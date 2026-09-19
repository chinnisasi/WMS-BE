import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions — the same bootstrap the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

describe('shipment addresses (e2e, story 11-1): destination + origin I/O, the replay break', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let warehouseId: string;
  let binA: string;
  const skuIds = new Map<string, string>();

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('shipment_addresses');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    // ── tenant + two roles ─────────────────────────────────────────────────
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Address Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const signIn = (address: string, password: string) =>
      request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: address, password })
        .expect(200)
        .then((res) => res.body.accessToken as string);
    ownerToken = await signIn(email, 'correct-horse-battery');
    const inviteeEmail = `ops-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: inviteeEmail, role: 'ops_manager' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'ops-password-123' })
      .expect(200);
    opsToken = await signIn(inviteeEmail, 'ops-password-123');

    // ── warehouse (origin) → zone → bin ────────────────────────────────────
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        code: `SHA-${ulid().slice(10, 16).toUpperCase()}`,
        name: `Address WH ${ulid()}`,
        origin: testAddress(),
      })
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

    // ── scenario SKUs via catalog import ───────────────────────────────────
    const SKU_CODES = ['SHA-OK', 'SHA-DEDUP', 'SHA-LEGACY'] as const;
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

  // ── helpers ─────────────────────────────────────────────────────────────

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
        note: 'addresses-suite seed',
      })
      .expect(201);
  }

  function createBody(
    lines: { skuId: string; quantity: number }[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { warehouseId, lines, destination: testAddress(), ...extra };
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

  function getOrders(token: string): request.Test {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/orders`)
      .set('Authorization', `Bearer ${token}`);
  }

  function postWarehouse(
    token: string,
    body: Record<string, unknown>,
    key: string = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function orderCount(): Promise<number> {
    const rows = await sql`
      select count(*)::int as n from orders where tenant_id = ${tenantId}
    `;
    return (rows[0] as unknown as { n: number }).n;
  }

  // ── the destination I/O matrix ───────────────────────────────────────────

  it('a full destination echoes on the detail and the list read', async () => {
    const skuId = skuIds.get('SHA-OK')!;
    await seedStock(skuId, 2);
    const destination = testAddress();
    const res = await postOrder(opsToken, createBody([{ skuId, quantity: 2 }], { destination })).expect(
      201,
    );
    const order = res.body.order as { id: string; destination: Record<string, unknown> };
    expect(order.destination).toEqual(destination);
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/orders/${order.id}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect((detail.body.order as { destination: Record<string, unknown> }).destination).toEqual(
      destination,
    );
    const list = await getOrders(opsToken).expect(200);
    const listed = (list.body.items as { id: string; destination: Record<string, unknown> }[]).find(
      (item) => item.id === order.id,
    );
    expect(listed?.destination).toEqual(destination);
  });

  it('line2 is optional: an address without one stores no second line and reads back without it', async () => {
    const skuId = skuIds.get('SHA-OK')!;
    await seedStock(skuId, 1);
    const destination = testAddress({ line2: undefined });
    const res = await postOrder(opsToken, createBody([{ skuId, quantity: 1 }], { destination })).expect(
      201,
    );
    const echoed = (res.body.order as { destination: Record<string, unknown> }).destination;
    expect(echoed).toEqual(destination); // absent line2, not null, not ''
    // ...and an explicit '' normalizes to the same address (the same hash):
    const key = ulid();
    const withBlank = testAddress({ line2: '' });
    await postOrder(opsToken, createBody([{ skuId, quantity: 1 }], { destination: withBlank }), key).expect(
      201,
    );
    const replay = await postOrder(
      opsToken,
      createBody([{ skuId, quantity: 1 }], { destination }),
      key,
    ).expect(201);
    // The blank-line2 body above used a DIFFERENT key, so this replay proves
    // the two forms hash identically (a mismatch would be 422 here).
    expect(replay.body.order.destination).toEqual(destination);
  });

  it('a missing destination is 400 validation-failed before any write', async () => {
    const skuId = skuIds.get('SHA-OK')!;
    const before = await orderCount();
    const res = await postOrder(opsToken, {
      warehouseId,
      lines: [{ skuId, quantity: 1 }],
    }).expect(400);
    expect(res.body).toMatchObject({ code: 'validation-failed' });
    expect(String(res.body.detail)).toContain('destination');
    expect(await orderCount()).toBe(before);
  });

  it('a partial destination is 400, naming the missing field', async () => {
    const skuId = skuIds.get('SHA-OK')!;
    const before = await orderCount();
    // Every field but city and pincode — the two omissions must be named.
    const partial = {
      contactName: 'Priya Sharma',
      phone: '+91 98450 12345',
      line1: '12, Peenya Industrial Area',
      state: 'Karnataka',
    };
    const res = await postOrder(opsToken, createBody([{ skuId, quantity: 1 }], { destination: partial })).expect(
      400,
    );
    expect(res.body).toMatchObject({ code: 'validation-failed' });
    expect(String(res.body.detail)).toContain('destination.city');
    expect(await orderCount()).toBe(before);
  });

  it.each(['11001', '1100011', '56006A', 560066])(
    'a pincode that is not six digit-text is 400 naming pincode (got %p)',
    async (badPincode) => {
      const skuId = skuIds.get('SHA-OK')!;
      const destination = testAddress({ pincode: badPincode });
      const res = await postOrder(
        opsToken,
        createBody([{ skuId, quantity: 1 }], { destination }),
      ).expect(400);
      expect(res.body).toMatchObject({ code: 'validation-failed' });
      expect(String(res.body.detail)).toContain('pincode');
    },
  );

  it('a pre-11.1 order row reads back destination null', async () => {
    const skuId = skuIds.get('SHA-OK')!;
    await seedStock(skuId, 1);
    const res = await postOrder(opsToken, createBody([{ skuId, quantity: 1 }])).expect(201);
    const orderId = (res.body.order as { id: string }).id;
    await sql`
      update orders set
        destination_contact_name = null, destination_phone = null, destination_line1 = null,
        destination_line2 = null, destination_city = null, destination_state = null,
        destination_pincode = null
      where id = ${orderId}
    `;
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/orders/${orderId}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect((detail.body.order as { destination: unknown }).destination).toBeNull();
    const list = await getOrders(opsToken).expect(200);
    const listed = (list.body.items as { id: string; destination: unknown }[]).find(
      (item) => item.id === orderId,
    );
    expect(listed?.destination).toBeNull();
  });

  // ── the origin (warehouse create) ────────────────────────────────────────

  it('a warehouse without an origin is 400 before any write', async () => {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `SHA2-${ulid().slice(10, 16).toUpperCase()}`, name: 'No Origin WH' })
      .expect(400);
    expect(res.body).toMatchObject({ code: 'validation-failed' });
    expect(String(res.body.detail)).toContain('origin');
  });

  it('a partial origin is 400 naming the missing field, and a bad origin pincode names pincode', async () => {
    // Every field but city — the omission must be named.
    const partial = {
      contactName: 'Priya Sharma',
      phone: '+91 98450 12345',
      line1: '12, Peenya Industrial Area',
      line2: 'Gate 3',
      state: 'Karnataka',
      pincode: '560066',
    };
    const partialRes = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        code: `SHA3-${ulid().slice(10, 16).toUpperCase()}`,
        name: 'Partial Origin WH',
        origin: partial,
      })
      .expect(400);
    expect(partialRes.body).toMatchObject({ code: 'validation-failed' });
    expect(String(partialRes.body.detail)).toContain('origin.city');

    const pinRes = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        code: `SHA4-${ulid().slice(10, 16).toUpperCase()}`,
        name: 'Bad Pin WH',
        origin: testAddress({ pincode: '11001' }),
      })
      .expect(400);
    expect(pinRes.body).toMatchObject({ code: 'validation-failed' });
    expect(String(pinRes.body.detail)).toContain('pincode');
  });

  it('an origin field over its ceiling is 400: contactName past 120, line2 past 200', async () => {
    const contactRes = await postWarehouse(ownerToken, {
      code: `SHA6-${ulid().slice(10, 16).toUpperCase()}`,
      name: 'Long Contact WH',
      origin: testAddress({ contactName: 'x'.repeat(121) }),
    }).expect(400);
    expect(contactRes.body).toMatchObject({ code: 'validation-failed' });
    expect(String(contactRes.body.detail)).toContain('contactName');

    const line2Res = await postWarehouse(ownerToken, {
      code: `SHA7-${ulid().slice(10, 16).toUpperCase()}`,
      name: 'Long Line2 WH',
      origin: testAddress({ line2: 'y'.repeat(201) }),
    }).expect(400);
    expect(line2Res.body).toMatchObject({ code: 'validation-failed' });
    expect(String(line2Res.body.detail)).toContain('line2');
  });

  it('the origin echoes on the warehouse list read', async () => {
    const origin = testAddress({ contactName: 'List Echo Owner' });
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        code: `SHA5-${ulid().slice(10, 16).toUpperCase()}`,
        name: 'Echo Origin WH',
        origin,
      })
      .expect(201);
    const list = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const created = (list.body.items as { code: string; origin: Record<string, unknown> | null }[]).find(
      (item) => item.origin !== null && (item.origin as { contactName: string }).contactName === 'List Echo Owner',
    );
    expect(created).toBeDefined();
    expect(created!.origin).toEqual(origin);
  });

  // ── the destination joins BOTH payload hashes ────────────────────────────

  it('the destination joins the idempotency hash: the same key with a divergent destination is 422', async () => {
    const skuId = skuIds.get('SHA-OK')!;
    await seedStock(skuId, 2);
    const key = ulid();
    const lines = [{ skuId, quantity: 1 }];
    await postOrder(opsToken, createBody(lines, { destination: testAddress() }), key).expect(201);
    const divergent = await postOrder(
      opsToken,
      createBody(lines, { destination: testAddress({ contactName: 'Someone Else' }) }),
      key,
    ).expect(422);
    expect(divergent.body).toMatchObject({ code: 'idempotency-key-reuse' });
  });

  it('the destination joins the source dedup hash: same payload + new key resolves to the same order, a divergent destination is 422 order-source-conflict', async () => {
    const skuId = skuIds.get('SHA-DEDUP')!;
    await seedStock(skuId, 4);
    const integrationId = uuidv7();
    const externalEventId = `evt-${ulid().toLowerCase()}`;
    const payload = {
      warehouseId,
      source: 'ingested',
      integrationId,
      externalEventId,
      lines: [{ skuId, quantity: 2 }],
      destination: testAddress(),
    };
    const first = await postOrder(opsToken, payload).expect(201);
    const second = await postOrder(opsToken, payload).expect(201); // NEW key, same payload
    expect(second.body.order.id).toBe(first.body.order.id as string);

    const divergent = await postOrder(opsToken, {
      ...payload,
      destination: testAddress({ city: 'Mysuru' }),
    }).expect(422);
    expect(divergent.body).toMatchObject({ code: 'order-source-conflict' });
  });

  // ── the origin joins the idempotency hash ────────────────────────────────

  it('the origin joins the idempotency hash: the same key with a divergent origin is 422', async () => {
    // Mirrors the destination pin above for the warehouse create: the origin
    // participates in the payload hash (normalized first, so a blank line2
    // and an absent one hash the same), so the same key with a different
    // origin cannot silently replay.
    const key = ulid();
    const body = {
      code: `SHA8-${ulid().slice(10, 16).toUpperCase()}`,
      name: 'Origin Hash WH',
      origin: testAddress(),
    };
    await postWarehouse(ownerToken, body, key).expect(201);
    const divergent = await postWarehouse(
      ownerToken,
      { ...body, origin: testAddress({ contactName: 'Someone Else' }) },
      key,
    ).expect(422);
    expect(divergent.body).toMatchObject({ code: 'idempotency-key-reuse' });
    // ...and a same-key replay of the IDENTICAL body still replays.
    await postWarehouse(ownerToken, body, key).expect(201);
  });

  // ── the accepted replay break, pinned ────────────────────────────────────

  it('a key written under the pre-11.1 fingerprint no longer replays — the ACCEPTED 11.1 break, pinned', async () => {
    // Story 11-1 grew the destination into BOTH payload hashes with a fixed
    // key position (`destination: fingerprint ?? null`). A key written by a
    // pre-11.1 build hashes over a field set WITHOUT the key, so its stored
    // hash can never match an 11.1 recomputation — the same accepted break
    // story 10.2 pinned in test/picking.spec.ts. What must not happen is for
    // it to be accepted SILENTLY: this test asserts the 422 so the convention
    // change is recorded evidence.
    const skuId = skuIds.get('SHA-LEGACY')!;
    await seedStock(skuId, 2);
    const lines = [{ skuId, quantity: 2 }];
    // The pre-11.1 hash field set: exactly what the command hashed before
    // story 11-1 — NO destination key at all.
    const legacyPayloadHash = hashCommandPayload({
      tenantId,
      warehouseId,
      source: 'manual',
      integrationId: null,
      externalEventId: null,
      lines: lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity })),
    });
    const key = ulid();
    await sql`
      insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
      values (${uuidv7()}, ${tenantId}, ${key}, ${legacyPayloadHash}, ${sql.json({
        order: { id: uuidv7(), lines: [] },
      })})
    `;
    const res = await postOrder(opsToken, createBody(lines), key).expect(422);
    expect(res.body).toMatchObject({ code: 'idempotency-key-reuse' });
  });

  it('a warehouse key written under the pre-11.1 fingerprint (no origin) no longer replays — the same break on the warehouse arm, pinned', async () => {
    // Story 11-1 added `origin: fingerprint ?? null` to the warehouse hash.
    // A key written by a pre-11.1 build hashed over exactly
    // {tenantId, code, name} — NO origin key — so an 11.1 recomputation can
    // never match it; the replay must answer 422, never silently create.
    const code = `SHA9-${ulid().slice(10, 16).toUpperCase()}`;
    const legacyPayloadHash = hashCommandPayload({ tenantId, code, name: 'Legacy Origin WH' });
    const key = ulid();
    await sql`
      insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
      values (${uuidv7()}, ${tenantId}, ${key}, ${legacyPayloadHash}, ${sql.json({
        warehouse: { id: uuidv7() },
      })})
    `;
    const res = await postWarehouse(
      ownerToken,
      { code, name: 'Legacy Origin WH', origin: testAddress() },
      key,
    ).expect(422);
    expect(res.body).toMatchObject({ code: 'idempotency-key-reuse' });
  });

  it('an ingested order whose stored source hash predates 11-1 answers 422 order-source-conflict — the same break on the dedup arm, pinned', async () => {
    const skuId = skuIds.get('SHA-LEGACY')!;
    await seedStock(skuId, 2);
    const lines = [{ skuId, quantity: 2 }];
    const integrationId = uuidv7();
    const externalEventId = `evt-${ulid().toLowerCase()}`;
    // Create a REAL ingested order, then wind it back to its pre-11.1 form:
    // the source hash recomputed over the field set WITHOUT the destination,
    // and the destination columns nulled (a pre-11.1 row).
    const created = await postOrder(
      opsToken,
      createBody(lines, {
        source: 'ingested',
        integrationId,
        externalEventId,
      }),
    ).expect(201);
    const orderId = (created.body.order as { id: string }).id;
    const legacySourceHash = hashCommandPayload({
      warehouseId,
      lines: lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity })),
    });
    await sql`
      update orders set
        source_payload_hash = ${legacySourceHash},
        destination_contact_name = null, destination_phone = null, destination_line1 = null,
        destination_line2 = null, destination_city = null, destination_state = null,
        destination_pincode = null
      where id = ${orderId}
    `;
    // The same channel payload redelivered (new key): the dedup comparison
    // reads the stored legacy hash, the recomputation carries the destination,
    // they cannot match — 422, never a silent resolve to the old order.
    const res = await postOrder(
      opsToken,
      createBody(lines, { source: 'ingested', integrationId, externalEventId }),
    ).expect(422);
    expect(res.body).toMatchObject({ code: 'order-source-conflict' });
  });
});
