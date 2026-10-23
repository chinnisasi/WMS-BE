import type { INestApplication } from '@nestjs/common';
import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { addIsoDays, istDateOf } from '../src/shared/primitives/time';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { licenceClock } from '../src/modules/compliance/licence-enforcement';
import {
  MAX_COD_AMOUNT_PAISE,
  ORDER_PRIORITIES,
  ORDER_PRIORITY_RANK,
  ORDER_TYPES,
  compareOrderUrgency,
  orderPriorityRankSql,
  orderUrgencyOrderBy,
  orderUrgencyColumns,
} from '../src/modules/outbound/order-urgency';
import { registerCarrierAdapter } from '../src/modules/carriers/carrier-registry';
import { sandboxLabelArm, sandboxRateArm } from '../src/modules/carriers/carrier-label-port';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 4-2a — the order header fields: order type (b2b/b2c), cash on
// delivery, priority and ship-by date. Created at the staff and portal create
// (and COD at channel ingest — channel-transports / channel-webhooks pin the
// parse and the redelivery), shown on every order read, and used by wave
// planning (the urgency key), the device snapshot (whole picklists and pack
// cards by urgency), pack, label, rate, manifest and dispatch. Every row of
// the spec's I/O matrix and its amended rows is driven here over real HTTP;
// the CHECKs are pinned against their TS tuples, the rank's SQL twin against
// the TS map, and the split sweep's lock order by a deadlock test.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.CARRIER_ENCRYPTION_KEY ??= 'e2e-only-carrier-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.LICENCE_EXPIRY_POLL_MS;

