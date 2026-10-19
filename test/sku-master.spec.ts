import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { CatalogFacade } from '../src/modules/catalog/catalog.facade';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow, noOpIdempotencyKey, seededIdempotencyKey } from './support/audit-guard';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';

// Story 1-4 — the SKU master on the web: the single-SKU create, the packaging
// PUT (pack levels + every non-primary barcode), the edit's shelf life,
// decision-7 flag guard and primary-barcode promotion, per-client products,
// the import's new columns, the device snapshot's `packBarcodes`, and the
// same-key races on the two lock-taking writes. One tenant with ONE client
// (the single-client create default) and one with THREE (client-required,
// per-client names and barcodes).
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

interface SkuBody {
  id: string;
  code: string;
  clientId: string;
  uom: string;
  barcode: string;
  shelfLifeDays: number | null;
  batchTracked: boolean;
  uomConversions: { uom: string; factor: number }[];
  barcodes: { barcode: string; uom: string; isPrimary: boolean }[];
}

describe('story 1-4: the SKU master (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  // The single-client tenant.
  let soloTenant: string;
  let soloToken: string;
  let soloOwner: string;
  // The multi-client tenant.
  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let opsToken: string;
  let operatorToken: string;
  let selfClient: string;
  let acme: string;
  let beta: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('sku_master');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });

    const solo = await register('Solo');
    soloTenant = solo.tenantId;
    soloToken = solo.token;
    soloOwner = solo.userId;

    const multi = await register('Multi');
    tenantId = multi.tenantId;
    ownerToken = multi.token;
    ownerUserId = multi.userId;
    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    acme = await createClient('ACME', 'Acme Apparel');
    beta = await createClient('BETA', 'Beta Brands');
    opsToken = await createMember('ops_manager');
    operatorToken = await createMember('operator');
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

  async function register(label: string): Promise<{ tenantId: string; token: string; userId: string }> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `${label} SKU Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    const signedIn = await mintSignIn(app, { email, password: 'correct-horse-battery' });
    return {
      tenantId: registered.body.tenant.id as string,
      token: signedIn.body.accessToken as string,
      userId: registered.body.owner.id as string,
    };
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

  async function createMember(role: 'ops_manager' | 'operator'): Promise<string> {
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
    return (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
  }

  function createSku(body: Record<string, unknown>, key = ulid(), opts: { tenant?: string; token?: string } = {}): request.Test {
    return http()
      .post(`${API}/${opts.tenant ?? tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${opts.token ?? ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function putPackaging(skuId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken): request.Test {
    return http()
      .put(`${API}/${tenantId}/catalog/skus/${skuId}/packaging`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function patchSku(skuId: string, body: Record<string, unknown>, key = ulid()): request.Test {
    return http()
      .patch(`${API}/${tenantId}/catalog/skus/${skuId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function createProduct(body: Record<string, unknown>, key = ulid()): request.Test {
    return http()
      .post(`${API}/${tenantId}/catalog/products`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  let seq = 0;
  /** A fresh SKU of `clientId` through the create route. */
  async function newSku(clientId: string, extra: Record<string, unknown> = {}): Promise<SkuBody> {
    seq += 1;
    const res = await createSku({
      code: `SM-${seq}-${ulid().slice(20)}`,
      name: `Sku ${seq}`,
      uom: 'each',
      gstRate: 500,
      batchTracked: false,
      serialTracked: false,
      catchWeightTracked: false,
      clientId,
      ...extra,
    }).expect(201);
    return res.body.sku as SkuBody;
  }

  async function snapshotSku(tenant: string, skuId: string) {
    const summaries = await app.get(CatalogFacade).getSkuSummaries(tenant);
    return summaries.find((summary) => summary.id === skuId)!;
  }

  // ── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('single-client tenant: 201 with the primary and case rows, shelf life, one sku_created event, one audit row; a replay re-serves it', async () => {
      const key = ulid();
      const body = {
        code: 'TEA-1',
        name: 'Assam tea',
        uom: 'pcs',
        gstRate: 500,
        batchTracked: false,
        serialTracked: false,
        catchWeightTracked: false,
        shelfLifeDays: 365,
        barcode: '8901000000100',
        levels: [{ uom: 'case', factor: 12 }],
        barcodes: [{ barcode: '8901000000101', uom: 'case' }],
      };
      const created = await createSku(body, key, { tenant: soloTenant, token: soloToken }).expect(201);
      const sku = created.body.sku as SkuBody;
      expect(sku).toMatchObject({ code: 'TEA-1', uom: 'each', shelfLifeDays: 365, barcode: '8901000000100' });
      expect(sku.uomConversions).toEqual([{ uom: 'case', factor: 12 }]);
      expect(sku.barcodes).toEqual([
        { barcode: '8901000000100', uom: 'each', isPrimary: true },
        { barcode: '8901000000101', uom: 'case', isPrimary: false },
      ]);
      // The self client (the only one).
      const selfOfSolo = (await sql`select id from clients where tenant_id = ${soloTenant} and system_owned`) as unknown as { id: string }[];
      expect(sku.clientId).toBe(selfOfSolo[0]!.id);

      const replay = await createSku(body, key, { tenant: soloTenant, token: soloToken }).expect(201);
      expect(replay.body).toEqual(created.body);
      const events = (await sql`
        select payload from outbox_messages where tenant_id = ${soloTenant} and type = 'catalog.sku_created'
      `) as unknown as { payload: Record<string, unknown> }[];
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({ skuId: sku.id, code: 'TEA-1', clientId: sku.clientId });
      await expectAuditRow({ tenantId: soloTenant, key, action: 'sku.created', targetType: 'sku', targetId: sku.id, actorUserId: soloOwner });

      // AC1 — a fresh device snapshot carries the case barcode with factor 12.
      const summary = await snapshotSku(soloTenant, sku.id);
      expect(summary.packBarcodes).toEqual([{ barcode: '8901000000101', uom: 'case', factor: 12 }]);
      expect(Object.keys(summary.packBarcodes[0]!).sort()).toEqual(['barcode', 'factor', 'uom']);
    });

    it('a blank barcode gets the generated value, and its primary row exists', async () => {
      const sku = await newSku(acme, { barcode: '' });
      expect(sku.barcode).toMatch(/^[0-9a-f-]{36}$/);
      expect(sku.barcodes).toEqual([{ barcode: sku.barcode, uom: 'each', isPrimary: true }]);
    });

    it('multi-client tenant without clientId → 400 client-required (SKU and product)', async () => {
      const res = await createSku({ code: 'NO-CLIENT', name: 'n', uom: 'each', gstRate: 0, batchTracked: false, serialTracked: false, catchWeightTracked: false }).expect(400);
      expect(res.body.code).toBe('client-required');
      const product = await createProduct({ name: 'No client', axes: ['size'] }).expect(400);
      expect(product.body.code).toBe('client-required');
    });

    it('a duplicate code in the client → 409 duplicate-sku-code; the same code in another client is fine', async () => {
      await newSku(acme, { code: 'DUP-CODE' });
      const dup = await createSku({ code: 'DUP-CODE', name: 'n', uom: 'each', gstRate: 0, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId: acme }).expect(409);
      expect(dup.body.code).toBe('duplicate-sku-code');
      await newSku(beta, { code: 'DUP-CODE' });
    });

    it('a barcode equal to a code, or a code equal to a barcode, in the client → 409 barcode-is-code', async () => {
      await newSku(acme, { code: 'CODE-AS-BC' });
      const res = await createSku({ code: 'X-1', name: 'n', uom: 'each', gstRate: 0, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId: acme, barcode: 'CODE-AS-BC' }).expect(409);
      expect(res.body.code).toBe('barcode-is-code');
      const own = await createSku({ code: 'SELF-BC', name: 'n', uom: 'each', gstRate: 0, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId: acme, barcode: 'SELF-BC' }).expect(409);
      expect(own.body.code).toBe('barcode-is-code');
      await newSku(acme, { barcode: 'BC-AS-CODE' });
      const reverse = await createSku({ code: 'BC-AS-CODE', name: 'n', uom: 'each', gstRate: 0, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId: acme }).expect(409);
      expect(reverse.body.code).toBe('barcode-is-code');
    });

    it('an operator cannot create (role-denied); a departed client takes no SKU (client-departed)', async () => {
      const denied = await createSku({ code: 'OP-1', name: 'n', uom: 'each', gstRate: 0, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId: acme }, ulid(), { token: operatorToken }).expect(403);
      expect(denied.body.code).toBe('role-denied');
      // The ops manager holds sku.edit.
      await createSku({ code: `OPS-${ulid().slice(20)}`, name: 'n', uom: 'each', gstRate: 0, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId: acme }, ulid(), { token: opsToken }).expect(201);
      const gone = await createClient('GONE', 'Gone Co');
      await sql`update clients set status = 'departed' where id = ${gone}`;
      const res = await createSku({ code: 'GONE-1', name: 'n', uom: 'each', gstRate: 0, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId: gone }).expect(409);
      expect(res.body.code).toBe('client-departed');
    });

    it('the typed rules: unknown uom, a level equal to the base uom, a factor of 1, an over-range shelf life', async () => {
      const base = { code: 'RULE-1', name: 'n', gstRate: 0, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId: acme };
      expect((await createSku({ ...base, uom: 'furlong' }).expect(400)).body.code).toBe('validation-failed');
      expect((await createSku({ ...base, uom: 'each', levels: [{ uom: 'pcs', factor: 12 }] }).expect(400)).body.code).toBe('validation-failed');
      expect((await createSku({ ...base, uom: 'each', levels: [{ uom: 'case', factor: 1 }] }).expect(400)).body.code).toBe('validation-failed');
      expect((await createSku({ ...base, uom: 'each', shelfLifeDays: 3651 }).expect(400)).body.code).toBe('validation-failed');
      expect((await createSku({ ...base, uom: 'each', barcode: 'has;semi' }).expect(400)).body.code).toBe('validation-failed');
    });
  });

  // ── packaging ──────────────────────────────────────────────────────────────

  describe('packaging', () => {
    it('replaces the levels and barcodes; the snapshot lists factors 12 / 480 / 1; one audit row and one sku_edited event', async () => {
      const sku = await newSku(acme);
      const key = ulid();
      const res = await putPackaging(sku.id, {
        levels: [
          { uom: 'case', factor: 12 },
          { uom: 'pallet', factor: 480 },
        ],
        barcodes: [
          { barcode: '8902000000001', uom: 'case' },
          { barcode: '8902000000002', uom: 'pallet' },
          { barcode: '8902000000003', uom: 'each' },
        ],
      }, key).expect(200);
      expect(res.body.sku.uomConversions).toEqual([
        { uom: 'case', factor: 12 },
        { uom: 'pallet', factor: 480 },
      ]);
      expect(res.body.sku.barcodes).toEqual([
        { barcode: sku.barcode, uom: 'each', isPrimary: true },
        { barcode: '8902000000001', uom: 'case', isPrimary: false },
        { barcode: '8902000000003', uom: 'each', isPrimary: false },
        { barcode: '8902000000002', uom: 'pallet', isPrimary: false },
      ]);
      const summary = await snapshotSku(tenantId, sku.id);
      expect(summary.packBarcodes).toEqual([
        { barcode: '8902000000001', uom: 'case', factor: 12 },
        { barcode: '8902000000003', uom: 'each', factor: 1 },
        { barcode: '8902000000002', uom: 'pallet', factor: 480 },
      ]);
      await expectAuditRow({ tenantId, key, action: 'sku.packaging_replaced', targetType: 'sku', targetId: sku.id, actorUserId: ownerUserId });
      const replay = await putPackaging(sku.id, { levels: [{ uom: 'pallet', factor: 480 }, { uom: 'case', factor: 12 }], barcodes: [{ barcode: '8902000000003', uom: 'each' }, { barcode: '8902000000002', uom: 'pallet' }, { barcode: '8902000000001', uom: 'case' }] }, key).expect(200);
      expect(replay.body).toEqual(res.body);
      const events = (await sql`
        select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'catalog.sku_edited' and payload ->> 'skuId' = ${sku.id}
      `) as unknown as { n: number }[];
      expect(events[0]!.n).toBe(1);

      // The same sets reordered under a NEW key: the no-op arm — 200, no audit row.
      const noOpKey = noOpIdempotencyKey(tenantId, ulid(), 'skus.packaging:unchanged');
      const noOp = await putPackaging(sku.id, {
        levels: [{ uom: 'pallet', factor: 480 }, { uom: 'case', factor: 12 }],
        barcodes: [{ barcode: '8902000000003', uom: 'each' }, { barcode: '8902000000002', uom: 'pallet' }, { barcode: '8902000000001', uom: 'case' }],
      }, noOpKey).expect(200);
      expect(noOp.body.sku.barcodes).toEqual(res.body.sku.barcodes);
      const audits = (await sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${noOpKey}`) as unknown as { n: number }[];
      expect(audits[0]!.n).toBe(0);

      // Clearing everything leaves just the primary.
      const cleared = await putPackaging(sku.id, { levels: [], barcodes: [] }).expect(200);
      expect(cleared.body.sku.barcodes).toEqual([{ barcode: sku.barcode, uom: 'each', isPrimary: true }]);
      expect(cleared.body.sku.uomConversions).toEqual([]);
    });

    it('a barcode held by another SKU of the client → 409 duplicate-barcode naming the SKU and level; the same barcode in another client is allowed', async () => {
      const holder = await newSku(acme);
      await putPackaging(holder.id, { levels: [{ uom: 'case', factor: 6 }], barcodes: [{ barcode: '8903000000001', uom: 'case' }] }).expect(200);
      const other = await newSku(acme);
      const before = await snapshotSku(tenantId, other.id);
      const clash = await putPackaging(other.id, { levels: [{ uom: 'case', factor: 12 }], barcodes: [{ barcode: '8903000000001', uom: 'case' }] }).expect(409);
      expect(clash.body.code).toBe('duplicate-barcode');
      expect(clash.body.detail).toContain(holder.code);
      expect(clash.body.detail).toContain('case');
      expect(await snapshotSku(tenantId, other.id)).toEqual(before);
      // Another client may carry it.
      const elsewhere = await newSku(beta);
      await putPackaging(elsewhere.id, { levels: [{ uom: 'case', factor: 12 }], barcodes: [{ barcode: '8903000000001', uom: 'case' }] }).expect(200);
      // The primary barcode of another SKU clashes too.
      const primaryClash = await putPackaging(other.id, { levels: [], barcodes: [{ barcode: holder.barcode, uom: 'each' }] }).expect(409);
      expect(primaryClash.body.code).toBe('duplicate-barcode');
    });

    it('refusals: barcode = a code (409 barcode-is-code), level missing (400 barcode-level-unknown), level = base, repeat, equal to the primary', async () => {
      const sku = await newSku(acme);
      const codeHolder = await newSku(acme);
      expect((await putPackaging(sku.id, { levels: [], barcodes: [{ barcode: codeHolder.code, uom: 'each' }] }).expect(409)).body.code).toBe('barcode-is-code');
      expect((await putPackaging(sku.id, { levels: [], barcodes: [{ barcode: sku.code, uom: 'each' }] }).expect(409)).body.code).toBe('barcode-is-code');
      expect((await putPackaging(sku.id, { levels: [{ uom: 'case', factor: 12 }], barcodes: [{ barcode: '8904000000001', uom: 'pallet' }] }).expect(400)).body.code).toBe('barcode-level-unknown');
      expect((await putPackaging(sku.id, { levels: [{ uom: 'each', factor: 12 }], barcodes: [] }).expect(400)).body.code).toBe('validation-failed');
      expect((await putPackaging(sku.id, { levels: [{ uom: 'case', factor: 12 }, { uom: 'cases', factor: 6 }], barcodes: [] }).expect(400)).body.code).toBe('validation-failed');
      expect((await putPackaging(sku.id, { levels: [{ uom: 'case', factor: 1_000_001 }], barcodes: [] }).expect(400)).body.code).toBe('validation-failed');
      expect((await putPackaging(sku.id, { levels: [], barcodes: [{ barcode: sku.barcode, uom: 'each' }] }).expect(400)).body.code).toBe('validation-failed');
      const twice = await putPackaging(sku.id, { levels: [{ uom: 'case', factor: 12 }], barcodes: [{ barcode: '8904000000002', uom: 'case' }, { barcode: '8904000000002', uom: 'each' }] }).expect(409);
      expect(twice.body.code).toBe('duplicate-barcode');
      // Nothing was written by any refusal.
      expect((await snapshotSku(tenantId, sku.id)).packBarcodes).toEqual([]);
    });

    it('an operator is refused (role-denied); an unknown SKU is 404', async () => {
      const sku = await newSku(acme);
      expect((await putPackaging(sku.id, { levels: [], barcodes: [] }, ulid(), operatorToken).expect(403)).body.code).toBe('role-denied');
      expect((await putPackaging(uuidv7(), { levels: [], barcodes: [] }).expect(404)).body.code).toBe('not-found');
    });
  });

  // ── edit ───────────────────────────────────────────────────────────────────

  describe('edit', () => {
    it('shelf life sets and clears; an empty patch lists shelfLifeDays', async () => {
      const sku = await newSku(acme);
      expect((await patchSku(sku.id, { shelfLifeDays: 180 }).expect(200)).body.shelfLifeDays).toBe(180);
      expect((await patchSku(sku.id, { shelfLifeDays: null }).expect(200)).body.shelfLifeDays).toBeNull();
      const empty = await patchSku(sku.id, {}).expect(400);
      expect(empty.body.detail).toContain('shelfLifeDays');
    });

    it('promotes this SKU\'s own extra barcode to primary — the extra row goes', async () => {
      const sku = await newSku(acme);
      await putPackaging(sku.id, { levels: [], barcodes: [{ barcode: '8905000000003', uom: 'each' }] }).expect(200);
      const res = await patchSku(sku.id, { barcode: '8905000000003' }).expect(200);
      expect(res.body.barcode).toBe('8905000000003');
      expect(res.body.barcodes).toEqual([{ barcode: '8905000000003', uom: 'each', isPrimary: true }]);
      const rows = (await sql`select barcode, is_primary from sku_barcodes where sku_id = ${sku.id}`) as unknown as { barcode: string; is_primary: boolean }[];
      expect(rows).toEqual([{ barcode: '8905000000003', is_primary: true }]);
    });

    it('the primary barcode change is checked against every level of every SKU, and against codes', async () => {
      const holder = await newSku(acme);
      await putPackaging(holder.id, { levels: [{ uom: 'case', factor: 4 }], barcodes: [{ barcode: '8906000000001', uom: 'case' }] }).expect(200);
      const sku = await newSku(acme);
      const clash = await patchSku(sku.id, { barcode: '8906000000001' }).expect(409);
      expect(clash.body.code).toBe('duplicate-barcode');
      expect(clash.body.detail).toContain(holder.code);
      expect((await patchSku(sku.id, { barcode: holder.code }).expect(409)).body.code).toBe('barcode-is-code');
    });

    it('decision 7: changing a tracking flag while the SKU has stock (any bin, QC-HOLD only, or a pending over-receipt) → 409 sku-has-stock; unchanged flags edit fine', async () => {
      const zone = uuidv7();
      const normalBin = uuidv7();
      const qcBin = uuidv7();
      const wh = uuidv7();
      await sql`insert into warehouses (id, tenant_id, code, name) values (${wh}, ${tenantId}, ${'SM-' + ulid().slice(20)}, 'Stock WH')`;
      await sql`insert into zones (id, tenant_id, warehouse_id, code, name) values (${zone}, ${tenantId}, ${wh}, 'Z', 'Zone')`;
      await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type) values (${normalBin}, ${tenantId}, ${wh}, ${zone}, 'S-01', 1000000, 'shelf')`;
      await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned) values (${qcBin}, ${tenantId}, ${wh}, ${zone}, 'QC-SM', 1000000, 'shelf', true)`;

      const onHand = await newSku(acme);
      await sql`insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity) values (${uuidv7()}, ${tenantId}, ${wh}, ${onHand.id}, ${normalBin}, 5000)`;
      const refused = await patchSku(onHand.id, { batchTracked: true }).expect(409);
      expect(refused.body.code).toBe('sku-has-stock');
      expect(refused.body.detail).toContain('stock on hand');
      // Flags sent unchanged + a name change: fine.
      const ok = await patchSku(onHand.id, { name: 'Renamed', batchTracked: false, serialTracked: false, catchWeightTracked: false }).expect(200);
      expect(ok.body.name).toBe('Renamed');

      const inQc = await newSku(acme);
      await sql`insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity) values (${uuidv7()}, ${tenantId}, ${wh}, ${inQc.id}, ${qcBin}, 2000)`;
      expect((await patchSku(inQc.id, { serialTracked: true }).expect(409)).body.code).toBe('sku-has-stock');

      const pending = await newSku(acme);
      await sql`insert into over_receipts (id, tenant_id, warehouse_id, grn_id, grn_line_id, po_id, po_line_id, sku_id, excess_qty, status, requested_by, requested_at)
        values (${uuidv7()}, ${tenantId}, ${wh}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${pending.id}, 1000, 'pending', ${ownerUserId}, now())`;
      const pendingRes = await patchSku(pending.id, { batchTracked: true }).expect(409);
      expect(pendingRes.body.detail).toContain('pending over-receipt');

      // No stock: the flip goes through.
      const clean = await newSku(acme);
      expect((await patchSku(clean.id, { batchTracked: true }).expect(200)).body.batchTracked).toBe(true);
    });
  });

  // ── products ───────────────────────────────────────────────────────────────

  describe('products', () => {
    it('names are unique per client: client A and client B both create "T-Shirt"; a second in one client is 409', async () => {
      const a = await createProduct({ name: 'T-Shirt', axes: ['size'], clientId: acme }).expect(201);
      expect(a.body.clientId).toBe(acme);
      await createProduct({ name: 'T-Shirt', axes: ['size'], clientId: beta }).expect(201);
      const dup = await createProduct({ name: 'T-Shirt', axes: ['colour'], clientId: acme }).expect(409);
      expect(dup.body.code).toBe('duplicate-product-name');
      expect(dup.body.detail).toContain('for this client');
      const listed = await http().get(`${API}/${tenantId}/catalog/products`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect((listed.body.items as { clientId: string }[]).every((item) => typeof item.clientId === 'string')).toBe(true);
    });

    it('attach refuses a SKU of another client (409 product-client-mismatch); the product client moves only while empty (409 product-has-skus)', async () => {
      const product = (await createProduct({ name: `Hoodie ${ulid()}`, axes: ['size'], clientId: acme }).expect(201)).body as { id: string };
      const betaSku = await newSku(beta);
      const mismatch = await patchSku(betaSku.id, { productId: product.id, variantValues: { size: 'M' } }).expect(409);
      expect(mismatch.body.code).toBe('product-client-mismatch');

      const empty = (await createProduct({ name: `Empty ${ulid()}`, axes: ['size'], clientId: acme }).expect(201)).body as { id: string };
      const moved = await http()
        .patch(`${API}/${tenantId}/catalog/products/${empty.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ clientId: beta })
        .expect(200);
      expect(moved.body.clientId).toBe(beta);

      const acmeSku = await newSku(acme);
      await patchSku(acmeSku.id, { productId: product.id, variantValues: { size: 'S' } }).expect(200);
      const blocked = await http()
        .patch(`${API}/${tenantId}/catalog/products/${product.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ clientId: beta })
        .expect(409);
      expect(blocked.body.code).toBe('product-has-skus');
    });
  });

  // ── client correction ──────────────────────────────────────────────────────

  describe('client correction', () => {
    function correct(skuId: string, clientId: string): request.Test {
      return http()
        .post(`${API}/${tenantId}/catalog/skus/${skuId}/client`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ clientId });
    }

    it('moves every barcode row and the product with the SKU', async () => {
      const product = (await createProduct({ name: `Mover ${ulid()}`, axes: ['size'], clientId: acme }).expect(201)).body as { id: string };
      const sku = await newSku(acme, { levels: [{ uom: 'case', factor: 6 }], barcodes: [{ barcode: '8907000000001', uom: 'case' }] });
      await patchSku(sku.id, { productId: product.id, variantValues: { size: 'L' } }).expect(200);
      const res = await correct(sku.id, beta).expect(200);
      expect(res.body.skus[0].barcodes).toHaveLength(2);
      const rows = (await sql`select distinct client_id from sku_barcodes where sku_id = ${sku.id}`) as unknown as { client_id: string }[];
      expect(rows).toEqual([{ client_id: beta }]);
      const productRow = (await sql`select client_id from products where id = ${product.id}`) as unknown as { client_id: string }[];
      expect(productRow).toEqual([{ client_id: beta }]);
    });

    it('refuses when an extra barcode or the product name is taken in the target (409 duplicate-barcode / duplicate-product-name)', async () => {
      const holder = await newSku(selfClient, { levels: [{ uom: 'case', factor: 6 }], barcodes: [{ barcode: '8908000000001', uom: 'case' }] });
      const mover = await newSku(acme, { levels: [{ uom: 'pallet', factor: 60 }], barcodes: [{ barcode: '8908000000001', uom: 'pallet' }] });
      const clash = await correct(mover.id, selfClient).expect(409);
      expect(clash.body.code).toBe('duplicate-barcode');
      expect(clash.body.detail).toContain(holder.code);

      const name = `Twin ${ulid()}`;
      await createProduct({ name, axes: ['size'], clientId: selfClient }).expect(201);
      const twin = (await createProduct({ name, axes: ['size'], clientId: acme }).expect(201)).body as { id: string };
      const variant = await newSku(acme);
      await patchSku(variant.id, { productId: twin.id, variantValues: { size: 'S' } }).expect(200);
      const nameClash = await correct(variant.id, selfClient).expect(409);
      expect(nameClash.body.code).toBe('duplicate-product-name');
    });
  });

  // ── import ─────────────────────────────────────────────────────────────────

  describe('import', () => {
    function importCsv(header: string, rows: string[], clientId: string): Promise<request.Response> {
      return http()
        .post(`${API}/${tenantId}/catalog/imports`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .field('mode', 'initial')
        .field('clientId', clientId)
        .attach('file', Buffer.from([header, ...rows].join('\n'), 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
        .expect(201);
    }

    it('takes shelf_life_days and barcodes; row errors on a missing level, a taken barcode, factor 1', async () => {
      const taken = await newSku(acme, { levels: [{ uom: 'case', factor: 2 }], barcodes: [{ barcode: '8909000000009', uom: 'case' }] });
      const header = 'sku_code,name,uom,gst_rate,uom_conversions,shelf_life_days,barcodes';
      const res = await importCsv(
        header,
        [
          'IMP-OK,Imported,pcs,500,case:12,730,case:8909000000001;each:8909000000003',
          'IMP-NOLEVEL,No level,pcs,500,case:12,,pallet:8909000000002',
          'IMP-TAKEN,Taken,pcs,500,case:12,,case:8909000000009',
          'IMP-F1,Factor one,pcs,500,case:1,,',
          'IMP-SHELF,Shelf,pcs,500,,0,',
        ],
        acme,
      );
      expect(res.body).toMatchObject({ committedRows: 1, failedRows: 4 });
      const codes = (res.body.errors as { skuCode: string; code: string }[]).map((e) => [e.skuCode, e.code]);
      expect(codes).toEqual([
        ['IMP-NOLEVEL', 'barcode-level-unknown'],
        ['IMP-TAKEN', 'duplicate-barcode'],
        ['IMP-F1', 'validation-failed'],
        ['IMP-SHELF', 'validation-failed'],
      ]);
      void taken;
      const rows = (await sql`
        select b.barcode, b.uom, b.is_primary, s.shelf_life_days from sku_barcodes b join skus s on s.id = b.sku_id
        where s.tenant_id = ${tenantId} and s.code = 'IMP-OK' and s.client_id = ${acme} order by b.is_primary desc, b.uom, b.barcode
      `) as unknown as { barcode: string; uom: string; is_primary: boolean; shelf_life_days: number }[];
      expect(rows.map((row) => [row.uom, row.is_primary])).toEqual([
        ['each', true],
        ['case', false],
        ['each', false],
      ]);
      expect(rows[0]!.shelf_life_days).toBe(730);
    });

    it('resolves a product within the run\'s client only', async () => {
      const name = `Imported product ${ulid()}`;
      await createProduct({ name, axes: ['size'], clientId: beta }).expect(201);
      const res = await importCsv('sku_code,name,uom,gst_rate,product,variant_values', [`IMP-P,P,pcs,500,${name},size=M`], acme);
      expect(res.body.failedRows).toBe(1);
      expect(res.body.errors[0].code).toBe('validation-failed');
      expect(res.body.errors[0].detail).toContain('does not exist for client');
    });
  });

  // ── races ──────────────────────────────────────────────────────────────────

  describe('same-key races (parked waiters)', () => {
    const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

    async function waitParked(holderPid: number, min: number): Promise<void> {
      const probe = handle();
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active'
              and a.query ilike ${'%"skus"%'} and a.query ilike '%for update%'
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
        throw new Error(`fewer than ${min} request(s) parked on the skus row`);
      } finally {
        await probe.end();
      }
    }

    async function raceTwice(skuId: string, send: () => request.Test): Promise<[request.Response, request.Response]> {
      const holder = handle();
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from skus where id = ${skuId} for update`) as unknown as { pid: number }[];
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

    it('PUT packaging: both parked same-key requests answer the same 200 body — one replacement, one key, one audit row', async () => {
      const sku = await newSku(acme);
      const key = ulid();
      const [a, b] = await raceTwice(sku.id, () =>
        putPackaging(sku.id, { levels: [{ uom: 'case', factor: 24 }], barcodes: [{ barcode: '8910000000001', uom: 'case' }] }, key),
      );
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.body).toEqual(a.body);
      const keys = (await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { n: number }[];
      expect(keys[0]!.n).toBe(1);
      await expectAuditRow({ tenantId, key, action: 'sku.packaging_replaced', targetType: 'sku', targetId: sku.id, actorUserId: ownerUserId });
    });

    it('PATCH flag flip: both parked same-key requests answer the same 200 body — one key, one audit row', async () => {
      const sku = await newSku(acme);
      const key = ulid();
      const [a, b] = await raceTwice(sku.id, () => patchSku(sku.id, { batchTracked: true }, key));
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.body).toEqual(a.body);
      const keys = (await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { n: number }[];
      expect(keys[0]!.n).toBe(1);
      await expectAuditRow({ tenantId, key, action: 'sku.edited', targetType: 'sku', targetId: sku.id, actorUserId: ownerUserId });
    });
  });

  // ── review follow-ups ──────────────────────────────────────────────────────

  describe('review follow-ups', () => {
    function importCsv(header: string, rows: string[], clientId: string): Promise<request.Response> {
      return http()
        .post(`${API}/${tenantId}/catalog/imports`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .field('mode', 'initial')
        .field('clientId', clientId)
        .attach('file', Buffer.from([header, ...rows].join('\n'), 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
        .expect(201);
    }

    it('a PATCH promoting this SKU\'s own CASE barcode to primary is refused 400 (it would count one unit); a base-level extra still promotes', async () => {
      const sku = await newSku(acme, {
        levels: [{ uom: 'case', factor: 12 }],
        barcodes: [{ barcode: '8911000000001', uom: 'case' }, { barcode: '8911000000002', uom: 'each' }],
      });
      const refused = await patchSku(sku.id, { barcode: '8911000000001' }).expect(400);
      expect(refused.body.code).toBe('validation-failed');
      expect(refused.body.detail).toContain('case');
      expect((await snapshotSku(tenantId, sku.id)).packBarcodes).toEqual([
        { barcode: '8911000000001', uom: 'case', factor: 12 },
        { barcode: '8911000000002', uom: 'each', factor: 1 },
      ]);
      expect((await patchSku(sku.id, { barcode: '8911000000002' }).expect(200)).body.barcode).toBe('8911000000002');
    });

    it('decision 7, catch-weight arm: a plain SKU with stock cannot turn catch-weight on (409 sku-has-stock)', async () => {
      const sku = await newSku(acme);
      const wh = uuidv7();
      const zone = uuidv7();
      const bin = uuidv7();
      await sql`insert into warehouses (id, tenant_id, code, name) values (${wh}, ${tenantId}, ${'CW-' + ulid().slice(20)}, 'CW WH')`;
      await sql`insert into zones (id, tenant_id, warehouse_id, code, name) values (${zone}, ${tenantId}, ${wh}, 'Z', 'Zone')`;
      await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type) values (${bin}, ${tenantId}, ${wh}, ${zone}, 'CW-01', 1000000, 'shelf')`;
      await sql`insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity) values (${uuidv7()}, ${tenantId}, ${wh}, ${sku.id}, ${bin}, 3000)`;
      const res = await patchSku(sku.id, { catchWeightTracked: true }).expect(409);
      expect(res.body.code).toBe('sku-has-stock');
      expect(res.body.detail).toContain('catch-weight');
    });

    it('import, decision 13: a barcode equal to its own code, to another row\'s code in the file, to an existing client code; a code equal to an existing client barcode — each a barcode-is-code row error', async () => {
      const existing = await newSku(acme, { barcode: `EXIST-BC-${ulid().slice(20)}` });
      const res = await importCsv(
        'sku_code,name,uom,gst_rate,barcode',
        [
          'BIC-OWN,Own,pcs,500,BIC-OWN',
          'BIC-ROW,Row,pcs,500,BIC-OTHER',
          'BIC-OTHER,Other,pcs,500,BIC-OTHER-BC',
          `BIC-CLIENT,Client,pcs,500,${existing.code}`,
          `${existing.barcode},Code as barcode,pcs,500,BIC-CAB-BC`,
        ],
        acme,
      );
      const byCode = new Map((res.body.errors as { skuCode: string; code: string }[]).map((e) => [e.skuCode, e.code]));
      expect(byCode.get('BIC-OWN')).toBe('barcode-is-code');
      expect(byCode.get('BIC-ROW')).toBe('barcode-is-code');
      expect(byCode.get('BIC-CLIENT')).toBe('barcode-is-code');
      expect(byCode.get(existing.barcode)).toBe('barcode-is-code');
    });

    it('correction, decision 13 both ways: a moving barcode equal to a target code, and a moving code equal to a target barcode — 409 barcode-is-code naming the moving SKU and the value', async () => {
      const targetSku = await newSku(selfClient);
      const mover = await newSku(acme, { barcode: targetSku.code });
      const one = await http()
        .post(`${API}/${tenantId}/catalog/skus/${mover.id}/client`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ clientId: selfClient })
        .expect(409);
      expect(one.body.code).toBe('barcode-is-code');
      expect(one.body.detail).toContain(mover.code);
      expect(one.body.detail).toContain(targetSku.code);

      const code = `MOVE-${ulid().slice(20)}`;
      await newSku(selfClient, { barcode: code });
      const mover2 = await newSku(acme, { code });
      const two = await http()
        .post(`${API}/${tenantId}/catalog/skus/${mover2.id}/client`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ clientId: selfClient })
        .expect(409);
      expect(two.body.code).toBe('barcode-is-code');
      expect(two.body.detail).toContain(code);
    });

    it('a pre-1.4 SKU edit snapshot replays with shelfLifeDays null and barcodes []', async () => {
      const sku = await newSku(acme);
      const key = seededIdempotencyKey(tenantId, ulid());
      const hash = hashCommandPayload({ tenantId, skuId: sku.id, name: 'Legacy name' });
      const legacy: Record<string, unknown> = { ...sku, name: 'Legacy name' };
      delete legacy['shelfLifeDays'];
      delete legacy['barcodes'];
      await sql`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (${uuidv7()}, ${tenantId}, ${key}, ${hash}, ${sql.json(legacy as never)})`;
      const res = await patchSku(sku.id, { name: 'Legacy name' }, key).expect(200);
      expect(res.body.shelfLifeDays).toBeNull();
      expect(res.body.barcodes).toEqual([]);
      expect(res.body.name).toBe('Legacy name');
    });

    it('a pre-1.4 product create and edit key (hashed without clientId) replays with the row\'s clientId', async () => {
      const name = `Legacy product ${ulid()}`;
      const product = (await createProduct({ name, axes: ['size'], clientId: acme }).expect(201)).body as { id: string; createdAt: string };
      const legacySnapshot = { id: product.id, tenantId, name, axes: ['size'], skuCount: 0, createdAt: product.createdAt };

      const createKey = seededIdempotencyKey(tenantId, ulid());
      await sql`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (${uuidv7()}, ${tenantId}, ${createKey}, ${hashCommandPayload({ tenantId, name, axes: ['size'] })}, ${sql.json(legacySnapshot)})`;
      const created = await createProduct({ name, axes: ['size'] }, createKey).expect(201);
      expect(created.body.clientId).toBe(acme);

      const editKey = seededIdempotencyKey(tenantId, ulid());
      await sql`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (${uuidv7()}, ${tenantId}, ${editKey}, ${hashCommandPayload({ tenantId, productId: product.id, name })}, ${sql.json(legacySnapshot)})`;
      const edited = await http()
        .patch(`${API}/${tenantId}/catalog/products/${product.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, editKey)
        .send({ name })
        .expect(200);
      expect(edited.body.clientId).toBe(acme);
    });
  });

  test('the OpenAPI document exposes the two new routes and the snapshot DTO (drift guard companion)', () => {
    const committed = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    expect(Object.keys(committed.paths['/tenants/{tenantId}/catalog/skus']!)).toEqual(expect.arrayContaining(['get', 'post']));
    expect(Object.keys(committed.paths['/tenants/{tenantId}/catalog/skus/{skuId}/packaging']!)).toEqual(['put']);
    expect(Object.keys(committed.components.schemas['CatalogSnapshotPackBarcodeDto']!.properties!).sort()).toEqual(['barcode', 'factor', 'uom']);
    expect(committed.components.schemas['CatalogSnapshotSkuDto']!.properties!['packBarcodes']).toBeDefined();
    expect(committed.components.schemas['ProductResponse']!.properties!['clientId']).toBeDefined();
  });
});
