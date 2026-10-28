import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { istDateOf } from '../src/shared/primitives/time';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { signTenantSession } from '../src/modules/tenancy/jwt-session';
import { LPN_STATUSES, LPN_VOID_REASON_CODES } from '../src/modules/inbound/lpn.store';
import { lpnLabelsFilename } from '../src/modules/inbound/lpn-labels';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { createLinkedVendor, linkVendor } from './support/linked-vendor';
import { expectAuditRow } from './support/audit-guard';
import { parseZplLabels, readPdfLabels } from './support/labels';

// Story 2-10b — LPN labels at receiving: mint a licence plate per pallet or
// carton of a GRN line (the cap, the bounds, the number), list, print as ZPL
// or PDF (every decoded barcode is its code), void, and the putaway
// placement that consumes an LPN (`lpnCode`, the conditional hash key, the
// two 400s). Every matrix row, both races, the audit rows, RLS and the
// OpenAPI paths.
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
const PASSWORD = 'correct-horse-battery';
const OCCURRED_AT = '2026-10-27T04:30:00.000Z';

interface Lpn {
  id: string;
  code: string;
  grnId: string;
  grnLineId: string;
  skuId: string;
  skuCode: string;
  batchId: string | null;
  batchCode: string | null;
  clientId: string;
  qty: number;
  status: string;
  placedAt: string | null;
  voidedAt: string | null;
  voidReasonCode: string | null;
  voidNote: string | null;
}

interface Grn {
  id: string;
  code: string;
  lines: { id: string; skuId: string; qty: number; appliedQty: number }[];
}

interface Task {
  grnId: string;
  grnLineId: string;
  skuId: string;
  qty: number;
  suggestedBin: { binId: string; binCode: string } | null;
  lpns: { code: string; qty: number }[];
}

