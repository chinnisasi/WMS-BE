import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { Webhook } from 'standardwebhooks';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { Database } from '../src/shared/db/db';
import { EVENT_BUS } from '../src/shared/events/event-bus';
import type { DomainEvent } from '../src/shared/events/event-bus.seam';
import { OUTBOX_RELAY, OUTBOX_SINK, type OutboxRelay, type OutboxSink } from '../src/shared/events/outbox.seam';
import { OUTBOX_MAX_ATTEMPTS, OUTBOX_OPERATOR_REPLAY_SQL } from '../src/shared/events/outbox';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { InvoiceDeliveryHandler } from '../src/modules/invoicing/delivery';
import { ClientWebhooksFacade } from '../src/modules/client-webhooks/client-webhooks.facade';
import { WebhookSender, newWebhookTick } from '../src/modules/client-webhooks/webhook.sender';
import { WebhookEnqueue, WebhookEnqueueHandler } from '../src/modules/client-webhooks/webhook.enqueue';
import { deliverySubjectUuid } from '../src/modules/client-webhooks/webhook-payloads';
import type { WebhookTransport } from '../src/modules/client-webhooks/webhook-http';
import { resealTenantSecretsInTx } from '../src/modules/client-webhooks/webhook-reseal';
import { openSigningSecret } from '../src/modules/client-webhooks/webhook-secrets';
import {
  WEBHOOK_BODY_MAX_BYTES,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_DISABLED_EVENT,
  WEBHOOK_DELETED_EVENT,
  WEBHOOK_DISABLED_REASONS,
  WEBHOOK_ENABLED_EVENT,
  WEBHOOK_ENDPOINT_STATUSES,
  WEBHOOK_EPISODE_REASONS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MANUALLY_DISABLED_EVENT,
  WEBHOOK_RESOLUTIONS,
  WEBHOOK_RETRY_WAITS_MS,
  type WebhookSendOutcome,
} from '../src/modules/client-webhooks/webhook-rules';
import {
  NOTIFICATION_SOURCE_TYPES,
  SOURCE_RESOLUTIONS,
  WEBHOOK_AUTO_DISABLE_REASONS,
  WEBHOOK_ENDPOINT_DELETED_EVENT_TYPE,
  WEBHOOK_ENDPOINT_DISABLED_EVENT_TYPE,
  WEBHOOK_ENDPOINT_ENABLED_EVENT_TYPE,
  WEBHOOK_ENDPOINT_MANUALLY_DISABLED_EVENT_TYPE,
} from '../src/modules/notifications/notification-sources';
import { WebhookSenderWorker } from '../src/jobs/jobs.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { mintSignIn } from './support/sign-in';
import { testAddress } from './support/shipment-address';
import { dispatchedOrderFixtures, type Picklist } from './support/dispatched-order';
import { createLinkedVendor } from './support/linked-vendor';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.WEBHOOK_SEND_POLL_MS;
delete process.env.WEBHOOK_MAX_PER_TICK;
delete process.env.WEBHOOK_DENY_HOSTS;
delete process.env.WEBHOOK_DENY_CIDRS;
delete process.env.WEBHOOK_SEAL_KEY_PREVIOUS;
// Story 5-2a — this suite sends (through a fake transport assigned to the
// sender: nothing leaves the process).
process.env.WEBHOOK_GATEWAY = 'https';
process.env.WEBHOOK_SEAL_KEY = 'e2e-only-webhook-seal-key-0123456789abcdef';

