import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { BATCH_BLOCK_REASONS } from '../src/shared/db/schema';
import { batchExpiryClock, isBatchExpiredAt } from '../src/shared/primitives/batch-expiry';
import { buildStockPool } from '../src/modules/outbound/replan';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow } from './support/audit-guard';
import { dispatchedOrderFixtures } from './support/dispatched-order';
import { ReservationService } from '../src/modules/inventory/reservation.service';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import type { Database } from '../src/shared/db/db';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const SCALE = 1000;

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** The session's user id (the token's `sub`). */
function userIdOf(token: string): string {
  return (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string }).sub;
}

interface BatchView {
  id: string;
  code: string;
  status: string;
  expiryDate: string | null;
  blockedReason: string | null;
  blockedNote?: string | null;
  blockedAt: string | null;
  blockedBy: string | null;
  blockedByName: string | null;
  expired: boolean;
  quantity?: number;
}

/**
 * Story 3-3a — batch block / unblock and unpromisable stock: the verb (guard
 * order, replay, the same-key race, audit), the ATP term (blocked and expired
 * batches stop being promised — order create, the channel-visible figure, the
 * buffer ceiling), its bin rules (RECEIVING counted; QC-HOLD, DAMAGED and a
 * quarantined scope never subtracted twice), the expiry boundary against the
 * draw side, the FEFO default draw, the explicit write-off, and an approval
 * re-running the draw check.
 */
