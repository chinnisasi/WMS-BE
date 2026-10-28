import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ReplenishmentFacade } from '../src/modules/replenishment/replenishment.facade';
import { BIN_BLOCK_REASONS } from '../src/shared/db/schema';
import { SHORT_PICK_REASON_CODES } from '../src/modules/outbound/pick.command';
import { istDateOf, nowIso } from '../src/shared/primitives/time';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow } from './support/audit-guard';
import { dispatchedOrderFixtures, type PickLine } from './support/dispatched-order';

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

/** The session's user id (the token's `sub`). */
function userIdOf(token: string): string {
  return (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string }).sub;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Story 3-3b — blocked locations: the block / unblock verbs (reason, note, who
 * and when; guard order, replay, the same-key race, audit, outbox), the ATP
 * term (`unpromisableUnits.blockedBin` — a blocked bin's stock leaves ATP, the
 * grant ceiling, the channel-visible figure and the replenishment sweep, never
 * subtracted twice), the pick arm (the Skip of a planned stop, the offline
 * exemption and its narrowing), the reads (zone bin list, impact preview,
 * stock chip, device snapshot), the flows still allowed into and out of a
 * blocked bin, and the reporting split (SM-3 excludes a Skip, the client's
 * lines_short keeps it). Every matrix row of the spec is a case here.
 */
