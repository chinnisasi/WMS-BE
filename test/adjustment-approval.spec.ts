import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from '../src/shared/primitives/ids';
import { fromMilli } from '../src/shared/primitives/quantity';
import { ADJUSTMENT_REASON_CODES } from '../src/modules/inventory/adjustment-reason';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions — the same bootstrap the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
/** The invitee's own password (set at accept-invite, spec 1.5). */
const INVITEE_PASSWORD = 'team-member-password';

jest.setTimeout(120_000);

/**
 * Story 5-2 — stock adjustments with approval thresholds, end to end.
 *
 * The one sentence this suite exists to keep true: **an adjustment whose
 * |quantityDelta| STRICTLY exceeds the tenant's threshold pends instead of
 * applying** — no ledger event, no on-hand change, no handling-unit status
 * change — and an Owner's decision re-executes the stored arms as fresh
 * ledger events at DECISION time, with the whole decide transaction rolling
 * back (the row staying pending) when the world moved since the pend.
 */
function nowUtc(): string {
  return new Date().toISOString();
}

describe('stock adjustment approval thresholds (e2e, story 5-2)', () => {
  let app: INestApplication;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let opsUserId: string;
  let opsToken: string;
  let warehouseId: string;
  let binA: string;
  let binB: string;
  const skuIds = new Map<string, string>();

  // Receipt-path fixtures for the catch-weight arms (the only way to create
  // live handling units): a floor device, its badge-in operator.
  let deviceToken: string;
  let operatorToken: string;

  let suiteDb: SuiteDatabase;

  // The over-threshold pend's request key + id — the replay test re-serves
  // the SAME stored snapshot under the SAME key (frozen matrix row).
  let overPendKey = '';
  let overPendId = '';

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('adjustment_approval');
    app = await createApp(false);
    await app.init();
  });

  afterAll(async () => {
    await cleanupRows();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      // The ledger tables are append-only by trigger — the suite's cleanup
      // rides the superuser's replication-role bypass (sibling-suite rule).
      await sql.unsafe('set session_replication_role = replica');
      await sql.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await sql.unsafe('set session_replication_role = DEFAULT');
      // Story 5-2's own tables first (no inbound references to them, but the
      // pendings carry no FKs — order is readability, not constraint).
      for (const table of ['stock_adjustment_pendings', 'stock_adjustment_policies']) {
        await sql.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      for (const table of [
        'picks',
        'picklist_lines',
        'picklists',
        'waves',
        'wave_policies',
        'order_lines',
        'orders',
        'qc_holds',
        'handling_units',
        'putaway_placements',
        'over_receipts',
        'goods_receipt_lines',
        'goods_receipt_notes',
        'purchase_order_lines',
        'purchase_orders',
        'vendors',
        'kit_compositions',
      ]) {
        await sql.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      for (const table of [
        'reservations',
        'reconciliation_checkpoints',
        'inventory_quarantines',
        'serials',
        'batch_on_hand',
        'stock_on_hand',
        'bin_state_epochs',
        'outbox_messages',
        'idempotency_keys',
        'audit_events',
        'catalog_import_errors',
        'catalog_imports',
        'uom_conversions',
        'batches',
        'skus',
        'devices',
        'bins',
        'zones',
        'warehouses',
      ]) {
        await sql.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      // The auth tables live in the AUTH database.
      const authUrl = process.env.DATABASE_AUTH_URL ?? process.env.DATABASE_URL!;
      const authSql = postgres(authUrl, { max: 1 });
      try {
        await authSql.unsafe('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
        await authSql.unsafe('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [createdTenantIds]);
      } finally {
        await authSql.end();
      }
    } finally {
      await sql.end();
    }
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────

  interface AdjustBody {
    warehouseId: string;
    skuId: string;
    binId: string;
    quantityDelta: number;
    reasonCode: string;
    note: string;
    batch?: { code: string; mfgDate?: string; expiryDate?: string; overrideReason?: string };
    serials?: string[];
    handlingUnitIds?: string[];
  }

  function adjust(body: AdjustBody, key = ulid(), token = opsToken): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function putPolicy(threshold: number, key = ulid(), token = ownerToken): SupertestTest {
    return request(app.getHttpServer())
      .put(`${API}/${tenantId}/inventory/adjustment-policies`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ quantityThreshold: threshold });
  }

  function getPolicy(token = ownerToken): SupertestTest {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/inventory/adjustment-policies`)
      .set('Authorization', `Bearer ${token}`);
  }

  function listPendings(query = '', token = opsToken): SupertestTest {
    return request(app.getHttpServer())
      .get(`${API}/${tenantId}/inventory/adjustment-pendings${query}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function approve(
    pendingId: string,
    key = ulid(),
    token = ownerToken,
    atTenant = tenantId,
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${atTenant}/inventory/adjustment-pendings/${pendingId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({});
  }

  function reject(pendingId: string, key = ulid(), token = ownerToken): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustment-pendings/${pendingId}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({});
  }

  function submitGrn(
    body: {
      warehouseId: string;
      poId: string | null;
      blindReasonCode: string | null;
      occurredAt: string;
      lines: {
        poLineId: string | null;
        skuId: string;
        batchCode: string | null;
        mfgDate: string | null;
        qty: number;
        weightsGrams?: number[] | null;
      }[];
    },
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  /** Receives catch-weight units, then puts them into bin A (pickable). */
  async function seedPickableUnits(skuCode: string, weights: number[]): Promise<string[]> {
    const received = await submitGrn({
      warehouseId,
      poId: null,
      blindReasonCode: 'unannounced-delivery',
      occurredAt: nowUtc(),
      lines: [
        { poLineId: null, skuId: sku(skuCode), batchCode: null, mfgDate: null, qty: weights.length, weightsGrams: weights },
      ],
    }).expect(201);
    const grn = received.body.goodsReceipt;
    const line = grn.lines[0];
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/putaway/placements`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        grnId: grn.id,
        grnLineId: line.id,
        skuId: sku(skuCode),
        toBinId: binA,
        qty: weights.length,
        // The server re-derives its own suggestion; this seed helper places
        // where the tests need the stock, so it records the mismatch reason.
        reasonCode: 'operator-preference',
        occurredAt: nowUtc(),
      })
      .expect(201);
    return line.handlingUnitIds as string[];
  }

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`fixture SKU ${code} missing`);
    return id;
  }

  // ── SQL probes ───────────────────────────────────────────────────────────

  async function withSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  }

  /** The (bin, sku) on-hand in base units — the projection the pend must NOT move. */
  async function onHandFor(binId: string, skuId: string): Promise<number> {
    return withSql(async (sql) => {
      const rows = await sql`
        select quantity from stock_on_hand
        where tenant_id = ${tenantId} and bin_id = ${binId} and sku_id = ${skuId}
      `;
      return rows.length === 0 ? 0 : fromMilli(Number((rows[0] as { quantity: string | number }).quantity));
    });
  }

  async function batchOnHandFor(batchId: string, binId: string): Promise<number> {
    return withSql(async (sql) => {
      const rows = await sql`
        select quantity from batch_on_hand
        where tenant_id = ${tenantId} and batch_id = ${batchId} and bin_id = ${binId}
      `;
      return rows.length === 0 ? 0 : fromMilli(Number((rows[0] as { quantity: string | number }).quantity));
    });
  }

  /** Ledger events for one SKU (the pend must add none; the decision adds the arm). */
  async function eventCountFor(skuId: string): Promise<number> {
    return withSql(async (sql) => {
      const rows = await sql`
        select count(*)::int as n from ledger_events
        where tenant_id = ${tenantId} and sku_id = ${skuId}
      `;
      return (rows[0] as { n: number }).n;
    });
  }

  interface AuditRow {
    action: string;
    actor_user_id: string;
    target_type: string;
    target_id: string;
    reference: string | null;
  }

  async function auditRows(action: string): Promise<AuditRow[]> {
    return withSql(async (sql) => {
      return (await sql`
        select action, actor_user_id, target_type, target_id, reference
        from audit_events
        where tenant_id = ${tenantId} and action = ${action}
        order by occurred_at, id
      `) as unknown as AuditRow[];
    });
  }

  async function outboxRows(type: string): Promise<{ payload: Record<string, unknown> }[]> {
    return withSql(async (sql) => {
      return (await sql`
        select payload from outbox_messages
        where tenant_id = ${tenantId} and type = ${type}
        order by occurred_at, id
      `) as unknown as { payload: Record<string, unknown> }[];
    });
  }

  interface PendRow {
    id: string;
    status: string;
    quantity_milli: string;
    threshold_quantity_at_request: number;
    requested_by: string;
  }

  async function pendRow(pendingId: string): Promise<PendRow | undefined> {
    return withSql(async (sql) => {
      const rows = await sql`
        select id, status, quantity_milli, threshold_quantity_at_request, requested_by
        from stock_adjustment_pendings
        where tenant_id = ${tenantId} and id = ${pendingId}
      `;
      return rows[0] as unknown as PendRow | undefined;
    });
  }

  /** The invitee's own member session, with the user id the invite returned. */
  async function inviteMember(
    role: string,
    password = INVITEE_PASSWORD,
  ): Promise<{ token: string; userId: string; email: string }> {
    const email = `member-${ulid().toLowerCase()}@example.com`;
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
      .send({ token: invited.body.inviteToken, password })
      .expect(200);
    const token = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password })
        .expect(200)
    ).body.accessToken as string;
    return { token, userId, email };
  }

  beforeAll(async () => {
    // Tenant + owner + an ops manager (holds stock.adjust; NOT the owner-only
    // adjustments.approve).
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Approval Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    ({ token: opsToken, userId: opsUserId } = await inviteMember('ops_manager'));

    // Warehouse → zone → two bins (binB exists to be retired mid-suite).
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ origin: testAddress(), code: `APR-${ulid().slice(10, 16).toUpperCase()}`, name: `Approval WH ${ulid()}` })
      .expect(201);
    warehouseId = warehouse.body.id as string;
    const zone = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    const binBody = { capacity: 1000, type: 'shelf' };
    binA = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.body.id as string}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...binBody, code: 'A-01-01' })
        .expect(201)
    ).body.id as string;
    binB = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.body.id as string}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...binBody, code: 'A-01-02' })
        .expect(201)
    ).body.id as string;

    // Six fixture SKUs: two flagless (one stays stockless to become a kit),
    // batch-tracked, serial-tracked, catch-weight, and a kit component.
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      'PLAIN-1,Flagless control,pcs,,1800,,false,false,false,,,',
      'PLAIN-2,Future kit,pcs,,1800,,false,false,false,,,',
      'BT-1,Batch Pills,pcs,,1800,,true,false,false,,,',
      'ST-1,Serial Widgets,pcs,,1800,,false,true,false,,,',
      'CW-1,Beef cases,case,,1800,,false,false,true,,,',
      'COMP-1,Kit component,pcs,,1800,,false,false,false,,,',
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const catalog = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of catalog.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }
    expect(skuIds.size).toBe(6);

    // The floor device + its badge-in operator (every receipt rides it) —
    // the catch-weight units can only come from a real receipt.
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Dock scale scanner', pin: '2468' })
      .expect(201);
    deviceToken = enrolled.body.deviceToken as string;
    // Badge-in signs an operator-bound session — the operator user must
    // exist first (the catch-weight suite's dance: invite, accept, badge-in).
    const operator = await inviteMember('operator', 'correct-horse-battery');
    operatorToken = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${deviceToken}`)
        .send({ operatorEmail: operator.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;
  });

  // ── the flow is OFF until a policy row exists ────────────────────────────

  it('without a policy every adjustment applies immediately; the applied path audits stock_adjustment.recorded against the ledger event', async () => {
    const before = await eventCountFor(sku('PLAIN-1'));
    const key = ulid();
    const res = await adjust(
      {
        warehouseId, skuId: sku('PLAIN-1'), binId: binA,
        quantityDelta: 11, // over any would-be threshold — the policy is what gates, not the size
        reasonCode: 'stock-count', note: 'flow disabled until configured',
      },
      key,
    ).expect(201);
    expect(res.body.event.id).toBeDefined();
    expect(res.body.onHand.quantity).toBe(11);
    expect(await eventCountFor(sku('PLAIN-1'))).toBe(before + 1);

    const rows = await auditRows('stock_adjustment.recorded');
    const mine = rows.find((row) => row.reference === key);
    expect(mine).toBeDefined();
    expect(mine!.target_type).toBe('ledger_event');
    expect(mine!.target_id).toBe(res.body.event.id);
    expect(mine!.actor_user_id).toBe(opsUserId);
  });

  it('GET adjustment-policies before any write is 404 not-found (the flow is disabled)', async () => {
    const res = await getPolicy().expect(404);
    expect(res.body.code).toBe('not-found');
  });

  it('the policy write is owner-only: ops_manager gets 403 role-denied', async () => {
    const res = await putPolicy(10, ulid(), opsToken).expect(403);
    expect(res.body.code).toBe('role-denied');
  });

  it('the owner PUT creates the policy and GET reads it back', async () => {
    const put = await putPolicy(10, ulid()).expect(200);
    expect(put.body.quantityThreshold).toBe(10);
    expect(put.body.tenantId).toBe(tenantId);
    expect(put.body.id).toBeDefined();

    const got = await getPolicy().expect(200);
    expect(got.body.id).toBe(put.body.id);
    expect(got.body.quantityThreshold).toBe(10);
  });

  it('the policy write is idempotent: the same key replays; the same key with a different threshold is 422 idempotency-key-reuse', async () => {
    const key = ulid();
    const first = await putPolicy(10, key).expect(200);
    const replay = await putPolicy(10, key).expect(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.quantityThreshold).toBe(10);

    const reuse = await putPolicy(12, key).expect(422);
    expect(reuse.body.code).toBe('idempotency-key-reuse');
    // The refused write changed nothing.
    expect((await getPolicy().expect(200)).body.quantityThreshold).toBe(10);
  });

  it('invalid thresholds are 400 validation-failed: negative, non-integer, over the int4 max', async () => {
    await putPolicy(-5).expect(400);
    await putPolicy(10.5).expect(400);
    await putPolicy(2147483648).expect(400);
  });

  it('the policy write audits stock_adjustment.policy_updated against the policy row', async () => {
    const policyId = (await getPolicy().expect(200)).body.id as string;
    const rows = await auditRows('stock_adjustment.policy_updated');
    const mine = rows.find((row) => row.target_id === policyId);
    expect(mine).toBeDefined();
    expect(mine!.target_type).toBe('stock_adjustment_policy');
    expect(mine!.actor_user_id).toBe(ownerUserId);
  });

  // ── the frozen I/O matrix: at-threshold applies, over-threshold pends ────

  it('at-threshold applies immediately (201); strictly-over pends (202) with no ledger event, no on-hand change, and the threshold context', async () => {
    // AT the threshold (10): applies — strictly-greater pends.
    const at = await adjust({
      warehouseId, skuId: sku('PLAIN-1'), binId: binA,
      quantityDelta: 10, reasonCode: 'stock-count', note: 'at threshold',
    }).expect(201);
    expect(at.body.onHand.quantity).toBe(21);

    // ONE over: pends.
    const before = await eventCountFor(sku('PLAIN-1'));
    overPendKey = ulid();
    const res = await adjust(
      {
        warehouseId, skuId: sku('PLAIN-1'), binId: binA,
        quantityDelta: 11, reasonCode: 'stock-count', note: 'needs the owner',
      },
      overPendKey,
    ).expect(202);
    const pend = res.body.pendingAdjustment;
    overPendId = pend.id;
    expect(pend.status).toBe('pending');
    expect(pend.quantityDelta).toBe(11);
    expect(pend.thresholdQuantityAtRequest).toBe(10);
    expect(pend.reasonCode).toBe('stock-count');
    expect(pend.note).toBe('needs the owner');
    expect(pend.requestedBy).toBe(opsUserId);
    expect(pend.decidedBy).toBeNull();
    expect(pend.decidedAt).toBeNull();
    expect(pend.batchId).toBeNull();
    expect(pend.serialIds).toBeNull();
    expect(pend.handlingUnitIds).toBeNull();

    // No ledger event, no on-hand change — the pend wrote NOTHING stock-side.
    expect(await eventCountFor(sku('PLAIN-1'))).toBe(before);
    expect(await onHandFor(binA, sku('PLAIN-1'))).toBe(21);

    // The audit row points at the PEND, not a ledger event.
    const audits = await auditRows('stock_adjustment.recorded');
    const mine = audits.find((row) => row.reference === overPendKey);
    expect(mine).toBeDefined();
    expect(mine!.target_type).toBe('stock_adjustment_pending');
    expect(mine!.target_id).toBe(pend.id);

    // The Owner is told (outbox-only functional entry).
    const notifications = await outboxRows('stock_adjustment.pending_approval');
    const notice = notifications.find((row) => row.payload.pendingAdjustmentId === pend.id);
    expect(notice).toBeDefined();
    expect(notice!.payload).toMatchObject({
      warehouseId,
      skuId: sku('PLAIN-1'),
      binId: binA,
      quantityDelta: 11,
      reasonCode: 'stock-count',
      requestedBy: opsUserId,
      thresholdQuantity: 10,
      notifyRole: 'owner',
    });
  });

  it('a replayed over-threshold request re-serves its stored 202 pend (nothing below replay runs)', async () => {
    const beforeCount = (await listPendings('?status=pending&limit=200').expect(200)).body.items.length;
    // The same key AND the same raw body as the pend creation above: the
    // stored pend is the answer — same id, no second row.
    const replay = await adjust(
      {
        warehouseId, skuId: sku('PLAIN-1'), binId: binA,
        quantityDelta: 11, reasonCode: 'stock-count', note: 'needs the owner',
      },
      overPendKey,
    ).expect(202);
    expect(replay.body.pendingAdjustment.id).toBe(overPendId);
    expect(replay.body.pendingAdjustment.thresholdQuantityAtRequest).toBe(10);
    const after = await listPendings('?status=pending&limit=200').expect(200);
    expect(after.body.items.length).toBe(beforeCount); // no second pend
  });

  it('a negative delta over threshold pends too (the guard set, not the sign, decides)', async () => {
    const res = await adjust({
      warehouseId, skuId: sku('PLAIN-1'), binId: binA,
      quantityDelta: -11, reasonCode: 'damaged', note: 'rejected pend fodder',
    }).expect(202);
    expect(res.body.pendingAdjustment.quantityDelta).toBe(-11);
    expect(res.body.pendingAdjustment.status).toBe('pending');
  });

  it('the queue read lists pendings with resolved arms and threshold context; the status filter partitions decided rows', async () => {
    const pending = await listPendings('?status=pending').expect(200);
    expect(pending.body.items.length).toBeGreaterThanOrEqual(2);
    for (const row of pending.body.items) {
      expect(row.status).toBe('pending');
      expect(row.decidedBy).toBeNull();
    }
    const byDelta = new Map(
      (pending.body.items as { quantityDelta: number; id: string }[]).map((row) => [row.quantityDelta, row.id]),
    );
    expect(byDelta.get(11)).toBeDefined();
    expect(byDelta.get(-11)).toBeDefined();

    // A decided-status filter starts empty (nothing decided yet).
    const approved = await listPendings('?status=approved').expect(200);
    expect(approved.body.items).toHaveLength(0);
  });

  it('keyset pagination: pages compose without repeats, the cursor exhausts, a bogus cursor is 400 invalid-cursor', async () => {
    // Five more pends → a queue worth paging through (2 + 5 = 7 pending).
    for (const delta of [12, 13, 14, 15, 16]) {
      await adjust({
        warehouseId, skuId: sku('PLAIN-1'), binId: binA,
        quantityDelta: delta, reasonCode: 'other', note: `pagination fodder ${delta}`,
      }).expect(202);
    }

    const full = await listPendings('?status=pending&limit=200').expect(200);
    const allIds = (full.body.items as { id: string }[]).map((row) => row.id);
    expect(allIds.length).toBe(7);

    // Walk two-row pages; the composition must equal the big page exactly.
    const paged: string[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page += 1) {
      const res = await listPendings(`?status=pending&limit=2${cursor}`).expect(200);
      for (const row of res.body.items as { id: string }[]) paged.push(row.id);
      if (res.body.nextCursor === null) break;
      cursor = `&cursor=${encodeURIComponent(res.body.nextCursor as string)}`;
    }
    expect(paged).toHaveLength(allIds.length);
    expect(new Set(paged).size).toBe(paged.length); // no repeats across pages
    expect([...paged].sort()).toEqual([...allIds].sort());

    const bogus = await listPendings('?status=pending&limit=2&cursor=not-a-real-cursor').expect(400);
    expect(bogus.body.code).toBe('invalid-cursor');
  });

  // ── the decision: re-executes the arms at decision time ─────────────────

  it('approve re-executes the arms at decision time: actor = approver, occurredAt = decision instant, audited and outboxed; a second decision is 409', async () => {
    const pend = (
      (await listPendings('?status=pending&limit=200').expect(200)).body.items as {
        id: string; quantityDelta: number; requestedAt: string;
      }[]
    ).find((row) => row.quantityDelta === 11)!;

    const before = await eventCountFor(sku('PLAIN-1'));
    const decision = await approve(pend.id).expect(200);
    expect(decision.body.status).toBe('approved');
    expect(decision.body.decidedBy).toBe(ownerUserId); // the OWNER decided, not the requester
    expect(typeof decision.body.decidedAt).toBe('string');
    expect(decision.body.events).toHaveLength(1);
    expect(decision.body.events[0].quantityDelta).toBe(11);
    expect(decision.body.onHand.quantity).toBe(32); // 21 + 11

    // The approved event's business time is the DECISION instant — strictly
    // at-or-after the request (the pend waited, the event did not backdate).
    expect(decision.body.events[0].occurredAt).toBe(decision.body.decidedAt);

    expect(await eventCountFor(sku('PLAIN-1'))).toBe(before + 1);
    expect(await onHandFor(binA, sku('PLAIN-1'))).toBe(32);

    // Audit: approved, pointing at the pend row, actor = the approver.
    const audits = await auditRows('stock_adjustment.approved');
    const mine = audits.find((row) => row.target_id === pend.id);
    expect(mine).toBeDefined();
    expect(mine!.target_type).toBe('stock_adjustment_pending');
    expect(mine!.actor_user_id).toBe(ownerUserId);

    // Outbox: the decision event carries the decision context.
    const decisions = await outboxRows('stock_adjustment.approved');
    const notice = decisions.find((row) => row.payload.pendingAdjustmentId === pend.id);
    expect(notice).toBeDefined();
    expect(notice!.payload).toMatchObject({
      warehouseId,
      skuId: sku('PLAIN-1'),
      quantityDelta: 11,
      decidedBy: ownerUserId,
    });

    // The queue shows the decision.
    const approved = await listPendings('?status=approved').expect(200);
    const row = (approved.body.items as { id: string; decidedBy: string }[]).find((r) => r.id === pend.id);
    expect(row).toBeDefined();
    expect(row!.decidedBy).toBe(ownerUserId);
    const stillPending = await listPendings('?status=pending&limit=200').expect(200);
    expect((stillPending.body.items as { id: string }[]).some((r) => r.id === pend.id)).toBe(false);

    // Both decisions are terminal and idempotency-independent: a DIFFERENT
    // key on the decided row is still 409 adjustment-pending-decided.
    const again = await approve(pend.id).expect(409);
    expect(again.body.code).toBe('adjustment-pending-decided');
    const rejectAfter = await reject(pend.id).expect(409);
    expect(rejectAfter.body.code).toBe('adjustment-pending-decided');
  });

  it('reject records the decision without any stock write; its audit and outbox land; the row is terminal', async () => {
    const pend = (
      (await listPendings('?status=pending&limit=200').expect(200)).body.items as {
        id: string; quantityDelta: number;
      }[]
    ).find((row) => row.quantityDelta === -11)!;
    const before = await eventCountFor(sku('PLAIN-1'));
    const onHandBefore = await onHandFor(binA, sku('PLAIN-1'));

    const decision = await reject(pend.id).expect(200);
    expect(decision.body.status).toBe('rejected');
    expect(decision.body.decidedBy).toBe(ownerUserId);
    expect(decision.body.events).toHaveLength(0); // no stock write
    expect(decision.body.onHand).toBeNull();

    expect(await eventCountFor(sku('PLAIN-1'))).toBe(before);
    expect(await onHandFor(binA, sku('PLAIN-1'))).toBe(onHandBefore);

    expect((await auditRows('stock_adjustment.rejected')).some((row) => row.target_id === pend.id)).toBe(true);
    expect(
      (await outboxRows('stock_adjustment.rejected')).some((row) => row.payload.pendingAdjustmentId === pend.id),
    ).toBe(true);

    const again = await approve(pend.id).expect(409);
    expect(again.body.code).toBe('adjustment-pending-decided');
  });

  // ── the stored arms ride into the approved event ─────────────────────────

  it('a batch-tracked pend approves with the stored batch: the approved event carries the pend batchId as batch_ref', async () => {
    // Two at-threshold intakes of the SAME batch code → one identity, 20 on hand.
    const intake = {
      warehouseId, skuId: sku('BT-1'), binId: binA,
      reasonCode: 'stock-count', note: 'batch intake for approval',
      batch: { code: 'B-52-1' },
    };
    await adjust({ ...intake, quantityDelta: 10 }).expect(201);
    await adjust({ ...intake, quantityDelta: 10 }).expect(201);
    const batchId = await withSql(async (sql) => {
      const rows = await sql`
        select id from batches where tenant_id = ${tenantId} and sku_id = ${sku('BT-1')} and code = 'B-52-1'
      `;
      return (rows[0] as { id: string }).id;
    });
    expect(await batchOnHandFor(batchId, binA)).toBe(20);

    // An over-threshold FEFO draw (no batch arm — the resolution happens at
    // request time and the resolved batchId is what the pend stores).
    const res = await adjust({
      warehouseId, skuId: sku('BT-1'), binId: binA,
      quantityDelta: -11, reasonCode: 'damaged', note: 'FEFO draw over threshold',
    }).expect(202);
    expect(res.body.pendingAdjustment.batchId).toBe(batchId);

    const decision = await approve(res.body.pendingAdjustment.id).expect(200);
    expect(decision.body.events).toHaveLength(1);
    expect(decision.body.events[0].quantityDelta).toBe(-11);
    // The approved event's batch_ref is the STORED batch — decision-time
    // identity, not a fresh resolution.
    const eventRow = await withSql(async (sql) => {
      const rows = await sql`
        select batch_ref, reference_doc from ledger_events
        where tenant_id = ${tenantId} and seq = ${decision.body.events[0].seq}
      `;
      return rows[0] as unknown as { batch_ref: string; reference_doc: Record<string, unknown> };
    });
    expect(eventRow.batch_ref).toBe(batchId);
    // A FEFO default draw is not an override — no override reason in the doc.
    expect('overrideReason' in eventRow.reference_doc).toBe(false);
    expect(await batchOnHandFor(batchId, binA)).toBe(9);
  });

  it('an override draw pend restores its override reason into the approved event referenceDoc', async () => {
    // Top back up to 19 (9 + 10 at-threshold), then an explicit draw of 11 —
    // an explicit draw is ALWAYS an FEFO override, reason required.
    await adjust({
      warehouseId, skuId: sku('BT-1'), binId: binA,
      quantityDelta: 10, reasonCode: 'stock-count', note: 'top up',
      batch: { code: 'B-52-1' },
    }).expect(201);

    const res = await adjust({
      warehouseId, skuId: sku('BT-1'), binId: binA,
      quantityDelta: -11, reasonCode: 'damaged', note: 'override draw over threshold',
      batch: { code: 'B-52-1', overrideReason: 'recount variance' },
    }).expect(202);
    expect(res.body.pendingAdjustment.batchOverrideReason).toBe('recount variance');
    expect(res.body.pendingAdjustment.batchId).not.toBeNull();

    const decision = await approve(res.body.pendingAdjustment.id).expect(200);
    const eventRow = await withSql(async (sql) => {
      const rows = await sql`
        select reference_doc from ledger_events
        where tenant_id = ${tenantId} and seq = ${decision.body.events[0].seq}
      `;
      return rows[0] as unknown as { reference_doc: Record<string, unknown> };
    });
    expect(eventRow.reference_doc.overrideReason).toBe('recount variance');
    expect(await batchOnHandFor(res.body.pendingAdjustment.batchId as string, binA)).toBe(8);
  });

  it('a catch-weight pend approves with its named units: every one leaves active', async () => {
    const unitIds = await seedPickableUnits('CW-1', Array.from({ length: 11 }, (_, i) => 18_000 + i * 10));
    expect(unitIds).toHaveLength(11);

    const res = await adjust({
      warehouseId, skuId: sku('CW-1'), binId: binA,
      quantityDelta: -11, reasonCode: 'damaged', note: 'eleven crushed cases',
      handlingUnitIds: unitIds,
    }).expect(202);
    expect(res.body.pendingAdjustment.handlingUnitIds).toEqual(unitIds);
    expect(await onHandFor(binA, sku('CW-1'))).toBe(11); // untouched

    const decision = await approve(res.body.pendingAdjustment.id).expect(200);
    expect(decision.body.events).toHaveLength(1);
    expect(decision.body.events[0].quantityDelta).toBe(-11);
    expect(await onHandFor(binA, sku('CW-1'))).toBe(0);

    const statuses = await withSql(async (sql) => {
      return (await sql`
        select id, status from handling_units where tenant_id = ${tenantId} and id = ANY(${unitIds}::uuid[])
      `) as unknown as { id: string; status: string }[];
    });
    expect(statuses).toHaveLength(11);
    for (const unit of statuses) expect(unit.status).toBe('rejected'); // written off
  });

  // ── the moved world: the decision rolls back and the row STAYS pending ──

  it('a bin retired since the pend: approve is 400 bin-retired and the row stays pending', async () => {
    const res = await adjust({
      warehouseId, skuId: sku('PLAIN-1'), binId: binB,
      quantityDelta: 11, reasonCode: 'stock-count', note: 'pends into binB',
    }).expect(202);
    const pendingId = res.body.pendingAdjustment.id as string;

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binB}/retire`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);

    const refused = await approve(pendingId).expect(400);
    expect(refused.body.code).toBe('bin-retired');
    expect((await pendRow(pendingId))!.status).toBe('pending'); // rolled back
  });

  it('stock drawn below zero since the pend: approve is 422 insufficient-on-hand and the row stays pending', async () => {
    // The pend is a DRAW of the bin's whole position — coverable at request
    // time, and over the threshold so it pends.
    const onHand = await onHandFor(binA, sku('PLAIN-1'));
    expect(onHand).toBeGreaterThan(10);
    const res = await adjust({
      warehouseId, skuId: sku('PLAIN-1'), binId: binA,
      quantityDelta: -onHand, reasonCode: 'damaged', note: 'full draw, awaits the owner',
    }).expect(202);
    const pendingId = res.body.pendingAdjustment.id as string;

    // Under/at-threshold draws are still IMMEDIATE — they shrink the world
    // the pend promised. Drain the bin in chunks the threshold still allows.
    let remaining = onHand;
    while (remaining > 0) {
      const chunk = Math.min(10, remaining);
      await adjust({
        warehouseId, skuId: sku('PLAIN-1'), binId: binA,
        quantityDelta: -chunk, reasonCode: 'damaged', note: 'drain chunk',
      }).expect(201);
      remaining -= chunk;
    }
    expect(await onHandFor(binA, sku('PLAIN-1'))).toBe(0);

    const refused = await approve(pendingId).expect(422);
    expect(refused.body.code).toBe('insufficient-on-hand');
    expect((await pendRow(pendingId))!.status).toBe('pending');
    // The failed decision wrote nothing — not even its own audit row.
    expect((await auditRows('stock_adjustment.approved')).some((row) => row.target_id === pendingId)).toBe(false);
  });

  it('a named handling unit written off since the pend: approve is 409 and the row stays pending', async () => {
    const unitIds = await seedPickableUnits('CW-1', Array.from({ length: 11 }, (_, i) => 18_500 + i * 10));
    const res = await adjust({
      warehouseId, skuId: sku('CW-1'), binId: binA,
      quantityDelta: -11, reasonCode: 'damaged', note: 'HU moved-world fodder',
      handlingUnitIds: unitIds,
    }).expect(202);
    const pendingId = res.body.pendingAdjustment.id as string;

    // ONE under-threshold write-off takes unit[0] out of active — the pend
    // names it too, so its re-execution must refuse.
    await adjust({
      warehouseId, skuId: sku('CW-1'), binId: binA,
      quantityDelta: -1, reasonCode: 'damaged', note: 'one case now',
      handlingUnitIds: [unitIds[0]!],
    }).expect(201);

    const refused = await approve(pendingId).expect(409);
    // The conditional write's moved-count check is the authority — its 409
    // is coded `conflict` and names the offending unit's real status.
    expect(refused.body.code).toBe('conflict');
    expect(refused.body.detail).toContain('not active');
    expect(refused.body.detail).toContain(unitIds[0]!);
    expect((await pendRow(pendingId))!.status).toBe('pending');
  });

  it('a kit created since the pend: approve is 409 kit-cannot-hold-stock and the row stays pending', async () => {
    // PLAIN-2 has NO stock — the pend is a positive delta (a kit can never
    // hold stock, so the pend would be refused if it had any).
    const res = await adjust({
      warehouseId, skuId: sku('PLAIN-2'), binId: binA,
      quantityDelta: 11, reasonCode: 'other', note: 'kit-since-pend fodder',
    }).expect(202);
    const pendingId = res.body.pendingAdjustment.id as string;

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/skus/${sku('PLAIN-2')}/kit`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: sku('COMP-1'), quantity: 1 }] })
      .expect(201);

    const refused = await approve(pendingId).expect(409);
    expect(refused.body.code).toBe('kit-cannot-hold-stock');
    expect((await pendRow(pendingId))!.status).toBe('pending');
  });

  // ── concurrency: one decision wins ───────────────────────────────────────

  it('two concurrent approves race: exactly one 200, the loser 409, one decision recorded', async () => {
    const res = await adjust({
      warehouseId, skuId: sku('PLAIN-1'), binId: binA,
      quantityDelta: 11, reasonCode: 'other', note: 'race fodder',
    }).expect(202);
    const pendingId = res.body.pendingAdjustment.id as string;

    const [first, second] = await Promise.all([
      approve(pendingId, ulid()).then(
        (r) => ({ status: r.status, body: r.body }),
        (err) => { throw err; },
      ),
      approve(pendingId, ulid()).then(
        (r) => ({ status: r.status, body: r.body }),
        (err) => { throw err; },
      ),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect((await pendRow(pendingId))!.status).toBe('approved');
    expect((await auditRows('stock_adjustment.approved')).filter((row) => row.target_id === pendingId)).toHaveLength(1);
  });

  // ── the multi-serial aggregate rides the approve path (retro A4) ────────

  it('a multi-serial pend approves into the aggregate snapshot: null event id/seq, one timeline event per serial', async () => {
    const serials = Array.from({ length: 11 }, () => `SN-${ulid().slice(0, 16).toUpperCase()}`);
    const res = await adjust({
      warehouseId, skuId: sku('ST-1'), binId: binA,
      quantityDelta: 11, reasonCode: 'stock-count', note: 'eleven serials in',
      serials,
    }).expect(202);
    expect(res.body.pendingAdjustment.serialIds).toHaveLength(11);

    const decision = await approve(res.body.pendingAdjustment.id).expect(200);
    expect(decision.body.events).toHaveLength(1);
    expect(decision.body.events[0].quantityDelta).toBe(11);
    // The A4 aggregate: the snapshot does NOT pretend one serial event is
    // THE event — id and seq are null, the timeline carries the truth.
    expect(decision.body.events[0].id).toBeNull();
    expect(decision.body.events[0].seq).toBeNull();
    expect(await onHandFor(binA, sku('ST-1'))).toBe(11);

    const timeline = await withSql(async (sql) => {
      return (await sql`
        select serial_ref, quantity_delta, id, seq from ledger_events
        where tenant_id = ${tenantId} and sku_id = ${sku('ST-1')} and serial_ref is not null
        order by seq
      `) as unknown as { serial_ref: string; quantity_delta: string; id: string; seq: number }[];
    });
    expect(timeline).toHaveLength(11);
    for (const event of timeline) {
      // The per-event delta is one whole unit in milli-units (AD-9).
      expect(fromMilli(Number(event.quantity_delta))).toBe(1);
      expect(event.id).toBeDefined();
      expect(event.seq).toBeGreaterThan(0);
    }
  });

  // ── the closed reason vocabulary is pinned at BOTH layers ────────────────

  it('the pendings CHECK constraint and the TS vocabulary agree; a foreign reasonCode is 400', async () => {
    const checkDef = await withSql(async (sql) => {
      const rows = await sql`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'stock_adjustment_pendings_reason_code_check'
      `;
      return (rows[0] as { def: string }).def;
    });
    // Every TS value is admitted by the DB CHECK — the vocabularies cannot
    // silently drift apart (a new code added to one layer but not the other
    // would 400 in production or insert what the API refuses).
    for (const code of ADJUSTMENT_REASON_CODES) {
      expect(checkDef).toContain(`'${code}'`);
    }
    // The deparse may render the list as `IN (...)` or `= ANY (ARRAY[...])`
    // — the single-quoted literals ARE the vocabulary either way.
    const dbCodes = [...checkDef.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(dbCodes.sort()).toEqual([...ADJUSTMENT_REASON_CODES].sort());

    await adjust({
      warehouseId, skuId: sku('PLAIN-1'), binId: binA,
      quantityDelta: 1, reasonCode: 'damage', note: 'not in the vocabulary',
    }).expect(400);
  });

  // ── RLS: the queue is tenant-scoped end to end ───────────────────────────

  it('RLS: another tenant reads an empty queue and a foreign pend id is 404, never a leak', async () => {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Other Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    const tenant2Id = registered.body.tenant.id as string;
    createdTenantIds.push(tenant2Id);
    const owner2Token = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;

    // The foreign queue is empty — RLS filters tenant 1's rows out of the read.
    const queue = await request(app.getHttpServer())
      .get(`${API}/${tenant2Id}/inventory/adjustment-pendings?status=pending&limit=200`)
      .set('Authorization', `Bearer ${owner2Token}`)
      .expect(200);
    expect(queue.body.items).toHaveLength(0);

    // A foreign pend id addressed INSIDE the foreign tenant's own path is a
    // 404 — the lookup filtered to zero rows, not a leak of the target.
    const foreignPend = (
      (await listPendings('?status=pending&limit=200').expect(200)).body.items as { id: string }[]
    )[0]!;
    const leaked = await approve(foreignPend.id, ulid(), owner2Token, tenant2Id).expect(404);
    expect(leaked.body.code).toBe('not-found');
    expect((await pendRow(foreignPend.id))!.status).toBe('pending');
  });

  // ── the contract: the OpenAPI document carries the story's surface ───────

  it('the committed OpenAPI document lists the approval surface and the dynamic 202', () => {
    const doc = JSON.parse(
      readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8'),
    ) as { paths: Record<string, unknown> };
    // The document's paths are server-relative (the global /api/v1 prefix
    // lives in the servers block, not on each path key).
    const base = '/tenants/{tenantId}';
    expect(doc.paths[`${base}/inventory/adjustment-policies`]).toBeDefined();
    expect(doc.paths[`${base}/inventory/adjustment-pendings`]).toBeDefined();
    expect(doc.paths[`${base}/inventory/adjustment-pendings/{pendingId}/approve`]).toBeDefined();
    expect(doc.paths[`${base}/inventory/adjustment-pendings/{pendingId}/reject`]).toBeDefined();

    const adjustOps = doc.paths[`${base}/inventory/adjustments`] as {
      post: { responses: Record<string, unknown> };
    };
    expect(adjustOps.post.responses['202']).toBeDefined();
  });
});