/** supertest: collect the body as raw bytes, whatever the content type. */
function binary(res: NodeJS.ReadableStream, done: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

describe('story 2-10b: LPN labels at receiving (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  let tenantId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let wh: string;
  let vendorId: string;
  let acmeId: string;
  let selfClientId: string;
  let deviceId: string;
  let operatorToken: string;
  let operatorUserId: string;
  let accountantToken: string;
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const sku = (code: string): string => {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('lpns');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `LPN Co ${ulid()}`, ownerEmail: email, password: PASSWORD }).expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;

    wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `LP-${ulid().slice(20)}`, name: 'LPN warehouse' })
        .expect(201)
    ).body.id as string;
    const zone = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    for (const code of ['S-01', 'S-02', 'S-03']) {
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones/${zone}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, capacity: 1_000_000, type: 'shelf' })
        .expect(201);
    }
    vendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: 'V-LPN', name: 'LPN Vendor' });
    const acme = await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'ACME', name: 'Acme Brands' }).expect(201);
    acmeId = acme.body.client.id as string;
    await linkVendor(app, tenantId, ownerToken, vendorId, acmeId);
    selfClientId = ((await sql`select id from clients where tenant_id = ${tenantId} and system_owned`) as unknown as { id: string }[])[0]!.id;

    // code, uom, batch, serial
    await importSkus(acmeId, [
      ['L-A', 'pcs', false],
      ['L-B', 'pcs', true],
      ['L-KG', 'kg', false],
      ['L-BIG', 'pcs', false],
      ['L-RACE', 'pcs', false],
      ['L-EX', 'pcs', false],
    ]);
    await importSkus(selfClientId, [['L-SELF', 'pcs', false]]);

    const operatorEmail = await member('operator');
    accountantToken = await signIn(await member('accountant'));
    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({}).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'LPN dock', pin: '2468' }).expect(201);
    deviceId = enrolled.body.device.id as string;
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail, pin: '2468' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
    operatorUserId = badged.body.operator.id as string;
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

  async function signIn(email: string): Promise<string> {
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
  }

  async function member(role: 'operator' | 'accountant' | 'ops_manager'): Promise<string> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return email;
  }

  async function importSkus(clientId: string, rows: readonly (readonly [string, string, boolean])[]): Promise<void> {
    const csv = [
      'sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked,catch_weight_tracked',
      ...rows.map(([code, uom, batch]) => `${code},${code} name,${uom},1800,${code}-BC,${batch},false,false`),
    ].join('\n');
    const res = await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    expect(res.body).toMatchObject({ committedRows: rows.length, failedRows: 0 });
    const stored = (await sql`select id, code from skus where tenant_id = ${tenantId} and client_id = ${clientId}`) as unknown as { id: string; code: string }[];
    for (const row of stored) skuIds.set(row.code, row.id);
  }

  type LineIn = { skuId: string; qty: number; batchCode?: string | null; expiryDate?: string; damagedQty?: number; damageReasonCode?: string; poLineId?: string };

  async function receiveBlind(clientId: string | null, lines: LineIn[]): Promise<Grn> {
    const res = await http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: wh,
        occurredAt: OCCURRED_AT,
        poId: null,
        blindReasonCode: 'other',
        ...(clientId === null ? {} : { clientId }),
        lines: lines.map((line) => ({ batchCode: null, mfgDate: null, ...line })),
      })
      .expect(201);
    return res.body.goodsReceipt as Grn;
  }

  function mint(grnId: string, lines: { grnLineId: string; quantities: number[] }[], key = ulid(), token = ownerToken): request.Test {
    return http().post(`${API}/${tenantId}/receiving/goods-receipts/${grnId}/lpns`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({ lines });
  }

  async function minted(grnId: string, lines: { grnLineId: string; quantities: number[] }[]): Promise<Lpn[]> {
    return (await mint(grnId, lines).expect(201)).body.lpns as Lpn[];
  }

  function list(grnId: string, token = ownerToken): request.Test {
    return http().get(`${API}/${tenantId}/receiving/goods-receipts/${grnId}/lpns`).set('Authorization', `Bearer ${token}`);
  }

  function voidLpn(grnId: string, lpnId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken): request.Test {
    return http().post(`${API}/${tenantId}/receiving/goods-receipts/${grnId}/lpns/${lpnId}/void`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function print(grnId: string, body: Record<string, unknown>, token = ownerToken): request.Test {
    return http()
      .post(`${API}/${tenantId}/receiving/goods-receipts/${grnId}/lpns/labels`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .buffer(true)
      .parse(binary as never);
  }

  async function refusal(res: request.Test, status: number): Promise<Record<string, unknown>> {
    const r = await res;
    expect(r.status).toBe(status);
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    return JSON.parse((r.body as Buffer).toString('utf8')) as Record<string, unknown>;
  }

  async function tasks(): Promise<Task[]> {
    return (await http().get(`${API}/${tenantId}/putaway/tasks`).query({ warehouseId: wh }).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.items as Task[];
  }

  function taskOf(all: Task[], grnLineId: string): Task | undefined {
    return all.find((task) => task.grnLineId === grnLineId);
  }

  function placement(task: Task, qty: number, extra: Record<string, unknown> = {}) {
    return {
      warehouseId: wh,
      grnId: task.grnId,
      grnLineId: task.grnLineId,
      skuId: task.skuId,
      batchId: null,
      qty,
      toBinId: task.suggestedBin!.binId,
      reasonCode: null,
      occurredAt: OCCURRED_AT,
      serials: null,
      ...extra,
    };
  }

  function place(body: Record<string, unknown>, key = ulid()): request.Test {
    return http().post(`${API}/${tenantId}/putaway/placements`).set('Authorization', `Bearer ${operatorToken}`).set(KEY_HEADER, key).send(body);
  }

  async function lpnRow(id: string): Promise<Record<string, unknown>> {
    return ((await sql`select status, qty::text as qty, placed_at, placement_id, voided_at, voided_by, void_reason_code, void_note from lpns where id = ${id}`) as unknown as Record<string, unknown>[])[0]!;
  }

  async function lpnCount(where: { grnId: string }): Promise<number> {
    return Number(((await sql`select count(*)::int as n from lpns where tenant_id = ${tenantId} and grn_id = ${where.grnId}`) as unknown as { n: number }[])[0]!.n);
  }

  async function keyRows(key: string): Promise<number> {
    return Number(((await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { n: number }[])[0]!.n);
  }

  // ── the matrix: mint ───────────────────────────────────────────────────────

  let mainGrn: Grn;
  let mainLpns: Lpn[];
  let mintKey: string;

  describe('mint', () => {
    it('mint one line: [40,40,20] on a 100 line → 201, LPN-000001..3 in request order; audit lpn.minted', async () => {
      mainGrn = await receiveBlind(acmeId, [{ skuId: sku('L-A'), qty: 100 }]);
      mintKey = ulid();
      const res = await mint(mainGrn.id, [{ grnLineId: mainGrn.lines[0]!.id, quantities: [40, 40, 20] }], mintKey).expect(201);
      mainLpns = res.body.lpns as Lpn[];
      expect(res.body.grnId).toBe(mainGrn.id);
      expect(mainLpns.map((l) => [l.code, l.qty, l.status])).toEqual([
        ['LPN-000001', 40, 'active'],
        ['LPN-000002', 40, 'active'],
        ['LPN-000003', 20, 'active'],
      ]);
      expect(mainLpns[0]).toMatchObject({ grnLineId: mainGrn.lines[0]!.id, skuId: sku('L-A'), skuCode: 'L-A', batchId: null, batchCode: null, clientId: acmeId, placedAt: null, voidedAt: null });
      // Milli-units below the command line; the seq beside the code.
      expect(await sql`select seq::int as seq, qty::text as qty from lpns where grn_id = ${mainGrn.id} order by seq`).toEqual([
        { seq: 1, qty: '40000' },
        { seq: 2, qty: '40000' },
        { seq: 3, qty: '20000' },
      ]);
      await expectAuditRow({ tenantId, key: mintKey, action: 'lpn.minted', targetType: 'goods_receipt', targetId: mainGrn.id, actorUserId: ownerUserId });
      // No ledger event, no outbox event: an LPN moves no stock.
      expect(await sql`select 1 from ledger_events where tenant_id = ${tenantId} and reference_doc::text like ${'%' + mainLpns[0]!.id + '%'}`).toHaveLength(0);
      expect(await sql`select 1 from outbox_messages where tenant_id = ${tenantId} and type like 'lpn%'`).toHaveLength(0);
    });

    it('mint replay: same key, same body → the stored 201, byte-identical; no new rows; same key, another body → 422', async () => {
      const replay = await mint(mainGrn.id, [{ grnLineId: mainGrn.lines[0]!.id, quantities: [40, 40, 20] }], mintKey).expect(201);
      expect(replay.body).toEqual({ grnId: mainGrn.id, lpns: mainLpns });
      expect(await lpnCount({ grnId: mainGrn.id })).toBe(3);
      await expectAuditRow({ tenantId, key: mintKey, action: 'lpn.minted', targetType: 'goods_receipt', targetId: mainGrn.id, actorUserId: ownerUserId });
      // An upper-cased id is the same request (ids are lower-cased before the hash).
      await mint(mainGrn.id.toUpperCase(), [{ grnLineId: mainGrn.lines[0]!.id.toUpperCase(), quantities: [40, 40, 20] }], mintKey).expect(201);
      expect((await mint(mainGrn.id, [{ grnLineId: mainGrn.lines[0]!.id, quantities: [40, 40] }], mintKey).expect(422)).body.code).toBe('idempotency-key-reuse');
    });

    it('the list: every LPN of the receipt in code order — open to any member (the accountant reads it)', async () => {
      const res = await list(mainGrn.id, accountantToken).expect(200);
      expect((res.body.items as Lpn[]).map((l) => l.code)).toEqual(['LPN-000001', 'LPN-000002', 'LPN-000003']);
      expect(res.body.items).toEqual(mainLpns);
      expect((await list(uuidv7()).expect(404)).body.code).toBe('not-found');
      expect((await list('not-a-uuid').expect(400)).body.code).toBe('validation-failed');
    });

    it('over the cap: 90 labelled on a 100 line, [20] → 422 lpn-quantity-exceeds-line (remaining 10)', async () => {
      const grn = await receiveBlind(acmeId, [{ skuId: sku('L-A'), qty: 100 }]);
      await minted(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [50, 40] }]);
      const res = await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [20] }]).expect(422);
      expect(res.body).toMatchObject({ code: 'lpn-quantity-exceeds-line', remaining: 10, putawayQty: 100, labelled: 90, grnLineId: grn.lines[0]!.id });
      // Exactly the rest is accepted.
      await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [10] }]).expect(201);
      expect((await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [1] }]).expect(422)).body).toMatchObject({ remaining: 0 });
    });

    it('nothing to label: an all-damaged line (good qty 0) → 422 lpn-quantity-exceeds-line (remaining 0)', async () => {
      const grn = await receiveBlind(acmeId, [{ skuId: sku('L-A'), qty: 0, damagedQty: 5, damageReasonCode: 'crushed' }]);
      const res = await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [1] }]).expect(422);
      expect(res.body).toMatchObject({ code: 'lpn-quantity-exceeds-line', remaining: 0 });
    });

    it('fractional: a kg SKU takes [12.5, 7.5]; [12.5, 0.0015] is the precision 400 naming quantities; [12.5, 0.0004] is the DTO 400; a pcs SKU refuses 1.5', async () => {
      const grn = await receiveBlind(acmeId, [{ skuId: sku('L-KG'), qty: 25 }, { skuId: sku('L-EX'), qty: 5 }]);
      const precise = await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [12.5, 0.0015] }]).expect(400);
      expect(precise.body.code).toBe('validation-failed');
      expect(precise.body.detail).toContain('quantities');
      const tiny = await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [12.5, 0.0004] }]).expect(400);
      expect(tiny.body.code).toBe('validation-failed');
      expect(JSON.stringify(tiny.body)).toContain('quantities');
      const whole = await mint(grn.id, [{ grnLineId: grn.lines[1]!.id, quantities: [1.5] }]).expect(400);
      expect(whole.body.detail).toContain('quantities');
      const ok = await minted(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [12.5, 7.5] }]);
      expect(ok.map((l) => l.qty)).toEqual([12.5, 7.5]);
      expect((await sql`select qty::text as qty from lpns where grn_id = ${grn.id} order by seq`).map((r) => r.qty)).toEqual(['12500', '7500']);
    });

    it('line not of the GRN → 404; unknown GRN → 404; shape: a line twice, more than 1000 labels, a missing key → 400', async () => {
      const other = await receiveBlind(acmeId, [{ skuId: sku('L-A'), qty: 3 }]);
      expect((await mint(mainGrn.id, [{ grnLineId: other.lines[0]!.id, quantities: [1] }]).expect(404)).body.code).toBe('not-found');
      expect((await mint(uuidv7(), [{ grnLineId: other.lines[0]!.id, quantities: [1] }]).expect(404)).body.code).toBe('not-found');
      expect((await mint(other.id, [{ grnLineId: other.lines[0]!.id, quantities: [1] }, { grnLineId: other.lines[0]!.id.toUpperCase(), quantities: [1] }]).expect(400)).body.code).toBe('validation-failed');
      const big = Array.from({ length: 501 }, () => 1);
      expect((await mint(other.id, [{ grnLineId: other.lines[0]!.id, quantities: big }, { grnLineId: mainGrn.lines[0]!.id, quantities: big }]).expect(400)).body.detail).toContain('1000');
      await http().post(`${API}/${tenantId}/receiving/goods-receipts/${other.id}/lpns`).set('Authorization', `Bearer ${ownerToken}`).send({ lines: [{ grnLineId: other.lines[0]!.id, quantities: [1] }] }).expect(400);
      expect(await lpnCount({ grnId: other.id })).toBe(0);
    });

    it('pending excess is not labellable; approved, it is: applied 100 + 20 pending, [60,60] → 422 (remaining 100); approve, [20] after 100 → 201', async () => {
      const po = await http()
        .post(`${API}/${tenantId}/inbound/purchase-orders`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, vendorId, code: `PO-${ulid().slice(14)}`, lines: [{ skuId: sku('L-A'), orderedQty: 100, unitCostPaise: 100 }] })
        .expect(201);
      const poId = po.body.purchaseOrder.id as string;
      const poLineId = po.body.purchaseOrder.lines[0].id as string;
      const res = await http()
        .post(`${API}/${tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, occurredAt: OCCURRED_AT, poId, blindReasonCode: null, lines: [{ poLineId, skuId: sku('L-A'), batchCode: null, mfgDate: null, qty: 120 }] })
        .expect(201);
      const grn = res.body.goodsReceipt as Grn;
      expect(grn.lines[0]).toMatchObject({ qty: 120, appliedQty: 100 });
      const refused = await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [60, 60] }]).expect(422);
      expect(refused.body).toMatchObject({ code: 'lpn-quantity-exceeds-line', remaining: 100 });
      await minted(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [60, 40] }]);
      expect((await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [20] }]).expect(422)).body).toMatchObject({ remaining: 0 });
      const overReceiptId = ((await sql`select id from over_receipts where tenant_id = ${tenantId} and grn_id = ${grn.id}`) as unknown as { id: string }[])[0]!.id;
      await http()
        .post(`${API}/${tenantId}/receiving/over-receipts/${overReceiptId}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .expect(200);
      const approved = await minted(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [20] }]);
      expect(approved.map((l) => l.qty)).toEqual([20]);
    });

    it('the client line: a batch with an expiry prints B/EXP, a client SKU prints CLIENT, the tenant\'s own prints none', async () => {
      const grn = await receiveBlind(acmeId, [{ skuId: sku('L-B'), qty: 10, batchCode: 'B-77', expiryDate: '2027-04-30' }]);
      const own = await receiveBlind(null, [{ skuId: sku('L-SELF'), qty: 4 }]);
      const [batched] = await minted(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [10] }]);
      expect(batched).toMatchObject({ batchCode: 'B-77', clientId: acmeId });
      const [mine] = await minted(own.id, [{ grnLineId: own.lines[0]!.id, quantities: [4] }]);
      expect(mine!.clientId).toBe(selfClientId);
      const zpl = ((await print(grn.id, { format: 'zpl' }).expect(200)).body as Buffer).toString('ascii');
      expect(zpl).toContain(`^FDL-B x 10 each^FS`);
      expect(zpl).toContain(`^FD${grn.code} | B B-77 EXP 2027-04-30 | CLIENT ACME^FS`);
      const ownZpl = ((await print(own.id, { format: 'zpl' }).expect(200)).body as Buffer).toString('ascii');
      expect(ownZpl).toContain(`^FD${own.code}^FS`);
      expect(ownZpl).not.toContain('CLIENT');
    });
  });

  // ── the matrix: print ──────────────────────────────────────────────────────

  describe('print', () => {
    it('print all: ZPL with no ids → every non-voided LPN of the GRN in code order; each decoded barcode is its code', async () => {
      const res = await print(mainGrn.id, { format: 'zpl' }).expect(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=us-ascii');
      expect(res.headers['cache-control']).toBe('no-store');
      const today = istDateOf(new Date().toISOString()).replace(/-/g, '');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="lpn-labels-${mainGrn.code}-${today}.zpl"`);
      const labels = parseZplLabels((res.body as Buffer).toString('ascii'));
      expect(labels.map((l) => l.payload)).toEqual(['LPN-000001', 'LPN-000002', 'LPN-000003']);
      expect(labels[0]!.raw).toContain('^FDL-A x 40 each^FS');
      expect(labels[0]!.raw).toContain(`^FD${mainGrn.code} | CLIENT ACME^FS`);
    });

    it('PDF (label 4x2, 2x1 and A4): the decoded bars are the codes, in code order', async () => {
      for (const body of [{ format: 'pdf' }, { format: 'pdf', size: '2x1' }, { format: 'pdf', layout: 'a4' }]) {
        const res = await print(mainGrn.id, body).expect(200);
        expect(res.headers['content-type']).toBe('application/pdf');
        const pages = await readPdfLabels(res.body as Buffer);
        expect(pages.flatMap((p) => p.payloads)).toEqual(['LPN-000001', 'LPN-000002', 'LPN-000003']);
      }
    });

    it('reprint: lpnIds of 2 → the same 2 codes, unchanged, in code order; by line → the line\'s', async () => {
      const res = await print(mainGrn.id, { format: 'zpl', lpnIds: [mainLpns[2]!.id, mainLpns[0]!.id.toUpperCase()] }).expect(200);
      expect(parseZplLabels((res.body as Buffer).toString('ascii')).map((l) => l.payload)).toEqual(['LPN-000001', 'LPN-000003']);
      const byLine = await print(mainGrn.id, { format: 'zpl', grnLineId: mainGrn.lines[0]!.id }).expect(200);
      expect(parseZplLabels((byLine.body as Buffer).toString('ascii'))).toHaveLength(3);
      expect(await lpnRow(mainLpns[0]!.id)).toMatchObject({ status: 'active' });
    });

    it('the refusals: 404 no-lpns-to-print, 404 for another receipt\'s LPN or line, the cross-field 400s', async () => {
      const empty = await receiveBlind(acmeId, [{ skuId: sku('L-A'), qty: 1 }]);
      expect(await refusal(print(empty.id, { format: 'zpl' }), 404)).toMatchObject({ code: 'no-lpns-to-print' });
      expect(await refusal(print(empty.id, { format: 'zpl', grnLineId: empty.lines[0]!.id }), 404)).toMatchObject({ code: 'no-lpns-to-print' });
      expect(await refusal(print(empty.id, { format: 'zpl', lpnIds: [mainLpns[0]!.id] }), 404)).toMatchObject({ code: 'not-found' });
      expect(await refusal(print(empty.id, { format: 'zpl', grnLineId: mainGrn.lines[0]!.id }), 404)).toMatchObject({ code: 'not-found' });
      expect(await refusal(print(uuidv7(), { format: 'zpl' }), 404)).toMatchObject({ code: 'not-found' });
      for (const body of [
        { format: 'zpl', lpnIds: [mainLpns[0]!.id], grnLineId: mainGrn.lines[0]!.id },
        { format: 'zpl', lpnIds: [mainLpns[0]!.id, mainLpns[0]!.id.toUpperCase()] },
        { format: 'zpl', layout: 'a4' },
        { format: 'pdf', layout: 'a4', size: '2x1' },
        { format: 'gif' },
      ]) {
        expect(await refusal(print(mainGrn.id, body), 400)).toMatchObject({ code: 'validation-failed' });
      }
    });

    it('the filename: IST date, the GRN code folded to [A-Za-z0-9._-]', () => {
      expect(lpnLabelsFilename('GRN-0001', 'zpl', '2026-10-21T18:29:59.999Z')).toBe('lpn-labels-GRN-0001-20261021.zpl');
      expect(lpnLabelsFilename('GRN-0001', 'pdf', '2026-10-21T18:30:00.000Z')).toBe('lpn-labels-GRN-0001-20261022.pdf');
      expect(lpnLabelsFilename('GRN 1/"é', 'pdf', '2026-10-21T18:30:00.000Z')).toBe('lpn-labels-GRN-1----20261022.pdf');
    });
  });

  // ── the matrix: void ───────────────────────────────────────────────────────

  describe('void', () => {
    it('void: an active LPN → 200 voided, its quantity freed; audit lpn.voided; the replay re-serves; again → 409 lpn-not-active; voided in a print → 422', async () => {
      const grn = await receiveBlind(acmeId, [{ skuId: sku('L-A'), qty: 50 }]);
      const [a, b] = await minted(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [30, 20] }]);
      expect((await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [1] }]).expect(422)).body).toMatchObject({ remaining: 0 });
      const key = ulid();
      const voided = await voidLpn(grn.id, a!.id, { reasonCode: 'other', note: '  smudged by rain  ' }, key).expect(200);
      expect(voided.body.lpn).toMatchObject({ id: a!.id, code: a!.code, status: 'voided', voidReasonCode: 'other', voidNote: 'smudged by rain' });
      expect(await lpnRow(a!.id)).toMatchObject({ status: 'voided', void_reason_code: 'other', void_note: 'smudged by rain', voided_by: ownerUserId });
      await expectAuditRow({ tenantId, key, action: 'lpn.voided', targetType: 'lpn', targetId: a!.id, actorUserId: ownerUserId });
      const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as { changes: Record<string, unknown> }[];
      expect(audit[0]!.changes).toMatchObject({ code: a!.code, reasonCode: 'other', note: 'smudged by rain' });
      // The same key re-serves the stored snapshot (the trimmed note hashes the same).
      expect((await voidLpn(grn.id, a!.id, { reasonCode: 'other', note: 'smudged by rain' }, key).expect(200)).body).toEqual(voided.body);
      await expectAuditRow({ tenantId, key, action: 'lpn.voided', targetType: 'lpn', targetId: a!.id, actorUserId: ownerUserId });
      // Freed: 30 more can be labelled.
      await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [30] }]).expect(201);
      const again = await voidLpn(grn.id, a!.id, { reasonCode: 'misprint' }).expect(409);
      expect(again.body).toMatchObject({ code: 'lpn-not-active', lpnCode: a!.code, lpnStatus: 'voided' });
      // A voided LPN never prints: listed → 422 + lpnCodes; the whole-receipt print skips it.
      expect(await refusal(print(grn.id, { format: 'zpl', lpnIds: [a!.id, b!.id] }), 422)).toMatchObject({ code: 'lpn-voided', lpnCodes: [a!.code] });
      const all = parseZplLabels(((await print(grn.id, { format: 'zpl' }).expect(200)).body as Buffer).toString('ascii'));
      expect(all.map((l) => l.payload)).not.toContain(a!.code);
      expect(all).toHaveLength(2);
    });

    it('void without a reason, an unknown reason, `other` without a note, an overlong note → 400; another receipt\'s LPN → 404', async () => {
      const grn = await receiveBlind(acmeId, [{ skuId: sku('L-A'), qty: 5 }]);
      const [a] = await minted(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [5] }]);
      for (const body of [{}, { reasonCode: 'smudged' }, { reasonCode: 'other' }, { reasonCode: 'other', note: '   ' }, { reasonCode: 'misprint', note: 'x'.repeat(201) }]) {
        expect((await voidLpn(grn.id, a!.id, body).expect(400)).body.code).toBe('validation-failed');
      }
      expect((await voidLpn(mainGrn.id, a!.id, { reasonCode: 'misprint' }).expect(404)).body.code).toBe('not-found');
      expect((await voidLpn(grn.id, 'nope', { reasonCode: 'misprint' }).expect(400)).body.code).toBe('validation-failed');
      expect(await lpnRow(a!.id)).toMatchObject({ status: 'active' });
    });
  });

  // ── putaway: the task's lpns and the placement that consumes one ──────────

  describe('putaway (A1)', () => {
    it('the putaway task and the device snapshot carry the line\'s active LPNs in code order', async () => {
      const task = taskOf(await tasks(), mainGrn.lines[0]!.id)!;
      expect(task.qty).toBe(100);
      expect(task.lpns).toEqual([
        { code: 'LPN-000001', qty: 40 },
        { code: 'LPN-000002', qty: 40 },
        { code: 'LPN-000003', qty: 20 },
      ]);
      const snapshot = await http().get(`${API}/${tenantId}/devices/catalog-snapshot`).query({ warehouseId: wh }).set('Authorization', `Bearer ${operatorToken}`).expect(200);
      const snapTask = (snapshot.body.putawayTasks as Task[]).find((t) => t.grnLineId === mainGrn.lines[0]!.id)!;
      expect(snapTask.lpns).toEqual(task.lpns);
      // A task without LPNs carries an empty list, never an absent key.
      const bare = await receiveBlind(acmeId, [{ skuId: sku('L-A'), qty: 2 }]);
      expect(taskOf(await tasks(), bare.lines[0]!.id)!.lpns).toEqual([]);
    });

    it('placement with LPN: lpnCode of this line, qty 40 ≤ 40 → 201; the LPN is placed and leaves the task\'s lpns; the hash golden puts lpnCode last', async () => {
      const task = taskOf(await tasks(), mainGrn.lines[0]!.id)!;
      const key = ulid();
      const body = placement(task, 40, { lpnCode: '  LPN-000002 ' });
      const res = await place(body, key).expect(201);
      const row = await lpnRow(mainLpns[1]!.id);
      expect(row).toMatchObject({ status: 'placed', placement_id: res.body.placement.id });
      expect(row.placed_at).not.toBeNull();
      // (The task's qty is pooled per (sku, batch) in Receiving — only the LPN list is the line's own.)
      const after = taskOf(await tasks(), mainGrn.lines[0]!.id)!;
      expect(after.lpns.map((l) => l.code)).toEqual(['LPN-000001', 'LPN-000003']);
      // The golden: the pre-2-10b keys in their order, then the trimmed lpnCode LAST (serials null → absent).
      const expected = `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}","grnId":"${task.grnId}","grnLineId":"${task.grnLineId}","skuId":"${task.skuId}","batchId":null,"qty":40,"toBinId":"${task.suggestedBin!.binId}","reasonCode":null,"occurredAt":"${OCCURRED_AT}","lpnCode":"LPN-000002"}`;
      const stored = ((await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[])[0]!;
      expect(stored.payload_hash).toBe(createHash('sha256').update(expected, 'utf8').digest('hex'));
      // The same key replays (the device retried), nothing re-moves.
      expect((await place(body, key).expect(201)).body).toEqual(res.body);
    });

    it('LPN placed twice → 400 lpn-not-placeable (already placed); unknown, another line\'s, voided → 400; over its qty → 400 lpn-quantity-exceeded', async () => {
      const task = taskOf(await tasks(), mainGrn.lines[0]!.id)!;
      const twice = await place(placement(task, 10, { lpnCode: 'LPN-000002' })).expect(400);
      expect(twice.body).toMatchObject({ code: 'lpn-not-placeable', lpnCode: 'LPN-000002' });
      expect(twice.body.detail).toContain('already put away');
      expect((await place(placement(task, 10, { lpnCode: 'LPN-999999' })).expect(400)).body.detail).toContain('no LPN with this code');
      const otherLine = ((await sql`select code from lpns where tenant_id = ${tenantId} and grn_line_id <> ${task.grnLineId} and status = 'active' order by seq limit 1`) as unknown as { code: string }[])[0]!.code;
      expect((await place(placement(task, 1, { lpnCode: otherLine })).expect(400)).body.detail).toContain('another GRN line');
      const voidedCode = ((await sql`select code from lpns where tenant_id = ${tenantId} and status = 'voided' limit 1`) as unknown as { code: string }[])[0]!.code;
      expect((await place(placement(task, 1, { lpnCode: voidedCode })).expect(400)).body.code).toBe('lpn-not-placeable');
      const over = await place(placement(task, 41, { lpnCode: 'LPN-000001' })).expect(400);
      expect(over.body).toMatchObject({ code: 'lpn-quantity-exceeded', lpnCode: 'LPN-000001', lpnQty: 40 });
      expect(await lpnRow(mainLpns[0]!.id)).toMatchObject({ status: 'active' });
      expect(taskOf(await tasks(), mainGrn.lines[0]!.id)!.lpns.map((l) => l.code)).toEqual(['LPN-000001', 'LPN-000003']);
    });

    it('old device: a placement without lpnCode (or a blank one) hashes byte for byte as before (golden) and consumes no LPN', async () => {
      const task = taskOf(await tasks(), mainGrn.lines[0]!.id)!;
      const key = ulid();
      await place(placement(task, 5), key).expect(201);
      const expected = `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}","grnId":"${task.grnId}","grnLineId":"${task.grnLineId}","skuId":"${task.skuId}","batchId":null,"qty":5,"toBinId":"${task.suggestedBin!.binId}","reasonCode":null,"occurredAt":"${OCCURRED_AT}"}`;
      const hash = (k: string) => sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${k}`;
      expect(((await hash(key)) as unknown as { payload_hash: string }[])[0]!.payload_hash).toBe(createHash('sha256').update(expected, 'utf8').digest('hex'));
      // A blank lpnCode is absent: the same pre-2-10b shape (re-read — the suggestion moved).
      const next = taskOf(await tasks(), mainGrn.lines[0]!.id)!;
      const blankKey = ulid();
      await place(placement(next, 5, { lpnCode: '   ' }), blankKey).expect(201);
      const blankExpected = expected.replace(`"toBinId":"${task.suggestedBin!.binId}"`, `"toBinId":"${next.suggestedBin!.binId}"`);
      expect(((await hash(blankKey)) as unknown as { payload_hash: string }[])[0]!.payload_hash).toBe(createHash('sha256').update(blankExpected, 'utf8').digest('hex'));
      expect(await lpnRow(mainLpns[0]!.id)).toMatchObject({ status: 'active' });
      expect(await lpnRow(mainLpns[2]!.id)).toMatchObject({ status: 'active' });
    });

    it('void placed → 409 lpn-not-active; a placed LPN still prints (a reprint)', async () => {
      const res = await voidLpn(mainGrn.id, mainLpns[1]!.id, { reasonCode: 'misprint' }).expect(409);
      expect(res.body).toMatchObject({ code: 'lpn-not-active', lpnStatus: 'placed' });
      const reprint = await print(mainGrn.id, { format: 'zpl', lpnIds: [mainLpns[1]!.id] }).expect(200);
      expect(parseZplLabels((reprint.body as Buffer).toString('ascii')).map((l) => l.payload)).toEqual(['LPN-000002']);
    });
  });

  // ── the bounds ─────────────────────────────────────────────────────────────

  describe('the bounds (A5)', () => {
    it('a line holds at most 5000 non-voided LPNs (422 too-many-labels, count); a print over 1000 → 422 too-many-labels (count 5000)', async () => {
      const grn = await receiveBlind(acmeId, [{ skuId: sku('L-BIG'), qty: 6000 }]);
      const ones = Array.from({ length: 1000 }, () => 1);
      for (let i = 0; i < 5; i++) await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: ones }]).expect(201);
      const refused = await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [1] }]).expect(422);
      expect(refused.body).toMatchObject({ code: 'too-many-labels', count: 5001 });
      const tooMany = await refusal(print(grn.id, { format: 'zpl' }), 422);
      expect(tooMany).toMatchObject({ code: 'too-many-labels', count: 5000 });
      expect(await refusal(print(grn.id, { format: 'zpl', grnLineId: grn.lines[0]!.id }), 422)).toMatchObject({ count: 5000 });
      // A chunk of 1000 ids prints.
      const ids = ((await sql`select id from lpns where grn_id = ${grn.id} order by seq limit 1000`) as unknown as { id: string }[]).map((r) => r.id);
      const chunk = await print(grn.id, { format: 'zpl', lpnIds: ids }).expect(200);
      expect(parseZplLabels((chunk.body as Buffer).toString('ascii'))).toHaveLength(1000);
      // Voiding one frees a slot.
      const [first] = (await list(grn.id).expect(200)).body.items as Lpn[];
      await voidLpn(grn.id, first!.id, { reasonCode: 'label-damaged' }).expect(200);
      await mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [1] }]).expect(201);
    });
  });

  // ── races ──────────────────────────────────────────────────────────────────

  describe('races (guide §1)', () => {
    const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

    /** Wait until `min` sessions are parked on a lock chain leading back to `holderPid` (no table filter: the advisory lock). */
    async function waitParked(holderPid: number, min: number): Promise<void> {
      const probe = handle();
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active'
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
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`fewer than ${min} request(s) parked on the ':lpn-seq' lock`);
      } finally {
        await probe.end();
      }
    }

    /** Fire `send`s while a raw holder has the tenant's ':lpn-seq' advisory lock; release once all are parked. */
    async function raceUnderSeqLock(sends: (() => request.Test)[]): Promise<request.Response[]> {
      const holder = handle();
      const fired: Promise<request.Response>[] = [];
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`
            select pg_backend_pid() as pid, pg_advisory_xact_lock(hashtextextended(${tenantId} || ':lpn-seq', 0)) is not null as held
          `) as unknown as { pid: number }[];
          for (const send of sends) fired.push((async () => send())());
          await waitParked(locked[0]!.pid, sends.length);
        });
        return await Promise.all(fired);
      } finally {
        await Promise.allSettled(fired);
        await holder.end();
      }
    }

    const outcome = (res: request.Response): number | string => (res.status === 201 ? 201 : `${res.status} ${(res.body as { code?: string }).code}`);

    it('same key: two mints parked on the lock both answer the same 201 — one set of LPNs, one key, one audit row', async () => {
      const grn = await receiveBlind(acmeId, [{ skuId: sku('L-RACE'), qty: 10 }]);
      const key = ulid();
      const [a, b] = await raceUnderSeqLock([
        () => mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [4, 6] }], key),
        () => mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [4, 6] }], key),
      ]);
      expect([a!, b!].map(outcome)).toEqual([201, 201]);
      expect(b!.body).toEqual(a!.body);
      expect(await lpnCount({ grnId: grn.id })).toBe(2);
      expect(await keyRows(key)).toBe(1);
      await expectAuditRow({ tenantId, key, action: 'lpn.minted', targetType: 'goods_receipt', targetId: grn.id, actorUserId: ownerUserId });
    });

    it('different keys: two mints racing on one line never exceed its cap — one 201, one 422', async () => {
      const grn = await receiveBlind(acmeId, [{ skuId: sku('L-RACE'), qty: 100 }]);
      const results = await raceUnderSeqLock([
        () => mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [60] }]),
        () => mint(grn.id, [{ grnLineId: grn.lines[0]!.id, quantities: [60] }]),
      ]);
      expect(results.map(outcome).sort()).toEqual([201, '422 lpn-quantity-exceeds-line'].sort());
      const total = ((await sql`select coalesce(sum(qty), 0)::text as n from lpns where grn_id = ${grn.id} and status <> 'voided'`) as unknown as { n: string }[])[0]!.n;
      expect(Number(total)).toBe(60_000);
    });
  });

  // ── access, vocabularies, RLS, OpenAPI ────────────────────────────────────

  describe('access and contracts', () => {
    it('accountant or portal → 403 role-denied, before any 400 or 404', async () => {
      expect((await mint(mainGrn.id, [{ grnLineId: mainGrn.lines[0]!.id, quantities: [1] }], ulid(), accountantToken).expect(403)).body.code).toBe('role-denied');
      expect((await voidLpn(mainGrn.id, mainLpns[0]!.id, { reasonCode: 'misprint' }, ulid(), accountantToken).expect(403)).body.code).toBe('role-denied');
      expect(await refusal(print(mainGrn.id, { format: 'zpl' }, accountantToken), 403)).toMatchObject({ code: 'role-denied' });
      expect(await refusal(print(uuidv7(), { format: 'zpl', layout: 'a4' }, accountantToken), 403)).toMatchObject({ code: 'role-denied' });
      expect(await refusal(print('not-a-uuid', { format: 'zpl' }, accountantToken), 403)).toMatchObject({ code: 'role-denied' });
      const portalToken = signTenantSession({ tenantId, userId: ownerUserId, sessionId: uuidv7(), kind: 'portal', clientId: acmeId }, process.env.JWT_SECRET!);
      for (const res of [() => list(mainGrn.id, portalToken), () => mint(mainGrn.id, [{ grnLineId: mainGrn.lines[0]!.id, quantities: [1] }], ulid(), portalToken)]) {
        expect((await res().expect(403)).body).toMatchObject({ code: 'role-denied', detail: 'This is an operator surface.' });
      }
      expect(await refusal(print(mainGrn.id, { format: 'zpl' }, portalToken), 403)).toMatchObject({ code: 'role-denied' });
      // The operator and the ops manager hold labels.execute.
      const opsToken = await signIn(await member('ops_manager'));
      await print(mainGrn.id, { format: 'zpl' }, opsToken).expect(200);
    });

    it('the vocabularies: LPN_STATUSES and LPN_VOID_REASON_CODES equal 0109\'s CHECKs', async () => {
      const defs = (await sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'lpns'::regclass and contype = 'c'`) as unknown as { conname: string; def: string }[];
      const quoted = (name: string): string[] => [...defs.find((d) => d.conname === name)!.def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
      expect(quoted('lpns_status_check').sort()).toEqual([...LPN_STATUSES].sort());
      expect(quoted('lpns_void_reason_check').sort()).toEqual([...LPN_VOID_REASON_CODES].sort());
    });

    it('RLS: lpns is tenant-isolated (wms_rls_probe sees only its stamped tenant, cannot write another)', async () => {
      const foreign = uuidv7();
      const row = (t: string, seq: number) => ({ id: uuidv7(), t, seq });
      const insert = async (r: { id: string; t: string; seq: number }) =>
        sql`insert into lpns (id, tenant_id, warehouse_id, grn_id, grn_line_id, sku_id, client_id, seq, code, qty, created_by)
          values (${r.id}, ${r.t}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${r.seq}, ${'LPN-' + String(r.seq).padStart(6, '0')}, 1000, ${uuidv7()})`;
      try {
        await insert(row(foreign, 1));
        const url = new URL(process.env.DATABASE_URL!);
        url.username = 'wms_rls_probe';
        url.password = 'wms_rls_probe';
        const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
        try {
          await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
          const hidden = await rls.unsafe(`select count(*)::int as n from lpns where tenant_id = '${foreign}'::uuid`);
          expect(Number((hidden[0] as unknown as { n: number }).n)).toBe(0);
          const mine = await rls.unsafe(`select count(*)::int as n from lpns`);
          expect(Number((mine[0] as unknown as { n: number }).n)).toBeGreaterThan(0);
          await rls.unsafe(`select set_config('app.tenant_id', '${foreign}', false)`);
          const own = await rls.unsafe(`select count(*)::int as n from lpns`);
          expect(Number((own[0] as unknown as { n: number }).n)).toBe(1);
          await expect(
            rls.begin(async (tx) => {
              await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
              await tx`insert into lpns (id, tenant_id, warehouse_id, grn_id, grn_line_id, sku_id, client_id, seq, code, qty, created_by)
                values (${uuidv7()}, ${foreign}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, 2, 'LPN-000002', 1000, ${uuidv7()})`;
            }),
          ).rejects.toThrow(/row-level security/i);
        } finally {
          await rls.end();
        }
      } finally {
        await sql`delete from lpns where tenant_id = ${foreign}`;
      }
    });

    it('the OpenAPI document carries the four routes, the binary 200s, the task lpns and the placement lpnCode', async () => {
      const served = (await http().get('/api/v1/openapi.json').expect(200)).body as {
        paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>>;
        components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
      };
      const committed = JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8')) as typeof served;
      const base = '/tenants/{tenantId}/receiving/goods-receipts/{grnId}/lpns';
      for (const doc of [served, committed]) {
        expect(Object.keys(doc.paths[base]!).sort()).toEqual(['get', 'post']);
        const labels = doc.paths[`${base}/labels`]!.post!;
        expect(Object.keys(labels.responses['200']!.content!).sort()).toEqual(['application/pdf', 'text/plain']);
        expect(Object.keys(labels.responses).sort()).toEqual(['200', '400', '401', '403', '404', '422']);
        expect(doc.paths[`${base}/{lpnId}/void`]!.post).toBeDefined();
        expect(doc.components.schemas.PutawayTaskDto!.required).toContain('lpns');
        expect(doc.components.schemas.PlacePutawayDto!.properties).toHaveProperty('lpnCode');
        expect(doc.components.schemas.LpnDto!.properties).toHaveProperty('code');
      }
    });
  });
});