describe('story 3-3b: blocked locations (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let inventory: InventoryFacade;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let ownerEmail: string;
  let opsToken: string;
  let opsUserId: string;
  let webOperatorToken: string;
  let deviceOperatorToken: string;
  let wh: string;
  let zoneId: string;
  let selfClient: string;
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
  let binSeq = 0;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('bin_block');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    inventory = app.get(InventoryFacade);

    ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Bin Block Co ${ulid()}`, ownerEmail, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email: ownerEmail, password: PASSWORD })).body.accessToken as string;
    ownerUserId = userIdOf(ownerToken);
    opsToken = (await createMember('ops_manager')).token;
    opsUserId = userIdOf(opsToken);
    webOperatorToken = (await createMember('operator')).token;

    wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `BL-${ulid().slice(20)}`, name: 'Blocked locations warehouse' })
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

    const plain = [
      'BL-MAIN', 'BL-QUAR', 'BL-SKIP', 'BL-NONE', 'BL-OFF', 'BL-SUS', 'BL-BACK', 'BL-SEC', 'BL-SUB', 'BL-UNB',
      'BL-BAD', 'BL-REL', 'BL-RACE', 'BL-IMP1', 'BL-IMP2', 'BL-ADJ', 'BL-LIST', 'BL-RPT', 'BL-SNAP',
    ];
    const csv = [
      'sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked,reorder_point,reorder_qty',
      ...plain.map((code) => `${code},${code} name,pcs,1800,${code}-BC,false,false,,`),
      'BL-LOT,BL-LOT name,pcs,1800,BL-LOT-BC,true,false,,',
      'BL-RP,BL-RP name,pcs,1800,BL-RP-BC,false,false,3,10',
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
    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;

    // The floor device and its operator (an operator: no `secure.move`).
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
      .send({ code: minted.body.code, label: 'BL floor', pin: '2468' })
      .expect(201);
    deviceOperatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: floor.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    await inventory.rebuildReservationCounters(tenantId, wh);
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

  /** A fresh storage bin; codes sort in creation order (`A-01-001`, …). */
  async function createBin(): Promise<{ id: string; code: string }> {
    binSeq += 1;
    const code = `A-01-${String(binSeq).padStart(3, '0')}`;
    const id = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, capacity: 100_000, type: 'shelf' })
        .expect(201)
    ).body.id as string;
    return { id, code };
  }

  function adjust(body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: wh, reasonCode: 'stock-count', note: 'bin-block suite', ...body });
  }

  async function seed(skuCode: string, binId: string, qty: number, batch?: { code: string }): Promise<void> {
    await adjust({ skuId: sku(skuCode), binId, quantityDelta: qty, ...(batch === undefined ? {} : { batch }) }).expect(201);
  }

  function block(binId: string, body: Record<string, unknown>, token = opsToken, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/warehouses/${wh}/bins/${binId}/block`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function unblock(binId: string, body: Record<string, unknown>, token = opsToken, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/warehouses/${wh}/bins/${binId}/unblock`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function pick(line: PickLine, overrides: Record<string, unknown> = {}, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/outbound/picks`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .set(KEY_HEADER, key)
      .send({
        warehouseId: wh,
        picklistId: line.picklistId,
        picklistLineId: line.id,
        skuId: line.skuId,
        binId: line.binId,
        qty: line.qty,
        occurredAt: new Date().toISOString(),
        ...overrides,
      });
  }

  /** The Skip of a planned stop: qty 0 at the stop's own bin, no scan. */
  function skip(line: PickLine, overrides: Record<string, unknown> = {}, key = ulid()): SupertestTest {
    return pick(line, { qty: 0, reasonCode: 'skipped-blocked-bin', ...overrides }, key);
  }

  async function atp(skuCode: string): Promise<{ onHand: number; atp: number; blockedBin: number; unpromisableBatch: number; qcHeld: number; reserved: number }> {
    const snapshot = await inventory.atp(tenantId, wh, sku(skuCode));
    return {
      onHand: snapshot.onHand / SCALE,
      atp: snapshot.atp / SCALE,
      blockedBin: snapshot.blockedBin / SCALE,
      unpromisableBatch: snapshot.unpromisableBatch / SCALE,
      qcHeld: snapshot.qcHeld / SCALE,
      reserved: snapshot.reserved / SCALE,
    };
  }

  async function onHandIn(skuCode: string, binId: string): Promise<number> {
    const rows = (await sql`
      select coalesce(sum(quantity), 0)::bigint as q from stock_on_hand
       where tenant_id = ${tenantId} and sku_id = ${sku(skuCode)} and bin_id = ${binId}`) as unknown as { q: string }[];
    return Number(rows[0]!.q) / SCALE;
  }

  async function lineRow(id: string): Promise<{ status: string; reason_code: string | null }> {
    const rows = (await sql`select status, reason_code from picklist_lines where id = ${id}`) as unknown as { status: string; reason_code: string | null }[];
    return rows[0]!;
  }

  async function count(query: PromiseLike<unknown>): Promise<number> {
    return Number(((await query) as { n: number | string }[])[0]!.n);
  }

  async function zoneBin(binId: string): Promise<Record<string, unknown>> {
    const res = await http()
      .get(`${API}/${tenantId}/warehouses/${wh}/zones/${zoneId}/bins?limit=200`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    return (res.body.items as Record<string, unknown>[]).find((bin) => bin.id === binId)!;
  }

  /** A released single-order wave planning `qty` of `skuCode` — the planned line. */
  async function plannedLine(skuCode: string, qty: number): Promise<PickLine> {
    const { picklist } = await fixtures.releasedWave([{ skuId: sku(skuCode), quantity: qty }]);
    const line = picklist.lines.find((candidate) => candidate.status === 'planned');
    if (line === undefined) throw new Error('the fixture wave planned nothing');
    return line;
  }

  // ── the vocabularies (guide §4: TS ↔ DB) ────────────────────────────────────

  it('BIN_BLOCK_REASONS is exactly the bins_blocked_pairing vocabulary, and SHORT_PICK_REASON_CODES the reason CHECK — both NOT VALID (A4)', async () => {
    const rows = (await sql`
      select conname, convalidated, pg_get_constraintdef(oid) as def from pg_constraint
       where conname in ('bins_blocked_pairing', 'picklist_lines_reason_code_check') order by conname`) as unknown as {
      conname: string;
      convalidated: boolean;
      def: string;
    }[];
    expect(rows.map((row) => [row.conname, row.convalidated])).toEqual([
      ['bins_blocked_pairing', false],
      ['picklist_lines_reason_code_check', false],
    ]);
    const vocabulary = (def: string): string[] => {
      const array = /ARRAY\[([^\]]+)\]/.exec(def)![1]!;
      return [...array.matchAll(/'([a-z-]+)'::text/g)].map((match) => match[1]!).sort();
    };
    expect(vocabulary(rows[0]!.def)).toEqual([...BIN_BLOCK_REASONS].sort());
    // The reason CHECK carries two ARRAYs (status, then the reasons) — take the reasons.
    const reasonArray = [...rows[1]!.def.matchAll(/ARRAY\[([^\]]+)\]/g)].map((match) => match[1]!).find((list) => list.includes('bin-empty'))!;
    expect([...reasonArray.matchAll(/'([a-z-]+)'::text/g)].map((match) => match[1]!).sort()).toEqual([...SHORT_PICK_REASON_CODES].sort());
  });

  // ── the verbs ──────────────────────────────────────────────────────────────

  it('block: 201 with reason, note, who and when; ATP 10 → 0 (blockedBin 10); an order backorders; the channel figure is 0; audited with changes, replayed; unblock: ATP back to 10', async () => {
    const binA = await createBin();
    await seed('BL-MAIN', binA.id, 10);
    expect(await atp('BL-MAIN')).toMatchObject({ onHand: 10, atp: 10, blockedBin: 0 });

    const key = ulid();
    const blocked = await block(binA.id, { reason: 'damaged', note: '  rack upright bent  ' }, opsToken, key).expect(201);
    expect(blocked.body).toMatchObject({
      id: binA.id,
      blocked: true,
      blockedReason: 'damaged',
      blockedNote: 'rack upright bent',
      blockedBy: opsUserId,
    });
    expect(Date.parse(blocked.body.blockedAt as string)).toBeGreaterThan(Date.now() - 60_000);
    expect(blocked.body.blockedByName).toMatch(/^ops_manager-/);
    const replay = await block(binA.id, { reason: 'damaged', note: 'rack upright bent' }, opsToken, key).expect(201);
    expect(replay.body).toEqual(blocked.body);
    await block(binA.id, { reason: 'maintenance' }, opsToken, key).expect(422);
    await expectAuditRow({ tenantId, key, action: 'bin.blocked', targetType: 'bin', targetId: binA.id, actorUserId: opsUserId });
    const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as { changes: unknown }[];
    expect(audit[0]!.changes).toEqual({
      blocked: { before: false, after: true },
      reason: { before: null, after: 'damaged' },
      note: { before: null, after: 'rack upright bent' },
      blockedAt: { before: null, after: blocked.body.blockedAt },
      blockedBy: { before: null, after: opsUserId },
    });
    // One clock reading: the audit row's business time IS the block's instant.
    const stamped = (await sql`select occurred_at from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as { occurred_at: Date }[];
    expect(stamped[0]!.occurred_at.toISOString()).toBe(blocked.body.blockedAt);

    // The promise side: on hand, never promised.
    expect(await atp('BL-MAIN')).toMatchObject({ onHand: 10, atp: 0, blockedBin: 10, unpromisableBatch: 0 });
    const order = await http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, lines: [{ skuId: sku('BL-MAIN'), quantity: 1 }], destination: testAddress() })
      .expect(201);
    const orderLine = (order.body.order as { lines: { status: string; reservationId: string | null }[] }).lines[0]!;
    expect(orderLine.reservationId ?? null).toBeNull();
    const visible = await inventory.channelVisibleQuantity(tenantId, wh, sku('BL-MAIN'), uuidv7());
    expect(visible).toMatchObject({ blockedBin: 10 * SCALE, visibleMilli: 0 });

    // The live list names it.
    expect(await zoneBin(binA.id)).toMatchObject({
      blocked: true,
      blockedReason: 'damaged',
      blockedNote: 'rack upright bent',
      blockedBy: opsUserId,
      blockedAt: blocked.body.blockedAt,
      blockedByName: blocked.body.blockedByName,
    });

    const unkey = ulid();
    const unblocked = await unblock(binA.id, { note: 'Upright replaced' }, ownerToken, unkey).expect(201);
    expect(unblocked.body).toMatchObject({ blocked: false, blockedReason: null, blockedNote: null, blockedAt: null, blockedBy: null, blockedByName: null });
    await expectAuditRow({ tenantId, key: unkey, action: 'bin.unblocked', targetType: 'bin', targetId: binA.id, actorUserId: ownerUserId });
    const unaudit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${unkey}`) as unknown as {
      changes: Record<string, { before: unknown; after: unknown }>;
    }[];
    expect(unaudit[0]!.changes).toMatchObject({
      blocked: { before: true, after: false },
      reason: { before: 'damaged', after: null },
      note: { before: 'rack upright bent', after: 'Upright replaced' },
      blockedBy: { before: opsUserId, after: null },
    });
    expect(unaudit[0]!.changes.blockedAt!.before).toBe(blocked.body.blockedAt);
    await unblock(binA.id, { note: 'Upright replaced' }, ownerToken, unkey).expect(201);
    await expectAuditRow({ tenantId, key: unkey, action: 'bin.unblocked', targetType: 'bin', targetId: binA.id, actorUserId: ownerUserId });
    // ATP is back (less the 1 the backordered order never held).
    expect(await atp('BL-MAIN')).toMatchObject({ onHand: 10, atp: 10, blockedBin: 0 });
  });

  it('already: 409 bin-already-blocked / bin-not-blocked — thrown, so no key and no audit row', async () => {
    const bin = await createBin();
    const activeKey = ulid();
    expect((await unblock(bin.id, { note: 'nothing to lift' }, opsToken, activeKey).expect(409)).body.code).toBe('bin-not-blocked');
    await block(bin.id, { reason: 'maintenance' }).expect(201);
    const againKey = ulid();
    const again = await block(bin.id, { reason: 'safety-hazard' }, opsToken, againKey).expect(409);
    expect(again.body.code).toBe('bin-already-blocked');
    expect(again.body.detail).toContain('maintenance');
    for (const key of [activeKey, againKey]) {
      expect(await count(sql`select count(*) as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(0);
      expect(await count(sql`select count(*) as n from audit_events where tenant_id = ${tenantId} and reference = ${key}`)).toBe(0);
    }
  });

  it('shape: other needs a note; unblock needs a note; a note over 500 (trimmed) is refused; an unknown reason is refused; an operator is 403', async () => {
    const bin = await createBin();
    expect((await block(bin.id, { reason: 'other' }).expect(400)).body.code).toBe('validation-failed');
    expect((await block(bin.id, { reason: 'other', note: '   ' }).expect(400)).body.code).toBe('validation-failed');
    expect((await block(bin.id, { reason: 'haunted' }).expect(400)).body.code).toBe('validation-failed');
    expect((await block(bin.id, { reason: 'damaged', note: 'n'.repeat(501) }).expect(400)).body.code).toBe('validation-failed');
    // 500 after trimming is fine.
    await block(bin.id, { reason: 'other', note: ` ${'n'.repeat(500)} ` }).expect(201);
    expect((await unblock(bin.id, {}).expect(400)).body.code).toBe('validation-failed');
    expect((await unblock(bin.id, { note: '  ' }).expect(400)).body.code).toBe('validation-failed');
    expect((await unblock(bin.id, { note: 'x' }, webOperatorToken).expect(403)).body.code).toBe('role-denied');
    await unblock(bin.id, { note: 'cleared' }).expect(201);
  });

  it('system bin 400, retired bin 409 bin-retired; the retired PATCH arm 400 names the verbs', async () => {
    // A system bin (the QC-HOLD bin, ensured by a hold placed in this suite
    // or here): never blockable.
    const holdBin = await createBin();
    await seed('BL-BAD', holdBin.id, 1);
    await http()
      .post(`${API}/${tenantId}/receiving/qc-holds`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, skuId: sku('BL-BAD'), binId: holdBin.id, reason: 'suspect seal' })
      .expect(201);
    const system = (await sql`select id from bins where tenant_id = ${tenantId} and warehouse_id = ${wh} and code = 'QC-HOLD' and system_owned`) as unknown as { id: string }[];
    const systemRefusal = await block(system[0]!.id, { reason: 'damaged' }).expect(400);
    expect(systemRefusal.body.code).toBe('validation-failed');
    expect(systemRefusal.body.detail).toContain('system bin');
    const retired = await createBin();
    await http()
      .post(`${API}/${tenantId}/warehouses/${wh}/bins/${retired.id}/retire`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(200);
    expect((await block(retired.id, { reason: 'damaged' }).expect(409)).body.code).toBe('bin-retired');
    const patched = await http()
      .patch(`${API}/${tenantId}/warehouses/${wh}/bins/${retired.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ blocked: true })
      .expect(400);
    expect(patched.body.code).toBe('validation-failed');
    expect(patched.body.detail).toContain('/block');
  });

  it('same-key race: two requests parked on the bin row both answer the winner\'s snapshot — one key, one audit row, one block', async () => {
    const bin = await createBin();
    await seed('BL-RACE', bin.id, 3);
    const key = ulid();
    const [first, second] = await raceTwice(bin.id, () => block(bin.id, { reason: 'investigation' }, opsToken, key));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(await count(sql`select count(*) as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(1);
    await expectAuditRow({ tenantId, key, action: 'bin.blocked', targetType: 'bin', targetId: bin.id, actorUserId: opsUserId });
  });

  // ── the ATP term ───────────────────────────────────────────────────────────

  it('a blocked lot in a blocked bin is counted once, under blockedBin; a quarantined blocked bin is never subtracted twice', async () => {
    const lotBin = await createBin();
    await seed('BL-LOT', lotBin.id, 4, { code: 'L-1' });
    const batchId = ((await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku('BL-LOT')} and code = 'L-1'`) as unknown as { id: string }[])[0]!.id;
    await http()
      .post(`${API}/${tenantId}/inventory/batches/${batchId}/block`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ reason: 'recall' })
      .expect(201);
    expect(await atp('BL-LOT')).toMatchObject({ onHand: 4, unpromisableBatch: 4, blockedBin: 0, atp: 0 });
    await block(lotBin.id, { reason: 'contamination' }).expect(201);
    expect(await atp('BL-LOT')).toMatchObject({ onHand: 4, unpromisableBatch: 0, blockedBin: 4, atp: 0 });

    const quarBin = await createBin();
    const other = await createBin();
    await seed('BL-QUAR', quarBin.id, 5);
    await seed('BL-QUAR', other.id, 2);
    await block(quarBin.id, { reason: 'investigation' }).expect(201);
    expect(await atp('BL-QUAR')).toMatchObject({ onHand: 7, blockedBin: 5, atp: 2 });
    await sql`
      insert into inventory_quarantines (id, tenant_id, warehouse_id, sku_id, bin_id, from_seq, to_seq, reason, status)
      values (${uuidv7()}, ${tenantId}, ${wh}, ${sku('BL-QUAR')}, ${quarBin.id}, 1, 1, 'bin-block-suite', 'open')`;
    // The 5 leave on-hand (quarantine) AND the term — never 5 twice.
    expect(await atp('BL-QUAR')).toMatchObject({ onHand: 2, blockedBin: 0, atp: 2 });
  });

  it('flows still allowed: a positive adjustment into a blocked bin (unpromisable at once), a move out of it, a count of it; a QC hold released into a blocked origin returns the units there, still unpromisable', async () => {
    const bin = await createBin();
    const target = await createBin();
    await block(bin.id, { reason: 'damaged' }).expect(201);
    await seed('BL-ADJ', bin.id, 6);
    expect(await atp('BL-ADJ')).toMatchObject({ onHand: 6, blockedBin: 6, atp: 0 });
    await http()
      .post(`${API}/${tenantId}/warehouses/${wh}/inventory/moves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ skuId: sku('BL-ADJ'), fromBinId: bin.id, toBinId: target.id, qty: 2, reasonCode: 'consolidate' })
      .expect((res) => expect([200, 201]).toContain(res.status));
    expect(await atp('BL-ADJ')).toMatchObject({ onHand: 6, blockedBin: 4, atp: 2 });
    await http()
      .post(`${API}/${tenantId}/movements/counts`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, binId: bin.id })
      .expect(201);

    // QC release into a blocked origin (A16): allowed, the units land back
    // in the blocked bin and stay unpromisable.
    const origin = await createBin();
    await seed('BL-REL', origin.id, 6);
    const hold = await http()
      .post(`${API}/${tenantId}/receiving/qc-holds`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, skuId: sku('BL-REL'), binId: origin.id, reason: 'suspect seal' })
      .expect(201);
    expect(await atp('BL-REL')).toMatchObject({ qcHeld: 6, atp: 0 });
    await block(origin.id, { reason: 'maintenance' }).expect(201);
    await http()
      .post(`${API}/${tenantId}/receiving/qc-holds/${hold.body.qcHold.id as string}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .expect((res) => expect([200, 201]).toContain(res.status));
    expect(await onHandIn('BL-REL', origin.id)).toBe(6);
    expect(await atp('BL-REL')).toMatchObject({ onHand: 6, qcHeld: 0, blockedBin: 6, atp: 0 });
  });

  it('replenishment (A15): a block that drops ATP below the reorder point opens a breach and a DRAFT suggested PO', async () => {
    const replenishment = app.get(ReplenishmentFacade);
    const bin = await createBin();
    await seed('BL-RP', bin.id, 10);
    expect((await replenishment.sweepScope(tenantId, wh)).opened).toBe(0);
    await block(bin.id, { reason: 'safety-hazard' }).expect(201);
    expect((await replenishment.sweepScope(tenantId, wh)).opened).toBe(1);
    const drafts = (await sql`select status from suggested_pos where tenant_id = ${tenantId} and sku_id = ${sku('BL-RP')}`) as unknown as { status: string }[];
    expect(drafts.map((draft) => draft.status)).toEqual(['draft']);
  });

  // ── the pick arm ───────────────────────────────────────────────────────────

  it('Skip: a stop planned in A before the block is skipped (qty 0, no scan) → the line is short skipped-blocked-bin and re-planned onto B; replay re-serves', async () => {
    const binA = await createBin();
    const binB = await createBin();
    await seed('BL-SKIP', binA.id, 5);
    const line = await plannedLine('BL-SKIP', 5);
    expect(line.binId).toBe(binA.id);
    await seed('BL-SKIP', binB.id, 5);
    await block(binA.id, { reason: 'damaged' }).expect(201);

    const key = ulid();
    // A queued op stamps its business time once; the replay resends it.
    const occurredAt = new Date().toISOString();
    const res = await skip(line, { occurredAt }, key).expect(201);
    expect(res.body.pick).toMatchObject({ reasonCode: 'skipped-blocked-bin', shortfallQty: 5 });
    const replanned = res.body.pick.replanned as { binId: string; qty: number }[];
    expect(replanned.map((slice) => [slice.binId, slice.qty])).toEqual([[binB.id, 5]]);
    expect(await lineRow(line.id)).toEqual({ status: 'short', reason_code: 'skipped-blocked-bin' });
    // Nothing was drawn from the blocked bin.
    expect(await onHandIn('BL-SKIP', binA.id)).toBe(5);
    expect((await skip(line, { occurredAt }, key).expect(201)).body).toEqual(res.body);
    await expectAuditRow({ tenantId, key, action: 'pick.short-picked', targetType: 'picklist_line', targetId: line.id, actorUserId: userIdOf(deviceOperatorToken) });
    // The audit row says the short was the blocked bin, not the picker's miss.
    const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as { changes: unknown }[];
    expect(audit.map((row) => row.changes)).toEqual([{ skippedBlockedBin: { binId: binA.id, reason: 'damaged' } }]);
  });

  it('Skip, nothing else: the line is short and takes the partial path (nothing re-planned)', async () => {
    const binA = await createBin();
    await seed('BL-NONE', binA.id, 4);
    const line = await plannedLine('BL-NONE', 4);
    await block(binA.id, { reason: 'maintenance' }).expect(201);
    const res = await skip(line).expect(201);
    expect(res.body.pick.replanned).toEqual([]);
    expect(await lineRow(line.id)).toEqual({ status: 'short', reason_code: 'skipped-blocked-bin' });
  });

  it('Skip of a blocked SECURE stop by an operator without secure.move is admitted (nothing is drawn)', async () => {
    const binA = await createBin();
    const binB = await createBin();
    await seed('BL-SEC', binA.id, 3);
    const line = await plannedLine('BL-SEC', 3);
    await seed('BL-SEC', binB.id, 3);
    await sql`update bins set storage_class = 'secure' where id = ${binA.id}`;
    await block(binA.id, { reason: 'safety-hazard' }).expect(201);
    const res = await skip(line).expect(201);
    expect(res.body.pick.replanned.map((slice: { binId: string }) => slice.binId)).toEqual([binB.id]);
  });

  it('bad Skips: another bin than the stop\'s, or qty > 0 → 400; a Skip of a bin that was unblocked → 409 bin-not-blocked (the stop stays planned)', async () => {
    const binA = await createBin();
    const binB = await createBin();
    await seed('BL-SUB', binA.id, 4);
    const line = await plannedLine('BL-SUB', 4);
    await seed('BL-SUB', binB.id, 4);
    await block(binA.id, { reason: 'damaged' }).expect(201);
    await block(binB.id, { reason: 'damaged' }).expect(201);
    const substituted = await skip(line, { binId: binB.id }).expect(400);
    expect(substituted.body.code).toBe('validation-failed');
    expect(substituted.body.detail).toContain('skipped-blocked-bin');
    expect((await skip(line, { qty: 1 }).expect(400)).body.code).toBe('validation-failed');
    expect((await lineRow(line.id)).status).toBe('planned');

    // A queued Skip replayed after the unblock.
    await unblock(binA.id, { note: 'false alarm' }).expect(201);
    const stale = await skip(line).expect(409);
    expect(stale.body).toMatchObject({ code: 'bin-not-blocked', binCode: (await zoneBin(binA.id)).code });
    expect((await lineRow(line.id)).status).toBe('planned');
    // …and the stop picks normally.
    await pick(line).expect(201);
  });

  it('offline before: a pick made before the block lands (on-hand −qty) and says so on its audit row; one made after is 400 bin-blocked', async () => {
    const binA = await createBin();
    await seed('BL-OFF', binA.id, 6);
    const line = await plannedLine('BL-OFF', 3);
    const before = new Date().toISOString();
    await sleep(15);
    const blocked = await block(binA.id, { reason: 'damaged' }).expect(201);

    // After the block: refused, naming the reason.
    const after = await pick(line, { occurredAt: new Date().toISOString() }).expect(400);
    expect(after.body.code).toBe('bin-blocked');
    expect(after.body.detail).toContain('damaged');

    const key = ulid();
    await pick(line, { occurredAt: before }, key).expect(201);
    expect(await onHandIn('BL-OFF', binA.id)).toBe(3);
    const audit = (await sql`select action, changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as {
      action: string;
      changes: unknown;
    }[];
    expect(audit).toEqual([
      { action: 'pick.picked', changes: { landedBeforeBlock: { binId: binA.id, blockedAt: blocked.body.blockedAt, reason: 'damaged' } } },
    ]);
  });

  it('offline before a SUSPECT-STOCK block (contamination, temperature-excursion) or a BACKFILLED block: refused 400 bin-blocked (A1)', async () => {
    for (const reason of ['contamination', 'temperature-excursion'] as const) {
      const binA = await createBin();
      await seed('BL-SUS', binA.id, 4);
      const line = await plannedLine('BL-SUS', 2);
      const before = new Date().toISOString();
      await sleep(15);
      await block(binA.id, { reason }).expect(201);
      const refused = await pick(line, { occurredAt: before }).expect(400);
      expect({ reason, code: refused.body.code }).toEqual({ reason, code: 'bin-blocked' });
      expect(await onHandIn('BL-SUS', binA.id)).toBe(4);
    }

    const binB = await createBin();
    await seed('BL-BACK', binB.id, 4);
    const lineB = await plannedLine('BL-BACK', 2);
    const beforeB = new Date().toISOString();
    await sleep(15);
    // The 0106 backfill's shape: reason other, the backfill note, no blocker.
    await sql`update bins set blocked = true, blocked_reason = 'other', blocked_note = 'Blocked before story 3-3b recorded reasons',
      blocked_at = now(), blocked_by = null where id = ${binB.id}`;
    expect((await pick(lineB, { occurredAt: beforeB }).expect(400)).body.code).toBe('bin-blocked');
    expect(await zoneBin(binB.id)).toMatchObject({ blockedReason: 'other', blockedBy: null, blockedByName: null });
  });

  // ── the reads ──────────────────────────────────────────────────────────────

  it('impact preview: on-hand units and SKUs, planned pick lines and units, open count lines, per client; bin.block only; 404 for an unknown bin', async () => {
    // A second client (a brand) with its own SKU in the same shared bin.
    const brandId = (
      await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'BRAND-X', name: 'Brand X Apparel' })
        .expect(201)
    ).body.client.id as string;
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', brandId)
      .attach('file', Buffer.from('sku_code,name,uom,gst_rate\nBX-1,Brand X tee,pcs,1800', 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const brandSku = ((await sql`select id from skus where tenant_id = ${tenantId} and client_id = ${brandId} and code = 'BX-1'`) as unknown as { id: string }[])[0]!.id;
    skuIds.set('BX-1', brandSku);

    const bin = await createBin();
    await seed('BL-IMP1', bin.id, 7);
    await seed('BL-IMP2', bin.id, 3);
    await seed('BX-1', bin.id, 12);
    // Only the tenant's own SKU has a planned stop in the bin.
    await plannedLine('BL-IMP1', 2);
    await http()
      .post(`${API}/${tenantId}/movements/counts`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, binId: bin.id })
      .expect(201);
    const read = (token: string, binId = bin.id) =>
      http().get(`${API}/${tenantId}/warehouses/${wh}/bins/${binId}/block-impact`).set('Authorization', `Bearer ${token}`);
    const res = await read(opsToken).expect(200);
    expect(res.body).toEqual({
      binId: bin.id,
      onHandUnits: 22,
      skuCount: 3,
      plannedPickLines: 1,
      plannedPickUnits: 2,
      openCountLines: 3,
      // Descending units: the brand (12, by its code) before the tenant (10).
      byClient: [
        { clientId: brandId, clientName: 'BRAND-X', units: 12, skuCount: 1, plannedPickLines: 0 },
        { clientId: selfClient, clientName: expect.stringMatching(/^Bin Block Co .* \(your company\)$/), units: 10, skuCount: 2, plannedPickLines: 1 },
      ],
    });
    expect((await read(webOperatorToken).expect(403)).body.code).toBe('role-denied');
    await read(opsToken, uuidv7()).expect(404);
  });

  it('the stock list carries binBlocked on both orders; the device snapshot bin carries blockedReason', async () => {
    const bin = await createBin();
    await seed('BL-LIST', bin.id, 2);
    await block(bin.id, { reason: 'temperature-excursion' }).expect(201);
    for (const query of [`skuId=${sku('BL-LIST')}`, `skuId=${sku('BL-LIST')}&order=location`]) {
      const res = await http().get(`${API}/${tenantId}/warehouses/${wh}/inventory/stock?${query}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect((res.body.items as { binId: string; binBlocked: boolean }[]).map((item) => [item.binId, item.binBlocked])).toEqual([[bin.id, true]]);
    }
    const other = await createBin();
    await seed('BL-SNAP', other.id, 1);
    const listed = await http().get(`${API}/${tenantId}/warehouses/${wh}/inventory/stock?skuId=${sku('BL-SNAP')}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(listed.body.items[0].binBlocked).toBe(false);

    const snapshot = await http()
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .expect(200);
    const bins = snapshot.body.bins as { id: string; blocked: boolean; blockedReason: string | null }[];
    expect(bins.find((row) => row.id === bin.id)).toMatchObject({ blocked: true, blockedReason: 'temperature-excursion' });
    expect(bins.find((row) => row.id === other.id)).toMatchObject({ blocked: false, blockedReason: null });
  });

  // ── reporting (A11) ────────────────────────────────────────────────────────

  it('KPI: a Skip is not in the shortPicks tile or SM-3 (its drill excludes it too); the client\'s lines_short keeps it', async () => {
    const binA = await createBin();
    const binB = await createBin();
    await seed('BL-RPT', binA.id, 2);
    const line = await plannedLine('BL-RPT', 2);
    await seed('BL-RPT', binB.id, 2);
    await block(binA.id, { reason: 'damaged' }).expect(201);
    const skipped = await skip(line).expect(201);
    const slice = (skipped.body.pick.replanned as { picklistLineId: string; binId: string; qty: number }[])[0]!;
    await pick({ ...line, id: slice.picklistLineId, binId: slice.binId, qty: slice.qty }).expect(201);
    await fixtures.packAndDispatch(line.orderId, [{ skuId: sku('BL-RPT'), qty: 2 }]);

    const overview = await http().get(`${API}/${tenantId}/warehouses/${wh}/reporting/overview`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    // Every short line of this warehouse is a Skip — none counts.
    expect(await count(sql`select count(*) as n from picklist_lines where tenant_id = ${tenantId} and status = 'short' and reason_code = 'skipped-blocked-bin'`)).toBeGreaterThan(0);
    expect(await count(sql`select count(*) as n from picklist_lines where tenant_id = ${tenantId} and status = 'short' and reason_code is distinct from 'skipped-blocked-bin'`)).toBe(0);
    expect(overview.body.tiles.shortPicks.shortLines.d7.value).toBe(0);
    expect(overview.body.tiles.orderAccuracy.shortLines.d7.value).toBe(0);
    expect(overview.body.tiles.shortPicks.shortLines.d7.drill.query).toMatchObject({ status: 'short', skippedBlockedBin: 'false' });
    const drill = await http()
      .get(`${API}/${tenantId}/warehouses/${wh}/outbound/picklist-lines?status=short&skippedBlockedBin=false`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect(drill.body.items).toEqual([]);
    const skips = await http()
      .get(`${API}/${tenantId}/warehouses/${wh}/outbound/picklist-lines?status=short&skippedBlockedBin=true`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect((skips.body.items as { id: string }[]).map((item) => item.id)).toContain(line.id);

    const today = istDateOf(nowIso());
    const service = await http()
      .get(`${API}/${tenantId}/reporting/clients/${selfClient}/service?from=${today}&to=${today}&warehouseId=${wh}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect(service.body.pickAccuracy.linesShortPicked).toBeGreaterThanOrEqual(1);
  });

  it('OpenAPI lists the two verbs and the impact read', async () => {
    const spec = await http().get('/api/v1/openapi.json').expect(200);
    const paths = spec.body.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths['/api/v1/tenants/{tenantId}/warehouses/{warehouseId}/bins/{binId}/block'] ?? paths['/tenants/{tenantId}/warehouses/{warehouseId}/bins/{binId}/block'] ?? {})).toEqual(['post']);
    expect(Object.keys(paths['/api/v1/tenants/{tenantId}/warehouses/{warehouseId}/bins/{binId}/unblock'] ?? paths['/tenants/{tenantId}/warehouses/{warehouseId}/bins/{binId}/unblock'] ?? {})).toEqual(['post']);
    expect(Object.keys(paths['/api/v1/tenants/{tenantId}/warehouses/{warehouseId}/bins/{binId}/block-impact'] ?? paths['/tenants/{tenantId}/warehouses/{warehouseId}/bins/{binId}/block-impact'] ?? {})).toEqual(['get']);
  });

  // ── the race helpers (the 21-11a pattern) ──────────────────────────────────

  const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

  async function waitParked(holderPid: number, min: number): Promise<void> {
    const probe = handle();
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active'
            and a.query ilike '%"bins"%' and a.query ilike '%for update%'
        `) as unknown as { pid: number; blockers: number[] }[];
        const chain = new Set<number>([holderPid]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const row of waiting) {
            if (!chain.has(row.pid) && row.blockers.some((pid) => chain.has(pid))) {
              chain.add(row.pid);
              grew = true;
            }
          }
        }
        if (chain.size - 1 >= min) return;
        await sleep(25);
      }
      throw new Error(`fewer than ${min} request(s) parked on the bins row`);
    } finally {
      await probe.end();
    }
  }

  async function raceTwice(binId: string, send: () => SupertestTest): Promise<[request.Response, request.Response]> {
    const holder = handle();
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`select pg_backend_pid() as pid from bins where tenant_id = ${tenantId} and id = ${binId} for update`) as unknown as { pid: number }[];
        first = (async () => send())();
        second = (async () => send())();
        await waitParked(locked[0]!.pid, 2);
      });
      return await Promise.all([first!, second!]);
    } finally {
      await Promise.allSettled([first, second]);
      await holder.end();
    }
  }
});
