import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import type { ProblemException } from '../src/shared/problem-details/problem.exception';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// Device intake is unused here (the hold is a web Ops-Manager action) but the
// dev env the sibling suites set keeps app boot identical.
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
// A host that exports any poll interval would boot background workers and
// race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

const SKU_CODES = ['QC-PLAIN', 'QC-BATCH', 'QC-EMPTY'] as const;

/** The machine-readable code of a rejected ProblemException (the contract). */
function codeOf(error: unknown): string {
  return ((error as ProblemException).getResponse() as { code: string }).code;
}

describe('QC hold and release (e2e, story 3.4)', () => {
  let app: INestApplication;
  let facade: InventoryFacade;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorToken: string; // a team operator (web session) — the 403 arm
  let warehouseId: string;
  let binA: string;
  let binB: string;
  let batchHoldId: string;
  const skuIds = new Map<string, string>();

  beforeAll(async () => {
    // Same deployment-parity probes as the sibling suites (auth + RLS roles,
    // serialized across parallel jest workers by the advisory lock).
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(742106)`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_auth_probe') then
              create role wms_auth_probe login password 'wms_auth_probe' nosuperuser bypassrls;
            end if;
            if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
              create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_auth_probe, wms_rls_probe');
        await tx.unsafe(
          'grant select, insert, update, delete on all tables in schema public to wms_auth_probe, wms_rls_probe',
        );
      });
      const authUrl = new URL(process.env.DATABASE_URL!);
      authUrl.username = 'wms_auth_probe';
      authUrl.password = 'wms_auth_probe';
      process.env.DATABASE_AUTH_URL = authUrl.toString();
    } finally {
      await admin.end();
    }
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
      .send({ name: `QC Hold Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // Warehouse → zone → two bins.
    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: `QCH-${ulid().slice(10, 16).toUpperCase()}`, name: `QC WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
    const zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    const zoneId = zone.body.id as string;
    const binBody = { capacity: 1000, type: 'shelf' };
    binA = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...binBody, code: 'A-01-01' })
        .expect(201)
    ).body.id as string;
    binB = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...binBody, code: 'A-01-02' })
        .expect(201)
    ).body.id as string;

    // SKUs: one plain, one batch-tracked (the batch arm), one for the empty scope.
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      'QC-PLAIN,QC Item Plain,pcs,,1800,,false,false,,,',
      'QC-BATCH,QC Item Batch,pcs,,1800,,true,false,,,',
      'QC-EMPTY,QC Item Empty,pcs,,1800,,false,false,,,',
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

    // An ops manager (the qc.manage authority) and an operator (the 403 arm).
    const ops = await createMember('ops_manager');
    opsToken = ops.token;
    opsUserId = ops.userId;
    operatorToken = (await createMember('operator')).token;

    // Cold-start bootstrap: the grant arms below need the warehouse's counter
    // set ready (the operator path after a Valkey flush) — same as 2.3's suite.
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
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // Children before parents: hold rows → ledger → projections → spine.
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
  async function createMember(role: 'ops_manager' | 'operator'): Promise<{ userId: string; token: string }> {
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
        note: 'qc-holds-suite seed',
        ...(batchCode === undefined ? {} : { batch: { code: batchCode } }),
      })
      .expect(201);
  }

  function placeHold(
    body: { warehouseId: string; skuId: string; binId: string; reason: string },
    token = opsToken,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/qc-holds`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function releaseHold(holdId: string, token = opsToken, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/qc-holds/${holdId}/release`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({});
  }

  async function qcHoldRow(id: string): Promise<Record<string, unknown> | undefined> {
    const rows = await sql`
      select id, status, reason, held_by, held_at, released_by, released_at, bin_id, sku_id, warehouse_id
      from qc_holds where tenant_id = ${tenantId} and id = ${id}`;
    return rows[0] as unknown as Record<string, unknown> | undefined;
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

  async function holdLedgerRows(holdId: string): Promise<
    { type: string; quantity_delta: number; from_bin_id: string | null; to_bin_id: string | null; batch_ref: string | null; reference_doc: Record<string, unknown> }[]
  > {
    return (await sql`
      select type, quantity_delta, from_bin_id, to_bin_id, batch_ref, reference_doc from ledger_events
      where tenant_id = ${tenantId} and reference_doc->>'holdId' = ${holdId}
      order by seq`) as unknown as Awaited<ReturnType<typeof holdLedgerRows>>;
  }

  async function onHandAtBin(binId: string, skuId: string): Promise<number> {
    const rows = await sql`
      select coalesce(sum(quantity), 0)::int as n from stock_on_hand
      where tenant_id = ${tenantId} and bin_id = ${binId} and sku_id = ${skuId}`;
    return Number((rows[0] as unknown as { n: number }).n);
  }

  async function outboxRows(type: string): Promise<Record<string, unknown>[]> {
    const rows = await sql`
      select payload from outbox_messages where tenant_id = ${tenantId} and type = ${type}`;
    return rows.map((row) => (row as unknown as { payload: Record<string, unknown> }).payload);
  }

  // ── hold happy path: the stock relocates, ATP drops ────────────────────────

  it('hold happy path: 201, qc.held movements into the system QC-hold bin, open row, outbox + audit, ATP snapshot pins qcHeld', async () => {
    const skuId = skuIds.get('QC-PLAIN')!;
    await seedStock(skuId, binA, 5);
    expect(await facade.atp(tenantId, warehouseId, skuId)).toMatchObject({ qcHeld: 0, atp: 5 });

    const res = await placeHold({
      warehouseId,
      skuId,
      binId: binA,
      reason: 'Carton damaged in transit — pending inspection',
    }).expect(201);
    const hold = res.body.qcHold as Record<string, unknown>;
    expect(hold).toMatchObject({
      tenantId,
      warehouseId,
      skuId,
      binId: binA,
      reason: 'Carton damaged in transit — pending inspection',
      status: 'open',
      heldBy: opsUserId,
      releasedBy: null,
      releasedAt: null,
    });
    expect(Date.parse(hold.heldAt as string)).not.toBeNaN();

    // The scope's stock RELOCATED: binA is empty, the QC bin holds the units,
    // and the ledger carries one qc.held movement per arm — never a
    // zero-delta event, never a direct stock_on_hand write.
    const qcBin = await qcBinId();
    expect(await onHandAtBin(binA, skuId)).toBe(0);
    expect(await onHandAtBin(qcBin, skuId)).toBe(5);
    const movements = await holdLedgerRows(hold.id as string);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: 'qc.held',
      quantity_delta: 5,
      from_bin_id: binA,
      to_bin_id: qcBin,
      batch_ref: null,
    });
    expect(movements[0]!.reference_doc).toMatchObject({
      kind: 'qc-hold',
      holdId: hold.id,
      fromBinId: binA,
    });

    const row = await qcHoldRow(hold.id as string);
    expect(row).toMatchObject({ status: 'open', bin_id: binA, held_by: opsUserId });

    // The decision's outbox event + audit row (reference = the idempotency key).
    const placed = await outboxRows('qc_hold.placed');
    expect(placed.some((p) => p.holdId === hold.id)).toBe(true);
    const audits = await sql`
      select action, target_type, target_id, reference from audit_events
      where tenant_id = ${tenantId} and action = 'qc_hold.placed' and target_id = ${String(hold.id)}`;
    expect(audits).toHaveLength(1);

    // ATP snapshot: the held units drop out in BOTH terms — qcHeld is the
    // QC bin's on-hand and atp = committedOnHand − reserved − qcHeld.
    expect(await facade.atp(tenantId, warehouseId, skuId)).toMatchObject({
      onHand: 5,
      reserved: 0,
      qcHeld: 5,
      buffer: 0,
      atp: 0,
    });

    // The holds list read shows the open hold (any member may read).
    const list = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/receiving/qc-holds`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const listed = (list.body.items as Record<string, unknown>[]).find((it) => it.id === hold.id);
    expect(listed).toMatchObject({ status: 'open', reason: hold.reason });
  });

  it('hold an empty scope: 400 validation-failed naming the empty scope, nothing written', async () => {
    const skuId = skuIds.get('QC-EMPTY')!;
    const res = await placeHold({ warehouseId, skuId, binId: binA, reason: 'empty arm' })
      .expect(400);
    expect(res.body.code).toBe('validation-failed');
    expect(res.body.detail as string).toContain(skuId);
    const rows = await sql`
      select count(*)::int as n from qc_holds
      where tenant_id = ${tenantId} and sku_id = ${skuId} and bin_id = ${binA}`;
    expect(Number((rows[0] as unknown as { n: number }).n)).toBe(0);
  });

  it('double hold: 409 qc-hold-open, no second row', async () => {
    const skuId = skuIds.get('QC-PLAIN')!;
    const open = (await sql`
      select id from qc_holds where tenant_id = ${tenantId} and sku_id = ${skuId} and status = 'open' limit 1
    `)[0] as unknown as { id: string } | undefined;
    expect(open).toBeDefined(); // the happy path's hold is still open
    const res = await placeHold({
      warehouseId,
      skuId,
      binId: binA,
      reason: 'a second hold on the same open scope',
    }).expect(409);
    expect(res.body.code).toBe('qc-hold-open');
    const rows = await sql`
      select count(*)::int as n from qc_holds
      where tenant_id = ${tenantId} and sku_id = ${skuId} and bin_id = ${binA} and status = 'open'`;
    expect(Number((rows[0] as unknown as { n: number }).n)).toBe(1);
  });

  it('wrong authority: operator session 403 role-denied; foreign-tenant path 403 permission-denied', async () => {
    const skuId = skuIds.get('QC-EMPTY')!;
    const denied = await placeHold(
      { warehouseId, skuId, binId: binA, reason: 'operator attempt' },
      operatorToken,
    ).expect(403);
    expect(denied.body.code).toBe('role-denied');
    expect(denied.body.detail as string).toContain('qc.manage');

    const foreign = await request(app.getHttpServer())
      .post(`${API}/${uuidv7()}/receiving/qc-holds`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId: binA, reason: 'foreign path' })
      .expect(403);
    expect(foreign.body.code).toBe('permission-denied');
  });

  it('idempotent place: same key+payload re-serves the snapshot; mismatched payload 422', async () => {
    const skuId = skuIds.get('QC-BATCH')!;
    await seedStock(skuId, binB, 4, 'LOT-2026-1');
    const key = ulid();
    const body = { warehouseId, skuId, binId: binB, reason: 'Suspect lot — inspection pending' };
    const first = await placeHold(body, opsToken, key).expect(201);
    const replay = await placeHold(body, opsToken, key).expect(201);
    expect(replay.body.qcHold.id as string).toBe(first.body.qcHold.id as string);
    expect(replay.body).toEqual(first.body);
    // The batch arm: the hold's movement carries the batch ref and the batch
    // fold moved with it.
    const movements = await holdLedgerRows(first.body.qcHold.id as string);
    expect(movements[0]).toMatchObject({ type: 'qc.held', quantity_delta: 4, batch_ref: expect.any(String) });
    expect(await onHandAtBin(binB, skuId)).toBe(0);

    const mismatch = await placeHold(
      { warehouseId, skuId, binId: binB, reason: 'A different reason' },
      opsToken,
      key,
    ).expect(422);
    expect(mismatch.body.code).toBe('idempotency-key-reuse');

    // The release arm reuses this hold.
    batchHoldId = first.body.qcHold.id as string;
  });

  it('release happy path: qc.released movements back to the recorded origin bin, row released, ATP restored; double release 409', async () => {
    const skuId = skuIds.get('QC-BATCH')!;
    const holdId = batchHoldId;
    const qcBin = await qcBinId();
    expect(await onHandAtBin(qcBin, skuId)).toBe(4);

    const res = await releaseHold(holdId).expect(200);
    const released = res.body.qcHold as Record<string, unknown>;
    expect(released).toMatchObject({
      id: holdId,
      status: 'released',
      releasedBy: opsUserId,
    });
    expect(Date.parse(released.releasedAt as string)).not.toBeNaN();

    // The units returned to the RECORDED origin bin — the hold row's, never a
    // caller-chosen one — on the same batch arms.
    expect(await onHandAtBin(binB, skuId)).toBe(4);
    expect(await onHandAtBin(qcBin, skuId)).toBe(0);
    const movements = await holdLedgerRows(holdId);
    const releasedArm = movements.find((m) => m.type === 'qc.released');
    expect(releasedArm).toMatchObject({
      quantity_delta: 4,
      from_bin_id: qcBin,
      to_bin_id: binB,
      batch_ref: movements.find((m) => m.type === 'qc.held')!.batch_ref,
    });
    expect(releasedArm!.reference_doc).toMatchObject({ kind: 'qc-hold', holdId });

    const row = await qcHoldRow(holdId);
    expect(row).toMatchObject({ status: 'released' });
    expect(row!.released_by).toBe(opsUserId);
    const releasedEvents = await outboxRows('qc_hold.released');
    expect(releasedEvents.some((p) => p.holdId === holdId)).toBe(true);
    const audits = await sql`
      select count(*)::int as n from audit_events
      where tenant_id = ${tenantId} and action = 'qc_hold.released' and target_id = ${holdId}`;
    expect(Number((audits[0] as unknown as { n: number }).n)).toBe(1);

    expect(await facade.atp(tenantId, warehouseId, skuId)).toMatchObject({ qcHeld: 0, atp: 4 });

    const second = await releaseHold(holdId).expect(409);
    expect(second.body.code).toBe('qc-hold-released');
  });

  it('reserve held stock: grant against a QC-held scope is 409 unavailable naming the held units', async () => {
    const skuId = skuIds.get('QC-BATCH')!;
    await seedStock(skuId, binA, 3, 'LOT-GRANT');
    const holdId = (await placeHold(
      { warehouseId, skuId, binId: binA, reason: 'Held for the grant-refusal arm' },
    ).expect(201)).body.qcHold.id as string;
    const atp = await facade.atp(tenantId, warehouseId, skuId);
    // onHand counts the whole warehouse SKU (the release arm restored the
    // other batch scope's 4 units to binB); the grant ceiling subtracts the
    // 3 QC-held units from it.
    expect(atp).toMatchObject({ onHand: 7, qcHeld: 3, atp: 4 });

    // The grant asks for more than the post-hold ceiling (onHand 7 − the 3
    // QC-held units = 4 sellable) — refused deterministically, the detail
    // naming the QC-held units (the grant probe's detail).
    try {
      await facade.grantReservation({
        tenantId,
        warehouseId,
        skuId,
        ownerType: 'order-line',
        ownerId: `qc-refusal-${ulid().toLowerCase()}`,
        quantity: 5,
      });
      throw new Error('the grant must refuse');
    } catch (error) {
      expect((error as ProblemException).getStatus()).toBe(409);
      expect(codeOf(error)).toBe('unavailable');
      expect(((error as ProblemException).getResponse() as { detail?: string }).detail ?? '')
        .toContain('QC-held');
    }

    // Release restores the whole warehouse SKU's ATP (the 3 units return).
    await releaseHold(holdId).expect(200);
    expect(await facade.atp(tenantId, warehouseId, skuId)).toMatchObject({ qcHeld: 0, atp: 7 });
  });

  it('origin bin missing mid-hold: 409, no movement, hold stays open', async () => {
    const skuId = skuIds.get('QC-PLAIN')!;
    await seedStock(skuId, binB, 2);
    const holdId = (await placeHold(
      { warehouseId, skuId, binId: binB, reason: 'Held before the bin vanishes' },
    ).expect(201)).body.qcHold.id as string;
    const qcBin = await qcBinId();
    // The happy path's hold on (QC-PLAIN, binA) is still open too — the QC
    // bin carries both scopes (5 + 2); concurrent holds of one SKU from
    // different origin bins never cross-return (the release arms prove it).
    expect(await onHandAtBin(qcBin, skuId)).toBe(7);

    // The bin row disappears out-of-band (no app path deletes bins in v1 —
    // the story 3.6 retire state extends this arm when it lands).
    await sql`delete from bins where tenant_id = ${tenantId} and id = ${binB}`;

    const res = await releaseHold(holdId).expect(409);
    expect(res.body.code).toBe('qc-hold-origin-bin-gone');
    expect(await qcHoldRow(holdId)).toMatchObject({ status: 'open' });
    // No release movement slipped in; the QC bin still holds the units.
    expect(
      (await holdLedgerRows(holdId)).filter((m) => m.type === 'qc.released'),
    ).toHaveLength(0);
    expect(await onHandAtBin(qcBin, skuId)).toBe(7);
  });

  it('holds list: status filter works; a crafted cursor is 400 invalid-cursor', async () => {
    // Released rows exist from the arms above; filter both ways.
    const openPage = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/receiving/qc-holds?status=open`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of openPage.body.items as Record<string, unknown>[]) {
      expect(item.status).toBe('open');
    }
    const releasedPage = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/receiving/qc-holds?status=released`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(releasedPage.body.items.length).toBeGreaterThan(0);

    const bad = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/receiving/qc-holds?cursor=${Buffer.from('garbage').toString('base64')}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
    expect(bad.body.code).toBe('invalid-cursor');
  });

  it('RLS: a non-superuser session scoped to one tenant sees no qc_holds rows of another tenant and cannot write foreign rows', async () => {
    const foreignTenantId = uuidv7();
    try {
      await sql`
        insert into qc_holds (id, tenant_id, warehouse_id, sku_id, bin_id, reason, status, held_by, held_at)
        values (${uuidv7()}, ${foreignTenantId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 'foreign row', 'open', ${uuidv7()}, now())`;

      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1 });
      try {
        await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
        const foreign = await rls.unsafe(
          `select count(*)::int as n from qc_holds where tenant_id = '${foreignTenantId}'::uuid`,
        );
        expect(Number((foreign[0] as unknown as { n: number }).n)).toBe(0);
        // Control: scoped to the foreign tenant the row IS visible.
        await rls.unsafe(`select set_config('app.tenant_id', '${foreignTenantId}', false)`);
        const own = await rls.unsafe('select count(*)::int as n from qc_holds');
        expect(Number((own[0] as unknown as { n: number }).n)).toBe(1);
        // The write side is fail-closed: a foreign-tenant INSERT is rejected.
        await expect(
          rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            await tx`insert into qc_holds (id, tenant_id, warehouse_id, sku_id, bin_id, reason, status, held_by, held_at)
              values (${uuidv7()}, ${foreignTenantId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 'foreign write', 'open', ${uuidv7()}, now())`;
          }),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await rls.end();
      }
    } finally {
      await sql.unsafe(`delete from qc_holds where tenant_id = '${foreignTenantId}'::uuid`);
    }
  });

  it('DB backstops: the release-pairing CHECK and the open-scope partial unique index reject direct writes', async () => {
    // Use the released plain scope from the arms above for the index arm.
    const released = (await sql`
      select id, tenant_id, warehouse_id, sku_id, bin_id from qc_holds
      where tenant_id = ${tenantId} and status = 'released' limit 1
    `)[0] as unknown as
      | { id: string; tenant_id: string; warehouse_id: string; sku_id: string; bin_id: string }
      | undefined;
    expect(released).toBeDefined();

    // A released row without released_by/at violates the pairing CHECK.
    await expect(
      sql`
        update qc_holds set status = 'released'
        where tenant_id = ${tenantId} and status = 'open' and id = (select id from qc_holds where tenant_id = ${tenantId} and status = 'open' limit 1)`,
    ).rejects.toThrow(/qc_holds_release_pairing/i);

    // A second OPEN row on an already-open scope violates the partial unique
    // index; a second RELEASED row for the same scope is fine (history).
    const openRow = (await sql`
      select id, warehouse_id, sku_id, bin_id from qc_holds where tenant_id = ${tenantId} and status = 'open' limit 1
    `)[0] as unknown as { id: string; warehouse_id: string; sku_id: string; bin_id: string } | undefined;
    expect(openRow).toBeDefined();
    await expect(
      sql`
        insert into qc_holds (id, tenant_id, warehouse_id, sku_id, bin_id, reason, status, held_by, held_at)
        values (${uuidv7()}, ${tenantId}, ${openRow!.warehouse_id}, ${openRow!.sku_id}, ${openRow!.bin_id}, 'index arm', 'open', ${uuidv7()}, now())`,
    ).rejects.toThrow(/qc_holds_open_scope_unique/i);
    await sql`
      insert into qc_holds (id, tenant_id, warehouse_id, sku_id, bin_id, reason, status, held_by, held_at, released_by, released_at)
      values (${uuidv7()}, ${tenantId}, ${openRow!.warehouse_id}, ${openRow!.sku_id}, ${openRow!.bin_id}, 'released twin', 'released', ${uuidv7()}, now(), ${uuidv7()}, now())`;
  });
});