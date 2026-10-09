import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { AsnCommand } from '../src/modules/inbound/asn.command';
import { OPERATOR_SURFACE_DETAIL } from '../src/modules/tenancy/tenant-session.guard';
import { PORTAL_SURFACE_DETAIL } from '../src/modules/clients/portal-session.guard';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

// Story 21-7b — portal ASN entry: a client user announces its OWN inbound
// shipment from the portal (`POST portal/inbound/asns`, the client taken from
// the session), fed by `portal/skus` and `portal/warehouses`. The result is an
// ordinary ASN — the operator, the device snapshot and receiving see it as
// one an operator keyed. Like every jest e2e suite this connects as a
// superuser (RLS inert), so these HTTP tests prove the app predicate; the
// whole announce write set under a client stamp is proved as `wms_rls_probe`
// in test/client-isolation.spec.ts, and the stamp itself by the
// architecture scan.
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
const PASSWORD = 'correct-horse-battery';
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

interface Portal {
  userId: string;
  email: string;
  token: string;
}

describe('portal ASN entry (e2e, story 21-7b)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let otherWarehouse: string; // another tenant's
  let whMain: string; // "Main", Bengaluru
  let whMain2: string; // "Main", Mysuru — the same name, told apart by city
  let whAnnex: string; // "Annex", Chennai
  let clientA: string;
  let clientB: string;
  const sku = new Map<string, string>();
  let portalA: Portal;
  let portalB: Portal;
  let deviceToken: string;
  let deviceOperatorToken: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('portalasn');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2 });

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Portal ASN 3PL ${ulid()}`, ownerEmail, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = await signIn(ownerEmail);

    // Another tenant's warehouse — never listed, never announceable.
    const otherEmail = `other-${ulid().toLowerCase()}@example.com`;
    const other = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Other 3PL ${ulid()}`, ownerEmail: otherEmail, password: PASSWORD })
      .expect(201);
    const otherToken = await signIn(otherEmail);
    otherWarehouse = (
      await http()
        .post(`${API}/${other.body.tenant.id as string}/warehouses`)
        .set('Authorization', `Bearer ${otherToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress({ city: 'Pune' }), code: `OT-${ulid().slice(20)}`, name: 'Elsewhere' })
        .expect(201)
    ).body.id as string;

    whMain = await createWarehouse('PA-W1', 'Main', 'Bengaluru');
    whMain2 = await createWarehouse('PA-W2', 'Main', 'Mysuru');
    whAnnex = await createWarehouse('PA-W3', 'Annex', 'Chennai');

    clientA = await createClient('BRAND-A', 'Brand A Apparel');
    clientB = await createClient('BRAND-B', 'Brand B Beauty');
    await importCsv(
      ['A-1,Alpha tee,pcs,1800,,,', 'A-2,Alpha cap,pcs,1800,,,', 'A-KG,Alpha rice,kg,500,,,', 'A-C1,Alpha sock,pcs,1800,,,', 'A-C2,Alpha band,pcs,1800,,,', 'A-KIT,Alpha bundle,pcs,1800,,,'],
      clientA,
    );
    await importCsv(['B-1,Beta serum,pcs,1800,,,'], clientB);
    const skus = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);
    await http()
      .post(`${API}/${tenantId}/catalog/skus/${sku.get('A-KIT')!}/kit`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ components: [{ skuId: sku.get('A-C1')!, quantity: 1 }, { skuId: sku.get('A-C2')!, quantity: 2 }] })
      .expect(201);

    portalA = await portalUser(clientA);
    portalB = await portalUser(clientB);

    // A floor device with a badged-in operator — the snapshot and the receipt.
    const operatorEmail = `operator-${ulid().toLowerCase()}@example.com`;
    const invited = await invite({ email: operatorEmail, role: 'operator' }).expect(201);
    await accept(invited.body.inviteToken as string);
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Portal ASN dock', pin: '1357' })
      .expect(201);
    deviceToken = enrolled.body.deviceToken as string;
    deviceOperatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${deviceToken}`)
        .send({ operatorEmail, pin: '1357' })
        .expect(200)
    ).body.accessToken as string;
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

  async function signIn(email: string): Promise<string> {
    return (await http().post(`${API}/sign-in`).send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  }

  async function createWarehouse(code: string, name: string, city: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress({ city }), code: `${code}-${ulid().slice(20)}`, name })
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

  function invite(body: Record<string, unknown>) {
    return http().post(`${API}/${tenantId}/users`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send(body);
  }

  async function accept(inviteToken: string): Promise<void> {
    await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: inviteToken, password: PASSWORD }).expect(200);
  }

  async function portalUser(clientId: string): Promise<Portal> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await invite({ email, role: 'client', clientId }).expect(201);
    await accept(invited.body.inviteToken as string);
    return { userId: invited.body.user.id as string, email, token: await signIn(email) };
  }

  function announce(body: Record<string, unknown>, token = portalA.token, key: string | null = ulid()) {
    const req = http().post(`${API}/${tenantId}/portal/inbound/asns`).set('Authorization', `Bearer ${token}`);
    return (key === null ? req : req.set(KEY_HEADER, key)).send(body);
  }

  function portalGet(path: string, token = portalA.token) {
    return http().get(`${API}/${tenantId}/portal/${path}`).set('Authorization', `Bearer ${token}`);
  }

  function operatorCreate(body: Record<string, unknown>, key = ulid()) {
    return http().post(`${API}/${tenantId}/inbound/asns`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key).send(body);
  }

  async function snapshotAsnIds(warehouseId: string): Promise<string[]> {
    const res = await http()
      .get(`${API}/${tenantId}/devices/catalog-snapshot`)
      .query({ warehouseId })
      .set('Authorization', `Bearer ${deviceOperatorToken}`)
      .expect(200);
    return (res.body.openAsns as { id: string }[]).map((a) => a.id);
  }

  /** A direct command call's refusal as `{status, code, detail}`. */
  async function refusal(run: Promise<unknown>): Promise<{ status: number; code: unknown; detail: unknown }> {
    try {
      await run;
    } catch (error) {
      if (error instanceof HttpException) {
        const body = error.getResponse() as { code?: unknown; detail?: unknown };
        return { status: error.getStatus(), code: body.code, detail: body.detail };
      }
      throw error;
    }
    throw new Error('expected a refusal, the command succeeded');
  }

  // ── announce ──────────────────────────────────────────────────────────────

  describe('announce', () => {
    it('a BRAND-A user announces into a warehouse: 201 PortalAsnDetail (exact keys) — an ordinary ASN for the operator, the device and the outbox; the audit actor is the client user', async () => {
      const key = ulid();
      const body = {
        warehouseId: whMain,
        asnCode: ' ASN-ANNOUNCE ',
        expectedAt: '2026-10-20T04:30:00.000Z',
        lines: [
          { skuId: sku.get('A-1')!, announcedQty: 10 },
          { skuId: sku.get('A-KG')!, announcedQty: 2.5 },
        ],
      };
      const res = await announce(body, portalA.token, key).expect(201);
      const id = res.body.id as string;
      const expected = {
        id,
        code: 'ASN-ANNOUNCE',
        status: 'announced',
        expectedAt: '2026-10-20T04:30:00.000Z',
        warehouseName: 'Main',
        lineCount: 2,
        announcedTotal: 12.5,
        receivedTotal: 0,
        createdAt: expect.any(String),
        lines: [
          { skuCode: 'A-1', skuName: 'Alpha tee', announcedQty: 10, receivedQty: 0 },
          { skuCode: 'A-KG', skuName: 'Alpha rice', announcedQty: 2.5, receivedQty: 0 },
        ],
      };
      // The BARE detail — not wrapped in {asn} — and byte-identical in shape to the GET.
      expect(res.body).toEqual(expected);
      expect((await portalGet(`inbound/asns/${id}`).expect(200)).body).toEqual(res.body);

      // Replay: the same key and body re-serve the stored PortalAsnDetail; a changed body is 422.
      expect((await announce(body, portalA.token, key).expect(201)).body).toEqual(res.body);
      expect((await announce({ ...body, asnCode: 'ASN-OTHER' }, portalA.token, key).expect(422)).body.code).toBe('idempotency-key-reuse');
      const stored = await sql`select response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
      expect(stored[0]!.response_snapshot).toEqual({ ...expected, createdAt: res.body.createdAt });

      // The operator sees an ordinary ASN of client A.
      const operator = await http().get(`${API}/${tenantId}/inbound/asns/${id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(operator.body.asn).toMatchObject({ id, code: 'ASN-ANNOUNCE', clientId: clientA, warehouseId: whMain, status: 'announced', statusNote: null });
      // In A's portal list, never B's.
      expect(((await portalGet('inbound/asns').expect(200)).body.items as { id: string }[]).map((a) => a.id)).toContain(id);
      expect(((await portalGet('inbound/asns', portalB.token).expect(200)).body.items as { id: string }[]).map((a) => a.id)).not.toContain(id);
      expect((await portalGet(`inbound/asns/${id}`, portalB.token).expect(404)).body.code).toBe('not-found');
      // On the warehouse's device snapshot, and only that warehouse's.
      expect(await snapshotAsnIds(whMain)).toContain(id);
      expect(await snapshotAsnIds(whAnnex)).not.toContain(id);
      // One outbox `asn.created` carrying the OPERATOR payload, and one audit row whose actor is the client user.
      const outbox = await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'asn.created' and payload->'asn'->>'id' = ${id}`;
      expect(outbox).toHaveLength(1);
      expect((outbox[0]!.payload as { asn: Record<string, unknown> }).asn).toEqual(operator.body.asn);
      const audit = await sql`select actor_user_id, action, target_type, reference from audit_events where tenant_id = ${tenantId} and target_id = ${id}`;
      expect(audit).toEqual([{ actor_user_id: portalA.userId, action: 'asn.created', target_type: 'advance_shipment_notice', reference: key }]);
    });

    it('expectedAt is optional: absent answers null', async () => {
      const res = await announce({ warehouseId: whAnnex, asnCode: 'ASN-NO-DATE', lines: [{ skuId: sku.get('A-2')!, announcedQty: 1 }] }).expect(201);
      expect(res.body).toMatchObject({ code: 'ASN-NO-DATE', expectedAt: null, warehouseName: 'Annex', lineCount: 1 });
    });

    it("a foreign or unknown SKU is the same 404 'for this client' — another client's SKU is never confirmed to exist", async () => {
      for (const skuId of [sku.get('B-1')!, uuidv7()]) {
        const res = await announce({ warehouseId: whMain, asnCode: `ASN-404-${ulid().slice(20)}`, lines: [{ skuId: sku.get('A-1')!, announcedQty: 1 }, { skuId, announcedQty: 1 }] }).expect(404);
        expect(res.body.code).toBe('not-found');
        expect(res.body.detail).toBe(`No SKU with id "${skuId}" exists for this client.`);
      }
    });

    it('a kit SKU is 409 kit-cannot-hold-stock naming the kit (receiving could never book it)', async () => {
      const res = await announce({ warehouseId: whMain, asnCode: 'ASN-KIT', lines: [{ skuId: sku.get('A-KIT')!, announcedQty: 1 }] }).expect(409);
      expect(res.body.code).toBe('kit-cannot-hold-stock');
      expect(res.body.detail).toContain('"A-KIT"');
      const rows = await sql`select count(*)::int as n from advance_shipment_notices where tenant_id = ${tenantId} and asn_code = 'ASN-KIT'`;
      expect(rows[0]!.n).toBe(0);
    });

    it('bad bodies are 400 validation-failed: a clientId, a line id, 0 or 201 lines, a quantity finer than its unit, a 65-character code', async () => {
      const line = { skuId: sku.get('A-1')!, announcedQty: 1 };
      const base = { warehouseId: whMain, asnCode: 'ASN-BAD', lines: [line] };
      for (const body of [
        { ...base, clientId: clientA },
        { ...base, lines: [{ ...line, id: uuidv7() }] },
        { ...base, lines: [] },
        { ...base, lines: Array.from({ length: 201 }, () => line) },
        { ...base, lines: [{ ...line, announcedQty: 1.5 }] },
        { ...base, asnCode: 'X'.repeat(65) },
      ]) {
        expect((await announce(body).expect(400)).body.code).toBe('validation-failed');
      }
      // A malformed expectedAt that passes the DTO's 20–35 length check is
      // refused by the command's UTC-instant rule (above the transaction).
      for (const expectedAt of ['2026-10-20T10:00:00+05:30', 'not-a-date-at-all-xx']) {
        const code = `ASN-BAD-AT-${ulid().slice(20)}`;
        expect((await announce({ ...base, asnCode: code, expectedAt }).expect(400)).body.code).toBe('validation-failed');
        const rows = await sql`select count(*)::int as n from advance_shipment_notices where tenant_id = ${tenantId} and asn_code = ${code}`;
        expect(rows[0]!.n).toBe(0);
      }
      // Meaningful: 64 characters is the edge, and it is accepted.
      await announce({ ...base, asnCode: 'X'.repeat(64) }).expect(201);
    });

    it('the Idempotency-Key is required and must be a ULID (400)', async () => {
      const body = { warehouseId: whMain, asnCode: 'ASN-KEY', lines: [{ skuId: sku.get('A-1')!, announcedQty: 1 }] };
      expect((await announce(body, portalA.token, null).expect(400)).body.code).toBe('idempotency-key-required');
      expect((await announce(body, portalA.token, 'not-a-ulid').expect(400)).body.code).toBe('idempotency-key-invalid');
    });

    it("an unknown warehouse, or another tenant's, is 404", async () => {
      for (const warehouseId of [uuidv7(), otherWarehouse]) {
        expect((await announce({ warehouseId, asnCode: 'ASN-WH', lines: [{ skuId: sku.get('A-1')!, announcedQty: 1 }] }).expect(404)).body.code).toBe('not-found');
      }
    });

    it('the same code twice for A is 409 duplicate-asn-code; A and B may share a code', async () => {
      const body = (skuId: string) => ({ warehouseId: whMain, asnCode: 'ASN-1', lines: [{ skuId, announcedQty: 1 }] });
      await announce(body(sku.get('A-1')!)).expect(201);
      const again = await announce(body(sku.get('A-2')!)).expect(409);
      expect(again.body.code).toBe('duplicate-asn-code');
      expect(again.body.detail).toBe('Client BRAND-A already has an advance shipment notice "ASN-1".');
      await announce(body(sku.get('B-1')!), portalB.token).expect(201);
    });

    it('a key is never shared across surfaces: identical fields (minus clientId) under one key are 422, in both directions', async () => {
      const fields = { warehouseId: whMain, asnCode: 'ASN-XSURF', expectedAt: '2026-10-21T00:00:00.000Z', lines: [{ skuId: sku.get('A-1')!, announcedQty: 3 }] };
      const k1 = ulid();
      await operatorCreate({ clientId: clientA, ...fields }, k1).expect(201);
      expect((await announce({ ...fields, asnCode: 'ASN-XSURF-2' }, portalA.token, k1).expect(422)).body.code).toBe('idempotency-key-reuse');
      expect((await announce(fields, portalA.token, k1).expect(422)).body.code).toBe('idempotency-key-reuse');
      const k2 = ulid();
      const portal = { ...fields, asnCode: 'ASN-XSURF-P' };
      await announce(portal, portalA.token, k2).expect(201);
      expect((await operatorCreate({ clientId: clientA, ...portal }, k2).expect(422)).body.code).toBe('idempotency-key-reuse');
    });
  });

  // ── the fingerprints ──────────────────────────────────────────────────────

  describe('the fingerprints (goldens read from idempotency_keys)', () => {
    it('the portal hash: surface first, then the session client, the trimmed code, expectedAt (null when absent), the lines — written out key by key', async () => {
      const key = ulid();
      await announce({ warehouseId: whAnnex, asnCode: '  ASN-GOLD  ', lines: [{ skuId: sku.get('A-2')!, announcedQty: 4 }, { skuId: sku.get('A-KG')!, announcedQty: 0.25 }] }, portalA.token, key).expect(201);
      const keyDated = ulid();
      await announce({ warehouseId: whAnnex, asnCode: 'ASN-GOLD-D', expectedAt: '2026-11-01T06:00:00Z', lines: [{ skuId: sku.get('A-2')!, announcedQty: 1 }] }, portalA.token, keyDated).expect(201);
      const rows = await sql`select key, payload_hash from idempotency_keys where tenant_id = ${tenantId} and key in (${key}, ${keyDated})`;
      const hashOf = new Map(rows.map((row) => [row.key as string, row.payload_hash as string]));
      expect(hashOf.get(key)).toBe(
        sha256(
          `{"surface":"portal","tenantId":"${tenantId}","clientId":"${clientA}","warehouseId":"${whAnnex}","asnCode":"ASN-GOLD","expectedAt":null,` +
            `"lines":[{"skuId":"${sku.get('A-2')!}","announcedQty":4},{"skuId":"${sku.get('A-KG')!}","announcedQty":0.25}]}`,
        ),
      );
      expect(hashOf.get(keyDated)).toBe(
        sha256(
          `{"surface":"portal","tenantId":"${tenantId}","clientId":"${clientA}","warehouseId":"${whAnnex}","asnCode":"ASN-GOLD-D","expectedAt":"2026-11-01T06:00:00Z",` +
            `"lines":[{"skuId":"${sku.get('A-2')!}","announcedQty":1}]}`,
        ),
      );
    });

    it('the operator create hash and response are UNCHANGED by 21-7b (pinned golden)', async () => {
      const key = ulid();
      const res = await operatorCreate(
        { clientId: clientA, warehouseId: whMain, asnCode: ' ASN-OP-GOLD ', expectedAt: '2026-10-22T00:00:00.000Z', lines: [{ skuId: sku.get('A-1')!, announcedQty: 2 }] },
        key,
      ).expect(201);
      const rows = await sql`select payload_hash, response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
      expect(rows[0]!.payload_hash).toBe(
        sha256(
          `{"tenantId":"${tenantId}","clientId":"${clientA}","warehouseId":"${whMain}","asnCode":"ASN-OP-GOLD","expectedAt":"2026-10-22T00:00:00.000Z",` +
            `"lines":[{"skuId":"${sku.get('A-1')!}","announcedQty":2}]}`,
        ),
      );
      // The operator response: {asn} with its full key set (unchanged).
      expect(Object.keys(res.body)).toEqual(['asn']);
      expect(Object.keys(res.body.asn as Record<string, unknown>).sort()).toEqual(
        ['id', 'code', 'clientId', 'status', 'expectedAt', 'lineCount', 'linesComplete', 'announcedTotal', 'receivedTotal', 'createdAt', 'warehouseId', 'statusNote', 'updatedAt', 'lines'].sort(),
      );
      expect(rows[0]!.response_snapshot).toEqual(res.body);
    });
  });

  // ── authority, re-read in the command's own transaction ───────────────────

  describe('the command re-reads its actor and client (direct calls — the guard would refuse first over HTTP)', () => {
    const command = (overrides: Record<string, unknown> = {}) => ({
      tenantId,
      clientId: clientA,
      actorUserId: portalA.userId,
      warehouseId: whMain,
      asnCode: `ASN-DIRECT-${ulid().slice(18)}`,
      lines: [{ skuId: sku.get('A-1')!, announcedQty: 1 }],
      ...overrides,
    });

    it('an owner (holds asn.announce through everything, but has no client) is 403 role-denied', async () => {
      expect(await refusal(app.get(AsnCommand).announce(command({ actorUserId: ownerUserId }), ulid()))).toEqual({
        status: 403,
        code: 'role-denied',
        detail: 'Only a client-portal user of this client may announce its shipments.',
      });
    });

    it("a B user announcing for A is 403 role-denied", async () => {
      expect(await refusal(app.get(AsnCommand).announce(command({ actorUserId: portalB.userId }), ulid()))).toMatchObject({ status: 403, code: 'role-denied' });
    });

    it('an operator (no asn.announce) is 403 role-denied naming the capability', async () => {
      const email = `op-${ulid().toLowerCase()}@example.com`;
      const invited = await invite({ email, role: 'ops_manager' }).expect(201);
      await accept(invited.body.inviteToken as string);
      const res = await refusal(app.get(AsnCommand).announce(command({ actorUserId: invited.body.user.id as string }), ulid()));
      expect(res).toEqual({ status: 403, code: 'role-denied', detail: 'Role "ops_manager" does not include the "asn.announce" capability.' });
    });

    it('a client suspended between the guard and the command is 403 client-suspended — and nothing is written', async () => {
      const cmd = command();
      await sql`update clients set status = 'suspended' where id = ${clientA}`;
      try {
        expect(await refusal(app.get(AsnCommand).announce(cmd, ulid()))).toMatchObject({ status: 403, code: 'client-suspended' });
      } finally {
        await sql`update clients set status = 'active' where id = ${clientA}`;
      }
      const rows = await sql`select count(*)::int as n from advance_shipment_notices where tenant_id = ${tenantId} and asn_code = ${cmd.asnCode}`;
      expect(rows[0]!.n).toBe(0);
    });

    it('a user no longer active is 401 unauthenticated', async () => {
      const user = await portalUser(clientA);
      await sql`update users set status = 'invited' where id = ${user.userId}`;
      expect(await refusal(app.get(AsnCommand).announce(command({ actorUserId: user.userId }), ulid()))).toMatchObject({ status: 401, code: 'unauthenticated' });
    });

    it('meaningful: the same direct call for the A user commits', async () => {
      const res = await app.get(AsnCommand).announce(command(), ulid());
      expect(res).toMatchObject({ status: 'announced', warehouseName: 'Main', lineCount: 1 });
    });
  });

  // ── the fences ────────────────────────────────────────────────────────────

  describe('the fences', () => {
    it('an operator token on POST portal/inbound/asns is 403 with the portal detail', async () => {
      const res = await announce({ warehouseId: whMain, asnCode: 'ASN-FENCE', lines: [{ skuId: sku.get('A-1')!, announcedQty: 1 }] }, ownerToken).expect(403);
      expect(res.body).toMatchObject({ code: 'role-denied', detail: PORTAL_SURFACE_DETAIL });
    });

    it('a portal token on the operator POST inbound/asns is 403 with the operator-surface detail', async () => {
      const res = await http()
        .post(`${API}/${tenantId}/inbound/asns`)
        .set('Authorization', `Bearer ${portalA.token}`)
        .set(KEY_HEADER, ulid())
        .send({ clientId: clientA, warehouseId: whMain, asnCode: 'ASN-FENCE-2', lines: [{ skuId: sku.get('A-1')!, announcedQty: 1 }] })
        .expect(403);
      expect(res.body).toMatchObject({ code: 'role-denied', detail: OPERATOR_SURFACE_DETAIL });
    });

    it('a suspended client is refused at the guard (403 client-suspended)', async () => {
      await sql`update clients set status = 'suspended' where id = ${clientA}`;
      try {
        expect((await announce({ warehouseId: whMain, asnCode: 'ASN-SUSP', lines: [{ skuId: sku.get('A-1')!, announcedQty: 1 }] }).expect(403)).body.code).toBe('client-suspended');
        expect((await portalGet('skus').expect(403)).body.code).toBe('client-suspended');
      } finally {
        await sql`update clients set status = 'active' where id = ${clientA}`;
      }
    });
  });

  // ── receive ───────────────────────────────────────────────────────────────

  describe('receiving books against a portal ASN', () => {
    it("a device grn.submit with asnId books; A's portal shows it received, and B's never lists it", async () => {
      const announced = await announce({ warehouseId: whMain, asnCode: 'ASN-RECEIVE', lines: [{ skuId: sku.get('A-1')!, announcedQty: 4 }] }).expect(201);
      const id = announced.body.id as string;
      const detail = await http().get(`${API}/${tenantId}/inbound/asns/${id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      const lineId = detail.body.asn.lines[0].id as string;
      const grn = await http()
        .post(`${API}/${tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${deviceOperatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId: whMain,
          asnId: id,
          occurredAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
          lines: [{ asnLineId: lineId, skuId: sku.get('A-1')!, batchCode: null, mfgDate: null, qty: 4 }],
        })
        .expect(201);
      expect(grn.body.goodsReceipt).toMatchObject({ asnId: id });
      const seen = await portalGet(`inbound/asns/${id}`).expect(200);
      expect(seen.body).toMatchObject({ status: 'received', receivedTotal: 4, lines: [{ skuCode: 'A-1', skuName: 'Alpha tee', announcedQty: 4, receivedQty: 4 }] });
      expect(((await portalGet('inbound/asns?status=received').expect(200)).body.items as { id: string }[]).map((a) => a.id)).toContain(id);
      expect(((await portalGet('inbound/asns?limit=100', portalB.token).expect(200)).body.items as { id: string }[]).map((a) => a.id)).not.toContain(id);
    });
  });

  // ── the form's reads ──────────────────────────────────────────────────────

  describe('portal/skus', () => {
    const row = (code: string, name: string, uom = 'each', precision = 0) => ({ skuId: sku.get(code), skuCode: code, skuName: name, baseUom: uom, uomPrecision: precision });

    it("every non-kit SKU of this client, by code — exact keys; the kit is absent; B sees only B's", async () => {
      const res = await portalGet('skus').expect(200);
      expect(res.body).toEqual({
        items: [row('A-1', 'Alpha tee'), row('A-2', 'Alpha cap'), row('A-C1', 'Alpha sock'), row('A-C2', 'Alpha band'), row('A-KG', 'Alpha rice', 'kg', 3)],
        nextCursor: null,
      });
      expect(JSON.stringify(res.body)).not.toContain(sku.get('A-KIT')!);
      expect((await portalGet('skus', portalB.token).expect(200)).body).toEqual({ items: [row('B-1', 'Beta serum')], nextCursor: null });
    });

    it('pages by (code, id); a bad cursor is 400 invalid-cursor; limit is 1–100', async () => {
      const first = await portalGet('skus?limit=2').expect(200);
      expect(first.body.items.map((r: { skuCode: string }) => r.skuCode)).toEqual(['A-1', 'A-2']);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await portalGet(`skus?limit=2&cursor=${first.body.nextCursor as string}`).expect(200);
      expect(second.body).toEqual({ items: [row('A-C1', 'Alpha sock'), row('A-C2', 'Alpha band')], nextCursor: expect.any(String) });
      const third = await portalGet(`skus?limit=2&cursor=${second.body.nextCursor as string}`).expect(200);
      expect(third.body).toEqual({ items: [row('A-KG', 'Alpha rice', 'kg', 3)], nextCursor: null });
      expect((await portalGet('skus?cursor=garbage').expect(400)).body.code).toBe('invalid-cursor');
      const crafted = Buffer.from(JSON.stringify({ code: 'A-1', id: 'nope' })).toString('base64url');
      expect((await portalGet(`skus?cursor=${crafted}`).expect(400)).body.code).toBe('invalid-cursor');
      expect((await portalGet('skus?limit=0').expect(400)).body.code).toBe('validation-failed');
      expect((await portalGet('skus?limit=101').expect(400)).body.code).toBe('validation-failed');
      await portalGet('skus?limit=100').expect(200);
      await portalGet('skus?limit=1').expect(200);
    });
  });

  describe('portal/warehouses', () => {
    it("every warehouse of the tenant by (name, id) — name and city only; never another tenant's", async () => {
      const res = await portalGet('warehouses').expect(200);
      const mains = [
        { warehouseId: whMain, warehouseName: 'Main', city: 'Bengaluru' },
        { warehouseId: whMain2, warehouseName: 'Main', city: 'Mysuru' },
      ].sort((a, b) => (a.warehouseId < b.warehouseId ? -1 : 1));
      expect(res.body).toEqual({ items: [{ warehouseId: whAnnex, warehouseName: 'Annex', city: 'Chennai' }, ...mains] });
      expect(JSON.stringify(res.body)).not.toContain(otherWarehouse);
      expect(JSON.stringify(res.body)).not.toContain('PA-W');
      expect(JSON.stringify(res.body)).not.toContain('Peenya');
      // The same list for B — decision 1: any warehouse of the tenant.
      expect((await portalGet('warehouses', portalB.token).expect(200)).body).toEqual(res.body);
    });
  });

  it('the OpenAPI document declares the announce POST and the two reads', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const paths = doc.body.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths['/tenants/{tenantId}/portal/inbound/asns']!).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths['/tenants/{tenantId}/portal/skus']!)).toEqual(['get']);
    expect(Object.keys(paths['/tenants/{tenantId}/portal/warehouses']!)).toEqual(['get']);
    const post = paths['/tenants/{tenantId}/portal/inbound/asns']!.post as { responses: Record<string, unknown> };
    expect(Object.keys(post.responses).sort()).toEqual(['201', '400', '401', '403', '404', '409', '422']);
  });
});
