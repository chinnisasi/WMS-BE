import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { MailFacade } from '../src/modules/mail/mail.facade';
import { EMAIL_GATEWAY, type LogEmailGateway } from '../src/modules/mail/email.gateway';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { HANDOVER_PARCEL_REFUSALS } from '../src/modules/outbound/handover.command';
import { withTenantTransaction, type TenantTx } from '../src/shared/db/tenant-scope';
import type { Database } from '../src/shared/db/db';
import { ewayRequired, thresholdForMovement } from '../src/shared/eway/eway-threshold';
import { liveConsignmentRecordsQuery } from '../src/modules/invoicing/consignment-seam';
import { consignmentExceptionsQuery, consignmentNeededPassQuery, portalOpenOrdersQuery } from '../src/modules/outbound/consignment.read';
import { uuidv7 } from '../src/shared/primitives/ids';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { pdfPagesText } from './support/pdf-text';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { mintSignIn } from './support/sign-in';
import { testAddress } from './support/shipment-address';
import { dispatchedOrderFixtures, type Picklist } from './support/dispatched-order';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.CARRIER_ENCRYPTION_KEY ??= 'e2e-only-carrier-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.EMAIL_SEND_POLL_MS;
delete process.env.EMAIL_ALLOWLIST_DOMAINS;
delete process.env.EMAIL_REPLY_TO;
delete process.env.WEBHOOK_SEND_POLL_MS;
process.env.EMAIL_PROVIDER = 'log';
process.env.EMAIL_FROM = 'no-reply@mail.wms.test';
process.env.WEB_BASE_URL = 'https://app.wms.test/';
process.env.EMAIL_SEAL_KEY = 'e2e-only-email-seal-key-0123456789abcdef';
process.env.CLIENT_EMAIL_ENABLED = 'true';

