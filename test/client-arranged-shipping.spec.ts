import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import request from 'supertest';
import type { PDFDict } from 'pdf-lib';
import { PDFDocument } from 'pdf-lib';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { AttachmentsFacade } from '../src/modules/attachments/attachments.facade';
import type { FileStore, FilePut, PresignGet, PresignedUrl } from '../src/modules/attachments/file-store';
import { MailFacade } from '../src/modules/mail/mail.facade';
import { EMAIL_GATEWAY, type LogEmailGateway } from '../src/modules/mail/email.gateway';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { REJECTED_OP_DECISIONS_BY_TYPE } from '../src/modules/tenancy/sync-report.command';
import { parcelTagCode } from '../src/shared/primitives/parcel-tag';
import { portalShippingStatus } from '../src/modules/outbound/shipping.read';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
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
const JPEG = readFileSync(join(__dirname, 'fixtures', 'images', 'baseline.jpg'));

/** An in-memory file store (the port's e2e fake) — `get` serves the mail renderer. */
class MemoryFileStore implements FileStore {
  readonly mode = 'local' as const;
  readonly objects = new Map<string, Buffer>();
  async put(input: FilePut): Promise<void> {
    this.objects.set(input.key, Buffer.from(input.bytes));
  }
  async presignGet(input: PresignGet): Promise<PresignedUrl> {
    return { url: `https://files.example/${input.key}?fn=${encodeURIComponent(input.filename)}`, expiresAt: new Date(Date.now() + 300_000).toISOString() };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async get(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new Error(`no object ${key}`);
    return bytes;
  }
}

async function labelPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([288, 432]).drawText(`AWB label page ${i + 1}`, { x: 20, y: 400, size: 10 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function encryptedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([288, 432]);
  doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -4 }) as PDFDict;
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * Story 4-4a — client-arranged shipping capture, end to end: the client's
 * label and AWB (portal and staff), the verification at the bench (web and
 * handheld), the courier handover on both surfaces (all-or-nothing on the
 * web, partial on the handheld with its review row), the dispatch it does,
 * the documents and the signed sheet with their emails, the cancels' voids,
 * the reads and the isolation, and the goldens of the new hashes.
 */
describe('client-arranged shipping capture (e2e, story 4-4a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let relay: OutboxRelay;
  let mail: MailFacade;
  let captured: LogEmailGateway;
  let store: MemoryFileStore;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsId: string;
  let accountantToken: string;
  let operatorToken: string;
  let operatorId: string;
  let deviceToken: string;
  let deviceId: string;
  let warehouseId: string;
  let binId: string;
  let acme: string;
  let beta: string;
  let acmePortal: string;
  let betaPortal: string;
  let transporterId: string;
  let sandboxConnectionId: string;
  const sku = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('clientarranged');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    mail = app.get(MailFacade);
    captured = app.get<LogEmailGateway>(EMAIL_GATEWAY);
    store = new MemoryFileStore();
    app.get(AttachmentsFacade).fileStore = store;

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Ship Co ${ulid()}`, ownerEmail, password: PASSWORD }).expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email: ownerEmail, password: PASSWORD })).body.accessToken as string;
    const ops = await member('ops_manager');
    opsToken = ops.token;
    opsId = ops.userId;
    accountantToken = (await member('accountant')).token;
    const floor = await member('operator');
    operatorId = floor.userId;

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
    await importCsv(['A-TEE,Acme tee,pcs,1800,,false,false', 'A-LOT,Acme lot tee,pcs,1800,,true,false'], acme);
    await importCsv(['B-TEE,Beta tee,pcs,1800,,false,false'], beta);
    const listed = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of listed.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    for (const code of ['A-TEE', 'B-TEE']) {
      await http().post(`${API}/${tenantId}/inventory/adjustments`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId: sku.get(code), binId, quantityDelta: 100000, reasonCode: 'stock-count', note: 'seed' }).expect(201);
    }
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'Dock scanner', pin: '2468' }).expect(201);
    deviceToken = enrolled.body.deviceToken as string;
    deviceId = enrolled.body.device.id as string;
    operatorToken = (
      await http().post(`${API}/${tenantId}/devices/badge-in`).set('Authorization', `Bearer ${deviceToken}`).send({ operatorEmail: floor.email, pin: '2468' }).expect(200)
    ).body.accessToken as string;

    acmePortal = await portalUser(acme);
    betaPortal = await portalUser(beta);
    transporterId = (
      await http().post(`${API}/${tenantId}/partners`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ code: 'BLUEDART', name: 'Blue Dart Express', roles: ['transporter'] }).expect(201)
    ).body.partner.id as string;
    sandboxConnectionId = (
      await http().post(`${API}/${tenantId}/carriers/connections`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ carrierCode: 'sandbox', accountLabel: 'Sandbox', credential: { accountToken: 'e2e-sandbox-token' } }).expect(201)
    ).body.id as string;
    await http().post(`${API}/${tenantId}/clients/${acme}/contacts`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
      .send({ name: 'Asha', email: 'asha@acme.example', emailEvents: ['order.dispatched', 'shipment.documents'] }).expect(201);
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

  async function portalUser(clientId: string): Promise<string> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role: 'client', clientId }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
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

  /** An ACCEPTED order of one SKU (not yet waved). */
  async function acceptedOrder(code = 'A-TEE', extra: Record<string, unknown> = {}): Promise<string> {
    return fixtures.createOrder([{ skuId: sku.get(code)!, quantity: 1 }], undefined, { clientOrderRef: `SO-${ulid().slice(18)}`, ...extra });
  }

  /** A PACKED (ready_to_dispatch) order of one SKU. */
  async function packedOrder(code = 'A-TEE', extra: Record<string, unknown> = {}): Promise<string> {
    const ready = await fixtures.releasedWave([{ skuId: sku.get(code)!, quantity: 1 }], { clientOrderRef: `SO-${ulid().slice(18)}`, ...extra });
    await fixtures.pickAllLines(ready.picklist);
    await http().post(`${API}/${tenantId}/outbound/orders/${ready.orderId}/pack`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
      .send({ scanned: scannedOf(ready.picklist), weightGrams: 900 }).expect(201);
    return ready.orderId;
  }

  function portalLabel(orderId: string, fields: Record<string, string>, file: Buffer, token = acmePortal, key = ulid()) {
    let req = http().post(`${API}/${tenantId}/portal/orders/${orderId}/shipment/client-label`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key);
    for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
    return req.attach('file', file, { filename: 'label.pdf', contentType: 'application/pdf' });
  }

  function staffLabel(orderId: string, fields: Record<string, string>, file: Buffer, token = opsToken, key = ulid()) {
    let req = http().post(`${API}/${tenantId}/outbound/orders/${orderId}/shipment/client-label`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key);
    for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
    return req.attach('file', file, { filename: 'label.pdf', contentType: 'application/pdf' });
  }

  function awbAdvice(orderId: string, body: Record<string, unknown>, token = opsToken, key = ulid(), portal = false) {
    const path = portal ? `${API}/${tenantId}/portal/orders/${orderId}/shipment/awb` : `${API}/${tenantId}/outbound/orders/${orderId}/shipment/awb`;
    return http().post(path).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function verify(orderId: string, body: Record<string, unknown>, token = opsToken, key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/orders/${orderId}/shipment/verify`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function handOver(body: Record<string, unknown>, token = opsToken, key = ulid()) {
    return http().post(`${API}/${tenantId}/outbound/handovers`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key)
      .send({ warehouseId, clientId: acme, courier: { courierName: 'Delhivery' }, pickupPersonName: 'Ravi', vehicleNumber: 'KA01AB1234', ...body });
  }

  function shipping(orderId: string, token = opsToken) {
    return http().get(`${API}/${tenantId}/outbound/orders/${orderId}/shipping`).set('Authorization', `Bearer ${token}`);
  }

  function uploadDocument(orderId: string, kind: string, file: Buffer, token = opsToken, portal = false, key = ulid()) {
    const path = portal ? `${API}/${tenantId}/portal/orders/${orderId}/documents` : `${API}/${tenantId}/outbound/orders/${orderId}/documents`;
    return http().post(path).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).field('kind', kind)
      .attach('file', file, { filename: 'doc', contentType: 'application/octet-stream' });
  }

