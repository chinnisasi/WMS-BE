import { createHash, createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { ROLE_CAPABILITIES } from '../src/modules/tenancy/permissions';
import { signTenantSession, verifyDeviceSession, verifyTenantSession } from '../src/modules/tenancy/jwt-session';
import { TenantSessionGuard, OPERATOR_SURFACE_DETAIL } from '../src/modules/tenancy/tenant-session.guard';
import { DeviceSessionGuard } from '../src/modules/tenancy/device-session.guard';
import { AnySessionGuard } from '../src/modules/tenancy/any-session.guard';
import { PortalSessionGuard, PORTAL_SURFACE_DETAIL } from '../src/modules/clients/portal-session.guard';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// Story 21-7 — the client portal: the `client` role and its invite rules, the
// portal token (AD-4 amended for the fence only), the central fence on every
// operator route and its reverse on the portal routes, the per-request
// re-read (suspension bites before expiry), and the ten portal reads — each
// one's exact key allowlist, its isolation and its paging. The RLS layer of
// the reads is proved as `wms_rls_probe` in test/client-isolation.spec.ts
// (this suite, like every jest e2e suite, connects as a superuser — RLS is
// inert here, so these HTTP tests prove the app predicate).
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
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

describe('client portal (e2e, story 21-7)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let valkey: Redis;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let wh1: string;
  let bin1: string;
  let bin1b: string;
  let vendorId: string;
  let selfClient: string;
  let clientA: string;
  let clientB: string;
  let clientC: string; // suspended mid-suite (the invite replay)
  let foreignClient: string; // another tenant's
  const sku = new Map<string, string>();

  let portalA: { userId: string; email: string; token: string };
  let portalB: { userId: string; email: string; token: string };

  const ids = {
    orderA1: '',
    orderKit: '',
    orderB: '',
    asnA: '',
    asnB: '',
    poA: '',
    poB: '',
    invoiceAIssued: '',
    invoiceAVoid: '',
    invoiceADraft: '',
    invoiceBIssued: '',
  };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('portal');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Portal 3PL ${ulid()}`, ownerEmail, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = await signIn(ownerEmail);

    // A second tenant — its client is the foreign-tenant invite arm.
    const otherEmail = `other-${ulid().toLowerCase()}@example.com`;
    const other = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Other 3PL ${ulid()}`, ownerEmail: otherEmail, password: PASSWORD })
      .expect(201);
    const otherToken = await signIn(otherEmail);
    foreignClient = (
      await http()
        .post(`${API}/${other.body.tenant.id as string}/clients`)
        .set('Authorization', `Bearer ${otherToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'FOREIGN', name: 'Foreign Brand' })
        .expect(201)
    ).body.client.id as string;

    wh1 = await createWarehouse('P-W1', 'Portal Main');
    // A second warehouse holding nothing of A's: no row for it (no fan-out).
    await createWarehouse('P-W2', 'Portal Overflow');
    const zone = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${wh1}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' })
        .expect(201)
    ).body.id as string;
    bin1 = await createBin(wh1, zone, 'A-01-01');
    bin1b = await createBin(wh1, zone, 'A-01-02');
    vendorId = (
      await http()
        .post(`${API}/${tenantId}/vendors`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'V-PORTAL', name: 'Portal Vendor' })
        .expect(201)
    ).body.vendor.id as string;

    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    clientA = await createClient('BRAND-A', 'Brand A Apparel');
    clientB = await createClient('BRAND-B', 'Brand B Beauty');
    clientC = await createClient('BRAND-C', 'Brand C Ceramics');

    await importCsv(['A-1,Alpha tee,pcs,1800,,,', 'A-2,Alpha cap,pcs,1800,,,', 'A-C1,Alpha sock,pcs,1800,,,', 'A-C2,Alpha band,pcs,1800,,,', 'A-KIT,Alpha bundle,pcs,1800,,,'], clientA);
    await importCsv(['B-1,Beta serum,pcs,1800,,,'], clientB);
    const skus = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);

    await http()
      .post(`${API}/${tenantId}/catalog/skus/${sku.get('A-KIT')!}/kit`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: sku.get('A-C1')!, quantity: 1 }, { skuId: sku.get('A-C2')!, quantity: 2 }] })
      .expect(201);

    // Stock: A-1 across TWO bins of wh1 (one row, summed), B-1 in the SAME
    // bin as A-1 (the shared bin — never fans out, never leaks).
    await adjust(wh1, bin1, sku.get('A-1')!, 4);
    await adjust(wh1, bin1b, sku.get('A-1')!, 6);
    await adjust(wh1, bin1, sku.get('B-1')!, 7);
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, wh1);

    ids.orderA1 = await postOrder([{ skuId: sku.get('A-1')!, quantity: 2 }]);
    ids.orderKit = await postOrder([{ skuId: sku.get('A-KIT')!, quantity: 1 }]);
    ids.orderB = await postOrder([{ skuId: sku.get('B-1')!, quantity: 1 }]);
    // The allocated-only row: A-2 has nothing on hand anywhere but 5 held
    // for an order. Acceptance reserves min(qty, ATP), so no order can create
    // this through the API in one step — the reservation is seeded directly
    // (the read under test sums reservation rows; how one came to exist is
    // the reservation core's business).
    await sql`insert into reservations (id, tenant_id, warehouse_id, sku_id, owner_type, owner_id, quantity, state, expires_at)
      values (${uuidv7()}, ${tenantId}, ${wh1}, ${sku.get('A-2')!}, 'order', ${uuidv7()}, 5000, 'held', now() + interval '1 day')`;

    ids.asnA = (
      await http()
        .post(`${API}/${tenantId}/inbound/asns`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ clientId: clientA, warehouseId: wh1, asnCode: 'ASN-A-1', expectedAt: '2026-10-20T04:30:00.000Z', lines: [{ skuId: sku.get('A-1')!, announcedQty: 5 }, { skuId: sku.get('A-2')!, announcedQty: 3 }] })
        .expect(201)
    ).body.asn.id as string;
    ids.asnB = (
      await http()
        .post(`${API}/${tenantId}/inbound/asns`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ clientId: clientB, warehouseId: wh1, asnCode: 'ASN-B-1', lines: [{ skuId: sku.get('B-1')!, announcedQty: 2 }] })
        .expect(201)
    ).body.asn.id as string;
    ids.poA = await createPo('PO-A-1', [{ skuId: sku.get('A-1')!, orderedQty: 3, unitCostPaise: 12345 }]);
    ids.poB = await createPo('PO-B-1', [{ skuId: sku.get('B-1')!, orderedQty: 4, unitCostPaise: 999 }]);

    // Invoices: seeded below the API (the 21-5 flow needs a month of metered
    // history); born draft, issued (and voided) through the guard trigger.
    ids.invoiceAIssued = await seedInvoice(clientA, '2026-08-01', 'issued', 1);
    ids.invoiceAVoid = await seedInvoice(clientA, '2026-07-01', 'void', 2);
    ids.invoiceADraft = await seedInvoice(clientA, '2026-09-01', 'draft', 0);
    ids.invoiceBIssued = await seedInvoice(clientB, '2026-08-01', 'issued', 3);

    portalA = await portalUser(clientA);
    portalB = await portalUser(clientB);
  });

  afterAll(async () => {
    for (const tenant of [tenantId]) {
      const keys = await valkey.keys(`wms:{${tenant}}:*`).catch(() => [] as string[]);
      if (keys.length > 0) await valkey.del(...keys);
    }
    await valkey.quit().catch(() => valkey.disconnect());
    await sql?.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function signIn(email: string, password = PASSWORD): Promise<string> {
    return (await http().post(`${API}/sign-in`).send({ email, password }).expect(200)).body.accessToken as string;
  }

  async function createWarehouse(code: string, name: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${code}-${ulid().slice(20)}`, name })
        .expect(201)
    ).body.id as string;
  }

  async function createBin(warehouseId: string, zoneId: string, code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code })
        .expect(201)
    ).body.id as string;
  }

  async function createClient(code: string, name: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name })
        .expect(201)
    ).body.client.id as string;
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

  async function adjust(warehouseId: string, binId: string, skuId: string, quantityDelta: number): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta, reasonCode: 'stock-count', note: 'portal seed' })
      .expect(201);
  }

  async function postOrder(lines: { skuId: string; quantity: number }[]): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/outbound/orders`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh1, lines, destination: testAddress() })
        .expect(201)
    ).body.order.id as string;
  }

  async function createPo(code: string, lines: { skuId: string; orderedQty: number; unitCostPaise: number }[]): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/inbound/purchase-orders`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: wh1, vendorId, code, lines })
        .expect(201)
    ).body.purchaseOrder.id as string;
  }

  const PARTY = {
    supplier: {
      name: 'Portal 3PL',
      gstin: '29ABCDE1234F1Z5',
      stateCode: '29',
      stateName: 'Karnataka',
      address: { line1: '12, Peenya', line2: null, city: 'Bengaluru', state: 'Karnataka', pincode: '560066' },
      warehouseCode: 'P-W1',
    },
    recipient: {
      name: 'Brand A Apparel',
      code: 'BRAND-A',
      legalName: 'Brand A Apparel Pvt Ltd',
      gstin: '29AAACA1111A1Z1',
      stateCode: '29',
      stateName: 'Karnataka',
      address: { line1: '1 MG Road', line2: null, city: 'Bengaluru', stateCode: '29', pincode: '560001' },
    },
  };

  /** A month's invoice of one client: draft, issued, or issued then voided. */
  async function seedInvoice(clientId: string, periodStart: string, status: 'draft' | 'issued' | 'void', seq: number): Promise<string> {
    const id = uuidv7();
    const [y, m] = periodStart.split('-').map(Number) as [number, number];
    const periodEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const segmentFrom = new Date(Date.UTC(y, m - 1, 1) - 19_800_000).toISOString();
    const segmentTo = new Date(Date.UTC(y, m, 1) - 19_800_000).toISOString();
    await sql`insert into client_invoices (id, tenant_id, client_id, period_start, period_end, status, supplier_gstin,
        place_of_supply, supply_type, subtotal_paise, cgst_paise, sgst_paise, igst_paise, tax_paise, total_paise,
        round_off_paise, payable_paise, gaps, warnings, party, content_hash, created_by)
      values (${id}, ${tenantId}, ${clientId}, ${periodStart}, ${periodEnd}, 'draft', '29ABCDE1234F1Z5',
        '29', 'intra', 3000, 270, 270, 0, 540, 3540, -40, 3500, '[]'::jsonb, ${sql.json([{ code: 'operator-only-warning' }])}, ${sql.json(PARTY)}, 'seed', ${ownerUserId})`;
    await sql`insert into client_invoice_lines (id, tenant_id, invoice_id, rate_card_id, segment_from, segment_to, charge_code, basis,
        uom, quantity, unit_amount_paise, amount_paise, sac_code, gst_bps, place_of_supply, supply_type, cgst_paise, sgst_paise, igst_paise)
      values (${uuidv7()}, ${tenantId}, ${id}, ${uuidv7()}, ${segmentFrom}, ${segmentTo}, 'pick', 'per_pick',
        null, 10, 300, 3000, '996719', 1800, '29', 'intra', 270, 270, 0)`;
    if (status === 'draft') return id;
    await sql`update client_invoices set status = 'issued', invoice_no = ${`29/S2627/${String(seq).padStart(6, '0')}`},
        fy_label = 'FY-2627', series_seq = ${seq}, issued_at = '2026-10-02T05:00:00.000Z', issued_by = ${ownerUserId}
      where id = ${id}`;
    if (status === 'void') {
      await sql`update client_invoices set status = 'void', status_note = 'operator-written void reason',
          status_changed_at = now(), status_changed_by = ${ownerUserId}
        where id = ${id}`;
    }
    return id;
  }

  function invite(body: Record<string, unknown>, key = ulid(), token = ownerToken) {
    return http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  async function accept(inviteToken: string): Promise<void> {
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: inviteToken, password: PASSWORD }).expect(200);
  }

  async function portalUser(clientId: string): Promise<{ userId: string; email: string; token: string }> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await invite({ email, role: 'client', clientId }).expect(201);
    await accept(invited.body.inviteToken as string);
    return { userId: invited.body.user.id as string, email, token: await signIn(email) };
  }

  async function staffUser(role: 'operator' | 'ops_manager'): Promise<{ userId: string; email: string; token: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await invite({ email, role }).expect(201);
    await accept(invited.body.inviteToken as string);
    return { userId: invited.body.user.id as string, email, token: await signIn(email) };
  }

  function portalGet(path: string, token = portalA.token) {
    return http().get(`${API}/${tenantId}/portal/${path}`).set('Authorization', `Bearer ${token}`);
  }

  function payloadOf(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  }

  /** Hand-signs a token with the suite's secret — the odd-claim arms. */
  function signRaw(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', process.env.JWT_SECRET!).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  async function withClientStatus<T>(clientId: string, status: 'active' | 'suspended', run: () => Promise<T>): Promise<T> {
    await sql`update clients set status = ${status} where id = ${clientId}`;
    try {
      return await run();
    } finally {
      await sql`update clients set status = 'active' where id = ${clientId}`;
    }
  }

  // ── every route, by reflection (the fence and the guard coverage) ─────────

  interface RouteInfo {
    readonly method: string;
    /** The path as declared, after the global prefix (`api/v1/tenants/:tenantId/…`). */
    readonly path: string;
    readonly guards: readonly unknown[];
  }

  function routes(): RouteInfo[] {
    const out: RouteInfo[] = [];
    const seen = new Set<unknown>();
    for (const module of app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const type = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
        if (type === undefined || seen.has(type)) continue;
        seen.add(type);
        const base = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
        const classGuards = (Reflect.getMetadata(GUARDS_METADATA, type) ?? []) as unknown[];
        for (const name of Object.getOwnPropertyNames(type.prototype)) {
          if (name === 'constructor') continue;
          const handler = (type.prototype as Record<string, unknown>)[name];
          if (typeof handler !== 'function') continue;
          const subPaths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
          if (subPaths === undefined || method === undefined) continue;
          const guards = [...classGuards, ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[])];
          for (const sub of Array.isArray(subPaths) ? subPaths : [subPaths]) {
            const joined = ['api/v1', base, sub].map((part) => part.replace(/^\/+|\/+$/g, '')).filter((part) => part !== '').join('/');
            out.push({ method: RequestMethod[method], path: joined, guards });
          }
        }
      }
    }
    return out;
  }

  /** The routes no session guards — by EXACT method and path. */
  const UNGUARDED = new Set([
    'GET api/v1/health',
    'GET api/v1/openapi.json',
    'POST api/v1/echo',
    'POST api/v1/tenants',
    'POST api/v1/tenants/sign-in',
    'POST api/v1/tenants/:tenantId/accept-invite',
    'POST api/v1/tenants/:tenantId/devices/enroll',
    'POST api/v1/tenants/:tenantId/webhooks/channels/:provider/:connectionId/orders',
    'POST api/v1/tenants/:tenantId/webhooks/channels/:provider/:connectionId/cancellations',
    'ALL api/v1/{*path}',
  ]);

  /** Story 21-7b — the portal's ONLY writes, by exact method and path. */
  const PORTAL_WRITES = new Set(['POST api/v1/tenants/:tenantId/portal/inbound/asns']);

  const SESSION_GUARDS = [TenantSessionGuard, DeviceSessionGuard, AnySessionGuard, PortalSessionGuard];

  function concretePath(path: string): string {
    return `/${path.replace(/:tenantId\b/g, tenantId).replace(/:[A-Za-z]+/g, () => uuidv7())}`;
  }

  function send(method: string, path: string, token: string) {
    const agent = http();
    const verb = method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
    return agent[verb](concretePath(path)).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, ulid());
  }

  // ── the role and its invite ───────────────────────────────────────────────

  describe('the client role and its invite', () => {
    it('ROLE_CAPABILITIES.client is exactly asn.announce (21-7 made it empty; 21-7b grants the one portal write)', () => {
      expect([...ROLE_CAPABILITIES.client]).toEqual(['asn.announce']);
    });

    it('an owner invites a client user for one client brand: invited, carrying its clientId', async () => {
      const email = `invite-${ulid().toLowerCase()}@brand.example`;
      const res = await invite({ email, role: 'client', clientId: clientA }).expect(201);
      expect(res.body.user).toEqual({
        id: expect.any(String),
        email,
        role: 'client',
        status: 'invited',
        clientId: clientA,
        createdAt: expect.any(String),
      });
      // A staff invite carries clientId null.
      const staff = await invite({ email: `staff-${ulid().toLowerCase()}@example.com`, role: 'operator' }).expect(201);
      expect(staff.body.user.clientId).toBeNull();
    });

    it('refuses the bad shapes: client without clientId 400, staff with one 400, the self client 400, a foreign tenant’s 404, a suspended client 409', async () => {
      const email = () => `bad-${ulid().toLowerCase()}@brand.example`;
      expect((await invite({ email: email(), role: 'client' }).expect(400)).body.code).toBe('validation-failed');
      expect((await invite({ email: email(), role: 'operator', clientId: clientA }).expect(400)).body.code).toBe('validation-failed');
      expect((await invite({ email: email(), role: 'client', clientId: selfClient }).expect(400)).body.code).toBe('validation-failed');
      expect((await invite({ email: email(), role: 'client', clientId: foreignClient }).expect(404)).body.code).toBe('not-found');
      expect((await invite({ email: email(), role: 'client', clientId: uuidv7() }).expect(404)).body.code).toBe('not-found');
      await withClientStatus(clientC, 'suspended', async () => {
        expect((await invite({ email: email(), role: 'client', clientId: clientC }).expect(409)).body.code).toBe('client-not-active');
      });
      // Not an owner: authority first (403), before any client check.
      const ops = await staffUser('ops_manager');
      expect((await invite({ email: email(), role: 'client', clientId: foreignClient }, ulid(), ops.token).expect(403)).body.code).toBe('role-denied');
    });

    it('a committed invite replays its snapshot even after its client is suspended (the client checks sit behind the replay)', async () => {
      const key = ulid();
      const body = { email: `replay-${ulid().toLowerCase()}@brand.example`, role: 'client', clientId: clientC };
      const first = await invite(body, key).expect(201);
      await withClientStatus(clientC, 'suspended', async () => {
        const replayed = await invite(body, key).expect(201);
        expect(replayed.body).toEqual(first.body);
      });
    });

    it('a pre-21-7 invite or role-change snapshot (no clientId) replays with clientId null', async () => {
      const key = ulid();
      const body = { email: `legacy-${ulid().toLowerCase()}@example.com`, role: 'operator' };
      const first = await invite(body, key).expect(201);
      await sql`update idempotency_keys set response_snapshot = response_snapshot #- '{user,clientId}' where tenant_id = ${tenantId} and key = ${key}`;
      const stored = await sql`select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
      expect((stored[0]!.response_snapshot as { user: Record<string, unknown> }).user).not.toHaveProperty('clientId');
      const replayed = await invite(body, key).expect(201);
      expect(replayed.body).toEqual(first.body);
      expect(replayed.body.user.clientId).toBeNull();

      // The role change: same normalisation.
      const roleKey = ulid();
      const member = await staffUser('operator');
      const changed = await http()
        .patch(`${API}/${tenantId}/users/${member.userId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, roleKey)
        .send({ role: 'ops_manager' })
        .expect(200);
      await sql`update idempotency_keys set response_snapshot = response_snapshot #- '{user,clientId}' where tenant_id = ${tenantId} and key = ${roleKey}`;
      const again = await http()
        .patch(`${API}/${tenantId}/users/${member.userId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, roleKey)
        .send({ role: 'ops_manager' })
        .expect(200);
      expect(again.body).toEqual(changed.body);
      expect(again.body.clientId).toBeNull();
    });

    it('golden: a staff invite hashes byte-for-byte as before 21-7; a client invite adds clientId after role', async () => {
      // The expected bytes are WRITTEN OUT, key by key. An always-present
      // `clientId: null` (the default instinct) changes the first and fails.
      const staffEmail = `golden-${ulid().toLowerCase()}@example.com`;
      const staffKey = ulid();
      await invite({ email: staffEmail, role: 'operator' }, staffKey).expect(201);
      const clientEmail = `golden-${ulid().toLowerCase()}@brand.example`;
      const clientKey = ulid();
      await invite({ email: clientEmail, role: 'client', clientId: clientA }, clientKey).expect(201);
      const rows = await sql`select key, payload_hash from idempotency_keys where tenant_id = ${tenantId} and key in (${staffKey}, ${clientKey})`;
      const hashOf = new Map(rows.map((row) => [row.key as string, row.payload_hash as string]));
      expect(hashOf.get(staffKey)).toBe(sha256(`{"tenantId":"${tenantId}","email":"${staffEmail}","role":"operator"}`));
      expect(hashOf.get(clientKey)).toBe(sha256(`{"tenantId":"${tenantId}","email":"${clientEmail}","role":"client","clientId":"${clientA}"}`));
    });

    it('the 0065 CHECK refuses a client role without a client (the direction the migration cannot probe) and a staff role with one', async () => {
      for (const [role, clientId] of [
        ['client', null],
        ['operator', clientA],
      ] as const) {
        const error = await sql`insert into users (id, tenant_id, email, password_hash, role, status, client_id)
          values (${uuidv7()}, ${tenantId}, ${`check-${ulid().toLowerCase()}@example.com`}, 'x', ${role}, 'active', ${clientId})`.catch((err: unknown) => err);
        expect(error).toMatchObject({ code: '23514', constraint_name: 'users_client_role_pairing' });
      }
      // Meaningful: the paired shape is admitted.
      const ok = uuidv7();
      await sql`insert into users (id, tenant_id, email, password_hash, role, status, client_id)
        values (${ok}, ${tenantId}, ${`check-${ulid().toLowerCase()}@example.com`}, 'x', 'client', 'invited', ${clientA})`;
      await sql`delete from users where id = ${ok}`;
    });

    it('role changes: nobody is made a client (400), and a client user’s role never changes (400)', async () => {
      const member = await staffUser('operator');
      const toClient = await http()
        .patch(`${API}/${tenantId}/users/${member.userId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ role: 'client' })
        .expect(400);
      expect(toClient.body.code).toBe('validation-failed');
      const ofClient = await http()
        .patch(`${API}/${tenantId}/users/${portalA.userId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ role: 'operator' })
        .expect(400);
      expect(ofClient.body.code).toBe('validation-failed');
      const after = await sql`select role, client_id from users where id = ${portalA.userId}`;
      expect(after[0]).toEqual({ role: 'client', client_id: clientA });
    });

    it('the users list carries the client user with its client', async () => {
      const list = await http().get(`${API}/${tenantId}/users?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      const row = (list.body.items as { id: string }[]).find((item) => item.id === portalA.userId);
      expect(row).toEqual({ id: portalA.userId, email: portalA.email, role: 'client', status: 'active', clientId: clientA, createdAt: expect.any(String) });
    });
  });

  // ── the token ─────────────────────────────────────────────────────────────

  describe('the session token (AD-4 amended for the fence only)', () => {
    it('an operator token’s payload keys are exactly sub, tenant_id, iat, exp — byte for byte', async () => {
      expect(Object.keys(payloadOf(ownerToken))).toEqual(['sub', 'tenant_id', 'iat', 'exp']);
      const user = uuidv7();
      const token = signTenantSession(tenantId, user, 'pinned-secret-0123456789', 1_000);
      const [header, payload] = token.split('.');
      expect(Buffer.from(header!, 'base64url').toString('utf8')).toBe('{"alg":"HS256","typ":"JWT"}');
      expect(Buffer.from(payload!, 'base64url').toString('utf8')).toBe(`{"sub":"${user}","tenant_id":"${tenantId}","iat":1000,"exp":1900}`);
      const portal = signTenantSession(tenantId, user, 'pinned-secret-0123456789', 1_000, clientA);
      expect(Buffer.from(portal.split('.')[1]!, 'base64url').toString('utf8')).toBe(
        `{"sub":"${user}","tenant_id":"${tenantId}","client_id":"${clientA}","iat":1000,"exp":1900}`,
      );
    });

    it('sign-in: a portal token carries client_id; the body carries user.clientId and the client', async () => {
      const res = await http().post(`${API}/sign-in`).send({ email: portalA.email, password: PASSWORD }).expect(200);
      expect(payloadOf(res.body.accessToken as string)).toMatchObject({ sub: portalA.userId, tenant_id: tenantId, client_id: clientA });
      expect(res.body.user).toEqual({ id: portalA.userId, email: portalA.email, role: 'client', status: 'active', clientId: clientA, createdAt: expect.any(String) });
      expect(res.body.client).toEqual({ id: clientA, code: 'BRAND-A', name: 'Brand A Apparel' });
      const staff = await http().get(`${API}/${tenantId}/me`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(staff.body.user.clientId).toBeNull();
      const ownerSignIn = await http().post(`${API}/sign-in`).send({ email: (await sql`select email from users where id = ${ownerUserId}`)[0]!.email as string, password: PASSWORD }).expect(200);
      expect(ownerSignIn.body.client).toBeNull();
      expect(ownerSignIn.body.user.clientId).toBeNull();
    });

    it('odd tokens are invalid: client_id null, non-UUID or numeric, or beside device_id → 401', async () => {
      const now = Math.floor(Date.now() / 1000);
      const base = { sub: portalA.userId, tenant_id: tenantId, iat: now, exp: now + 600 };
      for (const odd of [
        { ...base, client_id: null },
        { ...base, client_id: 'not-a-uuid' },
        { ...base, client_id: 42 },
        { ...base, client_id: clientA, device_id: uuidv7() },
      ]) {
        const token = signRaw(odd);
        expect(verifyTenantSession(token, process.env.JWT_SECRET!)).toBeNull();
        expect((await portalGet('me', token).expect(401)).body.code).toBe('unauthenticated');
        expect((await http().get(`${API}/${tenantId}/me`).set('Authorization', `Bearer ${token}`).expect(401)).body.code).toBe('unauthenticated');
      }
      // The device verifier refuses any token carrying client_id.
      expect(verifyDeviceSession(signRaw({ device_id: uuidv7(), tenant_id: tenantId, sub: portalA.userId, client_id: clientA, iat: now, exp: now + 600 }), process.env.JWT_SECRET!)).toBeNull();
      // Meaningful: the well-formed shapes verify.
      expect(verifyTenantSession(signRaw({ ...base, client_id: clientA }), process.env.JWT_SECRET!)).toMatchObject({ clientId: clientA });
      expect(verifyTenantSession(signRaw(base), process.env.JWT_SECRET!)).toMatchObject({ clientId: null });
    });

    it('a suspended client: a wrong password stays 401; the right one is 403 client-suspended; a live token’s next portal call is 403 client-suspended', async () => {
      await portalGet('me').expect(200);
      await withClientStatus(clientA, 'suspended', async () => {
        expect((await http().post(`${API}/sign-in`).send({ email: portalA.email, password: 'definitely-wrong' }).expect(401)).body.code).toBe('unauthenticated');
        expect((await http().post(`${API}/sign-in`).send({ email: portalA.email, password: PASSWORD }).expect(403)).body.code).toBe('client-suspended');
        expect((await portalGet('me').expect(403)).body.code).toBe('client-suspended');
        expect((await portalGet('stock').expect(403)).body.code).toBe('client-suspended');
      });
      await portalGet('me').expect(200);
    });

    it('the portal guard re-reads its user: a user whose client changed under the token is 401', async () => {
      const user = await portalUser(clientB);
      await portalGet('me', user.token).expect(200);
      // Simulated drift (the column is immutable in code; the CHECK still
      // admits a direct SQL move between clients).
      await sql`update users set client_id = ${clientA} where id = ${user.userId}`;
      expect((await portalGet('me', user.token).expect(401)).body.code).toBe('unauthenticated');
    });
  });

  // ── the fences ────────────────────────────────────────────────────────────

  describe('the fence and the reverse fence', () => {
    it('guard coverage: every route has exactly one session guard or is allowlisted; portal routes and only they carry PortalSessionGuard', () => {
      const all = routes();
      expect(all.length).toBeGreaterThan(150);
      const offenders: string[] = [];
      for (const route of all) {
        const id = `${route.method} ${route.path}`;
        const sessionGuards = route.guards.filter((guard) => SESSION_GUARDS.includes(guard as never));
        if (UNGUARDED.has(id)) {
          if (sessionGuards.length !== 0) offenders.push(`${id}: allowlisted but guarded`);
          continue;
        }
        if (sessionGuards.length !== 1) offenders.push(`${id}: ${sessionGuards.length} session guards`);
        const isPortal = /^api\/v1\/tenants\/:tenantId\/portal\//.test(route.path);
        if (isPortal !== sessionGuards.includes(PortalSessionGuard)) offenders.push(`${id}: portal=${isPortal} but PortalSessionGuard=${!isPortal}`);
        // 21-7 decision 2 made the portal read-only; 21-7b opens EXACTLY one
        // write — the announce. Any other portal write is an offender.
        if (isPortal && route.method !== 'GET' && !PORTAL_WRITES.has(id)) offenders.push(`${id}: a portal write outside the 21-7b allowlist`);
      }
      expect(offenders).toEqual([]);
      // Every allowlisted route exists (a stale entry hides nothing).
      const declared = new Set(all.map((route) => `${route.method} ${route.path}`));
      expect([...UNGUARDED].filter((id) => !declared.has(id))).toEqual([]);
      // Every allowlisted portal write exists, too.
      expect([...PORTAL_WRITES].filter((id) => !declared.has(id))).toEqual([]);
      // 21-7's ten reads, plus 21-7b's announce and its two form reads, plus
      // 21-8's service report.
      expect(all.filter((route) => route.guards.includes(PortalSessionGuard))).toHaveLength(14);
    });

    it('a portal token is refused on EVERY operator route — reads and writes — with the exact fence detail', async () => {
      const operatorRoutes = routes().filter((route) => route.guards.includes(TenantSessionGuard));
      expect(operatorRoutes.length).toBeGreaterThan(150);
      const offenders: string[] = [];
      for (const route of operatorRoutes) {
        const res = await send(route.method, route.path, portalA.token);
        if (res.status !== 403 || res.body.code !== 'role-denied' || res.body.detail !== OPERATOR_SURFACE_DETAIL) {
          offenders.push(`${route.method} ${route.path}: ${res.status} ${res.body.code} ${res.body.detail}`);
        }
      }
      expect(offenders).toEqual([]);
      // Meaningful: the member-open reads answer an operator token.
      await http().get(`${API}/${tenantId}/me`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      await http().get(`${API}/${tenantId}/catalog/skus`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    });

    it('the AnySessionGuard web arm refuses a portal token with the fence detail; device routes refuse it as no device token', async () => {
      const anyRoutes = routes().filter((route) => route.guards.includes(AnySessionGuard));
      expect(anyRoutes).toHaveLength(3);
      for (const route of anyRoutes) {
        const res = await send(route.method, route.path, portalA.token);
        expect({ route: route.path, status: res.status, code: res.body.code, detail: res.body.detail }).toEqual({
          route: route.path,
          status: 403,
          code: 'role-denied',
          detail: OPERATOR_SURFACE_DETAIL,
        });
      }
      for (const route of routes().filter((r) => r.guards.includes(DeviceSessionGuard))) {
        const res = await send(route.method, route.path, portalA.token);
        expect({ route: route.path, status: res.status, code: res.body.code }).toEqual({ route: route.path, status: 401, code: 'unauthenticated' });
      }
    });

    it('the reverse fence: an operator token on every portal route is 403 role-denied with the portal detail', async () => {
      const operator = await staffUser('operator');
      for (const route of routes().filter((r) => r.guards.includes(PortalSessionGuard))) {
        for (const token of [ownerToken, operator.token]) {
          const res = await send(route.method, route.path, token);
          expect({ route: route.path, status: res.status, code: res.body.code, detail: res.body.detail }).toEqual({
            route: route.path,
            status: 403,
            code: 'role-denied',
            detail: PORTAL_SURFACE_DETAIL,
          });
        }
      }
    });

    it('a portal token on another tenant’s path is 403 permission-denied', async () => {
      const res = await http().get(`${API}/${uuidv7()}/portal/stock`).set('Authorization', `Bearer ${portalA.token}`).expect(403);
      expect(res.body.code).toBe('permission-denied');
    });
  });

  // ── badge-in ──────────────────────────────────────────────────────────────

  describe('badge-in', () => {
    it('a client user: wrong PIN 401 badge-invalid, right PIN 403 role-denied — and the device stays unbound', async () => {
      const minted = await http()
        .post(`${API}/${tenantId}/devices/enrollment-codes`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(201);
      const enrolled = await http()
        .post(`${API}/${tenantId}/devices/enroll`)
        .set(KEY_HEADER, ulid())
        .send({ code: minted.body.code, label: 'Portal dock', pin: '2468' })
        .expect(201);
      const deviceToken = enrolled.body.deviceToken as string;
      const deviceId = enrolled.body.device.id as string;
      const badge = (pin: string, email = portalA.email) =>
        http().post(`${API}/${tenantId}/devices/badge-in`).set('Authorization', `Bearer ${deviceToken}`).send({ operatorEmail: email, pin });
      expect((await badge('1111').expect(401)).body.code).toBe('badge-invalid');
      const refused = await badge('2468').expect(403);
      expect(refused.body.code).toBe('role-denied');
      const row = await sql`select operator_user_id from devices where id = ${deviceId}`;
      expect(row[0]!.operator_user_id).toBeNull();
      // Meaningful: a floor role binds the same device.
      const operator = await staffUser('operator');
      const ok = await badge('2468', operator.email).expect(200);
      expect(ok.body.operator.role).toBe('operator');
      // Since 21-7 the families are exclusive both ways: the badge-in session
      // token no longer opens an operator (TenantSessionGuard) web route.
      const badgeSession = ok.body.accessToken as string;
      expect((await http().get(`${API}/${tenantId}/me`).set('Authorization', `Bearer ${badgeSession}`).expect(401)).body.code).toBe('unauthenticated');
      expect((await http().get(`${API}/${tenantId}/catalog/skus`).set('Authorization', `Bearer ${badgeSession}`).expect(401)).body.code).toBe('unauthenticated');
    });
  });

  // ── the reads ─────────────────────────────────────────────────────────────

  describe('the portal reads (exact keys, isolation)', () => {
    it('portal/me', async () => {
      const res = await portalGet('me').expect(200);
      expect(res.body).toEqual({
        user: { id: portalA.userId, email: portalA.email, role: 'client', status: 'active', clientId: clientA },
        client: { id: clientA, code: 'BRAND-A', name: 'Brand A Apparel' },
      });
    });

    it('stock: one row per (SKU, warehouse) — every bin summed, the shared bin never leaking, the allocated-only row listed, never a bin', async () => {
      const res = await portalGet('stock').expect(200);
      expect(res.body).toEqual({
        items: [
          { skuId: sku.get('A-1'), skuCode: 'A-1', skuName: 'Alpha tee', baseUom: 'each', warehouseId: wh1, warehouseName: 'Portal Main', onHand: 10, allocated: 2 },
          { skuId: sku.get('A-2'), skuCode: 'A-2', skuName: 'Alpha cap', baseUom: 'each', warehouseId: wh1, warehouseName: 'Portal Main', onHand: 0, allocated: 5 },
        ],
        nextCursor: null,
      });
      const b = await portalGet('stock', portalB.token).expect(200);
      expect(b.body).toEqual({
        items: [{ skuId: sku.get('B-1'), skuCode: 'B-1', skuName: 'Beta serum', baseUom: 'each', warehouseId: wh1, warehouseName: 'Portal Main', onHand: 7, allocated: 1 }],
        nextCursor: null,
      });
      expect(JSON.stringify(res.body)).not.toContain(bin1);
      expect(JSON.stringify(res.body)).not.toContain('A-01-0');
    });

    it('stock pages by (skuCode, warehouseId); a bad cursor is 400; limit bounds', async () => {
      const first = await portalGet('stock?limit=1').expect(200);
      expect(first.body.items.map((row: { skuCode: string }) => row.skuCode)).toEqual(['A-1']);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await portalGet(`stock?limit=1&cursor=${first.body.nextCursor as string}`).expect(200);
      expect(second.body.items.map((row: { skuCode: string }) => row.skuCode)).toEqual(['A-2']);
      expect(second.body.nextCursor).toBeNull();
      expect((await portalGet('stock?cursor=garbage').expect(400)).body.code).toBe('invalid-cursor');
      const crafted = Buffer.from(JSON.stringify({ skuCode: 'A-1', warehouseId: 'nope' })).toString('base64url');
      expect((await portalGet(`stock?cursor=${crafted}`).expect(400)).body.code).toBe('invalid-cursor');
      await portalGet('stock?limit=0').expect(400);
      await portalGet('stock?limit=101').expect(400);
      await portalGet('stock?limit=100').expect(200);
    });

    it('orders: only this client’s, newest first, exact keys; a kit counts once', async () => {
      const res = await portalGet('orders').expect(200);
      const row = (id: string, lineCount: number) => ({
        id,
        status: 'accepted',
        source: 'manual',
        externalRef: null,
        warehouseName: 'Portal Main',
        destinationName: 'Priya Sharma',
        destinationCity: 'Bengaluru',
        destinationPincode: '560066',
        lineCount,
        createdAt: expect.any(String),
      });
      expect(res.body).toEqual({ items: [row(ids.orderKit, 1), row(ids.orderA1, 1)], nextCursor: null });
      const b = await portalGet('orders', portalB.token).expect(200);
      expect(b.body.items.map((o: { id: string }) => o.id)).toEqual([ids.orderB]);
      expect((await portalGet('orders?status=dispatched').expect(200)).body).toEqual({ items: [], nextCursor: null });
      expect((await portalGet('orders?status=bogus').expect(400)).body.code).toBe('validation-failed');
    });

    it('order detail: lines with kit components nested; another client’s order is 404; a malformed id 400', async () => {
      const kit = await portalGet(`orders/${ids.orderKit}`).expect(200);
      expect(kit.body).toEqual({
        id: ids.orderKit,
        status: 'accepted',
        source: 'manual',
        externalRef: null,
        warehouseName: 'Portal Main',
        destinationName: 'Priya Sharma',
        destinationCity: 'Bengaluru',
        destinationPincode: '560066',
        lineCount: 1,
        createdAt: expect.any(String),
        lines: [
          {
            skuCode: 'A-KIT',
            skuName: 'Alpha bundle',
            qty: 1,
            components: [
              { skuCode: 'A-C1', skuName: 'Alpha sock', qty: 1 },
              { skuCode: 'A-C2', skuName: 'Alpha band', qty: 2 },
            ],
          },
        ],
      });
      const plain = await portalGet(`orders/${ids.orderA1}`).expect(200);
      expect(plain.body.lines).toEqual([{ skuCode: 'A-1', skuName: 'Alpha tee', qty: 2, components: [] }]);
      expect((await portalGet(`orders/${ids.orderB}`).expect(404)).body.code).toBe('not-found');
      expect((await portalGet(`orders/${uuidv7()}`).expect(404)).body.code).toBe('not-found');
      expect((await portalGet('orders/not-a-uuid').expect(400)).body.code).toBe('validation-failed');
    });

    it('orders page across EQUAL timestamps (the full-precision keyset); a bad cursor is 400', async () => {
      await sql`update orders set created_at = '2026-10-01T10:00:00.123456Z' where id in (${ids.orderA1}, ${ids.orderKit})`;
      try {
        const first = await portalGet('orders?limit=1').expect(200);
        expect(first.body.items).toHaveLength(1);
        const second = await portalGet(`orders?limit=1&cursor=${first.body.nextCursor as string}`).expect(200);
        expect(second.body.items).toHaveLength(1);
        expect(second.body.nextCursor).toBeNull();
        expect(new Set([first.body.items[0].id, second.body.items[0].id])).toEqual(new Set([ids.orderA1, ids.orderKit]));
      } finally {
        await sql`update orders set created_at = now() where id in (${ids.orderA1}, ${ids.orderKit})`;
      }
      expect((await portalGet('orders?cursor=garbage').expect(400)).body.code).toBe('invalid-cursor');
    });

    it('ASNs: list and detail, exact keys; another client’s ASN is 404', async () => {
      const list = await portalGet('inbound/asns').expect(200);
      const row = {
        id: ids.asnA,
        code: 'ASN-A-1',
        status: 'announced',
        expectedAt: '2026-10-20T04:30:00.000Z',
        warehouseName: 'Portal Main',
        lineCount: 2,
        announcedTotal: 8,
        receivedTotal: 0,
        createdAt: expect.any(String),
      };
      expect(list.body).toEqual({ items: [row], nextCursor: null });
      const detail = await portalGet(`inbound/asns/${ids.asnA}`).expect(200);
      expect(detail.body).toEqual({
        ...row,
        lines: [
          { skuCode: 'A-1', skuName: 'Alpha tee', announcedQty: 5, receivedQty: 0 },
          { skuCode: 'A-2', skuName: 'Alpha cap', announcedQty: 3, receivedQty: 0 },
        ],
      });
      expect((await portalGet(`inbound/asns/${ids.asnB}`).expect(404)).body.code).toBe('not-found');
      expect((await portalGet('inbound/asns/not-a-uuid').expect(400)).body.code).toBe('validation-failed');
      expect((await portalGet('inbound/asns?status=received').expect(200)).body.items).toEqual([]);
      await portalGet('inbound/asns?status=bogus').expect(400);
      expect((await portalGet('inbound/asns', portalB.token).expect(200)).body.items.map((a: { id: string }) => a.id)).toEqual([ids.asnB]);
    });

    it('purchase orders: list and detail, exact keys (no vendor, no cost); another client’s PO is 404', async () => {
      const list = await portalGet('inbound/purchase-orders').expect(200);
      const row = {
        id: ids.poA,
        code: 'PO-A-1',
        status: 'open',
        warehouseName: 'Portal Main',
        lineCount: 1,
        orderedTotal: 3,
        receivedTotal: 0,
        createdAt: expect.any(String),
      };
      expect(list.body).toEqual({ items: [row], nextCursor: null });
      const detail = await portalGet(`inbound/purchase-orders/${ids.poA}`).expect(200);
      expect(detail.body).toEqual({ ...row, lines: [{ skuCode: 'A-1', skuName: 'Alpha tee', orderedQty: 3, receivedQty: 0, expectedDate: null }] });
      expect(JSON.stringify(detail.body)).not.toContain('12345');
      expect((await portalGet(`inbound/purchase-orders/${ids.poB}`).expect(404)).body.code).toBe('not-found');
      expect((await portalGet('inbound/purchase-orders/not-a-uuid').expect(400)).body.code).toBe('validation-failed');
      await portalGet('inbound/purchase-orders?status=bogus').expect(400);
    });

    it('invoices: issued and void, never the draft; exact keys (no note, gaps, warnings, card or client id)', async () => {
      const list = await portalGet('invoices').expect(200);
      const row = (id: string, status: string, invoiceNo: string, periodStart: string, periodEnd: string) => ({
        id,
        invoiceNo,
        fyLabel: 'FY-2627',
        periodStart,
        periodEnd,
        status,
        issuedAt: '2026-10-02T05:00:00.000Z',
        replacesInvoiceId: null,
        placeOfSupply: '29',
        supplyType: 'intra',
        totals: { subtotal: 3000, cgst: 270, sgst: 270, igst: 0, tax: 540, roundOff: -40, payable: 3500 },
      });
      // Seeded issued (Aug) BEFORE void (Jul): newest-created first.
      expect(list.body).toEqual({
        items: [row(ids.invoiceAVoid, 'void', '29/S2627/000002', '2026-07-01', '2026-07-31'), row(ids.invoiceAIssued, 'issued', '29/S2627/000001', '2026-08-01', '2026-08-31')],
        nextCursor: null,
      });
      const detail = await portalGet(`invoices/${ids.invoiceAIssued}`).expect(200);
      expect(detail.body).toEqual({
        ...row(ids.invoiceAIssued, 'issued', '29/S2627/000001', '2026-08-01', '2026-08-31'),
        party: {
          supplier: {
            name: 'Portal 3PL',
            gstin: '29ABCDE1234F1Z5',
            stateCode: '29',
            stateName: 'Karnataka',
            address: { line1: '12, Peenya', line2: null, city: 'Bengaluru', state: 'Karnataka', pincode: '560066' },
          },
          recipient: {
            name: 'Brand A Apparel',
            legalName: 'Brand A Apparel Pvt Ltd',
            gstin: '29AAACA1111A1Z1',
            stateCode: '29',
            stateName: 'Karnataka',
            address: { line1: '1 MG Road', line2: null, city: 'Bengaluru', stateCode: '29', pincode: '560001' },
          },
        },
        lines: [
          {
            segmentFrom: '2026-08-01',
            segmentTo: '2026-08-31',
            chargeCode: 'pick',
            basis: 'per_pick',
            uom: null,
            quantity: '10',
            unitAmountPaise: 300,
            amountPaise: 3000,
            sac: '996719',
            gstBps: 1800,
            cgstPaise: 270,
            sgstPaise: 270,
            igstPaise: 0,
          },
        ],
      });
      const voided = await portalGet(`invoices/${ids.invoiceAVoid}`).expect(200);
      expect(voided.body).not.toHaveProperty('statusNote');
      expect(JSON.stringify(voided.body)).not.toContain('operator-written');
      expect(JSON.stringify(voided.body)).not.toContain('operator-only-warning');
      expect((await portalGet(`invoices/${ids.invoiceADraft}`).expect(404)).body.code).toBe('not-found');
      expect((await portalGet(`invoices/${ids.invoiceBIssued}`).expect(404)).body.code).toBe('not-found');
      expect((await portalGet('invoices/not-a-uuid').expect(404)).body.code).toBe('not-found');
      expect((await portalGet('invoices', portalB.token).expect(200)).body.items.map((i: { id: string }) => i.id)).toEqual([ids.invoiceBIssued]);
    });

    it('invoices page across equal timestamps; a bad cursor is 400; limit bounds', async () => {
      // An issued invoice is frozen by its guard trigger; the fixture steps
      // past it (replica role, this transaction only) to tie the timestamps.
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update client_invoices set created_at = '2026-10-01T10:00:00.654321Z' where id in (${ids.invoiceAIssued}, ${ids.invoiceAVoid}, ${ids.invoiceADraft})`;
      });
      const tied = await sql`select count(distinct created_at)::int as n from client_invoices where id in (${ids.invoiceAIssued}, ${ids.invoiceAVoid})`;
      expect(tied[0]!.n).toBe(1);
      const first = await portalGet('invoices?limit=1').expect(200);
      expect(first.body.items).toHaveLength(1);
      const second = await portalGet(`invoices?limit=1&cursor=${first.body.nextCursor as string}`).expect(200);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.nextCursor).toBeNull();
      expect(new Set([first.body.items[0].id, second.body.items[0].id])).toEqual(new Set([ids.invoiceAIssued, ids.invoiceAVoid]));
      expect((await portalGet('invoices?cursor=garbage').expect(400)).body.code).toBe('invalid-cursor');
      await portalGet('invoices?limit=0').expect(400);
      await portalGet('invoices?limit=101').expect(400);
    });

    it('invoice detail: a storage line reads its milli-unit-days as a decimal string, and lines come back in the canonical order', async () => {
      // June: three lines inserted OUT of canonical order — a late-segment
      // pick, an early pick, an early storage line. Canonical: by segment
      // start, then charge (storage before pick).
      const id = uuidv7();
      const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d) - 19_800_000).toISOString();
      await sql`insert into client_invoices (id, tenant_id, client_id, period_start, period_end, status, supplier_gstin,
          place_of_supply, supply_type, subtotal_paise, cgst_paise, sgst_paise, igst_paise, tax_paise, total_paise,
          round_off_paise, payable_paise, gaps, warnings, party, content_hash, created_by)
        values (${id}, ${tenantId}, ${clientA}, '2026-06-01', '2026-06-30', 'draft', '29ABCDE1234F1Z5',
          '29', 'intra', 3500, 315, 315, 0, 630, 4130, -30, 4100, '[]'::jsonb, '[]'::jsonb, ${sql.json(PARTY)}, 'seed', ${ownerUserId})`;
      for (const [charge, basis, uom, quantity, unit, amount, tax, from, to] of [
        ['pick', 'per_pick', null, 10, 100, 1000, 90, at(2026, 6, 16), at(2026, 7, 1)],
        ['pick', 'per_pick', null, 20, 100, 2000, 180, at(2026, 6, 1), at(2026, 6, 16)],
        ['storage', 'per_thousand_units_per_day', 'each', 12_500, 40, 500, 45, at(2026, 6, 1), at(2026, 6, 16)],
      ] as const) {
        await sql`insert into client_invoice_lines (id, tenant_id, invoice_id, rate_card_id, segment_from, segment_to, charge_code, basis,
            uom, quantity, unit_amount_paise, amount_paise, sac_code, gst_bps, place_of_supply, supply_type, cgst_paise, sgst_paise, igst_paise)
          values (${uuidv7()}, ${tenantId}, ${id}, ${uuidv7()}, ${from}, ${to}, ${charge}, ${basis},
            ${uom}, ${quantity}, ${unit}, ${amount}, ${charge === 'storage' ? '996729' : '996719'}, 1800, '29', 'intra', ${tax}, ${tax}, 0)`;
      }
      await sql`update client_invoices set status = 'issued', invoice_no = '29/S2627/000009', fy_label = 'FY-2627', series_seq = 9,
          issued_at = '2026-07-02T05:00:00.000Z', issued_by = ${ownerUserId} where id = ${id}`;
      const detail = await portalGet(`invoices/${id}`).expect(200);
      expect(
        (detail.body.lines as { segmentFrom: string; segmentTo: string; chargeCode: string; uom: string | null; quantity: string }[]).map((line) => [
          line.segmentFrom,
          line.segmentTo,
          line.chargeCode,
          line.uom,
          line.quantity,
        ]),
      ).toEqual([
        ['2026-06-01', '2026-06-15', 'storage', 'each', '12.5'],
        ['2026-06-01', '2026-06-15', 'pick', null, '20'],
        ['2026-06-16', '2026-06-30', 'pick', null, '10'],
      ]);
      expect(detail.body.lines[0]).toEqual({
        segmentFrom: '2026-06-01',
        segmentTo: '2026-06-15',
        chargeCode: 'storage',
        basis: 'per_thousand_units_per_day',
        uom: 'each',
        quantity: '12.5',
        unitAmountPaise: 40,
        amountPaise: 500,
        sac: '996729',
        gstBps: 1800,
        cgstPaise: 45,
        sgstPaise: 45,
        igstPaise: 0,
      });
    });

    it('ASNs and POs page across EQUAL timestamps (both pages, no repeat); a bad cursor is 400; a status that excludes the rows is []', async () => {
      const asn2 = (
        await http()
          .post(`${API}/${tenantId}/inbound/asns`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ clientId: clientA, warehouseId: wh1, asnCode: 'ASN-A-2', lines: [{ skuId: sku.get('A-1')!, announcedQty: 1 }] })
          .expect(201)
      ).body.asn.id as string;
      const po2 = await createPo('PO-A-2', [{ skuId: sku.get('A-2')!, orderedQty: 1, unitCostPaise: 100 }]);
      await sql`update advance_shipment_notices set created_at = '2026-10-01T10:00:00.111111Z' where id in (${ids.asnA}, ${asn2})`;
      await sql`update purchase_orders set created_at = '2026-10-01T10:00:00.222222Z' where id in (${ids.poA}, ${po2})`;
      for (const [path, expected] of [
        ['inbound/asns', [ids.asnA, asn2]],
        ['inbound/purchase-orders', [ids.poA, po2]],
      ] as const) {
        const first = await portalGet(`${path}?limit=1`).expect(200);
        expect(first.body.items).toHaveLength(1);
        expect(first.body.nextCursor).toEqual(expect.any(String));
        const second = await portalGet(`${path}?limit=1&cursor=${first.body.nextCursor as string}`).expect(200);
        expect(second.body.items).toHaveLength(1);
        expect(second.body.nextCursor).toBeNull();
        const seen = [first.body.items[0].id as string, second.body.items[0].id as string];
        expect(seen[0]).not.toBe(seen[1]);
        expect(new Set(seen)).toEqual(new Set(expected));
        expect((await portalGet(`${path}?cursor=garbage`).expect(400)).body.code).toBe('invalid-cursor');
      }
      expect((await portalGet('inbound/purchase-orders?status=closed').expect(200)).body).toEqual({ items: [], nextCursor: null });
      expect((await portalGet('inbound/purchase-orders?status=open').expect(200)).body.items).toHaveLength(2);
    });

    it('the portal routes are in the OpenAPI document', async () => {
      const doc = await http().get('/api/v1/openapi.json').expect(200);
      const paths = Object.keys(doc.body.paths as Record<string, unknown>).filter((path) => path.includes('/portal/'));
      expect(paths.sort()).toEqual(
        [
          '/tenants/{tenantId}/portal/inbound/asns',
          '/tenants/{tenantId}/portal/inbound/asns/{asnId}',
          '/tenants/{tenantId}/portal/inbound/purchase-orders',
          '/tenants/{tenantId}/portal/inbound/purchase-orders/{poId}',
          '/tenants/{tenantId}/portal/invoices',
          '/tenants/{tenantId}/portal/invoices/{invoiceId}',
          '/tenants/{tenantId}/portal/me',
          '/tenants/{tenantId}/portal/orders',
          '/tenants/{tenantId}/portal/orders/{orderId}',
          '/tenants/{tenantId}/portal/service',
          '/tenants/{tenantId}/portal/skus',
          '/tenants/{tenantId}/portal/stock',
          '/tenants/{tenantId}/portal/warehouses',
        ].sort(),
      );
    });
  });
});
