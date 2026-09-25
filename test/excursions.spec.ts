import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { fromMilli } from '../src/shared/primitives/quantity';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// Device intake is unused here (the excursion is a web operator action) but
// the dev env the sibling suites set keeps app boot identical.
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
// A host that exports any poll interval would boot background workers and
// race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

const SKU_CODES = ['EX-PLAIN', 'EX-BATCH', 'EX-SERIAL', 'EX-CW'] as const;

describe('Temperature excursions (e2e, story 12-5)', () => {
  let app: INestApplication;
  let facade: InventoryFacade;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorToken: string;
  let accountantToken: string;
  let warehouseId: string;
  let zoneId: string;
  let binMixed: string; // the happy-path bin: plain + batch (3 batches)
  let binEmpty: string;
  let binUnquarantinable: string; // plain + serial (the all-or-nothing arm)
  let binCatchWeight: string; // catch-weight only (the other refusal arm)
  let binSkip: string; // the already-held-scope arm
  let binPlaceHold: string; // the replay + resolve + placeHold-regression bin
  const skuIds = new Map<string, string>();

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('excursions');
    app = await createApp(false);
    await app.init();
    facade = app.get(InventoryFacade);
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    // Tenant + owner.
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Excursion Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // Warehouse → zone → six bins (one per matrix arm).
    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `EXC-${ulid().slice(10, 16).toUpperCase()}`, name: `Excursion WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
    const zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    zoneId = zone.body.id as string;
    const binBody = { capacity: 1000, type: 'shelf' };
    const binCodes = ['A-01-01', 'A-01-02', 'A-01-03', 'A-01-04', 'A-01-05', 'A-01-06'];
    const binIds: string[] = [];
    for (const code of binCodes) {
      binIds.push(
        (
          await request(app.getHttpServer())
            .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ ...binBody, code })
            .expect(201)
        ).body.id as string,
      );
    }
    binMixed = binIds[0]!;
    binEmpty = binIds[1]!;
    binUnquarantinable = binIds[2]!;
    binCatchWeight = binIds[3]!;
    binSkip = binIds[4]!;
    binPlaceHold = binIds[5]!;

    // SKUs: plain, batch-tracked (the batch arm), serial-tracked and
    // catch-weight-tracked (the refusal arms).
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      'EX-PLAIN,Excursion Plain,pcs,,1800,,false,false,false,,,',
      'EX-BATCH,Excursion Batch,pcs,,1800,,true,false,false,,,',
      'EX-SERIAL,Excursion Serial,pcs,,1800,,false,true,false,,,',
      'EX-CW,Excursion CatchWeight,pcs,,1800,,false,false,true,,,',
    ].join('\n');
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

    // An ops manager (review.decide), an operator (excursion.record — the
    // floor records what it observes) and an accountant (the 403 arm).
    const ops = await createMember('ops_manager');
    opsToken = ops.token;
    opsUserId = ops.userId;
    operatorToken = (await createMember('operator')).token;
    accountantToken = (await createMember('accountant')).token;

    // Cold-start bootstrap: the ATP reads below need the warehouse's counter
    // set ready — same as the sibling suites.
    await facade.rebuildReservationCounters(tenantId, warehouseId);
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
      // Children before parents: excursion rows → hold rows → ledger →
      // projections → spine.
      await cleaner.unsafe('DELETE FROM temperature_excursions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM qc_holds WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      await cleaner.unsafe('DELETE FROM reservations WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM batch_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM stock_on_hand WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM batches WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM outbox_messages WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM catalog_import_errors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM catalog_imports WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM uom_conversions WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM skus WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM bins WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM zones WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM warehouses WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM tenants WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      // The suite's namespaced counter keys must not outlive the rows.
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

  // ── helpers ────────────────────────────────────────────────────────────────

  /** One invite → accept → sign-in round trip: an active team user of a role. */
  async function createMember(role: 'ops_manager' | 'operator' | 'accountant'): Promise<{ userId: string; token: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    const userId = invited.body.user.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const token = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    return { userId, token };
  }

  /** Seeds committed on-hand via the stock.adjustment command (HTTP). */
  async function seedStock(
    skuId: string,
    binId: string,
    quantity: number,
    batchCode?: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId,
        quantityDelta: quantity,
        reasonCode: 'cycle-count',
        note: 'excursions-suite seed',
        ...(batchCode === undefined ? {} : { batch: { code: batchCode } }),
      })
      .expect(201);
  }

  /**
   * Seeds serial-tracked stock the only way an adjustment can: exactly one
   * named serial per unit (the batch-serial suite's intake arm).
   */
  async function seedSerialStock(skuId: string, binId: string, serials: string[]): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId,
        quantityDelta: serials.length,
        reasonCode: 'cycle-count',
        note: 'excursions-suite serial seed',
        serials,
      })
      .expect(201);
  }

  function recordExcursion(
    body: { warehouseId: string; binId: string; readingC: number; note?: string; occurredAt?: string },
    token: string = operatorToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/excursions`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function resolveExcursion(excursionId: string, token: string = opsToken, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/excursions/${excursionId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({});
  }

  async function qcBinId(): Promise<string> {
    const rows = await sql`
      select id from bins
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
      and code = 'QC-HOLD' and system_owned = true limit 1`;
    if (rows[0] === undefined) {
      throw new Error('the system QC-hold bin was never ensured');
    }
    return (rows[0] as unknown as { id: string }).id;
  }

  async function excursionLedgerRows(excursionId: string): Promise<
    { type: string; quantity_delta: number; from_bin_id: string | null; to_bin_id: string | null; batch_ref: string | null; serial_ref: string | null; sku_id: string; reference_doc: Record<string, unknown> }[]
  > {
    const rows = (await sql`
      select type, quantity_delta, from_bin_id, to_bin_id, batch_ref, serial_ref, sku_id, reference_doc
      from ledger_events
      where tenant_id = ${tenantId} and reference_doc->>'excursionId' = ${excursionId}
      order by seq`) as unknown as Awaited<ReturnType<typeof excursionLedgerRows>>;
    // `quantity_delta` is milli-units; this helper is the suite's edge, so
    // every assertion below it reads base units.
    return rows.map((row) => ({ ...row, quantity_delta: fromMilli(Number(row.quantity_delta)) }));
  }

  async function holdLedgerRows(holdId: string): Promise<
    { type: string; quantity_delta: number; from_bin_id: string | null; to_bin_id: string | null; batch_ref: string | null }[]
  > {
    const rows = (await sql`
      select type, quantity_delta, from_bin_id, to_bin_id, batch_ref from ledger_events
      where tenant_id = ${tenantId} and reference_doc->>'holdId' = ${holdId}
      order by seq`) as unknown as Awaited<ReturnType<typeof holdLedgerRows>>;
    return rows.map((row) => ({ ...row, quantity_delta: fromMilli(Number(row.quantity_delta)) }));
  }

  async function onHandAtBin(binId: string, skuId: string): Promise<number> {
    const rows = await sql`
      select coalesce(sum(quantity), 0)::bigint as n from stock_on_hand
      where tenant_id = ${tenantId} and bin_id = ${binId} and sku_id = ${skuId}`;
    return fromMilli(Number((rows[0] as unknown as { n: number }).n));
  }

  /** ATP in BASE units — the suite's own `fromMilli` edge. */
  async function atpUnits(skuId: string) {
    const snapshot = await facade.atp(tenantId, warehouseId, skuId);
    return {
      onHand: fromMilli(snapshot.onHand),
      reserved: fromMilli(snapshot.reserved),
      qcHeld: fromMilli(snapshot.qcHeld),
      buffer: fromMilli(snapshot.buffer),
      atp: fromMilli(snapshot.atp),
    };
  }

  async function outboxRows(type: string): Promise<Record<string, unknown>[]> {
    const rows = await sql`
      select payload from outbox_messages where tenant_id = ${tenantId} and type = ${type}`;
    return rows.map((row) => (row as unknown as { payload: Record<string, unknown> }).payload);
  }

  async function countRows(table: string, where: string): Promise<number> {
    const rows = await sql.unsafe(`select count(*)::int as n from ${table} where ${where}`);
    return Number((rows[0] as unknown as { n: number }).n);
  }

  // ── the matrix ─────────────────────────────────────────────────────────────

  it('happy path: a mixed bin (plain + 3-batch SKU) records one open excursion, quarantines both scopes through ordinary QC holds, appends the zero-delta per-scope events, and drops ATP (operator records — the floor verb)', async () => {
    const plainId = skuIds.get('EX-PLAIN')!;
    const batchId = skuIds.get('EX-BATCH')!;
    await seedStock(plainId, binMixed, 5);
    await seedStock(batchId, binMixed, 3, 'EXB-001');
    await seedStock(batchId, binMixed, 2, 'EXB-002');
    await seedStock(batchId, binMixed, 1, 'EXB-003');
    expect(await atpUnits(plainId)).toMatchObject({ qcHeld: 0, atp: 5 });
    expect(await atpUnits(batchId)).toMatchObject({ qcHeld: 0, atp: 6 });

    const res = await recordExcursion({
      warehouseId,
      binId: binMixed,
      readingC: 8.5,
      note: 'Chest freezer door found ajar overnight',
      occurredAt: '2026-09-25T06:30:00.000Z',
    }).expect(201);
    const excursion = res.body.excursion as Record<string, unknown>;
    expect(excursion).toMatchObject({
      tenantId,
      warehouseId,
      binId: binMixed,
      readingC: 8.5,
      note: 'Chest freezer door found ajar overnight',
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
    });
    expect((excursion.holdIds as string[]).length).toBe(2);
    expect(Date.parse(excursion.occurredAt as string)).toBe(Date.parse('2026-09-25T06:30:00.000Z'));

    const holdIds = excursion.holdIds as string[];
    // holdIds round-trip: the ids are exactly the open qc_holds rows.
    const holdRows = (await sql`
      select id, sku_id, status, reason, bin_id from qc_holds
      where tenant_id = ${tenantId} and id = any(${holdIds}::uuid[]) order by sku_id`) as unknown as {
      id: string; sku_id: string; status: string; reason: string; bin_id: string;
    }[];
    expect(holdRows).toHaveLength(2);
    expect(holdRows.map((row) => row.sku_id).sort()).toEqual([plainId, batchId].sort());
    for (const row of holdRows) {
      expect(row.status).toBe('open');
      expect(row.bin_id).toBe(binMixed);
      expect(row.reason).toContain('temperature-excursion');
    }

    // The scopes RELOCATED into the system QC-hold bin: one qc.held movement
    // per batch arm for the batch SKU (3 batches) + one batchRef-null
    // movement for the plain SKU = 4 qc.held movements across 2 holds.
    const qcBin = await qcBinId();
    expect(await onHandAtBin(binMixed, plainId)).toBe(0);
    expect(await onHandAtBin(binMixed, batchId)).toBe(0);
    expect(await onHandAtBin(qcBin, plainId)).toBe(5);
    expect(await onHandAtBin(qcBin, batchId)).toBe(6);
    const plainHold = holdRows.find((row) => row.sku_id === plainId)!;
    const batchHold = holdRows.find((row) => row.sku_id === batchId)!;
    const plainMovements = await holdLedgerRows(plainHold.id);
    expect(plainMovements).toHaveLength(1);
    expect(plainMovements[0]).toMatchObject({
      type: 'qc.held',
      quantity_delta: 5,
      from_bin_id: binMixed,
      to_bin_id: qcBin,
      batch_ref: null,
    });
    const batchMovements = await holdLedgerRows(batchHold.id);
    expect(batchMovements).toHaveLength(3);
    expect(batchMovements.map((m) => m.quantity_delta).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    for (const movement of batchMovements) {
      expect(movement).toMatchObject({ type: 'qc.held', from_bin_id: binMixed, to_bin_id: qcBin });
    }

    // ATP drops for BOTH scopes, computed from where the stock now sits.
    expect(await atpUnits(plainId)).toMatchObject({ qcHeld: 5, atp: 0 });
    expect(await atpUnits(batchId)).toMatchObject({ qcHeld: 6, atp: 0 });

    // The ledger events: TWO zero-quantity `excursion.recorded` events (one
    // per affected scope), both bin arms null, both identity arms closed,
    // each carrying the excursion reference doc (FR-45's reconstruction).
    const events = await excursionLedgerRows(excursion.id as string);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.type).toBe('excursion.recorded');
      expect(event.quantity_delta).toBe(0);
      expect(event.from_bin_id).toBeNull();
      expect(event.to_bin_id).toBeNull();
      expect(event.batch_ref).toBeNull();
      expect(event.serial_ref).toBeNull();
      expect(event.reference_doc).toMatchObject({
        kind: 'excursion',
        excursionId: excursion.id,
        binId: binMixed,
        readingC: 8.5,
      });
    }
    expect(events.map((event) => event.sku_id).sort()).toEqual([plainId, batchId].sort());

    // The decision's outbox event + audit row (reference = the idempotency key).
    const recorded = await outboxRows('excursion.recorded');
    expect(recorded.some((p) => p.excursionId === excursion.id)).toBe(true);
    const audits = await sql`
      select action, target_type, target_id, reference from audit_events
      where tenant_id = ${tenantId} and action = 'excursion.recorded' and target_id = ${String(excursion.id)}`;
    expect(audits).toHaveLength(1);

    // The review queue read shows the open excursion (any member may read).
    const list = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/excursions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const listed = (list.body.items as Record<string, unknown>[]).find(
      (it) => it.id === excursion.id,
    );
    expect(listed).toMatchObject({ status: 'open', readingC: 8.5, binId: binMixed });
    expect((listed!.holdIds as string[]).slice().sort()).toEqual(holdIds.slice().sort());
  });

  it('unquarantinable: a serial-tracked SKU in the bin refuses the ENTIRE excursion naming the offenders, nothing written', async () => {
    const plainId = skuIds.get('EX-PLAIN')!;
    const serialId = skuIds.get('EX-SERIAL')!;
    await seedStock(plainId, binUnquarantinable, 4);
    await seedSerialStock(serialId, binUnquarantinable, ['EXSN-001', 'EXSN-002']);
    const plainBefore = await onHandAtBin(binUnquarantinable, plainId);

    const res = await recordExcursion({
      warehouseId,
      binId: binUnquarantinable,
      readingC: 12,
    }).expect(400);
    expect(res.body.code).toBe('validation-failed');
    // The refusal names every OFFENDING SKU by code and id — the plain SKU is
    // not one (it would have quarantined fine on its own).
    expect(res.body.detail as string).toContain('EX-SERIAL');
    expect(res.body.detail as string).toContain(serialId);
    expect(res.body.detail as string).not.toContain('EX-PLAIN');

    // Nothing written: no excursion, no holds, no movements, on-hand intact.
    expect(await countRows('temperature_excursions', `tenant_id = '${tenantId}'::uuid and bin_id = '${binUnquarantinable}'::uuid`)).toBe(0);
    expect(await countRows('qc_holds', `tenant_id = '${tenantId}'::uuid and bin_id = '${binUnquarantinable}'::uuid`)).toBe(0);
    expect(await countRows('ledger_events', `tenant_id = '${tenantId}'::uuid and type = 'qc.held' and from_bin_id = '${binUnquarantinable}'::uuid`)).toBe(0);
    expect(await onHandAtBin(binUnquarantinable, plainId)).toBe(plainBefore);
  });

  it('unquarantinable: a catch-weight SKU refuses the excursion the same way (story 10.3 rationale)', async () => {
    const cwId = skuIds.get('EX-CW')!;
    // Catch-weight intake is receipt-only (an upward adjustment is refused),
    // and receipt needs a device session — out of this suite's path. The
    // on-hand row is driven directly instead (the out-of-band precedent of
    // qc-holds.spec's bin deletion): the arm proves the command's refusal,
    // not the seeding path.
    await sql`
      insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${cwId}, ${binCatchWeight}, 2000)`;
    const res = await recordExcursion({
      warehouseId,
      binId: binCatchWeight,
      readingC: 9,
    }).expect(400);
    expect(res.body.code).toBe('validation-failed');
    expect(res.body.detail as string).toContain('EX-CW');
    expect(await countRows('qc_holds', `tenant_id = '${tenantId}'::uuid and bin_id = '${binCatchWeight}'::uuid`)).toBe(0);
    expect(await onHandAtBin(binCatchWeight, cwId)).toBe(2);
  });

  it('empty bin: 400, nothing written; system-owned bin: 400', async () => {
    const res = await recordExcursion({ warehouseId, binId: binEmpty, readingC: 3 }).expect(400);
    expect(res.body.code).toBe('validation-failed');
    expect(res.body.detail as string).toContain('no on-hand stock');

    const qcBin = await qcBinId();
    const sysRes = await recordExcursion({ warehouseId, binId: qcBin, readingC: 3 }).expect(400);
    expect(sysRes.body.code).toBe('validation-failed');
    expect(sysRes.body.detail as string).toContain('system-owned');
  });

  it('a scope already under an open hold is SKIPPED (not a 409); the rest quarantines; holdIds omits it', async () => {
    const plainId = skuIds.get('EX-PLAIN')!;
    const batchId = skuIds.get('EX-BATCH')!;
    // binSkip: the plain scope is ALREADY held (an earlier decision), then
    // fresh stock arrived back into the bin; the batch scope is unheld. The
    // hold needs on-hand to relocate, so the first seed precedes it.
    await seedStock(plainId, binSkip, 5);
    const preRes = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/qc-holds`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: plainId, binId: binSkip, reason: 'prior inspection' })
      .expect(201);
    const priorHoldId = (preRes.body.qcHold as Record<string, unknown>).id as string;
    await seedStock(plainId, binSkip, 7);
    await seedStock(batchId, binSkip, 4, 'EXB-SKIP');

    const res = await recordExcursion({ warehouseId, binId: binSkip, readingC: -18 }).expect(201);
    const excursion = res.body.excursion as Record<string, unknown>;
    const holdIds = excursion.holdIds as string[];
    // The already-held scope is SKIPPED — holdIds carries only the new hold.
    expect(holdIds).toHaveLength(1);
    expect(holdIds).not.toContain(priorHoldId);
    const holdRows = (await sql`
      select id, sku_id from qc_holds where tenant_id = ${tenantId} and bin_id = ${binSkip} and status = 'open'`) as unknown as { id: string; sku_id: string }[];
    // Exactly two open holds on the bin: the prior one and the excursion's.
    expect(holdRows.map((row) => row.id).sort()).toEqual([priorHoldId, holdIds[0]!].sort());
    expect(holdRows.find((row) => row.id === holdIds[0])!.sku_id).toBe(batchId);

    // The skipped scope's stock stays in the origin bin (untouched); the
    // batch scope relocated. The ledger events cover the quarantined scope
    // only — holdIds, holds and events all tell the same story.
    expect(await onHandAtBin(binSkip, plainId)).toBe(7);
    expect(await onHandAtBin(binSkip, batchId)).toBe(0);
    const events = await excursionLedgerRows(excursion.id as string);
    expect(events).toHaveLength(1);
    expect(events[0]!.sku_id).toBe(batchId);
  });

  it('replay: the same idempotency key + payload re-serves the snapshot (no duplicate excursion/holds/movements); a different payload is 422', async () => {
    const plainId = skuIds.get('EX-PLAIN')!;
    await seedStock(plainId, binPlaceHold, 3);
    const key = ulid();
    const body = { warehouseId, binId: binPlaceHold, readingC: 8.5, note: 'same-key replay' };

    const first = await recordExcursion(body, operatorToken, key).expect(201);
    const replayed = await recordExcursion(body, operatorToken, key).expect(201);
    expect(replayed.body.excursion).toMatchObject({ id: first.body.excursion.id });

    expect(await countRows('temperature_excursions', `tenant_id = '${tenantId}'::uuid and bin_id = '${binPlaceHold}'::uuid`)).toBe(1);
    expect(await countRows('qc_holds', `tenant_id = '${tenantId}'::uuid and bin_id = '${binPlaceHold}'::uuid`)).toBe(1);
    expect(
      await countRows(
        'ledger_events',
        `tenant_id = '${tenantId}'::uuid and type = 'excursion.recorded' and reference_doc->>'binId' = '${binPlaceHold}'::text`,
      ),
    ).toBe(1);

    // The same key over a different payload never replays (the repo-wide 422
    // contract — the spec matrix's "409 on payload mismatch" reconciled to
    // the idempotency-key-reuse shape every sibling command uses).
    const mismatch = await recordExcursion(
      { ...body, readingC: 9.5 },
      operatorToken,
      key,
    ).expect(422);
    expect(mismatch.body.code).toBe('idempotency-key-reuse');
  });

  it('resolve: review.decide flips the status, stamps resolvedBy/At, emits excursion.resolved, leaves the holds open; second resolve 409; unknown id 404', async () => {
    const list = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/excursions`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const open = (list.body.items as { id: string; binId: string; status: string }[]).find(
      (it) => it.binId === binPlaceHold && it.status === 'open',
    )!;
    const holdRow = (await sql`
      select hold_ids from temperature_excursions where tenant_id = ${tenantId} and id = ${open.id}`)[0] as unknown as { hold_ids: string[] };
    const holdId = holdRow.hold_ids[0]!;

    const res = await resolveExcursion(open.id).expect(200);
    expect(res.body.excursion).toMatchObject({
      id: open.id,
      status: 'resolved',
      resolvedBy: opsUserId,
    });
    expect(res.body.excursion.resolvedAt).not.toBeNull();

    // The holds are UNTOUCHED — resolve releases nothing.
    const holdStatus = await sql`
      select status from qc_holds where tenant_id = ${tenantId} and id = ${holdId}`;
    expect((holdStatus[0] as unknown as { status: string }).status).toBe('open');

    const resolved = await outboxRows('excursion.resolved');
    expect(resolved.some((p) => p.excursionId === open.id)).toBe(true);
    const audits = await sql`
      select action from audit_events
      where tenant_id = ${tenantId} and action = 'excursion.resolved' and target_id = ${open.id}`;
    expect(audits).toHaveLength(1);

    // Terminal: a second resolve is a deterministic 409, and the resolved
    // excursion answers the resolved status filter.
    await resolveExcursion(open.id).expect(409);
    const reread = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/excursions?status=resolved`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(
      (reread.body.items as { id: string }[]).some((it) => it.id === open.id),
    ).toBe(true);

    await resolveExcursion(uuidv7()).expect(404);
  });

  it('capability: an accountant is 403 role-denied; an operator is accepted', async () => {
    const res = await recordExcursion(
      { warehouseId, binId: binMixed, readingC: 5 },
      accountantToken,
    ).expect(403);
    expect(res.body.code).toBe('role-denied');
    expect(res.body.detail as string).toContain('excursion.record');
    // The operator arm is the happy path above (recordExcursion defaults to
    // the operator token) — asserted there by construction.
  });

  it('reading bounds: out-of-range readings are 400 validation-failed before any write', async () => {
    const over = await recordExcursion({ warehouseId, binId: binMixed, readingC: 200.01 }).expect(400);
    expect(over.body.code).toBe('validation-failed');
    const under = await recordExcursion({ warehouseId, binId: binMixed, readingC: -100.5 }).expect(400);
    expect(under.body.code).toBe('validation-failed');
    expect(await countRows('temperature_excursions', `tenant_id = '${tenantId}'::uuid and bin_id = '${binMixed}'::uuid and reading_c <> 8.5`)).toBe(0);
  });

  it('placeHold regression: the extracted hold core keeps the ordinary QC-hold command behavior byte-identical', async () => {
    const batchId = skuIds.get('EX-BATCH')!;
    await seedStock(batchId, binPlaceHold, 2, 'EXB-PH1');
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/qc-holds`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: batchId, binId: binPlaceHold, reason: 'extraction regression' })
      .expect(201);
    const hold = res.body.qcHold as Record<string, unknown>;
    expect(hold).toMatchObject({ status: 'open', binId: binPlaceHold, skuId: batchId });
    const qcBin = await qcBinId();
    expect(await onHandAtBin(binPlaceHold, batchId)).toBe(0);
    expect(await onHandAtBin(qcBin, batchId)).toBeGreaterThanOrEqual(2);
    const movements = await holdLedgerRows(hold.id as string);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: 'qc.held', quantity_delta: 2, from_bin_id: binPlaceHold, to_bin_id: qcBin });
    // The audit row's reference is the caller's idempotency key (the
    // placeHold contract the extraction had to keep byte-identical).
    const audits = await sql`
      select reference from audit_events
      where tenant_id = ${tenantId} and action = 'qc_hold.placed' and target_id = ${String(hold.id)}`;
    expect((audits[0] as unknown as { reference: string }).reference).toHaveLength(26);
  });

  it('RLS: a tenant-scoped non-superuser session cannot read another tenant’s excursion rows; the write side is fail-closed', async () => {
    // A second tenant in the same suite database — the probe's contrast.
    const emailB = `owner-${ulid().toLowerCase()}@example.com`;
    const registeredB = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Excursion Co B ${ulid()}`, ownerEmail: emailB, password: 'correct-horse-battery' })
      .expect(201);
    const tenantB = registeredB.body.tenant.id as string;
    createdTenantIds.push(tenantB);

    // The probe role is cluster-level: idempotently ensure it (the
    // catalog.spec pattern), then connect as it.
    await sql`
      do $$ begin
        if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
          create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
        end if;
      end $$;`;
    await sql.unsafe('grant usage on schema public to wms_rls_probe');
    await sql.unsafe('grant select, insert, update, delete on all tables in schema public to wms_rls_probe');
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1 });
    try {
      // Scoped to tenant B, tenant A's excursion rows are invisible.
      await rls.unsafe(`select set_config('app.tenant_id', '${tenantB}', false)`);
      const foreign = await rls.unsafe(
        `select count(*)::int as n from temperature_excursions where tenant_id = '${tenantId}'::uuid`,
      );
      expect(Number((foreign[0] as unknown as { n: number }).n)).toBe(0);

      // Scoped to tenant A, the rows ARE visible (the policy is the only gate).
      await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
      const own = await rls.unsafe('select count(*)::int as n from temperature_excursions');
      expect(Number((own[0] as unknown as { n: number }).n)).toBeGreaterThan(0);

      // Fail-closed: an absent session setting renders every row invisible.
      await rls.unsafe("select set_config('app.tenant_id', '', false)");
      const unscoped = await rls.unsafe('select count(*)::int as n from temperature_excursions');
      expect(Number((unscoped[0] as unknown as { n: number }).n)).toBe(0);

      // The write side: a foreign-tenant INSERT is rejected by the policy.
      await expect(
        rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
          await tx`
            insert into temperature_excursions (id, tenant_id, warehouse_id, bin_id, reading_c, hold_ids, status, recorded_by, occurred_at)
            values (${uuidv7()}, ${tenantB}, ${uuidv7()}, ${uuidv7()}, 5, '{}', 'open', ${uuidv7()}, now())`;
        }),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await rls.end();
    }
  });

  it('openapi: the excursion routes are published (the record + resolve POSTs and the list GET)', async () => {
    const doc = await request(app.getHttpServer())
      .get('/api/v1/openapi.json')
      .expect(200);
    const paths = Object.keys(doc.body.paths as Record<string, unknown>);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/tenants/{tenantId}/excursions',
        '/tenants/{tenantId}/excursions/{excursionId}/resolve',
      ]),
    );
    expect(paths.filter((p) => p.includes('excursions')).length).toBe(2);
  });
});