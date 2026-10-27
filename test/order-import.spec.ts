import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Workbook } from 'exceljs';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { OrderCommandService } from '../src/modules/outbound/order.command';
import { ValkeyClient } from '../src/shared/valkey/valkey.client';
import { licenceClock } from '../src/modules/compliance/licence-enforcement';
import { orderImportClock, orderImportHooks } from '../src/modules/outbound/order-import.command';
import { ORDER_IMPORT_ROW_ERROR_CODES, orderImportOrderKey } from '../src/modules/outbound/order-import.parse';
import { addIsoDays, istDateOf } from '../src/shared/primitives/time';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 4-1c — the STAFF order import (`POST …/outbound/order-imports`): one
// file, one row per order line, grouped by the client order number; Check
// file runs each order through `createOrder`'s phase 1 and writes nothing;
// Import creates each through `createOrder` under a key derived from the
// import's, refuses an order with any bad row whole, and writes one
// `order_import.executed` row and the import key LAST. Every matrix row of
// the spec, the lease, the budget, the resume, the settle-once probe and the
// recalled-lot interaction (3-7a).
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.LICENCE_EXPIRY_POLL_MS;

jest.setTimeout(300_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const TODAY = '2026-11-02';
const HEADER =
  'order_ref,client,warehouse,sku,quantity,rate,ship_to_name,ship_to_phone,ship_to_line1,ship_to_line2,ship_to_city,ship_to_state,ship_to_pincode,consignee_gstin,consignee_legal_name,order_type,priority,ship_by,cod_amount,notes';
const ADDR = 'Priya Sharma,9845012345,12 Peenya Industrial Area,Gate 3,Bengaluru,Karnataka,560066';
const BLANK_ADDR = ',,,,,,';

/** One CSV row: order_ref, client, warehouse, sku, quantity, rate, address (7 cells), gstin, legal, type, priority, ship_by, cod, notes. */
function row(ref: string, sku: string, quantity: string, extra: Partial<Record<'client' | 'warehouse' | 'rate' | 'addr' | 'gstin' | 'legal' | 'type' | 'priority' | 'shipBy' | 'cod' | 'notes', string>> = {}): string {
  return [
    ref,
    extra.client ?? '',
    extra.warehouse ?? '',
    sku,
    quantity,
    extra.rate ?? '',
    extra.addr ?? ADDR,
    extra.gstin ?? '',
    extra.legal ?? '',
    extra.type ?? '',
    extra.priority ?? '',
    extra.shipBy ?? '',
    extra.cod ?? '',
    extra.notes ?? '',
  ].join(',');
}
const file = (...rows: string[]): string => [HEADER, ...rows].join('\n');
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

interface ImportBody {
  importId: string | null;
  dryRun: boolean;
  warehouseId: string;
  fileSha256: string;
  rowCount: number;
  orderCount: number;
  acceptedCount: number;
  refusedCount: number;
  complete: boolean;
  notAttemptedCount: number;
  orders: { orderId: string | null; clientOrderRef: string; lineCount: number; firstRow: number; replayed: boolean; clientId: string; clientLabel: string; backorderedLineCount: number | null }[];
  errors: { rowNumber: number; orderRef: string | null; sku: string | null; quantity: string | null; code: string; detail: string }[];
}

describe('order import — staff (e2e, story 4-1c)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let valkey: Redis;
  const realLicenceNow = licenceClock.now;
  const realImportNow = orderImportClock.now;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let floorToken: string;
  let wh: string;
  let whCode: string;
  let otherWhCode: string;
  let bin: string;
  let acme: string;
  let beta: string;
  let self: string;
  const sku = new Map<string, string>();

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('orderimport');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });
    licenceClock.now = () => Date.parse(`${TODAY}T06:00:00Z`);

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Order Import 3PL ${ulid()}`, ownerEmail, password: PASSWORD }).expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = await signIn(ownerEmail);
    const ops = await createMember('ops_manager');
    opsToken = ops.token;
    opsUserId = ops.userId;
    floorToken = (await createMember('operator')).token;

    whCode = `OI-W1-${ulid().slice(20)}`;
    otherWhCode = `OI-W2-${ulid().slice(20)}`;
    wh = await createWarehouse(whCode);
    await createWarehouse(otherWhCode);
    const zone = (await authed(http().post(`${API}/${tenantId}/warehouses/${wh}/zones`)).send({ code: 'A', name: 'Zone A' }).expect(201)).body.id as string;
    bin = (await authed(http().post(`${API}/${tenantId}/warehouses/${wh}/zones/${zone}/bins`)).send({ capacity: 10_000_000, type: 'shelf', code: 'A-01-01' }).expect(201)).body.id as string;

    acme = await createClient('ACME', 'Acme Apparel');
    beta = await createClient('BETA', 'Beta Beauty');
    self = ((await sql`select id from clients where tenant_id = ${tenantId} and system_owned`)[0] as { id: string }).id;
    const perf = Array.from({ length: 10 }, (_, i) => `P-${i},Perf ${i},pcs,1800,,false,false`);
    await importCsv(
      ['A-1,Acme tee,pcs,1800,,false,false', 'A-2,Acme cap,pcs,1800,,false,false', 'A-3,Acme sock,pcs,1800,,false,false', 'A-KG,Acme rice,kg,500,,false,false', 'A-C1,Acme band,pcs,1800,,false,false', 'A-KIT,Acme bundle,pcs,1800,,false,false', 'A-LOT,Acme balm,pcs,1800,,true,false', 'SH-1,Shared code,pcs,1800,,false,false', ...perf],
      acme,
    );
    await importCsv(['B-1,Beta serum,pcs,1800,,false,false', 'SH-1,Shared code,pcs,1800,,false,false'], beta);
    await importCsv(['S-1,Own tee,pcs,1800,,false,false'], self);
    for (const item of (await authed(http().get(`${API}/${tenantId}/catalog/skus?limit=200`)).expect(200)).body.items as { code: string; id: string; clientId: string }[]) {
      sku.set(item.clientId === beta ? `BETA:${item.code}` : item.code, item.id);
    }
    await authed(http().post(`${API}/${tenantId}/catalog/skus/${sku.get('A-KIT')!}/kit`)).send({ components: [{ skuId: sku.get('A-C1')!, quantity: 1 }] }).expect(201);
    for (const [code, qty] of [
      ['A-1', 1000],
      ['A-2', 1000],
      ['A-3', 4],
      ['A-KG', 50],
      ['A-C1', 10],
      ['SH-1', 10],
      ['BETA:SH-1', 10],
      ['BETA:B-1', 10],
      ['S-1', 20],
      ...Array.from({ length: 10 }, (_, i) => [`P-${i}`, 1000] as const),
    ] as const) {
      await adjust(sku.get(code)!, qty);
    }
    await adjust(sku.get('A-LOT')!, 10, { code: 'L1' });
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, wh);
  });

  afterAll(async () => {
    licenceClock.now = realLicenceNow;
    orderImportClock.now = realImportNow;
    orderImportHooks.afterOrder = null;
    const keys = await valkey.keys(`wms:{${tenantId}}:*`).catch(() => [] as string[]);
    if (keys.length > 0) await valkey.del(...keys);
    await valkey.quit().catch(() => valkey.disconnect());
    await sql?.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  afterEach(() => {
    orderImportHooks.afterOrder = null;
    orderImportClock.now = realImportNow;
    licenceClock.now = () => Date.parse(`${TODAY}T06:00:00Z`);
    jest.restoreAllMocks();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  function authed(req: request.Test, token = ownerToken): request.Test {
    return req.set('Authorization', `Bearer ${token}`).set(KEY_HEADER, ulid());
  }

  async function signIn(email: string): Promise<string> {
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
  }

  async function createMember(role: 'ops_manager' | 'operator'): Promise<{ token: string; userId: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await authed(http().post(`${API}/${tenantId}/users`)).send({ email, role }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { token: await signIn(email), userId: invited.body.user.id as string };
  }

  async function createWarehouse(code: string): Promise<string> {
    return (await authed(http().post(`${API}/${tenantId}/warehouses`)).send({ origin: testAddress(), code, name: code }).expect(201)).body.id as string;
  }

  async function createClient(code: string, name: string): Promise<string> {
    return (await authed(http().post(`${API}/${tenantId}/clients`)).send({ code, name }).expect(201)).body.client.id as string;
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked', ...rows].join('\n');
    await authed(http().post(`${API}/${tenantId}/catalog/imports`))
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  async function adjust(skuId: string, quantityDelta: number, batch?: { code: string }): Promise<void> {
    await authed(http().post(`${API}/${tenantId}/inventory/adjustments`))
      .send({ warehouseId: wh, skuId, binId: bin, quantityDelta, reasonCode: 'stock-count', note: 'order import seed', ...(batch === undefined ? {} : { batch }) })
      .expect(201);
  }

  function upload(
    content: string | Buffer,
    opts: { dryRun?: boolean; key?: string | null; token?: string; filename?: string; warehouseId?: string } = {},
  ): request.Test {
    const req = http().post(`${API}/${tenantId}/outbound/order-imports`).set('Authorization', `Bearer ${opts.token ?? opsToken}`);
    const keyed = opts.key === null || opts.dryRun === true ? req : req.set(KEY_HEADER, opts.key ?? ulid());
    const withFields = keyed.field('warehouseId', opts.warehouseId ?? wh);
    return (opts.dryRun === true ? withFields.field('dryRun', 'true') : withFields).attach(
      'file',
      typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
      { filename: opts.filename ?? 'orders.csv', contentType: opts.filename?.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : opts.filename?.endsWith('.pdf') ? 'application/pdf' : 'text/csv' },
    );
  }

  async function count(query: PromiseLike<unknown>): Promise<number> {
    return Number(((await query) as { n: number }[])[0]!.n);
  }
  const ordersOf = (ref: string) => sql`select count(*)::int as n from orders where tenant_id = ${tenantId} and client_order_ref = ${ref}`;
  const keyRows = (key: string) => sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
  const importAudits = () => sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and action = 'order_import.executed'`;

  function derivedKey(importKey: string, content: string, client: string, orderRef: string): string {
    return orderImportOrderKey(importKey, { surface: 'staff', fileSha256: sha(content), warehouseId: wh, client, orderRef });
  }

  /** A unique order-number prefix per test (the client number is live-unique per client). */
  const refs = (): string => `T${ulid().slice(16)}`;

  // ── the happy path and the report ──────────────────────────────────────────

  it('staff happy (AC1): 3 orders, 7 rows, blank client — Check 3 ready writes nothing; Import creates 3 ordinary manual ACME orders under derived keys, one order_import.executed', async () => {
    const p = refs();
    const content = file(
      row(`${p}-1`, 'A-1', '2', { rate: '499.50', type: 'B2B', gstin: '29AAACM4321K1Z8', legal: 'Acme Stores Pvt Ltd', priority: 'Urgent', shipBy: addIsoDays(TODAY, 3), cod: '1499' }),
      row(`${p}-1`, 'A-2', '1', { addr: BLANK_ADDR }),
      row(`${p}-2`, 'A-1', '1'),
      row(`${p}-2`, 'A-KG', '2.5', { addr: BLANK_ADDR }),
      row(`${p}-2`, 'A-KIT', '1', { addr: BLANK_ADDR }),
      row(`${p}-3 `, 'A-1', '3'),
      row(`${p}-3`, 'A-2', '3', { notes: 'leave at gate' }),
    );
    const ordersBefore = await count(sql`select count(*)::int as n from orders where tenant_id = ${tenantId}`);
    const keysBefore = await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId}`);

    const checked = (await upload(content, { dryRun: true }).expect(200)).body as ImportBody;
    expect(checked).toMatchObject({ importId: null, dryRun: true, warehouseId: wh, fileSha256: sha(content), rowCount: 7, orderCount: 3, acceptedCount: 3, refusedCount: 0, complete: true, notAttemptedCount: 0, errors: [] });
    expect(checked.orders.map((order) => [order.clientOrderRef, order.orderId, order.lineCount, order.firstRow, order.clientId, order.clientLabel, order.backorderedLineCount, order.replayed])).toEqual([
      [`${p}-1`, null, 2, 2, acme, 'ACME', null, false],
      [`${p}-2`, null, 3, 4, acme, 'ACME', null, false],
      [`${p}-3`, null, 2, 7, acme, 'ACME', null, false],
    ]);
    expect(await count(sql`select count(*)::int as n from orders where tenant_id = ${tenantId}`)).toBe(ordersBefore);
    expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId}`)).toBe(keysBefore);

    const key = ulid();
    const imported = (await upload(content, { key }).expect(201)).body as ImportBody;
    expect(imported).toMatchObject({ dryRun: false, orderCount: 3, acceptedCount: 3, refusedCount: 0, complete: true, errors: [] });
    expect(imported.importId).toMatch(/^[0-9a-f-]{36}$/);
    expect(imported.orders.map((order) => [order.clientOrderRef, order.lineCount, order.backorderedLineCount, order.replayed])).toEqual([
      [`${p}-1`, 2, 0, false],
      [`${p}-2`, 3, 0, false],
      [`${p}-3`, 2, 0, false],
    ]);
    // Each order is exactly a create: its derived key, its snapshot, its order.created row (actor: the importer).
    for (const order of imported.orders) {
      const derived = derivedKey(key, content, '', order.clientOrderRef);
      const stored = (await sql`select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${derived}`)[0] as { response_snapshot: { order: { id: string } } };
      expect(stored.response_snapshot.order.id).toBe(order.orderId);
      await expectAuditRow({ tenantId, key: derived, action: 'order.created', targetType: 'order', targetId: order.orderId!, actorUserId: opsUserId });
    }
    await expectAuditRow({ tenantId, key, action: 'order_import.executed', targetType: 'order_import', targetId: imported.importId!, actorUserId: opsUserId });

    // The order rows: manual, ACME, the ship-to, the 4-2a fields (lower-cased, A5), the rate.
    const first = (await http().get(`${API}/${tenantId}/outbound/orders/${imported.orders[0]!.orderId}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.order;
    expect(first).toMatchObject({
      source: 'manual',
      clientId: acme,
      clientOrderRef: `${p}-1`,
      orderType: 'b2b',
      priority: 'urgent',
      shipByDate: addIsoDays(TODAY, 3),
      codAmountPaise: 149_900,
      destination: { contactName: 'Priya Sharma', phone: '9845012345', line1: '12 Peenya Industrial Area', line2: 'Gate 3', city: 'Bengaluru', state: 'Karnataka', pincode: '560066' },
    });
    const rates = await sql`select l.rate_paise from order_lines l where l.order_id = ${imported.orders[0]!.orderId} order by l.created_at, l.id`;
    expect(rates.map((r) => (r.rate_paise === null ? null : Number(r.rate_paise)))).toEqual([49_950, null]);
    // A4 — "<ref>-3 " and "<ref>-3" were one order; the kit line counts once.
    expect(await count(ordersOf(`${p}-3`))).toBe(1);
    // The list shows them.
    const listed = (await http().get(`${API}/${tenantId}/warehouses/${wh}/outbound/orders?limit=200`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.items as { id: string }[];
    expect(listed.map((item) => item.id)).toEqual(expect.arrayContaining(imported.orders.map((order) => order.orderId)));

    // Retry after a timeout: same key, same file → the stored response, nothing re-run.
    const replayed = (await upload(content, { key }).expect(201)).body as ImportBody;
    expect(replayed).toEqual(imported);
    expect(await count(ordersOf(`${p}-1`))).toBe(1);
    await expectAuditRow({ tenantId, key, action: 'order_import.executed', targetType: 'order_import', targetId: imported.importId!, actorUserId: opsUserId });

    // Key reuse: the same key with another file → 422.
    expect((await upload(file(row(`${p}-9`, 'A-1', '1')), { key }).expect(422)).body.code).toBe('idempotency-key-reuse');
    // Re-upload: the same file under a NEW key → every order refused by the live client number.
    const again = (await upload(content, { key: ulid() }).expect(201)).body as ImportBody;
    expect(again).toMatchObject({ acceptedCount: 0, refusedCount: 3 });
    expect(again.errors.map((error) => [error.rowNumber, error.orderRef, error.code])).toEqual([
      [2, `${p}-1`, 'duplicate-client-order-ref'],
      [4, `${p}-2`, 'duplicate-client-order-ref'],
      [7, `${p}-3`, 'duplicate-client-order-ref'],
    ]);
    expect(again.errors[0]!.detail).toContain(`(in warehouse ${whCode})`);
    expect(await count(ordersOf(`${p}-1`))).toBe(1);
  });

  it('mixed file and the report: SO-2’s bad pincode refuses SO-2 only (the create’s address detail on its first row); the refused row carries its sku and quantity cells', async () => {
    const p = refs();
    const badAddr = 'Priya Sharma,9845012345,12 Peenya,,Bengaluru,Karnataka,56001';
    const content = file(row(`${p}-1`, 'A-1', '1'), row(`${p}-2`, 'A-1', '1', { addr: badAddr }), row(`${p}-2`, 'A-2', '4', { addr: BLANK_ADDR }), row(`${p}-3`, 'A-2', '1'));
    const checked = (await upload(content, { dryRun: true }).expect(200)).body as ImportBody;
    expect(checked.errors.map((error) => [error.rowNumber, error.code])).toEqual([[3, 'validation-failed']]);
    const body = (await upload(content).expect(201)).body as ImportBody;
    expect(body.orders.map((order) => order.clientOrderRef)).toEqual([`${p}-1`, `${p}-3`]);
    // An order-level refusal does not echo its first row's line cells (C10).
    expect(body.errors).toEqual([{ rowNumber: 3, orderRef: `${p}-2`, sku: null, quantity: null, code: 'validation-failed', detail: expect.stringContaining('pincode') }]);
    expect(await count(ordersOf(`${p}-2`))).toBe(0);
  });

  it('the file’s own rules: unknown/mismatched/mixed/required clients, warehouses, SKUs, quantities, rows disagreeing, a repeated SKU, a 201-line order, ship_by formats — each refuses its order only', async () => {
    const p = refs();
    const many = Array.from({ length: 201 }, (_, i) => row(`${p}-LINES`, `X-${i}`, '1', i === 0 ? {} : { addr: BLANK_ADDR }));
    const content = file(
      row(`${p}-OK`, 'A-1', '1'),
      row(`${p}-UC`, 'A-1', '1', { client: 'NOPE' }),
      row(`${p}-MM`, 'B-1', '1', { client: 'ACME' }),
      row(`${p}-MX`, 'A-1', '1'),
      row(`${p}-MX`, 'B-1', '1', { addr: BLANK_ADDR }),
      row(`${p}-CR`, 'SH-1', '1'),
      row(`${p}-WW`, 'A-1', '1', { warehouse: otherWhCode }),
      row(`${p}-UW`, 'A-1', '1', { warehouse: 'NOWHERE' }),
      row(`${p}-OWN`, 'A-1', '1', { warehouse: whCode.toLowerCase() }),
      row(`${p}-US`, 'NOPE-1', '1'),
      row(`${p}-QP`, 'A-1', '1.5'),
      row(`${p}-KG`, 'A-KG', '1.2345'),
      row(`${p}-RD`, 'A-1', '1'),
      row(`${p}-RD`, 'A-2', '1', { addr: 'Priya Sharma,9845012345,12 Peenya Industrial Area,Gate 3,Mumbai,Karnataka,560066' }),
      row(`${p}-DS`, 'A-1', '1'),
      row(`${p}-DS`, 'A-1', '2', { addr: BLANK_ADDR }),
      row(`${p}-SB`, 'A-1', '1', { shipBy: '30/10/2026' }),
      row(`${p}-MV`, 'A-1', '1', { addr: 'Priya Sharma,9845012345,12 Peenya,,Bengaluru,Karnataka,' }),
      ...many,
    );
    const body = (await upload(content).expect(201)).body as ImportBody;
    expect(body.orders.map((order) => order.clientOrderRef)).toEqual([`${p}-OK`, `${p}-OWN`]);
    const byRef = new Map<string, string[]>();
    for (const error of body.errors) byRef.set(error.orderRef!, [...(byRef.get(error.orderRef!) ?? []), error.code].sort());
    expect(Object.fromEntries(byRef)).toEqual({
      [`${p}-UC`]: ['unknown-client'],
      [`${p}-MM`]: ['sku-client-mismatch'],
      [`${p}-MX`]: ['mixed-client'],
      [`${p}-CR`]: ['client-required'],
      [`${p}-WW`]: ['wrong-warehouse'],
      [`${p}-UW`]: ['unknown-warehouse'],
      [`${p}-US`]: ['unknown-sku'],
      [`${p}-QP`]: ['quantity-precision'],
      [`${p}-KG`]: ['quantity-precision'],
      [`${p}-RD`]: ['order-rows-disagree'],
      [`${p}-DS`]: ['duplicate-sku-in-order'],
      [`${p}-SB`]: ['invalid-ship-by'],
      [`${p}-MV`]: ['missing-value'],
      // 201 unknown SKUs, and the order is too long.
      [`${p}-LINES`]: [...Array.from({ length: 201 }, () => 'unknown-sku'), 'too-many-lines'].sort(),
    });
    expect(body.errors.find((error) => error.code === 'invalid-ship-by')!.detail).toContain('30/10/2026 and 10/30/2026 are refused because they are ambiguous');
    expect(body.errors.find((error) => error.code === 'client-required')!.detail).toContain('ACME, BETA');
    expect(body).toMatchObject({ orderCount: 16, acceptedCount: 2, refusedCount: 14 });
  });

  it('A16: a blank client and `self` naming the same order number are both duplicate-order-in-file; `self` on its own is the tenant’s own order', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'S-1', '1'), row(`${p}-1`, 'S-1', '2', { client: 'self' }), row(`${p}-2`, 'S-1', '1', { client: 'SELF' }));
    const body = (await upload(content).expect(201)).body as ImportBody;
    expect(body.errors.map((error) => [error.rowNumber, error.code])).toEqual([
      [2, 'duplicate-order-in-file'],
      [3, 'duplicate-order-in-file'],
    ]);
    expect(body.orders).toEqual([expect.objectContaining({ clientOrderRef: `${p}-2`, clientId: self, clientLabel: expect.stringContaining('(your company)') })]);
  });

  it('backorder (staff): ask 10 with 4 available → created, backorderedLineCount 1', async () => {
    const p = refs();
    const body = (await upload(file(row(`${p}-1`, 'A-3', '10'), row(`${p}-1`, 'A-1', '1', { addr: BLANK_ADDR }))).expect(201)).body as ImportBody;
    expect(body.orders).toEqual([expect.objectContaining({ clientOrderRef: `${p}-1`, lineCount: 2, backorderedLineCount: 1 })]);
  });

  it('3-7a: a SKU whose only lot is under a LIVE recall imports backordered (the recall blocks the lot, so nothing is promisable) — never reserved against the recalled units', async () => {
    const lot = ((await sql`select b.id from batches b where b.tenant_id = ${tenantId} and b.sku_id = ${sku.get('A-LOT')!} and b.code = 'L1'`)[0] as { id: string }).id;
    await authed(http().post(`${API}/${tenantId}/inventory/recalls`), opsToken).send({ batchIds: [lot], reasonNote: 'contamination', mode: 'live' }).expect(201);
    const p = refs();
    const body = (await upload(file(row(`${p}-1`, 'A-LOT', '2'))).expect(201)).body as ImportBody;
    expect(body.orders).toEqual([expect.objectContaining({ clientOrderRef: `${p}-1`, backorderedLineCount: 1 })]);
    const held = await sql`select l.reserved_qty from order_lines l where l.order_id = ${body.orders[0]!.orderId}`;
    expect(held.map((line) => Number(line.reserved_qty))).toEqual([0]);
  });

  it('XLSX: a date cell is the IST day and a numeric pincode its digits; unknown columns are ignored', async () => {
    const p = refs();
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('orders');
    sheet.addRow(HEADER.split(','));
    sheet.addRow([`${p}-1`, '', '', 'A-1', 2, '', 'Priya Sharma', 9845012345, '12 Peenya', '', 'Bengaluru', 'Karnataka', 560066, '', '', '', '', new Date(Date.UTC(2026, 10, 9)), '', 'note']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const body = (await upload(buffer, { filename: 'orders.xlsx' }).expect(201)).body as ImportBody;
    expect(body.errors).toEqual([]);
    const order = (await sql`select destination_pincode, destination_phone, ship_by_date::text as ship_by from orders where id = ${body.orders[0]!.orderId}`)[0] as Record<string, string>;
    expect(order).toEqual({ destination_pincode: '560066', destination_phone: '9845012345', ship_by: '2026-11-09' });
  });

  // ── file-level refusals ───────────────────────────────────────────────────

  it('header and caps: a missing column is 400 missing-columns; 301 rows, 101 orders and 6 MB are 422 import-too-large', async () => {
    const noPincode = (await upload(['order_ref,sku,quantity,ship_to_name,ship_to_phone,ship_to_line1,ship_to_city,ship_to_state', 'X,A-1,1,a,b,c,d,e'].join('\n')).expect(400)).body;
    expect(noPincode).toMatchObject({ code: 'missing-columns', detail: expect.stringContaining('"ship_to_pincode"') });
    const tooManyRows = file(...Array.from({ length: 301 }, (_, i) => row(`R-${Math.floor(i / 20)}`, `X-${i % 20}`, '1')));
    expect((await upload(tooManyRows).expect(422)).body.code).toBe('import-too-large');
    const tooManyOrders = file(...Array.from({ length: 101 }, (_, i) => row(`O-${i}`, 'A-1', '1')));
    const orders = (await upload(tooManyOrders).expect(422)).body;
    expect(orders).toMatchObject({ code: 'import-too-large', detail: expect.stringContaining('101 orders') });
    const big = Buffer.alloc(6 * 1024 * 1024, 'a');
    expect((await upload(big).expect(422)).body.code).toBe('import-too-large');
    // Nothing was written by any of them: no order, no import audit row.
    expect(await count(ordersOf('O-0'))).toBe(0);
    expect(await count(ordersOf('R-0'))).toBe(0);
  });

  it('authority first: an operator (no orders.manage) is 403 before the file is read; a dry run needs no key, an import does', async () => {
    expect((await upload('not a sheet', { token: floorToken }).expect(403)).body.code).toBe('role-denied');
    expect((await upload(file(row('K-1', 'A-1', '1')), { key: null }).expect(400)).body.code).toMatch(/idempotency-key/);
    expect((await upload(file(row('K-1', 'A-1', '1')), { warehouseId: '0190aaaa-0000-7000-8000-000000000001' }).expect(404)).body.code).toBe('not-found');
  });

  // ── runs, retries and time ────────────────────────────────────────────────

  it('resume after 503 (decision 5): the run aborts after SO-1 naming the count; Import again with the same key replays SO-1 and creates the rest — nothing twice, no stored import until complete', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'A-1', '1'), row(`${p}-2`, 'A-1', '1'), row(`${p}-3`, 'A-2', '1'));
    const key = ulid();
    const store = app.get(ValkeyClient);
    const real = ValkeyClient.prototype.grantReservation;
    let grants = 0;
    jest.spyOn(store, 'grantReservation').mockImplementation(async (...args) => {
      grants += 1;
      if (grants === 1) return real.apply(store, args as Parameters<ValkeyClient['grantReservation']>);
      throw new Error('connection refused');
    });
    const failed = (await upload(content, { key }).expect(503)).body;
    expect(failed).toMatchObject({ code: 'reservation-store-unavailable', detail: expect.stringContaining('1 order was created') });
    expect(failed.detail).toContain('Import again with the same file');
    expect(await count(keyRows(key))).toBe(0);
    expect(await count(ordersOf(`${p}-1`))).toBe(1);
    expect(await count(ordersOf(`${p}-2`))).toBe(0);
    jest.restoreAllMocks();

    // C4 — a second abort right after the settled SO-1 counts only THIS run's creations.
    jest.spyOn(store, 'grantReservation').mockRejectedValue(new Error('connection refused'));
    expect((await upload(content, { key }).expect(503)).body.detail).toContain('0 orders were created');
    jest.restoreAllMocks();

    // A7 — the resume runs tomorrow: SO-1 replays without being re-judged.
    licenceClock.now = () => Date.parse(`${addIsoDays(TODAY, 1)}T06:00:00Z`);
    const resumed = (await upload(content, { key }).expect(201)).body as ImportBody;
    expect(resumed.orders.map((order) => [order.clientOrderRef, order.replayed])).toEqual([
      [`${p}-1`, true],
      [`${p}-2`, false],
      [`${p}-3`, false],
    ]);
    for (const ref of [`${p}-1`, `${p}-2`, `${p}-3`]) expect(await count(ordersOf(ref))).toBe(1);
    expect(await count(keyRows(key))).toBe(1);
  });

  it('A2/A7: an order created with ship-by today replays after IST midnight even though its rule would now refuse it; a NEW order with ship-by yesterday is refused', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'A-1', '1', { shipBy: TODAY }), row(`${p}-2`, 'A-1', '1', { shipBy: TODAY }));
    const key = ulid();
    // Run 1 creates SO-1, then the budget stops it before SO-2.
    let fake = Date.now();
    orderImportClock.now = () => fake;
    orderImportHooks.afterOrder = async () => {
      fake += 60_000;
    };
    const partial = (await upload(content, { key }).expect(200)).body as ImportBody;
    expect(partial).toMatchObject({ complete: false, notAttemptedCount: 1, importId: null, acceptedCount: 1 });
    orderImportHooks.afterOrder = null;
    orderImportClock.now = realImportNow;
    licenceClock.now = () => Date.parse(`${addIsoDays(TODAY, 1)}T00:01:00+05:30`);
    const resumed = (await upload(content, { key }).expect(201)).body as ImportBody;
    expect(resumed.orders).toEqual([expect.objectContaining({ clientOrderRef: `${p}-1`, replayed: true })]);
    expect(resumed.errors).toEqual([expect.objectContaining({ orderRef: `${p}-2`, code: 'validation-failed', detail: expect.stringContaining('shipByDate must fall from today') })]);
  });

  it('A7 midnight: ship-by today passes Check at 23:59 IST and is refused at Import at 00:01', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'A-1', '1', { shipBy: TODAY }));
    licenceClock.now = () => Date.parse(`${TODAY}T23:59:00+05:30`);
    expect(istDateOf(new Date(licenceClock.now()).toISOString())).toBe(TODAY);
    expect(((await upload(content, { dryRun: true }).expect(200)).body as ImportBody).acceptedCount).toBe(1);
    licenceClock.now = () => Date.parse(`${addIsoDays(TODAY, 1)}T00:01:00+05:30`);
    const imported = (await upload(content).expect(201)).body as ImportBody;
    expect(imported.errors.map((error) => error.code)).toEqual(['validation-failed']);
  });

  it('A3 budget: once the budget is spent the run starts no new order — 200, complete:false, no import key, no audit row; Import again completes it (201)', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'A-1', '1'), row(`${p}-2`, 'A-1', '1'), row(`${p}-3`, 'A-1', '1'));
    const key = ulid();
    let fake = Date.now();
    orderImportClock.now = () => fake;
    orderImportHooks.afterOrder = async () => {
      fake += 16_000;
    };
    const auditsBefore = await count(importAudits());
    const partial = (await upload(content, { key }).expect(200)).body as ImportBody;
    expect(partial).toMatchObject({ importId: null, complete: false, notAttemptedCount: 2, acceptedCount: 1, refusedCount: 0, orderCount: 3 });
    expect(await count(keyRows(key))).toBe(0);
    expect(await count(importAudits())).toBe(auditsBefore);
    orderImportHooks.afterOrder = null;
    orderImportClock.now = realImportNow;
    const done = (await upload(content, { key }).expect(201)).body as ImportBody;
    expect(done).toMatchObject({ complete: true, notAttemptedCount: 0, acceptedCount: 3 });
    expect(done.orders.map((order) => order.replayed)).toEqual([true, false, false]);
    expect(await count(importAudits())).toBe(auditsBefore + 1);
  });

  it('A1 overlap: a second run under the same key while the first is parked answers 409 import-in-progress and touches nothing; the first completes', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'A-1', '1'), row(`${p}-2`, 'A-1', '1'));
    const key = ulid();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const atHook = new Promise<void>((resolve) => {
      reached = resolve;
    });
    orderImportHooks.afterOrder = async (index) => {
      if (index === 0) {
        reached();
        await parked;
      }
    };
    const first = upload(content, { key }).then((res) => res);
    await atHook;
    const second = (await upload(content, { key }).expect(409)).body;
    expect(second).toMatchObject({ code: 'import-in-progress', detail: expect.stringContaining('still running') });
    release();
    const done = await first;
    expect(done.status).toBe(201);
    expect((done.body as ImportBody).acceptedCount).toBe(2);
    for (const ref of [`${p}-1`, `${p}-2`]) expect(await count(ordersOf(ref))).toBe(1);
    // After the run, the lease is free: the same key replays.
    expect((await upload(content, { key }).expect(201)).body).toEqual(done.body);
  });

  it('settle-once (A1/K3) and A6: a derived key committed between Transaction A and the call with ANOTHER payload is order-changed-since-first-run (never counted created); the Transaction B re-read does not flip it', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'A-1', '1'), row(`${p}-2`, 'A-1', '1'));
    const key = ulid();
    const twinKey = derivedKey(key, content, '', `${p}-2`);
    orderImportHooks.afterOrder = async (index) => {
      if (index !== 0) return;
      // A twin commits SO-2's derived key with a DIFFERENT payload (quantity 2):
      // the import's own call then answers 422 idempotency-key-reuse.
      await app.get(OrderCommandService).createOrder(
        { tenantId, actorUserId: opsUserId, warehouseId: wh, source: 'manual', destination: testAddress() as never, clientOrderRef: `${p}-2`, lines: [{ skuId: sku.get('A-1')!, quantity: 2 }] },
        twinKey,
      );
    };
    const body = (await upload(content, { key }).expect(201)).body as ImportBody;
    expect(body.orders.map((order) => [order.clientOrderRef, order.replayed])).toEqual([[`${p}-1`, false]]);
    expect(body.errors).toEqual([
      expect.objectContaining({ orderRef: `${p}-2`, code: 'order-changed-since-first-run', sku: null, detail: expect.stringContaining(`find it by order number ${p}-2`) }),
    ]);
    expect(await count(ordersOf(`${p}-2`))).toBe(1);
  });

  it('A3 worst case: the capped file (100 orders, 300 lines) with injected latency ends complete or complete:false within 17 s, and the next Import of the same file completes it', async () => {
    const p = refs();
    const lines: string[] = [];
    for (let order = 0; order < 100; order += 1) {
      for (let line = 0; line < 3; line += 1) lines.push(row(`${p}-${order}`, `P-${line}`, '1', line === 0 ? {} : { addr: BLANK_ADDR }));
    }
    const content = file(...lines);
    const key = ulid();
    // The spec’s injected latency, approximated per order: ~2 ms × the ten-odd statements of an order’s own transactions.
    orderImportHooks.afterOrder = () => new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    const first = await upload(content, { key });
    const elapsed = Date.now() - started;
    expect([200, 201]).toContain(first.status);
    expect(elapsed).toBeLessThan(17_000);
    const body = first.body as ImportBody;
    expect(body.acceptedCount + body.notAttemptedCount).toBe(100);
    orderImportHooks.afterOrder = null;
    let last = body;
    if (!last.complete) {
      // The next Import of the same file completes it (decision 6: the caps are set so it does).
      last = (await upload(content, { key }).expect(201)).body as ImportBody;
    }
    expect(last).toMatchObject({ complete: true, acceptedCount: 100, refusedCount: 0 });
    expect(await count(sql`select count(*)::int as n from orders where tenant_id = ${tenantId} and client_order_ref like ${`${p}-%`}`)).toBe(100);
  });

  it('the OpenAPI document lists both import routes, the row-error enum, and the portal response without client labels', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const paths = Object.keys(doc.body.paths as Record<string, unknown>);
    expect(paths).toEqual(expect.arrayContaining(['/tenants/{tenantId}/outbound/order-imports', '/tenants/{tenantId}/portal/order-imports']));
    const schemas = doc.body.components.schemas;
    expect([...schemas.OrderImportRowErrorDto.properties.code.enum].sort()).toEqual([...ORDER_IMPORT_ROW_ERROR_CODES].sort());
    expect(Object.keys(schemas.PortalOrderImportOrderDto.properties).sort()).toEqual(['clientOrderRef', 'firstRow', 'lineCount', 'orderId', 'replayed']);
  });

  it('C15: Valkey unreachable when the lease is taken → 503 reservation-store-unavailable, nothing read or created', async () => {
    const p = refs();
    jest.spyOn(app.get(ValkeyClient), 'acquireLease').mockRejectedValue(new Error('connection refused'));
    const res = (await upload(file(row(`${p}-1`, 'A-1', '1'))).expect(503)).body;
    expect(res).toMatchObject({ code: 'reservation-store-unavailable', detail: expect.stringContaining('nothing was created') });
    expect(await count(ordersOf(`${p}-1`))).toBe(0);
  });

  it('a non-sheet file is 415 unsupported-file-type', async () => {
    expect((await upload('%PDF-1.4', { filename: 'orders.pdf' }).expect(415)).body.code).toBe('unsupported-file-type');
  });

  it('C14: the create’s own refusals pass through by code — a departed client, an inactive SKU short of stock', async () => {
    const p = refs();
    await sql`update clients set status = 'departed' where id = ${beta}`;
    await sql`update skus set status = 'inactive' where id = ${sku.get('A-KG')!}`;
    try {
      const body = (await upload(file(row(`${p}-GONE`, 'B-1', '1'), row(`${p}-OLD`, 'A-KG', '9999'), row(`${p}-OK`, 'A-1', '1'))).expect(201)).body as ImportBody;
      expect(body.errors.map((error) => [error.orderRef, error.code])).toEqual([
        [`${p}-GONE`, 'client-departed'],
        [`${p}-OLD`, 'sku-inactive'],
      ]);
      expect(body.orders.map((order) => order.clientOrderRef)).toEqual([`${p}-OK`]);
    } finally {
      await sql`update clients set status = 'active' where id = ${beta}`;
      await sql`update skus set status = 'active' where id = ${sku.get('A-KG')!}`;
    }
  });

  it('C12: the pace check holds back an order its measured ms-per-line says would end past the budget, while time remains', async () => {
    const p = refs();
    const big = Array.from({ length: 10 }, (_, i) => row(`${p}-2`, `P-${i}`, '1', i === 0 ? {} : { addr: BLANK_ADDR }));
    const content = file(row(`${p}-1`, 'A-1', '1'), ...big);
    let fake = Date.now();
    orderImportClock.now = () => fake;
    // Each grant "takes" 2 s: SO-1's one line measures 2 s/line, so SO-2's ten lines project 20 s.
    const store = app.get(ValkeyClient);
    const real = ValkeyClient.prototype.grantReservation;
    jest.spyOn(store, 'grantReservation').mockImplementation(async (...args) => {
      fake += 2_000;
      return real.apply(store, args as Parameters<ValkeyClient['grantReservation']>);
    });
    const body = (await upload(content).expect(200)).body as ImportBody;
    expect(body).toMatchObject({ complete: false, acceptedCount: 1, notAttemptedCount: 1 });
    expect(await count(ordersOf(`${p}-2`))).toBe(0);
  });

  it('C17: the run’s first order always starts even when Transaction A spent the budget; a Check stopped by it is complete:false too', async () => {
    const p = refs();
    const content = file(row(`${p}-1`, 'A-1', '1'), row(`${p}-2`, 'A-1', '1'));
    const base = Date.now();
    let calls = 0;
    // The first read is the run's start; every later read is 20 s on.
    orderImportClock.now = () => (calls++ === 0 ? base : base + 20_000);
    const checked = (await upload(content, { dryRun: true }).expect(200)).body as ImportBody;
    expect(checked).toMatchObject({ dryRun: true, complete: false, acceptedCount: 1, notAttemptedCount: 1 });
    calls = 0;
    const imported = (await upload(content).expect(200)).body as ImportBody;
    expect(imported).toMatchObject({ complete: false, acceptedCount: 1, notAttemptedCount: 1 });
    expect(await count(ordersOf(`${p}-1`))).toBe(1);
  });
});
