import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { QC_HOLD_KINDS } from '../src/modules/inbound/qc.command';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { REJECTED_OP_DECISIONS_BY_TYPE, REJECTED_OP_TYPES } from '../src/modules/tenancy/sync-report.command';
import { SKU_NAMING_OP_TYPES } from '../src/modules/tenancy/client-wind-down';
import {
  RETURN_DISPOSITION_OUTCOMES,
  RETURN_DISPOSITION_REASONS,
  disposePayloadHash,
  normalizeDispose,
  normalizeRestock,
  restockPayloadHash,
} from '../src/modules/returns/return-disposition.command';
import { ReturnHoldSettlementHandler } from '../src/modules/returns/hold-settlement.delivery';
import { ReturnsController } from '../src/api/returns.controller';
import { EVENT_BUS } from '../src/shared/events/event-bus';
import type { EventBus } from '../src/shared/events/event-bus.seam';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { expectAuditRow } from './support/audit-guard';
import { dispatchedOrderFixtures, type Picklist } from './support/dispatched-order';
import { mintSignIn } from './support/sign-in';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;

jest.setTimeout(240_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
/** The advisory key every suite uses to serialize wms_rls_probe role setup. */
const PROBE_LOCK = 742105;

interface ReceiptLineView {
  id: string;
  rmaLineId: string;
  skuId: string;
  qty: number;
  condition: string;
  openQty: number;
  restockedQty: number;
  scrappedQty: number;
  onHoldQty: number;
  failedInspectionQty: number;
}

interface RmaBody {
  id: string;
  code: string;
  status: string;
  lines: { id: string; orderLineId: string; skuId: string; authorizedQty: number; receivedQty: number }[];
  receipts?: { id: string; code: string; lines: ReceiptLineView[] }[];
}

interface ReturnableBody {
  lines: { orderLineId: string; skuId: string; returnableQty: number }[];
}

interface DispositionBody {
  dispositions: { id: string; receiptLineId: string; rmaId: string; outcome: string; qty: number; toBinId: string | null; qcHoldId: string | null; ledgerEventId: string | null }[];
}

/** Second-precision device time, Z-suffixed. */
function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * Story 4-7a (FR-48) — returns disposition. Every backend row of the spec's
 * two I/O matrices, driven through real HTTP against really dispatched and
 * really received returns: the web's restock / quarantine / scrap, the
 * handheld's FIFO restock, the hold-settlement subscriber (release and
 * inspection, redelivery, data faults), conservation and reconcile, ATP and
 * the channel-visible figure, the goldens, the races, the portal's two
 * layers and the wms_rls_probe proof of the two new tables.
 */
