import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { addIsoDays, istMidnightOf } from '../src/shared/primitives/time';
import { isDateShapedInstant, shelfLifeRefusedOpId } from '../src/modules/inbound/receiving.command';
import { BATCH_EXPIRY_SOURCES, CatalogFacade } from '../src/modules/catalog/catalog.facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow } from './support/audit-guard';

// Story 2-4b — expiry from shelf life: a batch-tracked receipt line with a
// mfg date and no typed expiry gets the batch expiry mfg + the SKU's shelf
// life (step 3b of the expiry phase), judged by the client's receiving
// policy like a typed one; the provenance (`batches.expiry_source`), the
// per-client switch (`clients.derive_expiry`), a typed label replacing a
// derived date, the race arm, review Apply re-deriving, the snapshot's
// `shelfLifeDays`, the GRN lines read, and the goldens that keep a pre-2-4b
// op byte-identical.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
/** IST 2026-10-27 10:00 — every receipt's business date below is 2026-10-27. */
const OCCURRED_AT = '2026-10-27T04:30:00.000Z';
const RECEIPT_DATE = '2026-10-27';

interface GrnLine {
  poLineId?: string | null;
  skuId: string;
  batchCode: string | null;
  mfgDate: string | null;
  expiryDate?: string;
  qty: number;
  damagedQty?: number;
  damageReasonCode?: string;
}

interface DerivedExpiry {
  expiryDate: string;
  mfgDate: string;
  shelfLifeDays: number;
}

interface RejectedLine {
  code: string;
  reason: string;
  index?: number;
  batchCode?: string | null;
  expiryDate?: string | null;
  derivedExpiry?: DerivedExpiry;
}

interface GoodsReceipt {
  id: string;
  code: string;
  lines: { id: string; skuId: string; qty: number; appliedQty: number; batchId: string | null; batchCode: string | null; derivedExpiry?: DerivedExpiry; replacedDerivedExpiry?: string }[];
  rejectedLines?: RejectedLine[];
  reviewOpId?: string;
  shelfLifeReviewOpId?: string;
}

interface BatchRow {
  mfg_date: Date | null;
  expiry_date: Date | null;
  expiry_source: string | null;
}

