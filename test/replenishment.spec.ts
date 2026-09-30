import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import postgres from 'postgres';
import Redis from 'ioredis';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ReplenishmentFacade, MAX_REPLENISHMENT_SCOPES_PER_TICK } from '../src/modules/replenishment/replenishment.facade';
import { REPLENISHMENT_SCHEDULER_ACTOR_ID, poCodeForDraft, poMintKey } from '../src/modules/replenishment/replenishment.command';
import { ReplenishmentSchedulerWorker, parseReplenishmentPollMs } from '../src/jobs/jobs.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
// No background worker may race these tests — the sweep is driven by calling
// the facade directly and the scheduler's tick by the plumbing block (the
// sibling suites' convention).
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.REPLENISHMENT_SCHEDULER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(120_000);

/** The probe role's cluster-global setup lock (the client-isolation helper's shape). */
const PROBE_LOCK = 7_161_001;

describe('Replenishment: reorder policies, breach alerts, suggested POs (e2e, story 6-1)', () => {
  let app: INestApplication;
  let replenishment: ReplenishmentFacade;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  // Tenant A — the main arms tenant (two default vendors, three SKUs, two
  // warehouses).
  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string;
  let warehouseId: string; // W1 — the sweep arms
  let policyWarehouseId: string; // W2 — the policy/list arms (no stock)
  let binW1: string;
  let expectedDefaultVendorId: string; // min (created_at, id) — the deterministic pick
  let breachIds: Record<string, string>; // sku code → the FIRST sweep's breach
  let draftIds: Record<string, string>; // sku code → the minted draft
  let suiteDb: SuiteDatabase;

  // Tenant C — the vendor-null arm's tenant (no vendors at all).
  let tenantC: { id: string; ownerToken: string; warehouseId: string; skuId: string; draftId: string; breachId: string };

  const skuIds = new Map<string, string>();

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('replenishment');
    app = await createApp(false);
    await app.init();
    replenishment = app.get(ReplenishmentFacade);
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    // ── Tenant A: owner + ops manager + operator ─────────────────────────────
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Replenish Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const userIdOf = await request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email, password: 'correct-horse-battery' })
      .expect(200);
    ownerToken = userIdOf.body.accessToken as string;

    const mkMember = async (role: string): Promise<{ userId: string; token: string }> => {
      const memberEmail = `${role}-${ulid().toLowerCase()}@example.com`;
      const invited = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/users`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email: memberEmail, role })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
        .expect(200);
      const session = await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: memberEmail, password: 'correct-horse-battery' })
        .expect(200);
      return { userId: invited.body.id as string, token: session.body.accessToken as string };
    };
    const ops = await mkMember('ops_manager');
    opsToken = ops.token;
    const operator = await mkMember('operator');
    operatorToken = operator.token;
    void operator;

    const mkWarehouse = async (name: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code: `RP-${ulid().slice(10, 16).toUpperCase()}`, name })
          .expect(201)
      ).body.id as string;
    warehouseId = await mkWarehouse('Replenish WH');
    policyWarehouseId = await mkWarehouse('Policy WH');

    // One bin in W1 — the stock-seeding arm's target.
    const zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' })
        .expect(201)
    ).body.id as string;
    binW1 = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 10000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;

    // SKUs: RP-A carries both tenant-wide defaults; RP-B carries NONE (the
    // override-only candidate); RP-C carries a fractional point default and
    // NO qty (the recovery-gap arm).
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode,abc_class';
    const csv = [
      csvHeader,
      `RP-A,Replenish A,kg,,1800,,false,false,false,2,3,,`,
      `RP-B,Replenish B,pcs,,1800,,false,false,false,,,,`,
      `RP-C,Replenish C,kg,,1800,,false,false,false,2.5,,`,
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
      if ((['RP-A', 'RP-B', 'RP-C'] as readonly string[]).includes(item.code)) {
        skuIds.set(item.code, item.id);
      }
    }
    expect(skuIds.size).toBe(3);

    // Two DEFAULT vendors — several defaults are possible (no single-default
    // unique): the sweep must pick deterministically min (created_at, id).
    const mkVendor = async (code: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/vendors`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, name: `${code} vendor`, isDefault: true })
          .expect(201)
      ).body.vendor.id as string;
    const v1 = await mkVendor('RP-VEND-001');
    await mkVendor('RP-VEND-002');
    const minDefault = await sql`
      select id from vendors
      where tenant_id = ${tenantId}::uuid and is_default = true
      order by created_at asc, id asc limit 1`;
    expectedDefaultVendorId = (minDefault[0] as unknown as { id: string }).id;
    expect(expectedDefaultVendorId).toBe(v1); // created FIRST → the smallest

    // ATP for W1 must be readable (cold-start bootstrap — the counters +
    // ready marker from the still-empty journal, the reservations-suite arm).
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

    breachIds = {};
    draftIds = {};

    // ── Tenant C: no vendors at all (the vendor-null arm) ────────────────────
    const cEmail = `owner-c-${ulid().toLowerCase()}@example.com`;
    const cRegistered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Vendorless Co ${ulid()}`, ownerEmail: cEmail, password: 'correct-horse-battery' })
      .expect(201);
    const cTenantId = cRegistered.body.tenant.id as string;
    createdTenantIds.push(cTenantId);
    const cToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: cEmail, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    const cWarehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${cTenantId}/warehouses`)
        .set('Authorization', `Bearer ${cToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `RP-C-${ulid().slice(10, 14).toUpperCase()}`, name: 'Vendorless WH' })
        .expect(201)
    ).body.id as string;
    const cSkuCsv = [
      csvHeader,
      `RP-N,Vendorless,pcs,,1800,,false,false,false,4,5,,`,
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${cTenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${cToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(cSkuCsv, 'utf8'), { filename: 'catalog-c.csv', contentType: 'text/csv' })
      .expect(201);
    const cSkus = (
      await request(app.getHttpServer())
        .get(`${API}/${cTenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${cToken}`)
        .expect(200)
    ).body.items as { code: string; id: string }[];
    tenantC = {
      id: cTenantId,
      ownerToken: cToken,
      warehouseId: cWarehouseId,
      skuId: cSkus[0]!.id,
      draftId: '',
      breachId: '',
    };
    await app.get(InventoryFacade).rebuildReservationCounters(cTenantId, cWarehouseId);
  });

  afterAll(async () => {
    // The suite's namespaced counter + ready keys must not outlive its rows
    // (the shared Valkey is the one truly cross-suite resource).
    try {
      await valkey.connect();
      for (const tenant of createdTenantIds) {
        const keys = await valkey.keys(`wms:{${tenant}}:*`);
        if (keys.length > 0) {
          await valkey.del(...keys);
        }
      }
    } finally {
      await valkey.quit().catch(() => valkey.disconnect());
    }
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  async function auditRows(
    action: string,
    tenant: string,
  ): Promise<{ actor_user_id: string; target_type: string; target_id: string; reference: string | null }[]> {
    const rows = await sql`
      select actor_user_id, target_type, target_id, reference from audit_events
      where tenant_id = ${tenant}::uuid and action = ${action}`;
    return rows.map((row) => row as unknown as { actor_user_id: string; target_type: string; target_id: string; reference: string | null });
  }

  async function outboxPayloads(type: string, tenant: string): Promise<Record<string, unknown>[]> {
    const rows = await sql`
      select payload from outbox_messages
      where tenant_id = ${tenant}::uuid and type = ${type} order by created_at asc`;
    return rows.map((row) => (row as { payload: Record<string, unknown> }).payload);
  }

  /** The open breach for (tenant, warehouse, sku), if any — raw (the RLS-scoped suite handle). */
  async function breachRows(tenant: string, warehouse: string, sku: string): Promise<
    { id: string; status: string; point_milli: string; atp_milli: string; resolved_by: string | null }[]
  > {
    const rows = await sql`
      select id, status, point_milli, atp_milli, resolved_by
      from reorder_breaches
      where tenant_id = ${tenant}::uuid and warehouse_id = ${warehouse}::uuid and sku_id = ${sku}::uuid
      order by created_at asc`;
    return rows.map((row) => row as unknown as { id: string; status: string; point_milli: string; atp_milli: string; resolved_by: string | null });
  }

  async function draftRows(tenant: string, warehouse: string, sku: string): Promise<
    { id: string; status: string; breach_id: string; vendor_id: string | null; quantity_milli: string; submitted_po_id: string | null }[]
  > {
    const rows = await sql`
      select id, status, breach_id, vendor_id, quantity_milli, submitted_po_id
      from suggested_pos
      where tenant_id = ${tenant}::uuid and warehouse_id = ${warehouse}::uuid and sku_id = ${sku}::uuid
      order by created_at asc`;
    return rows.map((row) => row as unknown as { id: string; status: string; breach_id: string; vendor_id: string | null; quantity_milli: string; submitted_po_id: string | null });
  }

  function putPolicy(
    tenant: string,
    token: string,
    body: Record<string, unknown>,
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .put(`${API}/${tenant}/replenishment/policies`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  // ── the policy write arms ─────────────────────────────────────────────────

  it('policy upsert: 200 with the snapshot; a replay with the same key re-serves it; key reuse with a different payload is 422', async () => {
    const key = ulid();
    const body = { warehouseId, skuId: skuIds.get('RP-B'), reorderPoint: 1500, reorderQty: 7000 };
    const created = await putPolicy(tenantId, ownerToken, body, key).expect(200);
    expect(created.body.policy).toMatchObject({
      warehouseId,
      skuId: skuIds.get('RP-B'),
      reorderPoint: 1500,
      reorderQty: 7000,
    });

    // Replay: the stored snapshot, byte-for-byte.
    const replayed = await putPolicy(tenantId, ownerToken, body, key).expect(200);
    expect(replayed.body.policy).toEqual(created.body.policy);

    // Same key, different payload → 422 idempotency-key-reuse.
    await putPolicy(tenantId, ownerToken, { ...body, reorderPoint: 1600 }, key).expect(422);
  });

  it('policy upsert: RP-A is untouched by an RP-B override (per-warehouse override wins, SKU defaults fall back)', async () => {
    const listed = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/replenishment/policies`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({ warehouseId, skuId: skuIds.get('RP-B') });
  });

  it('policy upsert refusals: non-milli/non-positive 400 naming the field; unknown/foreign warehouse or SKU 404; no-authority 403; wrong tenant 403', async () => {
    const good = { warehouseId, skuId: skuIds.get('RP-A') };
    const badQuantities: [Record<string, unknown>, string][] = [
      [{ ...good, reorderPoint: 0, reorderQty: 7000 }, 'reorderPoint'],
      [{ ...good, reorderPoint: 1500, reorderQty: -1 }, 'reorderQty'],
      [{ ...good, reorderPoint: 1.5, reorderQty: 7000 }, 'reorderPoint'],
      [{ ...good, reorderPoint: 1500, reorderQty: 7.5 }, 'reorderQty'],
    ];
    for (const [body, field] of badQuantities) {
      const refusal = await putPolicy(tenantId, ownerToken, body).expect(400);
      expect(refusal.body.code).toBe('validation-failed');
      expect((refusal.body.errors ?? []).join(' ')).toContain(field);
    }

    await putPolicy(tenantId, ownerToken, { ...good, reorderPoint: 1500, reorderQty: 7000, warehouseId: uuidv7() }).expect(404);
    await putPolicy(tenantId, ownerToken, { ...good, reorderPoint: 1500, reorderQty: 7000, skuId: uuidv7() }).expect(404);

    // The operator holds no replenishment.manage — names the capability.
    const denied = await putPolicy(tenantId, operatorToken, { ...good, reorderPoint: 1500, reorderQty: 7000 }).expect(403);
    expect(denied.body.code).toBe('role-denied');
    expect(denied.body.detail).toContain('replenishment.manage');

    // Another tenant's session on this path → 403 from the shell's own-tenant
    // assert.
    await putPolicy(tenantId, tenantC.ownerToken, { ...good, reorderPoint: 1500, reorderQty: 7000 }).expect(403);
  });

  it('policy list: limit=abc is a 400 naming the query; a malformed cursor is a 400; a foreign warehouse filter is a 404', async () => {
    const badLimit = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/replenishment/policies?limit=abc`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
    expect(badLimit.body.code).toBe('validation-failed');
    expect((badLimit.body.errors ?? []).join(' ')).toContain('limit');

    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/replenishment/policies?cursor=bogus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);

    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/replenishment/policies?warehouseId=${uuidv7()}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
  });

  it('policy delete: the row is gone; the replay re-serves the deleted snapshot; unknown 404; malformed 400', async () => {
    // An extra override on the OTHER warehouse — deleted here, leaving the
    // sweep arm's W1 override alone.
    const key = ulid();
    const created = await putPolicy(tenantId, ownerToken, {
      warehouseId: policyWarehouseId,
      skuId: skuIds.get('RP-A'),
      reorderPoint: 500,
      reorderQty: 500,
    }, key).expect(200);
    const policyId = created.body.policy.id as string;

    // The delete gets its OWN key — `key` was already consumed by the upsert
    // above (a different payload hash under it would be a 422 key reuse).
    const deleteKey = ulid();
    const deleted = await request(app.getHttpServer())
      .delete(`${API}/${tenantId}/replenishment/policies/${policyId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, deleteKey)
      .expect(200);
    expect(deleted.body.policy).toEqual(created.body.policy);

    // The audit row exists.
    const deletedAudits = (await auditRows('replenishment.policy_deleted', tenantId)).filter(
      (row) => row.target_id === policyId,
    );
    expect(deletedAudits).toHaveLength(1);

    // Replay: same delete key, same snapshot (the idempotency write survives the delete).
    const replayed = await request(app.getHttpServer())
      .delete(`${API}/${tenantId}/replenishment/policies/${policyId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, deleteKey)
      .expect(200);
    expect(replayed.body.policy).toEqual(created.body.policy);

    await request(app.getHttpServer())
      .delete(`${API}/${tenantId}/replenishment/policies/${policyId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(404);
    await request(app.getHttpServer())
      .delete(`${API}/${tenantId}/replenishment/policies/not-a-uuid`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(400);
  });

  // ── the sweep's detection arms ────────────────────────────────────────────

  it('sweep, ATP below point, no active breach: new breach rows + drafts + events + audit rows (one per candidate)', async () => {
    // Candidates at ATP 0: RP-A (default point 2000 = 2 base units),
    // RP-B (override 1500), RP-C (default point 2500; NO qty → gap arm).
    const report = await replenishment.sweepScope(tenantId, warehouseId);
    expect(report).toMatchObject({ tenantId, warehouseId, evaluated: 3, opened: 3, recovered: 0 });

    const rpA = (await breachRows(tenantId, warehouseId, skuIds.get('RP-A')!))[0]!;
    const rpB = (await breachRows(tenantId, warehouseId, skuIds.get('RP-B')!))[0]!;
    const rpC = (await breachRows(tenantId, warehouseId, skuIds.get('RP-C')!))[0]!;
    breachIds = { 'RP-A': rpA.id, 'RP-B': rpB.id, 'RP-C': rpC.id };
    // Points/ATP FROZEN at detection.
    expect(Number(rpA.point_milli)).toBe(2000);
    expect(Number(rpB.point_milli)).toBe(1500);
    expect(Number(rpC.point_milli)).toBe(2500);
    expect(Number(rpA.atp_milli)).toBe(0);
    expect(rpA.resolved_by).toBeNull();

    // Drafts: vendor = the deterministic min (created_at, id) default; qty =
    // the effective reorder_qty (> 0) else the recovery gap (whole base units
    // rounded UP: 2.5 base shortfall → 3 base units).
    const dA = (await draftRows(tenantId, warehouseId, skuIds.get('RP-A')!))[0]!;
    const dB = (await draftRows(tenantId, warehouseId, skuIds.get('RP-B')!))[0]!;
    const dC = (await draftRows(tenantId, warehouseId, skuIds.get('RP-C')!))[0]!;
    draftIds = { 'RP-A': dA.id, 'RP-B': dB.id, 'RP-C': dC.id };
    expect(dA.breach_id).toBe(rpA.id);
    expect(dB.breach_id).toBe(rpB.id);
    expect(dC.breach_id).toBe(rpC.id);
    for (const draft of [dA, dB, dC]) {
      expect(draft.status).toBe('draft');
      expect(draft.vendor_id).toBe(expectedDefaultVendorId);
    }
    expect(Number(dA.quantity_milli)).toBe(3000); // the effective reorder_qty
    expect(Number(dB.quantity_milli)).toBe(7000); // the override's qty
    expect(Number(dC.quantity_milli)).toBe(3000); // ceil(2500/1000) = 3 base units (whole-unit ceil)

    // The events: one per OPEN, with the frozen snapshot and the notify hint.
    const payloads = await outboxPayloads('replenishment.breach_detected', tenantId);
    expect(payloads).toHaveLength(3);
    const aPayload = payloads.find((p) => p.skuId === skuIds.get('RP-A'))!;
    expect(aPayload).toMatchObject({
      breachId: rpA.id,
      warehouseId,
      pointMilli: 2000,
      atpMilli: 0,
      breachAt: expect.any(String),
      notifyRole: 'ops_manager',
    });

    // The audit rows: under the module-reserved actor, one per breach.
    const audits = await auditRows('replenishment.breach_detected', tenantId);
    expect(audits.map((row) => row.target_id).sort()).toEqual(
      [rpA.id, rpB.id, rpC.id].sort(),
    );
    expect(audits.every((row) => row.actor_user_id === REPLENISHMENT_SCHEDULER_ACTOR_ID)).toBe(true);
  });

  it('sweep, already active: a no-op — no new breach row, no duplicate event, no second draft', async () => {
    const eventsBefore = (await outboxPayloads('replenishment.breach_detected', tenantId)).length;
    const draftsBefore = (await draftRows(tenantId, warehouseId, skuIds.get('RP-A')!)).length;
    const report = await replenishment.sweepScope(tenantId, warehouseId);
    expect(report).toMatchObject({ evaluated: 3, opened: 0, recovered: 0 });
    const eventsAfter = (await outboxPayloads('replenishment.breach_detected', tenantId)).length;
    expect(eventsAfter).toBe(eventsBefore);
    expect((await draftRows(tenantId, warehouseId, skuIds.get('RP-A')!)).length).toBe(draftsBefore);
  });

  it('sweep, ATP ≥ point: the open breach RECOVERS (resolved_by stays null — nobody acted), the draft stays a draft, and NO event fires', async () => {
    // Seed stock past the effective points: 10 base units each (10000 milli).
    for (const code of ['RP-A', 'RP-B', 'RP-C']) {
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId: skuIds.get(code),
          binId: binW1,
          quantityDelta: 10,
          reasonCode: 'stock-count',
          note: 'replenishment-suite recovery seed',
        })
        .expect(201);
    }

    const eventsBefore = (await outboxPayloads('replenishment.breach_detected', tenantId)).length
      + (await outboxPayloads('replenishment.suggested_po_submitted', tenantId)).length;
    const report = await replenishment.sweepScope(tenantId, warehouseId);
    expect(report).toMatchObject({ evaluated: 3, opened: 0, recovered: 3 });

    for (const code of ['RP-A', 'RP-B', 'RP-C']) {
      const breaches = await breachRows(tenantId, warehouseId, skuIds.get(code)!);
      expect(breaches).toHaveLength(1);
      expect(breaches[0]!.status).toBe('recovered');
      expect(breaches[0]!.resolved_by).toBeNull();
      // The draft KEPT as a draft.
      const drafts = await draftRows(tenantId, warehouseId, skuIds.get(code)!);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.status).toBe('draft');
      expect(drafts[0]!.breach_id).toBe(breaches[0]!.id);
    }
    // NO event on recovery (surface-visible state change only).
    const eventsAfter = (await outboxPayloads('replenishment.breach_detected', tenantId)).length
      + (await outboxPayloads('replenishment.suggested_po_submitted', tenantId)).length;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('re-breach: ATP falls back below the point → a NEW breach row opens; the standing draft is REPOINTED (fresh vendor/qty replace the old)', async () => {
    // Draw the stock back out (ATP 0 again), and widen RP-B's planned
    // quantity so the repoint's REPLACE is observable.
    for (const code of ['RP-A', 'RP-B', 'RP-C']) {
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId: skuIds.get(code),
          binId: binW1,
          quantityDelta: -10,
          reasonCode: 'stock-count',
          note: 'replenishment-suite re-breach draw',
        })
        .expect(201);
    }
    await putPolicy(tenantId, ownerToken, {
      warehouseId,
      skuId: skuIds.get('RP-B'),
      reorderPoint: 1500,
      reorderQty: 9000,
    }).expect(200);

    const report = await replenishment.sweepScope(tenantId, warehouseId);
    expect(report).toMatchObject({ evaluated: 3, opened: 3, recovered: 0 });

    // New rows: the terminal `recovered` rows were NOT re-opened.
    const rpA = await breachRows(tenantId, warehouseId, skuIds.get('RP-A')!);
    expect(rpA).toHaveLength(2);
    expect(rpA[0]!.status).toBe('recovered');
    expect(rpA[1]!.status).toBe('open');
    expect(rpA[1]!.id).not.toBe(breachIds['RP-A']);

    // The standing draft: SAME id, repointed to the fresh breach, and the
    // fresh quantity replaces the old suggestion.
    const dB = (await draftRows(tenantId, warehouseId, skuIds.get('RP-B')!))[0]!;
    expect(dB.id).toBe(draftIds['RP-B']);
    const rpB = (await breachRows(tenantId, warehouseId, skuIds.get('RP-B')!))[1]!;
    expect(dB.breach_id).toBe(rpB.id);
    expect(Number(dB.quantity_milli)).toBe(9000);
    expect(dB.status).toBe('draft');
  });

  // ── the dismiss arm ──────────────────────────────────────────────────────

  it('dismiss an open breach: 200 with the dismissed entry; the DRAFT STAYS a draft; a second dismissal is 409 breach-not-open', async () => {
    const rpC = (await breachRows(tenantId, warehouseId, skuIds.get('RP-C')!))[1]!;
    const key = ulid();
    const dismissed = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/replenishment/breaches/${rpC.id}/dismiss`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .expect(200);
    expect(dismissed.body.breach).toMatchObject({ id: rpC.id, status: 'dismissed' });
    expect(dismissed.body.breach.resolvedBy).toBeTruthy();

    // The draft is untouched by the dismissal (dismissal is about the breach).
    const dC = (await draftRows(tenantId, warehouseId, skuIds.get('RP-C')!))[0]!;
    expect(dC.status).toBe('draft');

    // Terminal: another dismissal (fresh key) is the 409 naming the status.
    const refused = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/replenishment/breaches/${rpC.id}/dismiss`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .expect(409);
    expect(refused.body.code).toBe('breach-not-open');
    expect(refused.body.detail).toContain('dismissed');

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/replenishment/breaches/${uuidv7()}/dismiss`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .expect(404);
  });

  it('breach list reads: status filter works; the operator (any member) can read', async () => {
    const open = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/replenishment/breaches?status=open`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    expect(open.body.items).toHaveLength(2); // RP-A + RP-B opened on the re-breach
    const dismissed = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/replenishment/breaches?status=dismissed`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect(dismissed.body.items).toHaveLength(1);
    const badStatus = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/replenishment/breaches?status=floating`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
    expect(badStatus.body.code).toBe('validation-failed');
  });

  // ── the submit arm ────────────────────────────────────────────────────────

  it('submit a vendor-named draft: a REAL PO on the inbound path, the FLAT response carrier, draft → submitted, breach → actioned, event + audit', async () => {
    const dA = (await draftRows(tenantId, warehouseId, skuIds.get('RP-A')!))[0]!;
    expect(dA.vendor_id).not.toBeNull();
    const key = ulid();
    const submitted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/replenishment/suggested-pos/${dA.id}/submit`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ quantityMilli: 5500 }) // the planner's edit
      .expect(200);

    // The FLAT carrier: body.purchaseOrder IS the PO (never the wrapped
    // `{purchaseOrder: {…}}` shape the FE would read `undefined` off).
    const po = submitted.body.purchaseOrder as {
      id: string; code: string; status: string; vendorId: string; warehouseId: string;
      lines: { skuId: string; orderedQty: number }[];
    };
    expect((submitted.body.purchaseOrder as Record<string, unknown>).purchaseOrder).toBeUndefined();
    expect(po.id).toBeTruthy();
    expect(po.code).toBe(poCodeForDraft(dA.id));
    expect(po.status).toBe('open');
    expect(po.vendorId).toBe(dA.vendor_id);
    expect(po.warehouseId).toBe(warehouseId);
    expect(po.lines).toMatchObject([{ skuId: skuIds.get('RP-A'), orderedQty: 5.5 }]);
    expect(submitted.body.suggestedPoId).toBe(dA.id);

    // The draft settled.
    const settled = (await draftRows(tenantId, warehouseId, skuIds.get('RP-A')!))[0]!;
    expect(settled.status).toBe('submitted');
    expect(settled.submitted_po_id).toBe(po.id);
    // …the breach reads actioned with the human resolver.
    const rpA = (await breachRows(tenantId, warehouseId, skuIds.get('RP-A')!))[1]!;
    expect(rpA.status).toBe('actioned');
    expect(rpA.resolved_by).not.toBeNull();

    // The deterministic inner idempotency key landed on the mint.
    const mintKeys = await sql`
      select key from idempotency_keys where tenant_id = ${tenantId}::uuid and key = ${poMintKey(dA.id)}`;
    expect(mintKeys).toHaveLength(1);

    // The event names the minted PO.
    const payloads = await outboxPayloads('replenishment.suggested_po_submitted', tenantId);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      suggestedPoId: dA.id,
      poId: po.id,
      poCode: po.code,
      warehouseId,
      vendorId: dA.vendor_id,
      quantityMilli: 5500,
    });
    const audits = await auditRows('replenishment.suggested_po_submitted', tenantId);
    expect(audits.map((row) => row.target_id)).toEqual([dA.id]);

    // The PO is readable on the inbound detail read (a real PO, not a side row).
    const detail = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/inbound/purchase-orders/${po.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(detail.body.purchaseOrder.id).toBe(po.id);

    // Replay with the same key re-serves the settled result.
    const replayed = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/replenishment/suggested-pos/${dA.id}/submit`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ quantityMilli: 5500 })
      .expect(200);
    expect(replayed.body).toEqual(submitted.body);

    // Not a draft: a fresh key (any edits) is 409 suggested-po-submitted.
    const refused = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/replenishment/suggested-pos/${dA.id}/submit`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(409);
    expect(refused.body.code).toBe('suggested-po-submitted');
    expect(refused.body.detail).toContain('submitted');
  });

  it('submit refusals: a null-vendor draft refuses 400 suggested-po-vendor-required; a vanishing vendor 404s verbatim and the draft STAYS a draft; edits carry the milli guard', async () => {
    // Tenant C: the draft minted with NO tenant default vendor.
    const cReport = await replenishment.sweepScope(tenantC.id, tenantC.warehouseId);
    expect(cReport).toMatchObject({ evaluated: 1, opened: 1, recovered: 0 });
    const cDraft = (await draftRows(tenantC.id, tenantC.warehouseId, tenantC.skuId))[0]!;
    tenantC.draftId = cDraft.id;
    expect(cDraft.vendor_id).toBeNull();

    // A bare submit (no body at all) keeps the draft's values — vendor null →
    // the 400 naming the missing vendor.
    const refused = await request(app.getHttpServer())
      .post(`${API}/${tenantC.id}/replenishment/suggested-pos/${cDraft.id}/submit`)
      .set('Authorization', `Bearer ${tenantC.ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(400);
    expect(refused.body.code).toBe('suggested-po-vendor-required');
    expect((await draftRows(tenantC.id, tenantC.warehouseId, tenantC.skuId))[0]!.status).toBe('draft');

    // Edits carry the milli guard (validation-failed naming quantityMilli).
    const badQty = await request(app.getHttpServer())
      .post(`${API}/${tenantC.id}/replenishment/suggested-pos/${cDraft.id}/submit`)
      .set('Authorization', `Bearer ${tenantC.ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ quantityMilli: 1.5 })
      .expect(400);
    expect(badQty.body.code).toBe('validation-failed');
    expect((badQty.body.errors ?? []).join(' ')).toContain('quantityMilli');

    // Inner refusal, verbatim: submit tenant A's RP-B draft with a vendor the
    // tenant does not have — the inbound mint's own 404 surfaces, and the
    // draft stays a draft, the breach stays open.
    const dB = (await draftRows(tenantId, warehouseId, skuIds.get('RP-B')!))[0]!;
    const foreignVendor = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/replenishment/suggested-pos/${dB.id}/submit`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ vendorId: uuidv7() })
      .expect(404);
    expect(foreignVendor.body.code).toBe('not-found');
    expect((await draftRows(tenantId, warehouseId, skuIds.get('RP-B')!))[0]!.status).toBe('draft');
    const rpB = (await breachRows(tenantId, warehouseId, skuIds.get('RP-B')!))[1]!;
    expect(rpB.status).toBe('open');
  });

  it('submit 403: a member without replenishment.manage is refused; lists stay open to members', async () => {
    const dC = (await draftRows(tenantId, warehouseId, skuIds.get('RP-C')!))[0]!;
    const denied = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/replenishment/suggested-pos/${dC.id}/submit`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .expect(403);
    expect(denied.body.code).toBe('role-denied');
    // But the operator reads the queues freely.
    await request(app.getHttpServer())
      .get(`${API}/${tenantId}/replenishment/suggested-pos`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
  });

  it('submit in tenant C with a vendor edit: the PO mints with the edited vendor and quantity', async () => {
    const vendorId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantC.id}/vendors`)
        .set('Authorization', `Bearer ${tenantC.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'RPN-1', name: 'Late Vendor' })
        .expect(201)
    ).body.vendor.id as string;

    const submitted = await request(app.getHttpServer())
      .post(`${API}/${tenantC.id}/replenishment/suggested-pos/${tenantC.draftId}/submit`)
      .set('Authorization', `Bearer ${tenantC.ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ vendorId })
      .expect(200);
    const po = submitted.body.purchaseOrder as { id: string; code: string; vendorId: string; lines: { orderedQty: number }[] };
    expect(po.vendorId).toBe(vendorId);
    expect(po.lines).toMatchObject([{ orderedQty: 5 }]); // the draft's 5000 milli
    tenantC.breachId = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantC.id}/replenishment/breaches?status=actioned`)
        .set('Authorization', `Bearer ${tenantC.ownerToken}`)
        .expect(200)
    ).body.items[0]!.id as string;
    expect(tenantC.breachId).toBeTruthy();
  });

  it('an ATP read failure NEVER reads as 0 — the scope is skipped whole, nothing changes', async () => {
    const inventory = app.get(InventoryFacade);
    const spy = jest.spyOn(inventory, 'atp').mockRejectedValue(new Error('valkey down'));
    try {
      await expect(replenishment.sweepScope(tenantId, warehouseId)).rejects.toThrow('valkey down');
      // Nothing minted, nothing recovered, nothing audited by the failed sweep.
      const rpB = await breachRows(tenantId, warehouseId, skuIds.get('RP-B')!);
      expect(rpB).toHaveLength(2);
      expect(rpB.map((row) => row.status)).toEqual(['recovered', 'open']);
      const drafts = await draftRows(tenantId, warehouseId, skuIds.get('RP-B')!);
      expect(drafts).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('RLS: fail-closed without the tenant stamp; tenant-scoped reads; a foreign update touches nothing; a foreign insert refuses (42501)', async () => {
    // Ensure the probe role (the client-isolation helper's shape).
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${PROBE_LOCK})`;
      await tx.unsafe(`
        do $$ begin
          if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
            create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
          end if;
        end $$;
      `);
      await tx.unsafe('grant usage on schema public to wms_rls_probe');
      await tx.unsafe('grant select, insert, update, delete on all tables in schema public to wms_rls_probe');
    });
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const probe = postgres(url.toString(), { max: 1 });
    try {
      // Fail-closed: no tenant stamp → nothing visible.
      const unscoped = await probe.unsafe(
        `select count(*)::int as n from reorder_breaches where tenant_id = '${tenantId}'::uuid`,
      );
      expect(Number((unscoped[0] as unknown as { n: number }).n)).toBe(0);

      // Tenant-stamped: only the stamped tenant's rows.
      const scoped = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantC.id}, true)`;
        return tx.unsafe(`select count(*)::int as n from reorder_breaches where tenant_id = '${tenantId}'::uuid`);
      });
      expect(Number((scoped[0] as unknown as { n: number }).n)).toBe(0);
      const own = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantC.id}, true)`;
        return tx.unsafe(`select count(*)::int as n from reorder_breaches where tenant_id = '${tenantC.id}'::uuid`);
      });
      expect(Number((own[0] as unknown as { n: number }).n)).toBe(1);

      // A foreign-context UPDATE touches nothing.
      const touched = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantC.id}, true)`;
        return tx.unsafe(
          `update reorder_policies set reorder_qty_milli = 1 where tenant_id = '${tenantId}'::uuid`,
        );
      });
      expect(touched.count).toBe(0);

      // A foreign-context INSERT refuses at the row (WITH CHECK).
      const foreignInsert = probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantC.id}, true)`;
        return tx.unsafe(
          `insert into reorder_policies (id, tenant_id, warehouse_id, sku_id, reorder_point_milli, reorder_qty_milli, created_at, updated_at)
           values ('${uuidv7()}'::uuid, '${tenantId}'::uuid, '${warehouseId}'::uuid, '${skuIds.get('RP-A')}'::uuid, 1, 1, now(), now())`,
        );
      });
      await expect(foreignInsert).rejects.toMatchObject({ code: '42501' });
    } finally {
      await probe.end();
    }
  });
});

