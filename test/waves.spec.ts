import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { WAVE_CLOCK } from '../src/modules/outbound/wave.clock';
import type { WaveClock } from '../src/modules/outbound/wave.clock';
import {
  PICKLIST_LINE_STATUSES,
  PICKLIST_STATUSES,
  WAVE_CUTOFF_TIMEZONE,
  WAVE_GROUPINGS,
  WAVE_STATUSES,
  localTimeOfDay,
} from '../src/modules/outbound/wave.command';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions — the same bootstrap the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// A host that exports any poll interval would boot background workers and
// race these tests — the same convention as the sibling suites.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/** One SKU code per scenario — the suite's deterministic fixture set. */
const SKU_CODES = [
  'WAV-WALK', // the walk-order arm (stock in two bins, out of creation order)
  'WAV-BX', // the batch-vs-single inequality (bin A)
  'WAV-BY', // the batch-vs-single inequality (bin B)
  'WAV-DROP', // order cancelled after waving
  'WAV-SHORT', // reserved units with nowhere pickable to draw them
  'WAV-CUT', // the cutoff arms
  'WAV-RACE', // the concurrent-generate race
  'WAV-CANCEL', // wave cancel frees its orders
  'WAV-AUTH', // the authority arms
  'WAV-SWEEP', // the no-selection sweep + the policy cap
  'WAV-SYS', // the system-owned / retired bin arms of the pickable filter
  'WAV-REUSE', // the idempotency-key-reuse arms
  'WAV-LIST', // the wave-list read
] as const;

/** The batch-tracked SKU — the FEFO half of the planner runs only on this one. */
const BATCH_SKU_CODE = 'WAV-FEFO';

interface PickLine {
  id: string;
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
  policyId: string;
  releasedAt: string | null;
  cancelledAt: string | null;
  picklists: Picklist[];
}

