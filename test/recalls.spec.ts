import type { INestApplication } from '@nestjs/common';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { Workbook } from 'exceljs';
import { sql as dsql } from 'drizzle-orm';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ReportingFacade, RECALL_REPORT_COLUMNS, RECALL_REPORT_SECTIONS } from '../src/modules/reporting/reporting.facade';
import { RECALL_MODES, RECALL_STATUSES } from '../src/modules/recalls/recalls.facade';
import { buildCloseSummary } from '../src/modules/recalls/close-summary';
import { batchCandidatesQuery } from '../src/modules/catalog/catalog.facade';
import { openOrdersQuery } from '../src/modules/outbound/recall-trace';
import { orderPickEventsQuery, pickedBatchRefsQuery, recallOnHandQuery } from '../src/modules/inventory/recall-trace';
import { UTF8_BOM } from '../src/shared/export/csv';
import { buildXlsx, buildXlsxWorkbook } from '../src/shared/export/xlsx';
import { signedQuantity } from '../src/shared/primitives/quantity';
import { ensureDamagedBinInTx, ensureInTransitBinInTx, ensureQcHoldBinInTx, ensureReceivingBinInTx, ensureReturnsBinInTx } from '../src/modules/tenancy/receiving-bin';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow } from './support/audit-guard';
import { dispatchedOrderFixtures } from './support/dispatched-order';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(300_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const SCALE = 1000;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** The advisory key every suite uses to serialize wms_rls_probe role setup. */
const PROBE_LOCK = 742105;

function userIdOf(token: string): string {
  return (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string }).sub;
}