  async function orderStatus(orderId: string): Promise<string> {
    return (await sql`select status from orders where id = ${orderId}`)[0]!.status as string;
  }

  async function shipmentsOf(orderId: string): Promise<Record<string, unknown>[]> {
    return (await sql`select * from shipments where order_id = ${orderId} order by created_at, id`) as unknown as Record<string, unknown>[];
  }

  const drain = async () => {
    await sql`update outbox_messages set next_attempt_at = now() where tenant_id = ${tenantId} and status = 'pending' and next_attempt_at > now()`;
    return relay.drain(500);
  };

  async function storedHash(key: string): Promise<string> {
    return (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.payload_hash as string;
  }

  // ── the label and the AWB (A8, A9) ─────────────────────────────────────────

  it('portal label upload: 201, client-label labelled, the AWB normalised, the file attached with its page count, the portal hash golden and the audit', async () => {
    const orderId = await acceptedOrder();
    const key = ulid();
    const pdf = await labelPdf(2);
    const res = await portalLabel(orderId, { awb: '1234 5678 9012', courierName: 'Delhivery', packageCount: '1' }, pdf, acmePortal, key).expect(201);
    expect(res.body.shipment).toMatchObject({ orderId, kind: 'client-label', status: 'labelled', courierName: 'Delhivery', awb: '123456789012', packageCount: 1 });
    expect(Object.keys(res.body.shipment).sort()).toEqual(['awb', 'courierName', 'id', 'kind', 'orderId', 'packageCount', 'recordedAt', 'status']);
    const staff = await shipping(orderId).expect(200);
    expect(staff.body.label).toMatchObject({ purpose: 'shipping-label', contentType: 'application/pdf', pageCount: 2, source: 'portal' });
    expect(staff.body.label.fileName).toMatch(/-label\.pdf$/);
    expect(staff.body.parcelTagCode).toBe(parcelTagCode(orderId));
    expect(await storedHash(key)).toBe(
      hashCommandPayload({
        surface: 'portal',
        arm: 'client-label',
        tenantId,
        clientId: acme,
        orderId,
        rawSha256: (await import('node:crypto')).createHash('sha256').update(pdf).digest('hex'),
        awb: '123456789012',
        courierName: 'Delhivery',
        packageCount: 1,
        replace: false,
      }),
    );
    const portalUserId = (await sql`select id from users where tenant_id = ${tenantId} and client_id = ${acme} limit 1`)[0]!.id as string;
    await expectAuditRow({ tenantId, key, action: 'shipment.client_label_recorded', targetType: 'order', targetId: orderId, actorUserId: portalUserId });
    // Replay: the same key and body re-serve; a different body is 422.
    expect((await portalLabel(orderId, { awb: '1234 5678 9012', courierName: 'Delhivery', packageCount: '1' }, pdf, acmePortal, key).expect(201)).body).toEqual(res.body);
    expect((await portalLabel(orderId, { awb: '999988887777', courierName: 'Delhivery' }, pdf, acmePortal, key).expect(422)).body.code).toBe('idempotency-key-reuse');
    // The portal read.
    const portal = await http().get(`${API}/${tenantId}/portal/orders/${orderId}/shipping`).set('Authorization', `Bearer ${acmePortal}`).expect(200);
    expect(portal.body).toMatchObject({ status: 'label-received', courierName: 'Delhivery', awb: '123456789012' });
    expect(portal.body.label).toMatchObject({ kind: 'label', uploadedByYou: true, pageCount: 2 });
    expect(Object.keys(portal.body.label)).not.toContain('uploadedBy');
  });

  it('a second label without replace is 409 shipment-exists naming the AWB; replace voids the old one ("Replaced by the client") and removes its file', async () => {
    const orderId = await acceptedOrder();
    const first = await portalLabel(orderId, { awb: 'AWBREPL0001', courierName: 'Delhivery' }, await labelPdf(1)).expect(201);
    const refused = await portalLabel(orderId, { awb: 'AWBREPL0002', courierName: 'Delhivery' }, await labelPdf(1)).expect(409);
    expect(refused.body.code).toBe('shipment-exists');
    expect(refused.body.awb).toBe('AWBREPL0001');
    // The same AWB on a replace is not refused by its own shipment (D7).
    const replaced = await portalLabel(orderId, { awb: 'AWBREPL0001', courierName: 'Delhivery', replace: 'true' }, await labelPdf(1)).expect(201);
    expect(replaced.body.shipment.id).not.toBe(first.body.shipment.id);
    const rows = await shipmentsOf(orderId);
    expect(rows.map((row) => [row.status, row.void_reason])).toEqual([
      ['voided', 'Replaced by the client'],
      ['labelled', null],
    ]);
    const oldFile = (await sql`select status, removed_reason from attachments where id = ${rows[0]!.label_attachment_id as string}`)[0]!;
    expect(oldFile).toMatchObject({ status: 'removed', removed_reason: 'Replaced by the client' });
  });

  it('an AWB on another OPEN order of the client is 409 awb-in-use naming the client’s own order; another client may use it', async () => {
    const one = await acceptedOrder();
    const two = await acceptedOrder();
    await awbAdvice(one, { awb: 'lr/2026/0099', courierName: 'VRL' }).expect(201);
    const refused = await awbAdvice(two, { awb: 'LR/2026/0099', courierName: 'VRL' }).expect(409);
    expect(refused.body.code).toBe('awb-in-use');
    expect(refused.body.orderId).toBe(one);
    const betaOrder = await acceptedOrder('B-TEE');
    await awbAdvice(betaOrder, { awb: 'LR/2026/0099', courierName: 'VRL' }).expect(201);
  });

  it('refuses a JPEG as a label (415), an encrypted PDF (422 pdf-unreadable), a cancelled order (409 order-not-open), an unknown or another client’s order in the portal (404), and a role without labels.execute (403)', async () => {
    const orderId = await acceptedOrder();
    expect((await staffLabel(orderId, { awb: 'AWBJPEG001', courierName: 'X' }, JPEG).expect(415)).body.code).toBe('attachment-type-unsupported');
    const enc = await staffLabel(orderId, { awb: 'AWBENC0001', courierName: 'X' }, await encryptedPdf()).expect(422);
    expect(enc.body.code).toBe('pdf-unreadable');
    expect(enc.body.detail).toMatch(/password or print restriction/);
    const cancelled = await acceptedOrder();
    await http().post(`${API}/${tenantId}/outbound/orders/${cancelled}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({});
    expect((await awbAdvice(cancelled, { awb: 'AWBCXL0001', courierName: 'X' }).expect(409)).body.code).toBe('order-not-open');
    expect((await portalLabel(orderId, { awb: 'AWBBETA001', courierName: 'X' }, await labelPdf(1), betaPortal).expect(404)).body.code).toBe('not-found');
    expect((await http().get(`${API}/${tenantId}/portal/orders/${orderId}/shipping`).set('Authorization', `Bearer ${betaPortal}`).expect(404)).body.code).toBe('not-found');
    expect((await awbAdvice(orderId, { awb: 'AWBROLE001', courierName: 'X' }, accountantToken).expect(403)).body.code).toBe('role-denied');
    // A portal caller cannot name a transporter (staff master data); a bad AWB is 400.
    expect((await awbAdvice(orderId, { awb: 'AWBX', courierName: 'X', transporterId }, acmePortal, ulid(), true).expect(400)).body.code).toBe('validation-failed');
    expect((await awbAdvice(orderId, { awb: 'O0123456789ABCDEF', courierName: 'X' }).expect(400)).body.detail).toMatch(/parcel tag/);
  });

  it('a carrier label on the order is 409 shipment-exists; a voided client label no longer blocks a carrier label (A28)', async () => {
    const orderId = await packedOrder();
    await staffLabel(orderId, { awb: 'AWBA280001', transporterId }, await labelPdf(1)).expect(201);
    const voidKey = ulid();
    await http().post(`${API}/${tenantId}/outbound/orders/${orderId}/shipment/void`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, voidKey)
      .send({ reason: 'Client changed courier' }).expect(200);
    await expectAuditRow({ tenantId, key: voidKey, action: 'shipment.voided', targetType: 'order', targetId: orderId, actorUserId: opsId });
    const carrier = await http().post(`${API}/${tenantId}/outbound/orders/${orderId}/label`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
      .send({ carrierConnectionId: sandboxConnectionId }).expect(201);
    expect(carrier.body.shipment.carrierCode).toBe('sandbox');
    const refused = await awbAdvice(orderId, { awb: 'AWBA280002', courierName: 'X' }).expect(409);
    expect(refused.body.code).toBe('shipment-exists');
    // The read is live-first (A16): the carrier shipment, not the voided one.
    const read = await http().get(`${API}/${tenantId}/outbound/orders/${orderId}/shipment`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(read.body.shipment).toMatchObject({ kind: 'carrier', status: 'labelled' });
    // A manifest refuses a client-arranged shipment by name.
    const other = await acceptedOrder();
    const advice = await awbAdvice(other, { awb: 'AWBMANI001', courierName: 'X' }).expect(201);
    const manifest = await http().post(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/manifests`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
      .send({ shipmentIds: [advice.body.shipment.id] }).expect(409);
    expect(manifest.body.detail).toContain('client-arranged');
  });

  // ── the verification (A11, A48) ────────────────────────────────────────────

  it('verify: a matching scan verifies (audit); a second verify is the no-op; a mismatch is 422 label-mismatch; a courier label is 409 no-client-label', async () => {
    const orderId = await packedOrder();
    await staffLabel(orderId, { awb: 'AWBVER0001', courierName: 'Delhivery' }, await labelPdf(1)).expect(201);
    expect((await verify(orderId, { scannedCode: 'AWBVER9999', method: 'scan' }).expect(422)).body).toMatchObject({ code: 'label-mismatch', scanned: 'AWBVER9999' });
    const key = ulid();
    const ok = await verify(orderId, { scannedCode: 'awb-ver-0001', method: 'scan' }, opsToken, key).expect(200);
    expect(ok.body.verified).toBe(true);
    expect(ok.body.shipment).toMatchObject({ labelVerifyMethod: 'scan' });
    expect(ok.body.shipment.labelVerifiedAt).not.toBeNull();
    await expectAuditRow({ tenantId, key, action: 'shipment.label_verified', targetType: 'order', targetId: orderId, actorUserId: opsId });
    expect((await verify(orderId, { scannedCode: 'awb-ver-0001', method: 'scan' }, opsToken, key).expect(200)).body).toEqual(ok.body);
    const again = noOpIdempotencyKey(tenantId, ulid(), 'shipment.verify:already-verified');
    expect((await verify(orderId, { scannedCode: 'AWBVER0001', method: 'typed' }, opsToken, again).expect(200)).body.verified).toBe(false);
    const courier = await packedOrder();
    await awbAdvice(courier, { awb: 'AWBVER0002', courierName: 'VRL' }).expect(201);
    expect((await verify(courier, { scannedCode: 'AWBVER0002', method: 'scan' }).expect(409)).body.code).toBe('no-client-label');
  });

  it('the handheld verify: badge-in, occurredAt required, the device stamped; a late verify after the handover is the settled no-op (A48)', async () => {
    const orderId = await packedOrder();
    await staffLabel(orderId, { awb: 'AWBDEV0001', courierName: 'Delhivery' }, await labelPdf(1)).expect(201);
    expect((await verify(orderId, { scannedCode: 'AWBDEV0001', method: 'scan' }, operatorToken).expect(400)).body.code).toBe('validation-failed');
    const key = ulid();
    const occurredAt = new Date(Date.now() - 60_000).toISOString();
    const ok = await verify(orderId, { scannedCode: 'AWBDEV0001', method: 'scan', occurredAt }, operatorToken, key).expect(200);
    expect(ok.body.verified).toBe(true);
    expect((await shipmentsOf(orderId))[0]!.label_verified_device_id).toBe(deviceId);
    await handOver({ parcels: [{ orderId }] }).expect(201);
    const late = noOpIdempotencyKey(tenantId, ulid(), 'shipment.verify:already-verified');
    expect((await verify(orderId, { scannedCode: 'AWBDEV0001', method: 'scan', occurredAt }, operatorToken, late).expect(200)).body.verified).toBe(false);
    expect((await verify(orderId, { scannedCode: 'AWBDEV9999', method: 'scan', occurredAt }, operatorToken).expect(409)).body.code).toBe('order-not-open');
    // A bare enrollment credential (no badge-in) is 401.
    expect((await verify(orderId, { scannedCode: 'AWBDEV0001', method: 'scan', occurredAt }, deviceToken).expect(401)).body.code).toBe('unauthenticated');
  });

  // ── the per-order dispatch and the cancels (A13, A24, A27) ─────────────────

  it('a client-arranged order is dispatched only by a handover: 409 dispatch-via-handover', async () => {
    const orderId = await packedOrder();
    await awbAdvice(orderId, { awb: 'AWBDVH0001', courierName: 'VRL' }).expect(201);
    const refused = await http().post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(409);
    expect(refused.body.code).toBe('dispatch-via-handover');
    expect(await orderStatus(orderId)).toBe('ready_to_dispatch');
  });

  it('a plain cancel voids the client label ("Order cancelled") and removes its file; a cancel with restock does too, emitting the 4-2b payload with kind and voidReason', async () => {
    const accepted = await acceptedOrder();
    await staffLabel(accepted, { awb: 'AWBCXL1001', courierName: 'Delhivery' }, await labelPdf(1)).expect(201);
    await http().post(`${API}/${tenantId}/outbound/orders/${accepted}/cancel`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({});
    expect(await orderStatus(accepted)).toBe('cancelled');
    const [voided] = await shipmentsOf(accepted);
    expect(voided).toMatchObject({ status: 'voided', void_reason: 'Order cancelled' });
    expect((await sql`select status, removed_by from attachments where id = ${voided!.label_attachment_id as string}`)[0]).toMatchObject({ status: 'removed', removed_by: opsId });

    const packed = await packedOrder();
    await staffLabel(packed, { awb: 'AWBCXL1002', courierName: 'Delhivery' }, await labelPdf(1)).expect(201);
    const restock = await http().post(`${API}/${tenantId}/outbound/orders/${packed}/cancel-with-restock`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({});
    expect(restock.status).toBeLessThan(300);
    const [restocked] = await shipmentsOf(packed);
    expect(restocked).toMatchObject({ status: 'voided', void_reason: 'Order cancelled' });
    const event = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'shipment.voided' and payload->'shipment'->>'id' = ${restocked!.id as string}`)[0]!.payload as {
      shipment: Record<string, unknown>;
    };
    expect(Object.keys(event.shipment).sort()).toEqual(
      ['carrierCode', 'carrierConnectionId', 'carrierName', 'id', 'kind', 'orderId', 'status', 'trackingNumber', 'voidReason', 'voidedAt', 'voidedBy', 'warehouseId'].sort(),
    );
    expect(event.shipment).toMatchObject({ carrierCode: null, carrierConnectionId: null, kind: 'client-label', voidReason: 'Order cancelled' });
  });

  // ── the handover (A12, A32, A33, A36, A40) ─────────────────────────────────

  it('AC1/AC2 — the web handover: a verified client label, a pre-advised AWB scanned, and an AWB scanned on an order with no shipment → HO-NNNN, three handed over, three dispatched with the AWB on every event, frozen parties, the dispatch emails', async () => {
    const verified = await packedOrder();
    const pdf = await labelPdf(1);
    await portalLabel(verified, { awb: '1234-5678-9013', courierName: 'Delhivery' }, pdf).expect(201);
    await verify(verified, { scannedCode: '123456789013', method: 'scan' }).expect(200);
    const advised = await packedOrder('A-TEE', { orderType: 'b2c', codAmountPaise: 49900 });
    await awbAdvice(advised, { awb: 'AWBHO00002', courierName: 'Delhivery' }).expect(201);
    const bare = await packedOrder();
    const key = ulid();
    const res = await handOver(
      {
        courier: { transporterId },
        pickupPersonPhone: '+91 98765 43210',
        parcels: [{ orderId: verified }, { orderId: advised, awb: 'awbho00002', packageCount: 2 }, { orderId: bare, awb: '77001' }],
      },
      opsToken,
      key,
    ).expect(201);
    const handover = res.body.handover;
    expect(handover.code).toMatch(/^HO-\d{4}$/);
    expect(handover).toMatchObject({ courierName: 'Blue Dart Express', transporterId, shipmentCount: 3, packageCount: 4, codShipmentCount: 1, codTotalPaise: 49900, source: 'web' });
    expect(res.body.refused).toEqual([]);
    expect(res.body.parcels.map((p: { awb: string }) => p.awb).sort()).toEqual(['123456789013', '77001', 'AWBHO00002']);
    for (const orderId of [verified, advised, bare]) {
      expect(await orderStatus(orderId)).toBe('dispatched');
      const [shipment] = await shipmentsOf(orderId);
      expect(shipment).toMatchObject({ status: 'handed_over', handover_id: handover.id });
      const events = (await sql`select reference_doc from ledger_events where tenant_id = ${tenantId} and type = 'dispatch.dispatched' and reference_doc->>'orderId' = ${orderId}`) as unknown as {
        reference_doc: Record<string, unknown>;
      }[];
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.reference_doc).toMatchObject({ carrierName: shipment!.carrier_name, trackingNumber: shipment!.tracking_number });
    }
    const created = (await shipmentsOf(bare))[0]!;
    expect(created).toMatchObject({ kind: 'courier-label', labelled_by: opsId, recorded_surface: 'web' });
    expect((await shipmentsOf(advised))[0]!.label_verify_method).toBe('handover-scan');
    const row = (await sql`select * from courier_handovers where id = ${handover.id as string}`)[0]!;
    expect((row.client_snapshot as { code: string }).code).toBe('ACME');
    expect(row.pickup_person_phone).toBe('+919876543210');
    // One handover.created row beside the three per-order order.dispatched rows, one reference.
    const audit = (await sql`select action, target_id from audit_events where tenant_id = ${tenantId} and reference = ${key} order by action, target_id`) as unknown as { action: string; target_id: string }[];
    expect(audit.map((row) => row.action)).toEqual(['handover.created', 'order.dispatched', 'order.dispatched', 'order.dispatched']);
    expect(audit.slice(1).map((row) => row.target_id).sort()).toEqual([verified, advised, bare].sort());
    // The detail: the phone unmasked for dispatch.execute, masked for an accountant.
    expect((await http().get(`${API}/${tenantId}/outbound/handovers/${handover.id}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.handover.pickupPersonPhone).toBe('+919876543210');
    expect((await http().get(`${API}/${tenantId}/outbound/handovers/${handover.id}`).set('Authorization', `Bearer ${accountantToken}`).expect(200)).body.handover.pickupPersonPhone).not.toBe('+919876543210');
    // AC6 — editing the client's name later leaves the frozen sheet party unchanged.
    await http().patch(`${API}/${tenantId}/clients/${acme}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ name: 'ACME Renamed' });
    expect((await http().get(`${API}/${tenantId}/outbound/handovers/${handover.id}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.handover.clientSnapshot.name).toBe('ACME Brand');
    await http().patch(`${API}/${tenantId}/clients/${acme}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ name: 'ACME Brand' });
    // Replay; a different body is 422.
    expect((await handOver({ courier: { transporterId }, pickupPersonPhone: '+91 98765 43210', parcels: [{ orderId: verified }, { orderId: advised, awb: 'awbho00002', packageCount: 2 }, { orderId: bare, awb: '77001' }] }, opsToken, key).expect(201)).body).toEqual(res.body);
    // The dispatch emails (5-2b) name the AWB; the portal reads "handed-over".
    await drain();
    const dispatchMail = (await sql`select params from email_messages where tenant_id = ${tenantId} and template = 'client-dispatch' and params->>'trackingNumber' = '123456789013'`) as unknown as { params: Record<string, unknown> }[];
    expect(dispatchMail).toHaveLength(1);
    const portal = await http().get(`${API}/${tenantId}/portal/orders/${verified}/shipping`).set('Authorization', `Bearer ${acmePortal}`).expect(200);
    expect(portal.body).toMatchObject({ status: 'handed-over', courierName: 'Delhivery', handoverCode: handover.code, pickupPersonName: 'Ravi', vehicleNumber: 'KA01AB1234' });
    expect(JSON.stringify(portal.body)).not.toContain('9876543210');
    // Replacing a handed-over label is 409 shipment-handed-over.
    expect((await portalLabel(verified, { awb: 'AWBNEW0001', courierName: 'X', replace: 'true' }, pdf).expect(409)).body.code).toBe('shipment-handed-over');
    // The list.
    const list = await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/handovers?clientId=${acme}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(list.body.items.map((item: { id: string }) => item.id)).toContain(handover.id);
  });

  it('the web handover is all-or-nothing: an unverified client label without a scan is 409 handover-parcels-refused naming it; nothing is written', async () => {
    const good = await packedOrder();
    await awbAdvice(good, { awb: 'AWBALL0001', courierName: 'VRL' }).expect(201);
    const unverified = await packedOrder();
    await staffLabel(unverified, { awb: 'AWBALL0002', courierName: 'VRL' }, await labelPdf(1)).expect(201);
    const before = Number((await sql`select count(*)::int as n from courier_handovers where tenant_id = ${tenantId}`)[0]!.n);
    const refused = await handOver({ parcels: [{ orderId: good, awb: 'AWBALL0001' }, { orderId: unverified }] }).expect(409);
    expect(refused.body.code).toBe('handover-parcels-refused');
    expect(refused.body.parcels.map((p: { orderId: string; code: string }) => [p.orderId, p.code])).toEqual([[unverified, 'label-not-verified']]);
    expect(Number((await sql`select count(*)::int as n from courier_handovers where tenant_id = ${tenantId}`)[0]!.n)).toBe(before);
    expect(await orderStatus(good)).toBe('ready_to_dispatch');
    // A scanned AWB that differs is awb-mismatch; no AWB on a no-shipment order is awb-required.
    const none = await packedOrder();
    const two = await handOver({ parcels: [{ orderId: unverified, awb: 'AWBOTHER01' }, { orderId: none }] }).expect(409);
    expect(two.body.parcels.map((p: { code: string }) => p.code)).toEqual(['awb-mismatch', 'awb-required']);
  });

  it('a recalled lot: the web refuses the whole handover (order-holds-recalled-batch); the handheld hands over the rest and refuses that parcel', async () => {
    await http().post(`${API}/${tenantId}/inventory/adjustments`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: sku.get('A-LOT'), binId, quantityDelta: 5, reasonCode: 'stock-count', note: 'lot seed', batch: { code: 'LOT-RCL-1' } }).expect(201);
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
    const recalledOrder = await packedOrder('A-LOT');
    const clean = await packedOrder();
    const lot = (await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku.get('A-LOT')!} and code = 'LOT-RCL-1'`)[0]!.id as string;
    await http().post(`${API}/${tenantId}/inventory/recalls`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ batchIds: [lot], reasonNote: 'handover suite', mode: 'live' }).expect(201);
    const web = await handOver({ parcels: [{ orderId: clean, awb: 'AWBRCL0001' }, { orderId: recalledOrder, awb: 'AWBRCL0002' }] }).expect(409);
    expect(web.body.parcels).toEqual([{ orderId: recalledOrder, code: 'order-holds-recalled-batch', detail: expect.stringContaining('recall') }]);
    const device = await handOver({ occurredAt: new Date().toISOString(), parcels: [{ orderId: clean, awb: 'AWBRCL0001' }, { orderId: recalledOrder, awb: 'AWBRCL0002' }] }, operatorToken).expect(201);
    expect(device.body.parcels.map((p: { orderId: string }) => p.orderId)).toEqual([clean]);
    expect(device.body.refused.map((r: { code: string }) => r.code)).toEqual(['order-holds-recalled-batch']);
    expect(await orderStatus(recalledOrder)).toBe('ready_to_dispatch');
  });

  it('mixed clients are 409 handover-client-mismatch on both surfaces; duplicates and photoRefs on the web are 400; the 7-day window', async () => {
    const a = await packedOrder();
    const b = await packedOrder('B-TEE');
    const web = await handOver({ parcels: [{ orderId: a, awb: 'AWBMIX0001' }, { orderId: b, awb: 'AWBMIX0002' }] }).expect(409);
    expect(web.body).toMatchObject({ code: 'handover-client-mismatch', orderIds: [b] });
    const device = await handOver({ occurredAt: new Date().toISOString(), parcels: [{ orderId: a, awb: 'AWBMIX0001' }, { orderId: b, awb: 'AWBMIX0002' }] }, operatorToken).expect(409);
    expect(device.body.code).toBe('handover-client-mismatch');
    expect((await handOver({ parcels: [{ orderId: a, awb: 'AWBDUP' + '0001' }, { orderId: a, awb: 'AWBDUP0002' }] }).expect(400)).body.code).toBe('validation-failed');
    expect((await handOver({ photoRefs: [ulid()], parcels: [{ orderId: a, awb: 'AWBMIX0001' }] }).expect(400)).body.code).toBe('validation-failed');
    expect((await handOver({ occurredAt: new Date(Date.now() - 8 * 86_400_000).toISOString(), parcels: [{ orderId: a, awb: 'AWBMIX0001' }] }).expect(400)).body.detail).toMatch(/7 days/);
    expect((await handOver({ parcels: [{ orderId: a, awb: 'AWBMIX0001' }] }, accountantToken).expect(403)).body.code).toBe('role-denied');
  });

  it('AC4 — the handheld handover settles partially: a cancelled order refused into ONE Discard-only review row, the rest dispatched; the photos staged before attach to the handover and are shared', async () => {
    const orders = [await packedOrder(), await packedOrder(), await packedOrder()];
    const cancelled = await packedOrder();
    await http().post(`${API}/${tenantId}/outbound/orders/${cancelled}/cancel-with-restock`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({});
    const photo = ulid();
    const staged = await http().post(`${API}/${tenantId}/outbound/handover-photos`).set('Authorization', `Bearer ${deviceToken}`).set(KEY_HEADER, photo)
      .set('x-op-operator', operatorId).field('capturedAt', new Date().toISOString()).attach('file', JPEG, { filename: 'sheet.jpg', contentType: 'image/jpeg' }).expect(201);
    expect(staged.body).toEqual({ ref: photo, status: 'staged' });
    await expectAuditRow({ tenantId, key: photo, action: 'handover_photo.uploaded', targetType: 'attachment', targetId: (await sql`select id from attachments where client_ref = ${photo}`)[0]!.id as string, actorUserId: operatorId });
    const late = ulid();
    const key = ulid();
    const res = await handOver(
      {
        occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        photoRefs: [photo, late],
        parcels: [...orders.map((orderId, i) => ({ orderId, awb: `AWBDEVHO0${i}` })), { orderId: cancelled, awb: 'AWBDEVHO09' }],
      },
      operatorToken,
      key,
    ).expect(201);
    expect(res.body.handover.source).toBe('handheld');
    expect(res.body.parcels).toHaveLength(3);
    expect(res.body.refused).toEqual([{ orderId: cancelled, code: 'order-not-ready', detail: expect.any(String) }]);
    expect(res.body.rejectedOpId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const review = (await sql`select op_type, problem_code, payload from rejected_ops where tenant_id = ${tenantId} and op_id = ${res.body.rejectedOpId as string}`)[0]!;
    expect(review).toMatchObject({ op_type: 'handover.create', problem_code: 'handover-parcels-refused' });
    expect((review.payload as { parcels: { orderId: string }[] }).parcels.map((p) => p.orderId)).toEqual([cancelled]);
    expect(REJECTED_OP_DECISIONS_BY_TYPE['handover.create']).toEqual(['discard']);
    for (const orderId of orders) expect(await orderStatus(orderId)).toBe('dispatched');
    const pages = (await sql`select status, client_ref from attachments where owner_id = ${res.body.handover.id as string} order by client_ref`) as unknown as { status: string; client_ref: string }[];
    expect(pages.map((p) => [p.client_ref, p.status]).sort()).toEqual([[late, 'awaited'], [photo, 'attached']].sort());
    // The late photo fills its placeholder — and is shared then (A35).
    await http().post(`${API}/${tenantId}/outbound/handover-photos`).set('Authorization', `Bearer ${deviceToken}`).set(KEY_HEADER, late)
      .set('x-op-operator', operatorId).field('capturedAt', new Date().toISOString()).attach('file', JPEG, { filename: 'sheet.jpg', contentType: 'image/jpeg' }).expect(201);
    const shared = await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'shipment.document-shared' and payload->>'handoverId' = ${res.body.handover.id as string}`;
    expect(shared).toHaveLength(2);
    // Every parcel refused: no handover, the audit targets the review row.
    const allRefused = await packedOrder();
    await http().post(`${API}/${tenantId}/outbound/orders/${allRefused}/cancel-with-restock`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({});
    const key2 = ulid();
    const none = await handOver({ occurredAt: new Date().toISOString(), parcels: [{ orderId: allRefused, awb: 'AWBNONE001' }] }, operatorToken, key2).expect(201);
    expect(none.body.handover).toBeNull();
    const reviewId = (await sql`select id from rejected_ops where tenant_id = ${tenantId} and op_id = ${none.body.rejectedOpId as string}`)[0]!.id as string;
    await expectAuditRow({ tenantId, key: key2, action: 'handover.parcels_refused', targetType: 'rejected_op', targetId: reviewId, actorUserId: operatorId });
  });

  it('A29 — a staged sheet photo an open handover.create review row names survives the staged sweep', async () => {
    const photo = ulid();
    await http().post(`${API}/${tenantId}/outbound/handover-photos`).set('Authorization', `Bearer ${deviceToken}`).set(KEY_HEADER, photo)
      .set('x-op-operator', operatorId).field('capturedAt', new Date().toISOString()).attach('file', JPEG, { filename: 'sheet.jpg', contentType: 'image/jpeg' }).expect(201);
    await sql`update attachments set created_at = now() - interval '400 days' where client_ref = ${photo}`;
    await sql`insert into rejected_ops (id, tenant_id, device_id, operator_user_id, op_id, op_type, classification, problem_code, problem_detail, payload, attribution, op_enqueued_at, op_occurred_at)
      values (${uuidv7()}, ${tenantId}, ${deviceId}, ${operatorId}, ${ulid()}, 'handover.create', 'rejected', 'handover-client-mismatch', null,
              ${sql.json({ warehouseId, clientId: acme, parcels: [{ orderId: uuidv7() }], photoRefs: [photo] })}, ${sql.json({})}, now(), now())`;
    const summary = await app.get(AttachmentsFacade).sweep(tenantId);
    expect(summary.keptReferenced).toBeGreaterThanOrEqual(1);
    expect((await sql`select status from attachments where client_ref = ${photo}`)[0]!.status).toBe('staged');
  });

  // ── documents and the signed sheet (A14, A23, A35, A46, A47) ───────────────

  it('AC5 — a POD on a dispatched order is shared at once: one email per opted-in contact, the file attached at send time; the portal lists it; client B sees nothing', async () => {
    const orderId = await packedOrder();
    await awbAdvice(orderId, { awb: 'AWBPOD0001', courierName: 'Delhivery' }).expect(201);
    const handoverKey = ulid();
    const handed = await handOver({ parcels: [{ orderId, awb: 'AWBPOD0001' }] }, opsToken, handoverKey).expect(201);
    await expectAuditRow({
      tenantId,
      key: handoverKey,
      action: 'handover.created',
      targetType: 'courier_handover',
      targetId: handed.body.handover.id,
      actorUserId: opsId,
      alongside: [{ action: 'order.dispatched', targetType: 'order', targetId: orderId, actorUserId: opsId }],
    });
    const key = ulid();
    const doc = await uploadDocument(orderId, 'pod', JPEG, opsToken, false, key).expect(201);
    expect(doc.body.file).toMatchObject({ purpose: 'shipping-document', docKind: 'pod', status: 'attached', contentType: 'image/jpeg' });
    await expectAuditRow({ tenantId, key, action: 'shipping_file.attached', targetType: 'attachment', targetId: doc.body.file.id, actorUserId: opsId });
    // The signed sheet (web, PDF).
    const sheetKey = ulid();
    const sheet = await http().post(`${API}/${tenantId}/outbound/handovers/${handed.body.handover.id}/sheet`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, sheetKey)
      .attach('file', await labelPdf(1), { filename: 'sheet.pdf', contentType: 'application/pdf' }).expect(201);
    await expectAuditRow({ tenantId, key: sheetKey, action: 'handover.sheet_attached', targetType: 'attachment', targetId: sheet.body.file.id, actorUserId: opsId });
    await drain();
    const rows = (await sql`select to_email, attachment_kind, attachment_ref, params from email_messages where tenant_id = ${tenantId} and template = 'client-shipment-document' and attachment_ref in ${sql([doc.body.file.id, sheet.body.file.id])}`) as unknown as {
      to_email: string;
      attachment_kind: string;
      attachment_ref: string;
      params: Record<string, unknown>;
    }[];
    expect(rows.map((row) => [row.to_email, row.attachment_kind]).sort()).toEqual([['asha@acme.example', 'stored-file'], ['asha@acme.example', 'stored-file']]);
    const orderRef = rows.find((row) => row.attachment_ref === doc.body.file.id)!.params.orderRef as string;
    const wanted = [`ACME Brand: Proof of delivery for order ${orderRef}`, `ACME Brand: signed handover sheet ${handed.body.handover.code} (page 1)`];
    const before = captured.captured.length;
    // Earlier tests' notices are older and claimed first: send until ours went.
    for (let round = 0; round < 20; round += 1) {
      await mail.sendDue(tenantId, 50);
      const subjects = captured.captured.slice(before).map((email) => email.subject);
      if (wanted.every((subject) => subjects.includes(subject))) break;
    }
    const sent = captured.captured.slice(before).filter((email) => wanted.includes(email.subject));
    expect(sent.map((email) => email.subject).sort()).toEqual([...wanted].sort());
    const pod = sent.find((email) => email.subject.includes('Proof of delivery'))!;
    expect(Buffer.from(pod.attachments![0]!.content).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(pod.attachments![0]!.filename).toMatch(/-pod-1\.jpg$/);
    const page = sent.find((email) => email.subject.includes('signed handover sheet'))!;
    expect(page.subject).toContain(`${handed.body.handover.code} (page 1)`);
    expect(Buffer.from(page.attachments![0]!.content).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const portal = await http().get(`${API}/${tenantId}/portal/orders/${orderId}/shipping`).set('Authorization', `Bearer ${acmePortal}`).expect(200);
    expect(portal.body.documents.map((d: { kind: string }) => d.kind)).toEqual(['pod']);
    expect(portal.body.handoverSheet).toHaveLength(1);
    expect((await http().get(`${API}/${tenantId}/portal/orders/${orderId}/shipping`).set('Authorization', `Bearer ${betaPortal}`).expect(404)).body.code).toBe('not-found');
    // The client may upload its own invoice — never a POD.
    expect((await uploadDocument(orderId, 'pod', JPEG, acmePortal, true).expect(400)).body.code).toBe('validation-failed');
    const own = await uploadDocument(orderId, 'invoice', await labelPdf(1), acmePortal, true).expect(201);
    expect(own.body.file).toMatchObject({ source: 'portal', docKind: 'invoice', pageCount: 1 });
  });

  it('A47 — a document attached before a per-order dispatch is shared at the dispatch; the caps (20 warehouse, 10 sheet pages) refuse; remove (orders.manage) and a live label is label-in-use', async () => {
    const orderId = await packedOrder();
    const doc = await uploadDocument(orderId, 'invoice', JPEG).expect(201);
    expect((await sql`select count(*)::int as n from outbox_messages where type = 'shipment.document-shared' and payload->>'attachmentId' = ${doc.body.file.id as string}`)[0]!.n).toBe(0);
    await http().post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({}).expect(201);
    expect((await sql`select count(*)::int as n from outbox_messages where type = 'shipment.document-shared' and payload->>'attachmentId' = ${doc.body.file.id as string}`)[0]!.n).toBe(1);
    // The cap: seed 19 more live warehouse documents.
    for (let i = 0; i < 19; i += 1) {
      await sql`insert into attachments (id, tenant_id, client_id, warehouse_id, purpose, doc_kind, status, source, owner_type, owner_id, owner_parent_id, object_key, content_type, byte_size, sha256, width, height, uploaded_at, created_by)
        values (${uuidv7()}, ${tenantId}, ${acme}, ${warehouseId}, 'shipping-document', 'other', 'attached', 'web', 'order', ${orderId}, ${orderId}, ${'seed/' + ulid()}, 'image/jpeg', 10, ${'a'.repeat(64)}, 1, 1, now(), ${opsId})`;
    }
    expect((await uploadDocument(orderId, 'other', JPEG).expect(409)).body.code).toBe('document-limit');
    const key = ulid();
    const removed = await http().post(`${API}/${tenantId}/outbound/shipping-files/${doc.body.file.id}/remove`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, key).send({ reason: 'Wrong file' }).expect(200);
    expect(removed.body.file.status).toBe('removed');
    await expectAuditRow({ tenantId, key, action: 'shipping_file.removed', targetType: 'attachment', targetId: doc.body.file.id, actorUserId: opsId });
    const labelled = await acceptedOrder();
    const label = await staffLabel(labelled, { awb: 'AWBINUSE01', courierName: 'X' }, await labelPdf(1)).expect(201);
    const labelFile = label.body.shipment.labelAttachmentId as string;
    expect((await http().post(`${API}/${tenantId}/outbound/shipping-files/${labelFile}/remove`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ reason: 'x' }).expect(409)).body.code).toBe('label-in-use');
  });

  it('the AWB advice audit, the staff label hash golden, the candidates and the parcel tag', async () => {
    const orderId = await packedOrder();
    const key = ulid();
    await awbAdvice(orderId, { awb: ' 7700 2 ', courierName: 'VRL', packageCount: 2 }, opsToken, key).expect(201);
    await expectAuditRow({ tenantId, key, action: 'shipment.awb_recorded', targetType: 'order', targetId: orderId, actorUserId: opsId });
    expect(await storedHash(key)).toBe(
      hashCommandPayload({ arm: 'awb-advice', surface: 'staff', tenantId, orderId, awb: '77002', transporterId: null, courierName: 'VRL', packageCount: 2, replace: false }),
    );
    const staffKey = ulid();
    const labelOrder = await acceptedOrder();
    const pdf = await labelPdf(1);
    await staffLabel(labelOrder, { awb: 'AWBSTF0001', transporterId }, pdf, opsToken, staffKey).expect(201);
    await expectAuditRow({ tenantId, key: staffKey, action: 'shipment.client_label_recorded', targetType: 'order', targetId: labelOrder, actorUserId: opsId });
    expect(await storedHash(staffKey)).toBe(
      hashCommandPayload({
        arm: 'client-label',
        surface: 'staff',
        tenantId,
        orderId: labelOrder,
        rawSha256: (await import('node:crypto')).createHash('sha256').update(pdf).digest('hex'),
        awb: 'AWBSTF0001',
        transporterId,
        courierName: null,
        packageCount: null,
        replace: false,
      }),
    );
    const candidates = await http().get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/handover-candidates?clientId=${acme}&limit=200`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    const mine = (candidates.body.items as { orderId: string; parcelTagCode: string; shipment: { awb: string; packageCount: number } | null }[]).find((item) => item.orderId === orderId)!;
    expect(mine).toMatchObject({ parcelTagCode: parcelTagCode(orderId), shipment: { awb: '77002', packageCount: 2 } });
    const zpl = await http().get(`${API}/${tenantId}/outbound/orders/${orderId}/parcel-tag?format=zpl`).set('Authorization', `Bearer ${opsToken}`).buffer(true).parse((res, cb) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
      res.on('end', () => cb(null, data));
    }).expect(200);
    expect(zpl.body as string).toContain(parcelTagCode(orderId));
    const pdfTag = await http().get(`${API}/${tenantId}/outbound/orders/${orderId}/parcel-tag?format=pdf`).set('Authorization', `Bearer ${opsToken}`).expect(200);
    expect(pdfTag.headers['content-type']).toContain('application/pdf');
    // The device snapshot carries the parcel.
    const snapshot = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`).set('Authorization', `Bearer ${operatorToken}`).expect(200);
    const parcel = (snapshot.body.dispatchParcels as { orderId: string; shipment: { awb: string } | null }[]).find((p) => p.orderId === orderId)!;
    expect(parcel.shipment!.awb).toBe('77002');
    expect(snapshot.body.dispatchParcelsTruncated).toBe(false);
    expect(snapshot.body.clients.map((c: { id: string }) => c.id)).toContain(acme);
  });

  it('A41 — a blind return finds a client-arranged AWB typed spaced or in lower case', async () => {
    const orderId = await packedOrder();
    await awbAdvice(orderId, { awb: 'ab12-3456-7890', courierName: 'VRL' }).expect(201);
    await handOver({ parcels: [{ orderId, awb: 'AB1234567890' }] }).expect(201);
    const { withTenantTransaction } = await import('../src/shared/db/tenant-scope');
    const { OutboundFacade } = await import('../src/modules/outbound/outbound.facade');
    const outbound = app.get(OutboundFacade);
    for (const typed of ['ab12 3456 7890', 'AB1234567890']) {
      const found = await withTenantTransaction(app.get(DATABASE), tenantId, (tx) => outbound.ordersByParcelReferenceInTx(tx, tenantId, acme, warehouseId, typed));
      expect(found).toEqual([{ orderId, matchKind: 'awb' }]);
    }
  });

  it('same-key races (parked waiters): two handovers and two AWB advices under one key, parked on the order lock — both answer the winner’s snapshot, one effect', async () => {
    async function race(orderId: string, fire: () => Promise<request.Response>): Promise<request.Response[]> {
      const holder = postgres(process.env.DATABASE_URL!.replace(/\/[^/]+$/, `/${(await sql`select current_database() as db`)[0]!.db as string}`), { max: 1, onnotice: () => undefined });
      try {
        let releaseHolder!: () => void;
        const held = new Promise<void>((resolve) => (releaseHolder = resolve));
        let holderPid = 0;
        const locked = new Promise<void>((resolve) => {
          void holder.begin(async (tx) => {
            holderPid = Number((await tx`select pg_backend_pid() as pid`)[0]!.pid);
            await tx`select id from orders where id = ${orderId} for update`;
            resolve();
            await held;
          });
        });
        await locked;
        const first = fire();
        const second = fire();
        const deadline = Date.now() + 10_000;
        for (;;) {
          const waiting = (await sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and ${holderPid} = any(pg_blocking_pids(pid))`)[0]!.n as number;
          const chained = (await sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and state = 'active' and query ilike '%"orders"%'`)[0]!.n as number;
          if (waiting >= 1 && chained >= 2) break;
          if (Date.now() > deadline) throw new Error('the duplicates never parked');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        releaseHolder();
        return await Promise.all([first, second]);
      } finally {
        await holder.end();
      }
    }
    const handoverOrder = await packedOrder();
    const key = ulid();
    const answers = await race(handoverOrder, () => handOver({ parcels: [{ orderId: handoverOrder, awb: 'AWBRACE001' }] }, opsToken, key).then((res) => res));
    expect(answers.map((res) => res.status)).toEqual([201, 201]);
    expect(answers[1]!.body).toEqual(answers[0]!.body);
    expect((await sql`select count(*)::int as n from shipments where order_id = ${handoverOrder}`)[0]!.n).toBe(1);
    const adviceOrder = await acceptedOrder();
    const adviceKey = ulid();
    const advices = await race(adviceOrder, () => awbAdvice(adviceOrder, { awb: 'AWBRACE002', courierName: 'VRL' }, opsToken, adviceKey).then((res) => res));
    expect(advices.map((res) => res.status)).toEqual([201, 201]);
    expect(advices[1]!.body).toEqual(advices[0]!.body);
    expect((await sql`select count(*)::int as n from shipments where order_id = ${adviceOrder}`)[0]!.n).toBe(1);
  });

  it('A44 — the portal status derivation', () => {
    expect(portalShippingStatus('cancelled', null, false)).toBe('cancelled');
    expect(portalShippingStatus('accepted', null, false)).toBe('no-label-yet');
    expect(portalShippingStatus('accepted', { kind: 'client-label', status: 'labelled', labelVerified: false }, false)).toBe('label-received');
    expect(portalShippingStatus('ready_to_dispatch', { kind: 'client-label', status: 'labelled', labelVerified: true }, false)).toBe('ready-for-pickup');
    expect(portalShippingStatus('accepted', { kind: 'courier-label', status: 'labelled', labelVerified: false }, false)).toBe('awb-received');
    expect(portalShippingStatus('dispatched', { kind: 'courier-label', status: 'handed_over', labelVerified: false }, true)).toBe('handed-over');
    expect(portalShippingStatus('dispatched', { kind: 'carrier', status: 'manifested', labelVerified: false }, true)).toBe('shipped');
    expect(portalShippingStatus('dispatched', null, true)).toBe('shipped-no-courier-record');
  });

  it('the OpenAPI document lists the 18 new routes', async () => {
    const doc = (await http().get('/api/v1/openapi.json').expect(200)).body as { paths: Record<string, Record<string, unknown>> };
    const routes: [string, string][] = [
      ['/api/v1/tenants/{tenantId}/outbound/orders/{orderId}/shipment/client-label', 'post'],
      ['/api/v1/tenants/{tenantId}/outbound/orders/{orderId}/shipment/awb', 'post'],
      ['/api/v1/tenants/{tenantId}/outbound/orders/{orderId}/shipment/void', 'post'],
      ['/api/v1/tenants/{tenantId}/outbound/orders/{orderId}/shipment/verify', 'post'],
      ['/api/v1/tenants/{tenantId}/outbound/orders/{orderId}/shipping', 'get'],
      ['/api/v1/tenants/{tenantId}/outbound/orders/{orderId}/parcel-tag', 'get'],
      ['/api/v1/tenants/{tenantId}/outbound/orders/{orderId}/documents', 'post'],
      ['/api/v1/tenants/{tenantId}/outbound/handovers', 'post'],
      ['/api/v1/tenants/{tenantId}/outbound/handovers/{handoverId}', 'get'],
      ['/api/v1/tenants/{tenantId}/outbound/handovers/{handoverId}/sheet', 'post'],
      ['/api/v1/tenants/{tenantId}/outbound/handover-photos', 'post'],
      ['/api/v1/tenants/{tenantId}/outbound/shipping-files/{attachmentId}/remove', 'post'],
      ['/api/v1/tenants/{tenantId}/warehouses/{warehouseId}/outbound/handover-candidates', 'get'],
      ['/api/v1/tenants/{tenantId}/warehouses/{warehouseId}/outbound/handovers', 'get'],
      ['/api/v1/tenants/{tenantId}/portal/orders/{orderId}/shipping', 'get'],
      ['/api/v1/tenants/{tenantId}/portal/orders/{orderId}/shipment/client-label', 'post'],
      ['/api/v1/tenants/{tenantId}/portal/orders/{orderId}/shipment/awb', 'post'],
      ['/api/v1/tenants/{tenantId}/portal/orders/{orderId}/documents', 'post'],
    ];
    for (const [path, method] of routes) {
      const entry = doc.paths[path] ?? doc.paths[path.replace('/api/v1', '')];
      expect([path, method, entry?.[method] !== undefined]).toEqual([path, method, true]);
    }
  });

  it('A37 — a 100-parcel web handover commits within 5 s', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i += 1) ids.push(await packedOrder());
    const started = Date.now();
    const res = await handOver({ parcels: ids.map((orderId, i) => ({ orderId, awb: `AWBBULK${String(i).padStart(4, '0')}` })) }).expect(201);
    const elapsed = Date.now() - started;
    expect(res.body.handover.shipmentCount).toBe(100);
    expect(elapsed).toBeLessThan(5000);
    // A 101st parcel is a 400 (a larger pickup is two handovers).
    expect((await handOver({ parcels: [...ids, uuidv7()].map((orderId, i) => ({ orderId, awb: `AWBOVER${String(i).padStart(4, '0')}` })) }).expect(400)).body.code).toBe('validation-failed');
  });

});