describe('waves: generation, picklists, release and cancellation (e2e, story 4.2)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let valkey: Redis;
  const createdTenantIds: string[] = [];

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let operatorToken: string;
  let accountantToken: string;
  let warehouseId: string;
  /** Storage bins, deliberately created OUT of code order (the walk is by code). */
  let binB: string;
  let binA: string;
  let binC: string;
  let zoneId: string;
  const skuIds = new Map<string, string>();

  beforeAll(async () => {
    // Same deployment-parity probes as the sibling suites (auth + RLS roles,
    // serialized by the advisory lock).
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await admin.begin(async (tx) => {
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

    // ── tenant + four roles (owner, ops_manager, operator, accountant) ────
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Wave Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
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

    const roles: [string, string][] = [
      ['ops_manager', 'ops-password-123'],
      ['operator', 'floor-password-123'],
      ['accountant', 'books-password-123'],
    ];
    const tokens: string[] = [];
    for (const [role, password] of roles) {
      const inviteeEmail = `${role}-${ulid().toLowerCase()}@example.com`;
      const invited = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/users`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email: inviteeEmail, role })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password })
        .expect(200);
      tokens.push(await signIn(inviteeEmail, password));
    }
    opsToken = tokens[0]!;
    operatorToken = tokens[1]!;
    accountantToken = tokens[2]!;

    // ── warehouse → zone → bins ───────────────────────────────────────────
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `WAV-${ulid().slice(10, 16).toUpperCase()}`, name: `Wave WH ${ulid()}` })
      .expect(201);
    warehouseId = warehouse.body.id as string;
    const zone = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body as { id: string };
    zoneId = zone.id;
    const createBin = async (code: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.id}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 10000, type: 'shelf', code })
          .expect(201)
      ).body.id as string;
    // Created B → A → C on purpose: the walk is `bins.code` ascending, not
    // creation order, so an assertion on A-before-B-before-C is meaningful.
    binB = await createBin('A-01-02');
    binA = await createBin('A-01-01');
    binC = await createBin('A-01-03');

    // ── all scenario SKUs via catalog import ───────────────────────────────
    const csvHeader =
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    const csv = [
      csvHeader,
      ...SKU_CODES.map((code) => `${code},Test SKU ${code},pcs,,1800,,false,false,,,`),
      // Batch-tracked: its bins carry `batch_on_hand` rows, so the planner's
      // FEFO ranking, blocked/expired exclusion and per-bin budget all run.
      `${BATCH_SKU_CODE},Test SKU ${BATCH_SKU_CODE},pcs,,1800,,true,false,,,`,
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
      if (
        (SKU_CODES as readonly string[]).includes(item.code) ||
        item.code === BATCH_SKU_CODE
      ) {
        skuIds.set(item.code, item.id);
      }
    }
    expect(skuIds.size).toBe(SKU_CODES.length + 1);

    // Cold-start bootstrap: seed the tenant's reservation counters + ready
    // marker from the (still empty) journal.
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
  });

  afterEach(() => {
    // Every clock stub is per-test: a leaked fake "now" would silently move
    // every later cutoff comparison.
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupRows();
    await valkey.quit().catch(() => valkey.disconnect());
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
  });

  async function cleanupRows(): Promise<void> {
    if (createdTenantIds.length === 0) return;
    const cleaner = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      for (const table of [
        'picklist_lines',
        'picklists',
        'waves',
        'wave_policies',
        'order_lines',
        'orders',
      ]) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [
          createdTenantIds,
        ]);
      }
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [
        createdTenantIds,
      ]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      for (const table of [
        'reservations',
        'batch_on_hand',
        'stock_on_hand',
        'ledger_anchors',
        'outbox_messages',
        'idempotency_keys',
        'audit_events',
        'catalog_import_errors',
        'catalog_imports',
        'uom_conversions',
        'batches',
        'skus',
        'bins',
        'zones',
        'warehouses',
        'users',
        'tenants',
      ]) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [
          createdTenantIds,
        ]);
      }
      for (const tenant of createdTenantIds) {
        const keys = await valkey.keys(`wms:{${tenant}}:*`);
        if (keys.length > 0) {
          await valkey.del(...keys);
        }
      }
    } finally {
      await cleaner.end();
    }
  }

  // ── fixtures ───────────────────────────────────────────────────────────────

  /**
   * A second warehouse (+ zone + one storage bin) for the scenarios that
   * must own every order in their warehouse — a no-selection sweep reads
   * them all.
   */
  async function freshWarehouse(tag: string): Promise<{ warehouseId: string; binId: string }> {
    const warehouse = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: `${tag}-${ulid().slice(10, 16).toUpperCase()}`, name: `${tag} WH ${ulid()}` })
      .expect(201);
    const id = warehouse.body.id as string;
    const zone = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${id}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body as { id: string };
    const binId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${id}/zones/${zone.id}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 10000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, id);
    return { warehouseId: id, binId };
  }

  /** Seeds committed on-hand of a batch-tracked SKU (the adjustment's batch arm). */
  async function seedBatchStock(
    skuId: string,
    binId: string,
    quantity: number,
    batch: { code: string; expiryDate?: string },
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
        note: `waves-suite batch ${batch.code}`,
        batch,
      })
      .expect(201);
  }

  /** An instant `days` from now, as the catalog's ISO-8601 UTC expiry shape. */
  function daysFromNow(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString();
  }

  /** Seeds committed on-hand into one bin via the stock.adjustment command. */
  async function seedStock(
    skuId: string,
    binId: string,
    quantity: number,
    inWarehouse: string = warehouseId,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: inWarehouse,
        skuId,
        binId,
        quantityDelta: quantity,
        reasonCode: 'cycle-count',
        note: 'waves-suite seed',
      })
      .expect(201);
  }

  async function createOrder(
    lines: { skuId: string; quantity: number }[],
    inWarehouse: string = warehouseId,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: inWarehouse, lines })
      .expect(201);
    return res.body.order.id as string;
  }

  async function cancelOrder(orderId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
  }

  function createPolicy(
    body: Record<string, unknown>,
    token: string = opsToken,
    key: string = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/wave-policies`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, ...body });
  }

  async function policyId(
    name: string,
    grouping: 'single' | 'batch',
    extra: Record<string, unknown> = {},
    inWarehouse: string = warehouseId,
  ): Promise<string> {
    const res = await createPolicy({ name, grouping, warehouseId: inWarehouse, ...extra }).expect(201);
    return res.body.policy.id as string;
  }

  function generate(
    body: Record<string, unknown>,
    token: string = opsToken,
    key: string = ulid(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, ...body });
  }

  function release(waveId: string, token: string = opsToken, key: string = ulid()): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({});
  }

  function cancelWave(waveId: string, token: string = opsToken, key: string = ulid()): request.Test {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({});
  }

  async function getWave(waveId: string): Promise<Wave> {
    const res = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    return res.body.wave as Wave;
  }

  async function outboxTypes(type: string, targetId: string): Promise<number> {
    const rows = await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = ${type}
    `;
    return rows.filter(
      (row) => (row as unknown as { payload: { wave: { id: string } } }).payload.wave.id === targetId,
    ).length;
  }

  async function outboxPolicyCount(policyId: string): Promise<number> {
    const rows = await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'wave.policy-created'
    `;
    return rows.filter(
      (row) => (row as unknown as { payload: { policy: { id: string } } }).payload.policy.id === policyId,
    ).length;
  }

  async function auditCount(action: string, targetId: string): Promise<number> {
    const rows = await sql`
      select id from audit_events
      where tenant_id = ${tenantId} and action = ${action} and target_id = ${targetId}
    `;
    return rows.length;
  }

  /** Freezes the wave clock at an instant (both cutoff sides are assertable). */
  function freezeClock(isoInstant: string): void {
    const clock = app.get<WaveClock>(WAVE_CLOCK);
    jest.spyOn(clock, 'now').mockReturnValue(new Date(isoInstant));
  }

  // ── the module's arm registries ────────────────────────────────────────────

  it('the wave state machines are the outbound module’s own additive arm sets', () => {
    expect([...WAVE_STATUSES]).toEqual(['planned', 'released', 'cancelled']);
    expect([...PICKLIST_STATUSES]).toEqual(['planned', 'ready', 'cancelled']);
    // Story 4.3 appends `picked` — additive, and deliberately OUTSIDE
    // `cancelled` so a picked line keeps its claim in the one-open-wave
    // partial unique index.
    expect([...PICKLIST_LINE_STATUSES]).toEqual(['planned', 'unfulfillable', 'picked', 'cancelled']);
    expect([...WAVE_GROUPINGS]).toEqual(['single', 'batch']);
    // The cutoff timezone is a named module constant, not a per-warehouse
    // column: `warehouses` carries no timezone and the product is India-only.
    expect(WAVE_CUTOFF_TIMEZONE).toBe('Asia/Kolkata');
    // 11:00Z is 16:30 in Kolkata (UTC+5:30) — the conversion the cutoff rides.
    expect(localTimeOfDay(new Date('2026-09-11T11:00:00Z'))).toBe('16:30');
    expect(localTimeOfDay(new Date('2026-09-11T03:30:00Z'))).toBe('09:00');
  });

  // ── wave policies ──────────────────────────────────────────────────────────

  it('policy create: 201 with the cutoff timezone named; the name is unique per warehouse; the list reads it back', async () => {
    const name = `Cutoff 16 ${ulid().slice(0, 8)}`;
    const carrierRef = uuidv7();
    const created = await createPolicy({
      name,
      grouping: 'batch',
      priority: 5,
      maxOrders: 20,
      cutoffLocalTime: '16:00',
      carrierRef,
    }).expect(201);
    expect(created.body.policy).toMatchObject({
      name,
      grouping: 'batch',
      priority: 5,
      maxOrders: 20,
      cutoffLocalTime: '16:00',
      cutoffTimezone: 'Asia/Kolkata',
      // Shape-validated only: no carriers table exists until 4.6 / Epic 7 —
      // exactly the `orders.integration_id` precedent 4.1 set.
      carrierRef,
      warehouseId,
    });

    const duplicate = await createPolicy({ name, grouping: 'single' }).expect(409);
    expect((duplicate.body as { code: string }).code).toBe('conflict');

    // The in-tx outbox row + the audit row committed WITH the policy (AD-7).
    const policyIdCreated = created.body.policy.id as string;
    expect(await outboxPolicyCount(policyIdCreated)).toBe(1);
    expect(await auditCount('wave.policy-created', policyIdCreated)).toBe(1);

    const list = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/wave-policies`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    expect(
      (list.body.items as { id: string }[]).some(
        (item) => item.id === (created.body.policy.id as string),
      ),
    ).toBe(true);
  });

  it('policy create: a malformed cutoff is a 400 and an operator/accountant is role-denied', async () => {
    const bad = await createPolicy({ name: `Bad ${ulid()}`, grouping: 'single', cutoffLocalTime: '25:00' }).expect(400);
    expect((bad.body as { code: string }).code).toBe('validation-failed');

    // Midnight passes the HH:MM shape but is never a usable cutoff: "is the
    // local wall clock past 00:00" is true at every instant except that one
    // minute, so the policy would refuse release all day, every day.
    const midnight = await createPolicy({
      name: `Midnight ${ulid()}`,
      grouping: 'single',
      cutoffLocalTime: '00:00',
    }).expect(400);
    expect((midnight.body as { code: string }).code).toBe('validation-failed');
    // One minute later is legal.
    await createPolicy({ name: `Just after ${ulid()}`, grouping: 'single', cutoffLocalTime: '00:01' }).expect(201);

    for (const token of [operatorToken, accountantToken]) {
      const denied = await createPolicy({ name: `Denied ${ulid()}`, grouping: 'single' }, token).expect(403);
      expect((denied.body as { code: string }).code).toBe('role-denied');
    }
  });

  // ── generation ─────────────────────────────────────────────────────────────

  it('single-order wave: 201 planned with one picklist whose lines walk in bins.code order, quantities from reservedQty', async () => {
    const skuId = skuIds.get('WAV-WALK')!;
    // 6 units in A-01-02 (created first) and 4 in A-01-01 (created second):
    // the walk must still start at A-01-01.
    await seedStock(skuId, binB, 6);
    await seedStock(skuId, binA, 4);
    const orderId = await createOrder([{ skuId, quantity: 10 }]);
    const policy = await policyId(`Single walk ${ulid().slice(0, 8)}`, 'single');

    const res = await generate({ policyId: policy, orderIds: [orderId] }).expect(201);
    const wave = res.body.wave as Wave;
    expect(wave.status).toBe('planned');
    expect(wave.picklists).toHaveLength(1);
    const picklist = wave.picklists[0]!;
    expect(picklist.orderId).toBe(orderId);
    expect(picklist.status).toBe('planned');
    expect(picklist.lines.map((line) => line.binCode)).toEqual(['A-01-01', 'A-01-02']);
    expect(picklist.lines.map((line) => line.walkSeq)).toEqual([0, 1]);
    // The pool is consumed as it is planned: A-01-01's 4 units first, then
    // the remaining 6 from A-01-02 — total is the line's reservedQty.
    expect(picklist.lines.map((line) => line.qty)).toEqual([4, 6]);
    expect(picklist.stopCount).toBe(2);
    // Every line carries the order line's EXISTING hold forward; nothing is
    // re-reserved here and no bin-level claim is made.
    for (const line of picklist.lines) {
      expect(line.reservationId).not.toBeNull();
      expect(line.status).toBe('planned');
      expect(line.shortfallQty).toBe(0);
    }

    // The in-tx outbox row + the audit row committed WITH the wave (AD-7).
    expect(await outboxTypes('wave.generated', wave.id)).toBe(1);
    expect(await auditCount('wave.generated', wave.id)).toBe(1);

    // The detail read serves the same shape the write answered.
    expect(await getWave(wave.id)).toMatchObject({ id: wave.id, status: 'planned' });
  });

  it('generate: no eligible order is 422 no-eligible-orders, and an order already on an open wave is 409 naming that wave', async () => {
    const skuId = skuIds.get('WAV-CANCEL')!;
    await seedStock(skuId, binA, 5);
    const orderId = await createOrder([{ skuId, quantity: 5 }]);
    const policy = await policyId(`Claim ${ulid().slice(0, 8)}`, 'single');
    const first = await generate({ policyId: policy, orderIds: [orderId] }).expect(201);
    const waveId = (first.body.wave as Wave).id;

    const second = await generate({ policyId: policy, orderIds: [orderId] }).expect(409);
    expect((second.body as { code: string; detail: string }).code).toBe('conflict');
    expect((second.body as { detail: string }).detail).toContain(waveId);

    // Cancelling the wave frees its orders: the same order waves again.
    await cancelWave(waveId).expect(200);
    const third = await generate({ policyId: policy, orderIds: [orderId] }).expect(201);
    expect((third.body.wave as Wave).id).not.toBe(waveId);
    await cancelWave((third.body.wave as Wave).id).expect(200);

    // Nothing left that is free to wave in a warehouse with no open orders
    // for this policy: an unknown order id is a 404, a cancelled one a 422.
    await cancelOrder(orderId);
    const gone = await generate({ policyId: policy, orderIds: [orderId] }).expect(422);
    expect((gone.body as { code: string }).code).toBe('no-eligible-orders');
    const unknown = await generate({ policyId: policy, orderIds: [uuidv7()] }).expect(404);
    expect((unknown.body as { code: string }).code).toBe('not-found');
  });

  it('batch wave: ONE picklist, each bin visited once, and total stops ≤ the sum of the same orders’ single-order stops', async () => {
    const skuX = skuIds.get('WAV-BX')!;
    const skuY = skuIds.get('WAV-BY')!;
    // X lives only in A-01-01, Y only in A-01-02 — three orders each need both.
    await seedStock(skuX, binA, 300);
    await seedStock(skuY, binB, 300);
    const orderIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      orderIds.push(
        await createOrder([
          { skuId: skuX, quantity: 10 },
          { skuId: skuY, quantity: 10 },
        ]),
      );
    }

    const batchPolicy = await policyId(`Batch ${ulid().slice(0, 8)}`, 'batch');
    const batched = (await generate({ policyId: batchPolicy, orderIds }).expect(201)).body
      .wave as Wave;
    expect(batched.picklists).toHaveLength(1);
    const picklist = batched.picklists[0]!;
    expect(picklist.orderId).toBeNull();
    // Every bin is ONE stop however many lines are picked there, and each
    // bin's lines are contiguous on the walk — that IS "visits each bin at
    // most once".
    const walkCodes = picklist.lines.map((line) => line.binCode);
    expect(walkCodes).toEqual([...walkCodes].sort());
    const runs = walkCodes.filter((code, index) => index === 0 || code !== walkCodes[index - 1]);
    expect(new Set(runs).size).toBe(runs.length);
    expect(picklist.stopCount).toBe(2);
    expect(picklist.lines).toHaveLength(6); // 3 orders × 2 SKUs
    expect(new Set(picklist.lines.map((line) => line.orderId)).size).toBe(3);

    // The inequality, measured against the real alternative: cancel the
    // batch wave (which frees the orders) and wave the SAME orders single.
    await cancelWave(batched.id).expect(200);
    const singlePolicy = await policyId(`Batch-vs-single ${ulid().slice(0, 8)}`, 'single');
    const singles = (await generate({ policyId: singlePolicy, orderIds }).expect(201)).body
      .wave as Wave;
    expect(singles.picklists).toHaveLength(3);
    const singleStops = singles.picklists.reduce((sum, list) => sum + list.stopCount, 0);
    expect(singleStops).toBe(6);
    expect(picklist.stopCount).toBeLessThanOrEqual(singleStops);
    await cancelWave(singles.id).expect(200);
  });

  it('a line whose reserved units sit nowhere pickable plans as unfulfillable with the shortfall named — the wave still generates', async () => {
    const skuId = skuIds.get('WAV-SHORT')!;
    // The stock is real (so acceptance reserves it) but its bin is blocked,
    // which is exactly what "not pickable" means (putaway's filter set).
    await seedStock(skuId, binC, 7);
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binC}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ blocked: true })
      .expect(200);
    const orderId = await createOrder([{ skuId, quantity: 7 }]);
    const policy = await policyId(`Short ${ulid().slice(0, 8)}`, 'single');

    const wave = (await generate({ policyId: policy, orderIds: [orderId] }).expect(201)).body
      .wave as Wave;
    const picklist = wave.picklists[0]!;
    expect(picklist.lines).toHaveLength(1);
    expect(picklist.lines[0]).toMatchObject({
      status: 'unfulfillable',
      binId: null,
      binCode: null,
      qty: 0,
      shortfallQty: 7,
    });
    expect(picklist.stopCount).toBe(0);

    // Unblock for the rest of the suite and free the order again.
    await cancelWave(wave.id).expect(200);
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binC}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ blocked: false })
      .expect(200);
  });

  it('generate without an explicit selection sweeps every eligible accepted order, oldest first, capped by the policy — and a claimed order is never swept twice', async () => {
    // A warehouse of its own: a sweep with no selection reads EVERY free
    // accepted order in the warehouse, so the other scenarios' leftovers
    // would otherwise decide which two orders the cap takes.
    const sweep = await freshWarehouse('SWEEP');
    const skuId = skuIds.get('WAV-SWEEP')!;
    await seedStock(skuId, sweep.binId, 100, sweep.warehouseId);
    const first = await createOrder([{ skuId, quantity: 1 }], sweep.warehouseId);
    const second = await createOrder([{ skuId, quantity: 1 }], sweep.warehouseId);
    const third = await createOrder([{ skuId, quantity: 1 }], sweep.warehouseId);
    // maxOrders 2: the sweep takes the two OLDEST and leaves the third.
    const policy = await policyId(`Sweep ${ulid().slice(0, 8)}`, 'batch', { maxOrders: 2 }, sweep.warehouseId);

    const swept = (await generate({ policyId: policy, warehouseId: sweep.warehouseId }).expect(201)).body.wave as Wave;
    const sweptOrders = new Set(
      swept.picklists.flatMap((list) => list.lines).map((line) => line.orderId),
    );
    expect(sweptOrders.has(first)).toBe(true);
    expect(sweptOrders.has(second)).toBe(true);
    expect(sweptOrders.has(third)).toBe(false);

    // A second sweep cannot re-claim the first two — only the third is free.
    const rest = (await generate({ policyId: policy, warehouseId: sweep.warehouseId }).expect(201))
      .body.wave as Wave;
    const restOrders = new Set(
      rest.picklists.flatMap((list) => list.lines).map((line) => line.orderId),
    );
    expect([...restOrders]).toEqual([third]);

    // Now nothing is free at all.
    const empty = await generate({ policyId: policy, warehouseId: sweep.warehouseId }).expect(422);
    expect((empty.body as { code: string }).code).toBe('no-eligible-orders');

    await cancelWave(swept.id).expect(200);
    await cancelWave(rest.id).expect(200);
  });

  it('a batch-tracked SKU plans FEFO within the bin: the soonest-expiring drawable batch first, blocked and expired batches never suggested, and the per-bin sum never exceeds the bin’s on-hand', async () => {
    const skuId = skuIds.get(BATCH_SKU_CODE)!;
    // All four batches sit in ONE bin so the ordering under test is the
    // batch ranking, not the bin walk.
    await seedBatchStock(skuId, binA, 4, { code: 'FEFO-LATE', expiryDate: daysFromNow(90) });
    await seedBatchStock(skuId, binA, 3, { code: 'FEFO-SOON', expiryDate: daysFromNow(5) });
    await seedBatchStock(skuId, binA, 6, { code: 'FEFO-GONE', expiryDate: daysFromNow(-1) });
    await seedBatchStock(skuId, binA, 5, { code: 'FEFO-BLOCKED', expiryDate: daysFromNow(60) });
    // No block-a-batch command exists yet (the catalog lifecycle flag is set
    // by Epic 2's machinery); flip the identity directly — the planner reads
    // `batches.status`, which is the contract under test.
    await sql`
      update batches set status = 'blocked'
      where tenant_id = ${tenantId} and sku_id = ${skuId} and code = 'FEFO-BLOCKED'
    `;

    // 18 units on hand, but only FEFO-SOON (3) + FEFO-LATE (4) are drawable.
    const orderId = await createOrder([{ skuId, quantity: 9 }]);
    const policy = await policyId(`Fefo ${ulid().slice(0, 8)}`, 'single');
    const wave = (await generate({ policyId: policy, orderIds: [orderId] }).expect(201)).body
      .wave as Wave;
    const lines = wave.picklists[0]!.lines;

    const byBatch = new Map<string, string>();
    for (const code of ['FEFO-LATE', 'FEFO-SOON', 'FEFO-GONE', 'FEFO-BLOCKED']) {
      const row = await sql`
        select id from batches where tenant_id = ${tenantId} and sku_id = ${skuId} and code = ${code}
      `;
      byBatch.set((row[0] as unknown as { id: string }).id, code);
    }
    const drawn = lines
      .filter((line) => line.status !== 'unfulfillable')
      .map((line) => ({ batch: byBatch.get(line.batchId!)!, qty: line.qty }));
    // FEFO: the soonest expiry first, then the later one. Neither the expired
    // nor the blocked batch is ever suggested.
    expect(drawn).toEqual([
      { batch: 'FEFO-SOON', qty: 3 },
      { batch: 'FEFO-LATE', qty: 4 },
    ]);
    // The bin held 18 units but only 7 were drawable: the remaining 2 of the
    // 9 reserved are named as a shortfall, not quietly planned against the
    // blocked/expired stock.
    const short = lines.find((line) => line.status === 'unfulfillable')!;
    expect(short.shortfallQty).toBe(2);
    // Every drawn slice names the same single bin — one stop.
    expect(wave.picklists[0]!.stopCount).toBe(1);
    // And the per-bin sum never exceeded the bin's plain on-hand.
    expect(drawn.reduce((sum, slice) => sum + slice.qty, 0)).toBeLessThanOrEqual(18);

    await cancelWave(wave.id).expect(200);
  });

  it('the pickable-bin filter excludes system-owned and retired bins, not just blocked ones', async () => {
    const skuId = skuIds.get('WAV-SYS')!;
    // A system-owned bin (Receiving, QC-hold) holds real stock and is never
    // a pick stop. The tenancy facade creates those lazily on the first
    // receipt, which this suite has none of — flip the flag on a bin of our
    // own instead: `bins.system_owned` is the contract the planner reads.
    const systemBin = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 10000, type: 'staging', code: `A-08-${ulid().slice(20, 22)}` })
        .expect(201)
    ).body.id as string;
    await seedStock(skuId, systemBin, 4);
    await sql`update bins set system_owned = true where id = ${systemBin}`;

    // A retired bin is operationally gone. Retirement is terminal and only
    // a merge produces it (3.6), so retire a spare bin by merging it away.
    const spare = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 10000, type: 'shelf', code: `A-09-${ulid().slice(20, 22)}` })
        .expect(201)
    ).body.id as string;
    await seedStock(skuId, spare, 6);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${spare}/merge`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ targetBinId: binC })
      .expect(200);
    // The merge moved the 6 units into A-01-03 and retired the source; put
    // them somewhere unpickable again so ONLY unpickable stock remains.
    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binC}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ blocked: true })
      .expect(200);

    const orderId = await createOrder([{ skuId, quantity: 10 }]);
    const policy = await policyId(`System bins ${ulid().slice(0, 8)}`, 'single');
    const wave = (await generate({ policyId: policy, orderIds: [orderId] }).expect(201)).body
      .wave as Wave;
    const picklist = wave.picklists[0]!;
    // Ten units of on-hand exist — all of it in a system bin, a retired bin's
    // successor that is blocked. None of it is pickable.
    expect(picklist.lines).toHaveLength(1);
    expect(picklist.lines[0]).toMatchObject({ status: 'unfulfillable', binId: null, shortfallQty: 10 });
    expect(picklist.stopCount).toBe(0);
    // Nothing pickable → the picklist never reaches the floor.
    const released = (await release(wave.id).expect(200)).body.wave as Wave;
    expect(released.picklists[0]!.status).toBe('cancelled');

    await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${binC}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ blocked: false })
      .expect(200);
  });

  // ── release ────────────────────────────────────────────────────────────────

  it('release: 200 released with picklists ready, one wave.released event + one audit row; a second release under a NEW key is an idempotent no-op', async () => {
    const skuId = skuIds.get('WAV-WALK')!;
    await seedStock(skuId, binA, 20);
    const orderId = await createOrder([{ skuId, quantity: 5 }]);
    const policy = await policyId(`Release ${ulid().slice(0, 8)}`, 'single');
    const wave = (await generate({ policyId: policy, orderIds: [orderId] }).expect(201)).body
      .wave as Wave;

    const released = (await release(wave.id).expect(200)).body.wave as Wave;
    expect(released.status).toBe('released');
    expect(released.releasedAt).not.toBeNull();
    expect(released.picklists.map((list) => list.status)).toEqual(['ready']);
    expect(await outboxTypes('wave.released', wave.id)).toBe(1);
    expect(await auditCount('wave.released', wave.id)).toBe(1);

    // A NEW key on an already-released wave: 200 with the settled snapshot,
    // no second event, no second audit row.
    const again = (await release(wave.id).expect(200)).body.wave as Wave;
    expect(again.status).toBe('released');
    expect(again.releasedAt).toBe(released.releasedAt);
    expect(await outboxTypes('wave.released', wave.id)).toBe(1);
    expect(await auditCount('wave.released', wave.id)).toBe(1);

    // A replay under the ORIGINAL key re-serves the stored snapshot.
    const key = ulid();
    const first = await release(wave.id, opsToken, key).expect(200);
    const replay = await release(wave.id, opsToken, key).expect(200);
    expect(replay.body).toEqual(first.body);
  });

  it('an order cancelled after being planned onto an unreleased wave loses its pick lines at release', async () => {
    const skuId = skuIds.get('WAV-DROP')!;
    await seedStock(skuId, binA, 40);
    const keptOrder = await createOrder([{ skuId, quantity: 5 }]);
    const doomedOrder = await createOrder([{ skuId, quantity: 5 }]);
    const policy = await policyId(`Drop ${ulid().slice(0, 8)}`, 'single');
    const wave = (
      await generate({ policyId: policy, orderIds: [keptOrder, doomedOrder] }).expect(201)
    ).body.wave as Wave;
    expect(wave.picklists).toHaveLength(2);
    expect(wave.picklists.flatMap((list) => list.lines).some((line) => line.orderId === doomedOrder)).toBe(true);

    await cancelOrder(doomedOrder);
    const released = (await release(wave.id).expect(200)).body.wave as Wave;

    const lines = released.picklists.flatMap((list) => list.lines);
    // Gone from the WALK: the doomed order's lines carry no live status and
    // are no stop on any picklist. (They are flipped `cancelled`, not
    // deleted — `cancelWave` frees claims the same way, and the row keeps
    // the record that those units were once planned onto this wave.)
    const doomedLines = lines.filter((line) => line.orderId === doomedOrder);
    expect(doomedLines.length).toBeGreaterThan(0);
    expect(doomedLines.every((line) => line.status === 'cancelled')).toBe(true);
    expect(
      lines.some((line) => line.orderId === keptOrder && line.status !== 'cancelled'),
    ).toBe(true);
    // The cancelled order's picklist has nothing to pick — it is not shipped
    // to the floor empty.
    const doomedList = released.picklists.find((list) => list.orderId === doomedOrder)!;
    expect(doomedList.status).toBe('cancelled');
    expect(doomedList.stopCount).toBe(0);
    expect(released.picklists.find((list) => list.orderId === keptOrder)!.status).toBe('ready');
  });

  it('release is refused 409 cutoff-passed once the policy cutoff has passed in the Kolkata-local day, and allowed before it', async () => {
    const skuId = skuIds.get('WAV-CUT')!;
    await seedStock(skuId, binA, 40);
    const lateOrder = await createOrder([{ skuId, quantity: 3 }]);
    const earlyOrder = await createOrder([{ skuId, quantity: 3 }]);
    const policy = await policyId(`Cutoff ${ulid().slice(0, 8)}`, 'single', {
      cutoffLocalTime: '16:00',
    });

    // Generation is ALWAYS allowed, cutoff or not — planning ahead of a
    // cutoff is the point.
    freezeClock('2026-09-11T11:00:00Z'); // 16:30 IST — past the cutoff
    const lateWave = (await generate({ policyId: policy, orderIds: [lateOrder] }).expect(201)).body
      .wave as Wave;
    const refused = await release(lateWave.id).expect(409);
    expect((refused.body as { code: string }).code).toBe('cutoff-passed');
    expect((refused.body as { detail: string }).detail).toContain('16:00');
    // Nothing written: the wave stays planned and re-releasable.
    expect((await getWave(lateWave.id)).status).toBe('planned');
    expect(await outboxTypes('wave.released', lateWave.id)).toBe(0);

    // The other side of the same boundary: 09:00 IST on the same policy.
    jest.restoreAllMocks();
    freezeClock('2026-09-11T03:30:00Z'); // 09:00 IST — before the cutoff
    const earlyWave = (await generate({ policyId: policy, orderIds: [earlyOrder] }).expect(201))
      .body.wave as Wave;
    expect(((await release(earlyWave.id).expect(200)).body.wave as Wave).status).toBe('released');
    // And the wave refused a moment ago releases fine now.
    expect(((await release(lateWave.id).expect(200)).body.wave as Wave).status).toBe('released');
  });

  it('a cancelled wave is never released, and cancelling is idempotent under a new key', async () => {
    const skuId = skuIds.get('WAV-CANCEL')!;
    await seedStock(skuId, binA, 10);
    const orderId = await createOrder([{ skuId, quantity: 2 }]);
    const policy = await policyId(`Cancel ${ulid().slice(0, 8)}`, 'single');
    const wave = (await generate({ policyId: policy, orderIds: [orderId] }).expect(201)).body
      .wave as Wave;

    const cancelled = (await cancelWave(wave.id).expect(200)).body.wave as Wave;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.picklists.every((list) => list.status === 'cancelled')).toBe(true);
    expect(
      cancelled.picklists.flatMap((list) => list.lines).every((line) => line.status === 'cancelled'),
    ).toBe(true);
    expect(await outboxTypes('wave.cancelled', wave.id)).toBe(1);

    // A NEW key on an already-cancelled wave is an idempotent no-op.
    expect(((await cancelWave(wave.id).expect(200)).body.wave as Wave).status).toBe('cancelled');
    expect(await outboxTypes('wave.cancelled', wave.id)).toBe(1);

    const refused = await release(wave.id).expect(409);
    expect((refused.body as { code: string }).code).toBe('conflict');
  });

  // ── the race ───────────────────────────────────────────────────────────────

  it('two generate calls racing the same accepted orders: exactly one wave claims them, the loser is refused', async () => {
    const skuId = skuIds.get('WAV-RACE')!;
    await seedStock(skuId, binA, 60);
    const orderIds = [
      await createOrder([{ skuId, quantity: 2 }]),
      await createOrder([{ skuId, quantity: 2 }]),
    ];
    const policy = await policyId(`Race ${ulid().slice(0, 8)}`, 'batch');

    const [left, right] = await Promise.all([
      generate({ policyId: policy, orderIds }),
      generate({ policyId: policy, orderIds }),
    ]);
    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = left.status === 201 ? left : right;
    const loser = left.status === 201 ? right : left;
    expect((loser.body as { code: string }).code).toBe('conflict');
    // The refusal names the wave that actually claimed the orders.
    expect((loser.body as { detail: string }).detail).toContain(
      (winner.body.wave as Wave).id,
    );

    // Exactly one wave holds an open claim on these orders.
    const claims = await sql`
      select distinct wave_id from picklist_lines
      where tenant_id = ${tenantId} and order_id = any(${orderIds}::uuid[]) and status <> 'cancelled'
    `;
    expect(claims).toHaveLength(1);
  });

  // ── authority ──────────────────────────────────────────────────────────────

  it('wrong authority writes nothing: operator/accountant are role-denied, a foreign tenant path is permission-denied, a missing key is a 400', async () => {
    const skuId = skuIds.get('WAV-AUTH')!;
    await seedStock(skuId, binA, 10);
    const orderId = await createOrder([{ skuId, quantity: 2 }]);
    const policy = await policyId(`Auth ${ulid().slice(0, 8)}`, 'single');

    for (const token of [operatorToken, accountantToken]) {
      const denied = await generate({ policyId: policy, orderIds: [orderId] }, token).expect(403);
      expect((denied.body as { code: string }).code).toBe('role-denied');
    }

    // The same gate on BOTH transitions — `waves.manage` covers the whole
    // aggregate, not just generation. A wave has to exist to be refused.
    const gated = (await generate({ policyId: policy, orderIds: [orderId] }).expect(201)).body
      .wave as Wave;
    for (const token of [operatorToken, accountantToken]) {
      expect(((await release(gated.id, token).expect(403)).body as { code: string }).code).toBe(
        'role-denied',
      );
      expect(((await cancelWave(gated.id, token).expect(403)).body as { code: string }).code).toBe(
        'role-denied',
      );
    }
    // Owner holds every capability: the owner arm of the same gate passes.
    expect(((await release(gated.id, ownerToken).expect(200)).body.wave as Wave).status).toBe(
      'released',
    );
    expect(((await cancelWave(gated.id, ownerToken).expect(200)).body.wave as Wave).status).toBe(
      'cancelled',
    );

    const foreign = await request(app.getHttpServer())
      .post(`${API}/${uuidv7()}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy })
      .expect(403);
    expect((foreign.body as { code: string }).code).toBe('permission-denied');

    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ warehouseId, policyId: policy })
      .expect(400);

    await request(app.getHttpServer()).get(`${API}/${tenantId}/outbound/waves/${uuidv7()}`).expect(401);

    // Nothing was written by any of the REFUSALS: the only wave under this
    // policy is the one the permitted owner/ops calls above created.
    const waveRows = await sql`
      select w.id from waves w where w.tenant_id = ${tenantId} and w.policy_id = ${policy}
    `;
    expect(waveRows).toHaveLength(1);

    // The order is free to wave again — the cancelled wave released its
    // claim and the refusals claimed nothing.
    expect(
      ((await generate({ policyId: policy, orderIds: [orderId] }).expect(201)).body.wave as Wave)
        .status,
    ).toBe('planned');
  });

  // ── idempotency ────────────────────────────────────────────────────────────

  it('every wave command compares the payload hash: the same key with a DIFFERENT payload is 422 idempotency-key-reuse, never a replayed answer', async () => {
    const skuId = skuIds.get('WAV-REUSE')!;
    await seedStock(skuId, binA, 30);
    const orderA = await createOrder([{ skuId, quantity: 2 }]);
    const orderB = await createOrder([{ skuId, quantity: 2 }]);

    // policy create
    const policyKey = ulid();
    const firstPolicy = await createPolicy(
      { name: `Reuse A ${ulid().slice(0, 8)}`, grouping: 'single' },
      opsToken,
      policyKey,
    ).expect(201);
    const reusedPolicy = await createPolicy(
      { name: `Reuse B ${ulid().slice(0, 8)}`, grouping: 'single' },
      opsToken,
      policyKey,
    ).expect(422);
    expect((reusedPolicy.body as { code: string }).code).toBe('idempotency-key-reuse');
    const policy = firstPolicy.body.policy.id as string;

    // generate
    const generateKey = ulid();
    const wave = (
      await generate({ policyId: policy, orderIds: [orderA] }, opsToken, generateKey).expect(201)
    ).body.wave as Wave;
    const reusedGenerate = await generate(
      { policyId: policy, orderIds: [orderB] },
      opsToken,
      generateKey,
    ).expect(422);
    expect((reusedGenerate.body as { code: string }).code).toBe('idempotency-key-reuse');

    // release, then cancel — under ONE key each, replayed against the other
    // wave. The two transitions also hash their own action name, so a key
    // that released one wave can never replay as a cancel.
    const other = (await generate({ policyId: policy, orderIds: [orderB] }).expect(201)).body
      .wave as Wave;
    const releaseKey = ulid();
    await release(wave.id, opsToken, releaseKey).expect(200);
    const reusedRelease = await release(other.id, opsToken, releaseKey).expect(422);
    expect((reusedRelease.body as { code: string }).code).toBe('idempotency-key-reuse');
    // The SAME key against the SAME wave, but as a cancel: a different
    // action, so a different hash — refused rather than replaying the
    // release's snapshot.
    const crossAction = await cancelWave(wave.id, opsToken, releaseKey).expect(422);
    expect((crossAction.body as { code: string }).code).toBe('idempotency-key-reuse');

    const cancelKey = ulid();
    await cancelWave(wave.id, opsToken, cancelKey).expect(200);
    const reusedCancel = await cancelWave(other.id, opsToken, cancelKey).expect(422);
    expect((reusedCancel.body as { code: string }).code).toBe('idempotency-key-reuse');
    await cancelWave(other.id).expect(200);
  });

  // ── persistence guards ─────────────────────────────────────────────────────

  it('0018 CHECK constraints: a bogus wave/picklist/line status, a bin-less slice naming units, and an unstamped terminal instant are rejected (23514)', async () => {
    const policy = await policyId(`Checks ${ulid().slice(0, 8)}`, 'single');
    const waveId = uuidv7();
    // The wave status arm.
    await expect(
      sql`
        insert into waves (id, tenant_id, warehouse_id, policy_id, status)
        values (${waveId}, ${tenantId}, ${warehouseId}, ${policy}, 'bogus')
      `,
    ).rejects.toMatchObject({ code: '23514' });
    // The terminal-instant pairing: a released wave always names WHEN.
    await expect(
      sql`
        insert into waves (id, tenant_id, warehouse_id, policy_id, status)
        values (${waveId}, ${tenantId}, ${warehouseId}, ${policy}, 'released')
      `,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`
        insert into waves (id, tenant_id, warehouse_id, policy_id, status)
        values (${waveId}, ${tenantId}, ${warehouseId}, ${policy}, 'cancelled')
      `,
    ).rejects.toMatchObject({ code: '23514' });
    await sql`
      insert into waves (id, tenant_id, warehouse_id, policy_id, status)
      values (${waveId}, ${tenantId}, ${warehouseId}, ${policy}, 'planned')
    `;

    const picklistId = uuidv7();
    await expect(
      sql`
        insert into picklists (id, tenant_id, warehouse_id, wave_id, status)
        values (${picklistId}, ${tenantId}, ${warehouseId}, ${waveId}, 'bogus')
      `,
    ).rejects.toMatchObject({ code: '23514' });
    await sql`
      insert into picklists (id, tenant_id, warehouse_id, wave_id, status)
      values (${picklistId}, ${tenantId}, ${warehouseId}, ${waveId}, 'planned')
    `;

    const lineValues = (
      binId: string | null,
      qty: number,
      shortfall: number,
      status: string,
    ) => sql`
      insert into picklist_lines
        (id, tenant_id, picklist_id, wave_id, order_id, order_line_id, sku_id, bin_id, qty, shortfall_qty, slice_seq, walk_seq, status)
      values
        (${uuidv7()}, ${tenantId}, ${picklistId}, ${waveId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${binId}, ${qty}, ${shortfall}, 0, 0, ${status})
    `;
    // The line status arm.
    await expect(lineValues(binA, 1, 0, 'bogus')).rejects.toMatchObject({ code: '23514' });
    // The slice shape: a bin-less slice may not name units…
    await expect(lineValues(null, 3, 0, 'unfulfillable')).rejects.toMatchObject({ code: '23514' });
    // …and a binned slice may not carry a shortfall, nor zero units.
    await expect(lineValues(binA, 3, 2, 'planned')).rejects.toMatchObject({ code: '23514' });
    await expect(lineValues(binA, 0, 0, 'planned')).rejects.toMatchObject({ code: '23514' });
    // Both legal shapes insert cleanly.
    await lineValues(binA, 3, 0, 'planned');
    await lineValues(null, 0, 4, 'unfulfillable');

    // The policy bounds, for completeness.
    await expect(
      sql`
        insert into wave_policies (id, tenant_id, warehouse_id, name, grouping)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${`Bogus ${ulid()}`}, 'bogus')
      `,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`
        insert into wave_policies (id, tenant_id, warehouse_id, name, grouping, cutoff_local_time)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${`Bad cutoff ${ulid()}`}, 'single', '99:99')
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('RLS on the four wave tables: foreign rows are invisible, own rows are visible, and a foreign-tenant insert is refused (42501)', async () => {
    // A real second tenant, with real rows in every one of the four tables —
    // counting a table that holds nothing returns 0 with RLS on or off.
    const foreignEmail = `foreign-${ulid().toLowerCase()}@example.com`;
    const foreign = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Foreign Co ${ulid()}`, ownerEmail: foreignEmail, password: 'correct-horse-battery' })
      .expect(201);
    const foreignTenantId = foreign.body.tenant.id as string;
    createdTenantIds.push(foreignTenantId);

    const foreignPolicyId = uuidv7();
    const foreignWaveId = uuidv7();
    const foreignPicklistId = uuidv7();
    await sql`
      insert into wave_policies (id, tenant_id, warehouse_id, name, grouping)
      values (${foreignPolicyId}, ${foreignTenantId}, ${warehouseId}, ${`Foreign ${ulid()}`}, 'single')
    `;
    await sql`
      insert into waves (id, tenant_id, warehouse_id, policy_id, status)
      values (${foreignWaveId}, ${foreignTenantId}, ${warehouseId}, ${foreignPolicyId}, 'planned')
    `;
    await sql`
      insert into picklists (id, tenant_id, warehouse_id, wave_id, status)
      values (${foreignPicklistId}, ${foreignTenantId}, ${warehouseId}, ${foreignWaveId}, 'planned')
    `;
    await sql`
      insert into picklist_lines
        (id, tenant_id, picklist_id, wave_id, order_id, order_line_id, sku_id, bin_id, qty, shortfall_qty, slice_seq, walk_seq, status)
      values
        (${uuidv7()}, ${foreignTenantId}, ${foreignPicklistId}, ${foreignWaveId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${binA}, 1, 0, 0, 0, 'planned')
    `;

    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1 });
    try {
      await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
      for (const table of ['wave_policies', 'waves', 'picklists', 'picklist_lines']) {
        // The foreign rows exist (seeded above through the privileged
        // connection) and are invisible through the scoped role…
        const seeded = await sql.unsafe(
          `select count(*)::int as n from ${table} where tenant_id = '${foreignTenantId}'::uuid`,
        );
        expect(Number((seeded[0] as unknown as { n: number }).n)).toBeGreaterThan(0);
        const foreignRows = await rls.unsafe(
          `select count(*)::int as n from ${table} where tenant_id = '${foreignTenantId}'::uuid`,
        );
        expect(Number((foreignRows[0] as unknown as { n: number }).n)).toBe(0);
        // …while the session tenant's OWN rows are visible through it.
        const own = await rls.unsafe(
          `select count(*)::int as n from ${table} where tenant_id = '${tenantId}'::uuid`,
        );
        expect(Number((own[0] as unknown as { n: number }).n)).toBeGreaterThan(0);
      }
      // The write side fails closed too (the WITH CHECK arm).
      await expect(
        rls.unsafe(
          `insert into waves (id, tenant_id, warehouse_id, policy_id, status)
           values ('${uuidv7()}'::uuid, '${foreignTenantId}'::uuid, '${warehouseId}'::uuid, '${foreignPolicyId}'::uuid, 'planned')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      // …while the allowed arm (own tenant_id) inserts cleanly.
      await rls.unsafe(
        `insert into waves (id, tenant_id, warehouse_id, policy_id, status)
         values ('${uuidv7()}'::uuid, '${tenantId}'::uuid, '${warehouseId}'::uuid, '${foreignPolicyId}'::uuid, 'planned')`,
      );
    } finally {
      await rls.end();
    }
  });

  // ── reads ──────────────────────────────────────────────────────────────────

  it('wave reads: the detail 404s on an unknown id, 400s on a malformed one, and the warehouse list paginates by keyset', async () => {
    const malformed = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/waves/not-a-uuid`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(400);
    expect((malformed.body as { code: string }).code).toBe('validation-failed');

    const missing = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/outbound/waves/${uuidv7()}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(404);
    expect((missing.body as { code: string }).code).toBe('not-found');

    const firstPage = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/waves?limit=2`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    const items = firstPage.body.items as { id: string; picklistCount: number }[];
    expect(items.length).toBeLessThanOrEqual(2);
    // The count is real, not a constant: a wave generated through the
    // command has its picklists counted.
    await seedStock(skuIds.get('WAV-LIST')!, binA, 5);
    const counted = (await generate({
      policyId: await policyId(`Counted ${ulid().slice(0, 8)}`, 'single'),
      orderIds: [await createOrder([{ skuId: skuIds.get('WAV-LIST')!, quantity: 1 }])],
    }).expect(201)).body.wave as Wave;
    const listed = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/waves?limit=1`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    expect((listed.body.items as { id: string; picklistCount: number }[])[0]).toMatchObject({
      id: counted.id,
      picklistCount: counted.picklists.length,
    });
    if (firstPage.body.nextCursor !== null) {
      const second = await request(app.getHttpServer())
        .get(
          `${API}/${tenantId}/warehouses/${warehouseId}/outbound/waves?limit=2&cursor=${encodeURIComponent(
            firstPage.body.nextCursor as string,
          )}`,
        )
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200);
      const ids = new Set(items.map((item) => item.id));
      for (const item of second.body.items as { id: string }[]) {
        expect(ids.has(item.id)).toBe(false);
      }
    }

    const badCursor = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/waves?cursor=not-a-cursor`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(400);
    expect((badCursor.body as { code: string }).code).toBe('invalid-cursor');
  });
});
