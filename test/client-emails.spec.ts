import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import type { DomainEvent } from '../src/shared/events/event-bus.seam';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import { withTenantTransaction, type TenantTx } from '../src/shared/db/tenant-scope';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { InvoiceDeliveryHandler } from '../src/modules/invoicing/delivery';
import { EmailSenderWorker } from '../src/jobs/jobs.module';
import { MailFacade, clientEmailCountsTodayInTx, latestClientEmailsQuery } from '../src/modules/mail/mail.facade';
import { MailSender, dueClaimQuery } from '../src/modules/mail/mail.sender';
import { EMAIL_GATEWAY, type EmailGateway, type EmailSendResult, type LogEmailGateway, type OutgoingEmail } from '../src/modules/mail/email.gateway';
import { ClientEmailsEnqueueHandler } from '../src/modules/client-emails/client-emails.enqueue';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey, seededIdempotencyKey } from './support/audit-guard';
import { mintSignIn } from './support/sign-in';
import { testAddress } from './support/shipment-address';
import { dispatchedOrderFixtures, type Picklist } from './support/dispatched-order';

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
// Story 5-2b — the `log` provider (captured in memory, nothing leaves the
// process) and client emails switched ON (A4's kill switch defaults off).
process.env.EMAIL_PROVIDER = 'log';
process.env.EMAIL_FROM = 'no-reply@mail.wms.test';
process.env.WEB_BASE_URL = 'https://app.wms.test/';
process.env.EMAIL_SEAL_KEY = 'e2e-only-email-seal-key-0123456789abcdef';
delete process.env.EMAIL_SEAL_KEY_PREVIOUS;
process.env.CLIENT_EMAIL_ENABLED = 'true';