jest.setTimeout(240_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const GSTIN = '29ABCDE1234F1Z5';

/** A carrier that cannot collect COD (A18) — registered once, before the app connects it. */
const NO_COD_CARRIER = 'e2e_nocod';
registerCarrierAdapter({
  code: NO_COD_CARRIER,
  displayName: 'No-COD Courier',
  label: sandboxLabelArm(),
  rate: sandboxRateArm(),
  credentialFields: [{ name: 'accountToken', label: 'Account token', required: true, description: 'Any token.' }],
  supportsCod: false,
});

interface Line {
  id: string;
  picklistId: string;
  orderId: string;
  skuId: string;
  binId: string | null;
  binCode: string | null;
  qty: number;
  shortfallQty: number;
  status: string;
}
interface Picklist {
  id: string;
  orderId: string | null;
  priority?: string | null;
  shipByDate?: string | null;
  lines: Line[];
}
interface Wave {
  id: string;
  picklists: Picklist[];
}

describe('order fields (e2e, story 4-2a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let valkey: Redis;
  let db: Database;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string;
  let warehouseId: string;
  let binA: string;
  let acme: string;
  let beta: string;
  const sku = new Map<string, string>();
  let portalA: string;
  let portalB: string;
  let sandboxConnection: string;
  let noCodConnection: string;
  const realLicenceNow = licenceClock.now;

  const http = () => request(app.getHttpServer());
  const todayIst = (): string => istDateOf(new Date().toISOString());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('orderfields');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });
    db = app.get<Database>(DATABASE);

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Order Fields 3PL ${ulid()}`, ownerEmail, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = await signIn(ownerEmail);
    opsToken = (await createMember('ops_manager')).token;
    const floor = await createMember('operator');

    acme = await createClient('ACME', 'Acme Apparel');
    beta = await createClient('BETA', 'Beta Beauty');
    await importCsv(['A-1,Acme tee,pcs,1800,,,', 'A-2,Acme cap,pcs,1800,,,', 'A-3,Acme sock,pcs,1800,,,', 'A-4,Acme band,pcs,1800,,,'], acme);
    await importCsv(['B-1,Beta serum,pcs,1800,,,'], beta);
    const listed = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of listed.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    // The rate read prices by weight.
    await sql`update skus set weight_grams = 500 where tenant_id = ${tenantId}`;

    const main = await freshWarehouse('OF-W1');
    warehouseId = main.warehouseId;
    binA = main.bins[0]!;
    for (const code of ['A-1', 'A-2', 'B-1']) await adjust(warehouseId, binA, sku.get(code)!, 1000);

    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Order fields scanner', pin: '2468' })
      .expect(201);
    operatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: floor.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    portalA = await portalUser(acme);
    portalB = await portalUser(beta);
    sandboxConnection = await connectCarrier('sandbox');
    noCodConnection = await connectCarrier(NO_COD_CARRIER);
  });

  afterAll(async () => {
    licenceClock.now = realLicenceNow;
    const keys = await valkey.keys(`wms:{${tenantId}}:*`).catch(() => [] as string[]);
    if (keys.length > 0) await valkey.del(...keys);
    await valkey.quit().catch(() => valkey.disconnect());
    await sql?.end();
    const mainDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await mainDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  afterEach(() => {
    licenceClock.now = realLicenceNow;
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function signIn(email: string): Promise<string> {
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
  }

  async function createMember(role: string): Promise<{ token: string; email: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { token: await signIn(email), email };
  }

  async function portalUser(clientId: string): Promise<string> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role: 'client', clientId })
      .expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return signIn(email);
  }

  async function createClient(code: string, name: string): Promise<string> {
    return (await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name }).expect(201)).body.client.id as string;
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,product,variant_values,kit_components', ...rows].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  /** A warehouse of its own (a sweep reads EVERY free order of its warehouse) with two shelf bins. */
  async function freshWarehouse(tag: string): Promise<{ warehouseId: string; bins: string[] }> {
    const wh = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${tag}-${ulid().slice(20)}`, name: tag })
        .expect(201)
    ).body.id as string;
    const zone = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' })
        .expect(201)
    ).body.id as string;
    const bins: string[] = [];
    for (const code of ['A-01-01', 'A-01-02']) {
      bins.push(
        (
          await http()
            .post(`${API}/${tenantId}/warehouses/${wh}/zones/${zone}/bins`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ capacity: 1000000, type: 'shelf', code })
            .expect(201)
        ).body.id as string,
      );
    }
    return { warehouseId: wh, bins };
  }

  async function adjust(wh: string, bin: string, skuId: string, quantityDelta: number): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, skuId, binId: bin, quantityDelta, reasonCode: 'stock-count', note: 'order-fields seed' })
      .expect(201);
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, wh);
  }

  async function connectCarrier(carrierCode: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/carriers/connections`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ carrierCode, accountLabel: `${carrierCode} ${ulid().slice(10, 16)}`, credential: { accountToken: 'e2e-order-fields-token' } })
        .expect(201)
    ).body.id as string;
  }

  function orderBody(code: string, extra: Record<string, unknown> = {}, wh = warehouseId, quantity = 1): Record<string, unknown> {
    return { warehouseId: wh, lines: [{ skuId: sku.get(code)!, quantity }], destination: testAddress(), ...extra };
  }

  function staffCreate(payload: Record<string, unknown>, key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/orders`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send(payload);
  }

  function place(payload: Record<string, unknown>, token = portalA, key = ulid()) {
    return http().post(`${API}/${tenantId}/portal/orders`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(payload);
  }

  async function createOrder(code: string, extra: Record<string, unknown> = {}, wh = warehouseId, quantity = 1): Promise<string> {
    return (await staffCreate(orderBody(code, extra, wh, quantity)).expect(201)).body.order.id as string;
  }

  async function policy(wh: string, grouping: 'single' | 'batch', extra: Record<string, unknown> = {}): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/outbound/wave-policies`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh, name: `of-${ulid().slice(10, 20)}`, grouping, ...extra })
        .expect(201)
    ).body.policy.id as string;
  }

  function generate(body: Record<string, unknown>, key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/waves`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send(body);
  }

  async function release(waveId: string): Promise<void> {
    await http().post(`${API}/${tenantId}/outbound/waves/${waveId}/release`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
  }

  async function getWave(waveId: string): Promise<Wave> {
    return (await http().get(`${API}/${tenantId}/outbound/waves/${waveId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.wave as Wave;
  }

  async function pickAll(picklist: Picklist, wh = warehouseId): Promise<void> {
    for (const line of picklist.lines) {
      if (line.status !== 'planned') continue;
      await http()
        .post(`${API}/${tenantId}/outbound/picks`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId: wh,
          picklistId: line.picklistId,
          picklistLineId: line.id,
          skuId: line.skuId,
          binId: line.binId!,
          qty: line.qty,
          occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        })
        .expect(201);
    }
  }

  /** A fully picked order on its own released single-order wave. */
  async function pickedOrder(orderId: string, wh = warehouseId): Promise<Picklist> {
    const wave = (await generate({ warehouseId: wh, policyId: await policy(wh, 'single'), orderIds: [orderId] }).expect(201)).body.wave as Wave;
    await release(wave.id);
    const picklist = (await getWave(wave.id)).picklists[0]!;
    await pickAll(picklist, wh);
    return picklist;
  }

  function pack(orderId: string, scanned: { skuId: string; qty: number }[], key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send({ scanned });
  }

  function label(orderId: string, connectionId: string, key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/label`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send({ carrierConnectionId: connectionId });
  }

  function manifest(shipmentIds: string[], key = ulid()) {
    return http().post(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/manifests`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send({ shipmentIds });
  }

  function dispatch(orderId: string, key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send({});
  }

  async function snapshot(wh = warehouseId): Promise<{ pickTasks: Record<string, unknown>[]; packTasks: Record<string, unknown>[] }> {
    const res = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${wh}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    return { pickTasks: res.body.pickTasks as Record<string, unknown>[], packTasks: res.body.packTasks as Record<string, unknown>[] };
  }

  async function storedOrder(orderId: string): Promise<Record<string, unknown>> {
    const row = (await sql`select order_type, priority, ship_by_date::text as ship_by_date, cod_amount_paise from orders where id = ${orderId}`)[0]!;
    // bigint over postgres.js is a string (IMPLEMENTATION-GUIDE §2).
    return { ...row, cod_amount_paise: row.cod_amount_paise === null ? null : Number(row.cod_amount_paise) };
  }

  /** Fixes the licence clock (the create's one captured IST date) at an instant. */
  function setLicenceClock(iso: string): void {
    const ms = Date.parse(iso);
    licenceClock.now = () => ms;
  }

  /** Strips keys from a stored idempotency snapshot at `path` — what a pre-4-2a build stored. */
  async function strip(key: string, path: string[], keys: string[]): Promise<void> {
    for (const k of keys) {
      const p = `{${[...path, k].join(',')}}`;
      await sql`update idempotency_keys set response_snapshot = response_snapshot #- ${p}::text[] where tenant_id = ${tenantId} and key = ${key}`;
    }
  }

  async function storedSnapshot(key: string): Promise<unknown> {
    return (await sql`select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.response_snapshot;
  }

  // ── migration 0093: the tuples, the CHECKs, the rank twin ──────────────────

  describe('migration 0093', () => {
    async function checkDef(name: string): Promise<{ def: string; validated: boolean }> {
      const rows = await sql`select pg_get_constraintdef(oid) as def, convalidated from pg_constraint where conname = ${name} and conrelid = 'public.orders'::regclass`;
      return { def: rows[0]!.def as string, validated: rows[0]!.convalidated as boolean };
    }
    const literals = (def: string): string[] => [...def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]!);

    it('each tuple equals its CHECK (the quoted literals — tolerant of the NOT VALID suffix), and all three CHECKs are NOT VALID', async () => {
      const type = await checkDef('orders_order_type_check');
      const priority = await checkDef('orders_priority_check');
      const cod = await checkDef('orders_cod_amount_paise_check');
      expect(literals(type.def).sort()).toEqual([...ORDER_TYPES].sort());
      expect(type.def).toMatch(/order_type IS NULL/);
      expect(literals(priority.def).sort()).toEqual([...ORDER_PRIORITIES].sort());
      expect(cod.def).toMatch(/cod_amount_paise IS NULL/);
      expect(cod.def).toContain(`cod_amount_paise <= ${MAX_COD_AMOUNT_PAISE}`);
      expect(cod.def).toContain('cod_amount_paise > 0');
      expect([type.validated, priority.validated, cod.validated]).toEqual([false, false, false]);
      for (const def of [type.def, priority.def, cod.def]) expect(def).toMatch(/NOT VALID$/);
    });

    it('the CHECKs refuse the out-of-vocabulary values (each by its named constraint); priority defaults to normal', async () => {
      const probe = async (column: string, value: unknown): Promise<string | null> =>
        sql
          .begin(async (tx) => {
            await tx.unsafe(`insert into orders (id, tenant_id, client_id, warehouse_id, ${column}) values ($1, $2, $3, $4, $5)`, [uuidv7(), uuidv7(), uuidv7(), uuidv7(), value as string]);
            throw new Error('rollback');
          })
          .catch((err: Error & { constraint_name?: string }) => (err.message === 'rollback' ? null : (err.constraint_name ?? err.message)));
      expect(await probe('order_type', 'b2x')).toBe('orders_order_type_check');
      expect(await probe('priority', 'low')).toBe('orders_priority_check');
      expect(await probe('cod_amount_paise', 0)).toBe('orders_cod_amount_paise_check');
      expect(await probe('cod_amount_paise', MAX_COD_AMOUNT_PAISE + 1)).toBe('orders_cod_amount_paise_check');
      expect(await probe('cod_amount_paise', MAX_COD_AMOUNT_PAISE)).toBeNull();
      for (const value of ORDER_TYPES) expect(await probe('order_type', value)).toBeNull();
      for (const value of ORDER_PRIORITIES) expect(await probe('priority', value)).toBeNull();
      const defaulted = await sql.begin(async (tx) => {
        const id = uuidv7();
        await tx`insert into orders (id, tenant_id, client_id, warehouse_id) values (${id}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()})`;
        const row = (await tx`select priority, order_type from orders where id = ${id}`)[0]!;
        await tx`delete from orders where id = ${id}`;
        return row;
      });
      expect(defaulted).toEqual({ priority: 'normal', order_type: null });
    });

    it('A10: the SQL rank twin equals ORDER_PRIORITY_RANK for every priority (evaluated in Postgres)', async () => {
      const ranks = await withTenantTransaction(db, tenantId, async (tx) => {
        const out: Record<string, number> = {};
        for (const priority of ORDER_PRIORITIES) {
          const rows = (await tx.execute(dsql`select ${orderPriorityRankSql(dsql`${priority}::text`)} as r`)) as unknown as { r: number }[];
          out[priority] = Number(rows[0]!.r);
        }
        return out;
      });
      expect(ranks).toEqual(ORDER_PRIORITY_RANK);
      expect(ORDER_PRIORITY_RANK).toEqual({ urgent: 0, high: 1, normal: 2 });
    });

    it('A8: compareOrderUrgency orders a mixed set exactly as orderUrgencyOrderBy does in Postgres', async () => {
      const today = '2026-11-10';
      const rows = [
        { priority: 'normal', shipByDate: null },
        { priority: 'urgent', shipByDate: null },
        { priority: 'high', shipByDate: '2026-11-17' },
        { priority: 'normal', shipByDate: '2026-11-09' }, // overdue
        { priority: 'normal', shipByDate: '2026-11-10' }, // due today
        { priority: 'high', shipByDate: '2026-11-10' }, // due today, high
        { priority: 'normal', shipByDate: '2026-11-11' },
        { priority: 'urgent', shipByDate: '2026-11-12' },
        { priority: 'normal', shipByDate: null },
      ].map((row, index) => ({ ...row, id: uuidv7(), createdAt: `2026-11-0${(index % 3) + 1}T10:00:00.000Z` }));
      const ordered = await withTenantTransaction(db, tenantId, async (tx) => {
        await tx.execute(dsql`create temp table urgency_probe (id uuid, priority text, ship_by_date date, created_at timestamptz) on commit drop`);
        for (const row of rows) {
          await tx.execute(dsql`insert into urgency_probe values (${row.id}::uuid, ${row.priority}, ${row.shipByDate}::date, ${row.createdAt}::timestamptz)`);
        }
        const out = (await tx.execute(dsql`select p.id from urgency_probe p order by ${orderUrgencyOrderBy(today, orderUrgencyColumns('p'))}`)) as unknown as { id: string }[];
        return out.map((row) => row.id);
      });
      const fromTs = [...rows].sort((a, b) => compareOrderUrgency(a, b, today)).map((row) => row.id);
      expect(ordered).toEqual(fromTs);
      // Due first (high before normal, then by date), then urgent (dated
      // before undated), high, normal (dated, then undated oldest first).
      expect(fromTs).toEqual([5, 3, 4, 7, 1, 2, 6, 0, 8].map((index) => rows[index]!.id));
    });
  });

  // ── the staff create (decisions 2–7, A3, A11, A13) ─────────────────────────

  describe('staff create', () => {
    it('Staff full: b2c, urgent, ship-by today, COD ₹1,499 — stored, and the create, the detail and the list entry carry all four', async () => {
      const today = todayIst();
      const res = await staffCreate(orderBody('A-1', { orderType: 'b2c', priority: 'urgent', shipByDate: today, codAmountPaise: 149900 })).expect(201);
      const id = res.body.order.id as string;
      expect(res.body.order).toMatchObject({ orderType: 'b2c', priority: 'urgent', shipByDate: today, codAmountPaise: 149900 });
      expect(await storedOrder(id)).toEqual({ order_type: 'b2c', priority: 'urgent', ship_by_date: today, cod_amount_paise: 149900 });
      const detail = await http().get(`${API}/${tenantId}/outbound/orders/${id}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect(detail.body.order).toMatchObject({ orderType: 'b2c', priority: 'urgent', shipByDate: today, codAmountPaise: 149900 });
      const list = await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/orders?limit=200`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      const entry = (list.body.items as { id: string }[]).find((item) => item.id === id);
      expect(entry).toMatchObject({ orderType: 'b2c', priority: 'urgent', shipByDate: today, codAmountPaise: 149900 });
    });

    it('Defaults: none sent — b2b with a GSTIN, b2c without; priority normal; ship-by and COD null', async () => {
      const withGstin = await staffCreate(orderBody('A-1', { consigneeGstin: GSTIN })).expect(201);
      expect(withGstin.body.order).toMatchObject({ orderType: 'b2b', priority: 'normal', shipByDate: null, codAmountPaise: null });
      const without = await staffCreate(orderBody('A-1')).expect(201);
      expect(without.body.order).toMatchObject({ orderType: 'b2c', priority: 'normal', shipByDate: null, codAmountPaise: null });
      expect(await storedOrder(without.body.order.id as string)).toEqual({ order_type: 'b2c', priority: 'normal', ship_by_date: null, cod_amount_paise: null });
    });

    it('Contradiction: an explicit b2c beside a consignee GSTIN is 400; b2b without one is allowed', async () => {
      const refused = await staffCreate(orderBody('A-1', { orderType: 'b2c', consigneeGstin: GSTIN })).expect(400);
      expect(refused.body.code).toBe('validation-failed');
      expect(refused.body.detail).toContain('b2c contradicts the consignee GSTIN');
      const unregistered = await staffCreate(orderBody('A-1', { orderType: 'b2b' })).expect(201);
      expect(unregistered.body.order.orderType).toBe('b2b');
    });

    it('Bad values and bad types: each is 400 validation-failed and nothing is written', async () => {
      const today = todayIst();
      const bad: Record<string, unknown>[] = [
        { orderType: 'b2x' },
        { orderType: 'B2C' },
        { priority: 'low' },
        { codAmountPaise: 0 },
        { codAmountPaise: 1.5 },
        { codAmountPaise: MAX_COD_AMOUNT_PAISE + 1 },
        { codAmountPaise: '149900' },
        { codAmountPaise: -1 },
        { shipByDate: '2026-02-30' },
        { shipByDate: addIsoDays(today, -1) },
        { shipByDate: addIsoDays(today, 366) },
        { shipByDate: `${today}T00:00:00Z` },
        { shipByDate: '2026-2-4' },
      ];
      const before = (await sql`select count(*)::int as n from orders where tenant_id = ${tenantId}`)[0]!.n as number;
      for (const extra of bad) {
        const res = await staffCreate(orderBody('A-1', extra));
        expect({ extra, status: res.status, code: res.body.code }).toEqual({ extra, status: 400, code: 'validation-failed' });
      }
      expect((await sql`select count(*)::int as n from orders where tenant_id = ${tenantId}`)[0]!.n).toBe(before);
    });

    it('Blank = absent: a whitespace orderType, an empty shipByDate and an empty codAmountPaise read as omitted', async () => {
      const res = await staffCreate(orderBody('A-1', { orderType: '  ', shipByDate: '', codAmountPaise: '' })).expect(201);
      expect(res.body.order).toMatchObject({ orderType: 'b2c', priority: 'normal', shipByDate: null, codAmountPaise: null });
    });

    it('COD on b2b and COD above the goods value are accepted (shipping and charges may ride the COD)', async () => {
      const res = await staffCreate(orderBody('A-1', { orderType: 'b2b', codAmountPaise: 5_000_000 })).expect(201);
      expect(res.body.order).toMatchObject({ orderType: 'b2b', codAmountPaise: 5_000_000 });
    });

    it('A3: an ingested order carrying a manual field (type, priority, ship-by) is 400; its COD is allowed', async () => {
      for (const extra of [{ priority: 'high' }, { orderType: 'b2b' }, { shipByDate: todayIst() }]) {
        const res = await staffCreate(orderBody('A-1', { source: 'ingested', integrationId: uuidv7(), externalEventId: `evt-${ulid()}`, ...extra }));
        expect({ extra, status: res.status, code: res.body.code }).toEqual({ extra, status: 400, code: 'validation-failed' });
      }
      const cod = await staffCreate(orderBody('A-1', { source: 'ingested', integrationId: uuidv7(), externalEventId: `evt-${ulid()}`, codAmountPaise: 99900 })).expect(201);
      expect(cod.body.order).toMatchObject({ source: 'ingested', orderType: 'b2c', priority: 'normal', codAmountPaise: 99900 });
    });

    it('A13 bounds at the IST midnight: at 18:29:59Z today and +365 are accepted, +366 and yesterday refused; at 18:30:00Z the old today is yesterday', async () => {
      const day = '2026-11-10';
      setLicenceClock(`${day}T18:29:59.000Z`); // 23:59:59 IST on the 10th
      await staffCreate(orderBody('A-1', { shipByDate: day })).expect(201);
      await staffCreate(orderBody('A-1', { shipByDate: addIsoDays(day, 365) })).expect(201);
      expect((await staffCreate(orderBody('A-1', { shipByDate: addIsoDays(day, 366) }))).status).toBe(400);
      expect((await staffCreate(orderBody('A-1', { shipByDate: addIsoDays(day, -1) }))).status).toBe(400);
      setLicenceClock(`${day}T18:30:00.000Z`); // 00:00 IST on the 11th
      const yesterday = await staffCreate(orderBody('A-1', { shipByDate: day }));
      expect(yesterday.status).toBe(400);
      expect(yesterday.body.detail).toContain(`from today (${addIsoDays(day, 1)}, IST)`);
      await staffCreate(orderBody('A-1', { shipByDate: addIsoDays(day, 366) })).expect(201);
    });

    it('Replay across midnight: the same key and body after the IST date moved replays the committed order (never refused)', async () => {
      const day = '2026-11-20';
      setLicenceClock(`${day}T18:29:59.000Z`);
      const key = ulid();
      const body = orderBody('A-1', { shipByDate: day, priority: 'high' });
      const first = await staffCreate(body, key).expect(201);
      setLicenceClock(`${day}T18:30:00.000Z`);
      const again = await staffCreate(body, key).expect(201);
      expect(again.body).toEqual(first.body);
      // A NEW key with the same body is judged on the new date: yesterday.
      expect((await staffCreate(body)).status).toBe(400);
    });
  });

  // ── the portal create (A12, isolation) ────────────────────────────────────

  describe('portal create', () => {
    it('Portal: ACME places with all four — stored; its row and detail show them; BETA sees nothing (404 on the id)', async () => {
      const today = todayIst();
      const placed = await place(orderBody('A-1', { orderType: 'b2c', priority: 'high', shipByDate: today, codAmountPaise: 149900 })).expect(201);
      const orderId = placed.body.orderId as string;
      expect(placed.body).toMatchObject({ orderType: 'b2c', priority: 'high', shipByDate: today, codAmountPaise: 149900 });
      expect(await storedOrder(orderId)).toEqual({ order_type: 'b2c', priority: 'high', ship_by_date: today, cod_amount_paise: 149900 });
      const rows = (await http().get(`${API}/${tenantId}/portal/orders?limit=100`).set('Authorization', `Bearer ${portalA}`).expect(200)).body.items as { id: string }[];
      expect(rows.find((row) => row.id === orderId)).toMatchObject({ orderType: 'b2c', priority: 'high', shipByDate: today, codAmountPaise: 149900 });
      const detail = await http().get(`${API}/${tenantId}/portal/orders/${orderId}`).set('Authorization', `Bearer ${portalA}`).expect(200);
      expect(detail.body).toMatchObject({ orderType: 'b2c', priority: 'high', shipByDate: today, codAmountPaise: 149900 });
      const betaRows = (await http().get(`${API}/${tenantId}/portal/orders?limit=100`).set('Authorization', `Bearer ${portalB}`).expect(200)).body.items as { id: string }[];
      expect(betaRows.some((row) => row.id === orderId)).toBe(false);
      expect((await http().get(`${API}/${tenantId}/portal/orders/${orderId}`).set('Authorization', `Bearer ${portalB}`).expect(404)).body.code).toBe('not-found');

      // AC1 — the outbound register's row carries b2c, high, the date and 149900.
      const res = await http()
        .get(`${API}/${tenantId}/warehouses/${warehouseId}/reports/outbound-register?format=csv&from=${today}&to=${today}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200);
      const [header, ...csvRows] = parseCsvSync(res.text.replace(/^\uFEFF/, '')) as string[][];
      const at = (name: string) => header!.indexOf(name);
      const row = csvRows.find((r) => r[at('order_id')] === orderId)!;
      expect([row[at('order_type')], row[at('priority')], row[at('ship_by_date')], row[at('cod_amount_paise')]]).toEqual(['b2c', 'high', today, '149900']);
      expect(header!.slice(-4)).toEqual(['order_type', 'priority', 'ship_by_date', 'cod_amount_paise']);
    });

    it('A12: portal urgent is 400 — the warehouse sets urgent; normal and high are the portal’s', async () => {
      const refused = await place(orderBody('A-1', { priority: 'urgent' })).expect(400);
      expect(refused.body.code).toBe('validation-failed');
      expect(refused.body.detail).toBe('Urgent priority is set by the warehouse — choose Normal or High.');
      await place(orderBody('A-1', { priority: 'normal' })).expect(201);
    });

    it('the portal refuses the same bad values as the staff create (behind its replay lookup)', async () => {
      for (const extra of [{ orderType: 'b2x' }, { codAmountPaise: '149900' }, { shipByDate: addIsoDays(todayIst(), -1) }, { orderType: 'b2c', consigneeGstin: GSTIN }]) {
        const res = await place(orderBody('A-1', extra));
        expect({ extra, status: res.status, code: res.body.code }).toEqual({ extra, status: 400, code: 'validation-failed' });
      }
    });
  });

  // ── wave planning (A8, A9, A23) ───────────────────────────────────────────

  describe('wave planning by urgency', () => {
    it('Wave sweep: cap 1 — an older normal and a newer urgent order: the wave holds the urgent one', async () => {
      const wh = await freshWarehouse('SWP');
      await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-3')!, 10);
      const older = await createOrder('A-3', {}, wh.warehouseId);
      const urgent = await createOrder('A-3', { priority: 'urgent' }, wh.warehouseId);
      const wave = (await generate({ warehouseId: wh.warehouseId, policyId: await policy(wh.warehouseId, 'batch', { maxOrders: 1 }) }).expect(201)).body.wave as Wave;
      const orderIds = new Set(wave.picklists.flatMap((list) => list.lines.map((line) => line.orderId)));
      expect([...orderIds]).toEqual([urgent]);
      expect(orderIds.has(older)).toBe(false);
      expect(wave.picklists[0]).toMatchObject({ priority: 'urgent', shipByDate: null });
    });

    it('Wave key (A8): a normal order due YESTERDAY goes before a high order due next week', async () => {
      const wh = await freshWarehouse('KEY');
      await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-3')!, 10);
      const overdue = await createOrder('A-3', { shipByDate: todayIst() }, wh.warehouseId);
      // The order was due today when placed; it is overdue now.
      await sql`update orders set ship_by_date = ${addIsoDays(todayIst(), -1)}::date where id = ${overdue}`;
      const high = await createOrder('A-3', { priority: 'high', shipByDate: addIsoDays(todayIst(), 7) }, wh.warehouseId);
      const wave = (await generate({ warehouseId: wh.warehouseId, policyId: await policy(wh.warehouseId, 'single', { maxOrders: 1 }) }).expect(201)).body.wave as Wave;
      expect(wave.picklists.map((list) => list.orderId)).toEqual([overdue]);
      expect(high).not.toBe(overdue);
    });

    it('Ship-by tie-break: same priority — today, then tomorrow, then none; picklists are created in that order', async () => {
      const wh = await freshWarehouse('TIE');
      await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-3')!, 10);
      const tomorrow = await createOrder('A-3', { shipByDate: addIsoDays(todayIst(), 1) }, wh.warehouseId);
      const none = await createOrder('A-3', {}, wh.warehouseId);
      const today = await createOrder('A-3', { shipByDate: todayIst() }, wh.warehouseId);
      const policyId = await policy(wh.warehouseId, 'single');
      // The explicit path sorts its locked rows by the key too.
      const explicit = (await generate({ warehouseId: wh.warehouseId, policyId, orderIds: [none, tomorrow, today] }).expect(201)).body.wave as Wave;
      expect(explicit.picklists.map((list) => list.orderId)).toEqual([today, tomorrow, none]);
      expect(explicit.picklists.map((list) => list.shipByDate)).toEqual([todayIst(), addIsoDays(todayIst(), 1), null]);
    });

    it('Wave allocation (A9): two orders contend for the first stock on the walk; the newer HIGH order’s slice takes it', async () => {
      const wh = await freshWarehouse('ALC');
      // One unit in each bin: A-01-01 is the walk's (and the pool's) first slot.
      await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-4')!, 1);
      await adjust(wh.warehouseId, wh.bins[1]!, sku.get('A-4')!, 1);
      const normal = await createOrder('A-4', {}, wh.warehouseId);
      const high = await createOrder('A-4', { priority: 'high' }, wh.warehouseId);
      const wave = (await generate({ warehouseId: wh.warehouseId, policyId: await policy(wh.warehouseId, 'batch'), orderIds: [normal, high] }).expect(201)).body.wave as Wave;
      const lines = wave.picklists[0]!.lines;
      expect(lines.find((line) => line.orderId === high)!.binId).toBe(wh.bins[0]);
      expect(lines.find((line) => line.orderId === normal)!.binId).toBe(wh.bins[1]);
    });

    it('Shortfall (A23): urgent and normal contend for 5 reserved units with 3 pickable — urgent is planned 3, normal unfulfillable with its shortfall', async () => {
      const wh = await freshWarehouse('SHT');
      await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-4')!, 3);
      await adjust(wh.warehouseId, wh.bins[1]!, sku.get('A-4')!, 2);
      const normal = await createOrder('A-4', {}, wh.warehouseId, 2);
      const urgent = await createOrder('A-4', { priority: 'urgent' }, wh.warehouseId, 3);
      // The second bin goes unpickable after both orders reserved.
      await http()
        .patch(`${API}/${tenantId}/warehouses/${wh.warehouseId}/bins/${wh.bins[1]!}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ blocked: true })
        .expect(200);
      const wave = (await generate({ warehouseId: wh.warehouseId, policyId: await policy(wh.warehouseId, 'batch'), orderIds: [normal, urgent] }).expect(201)).body.wave as Wave;
      const lines = wave.picklists[0]!.lines;
      const urgentLines = lines.filter((line) => line.orderId === urgent);
      expect(urgentLines.map((line) => [line.status, line.qty, line.shortfallQty])).toEqual([['planned', 3, 0]]);
      const normalLines = lines.filter((line) => line.orderId === normal);
      expect(normalLines.map((line) => [line.status, line.qty, line.shortfallQty])).toEqual([['unfulfillable', 0, 2]]);
    });

    describe('the split sweep under concurrency (A8)', () => {
      const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

      async function waitParkedOnOrders(holderPid: number): Promise<void> {
        const probe = handle();
        try {
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            const waiting = (await probe`
              select a.pid from pg_stat_activity a
              where a.wait_event_type = 'Lock' and a.state = 'active' and ${holderPid} = any(pg_blocking_pids(a.pid))
            `) as unknown as { pid: number }[];
            if (waiting.length > 0) return;
            await new Promise((r) => setTimeout(r, 25));
          }
          throw new Error('the sweep never parked on the held order row');
        } finally {
          await probe.end();
        }
      }

      it('the deadlock test: A locks the OLDER order X, a sweep whose key puts the newer Y first parks on X, then A locks Y — no 40P01, both settle', async () => {
        const wh = await freshWarehouse('DLK');
        await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-3')!, 10);
        const x = await createOrder('A-3', {}, wh.warehouseId);
        const y = await createOrder('A-3', { priority: 'urgent' }, wh.warehouseId);
        const policyId = await policy(wh.warehouseId, 'batch');
        const holder = handle();
        let sweep: Promise<request.Response> | undefined;
        try {
          await holder.begin(async (tx) => {
            const pid = ((await tx`select pg_backend_pid() as pid`) as unknown as { pid: number }[])[0]!.pid;
            await tx`set local lock_timeout = '10s'`;
            await tx`select id from orders where id = ${x} for update`;
            sweep = (async () => generate({ warehouseId: wh.warehouseId, policyId }))();
            await waitParkedOnOrders(pid);
            // Under the OLD single-statement sweep (urgency-ordered FOR UPDATE)
            // the sweep would hold Y and wait on X — this lock would deadlock.
            await tx`select id from orders where id = ${y} for update`;
          });
          const res = await sweep!;
          expect(res.status).toBe(201);
          const swept = new Set((res.body.wave as Wave).picklists.flatMap((list) => list.lines.map((line) => line.orderId)));
          expect(swept).toEqual(new Set([x, y]));
        } finally {
          await Promise.allSettled([sweep]);
          await holder.end();
        }
      });

      it('Sweep lost all: every candidate is claimed while the sweep waits for its lock — 409 conflict naming the winner, never the 422', async () => {
        const wh = await freshWarehouse('LST');
        await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-3')!, 10);
        const x = await createOrder('A-3', {}, wh.warehouseId);
        const policyId = await policy(wh.warehouseId, 'batch');
        const orderLine = (await sql`select id, sku_id from order_lines where order_id = ${x}`)[0]!;
        const waveId = uuidv7();
        const picklistId = uuidv7();
        const holder = handle();
        let sweep: Promise<request.Response> | undefined;
        try {
          await holder.begin(async (tx) => {
            const pid = ((await tx`select pg_backend_pid() as pid`) as unknown as { pid: number }[])[0]!.pid;
            await tx`select id from orders where id = ${x} for update`;
            sweep = (async () => generate({ warehouseId: wh.warehouseId, policyId }))();
            await waitParkedOnOrders(pid);
            // A concurrent wave claims X and commits while the sweep waits.
            await tx`insert into waves (id, tenant_id, warehouse_id, policy_id, status) values (${waveId}, ${tenantId}, ${wh.warehouseId}, ${policyId}, 'planned')`;
            await tx`insert into picklists (id, tenant_id, warehouse_id, wave_id, order_id, status) values (${picklistId}, ${tenantId}, ${wh.warehouseId}, ${waveId}, ${x}, 'planned')`;
            await tx`insert into picklist_lines (id, tenant_id, picklist_id, wave_id, order_id, order_line_id, sku_id, bin_id, bin_code, qty, shortfall_qty, slice_seq, walk_seq, status)
              values (${uuidv7()}, ${tenantId}, ${picklistId}, ${waveId}, ${x}, ${orderLine.id as string}, ${orderLine.sku_id as string}, ${wh.bins[0]!}, 'A-01-01', 1000, 0, 0, 0, 'planned')`;
          });
          const res = await sweep!;
          expect(res.status).toBe(409);
          expect(res.body.code).toBe('conflict');
          expect(res.body.detail).toContain(waveId);
        } finally {
          await Promise.allSettled([sweep]);
          await holder.end();
        }
        // With nothing free at all, the sweep is the 422 it always was.
        expect((await generate({ warehouseId: wh.warehouseId, policyId })).body.code).toBe('no-eligible-orders');
      });
    });
  });

  // ── the device snapshot (A2, A16 — AC3) ───────────────────────────────────

  describe('the device snapshot', () => {
    it('pick tasks: whole picklists by urgency (an urgent picklist before an older routine one), each stop carrying its order’s priority and ship-by; the walk inside stays in bin order', async () => {
      const wh = await freshWarehouse('PKT');
      await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-3')!, 10);
      await adjust(wh.warehouseId, wh.bins[1]!, sku.get('A-4')!, 10);
      const routine = await createOrder('A-3', {}, wh.warehouseId);
      const urgent = (
        await staffCreate({
          warehouseId: wh.warehouseId,
          lines: [
            { skuId: sku.get('A-4')!, quantity: 1 },
            { skuId: sku.get('A-3')!, quantity: 1 },
          ],
          destination: testAddress(),
          priority: 'urgent',
          shipByDate: todayIst(),
        }).expect(201)
      ).body.order.id as string;
      const policyId = await policy(wh.warehouseId, 'single');
      const first = (await generate({ warehouseId: wh.warehouseId, policyId, orderIds: [routine] }).expect(201)).body.wave as Wave;
      const second = (await generate({ warehouseId: wh.warehouseId, policyId, orderIds: [urgent] }).expect(201)).body.wave as Wave;
      await release(first.id);
      await release(second.id);
      const tasks = (await snapshot(wh.warehouseId)).pickTasks as { orderId: string; binCode: string; walkSeq: number; orderPriority: string; orderShipByDate: string | null }[];
      expect(tasks.map((task) => task.orderId)).toEqual([urgent, urgent, routine]);
      expect(tasks.map((task) => task.binCode)).toEqual(['A-01-01', 'A-01-02', 'A-01-01']);
      expect(tasks.map((task) => task.walkSeq)).toEqual([0, 1, 0]);
      expect(tasks[0]).toMatchObject({ orderPriority: 'urgent', orderShipByDate: todayIst() });
      expect(tasks[2]).toMatchObject({ orderPriority: 'normal', orderShipByDate: null });
    });

    it('pack tasks: the urgent fully-picked order sits above the routine one and carries its chips and COD', async () => {
      const wh = await freshWarehouse('PCK');
      await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-3')!, 10);
      const routine = await createOrder('A-3', {}, wh.warehouseId);
      const urgent = await createOrder('A-3', { priority: 'high', shipByDate: todayIst(), codAmountPaise: 149900 }, wh.warehouseId);
      await pickedOrder(routine, wh.warehouseId);
      await pickedOrder(urgent, wh.warehouseId);
      const tasks = (await snapshot(wh.warehouseId)).packTasks as { orderId: string; orderPriority: string; orderShipByDate: string | null; codAmountPaise: number | null }[];
      expect(tasks.map((task) => task.orderId)).toEqual([urgent, routine]);
      expect(tasks[0]).toMatchObject({ orderPriority: 'high', orderShipByDate: todayIst(), codAmountPaise: 149900 });
      expect(tasks[1]).toMatchObject({ orderPriority: 'normal', orderShipByDate: null, codAmountPaise: null });
    });

    it('A8 due first (pick): an OVERDUE normal picklist leads an older HIGH one that is not due — on the snapshot IST date', async () => {
      const wh = await freshWarehouse('PDF');
      await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-3')!, 10);
      const high = await createOrder('A-3', { priority: 'high', shipByDate: addIsoDays(todayIst(), 7) }, wh.warehouseId);
      const overdue = await createOrder('A-3', { shipByDate: todayIst() }, wh.warehouseId);
      await sql`update orders set ship_by_date = ${addIsoDays(todayIst(), -1)}::date where id = ${overdue}`;
      const policyId = await policy(wh.warehouseId, 'single');
      const first = (await generate({ warehouseId: wh.warehouseId, policyId, orderIds: [high] }).expect(201)).body.wave as Wave;
      const second = (await generate({ warehouseId: wh.warehouseId, policyId, orderIds: [overdue] }).expect(201)).body.wave as Wave;
      await release(first.id);
      await release(second.id);
      const tasks = (await snapshot(wh.warehouseId)).pickTasks as { orderId: string }[];
      expect(tasks.map((task) => task.orderId)).toEqual([overdue, high]);
    });

    it('A8 due first (pack): an OVERDUE normal order sits above an older HIGH one that is not due', async () => {
      const wh = await freshWarehouse('PKD');
      await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-3')!, 10);
      const high = await createOrder('A-3', { priority: 'high', shipByDate: addIsoDays(todayIst(), 7) }, wh.warehouseId);
      const overdue = await createOrder('A-3', { shipByDate: todayIst() }, wh.warehouseId);
      await sql`update orders set ship_by_date = ${addIsoDays(todayIst(), -1)}::date where id = ${overdue}`;
      await pickedOrder(high, wh.warehouseId);
      await pickedOrder(overdue, wh.warehouseId);
      const tasks = (await snapshot(wh.warehouseId)).packTasks as { orderId: string }[];
      expect(tasks.map((task) => task.orderId)).toEqual([overdue, high]);
    });
  });

  // ── pack, label, rate, manifest, dispatch (A17, A18 — AC4, AC5) ───────────

  describe('the COD order through pack, label, manifest and dispatch', () => {
    it('Pack/dispatch/manifest: the slip, the shipment and the dispatch carry the COD; the manifest freezes codShipmentCount 1 and codTotalPaise 149900 (the list read agrees)', async () => {
      const orderId = await createOrder('A-2', { codAmountPaise: 149900, priority: 'high', shipByDate: todayIst() });
      await pickedOrder(orderId);
      const packed = await pack(orderId, [{ skuId: sku.get('A-2')!, qty: 1 }]).expect(201);
      expect(packed.body.pack).toMatchObject({ codAmountPaise: 149900, orderType: 'b2c', priority: 'high', shipByDate: todayIst() });
      // A prepaid order beside it on the same manifest.
      const prepaid = await createOrder('A-2');
      await pickedOrder(prepaid);
      await pack(prepaid, [{ skuId: sku.get('A-2')!, qty: 1 }]).expect(201);

      // The rate read carries the COD; the no-COD carrier is a refused item.
      const rates = await http().get(`${API}/${tenantId}/outbound/orders/${orderId}/rates`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      const items = rates.body.rates.items as { connectionId: string; quote: unknown; refusal: { code: string } | null }[];
      expect(items.find((item) => item.connectionId === noCodConnection)!.refusal!.code).toBe('carrier-cod-unsupported');
      expect(items.find((item) => item.connectionId === sandboxConnection)!.quote).not.toBeNull();

      // AC5 — a carrier declaring supportsCod: false is refused 409, before any adapter call.
      const refused = await label(orderId, noCodConnection).expect(409);
      expect(refused.body.code).toBe('carrier-cod-unsupported');
      expect((await sql`select count(*)::int as n from shipments where order_id = ${orderId}`)[0]!.n).toBe(0);
      // …the prepaid order labels through it fine.
      const prepaidLabel = await label(prepaid, sandboxConnection).expect(201);

      const labelled = await label(orderId, sandboxConnection).expect(201);
      expect(labelled.body.shipment.codAmountPaise).toBe(149900);
      expect(prepaidLabel.body.shipment.codAmountPaise).toBeNull();
      const read = await http().get(`${API}/${tenantId}/outbound/orders/${orderId}/shipment`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect(read.body.shipment.codAmountPaise).toBe(149900);

      const closed = await manifest([labelled.body.shipment.id as string, prepaidLabel.body.shipment.id as string]).expect(201);
      expect(closed.body.manifest).toMatchObject({ shipmentCount: 2, codShipmentCount: 1, codTotalPaise: 149900 });
      const list = await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/manifests?limit=50`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect((list.body.items as { id: string }[]).find((m) => m.id === closed.body.manifest.id)).toMatchObject({ codShipmentCount: 1, codTotalPaise: 149900 });

      const dispatched = await dispatch(orderId).expect(201);
      expect(dispatched.body.dispatch).toMatchObject({ codAmountPaise: 149900, orderType: 'b2c' });
    });

    it('Manifest no COD: prepaid orders only — codShipmentCount 0, codTotalPaise 0', async () => {
      const orderId = await createOrder('A-2');
      await pickedOrder(orderId);
      await pack(orderId, [{ skuId: sku.get('A-2')!, qty: 1 }]).expect(201);
      const labelled = await label(orderId, sandboxConnection).expect(201);
      const closed = await manifest([labelled.body.shipment.id as string]).expect(201);
      expect(closed.body.manifest).toMatchObject({ codShipmentCount: 0, codTotalPaise: 0 });
    });
  });

  // ── stored snapshots replay byte-unchanged (A1) ───────────────────────────

  describe('a snapshot stored before 4-2a replays unchanged (A1)', () => {
    const FIELDS = ['orderType', 'priority', 'shipByDate', 'codAmountPaise'];

    it('the staff create, the portal placed answer, the pack slip, the label and the manifest', async () => {
      // The staff create.
      const createKey = ulid();
      const body = orderBody('A-2');
      await staffCreate(body, createKey).expect(201);
      await strip(createKey, ['order'], FIELDS);
      const legacyCreate = await storedSnapshot(createKey);
      const replayedCreate = await staffCreate(body, createKey).expect(201);
      expect(replayedCreate.body).toEqual(legacyCreate);
      for (const field of FIELDS) expect(Object.keys(replayedCreate.body.order as object)).not.toContain(field);

      // The portal placed answer.
      const placeKey = ulid();
      const portalBody = orderBody('A-1');
      await place(portalBody, portalA, placeKey).expect(201);
      await strip(placeKey, [], FIELDS);
      const replayedPlace = await place(portalBody, portalA, placeKey).expect(201);
      expect(Object.keys(replayedPlace.body as object).sort()).toEqual(['clientOrderRef', 'lineCount', 'orderId', 'placedAt', 'warehouseName']);

      // The pack slip, the label and the manifest of one order.
      const orderId = replayedCreate.body.order.id as string;
      await pickedOrder(orderId);
      const packKey = ulid();
      const scanned = [{ skuId: sku.get('A-2')!, qty: 1 }];
      await pack(orderId, scanned, packKey).expect(201);
      await strip(packKey, ['pack'], FIELDS);
      const replayedPack = await pack(orderId, scanned, packKey).expect(201);
      expect(replayedPack.body).toEqual(await storedSnapshot(packKey));
      for (const field of FIELDS) expect(Object.keys(replayedPack.body.pack as object)).not.toContain(field);

      const labelKey = ulid();
      const labelled = await label(orderId, sandboxConnection, labelKey).expect(201);
      await strip(labelKey, ['shipment'], ['codAmountPaise']);
      const replayedLabel = await label(orderId, sandboxConnection, labelKey).expect(201);
      expect(replayedLabel.body).toEqual(await storedSnapshot(labelKey));
      expect(Object.keys(replayedLabel.body.shipment as object)).not.toContain('codAmountPaise');

      const manifestKey = ulid();
      await manifest([labelled.body.shipment.id as string], manifestKey).expect(201);
      await strip(manifestKey, ['manifest'], ['codShipmentCount', 'codTotalPaise']);
      const replayedManifest = await manifest([labelled.body.shipment.id as string], manifestKey).expect(201);
      expect(replayedManifest.body).toEqual(await storedSnapshot(manifestKey));
      expect(Object.keys(replayedManifest.body.manifest as object)).not.toContain('codTotalPaise');
    });

    it('a wave generate stored before 4-2a replays its picklists without priority / shipByDate', async () => {
      const wh = await freshWarehouse('RPL');
      await adjust(wh.warehouseId, wh.bins[0]!, sku.get('A-3')!, 5);
      const orderId = await createOrder('A-3', { priority: 'urgent' }, wh.warehouseId);
      const policyId = await policy(wh.warehouseId, 'single');
      const key = ulid();
      const body = { warehouseId: wh.warehouseId, policyId, orderIds: [orderId] };
      const generated = await generate(body, key).expect(201);
      expect(generated.body.wave.picklists[0]).toMatchObject({ priority: 'urgent', shipByDate: null });
      await strip(key, ['wave', 'picklists', '0'], ['priority', 'shipByDate']);
      const replayed = await generate(body, key).expect(201);
      expect(replayed.body).toEqual(await storedSnapshot(key));
      expect(Object.keys(replayed.body.wave.picklists[0] as object)).not.toContain('priority');
    });
  });
});