describe('story 2-4b: expiry from shelf life (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let wh: string;
  let deviceId: string;
  let operatorToken: string;
  let operatorUserId: string;
  const clientIds = new Map<string, string>();
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const client = (code: string): string => {
    const id = clientIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture client ${code}`);
    return id;
  };
  const sku = (clientCode: string, code: string): string => {
    const id = skuIds.get(`${clientCode}:${code}`);
    if (id === undefined) throw new Error(`unknown fixture SKU ${clientCode}:${code}`);
    return id;
  };

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('receipt_expiry_derivation');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 3, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `SLD Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    const signedIn = await mintSignIn(app, { email, password: 'correct-horse-battery' });
    ownerToken = signedIn.body.accessToken as string;
    ownerUserId = signedIn.body.user.id as string;

    wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `SLD-${ulid().slice(20)}`, name: 'SLD warehouse' })
        .expect(201)
    ).body.id as string;

    for (const [code, name] of [
      ['PLAIN', 'Plain Brand'],
      ['EXP', 'Expiry Brand'],
      ['OFF', 'Label-only Brand'],
    ] as const) {
      const res = await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name })
        .expect(201);
      clientIds.set(code, res.body.client.id as string);
    }
    await importSkus('PLAIN', ['D180', 'NOSL', 'UNTR']);
    await importSkus('EXP', ['E180', 'ENOSL']);
    await importSkus('OFF', ['O180']);
    await setShelfLife(sku('PLAIN', 'D180'), 180);
    await setShelfLife(sku('EXP', 'E180'), 180);
    await setShelfLife(sku('OFF', 'O180'), 180);

    await putPolicy(client('EXP'), { receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: true, minShelfLifeDays: 90 }).expect(200);
    await putPolicy(client('OFF'), { receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null, deriveExpiry: false }).expect(200);

    const operatorEmail = `operator-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: operatorEmail, role: 'operator' })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'SLD dock', pin: '2468' })
      .expect(201);
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

  async function importSkus(clientCode: string, codes: readonly string[]): Promise<void> {
    const csv = [
      'sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked',
      ...codes.map((code) => `${code},${code} name,pcs,1800,${clientCode}-${code}-BC,${code !== 'UNTR'},false`),
    ].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', client(clientCode))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const stored = (await sql`select id, code from skus where tenant_id = ${tenantId} and client_id = ${client(clientCode)}`) as unknown as {
      id: string;
      code: string;
    }[];
    for (const row of stored) skuIds.set(`${clientCode}:${row.code}`, row.id);
  }

  async function setShelfLife(skuId: string, days: number | null): Promise<void> {
    await sql`update skus set shelf_life_days = ${days} where id = ${skuId}`;
  }

  function putPolicy(clientId: string, body: Record<string, unknown>, key = ulid()): request.Test {
    return http()
      .put(`${API}/${tenantId}/clients/${clientId}/receiving-policy`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function line(skuId: string, qty: number, extra: Partial<GrnLine> = {}): GrnLine {
    return { skuId, batchCode: null, mfgDate: null, qty, ...extra };
  }

  function receive(clientCode: string, lines: GrnLine[], key = ulid()): request.Test {
    return http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: wh, occurredAt: OCCURRED_AT, poId: null, blindReasonCode: 'other', clientId: client(clientCode), lines });
  }

  async function receiveGrn(clientCode: string, lines: GrnLine[], key = ulid()): Promise<GoodsReceipt> {
    return (await receive(clientCode, lines, key).expect(201)).body.goodsReceipt as GoodsReceipt;
  }

  async function batch(skuId: string, code: string): Promise<BatchRow> {
    const rows = (await sql`select mfg_date, expiry_date, expiry_source from batches where tenant_id = ${tenantId} and sku_id = ${skuId} and code = ${code}`) as unknown as BatchRow[];
    if (rows[0] === undefined) throw new Error(`no batch ${code}`);
    return rows[0];
  }

  /** The batch row as comparable strings: the mfg instant, the expiry's IST date, the source. */
  async function batchFacts(skuId: string, code: string): Promise<{ mfg: string | null; expiry: string | null; source: string | null }> {
    const row = await batch(skuId, code);
    return {
      mfg: row.mfg_date === null ? null : row.mfg_date.toISOString(),
      expiry: row.expiry_date === null ? null : new Date(row.expiry_date.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10),
      source: row.expiry_source,
    };
  }

  async function seedBatch(skuId: string, code: string, mfg: string | null, expiryDate: string | null, source: 'typed' | 'derived' | null = null): Promise<void> {
    await sql`insert into batches (id, tenant_id, sku_id, code, mfg_date, expiry_date, expiry_source)
      values (${uuidv7()}, ${tenantId}, ${skuId}, ${code}, ${mfg}, ${expiryDate === null ? null : istMidnightOf(expiryDate)}, ${source})`;
  }

  async function rejectedOp(opId: string): Promise<{ id: string; opType: string; problemCode: string; status: string; payload: Record<string, unknown> }> {
    const rows = (await sql`select id, op_type, problem_code, status, payload from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`) as unknown as {
      id: string;
      op_type: string;
      problem_code: string;
      status: string;
      payload: Record<string, unknown>;
    }[];
    if (rows[0] === undefined) throw new Error(`no rejected op ${opId}`);
    return { id: rows[0].id, opType: rows[0].op_type, problemCode: rows[0].problem_code, status: rows[0].status, payload: rows[0].payload };
  }

  function resolve(rejectedOpId: string, body: Record<string, unknown>): request.Test {
    return http()
      .post(`${API}/${tenantId}/rejected-ops/${rejectedOpId}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send(body);
  }

  const mfg = (date: string): string => `${date}T00:00:00Z`;

  // ── the derivation (the frozen matrix) ─────────────────────────────────────

  describe('derive', () => {
    it('a new batch: expiry = mfg + 180 (2026-09-01 → 2027-02-28), stored as IST midnight, source derived; the line says so', async () => {
      const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 5, { batchCode: 'N1', mfgDate: mfg('2026-09-01') })]);
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.lines[0]!.derivedExpiry).toEqual({ expiryDate: '2027-02-28', mfgDate: '2026-09-01', shelfLifeDays: 180 });
      expect(grn.lines[0]!.replacedDerivedExpiry).toBeUndefined();
      const row = await batch(sku('PLAIN', 'D180'), 'N1');
      expect(row.expiry_date!.toISOString()).toBe(istMidnightOf('2027-02-28'));
      expect(row.expiry_source).toBe('derived');
      expect(row.mfg_date!.toISOString()).toBe('2026-09-01T00:00:00.000Z');
      // The lines read carries the IST dates and the source.
      const lines = await http()
        .get(`${API}/${tenantId}/receiving/goods-receipts/${grn.id}/lines`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(lines.body.items[0]).toMatchObject({ batchCode: 'N1', batchMfgDate: '2026-09-01', batchExpiryDate: '2027-02-28', expirySource: 'derived' });
    });

    it('typed wins: a line expiry is the batch expiry, source typed, no derivedExpiry', async () => {
      const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'T1', mfgDate: mfg('2026-09-01'), expiryDate: '2027-01-31' })]);
      expect(grn.lines[0]!.derivedExpiry).toBeUndefined();
      expect(await batchFacts(sku('PLAIN', 'D180'), 'T1')).toMatchObject({ expiry: '2027-01-31', source: 'typed' });
    });

    it('an existing expiry wins: the batch is untouched, nothing refused, no derivedExpiry', async () => {
      await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'E1', expiryDate: '2027-01-15' })]);
      const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 2, { batchCode: 'E1', mfgDate: mfg('2026-09-01') })]);
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.lines[0]!.derivedExpiry).toBeUndefined();
      expect(await batchFacts(sku('PLAIN', 'D180'), 'E1')).toMatchObject({ expiry: '2027-01-15', source: 'typed', mfg: null });
    });

    it('fill a null: an existing batch (expiry NULL, mfg 2026-08-01) and a line with neither → 2027-01-28 from the batch mfg', async () => {
      await seedBatch(sku('PLAIN', 'D180'), 'F1', '2026-08-01T00:00:00Z', null);
      const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'F1' })]);
      expect(grn.lines[0]!.derivedExpiry).toEqual({ expiryDate: '2027-01-28', mfgDate: '2026-08-01', shelfLifeDays: 180 });
      expect(await batchFacts(sku('PLAIN', 'D180'), 'F1')).toEqual({ mfg: '2026-08-01T00:00:00.000Z', expiry: '2027-01-28', source: 'derived' });
    });

    it("the existing mfg wins over the line's; the stored mfg is never overwritten", async () => {
      await seedBatch(sku('PLAIN', 'D180'), 'M1', '2026-08-01T00:00:00Z', null);
      const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'M1', mfgDate: mfg('2026-09-01') })]);
      expect(grn.lines[0]!.derivedExpiry).toEqual({ expiryDate: '2027-01-28', mfgDate: '2026-08-01', shelfLifeDays: 180 });
      expect(await batchFacts(sku('PLAIN', 'D180'), 'M1')).toEqual({ mfg: '2026-08-01T00:00:00.000Z', expiry: '2027-01-28', source: 'derived' });
    });

    it('A2: an existing batch whose stored mfg is an old-device instant derives nothing — never from the line\'s mfg', async () => {
      await seedBatch(sku('PLAIN', 'D180'), 'OLDB1', '2026-03-03T18:30:00Z', null);
      const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'OLDB1', mfgDate: mfg('2026-09-01') })]);
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.lines[0]!.derivedExpiry).toBeUndefined();
      expect(await batchFacts(sku('PLAIN', 'D180'), 'OLDB1')).toEqual({ mfg: '2026-03-03T18:30:00.000Z', expiry: null, source: null });
    });

    it('A3: an existing batch with mfg AND expiry NULL — the derivation fills both from the line', async () => {
      await seedBatch(sku('PLAIN', 'D180'), 'NM1', null, null);
      const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'NM1', mfgDate: mfg('2026-09-01') })]);
      expect(grn.lines[0]!.derivedExpiry).toEqual({ expiryDate: '2027-02-28', mfgDate: '2026-09-01', shelfLifeDays: 180 });
      expect(await batchFacts(sku('PLAIN', 'D180'), 'NM1')).toEqual({ mfg: '2026-09-01T00:00:00.000Z', expiry: '2027-02-28', source: 'derived' });
    });

    it('A3: a new batch whose FIRST line has no mfg stores the mfg it derived from (the second line\'s)', async () => {
      const grn = await receiveGrn('PLAIN', [
        line(sku('PLAIN', 'D180'), 1, { batchCode: 'FM1' }),
        line(sku('PLAIN', 'D180'), 1, { batchCode: 'FM1', mfgDate: mfg('2026-09-01') }),
      ]);
      expect(grn.lines.map((entry) => entry.derivedExpiry?.expiryDate)).toEqual(['2027-02-28', '2027-02-28']);
      expect(await batchFacts(sku('PLAIN', 'D180'), 'FM1')).toEqual({ mfg: '2026-09-01T00:00:00.000Z', expiry: '2027-02-28', source: 'derived' });
    });

    it('A3: lines of one batch with differing mfg dates — the first wins, nothing refused', async () => {
      const grn = await receiveGrn('PLAIN', [
        line(sku('PLAIN', 'D180'), 1, { batchCode: 'DM1', mfgDate: mfg('2026-09-01') }),
        line(sku('PLAIN', 'D180'), 1, { batchCode: 'DM1', mfgDate: mfg('2026-08-01') }),
      ]);
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.lines.map((entry) => entry.derivedExpiry?.mfgDate)).toEqual(['2026-09-01', '2026-09-01']);
      expect(await batchFacts(sku('PLAIN', 'D180'), 'DM1')).toEqual({ mfg: '2026-09-01T00:00:00.000Z', expiry: '2027-02-28', source: 'derived' });
    });

    it('typed in the same receipt: line 1 mfg only, line 2 types 2027-03-01 → both book with it, no refusal, no derivation', async () => {
      const grn = await receiveGrn('PLAIN', [
        line(sku('PLAIN', 'D180'), 1, { batchCode: 'S1', mfgDate: mfg('2026-09-01') }),
        line(sku('PLAIN', 'D180'), 1, { batchCode: 'S1', expiryDate: '2027-03-01' }),
      ]);
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.lines.every((entry) => entry.derivedExpiry === undefined)).toBe(true);
      expect(await batchFacts(sku('PLAIN', 'D180'), 'S1')).toMatchObject({ expiry: '2027-03-01', source: 'typed' });
    });

    it('a client requiring expiry is satisfied by a derived one, judged by shelf-life-short against it', async () => {
      const grn = await receiveGrn('EXP', [line(sku('EXP', 'E180'), 3, { batchCode: 'R1', mfgDate: mfg('2026-09-01') })]);
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.lines[0]!.derivedExpiry?.expiryDate).toBe('2027-02-28');
      expect(await batchFacts(sku('EXP', 'E180'), 'R1')).toMatchObject({ expiry: '2027-02-28', source: 'derived' });
    });

    it('no shelf life: as today (NULL expiry; expiry-required when the client requires one)', async () => {
      const plain = await receiveGrn('PLAIN', [line(sku('PLAIN', 'NOSL'), 1, { batchCode: 'NS1', mfgDate: mfg('2026-09-01') })]);
      expect(plain.lines[0]!.derivedExpiry).toBeUndefined();
      expect(await batchFacts(sku('PLAIN', 'NOSL'), 'NS1')).toMatchObject({ expiry: null, source: null });
      const res = await receive('EXP', [line(sku('EXP', 'ENOSL'), 1, { batchCode: 'NS2', mfgDate: mfg('2026-09-01') })]).expect(201);
      expect(res.body.refusedReceipt.rejectedLines).toEqual([expect.objectContaining({ code: 'expiry-required' })]);
      expect(res.body.refusedReceipt.rejectedLines[0].derivedExpiry).toBeUndefined();
    });

    it('A9 boundaries: mfg ON the receipt date derives; one IST day after does not; an IST-midnight instant is not date-shaped', async () => {
      const grn = await receiveGrn('PLAIN', [
        line(sku('PLAIN', 'D180'), 1, { batchCode: 'B-ON', mfgDate: mfg(RECEIPT_DATE) }),
        line(sku('PLAIN', 'D180'), 1, { batchCode: 'B-AFTER', mfgDate: mfg('2026-10-28') }),
        // 2026-10-26T18:30Z is the IST date 2026-10-27 — the receipt's date — but not date-shaped (A2).
        line(sku('PLAIN', 'D180'), 1, { batchCode: 'B-1830', mfgDate: '2026-10-26T18:30:00Z' }),
      ]);
      expect(grn.lines.map((entry) => entry.derivedExpiry?.expiryDate ?? null)).toEqual([addIsoDays(RECEIPT_DATE, 180), null, null]);
      expect(await batchFacts(sku('PLAIN', 'D180'), 'B-AFTER')).toEqual({ mfg: '2026-10-28T00:00:00.000Z', expiry: null, source: null });
      expect(await batchFacts(sku('PLAIN', 'D180'), 'B-1830')).toEqual({ mfg: '2026-10-26T18:30:00.000Z', expiry: null, source: null });
    });

    it('A2: an old-device mfg (2026-03-03T18:30:00.000Z, a US-order misread) derives nothing; the mfg is stored as today', async () => {
      expect(isDateShapedInstant('2026-03-03T18:30:00.000Z')).toBe(false);
      expect(isDateShapedInstant('2026-03-03T00:00:00.000Z')).toBe(true);
      expect(isDateShapedInstant('2026-03-03T00:00:00Z')).toBe(true);
      expect(isDateShapedInstant('2026-03-03T00:00:00.001Z')).toBe(false);
      const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'OLD1', mfgDate: '2026-03-03T18:30:00.000Z' })]);
      expect(grn.lines[0]!.derivedExpiry).toBeUndefined();
      expect(await batchFacts(sku('PLAIN', 'D180'), 'OLD1')).toEqual({ mfg: '2026-03-03T18:30:00.000Z', expiry: null, source: null });
    });

    it('out of range: a result before year 2000 derives nothing (an expiry after 2199 cannot arise — mfg ≤ today, shelf life ≤ 3650)', async () => {
      const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'OOR1', mfgDate: mfg('1990-01-01') })]);
      expect(grn.lines[0]!.derivedExpiry).toBeUndefined();
      expect(await batchFacts(sku('PLAIN', 'D180'), 'OOR1')).toMatchObject({ expiry: null, source: null });
    });

    it('all damaged: the batch is filled with the derived expiry, no policy judgement (it would be short-dated)', async () => {
      const grn = await receiveGrn('EXP', [
        line(sku('EXP', 'E180'), 0, { batchCode: 'AD1', mfgDate: mfg('2026-05-01'), damagedQty: 5, damageReasonCode: 'broken' }),
      ]);
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.lines[0]!.derivedExpiry).toEqual({ expiryDate: '2026-10-28', mfgDate: '2026-05-01', shelfLifeDays: 180 });
      expect(await batchFacts(sku('EXP', 'E180'), 'AD1')).toMatchObject({ expiry: '2026-10-28', source: 'derived' });
    });

    it('the client switch off: no derivation (as today)', async () => {
      const grn = await receiveGrn('OFF', [line(sku('OFF', 'O180'), 1, { batchCode: 'OFF1', mfgDate: mfg('2026-09-01') })]);
      expect(grn.lines[0]!.derivedExpiry).toBeUndefined();
      expect(await batchFacts(sku('OFF', 'O180'), 'OFF1')).toMatchObject({ expiry: null, source: null });
    });

    it('a derived batch received again with mfg only keeps its expiry (a shelf-life edit never re-dates a batch)', async () => {
      await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'KEEP1', mfgDate: mfg('2026-09-01') })]);
      await setShelfLife(sku('PLAIN', 'D180'), 200);
      try {
        const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'KEEP1', mfgDate: mfg('2026-09-01') })]);
        expect(grn.lines[0]!.derivedExpiry).toBeUndefined();
        expect(await batchFacts(sku('PLAIN', 'D180'), 'KEEP1')).toMatchObject({ expiry: '2027-02-28', source: 'derived' });
      } finally {
        await setShelfLife(sku('PLAIN', 'D180'), 180);
      }
    });
  });

  // ── the policy judgement and review ─────────────────────────────────────────

  describe('shelf life against a derived expiry', () => {
    it('A9: exactly the minimum books; one day under is shelf-life-short', async () => {
      // Receipt 2026-10-27 + 90 = 2027-01-25 = 2026-07-29 + 180.
      expect(addIsoDays('2026-07-29', 180)).toBe(addIsoDays(RECEIPT_DATE, 90));
      const edge = await receiveGrn('EXP', [line(sku('EXP', 'E180'), 1, { batchCode: 'EDGE90', mfgDate: mfg('2026-07-29') })]);
      expect(edge.rejectedLines).toBeUndefined();
      const res = await receive('EXP', [line(sku('EXP', 'E180'), 1, { batchCode: 'EDGE89', mfgDate: mfg('2026-07-28') })]).expect(201);
      expect(res.body.refusedReceipt.rejectedLines).toEqual([
        expect.objectContaining({ code: 'shelf-life-short', expiryDate: '2027-01-24', derivedExpiry: { expiryDate: '2027-01-24', mfgDate: '2026-07-28', shelfLifeDays: 180 } }),
      ]);
    });

    it('derived short-dated: the shelf-life review row carries derivedExpiry and says so; Apply with a note re-derives under the waiver', async () => {
      const key = ulid();
      const res = await receive('EXP', [line(sku('EXP', 'E180'), 4, { batchCode: 'SH1', mfgDate: mfg('2026-05-01') })], key).expect(201);
      const refused = res.body.refusedReceipt as { rejectedLines: RejectedLine[]; shelfLifeReviewOpId: string };
      const derived = { expiryDate: '2026-10-28', mfgDate: '2026-05-01', shelfLifeDays: 180 };
      expect(refused.rejectedLines).toEqual([expect.objectContaining({ code: 'shelf-life-short', expiryDate: '2026-10-28', derivedExpiry: derived })]);
      expect(refused.rejectedLines[0]!.reason).toContain("(derived from mfg 2026-05-01 + 180 days' shelf life)");
      expect(refused.shelfLifeReviewOpId).toBe(shelfLifeRefusedOpId(key));
      const row = await rejectedOp(refused.shelfLifeReviewOpId);
      expect(row.opType).toBe('grn.shelf-life-refused');
      expect((row.payload.refusals as Record<string, unknown>[])[0]).toMatchObject({ reason: 'shelf-life-short', expiryDate: '2026-10-28', derivedExpiry: derived });
      // The payload re-sends the mfg and no expiry (A8, K14): Apply re-derives.
      expect((row.payload.lines as Record<string, unknown>[])[0]).toEqual({ poLineId: null, skuId: sku('EXP', 'E180'), batchCode: 'SH1', mfgDate: mfg('2026-05-01'), expiryDate: null, qty: 4 });

      const applied = await resolve(row.id, { decision: 'apply', note: 'Brand accepts short-dated stock' }).expect(200);
      const snapshot = (applied.body.outcome as { snapshot: { goodsReceipt: GoodsReceipt } }).snapshot.goodsReceipt;
      expect(snapshot.rejectedLines).toBeUndefined();
      expect(snapshot.lines).toEqual([expect.objectContaining({ qty: 4, derivedExpiry: derived })]);
      // A10 — derived already past tomorrow: the server derives (the batch's truth beats a NULL).
      expect(await batchFacts(sku('EXP', 'E180'), 'SH1')).toMatchObject({ expiry: '2026-10-28', source: 'derived' });
    });

    it('A8: Apply after the SKU\'s shelf life was cleared re-runs to expiry-required → the ordinary grn.lines-refused row', async () => {
      await setShelfLife(sku('EXP', 'ENOSL'), 180);
      const res = await receive('EXP', [line(sku('EXP', 'ENOSL'), 2, { batchCode: 'SH2', mfgDate: mfg('2026-05-01') })]).expect(201);
      const row = await rejectedOp(res.body.refusedReceipt.shelfLifeReviewOpId as string);
      await setShelfLife(sku('EXP', 'ENOSL'), null);
      const applied = await resolve(row.id, { decision: 'apply', note: 'Accepted anyway' }).expect(200);
      const outcome = (applied.body.outcome as { snapshot: { goodsReceipt: null; refusedReceipt: { rejectedLines: RejectedLine[]; reviewOpId: string } } }).snapshot;
      expect(outcome.goodsReceipt).toBeNull();
      expect(outcome.refusedReceipt.rejectedLines).toEqual([expect.objectContaining({ code: 'expiry-required' })]);
      const raised = await rejectedOp(outcome.refusedReceipt.reviewOpId);
      expect(raised).toMatchObject({ opType: 'grn.lines-refused', problemCode: 'expiry-required', status: 'open' });
    });

    it('A8: Apply after an all-damaged receipt created the batch — the batch\'s expiry stands and the line books', async () => {
      const res = await receive('EXP', [line(sku('EXP', 'E180'), 3, { batchCode: 'SH3', mfgDate: mfg('2026-05-01') })]).expect(201);
      const row = await rejectedOp(res.body.refusedReceipt.shelfLifeReviewOpId as string);
      // Meanwhile the damaged units of the same batch are received: the batch is created with its derived expiry.
      await receiveGrn('EXP', [line(sku('EXP', 'E180'), 0, { batchCode: 'SH3', mfgDate: mfg('2026-05-01'), damagedQty: 1, damageReasonCode: 'broken' })]);
      const applied = await resolve(row.id, { decision: 'apply', note: 'Accepted anyway' }).expect(200);
      const snapshot = (applied.body.outcome as { snapshot: { goodsReceipt: GoodsReceipt } }).snapshot.goodsReceipt;
      expect(snapshot.lines).toEqual([expect.objectContaining({ qty: 3 })]);
      // The existing batch's expiry won: nothing was derived by the re-run.
      expect(snapshot.lines[0]!.derivedExpiry).toBeUndefined();
      expect(await batchFacts(sku('EXP', 'E180'), 'SH3')).toMatchObject({ expiry: '2026-10-28', source: 'derived' });
    });
  });

  // ── provenance and correction (A5) ─────────────────────────────────────────

  describe('a typed label against a derived expiry', () => {
    it('typed corrects derived: the expiry is replaced, source typed; the line says what it replaced; audited in changes', async () => {
      await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'C1', mfgDate: mfg('2026-09-01') })]);
      expect(await batchFacts(sku('PLAIN', 'D180'), 'C1')).toMatchObject({ expiry: '2027-02-28', source: 'derived' });
      const key = ulid();
      const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'C1', expiryDate: '2027-03-31' })], key);
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.lines[0]!.replacedDerivedExpiry).toBe('2027-02-28');
      expect(grn.lines[0]!.derivedExpiry).toBeUndefined();
      expect(await batchFacts(sku('PLAIN', 'D180'), 'C1')).toMatchObject({ expiry: '2027-03-31', source: 'typed' });
      await expectAuditRow({ tenantId, key, action: 'goods_receipt.submitted', targetType: 'goods_receipt', targetId: grn.id, actorUserId: operatorUserId });
      const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as { changes: unknown }[];
      expect(audit[0]!.changes).toEqual({
        replacedDerivedExpiry: [{ batchId: grn.lines[0]!.batchId, batchCode: 'C1', skuId: sku('PLAIN', 'D180'), before: '2027-02-28', after: '2027-03-31' }],
      });
      // Now typed: another typed date is the 1-2b mismatch.
      const res = await receive('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'C1', expiryDate: '2027-04-30' })]).expect(201);
      expect(res.body.refusedReceipt.rejectedLines).toEqual([expect.objectContaining({ code: 'batch-expiry-mismatch' })]);
    });

    it('a typed expiry EQUAL to the derived one confirms it: source typed, no replacedDerivedExpiry, no audit changes', async () => {
      await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'EQ1', mfgDate: mfg('2026-09-01') })]);
      expect(await batchFacts(sku('PLAIN', 'D180'), 'EQ1')).toMatchObject({ expiry: '2027-02-28', source: 'derived' });
      const key = ulid();
      const grn = await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'EQ1', expiryDate: '2027-02-28' })], key);
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.lines[0]!.replacedDerivedExpiry).toBeUndefined();
      expect(grn.lines[0]!.derivedExpiry).toBeUndefined();
      expect(await batchFacts(sku('PLAIN', 'D180'), 'EQ1')).toMatchObject({ expiry: '2027-02-28', source: 'typed' });
      const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key} and action = 'goods_receipt.submitted'`) as unknown as {
        changes: { replacedDerivedExpiry?: unknown } | null;
      }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]!.changes?.replacedDerivedExpiry).toBeUndefined();
    });

    it('typed vs typed (source typed, or NULL from before 2-4b): batch-expiry-mismatch as in 1-2b', async () => {
      await seedBatch(sku('PLAIN', 'D180'), 'TT1', null, '2027-01-31', 'typed');
      await seedBatch(sku('PLAIN', 'D180'), 'TT2', null, '2027-01-31', null);
      const res = await receive('PLAIN', [
        line(sku('PLAIN', 'D180'), 1, { batchCode: 'TT1', expiryDate: '2027-02-01' }),
        line(sku('PLAIN', 'D180'), 1, { batchCode: 'TT2', expiryDate: '2027-02-01' }),
      ]).expect(201);
      expect((res.body.refusedReceipt.rejectedLines as RejectedLine[]).map((entry) => entry.code)).toEqual(['batch-expiry-mismatch', 'batch-expiry-mismatch']);
      expect(await batchFacts(sku('PLAIN', 'D180'), 'TT2')).toMatchObject({ expiry: '2027-01-31', source: null });
    });
  });

  // ── the race (A7) — a concurrent filler, parked deterministically ────────

  describe('the race arm', () => {
    /** Holds the batch row's expiry update uncommitted until the receipt parks behind it, then commits. */
    async function raceFiller(skuId: string, code: string, fillWith: string, send: () => request.Test): Promise<request.Response> {
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let pending: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const pid = (await tx`select pg_backend_pid() as pid`) as unknown as { pid: number }[];
          await tx`update batches set expiry_date = ${istMidnightOf(fillWith)}, expiry_source = 'typed'
            where tenant_id = ${tenantId} and sku_id = ${skuId} and code = ${code}`;
          pending = (async () => send())();
          const deadline = Date.now() + 10_000;
          for (;;) {
            const parked = (await probe`
              select 1 from pg_stat_activity a
              where a.wait_event_type = 'Lock' and a.state = 'active' and a.query ilike '%"batches"%'
                and ${pid[0]!.pid}::int = any(pg_blocking_pids(a.pid))`) as unknown as unknown[];
            if (parked.length > 0) break;
            if (Date.now() > deadline) throw new Error('the receipt never parked behind the filler');
            await new Promise((r) => setTimeout(r, 25));
          }
        });
        return await pending!;
      } finally {
        await Promise.allSettled([pending]);
        await holder.end();
        await probe.end();
      }
    }

    it('unjudged (no client requires expiry): the filler\'s date stands and the line books, with no derivedExpiry', async () => {
      await seedBatch(sku('PLAIN', 'D180'), 'RACE1', '2026-09-01T00:00:00Z', null);
      const res = await raceFiller(sku('PLAIN', 'D180'), 'RACE1', '2027-05-31', () =>
        receive('PLAIN', [line(sku('PLAIN', 'D180'), 2, { batchCode: 'RACE1' })]),
      );
      expect(res.status).toBe(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.rejectedLines).toBeUndefined();
      expect(grn.lines).toEqual([expect.objectContaining({ qty: 2, batchCode: 'RACE1' })]);
      expect(grn.lines[0]!.derivedExpiry).toBeUndefined();
      expect(await batchFacts(sku('PLAIN', 'D180'), 'RACE1')).toMatchObject({ expiry: '2027-05-31', source: 'typed' });
    });

    it('judged (an expiry-required client): batch-expiry-mismatch carrying derivedExpiry, the reason says it was derived', async () => {
      await seedBatch(sku('EXP', 'E180'), 'RACE2', '2026-09-01T00:00:00Z', null);
      const res = await raceFiller(sku('EXP', 'E180'), 'RACE2', '2027-05-31', () =>
        receive('EXP', [line(sku('EXP', 'E180'), 2, { batchCode: 'RACE2' })]),
      );
      expect(res.status).toBe(201);
      const rejected = res.body.refusedReceipt.rejectedLines as RejectedLine[];
      expect(rejected).toEqual([
        expect.objectContaining({ code: 'batch-expiry-mismatch', expiryDate: '2027-02-28', derivedExpiry: { expiryDate: '2027-02-28', mfgDate: '2026-09-01', shelfLifeDays: 180 } }),
      ]);
      expect(rejected[0]!.reason).toContain("(derived from mfg 2026-09-01 + 180 days' shelf life)");
      expect(await batchFacts(sku('EXP', 'E180'), 'RACE2')).toMatchObject({ expiry: '2027-05-31', source: 'typed' });
    });
  });

  // ── byte-identity: the old op, the no-derivation receipt, the query count ──

  describe('nothing changes without a derivation', () => {
    it('a pre-2-4b op hashes byte for byte as before (golden), and its committed snapshot replays unchanged after a shelf life is set', async () => {
      const key = ulid();
      const first = await receive('PLAIN', [line(sku('PLAIN', 'NOSL'), 1, { batchCode: 'G1', mfgDate: mfg('2026-09-01') })], key).expect(201);
      const golden =
        `{"tenantId":"${tenantId}","deviceId":"${deviceId}","operatorUserId":"${operatorUserId}","warehouseId":"${wh}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${client('PLAIN')}","occurredAt":"${OCCURRED_AT}",` +
        `"lines":[{"poLineId":null,"skuId":"${sku('PLAIN', 'NOSL')}","batchCode":"G1","mfgDate":"2026-09-01T00:00:00Z","qty":1}]}`;
      const stored = (await sql`select payload_hash, response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as {
        payload_hash: string;
        response_snapshot: unknown;
      }[];
      expect(stored[0]!.payload_hash).toBe(createHash('sha256').update(golden, 'utf8').digest('hex'));
      // A receipt without a derivation carries no 2-4b key anywhere in its snapshot.
      expect(JSON.stringify(stored[0]!.response_snapshot)).not.toMatch(/derivedExpiry|replacedDerivedExpiry/);
      await setShelfLife(sku('PLAIN', 'NOSL'), 180);
      try {
        const replay = await receive('PLAIN', [line(sku('PLAIN', 'NOSL'), 1, { batchCode: 'G1', mfgDate: mfg('2026-09-01') })], key).expect(201);
        expect(replay.body).toEqual(first.body);
        expect(await batchFacts(sku('PLAIN', 'NOSL'), 'G1')).toMatchObject({ expiry: null, source: null });
      } finally {
        await setShelfLife(sku('PLAIN', 'NOSL'), null);
      }
    });

    it('A13: a default receipt of SKUs without a shelf life reads no batches (no extra query)', async () => {
      const spy = jest.spyOn(app.get(CatalogFacade), 'batchesByCodesInTx');
      await receiveGrn('PLAIN', [line(sku('PLAIN', 'NOSL'), 1, { batchCode: 'Q1', mfgDate: mfg('2026-09-01') }), line(sku('PLAIN', 'UNTR'), 1)]);
      expect(spy).not.toHaveBeenCalled();
      // …and the derivable one does.
      await receiveGrn('PLAIN', [line(sku('PLAIN', 'D180'), 1, { batchCode: 'Q2', mfgDate: mfg('2026-09-01') })]);
      expect(spy).toHaveBeenCalledTimes(1);
      // …and a client that turned derivation off reads nothing either.
      spy.mockClear();
      await receiveGrn('OFF', [line(sku('OFF', 'O180'), 1, { batchCode: 'Q3', mfgDate: mfg('2026-09-01') })]);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── the reads ──────────────────────────────────────────────────────────────

  describe('the reads', () => {
    it('the device snapshot carries shelfLifeDays per SKU and each client\'s deriveExpiry', async () => {
      const res = await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      const skus = res.body.skus as { id: string; shelfLifeDays: number | null }[];
      expect(skus.find((entry) => entry.id === sku('PLAIN', 'D180'))!.shelfLifeDays).toBe(180);
      expect(skus.find((entry) => entry.id === sku('PLAIN', 'NOSL'))!.shelfLifeDays).toBeNull();
      const clients = res.body.clients as { id: string; receivingPolicy: { deriveExpiry?: boolean } }[];
      expect(clients.find((entry) => entry.id === client('OFF'))!.receivingPolicy.deriveExpiry).toBe(false);
      expect(clients.find((entry) => entry.id === client('PLAIN'))!.receivingPolicy.deriveExpiry).toBe(true);
    });

    it('the OpenAPI publishes the new keys', async () => {
      const doc = (await http().get('/api/v1/openapi.json').expect(200)).body as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } };
      const schemas = doc.components.schemas;
      expect(Object.keys(schemas.CatalogSnapshotSkuDto!.properties)).toContain('shelfLifeDays');
      expect(Object.keys(schemas.GrnLineDto!.properties)).toEqual(expect.arrayContaining(['derivedExpiry', 'replacedDerivedExpiry']));
      expect(Object.keys(schemas.RejectedGrnLineDto!.properties)).toContain('derivedExpiry');
      expect(Object.keys(schemas.GoodsReceiptLineEntryDto!.properties)).toEqual(expect.arrayContaining(['batchMfgDate', 'batchExpiryDate', 'expirySource']));
      expect(Object.keys(schemas.UpdateClientReceivingPolicyDto!.properties)).toContain('deriveExpiry');
    });
  });

  // ── the per-client switch (A6) ──────────────────────────────────────────────

  describe('the receiving policy switch', () => {
    it('a PUT without deriveExpiry keeps the current value and hashes byte for byte as before (golden); with it, audited in changes', async () => {
      const policyClient = client('PLAIN');
      const body = { receivingToleranceBps: 100, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null };
      const key = ulid();
      const res = await putPolicy(policyClient, body, key).expect(200);
      expect(res.body.client.receivingPolicy).toEqual({ ...body, deriveExpiry: true });
      const golden = `{"arm":"receiving-policy","tenantId":"${tenantId}","clientId":"${policyClient}","receivingToleranceBps":100,"qcOnReceipt":false,"expiryRequired":false,"minShelfLifeDays":null}`;
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
      expect(stored[0]!.payload_hash).toBe(createHash('sha256').update(golden, 'utf8').digest('hex'));

      const offKey = ulid();
      const off = await putPolicy(policyClient, { ...body, deriveExpiry: false }, offKey).expect(200);
      expect(off.body.client.receivingPolicy.deriveExpiry).toBe(false);
      const goldenOff = `${golden.slice(0, -1)},"deriveExpiry":false}`;
      const storedOff = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${offKey}`) as unknown as { payload_hash: string }[];
      expect(storedOff[0]!.payload_hash).toBe(createHash('sha256').update(goldenOff, 'utf8').digest('hex'));
      await expectAuditRow({ tenantId, key: offKey, action: 'client.receiving_policy_updated', targetType: 'client', targetId: policyClient, actorUserId: ownerUserId });
      const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${offKey}`) as unknown as { changes: unknown }[];
      expect(audit[0]!.changes).toEqual({ deriveExpiry: { before: true, after: false } });

      // Absent keeps it off; the GET reads it.
      await putPolicy(policyClient, { ...body, receivingToleranceBps: 0 }).expect(200);
      const read = await http().get(`${API}/${tenantId}/clients/${policyClient}/receiving-policy`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(read.body).toMatchObject({ receivingToleranceBps: 0, deriveExpiry: false });
      const bad = await putPolicy(policyClient, { ...body, deriveExpiry: 'yes' }).expect(400);
      expect(bad.body.code).toBe('validation-failed');
      // Restore (the other tests use PLAIN as a deriving client).
      await putPolicy(policyClient, { ...body, receivingToleranceBps: 0, deriveExpiry: true }).expect(200);
    });
  });

  // ── the vocabulary pin (TS ↔ DB) ─────────────────────────────────────────────

  it('BATCH_EXPIRY_SOURCES matches the 0108 CHECK; both batches CHECKs are present', async () => {
    const rows = (await sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'public.batches'::regclass and conname in ('batches_expiry_source_check', 'batches_expiry_source_dated') order by conname`) as unknown as {
      conname: string;
      def: string;
    }[];
    expect(rows.map((row) => row.conname)).toEqual(['batches_expiry_source_check', 'batches_expiry_source_dated']);
    const listed = [...rows[0]!.def.matchAll(/'([a-z]+)'::text/g)].map((match) => match[1]);
    expect(listed).toEqual([...BATCH_EXPIRY_SOURCES]);
    await expect(sql`insert into batches (id, tenant_id, sku_id, code, expiry_source) values (${uuidv7()}, ${tenantId}, ${sku('PLAIN', 'D180')}, 'BAD-SRC', 'derived')`).rejects.toMatchObject({
      constraint_name: 'batches_expiry_source_dated',
    });
  });
});
