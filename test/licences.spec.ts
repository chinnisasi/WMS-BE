import { type INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { addIsoDays, istDateOf } from '../src/shared/primitives/time';
import { SYSTEM_ACTOR_ID } from '../src/shared/primitives/audit';
import { LICENCE_KINDS, LICENCE_NEEDS, LICENCE_STATUSES } from '../src/shared/primitives/licence';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import { LicenceFacade } from '../src/modules/compliance/licence.facade';
import { licenceClock } from '../src/modules/compliance/licence.command';
import { LicenceExpiryWorker } from '../src/jobs/jobs.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { createLinkedVendor } from './support/linked-vendor';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.LICENCE_EXPIRY_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

jest.setTimeout(180_000);

/**
 * The matrix's "today" (2026-11-01 in the spec) is set 12 days after the real
 * IST date, so a licence added today (its `created_at`) is never a
 * "historical record" relative to it — the suite reads the same whatever day
 * it runs. Every matrix date below is relative to TODAY.
 */
const REAL_TODAY = istDateOf(new Date().toISOString());
const TODAY = addIsoDays(REAL_TODAY, 12);
const day = (offset: number): string => addIsoDays(TODAY, offset);

interface World {
  tenantId: string;
  ownerToken: string;
  ownerUserId: string;
  selfClientId: string;
  w1: string;
  w2: string;
  bin1: string;
  bin2: string;
}

interface Gap {
  holder: 'client' | 'site';
  clientId?: string;
  warehouseId: string;
  need: string;
  coveredBy: string[];
  skuCount: number;
}

/**
 * Story 1-6c — drug and FSSAI licences: the master (add, edit, withdraw), the
 * coverage gaps where drug and food goods are, and the expiry sweep with its
 * notification entries. Every row of the spec's I/O matrix has a test here.
 */
describe('story 1-6c: drug and FSSAI licences', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;
  let relay: OutboxRelay;
  let facade: LicenceFacade;
  const realNow = licenceClock.now;

  const http = () => request(app.getHttpServer());

  function expectProblem(res: request.Response, status: number, code: string): void {
    expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
  }

  async function newWorld(label: string): Promise<World> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Licence ${label} Co ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    const tenantId = registered.body.tenant.id as string;
    const ownerUserId = registered.body.owner.id as string;
    const ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
    const site = async (code: string): Promise<{ id: string; bin: string }> => {
      const id = (
        await http()
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code, name: `${code} site` })
          .expect(201)
      ).body.id as string;
      const zone = (
        await http()
          .post(`${API}/${tenantId}/warehouses/${id}/zones`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'A', name: 'Aisle A' })
          .expect(201)
      ).body.id as string;
      const bin = (
        await http()
          .post(`${API}/${tenantId}/warehouses/${id}/zones/${zone}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 100000, type: 'shelf', code: 'A-01-01' })
          .expect(201)
      ).body.id as string;
      return { id, bin };
    };
    const first = await site('WH-PUN');
    const second = await site('WH-BLR');
    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    return {
      tenantId,
      ownerToken,
      ownerUserId,
      selfClientId: clients.body.items[0].id as string,
      w1: first.id,
      w2: second.id,
      bin1: first.bin,
      bin2: second.bin,
    };
  }

  async function createClient(world: World, code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${world.tenantId}/clients`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name: `${code} Brand` })
        .expect(201)
    ).body.client.id as string;
  }

  async function depart(world: World, clientId: string): Promise<void> {
    await http()
      .patch(`${API}/${world.tenantId}/clients/${clientId}/status`)
      .set('Authorization', `Bearer ${world.ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ status: 'departed' })
      .expect(200);
  }

  let skuSeq = 0;
  async function createSku(world: World, clientId: string, goods: Record<string, unknown>): Promise<string> {
    skuSeq += 1;
    return (
      await http()
        .post(`${API}/${world.tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          code: `LIC-${skuSeq}-${ulid().slice(20)}`,
          name: `Licence goods ${skuSeq}`,
          uom: 'each',
          gstRate: 1800,
          batchTracked: false,
          serialTracked: false,
          catchWeightTracked: false,
          clientId,
          ...goods,
        })
        .expect(201)
    ).body.sku.id as string;
  }

  async function stock(world: World, warehouseId: string, binId: string, skuId: string): Promise<void> {
    await http()
      .post(`${API}/${world.tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${world.ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta: 5, reasonCode: 'stock-count', note: 'licence seed' })
      .expect(201);
  }

  async function announce(world: World, clientId: string, warehouseId: string, skuId: string): Promise<void> {
    await http()
      .post(`${API}/${world.tenantId}/inbound/asns`)
      .set('Authorization', `Bearer ${world.ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ clientId, warehouseId, asnCode: `ASN-${ulid().slice(14)}`, lines: [{ skuId, announcedQty: 4 }] })
      .expect(201);
  }

  function addLicence(world: World, body: Record<string, unknown>, key = ulid(), token = world.ownerToken): SupertestTest {
    return http().post(`${API}/${world.tenantId}/licences`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function editLicence(world: World, id: string, body: Record<string, unknown>, key = ulid(), token = world.ownerToken): SupertestTest {
    return http().patch(`${API}/${world.tenantId}/licences/${id}`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function withdrawLicence(world: World, id: string, key = ulid(), token = world.ownerToken): SupertestTest {
    return http().post(`${API}/${world.tenantId}/licences/${id}/withdraw`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key);
  }

  async function added(world: World, body: Record<string, unknown>): Promise<string> {
    return (await addLicence(world, body).expect(201)).body.licence.id as string;
  }

  async function gapsOf(world: World): Promise<Gap[]> {
    const res = await http().get(`${API}/${world.tenantId}/licences/coverage`).set('Authorization', `Bearer ${world.ownerToken}`).expect(200);
    expect(res.body.asOfDate).toBe(TODAY);
    return res.body.gaps as Gap[];
  }

  async function drainAll(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await sql`update outbox_messages set next_attempt_at = now() where status = 'pending'`;
      const drained = await relay.drain(100);
      if (drained.length === 0) return;
    }
  }

  async function licenceRow(id: string): Promise<Record<string, unknown>> {
    const rows = await sql`
      select status, number, valid_until::text as valid_until, upcoming_warned_on::text as upcoming_warned_on,
             expired_warned_on::text as expired_warned_on, open_warning_id
        from licences where id = ${id}`;
    return rows[0]!;
  }

  async function entriesOf(tenantId: string, licenceId: string): Promise<{ source_id: string; state: string; resolution: string | null }[]> {
    return (await sql`
      select source_id, summary->>'state' as state, resolution
        from notifications
       where tenant_id = ${tenantId} and source_type = 'licence-expiry' and summary->>'licenceId' = ${licenceId}
       order by raised_at, id`) as unknown as { source_id: string; state: string; resolution: string | null }[];
  }

  async function outboxCount(tenantId: string, type: string, licenceId: string): Promise<number> {
    return (
      await sql<{ n: number }[]>`select count(*)::int as n from outbox_messages
        where tenant_id = ${tenantId} and type = ${type} and payload->>'licenceId' = ${licenceId}`
    )[0]!.n;
  }

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('licences');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    facade = app.get(LicenceFacade);
    licenceClock.now = () => Date.parse(`${TODAY}T06:00:00Z`);
  });

  afterAll(async () => {
    licenceClock.now = realNow;
    await sql?.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── vocabularies and the contract ──────────────────────────────────────────

  describe('vocabularies and the contract', () => {
    async function literals(conname: string): Promise<string[]> {
      const def = (await sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${conname}`)[0]!.def;
      return [...new Set([...def.matchAll(/'([^']+)'::text/g)].map((match) => match[1]!))].sort();
    }

    it('the kind and status tuples are exactly their CHECKs’ vocabularies', async () => {
      expect(await literals('licences_kind_check')).toEqual([...LICENCE_KINDS].sort());
      expect(await literals('licences_status_check')).toEqual([...LICENCE_STATUSES].sort());
    });

    it('the committed OpenAPI carries the five routes and the kind and need enums', () => {
      const committed = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8')) as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
        components: { schemas: Record<string, { properties?: Record<string, { enum?: string[]; items?: { enum?: string[] } }> }> };
      };
      expect(Object.keys(committed.paths['/tenants/{tenantId}/licences']!).sort()).toEqual(['get', 'post']);
      expect(Object.keys(committed.paths['/tenants/{tenantId}/licences/{licenceId}']!)).toEqual(['patch']);
      expect(Object.keys(committed.paths['/tenants/{tenantId}/licences/{licenceId}/withdraw']!)).toEqual(['post']);
      expect(Object.keys(committed.paths['/tenants/{tenantId}/licences/coverage']!)).toEqual(['get']);
      expect(Object.keys(committed.paths['/tenants/{tenantId}/licences']!['post']!.responses).sort()).toEqual(['201', '400', '401', '403', '404', '409', '422']);
      expect(committed.components.schemas['AddLicenceDto']!.properties!['kind']!.enum).toEqual([...LICENCE_KINDS]);
      expect(committed.components.schemas['CoverageGapDto']!.properties!['need']!.enum).toEqual([...LICENCE_NEEDS]);
      expect(committed.components.schemas['CoverageGapDto']!.properties!['coveredBy']!.items!.enum).toEqual([...LICENCE_KINDS]);
    });
  });

  // ── the master ─────────────────────────────────────────────────────────────

  describe('the master: add, edit, withdraw', () => {
    let world: World;
    let acme: string;
    let opsToken: string;
    let portalToken: string;

    beforeAll(async () => {
      world = await newWorld('master');
      acme = await createClient(world, 'ACME');
      const opsEmail = `ops-${ulid().toLowerCase()}@example.com`;
      const invited = await http()
        .post(`${API}/${world.tenantId}/users`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email: opsEmail, role: 'ops_manager' })
        .expect(201);
      await http()
        .post(`${API}/${world.tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password: PASSWORD })
        .expect(200);
      opsToken = (await mintSignIn(app, { email: opsEmail, password: PASSWORD })).body.accessToken as string;
      const portalEmail = `portal-${ulid().toLowerCase()}@brand.example`;
      const portalInvite = await http()
        .post(`${API}/${world.tenantId}/users`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email: portalEmail, role: 'client', clientId: acme })
        .expect(201);
      await http()
        .post(`${API}/${world.tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: portalInvite.body.inviteToken as string, password: PASSWORD })
        .expect(200);
      portalToken = (await http().post(`${API}/sign-in`).send({ email: portalEmail, password: PASSWORD }).expect(200)).body.accessToken as string;
    });

    it('Add FSSAI: 201, audited, and a same-key replay answers the same body with one row', async () => {
      const key = ulid();
      const body = { clientId: acme, kind: 'fssai-state', number: '10012345678901', validUntil: '2027-03-31' };
      const res = await addLicence(world, body, key).expect(201);
      expect(res.body.licence).toMatchObject({
        holder: 'client',
        clientId: acme,
        warehouseId: null,
        kind: 'fssai-state',
        number: '10012345678901',
        validFrom: null,
        validUntil: '2027-03-31',
        note: null,
        status: 'active',
      });
      await expectAuditRow({ tenantId: world.tenantId, key, action: 'licence.added', targetType: 'licence', targetId: res.body.licence.id, actorUserId: world.ownerUserId });
      const replay = await addLicence(world, body, key).expect(201);
      expect(replay.body).toEqual(res.body);
      await expectAuditRow({ tenantId: world.tenantId, key, action: 'licence.added', targetType: 'licence', targetId: res.body.licence.id, actorUserId: world.ownerUserId });
      expect((await sql`select id from licences where tenant_id = ${world.tenantId} and number = '10012345678901'`).length).toBe(1);
      expectProblem(await addLicence(world, { ...body, note: 'changed' }, key), 422, 'idempotency-key-reuse');
    });

    it('Registration prefix: a registration number starting 1 is 400', async () => {
      const res = await addLicence(world, { clientId: acme, kind: 'fssai-registration', number: '10012345678901', validUntil: '2027-03-31' });
      expectProblem(res, 400, 'validation-failed');
      expect(res.body.detail).toContain('starts with 2');
    });

    it('Premises licence: client + site, the number normalised', async () => {
      const res = await addLicence(world, { clientId: acme, warehouseId: world.w1, kind: 'drug-20b', number: 'mh/pun/20b  12' }).expect(201);
      expect(res.body.licence).toMatchObject({ holder: 'client', clientId: acme, warehouseId: world.w1, number: 'MH/PUN/20B 12', validUntil: null });
    });

    it('NDPS without expiry, a malformed date, until before from, no holder, an over-long note: 400', async () => {
      expectProblem(await addLicence(world, { warehouseId: world.w1, kind: 'ndps', number: 'NDPS-1' }), 400, 'validation-failed');
      expectProblem(await addLicence(world, { warehouseId: world.w1, kind: 'drug-20b', number: 'D-1', validUntil: '2027-02-30' }), 400, 'validation-failed');
      expectProblem(await addLicence(world, { warehouseId: world.w1, kind: 'drug-20b', number: 'D-1', validFrom: '2027-02-02', validUntil: '2027-02-01' }), 400, 'validation-failed');
      expectProblem(await addLicence(world, { kind: 'drug-20b', number: 'D-1' }), 400, 'validation-failed');
      expectProblem(await addLicence(world, { warehouseId: world.w1, kind: 'drug-20b', number: 'D-1', note: 'n'.repeat(201) }), 400, 'validation-failed');
      expectProblem(await addLicence(world, { warehouseId: world.w1, kind: 'drug-20c', number: 'D-1' }), 400, 'validation-failed');
    });

    it('Self holder: 400', async () => {
      const res = await addLicence(world, { clientId: world.selfClientId, kind: 'drug-20b', number: 'SELF-1' });
      expectProblem(res, 400, 'validation-failed');
    });

    it('Departed holder: 409 client-departed', async () => {
      const gone = await createClient(world, 'GONE');
      await depart(world, gone);
      expectProblem(await addLicence(world, { clientId: gone, kind: 'drug-20b', number: 'GONE-1' }), 409, 'client-departed');
    });

    it('Unknown holder or licence: 404 not-found', async () => {
      const other = await newWorld('foreign');
      const foreignClient = await createClient(other, 'FOREIGN');
      expectProblem(await addLicence(world, { clientId: foreignClient, kind: 'drug-20b', number: 'F-1' }), 404, 'not-found');
      expectProblem(await addLicence(world, { warehouseId: other.w1, kind: 'drug-20b', number: 'F-2' }), 404, 'not-found');
      expectProblem(await editLicence(world, uuidv7(), { note: 'x' }), 404, 'not-found');
      expectProblem(await withdrawLicence(world, uuidv7()), 404, 'not-found');
      expectProblem(await editLicence(world, 'not-a-uuid', { note: 'x' }), 400, 'validation-failed');
    });

    it('Family duplicate: an active fssai-state N refuses fssai-central N (409); a withdrawn one frees it', async () => {
      const first = await added(world, { warehouseId: world.w1, kind: 'fssai-state', number: '10000000000077', validUntil: '2027-03-31' });
      const clash = await addLicence(world, { warehouseId: world.w2, kind: 'fssai-central', number: '10000000000077', validUntil: '2027-03-31' });
      expectProblem(clash, 409, 'licence-number-taken');
      // Another family may carry the same text: a drug form's number is its own family.
      await addLicence(world, { warehouseId: world.w1, kind: 'drug-21b', number: 'MH/PUN/20B 12' }).expect(201);
      await withdrawLicence(world, first).expect(200);
      await addLicence(world, { warehouseId: world.w2, kind: 'fssai-central', number: '10000000000077', validUntil: '2027-03-31' }).expect(201);
    });

    it('Edit number clash: 409', async () => {
      await added(world, { warehouseId: world.w1, kind: 'drug-20g', number: 'X-ONE' });
      const second = await added(world, { warehouseId: world.w2, kind: 'drug-20g', number: 'X-TWO' });
      expectProblem(await editLicence(world, second, { number: 'x-one' }), 409, 'licence-number-taken');
    });

    it('Clear FSSAI expiry: 400; a null number: 400; a fixed field in the body: 400', async () => {
      const id = await added(world, { warehouseId: world.w2, kind: 'fssai-state', number: '10000000000123', validUntil: '2027-03-31' });
      expectProblem(await editLicence(world, id, { validUntil: null }), 400, 'validation-failed');
      expectProblem(await editLicence(world, id, { number: null }), 400, 'validation-failed');
      expectProblem(await editLicence(world, id, { kind: 'fssai-central' }), 400, 'validation-failed');
      expectProblem(await editLicence(world, id, { warehouseId: world.w1 }), 400, 'validation-failed');
    });

    it('Edit: absent keeps, null clears; audited licence.edited; an unchanged edit is a no-op that stores the key', async () => {
      const id = await added(world, { warehouseId: world.w2, kind: 'drug-20b', number: 'EDIT-1', validFrom: '2026-01-01', validUntil: '2030-01-01', note: 'first' });
      const key = ulid();
      const res = await editLicence(world, id, { validFrom: null, note: '  second  ' }, key).expect(200);
      expect(res.body.licence).toMatchObject({ number: 'EDIT-1', validFrom: null, validUntil: '2030-01-01', note: 'second' });
      await expectAuditRow({ tenantId: world.tenantId, key, action: 'licence.edited', targetType: 'licence', targetId: id, actorUserId: world.ownerUserId });
      const noOpKey = noOpIdempotencyKey(world.tenantId, ulid(), 'licences.edit:unchanged');
      const unchanged = await editLicence(world, id, { number: 'edit-1', note: 'second' }, noOpKey).expect(200);
      expect(unchanged.body.licence.updatedAt).toBe(res.body.licence.updatedAt);
      expect((await sql`select 1 from audit_events where tenant_id = ${world.tenantId} and reference = ${noOpKey}`).length).toBe(0);
      expect((await sql`select 1 from idempotency_keys where tenant_id = ${world.tenantId} and key = ${noOpKey}`).length).toBe(1);
    });

    it('Edit withdrawn: PATCH or withdraw a withdrawn licence is 409 licence-withdrawn; the withdraw is audited', async () => {
      const id = await added(world, { warehouseId: world.w1, kind: 'drug-21b', number: 'WD-1' });
      const key = ulid();
      const res = await withdrawLicence(world, id, key).expect(200);
      expect(res.body.licence.status).toBe('withdrawn');
      await expectAuditRow({ tenantId: world.tenantId, key, action: 'licence.withdrawn', targetType: 'licence', targetId: id, actorUserId: world.ownerUserId });
      expect((await withdrawLicence(world, id, key).expect(200)).body).toEqual(res.body); // a replay
      expectProblem(await editLicence(world, id, { note: 'x' }), 409, 'licence-withdrawn');
      expectProblem(await withdrawLicence(world, id), 409, 'licence-withdrawn');
    });

    it('Not owner / portal: ops_manager POST, PATCH and withdraw are 403 role-denied; ops reads; portal GET is 403', async () => {
      const id = await added(world, { warehouseId: world.w1, kind: 'drug-20b', number: 'OWN-1' });
      expectProblem(await addLicence(world, { warehouseId: world.w1, kind: 'drug-20b', number: 'OPS-1' }, ulid(), opsToken), 403, 'role-denied');
      expectProblem(await editLicence(world, id, { note: 'x' }, ulid(), opsToken), 403, 'role-denied');
      expectProblem(await withdrawLicence(world, id, ulid(), opsToken), 403, 'role-denied');
      const listed = await http().get(`${API}/${world.tenantId}/licences`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect((listed.body.items as { id: string }[]).some((item) => item.id === id)).toBe(true);
      await http().get(`${API}/${world.tenantId}/licences/coverage`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expectProblem(await http().get(`${API}/${world.tenantId}/licences`).set('Authorization', `Bearer ${portalToken}`), 403, 'role-denied');
      expectProblem(await http().get(`${API}/${world.tenantId}/licences/coverage`).set('Authorization', `Bearer ${portalToken}`), 403, 'role-denied');
    });

    it('the list: active first, the server’s badge and days left for asOfDate, filters', async () => {
      const soon = await added(world, { warehouseId: world.w2, kind: 'drug-20g', number: 'LIST-SOON', validUntil: day(60) });
      const late = await added(world, { warehouseId: world.w2, kind: 'drug-20g', number: 'LIST-LATE', validUntil: day(61) });
      const gone = await added(world, { warehouseId: world.w2, kind: 'drug-20g', number: 'LIST-GONE', validUntil: day(-1) });
      const res = await http().get(`${API}/${world.tenantId}/licences`).query({ warehouseId: world.w2 }).set('Authorization', `Bearer ${world.ownerToken}`).expect(200);
      expect(res.body.asOfDate).toBe(TODAY);
      const items = res.body.items as { id: string; status: string; expiryState: string; daysLeft: number | null; warehouseId: string }[];
      expect(items.every((item) => item.warehouseId === world.w2)).toBe(true);
      const byId = new Map(items.map((item) => [item.id, item]));
      expect(byId.get(soon)).toMatchObject({ expiryState: 'upcoming', daysLeft: 60 });
      expect(byId.get(late)).toMatchObject({ expiryState: 'valid', daysLeft: 61 });
      expect(byId.get(gone)).toMatchObject({ expiryState: 'expired', daysLeft: -1 });
      const statuses = items.map((item) => item.status);
      expect(statuses).toEqual([...statuses].sort()); // active before withdrawn
      const withdrawn = await http().get(`${API}/${world.tenantId}/licences`).query({ status: 'withdrawn' }).set('Authorization', `Bearer ${world.ownerToken}`).expect(200);
      expect((withdrawn.body.items as { expiryState: string; daysLeft: unknown }[]).every((item) => item.expiryState === 'withdrawn' && item.daysLeft === null)).toBe(true);
      expectProblem(await http().get(`${API}/${world.tenantId}/licences`).query({ status: 'expired' }).set('Authorization', `Bearer ${world.ownerToken}`), 400, 'validation-failed');
    });

    describe('the same-key race (IMPLEMENTATION-GUIDE §1): the duplicate replays again under the row lock', () => {
      const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

      async function waitParked(holderPid: number, min: number): Promise<void> {
        const probe = handle();
        try {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const waiting = (await probe`
              select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
              where a.wait_event_type = 'Lock' and a.state = 'active'
                and a.query ilike '%"licences"%' and a.query ilike '%for update%'
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
          throw new Error(`fewer than ${min} request(s) parked on the licences row`);
        } finally {
          await probe.end();
        }
      }

      it('two same-key withdraws parked on the lock both answer 200 with the same body — one withdraw, one key', async () => {
        const id = await added(world, { warehouseId: world.w1, kind: 'drug-20b', number: 'RACE-1' });
        const key = ulid();
        const holder = handle();
        let first: Promise<request.Response> | undefined;
        let second: Promise<request.Response> | undefined;
        try {
          await holder.begin(async (tx) => {
            const locked = (await tx`select pg_backend_pid() as pid from licences where id = ${id} for update`) as unknown as { pid: number }[];
            first = (async () => withdrawLicence(world, id, key))();
            second = (async () => withdrawLicence(world, id, key))();
            await waitParked(locked[0]!.pid, 2);
          });
          const [a, b] = await Promise.all([first!, second!]);
          expect([a.status, b.status]).toEqual([200, 200]);
          expect(b.body).toEqual(a.body);
        } finally {
          await Promise.allSettled([first, second]);
          await holder.end();
        }
        expect((await sql<{ n: number }[]>`select count(*)::int as n from idempotency_keys where tenant_id = ${world.tenantId} and key = ${key}`)[0]!.n).toBe(1);
        expect((await sql<{ n: number }[]>`select count(*)::int as n from audit_events where tenant_id = ${world.tenantId} and reference = ${key}`)[0]!.n).toBe(1);
      });
    });
  });

  // ── coverage gaps ──────────────────────────────────────────────────────────

  describe('coverage gaps — where the goods are (decision 2)', () => {
    const food = { foodCategory: 'dairy' };

    it('Gaps: where goods are — food stock for C at W1 only: client C@W1 and site W1; nothing at W2. Covered → none (the acceptance criterion)', async () => {
      const world = await newWorld('gaps-where');
      const c = await createClient(world, 'ACME');
      const sku = await createSku(world, c, food);
      await stock(world, world.w1, world.bin1, sku);
      // The site's gap first, then the client's (per warehouse).
      expect(await gapsOf(world)).toEqual([
        { holder: 'site', warehouseId: world.w1, need: 'fssai', coveredBy: ['fssai-registration', 'fssai-state', 'fssai-central'], skuCount: 1 },
        { holder: 'client', clientId: c, warehouseId: world.w1, need: 'fssai', coveredBy: ['fssai-registration', 'fssai-state', 'fssai-central'], skuCount: 1 },
      ]);
      await added(world, { clientId: c, kind: 'fssai-central', number: '10011111111111', validUntil: day(365) });
      await added(world, { warehouseId: world.w1, kind: 'fssai-state', number: '10022222222222', validUntil: day(365) });
      expect(await gapsOf(world)).toEqual([]);
    });

    it('Gaps: open ASN — C’s food on an open ASN into W2, no stock: gaps for W2', async () => {
      const world = await newWorld('gaps-asn');
      const c = await createClient(world, 'ACME');
      const sku = await createSku(world, c, food);
      await announce(world, c, world.w2, sku);
      const gaps = await gapsOf(world);
      expect(gaps.map((gap) => [gap.holder, gap.clientId ?? null, gap.warehouseId, gap.need]).sort()).toEqual(
        [['client', c, world.w2, 'fssai'], ['site', null, world.w2, 'fssai']].sort(),
      );
    });

    it('Gaps: open PO — C’s food on an open PO line into W2, no stock: gaps at W2; once the line is fully received, none from it', async () => {
      const world = await newWorld('gaps-po');
      const c = await createClient(world, 'ACME');
      const sku = await createSku(world, c, food);
      const vendorId = await createLinkedVendor(app, world.tenantId, world.ownerToken, { code: 'VEND-LIC', name: 'Licence Vendor' });
      const po = await http()
        .post(`${API}/${world.tenantId}/inbound/purchase-orders`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: world.w2, vendorId, code: `PO-${ulid().slice(14)}`, lines: [{ skuId: sku, orderedQty: 4, unitCostPaise: 1000 }] })
        .expect(201);
      const gaps = await gapsOf(world);
      expect(gaps.map((gap) => [gap.holder, gap.clientId ?? null, gap.warehouseId, gap.need]).sort()).toEqual(
        [['client', c, world.w2, 'fssai'], ['site', null, world.w2, 'fssai']].sort(),
      );
      // Fully received (and the stock since moved out): the still-open PO's line raises no gap.
      // Set below the API — receiving needs a badged-in handheld, and only the line's quantities matter here.
      await sql`update purchase_order_lines set received_qty = ordered_qty where po_id = ${po.body.purchaseOrder.id as string}`;
      expect(await gapsOf(world)).toEqual([]);
    });

    it('Gaps: premises scope — C holds FSSAI for W1 only, goods at W1 and W2: a client gap at W2 only', async () => {
      const world = await newWorld('gaps-premises');
      const c = await createClient(world, 'ACME');
      const sku = await createSku(world, c, food);
      await stock(world, world.w1, world.bin1, sku);
      await stock(world, world.w2, world.bin2, sku);
      await added(world, { clientId: c, warehouseId: world.w1, kind: 'fssai-state', number: '10033333333333', validUntil: day(365) });
      await added(world, { warehouseId: world.w1, kind: 'fssai-registration', number: '20044444444444', validUntil: day(365) });
      await added(world, { warehouseId: world.w2, kind: 'fssai-registration', number: '20055555555555', validUntil: day(365) });
      expect((await gapsOf(world)).map((gap) => [gap.holder, gap.clientId, gap.warehouseId, gap.need])).toEqual([['client', c, world.w2, 'fssai']]);
    });

    it('Gaps: head office — C holds FSSAI with no site: no client gaps', async () => {
      const world = await newWorld('gaps-head');
      const c = await createClient(world, 'ACME');
      const sku = await createSku(world, c, food);
      await stock(world, world.w1, world.bin1, sku);
      await stock(world, world.w2, world.bin2, sku);
      await added(world, { clientId: c, kind: 'fssai-central', number: '10066666666666', validUntil: day(365) });
      expect((await gapsOf(world)).filter((gap) => gap.holder === 'client')).toEqual([]);
      expect((await gapsOf(world)).map((gap) => gap.warehouseId).sort()).toEqual([world.w1, world.w2].sort());
    });

    it('Gaps: Schedule X — both hold drug-20b; an X SKU at W1: drug-20g gaps, client and site; a multi-schedule SKU raises one gap per family', async () => {
      const world = await newWorld('gaps-x');
      const c = await createClient(world, 'ACME');
      await added(world, { clientId: c, kind: 'drug-20b', number: 'C-20B' });
      await added(world, { warehouseId: world.w1, kind: 'drug-20b', number: 'W1-20B' });
      const x = await createSku(world, c, { drugSchedules: ['X'] });
      const hNdps = await createSku(world, c, { drugSchedules: ['H', 'NDPS'] });
      await stock(world, world.w1, world.bin1, x);
      await stock(world, world.w1, world.bin1, hNdps);
      const gaps = await gapsOf(world);
      expect(gaps.map((gap) => [gap.holder, gap.need, gap.coveredBy, gap.skuCount])).toEqual([
        ['site', 'drug-20g', ['drug-20g'], 1],
        ['site', 'ndps', ['ndps'], 1],
        ['client', 'drug-20g', ['drug-20g'], 1],
        ['client', 'ndps', ['ndps'], 1],
      ]);
    });

    it('Gaps: self — your own company’s food at W1: the site gap only', async () => {
      const world = await newWorld('gaps-self');
      const sku = await createSku(world, world.selfClientId, food);
      await stock(world, world.w1, world.bin1, sku);
      expect((await gapsOf(world)).map((gap) => [gap.holder, gap.warehouseId, gap.need])).toEqual([['site', world.w1, 'fssai']]);
    });

    it('Gaps: expired / future / registration — gap; gap; W1 covered by a registration', async () => {
      const world = await newWorld('gaps-dates');
      const c = await createClient(world, 'ACME');
      const d = await createClient(world, 'DELTA');
      const skuC = await createSku(world, c, food);
      const skuD = await createSku(world, d, food);
      await stock(world, world.w1, world.bin1, skuC);
      await stock(world, world.w1, world.bin1, skuD);
      await added(world, { clientId: c, kind: 'fssai-state', number: '10077777777777', validUntil: day(-1) });
      await added(world, { clientId: d, kind: 'fssai-state', number: '10088888888888', validFrom: day(30), validUntil: day(400) });
      await added(world, { warehouseId: world.w1, kind: 'fssai-registration', number: '20099999999999', validUntil: day(365) });
      const gaps = await gapsOf(world);
      expect(gaps.filter((gap) => gap.holder === 'site')).toEqual([]);
      expect(gaps.map((gap) => gap.clientId).sort()).toEqual([c, d].sort());
      // The facade's injectable date: on the future licence's first day, D is covered.
      const later = await facade.coverageGaps(world.tenantId, day(30));
      expect(later.asOfDate).toBe(day(30));
      expect(later.gaps.map((gap) => gap.clientId)).toEqual([c]);
    });

    it('a departed client’s goods raise no gap (the read skips departed clients)', async () => {
      const world = await newWorld('gaps-departed');
      const c = await createClient(world, 'ACME');
      const sku = await createSku(world, c, food);
      await stock(world, world.w1, world.bin1, sku);
      // A departure needs a wound-down client, so the departed state is set below the API here.
      await sql`update clients set status = 'departed' where id = ${c}`;
      expect(await gapsOf(world)).toEqual([]);
    });
  });

  // ── the expiry sweep ───────────────────────────────────────────────────────

  describe('the expiry sweep and its notification entries (decisions 3, 8, 9, 10)', () => {
    let world: World;
    let acme: string;
    let opsToken: string;

    beforeAll(async () => {
      world = await newWorld('sweep');
      acme = await createClient(world, 'ACME');
      const opsEmail = `ops-${ulid().toLowerCase()}@example.com`;
      const invited = await http()
        .post(`${API}/${world.tenantId}/users`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email: opsEmail, role: 'ops_manager' })
        .expect(201);
      await http()
        .post(`${API}/${world.tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password: PASSWORD })
        .expect(200);
      opsToken = (await mintSignIn(app, { email: opsEmail, password: PASSWORD })).body.accessToken as string;
    });

    // Each licence gets a holder of its own: two licences of one holder and
    // need are each other's successor (decision 9), which would mute both.
    let numberSeq = 0;
    const lone = async (validUntil: string): Promise<string> => {
      numberSeq += 1;
      const holder = await createClient(world, `HOLD-${numberSeq}`);
      return added(world, { clientId: holder, kind: 'drug-20g', number: `SW-${numberSeq}`, validUntil });
    };

    it('Sweep day 61: nothing; day 60: one upcoming, a second run raises nothing; the expiry day: upcoming', async () => {
      const d61 = await lone(day(61));
      const d60 = await lone(day(60));
      const d0 = await lone(day(0));
      await facade.sweepExpiry(world.tenantId, TODAY);
      await facade.sweepExpiry(world.tenantId, TODAY);
      expect(await outboxCount(world.tenantId, 'licence.expiry_upcoming', d61)).toBe(0);
      expect(await outboxCount(world.tenantId, 'licence.expiry_upcoming', d60)).toBe(1);
      expect(await outboxCount(world.tenantId, 'licence.expiry_upcoming', d0)).toBe(1);
      expect(await licenceRow(d60)).toMatchObject({ upcoming_warned_on: TODAY, expired_warned_on: null });
      expect((await licenceRow(d60)).open_warning_id).not.toBeNull();
      const audits = await sql<{ actor_user_id: string; target_type: string }[]>`
        select actor_user_id, target_type from audit_events where tenant_id = ${world.tenantId} and action = 'licence.expiry_upcoming_raised' and target_id = ${d60}`;
      expect(audits).toEqual([{ actor_user_id: SYSTEM_ACTOR_ID, target_type: 'licence' }]);
      await drainAll();
      expect(await entriesOf(world.tenantId, d60)).toEqual([{ source_id: (await licenceRow(d60)).open_warning_id, state: 'upcoming', resolution: null }]);
      expect(await entriesOf(world.tenantId, d61)).toEqual([]);
    });

    it('Sweep expired: the open upcoming entry clears (expired) and one expired entry opens (the acceptance criterion, through the worker)', async () => {
      const id = await lone(day(-1));
      // On its last valid day the worker raises the upcoming warning — twice in one day, one entry.
      const worker = app.get(LicenceExpiryWorker);
      expect(await worker.tick(day(-1))).toContain(world.tenantId);
      await worker.tick(day(-1));
      await drainAll();
      const upcoming = await entriesOf(world.tenantId, id);
      expect(upcoming).toEqual([{ source_id: expect.any(String), state: 'upcoming', resolution: null }]);
      // The next day it has expired — the worker must still select the tenant for an expired-only row.
      expect(await worker.tick(TODAY)).toContain(world.tenantId);
      await worker.tick(TODAY);
      await drainAll();
      const after = await entriesOf(world.tenantId, id);
      expect(after).toEqual([
        { source_id: upcoming[0]!.source_id, state: 'upcoming', resolution: 'expired' },
        { source_id: (await licenceRow(id)).open_warning_id, state: 'expired', resolution: null },
      ]);
      expect(await licenceRow(id)).toMatchObject({ upcoming_warned_on: day(-1), expired_warned_on: TODAY });
    });

    it('Sweep exclusions: withdrawn; a departed client’s; until before its added date; a successor valid on until + 1 — no raise, but stamped out of the due set', async () => {
      const withdrawn = await lone(day(10));
      await withdrawLicence(world, withdrawn).expect(200);
      const leaving = await createClient(world, 'LEAVING');
      const departedLicence = await added(world, { clientId: leaving, kind: 'drug-20g', number: 'SW-LEAVE', validUntil: day(10) });
      await depart(world, leaving);
      const historical = await lone(addIsoDays(REAL_TODAY, -1));
      const covered = await added(world, { clientId: acme, warehouseId: world.w1, kind: 'drug-20g', number: 'SW-OLD', validUntil: day(30) });
      await added(world, { clientId: acme, warehouseId: world.w1, kind: 'drug-20g', number: 'SW-NEW', validFrom: day(31), validUntil: day(800) });
      await facade.sweepExpiry(world.tenantId, TODAY);
      for (const id of [withdrawn, departedLicence, historical, covered]) {
        expect(await outboxCount(world.tenantId, 'licence.expiry_upcoming', id)).toBe(0);
        expect(await outboxCount(world.tenantId, 'licence.expired', id)).toBe(0);
        expect((await sql`select 1 from audit_events where tenant_id = ${world.tenantId} and target_id = ${id} and action like 'licence.expir%'`).length).toBe(0);
        expect((await licenceRow(id)).open_warning_id).toBeNull();
      }
      // A withdrawn licence is outside the sweep; a skipped one is stamped for its current state.
      expect(await licenceRow(withdrawn)).toMatchObject({ upcoming_warned_on: null, expired_warned_on: null });
      expect(await licenceRow(departedLicence)).toMatchObject({ upcoming_warned_on: TODAY, expired_warned_on: null });
      expect(await licenceRow(covered)).toMatchObject({ upcoming_warned_on: TODAY, expired_warned_on: null });
      expect(await licenceRow(historical)).toMatchObject({ upcoming_warned_on: TODAY, expired_warned_on: TODAY });
    });

    it('A successor added after the upcoming warning resolves it (renewed)', async () => {
      const holder = await createClient(world, 'SUCC-H');
      const id = await added(world, { clientId: holder, kind: 'drug-20g', number: 'SUCC-OLD', validUntil: day(20) });
      await facade.sweepExpiry(world.tenantId, TODAY);
      await drainAll();
      const warningId = (await licenceRow(id)).open_warning_id as string;
      expect(warningId).not.toBeNull();
      await added(world, { clientId: holder, kind: 'drug-20g', number: 'SUCC-NEW', validFrom: day(21), validUntil: day(800) });
      await facade.sweepExpiry(world.tenantId, TODAY);
      expect((await licenceRow(id)).open_warning_id).toBeNull();
      await drainAll();
      expect(await entriesOf(world.tenantId, id)).toEqual([{ source_id: warningId, state: 'upcoming', resolution: 'renewed' }]);
    });

    it('A departed client’s open upcoming warning resolves (expired) at expiry, and no expired entry opens', async () => {
      const holder = await createClient(world, 'DEP-H');
      const id = await added(world, { clientId: holder, kind: 'drug-20g', number: 'DEP-1', validUntil: day(10) });
      await facade.sweepExpiry(world.tenantId, TODAY);
      await drainAll();
      const warningId = (await licenceRow(id)).open_warning_id as string;
      await depart(world, holder);
      await facade.sweepExpiry(world.tenantId, day(10)); // still upcoming: stays open
      await facade.sweepExpiry(world.tenantId, day(11));
      await drainAll();
      expect(await entriesOf(world.tenantId, id)).toEqual([{ source_id: warningId, state: 'upcoming', resolution: 'expired' }]);
      expect(await licenceRow(id)).toMatchObject({ open_warning_id: null, expired_warned_on: day(11) });
    });

    it('A skipped row is not re-selected by a second worker tick', async () => {
      const lonely = await newWorld('sweep-skip');
      const id = await added(lonely, { warehouseId: lonely.w1, kind: 'drug-20b', number: 'HIST-1', validUntil: addIsoDays(REAL_TODAY, -1) });
      const worker = app.get(LicenceExpiryWorker);
      expect(await worker.tick(TODAY)).toContain(lonely.tenantId);
      expect(await worker.tick(TODAY)).not.toContain(lonely.tenantId);
      expect(await outboxCount(lonely.tenantId, 'licence.expired', id)).toBe(0);
    });

    it('An upcoming-warned licence edited to a past date resolves (expired); the next sweep opens one expired entry', async () => {
      const id = await lone(day(20));
      await facade.sweepExpiry(world.tenantId, TODAY);
      await drainAll();
      const warningId = (await licenceRow(id)).open_warning_id as string;
      await editLicence(world, id, { validUntil: day(-2) }).expect(200);
      expect(await licenceRow(id)).toMatchObject({ upcoming_warned_on: null, expired_warned_on: null, open_warning_id: null });
      await drainAll();
      expect(await entriesOf(world.tenantId, id)).toEqual([{ source_id: warningId, state: 'upcoming', resolution: 'expired' }]);
      await facade.sweepExpiry(world.tenantId, TODAY);
      await drainAll();
      const entries = await entriesOf(world.tenantId, id);
      expect(entries).toHaveLength(2);
      expect(entries[1]).toEqual({ source_id: (await licenceRow(id)).open_warning_id, state: 'expired', resolution: null });
    });

    it('Renewing an expired-warned licence into the window resolves the expired entry (renewed); the next sweep opens one upcoming', async () => {
      const id = await lone(day(-1));
      await facade.sweepExpiry(world.tenantId, TODAY);
      await drainAll();
      const expiredWarning = (await licenceRow(id)).open_warning_id as string;
      expect(await entriesOf(world.tenantId, id)).toEqual([{ source_id: expiredWarning, state: 'expired', resolution: null }]);
      await editLicence(world, id, { validUntil: day(30) }).expect(200);
      expect(await licenceRow(id)).toMatchObject({ upcoming_warned_on: null, expired_warned_on: null, open_warning_id: null });
      await facade.sweepExpiry(world.tenantId, TODAY);
      await drainAll();
      expect(await entriesOf(world.tenantId, id)).toEqual([
        { source_id: expiredWarning, state: 'expired', resolution: 'renewed' },
        { source_id: (await licenceRow(id)).open_warning_id, state: 'upcoming', resolution: null },
      ]);
    });

    it('Renewed: an edit moving validUntil out of the warned state resolves the entry (renewed) and resets the dates', async () => {
      const id = await lone(day(59));
      await facade.sweepExpiry(world.tenantId, TODAY);
      await drainAll();
      const warningId = (await licenceRow(id)).open_warning_id as string;
      await editLicence(world, id, { validUntil: day(800) }).expect(200);
      expect(await licenceRow(id)).toMatchObject({ upcoming_warned_on: null, expired_warned_on: null, open_warning_id: null });
      await drainAll();
      expect(await entriesOf(world.tenantId, id)).toEqual([{ source_id: warningId, state: 'upcoming', resolution: 'renewed' }]);
      // A re-sweep raises nothing for the renewed term.
      await facade.sweepExpiry(world.tenantId, TODAY);
      expect(await outboxCount(world.tenantId, 'licence.expiry_upcoming', id)).toBe(0);
    });

    it('Typo within window: until moved within the warned state — no clear, no re-raise', async () => {
      const id = await lone(day(59));
      await facade.sweepExpiry(world.tenantId, TODAY);
      await drainAll();
      const before = await licenceRow(id);
      await editLicence(world, id, { validUntil: day(58) }).expect(200);
      expect(await licenceRow(id)).toMatchObject({ upcoming_warned_on: before.upcoming_warned_on, open_warning_id: before.open_warning_id });
      await facade.sweepExpiry(world.tenantId, TODAY);
      expect(await outboxCount(world.tenantId, 'licence.expiry_warning_cleared', id)).toBe(0);
      await drainAll();
      expect(await entriesOf(world.tenantId, id)).toEqual([{ source_id: before.open_warning_id, state: 'upcoming', resolution: null }]);
    });

    it('Withdraw warned: the entry resolves (withdrawn)', async () => {
      const id = await lone(day(20));
      await facade.sweepExpiry(world.tenantId, TODAY);
      await drainAll();
      const warningId = (await licenceRow(id)).open_warning_id as string;
      await withdrawLicence(world, id).expect(200);
      await drainAll();
      expect(await entriesOf(world.tenantId, id)).toEqual([{ source_id: warningId, state: 'upcoming', resolution: 'withdrawn' }]);
    });

    it('Notification audience: the owner sees the entries; the ops manager does not', async () => {
      const id = await added(world, { warehouseId: world.w1, kind: 'drug-21b', number: 'SW-SITE', validUntil: day(15) });
      await facade.sweepExpiry(world.tenantId, TODAY);
      await drainAll();
      const owner = await http().get(`${API}/${world.tenantId}/notifications`).query({ limit: 100 }).set('Authorization', `Bearer ${world.ownerToken}`).expect(200);
      const entry = (owner.body.items as { sourceType: string; summary: Record<string, unknown>; warehouseId: string | null }[]).find(
        (item) => item.sourceType === 'licence-expiry' && item.summary.licenceId === id,
      );
      expect(entry).toMatchObject({
        warehouseId: world.w1,
        summary: { licenceId: id, kind: 'drug-21b', holder: 'site', holderName: 'WH-PUN site', siteCode: 'WH-PUN', validUntil: day(15), state: 'upcoming' },
      });
      const ops = await http().get(`${API}/${world.tenantId}/notifications`).query({ limit: 100 }).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect((ops.body.items as { sourceType: string }[]).filter((item) => item.sourceType === 'licence-expiry')).toEqual([]);
      // Never pushed.
      expect((await sql`select 1 from push_deliveries where tenant_id = ${world.tenantId}`).length).toBe(0);
    });
  });
});
