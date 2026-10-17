import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { Workbook } from 'exceljs';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { ASN_IMPORT_ROW_ERROR_CODES } from '../src/modules/inbound/asn-import.parse';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { expectAuditRow } from './support/audit-guard';

// The ASN import (2026-10-17): many advance shipment notices from one CSV or
// XLSX file. Every I/O matrix row of the spec, the dry run that writes
// nothing, the one-key replay, the savepoint that survives a concurrent
// manual create, the portal and role refusals, and the timing run at the cap.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(180_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

interface ImportBody {
  importId: string | null;
  dryRun: boolean;
  warehouseId: string;
  fileSha256: string;
  rowCount: number;
  asnCount: number;
  acceptedCount: number;
  refusedCount: number;
  asns: { asnId: string | null; asnCode: string; clientId: string; clientLabel: string; lineCount: number; firstRow: number }[];
  errors: { rowNumber: number; asnCode: string | null; code: string; detail: string; sku: string | null; quantity: string | null }[];
}

interface UploadFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

const HEADER = 'asn_code,client,warehouse,expected_at,sku,quantity';

function csvFile(lines: string[], header = HEADER): UploadFile {
  return { buffer: Buffer.from([header, ...lines].join('\n'), 'utf8'), filename: 'asns.csv', contentType: 'text/csv' };
}

async function xlsxFile(rows: unknown[][]): Promise<UploadFile> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('ASNs');
  for (const row of rows) sheet.addRow(row);
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    filename: 'asns.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