describe('returns disposition (e2e, story 4-7a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let inventory: InventoryFacade;
  let settlement: ReturnHoldSettlementHandler;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let opsUserId: string;
  let operatorToken: string;
  let operatorUserId: string;
  let accountantToken: string;
  let deviceId: string;
  let warehouseId: string;
  let otherWarehouseId: string;
  let stockBin: string;
  let shelfA: string;
  let shelfB: string;
  let retiredBin: string;
  let brandBin: string;
  let caseBin: string;
  let brandId: string;
  let otherClientId: string;
  let portalBrand: string;
  let portalOther: string;
  const skuIds = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const fixtures = dispatchedOrderFixtures(() => ({ app, tenantId, warehouseId, opsToken, ownerToken, operatorToken }));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('return_dispositions');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 3, onnotice: () => undefined });
    inventory = app.get(InventoryFacade);
    settlement = app.get(ReturnHoldSettlementHandler);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Return Dispositions Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
    const ops = await createMember('ops_manager');
    opsToken = ops.token;
    opsUserId = ops.userId;
    accountantToken = (await createMember('accountant')).token;
    const floor = await createMember('operator');
    operatorUserId = floor.userId;

    warehouseId = await createWarehouse('RD');
    otherWarehouseId = await createWarehouse('RX');
    const zoneId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    stockBin = await createBin(zoneId, 'A-00');
    shelfA = await createBin(zoneId, 'A-01');
    shelfB = await createBin(zoneId, 'A-02');
    retiredBin = await createBin(zoneId, 'A-09');
    brandBin = await createBin(zoneId, 'A-BR');
    caseBin = await createBin(zoneId, 'A-CW');

    await importSkus(null, [
      'RD-A,Return A,pcs,,1800,,false,false,false,,,',
      'RD-B,Return B,pcs,,1800,,false,false,false,,,',
      'RD-C,Return C,pcs,,1800,,false,false,false,,,',
      'RD-SER,Return serial,pcs,,1800,,false,true,false,,,',
      'RD-BAT,Return batch,pcs,,1800,,true,false,false,,,',
      'RD-CW,Return catch weight,case,,1800,,false,false,true,,,',
    ]);
    for (const [code, name] of [
      ['BRAND', 'Brand Co'],
      ['OTHER', 'Other Co'],
    ] as const) {
      const res = await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name })
        .expect(201);
      if (code === 'BRAND') brandId = res.body.client.id as string;
      else otherClientId = res.body.client.id as string;
    }

    await importSkus(brandId, ['PB-1,Brand tee,pcs,,1800,,false,false,false,,,']);

    for (const code of ['RD-A', 'RD-B', 'RD-C']) await seedStock(sku(code), 1000);
    await seedStock(sku('RD-SER'), 4, ['RS-1', 'RS-2', 'RS-3', 'RS-4']);
    await seedStock(sku('PB-1'), 100);

    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Returns restock scanner', pin: '2468' })
      .expect(201);
    deviceId = enrolled.body.device.id as string;
    operatorToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: floor.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

    // A bin dedicated to the brand (the client gate), and one retired.
    await http()
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${brandBin}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ dedicatedClientId: brandId })
      .expect(200);
    await http()
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/bins/${retiredBin}/retire`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect((res) => {
        if (res.status !== 200 && res.status !== 201) throw new Error(`retire answered ${res.status}: ${JSON.stringify(res.body)}`);
      });
    portalBrand = await portalUser(brandId);
    portalOther = await portalUser(otherClientId);
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

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  async function importSkus(clientId: string | null, rows: string[]): Promise<void> {
    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,catch_weight_tracked,reorder_point,reorder_qty,barcode',
      ...rows,
    ].join('\n');
    const req = http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial');
    if (clientId !== null) req.field('clientId', clientId);
    const imported = await req.attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' }).expect(201);
    expect(imported.body.failedRows).toBe(0);
    const stored = (await sql`select id, code from skus where tenant_id = ${tenantId}`) as unknown as { id: string; code: string }[];
    for (const row of stored) skuIds.set(row.code, row.id);
  }

  async function createWarehouse(prefix: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `${prefix}-${ulid().slice(20)}`, name: `${prefix} WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
  }

  async function createBin(zoneId: string, code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code })
        .expect(201)
    ).body.id as string;
  }

  async function createMember(role: string): Promise<{ userId: string; token: string; email: string }> {
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
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const token = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
    return { userId: invited.body.user.id as string, token, email };
  }

  async function portalUser(clientId: string): Promise<string> {
    const email = `portal-${ulid().toLowerCase()}@brand.example`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role: 'client', clientId })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    return (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
  }

  async function seedStock(skuId: string, quantity: number, serials?: string[], batch?: { code: string; expiryDate?: string }): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        skuId,
        binId: stockBin,
        quantityDelta: quantity,
        reasonCode: 'stock-count',
        note: 'return-dispositions seed',
        ...(serials === undefined ? {} : { serials }),
        ...(batch === undefined ? {} : { batch }),
      })
      .expect(201);
  }

  function scannedOf(picklist: Picklist, cases?: string[]): { skuId: string; qty: number; handlingUnitIds?: string[] }[] {
    const bySku = new Map<string, number>();
    for (const line of picklist.lines) bySku.set(line.skuId, (bySku.get(line.skuId) ?? 0) + line.qty);
    return [...bySku].map(([skuId, qty]) => ({ skuId, qty, ...(cases !== undefined && skuId === sku('RD-CW') ? { handlingUnitIds: cases } : {}) }));
  }

  /**
   * A dispatched order of `qty` × `code`, authorized for return and received
   * with `entries` (each `{qty, condition, serialNumber?, batchCode?, weightGrams?}`).
   * Answers the RMA and its receipt lines (in entry order).
   */
  async function receivedReturn(
    code: string,
    qty: number,
    entries: { qty: number; condition?: string; serialNumber?: string; batchCode?: string; weightGrams?: number }[],
    options: { serials?: string[]; cases?: string[] } = {},
  ): Promise<{ rma: RmaBody; lines: ReceiptLineView[] }> {
    const { orderId, picklist } = await fixtures.releasedWave([{ skuId: sku(code), quantity: qty }]);
    await fixtures.pickAllLines(picklist, undefined, options.serials === undefined ? undefined : new Map([[picklist.lines[0]!.id, options.serials]]));
    await fixtures.packAndDispatch(orderId, scannedOf(picklist, options.cases));
    const returnable = (await http().get(`${API}/${tenantId}/returns/returnable?orderId=${orderId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200))
      .body as ReturnableBody;
    const orderLine = returnable.lines.find((line) => line.skuId === sku(code))!;
    const rma = (
      await http()
        .post(`${API}/${tenantId}/returns`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          orderId,
          lines: [{ orderLineId: orderLine.orderLineId, qty, reasonCode: 'damaged', ...(options.serials === undefined ? {} : { serialNumbers: options.serials }) }],
        })
        .expect(201)
    ).body as RmaBody;
    const received = await http()
      .post(`${API}/${tenantId}/returns/receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId,
        rmaId: rma.id,
        occurredAt: nowUtc(),
        entries: entries.map((entry) => ({
          rmaLineId: rma.lines[0]!.id,
          skuId: sku(code),
          qty: entry.qty,
          condition: entry.condition ?? 'resaleable',
          serialNumber: entry.serialNumber ?? null,
          batchCode: entry.batchCode ?? null,
          weightGrams: entry.weightGrams ?? null,
        })),
      })
      .expect(201);
    expect(received.body.refused).toEqual([]);
    const detail = await rmaDetail(rma.id);
    return { rma: detail, lines: detail.receipts!.flatMap((receipt) => receipt.lines) };
  }

  async function rmaDetail(rmaId: string): Promise<RmaBody> {
    return (await http().get(`${API}/${tenantId}/returns/${rmaId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body as RmaBody;
  }

  async function lineView(rmaId: string, lineId: string): Promise<ReceiptLineView> {
    return (await rmaDetail(rmaId)).receipts!.flatMap((receipt) => receipt.lines).find((line) => line.id === lineId)!;
  }

  function dispose(body: Record<string, unknown>, key = ulid(), token = opsToken): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/returns/dispositions`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, ...body });
  }

  function restock(body: Record<string, unknown>, key = ulid(), token = operatorToken): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/returns/restocks`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, occurredAt: nowUtc(), batchCode: null, serialNumbers: null, ...body });
  }

  async function count(query: PromiseLike<unknown>): Promise<number> {
    const rows = (await query) as { n: number | string }[];
    return Number(rows[0]!.n);
  }

  async function systemBin(code: string): Promise<string> {
    const rows = (await sql`select id from bins where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and code = ${code} and system_owned`) as unknown as {
      id: string;
    }[];
    return rows[0]!.id;
  }

  async function onHandIn(bin: string, skuId: string): Promise<number> {
    return count(sql`select coalesce(sum(quantity), 0)::bigint as n from stock_on_hand where tenant_id = ${tenantId} and bin_id = ${bin} and sku_id = ${skuId}`);
  }

  async function atp(skuId: string): Promise<number> {
    return (await inventory.atp(tenantId, warehouseId, skuId)).atp;
  }

  async function openQty(lineId: string): Promise<number> {
    return count(sql`select open_qty::bigint as n from return_receipt_lines where id = ${lineId}`);
  }

  /** Deliver the hold's closing outbox event (release or inspection) to the subscriber, as the relay would. */
  async function deliverClose(holdId: string): Promise<string> {
    const rows = (await sql`
      select id as message_id, type, payload, occurred_at from outbox_messages
      where tenant_id = ${tenantId} and type in ('qc_hold.released', 'qc_hold.inspected') and payload->>'holdId' = ${holdId}
      order by created_at desc limit 1`) as unknown as { message_id: string; type: string; payload: Record<string, unknown>; occurred_at: string }[];
    const row = rows[0]!;
    return settlement.deliver({ eventId: row.message_id, tenantId, type: row.type, occurredAt: String(row.occurred_at), payload: row.payload } as never);
  }

  /** Publish the hold's closing outbox event through the app's routed event bus (as the relay does). */
  async function publishClose(holdId: string): Promise<void> {
    const rows = (await sql`
      select id, type, payload, occurred_at from outbox_messages
      where tenant_id = ${tenantId} and type in ('qc_hold.released', 'qc_hold.inspected') and payload->>'holdId' = ${holdId}
      order by created_at desc limit 1`) as unknown as { id: string; type: string; payload: Record<string, unknown>; occurred_at: string }[];
    const row = rows[0]!;
    await app.get<EventBus>(EVENT_BUS).publish({ eventId: row.id, tenantId, type: row.type, occurredAt: String(row.occurred_at), payload: row.payload } as never);
  }

  // ── the goldens and the vocabularies ───────────────────────────────────────

  describe('fingerprints and vocabularies', () => {
    it('golden — the web dispose hash: arm first, every key present, the note trimmed (A28), the quantity as sent (4, never 4000)', () => {
      const normalized = normalizeDispose({
        warehouseId: 'AAAAAAAA-0000-4000-8000-000000000001',
        receiptLineId: 'aaaaaaaa-0000-4000-8000-000000000002',
        outcome: 'scrap',
        qty: 4,
        toBinId: null,
        reasonCode: 'other',
        note: '  crushed in transit  ',
      });
      expect(disposePayloadHash('t-1', normalized)).toBe(
        hashCommandPayload({
          arm: 'return-dispose',
          tenantId: 't-1',
          warehouseId: 'aaaaaaaa-0000-4000-8000-000000000001',
          receiptLineId: 'aaaaaaaa-0000-4000-8000-000000000002',
          outcome: 'scrap',
          qty: 4,
          toBinId: null,
          reasonCode: 'other',
          note: 'crushed in transit',
        }),
      );
      // A blank note is absent — the same request as no note.
      const blank = normalizeDispose({ warehouseId: uuidv7(), receiptLineId: uuidv7(), outcome: 'scrap', qty: 1, reasonCode: 'damaged', note: '   ' });
      expect(blank.note).toBeNull();
    });

    it('golden — the device restock hash (the spec\'s Design Notes): serials trimmed, sorted; a padded batch code trimmed; qty 4 hashes as 4', () => {
      const deviceTime = '2026-10-27T10:00:00Z';
      const normalized = normalizeRestock({
        warehouseId: 'aaaaaaaa-0000-4000-8000-000000000001',
        skuId: 'aaaaaaaa-0000-4000-8000-000000000003',
        qty: 4,
        batchCode: null,
        serialNumbers: null,
        toBinId: 'aaaaaaaa-0000-4000-8000-000000000004',
        occurredAt: deviceTime,
      });
      expect(restockPayloadHash('t-1', 'd-1', 'u-1', normalized)).toBe(
        hashCommandPayload({
          arm: 'return-restock',
          tenantId: 't-1',
          deviceId: 'd-1',
          operatorUserId: 'u-1',
          warehouseId: 'aaaaaaaa-0000-4000-8000-000000000001',
          skuId: 'aaaaaaaa-0000-4000-8000-000000000003',
          qty: 4,
          batchCode: null,
          serialNumbers: null,
          toBinId: 'aaaaaaaa-0000-4000-8000-000000000004',
          occurredAt: deviceTime,
        }),
      );
      const serial = normalizeRestock({
        warehouseId: uuidv7(),
        skuId: uuidv7(),
        qty: 2,
        serialNumbers: [' S-2 ', 'S-1'],
        toBinId: uuidv7(),
        occurredAt: deviceTime,
      });
      expect(serial.serialNumbers).toEqual(['S-1', 'S-2']);
      expect(normalizeRestock({ warehouseId: uuidv7(), skuId: uuidv7(), qty: 1, batchCode: '  B1 ', toBinId: uuidv7(), occurredAt: deviceTime }).batchCode).toBe('B1');
      expect(() => normalizeRestock({ warehouseId: uuidv7(), skuId: uuidv7(), qty: 1, toBinId: uuidv7(), occurredAt: '2026-10-27T10:00:00+05:30' })).toThrow(
        /occurredAt/,
      );
      expect(() => normalizeRestock({ warehouseId: uuidv7(), skuId: uuidv7(), qty: 2, serialNumbers: ['S-1', ' S-1'], toBinId: uuidv7(), occurredAt: deviceTime })).toThrow(
        /twice/,
      );
    });

    it('the TS tuples mirror their CHECKs: outcomes, reasons, and the widened QC hold kinds', async () => {
      const checks = (await sql`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('return_dispositions_outcome_check', 'return_dispositions_reason_check', 'qc_holds_kind_check')`) as unknown as {
        conname: string;
        def: string;
      }[];
      const quoted = (name: string): string[] => [...checks.find((row) => row.conname === name)!.def.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
      expect(quoted('return_dispositions_outcome_check')).toEqual([...RETURN_DISPOSITION_OUTCOMES].sort());
      expect(quoted('return_dispositions_reason_check')).toEqual([...RETURN_DISPOSITION_REASONS].sort());
      expect(quoted('qc_holds_kind_check')).toEqual([...QC_HOLD_KINDS].sort());
    });

    it('the device op is a Discard-only review type that names its SKU (the wind-down read)', () => {
      expect(REJECTED_OP_TYPES).toContain('return.restock');
      expect(REJECTED_OP_DECISIONS_BY_TYPE['return.restock']).toEqual(['discard']);
      expect(SKU_NAMING_OP_TYPES).toContain('return.restock');
    });
  });

  // ── the web: restock ───────────────────────────────────────────────────────

  describe('web restock', () => {
    it('part of a line: 1 return.restocked of 3 RETURNS → the bin; open 2; ATP and the channel-visible figure +3; audited; a replay re-serves it; another body is 422', async () => {
      const { rma, lines } = await receivedReturn('RD-A', 5, [{ qty: 5 }]);
      const line = lines[0]!;
      const returnsBin = await systemBin('RETURNS');
      const atpBefore = await atp(sku('RD-A'));
      const visibleBefore = (await inventory.channelVisibleQuantity(tenantId, warehouseId, sku('RD-A'), uuidv7())).visibleMilli;
      const key = ulid();
      const res = await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 3, toBinId: shelfA }, key).expect(201);
      const body = res.body as DispositionBody;
      expect(body.dispositions).toHaveLength(1);
      expect(body.dispositions[0]).toMatchObject({ receiptLineId: line.id, rmaId: rma.id, outcome: 'restock', qty: 3, toBinId: shelfA, qcHoldId: null });
      const events = (await sql`select type, quantity_delta, from_bin_id, to_bin_id, reference_doc from ledger_events where id = ${body.dispositions[0]!.ledgerEventId!}`) as unknown as {
        type: string;
        quantity_delta: string;
        from_bin_id: string;
        to_bin_id: string;
        reference_doc: Record<string, unknown>;
      }[];
      expect(events[0]).toMatchObject({ type: 'return.restocked', from_bin_id: returnsBin, to_bin_id: shelfA });
      expect(Number(events[0]!.quantity_delta)).toBe(3000);
      // A8 — exactly these keys; no reasonCode / handlingUnitIds key at all.
      expect(events[0]!.reference_doc).toEqual({
        kind: 'return-disposition',
        dispositionId: body.dispositions[0]!.id,
        returnReceiptLineId: line.id,
        rmaId: rma.id,
        outcome: 'restock',
      });
      expect(await openQty(line.id)).toBe(2000);
      expect(await atp(sku('RD-A'))).toBe(atpBefore + 3000);
      expect((await inventory.channelVisibleQuantity(tenantId, warehouseId, sku('RD-A'), uuidv7())).visibleMilli).toBe(visibleBefore + 3000);
      expect(await lineView(rma.id, line.id)).toMatchObject({ openQty: 2, restockedQty: 3, scrappedQty: 0, onHoldQty: 0, failedInspectionQty: 0 });
      await expectAuditRow({ tenantId, key, action: 'return_disposition.recorded', targetType: 'return_disposition', targetId: body.dispositions[0]!.id, actorUserId: opsUserId });
      const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as { changes: Record<string, unknown> }[];
      expect(audit[0]!.changes).toEqual({ dispositionIds: [body.dispositions[0]!.id], outcome: 'restock', deviceId: null, operatorUserId: null });
      const outbox = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'return_disposition.recorded' and payload->>'firstDispositionId' = ${body.dispositions[0]!.id}`) as unknown as {
        payload: Record<string, unknown>;
      }[];
      expect(outbox[0]!.payload).toEqual({
        warehouseId,
        clientId: expect.any(String),
        skuId: sku('RD-A'),
        outcome: 'restock',
        qty: '3',
        dispositionCount: 1,
        firstDispositionId: body.dispositions[0]!.id,
      });
      // Replay — the stored snapshot, nothing written twice.
      const replay = await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 3, toBinId: shelfA }, key).expect(201);
      expect(replay.body).toEqual(res.body);
      expect(await openQty(line.id)).toBe(2000);
      await expectAuditRow({ tenantId, key, action: 'return_disposition.recorded', targetType: 'return_disposition', targetId: body.dispositions[0]!.id, actorUserId: opsUserId });
      const reuse = await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 2, toBinId: shelfA }, key).expect(422);
      expect(reuse.body.code).toBe('idempotency-key-reuse');
    });

    it('gate refusals write nothing: retired 409 bin-retired, a system bin 400, another client\'s dedicated bin 409 bin-client-mismatch; over-dispose 409 exceeds-awaiting (awaitingQty); wrong warehouse 409; an unknown line 404', async () => {
      const { lines } = await receivedReturn('RD-A', 2, [{ qty: 2 }]);
      const line = lines[0]!;
      expect((await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 1, toBinId: retiredBin }).expect(409)).body.code).toBe('bin-retired');
      expect((await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 1, toBinId: await systemBin('RETURNS') }).expect(400)).body.code).toBe('validation-failed');
      expect((await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 1, toBinId: brandBin }).expect(409)).body.code).toBe('bin-client-mismatch');
      const over = await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 3, toBinId: shelfA }).expect(409);
      expect(over.body).toMatchObject({ code: 'exceeds-awaiting', awaitingQty: 2 });
      expect((await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 1, toBinId: shelfA, warehouseId: otherWarehouseId }).expect(409)).body.code).toBe(
        'document-warehouse-mismatch',
      );
      expect((await dispose({ receiptLineId: uuidv7(), outcome: 'restock', qty: 1, toBinId: shelfA }).expect(404)).body.code).toBe('not-found');
      expect(await openQty(line.id)).toBe(2000);
      expect(await count(sql`select count(*)::int as n from return_dispositions where return_receipt_line_id = ${line.id}`)).toBe(0);
    });

    it('shape 400s above the transaction; authority 403 for a member without returns.manage', async () => {
      const id = uuidv7();
      expect((await dispose({ receiptLineId: id, outcome: 'scrap', qty: 1 }).expect(400)).body.detail).toMatch(/reasonCode/);
      expect((await dispose({ receiptLineId: id, outcome: 'scrap', qty: 1, reasonCode: 'other' }).expect(400)).body.detail).toMatch(/note/);
      expect((await dispose({ receiptLineId: id, outcome: 'restock', qty: 1, toBinId: shelfA, reasonCode: 'damaged' }).expect(400)).body.detail).toMatch(/no reasonCode/);
      expect((await dispose({ receiptLineId: id, outcome: 'restock', qty: 1 }).expect(400)).body.detail).toMatch(/toBinId/);
      expect((await dispose({ receiptLineId: id, outcome: 'quarantine', qty: 1, reasonCode: 'damaged', toBinId: shelfA }).expect(400)).body.code).toBe('validation-failed');
      expect((await dispose({ receiptLineId: id, outcome: 'scrap', qty: 1, reasonCode: 'damaged', note: 'x'.repeat(201) }).expect(400)).body.code).toBe('validation-failed');
      expect((await dispose({ receiptLineId: id, outcome: 'restock', qty: 1, toBinId: shelfA }, ulid(), accountantToken).expect(403)).body.code).toBe('role-denied');
      expect((await dispose({ receiptLineId: id, outcome: 'restock', qty: 1, toBinId: shelfA }, ulid(), operatorToken).expect(401)).status).toBe(401);
    });

    it('a reconcile quarantine on RETURNS or on the target refuses 409 disposition-scope-quarantined', async () => {
      const { lines } = await receivedReturn('RD-C', 2, [{ qty: 2 }]);
      const line = lines[0]!;
      const returnsBin = await systemBin('RETURNS');
      for (const bin of [returnsBin, shelfB]) {
        const [q] = (await sql`
          insert into inventory_quarantines (id, tenant_id, warehouse_id, sku_id, bin_id, from_seq, to_seq, reason)
          values (gen_random_uuid(), ${tenantId}, ${warehouseId}, ${sku('RD-C')}, ${bin}, 1, 1, 'test') returning id`) as unknown as { id: string }[];
        const res = await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 1, toBinId: shelfB }).expect(409);
        expect(res.body.code).toBe('disposition-scope-quarantined');
        await sql`update inventory_quarantines set status = 'resolved' where id = ${q!.id}`;
      }
      await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 2, toBinId: shelfB }).expect(201);
    });
  });

  // ── quarantine and the settlement subscriber ───────────────────────────────

  describe('quarantine', () => {
    it('quarantine 2 → qc.held RETURNS → QC-HOLD on a `return` hold (the RMA in its reason); open −2, ATP unchanged; the QC desk names the RMA; release → the subscriber adds 2 back, once', async () => {
      const { rma, lines } = await receivedReturn('RD-B', 3, [{ qty: 3 }]);
      const line = lines[0]!;
      const atpBefore = await atp(sku('RD-B'));
      const res = await dispose({ receiptLineId: line.id, outcome: 'quarantine', qty: 2, reasonCode: 'needs-inspection', note: '  smells  ' }).expect(201);
      const holdId = (res.body as DispositionBody).dispositions[0]!.qcHoldId!;
      expect((res.body as DispositionBody).dispositions[0]!.ledgerEventId).toBeNull();
      const hold = (await sql`select kind, status, bin_id, reason from qc_holds where id = ${holdId}`) as unknown as { kind: string; status: string; bin_id: string; reason: string }[];
      expect(hold[0]).toEqual({ kind: 'return', status: 'open', bin_id: await systemBin('RETURNS'), reason: `return ${rma.code} · needs-inspection` });
      const held = (await sql`select from_bin_id, to_bin_id, quantity_delta from ledger_events where type = 'qc.held' and reference_doc->>'holdId' = ${holdId}`) as unknown as {
        from_bin_id: string;
        to_bin_id: string;
        quantity_delta: string;
      }[];
      expect(held).toHaveLength(1);
      expect(held[0]!.from_bin_id).toBe(await systemBin('RETURNS'));
      expect(held[0]!.to_bin_id).toBe(await systemBin('QC-HOLD'));
      expect(await openQty(line.id)).toBe(1000);
      expect(await atp(sku('RD-B'))).toBe(atpBefore);
      // The note stays on the disposition row (trimmed), never in QC's reason.
      expect(await count(sql`select count(*)::int as n from return_dispositions where qc_hold_id = ${holdId} and note = 'smells'`)).toBe(1);
      // The placed event rides the manual hold's payload shape (the qc-hold notification raises).
      const placed = (await sql`select payload from outbox_messages where type = 'qc_hold.placed' and payload->>'holdId' = ${holdId}`) as unknown as {
        payload: Record<string, unknown>;
      }[];
      expect(Object.keys(placed[0]!.payload).sort()).toEqual(['binId', 'heldAt', 'heldBy', 'holdId', 'reason', 'skuId', 'tenantId', 'warehouseId']);
      const desk = await http().get(`${API}/${tenantId}/receiving/qc-holds?warehouseId=${warehouseId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      const row = (desk.body.items as { id: string; kind: string; rmaCode?: string }[]).find((item) => item.id === holdId)!;
      expect(row).toMatchObject({ kind: 'return', rmaCode: rma.code });
      const holdDetail = await http().get(`${API}/${tenantId}/receiving/qc-holds/${holdId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect(holdDetail.body.qcHold).toMatchObject({ kind: 'return', rmaCode: rma.code });
      expect(await lineView(rma.id, line.id)).toMatchObject({ openQty: 1, onHoldQty: 2 });

      // A second quarantine of the remaining unit is allowed (prior count 1 on the queue).
      // Release through the QC desk — the units return to RETURNS.
      const released = await http()
        .post(`${API}/${tenantId}/receiving/qc-holds/${holdId}/release`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect((r) => {
          if (r.status !== 200 && r.status !== 201) throw new Error(`release answered ${r.status}: ${JSON.stringify(r.body)}`);
        });
      expect(released.body.qcHold.status).toBe('released');
      // The release payload carries no `kind` (the qc-hold notification resolves).
      const closed = (await sql`select payload from outbox_messages where type = 'qc_hold.released' and payload->>'holdId' = ${holdId}`) as unknown as {
        payload: Record<string, unknown>;
      }[];
      expect('kind' in closed[0]!.payload).toBe(false);
      // Before the subscriber runs the units still count as on hold (A1's window).
      expect(await openQty(line.id)).toBe(1000);
      // Through the REAL bus (the subscription, not a direct call): one publish settles.
      await publishClose(holdId);
      expect(await openQty(line.id)).toBe(3000);
      // Redelivery — at-least-once: one settlement, open raised once.
      expect(await deliverClose(holdId)).toBe('already-settled');
      expect(await openQty(line.id)).toBe(3000);
      expect(await count(sql`select count(*)::int as n from return_hold_settlements where qc_hold_id = ${holdId}`)).toBe(1);
      expect(await lineView(rma.id, line.id)).toMatchObject({ openQty: 3, onHoldQty: 0, failedInspectionQty: 0 });
      // The queue card shows the line's history (A14).
      const queue = await http().get(`${API}/${tenantId}/returns/awaiting?warehouseId=${warehouseId}&limit=100`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect((queue.body.items as { receiptLineId: string }[]).find((item) => item.receiptLineId === line.id)).toMatchObject({
        openQty: 3,
        onHoldQty: 0,
        priorQuarantines: 1,
        lastReasonCode: 'needs-inspection',
        rmaCode: rma.code,
        skuCode: 'RD-B',
        condition: 'resaleable',
      });
    });

    it('quarantine 3 → inspect pass 1 / fail 2 → after the subscriber: open +1, failed inspection 2 (in DAMAGED)', async () => {
      const { rma, lines } = await receivedReturn('RD-B', 3, [{ qty: 3, condition: 'opened' }]);
      const line = lines[0]!;
      const holdId = ((await dispose({ receiptLineId: line.id, outcome: 'quarantine', qty: 3, reasonCode: 'defective' }).expect(201)).body as DispositionBody)
        .dispositions[0]!.qcHoldId!;
      const damaged = await onHandIn(await systemBin('QC-HOLD'), sku('RD-B'));
      expect(damaged).toBeGreaterThanOrEqual(3000);
      await http()
        .post(`${API}/${tenantId}/receiving/qc-holds/${holdId}/inspect`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ lines: [{ batchId: null, passed: 1, failed: [{ reason: 'damaged', quantity: 2 }] }] })
        .expect((r) => {
          if (r.status !== 200 && r.status !== 201) throw new Error(`inspect answered ${r.status}: ${JSON.stringify(r.body)}`);
        });
      expect(await deliverClose(holdId)).toBe('settled');
      expect(await openQty(line.id)).toBe(1000);
      expect(await lineView(rma.id, line.id)).toMatchObject({ openQty: 1, onHoldQty: 0, failedInspectionQty: 2 });
      const settled = (await sql`select status, held_qty, returned_qty, failed_qty from return_hold_settlements where qc_hold_id = ${holdId}`) as unknown as {
        status: string;
        held_qty: string;
        returned_qty: string;
        failed_qty: string;
      }[];
      expect(settled[0]).toEqual({ status: 'inspected', held_qty: '3000', returned_qty: '1000', failed_qty: '2000' });
    });

    it('a serial-tracked or catch-weight line is not quarantined: 409 disposition-not-supported', async () => {
      const { lines } = await receivedReturn('RD-SER', 1, [{ qty: 1, serialNumber: 'RS-1' }], { serials: ['RS-1'] });
      const res = await dispose({ receiptLineId: lines[0]!.id, outcome: 'quarantine', qty: 1, reasonCode: 'damaged' }).expect(409);
      expect(res.body.code).toBe('disposition-not-supported');
    });

    it('the subscriber acks what it cannot settle: a malformed payload, a hold that is not a return hold, a return hold still open, and a data fault (rolled back)', async () => {
      expect(await settlement.deliver({ eventId: uuidv7(), tenantId, type: 'qc_hold.released', occurredAt: nowUtc(), payload: { holdId: 'nope' } } as never)).toBe('unroutable');
      expect(await settlement.deliver({ eventId: uuidv7(), tenantId, type: 'qc_hold.released', occurredAt: nowUtc(), payload: { holdId: uuidv7() } } as never)).toBe(
        'not-a-return-hold',
      );
      const { lines } = await receivedReturn('RD-C', 2, [{ qty: 2 }]);
      const line = lines[0]!;
      const holdId = ((await dispose({ receiptLineId: line.id, outcome: 'quarantine', qty: 2, reasonCode: 'damaged' }).expect(201)).body as DispositionBody)
        .dispositions[0]!.qcHoldId!;
      expect(await settlement.deliver({ eventId: uuidv7(), tenantId, type: 'qc_hold.released', occurredAt: nowUtc(), payload: { holdId } } as never)).toBe(
        'hold-still-open',
      );
      await http().post(`${API}/${tenantId}/receiving/qc-holds/${holdId}/release`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({});
      // Tamper: the disposition no longer matches QC's record — a data fault, acked, nothing settled.
      await sql`update return_dispositions set qty = 1000 where qc_hold_id = ${holdId}`;
      expect(await deliverClose(holdId)).toBe('data-fault');
      expect(await count(sql`select count(*)::int as n from return_hold_settlements where qc_hold_id = ${holdId}`)).toBe(0);
      await sql`update return_dispositions set qty = 2000 where qc_hold_id = ${holdId}`;
      expect(await deliverClose(holdId)).toBe('settled');
      expect(await openQty(line.id)).toBe(2000);
    });
  });

  // ── scrap ──────────────────────────────────────────────────────────────────

  describe('scrap', () => {
    it('scrap with a reason: return.scrapped out of RETURNS (a draw, the reason on the reference), ATP unchanged, the client signal appended; above the threshold 409', async () => {
      const { rma, lines } = await receivedReturn('RD-A', 4, [{ qty: 4, condition: 'damaged' }]);
      const line = lines[0]!;
      const atpBefore = await atp(sku('RD-A'));
      const returnsBin = await systemBin('RETURNS');
      const before = await onHandIn(returnsBin, sku('RD-A'));
      const res = await dispose({ receiptLineId: line.id, outcome: 'scrap', qty: 1, reasonCode: 'damaged' }).expect(201);
      const entry = (res.body as DispositionBody).dispositions[0]!;
      const events = (await sql`select type, quantity_delta, from_bin_id, to_bin_id, reference_doc from ledger_events where id = ${entry.ledgerEventId!}`) as unknown as {
        type: string;
        quantity_delta: string;
        from_bin_id: string;
        to_bin_id: string | null;
        reference_doc: Record<string, unknown>;
      }[];
      expect(events[0]).toMatchObject({ type: 'return.scrapped', from_bin_id: returnsBin, to_bin_id: null });
      expect(Number(events[0]!.quantity_delta)).toBe(-1000);
      expect(events[0]!.reference_doc).toEqual({ kind: 'return-disposition', dispositionId: entry.id, returnReceiptLineId: line.id, rmaId: rma.id, outcome: 'scrap', reasonCode: 'damaged' });
      expect(await onHandIn(returnsBin, sku('RD-A'))).toBe(before - 1000);
      expect(await atp(sku('RD-A'))).toBe(atpBefore);
      const signal = (await sql`select payload from outbox_messages where type = 'return_scrap.recorded' and payload->>'dispositionId' = ${entry.id}`) as unknown as {
        payload: Record<string, unknown>;
      }[];
      expect(signal[0]!.payload).toEqual({
        rmaId: rma.id,
        rmaCode: rma.code,
        clientId: expect.any(String),
        warehouseId,
        skuId: sku('RD-A'),
        qty: '1',
        reasonCode: 'damaged',
        dispositionId: entry.id,
      });
      // A3 — the tenant's write-off threshold bounds a scrap (strictly greater refuses).
      await http().put(`${API}/${tenantId}/inventory/adjustment-policies`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ quantityThreshold: 2 }).expect(200);
      try {
        const refused = await dispose({ receiptLineId: line.id, outcome: 'scrap', qty: 3, reasonCode: 'damaged' }).expect(409);
        expect(refused.body).toMatchObject({ code: 'scrap-above-threshold', awaitingQty: 3, threshold: 2 });
        await dispose({ receiptLineId: line.id, outcome: 'scrap', qty: 2, reasonCode: 'damaged' }).expect(201);
      } finally {
        await http().put(`${API}/${tenantId}/inventory/adjustment-policies`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ quantityThreshold: 1_000_000 }).expect(200);
      }
      expect(await lineView(rma.id, line.id)).toMatchObject({ openQty: 1, scrappedQty: 3 });
    });

    it('a returned case: scrap writes it off (handling unit → rejected, its id on the reference); a restocked case is packable again (→ active)', async () => {
      const cases = await fixtures.seedCatchWeightCases(sku('RD-CW'), caseBin, [2_100, 2_200]);
      const { lines } = await receivedReturn('RD-CW', 2, [
        { qty: 1, weightGrams: 2_090, condition: 'damaged' },
        { qty: 1, weightGrams: 2_210 },
      ], { cases });
      const [scrapLine, restockLine] = lines;
      const scrapped = ((await dispose({ receiptLineId: scrapLine!.id, outcome: 'scrap', qty: 1, reasonCode: 'damaged' }).expect(201)).body as DispositionBody).dispositions[0]!;
      const unitOf = async (lineId: string): Promise<{ id: string; status: string }> =>
        ((await sql`select h.id, h.status from handling_units h join return_receipt_lines l on l.handling_unit_id = h.id where l.id = ${lineId}`) as unknown as {
          id: string;
          status: string;
        }[])[0]!;
      const scrappedUnit = await unitOf(scrapLine!.id);
      expect(scrappedUnit.status).toBe('rejected');
      const doc = (await sql`select reference_doc from ledger_events where id = ${scrapped.ledgerEventId!}`) as unknown as { reference_doc: Record<string, unknown> }[];
      expect(doc[0]!.reference_doc).toMatchObject({ handlingUnitIds: [scrappedUnit.id] });
      // A returned case is never quarantined (a QC hold carries no case identity).
      const caseHold = await dispose({ receiptLineId: restockLine!.id, outcome: 'quarantine', qty: 1, reasonCode: 'damaged' }).expect(409);
      expect(caseHold.body.code).toBe('disposition-not-supported');
      expect(await openQty(restockLine!.id)).toBe(1000);
      await dispose({ receiptLineId: restockLine!.id, outcome: 'restock', qty: 1, toBinId: shelfA }).expect(201);
      expect((await unitOf(restockLine!.id)).status).toBe('active');
      // A case is disposed whole.
      expect(await count(sql`select count(*)::int as n from return_dispositions where handling_unit_id = ${scrappedUnit.id}`)).toBe(1);
    });
  });

  // ── the handheld ───────────────────────────────────────────────────────────

  describe('device restock', () => {
    it('FIFO: 4 units over L1 (2, older) and L2 (3) → L1:2, L2:2 (DB 2000, 2000); one event per line at the device time; audited with the device', async () => {
      const first = await receivedReturn('RD-B', 2, [{ qty: 2 }]);
      const second = await receivedReturn('RD-B', 3, [{ qty: 3 }]);
      // Drain any older sellable RD-B lines first, so L1/L2 are the oldest.
      await drainOlder('RD-B', [first.lines[0]!.id, second.lines[0]!.id]);
      const key = ulid();
      const deviceTime = '2026-10-27T09:30:00Z';
      const res = await restock({ skuId: sku('RD-B'), qty: 4, toBinId: shelfA, occurredAt: deviceTime }, key).expect(201);
      const body = res.body as DispositionBody;
      expect(body.dispositions.map((d) => [d.receiptLineId, d.qty])).toEqual([
        [first.lines[0]!.id, 2],
        [second.lines[0]!.id, 2],
      ]);
      const rows = (await sql`select qty, occurred_at, device_id from return_dispositions where id in ${sql(body.dispositions.map((d) => d.id))} order by created_at, id`) as unknown as {
        qty: string;
        occurred_at: Date;
        device_id: string;
      }[];
      expect(rows.map((row) => Number(row.qty))).toEqual([2000, 2000]);
      expect(rows.every((row) => row.device_id === deviceId)).toBe(true);
      const events = (await sql`select occurred_at from ledger_events where id in ${sql(body.dispositions.map((d) => d.ledgerEventId!))}`) as unknown as { occurred_at: Date }[];
      expect(events.every((event) => new Date(event.occurred_at).toISOString() === '2026-10-27T09:30:00.000Z')).toBe(true);
      await expectAuditRow({ tenantId, key, action: 'return_disposition.recorded', targetType: 'return_disposition', targetId: body.dispositions[0]!.id, actorUserId: operatorUserId });
      const audit = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as { changes: Record<string, unknown> }[];
      expect(audit[0]!.changes).toMatchObject({ outcome: 'restock', deviceId, operatorUserId });
      // Replay.
      expect((await restock({ skuId: sku('RD-B'), qty: 4, toBinId: shelfA, occurredAt: deviceTime }, key).expect(201)).body).toEqual(res.body);
    });

    it('A19 — the device skips non-sellable lines: L1 damaged (older), L2 resaleable → L2; short → 409 exceeds-awaiting (awaitingQty)', async () => {
      const damaged = await receivedReturn('RD-C', 1, [{ qty: 1, condition: 'damaged' }]);
      const sellable = await receivedReturn('RD-C', 1, [{ qty: 1 }]);
      await drainOlder('RD-C', [sellable.lines[0]!.id], [damaged.lines[0]!.id]);
      const short = await restock({ skuId: sku('RD-C'), qty: 2, toBinId: shelfA }).expect(409);
      expect(short.body).toMatchObject({ code: 'exceeds-awaiting', awaitingQty: 1 });
      const res = await restock({ skuId: sku('RD-C'), qty: 1, toBinId: shelfA }).expect(201);
      expect((res.body as DispositionBody).dispositions.map((d) => d.receiptLineId)).toEqual([sellable.lines[0]!.id]);
      expect(await openQty(damaged.lines[0]!.id)).toBe(1000);
    });

    it('serial: the line holding the serial; a second restock 409 serial-not-awaiting; A22 — restocked is in stock, a scrapped serial is out', async () => {
      const { lines } = await receivedReturn('RD-SER', 1, [{ qty: 1, serialNumber: 'RS-2' }], { serials: ['RS-2'] });
      const res = await restock({ skuId: sku('RD-SER'), qty: 1, serialNumbers: ['RS-2'], toBinId: shelfB }).expect(201);
      expect((res.body as DispositionBody).dispositions.map((d) => d.receiptLineId)).toEqual([lines[0]!.id]);
      const again = await restock({ skuId: sku('RD-SER'), qty: 1, serialNumbers: ['RS-2'], toBinId: shelfB }).expect(409);
      expect(again.body).toMatchObject({ code: 'serial-not-awaiting', serialNumber: 'RS-2' });
      const serialId = ((await sql`select id from serials where tenant_id = ${tenantId} and serial_number = 'RS-2'`) as unknown as { id: string }[])[0]!.id;
      const latest = async (): Promise<string | null> =>
        ((await sql`select to_bin_id from ledger_events where serial_ref = ${serialId} order by id desc limit 1`) as unknown as { to_bin_id: string | null }[])[0]!.to_bin_id;
      expect(await latest()).toBe(shelfB);
      // Scrap a returned serial on the web — out of stock.
      const scrapped = await receivedReturn('RD-SER', 1, [{ qty: 1, serialNumber: 'RS-3', condition: 'damaged' }], { serials: ['RS-3'] });
      // A19 — the handheld never restocks a serial graded non-sellable.
      const graded = await restock({ skuId: sku('RD-SER'), qty: 1, serialNumbers: ['RS-3'], toBinId: shelfB }).expect(409);
      expect(graded.body).toMatchObject({ code: 'serial-not-awaiting', serialNumber: 'RS-3' });
      expect(graded.body.detail).toMatch(/graded "damaged"/);
      expect(await openQty(scrapped.lines[0]!.id)).toBe(1000);
      await dispose({ receiptLineId: scrapped.lines[0]!.id, outcome: 'scrap', qty: 1, reasonCode: 'damaged' }).expect(201);
      const scrapId = ((await sql`select id from serials where tenant_id = ${tenantId} and serial_number = 'RS-3'`) as unknown as { id: string }[])[0]!.id;
      expect(((await sql`select to_bin_id from ledger_events where serial_ref = ${scrapId} order by id desc limit 1`) as unknown as { to_bin_id: string | null }[])[0]!.to_bin_id).toBeNull();
    });

    it('4-7b fix — a serial returned a SECOND time (restocked, re-sold, returned again on a new receipt line) is dispositioned again', async () => {
      const once = await receivedReturn('RD-SER', 1, [{ qty: 1, serialNumber: 'RS-4' }], { serials: ['RS-4'] });
      await dispose({ receiptLineId: once.lines[0]!.id, outcome: 'restock', qty: 1, toBinId: stockBin }).expect(201);
      // Re-sold (picked from stockBin by the fixtures' wave) and returned again.
      const twice = await receivedReturn('RD-SER', 1, [{ qty: 1, serialNumber: 'RS-4' }], { serials: ['RS-4'] });
      expect(twice.lines[0]!.id).not.toBe(once.lines[0]!.id);
      await dispose({ receiptLineId: twice.lines[0]!.id, outcome: 'restock', qty: 1, toBinId: stockBin }).expect(201);
      expect(await count(sql`select count(*)::int as n from return_dispositions d join serials s on s.id = d.serial_id where s.serial_number = 'RS-4' and s.tenant_id = ${tenantId}`)).toBe(2);
    });

    it('batch: batch-required 400; two-batch FIFO takes only the named batch; a blocked batch 409 batch-blocked; expired at the device time 409 batch-expired', async () => {
      expect((await restock({ skuId: sku('RD-BAT'), qty: 1, toBinId: shelfA }).expect(400)).body.code).toBe('batch-required');
      // B2 (earlier expiry, 1 unit) is picked by the first order; B1 by the second.
      await seedStock(sku('RD-BAT'), 1, undefined, { code: 'B2', expiryDate: daysFromNow(100) });
      const older = await receivedReturn('RD-BAT', 1, [{ qty: 1, batchCode: 'B2' }]);
      await seedStock(sku('RD-BAT'), 5, undefined, { code: 'B1', expiryDate: daysFromNow(200) });
      const newer = await receivedReturn('RD-BAT', 2, [{ qty: 2, batchCode: 'B1' }]);
      const one = await restock({ skuId: sku('RD-BAT'), qty: 1, batchCode: ' B1 ', toBinId: shelfA }).expect(201);
      expect((one.body as DispositionBody).dispositions.map((d) => d.receiptLineId)).toEqual([newer.lines[0]!.id]);
      expect(await openQty(older.lines[0]!.id)).toBe(1000);
      // Expired at the device's business time.
      const expired = await restock({ skuId: sku('RD-BAT'), qty: 1, batchCode: 'B1', toBinId: shelfA, occurredAt: daysFromNow(300) }).expect(409);
      expect(expired.body.code).toBe('batch-expired');
      const b1 = ((await sql`select id from batches where tenant_id = ${tenantId} and sku_id = ${sku('RD-BAT')} and code = 'B1'`) as unknown as { id: string }[])[0]!.id;
      await http().post(`${API}/${tenantId}/inventory/batches/${b1}/block`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ reason: 'recall' }).expect(201);
      try {
        expect((await restock({ skuId: sku('RD-BAT'), qty: 1, batchCode: 'B1', toBinId: shelfA }).expect(409)).body.code).toBe('batch-blocked');
        // The web refuses the same restock too.
        expect((await dispose({ receiptLineId: newer.lines[0]!.id, outcome: 'restock', qty: 1, toBinId: shelfA }).expect(409)).body.code).toBe('batch-blocked');
      } finally {
        await http().post(`${API}/${tenantId}/inventory/batches/${b1}/unblock`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({ note: 'recall withdrawn' }).expect(201);
      }
    });

    it('device shape and SKU rules: a catch-weight SKU 400, serials on an untracked SKU 400, a malformed occurredAt 400, a web session 401', async () => {
      expect((await restock({ skuId: sku('RD-CW'), qty: 1, toBinId: shelfA }).expect(400)).body.detail).toMatch(/catch-weight/);
      expect((await restock({ skuId: sku('RD-A'), qty: 1, serialNumbers: ['X'], toBinId: shelfA }).expect(400)).body.code).toBe('validation-failed');
      expect((await restock({ skuId: sku('RD-A'), qty: 1, toBinId: shelfA, occurredAt: '2026-10-27 10:00' }).expect(400)).body.code).toBe('validation-failed');
      // A web session cannot use the device route.
      await restock({ skuId: sku('RD-A'), qty: 1, toBinId: shelfA }, ulid(), opsToken).expect(401);
    });

    it('a device-uploaded refusal of return.restock is accepted into the review queue (A4 payload), Discard only', async () => {
      const opId = ulid();
      const payload = { warehouseId, skuId: sku('RD-A'), qty: 2, batchCode: null, serialNumbers: null, toBinId: shelfA, occurredAt: nowUtc() };
      await http()
        .post(`${API}/${tenantId}/devices/sync-reports`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          rows: [
            {
              opId,
              opType: 'return.restock',
              classification: 'rejected',
              problemCode: 'exceeds-awaiting',
              problemDetail: '0 pcs of SKU "RD-A" are awaiting a restock',
              payload,
              attribution: { deviceLabel: 'Returns restock scanner' },
              opEnqueuedAt: nowUtc(),
              opOccurredAt: nowUtc(),
            },
          ],
        })
        .expect(201);
      const rows = (await sql`select op_type, payload from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`) as unknown as { op_type: string; payload: Record<string, unknown> }[];
      expect(rows[0]).toEqual({ op_type: 'return.restock', payload });
      const queue = await http().get(`${API}/${tenantId}/rejected-ops?status=open&limit=100`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      expect((queue.body.items as { opId: string; decisions?: string[] }[]).find((item) => item.opId === opId)?.decisions).toEqual(['discard']);
    });

    it('device op vs web dispose: the web scraps L first; the queued device op then draws what remains or refuses 409 exceeds-awaiting', async () => {
      const { lines } = await receivedReturn('RD-A', 2, [{ qty: 2 }]);
      await drainOlder('RD-A', [lines[0]!.id]);
      await dispose({ receiptLineId: lines[0]!.id, outcome: 'scrap', qty: 2, reasonCode: 'client-instruction' }).expect(201);
      const res = await restock({ skuId: sku('RD-A'), qty: 1, toBinId: shelfA }).expect(409);
      expect(res.body).toMatchObject({ code: 'exceeds-awaiting', awaitingQty: 0 });
    });
  });

  // ── races ──────────────────────────────────────────────────────────────────

  describe('races', () => {
    function handle(): postgres.Sql<Record<string, unknown>> {
      return postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    }

    async function waitParked(holderPid: number, min: number): Promise<void> {
      const probe = handle();
      try {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active'
              and a.query ilike '%for update%'
          `) as unknown as { pid: number; blockers: number[] }[];
          // The chain back to the holder: a same-device duplicate parks on the
          // device row (`assertDeviceOperatorInTx`) behind the first waiter.
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
        throw new Error(`fewer than ${min} request(s) parked on the receipt line`);
      } finally {
        await probe.end();
      }
    }

    /** Fire two requests while a raw holder has the receipt line `FOR UPDATE`; release once both are parked. */
    async function raceTwo(lineId: string, a: () => SupertestTest, b: () => SupertestTest): Promise<[request.Response, request.Response]> {
      const holder = handle();
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from return_receipt_lines where id = ${lineId} for update`) as unknown as { pid: number }[];
          first = (async () => a())();
          second = (async () => b())();
          await waitParked(locked[0]!.pid, 2);
        });
        return await Promise.all([first!, second!]);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
    }

    it('dispose: two same-key requests parked on the line answer the same body — one disposition, one key', async () => {
      const { lines } = await receivedReturn('RD-A', 3, [{ qty: 3 }]);
      const key = ulid();
      const send = () => dispose({ receiptLineId: lines[0]!.id, outcome: 'restock', qty: 2, toBinId: shelfA }, key);
      const [a, b] = await raceTwo(lines[0]!.id, send, send);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body).toEqual(b.body);
      expect(await count(sql`select count(*)::int as n from return_dispositions where return_receipt_line_id = ${lines[0]!.id}`)).toBe(1);
      expect(await openQty(lines[0]!.id)).toBe(1000);
    });

    it('restock: two same-key device ops parked on the candidate line answer the same body — one disposition', async () => {
      const { lines } = await receivedReturn('RD-A', 2, [{ qty: 2 }]);
      await drainOlder('RD-A', [lines[0]!.id]);
      const key = ulid();
      const at = nowUtc();
      const send = () => restock({ skuId: sku('RD-A'), qty: 1, toBinId: shelfA, occurredAt: at }, key);
      const [a, b] = await raceTwo(lines[0]!.id, send, send);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body).toEqual(b.body);
      expect(await openQty(lines[0]!.id)).toBe(1000);
    });

    it('A20 — two different disposes whose sum exceeds the line: exactly one commits, the other answers 409 exceeds-awaiting', async () => {
      const { lines } = await receivedReturn('RD-A', 3, [{ qty: 3 }]);
      const [a, b] = await raceTwo(
        lines[0]!.id,
        () => dispose({ receiptLineId: lines[0]!.id, outcome: 'restock', qty: 2, toBinId: shelfA }),
        () => dispose({ receiptLineId: lines[0]!.id, outcome: 'scrap', qty: 2, reasonCode: 'damaged' }),
      );
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect([a, b].find((r) => r.status === 409)!.body).toMatchObject({ code: 'exceeds-awaiting', awaitingQty: 1 });
      expect(await openQty(lines[0]!.id)).toBe(1000);
    });
  });

  // ── conservation, RETURNS, reconcile ───────────────────────────────────────

  it('acceptance 1 — a fully received RMA restocked, quarantined (released and inspected) and scrapped: every line open 0 / on hold 0, RETURNS falls by received − failed, reconcile clean', async () => {
    const returnsBin = await systemBin('RETURNS');
    const { rma, lines } = await receivedReturn('RD-C', 6, [{ qty: 6 }]);
    const line = lines[0]!;
    const returnsBefore = await onHandIn(returnsBin, sku('RD-C'));
    await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 2, toBinId: shelfB }).expect(201);
    const holdA = ((await dispose({ receiptLineId: line.id, outcome: 'quarantine', qty: 1, reasonCode: 'needs-inspection' }).expect(201)).body as DispositionBody).dispositions[0]!.qcHoldId!;
    const holdB = ((await dispose({ receiptLineId: line.id, outcome: 'quarantine', qty: 2, reasonCode: 'damaged' }).expect(201)).body as DispositionBody).dispositions[0]!.qcHoldId!;
    await dispose({ receiptLineId: line.id, outcome: 'scrap', qty: 1, reasonCode: 'contaminated' }).expect(201);
    await http().post(`${API}/${tenantId}/receiving/qc-holds/${holdA}/release`).set('Authorization', `Bearer ${opsToken}`).set(KEY_HEADER, ulid()).send({});
    await http()
      .post(`${API}/${tenantId}/receiving/qc-holds/${holdB}/inspect`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ lines: [{ batchId: null, passed: 0, failed: [{ reason: 'damaged', quantity: 2 }] }] });
    expect(await deliverClose(holdA)).toBe('settled');
    expect(await deliverClose(holdB)).toBe('settled');
    // The released unit is awaiting again — restock it.
    await dispose({ receiptLineId: line.id, outcome: 'restock', qty: 1, toBinId: shelfB }).expect(201);
    expect(await lineView(rma.id, line.id)).toMatchObject({ openQty: 0, onHoldQty: 0, restockedQty: 3, scrappedQty: 1, failedInspectionQty: 2 });
    // 6 received, 2 failed inspection: RETURNS gave up exactly 6 (3 restocked + 1 scrapped + 2 via QC to DAMAGED).
    expect(await onHandIn(returnsBin, sku('RD-C'))).toBe(returnsBefore - 6000);
    const report = await inventory.reconcile(tenantId, warehouseId);
    expect(report.divergences).toEqual([]);
    // No longer on the queue.
    const queue = await http().get(`${API}/${tenantId}/returns/awaiting?warehouseId=${warehouseId}&limit=100`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((queue.body.items as { receiptLineId: string }[]).some((item) => item.receiptLineId === line.id)).toBe(false);
  });

  it('the queue: oldest first, a client filter before the limit (no short pages), the literal route before :rmaId', async () => {
    const page = await http().get(`${API}/${tenantId}/returns/awaiting?warehouseId=${warehouseId}&limit=1`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(page.body.items).toHaveLength(1);
    const all: { receiptLineId: string; receivedAt: string; clientId: string }[] = [];
    let cursor: string | null = null;
    do {
      const res = await http()
        .get(`${API}/${tenantId}/returns/awaiting?warehouseId=${warehouseId}&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      all.push(...(res.body.items as typeof all));
      cursor = res.body.nextCursor as string | null;
    } while (cursor !== null);
    const lineIds = all.map((item) => item.receiptLineId);
    expect(new Set(lineIds).size).toBe(lineIds.length);
    const ordered = (await sql`
      select l.id from return_receipt_lines l join return_receipts r on r.id = l.return_receipt_id
      where l.tenant_id = ${tenantId} and l.open_qty > 0 and r.warehouse_id = ${warehouseId} order by l.created_at, l.id`) as unknown as { id: string }[];
    expect(lineIds).toEqual(ordered.map((row) => row.id));
    // A brand line behind a full page of self-client lines still comes back on page one.
    const brand = await receivedReturn('PB-1', 1, [{ qty: 1 }]);
    const filtered = await http().get(`${API}/${tenantId}/returns/awaiting?clientId=${brandId}&limit=1`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((filtered.body.items as { receiptLineId: string }[]).map((item) => item.receiptLineId)).toEqual([brand.lines[0]!.id]);
  });

  it('the OpenAPI document lists the five new routes; the literal `awaiting` is declared before `:rmaId`', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const paths = Object.keys(doc.body.paths as Record<string, unknown>);
    for (const path of [
      '/tenants/{tenantId}/returns/dispositions',
      '/tenants/{tenantId}/returns/restocks',
      '/tenants/{tenantId}/returns/awaiting',
      '/tenants/{tenantId}/portal/returns',
      '/tenants/{tenantId}/portal/returns/{rmaId}',
    ]) {
      expect(paths).toContain(path);
    }
    const names = Object.getOwnPropertyNames(ReturnsController.prototype);
    expect(names.indexOf('awaiting')).toBeGreaterThan(-1);
    expect(names.indexOf('awaiting')).toBeLessThan(names.indexOf('get'));
  });

  // ── the portal ─────────────────────────────────────────────────────────────

  describe('the client portal', () => {
    const ROW_KEYS = [
      'code',
      'createdAt',
      'externalReference',
      'failedInspectionTotal',
      'id',
      'lineCount',
      'onHoldTotal',
      'openTotal',
      'orderId',
      'orderReference',
      // Story 4-7b (A25, D2) — the allowlist grows by exactly these two.
      'origin',
      'parcelReference',
      'receivedTotal',
      'restockedTotal',
      // Story 4-7c (D6) — the allowlist grows by exactly these two.
      'returnedToClientTotal',
      'returningToClientTotal',
      'scrappedTotal',
      'status',
    ];
    const LINE_KEYS = [
      'authorizedQty',
      'failedInspectionQty',
      'onHoldQty',
      'openQty',
      'receivedQty',
      'restockedQty',
      'returnReasonCode',
      // Story 4-7c (D6) — the allowlist grows by exactly these two.
      'returnedToClientQty',
      'returningToClientQty',
      'scrappedQty',
      'skuCode',
      'skuName',
    ];
    const DISPOSITION_KEYS = ['occurredAt', 'outcome', 'qty', 'reasonCode', 'skuCode'];

    it('the brand sees its returns with disposition totals (an exact allowlist, recursively); another client gets the same 404 as an unknown id; the state filter', async () => {
      const { rma, lines } = await receivedReturn('PB-1', 3, [{ qty: 3 }]);
      await dispose({ receiptLineId: lines[0]!.id, outcome: 'restock', qty: 1, toBinId: brandBin }).expect(201);
      await dispose({ receiptLineId: lines[0]!.id, outcome: 'scrap', qty: 1, reasonCode: 'damaged', note: 'internal remark' }).expect(201);
      const list = await http().get(`${API}/${tenantId}/portal/returns`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
      const row = (list.body.items as Record<string, unknown>[]).find((item) => item.id === rma.id)!;
      expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
      expect(row).toMatchObject({ receivedTotal: 3, restockedTotal: 1, scrappedTotal: 1, onHoldTotal: 0, failedInspectionTotal: 0, openTotal: 1, lineCount: 1 });
      const detail = await http().get(`${API}/${tenantId}/portal/returns/${rma.id}`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
      expect(Object.keys(detail.body).sort()).toEqual([...ROW_KEYS, 'dispositions', 'lines'].sort());
      for (const line of detail.body.lines as Record<string, unknown>[]) expect(Object.keys(line).sort()).toEqual(LINE_KEYS);
      for (const entry of detail.body.dispositions as Record<string, unknown>[]) expect(Object.keys(entry).sort()).toEqual(DISPOSITION_KEYS);
      expect(detail.body.lines[0]).toMatchObject({ skuCode: 'PB-1', skuName: 'Brand tee', authorizedQty: 3, receivedQty: 3, returnReasonCode: 'damaged', restockedQty: 1, scrappedQty: 1, openQty: 1 });
      expect((detail.body.dispositions as { outcome: string; reasonCode: string | null }[]).map((d) => [d.outcome, d.reasonCode])).toEqual([
        ['restock', null],
        ['scrap', 'damaged'],
      ]);
      expect(JSON.stringify(detail.body)).not.toContain('internal remark');
      expect(JSON.stringify(detail.body)).not.toContain(brandBin);
      // Awaiting / dispositioned.
      const awaiting = await http().get(`${API}/${tenantId}/portal/returns?dispositionState=awaiting`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
      expect((awaiting.body.items as { id: string }[]).some((item) => item.id === rma.id)).toBe(true);
      await dispose({ receiptLineId: lines[0]!.id, outcome: 'restock', qty: 1, toBinId: brandBin }).expect(201);
      const done = await http().get(`${API}/${tenantId}/portal/returns?dispositionState=dispositioned`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
      expect((done.body.items as { id: string }[]).some((item) => item.id === rma.id)).toBe(true);
      const stillAwaiting = await http().get(`${API}/${tenantId}/portal/returns?dispositionState=awaiting`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
      expect((stillAwaiting.body.items as { id: string }[]).some((item) => item.id === rma.id)).toBe(false);
      // Another client: the same 404 as an unknown id; its list holds none of the brand's.
      const foreign = await http().get(`${API}/${tenantId}/portal/returns/${rma.id}`).set('Authorization', `Bearer ${portalOther}`).expect(404);
      const unknown = await http().get(`${API}/${tenantId}/portal/returns/${uuidv7()}`).set('Authorization', `Bearer ${portalOther}`).expect(404);
      expect(foreign.body.code).toBe(unknown.body.code);
      const otherList = await http().get(`${API}/${tenantId}/portal/returns`).set('Authorization', `Bearer ${portalOther}`).expect(200);
      expect(otherList.body.items).toEqual([]);
      // An operator token is fenced off the portal; a portal token off the operator routes.
      await http().get(`${API}/${tenantId}/portal/returns`).set('Authorization', `Bearer ${ownerToken}`).expect(403);
      await http().get(`${API}/${tenantId}/returns/awaiting`).set('Authorization', `Bearer ${portalBrand}`).expect(403);
    });
  });

  it('the portal on hold: a fully quarantined RMA is awaiting (not dispositioned) with onHoldQty; after a failed inspection it is dispositioned with failedInspectionQty', async () => {
    const { rma, lines } = await receivedReturn('PB-1', 2, [{ qty: 2, condition: 'opened' }]);
    const holdId = ((await dispose({ receiptLineId: lines[0]!.id, outcome: 'quarantine', qty: 2, reasonCode: 'needs-inspection' }).expect(201)).body as DispositionBody)
      .dispositions[0]!.qcHoldId!;
    const ids = async (state: string): Promise<string[]> =>
      ((await http().get(`${API}/${tenantId}/portal/returns?dispositionState=${state}`).set('Authorization', `Bearer ${portalBrand}`).expect(200)).body.items as { id: string }[]).map(
        (item) => item.id,
      );
    expect(await ids('awaiting')).toContain(rma.id);
    expect(await ids('dispositioned')).not.toContain(rma.id);
    const held = await http().get(`${API}/${tenantId}/portal/returns/${rma.id}`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    expect(held.body).toMatchObject({ onHoldTotal: 2, openTotal: 0 });
    expect(held.body.lines[0]).toMatchObject({ onHoldQty: 2, failedInspectionQty: 0 });
    await http()
      .post(`${API}/${tenantId}/receiving/qc-holds/${holdId}/inspect`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ lines: [{ batchId: null, passed: 0, failed: [{ reason: 'damaged', quantity: 2 }] }] });
    expect(await deliverClose(holdId)).toBe('settled');
    expect(await ids('dispositioned')).toContain(rma.id);
    const done = await http().get(`${API}/${tenantId}/portal/returns/${rma.id}`).set('Authorization', `Bearer ${portalBrand}`).expect(200);
    expect(done.body).toMatchObject({ onHoldTotal: 0, failedInspectionTotal: 2, openTotal: 0 });
    expect(done.body.lines[0]).toMatchObject({ onHoldQty: 0, failedInspectionQty: 2 });
  });

  it('A20 — a line that no longer conserves refuses the dispose with 500 data-fault and writes nothing', async () => {
    const { lines } = await receivedReturn('RD-C', 2, [{ qty: 2 }]);
    const line = lines[0]!;
    // Tamper: a disposition the stored open quantity does not account for.
    await sql`update return_receipt_lines set open_qty = 2000 where id = ${line.id}`;
    await sql`insert into return_dispositions (id, tenant_id, client_id, warehouse_id, return_receipt_id, return_receipt_line_id, rma_id, sku_id, outcome, qty, to_bin_id, decided_by, ledger_event_id, occurred_at)
      select gen_random_uuid(), r.tenant_id, r.client_id, r.warehouse_id, r.id, ${line.id}, r.rma_id, ${sku('RD-C')}, 'restock', 1000, ${shelfB}, ${opsUserId}, gen_random_uuid(), now()
      from return_receipts r join return_receipt_lines l on l.return_receipt_id = r.id where l.id = ${line.id}`;
    const events = await count(sql`select count(*)::int as n from ledger_events where tenant_id = ${tenantId}`);
    const res = await dispose({ receiptLineId: line.id, outcome: 'scrap', qty: 1, reasonCode: 'damaged' }).expect(500);
    expect(res.body.code).toBe('data-fault');
    expect(await count(sql`select count(*)::int as n from ledger_events where tenant_id = ${tenantId}`)).toBe(events);
    expect(await count(sql`select count(*)::int as n from return_dispositions where return_receipt_line_id = ${line.id}`)).toBe(1);
    expect(await openQty(line.id)).toBe(2000);
    // Repair the tamper so the suite's later reads stay conserving.
    await sql`delete from return_dispositions where return_receipt_line_id = ${line.id}`;
  });

  // ── RLS ────────────────────────────────────────────────────────────────────

  describe('client isolation (wms_rls_probe)', () => {
    let probe: postgres.Sql<Record<string, unknown>>;

    beforeAll(async () => {
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${PROBE_LOCK})`;
        await tx.unsafe(`
          do $$ begin
            if not exists (select from pg_roles where rolname = 'wms_rls_probe') then
              create role wms_rls_probe login password 'wms_rls_probe' nosuperuser;
            end if;
          end $$;
        `);
        await tx.unsafe('grant usage on schema public to wms_rls_probe');
        await tx.unsafe('grant select, insert, update, delete on all tables in schema public to wms_rls_probe');
      });
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      probe = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    });

    afterAll(async () => {
      await probe?.end();
    });

    function stamped(tenant: string, client: string | null, run: (tx: postgres.TransactionSql<Record<string, unknown>>) => PromiseLike<unknown>): Promise<number> {
      return probe.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenant}, true)`;
        if (client !== null) await tx`select set_config('app.client_id', ${client}, true)`;
        const rows = (await run(tx)) as { n: number }[];
        return Number(rows[0]!.n);
      }) as Promise<number>;
    }

    it("another client's or another tenant's session sees no disposition or settlement; the owning client and an operator session do", async () => {
      const [owned] = (await sql`
        select d.id, d.client_id, s.id as settlement from return_dispositions d
        join return_hold_settlements s on s.disposition_id = d.id where d.tenant_id = ${tenantId} limit 1`) as unknown as {
        id: string;
        client_id: string;
        settlement: string;
      }[];
      const dispositions = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`select count(*)::int as n from return_dispositions where id = ${owned!.id}`;
      const settlements = (tx: postgres.TransactionSql<Record<string, unknown>>) =>
        tx`select count(*)::int as n from return_hold_settlements where id = ${owned!.settlement}`;
      for (const read of [dispositions, settlements]) {
        expect(await stamped(tenantId, uuidv7(), read)).toBe(0);
        expect(await stamped(tenantId, owned!.client_id, read)).toBe(1);
        expect(await stamped(tenantId, null, read)).toBe(1);
        expect(await stamped(uuidv7(), null, read)).toBe(0);
      }
      // The brand's own rows under its stamp (the portal read's shape).
      const brandRows = (tx: postgres.TransactionSql<Record<string, unknown>>) => tx`select count(*)::int as n from return_dispositions where tenant_id = ${tenantId}`;
      const all = await stamped(tenantId, null, brandRows);
      const brandOnly = await stamped(tenantId, brandId, brandRows);
      expect(brandOnly).toBeGreaterThan(0);
      expect(brandOnly).toBeLessThan(all);
    });
  });

  /**
   * Restock away every OTHER sellable awaiting line of a SKU (oldest-first
   * allocation would otherwise draw from them), keeping `keep` and `skip`.
   */
  async function drainOlder(code: string, keep: string[], skip: string[] = []): Promise<void> {
    const others = (await sql`
      select l.id, l.open_qty from return_receipt_lines l join return_receipts r on r.id = l.return_receipt_id
      where l.tenant_id = ${tenantId} and l.sku_id = ${sku(code)} and l.open_qty > 0 and r.warehouse_id = ${warehouseId}`) as unknown as {
      id: string;
      open_qty: string;
    }[];
    for (const line of others) {
      if (keep.includes(line.id) || skip.includes(line.id)) continue;
      await dispose({ receiptLineId: line.id, outcome: 'scrap', qty: Number(line.open_qty) / 1000, reasonCode: 'client-instruction' }).expect(201);
    }
  }
});
