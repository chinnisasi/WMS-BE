import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ensureReturnsBinInTx } from '../src/modules/tenancy/receiving-bin';
import { REJECTED_OP_DECISIONS_BY_TYPE, REJECTED_OP_TYPES } from '../src/modules/tenancy/sync-report.command';
import { RMA_STATUSES } from '../src/modules/returns/return-authorization.command';
import {
  RETURN_CONDITIONS,
  classifyReturnEntry,
  normalizeReceive,
  receivePayloadHash,
  refusedEntriesOpId,
  type ClassifyContext,
} from '../src/modules/returns/return-receipt.command';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { expectAuditRow } from './support/audit-guard';
import { dispatchedOrderFixtures, type Picklist } from './support/dispatched-order';
import { mintSignIn } from './support/sign-in';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(180_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
/** The advisory key every suite uses to serialize wms_rls_probe role setup. */
const PROBE_LOCK = 742105;

interface RmaBody {
  id: string;
  code: string;
  status: string;
  warehouseId: string;
  lines: { id: string; orderLineId: string; skuId: string; authorizedQty: number; receivedQty: number; serials: { id: string; serialNumber: string }[] }[];
  receipts?: {
    id: string;
    code: string;
    occurredAt: string;
    operatorEmail: string | null;
    lines: {
      rmaLineId: string;
      skuId: string;
      qty: number;
      condition: string;
      note: string | null;
      batchCode: string | null;
      serialNumber: string | null;
      weightGrams: number | null;
    }[];
  }[];
}

interface ReturnableBody {
  lines: { orderLineId: string; skuId: string; returnableQty: number; returnableSerials: { serialNumber: string }[] }[];
}

interface ReceiptBody {
  returnReceiptId: string | null;
  code: string | null;
  rmaStatus: string;
  applied: { entryIndex: number; rmaLineId: string; qty: number }[];
  refused: { entryIndex: number; reason: string }[];
  reviewOpId: string | null;
}

interface Entry {
  rmaLineId: string | null;
  skuId: string;
  qty: number;
  condition: string;
  note?: string | null;
  batchCode?: string | null;
  serialNumber?: string | null;
  weightGrams?: number | null;
}

/** Second-precision device time, Z-suffixed. */
function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * Story 13-2 (FR-47) — return receipt and inspection. Every backend row of
 * the spec's I/O matrix, driven through real HTTP against really dispatched
 * orders (the shared `dispatched-order` fixtures, extended here with a
 * batch-tracked and a catch-weight dispatch), plus the ATP / reconcile
 * proof with stock in RETURNS, the review queue's Discard-only rule, the
 * RETURNS bin's protections, the vocabulary pins, the hash golden and the
 * wms_rls_probe isolation proof.
 */
describe('return receipts (e2e, story 13-2)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let inventory: InventoryFacade;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string; // the badge-in device session
  let operatorUserId: string;
  let operatorEmail: string;
  let deviceId: string;
  let warehouseId: string;
  let otherWarehouseId: string;
  let binId: string;
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  const SKU_ROWS = [
    'RR-A,Return line A,pcs,,1800,,false,false,false,,,',
    'RR-B,Return line B,pcs,,1800,,false,false,false,,,',
    'RR-C,Not on the RMA,pcs,,1800,,false,false,false,,,',
    'RR-SER,Return serial,pcs,,1800,,false,true,false,,,',
    'RR-BAT,Return batch,pcs,,1800,,true,false,false,,,',
    'RR-CW,Return catch weight,case,,1800,,false,false,true,,,',
    'RR-CW2,Return catch weight (flag),case,,1800,,false,false,true,,,',
    'RR-KG,Return by the kilo,kg,,1800,,false,false,false,,,',
  ];

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('return_receipts');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    inventory = app.get(InventoryFacade);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Return Receipts Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
    opsToken = (await createMember('ops_manager')).token;
    const floor = await createMember('operator');
    operatorUserId = floor.userId;
    operatorEmail = floor.email;

    warehouseId = await createWarehouse('RR');
    otherWarehouseId = await createWarehouse('RX');
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
      ...SKU_ROWS,
    ].join('\n');
    const imported = await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    expect(imported.body.failedRows).toBe(0);
    const catalog = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of catalog.body.items as { code: string; id: string }[]) skuIds.set(item.code, item.id);

    for (const code of ['RR-A', 'RR-B', 'RR-C']) await seedStock(sku(code), 1000);
    await seedStock(sku('RR-KG'), 100);
    await seedStock(sku('RR-SER'), 6, ['S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6']);

    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Returns dock scanner', pin: '2468' })
      .expect(201);
    deviceId = enrolled.body.device.id as string;
    operatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    // The batch-tracked and catch-weight stock, through the extended fixtures.
    await fixtures.seedBatchStock(sku('RR-BAT'), binId, 5, 'B1');
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

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  async function createWarehouse(prefix: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${prefix}-${ulid().slice(20)}`, name: `${prefix} WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
  }

  async function createMember(role: string): Promise<{ userId: string; token: string; email: string }> {
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
    return { userId: invited.body.user.id as string, token, email };
  }

  async function seedStock(skuId: string, quantity: number, serials?: string[]): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta: quantity, reasonCode: 'stock-count', note: 'return-receipts seed', ...(serials === undefined ? {} : { serials }) })
      .expect(201);
  }

  function scannedOf(picklist: Picklist, handlingUnitIds?: Map<string, string[]>): { skuId: string; qty: number; handlingUnitIds?: string[] }[] {
    const bySku = new Map<string, number>();
    for (const line of picklist.lines) bySku.set(line.skuId, (bySku.get(line.skuId) ?? 0) + line.qty);
    return [...bySku].map(([skuId, qty]) => ({ skuId, qty, ...(handlingUnitIds?.has(skuId) ? { handlingUnitIds: handlingUnitIds.get(skuId)! } : {}) }));
  }

  /** A really dispatched order of `lines`; serial lines pick `serials`; catch-weight lines pack `cases`. */
  async function dispatchedOrder(
    lines: { skuId: string; quantity: number }[],
    options: { serials?: string[]; cases?: string[]; cwSku?: string } = {},
  ): Promise<{ orderId: string; returnable: ReturnableBody }> {
    const { orderId, picklist } = await fixtures.releasedWave(lines);
    const serialLine = picklist.lines.find((l) => l.skuId === sku('RR-SER'));
    await fixtures.pickAllLines(
      picklist,
      undefined,
      options.serials === undefined || serialLine === undefined ? undefined : new Map([[serialLine.id, options.serials]]),
    );
    await fixtures.packAndDispatch(
      orderId,
      scannedOf(picklist, options.cases === undefined ? undefined : new Map([[sku(options.cwSku ?? 'RR-CW'), options.cases]])),
    );
    const read = await http().get(`${API}/${tenantId}/returns/returnable?orderId=${orderId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    return { orderId, returnable: read.body as ReturnableBody };
  }

  function lineOf(read: ReturnableBody, code: string): ReturnableBody['lines'][number] {
    const line = read.lines.find((l) => l.skuId === sku(code));
    if (line === undefined) throw new Error(`no ${code} line`);
    return line;
  }

  async function createRma(orderId: string, lines: { orderLineId: string; qty: number; serialNumbers?: string[] }[]): Promise<RmaBody> {
    return (
      await http()
        .post(`${API}/${tenantId}/returns`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ orderId, lines: lines.map((line) => ({ ...line, reasonCode: 'damaged' })) })
        .expect(201)
    ).body as RmaBody;
  }

  function receive(body: { rmaId: string; entries: Entry[]; warehouseId?: string; occurredAt?: string }, key = ulid(), token = operatorToken): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/returns/receipts`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: body.warehouseId ?? warehouseId, rmaId: body.rmaId, occurredAt: body.occurredAt ?? nowUtc(), entries: body.entries });
  }

  async function rmaDetail(rmaId: string): Promise<RmaBody> {
    return (await http().get(`${API}/${tenantId}/returns/${rmaId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body as RmaBody;
  }

  async function count(query: PromiseLike<unknown>): Promise<number> {
    const rows = (await query) as { n: number | string }[];
    return Number(rows[0]!.n);
  }

  async function returnsBin(): Promise<string> {
    const rows = (await sql`select id from bins where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and code = 'RETURNS' and system_owned`) as unknown as { id: string }[];
    return rows[0]!.id;
  }

  async function onHandIn(bin: string, skuId: string): Promise<number> {
    return count(sql`select coalesce(sum(quantity), 0)::bigint as n from stock_on_hand where tenant_id = ${tenantId} and bin_id = ${bin} and sku_id = ${skuId}`);
  }

  async function rejectedOpOf(opId: string): Promise<{ id: string; op_type: string; problem_code: string; payload: Record<string, unknown>; status: string; classification: string; attribution: Record<string, unknown> } | undefined> {
    const rows = (await sql`select id, op_type, problem_code, payload, status, classification, attribution from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`) as unknown as {
      id: string;
      op_type: string;
      problem_code: string;
      payload: Record<string, unknown>;
      status: string;
      classification: string;
      attribution: Record<string, unknown>;
    }[];
    return rows[0];
  }

  // ── the happy path, replay, ATP ────────────────────────────────────────────

  it('happy path: 2 × A received resaleable → 201 RRN, two receipt lines, two return.received into RETURNS, RMA received, ATP unchanged; a replay re-serves it, another body is 422', async () => {
    const { orderId, returnable } = await dispatchedOrder([{ skuId: sku('RR-A'), quantity: 2 }]);
    const rma = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-A').orderLineId, qty: 2 }]);
    const rmaLineId = rma.lines[0]!.id;
    const atpBefore = await inventory.atp(tenantId, warehouseId, sku('RR-A'));

    const key = ulid();
    const occurredAt = nowUtc();
    const entries: Entry[] = [
      { rmaLineId, skuId: sku('RR-A'), qty: 1, condition: 'resaleable' },
      { rmaLineId, skuId: sku('RR-A'), qty: 1, condition: 'resaleable', note: '  sealed  ' },
    ];
    const res = await receive({ rmaId: rma.id, entries, occurredAt }, key).expect(201);
    const body = res.body as ReceiptBody;
    expect(body.code).toMatch(/^RRN-\d{4}$/);
    expect(body).toMatchObject({ rmaStatus: 'received', refused: [], reviewOpId: null });
    expect(body.applied).toEqual([
      { entryIndex: 0, rmaLineId, qty: 1 },
      { entryIndex: 1, rmaLineId, qty: 1 },
    ]);

    const lines = (await sql`select line_no, qty, condition, note, ledger_event_id from return_receipt_lines where return_receipt_id = ${body.returnReceiptId} order by line_no`) as unknown as {
      line_no: number;
      qty: string;
      condition: string;
      note: string | null;
      ledger_event_id: string;
    }[];
    expect(lines.map((l) => [l.line_no, Number(l.qty), l.condition, l.note])).toEqual([
      [1, 1000, 'resaleable', null],
      [2, 1000, 'resaleable', 'sealed'],
    ]);
    const bin = await returnsBin();
    const events = (await sql`select id, type, quantity_delta, from_bin_id, to_bin_id, occurred_at, reference_doc, client_id from ledger_events where tenant_id = ${tenantId} and type = 'return.received' and reference_doc->>'returnReceiptId' = ${body.returnReceiptId} order by seq`) as unknown as {
      id: string;
      quantity_delta: string;
      from_bin_id: string | null;
      to_bin_id: string;
      occurred_at: Date;
      reference_doc: Record<string, unknown>;
      client_id: string;
    }[];
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.id).sort()).toEqual(lines.map((l) => l.ledger_event_id).sort());
    for (const event of events) {
      expect(Number(event.quantity_delta)).toBe(1000);
      expect(event.from_bin_id).toBeNull();
      expect(event.to_bin_id).toBe(bin);
      expect(new Date(event.occurred_at).toISOString().replace(/\.\d+Z$/, 'Z')).toBe(occurredAt);
      expect(event.reference_doc).toEqual({ kind: 'return-receipt', returnReceiptId: body.returnReceiptId, rmaId: rma.id, rmaLineId });
    }
    const skuClient = (await sql`select client_id from skus where id = ${sku('RR-A')}`) as unknown as { client_id: string }[];
    expect(events[0]!.client_id).toBe(skuClient[0]!.client_id);

    // ATP: on-hand grew by 2, all of it in RETURNS — ATP is unchanged.
    const atpAfter = await inventory.atp(tenantId, warehouseId, sku('RR-A'));
    expect(atpAfter.onHand).toBe(atpBefore.onHand + 2000);
    expect(atpAfter.returnsAwaiting).toBe(atpBefore.returnsAwaiting + 2000);
    expect(atpAfter.atp).toBe(atpBefore.atp);

    const detail = await rmaDetail(rma.id);
    expect(detail.status).toBe('received');
    expect(detail.lines[0]!.receivedQty).toBe(2);
    expect(detail.receipts).toHaveLength(1);
    expect(detail.receipts![0]).toMatchObject({ code: body.code, operatorEmail });
    expect(Date.parse(detail.receipts![0]!.occurredAt)).toBe(Date.parse(occurredAt));
    expect(detail.receipts![0]!.lines.map((l) => [l.qty, l.condition, l.note])).toEqual([
      [1, 'resaleable', null],
      [1, 'resaleable', 'sealed'],
    ]);
    // The list carries no receipts (detail only).
    const list = await http().get(`${API}/${tenantId}/returns?orderId=${orderId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(list.body.items[0].receipts).toBeUndefined();

    await expectAuditRow({ tenantId, key, action: 'return_receipt.recorded', targetType: 'return_receipt', targetId: body.returnReceiptId!, actorUserId: operatorUserId });
    const outbox = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'return_receipt.recorded' and payload->>'rmaId' = ${rma.id}`) as unknown as { payload: Record<string, unknown> }[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload).toEqual({
      returnReceiptId: body.returnReceiptId,
      code: body.code,
      rmaId: rma.id,
      rmaCode: rma.code,
      clientId: skuClient[0]!.client_id,
      warehouseId,
      appliedCount: 2,
      refusedCount: 0,
    });

    // The replay: same 201, nothing new.
    const replay = await receive({ rmaId: rma.id, entries, occurredAt }, key).expect(201);
    expect(replay.body).toEqual(body);
    await expectAuditRow({ tenantId, key, action: 'return_receipt.recorded', targetType: 'return_receipt', targetId: body.returnReceiptId!, actorUserId: operatorUserId });
    expect(await count(sql`select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and type = 'return.received' and reference_doc->>'rmaId' = ${rma.id}`)).toBe(2);
    // A different body under the key is 422.
    const reused = await receive({ rmaId: rma.id, entries: entries.slice(0, 1), occurredAt }, key).expect(422);
    expect(reused.body.code).toBe('idempotency-key-reuse');
  });

  // Story 1-4 — the posting reads its SKU facts FOR SHARE, so a tracking-
  // flag flip (the SKU edit's FOR UPDATE) cannot interleave with it: with a
  // raw holder on the SKU row, the post parks until the holder commits.
  it('story 1-4: the posting takes the SKU row FOR SHARE — it parks behind a held FOR UPDATE and settles once released', async () => {
    const { orderId, returnable } = await dispatchedOrder([{ skuId: sku('RR-A'), quantity: 1 }]);
    const rma = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-A').orderLineId, qty: 1 }]);
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    let post: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`select pg_backend_pid() as pid from skus where id = ${sku('RR-A')} for update`) as unknown as { pid: number }[];
        const holderPid = locked[0]!.pid;
        post = (async () => receive({ rmaId: rma.id, entries: [{ rmaLineId: rma.lines[0]!.id, skuId: sku('RR-A'), qty: 1, condition: 'resaleable' }] }))();
        let parked = false;
        const deadline = Date.now() + 10_000;
        while (!parked && Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active'
              and a.query ilike '%"skus"%' and a.query ilike '%for share%'
              and ${holderPid} = any(pg_blocking_pids(a.pid))
          `) as unknown as { pid: number }[];
          parked = waiting.length > 0;
          if (!parked) await new Promise((r) => setTimeout(r, 25));
        }
        expect(parked).toBe(true);
      });
      const res = await post!;
      expect(res.status).toBe(201);
    } finally {
      await Promise.allSettled([post]);
      await holder.end();
      await probe.end();
    }
  });

  it('partial: 1 of 2 → partially_received, and the device snapshot shows 1 open on the line', async () => {
    const { orderId, returnable } = await dispatchedOrder([{ skuId: sku('RR-B'), quantity: 2 }]);
    const rma = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-B').orderLineId, qty: 2 }]);
    const res = await receive({ rmaId: rma.id, entries: [{ rmaLineId: rma.lines[0]!.id, skuId: sku('RR-B'), qty: 1, condition: 'opened' }] }).expect(201);
    expect(res.body.rmaStatus).toBe('partially_received');

    const snapshot = await http()
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    const open = (snapshot.body.openReturns as { id: string; code: string; orderReference: string | null; lines: { id: string; openQty: number; receivedQty: number; authorizedQty: number; batchCodes: string[]; serials: unknown[] }[] }[]).find(
      (item) => item.id === rma.id,
    );
    expect(open).toMatchObject({ code: rma.code, lines: [{ id: rma.lines[0]!.id, authorizedQty: 2, receivedQty: 1, openQty: 1, batchCodes: [], serials: [] }] });
    // A received RMA is not in the snapshot; a partially received one still is.
    const ids = (snapshot.body.openReturns as { id: string }[]).map((item) => item.id);
    expect(ids).toContain(rma.id);

    // A new RMA for the line's full quantity is refused: the partial RMA
    // still speaks for both units (received or not).
    const full = await http()
      .post(`${API}/${tenantId}/returns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ orderId, lines: [{ orderLineId: lineOf(returnable, 'RR-B').orderLineId, qty: 2, reasonCode: 'damaged' }] })
      .expect(409);
    expect(full.body.code).toBe('exceeds-returnable');

    // The rest of it, then it leaves the snapshot.
    await receive({ rmaId: rma.id, entries: [{ rmaLineId: rma.lines[0]!.id, skuId: sku('RR-B'), qty: 1, condition: 'damaged' }] }).expect(201);
    const after = await http()
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    expect((after.body.openReturns as { id: string }[]).map((item) => item.id)).not.toContain(rma.id);
  });

  it('no double authorization: after a receipt, a new RMA on the same line refuses exceeds-returnable / serial-already-authorized (the 13-1 sums read every uncancelled status)', async () => {
    const { orderId, returnable } = await dispatchedOrder(
      [
        { skuId: sku('RR-A'), quantity: 1 },
        { skuId: sku('RR-SER'), quantity: 1 },
      ],
      { serials: ['S-1'] },
    );
    const rma = await createRma(orderId, [
      { orderLineId: lineOf(returnable, 'RR-A').orderLineId, qty: 1 },
      { orderLineId: lineOf(returnable, 'RR-SER').orderLineId, qty: 1, serialNumbers: ['S-1'] },
    ]);
    const lineA = rma.lines.find((l) => l.skuId === sku('RR-A'))!;
    const lineS = rma.lines.find((l) => l.skuId === sku('RR-SER'))!;
    const res = await receive({
      rmaId: rma.id,
      entries: [
        { rmaLineId: lineA.id, skuId: sku('RR-A'), qty: 1, condition: 'resaleable' },
        { rmaLineId: lineS.id, skuId: sku('RR-SER'), qty: 1, condition: 'opened', serialNumber: 'S-1' },
      ],
    }).expect(201);
    expect(res.body.rmaStatus).toBe('received');

    const again = await http()
      .post(`${API}/${tenantId}/returns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ orderId, lines: [{ orderLineId: lineOf(returnable, 'RR-A').orderLineId, qty: 1, reasonCode: 'damaged' }] })
      .expect(409);
    expect(again.body.code).toBe('exceeds-returnable');
    const serialAgain = await http()
      .post(`${API}/${tenantId}/returns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ orderId, lines: [{ orderLineId: lineOf(returnable, 'RR-SER').orderLineId, qty: 0.0 + 1, reasonCode: 'damaged', serialNumbers: ['S-1'] }] });
    // The quantity bound bites first (returnable 0); either refusal keeps the
    // serial from being authorized twice.
    expect(serialAgain.status).toBe(409);
    expect(['exceeds-returnable', 'serial-already-authorized']).toContain(serialAgain.body.code);
  });

  // ── serials ────────────────────────────────────────────────────────────────

  it('serial: an authorized serial applies into RETURNS; an unauthorized one is serial-not-authorized; one back in stock is serial-in-stock', async () => {
    const { orderId, returnable } = await dispatchedOrder([{ skuId: sku('RR-SER'), quantity: 3 }], { serials: ['S-2', 'S-3', 'S-4'] });
    const rma = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-SER').orderLineId, qty: 2, serialNumbers: ['S-2', 'S-3'] }]);
    const line = rma.lines[0]!;
    // S-3 re-enters stock by an adjustment intake before the return arrives.
    await seedStock(sku('RR-SER'), 1, ['S-3']);

    const res = await receive({
      rmaId: rma.id,
      entries: [
        { rmaLineId: line.id, skuId: sku('RR-SER'), qty: 1, condition: 'resaleable', serialNumber: 'S-2' },
        { rmaLineId: line.id, skuId: sku('RR-SER'), qty: 1, condition: 'resaleable', serialNumber: 'S-4' },
        { rmaLineId: line.id, skuId: sku('RR-SER'), qty: 1, condition: 'resaleable', serialNumber: 'S-3' },
        { rmaLineId: line.id, skuId: sku('RR-SER'), qty: 1, condition: 'damaged' },
      ],
    }).expect(201);
    expect(res.body.applied).toEqual([{ entryIndex: 0, rmaLineId: line.id, qty: 1 }]);
    expect(res.body.refused).toEqual([
      { entryIndex: 1, reason: 'serial-not-authorized' },
      { entryIndex: 2, reason: 'serial-in-stock' },
      { entryIndex: 3, reason: 'missing-capture' },
    ]);
    const s2 = line.serials.find((s) => s.serialNumber === 'S-2')!;
    const location = await inventory.serialLocation(tenantId, s2.id);
    expect(location).toEqual({ warehouseId, binId: await returnsBin() });
    // The same serial twice is refused the second time (already received).
    const twice = await receive({ rmaId: rma.id, entries: [{ rmaLineId: line.id, skuId: sku('RR-SER'), qty: 1, condition: 'opened', serialNumber: 'S-2' }] }).expect(201);
    expect(twice.body.refused).toEqual([{ entryIndex: 0, reason: 'serial-not-authorized' }]);
    expect(twice.body.returnReceiptId).toBeNull();
    // The snapshot's serials for the line, exactly (S-3 is still open).
    const snapshot = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    const open = (snapshot.body.openReturns as { id: string; lines: { serials: unknown[] }[] }[]).find((item) => item.id === rma.id)!;
    expect(open.lines[0]!.serials).toEqual([
      { id: s2.id, serialNumber: 'S-2', received: true, batchCode: null },
      { id: line.serials.find((s) => s.serialNumber === 'S-3')!.id, serialNumber: 'S-3', received: false, batchCode: null },
    ]);
  });

  it('one op naming the same serial twice: entry 0 applies, entry 1 is serial-not-authorized', async () => {
    // Two authorized, so the quantity bound is not what refuses the repeat.
    const { orderId, returnable } = await dispatchedOrder([{ skuId: sku('RR-SER'), quantity: 2 }], { serials: ['S-5', 'S-6'] });
    const rma = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-SER').orderLineId, qty: 2, serialNumbers: ['S-5', 'S-6'] }]);
    const line = rma.lines[0]!;
    const res = await receive({
      rmaId: rma.id,
      entries: [
        { rmaLineId: line.id, skuId: sku('RR-SER'), qty: 1, condition: 'opened', serialNumber: 'S-5' },
        { rmaLineId: line.id, skuId: sku('RR-SER'), qty: 1, condition: 'opened', serialNumber: 'S-5' },
      ],
    }).expect(201);
    expect(res.body.applied).toEqual([{ entryIndex: 0, rmaLineId: line.id, qty: 1 }]);
    expect(res.body.refused).toEqual([{ entryIndex: 1, reason: 'serial-not-authorized' }]);
  });

  // ── batches ────────────────────────────────────────────────────────────────

  it('batch: a batch-tracked line picked from B1 applies with B1 (the batch reused, never created); B9 is batch-not-dispatched; no batch is missing-capture', async () => {
    const { orderId, returnable } = await dispatchedOrder([{ skuId: sku('RR-BAT'), quantity: 2 }]);
    const rma = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-BAT').orderLineId, qty: 2 }]);
    const line = rma.lines[0]!;
    const batchesBefore = await count(sql`select count(*)::int as n from batches where tenant_id = ${tenantId} and sku_id = ${sku('RR-BAT')}`);
    const res = await receive({
      rmaId: rma.id,
      entries: [
        { rmaLineId: line.id, skuId: sku('RR-BAT'), qty: 1, condition: 'resaleable', batchCode: 'B1' },
        { rmaLineId: line.id, skuId: sku('RR-BAT'), qty: 1, condition: 'resaleable', batchCode: 'B9' },
        { rmaLineId: line.id, skuId: sku('RR-BAT'), qty: 1, condition: 'resaleable' },
      ],
    }).expect(201);
    expect(res.body.applied).toEqual([{ entryIndex: 0, rmaLineId: line.id, qty: 1 }]);
    expect(res.body.refused).toEqual([
      { entryIndex: 1, reason: 'batch-not-dispatched' },
      { entryIndex: 2, reason: 'missing-capture' },
    ]);
    expect(await count(sql`select count(*)::int as n from batches where tenant_id = ${tenantId} and sku_id = ${sku('RR-BAT')}`)).toBe(batchesBefore);
    const event = (await sql`select batch_ref from ledger_events where tenant_id = ${tenantId} and type = 'return.received' and reference_doc->>'rmaId' = ${rma.id}`) as unknown as { batch_ref: string }[];
    const b1 = (await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku('RR-BAT')} and code = 'B1'`) as unknown as { id: string }[];
    expect(event.map((e) => e.batch_ref)).toEqual([b1[0]!.id]);
    // The snapshot names the line's picked batches.
    const snapshot = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    const open = (snapshot.body.openReturns as { id: string; lines: { batchCodes: string[] }[] }[]).find((item) => item.id === rma.id)!;
    expect(open.lines[0]!.batchCodes).toEqual(['B1']);
    const detail = await rmaDetail(rma.id);
    expect(detail.receipts![0]!.lines[0]!.batchCode).toBe('B1');
  });

  it("batch-and-serial (the classification, pure — a batch+serial SKU cannot be picked yet, pick.command's refusal): the serial's own pick batch applies; another serial's batch is batch-not-dispatched", () => {
    const line = { id: 'line-1', skuId: 'sku-bs', orderLineId: 'ol-1', serialIds: ['ser-1', 'ser-2'] };
    const ctx: ClassifyContext = {
      lineById: new Map([[line.id, line]]),
      skuFacts: new Map([['sku-bs', { batchTracked: true, serialTracked: true, catchWeightTracked: false, uom: 'pcs', uomPrecision: 0 }]]),
      remaining: new Map([[line.id, 2000]]),
      serialIdByEntry: new Map([
        [0, 'ser-1'],
        [1, 'ser-2'],
      ]),
      inStock: new Map(),
      receivedSerials: new Map(),
      picks: {
        batchIdsByOrderLine: new Map([['ol-1', new Set(['bat-L1', 'bat-L2'])]]),
        pickedMilliByLineBatch: new Map([
          ['ol-1:bat-L1', 1000],
          ['ol-1:bat-L2', 1000],
        ]),
        batchBySerial: new Map([['ser-1', 'bat-L1'], ['ser-2', 'bat-L2']]),
      },
      batchIdByCode: new Map([
        ['sku-bs:L1', 'bat-L1'],
        ['sku-bs:L2', 'bat-L2'],
      ]),
      receivedMilliByLineBatch: new Map(),
    };
    const entry = (serialNumber: string, batchCode: string) => ({
      rmaLineId: line.id,
      skuId: 'sku-bs',
      qty: 1,
      condition: 'resaleable' as const,
      note: null,
      batchCode,
      serialNumber,
      weightGrams: null,
    });
    expect(classifyReturnEntry(0, entry('X-1', 'L1'), ctx)).toMatchObject({ batchId: 'bat-L1', serialId: 'ser-1', milli: 1000 });
    // ser-1 was picked from L1 — L2 is another serial's batch.
    expect(classifyReturnEntry(0, entry('X-1', 'L2'), ctx)).toEqual({ reason: 'batch-not-dispatched' });
    expect(classifyReturnEntry(1, entry('X-2', 'L2'), ctx)).toMatchObject({ batchId: 'bat-L2', serialId: 'ser-2' });
    // A batch already returned up to what was picked from it is refused.
    expect(classifyReturnEntry(1, entry('X-2', 'L2'), { ...ctx, receivedMilliByLineBatch: new Map([['ol-1:bat-L2', 1000]]) })).toEqual({ reason: 'batch-not-dispatched' });
  });

  it('the classification (pure): batch over-claim, qty-precision, unexpected-capture, weight-out-of-range, missing-capture', () => {
    const line = { id: 'line-b', skuId: 'sku-b', orderLineId: 'ol-b', serialIds: [] as string[] };
    const facts = (over: Partial<{ batchTracked: boolean; catchWeightTracked: boolean; uomPrecision: number }>) => ({
      batchTracked: false, serialTracked: false, catchWeightTracked: false, uom: 'pcs', uomPrecision: 0, ...over,
    });
    const ctx = (sku: ReturnType<typeof facts>): ClassifyContext => ({
      lineById: new Map([[line.id, line]]),
      skuFacts: new Map([['sku-b', sku]]),
      remaining: new Map([[line.id, 10_000]]),
      serialIdByEntry: new Map(),
      inStock: new Map(),
      receivedSerials: new Map(),
      picks: {
        batchIdsByOrderLine: new Map([['ol-b', new Set(['b1', 'b2'])]]),
        pickedMilliByLineBatch: new Map([['ol-b:b1', 2000], ['ol-b:b2', 3000]]),
        batchBySerial: new Map(),
      },
      batchIdByCode: new Map([['sku-b:B1', 'b1'], ['sku-b:B2', 'b2']]),
      receivedMilliByLineBatch: new Map([['ol-b:b1', 1000]]),
    });
    const entry = (over: Partial<{ qty: number; batchCode: string | null; serialNumber: string | null; weightGrams: number | null }>) => ({
      rmaLineId: line.id, skuId: 'sku-b', qty: 1, condition: 'opened' as const, note: null,
      batchCode: null as string | null, serialNumber: null as string | null, weightGrams: null as number | null, ...over,
    });
    const batched = ctx(facts({ batchTracked: true }));
    // B1 picked 2, 1 already back: 1 more fits, 2 more do not — even though the line has 10 open.
    expect(classifyReturnEntry(0, entry({ batchCode: 'B1' }), batched)).toMatchObject({ batchId: 'b1', milli: 1000 });
    expect(classifyReturnEntry(0, entry({ qty: 2, batchCode: 'B1' }), batched)).toEqual({ reason: 'batch-not-dispatched' });
    expect(classifyReturnEntry(0, entry({ qty: 3, batchCode: 'B2' }), batched)).toMatchObject({ batchId: 'b2' });
    expect(classifyReturnEntry(0, entry({}), batched)).toEqual({ reason: 'missing-capture' });
    const plain = ctx(facts({}));
    expect(classifyReturnEntry(0, entry({ qty: 1.5 }), plain)).toEqual({ reason: 'qty-precision' });
    expect(classifyReturnEntry(0, entry({ batchCode: 'B1' }), plain)).toEqual({ reason: 'unexpected-capture' });
    expect(classifyReturnEntry(0, entry({ serialNumber: 'S-1' }), plain)).toEqual({ reason: 'unexpected-capture' });
    expect(classifyReturnEntry(0, entry({ weightGrams: 900 }), plain)).toEqual({ reason: 'unexpected-capture' });
    const caught = ctx(facts({ catchWeightTracked: true }));
    expect(classifyReturnEntry(0, entry({}), caught)).toEqual({ reason: 'missing-capture' });
    expect(classifyReturnEntry(0, entry({ weightGrams: 1_000_001 }), caught)).toEqual({ reason: 'weight-out-of-range' });
    expect(classifyReturnEntry(0, entry({ weightGrams: 2_340 }), caught)).toMatchObject({ milli: 1000 });
  });

  // ── catch weight ───────────────────────────────────────────────────────────

  it('catch-weight: one case at 2,340 g → a new `returned` handling unit (provenance the receipt line), which the snapshot does not list and pack cannot scan; no weight is missing-capture', async () => {
    const cases = await fixtures.seedCatchWeightCases(sku('RR-CW'), binId, [2_100, 2_200, 2_300]);
    const { orderId, returnable } = await dispatchedOrder([{ skuId: sku('RR-CW'), quantity: 1 }], { cases: [cases[0]!] });
    const rma = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-CW').orderLineId, qty: 1 }]);
    const line = rma.lines[0]!;
    const missing = await receive({ rmaId: rma.id, entries: [{ rmaLineId: line.id, skuId: sku('RR-CW'), qty: 1, condition: 'damaged' }] }).expect(201);
    expect(missing.body.refused).toEqual([{ entryIndex: 0, reason: 'missing-capture' }]);

    const res = await receive({ rmaId: rma.id, entries: [{ rmaLineId: line.id, skuId: sku('RR-CW'), qty: 1, condition: 'damaged', weightGrams: 2_340 }] }).expect(201);
    expect(res.body.applied).toHaveLength(1);
    const receiptLine = (await sql`select id, handling_unit_id from return_receipt_lines where return_receipt_id = ${res.body.returnReceiptId}`) as unknown as { id: string; handling_unit_id: string }[];
    const unit = (await sql`select status, weight_grams, grn_line_id, return_receipt_line_id, warehouse_id from handling_units where id = ${receiptLine[0]!.handling_unit_id}`) as unknown as {
      status: string;
      weight_grams: number;
      grn_line_id: string | null;
      return_receipt_line_id: string;
      warehouse_id: string;
    }[];
    expect(unit[0]).toEqual({ status: 'returned', weight_grams: 2_340, grn_line_id: null, return_receipt_line_id: receiptLine[0]!.id, warehouse_id: warehouseId });
    expect((await rmaDetail(rma.id)).receipts!.at(-1)!.lines[0]!.weightGrams).toBe(2_340);

    // Not in the snapshot's packable units.
    const snapshot = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    expect((snapshot.body.handlingUnits as { id: string }[]).map((u) => u.id)).not.toContain(receiptLine[0]!.handling_unit_id);
    // Pack refuses it on another order; the order packs with a live case.
    const { orderId: second, picklist } = await fixtures.releasedWave([{ skuId: sku('RR-CW'), quantity: 1 }]);
    await fixtures.pickAllLines(picklist);
    const refused = await http()
      .post(`${API}/${tenantId}/outbound/orders/${second}/pack`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned: [{ skuId: sku('RR-CW'), qty: 1, handlingUnitIds: [receiptLine[0]!.handling_unit_id] }] });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(((await sql`select status from handling_units where id = ${receiptLine[0]!.handling_unit_id}`) as unknown as { status: string }[])[0]!.status).toBe('returned');
    await http()
      .post(`${API}/${tenantId}/outbound/orders/${second}/pack`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ scanned: [{ skuId: sku('RR-CW'), qty: 1, handlingUnitIds: [cases[1]!] }] })
      .expect(201);
  });

  it('a catch-weight SKU whose only live units are `returned` cannot flip catchWeightTracked off (409)', async () => {
    const cases = await fixtures.seedCatchWeightCases(sku('RR-CW2'), binId, [3_000]);
    const { orderId, returnable } = await dispatchedOrder([{ skuId: sku('RR-CW2'), quantity: 1 }], { cases, cwSku: 'RR-CW2' });
    const rma = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-CW2').orderLineId, qty: 1 }]);
    await receive({ rmaId: rma.id, entries: [{ rmaLineId: rma.lines[0]!.id, skuId: sku('RR-CW2'), qty: 1, condition: 'opened', weightGrams: 2_990 }] }).expect(201);
    expect(await count(sql`select count(*)::int as n from handling_units where sku_id = ${sku('RR-CW2')} and status in ('active', 'pending_approval')`)).toBe(0);
    const refused = await http()
      .patch(`${API}/${tenantId}/catalog/skus/${sku('RR-CW2')}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ catchWeightTracked: false })
      .expect(409);
    expect(refused.body.detail).toContain('1 live handling unit');
  });

  // ── mixed parcel, all refused, the review queue ────────────────────────────

  it('mixed parcel: 2 authorized + 1 extra + 1 SKU not on the RMA → 2 apply; ONE review row holding the 2 refused entries with reasons; the rejected-op panel raise fires', async () => {
    const { orderId, returnable } = await dispatchedOrder([{ skuId: sku('RR-A'), quantity: 2 }]);
    const rma = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-A').orderLineId, qty: 2 }]);
    const lineId = rma.lines[0]!.id;
    const key = ulid();
    const occurredAt = nowUtc();
    const entries: Entry[] = [
      { rmaLineId: lineId, skuId: sku('RR-A'), qty: 1, condition: 'resaleable' },
      { rmaLineId: lineId, skuId: sku('RR-A'), qty: 1, condition: 'opened' },
      { rmaLineId: lineId, skuId: sku('RR-A'), qty: 1, condition: 'opened' },
      { rmaLineId: null, skuId: sku('RR-C'), qty: 1, condition: 'missing-parts', note: 'no box' },
    ];
    const res = await receive({ rmaId: rma.id, entries, occurredAt }, key).expect(201);
    const body = res.body as ReceiptBody;
    expect(body.applied.map((a) => a.entryIndex)).toEqual([0, 1]);
    expect(body.refused).toEqual([
      { entryIndex: 2, reason: 'exceeds-authorized' },
      { entryIndex: 3, reason: 'not-on-authorization' },
    ]);
    expect(body.rmaStatus).toBe('received');
    expect(body.reviewOpId).toBe(refusedEntriesOpId(key));
    expect(body.reviewOpId).not.toBe(key);
    expect(body.reviewOpId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const row = (await rejectedOpOf(body.reviewOpId!))!;
    expect(row).toMatchObject({ op_type: 'return.receive', problem_code: 'return-entries-refused', status: 'open', classification: 'rejected' });
    expect(row.payload).toMatchObject({
      warehouseId,
      rmaId: rma.id,
      rmaCode: rma.code,
      refusals: [
        { entryIndex: 2, reason: 'exceeds-authorized' },
        { entryIndex: 3, reason: 'not-on-authorization' },
      ],
    });
    expect((row.payload.entries as Entry[]).map((e) => [e.skuId, e.rmaLineId, e.note])).toEqual([
      [sku('RR-A'), lineId, null],
      [sku('RR-C'), null, 'no box'],
    ]);
    expect(row.attribution).toMatchObject({ deviceId, operatorId: operatorUserId, operatorEmail, deviceLabel: 'Returns dock scanner' });
    expect(await count(sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'device.rejected_op.raised' and payload->>'rejectedOpId' = ${row.id}`)).toBe(1);

    // A replay inserts no second row and raises nothing new.
    const replay = await receive({ rmaId: rma.id, entries, occurredAt }, key).expect(201);
    expect(replay.body).toEqual(body);
    expect(await count(sql`select count(*)::int as n from rejected_ops where tenant_id = ${tenantId} and op_type = 'return.receive' and payload->>'rmaId' = ${rma.id}`)).toBe(1);
  });

  it('all refused: no receipt row, RMA unchanged, one review row, the audit row targets the RMA', async () => {
    const { orderId, returnable } = await dispatchedOrder([{ skuId: sku('RR-B'), quantity: 1 }]);
    const rma = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-B').orderLineId, qty: 1 }]);
    const key = ulid();
    const res = await receive({ rmaId: rma.id, entries: [{ rmaLineId: null, skuId: sku('RR-C'), qty: 2, condition: 'damaged' }] }, key).expect(201);
    expect(res.body).toMatchObject({ returnReceiptId: null, code: null, rmaStatus: 'open', applied: [], refused: [{ entryIndex: 0, reason: 'not-on-authorization' }] });
    expect(await count(sql`select count(*)::int as n from return_receipts where tenant_id = ${tenantId} and rma_id = ${rma.id}`)).toBe(0);
    expect((await rmaDetail(rma.id)).status).toBe('open');
    expect(await rejectedOpOf(res.body.reviewOpId)).toBeDefined();
    await expectAuditRow({ tenantId, key, action: 'return_receipt.recorded', targetType: 'return_authorization', targetId: rma.id, actorUserId: operatorUserId });
  });

  it('review: a return.receive row offers Discard only — apply and recount are 409 decision-not-available; discard resolves it', async () => {
    const { orderId, returnable } = await dispatchedOrder([{ skuId: sku('RR-A'), quantity: 1 }]);
    const rma = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-A').orderLineId, qty: 1 }]);
    const res = await receive({ rmaId: rma.id, entries: [{ rmaLineId: rma.lines[0]!.id, skuId: sku('RR-A'), qty: 3, condition: 'opened' }] }).expect(201);
    const row = (await rejectedOpOf(res.body.reviewOpId))!;
    const listed = await http().get(`${API}/${tenantId}/rejected-ops?status=open&limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const item = (listed.body.items as { id: string; decisions: string[]; opType: string }[]).find((i) => i.id === row.id)!;
    expect(item).toMatchObject({ opType: 'return.receive', decisions: ['discard'] });
    for (const decision of ['apply', 'recount']) {
      const refused = await http()
        .post(`${API}/${tenantId}/rejected-ops/${row.id}/resolve`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision })
        .expect(409);
      expect(refused.body.code).toBe('decision-not-available');
      expect(refused.body.decisions).toEqual(['discard']);
      expect(refused.body.detail).toContain('create a return authorization for these units, then receive them again'.replace(/^c/, 'C'));
    }
    const discarded = await http()
      .post(`${API}/${tenantId}/rejected-ops/${row.id}/resolve`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'discard' })
      .expect(200);
    expect(discarded.body.rejectedOp).toMatchObject({ status: 'discarded', decisions: ['discard'] });
    // Discard books nothing.
    expect(await count(sql`select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and type = 'return.received' and reference_doc->>'rmaId' = ${rma.id}`)).toBe(0);
  });

  // Story 1-1 adds a second Discard-only type, the server-raised
  // `grn.lines-refused` (a blind receipt's line of another client); every
  // pre-13-2 type still keeps all three — the property this pins.
  // Story 1-2b adds a third server-raised type with its OWN rule, the
  // `grn.shelf-life-refused` row: apply (with a note) and discard, no recount.
  // The property this test pins — every pre-13-2 type keeps all three — is
  // unchanged; the new type is named here explicitly rather than folded in.
  // Story 1-4b adds a fourth server-raised type, `grn.inactive-sku-received`
  // (booked lines of an inactive SKU, flagged): Discard only (the web's
  // Acknowledge). Named explicitly, the same way.
  it('the per-type decision rule: every pre-13-2 op type keeps all three decisions; return.receive, grn.lines-refused and grn.inactive-sku-received only discard; grn.shelf-life-refused and (1-6d) grn.licence-refused apply + discard', () => {
    // Story 2-3a adds a device-uploaded Discard-only type, `gate-in.unload`
    // (a refused unload — re-applying would be refused again). Named here.
    const discardOnly = new Set(['return.receive', 'grn.lines-refused', 'grn.inactive-sku-received', 'gate-in.unload']);
    for (const type of REJECTED_OP_TYPES) {
      const expected =
        type === 'grn.shelf-life-refused' || type === 'grn.licence-refused'
          ? ['apply', 'discard']
          : discardOnly.has(type)
            ? ['discard']
            : ['apply', 'recount', 'discard'];
      expect(REJECTED_OP_DECISIONS_BY_TYPE[type]).toEqual(expected);
    }
  });

  it('a device-uploaded whole-op refusal of return.receive is accepted into the queue (its full payload)', async () => {
    const opId = ulid();
    await http()
      .post(`${API}/${tenantId}/devices/sync-reports`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        rows: [
          {
            opId,
            opType: 'return.receive',
            classification: 'rejected',
            problemCode: 'rma-not-receivable',
            problemDetail: 'Return authorization "RMA-0001" is cancelled',
            payload: { warehouseId, rmaId: uuidv7(), occurredAt: nowUtc(), entries: [{ rmaLineId: null, skuId: sku('RR-A'), qty: 1, condition: 'opened' }] },
            attribution: { deviceLabel: 'Returns dock scanner', operatorEmail },
            opEnqueuedAt: nowUtc(),
            opOccurredAt: nowUtc(),
          },
        ],
      })
      .expect(201);
    expect((await rejectedOpOf(opId))!.op_type).toBe('return.receive');
  });

  // ── whole-op refusals ──────────────────────────────────────────────────────

  it('wrong state / warehouse: a cancelled or received RMA is 409 rma-not-receivable; another warehouse is 409 document-warehouse-mismatch (before the status); an unknown RMA is 404', async () => {
    const { orderId, returnable } = await dispatchedOrder([
      { skuId: sku('RR-A'), quantity: 1 },
      { skuId: sku('RR-B'), quantity: 1 },
    ]);
    const cancelled = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-A').orderLineId, qty: 1 }]);
    await http().post(`${API}/${tenantId}/returns/${cancelled.id}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ reason: 'kept it' }).expect(200);
    const entry = (rma: RmaBody, code: string): Entry => ({ rmaLineId: rma.lines[0]!.id, skuId: sku(code), qty: 1, condition: 'opened' });
    expect((await receive({ rmaId: cancelled.id, entries: [entry(cancelled, 'RR-A')] }).expect(409)).body.code).toBe('rma-not-receivable');
    // Another warehouse beats the status.
    expect((await receive({ rmaId: cancelled.id, entries: [entry(cancelled, 'RR-A')], warehouseId: otherWarehouseId }).expect(409)).body.code).toBe('document-warehouse-mismatch');

    const received = await createRma(orderId, [{ orderLineId: lineOf(returnable, 'RR-B').orderLineId, qty: 1 }]);
    await receive({ rmaId: received.id, entries: [entry(received, 'RR-B')] }).expect(201);
    expect((await receive({ rmaId: received.id, entries: [entry(received, 'RR-B')] }).expect(409)).body.code).toBe('rma-not-receivable');
    expect((await receive({ rmaId: uuidv7(), entries: [entry(received, 'RR-B')] }).expect(404)).body.code).toBe('not-found');
  });

  it('shape: no entries, 151 entries, an unknown condition, a serial entry of 2, a note over 200 → 400 validation-failed (above the transaction)', async () => {
    const base: Entry = { rmaLineId: null, skuId: sku('RR-A'), qty: 1, condition: 'opened' };
    const rmaId = uuidv7();
    for (const entries of [
      [],
      Array.from({ length: 151 }, () => base),
      [{ ...base, condition: 'mint' }],
      [{ ...base, qty: 2, serialNumber: 'S-9' }],
      [{ ...base, note: 'x'.repeat(201) }],
      [{ ...base, qty: 2, weightGrams: 1000 }],
    ]) {
      const res = await receive({ rmaId, entries: entries as Entry[] }).expect(400);
      expect(res.body.code).toBe('validation-failed');
    }
  });

  it('device / role: a non-floor operator is 403 role-denied; a revoked device is 403 device-revoked (the GRN arms)', async () => {
    const second = await createMember('operator');
    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'Spare', pin: '1357' }).expect(201);
    const token = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: second.email, pin: '1357' })
        .expect(200)
    ).body.accessToken as string;
    const body = { rmaId: uuidv7(), entries: [{ rmaLineId: null, skuId: sku('RR-A'), qty: 1, condition: 'opened' }] };
    await sql`update users set role = 'accountant' where id = ${second.userId}`;
    expect((await receive(body, ulid(), token).expect(403)).body.code).toBe('role-denied');
    await sql`update devices set status = 'revoked' where id = ${enrolled.body.device.id as string}`;
    expect((await receive(body, ulid(), token).expect(403)).body.code).toBe('device-revoked');
  });

  // ── RETURNS protected, conflicts, ATP and reconcile ────────────────────────

  it('RETURNS is protected: an adjustment on it is refused; it cannot be a QC-hold origin; putaway cannot target it', async () => {
    const bin = await returnsBin();
    const adjusted = await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: sku('RR-A'), binId: bin, quantityDelta: -1, reasonCode: 'stock-count', note: 'scrap a return' })
      .expect(400);
    expect(adjusted.body.code).toBe('returns-bin-not-adjustable');
    expect(adjusted.body.detail).toContain('RETURNS');
    const held = await http()
      .post(`${API}/${tenantId}/receiving/qc-holds`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: sku('RR-A'), binId: bin, reason: 'inspect' })
      .expect(400);
    expect(held.body.detail).toContain('RETURNS');
    const grn = await http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, poId: null, blindReasonCode: 'unannounced-delivery', occurredAt: nowUtc(), lines: [{ poLineId: null, skuId: sku('RR-A'), batchCode: null, mfgDate: null, qty: 1 }] })
      .expect(201);
    const placed = await http()
      .post(`${API}/${tenantId}/putaway/placements`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, grnId: grn.body.goodsReceipt.id, grnLineId: grn.body.goodsReceipt.lines[0].id, skuId: sku('RR-A'), toBinId: bin, qty: 1, occurredAt: nowUtc() });
    expect(placed.status).toBe(400);
  });

  it('bin conflict: RETURNS is a reserved zone/bin code at create (409 reserved-location-code); a collision that predates the rule is 409 returns-bin-conflict (never adopted); a renamed system zone breeds no stray zone', async () => {
    const db = app.get<Database>(DATABASE);
    const withBin = await createWarehouse('RB');
    const zone = (
      await http().post(`${API}/${tenantId}/warehouses/${withBin}/zones`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'Z', name: 'Z' }).expect(201)
    ).body.id as string;
    const reservedBin = await http()
      .post(`${API}/${tenantId}/warehouses/${withBin}/zones/${zone}/bins`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ capacity: 10, type: 'shelf', code: 'RETURNS' })
      .expect(409);
    expect(reservedBin.body.code).toBe('reserved-location-code');
    const reservedZone = await http()
      .post(`${API}/${tenantId}/warehouses/${withBin}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'RETURNS', name: 'Our returns' })
      .expect(409);
    expect(reservedZone.body.code).toBe('reserved-location-code');

    // Collisions that predate the rule (seeded below the API).
    await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned) values (${uuidv7()}, ${tenantId}, ${withBin}, ${zone}, 'RETURNS', 10000, 'shelf', false)`;
    await expect(withTenantTransaction(db, tenantId, (tx) => ensureReturnsBinInTx(tx, tenantId, withBin))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'returns-bin-conflict' }),
    });
    const withZone = await createWarehouse('RZ');
    await sql`insert into zones (id, tenant_id, warehouse_id, code, name) values (${uuidv7()}, ${tenantId}, ${withZone}, 'RETURNS', 'Our returns')`;
    await expect(withTenantTransaction(db, tenantId, (tx) => ensureReturnsBinInTx(tx, tenantId, withZone))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'returns-bin-conflict' }),
    });
    // Nothing was adopted: no system RETURNS bin exists in either warehouse.
    expect(await count(sql`select count(*)::int as n from bins where warehouse_id in (${withBin}, ${withZone}) and code = 'RETURNS' and system_owned`)).toBe(0);

    // A fresh warehouse ensures cleanly, and a second ensure re-selects the same bin.
    const fresh = await createWarehouse('RF');
    const first = await withTenantTransaction(db, tenantId, (tx) => ensureReturnsBinInTx(tx, tenantId, fresh));
    const again = await withTenantTransaction(db, tenantId, (tx) => ensureReturnsBinInTx(tx, tenantId, fresh));
    expect(again).toEqual(first);
    // The system zone renamed: the bin keeps its zone, and no stray RETURNS zone appears.
    await sql`update zones set code = 'RETURNS-OLD' where id = ${first.zoneId}`;
    const renamed = await withTenantTransaction(db, tenantId, (tx) => ensureReturnsBinInTx(tx, tenantId, fresh));
    expect(renamed).toEqual(first);
    expect(await count(sql`select count(*)::int as n from zones where warehouse_id = ${fresh} and code = 'RETURNS'`)).toBe(0);
  });

  it('ATP: stock in RETURNS is excluded from ATP, the grant ceiling and the channel-visible figure; projection and replay reconcile', async () => {
    const skuA = sku('RR-A');
    const bin = await returnsBin();
    const inReturns = await onHandIn(bin, skuA);
    expect(inReturns).toBeGreaterThan(0);
    const atp = await inventory.atp(tenantId, warehouseId, skuA);
    expect(atp.returnsAwaiting).toBe(inReturns);
    expect(atp.atp).toBe(Math.max(0, atp.onHand - atp.reserved - atp.qcHeld - atp.inTransit - atp.returnsAwaiting));
    const visible = await inventory.channelVisibleQuantity(tenantId, warehouseId, skuA, uuidv7());
    expect(visible.returnsAwaiting).toBe(inReturns);
    expect(visible.poolAtp).toBe(atp.atp);
    // The ceiling: an order for exactly the sellable quantity plus one unit
    // goes backordered on that unit — the RETURNS stock is never granted.
    const sellable = atp.atp / 1000;
    const order = await http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines: [{ skuId: skuA, quantity: sellable + 1 }], destination: testAddress() })
      .expect(201);
    expect(JSON.stringify(order.body)).toMatch(/backorder/i);
    const after = await inventory.atp(tenantId, warehouseId, skuA);
    expect(after.returnsAwaiting).toBe(inReturns);
    // The ledger replays to the projections, RETURNS included.
    const replay = await inventory.replay(tenantId, warehouseId);
    expect(replay.divergences).toEqual([]);
    expect(replay.matches).toBe(true);
    const reconcile = await inventory.reconcile(tenantId, warehouseId);
    expect(reconcile.divergences).toEqual([]);
  });

  // ── vocabularies, the fingerprint, the CHECKs, the routes ──────────────────

  it('RETURN_CONDITIONS and the widened RMA_STATUSES are pinned against their CHECKs', async () => {
    const def = async (name: string) =>
      ((await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`) as unknown as { def: string }[])[0]!.def;
    const conditions = await def('return_receipt_lines_condition_check');
    expect([...conditions.matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1]).sort()).toEqual([...RETURN_CONDITIONS].sort());
    const statuses = await def('return_authorizations_status_check');
    expect([...statuses.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort()).toEqual([...RMA_STATUSES].sort());
  });

  it('each new 0073 CHECK refuses what it must (23514), below the API', async () => {
    const t = uuidv7();
    const refused = (statement: PromiseLike<unknown>, constraint: string) =>
      expect(Promise.resolve(statement)).rejects.toMatchObject({ code: '23514', constraint_name: constraint });
    const line = (extra: { qty?: number; condition?: string; note?: string | null; serial?: string | null; unit?: string | null }) =>
      sql`insert into return_receipt_lines (id, tenant_id, return_receipt_id, rma_line_id, sku_id, line_no, qty, condition, note, serial_id, handling_unit_id, ledger_event_id)
          values (${uuidv7()}, ${t}, ${t}, ${uuidv7()}, ${t}, 1, ${extra.qty ?? 1000}, ${extra.condition ?? 'opened'}, ${extra.note ?? null}, ${extra.serial ?? null}, ${extra.unit ?? null}, ${t})`;
    await refused(line({ qty: 0 }), 'return_receipt_lines_qty_positive');
    await refused(line({ condition: 'mint' }), 'return_receipt_lines_condition_check');
    await refused(line({ note: ' x ' }), 'return_receipt_lines_note_length');
    await refused(line({ serial: uuidv7(), unit: uuidv7() }), 'return_receipt_lines_identity_shape');
    await refused(line({ qty: 2000, serial: uuidv7() }), 'return_receipt_lines_serial_one_unit');
    await refused(
      sql`insert into return_authorization_lines (id, tenant_id, rma_id, line_no, order_line_id, sku_id, authorized_qty, received_qty, reason_code)
          values (${uuidv7()}, ${t}, ${t}, 1, ${uuidv7()}, ${t}, 1000, 1001, 'damaged')`,
      'return_authorization_lines_received_within_authorized',
    );
    await refused(
      sql`insert into handling_units (id, tenant_id, warehouse_id, sku_id, weight_grams, status) values (${uuidv7()}, ${t}, ${t}, ${t}, 100, 'returned')`,
      'handling_units_provenance',
    );
  });

  it('the receipt fingerprint is pinned: arm first, the whole body, entries in request order, every key present (rmaLineId an explicit null)', () => {
    const normalized = normalizeReceive({
      warehouseId: '01900000-0000-7000-8000-0000000000AA',
      rmaId: '01900000-0000-7000-8000-0000000000bb',
      occurredAt: '2026-10-16T10:00:00Z',
      entries: [
        { rmaLineId: '01900000-0000-7000-8000-0000000000c1', skuId: '01900000-0000-7000-8000-0000000000d1', qty: 1, condition: 'opened', note: '  torn  ', serialNumber: ' S-1 ' },
        { skuId: '01900000-0000-7000-8000-0000000000d2', qty: 2.5, condition: 'resaleable' },
      ],
    });
    const golden = hashCommandPayload({
      arm: 'return-receive',
      tenantId: 't-1',
      deviceId: 'd-1',
      operatorUserId: 'u-1',
      warehouseId: '01900000-0000-7000-8000-0000000000aa',
      rmaId: '01900000-0000-7000-8000-0000000000bb',
      occurredAt: '2026-10-16T10:00:00Z',
      entries: [
        { rmaLineId: '01900000-0000-7000-8000-0000000000c1', skuId: '01900000-0000-7000-8000-0000000000d1', qty: 1, condition: 'opened', note: 'torn', batchCode: null, serialNumber: 'S-1', weightGrams: null },
        { rmaLineId: null, skuId: '01900000-0000-7000-8000-0000000000d2', qty: 2.5, condition: 'resaleable', note: null, batchCode: null, serialNumber: null, weightGrams: null },
      ],
    });
    expect(receivePayloadHash('t-1', 'd-1', 'u-1', normalized)).toBe(golden);
    // Entry order matters (the receipt's line order).
    const swapped = { ...normalized, entries: [...normalized.entries].reverse() };
    expect(receivePayloadHash('t-1', 'd-1', 'u-1', swapped)).not.toBe(golden);
    // The derived review op id: a ULID on the key's timestamp, never the key.
    const key = '01JABCDEFGHJKMNPQRSTVWXYZ0';
    expect(refusedEntriesOpId(key)).toMatch(/^01JABCDEFG[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(refusedEntriesOpId(key)).not.toBe(key);
    expect(refusedEntriesOpId(key)).toBe(refusedEntriesOpId(key));
  });

  it('the OpenAPI document lists the receipt route, and the snapshot carries openReturns', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    expect(Object.keys(doc.body.paths as Record<string, unknown>)).toContain('/tenants/{tenantId}/returns/receipts');
    expect(Object.keys(doc.body.components.schemas.CatalogSnapshotResponse.properties as Record<string, unknown>)).toContain('openReturns');
  });

  // ── RLS ────────────────────────────────────────────────────────────────────

  describe('client isolation (wms_rls_probe)', () => {
    let probe: postgres.Sql<Record<string, unknown>>;

    beforeAll(async () => {
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
      probe = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    });

    afterAll(async () => {
      await probe?.end();
    });

    function stamped(tenant: string, client: string | null, run: (tx: postgres.TransactionSql<Record<string, unknown>>) => PromiseLike<unknown>): Promise<number> {
      return probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenant}, true)`;
        if (client !== null) await tx`select set_config('app.client_id', ${client}, true)`;
        const rows = (await run(tx)) as { n: number }[];
        return Number(rows[0]!.n);
      }) as Promise<number>;
    }

    it("another client's or another tenant's session sees no receipt or receipt line; the owning client and an operator session do", async () => {
      const [owned] = (await sql`select id, client_id from return_receipts where tenant_id = ${tenantId} limit 1`) as unknown as { id: string; client_id: string }[];
      const headers = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`select count(*)::int as n from return_receipts where id = ${owned!.id}`;
      const lines = (tx: postgres.TransactionSql<Record<string, unknown>>) =>
        tx`select count(*)::int as n from return_receipt_lines where return_receipt_id = ${owned!.id}`;
      expect(await stamped(tenantId, uuidv7(), headers)).toBe(0);
      expect(await stamped(tenantId, uuidv7(), lines)).toBe(0);
      expect(await stamped(tenantId, owned!.client_id, headers)).toBe(1);
      expect(await stamped(tenantId, owned!.client_id, lines)).toBeGreaterThan(0);
      expect(await stamped(tenantId, null, headers)).toBe(1);
      expect(await stamped(uuidv7(), null, headers)).toBe(0);
      expect(await stamped(uuidv7(), null, lines)).toBe(0);
    });
  });
});