describe('ASN import (e2e, 2026-10-17)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorMemberToken: string;
  let accountantToken: string;
  let wh1: string;
  let wh1Code: string;
  let wh2Code: string;
  let whCap: string;
  let acme: string;
  let beta: string;
  let selfClient: string;
  const sku = new Map<string, string>();
  let operatorToken: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('asn_import');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2 });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Import Co ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await http().post(`${API}/sign-in`).send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;

    ({ id: wh1, code: wh1Code } = await createWarehouse('BLR-DC'));
    ({ code: wh2Code } = await createWarehouse('MUM-DC'));
    ({ id: whCap } = await createWarehouse('CAP-DC'));

    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    acme = await createClient('GLOWCO', 'Glow Co');
    beta = await createClient('ACME', 'Acme Brands');

    const tenSkus = Array.from({ length: 10 }, (_, i) => `GLOW-T${i},Glow T${i},pcs,1800,`);
    await importCatalog(['GLOW-1,Glow One,pcs,1800,', 'GLOW-2,Glow Two,pcs,1800,', 'GLOW-KG,Glow Bulk,kg,1800,', 'GLOW-KIT,Glow Kit,pcs,1800,', ...tenSkus], acme);
    await importCatalog(['ACME-1,Acme One,pcs,1800,'], beta);
    await importCatalog(['SELF-1,Self One,pcs,1800,'], selfClient);
    const skus = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const row of skus.body.items as { code: string; id: string }[]) sku.set(row.code, row.id);
    await http()
      .post(`${API}/${tenantId}/catalog/skus/${sku.get('GLOW-KIT')!}/kit`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: sku.get('GLOW-1')!, quantity: 1 }] })
      .expect(201);

    const ops = await createMember('ops_manager');
    opsToken = ops.token;
    opsUserId = ops.userId;
    operatorMemberToken = (await createMember('operator')).token;
    accountantToken = (await createMember('accountant')).token;

    // A badged-in handheld, for the device snapshot.
    const operator = await createMember('operator');
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Import dock', pin: '1357' })
      .expect(201);
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail: operator.email, pin: '1357' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
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

  async function createWarehouse(code: string): Promise<{ id: string; code: string }> {
    const res = await http()
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ origin: testAddress(), code, name: `Warehouse ${code}` })
      .expect(201);
    return { id: res.body.id as string, code };
  }

  async function createClient(code: string, name: string): Promise<string> {
    const res = await http()
      .post(`${API}/${tenantId}/clients`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code, name })
      .expect(201);
    return res.body.client.id as string;
  }

  async function importCatalog(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,product', ...rows].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  async function createMember(role: 'ops_manager' | 'operator' | 'accountant'): Promise<{ userId: string; token: string; email: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    const token = (await http().post(`${API}/sign-in`).send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
    return { userId: invited.body.user.id as string, token, email };
  }

  function upload(
    file: UploadFile,
    opts: { dryRun?: boolean; key?: string | null; token?: string; warehouseId?: string } = {},
  ): request.Test {
    let req = http()
      .post(`${API}/${tenantId}/inbound/asn-imports`)
      .set('Authorization', `Bearer ${opts.token ?? opsToken}`);
    const key = opts.key === undefined ? ulid() : opts.key;
    if (key !== null) req = req.set(KEY_HEADER, key);
    req = req.field('warehouseId', opts.warehouseId ?? wh1);
    if (opts.dryRun !== undefined) req = req.field('dryRun', String(opts.dryRun));
    return req.attach('file', file.buffer, { filename: file.filename, contentType: file.contentType });
  }

  async function imported(file: UploadFile, key = ulid()): Promise<ImportBody> {
    return (await upload(file, { key }).expect(201)).body as ImportBody;
  }

  async function counts(): Promise<{ asns: number; keys: number; audits: number }> {
    const [row] = await sql<{ asns: number; keys: number; audits: number }[]>`
      select (select count(*)::int from advance_shipment_notices where tenant_id = ${tenantId}) as asns,
             (select count(*)::int from idempotency_keys where tenant_id = ${tenantId}) as keys,
             (select count(*)::int from audit_events where tenant_id = ${tenantId}) as audits`;
    return row!;
  }

  async function snapshotAsnIds(warehouseId = wh1): Promise<string[]> {
    const res = await http()
      .get(`${API}/${tenantId}/devices/catalog-snapshot`)
      .query({ warehouseId })
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    return (res.body.openAsns as { id: string }[]).map((a) => a.id);
  }

  const codes = (body: ImportBody): [number, string | null, string][] => body.errors.map((e) => [e.rowNumber, e.asnCode, e.code]);
  const unique = () => ulid().slice(16);

  // ── the happy path and the acceptance criteria ─────────────────────────────

  it('Check file reports 3 ASNs / 10 lines and writes nothing; Import creates them exactly as the form would; a retry replays', async () => {
    const t = unique();
    const file = csvFile([
      `A-${t},GLOWCO,${wh1Code},2026-10-20,GLOW-1,5`, // row 2
      `A-${t},GLOWCO,${wh1Code},2026-10-20,GLOW-2,3`,
      `A-${t},GLOWCO,${wh1Code},2026-10-20,GLOW-KG,2.5`,
      `A-${t},GLOWCO,${wh1Code},2026-10-20,GLOW-T0,1`,
      `B-${t},,,2026-10-21 14:30,GLOW-1,10`, // row 6 — a blank client is the SKUs' client
      `B-${t},,,2026-10-21 14:30,GLOW-T1,10`,
      `B-${t},,,2026-10-21 14:30,GLOW-T2,10`,
      `C-${t},acme,,,ACME-1,7`, // row 9 — the client code is case-insensitive
      `A-${t},GLOWCO,${wh1Code},2026-10-20,GLOW-T3,1`,
      `B-${t},,,2026-10-21 14:30,GLOW-T4,2`,
    ]);

    const before = await counts();
    // What the web sends: Check file with NO Idempotency-Key.
    const bare = (await upload(file, { dryRun: true, key: null }).expect(200)).body as ImportBody;
    expect(bare).toMatchObject({ importId: null, dryRun: true, asnCount: 3, acceptedCount: 3 });
    expect(await counts()).toEqual(before);
    const key = ulid();
    const dry = await upload(file, { dryRun: true, key }).expect(200);
    const check = dry.body as ImportBody;
    expect(check).toMatchObject({ importId: null, dryRun: true, warehouseId: wh1, rowCount: 10, asnCount: 3, acceptedCount: 3, refusedCount: 0, errors: [] });
    expect(check.asns.map((a) => [a.asnCode, a.asnId, a.lineCount])).toEqual([
      [`A-${t}`, null, 5],
      [`B-${t}`, null, 4],
      [`C-${t}`, null, 1],
    ]);
    expect(check.asns.reduce((n, a) => n + a.lineCount, 0)).toBe(10);
    // Check file wrote NOTHING — no ASN, no key (even with a key sent), no audit row.
    expect(await counts()).toEqual(before);

    const res = await upload(file, { key }).expect(201);
    const body = res.body as ImportBody;
    expect(body).toMatchObject({ dryRun: false, rowCount: 10, asnCount: 3, acceptedCount: 3, refusedCount: 0, errors: [] });
    expect(body.importId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.asns.map((a) => [a.asnCode, a.clientId, a.clientLabel, a.lineCount, a.firstRow])).toEqual([
      [`A-${t}`, acme, 'GLOWCO', 5, 2],
      [`B-${t}`, acme, 'GLOWCO', 4, 6],
      [`C-${t}`, beta, 'ACME', 1, 9],
    ]);

    // Exactly as the Announce form would have made them.
    const detail = async (asnId: string) =>
      (await http().get(`${API}/${tenantId}/inbound/asns/${asnId}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.asn;
    const a = await detail(body.asns[0]!.asnId!);
    expect(a).toMatchObject({ code: `A-${t}`, clientId: acme, warehouseId: wh1, status: 'announced', expectedAt: '2026-10-19T18:30:00.000Z', statusNote: null, lineCount: 5 });
    expect(a.lines.map((l: { skuId: string; announcedQty: number; receivedQty: number }) => [l.skuId, l.announcedQty, l.receivedQty])).toEqual([
      [sku.get('GLOW-1'), 5, 0],
      [sku.get('GLOW-2'), 3, 0],
      [sku.get('GLOW-KG'), 2.5, 0],
      [sku.get('GLOW-T0'), 1, 0],
      [sku.get('GLOW-T3'), 1, 0],
    ]);
    expect((await detail(body.asns[1]!.asnId!)).expectedAt).toBe('2026-10-21T09:00:00.000Z');
    expect((await detail(body.asns[2]!.asnId!)).expectedAt).toBeNull();

    // Each ASN: its own asn.created outbox event and audit row (reference = the bare key).
    const ids = body.asns.map((x) => x.asnId!);
    const audits = await sql<{ action: string; target_type: string; target_id: string; actor_user_id: string }[]>`
      select action, target_type, target_id, actor_user_id from audit_events where tenant_id = ${tenantId} and reference = ${key} `;
    const byTarget = <T extends { target_id: string | null }>(rows: readonly T[]): T[] =>
      [...rows].sort((x, y) => (x.target_id! < y.target_id! ? -1 : 1));
    expect(byTarget(audits)).toEqual(
      byTarget([
        ...ids.map((id) => ({ action: 'asn.created', target_type: 'advance_shipment_notice', target_id: id, actor_user_id: opsUserId })),
        { action: 'asn_import.executed', target_type: 'asn_import', target_id: body.importId, actor_user_id: opsUserId },
      ]),
    );
    const events = await sql<{ id: string }[]>`
      select payload->'asn'->>'id' as id from outbox_messages where tenant_id = ${tenantId} and type = 'asn.created' and payload->'asn'->>'id' in ${sql(ids)}`;
    expect(events.map((e) => e.id).sort()).toEqual([...ids].sort());
    const keyRows = await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
    expect(keyRows).toHaveLength(1);

    // The handheld snapshot lists them.
    const snapshot = await snapshotAsnIds();
    for (const id of ids) expect(snapshot).toContain(id);

    // A retry with the same key and file replays the stored answer; nothing new is created.
    const afterImport = await counts();
    expect((await upload(file, { key }).expect(201)).body).toEqual(body);
    expect(await counts()).toEqual(afterImport);
    // The same key with a different file is 422.
    const other = csvFile([`Z-${t},GLOWCO,,,GLOW-1,1`]);
    expect((await upload(other, { key }).expect(422)).body.code).toBe('idempotency-key-reuse');
    // …and with the same file for another warehouse too (the fingerprint is {fileSha256, warehouseId}).
    expect((await upload(file, { key, warehouseId: whCap }).expect(422)).body.code).toBe('idempotency-key-reuse');
  });

  it('an ASN with any bad row is refused whole; the others are created (row numbers are spreadsheet rows)', async () => {
    const t = unique();
    const body = await imported(
      csvFile([
        `OK-${t},GLOWCO,,,GLOW-1,1`,
        `BAD-${t},GLOWCO,,,GLOW-2,1`,
        ``,
        `BAD-${t},GLOWCO,,,NO-SUCH-SKU,1`,
        `OK2-${t},GLOWCO,,,GLOW-2,4`,
      ]),
    );
    expect(body.asns.map((a) => a.asnCode)).toEqual([`OK-${t}`, `OK2-${t}`]);
    expect(body).toMatchObject({ asnCount: 3, acceptedCount: 2, refusedCount: 1 });
    // Each error carries its row's own sku and quantity cells, so the report identifies the line.
    expect(body.errors).toEqual([
      { rowNumber: 5, asnCode: `BAD-${t}`, code: 'unknown-sku', detail: 'No SKU with code "NO-SUCH-SKU" exists in this tenant.', sku: 'NO-SUCH-SKU', quantity: '1' },
    ]);
    const bad = await sql`select 1 from advance_shipment_notices where tenant_id = ${tenantId} and asn_code = ${`BAD-${t}`}`;
    expect(bad).toHaveLength(0);
  });

  it('client attribution: another client’s SKU (sku-client-mismatch), a blank client over two clients’ SKUs (mixed-client), unknown client', async () => {
    const t = unique();
    const body = await imported(
      csvFile([
        `M-${t},GLOWCO,,,GLOW-1,1`,
        `M-${t},GLOWCO,,,ACME-1,1`,
        `X-${t},,,,GLOW-1,1`,
        `X-${t},,,,ACME-1,1`,
        `U-${t},ACMEE,,,GLOW-1,1`,
        `S-${t},self,,,SELF-1,2`,
      ]),
    );
    expect(codes(body)).toEqual([
      [2, `M-${t}`, 'mixed-client'],
      [4, `X-${t}`, 'mixed-client'],
      [6, `U-${t}`, 'unknown-client'],
    ]);
    // `self` names the tenant's own goods.
    expect(body.asns.map((a) => [a.asnCode, a.clientId])).toEqual([[`S-${t}`, selfClient]]);

    const mismatch = await imported(csvFile([`MM-${t},ACME,,,GLOW-1,1`, `MM-${t},ACME,,,GLOW-2,1`]));
    expect(codes(mismatch)).toEqual([
      [2, `MM-${t}`, 'sku-client-mismatch'],
      [3, `MM-${t}`, 'sku-client-mismatch'],
    ]);
    expect(mismatch.errors[0]!.detail).toContain('is for client ACME');
  });

  it('kits, repeated SKUs, disagreeing rows, precision, bad cells, codes already used, and too many lines are each refused by name', async () => {
    const t = unique();
    await imported(csvFile([`USED-${t},GLOWCO,,,GLOW-1,1`]));
    const longCode = 'L'.repeat(65);
    const tooMany = Array.from({ length: 201 }, (_, i) => `MANY-${t},GLOWCO,,,GLOW-${i % 2 === 0 ? 1 : 2},1`);
    const body = await imported(
      csvFile([
        `KIT-${t},GLOWCO,,,GLOW-KIT,1`,
        `DUP-${t},GLOWCO,,,GLOW-1,1`,
        `DUP-${t},GLOWCO,,,GLOW-1,2`,
        `DIS-${t},GLOWCO,${wh1Code},,GLOW-1,1`,
        `DIS-${t},GLOWCO,${wh2Code},,GLOW-2,1`,
        `PRE-${t},GLOWCO,,,GLOW-1,1.5`,
        `QTY-${t},GLOWCO,,,GLOW-1,0`,
        `DAT-${t},GLOWCO,,20/10/2026,GLOW-1,1`,
        `USED-${t},GLOWCO,,,GLOW-2,1`,
        `${longCode},GLOWCO,,,GLOW-1,1`,
        `,GLOWCO,,,GLOW-1,1`,
        `BLANK-${t},GLOWCO,,,,1`,
        ...tooMany,
      ]),
    );
    expect(body.acceptedCount).toBe(0);
    expect(codes(body).slice(0, 12)).toEqual([
      [2, `KIT-${t}`, 'kit-cannot-hold-stock'],
      [4, `DUP-${t}`, 'duplicate-sku-in-asn'],
      [6, `DIS-${t}`, 'wrong-warehouse'],
      [6, `DIS-${t}`, 'asn-rows-disagree'],
      [7, `PRE-${t}`, 'quantity-precision'],
      [8, `QTY-${t}`, 'invalid-quantity'],
      [9, `DAT-${t}`, 'invalid-expected-at'],
      [10, `USED-${t}`, 'duplicate-asn-code'],
      [11, longCode, 'invalid-asn-code'],
      [12, null, 'missing-value'],
      [13, `BLANK-${t}`, 'missing-value'],
      [14, `MANY-${t}`, 'too-many-lines'],
    ]);
    expect(body.errors.find((e) => e.code === 'asn-rows-disagree')!.detail).toContain('warehouse');
    expect(body.errors.find((e) => e.code === 'kit-cannot-hold-stock')!.detail).toContain('"GLOW-KIT"');
    expect(body.errors.find((e) => e.code === 'duplicate-asn-code')!.detail).toBe(`Client GLOWCO already has an advance shipment notice "USED-${t}".`);
    expect(body.errors.find((e) => e.code === 'quantity-precision')!.detail).toContain('whole number');
    // Every reason this suite raises is in the closed vocabulary the DTO publishes.
    for (const error of body.errors) expect(ASN_IMPORT_ROW_ERROR_CODES).toContain(error.code);
  });

  it('warehouse: blank or this warehouse (any case) is accepted; another is wrong-warehouse; an unknown code is unknown-warehouse', async () => {
    const t = unique();
    const body = await imported(
      csvFile([
        `W1-${t},GLOWCO,${wh1Code.toLowerCase()},,GLOW-1,1`,
        `W2-${t},GLOWCO,${wh2Code},,GLOW-1,1`,
        `W3-${t},GLOWCO,NOWHERE,,GLOW-1,1`,
      ]),
    );
    expect(body.asns.map((a) => a.asnCode)).toEqual([`W1-${t}`]);
    expect(codes(body)).toEqual([
      [3, `W2-${t}`, 'wrong-warehouse'],
      [4, `W3-${t}`, 'unknown-warehouse'],
    ]);
  });

  it('a blank client is the SKUs\' client: rows naming the same client and blank rows are ONE ASN; a blank row of another client\'s SKU refuses the whole ASN', async () => {
    const t = unique();
    const body = await imported(csvFile([`MIX-${t},GLOWCO,,,GLOW-1,1`, `MIX-${t},,,,GLOW-2,1`]));
    expect(body).toMatchObject({ asnCount: 1, acceptedCount: 1, refusedCount: 0, errors: [] });
    expect(body.asns.map((a) => [a.asnCode, a.clientId, a.lineCount])).toEqual([[`MIX-${t}`, acme, 2]]);
    const mixed = await sql`select 1 from advance_shipment_notices where tenant_id = ${tenantId} and asn_code = ${`MIX-${t}`}`;
    expect(mixed).toHaveLength(1);

    const bad = await imported(csvFile([`DIS2-${t},GLOWCO,,,GLOW-1,1`, `DIS2-${t},,,,ACME-1,1`]));
    expect(bad).toMatchObject({ asnCount: 1, acceptedCount: 0, refusedCount: 1 });
    expect(codes(bad)).toContainEqual([3, `DIS2-${t}`, 'asn-rows-disagree']);
    const none = await sql`select 1 from advance_shipment_notices where tenant_id = ${tenantId} and asn_code = ${`DIS2-${t}`}`;
    expect(none).toHaveLength(0);
  });

  it('a blank-client ASN refused for a used code names the client by its code, never a uuid', async () => {
    const t = unique();
    await imported(csvFile([`USED2-${t},,,,GLOW-1,1`]));
    const again = await upload(csvFile([`USED2-${t},,,,GLOW-2,1`]), { dryRun: true, key: null }).expect(200);
    expect((again.body as ImportBody).errors[0]!.detail).toBe(`Client GLOWCO already has an advance shipment notice "USED2-${t}".`);
  });

  it('the same code for two clients is two ASNs', async () => {
    const t = unique();
    const body = await imported(csvFile([`TWIN-${t},GLOWCO,,,GLOW-1,1`, `TWIN-${t},ACME,,,ACME-1,1`]));
    expect(body.asns.map((a) => [a.asnCode, a.clientId])).toEqual([
      [`TWIN-${t}`, acme],
      [`TWIN-${t}`, beta],
    ]);
  });

  it('XLSX: an Excel date cell is its IST wall clock, a serial number is refused, extra columns are ignored', async () => {
    const t = unique();
    const file = await xlsxFile([
      ['ASN_Code', 'Notes', 'Expected_At', 'SKU', 'Quantity'],
      [`XD-${t}`, 'dock 3', new Date(Date.UTC(2026, 9, 20, 14, 30)), 'GLOW-1', 5],
      [`XD-${t}`, '', new Date(Date.UTC(2026, 9, 20, 14, 30)), 'GLOW-KG', 0.25],
      [`XS-${t}`, '', 46315, 'GLOW-1', 1],
    ]);
    const body = await imported(file);
    expect(body.asns.map((a) => [a.asnCode, a.lineCount])).toEqual([[`XD-${t}`, 2]]);
    expect(codes(body)).toEqual([[4, `XS-${t}`, 'invalid-expected-at']]);
    const [row] = await sql<{ at: string }[]>`select expected_at::text as at from advance_shipment_notices where id = ${body.asns[0]!.asnId!}`;
    expect(new Date(row!.at).toISOString()).toBe('2026-10-20T09:00:00.000Z');
  });

  // ── file-level refusals ────────────────────────────────────────────────────

  it('a bad file creates nothing: wrong type 415, empty 400, missing columns 400 (naming them), over 5 MB / 5,000 rows / 500 ASNs 422', async () => {
    const before = await counts();
    const pdf = { buffer: Buffer.from('%PDF-1.4'), filename: 'asns.pdf', contentType: 'application/pdf' };
    expect((await upload(pdf).expect(415)).body.code).toBe('unsupported-file-type');
    expect((await upload(csvFile([])).expect(400)).body.code).toBe('file-unreadable');
    const missing = await upload(csvFile(['A,GLOWCO'], 'asn_code,client')).expect(400);
    expect(missing.body).toMatchObject({ code: 'missing-columns', detail: 'The header row is missing the required columns "sku", "quantity".' });
    const big = { buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 0x41), filename: 'asns.csv', contentType: 'text/csv' };
    expect((await upload(big).expect(422)).body.code).toBe('import-too-large');
    const rows = Array.from({ length: 5001 }, (_, i) => `R-${i},GLOWCO,,,GLOW-1,1`);
    expect((await upload(csvFile(rows)).expect(422)).body).toMatchObject({ code: 'import-too-large', detail: 'The file has 5001 data rows — the cap is 5000.' });
    const asns = Array.from({ length: 501 }, (_, i) => `N-${i},GLOWCO,,,GLOW-1,1`);
    expect((await upload(csvFile(asns)).expect(422)).body).toMatchObject({ code: 'import-too-large', detail: 'The file announces 501 ASNs — the cap is 500 per import.' });
    expect((await upload(csvFile(['A,GLOWCO,,,GLOW-1,1']), { warehouseId: uuidv7() }).expect(404)).body.code).toBe('not-found');
    expect((await upload(csvFile(['A,GLOWCO,,,GLOW-1,1']), { key: null }).expect(400)).body.code).toBe('idempotency-key-required');
    expect(await counts()).toEqual(before);
  });

  // ── authority ──────────────────────────────────────────────────────────────

  it('asn.manage only: operator and accountant 403 role-denied; a client-portal session 403 at the fence; checked before the file is read', async () => {
    const file = csvFile(['A,GLOWCO,,,GLOW-1,1']);
    const garbage = { buffer: Buffer.from('not,a\n"broken'), filename: 'asns.csv', contentType: 'text/csv' };
    for (const token of [operatorMemberToken, accountantToken]) {
      expect((await upload(file, { token }).expect(403)).body.code).toBe('role-denied');
      expect((await upload(file, { token, dryRun: true }).expect(403)).body.code).toBe('role-denied');
      // Authority first: an unreadable file still answers 403, not 400.
      expect((await upload(garbage, { token, dryRun: true }).expect(403)).body.code).toBe('role-denied');
    }
    const email = `client-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role: 'client', clientId: acme })
      .expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    const portalToken = (await http().post(`${API}/sign-in`).send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
    const portal = await upload(file, { token: portalToken }).expect(403);
    expect(portal.body).toMatchObject({ code: 'role-denied', detail: 'This is an operator surface.' });
    const portalCheck = await upload(file, { token: portalToken, dryRun: true, key: null }).expect(403);
    expect(portalCheck.body).toMatchObject({ code: 'role-denied', detail: 'This is an operator surface.' });
    // The owner may import too (asn.manage).
    await upload(csvFile([`OWN-${unique()},GLOWCO,,,GLOW-1,1`]), { token: ownerToken }).expect(201);
  });

  // ── the audit row ──────────────────────────────────────────────────────────

  it('an import that creates nothing still answers, stores its key and writes its one asn_import.executed row', async () => {
    const key = ulid();
    const file = csvFile([`NONE-${unique()},GLOWCO,,,NO-SKU,1`]);
    const body = await imported(file, key);
    expect(body).toMatchObject({ acceptedCount: 0, refusedCount: 1, asns: [] });
    await expectAuditRow({ tenantId, key, action: 'asn_import.executed', targetType: 'asn_import', targetId: body.importId!, actorUserId: opsUserId });
    // A replay writes no second row.
    expect((await upload(file, { key }).expect(201)).body).toEqual(body);
    await expectAuditRow({ tenantId, key, action: 'asn_import.executed', targetType: 'asn_import', targetId: body.importId!, actorUserId: opsUserId });
  });

  // ── a concurrent manual create ─────────────────────────────────────────────

  it('a manual create of the same code racing the import refuses only that ASN (its savepoint) — the rest of the run is created', async () => {
    const t = unique();
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    let pending: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        // A manual create of RACE-t, committed only once the import is parked behind it.
        await tx`insert into advance_shipment_notices (id, tenant_id, client_id, warehouse_id, asn_code, status)
          values (${uuidv7()}, ${tenantId}, ${acme}, ${wh1}, ${`RACE-${t}`}, 'announced')`;
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }];
        pending = (async () =>
          upload(csvFile([`FIRST-${t},GLOWCO,,,GLOW-1,1`, `RACE-${t},GLOWCO,,,GLOW-1,1`, `LAST-${t},GLOWCO,,,GLOW-2,1`])))();
        const deadline = Date.now() + 15_000;
        for (;;) {
          const parked = (await probe`
            select 1 from pg_stat_activity where wait_event_type = 'Lock' and ${pid} = any(pg_blocking_pids(pid))`) as unknown as unknown[];
          if (parked.length > 0) break;
          if (Date.now() > deadline) throw new Error('the import never parked behind the manual create');
          await new Promise((r) => setTimeout(r, 25));
        }
      });
      const res = await pending!;
      expect(res.status).toBe(201);
      const body = res.body as ImportBody;
      expect(body.asns.map((a) => a.asnCode)).toEqual([`FIRST-${t}`, `LAST-${t}`]);
      expect(codes(body)).toEqual([[3, `RACE-${t}`, 'duplicate-asn-code']]);
      // The race's savepoint rolled back its own outbox and audit rows only.
      const raced = await sql`select a.id from advance_shipment_notices a where a.tenant_id = ${tenantId} and a.asn_code = ${`RACE-${t}`}`;
      expect(raced).toHaveLength(1);
      const audits = await sql`select 1 from audit_events where tenant_id = ${tenantId} and target_id = ${raced[0]!.id as string}`;
      expect(audits).toHaveLength(0);
    } finally {
      await Promise.allSettled([pending]);
      await holder.end();
      await probe.end();
    }
  });

  it('two imports with the same key at once: one creates, the other answers 409 conflict and leaves nothing; a retry replays', async () => {
    const t = unique();
    const key = ulid();
    const file = csvFile([`SAME-${t},GLOWCO,,,GLOW-1,1`]);
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      // A held, never-committed row of the same code parks BOTH imports past
      // their replay lookup; rolling it back releases them into each other.
      await holder
        .begin(async (tx) => {
          await tx`insert into advance_shipment_notices (id, tenant_id, client_id, warehouse_id, asn_code, status)
            values (${uuidv7()}, ${tenantId}, ${acme}, ${wh1}, ${`SAME-${t}`}, 'announced')`;
          const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }];
          first = (async () => upload(file, { key }))();
          second = (async () => upload(file, { key }))();
          const deadline = Date.now() + 15_000;
          for (;;) {
            const waiting = (await probe`
              select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a where a.wait_event_type = 'Lock'`) as unknown as {
              pid: number;
              blockers: number[];
            }[];
            const chain = new Set<number>([pid]);
            for (let grew = true; grew; ) {
              grew = false;
              for (const row of waiting) {
                if (!chain.has(row.pid) && row.blockers.some((b) => chain.has(b))) {
                  chain.add(row.pid);
                  grew = true;
                }
              }
            }
            if (chain.size - 1 >= 2) break;
            if (Date.now() > deadline) throw new Error('the imports never parked');
            await new Promise((r) => setTimeout(r, 25));
          }
          throw new Error('rollback');
        })
        .catch((err: Error) => expect(err.message).toBe('rollback'));
      const results = await Promise.all([first!, second!]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const winner = results.find((r) => r.status === 201)!;
      expect(results.find((r) => r.status === 409)!.body.code).toBe('conflict');
      const keys = await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
      expect(keys).toHaveLength(1);
      const asns = await sql`select 1 from advance_shipment_notices where tenant_id = ${tenantId} and asn_code = ${`SAME-${t}`}`;
      expect(asns).toHaveLength(1);
      expect((await upload(file, { key }).expect(201)).body).toEqual(winner.body);
    } finally {
      await Promise.allSettled([first, second]);
      await holder.end();
      await probe.end();
    }
  });

  // ── the cap, timed ─────────────────────────────────────────────────────────

  it('500 ASNs × 10 lines (the row and ASN caps together) import in one request within a bounded time', async () => {
    const t = unique();
    const rows: string[] = [];
    for (let a = 0; a < 500; a += 1) {
      for (let l = 0; l < 10; l += 1) rows.push(`CAP-${t}-${a},GLOWCO,,2026-10-25,GLOW-T${l},${l + 1}`);
    }
    const started = Date.now();
    const res = await upload(csvFile(rows), { warehouseId: whCap }).expect(201);
    const elapsed = Date.now() - started;
    const body = res.body as ImportBody;
    expect(body).toMatchObject({ rowCount: 5000, asnCount: 500, acceptedCount: 500, refusedCount: 0, errors: [] });
    // The bound is generous for CI (≈4.5 s locally on 2026-10-17); the
    // figure is recorded in the PENDING snapshot-growth note.
    expect(elapsed).toBeLessThan(60_000);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from advance_shipment_notices where tenant_id = ${tenantId} and warehouse_id = ${whCap}`;
    expect(n!.n).toBe(500);
  });

  it('the OpenAPI document lists the import route and its row-error enum', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    expect(Object.keys(doc.body.paths as Record<string, unknown>)).toContain('/tenants/{tenantId}/inbound/asn-imports');
    const schema = doc.body.components.schemas.AsnImportRowErrorDto;
    expect([...schema.properties.code.enum].sort()).toEqual([...ASN_IMPORT_ROW_ERROR_CODES].sort());
  });
});