jest.setTimeout(240_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

interface Call {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The suites' transport: records every POST and answers with `answer`. */
class FakeTransport implements WebhookTransport {
  calls: Call[] = [];
  answer: (call: Call) => Promise<WebhookSendOutcome> | WebhookSendOutcome = () => ok(204);
  async post(url: string, headers: Readonly<Record<string, string>>, body: string): Promise<WebhookSendOutcome> {
    const call = { url, headers, body };
    this.calls.push(call);
    return this.answer(call);
  }
}

const ok = (statusCode = 204): WebhookSendOutcome => ({ kind: 'response', statusCode, retryAfterMs: null, durationMs: 4 });

interface EndpointBody {
  id: string;
  clientId: string;
  url: string;
  eventTypes: string[];
  status: string;
  disabledReason: string | null;
  secretHint: string;
  consecutiveFailures: number;
  failingSince: string | null;
  previousSecretExpiresAt: string | null;
}

interface DeliveryRow {
  id: string;
  status: string;
  attempts: number;
  last_error_code: string | null;
  last_status_code: number | null;
  next_wait_s: number;
  pending_since: string;
  redelivery_count: number;
}

describe('client webhooks (e2e, story 5-2a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let db: Database;
  let relay: OutboxRelay;
  let facade: ClientWebhooksFacade;
  let sender: WebhookSender;
  let handler: WebhookEnqueueHandler;
  const transport = new FakeTransport();

  let tenantId: string;
  let ownerId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string;
  let warehouseId: string;
  let warehouseCode: string;
  let binId: string;
  let acme: string;
  let beta: string;
  let selfClient: string;
  const sku = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('clientwebhooks');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    db = app.get<Database>(DATABASE);
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    facade = app.get(ClientWebhooksFacade);
    sender = app.get(WebhookSender);
    sender.transport = transport;
    sender.random = () => 0;
    // Every call runs the slow sweep arms too (C10's throttle is per process).
    sender.slowSweepEveryMs = 0;
    handler = app.get(WebhookEnqueueHandler);

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Webhook 3PL ${ulid()}`, ownerEmail, password: PASSWORD }).expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerId = registered.body.owner.id as string;
    ownerToken = await signIn(ownerEmail);
    opsToken = (await createMember('ops_manager')).token;
    const floor = await createMember('operator');

    warehouseId = (
      await http().post(`${API}/${tenantId}/warehouses`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `WH-${ulid().slice(20)}`, name: 'Main' }).expect(201)
    ).body.id as string;
    warehouseCode = (await sql`select code from warehouses where id = ${warehouseId}`)[0]!.code as string;
    const zone = (
      await http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' }).expect(201)
    ).body.id as string;
    binId = (
      await http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone}/bins`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ capacity: 1000000, type: 'shelf', code: 'A-01-01' }).expect(201)
    ).body.id as string;

    acme = await createClient('ACME', 'Acme Apparel');
    beta = await createClient('BETA', 'Beta Beauty');
    selfClient = (await sql`select id from clients where tenant_id = ${tenantId} and system_owned`)[0]!.id as string;
    await importCsv(['A-TEE,Acme tee,pcs,1800,,,', 'A-RICE,Acme rice,kg,500,,,', 'A-KIT,Acme gift box,pcs,1800,,,', 'A-C1,Kit mug,pcs,1800,,,', 'A-C2,Kit card,pcs,1800,,,'], acme);
    await importCsv(['B-1,Beta serum,pcs,1800,,,'], beta);
    const listed = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of listed.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    await http().post(`${API}/${tenantId}/catalog/skus/${sku.get('A-KIT')}/kit`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: sku.get('A-C1'), quantity: 1 }, { skuId: sku.get('A-C2'), quantity: 2 }] }).expect(201);
    for (const code of ['A-TEE', 'A-RICE', 'A-C1', 'A-C2', 'B-1']) await adjust(sku.get(code)!, 1000);
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

    const minted = await http().post(`${API}/${tenantId}/devices/enrollment-codes`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(201);
    const enrolled = await http().post(`${API}/${tenantId}/devices/enroll`).set(KEY_HEADER, ulid()).send({ code: minted.body.code, label: 'Webhook scanner', pin: '2468' }).expect(201);
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

  beforeEach(() => {
    transport.calls = [];
    transport.answer = () => ok(204);
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
      .send({ warehouseId, skuId, binId, quantityDelta, reasonCode: 'stock-count', note: 'webhook seed' }).expect(201);
  }

  const base = (clientId: string) => `${API}/${tenantId}/clients/${clientId}/webhook-endpoints`;

  function create(clientId: string, body: Record<string, unknown>, key = ulid(), token = ownerToken) {
    return http().post(base(clientId)).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  async function endpoint(clientId: string, url: string, eventTypes: string[] = ['order.dispatched', 'receipt.recorded']): Promise<{ endpoint: EndpointBody; secret: string }> {
    const res = await create(clientId, { url, eventTypes }).expect(201);
    return { endpoint: res.body.endpoint as EndpointBody, secret: res.body.signingSecret as string };
  }

  function patch(clientId: string, endpointId: string, body: Record<string, unknown>, key = ulid()) {
    return http().patch(`${base(clientId)}/${endpointId}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key).send(body);
  }

  function post(path: string, body: Record<string, unknown> = {}, key = ulid()) {
    return http().post(path).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key).send(body);
  }

  async function deliveriesOf(endpointId: string): Promise<DeliveryRow[]> {
    return (await sql`
      select id, status, attempts, last_error_code, last_status_code, redelivery_count, pending_since::text as pending_since,
             round(extract(epoch from (next_attempt_at - now())))::int as next_wait_s
        from webhook_deliveries where tenant_id = ${tenantId} and endpoint_id = ${endpointId} order by created_at, id
    `) as unknown as DeliveryRow[];
  }

  async function endpointRow(endpointId: string): Promise<Record<string, unknown>> {
    return (await sql`select * from webhook_endpoints where id = ${endpointId}`)[0]!;
  }

  // The append stamps `next_attempt_at` with the APP clock and the relay compares
  // with the DATABASE clock: a few ms of skew would leave a fresh row not yet due.
  const drain = async () => {
    await sql`update outbox_messages set next_attempt_at = now() where tenant_id = ${tenantId} and status = 'pending' and next_attempt_at > now()`;
    return relay.drain(500);
  };
  const send = () => facade.sendDueWebhooksNow(tenantId);

  /** Seeds one event + one delivery straight into the tables (a sender-only case). */
  async function seedDelivery(endpointId: string, clientId: string, opts: { status?: string; eventType?: string; createdAgo?: string } = {}): Promise<{ eventId: string; deliveryId: string }> {
    const eventId = uuidv7();
    const deliveryId = uuidv7();
    const body = JSON.stringify({ id: eventId, type: opts.eventType ?? 'order.dispatched', schemaVersion: 1, data: { seeded: true } });
    await sql`insert into webhook_events (id, tenant_id, client_id, event_type, subject_id, body, created_at, updated_at)
      values (${eventId}, ${tenantId}, ${clientId}, ${opts.eventType ?? 'order.dispatched'}, ${uuidv7()}, ${body}, now() - ${opts.createdAgo ?? '0 s'}::interval, now())`;
    await sql`insert into webhook_deliveries (id, tenant_id, client_id, event_id, endpoint_id, status, next_attempt_at, pending_since, created_at, updated_at)
      values (${deliveryId}, ${tenantId}, ${clientId}, ${eventId}, ${endpointId}, ${opts.status ?? 'pending'}, now(), now(), now() - ${opts.createdAgo ?? '0 s'}::interval, now())`;
    return { eventId, deliveryId };
  }

  function scannedOf(picklist: Picklist): { skuId: string; qty: number }[] {
    const by = new Map<string, number>();
    for (const line of picklist.lines) by.set(line.skuId, (by.get(line.skuId) ?? 0) + line.qty);
    return [...by.entries()].map(([skuId, qty]) => ({ skuId, qty }));
  }

  async function dispatchOrder(lines: { skuId: string; quantity: number }[], dispatchBody: Record<string, unknown> = {}): Promise<string> {
    const ready = await fixtures.releasedWave(lines, { clientOrderRef: `CO-${ulid().slice(18)}` });
    await fixtures.pickAllLines(ready.picklist);
    await fixtures.packAndDispatch(ready.orderId, scannedOf(ready.picklist), dispatchBody);
    return ready.orderId;
  }

  async function eventsOf(subjectId: string): Promise<{ id: string; event_type: string; body: string; client_id: string }[]> {
    return (await sql`select id, event_type, body, client_id from webhook_events where tenant_id = ${tenantId} and subject_id = ${subjectId}`) as unknown as {
      id: string;
      event_type: string;
      body: string;
      client_id: string;
    }[];
  }

  async function wipeEndpoints(clientId: string): Promise<void> {
    // Test isolation: this suite's own rows only (no audit or key rows are touched).
    await sql`delete from webhook_deliveries where tenant_id = ${tenantId} and client_id = ${clientId}`;
    await sql`delete from webhook_events where tenant_id = ${tenantId} and client_id = ${clientId}`;
    await sql`delete from webhook_endpoints where tenant_id = ${tenantId} and client_id = ${clientId}`;
  }

  // ── the vocabularies ───────────────────────────────────────────────────────

  describe('vocabularies (§4: TS tuple ↔ CHECK ↔ API)', () => {
    async function quoted(constraint: string): Promise<string[]> {
      const rows = (await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${constraint}`) as unknown as { def: string }[];
      expect(rows).toHaveLength(1);
      return [...new Set([...rows[0]!.def.matchAll(/'([^']+)'/g)].map((m) => m[1]!))].sort();
    }

    it('the endpoint, delivery and event CHECKs carry exactly the TS tuples', async () => {
      expect(await quoted('webhook_endpoints_status_check')).toEqual([...WEBHOOK_ENDPOINT_STATUSES].sort());
      expect((await quoted('webhook_endpoints_disabled_shape_check')).filter((v) => v !== 'disabled')).toEqual([...WEBHOOK_DISABLED_REASONS].sort());
      expect(await quoted('webhook_endpoints_event_types_check')).toEqual([...WEBHOOK_EVENT_TYPES].sort());
      expect(await quoted('webhook_deliveries_status_check')).toEqual([...WEBHOOK_DELIVERY_STATUSES].sort());
      expect(await quoted('webhook_events_type_check')).toEqual([...WEBHOOK_EVENT_TYPES].sort());
      const body = (await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'webhook_events_body_check'`)[0]!.def as string;
      expect(body).toContain(String(WEBHOOK_BODY_MAX_BYTES));
    });

    it('the notifications source vocabulary gains webhook-disabled, NOT VALID (A9)', async () => {
      expect(await quoted('notifications_source_type_check')).toEqual([...NOTIFICATION_SOURCE_TYPES].sort());
      const validated = (await sql`select convalidated from pg_constraint where conname = 'notifications_source_type_check'`)[0]!.convalidated;
      expect(validated).toBe(false);
    });

    it('the notifications source repeats the emitter’s literals exactly (AD-6 pins)', () => {
      expect([...SOURCE_RESOLUTIONS['webhook-disabled']].sort()).toEqual([...WEBHOOK_RESOLUTIONS].sort());
      expect([...WEBHOOK_AUTO_DISABLE_REASONS]).toEqual([...WEBHOOK_EPISODE_REASONS]);
      expect(WEBHOOK_ENDPOINT_DISABLED_EVENT_TYPE).toBe(WEBHOOK_DISABLED_EVENT);
      expect(WEBHOOK_ENDPOINT_ENABLED_EVENT_TYPE).toBe(WEBHOOK_ENABLED_EVENT);
      expect(WEBHOOK_ENDPOINT_DELETED_EVENT_TYPE).toBe(WEBHOOK_DELETED_EVENT);
      expect(WEBHOOK_ENDPOINT_MANUALLY_DISABLED_EVENT_TYPE).toBe(WEBHOOK_MANUALLY_DISABLED_EVENT);
    });

    it('OpenAPI lists every route', async () => {
      const doc = (await http().get('/api/v1/openapi.json').expect(200)).body as { paths: Record<string, Record<string, unknown>> };
      const prefix = '/tenants/{tenantId}/clients/{clientId}/webhook-endpoints';
      expect(Object.keys(doc.paths[prefix]!).sort()).toEqual(['get', 'post']);
      expect(Object.keys(doc.paths[`${prefix}/{endpointId}`]!).sort()).toEqual(['delete', 'patch']);
      for (const path of ['/rotate-secret', '/test', '/deliveries/redeliver', '/deliveries/{deliveryId}/redeliver']) {
        expect(Object.keys(doc.paths[`${prefix}/{endpointId}${path}`]!)).toEqual(['post']);
      }
      for (const path of ['/deliveries', '/deliveries/{deliveryId}']) expect(Object.keys(doc.paths[`${prefix}/{endpointId}${path}`]!)).toEqual(['get']);
    });
  });

  // ── create and the secret ──────────────────────────────────────────────────

  describe('create (decision 14) and the one-time secret (decision 10)', () => {
    afterAll(() => wipeEndpoints(acme));

    it('201 with the secret once; the replay answers null; no secret in a key, an audit row or the outbox; audited', async () => {
      const key = ulid();
      const res = await create(acme, { url: 'https://HOOKS.acme.example:443/wms?token=abc', eventTypes: ['order.dispatched'], description: '  ERP  ' }, key).expect(201);
      const secret = res.body.signingSecret as string;
      expect(secret).toMatch(/^whsec_/);
      expect(res.body.endpoint).toMatchObject({ url: 'https://hooks.acme.example/wms?token=abc', eventTypes: ['order.dispatched'], status: 'active', secretHint: secret.slice(-5, -1), description: 'ERP' });
      expect(res.body.warnings).toEqual([]);
      const replay = await create(acme, { url: 'https://HOOKS.acme.example:443/wms?token=abc', eventTypes: ['order.dispatched'], description: '  ERP  ' }, key).expect(201);
      expect(replay.body.signingSecret).toBeNull();
      expect(replay.body.endpoint.id).toBe(res.body.endpoint.id);
      const raw = secret.slice('whsec_'.length);
      const like = `%${raw}%`;
      const hits = (await sql`
        select (select count(*) from idempotency_keys k where k::text like ${like})::int as keys,
               (select count(*) from audit_events a where a::text like ${like})::int as audit,
               (select count(*) from outbox_messages o where o::text like ${like})::int as outbox,
               (select count(*) from webhook_endpoints w where w::text like ${like})::int as stored
      `)[0]!;
      expect(hits).toEqual({ keys: 0, audit: 0, outbox: 0, stored: 0 });
      await expectAuditRow({ tenantId, key, action: 'webhook_endpoint.created', targetType: 'webhook_endpoint', targetId: res.body.endpoint.id, actorUserId: ownerId });
      const audit = (await sql`select changes from audit_events where reference = ${key}`)[0]!.changes as { url: string };
      expect(audit.url).toBe('https://hooks.acme.example/wms?…');
      const listed = await http().get(base(acme)).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(JSON.stringify(listed.body)).not.toContain(raw);
      expect(listed.body.items[0]).toMatchObject({ id: res.body.endpoint.id, secretHint: secret.slice(-5, -1), heldCount: 0 });
    });

    it.each([
      ['http://hooks.acme.example/', 'scheme'],
      ['https://10.0.0.5/', 'host'],
      ['https://localhost/', 'host'],
      ['https://u:p@x.acme.example/', 'userinfo'],
      ['https://2130706433/', 'host'],
      ['https://0x7f.1/', 'host'],
      ['https://localhost./', 'host'],
    ])('400 validation-failed for %s, naming the %s rule', async (url, rule) => {
      const res = await create(acme, { url, eventTypes: ['order.dispatched'] }).expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(res.body.detail).toContain(`rule: ${rule}`);
    });

    it('400 for an unknown or repeated event type; 400 on the self client; 403 for a non-owner; 404 for an unknown client', async () => {
      expect((await create(acme, { url: 'https://a.acme.example/', eventTypes: ['webhook.test'] }).expect(400)).body.code).toBe('validation-failed');
      expect((await create(acme, { url: 'https://a.acme.example/', eventTypes: ['order.dispatched', 'order.dispatched'] }).expect(400)).body.code).toBe('validation-failed');
      expect((await create(acme, { url: 'https://a.acme.example/', eventTypes: [] }).expect(400)).body.code).toBe('validation-failed');
      const self = await create(selfClient, { url: 'https://a.acme.example/', eventTypes: ['order.dispatched'] }).expect(400);
      expect(self.body.detail).toBe("The warehouse's own client cannot have webhooks.");
      expect((await create(acme, { url: 'https://a.acme.example/', eventTypes: ['order.dispatched'] }, ulid(), opsToken).expect(403)).body.code).toBe('role-denied');
      expect((await http().get(base(acme)).set('Authorization', `Bearer ${opsToken}`).expect(403)).body.code).toBe('role-denied');
      expect((await create(uuidv7(), { url: 'https://a.acme.example/', eventTypes: ['order.dispatched'] }).expect(404)).body.code).toBe('not-found');
    });

    it('409 duplicate-webhook-url per client; another client may use it; the 6th is 409 webhook-endpoint-limit; a deleted one frees its slot', async () => {
      expect((await create(acme, { url: 'https://hooks.acme.example/wms?token=abc', eventTypes: ['receipt.recorded'] }).expect(409)).body.code).toBe('duplicate-webhook-url');
      const betaOne = await endpoint(beta, 'https://hooks.acme.example/wms?token=abc');
      for (let i = 2; i <= 5; i += 1) await endpoint(acme, `https://n${i}.acme.example/`);
      expect((await create(acme, { url: 'https://n6.acme.example/', eventTypes: ['order.dispatched'] }).expect(409)).body.code).toBe('webhook-endpoint-limit');
      const victim = (await http().get(base(acme)).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.items[1] as EndpointBody;
      await http().delete(`${base(acme)}/${victim.id}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(200);
      await create(acme, { url: victim.url, eventTypes: ['order.dispatched'] }).expect(201);
      expect(betaOne.endpoint.url).toBe('https://hooks.acme.example/wms?token=abc');
      await wipeEndpoints(beta);
    });

    it('another client’s endpoint id is the same 404 as an unknown one', async () => {
      const betaEndpoint = await endpoint(beta, 'https://beta.example.org/');
      for (const id of [betaEndpoint.endpoint.id, uuidv7()]) {
        expect((await patch(acme, id, { description: 'x' }).expect(404)).body.code).toBe('not-found');
        expect((await http().get(`${base(acme)}/${id}/deliveries`).set('Authorization', `Bearer ${ownerToken}`).expect(404)).body.code).toBe('not-found');
      }
      await wipeEndpoints(beta);
    });

    it('a same-key create parked on the client lock replays under the lock: both 201, one endpoint, one key', async () => {
      await wipeEndpoints(beta);
      const key = ulid();
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from clients where id = ${beta} for update`) as unknown as { pid: number }[];
          first = (async () => create(beta, { url: 'https://race.beta.example/', eventTypes: ['order.dispatched'] }, key))();
          second = (async () => create(beta, { url: 'https://race.beta.example/', eventTypes: ['order.dispatched'] }, key))();
          await waitParked(locked[0]!.pid, 2);
        });
        const [a, b] = await Promise.all([first!, second!]);
        expect([a.status, b.status]).toEqual([201, 201]);
        expect(a.body.endpoint.id).toBe(b.body.endpoint.id);
        // Exactly one of them is the fresh create carrying the secret.
        expect([a.body.signingSecret, b.body.signingSecret].filter((s) => s !== null)).toHaveLength(1);
        expect((await sql`select count(*)::int as n from webhook_endpoints where client_id = ${beta}`)[0]!.n).toBe(1);
        expect((await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.n).toBe(1);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
        await wipeEndpoints(beta);
      }
    });
  });

  async function waitParked(holderPid: number, min: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const waiting = (await sql`
        select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
         where a.wait_event_type = 'Lock' and a.state = 'active' and a.query ilike '%"clients"%'
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
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${min} request(s) parked on the client row`);
  }

  // ── the dispatch path end to end ───────────────────────────────────────────

  describe('order.dispatched end to end (AC 1)', () => {
    afterAll(() => wipeEndpoints(acme));

    it('one event, one delivery, one signed POST that standardwebhooks verifies; a fractional kg line reads "12.500"', async () => {
      await wipeEndpoints(acme);
      const { endpoint: e, secret } = await endpoint(acme, 'https://hooks.acme.example/dispatch', ['order.dispatched']);
      const orderId = await dispatchOrder([{ skuId: sku.get('A-RICE')!, quantity: 12.5 }, { skuId: sku.get('A-TEE')!, quantity: 2 }], { carrierName: 'Delhivery', trackingNumber: 'DL-77' });
      await drain();
      const events = await eventsOf(orderId);
      expect(events).toHaveLength(1);
      expect(events[0]!.client_id).toBe(acme);
      expect(await deliveriesOf(e.id)).toHaveLength(1);

      const summary = await send();
      expect(summary).toMatchObject({ claimed: 1, attempted: 1, succeeded: 1 });
      expect(transport.calls).toHaveLength(1);
      const call = transport.calls[0]!;
      expect(call.url).toBe('https://hooks.acme.example/dispatch');
      expect(call.headers['webhook-id']).toBe(events[0]!.id);
      expect(call.body).toBe(events[0]!.body);
      expect(new Webhook(secret).verify(call.body, call.headers as Record<string, string>)).toBeTruthy();
      const body = JSON.parse(call.body) as { type: string; schemaVersion: number; client: { code: string }; data: Record<string, unknown> & { lines: Record<string, string>[] } };
      expect(body).toMatchObject({ type: 'order.dispatched', schemaVersion: 1, client: { code: 'ACME' } });
      expect(body.data).toMatchObject({ orderId, warehouseCode, carrierName: 'Delhivery', trackingNumber: 'DL-77', channelOrderRef: null, totalUnits: '14.500' });
      expect(body.data.lines).toEqual([
        { skuCode: 'A-RICE', skuName: 'Acme rice', uom: 'kg', orderedQty: '12.500', dispatchedQty: '12.500', shortfallQty: '0.000' },
        { skuCode: 'A-TEE', skuName: 'Acme tee', uom: 'each', orderedQty: '2', dispatchedQty: '2', shortfallQty: '0' },
      ]);
      for (const leak of ['consignee', 'codAmountPaise', 'dispatchedBy', 'ledgerEventId', 'skuId']) expect(call.body).not.toContain(leak);
      const [delivery] = await deliveriesOf(e.id);
      expect(delivery).toMatchObject({ status: 'succeeded', attempts: 1, last_status_code: 204, last_error_code: null });
      expect((await endpointRow(e.id)).last_success_at).not.toBeNull();

      expect(await eventsOf(orderId)).toHaveLength(1);
      expect((await send()).attempted).toBe(0);
    });

    it('a relay redelivery of the same subject is one event (subject unique)', async () => {
      const { endpoint: e } = await endpoint(acme, 'https://again.acme.example/', ['order.dispatched']);
      const orderId = await dispatchOrder([{ skuId: sku.get('A-TEE')!, quantity: 1 }]);
      const outbox = (await sql`select id, payload, occurred_at::text as at from outbox_messages where tenant_id = ${tenantId} and type = 'order.dispatched' and payload->'dispatch'->>'orderId' = ${orderId}`)[0]!;
      const event: DomainEvent = { eventId: outbox.id as string, type: 'order.dispatched', tenantId, occurredAt: new Date(outbox.at as string).toISOString(), payload: outbox.payload };
      expect(await handler.deliver(event)).toMatchObject({ kind: 'enqueued' });
      expect(await handler.deliver(event)).toEqual({ kind: 'duplicate' });
      await drain();
      expect(await eventsOf(orderId)).toHaveLength(1);
      expect(await deliveriesOf(e.id)).toHaveLength(1);
    });

    it('a kit order lists its components only (A6)', async () => {
      const orderId = await dispatchOrder([{ skuId: sku.get('A-KIT')!, quantity: 2 }]);
      await drain();
      const [event] = await eventsOf(orderId);
      const lines = (JSON.parse(event!.body) as { data: { lines: { skuCode: string; dispatchedQty: string }[] } }).data.lines;
      expect(lines.map((line) => line.skuCode).sort()).toEqual(['A-C1', 'A-C2']);
      expect(lines.find((line) => line.skuCode === 'A-C2')!.dispatchedQty).toBe('4');
    });

    it('another client’s dispatch makes no event for this client; a client without an endpoint makes none at all', async () => {
      const orderId = await dispatchOrder([{ skuId: sku.get('B-1')!, quantity: 1 }]);
      await drain();
      expect(await eventsOf(orderId)).toHaveLength(0);
    });
  });

  // ── story 4-9a: order.delivered ────────────────────────────────────────────

  describe('order.delivered end to end (story 4-9a, A28, A67)', () => {
    afterAll(() => wipeEndpoints(acme));

    function deliveredPayload(orderId: string, consignmentId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        consignmentId,
        orderId,
        clientId: acme,
        warehouseId,
        deliverySeq: 1,
        outcome: 'delivered',
        deliveredAt: '2026-11-02T05:50:00.000Z',
        receiverName: 'A. Kumar',
        shortPackageCount: null,
        damagedPackageCount: null,
        note: null,
        lrNumber: '4410',
        transporterName: 'VRL Logistics',
        vehicleNumber: 'KA01AB1234',
        dispatchedAt: '2026-10-30T10:35:00.000Z',
        consignmentRef: 'LD-0007/03',
        amended: false,
        recordedAt: '2026-11-02T06:00:00.000Z',
        ...extra,
      };
    }

    async function appendDelivered(payload: Record<string, unknown>): Promise<void> {
      const outbox = app.get<OutboxSink>(OUTBOX_SINK);
      await withTenantTransaction(db, tenantId, (tx) =>
        outbox.append(tx, { messageId: uuidv7(), tenantId, type: 'freight_consignment.delivered', occurredAt: new Date().toISOString(), payload }),
      );
    }

    it('a freight_consignment.delivered outbox row → one order.delivered event for the payload’s client, subject per version, signed and sent; an amendment is a second event', async () => {
      await wipeEndpoints(acme);
      const { endpoint: e } = await endpoint(acme, 'https://hooks.acme.example/delivered', ['order.delivered']);
      const orderId = await dispatchOrder([{ skuId: sku.get('A-TEE')!, quantity: 1 }]);
      await drain();
      // The endpoint is not subscribed to order.dispatched: the dispatch made no event.
      expect(await eventsOf(orderId)).toHaveLength(0);
      const consignmentId = uuidv7();
      await appendDelivered(deliveredPayload(orderId, consignmentId));
      await drain();
      const [first] = await eventsOf(deliverySubjectUuid(consignmentId, 1));
      expect(first).toMatchObject({ event_type: 'order.delivered', client_id: acme });
      const body = JSON.parse(first!.body) as { type: string; client: { code: string }; data: Record<string, unknown> };
      expect(body).toMatchObject({ type: 'order.delivered', client: { code: 'ACME' } });
      expect(body.data).toEqual({
        orderId,
        clientOrderRef: expect.stringMatching(/^CO-/),
        channelOrderRef: null,
        warehouseCode,
        consignmentRef: 'LD-0007/03',
        dispatchedAt: '2026-10-30T10:35:00.000Z',
        deliveredAt: '2026-11-02T05:50:00.000Z',
        outcome: 'delivered',
        transporterName: 'VRL Logistics',
        lrNumber: '4410',
        vehicleNumber: 'KA01AB1234',
        receiverName: 'A. Kumar',
        shortPackages: 0,
        damagedPackages: 0,
        note: null,
        amended: false,
        deliverySeq: 1,
        recordedAt: '2026-11-02T06:00:00.000Z',
      });
      expect(first!.body).not.toContain('"lines"');
      expect(await deliveriesOf(e.id)).toHaveLength(1);
      expect(await send()).toMatchObject({ attempted: 1, succeeded: 1 });

      // An amendment: a new version, a new event; a redelivery of a version is one event.
      await appendDelivered(deliveredPayload(orderId, consignmentId, { deliverySeq: 2, amended: true, outcome: 'refused', note: 'wrong item' }));
      await appendDelivered(deliveredPayload(orderId, consignmentId, { deliverySeq: 2, amended: true, outcome: 'refused', note: 'wrong item' }));
      await drain();
      const [second] = await eventsOf(deliverySubjectUuid(consignmentId, 2));
      expect(JSON.parse(second!.body).data).toMatchObject({ outcome: 'refused', amended: true, deliverySeq: 2, note: 'wrong item' });
      expect(await eventsOf(deliverySubjectUuid(consignmentId, 2))).toHaveLength(1);
      expect(await deliveriesOf(e.id)).toHaveLength(2);
    });

    it('the client is the payload’s (never looked up through the order); a client without an endpoint gets none; a malformed payload is acked', async () => {
      const consignmentId = uuidv7();
      const outcome = await handler.deliver({
        eventId: uuidv7(),
        type: 'freight_consignment.delivered',
        tenantId,
        occurredAt: new Date().toISOString(),
        payload: deliveredPayload(uuidv7(), consignmentId, { clientId: beta }),
      });
      expect(outcome).toEqual({ kind: 'skipped', reason: 'no-endpoint' });
      expect(
        await handler.deliver({ eventId: uuidv7(), type: 'freight_consignment.delivered', tenantId, occurredAt: new Date().toISOString(), payload: { consignmentId: 'x' } }),
      ).toEqual({ kind: 'malformed' });
    });
  });

  // ── the receipt path ───────────────────────────────────────────────────────

  describe('receipt.recorded end to end', () => {
    afterAll(() => wipeEndpoints(acme));

    it('a PO receipt: one event naming the GRN, the PO by code and the warehouse by code', async () => {
      await wipeEndpoints(acme);
      const { endpoint: e } = await endpoint(acme, 'https://hooks.acme.example/receipts', ['receipt.recorded']);
      const vendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: `V-${ulid().slice(20)}`, name: 'Acme mill', clientIds: [acme] });
      const poCode = `PO-${ulid().slice(16)}`;
      const po = await http().post(`${API}/${tenantId}/inbound/purchase-orders`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid())
        .send({ warehouseId, vendorId, code: poCode, lines: [{ skuId: sku.get('A-RICE'), orderedQty: 20, unitCostPaise: 100 }] }).expect(201);
      const grn = await http().post(`${API}/${tenantId}/receiving/goods-receipts`).set('Authorization', `Bearer ${operatorToken}`).set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          poId: po.body.purchaseOrder.id,
          occurredAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
          lines: [{ poLineId: po.body.purchaseOrder.lines[0].id, skuId: sku.get('A-RICE'), batchCode: null, mfgDate: null, qty: 7.25 }],
        })
        .expect(201);
      const grnId = grn.body.goodsReceipt.id as string;
      await drain();
      const [event] = await eventsOf(grnId);
      expect(event!.event_type).toBe('receipt.recorded');
      const body = JSON.parse(event!.body) as { data: Record<string, unknown> };
      expect(body.data).toEqual({
        receiptId: grnId,
        grnCode: grn.body.goodsReceipt.code,
        warehouseCode,
        purchaseOrderCode: poCode,
        asnCode: null,
        recordedAt: grn.body.goodsReceipt.recordedAt,
        lines: [{ skuCode: 'A-RICE', skuName: 'Acme rice', uom: 'kg', batchCode: null, qty: '7.250', appliedQty: '7.250', excessQty: '0.000', qcHeld: false }],
      });
      expect(await deliveriesOf(e.id)).toHaveLength(1);
    });

    it('QC on receipt: a held line reads `qcHeld: true` (VG3)', async () => {
      await http().put(`${API}/${tenantId}/clients/${acme}/receiving-policy`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
        .send({ receivingToleranceBps: 0, qcOnReceipt: true, expiryRequired: false, minShelfLifeDays: null }).expect(200);
      try {
        const grn = await http().post(`${API}/${tenantId}/receiving/goods-receipts`).set('Authorization', `Bearer ${operatorToken}`).set(KEY_HEADER, ulid())
          .send({
            warehouseId,
            poId: null,
            blindReasonCode: 'unannounced-delivery',
            occurredAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
            lines: [{ poLineId: null, skuId: sku.get('A-TEE'), batchCode: null, mfgDate: null, qty: 3 }],
          })
          .expect(201);
        await drain();
        const [event] = await eventsOf(grn.body.goodsReceipt.id as string);
        const lines = (JSON.parse(event!.body) as { data: { lines: { skuCode: string; qcHeld: boolean }[] } }).data.lines;
        expect(lines).toEqual([expect.objectContaining({ skuCode: 'A-TEE', qty: '3', qcHeld: true })]);
      } finally {
        await http().put(`${API}/${tenantId}/clients/${acme}/receiving-policy`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid())
          .send({ receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: false, minShelfLifeDays: null }).expect(200);
      }
    });

    it('a receipt with no client (an older build’s mixed-client blind receipt) makes no webhook and is acked', async () => {
      const event: DomainEvent = {
        eventId: uuidv7(),
        type: 'grn.recorded',
        tenantId,
        occurredAt: new Date().toISOString(),
        payload: { goodsReceipt: { id: uuidv7(), code: 'GRN-OLD', warehouseId, recordedAt: new Date().toISOString(), lines: [] } },
      };
      expect(await handler.deliver(event)).toEqual({ kind: 'skipped', reason: 'no-client' });
      expect(await handler.deliver({ ...event, payload: { nonsense: true } })).toEqual({ kind: 'malformed' });
    });
  });

  // ── handler order and the rethrow rule ────────────────────────────────────

  describe('the bus handler order (decision 7, A25) and A11', () => {
    afterAll(() => wipeEndpoints(acme));

    it('the webhook enqueue is the LAST handler on both source types', async () => {
      // A private field, read through a cast (A25): the bus's handler list per type.
      const handlers = (app.get(EVENT_BUS) as unknown as { handlers: Map<string, ((event: DomainEvent) => Promise<void>)[]> }).handlers;
      for (const type of ['order.dispatched', 'grn.recorded']) {
        const list = handlers.get(type)!;
        expect(list.length).toBeGreaterThanOrEqual(type === 'order.dispatched' ? 3 : 1);
        const spy = jest.spyOn(handler, 'deliver').mockResolvedValue(null);
        await list[list.length - 1]!({ eventId: uuidv7(), type, tenantId, occurredAt: new Date().toISOString(), payload: {} });
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockClear();
        // No earlier handler is ours.
        const earlier = list.slice(0, -1);
        for (const fn of earlier) {
          await fn({ eventId: uuidv7(), type: `${type}`, tenantId, occurredAt: new Date().toISOString(), payload: {} }).catch(() => undefined);
        }
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      }
    });

    it('a transient enqueue fault re-drains the row; invoicing ran first on each attempt; the webhook lands once on the retry', async () => {
      await endpoint(acme, 'https://transient.acme.example/', ['order.dispatched']);
      const invoicing = app.get(InvoiceDeliveryHandler);
      const invoiceSpy = jest.spyOn(invoicing, 'deliver');
      const enqueue = app.get(WebhookEnqueue);
      const failing = jest.spyOn(enqueue, 'enqueueFromSourceInTx').mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }));
      const orderId = await dispatchOrder([{ skuId: sku.get('A-TEE')!, quantity: 1 }]);
      await drain();
      const row = (await sql`select id, attempts, status from outbox_messages where type = 'order.dispatched' and payload->'dispatch'->>'orderId' = ${orderId}`)[0]!;
      expect(row).toMatchObject({ attempts: 1, status: 'pending' });
      expect(invoiceSpy).toHaveBeenCalledTimes(1);
      expect(await eventsOf(orderId)).toHaveLength(0);
      await sql`update outbox_messages set next_attempt_at = now() where id = ${row.id as string}`;
      await drain();
      expect(invoiceSpy).toHaveBeenCalledTimes(2);
      expect(failing).toHaveBeenCalledTimes(2);
      expect(await eventsOf(orderId)).toHaveLength(1);
      expect((await sql`select count(*)::int as n from outbox_messages where id = ${row.id as string}`)[0]!.n).toBe(0);
    });

    it('a data fault in the enqueue is logged and acked (no retry)', async () => {
      const enqueue = app.get(WebhookEnqueue);
      jest.spyOn(enqueue, 'enqueueFromSourceInTx').mockRejectedValueOnce(Object.assign(new Error('check violated'), { code: '23514' }));
      const orderId = await dispatchOrder([{ skuId: sku.get('A-TEE')!, quantity: 1 }]);
      await drain();
      expect((await sql`select count(*)::int as n from outbox_messages where type = 'order.dispatched' and payload->'dispatch'->>'orderId' = ${orderId}`)[0]!.n).toBe(0);
      expect(await eventsOf(orderId)).toHaveLength(0);
    });
  });

  // ── the quarantine reconcile (A1) ─────────────────────────────────────────

  it('quarantine reconcile (A1): invoicing throws ×5, the row quarantines, one tick enqueues exactly one event; a second tick and an operator replay add none', async () => {
    await wipeEndpoints(acme);
    await endpoint(acme, 'https://quarantine.acme.example/', ['order.dispatched']);
    const invoicing = app.get(InvoiceDeliveryHandler);
    const thrower = jest.spyOn(invoicing, 'deliver').mockRejectedValue(new Error('invoicing is down'));
    const orderId = await dispatchOrder([{ skuId: sku.get('A-TEE')!, quantity: 1 }]);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drain();
      await sql`update outbox_messages set next_attempt_at = now() where type = 'order.dispatched' and status = 'pending'`;
    }
    const row = (await sql`select id, status from outbox_messages where type = 'order.dispatched' and payload->'dispatch'->>'orderId' = ${orderId}`)[0]!;
    expect(row.status).toBe('quarantined');
    expect(await eventsOf(orderId)).toHaveLength(0);
    const first = await send();
    expect(first.reconciled).toBe(1);
    expect(await eventsOf(orderId)).toHaveLength(1);
    expect((await send()).reconciled).toBe(0);
    thrower.mockRestore();
    expect((await sql.unsafe(OUTBOX_OPERATOR_REPLAY_SQL, [row.id as string])).count).toBe(1);
    await drain();
    // The replayed row ran every handler (ours deduped on the subject) and was acked.
    expect(await sql`select 1 from outbox_messages where id = ${row.id as string}`).toHaveLength(0);
    expect(await eventsOf(orderId)).toHaveLength(1);
    await wipeEndpoints(acme);
  });

  it('C22: a quarantined row the enqueue cannot build from is tried once, not every tick', async () => {
    await wipeEndpoints(acme);
    await endpoint(acme, 'https://memo.acme.example/', ['order.dispatched']);
    const rowId = uuidv7();
    await sql`insert into outbox_messages (id, tenant_id, type, payload, occurred_at, status, attempts, next_attempt_at)
      values (${rowId}, ${tenantId}, 'order.dispatched', ${sql.json({ dispatch: { nonsense: true } })}, now(), 'quarantined', 5, now())`;
    const spy = jest.spyOn(app.get(WebhookEnqueue), 'enqueueFromSourceInTx');
    await send();
    await send();
    expect(spy.mock.calls.filter((call) => call[2].eventId === rowId)).toHaveLength(1);
    await sql`delete from outbox_messages where id = ${rowId}`;
    await wipeEndpoints(acme);
  });

  // ── the sender's fates ────────────────────────────────────────────────────

  describe('the sender (A2, A3, A12, A18)', () => {
    let e: EndpointBody;
    beforeEach(async () => {
      await wipeEndpoints(acme);
      e = (await endpoint(acme, 'https://fates.acme.example/', ['order.dispatched'])).endpoint;
    });
    afterAll(() => wipeEndpoints(acme));

    it('a 500 retries on the schedule (1 m first, jitter only shortens), counts nothing until final; the 9th fails and counts once', async () => {
      const { deliveryId } = await seedDelivery(e.id, acme);
      transport.answer = () => ok(500);
      await send();
      let [d] = await deliveriesOf(e.id);
      expect(d).toMatchObject({ status: 'pending', attempts: 1, last_status_code: 500, last_error_code: 'http-500' });
      expect(d!.next_wait_s).toBeGreaterThanOrEqual(WEBHOOK_RETRY_WAITS_MS[0] / 1000 - 2);
      expect(d!.next_wait_s).toBeLessThanOrEqual(WEBHOOK_RETRY_WAITS_MS[0] / 1000);
      expect((await endpointRow(e.id)).consecutive_failures).toBe(0);
      for (let attempt = 2; attempt <= 9; attempt += 1) {
        await sql`update webhook_deliveries set next_attempt_at = now() where id = ${deliveryId}`;
        await send();
      }
      [d] = await deliveriesOf(e.id);
      expect(d).toMatchObject({ status: 'failed', attempts: 9, last_error_code: 'http-500' });
      expect((await endpointRow(e.id)).consecutive_failures).toBe(1);
      expect(transport.calls).toHaveLength(9);
      // The same webhook-id on every attempt; a fresh timestamp each time.
      expect(new Set(transport.calls.map((c) => c.headers['webhook-id'])).size).toBe(1);
    });

    it('a 404 fails at once and counts; a 3xx is never followed and fails at once', async () => {
      await seedDelivery(e.id, acme);
      transport.answer = () => ok(404);
      await send();
      expect((await deliveriesOf(e.id))[0]).toMatchObject({ status: 'failed', attempts: 1, last_error_code: 'http-404' });
      expect((await endpointRow(e.id)).consecutive_failures).toBe(1);
      await seedDelivery(e.id, acme);
      transport.answer = () => ok(302);
      await send();
      expect((await deliveriesOf(e.id))[1]).toMatchObject({ status: 'failed', last_error_code: 'http-302' });
      expect((await endpointRow(e.id)).consecutive_failures).toBe(2);
    });

    it('a 429 honours a longer Retry-After', async () => {
      await seedDelivery(e.id, acme);
      transport.answer = () => ({ kind: 'response', statusCode: 429, retryAfterMs: 3_600_000, durationMs: 1 });
      await send();
      const [d] = await deliveriesOf(e.id);
      expect(d!.next_wait_s).toBeGreaterThan(3590);
    });

    it('SSRF (AC): target-blocked retries and NEVER counts toward auto-disable', async () => {
      const { deliveryId } = await seedDelivery(e.id, acme);
      transport.answer = () => ({ kind: 'error', code: 'target-blocked', durationMs: 0 });
      await send();
      expect((await deliveriesOf(e.id))[0]).toMatchObject({ status: 'pending', last_error_code: 'target-blocked' });
      await sql`update webhook_deliveries set attempts = 8, next_attempt_at = now() where id = ${deliveryId}`;
      await send();
      expect((await deliveriesOf(e.id))[0]).toMatchObject({ status: 'failed', attempts: 9, last_error_code: 'target-blocked' });
      expect((await endpointRow(e.id)).consecutive_failures).toBe(0);
    });

    it('a 410 fails, auto-disables `gone` at once, fails the rest and raises a panel entry; a re-enable resolves it', async () => {
      await seedDelivery(e.id, acme);
      transport.answer = () => ok(410);
      const before = (await sql`select count(*)::int as n from webhook_deliveries where endpoint_id = ${e.id}`)[0]!.n as number;
      await send();
      const other = await seedDelivery(e.id, acme);
      const row = await endpointRow(e.id);
      expect(row).toMatchObject({ status: 'disabled', disabled_reason: 'gone' });
      expect(row.disabled_episode_id).not.toBeNull();
      expect(before).toBe(1);
      // A later pending row is failed at claim (gone does not hold).
      await send();
      expect((await deliveriesOf(e.id)).find((d) => d.id === other.deliveryId)).toMatchObject({ status: 'failed', last_error_code: 'endpoint-disabled' });
      await drain();
      const entry = (await sql`select source_id, summary, resolved_at from notifications where tenant_id = ${tenantId} and source_type = 'webhook-disabled' and source_id = ${row.disabled_episode_id as string}`)[0]!;
      expect(entry.summary).toEqual({ endpointId: e.id, clientId: acme, host: 'fates.acme.example', reason: 'gone' });
      expect(entry.resolved_at).toBeNull();
      await patch(acme, e.id, { status: 'active' }).expect(200);
      await drain();
      const resolved = (await sql`select resolved_at, resolution from notifications where source_id = ${row.disabled_episode_id as string}`)[0]!;
      expect(resolved.resolution).toBe('re-enabled');
    });

    it('deleting an auto-disabled endpoint resolves its panel entry `deleted` (VG5)', async () => {
      await seedDelivery(e.id, acme);
      transport.answer = () => ok(410);
      await send();
      const episode = (await endpointRow(e.id)).disabled_episode_id as string;
      await drain();
      await http().delete(`${base(acme)}/${e.id}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(200);
      await drain();
      expect((await sql`select resolution from notifications where source_id = ${episode}`)[0]!.resolution).toBe('deleted');
    });

    it('ten final failures spanning 24 h auto-disable `failing`: pending and new rows are held; re-enable needs release | discard (A5, A12)', async () => {
      await sql`update webhook_endpoints set consecutive_failures = 9, failing_since = now() - interval '25 hours' where id = ${e.id}`;
      const pending = await seedDelivery(e.id, acme);
      await sql`update webhook_deliveries set next_attempt_at = now() + interval '1 hour' where id = ${pending.deliveryId}`;
      await seedDelivery(e.id, acme);
      transport.answer = () => ok(400);
      await send();
      const row = await endpointRow(e.id);
      expect(row).toMatchObject({ status: 'disabled', disabled_reason: 'failing', consecutive_failures: 10 });
      expect((await deliveriesOf(e.id)).find((d) => d.id === pending.deliveryId)!.status).toBe('held');
      const auto = (await sql`select actor_user_id, changes from audit_events where target_id = ${e.id} and action = 'webhook_endpoint.auto_disabled'`)[0]!;
      expect(auto.actor_user_id).toBe('01900000-0000-7000-8000-000000000000');
      // A new event for the client still creates a held delivery.
      const orderId = await dispatchOrder([{ skuId: sku.get('A-TEE')!, quantity: 1 }]);
      await drain();
      expect(await eventsOf(orderId)).toHaveLength(1);
      expect((await deliveriesOf(e.id)).filter((d) => d.status === 'held')).toHaveLength(2);
      const listed = (await http().get(base(acme)).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.items[0];
      expect(listed.heldCount).toBe(2);
      const refused = await patch(acme, e.id, { status: 'active' }).expect(409);
      expect(refused.body).toMatchObject({ code: 'held-decision-required', heldCount: 2 });
      expect((await patch(acme, e.id, { held: 'release' }).expect(400)).body.code).toBe('validation-failed');
      const released = await patch(acme, e.id, { status: 'active', held: 'release' }).expect(200);
      expect(released.body).toMatchObject({ heldReleased: 2, endpoint: { status: 'active', consecutiveFailures: 0, failingSince: null } });
      expect((await deliveriesOf(e.id)).filter((d) => d.status === 'pending')).toHaveLength(2);
      transport.answer = () => ok(204);
      await send();
      expect((await deliveriesOf(e.id)).filter((d) => d.status === 'succeeded')).toHaveLength(2);
      await drain();
      expect((await sql`select resolution from notifications where source_id = ${row.disabled_episode_id as string}`)[0]!.resolution).toBe('re-enabled');
    });

    it('failing → a manual disable resolves the entry `manually-disabled` and fails the held rows; discard on re-enable', async () => {
      await sql`update webhook_endpoints set consecutive_failures = 9, failing_since = now() - interval '25 hours' where id = ${e.id}`;
      await seedDelivery(e.id, acme);
      transport.answer = () => ok(400);
      await send();
      const episode = (await endpointRow(e.id)).disabled_episode_id as string;
      await seedDelivery(e.id, acme, { status: 'held' });
      await patch(acme, e.id, { status: 'disabled' }).expect(200);
      expect(await endpointRow(e.id)).toMatchObject({ status: 'disabled', disabled_reason: 'manual', disabled_episode_id: null });
      expect((await deliveriesOf(e.id)).filter((d) => d.status === 'held')).toHaveLength(0);
      await drain();
      expect((await sql`select resolution from notifications where source_id = ${episode}`)[0]!.resolution).toBe('manually-disabled');
      // A manual disable raises nothing; a re-enable of a manual disable resolves nothing (episode null → ignored).
      await seedDelivery(e.id, acme, { status: 'held' });
      const discarded = await patch(acme, e.id, { status: 'active', held: 'discard' }).expect(200);
      expect(discarded.body.heldDiscarded).toBe(1);
      expect((await deliveriesOf(e.id)).at(-1)).toMatchObject({ status: 'failed', last_error_code: 'discarded' });
      await drain();
      expect((await sql`select count(*)::int as n from notifications where tenant_id = ${tenantId} and source_type = 'webhook-disabled' and source_id = ${episode}`)[0]!.n).toBe(1);
    });

    it('the expiry clock (A2): 72 h + 1 ms on pending_since fails `expired` (and counts); 72 h − 1 ms stays pending; a redeliver resets it', async () => {
      const late = await seedDelivery(e.id, acme);
      const early = await seedDelivery(e.id, acme);
      await sql`update webhook_deliveries set attempts = 1, last_error_code = 'http-503', pending_since = now() - interval '72 hours' - interval '1 millisecond', next_attempt_at = now() + interval '1 hour' where id = ${late.deliveryId}`;
      await sql`update webhook_deliveries set pending_since = now() - interval '72 hours' + interval '1 millisecond' + interval '2 seconds', next_attempt_at = now() + interval '1 hour' where id = ${early.deliveryId}`;
      const summary = await facade.sendDueWebhooksNow(tenantId);
      expect(summary.expired).toBe(1);
      const rows = await deliveriesOf(e.id);
      expect(rows.find((d) => d.id === late.deliveryId)).toMatchObject({ status: 'failed', last_error_code: 'expired' });
      expect(rows.find((d) => d.id === early.deliveryId)).toMatchObject({ status: 'pending' });
      expect((await endpointRow(e.id)).consecutive_failures).toBe(1);
      const key = ulid();
      await post(`${base(acme)}/${e.id}/deliveries/${late.deliveryId}/redeliver`, {}, key).expect(200);
      const reset = (await sql`select extract(epoch from (now() - pending_since)) as age from webhook_deliveries where id = ${late.deliveryId}`)[0]!;
      expect(Number(reset.age)).toBeLessThan(5);
      await expectAuditRow({ tenantId, key, action: 'webhook_endpoint.redelivered', targetType: 'webhook_endpoint', targetId: e.id, actorUserId: ownerId });
    });

    it('C2: an expiry counts toward auto-disable only when the receiver was tried — never a row nothing was sent for, nor a config fault', async () => {
      const unsent = await seedDelivery(e.id, acme);
      const configFault = await seedDelivery(e.id, acme);
      await sql`update webhook_deliveries set pending_since = now() - interval '73 hours', next_attempt_at = now() + interval '1 hour' where id = ${unsent.deliveryId}`;
      await sql`update webhook_deliveries set attempts = 0, last_error_code = 'secret-unavailable', pending_since = now() - interval '73 hours', next_attempt_at = now() + interval '1 hour' where id = ${configFault.deliveryId}`;
      expect((await send()).expired).toBe(2);
      expect((await deliveriesOf(e.id)).every((d) => d.status === 'failed' && d.last_error_code === 'expired')).toBe(true);
      expect((await endpointRow(e.id)).consecutive_failures).toBe(0);
    });

    it('C1: a row that goes stale with its attempts spent is final (`failed stale`), never looping, never counted', async () => {
      const { deliveryId } = await seedDelivery(e.id, acme);
      await sql`update webhook_deliveries set status = 'sending', attempts = 8, claimed_at = now() - interval '301 seconds' where id = ${deliveryId}`;
      await send();
      expect((await deliveriesOf(e.id))[0]).toMatchObject({ status: 'failed', attempts: 9, last_error_code: 'stale' });
      expect(transport.calls).toHaveLength(0);
      expect((await endpointRow(e.id)).consecutive_failures).toBe(0);
    });

    it('C3: a sibling send that auto-disables the endpoint mid-tick HOLDS the next claimed row (release sends it)', async () => {
      await sql`update webhook_endpoints set consecutive_failures = 9, failing_since = now() - interval '25 hours' where id = ${e.id}`;
      await seedDelivery(e.id, acme);
      await seedDelivery(e.id, acme);
      transport.answer = () => ok(400);
      // One send at a time: the first send's final failure disables the endpoint before the second starts.
      const tick = newWebhookTick({ maxPerTick: 50, sendConcurrency: 1 });
      await facade.sendDueWebhooksNow(tenantId, tick);
      expect(await endpointRow(e.id)).toMatchObject({ status: 'disabled', disabled_reason: 'failing' });
      const rows = await deliveriesOf(e.id);
      expect(rows.map((d) => d.status).sort()).toEqual(['failed', 'held']);
      expect(transport.calls).toHaveLength(1);
    });

    it('C5: two claimers on one tenant at once still put at most two rows in flight per endpoint', async () => {
      for (let i = 0; i < 4; i += 1) await seedDelivery(e.id, acme);
      const [a, b] = await Promise.all([sender.claim(tenantId, 50), sender.claim(tenantId, 50)]);
      expect(a.claimed.length + b.claimed.length).toBe(2);
      expect((await sql`select count(*)::int as n from webhook_deliveries where endpoint_id = ${e.id} and status = 'sending'`)[0]!.n).toBe(2);
      await sql`update webhook_deliveries set status = 'pending', claimed_at = null where endpoint_id = ${e.id} and status = 'sending'`;
    });

    it('the tick budget (A3, C24): a claimed row not started before the deadline goes back to pending, no attempt spent; past it nothing is claimed', async () => {
      await seedDelivery(e.id, acme);
      await seedDelivery(e.id, acme);
      transport.answer = async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return ok(204);
      };
      const tick = newWebhookTick({ maxPerTick: 50, sendConcurrency: 1 }, undefined, Date.now() - 60_000 + 50);
      const summary = await facade.sendDueWebhooksNow(tenantId, tick);
      expect(summary).toMatchObject({ claimed: 2, attempted: 1, released: 1 });
      const rows = await deliveriesOf(e.id);
      expect(rows.map((d) => [d.status, d.attempts]).sort()).toEqual([['pending', 0], ['succeeded', 1]]);
      const late = newWebhookTick({ maxPerTick: 50, sendConcurrency: 8 }, undefined, Date.now() - 61_000);
      expect((await facade.sendDueWebhooksNow(tenantId, late)).claimed).toBe(0);
    });

    it('held backlog caps (A5): a held row past 30 days fails `held-expired`; past 10,000 held the OLDEST fail `held-overflow`', async () => {
      const old = await seedDelivery(e.id, acme, { status: 'held', createdAgo: '31 days' });
      await sql`
        with ev as (
          insert into webhook_events (id, tenant_id, client_id, event_type, subject_id, body, created_at, updated_at)
          select gen_random_uuid(), ${tenantId}, ${acme}, 'order.dispatched', gen_random_uuid(), '{}', now() - make_interval(secs => g), now()
            from generate_series(1, 10001) g
          returning id, created_at
        )
        insert into webhook_deliveries (id, tenant_id, client_id, event_id, endpoint_id, status, next_attempt_at, pending_since, created_at, updated_at)
        select gen_random_uuid(), ${tenantId}, ${acme}, ev.id, ${e.id}, 'held', now(), now(), ev.created_at, now() from ev
      `;
      const summary = await send();
      expect(summary.heldExpired).toBe(1);
      expect(summary.heldOverflow).toBe(1);
      // Failed `held-expired`, then — 31 days old — purged by the same sweep's retention arm.
      expect(await sql`select 1 from webhook_deliveries where id = ${old.deliveryId}`).toHaveLength(0);
      const overflowed = (await sql`select created_at from webhook_deliveries where endpoint_id = ${e.id} and last_error_code = 'held-overflow'`)[0]!.created_at as Date;
      const oldestHeld = (await sql`select min(created_at) as at from webhook_deliveries where endpoint_id = ${e.id} and status = 'held'`)[0]!.at as Date;
      expect(overflowed.getTime()).toBeLessThan(oldestHeld.getTime());
      expect((await sql`select count(*)::int as n from webhook_deliveries where endpoint_id = ${e.id} and status = 'held'`)[0]!.n).toBe(10_000);
    });

    it('a stale `sending` row (the worker died mid-send) returns to pending, the attempt counted `stale`, never a failure; it is re-sent with the same webhook-id', async () => {
      const { deliveryId, eventId } = await seedDelivery(e.id, acme);
      await sql`update webhook_deliveries set status = 'sending', claimed_at = now() - interval '301 seconds' where id = ${deliveryId}`;
      await send();
      expect((await deliveriesOf(e.id))[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
      expect(transport.calls[0]!.headers['webhook-id']).toBe(eventId);
      expect((await endpointRow(e.id)).consecutive_failures).toBe(0);
    });

    it('an unopenable secret is a config fault: no attempt spent, retried in 60 s, never counted (A17)', async () => {
      const { deliveryId } = await seedDelivery(e.id, acme);
      const sealed = (await endpointRow(e.id)).secret_sealed as string;
      await sql`update webhook_endpoints set secret_sealed = ${sealed.replace(/:[^:]+$/, ':AAAA')} where id = ${e.id}`;
      const summary = await send();
      expect(summary.configCodes).toEqual(['secret-unavailable']);
      const [d] = await deliveriesOf(e.id);
      expect(d).toMatchObject({ status: 'pending', attempts: 0, last_error_code: 'secret-unavailable' });
      expect(d!.next_wait_s).toBeGreaterThan(50);
      expect(transport.calls).toHaveLength(0);
      expect((await endpointRow(e.id)).consecutive_failures).toBe(0);
      await sql`update webhook_endpoints set secret_sealed = ${sealed} where id = ${e.id}`;
      void deliveryId;
    });

    it('outcome order (A12): a success and a final failure written in both orders keep the counters consistent', async () => {
      for (const order of [['ok', 'fail'], ['fail', 'ok']] as const) {
        await sql`update webhook_endpoints set consecutive_failures = 0, failing_since = null where id = ${e.id}`;
        const claims: { id: string; endpointId: string; eventId: string; attempts: number; claimedAt: string }[] = [];
        for (let i = 0; i < 2; i += 1) {
          const { deliveryId } = await seedDelivery(e.id, acme);
          const claimedAt = new Date().toISOString();
          await sql`update webhook_deliveries set status = 'sending', claimed_at = ${claimedAt} where id = ${deliveryId}`;
          claims.push({ id: deliveryId, endpointId: e.id, eventId: '', attempts: 0, claimedAt });
        }
        for (const [index, kind] of order.entries()) {
          await withTenantTransaction(db, tenantId, (tx) => sender.writeOutcomeInTx(tx, tenantId, claims[index]!, kind === 'ok' ? ok(200) : ok(404)));
        }
        const row = await endpointRow(e.id);
        expect([order.join('→'), row.consecutive_failures, row.failing_since === null]).toEqual([order.join('→'), order[1] === 'ok' ? 0 : 1, order[1] === 'ok']);
      }
    });

    it('fairness (A3): one endpoint hanging cannot hold another tenant’s delivery back within a tick, and at most two are in flight per endpoint', async () => {
      // A second tenant with its own client and endpoint.
      const otherEmail = `b-${ulid().toLowerCase()}@example.com`;
      const other = await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Webhook B ${ulid()}`, ownerEmail: otherEmail, password: PASSWORD }).expect(201);
      const otherToken = (await mintSignIn(app, { email: otherEmail, password: PASSWORD })).body.accessToken as string;
      const otherTenant = other.body.tenant.id as string;
      const otherClient = (await http().post(`${API}/${otherTenant}/clients`).set('Authorization', `Bearer ${otherToken}`).set(KEY_HEADER, ulid()).send({ code: 'ZED', name: 'Zed' }).expect(201)).body.client.id as string;
      const otherEndpoint = (await http().post(`${API}/${otherTenant}/clients/${otherClient}/webhook-endpoints`).set('Authorization', `Bearer ${otherToken}`).set(KEY_HEADER, ulid())
        .send({ url: 'https://fast.zed.example/', eventTypes: ['order.dispatched'] }).expect(201)).body.endpoint.id as string;
      const eventId = uuidv7();
      await sql`insert into webhook_events (id, tenant_id, client_id, event_type, subject_id, body) values (${eventId}, ${otherTenant}, ${otherClient}, 'order.dispatched', ${uuidv7()}, '{}')`;
      await sql`insert into webhook_deliveries (id, tenant_id, client_id, event_id, endpoint_id, status, next_attempt_at, pending_since) values (${uuidv7()}, ${otherTenant}, ${otherClient}, ${eventId}, ${otherEndpoint}, 'pending', now(), now())`;
      for (let i = 0; i < 4; i += 1) await seedDelivery(e.id, acme);

      let release: () => void = () => undefined;
      const hang = new Promise<void>((resolve) => (release = resolve));
      let fastAt = 0;
      transport.answer = async (call) => {
        if (call.url.includes('fates.acme')) {
          await hang;
          return { kind: 'error', code: 'timeout', durationMs: 10_000 };
        }
        fastAt = Date.now();
        return ok(200);
      };
      const worker = new WebhookSenderWorker(app.get(AUTH_DATABASE), facade);
      const ticking = worker.tick();
      const deadline = Date.now() + 10_000;
      const otherStatus = async () => (await sql`select status from webhook_deliveries where tenant_id = ${otherTenant}`)[0]!.status as string;
      while ((await otherStatus()) !== 'succeeded' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      // B succeeded while A's sends are still hanging, inside the same tick.
      expect(fastAt).toBeGreaterThan(0);
      expect(await otherStatus()).toBe('succeeded');
      // The hanging endpoint has exactly two rows in flight (A3's per-endpoint cap).
      expect((await sql`select count(*)::int as n from webhook_deliveries where endpoint_id = ${e.id} and status = 'sending'`)[0]!.n).toBe(2);
      release();
      const driven = await ticking;
      expect(driven).toEqual(expect.arrayContaining([tenantId, otherTenant]));
    });
  });

  // ── the endpoint lifecycle (A4) ────────────────────────────────────────────

  describe('edit, delete, rotate, test, redeliver (A4, A17, A20)', () => {
    let e: EndpointBody;
    let secret: string;
    beforeEach(async () => {
      await wipeEndpoints(acme);
      ({ endpoint: e, secret } = await endpoint(acme, 'https://life.acme.example/', ['order.dispatched', 'receipt.recorded']));
    });
    afterAll(() => wipeEndpoints(acme));

    it('an unchanged edit is a no-op that stores the key; a URL change resets the counters; narrowing fails the dropped type’s rows `unsubscribed`', async () => {
      const key = noOpIdempotencyKey(tenantId, ulid(), 'clientWebhooks.update:unchanged');
      await patch(acme, e.id, { url: 'https://LIFE.acme.example:443/', eventTypes: ['receipt.recorded', 'order.dispatched'] }, key).expect(200);
      expect((await sql`select count(*)::int as n from audit_events where reference = ${key}`)[0]!.n).toBe(0);
      await sql`update webhook_endpoints set consecutive_failures = 3, failing_since = now() where id = ${e.id}`;
      const receipt = await seedDelivery(e.id, acme, { eventType: 'receipt.recorded' });
      const dispatch = await seedDelivery(e.id, acme);
      const editKey = ulid();
      const edited = await patch(acme, e.id, { url: 'https://life2.acme.example/', eventTypes: ['order.dispatched'] }, editKey).expect(200);
      expect(edited.body.endpoint).toMatchObject({ url: 'https://life2.acme.example/', eventTypes: ['order.dispatched'], consecutiveFailures: 0, failingSince: null });
      await expectAuditRow({ tenantId, key: editKey, action: 'webhook_endpoint.updated', targetType: 'webhook_endpoint', targetId: e.id, actorUserId: ownerId });
      const rows = await deliveriesOf(e.id);
      expect(rows.find((d) => d.id === receipt.deliveryId)).toMatchObject({ status: 'failed', last_error_code: 'unsubscribed' });
      expect(rows.find((d) => d.id === dispatch.deliveryId)).toMatchObject({ status: 'pending' });
      // The pending row goes to the NEW url (read at send).
      await send();
      expect(transport.calls.map((c) => c.url)).toEqual(['https://life2.acme.example/']);
    });

    it('a soft delete fails pending and held rows `endpoint-deleted`, leaves the log readable, unlists it, and a deleted endpoint is 404 to commands', async () => {
      const pending = await seedDelivery(e.id, acme);
      const key = ulid();
      const deleted = await http().delete(`${base(acme)}/${e.id}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key).expect(200);
      expect(deleted.body.endpoint.status).toBe('deleted');
      await expectAuditRow({ tenantId, key, action: 'webhook_endpoint.deleted', targetType: 'webhook_endpoint', targetId: e.id, actorUserId: ownerId });
      expect((await deliveriesOf(e.id))[0]).toMatchObject({ status: 'failed', last_error_code: 'endpoint-deleted' });
      const log = await http().get(`${base(acme)}/${e.id}/deliveries`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(log.body.items.map((d: { id: string }) => d.id)).toEqual([pending.deliveryId]);
      expect((await http().get(base(acme)).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.items).toHaveLength(0);
      expect((await patch(acme, e.id, { description: 'x' }).expect(404)).body.code).toBe('not-found');
      expect((await post(`${base(acme)}/${e.id}/rotate-secret`).expect(404)).body.code).toBe('not-found');
    });

    it('rotate: the new secret once; both secrets sign for 24 h; revokePrevious ends the overlap; both audited', async () => {
      const key = ulid();
      const rotated = await post(`${base(acme)}/${e.id}/rotate-secret`, {}, key).expect(200);
      const next = rotated.body.signingSecret as string;
      expect(next).not.toBe(secret);
      expect(rotated.body.endpoint.previousSecretExpiresAt).not.toBeNull();
      expect((await post(`${base(acme)}/${e.id}/rotate-secret`, {}, key).expect(200)).body.signingSecret).toBeNull();
      await expectAuditRow({ tenantId, key, action: 'webhook_endpoint.secret_rotated', targetType: 'webhook_endpoint', targetId: e.id, actorUserId: ownerId });
      await seedDelivery(e.id, acme);
      await send();
      const call = transport.calls[0]!;
      expect(call.headers['webhook-signature']!.split(' ')).toHaveLength(2);
      expect(new Webhook(next).verify(call.body, call.headers as Record<string, string>)).toBeTruthy();
      expect(new Webhook(secret).verify(call.body, call.headers as Record<string, string>)).toBeTruthy();
      const revokeKey = ulid();
      const revoked = await post(`${base(acme)}/${e.id}/rotate-secret`, { revokePrevious: true }, revokeKey).expect(200);
      expect(revoked.body.endpoint.previousSecretExpiresAt).toBeNull();
      await expectAuditRow({ tenantId, key: revokeKey, action: 'webhook_endpoint.secret_revoked', targetType: 'webhook_endpoint', targetId: e.id, actorUserId: ownerId });
      transport.calls = [];
      await seedDelivery(e.id, acme);
      await send();
      expect(transport.calls[0]!.headers['webhook-signature']!.split(' ')).toHaveLength(1);
      expect(() => new Webhook(next).verify(transport.calls[0]!.body, transport.calls[0]!.headers as Record<string, string>)).toThrow();
      // An expired overlap is dropped by the sweep.
      await post(`${base(acme)}/${e.id}/rotate-secret`).expect(200);
      await sql`update webhook_endpoints set previous_secret_expires_at = now() - interval '1 second' where id = ${e.id}`;
      await send();
      expect((await endpointRow(e.id)).previous_secret_sealed).toBeNull();
    });

    it('test: a synchronous signed send of webhook.test, allowed while disabled, counters untouched, audited; off → 409', async () => {
      await patch(acme, e.id, { status: 'disabled' }).expect(200);
      transport.answer = () => ok(503);
      const key = ulid();
      const res = await post(`${base(acme)}/${e.id}/test`, {}, key).expect(200);
      expect(res.body.test).toMatchObject({ statusCode: 503, errorCode: 'http-503' });
      expect(transport.calls).toHaveLength(1);
      const body = JSON.parse(transport.calls[0]!.body) as { type: string; data: { endpointId: string } };
      expect(body).toMatchObject({ type: 'webhook.test', data: { endpointId: e.id } });
      expect(new Webhook(secret).verify(transport.calls[0]!.body, transport.calls[0]!.headers as Record<string, string>)).toBeTruthy();
      expect((await endpointRow(e.id)).consecutive_failures).toBe(0);
      expect(await deliveriesOf(e.id)).toHaveLength(0);
      await expectAuditRow({ tenantId, key, action: 'webhook_endpoint.test_sent', targetType: 'webhook_endpoint', targetId: e.id, actorUserId: ownerId });
      expect((await post(`${base(acme)}/${e.id}/test`, {}, key).expect(200)).body.test.statusCode).toBe(503);
      expect(transport.calls).toHaveLength(1);
      process.env.WEBHOOK_GATEWAY = 'off';
      try {
        expect((await post(`${base(acme)}/${e.id}/test`).expect(409)).body.code).toBe('webhooks-unavailable');
        const listed = await http().get(base(acme)).set('Authorization', `Bearer ${ownerToken}`).expect(200);
        expect(listed.body.warnings).toEqual(['webhooks-unavailable']);
        // The sweep still runs with the gateway off; nothing is claimed.
        await seedDelivery(e.id, acme);
        await patch(acme, e.id, { status: 'active' }).expect(200);
        const summary = await send();
        expect(summary.claimed).toBe(0);
      } finally {
        process.env.WEBHOOK_GATEWAY = 'https';
      }
    });

    it('redeliver: a final delivery goes back to pending and resends the same bytes; in-progress, disabled, unknown and purged refuse', async () => {
      const { deliveryId, eventId } = await seedDelivery(e.id, acme);
      expect((await post(`${base(acme)}/${e.id}/deliveries/${deliveryId}/redeliver`).expect(409)).body.code).toBe('delivery-in-progress');
      transport.answer = () => ok(400);
      await send();
      const res = await post(`${base(acme)}/${e.id}/deliveries/${deliveryId}/redeliver`).expect(200);
      expect(res.body.delivery).toMatchObject({ id: deliveryId, status: 'pending', attempts: 0, redeliveryCount: 1, eventId, eventType: 'order.dispatched' });
      transport.answer = () => ok(204);
      await send();
      expect(transport.calls[0]!.body).toBe(transport.calls[1]!.body);
      expect(transport.calls[0]!.headers['webhook-id']).toBe(transport.calls[1]!.headers['webhook-id']);
      const detail = await http().get(`${base(acme)}/${e.id}/deliveries/${deliveryId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(detail.body.delivery).toMatchObject({ status: 'succeeded', redeliveryCount: 1 });
      expect(detail.body.delivery.body).toBe(transport.calls[0]!.body);
      expect((await post(`${base(acme)}/${e.id}/deliveries/${uuidv7()}/redeliver`).expect(404)).body.code).toBe('not-found');
      // C11 — a delivery whose event is gone is purged, never resent with invented facts.
      const orphan = await seedDelivery(e.id, acme);
      await sql`update webhook_deliveries set status = 'failed' where id = ${orphan.deliveryId}`;
      await sql`delete from webhook_events where id = ${orphan.eventId}`;
      expect((await post(`${base(acme)}/${e.id}/deliveries/${orphan.deliveryId}/redeliver`).expect(410)).body.code).toBe('delivery-purged');
      const old = uuidv7(Date.now() - 31 * 86_400_000);
      expect((await post(`${base(acme)}/${e.id}/deliveries/${old}/redeliver`).expect(410)).body.code).toBe('delivery-purged');
      expect((await http().get(`${base(acme)}/${e.id}/deliveries/${old}`).set('Authorization', `Bearer ${ownerToken}`).expect(410)).body.code).toBe('delivery-purged');
      await patch(acme, e.id, { status: 'disabled' }).expect(200);
      expect((await post(`${base(acme)}/${e.id}/deliveries/${deliveryId}/redeliver`).expect(409)).body.code).toBe('webhook-endpoint-disabled');
      expect((await post(`${base(acme)}/${e.id}/deliveries/redeliver`, { since: '2026-01-01T00:00:00Z' }).expect(409)).body.code).toBe('webhook-endpoint-disabled');
    });

    it('bulk redeliver: failed (or only expired) since an instant, oldest first, audited; the literal route is not captured by :deliveryId', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) ids.push((await seedDelivery(e.id, acme)).deliveryId);
      await sql`update webhook_deliveries set status = 'failed', last_error_code = case when id = ${ids[0]!} then 'expired' else 'http-500' end where id in ${sql(ids)}`;
      const key = ulid();
      const expiredOnly = await post(`${base(acme)}/${e.id}/deliveries/redeliver`, { since: '2026-01-01T00:00:00Z', statuses: ['expired'] }, key).expect(200);
      expect(expiredOnly.body).toEqual({ redelivered: 1, remaining: 0 });
      await expectAuditRow({ tenantId, key, action: 'webhook_endpoint.bulk_redelivered', targetType: 'webhook_endpoint', targetId: e.id, actorUserId: ownerId });
      const all = await post(`${base(acme)}/${e.id}/deliveries/redeliver`, { since: '2026-01-01T00:00:00Z' }).expect(200);
      expect(all.body).toEqual({ redelivered: 2, remaining: 0 });

      expect((await deliveriesOf(e.id)).every((d) => d.status === 'pending')).toBe(true);
      // C4 — never a row whose type is no longer subscribed, nor a discarded one.
      const skipped = await seedDelivery(e.id, acme);
      await sql`update webhook_deliveries set status = 'failed', last_error_code = 'unsubscribed' where id = ${skipped.deliveryId}`;
      const discarded = await seedDelivery(e.id, acme);
      await sql`update webhook_deliveries set status = 'failed', last_error_code = 'discarded' where id = ${discarded.deliveryId}`;
      expect((await post(`${base(acme)}/${e.id}/deliveries/redeliver`, { since: '2026-01-01T00:00:00Z' }).expect(200)).body).toEqual({ redelivered: 0, remaining: 0 });
      expect((await post(`${base(acme)}/${e.id}/deliveries/redeliver`, { since: 'yesterday' }).expect(400)).body.code).toBe('validation-failed');
    });

    it('rate limit (A20): an 11th manual send in a minute is 429 rate-limited with retryAfterSeconds', async () => {
      await sql`update webhook_endpoints set rate_window_start = date_trunc('minute', now()), rate_window_count = 10 where id = ${e.id}`;
      const res = await post(`${base(acme)}/${e.id}/test`).expect(429);
      expect(res.body.code).toBe('rate-limited');
      expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(transport.calls).toHaveLength(0);
      await sql`update webhook_endpoints set rate_window_start = date_trunc('minute', now()) - interval '1 minute' where id = ${e.id}`;
      await post(`${base(acme)}/${e.id}/test`).expect(200);
    });

    it('the deliveries list pages newest first with a full-precision cursor', async () => {
      for (let i = 0; i < 5; i += 1) await seedDelivery(e.id, acme);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: request.Response = await http().get(`${base(acme)}/${e.id}/deliveries`).query({ limit: 2, ...(cursor === null ? {} : { cursor }) }).set('Authorization', `Bearer ${ownerToken}`).expect(200);
        seen.push(...page.body.items.map((d: { id: string }) => d.id));
        cursor = page.body.nextCursor as string | null;
      } while (cursor !== null);
      const expected = (await sql`select id from webhook_deliveries where endpoint_id = ${e.id} order by created_at desc, id desc`).map((r) => r.id as string);
      expect(seen).toEqual(expected);
      expect((await http().get(`${base(acme)}/${e.id}/deliveries`).query({ status: 'bogus' }).set('Authorization', `Bearer ${ownerToken}`).expect(400)).body.code).toBe('validation-failed');
    });

    it('a departed client: its endpoint is disabled `client-departed` and its pending rows fail at the sweep; create refuses 409', async () => {
      const dep = await createClient(`DEP${ulid().slice(22)}`, 'Departing');
      const { endpoint: de } = await endpoint(dep, 'https://dep.example.org/', ['order.dispatched']);
      await seedDelivery(de.id, dep);
      await sql`update clients set status = 'departed' where id = ${dep}`;
      await send();
      expect(await endpointRow(de.id)).toMatchObject({ status: 'disabled', disabled_reason: 'client-departed' });
      expect((await deliveriesOf(de.id))[0]).toMatchObject({ status: 'failed', last_error_code: 'client-departed' });
      expect((await create(dep, { url: 'https://dep2.example.org/', eventTypes: ['order.dispatched'] }).expect(409)).body.code).toBe('client-departed');
      expect((await patch(dep, de.id, { status: 'active' }).expect(409)).body.code).toBe('client-departed');
      // C9 — an endpoint already auto-disabled for failing: its held backlog is failed too.
      const { endpoint: fe } = await endpoint(dep, 'https://dep3.example.org/', ['order.dispatched']).catch(async () => {
        await sql`update clients set status = 'active' where id = ${dep}`;
        const made = await endpoint(dep, 'https://dep3.example.org/', ['order.dispatched']);
        await sql`update clients set status = 'departed' where id = ${dep}`;
        return made;
      });
      await sql`update webhook_endpoints set status = 'disabled', disabled_reason = 'failing', disabled_at = now(), disabled_episode_id = gen_random_uuid(), consecutive_failures = 10, failing_since = now() where id = ${fe.id}`;
      await seedDelivery(fe.id, dep, { status: 'held' });
      await send();
      expect((await deliveriesOf(fe.id))[0]).toMatchObject({ status: 'failed', last_error_code: 'client-departed' });
      await wipeEndpoints(dep);
    });
  });

  // ── retention ──────────────────────────────────────────────────────────────

  it('retention: final deliveries and empty events past 30 days, and deleted endpoints past 30 days, are purged; newer rows stay', async () => {
    await wipeEndpoints(acme);
    const { endpoint: e } = await endpoint(acme, 'https://purge.acme.example/', ['order.dispatched']);
    const old = await seedDelivery(e.id, acme, { createdAgo: '31 days' });
    const fresh = await seedDelivery(e.id, acme);
    await sql`update webhook_deliveries set status = 'failed', last_attempt_at = now() - interval '31 days' where id = ${old.deliveryId}`;
    await sql`update webhook_deliveries set status = 'succeeded', succeeded_at = now() where id = ${fresh.deliveryId}`;
    const summary = await send();
    expect(summary.purgedDeliveries).toBe(1);
    expect(summary.purgedEvents).toBe(1);
    expect(await deliveriesOf(e.id)).toHaveLength(1);
    await http().delete(`${base(acme)}/${e.id}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).expect(200);
    await sql`update webhook_endpoints set deleted_at = now() - interval '31 days' where id = ${e.id}`;
    // The tenant has no live endpoint left: discovery still finds it (C10 / VG7), and the tick purges.
    const worker = new WebhookSenderWorker(app.get(AUTH_DATABASE), facade);
    expect(await worker.tick()).toContain(tenantId);
    expect((await sql`select count(*)::int as n from webhook_endpoints where id = ${e.id}`)[0]!.n).toBe(0);
  });

  // ── RLS ────────────────────────────────────────────────────────────────────

  it('RLS: the three tables are tenant- and client-isolated (wms_rls_probe), with a positive control', async () => {
    await wipeEndpoints(acme);
    const { endpoint: e } = await endpoint(acme, 'https://rls.acme.example/', ['order.dispatched']);
    await seedDelivery(e.id, acme);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      for (const table of ['webhook_endpoints', 'webhook_events', 'webhook_deliveries']) {
        expect(await rls`select 1 from ${rls(table)} where tenant_id = ${tenantId}`).toHaveLength(0);
        const foreign = await rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
          return tx`select 1 from ${tx(table)} where tenant_id = ${tenantId}`;
        });
        expect(foreign).toHaveLength(0);
        const otherClient = await rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
          await tx`select set_config('app.client_id', ${beta}, true)`;
          return tx`select 1 from ${tx(table)} where tenant_id = ${tenantId}`;
        });
        expect([table, otherClient.length]).toEqual([table, 0]);
        const own = await rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
          await tx`select set_config('app.client_id', ${acme}, true)`;
          return tx`select 1 from ${tx(table)} where tenant_id = ${tenantId}`;
        });
        expect([table, own.length]).toEqual([table, 1]);
      }
    } finally {
      await rls.end();
      await wipeEndpoints(acme);
    }
  });

  it('webhooks:reseal (A17): after a key rotation every secret is re-sealed under the new key, so _PREVIOUS can be retired', async () => {
    await wipeEndpoints(acme);
    const { endpoint: e, secret } = await endpoint(acme, 'https://reseal.acme.example/', ['order.dispatched']);
    const oldKey = process.env.WEBHOOK_SEAL_KEY!;
    const newKey = 'e2e-only-webhook-seal-key-ROTATED-0123456789';
    process.env.WEBHOOK_SEAL_KEY = newKey;
    process.env.WEBHOOK_SEAL_KEY_PREVIOUS = oldKey;
    try {
      const first = await withTenantTransaction(db, tenantId, (tx) => resealTenantSecretsInTx(tx, tenantId));
      expect(first).toEqual({ resealed: 1, unchanged: 0, unopenable: [] });
      expect(await withTenantTransaction(db, tenantId, (tx) => resealTenantSecretsInTx(tx, tenantId))).toEqual({ resealed: 0, unchanged: 1, unopenable: [] });
      // C15 — a previous blob that opens under neither key is dropped; the current one is still re-sealed.
      await sql`update webhook_endpoints set previous_secret_sealed = 'v1:deadbeef:AAAA:AAAA:AAAA', previous_secret_expires_at = now() + interval '1 hour' where id = ${e.id}`;
      expect(await withTenantTransaction(db, tenantId, (tx) => resealTenantSecretsInTx(tx, tenantId))).toEqual({ resealed: 1, unchanged: 0, unopenable: [] });
      expect((await endpointRow(e.id)).previous_secret_sealed).toBeNull();
      delete process.env.WEBHOOK_SEAL_KEY_PREVIOUS;
      const row = await endpointRow(e.id);
      expect(openSigningSecret(row.secret_sealed as string, tenantId, e.id)).toBe(secret);
      await seedDelivery(e.id, acme);
      await send();
      expect(new Webhook(secret).verify(transport.calls[0]!.body, transport.calls[0]!.headers as Record<string, string>)).toBeTruthy();
    } finally {
      process.env.WEBHOOK_SEAL_KEY = oldKey;
      delete process.env.WEBHOOK_SEAL_KEY_PREVIOUS;
      await wipeEndpoints(acme);
    }
  });

  it('the worker plumbing: tick() drives every tenant with webhook work once', async () => {
    await wipeEndpoints(acme);
    const { endpoint: e } = await endpoint(acme, 'https://tick.acme.example/', ['order.dispatched']);
    await seedDelivery(e.id, acme);
    const worker = new WebhookSenderWorker(app.get(AUTH_DATABASE), facade);
    expect(await worker.tick()).toContain(tenantId);
    expect((await deliveriesOf(e.id))[0]!.status).toBe('succeeded');
    await wipeEndpoints(acme);
  });
});
