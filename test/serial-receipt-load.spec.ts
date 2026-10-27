import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { dispatchedOrderFixtures, type Picklist } from './support/dispatched-order';
import { mintSignIn } from './support/sign-in';

// Story 2-6a (A23) — load and locks: a 1,000-serial `grn.submit` runs
// CONCURRENTLY with a `return.receive` naming one of its serials (dispatched
// earlier on an order). Both take the serial advisory locks — the receipt
// after its SKU / document rows, the return after its RMA row — in sorted
// order, then the warehouse advisory inside each append. Pass: no deadlock
// (both answer 201), exactly one of them books the shared serial (the
// return — the receipt refuses it per serial whichever commits first:
// `serial-dispatched-use-returns` before the return, `serial-in-stock`
// after), the other 999 serials book, and the receipt settles in under 30 s
// locally (the duration is logged).
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(240_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

describe('story 2-6a: a 1,000-serial receipt under a concurrent return (e2e, A23)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string;
  let warehouseId: string;
  let binId: string;
  let skuId: string;

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('serial_receipt_load');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `SRL Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
    opsToken = (await createMember('ops_manager')).token;
    const floor = await createMember('operator');

    warehouseId = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `SRL-${ulid().slice(20)}`, name: 'SRL warehouse' })
        .expect(201)
    ).body.id as string;
    const zoneId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code: 'A-01' })
        .expect(201)
    ).body.id as string;

    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode',
      'PHONE,Phone,pcs,,1800,,false,true,false,,,',
    ].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    skuId = ((await sql`select id from skus where tenant_id = ${tenantId} and code = 'PHONE'`)[0]!.id) as string;

    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Load dock', pin: '2468' })
      .expect(201);
    operatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: floor.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;
  });

  afterAll(async () => {
    await sql?.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  async function createMember(role: string): Promise<{ token: string; email: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const token = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
    return { token, email };
  }

  it('1,000 serials settle under 30 s beside a concurrent return of one of them: no deadlock, exactly one books it', async () => {
    const shared = 'LOAD-SHARED-1';
    // The shared serial: stocked, then dispatched on an order (its latest event is a pick).
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta: 1, reasonCode: 'stock-count', note: 'load seed', serials: [shared] })
      .expect(201);
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId, quantity: 1 }]);
    await fixtures.pickAllLines(picklist as Picklist, undefined, new Map([[picklist.lines[0]!.id, [shared]]]));
    await fixtures.packAndDispatch(orderId, [{ skuId, qty: 1 }]);
    const returnable = await http().get(`${API}/${tenantId}/returns/returnable?orderId=${orderId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const orderLineId = (returnable.body.lines as { orderLineId: string }[])[0]!.orderLineId;
    const rma = (
      await http()
        .post(`${API}/${tenantId}/returns`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ orderId, lines: [{ orderLineId, qty: 1, reasonCode: 'damaged', serialNumbers: [shared] }] })
        .expect(201)
    ).body as { id: string; lines: { id: string }[] };

    const serials = [shared, ...Array.from({ length: 999 }, (_, i) => `LOAD-${String(i).padStart(4, '0')}`)];
    const lines = [serials.slice(0, 500), serials.slice(500)].map((chunk) => ({
      skuId,
      batchCode: null,
      mfgDate: null,
      qty: chunk.length,
      serials: chunk,
    }));

    const started = Date.now();
    const [receipt, returned] = await Promise.all([
      http()
        .post(`${API}/${tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, occurredAt: nowUtc(), poId: null, blindReasonCode: 'other', lines })
        .then((res) => ({ res, at: Date.now() })),
      http()
        .post(`${API}/${tenantId}/returns/receipts`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          rmaId: rma.id,
          occurredAt: nowUtc(),
          entries: [{ rmaLineId: rma.lines[0]!.id, skuId, qty: 1, condition: 'resaleable', serialNumber: shared }],
        }),
    ]);
    const duration = receipt.at - started;
    // eslint-disable-next-line no-console
    console.log(`[2-6a A23] 1,000-serial grn.submit settled in ${duration} ms (concurrent return.receive: ${returned.status})`);

    expect(receipt.res.status).toBe(201);
    expect(returned.status).toBe(201);
    expect(duration).toBeLessThan(30_000);

    const grn = receipt.res.body.goodsReceipt as { lines: { serials?: string[] }[]; rejectedLines?: { code: string; serials?: string[] }[] };
    const booked = grn.lines.flatMap((line) => line.serials ?? []);
    expect(booked).toHaveLength(999);
    expect(booked).not.toContain(shared);
    expect(grn.rejectedLines).toEqual([
      expect.objectContaining({ serials: [shared], code: expect.stringMatching(/^serial-(dispatched-use-returns|in-stock)$/) }),
    ]);
    expect((returned.body as { applied: unknown[] }).applied).toHaveLength(1);
    // Exactly one intake of the shared serial since its dispatch: the return's.
    const events = (await sql`
      select e.type from ledger_events e join serials s on s.id::text = e.serial_ref::text
      where e.tenant_id = ${tenantId} and s.serial_number = ${shared} order by e.id`) as unknown as { type: string }[];
    expect(events.map((event) => event.type).slice(-2)).toEqual(['pick.picked', 'return.received']);
  });
});