function nowZ(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function parseCsv(text: string): string[][] {
  expect(text.startsWith(UTF8_BOM)).toBe(true);
  const body = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function binary(res: request.Response, callback: (err: Error | null, body: Buffer) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

/** A CSV as rows keyed by column header. */
function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  return rows.map((row) => Object.fromEntries(header!.map((name, index) => [name, row[index] ?? ''])));
}

interface Lot {
  readonly id: string;
  readonly code: string;
}

/**
 * Story 3-7a — the batch recall: open (live and mock), the blocks it takes
 * in every warehouse, the guards (mixed client, already recalled, the unblock
 * under recall, dispatch of a held order, a pick in a mixed bin), add lots,
 * close with releases, overrides and the frozen summary; the figures and the
 * trace (on hand, in transit, held, dispatched, received, damaged, returned,
 * written off — each figure equal to its rows' sum); the report (CSV streamed
 * to its `end` row, XLSX built whole and capped, the slots, the deadline, the
 * download audit), the portal's two layers, the locks and their races, the
 * EXPLAINs of the bounded reads, and the RLS probes.
 */
describe('story 3-7a: batch recall (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let db: Database;
  let inventory: InventoryFacade;
  let reporting: ReportingFacade;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorToken: string;
  let deviceOperatorToken: string;
  let wh: string;
  let wh2: string;
  let zoneId: string;
  let binA: string;
  let binB: string;
  let binD: string;
  let binC: string;
  let acme: string;
  let beta: string;
  let acmePortal: { userId: string; token: string };
  let betaPortal: { userId: string; token: string };
  const skuIds = new Map<string, string>();
  const http = () => request(app.getHttpServer());
  const sku = (code: string): string => {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  };
  const fixtures = dispatchedOrderFixtures(() => ({
    app,
    tenantId,
    warehouseId: wh,
    opsToken,
    ownerToken,
    operatorToken: deviceOperatorToken,
  }));

  const ACME_SKUS = [
    'RC-OPEN', 'RC-OPEN2', 'RC-ATP', 'RC-PRE', 'RC-PREQ', 'RC-HELD', 'RC-OTHER', 'RC-QCB', 'RC-MIX', 'RC-CL', 'RC-UNA', 'RC-TRN',
    'RC-N1', 'RC-N2', 'RC-MOCK', 'RC-LOCK', 'RC-RACE1', 'RC-RACE2', 'RC-PICKR', 'RC-SK1', 'RC-SK2', 'RC-SK3', 'RC-B19', 'RC-ALL',
    'RC-BIG', 'RC-REP', 'RC-CUT',
  ];

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('recalls');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    db = app.get<Database>(DATABASE);
    inventory = app.get(InventoryFacade);
    reporting = app.get(ReportingFacade);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Recall Co ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
    ownerUserId = userIdOf(ownerToken);
    opsToken = (await createMember('ops_manager')).token;
    opsUserId = userIdOf(opsToken);
    operatorToken = (await createMember('operator')).token;

    wh = await createWarehouse(`RC-${ulid().slice(20)}`);
    zoneId = await createZone(wh, 'A');
    binA = await createBin(wh, zoneId, 'A-01-01');
    binB = await createBin(wh, zoneId, 'A-01-02');
    binD = await createBin(wh, zoneId, 'A-01-03');
    wh2 = await createWarehouse(`RC2-${ulid().slice(20)}`);
    binC = await createBin(wh2, await createZone(wh2, 'C'), 'C-01-01');

    acme = await createClient('ACME', 'Acme Foods');
    beta = await createClient('BETA', 'Beta Pharma');
    await importCsv(ACME_SKUS.map((code) => `${code},${code} name,pcs,1800,${code}-BC,true,false`), acme);
    await importCsv(['RB-1,RB-1 name,pcs,1800,RB-1-BC,true,false', 'RB-N,RB-N name,pcs,1800,RB-N-BC,true,false'], beta);
    const rows = (await sql`select id, code from skus where tenant_id = ${tenantId}`) as unknown as { id: string; code: string }[];
    for (const row of rows) skuIds.set(row.code, row.id);

    // The floor device and its operator.
    const floor = await createMember('operator');
    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({}).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'RC dock', pin: '2468' }).expect(201);
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail: floor.email, pin: '2468' })
      .expect(200);
    deviceOperatorToken = badged.body.accessToken as string;

    acmePortal = await portalUser(acme);
    betaPortal = await portalUser(beta);

    await inventory.rebuildReservationCounters(tenantId, wh);
    await inventory.rebuildReservationCounters(tenantId, wh2);
  });

  afterAll(async () => {
    await sql?.end();
    const dbClient = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await dbClient.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function createMember(role: 'ops_manager' | 'operator'): Promise<{ email: string; token: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { email, token: (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string };
  }

  async function portalUser(clientId: string): Promise<{ userId: string; token: string }> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role: 'client', clientId }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { userId: invited.body.user.id as string, token: (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string };
  }

  async function createWarehouse(code: string): Promise<string> {
    return (
      await http().post(`${API}/${tenantId}/warehouses`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ origin: testAddress(), code, name: `Warehouse ${code}` }).expect(201)
    ).body.id as string;
  }

  async function createZone(warehouseId: string, code: string): Promise<string> {
    return (
      await http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name: `Zone ${code}` }).expect(201)
    ).body.id as string;
  }

  async function createBin(warehouseId: string, zone: string, code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, capacity: 1_000_000, type: 'shelf' })
        .expect(201)
    ).body.id as string;
  }

  async function createClient(code: string, name: string): Promise<string> {
    return (await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name }).expect(201)).body.client.id as string;
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked', ...rows].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  function adjust(body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: wh, reasonCode: 'stock-count', note: 'recall suite', ...body });
  }

  async function seed(skuCode: string, binId: string, qty: number, code: string, warehouseId = wh, expiryDays?: number): Promise<Lot> {
    await adjust({
      warehouseId,
      skuId: sku(skuCode),
      binId,
      quantityDelta: qty,
      batch: { code, ...(expiryDays === undefined ? {} : { expiryDate: new Date(Date.now() + expiryDays * 86_400_000).toISOString() }) },
    }).expect(201);
    return { id: await batchId(skuCode, code), code };
  }

  async function batchId(skuCode: string, code: string): Promise<string> {
    const rows = (await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku(skuCode)} and code = ${code}`) as unknown as { id: string }[];
    return rows[0]!.id;
  }

  async function batchRow(id: string): Promise<{ status: string; blocked_reason: string | null; blocked_note: string | null }> {
    return (await sql`select status, blocked_reason, blocked_note from batches where id = ${id}`)[0] as unknown as { status: string; blocked_reason: string | null; blocked_note: string | null };
  }

  function openRecall(body: Record<string, unknown>, key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/inventory/recalls`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function addBatches(recallId: string, batchIds: string[], key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/inventory/recalls/${recallId}/batches`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({ batchIds });
  }

  function closeRecall(recallId: string, body: Record<string, unknown>, key = ulid(), token = opsToken): SupertestTest {
    return http().post(`${API}/${tenantId}/inventory/recalls/${recallId}/close`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function detail(recallId: string, token = operatorToken): SupertestTest {
    return http().get(`${API}/${tenantId}/inventory/recalls/${recallId}`).set('Authorization', `Bearer ${token}`);
  }

  function block(id: string, body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http().post(`${API}/${tenantId}/inventory/batches/${id}/block`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send(body);
  }

  function unblock(id: string, note: string): SupertestTest {
    return http().post(`${API}/${tenantId}/inventory/batches/${id}/unblock`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ note });
  }

  function report(recallId: string, format: 'csv' | 'xlsx', token = operatorToken): SupertestTest {
    return http().get(`${API}/${tenantId}/inventory/recalls/${recallId}/report?format=${format}`).set('Authorization', `Bearer ${token}`);
  }

  function portalGet(path: string, token: string): SupertestTest {
    return http().get(`${API}/${tenantId}/portal/${path}`).set('Authorization', `Bearer ${token}`);
  }

  async function atp(skuCode: string, warehouseId = wh): Promise<{ onHand: number; atp: number; unpromisableBatch: number }> {
    const snapshot = await inventory.atp(tenantId, warehouseId, sku(skuCode));
    return { onHand: snapshot.onHand / SCALE, atp: snapshot.atp / SCALE, unpromisableBatch: snapshot.unpromisableBatch / SCALE };
  }

  async function count(query: PromiseLike<unknown>): Promise<number> {
    return Number(((await query) as { n: number | string }[])[0]!.n);
  }

  async function keyStored(key: string): Promise<boolean> {
    return (await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)) === 1;
  }

  async function pack(orderId: string, scanned: { skuId: string; qty: number }[]): Promise<void> {
    await http().post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ scanned }).expect(201);
  }

  function dispatch(orderId: string, key = ulid()): SupertestTest {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send({ carrierName: 'BlueDart', trackingNumber: `AWB-${ulid().slice(18)}` });
  }

  /** A picked-and-packed order of `qty` units of `skuCode` (the wave draws FEFO). */
  async function packedOrder(skuCode: string, qty: number, extra: Record<string, unknown> = {}): Promise<string> {
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku(skuCode), quantity: qty }], extra);
    await fixtures.pickAllLines(picklist);
    await pack(orderId, [{ skuId: sku(skuCode), qty }]);
    return orderId;
  }

  /** Poll until `n` backends of this database wait on a lock held by another. */
  async function waitParked(n: number, timeoutMs = 15_000): Promise<void> {
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const rows = (await probe`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`) as unknown as { n: number }[];
        if (rows[0]!.n >= n) return;
        if (Date.now() > deadline) throw new Error(`fewer than ${n} backends parked on a lock`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await probe.end();
    }
  }

  async function csvOf(recallId: string, token = operatorToken): Promise<Record<string, string>[]> {
    const res = await report(recallId, 'csv', token).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    return csvRecords(res.text);
  }

  function sumOf(rows: Record<string, string>[], section: string, batchCode: string): number {
    return Math.round(rows.filter((row) => row.section === section && row.batch_code === batchCode).reduce((sum, row) => sum + Number(row.quantity), 0) * 1000) / 1000;
  }

  function figureOf(rows: Record<string, string>[], section: 'figure_live' | 'figure_at_close', batchCode: string, figure: string): number {
    const row = rows.find((candidate) => candidate.section === section && candidate.batch_code === batchCode && candidate.location === figure);
    if (row === undefined) throw new Error(`no ${section} ${figure} row for ${batchCode}`);
    return Number(row.quantity);
  }

  // ── the vocabularies and the migration ─────────────────────────────────────

  it('RECALL_MODES and RECALL_STATUSES are exactly the 0101 CHECK vocabularies (TS ↔ DB pin, guide §4); RLS is on both tables', async () => {
    const defs = (await sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conname in ('batch_recalls_mode_check', 'batch_recalls_status_check')`) as unknown as { conname: string; def: string }[];
    const listed = (name: string) => [...defs.find((row) => row.conname === name)!.def.matchAll(/'([a-z]+)'::text/g)].map((match) => match[1]!).sort();
    expect(listed('batch_recalls_mode_check')).toEqual([...RECALL_MODES].sort());
    expect(listed('batch_recalls_status_check')).toEqual([...RECALL_STATUSES].sort());
    const rls = (await sql`select relname, relrowsecurity from pg_class where relname in ('batch_recalls', 'batch_recall_lines') and relkind = 'r' order by relname`) as unknown as { relname: string; relrowsecurity: boolean }[];
    expect(rls).toEqual([
      { relname: 'batch_recall_lines', relrowsecurity: true },
      { relname: 'batch_recalls', relrowsecurity: true },
    ]);
  });

  // ── open ───────────────────────────────────────────────────────────────────

  let rcl1: string;
  let l1: Lot;
  let l2: Lot;

  it('open: two ACME lots (one in WH1 and WH2) → 201 RCL-000001; both blocked `recall` with the code in the note; ATP drops in BOTH warehouses; one opened + two batch.blocked audit rows under the key; replay serves the snapshot, another body is 422', async () => {
    l1 = await seed('RC-OPEN', binA, 10, 'L1');
    await seed('RC-OPEN', binC, 4, 'L1', wh2);
    l2 = await seed('RC-OPEN2', binB, 5, 'L2');
    expect(await atp('RC-OPEN')).toMatchObject({ onHand: 10, atp: 10 });
    expect(await atp('RC-OPEN', wh2)).toMatchObject({ onHand: 4, atp: 4 });

    const key = ulid();
    const body = { batchIds: [l2.id, l1.id], reasonNote: '  Supplier recall: wrong allergen label  ', externalRef: 'ACME-RC-17' };
    const res = await openRecall(body, key).expect(201);
    const recall = res.body.recall as { id: string; code: string; status: string; mode: string; clientId: string; reasonNote: string; lots: { batchId: string; blockedByRecall: boolean }[] };
    rcl1 = recall.id;
    expect(recall).toMatchObject({ code: 'RCL-000001', status: 'open', mode: 'live', clientId: acme, reasonNote: 'Supplier recall: wrong allergen label', externalRef: 'ACME-RC-17' });
    expect(recall.lots.map((lot) => lot.blockedByRecall)).toEqual([true, true]);
    for (const lot of [l1, l2]) {
      expect(await batchRow(lot.id)).toEqual({ status: 'blocked', blocked_reason: 'recall', blocked_note: 'RCL-000001: Supplier recall: wrong allergen label' });
    }
    expect(await atp('RC-OPEN')).toMatchObject({ onHand: 10, atp: 0, unpromisableBatch: 10 });
    expect(await atp('RC-OPEN', wh2)).toMatchObject({ onHand: 4, atp: 0, unpromisableBatch: 4 });
    expect(await atp('RC-OPEN2')).toMatchObject({ onHand: 5, atp: 0 });

    const alongside = [
      { action: 'batch.blocked', targetType: 'batch', targetId: l1.id, actorUserId: opsUserId },
      { action: 'batch.blocked', targetType: 'batch', targetId: l2.id, actorUserId: opsUserId },
    ];
    await expectAuditRow({ tenantId, key, action: 'batch_recall.opened', targetType: 'batch_recall', targetId: rcl1, actorUserId: opsUserId, alongside });
    const blockedAudit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key} and action = 'batch.blocked' and target_id = ${l1.id}`) as unknown as { changes: Record<string, unknown> }[];
    expect(blockedAudit[0]!.changes).toEqual({
      status: { before: 'active', after: 'blocked' },
      reason: { before: null, after: 'recall' },
      note: { before: null, after: 'RCL-000001: Supplier recall: wrong allergen label' },
      recall: { before: null, after: 'RCL-000001' },
    });
    expect(await count(sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'batch_recall.opened' and payload->>'recallId' = ${rcl1}`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'batch.blocked' and payload->>'batchId' in (${l1.id}, ${l2.id})`)).toBe(2);

    // Replay (ids in another order and the note untrimmed hash the same): the snapshot, nothing more.
    const replay = await openRecall({ ...body, batchIds: [l1.id, l2.id] }, key).expect(201);
    expect(replay.body).toEqual(res.body);
    await expectAuditRow({ tenantId, key, action: 'batch_recall.opened', targetType: 'batch_recall', targetId: rcl1, actorUserId: opsUserId, alongside });
    expect((await openRecall({ ...body, reasonNote: 'another reason' }, key).expect(422)).body.code).toBe('idempotency-key-reuse');
  });

  it('the detail lists the lots by warehouse and role with live figures, the batch reads carry the recall code, and an operator may read but not open', async () => {
    const res = await detail(rcl1).expect(200);
    expect(res.body.recall).toMatchObject({ code: 'RCL-000001', clientCode: 'ACME', mode: 'live', status: 'open', openedByName: expect.any(String), timeToReportSeconds: null });
    const lot = (res.body.lots as { batchCode: string; status: string; blockedReason: string; figures: Record<string, number> }[]).find((entry) => entry.batchCode === 'L1')!;
    expect(lot).toMatchObject({ status: 'blocked', blockedReason: 'recall' });
    expect(lot.figures).toEqual({ received: 0, receivedDamaged: 0, onHand: 14, inTransit: 0, heldInOpenOrders: 0, dispatched: 0, returned: 0, returnScrapped: 0, adjustedOut: 0, unaccounted: 0 });
    expect((res.body.onHandByWarehouse as { batchCode: string; role: string; quantity: number }[]).filter((row) => row.batchCode === 'L1').map((row) => [row.role, row.quantity])).toEqual(
      expect.arrayContaining([
        ['storage', 10],
        ['storage', 4],
      ]),
    );
    const bins = await http().get(`${API}/${tenantId}/inventory/recalls/${rcl1}/bins?limit=2`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    expect(bins.body.items).toHaveLength(2);
    expect(bins.body.nextCursor).not.toBeNull();
    const rest = await http().get(`${API}/${tenantId}/inventory/recalls/${rcl1}/bins?limit=2&cursor=${bins.body.nextCursor as string}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    expect(rest.body.items).toHaveLength(1);
    expect(rest.body.nextCursor).toBeNull();
    expect([...bins.body.items, ...rest.body.items].map((row: { binCode: string }) => row.binCode).sort()).toEqual(['A-01-01', 'A-01-02', 'C-01-01']);

    const view = await http().get(`${API}/${tenantId}/inventory/batches/${l1.id}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    expect(view.body.recallCode).toBe('RCL-000001');
    expect((await openRecall({ batchIds: [l1.id], reasonNote: 'x' }, ulid(), operatorToken).expect(403)).body.code).toBe('role-denied');
    // The list, and its filters.
    const list = await http().get(`${API}/${tenantId}/inventory/recalls?externalRef=ACME-RC-17`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    expect((list.body.items as { code: string; lotCount: number; clientCode: string }[]).map((row) => [row.code, row.lotCount, row.clientCode])).toEqual([['RCL-000001', 2, 'ACME']]);
    expect((await http().get(`${API}/${tenantId}/inventory/recalls?code=RCL-000001`).set('Authorization', `Bearer ${operatorToken}`).expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([rcl1]);
    expect((await http().get(`${API}/${tenantId}/inventory/recalls?code=nope`).set('Authorization', `Bearer ${operatorToken}`).expect(400)).body.code).toBe('validation-failed');
    expect((await http().get(`${API}/${tenantId}/inventory/recalls?clientId=${beta}`).set('Authorization', `Bearer ${operatorToken}`).expect(200)).body.items).toEqual([]);
  });

  it('AC1: while the open is parked on a lot lock, a read in another transaction still promises the lot; once it commits, the lot is unpromisable', async () => {
    const lot = await seed('RC-ATP', binA, 6, 'AT-1');
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    let pending: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        await tx`select 1 from batches where id = ${lot.id} for update`;
        pending = (async () => openRecall({ batchIds: [lot.id], reasonNote: 'parked open' }))();
        await waitParked(1);
        expect(await atp('RC-ATP')).toMatchObject({ onHand: 6, atp: 6, unpromisableBatch: 0 });
      });
      expect((await pending!).status).toBe(201);
    } finally {
      await Promise.allSettled([pending]);
      await holder.end();
    }
    expect(await atp('RC-ATP')).toMatchObject({ onHand: 6, atp: 0, unpromisableBatch: 6 });
  });

  it('a lot of another client in the same open is 409 mixed-client; a lot already on an open live recall is 409 batch-already-recalled naming it — neither stores a key', async () => {
    const betaLot = await seedBeta();
    const key = ulid();
    const mixed = await openRecall({ batchIds: [l1.id, betaLot.id], reasonNote: 'mixed' }, key).expect(409);
    expect(mixed.body.code).toBe('mixed-client');
    expect(await keyStored(key)).toBe(false);
    const again = ulid();
    const recalled = await openRecall({ batchIds: [l1.id], reasonNote: 'again' }, again).expect(409);
    expect(recalled.body).toMatchObject({ code: 'batch-already-recalled', recallCodes: ['RCL-000001'] });
    expect(recalled.body.detail).toContain('RCL-000001');
    expect(await keyStored(again)).toBe(false);
    // An unknown batch is 404 naming it; a malformed body is 400.
    const ghost = uuidv7();
    const missing = await openRecall({ batchIds: [ghost], reasonNote: 'ghost' }).expect(404);
    expect(missing.body.detail).toContain(ghost);
    expect((await openRecall({ batchIds: [], reasonNote: 'none' }).expect(400)).body.code).toBe('validation-failed');
    expect((await openRecall({ batchIds: [l1.id, l1.id], reasonNote: 'twice' }).expect(400)).body.code).toBe('validation-failed');
    expect((await openRecall({ batchIds: [l1.id], reasonNote: '   ' }).expect(400)).body.code).toBe('validation-failed');
    expect((await openRecall({ batchIds: [l1.id], reasonNote: 'x', externalRef: 'ü'.repeat(101) }).expect(400)).body.code).toBe('validation-failed');
    expect((await openRecall({ batchIds: [l1.id], reasonNote: 'é'.repeat(501) }).expect(400)).body.code).toBe('validation-failed');
  });

  async function seedBeta(): Promise<Lot> {
    await adjust({ skuId: sku('RB-1'), binId: binD, quantityDelta: 2, batch: { code: 'B-1' } }).expect(201);
    return { id: await batchId('RB-1', 'B-1'), code: 'B-1' };
  }

  let preQc: Lot;

  it('a lot already blocked (qc-failed) keeps its reason (blocked_by_recall false); unblocking ANY lot of an open live recall is 409 batch-under-recall, a mock recall never refuses it', async () => {
    preQc = await seed('RC-PRE', binA, 3, 'P-QC');
    const active = await seed('RC-PREQ', binA, 3, 'P-OK');
    await block(preQc.id, { reason: 'qc-failed', note: 'lab report 9' }).expect(201);
    const res = await openRecall({ batchIds: [preQc.id, active.id], reasonNote: 'mixed states' }).expect(201);
    const lines = res.body.recall.lots as { batchId: string; blockedByRecall: boolean }[];
    expect(lines.find((line) => line.batchId === preQc.id)!.blockedByRecall).toBe(false);
    expect(lines.find((line) => line.batchId === active.id)!.blockedByRecall).toBe(true);
    expect(await batchRow(preQc.id)).toEqual({ status: 'blocked', blocked_reason: 'qc-failed', blocked_note: 'lab report 9' });
    const refused = await unblock(preQc.id, 'QC re-test passed').expect(409);
    expect(refused.body).toMatchObject({ code: 'batch-under-recall', recallCode: res.body.recall.code });
    expect(refused.body.detail).toContain(`release it from the recall`);
    expect((await unblock(l1.id, 'supplier withdrew').expect(409)).body.code).toBe('batch-under-recall');
  });

  // ── held orders and dispatch ───────────────────────────────────────────────

  it('a packed order holding the lot is listed held and dispatch refuses it (409 order-holds-recalled-batch); an order of another lot ships; a lot blocked for another reason still ships', async () => {
    await seed('RC-HELD', binA, 5, 'H1');
    await seed('RC-OTHER', binA, 5, 'O1');
    await seed('RC-QCB', binA, 5, 'Q1');
    const held = await packedOrder('RC-HELD', 3, { clientOrderRef: 'ACME-PO-HELD' });
    const other = await packedOrder('RC-OTHER', 2);
    const otherBlock = await packedOrder('RC-QCB', 1);
    const h1 = await batchId('RC-HELD', 'H1');
    const recall = await openRecall({ batchIds: [h1], reasonNote: 'held order' }).expect(201);
    const code = recall.body.recall.code as string;

    const view = await detail(recall.body.recall.id as string).expect(200);
    expect(view.body.heldOrders).toEqual([
      expect.objectContaining({ orderId: held, orderLabel: 'ACME-PO-HELD', clientOrderRef: 'ACME-PO-HELD', status: 'ready_to_dispatch', batchCode: 'H1', quantity: 3 }),
    ]);
    expect(view.body.lots[0].figures).toMatchObject({ onHand: 2, heldInOpenOrders: 3, dispatched: 0 });

    const key = ulid();
    const refused = await dispatch(held, key).expect(409);
    expect(refused.body).toMatchObject({ code: 'order-holds-recalled-batch', batchCodes: ['H1'], recallCodes: [code] });
    expect(refused.body.detail).toMatch(/release the lot from the recall/i);
    expect(await keyStored(key)).toBe(false);
    expect((await sql`select status from orders where id = ${held}`)[0]!.status).toBe('ready_to_dispatch');
    await dispatch(other).expect(201);
    // A non-recall block (expiry-review) never stops a dispatch (A2).
    await block(await batchId('RC-QCB', 'Q1'), { reason: 'expiry-review' }).expect(201);
    await dispatch(otherBlock).expect(201);
  });

  // ── a pick in a bin holding a recalled lot (A13) ───────────────────────────

  it('a pick at a bin holding a recalled lot beside a good one is 409 recalled-lot-in-bin (never re-derived); the planned task is listed; once the recalled units are moved out, the pick draws', async () => {
    const recalledLot = await seed('RC-MIX', binA, 2, 'M-R', wh, 400);
    await seed('RC-MIX', binA, 5, 'M-G', wh, 300);
    const recall = await openRecall({ batchIds: [recalledLot.id], reasonNote: 'mixed bin' }).expect(201);
    // The wave plans the good lot in A-01-01 (the recalled one is blocked).
    const { picklist } = await fixtures.releasedWave([{ skuId: sku('RC-MIX'), quantity: 2 }]);
    const line = picklist.lines[0]!;
    expect(line.binId).toBe(binA);
    const view = await detail(recall.body.recall.id as string).expect(200);
    expect(view.body.plannedPicks).toEqual([expect.objectContaining({ picklistLineId: line.id, binCode: 'A-01-01', skuCode: 'RC-MIX', quantity: 2 })]);
    const pickBody = { warehouseId: wh, picklistId: line.picklistId, picklistLineId: line.id, skuId: line.skuId, binId: binA, qty: 2, occurredAt: nowZ() };
    const key = ulid();
    const refused = await http().post(`${API}/${tenantId}/outbound/picks`).set('Authorization', `Bearer ${deviceOperatorToken}`).set(KEY_HEADER, key).send(pickBody).expect(409);
    expect(refused.body).toMatchObject({ code: 'recalled-lot-in-bin', binCode: 'A-01-01', batchCodes: ['M-R'], recallCodes: [recall.body.recall.code] });
    expect(await keyStored(key)).toBe(false);
    // The remedy: move the recalled units out (a move of a blocked lot is allowed), then pick.
    await http()
      .post(`${API}/${tenantId}/warehouses/${wh}/inventory/moves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ skuId: sku('RC-MIX'), fromBinId: binA, toBinId: binD, qty: 2, batchCode: 'M-R', reasonCode: 'make-room' })
      .expect(201);
    const picked = await http().post(`${API}/${tenantId}/outbound/picks`).set('Authorization', `Bearer ${deviceOperatorToken}`).set(KEY_HEADER, ulid()).send(pickBody).expect(201);
    expect(picked.body.pick.batchId).toBe(await batchId('RC-MIX', 'M-G'));
  });

  // ── close ──────────────────────────────────────────────────────────────────

  it('close: only lots THIS recall blocked are releasable (409 recall-release-not-eligible); stock needs an override (409 recall-release-has-stock); the override releases with its reason audited; the summary freezes; a re-close is 409 recall-not-open', async () => {
    const a = await seed('RC-CL', binA, 2, 'CL-A');
    const b = await seed('RC-CL', binA, 1, 'CL-B');
    const c = await seed('RC-CL', binB, 1, 'CL-C');
    await block(b.id, { reason: 'contamination' }).expect(201);
    const opened = await openRecall({ batchIds: [a.id, b.id, c.id], reasonNote: 'close suite' }).expect(201);
    const recallId = opened.body.recall.id as string;
    const code = opened.body.recall.code as string;
    // C is written off entirely (a named blocked batch needs an override — 3-3a).
    await adjust({ skuId: sku('RC-CL'), binId: binB, quantityDelta: -1, reasonCode: 'recall', batch: { code: 'CL-C', overrideReason: 'recalled — destroy' } }).expect(201);

    const notEligible = await closeRecall(recallId, { note: 'done', releaseBatchIds: [b.id] }).expect(409);
    expect(notEligible.body).toMatchObject({ code: 'recall-release-not-eligible', batchCodes: ['CL-B'] });
    const withStock = await closeRecall(recallId, { note: 'done', releaseBatchIds: [a.id, c.id] }).expect(409);
    expect(withStock.body).toMatchObject({ code: 'recall-release-has-stock', batchCodes: ['CL-A'] });
    expect((await closeRecall(recallId, { note: 'done', releaseBatchIds: [uuidv7()] }).expect(409)).body.code).toBe('recall-batch-not-on-recall');

    const key = ulid();
    const closeBody = {
      note: ' Supplier confirmed only CL-C was affected ',
      releaseBatchIds: [c.id, a.id],
      overrideReason: 'CL-A re-tested clean by the supplier lab',
      dispositionNotes: [{ batchId: c.id, note: 'destroyed under certificate D-55' }],
      evidenceRef: 'CERT-D-55',
    };
    const closed = await closeRecall(recallId, closeBody, key).expect(201);
    expect(closed.body.recall).toMatchObject({ status: 'closed', closeNote: 'Supplier confirmed only CL-C was affected' });
    expect([...(closed.body.recall.releasedBatchIds as string[])].sort()).toEqual([a.id, c.id].sort());
    expect((await batchRow(a.id)).status).toBe('active');
    expect((await batchRow(c.id)).status).toBe('active');
    expect(await batchRow(b.id)).toMatchObject({ status: 'blocked', blocked_reason: 'contamination' });
    const summary = closed.body.recall.closeSummary as { v: number; lots: { batchCode: string; released: boolean; overrideReason: string | null; dispositionNote: string | null; figures: Record<string, number>; adjustedOutByReason: Record<string, number> }[]; evidenceRef: string; acknowledgedUnaccounted: boolean };
    expect(summary).toMatchObject({ v: 1, evidenceRef: 'CERT-D-55', acknowledgedUnaccounted: false });
    expect(summary.lots.map((lot) => [lot.batchCode, lot.released, lot.overrideReason, lot.dispositionNote])).toEqual([
      ['CL-A', true, 'CL-A re-tested clean by the supplier lab', null],
      ['CL-B', false, null, null],
      ['CL-C', true, 'CL-A re-tested clean by the supplier lab', 'destroyed under certificate D-55'],
    ]);
    expect(summary.lots[2]!.figures).toMatchObject({ onHand: 0, adjustedOut: 1 });
    expect(summary.lots[2]!.adjustedOutByReason).toEqual({ recall: 1 });

    await expectAuditRow({
      tenantId,
      key,
      action: 'batch_recall.closed',
      targetType: 'batch_recall',
      targetId: recallId,
      actorUserId: opsUserId,
      alongside: [
        { action: 'batch.unblocked', targetType: 'batch', targetId: a.id, actorUserId: opsUserId },
        { action: 'batch.unblocked', targetType: 'batch', targetId: c.id, actorUserId: opsUserId },
      ],
    });
    const unblocked = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key} and action = 'batch.unblocked' and target_id = ${a.id}`) as unknown as { changes: Record<string, { before: unknown; after: unknown }> }[];
    expect(unblocked[0]!.changes.overrideReason).toEqual({ before: null, after: 'CL-A re-tested clean by the supplier lab' });
    expect(unblocked[0]!.changes.recall).toEqual({ before: code, after: null });
    expect(unblocked[0]!.changes.note!.after).toBe(`${code} closed: Supplier confirmed only CL-C was affected`);

    // The replay re-serves; a re-close under a new key is 409 and stores no key.
    expect((await closeRecall(recallId, closeBody, key).expect(201)).body).toEqual(closed.body);
    const again = ulid();
    expect((await closeRecall(recallId, { note: 'again' }, again).expect(409)).body.code).toBe('recall-not-open');
    expect(await keyStored(again)).toBe(false);
    expect((await addBatches(recallId, [l2.id]).expect(409)).body.code).toBe('recall-not-open');
    // A released lot is unblockable no more (it is active); B, still blocked, is unblockable through 3-3a now.
    await unblock(b.id, 'contamination cleared').expect(201);

    // The summary is frozen: a later write-off changes the live figures only.
    await adjust({ skuId: sku('RC-CL'), binId: binA, quantityDelta: -1, reasonCode: 'damaged', batch: { code: 'CL-A', overrideReason: 'post-close write-off' } }).expect(201);
    const view = await detail(recallId).expect(200);
    const lotA = (view.body.lots as { batchCode: string; figures: Record<string, number>; closeFigures: Record<string, number> }[]).find((lot) => lot.batchCode === 'CL-A')!;
    expect(lotA.figures.onHand).toBe(1);
    expect(lotA.closeFigures.onHand).toBe(2);
  });

  it('a close whose lot does not reconcile (the projection diverged) needs acknowledgeUnaccounted (409 recall-unaccounted), which the summary records', async () => {
    const u = await seed('RC-UNA', binA, 3, 'U-1');
    const opened = await openRecall({ batchIds: [u.id], reasonNote: 'diverged' }).expect(201);
    const recallId = opened.body.recall.id as string;
    await sql`update batch_on_hand set quantity = quantity + 1000 where tenant_id = ${tenantId} and batch_id = ${u.id}`;
    try {
      expect((await detail(recallId).expect(200)).body.lots[0].figures.unaccounted).toBe(-1);
      const refused = await closeRecall(recallId, { note: 'close' }).expect(409);
      expect(refused.body).toMatchObject({ code: 'recall-unaccounted', batchCodes: ['U-1'] });
      const closed = await closeRecall(recallId, { note: 'close', acknowledgeUnaccounted: true }).expect(201);
      expect(closed.body.recall.closeSummary.acknowledgedUnaccounted).toBe(true);
      expect(closed.body.recall.closeSummary.lots[0].figures.unaccounted).toBe(-1);
    } finally {
      await sql`update batch_on_hand set quantity = quantity - 1000 where tenant_id = ${tenantId} and batch_id = ${u.id}`;
    }
  });

  it('in transit: a lot moved WH1 → WH2 and not yet confirmed is `inTransit`, with an in_transit row; confirming it at WH2 keeps it blocked', async () => {
    const t = await seed('RC-TRN', binA, 5, 'T-1');
    const transfer = await http()
      .post(`${API}/${tenantId}/movements/transfers`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ sourceWarehouseId: wh, destWarehouseId: wh2, lines: [{ skuId: sku('RC-TRN'), quantity: 3, fromBinId: binA, toBinId: binC, batchId: t.id }] })
      .expect(201);
    const transferId = transfer.body.transfer.id as string;
    await http().post(`${API}/${tenantId}/movements/transfers/${transferId}/outbound-confirm`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
    const opened = await openRecall({ batchIds: [t.id], reasonNote: 'in transit' }).expect(201);
    const recallId = opened.body.recall.id as string;
    expect((await detail(recallId).expect(200)).body.lots[0].figures).toMatchObject({ onHand: 2, inTransit: 3, unaccounted: 0 });
    const rows = await csvOf(recallId);
    expect(sumOf(rows, 'in_transit', 'T-1')).toBe(3);
    expect(rows.find((row) => row.section === 'in_transit')!.location).toBe('IN-TRANSIT');
    await http().post(`${API}/${tenantId}/movements/transfers/${transferId}/inbound-confirm`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
    expect((await batchRow(t.id)).status).toBe('blocked');
    expect((await detail(recallId).expect(200)).body.lots[0].figures).toMatchObject({ onHand: 5, inTransit: 0, unaccounted: 0 });
  });

  // ── candidates and add batches (A9, A14) ───────────────────────────────────

  it('candidates match the normalised lot code (exact / normalised) within the client only; a matching batch off an open recall names it; add batches blocks it; mixed client and an already-recalled lot are 409', async () => {
    const n1 = await seed('RC-N1', binB, 2, 'AB123');
    const n2 = await seed('RC-N2', binB, 3, 'ab-12/3');
    await adjust({ skuId: sku('RB-N'), binId: binD, quantityDelta: 1, batch: { code: 'AB123' } }).expect(201);
    const search = (code: string) =>
      http().get(`${API}/${tenantId}/inventory/recalls/candidates?clientId=${acme}&code=${encodeURIComponent(code)}`).set('Authorization', `Bearer ${operatorToken}`);
    const found = await search('ab-12/3').expect(200);
    expect(found.body.normalisedCode).toBe('AB123');
    expect((found.body.items as { batchCode: string; skuCode: string; match: string; onHand: number; onRecall: unknown; sameCodeOnOpenRecall: unknown }[]).map((row) => [row.skuCode, row.batchCode, row.match, row.onHand, row.onRecall, row.sameCodeOnOpenRecall])).toEqual([
      ['RC-N1', 'AB123', 'normalised', 2, null, null],
      ['RC-N2', 'ab-12/3', 'exact', 3, null, null],
    ]);
    expect((await search('--').expect(400)).body.code).toBe('validation-failed');

    const opened = await openRecall({ batchIds: [n2.id], reasonNote: 'label variant' }).expect(201);
    const recallId = opened.body.recall.id as string;
    const code = opened.body.recall.code as string;
    const flagged = await search('AB 123').expect(200);
    const rows = flagged.body.items as { batchId: string; onRecall: { code: string } | null; sameCodeOnOpenRecall: string | null }[];
    expect(rows.find((row) => row.batchId === n1.id)).toMatchObject({ onRecall: null, sameCodeOnOpenRecall: code });
    expect(rows.find((row) => row.batchId === n2.id)!.onRecall).toMatchObject({ code });

    const key = ulid();
    const added = await addBatches(recallId, [n1.id], key).expect(201);
    expect((added.body.recall.lots as unknown[]).length).toBe(2);
    expect((await batchRow(n1.id)).status).toBe('blocked');
    await expectAuditRow({
      tenantId,
      key,
      action: 'batch_recall.batches_added',
      targetType: 'batch_recall',
      targetId: recallId,
      actorUserId: opsUserId,
      alongside: [{ action: 'batch.blocked', targetType: 'batch', targetId: n1.id, actorUserId: opsUserId }],
    });
    expect((await addBatches(recallId, [n1.id], key).expect(201)).body).toEqual(added.body);
    expect((await addBatches(recallId, [n1.id]).expect(409)).body.code).toBe('batch-already-recalled');
    expect((await addBatches(recallId, [await batchId('RB-N', 'AB123')]).expect(409)).body.code).toBe('mixed-client');
    expect((await addBatches(recallId, [l1.id]).expect(409)).body).toMatchObject({ code: 'batch-already-recalled', recallCodes: ['RCL-000001'] });
  });

  // ── mock recalls (A16) ─────────────────────────────────────────────────────

  it('a mock recall blocks nothing: the lot stays active and promisable, it picks and ships, a second mock may name it; the report is labelled MOCK', async () => {
    const k = await seed('RC-MOCK', binA, 4, 'K-1');
    const mock = await openRecall({ batchIds: [k.id], reasonNote: 'drill', mode: 'mock' }).expect(201);
    expect(mock.body.recall).toMatchObject({ mode: 'mock' });
    expect(mock.body.recall.lots[0].blockedByRecall).toBe(false);
    expect((await batchRow(k.id)).status).toBe('active');
    expect(await atp('RC-MOCK')).toMatchObject({ atp: 4 });
    await openRecall({ batchIds: [k.id], reasonNote: 'second drill', mode: 'mock' }).expect(201);
    const orderId = await packedOrder('RC-MOCK', 1);
    await dispatch(orderId).expect(201);
    const rows = await csvOf(mock.body.recall.id as string);
    expect(rows.find((row) => row.meta_field === 'mode')!.meta_value).toMatch(/^MOCK/);
    expect(sumOf(rows, 'dispatched', 'K-1')).toBe(1);
  });

  // ── locks (A15) ────────────────────────────────────────────────────────────

  it('an open that waits on a held lot row past 5 s is 503 recall-open-contended — nothing written, no key', async () => {
    const lot = await seed('RC-LOCK', binA, 1, 'LK-1');
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    const key = ulid();
    try {
      await holder.begin(async (tx) => {
        await tx`select 1 from batches where id = ${lot.id} for update`;
        const res = await openRecall({ batchIds: [lot.id], reasonNote: 'contended' }, key);
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('recall-open-contended');
      });
    } finally {
      await holder.end();
    }
    expect(await keyStored(key)).toBe(false);
    expect((await batchRow(lot.id)).status).toBe('active');
    expect(await count(sql`select count(*)::int as n from batch_recall_lines where tenant_id = ${tenantId} and batch_id = ${lot.id}`)).toBe(0);
  });

  it('race — a recall commits first: a dispatch parked on the lot lock wakes to the open recall and answers 409', async () => {
    await seed('RC-RACE1', binA, 3, 'RA-1');
    const orderId = await packedOrder('RC-RACE1', 2);
    const lot = await batchId('RC-RACE1', 'RA-1');
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    let pending: Promise<request.Response> | undefined;
    try {
      // The holder IS a recall in flight: it locks the lot and writes the recall's rows.
      await holder.begin(async (tx) => {
        await tx`select 1 from batches where id = ${lot} for update`;
        const recallId = uuidv7();
        await tx`insert into batch_recalls (id, tenant_id, client_id, code, mode, status, reason_note, opened_at, opened_by)
          values (${recallId}, ${tenantId}, ${acme}, 'RCL-800001', 'live', 'open', 'race', now(), ${ownerUserId})`;
        await tx`insert into batch_recall_lines (id, tenant_id, recall_id, batch_id, sku_id, batch_code, blocked_by_recall)
          values (${uuidv7()}, ${tenantId}, ${recallId}, ${lot}, ${sku('RC-RACE1')}, 'RA-1', false)`;
        pending = (async () => dispatch(orderId))();
        await waitParked(1);
      });
      const res = await pending!;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'order-holds-recalled-batch', recallCodes: ['RCL-800001'] });
    } finally {
      await Promise.allSettled([pending]);
      await holder.end();
    }
  });

  it('race — a dispatch holds the lot first: the open waits for it, the order ships, and it appears in the recall’s dispatched trace', async () => {
    await seed('RC-RACE2', binA, 3, 'RB-2');
    const orderId = await packedOrder('RC-RACE2', 2, { clientOrderRef: 'ACME-RACE-2' });
    const lot = await batchId('RC-RACE2', 'RB-2');
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    let shipping: Promise<request.Response> | undefined;
    let opening: Promise<request.Response> | undefined;
    try {
      // The warehouse advisory: the dispatch takes the order row and the lot's
      // key share, then parks inside its first ledger append.
      await holder.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':' || ${wh}, 0))`;
        shipping = (async () => dispatch(orderId))();
        await waitParked(1);
        opening = (async () => openRecall({ batchIds: [lot], reasonNote: 'arrives during a dispatch' }))();
        await waitParked(2);
      });
      const shipped = await shipping!;
      const opened = await opening!;
      expect([shipped.status, opened.status]).toEqual([201, 201]);
      const recallId = opened.body.recall.id as string;
      const shipments = await http().get(`${API}/${tenantId}/inventory/recalls/${recallId}/shipments`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
      expect(shipments.body.items).toEqual([expect.objectContaining({ orderId, orderLabel: 'ACME-RACE-2', batchCode: 'RB-2', quantity: 2, carrier: 'BlueDart', duringRecall: false })]);
    } finally {
      await Promise.allSettled([shipping, opening]);
      await holder.end();
    }
  });

  it('race — a pick holds the lot’s key share: the open waits and commits after it; held past 5 s the open is 503', async () => {
    const lot = await seed('RC-PICKR', binA, 6, 'PR-1');
    const { picklist: first } = await fixtures.releasedWave([{ skuId: sku('RC-PICKR'), quantity: 1 }]);
    const { picklist: second } = await fixtures.releasedWave([{ skuId: sku('RC-PICKR'), quantity: 1 }]);
    const pickOf = (line: (typeof first.lines)[number]) =>
      (async () =>
        http()
          .post(`${API}/${tenantId}/outbound/picks`)
          .set('Authorization', `Bearer ${deviceOperatorToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId: wh, picklistId: line.picklistId, picklistLineId: line.id, skuId: line.skuId, binId: line.binId!, qty: line.qty, occurredAt: nowZ() }))();
    const holdAdvisory = async (then: () => Promise<void>): Promise<void> => {
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      try {
        await holder.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':' || ${wh}, 0))`;
          await then();
        });
      } finally {
        await holder.end();
      }
    };
    // Held past 5 s: 503, no key.
    let picking: Promise<request.Response> | undefined;
    const contendedKey = ulid();
    await holdAdvisory(async () => {
      picking = pickOf(first.lines[0]!);
      await waitParked(1);
      const res = await openRecall({ batchIds: [lot.id], reasonNote: 'contended by a pick' }, contendedKey);
      expect([res.status, res.body.code]).toEqual([503, 'recall-open-contended']);
    });
    expect((await picking!).status).toBe(201);
    expect(await keyStored(contendedKey)).toBe(false);
    // Released in time: the pick commits, then the open.
    let opening: Promise<request.Response> | undefined;
    await holdAdvisory(async () => {
      picking = pickOf(second.lines[0]!);
      await waitParked(1);
      opening = (async () => openRecall({ batchIds: [lot.id], reasonNote: 'after a pick' }))();
      await waitParked(2);
    });
    expect((await picking!).status).toBe(201);
    expect((await opening!).status).toBe(201);
  });

  it('same-key races: two identical opens, adds and closes parked on their lock answer the same body — one effect, one key', async () => {
    const parkedTwice = async (lockSql: string, lockId: string, fire: () => Promise<request.Response>): Promise<[request.Response, request.Response]> => {
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let a: Promise<request.Response> | undefined;
      let b: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          await tx.unsafe(lockSql, [lockId]);
          a = fire();
          b = fire();
          await waitParked(2);
        });
        const both = await Promise.all([a!, b!]);
        return [both[0], both[1]];
      } finally {
        await Promise.allSettled([a, b]);
        await holder.end();
      }
    };
    const lot = await seed('RC-SK1', binA, 1, 'SK-1');
    const openKey = ulid();
    const [o1, o2] = await parkedTwice('select 1 from batches where id = $1 for update', lot.id, () => (async () => openRecall({ batchIds: [lot.id], reasonNote: 'same key' }, openKey))());
    expect([o1.status, o2.status]).toEqual([201, 201]);
    expect(o2.body).toEqual(o1.body);
    expect(await count(sql`select count(*)::int as n from batch_recall_lines where tenant_id = ${tenantId} and batch_id = ${lot.id}`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${openKey}`)).toBe(2);
    const recallId = o1.body.recall.id as string;

    const more = await seed('RC-SK2', binA, 1, 'SK-2');
    const addKey = ulid();
    const [a1, a2] = await parkedTwice('select 1 from batch_recalls where id = $1 for update', recallId, () => (async () => addBatches(recallId, [more.id], addKey))());
    expect([a1.status, a2.status]).toEqual([201, 201]);
    expect(a2.body).toEqual(a1.body);
    expect(await count(sql`select count(*)::int as n from batch_recall_lines where tenant_id = ${tenantId} and recall_id = ${recallId}`)).toBe(2);

    const closeKey = ulid();
    const [c1, c2] = await parkedTwice('select 1 from batch_recalls where id = $1 for update', recallId, () => (async () => closeRecall(recallId, { note: 'same key close' }, closeKey))());
    expect([c1.status, c2.status]).toEqual([201, 201]);
    expect(c2.body).toEqual(c1.body);
    expect(await count(sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${closeKey}`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key in (${openKey}, ${addKey}, ${closeKey})`)).toBe(3);
  });

  // ── receiving into a recalled lot (A14) ────────────────────────────────────

  it('a receipt into a recalled lot is booked, the lot stays blocked, the response names it (recalledLots), the GRN lines carry its recall code and the trace marks it during the recall', async () => {
    const res = await http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: wh,
        poId: null,
        clientId: acme,
        blindReasonCode: 'unannounced-delivery',
        occurredAt: nowZ(),
        lines: [{ poLineId: null, skuId: sku('RC-OPEN'), batchCode: 'L1', mfgDate: null, qty: 4, damagedQty: 1, damageReasonCode: 'crushed' }],
      });
    expect([res.status, res.body.detail]).toEqual([201, undefined]);
    expect(res.body.goodsReceipt.recalledLots).toEqual([{ batchId: l1.id, batchCode: 'L1', recallCode: 'RCL-000001' }]);
    expect((await batchRow(l1.id)).status).toBe('blocked');
    const lines = await http().get(`${API}/${tenantId}/receiving/goods-receipts/${res.body.goodsReceipt.id as string}/lines`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    expect(lines.body.items[0].recallCode).toBe('RCL-000001');
    const receipts = await http().get(`${API}/${tenantId}/inventory/recalls/${rcl1}/receipts`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    expect(receipts.body.items).toEqual([expect.objectContaining({ grnCode: res.body.goodsReceipt.code, batchCode: 'L1', quantity: 4, duringRecall: true, vendorName: null })]);
    const view = await detail(rcl1).expect(200);
    expect((view.body.lots as { batchCode: string; figures: Record<string, number> }[]).find((lot) => lot.batchCode === 'L1')!.figures).toMatchObject({ received: 4, receivedDamaged: 1, onHand: 19, unaccounted: 0 });
  });

  // ── the figures equal their rows (B19) ─────────────────────────────────────

  it('B19: in one snapshot every figure equals its section’s sum — a multi-batch pick (picks.batch_id null), a dispatched and a held order, a receipt with damage, a return, a scrap and a write-off', async () => {
    const x = await seed('RC-B19', binA, 5, 'BX', wh, 100);
    // Order 1 is planned as ONE slice of 5 BX at A-01-01; then 3 BX move away and
    // 3 BY arrive, so the pick re-derives FEFO in the bin as 2 BX + 3 BY — one
    // pick spanning two batches (`picks.batch_id` null).
    const planned = await fixtures.releasedWave([{ skuId: sku('RC-B19'), quantity: 5 }], { clientOrderRef: 'B19-SHIP' });
    expect(planned.picklist.lines).toHaveLength(1);
    await http()
      .post(`${API}/${tenantId}/warehouses/${wh}/inventory/moves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ skuId: sku('RC-B19'), fromBinId: binA, toBinId: binB, qty: 3, batchCode: 'BX', reasonCode: 'make-room' })
      .expect(201);
    const y = await seed('RC-B19', binA, 3, 'BY', wh, 200);
    await fixtures.pickAllLines(planned.picklist);
    await pack(planned.orderId, [{ skuId: sku('RC-B19'), qty: 5 }]);
    const shipped = planned.orderId;
    const pickRow = (await sql`select batch_id from picks where tenant_id = ${tenantId} and order_id = ${shipped}`) as unknown as { batch_id: string | null }[];
    expect(pickRow.map((row) => row.batch_id)).toEqual([null]);
    await dispatch(shipped).expect(201);
    // A return of 2 into RETURNS, then a scrap of one (4-7a).
    const returnable = await http().get(`${API}/${tenantId}/returns/returnable?orderId=${shipped}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const orderLineId = (returnable.body.lines as { orderLineId: string }[])[0]!.orderLineId;
    const rma = await http().post(`${API}/${tenantId}/returns`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ orderId: shipped, lines: [{ orderLineId, qty: 2, reasonCode: 'damaged' }] }).expect(201);
    await http()
      .post(`${API}/${tenantId}/returns/receipts`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, rmaId: rma.body.id as string, occurredAt: nowZ(), entries: [{ rmaLineId: rma.body.lines[0].id as string, skuId: sku('RC-B19'), qty: 2, condition: 'resaleable', batchCode: 'BY' }] })
      .expect(201);
    const rmaView = (await http().get(`${API}/${tenantId}/returns/${rma.body.id as string}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body as { receipts: { lines: { id: string }[] }[] };
    const receiptLineId = rmaView.receipts.flatMap((receipt) => receipt.lines)[0]!.id;
    // A held order (picked + packed, not dispatched), before the recall.
    const held = await packedOrder('RC-B19', 1, { clientOrderRef: 'B19-HELD' });
    // A write-off of 1 BX (the only lot in A-01-02).
    const writeOff = await adjust({ skuId: sku('RC-B19'), binId: binB, quantityDelta: -1, reasonCode: 'damaged', batch: { code: 'BX', overrideReason: 'crushed in storage' } });
    expect([writeOff.status, writeOff.body.detail]).toEqual([201, undefined]);
    // A receipt of BY with damage.
    await http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, poId: null, clientId: acme, blindReasonCode: 'unannounced-delivery', occurredAt: nowZ(), lines: [{ poLineId: null, skuId: sku('RC-B19'), batchCode: 'BY', mfgDate: null, qty: 2, damagedQty: 1, damageReasonCode: 'crushed' }] })
      .expect(201);
    // Scrap 1 of the 2 returned units (4-7a): the trace stops there for it.
    await http()
      .post(`${API}/${tenantId}/returns/dispositions`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, receiptLineId, outcome: 'scrap', qty: 1, reasonCode: 'damaged' })
      .expect(201);

    const opened = await openRecall({ batchIds: [x.id, y.id], reasonNote: 'B19' }).expect(201);
    const recallId = opened.body.recall.id as string;
    const rows = await csvOf(recallId);
    const view = await detail(recallId).expect(200);
    for (const code of ['BX', 'BY']) {
      const live = (view.body.lots as { batchCode: string; figures: Record<string, number> }[]).find((lot) => lot.batchCode === code)!.figures;
      expect(figureOf(rows, 'figure_live', code, 'on_hand')).toBe(live.onHand);
      expect(sumOf(rows, 'on_hand', code)).toBe(live.onHand);
      expect(sumOf(rows, 'in_transit', code)).toBe(live.inTransit);
      expect(sumOf(rows, 'held_in_open_order', code)).toBe(live.heldInOpenOrders);
      expect(sumOf(rows, 'dispatched', code)).toBe(live.dispatched);
      expect(sumOf(rows, 'received', code)).toBe(live.received);
      expect(sumOf(rows, 'received_damaged', code)).toBe(live.receivedDamaged);
      expect(sumOf(rows, 'returned', code)).toBe(live.returned);
      expect(sumOf(rows, 'return_scrapped', code)).toBe(live.returnScrapped);
      expect(sumOf(rows, 'adjusted_out', code)).toBe(live.adjustedOut);
      expect(live.unaccounted).toBe(0);
    }
    const bx = (view.body.lots as { batchCode: string; figures: Record<string, number> }[]).find((lot) => lot.batchCode === 'BX')!.figures;
    const by = (view.body.lots as { batchCode: string; figures: Record<string, number> }[]).find((lot) => lot.batchCode === 'BY')!.figures;
    // The shipped order's one pick drew 2 BX + 3 BY; the held order drew 1 BY.
    expect([bx.dispatched, by.dispatched]).toEqual([2, 3]);
    expect(bx.heldInOpenOrders! + by.heldInOpenOrders!).toBe(1);
    expect(bx.adjustedOut).toBe(1);
    expect(by.returned).toBe(2);
    expect(by.returnScrapped).toBe(1);
    expect(by.received).toBe(2);
    expect(by.receivedDamaged).toBe(1);
    // The dispatched rows carry the order, the consignee and the destination; no contact field exists.
    const shippedRows = rows.filter((row) => row.section === 'dispatched');
    expect(shippedRows.every((row) => row.client_order_ref === 'B19-SHIP' && row.carrier === 'BlueDart' && (row.awb ?? '').startsWith('AWB-') && row.destination_pincode !== '')).toBe(true);
    expect(rows.filter((row) => row.section === 'held_in_open_order').map((row) => row.client_order_ref)).toEqual(['B19-HELD']);
    expect(held).toEqual(expect.any(String));
    for (const forbidden of ['contact', 'phone', 'line1', 'address']) {
      expect(Object.keys(rows[0]!).some((header) => header.includes(forbidden))).toBe(false);
    }
  });

  // ── A7: every ledger type on one batch, unaccounted 0 ──────────────────────

  it('A7: a batch moved through every registered ledger type (a transfer left in transit) folds to unaccounted = 0', async () => {
    const lot = await seed('RC-ALL', binA, 5, 'ALL-1');
    await withTenantTransaction(db, tenantId, async (tx) => {
      await ensureReceivingBinInTx(tx, tenantId, wh);
      await ensureQcHoldBinInTx(tx, tenantId, wh);
      await ensureInTransitBinInTx(tx, tenantId, wh);
      await ensureReturnsBinInTx(tx, tenantId, wh);
      await ensureDamagedBinInTx(tx, tenantId, wh);
    });
    const bins = (await sql`select id, code from bins where tenant_id = ${tenantId} and warehouse_id = ${wh} and system_owned`) as unknown as { id: string; code: string }[];
    const system = (code: string) => bins.find((row) => row.code === code)!.id;
    const at = nowZ();
    const base = { tenantId, warehouseId: wh, skuId: sku('RC-ALL'), serialRef: null, actorUserId: ownerUserId, occurredAt: at, recordedAt: at };
    type Doc = Parameters<InventoryFacade['appendLedgerEventInTx']>[1]['referenceDoc'];
    const move = (type: string, qty: number, from: string | null, to: string | null, referenceDoc: Doc, batch: string | null = lot.id) =>
      // A pure draw (a from arm only) is journalled negative, every other shape positive — the writers' convention.
      ({ ...base, type, quantityDelta: signedQuantity((from !== null && to === null ? -qty : qty) * SCALE), fromBinId: from, toBinId: to, batchRef: batch, referenceDoc });
    const grnId = uuidv7();
    const holdId = uuidv7();
    const orderId = uuidv7();
    const orderLineId = uuidv7();
    await withTenantTransaction(db, tenantId, async (tx) => {
      const events = [
        move('grn.received', 4, null, system('RECEIVING'), { kind: 'grn-receipt', grnId }),
        move('grn.damaged', 1, null, system('DAMAGED'), { kind: 'grn-receipt', grnId, grnLineId: uuidv7() }),
        move('putaway.placed', 4, system('RECEIVING'), binA, { kind: 'putaway', grnId, grnLineId: uuidv7() }),
        move('qc.held', 2, binA, system('QC-HOLD'), { kind: 'qc-hold', holdId, fromBinId: binA }),
        move('qc.released', 1, system('QC-HOLD'), binA, { kind: 'qc-hold', holdId }),
        move('qc.failed', 1, system('QC-HOLD'), system('DAMAGED'), { kind: 'qc-hold', holdId, inspectionId: uuidv7() }),
        move('bin.merged', 1, binA, binB, { kind: 'bin-merge', mergeId: uuidv7() }),
        move('stock.moved', 1, binB, binA, { kind: 'bin-move', moveId: uuidv7(), reasonCode: 'consolidate' }),
        move('pick.picked', 1, binA, null, { kind: 'pick', picklistId: uuidv7(), picklistLineId: uuidv7(), waveId: uuidv7(), orderId, orderLineId }),
        move('pack.packed', 0, null, null, { kind: 'pack', orderId, orderLineId, packedQty: 1 }, null),
        move('dispatch.dispatched', 0, null, null, { kind: 'dispatch', orderId, orderLineId, dispatchedQty: 1 }, null),
        move('excursion.recorded', 0, null, null, { kind: 'excursion', excursionId: uuidv7(), binId: binA, readingC: 9 }, null),
        move('return.received', 2, null, system('RETURNS'), { kind: 'return-receipt', returnReceiptId: uuidv7(), rmaId: uuidv7(), rmaLineId: uuidv7() }),
        move('return.restocked', 1, system('RETURNS'), binA, { kind: 'return-disposition', dispositionId: uuidv7(), returnReceiptLineId: uuidv7(), rmaId: uuidv7(), outcome: 'restock' }),
        move('return.scrapped', 1, system('RETURNS'), null, { kind: 'return-disposition', dispositionId: uuidv7(), returnReceiptLineId: uuidv7(), rmaId: uuidv7(), outcome: 'scrap', reasonCode: 'damaged' }),
        move('transfer.outbound', 2, binA, system('IN-TRANSIT'), { kind: 'transfer', transferId: uuidv7(), lineId: uuidv7() }),
        move('stock.adjusted', 1, system('DAMAGED'), null, { kind: 'manual-adjustment', reasonCode: 'damaged', note: 'write-off' }),
      ];
      for (const event of events) await inventory.appendLedgerEventInTx(tx, event as Parameters<InventoryFacade['appendLedgerEventInTx']>[1]);
    });
    const opened = await openRecall({ batchIds: [lot.id], reasonNote: 'every type' }).expect(201);
    const figures = (await detail(opened.body.recall.id as string).expect(200)).body.lots[0].figures as Record<string, number>;
    expect(figures).toEqual({
      received: 4,
      receivedDamaged: 1,
      onHand: 7,
      inTransit: 2,
      heldInOpenOrders: 0,
      dispatched: 0,
      returned: 2,
      returnScrapped: 1,
      adjustedOut: 1,
      unaccounted: 0,
    });
    // The transfer type registered here is one of the 18 — every registered type ran above but the inbound leg.
    const types = (await sql`select distinct type from ledger_events where tenant_id = ${tenantId} and (batch_ref = ${lot.id} or sku_id = ${sku('RC-ALL')})`) as unknown as { type: string }[];
    expect(types.map((row) => row.type).sort()).toEqual(
      [
        'bin.merged', 'dispatch.dispatched', 'excursion.recorded', 'grn.damaged', 'grn.received', 'pack.packed', 'pick.picked', 'putaway.placed',
        'qc.failed', 'qc.held', 'qc.released', 'return.received', 'return.restocked', 'return.scrapped', 'stock.adjusted', 'stock.moved', 'transfer.outbound',
      ].sort(),
    );
  });

  // ── the report ─────────────────────────────────────────────────────────────

  let repRecall: string;

  it('the report: the header golden, meta rows first and an end row with the count; staff and the client’s portal files are identical but for the staff-only planned picks; BETA gets 404; every download is audited and stamps first_report_at', async () => {
    expect(RECALL_REPORT_COLUMNS.map((column) => `${column.header}:${column.kind}`)).toEqual([
      'section:text', 'client_code:text', 'sku_code:text', 'sku_name:text', 'uom:text', 'batch_code:text', 'expiry_date:date', 'warehouse_code:text',
      'location:text', 'event_ist:instant', 'during_recall:text', 'client_order_ref:text', 'channel_order_ref:text', 'consignee_legal_name:text',
      'consignee_gstin:text', 'destination_city:text', 'destination_state:text', 'destination_pincode:text', 'carrier:text', 'awb:text',
      'vendor_name:text', 'reason:text', 'quantity:number', 'meta_field:text', 'meta_value:text',
    ]);
    const lot = await seed('RC-REP', binA, 6, 'REP-1', wh, 90);
    const shipped = await packedOrder('RC-REP', 2, { clientOrderRef: 'REP-SHIP' });
    await dispatch(shipped).expect(201);
    await packedOrder('RC-REP', 1, { clientOrderRef: 'REP-HELD' });
    const opened = await openRecall({ batchIds: [lot.id], reasonNote: 'report suite', externalRef: 'REP-REF' }).expect(201);
    repRecall = opened.body.recall.id as string;
    // A planned task at the lot's bin (staff only).
    await fixtures.releasedWave([{ skuId: sku('RC-REP'), quantity: 1 }]).catch(() => undefined);

    const staff = await csvOf(repRecall);
    expect(staff[0]!.section).toBe('meta');
    expect(staff.filter((row) => row.section === 'meta').map((row) => row.meta_field)).toEqual([
      'recall_code', 'mode', 'status', 'external_ref', 'client', 'reason_note', 'opened_ist', 'closed_ist', 'generated_ist', 'as_of_ist', 'lot_count', 'consignee_contacts',
    ]);
    const end = staff.at(-1)!;
    expect(end).toMatchObject({ section: 'end', meta_field: 'row_count', meta_value: String(staff.length - 1) });
    const order = staff.map((row) => RECALL_REPORT_SECTIONS.indexOf(row.section as (typeof RECALL_REPORT_SECTIONS)[number]));
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const portalRes = await portalGet(`recalls/${repRecall}/report?format=csv`, acmePortal.token).expect(200);
    const portal = csvRecords(portalRes.text);
    const strip = (rows: Record<string, string>[]) =>
      rows.filter((row) => !['planned_pick_in_recalled_bin', 'end'].includes(row.section ?? '') && !['generated_ist', 'as_of_ist'].includes(row.meta_field!));
    expect(strip(portal)).toEqual(strip(staff));
    expect(portal.some((row) => row.section === 'planned_pick_in_recalled_bin')).toBe(false);
    expect(portal.some((row) => row.section === 'on_hand' && /A-01/.test(row.location ?? ''))).toBe(false);

    expect((await portalGet(`recalls/${repRecall}/report?format=csv`, betaPortal.token).expect(404)).body.code).toBe('not-found');
    expect((await portalGet(`recalls/${repRecall}`, betaPortal.token).expect(404)).body.code).toBe('not-found');
    expect((await portalGet(`recalls/${uuidv7()}`, betaPortal.token).expect(404)).body.code).toBe('not-found');

    const audits = (await sql`select reference, actor_user_id, changes from audit_events where tenant_id = ${tenantId} and action = 'batch_recall.report_downloaded' and target_id = ${repRecall} order by created_at`) as unknown as { reference: string; actor_user_id: string; changes: Record<string, { after: unknown }> }[];
    expect(audits.map((row) => [row.actor_user_id, row.changes.surface!.after, row.changes.format!.after])).toEqual([
      [userIdOf(operatorToken), 'staff', 'csv'],
      [acmePortal.userId, 'portal', 'csv'],
    ]);
    await expectAuditRow({ tenantId, key: audits[0]!.reference, action: 'batch_recall.report_downloaded', targetType: 'batch_recall', targetId: repRecall, actorUserId: userIdOf(operatorToken) });
    const first = (await sql`select first_report_at from batch_recalls where id = ${repRecall}`)[0]!.first_report_at;
    expect(first).not.toBeNull();
    expect((await detail(repRecall).expect(200)).body.recall.timeToReportSeconds).toEqual(expect.any(Number));
  });

  it('the XLSX: a "Recall" facts sheet and a "Trace" sheet in the same schema; past the cap it is 422 report-too-large with no file', async () => {
    const res = await report(repRecall, 'xlsx').buffer(true).parse(binary).expect(200);
    expect(res.headers['content-type']).toBe(XLSX);
    expect(Number(res.headers['content-length'])).toBe((res.body as Buffer).length);
    const workbook = new Workbook();
    await workbook.xlsx.load(res.body as Parameters<Workbook['xlsx']['load']>[0]);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Recall', 'Trace']);
    const facts = workbook.getWorksheet('Recall')!;
    expect(facts.getRow(2).values).toEqual([undefined, 'recall_code', expect.stringMatching(/^RCL-\d{6}$/)]);
    const trace = workbook.getWorksheet('Trace')!;
    expect((trace.getRow(1).values as unknown[]).slice(1)).toEqual(RECALL_REPORT_COLUMNS.map((column) => column.header));
    expect(trace.rowCount).toBeGreaterThan(5);
    const original = reporting.recallXlsxMaxRows;
    reporting.recallXlsxMaxRows = 3;
    try {
      const refused = await report(repRecall, 'xlsx').expect(422);
      expect(refused.body.code).toBe('report-too-large');
      expect(refused.headers['content-type']).toMatch(/problem\+json/);
    } finally {
      reporting.recallXlsxMaxRows = original;
    }
  });

  it('the slots and the deadline: a held staff slot is 503 (Retry-After 5) while the portal’s own slot still serves; a spent deadline is 503 before any byte', async () => {
    expect(reporting.recallReportSlots.tryAcquire()).toBe(true);
    try {
      const busy = await report(repRecall, 'csv').expect(503);
      expect(busy.body.code).toBe('report-unavailable');
      expect(busy.headers['retry-after']).toBe('5');
      await portalGet(`recalls/${repRecall}/report?format=csv`, acmePortal.token).expect(200);
    } finally {
      reporting.recallReportSlots.release();
    }
    expect(reporting.portalRecallReportSlots.tryAcquire()).toBe(true);
    try {
      expect((await portalGet(`recalls/${repRecall}/report?format=csv`, acmePortal.token).expect(503)).body.code).toBe('report-unavailable');
    } finally {
      reporting.portalRecallReportSlots.release();
    }
    const before = await count(sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and action = 'batch_recall.report_downloaded'`);
    // A statement that outlives the whole-read budget (the figures read sleeps past it).
    const original = reporting.recallReportDeadlineMs;
    const figures = inventory.batchLedgerFiguresInTx.bind(inventory);
    reporting.recallReportDeadlineMs = 300;
    inventory.batchLedgerFiguresInTx = (async (tx, ...rest) => {
      await tx.execute(dsql`select pg_sleep(1)`);
      return figures(tx, ...rest);
    }) as InventoryFacade['batchLedgerFiguresInTx'];
    try {
      const slow = await report(repRecall, 'csv').expect(503);
      expect(slow.body.code).toBe('report-unavailable');
      expect(slow.headers['content-type']).toMatch(/problem\+json/);
    } finally {
      reporting.recallReportDeadlineMs = original;
      inventory.batchLedgerFiguresInTx = figures;
    }
    // Refused before the audit, too.
    expect(await count(sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and action = 'batch_recall.report_downloaded'`)).toBe(before);
  });

  it('a failure after the first byte cuts the file: the socket is destroyed and the CSV lacks its end row', async () => {
    const lot = await seed('RC-CUT', binA, 1, 'CUT-1');
    for (let i = 0; i < 6; i += 1) await adjust({ skuId: sku('RC-CUT'), binId: binA, quantityDelta: 1, batch: { code: 'CUT-1' } }).expect(201);
    const opened = await openRecall({ batchIds: [lot.id], reasonNote: 'cut' }).expect(201);
    const recallId = opened.body.recall.id as string;
    const originalPage = reporting.recallTracePageSize;
    reporting.recallTracePageSize = 1;
    const original = inventory.batchTraceEventsPageInTx.bind(inventory);
    let calls = 0;
    inventory.batchTraceEventsPageInTx = (async (...args: Parameters<InventoryFacade['batchTraceEventsPageInTx']>) => {
      calls += 1;
      if (calls === 3) throw new Error('injected mid-stream failure');
      return original(...args);
    }) as InventoryFacade['batchTraceEventsPageInTx'];
    try {
      const server = app.getHttpServer() as Server;
      if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as AddressInfo).port;
      const outcome = await new Promise<{ status: number; body: string; aborted: boolean }>((resolve) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: `${API}/${tenantId}/inventory/recalls/${recallId}/report?format=csv`, headers: { Authorization: `Bearer ${operatorToken}` } }, (res) => {
          const chunks: Buffer[] = [];
          let aborted = false;
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('aborted', () => {
            aborted = true;
          });
          res.on('error', () => {
            aborted = true;
          });
          res.on('close', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), aborted }));
        });
        req.on('error', () => resolve({ status: 0, body: '', aborted: true }));
        req.end();
      });
      expect(outcome.status).toBe(200);
      expect(outcome.aborted).toBe(true);
      expect(outcome.body).not.toMatch(/\r\nend,/);
    } finally {
      inventory.batchTraceEventsPageInTx = original;
      reporting.recallTracePageSize = originalPage;
    }
    // Uncut, the same file ends in its end row.
    expect((await csvOf(recallId)).at(-1)!.section).toBe('end');
  });

  it('a 120,000-row trace streams whole: the CSV ends in an end row carrying the count; an XLSX past its cap is 422', async () => {
    const big = await createWarehouse(`RCB-${ulid().slice(20)}`);
    await adjust({ warehouseId: big, skuId: sku('RC-BIG'), binId: await createBin(big, await createZone(big, 'B'), 'B-01-01'), quantityDelta: 1, batch: { code: 'BIG-1' } }).expect(201);
    const lot = await batchId('RC-BIG', 'BIG-1');
    const maxSeq = Number((await sql`select max(seq)::int as n from ledger_events where tenant_id = ${tenantId} and warehouse_id = ${big}`)[0]!.n);
    await sql`
      insert into ledger_events (id, tenant_id, client_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta, from_bin_id, to_bin_id,
        batch_ref, serial_ref, actor_user_id, occurred_at, recorded_at, reference_doc, prev_hash, event_hash)
      select gen_random_uuid(), ${tenantId}, ${acme}, ${big}, ${maxSeq} + g, 'grn.received', 1, ${sku('RC-BIG')}, 1000, null, gen_random_uuid(),
        ${lot}, null, ${ownerUserId}, now(), now(), jsonb_build_object('kind', 'grn-receipt', 'grnId', gen_random_uuid()::text), 'seed', 'seed-' || g
      from generate_series(1, 120000) g`;
    const opened = await openRecall({ batchIds: [lot], reasonNote: 'a very large lot' }).expect(201);
    const recallId = opened.body.recall.id as string;
    const res = await report(recallId, 'csv').buffer(true).expect(200);
    expect(res.headers['content-length']).toBeUndefined();
    const text = res.text;
    const lines = text.trimEnd().split('\r\n');
    expect(lines.length).toBeGreaterThan(120_000);
    const last = lines.at(-1)!;
    expect(last.startsWith('end,')).toBe(true);
    expect(last.endsWith(`,row_count,${lines.length - 2}`)).toBe(true);
    expect(lines.filter((line) => line.startsWith('received,')).length).toBe(120_000);
    // The XLSX is built whole and capped (A10: 200,000 rows — the CSV carries any size); past the cap it is 422.
    const cap = reporting.recallXlsxMaxRows;
    reporting.recallXlsxMaxRows = 100_000;
    try {
      expect((await report(recallId, 'xlsx').expect(422)).body.code).toBe('report-too-large');
    } finally {
      reporting.recallXlsxMaxRows = cap;
    }
  });

  // ── the portal ─────────────────────────────────────────────────────────────

  it('the portal: its own recalls only, the detail an exact key allowlist (no bins, no actors, no planned picks); an operator token is refused', async () => {
    const list = await portalGet('recalls', acmePortal.token).expect(200);
    const codes = (list.body.items as { code: string }[]).map((row) => row.code);
    expect(codes).toContain('RCL-000001');
    expect(Object.keys(list.body.items[0]).sort()).toEqual(['closedAt', 'code', 'externalRef', 'id', 'lotCount', 'mode', 'openedAt', 'status']);
    expect((await portalGet('recalls', betaPortal.token).expect(200)).body.items).toEqual([]);
    const one = await portalGet(`recalls/${rcl1}`, acmePortal.token).expect(200);
    expect(Object.keys(one.body).sort()).toEqual(['closeNote', 'closedAt', 'code', 'externalRef', 'heldOrders', 'id', 'lots', 'mode', 'onHandByWarehouse', 'openedAt', 'reasonNote', 'status']);
    expect(Object.keys(one.body.lots[0]).sort()).toEqual(['batchCode', 'batchId', 'closeFigures', 'expiryDate', 'figures', 'skuCode', 'skuName', 'uom']);
    expect(Object.keys(one.body.onHandByWarehouse[0]).sort()).toEqual(['batchCode', 'quantity', 'role', 'warehouseCode']);
    expect(JSON.stringify(one.body)).not.toMatch(/A-01-0|openedBy|closedBy/);
    expect((await portalGet('recalls', opsToken).expect(403)).body.code).toBe('role-denied');
    expect((await http().get(`${API}/${tenantId}/inventory/recalls`).set('Authorization', `Bearer ${acmePortal.token}`).expect(403)).body.code).toBe('role-denied');
  });

  // ── the pure pieces ────────────────────────────────────────────────────────

  it('the close summary v1 golden: every key in its fixed position', () => {
    const figures = { received: 1, receivedDamaged: 0, onHand: 2, inTransit: 0, heldInOpenOrders: 0, dispatched: 3, returned: 0, returnScrapped: 0, adjustedOut: 1, unaccounted: 0 };
    const summary = buildCloseSummary({
      asOf: '2026-10-28T05:30:00.000Z',
      lots: [
        { batchId: 'b2', batchCode: 'Z', skuId: 's', figures: { ...figures, unaccounted: 0, received: 9 }, adjustedOutByReason: { damage: 1, aaa: 2 }, released: false, overrideReason: null, dispositionNote: 'kept' },
        { batchId: 'b1', batchCode: 'A', skuId: 's', figures, adjustedOutByReason: {}, released: true, overrideReason: 'clean', dispositionNote: null },
      ],
      acknowledgedUnaccounted: false,
      evidenceRef: null,
    });
    expect(JSON.stringify(summary)).toBe(
      '{"v":1,"asOf":"2026-10-28T05:30:00.000Z","lots":[' +
        '{"batchId":"b1","batchCode":"A","skuId":"s","figures":{"received":1,"receivedDamaged":0,"onHand":2,"inTransit":0,"heldInOpenOrders":0,"dispatched":3,"returned":0,"returnScrapped":0,"adjustedOut":1,"unaccounted":0},"adjustedOutByReason":{},"released":true,"overrideReason":"clean","dispositionNote":null},' +
        '{"batchId":"b2","batchCode":"Z","skuId":"s","figures":{"received":9,"receivedDamaged":0,"onHand":2,"inTransit":0,"heldInOpenOrders":0,"dispatched":3,"returned":0,"returnScrapped":0,"adjustedOut":1,"unaccounted":0},"adjustedOutByReason":{"aaa":2,"damage":1},"released":false,"overrideReason":null,"dispositionNote":"kept"}' +
        '],"acknowledgedUnaccounted":false,"evidenceRef":null}',
    );
  });

  it('buildXlsx is buildXlsxWorkbook of one sheet: the same worksheet bytes (the registers’ files are unchanged)', async () => {
    const columns = [{ header: 'a', kind: 'text' as const }, { header: 'n', kind: 'number' as const }, { header: 'd', kind: 'date' as const }];
    const rows = [['=SUM(1)', -5, new Date('2026-10-01T18:30:00.000Z')], [null, 1.5, null]];
    const one = await buildXlsx('Sheet', columns, rows);
    const two = await buildXlsxWorkbook([{ name: 'Sheet', columns, rows }]);
    const sheetXml = async (buffer: Buffer): Promise<string> => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const JSZip = require('jszip') as { loadAsync(data: Buffer): Promise<{ file(name: string): { async(kind: 'string'): Promise<string> } | null }> };
      const zip = await JSZip.loadAsync(buffer);
      return zip.file('xl/worksheets/sheet1.xml')!.async('string');
    };
    expect(await sheetXml(two)).toBe(await sheetXml(one));
  });

  // ── the bounded reads' plans (A8, A9) ──────────────────────────────────────

  it('EXPLAIN: the candidates, open orders, held picks, picked lots and on-hand statements plan on their indexes', async () => {
    const plan = async (statement: ReturnType<typeof batchCandidatesQuery>): Promise<string> =>
      withTenantTransaction(db, tenantId, async (tx) => {
        await tx.execute(dsql`set local enable_seqscan = off`);
        const rows = (await tx.execute(dsql`explain ${statement}`)) as unknown as Record<string, string>[];
        return rows.map((row) => Object.values(row)[0]).join('\n');
      });
    expect(await plan(batchCandidatesQuery(tenantId, acme, 'AB123', 10))).toContain('batches_tenant_code_norm_idx');
    expect(await plan(openOrdersQuery(tenantId, acme, [wh, wh2]))).toContain('orders_tenant_client_open_idx');
    expect(await plan(orderPickEventsQuery(tenantId, [uuidv7()], [l1.id]))).toMatch(/ledger_events_order_ref_idx|ledger_events_tenant_batch_ref_seq_idx/);
    expect(await plan(pickedBatchRefsQuery(tenantId, uuidv7()))).toContain('ledger_events_order_ref_idx');
    expect(await plan(recallOnHandQuery(tenantId, [wh, wh2], [sku('RC-OPEN')], [l1.id]))).toMatch(/batch_on_hand_tenant_warehouse_sku_idx|batch_on_hand_scope_unique/);
  });

  // ── RLS (guide §5, §7e) ────────────────────────────────────────────────────

  it('RLS: as wms_rls_probe a foreign tenant sees no recall row or line; a portal stamp sees only its own client’s recalls, and their lines through the join', async () => {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${PROBE_LOCK})`;
      await tx.unsafe(`do $$ begin if not exists (select from pg_roles where rolname = 'wms_rls_probe') then create role wms_rls_probe login password 'wms_rls_probe' nosuperuser; end if; end $$;`);
      await tx.unsafe('grant usage on schema public to wms_rls_probe');
      await tx.unsafe('grant select, insert, update, delete on all tables in schema public to wms_rls_probe');
    });
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const probe = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      const foreign = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
        return [Number((await tx`select count(*)::int as n from batch_recalls`)[0]!.n), Number((await tx`select count(*)::int as n from batch_recall_lines`)[0]!.n)];
      });
      expect(foreign).toEqual([0, 0]);
      const tenantWide = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        return Number((await tx`select count(*)::int as n from batch_recalls`)[0]!.n);
      });
      expect(tenantWide).toBeGreaterThan(3);
      const stamped = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`select set_config('app.client_id', ${beta}, true)`;
        const recalls = Number((await tx`select count(*)::int as n from batch_recalls`)[0]!.n);
        const joined = Number((await tx`select count(*)::int as n from batch_recall_lines l join batch_recalls r on r.tenant_id = l.tenant_id and r.id = l.recall_id`)[0]!.n);
        return [recalls, joined];
      });
      expect(stamped).toEqual([0, 0]);
      const own = await probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`select set_config('app.client_id', ${acme}, true)`;
        return Number((await tx`select count(*)::int as n from batch_recalls where client_id <> ${acme}`)[0]!.n) + Number((await tx`select count(*)::int as n from batch_recalls`)[0]!.n > 0 ? 0 : 1);
      });
      expect(own).toBe(0);
    } finally {
      await probe.end();
    }
  });

  // ── the routes ─────────────────────────────────────────────────────────────

  it('the OpenAPI document carries every recall route, the literal candidates route resolves before :recallId', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const paths = Object.keys(doc.body.paths as Record<string, unknown>);
    for (const path of [
      '/tenants/{tenantId}/inventory/recalls',
      '/tenants/{tenantId}/inventory/recalls/candidates',
      '/tenants/{tenantId}/inventory/recalls/{recallId}',
      '/tenants/{tenantId}/inventory/recalls/{recallId}/bins',
      '/tenants/{tenantId}/inventory/recalls/{recallId}/shipments',
      '/tenants/{tenantId}/inventory/recalls/{recallId}/receipts',
      '/tenants/{tenantId}/inventory/recalls/{recallId}/report',
      '/tenants/{tenantId}/inventory/recalls/{recallId}/batches',
      '/tenants/{tenantId}/inventory/recalls/{recallId}/close',
      '/tenants/{tenantId}/portal/recalls',
      '/tenants/{tenantId}/portal/recalls/{recallId}',
      '/tenants/{tenantId}/portal/recalls/{recallId}/report',
    ]) {
      expect(paths).toContain(path);
    }
    // `candidates` is not captured by `:recallId` (which would answer 400 "recallId must be a uuid").
    expect((await http().get(`${API}/${tenantId}/inventory/recalls/candidates?clientId=${acme}&code=L1`).set('Authorization', `Bearer ${operatorToken}`).expect(200)).body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ batchCode: 'L1', onRecall: expect.objectContaining({ code: 'RCL-000001' }) })]),
    );
  });
});
