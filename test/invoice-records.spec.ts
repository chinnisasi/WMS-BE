import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { createDatabase, type Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { encodeCursor } from '../src/shared/primitives/pagination';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { SignedQuantity } from '../src/shared/primitives/quantity';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { getLedgerEventType } from '../src/modules/inventory/ledger-registry';
import { rateCardClock } from '../src/modules/billing/rate-card.command';
import { BillingFacade } from '../src/modules/billing/billing.facade';
import { clientInvoiceClock, decimalToMilli, measuredThroughOf } from '../src/modules/billing/client-invoices';
import { RECORD_KIND_OF_CHARGE, storageDays } from '../src/modules/billing/invoice-records';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.STORAGE_SNAPSHOT_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(240_000);

/** An IST wall-clock instant in ms, e.g. `ist('2026-09-10T10:00')`. */
function ist(local: string): number {
  return Date.parse(local.length === 16 ? `${local}:00+05:30` : `${local}+05:30`);
}
function istIso(local: string): string {
  return new Date(ist(local)).toISOString();
}

const T29 = '29AAACT1234A1Z5';
const W27 = '27AAACT1234A1Z6';

function migration0063Statements(): string[] {
  const text = readFileSync(resolve(process.cwd(), 'drizzle/0063_invoice_storage_measured_through.sql'), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 21-5b — the dispute drill-down: a client-invoice line expanded to the
 * records its quantity was counted from, on the same predicates the counts
 * use, with a reconciliation summary on the first page.
 */
describe('story 21-5b: the dispute drill-down', () => {
  describe('the pure helpers', () => {
    it('measuredThroughOf clips the group watermark to the month; no watermark stores period_start − 1 (nothing measured), never NULL', () => {
      expect(measuredThroughOf('2026-10-03', '2026-09-01', '2026-09-30')).toBe('2026-09-30');
      expect(measuredThroughOf('2026-09-19', '2026-09-01', '2026-09-30')).toBe('2026-09-19');
      expect(measuredThroughOf(null, '2026-09-01', '2026-09-30')).toBe('2026-08-31');
    });

    it('storageDays: the segment’s IST days up to the measured day; a pre-0063 null reads as period_end', () => {
      const line = { segmentFrom: '2026-09-14T18:30:00.000Z', segmentTo: '2026-09-30T18:30:00.000Z' }; // 09-15 … 09-30
      const month = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
      expect(storageDays(line, { ...month, status: 'draft', storageMeasuredThrough: '2026-09-19' })).toEqual({ fromDay: '2026-09-15', throughDay: '2026-09-19' });
      // NULL (pre-0063) on a non-draft invoice: period_end (issue required storage complete through it).
      for (const status of ['issued', 'disputed', 'settled', 'void'] as const) {
        expect(storageDays(line, { ...month, status, storageMeasuredThrough: null })).toEqual({ fromDay: '2026-09-15', throughDay: '2026-09-30' });
      }
      // NULL on a DRAFT: nothing measured — an empty range, never the whole month.
      const nullDraft = storageDays(line, { ...month, status: 'draft', storageMeasuredThrough: null });
      expect(nullDraft.throughDay).toBe('2026-08-31');
      expect(nullDraft.throughDay < nullDraft.fromDay).toBe(true);
      // Measured before the segment begins (or "nothing measured"): an empty range.
      const empty = storageDays(line, { ...month, status: 'draft', storageMeasuredThrough: '2026-09-10' });
      expect(empty.throughDay < empty.fromDay).toBe(true);
    });

    it('every charge has exactly one record kind', () => {
      expect(RECORD_KIND_OF_CHARGE).toEqual({ inbound_handling: 'receipt-line', pick: 'pick', outbound_handling: 'order', storage: 'storage-day' });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Migration 0063 on a database built from the repo's own journal at 0062.
  // ──────────────────────────────────────────────────────────────────────────
  describe('migration 0063, applied to a pre-migration database', () => {
    const PRE_DB = 'wms_s_invrecords_premigration';
    let sql: ReturnType<typeof postgres>;
    let folder: string;
    const seeded = { tenant: uuidv7(), client: uuidv7(), invoice: uuidv7() };

    async function admin<T>(fn: (db: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
      const adminUrl = new URL(process.env.DATABASE_URL!);
      adminUrl.pathname = '/postgres';
      const db = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
      try {
        return await fn(db);
      } finally {
        await db.end();
      }
    }

    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${PRE_DB}`;
      const preUrl = url.toString();
      await admin(async (db) => {
        await db.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
        await db.unsafe(`drop database if exists "${PRE_DB}"`);
        await db.unsafe(`create database "${PRE_DB}"`);
      });
      folder = mkdtempSync(join(tmpdir(), 'wms-pre-0063-'));
      cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
      rmSync(join(folder, '0063_invoice_storage_measured_through.sql'));
      const journalPath = join(folder, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 62);
      writeFileSync(journalPath, JSON.stringify(journal));
      const db = createDatabase(preUrl);
      await migrate(db, { migrationsFolder: folder });
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
      sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
      // A pre-existing draft invoice: the column must arrive NULL on it.
      await sql`insert into client_invoices (id, tenant_id, client_id, period_start, period_end, status,
          subtotal_paise, cgst_paise, sgst_paise, igst_paise, tax_paise, total_paise, round_off_paise, payable_paise,
          gaps, warnings, party, content_hash, created_by)
        values (${seeded.invoice}, ${seeded.tenant}, ${seeded.client}, '2026-09-01', '2026-09-30', 'draft',
          0, 0, 0, 0, 0, 0, 0, 0, '[]', '[]', '{}', 'pre', ${uuidv7()})`;
    }, 120_000);

    afterAll(async () => {
      await sql?.end();
      rmSync(folder, { recursive: true, force: true });
      await admin(async (db) => {
        await db.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
        await db.unsafe(`drop database if exists "${PRE_DB}"`);
      });
    });

    it('applies in one transaction: a nullable date, NULL on the existing row; the 0062 guard admits a draft’s write', async () => {
      const before = await sql<{ n: number }[]>`select count(*)::int as n from information_schema.columns where table_name = 'client_invoices' and column_name = 'storage_measured_through'`;
      expect(before[0]!.n).toBe(0);
      await sql.begin(async (tx) => {
        for (const statement of migration0063Statements()) await tx.unsafe(statement);
      });
      const column = await sql<{ data_type: string; is_nullable: string }[]>`
        select data_type, is_nullable from information_schema.columns where table_name = 'client_invoices' and column_name = 'storage_measured_through'`;
      expect(column[0]).toEqual({ data_type: 'date', is_nullable: 'YES' });
      const row = await sql<{ smt: string | null }[]>`select storage_measured_through::text as smt from client_invoices where id = ${seeded.invoice}`;
      expect(row[0]!.smt).toBeNull();
      // A draft → draft write of the new column passes the guard trigger.
      await sql`update client_invoices set storage_measured_through = '2026-09-19' where id = ${seeded.invoice}`;
      const written = await sql<{ smt: string }[]>`select storage_measured_through::text as smt from client_invoices where id = ${seeded.invoice}`;
      expect(written[0]!.smt).toBe('2026-09-19');
    });

    it('the fail-fast guard refuses a second application', async () => {
      await expect(sql.unsafe(migration0063Statements()[0]!)).rejects.toThrow(/migration 0063 has already been applied/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Over the ledger, through HTTP.
  // ──────────────────────────────────────────────────────────────────────────
  describe('over the ledger, through HTTP', () => {
    let app: INestApplication;
    let db: Database;
    let sql: postgres.Sql;
    let suiteDb: SuiteDatabase;
    let inventory: InventoryFacade;
    let billing: BillingFacade;
    const realRateCardNow = rateCardClock.now;
    const realInvoiceNow = clientInvoiceClock.now;

    let tenantId: string;
    let ownerToken: string;
    let ownerEmail: string;
    let accountantToken: string;
    let opsToken: string;
    let portalToken: string;
    let actorId: string;
    const UNKNOWN_ACTOR = uuidv7();
    const wh: Record<'w1' | 'w2' | 'w3', string> = { w1: '', w2: '', w3: '' };
    const whCode: Record<'w1' | 'w2' | 'w3', string> = { w1: '', w2: '', w3: '' };
    const bin: Record<'w1' | 'w2' | 'w3', string> = { w1: '', w2: '', w3: '' };
    const clients = new Map<string, string>();
    const skus = new Map<string, string>();
    const orders: Record<'o1' | 'o2' | 'o3' | 'o4' | 'o5', string> = { o1: uuidv7(), o2: uuidv7(), o3: uuidv7(), o4: uuidv7(), o5: uuidv7() };

    const http = () => request(app.getHttpServer());
    const client = (code: string): string => clients.get(code)!;
    const sku = (code: string): string => skus.get(code)!;

    async function register(name: string, gstin?: string): Promise<{ tenantId: string; ownerToken: string; userId: string; email: string }> {
      const email = `owner-${ulid().toLowerCase()}@example.com`;
      const registered = await http()
        .post(API)
        .set(KEY_HEADER, ulid())
        .send({ name, ownerEmail: email, password: 'correct-horse-battery', ...(gstin === undefined ? {} : { gstin }) })
        .expect(201);
      const signedIn = await http().post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200);
      return { tenantId: registered.body.tenant.id as string, ownerToken: signedIn.body.accessToken as string, userId: registered.body.owner.id as string, email };
    }

    async function invite(role: string): Promise<{ token: string; email: string }> {
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
      const token = (await http().post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200)).body.accessToken as string;
      return { token, email };
    }

    async function createWarehouse(code: string, gstin?: string, origin: Record<string, unknown> = testAddress()): Promise<{ warehouseId: string; binId: string }> {
      const warehouseId = (
        await http()
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin, code, name: `${code} warehouse`, ...(gstin === undefined ? {} : { gstin }) })
          .expect(201)
      ).body.id as string;
      const zoneId = (
        await http()
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'A', name: 'Aisle A' })
          .expect(201)
      ).body.id as string;
      const binId = (
        await http()
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 100000000, type: 'shelf', code: 'A-01-01' })
          .expect(201)
      ).body.id as string;
      return { warehouseId, binId };
    }

    async function importSkus(clientId: string, rows: string[]): Promise<void> {
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

    async function append(event: {
      warehouseId: string;
      type: string;
      skuId: string;
      quantityDelta: number;
      fromBinId?: string | null;
      toBinId?: string | null;
      recordedAt: string;
      referenceDoc?: Record<string, unknown>;
    }): Promise<void> {
      const definition = getLedgerEventType(event.type)!;
      await withTenantTransaction(db, tenantId, (tx) =>
        inventory.appendLedgerEventInTx(tx, {
          tenantId,
          warehouseId: event.warehouseId,
          type: event.type,
          skuId: event.skuId,
          quantityDelta: event.quantityDelta as SignedQuantity,
          fromBinId: event.fromBinId ?? null,
          toBinId: event.toBinId ?? null,
          batchRef: null,
          serialRef: null,
          actorUserId: actorId,
          occurredAt: event.recordedAt,
          recordedAt: event.recordedAt,
          referenceDoc: (event.referenceDoc ?? { kind: definition.referenceKinds[0] }) as never,
        }),
      );
    }

    async function receive(where: 'w1' | 'w2' | 'w3', skuCode: string, milli: number, at: string): Promise<void> {
      await append({ warehouseId: wh[where], type: 'grn.received', skuId: sku(skuCode), quantityDelta: milli, toBinId: bin[where], recordedAt: istIso(at) });
    }

    async function draw(where: 'w1' | 'w2' | 'w3', skuCode: string, milli: number, at: string): Promise<void> {
      await append({ warehouseId: wh[where], type: 'pick.picked', skuId: sku(skuCode), quantityDelta: -milli, fromBinId: bin[where], recordedAt: istIso(at) });
    }

    async function dispatch(where: 'w1' | 'w2' | 'w3', skuCode: string, orderId: string, at: string, carrier?: { name: string; tracking: string }): Promise<void> {
      await append({
        warehouseId: wh[where],
        type: 'dispatch.dispatched',
        skuId: sku(skuCode),
        quantityDelta: 0,
        recordedAt: istIso(at),
        referenceDoc: {
          kind: 'dispatch',
          orderId,
          orderLineId: uuidv7(),
          dispatchedQty: 1,
          ...(carrier === undefined ? {} : { carrierName: carrier.name, trackingNumber: carrier.tracking }),
        },
      });
    }

    async function seedGrn(
      where: 'w1' | 'w2' | 'w3',
      recordedAt: string,
      lines: readonly { skuId: string; qtyMilli: number; appliedMilli?: number }[],
      options: { poCode?: string; recordedBy?: string } = {},
    ): Promise<string> {
      const grnId = uuidv7();
      let poId: string | null = null;
      if (options.poCode !== undefined) {
        poId = uuidv7();
        const vendor = await sql<{ id: string }[]>`select id from vendors where tenant_id = ${tenantId} limit 1`;
        const vendorId = vendor[0]?.id ?? uuidv7();
        const owner = await sql<{ client_id: string }[]>`select client_id from skus where id = ${lines[0]!.skuId}`;
        await sql`insert into purchase_orders (id, tenant_id, client_id, warehouse_id, vendor_id, code, status)
          values (${poId}, ${tenantId}, ${owner[0]!.client_id}, ${wh[where]}, ${vendorId}, ${options.poCode}, 'open')`;
      }
      const code = `GRN-${ulid().slice(14)}`;
      await sql`insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, blind_reason_code, status, device_id, recorded_by, occurred_at, recorded_at)
        values (${grnId}, ${tenantId}, ${wh[where]}, ${code}, ${poId}, ${poId === null ? 'other' : null}, 'recorded', ${uuidv7()},
          ${options.recordedBy ?? actorId}, ${istIso(recordedAt)}, ${istIso(recordedAt)})`;
      for (const line of lines) {
        await sql`insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty)
          values (${uuidv7()}, ${tenantId}, ${grnId}, ${line.skuId}, ${line.qtyMilli}, ${line.appliedMilli ?? line.qtyMilli})`;
      }
      return code;
    }

    async function seedPick(where: 'w1' | 'w2' | 'w3', skuId: string, createdAt: string, orderId: string, qtyMilli = 1000): Promise<string> {
      const id = uuidv7();
      await sql`insert into picks (id, tenant_id, warehouse_id, wave_id, picklist_id, picklist_line_id, order_id, order_line_id,
          sku_id, bin_id, qty, picked_by, picked_at, device_id, created_at, updated_at)
        values (${id}, ${tenantId}, ${wh[where]}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${orderId}, ${uuidv7()},
          ${skuId}, ${bin[where]}, ${qtyMilli}, ${actorId}, ${istIso(createdAt)}, ${uuidv7()}, ${istIso(createdAt)}, ${istIso(createdAt)})`;
      return id;
    }

    async function seedOrder(id: string, clientCode: string, where: 'w1' | 'w2' | 'w3', channel: string | null): Promise<void> {
      await sql`insert into orders (id, tenant_id, client_id, warehouse_id, status, source, integration_id, external_event_id)
        values (${id}, ${tenantId}, ${client(clientCode)}, ${wh[where]}, 'dispatched', ${channel === null ? 'manual' : 'ingested'},
          ${channel === null ? null : uuidv7()}, ${channel})`;
    }

    async function settle(clientCode: string, where: 'w1' | 'w2' | 'w3', nowMs: number): Promise<void> {
      for (let i = 0; i < 4; i += 1) {
        const tick = await billing.snapshotScope(tenantId, client(clientCode), wh[where], nowMs);
        if (tick.waiting !== 'commit-guarantee') break;
      }
    }

    const ALL_FOUR = (storage: number, inbound: number, pick: number, outbound: number) => [
      { chargeCode: 'storage', basis: 'per_thousand_units_per_day', amountPaise: storage },
      { chargeCode: 'inbound_handling', basis: 'per_receipt_line', amountPaise: inbound },
      { chargeCode: 'pick', basis: 'per_pick', amountPaise: pick },
      { chargeCode: 'outbound_handling', basis: 'per_order', amountPaise: outbound },
    ];

    async function activeCard(clientId: string, lines: { chargeCode: string; basis: string; amountPaise: number }[], effectiveFrom: string, clockAt: string): Promise<string> {
      rateCardClock.now = () => ist(clockAt);
      const drafted = await http()
        .post(`${API}/${tenantId}/clients/${clientId}/rate-cards`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .set(KEY_HEADER, ulid())
        .send({ lines })
        .expect(201);
      const id = drafted.body.rateCard.id as string;
      await http()
        .post(`${API}/${tenantId}/rate-cards/${id}/activate`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .set(KEY_HEADER, ulid())
        .send({ effectiveFrom })
        .expect(200);
      rateCardClock.now = realRateCardNow;
      return id;
    }

    const FULL = (overrides: Record<string, unknown> = {}) => ({
      legalName: 'Brand Private Limited',
      billingLine1: '5 Brigade Road',
      billingCity: 'Bengaluru',
      billingStateCode: '29',
      billingPincode: '560025',
      ...overrides,
    });

    function prepare(clientId: string, month: string) {
      return http().post(`${API}/${tenantId}/clients/${clientId}/invoices`).set('Authorization', `Bearer ${accountantToken}`).set(KEY_HEADER, ulid()).send({ month });
    }

    function act(invoiceId: string, verb: 'issue' | 'refresh' | 'dispute' | 'settle' | 'void', body: Record<string, unknown> = {}) {
      return http().post(`${API}/${tenantId}/client-invoices/${invoiceId}/${verb}`).set('Authorization', `Bearer ${accountantToken}`).set(KEY_HEADER, ulid()).send(body);
    }

    function records(invoiceId: string, lineId: string, query: Record<string, string | number> = {}, token = opsToken, tenant = tenantId) {
      return http().get(`${API}/${tenant}/client-invoices/${invoiceId}/lines/${lineId}/records`).query(query).set('Authorization', `Bearer ${token}`);
    }

    function breakdown(invoiceId: string, lineId: string, query: Record<string, string>, token = opsToken) {
      return http().get(`${API}/${tenantId}/client-invoices/${invoiceId}/lines/${lineId}/storage-breakdown`).query(query).set('Authorization', `Bearer ${token}`);
    }

    function expectProblem(res: request.Response, status: number, code: string): void {
      expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
    }

    type Line = { id: string; segmentFrom: string; segmentTo: string; chargeCode: string; uom: string | null; quantity: string };
    type Invoice = { id: string; status: string; supplierGstin: string | null; lines: Line[]; gaps: { code: string }[] };
    type Rec = Record<string, unknown> & { kind: string };
    type PageBody = { kind: string; invoiceStatus: string; summary?: { lineQuantity: string; recordsQuantity: string; reconciles: boolean }; records: Rec[]; nextCursor: string | null };

    /** Every page of a line's drill, at `limit`; asserts the summary is on the first page only. */
    async function walk(invoiceId: string, lineId: string, limit: number): Promise<{ first: PageBody; all: Rec[]; pages: number }> {
      const all: Rec[] = [];
      let cursor: string | null = null;
      let first: PageBody | null = null;
      let pages = 0;
      do {
        const res = await records(invoiceId, lineId, cursor === null ? { limit } : { limit, cursor }).expect(200);
        const body = res.body as PageBody;
        if (first === null) {
          first = body;
          expect(body.summary).toBeDefined();
        } else {
          expect(body.summary).toBeUndefined();
        }
        expect(body.records.length).toBeLessThanOrEqual(limit);
        all.push(...body.records);
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 500);
      return { first: first!, all, pages };
    }

    /** What a line's records add up to, in the line view's units (milli for storage, a count otherwise). */
    function recordsTotal(line: Line, all: Rec[]): bigint {
      if (line.chargeCode === 'storage') return all.reduce((sum, rec) => sum + decimalToMilli(String(rec.onHand)), 0n);
      return BigInt(all.length);
    }
    const lineTotal = (line: Line): bigint => (line.chargeCode === 'storage' ? decimalToMilli(line.quantity) : BigInt(line.quantity));
    const keyOf = (rec: Rec): string => (rec.kind === 'storage-day' ? `${String(rec.date)}|${String(rec.warehouseId)}` : String(rec.id));

    /** Every line of an invoice drills to records that add up to it — walked at two page sizes, no duplicate, no gap. */
    async function expectEveryLineReconciles(invoice: Invoice): Promise<void> {
      for (const line of invoice.lines) {
        const big = await walk(invoice.id, line.id, 1000);
        expect(big.first.kind).toBe(RECORD_KIND_OF_CHARGE[line.chargeCode as keyof typeof RECORD_KIND_OF_CHARGE]);
        expect(big.first.invoiceStatus).toBe(invoice.status);
        expect(big.first.summary).toEqual({ lineQuantity: line.quantity, recordsQuantity: line.quantity, reconciles: true });
        expect(recordsTotal(line, big.all)).toBe(lineTotal(line));
        const small = await walk(invoice.id, line.id, 2);
        expect(small.all.map(keyOf)).toEqual(big.all.map(keyOf));
        expect(new Set(small.all.map(keyOf)).size).toBe(small.all.length);
      }
    }

    const AT_OCT_1 = ist('2026-10-01T00:30');
    const AT_OCT_7 = ist('2026-10-07T10:00');
    const lineOf = (invoice: Invoice, charge: string, segmentFrom: string, uom: string | null = null): Line =>
      invoice.lines.find((line) => line.chargeCode === charge && line.segmentFrom === segmentFrom && line.uom === uom)!;

    let acme29: Invoice;
    let acme27: Invoice;
    let beta: Invoice;
    let gamma: Invoice;
    const picksSharingInstant: string[] = [];

    beforeAll(async () => {
      suiteDb = await useSuiteDatabase('invoicerecords');
      app = await createApp(false);
      await app.init();
      db = app.get<Database>(DATABASE);
      inventory = app.get(InventoryFacade);
      billing = app.get(BillingFacade);
      sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
      clientInvoiceClock.now = () => AT_OCT_7;

      const owner = await register(`Drill PL Co ${ulid()}`, T29);
      tenantId = owner.tenantId;
      ownerToken = owner.ownerToken;
      ownerEmail = owner.email;
      actorId = owner.userId;
      accountantToken = (await invite('accountant')).token;
      opsToken = (await invite('ops_manager')).token;
      const portal = await invite('accountant');
      portalToken = portal.token;

      const w1 = await createWarehouse(`DR1-${ulid().slice(20)}`);
      const w2 = await createWarehouse(`DR2-${ulid().slice(20)}`);
      const w3 = await createWarehouse(`DR3-${ulid().slice(20)}`, W27, testAddress({ city: 'Mumbai', state: 'Maharashtra', pincode: '400001' }));
      for (const [where, made] of [['w1', w1], ['w2', w2], ['w3', w3]] as const) {
        wh[where] = made.warehouseId;
        bin[where] = made.binId;
      }
      const listedWarehouses = await http().get(`${API}/${tenantId}/warehouses?limit=50`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      for (const row of listedWarehouses.body.items as { id: string; code: string }[]) {
        for (const where of ['w1', 'w2', 'w3'] as const) if (row.id === wh[where]) whCode[where] = row.code;
      }

      for (const code of ['ACME', 'BETA', 'GAMMA']) {
        clients.set(
          code,
          (
            await http()
              .post(`${API}/${tenantId}/clients`)
              .set('Authorization', `Bearer ${ownerToken}`)
              .set(KEY_HEADER, ulid())
              .send({ code, name: `${code} Brand` })
              .expect(201)
          ).body.client.id as string,
        );
      }
      await importSkus(client('ACME'), ['ACME-PC,Acme widget,each,1800,,,', 'ACME-KG,Acme flour,kg,1800,,,', 'MOVE-X,Moved item,each,1800,,,']);
      await importSkus(client('BETA'), ['BETA-PC,Beta widget,each,1800,,,']);
      await importSkus(client('GAMMA'), ['GAMMA-PC,Gamma widget,each,1800,,,']);
      const skuList = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      for (const item of skuList.body.items as { code: string; id: string }[]) skus.set(item.code, item.id);

      // Story 21-7: role and client together (the 0065 CHECK), the token minted
      // before — a claim-less token, so the per-route refusal is what answers.
      await sql`update users set role = 'client', client_id = ${client('ACME')} where tenant_id = ${tenantId} and email = ${portal.email}`;
      for (const code of ['ACME', 'BETA', 'GAMMA']) {
        await http().patch(`${API}/${tenantId}/clients/${client(code)}/tax-details`).set('Authorization', `Bearer ${accountantToken}`).set(KEY_HEADER, ulid()).send(FULL()).expect(200);
      }

      // ── ACME, September. Group 29 = WH1 + WH2 (the tenant GSTIN); WH3 is 27.
      // Storage: MOVE-X 100 each in WH1 from the 2nd (ACME's when received —
      // it is "corrected" to BETA below, the 21-2b race); ACME-PC 300 each in
      // WH1 the 10th–17th; ACME-KG 12.5 kg in WH2 from the 12th; ACME-PC 50
      // in WH3 from the 20th.
      await receive('w1', 'MOVE-X', 100_000, '2026-09-02T10:00');
      await receive('w1', 'ACME-PC', 300_000, '2026-09-10T10:00');
      await draw('w1', 'ACME-PC', 300_000, '2026-09-18T10:00');
      await receive('w2', 'ACME-KG', 12_500, '2026-09-12T10:00');
      // The same client + uom in WH1 on the same days: storage rows tie on the day across warehouses.
      await receive('w1', 'ACME-KG', 5_000, '2026-09-12T10:00');
      await receive('w3', 'ACME-PC', 50_000, '2026-09-20T10:00');
      // Receipt lines: a PO receipt of two lines (WH1, the 10th), a blind one
      // by an actor who is not a user (WH2, the 12th), one after the card
      // change (WH1, the 16th), and one in WH3 (group 27 — never in 29's drill).
      await seedGrn('w1', '2026-09-10T10:00', [{ skuId: sku('ACME-PC'), qtyMilli: 300_000 }, { skuId: sku('ACME-KG'), qtyMilli: 2_500, appliedMilli: 2_000 }], { poCode: 'PO-ACME-1' });
      await seedGrn('w2', '2026-09-12T10:00', [{ skuId: sku('ACME-KG'), qtyMilli: 12_500 }], { recordedBy: UNKNOWN_ACTOR });
      // Three lines of one GRN share its recorded_at: a keyset tie the pages must cross.
      await seedGrn('w1', '2026-09-16T10:00', [{ skuId: sku('ACME-PC'), qtyMilli: 1_000 }, { skuId: sku('ACME-KG'), qtyMilli: 1_000 }, { skuId: sku('ACME-PC'), qtyMilli: 2_000 }]);
      await seedGrn('w3', '2026-09-20T10:00', [{ skuId: sku('ACME-PC'), qtyMilli: 50_000 }]);
      // Orders: o1 (a channel order) ships two lines on the 20th; o2 (manual)
      // ships one line on the 30th (22:00 IST) and one on Oct 1st; o3 on the
      // 8th (card A).
      await seedOrder(orders.o1, 'ACME', 'w1', 'shopify-evt-1');
      await seedOrder(orders.o2, 'ACME', 'w1', null);
      await seedOrder(orders.o3, 'ACME', 'w1', null);
      await seedOrder(orders.o4, 'ACME', 'w1', null);
      await seedOrder(orders.o5, 'ACME', 'w1', null);
      await dispatch('w1', 'ACME-PC', orders.o1, '2026-09-20T10:00', { name: 'BlueDart', tracking: 'BD-1' });
      await dispatch('w1', 'ACME-PC', orders.o1, '2026-09-20T11:00', { name: 'BlueDart', tracking: 'BD-1' });
      await dispatch('w1', 'ACME-PC', orders.o2, '2026-09-30T22:00', { name: 'Ekart', tracking: 'EK-9' });
      await dispatch('w1', 'ACME-PC', orders.o2, '2026-10-01T09:00', { name: 'Delhivery', tracking: 'DL-2' });
      await dispatch('w1', 'ACME-PC', orders.o3, '2026-09-08T10:00');
      // o4 and o5 first dispatch at the SAME recorded_at: an order-drill keyset tie.
      await dispatch('w1', 'ACME-PC', orders.o4, '2026-09-25T10:00');
      await dispatch('w1', 'ACME-PC', orders.o5, '2026-09-25T10:00');
      // Picks: one on the 5th (card A); three sharing ONE created_at on the
      // 16th and one on the 18th (card B); one in WH3 (group 27).
      await seedPick('w1', sku('ACME-PC'), '2026-09-05T10:00', orders.o3);
      for (let i = 0; i < 3; i += 1) picksSharingInstant.push(await seedPick('w1', sku('ACME-PC'), '2026-09-16T10:00', orders.o1, 2_500));
      await seedPick('w1', sku('ACME-PC'), '2026-09-18T10:00', orders.o2);
      await seedPick('w3', sku('ACME-PC'), '2026-09-21T10:00', orders.o2);

      // ── BETA (WH1): 100 each from the 3rd; MOVE-X is "corrected" to BETA
      // directly (the race the drill alarms on), then 40 of it are drawn —
      // stamped BETA — so BETA's MOVE-X folds NEGATIVE in WH1.
      await receive('w1', 'BETA-PC', 100_000, '2026-09-03T10:00');
      await seedGrn('w1', '2026-09-03T10:00', [{ skuId: sku('BETA-PC'), qtyMilli: 100_000 }]);
      // A receipt line in WH3 with no stock event there: BETA's group 27 has counts but no snapshot scope.
      await seedGrn('w3', '2026-09-06T10:00', [{ skuId: sku('BETA-PC'), qtyMilli: 1_000 }]);
      await sql`update skus set client_id = ${client('BETA')} where id = ${sku('MOVE-X')}`;
      await draw('w1', 'MOVE-X', 40_000, '2026-09-04T10:00');

      // ── GAMMA (WH1): 10 each from the 4th; its storage is measured only to the 19th at first.
      await receive('w1', 'GAMMA-PC', 10_000, '2026-09-04T10:00');
      await seedGrn('w1', '2026-09-04T10:00', [{ skuId: sku('GAMMA-PC'), qtyMilli: 10_000 }]);

      // ── the cards: ACME A from 09-01, B from 09-15; BETA and GAMMA one each.
      await activeCard(client('ACME'), ALL_FOUR(330, 500, 300, 2000), '2026-09-01', '2026-09-01T09:00');
      await activeCard(client('ACME'), ALL_FOUR(400, 600, 350, 2500), '2026-09-15', '2026-09-05T09:00');
      await activeCard(client('BETA'), ALL_FOUR(1000, 700, 300, 2000), '2026-09-01', '2026-09-01T09:00');
      await activeCard(client('GAMMA'), ALL_FOUR(1000, 700, 300, 2000), '2026-09-01', '2026-09-01T09:00');

      for (const [code, where] of [['ACME', 'w1'], ['ACME', 'w2'], ['ACME', 'w3'], ['BETA', 'w1']] as const) await settle(code, where, AT_OCT_1);
      await settle('GAMMA', 'w1', ist('2026-09-20T00:30'));
    }, 240_000);

    afterAll(async () => {
      rateCardClock.now = realRateCardNow;
      clientInvoiceClock.now = realInvoiceNow;
      await sql?.end();
      const rawDb = app?.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
      await rawDb?.$client?.end();
      const authDb = app?.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
      await authDb?.$client?.end();
      await app?.close();
      await suiteDb?.drop();
    });

    describe('ACME — a draft, then issued: every line reconciles', () => {
      it('prepare: group 29 and group 27 drafts; every draft line carries an id; the measured-through day is stored', async () => {
        const res = await prepare(client('ACME'), '2026-09').expect(201);
        const created = res.body.created as Invoice[];
        acme29 = created.find((invoice) => invoice.supplierGstin === T29)!;
        acme27 = created.find((invoice) => invoice.supplierGstin === W27)!;
        expect(acme29.gaps).toEqual([]);
        for (const line of [...acme29.lines, ...acme27.lines]) expect(line.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(acme29.lines.map((line) => [line.segmentFrom, line.chargeCode, line.uom, line.quantity])).toEqual([
          ['2026-09-01', 'storage', 'each', '2800'], // MOVE-X 100 × 13 days (2nd–14th) + ACME-PC 300 × 5 (10th–14th)
          ['2026-09-01', 'storage', 'kg', '52.5'], // (12.5 + 5) kg × 3 (12th–14th)
          ['2026-09-01', 'inbound_handling', null, '3'],
          ['2026-09-01', 'pick', null, '1'],
          ['2026-09-01', 'outbound_handling', null, '1'],
          ['2026-09-15', 'storage', 'each', '2500'], // 400 × 3 + 100 × 13
          ['2026-09-15', 'storage', 'kg', '280'], // 17.5 × 16
          ['2026-09-15', 'inbound_handling', null, '3'],
          ['2026-09-15', 'pick', null, '4'],
          ['2026-09-15', 'outbound_handling', null, '4'],
        ]);
        const stored = await sql<{ smt: string }[]>`select storage_measured_through::text as smt from client_invoices where id = ${acme29.id}`;
        expect(stored[0]!.smt).toBe('2026-09-30');
      });

      it('on the DRAFT: every line’s records add up to it — summary on the first page only, keyset pages with no duplicate or gap', async () => {
        await expectEveryLineReconciles(acme29);
        await expectEveryLineReconciles(acme27);
      });

      it('issued: the same lines reconcile on the issued invoice', async () => {
        const res = await act(acme29.id, 'issue').expect(200);
        expect(res.body.outcome).toBe('issued');
        acme29 = res.body.invoice as Invoice;
        const stored = await sql<{ smt: string }[]>`select storage_measured_through::text as smt from client_invoices where id = ${acme29.id}`;
        expect(stored[0]!.smt).toBe('2026-09-30');
        // The 0062 guard freezes it on an issued row like every other column.
        await expect(sql`update client_invoices set storage_measured_through = '2026-09-19' where id = ${acme29.id}`).rejects.toMatchObject({ code: 'P0001' });
        expect(acme29.status).toBe('issued');
        await expectEveryLineReconciles(acme29);
      });

      it('receipt lines: GRN, PO (null when blind), IST-ready instant, warehouse, SKU, both quantities, actor — an unknown actor reads null', async () => {
        const page = await records(acme29.id, lineOf(acme29, 'inbound_handling', '2026-09-01').id).expect(200);
        const recs = page.body.records as Rec[];
        expect(recs.map((rec) => [rec.kind, rec.poCode, rec.skuCode, rec.qty, rec.appliedQty, rec.warehouseCode, rec.actorEmail])).toEqual([
          ['receipt-line', 'PO-ACME-1', expect.any(String), expect.any(String), expect.any(String), whCode.w1, ownerEmail],
          ['receipt-line', 'PO-ACME-1', expect.any(String), expect.any(String), expect.any(String), whCode.w1, ownerEmail],
          ['receipt-line', null, 'ACME-KG', '12.5', '12.5', whCode.w2, null],
        ]);
        // An over-receipt line: received 2.5, applied 2.
        expect([recs[1]!.skuCode, recs[1]!.qty, recs[1]!.appliedQty, recs[1]!.skuName]).toEqual(['ACME-KG', '2.5', '2', 'Acme flour']);
        expect(recs[2]!.actorId).toBe(UNKNOWN_ACTOR);
        expect(recs[0]!.recordedAt).toBe('2026-09-10T04:30:00.000000Z');
        expect(String(recs[0]!.grnCode)).toMatch(/^GRN-/);
      });

      it('picks: the three that share one created_at are each listed once at every page size; order ref, bin, picker', async () => {
        const line = lineOf(acme29, 'pick', '2026-09-15');
        for (const limit of [1, 2, 3]) {
          const walked = await walk(acme29.id, line.id, limit);
          expect(walked.all).toHaveLength(4);
          expect(walked.pages).toBe(Math.ceil(4 / limit));
          const ids = walked.all.map((rec) => String(rec.id));
          for (const id of picksSharingInstant) expect(ids).toContain(id);
          expect(new Set(ids).size).toBe(4);
        }
        const first = (await records(acme29.id, line.id).expect(200)).body.records[0] as Rec;
        expect(first).toMatchObject({
          kind: 'pick',
          pickedAt: '2026-09-16T04:30:00.000000Z',
          warehouseCode: whCode.w1,
          orderRef: { source: 'ingested', externalEventId: 'shopify-evt-1', orderId: orders.o1 },
          skuCode: 'ACME-PC',
          qty: '2.5',
          binCode: 'A-01-01',
          actorEmail: ownerEmail,
        });
      });

      it('split dispatch: o2 ships either side of the month end — listed once, on September, with its FIRST event’s carrier; o1’s two lines count as one order', async () => {
        const res = await records(acme29.id, lineOf(acme29, 'outbound_handling', '2026-09-15').id).expect(200);
        const recs = res.body.records as Rec[];
        expect(recs.map((rec) => [(rec.orderRef as { orderId: string }).orderId, rec.lines, rec.carrierName, rec.trackingNumber])).toEqual([
          [orders.o1, 2, 'BlueDart', 'BD-1'],
          [orders.o4, 1, null, null],
          [orders.o5, 1, null, null],
          [orders.o2, 1, 'Ekart', 'EK-9'],
        ]);
        expect(recs[3]).toMatchObject({ kind: 'order', dispatchedAt: '2026-09-30T16:30:00.000000Z', orderRef: { source: 'manual', externalEventId: null }, actorEmail: ownerEmail });
        // The card-A segment holds only o3.
        const early = await records(acme29.id, lineOf(acme29, 'outbound_handling', '2026-09-01').id).expect(200);
        expect((early.body.records as Rec[]).map((rec) => (rec.orderRef as { orderId: string }).orderId)).toEqual([orders.o3]);
      });

      it('keyset ties are crossed at every page boundary: a 3-line GRN, two orders first dispatched at one instant, one uom in two warehouses on the same days', async () => {
        for (const line of [
          lineOf(acme29, 'inbound_handling', '2026-09-15'),
          lineOf(acme29, 'outbound_handling', '2026-09-15'),
          lineOf(acme29, 'storage', '2026-09-15', 'kg'),
          lineOf(acme29, 'pick', '2026-09-15'),
        ]) {
          const all = (await walk(acme29.id, line.id, 1000)).all.map(keyOf);
          expect(all.length).toBeGreaterThanOrEqual(3);
          expect(new Set(all).size).toBe(all.length);
          expect(BigInt(all.length)).toBe(line.chargeCode === 'storage' ? 32n : lineTotal(line));
          for (const limit of [1, 2, 3]) {
            const walked = await walk(acme29.id, line.id, limit);
            expect(walked.all.map(keyOf)).toEqual(all);
            expect(walked.pages).toBe(Math.ceil(all.length / limit));
          }
        }
      });

      it('two registrations: group 29’s drills show only WH1/WH2 records; group 27’s only WH3', async () => {
        for (const line of acme29.lines) {
          const walked = await walk(acme29.id, line.id, 1000);
          for (const rec of walked.all) expect([wh.w1, wh.w2]).toContain(rec.warehouseId);
        }
        for (const line of acme27.lines) {
          const walked = await walk(acme27.id, line.id, 1000);
          expect(walked.all.length).toBeGreaterThan(0);
          for (const rec of walked.all) expect(rec.warehouseId).toBe(wh.w3);
        }
      });

      it('card change: each line drills only its own segment', async () => {
        const a = await walk(acme29.id, lineOf(acme29, 'storage', '2026-09-01', 'each').id, 1000);
        const b = await walk(acme29.id, lineOf(acme29, 'storage', '2026-09-15', 'each').id, 1000);
        expect(a.all.every((rec) => String(rec.date) >= '2026-09-01' && String(rec.date) <= '2026-09-14')).toBe(true);
        expect(b.all.every((rec) => String(rec.date) >= '2026-09-15' && String(rec.date) <= '2026-09-30')).toBe(true);
        const picksA = await walk(acme29.id, lineOf(acme29, 'pick', '2026-09-01').id, 1000);
        expect(picksA.all.map((rec) => rec.pickedAt)).toEqual(['2026-09-05T04:30:00.000000Z']);
      });

      it('storage: one row per (day, warehouse) of the line’s base UoM, in day order', async () => {
        const kg = await walk(acme29.id, lineOf(acme29, 'storage', '2026-09-15', 'kg').id, 1000);
        expect(kg.all).toHaveLength(32); // 16 days × WH1 and WH2
        const [w1First, w2First] = [wh.w1, wh.w2].sort();
        expect(kg.all.slice(0, 2).map((rec) => [rec.date, rec.warehouseId])).toEqual([['2026-09-15', w1First], ['2026-09-15', w2First]]);
        expect(kg.all.find((rec) => rec.warehouseId === wh.w2)).toEqual({ kind: 'storage-day', date: '2026-09-15', warehouseId: wh.w2, warehouseCode: whCode.w2, uom: 'kg', onHand: '12.5' });
        expect(kg.all.at(-1)!.date).toBe('2026-09-30');
        const each = await walk(acme29.id, lineOf(acme29, 'storage', '2026-09-01', 'each').id, 1000);
        expect(each.all).toHaveLength(13); // the 2nd–14th, WH1 only
        expect(each.all.find((rec) => rec.date === '2026-09-10')!.onHand).toBe('400');
      });

      it('drift on an issued invoice: a rebuilt snapshot with another figure → reconciles false, both figures', async () => {
        const line = lineOf(acme29, 'storage', '2026-09-15', 'kg');
        await sql`update storage_snapshots set on_hand_milli = 13500
          where tenant_id = ${tenantId} and client_id = ${client('ACME')} and warehouse_id = ${wh.w2} and snapshot_date = '2026-09-20' and uom = 'kg'`;
        try {
          const res = await records(acme29.id, line.id).expect(200);
          expect(res.body.invoiceStatus).toBe('issued');
          expect(res.body.summary).toEqual({ lineQuantity: '280', recordsQuantity: '281', reconciles: false });
        } finally {
          await sql`update storage_snapshots set on_hand_milli = 12500
            where tenant_id = ${tenantId} and client_id = ${client('ACME')} and warehouse_id = ${wh.w2} and snapshot_date = '2026-09-20' and uom = 'kg'`;
        }
        expect((await records(acme29.id, line.id).expect(200)).body.summary.reconciles).toBe(true);
      });

      it('group changed: WH3’s GSTIN no longer maps → 409 invoice-group-changed, never a silent zero', async () => {
        const line = acme27.lines[0]!;
        await sql`update warehouses set gstin = null where id = ${wh.w3}`;
        try {
          expectProblem(await records(acme27.id, line.id), 409, 'invoice-group-changed');
        } finally {
          await sql`update warehouses set gstin = ${W27} where id = ${wh.w3}`;
        }
        await records(acme27.id, line.id).expect(200);
      });
    });

    describe('BETA — the storage breakdown (a negative SKU), void', () => {
      it('one day’s per-SKU on-hand sums to that day’s snapshot — the negative SKU included', async () => {
        const res = await prepare(client('BETA'), '2026-09').expect(201);
        beta = (res.body.created as Invoice[]).find((invoice) => invoice.supplierGstin === T29)!;
        // Group 27 has a receipt line but no snapshot scope: it stores period_start − 1 (nothing measured), never NULL.
        const beta27 = (res.body.created as Invoice[]).find((invoice) => invoice.supplierGstin === W27)!;
        expect(beta27.lines.map((line) => line.chargeCode)).toEqual(['inbound_handling']);
        const stored27 = await sql<{ smt: string | null }[]>`select storage_measured_through::text as smt from client_invoices where id = ${beta27.id}`;
        expect(stored27[0]!.smt).toBe('2026-08-31');
        await expectEveryLineReconciles(beta27);
        const issued = await act(beta.id, 'issue').expect(200);
        beta = issued.body.invoice as Invoice;
        await expectEveryLineReconciles(beta);
        const storage = lineOf(beta, 'storage', '2026-09-01', 'each');
        const day = await breakdown(beta.id, storage.id, { date: '2026-09-05', warehouseId: wh.w1 }).expect(200);
        expect(day.body).toEqual({
          date: '2026-09-05',
          warehouseId: wh.w1,
          warehouseCode: whCode.w1,
          uom: 'each',
          skus: [
            { skuId: sku('BETA-PC'), skuCode: 'BETA-PC', skuName: 'Beta widget', onHand: '100' },
            { skuId: sku('MOVE-X'), skuCode: 'MOVE-X', skuName: 'Moved item', onHand: '-40' },
          ],
          total: '60',
          snapshotOnHand: '60',
          reconciles: true,
        });
        // The 3rd: before the draw — BETA-PC only.
        const third = await breakdown(beta.id, storage.id, { date: '2026-09-03', warehouseId: wh.w1 }).expect(200);
        expect(third.body).toMatchObject({ total: '100', snapshotOnHand: '100', reconciles: true });
        expect((third.body.skus as unknown[]).length).toBe(1);
      });

      it('breakdown misuse: a non-storage line, a date outside the measured segment, a warehouse outside the group → 404; malformed → 400', async () => {
        const storage = lineOf(beta, 'storage', '2026-09-01', 'each');
        const handling = lineOf(beta, 'inbound_handling', '2026-09-01');
        expectProblem(await breakdown(beta.id, handling.id, { date: '2026-09-05', warehouseId: wh.w1 }), 404, 'not-found');
        expectProblem(await breakdown(beta.id, storage.id, { date: '2026-08-31', warehouseId: wh.w1 }), 404, 'not-found');
        expectProblem(await breakdown(beta.id, storage.id, { date: '2026-10-01', warehouseId: wh.w1 }), 404, 'not-found');
        expectProblem(await breakdown(beta.id, storage.id, { date: '2026-09-05', warehouseId: wh.w3 }), 404, 'not-found');
        expectProblem(await breakdown(beta.id, storage.id, { date: '2026-09-31', warehouseId: wh.w1 }), 400, 'validation-failed');
        expectProblem(await breakdown(beta.id, storage.id, { date: '2026-09-05', warehouseId: 'not-a-uuid' }), 400, 'validation-failed');
        expectProblem(await breakdown(beta.id, storage.id, { date: '2026-09-05' } as Record<string, string>), 400, 'validation-failed');
      });

      it('a void invoice drills like any other', async () => {
        const voided = await act(beta.id, 'void', { note: 'issued in error' }).expect(200);
        beta = voided.body.invoice as Invoice;
        expect(beta.status).toBe('void');
        await expectEveryLineReconciles(beta);
      });
    });

    describe('GAMMA — a draft measured short, then refreshed', () => {
      it('a draft prepared before storage finished drills only its measured days, and reconciles', async () => {
        const res = await prepare(client('GAMMA'), '2026-09').expect(201);
        gamma = (res.body.created as Invoice[])[0]!;
        expect(gamma.gaps.map((gap) => gap.code)).toContain('storage-not-complete');
        const stored = await sql<{ smt: string }[]>`select storage_measured_through::text as smt from client_invoices where id = ${gamma.id}`;
        expect(stored[0]!.smt).toBe('2026-09-19');
        const storage = lineOf(gamma, 'storage', '2026-09-01', 'each');
        expect(storage.quantity).toBe('160'); // 10 × the 4th–19th
        // The job now catches up — the drill still lists exactly the draft's days.
        await settle('GAMMA', 'w1', AT_OCT_1);
        const walked = await walk(gamma.id, storage.id, 1000);
        expect(walked.all.map((rec) => rec.date).at(-1)).toBe('2026-09-19');
        expect(walked.first.summary).toEqual({ lineQuantity: '160', recordsQuantity: '160', reconciles: true });
        // A breakdown past the measured day is outside the line.
        expectProblem(await breakdown(gamma.id, storage.id, { date: '2026-09-25', warehouseId: wh.w1 }), 404, 'not-found');
        await breakdown(gamma.id, storage.id, { date: '2026-09-19', warehouseId: wh.w1 }).expect(200);
      });

      const measuredOf = async (id: string): Promise<string | null> =>
        (await sql<{ smt: string | null }[]>`select storage_measured_through::text as smt from client_invoices where id = ${id}`)[0]!.smt;

      it('a late receipt line: the draft no longer adds up (reconciles false, both figures); a STALE issue rewrites it — the OLD line ids answer 404, the measured day moves, the new lines reconcile', async () => {
        const handling = lineOf(gamma, 'inbound_handling', '2026-09-01');
        await seedGrn('w1', '2026-09-25T10:00', [{ skuId: sku('GAMMA-PC'), qtyMilli: 1_000 }]);
        const stale = await records(gamma.id, handling.id).expect(200);
        expect(stale.body.invoiceStatus).toBe('draft');
        expect(stale.body.summary).toEqual({ lineQuantity: '1', recordsQuantity: '2', reconciles: false });
        const issued = await act(gamma.id, 'issue').expect(200);
        expect(issued.body.outcome).toBe('stale');
        gamma = issued.body.invoice as Invoice;
        expectProblem(await records(gamma.id, handling.id), 404, 'not-found');
        expect(await measuredOf(gamma.id)).toBe('2026-09-30');
        await expectEveryLineReconciles(gamma);
        expect(lineOf(gamma, 'storage', '2026-09-01', 'each').quantity).toBe('270'); // 10 × the 4th–30th
      });

      it('a NULL (pre-0063) draft reads as nothing measured — no storage day listed; a refresh with unchanged figures restamps the day; issue keeps it', async () => {
        const storage = lineOf(gamma, 'storage', '2026-09-01', 'each');
        await sql`update client_invoices set storage_measured_through = null where id = ${gamma.id}`;
        const nothing = await walk(gamma.id, storage.id, 1000);
        expect(nothing.all).toEqual([]);
        expect(nothing.first.summary).toEqual({ lineQuantity: '270', recordsQuantity: '0', reconciles: false });
        expectProblem(await breakdown(gamma.id, storage.id, { date: '2026-09-10', warehouseId: wh.w1 }), 404, 'not-found');
        const refreshed = await act(gamma.id, 'refresh').expect(200);
        expect((refreshed.body.invoice as Invoice).lines.map((line) => line.id)).toEqual(gamma.lines.map((line) => line.id));
        expect(await measuredOf(gamma.id)).toBe('2026-09-30');
        await expectEveryLineReconciles(gamma);
        const issued = await act(gamma.id, 'issue').expect(200);
        expect(issued.body.outcome).toBe('issued');
        expect(await measuredOf(gamma.id)).toBe('2026-09-30');
      });
    });

    describe('the refusals', () => {
      it('an unknown invoice or line, a line of another invoice, another tenant → 404; malformed ids → 400', async () => {
        const line = acme29.lines[0]!;
        expectProblem(await records(uuidv7(), line.id), 404, 'not-found');
        expectProblem(await records(acme29.id, uuidv7()), 404, 'not-found');
        expectProblem(await records(acme27.id, line.id), 404, 'not-found');
        expectProblem(await records('not-a-uuid', line.id), 400, 'validation-failed');
        expectProblem(await records(acme29.id, 'nope'), 400, 'validation-failed');
        const other = await register(`Other Co ${ulid()}`);
        expectProblem(await records(acme29.id, line.id, {}, other.ownerToken, other.tenantId), 404, 'not-found');
        expectProblem(await records(acme29.id, line.id, {}, other.ownerToken), 403, 'permission-denied');
      });

      it('a bad cursor → 400 invalid-cursor; a limit outside 1–1,000 → 400 validation-failed', async () => {
        const line = acme29.lines[0]!;
        expectProblem(await records(acme29.id, line.id, { cursor: 'garbage' }), 400, 'invalid-cursor');
        expectProblem(await records(acme29.id, line.id, { cursor: encodeCursor({ createdAt: 'yesterday', id: uuidv7() }) }), 400, 'invalid-cursor');
        expectProblem(await records(acme29.id, line.id, { limit: 0 }), 400, 'validation-failed');
        expectProblem(await records(acme29.id, line.id, { limit: 1001 }), 400, 'validation-failed');
        await records(acme29.id, line.id, { limit: 1000 }).expect(200);
        await records(acme29.id, line.id, { limit: 1 }).expect(200);
      });

      it('a client-portal session → 403, on both routes; every staff role reads', async () => {
        const storage = lineOf(acme29, 'storage', '2026-09-15', 'kg');
        expectProblem(await records(acme29.id, storage.id, {}, portalToken), 403, 'role-denied');
        expectProblem(await breakdown(acme29.id, storage.id, { date: '2026-09-20', warehouseId: wh.w2 }, portalToken), 403, 'role-denied');
        for (const token of [ownerToken, accountantToken, opsToken]) await records(acme29.id, storage.id, {}, token).expect(200);
      });
    });

    it('both routes are in the OpenAPI document', async () => {
      const doc = await http().get('/api/v1/openapi.json').expect(200);
      const paths = Object.keys(doc.body.paths as Record<string, unknown>);
      expect(paths).toContain('/tenants/{tenantId}/client-invoices/{invoiceId}/lines/{lineId}/records');
      expect(paths).toContain('/tenants/{tenantId}/client-invoices/{invoiceId}/lines/{lineId}/storage-breakdown');
    });
  });
});
