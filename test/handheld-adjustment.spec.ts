import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import type { StockAdjustmentCommand } from '../src/modules/inventory/inventory.command';
import { ADJUSTMENT_REASON_CODES, ADJUSTMENT_REASON_LABELS } from '../src/modules/inventory/adjustment-reason';
import { ADJUSTMENT_PEND_REASONS } from '../src/shared/db/schema';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { AdjustmentSubmission, normalizeArms } from '../src/modules/tenancy/adjustment-submission';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, seededIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

const PLAIN = 'HA-PLAIN';
const BATCH = 'HA-BATCH';
const SERIAL = 'HA-SER';
const SKU_CODES = [PLAIN, BATCH, SERIAL] as const;

/**
 * Story 3-2b — the handheld stock adjustment: the device arm on
 * `POST …/inventory/adjustments`, the `stock.adjust.request` forced pend,
 * the stored `pendReason`/`source_device_id` (0090), the fingerprint goldens
 * (web byte-identical, device discriminated), the review queue's `stock.adjust`
 * Apply through the one submission path, and the snapshot's `adjustReasons`.
 */
describe('handheld stock adjustment (e2e, story 3-2b)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;

  let tenantId = '';
  let ownerToken = '';
  let opsToken = '';
  let opsUserId = '';
  let operatorToken = '';
  let operatorUserId = '';
  let operatorEmail = '';
  let opsEmail = '';
  let deviceId = ''; // the operator's handheld
  let deviceToken = ''; // its badge-in session (the operator)
  let bareDeviceToken = '';
  let managerDeviceId = '';
  let managerDeviceToken = ''; // a second handheld, the ops manager badged in
  let warehouseId = '';
  const skuIds = new Map<string, string>();
  const binIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const sku = (code: string): string => skuIds.get(code)!;
  const bin = (code: string): string => binIds.get(code)!;

  async function enrollAndBadgeIn(label: string, email: string): Promise<{ deviceId: string; bare: string; token: string }> {
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label, pin: '2468' })
      .expect(201);
    const token = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;
    return { deviceId: enrolled.body.device.id as string, bare: enrolled.body.deviceToken as string, token };
  }

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('handheld_adjustment');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

    const ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Handheld Adjust Co ${ulid()}`, ownerEmail, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email: ownerEmail, password: PASSWORD })).body.accessToken as string;

    warehouseId = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `HA-${ulid().slice(10, 16)}`, name: 'Handheld WH' })
        .expect(201)
    ).body.id as string;

    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode',
      `${PLAIN},Adjust Plain,pcs,,1800,,false,false,false,,,`,
      `${BATCH},Adjust Batch,pcs,,1800,,true,false,false,,,`,
      `${SERIAL},Adjust Serial,pcs,,1800,,false,true,false,,,`,
    ].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const skus = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) {
      if ((SKU_CODES as readonly string[]).includes(item.code)) skuIds.set(item.code, item.id);
    }
    expect(skuIds.size).toBe(SKU_CODES.length);

    const zoneId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Zone A' })
        .expect(201)
    ).body.id as string;
    for (const code of ['A-01', 'A-02', 'A-03', 'A-04', 'A-05']) {
      binIds.set(
        code,
        (
          await http()
            .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ capacity: 1000, type: 'shelf', code })
            .expect(201)
        ).body.id as string,
      );
    }

    const mkMember = async (role: 'ops_manager' | 'operator'): Promise<{ userId: string; email: string; token: string }> => {
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
      const token = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
      return { userId: invited.body.user.id as string, email, token };
    };
    const ops = await mkMember('ops_manager');
    opsToken = ops.token;
    opsUserId = ops.userId;
    opsEmail = ops.email;
    const operator = await mkMember('operator');
    operatorToken = operator.token;
    operatorUserId = operator.userId;
    operatorEmail = operator.email;

    const handheld = await enrollAndBadgeIn('adjust-suite handheld', operatorEmail);
    deviceId = handheld.deviceId;
    deviceToken = handheld.token;
    bareDeviceToken = handheld.bare;
    const managerHandheld = await enrollAndBadgeIn('adjust-suite manager handheld', opsEmail);
    managerDeviceId = managerHandheld.deviceId;
    managerDeviceToken = managerHandheld.token;

    // Stock, seeded by the ops manager on the web BEFORE the policy exists.
    await webAdjust(opsToken, { skuId: sku(PLAIN), binId: bin('A-01'), quantityDelta: 40, reasonCode: 'stock-count', note: 'seed' }).expect(201);
    const day = 24 * 3600 * 1000;
    await webAdjust(opsToken, {
      skuId: sku(BATCH),
      binId: bin('A-02'),
      quantityDelta: 5,
      reasonCode: 'stock-count',
      note: 'seed old lot',
      batch: { code: 'OLD', expiryDate: new Date(Date.now() + 30 * day).toISOString() },
    }).expect(201);
    await webAdjust(opsToken, {
      skuId: sku(BATCH),
      binId: bin('A-02'),
      quantityDelta: 5,
      reasonCode: 'stock-count',
      note: 'seed new lot',
      batch: { code: 'NEW', expiryDate: new Date(Date.now() + 300 * day).toISOString() },
    }).expect(201);
    await webAdjust(opsToken, { skuId: sku(SERIAL), binId: bin('A-03'), quantityDelta: 2, reasonCode: 'stock-count', note: 'seed', serials: ['SN-1', 'SN-2'] }).expect(201);

    // The owner's threshold: 10.
    await http()
      .put(`${API}/${tenantId}/inventory/adjustment-policies`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ quantityThreshold: 10 })
      .expect(200);
  }, 180_000);

  afterAll(async () => {
    const rawDb = app?.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
    await rawDb?.$client?.end();
    const authDb = app?.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
    await authDb?.$client?.end();
    await sql?.end();
    await app?.close();
    await suiteDb?.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  function webAdjust(token: string, body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, ...body });
  }

  /** The handheld's request body: the device sends explicit nulls for absent arms. */
  function deviceBody(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      warehouseId,
      skuId: sku(PLAIN),
      binId: bin('A-01'),
      reasonCode: 'damaged',
      note: 'crushed on the shelf',
      batch: null,
      serials: null,
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      ...extra,
    };
  }

  function deviceAdjust(body: Record<string, unknown>, token = deviceToken, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  async function count(table: string, where: string, params: unknown[] = []): Promise<number> {
    const rows = await sql.unsafe(`select count(*)::int as n from ${table} where tenant_id = $1 ${where}`, [tenantId, ...params] as never[]);
    return (rows[0] as unknown as { n: number }).n;
  }

  async function pendRow(id: string): Promise<Record<string, unknown>> {
    return (await sql`select * from stock_adjustment_pendings where tenant_id = ${tenantId} and id = ${id}`)[0] as Record<string, unknown>;
  }

  async function storedHash(key: string): Promise<string> {
    return (await sql<{ payload_hash: string }[]>`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.payload_hash;
  }

  // ── A8: golden first ───────────────────────────────────────────────────────

  it('A8: the web fingerprints of the 3-2a request shapes equal the goldens captured from origin/main before 3-2b', () => {
    // Captured with the PRE-3-2b `fingerprint()` (origin/main, 2026-10-23) over
    // these exact commands — the web hash must stay byte-identical.
    const T = '01900000-0000-7000-8000-0000000000a1';
    const base = {
      tenantId: T,
      actorUserId: '01900000-0000-7000-8000-0000000000e1',
      warehouseId: '01900000-0000-7000-8000-0000000000b1',
      skuId: '01900000-0000-7000-8000-0000000000c1',
      binId: '01900000-0000-7000-8000-0000000000d1',
    };
    const fixtures: Record<string, [Parameters<StockAdjustmentCommand['fingerprint']>[0], string]> = {
      'add, untracked': [{ ...base, quantityDelta: 3, reasonCode: 'found', note: 'three extra on the shelf' }, '975138beb7a5b0f7b64b49c0293e0cadea740fd8d02332550a62bae19af99e3e'],
      'remove, FEFO': [{ ...base, quantityDelta: -2, reasonCode: 'damaged', note: 'crushed' }, '77535b8640fafd0ce34b657674a484e14298135e1518230fcdce1b761f8ad3cd'],
      'remove, override': [
        { ...base, quantityDelta: -2, reasonCode: 'expired', note: 'L2 expired', batch: { code: 'L2', overrideReason: 'expired lot' } },
        '5996d9a318d72dbd904b4d3f9b2b41669fe671e26cfc642e9a13cca0da046ca1',
      ],
      'add, new batch': [
        { ...base, quantityDelta: 4, reasonCode: 'found', note: 'new lot', batch: { code: 'L9', mfgDate: '2026-01-31T18:30:00.000Z', expiryDate: '2027-03-30T18:30:00.000Z' } },
        '4d8d97e18d42b31d6a94b56918b256a12e89acad2538ca00e9acc007171f1c15',
      ],
      'batch + serial remove': [
        { ...base, quantityDelta: -2, reasonCode: 'shrinkage', note: 'missing', batch: { code: 'L1', overrideReason: 'counted' }, serials: ['SN-1', 'SN-2'] },
        '25f843632c0a7108ed121e0bd778c6fe933f529c4bd194c3902a5185c0a944c7',
      ],
      fractional: [{ ...base, quantityDelta: -1.25, reasonCode: 'stock-count', note: 'recount' }, '96bbf5ff8f847744104031bf090e8e92d294792a9d02ddcaa63a67f880e295b4'],
    };
    const facade = app.get(InventoryFacade);
    for (const [name, [command, golden]] of Object.entries(fixtures)) {
      expect([name, facade.adjustmentFingerprint(command)]).toEqual([name, golden]);
      // An explicit null deviceId (the route's web arm) is the same web hash.
      expect([name, facade.adjustmentFingerprint({ ...command, deviceId: null })]).toEqual([name, golden]);
    }
  });

  it('code review: a web batch with an explicit overrideReason null keeps its pre-3-2b hash (golden from e3f881d); the handheld normalises it', () => {
    const base = {
      tenantId: '01900000-0000-7000-8000-0000000000a1',
      actorUserId: '01900000-0000-7000-8000-0000000000e1',
      warehouseId: '01900000-0000-7000-8000-0000000000b1',
      skuId: '01900000-0000-7000-8000-0000000000c1',
      binId: '01900000-0000-7000-8000-0000000000d1',
      quantityDelta: -2,
      reasonCode: 'expired',
      note: 'L2 expired',
    };
    const input = { batch: { code: 'L2', overrideReason: null } };
    const facade = app.get(InventoryFacade);
    // Captured by running the pre-3-2b controller's normalizeArms and
    // fingerprint (baseline e3f881de53cd7728c4ca43b25752de85063d610b).
    const golden = '9c42fe96a50b418e3fa86ff1b78ebb7c6a5eeebdb55c2e5ccba3e3373d8b2bad';
    expect(facade.adjustmentFingerprint({ ...base, batch: normalizeArms(input, false).batch })).toBe(golden);
    // On the handheld a null field is absent — a different (device-only) shape.
    expect(facade.adjustmentFingerprint({ ...base, batch: normalizeArms(input, true).batch })).not.toBe(golden);
  });

  it('A8: the stored hashes, key by key — the web shape unchanged, the device shape led by surface + deviceId', async () => {
    const webKey = ulid();
    await webAdjust(opsToken, { skuId: sku(PLAIN), binId: bin('A-04'), quantityDelta: 1, reasonCode: 'found', note: 'golden web' }, webKey).expect(201);
    expect(await storedHash(webKey)).toBe(
      hashCommandPayload({ tenantId, warehouseId, skuId: sku(PLAIN), binId: bin('A-04'), quantityDelta: 1, reasonCode: 'found', note: 'golden web' }),
    );

    const deviceKey = ulid();
    const occurredAt = '2026-10-22T08:30:00.000Z';
    await deviceAdjust(deviceBody({ binId: bin('A-04'), quantityDelta: 1, reasonCode: 'found', note: 'golden device', occurredAt }), managerDeviceToken, deviceKey).expect(201);
    expect(await storedHash(deviceKey)).toBe(
      hashCommandPayload({
        surface: 'device',
        deviceId: managerDeviceId,
        tenantId,
        warehouseId,
        skuId: sku(PLAIN),
        binId: bin('A-04'),
        quantityDelta: 1,
        reasonCode: 'found',
        note: 'golden device',
        occurredAt,
      }),
    );
  });

  // ── the matrix ─────────────────────────────────────────────────────────────

  it('operator, small: 202 approval-required, no ledger event, the pend row names the operator and the device; audited; device heartbeat', async () => {
    const key = ulid();
    const events = await count('ledger_events', '');
    await sql`update devices set last_seen_at = null where id = ${deviceId}`;
    const res = await deviceAdjust(deviceBody({ quantityDelta: -2 }), deviceToken, key).expect(202);
    expect(res.body.pendingAdjustment).toMatchObject({
      status: 'pending',
      quantityDelta: -2,
      requestedBy: operatorUserId,
      pendReason: 'approval-required',
      thresholdQuantityAtRequest: 10,
    });
    expect(await count('ledger_events', '')).toBe(events);
    const row = await pendRow(res.body.pendingAdjustment.id as string);
    expect(row).toMatchObject({ requested_by: operatorUserId, pend_reason: 'approval-required', source_device_id: deviceId, threshold_quantity_at_request: 10 });
    await expectAuditRow({
      tenantId,
      key,
      action: 'stock_adjustment.recorded',
      targetType: 'stock_adjustment_pending',
      targetId: res.body.pendingAdjustment.id as string,
      actorUserId: operatorUserId,
    });
    const seen = await sql<{ last_seen_at: string | null }[]>`select last_seen_at from devices where id = ${deviceId}`;
    expect(seen[0]!.last_seen_at).not.toBeNull();
  });

  it('replay: the exact device body under the same key re-serves the 202; a different body under it is 422', async () => {
    const key = ulid();
    const body = deviceBody({ quantityDelta: -1 });
    const first = await deviceAdjust(body, deviceToken, key).expect(202);
    const again = await deviceAdjust(body, deviceToken, key).expect(202);
    expect(again.body).toEqual(first.body);
    const reuse = await deviceAdjust({ ...body, note: 'another note' }, deviceToken, key).expect(422);
    expect(reuse.body.code).toBe('idempotency-key-reuse');
    expect(await count('stock_adjustment_pendings', 'and id = $2', [first.body.pendingAdjustment.id])).toBe(1);
  });

  it('operator, large: |delta| over the threshold pends with pendReason threshold', async () => {
    const res = await deviceAdjust(deviceBody({ quantityDelta: -15 })).expect(202);
    expect(res.body.pendingAdjustment).toMatchObject({ pendReason: 'threshold', thresholdQuantityAtRequest: 10, quantityDelta: -15 });
  });

  it('manager on a device, small: 201 applied, a stock.adjusted event whose actor is the badge-in manager', async () => {
    const key = ulid();
    await sql`update devices set last_seen_at = null where id = ${managerDeviceId}`;
    const res = await deviceAdjust(deviceBody({ binId: bin('A-05'), quantityDelta: 3, reasonCode: 'found', note: 'three found' }), managerDeviceToken, key).expect(201);
    expect(res.body.event).toMatchObject({ type: 'stock.adjusted', quantityDelta: 3 });
    const event = (await sql<{ actor_user_id: string }[]>`select actor_user_id from ledger_events where id = ${res.body.event.id as string}`)[0]!;
    expect(event.actor_user_id).toBe(opsUserId);
    await expectAuditRow({ tenantId, key, action: 'stock_adjustment.recorded', targetType: 'ledger_event', targetId: res.body.event.id as string, actorUserId: opsUserId });
    // The applied arm stamps the device heartbeat too.
    const seen = await sql<{ last_seen_at: string | null }[]>`select last_seen_at from devices where id = ${managerDeviceId}`;
    expect(seen[0]!.last_seen_at).not.toBeNull();
  });

  it('code review: the audit row\'s time — the business time on the web (as before 3-2b), the server clock on the handheld', async () => {
    const webKey = ulid();
    const businessTime = new Date(Date.now() - 2 * 3600_000).toISOString();
    const web = await webAdjust(opsToken, { skuId: sku(PLAIN), binId: bin('A-05'), quantityDelta: 1, reasonCode: 'found', note: 'web business time', occurredAt: businessTime }, webKey).expect(201);
    const webAudit = (await sql<{ occurred_at: Date }[]>`select occurred_at from audit_events where tenant_id = ${tenantId} and reference = ${webKey}`)[0]!;
    expect(new Date(webAudit.occurred_at).toISOString()).toBe(businessTime);
    expect(web.body.event.occurredAt).toBe(businessTime);

    const deviceKey = ulid();
    await deviceAdjust(deviceBody({ binId: bin('A-05'), quantityDelta: 1, reasonCode: 'found', note: 'device business time', occurredAt: businessTime }), managerDeviceToken, deviceKey).expect(201);
    const deviceAudit = (await sql<{ occurred_at: Date }[]>`select occurred_at from audit_events where tenant_id = ${tenantId} and reference = ${deviceKey}`)[0]!;
    expect(Math.abs(new Date(deviceAudit.occurred_at).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('code review: handlingUnitIds from a handheld are refused 400 (the review Apply could not carry them)', async () => {
    const res = await deviceAdjust(deviceBody({ quantityDelta: -1, handlingUnitIds: ['01900000-0000-7000-8000-00000000aa01'] }), managerDeviceToken).expect(400);
    expect(res.body.code).toBe('validation-failed');
    expect(res.body.detail).toMatch(/handling units/);
  });

  it('the handheld\'s explicit nulls inside the batch arm read as absent: a manager\'s batch Add applies with no dates', async () => {
    const res = await deviceAdjust(
      deviceBody({
        skuId: sku(BATCH),
        binId: bin('A-05'),
        quantityDelta: 2,
        reasonCode: 'found',
        note: 'found a lot',
        batch: { code: 'HH-LOT', mfgDate: null, expiryDate: null, overrideReason: null },
      }),
      managerDeviceToken,
    ).expect(201);
    expect(res.body.event.quantityDelta).toBe(2);
    const lot = (await sql<{ expiry_date: string | null }[]>`select expiry_date from batches where tenant_id = ${tenantId} and code = 'HH-LOT'`)[0]!;
    expect(lot.expiry_date).toBeNull();
  });

  it('no badge-in: a bare device enrollment credential is 401 unauthenticated — even without an Idempotency-Key', async () => {
    const res = await deviceAdjust(deviceBody({ quantityDelta: -1 }), bareDeviceToken).expect(401);
    expect(res.body.code).toBe('unauthenticated');
    const noKey = await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${bareDeviceToken}`)
      .send(deviceBody({ quantityDelta: -1 }))
      .expect(401);
    expect(noKey.body.code).toBe('unauthenticated');
  });

  it('operator mismatch: X-Op-Operator naming another user is 409 operator-mismatch', async () => {
    const res = await deviceAdjust(deviceBody({ quantityDelta: -1 })).set('X-Op-Operator', opsUserId).expect(409);
    expect(res.body.code).toBe('operator-mismatch');
  });

  it('no occurredAt on the device is 400; the web keeps it optional', async () => {
    const { occurredAt: _omit, ...noTime } = deviceBody({ quantityDelta: -1 });
    void _omit;
    const res = await deviceAdjust(noTime).expect(400);
    expect(res.body.detail).toMatch(/occurredAt is required on a handheld adjustment/);
    // The same request shape on a TRACKED SKU answers 400 before any identity is minted.
    const batches = await count('batches', '');
    const tracked = await deviceAdjust({ ...noTime, skuId: sku(BATCH), binId: bin('A-02'), quantityDelta: 1, batch: { code: 'NO-TIME' } }).expect(400);
    expect(tracked.body.detail).toMatch(/occurredAt is required/);
    expect(await count('batches', '')).toBe(batches);
  });

  it('FEFO remove on the handheld: no batch → the server resolves the oldest non-expired batch into the pend', async () => {
    const res = await deviceAdjust(deviceBody({ skuId: sku(BATCH), binId: bin('A-02'), quantityDelta: -1 })).expect(202);
    const old = (await sql<{ id: string }[]>`select id from batches where tenant_id = ${tenantId} and code = 'OLD'`)[0]!.id;
    expect(res.body.pendingAdjustment.batchId).toBe(old);
  });

  it('serial count: serials that do not match |quantityDelta| are 400', async () => {
    const res = await deviceAdjust(deviceBody({ skuId: sku(SERIAL), binId: bin('A-03'), quantityDelta: -2, serials: ['SN-1'] })).expect(400);
    expect(res.body.code).toBe('validation-failed');
  });

  it('A4: an applied adjustment re-served to a request-only holder is 403; a stored 202 replays to either', async () => {
    const appliedKey = ulid();
    const body = { skuId: sku(PLAIN), binId: bin('A-04'), quantityDelta: 1, reasonCode: 'found', note: 'a4 applied' };
    await webAdjust(opsToken, body, appliedKey).expect(201);
    // The web hash names no actor, so the operator presenting the same key and
    // body reaches the replay — and is refused on authority, never served.
    const denied = await webAdjust(operatorToken, body, appliedKey).expect(403);
    expect(denied.body.detail).toContain('stock.adjust');

    const pendKey = ulid();
    const pendBody = { skuId: sku(PLAIN), binId: bin('A-04'), quantityDelta: 1, reasonCode: 'found', note: 'a4 pend' };
    const pended = await webAdjust(operatorToken, pendBody, pendKey).expect(202);
    const replayed = await webAdjust(opsToken, pendBody, pendKey).expect(202);
    expect(replayed.body).toEqual(pended.body);
  });

  it('A4 on a batch-tracked SKU: an applied explicit-batch draw replayed by a request-only holder is 403 naming stock.adjust', async () => {
    const key = ulid();
    const body = { skuId: sku(BATCH), binId: bin('A-02'), quantityDelta: -1, reasonCode: 'damaged', note: 'a4 batch', batch: { code: 'NEW', overrideReason: 'the crushed lot' } };
    await webAdjust(opsToken, body, key).expect(201);
    const denied = await webAdjust(operatorToken, body, key).expect(403);
    expect(denied.body.code).toBe('role-denied');
    expect(denied.body.detail).toContain('stock.adjust');
  });

  it('A7: a 202 stored before 3-2b (no pendReason) replays with pendReason threshold', async () => {
    const key = seededIdempotencyKey(tenantId, ulid());
    const body = { skuId: sku(PLAIN), binId: bin('A-04'), quantityDelta: 50, reasonCode: 'found', note: 'legacy pend' };
    const hash = app.get(InventoryFacade).adjustmentFingerprint({ tenantId, actorUserId: opsUserId, warehouseId, ...body });
    const legacy = {
      pendingAdjustment: {
        id: '01900000-0000-7000-8000-00000000f001',
        tenantId,
        warehouseId,
        binId: body.binId,
        skuId: body.skuId,
        quantityDelta: 50,
        reasonCode: 'found',
        note: 'legacy pend',
        batchOverrideReason: null,
        batchId: null,
        serialIds: null,
        handlingUnitIds: null,
        occurredAt: '2026-10-01T00:00:00.000Z',
        requestedBy: opsUserId,
        requestedAt: '2026-10-01T00:00:00.000Z',
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        thresholdQuantityAtRequest: 10,
      },
    };
    await sql`insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
      values (gen_random_uuid(), ${tenantId}, ${key}, ${hash}, ${sql.json(legacy)})`;
    const res = await webAdjust(opsToken, body, key).expect(202);
    expect(res.body.pendingAdjustment).toEqual({ ...legacy.pendingAdjustment, pendReason: 'threshold' });
  });

  it('the pend queue carries pendReason and sourceDeviceId', async () => {
    const res = await deviceAdjust(deviceBody({ quantityDelta: -1, note: 'queue row' })).expect(202);
    const list = await http().get(`${API}/${tenantId}/inventory/adjustment-pendings?status=pending&limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const items = list.body.items as { id: string; pendReason: string; sourceDeviceId: string | null }[];
    expect(items.find((item) => item.id === res.body.pendingAdjustment.id)).toMatchObject({ pendReason: 'approval-required', sourceDeviceId: deviceId });
    // A web-raised (threshold) pend names no device.
    const web = await webAdjust(opsToken, { skuId: sku(PLAIN), binId: bin('A-04'), quantityDelta: 20, reasonCode: 'found', note: 'web over' }).expect(202);
    const again = await http().get(`${API}/${tenantId}/inventory/adjustment-pendings?status=pending&limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((again.body.items as typeof items).find((item) => item.id === web.body.pendingAdjustment.id)).toMatchObject({ pendReason: 'threshold', sourceDeviceId: null });
  });

  it('the owner approves an operator request: the ledger event posts under the owner, decided by the owner', async () => {
    const res = await deviceAdjust(deviceBody({ quantityDelta: -1, note: 'approve me' })).expect(202);
    const approved = await http()
      .post(`${API}/${tenantId}/inventory/adjustment-pendings/${res.body.pendingAdjustment.id as string}/approve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.events).toHaveLength(1);
  });

  it('AC: the live route and the review apply compose the same input into the same arms', async () => {
    // One input, driven twice: once live on the device route, once as a
    // rejected `stock.adjust` op applied from the review queue. Both are the
    // operator's (so both pend) — the pend rows' resolved arms must match.
    const occurredAt = new Date(Date.now() - 30_000).toISOString();
    const payload = deviceBody({ skuId: sku(BATCH), binId: bin('A-02'), quantityDelta: -1, reasonCode: 'damaged', note: 'parity', occurredAt });
    const live = await deviceAdjust(payload).expect(202);

    const opId = ulid();
    await http()
      .post(`${API}/${tenantId}/devices/sync-reports`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        rows: [
          {
            opId,
            opType: 'stock.adjust',
            classification: 'rejected',
            problemCode: 'insufficient-on-hand',
            problemDetail: 'Not enough stock',
            payload,
            attribution: { deviceLabel: 'adjust-suite handheld', operatorEmail },
            opEnqueuedAt: new Date(Date.now() - 60_000).toISOString(),
            opOccurredAt: occurredAt,
          },
        ],
      })
      .expect(201);
    const listed = (await http().get(`${API}/${tenantId}/rejected-ops?status=open`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.items as {
      id: string;
      opId: string;
      decisions: string[];
    }[];
    const entry = listed.find((item) => item.opId === opId)!;
    expect(entry.decisions).toEqual(['apply', 'discard']);
    const recount = await http()
      .post(`${API}/${tenantId}/rejected-ops/${entry.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'recount' })
      .expect(409);
    expect(recount.body.code).toBe('decision-not-available');

    const applied = await http()
      .post(`${API}/${tenantId}/rejected-ops/${entry.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'apply' });
    expect([applied.status, applied.body.code, applied.body.detail]).toEqual([200, undefined, undefined]);
    expect(applied.body.rejectedOp.status).toBe('applied');
    expect(applied.body.outcome.command).toBe('stock.adjust');
    // A3 — the operator's request re-pends: the outcome holds the pend.
    const replayedPend = applied.body.outcome.snapshot.pendingAdjustment as { id: string; pendReason: string; requestedBy: string };
    expect(replayedPend).toMatchObject({ pendReason: 'approval-required', requestedBy: operatorUserId });

    const [a, b] = await Promise.all([pendRow(live.body.pendingAdjustment.id as string), pendRow(replayedPend.id)]);
    const arms = (row: Record<string, unknown>) => ({
      batch_id: row.batch_id,
      serial_ids: row.serial_ids,
      handling_unit_ids: row.handling_unit_ids,
      batch_override_reason: row.batch_override_reason,
      quantity_milli: row.quantity_milli,
      bin_id: row.bin_id,
      sku_id: row.sku_id,
      source_device_id: row.source_device_id,
      requested_by: row.requested_by,
      pend_reason: row.pend_reason,
    });
    expect(arms(b)).toEqual(arms(a));
    expect(a.batch_id).not.toBeNull();
    // The op's own ULID is the apply's key (a re-apply after a crash replays).
    await expectAuditRow({ tenantId, key: opId, action: 'stock_adjustment.recorded', targetType: 'stock_adjustment_pending', targetId: replayedPend.id, actorUserId: operatorUserId });
  });

  it("review apply of a manager's op posts the adjustment (201 snapshot); a refused apply leaves the row open; discard writes nothing", async () => {
    const upload = (row: Record<string, unknown>) =>
      http().post(`${API}/${tenantId}/devices/sync-reports`).set('Authorization', `Bearer ${managerDeviceToken}`).set(KEY_HEADER, ulid()).send({ rows: [row] });
    const row = (payload: Record<string, unknown>) => ({
      opId: ulid(),
      opType: 'stock.adjust',
      classification: 'rejected',
      problemCode: 'conflict',
      problemDetail: null,
      payload,
      attribution: { deviceLabel: 'adjust-suite manager handheld', operatorEmail: opsEmail },
      opEnqueuedAt: new Date(Date.now() - 60_000).toISOString(),
      opOccurredAt: null,
    });
    const applyRow = row(deviceBody({ binId: bin('A-05'), quantityDelta: 2, reasonCode: 'found', note: 'manager review' }));
    const refusedRow = row(deviceBody({ binId: bin('A-05'), quantityDelta: -5000, reasonCode: 'shrinkage', note: 'too many' }));
    await upload(applyRow).expect(201);
    await upload(refusedRow).expect(201);
    const listed = (await http().get(`${API}/${tenantId}/rejected-ops?status=open`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.items as { id: string; opId: string }[];
    const applyEntry = listed.find((item) => item.opId === applyRow.opId)!;
    const refusedEntry = listed.find((item) => item.opId === refusedRow.opId)!;

    const applied = await http()
      .post(`${API}/${tenantId}/rejected-ops/${applyEntry.id}/resolve`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'apply' })
      .expect(200);
    expect(applied.body.outcome.snapshot.event).toMatchObject({ type: 'stock.adjusted', quantityDelta: 2 });
    await expectAuditRow({
      tenantId,
      key: applyRow.opId,
      action: 'stock_adjustment.recorded',
      targetType: 'ledger_event',
      targetId: applied.body.outcome.snapshot.event.id as string,
      actorUserId: opsUserId,
    });

    // −5000 is over the threshold, so it re-pends (the write-side refusal sits
    // below the branch) — the reviewer's Apply never forces stock through.
    const repended = await http()
      .post(`${API}/${tenantId}/rejected-ops/${refusedEntry.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'apply' })
      .expect(200);
    expect(repended.body.outcome.snapshot.pendingAdjustment).toMatchObject({ pendReason: 'threshold', quantityDelta: -5000 });

    // A malformed stored payload (a reason outside the vocabulary) refuses
    // before any write — the row stays open, and Discard closes it.
    const badRow = row(deviceBody({ quantityDelta: -1, reasonCode: 'lost' }));
    await upload(badRow).expect(201);
    const bad = ((await http().get(`${API}/${tenantId}/rejected-ops?status=open`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.items as { id: string; opId: string }[]).find(
      (item) => item.opId === badRow.opId,
    )!;
    const badApply = await http()
      .post(`${API}/${tenantId}/rejected-ops/${bad.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'apply' })
      .expect(400);
    expect(badApply.body.detail).toMatch(/reasonCode/);
    const pends = await count('stock_adjustment_pendings', '');
    const discarded = await http()
      .post(`${API}/${tenantId}/rejected-ops/${bad.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'discard' })
      .expect(200);
    expect(discarded.body.rejectedOp.status).toBe('discarded');
    expect(await count('stock_adjustment_pendings', '')).toBe(pends);

    // Code review — the stored payload's DTO bounds: each refuses 400
    // `validation-failed` before any write, and the row stays open.
    for (const [label, extra] of [
      ['a blank note', { note: '   ' }],
      ['a batch that is a string', { batch: 'L1' }],
      ['an empty batch code', { batch: { code: '' } }],
      ['a non-string serial', { serials: [1] }],
      ['a 65-character serial', { serials: ['S'.repeat(65)] }],
    ] as const) {
      const malformed = row(deviceBody({ quantityDelta: -1, ...extra }));
      await upload(malformed).expect(201);
      const open = ((await http().get(`${API}/${tenantId}/rejected-ops?status=open`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.items as { id: string; opId: string }[]).find(
        (item) => item.opId === malformed.opId,
      )!;
      const [pendsBefore, eventsBefore] = [await count('stock_adjustment_pendings', ''), await count('ledger_events', '')];
      const refused = await http()
        .post(`${API}/${tenantId}/rejected-ops/${open.id}/resolve`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ decision: 'apply' });
      expect([label, refused.status, refused.body.code]).toEqual([label, 400, 'validation-failed']);
      expect([label, await count('stock_adjustment_pendings', ''), await count('ledger_events', '')]).toEqual([label, pendsBefore, eventsBefore]);
      const still = (await sql<{ status: string }[]>`select status from rejected_ops where id = ${open.id}`)[0]!;
      expect([label, still.status]).toEqual([label, 'open']);
    }
  });

  it('A2: a revoked device is refused BEFORE composition — no batch identity is minted', async () => {
    const third = await enrollAndBadgeIn('adjust-suite revoked handheld', operatorEmail);
    await http()
      .post(`${API}/${tenantId}/devices/${third.deviceId}/revoke`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(200);
    const batches = await count('batches', "and code = 'REVOKED-LOT'");
    // Driven through the submission directly — the HTTP guard would refuse a
    // revoked device's session before the submission ever ran.
    await expect(
      app.get(AdjustmentSubmission).submit(
        {
          tenantId,
          actorUserId: operatorUserId,
          deviceId: third.deviceId,
          warehouseId,
          skuId: sku(BATCH),
          binId: bin('A-02'),
          quantityDelta: 1,
          reasonCode: 'found',
          note: 'revoked',
          occurredAt: new Date().toISOString(),
          batch: { code: 'REVOKED-LOT' },
        },
        ulid(),
      ),
    ).rejects.toMatchObject({ response: { code: 'device-revoked' } });
    expect(await count('batches', "and code = 'REVOKED-LOT'")).toBe(batches);
  });

  it('A2 through HTTP: a revoked device\'s armed adjustment is refused before composition — no batch minted', async () => {
    const revoked = await enrollAndBadgeIn('adjust-suite revoked-http handheld', operatorEmail);
    await http()
      .post(`${API}/${tenantId}/devices/${revoked.deviceId}/revoke`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(200);
    const before = await count('batches', "and code = 'REVOKED-HTTP-LOT'");
    const res = await deviceAdjust(
      deviceBody({ skuId: sku(BATCH), binId: bin('A-02'), quantityDelta: 1, reasonCode: 'found', note: 'revoked', batch: { code: 'REVOKED-HTTP-LOT', mfgDate: null, expiryDate: null, overrideReason: null } }),
      revoked.token,
    );
    expect([res.status, res.body.code]).toEqual([403, 'device-revoked']);
    expect(await count('batches', "and code = 'REVOKED-HTTP-LOT'")).toBe(before);
  });

  it('the snapshot carries the adjustment reasons with their labels, in vocabulary order', async () => {
    const res = await http().get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`).set('Authorization', `Bearer ${deviceToken}`).expect(200);
    expect(res.body.adjustReasons).toEqual(ADJUSTMENT_REASON_CODES.map((code) => ({ code, label: ADJUSTMENT_REASON_LABELS[code] })));
  });

  it('pend_reason: the DB CHECK and the TS vocabulary agree', async () => {
    const def = (await sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'stock_adjustment_pendings_pend_reason_check'`)[0]!.def;
    expect([...def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()).toEqual([...ADJUSTMENT_PEND_REASONS].sort());
  });

  it('the route is in the OpenAPI document with both security schemes and the 202 arm', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const op = (doc.body.paths as Record<string, Record<string, { responses: Record<string, unknown>; security: Record<string, unknown>[] }>>)[
      '/tenants/{tenantId}/inventory/adjustments'
    ]?.post;
    expect(op).toBeDefined();
    expect(Object.keys(op!.responses).sort()).toEqual(['201', '202', '400', '401', '403', '404', '409', '422']);
    expect(op!.security.map((entry) => Object.keys(entry)[0]).sort()).toEqual(['bearer', 'device']);
  });
});
