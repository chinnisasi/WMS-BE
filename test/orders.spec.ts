import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { ValkeyClient } from '../src/shared/valkey/valkey.client';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ORDER_LINE_STATUSES, ORDER_SOURCES, ORDER_STATUSES } from '../src/modules/outbound/order.command';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions — the same bootstrap the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// A host that exports any poll interval would boot background workers and
// race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/** One SKU code per scenario — the suite's deterministic fixture set. */
const SKU_CODES = [
  'ORD-OK',
  'ORD-BACK',
  'ORD-NONE',
  'ORD-CANCEL',
  'ORD-COMMIT',
  'ORD-RACE',
  'ORD-DOWN',
  'ORD-DEDUP',
  'ORD-LIST',
  'ORD-RLS',
  'ORD-ADJ',
  'ORD-TIME',
  'ORD-ABORT',
] as const;

describe('orders: manual entry, idempotent ingestion, acceptance reservation, cancel (e2e, story 4.1)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string;
  let accountantToken: string;
  let warehouseId: string;
  let binA: string;
  const skuIds = new Map<string, string>();

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('orders');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    // ── tenant + four roles (owner, ops_manager, operator, accountant) ────
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Order Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const signIn = (email: string, password: string) =>
      request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password })
        .expect(200)
        .then((res) => res.body.accessToken as string);
    ownerToken = await signIn(email, 'correct-horse-battery');

    const roles: [string, string][] = [
      ['ops_manager', 'ops-password-123'],
      ['operator', 'floor-password-123'],
      ['accountant', 'books-password-123'],
    ];
    const tokens: string[] = [];
    for (const [role, password] of roles) {
      const inviteeEmail = `${role}-${ulid().toLowerCase()}@example.com`;
      const invited = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/users`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email: inviteeEmail, role })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password })
        .expect(200);
      tokens.push(await signIn(inviteeEmail, password));
    }
    opsToken = tokens[0]!;
    operatorToken = tokens[1]!;
    accountantToken = tokens[2]!;

    // ── warehouse → zone → bin ─────────────────────────────────────────────
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `ORD-${ulid().slice(10, 16).toUpperCase()}`, name: `Order WH ${ulid()}` })
      .expect(201);
    warehouseId = warehouse.body.id as string;
    const zone = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' })
        .expect(201)
    ).body as { id: string };
    binA = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.id}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 1000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;

    // ── all scenario SKUs via catalog import ───────────────────────────────
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [csvHeader, ...SKU_CODES.map((code) => `${code},Test SKU ${code},pcs,,1800,,,,,`)].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const skus = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) {
      if ((SKU_CODES as readonly string[]).includes(item.code)) {
        skuIds.set(item.code, item.id);
      }
    }
    expect(skuIds.size).toBe(SKU_CODES.length);

    // Cold-start bootstrap: seed the tenant's reservation counters + ready
    // marker from the (still empty) journal.
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
  });

  afterAll(async () => {
    await cleanupRows();
    await valkey.quit().catch(() => valkey.disconnect());
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await cleaner.unsafe('DELETE FROM order_lines WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM orders WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      await cleaner.unsafe('DELETE FROM reservations WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      // The suite's namespaced decision-state keys must not outlive the rows.
      for (const tenant of createdTenantIds) {
        const keys = await valkey.keys(`wms:{${tenant}}:*`);
        if (keys.length > 0) {
          await valkey.del(...keys);
        }
      }
    } finally {
      await cleaner.end();
    }
  }

  /** Seeds committed on-hand via the stock.adjustment command (HTTP). */
  async function seedStock(skuId: string, quantity: number): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId: binA,
        quantityDelta: quantity,
        reasonCode: 'cycle-count',
        note: 'orders-suite seed',
      })
      .expect(201);
  }

  function createBody(
    lines: { skuId: string; quantity: number }[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { warehouseId, lines, ...extra };
  }

  function postOrder(
    token: string,
    body: Record<string, unknown>,
    key: string = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  /** The real-time ATP read (facade — story 2.5 has no ATP HTTP route). */
  async function atp(skuId: string): Promise<{ onHand: number; reserved: number; atp: number }> {
    return app.get(InventoryFacade).atp(tenantId, warehouseId, skuId);
  }

  /** The live journal rows of one SKU's order holds (this suite's own truth read). */
  async function orderHolds(skuId: string): Promise<{ id: string; state: string; quantity: number }[]> {
    const rows = await sql`
      select id, state, quantity from reservations
      where tenant_id = ${tenantId} and sku_id = ${skuId} and owner_type = 'order'
      order by id
    `;
    return rows as unknown as { id: string; state: string; quantity: number }[];
  }

  async function orderRow(orderId: string): Promise<Record<string, unknown> | undefined> {
    const rows = await sql`
      select id, status, source, integration_id, external_event_id from orders where id = ${orderId}
    `;
    return rows[0] as unknown as Record<string, unknown> | undefined;
  }

  // ── the create path ──────────────────────────────────────────────────────

  it('manual create: 201 accepted, per-line holds journalled, outbox + audit rows written', async () => {
    const skuId = skuIds.get('ORD-OK')!;
    await seedStock(skuId, 5);
    const res = await postOrder(opsToken, createBody([{ skuId, quantity: 3 }])).expect(201);
    const order = res.body.order as {
      id: string;
      status: string;
      source: string;
      integrationId: string | null;
      externalEventId: string | null;
      lines: Record<string, unknown>[];
    };
    expect(order.status).toBe('accepted');
    expect(order.source).toBe('manual');
    expect(order.integrationId).toBeNull();
    expect(order.externalEventId).toBeNull();
    const line = order.lines[0] as Record<string, unknown>;
    expect(line).toMatchObject({
      skuId,
      qty: 3,
      reservedQty: 3,
      shortfallQty: 0,
      status: 'open',
      reservationState: 'held',
    });
    expect(line['reservationId']).not.toBeNull();

    // The journal truth: one held row owned by the line, 7-day TTL.
    const holds = await orderHolds(skuId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ state: 'held', quantity: 3 });
    const journal = await sql`
      select owner_id, owner_type, extract(epoch from expires_at - created_at)::int as ttl
      from reservations where id = ${String(line['reservationId'])}
    `;
    expect(Number((journal[0] as unknown as { ttl: number }).ttl)).toBe(7 * 24 * 3600);

    // ATP moved: 5 on-hand − 3 reserved = 2 available.
    expect(await atp(skuId)).toMatchObject({ onHand: 5, reserved: 3, atp: 2 });

    // AD-7: the in-tx outbox row + the audit row committed with the order.
    const outbox = await sql`
      select type, payload from outbox_messages where tenant_id = ${tenantId} order by created_at
    `;
    const created = outbox.find(
      (row) => (row as unknown as { type: string }).type === 'order.created',
    );
    expect(created).toBeDefined();
    expect(
      ((created as unknown as { payload: { order: { id: string } } }).payload).order.id,
    ).toBe(order.id as string);
    const audits = await sql`
      select action, target_type, target_id from audit_events
      where tenant_id = ${tenantId} and action = 'order.created'
    `;
    expect(
      audits.some(
        (row) =>
          (row as unknown as { target_id: string }).target_id === (order.id as string),
      ),
    ).toBe(true);
  });

  it('idempotency: a replayed key re-serves the stored snapshot without a second reservation', async () => {
    const skuId = skuIds.get('ORD-OK')!;
    const holdsBefore = (await orderHolds(skuId)).length;
    const key = ulid();
    const body = createBody([{ skuId, quantity: 1 }]);
    const first = await postOrder(opsToken, body, key).expect(201);
    expect((await orderHolds(skuId)).length).toBe(holdsBefore + 1);
    const replay = await postOrder(opsToken, body, key).expect(201);
    expect(replay.body.order.id).toBe(first.body.order.id as string);
    expect((await orderHolds(skuId)).length).toBe(holdsBefore + 1); // no second hold
    // A reused key with a DIFFERENT payload is the 422 contract.
    const reuse = await postOrder(opsToken, createBody([{ skuId, quantity: 2 }]), key).expect(422);
    expect((reuse.body as { code: string }).code).toBe('idempotency-key-reuse');
  });

  it('validation: zero/negative quantity, empty lines, and a malformed skuId are 400 before any write', async () => {
    const skuId = skuIds.get('ORD-OK')!;
    await postOrder(opsToken, createBody([])).expect(400);
    await postOrder(opsToken, createBody([{ skuId, quantity: 0 }])).expect(400);
    await postOrder(opsToken, createBody([{ skuId: 'not-a-uuid', quantity: 1 }])).expect(400);
    // Channel refs are required-together AND ingested-only: a manual order
    // carrying either arm is an input error (the command owns the rule).
    await postOrder(
      opsToken,
      createBody([{ skuId, quantity: 1 }], { integrationId: uuidv7() }),
    ).expect(400);
    await postOrder(
      opsToken,
      createBody([{ skuId, quantity: 1 }], { externalEventId: 'evt-1' }),
    ).expect(400);
    // The review-patch arms: a non-uuid integrationId and a quantity above
    // the int4 column bound are rejected at the boundary (never a driver 500).
    await postOrder(
      opsToken,
      createBody([{ skuId, quantity: 1 }], {
        source: 'ingested',
        integrationId: 'not-a-uuid',
        externalEventId: 'evt-1',
      }),
    ).expect(400);
    await postOrder(opsToken, createBody([{ skuId, quantity: 2_147_483_648 }])).expect(400);
    // Nothing reached the journal for the probe SKUs beyond the fixtures.
    expect((await orderHolds(skuId)).length).toBeLessThanOrEqual(2); // the earlier tests' holds
  });

  it('404: an unknown warehouse or a line naming an unknown SKU (404, before any write)', async () => {
    const skuId = skuIds.get('ORD-OK')!;
    await postOrder(opsToken, {
      warehouseId: uuidv7(),
      lines: [{ skuId, quantity: 1 }],
    }).expect(404);
    const res = await postOrder(opsToken, createBody([{ skuId: uuidv7(), quantity: 1 }])).expect(
      404,
    );
    expect(res.body.code).toBe('not-found');
  });

  it('role matrix: operator and accountant lack orders.manage (403 role-denied); reads stay open', async () => {
    const skuId = skuIds.get('ORD-OK')!;
    const denied = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send(createBody([{ skuId, quantity: 1 }]))
      .expect(403);
    expect(denied.body.code).toBe('role-denied');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .set(KEY_HEADER, ulid())
      .send(createBody([{ skuId, quantity: 1 }]))
      .expect(403);
    // A read is never capability-gated (any tenant member).
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/orders`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
  });

  // ── the fixed backorder policy ───────────────────────────────────────────

  it('over-ATP line: the fixed backorder policy reserves min(qty, ATP) and the shortfall is visible', async () => {
    const skuId = skuIds.get('ORD-BACK')!;
    await seedStock(skuId, 4);
    const res = await postOrder(opsToken, createBody([{ skuId, quantity: 10 }])).expect(201);
    const line = (res.body.order as { lines: Record<string, unknown>[] }).lines[0]!;
    expect(line).toMatchObject({
      qty: 10,
      reservedQty: 4,
      shortfallQty: 6,
      status: 'backordered',
      reservationState: 'held',
    });
    expect(await atp(skuId)).toMatchObject({ onHand: 4, reserved: 4, atp: 0 });
  });

  it('a fully-unavailable line gets no reservation at all (no hold, no backorder link)', async () => {
    const skuId = skuIds.get('ORD-NONE')!;
    const res = await postOrder(opsToken, createBody([{ skuId, quantity: 2 }])).expect(201);
    const line = (res.body.order as { lines: Record<string, unknown>[] }).lines[0]!;
    expect(line).toMatchObject({
      qty: 2,
      reservedQty: 0,
      shortfallQty: 2,
      status: 'backordered',
      reservationId: null,
      reservationState: null,
    });
    expect((await orderHolds(skuId)).length).toBe(0);
  });

  // ── channel dedup (AD-5) ─────────────────────────────────────────────────

  it('ingested dedup: the same channel payload twice → the SAME order; a divergent payload → 422 order-source-conflict', async () => {
    const skuId = skuIds.get('ORD-DEDUP')!;
    await seedStock(skuId, 50);
    const integrationId = uuidv7();
    const externalEventId = `evt-${ulid().toLowerCase()}`;
    const payload = {
      warehouseId,
      source: 'ingested',
      integrationId,
      externalEventId,
      lines: [{ skuId, quantity: 2 }],
    };
    const first = await postOrder(opsToken, payload).expect(201);
    expect((first.body.order as { source: string }).source).toBe('ingested');
    const second = await postOrder(opsToken, payload).expect(201); // NEW key, same payload
    expect(second.body.order.id).toBe(first.body.order.id as string);
    expect((await orderHolds(skuId)).length).toBe(1); // no second reservation

    // The same ref with a DIFFERENT payload is a data conflict, not a retry.
    const divergent = await postOrder(opsToken, {
      ...payload,
      lines: [{ skuId, quantity: 5 }],
    });
    expect(divergent.status).toBe(422);
    expect((divergent.body as { code: string }).code).toBe('order-source-conflict');
  });

  it('concurrent first delivery of the same channel payload: exactly one order wins and both callers see it', async () => {
    const skuId = skuIds.get('ORD-DEDUP')!;
    const integrationId = uuidv7();
    const payload = {
      warehouseId,
      source: 'ingested',
      integrationId,
      externalEventId: `evt-${ulid().toLowerCase()}`,
      lines: [{ skuId, quantity: 3 }],
    };
    // Two different keys, same payload, fired concurrently: the dedup index
    // is the race backstop — the loser releases its own grants and resolves
    // to the winner's snapshot.
    const heldBefore = (await orderHolds(skuId)).filter((hold) => hold.state === 'held');
    const [a, b] = (await Promise.all([
      postOrder(opsToken, payload).expect(201),
      postOrder(opsToken, payload).expect(201),
    ])) as unknown as [{ body: { order: { id: string } } }, { body: { order: { id: string } } }];
    expect(a.body.order.id).toBe(b.body.order.id);
    // Exactly one order line and one NEW live hold survive (the loser's
    // grants were released — only the winner's line holds stock).
    const lines = await sql`
      select count(*)::int as n from order_lines where order_id = ${a.body.order.id}
    `;
    expect(Number((lines[0] as unknown as { n: number }).n)).toBe(1);
    const live = (await orderHolds(skuId)).filter((hold) => hold.state === 'held');
    expect(live.length).toBe(heldBefore.length + 1);
    const newcomer = live.find((hold) => !heldBefore.some((prior) => prior.id === hold.id))!;
    expect(newcomer.quantity).toBe(3);
  });

  // ── cancellation ─────────────────────────────────────────────────────────

  it('cancel: releases every open hold, flips the status, and is idempotent on replay and on an already-cancelled order', async () => {
    const skuId = skuIds.get('ORD-CANCEL')!;
    await seedStock(skuId, 3);
    const created = await postOrder(opsToken, createBody([{ skuId, quantity: 2 }])).expect(201);
    const orderId = (created.body.order as { id: string }).id;
    expect((await orderHolds(skuId)).filter((hold) => hold.state === 'held')).toHaveLength(1);
    expect(await atp(skuId)).toMatchObject({ onHand: 3, reserved: 2, atp: 1 });

    const cancelKey = ulid();
    const cancelled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, cancelKey)
      .send({})
      .expect(200);
    const order = cancelled.body.order as { status: string; lines: Record<string, unknown>[] };
    expect(order.status).toBe('cancelled');
    // The line stops claiming stock in the same commit as the flip: the hold
    // pointer and the reserved qty are both cleared, so no read can report a
    // hold this order no longer owns (the journal keeps the trail via
    // `owner_id`). The release itself runs after the flip commits.
    expect(order.lines[0]).toMatchObject({
      reservedQty: 0,
      reservationId: null,
      reservationState: null,
    });
    const cancelledLines = await sql`
      select reserved_qty, reservation_id from order_lines
      where tenant_id = ${tenantId} and order_id = ${orderId}
    `;
    expect(Number((cancelledLines[0] as unknown as { reserved_qty: number }).reserved_qty)).toBe(0);
    expect((cancelledLines[0] as unknown as { reservation_id: string | null }).reservation_id).toBeNull();
    // ATP restored; the journal row is terminal-released, never deleted.
    expect(await atp(skuId)).toMatchObject({ onHand: 3, reserved: 0, atp: 3 });
    expect((await orderHolds(skuId)).map((hold) => hold.state)).toEqual(['released']);

    // A replay under the original key re-serves the stored snapshot.
    const replayed = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, cancelKey)
      .send({})
      .expect(200);
    expect((replayed.body.order as { status: string }).status).toBe('cancelled');
    // A cancel under a NEW key is an idempotent no-op (200, no new events).
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const outbox = await sql`
      select type from outbox_messages where tenant_id = ${tenantId} and type = 'order.cancelled'
    `;
    expect(outbox).toHaveLength(1); // one flip → one event, the no-op wrote none
    expect(await orderRow(orderId)).toMatchObject({ status: 'cancelled' });
  });

  it('concurrent cancels: two racing cancels both settle 200 and the flip emits exactly one order.cancelled event', async () => {
    // The flip loser (its conditional UPDATE matches no row) sees the
    // winner's settled state and takes the idempotent no-op arm — two racing
    // cancels must never double-emit or double-release.
    const skuId = skuIds.get('ORD-CANCEL')!;
    await seedStock(skuId, 2);
    const created = await postOrder(opsToken, createBody([{ skuId, quantity: 1 }])).expect(201);
    const orderId = (created.body.order as { id: string }).id;
    const cancelsBefore = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId} and type = 'order.cancelled'
    `;
    const baseline = Number((cancelsBefore[0] as unknown as { n: number }).n);
    const cancel = (key: string) =>
      request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, key)
        .send({});
    const [a, b] = await Promise.all([cancel(ulid()), cancel(ulid())]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await orderRow(orderId)).toMatchObject({ status: 'cancelled' });
    expect((await orderHolds(skuId)).every((hold) => hold.state === 'released')).toBe(true);
    const cancelsAfter = await sql`
      select count(*)::int as n from outbox_messages
      where tenant_id = ${tenantId} and type = 'order.cancelled'
    `;
    expect(Number((cancelsAfter[0] as unknown as { n: number }).n)).toBe(baseline + 1);
  });

  it('cancel refuses an order whose hold a consuming flow already claimed (409 conflict)', async () => {
    const skuId = skuIds.get('ORD-COMMIT')!;
    await seedStock(skuId, 2);
    const created = await postOrder(opsToken, createBody([{ skuId, quantity: 2 }])).expect(201);
    const orderId = (created.body.order as { id: string }).id;
    const reservationId = (
      (created.body.order as { lines: { reservationId: string }[] }).lines[0]!
    ).reservationId;
    // The consuming flow commits the hold directly through the facade (the
    // pick path arrives with a later story).
    await app
      .get(InventoryFacade)
      .commitReservation(tenantId, reservationId)
      .then(
        (snapshot) => expect(snapshot.state).toBe('committed'),
        (error: unknown) => {
          throw error;
        },
      );
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(409);
    expect(res.body.code).toBe('conflict');
  });

  it('cancel 404 on an unknown order; a malformed orderId is a 400', async () => {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${uuidv7()}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/not-a-uuid/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(400);
  });

  // ── fail-closed + race arms ──────────────────────────────────────────────

  it('mid-order grant abort: an earlier line\'s hold is RELEASED, not orphaned', async () => {
    // The store-down arm above is single-line, so its `granted` list is empty
    // when the abort path runs — deleting the release entirely left it green.
    // This arm fails the SECOND line's grant with the first already held, so
    // the compensating release is the only thing that can restore ATP.
    const first = skuIds.get('ORD-ABORT')!;
    const second = skuIds.get('ORD-OK')!;
    await seedStock(first, 6);
    const atpBefore = await atp(first);
    const holdsBefore = (await orderHolds(first)).length;

    const valkeyClient = app.get(ValkeyClient);
    const real = ValkeyClient.prototype.grantReservation;
    let calls = 0;
    jest.spyOn(valkeyClient, 'grantReservation').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) {
        return real.apply(valkeyClient, args as Parameters<ValkeyClient['grantReservation']>);
      }
      throw new Error('connection refused');
    });
    try {
      const res = await postOrder(
        opsToken,
        createBody([
          { skuId: first, quantity: 2 },
          { skuId: second, quantity: 1 },
        ]),
      ).expect(503);
      expect(res.body.code).toBe('reservation-store-unavailable');
    } finally {
      jest.restoreAllMocks();
    }

    // The first line's hold was granted and must be gone again: no NEW held
    // row, and ATP back where it started (the orphan-hold regression).
    const after = await orderHolds(first);
    expect(holdsBefore).toBe(0); // a fresh SKU: every hold below is this arm's
    expect(after.filter((row) => row.state === 'held')).toEqual([]);
    expect((await atp(first)).atp).toBe(atpBefore.atp);
  });

  it('store-down acceptance: 503 reservation-store-unavailable and NOTHING written', async () => {
    const skuId = skuIds.get('ORD-DOWN')!;
    await seedStock(skuId, 5);
    const beforeOrders = await sql`select count(*)::int as n from orders where tenant_id = ${tenantId}`;
    const valkeyClient = app.get(ValkeyClient);
    jest.spyOn(valkeyClient, 'grantReservation').mockRejectedValue(new Error('connection refused'));
    try {
      const key = ulid();
      const res = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/orders`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, key)
        .send(createBody([{ skuId, quantity: 3 }]))
        .expect(503);
      expect(res.body.code).toBe('reservation-store-unavailable');
      // Nothing accepted half-reserved: no order row, no hold, no key.
      const afterOrders = await sql`select count(*)::int as n from orders where tenant_id = ${tenantId}`;
      expect(Number((afterOrders[0] as unknown as { n: number }).n)).toBe(
        Number((beforeOrders[0] as unknown as { n: number }).n),
      );
      expect((await orderHolds(skuId)).length).toBe(0);
      const keyRow = await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
      expect(Number((keyRow[0] as unknown as { n: number }).n)).toBe(0);
    } finally {
      jest.restoreAllMocks();
    }
    // Healthy again: the store was only mocked.
    const retry = await postOrder(opsToken, createBody([{ skuId, quantity: 1 }])).expect(201);
    expect((retry.body.order as { lines: Record<string, unknown>[] }).lines[0]).toMatchObject({
      reservedQty: 1,
      status: 'open',
    });
  });

  it('grant-loser race: two concurrent orders over one SKU split the ATP, the loser backorders, nothing oversells', async () => {
    const skuId = skuIds.get('ORD-RACE')!;
    await seedStock(skuId, 6);
    const [a, b] = (await Promise.all([
      postOrder(opsToken, createBody([{ skuId, quantity: 5 }])).expect(201),
      postOrder(opsToken, createBody([{ skuId, quantity: 5 }])).expect(201),
    ])) as unknown as [
      { body: { order: { lines: Record<string, unknown>[] } } },
      { body: { order: { lines: Record<string, unknown>[] } } },
    ];
    // Both creations SUCCEED (the fixed backorder policy accepts) — the ATP
    // is split between them, never more than 6 units held in total.
    const reservedSum =
      Number(a.body.order.lines[0]!['reservedQty'] as number) +
      Number(b.body.order.lines[0]!['reservedQty'] as number);
    expect(reservedSum).toBeLessThanOrEqual(6);
    const atpNow = await atp(skuId);
    expect(atpNow.atp).toBe(6 - reservedSum);
    expect(atpNow.reserved).toBe(reservedSum);
    // The journal agrees with what both responses reported.
    const journalHeld = (await orderHolds(skuId))
      .filter((hold) => hold.state === 'held')
      .reduce((sum, hold) => sum + hold.quantity, 0);
    expect(journalHeld).toBe(reservedSum);
  });

  it('adjust-vs-accept race: a concurrent negative adjustment never lets acceptance oversell', async () => {
    const skuId = skuIds.get('ORD-ADJ')!;
    await seedStock(skuId, 5);
    // A negative adjustment (the A2 arm's writer) races an order accepting 5.
    const [, order] = await Promise.all([
      request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId,
          binId: binA,
          quantityDelta: -5,
          reasonCode: 'cycle-count',
          note: 'orders-suite race',
        }),
      postOrder(opsToken, createBody([{ skuId, quantity: 5 }])).then(
        (res) => res as unknown as { status: number },
        () => null,
      ),
    ]);
    // Whichever arm loses retries/re-probes; the invariant both ways is
    // "never oversell": the journal's live sum can never exceed on-hand.
    const snapshot = await atp(skuId);
    const held = (await orderHolds(skuId))
      .filter((hold) => hold.state === 'held')
      .reduce((sum, hold) => sum + hold.quantity, 0);
    expect(held).toBeLessThanOrEqual(snapshot.onHand);
    expect(snapshot.onHand - held).toBe(snapshot.atp);
    expect(held).toBeGreaterThanOrEqual(0);
    // The adjust arm either landed or was rejected by its own ceiling guard;
    // the order arm either accepted (fully or partially reserved) or — only
    // if the store was down mid-race — failed closed with nothing written.
    expect(order === null || order.status === 201).toBe(true);
  });

  // ── reads ────────────────────────────────────────────────────────────────

  it('detail + list reads: the detail carries the lines, the list is warehouse-scoped keyset-cursor newest-first', async () => {
    const skuId = skuIds.get('ORD-LIST')!;
    const createdIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const res = await postOrder(opsToken, createBody([{ skuId, quantity: 1 }])).expect(201);
      createdIds.push((res.body.order as { id: string }).id);
    }
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/orders/${createdIds[0]}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect((detail.body.order as { id: string }).id).toBe(createdIds[0]);
    expect((detail.body.order as { lines: unknown[] }).lines).toHaveLength(1);
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/orders/${uuidv7()}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/orders/not-a-uuid`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(400);

    const page1 = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/orders?limit=2`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    const body1 = page1.body as { items: { id: string }[]; nextCursor?: string };
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).toBeTruthy();
    const page2 = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/orders?limit=2&cursor=${body1.nextCursor}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    const body2 = page2.body as { items: { id: string }[]; nextCursor?: string };
    // Newest first, no overlap between pages.
    const seen = new Set([...body1.items.map((item) => item.id), ...body2.items.map((item) => item.id)]);
    expect(seen.has(createdIds[2]!)).toBe(true); // the newest order leads page 1
    expect(seen.size).toBe(4); // 2 + 2 distinct
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/orders?cursor=bogus`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(400);
    // An unknown warehouse is a 404 (the facade asserts existence — never a
    // silently empty page).
    const unknownWh = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${uuidv7()}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(404);
    expect((unknownWh.body as { code: string }).code).toBe('not-found');
  });

  // ── persistence guards ───────────────────────────────────────────────────

  it('0017 CHECK constraints: a bogus status, a zero qty, and a reserved_qty above qty are rejected (23514)', async () => {
    const skuId = skuIds.get('ORD-RLS')!;
    const orderId = uuidv7();
    await expect(
      sql`
        insert into orders (id, tenant_id, warehouse_id, status, source)
        values (${orderId}, ${tenantId}, ${warehouseId}, 'bogus', 'manual')
      `,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`
        insert into orders (id, tenant_id, warehouse_id, status, source)
        values (${orderId}, ${tenantId}, ${warehouseId}, 'accepted', 'bogus')
      `,
    ).rejects.toMatchObject({ code: '23514' });
    await sql`
      insert into orders (id, tenant_id, warehouse_id, status, source)
      values (${orderId}, ${tenantId}, ${warehouseId}, 'accepted', 'manual')
    `;
    await expect(
      sql`
        insert into order_lines (id, tenant_id, order_id, sku_id, qty, status)
        values (${uuidv7()}, ${tenantId}, ${orderId}, ${skuId}, 0, 'open')
      `,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`
        insert into order_lines (id, tenant_id, order_id, sku_id, qty, reserved_qty, status)
        values (${uuidv7()}, ${tenantId}, ${orderId}, ${skuId}, 1, 2, 'open')
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('TS/CHECK parity: the 0017 CHECK arm sets equal the command-layer state-machine constants (the drift guard)', async () => {
    // The CHECKs are the additive backstop to the TypeScript constants; if
    // they drift apart, a valid arm would be rejected by the DB (or an
    // invalid one accepted past a stale TS set). The parity guard reads the
    // live constraint definitions and pins them to the constants.
    const defs = await sql`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conname in ('orders_status_check', 'orders_source_check', 'order_lines_status_check')
    `;
    const armsOf = (conname: string): string[] => {
      const row = defs.find((item) => (item as unknown as { conname: string }).conname === conname);
      expect(row).toBeDefined();
      const def = (row as unknown as { def: string }).def;
      const arms = [...def.matchAll(/'([a-z]+)'/g)].map((match) => match[1]!);
      expect(arms.length).toBeGreaterThan(0); // every arm is a quoted literal
      return arms.sort();
    };
    expect(armsOf('orders_status_check')).toEqual([...ORDER_STATUSES].sort());
    expect(armsOf('orders_source_check')).toEqual([...ORDER_SOURCES].sort());
    expect(armsOf('order_lines_status_check')).toEqual([...ORDER_LINE_STATUSES].sort());
  });

  it('RLS: orders and order_lines are invisible to another tenant even for a same-session probe', async () => {
    // A foreign tenant's order, then probe through the non-bypass RLS role.
    const foreignEmail = `foreign-owner-${ulid().toLowerCase()}@example.com`;
    const foreign = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({
        name: `Foreign Co ${ulid()}`,
        ownerEmail: foreignEmail,
        password: 'correct-horse-battery',
      })
      .expect(201);
    const foreignTenantId = foreign.body.tenant.id as string;
    createdTenantIds.push(foreignTenantId);
    const foreignToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: foreignEmail, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    const foreignWh = await request(app.getHttpServer())
      .post(`${API}/${foreignTenantId}/warehouses`)
      .set('Authorization', `Bearer ${foreignToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `FOR-${ulid().slice(10, 16).toUpperCase()}`, name: `Foreign WH ${ulid()}` })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${foreignTenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${foreignToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: foreignWh.body.id as string,
        lines: [{ skuId: uuidv7(), quantity: 1 }],
      })
      .expect(404); // the foreign tenant has no such SKU — nothing written

    // Seed one real foreign order AND one foreign line (the RLS probe needs
    // rows on both sides of BOTH tables — counting order_lines while none
    // exists returns 0 with RLS on or off, which proves nothing).
    const foreignOrderId = uuidv7();
    await sql`
      insert into orders (id, tenant_id, warehouse_id, status, source)
      values (${foreignOrderId}, ${foreignTenantId}, ${warehouseId}, 'accepted', 'manual')
    `;
    await sql`
      insert into order_lines (id, tenant_id, order_id, sku_id, qty, reserved_qty, status)
      values (${uuidv7()}, ${foreignTenantId}, ${foreignOrderId}, ${uuidv7()}, 2, 0, 'open')
    `;
    // The probe below is only meaningful because both foreign rows exist.
    const foreignSeeded = await sql`
      select count(*)::int as n from order_lines where tenant_id = ${foreignTenantId}
    `;
    expect(Number((foreignSeeded[0] as unknown as { n: number }).n)).toBeGreaterThan(0);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1 });
    try {
      await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
      for (const table of ['orders', 'order_lines']) {
        const foreign = await rls.unsafe(
          `select count(*)::int as n from ${table} where tenant_id = '${foreignTenantId}'::uuid`,
        );
        expect(Number((foreign[0] as unknown as { n: number }).n)).toBe(0);
      }
      // And the session tenant's own rows ARE visible through the same role.
      const own = await rls.unsafe(
        `select count(*)::int as n from orders where tenant_id = '${tenantId}'::uuid`,
      );
      expect(Number((own[0] as unknown as { n: number }).n)).toBeGreaterThan(0);

      // The write side fails closed too (the WITH CHECK arm): an INSERT
      // naming a foreign tenant under the session's own scope is a 42501.
      await expect(
        rls.unsafe(
          `insert into orders (id, tenant_id, warehouse_id, status, source)
           values ('${uuidv7()}'::uuid, '${foreignTenantId}'::uuid, '${warehouseId}'::uuid, 'accepted', 'manual')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      // …while the allowed arm (own tenant_id) inserts cleanly.
      await rls.unsafe(
        `insert into orders (id, tenant_id, warehouse_id, status, source)
         values ('${uuidv7()}'::uuid, '${tenantId}'::uuid, '${warehouseId}'::uuid, 'accepted', 'manual')`,
      );
    } finally {
      await rls.end();
    }
    // A session reaching into ANOTHER tenant's path is refused by the tenancy
    // guard (403) before any read runs — the token's tenant does not own the
    // path, which is a different contract from the 404 an unknown id inside
    // the session's OWN tenant returns.
    await request(app.getHttpServer())
      .get(`${API}/${foreignTenantId}/outbound/orders/${uuidv7()}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(403);
    // The not-found contract, for contrast: own tenant, unknown order id.
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/orders/${uuidv7()}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(404);
  });


  it('accept → reservation latency: a multi-line acceptance settles its holds well inside the 10 s p95 budget', async () => {
    // The epic's ingestion NFR (ingested order → reservation ≤ 10 s p95) is a
    // pipeline budget, and acceptance is the only synchronous leg in it: this
    // samples that leg so a regression which makes the grant phase pathological
    // (an unbounded re-probe loop, a lock convoy on the A2 re-validation) fails
    // here rather than in production. A sample, not a benchmark — the bound is
    // deliberately the NFR's own, not a tighter number that would go flaky on a
    // loaded CI box.
    const skuId = skuIds.get('ORD-TIME')!;
    await seedStock(skuId, 30);
    const started = Date.now();
    const res = await postOrder(
      opsToken,
      createBody([
        { skuId, quantity: 4 },
        { skuId, quantity: 5 },
        { skuId, quantity: 6 },
      ]),
    ).expect(201);
    const elapsedMs = Date.now() - started;

    // Every line came back reserved in full — the sample measured the real
    // grant path, not three no-op backorders.
    const lines = res.body.order.lines as { reservedQty: number; status: string }[];
    expect(lines.map((line) => line.reservedQty)).toEqual([4, 5, 6]);
    expect(lines.every((line) => line.status === 'open')).toBe(true);
    expect((await orderHolds(skuId)).filter((hold) => hold.state === 'held')).toHaveLength(3);
    expect(elapsedMs).toBeLessThan(10_000);
  });

});
