import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { PICKLIST_LINE_STATUSES } from '../src/modules/outbound/wave.command';
import { CAPABILITIES, ROLE_CAPABILITIES } from '../src/modules/tenancy/permissions';
import { getLedgerEventType } from '../src/modules/inventory/ledger-registry';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions — the same bootstrap the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// A host that exports any poll interval would boot background workers and
// race these tests — the sibling-suite convention.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(30_000);

interface PickLine {
  id: string;
  picklistId: string;
  orderId: string;
  orderLineId: string;
  skuId: string;
  binId: string | null;
  binCode: string | null;
  batchId: string | null;
  reservationId: string | null;
  qty: number;
  shortfallQty: number;
  sliceSeq: number;
  walkSeq: number;
  status: string;
}

interface Picklist {
  id: string;
  waveId: string;
  orderId: string | null;
  status: string;
  stopCount: number;
  lines: PickLine[];
}

interface Wave {
  id: string;
  status: string;
  picklists: Picklist[];
}

interface PickBody {
  warehouseId?: string;
  picklistId: string;
  picklistLineId: string;
  skuId: string;
  binId: string;
  qty: number;
  occurredAt?: string;
  serials?: string[] | null;
}

describe('picking: scan-verified picks with offline tolerance (e2e, story 4.3)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let accountantToken: string;
  let warehouseId: string;
  let zoneId: string;
  let binA: string; // A-01-01
  let binB: string; // A-01-02
  let binBlockedId: string; // A-09-01, blocked at pick time
  const skuIds = new Map<string, string>();

  let deviceId: string;
  let deviceToken: string; // the bare enrollment credential (no badge-in)
  let operatorToken: string; // the badge-in operator session
  let operatorUserId: string;

  /** SKU fixtures — one scenario each, so the suite never shares stock. */
  const SKU_CODES = [
    'PCK-OK', // the happy path + the idempotent replay
    'PCK-WRONG', // the wrong-item / wrong-bin arms
    'PCK-STALE', // the stale-replay 422
    'PCK-AUTH', // the authority arms
    'PCK-SPLIT', // an order line spanning two bins (the hold settles last)
    'PCK-GATE', // the blocked / retired / system-bin arms
    'PCK-REUSE', // the idempotency-key-reuse arm
    'PCK-CANCEL', // wave cancel must not free a picked line
    'PCK-WHOLE', // the full-quantity-only arm
    'PCK-SNAP', // the sealed device snapshot's pickTasks
    'PCK-ORDCXL', // order-cancel refused once a line is picked
  ] as const;
  const BATCH_SKU_CODE = 'PCK-FEFO';
  /** Its own batch-tracked SKU: the two-arm draw must be the only claim on its bins. */
  const BATCH_SPAN_SKU_CODE = 'PCK-FEFO2';
  const SERIAL_SKU_CODE = 'PCK-SERIAL';

  beforeAll(async () => {
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await admin.begin(async (tx) => {
        // 742107 is the id `orders.spec` and `waves.spec` already take for
        // this block. The lock exists to serialize creation of the
        // CLUSTER-GLOBAL probe roles, so a suite taking its own id is not
        // holding the same mutex as everyone else — harmless while jest runs
        // one worker, wrong the moment it does not.
        await tx`select pg_advisory_xact_lock(742107)`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_auth_probe') then
              create role wms_auth_probe login password 'wms_auth_probe' nosuperuser bypassrls;
            end if;
            if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
              create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_auth_probe, wms_rls_probe');
        await tx.unsafe(
          'grant select, insert, update, delete on all tables in schema public to wms_auth_probe, wms_rls_probe',
        );
      });
      const authUrl = new URL(process.env.DATABASE_URL!);
      authUrl.username = 'wms_auth_probe';
      authUrl.password = 'wms_auth_probe';
      process.env.DATABASE_AUTH_URL = authUrl.toString();
    } finally {
      await admin.end();
    }
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    // ── tenant + roles ────────────────────────────────────────────────────
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Pick Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    const signIn = (address: string, password: string) =>
      request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: address, password })
        .expect(200)
        .then((res) => res.body.accessToken as string);
    ownerToken = await signIn(email, 'correct-horse-battery');
    opsToken = await inviteAndSignIn('ops_manager', 'ops-password-123');
    accountantToken = await inviteAndSignIn('accountant', 'books-password-123');

    // ── warehouse → zone → bins (created out of code order on purpose) ────
    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: `PCK-${ulid().slice(10, 16).toUpperCase()}`, name: `Pick WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
    zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binB = await createBin('A-01-02');
    binA = await createBin('A-01-01');
    binBlockedId = await createBin('A-09-01');

    // ── SKUs ──────────────────────────────────────────────────────────────
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      ...SKU_CODES.map((code) => `${code},Pick SKU ${code},pcs,,1800,,false,false,,,`),
      `${BATCH_SKU_CODE},Pick SKU ${BATCH_SKU_CODE},pcs,,1800,,true,false,,,`,
      `${BATCH_SPAN_SKU_CODE},Pick SKU ${BATCH_SPAN_SKU_CODE},pcs,,1800,,true,false,,,`,
      `${SERIAL_SKU_CODE},Pick SKU ${SERIAL_SKU_CODE},pcs,,1800,,false,true,,,`,
    ].join('\n');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const skus = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }
    expect(skuIds.size).toBeGreaterThanOrEqual(SKU_CODES.length + 3);

    // ── the floor device + its badge-in operator ──────────────────────────
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Pick scanner 1', pin: '1357' })
      .expect(201);
    deviceId = enrolled.body.device.id as string;
    deviceToken = enrolled.body.deviceToken as string;
    const operatorEmail = `operator-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: operatorEmail, role: 'operator' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const badged = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ operatorEmail, pin: '1357' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
    operatorUserId = badged.body.operator.id as string;

    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
  });

  afterAll(async () => {
    // The pools close even when the row cleanup fails. These suites share one
    // Postgres server (max_connections is the shared resource), so a teardown
    // that throws BEFORE `$client.end()` strands this app's ten connections
    // for the rest of the run — and the failure then surfaces as an
    // unrelated, arbitrary suite later on. Cleanup problems must stay this
    // suite's problem.
    let cleanupError: unknown;
    try {
      await cleanupRows();
    } catch (err) {
      cleanupError = err;
    }
    await valkey.quit().catch(() => valkey.disconnect());
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    if (cleanupError !== undefined) throw cleanupError;
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      for (const table of ['picks', 'picklist_lines', 'picklists', 'waves', 'wave_policies', 'order_lines', 'orders']) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      // The ledger tables are append-only by trigger — the trigger is not RLS
      // and fires even for the table owner (the ledger.spec convention).
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      for (const table of [
        'reservations',
        'serials',
        'batch_on_hand',
        'stock_on_hand',
        'outbox_messages',
        'idempotency_keys',
        'audit_events',
        'catalog_import_errors',
        'catalog_imports',
        'uom_conversions',
        'batches',
        'skus',
        'devices',
        'bins',
        'zones',
        'warehouses',
        'users',
        'tenants',
      ]) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      for (const tenant of createdTenantIds) {
        const keys = await valkey.keys(`wms:{${tenant}}:*`);
        if (keys.length > 0) await valkey.del(...keys);
      }
    } finally {
      await cleaner.end();
    }
  }

  // ── fixtures ───────────────────────────────────────────────────────────────

  async function inviteAndSignIn(role: string, password: string): Promise<string> {
    const address = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: address, role })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password })
      .expect(200);
    return request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email: address, password })
      .expect(200)
      .then((res) => res.body.accessToken as string);
  }

  async function createBin(code: string): Promise<string> {
    return (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 10000, type: 'shelf', code })
        .expect(201)
    ).body.id as string;
  }

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  /** Seeds committed on-hand into one bin through the stock.adjustment command. */
  async function seedStock(
    skuId: string,
    binId: string,
    quantity: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId,
        quantityDelta: quantity,
        reasonCode: 'cycle-count',
        note: 'picking-suite seed',
        ...extra,
      })
      .expect(201);
  }

  /** Draws units back OUT of a bin (the "another wave drained it" simulation). */
  async function drainStock(skuId: string, binId: string, quantity: number): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId,
        quantityDelta: -quantity,
        reasonCode: 'cycle-count',
        note: 'picking-suite drain',
      })
      .expect(201);
  }

  async function createOrder(lines: { skuId: string; quantity: number }[]): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines })
      .expect(201);
    return res.body.order.id as string;
  }

  async function policyId(name: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/wave-policies`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, name, grouping: 'single' })
      .expect(201);
    return res.body.policy.id as string;
  }

  /** One released wave over one fresh order — the pick fixture in one call. */
  async function releasedWave(
    lines: { skuId: string; quantity: number }[],
    tag: string,
  ): Promise<{ waveId: string; orderId: string; picklist: Picklist }> {
    const orderId = await createOrder(lines);
    const policy = await policyId(`${tag}-${ulid().slice(10, 18)}`);
    const generated = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy, orderIds: [orderId] })
      .expect(201);
    const waveId = generated.body.wave.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const wave = await getWave(waveId);
    const picklist = wave.picklists[0];
    if (picklist === undefined) throw new Error('fixture produced no picklist');
    return { waveId, orderId, picklist };
  }

  async function getWave(waveId: string): Promise<Wave> {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    return res.body.wave as Wave;
  }

  /**
   * Posts a body VERBATIM. It deliberately mints nothing of its own: the
   * server hashes the whole payload for the idempotency contract, so a
   * helper that stamped a fresh `occurredAt` per call would make two
   * "same-key replay" requests carry DIFFERENT payloads whenever they
   * straddled a whole second, and the replay would correctly answer
   * `422 idempotency-key-reuse` instead of re-serving. A replay test must
   * send the same bytes twice — which is also what the device does: the
   * queued op stamps `occurredAt` once at enqueue time and replays that.
   */
  function pick(body: PickBody, token = operatorToken, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/picks`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, ...body });
  }

  /**
   * The pick body a planned line implies (the happy path's "scan what it
   * says"), with `occurredAt` stamped ONCE — hold the returned object and
   * re-post it to replay, exactly as a queued op does.
   */
  function bodyFor(line: PickLine, overrides: Partial<PickBody> = {}): PickBody {
    return {
      picklistId: line.picklistId,
      picklistLineId: line.id,
      skuId: line.skuId,
      binId: line.binId!,
      qty: line.qty,
      occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      ...overrides,
    };
  }

  async function snapshotTasks(): Promise<
    { picklistLineId: string; binCode: string; skuCode: string; qty: number; walkSeq: number }[]
  > {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    return res.body.pickTasks as {
      picklistLineId: string;
      binCode: string;
      skuCode: string;
      qty: number;
      walkSeq: number;
    }[];
  }

  async function ledgerFor(picklistLineId: string): Promise<
    { type: string; quantity_delta: number; from_bin_id: string | null; to_bin_id: string | null; batch_ref: string | null; serial_ref: string | null }[]
  > {
    return (await sql`
      select type, quantity_delta, from_bin_id, to_bin_id, batch_ref, serial_ref
      from ledger_events
      where tenant_id = ${tenantId}
        and reference_doc->>'picklistLineId' = ${picklistLineId}
      order by seq
    `) as unknown as {
      type: string;
      quantity_delta: number;
      from_bin_id: string | null;
      to_bin_id: string | null;
      batch_ref: string | null;
      serial_ref: string | null;
    }[];
  }

  async function reservationState(reservationId: string): Promise<string | null> {
    const rows = await sql`select state from reservations where id = ${reservationId}`;
    return (rows[0] as unknown as { state: string } | undefined)?.state ?? null;
  }

  async function lineStatus(lineId: string): Promise<string | null> {
    const rows = await sql`select status from picklist_lines where id = ${lineId}`;
    return (rows[0] as unknown as { status: string } | undefined)?.status ?? null;
  }

  async function onHand(skuId: string, binId: string): Promise<number> {
    const rows = await sql`
      select quantity from stock_on_hand
      where tenant_id = ${tenantId} and sku_id = ${skuId} and bin_id = ${binId}
    `;
    return (rows[0] as unknown as { quantity: number } | undefined)?.quantity ?? 0;
  }

  // ── the module's registries ────────────────────────────────────────────────

  it('the pick arms are additive: the line status machine gains `picked`, the grammar gains `pick.picked`, the role matrix gains `picks.execute`', () => {
    // `picked` sits OUTSIDE `cancelled` — the partial unique index keys on
    // `status <> 'cancelled'`, so a picked line KEEPS its claim on the order.
    expect([...PICKLIST_LINE_STATUSES]).toEqual(['planned', 'unfulfillable', 'picked', 'cancelled']);
    expect((PICKLIST_LINE_STATUSES as readonly string[]).includes('picked')).toBe(true);

    const definition = getLedgerEventType('pick.picked');
    expect(definition).toBeDefined();
    expect(definition!.referenceKinds).toEqual(['pick']);
    expect(definition!.allowsBatchArm).toBe(true);
    expect(definition!.allowsSerialArm).toBe(true);

    expect((CAPABILITIES as readonly string[]).includes('picks.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.operator.has('picks.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.ops_manager.has('picks.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.owner.has('picks.execute')).toBe(true);
    expect(ROLE_CAPABILITIES.accountant.has('picks.execute')).toBe(false);
  });

  // ── the happy path ────────────────────────────────────────────────────────

  it('a scan-verified pick draws the ledger, commits the hold and flips the line — all from ONE transaction', async () => {
    const skuId = sku('PCK-OK');
    await seedStock(skuId, binA, 40);
    const { picklist } = await releasedWave([{ skuId, quantity: 12 }], 'ok');
    const line = picklist.lines[0]!;
    expect(line.status).toBe('planned');
    expect(line.binId).toBe(binA);
    expect(line.reservationId).not.toBeNull();
    expect(await reservationState(line.reservationId!)).toBe('held');
    const before = await onHand(skuId, binA);

    const res = await pick(bodyFor(line)).expect(201);
    const settled = res.body.pick as Record<string, unknown>;
    expect(settled.picklistLineId).toBe(line.id);
    expect(settled.binId).toBe(binA);
    expect(settled.qty).toBe(12);
    expect(settled.lineStatus).toBe('picked');
    expect(settled.reservationCommitted).toBe(true);
    expect(settled.pickedBy).toBe(operatorUserId);
    expect(settled.deviceId).toBe(deviceId);

    // The three effects of the one transaction.
    expect(await onHand(skuId, binA)).toBe(before - 12);
    expect(await reservationState(line.reservationId!)).toBe('committed');
    expect(await lineStatus(line.id)).toBe('picked');

    // The ledger draw: one `pick.picked` event OUT of the scanned bin.
    const events = await ledgerFor(line.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('pick.picked');
    expect(events[0]!.quantity_delta).toBe(-12);
    expect(events[0]!.from_bin_id).toBe(binA);
    expect(events[0]!.to_bin_id).toBeNull();

    // The outbox event and the audit row ride the same commit.
    const outbox = await sql`
      select payload from outbox_messages where tenant_id = ${tenantId} and type = 'pick.recorded'
    `;
    expect(
      outbox.filter(
        (row) => (row as unknown as { payload: { pick: { id: string } } }).payload.pick.id === settled.id,
      ),
    ).toHaveLength(1);
    const audit = await sql`
      select id from audit_events
      where tenant_id = ${tenantId} and action = 'pick.picked' and target_id = ${settled.id as string}
    `;
    expect(audit).toHaveLength(1);
  });

  it('the same key + the same payload re-serves the original snapshot — nothing re-draws', async () => {
    const skuId = sku('PCK-REUSE');
    await seedStock(skuId, binA, 20);
    const { picklist } = await releasedWave([{ skuId, quantity: 5 }], 'replay');
    const line = picklist.lines[0]!;
    const key = ulid();
    // ONE body, posted twice — the same bytes under the same key is what the
    // replay contract is about (a re-stamped `occurredAt` would be a
    // different payload and would rightly 422).
    const body = bodyFor(line);

    const first = await pick(body, operatorToken, key).expect(201);
    const drawn = await onHand(skuId, binA);
    const replay = await pick(body, operatorToken, key).expect(201);
    expect(replay.body.pick).toEqual(first.body.pick);
    // The replay re-serves; it never re-draws.
    expect(await onHand(skuId, binA)).toBe(drawn);
    expect(await ledgerFor(line.id)).toHaveLength(1);

    // The same key with a DIFFERENT payload is the deterministic 422.
    const reused = await pick({ ...body, qty: 4 }, operatorToken, key).expect(422);
    expect(reused.body.code).toBe('idempotency-key-reuse');

    // A NEW key against an already-picked line is a deterministic 409 —
    // never a second draw.
    const second = await pick(bodyFor(line)).expect(409);
    expect(second.body.detail).toMatch(/already picked/i);
    expect(await ledgerFor(line.id)).toHaveLength(1);
  });

  // ── the conflict arm (the whole of 4.3's conflict behaviour) ──────────────

  it('a queued pick whose bin drained before replay fails 422 insufficient-on-hand, persists NOTHING, and leaves its key unconsumed', async () => {
    const skuId = sku('PCK-STALE');
    await seedStock(skuId, binA, 10);
    const { picklist } = await releasedWave([{ skuId, quantity: 10 }], 'stale');
    const line = picklist.lines[0]!;

    // Another wave drains the bin while the op sits in the device queue.
    await drainStock(skuId, binA, 10);
    expect(await onHand(skuId, binA)).toBe(0);

    const key = ulid();
    // The queued op's bytes, stamped once — the parked op replays verbatim.
    const body = bodyFor(line);
    const stale = await pick(body, operatorToken, key).expect(422);
    expect(stale.body.code).toBe('insufficient-on-hand');
    // The rejection names the bin and what it LIVE holds.
    expect(stale.body.detail).toContain('A-01-01');
    expect(stale.body.detail).toContain('0');

    // Nothing persisted: no pick row, no ledger event, the line still
    // planned, the hold still held, and the key never consumed.
    const picks = await sql`select id from picks where tenant_id = ${tenantId} and picklist_line_id = ${line.id}`;
    expect(picks).toHaveLength(0);
    expect(await ledgerFor(line.id)).toHaveLength(0);
    expect(await lineStatus(line.id)).toBe('planned');
    expect(await reservationState(line.reservationId!)).toBe('held');
    const keys = await sql`select id from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
    expect(keys).toHaveLength(0);

    // The op is still replayable once the stock is back — the client parks
    // it, it does not lose it.
    await seedStock(skuId, binA, 10);
    await pick(body, operatorToken, key).expect(201);
    expect(await lineStatus(line.id)).toBe('picked');
  });

  // ── the on-device mirror's server-side backstops ──────────────────────────

  it('a wrong item is refused naming the expected SKU; a wrong bin is checked against LIVE stock, not against the plan', async () => {
    const skuId = sku('PCK-WRONG');
    const otherSkuId = sku('PCK-GATE');
    await seedStock(skuId, binA, 15);
    const { picklist } = await releasedWave([{ skuId, quantity: 6 }], 'wrong');
    const line = picklist.lines[0]!;

    // Wrong item: the server backstop for the on-device rejection.
    const wrong = await pick(bodyFor(line, { skuId: otherSkuId })).expect(400);
    expect(wrong.body.code).toBe('wrong-item');
    expect(wrong.body.detail).toContain(skuId);
    expect(await lineStatus(line.id)).toBe('planned');

    // A bin the plan did NOT name, but which holds the SKU, is picked from
    // it — the plan's bin is a suggestion, re-derived against live stock.
    await seedStock(skuId, binB, 6);
    const elsewhere = await pick(bodyFor(line, { binId: binB })).expect(201);
    expect(elsewhere.body.pick.binId).toBe(binB);
    expect(elsewhere.body.pick.suggestedBinId).toBe(binA);
    expect(await onHand(skuId, binB)).toBe(0);
    // The suggested bin is untouched — the draw followed the scan.
    expect(await onHand(skuId, binA)).toBe(15);
  });

  it('a bin holding none of the SKU is the same 422 — a wrong-bin scan never drains the wrong stock', async () => {
    const skuId = sku('PCK-CANCEL');
    await seedStock(skuId, binA, 8);
    const { picklist } = await releasedWave([{ skuId, quantity: 8 }], 'wrongbin');
    const line = picklist.lines[0]!;
    const empty = await pick(bodyFor(line, { binId: binB })).expect(422);
    expect(empty.body.code).toBe('insufficient-on-hand');
    expect(await lineStatus(line.id)).toBe('planned');
  });

  // ── the bin gates ─────────────────────────────────────────────────────────

  it('blocked, retired and system bins are unpickable; an unknown bin is a 404', async () => {
    const skuId = sku('PCK-GATE');
    await seedStock(skuId, binA, 10);
    await seedStock(skuId, binBlockedId, 10);
    const { picklist } = await releasedWave([{ skuId, quantity: 4 }], 'gate');
    const line = picklist.lines[0]!;

    // Block the bin AFTER the wave planned (the floor state moved on).
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binBlockedId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ blocked: true })
      .expect(200);
    const blocked = await pick(bodyFor(line, { binId: binBlockedId })).expect(400);
    expect(blocked.body.code).toBe('bin-blocked');
    expect(blocked.body.detail).toContain('A-09-01');

    // A RETIRED bin: retirement is terminal, and a retired bin is refused as
    // a draw source. (Set through the owner handle — the retire command
    // refuses a non-empty bin, and this bin must hold stock to be a
    // meaningful draw target.)
    const retiredBin = await createBin('A-09-02');
    await seedStock(skuId, retiredBin, 10);
    await sql`
      update bins set retired_at = now(), retired_by = ${operatorUserId}
      where id = ${retiredBin} and tenant_id = ${tenantId}
    `;
    const retired = await pick(bodyFor(line, { binId: retiredBin })).expect(400);
    expect(retired.body.code).toBe('bin-retired');
    expect(retired.body.detail).toContain('A-09-02');

    // A SYSTEM bin (Receiving / QC-hold): picks draw from storage bins only.
    const systemBinId = uuidv7();
    await sql`
      insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned)
      values (${systemBinId}, ${tenantId}, ${warehouseId}, ${zoneId}, ${`SYS-${ulid().slice(10, 16)}`}, 1000, 'shelf', true)
    `;
    const system = await pick(bodyFor(line, { binId: systemBinId })).expect(400);
    expect(system.body.code).toBe('validation-failed');
    expect(system.body.detail).toMatch(/system bin/i);

    // A bin outside the warehouse (or nonexistent) is a 404, never a 500.
    const missing = await pick(bodyFor(line, { binId: uuidv7() })).expect(404);
    expect(missing.body.code).toBe('not-found');
    expect(await lineStatus(line.id)).toBe('planned');
  });

  // ── quantity + lifecycle gates ────────────────────────────────────────────

  it('a line is picked WHOLE — a partial quantity is refused (short-picking is 4.4)', async () => {
    // Its own SKU: a leftover pool in the walk's first bin would let the
    // planner cover the next scenario's order from there instead of the two
    // bins that scenario seeds.
    const skuId = sku('PCK-WHOLE');
    await seedStock(skuId, binA, 30);
    const { picklist } = await releasedWave([{ skuId, quantity: 9 }], 'whole');
    const line = picklist.lines[0]!;
    const short = await pick(bodyFor(line, { qty: 4 })).expect(400);
    expect(short.body.code).toBe('validation-failed');
    expect(short.body.detail).toMatch(/picked whole/i);
    expect(await lineStatus(line.id)).toBe('planned');
  });

  it('an order line spanning two bins settles its hold only when the LAST slice is picked', async () => {
    const skuId = sku('PCK-SPLIT');
    // Fresh bins so this order line is the only claim on them.
    const binC = await createBin('A-02-01');
    const binD = await createBin('A-02-02');
    await seedStock(skuId, binC, 5);
    await seedStock(skuId, binD, 5);
    const { picklist } = await releasedWave([{ skuId, quantity: 10 }], 'split');
    const slices = picklist.lines.filter((candidate) => candidate.status === 'planned');
    expect(slices.length).toBeGreaterThanOrEqual(2);
    const [first, second] = slices;
    const reservationId = first!.reservationId!;

    await pick(bodyFor(first!)).expect(201);
    // A whole-quantity row has no partial commit: settling here would commit
    // units still sitting in the other bin.
    expect(await reservationState(reservationId)).toBe('held');
    expect(await lineStatus(first!.id)).toBe('picked');

    const last = await pick(bodyFor(second!)).expect(201);
    expect(last.body.pick.reservationCommitted).toBe(true);
    expect(await reservationState(reservationId)).toBe('committed');
  });

  it('the wave must be released and the order accepted — a cancelled order’s units are never picked', async () => {
    const skuId = sku('PCK-CANCEL');
    await seedStock(skuId, binA, 12);
    const orderId = await createOrder([{ skuId, quantity: 3 }]);
    const policy = await policyId(`unreleased-${ulid().slice(10, 18)}`);
    const generated = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy, orderIds: [orderId] })
      .expect(201);
    const waveId = generated.body.wave.id as string;
    const planned = (await getWave(waveId)).picklists[0]!.lines[0]!;

    // Planned, not released: not the floor's work yet.
    const early = await pick(bodyFor(planned)).expect(409);
    expect(early.body.detail).toMatch(/only a released wave/i);
    expect(early.body.detail).toContain('planned');

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    // The wave's own release drops a cancelled order's lines, so cancel the
    // order AFTER release to reach the command's own order gate.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const cancelled = await pick(bodyFor(planned)).expect(409);
    expect(cancelled.body.code).toBe('conflict');
    expect(cancelled.body.detail).toMatch(/its units are not picked/i);
    expect(cancelled.body.detail).toContain('cancelled');
    expect(await lineStatus(planned.id)).toBe('planned');
  });

  it('cancelling the ORDER is refused once any of its lines is picked — those units have left their bins', async () => {
    // A COMMITTED hold is not the only way an order stops being pre-pick
    // stock: the hold settles only on the LAST open slice, so an order whose
    // first slice is picked still carries a `held` reservation. Releasing it
    // on cancel would free stock that has already left the bin.
    // Its own SKU: a committed hold stays deducted from ATP until dispatch,
    // so a SKU another scenario has already picked cannot reserve again here.
    const skuId = sku('PCK-ORDCXL');
    const binK = await createBin('A-07-01');
    const binL = await createBin('A-07-02');
    await seedStock(skuId, binK, 4);
    await seedStock(skuId, binL, 4);
    const { orderId, picklist } = await releasedWave([{ skuId, quantity: 8 }], 'ordercancel');
    const slices = picklist.lines.filter((candidate) => candidate.status === 'planned');
    expect(slices.length).toBeGreaterThanOrEqual(2);
    const first = slices[0]!;

    await pick(bodyFor(first)).expect(201);
    // The hold is still `held` (the other slice is open), so the 4.1 guard
    // that only refuses COMMITTED holds would have let this through.
    expect(await reservationState(first.reservationId!)).toBe('held');

    const refused = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(409);
    expect(refused.body.detail).toContain(first.id);
    expect(refused.body.detail).toMatch(/already left their bins/i);

    // Nothing moved: the order is still accepted and the hold still held.
    expect(await reservationState(first.reservationId!)).toBe('held');
    const order = await sql`select status from orders where id = ${orderId}`;
    expect((order[0] as unknown as { status: string }).status).toBe('accepted');
  });

  it('cancelling a wave never frees a PICKED line — its units have already left the bin', async () => {
    const skuId = sku('PCK-CANCEL');
    await seedStock(skuId, binA, 20);
    const { waveId, picklist } = await releasedWave([{ skuId, quantity: 7 }], 'wavecancel');
    const line = picklist.lines[0]!;
    await pick(bodyFor(line)).expect(201);

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    // The picked line keeps its claim in the partial unique index; a second
    // wave can never re-plan stock that is already gone.
    expect(await lineStatus(line.id)).toBe('picked');
  });

  // ── the batch and serial arms ─────────────────────────────────────────────

  it('a batch-tracked pick re-derives its batch FEFO inside the SCANNED bin and folds both projections', async () => {
    const skuId = sku(BATCH_SKU_CODE);
    const binE = await createBin('A-03-01');
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 400 * 86_400_000).toISOString();
    // The LATER batch is seeded first: FEFO, not insertion order, must win.
    await seedStock(skuId, binE, 6, { batch: { code: `PCK-LATE-${ulid().slice(10, 16)}`, expiryDate: later } });
    await seedStock(skuId, binE, 6, { batch: { code: `PCK-SOON-${ulid().slice(10, 16)}`, expiryDate: soon } });
    const { picklist } = await releasedWave([{ skuId, quantity: 4 }], 'fefo');
    const line = picklist.lines.find((candidate) => candidate.binId === binE)!;

    const res = await pick(bodyFor(line)).expect(201);
    const drawnBatch = res.body.pick.batchId as string;
    const batchRows = await sql`select code, expiry_date from batches where id = ${drawnBatch}`;
    expect((batchRows[0] as unknown as { code: string }).code).toContain('PCK-SOON');

    const events = await ledgerFor(line.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.batch_ref).toBe(drawnBatch);
    const batchOnHand = await sql`
      select quantity from batch_on_hand
      where tenant_id = ${tenantId} and bin_id = ${binE} and batch_id = ${drawnBatch}
    `;
    expect((batchOnHand[0] as unknown as { quantity: number }).quantity).toBe(2);
  });

  it('a draw larger than the earliest batch spans TWO arms — one event each, FEFO order, and the pick row names no single batch', async () => {
    const skuId = sku(BATCH_SPAN_SKU_CODE);
    const binJ = await createBin('A-06-01');
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 300 * 86_400_000).toISOString();
    const soonCode = `PCK-2A-SOON-${ulid().slice(10, 16)}`;
    const laterCode = `PCK-2A-LATE-${ulid().slice(10, 16)}`;
    // Only ONE batch exists when the wave plans, so the planner emits a
    // single 7-unit slice naming it.
    await seedStock(skuId, binJ, 8, { batch: { code: laterCode, expiryDate: later } });
    const { picklist } = await releasedWave([{ skuId, quantity: 7 }], 'fefo2');
    const line = picklist.lines.find((candidate) => candidate.binId === binJ)!;
    expect(line.qty).toBe(7);

    // An EARLIER-expiring batch lands in the same bin before the pick. The
    // plan's batch is advisory and re-derived at pick time, so the draw must
    // now take the new batch first and spill into the planned one — two arms
    // from one line. A draw that stopped after the first arm would
    // under-draw stock while recording the full quantity.
    await seedStock(skuId, binJ, 3, { batch: { code: soonCode, expiryDate: soon } });

    const res = await pick(bodyFor(line)).expect(201);
    // A draw spanning arms names no single batch on the settlement row — the
    // arms live on the events.
    expect(res.body.pick.batchId).toBeNull();
    expect(res.body.pick.batchCode).toBeNull();

    const events = await ledgerFor(line.id);
    expect(events).toHaveLength(2);
    const ids = await sql`select id, code from batches where tenant_id = ${tenantId} and code in (${soonCode}, ${laterCode})`;
    const byCode = new Map((ids as unknown as { id: string; code: string }[]).map((r) => [r.code, r.id]));
    // FEFO order: the soon-expiring batch drains first, and in full.
    expect(events[0]!.batch_ref).toBe(byCode.get(soonCode));
    expect(events[0]!.quantity_delta).toBe(-3);
    expect(events[1]!.batch_ref).toBe(byCode.get(laterCode));
    expect(events[1]!.quantity_delta).toBe(-4);
    // Both quantities actually left: 11 seeded − 7 drawn = 4, all of it in
    // the later batch (the earlier one drained whole).
    expect(await onHand(skuId, binJ)).toBe(4);
    const remaining = await sql`
      select batch_id, quantity from batch_on_hand
      where tenant_id = ${tenantId} and bin_id = ${binJ} and quantity > 0
    `;
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as unknown as { batch_id: string; quantity: number }).batch_id).toBe(
      byCode.get(laterCode),
    );
    expect((remaining[0] as unknown as { quantity: number }).quantity).toBe(4);
  });

  it('a serial-tracked pick writes one ledger event per serial unit; a wrong count, a duplicate or a serial living elsewhere is refused', async () => {
    const skuId = sku(SERIAL_SKU_CODE);
    const binF = await createBin('A-04-01');
    const binG = await createBin('A-04-02');
    const tag = ulid().slice(10, 16);
    await seedStock(skuId, binF, 2, { serials: [`PK-SN-${tag}-1`, `PK-SN-${tag}-2`] });
    await seedStock(skuId, binG, 1, { serials: [`PK-SN-${tag}-3`] });
    const { picklist } = await releasedWave([{ skuId, quantity: 2 }], 'serial');
    const line = picklist.lines.find((candidate) => candidate.binId === binF)!;
    expect(line.qty).toBe(2);

    // Missing serials, a wrong count, a duplicate and an unknown number are
    // all 400s before any write.
    await pick(bodyFor(line)).expect(400);
    await pick(bodyFor(line, { serials: [`PK-SN-${tag}-1`] })).expect(400);
    await pick(bodyFor(line, { serials: [`PK-SN-${tag}-1`, `PK-SN-${tag}-1`] })).expect(400);
    await pick(bodyFor(line, { serials: [`PK-SN-${tag}-1`, 'PK-SN-NOPE'] })).expect(400);
    // A serial that lives in another bin is the ledger's own 409.
    const elsewhere = await pick(bodyFor(line, { serials: [`PK-SN-${tag}-1`, `PK-SN-${tag}-3`] })).expect(409);
    expect(elsewhere.body.code).toBe('serial-elsewhere');
    expect(await lineStatus(line.id)).toBe('planned');

    await pick(bodyFor(line, { serials: [`PK-SN-${tag}-1`, `PK-SN-${tag}-2`] })).expect(201);
    const events = await ledgerFor(line.id);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.quantity_delta === -1)).toBe(true);
    expect(events.every((event) => event.from_bin_id === binF && event.to_bin_id === null)).toBe(true);
    expect(new Set(events.map((event) => event.serial_ref)).size).toBe(2);
    expect(await onHand(skuId, binF)).toBe(0);
  });

  // ── authority ─────────────────────────────────────────────────────────────

  it('authority is re-read at command entry: a bare device credential, a foreign tenant, a non-operator role and a revoked device all write nothing', async () => {
    const skuId = sku('PCK-AUTH');
    await seedStock(skuId, binA, 10);
    const { picklist } = await releasedWave([{ skuId, quantity: 3 }], 'auth');
    const line = picklist.lines[0]!;

    // A bare enrollment credential has no operator — badge-in first.
    const bare = await pick(bodyFor(line), deviceToken).expect(401);
    expect(bare.body.code).toBe('unauthenticated');

    // A web session token is not a device session.
    await pick(bodyFor(line), opsToken).expect(401);

    // A device token on another tenant's path.
    const foreign = await request(app.getHttpServer())
      .post(`${API}/${uuidv7()}/outbound/picks`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({ ...bodyFor(line), warehouseId })
      .expect(403);
    expect(foreign.body.code).toBe('permission-denied');

    // Demote the operator to accountant: the role is re-read per command, so
    // the NEXT action is denied ("next action, not next login").
    await sql`update users set role = 'accountant' where id = ${operatorUserId} and tenant_id = ${tenantId}`;
    const denied = await pick(bodyFor(line)).expect(403);
    expect(denied.body.code).toBe('role-denied');
    await sql`update users set role = 'operator' where id = ${operatorUserId} and tenant_id = ${tenantId}`;

    // Nothing above wrote anything.
    expect(await lineStatus(line.id)).toBe('planned');
    expect(await ledgerFor(line.id)).toHaveLength(0);

    // Revoke the device: the token is transport, never authority.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/${deviceId}/revoke`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const revoked = await pick(bodyFor(line)).expect(403);
    expect(revoked.body.code).toBe('device-revoked');
    expect(await lineStatus(line.id)).toBe('planned');
    // Un-revoke so the remaining assertions in this suite keep a live device.
    await sql`update devices set status = 'active' where id = ${deviceId}`;
  });

  it('an explicit `serials: null` body — what the device sends for EVERY untracked-SKU pick — is accepted', async () => {
    // The mobile op payload always carries the key. `@IsOptional()` lets the
    // null through, and the controller normalizes it to absent so the
    // command's payload hash spreads an array, never null: without that,
    // every untracked pick would 500 on `[...null]`.
    const skuId = sku('PCK-WHOLE');
    await seedStock(skuId, binA, 6);
    const { picklist } = await releasedWave([{ skuId, quantity: 6 }], 'nullserials');
    const line = picklist.lines[0]!;
    const res = await pick(bodyFor(line, { serials: null })).expect(201);
    expect(res.body.pick.lineStatus).toBe('picked');
    expect(await ledgerFor(line.id)).toHaveLength(1);
  });

  it('a queued pick whose hold expired before replay is a deterministic 409 and persists nothing', async () => {
    // The normal offline case: the op sat in the device queue past the
    // hold's TTL, the reaper expired it, and the replay lands on a
    // non-`held` reservation. `commitInTx` is the conditional UPDATE that
    // must refuse it — a silent re-commit of an expired hold would settle
    // stock nobody is holding any more.
    const skuId = sku('PCK-AUTH');
    await seedStock(skuId, binA, 9);
    const { picklist } = await releasedWave([{ skuId, quantity: 9 }], 'expired');
    const line = picklist.lines[0]!;
    // binA carries other scenarios' stock too — compare against what it held
    // a moment ago, not an absolute figure.
    const before = await onHand(skuId, line.binId!);
    await sql`update reservations set state = 'expired' where id = ${line.reservationId!}`;

    const key = ulid();
    const refused = await pick(bodyFor(line), operatorToken, key).expect(409);
    expect(refused.body.detail).toMatch(/already terminal/i);

    // The whole transaction rolled back: no draw, no pick row, the line still
    // planned, and the key unconsumed so the op stays replayable.
    expect(await ledgerFor(line.id)).toHaveLength(0);
    expect(await onHand(skuId, line.binId!)).toBe(before);
    expect(await lineStatus(line.id)).toBe('planned');
    expect(await reservationState(line.reservationId!)).toBe('expired');
    const picks = await sql`select id from picks where tenant_id = ${tenantId} and picklist_line_id = ${line.id}`;
    expect(picks).toHaveLength(0);
    const keys = await sql`select id from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
    expect(keys).toHaveLength(0);
  });

  // ── the schema contract: RLS + the 0019 CHECKs ────────────────────────────

  it('RLS on `picks`: foreign rows are invisible, own rows are visible, a foreign insert is 42501; the qty and reservation-pairing CHECKs hold', async () => {
    // A real foreign tenant with a REAL `picks` row — counting a table that
    // holds nothing returns 0 with RLS on or off.
    const foreignEmail = `foreign-${ulid().toLowerCase()}@example.com`;
    const foreign = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Foreign Pick Co ${ulid()}`, ownerEmail: foreignEmail, password: 'correct-horse-battery' })
      .expect(201);
    const foreignTenantId = foreign.body.tenant.id as string;
    createdTenantIds.push(foreignTenantId);
    const foreignPickId = uuidv7();
    await sql`
      insert into picks
        (id, tenant_id, warehouse_id, wave_id, picklist_id, picklist_line_id, order_id, order_line_id,
         sku_id, bin_id, qty, picked_by, picked_at, device_id)
      values
        (${foreignPickId}, ${foreignTenantId}, ${warehouseId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()},
         ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${binA}, 1, ${uuidv7()}, now(), ${uuidv7()})
    `;
    // …and at least one of OUR OWN, so the "visible" half is not vacuous.
    const ownSkuId = sku('PCK-REUSE');
    await seedStock(ownSkuId, binA, 4);
    const { picklist } = await releasedWave([{ skuId: ownSkuId, quantity: 4 }], 'rls');
    await pick(bodyFor(picklist.lines[0]!)).expect(201);

    // The two CHECKs, through the privileged handle (RLS is not what refuses
    // these — the constraints are).
    await expect(
      sql`
        insert into picks
          (id, tenant_id, warehouse_id, wave_id, picklist_id, picklist_line_id, order_id, order_line_id,
           sku_id, bin_id, qty, picked_by, picked_at, device_id)
        values
          (${uuidv7()}, ${tenantId}, ${warehouseId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()},
           ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${binA}, 0, ${uuidv7()}, now(), ${uuidv7()})
      `,
    ).rejects.toThrow(/picks_qty_positive/i);
    await expect(
      sql`
        insert into picks
          (id, tenant_id, warehouse_id, wave_id, picklist_id, picklist_line_id, order_id, order_line_id,
           sku_id, bin_id, qty, reservation_id, reservation_committed, picked_by, picked_at, device_id)
        values
          (${uuidv7()}, ${tenantId}, ${warehouseId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()},
           ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${binA}, 1, null, true, ${uuidv7()}, now(), ${uuidv7()})
      `,
    ).rejects.toThrow(/picks_reservation_pairing/i);

    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1 });
    try {
      await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
      // The foreign row exists through the privileged connection…
      const seeded = await sql`select count(*)::int as n from picks where tenant_id = ${foreignTenantId}`;
      expect(Number((seeded[0] as unknown as { n: number }).n)).toBeGreaterThan(0);
      // …and is invisible through the scoped role.
      const foreignRows = await rls.unsafe(
        `select count(*)::int as n from picks where tenant_id = '${foreignTenantId}'::uuid`,
      );
      expect(Number((foreignRows[0] as unknown as { n: number }).n)).toBe(0);
      // …while our own rows are visible through it.
      const own = await rls.unsafe(
        `select count(*)::int as n from picks where tenant_id = '${tenantId}'::uuid`,
      );
      expect(Number((own[0] as unknown as { n: number }).n)).toBeGreaterThan(0);
      // The write side fails closed too (the WITH CHECK arm).
      await expect(
        rls.unsafe(
          `insert into picks
             (id, tenant_id, warehouse_id, wave_id, picklist_id, picklist_line_id, order_id, order_line_id,
              sku_id, bin_id, qty, picked_by, picked_at, device_id)
           values
             ('${uuidv7()}'::uuid, '${foreignTenantId}'::uuid, '${warehouseId}'::uuid, '${uuidv7()}'::uuid,
              '${uuidv7()}'::uuid, '${uuidv7()}'::uuid, '${uuidv7()}'::uuid, '${uuidv7()}'::uuid,
              '${uuidv7()}'::uuid, '${binA}'::uuid, 1, '${uuidv7()}'::uuid, now(), '${uuidv7()}'::uuid)`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await rls.end();
    }
  });

  // ── the sealed offline surface ────────────────────────────────────────────

  it('the device catalog snapshot carries pickTasks in walk order, and a picked line drops out of it', async () => {
    const skuId = sku('PCK-SNAP');
    const binH = await createBin('A-05-02');
    const binI = await createBin('A-05-01');
    await seedStock(skuId, binH, 4);
    await seedStock(skuId, binI, 4);
    const { picklist } = await releasedWave([{ skuId, quantity: 8 }], 'snapshot');
    const mine = picklist.lines.filter((candidate) => candidate.status === 'planned');

    const tasks = await snapshotTasks();
    const forThisWalk = tasks.filter((task) => mine.some((line) => line.id === task.picklistLineId));
    expect(forThisWalk).toHaveLength(mine.length);
    // Walk order is `bins.code` ascending — A-05-01 before A-05-02.
    const walkCodes = forThisWalk.map((task) => task.binCode);
    expect([...walkCodes]).toEqual([...walkCodes].sort());
    expect(forThisWalk[0]!.skuCode).toBe('PCK-SNAP');

    const first = mine.find((line) => line.binId === binI)!;
    await pick(bodyFor(first)).expect(201);
    const after = await snapshotTasks();
    expect(after.some((task) => task.picklistLineId === first.id)).toBe(false);
  });
});
