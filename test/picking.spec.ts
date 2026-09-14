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
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

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
  /** Story 4.3b: the bin state epoch the device captured at task start. */
  binStateEpoch?: number | null;
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
    'PCK-EPOCH', // 4.3b: the snapshot's bin epoch and its movement
    'PCK-EPOCH-APPLY', // 4.3b: case 1 — the epoch moved, the draw still stands
    'PCK-EPOCH-SETTLE', // 4.3b: case 2 — the moved-on bin still covers
    'PCK-EPOCH-SHORT', // 4.3b: case 3 — the moved-on bin is short
    'PCK-EPOCH-DEAD', // 4.3b: case 4 — the hold's premises are gone
    'PCK-EPOCH-NONE', // 4.3b: the no-epoch and unknown-bin arms
    'PCK-EPOCH-HASH', // 4.3b: the epoch is outside the payload hash
    'PCK-EPOCH-NOISE', // 4.3b: the OTHER SKU whose movement bumps a bin epoch
    'PCK-EPOCH-TTL', // 4.3b: expiry is a premise only of the settling slice
    'PCK-EPOCH-BACKSTOP', // 4.3b: the commitInTx guard beneath the case-4 gate
  ] as const;
  const BATCH_SKU_CODE = 'PCK-FEFO';
  /** 4.3b: the batch-arm shortfall, routed by the epoch to 409 or 422. */
  const BATCH_SHORT_SKU_CODE = 'PCK-FEFO3';
  /** Its own batch-tracked SKU: the two-arm draw must be the only claim on its bins. */
  const BATCH_SPAN_SKU_CODE = 'PCK-FEFO2';
  const SERIAL_SKU_CODE = 'PCK-SERIAL';

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    // infra-1: this suite owns its own database (cloned from the template).
    suiteDb = await useSuiteDatabase('picking');
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
      `${BATCH_SHORT_SKU_CODE},Pick SKU ${BATCH_SHORT_SKU_CODE},pcs,,1800,,true,false,,,`,
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
    expect(skuIds.size).toBeGreaterThanOrEqual(SKU_CODES.length + 4);

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
    await suiteDb.drop();
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
    {
      picklistLineId: string;
      binCode: string;
      skuCode: string;
      qty: number;
      walkSeq: number;
      binStateEpoch: number | null;
    }[]
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
      binStateEpoch: number | null;
    }[];
  }

  /**
   * The bin's live state epoch (story 4.3b). Read straight from the table
   * rather than from the snapshot so the epoch tests can force and observe it
   * independently of the projection that serves it.
   */
  async function binEpoch(binId: string): Promise<number | null> {
    const rows = await sql`
      select epoch from bin_state_epochs
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and bin_id = ${binId}
    `;
    const row = rows[0] as unknown as { epoch: string | number } | undefined;
    return row === undefined ? null : Number(row.epoch);
  }

  /** The epoch of one snapshot task, as the DEVICE would have captured it. */
  async function capturedEpoch(picklistLineId: string): Promise<number> {
    const task = (await snapshotTasks()).find(
      (candidate) => candidate.picklistLineId === picklistLineId,
    );
    if (task === undefined) throw new Error(`no snapshot task for line ${picklistLineId}`);
    if (task.binStateEpoch === null) throw new Error('snapshot task carried no bin epoch');
    return task.binStateEpoch;
  }

  async function pickRow(
    picklistLineId: string,
  ): Promise<{ conflict_class: string; reservation_committed: boolean } | undefined> {
    const rows = await sql`
      select conflict_class, reservation_committed from picks
      where tenant_id = ${tenantId} and picklist_line_id = ${picklistLineId}
    `;
    return rows[0] as unknown as
      | { conflict_class: string; reservation_committed: boolean }
      | undefined;
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
    // never a second draw. Story 4.3b classifies it as case 4: the line is
    // drawn and no retry undraws it, so the op is held for review rather than
    // deleted from the device's outbox.
    const second = await pick(bodyFor(line)).expect(409);
    expect(second.body.code).toBe('pick-unresolvable');
    expect(second.body.detail).toMatch(/already picked/i);
    expect(await ledgerFor(line.id)).toHaveLength(1);
  });

  // ── the undifferentiated conflict arm (4.3; 4.3b differentiates it) ──────

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
    // No `binStateEpoch` on the body: a device whose cache predates story
    // 4.3b. The bin's epoch HAS moved (the drain folded through the ledger),
    // but with nothing to compare it against the outcome is exactly the
    // pre-4.3b one — an op is never refused for a field its cache predates.
    expect(body.binStateEpoch).toBeUndefined();
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

  // ── story 4.3b: state_epoch and the AD-14 conflict taxonomy ───────────────

  it('the sealed snapshot stitches each stop’s bin state epoch onto the task, and the epoch moves when — and only when — the bin does', async () => {
    const skuId = sku('PCK-EPOCH');
    const noiseSkuId = sku('PCK-EPOCH-NOISE');
    const binE = await createBin('A-10-01');
    const binIdle = await createBin('A-10-02');
    await seedStock(skuId, binE, 5);
    const { picklist } = await releasedWave([{ skuId, quantity: 5 }], 'epochsnap');
    const line = picklist.lines[0]!;

    // The task's epoch comes from the same read as the task (not from the
    // snapshot's `bins` array, which is stitched on another transaction).
    const captured = await capturedEpoch(line.id);
    expect(captured).toBe(await binEpoch(binE));
    expect(captured).toBeGreaterThan(0);

    // A movement in ANOTHER SKU still moves the BIN's epoch: the epoch is a
    // fact about the bin, not about one SKU inside it.
    const idleBefore = await binEpoch(binIdle);
    await seedStock(noiseSkuId, binE, 1);
    const moved = await capturedEpoch(line.id);
    expect(moved).not.toBe(captured);
    // A bin nothing touched is unchanged — and a bin nothing has EVER
    // touched simply has no epoch (null), which the server reads as a match.
    expect(await binEpoch(binIdle)).toBe(idleBefore);
    expect(idleBefore).toBeNull();
  });

  it('case 1 (apply) and case 2 (settle): a moved-on bin that still covers the draw answers 201, and the pick row records which arm it settled under', async () => {
    // Two slices of ONE order line across two bins: the hold settles only on
    // the LAST open slice, so the first pick is `applied` and the second —
    // the one that flips `held → committed` — is `settled`.
    const skuId = sku('PCK-EPOCH-APPLY');
    const noiseSkuId = sku('PCK-EPOCH-NOISE');
    const binP = await createBin('A-11-01');
    const binQ = await createBin('A-11-02');
    await seedStock(skuId, binP, 4);
    await seedStock(skuId, binQ, 4);
    const { picklist } = await releasedWave([{ skuId, quantity: 8 }], 'epochapply');
    const slices = picklist.lines.filter((candidate) => candidate.status === 'planned');
    expect(slices).toHaveLength(2);
    const [first, second] = slices as [PickLine, PickLine];
    const firstEpoch = await capturedEpoch(first.id);
    const secondEpoch = await capturedEpoch(second.id);

    // Both bins move on under the queued ops — another SKU lands in each —
    // but neither draw's own stock is touched, so both still cover.
    await seedStock(noiseSkuId, first.binId!, 2);
    await seedStock(noiseSkuId, second.binId!, 2);

    const applied = await pick(bodyFor(first, { binStateEpoch: firstEpoch })).expect(201);
    expect(applied.body.pick.conflictClass).toBe('applied');
    expect(applied.body.pick.reservationCommitted).toBe(false);
    expect(await reservationState(first.reservationId!)).toBe('held');
    expect(await pickRow(first.id)).toEqual({ conflict_class: 'applied', reservation_committed: false });

    const settled = await pick(bodyFor(second, { binStateEpoch: secondEpoch })).expect(201);
    expect(settled.body.pick.conflictClass).toBe('settled');
    expect(settled.body.pick.reservationCommitted).toBe(true);
    expect(await reservationState(second.reservationId!)).toBe('committed');
  });

  it('a pick whose epoch still matches is classified `none` — the taxonomy only fires on a real mismatch', async () => {
    const skuId = sku('PCK-EPOCH-SETTLE');
    const binM = await createBin('A-12-01');
    await seedStock(skuId, binM, 3);
    const { picklist } = await releasedWave([{ skuId, quantity: 3 }], 'epochmatch');
    const line = picklist.lines[0]!;
    const captured = await capturedEpoch(line.id);

    const res = await pick(bodyFor(line, { binStateEpoch: captured })).expect(201);
    expect(res.body.pick.conflictClass).toBe('none');
    expect(res.body.pick.reservationCommitted).toBe(true);
  });

  it('case 3 (re-plan): a moved-on bin that is short answers 409 pick-bin-short, writes NOTHING, leaves the key unconsumed — and the op replays once the stock is back', async () => {
    const skuId = sku('PCK-EPOCH-SHORT');
    const binS = await createBin('A-13-01');
    await seedStock(skuId, binS, 7);
    const { picklist } = await releasedWave([{ skuId, quantity: 7 }], 'epochshort');
    const line = picklist.lines[0]!;
    const captured = await capturedEpoch(line.id);

    // Another wave drains the bin while the op sits in the device queue —
    // the same deterministic driver as the 4.3 stale-replay test: a real
    // `stock.adjusted` movement, so the epoch changes by construction.
    await drainStock(skuId, binS, 7);
    expect(await onHand(skuId, binS)).toBe(0);
    expect(await binEpoch(binS)).not.toBe(captured);

    const key = ulid();
    const body = bodyFor(line, { binStateEpoch: captured });
    const short = await pick(body, operatorToken, key).expect(409);
    expect(short.body.code).toBe('pick-bin-short');
    // The refusal names the bin and what it LIVE holds, and says re-planning.
    expect(short.body.detail).toContain('A-13-01');
    expect(short.body.detail).toContain('0');
    expect(short.body.detail).toMatch(/re-planning/i);

    // Nothing persisted: no pick row, no ledger event, the line still
    // planned, the hold still held, and the key never consumed — the op is
    // re-plannable, which is only meaningful if the client can still hold it.
    expect(await pickRow(line.id)).toBeUndefined();
    expect(await ledgerFor(line.id)).toHaveLength(0);
    expect(await lineStatus(line.id)).toBe('planned');
    expect(await reservationState(line.reservationId!)).toBe('held');
    const keys = await sql`select id from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
    expect(keys).toHaveLength(0);

    // The SAME bytes replay once the bin covers again — including the now
    // doubly-stale epoch, which no longer matters because the bin covers.
    await seedStock(skuId, binS, 7);
    const recovered = await pick(body, operatorToken, key).expect(201);
    expect(recovered.body.pick.conflictClass).toBe('settled');
    expect(await lineStatus(line.id)).toBe('picked');
  });

  it('case 4 (quarantine) beats case 3: a hold that is past its TTL but not yet reaped is unresolvable, even in a bin that still covers', async () => {
    // `state = 'held'` and `expires_at > now` are NOT the same test — the
    // reaper is a job, so a hold can be past its TTL and still read `held`.
    // Settling one would commit units nobody is holding any more.
    const skuId = sku('PCK-EPOCH-DEAD');
    const binD = await createBin('A-14-01');
    await seedStock(skuId, binD, 6);
    const { picklist } = await releasedWave([{ skuId, quantity: 6 }], 'epochdead');
    const line = picklist.lines[0]!;
    const captured = await capturedEpoch(line.id);
    const before = await onHand(skuId, binD);

    await sql`
      update reservations set expires_at = now() - interval '1 minute'
      where id = ${line.reservationId!}
    `;
    expect(await reservationState(line.reservationId!)).toBe('held');

    const key = ulid();
    const dead = await pick(bodyFor(line, { binStateEpoch: captured }), operatorToken, key).expect(409);
    expect(dead.body.code).toBe('pick-unresolvable');
    expect(dead.body.detail).toMatch(/expired/i);

    // Nothing written, key unconsumed — the client quarantines, it does not
    // silently drop a pick the operator physically performed.
    expect(await pickRow(line.id)).toBeUndefined();
    expect(await ledgerFor(line.id)).toHaveLength(0);
    expect(await onHand(skuId, binD)).toBe(before);
    expect(await lineStatus(line.id)).toBe('planned');
    const keys = await sql`select id from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
    expect(keys).toHaveLength(0);
  });

  it('a bin with no epoch row is treated as a match — a bin no movement has ever touched is nothing to be stale against', async () => {
    const skuId = sku('PCK-EPOCH-NONE');
    const binN = await createBin('A-15-01');
    await seedStock(skuId, binN, 4);
    const { picklist } = await releasedWave([{ skuId, quantity: 4 }], 'epochnone');
    const line = picklist.lines[0]!;
    const captured = await capturedEpoch(line.id);

    // Force the "unknown bin" arm of the I/O matrix directly: no epoch row at
    // all, while the op still quotes one. Absence of the row is not evidence
    // of change, so the pick proceeds exactly as it would without the field.
    await sql`
      delete from bin_state_epochs
      where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and bin_id = ${binN}
    `;
    expect(await binEpoch(binN)).toBeNull();

    const res = await pick(bodyFor(line, { binStateEpoch: captured })).expect(201);
    expect(res.body.pick.conflictClass).toBe('none');
  });

  it('the epoch is OUTSIDE the idempotency payload hash: a replay carrying a different epoch re-serves the snapshot instead of failing idempotency-key-reuse', async () => {
    // The whole story depends on this. The hash catches a client reusing one
    // key for two different INTENTS; the epoch is an observation, not an
    // intent, and two replays of the same physical pick may legitimately
    // carry different ones. Hashing it would turn every stale replay into a
    // 422 before the taxonomy ever ran.
    const skuId = sku('PCK-EPOCH-HASH');
    const binH = await createBin('A-16-01');
    await seedStock(skuId, binH, 2);
    const { picklist } = await releasedWave([{ skuId, quantity: 2 }], 'epochhash');
    const line = picklist.lines[0]!;
    const captured = await capturedEpoch(line.id);

    const key = ulid();
    const body = bodyFor(line, { binStateEpoch: captured });
    const first = await pick(body, operatorToken, key).expect(201);

    const replayed = await pick({ ...body, binStateEpoch: captured + 99 }, operatorToken, key).expect(201);
    expect(replayed.body.pick).toEqual(first.body.pick);
    expect(await ledgerFor(line.id)).toHaveLength(1);

    // A payload field that IS intent still diverges the hash.
    const reused = await pick({ ...body, qty: 1 }, operatorToken, key).expect(422);
    expect(reused.body.code).toBe('idempotency-key-reuse');
  });

  it('the BATCH-arm shortfall is routed by the epoch too: 422 without a moved epoch, 409 pick-bin-short with one', async () => {
    // The FEFO derivation reports its shortfall rather than throwing it, so
    // the caller can route it — the plain whole-bin check is not the only
    // producer. Blocking the batch empties the DRAWABLE pool while leaving
    // `stock_on_hand` untouched, so the batch arm is provably the branch
    // under test: the whole-bin check below it would pass.
    const skuId = sku(BATCH_SHORT_SKU_CODE);
    const noiseSkuId = sku('PCK-EPOCH-NOISE');
    const binF = await createBin('A-17-01');
    const batchCode = `PCK-SHORT-${ulid().slice(10, 16)}`;
    const expiryDate = new Date(Date.now() + 400 * 86_400_000).toISOString();
    await seedStock(skuId, binF, 5, { batch: { code: batchCode, expiryDate } });
    const { picklist } = await releasedWave([{ skuId, quantity: 5 }], 'batchshort');
    const line = picklist.lines[0]!;
    const captured = await capturedEpoch(line.id);

    // A blocked batch is never drawn (epic-2 retro a13's draw side). The bin
    // still HOLDS the units — only the drawable pool is empty.
    await sql`update batches set status = 'blocked' where tenant_id = ${tenantId} and code = ${batchCode}`;
    expect(await onHand(skuId, binF)).toBe(5);

    // No epoch movement: the pre-4.3b outcome, unchanged.
    expect(await binEpoch(binF)).toBe(captured);
    const stale = await pick(bodyFor(line, { binStateEpoch: captured })).expect(422);
    expect(stale.body.code).toBe('insufficient-on-hand');
    expect(stale.body.detail).toContain('A-17-01');

    // Now move the bin's epoch — another SKU lands in it — and the SAME
    // shortfall becomes the re-plannable 409 the client keeps.
    await seedStock(noiseSkuId, binF, 1);
    expect(await binEpoch(binF)).not.toBe(captured);
    const short = await pick(bodyFor(line, { binStateEpoch: captured })).expect(409);
    expect(short.body.code).toBe('pick-bin-short');
    expect(short.body.detail).toContain('A-17-01');

    // Neither arm wrote anything.
    expect(await pickRow(line.id)).toBeUndefined();
    expect(await ledgerFor(line.id)).toHaveLength(0);
    expect(await lineStatus(line.id)).toBe('planned');
  });

  it('case 4 covers every terminal premise: a cancelled wave, a cancelled picklist, a cancelled line and an unfulfillable one', async () => {
    const skuId = sku('PCK-EPOCH-DEAD');
    const binT = await createBin('A-18-01');
    await seedStock(skuId, binT, 12);

    // ── the wave arm: cancelling the wave is the floor-visible path ───────
    const cancelledWave = await releasedWave([{ skuId, quantity: 3 }], 'deadwave');
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${cancelledWave.waveId}/cancel`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const waveArm = await pick(bodyFor(cancelledWave.picklist.lines[0]!)).expect(409);
    expect(waveArm.body.code).toBe('pick-unresolvable');
    expect(waveArm.body.detail).toMatch(/wave .* was cancelled while this pick was queued/i);

    // ── the picklist arm ─────────────────────────────────────────────────
    // Forced directly: a wave cancel cancels the wave FIRST, so the wave gate
    // above would shadow this one and the arm would never be reached.
    const picklistCancelled = await releasedWave([{ skuId, quantity: 3 }], 'deadlist');
    await sql`update picklists set status = 'cancelled' where id = ${picklistCancelled.picklist.id}`;
    const listArm = await pick(bodyFor(picklistCancelled.picklist.lines[0]!)).expect(409);
    expect(listArm.body.code).toBe('pick-unresolvable');
    expect(listArm.body.detail).toMatch(/picklist .* was cancelled while this pick was queued/i);

    // ── the line arms: cancelled, and unfulfillable ──────────────────────
    const lineCancelled = await releasedWave([{ skuId, quantity: 3 }], 'deadline');
    const cancelledLine = lineCancelled.picklist.lines[0]!;
    await sql`update picklist_lines set status = 'cancelled' where id = ${cancelledLine.id}`;
    const lineArm = await pick(bodyFor(cancelledLine)).expect(409);
    expect(lineArm.body.code).toBe('pick-unresolvable');
    expect(lineArm.body.detail).toMatch(/was cancelled while this pick was queued/i);

    const unfulfillable = await releasedWave([{ skuId, quantity: 3 }], 'deadunfil');
    const shortfallLine = unfulfillable.picklist.lines[0]!;
    // `unfulfillable` never returns to `planned`, so a queued op against one
    // is terminal — routing it to the plain `conflict` would have the device
    // DELETE a pick the operator physically performed.
    await sql`update picklist_lines set status = 'unfulfillable' where id = ${shortfallLine.id}`;
    const unfilArm = await pick(bodyFor(shortfallLine)).expect(409);
    expect(unfilArm.body.code).toBe('pick-unresolvable');
    expect(unfilArm.body.detail).toMatch(/unfulfillable/i);

    // Nothing was drawn by any of the four.
    expect(await onHand(skuId, binT)).toBe(12);
  });

  it('a multi-slice order line whose hold is past TTL still draws its NON-settling slices — expiry is a premise only of the pick that settles', async () => {
    // The regression this guards: judging expiry at the classification point
    // refuses the FIRST slice of a multi-bin line, which previously drew
    // fine. The hold settles only on the LAST open slice, so that is the only
    // pick whose premises include the TTL.
    const skuId = sku('PCK-EPOCH-TTL');
    const binU = await createBin('A-19-01');
    const binV = await createBin('A-19-02');
    await seedStock(skuId, binU, 4);
    await seedStock(skuId, binV, 4);
    const { picklist } = await releasedWave([{ skuId, quantity: 8 }], 'ttlslices');
    const slices = picklist.lines.filter((candidate) => candidate.status === 'planned');
    expect(slices).toHaveLength(2);
    const [first, second] = slices as [PickLine, PickLine];

    await sql`
      update reservations set expires_at = now() - interval '1 minute'
      where id = ${first.reservationId!}
    `;

    // The non-settling slice draws: its own premise (the hold is still
    // `held`) holds, and the TTL is not its business.
    const drew = await pick(bodyFor(first)).expect(201);
    expect(drew.body.pick.reservationCommitted).toBe(false);
    expect(await lineStatus(first.id)).toBe('picked');

    // The SETTLING slice is the one the expiry refuses — and refuses whole:
    // the draw it would have made rolls back with it.
    const refused = await pick(bodyFor(second)).expect(409);
    expect(refused.body.code).toBe('pick-unresolvable');
    expect(refused.body.detail).toMatch(/hold expired at/i);
    expect(await lineStatus(second.id)).toBe('planned');
    expect(await ledgerFor(second.id)).toHaveLength(0);
    expect(await onHand(skuId, second.binId!)).toBe(4);
  });

  it('the reservation backstop under the classification still refuses a terminal hold (the 4.3 `commitInTx` guard)', async () => {
    // Story 4.3b's case-4 gate now refuses a terminal hold BEFORE the pick
    // reaches settlement, so the command can no longer drive `commitInTx`
    // into its own refusal. That refusal is the backstop beneath the gate —
    // if it ever stopped refusing, a classification bug would silently
    // re-commit a hold nobody is holding — so it is asserted directly.
    const skuId = sku('PCK-EPOCH-BACKSTOP');
    const binW = await createBin('A-20-01');
    await seedStock(skuId, binW, 5);
    const { picklist } = await releasedWave([{ skuId, quantity: 5 }], 'backstop');
    const line = picklist.lines[0]!;
    await sql`update reservations set state = 'expired' where id = ${line.reservationId!}`;

    const facade = app.get(InventoryFacade);
    await expect(facade.commitReservation(tenantId, line.reservationId!)).rejects.toMatchObject({
      status: 409,
    });
    expect(await reservationState(line.reservationId!)).toBe('expired');

    // …and the command's own gate refuses first, naming the state.
    const refused = await pick(bodyFor(line)).expect(409);
    expect(refused.body.code).toBe('pick-unresolvable');
    expect(refused.body.detail).toMatch(/a terminal hold is never re-settled/i);
    expect(await ledgerFor(line.id)).toHaveLength(0);
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
    // Story 4.3b: a CANCELLED order has moved terminally — AD-14 case 4, so
    // the queued op quarantines for a human rather than being dropped. The
    // unreleased-wave arm above is NOT terminal (releasing it later makes the
    // op replayable) and stays the plain retryable `conflict`.
    expect(early.body.code).toBe('conflict');
    const cancelled = await pick(bodyFor(planned)).expect(409);
    expect(cancelled.body.code).toBe('pick-unresolvable');
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

  it('a queued pick whose hold expired before replay is case 4 — 409 pick-unresolvable, and it persists nothing', async () => {
    // The normal offline case: the op sat in the device queue past the
    // hold's TTL, the reaper expired it, and the replay lands on a
    // non-`held` reservation. Story 4.3b classifies it as AD-14 case 4 —
    // unresolvable — so the client QUARANTINES it with the session that made
    // it instead of deleting it: the hold, the line's own premise, is gone
    // and no retry recovers it. `commitInTx` stays the backstop underneath.
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
    expect(refused.body.code).toBe('pick-unresolvable');
    expect(refused.body.detail).toMatch(/expired/i);
    expect(refused.body.detail).toMatch(/held for review/i);

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

  it('RLS on `picks` and `bin_state_epochs`: foreign rows are invisible, own rows are visible, a foreign insert is 42501; the four CHECKs hold', async () => {
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
    // Story 4.3b's two: the taxonomy's stored classes, and the epoch's
    // monotonic-and-never-zero floor (a 0 on the wire would be
    // indistinguishable from "this bin has no epoch").
    await expect(
      sql`
        insert into picks
          (id, tenant_id, warehouse_id, wave_id, picklist_id, picklist_line_id, order_id, order_line_id,
           sku_id, bin_id, qty, conflict_class, picked_by, picked_at, device_id)
        values
          (${uuidv7()}, ${tenantId}, ${warehouseId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()},
           ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${binA}, 1, 'pick-bin-short', ${uuidv7()}, now(), ${uuidv7()})
      `,
    ).rejects.toThrow(/picks_conflict_class_check/i);
    await expect(
      sql`
        insert into bin_state_epochs (id, tenant_id, warehouse_id, bin_id, epoch)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${uuidv7()}, 0)
      `,
    ).rejects.toThrow(/bin_state_epochs_epoch_positive/i);

    // Story 4.3b seeded `bin_state_epochs` for this tenant many times over
    // (every fixture adjustment folds through the ledger), so the "own rows
    // are visible" half of the probe is non-vacuous for it too.
    const foreignEpochBin = uuidv7();
    await sql`
      insert into bin_state_epochs (id, tenant_id, warehouse_id, bin_id, epoch)
      values (${uuidv7()}, ${foreignTenantId}, ${warehouseId}, ${foreignEpochBin}, 1)
    `;

    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1 });
    try {
      await rls.unsafe(`select set_config('app.tenant_id', '${tenantId}', false)`);
      // Both tenant-bearing tables this story touches get the same probe.
      // Looping is the point: `bin_state_epochs`'s policy is hand-written in
      // 0021, and without this arm dropping it from the migration would leave
      // the suite green while every tenant could read every other tenant's
      // bin state.
      const foreignInsertSql: Record<string, string> = {
        picks: `insert into picks
             (id, tenant_id, warehouse_id, wave_id, picklist_id, picklist_line_id, order_id, order_line_id,
              sku_id, bin_id, qty, picked_by, picked_at, device_id)
           values
             ('${uuidv7()}'::uuid, '${foreignTenantId}'::uuid, '${warehouseId}'::uuid, '${uuidv7()}'::uuid,
              '${uuidv7()}'::uuid, '${uuidv7()}'::uuid, '${uuidv7()}'::uuid, '${uuidv7()}'::uuid,
              '${uuidv7()}'::uuid, '${binA}'::uuid, 1, '${uuidv7()}'::uuid, now(), '${uuidv7()}'::uuid)`,
        bin_state_epochs: `insert into bin_state_epochs (id, tenant_id, warehouse_id, bin_id, epoch)
           values ('${uuidv7()}'::uuid, '${foreignTenantId}'::uuid, '${warehouseId}'::uuid, '${uuidv7()}'::uuid, 1)`,
      };
      for (const table of ['picks', 'bin_state_epochs'] as const) {
        // The foreign row exists through the privileged connection…
        const seeded = await sql.unsafe(
          `select count(*)::int as n from ${table} where tenant_id = '${foreignTenantId}'::uuid`,
        );
        expect(Number((seeded[0] as unknown as { n: number }).n)).toBeGreaterThan(0);
        // …and is invisible through the scoped role.
        const foreignRows = await rls.unsafe(
          `select count(*)::int as n from ${table} where tenant_id = '${foreignTenantId}'::uuid`,
        );
        expect(Number((foreignRows[0] as unknown as { n: number }).n)).toBe(0);
        // …while our own rows are visible through it.
        const own = await rls.unsafe(
          `select count(*)::int as n from ${table} where tenant_id = '${tenantId}'::uuid`,
        );
        expect(Number((own[0] as unknown as { n: number }).n)).toBeGreaterThan(0);
        // The write side fails closed too (the WITH CHECK arm).
        await expect(rls.unsafe(foreignInsertSql[table]!)).rejects.toMatchObject({ code: '42501' });
      }
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