jest.setTimeout(240_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

/** An IST calendar date `offset` days from today. */
function istDay(offset = 0): string {
  return new Date(Date.now() + 5.5 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
}

let ewbCounter = 100_000;
/** A fresh 12-digit e-way bill number. */
function ewb(): string {
  ewbCounter += 1;
  return `4101${String(ewbCounter).padStart(8, '0')}`;
}

/** Maharashtra — an inter-state movement from the Karnataka warehouse. */
const MAHARASHTRA = testAddress({ state: 'Maharashtra', city: 'Pune', pincode: '411001' });

/**
 * Story 4-6a — client consignment compliance, end to end: the brand's
 * document and e-way bill recorded in the portal and by staff, the threshold
 * judged from the declared value, the documents rule and the value floor, the
 * gate in per-order dispatch and the courier handover (refused on the web,
 * flagged on the handheld), the stamp, amendments and withdrawals, the cancels
 * freeing the e-way number, the worklists, the prints and the emails, the
 * client's rule, isolation, and the hashes' goldens.
 */
describe('client consignment compliance (e2e, story 4-6a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let relay: OutboxRelay;
  let mail: MailFacade;
  let captured: LogEmailGateway;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsId: string;
  let floorWebToken: string;
  let operatorToken: string;
  let warehouseId: string;
  let binId: string;
  let acme: string;
  let beta: string;
  let selfClient: string;
  let acmePortal: string;
  let acmePortalId: string;
  let betaPortal: string;
  const sku = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('consignment');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    mail = app.get(MailFacade);
    captured = app.get<LogEmailGateway>(EMAIL_GATEWAY);

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Docs Co ${ulid()}`, ownerEmail, password: PASSWORD }).expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email: ownerEmail, password: PASSWORD })).body.accessToken as string;
    const ops = await member('ops_manager');
    opsToken = ops.token;
    opsId = ops.userId;
    const floor = await member('operator');
    floorWebToken = floor.token;

    warehouseId = (
      await http().post(`${API}/${tenantId}/warehouses`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `WH-${ulid().slice(20)}`, name: 'Main' }).expect(201)
    ).body.id as string;
    const zone = (
      await http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' }).expect(201)
    ).body.id as string;
    binId = (
      await http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone}/bins`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ capacity: 10000000, type: 'shelf', code: 'A-01-01' }).expect(201)
    ).body.id as string;

    acme = await createClient('ACME', 'ACME Brand');
    beta = await createClient('BETA', 'Beta Brand');
    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    selfClient = (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id;
    await http().patch(`${API}/${tenantId}/clients/${acme}/tax-details`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
      .send({ legalName: 'Acme Brand Private Limited', gstin: '29ABCDE1234F1Z5' }).expect(200);
    await importCsv(['A-TEE,Acme tee,pcs,1800,,false,false', 'A-LOT,Acme lot tee,pcs,1800,,true,false'], acme);
    await importCsv(['B-TEE,Beta tee,pcs,1800,,false,false'], beta);
    await importCsv(['S-TEE,Own tee,pcs,1800,,false,false'], selfClient);
    const listed = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of listed.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    for (const code of ['A-TEE', 'B-TEE', 'S-TEE']) {
      await http().post(`${API}/${tenantId}/inventory/adjustments`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: sku.get(code), binId, quantityDelta: 100000, reasonCode: 'stock-count', note: 'seed' }).expect(201);
    }
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'Dock scanner', pin: '2468' }).expect(201);
    operatorToken = (
      await http().post(`${API}/${tenantId}/devices/badge-in`).set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`).send({ operatorEmail: floor.email, pin: '2468' }).expect(200)
    ).body.accessToken as string;

    const acmeUser = await portalUser(acme);
    acmePortal = acmeUser.token;
    acmePortalId = acmeUser.userId;
    betaPortal = (await portalUser(beta)).token;
    await http().post(`${API}/${tenantId}/clients/${acme}/contacts`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
      .send({ name: 'Asha', email: 'asha@acme.example', emailEvents: ['order.dispatched', 'consignment.documents-needed'] }).expect(201);
  });

  afterAll(async () => {
    try {
      await sql?.end();
      const main = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
      await main.$client?.end();
      const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
      await authDb.$client?.end();
      await app.close();
    } finally {
      await suiteDb.drop();
    }
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function member(role: string): Promise<{ token: string; email: string; userId: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { token: (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string, email, userId: invited.body.user.id as string };
  }

  async function portalUser(clientId: string): Promise<{ token: string; userId: string }> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role: 'client', clientId }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { token: (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string, userId: invited.body.user.id as string };
  }

  async function createClient(code: string, name: string): Promise<string> {
    return (await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name }).expect(201)).body.client.id as string;
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,barcode,batch_tracked,serial_tracked', ...rows].join('\n');
    await http().post(`${API}/${tenantId}/catalog/imports`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
      .field('mode', 'initial').field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' }).expect(201);
  }

  function scannedOf(picklist: Picklist): { skuId: string; qty: number }[] {
    const by = new Map<string, number>();
    for (const line of picklist.lines) by.set(line.skuId, (by.get(line.skuId) ?? 0) + line.qty);
    return [...by.entries()].map(([skuId, qty]) => ({ skuId, qty }));
  }

  interface OrderSpec {
    readonly code?: string;
    readonly quantity?: number;
    readonly ratePaise?: number;
    readonly extra?: Record<string, unknown>;
  }

  /** An accepted order (B2B, inter-state to Maharashtra, unless `extra` says otherwise). */
  async function acceptedOrder(spec: OrderSpec = {}): Promise<string> {
    return fixtures.createOrder(
      [{ skuId: sku.get(spec.code ?? 'A-TEE')!, quantity: spec.quantity ?? 1, ...(spec.ratePaise === undefined ? {} : { ratePaise: spec.ratePaise }) }],
      undefined,
      { clientOrderRef: `SO-${ulid().slice(18)}`, orderType: 'b2b', destination: MAHARASHTRA, ...spec.extra },
    );
  }

  /** A packed (ready_to_dispatch) order — B2B, inter-state, unless `extra` says otherwise. */
  async function packedOrder(spec: OrderSpec = {}): Promise<string> {
    const ready = await fixtures.releasedWave(
      [{ skuId: sku.get(spec.code ?? 'A-TEE')!, quantity: spec.quantity ?? 1, ...(spec.ratePaise === undefined ? {} : { ratePaise: spec.ratePaise }) }],
      { clientOrderRef: `SO-${ulid().slice(18)}`, orderType: 'b2b', destination: MAHARASHTRA, ...spec.extra },
    );
    await fixtures.pickAllLines(ready.picklist);
    await http().post(`${API}/${tenantId}/outbound/orders/${ready.orderId}/pack`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
      .send({ scanned: scannedOf(ready.picklist), weightGrams: 900 }).expect(201);
    return ready.orderId;
  }

  function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      brandDocument: { type: 'invoice', number: 'INV/26-27/0042', date: istDay() },
      declaredValuePaise: 11_800_000,
      ewayBill: { number: ewb(), date: istDay(), validUntil: istDay(2) },
      ...overrides,
    };
  }

  function record(orderId: string, payload: Record<string, unknown>, token = opsToken, key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/consignment`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(payload);
  }

  function portalRecord(orderId: string, payload: Record<string, unknown>, token = acmePortal, key = ulid()) {
    return http().post(`${API}/${tenantId}/portal/orders/${orderId}/consignment`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(payload);
  }

  function withdraw(orderId: string, reason: string, token = opsToken, key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/consignment/withdraw`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({ reason });
  }

  function readConsignment(orderId: string, token = opsToken) {
    return http().get(`${API}/${tenantId}/outbound/orders/${orderId}/consignment`).set('Authorization', `Bearer ${token}`);
  }

  function dispatch(orderId: string, key = ulid()) {
    // 201 on success (the dispatch record).
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send({});
  }

  function handOver(payload: Record<string, unknown>, token = opsToken, key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/handovers`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key)
      .send({ warehouseId, clientId: acme, courier: { courierName: 'Delhivery' }, pickupPersonName: 'Ravi', vehicleNumber: 'KA01AB1234', ...payload });
  }

  function worklist(view: 'needed' | 'exceptions' = 'needed', clientId = acme) {
    return http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/consignments?view=${view}&clientId=${clientId}`).set('Authorization', `Bearer ${opsToken}`);
  }

  const drain = async () => {
    await sql`update outbox_messages set next_attempt_at = now() where tenant_id = ${tenantId} and status = 'pending' and next_attempt_at > now()`;
    return relay.drain(500);
  };

  async function orderStatus(orderId: string): Promise<string> {
    return (await sql`select status from orders where id = ${orderId}`)[0]!.status as string;
  }

  async function versions(orderId: string): Promise<{ seq: number; status: string; dispatched_at: string | null; end_reason: string | null }[]> {
    return (await sql`select seq, status, dispatched_at, end_reason from order_consignment_records where order_id = ${orderId} order by seq`) as unknown as {
      seq: number;
      status: string;
      dispatched_at: string | null;
      end_reason: string | null;
    }[];
  }

  // ── AC1: the brand records in the portal, the warehouse ships ──────────────

  it('AC1 — portal record (201, recorded, national inter-state): the worklist drops SO-1, a web handover dispatches it, the version is stamped, the sheet detail and the dispatch email name the documents; the portal hash golden', async () => {
    const orderId = await packedOrder();
    expect((await worklist().expect(200)).body.needed.map((r: { orderId: string }) => r.orderId)).toContain(orderId);
    const number = ewb();
    const key = ulid();
    const payload = { brandDocument: { type: 'invoice', number: 'INV/26-27/0042', date: istDay() }, declaredValuePaise: 11_800_000, ewayBill: { number, date: istDay(), validUntil: istDay(2) } };
    const recorded = await portalRecord(orderId, payload, acmePortal, key).expect(201);
    expect(recorded.body.consignment).toMatchObject({
      seq: 1,
      status: 'live',
      consignorGstin: '29ABCDE1234F1Z5',
      consignor: { name: 'ACME Brand', legalName: 'Acme Brand Private Limited' },
      declaredValuePaise: 11_800_000,
      destinationStateCode: '27',
      supplyType: 'inter',
      thresholdPaise: 5_000_000,
      thresholdRule: 'national',
      ewayRequired: true,
      eway: { status: 'recorded', number, validUntil: istDay(2) },
      source: 'portal',
      recordedByYou: true,
    });
    expect(Object.keys(recorded.body.consignment)).not.toContain('recordedBy');
    await expectAuditRow({ tenantId, key, action: 'consignment.recorded', targetType: 'order', targetId: orderId, actorUserId: acmePortalId });
    // The portal hash golden (A9): the surface and the client, the consignor as SENT (null).
    expect((await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.payload_hash).toBe(
      hashCommandPayload({
        arm: 'consignment-record',
        surface: 'portal',
        tenantId,
        clientId: acme,
        orderId,
        brandDocumentType: 'invoice',
        brandDocumentNumber: 'INV/26-27/0042',
        brandDocumentDate: istDay(),
        consignorGstin: null,
        declaredValuePaise: 11_800_000,
        ewayBillNumber: number,
        ewayBillDate: istDay(),
        ewayValidUntil: istDay(2),
        ewayExemptionReason: null,
        ewayExemptionNote: null,
        reason: null,
      }),
    );
    // A replay re-serves the portal snapshot.
    expect((await portalRecord(orderId, payload, acmePortal, key).expect(201)).body).toEqual(recorded.body);
    expect((await worklist().expect(200)).body.needed.map((r: { orderId: string }) => r.orderId)).not.toContain(orderId);
    // The prints read the LIVE version before the goods leave (the label line is ASCII).
    const file = (path: string) =>
      http().get(`${API}/${tenantId}${path}`).set('Authorization', `Bearer ${opsToken}`).buffer(true).parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    const zpl = ((await file(`/outbound/orders/${orderId}/carton-labels?format=zpl`).expect(200)).body as Buffer).toString('utf8');
    expect(zpl).toContain(`EWB ${number.slice(0, 4)} ${number.slice(4, 8)} ${number.slice(8)} / INV INV/26-27/0042`);
    const slip = (await pdfPagesText((await file(`/outbound/orders/${orderId}/packing-slip`).expect(200)).body as Buffer)).flat().join('\n');
    expect(slip).toContain('Tax document: Invoice INV/26-27/0042');
    expect(slip).toContain(`E-way bill ${number.slice(0, 4)} ${number.slice(4, 8)} ${number.slice(8)}`);
    const staff = (await readConsignment(orderId).expect(200)).body;
    expect(staff.gate).toMatchObject({ state: 'ready', blocking: false, nationalThresholdPaise: 5_000_000 });
    expect(staff.live.recordedBy).toBe(acmePortalId);

    const handover = await handOver({ parcels: [{ orderId, awb: 'AWBDOC0001' }] }).expect(201);
    expect(handover.body.parcels[0]).not.toHaveProperty('complianceException');
    expect(await orderStatus(orderId)).toBe('dispatched');
    expect((await versions(orderId))[0]!.dispatched_at).not.toBeNull();
    const detail = await http().get(`${API}/${tenantId}/outbound/handovers/${handover.body.handover.id as string}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(detail.body.handover.parcels[0]).toMatchObject({
      taxDocument: { type: 'invoice', number: 'INV/26-27/0042', date: istDay() },
      ewayBillNumber: number,
      ewayValidUntil: istDay(2),
      complianceException: null,
      lateRecord: null,
    });
    await drain();
    const rows = (await sql`select params from email_messages where tenant_id = ${tenantId} and template = 'client-dispatch' and dedupe_key like ${`client-dispatch:${orderId}:%`}`) as unknown as { params: Record<string, unknown> }[];
    expect(rows[0]!.params).toMatchObject({ taxDocument: { label: 'Invoice', number: 'INV/26-27/0042' }, ewayBill: { number, validUntil: istDay(2) } });
    const before = captured.captured.length;
    await mail.sendDue(tenantId);
    const sent = captured.captured.slice(before).find((email) => email.template === 'client-dispatch' && email.text.includes('INV/26-27/0042'));
    expect(sent!.text).toContain(`Sent under Invoice INV/26-27/0042 · E-way bill ${number.slice(0, 4)} ${number.slice(4, 8)} ${number.slice(8)}`);
  });

  // ── AC2: no documents, no dispatch ─────────────────────────────────────────

  it('AC2 — a B2B order with no record: per-order dispatch and the web handover refuse consignment-documents-missing (policy-b2b); it is on the worklist; the brand got ONE documents-needed email at pack', async () => {
    const orderId = await packedOrder();
    const refused = await dispatch(orderId).expect(409);
    expect(refused.body).toMatchObject({ code: 'consignment-documents-missing', orderId, state: 'missing', requiredBecause: 'policy-b2b', thresholdPaise: 5_000_000 });
    expect(refused.body.detail).toMatch(/Record the brand's invoice \(or challan\) for order/);
    const web = await handOver({ parcels: [{ orderId, awb: 'AWBDOC0002' }] }).expect(409);
    expect(web.body.parcels.map((p: { code: string }) => p.code)).toEqual(['consignment-documents-missing']);
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
    const needed = (await worklist().expect(200)).body.needed.find((r: { orderId: string }) => r.orderId === orderId);
    expect(needed).toMatchObject({ stage: 'packed', state: 'missing', requiredBecause: 'policy-b2b', clientCode: 'ACME', eway: null });
    await drain();
    await drain();
    const rows = (await sql`select dedupe_key, params from email_messages where tenant_id = ${tenantId} and template = 'client-documents-needed' and dedupe_key like ${`%${orderId}%`}`) as unknown as { dedupe_key: string; params: Record<string, unknown> }[];
    expect(rows.map((r) => r.dedupe_key)).toEqual([`client-documents-needed:${orderId}:asha@acme.example`]);
    expect(rows[0]!.params).toMatchObject({ orderId, needs: 'invoice', reason: 'policy-b2b' });
    const before = captured.captured.length;
    await mail.sendDue(tenantId);
    const sent = captured.captured.slice(before).find((email) => email.template === 'client-documents-needed');
    expect(sent!.subject).toMatch(/: order SO-[0-9A-Z]+ is packed — your invoice is needed before it can leave$/);
    expect(sent!.text).toContain(`/portal/orders?order=${orderId}&tab=documents`);
  });

  it('A20 — a packed order whose gate is NOT blocking at delivery gets no documents-needed email (a B2C order with no figures)', async () => {
    const orderId = await packedOrder({ extra: { orderType: 'b2c' } });
    await drain();
    expect(await sql`select count(*)::int as n from email_messages where tenant_id = ${tenantId} and dedupe_key = ${`client-documents-needed:${orderId}:asha@acme.example`}`).toEqual([{ n: 0 }]);
  });

  // ── AC3: the threshold judged ──────────────────────────────────────────────

  it('AC3 — ₹1,18,000 inter-state with no e-way bill reads pending and blocks (eway-bill-required); ₹42,000 is not-required and ships; ₹50,000 exactly is not-required (strictly above)', async () => {
    const pending = await packedOrder();
    const recorded = await record(pending, body({ ewayBill: undefined })).expect(201);
    expect(recorded.body.consignment.eway.status).toBe('pending');
    expect((await dispatch(pending).expect(409)).body.code).toBe('eway-bill-required');
    expect((await worklist().expect(200)).body.needed.find((r: { orderId: string }) => r.orderId === pending)).toMatchObject({ state: 'eway-required' });

    const below = await packedOrder();
    expect((await record(below, body({ ewayBill: undefined, declaredValuePaise: 4_200_000 })).expect(201)).body.consignment).toMatchObject({ ewayRequired: false, eway: { status: 'not-required' } });
    await dispatch(below).expect(201);
    expect((await versions(below))[0]!.dispatched_at).not.toBeNull();

    const equal = await packedOrder();
    expect((await record(equal, body({ ewayBill: undefined, declaredValuePaise: 5_000_000 })).expect(201)).body.consignment.eway.status).toBe('not-required');
  });

  it('AC3 — a Karnataka intra-state override of ₹1,00,000 in force: ₹80,000 intra-state reads not-required under rule state:29', async () => {
    await http().post(`${API}/${tenantId}/eway/state-thresholds`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
      .send({ stateCode: '29', thresholdPaise: 10_000_000, effectiveFrom: istDay(-1) }).expect(201);
    const orderId = await packedOrder({ extra: { destination: testAddress() } });
    const view = (await record(orderId, body({ ewayBill: undefined, declaredValuePaise: 8_000_000 })).expect(201)).body.consignment;
    expect(view).toMatchObject({ supplyType: 'intra', destinationStateCode: '29', thresholdRule: 'state:29', thresholdPaise: 10_000_000, ewayRequired: false, eway: { status: 'not-required' } });
  });

  // ── AC4: the floor ─────────────────────────────────────────────────────────

  it('AC4 — a B2C order with 2 × ₹30,000 rated and no record is refused with requiredBecause value; the same order with no rates ships', async () => {
    const rated = await packedOrder({ quantity: 2, ratePaise: 3_000_000, extra: { orderType: 'b2c' } });
    expect((await dispatch(rated).expect(409)).body).toMatchObject({ code: 'consignment-documents-missing', requiredBecause: 'value', valueFloorPaise: 6_000_000 });
    const unrated = await packedOrder({ quantity: 2, extra: { orderType: 'b2c' } });
    await dispatch(unrated).expect(201);
  });

  // ── expiry, one clock ─────────────────────────────────────────────────────

  it('an e-way bill valid until yesterday is eway-bill-expired; valid until today dispatches (expiresToday on the worklist first)', async () => {
    const expired = await packedOrder();
    await record(expired, body({ brandDocument: { type: 'invoice', number: 'INV-EXP', date: istDay(-1) }, ewayBill: { number: ewb(), date: istDay(-1), validUntil: istDay(-1) } })).expect(201);
    expect((await dispatch(expired).expect(409)).body.code).toBe('eway-bill-expired');
    const today = await packedOrder();
    await record(today, body({ ewayBill: { number: ewb(), date: istDay(), validUntil: istDay() } })).expect(201);
    expect((await worklist().expect(200)).body.needed.find((r: { orderId: string }) => r.orderId === today)).toMatchObject({ state: 'ready' });
    await dispatch(today).expect(201);
  });

  // ── shape refusals ────────────────────────────────────────────────────────

  it('shape and rules: no validity (A34), an e-way date before the document (A33), other without a note, a declared value below the COD amount (A40, 422), the tenant’s own goods (own-goods-invoiced), a replay with another body (422)', async () => {
    const orderId = await packedOrder();
    expect((await record(orderId, body({ ewayBill: { number: ewb(), date: istDay() } })).expect(400)).body.detail).toMatch(/validUntil is required/);
    expect((await record(orderId, body({ brandDocument: { type: 'invoice', number: 'X', date: istDay() }, ewayBill: { number: ewb(), date: istDay(-1), validUntil: istDay(1) } })).expect(400)).body.detail).toMatch(/before brandDocument.date/);
    expect((await record(orderId, body({ ewayBill: undefined, ewayExemption: { reason: 'other' } }), opsToken).expect(400)).body.detail).toMatch(/note is required/);
    expect((await record(orderId, body({ brandDocument: { type: 'debit-note', number: 'X', date: istDay() } })).expect(400)).body.detail).toMatch(/brandDocument.type/);
    const cod = await packedOrder({ extra: { orderType: 'b2c', codAmountPaise: 8_000_000 } });
    expect((await record(cod, body({ ewayBill: undefined, declaredValuePaise: 800_000 })).expect(422)).body).toMatchObject({ code: 'declared-value-below-order-value', codAmountPaise: 8_000_000 });
    const own = await packedOrder({ code: 'S-TEE', extra: { orderType: 'b2b' } });
    expect((await record(own, body()).expect(409)).body.code).toBe('own-goods-invoiced');
    // The self client's B2B order is outside the gate.
    await dispatch(own).expect(201);
    const key = ulid();
    await record(orderId, body(), opsToken, key).expect(201);
    expect((await record(orderId, body(), opsToken, key).expect(422)).body.code).toBe('idempotency-key-reuse');
  });

  // ── amendments, the no-op, after dispatch, A46 ─────────────────────────────

  it('amend before dispatch: v2 live, v1 superseded "Amended"; the same body again is a no-op that stores the key; the staff hash golden', async () => {
    const orderId = await packedOrder();
    const first = body();
    await record(orderId, first).expect(201);
    const second = body();
    const key = ulid();
    const amended = await record(orderId, second, opsToken, key).expect(201);
    expect(amended.body.consignment.seq).toBe(2);
    await expectAuditRow({ tenantId, key, action: 'consignment.recorded', targetType: 'order', targetId: orderId, actorUserId: opsId });
    expect(await versions(orderId)).toEqual([
      { seq: 1, status: 'superseded', dispatched_at: null, end_reason: 'Amended' },
      { seq: 2, status: 'live', dispatched_at: null, end_reason: null },
    ]);
    const eway = second.ewayBill as { number: string; date: string; validUntil: string };
    expect((await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.payload_hash).toBe(
      hashCommandPayload({
        arm: 'consignment-record',
        surface: 'staff',
        tenantId,
        orderId,
        brandDocumentType: 'invoice',
        brandDocumentNumber: 'INV/26-27/0042',
        brandDocumentDate: istDay(),
        consignorGstin: null,
        declaredValuePaise: 11_800_000,
        ewayBillNumber: eway.number,
        ewayBillDate: eway.date,
        ewayValidUntil: eway.validUntil,
        ewayExemptionReason: null,
        ewayExemptionNote: null,
        reason: null,
      }),
    );
    // A portal resend of the same document is a no-op (D25 — source and actor excluded).
    const noop = ulid();
    noOpIdempotencyKey(tenantId, noop, 'consignment.record:unchanged');
    const unchanged = await portalRecord(orderId, second, acmePortal, noop).expect(200);
    expect(unchanged.body).toMatchObject({ unchanged: true, consignment: { seq: 2 } });
    // A replay of the no-op key is 200 too (the flag rides the stored snapshot).
    expect((await portalRecord(orderId, second, acmePortal, noop).expect(200)).body).toEqual(unchanged.body);
    // The staff surface: the same body again is the same 200 no-op.
    const staffNoop = ulid();
    noOpIdempotencyKey(tenantId, staffNoop, 'consignment.record:unchanged');
    expect((await record(orderId, second, opsToken, staffNoop).expect(200)).body).toMatchObject({ unchanged: true, consignment: { seq: 2 } });
    expect((await record(orderId, second, opsToken, staffNoop).expect(200)).body.unchanged).toBe(true);
    // A new version answers 201 with no flag.
    expect(amended.body).not.toHaveProperty('unchanged');
    expect((await versions(orderId)).length).toBe(2);
    expect(await sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${noop}`).toEqual([{ n: 0 }]);
  });

  it('AC6 — amend after dispatch: a floor operator is 403 (A46), no reason is 400, the office records v2 recordedAfterDispatch; v1 keeps its stamp; the trigger refuses any rewrite of v1', async () => {
    const orderId = await packedOrder();
    const first = body();
    await record(orderId, first).expect(201);
    await dispatch(orderId).expect(201);
    const extended = { ...first, ewayBill: { ...(first.ewayBill as Record<string, string>), validUntil: istDay(5) } };
    expect((await record(orderId, extended, floorWebToken).expect(403)).body.detail).toMatch(/office role/);
    expect((await record(orderId, extended).expect(400)).body.detail).toMatch(/reason is required/);
    const late = await record(orderId, { ...extended, reason: 'Validity extended' }).expect(201);
    expect(late.body.consignment).toMatchObject({ seq: 2, recordedAfterDispatch: true, dispatchedAt: null });
    const rows = await versions(orderId);
    expect(rows[0]).toMatchObject({ seq: 1, status: 'superseded', end_reason: 'Validity extended' });
    expect(rows[0]!.dispatched_at).not.toBeNull();
    const read = (await readConsignment(orderId).expect(200)).body;
    expect(read.dispatchedRecordId).toBe((await sql`select id from order_consignment_records where order_id = ${orderId} and seq = 1`)[0]!.id);
    expect(read.gate.state).toBe('dispatched');
    await expect(sql`update order_consignment_records set brand_document_number = 'X' where order_id = ${orderId} and seq = 1`).rejects.toThrow(/immutable/);
    // Withdrawing after the goods left is refused.
    expect((await withdraw(orderId, 'wrong').expect(409)).body.code).toBe('order-dispatched');
  });

  it('A46 — an exemption: the floor operator is 403; the office records exempt-goods (ewayStatus exempt) and the order ships', async () => {
    const orderId = await packedOrder();
    const exempt = body({ ewayBill: undefined, ewayExemption: { reason: 'exempt-goods' } });
    expect((await record(orderId, exempt, floorWebToken).expect(403)).body.detail).toBe('Only an office role can record an e-way exemption.');
    expect((await record(orderId, exempt).expect(201)).body.consignment.eway).toMatchObject({ status: 'exempt', exemptionReason: 'exempt-goods' });
    await dispatch(orderId).expect(201);
  });

  // ── the e-way number, isolation ────────────────────────────────────────────

  it('AC7 — the same e-way number live on another ACME order is 409 eway-bill-in-use naming it; BETA may hold it (per-client); BETA cannot read or record on ACME’s order (404) nor see its needed list', async () => {
    const number = ewb();
    const holder = await packedOrder();
    await record(holder, body({ ewayBill: { number, date: istDay(), validUntil: istDay(1) } })).expect(201);
    const other = await packedOrder();
    const inUse = await record(other, body({ ewayBill: { number, date: istDay(), validUntil: istDay(1) } })).expect(409);
    expect(inUse.body).toMatchObject({ code: 'eway-bill-in-use', orderId: holder });
    const betaOrder = await packedOrder({ code: 'B-TEE' });
    // BETA has no GSTIN on file: its portal user names the consignor.
    await portalRecord(betaOrder, body({ consignorGstin: '29AAACB1234F1Z5', ewayBill: { number, date: istDay(), validUntil: istDay(1) } }), betaPortal).expect(201);
    // The staff-only cross-client warning on ACME's read; never on the portal.
    expect((await readConsignment(holder).expect(200)).body.ewayUsedByOtherClient).toMatchObject({ clientCode: 'BETA' });
    const portalRead = (await http().get(`${API}/${tenantId}/portal/orders/${holder}/consignment`).set('Authorization', `Bearer ${acmePortal}`).expect(200)).body;
    expect(Object.keys(portalRead).sort()).toEqual(['gate', 'history', 'live']);
    await http().get(`${API}/${tenantId}/portal/orders/${holder}/consignment`).set('Authorization', `Bearer ${betaPortal}`).expect(404);
    await portalRecord(holder, body(), betaPortal).expect(404);
    const needed = await http().get(`${API}/${tenantId}/portal/consignments/needed`).set('Authorization', `Bearer ${betaPortal}`).expect(200);
    expect((needed.body.items as { orderId: string }[]).every((row) => row.orderId !== other)).toBe(true);
    const acmeNeeded = await http().get(`${API}/${tenantId}/portal/consignments/needed`).set('Authorization', `Bearer ${acmePortal}`).expect(200);
    expect((acmeNeeded.body.items as { orderId: string }[]).map((r) => r.orderId)).toContain(other);
  });

  // ── withdraw and the cancels ──────────────────────────────────────────────

  it('withdraw (orders.manage): the version withdrawn, the gate refuses again; a floor operator is 403; nothing live is 409', async () => {
    const orderId = await packedOrder();
    await record(orderId, body()).expect(201);
    await withdraw(orderId, 'Wrong invoice', floorWebToken).expect(403);
    const key = ulid();
    const out = await withdraw(orderId, 'Wrong invoice', opsToken, key).expect(200);
    expect(out.body.consignment).toBeNull();
    expect(out.body.history[0]).toMatchObject({ status: 'withdrawn', endReason: 'Wrong invoice' });
    await expectAuditRow({ tenantId, key, action: 'consignment.withdrawn', targetType: 'order', targetId: orderId, actorUserId: opsId });
    expect((await dispatch(orderId).expect(409)).body.code).toBe('consignment-documents-missing');
    expect((await withdraw(orderId, 'again').expect(409)).body.code).toBe('consignment-not-found');
  });

  it('A38 — a cancel withdraws the record ("Order cancelled") and frees its e-way number; a cancel with restock of a packed order does too', async () => {
    const number = ewb();
    const accepted = await acceptedOrder();
    await record(accepted, body({ ewayBill: { number, date: istDay(), validUntil: istDay(1) } })).expect(201);
    await http().post(`${API}/${tenantId}/outbound/orders/${accepted}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
    expect(await versions(accepted)).toEqual([{ seq: 1, status: 'withdrawn', dispatched_at: null, end_reason: 'Order cancelled' }]);
    const reuse = await packedOrder();
    await record(reuse, body({ ewayBill: { number, date: istDay(), validUntil: istDay(1) } })).expect(201);
    expect((await record(accepted, body()).expect(409)).body.code).toBe('order-not-open');

    const packed = await packedOrder();
    await record(packed, body()).expect(201);
    await http().post(`${API}/${tenantId}/outbound/orders/${packed}/cancel-with-restock`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(200);
    expect((await versions(packed))[0]).toMatchObject({ status: 'withdrawn', end_reason: 'Order cancelled' });
  });

  // ── AC5: the handheld's stale snapshot ─────────────────────────────────────

  it('AC5 — a device handover of a parcel whose record was withdrawn settles it: dispatched, its shipment flagged, "Left without documents" lists it, a late record valid on the handover day clears it', async () => {
    const ok = await packedOrder();
    await record(ok, body()).expect(201);
    const stale = await packedOrder();
    await record(stale, body()).expect(201);
    await withdraw(stale, 'Brand re-issuing').expect(200);
    const key = ulid();
    const device = await handOver({ occurredAt: new Date().toISOString(), parcels: [{ orderId: ok, awb: 'AWBDEV0001' }, { orderId: stale, awb: 'AWBDEV0002' }] }, operatorToken, key).expect(201);
    expect(device.body.refused).toEqual([]);
    expect(device.body.parcels.find((p: { orderId: string }) => p.orderId === stale)).toMatchObject({ complianceException: 'consignment-documents-missing' });
    expect(device.body.parcels.find((p: { orderId: string }) => p.orderId === ok)).not.toHaveProperty('complianceException');
    expect(await orderStatus(stale)).toBe('dispatched');
    expect((await sql`select compliance_exception from shipments where order_id = ${stale}`)[0]!.compliance_exception).toBe('consignment-documents-missing');
    const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key} and action = 'handover.created'`)[0]!.changes as { complianceExceptions: unknown };
    expect(audit.complianceExceptions).toEqual([{ orderId: stale, code: 'consignment-documents-missing' }]);
    expect((await worklist('exceptions').expect(200)).body.exceptions.map((r: { orderId: string }) => r.orderId)).toContain(stale);
    await record(stale, body({ reason: 'Recorded after the pickup' })).expect(201);
    expect((await worklist('exceptions').expect(200)).body.exceptions.map((r: { orderId: string }) => r.orderId)).not.toContain(stale);
    const detail = await http().get(`${API}/${tenantId}/outbound/handovers/${device.body.handover.id as string}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(detail.body.handover.parcels.find((p: { orderId: string }) => p.orderId === stale)).toMatchObject({
      taxDocument: null,
      complianceException: 'consignment-documents-missing',
      lateRecord: { seq: 2, brandDocument: { number: 'INV/26-27/0042' } },
    });
  });

  it('A31 — recall first: a recalled lot with no documents is refused order-holds-recalled-batch on the device (never flagged) and by per-order dispatch', async () => {
    await http().post(`${API}/${tenantId}/inventory/adjustments`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: sku.get('A-LOT'), binId, quantityDelta: 2, reasonCode: 'stock-count', note: 'lot seed', batch: { code: 'LOT-CC-1' } }).expect(201);
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
    const recalled = await packedOrder({ code: 'A-LOT' });
    const lot = (await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku.get('A-LOT')!} and code = 'LOT-CC-1'`)[0]!.id as string;
    await http().post(`${API}/${tenantId}/inventory/recalls`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ batchIds: [lot], reasonNote: 'consignment suite', mode: 'live' }).expect(201);
    const device = await handOver({ occurredAt: new Date().toISOString(), parcels: [{ orderId: recalled, awb: 'AWBRCL0101' }] }, operatorToken).expect(201);
    expect(device.body.refused.map((r: { code: string }) => r.code)).toEqual(['order-holds-recalled-batch']);
    expect((await dispatch(recalled).expect(409)).body.code).toBe('order-holds-recalled-batch');
  });

  it('A35 — a 100th version is 409 consignment-version-limit', async () => {
    const orderId = await packedOrder();
    await record(orderId, body()).expect(201);
    // 98 more superseded versions under the live one (seq 99 live).
    await sql`update order_consignment_records set status = 'superseded', ended_at = now(), ended_by = ${opsId}, end_reason = 'x' where order_id = ${orderId}`;
    await sql`insert into order_consignment_records (id, tenant_id, client_id, warehouse_id, order_id, seq, status, brand_document_type, brand_document_number, brand_document_date,
        consignor_gstin, consignor_snapshot, declared_value_paise, threshold_rule, eway_required, eway_status, recorded_after_dispatch, source, recorded_by, recorded_at, ended_at, ended_by, end_reason)
      select gen_random_uuid(), tenant_id, client_id, warehouse_id, order_id, g, case when g = 99 then 'live' else 'superseded' end, 'invoice', 'INV-' || g, brand_document_date,
        consignor_gstin, consignor_snapshot, 100, 'national', false, 'not-required', false, 'web', recorded_by, now(),
        case when g = 99 then null else now() end, case when g = 99 then null else ${opsId}::uuid end, case when g = 99 then null else 'x' end
      from order_consignment_records, generate_series(2, 99) g where order_id = ${orderId} and seq = 1`;
    expect((await record(orderId, body()).expect(409)).body.code).toBe('consignment-version-limit');
  });

  // ── the client's documents rule ────────────────────────────────────────────

  it('A11 — the documents rule: all makes a B2C order need a record; high-value lets a B2B one under the floor ship; the self client is 400; an unchanged rule is a no-op; reads and the ClientDto carry it', async () => {
    const put = (clientId: string, documentRule: string, key = ulid()) =>
      http().put(`${API}/${tenantId}/clients/${clientId}/consignment-policy`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key).send({ documentRule });
    const ownerId = (await sql`select id from users where tenant_id = ${tenantId} and role = 'owner'`)[0]!.id as string;
    const key = ulid();
    expect((await put(beta, 'all', key).expect(200)).body.client.consignmentPolicy).toEqual({ documentRule: 'all' });
    await expectAuditRow({ tenantId, key, action: 'client.consignment_policy_updated', targetType: 'client', targetId: beta, actorUserId: ownerId });
    const b2c = await packedOrder({ code: 'B-TEE', extra: { orderType: 'b2c' } });
    expect((await dispatch(b2c).expect(409)).body.requiredBecause).toBe('policy-all');
    await put(beta, 'high-value').expect(200);
    const b2b = await packedOrder({ code: 'B-TEE' });
    await dispatch(b2b).expect(201);
    const same = ulid();
    noOpIdempotencyKey(tenantId, same, 'clients.consignmentPolicy:unchanged');
    await put(beta, 'high-value', same).expect(200);
    expect((await put(selfClient, 'all').expect(400)).body.detail).toMatch(/own goods/);
    expect((await put(beta, 'none').expect(400)).body.detail).toMatch(/documentRule must be one of/);
    expect((await http().get(`${API}/${tenantId}/clients/${beta}/consignment-policy`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body).toEqual({ clientId: beta, documentRule: 'high-value' });
    await put(beta, 'b2b').expect(200);
  });

  // ── the reads ─────────────────────────────────────────────────────────────

  it('the reads: the order list and the device parcels carry the consignment state; the candidates mark a blocking parcel; the vocabulary ends with the three codes (A31)', async () => {
    const orderId = await packedOrder();
    const list = await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/orders?status=ready_to_dispatch&limit=100`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect((list.body.items as { id: string; consignmentState?: string }[]).find((row) => row.id === orderId)?.consignmentState).toBe('missing');
    const candidates = await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/handover-candidates?clientId=${acme}&limit=200`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect((candidates.body.items as { orderId: string; consignment?: unknown }[]).find((row) => row.orderId === orderId)?.consignment).toEqual({
      state: 'missing',
      blocking: true,
      ewayBillNumber: null,
      ewayValidUntil: null,
    });
    const snapshot = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    expect((snapshot.body.dispatchParcels as { orderId: string; consignment?: { state: string } }[]).find((row) => row.orderId === orderId)?.consignment?.state).toBe('missing');
    expect(HANDOVER_PARCEL_REFUSALS.slice(-3)).toEqual(['consignment-documents-missing', 'eway-bill-required', 'eway-bill-expired']);
  });

  // ── races (guide §1: the parked-waiter pattern) ──────────────────────────

  async function waitParked(holderPid: number, min: number): Promise<void> {
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active' and a.datname = current_database()
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
      throw new Error(`fewer than ${min} request(s) parked on the order row`);
    } finally {
      await probe.end();
    }
  }

  /** Holds the ORDER row (the lock every record writer takes first) while `sends` park on it, then releases. */
  async function raceOnOrder(orderId: string, sends: (() => request.Test)[]): Promise<request.Response[]> {
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    const pending: Promise<request.Response>[] = [];
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`select pg_backend_pid() as pid from orders where tenant_id = ${tenantId} and id = ${orderId} for update`) as unknown as { pid: number }[];
        for (const send of sends) pending.push((async () => send())());
        await waitParked(locked[0]!.pid, sends.length);
      });
      return await Promise.all(pending);
    } finally {
      await Promise.allSettled(pending);
      await holder.end();
    }
  }

  it('the same-key race: two requests parked on the order lock answer the same 201 body; one version, one key, one audit row (mutation-check: the second replay)', async () => {
    const orderId = await packedOrder();
    const key = ulid();
    const payload = body();
    const [a, b] = await raceOnOrder(orderId, [() => record(orderId, payload, opsToken, key), () => record(orderId, payload, opsToken, key)]);
    expect([a!.status, b!.status]).toEqual([201, 201]);
    expect(a!.body).toEqual(b!.body);
    expect(await versions(orderId)).toHaveLength(1);
    expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
    expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${key}`).toHaveLength(1);
  });

  it('two orders racing for one e-way number: one 201, one 409 eway-bill-in-use (the per-client live index is the backstop)', async () => {
    const number = ewb();
    const first = await packedOrder();
    const second = await packedOrder();
    const payload = body({ ewayBill: { number, date: istDay(), validUntil: istDay(1) } });
    const results = await Promise.all([record(first, payload), record(second, payload)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('eway-bill-in-use');
    expect(await sql`select count(*)::int as n from order_consignment_records where tenant_id = ${tenantId} and eway_bill_number = ${number} and status = 'live'`).toEqual([{ n: 1 }]);
  });

  // ── A46 on the portal: the brand speaks for its own documents ──────────────

  it('A46 — the PORTAL may record an exemption and amend after dispatch (the brand issues its documents), but an amendment after dispatch still needs a reason, and the audit row names the portal user', async () => {
    const orderId = await packedOrder();
    const exempt = body({ ewayBill: undefined, ewayExemption: { reason: 'non-motorised' } });
    expect((await portalRecord(orderId, exempt).expect(201)).body.consignment.eway.status).toBe('exempt');
    await dispatch(orderId).expect(201);
    const amended = body();
    expect((await portalRecord(orderId, amended).expect(400)).body.detail).toMatch(/reason is required/);
    const key = ulid();
    expect((await portalRecord(orderId, { ...amended, reason: 'Bill generated after all' }, acmePortal, key).expect(201)).body.consignment).toMatchObject({ seq: 2, recordedAfterDispatch: true, recordedByYou: true });
    await expectAuditRow({ tenantId, key, action: 'consignment.recorded', targetType: 'order', targetId: orderId, actorUserId: acmePortalId });
  });

  // ── A50: the threshold branches, directly ──────────────────────────────────

  it('A50 — thresholdForMovement: destination unknown takes the LOWER of national and the from-state override (an override below wins, above loses, NULL never wins); intra with a NULL override needs none; no from-state is national; value == threshold is not required', async () => {
    const t = uuidv7();
    const by = uuidv7();
    await sql`insert into eway_state_thresholds (id, tenant_id, state_code, threshold_paise, effective_from, created_by) values
      (${uuidv7()}, ${t}, '27', 3000000, '2020-01-01', ${by}),
      (${uuidv7()}, ${t}, '29', 10000000, '2020-01-01', ${by}),
      (${uuidv7()}, ${t}, '33', null, '2020-01-01', ${by})`;
    const db = app.get<unknown>(DATABASE) as Database;
    const judge = (fromState: string | null, toState: string | null) =>
      withTenantTransaction(db, t, (tx: TenantTx) => thresholdForMovement(tx, t, { fromState, toState, istDate: istDay() }));
    expect(await judge('27', null)).toEqual({ thresholdPaise: 3_000_000, rule: 'state:27', supplyType: null });
    expect(await judge('29', null)).toEqual({ thresholdPaise: 5_000_000, rule: 'national', supplyType: null });
    expect(await judge('33', null)).toEqual({ thresholdPaise: 5_000_000, rule: 'national', supplyType: null });
    expect(await judge('07', null)).toEqual({ thresholdPaise: 5_000_000, rule: 'national', supplyType: null });
    expect(await judge('33', '33')).toEqual({ thresholdPaise: null, rule: 'state:33', supplyType: 'intra' });
    expect(await judge('27', '29')).toEqual({ thresholdPaise: 5_000_000, rule: 'national', supplyType: 'inter' });
    expect(await judge(null, '29')).toEqual({ thresholdPaise: 5_000_000, rule: 'national', supplyType: null });
    expect(ewayRequired(5_000_000, { thresholdPaise: 5_000_000, rule: 'national' })).toBe(false);
    expect(ewayRequired(5_000_001, { thresholdPaise: 5_000_000, rule: 'national' })).toBe(true);
    expect(ewayRequired(99_000_000, { thresholdPaise: null, rule: 'state:33' })).toBe(false);
  });

  it('A50 — a floor exactly at the national threshold needs no record (strictly above): a B2C order rated 1 × ₹50,000 ships', async () => {
    const orderId = await packedOrder({ quantity: 1, ratePaise: 5_000_000, extra: { orderType: 'b2c' } });
    await dispatch(orderId).expect(201);
  });

  // ── A50: the partial indexes, on the REAL queries (guide §5: ANALYZE first) ─

  it('A50 — EXPLAIN: the live read uses order_consignment_records_live_unique; the worklist passes use orders_ready_to_dispatch_idx and orders_accepted_tenant_warehouse_idx (D3); the exceptions read shipments_compliance_exception_idx; the portal list orders_tenant_client_open_idx', async () => {
    const wh = uuidv7();
    const client = uuidv7();
    const template = await acceptedOrder();
    // 24,200 orders of a fake warehouse and client (the template row's columns, fresh ids): 2,200 packed and
    // 2,200 accepted among a history of dispatched ones — a real warehouse's shape.
    await sql`
      insert into orders
      select (jsonb_populate_record(null::orders, to_jsonb(o) || jsonb_build_object(
        'id', gen_random_uuid(), 'warehouse_id', ${wh}::uuid, 'client_id', ${client}::uuid,
        'status', case g % 11 when 0 then 'accepted' when 1 then 'ready_to_dispatch' else 'dispatched' end,
        'client_order_ref', null, 'external_event_id', null, 'source_payload_hash', null,
        'follow_on_of_order_id', null, 'follow_on_root_order_id', null, 'follow_on_seq', null,
        'created_at', now() - (g || ' minutes')::interval, 'updated_at', now() - (g || ' minutes')::interval))).*
      from orders o, generate_series(1, 24200) g where o.id = ${template}`;
    // 3,000 handed-over shipments of that warehouse, 20 flagged.
    await sql`
      insert into shipments (id, tenant_id, warehouse_id, order_id, client_id, status, kind, carrier_name, tracking_number, label_attachment_id, package_count, labelled_by, labelled_at, recorded_surface,
        handover_id, handed_over_at, label_verified_at, label_verified_by, label_verify_method, compliance_exception)
      select gen_random_uuid(), ${tenantId}, ${wh}, gen_random_uuid(), ${client}, 'handed_over', 'client-label', 'Delhivery', 'AWBX' || g, gen_random_uuid(), 1, ${opsId}, now(), 'portal',
        gen_random_uuid(), now() - (g || ' minutes')::interval, now(), ${opsId}, 'handover-scan', case when g % 150 = 0 then 'consignment-documents-missing' else null end
      from generate_series(1, 3000) g`;
    // 3,000 consignment versions of fake orders (live and superseded).
    await sql`
      insert into order_consignment_records (id, tenant_id, client_id, warehouse_id, order_id, seq, status, brand_document_type, brand_document_number, brand_document_date,
        consignor_gstin, consignor_snapshot, declared_value_paise, threshold_rule, eway_required, eway_status, recorded_after_dispatch, source, recorded_by, recorded_at, ended_at, ended_by, end_reason)
      select gen_random_uuid(), ${tenantId}, ${client}, ${wh}, gen_random_uuid(), 1, case when g % 3 = 0 then 'live' else 'superseded' end, 'invoice', 'INV-X' || g, current_date,
        '29ABCDE1234F1Z5', '{"v":1}'::jsonb, 100, 'national', false, 'not-required', false, 'web', ${opsId}, now(),
        case when g % 3 = 0 then null else now() end, case when g % 3 = 0 then null else ${opsId}::uuid end, case when g % 3 = 0 then null else 'x' end
      from generate_series(1, 3000) g`;
    await sql`analyze orders`;
    await sql`analyze shipments`;
    await sql`analyze order_consignment_records`;
    const db = app.get<unknown>(DATABASE) as unknown as TenantTx;
    const plan = async (query: { toSQL(): { sql: string; params: unknown[] } }) => {
      const { sql: text, params } = query.toSQL();
      return (await sql.unsafe(`explain ${text}`, params as never[])).map((row) => Object.values(row)[0]).join('\n');
    };
    const someOrders = ((await sql`select order_id from order_consignment_records where tenant_id = ${tenantId} and client_id = ${client} limit 5`) as unknown as { order_id: string }[]).map((r) => r.order_id);
    expect(await plan(liveConsignmentRecordsQuery(db, tenantId, someOrders))).toContain('order_consignment_records_live_unique');
    // D3 — each pass is bounded by an OPEN-orders partial index, never a scan of the dispatched history. The
    // planner picks the pass's own index (0116 / 0104) or 0101's open-orders index (a skip scan on
    // tenant + warehouse, then a top-N sort of at most 5,001 rows): either keeps the read to open orders.
    const packedPlan = await plan(consignmentNeededPassQuery(db, tenantId, wh, null, 'ready_to_dispatch', 5001));
    expect(packedPlan).toMatch(/orders_ready_to_dispatch_idx|orders_tenant_client_open_idx/);
    expect(packedPlan).not.toMatch(/Seq Scan on orders/);
    const acceptedPlan = await plan(consignmentNeededPassQuery(db, tenantId, wh, null, 'accepted', 5001));
    expect(acceptedPlan).toMatch(/orders_accepted_tenant_warehouse_idx|orders_tenant_client_open_idx/);
    expect(acceptedPlan).not.toMatch(/Seq Scan on orders/);
    // A small page (the shape a later page cap would give) takes the pass's own ordered index.
    expect(await plan(consignmentNeededPassQuery(db, tenantId, wh, null, 'ready_to_dispatch', 50))).toContain('orders_ready_to_dispatch_idx');
    expect(await plan(consignmentNeededPassQuery(db, tenantId, wh, null, 'accepted', 50))).toContain('orders_accepted_tenant_warehouse_idx');
    expect(await plan(consignmentExceptionsQuery(db, tenantId, wh, null))).toContain('shipments_compliance_exception_idx');
    expect(await plan(portalOpenOrdersQuery(db, tenantId, client))).toContain('orders_tenant_client_open_idx');
  });

  it('the routes are in the OpenAPI document', async () => {
    const doc = (await http().get('/api/v1/openapi.json').expect(200)).body as { paths: Record<string, Record<string, unknown>> };
    for (const [path, method] of [
      ['/tenants/{tenantId}/outbound/orders/{orderId}/consignment', 'post'],
      ['/tenants/{tenantId}/outbound/orders/{orderId}/consignment', 'get'],
      ['/tenants/{tenantId}/outbound/orders/{orderId}/consignment/withdraw', 'post'],
      ['/tenants/{tenantId}/warehouses/{warehouseId}/outbound/consignments', 'get'],
      ['/tenants/{tenantId}/clients/{clientId}/consignment-policy', 'get'],
      ['/tenants/{tenantId}/clients/{clientId}/consignment-policy', 'put'],
      ['/tenants/{tenantId}/portal/orders/{orderId}/consignment', 'get'],
      ['/tenants/{tenantId}/portal/orders/{orderId}/consignment', 'post'],
      ['/tenants/{tenantId}/portal/consignments/needed', 'get'],
    ] as const) {
      expect([path, method, doc.paths[path]?.[method] === undefined ? 'missing' : 'present']).toEqual([path, method, 'present']);
    }
  });
});
