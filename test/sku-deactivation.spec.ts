import { type INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { SKU_STATUSES } from '../src/shared/db/schema';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ChannelsIngestCommand } from '../src/modules/channels/channels.ingest.command';
import { ChannelsPublishService } from '../src/modules/channels/channels.publish';
import { ReplenishmentSweep } from '../src/modules/replenishment/replenishment.sweep';
import { ASN_IMPORT_ROW_ERROR_CODES } from '../src/modules/inbound/asn-import.parse';
import { REJECTED_OP_DECISIONS_BY_TYPE, REJECTED_OP_TYPES } from '../src/modules/tenancy/sync-report.command';
import { SKU_NAMING_OP_TYPES } from '../src/modules/tenancy/client-wind-down';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey, seededIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { createLinkedVendor, linkVendor } from './support/linked-vendor';
import { dispatchedOrderFixtures } from './support/dispatched-order';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

jest.setTimeout(120_000);

/**
 * Story 1-4b — SKU deactivation. An inactive SKU refuses new inbound (PO,
 * PO amend, ASN, ASN amend, portal ASN, ASN import), kit composition and new
 * channel mappings; sells down (an order line is accepted only when stock
 * covers it in full); publishes zero to its channels; and stays visible on
 * every existing document. Every row of the spec's I/O matrix has a test.
 */
