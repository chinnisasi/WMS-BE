import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import {
  HANDLING_UNIT_STATUSES,
  MAX_HANDLING_UNIT_WEIGHT_GRAMS,
  assertCatchWeightGrams,
} from '../src/modules/catalog/handling-unit';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

// The e2e suite talks to the real Postgres + Valkey (docker-compose dev
// containers by default; CI provides the service containers) and signs
// sessions — the same bootstrap the sibling suites run.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(120_000);

/**
 * Story 10.3 — catch weight and handling units, end to end over real HTTP.
 *
 * The one sentence this suite exists to keep true: **a catch weight is never a
 * quantity.** Six cases of beef are quantity `6` in the ledger and six
 * `handling_units` rows of ~18,400 g each; nothing anywhere multiplies the
 * two, and no weight is ever scaled into milli-units. Every other assertion
 * here hangs off that — the over-receipt split, the pack scan, the write-off
 * refusal — because each of them is a place the two numbers could be confused.
 *
 * Fixtures deliberately include a **fractional-UoM** catch-weight SKU (`kg`,
 * 3 declared decimals). A suite that only ever seeded whole `case` units would
 * prove nothing about the boundary between the two representations, which is
 * exactly where the defect would live.
 */
interface GrnLineBody {
  poLineId: string | null;
  skuId: string;
  batchCode: string | null;
  mfgDate: string | null;
  qty: number;
  weightsGrams?: number[] | null;
}

interface HandlingUnitRow {
  id: string;
  tenant_id: string;
  warehouse_id: string;
  sku_id: string;
  batch_id: string | null;
  grn_line_id: string;
  weight_grams: number;
  status: string;
  packed_order_line_id: string | null;
}

interface PickLine {
  id: string;
  picklistId: string;
  orderId: string;
  orderLineId: string;
  skuId: string;
  binId: string | null;
  qty: number;
  status: string;
}

/**
 * The weight gate, exercised DIRECTLY.
 *
 * Over HTTP the DTO's own `@IsInt` / `@Min(1)` / `@Max(...)` shadow this
 * function completely, so an e2e-only suite would pass with the gate replaced
 * by a pass-through — "a guard no test exercises", the exact defect class the
 * repo's mutation checks exist to find. The command keeps its own gate
 * regardless (the `assertWeight` precedent in `pack.command.ts`): DTO
 * validation composes with the command, it is never the command's authority,
 * and a non-HTTP caller must meet the same rule.
 */
