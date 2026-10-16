import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ulid } from '../../src/shared/primitives/ids';
import { testAddress } from './shipment-address';

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

export interface PickLine {
  id: string;
  picklistId: string;
  orderId: string;
  orderLineId: string;
  skuId: string;
  binId: string | null;
  qty: number;
  status: string;
}

export interface Picklist {
  id: string;
  waveId: string;
  orderId: string | null;
  status: string;
  lines: PickLine[];
}

export interface Wave {
  id: string;
  status: string;
  picklists: Picklist[];
}

/**
 * What the fixtures act as. A getter, not a value: the suites assign these in
 * `beforeAll`, after the fixtures are bound at describe time.
 */
export interface DispatchedOrderContext {
  readonly app: INestApplication;
  readonly tenantId: string;
  readonly warehouseId: string;
  /** Holds `orders.manage`, `waves.manage`, `pack.execute`, `dispatch.execute` (an ops manager). */
  readonly opsToken: string;
  /** Any member — reads the released wave. */
  readonly ownerToken: string;
  /** The badge-in DEVICE session that draws the picks (`picks.execute`). */
  readonly operatorToken: string;
}

/** Second-precision business time, Z-suffixed (the pick's `occurredAt` shape). */
function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * The dispatched-order seeding fixtures, extracted from
 * `test/cold-chain.spec.ts` (story 13-1) so the returns suite seeds a
 * dispatched order through the same real HTTP flow: order → single-order
 * wave policy → wave → release → picks → pack → dispatch. Stock must already
 * sit in a bin the wave plan can draw from (the calling suite seeds it).
 */
export function dispatchedOrderFixtures(context: () => DispatchedOrderContext) {
  async function createOrder(lines: { skuId: string; quantity: number }[], wh?: string): Promise<string> {
    const ctx = context();
    const res = await request(ctx.app.getHttpServer())
      .post(`${API}/${ctx.tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${ctx.opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh ?? ctx.warehouseId, lines, destination: testAddress() })
      .expect(201);
    return res.body.order.id as string;
  }

  /** A released single-order wave over a fresh order of `lines`, and its one picklist. */
  async function releasedWave(
    lines: { skuId: string; quantity: number }[],
  ): Promise<{ waveId: string; orderId: string; picklist: Picklist }> {
    const ctx = context();
    const orderId = await createOrder(lines);
    const policyId = (
      await request(ctx.app.getHttpServer())
        .post(`${API}/${ctx.tenantId}/outbound/wave-policies`)
        .set('Authorization', `Bearer ${ctx.opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: ctx.warehouseId, name: `cc-${ulid().slice(10, 18)}`, grouping: 'single' })
        .expect(201)
    ).body.policy.id as string;
    const waveId = (
      await request(ctx.app.getHttpServer())
        .post(`${API}/${ctx.tenantId}/outbound/waves`)
        .set('Authorization', `Bearer ${ctx.opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: ctx.warehouseId, policyId, orderIds: [orderId] })
        .expect(201)
    ).body.wave.id as string;
    await request(ctx.app.getHttpServer())
      .post(`${API}/${ctx.tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${ctx.opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const wave = (
      await request(ctx.app.getHttpServer())
        .get(`${API}/${ctx.tenantId}/outbound/waves/${waveId}`)
        .set('Authorization', `Bearer ${ctx.ownerToken}`)
        .expect(200)
    ).body.wave as Wave;
    const picklist = wave.picklists[0];
    if (picklist === undefined) throw new Error('fixture produced no picklist');
    return { waveId, orderId, picklist };
  }

  /** Picks every planned line in full (serial-tracked lines take their serials from `serialsByLine`). */
  async function pickAllLines(
    picklist: Picklist,
    occurredAt?: string,
    serialsByLine?: Map<string, string[]>,
  ): Promise<void> {
    const ctx = context();
    for (const line of picklist.lines) {
      await request(ctx.app.getHttpServer())
        .post(`${API}/${ctx.tenantId}/outbound/picks`)
        .set('Authorization', `Bearer ${ctx.operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId: ctx.warehouseId,
          picklistId: line.picklistId,
          picklistLineId: line.id,
          skuId: line.skuId,
          binId: line.binId!,
          qty: line.qty,
          occurredAt: occurredAt ?? now(),
          ...(serialsByLine === undefined ? {} : { serials: serialsByLine.get(line.id) }),
        })
        .expect(201);
    }
  }

  async function packAndDispatch(
    orderId: string,
    scanned: { skuId: string; qty: number }[],
    dispatchBody: Record<string, unknown> = {},
  ): Promise<void> {
    const ctx = context();
    await request(ctx.app.getHttpServer())
      .post(`${API}/${ctx.tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${ctx.opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned })
      .expect(201);
    await request(ctx.app.getHttpServer())
      .post(`${API}/${ctx.tenantId}/outbound/orders/${orderId}/dispatch`)
      .set('Authorization', `Bearer ${ctx.opsToken}`)
      .set(KEY_HEADER, ulid())
      .send(dispatchBody)
      .expect(201);
  }

  return { createOrder, releasedWave, pickAllLines, packAndDispatch };
}