describe('story 1-4b: SKU deactivation', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;

  let tenantId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorWebToken: string;
  let deviceOperatorToken: string;
  let warehouseId: string;
  let warehouse2Id: string;
  let binA: string;
  let vendorId: string;
  let acme: string;
  let beta: string;
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const at = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const fixtures = dispatchedOrderFixtures(() => ({
    app,
    tenantId,
    warehouseId,
    opsToken,
    ownerToken,
    operatorToken: deviceOperatorToken,
  }));

  function expectProblem(res: request.Response, status: number, code: string): void {
    expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
  }

  async function invite(role: string, clientId?: string): Promise<{ email: string; token: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role, ...(clientId === undefined ? {} : { clientId }) })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    const token =
      clientId === undefined
        ? ((await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string)
        : ((await http().post(`${API}/sign-in`).send({ email, password: PASSWORD }).expect(200)).body.accessToken as string);
    return { email, token };
  }

  async function createClient(code: string): Promise<string> {
    const id = (
      await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name: `${code} Brand` })
        .expect(201)
    ).body.client.id as string;
    if (vendorId !== undefined) await linkVendor(app, tenantId, ownerToken, vendorId, id);
    return id;
  }

  function importCsv(csvRows: string[], clientId: string): SupertestTest {
    const csv = ['sku_code,name,uom,gst_rate,product,variant_values,kit_components', ...csvRows].join('\n');
    return http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' });
  }

  async function refreshSkus(): Promise<void> {
    let cursor: string | null = null;
    do {
      const res = await http()
        .get(`${API}/${tenantId}/catalog/skus`)
        .query({ limit: 200, ...(cursor === null ? {} : { cursor }) })
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      for (const item of res.body.items as { code: string; id: string }[]) skuIds.set(item.code, item.id);
      cursor = res.body.nextCursor as string | null;
    } while (cursor !== null);
  }

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  function setSkuStatus(skuId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken): SupertestTest {
    return http()
      .patch(`${API}/${tenantId}/catalog/skus/${skuId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function deactivate(code: string, reason?: string): Promise<void> {
    await setSkuStatus(sku(code), { status: 'inactive', ...(reason === undefined ? {} : { reason }) }).expect(200);
  }

  function createOrder(lines: { skuId: string; quantity: number }[], key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, lines, destination: testAddress() });
  }

  function createPo(lines: { skuId: string; orderedQty: number }[], vendor = vendorId): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, vendorId: vendor, code: `PO-${ulid().slice(10, 20)}`, lines: lines.map((line) => ({ ...line, unitCostPaise: 1000 })) });
  }

  function amendPo(poId: string, lines: { id?: string; skuId: string; orderedQty: number }[]): SupertestTest {
    return http()
      .patch(`${API}/${tenantId}/inbound/purchase-orders/${poId}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ lines: lines.map((line) => ({ ...line, unitCostPaise: 1000 })) });
  }

  function createAsn(clientId: string, lines: { skuId: string; announcedQty: number }[]): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inbound/asns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ clientId, warehouseId, asnCode: `ASN-${ulid().slice(12, 22)}`, lines });
  }

  function amendAsn(asnId: string, lines: { id?: string; skuId: string; announcedQty: number }[]): SupertestTest {
    return http()
      .patch(`${API}/${tenantId}/inbound/asns/${asnId}`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ lines });
  }

  function kit(skuId: string, components: { skuId: string; quantity: number }[], method: 'post' | 'put' = 'post'): SupertestTest {
    const path = `${API}/${tenantId}/catalog/skus/${skuId}/kit`;
    return (method === 'post' ? http().post(path) : http().put(path))
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ components });
  }

  function adjust(skuId: string, quantityDelta: number, wh = warehouseId, bin = binA): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh, skuId, binId: bin, quantityDelta, reasonCode: 'stock-count', note: 'sku-deactivation seed' });
  }

  function receive(body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, occurredAt: at(), ...body });
  }

  const grnLine = (skuId: string, qty: number, extra: Record<string, unknown> = {}) => ({ skuId, batchCode: null, mfgDate: null, qty, ...extra });

  async function rejectedOp(opId: string): Promise<{ id: string; opType: string; decisions: string[]; status: string; payload: Record<string, unknown> }> {
    const rows = (await sql`select id from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`) as unknown as { id: string }[];
    if (rows[0] === undefined) throw new Error(`no rejected op ${opId}`);
    const listed = await http().get(`${API}/${tenantId}/rejected-ops`).query({ limit: 200 }).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    return (listed.body.items as { id: string }[]).find((item) => item.id === rows[0]!.id) as never;
  }

  function resolve(rejectedOpId: string, body: Record<string, unknown>): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/rejected-ops/${rejectedOpId}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send(body);
  }

  async function onHand(skuId: string): Promise<number> {
    const rows = (await sql`select coalesce(sum(quantity), 0)::bigint as n from stock_on_hand where tenant_id = ${tenantId} and sku_id = ${skuId}`) as unknown as { n: string }[];
    return Number(rows[0]!.n);
  }

  async function liveHolds(skuId: string): Promise<number> {
    const rows = (await sql`select count(*)::int as n from reservations where tenant_id = ${tenantId} and sku_id = ${skuId} and state in ('held', 'committed')`) as unknown as { n: number }[];
    return rows[0]!.n;
  }

  /** A connection row of `provider` (one per provider per tenant), made on first use. */
  async function integration(provider: 'shopify' | 'amazon-in'): Promise<string> {
    const existing = await sql<{ id: string }[]>`select id from integrations where tenant_id = ${tenantId} and provider = ${provider}`;
    if (existing[0] !== undefined) return existing[0].id;
    const id = uuidv7();
    await sql`insert into integrations (id, tenant_id, provider, status, connected_by, ingest_warehouse_id)
      values (${id}, ${tenantId}, ${provider}, 'connected', ${ownerUserId}, ${warehouseId})`;
    return id;
  }

  function putMappings(connectionId: string, items: { externalRef: string; skuId: string }[]): SupertestTest {
    return http()
      .put(`${API}/${tenantId}/channels/connections/${connectionId}/mappings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ items });
  }

  /** Polls until `min` requests are parked on a lock whose chain leads back to the holder. */
  async function waitParked(table: string, holderPid: number, min: number): Promise<void> {
    const probe = handle();
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active' and a.query ilike ${`%"${table}"%`}
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
      throw new Error(`fewer than ${min} request(s) parked on the ${table} row`);
    } finally {
      await probe.end();
    }
  }

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('sku_deactivation');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `SKU Deactivation Co ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
    opsToken = (await invite('ops_manager')).token;
    const operator = await invite('operator');
    operatorWebToken = operator.token;

    const makeWarehouse = async (code: string) =>
      (
        await http()
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code, name: `${code} WH` })
          .expect(201)
      ).body.id as string;
    warehouseId = await makeWarehouse(`SD-${ulid().slice(10, 16)}`);
    warehouse2Id = await makeWarehouse(`SE-${ulid().slice(10, 16)}`);
    const zoneId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binA = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 1000000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;

    acme = await createClient('ACME');
    beta = await createClient('BETA');
    vendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: 'VEND-SD', name: 'Deactivation Vendor' });

    await importCsv(
      [
        'STAT,Status SKU,pcs,1800,,,',
        'INA,Inactive SKU,pcs,1800,,,',
        'INA2,Second inactive SKU,pcs,1800,,,',
        'ACT,Active SKU,pcs,1800,,,',
        'ACT2,Second active SKU,pcs,1800,,,',
        'ACT3,Race SKU,pcs,1800,,,',
        'SELL,Sell-down SKU,pcs,1800,,,',
        'RACE,Order race SKU,pcs,1800,,,',
        'KRACE,Kit race SKU,pcs,1800,,,',
        'KC,Kit race component,pcs,1800,,,',
        'K1,Kit one,pcs,1800,,,',
        'C1,Component one,pcs,1800,,,',
        'C2,Component two,pcs,1800,,,',
        'K2,Kit two,pcs,1800,,,',
        'PUB,Published SKU,pcs,1800,,,',
        'RO,Reorder SKU,pcs,1800,,,',
        'RMA,Returned SKU,pcs,1800,,,',
      ],
      acme,
    ).expect(201);
    await importCsv(['BETA-A,Beta A,pcs,1800,,,'], beta).expect(201);
    await refreshSkus();

    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Deactivation scanner', pin: '2468' })
      .expect(201);
    deviceOperatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: operator.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    const inventory = app.get(InventoryFacade);
    await inventory.rebuildReservationCounters(tenantId, warehouseId);
    await inventory.rebuildReservationCounters(tenantId, warehouse2Id);
  });

  afterAll(async () => {
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('vocabularies and the contract', () => {
    it('SKU_STATUSES is exactly the skus_status_check vocabulary; the reason CHECKs exist', async () => {
      const def = (await sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'skus_status_check'`)[0]!.def;
      const literals = [...def.matchAll(/'([a-z]+)'::text/g)].map((match) => match[1]!);
      expect([...new Set(literals)].sort()).toEqual([...SKU_STATUSES].sort());
      const others = await sql<{ conname: string }[]>`
        select conname from pg_constraint where conname in ('skus_inactive_reason_pairing', 'skus_inactive_reason_length') order by conname`;
      expect(others.map((row) => row.conname)).toEqual(['skus_inactive_reason_length', 'skus_inactive_reason_pairing']);
    });

    it('the CHECKs refuse a reason on an active SKU and a reason over 500 characters', async () => {
      await expect(sql`update skus set inactive_reason = 'x' where id = ${sku('ACT')}`).rejects.toMatchObject({ constraint_name: 'skus_inactive_reason_pairing' });
      await expect(sql`update skus set status = 'inactive', inactive_reason = ${'r'.repeat(501)} where id = ${sku('ACT')}`).rejects.toMatchObject({
        constraint_name: 'skus_inactive_reason_length',
      });
      await expect(sql`update skus set status = 'retired' where id = ${sku('ACT')}`).rejects.toMatchObject({ constraint_name: 'skus_status_check' });
    });

    it('the review vocabularies carry grn.inactive-sku-received (Discard only, SKU-naming); the ASN import carries sku-inactive', () => {
      expect(REJECTED_OP_TYPES).toContain('grn.inactive-sku-received');
      expect(REJECTED_OP_DECISIONS_BY_TYPE['grn.inactive-sku-received']).toEqual(['discard']);
      expect(SKU_NAMING_OP_TYPES).toContain('grn.inactive-sku-received');
      expect(ASN_IMPORT_ROW_ERROR_CODES).toContain('sku-inactive');
    });

    it('OpenAPI lists the status route, the list filter and the new response fields', async () => {
      const doc = await http().get('/api/v1/openapi.json').expect(200);
      expect(Object.keys(doc.body.paths as Record<string, unknown>)).toContain('/tenants/{tenantId}/catalog/skus/{skuId}/status');
      expect(doc.body.paths['/tenants/{tenantId}/catalog/skus/{skuId}/status'].patch).toBeDefined();
      const listParams = (doc.body.paths['/tenants/{tenantId}/catalog/skus'].get.parameters as { name: string; schema?: { enum?: string[] } }[]);
      expect(listParams.find((p) => p.name === 'status')?.schema?.enum).toEqual(['active', 'inactive']);
      const schemas = doc.body.components.schemas;
      expect(schemas.SkuResponse.required).toEqual(expect.arrayContaining(['status', 'inactiveReason']));
      expect(schemas.UpdateSkuStatusDto.properties.status.enum).toEqual(['active', 'inactive']);
      expect(schemas.CatalogSnapshotSkuDto.properties.status.enum).toEqual(['active', 'inactive']);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the status route', () => {
    it('deactivate with a reason: 200, trimmed reason stored, audited sku.deactivated, catalog.sku_edited emitted; a replay writes nothing more', async () => {
      const key = ulid();
      const res = await setSkuStatus(sku('STAT'), { status: 'inactive', reason: '  discontinued  ' }, key).expect(200);
      expect(res.body.sku).toMatchObject({ id: sku('STAT'), status: 'inactive', inactiveReason: 'discontinued' });
      await expectAuditRow({ tenantId, key, action: 'sku.deactivated', targetType: 'sku', targetId: sku('STAT'), actorUserId: ownerUserId });
      const events = await sql`select 1 from outbox_messages where tenant_id = ${tenantId} and type = 'catalog.sku_edited' and payload->>'skuId' = ${sku('STAT')}`;
      expect(events).toHaveLength(1);
      const replay = await setSkuStatus(sku('STAT'), { status: 'inactive', reason: '  discontinued  ' }, key).expect(200);
      expect(replay.body).toEqual(res.body);
      await expectAuditRow({ tenantId, key, action: 'sku.deactivated', targetType: 'sku', targetId: sku('STAT'), actorUserId: ownerUserId });
      expect(await sql`select 1 from outbox_messages where tenant_id = ${tenantId} and type = 'catalog.sku_edited' and payload->>'skuId' = ${sku('STAT')}`).toHaveLength(1);
    });

    it('no-op: the same status with no reason keeps the stored reason — 200, key stored, no audit row, no outbox message', async () => {
      const key = noOpIdempotencyKey(tenantId, ulid(), 'skus.status:unchanged');
      const res = await setSkuStatus(sku('STAT'), { status: 'inactive' }, key).expect(200);
      expect(res.body.sku).toMatchObject({ status: 'inactive', inactiveReason: 'discontinued' });
      expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${key}`).toHaveLength(0);
      expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
      expect(await sql`select 1 from outbox_messages where tenant_id = ${tenantId} and type = 'catalog.sku_edited' and payload->>'skuId' = ${sku('STAT')}`).toHaveLength(1);
      // A blank reason counts as absent — the same no-op.
      const blankKey = noOpIdempotencyKey(tenantId, ulid(), 'skus.status:unchanged');
      const blank = await setSkuStatus(sku('STAT'), { status: 'inactive', reason: '   ' }, blankKey).expect(200);
      expect(blank.body.sku.inactiveReason).toBe('discontinued');
    });

    it('a new reason on an inactive SKU replaces the old one, audited sku.edited', async () => {
      const key = ulid();
      const res = await setSkuStatus(sku('STAT'), { status: 'inactive', reason: 'brand recalled it' }, key).expect(200);
      expect(res.body.sku.inactiveReason).toBe('brand recalled it');
      await expectAuditRow({ tenantId, key, action: 'sku.edited', targetType: 'sku', targetId: sku('STAT'), actorUserId: ownerUserId });
    });

    it('shape refusals: a reason with active, an unknown status, a reason over 500 code points — 400 validation-failed, no key stored', async () => {
      const key = ulid();
      expectProblem(await setSkuStatus(sku('STAT'), { status: 'active', reason: 'x' }, key), 400, 'validation-failed');
      expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(0);
      expectProblem(await setSkuStatus(sku('STAT'), { status: 'retired' }), 400, 'validation-failed');
      const long = await setSkuStatus(sku('STAT'), { status: 'inactive', reason: '𝒳'.repeat(501) });
      expectProblem(long, 400, 'validation-failed');
      expect(long.body.detail).toContain('500');
      // 500 astral code points is within the limit.
      await setSkuStatus(sku('STAT'), { status: 'inactive', reason: '𝒳'.repeat(500) }).expect(200);
    });

    it('authority and scope: an operator is 403; an unknown SKU is 404', async () => {
      expectProblem(await setSkuStatus(sku('STAT'), { status: 'active' }, ulid(), operatorWebToken), 403, 'role-denied');
      expectProblem(await setSkuStatus(uuidv7(), { status: 'inactive' }), 404, 'not-found');
    });

    it('reactivate clears the reason, audited sku.reactivated; the ops manager holds sku.edit', async () => {
      const key = ulid();
      const res = await setSkuStatus(sku('STAT'), { status: 'active' }, key, opsToken).expect(200);
      expect(res.body.sku).toMatchObject({ status: 'active', inactiveReason: null });
      const opsUserId = (await sql<{ id: string }[]>`select id from users where tenant_id = ${tenantId} and role = 'ops_manager'`)[0]!.id;
      await expectAuditRow({ tenantId, key, action: 'sku.reactivated', targetType: 'sku', targetId: sku('STAT'), actorUserId: opsUserId });
    });

    it('a pre-1.4b stored SKU response replays with status active and inactiveReason null', async () => {
      const list = await http().get(`${API}/${tenantId}/catalog/skus`).query({ limit: 200 }).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      const current = (list.body.items as { id: string }[]).find((item) => item.id === sku('ACT2'))! as Record<string, unknown>;
      const legacy: Record<string, unknown> = { ...current, name: 'Legacy name' };
      delete legacy['status'];
      delete legacy['inactiveReason'];
      const key = seededIdempotencyKey(tenantId, ulid());
      await sql`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (${uuidv7()}, ${tenantId}, ${key}, ${hashCommandPayload({ tenantId, skuId: sku('ACT2'), name: 'Legacy name' })}, ${sql.json(legacy as never)})`;
      const res = await http()
        .patch(`${API}/${tenantId}/catalog/skus/${sku('ACT2')}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, key)
        .send({ name: 'Legacy name' })
        .expect(200);
      expect(res.body).toMatchObject({ name: 'Legacy name', status: 'active', inactiveReason: null });
    });

    it('the list: absent status lists every SKU; ?status filters', async () => {
      await deactivate('INA', 'end of line');
      const all = await http().get(`${API}/${tenantId}/catalog/skus`).query({ limit: 200 }).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      const codes = (all.body.items as { code: string }[]).map((item) => item.code);
      expect(codes).toEqual(expect.arrayContaining(['INA', 'ACT']));
      const inactive = await http().get(`${API}/${tenantId}/catalog/skus`).query({ status: 'inactive' }).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect((inactive.body.items as { code: string; status: string }[]).map((item) => [item.code, item.status])).toEqual([['INA', 'inactive']]);
      const active = await http().get(`${API}/${tenantId}/catalog/skus`).query({ status: 'active', limit: 200 }).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect((active.body.items as { code: string }[]).map((item) => item.code)).not.toContain('INA');
      expectProblem(await http().get(`${API}/${tenantId}/catalog/skus`).query({ status: 'gone' }).set('Authorization', `Bearer ${ownerToken}`), 400, 'validation-failed');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('inbound', () => {
    let po: { id: string; lines: { id: string; skuId: string }[] };
    let asn: { id: string; lines: { id: string; skuId: string }[] };

    beforeAll(async () => {
      // Documents created while INA2 is still active; INA was deactivated above,
      // so reactivate it for the setup and deactivate both after.
      await setSkuStatus(sku('INA'), { status: 'active' }).expect(200);
      po = (await createPo([{ skuId: sku('INA'), orderedQty: 10 }, { skuId: sku('ACT'), orderedQty: 5 }]).expect(201)).body.purchaseOrder;
      asn = (await createAsn(acme, [{ skuId: sku('INA'), announcedQty: 10 }, { skuId: sku('ACT'), announcedQty: 5 }]).expect(201)).body.asn;
      await deactivate('INA', 'end of line');
      await deactivate('INA2');
    });

    it('a new PO naming an inactive SKU: 409 sku-inactive naming the codes; nothing written', async () => {
      const before = (await sql`select count(*)::int as n from purchase_orders where tenant_id = ${tenantId}`) as unknown as { n: number }[];
      const res = await createPo([{ skuId: sku('INA2'), orderedQty: 1 }, { skuId: sku('INA'), orderedQty: 1 }, { skuId: sku('ACT'), orderedQty: 1 }]);
      expectProblem(res, 409, 'sku-inactive');
      expect(res.body.skuCodes).toEqual(['INA', 'INA2']);
      const after = (await sql`select count(*)::int as n from purchase_orders where tenant_id = ${tenantId}`) as unknown as { n: number }[];
      expect(after[0]!.n).toBe(before[0]!.n);
    });

    it('precedence (decision 13): an unknown SKU is 404 first; sku-inactive comes before the vendor guard', async () => {
      expectProblem(await createPo([{ skuId: sku('INA'), orderedQty: 1 }, { skuId: uuidv7(), orderedQty: 1 }]), 404, 'not-found');
      const unlinked = await createLinkedVendor(app, tenantId, ownerToken, { code: 'VEND-UNL', name: 'Unlinked', clientIds: [beta] });
      expectProblem(await createPo([{ skuId: sku('INA'), orderedQty: 1 }], unlinked), 409, 'sku-inactive');
      expectProblem(await createPo([{ skuId: sku('ACT'), orderedQty: 1 }], unlinked), 409, 'vendor-not-linked');
    });

    it('precedence (decision 13): a departed client + an inactive SKU answers client-departed', async () => {
      const dep = await createClient('DEPT');
      await importCsv(['DEP-A,Departing A,pcs,1800,,,'], dep).expect(201);
      await refreshSkus();
      await deactivate('DEP-A');
      await http()
        .patch(`${API}/${tenantId}/clients/${dep}/status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ status: 'departed' })
        .expect(200);
      expectProblem(await createPo([{ skuId: sku('DEP-A'), orderedQty: 1 }]), 409, 'client-departed');
      expectProblem(await createAsn(dep, [{ skuId: sku('DEP-A'), announcedQty: 1 }]), 409, 'client-departed');
    });

    it('PO amend: keep the inactive line and add an active one — 200; lower it — 200; raise it, or re-point a kept line to an inactive SKU — 409', async () => {
      const ina = po.lines.find((line) => line.skuId === sku('INA'))!;
      const act = po.lines.find((line) => line.skuId === sku('ACT'))!;
      const kept = await amendPo(po.id, [
        { id: ina.id, skuId: sku('INA'), orderedQty: 10 },
        { id: act.id, skuId: sku('ACT'), orderedQty: 5 },
        { skuId: sku('ACT2'), orderedQty: 3 },
      ]).expect(200);
      const lines = kept.body.purchaseOrder.lines as { id: string; skuId: string; orderedQty: number }[];
      expect(lines).toHaveLength(3);
      const act2 = lines.find((line) => line.skuId === sku('ACT2'))!;
      await amendPo(po.id, [
        { id: ina.id, skuId: sku('INA'), orderedQty: 8 },
        { id: act.id, skuId: sku('ACT'), orderedQty: 5 },
        { id: act2.id, skuId: sku('ACT2'), orderedQty: 3 },
      ]).expect(200);
      const raised = await amendPo(po.id, [
        { id: ina.id, skuId: sku('INA'), orderedQty: 9 },
        { id: act.id, skuId: sku('ACT'), orderedQty: 5 },
        { id: act2.id, skuId: sku('ACT2'), orderedQty: 3 },
      ]);
      expectProblem(raised, 409, 'sku-inactive');
      expect(raised.body.skuCodes).toEqual(['INA']);
      // A kept line re-pointed to an inactive SKU the PO does not carry.
      expectProblem(
        await amendPo(po.id, [
          { id: ina.id, skuId: sku('INA'), orderedQty: 8 },
          { id: act.id, skuId: sku('INA2'), orderedQty: 5 },
          { id: act2.id, skuId: sku('ACT2'), orderedQty: 3 },
        ]),
        409,
        'sku-inactive',
      );
      // …and re-pointed onto the PO's own inactive SKU: its total rises.
      expectProblem(
        await amendPo(po.id, [
          { id: ina.id, skuId: sku('INA'), orderedQty: 8 },
          { id: act.id, skuId: sku('INA'), orderedQty: 5 },
          { id: act2.id, skuId: sku('ACT2'), orderedQty: 3 },
        ]),
        409,
        'sku-inactive',
      );
    });

    it('a PO-line receipt of the inactive SKU keeps receiving, unflagged', async () => {
      const ina = po.lines.find((line) => line.skuId === sku('INA'))!;
      const res = await receive({ poId: po.id, blindReasonCode: null, lines: [grnLine(sku('INA'), 2, { poLineId: ina.id })] }).expect(201);
      expect(res.body.goodsReceipt.lines[0]).toMatchObject({ skuId: sku('INA'), appliedQty: 2 });
      expect(res.body.goodsReceipt.inactiveSkuReviewOpId).toBeUndefined();
      expect(await sql`select 1 from rejected_ops where tenant_id = ${tenantId} and op_type = 'grn.inactive-sku-received' and payload->>'grnId' = ${res.body.goodsReceipt.id}`).toHaveLength(0);
    });

    it('a new ASN naming an inactive SKU: 409; ASN amend keeping it and adding an active one: 200; raising it: 409', async () => {
      const res = await createAsn(acme, [{ skuId: sku('INA'), announcedQty: 1 }]);
      expectProblem(res, 409, 'sku-inactive');
      expect(res.body.skuCodes).toEqual(['INA']);
      const lines = asn.lines;
      const ina = lines.find((line) => line.skuId === sku('INA'))!;
      const act = lines.find((line) => line.skuId === sku('ACT'))!;
      await amendAsn(asn.id, [
        { id: ina.id, skuId: sku('INA'), announcedQty: 10 },
        { id: act.id, skuId: sku('ACT'), announcedQty: 5 },
        { skuId: sku('ACT2'), announcedQty: 2 },
      ]).expect(200);
      expectProblem(
        await amendAsn(asn.id, [
          { id: ina.id, skuId: sku('INA'), announcedQty: 11 },
          { id: act.id, skuId: sku('ACT'), announcedQty: 5 },
        ]),
        409,
        'sku-inactive',
      );
    });

    it('the portal: portal/skus leaves out inactive SKUs, and an announce naming one is 409 sku-inactive', async () => {
      const portal = await invite('client', acme);
      const skus = await http().get(`${API}/${tenantId}/portal/skus`).query({ limit: 100 }).set('Authorization', `Bearer ${portal.token}`).expect(200);
      const codes = (skus.body.items as { skuCode: string }[]).map((item) => item.skuCode);
      expect(codes).toContain('ACT');
      expect(codes).not.toContain('INA');
      const res = await http()
        .post(`${API}/${tenantId}/portal/inbound/asns`)
        .set('Authorization', `Bearer ${portal.token}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, asnCode: `P-${ulid().slice(14, 22)}`, lines: [{ skuId: sku('INA'), announcedQty: 1 }] });
      expectProblem(res, 409, 'sku-inactive');
    });

    it('the ASN import: every row of the group naming an inactive SKU is a row error sku-inactive', async () => {
      const csv = ['asn_code,client,warehouse,expected_at,sku,quantity', 'ASN-IMP-1,ACME,,,INA,1', 'ASN-IMP-1,ACME,,,ACT,1', 'ASN-IMP-1,ACME,,,INA2,1'].join('\n');
      const res = await http()
        .post(`${API}/${tenantId}/inbound/asn-imports`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .field('warehouseId', warehouseId)
        .field('dryRun', 'true')
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 'asns.csv', contentType: 'text/csv' })
        .expect(200);
      expect(res.body.acceptedCount).toBe(0);
      expect((res.body.errors as { code: string; sku: string }[]).map((error) => [error.code, error.sku])).toEqual([
        ['sku-inactive', 'INA'],
        ['sku-inactive', 'INA2'],
      ]);
    });

    it('the deactivate-vs-PO-create lock race: a PO create parked behind a committing deactivation is refused sku-inactive', async () => {
      const holder = handle();
      let created: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from skus where id = ${sku('ACT3')} for update`) as unknown as { pid: number }[];
          created = (async () => createPo([{ skuId: sku('ACT3'), orderedQty: 1 }]))();
          await waitParked('skus', locked[0]!.pid, 1);
          await tx`update skus set status = 'inactive' where id = ${sku('ACT3')}`;
        });
        expectProblem(await created!, 409, 'sku-inactive');
      } finally {
        await Promise.allSettled([created]);
        await holder.end();
      }
      await setSkuStatus(sku('ACT3'), { status: 'active' }).expect(200);
      await createPo([{ skuId: sku('ACT3'), orderedQty: 1 }]).expect(201);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('kits', () => {
    it('a new kit with an inactive component, or an inactive kit SKU: 409 sku-inactive', async () => {
      await kit(sku('K1'), [{ skuId: sku('C1'), quantity: 1 }, { skuId: sku('C2'), quantity: 1 }]).expect(201);
      await deactivate('C2');
      const res = await kit(sku('K2'), [{ skuId: sku('C2'), quantity: 1 }]);
      expectProblem(res, 409, 'sku-inactive');
      expect(res.body.skuCodes).toEqual(['C2']);
      expectProblem(await kit(sku('INA2'), [{ skuId: sku('C1'), quantity: 1 }]), 409, 'sku-inactive');
      expect(await sql`select 1 from kit_compositions where tenant_id = ${tenantId} and kit_sku_id = ${sku('K2')}`).toHaveLength(0);
    });

    it('a kit PUT keeps a stored component that has since been deactivated; a new inactive component is refused', async () => {
      await kit(sku('K1'), [{ skuId: sku('C1'), quantity: 2 }, { skuId: sku('C2'), quantity: 1 }], 'put').expect(200);
      expectProblem(
        await kit(sku('K1'), [{ skuId: sku('C1'), quantity: 2 }, { skuId: sku('C2'), quantity: 1 }, { skuId: sku('INA2'), quantity: 1 }], 'put'),
        409,
        'sku-inactive',
      );
    });

    it('the catalog import kit pass: a kit_components cell naming an inactive SKU is a row error sku-inactive', async () => {
      const res = await importCsv(['IMPKIT,Imported kit,pcs,1800,,,C1:1;C2:1'], acme).expect(201);
      expect((res.body.errors as { code: string; skuCode: string }[]).map((error) => [error.skuCode, error.code])).toEqual([
        ['IMPKIT', 'sku-inactive'],
      ]);
      await refreshSkus();
      expect(await sql`select 1 from kit_compositions where tenant_id = ${tenantId} and kit_sku_id = ${sku('IMPKIT')}`).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('channels', () => {
    it('a new mapping to an inactive SKU is 409; a re-PUT keeping a stored inactive pair and adding an active one is 200', async () => {
      const connectionId = await integration('amazon-in');
      const res = await putMappings(connectionId, [{ externalRef: 'AMZ-INA', skuId: sku('INA') }]);
      expectProblem(res, 409, 'sku-inactive');
      // A pair stored while the SKU was active (seeded directly).
      await sql`insert into channel_mappings (id, tenant_id, integration_id, external_ref, sku_id)
        values (${uuidv7()}, ${tenantId}, ${connectionId}, 'AMZ-KEPT', ${sku('INA')})`;
      const kept = await putMappings(connectionId, [
        { externalRef: 'AMZ-KEPT', skuId: sku('INA') },
        { externalRef: 'AMZ-ACT', skuId: sku('ACT') },
      ]).expect(200);
      expect(kept.body.items).toHaveLength(2);
      // The same ref re-pointed to an inactive SKU is a NEW pair.
      expectProblem(await putMappings(connectionId, [{ externalRef: 'AMZ-ACT', skuId: sku('INA2') }]), 409, 'sku-inactive');
    });

    it('publishes 0 at every warehouse for an inactive mapped SKU with stock; reactivation resumes the real quantity', async () => {
      await adjust(sku('PUB'), 40).expect(201);
      const connectionId = await integration('shopify');
      await sql`insert into channel_mappings (id, tenant_id, integration_id, external_ref, sku_id)
        values (${uuidv7()}, ${tenantId}, ${connectionId}, 'SHOP-PUB', ${sku('PUB')})`;
      const publish = app.get(ChannelsPublishService);
      const latestScopes = async () => {
        const rows = (await sql`
          select payload from outbox_messages
          where tenant_id = ${tenantId} and type = 'channel.availability.published' and payload->>'connectionId' = ${connectionId}
          order by created_at desc, id desc limit 1`) as unknown as { payload: { scopes: { warehouseId: string; skuId: string; visibleMilli: number }[] } }[];
        return rows[0]!.payload.scopes.filter((scope) => scope.skuId === sku('PUB'));
      };
      await deactivate('PUB');
      const inventory = app.get(InventoryFacade);
      const atpSpy = jest.spyOn(inventory, 'channelVisibleQuantity');
      try {
        expect(await publish.publishConnectionSnapshot(tenantId, connectionId)).toBe(true);
        expect(atpSpy.mock.calls.filter((call) => call[2] === sku('PUB'))).toHaveLength(0);
      } finally {
        atpSpy.mockRestore();
      }
      expect((await latestScopes()).map((scope) => [scope.warehouseId, scope.visibleMilli]).sort()).toEqual(
        [[warehouseId, 0], [warehouse2Id, 0]].sort(),
      );
      await setSkuStatus(sku('PUB'), { status: 'active' }).expect(200);
      expect(await publish.publishConnectionSnapshot(tenantId, connectionId)).toBe(true);
      const resumed = await latestScopes();
      expect(resumed.find((scope) => scope.warehouseId === warehouseId)?.visibleMilli).toBe(40_000);
      expect(resumed.find((scope) => scope.warehouseId === warehouse2Id)?.visibleMilli).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('orders sell down', () => {
    beforeAll(async () => {
      await adjust(sku('SELL'), 40).expect(201);
      await deactivate('SELL');
    });

    it('stock covers the line: accepted, the line open, nothing marked', async () => {
      const res = await createOrder([{ skuId: sku('SELL'), quantity: 30 }]).expect(201);
      expect(res.body.order.lines.map((line: { status: string }) => line.status)).toEqual(['open']);
    });

    it('a shortfall refuses the order 409 sku-inactive naming the code and the available quantity; every grant released, no order', async () => {
      const ordersBefore = (await sql`select count(*)::int as n from orders where tenant_id = ${tenantId}`) as unknown as { n: number }[];
      const holdsBefore = await liveHolds(sku('SELL'));
      const res = await createOrder([
        { skuId: sku('ACT'), quantity: 1 },
        { skuId: sku('SELL'), quantity: 30 },
      ]);
      expectProblem(res, 409, 'sku-inactive');
      expect(res.body.skuCodes).toEqual(['SELL']);
      expect(res.body.detail).toContain('ordered 30, available 10');
      expect(await liveHolds(sku('SELL'))).toBe(holdsBefore);
      expect(await liveHolds(sku('ACT'))).toBe(0);
      const ordersAfter = (await sql`select count(*)::int as n from orders where tenant_id = ${tenantId}`) as unknown as { n: number }[];
      expect(ordersAfter[0]!.n).toBe(ordersBefore[0]!.n);
    });

    it('a kit with an inactive component that cannot be reserved in full: 409 sku-inactive, the kit named, no per-component numbers', async () => {
      await adjust(sku('C1'), 10).expect(201);
      const res = await createOrder([{ skuId: sku('K1'), quantity: 1 }]);
      expectProblem(res, 409, 'sku-inactive');
      expect(res.body.skuCodes).toEqual(['C2']);
      expect(res.body.detail).toContain('kit "K1"');
      expect(res.body.detail).toContain('could not be reserved in full');
      expect(await liveHolds(sku('C1'))).toBe(0);
      // Stock that covers the kit in full: accepted.
      await adjust(sku('C2'), 5).expect(201);
      await createOrder([{ skuId: sku('K1'), quantity: 1 }]).expect(201);
    });

    it('a channel order short of an inactive SKU: 422 sku-inactive, metered validation-failed, no backorder-refusal fact, not a backorder', async () => {
      const connectionId = await integration('shopify');
      await sql`update integrations set backorder_policy = 'reject' where id = ${connectionId}`;
      await sql`insert into channel_mappings (id, tenant_id, integration_id, external_ref, sku_id)
        values (${uuidv7()}, ${tenantId}, ${connectionId}, 'SHOP-SELL', ${sku('SELL')})`;
      await sql`delete from integration_calls where integration_id = ${connectionId}`;
      const orderRef = `CH-${ulid()}`;
      const ingest = app.get(ChannelsIngestCommand).ingestOrderDelivery({
        tenantId,
        connectionId,
        parsed: { orderRef, destination: testAddress() as never, lines: [{ externalRef: 'SHOP-SELL', quantity: 30 }] },
      });
      await expect(ingest).rejects.toMatchObject({ status: 422, response: expect.objectContaining({ code: 'sku-inactive', extensions: { skuCodes: ['SELL'] } }) });
      const calls = await sql<{ status: string }[]>`select status from integration_calls where integration_id = ${connectionId}`;
      expect(calls.map((row) => row.status)).toEqual(['validation-failed']);
      expect(await sql`select 1 from ingest_backorder_refusals where tenant_id = ${tenantId} and external_event_id = ${orderRef}`).toHaveLength(0);
      expect(await sql`select 1 from orders where tenant_id = ${tenantId} and external_event_id = ${orderRef}`).toHaveLength(0);
      // A covered line is accepted.
      const accepted = await app.get(ChannelsIngestCommand).ingestOrderDelivery({
        tenantId,
        connectionId,
        parsed: { orderRef: `CH-${ulid()}`, destination: testAddress() as never, lines: [{ externalRef: 'SHOP-SELL', quantity: 5 }] },
      });
      expect(accepted.outcome).toBe('accepted');
      await sql`update integrations set backorder_policy = 'accept' where id = ${connectionId}`;
    });

    it('the race: deactivated between phase 1 and phase 3 with a short line — rolled back, grants released, 409 sku-inactive', async () => {
      await adjust(sku('RACE'), 1).expect(201);
      const inventory = app.get(InventoryFacade);
      const original = inventory.atp.bind(inventory);
      let flipped: request.Response | null = null;
      const spy = jest.spyOn(inventory, 'atp').mockImplementation(async (...args: Parameters<InventoryFacade['atp']>) => {
        if (flipped === null) flipped = await setSkuStatus(sku('RACE'), { status: 'inactive' });
        return original(...args);
      });
      try {
        const res = await createOrder([{ skuId: sku('RACE'), quantity: 2 }]);
        expect(flipped!.status).toBe(200);
        expectProblem(res, 409, 'sku-inactive');
      } finally {
        spy.mockRestore();
      }
      expect(await liveHolds(sku('RACE'))).toBe(0);
      expect(await sql`select 1 from order_lines where tenant_id = ${tenantId} and sku_id = ${sku('RACE')}`).toHaveLength(0);
    });

    it('the kit race (PENDING catalog): a SKU composed into a kit between phase 1 and phase 3 — 409 order-catalog-changed, nothing written', async () => {
      const inventory = app.get(InventoryFacade);
      const original = inventory.atp.bind(inventory);
      let composed: request.Response | null = null;
      const spy = jest.spyOn(inventory, 'atp').mockImplementation(async (...args: Parameters<InventoryFacade['atp']>) => {
        if (composed === null) composed = await kit(sku('KRACE'), [{ skuId: sku('KC'), quantity: 1 }]);
        return original(...args);
      });
      try {
        const res = await createOrder([{ skuId: sku('KRACE'), quantity: 1 }]);
        expect(composed!.status).toBe(201);
        expectProblem(res, 409, 'order-catalog-changed');
        expect(res.body.skuCodes).toEqual(['KRACE']);
      } finally {
        spy.mockRestore();
      }
      expect(await sql`select 1 from order_lines where tenant_id = ${tenantId} and sku_id = ${sku('KRACE')}`).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('receiving', () => {
    it('a blind receipt of an inactive SKU is booked and raises one grn.inactive-sku-received row; Acknowledge (discard) books nothing', async () => {
      const before = await onHand(sku('INA2'));
      const res = await receive({ poId: null, blindReasonCode: 'other', clientId: acme, lines: [grnLine(sku('INA2'), 12)] }).expect(201);
      expect(res.body.goodsReceipt.lines[0]).toMatchObject({ skuId: sku('INA2'), appliedQty: 12 });
      const opId = res.body.goodsReceipt.inactiveSkuReviewOpId as string;
      expect(typeof opId).toBe('string');
      expect(await onHand(sku('INA2'))).toBe(before + 12_000);
      const row = await rejectedOp(opId);
      expect(row).toMatchObject({ opType: 'grn.inactive-sku-received', decisions: ['discard'], status: 'open' });
      expect(row.payload).toEqual({
        grnId: res.body.goodsReceipt.id,
        grnCode: res.body.goodsReceipt.code,
        lines: [{ skuId: sku('INA2'), skuCode: 'INA2', qty: 12, uom: 'each' }],
      });
      expectProblem(await resolve(row.id, { decision: 'apply' }), 409, 'decision-not-available');
      await resolve(row.id, { decision: 'discard' }).expect(200);
      expect((await rejectedOp(opId)).status).not.toBe('open');
      expect(await onHand(sku('INA2'))).toBe(before + 12_000);
      // A replay re-serves the op id and inserts nothing.
    });

    it('a replay re-serves the snapshot and raises no second row', async () => {
      const key = ulid();
      const body = { poId: null, blindReasonCode: 'other', clientId: acme, lines: [grnLine(sku('INA2'), 1)] };
      const first = await receive(body, key).expect(201);
      const second = await receive(body, key).expect(201);
      expect(second.body).toEqual(first.body);
      expect(await sql`select 1 from rejected_ops where tenant_id = ${tenantId} and op_id = ${first.body.goodsReceipt.inactiveSkuReviewOpId}`).toHaveLength(1);
    });

    it('a mixed blind receipt: the inactive line booked and flagged; another client\'s line refused into its own row; nothing listed twice', async () => {
      const res = await receive({
        poId: null,
        blindReasonCode: 'other',
        clientId: acme,
        lines: [grnLine(sku('INA2'), 2), grnLine(sku('BETA-A'), 1), grnLine(sku('ACT'), 1)],
      }).expect(201);
      expect((res.body.goodsReceipt.lines as { skuId: string }[]).map((line) => line.skuId)).toEqual([sku('INA2'), sku('ACT')]);
      expect(res.body.goodsReceipt.rejectedLines).toEqual([expect.objectContaining({ skuId: sku('BETA-A'), code: 'sku-client-mismatch' })]);
      const flag = await rejectedOp(res.body.goodsReceipt.inactiveSkuReviewOpId as string);
      expect((flag.payload.lines as { skuId: string }[]).map((line) => line.skuId)).toEqual([sku('INA2')]);
      const refused = await rejectedOp(res.body.goodsReceipt.reviewOpId as string);
      expect(refused.opType).toBe('grn.lines-refused');
      expect(((refused.payload.lines as { skuId: string }[]) ?? []).map((line) => line.skuId)).toEqual([sku('BETA-A')]);
    });

    it('the full mixed receipt (matrix row): inactive line booked + flagged; another client\'s line → grn.lines-refused; an INACTIVE short-dated line → grn.shelf-life-refused and NOT listed again on the inactive row', async () => {
      // An inactive, batch-tracked SKU of ACME for the short-dated line.
      const created = await http()
        .post(`${API}/${tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'INA-BATCH', name: 'Inactive batch SKU', uom: 'each', gstRate: 1800, batchTracked: true, serialTracked: false, catchWeightTracked: false, clientId: acme })
        .expect(201);
      const batchSku = created.body.sku.id as string;
      await setSkuStatus(batchSku, { status: 'inactive' }).expect(200);
      const policyPath = `${API}/${tenantId}/clients/${acme}/receiving-policy`;
      const original = (await http().get(policyPath).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body as Record<string, unknown>;
      const restore = {
        receivingToleranceBps: original.receivingToleranceBps,
        qcOnReceipt: original.qcOnReceipt,
        expiryRequired: original.expiryRequired,
        minShelfLifeDays: original.minShelfLifeDays,
      };
      await http()
        .put(policyPath)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...restore, expiryRequired: true, minShelfLifeDays: 90 })
        .expect(200);
      try {
        // 10 days left against a 90-day minimum: short-dated.
        const shortExpiry = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
        const res = await receive({
          poId: null,
          blindReasonCode: 'other',
          clientId: acme,
          lines: [
            grnLine(sku('INA2'), 2),
            grnLine(sku('BETA-A'), 1),
            grnLine(batchSku, 4, { batchCode: 'B-SHORT-INA', expiryDate: shortExpiry }),
          ],
        }).expect(201);
        const grn = res.body.goodsReceipt;
        // Only the inactive unrefused line is booked.
        expect((grn.lines as { skuId: string }[]).map((line) => line.skuId)).toEqual([sku('INA2')]);
        expect((grn.rejectedLines as { skuId: string; code: string }[]).map((line) => [line.skuId, line.code])).toEqual([
          [sku('BETA-A'), 'sku-client-mismatch'],
          [batchSku, 'shelf-life-short'],
        ]);
        // Three distinct rows, each listing only its own line.
        const flag = await rejectedOp(grn.inactiveSkuReviewOpId as string);
        expect(flag.opType).toBe('grn.inactive-sku-received');
        expect(flag.payload.lines).toEqual([{ skuId: sku('INA2'), skuCode: 'INA2', qty: 2, uom: 'each' }]);
        const refused = await rejectedOp(grn.reviewOpId as string);
        expect(refused.opType).toBe('grn.lines-refused');
        expect((refused.payload.lines as { skuId: string }[]).map((line) => line.skuId)).toEqual([sku('BETA-A')]);
        const shelf = await rejectedOp(grn.shelfLifeReviewOpId as string);
        expect(shelf.opType).toBe('grn.shelf-life-refused');
        expect((shelf.payload.lines as { skuId: string }[]).map((line) => line.skuId)).toEqual([batchSku]);
        // The refused inactive line appears on no inactive-SKU row anywhere.
        expect(
          await sql`select 1 from rejected_ops where tenant_id = ${tenantId} and op_type = 'grn.inactive-sku-received'
            and payload -> 'lines' @> ${sql.json([{ skuId: batchSku }] as never)}`,
        ).toHaveLength(0);
        expect(await onHand(batchSku)).toBe(0);
      } finally {
        await http().put(policyPath).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send(restore).expect(200);
      }
    });

    it('an unmatched line of an inactive SKU on a PO receipt is booked and flagged', async () => {
      const po = (await createPo([{ skuId: sku('ACT'), orderedQty: 5 }]).expect(201)).body.purchaseOrder;
      const res = await receive({
        poId: po.id,
        blindReasonCode: null,
        lines: [grnLine(sku('ACT'), 1, { poLineId: po.lines[0].id }), grnLine(sku('INA2'), 3)],
      }).expect(201);
      expect(res.body.goodsReceipt.unmatchedLines).toEqual([{ index: 1, reason: 'no-line-reference' }]);
      const flag = await rejectedOp(res.body.goodsReceipt.inactiveSkuReviewOpId as string);
      expect(flag.payload.lines).toEqual([{ skuId: sku('INA2'), skuCode: 'INA2', qty: 3, uom: 'each' }]);
    });

    it('the device catalog snapshot carries each SKU\'s status', async () => {
      const res = await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot`)
        .query({ warehouseId })
        .set('Authorization', `Bearer ${deviceOperatorToken}`)
        .expect(200);
      const byCode = new Map((res.body.skus as { code: string; status: string }[]).map((entry) => [entry.code, entry.status]));
      expect(byCode.get('INA2')).toBe('inactive');
      expect(byCode.get('ACT')).toBe('active');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('replenishment and returns', () => {
    it('the reorder sweep raises nothing for an inactive SKU, recovers its open breach and dismisses its standing draft', async () => {
      await sql`update skus set reorder_point = 5000 where id = ${sku('RO')}`;
      const sweep = app.get(ReplenishmentSweep);
      await sweep.sweepScope(tenantId, warehouseId);
      const opened = await sql<{ status: string }[]>`select status from reorder_breaches where tenant_id = ${tenantId} and sku_id = ${sku('RO')}`;
      expect(opened.map((row) => row.status)).toEqual(['open']);
      expect((await sql<{ status: string }[]>`select status from suggested_pos where tenant_id = ${tenantId} and sku_id = ${sku('RO')}`).map((row) => row.status)).toEqual(['draft']);
      await deactivate('RO');
      await sweep.sweepScope(tenantId, warehouseId);
      expect((await sql<{ status: string }[]>`select status from reorder_breaches where tenant_id = ${tenantId} and sku_id = ${sku('RO')}`).map((row) => row.status)).toEqual(['recovered']);
      expect((await sql<{ status: string }[]>`select status from suggested_pos where tenant_id = ${tenantId} and sku_id = ${sku('RO')}`).map((row) => row.status)).toEqual(['dismissed']);
      await sweep.sweepScope(tenantId, warehouseId);
      expect(await sql`select 1 from reorder_breaches where tenant_id = ${tenantId} and sku_id = ${sku('RO')} and status = 'open'`).toHaveLength(0);
    });

    it('an RMA for an old order line of an inactive SKU is created (returns ignore SKU status)', async () => {
      await adjust(sku('RMA'), 5).expect(201);
      const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku('RMA'), quantity: 1 }]);
      await fixtures.pickAllLines(picklist);
      await fixtures.packAndDispatch(orderId, [{ skuId: sku('RMA'), qty: 1 }]);
      await deactivate('RMA');
      const returnable = await http().get(`${API}/${tenantId}/returns/returnable`).query({ orderId }).set('Authorization', `Bearer ${opsToken}`).expect(200);
      const line = (returnable.body.lines as { orderLineId: string; skuId: string }[]).find((entry) => entry.skuId === sku('RMA'))!;
      await http()
        .post(`${API}/${tenantId}/returns`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ orderId, lines: [{ orderLineId: line.orderLineId, qty: 1, reasonCode: 'damaged' }] })
        .expect(201);
    });
  });
});
