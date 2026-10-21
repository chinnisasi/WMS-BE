import { type INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { sql as dsql } from 'drizzle-orm';
import { createApp } from '../src/app.factory';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import type { Database } from '../src/shared/db/db';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { CLIENT_CONTACT_ROLES, ADJUSTMENT_PENDING_STATUSES, COUNT_TASK_STATUSES, COUNT_VARIANCE_STATUSES, REJECTED_OP_STATUSES } from '../src/shared/db/schema';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { assertClientTakesWorkInTx, lockClientInTx } from '../src/modules/clients/clients.facade';
import { ChannelsIngestCommand } from '../src/modules/channels/channels.ingest.command';
import { ReplenishmentSweep } from '../src/modules/replenishment/replenishment.sweep';
import { ORDER_STATUSES } from '../src/modules/outbound/order.command';
import { OPEN_ASN_STATUSES } from '../src/modules/inbound/asn.command';
import { PO_STATUSES } from '../src/modules/inbound/po.command';
import { RECEIVABLE_RMA_STATUSES } from '../src/modules/returns/return-receipt.command';
import { CLIENT_INVOICE_STATUSES } from '../src/modules/billing/client-invoices';
import { ORDER_OPEN_STATUSES } from '../src/modules/outbound/client-wind-down';
import { ASN_OPEN_STATUSES, OVER_RECEIPT_PENDING_STATUSES, PO_OPEN_STATUSES } from '../src/modules/inbound/client-wind-down';
import { RMA_OPEN_STATUSES } from '../src/modules/returns/client-wind-down';
import { CLIENT_INVOICE_UNSETTLED_STATUSES } from '../src/modules/billing/client-wind-down';
import { REJECTED_OP_OPEN_STATUSES, SKU_NAMING_OP_TYPES } from '../src/modules/tenancy/client-wind-down';
import { REJECTED_OP_DECISIONS_BY_TYPE } from '../src/modules/tenancy/sync-report.command';
import {
  ADJUSTMENT_PENDING_OPEN_STATUSES,
  COUNT_TASK_OPEN_STATUSES,
  COUNT_VARIANCE_OPEN_STATUSES,
} from '../src/modules/inventory/client-wind-down';
import { WIND_DOWN_BLOCKER_KINDS } from '../src/shared/primitives/wind-down';
import { REJECTED_GRN_LINE_CODES } from '../src/modules/inbound/receiving.command';
import { ASN_IMPORT_ROW_ERROR_CODES } from '../src/modules/inbound/asn-import.parse';
import { SESSION_REVOKE_REASONS } from '../src/modules/tenancy/sessions';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey, seededIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { createLinkedVendor, linkVendor } from './support/linked-vendor';

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
/** The advisory key every suite uses to serialize wms_rls_probe role setup. */
const PROBE_LOCK = 742105;

jest.setTimeout(120_000);

/**
 * Story 1-2a — the client master record: contacts, the registered and return
 * addresses, and departure (offboarding) with its wind-down check and the
 * "no new work" gate. Every row of the spec's I/O matrix has a test here;
 * the transitions the 21-10 suite already pinned stay in test/clients.spec.ts.
 */
describe('story 1-2a: the client master record', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;

  let tenantId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let opsToken: string;
  let accountantToken: string;
  let operatorWebToken: string;
  let deviceOperatorToken: string;
  let warehouseId: string;
  let zoneId: string;
  let binA: string;
  let vendorId: string;
  let selfClientId: string;
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const at = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  function expectProblem(res: request.Response, status: number, code: string): void {
    expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
  }

  async function invite(role: string): Promise<{ email: string; token: string }> {
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
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    return { email, token: (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string };
  }

  async function portalUser(clientId: string): Promise<{ email: string; token: string }> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role: 'client', clientId })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    return { email, token: (await signIn(email).expect(200)).body.accessToken as string };
  }

  function signIn(email: string): SupertestTest {
    return http().post(`${API}/sign-in`).send({ email, password: PASSWORD });
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
    // Story 1-3 — a PO's vendor must be linked to its client: the suite's vendor trades with every client it creates.
    if (vendorId !== undefined) await linkVendor(app, tenantId, ownerToken, vendorId, id);
    return id;
  }

  function importCsv(csvRows: string[], clientId: string, token = ownerToken): SupertestTest {
    const csv = ['sku_code,name,uom,gst_rate,product,variant_values,kit_components', ...csvRows].join('\n');
    return http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' });
  }

  async function refreshSkus(): Promise<void> {
    const list = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of list.body.items as { code: string; id: string }[]) skuIds.set(item.code, item.id);
  }

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  function setStatus(clientId: string, status: string, key = ulid(), token = ownerToken): SupertestTest {
    return http()
      .patch(`${API}/${tenantId}/clients/${clientId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ status });
  }

  function createOrder(lines: { skuId: string; quantity: number }[], key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, lines, destination: testAddress() });
  }

  function createPo(lines: { skuId: string; orderedQty: number }[], code = `PO-${ulid().slice(10, 18)}`): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, vendorId, code, lines: lines.map((line) => ({ ...line, unitCostPaise: 1000 })) });
  }

  function createAsn(clientId: string, lines: { skuId: string; announcedQty: number }[], asnCode = `ASN-${ulid().slice(12, 20)}`): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inbound/asns`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ clientId, warehouseId, asnCode, lines });
  }

  function adjust(skuId: string, quantityDelta: number, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, skuId, binId: binA, quantityDelta, reasonCode: 'stock-count', note: 'client-master seed' });
  }

  function receive(body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, occurredAt: at(), ...body });
  }

  const grnLine = (skuId: string, qty: number, extra: Record<string, unknown> = {}) => ({
    skuId,
    batchCode: null,
    mfgDate: null,
    qty,
    ...extra,
  });

  // ── contacts / addresses helpers ────────────────────────────────────────
  function addContact(clientId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/clients/${clientId}/contacts`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function editContact(clientId: string, contactId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken): SupertestTest {
    return http()
      .patch(`${API}/${tenantId}/clients/${clientId}/contacts/${contactId}`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function removeContact(clientId: string, contactId: string, key = ulid()): SupertestTest {
    return http()
      .delete(`${API}/${tenantId}/clients/${clientId}/contacts/${contactId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key);
  }

  function listContacts(clientId: string, token = ownerToken): SupertestTest {
    return http().get(`${API}/${tenantId}/clients/${clientId}/contacts`).set('Authorization', `Bearer ${token}`);
  }

  function setAddresses(clientId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken): SupertestTest {
    return http()
      .patch(`${API}/${tenantId}/clients/${clientId}/addresses`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function primaries(clientId: string): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`select id from client_contacts where client_id = ${clientId} and is_primary`;
    return rows.map((row) => row.id);
  }

  async function keyStored(key: string): Promise<boolean> {
    return (await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).length > 0;
  }

  const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

  /** The tenant's one shopify connection (one per provider per tenant), made on first use. */
  async function shopifyIntegration(): Promise<string> {
    const existing = await sql<{ id: string }[]>`select id from integrations where tenant_id = ${tenantId} and provider = 'shopify'`;
    if (existing[0] !== undefined) return existing[0].id;
    const id = uuidv7();
    await sql`insert into integrations (id, tenant_id, provider, status, connected_by, ingest_warehouse_id)
      values (${id}, ${tenantId}, 'shopify', 'connected', ${ownerUserId}, ${warehouseId})`;
    return id;
  }

  /** Wait until `min` sessions are parked on a `clients` row lock (the 21-10 waiter shape). */
  async function waitParkedOnClients(lockClause: string, min: number): Promise<void> {
    const probe = handle();
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = await probe`
          select a.pid from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active'
            and a.query ilike ${'%"clients"%'} and a.query ilike ${`%${lockClause}%`}`;
        if (waiting.length >= min) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`fewer than ${min} request(s) parked on the clients row (${lockClause})`);
    } finally {
      await probe.end();
    }
  }

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('client_master');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4 });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Client Master Co ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
    ownerUserId = (await sql<{ id: string }[]>`select id from users where tenant_id = ${tenantId} and role = 'owner'`)[0]!.id;
    opsToken = (await invite('ops_manager')).token;
    accountantToken = (await invite('accountant')).token;
    const operator = await invite('operator');
    operatorWebToken = operator.token;

    warehouseId = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `CM-${ulid().slice(10, 16)}`, name: 'Client Master WH' })
        .expect(201)
    ).body.id as string;
    zoneId = (
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
        .send({ capacity: 100000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;
    vendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: 'VEND-CM', name: 'Client Master Vendor' });

    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Client master scanner', pin: '2468' })
      .expect(201);
    deviceOperatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: operator.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClientId = clients.body.items[0].id as string;
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
  // Vocabularies — the three mirrored layers stay in step.
  // ──────────────────────────────────────────────────────────────────────────
  describe('vocabularies', () => {
    async function constraintDef(name: string): Promise<string> {
      const rows = await sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`;
      return rows[0]!.def;
    }

    it('the roles CHECK names exactly CLIENT_CONTACT_ROLES', async () => {
      const def = await constraintDef('client_contacts_roles_check');
      const literals = [...def.matchAll(/'([a-z]+)'::text/g)].map((match) => match[1]!);
      expect([...new Set(literals)].sort()).toEqual([...CLIENT_CONTACT_ROLES].sort());
    });

    it('the wind-down status lists are subsets of (or equal to) the owners’ vocabularies', () => {
      expect(ORDER_OPEN_STATUSES.every((status) => (ORDER_STATUSES as readonly string[]).includes(status))).toBe(true);
      expect([...ORDER_OPEN_STATUSES]).toEqual(['accepted', 'ready_to_dispatch']);
      expect([...ASN_OPEN_STATUSES]).toEqual([...OPEN_ASN_STATUSES]);
      expect(PO_OPEN_STATUSES.every((status) => (PO_STATUSES as readonly string[]).includes(status))).toBe(true);
      expect([...RMA_OPEN_STATUSES]).toEqual([...RECEIVABLE_RMA_STATUSES]);
      expect(CLIENT_INVOICE_UNSETTLED_STATUSES.every((status) => (CLIENT_INVOICE_STATUSES as readonly string[]).includes(status))).toBe(true);
      expect(ADJUSTMENT_PENDING_OPEN_STATUSES.every((status) => (ADJUSTMENT_PENDING_STATUSES as readonly string[]).includes(status))).toBe(true);
      expect(COUNT_TASK_OPEN_STATUSES.every((status) => (COUNT_TASK_STATUSES as readonly string[]).includes(status))).toBe(true);
      expect(COUNT_VARIANCE_OPEN_STATUSES.every((status) => (COUNT_VARIANCE_STATUSES as readonly string[]).includes(status))).toBe(true);
      expect(REJECTED_OP_OPEN_STATUSES.every((status) => (REJECTED_OP_STATUSES as readonly string[]).includes(status))).toBe(true);
      expect(OVER_RECEIPT_PENDING_STATUSES).toEqual(['pending']);
      // Decision 8 — an issued invoice not yet settled also blocks departure.
      expect([...CLIENT_INVOICE_UNSETTLED_STATUSES]).toEqual(['draft', 'issued', 'disputed']);
      // The review-item read covers every SKU-naming op type the queue holds.
      const opTypes = Object.keys(REJECTED_OP_DECISIONS_BY_TYPE);
      expect(SKU_NAMING_OP_TYPES.every((type) => opTypes.includes(type))).toBe(true);
      // Story 1-6d — the licence-refused row names its SKUs too.
      expect(SKU_NAMING_OP_TYPES).toContain('grn.licence-refused');
      // Story 2-3a — the gate-in unload names no SKU (a vehicle visit
      // carries several clients' goods), so it is outside the wind-down read
      // by design (`client-wind-down.ts` untouched).
      expect(opTypes.filter((type) => !(SKU_NAMING_OP_TYPES as readonly string[]).includes(type)).sort()).toEqual([
        'excursion.record',
        'gate-in.unload',
        'transfer.confirm',
      ]);
    });

    it('the refusal vocabularies carry client-departed', () => {
      expect(REJECTED_GRN_LINE_CODES).toContain('client-departed');
      expect(ASN_IMPORT_ROW_ERROR_CODES).toContain('client-departed');
      expect(SESSION_REVOKE_REASONS).toContain('client-departed');
    });

    it('OpenAPI lists the new routes and the departed target', async () => {
      const doc = await http().get('/api/v1/openapi.json').expect(200);
      const paths = Object.keys(doc.body.paths as Record<string, unknown>);
      expect(paths).toEqual(
        expect.arrayContaining([
          '/tenants/{tenantId}/clients/{clientId}/contacts',
          '/tenants/{tenantId}/clients/{clientId}/contacts/{contactId}',
          '/tenants/{tenantId}/clients/{clientId}/addresses',
        ]),
      );
      const status = doc.body.components.schemas.UpdateClientStatusDto.properties.status;
      expect(status.enum).toEqual(['active', 'suspended', 'departed']);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Contacts
  // ──────────────────────────────────────────────────────────────────────────
  describe('contacts', () => {
    let acmeId: string;
    let asha: string;
    let ravi: string;

    beforeAll(async () => {
      acmeId = await createClient('ACME');
    });

    it('the first contact becomes primary; email stored lower-cased, roles in vocabulary order; audited client.contact_added; a replay writes nothing', async () => {
      const key = ulid();
      const res = await addContact(acmeId, { name: ' Asha Rao ', email: ' Asha@Acme.Example ', phone: ' +91 98200 00001 ', roles: ['returns', 'operations'] }, key).expect(201);
      expect(res.body.contact).toMatchObject({
        clientId: acmeId,
        name: 'Asha Rao',
        email: 'asha@acme.example',
        phone: '+91 98200 00001',
        roles: ['operations', 'returns'],
        isPrimary: true,
      });
      asha = res.body.contact.id as string;
      await expectAuditRow({ tenantId, key, action: 'client.contact_added', targetType: 'client', targetId: acmeId, actorUserId: ownerUserId });
      const replay = await addContact(acmeId, { name: 'Asha Rao', email: 'asha@acme.example', phone: '+91 98200 00001', roles: ['operations', 'returns'] }, key).expect(201);
      expect(replay.body).toEqual(res.body);
      await expectAuditRow({ tenantId, key, action: 'client.contact_added', targetType: 'client', targetId: acmeId, actorUserId: ownerUserId });

      const second = await addContact(acmeId, { name: 'Ravi', email: 'ravi@acme.example' }).expect(201);
      expect(second.body.contact).toMatchObject({ isPrimary: false, phone: null, roles: [] });
      ravi = second.body.contact.id as string;
    });

    it('any staff session reads the list (primary first, then by name); a portal session is refused; the clients list carries no contacts', async () => {
      await addContact(acmeId, { name: 'Aarti', email: 'aarti@acme.example', roles: ['billing'] }).expect(201);
      for (const token of [ownerToken, opsToken, accountantToken, operatorWebToken]) {
        const res = await listContacts(acmeId, token).expect(200);
        expect((res.body.items as { name: string }[]).map((item) => item.name)).toEqual(['Asha Rao', 'Aarti', 'Ravi']);
      }
      const portal = await portalUser(acmeId);
      expectProblem(await listContacts(acmeId, portal.token), 403, 'role-denied');
      const list = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      const acme = (list.body.items as Record<string, unknown>[]).find((item) => item.id === acmeId)!;
      expect(Object.keys(acme)).not.toContain('contacts');
      expectProblem(await listContacts(uuidv7()), 404, 'not-found');
      expectProblem(await listContacts('not-a-uuid'), 400, 'validation-failed');
    });

    it('writes need clients.manage (owner only)', async () => {
      for (const token of [opsToken, accountantToken, operatorWebToken]) {
        expectProblem(await addContact(acmeId, { name: 'X', email: 'x@acme.example' }, ulid(), token), 403, 'role-denied');
        expectProblem(await editContact(acmeId, ravi, { name: 'X' }, ulid(), token), 403, 'role-denied');
      }
    });

    it('validation answers 400 naming the field; a duplicate email in another case is 409 duplicate-contact-email', async () => {
      expectProblem(await addContact(acmeId, { name: 'Bad', email: 'not-an-email' }), 400, 'validation-failed');
      expectProblem(await addContact(acmeId, { name: '   ', email: 'blank@acme.example' }), 400, 'validation-failed');
      expectProblem(await addContact(acmeId, { name: 'Long phone', email: 'lp@acme.example', phone: '0'.repeat(21) }), 400, 'validation-failed');
      expectProblem(await addContact(acmeId, { name: 'Bad role', email: 'br@acme.example', roles: ['sales'] }), 400, 'validation-failed');
      const twice = await addContact(acmeId, { name: 'Twice', email: 'tw@acme.example', roles: ['billing', 'billing'] });
      expectProblem(twice, 400, 'validation-failed');
      expect(twice.body.detail).toMatch(/roles must not repeat/);
      const dup = await addContact(acmeId, { name: 'Asha again', email: 'ASHA@acme.example' });
      expectProblem(dup, 409, 'duplicate-contact-email');
      expectProblem(await editContact(acmeId, ravi, { email: 'Asha@Acme.example' }), 409, 'duplicate-contact-email');
    });

    it('make Ravi primary: Asha cleared, Ravi set, one transaction; audited client.contact_edited; isPrimary false is 400', async () => {
      const key = ulid();
      const res = await editContact(acmeId, ravi, { isPrimary: true }, key).expect(200);
      expect(res.body.contact).toMatchObject({ id: ravi, isPrimary: true });
      expect(await primaries(acmeId)).toEqual([ravi]);
      await expectAuditRow({ tenantId, key, action: 'client.contact_edited', targetType: 'client', targetId: acmeId, actorUserId: ownerUserId });
      expectProblem(await editContact(acmeId, asha, { isPrimary: false }), 400, 'validation-failed');
      expect(await primaries(acmeId)).toEqual([ravi]);
    });

    it('an unchanged edit is a declared no-op that stores the key and writes no audit row', async () => {
      const before = await sql`select updated_at::text from client_contacts where id = ${asha}`;
      const key = noOpIdempotencyKey(tenantId, ulid(), 'clients.contactEdit:unchanged');
      const res = await editContact(acmeId, asha, { name: 'Asha Rao', roles: ['returns', 'operations'] }, key).expect(200);
      expect(res.body.contact).toMatchObject({ id: asha, name: 'Asha Rao' });
      expect(await keyStored(key)).toBe(true);
      expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${key}`).toHaveLength(0);
      expect(await sql`select updated_at::text from client_contacts where id = ${asha}`).toEqual(before);
    });

    it('removing the primary while others remain is 409 primary-contact-required; removing another is 200, audited client.contact_removed', async () => {
      expectProblem(await removeContact(acmeId, ravi), 409, 'primary-contact-required');
      const key = ulid();
      const res = await removeContact(acmeId, asha, key).expect(200);
      expect(res.body.contact.id).toBe(asha);
      await expectAuditRow({ tenantId, key, action: 'client.contact_removed', targetType: 'client', targetId: acmeId, actorUserId: ownerUserId });
      expect(await sql`select 1 from client_contacts where id = ${asha}`).toHaveLength(0);
      expectProblem(await removeContact(acmeId, asha), 404, 'not-found');
    });

    it('two racing make-primary edits both commit, and exactly one primary remains', async () => {
      const raceId = await createClient('RACEPRI');
      const a = (await addContact(raceId, { name: 'A', email: 'a@race.example' }).expect(201)).body.contact.id as string;
      const b = (await addContact(raceId, { name: 'B', email: 'b@race.example' }).expect(201)).body.contact.id as string;
      const c = (await addContact(raceId, { name: 'C', email: 'c@race.example' }).expect(201)).body.contact.id as string;
      expect(await primaries(raceId)).toEqual([a]);
      const [rb, rc] = await Promise.all([editContact(raceId, b, { isPrimary: true }), editContact(raceId, c, { isPrimary: true })]);
      expect([rb.status, rc.status]).toEqual([200, 200]);
      const now = await primaries(raceId);
      expect(now).toHaveLength(1);
      expect([b, c]).toContain(now[0]);
    });

    it('a 21st contact is 409 contact-limit; the last contact can be removed', async () => {
      const fullId = await createClient('FULL');
      for (let i = 0; i < 20; i++) {
        await addContact(fullId, { name: `Contact ${i}`, email: `c${i}@full.example` }).expect(201);
      }
      expectProblem(await addContact(fullId, { name: 'One more', email: 'more@full.example' }), 409, 'contact-limit');
      const soloId = await createClient('SOLO');
      const solo = (await addContact(soloId, { name: 'Only', email: 'only@solo.example' }).expect(201)).body.contact.id as string;
      await removeContact(soloId, solo).expect(200);
      expect(await primaries(soloId)).toEqual([]);
    });

    it('the self client may have contacts', async () => {
      const res = await addContact(selfClientId, { name: 'Our ops', email: 'ops@self.example', roles: ['operations'] }).expect(201);
      expect(res.body.contact).toMatchObject({ clientId: selfClientId, isPrimary: true });
    });

    it('RLS: a portal-stamped transaction reads only its own client’s contacts (wms_rls_probe)', async () => {
      const other = await createClient('RLSB');
      await addContact(other, { name: 'Beta', email: 'beta@rls.example' }).expect(201);
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${PROBE_LOCK})`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
              create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
            end if;
          end $$;`);
        await tx.unsafe('grant usage on schema public to wms_rls_probe');
        await tx.unsafe('grant select, insert, update, delete on all tables in schema public to wms_rls_probe');
      });
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const probe = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        const read = async (clientStamp: string | null, tenantStamp = tenantId): Promise<string[]> =>
          probe.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantStamp}, true)`;
            if (clientStamp !== null) await tx`select set_config('app.client_id', ${clientStamp}, true)`;
            // The query shape with NO client predicate — only the policy filters.
            const rows = await tx<{ client_id: string }[]>`select client_id from client_contacts`;
            return [...new Set(rows.map((row) => row.client_id))].sort();
          }) as Promise<string[]>;
        expect(await read(acmeId)).toEqual([acmeId]);
        expect(await read(other)).toEqual([other]);
        // Positive control: the operator shape (no client stamp) sees both.
        const all = await read(null);
        expect(all).toEqual(expect.arrayContaining([acmeId, other]));
        expect(await read(null, uuidv7())).toEqual([]);
        // A portal-stamped session cannot write another client's contact (42501).
        await expect(
          probe.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            await tx`select set_config('app.client_id', ${acmeId}, true)`;
            await tx`insert into client_contacts (id, tenant_id, client_id, name, email) values (${uuidv7()}, ${tenantId}, ${other}, 'X', 'x@rls.example')`;
          }),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await probe.end();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Addresses
  // ──────────────────────────────────────────────────────────────────────────
  describe('addresses', () => {
    let addrId: string;
    const registered = { line1: '4th Floor, Prestige Towers', city: 'Mumbai', stateCode: '27', pincode: '400001' };
    const returnAddress = { contactName: 'Returns desk', phone: '+91 98200 00000', line1: '2 Probe Road', line2: 'Unit 4', city: 'Pune', state: 'Maharashtra', pincode: '411001' };

    beforeAll(async () => {
      addrId = await createClient('ADDR');
    });

    it('sets both groups: 200, every client read carries them; audited client.addresses_updated', async () => {
      const key = ulid();
      const res = await setAddresses(addrId, { registered, return: returnAddress }, key).expect(200);
      expect(res.body.client.registeredAddress).toEqual({ ...registered, line2: null });
      expect(res.body.client.returnAddress).toEqual(returnAddress);
      await expectAuditRow({ tenantId, key, action: 'client.addresses_updated', targetType: 'client', targetId: addrId, actorUserId: ownerUserId });
      const list = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      const row = (list.body.items as { id: string; registeredAddress: unknown; returnAddress: unknown }[]).find((item) => item.id === addrId)!;
      expect(row.registeredAddress).toEqual({ ...registered, line2: null });
      expect(row.returnAddress).toEqual(returnAddress);
      // Every other client reads both as null — required and nullable.
      const selfRow = (list.body.items as { id: string; registeredAddress: unknown; returnAddress: unknown }[]).find((item) => item.id === selfClientId)!;
      expect(selfRow).toMatchObject({ registeredAddress: null, returnAddress: null });
    });

    it('an omitted group is unchanged, null clears it; an unchanged patch is a no-op that stores the key', async () => {
      const cleared = await setAddresses(addrId, { return: null }).expect(200);
      expect(cleared.body.client.returnAddress).toBeNull();
      expect(cleared.body.client.registeredAddress).toEqual({ ...registered, line2: null });
      const key = noOpIdempotencyKey(tenantId, ulid(), 'clients.addresses:unchanged');
      await setAddresses(addrId, { registered }, key).expect(200);
      expect(await keyStored(key)).toBe(true);
      expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${key}`).toHaveLength(0);
    });

    it('a registered state code off the registration list (99) is 400 naming the field; a partial group is 400', async () => {
      const bad = await setAddresses(addrId, { registered: { ...registered, stateCode: '99' } });
      expectProblem(bad, 400, 'validation-failed');
      expect(bad.body.detail).toMatch(/registeredAddress\.stateCode/);
      const pin = await setAddresses(addrId, { registered: { ...registered, pincode: '4000' } });
      expectProblem(pin, 400, 'validation-failed');
      expect(pin.body.detail).toMatch(/registeredAddress\.pincode/);
      expectProblem(await setAddresses(addrId, { return: { ...returnAddress, phone: undefined } }), 400, 'validation-failed');
      expectProblem(await setAddresses(addrId, { registered }, ulid(), opsToken), 403, 'role-denied');
    });

    it('the self client may have addresses', async () => {
      const res = await setAddresses(selfClientId, { registered }).expect(200);
      expect(res.body.client.registeredAddress).toEqual({ ...registered, line2: null });
    });

    it('a stored snapshot from before 1-2a replays with both addresses null-filled', async () => {
      const key = seededIdempotencyKey(tenantId, ulid());
      const name = 'ADDR Brand';
      const payloadHash = createHash('sha256').update(JSON.stringify({ tenantId, clientId: addrId, name }), 'utf8').digest('hex');
      const legacy = {
        client: {
          id: addrId,
          tenantId,
          code: 'ADDR',
          name,
          status: 'active',
          systemOwned: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      await sql`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
        values (${uuidv7()}, ${tenantId}, ${key}, ${payloadHash}, ${sql.json(legacy)})`;
      const res = await http()
        .patch(`${API}/${tenantId}/clients/${addrId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, key)
        .send({ name })
        .expect(200);
      expect(res.body.client).toMatchObject({ registeredAddress: null, returnAddress: null, taxDetails: { gstin: null } });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Departure — the wind-down check, the transitions, "no new work"
  // ──────────────────────────────────────────────────────────────────────────
  describe('departure', () => {
    it('the self client cannot depart (400); a refused departure stores no key', async () => {
      const self = await setStatus(selfClientId, 'departed');
      expectProblem(self, 400, 'validation-failed');
    });

    it('stock, two open orders and a pending adjustment: 409 client-not-wound-down listing exactly those three (orders with codes); no key stored', async () => {
      const trioId = await createClient('TRIO');
      await importCsv(['TRIO-A,Trio A,pcs,1800,,,', 'TRIO-B,Trio B,pcs,1800,,,'], trioId).expect(201);
      await refreshSkus();
      await adjust(sku('TRIO-A'), 10).expect(201);
      const o1 = (await createOrder([{ skuId: sku('TRIO-A'), quantity: 1 }]).expect(201)).body.order.id as string;
      const o2 = (await createOrder([{ skuId: sku('TRIO-A'), quantity: 1 }]).expect(201)).body.order.id as string;
      // A pending adjustment: the tenant's approval threshold, then an adjustment over it.
      await sql`insert into stock_adjustment_policies (id, tenant_id, quantity_threshold) values (${uuidv7()}, ${tenantId}, 1000)
        on conflict do nothing`;
      await adjust(sku('TRIO-B'), 2000).expect(202);

      const key = ulid();
      const res = await setStatus(trioId, 'departed', key);
      expectProblem(res, 409, 'client-not-wound-down');
      expect(res.body.blockers).toEqual([
        { kind: 'stock', count: 1, codes: ['TRIO-A'] },
        { kind: 'open-orders', count: 2, codes: [o1.slice(-8), o2.slice(-8)].sort() },
        { kind: 'pending-adjustments', count: 1 },
      ]);
      expect(await keyStored(key)).toBe(false);
      expect((await sql`select status from clients where id = ${trioId}`)[0]!.status).toBe('active');
    });

    it('every blocker kind bites: a client with all ten is refused naming all ten, in order', async () => {
      const windId = await createClient('WIND');
      await importCsv(['WIND-A,Wind A,pcs,1800,,,', 'WIND-B,Wind B,pcs,1800,,,'], windId).expect(201);
      await refreshSkus();
      // stock + an open order
      await adjust(sku('WIND-A'), 5).expect(201);
      await createOrder([{ skuId: sku('WIND-A'), quantity: 1 }]).expect(201);
      // an open PO, over-received → a pending over-receipt
      const po = await createPo([{ skuId: sku('WIND-B'), orderedQty: 1 }], 'PO-WIND-1').expect(201);
      await receive({
        poId: po.body.purchaseOrder.id,
        blindReasonCode: null,
        lines: [grnLine(sku('WIND-B'), 3, { poLineId: po.body.purchaseOrder.lines[0].id })],
      }).expect(201);
      // an open ASN
      await createAsn(windId, [{ skuId: sku('WIND-B'), announcedQty: 1 }], 'ASN-WIND-1').expect(201);
      // a pending adjustment (the threshold from the previous test)
      await sql`insert into stock_adjustment_policies (id, tenant_id, quantity_threshold) values (${uuidv7()}, ${tenantId}, 1000)
        on conflict do nothing`;
      await adjust(sku('WIND-A'), 2000).expect(202);
      // Direct-SQL fixtures for the documents an e2e flow is long to reach.
      const devices = await sql<{ id: string }[]>`select id from devices where tenant_id = ${tenantId} limit 1`;
      await sql`insert into return_authorizations (id, tenant_id, client_id, warehouse_id, order_id, code, status, order_dispatched_at, created_by)
        values (${uuidv7()}, ${tenantId}, ${windId}, ${warehouseId}, ${uuidv7()}, 'RMA-WIND-1', 'partially_received', now(), ${ownerUserId})`;
      const taskId = uuidv7();
      await sql`insert into count_tasks (id, tenant_id, warehouse_id, bin_id, origin, status) values (${taskId}, ${tenantId}, ${warehouseId}, ${binA}, 'on_demand', 'pending')`;
      await sql`insert into count_task_lines (id, tenant_id, task_id, sku_id, expected_quantity_milli) values (${uuidv7()}, ${tenantId}, ${taskId}, ${sku('WIND-A')}, 0)`;
      await sql`insert into rejected_ops (id, tenant_id, device_id, operator_user_id, op_id, op_type, classification, problem_code, payload, attribution, op_enqueued_at)
        values (${uuidv7()}, ${tenantId}, ${devices[0]!.id}, ${ownerUserId}, ${ulid()}, 'grn.submit', 'rejected', 'conflict',
                ${sql.json({ lines: [{ skuId: sku('WIND-B'), qty: 1 }] })}, ${sql.json({})}, now())`;
      await sql`insert into client_invoices (id, tenant_id, client_id, status, period_start, period_end, subtotal_paise, cgst_paise, sgst_paise, igst_paise,
                                             tax_paise, total_paise, round_off_paise, payable_paise, gaps, warnings, party, content_hash, created_by)
        values (${uuidv7()}, ${tenantId}, ${windId}, 'draft', '2026-09-01', '2026-09-30', 0, 0, 0, 0, 0, 0, 0, 0, '[]', '[]', '{}', 'x', ${ownerUserId})`;
      // Decision 9 — a channel mapping of its SKU.
      await sql`insert into channel_mappings (id, tenant_id, integration_id, external_ref, sku_id)
        values (${uuidv7()}, ${tenantId}, ${await shopifyIntegration()}, 'EXT-WIND', ${sku('WIND-A')})`;

      const res = await setStatus(windId, 'departed');
      expectProblem(res, 409, 'client-not-wound-down');
      const blockers = res.body.blockers as { kind: string; count: number; codes?: string[] }[];
      expect(blockers.map((blocker) => blocker.kind)).toEqual([...WIND_DOWN_BLOCKER_KINDS]);
      expect(blockers.find((b) => b.kind === 'open-purchase-orders')).toEqual({ kind: 'open-purchase-orders', count: 1, codes: ['PO-WIND-1'] });
      expect(blockers.find((b) => b.kind === 'open-asns')).toEqual({ kind: 'open-asns', count: 1, codes: ['ASN-WIND-1'] });
      expect(blockers.find((b) => b.kind === 'open-rmas')).toEqual({ kind: 'open-rmas', count: 1, codes: ['RMA-WIND-1'] });
      expect(blockers.find((b) => b.kind === 'unsettled-invoices')).toEqual({ kind: 'unsettled-invoices', count: 1, codes: ['2026-09'] });
      expect(blockers.find((b) => b.kind === 'open-counts')).toEqual({ kind: 'open-counts', count: 1 });
      expect(blockers.find((b) => b.kind === 'open-review-items')).toEqual({ kind: 'open-review-items', count: 1 });
      expect(blockers.find((b) => b.kind === 'channel-mappings')).toEqual({ kind: 'channel-mappings', count: 1, codes: ['EXT-WIND'] });
      expect(blockers.find((b) => b.kind === 'pending-over-receipts')?.count).toBe(1);
      expect(res.body.detail).toMatch(/Client "WIND" cannot depart while work remains/);
    });

    describe('a wound-down client departs', () => {
      let goneId: string;
      let acmeId: string;
      let portal: { email: string; token: string };
      let departKey: string;

      beforeAll(async () => {
        goneId = await createClient('GONE');
        acmeId = (await sql<{ id: string }[]>`select id from clients where tenant_id = ${tenantId} and code = 'ACME'`)[0]!.id;
        await importCsv(['GONE-A,Gone A,pcs,1800,,,', 'GONE-B,Gone B,pcs,1800,,,', 'GONE-K,Gone kit,pcs,1800,,,', 'GONE-V,Gone variant,pcs,1800,,,'], goneId).expect(201);
        await importCsv(['ACME-A,Acme A,pcs,1800,,,', 'ACME-FREE,Acme free,pcs,1800,,,'], acmeId).expect(201);
        await refreshSkus();
        portal = await portalUser(goneId);
        await http().get(`${API}/${tenantId}/portal/me`).set('Authorization', `Bearer ${portal.token}`).expect(200);
        departKey = ulid();
        const res = await setStatus(goneId, 'departed', departKey).expect(200);
        expect(res.body.client).toMatchObject({ id: goneId, status: 'departed' });
      });

      it('audited client.departed; the portal session ended (client-departed); portal sign-in answers 403 client-departed', async () => {
        await expectAuditRow({ tenantId, key: departKey, action: 'client.departed', targetType: 'client', targetId: goneId, actorUserId: ownerUserId });
        const ended = await http().get(`${API}/${tenantId}/portal/me`).set('Authorization', `Bearer ${portal.token}`);
        expect(ended.status).toBe(401);
        expect(ended.body).toMatchObject({ code: 'session-ended', reason: 'client-departed' });
        const signed = await signIn(portal.email);
        expectProblem(signed, 403, 'client-departed');
        expect(signed.body.detail).toBe("Your company's account with the warehouse has ended.");
        // A replay of the departure re-serves it; departing again is a stored no-op.
        const replay = await setStatus(goneId, 'departed', departKey).expect(200);
        expect(replay.body.client.status).toBe('departed');
        const again = noOpIdempotencyKey(tenantId, ulid(), 'clients.updateStatus:same-status');
        await setStatus(goneId, 'departed', again).expect(200);
      });

      it('a departed client cannot be suspended (409 client-not-active); addresses and contacts stay editable', async () => {
        const res = await setStatus(goneId, 'suspended');
        expectProblem(res, 409, 'client-not-active');
        expect(res.body.detail).toMatch(/a departed client can only be reactivated/);
        await setAddresses(goneId, { registered: { line1: '1 Gone Road', city: 'Delhi', stateCode: '07', pincode: '110001' } }).expect(200);
        await addContact(goneId, { name: 'Last contact', email: 'last@gone.example' }).expect(201);
      });

      it('no new work: order, PO, ASN, catalog import, SKU correction, kit, variant, mapping, adjustment — each 409 client-departed', async () => {
        expectProblem(await createOrder([{ skuId: sku('GONE-A'), quantity: 1 }]), 409, 'client-departed');
        expectProblem(await createPo([{ skuId: sku('GONE-A'), orderedQty: 1 }]), 409, 'client-departed');
        expectProblem(await createAsn(goneId, [{ skuId: sku('GONE-A'), announcedQty: 1 }]), 409, 'client-departed');
        expectProblem(await importCsv(['GONE-NEW,Gone new,pcs,1800,,,'], goneId), 409, 'client-departed');
        expectProblem(
          await http()
            .post(`${API}/${tenantId}/catalog/skus/${sku('ACME-FREE')}/client`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ clientId: goneId }),
          409,
          'client-departed',
        );
        expectProblem(
          await http()
            .post(`${API}/${tenantId}/catalog/skus/${sku('GONE-K')}/kit`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ components: [{ skuId: sku('GONE-A'), quantity: 1 }] }),
          409,
          'client-departed',
        );
        await http()
          .post(`${API}/${tenantId}/catalog/products`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          // Story 1-4 — a product names its client (more than one exists here);
          // the attach below still answers client-departed first.
          .send({ name: 'Gone Tee', axes: ['size'], clientId: selfClientId })
          .expect(201);
        const products = await http().get(`${API}/${tenantId}/catalog/products`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
        const productId = (products.body.items as { id: string; name: string }[]).find((p) => p.name === 'Gone Tee')!.id;
        expectProblem(
          await http()
            .patch(`${API}/${tenantId}/catalog/skus/${sku('GONE-V')}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ productId, variantValues: { size: 'S' } }),
          409,
          'client-departed',
        );
        const integrationId = await shopifyIntegration();
        expectProblem(
          await http()
            .put(`${API}/${tenantId}/channels/connections/${integrationId}/mappings`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ items: [{ externalRef: 'GONE-REF', skuId: sku('GONE-A') }] }),
          409,
          'client-departed',
        );
        // Decision 7 — found stock for a departed client is refused.
        expectProblem(await adjust(sku('GONE-A'), 1), 409, 'client-departed');
      });

      it('a count gain on its SKU is refused through the same guard (409 client-departed)', async () => {
        const inventory = app.get(InventoryFacade);
        const db = app.get<Database>(DATABASE);
        const attempt = withTenantTransaction(db, tenantId, (tx) =>
          inventory.assertAdjustableInTx(tx, {
            tenantId,
            actorUserId: ownerUserId,
            warehouseId,
            skuId: sku('GONE-A'),
            binId: binA,
            quantityDelta: 1,
            reasonCode: 'stock-count',
            note: 'count variance resolution',
          }),
        );
        await expect(attempt).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'client-departed' }) });
      });

      it('the ASN import refuses the group as a row error client-departed', async () => {
        const csv = ['asn_code,client,warehouse,expected_at,sku,quantity', 'ASN-GONE-IMP,GONE,,,GONE-A,1'].join('\n');
        const res = await http()
          .post(`${API}/${tenantId}/inbound/asn-imports`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .field('warehouseId', warehouseId)
          .field('dryRun', 'true')
          .attach('file', Buffer.from(csv, 'utf8'), { filename: 'asns.csv', contentType: 'text/csv' })
          .expect(200);
        expect(res.body.acceptedCount).toBe(0);
        expect((res.body.errors as { code: string }[]).map((error) => error.code)).toEqual(['client-departed']);
      });

      it('a channel order for its SKUs is 422 validation-failed, metered validation-failed', async () => {
        const integrationId = await shopifyIntegration();
        await sql`insert into channel_mappings (id, tenant_id, integration_id, external_ref, sku_id)
          values (${uuidv7()}, ${tenantId}, ${integrationId}, 'EXT-GONE', ${sku('GONE-A')})`;
        const ingest = app.get(ChannelsIngestCommand).ingestOrderDelivery({
          tenantId,
          connectionId: integrationId,
          parsed: { orderRef: `CH-${ulid()}`, destination: testAddress() as never, lines: [{ externalRef: 'EXT-GONE', quantity: 1 }] },
        });
        await expect(ingest).rejects.toMatchObject({ status: 422, response: expect.objectContaining({ code: 'validation-failed' }) });
        const calls = await sql<{ status: string }[]>`select status from integration_calls where tenant_id = ${tenantId} and integration_id = ${integrationId}`;
        expect(calls.map((row) => row.status)).toEqual(['validation-failed']);
        expect(await sql`select 1 from orders where tenant_id = ${tenantId} and client_id = ${goneId}`).toHaveLength(0);
      });

      it('an RMA for its order is 409 client-departed', async () => {
        const orderId = uuidv7();
        await sql`insert into orders (id, tenant_id, client_id, warehouse_id, status, source) values (${orderId}, ${tenantId}, ${goneId}, ${warehouseId}, 'dispatched', 'manual')`;
        const res = await http()
          .post(`${API}/${tenantId}/returns`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({ orderId, lines: [{ orderLineId: uuidv7(), qty: 1, reasonCode: 'damaged' }] });
        expectProblem(res, 409, 'client-departed');
      });

      it('receipts: its lines on any receipt — a blind one naming it included — are refused per line; the rest settles', async () => {
        const reviewOf = async (opId: string) =>
          sql<{ op_type: string; problem_code: string }[]>`
            select op_type, problem_code from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`;
        // Decision 7 — a blind receipt NAMING it is no longer refused whole:
        // its line is refused per line, and with every line refused the
        // receipt takes the goodsReceipt:null arm.
        const named = await receive({ poId: null, blindReasonCode: 'other', clientId: goneId, lines: [grnLine(sku('GONE-A'), 1)] }).expect(201);
        expect(named.body.goodsReceipt).toBeNull();
        expect(named.body.refusedReceipt).toMatchObject({ clientId: goneId, rejectedLines: [expect.objectContaining({ code: 'client-departed' })] });
        expect(await reviewOf(named.body.refusedReceipt.reviewOpId as string)).toEqual([
          { op_type: 'grn.lines-refused', problem_code: 'client-departed' },
        ]);
        // A blind receipt from an older build (no clientId): its line refused, the ACME line settles.
        const mixed = await receive({ poId: null, blindReasonCode: 'other', lines: [grnLine(sku('GONE-A'), 2), grnLine(sku('ACME-A'), 1)] }).expect(201);
        expect(mixed.body.goodsReceipt.lines).toHaveLength(1);
        expect(mixed.body.goodsReceipt.rejectedLines).toEqual([
          expect.objectContaining({ skuId: sku('GONE-A'), qty: 2, code: 'client-departed' }),
        ]);
        expect(await reviewOf(mixed.body.goodsReceipt.reviewOpId as string)).toEqual([
          { op_type: 'grn.lines-refused', problem_code: 'client-departed' },
        ]);
        // Its SKU on another client's PO: refused per line too.
        const po = await createPo([{ skuId: sku('ACME-A'), orderedQty: 5 }]).expect(201);
        const onPo = await receive({
          poId: po.body.purchaseOrder.id,
          blindReasonCode: null,
          lines: [grnLine(sku('ACME-A'), 1, { poLineId: po.body.purchaseOrder.lines[0].id }), grnLine(sku('GONE-B'), 1)],
        }).expect(201);
        expect((onPo.body.goodsReceipt.rejectedLines as { code: string; skuId: string }[]).map((line) => [line.skuId, line.code])).toEqual([
          [sku('GONE-B'), 'client-departed'],
        ]);
        expect(await reviewOf(onPo.body.goodsReceipt.reviewOpId as string)).toEqual([
          { op_type: 'grn.lines-refused', problem_code: 'client-departed' },
        ]);
        // Every line refused: no receipt, goodsReceipt null, one review row (Discard only).
        const all = await receive({ poId: null, blindReasonCode: 'other', lines: [grnLine(sku('GONE-A'), 1)] }).expect(201);
        expect(all.body.goodsReceipt).toBeNull();
        expect(all.body.refusedReceipt).toMatchObject({ clientId: goneId, rejectedLines: [expect.objectContaining({ code: 'client-departed' })] });
        expect(await reviewOf(all.body.refusedReceipt.reviewOpId as string)).toEqual([
          { op_type: 'grn.lines-refused', problem_code: 'client-departed' },
        ]);
        // Nothing of its stock was booked.
        expect(await sql`select 1 from stock_on_hand where tenant_id = ${tenantId} and sku_id in ${sql([sku('GONE-A'), sku('GONE-B')])} and quantity <> 0`).toHaveLength(0);
      });

      it('the replenishment sweep skips its SKUs (an active client’s breach still opens)', async () => {
        await sql`update skus set reorder_point = 5000 where id in ${sql([sku('GONE-B'), sku('ACME-FREE')])}`;
        const report = await app.get(ReplenishmentSweep).sweepScope(tenantId, warehouseId);
        expect(report.opened).toBeGreaterThanOrEqual(1);
        const breaches = await sql<{ sku_id: string }[]>`select sku_id from reorder_breaches where tenant_id = ${tenantId}`;
        expect(breaches.map((row) => row.sku_id)).toContain(sku('ACME-FREE'));
        expect(breaches.map((row) => row.sku_id)).not.toContain(sku('GONE-B'));
      });

      it('history stays readable and a client invoice can still be prepared (never client-departed)', async () => {
        const list = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
        expect((list.body.items as { id: string; status: string }[]).find((item) => item.id === goneId)?.status).toBe('departed');
        await http().get(`${API}/${tenantId}/clients/${goneId}/contacts`).set('Authorization', `Bearer ${opsToken}`).expect(200);
        const prepared = await http()
          .post(`${API}/${tenantId}/clients/${goneId}/invoices`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ month: '2026-09' });
        expect((prepared.body as { code?: string }).code).not.toBe('client-departed');
      });

      it('reactivate: 200 active, audited client.reactivated; work resumes; the portal needs a fresh sign-in', async () => {
        const key = ulid();
        const res = await setStatus(goneId, 'active', key).expect(200);
        expect(res.body.client.status).toBe('active');
        await expectAuditRow({ tenantId, key, action: 'client.reactivated', targetType: 'client', targetId: goneId, actorUserId: ownerUserId });
        // The ended session stays ended; a fresh sign-in works.
        expect((await http().get(`${API}/${tenantId}/portal/me`).set('Authorization', `Bearer ${portal.token}`)).status).toBe(401);
        const fresh = (await signIn(portal.email).expect(200)).body.accessToken as string;
        await http().get(`${API}/${tenantId}/portal/me`).set('Authorization', `Bearer ${fresh}`).expect(200);
        await createOrder([{ skuId: sku('GONE-A'), quantity: 1 }]).expect(201);
      });
    });

    it('an order racing the departure: the departure commits between phase 1 and phase 3 — the order is refused at phase 3, grants released', async () => {
      const raceId = await createClient('RACEDEP');
      await importCsv(['RACE-A,Race A,pcs,1800,,,'], raceId).expect(201);
      await refreshSkus();
      const inventory = app.get(InventoryFacade);
      const original = inventory.atp.bind(inventory);
      let departed: request.Response | null = null;
      const spy = jest.spyOn(inventory, 'atp').mockImplementation(async (...args: Parameters<InventoryFacade['atp']>) => {
        if (departed === null) {
          // Phase 1 committed (the client was active, no lock held); the
          // departure now commits before the write transaction opens.
          departed = await setStatus(raceId, 'departed');
        }
        return original(...args);
      });
      try {
        const res = await createOrder([{ skuId: sku('RACE-A'), quantity: 1 }]);
        expect(departed!.status).toBe(200);
        expectProblem(res, 409, 'client-departed');
      } finally {
        spy.mockRestore();
      }
      expect(await sql`select 1 from orders where tenant_id = ${tenantId} and client_id = ${raceId}`).toHaveLength(0);
      expect(await sql`select 1 from reservations where tenant_id = ${tenantId} and sku_id = ${sku('RACE-A')} and state in ('held', 'committed')`).toHaveLength(0);
    });

    it('an order that committed first blocks the departure (open-orders)', async () => {
      const firstId = await createClient('FIRST');
      await importCsv(['FIRST-A,First A,pcs,1800,,,'], firstId).expect(201);
      await refreshSkus();
      const order = (await createOrder([{ skuId: sku('FIRST-A'), quantity: 1 }]).expect(201)).body.order.id as string;
      const res = await setStatus(firstId, 'departed');
      expectProblem(res, 409, 'client-not-wound-down');
      expect(res.body.blockers).toEqual([{ kind: 'open-orders', count: 1, codes: [order.slice(-8)] }]);
    });

    it('the gate serialises a creation against a departure: a departure parked behind a creator\'s key share sees its document', async () => {
      const gateId = await createClient('GATEC');
      await importCsv(['GATE-A,Gate A,pcs,1800,,,'], gateId).expect(201);
      await refreshSkus();
      const db = app.get<Database>(DATABASE);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let gated!: () => void;
      const gateHeld = new Promise<void>((resolve) => {
        gated = resolve;
      });
      // A creator: the gate (FOR KEY SHARE), then — after the departure has
      // parked — its open document, committed.
      const creator = withTenantTransaction(db, tenantId, async (tx) => {
        await assertClientTakesWorkInTx(tx, tenantId, gateId);
        gated();
        await gate;
        await tx.execute(dsql`insert into purchase_orders (id, tenant_id, client_id, warehouse_id, vendor_id, code, status)
          values (${uuidv7()}, ${tenantId}, ${gateId}, ${warehouseId}, ${vendorId}, 'PO-GATE-1', 'open')`);
      });
      await gateHeld;
      try {
        const departing = setStatus(gateId, 'departed').then((res) => res);
        await waitParkedOnClients('for update', 1);
        release();
        await creator;
        const departure = await departing;
        expectProblem(departure, 409, 'client-not-wound-down');
        expect(departure.body.blockers).toEqual([{ kind: 'open-purchase-orders', count: 1, codes: ['PO-GATE-1'] }]);
      } finally {
        release();
        await creator.catch(() => undefined);
      }
    });

    it('an open count variance alone (no open task) blocks the departure', async () => {
      const varId = await createClient('VARC');
      await importCsv(['VAR-A,Var A,pcs,1800,,,'], varId).expect(201);
      await refreshSkus();
      const taskId = uuidv7();
      await sql`insert into count_tasks (id, tenant_id, warehouse_id, bin_id, origin, status) values (${taskId}, ${tenantId}, ${warehouseId}, ${binA}, 'on_demand', 'completed')`;
      await sql`insert into count_variances (id, tenant_id, task_id, warehouse_id, bin_id, sku_id, expected_quantity_milli, counted_quantity_milli, delta_milli, status)
        values (${uuidv7()}, ${tenantId}, ${taskId}, ${warehouseId}, ${binA}, ${sku('VAR-A')}, 0, 1000, 1000, 'open')`;
      const res = await setStatus(varId, 'departed');
      expectProblem(res, 409, 'client-not-wound-down');
      expect(res.body.blockers).toEqual([{ kind: 'open-counts', count: 1 }]);
    });

    it('a breach open at departure is recovered by the next sweep, and no new one opens', async () => {
      const replId = await createClient('REPLC');
      await importCsv(['REPL-A,Repl A,pcs,1800,,,'], replId).expect(201);
      await refreshSkus();
      await sql`update skus set reorder_point = 5000 where id = ${sku('REPL-A')}`;
      const sweep = app.get(ReplenishmentSweep);
      await sweep.sweepScope(tenantId, warehouseId);
      const breachesOf = () =>
        sql<{ status: string }[]>`select status from reorder_breaches where tenant_id = ${tenantId} and sku_id = ${sku('REPL-A')} order by created_at`;
      expect((await breachesOf()).map((row) => row.status)).toEqual(['open']);
      await setStatus(replId, 'departed').expect(200);
      await sweep.sweepScope(tenantId, warehouseId);
      expect((await breachesOf()).map((row) => row.status)).toEqual(['recovered']);
      await sweep.sweepScope(tenantId, warehouseId);
      expect((await breachesOf()).map((row) => row.status)).toEqual(['recovered']);
    });

    it('lock modes: a long-held invoice-prepare lock does not block an order create, but a departure waits for it', async () => {
      const lockId = await createClient('LOCKC');
      await importCsv(['LOCK-A,Lock A,pcs,1800,,,'], lockId).expect(201);
      await refreshSkus();
      const db = app.get<Database>(DATABASE);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = withTenantTransaction(db, tenantId, async (tx) => {
        await lockClientInTx(tx, tenantId, lockId);
        locked();
        await gate;
      });
      await lockTaken;
      try {
        let timer: NodeJS.Timeout | undefined;
        const order = await Promise.race([
          createOrder([{ skuId: sku('LOCK-A'), quantity: 1 }]).then((res) => res.status),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve('blocked'), 8_000);
          }),
        ]);
        clearTimeout(timer);
        expect(order).toBe(201);
        // The status command's FOR UPDATE conflicts with FOR NO KEY UPDATE.
        const departing = setStatus(lockId, 'departed').then((res) => res);
        await waitParkedOnClients('for update', 1);
        release();
        const departure = await departing;
        expectProblem(departure, 409, 'client-not-wound-down');
      } finally {
        release();
        await holder;
      }
    });
  });
});