jest.setTimeout(240_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

interface MailRow {
  id: string;
  template: string;
  to_email: string;
  client_id: string | null;
  dedupe_key: string | null;
  priority: number;
  status: string;
  error_code: string | null;
  params: Record<string, unknown>;
}

/** A scripted gateway: answers each send with `answer(email)` and records every call. */
class ScriptedGateway implements EmailGateway {
  readonly mode = 'ses' as const;
  readonly calls: OutgoingEmail[] = [];
  constructor(private readonly answer: (email: OutgoingEmail) => EmailSendResult) {}
  async send(email: OutgoingEmail): Promise<EmailSendResult> {
    this.calls.push(email);
    return this.answer(email);
  }
}

/** A uuidv7 whose embedded time is `msAgo` in the past (the staleness rule reads it). */
function uuidv7Ago(msAgo: number): string {
  const hex = (Date.now() - msAgo).toString(16).padStart(12, '0');
  const fresh = uuidv7();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}${fresh.slice(13)}`;
}

/**
 * Story 5-2b — receipt and dispatch emails end to end, under
 * `EMAIL_PROVIDER=log`: the contact opt-ins and their hashes, the Reply-To
 * settings, the outbox subscriber (one row per recipient, deduped; every skip
 * arm writes nothing; the daily cap all-or-nothing on the database clock; the
 * kill switch; A6's one in-process retry then ack), the sender's claim order
 * and the per-tenant reserve, the cancels, the log read and the contact
 * badge, and the EXPLAIN pins of the claim and the badge read.
 */
describe('receipt and dispatch emails (e2e, story 5-2b)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let db: Database;
  let relay: OutboxRelay;
  let mail: MailFacade;
  let handler: ClientEmailsEnqueueHandler;
  let captured: LogEmailGateway;

  let tenantId: string;
  let tenantName: string;
  let ownerId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string;
  let warehouseId: string;
  let binId: string;
  let acme: string;
  let selfClient: string;
  const sku = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('clientemails');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    db = app.get<Database>(DATABASE);
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    mail = app.get(MailFacade);
    handler = app.get(ClientEmailsEnqueueHandler);
    captured = app.get<LogEmailGateway>(EMAIL_GATEWAY);

    const registered = await registerTenant(`Acme 3PL ${ulid()}`);
    tenantId = registered.tenantId;
    tenantName = registered.name;
    ownerId = registered.ownerId;
    ownerToken = registered.ownerToken;
    opsToken = (await createMember('ops_manager')).token;
    const floor = await createMember('operator');

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
        .send({ capacity: 1000000, type: 'shelf', code: 'A-01-01' }).expect(201)
    ).body.id as string;

    acme = await createClient('ACME', 'ACME Brand');
    selfClient = (await sql`select id from clients where tenant_id = ${tenantId} and system_owned`)[0]!.id as string;
    await importCsv(['A-TEE,Acme tee,pcs,1800,,,', 'A-RICE,Acme rice,kg,500,,,', 'A-KIT,Acme gift box,pcs,1800,,,', 'A-C1,Kit mug,pcs,1800,,,', 'A-C2,Kit card,pcs,1800,,,'], acme);
    const listed = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of listed.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    await http().post(`${API}/${tenantId}/catalog/skus/${sku.get('A-KIT')}/kit`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: sku.get('A-C1'), quantity: 1 }, { skuId: sku.get('A-C2'), quantity: 2 }] }).expect(201);
    for (const code of ['A-TEE', 'A-RICE', 'A-C1', 'A-C2']) await adjust(sku.get(code)!, 1000);
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'Email scanner', pin: '2468' }).expect(201);
    operatorToken = (
      await http().post(`${API}/${tenantId}/devices/badge-in`).set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: floor.email, pin: '2468' }).expect(200)
    ).body.accessToken as string;
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

  async function registerTenant(name: string): Promise<{ tenantId: string; ownerId: string; ownerToken: string; name: string }> {
    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name, ownerEmail, password: PASSWORD }).expect(201);
    return {
      tenantId: registered.body.tenant.id as string,
      ownerId: registered.body.owner.id as string,
      ownerToken: (await mintSignIn(app, { email: ownerEmail, password: PASSWORD })).body.accessToken as string,
      name: registered.body.tenant.name as string,
    };
  }

  async function createMember(role: string, t = tenantId, token = ownerToken): Promise<{ token: string; email: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http().post(`${API}/${t}/users`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, ulid()).send({ email, role }).expect(201);
    await http().post(`${API}/${t}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
    return { token: (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string, email };
  }

  async function createClient(code: string, name: string): Promise<string> {
    return (await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name }).expect(201)).body.client.id as string;
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,gst_rate,product,variant_values,kit_components', ...rows].join('\n');
    await http().post(`${API}/${tenantId}/catalog/imports`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
      .field('mode', 'initial').field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' }).expect(201);
  }

  async function adjust(skuId: string, quantityDelta: number): Promise<void> {
    await http().post(`${API}/${tenantId}/inventory/adjustments`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta, reasonCode: 'stock-count', note: 'email seed' }).expect(201);
  }

  const contacts = (clientId: string) => `${API}/${tenantId}/clients/${clientId}/contacts`;

  function addContact(clientId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken) {
    return http().post(contacts(clientId)).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function editContact(clientId: string, contactId: string, body: Record<string, unknown>, key = ulid()) {
    return http().patch(`${contacts(clientId)}/${contactId}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key).send(body);
  }

  function removeContact(clientId: string, contactId: string) {
    return http().delete(`${contacts(clientId)}/${contactId}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid());
  }

  function setReplyTo(clientId: string, replyTo: unknown, key = ulid(), token = ownerToken) {
    return http().patch(`${API}/${tenantId}/clients/${clientId}/email-settings`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({ replyTo });
  }

  function emailLog(clientId: string, query = '', token = opsToken) {
    return http().get(`${API}/${tenantId}/clients/${clientId}/emails${query}`).set('Authorization', `Bearer ${token}`);
  }

  async function mailRows(clientId: string, t = tenantId): Promise<MailRow[]> {
    return (await sql`
      select id, template, to_email, client_id, dedupe_key, priority, status, error_code, params
        from email_messages where tenant_id = ${t} and client_id = ${clientId} order by created_at, id
    `) as unknown as MailRow[];
  }

  async function wipeMail(clientId: string): Promise<void> {
    // Test isolation: this suite's own client-email rows only (no audit or key rows are touched).
    await sql`delete from email_messages where tenant_id = ${tenantId} and client_id = ${clientId}`;
  }

  // The append stamps `next_attempt_at` with the APP clock and the relay compares
  // with the DATABASE clock: a few ms of skew would leave a fresh row not yet due (C32).
  const drain = async () => {
    await sql`update outbox_messages set next_attempt_at = now() where tenant_id = ${tenantId} and status = 'pending' and next_attempt_at > now()`;
    return relay.drain(500);
  };

  function scannedOf(picklist: Picklist): { skuId: string; qty: number }[] {
    const by = new Map<string, number>();
    for (const line of picklist.lines) by.set(line.skuId, (by.get(line.skuId) ?? 0) + line.qty);
    return [...by.entries()].map(([skuId, qty]) => ({ skuId, qty }));
  }

  async function dispatchOrder(lines: { skuId: string; quantity: number }[], dispatchBody: Record<string, unknown> = {}, orderExtra: Record<string, unknown> = {}): Promise<string> {
    const ready = await fixtures.releasedWave(lines, { clientOrderRef: `CO-${ulid().slice(18)}`, ...orderExtra });
    await fixtures.pickAllLines(ready.picklist);
    await fixtures.packAndDispatch(ready.orderId, scannedOf(ready.picklist), dispatchBody);
    return ready.orderId;
  }

  async function recordBlindGrn(lines: { skuId: string; qty: number }[]): Promise<{ id: string; code: string }> {
    const grn = await http().post(`${API}/${tenantId}/receiving/goods-receipts`).set('Authorization', `Bearer ${operatorToken}`).set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        poId: null,
        blindReasonCode: 'unannounced-delivery',
        occurredAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
        lines: lines.map((line) => ({ poLineId: null, skuId: line.skuId, batchCode: null, mfgDate: null, qty: line.qty })),
      })
      .expect(201);
    return { id: grn.body.goodsReceipt.id as string, code: grn.body.goodsReceipt.code as string };
  }

  /** A synthetic `grn.recorded` event for `clientId` (its eventId fresh unless `eventId` is given). */
  function receiptEvent(clientId: string | null, opts: { eventId?: string; grnId?: string } = {}): DomainEvent {
    return {
      eventId: opts.eventId ?? uuidv7(),
      type: 'grn.recorded',
      tenantId,
      occurredAt: new Date().toISOString(),
      payload: {
        goodsReceipt: {
          id: opts.grnId ?? uuidv7(),
          code: `GRN-S${ulid().slice(20)}`,
          ...(clientId === null ? {} : { clientId }),
          warehouseId,
          poId: null,
          recordedAt: new Date().toISOString(),
          lines: [{ id: uuidv7(), skuId: sku.get('A-TEE'), batchCode: null, qty: 2, appliedQty: 2, excessQty: 0 }],
        },
      },
    };
  }

  async function seedClientRows(clientId: string, template: 'client-receipt' | 'client-dispatch', n: number, createdAt = sql`now()`, status = 'sent'): Promise<void> {
    const tag = ulid();
    await sql`
      insert into email_messages (id, tenant_id, template, to_email, params, status, next_attempt_at, client_id, dedupe_key, priority, created_at, updated_at)
      select gen_random_uuid(), ${tenantId}, ${template}, 'seed@acme.example', '{}'::jsonb, ${status}, now(), ${clientId}, ${template} || ':' || ${tag} || ':' || g, 1, ${createdAt}, ${createdAt}
        from generate_series(1, ${n}) g
    `;
  }

  async function withEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await run();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  /** Params a `client-receipt` row renders from (a seeded backlog the sender really attempts). */
  const renderableReceipt = {
    tenantName: 'Backlog 3PL',
    clientName: 'Back',
    warehouseName: 'Main',
    grnCode: 'GRN-B',
    poCode: null,
    asnCode: null,
    recordedAt: '2026-10-30T00:00:00.000Z',
    replyTo: null,
    lines: [],
    moreLines: 0,
    totals: { received: '0', damaged: '0', short: '0' },
    qcHeldLines: 0,
  };
  const hashOf = (json: string) => createHash('sha256').update(json, 'utf8').digest('hex');

  // ── the contact opt-ins ────────────────────────────────────────────────────

  describe('contacts: email events', () => {
    let client: string;

    beforeAll(async () => {
      client = await createClient('OPTS', 'Opts Brand');
    });

    it('an opt-in is stored sorted in vocabulary order and read back; the list carries emailEvents and lastEmail null', async () => {
      const res = await addContact(client, { name: 'Asha', email: 'asha@opts.example', emailEvents: ['order.dispatched', 'receipt.recorded'] }).expect(201);
      expect(res.body.contact.emailEvents).toEqual(['receipt.recorded', 'order.dispatched']);
      expect((await sql`select email_events from client_contacts where id = ${res.body.contact.id as string}`)[0]!.email_events).toEqual(['receipt.recorded', 'order.dispatched']);
      const list = await http().get(contacts(client)).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect(list.body.items[0]).toMatchObject({ email: 'asha@opts.example', emailEvents: ['receipt.recorded', 'order.dispatched'], lastEmail: null });
    });

    it('absent on add means none; absent on edit means unchanged; [] clears', async () => {
      const added = await addContact(client, { name: 'Ravi', email: 'ravi@opts.example' }).expect(201);
      expect(added.body.contact.emailEvents).toEqual([]);
      const id = added.body.contact.id as string;
      expect((await editContact(client, id, { emailEvents: ['receipt.recorded'] }).expect(200)).body.contact.emailEvents).toEqual(['receipt.recorded']);
      expect((await editContact(client, id, { name: 'Ravi K' }).expect(200)).body.contact.emailEvents).toEqual(['receipt.recorded']);
      expect((await editContact(client, id, { emailEvents: [] }).expect(200)).body.contact.emailEvents).toEqual([]);
    });

    it('an unchanged emailEvents edit is the declared no-op (key stored, no audit)', async () => {
      const added = await addContact(client, { name: 'Same', email: 'same@opts.example', emailEvents: ['order.dispatched'] }).expect(201);
      const key = noOpIdempotencyKey(tenantId, ulid(), 'clients.contactEdit:unchanged');
      await editContact(client, added.body.contact.id as string, { emailEvents: ['order.dispatched'] }, key).expect(200);
      expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${key}`).toHaveLength(0);
      expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
    });

    it('validation: an unknown event is 400; a repeated event is 400 naming emailEvents; the self client may not opt in (400)', async () => {
      expect((await addContact(client, { name: 'X', email: 'x1@opts.example', emailEvents: ['invoice.issued'] }).expect(400)).body.code).toBe('validation-failed');
      const repeated = await addContact(client, { name: 'X', email: 'x2@opts.example', emailEvents: ['order.dispatched', 'order.dispatched'] }).expect(400);
      expect(repeated.body).toMatchObject({ code: 'validation-failed' });
      expect(repeated.body.detail).toMatch(/emailEvents must not repeat/);
      const self = await addContact(selfClient, { name: 'Own', email: 'own@self.example', emailEvents: ['receipt.recorded'] }).expect(400);
      expect(self.body.detail).toMatch(/warehouse's own client gets no client emails/);
      // The self client may still have contacts, and may clear (send []).
      const plain = await addContact(selfClient, { name: 'Own', email: 'own@self.example', emailEvents: [] }).expect(201);
      expect((await editContact(selfClient, plain.body.contact.id as string, { emailEvents: ['order.dispatched'] }).expect(400)).body.code).toBe('validation-failed');
      expect(await sql`select 1 from client_contacts where tenant_id = ${tenantId} and client_id = ${client} and email like 'x_@opts.example'`).toHaveLength(0);
    });

    it('golden: an add and an edit WITHOUT emailEvents hash byte for byte as before 5-2b; with it, the sorted list is appended', async () => {
      const addKey = ulid();
      const added = await addContact(client, { name: 'Golden', email: 'golden@opts.example' }, addKey).expect(201);
      const stored = async (key: string) => (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.payload_hash as string;
      expect(await stored(addKey)).toBe(
        hashOf(`{"arm":"contact-add","tenantId":"${tenantId}","clientId":"${client}","name":"Golden","email":"golden@opts.example","phone":null,"roles":[]}`),
      );
      const contactId = added.body.contact.id as string;
      const editKey = ulid();
      await editContact(client, contactId, { name: 'Golden Two' }, editKey).expect(200);
      expect(await stored(editKey)).toBe(
        hashOf(`{"arm":"contact-edit","tenantId":"${tenantId}","clientId":"${client}","contactId":"${contactId}","name":"Golden Two"}`),
      );
      const withKey = ulid();
      await editContact(client, contactId, { emailEvents: ['order.dispatched', 'receipt.recorded'] }, withKey).expect(200);
      expect(await stored(withKey)).toBe(
        hashOf(`{"arm":"contact-edit","tenantId":"${tenantId}","clientId":"${client}","contactId":"${contactId}","emailEvents":["receipt.recorded","order.dispatched"]}`),
      );
    });

    it('a contact-add key stored before 5-2b replays its snapshot with emailEvents [] (and the client snapshot with emailReplyTo null)', async () => {
      const key = seededIdempotencyKey(tenantId, ulid());
      const body = { name: 'Old', email: 'old@opts.example' };
      const hash = hashOf(`{"arm":"contact-add","tenantId":"${tenantId}","clientId":"${client}","name":"Old","email":"old@opts.example","phone":null,"roles":[]}`);
      const snapshot = {
        contact: { id: uuidv7(), clientId: client, name: 'Old', email: 'old@opts.example', phone: null, roles: [], isPrimary: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
      };
      await sql`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot) values (${uuidv7()}, ${tenantId}, ${key}, ${hash}, ${sql.json(snapshot)})`;
      const replay = await addContact(client, body, key).expect(201);
      expect(replay.body.contact).toMatchObject({ name: 'Old', emailEvents: [] });

      const renameKey = seededIdempotencyKey(tenantId, ulid());
      const renameHash = hashOf(`{"tenantId":"${tenantId}","clientId":"${client}","name":"Opts Brand"}`);
      const row = (await sql`select * from clients where id = ${client}`)[0]!;
      const clientSnapshot = {
        client: {
          id: client, tenantId, code: row.code, name: 'Opts Brand', status: 'active', systemOwned: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
          taxDetails: { legalName: null, gstin: null, billingLine1: null, billingLine2: null, billingCity: null, billingStateCode: null, billingPincode: null },
          registeredAddress: null, returnAddress: null,
        },
      };
      await sql`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot) values (${uuidv7()}, ${tenantId}, ${renameKey}, ${renameHash}, ${sql.json(clientSnapshot)})`;
      const replayed = await http().patch(`${API}/${tenantId}/clients/${client}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, renameKey).send({ name: 'Opts Brand' }).expect(200);
      expect(replayed.body.client).toMatchObject({ name: 'Opts Brand', emailReplyTo: null });
    });
  });

  // ── the Reply-To ───────────────────────────────────────────────────────────

  describe('email settings: the Reply-To', () => {
    let client: string;
    beforeAll(async () => {
      client = await createClient('REPLY', 'Reply Brand');
    });

    it('stores it lower-cased and trimmed; audited client.email_settings_updated with before/after; a replay writes nothing; every client read carries it', async () => {
      const key = ulid();
      const res = await setReplyTo(client, ' Ops@3pl.in ', key).expect(200);
      expect(res.body.client.emailReplyTo).toBe('ops@3pl.in');
      await expectAuditRow({ tenantId, key, action: 'client.email_settings_updated', targetType: 'client', targetId: client, actorUserId: ownerId });
      const changes = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`)[0]!.changes;
      expect(changes).toEqual({ replyTo: { before: null, after: 'ops@3pl.in' } });
      expect((await setReplyTo(client, ' Ops@3pl.in ', key).expect(200)).body).toEqual(res.body);
      await expectAuditRow({ tenantId, key, action: 'client.email_settings_updated', targetType: 'client', targetId: client, actorUserId: ownerId });
      const golden = hashOf(`{"arm":"email-settings","tenantId":"${tenantId}","clientId":"${client}","replyTo":"ops@3pl.in"}`);
      expect((await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.payload_hash).toBe(golden);
      const listed = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect((listed.body.items as { id: string; emailReplyTo: string | null }[]).find((c) => c.id === client)!.emailReplyTo).toBe('ops@3pl.in');
    });

    it('the same value again under a new key is a no-op that stores the key; null clears it', async () => {
      const key = noOpIdempotencyKey(tenantId, ulid(), 'clients.emailSettings:unchanged');
      await setReplyTo(client, 'ops@3pl.in', key).expect(200);
      expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${key}`).toHaveLength(0);
      expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
      expect((await setReplyTo(client, null).expect(200)).body.client.emailReplyTo).toBeNull();
      // Blank reads as null — already null, so the declared no-op again.
      expect((await setReplyTo(client, '   ', noOpIdempotencyKey(tenantId, ulid(), 'clients.emailSettings:unchanged')).expect(200)).body.client.emailReplyTo).toBeNull();
    });

    it('a bad shape is 400 naming replyTo; a missing key is 400; owner only (403); an unknown client is 404', async () => {
      expect((await setReplyTo(client, 'not-an-address').expect(400)).body.detail).toMatch(/replyTo/);
      await http().patch(`${API}/${tenantId}/clients/${client}/email-settings`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({}).expect(400);
      expect((await setReplyTo(client, 'ops@3pl.in', ulid(), opsToken).expect(403)).body.code).toBe('role-denied');
      await setReplyTo(uuidv7(), 'ops@3pl.in').expect(404);
    });
  });

  // ── the receipt path ───────────────────────────────────────────────────────

  describe('receipt emails end to end', () => {
    beforeAll(async () => {
      await addContact(acme, { name: 'A', email: 'a@acme.example', emailEvents: ['receipt.recorded'] }).expect(201);
      await addContact(acme, { name: 'B', email: 'b@acme.example', emailEvents: ['receipt.recorded', 'order.dispatched'] }).expect(201);
      await addContact(acme, { name: 'C', email: 'c@acme.example' }).expect(201);
    });
    afterEach(() => wipeMail(acme));

    it('AC: a GRN recorded on the handheld → two client-receipt rows (keys, priority 1), the sender captures one mail each with the pinned subject and every line in decimal strings', async () => {
      const grn = await recordBlindGrn([{ skuId: sku.get('A-RICE')!, qty: 12.5 }, { skuId: sku.get('A-TEE')!, qty: 3 }]);
      await drain();
      const rows = await mailRows(acme);
      expect(rows.map((r) => [r.template, r.to_email, r.status, r.priority, r.dedupe_key])).toEqual([
        ['client-receipt', 'a@acme.example', 'pending', 1, `client-receipt:${grn.id}:a@acme.example`],
        ['client-receipt', 'b@acme.example', 'pending', 1, `client-receipt:${grn.id}:b@acme.example`],
      ]);
      expect(rows[0]!.params).toMatchObject({ tenantName, clientName: 'ACME Brand', warehouseName: 'Main', grnCode: grn.code });
      const before = captured.captured.length;
      await mail.sendDue(tenantId);
      const sent = captured.captured.slice(before).filter((email) => email.template === 'client-receipt');
      expect(sent.map((email) => email.to).sort()).toEqual(['a@acme.example', 'b@acme.example']);
      for (const email of sent) {
        expect(email.subject).toBe(`ACME Brand: goods received at Main — ${grn.code}`);
        expect(email.fromName).toBe(`${tenantName} via WMS`);
        expect(email.text).toContain('- A-RICE Acme rice: received 12.500 kg, damaged 0.000 kg, short 0.000 kg');
        expect(email.text).toMatch(/- A-TEE Acme tee: received 3 \w+, damaged 0 \w+, short 0 \w+/);
        // Per UoM — never 12.5 kg + 3 units summed into one number.
        expect(email.text).toMatch(/Totals — received: 12\.500 kg, 3 \w+; damaged: 0\.000 kg, 0 \w+; short: 0\.000 kg, 0 \w+\./);
      }
      expect((await mailRows(acme)).map((r) => r.status)).toEqual(['sent', 'sent']);
    });

    it('the relay re-delivers the same row: still two rows (deduped on the subject, never the outbox id)', async () => {
      const grn = await recordBlindGrn([{ skuId: sku.get('A-TEE')!, qty: 1 }]);
      const outbox = (await sql`select id, payload from outbox_messages where tenant_id = ${tenantId} and type = 'grn.recorded' and payload->'goodsReceipt'->>'id' = ${grn.id}`)[0]!;
      const event: DomainEvent = { eventId: outbox.id as string, type: 'grn.recorded', tenantId, occurredAt: new Date().toISOString(), payload: outbox.payload };
      expect(await handler.deliver(event)).toEqual({ kind: 'queued', queued: 2, deduped: 0 });
      expect(await handler.deliver(event)).toEqual({ kind: 'queued', queued: 0, deduped: 2 });
      // An operator replay of the same subject under another outbox id dedupes too.
      expect(await handler.deliver({ ...event, eventId: uuidv7() })).toEqual({ kind: 'queued', queued: 0, deduped: 2 });
      await drain();
      expect(await mailRows(acme)).toHaveLength(2);
    });

    it('the client Reply-To rides the mail; without it the deployment default applies', async () => {
      await setReplyTo(acme, 'accounts@3pl.example.in').expect(200);
      try {
        await handler.deliver(receiptEvent(acme));
        const before = captured.captured.length;
        await mail.sendDue(tenantId);
        const sent = captured.captured.slice(before).filter((email) => email.template === 'client-receipt');
        expect(sent).toHaveLength(2);
        expect(sent.every((email) => email.replyTo === 'accounts@3pl.example.in')).toBe(true);
        expect(sent[0]!.text).toContain('reply to this email or ask');
      } finally {
        await setReplyTo(acme, null).expect(200);
      }
      await wipeMail(acme);
      await handler.deliver(receiptEvent(acme));
      const before = captured.captured.length;
      await mail.sendDue(tenantId);
      const sent = captured.captured.slice(before).filter((email) => email.template === 'client-receipt');
      expect(sent[0]!.replyTo).toBeNull();
      expect(sent[0]!.text).toContain('to remove you');
    });
  });

  // ── the skip arms ──────────────────────────────────────────────────────────

  describe('events that queue nothing (no row ever)', () => {
    afterEach(() => wipeMail(acme));

    it('no subscriber: a client with contacts but none opted in', async () => {
      const quiet = await createClient('QUIET', 'Quiet Brand');
      await addContact(quiet, { name: 'Q', email: 'q@quiet.example' }).expect(201);
      expect(await handler.deliver(receiptEvent(quiet))).toEqual({ kind: 'skipped', reason: 'no-subscriber' });
      expect(await mailRows(quiet)).toHaveLength(0);
    });

    it('no client (an older build’s mixed GRN), an unknown client, the self client, a departed client', async () => {
      expect(await handler.deliver(receiptEvent(null))).toEqual({ kind: 'skipped', reason: 'no-client' });
      expect(await handler.deliver(receiptEvent(uuidv7()))).toEqual({ kind: 'skipped', reason: 'no-client' });
      expect(await handler.deliver(receiptEvent(selfClient))).toEqual({ kind: 'skipped', reason: 'self-client' });
      const gone = await createClient('GONE', 'Gone Brand');
      await addContact(gone, { name: 'G', email: 'g@gone.example', emailEvents: ['receipt.recorded'] }).expect(201);
      await http().patch(`${API}/${tenantId}/clients/${gone}/status`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ status: 'departed' }).expect(200);
      expect(await handler.deliver(receiptEvent(gone))).toEqual({ kind: 'skipped', reason: 'client-departed' });
      expect(await sql`select 1 from email_messages where tenant_id = ${tenantId} and client_id in (${selfClient}, ${gone})`).toHaveLength(0);
    });

    it('a suspended client still gets mail (it still ships)', async () => {
      const paused = await createClient('PAUSED', 'Paused Brand');
      await addContact(paused, { name: 'P', email: 'p@paused.example', emailEvents: ['receipt.recorded'] }).expect(201);
      await http().patch(`${API}/${tenantId}/clients/${paused}/status`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ status: 'suspended' }).expect(200);
      expect(await handler.deliver(receiptEvent(paused))).toEqual({ kind: 'queued', queued: 1, deduped: 0 });
    });

    it('a stale event (appended 25 h ago, an operator replay) queues nothing; 23 h ago still does', async () => {
      expect(await handler.deliver(receiptEvent(acme, { eventId: uuidv7Ago(25 * 3600_000) }))).toEqual({ kind: 'skipped', reason: 'stale' });
      expect(await mailRows(acme)).toHaveLength(0);
      expect(await handler.deliver(receiptEvent(acme, { eventId: uuidv7Ago(23 * 3600_000) }))).toMatchObject({ kind: 'queued', queued: 2 });
    });

    it('a malformed payload is logged and acked, no rows', async () => {
      expect(await handler.deliver({ ...receiptEvent(acme), payload: { nonsense: true } })).toEqual({ kind: 'malformed' });
      expect(await handler.deliver({ ...receiptEvent(acme), type: 'order.dispatched', payload: { dispatch: { orderId: 'x' } } })).toEqual({ kind: 'malformed' });
      expect(await mailRows(acme)).toHaveLength(0);
    });

    it('the kill switch (A4): CLIENT_EMAIL_ENABLED=false acks every event and writes nothing; the log says clientMailEnabled false; opt-ins still editable', async () => {
      await withEnv({ CLIENT_EMAIL_ENABLED: 'false' }, async () => {
        expect(await handler.deliver(receiptEvent(acme))).toEqual({ kind: 'skipped', reason: 'disabled' });
        await recordBlindGrn([{ skuId: sku.get('A-TEE')!, qty: 1 }]);
        await drain();
        expect(await mailRows(acme)).toHaveLength(0);
        expect((await emailLog(acme).expect(200)).body).toMatchObject({ clientMailEnabled: false, mailEnabled: true });
        const c = await addContact(acme, { name: 'K', email: 'k@acme.example', emailEvents: ['receipt.recorded'] }).expect(201);
        await removeContact(acme, c.body.contact.id as string).expect(200);
      });
      expect((await emailLog(acme).expect(200)).body.clientMailEnabled).toBe(true);
    });

    it('EMAIL_PROVIDER=off: rows are written `skipped provider-off`, and the log reads mailEnabled false', async () => {
      await withEnv({ EMAIL_PROVIDER: 'off' }, async () => {
        await handler.deliver(receiptEvent(acme));
        expect((await mailRows(acme)).map((r) => [r.status, r.error_code])).toEqual([
          ['skipped', 'provider-off'],
          ['skipped', 'provider-off'],
        ]);
        expect((await emailLog(acme).expect(200)).body.mailEnabled).toBe(false);
      });
    });
  });

  // ── the daily cap ──────────────────────────────────────────────────────────

  describe('the daily cap (A5)', () => {
    it('499 rows today + a 3-recipient event: all 3 queued (502); the next event queues none and the log says capReachedToday', async () => {
      const busy = await createClient('BUSY', 'Busy Brand');
      for (const who of ['x', 'y', 'z']) await addContact(busy, { name: who, email: `${who}@busy.example`, emailEvents: ['receipt.recorded'] }).expect(201);
      await seedClientRows(busy, 'client-receipt', 499);
      expect((await emailLog(busy).expect(200)).body.capReachedToday).toEqual({ receipt: false, dispatch: false, shipmentDocument: false });
      expect(await handler.deliver(receiptEvent(busy))).toEqual({ kind: 'queued', queued: 3, deduped: 0 });
      expect(await mailRows(busy)).toHaveLength(502);
      expect(await handler.deliver(receiptEvent(busy))).toEqual({ kind: 'skipped', reason: 'over-cap' });
      expect(await handler.deliver(receiptEvent(busy))).toEqual({ kind: 'skipped', reason: 'over-cap' });
      expect(await mailRows(busy)).toHaveLength(502);
      expect((await emailLog(busy).expect(200)).body.capReachedToday).toEqual({ receipt: true, dispatch: false, shipmentDocument: false });
    });

    it('the IST day on the database clock: 23:59:59 IST yesterday does not count, 00:00:00 IST today does; any status counts', async () => {
      const edge = await createClient('EDGE', 'Edge Brand');
      const midnight = sql`(date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;
      await seedClientRows(edge, 'client-dispatch', 7, sql`${midnight} - interval '1 second'`);
      await seedClientRows(edge, 'client-dispatch', 2, midnight, 'cancelled');
      await seedClientRows(edge, 'client-receipt', 1, midnight, 'failed');
      const counts = await withTenantTransaction(db, tenantId, (tx: TenantTx) => clientEmailCountsTodayInTx(tx, tenantId, edge));
      expect(counts).toEqual({ 'client-dispatch': 2, 'client-receipt': 1, 'client-shipment-document': 0 });
    });

    it('AC: 500 ACME dispatch rows today → another ACME order dispatches, no row is written; the log answers capReachedToday.dispatch', async () => {
      await wipeMail(acme);
      // A subscriber of its own, so the refusal can only be the cap.
      const cap = (await addContact(acme, { name: 'Cap', email: 'cap@acme.example', emailEvents: ['order.dispatched'] }).expect(201)).body.contact.id as string;
      try {
        await seedClientRows(acme, 'client-dispatch', 500);
        const orderId = await dispatchOrder([{ skuId: sku.get('A-TEE')!, quantity: 1 }]);
        const spy = jest.spyOn(handler, 'deliver');
        await drain();
        expect(await spy.mock.results.find((r, i) => spy.mock.calls[i]![0].type === 'order.dispatched')!.value).toEqual({ kind: 'skipped', reason: 'over-cap' });
        spy.mockRestore();
        expect(await sql`select 1 from email_messages where tenant_id = ${tenantId} and dedupe_key like ${`client-dispatch:${orderId}:%`}`).toHaveLength(0);
        expect((await emailLog(acme).expect(200)).body.capReachedToday).toEqual({ receipt: false, dispatch: true, shipmentDocument: false });
      } finally {
        await removeContact(acme, cap).expect(200);
        await wipeMail(acme);
      }
    });
  });

  // ── the dispatch path ──────────────────────────────────────────────────────

  describe('dispatch emails end to end', () => {
    afterEach(() => wipeMail(acme));

    it('one subscribed contact: one client-dispatch row; the subject carries the ref, carrier and AWB; a kit lists its components only', async () => {
      const ref = `PO-${ulid().slice(18)}`;
      const orderId = await dispatchOrder(
        [{ skuId: sku.get('A-RICE')!, quantity: 12.5 }, { skuId: sku.get('A-KIT')!, quantity: 1 }],
        { carrierName: 'Delhivery', trackingNumber: 'DL-77' },
        { clientOrderRef: ref },
      );
      await drain();
      const rows = await mailRows(acme);
      expect(rows.map((r) => [r.template, r.to_email, r.dedupe_key])).toEqual([['client-dispatch', 'b@acme.example', `client-dispatch:${orderId}:b@acme.example`]]);
      const lines = (rows[0]!.params.lines as { skuCode: string }[]).map((line) => line.skuCode);
      expect(lines).toEqual(expect.arrayContaining(['A-RICE', 'A-C1', 'A-C2']));
      expect(lines).not.toContain('A-KIT');
      expect(JSON.stringify(rows[0]!.params)).not.toMatch(/consignee|codAmount|line1|pincode|phone/i);
      const before = captured.captured.length;
      await mail.sendDue(tenantId);
      const [sent] = captured.captured.slice(before).filter((email) => email.template === 'client-dispatch');
      expect(sent!.subject).toBe(`ACME Brand: order ${ref} dispatched — Delhivery DL-77`);
      expect(sent!.text).toContain('- A-RICE Acme rice: ordered 12.500 kg, dispatched 12.500 kg, short 0.000 kg');
    });

    it('A6: a transient fault on the enqueue, twice — one in-process retry, then logged and acked: the invoice handler ran once, the outbox row is gone, no rows', async () => {
      const invoiceSpy = jest.spyOn(app.get(InvoiceDeliveryHandler), 'deliver');
      const failing = jest.spyOn(handler, 'enqueueInTx').mockRejectedValue(Object.assign(new Error('serialization'), { code: '40001' }));
      try {
        const orderId = await dispatchOrder([{ skuId: sku.get('A-TEE')!, quantity: 1 }]);
        invoiceSpy.mockClear();
        await drain();
        expect(failing).toHaveBeenCalledTimes(2);
        expect(invoiceSpy).toHaveBeenCalledTimes(1);
        expect((await sql`select count(*)::int as n from outbox_messages where type = 'order.dispatched' and payload->'dispatch'->>'orderId' = ${orderId}`)[0]!.n).toBe(0);
        expect(await mailRows(acme)).toHaveLength(0);
      } finally {
        failing.mockRestore();
        invoiceSpy.mockRestore();
      }
    });

    it('A6: a transient fault once — the in-process retry queues the rows; a data fault is not retried', async () => {
      const once = jest.spyOn(handler, 'enqueueInTx').mockImplementationOnce(() => Promise.reject(Object.assign(new Error('deadlock'), { code: '40P01' })));
      try {
        expect(await handler.deliver(receiptEvent(acme))).toEqual({ kind: 'queued', queued: 2, deduped: 0 });
        expect(once).toHaveBeenCalledTimes(2);
      } finally {
        once.mockRestore();
      }
      const fault = jest.spyOn(handler, 'enqueueInTx').mockRejectedValue(Object.assign(new Error('check violated'), { code: '23514' }));
      try {
        expect(await handler.deliver(receiptEvent(acme))).toEqual({ kind: 'failed' });
        expect(fault).toHaveBeenCalledTimes(1);
      } finally {
        fault.mockRestore();
      }
    });
  });

  // ── cancels, the badge and the log ─────────────────────────────────────────

  describe('cancels, the contact badge and the log', () => {
    let client: string;
    let dee: string;
    let eve: string;

    beforeAll(async () => {
      client = await createClient('LOGCO', 'Log Brand');
      dee = (await addContact(client, { name: 'Dee', email: 'dee@log.example', emailEvents: ['receipt.recorded', 'order.dispatched'] }).expect(201)).body.contact.id as string;
      eve = (await addContact(client, { name: 'Eve', email: 'eve@log.example', emailEvents: ['receipt.recorded'] }).expect(201)).body.contact.id as string;
    });

    it('AC: a pending dispatch row to a contact who drops order.dispatched is cancelled `unsubscribed` and never sent; its receipt rows stay', async () => {
      await seedClientRows(client, 'client-dispatch', 1, sql`now()`, 'pending');
      await sql`update email_messages set to_email = 'dee@log.example' where tenant_id = ${tenantId} and client_id = ${client} and template = 'client-dispatch'`;
      await handler.deliver(receiptEvent(client));
      await editContact(client, dee, { emailEvents: ['receipt.recorded'] }).expect(200);
      const rows = await mailRows(client);
      expect(rows.filter((r) => r.template === 'client-dispatch').map((r) => [r.status, r.error_code])).toEqual([['cancelled', 'unsubscribed']]);
      expect(rows.filter((r) => r.template === 'client-receipt').map((r) => r.status)).toEqual(['pending', 'pending']);
      const before = captured.captured.length;
      await mail.sendDue(tenantId);
      expect(captured.captured.slice(before).filter((email) => email.template === 'client-dispatch' && email.to === 'dee@log.example')).toHaveLength(0);
    });

    it('a changed address cancels the old address’s queued mail; a removed contact’s queued mail is cancelled', async () => {
      await wipeMail(client);
      await handler.deliver(receiptEvent(client));
      await editContact(client, eve, { email: 'eve2@log.example' }).expect(200);
      await handler.deliver(receiptEvent(client));
      expect((await mailRows(client)).map((r) => [r.to_email, r.status, r.error_code])).toEqual([
        ['dee@log.example', 'pending', null],
        ['eve@log.example', 'cancelled', 'unsubscribed'],
        ['dee@log.example', 'pending', null],
        ['eve2@log.example', 'pending', null],
      ]);
      await removeContact(client, eve).expect(200);
      expect((await mailRows(client)).filter((r) => r.to_email === 'eve2@log.example').map((r) => r.status)).toEqual(['cancelled']);
      await mail.sendDue(tenantId);
    });

    it('a suppressed address: the row fails `suppressed`; the contact list’s lastEmail shows it (list-only, never on a write answer)', async () => {
      await wipeMail(client);
      await handler.deliver(receiptEvent(client));
      const gateway = new ScriptedGateway((email) => (email.to === 'dee@log.example' ? { ok: false, code: 'suppressed' } : { ok: true, providerMessageId: 'x' }));
      await new MailSender(db, gateway).sendDue(tenantId, 50);
      expect((await mailRows(client)).map((r) => [r.to_email, r.status, r.error_code])).toEqual([['dee@log.example', 'failed', 'suppressed']]);
      const list = await http().get(contacts(client)).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect((list.body.items as { email: string; lastEmail: unknown }[]).find((c) => c.email === 'dee@log.example')!.lastEmail).toMatchObject({ status: 'failed', errorCode: 'suppressed' });
      const edited = await editContact(client, dee, { name: 'Dee R' }).expect(200);
      expect(edited.body.contact).not.toHaveProperty('lastEmail');
    });

    it('the log: newest first, kind and subject label from the params, the problems filter, keyset paging; any staff session; 404 for an unknown client; a bad cursor is 400', async () => {
      await wipeMail(client);
      await sql`update email_messages set status = 'sent' where tenant_id = ${tenantId} and status = 'pending'`;
      const first = receiptEvent(client);
      await handler.deliver(first);
      await seedClientRows(client, 'client-dispatch', 2, sql`now()`, 'expired');
      await sql`update email_messages set params = '{"orderRef":"CO-9"}'::jsonb where tenant_id = ${tenantId} and client_id = ${client} and template = 'client-dispatch'`;
      // Every non-problem final state the filter must leave out, and the two other problems it must keep.
      const statuses: [string, string | null][] = [['failed', 'MessageRejected'], ['skipped', 'allowlist'], ['skipped', 'provider-off'], ['cancelled', 'unsubscribed'], ['sent', null]];
      for (const [status, code] of statuses) {
        await sql`
          insert into email_messages (id, tenant_id, template, to_email, params, status, error_code, next_attempt_at, client_id, dedupe_key, priority, created_at)
          values (${uuidv7()}, ${tenantId}, 'client-receipt', 'mix@log.example', '{"grnCode":"GRN-MIX"}'::jsonb, ${status}, ${code}, now(), ${client}, ${`mix:${status}:${code ?? 'none'}:${ulid()}`}, 1, now() - interval '1 day')
        `;
      }
      const all = (await emailLog(client).expect(200)).body as { items: { kind: string; subjectLabel: string; status: string; to: string }[]; nextCursor: string | null };
      expect(all.items).toHaveLength(8);
      expect(all.items.slice(0, 3).map((item) => item.kind)).toEqual(['dispatch', 'dispatch', 'receipt']);
      expect(all.items[2]).toMatchObject({ kind: 'receipt', subjectLabel: (first.payload as { goodsReceipt: { code: string } }).goodsReceipt.code, to: 'dee@log.example', status: 'pending' });
      expect(all.items[0]).toMatchObject({ subjectLabel: 'CO-9', status: 'expired' });
      const problems = (await emailLog(client, '?problems=true').expect(200)).body.items as { status: string; errorCode: string | null }[];
      expect(problems.map((item) => [item.status, item.errorCode])).toEqual([
        ['expired', null],
        ['expired', null],
        expect.anything(),
        expect.anything(),
      ]);
      expect(problems.slice(2).map((item) => `${item.status}:${item.errorCode}`).sort()).toEqual(['failed:MessageRejected', 'skipped:allowlist']);
      const page1 = (await emailLog(client, '?limit=5', ownerToken).expect(200)).body as { items: { id: string }[]; nextCursor: string };
      expect(page1.items).toHaveLength(5);
      const page2 = (await emailLog(client, `?limit=5&cursor=${encodeURIComponent(page1.nextCursor)}`).expect(200)).body as { items: { id: string }[]; nextCursor: string | null };
      expect(page2.items).toHaveLength(3);
      expect(page2.nextCursor).toBeNull();
      expect(new Set([...page1.items, ...page2.items].map((item) => item.id)).size).toBe(8);
      await emailLog(uuidv7()).expect(404);
      await emailLog(client, '?cursor=garbage').expect(400);
      // A cursor whose instant is not an ISO-8601 instant ("1" passes Date.parse) is 400, never a 500.
      const odd = Buffer.from(JSON.stringify({ createdAt: '1', id: uuidv7() }), 'utf8').toString('base64url');
      await emailLog(client, `?cursor=${odd}`).expect(400);
      await emailLog(client, '?problems=maybe').expect(400);
    });
  });

  describe('the log is staff-only; the deployment Reply-To', () => {
    it('a client-portal session is refused the log (403 role-denied)', async () => {
      const email = `portal-${ulid().toLowerCase()}@brand.example`;
      const invited = await http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ email, role: 'client', clientId: acme }).expect(201);
      await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: PASSWORD }).expect(200);
      const portalToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
      expect((await emailLog(acme, '', portalToken).expect(403)).body.code).toBe('role-denied');
    });

    it('a client with no Reply-To: the sender applies EMAIL_REPLY_TO, and the footer offers the reply', async () => {
      const plain = await createClient('PLAIN', 'Plain Brand');
      await addContact(plain, { name: 'Pat', email: 'pat@plain.example', emailEvents: ['receipt.recorded'] }).expect(201);
      await withEnv({ EMAIL_REPLY_TO: 'help@3pl.example.in' }, async () => {
        expect(await handler.deliver(receiptEvent(plain))).toEqual({ kind: 'queued', queued: 1, deduped: 0 });
        const before = captured.captured.length;
        await mail.sendDue(tenantId, 50);
        const [sent] = captured.captured.slice(before).filter((email) => email.to === 'pat@plain.example');
        expect(sent!.replyTo).toBe('help@3pl.example.in');
        expect(sent!.text).toContain('reply to this email or ask');
      });
    });
  });

  // ── the sender's claim order ───────────────────────────────────────────────

  describe('the claim order (A7, D7)', () => {
    it('AC: an invite queued after 20 pending client rows in one tenant is the one sent by sendDue(tenant, 1)', async () => {
      const t = await registerTenant(`Prio ${ulid()}`);
      const c = (await http().post(`${API}/${t.tenantId}/clients`).set('Authorization', `Bearer ${t.ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'PRIO', name: 'Prio' }).expect(201)).body.client.id as string;
      await sql`
        insert into email_messages (id, tenant_id, template, to_email, params, status, next_attempt_at, client_id, dedupe_key, priority, created_at)
        select gen_random_uuid(), ${t.tenantId}, 'client-dispatch', 'p@prio.example', '{"orderRef":"X"}'::jsonb, 'pending', now() - interval '1 minute', ${c}, 'k:' || g, 1, now() - interval '1 minute'
          from generate_series(1, 20) g
      `;
      const invited = `invitee-${ulid().toLowerCase()}@example.com`;
      await http().post(`${API}/${t.tenantId}/users`).set('Authorization', `Bearer ${t.ownerToken}`).set(KEY_HEADER, ulid()).send({ email: invited, role: 'operator' }).expect(201);
      const gateway = new ScriptedGateway(() => ({ ok: true, providerMessageId: 'x' }));
      expect(await new MailSender(db, gateway).sendDue(t.tenantId, 1)).toMatchObject({ claimed: 1, sent: 1 });
      expect(gateway.calls.map((email) => [email.template, email.to])).toEqual([['user-invite', invited]]);
      // sendDue(t, 0) still claims nothing (5-1a's pin) — the reserve is the worker's option only.
      expect(await new MailSender(db, gateway).sendDue(t.tenantId, 0)).toMatchObject({ claimed: 0 });
    });

    it('A7 AC: tenant A has 200 pending client rows and comes first in the walk, tenant B one invite — one tick at EMAIL_MAX_PER_TICK=10 sends B’s invite (the reserve)', async () => {
      const mailFacade = mail;
      // Drain what earlier tests left due, so only A and B have work.
      await withEnv({ EMAIL_MAX_PER_TICK: '1000' }, () => new EmailSenderWorker(app.get(AUTH_DATABASE) as never, mailFacade).tick());
      const a = await registerTenant(`Backlog ${ulid()}`);
      const b = await registerTenant(`Invite ${ulid()}`);
      const ac = (await http().post(`${API}/${a.tenantId}/clients`).set('Authorization', `Bearer ${a.ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'BACK', name: 'Back' }).expect(201)).body.client.id as string;
      await sql`
        insert into email_messages (id, tenant_id, template, to_email, params, status, next_attempt_at, client_id, dedupe_key, priority)
        select gen_random_uuid(), ${a.tenantId}, 'client-receipt', 'r' || g || '@back.example', ${sql.json(renderableReceipt)}, 'pending', now(), ${ac}, 'k:' || g, 1
          from generate_series(1, 200) g
      `;
      const invited = `b-${ulid().toLowerCase()}@example.com`;
      await http().post(`${API}/${b.tenantId}/users`).set('Authorization', `Bearer ${b.ownerToken}`).set(KEY_HEADER, ulid()).send({ email: invited, role: 'operator' }).expect(201);
      // A fresh worker starts its walk at the first tenant (A registered first: uuidv7 order).
      const worker = new EmailSenderWorker(app.get(AUTH_DATABASE) as never, mailFacade);
      const driven = await withEnv({ EMAIL_MAX_PER_TICK: '10' }, () => worker.tick());
      expect(driven.indexOf(a.tenantId)).toBeLessThan(driven.indexOf(b.tenantId));
      expect((await sql`select status from email_messages where tenant_id = ${b.tenantId}`).map((r) => r.status)).toEqual(['sent']);
      // A's client rows spent the whole shared budget (10 attempted), so B ran with a zero limit: only the reserve sent its invite.
      expect((await sql`select count(*)::int as n from email_messages where tenant_id = ${a.tenantId} and status = 'sent'`)[0]!.n).toBe(10);
    });

    it('EXPLAIN: the real claim query over 2,000 client rows uses email_messages_claim_idx; the badge read uses email_messages_client_address_idx', async () => {
      const t = await registerTenant(`Plan ${ulid()}`);
      const c = uuidv7();
      await sql`
        insert into email_messages (id, tenant_id, template, to_email, params, status, next_attempt_at, client_id, dedupe_key, priority)
        select gen_random_uuid(), ${t.tenantId}, 'client-dispatch', 'r' || (g % 40) || '@plan.example', '{}'::jsonb, 'pending', now() + interval '1 day', ${c}, 'k:' || g, 1
          from generate_series(1, 2000) g
      `;
      await sql`analyze email_messages`;
      const claim = dueClaimQuery(db as unknown as TenantTx, t.tenantId, 0, 10).toSQL();
      const claimPlan = (await sql.unsafe(`explain ${claim.sql}`, claim.params as never[])).map((row) => Object.values(row)[0]).join('\n');
      expect(claimPlan).toContain('email_messages_claim_idx');
      // The client claim over 2,000 DUE client rows (the backlog case).
      await sql`
        insert into email_messages (id, tenant_id, template, to_email, params, status, next_attempt_at, client_id, dedupe_key, priority)
        select gen_random_uuid(), ${t.tenantId}, 'client-dispatch', 'd' || (g % 40) || '@plan.example', '{}'::jsonb, 'pending', now() - interval '1 minute', ${c}, 'due:' || g, 1
          from generate_series(1, 2000) g
      `;
      await sql`analyze email_messages`;
      const due = dueClaimQuery(db as unknown as TenantTx, t.tenantId, 1, 10).toSQL();
      const duePlan = (await sql.unsafe(`explain ${due.sql}`, due.params as never[])).map((row) => Object.values(row)[0]).join('\n');
      expect(duePlan).toContain('email_messages_claim_idx');
      const badge = latestClientEmailsQuery(db as unknown as TenantTx, t.tenantId, c, ['r1@plan.example', 'r2@plan.example']).toSQL();
      const badgePlan = (await sql.unsafe(`explain ${badge.sql}`, badge.params as never[])).map((row) => Object.values(row)[0]).join('\n');
      expect(badgePlan).toContain('email_messages_client_address_idx');
    });
  });

  // ── the schema ─────────────────────────────────────────────────────────────

  describe('the schema and the contract', () => {
    it('the priority CHECK is IN (0, 1); the dedupe unique is partial; the template CHECK lists both client templates', async () => {
      const def = async (name: string) => (await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`)[0]!.def as string;
      expect(await def('email_messages_priority_check')).toMatch(/priority = ANY \(ARRAY\[0, 1\]\)/);
      expect(await def('email_messages_template_check')).toContain("'client-dispatch'");
      const unique = (await sql`select indexdef from pg_indexes where indexname = 'email_messages_dedupe_unique'`)[0]!.indexdef as string;
      expect(unique).toMatch(/UNIQUE INDEX .* \(tenant_id, dedupe_key\) WHERE \(dedupe_key IS NOT NULL\)/);
    });

    it('OpenAPI lists the two new routes', async () => {
      const doc = (await http().get('/api/v1/openapi.json').expect(200)).body as { paths: Record<string, Record<string, unknown>> };
      expect(Object.keys(doc.paths['/tenants/{tenantId}/clients/{clientId}/email-settings'] ?? {})).toEqual(['patch']);
      expect(Object.keys(doc.paths['/tenants/{tenantId}/clients/{clientId}/emails'] ?? {})).toEqual(['get']);
    });
  });
});
