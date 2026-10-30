import type { INestApplication } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction, type TenantTx } from '../src/shared/db/tenant-scope';
import { qcHeldTotalsQuery } from '../src/modules/inventory/inventory.facade';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import { MailFacade, MailAttachmentRegistry } from '../src/modules/mail/mail.facade';
import { MailSender } from '../src/modules/mail/mail.sender';
import { EMAIL_GATEWAY, type EmailGateway, type EmailSendResult, type LogEmailGateway, type OutgoingEmail } from '../src/modules/mail/email.gateway';
import { GrnDocumentReader } from '../src/modules/inbound/grn-document.read';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { mintSignIn } from './support/sign-in';
import { testAddress } from './support/shipment-address';
import { createLinkedVendor } from './support/linked-vendor';
import { pdfText } from './support/pdf-text';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.EMAIL_SEND_POLL_MS;
delete process.env.EMAIL_ALLOWLIST_DOMAINS;
delete process.env.EMAIL_REPLY_TO;
delete process.env.EMAIL_MAX_PER_TICK;
delete process.env.WEBHOOK_SEND_POLL_MS;
process.env.EMAIL_PROVIDER = 'log';
process.env.EMAIL_FROM = 'no-reply@mail.wms.test';
process.env.WEB_BASE_URL = 'https://app.wms.test/';
process.env.EMAIL_SEAL_KEY = 'e2e-only-email-seal-key-0123456789abcdef';
delete process.env.EMAIL_SEAL_KEY_PREVIOUS;
process.env.CLIENT_EMAIL_ENABLED = 'true';