// ── the worker shell (unit, the count scheduler's plumbing pattern) ─────────

describe('replenishment scheduler plumbing (unit, story 6-1)', () => {
  const ENV_KEY = 'REPLENISHMENT_SCHEDULER_POLL_MS';

  function setEnv(value: string | undefined): void {
    if (value === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = value;
    }
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error('waitFor: condition never became true');
      }
      await delay(5);
    }
  }

  afterEach(() => {
    setEnv(undefined);
  });

  describe('parseReplenishmentPollMs', () => {
    it('unset and empty are off (0)', () => {
      expect(parseReplenishmentPollMs(undefined)).toBe(0);
      expect(parseReplenishmentPollMs('')).toBe(0);
    });

    it('non-negative integers pass through (0 included)', () => {
      expect(parseReplenishmentPollMs('300000')).toBe(300_000);
      expect(parseReplenishmentPollMs('0')).toBe(0);
    });

    it('anything not a non-negative integer fails the boot loudly', () => {
      expect(() => parseReplenishmentPollMs('hourly')).toThrow(/REPLENISHMENT_SCHEDULER_POLL_MS/);
      expect(() => parseReplenishmentPollMs('1.5')).toThrow(/REPLENISHMENT_SCHEDULER_POLL_MS/);
      expect(() => parseReplenishmentPollMs('-5')).toThrow(/REPLENISHMENT_SCHEDULER_POLL_MS/);
    });
  });

  /**
   * An AUTH-database stub answering the tick's TWO enumeration reads: the
   * first call is the policies query, the second the tenant-wide defaults
   * query (the worker alternates by call order).
   */
  function stubAuthDb(
    policyScopes: { tenantId: string; warehouseId: string }[],
    defaultScopes: { tenantId: string; warehouseId: string }[],
  ): { calls: number; execute(): Promise<unknown> } {
    let call = 0;
    return {
      get calls() {
        return call;
      },
      execute: async () => {
        call += 1;
        // The tick alternates: odd calls are the policies query, even the defaults query.
        return call % 2 === 1 ? policyScopes : defaultScopes;
      },
    };
  }

  /** A facade stub recording sweep calls, able to hold one in flight. */
  function stubFacade(): {
    calls: { tenantId: string; warehouseId: string }[];
    hold: boolean;
    sweepScope(tenantId: string, warehouseId: string): Promise<unknown>;
    release(): void;
  } {
    const calls: { tenantId: string; warehouseId: string }[] = [];
    let held: (() => void) | undefined;
    return {
      calls,
      hold: false,
      async sweepScope(tenantId, warehouseId) {
        calls.push({ tenantId, warehouseId });
        if (this.hold && held === undefined) {
          await new Promise<void>((resolve) => {
            held = resolve;
          });
        }
        return { tenantId, warehouseId, evaluated: 0, opened: 0, recovered: 0 };
      },
      release() {
        held?.();
        held = undefined;
      },
    };
  }

  it('an invalid env fails the constructor (loud boot, not a silent worker)', () => {
    for (const bad of ['hourly', '1.5', '-5']) {
      setEnv(bad);
      expect(() => new ReplenishmentSchedulerWorker(stubAuthDb([], []) as never, stubFacade() as never)).toThrow(
        /REPLENISHMENT_SCHEDULER_POLL_MS/,
      );
    }
  });

  it('tick() dedupes the two scope queries and sweeps every (tenant, warehouse) in deterministic order', async () => {
    setEnv('20');
    const authDb = stubAuthDb(
      [
        { tenantId: 't-1', warehouseId: 'w-1' },
        { tenantId: 't-1', warehouseId: 'w-2' },
      ],
      [
        { tenantId: 't-1', warehouseId: 'w-2' }, // the dedup arm
        { tenantId: 't-2', warehouseId: 'w-9' },
      ],
    );
    const facade = stubFacade();
    const worker = new ReplenishmentSchedulerWorker(authDb as never, facade as never);
    await worker.tick();
    // Policy scopes first, then the defaults-only warehouses, dupes shed.
    expect(facade.calls).toEqual([
      { tenantId: 't-1', warehouseId: 'w-1' },
      { tenantId: 't-1', warehouseId: 'w-2' },
      { tenantId: 't-2', warehouseId: 'w-9' },
    ]);
    expect(authDb.calls).toBe(2);
  });

  it('tick() carries at most MAX_REPLENISHMENT_SCOPES_PER_TICK scopes and logs the truncation loudly', async () => {
    setEnv('20');
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const many = Array.from({ length: MAX_REPLENISHMENT_SCOPES_PER_TICK + 10 }, (_, i) => ({
      tenantId: `t-${Math.floor(i / 100)}`,
      warehouseId: `w-${i}`,
    }));
    const facade = stubFacade();
    const worker = new ReplenishmentSchedulerWorker(stubAuthDb(many, []) as never, facade as never);
    try {
      await worker.tick();
      expect(facade.calls).toHaveLength(MAX_REPLENISHMENT_SCOPES_PER_TICK);
      expect(warnSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        `carried ${MAX_REPLENISHMENT_SCOPES_PER_TICK} of ${MAX_REPLENISHMENT_SCOPES_PER_TICK + 10}`,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a poison scope is skipped and the NEXT scope still sweeps (never starves the tick)', async () => {
    setEnv('20');
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const calls: string[] = [];
    const poisoned = {
      async sweepScope(tenantId: string, warehouseId: string): Promise<unknown> {
        calls.push(warehouseId);
        if (warehouseId === 'w-1') {
          throw new Error('boom');
        }
        return { evaluated: 0, opened: 0, recovered: 0 };
      },
    };
    const worker = new ReplenishmentSchedulerWorker(
      stubAuthDb([{ tenantId: 't-1', warehouseId: 'w-1' }, { tenantId: 't-1', warehouseId: 'w-2' }], []) as never,
      poisoned as never,
    );
    try {
      await worker.tick();
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'Replenishment scheduler could not sweep warehouse w-1',
      );
      expect(calls).toEqual(['w-1', 'w-2']);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('an in-flight tick sheds the next ticks until it settles', async () => {
    setEnv('20');
    const facade = stubFacade();
    facade.hold = true;
    const worker = new ReplenishmentSchedulerWorker(
      stubAuthDb([{ tenantId: 't-1', warehouseId: 'w-1' }], []) as never,
      facade as never,
    );
    const first = worker.tick();
    await waitFor(() => facade.calls.length === 1);
    await worker.tick(); // shed — returns immediately
    expect(facade.calls).toHaveLength(1);
    facade.release();
    await first;
    expect(facade.calls).toHaveLength(1);
  });

  it('pollMs=0 (env unset) schedules nothing', async () => {
    setEnv(undefined);
    const facade = stubFacade();
    const worker = new ReplenishmentSchedulerWorker(stubAuthDb([{ tenantId: 't-1', warehouseId: 'w-1' }], []) as never, facade as never);
    worker.onApplicationBootstrap();
    await delay(60);
    expect(facade.calls).toHaveLength(0);
    worker.onApplicationShutdown();
  });

  it('bootstrap with a poll interval drives the tick on the timer; shutdown clears it', async () => {
    setEnv('20');
    const facade = stubFacade();
    const worker = new ReplenishmentSchedulerWorker(
      stubAuthDb([{ tenantId: 't-1', warehouseId: 'w-1' }], []) as never,
      facade as never,
    );
    worker.onApplicationBootstrap();
    try {
      await waitFor(() => facade.calls.length >= 3);
    } finally {
      worker.onApplicationShutdown();
    }
    // No further sweeps after shutdown.
    await delay(80);
    const atShutdown = facade.calls.length;
    expect(atShutdown).toBeGreaterThanOrEqual(3);
    await delay(50);
    expect(facade.calls.length).toBe(atShutdown);
  });
});