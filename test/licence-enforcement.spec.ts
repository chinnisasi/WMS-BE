import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { licenceClock } from '../src/modules/compliance/licence.command';
import { licenceRefusedOpId, shelfLifeRefusedOpId } from '../src/modules/inbound/receiving.command';
import { ReceivingFacade } from '../src/modules/inbound/receiving.facade';
import { ChannelsIngestCommand } from '../src/modules/channels/channels.ingest.command';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
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

jest.setTimeout(240_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

/** The matrix's receipt IST date (2026-11-01) — every receipt below is at 10:00 IST on its day. */
const at = (date: string): string => new Date(Date.parse(`${date}T04:30:00.000Z`)).toISOString();
const RECEIPT_AT = at('2026-11-01');
/** The order create's "today" (the licence clock), the same IST date. */
const TODAY = '2026-11-01';
const WIDE = { validFrom: '2026-01-01', validUntil: '2028-12-31' };

interface Missing {
  need: string;
  holder: 'client' | 'site';
}
interface RejectedLine {
  poLineId: string | null;
  skuId: string;
  qty: number;
  code: string;
  reason: string;
  index?: number;
  missing?: Missing[];
}
interface GoodsReceipt {
  id: string;
  lines: { skuId: string; qty: number; appliedQty: number }[];
  rejectedLines?: RejectedLine[];
  reviewOpId?: string;
  shelfLifeReviewOpId?: string;
  licenceReviewOpId?: string;
}

interface World {
  tenantId: string;
  ownerToken: string;
  ownerUserId: string;
  opsToken: string;
  operatorToken: string;
  operatorUserId: string;
  deviceId: string;
  selfClientId: string;
}

/**
 * Story 1-6d — licence enforcement: the per-tenant switch, the receipt's
 * licence phase and its waivable `grn.licence-refused` review row, the order
 * create's 409 and the channel ingest's typed 422. Every row of the spec's
 * I/O matrix has a test here (the handheld's wording is wms-mobile's).
 */
describe('story 1-6d: licence enforcement', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;
  const realNow = licenceClock.now;
  let skuSeq = 0;

  const http = () => request(app.getHttpServer());

  function expectProblem(res: request.Response, status: number, code: string): void {
    expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
  }

  async function newWorld(label: string): Promise<World> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Enforce ${label} Co ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    const tenantId = registered.body.tenant.id as string;
    const ownerUserId = registered.body.owner.id as string;
    const ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
    const member = async (role: 'ops_manager' | 'operator'): Promise<string> => {
      const memberEmail = `${role}-${ulid().toLowerCase()}@example.com`;
      const invited = await http()
        .post(`${API}/${tenantId}/users`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email: memberEmail, role })
        .expect(201);
      await http()
        .post(`${API}/${tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password: PASSWORD })
        .expect(200);
      return memberEmail;
    };
    const opsEmail = await member('ops_manager');
    const opsToken = (await mintSignIn(app, { email: opsEmail, password: PASSWORD })).body.accessToken as string;
    const operatorEmail = await member('operator');
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: `${label} dock`, pin: '2468' })
      .expect(201);
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail, pin: '2468' })
      .expect(200);
    const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    return {
      tenantId,
      ownerToken,
      ownerUserId,
      opsToken,
      operatorToken: badged.body.accessToken as string,
      operatorUserId: badged.body.operator.id as string,
      deviceId: enrolled.body.device.id as string,
      selfClientId: (clients.body.items as { id: string; systemOwned: boolean }[]).find((c) => c.systemOwned)!.id,
    };
  }

  async function site(world: World, code: string): Promise<{ id: string; bin: string }> {
    const id = (
      await http()
        .post(`${API}/${world.tenantId}/warehouses`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code, name: `${code} site` })
        .expect(201)
    ).body.id as string;
    const zone = (
      await http()
        .post(`${API}/${world.tenantId}/warehouses/${id}/zones`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    const bin = (
      await http()
        .post(`${API}/${world.tenantId}/warehouses/${id}/zones/${zone}/bins`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;
    return { id, bin };
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

  /** A SKU of `clientId`; returns its id and code. `goods` carries 1-6a's attributes (and any flag). */
  async function createSku(world: World, clientId: string, prefix: string, goods: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
    skuSeq += 1;
    const code = `${prefix}-${skuSeq}`;
    const id = (
      await http()
        .post(`${API}/${world.tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          code,
          name: `${prefix} goods ${skuSeq}`,
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
    return { id, code };
  }

  async function addLicence(world: World, body: Record<string, unknown>): Promise<string> {
    return (
      await http()
        .post(`${API}/${world.tenantId}/licences`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send(body)
        .expect(201)
    ).body.licence.id as string;
  }

  let fssaiSeq = 0;
  /** A fresh 14-digit FSSAI state licence number (one family — unique per tenant). */
  const fssaiNumber = (): string => `1${String(Date.now() % 1_000_000).padStart(6, '0')}${String((fssaiSeq += 1)).padStart(7, '0')}`;
  let drugSeq = 0;
  const drugNumber = (): string => `MH/LE/${(drugSeq += 1)}-${ulid().slice(20)}`;

  function fssai(holder: { clientId?: string; warehouseId?: string }, dates: { validFrom?: string; validUntil: string } = WIDE): Record<string, unknown> {
    return { ...holder, kind: 'fssai-state', number: fssaiNumber(), ...dates };
  }

  function putPolicy(world: World, body: Record<string, unknown>, key = ulid(), token = world.ownerToken): SupertestTest {
    return http().put(`${API}/${world.tenantId}/licence-policy`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  async function enforce(world: World, on: boolean): Promise<void> {
    // Acknowledge whatever the GET shows (the web sends the count it showed).
    const shown = (await http().get(`${API}/${world.tenantId}/licence-policy`).set('Authorization', `Bearer ${world.ownerToken}`).expect(200)).body as {
      gapCount: number;
    };
    await putPolicy(world, { enforce: on, acknowledgedGapCount: shown.gapCount }).expect(200);
  }

  function line(skuId: string, qty: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { poLineId: null, skuId, batchCode: null, mfgDate: null, qty, ...extra };
  }

  function receive(world: World, warehouseId: string, clientId: string, lines: Record<string, unknown>[], occurredAt = RECEIPT_AT, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${world.tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${world.operatorToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, occurredAt, poId: null, blindReasonCode: 'other', clientId, lines });
  }

  function createOrder(world: World, warehouseId: string, lines: { skuId: string; quantity: number }[], key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${world.tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${world.opsToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, lines, destination: testAddress() });
  }

  async function stock(world: World, warehouseId: string, binId: string, skuId: string, quantityDelta = 5): Promise<void> {
    await http()
      .post(`${API}/${world.tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${world.ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId, quantityDelta, reasonCode: 'stock-count', note: 'licence enforcement seed' })
      .expect(201);
  }

  async function rejectedOp(world: World, opId: string): Promise<{
    id: string;
    opId: string;
    opType: string;
    decisions: string[];
    problemCode: string;
    problemDetail: string;
    status: string;
    payload: Record<string, unknown>;
  }> {
    const rows = (await sql`select id from rejected_ops where tenant_id = ${world.tenantId} and op_id = ${opId}`) as unknown as { id: string }[];
    if (rows[0] === undefined) throw new Error(`no rejected op ${opId}`);
    const listed = await http()
      .get(`${API}/${world.tenantId}/rejected-ops`)
      .query({ limit: 200 })
      .set('Authorization', `Bearer ${world.ownerToken}`)
      .expect(200);
    return (listed.body.items as { id: string }[]).find((item) => item.id === rows[0]!.id) as never;
  }

  function resolveRow(world: World, rejectedOpId: string, body: Record<string, unknown>, token = world.ownerToken, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${world.tenantId}/rejected-ops/${rejectedOpId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function liveHolds(world: World, skuId: string): Promise<number> {
    const rows = (await sql`select count(*)::int as n from reservations where tenant_id = ${world.tenantId} and sku_id = ${skuId} and state in ('held', 'committed')`) as unknown as { n: number }[];
    return rows[0]!.n;
  }

  async function grnCount(world: World, skuId: string): Promise<number> {
    const rows = (await sql`select count(distinct grn_id)::int as n from goods_receipt_lines where tenant_id = ${world.tenantId} and sku_id = ${skuId}`) as unknown as { n: number }[];
    return rows[0]!.n;
  }

  async function rowsOfType(world: World, opType: string): Promise<number> {
    const rows = (await sql`select count(*)::int as n from rejected_ops where tenant_id = ${world.tenantId} and op_type = ${opType}`) as unknown as { n: number }[];
    return rows[0]!.n;
  }

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('licence_enforcement');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
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

  // ── the contract ───────────────────────────────────────────────────────────

  describe('the contract', () => {
    it('the committed OpenAPI carries the policy routes, the licence code and the new snapshot fields', () => {
      const committed = JSON.parse(readFileSync(resolvePath(process.cwd(), 'openapi/openapi.json'), 'utf8')) as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
        components: { schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
      };
      expect(Object.keys(committed.paths['/tenants/{tenantId}/licence-policy']!).sort()).toEqual(['get', 'put']);
      expect(Object.keys(committed.paths['/tenants/{tenantId}/licence-policy']!['put']!.responses).sort()).toEqual(['200', '400', '401', '403', '409', '422']);
      expect(committed.components.schemas['RejectedGrnLineDto']!.properties!['code']!.enum).toContain('licence-not-covered');
      expect(Object.keys(committed.components.schemas['RejectedGrnLineDto']!.properties!)).toContain('missing');
      expect(Object.keys(committed.components.schemas['GoodsReceiptDto']!.properties!)).toContain('licenceReviewOpId');
      expect(Object.keys(committed.components.schemas['RefusedReceiptDto']!.properties!)).toContain('licenceReviewOpId');
    });

    it('licence_policies is tenant-isolated under RLS (wms_rls_probe sees only its stamped tenant)', async () => {
      const tenantId = uuidv7();
      await sql`insert into licence_policies (id, tenant_id, enforce, updated_by) values (${uuidv7()}, ${tenantId}, true, ${uuidv7()})`;
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        expect(await rls`select 1 from licence_policies where tenant_id = ${tenantId}`).toHaveLength(0);
        const foreign = await rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
          return tx`select 1 from licence_policies where tenant_id = ${tenantId}`;
        });
        expect(foreign).toHaveLength(0);
        const own = await rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
          return tx`select 1 from licence_policies where tenant_id = ${tenantId}`;
        });
        expect(own).toHaveLength(1);
      } finally {
        await rls.end();
      }
      await sql`delete from licence_policies where tenant_id = ${tenantId}`;
    });
  });

  // ── the switch ─────────────────────────────────────────────────────────────

  describe('the switch, and enforcement off', () => {
    let world: World;
    let w1: { id: string; bin: string };
    let c: string;

    beforeAll(async () => {
      world = await newWorld('switch');
      w1 = await site(world, 'SW-W1');
      c = await createClient(world, 'SWC');
    });

    it('Off: no licences; a food receipt books and a food order is created — byte-identical to before (the old hash golden, no new keys)', async () => {
      const policy = await http().get(`${API}/${world.tenantId}/licence-policy`).set('Authorization', `Bearer ${world.opsToken}`).expect(200);
      expect(policy.body).toEqual({ enforce: false, gapCount: 0 });

      const rice = await createSku(world, c, 'RICE', { foodCategory: 'bakery-cereals' });
      const key = ulid();
      const res = await receive(world, w1.id, c, [line(rice.id, 4)], RECEIPT_AT, key).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt & Record<string, unknown>;
      expect(grn.lines).toEqual([expect.objectContaining({ skuId: rice.id, qty: 4, appliedQty: 4 })]);
      for (const absent of ['rejectedLines', 'reviewOpId', 'shelfLifeReviewOpId', 'licenceReviewOpId']) expect(grn).not.toHaveProperty(absent);
      const golden =
        `{"tenantId":"${world.tenantId}","deviceId":"${world.deviceId}","operatorUserId":"${world.operatorUserId}","warehouseId":"${w1.id}",` +
        `"poId":null,"blindReasonCode":"other","clientId":"${c}","occurredAt":"${RECEIPT_AT}",` +
        `"lines":[{"poLineId":null,"skuId":"${rice.id}","batchCode":null,"mfgDate":null,"qty":4}]}`;
      const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${world.tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
      expect(stored[0]!.payload_hash).toBe(createHash('sha256').update(golden, 'utf8').digest('hex'));

      const order = await createOrder(world, w1.id, [{ skuId: rice.id, quantity: 1 }]).expect(201);
      expect(order.body.order.status).toBe('accepted');
    });

    it('Switch, not owner: an ops manager PUT is 403 role-denied; the GET is open to staff', async () => {
      const res = await putPolicy(world, { enforce: true, acknowledgedGapCount: 9 }, ulid(), world.opsToken);
      expectProblem(res, 403, 'role-denied');
    });

    it('Turn on with gaps: 409 licence-gaps-unacknowledged naming gapCount; nothing written', async () => {
      // The rice now on hand at SW-W1 is two known gaps: SWC's client licence and the site's.
      const res = await putPolicy(world, { enforce: true });
      expectProblem(res, 409, 'licence-gaps-unacknowledged');
      expect(res.body.gapCount).toBe(2);
      expect(res.body.detail).toContain('2 known coverage gaps');
      const policy = await http().get(`${API}/${world.tenantId}/licence-policy`).set('Authorization', `Bearer ${world.ownerToken}`).expect(200);
      expect(policy.body).toEqual({ enforce: false, gapCount: 2 });
      // A stale acknowledgement (fewer gaps than now) is refused the same way, naming the live count.
      const stale = await putPolicy(world, { enforce: true, acknowledgedGapCount: 1 });
      expectProblem(stale, 409, 'licence-gaps-unacknowledged');
      expect(stale.body.gapCount).toBe(2);
      expectProblem(await putPolicy(world, { enforce: true, acknowledgedGapCount: -1 }), 400, 'validation-failed');
      expect(await sql`select 1 from licence_policies where tenant_id = ${world.tenantId}`).toHaveLength(0);
    });

    it('Turn on, acknowledged: 200, audited licence.enforcement_enabled; a same-key replay answers the same; the unchanged PUT is a no-op', async () => {
      const key = ulid();
      const on = await putPolicy(world, { enforce: true, acknowledgedGapCount: 2 }, key).expect(200);
      expect(on.body).toEqual({ enforce: true, gapCount: 2 });
      const policyId = ((await sql`select id from licence_policies where tenant_id = ${world.tenantId}`) as unknown as { id: string }[])[0]!.id;
      await expectAuditRow({
        tenantId: world.tenantId,
        key,
        action: 'licence.enforcement_enabled',
        targetType: 'licence_policy',
        targetId: policyId,
        actorUserId: world.ownerUserId,
      });
      // acknowledgedGapCount is a precondition, not hashed: the same key without it replays.
      const replay = await putPolicy(world, { enforce: true }, key).expect(200);
      expect(replay.body).toEqual(on.body);
      await expectAuditRow({
        tenantId: world.tenantId,
        key,
        action: 'licence.enforcement_enabled',
        targetType: 'licence_policy',
        targetId: policyId,
        actorUserId: world.ownerUserId,
      });
      // Already on: a no-op that stores its key (no audit row, no gap scan) — no acknowledgement needed.
      const noOpKey = noOpIdempotencyKey(world.tenantId, ulid(), 'licencePolicy.put:unchanged');
      const unchanged = await putPolicy(world, { enforce: true }, noOpKey).expect(200);
      expect(unchanged.body).toEqual({ enforce: true });
      expect(await sql`select 1 from audit_events where tenant_id = ${world.tenantId} and reference = ${noOpKey}`).toHaveLength(0);
      // A different payload under a used key is 422.
      expectProblem(await putPolicy(world, { enforce: false }, key), 422, 'idempotency-key-reuse');
    });

    it('Turn off: 200, audited licence.enforcement_disabled — always allowed, whatever the gaps, and scans none', async () => {
      const key = ulid();
      const off = await putPolicy(world, { enforce: false }, key).expect(200);
      expect(off.body).toEqual({ enforce: false });
      const policyId = ((await sql`select id from licence_policies where tenant_id = ${world.tenantId}`) as unknown as { id: string }[])[0]!.id;
      await expectAuditRow({
        tenantId: world.tenantId,
        key,
        action: 'licence.enforcement_disabled',
        targetType: 'licence_policy',
        targetId: policyId,
        actorUserId: world.ownerUserId,
      });
      expect((await sql`select enforce from licence_policies where tenant_id = ${world.tenantId}`)[0]!.enforce).toBe(false);
    });

    it('a portal session gets 403 on the GET', async () => {
      const email = `client-${ulid().toLowerCase()}@example.com`;
      const invited = await http()
        .post(`${API}/${world.tenantId}/users`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email, role: 'client', clientId: c })
        .expect(201);
      await http()
        .post(`${API}/${world.tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password: PASSWORD })
        .expect(200);
      const portalToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
      const res = await http().get(`${API}/${world.tenantId}/licence-policy`).set('Authorization', `Bearer ${portalToken}`);
      expectProblem(res, 403, 'role-denied');
    });
  });

  describe('Blind into an empty site', () => {
    it('gapCount 0 turns on without an acknowledgement; a blind food receipt into a site holding nothing is still refused', async () => {
      const world = await newWorld('empty');
      const w = await site(world, 'EM-W1');
      const c = await createClient(world, 'EMC');
      const rice = await createSku(world, c, 'RICE', { foodCategory: 'bakery-cereals' });
      const onKey = ulid();
      const on = await putPolicy(world, { enforce: true }, onKey).expect(200);
      expect(on.body).toEqual({ enforce: true, gapCount: 0 });
      await expectAuditRow({
        tenantId: world.tenantId,
        key: onKey,
        action: 'licence.enforcement_enabled',
        targetType: 'licence_policy',
        targetId: ((await sql`select id from licence_policies where tenant_id = ${world.tenantId}`) as unknown as { id: string }[])[0]!.id,
        actorUserId: world.ownerUserId,
      });
      const res = await receive(world, w.id, c, [line(rice.id, 2)]).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      expect(res.body.refusedReceipt.rejectedLines).toEqual([
        expect.objectContaining({
          code: 'licence-not-covered',
          missing: [
            { need: 'fssai', holder: 'client', siteCode: 'EM-W1' },
            { need: 'fssai', holder: 'site', siteCode: 'EM-W1' },
          ],
        }),
      ]);
    });
  });

  // ── receipts ───────────────────────────────────────────────────────────────

  describe('receipts (enforcement on)', () => {
    let world: World;
    /** FSSAI + Form 20B site licences, valid all through the matrix. */
    let covered: { id: string; bin: string };
    /** No site licence at all. */
    let bare: { id: string; bin: string };
    let w2: { id: string; bin: string };
    /** C holds FSSAI + Form 20B for no site (head office), valid all through. */
    let c: string;
    let rice: { id: string; code: string };
    let shirt: { id: string; code: string };

    beforeAll(async () => {
      world = await newWorld('receipts');
      covered = await site(world, 'RC-COV');
      bare = await site(world, 'RC-BARE');
      w2 = await site(world, 'RC-W2');
      c = await createClient(world, 'RCC');
      await addLicence(world, fssai({ warehouseId: covered.id }));
      await addLicence(world, { warehouseId: covered.id, kind: 'drug-20b', number: drugNumber(), ...WIDE });
      await addLicence(world, fssai({ clientId: c }));
      await addLicence(world, { clientId: c, kind: 'drug-20b', number: drugNumber(), ...WIDE });
      rice = await createSku(world, c, 'RICE', { foodCategory: 'bakery-cereals' });
      shirt = await createSku(world, c, 'TSHIRT');
      await enforce(world, true);
    });

    it('Covered: C and the site hold a valid FSSAI — the rice books', async () => {
      const res = await receive(world, covered.id, c, [line(rice.id, 3)]).expect(201);
      expect(res.body.goodsReceipt.lines).toEqual([expect.objectContaining({ skuId: rice.id, appliedQty: 3 })]);
      expect(res.body.goodsReceipt.rejectedLines).toBeUndefined();
      expect(res.body.goodsReceipt.licenceReviewOpId).toBeUndefined();
    });

    it('Partly covered SKU: an H + NDPS SKU where both hold drug-20b and neither ndps — refused for ndps, client and site', async () => {
      const drug = await createSku(world, c, 'HNDPS', { drugSchedules: ['H', 'NDPS'] });
      const res = await receive(world, covered.id, c, [line(drug.id, 1)]).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      const [refused] = res.body.refusedReceipt.rejectedLines as RejectedLine[];
      expect(refused).toEqual({
        poLineId: null,
        skuId: drug.id,
        qty: 1,
        code: 'licence-not-covered',
        reason: `SKU "${drug.code}" needs an NDPS licence (client); needs an NDPS licence (site "RC-COV")`,
        index: 0,
        missing: [
          { need: 'ndps', holder: 'client', siteCode: 'RC-COV' },
          { need: 'ndps', holder: 'site', siteCode: 'RC-COV' },
        ],
      });
    });

    it('Site missing + Mixed receipt: rice (C covered, the site not) is refused into grn.licence-refused; the t-shirt books', async () => {
      const key = ulid();
      const res = await receive(world, bare.id, c, [line(shirt.id, 2), line(rice.id, 5)], RECEIPT_AT, key).expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt;
      expect(grn.lines).toEqual([expect.objectContaining({ skuId: shirt.id, appliedQty: 2 })]);
      expect(grn.rejectedLines).toEqual([
        expect.objectContaining({ skuId: rice.id, qty: 5, code: 'licence-not-covered', index: 1, missing: [{ need: 'fssai', holder: 'site', siteCode: 'RC-BARE' }] }),
      ]);
      expect(grn.licenceReviewOpId).toBe(licenceRefusedOpId(key));
      expect(grn.reviewOpId).toBeUndefined();
      const row = await rejectedOp(world, grn.licenceReviewOpId!);
      expect(row).toMatchObject({ opType: 'grn.licence-refused', problemCode: 'licence-not-covered', decisions: ['apply', 'discard'], status: 'open' });
      expect(row.problemDetail).toContain(`SKU "${rice.code}" needs an FSSAI licence (site "RC-BARE")`);
      expect(row.payload).toMatchObject({
        warehouseId: bare.id,
        poId: null,
        blindReasonCode: 'other',
        clientId: c,
        occurredAt: RECEIPT_AT,
        grnId: grn.id,
        lines: [{ poLineId: null, skuId: rice.id, batchCode: null, mfgDate: null, qty: 5 }],
        refusals: [expect.objectContaining({ lineIndex: 1, skuId: rice.id, skuClientId: c, reason: 'licence-not-covered', missing: [{ need: 'fssai', holder: 'site', siteCode: 'RC-BARE' }] })],
      });
      expect(row.payload).not.toHaveProperty('waivers');
    });

    it('a PO receipt with the refused line FIRST: the refusal names request index 0, the settling line index 1 (the settling-index remap)', async () => {
      const vendorId = await createLinkedVendor(app, world.tenantId, world.ownerToken, { code: `V-${ulid().slice(20)}`, name: 'Remap Vendor', clientIds: [c] });
      const po = await http()
        .post(`${API}/${world.tenantId}/inbound/purchase-orders`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: bare.id, vendorId, code: `PO-${ulid().slice(14)}`, lines: [{ skuId: rice.id, orderedQty: 10, unitCostPaise: 100 }] })
        .expect(201);
      const poId = po.body.purchaseOrder.id as string;
      const riceLineId = po.body.purchaseOrder.lines[0].id as string;
      const res = await http()
        .post(`${API}/${world.tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${world.operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId: bare.id,
          occurredAt: RECEIPT_AT,
          poId,
          blindReasonCode: null,
          // index 0: rice, uncovered at the bare site; index 1: the t-shirt, no line reference.
          lines: [line(rice.id, 3, { poLineId: riceLineId }), line(shirt.id, 2)],
        })
        .expect(201);
      const grn = res.body.goodsReceipt as GoodsReceipt & { unmatchedLines?: { index: number; reason: string }[] };
      expect(grn.rejectedLines).toEqual([expect.objectContaining({ code: 'licence-not-covered', index: 0, poLineId: riceLineId })]);
      expect(grn.unmatchedLines).toEqual([{ index: 1, reason: 'no-line-reference' }]);
      expect(grn.lines).toEqual([expect.objectContaining({ skuId: shirt.id, appliedQty: 2 })]);
    });

    it('Client premises: C2’s FSSAI is for another site only — refused for the client', async () => {
      const c2 = await createClient(world, 'RCP');
      await addLicence(world, fssai({ clientId: c2, warehouseId: w2.id }));
      const food = await createSku(world, c2, 'DAL', { foodCategory: 'bakery-cereals' });
      const res = await receive(world, covered.id, c2, [line(food.id, 1)]).expect(201);
      expect(res.body.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'licence-not-covered', missing: [{ need: 'fssai', holder: 'client', siteCode: 'RC-COV' }] });
    });

    it('Expired / future: a client licence until 2026-10-31, or from 2026-11-02, does not cover 2026-11-01', async () => {
      for (const [code, dates] of [
        ['RCX', { validFrom: '2026-01-01', validUntil: '2026-10-31' }],
        ['RCF', { validFrom: '2026-11-02', validUntil: '2027-11-01' }],
      ] as const) {
        const client = await createClient(world, code);
        await addLicence(world, fssai({ clientId: client }, dates));
        const food = await createSku(world, client, code, { foodCategory: 'dairy' });
        const res = await receive(world, covered.id, client, [line(food.id, 1)]).expect(201);
        expect(res.body.refusedReceipt.rejectedLines[0]).toMatchObject({ code: 'licence-not-covered', missing: [{ need: 'fssai', holder: 'client', siteCode: 'RC-COV' }] });
      }
    });

    it('Late replay: scanned 2026-10-30 while licensed (expired 2026-10-31), synced later — booked (judged on the scan date)', async () => {
      const client = await createClient(world, 'RCL');
      await addLicence(world, fssai({ clientId: client }, { validFrom: '2026-01-01', validUntil: '2026-10-31' }));
      const food = await createSku(world, client, 'LATE', { foodCategory: 'dairy' });
      const res = await receive(world, covered.id, client, [line(food.id, 2)], at('2026-10-30')).expect(201);
      expect(res.body.goodsReceipt.lines).toEqual([expect.objectContaining({ skuId: food.id, appliedQty: 2 })]);
    });

    it('Before validFrom: scanned 2026-10-30 against a licence from 2026-10-31 — refused, waivable', async () => {
      const client = await createClient(world, 'RCB');
      await addLicence(world, fssai({ clientId: client }, { validFrom: '2026-10-31', validUntil: '2027-10-31' }));
      const food = await createSku(world, client, 'EARLY', { foodCategory: 'dairy' });
      const res = await receive(world, covered.id, client, [line(food.id, 2)], at('2026-10-30')).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      const row = await rejectedOp(world, res.body.refusedReceipt.licenceReviewOpId as string);
      expect(row.decisions).toEqual(['apply', 'discard']);
    });

    it('Catch-weight line: an uncovered catch-weight food line with bad weights fails the whole op on shape (400), as today', async () => {
      const meat = await createSku(world, c, 'MEAT', { foodCategory: 'meat-poultry-seafood', catchWeightTracked: true });
      const res = await receive(world, bare.id, c, [line(shirt.id, 1), line(meat.id, 2)]);
      expectProblem(res, 400, 'validation-failed');
      expect(res.body.detail).toContain('catch-weight tracked');
    });

    it('Self: the tenant’s own food at a site holding FSSAI books (no client licence needed)', async () => {
      const ownFood = await createSku(world, world.selfClientId, 'OWN', { foodCategory: 'beverages' });
      const res = await receive(world, covered.id, world.selfClientId, [line(ownFood.id, 2)]).expect(201);
      expect(res.body.goodsReceipt.lines).toEqual([expect.objectContaining({ skuId: ownFood.id, appliedQty: 2 })]);
    });

    it('All refused: only rice into the bare site — goodsReceipt null, refusedReceipt.licenceReviewOpId, no other row', async () => {
      const key = ulid();
      const res = await receive(world, bare.id, c, [line(rice.id, 1)], RECEIPT_AT, key).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      expect(res.body.refusedReceipt).toMatchObject({ clientId: c, licenceReviewOpId: licenceRefusedOpId(key) });
      expect(res.body.refusedReceipt.reviewOpId).toBeUndefined();
      expect(res.body.refusedReceipt.shelfLifeReviewOpId).toBeUndefined();
      // The audit row targets the review row (nothing else was written).
      const row = await rejectedOp(world, licenceRefusedOpId(key));
      await expectAuditRow({
        tenantId: world.tenantId,
        key,
        action: 'goods_receipt.submitted',
        targetType: 'rejected_op',
        targetId: row.id,
        actorUserId: world.operatorUserId,
      });
    });

    it('the handheld cannot upload a grn.licence-refused row (server-raised only)', async () => {
      const res = await http()
        .post(`${API}/${world.tenantId}/devices/sync-reports`)
        .set('Authorization', `Bearer ${world.operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          rows: [
            {
              opId: ulid(),
              opType: 'grn.licence-refused',
              classification: 'rejected',
              problemCode: 'licence-not-covered',
              problemDetail: null,
              payload: { warehouseId: bare.id, poId: null, asnId: null, blindReasonCode: 'other', lines: [], refusals: [] },
              attribution: { deviceLabel: 'dock', operatorEmail: 'floor@example.com' },
              opEnqueuedAt: RECEIPT_AT,
              opOccurredAt: null,
            },
          ],
        });
      expectProblem(res, 400, 'validation-failed');
      expect(res.body.detail).toContain('opType "grn.licence-refused" is not a reviewable op type');
    });

    describe('the review row', () => {
      async function refusedRow(qty: number): Promise<{ id: string; opId: string }> {
        const res = await receive(world, bare.id, c, [line(rice.id, qty)]).expect(201);
        const opId = res.body.refusedReceipt.licenceReviewOpId as string;
        return { id: (await rejectedOp(world, opId)).id, opId };
      }

      it('Waiver, ops: an ops manager’s Apply is 403 role-denied — with or without a note — and the row stays open', async () => {
        const row = await refusedRow(1);
        const noNote = await resolveRow(world, row.id, { decision: 'apply' }, world.opsToken);
        expectProblem(noNote, 403, 'role-denied');
        expect(noNote.body.detail).toBe('Accepting goods without a valid licence is an owner decision.');
        const withNote = await resolveRow(world, row.id, { decision: 'apply', note: 'please' }, world.opsToken);
        expectProblem(withNote, 403, 'role-denied');
        expect(withNote.body.detail).toBe('Accepting goods without a valid licence is an owner decision.');
        expect((await rejectedOp(world, row.opId)).status).toBe('open');
      });

      it('Waiver, no note: an owner’s Apply without a note is 400 and the row stays open', async () => {
        const row = await refusedRow(1);
        const res = await resolveRow(world, row.id, { decision: 'apply' });
        expectProblem(res, 400, 'validation-failed');
        expect(res.body.detail).toContain('note');
        expectProblem(await resolveRow(world, row.id, { decision: 'recount', note: 'x' }), 409, 'decision-not-available');
        expect((await rejectedOp(world, row.opId)).status).toBe('open');
      });

      it('Waiver + Waiver retry: an owner’s Apply with a note books the lines, audited goods_receipt.licence_waived; the same Apply again leaves one GRN', async () => {
        const before = await grnCount(world, rice.id);
        const row = await refusedRow(7);
        const resolveKey = ulid();
        const applied = await resolveRow(world, row.id, { decision: 'apply', note: 'FSSAI renewal filed, client confirmed' }, world.ownerToken, resolveKey).expect(200);
        expect(applied.body.rejectedOp.status).toBe('applied');
        const snapshot = (applied.body.outcome as { snapshot: { goodsReceipt: GoodsReceipt } }).snapshot.goodsReceipt;
        expect(snapshot.lines).toEqual([expect.objectContaining({ skuId: rice.id, qty: 7, appliedQty: 7 })]);
        expect(snapshot.rejectedLines).toBeUndefined();
        await expectAuditRow({
          tenantId: world.tenantId,
          key: row.opId,
          action: 'goods_receipt.licence_waived',
          targetType: 'goods_receipt',
          targetId: snapshot.id,
          actorUserId: world.ownerUserId,
          alongside: [{ action: 'goods_receipt.submitted', targetType: 'goods_receipt', targetId: snapshot.id, actorUserId: world.operatorUserId }],
        });
        // The same Apply again (same key) replays; a re-run under the row's op id by
        // another owner with another note replays too (only the waiver's FACT is hashed).
        const again = await resolveRow(world, row.id, { decision: 'apply', note: 'FSSAI renewal filed, client confirmed' }, world.ownerToken, resolveKey).expect(200);
        expect(again.body).toEqual(applied.body);
        const payload = (await rejectedOp(world, row.opId)).payload as { warehouseId: string; clientId: string; occurredAt: string; lines: never[] };
        const rerun = await app.get(ReceivingFacade).submitGoodsReceipt(
          {
            tenantId: world.tenantId,
            deviceId: world.deviceId,
            operatorUserId: world.operatorUserId,
            warehouseId: payload.warehouseId,
            poId: null,
            blindReasonCode: 'other',
            clientId: payload.clientId,
            occurredAt: payload.occurredAt,
            lines: payload.lines,
            licenceWaiver: { byUserId: uuidv7(), note: 'another owner' },
          },
          row.opId,
        );
        expect(rerun).toEqual((applied.body.outcome as { snapshot: unknown }).snapshot);
        expect(await grnCount(world, rice.id)).toBe(before + 1);
      });

      it('Apply while off: with enforcement off, an open licence row still needs the owner and a note; the owner’s Apply books', async () => {
        const row = await refusedRow(2);
        await enforce(world, false);
        try {
          expectProblem(await resolveRow(world, row.id, { decision: 'apply', note: 'x' }, world.opsToken), 403, 'role-denied');
          expectProblem(await resolveRow(world, row.id, { decision: 'apply' }), 400, 'validation-failed');
          const applied = await resolveRow(world, row.id, { decision: 'apply', note: 'enforcement paused; owner accepts' }).expect(200);
          expect(applied.body.rejectedOp.status).toBe('applied');
        } finally {
          await enforce(world, true);
        }
      });

      it('Discard: an ops manager discards the row — dropped, nothing booked', async () => {
        const before = await grnCount(world, rice.id);
        const row = await refusedRow(1);
        const res = await resolveRow(world, row.id, { decision: 'discard', note: 'returned to the vendor' }, world.opsToken).expect(200);
        expect(res.body.rejectedOp.status).toBe('discarded');
        expect(await grnCount(world, rice.id)).toBe(before);
      });

      it('Departed meanwhile: the client departs between the refusal and the Apply — it settles client-departed per line, no new licence row', async () => {
        const gone = await createClient(world, 'RCG');
        const food = await createSku(world, gone, 'GONE', { foodCategory: 'dairy' });
        const res = await receive(world, bare.id, gone, [line(food.id, 1)]).expect(201);
        const row = await rejectedOp(world, res.body.refusedReceipt.licenceReviewOpId as string);
        const licenceRows = await rowsOfType(world, 'grn.licence-refused');
        // (The open row blocks a departure through the API — the wind-down rule —
        // so the race is staged on the row.)
        await sql`update clients set status = 'departed' where id = ${gone}`;
        try {
          const applied = await resolveRow(world, row.id, { decision: 'apply', note: 'accept anyway' }).expect(200);
          const outcome = (applied.body.outcome as { snapshot: { goodsReceipt: null; refusedReceipt: { rejectedLines: RejectedLine[] } } }).snapshot;
          expect(outcome.goodsReceipt).toBeNull();
          expect(outcome.refusedReceipt.rejectedLines.map((l) => l.code)).toEqual(['client-departed']);
          expect(await rowsOfType(world, 'grn.licence-refused')).toBe(licenceRows);
        } finally {
          await sql`update clients set status = 'active' where id = ${gone}`;
        }
      });
    });

    describe('Shelf-life first, then the licence — no loop', () => {
      it('a CARRIED shelf-life waiver is not audited twice: two owners, a partly booked first re-run — one shelf_life_waived (the first owner), one licence_waived (the second)', async () => {
        const email = `owner2-${ulid().toLowerCase()}@example.com`;
        const invited = await http()
          .post(`${API}/${world.tenantId}/users`)
          .set('Authorization', `Bearer ${world.ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ email, role: 'owner' })
          .expect(201);
        await http()
          .post(`${API}/${world.tenantId}/accept-invite`)
          .set(KEY_HEADER, ulid())
          .send({ token: invited.body.inviteToken as string, password: PASSWORD })
          .expect(200);
        const second = (await mintSignIn(app, { email, password: PASSWORD })).body as { accessToken: string; user: { id: string } };

        const client = await createClient(world, 'RCW');
        await http()
          .put(`${API}/${world.tenantId}/clients/${client}/receiving-policy`)
          .set('Authorization', `Bearer ${world.ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: true, minShelfLifeDays: 90 })
          .expect(200);
        await addLicence(world, fssai({ clientId: client }));
        // Both short-dated; only the cheese needs a licence (the bare site holds none).
        const soap = await createSku(world, client, 'SOAPB', { batchTracked: true });
        const cheese = await createSku(world, client, 'CHEESE', { foodCategory: 'dairy', batchTracked: true });
        const key = ulid();
        await receive(
          world,
          bare.id,
          client,
          [line(soap.id, 2, { batchCode: 'S-1', expiryDate: '2026-12-01' }), line(cheese.id, 3, { batchCode: 'C-1', expiryDate: '2026-12-01' })],
          RECEIPT_AT,
          key,
        ).expect(201);
        const shelfOpId = shelfLifeRefusedOpId(key);
        const shelfRow = await rejectedOp(world, shelfOpId);
        const first = await resolveRow(world, shelfRow.id, { decision: 'apply', note: 'first owner accepts the dates' }).expect(200);
        const firstGrn = (first.body.outcome as { snapshot: { goodsReceipt: GoodsReceipt } }).snapshot.goodsReceipt;
        expect(firstGrn.lines).toEqual([expect.objectContaining({ skuId: soap.id, appliedQty: 2 })]);
        const licenceOpId = firstGrn.licenceReviewOpId!;
        expect(licenceOpId).toBe(licenceRefusedOpId(shelfOpId));

        const licenceRow = await rejectedOp(world, licenceOpId);
        const secondApply = await resolveRow(world, licenceRow.id, { decision: 'apply', note: 'second owner waives the licence' }, second.accessToken).expect(200);
        const secondGrn = (secondApply.body.outcome as { snapshot: { goodsReceipt: GoodsReceipt } }).snapshot.goodsReceipt;
        expect(secondGrn.lines).toEqual([expect.objectContaining({ skuId: cheese.id, appliedQty: 3 })]);

        const waivers = (await sql`
          select action, actor_user_id, target_id from audit_events
           where tenant_id = ${world.tenantId} and reference in (${shelfOpId}, ${licenceOpId})
             and action in ('goods_receipt.shelf_life_waived', 'goods_receipt.licence_waived')
           order by action`) as unknown as { action: string; actor_user_id: string; target_id: string }[];
        expect(waivers).toEqual([
          { action: 'goods_receipt.licence_waived', actor_user_id: second.user.id, target_id: secondGrn.id },
          { action: 'goods_receipt.shelf_life_waived', actor_user_id: world.ownerUserId, target_id: firstGrn.id },
        ]);
        await expectAuditRow({
          tenantId: world.tenantId,
          key: licenceOpId,
          action: 'goods_receipt.licence_waived',
          targetType: 'goods_receipt',
          targetId: secondGrn.id,
          actorUserId: second.user.id,
          alongside: [{ action: 'goods_receipt.submitted', targetType: 'goods_receipt', targetId: secondGrn.id, actorUserId: world.operatorUserId }],
        });
      });

      it('a short-dated, uncovered line: the shelf-life row only; its Apply raises a licence row storing the waiver; that Apply books once', async () => {
        const client = await createClient(world, 'RCS');
        await http()
          .put(`${API}/${world.tenantId}/clients/${client}/receiving-policy`)
          .set('Authorization', `Bearer ${world.ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ receivingToleranceBps: 0, qcOnReceipt: false, expiryRequired: true, minShelfLifeDays: 90 })
          .expect(200);
        await addLicence(world, fssai({ clientId: client }));
        const milk = await createSku(world, client, 'MILK', { foodCategory: 'dairy', batchTracked: true });
        const key = ulid();
        const res = await receive(world, bare.id, client, [line(milk.id, 4, { batchCode: 'B-SHORT', expiryDate: '2026-12-01' })], RECEIPT_AT, key).expect(201);
        expect(res.body.goodsReceipt).toBeNull();
        expect(res.body.refusedReceipt.rejectedLines.map((l: RejectedLine) => l.code)).toEqual(['shelf-life-short']);
        expect(res.body.refusedReceipt.shelfLifeReviewOpId).toBe(shelfLifeRefusedOpId(key));
        expect(res.body.refusedReceipt.licenceReviewOpId).toBeUndefined();

        const shelfRow = await rejectedOp(world, shelfLifeRefusedOpId(key));
        const shelfApplied = await resolveRow(world, shelfRow.id, { decision: 'apply', note: 'client accepts short date' }).expect(200);
        const rerun = (shelfApplied.body.outcome as { snapshot: { goodsReceipt: null; refusedReceipt: { rejectedLines: RejectedLine[]; licenceReviewOpId: string } } }).snapshot;
        expect(rerun.goodsReceipt).toBeNull();
        expect(rerun.refusedReceipt.rejectedLines.map((l) => l.code)).toEqual(['licence-not-covered']);
        const licenceOpId = rerun.refusedReceipt.licenceReviewOpId;
        expect(licenceOpId).toBe(licenceRefusedOpId(shelfLifeRefusedOpId(key)));
        const licenceRow = await rejectedOp(world, licenceOpId);
        expect(licenceRow.payload.waivers).toEqual({ shelfLife: { byUserId: world.ownerUserId, note: 'client accepts short date' } });

        const shelfRows = await rowsOfType(world, 'grn.shelf-life-refused');
        const applied = await resolveRow(world, licenceRow.id, { decision: 'apply', note: 'licence renewal in hand' }).expect(200);
        const booked = (applied.body.outcome as { snapshot: { goodsReceipt: GoodsReceipt } }).snapshot.goodsReceipt;
        expect(booked.lines).toEqual([expect.objectContaining({ skuId: milk.id, qty: 4, appliedQty: 4 })]);
        expect(booked.rejectedLines).toBeUndefined();
        expect(await grnCount(world, milk.id)).toBe(1);
        expect(await rowsOfType(world, 'grn.shelf-life-refused')).toBe(shelfRows);
        await expectAuditRow({
          tenantId: world.tenantId,
          key: licenceOpId,
          action: 'goods_receipt.licence_waived',
          targetType: 'goods_receipt',
          targetId: booked.id,
          actorUserId: world.ownerUserId,
          // The carried shelf-life waiver writes no second row (it was granted on the first re-run).
          alongside: [{ action: 'goods_receipt.submitted', targetType: 'goods_receipt', targetId: booked.id, actorUserId: world.operatorUserId }],
        });
      });
    });
  });

  // ── orders ─────────────────────────────────────────────────────────────────

  describe('orders (enforcement on)', () => {
    let world: World;
    /** FSSAI site licence only — no drug licence. */
    let w1: { id: string; bin: string };
    let c: string;
    let rice: { id: string; code: string };

    beforeAll(async () => {
      world = await newWorld('orders');
      w1 = await site(world, 'OR-W1');
      c = await createClient(world, 'ORC');
      await addLicence(world, fssai({ warehouseId: w1.id }));
      await addLicence(world, fssai({ clientId: c }));
      rice = await createSku(world, c, 'RICE', { foodCategory: 'bakery-cereals' });
      await stock(world, w1.id, w1.bin, rice.id, 10);
      await enforce(world, true);
    });

    it('Self order: the tenant’s own food at a site holding FSSAI, no client licence — created', async () => {
      const ownFood = await createSku(world, world.selfClientId, 'OWNTEA', { foodCategory: 'beverages' });
      await stock(world, w1.id, w1.bin, ownFood.id, 3);
      const res = await createOrder(world, w1.id, [{ skuId: ownFood.id, quantity: 1 }]).expect(201);
      expect(res.body.order.status).toBe('accepted');
    });

    it('a covered order is created', async () => {
      const res = await createOrder(world, w1.id, [{ skuId: rice.id, quantity: 1 }]).expect(201);
      expect(res.body.order.status).toBe('accepted');
    });

    it('Order: an H drug where the site lacks drug-20b — 409 licence-not-covered naming SKU, need and holder; nothing created, no grants left', async () => {
      const drug = await createSku(world, c, 'PARA', { drugSchedules: ['H'] });
      await stock(world, w1.id, w1.bin, drug.id, 5);
      const res = await createOrder(world, w1.id, [{ skuId: drug.id, quantity: 1 }]);
      expectProblem(res, 409, 'licence-not-covered');
      expect(res.body.detail).toContain(`${drug.code} — needs a Form 20B licence (client); ${drug.code} — needs a Form 20B licence (site "OR-W1")`);
      expect(res.body.skuCodes).toEqual([drug.code]);
      expect(await liveHolds(world, drug.id)).toBe(0);
      expect(await sql`select 1 from order_lines where tenant_id = ${world.tenantId} and sku_id = ${drug.id}`).toHaveLength(0);
    });

    it('Order kit: a kit whose component is food of an uncovered client — 409', async () => {
      const c2 = await createClient(world, 'ORK');
      const food = await createSku(world, c2, 'OATS', { foodCategory: 'bakery-cereals' });
      const kit = await createSku(world, c2, 'HAMPER');
      await http()
        .post(`${API}/${world.tenantId}/catalog/skus/${kit.id}/kit`)
        .set('Authorization', `Bearer ${world.ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ components: [{ skuId: food.id, quantity: 1 }] })
        .expect(201);
      await stock(world, w1.id, w1.bin, food.id, 5);
      const res = await createOrder(world, w1.id, [{ skuId: kit.id, quantity: 1 }]);
      expectProblem(res, 409, 'licence-not-covered');
      expect(res.body.skuCodes).toEqual([food.code]);
      expect(await liveHolds(world, food.id)).toBe(0);
    });

    it('Mixed order: one covered line, one uncovered — the whole order is refused, no grants left', async () => {
      const c3 = await createClient(world, 'ORM');
      await addLicence(world, fssai({ clientId: c3 }));
      const ok = await createSku(world, c3, 'FLOUR', { foodCategory: 'bakery-cereals' });
      const drug = await createSku(world, c3, 'CODEINE', { drugSchedules: ['H1'] });
      await stock(world, w1.id, w1.bin, ok.id, 5);
      await stock(world, w1.id, w1.bin, drug.id, 5);
      const res = await createOrder(world, w1.id, [
        { skuId: ok.id, quantity: 2 },
        { skuId: drug.id, quantity: 1 },
      ]);
      expectProblem(res, 409, 'licence-not-covered');
      expect(res.body.skuCodes).toEqual([drug.code]);
      expect(await liveHolds(world, ok.id)).toBe(0);
      expect(await liveHolds(world, drug.id)).toBe(0);
    });

    it('Backordered line: an uncovered line with no stock anywhere is refused too', async () => {
      const c4 = await createClient(world, 'ORB');
      const food = await createSku(world, c4, 'GHEE', { foodCategory: 'dairy' });
      const res = await createOrder(world, w1.id, [{ skuId: food.id, quantity: 3 }]);
      expectProblem(res, 409, 'licence-not-covered');
      expect(res.body.detail).toContain(`${food.code} — needs an FSSAI licence (client)`);
    });

    it('the phase-3 re-check: goods attributes edited between phase 1 and phase 3 are caught, grants released', async () => {
      const plain = await createSku(world, c, 'SOAP');
      await stock(world, w1.id, w1.bin, plain.id, 5);
      // Phase 1 sees a plain SKU; during the grants (phase 2) it becomes a
      // Schedule X drug — only phase 3's locked re-read can refuse it.
      const inventory = app.get(InventoryFacade);
      const original = inventory.atp.bind(inventory);
      let flipped = false;
      const spy = jest.spyOn(inventory, 'atp').mockImplementation(async (...args: Parameters<InventoryFacade['atp']>) => {
        if (!flipped) {
          flipped = true;
          await sql`update skus set drug_schedules = '{X}' where id = ${plain.id}`;
        }
        return original(...args);
      });
      try {
        const res = await createOrder(world, w1.id, [{ skuId: plain.id, quantity: 1 }]);
        expect(flipped).toBe(true);
        expectProblem(res, 409, 'licence-not-covered');
        expect(res.body.detail).toContain(`${plain.code} — needs a Form 20G licence (client)`);
      } finally {
        spy.mockRestore();
      }
      expect(await liveHolds(world, plain.id)).toBe(0);
      expect(await sql`select 1 from order_lines where tenant_id = ${world.tenantId} and sku_id = ${plain.id}`).toHaveLength(0);
    });

    describe('channel ingest', () => {
      it('Channel order: ingest of an uncovered order — typed 422 licence-not-covered, metered validation-failed, no order', async () => {
        const c5 = await createClient(world, 'ORX');
        const food = await createSku(world, c5, 'JAM', { foodCategory: 'ready-to-eat' });
        await stock(world, w1.id, w1.bin, food.id, 5);
        const connectionId = uuidv7();
        await sql`insert into integrations (id, tenant_id, provider, status, connected_by, ingest_warehouse_id)
          values (${connectionId}, ${world.tenantId}, 'shopify', 'connected', ${world.ownerUserId}, ${w1.id})`;
        await sql`insert into channel_mappings (id, tenant_id, integration_id, external_ref, sku_id)
          values (${uuidv7()}, ${world.tenantId}, ${connectionId}, 'SHOP-JAM', ${food.id})`;
        const orderRef = `CH-${ulid()}`;
        const ingest = app.get(ChannelsIngestCommand).ingestOrderDelivery({
          tenantId: world.tenantId,
          connectionId,
          parsed: { orderRef, destination: testAddress() as never, lines: [{ externalRef: 'SHOP-JAM', quantity: 1 }] },
        });
        await expect(ingest).rejects.toMatchObject({
          status: 422,
          response: expect.objectContaining({ code: 'licence-not-covered', extensions: { skuCodes: [food.code] } }),
        });
        const calls = await sql<{ status: string }[]>`select status from integration_calls where integration_id = ${connectionId}`;
        expect(calls.map((row) => row.status)).toEqual(['validation-failed']);
        expect(await sql`select 1 from orders where tenant_id = ${world.tenantId} and external_event_id = ${orderRef}`).toHaveLength(0);
        expect(await liveHolds(world, food.id)).toBe(0);
      });
    });
  });
});