jest.setTimeout(300_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

/** A scripted gateway: answers ok and records every call. */
class RecordingGateway implements EmailGateway {
  readonly mode = 'ses' as const;
  readonly calls: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<EmailSendResult> {
    this.calls.push(email);
    return { ok: true, providerMessageId: `ok-${email.id}` };
  }
}

interface Grn {
  id: string;
  code: string;
  lines: { id: string; batchId: string | null }[];
}

/**
 * Story 2-9a — the GRN document end to end: the freeze in `grn.submit` (the
 * device path) and its byte-identical snapshot and payload; the staff JSON
 * and file routes; the portal detail and file with their isolation probes;
 * a legacy (unfrozen) GRN; the shared-truck document filter; the QC outcome
 * from QC's own record; the receipt email's send-time attachment (attached,
 * memoised, retried, sent without the file on the last attempt, on a null,
 * too large, deferred, unavailable; a pre-story row unchanged); the
 * statement bound of the read.
 */
describe('the GRN document (e2e, story 2-9a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let db: Database;
  let relay: OutboxRelay;
  let mail: MailFacade;
  let registry: MailAttachmentRegistry;
  let captured: LogEmailGateway;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string;
  let portalToken: string;
  let warehouseId: string;
  let acme: string;
  let beta: string;
  let vendorId: string;
  let betaVendorId: string;
  const sku = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const occurredAt = () => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('grndocument');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    db = app.get<Database>(DATABASE);
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    mail = app.get(MailFacade);
    registry = app.get(MailAttachmentRegistry);
    captured = app.get<LogEmailGateway>(EMAIL_GATEWAY);

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Acme 3PL ${ulid()}`, ownerEmail, password: PASSWORD }).expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email: ownerEmail, password: PASSWORD })).body.accessToken as string;
    opsToken = (await member('ops_manager')).token;
    const floor = await member('operator');

    warehouseId = (
      await http().post(`${API}/${tenantId}/warehouses`).set(auth(ownerToken)).set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `W1-${ulid().slice(22)}`, name: 'Peenya DC' }).expect(201)
    ).body.id as string;
    await sql`update warehouses set gstin = '29AAAAA0000A1Z5' where id = ${warehouseId}`;

    acme = await client('ACME', 'ACME Brand');
    beta = await client('BETA', 'Beta Brand');
    await importSkus(acme, ['A-TEE,Acme tee,pcs,false', 'A-RICE,Acme rice,kg,false', 'A-QC,Acme serum,pcs,true', 'A-LOT,Acme lot,pcs,true']);
    await importSkus(beta, ['B-TEE,Beta tee,pcs,false']);
    vendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: 'V-01', name: 'Fabrics Co', clientIds: [acme], gstin: '24AAACF1234A1Z5' });
    betaVendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: 'V-02', name: 'Beta Supply', clientIds: [beta] });

    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set(auth(ownerToken)).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'Dock', pin: '2468' }).expect(201);
    operatorToken = (
      await http().post(`${API}/${tenantId}/devices/badge-in`).set(auth(enrolled.body.deviceToken as string)).send({ operatorEmail: floor.email, pin: '2468' }).expect(200)
    ).body.accessToken as string;

    const portalEmail = `portal-${ulid().toLowerCase()}@acme.example`;
    const invited = await http().post(`${API}/${tenantId}/users`).set(auth(ownerToken)).set(KEY_HEADER, ulid()).send({ email: portalEmail, role: 'client', clientId: acme }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    portalToken = (await mintSignIn(app, { email: portalEmail, password: PASSWORD })).body.accessToken as string;
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

  async function member(role: string): Promise<{ token: string; email: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http().post(`${API}/${tenantId}/users`).set(auth(ownerToken)).set(KEY_HEADER, ulid()).send({ email, role }).expect(201);
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { token: (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string, email };
  }

  async function client(code: string, name: string): Promise<string> {
    return (await http().post(`${API}/${tenantId}/clients`).set(auth(ownerToken)).set(KEY_HEADER, ulid()).send({ code, name }).expect(201)).body.client.id as string;
  }

  async function importSkus(clientId: string, rows: string[]): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,batch_tracked', ...rows.map((row) => { const [code, name, uom, batch] = row.split(','); return `${code},${name},${uom},1800,${batch}`; })].join('\n');
    await http().post(`${API}/${tenantId}/catalog/imports`).set(auth(ownerToken)).set(KEY_HEADER, ulid())
      .field('mode', 'initial').field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' }).expect(201);
    const stored = (await sql`select id, code from skus where tenant_id = ${tenantId} and client_id = ${clientId}`) as unknown as { id: string; code: string }[];
    for (const row of stored) sku.set(row.code, row.id);
  }

  async function purchaseOrder(vendor: string, lines: { code: string; qty: number }[]): Promise<{ id: string; code: string; lineIds: string[] }> {
    const code = `PO-${ulid().slice(18)}`;
    const res = await http().post(`${API}/${tenantId}/inbound/purchase-orders`).set(auth(opsToken)).set(KEY_HEADER, ulid())
      .send({ warehouseId, vendorId: vendor, code, lines: lines.map((line) => ({ skuId: sku.get(line.code), orderedQty: line.qty, unitCostPaise: 100 })) }).expect(201);
    return { id: res.body.purchaseOrder.id as string, code, lineIds: (res.body.purchaseOrder.lines as { id: string }[]).map((line) => line.id) };
  }

  async function gateIn(documents: Record<string, unknown>[]): Promise<{ id: string; code: string }> {
    const res = await http().post(`${API}/${tenantId}/receiving/gate-ins`).set(auth(ownerToken)).set(KEY_HEADER, ulid())
      .send({ warehouseId, vehicleNo: 'KA01AB1234', transporterName: 'Typed Roadways', driverName: 'Suresh Driver', driverPhone: '9876543210', sealStatus: 'intact', sealNumber: 'S-77', packagesDeclared: 12, documents })
      .expect(201);
    return { id: (res.body.gateIn ?? res.body).id as string, code: (res.body.gateIn ?? res.body).code as string };
  }

  /** `grn.submit` through the DEVICE route (the handheld's path). */
  async function receive(body: Record<string, unknown>, key = ulid()): Promise<Grn> {
    const res = await http().post(`${API}/${tenantId}/receiving/goods-receipts`).set(auth(operatorToken)).set(KEY_HEADER, key)
      .send({ warehouseId, occurredAt: occurredAt(), ...body }).expect(201);
    return res.body.goodsReceipt as Grn;
  }

  function blind(clientId: string, lines: Record<string, unknown>[]): Promise<Grn> {
    return receive({ poId: null, blindReasonCode: 'unannounced-delivery', clientId, lines });
  }

  const docLine = (code: string, qty: number, extra: Record<string, unknown> = {}) => ({ poLineId: null, skuId: sku.get(code), batchCode: null, mfgDate: null, qty, ...extra });

  const staffDoc = (grnId: string, token = opsToken) => http().get(`${API}/${tenantId}/receiving/goods-receipts/${grnId}/document`).set(auth(token));
  const staffFile = (grnId: string, query: string, token = opsToken) =>
    http().get(`${API}/${tenantId}/receiving/goods-receipts/${grnId}/document/file${query}`).set(auth(token)).buffer(true).parse(binary);
  const portalDetail = (grnId: string, token = portalToken) => http().get(`${API}/${tenantId}/portal/inbound/goods-receipts/${grnId}`).set(auth(token));
  const portalFile = (grnId: string, query: string, token = portalToken) =>
    http().get(`${API}/${tenantId}/portal/inbound/goods-receipts/${grnId}/document/file${query}`).set(auth(token)).buffer(true).parse(binary);

  function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
    const stream = res as unknown as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => done(null, Buffer.concat(chunks)));
  }

  const drain = async () => {
    await sql`update outbox_messages set next_attempt_at = now() where tenant_id = ${tenantId} and status = 'pending' and next_attempt_at > now()`;
    return relay.drain(500);
  };

  // ── the freeze ─────────────────────────────────────────────────────────────

  describe('the freeze in grn.submit (device path)', () => {
    let po: { id: string; code: string; lineIds: string[] };
    let grn: Grn;
    let submitKey: string;

    beforeAll(async () => {
      po = await purchaseOrder(vendorId, [{ code: 'A-TEE', qty: 100 }, { code: 'A-RICE', qty: 20 }]);
      submitKey = ulid();
      grn = await receive(
        {
          poId: po.id,
          lines: [
            { poLineId: po.lineIds[0], skuId: sku.get('A-TEE'), batchCode: null, mfgDate: null, qty: 120, damagedQty: 3, damageReasonCode: 'crushed', shortQty: 2, shortReasonCode: 'not-shipped' },
            { poLineId: po.lineIds[1], skuId: sku.get('A-RICE'), batchCode: null, mfgDate: null, qty: 12.5 },
          ],
        },
        submitKey,
      );
    });

    it('document_parties holds v, the warehouse (no person — A3), the client and the PO’s frozen vendor', async () => {
      const row = (await sql`select document_parties from goods_receipt_notes where id = ${grn.id}`)[0]!.document_parties as Record<string, Record<string, unknown> | number>;
      expect(Object.keys(row).sort()).toEqual(['client', 'v', 'vendor', 'warehouse']);
      expect(row.v).toBe(1);
      const warehouse = row.warehouse as Record<string, unknown>;
      expect(Object.keys(warehouse).sort()).toEqual(['address', 'code', 'gstin', 'name', 'operatorName']);
      expect(Object.keys(warehouse.address as object).sort()).toEqual(['city', 'line1', 'line2', 'pincode', 'state']);
      expect(JSON.stringify(row)).not.toMatch(/Priya|98450/);
      expect(warehouse).toMatchObject({ name: 'Peenya DC', gstin: '29AAAAA0000A1Z5' });
      expect(row.client).toMatchObject({ v: 1, code: 'ACME', name: 'ACME Brand' });
      expect(row.vendor).toMatchObject({ v: 1, code: 'V-01', name: 'Fabrics Co' });
    });

    it('decision 13: the stored snapshot and the grn.recorded payload carry no parties — the snapshot is exactly {goodsReceipt, …} as before', async () => {
      const stored = (await sql`select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${submitKey}`)[0]!.response_snapshot as Record<string, unknown>;
      const outbox = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'grn.recorded' and payload->'goodsReceipt'->>'id' = ${grn.id}`)[0]!.payload as Record<string, unknown>;
      expect(JSON.stringify(stored)).not.toMatch(/documentParties|document_parties|operatorName/);
      expect(JSON.stringify(outbox)).not.toMatch(/documentParties|document_parties|operatorName/);
      // The payload IS the snapshot's goodsReceipt (receiving.command) — a sibling key would show here.
      expect(outbox.goodsReceipt).toEqual((stored as { goodsReceipt: unknown }).goodsReceipt);
      expect(Object.keys((stored as { goodsReceipt: object }).goodsReceipt).sort()).toMatchSnapshot();
      expect(Object.keys(stored).sort()).toMatchSnapshot();
    });

    it('AC: a rename of the client and a GSTIN edit of the warehouse leave the GRN document as recorded; parties.frozen is true', async () => {
      await sql`update clients set name = 'ACME Brands Renamed' where id = ${acme}`;
      await sql`update warehouses set gstin = '29ZZZZZ9999Z1Z9' where id = ${warehouseId}`;
      try {
        const res = await staffDoc(grn.id).expect(200);
        expect(res.body.parties.frozen).toBe(true);
        expect(res.body.parties.client).toMatchObject({ code: 'ACME', name: 'ACME Brand' });
        expect(res.body.parties.warehouse).toMatchObject({ gstin: '29AAAAA0000A1Z5', operatorName: expect.any(String) });
        expect(Object.keys(res.body.parties.warehouse).sort()).toEqual(['address', 'code', 'gstin', 'legalName', 'name', 'operatorName']);
        const pdf = await staffFile(grn.id, '?format=pdf').expect(200);
        const text = (await pdfText(pdf.body as Buffer)).split('\n').join(' ');
        expect(text).toContain('ACME — ACME Brand');
        expect(text).not.toContain('Renamed');
        expect(text).toContain('GSTIN 29AAAAA0000A1Z5');
        expect(text).not.toMatch(/Priya|98450/);
      } finally {
        await sql`update clients set name = 'ACME Brand' where id = ${acme}`;
        await sql`update warehouses set gstin = '29AAAAA0000A1Z5' where id = ${warehouseId}`;
      }
    });

    it('the JSON: the over-receipt pending, damage with labels, the fractional line, the totals per UoM', async () => {
      const res = await staffDoc(grn.id).expect(200);
      expect(res.body.document).toMatchObject({ kind: 'po', code: po.code, label: `PO ${po.code}` });
      const [tee, rice] = res.body.lines as Record<string, unknown>[];
      expect(tee).toMatchObject({
        lineNo: 1,
        skuCode: 'A-TEE',
        goodQty: 120,
        expectedQty: 100,
        damagedQty: 3,
        damageReasonCode: 'crushed',
        damageReasonLabel: 'Crushed',
        shortQty: 2,
        shortReasonLabel: 'Not shipped',
        excess: { pendingQty: 20, approvedQty: 0, rejectedQty: 0 },
        qc: { status: null, heldQty: 0 },
      });
      expect(rice).toMatchObject({ uom: 'kg', uomPrecision: 3, goodQty: 12.5 });
      expect(res.body.totals).toEqual({ lineCount: 2, byUom: [{ uom: 'each', goodQty: 120, damagedQty: 3, shortQty: 2 }, { uom: 'kg', goodQty: 12.5, damagedQty: 0, shortQty: 0 }] });
      const pdf = (await pdfText((await staffFile(grn.id, '?format=pdf').expect(200)).body as Buffer)).split('\n').join(' ');
      expect(pdf).toContain('20 awaiting approval');
      expect(pdf).toContain('12.500');
    });

    it('the staff file routes: PDF and CSV headers; format required; 400 / 404 / 403 arms', async () => {
      const pdf = await staffFile(grn.id, '?format=pdf').expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.headers['content-disposition']).toBe(`attachment; filename="${grn.code}.pdf"`);
      expect(pdf.headers['cache-control']).toBe('no-store');
      expect(Number(pdf.headers['content-length'])).toBe((pdf.body as Buffer).length);
      expect((pdf.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const csv = await staffFile(grn.id, '?format=csv').expect(200);
      expect(csv.headers['content-type']).toMatch(/^text\/csv/);
      expect(csv.headers['content-disposition']).toBe(`attachment; filename="${grn.code}-lines.csv"`);
      const csvText = (csv.body as Buffer).toString('utf8');
      expect(csvText.startsWith('﻿grnCode,')).toBe(true);
      expect(csvText.split('\r\n').filter((line) => line.length > 0)).toHaveLength(3);
      expect((await staffFile(grn.id, '').expect(400)).body).toBeDefined();
      expect(JSON.parse(((await staffFile(grn.id, '?format=xlsx').expect(400)).body as Buffer).toString('utf8')).code).toBe('validation-failed');
      expect(JSON.parse(((await staffFile('not-a-uuid', '?format=pdf').expect(400)).body as Buffer).toString('utf8')).code).toBe('validation-failed');
      expect(JSON.parse(((await staffFile(uuidv7(), '?format=pdf').expect(404)).body as Buffer).toString('utf8')).code).toBe('not-found');
      expect(JSON.parse(((await staffFile(grn.id, '?format=pdf', portalToken).expect(403)).body as Buffer).toString('utf8')).code).toBe('role-denied');
      expect((await staffDoc(uuidv7()).expect(404)).body.code).toBe('not-found');
      expect((await staffDoc(grn.id, portalToken).expect(403)).body.code).toBe('role-denied');
    });

    it('the portal: the detail keeps every 2-5a key and gains the header and the line keys; the file is the same document', async () => {
      const res = await portalDetail(grn.id).expect(200);
      for (const key of ['id', 'code', 'warehouseName', 'poCode', 'asnCode', 'lineCount', 'receivedTotal', 'damagedTotal', 'shortTotal', 'photoCount', 'receivedAt', 'createdAt', 'lines', 'parties', 'document', 'arrival', 'totals']) {
        expect(res.body).toHaveProperty(key);
      }
      expect(res.body.parties).toMatchObject({ frozen: true, client: { code: 'ACME' }, vendor: { code: 'V-01' } });
      expect(res.body.lines[0]).toMatchObject({
        lineNo: 1,
        skuCode: 'A-TEE',
        qty: 120,
        damageReasonCode: 'crushed',
        photos: [],
        uom: 'each',
        excess: { pendingQty: 20, approvedQty: 0, rejectedQty: 0 },
        qc: { status: null },
        serialCount: 0,
      });
      expect(res.body.lines[0]).not.toHaveProperty('id');
      const portalPdf = await portalFile(grn.id, '?format=pdf').expect(200);
      expect(portalPdf.headers['content-disposition']).toBe(`attachment; filename="${grn.code}.pdf"`);
      const staffText = (await pdfText((await staffFile(grn.id, '?format=pdf').expect(200)).body as Buffer)).replace(/Printed [^\n]+/g, '');
      const portalText = (await pdfText(portalPdf.body as Buffer)).replace(/Printed [^\n]+/g, '');
      expect(portalText).toBe(staffText);
      expect((await portalFile(grn.id, '?format=csv').expect(200)).headers['content-type']).toMatch(/^text\/csv/);
    });
  });

  // ── isolation ──────────────────────────────────────────────────────────────

  describe('portal isolation', () => {
    it('AC: BETA’s GRN, an unknown id and a null-client GRN are the same 404; a staff token is 403; format is required', async () => {
      const betaGrn = await blind(beta, [docLine('B-TEE', 1)]);
      const legacyMixed = await blind(acme, [docLine('A-TEE', 1)]);
      // An older build's mixed-client receipt: no client, and recorded before frozen documents.
      await sql`update goods_receipt_notes set client_id = null, document_parties = null where id = ${legacyMixed.id}`;
      const details: string[] = [];
      for (const id of [betaGrn.id, uuidv7(), legacyMixed.id]) {
        const res = await portalFile(id, '?format=pdf').expect(404);
        const body = JSON.parse((res.body as Buffer).toString('utf8')) as { code: string; detail: string };
        expect(body.code).toBe('not-found');
        details.push(body.detail.replace(id, '<id>'));
        expect((await portalDetail(id).expect(404)).body.code).toBe('not-found');
      }
      expect(new Set(details).size).toBe(1);
      expect(JSON.parse(((await portalFile(betaGrn.id, '?format=pdf', opsToken).expect(403)).body as Buffer).toString('utf8')).code).toBeDefined();
      await portalFile(betaGrn.id, '').expect(400);
      // The staff copy of the mixed-client receipt prints "several".
      const staff = await staffDoc(legacyMixed.id).expect(200);
      expect(staff.body.parties.client).toBeNull();
    });
  });

  // ── legacy ─────────────────────────────────────────────────────────────────

  describe('a GRN recorded before frozen documents', () => {
    it('AC: document_parties NULL prints the live parties and the note — staff, portal (under the stamp) and the mail renderer', async () => {
      const grn = await blind(acme, [docLine('A-TEE', 2)]);
      await sql`update goods_receipt_notes set document_parties = null where id = ${grn.id}`;
      await sql`update clients set name = 'ACME Live Name' where id = ${acme}`;
      try {
        const staff = await staffDoc(grn.id).expect(200);
        expect(staff.body.parties).toMatchObject({ frozen: false, client: { name: 'ACME Live Name' }, supplierNote: 'Unannounced — Unannounced delivery' });
        const note = 'Party details are current, not as at receipt (recorded before frozen documents).';
        expect((await pdfText((await staffFile(grn.id, '?format=pdf').expect(200)).body as Buffer)).split('\n').join(' ')).toContain(note);
        expect((await pdfText((await portalFile(grn.id, '?format=pdf').expect(200)).body as Buffer)).split('\n').join(' ')).toContain('ACME Live Name');
        const rendered = await registry.render('grn-pdf', tenantId, acme, grn.id);
        expect(rendered).not.toBeNull();
        expect((await pdfText(rendered!.content)).split('\n').join(' ')).toContain(note);
      } finally {
        await sql`update clients set name = 'ACME Brand' where id = ${acme}`;
      }
    });
  });

  // ── the shared truck ───────────────────────────────────────────────────────

  describe('arrival documents on a shared truck (decision 7, A9)', () => {
    it('AC: ACME’s GRN prints INV-1 only (BETA’s INV-9 and the unlinked BOE omitted, with the note); no package count, no driver', async () => {
      const acmePo = await purchaseOrder(vendorId, [{ code: 'A-TEE', qty: 10 }]);
      const betaPo = await purchaseOrder(betaVendorId, [{ code: 'B-TEE', qty: 10 }]);
      const today = new Date().toISOString().slice(0, 10);
      const truck = await gateIn([
        { kind: 'invoice', number: 'INV-1', documentDate: today, poId: acmePo.id },
        { kind: 'invoice', number: 'INV-9', documentDate: today, poId: betaPo.id },
        { kind: 'bill_of_entry', number: 'BOE-3', documentDate: today },
      ]);
      const acmeGrn = await receive({ poId: acmePo.id, gateInId: truck.id, lines: [{ poLineId: acmePo.lineIds[0], skuId: sku.get('A-TEE'), batchCode: null, mfgDate: null, qty: 10 }] });
      await receive({ poId: betaPo.id, gateInId: truck.id, lines: [{ poLineId: betaPo.lineIds[0], skuId: sku.get('B-TEE'), batchCode: null, mfgDate: null, qty: 10 }] });
      const res = await staffDoc(acmeGrn.id).expect(200);
      expect(res.body.arrival).toMatchObject({ gateInCode: truck.code, vehicleNo: 'KA01AB1234', sealStatus: 'intact', documentsOmitted: true });
      expect((res.body.arrival.documents as { number: string }[]).map((d) => d.number)).toEqual(['INV-1']);
      expect(JSON.stringify(res.body)).not.toMatch(/Suresh|9876543210|packages/i);
      const text = (await pdfText((await portalFile(acmeGrn.id, '?format=pdf').expect(200)).body as Buffer)).split('\n').join(' ');
      expect(text).toContain('INV-1');
      expect(text).not.toContain('INV-9');
      expect(text).not.toContain('BOE-3');
      expect(text).toContain('Other documents of this vehicle are not shown.');
      expect(text).not.toMatch(/Suresh|9876543210|package/i);
    });

    it('A9: on a single-client truck an unlinked document prints, and a blind receipt prints it too', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const truck = await gateIn([{ kind: 'challan', number: 'DC-5', documentDate: today }]);
      const grn = await receive({ poId: null, blindReasonCode: 'unannounced-delivery', clientId: acme, gateInId: truck.id, lines: [docLine('A-TEE', 1)] });
      const res = await staffDoc(grn.id).expect(200);
      expect(res.body.arrival).toMatchObject({ documentsOmitted: false, documents: [{ kind: 'challan', number: 'DC-5' }] });
    });
  });

  // ── QC ─────────────────────────────────────────────────────────────────────

  describe('the QC outcome from QC’s own record', () => {
    it('AC: a receipt hold inspected 18 passed, 2 failed reads {status inspected, heldQty 20, passedQty 18, failedQty 2} on the portal', async () => {
      await http().put(`${API}/${tenantId}/clients/${acme}/receiving-policy`).set(auth(ownerToken)).set(KEY_HEADER, ulid())
        .send({ receivingToleranceBps: 0, qcOnReceipt: true, expiryRequired: false, minShelfLifeDays: null }).expect(200);
      try {
        const grn = await blind(acme, [docLine('A-QC', 20, { batchCode: 'QC-1' })]);
        const hold = (await sql`select id from qc_holds where tenant_id = ${tenantId} and grn_line_id = ${grn.lines[0]!.id}`)[0]!.id as string;
        const open = await portalDetail(grn.id).expect(200);
        expect(open.body.lines[0].qc).toEqual({ status: 'on-hold', heldQty: 20, releasedQty: 0, passedQty: 0, failedQty: 0 });
        await http().post(`${API}/${tenantId}/receiving/qc-holds/${hold}/inspect`).set(auth(opsToken)).set(KEY_HEADER, ulid())
          .send({ lines: [{ batchId: grn.lines[0]!.batchId, passed: 18, failed: [{ reason: 'damaged', quantity: 2 }] }] }).expect(200);
        const res = await portalDetail(grn.id).expect(200);
        expect(res.body.lines[0].qc).toMatchObject({ status: 'inspected', heldQty: 20, passedQty: 18, failedQty: 2 });
        const text = (await pdfText((await portalFile(grn.id, '?format=pdf').expect(200)).body as Buffer)).split('\n').join(' ');
        expect(text).toContain('Passed 18 · Failed 2');
      } finally {
        await http().put(`${API}/${tenantId}/clients/${acme}/receiving-policy`).set(auth(ownerToken)).set(KEY_HEADER, ulid())
          .send({ receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null }).expect(200);
      }
    });
  });

  // ── the statement bound (A12, D12) ─────────────────────────────────────────

  describe('the read’s statement bound', () => {
    it('a 200-line frozen GRN is read in at most 15 statements', async () => {
      const lines = Array.from({ length: 200 }, (_, i) => docLine('A-LOT', 1, { batchCode: `L-${i + 1}` }));
      const grn = await blind(acme, lines);
      let count = 0;
      let counting = false;
      const client = postgres(process.env.DATABASE_URL!, {
        max: 1,
        onnotice: () => undefined,
        debug: () => {
          if (counting) count += 1;
        },
      });
      try {
        const countingDb = drizzle(client) as unknown as Database;
        const reader = app.get(GrnDocumentReader);
        const doc = await withTenantTransaction(countingDb, tenantId, async (tx) => {
          counting = true;
          const read = await reader.readInTx(tx, tenantId, grn.id, null, new Date().toISOString());
          counting = false;
          return read;
        });
        expect(doc!.lines).toHaveLength(200);
        expect(count).toBeGreaterThan(5);
        expect(count).toBeLessThanOrEqual(15);
      } finally {
        await client.end();
      }
      // And the 200-line PDF paginates (the layout spec pins the per-page invariants).
      const text = await pdfText((await staffFile(grn.id, '?format=pdf').expect(200)).body as Buffer);
      expect(text).toMatch(/Page 1 of [2-9]/);
    });
  });

  describe('the grouped qc.held read (A12)', () => {
    it('EXPLAIN: the REAL qcHeldTotalsQuery statement rides ledger_events_hold_ref_idx', async () => {
      const holdIds = Array.from({ length: 40 }, () => uuidv7());
      const statement = qcHeldTotalsQuery(db as unknown as TenantTx, tenantId, [warehouseId], holdIds).toSQL();
      const plan = await sql.begin(async (q) => {
        await q`set local enable_seqscan = off`;
        return (await q.unsafe(`explain ${statement.sql}`, statement.params as never[])) as unknown as Record<string, string>[];
      });
      expect(plan.map((row) => Object.values(row)[0]).join('\n')).toContain('ledger_events_hold_ref_idx');
    });
  });

  // ── the receipt email ──────────────────────────────────────────────────────

  describe('the receipt email’s GRN attachment (decision 17)', () => {
    let mailClient: string;

    beforeAll(async () => {
      mailClient = await client('MAILC', 'Mail Brand');
      await importSkus(mailClient, ['M-TEE,Mail tee,pcs,false']);
      for (const email of ['ana@mail.example', 'bo@mail.example']) {
        await http().post(`${API}/${tenantId}/clients/${mailClient}/contacts`).set(auth(ownerToken)).set(KEY_HEADER, ulid())
          .send({ name: email.split('@')[0], email, emailEvents: ['receipt.recorded'] }).expect(201);
      }
    });

    async function receiptRows(grnId: string) {
      return (await sql`
        select id, to_email, status, error_code, attempts, attachment_kind, attachment_ref, params->>'grnId' as grn
          from email_messages where tenant_id = ${tenantId} and client_id = ${mailClient} and attachment_ref = ${grnId} order by to_email
      `) as unknown as { id: string; to_email: string; status: string; error_code: string | null; attempts: number; attachment_kind: string; attachment_ref: string; grn: string }[];
    }

    async function recordAndQueue(): Promise<Grn> {
      const grn = await blind(mailClient, [docLine('M-TEE', 3)]);
      await drain();
      return grn;
    }

    it('AC: the row carries grn-pdf + the GRN; the log gateway gets ONE PDF named {GRN code}.pdf per recipient, two recipients cost one render, and the body names it and links /portal/inbound?grn=', async () => {
      const grn = await recordAndQueue();
      const rows = await receiptRows(grn.id);
      expect(rows.map((row) => [row.to_email, row.status, row.attachment_kind, row.grn])).toEqual([
        ['ana@mail.example', 'pending', 'grn-pdf', grn.id],
        ['bo@mail.example', 'pending', 'grn-pdf', grn.id],
      ]);
      const spy = jest.spyOn(registry, 'render');
      const before = captured.captured.length;
      let renders: number;
      try {
        await mail.sendDue(tenantId, 50);
        renders = spy.mock.calls.filter((call) => call[3] === grn.id).length;
      } finally {
        spy.mockRestore();
      }
      expect(renders).toBe(1);
      const sent = captured.captured.slice(before).filter((email) => email.template === 'client-receipt' && email.text.includes(grn.code));
      expect(sent).toHaveLength(2);
      for (const email of sent) {
        expect(email.attachments).toHaveLength(1);
        expect(email.attachments![0]!.filename).toBe(`${grn.code}.pdf`);
        expect(email.attachments![0]!.contentType).toBe('application/pdf');
        expect(Buffer.from(email.attachments![0]!.content).subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(email.text).toContain(`The goods receipt note is attached (${grn.code}.pdf).`);
        expect(email.text).toContain(`https://app.wms.test/portal/inbound?grn=${grn.id}`);
      }
      expect((await receiptRows(grn.id)).map((row) => row.status)).toEqual(['sent', 'sent']);
    });

    it('AC: a render that throws once leaves the row pending attachment-failed with one attempt; the next run past the backoff sends it', async () => {
      const grn = await recordAndQueue();
      const spy = jest.spyOn(registry, 'render').mockRejectedValue(new Error('db blip'));
      try {
        await mail.sendDue(tenantId, 50);
      } finally {
        spy.mockRestore();
      }
      expect((await receiptRows(grn.id)).map((row) => [row.status, row.error_code, row.attempts])).toEqual([
        ['pending', 'attachment-failed', 1],
        ['pending', 'attachment-failed', 1],
      ]);
      await sql`update email_messages set next_attempt_at = now() where tenant_id = ${tenantId} and attachment_ref = ${grn.id}`;
      const before = captured.captured.length;
      await mail.sendDue(tenantId, 50);
      expect((await receiptRows(grn.id)).map((row) => row.status)).toEqual(['sent', 'sent']);
      expect(captured.captured.slice(before).filter((email) => email.text.includes(grn.code)).every((email) => email.attachments?.length === 1)).toBe(true);
    });

    it('A14: on the last allowed attempt a throwing render sends the email WITHOUT the file, with the fallback sentence', async () => {
      const grn = await recordAndQueue();
      await sql`update email_messages set attempts = 4 where tenant_id = ${tenantId} and attachment_ref = ${grn.id}`;
      const spy = jest.spyOn(registry, 'render').mockRejectedValue(new Error('still broken'));
      const before = captured.captured.length;
      try {
        await mail.sendDue(tenantId, 50);
      } finally {
        spy.mockRestore();
      }
      const sent = captured.captured.slice(before).filter((email) => email.text.includes(grn.code));
      expect(sent).toHaveLength(2);
      for (const email of sent) {
        expect(email.attachments).toBeUndefined();
        expect(email.text).toContain('The GRN could not be attached — download it from the client portal, or reply to this email to ask for it.');
      }
    });

    it('A13/A14: a row whose client is not the GRN’s gets null from the stamped renderer — sent without the file', async () => {
      const grn = await recordAndQueue();
      await sql`update email_messages set client_id = ${beta} where tenant_id = ${tenantId} and attachment_ref = ${grn.id}`;
      const before = captured.captured.length;
      await mail.sendDue(tenantId, 50);
      const sent = captured.captured.slice(before).filter((email) => email.text.includes(grn.code));
      expect(sent).toHaveLength(2);
      expect(sent.every((email) => email.attachments === undefined && email.text.includes('could not be attached'))).toBe(true);
    });

    it('A16: above the size bound the email goes without the file ("too large to attach")', async () => {
      const grn = await recordAndQueue();
      const gateway = new RecordingGateway();
      await new MailSender(db, gateway, registry, { attachmentMaxBytes: 1 }).sendDue(tenantId, 50);
      const sent = gateway.calls.filter((email) => email.text.includes(grn.code));
      expect(sent).toHaveLength(2);
      expect(sent.every((email) => email.attachments === undefined && email.text.includes('too large to attach'))).toBe(true);
    });

    it('D7: past the render budget the rows are released pending attachment-deferred with no attempt spent', async () => {
      const grn = await recordAndQueue();
      const gateway = new RecordingGateway();
      await new MailSender(db, gateway, registry, { renderBudgetMs: 0 }).sendDue(tenantId, 50);
      expect(gateway.calls.filter((email) => email.text.includes(grn.code))).toHaveLength(0);
      expect((await receiptRows(grn.id)).map((row) => [row.status, row.error_code, row.attempts])).toEqual([
        ['pending', 'attachment-deferred', 0],
        ['pending', 'attachment-deferred', 0],
      ]);
      await mail.sendDue(tenantId, 50);
      expect((await receiptRows(grn.id)).map((row) => row.status)).toEqual(['sent', 'sent']);
    });

    it('no renderer registered: pending attachment-unavailable (config), no attempt spent, reported in configCodes', async () => {
      const grn = await recordAndQueue();
      const gateway = new RecordingGateway();
      const summary = await new MailSender(db, gateway, new MailAttachmentRegistry(db)).sendDue(tenantId, 50);
      expect(summary.configCodes).toContain('attachment-unavailable');
      expect((await receiptRows(grn.id)).map((row) => [row.status, row.error_code, row.attempts])).toEqual([
        ['pending', 'attachment-unavailable', 0],
        ['pending', 'attachment-unavailable', 0],
      ]);
      await sql`update email_messages set next_attempt_at = now() where tenant_id = ${tenantId} and attachment_ref = ${grn.id}`;
      await mail.sendDue(tenantId, 50);
    });

    it('a pre-story row (no attachment columns, no grnId) is sent exactly as 5-2b renders it', async () => {
      const grn = await recordAndQueue();
      await sql`update email_messages set attachment_kind = null, attachment_ref = null, params = params - 'grnId' where tenant_id = ${tenantId} and params->>'grnCode' = ${grn.code}`;
      const before = captured.captured.length;
      await mail.sendDue(tenantId, 50);
      const sent = captured.captured.slice(before).filter((email) => email.text.includes(grn.code));
      expect(sent).toHaveLength(2);
      for (const email of sent) {
        expect(email.attachments).toBeUndefined();
        expect(email.text).not.toMatch(/attached|could not be attached|too large/);
        expect(email.text).toContain('https://app.wms.test/portal/inbound\n');
      }
    });
  });
});