describe('story 3-3a: batch block and unpromisable stock (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let inventory: InventoryFacade;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let opsEmail: string;
  let webOperatorToken: string;
  let wh: string;
  let zoneId: string;
  let binA: string;
  let binB: string;
  let deviceOperatorToken: string;
  let wh2: string;
  let binC: string;
  const fixtures = dispatchedOrderFixtures(() => ({
    app,
    tenantId,
    warehouseId: wh,
    opsToken,
    ownerToken,
    operatorToken: deviceOperatorToken,
  }));
  const skuIds = new Map<string, string>();
  const http = () => request(app.getHttpServer());
  const sku = (code: string): string => {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('batch_block');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    inventory = app.get(InventoryFacade);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Block Co ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
    const ops = await createMember('ops_manager');
    opsToken = ops.token;
    opsEmail = ops.email;
    opsUserId = userIdOf(opsToken);
    webOperatorToken = (await createMember('operator')).token;

    wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `BB-${ulid().slice(20)}`, name: 'Block warehouse' })
        .expect(201)
    ).body.id as string;
    zoneId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binA = await createBin('A-01-01');
    binB = await createBin('A-01-02');

    const codes = [
      'BB-MAIN', 'BB-EXP', 'BB-QC', 'BB-QUAR', 'BB-RCV', 'BB-BUF', 'BB-FEFO', 'BB-RACE', 'BB-PEND', 'BB-TWO',
      'BB-RET', 'BB-TRN', 'BB-LOT', 'BB-CLAMP', 'BB-XPL', 'BB-LEG', 'BB-XPD', 'BB-GONE', 'BB-REG',
    ];
    const csv = [
      'sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked',
      ...codes.map((code) => `${code},${code} name,pcs,1800,${code}-BC,true,false`),
    ].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const rows = (await sql`select id, code from skus where tenant_id = ${tenantId}`) as unknown as { id: string; code: string }[];
    for (const row of rows) skuIds.set(row.code, row.id);

    // The floor device and its operator (the blind receipt into RECEIVING).
    const floor = await createMember('operator');
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'BB dock', pin: '2468' })
      .expect(201);
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail: floor.email, pin: '2468' })
      .expect(200);
    deviceOperatorToken = badged.body.accessToken as string;

    // A second warehouse (the lot-wide block, the transfer into IN-TRANSIT).
    wh2 = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `BB2-${ulid().slice(20)}`, name: 'Block warehouse two' })
        .expect(201)
    ).body.id as string;
    const zone2 = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh2}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'C', name: 'Aisle C' })
        .expect(201)
    ).body.id as string;
    binC = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh2}/zones/${zone2}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'C-01-01', capacity: 100_000, type: 'shelf' })
        .expect(201)
    ).body.id as string;
    await inventory.rebuildReservationCounters(tenantId, wh2);

    // Arm the warehouse's reservation counters (a grant fails closed on a cold warehouse).
    await inventory.rebuildReservationCounters(tenantId, wh);
  });

  afterAll(async () => {
    batchExpiryClock.now = () => Date.now();
    await sql?.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function createMember(role: 'ops_manager' | 'operator'): Promise<{ email: string; token: string }> {
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
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    return { email, token: (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string };
  }

  async function createBin(code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, capacity: 100_000, type: 'shelf' })
        .expect(201)
    ).body.id as string;
  }

  function adjust(body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: wh, reasonCode: 'stock-count', note: 'batch-block suite', ...body });
  }

  async function seed(skuCode: string, binId: string, qty: number, batch: { code: string; expiryDate?: string }): Promise<void> {
    await adjust({ skuId: sku(skuCode), binId, quantityDelta: qty, batch }).expect(201);
  }

  async function batchId(skuCode: string, code: string): Promise<string> {
    const rows = (await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku(skuCode)} and code = ${code}`) as unknown as { id: string }[];
    return rows[0]!.id;
  }

  function block(id: string, body: Record<string, unknown>, token = opsToken, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/batches/${id}/block`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function unblock(id: string, body: Record<string, unknown>, token = opsToken, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/batches/${id}/unblock`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function atp(
    skuCode: string,
    warehouseId = wh,
  ): Promise<{ onHand: number; atp: number; unpromisableBatch: number; damaged: number; qcHeld: number; reserved: number; returnsAwaiting: number; inTransit: number }> {
    const snapshot = await inventory.atp(tenantId, warehouseId, sku(skuCode));
    return {
      returnsAwaiting: snapshot.returnsAwaiting / SCALE,
      inTransit: snapshot.inTransit / SCALE,
      onHand: snapshot.onHand / SCALE,
      atp: snapshot.atp / SCALE,
      unpromisableBatch: snapshot.unpromisableBatch / SCALE,
      damaged: snapshot.damaged / SCALE,
      qcHeld: snapshot.qcHeld / SCALE,
      reserved: snapshot.reserved / SCALE,
    };
  }

  async function createOrder(skuCode: string, quantity: number): Promise<Record<string, unknown>> {
    const res = await http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, lines: [{ skuId: sku(skuCode), quantity }], destination: testAddress() })
      .expect(201);
    return (res.body.order as { lines: Record<string, unknown>[] }).lines[0]!;
  }

  async function listBatches(skuCode: string): Promise<BatchView[]> {
    const res = await http()
      .get(`${API}/${tenantId}/warehouses/${wh}/inventory/batches?skuId=${sku(skuCode)}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    return res.body.items as BatchView[];
  }

  async function count(query: PromiseLike<unknown>): Promise<number> {
    return Number(((await query) as { n: number | string }[])[0]!.n);
  }

  // ── the vocabulary ─────────────────────────────────────────────────────────

  it('BATCH_BLOCK_REASONS is exactly the batches_blocked_pairing CHECK vocabulary (TS ↔ DB pin, guide §4)', async () => {
    const rows = (await sql`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'batches_blocked_pairing'`) as unknown as { def: string }[];
    expect(rows).toHaveLength(1);
    // The vocabulary is the `= ANY (ARRAY[…])` list (the CHECK also names
    // `blocked` and, for the note rule, `other` again outside it).
    const array = /ARRAY\[([^\]]+)\]/.exec(rows[0]!.def)![1]!;
    const listed = [...array.matchAll(/'([a-z-]+)'::text/g)].map((match) => match[1]!);
    expect(listed.sort()).toEqual([...BATCH_BLOCK_REASONS].sort());
  });

  // ── the verb ───────────────────────────────────────────────────────────────

  it('block: 201, the batch is blocked with reason, who and when; ATP −10; an order backorders with no grant; the channel-visible figure is 0; audited once, replayed', async () => {
    await seed('BB-MAIN', binA, 10, { code: 'M-1', expiryDate: daysFromNow(200) });
    const id = await batchId('BB-MAIN', 'M-1');
    expect(await atp('BB-MAIN')).toMatchObject({ onHand: 10, atp: 10, unpromisableBatch: 0 });

    const key = ulid();
    const res = await block(id, { reason: 'recall', note: '  Supplier recall R-17  ' }, opsToken, key).expect(201);
    const batch = res.body.batch as BatchView;
    expect(batch).toMatchObject({
      id,
      code: 'M-1',
      status: 'blocked',
      blockedReason: 'recall',
      blockedBy: opsUserId,
      blockedByName: opsEmail.split('@')[0],
      expired: false,
    });
    expect(Date.parse(batch.blockedAt!)).toBeGreaterThan(Date.now() - 60_000);

    // The units stay on hand; none is promisable.
    expect(await atp('BB-MAIN')).toMatchObject({ onHand: 10, atp: 0, unpromisableBatch: 10 });
    const line = await createOrder('BB-MAIN', 1);
    expect(line).toMatchObject({ reservedQty: 0, shortfallQty: 1, status: 'backordered', reservationId: null });
    const visible = await inventory.channelVisibleQuantity(tenantId, wh, sku('BB-MAIN'), uuidv7());
    expect(visible.visibleMilli).toBe(0);
    expect(visible.unpromisableBatch).toBe(10 * SCALE);

    // Outbox + audit, once; the replay re-serves the body and writes nothing.
    const replay = await block(id, { reason: 'recall', note: 'Supplier recall R-17' }, opsToken, key).expect(201);
    expect(replay.body).toEqual(res.body);
    await expectAuditRow({ tenantId, key, action: 'batch.blocked', targetType: 'batch', targetId: id, actorUserId: opsUserId });
    const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as { changes: unknown }[];
    expect(audit[0]!.changes).toEqual({
      status: { before: 'active', after: 'blocked' },
      reason: { before: null, after: 'recall' },
      note: { before: null, after: 'Supplier recall R-17' },
    });
    expect(
      await count(sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'batch.blocked' and payload->>'batchId' = ${id}`),
    ).toBe(1);
    const outbox = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'batch.blocked' and payload->>'batchId' = ${id}`) as unknown as { payload: Record<string, unknown> }[];
    expect(outbox[0]!.payload).toEqual({ batchId: id, skuId: sku('BB-MAIN'), code: 'M-1', reason: 'recall', note: 'Supplier recall R-17' });

    // The same key with a different body is 422.
    const reused = await block(id, { reason: 'qc-failed' }, opsToken, key).expect(422);
    expect(reused.body.code).toBe('idempotency-key-reuse');

    // The reads carry the lifecycle facts.
    const listed = (await listBatches('BB-MAIN')).find((row) => row.id === id)!;
    expect(listed).toMatchObject({ status: 'blocked', blockedReason: 'recall', blockedBy: opsUserId, blockedByName: opsEmail.split('@')[0], expired: false, quantity: 10 });
    const detail = await http().get(`${API}/${tenantId}/inventory/batches/${id}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(detail.body).toMatchObject({ status: 'blocked', blockedReason: 'recall', blockedByName: opsEmail.split('@')[0], expired: false });
  });

  it('already blocked → 409 batch-already-blocked; unblock needs a note, then 201 and ATP +10; unblocking an active batch → 409 batch-not-blocked', async () => {
    const id = await batchId('BB-MAIN', 'M-1');
    const again = await block(id, { reason: 'qc-failed' }).expect(409);
    expect(again.body.code).toBe('batch-already-blocked');

    for (const body of [{}, { note: '' }, { note: '   ' }]) {
      const refused = await unblock(id, body).expect(400);
      expect(refused.body.code).toBe('validation-failed');
    }
    const before = await atp('BB-MAIN');
    const key = ulid();
    const res = await unblock(id, { note: 'Recall withdrawn by supplier' }, opsToken, key).expect(201);
    expect(res.body.batch).toMatchObject({ id, status: 'active', blockedReason: null, blockedAt: null, blockedBy: null, blockedByName: null, expired: false });
    const after = await atp('BB-MAIN');
    expect(after.unpromisableBatch).toBe(0);
    expect(after.atp - before.atp).toBe(10 - after.reserved + before.reserved);
    await unblock(id, { note: 'Recall withdrawn by supplier' }, opsToken, key).expect(201);
    await expectAuditRow({ tenantId, key, action: 'batch.unblocked', targetType: 'batch', targetId: id, actorUserId: opsUserId });
    const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as { changes: Record<string, { before: unknown; after: unknown }> }[];
    expect(audit[0]!.changes.status).toEqual({ before: 'blocked', after: 'active' });
    expect(audit[0]!.changes.reason).toEqual({ before: 'recall', after: null });
    expect(audit[0]!.changes.blockedBy).toEqual({ before: opsUserId, after: null });
    // The block's own note survives the unblock in `before` (the row is cleared).
    expect(audit[0]!.changes.note).toEqual({ before: 'Supplier recall R-17', after: 'Recall withdrawn by supplier' });

    const notBlocked = await unblock(id, { note: 'again' }).expect(409);
    expect(notBlocked.body.code).toBe('batch-not-blocked');
    // Every lifecycle column cleared together (the pairing CHECK holds).
    const row = (await sql`select status, blocked_reason, blocked_at, blocked_by from batches where id = ${id}`) as unknown as Record<string, unknown>[];
    expect(row[0]).toEqual({ status: 'active', blocked_reason: null, blocked_at: null, blocked_by: null });
    expect((await sql`select blocked_note from batches where id = ${id}`)[0]).toEqual({ blocked_note: null });
  });

  it('the shape refusals: `other` without a note, an unknown reason, a note over 500 characters — all 400 and nothing written', async () => {
    const id = await batchId('BB-MAIN', 'M-1');
    for (const body of [{ reason: 'other' }, { reason: 'other', note: '   ' }, { reason: 'mouldy' }, { reason: 'recall', note: 'x'.repeat(501) }, {}]) {
      const res = await block(id, body).expect(400);
      expect(res.body.code).toBe('validation-failed');
    }
    // `other` WITH a note is accepted (and undone, so later tests start clean).
    await block(id, { reason: 'other', note: 'Label misprint' }).expect(201);
    await unblock(id, { note: 'Relabelled' }).expect(201);
    expect((await sql`select status from batches where id = ${id}`)[0]).toEqual({ status: 'active' });
  });

  it('authority before anything: a web operator (no qc.manage) is 403 role-denied even for an unknown batch; an unknown or malformed batch is 404', async () => {
    const id = await batchId('BB-MAIN', 'M-1');
    const denied = await block(id, { reason: 'recall' }, webOperatorToken).expect(403);
    expect(denied.body.code).toBe('role-denied');
    const deniedUnknown = await block(uuidv7(), { reason: 'recall' }, webOperatorToken).expect(403);
    expect(deniedUnknown.body.code).toBe('role-denied');
    const deniedUnblock = await unblock(id, { note: 'x' }, webOperatorToken).expect(403);
    expect(deniedUnblock.body.code).toBe('role-denied');
    expect((await block(uuidv7(), { reason: 'recall' }).expect(404)).body.code).toBe('not-found');
    expect((await block('not-a-uuid', { reason: 'recall' }).expect(404)).body.code).toBe('not-found');
    expect((await unblock(uuidv7(), { note: 'x' }).expect(404)).body.code).toBe('not-found');
    // The owner holds qc.manage too.
    await block(id, { reason: 'contamination' }, ownerToken).expect(201);
    await unblock(id, { note: 'Cleared by lab' }, ownerToken).expect(201);
  });

  it('a block is lot-wide and outlives a move: a blocked batch received or moved into another bin stays unpromisable there', async () => {
    await seed('BB-TWO', binA, 4, { code: 'T-1' });
    const id = await batchId('BB-TWO', 'T-1');
    await block(id, { reason: 'client-instruction' }).expect(201);
    // A positive adjustment INTO the blocked lot is allowed (A11) — the units
    // land unpromisable, wherever.
    await seed('BB-TWO', binB, 3, { code: 'T-1' });
    expect(await atp('BB-TWO')).toMatchObject({ onHand: 7, unpromisableBatch: 7, atp: 0 });
    await unblock(id, { note: 'Client released the hold' }).expect(201);
    expect(await atp('BB-TWO')).toMatchObject({ onHand: 7, unpromisableBatch: 0 });
  });

  // ── the bins the term counts ───────────────────────────────────────────────

  it('QC-HOLD is never subtracted twice: a held scope of a blocked batch counts in qcHeld only', async () => {
    await seed('BB-QC', binA, 6, { code: 'Q-1' });
    await seed('BB-QC', binB, 4, { code: 'Q-1' });
    await http()
      .post(`${API}/${tenantId}/receiving/qc-holds`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, skuId: sku('BB-QC'), binId: binA, reason: 'suspect seal' })
      .expect(201);
    await block(await batchId('BB-QC', 'Q-1'), { reason: 'qc-failed' }).expect(201);
    // 6 in QC-HOLD (qcHeld), 4 in A-01-02 (the term) — never 6 twice.
    expect(await atp('BB-QC')).toMatchObject({ onHand: 10, qcHeld: 6, unpromisableBatch: 4, atp: 0 });
  });

  it('a quarantined scope is dropped from on-hand and never subtracted again by the term', async () => {
    await seed('BB-QUAR', binA, 5, { code: 'U-1' });
    await seed('BB-QUAR', binB, 2, { code: 'U-1' });
    await block(await batchId('BB-QUAR', 'U-1'), { reason: 'recall' }).expect(201);
    expect(await atp('BB-QUAR')).toMatchObject({ onHand: 7, unpromisableBatch: 7, atp: 0 });
    await sql`
      insert into inventory_quarantines (id, tenant_id, warehouse_id, sku_id, bin_id, from_seq, to_seq, reason, status)
      values (${uuidv7()}, ${tenantId}, ${wh}, ${sku('BB-QUAR')}, ${binA}, 1, 1, 'batch-block-suite', 'open')`;
    // A-01-01's 5 leave on-hand (quarantine) and the term (no double count).
    expect(await atp('BB-QUAR')).toMatchObject({ onHand: 2, unpromisableBatch: 2, atp: 0 });
  });

  it('RECEIVING is counted, DAMAGED is not: a blocked lot received (good + damaged) is wholly unpromisable, with no double subtraction', async () => {
    const res = await http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: wh,
        poId: null,
        blindReasonCode: 'unannounced-delivery',
        occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        lines: [
          {
            poLineId: null,
            skuId: sku('BB-RCV'),
            batchCode: 'R-1',
            mfgDate: null,
            expiryDate: daysFromNow(300).slice(0, 10),
            qty: 4,
            damagedQty: 2,
            damageReasonCode: 'crushed',
          },
        ],
      })
    ;
    expect([res.status, res.body.detail]).toEqual([201, undefined]);
    // The good units sit in RECEIVING, the damaged in DAMAGED (2-4a).
    // Before the block: the 4 good units in RECEIVING are promisable, the 2
    // damaged are not (the damaged hook).
    expect(await atp('BB-RCV')).toMatchObject({ onHand: 6, damaged: 2, unpromisableBatch: 0, atp: 4 });
    await block(await batchId('BB-RCV', 'R-1'), { reason: 'recall' }).expect(201);
    // RECEIVING's 4 are now unpromisable; DAMAGED's 2 stay in `damaged` only.
    expect(await atp('BB-RCV')).toMatchObject({ onHand: 6, damaged: 2, unpromisableBatch: 4, atp: 0 });
  });

  // ── expiry — promise and draw agree ────────────────────────────────────────

  it('expiry flips ATP at the stored instant with no event — E−1 ms and E promisable (drawable while expiry ≥ at), E+1 ms not — and the FEFO default draw and the wave pool agree at each instant', async () => {
    await seed('BB-EXP', binA, 5, { code: 'E-1', expiryDate: daysFromNow(30) });
    const view = (await listBatches('BB-EXP')).find((row) => row.code === 'E-1')!;
    const expiry = Date.parse(view.expiryDate!);
    const id = view.id;
    const poolAt = (at: number): number =>
      (
        buildStockPool({
          skuIds: [sku('BB-EXP')],
          binOrder: [{ id: binA, code: 'A-01-01', storageClass: 'ambient' }],
          skuClassById: new Map([[sku('BB-EXP'), 'ambient']]),
          stock: [{ skuId: sku('BB-EXP'), binId: binA, quantity: 5 * SCALE }],
          batchStock: [{ skuId: sku('BB-EXP'), binId: binA, batchId: id, quantity: 5 * SCALE }],
          batchIdentities: [{ id, code: 'E-1', expiryDate: view.expiryDate, status: 'active', mfgDate: null, createdAt: new Date().toISOString() }],
          at,
          // Story 4-3a — the pool ranks and filters by the SKU's policy (fefo, no minimum: the 3-3a draw).
          policyOf: () => ({ allocationRule: 'fefo', minDays: null }),
        } as unknown as Parameters<typeof buildStockPool>[0]).get(sku('BB-EXP')) ?? []
      ).reduce((sum, slot) => sum + slot.remaining, 0) / SCALE;
    try {
      for (const at of [expiry - 1, expiry]) {
        batchExpiryClock.now = () => at;
        expect(await atp('BB-EXP')).toMatchObject({ onHand: 5, unpromisableBatch: 0, atp: 5 });
        expect(isBatchExpiredAt(view.expiryDate, at)).toBe(false);
        expect(poolAt(at)).toBe(5);
        expect((await listBatches('BB-EXP')).find((row) => row.id === id)!.expired).toBe(false);
      }

      for (const at of [expiry + 1, expiry + 86_400_000]) {
        batchExpiryClock.now = () => at;
        expect(await atp('BB-EXP')).toMatchObject({ onHand: 5, unpromisableBatch: 5, atp: 0 });
        expect(isBatchExpiredAt(view.expiryDate, at)).toBe(true);
        expect(poolAt(at)).toBe(0);
        expect((await listBatches('BB-EXP')).find((row) => row.id === id)!.expired).toBe(true);
        // The FEFO default draw (same clock) refuses the expired lot.
        const refused = await adjust({ skuId: sku('BB-EXP'), binId: binA, quantityDelta: -1 }).expect(422);
        expect(refused.body.code).toBe('insufficient-on-hand');
        expect(refused.body.detail).toContain('no non-expired, unblocked batch stock');
      }
      // No event: the status column never moved.
      expect((await sql`select status from batches where id = ${id}`)[0]).toEqual({ status: 'active' });

      // An unblocked batch past expiry stays unpromisable, and says so (A8).
      await block(id, { reason: 'expiry-review' }).expect(201);
      const lifted = await unblock(id, { note: 'Review done — expired, write-off pending' }).expect(201);
      expect(lifted.body.batch).toMatchObject({ status: 'active', expired: true });
      expect(await atp('BB-EXP')).toMatchObject({ unpromisableBatch: 5, atp: 0 });

      batchExpiryClock.now = () => expiry;
      // At E the FEFO default still draws it.
      await adjust({ skuId: sku('BB-EXP'), binId: binA, quantityDelta: -1 }).expect(201);
    } finally {
      batchExpiryClock.now = () => Date.now();
    }
  });

  // ── the draw rules ─────────────────────────────────────────────────────────

  it('the FEFO default draw skips a blocked batch; an explicit write-off of the blocked batch (with its override reason) is allowed', async () => {
    await seed('BB-FEFO', binA, 3, { code: 'F-SOON', expiryDate: daysFromNow(10) });
    await seed('BB-FEFO', binA, 3, { code: 'F-LATE', expiryDate: daysFromNow(90) });
    const soon = await batchId('BB-FEFO', 'F-SOON');
    const late = await batchId('BB-FEFO', 'F-LATE');
    await block(soon, { reason: 'recall' }).expect(201);
    // The default would have drawn F-SOON (earliest expiry); it is blocked, so F-LATE.
    const batchRefOf = async (eventId: string): Promise<string | null> =>
      ((await sql`select batch_ref from ledger_events where id = ${eventId}`) as unknown as { batch_ref: string | null }[])[0]!.batch_ref;
    const drawn = await adjust({ skuId: sku('BB-FEFO'), binId: binA, quantityDelta: -1 }).expect(201);
    expect(await batchRefOf(drawn.body.event.id as string)).toBe(late);
    // The explicit write-off of the blocked lot.
    const writeOff = await adjust({
      skuId: sku('BB-FEFO'),
      binId: binA,
      quantityDelta: -3,
      reasonCode: 'damaged',
      batch: { code: 'F-SOON', overrideReason: 'recall write-off' },
    }).expect(201);
    expect(await batchRefOf(writeOff.body.event.id as string)).toBe(soon);
    expect(await atp('BB-FEFO')).toMatchObject({ onHand: 2, unpromisableBatch: 0 });
    // Only a blocked batch left in the bin → the default has nothing to draw.
    await block(late, { reason: 'qc-failed' }).expect(201);
    const none = await adjust({ skuId: sku('BB-FEFO'), binId: binA, quantityDelta: -1 }).expect(422);
    expect(none.body.code).toBe('insufficient-on-hand');
    expect(none.body.detail).toContain('no non-expired, unblocked batch stock');
  });

  it('existing promises stand: a block after an order reserved clamps ATP at 0, the reservation is untouched', async () => {
    await seed('BB-MAIN', binB, 4, { code: 'M-2', expiryDate: daysFromNow(150) });
    const line = await createOrder('BB-MAIN', 12);
    expect(line).toMatchObject({ reservedQty: 12, status: 'open' });
    await block(await batchId('BB-MAIN', 'M-1'), { reason: 'recall' }).expect(201);
    const after = await atp('BB-MAIN');
    // 14 on hand, 10 blocked, 12 reserved → max(0, 14 − 12 − 10) = 0.
    expect(after).toMatchObject({ onHand: 14, unpromisableBatch: 10, reserved: 12, atp: 0 });
    const held = (await sql`select state, quantity::bigint as q from reservations where id = ${line.reservationId as string}`) as unknown as { state: string; q: string }[];
    expect(held[0]).toEqual({ state: 'held', q: String(12 * SCALE) });
  });

  // ── the standing buffer (A4) ───────────────────────────────────────────────

  it('a buffer DECREASE is applied even with the ceiling under the reserved total; an increase is refused naming the blocked units', async () => {
    await seed('BB-BUF', binA, 10, { code: 'B-1' });
    const ownerId = uuidv7();
    await inventory.atp(tenantId, wh, sku('BB-BUF'));
    const set = await inventory.applyChannelBuffer({ tenantId, warehouseId: wh, skuId: sku('BB-BUF'), ownerId, targetMilli: 5 * SCALE });
    expect(set).toMatchObject({ status: 'applied', previousMilli: 0, targetMilli: 5 * SCALE });
    await block(await batchId('BB-BUF', 'B-1'), { reason: 'recall' }).expect(201);
    // Ceiling 0, reserved 5.
    const decreased = await inventory.applyChannelBuffer({ tenantId, warehouseId: wh, skuId: sku('BB-BUF'), ownerId, targetMilli: 2 * SCALE });
    expect(decreased).toMatchObject({ status: 'applied', previousMilli: 5 * SCALE, targetMilli: 2 * SCALE });
    expect(decreased.reservation).toMatchObject({ quantity: 2 * SCALE, state: 'held', expiresAt: null });
    expect((await atp('BB-BUF')).reserved).toBe(2);
    const refusal = await inventory
      .applyChannelBuffer({ tenantId, warehouseId: wh, skuId: sku('BB-BUF'), ownerId, targetMilli: 3 * SCALE })
      .then(
        () => null,
        (err: unknown) => err as { getStatus(): number; getResponse(): { code: string; detail: string } },
      );
    expect(refusal?.getStatus()).toBe(409);
    expect(refusal?.getResponse()).toMatchObject({ code: 'unavailable' });
    // Story 4-3a (A15) re-words the clause to name the client minimum too.
    expect(refusal?.getResponse().detail).toContain("(of which 10 in blocked or expired batches, or below the client's minimum remaining shelf life)");
    // Clearing still works.
    expect(await inventory.applyChannelBuffer({ tenantId, warehouseId: wh, skuId: sku('BB-BUF'), ownerId, targetMilli: 0 })).toMatchObject({ status: 'applied', targetMilli: 0 });
  });

  // ── the same-key race (guide §1, A11) ──────────────────────────────────────

  it('two same-key blocks parked on the batch lock both answer the same body — one block, one audit row, one key', async () => {
    await seed('BB-RACE', binA, 2, { code: 'X-1' });
    const id = await batchId('BB-RACE', 'X-1');
    const key = ulid();
    const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    const holder = handle();
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`select pg_backend_pid() as pid from batches where id = ${id} for update`) as unknown as { pid: number }[];
        first = (async () => block(id, { reason: 'recall', note: 'race' }, opsToken, key))();
        second = (async () => block(id, { reason: 'recall', note: 'race' }, opsToken, key))();
        const probe = handle();
        try {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const waiting = (await probe`
              select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
              where a.wait_event_type = 'Lock' and a.state = 'active'
                and a.query ilike '%"batches"%' and a.query ilike '%for update%'`) as unknown as { pid: number; blockers: number[] }[];
            const chain = new Set<number>([locked[0]!.pid]);
            for (let grew = true; grew; ) {
              grew = false;
              for (const row of waiting) {
                if (!chain.has(row.pid) && row.blockers.some((pid) => chain.has(pid))) {
                  chain.add(row.pid);
                  grew = true;
                }
              }
            }
            if (chain.size - 1 >= 2) break;
            if (Date.now() > deadline) throw new Error('fewer than 2 requests parked on the batch row');
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        } finally {
          await probe.end();
        }
      });
      const [a, b] = await Promise.all([first!, second!]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(b.body).toEqual(a.body);
    } finally {
      await Promise.allSettled([first, second]);
      await holder.end();
    }
    expect(await count(sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${key}`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'batch.blocked' and payload->>'batchId' = ${id}`)).toBe(1);
  });

  // ── an approval re-runs the draw check (A11) ───────────────────────────────

  it('a pend resolved to the FEFO default is refused at approval once that batch is blocked (409 batch-blocked, the pend stays pending)', async () => {
    await seed('BB-PEND', binA, 5, { code: 'P-1', expiryDate: daysFromNow(60) });
    await http()
      .put(`${API}/${tenantId}/inventory/adjustment-policies`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ quantityThreshold: 1 })
      .expect(200);
    try {
      const pended = await adjust({ skuId: sku('BB-PEND'), binId: binA, quantityDelta: -3 }).expect(202);
      const pendId = pended.body.pendingAdjustment.id as string;
      await block(await batchId('BB-PEND', 'P-1'), { reason: 'recall' }).expect(201);
      const refused = await http()
        .post(`${API}/${tenantId}/inventory/adjustment-pendings/${pendId}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(409);
      expect(refused.body.code).toBe('batch-blocked');
      expect((await sql`select status from stock_adjustment_pendings where id = ${pendId}`)[0]).toEqual({ status: 'pending' });
      expect(await atp('BB-PEND')).toMatchObject({ onHand: 5 });
    } finally {
      await http()
        .put(`${API}/${tenantId}/inventory/adjustment-policies`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ quantityThreshold: 1_000_000 })
        .expect(200);
    }
  });

  // ── code review: the system bins, lot-wide, the clamp ─────────────────────

  it('a blocked batch in RETURNS (a return receipt) and in IN-TRANSIT (a transfer dispatch) is carried by returnsAwaiting / inTransit only — the term counts 0 there', async () => {
    // RETURNS: dispatch 2 of lot R-L1, receive them back into RETURNS, block the lot.
    await fixtures.seedBatchStock(sku('BB-RET'), binA, 3, 'R-L1');
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('BB-RET'), quantity: 2 }]);
    await fixtures.pickAllLines(picklist);
    await fixtures.packAndDispatch(orderId, [{ skuId: sku('BB-RET'), qty: 2 }]);
    const returnable = await http().get(`${API}/${tenantId}/returns/returnable?orderId=${orderId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const orderLineId = (returnable.body.lines as { skuId: string; orderLineId: string }[]).find((l) => l.skuId === sku('BB-RET'))!.orderLineId;
    const rma = await http()
      .post(`${API}/${tenantId}/returns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ orderId, lines: [{ orderLineId, qty: 2, reasonCode: 'damaged' }] })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/returns/receipts`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: wh,
        rmaId: rma.body.id as string,
        occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        entries: [
          { rmaLineId: rma.body.lines[0].id as string, skuId: sku('BB-RET'), qty: 1, condition: 'resaleable', batchCode: 'R-L1' },
          { rmaLineId: rma.body.lines[0].id as string, skuId: sku('BB-RET'), qty: 1, condition: 'resaleable', batchCode: 'R-L1' },
        ],
      })
      .expect(201);
    await block(await batchId('BB-RET', 'R-L1'), { reason: 'recall' }).expect(201);
    // 1 in A-01-01 (the term), 2 in RETURNS (returnsAwaiting) — never 2 twice.
    expect(await atp('BB-RET')).toMatchObject({ onHand: 3, returnsAwaiting: 2, unpromisableBatch: 1, atp: 0 });

    // IN-TRANSIT: 3 of lot N-L1 confirmed out towards the second warehouse.
    await seed('BB-TRN', binA, 5, { code: 'N-L1' });
    const lot = await batchId('BB-TRN', 'N-L1');
    const transfer = await http()
      .post(`${API}/${tenantId}/movements/transfers`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ sourceWarehouseId: wh, destWarehouseId: wh2, lines: [{ skuId: sku('BB-TRN'), quantity: 3, fromBinId: binA, toBinId: binC, batchId: lot }] })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/movements/transfers/${transfer.body.transfer.id as string}/outbound-confirm`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    await block(lot, { reason: 'recall' }).expect(201);
    expect(await atp('BB-TRN')).toMatchObject({ onHand: 5, inTransit: 3, unpromisableBatch: 2, atp: 0 });
  });

  it('a block is lot-wide: the same lot in a second warehouse stops being promised there too', async () => {
    await seed('BB-LOT', binA, 2, { code: 'W-L1' });
    await adjust({ warehouseId: wh2, skuId: sku('BB-LOT'), binId: binC, quantityDelta: 4, batch: { code: 'W-L1' } }).expect(201);
    expect(await atp('BB-LOT', wh2)).toMatchObject({ onHand: 4, atp: 4, unpromisableBatch: 0 });
    await block(await batchId('BB-LOT', 'W-L1'), { reason: 'qc-failed' }).expect(201);
    expect(await atp('BB-LOT', wh2)).toMatchObject({ onHand: 4, atp: 0, unpromisableBatch: 4 });
    expect(await atp('BB-LOT')).toMatchObject({ onHand: 2, atp: 0, unpromisableBatch: 2 });
  });

  it('the per-bin clamp: a batch projection that runs ahead of the bin on-hand is counted only up to the bin on-hand', async () => {
    await seed('BB-CLAMP', binA, 5, { code: 'K-L1' });
    const lot = await batchId('BB-CLAMP', 'K-L1');
    await block(lot, { reason: 'recall' }).expect(201);
    expect(await atp('BB-CLAMP')).toMatchObject({ onHand: 5, unpromisableBatch: 5 });
    // A divergent batch arm (what reconciliation would flag): 9 units claimed
    // by the batch in a bin that holds 5.
    await sql`update batch_on_hand set quantity = 9000 where tenant_id = ${tenantId} and batch_id = ${lot} and bin_id = ${binA}`;
    expect(await atp('BB-CLAMP')).toMatchObject({ onHand: 5, unpromisableBatch: 5, atp: 0 });
  });

  it('blockedByName is null once the blocker is no longer a member of the tenant', async () => {
    const leaver = await createMember('ops_manager');
    await seed('BB-GONE', binA, 1, { code: 'G-L1' });
    const lot = await batchId('BB-GONE', 'G-L1');
    const res = await block(lot, { reason: 'recall' }, leaver.token).expect(201);
    expect(res.body.batch.blockedByName).toBe(leaver.email.split('@')[0]);
    await sql`delete from users where tenant_id = ${tenantId} and id = ${userIdOf(leaver.token)}`;
    const listed = (await listBatches('BB-GONE')).find((row) => row.id === lot)!;
    expect(listed).toMatchObject({ status: 'blocked', blockedBy: userIdOf(leaver.token), blockedByName: null });
  });

  it('regrantSmallerInTx: null when an open hold for the owner already exists; a re-grant larger than released throws', async () => {
    await seed('BB-REG', binA, 10, { code: 'Z-L1' });
    const ownerId = uuidv7();
    await inventory.atp(tenantId, wh, sku('BB-REG'));
    const set = await inventory.applyChannelBuffer({ tenantId, warehouseId: wh, skuId: sku('BB-REG'), ownerId, targetMilli: 5 * SCALE });
    const service = app.get(ReservationService) as unknown as {
      regrantSmallerInTx(tx: unknown, command: Record<string, unknown>, releasedFrom: Record<string, unknown>): Promise<unknown>;
    };
    const command = { tenantId, warehouseId: wh, skuId: sku('BB-REG'), ownerType: 'buffer', ownerId, quantity: 2 * SCALE };
    const released = { ...set.reservation!, state: 'released' };
    const db = app.get<Database>(DATABASE);
    // The standing row is still open (nothing released it): the helper refuses with null.
    expect(await withTenantTransaction(db, tenantId, (tx) => service.regrantSmallerInTx(tx, command, released))).toBeNull();
    await expect(
      withTenantTransaction(db, tenantId, (tx) => service.regrantSmallerInTx(tx, { ...command, quantity: 6 * SCALE }, released)),
    ).rejects.toThrow('NO MORE than the hold released');
    // Nothing was journalled: still the one 5-unit standing row.
    expect(await count(sql`select count(*)::int as n from reservations where tenant_id = ${tenantId} and owner_id = ${ownerId} and state = 'held'`)).toBe(1);
  });

  // ── code review: how a pend's batch was resolved ───────────────────────────

  async function withThreshold<T>(run: () => Promise<T>): Promise<T> {
    const put = (quantityThreshold: number) =>
      http()
        .put(`${API}/${tenantId}/inventory/adjustment-policies`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ quantityThreshold })
        .expect(200);
    await put(1);
    try {
      return await run();
    } finally {
      await put(1_000_000);
    }
  }

  function approve(pendId: string): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustment-pendings/${pendId}/approve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({});
  }

  it('an EXPLICIT pend (the web names the batch, no override reason) of a lot blocked since is approved — 201 and the ledger draw; batch_resolved_by is stored', async () => {
    await seed('BB-XPL', binA, 5, { code: 'X-L1', expiryDate: daysFromNow(60) });
    const lot = await batchId('BB-XPL', 'X-L1');
    await withThreshold(async () => {
      const pended = await adjust({ skuId: sku('BB-XPL'), binId: binA, quantityDelta: -3, reasonCode: 'damaged', batch: { code: 'X-L1', overrideReason: null } }).expect(202);
      const pendId = pended.body.pendingAdjustment.id as string;
      expect((await sql`select batch_resolved_by, batch_override_reason from stock_adjustment_pendings where id = ${pendId}`)[0]).toEqual({
        batch_resolved_by: 'explicit',
        batch_override_reason: null,
      });
      await block(lot, { reason: 'recall' }).expect(201);
      const approved = await approve(pendId).expect(200);
      const eventId = approved.body.events[0].id as string;
      expect((await sql`select batch_ref, quantity_delta::bigint as q from ledger_events where id = ${eventId}`)[0]).toEqual({ batch_ref: lot, q: String(-3 * SCALE) });
    });
    expect(await atp('BB-XPL')).toMatchObject({ onHand: 2, unpromisableBatch: 2 });
  });

  it('a pend raised before 3-3a (batch_resolved_by null) keeps the old inference: no override reason → FEFO → refused once blocked', async () => {
    await seed('BB-LEG', binA, 5, { code: 'L-L1', expiryDate: daysFromNow(60) });
    await withThreshold(async () => {
      const pended = await adjust({ skuId: sku('BB-LEG'), binId: binA, quantityDelta: -3 }).expect(202);
      const pendId = pended.body.pendingAdjustment.id as string;
      expect((await sql`select batch_resolved_by from stock_adjustment_pendings where id = ${pendId}`)[0]).toEqual({ batch_resolved_by: 'fefo' });
      await sql`update stock_adjustment_pendings set batch_resolved_by = null where id = ${pendId}`;
      await block(await batchId('BB-LEG', 'L-L1'), { reason: 'recall' }).expect(201);
      expect((await approve(pendId).expect(409)).body.code).toBe('batch-blocked');
    });
  });

  it('a FEFO pend whose batch EXPIRED after the pend is refused at approval (409 batch-expired), the pend stays pending', async () => {
    await seed('BB-XPD', binA, 5, { code: 'D-L1', expiryDate: daysFromNow(20) });
    const expiry = Date.parse((await listBatches('BB-XPD')).find((row) => row.code === 'D-L1')!.expiryDate!);
    await withThreshold(async () => {
      const pended = await adjust({ skuId: sku('BB-XPD'), binId: binA, quantityDelta: -2 }).expect(202);
      const pendId = pended.body.pendingAdjustment.id as string;
      try {
        batchExpiryClock.now = () => expiry + 1;
        const refused = await approve(pendId).expect(409);
        expect(refused.body.code).toBe('batch-expired');
        expect((await sql`select status from stock_adjustment_pendings where id = ${pendId}`)[0]).toEqual({ status: 'pending' });
        // At the expiry instant itself the default still draws it (expiry ≥ at).
        batchExpiryClock.now = () => expiry;
        await approve(pendId).expect(200);
      } finally {
        batchExpiryClock.now = () => Date.now();
      }
    });
  });

  it('the block note is stored, read back, and `other` cannot exist without one (the pairing CHECK)', async () => {
    const id = await batchId('BB-MAIN', 'M-2');
    const res = await block(id, { reason: 'other', note: ' Label misprint ' }).expect(201);
    expect(res.body.batch).toMatchObject({ blockedReason: 'other', blockedNote: 'Label misprint' });
    expect((await listBatches('BB-MAIN')).find((row) => row.id === id)).toMatchObject({ blockedNote: 'Label misprint' });
    await expect(sql`update batches set blocked_note = null where id = ${id}`).rejects.toMatchObject({ constraint_name: 'batches_blocked_pairing' });
    await unblock(id, { note: 'Relabelled' }).expect(201);
  });

  it('the routes are in the OpenAPI document', async () => {
    const res = await http().get('/api/v1/openapi.json').expect(200);
    const paths = Object.keys(res.body.paths as Record<string, unknown>);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/tenants/{tenantId}/inventory/batches/{batchId}/block',
        '/tenants/{tenantId}/inventory/batches/{batchId}/unblock',
      ]),
    );
  });
});