describe('assertCatchWeightGrams (story 10.3)', () => {
  it('admits whole grams inside the bound, including both ends', () => {
    expect(assertCatchWeightGrams(1, 'weightsGrams')).toBe(1);
    expect(assertCatchWeightGrams(18_400, 'weightsGrams')).toBe(18_400);
    expect(assertCatchWeightGrams(MAX_HANDLING_UNIT_WEIGHT_GRAMS, 'weightsGrams')).toBe(
      MAX_HANDLING_UNIT_WEIGHT_GRAMS,
    );
  });

  it('refuses zero, negatives, fractions, non-numbers and anything past the bound — naming the bound', () => {
    for (const bad of [
      0,
      -1,
      -18_400,
      18_400.5,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_HANDLING_UNIT_WEIGHT_GRAMS + 1,
      '18400',
      null,
      undefined,
    ]) {
      let thrown: unknown;
      try {
        assertCatchWeightGrams(bad, 'weightsGrams');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      const body = (thrown as { getResponse(): { code: string; detail: string } }).getResponse();
      expect(body.code).toBe('validation-failed');
      // The refusal names the field, the bound and the offender — never a
      // bare "invalid weight" the operator cannot act on.
      expect(body.detail).toContain('weightsGrams');
      expect(body.detail).toContain(String(MAX_HANDLING_UNIT_WEIGHT_GRAMS));
      expect(body.detail).toContain(String(bad));
    }
  });

  it('is a grams gate, not a quantity gate — a fraction is refused, never scaled', () => {
    // 18.4 is a perfectly good KILOGRAM quantity and a nonsense GRAM weight.
    // If this ever starts returning 18400, a catch weight has begun travelling
    // the milli-unit path and 10.1's completed migration is re-opened.
    expect(() => assertCatchWeightGrams(18.4, 'weightsGrams')).toThrow();
  });
});

describe('catch weight and handling units (e2e, story 10.3)', () => {
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
  let binA: string;
  let vendorId: string;
  let deviceToken: string;
  let deviceId: string;
  let operatorToken: string;
  /** The badge-in operator's user id — the pre-10.3 payload hash names it. */
  let operatorUserId: string;
  const skuIds = new Map<string, string>();

  /**
   * One fixture SKU per scenario, so no two tests share stock or units.
   * `CW-` prefixed SKUs are catch-weight tracked.
   */
  const SKU_ROWS: readonly string[] = [
    // code,name,uom,uom_conversions,gst_rate,hsn,batch,serial,catch_weight,rp,rq,barcode
    'CW-CASE,Beef case,case,,1800,,false,false,true,,,',
    'CW-BATCH,Beef case lot-tracked,case,,1800,,true,false,true,,,',
    'CW-KG,Salmon by kilo,kg,,1800,,false,false,true,,,',
    'CW-OVER,Beef case over-received,case,,1800,,false,false,true,,,',
    'CW-REJECT,Beef case rejected excess,case,,1800,,false,false,true,,,',
    'CW-ADJ,Beef case written off,case,,1800,,false,false,true,,,',
    'CW-ADJUP,Beef case adjusted upward,case,,1800,,false,false,true,,,',
    'CW-QC,Beef case quarantined,case,,1800,,false,false,true,,,',
    'CW-PACK,Beef case packed,case,,1800,,false,false,true,,,',
    'CW-SPLIT,Beef case two order lines,case,,1800,,false,false,true,,,',
    'CW-FAILOPEN,Beef case written off then packed,case,,1800,,false,false,true,,,',
    'CW-REPLAY,Beef case replayed receipt,case,,1800,,false,false,true,,,',
    'CW-ARMS,Beef case pack refusal arms,case,,1800,,false,false,true,,,',
    'CW-LOTS,Beef case two lots,case,,1800,,true,false,true,,,',
    'CW-KGPACK,Salmon by kilo packed,kg,,1800,,false,false,true,,,',
    'CW-FLIP,Case whose flag is flipped,case,,1800,,false,false,false,,,',
    'CW-LEGACY,Plain case with a pre-10.3 key,case,,1800,,false,false,false,,,',
    'PLAIN-CASE,Plain case (no catch weight),case,,1800,,false,false,false,,,',
    'PLAIN-SERIAL,Serial-tracked plain,each,,1800,,false,true,false,,,',
  ];
  // Derived from the fixture rows' own flag column, not from the code prefix:
  // `CW-FLIP` and `CW-LEGACY` are deliberately NOT catch-weight tracked, and a
  // prefix heuristic would quietly assert the opposite of what they are for.
  const CATCH_WEIGHT_CODES = SKU_ROWS.filter((row) => row.split(',')[8] === 'true').map(
    (row) => row.split(',')[0]!,
  );

  let suiteDb: SuiteDatabase;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('catch_weight');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Catch Weight Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    createdTenantIds.push(tenantId);
    ownerToken = await signIn(email, 'correct-horse-battery');
    opsToken = await inviteAndSignIn('ops_manager', 'ops-password-123');
    accountantToken = await inviteAndSignIn('accountant', 'books-password-123');

    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: `CW-${ulid().slice(10, 16).toUpperCase()}`, name: `Catch WH ${ulid()}` })
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
    binA = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;

    vendorId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/vendors`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'VEND-CW', name: 'Prime Foods Pvt Ltd' })
        .expect(201)
    ).body.vendor.id as string;

    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode',
      ...SKU_ROWS,
    ].join('\n');
    const imported = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    expect(imported.body.failedRows).toBe(0);
    const catalog = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of catalog.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }
    expect(skuIds.size).toBeGreaterThanOrEqual(SKU_ROWS.length);

    // The floor device + its badge-in operator (every receipt rides it).
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Dock scale scanner', pin: '2468' })
      .expect(201);
    deviceToken = enrolled.body.deviceToken as string;
    deviceId = enrolled.body.device.id as string;
    const operatorEmail = `receiver-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: operatorEmail, role: 'operator' })
      .expect(201);
    operatorUserId = invited.body.user.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    operatorToken = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${deviceToken}`)
        .send({ operatorEmail, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
  });

  afterAll(async () => {
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
      for (const table of [
        'picks',
        'picklist_lines',
        'picklists',
        'waves',
        'wave_policies',
        'order_lines',
        'orders',
        'qc_holds',
        'handling_units',
        'over_receipts',
        'goods_receipt_lines',
        'goods_receipt_notes',
        'purchase_order_lines',
        'purchase_orders',
        'vendors',
      ]) {
        await cleaner.unsafe(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      }
      await cleaner.unsafe('set session_replication_role = replica');
      await cleaner.unsafe('DELETE FROM ledger_events WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('DELETE FROM ledger_anchors WHERE tenant_id = ANY($1::uuid[])', [createdTenantIds]);
      await cleaner.unsafe('set session_replication_role = DEFAULT');
      for (const table of [
        'reservations',
        'reconciliation_checkpoints',
        'inventory_quarantines',
        'serials',
        'batch_on_hand',
        'stock_on_hand',
        'bin_state_epochs',
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

  // ── helpers ────────────────────────────────────────────────────────────────

  function signIn(address: string, password: string): Promise<string> {
    return request(app.getHttpServer())
      .post(`${API}/sign-in`)
      .send({ email: address, password })
      .expect(200)
      .then((res) => res.body.accessToken as string);
  }

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
    return signIn(address, password);
  }

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  function nowUtc(): string {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  }

  function submitGrn(
    body: {
      warehouseId: string;
      poId: string | null;
      blindReasonCode: string | null;
      occurredAt: string;
      lines: GrnLineBody[];
    },
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  /** A blind receipt of one catch-weight line — the shortest path to live units. */
  function blindReceipt(
    skuId: string,
    weights: number[],
    extra: Partial<GrnLineBody> = {},
    key = ulid(),
    // The business time is a parameter, not a fresh `nowUtc()` per call: a
    // replay test that let two attempts straddle a second boundary would hash
    // two different payloads and answer 422 for a reason that has nothing to
    // do with what it is testing.
    occurredAt: string = nowUtc(),
  ): SupertestTest {
    return submitGrn(
      {
        warehouseId,
        poId: null,
        blindReasonCode: 'unannounced-delivery',
        occurredAt,
        lines: [
          {
            poLineId: null,
            skuId,
            batchCode: null,
            mfgDate: null,
            qty: weights.length,
            weightsGrams: weights,
            ...extra,
          },
        ],
      },
      key,
    );
  }

  async function createPo(
    skuId: string,
    orderedQty: number,
  ): Promise<{ poId: string; poLineId: string }> {
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        vendorId,
        code: `PO-CW-${ulid().slice(10, 18).toUpperCase()}`,
        lines: [{ skuId, orderedQty, unitCostPaise: 100 }],
      })
      .expect(201);
    return {
      poId: res.body.purchaseOrder.id as string,
      poLineId: res.body.purchaseOrder.lines[0].id as string,
    };
  }

  async function unitsOfGrn(grnLineId: string): Promise<HandlingUnitRow[]> {
    return (await sql`
      select * from handling_units
      where tenant_id = ${tenantId} and grn_line_id = ${grnLineId}
      order by id
    `) as unknown as HandlingUnitRow[];
  }

  async function unitById(id: string): Promise<HandlingUnitRow | undefined> {
    const rows = (await sql`
      select * from handling_units where tenant_id = ${tenantId} and id = ${id}
    `) as unknown as HandlingUnitRow[];
    return rows[0];
  }

  function adjust(body: Record<string, unknown>, key = ulid()): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  /** Receives units, then makes them pickable by putting them in bin A. */
  async function seedPickableUnits(
    skuCode: string,
    weights: number[],
    extra: Partial<GrnLineBody> = {},
  ): Promise<{ unitIds: string[]; grnLineId: string }> {
    const received = await blindReceipt(sku(skuCode), weights, extra).expect(201);
    const grn = received.body.goodsReceipt;
    const line = grn.lines[0];
    // The receipt lands the stock in the system Receiving bin; a putaway moves
    // it to a pickable one. The handling units are UNTOUCHED by that move —
    // the documented limitation, not an oversight: a unit has no location
    // between receipt and pack, and nothing here pretends otherwise.
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/putaway/placements`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        grnId: grn.id,
        grnLineId: line.id,
        skuId: sku(skuCode),
        // A batch-tracked SKU's placement names the batch the receipt created;
        // it is forbidden on every other SKU.
        ...(line.batchId === null ? {} : { batchId: line.batchId }),
        toBinId: binA,
        qty: weights.length,
        occurredAt: nowUtc(),
      })
      .expect(201);
    return { unitIds: line.handlingUnitIds as string[], grnLineId: line.id as string };
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

  /** Order → wave → release → pick every line. Returns the picked order id. */
  async function pickedOrder(lines: { skuId: string; quantity: number }[], tag: string): Promise<string> {
    const orderId = await createOrder(lines);
    const policy = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/wave-policies`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, name: `${tag}-${ulid().slice(10, 18)}`, grouping: 'single' })
        .expect(201)
    ).body.policy.id as string;
    const waveId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/waves`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, policyId: policy, orderIds: [orderId] })
        .expect(201)
    ).body.wave.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const wave = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200)
    ).body.wave as { picklists: { lines: PickLine[] }[] };
    for (const picklist of wave.picklists) {
      for (const line of picklist.lines) {
        if (line.binId === null) continue;
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/outbound/picks`)
          .set('Authorization', `Bearer ${operatorToken}`)
          .set(KEY_HEADER, ulid())
          .send({
            warehouseId,
            picklistId: line.picklistId,
            picklistLineId: line.id,
            skuId: line.skuId,
            binId: line.binId,
            qty: line.qty,
            occurredAt: nowUtc(),
          })
          .expect(201);
      }
    }
    return orderId;
  }

  /** Seeds plain (non-catch-weight) on-hand straight into the pickable bin. */
  async function seedPlainStock(skuCode: string, quantity: number): Promise<void> {
    await adjust({
      warehouseId,
      skuId: sku(skuCode),
      binId: binA,
      quantityDelta: quantity,
      reasonCode: 'cycle-count',
      note: 'catch-weight suite plain seed',
    }).expect(201);
  }

  /**
   * Units that exist but are NOT sellable stock: a second receipt against a
   * fully-consumed PO line applies nothing, so every case lands
   * `pending_approval` awaiting the over-receipt decision. Returns their ids.
   */
  async function pendingApprovalUnits(skuCode: string, weights: number[]): Promise<string[]> {
    const { poId, poLineId } = await createPo(sku(skuCode), 1);
    const line: GrnLineBody = {
      poLineId,
      skuId: sku(skuCode),
      batchCode: null,
      mfgDate: null,
      qty: 1,
      weightsGrams: [18_001],
    };
    // First receipt consumes the whole opening…
    await submitGrn({
      warehouseId,
      poId,
      blindReasonCode: null,
      occurredAt: nowUtc(),
      lines: [line],
    }).expect(201);
    // …so the second applies nothing and every case pends.
    const excess = await submitGrn({
      warehouseId,
      poId,
      blindReasonCode: null,
      occurredAt: nowUtc(),
      lines: [{ ...line, qty: weights.length, weightsGrams: weights }],
    }).expect(201);
    const excessLine = excess.body.goodsReceipt.lines[0];
    expect(excessLine.appliedQty).toBe(0);
    const rows = await unitsOfGrn(excessLine.id as string);
    expect(rows.every((row) => row.status === 'pending_approval')).toBe(true);
    return excessLine.handlingUnitIds as string[];
  }

  /**
   * Orders, waves, releases and attempts ONE pick at `quantity` — returning
   * the pick response unasserted, so a refusal can be examined. The whole
   * reserved quantity lands on one picklist line, which is what makes the
   * fractional-draw refusal reachable.
   */
  async function pickFirstLine(
    skuCode: string,
    quantity: number,
    tag: string,
  ): Promise<request.Response> {
    const orderId = await createOrder([{ skuId: sku(skuCode), quantity }]);
    const policy = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/wave-policies`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, name: `${tag}-${ulid().slice(10, 18)}`, grouping: 'single' })
        .expect(201)
    ).body.policy.id as string;
    const waveId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/waves`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, policyId: policy, orderIds: [orderId] })
        .expect(201)
    ).body.wave.id as string;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const wave = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200)
    ).body.wave as { picklists: { lines: PickLine[] }[] };
    const line = wave.picklists.flatMap((picklist) => picklist.lines).find((l) => l.binId !== null)!;
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/picks`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        picklistId: line.picklistId,
        picklistLineId: line.id,
        skuId: line.skuId,
        binId: line.binId,
        qty: line.qty,
        occurredAt: nowUtc(),
      });
  }

  function packOrder(
    orderId: string,
    scanned: { skuId: string; qty: number; handlingUnitIds?: string[] }[],
    key = ulid(),
  ): SupertestTest {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ scanned });
  }

  // ── receipt: capture once, carry ───────────────────────────────────────────

  it('six cases at six weights produce six handling units, and the ledger records quantity 6 — never 110,400', async () => {
    const weights = [18_400, 18_600, 17_950, 19_100, 18_000, 18_255];
    const received = await blindReceipt(sku('CW-CASE'), weights).expect(201);
    const line = received.body.goodsReceipt.lines[0];
    expect(line.qty).toBe(6);
    expect(line.appliedQty).toBe(6);
    expect(line.handlingUnitIds).toHaveLength(6);

    const units = await unitsOfGrn(line.id as string);
    expect(units).toHaveLength(6);
    // Unit i IS weight i: the response's id order and the captured weights
    // line up, which is what makes a printed unit label meaningful.
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    expect((line.handlingUnitIds as string[]).map((id) => byId.get(id)!.weight_grams)).toEqual(weights);
    expect(units.every((unit) => unit.status === 'active')).toBe(true);
    expect(units.every((unit) => unit.sku_id === sku('CW-CASE'))).toBe(true);
    expect(units.every((unit) => unit.warehouse_id === warehouseId)).toBe(true);
    expect(units.every((unit) => unit.batch_id === null)).toBe(true);
    expect(units.every((unit) => unit.packed_order_line_id === null)).toBe(true);

    // The ledger moved a COUNT, not a mass. 6 cases = 6,000 milli-units; the
    // sum of the weights (110,305 g) appears nowhere in it.
    const events = (await sql`
      select quantity_delta, type from ledger_events
      where tenant_id = ${tenantId} and sku_id = ${sku('CW-CASE')}
    `) as unknown as { quantity_delta: string; type: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('grn.received');
    expect(Number(events[0]!.quantity_delta)).toBe(6_000);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    expect(Number(events[0]!.quantity_delta)).not.toBe(weightSum);
  });

  it('a batch-tracked catch-weight SKU records its batch ON THE UNIT ROW — recoverable with no ledger traversal', async () => {
    const received = await submitGrn({
      warehouseId,
      poId: null,
      blindReasonCode: 'unannounced-delivery',
      occurredAt: nowUtc(),
      lines: [
        {
          poLineId: null,
          skuId: sku('CW-BATCH'),
          batchCode: 'LOT-2026-09',
          mfgDate: null,
          qty: 3,
          weightsGrams: [18_100, 18_200, 18_300],
        },
      ],
    }).expect(201);
    const line = received.body.goodsReceipt.lines[0];
    expect(line.batchId).not.toBeNull();

    const units = await unitsOfGrn(line.id as string);
    expect(units).toHaveLength(3);
    // The whole point of the divergence from `serials` (which carry no batch):
    // a recall traces this case to its lot from ONE row.
    expect(units.every((unit) => unit.batch_id === line.batchId)).toBe(true);
    const batch = (await sql`
      select code from batches where tenant_id = ${tenantId} and id = ${line.batchId as string}
    `) as unknown as { code: string }[];
    expect(batch[0]!.code).toBe('LOT-2026-09');
  });

  it('a FRACTIONAL-UoM catch-weight SKU keeps the two representations apart: quantity scales, weight does not', async () => {
    // `kg` declares 3 decimals, so the quantity column holds milli-units —
    // while the captured weights stay plain integer grams. This is the one
    // fixture where a stray `toMilli` on a weight would be visible.
    const weights = [4_120, 3_980, 4_505];
    const received = await blindReceipt(sku('CW-KG'), weights).expect(201);
    const line = received.body.goodsReceipt.lines[0];
    expect(line.qty).toBe(3);

    const events = (await sql`
      select quantity_delta from ledger_events
      where tenant_id = ${tenantId} and sku_id = ${sku('CW-KG')}
    `) as unknown as { quantity_delta: string }[];
    expect(Number(events[0]!.quantity_delta)).toBe(3_000);
    const units = await unitsOfGrn(line.id as string);
    expect(units.map((u) => u.weight_grams).sort((a, b) => a - b)).toEqual([3_980, 4_120, 4_505]);
  });

  it('a fractional QUANTITY on a catch-weight line is refused naming both counts — a case is a whole thing', async () => {
    const res = await submitGrn({
      warehouseId,
      poId: null,
      blindReasonCode: 'unannounced-delivery',
      occurredAt: nowUtc(),
      lines: [
        {
          poLineId: null,
          skuId: sku('CW-KG'),
          batchCode: null,
          mfgDate: null,
          qty: 6.5,
          weightsGrams: [4_000, 4_100, 4_200, 4_300, 4_400, 4_500],
        },
      ],
    }).expect(400);
    expect(res.body.code).toBe('validation-failed');
    expect(res.body.detail).toContain('6.5');
    expect(res.body.detail).toContain('6 entry(ies)');
  });

  it('a weight count short of or long past the quantity is refused naming BOTH counts', async () => {
    for (const [qty, weights] of [
      [6, [18_400, 18_600, 17_950]],
      [3, [18_400, 18_600, 17_950, 19_100]],
    ] as const) {
      const res = await submitGrn({
        warehouseId,
        poId: null,
        blindReasonCode: 'unannounced-delivery',
        occurredAt: nowUtc(),
        lines: [
          {
            poLineId: null,
            skuId: sku('CW-CASE'),
            batchCode: null,
            mfgDate: null,
            qty,
            weightsGrams: [...weights],
          },
        ],
      }).expect(400);
      expect(res.body.detail).toContain(String(qty));
      expect(res.body.detail).toContain(`${weights.length} entry(ies)`);
    }
  });

  it('a catch-weight SKU with NO weights is refused — and a non-catch-weight SKU carrying weights is refused too', async () => {
    const missing = await submitGrn({
      warehouseId,
      poId: null,
      blindReasonCode: 'unannounced-delivery',
      occurredAt: nowUtc(),
      lines: [
        { poLineId: null, skuId: sku('CW-CASE'), batchCode: null, mfgDate: null, qty: 2 },
      ],
    }).expect(400);
    expect(missing.body.detail).toContain('catch-weight tracked');

    const unwanted = await blindReceipt(sku('PLAIN-CASE'), [18_400, 18_600]).expect(400);
    // Fail closed: a weight the operator recorded is never silently discarded.
    expect(unwanted.body.detail).toContain('not catch-weight tracked');

    // An EMPTY array is the other spelling of "no weights" and normalizes to
    // absent at the edge, the way every other optional arm does. Left as `[]`
    // it would hash differently from an omitted field (breaking replay) and a
    // non-catch-weight line would answer the one-weight-per-unit count
    // message instead of the refusal above.
    const emptyOnPlain = await submitGrn({
      warehouseId,
      poId: null,
      blindReasonCode: 'unannounced-delivery',
      occurredAt: nowUtc(),
      lines: [
        { poLineId: null, skuId: sku('PLAIN-CASE'), batchCode: null, mfgDate: null, qty: 1, weightsGrams: [] },
      ],
    }).expect(201);
    expect(emptyOnPlain.body.goodsReceipt.lines[0].handlingUnitIds).toBeUndefined();
    const emptyOnCatchWeight = await submitGrn({
      warehouseId,
      poId: null,
      blindReasonCode: 'unannounced-delivery',
      occurredAt: nowUtc(),
      lines: [
        { poLineId: null, skuId: sku('CW-CASE'), batchCode: null, mfgDate: null, qty: 1, weightsGrams: [] },
      ],
    }).expect(400);
    expect(emptyOnCatchWeight.body.detail).toContain('catch-weight tracked');
  });

  it('a weight outside its bounds is refused naming the bound — zero, negative, fractional and absurd alike', async () => {
    for (const bad of [0, -1, 18_400.5, MAX_HANDLING_UNIT_WEIGHT_GRAMS + 1]) {
      const res = await blindReceipt(sku('CW-CASE'), [bad]);
      // The DTO's own @IsInt/@Min/@Max catches some of these before the
      // command's gate does; both answer 400, which is the contract.
      expect(res.status).toBe(400);
    }
    // …and the ceiling itself is admitted (the bound is inclusive).
    await blindReceipt(sku('CW-CASE'), [MAX_HANDLING_UNIT_WEIGHT_GRAMS]).expect(201);
  });

  // ── over-receipt: all the rows, split by status ────────────────────────────

  it('an over-receipt creates ALL the units — the applied slice active, the excess pending_approval', async () => {
    const { poId, poLineId } = await createPo(sku('CW-OVER'), 4);
    const weights = [18_000, 18_100, 18_200, 18_300, 18_400, 18_500];
    const received = await submitGrn({
      warehouseId,
      poId,
      blindReasonCode: null,
      occurredAt: nowUtc(),
      lines: [
        {
          poLineId,
          skuId: sku('CW-OVER'),
          batchCode: null,
          mfgDate: null,
          qty: 6,
          weightsGrams: weights,
        },
      ],
    }).expect(201);
    const line = received.body.goodsReceipt.lines[0];
    expect(line.appliedQty).toBe(4);
    expect(line.excessQty).toBe(2);

    const units = await unitsOfGrn(line.id as string);
    expect(units).toHaveLength(6);
    const byId = new Map(units.map((u) => [u.id, u]));
    const statuses = (line.handlingUnitIds as string[]).map((id) => byId.get(id)!.status);
    // In weight order: the first four applied, the last two pend.
    expect(statuses).toEqual([
      'active',
      'active',
      'active',
      'active',
      'pending_approval',
      'pending_approval',
    ]);

    // Approval flips the pending pair to active — it creates no row and
    // destroys none, because the physical cases arrived either way.
    const pending = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/receiving/over-receipts?status=pending`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200)
    ).body.items as { id: string; skuId: string }[];
    const mine = pending.find((row) => row.skuId === sku('CW-OVER'))!;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/over-receipts/${mine.id}/approve`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);

    const after = await unitsOfGrn(line.id as string);
    expect(after).toHaveLength(6);
    expect(after.every((unit) => unit.status === 'active')).toBe(true);
  });

  it('a REJECTED over-receipt flips its pending units to rejected — never left pending forever, never deleted', async () => {
    const { poId, poLineId } = await createPo(sku('CW-REJECT'), 2);
    const received = await submitGrn({
      warehouseId,
      poId,
      blindReasonCode: null,
      occurredAt: nowUtc(),
      lines: [
        {
          poLineId,
          skuId: sku('CW-REJECT'),
          batchCode: null,
          mfgDate: null,
          qty: 5,
          weightsGrams: [18_000, 18_100, 18_200, 18_300, 18_400],
        },
      ],
    }).expect(201);
    const line = received.body.goodsReceipt.lines[0];

    const pending = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/receiving/over-receipts?status=pending`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200)
    ).body.items as { id: string; skuId: string }[];
    const mine = pending.find((row) => row.skuId === sku('CW-REJECT'))!;
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/over-receipts/${mine.id}/reject`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);

    const units = await unitsOfGrn(line.id as string);
    expect(units).toHaveLength(5);
    const counted = units.reduce<Record<string, number>>((acc, unit) => {
      acc[unit.status] = (acc[unit.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(counted).toEqual({ active: 2, rejected: 3 });
  });

  it('a replayed receipt re-serves its snapshot and creates no second unit row', async () => {
    const key = ulid();
    const weights = [18_050, 18_150];
    const at = nowUtc();
    const first = await blindReceipt(sku('CW-REPLAY'), weights, {}, key, at).expect(201);
    const second = await blindReceipt(sku('CW-REPLAY'), weights, {}, key, at).expect(201);
    expect(second.body).toEqual(first.body);

    const all = (await sql`
      select count(*)::int as n from handling_units
      where tenant_id = ${tenantId} and sku_id = ${sku('CW-REPLAY')}
    `) as unknown as { n: number }[];
    expect(all[0]!.n).toBe(2);
  });

  // ── catalog entry ─────────────────────────────────────────────────────────

  it('a key written by a PRE-10.3 build still replays — the new weights field is absent, not undefined-valued', async () => {
    // The offline device outbox is the whole reason this matters: a handheld
    // that queued a goods receipt under the deployed build and replays it
    // after 10.3 ships must get its original 201, not a 422 telling it the
    // payload changed. The claim "a non-catch-weight receipt hashes
    // byte-identically to its pre-10.3 shape" is load-bearing and, submitted
    // twice on the same build, completely untested — both attempts would hash
    // the same whatever the convention is.
    //
    // So the pre-10.3 key is SEEDED, hashed over the payload shape the
    // deployed build actually produced (no `weightsGrams` key at all), the way
    // `test/picking.spec.ts` pins the 10.2 convention change.
    const key = ulid();
    const occurredAt = nowUtc();
    const body = {
      warehouseId,
      poId: null,
      blindReasonCode: 'unannounced-delivery',
      occurredAt,
      lines: [
        {
          poLineId: null,
          skuId: sku('CW-LEGACY'),
          batchCode: null,
          mfgDate: null,
          qty: 2,
        },
      ],
    };
    const legacySnapshot = { goodsReceipt: { id: uuidv7(), code: 'GRN-LEGACY', lines: [] } };
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          tenantId,
          deviceId,
          operatorUserId,
          warehouseId,
          poId: null,
          blindReasonCode: 'unannounced-delivery',
          occurredAt,
          lines: [
            {
              poLineId: null,
              skuId: sku('CW-LEGACY'),
              batchCode: null,
              mfgDate: null,
              qty: 2,
              // NOTE the absence: a pre-10.3 build had no such key to emit.
              // `JSON.stringify` drops it on today's build too (the command
              // normalizes "no weights" to `undefined`), which is exactly what
              // makes the two builds hash the same bytes.
            },
          ],
        }),
        'utf8',
      )
      .digest('hex');
    await sql`
      insert into idempotency_keys (id, tenant_id, key, payload_hash, response_snapshot)
      values (${uuidv7()}, ${tenantId}, ${key}, ${payloadHash}, ${sql.json(legacySnapshot)})
    `;

    // 201 with the STORED snapshot — not 422 idempotency-key-reuse.
    const replayed = await submitGrn(body, key).expect(201);
    expect(replayed.body).toEqual(legacySnapshot);
    // And nothing was written a second time: the replay returned before any
    // receipt work, so this SKU has no handling units and no GRN of its own.
    const units = (await sql`
      select count(*)::int as n from handling_units
      where tenant_id = ${tenantId} and sku_id = ${sku('CW-LEGACY')}
    `) as unknown as { n: number }[];
    expect(units[0]!.n).toBe(0);
  });

  it('turning catch-weight tracking ON persists, and is refused once the SKU has live units', async () => {
    // The only other PATCH test targets a SERIAL SKU, so it returns at the
    // exclusivity refusal before the updates map is ever built — deleting the
    // line that writes the column would leave it green. This one writes.
    const flipped = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/catalog/skus/${sku('CW-FLIP')}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ catchWeightTracked: true })
      .expect(200);
    expect(flipped.body.catchWeightTracked).toBe(true);

    // …and a re-read agrees, so the assertion is about the COLUMN and not
    // about a response the command could have echoed from its input.
    const reread = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body.items as { code: string; catchWeightTracked: boolean }[];
    expect(reread.find((row) => row.code === 'CW-FLIP')!.catchWeightTracked).toBe(true);

    // With live units the flag is frozen in BOTH directions: off would strand
    // them and ship their stock uncounted, on would wedge pack forever.
    await blindReceipt(sku('CW-FLIP'), [18_500]).expect(201);
    const refused = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/catalog/skus/${sku('CW-FLIP')}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ catchWeightTracked: false })
      .expect(409);
    expect(refused.body.code).toBe('conflict');
    expect(refused.body.detail).toContain('1 live handling unit');
  });

  it('catch weight and serial tracking cannot coexist — refused at import as a row error, and at PATCH as a 400', async () => {
    const csv = [
      'sku_code,name,uom,gst_rate,serial_tracked,catch_weight_tracked',
      'CW-BOTH,Impossible SKU,each,1800,true,true',
    ].join('\n');
    const imported = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'both.csv', contentType: 'text/csv' })
      .expect(201);
    expect(imported.body.committedRows).toBe(0);
    expect(imported.body.failedRows).toBe(1);
    expect(imported.body.errors[0].detail).toContain('cannot both be true');

    // …and the edit path, which must ask about the RESULTING state: turning
    // catch weight on for an already-serial-tracked SKU is the same collision.
    const patched = await request(app.getHttpServer())
      .patch(`${API}/${tenantId}/catalog/skus/${sku('PLAIN-SERIAL')}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ catchWeightTracked: true })
      .expect(400);
    expect(patched.body.detail).toContain('Pick one');
  });

  it('the SKU read surface and the device catalog snapshot both carry catchWeightTracked', async () => {
    const listed = (
      await request(app.getHttpServer())
        .get(`${API}/${tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body.items as { code: string; catchWeightTracked: boolean }[];
    expect(listed.find((row) => row.code === 'CW-CASE')!.catchWeightTracked).toBe(true);
    expect(listed.find((row) => row.code === 'PLAIN-CASE')!.catchWeightTracked).toBe(false);

    // The snapshot is the reason the flag exists on the device at all: the
    // handheld has to PROMPT for a per-unit weight offline.
    const snapshot = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/devices/catalog-snapshot?warehouseId=${warehouseId}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    const snapSkus = snapshot.body.skus as { code: string; catchWeightTracked: boolean }[];
    for (const code of CATCH_WEIGHT_CODES) {
      expect(snapSkus.find((row) => row.code === code)!.catchWeightTracked).toBe(true);
    }
    expect(snapSkus.find((row) => row.code === 'PLAIN-CASE')!.catchWeightTracked).toBe(false);
  });

  // ── QC hold: refused by name ──────────────────────────────────────────────

  it('a QC hold on a catch-weight SKU is REFUSED by name — not accepted with its units left active', async () => {
    await seedPickableUnits('CW-QC', [18_000, 18_100]);
    const res = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/receiving/qc-holds`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId: sku('CW-QC'), binId: binA, reason: 'suspected temperature abuse' })
      .expect(400);
    expect(res.body.detail).toContain(sku('CW-QC'));
    expect(res.body.detail).toContain('catch-weight tracked');

    // Nothing moved: no hold row, and the units are still exactly as received.
    const holds = (await sql`
      select count(*)::int as n from qc_holds where tenant_id = ${tenantId} and sku_id = ${sku('CW-QC')}
    `) as unknown as { n: number }[];
    expect(holds[0]!.n).toBe(0);
  });

  // ── adjustment: name the units, or be refused ─────────────────────────────

  it('a catch-weight write-off must NAME its units, in the right count, and only ever its own', async () => {
    const { unitIds } = await seedPickableUnits('CW-ADJ', [18_000, 18_100, 18_200]);

    // Omitted entirely → 400 naming the requirement.
    const omitted = await adjust({
      warehouseId,
      skuId: sku('CW-ADJ'),
      binId: binA,
      quantityDelta: -1,
      reasonCode: 'damaged',
      note: 'crushed case',
    }).expect(400);
    expect(omitted.body.detail).toContain('handlingUnitIds');

    // Count mismatch → 400, mirroring the serial-count rule.
    await adjust({
      warehouseId,
      skuId: sku('CW-ADJ'),
      binId: binA,
      quantityDelta: -2,
      reasonCode: 'damaged',
      note: 'crushed case',
      handlingUnitIds: [unitIds[0]!],
    }).expect(400);

    // The same id twice is one case written off twice.
    await adjust({
      warehouseId,
      skuId: sku('CW-ADJ'),
      binId: binA,
      quantityDelta: -2,
      reasonCode: 'damaged',
      note: 'crushed case',
      handlingUnitIds: [unitIds[0]!, unitIds[0]!],
    }).expect(400);

    // An unknown id never reveals whether it exists somewhere else.
    await adjust({
      warehouseId,
      skuId: sku('CW-ADJ'),
      binId: binA,
      quantityDelta: -1,
      reasonCode: 'damaged',
      note: 'crushed case',
      handlingUnitIds: [uuidv7()],
    }).expect(404);

    // A unit of another SKU is a 422 naming both.
    const foreign = await seedPickableUnits('CW-FAILOPEN', [18_700]);
    const mismatched = await adjust({
      warehouseId,
      skuId: sku('CW-ADJ'),
      binId: binA,
      quantityDelta: -1,
      reasonCode: 'damaged',
      note: 'crushed case',
      handlingUnitIds: [foreign.unitIds[0]!],
    }).expect(422);
    expect(mismatched.body.detail).toContain(sku('CW-ADJ'));

    // A non-catch-weight SKU carrying the field is refused rather than ignored.
    await adjust({
      warehouseId,
      skuId: sku('PLAIN-CASE'),
      binId: binA,
      quantityDelta: -1,
      reasonCode: 'damaged',
      note: 'crushed case',
      handlingUnitIds: [unitIds[0]!],
    }).expect(400);

    // Nothing above wrote anything.
    expect((await unitById(unitIds[0]!))!.status).toBe('active');

    // The happy path: the named case leaves `active`, the ledger moves 1.
    await adjust({
      warehouseId,
      skuId: sku('CW-ADJ'),
      binId: binA,
      quantityDelta: -1,
      reasonCode: 'damaged',
      note: 'crushed case',
      handlingUnitIds: [unitIds[0]!],
    }).expect(201);
    expect((await unitById(unitIds[0]!))!.status).toBe('rejected');
    expect((await unitById(unitIds[1]!))!.status).toBe('active');

    // The write-off's units ride the already-hashed reference doc, SORTED —
    // so a case that never shipped has a tamper-evident record of being
    // scrapped, exactly as pack's consumption does.
    const adjustedEvents = (await sql`
      select reference_doc from ledger_events
      where tenant_id = ${tenantId} and sku_id = ${sku('CW-ADJ')} and type = 'stock.adjusted'
      and reference_doc ? 'handlingUnitIds'
    `) as unknown as { reference_doc: Record<string, unknown> }[];
    expect(adjustedEvents).toHaveLength(1);
    expect(adjustedEvents[0]!.reference_doc.handlingUnitIds).toEqual([unitIds[0]!]);

    // …and a second write-off of the same case is a 409 naming its status.
    const twice = await adjust({
      warehouseId,
      skuId: sku('CW-ADJ'),
      binId: binA,
      quantityDelta: -1,
      reasonCode: 'damaged',
      note: 'crushed case again',
      handlingUnitIds: [unitIds[0]!],
    }).expect(409);
    expect(twice.body.detail).toContain('rejected');

    // The ids are SORTED into the fingerprint: scanning two damaged cases
    // A,B is the same physical act as B,A, so a retry that reordered them
    // must REPLAY rather than answer 422 idempotency-key-reuse. Left
    // unsorted this is the defect the repo's own normalize-before-hashing
    // rule exists to prevent.
    const reorderKey = ulid();
    const pair = [unitIds[1]!, unitIds[2]!];
    const body = {
      warehouseId,
      skuId: sku('CW-ADJ'),
      binId: binA,
      quantityDelta: -2,
      reasonCode: 'damaged',
      note: 'two crushed cases',
    };
    const firstOrder = await adjust({ ...body, handlingUnitIds: pair }, reorderKey).expect(201);
    const reordered = await adjust(
      { ...body, handlingUnitIds: [...pair].reverse() },
      reorderKey,
    ).expect(201);
    expect(reordered.body).toEqual(firstOrder.body);
  });

  // ── pack: per-SKU ids, server-side line assignment ────────────────────────

  it('packing a catch-weight order consumes its units, stamps the order line, and rides the pack.packed reference doc', async () => {
    const { unitIds } = await seedPickableUnits('CW-PACK', [18_000, 18_100, 18_200]);
    const orderId = await pickedOrder([{ skuId: sku('CW-PACK'), quantity: 3 }], 'cw-pack');

    // Scanned in a DIFFERENT order than received: two orderings of the same
    // physical act must produce one pack, so the ids are sorted before hashing.
    const scrambled = [unitIds[2]!, unitIds[0]!, unitIds[1]!];
    const packed = await packOrder(orderId, [
      { skuId: sku('CW-PACK'), qty: 3, handlingUnitIds: scrambled },
    ]).expect(201);
    const orderLineId = packed.body.pack.lines[0].orderLineId as string;

    for (const id of unitIds) {
      const unit = (await unitById(id))!;
      expect(unit.status).toBe('packed');
      expect(unit.packed_order_line_id).toBe(orderLineId);
    }

    // The ids are on the already-hashed reference doc of the existing per-line
    // event — no new column, no new event type — and they are SORTED.
    const events = (await sql`
      select type, quantity_delta, reference_doc from ledger_events
      where tenant_id = ${tenantId} and sku_id = ${sku('CW-PACK')} and type = 'pack.packed'
    `) as unknown as { type: string; quantity_delta: string; reference_doc: Record<string, unknown> }[];
    expect(events).toHaveLength(1);
    expect(Number(events[0]!.quantity_delta)).toBe(0);
    expect(events[0]!.reference_doc.handlingUnitIds).toEqual([...unitIds].sort());
  });

  it('a case written off as damaged is REFUSED at the bench — the fail-open the review found', async () => {
    const { unitIds } = await seedPickableUnits('CW-FAILOPEN', [18_300, 18_400, 18_500]);
    // Write one case off, then try to ship it. Two units remain sellable.
    await adjust({
      warehouseId,
      skuId: sku('CW-FAILOPEN'),
      binId: binA,
      quantityDelta: -1,
      reasonCode: 'damaged',
      note: 'dropped at the dock',
      handlingUnitIds: [unitIds[0]!],
    }).expect(201);

    const orderId = await pickedOrder([{ skuId: sku('CW-FAILOPEN'), quantity: 2 }], 'cw-failopen');
    const refused = await packOrder(orderId, [
      // The operator scans the written-off case plus one good one.
      { skuId: sku('CW-FAILOPEN'), qty: 2, handlingUnitIds: [unitIds[0]!, unitIds[1]!] },
    ]).expect(409);
    expect(refused.body.detail).toContain('rejected');

    // Nothing was written — the order is still packable with the right cases.
    expect((await unitById(unitIds[1]!))!.status).toBe('active');
    await packOrder(orderId, [
      { skuId: sku('CW-FAILOPEN'), qty: 2, handlingUnitIds: [unitIds[1]!, unitIds[2]!] },
    ]).expect(201);
  });

  it('two order lines for ONE catch-weight SKU each land a determinate set of units, and a replay reproduces it', async () => {
    const { unitIds } = await seedPickableUnits('CW-SPLIT', [18_010, 18_020, 18_030, 18_040, 18_050]);
    const orderId = await pickedOrder(
      [
        { skuId: sku('CW-SPLIT'), quantity: 2 },
        { skuId: sku('CW-SPLIT'), quantity: 3 },
      ],
      'cw-split',
    );

    const key = ulid();
    const packed = await packOrder(
      orderId,
      // Per SKU — the bench cannot tell which LINE a case belongs to, and is
      // never asked to. The server derives the split from the picks.
      [{ skuId: sku('CW-SPLIT'), qty: 5, handlingUnitIds: [...unitIds].reverse() }],
      key,
    ).expect(201);
    expect(packed.body.pack.lines).toHaveLength(2);

    const sorted = [...unitIds].sort();
    const stamped = new Map<string, string[]>();
    for (const id of sorted) {
      const unit = (await unitById(id))!;
      expect(unit.status).toBe('packed');
      const list = stamped.get(unit.packed_order_line_id!) ?? [];
      list.push(id);
      stamped.set(unit.packed_order_line_id!, list);
    }
    // Deterministic: sorted ids consumed in order across the order's lines in
    // their own order, sized by each line's picked quantity.
    const firstLine = packed.body.pack.lines[0].orderLineId as string;
    const secondLine = packed.body.pack.lines[1].orderLineId as string;
    expect(stamped.get(firstLine)).toEqual(sorted.slice(0, 2));
    expect(stamped.get(secondLine)).toEqual(sorted.slice(2, 5));

    // The replay re-serves the identical assignment byte for byte.
    const replayed = await packOrder(
      orderId,
      [{ skuId: sku('CW-SPLIT'), qty: 5, handlingUnitIds: [...unitIds].reverse() }],
      key,
    ).expect(201);
    expect(replayed.body).toEqual(packed.body);
  });

  it('pack refuses an unknown unit, a foreign SKU’s unit, a duplicate scan, and a count that does not add up', async () => {
    const { unitIds } = await seedPickableUnits('CW-CASE', [18_060, 18_070]);
    const orderId = await pickedOrder([{ skuId: sku('CW-CASE'), quantity: 2 }], 'cw-refusals');

    // A count that does not equal the picked units → 422 naming both.
    const short = await packOrder(orderId, [
      { skuId: sku('CW-CASE'), qty: 2, handlingUnitIds: [unitIds[0]!] },
    ]).expect(422);
    expect(short.body.code).toBe('pack-mismatch');
    expect(short.body.detail).toContain('2 unit(s) were picked');
    expect(short.body.detail).toContain('1 handling unit id(s)');

    // None at all is the same question with the same answer.
    await packOrder(orderId, [{ skuId: sku('CW-CASE'), qty: 2 }]).expect(422);

    // A duplicate id in one request is a shape refusal, above the transaction.
    const dup = await packOrder(orderId, [
      { skuId: sku('CW-CASE'), qty: 2, handlingUnitIds: [unitIds[0]!, unitIds[0]!] },
    ]).expect(400);
    expect(dup.body.detail).toContain('scanned twice');

    // An unknown id is a 404 that reveals nothing.
    await packOrder(orderId, [
      { skuId: sku('CW-CASE'), qty: 2, handlingUnitIds: [unitIds[0]!, uuidv7()] },
    ]).expect(404);

    // Nothing above moved a unit.
    for (const id of unitIds) {
      expect((await unitById(id))!.status).toBe('active');
    }
  });

  /**
   * The three refusal arms that only fire once the SCAN QUANTITIES MATCH.
   *
   * This is the trap the first version of this suite fell into: a pack whose
   * quantities disagree with the picks throws `pack-mismatch` from
   * `assertScanMatchesPicked` BEFORE `resolveHandlingUnits` runs at all, so a
   * test that scans the wrong quantity pins the wrong arm and its comment
   * asserts something it never proves. Every scan below matches its picks
   * exactly, and every assertion checks `code` as well as status, so it
   * cannot pass on a different refusal again.
   */
  it('with matching quantities: a foreign SKU’s unit is 422 naming both, a non-catch-weight SKU carrying ids is 400, and a pending unit is 409', async () => {
    const { unitIds } = await seedPickableUnits('CW-ARMS', [18_090, 18_095]);
    const orderId = await pickedOrder([{ skuId: sku('CW-ARMS'), quantity: 2 }], 'cw-arms');

    // ── the foreign-SKU arm ────────────────────────────────────────────────
    // Right SKU, right COUNT, but one id belongs to another catch-weight SKU.
    // `assertScanMatchesPicked` is satisfied, so `resolveHandlingUnits` runs
    // and the per-unit guard is what answers.
    const foreign = await seedPickableUnits('CW-CASE', [18_099]);
    const wrongSku = await packOrder(orderId, [
      { skuId: sku('CW-ARMS'), qty: 2, handlingUnitIds: [unitIds[0]!, foreign.unitIds[0]!] },
    ]).expect(422);
    expect(wrongSku.body.code).toBe('validation-failed');
    // NOT `title`: `ProblemDetailsFilter` renders the wire title from the
    // exception message, which `ProblemException` sets to the DETAIL (the
    // documented repo-wide gotcha). `code` plus `detail` is the contract.
    expect(wrongSku.body.detail).toContain('belongs to SKU');
    // Named BOTH ways — the operator has to know which case to swap.
    expect(wrongSku.body.detail).toContain(sku('CW-CASE'));
    expect(wrongSku.body.detail).toContain(sku('CW-ARMS'));

    // ── the not-catch-weight arm ───────────────────────────────────────────
    // A plain SKU, picked and scanned at the SAME quantity, carrying ids.
    // Fail closed: the ids are refused, never quietly ignored.
    await seedPlainStock('PLAIN-CASE', 2);
    const plainOrder = await pickedOrder([{ skuId: sku('PLAIN-CASE'), quantity: 2 }], 'cw-plain');
    const plain = await packOrder(plainOrder, [
      { skuId: sku('PLAIN-CASE'), qty: 2, handlingUnitIds: [unitIds[0]!, unitIds[1]!] },
    ]).expect(400);
    expect(plain.body.code).toBe('validation-failed');
    expect(plain.body.detail).toContain('not catch-weight tracked');

    // ── the pending_approval arm ───────────────────────────────────────────
    // A unit whose over-receipt is still undecided is NOT sellable stock: it
    // is a case on the dock nobody has agreed to keep. 409 naming the status.
    const pendingUnits = await pendingApprovalUnits('CW-ARMS', [18_111, 18_112]);
    const pendingPack = await packOrder(orderId, [
      { skuId: sku('CW-ARMS'), qty: 2, handlingUnitIds: pendingUnits },
    ]).expect(409);
    expect(pendingPack.body.code).toBe('conflict');
    expect(pendingPack.body.detail).toContain('pending_approval');

    // The order is still packable with its own two live cases.
    await packOrder(orderId, [
      { skuId: sku('CW-ARMS'), qty: 2, handlingUnitIds: unitIds },
    ]).expect(201);
  });

  /**
   * The two guards the matrix demands that nothing else exercises.
   *
   * `pack.command.ts` refuses a unit whose `warehouseId` is not the order's,
   * and `lockHandlingUnitsInTx` only ever returns rows of the caller's tenant
   * — so a foreign unit is indistinguishable from an absent one, which is the
   * point: existence never leaks. Both were implemented and BOTH were
   * untested, so deleting either predicate left the whole suite green. That is
   * the `openCredentialForAdapterUse` shape the repo already has one of, and
   * one is enough.
   *
   * Probed by relocating a real unit's scope directly, rather than seeding a
   * second warehouse and tenant: it targets exactly the predicate under test
   * and nothing else.
   */
  /**
   * Found in review, not by the spec: the frozen matrix's adjustment row is
   * sign-agnostic, so a POSITIVE delta fell through the same guard and
   * `moveHandlingUnitsOutOfActive` would have written off live cases in order
   * to "add" stock. Receipt is the only path that can capture a weight, so
   * there is nothing an upward adjustment could name.
   */
  it('a catch-weight SKU cannot be adjusted UPWARD — receipt is the only path that captures a weight', async () => {
    const { unitIds } = await seedPickableUnits('CW-ADJUP', [18_400]);
    const refused = await adjust({
      warehouseId,
      skuId: sku('CW-ADJUP'),
      binId: binA,
      quantityDelta: 1,
      reasonCode: 'found',
      note: 'stock found on the floor',
      handlingUnitIds: [unitIds[0]!],
    }).expect(400);
    expect(refused.body.detail).toContain('receipt is the only path');
    // The named unit is untouched — a refusal that wrote anything would be
    // the very corruption this guard exists to stop.
    expect((await unitById(unitIds[0]!))!.status).toBe('active');
  });

  it('pack refuses a unit belonging to another warehouse, and another tenant, as a bare 404', async () => {
    const { unitIds: foreignWarehouse } = await seedPickableUnits('CW-CASE', [18_400]);
    const { unitIds: foreignTenant } = await seedPickableUnits('CW-CASE', [18_410]);
    const orderId = await pickedOrder([{ skuId: sku('CW-CASE'), quantity: 1 }], 'cw-foreign');

    // Same tenant, different warehouse → 404 (pack.command.ts's warehouse arm).
    await sql`
      update handling_units set warehouse_id = ${uuidv7()} where id = ${foreignWarehouse[0]!}
    `;
    await packOrder(orderId, [
      { skuId: sku('CW-CASE'), qty: 1, handlingUnitIds: [foreignWarehouse[0]!] },
    ]).expect(404);

    // Different tenant → the tenant-scoped lock read never returns it → 404.
    await sql`
      update handling_units set tenant_id = ${uuidv7()} where id = ${foreignTenant[0]!}
    `;
    await packOrder(orderId, [
      { skuId: sku('CW-CASE'), qty: 1, handlingUnitIds: [foreignTenant[0]!] },
    ]).expect(404);

    // Neither refusal moved anything.
    for (const id of [foreignWarehouse[0]!, foreignTenant[0]!]) {
      const row = (await sql`
        select status from handling_units where id = ${id}
      `) as unknown as { status: string }[];
      expect(row[0]!.status).toBe('active');
    }
  });

  // ── the invariants the story must not have disturbed ──────────────────────

  it('a FRACTIONAL-UoM catch-weight SKU: a fractional pick is refused at the SHELF, and a whole-unit one packs', async () => {
    // `CW-KG` was only ever received before this — so the one fixture that
    // exists to prove quantity and weight stay apart never crossed the pick
    // or pack boundary, which is precisely where they would be confused.
    await seedPickableUnits('CW-KGPACK', [4_100, 4_200, 4_300]);

    // ── the refusal, where the operator can still act on it ────────────────
    // A `kg` SKU can express 2.5, and the ledger would happily record it —
    // but 2.5 cases is a quantity no set of physical cases can account for.
    // It has to be refused at PICK: by pack the units have left the bin and
    // the hold is committed, and the order would be stranded with no way back.
    const fractional = await pickFirstLine('CW-KGPACK', 2.5, 'cw-kgfrac');
    expect(fractional.status).toBe(400);
    expect(fractional.body.code).toBe('validation-failed');
    expect(fractional.body.detail).toContain('whole number');
    expect(fractional.body.detail).toContain('2.5');

    // ── the happy path: whole units on a 3-decimal unit ────────────────────
    const { unitIds } = await seedPickableUnits('CW-KGPACK', [4_400, 4_500]);
    const orderId = await pickedOrder([{ skuId: sku('CW-KGPACK'), quantity: 2 }], 'cw-kgpack');
    const packed = await packOrder(orderId, [
      { skuId: sku('CW-KGPACK'), qty: 2, handlingUnitIds: unitIds },
    ]).expect(201);
    // Base units out at the edge — 2 kg, not 2000 — and the weights are the
    // grams that were captured, untouched by any scaling.
    expect(packed.body.pack.lines[0].packedQty).toBe(2);
    for (const id of unitIds) {
      expect((await unitById(id))!.status).toBe('packed');
    }
    const weights = await Promise.all(unitIds.map(async (id) => (await unitById(id))!.weight_grams));
    expect(weights.sort((a, b) => a - b)).toEqual([4_400, 4_500]);
  });

  it('a case may only ship from the LOT the pick drew — at the bench and on a write-off alike', async () => {
    // Catch weight × batch is the primary domain combination (meat is
    // lot-tracked), and it is where the two per-unit facts can silently
    // disagree: the draw re-derives its batch FEFO at pick time, while the
    // bench scans whatever case is physically in front of it. Ship a LOT-B
    // case against a LOT-A draw and `batch_on_hand` debits one lot while the
    // customer receives the other — a recall then traces to the wrong lot,
    // which is the one failure a lot-tracked SKU exists to prevent.
    const lotA = await seedPickableUnits('CW-LOTS', [18_210], { batchCode: 'LOT-A' });
    const lotB = await seedPickableUnits('CW-LOTS', [18_220], { batchCode: 'LOT-B' });

    // ── the write-off arm, while BOTH lots still have stock ────────────────
    // Debiting LOT-A while scrapping a LOT-B case leaves both lots wrong and
    // the recall trace pointing at the surviving one. Run first, so the
    // explicit-batch draw has on-hand to resolve against and the refusal
    // under test is the batch guard rather than an empty bin.
    const adjusted = await adjust({
      warehouseId,
      skuId: sku('CW-LOTS'),
      binId: binA,
      quantityDelta: -1,
      reasonCode: 'damaged',
      note: 'crushed case',
      batch: { code: 'LOT-A', overrideReason: 'explicit lot' },
      handlingUnitIds: [lotB.unitIds[0]!],
    }).expect(422);
    expect(adjusted.body.code).toBe('validation-failed');
    expect(adjusted.body.detail).toContain('written off against the lot');
    // A refusal that wrote anything would be the corruption it exists to stop.
    expect((await unitById(lotB.unitIds[0]!))!.status).toBe('active');

    // ── the bench arm ──────────────────────────────────────────────────────
    const orderId = await pickedOrder([{ skuId: sku('CW-LOTS'), quantity: 1 }], 'cw-lots');
    // Which lot FEFO actually drew is not this test's business — both are
    // undated, so the tie-break is the planner's. Read it back and scan the
    // OTHER one, so the assertion is about the guard and not about ordering.
    const drawn = (await sql`
      select distinct batch_id from picks
      where tenant_id = ${tenantId} and order_id = ${orderId}
    `) as unknown as { batch_id: string | null }[];
    expect(drawn).toHaveLength(1);
    const drawnBatch = drawn[0]!.batch_id;
    const wrongUnit =
      (await unitById(lotA.unitIds[0]!))!.batch_id === drawnBatch
        ? lotB.unitIds[0]!
        : lotA.unitIds[0]!;
    const rightUnit = wrongUnit === lotA.unitIds[0]! ? lotB.unitIds[0]! : lotA.unitIds[0]!;

    // Right SKU, right COUNT, wrong lot — so the scan passes
    // `assertScanMatchesPicked` and the per-unit batch guard is what answers.
    const mismatched = await packOrder(orderId, [
      { skuId: sku('CW-LOTS'), qty: 1, handlingUnitIds: [wrongUnit] },
    ]).expect(422);
    expect(mismatched.body.code).toBe('validation-failed');
    // Asserted on DETAIL, never `title`: the problem-details filter renders
    // the wire title from the exception message, which is the detail.
    expect(mismatched.body.detail).toContain('ships from the lot it was picked from');
    // Named both ways: the lot on the case, and the lot the line drew.
    expect(mismatched.body.detail).toContain((await unitById(wrongUnit))!.batch_id!);
    expect(mismatched.body.detail).toContain(drawnBatch!);

    // …and the right case packs, which is what makes the refusals above a
    // guard rather than a blanket "catch weight × batch is unsupported".
    await packOrder(orderId, [
      { skuId: sku('CW-LOTS'), qty: 1, handlingUnitIds: [rightUnit] },
    ]).expect(201);
    expect((await unitById(rightUnit))!.status).toBe('packed');
    expect((await unitById(wrongUnit))!.status).toBe('active');
  });

  it('a receipt whose applied slice is not a whole number of cases is refused, never floored', async () => {
    // Only reachable on a fractional UoM: a `kg` PO line may legitimately
    // open 1.5, and a delivery of two cases against it would apply 1.5 —
    // leaving 1.5 kg of live on-hand backed by ONE active case. That case can
    // never be packed (pack demands one id per picked unit, and the third
    // half-case does not exist), and there is no path back. Refused at the
    // dock, naming what to do instead.
    const { poId, poLineId } = await createPo(sku('CW-KGPACK'), 1.5);
    const refused = await submitGrn({
      warehouseId,
      poId,
      blindReasonCode: null,
      occurredAt: nowUtc(),
      lines: [
        {
          poLineId,
          skuId: sku('CW-KGPACK'),
          batchCode: null,
          mfgDate: null,
          qty: 2,
          weightsGrams: [4_600, 4_700],
        },
      ],
    }).expect(400);
    expect(refused.body.code).toBe('validation-failed');
    expect(refused.body.detail).toContain('whole number of cases');
    expect(refused.body.detail).toContain('1.5');

    // Nothing was written: no GRN, no units, no ledger movement.
    const units = (await sql`
      select count(*)::int as n from handling_units
      where tenant_id = ${tenantId} and sku_id = ${sku('CW-KGPACK')} and weight_grams = 4600
    `) as unknown as { n: number }[];
    expect(units[0]!.n).toBe(0);
  });

  it('the ledger still verifies and reconciliation still reports no divergence — this story hashes no new field', async () => {
    const facade = app.get(InventoryFacade);
    const report = await facade.verifyChain(tenantId, warehouseId);
    // Every event in THIS suite's warehouse was written post-0026, so the
    // chain is intact end to end. A new HASHED field — the design this story
    // rejected — would have broken every one of them instead; the ids ride
    // the already-hashed reference doc precisely so this stays `ok`.
    expect(report.ok).toBe(true);
    const replay = await facade.replay(tenantId, warehouseId);
    // Weight is absent from the fold BY DESIGN: it is an immutable attribute
    // of an identified thing, not a conserved delta, so there is no invariant
    // a sum of weights could be compared against.
    expect(replay.divergences).toEqual([]);
  });

  it('the status vocabulary in TypeScript is the status CHECK in the database (three copies, one list)', async () => {
    const constraint = (await sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'handling_units_status_check'
    `) as unknown as { def: string }[];
    expect(constraint).toHaveLength(1);
    for (const status of HANDLING_UNIT_STATUSES) {
      expect(constraint[0]!.def).toContain(`'${status}'`);
    }
    // And the DB refuses anything outside it — an allow-list, not a comment.
    const anyUnit = (await sql`
      select id from handling_units where tenant_id = ${tenantId} limit 1
    `) as unknown as { id: string }[];
    await expect(
      sql`update handling_units set status = 'in_transit' where id = ${anyUnit[0]!.id}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the weight CHECK is the backstop behind the command refusal, and its BOUND is the TS constant', async () => {
    // Pinned the way the status vocabulary is. Probing 0 / -1 / MAX+1 alone
    // proves only that *some* bound exists: raise
    // MAX_HANDLING_UNIT_WEIGHT_GRAMS and the behavioural probe stays green
    // while the DDL sits at the old number, and the command and the database
    // then disagree about what is storable.
    const constraint = (await sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'handling_units_weight_grams_bounded'
    `) as unknown as { def: string }[];
    expect(constraint).toHaveLength(1);
    expect(constraint[0]!.def).toContain(String(MAX_HANDLING_UNIT_WEIGHT_GRAMS));
    // …and it is an upper bound on a strictly positive column, not merely a
    // string that happens to contain the number.
    expect(constraint[0]!.def.replace(/\s+/g, ' ')).toMatch(
      new RegExp(`weight_grams\\s*>\\s*0.*weight_grams\\s*<=\\s*${MAX_HANDLING_UNIT_WEIGHT_GRAMS}`),
    );

    const anyUnit = (await sql`
      select id from handling_units where tenant_id = ${tenantId} limit 1
    `) as unknown as { id: string }[];
    for (const bad of [0, -1, MAX_HANDLING_UNIT_WEIGHT_GRAMS + 1]) {
      await expect(
        sql`update handling_units set weight_grams = ${bad} where id = ${anyUnit[0]!.id}`,
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('RLS fails closed on handling_units: unscoped and foreign-scoped reads see zero rows', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'wms_rls_probe';
    url.password = 'wms_rls_probe';
    const rls = postgres(url.toString(), { max: 1 });
    const foreignTenant = uuidv7();
    try {
      const seeded = (await sql`
        select count(*)::int as n from handling_units where tenant_id = ${tenantId}
      `) as unknown as { n: number }[];
      expect(seeded[0]!.n).toBeGreaterThan(0);

      const unscoped = await rls`select id from handling_units where tenant_id = ${tenantId}`;
      expect(unscoped).toHaveLength(0);

      const foreign = await rls.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${foreignTenant}, true)`;
        return tx`select id from handling_units where tenant_id = ${tenantId}`;
      });
      expect(foreign).toHaveLength(0);

      const own = await rls.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        return tx`select id from handling_units where tenant_id = ${tenantId}`;
      });
      expect(own.length).toBeGreaterThan(0);

      // The write side fails closed too (the WITH CHECK arm).
      await expect(
        rls.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${foreignTenant}, true)`;
          return tx.unsafe(
            `insert into handling_units (id, tenant_id, warehouse_id, sku_id, grn_line_id, weight_grams)
             values ('${uuidv7()}'::uuid, '${tenantId}'::uuid, '${warehouseId}'::uuid,
                     '${sku('CW-CASE')}'::uuid, '${uuidv7()}'::uuid, 18400)`,
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await rls.end();
    }
  });
});
