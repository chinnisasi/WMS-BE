import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { clientInvoiceLines, clientInvoices } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { encodeCursor, type CursorPayload, type KeysetWindow } from '../../shared/primitives/pagination';
import { addIsoDays, fullPrecisionInstant, istDateOf, istMidnightOf, isIsoDate } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { InboundFacade } from '../inbound/inbound.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import { clientInvoiceSupplierFactsInTx, getMemberClientIdIn, userEmailsInTx } from '../tenancy/tenancy.service';
import {
  clientInvoiceNotFound,
  decodeCursorSafe,
  groupOf,
  portalRefused,
  supplierGroups,
  type ClientInvoiceStatus,
} from './client-invoices';
import { milliToDecimal } from './metering';
import type { ChargeCode } from './rate-cards';

/**
 * Story 21-5b — the dispute drill-down (CAP-7: "both sides can see which
 * events produced each line"). An operator expands any client-invoice line,
 * on an invoice of any status, to the records its quantity was counted from:
 *
 * - `inbound_handling` — each GRN line (`InboundFacade.receiptLineRecordsInTx`);
 * - `pick` — each `picks` row (`OutboundFacade.pickRecordsInTx`);
 * - `outbound_handling` — each order, at its first dispatch
 *   (`InventoryFacade.dispatchedOrderRecordsInTx`);
 * - `storage` — each (day, warehouse) snapshot of the line's base UoM, up to
 *   the invoice's measured-through day (the snapshots are billing's own),
 *   with an on-demand per-SKU breakdown of one day
 *   (`InventoryFacade.clientOnHandBySkuAtInTx`).
 *
 * Every drill reuses its count's ONE predicate (21-4) with 21-5's warehouse
 * filter — the invoice's supplying-GSTIN group, re-resolved from the tenant's
 * warehouses (`supplierGroups` / `groupOf`) — over the line's
 * `[segment_from, segment_to)`. A group that no longer maps to any warehouse
 * answers 409 `invoice-group-changed`, never a silent zero.
 *
 * The first page (no cursor) carries `summary {lineQuantity,
 * recordsQuantity, reconciles}`, computed over the whole predicate in the
 * same transaction, in the line view's units (storage base-unit-days, a
 * whole count otherwise), compared exactly. A mismatch on an issued invoice
 * is the alarm for the residual paths (the 21-2b SKU-correction race, a
 * snapshot rebuild); on a draft it means the draft is out of date.
 *
 * Reads are member-open; a client-portal session is refused (21-7 owns the
 * portal). Reads only — nothing here writes.
 */

export const LINE_RECORDS_DEFAULT_LIMIT = 100;
export const LINE_RECORDS_MAX_LIMIT = 1000;

/** The record kinds, one per charge. */
export const LINE_RECORD_KINDS = ['receipt-line', 'pick', 'order', 'storage-day'] as const;
export type LineRecordKind = (typeof LINE_RECORD_KINDS)[number];

export const RECORD_KIND_OF_CHARGE: Readonly<Record<ChargeCode, LineRecordKind>> = {
  inbound_handling: 'receipt-line',
  pick: 'pick',
  outbound_handling: 'order',
  storage: 'storage-day',
};

/** An order's client-facing reference; the web labels it "Channel ref", falling back to the order id. */
export interface OrderRefView {
  /** `manual` or a channel; null only when the order row is missing. */
  readonly source: string | null;
  /** The channel's event id; null on a manual order (there is no order number yet). */
  readonly externalEventId: string | null;
  readonly orderId: string;
}

export interface ReceiptLineRecordView {
  readonly kind: 'receipt-line';
  readonly id: string;
  readonly grnCode: string;
  readonly poCode: string | null;
  /** The GRN's `recorded_at`, ISO-8601 UTC at full precision. */
  readonly recordedAt: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  /** Base units, a decimal string. */
  readonly qty: string;
  readonly appliedQty: string;
  readonly actorId: string;
  readonly actorEmail: string | null;
}

export interface PickRecordView {
  readonly kind: 'pick';
  readonly id: string;
  /** The pick row's `created_at` (the server clock), ISO-8601 UTC at full precision. */
  readonly pickedAt: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly orderRef: OrderRefView;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly qty: string;
  readonly binCode: string | null;
  readonly actorId: string;
  readonly actorEmail: string | null;
}

export interface OrderRecordView {
  readonly kind: 'order';
  /** The order's first dispatch event (in the window) — the record's identity. */
  readonly id: string;
  readonly dispatchedAt: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly orderRef: OrderRefView;
  /** The order's dispatch events in this window and group (one per order line shipped). */
  readonly lines: number;
  readonly carrierName: string | null;
  readonly trackingNumber: string | null;
  readonly actorId: string;
  readonly actorEmail: string | null;
}

export interface StorageDayRecordView {
  readonly kind: 'storage-day';
  /** The IST day this is the closing stock of. */
  readonly date: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly uom: string;
  /** Base units on hand at the end of the IST day, a decimal string. */
  readonly onHand: string;
}

export type LineRecordView = ReceiptLineRecordView | PickRecordView | OrderRecordView | StorageDayRecordView;

export interface LineRecordsSummary {
  /** The line's quantity, as the line view states it. */
  readonly lineQuantity: string;
  /** The same figure re-derived from every record of the predicate, now. */
  readonly recordsQuantity: string;
  readonly reconciles: boolean;
}

export interface LineRecordsPage {
  readonly kind: LineRecordKind;
  readonly invoiceStatus: ClientInvoiceStatus;
  /** The first page only. */
  readonly summary?: LineRecordsSummary;
  readonly records: readonly LineRecordView[];
  readonly nextCursor: string | null;
}

export interface StorageBreakdownSku {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  /** Signed base units, a decimal string (a negative SKU is kept — it is part of the sum). */
  readonly onHand: string;
}

export interface StorageBreakdownView {
  readonly date: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly uom: string;
  readonly skus: readonly StorageBreakdownSku[];
  /** Σ of the SKUs, base units. */
  readonly total: string;
  /** The day's snapshot, base units — null when the day closed at ≤ 0 (no row is written). */
  readonly snapshotOnHand: string | null;
  readonly reconciles: boolean;
}

export interface LineRecordsQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface StorageBreakdownQuery {
  readonly date: string;
  readonly warehouseId: string;
}

// ── billing's own read: the storage snapshots of a drill ─────────────────────

/** One snapshot row of a storage drill (milli-units as text). */
export interface StorageSnapshotRecordRow {
  readonly date: string;
  readonly warehouseId: string;
  readonly milli: string;
}

/** The storage drill's scope: one client, a set of warehouses, one base UoM, an inclusive IST day range. */
export interface StorageDrillScope {
  readonly tenantId: string;
  readonly clientId: string;
  readonly warehouseIds: readonly string[];
  readonly uom: string;
  readonly fromDay: string;
  readonly throughDay: string;
}

function storageDrillWhere(scope: StorageDrillScope) {
  return sql`ss.tenant_id = ${scope.tenantId}::uuid
    and ss.client_id = ${scope.clientId}::uuid
    and ss.uom = ${scope.uom}
    and ss.warehouse_id = any(${sql.param([...scope.warehouseIds])}::uuid[])
    and ss.snapshot_date >= ${scope.fromDay}::date
    and ss.snapshot_date <= ${scope.throughDay}::date`;
}

/**
 * Story 21-5b — the storage drill's records: one `storage_snapshots` row per
 * (IST day, warehouse) of the line's base UoM in the group, ascending on
 * `(snapshot_date, warehouse_id)` (the cursor carries `istMidnightOf(date)`
 * and the warehouse id), keyset-paged after `window.after`. The quantity
 * column is `mode: 'number'` in the schema — read as `::text` here.
 */
export async function storageSnapshotRecordsInTx(tx: TenantTx, scope: StorageDrillScope, window: KeysetWindow): Promise<StorageSnapshotRecordRow[]> {
  if (scope.warehouseIds.length === 0 || scope.throughDay < scope.fromDay) return [];
  const after =
    window.after === null
      ? sql``
      : sql`and (ss.snapshot_date, ss.warehouse_id) > (${istDateOf(window.after.createdAt)}::date, ${window.after.id}::uuid)`;
  const rows = (await tx.execute(sql`
    select ss.snapshot_date::text as "date", ss.warehouse_id as "warehouseId", ss.on_hand_milli::text as "milli"
    from storage_snapshots ss
    where ${storageDrillWhere(scope)}
      ${after}
    order by ss.snapshot_date, ss.warehouse_id
    limit ${window.limit}
  `)) as unknown as StorageSnapshotRecordRow[];
  return rows.map((row) => ({ ...row }));
}

/** Σ of the storage drill's snapshots, milli-unit-days (BigInt — a month can pass 2⁵³). */
export async function storageSnapshotSumInTx(tx: TenantTx, scope: StorageDrillScope): Promise<bigint> {
  if (scope.warehouseIds.length === 0 || scope.throughDay < scope.fromDay) return 0n;
  const rows = (await tx.execute(sql`
    select coalesce(sum(ss.on_hand_milli), 0)::text as "milli"
    from storage_snapshots ss
    where ${storageDrillWhere(scope)}
  `)) as unknown as { milli: string }[];
  return BigInt(rows[0]?.milli ?? '0');
}

// ── the service ──────────────────────────────────────────────────────────────

/** The line a drill addresses, its invoice, and the invoice's (re-resolved) group. */
interface DrillTarget {
  readonly invoice: {
    readonly id: string;
    readonly clientId: string;
    readonly status: ClientInvoiceStatus;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly storageMeasuredThrough: string | null;
  };
  readonly line: {
    readonly chargeCode: ChargeCode;
    readonly uom: string | null;
    /** IST-midnight instants, ISO-8601 UTC, `[from, to)`. */
    readonly segmentFrom: string;
    readonly segmentTo: string;
    /** The stored bigint as text (milli-unit-days for storage, a count otherwise). */
    readonly quantity: string;
  };
  readonly warehouseIds: readonly string[];
  readonly warehouseCodes: ReadonlyMap<string, string>;
}

/** A storage line's inclusive IST day range: its segment, up to the invoice's measured-through day. */
export function storageDays(
  line: Pick<DrillTarget['line'], 'segmentFrom' | 'segmentTo'>,
  invoice: Pick<DrillTarget['invoice'], 'storageMeasuredThrough' | 'periodStart' | 'periodEnd' | 'status'>,
): { fromDay: string; throughDay: string } {
  const fromDay = istDateOf(line.segmentFrom);
  const lastDay = addIsoDays(istDateOf(line.segmentTo), -1);
  // NULL = stored before 0063. On a non-draft invoice that is period_end
  // (issue already required storage complete through it); on a draft
  // nothing is known to be measured, so nothing is listed (period_start − 1)
  // — a refresh records the real day. Every post-0063 compute stores a date.
  const measured = invoice.storageMeasuredThrough ?? (invoice.status === 'draft' ? addIsoDays(invoice.periodStart, -1) : invoice.periodEnd);
  return { fromDay, throughDay: measured < lastDay ? measured : lastDay };
}

function lineNotFound(lineId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Invoice line not found', `No line with id "${lineId}" on this client invoice — a draft's lines are rewritten when it is refreshed; reload the invoice.`);
}

function validation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid request', detail);
}

@Injectable()
export class InvoiceRecordsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(InboundFacade) private readonly inbound: InboundFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
  ) {}

  /** One keyset page of a line's records; the first page carries the reconciliation summary. */
  async lineRecords(tenantId: string, actorUserId: string, invoiceId: string, lineId: string, query: LineRecordsQuery = {}): Promise<LineRecordsPage> {
    const limit = query.limit ?? LINE_RECORDS_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > LINE_RECORDS_MAX_LIMIT) {
      throw validation(`limit must be a whole number from 1 to ${LINE_RECORDS_MAX_LIMIT} (got ${limit}).`);
    }
    const after: CursorPayload | null = query.cursor === undefined ? null : decodeCursorSafe(query.cursor);
    const firstPage = query.cursor === undefined;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) throw portalRefused();
      const target = await this.targetInTx(tx, tenantId, invoiceId, lineId);
      const { invoice, line } = target;
      const kind = RECORD_KIND_OF_CHARGE[line.chargeCode];
      const window: KeysetWindow = { after, limit: limit + 1 };
      const scope = { tenantId, clientId: invoice.clientId, warehouseIds: target.warehouseIds };
      const codeOf = (warehouseId: string): string => target.warehouseCodes.get(warehouseId) ?? warehouseId;

      let records: LineRecordView[];
      let cursors: CursorPayload[];
      let recordsMilli: bigint | null = null;
      let recordsCount: number | null = null;

      switch (line.chargeCode) {
        case 'inbound_handling': {
          const rows = await this.inbound.receiptLineRecordsInTx(tx, scope, line.segmentFrom, line.segmentTo, window);
          const emails = await userEmailsInTx(tx, tenantId, rows.map((row) => row.actorId));
          records = rows.map((row) => ({
            kind: 'receipt-line',
            id: row.id,
            grnCode: row.grnCode,
            poCode: row.poCode,
            recordedAt: fullPrecisionInstant(row.recordedAt),
            warehouseId: row.warehouseId,
            warehouseCode: codeOf(row.warehouseId),
            skuId: row.skuId,
            skuCode: row.skuCode,
            skuName: row.skuName,
            qty: milliToDecimal(BigInt(row.qtyMilli)),
            appliedQty: milliToDecimal(BigInt(row.appliedQtyMilli)),
            actorId: row.actorId,
            actorEmail: emails.get(row.actorId) ?? null,
          }));
          cursors = rows.map((row) => ({ createdAt: fullPrecisionInstant(row.recordedAt), id: row.id }));
          if (firstPage) recordsCount = await this.inbound.countReceiptLinesInTx(tx, scope, line.segmentFrom, line.segmentTo);
          break;
        }
        case 'pick': {
          const rows = await this.outbound.pickRecordsInTx(tx, scope, line.segmentFrom, line.segmentTo, window);
          const emails = await userEmailsInTx(tx, tenantId, rows.map((row) => row.actorId));
          records = rows.map((row) => ({
            kind: 'pick',
            id: row.id,
            pickedAt: fullPrecisionInstant(row.createdAt),
            warehouseId: row.warehouseId,
            warehouseCode: codeOf(row.warehouseId),
            orderRef: { source: row.orderSource, externalEventId: row.orderExternalEventId, orderId: row.orderId },
            skuId: row.skuId,
            skuCode: row.skuCode,
            skuName: row.skuName,
            qty: milliToDecimal(BigInt(row.qtyMilli)),
            binCode: row.binCode,
            actorId: row.actorId,
            actorEmail: emails.get(row.actorId) ?? null,
          }));
          cursors = rows.map((row) => ({ createdAt: fullPrecisionInstant(row.createdAt), id: row.id }));
          if (firstPage) recordsCount = await this.outbound.countPicksInTx(tx, scope, line.segmentFrom, line.segmentTo);
          break;
        }
        case 'outbound_handling': {
          const rows = await this.inventory.dispatchedOrderRecordsInTx(tx, scope, line.segmentFrom, line.segmentTo, window);
          const emails = await userEmailsInTx(tx, tenantId, rows.map((row) => row.actorId));
          const refs = await this.outbound.orderRefsInTx(tx, tenantId, rows.map((row) => row.orderId));
          records = rows.map((row) => {
            const ref = refs.get(row.orderId);
            return {
              kind: 'order',
              id: row.eventId,
              dispatchedAt: fullPrecisionInstant(row.recordedAt),
              warehouseId: row.warehouseId,
              warehouseCode: codeOf(row.warehouseId),
              orderRef: { source: ref?.source ?? null, externalEventId: ref?.externalEventId ?? null, orderId: row.orderId },
              lines: row.lines,
              carrierName: row.carrierName,
              trackingNumber: row.trackingNumber,
              actorId: row.actorId,
              actorEmail: emails.get(row.actorId) ?? null,
            };
          });
          cursors = rows.map((row) => ({ createdAt: fullPrecisionInstant(row.recordedAt), id: row.eventId }));
          if (firstPage) recordsCount = await this.inventory.countDispatchedOrdersInTx(tx, scope, line.segmentFrom, line.segmentTo);
          break;
        }
        case 'storage': {
          const days = storageDays(line, invoice);
          const drill: StorageDrillScope = { ...scope, uom: line.uom ?? '', ...days };
          const rows = await storageSnapshotRecordsInTx(tx, drill, window);
          records = rows.map((row) => ({
            kind: 'storage-day',
            date: row.date,
            warehouseId: row.warehouseId,
            warehouseCode: codeOf(row.warehouseId),
            uom: drill.uom,
            onHand: milliToDecimal(BigInt(row.milli)),
          }));
          cursors = rows.map((row) => ({ createdAt: istMidnightOf(row.date), id: row.warehouseId }));
          if (firstPage) recordsMilli = await storageSnapshotSumInTx(tx, drill);
          break;
        }
      }

      const hasMore = records.length > limit;
      const page = hasMore ? records.slice(0, limit) : records;
      const nextCursor = hasMore ? encodeCursor(cursors[limit - 1]!) : null;

      let summary: LineRecordsSummary | undefined;
      if (firstPage) {
        if (line.chargeCode === 'storage') {
          const lineMilli = BigInt(line.quantity);
          const got = recordsMilli ?? 0n;
          summary = { lineQuantity: milliToDecimal(lineMilli), recordsQuantity: milliToDecimal(got), reconciles: got === lineMilli };
        } else {
          const got = BigInt(recordsCount ?? 0);
          summary = { lineQuantity: line.quantity, recordsQuantity: got.toString(), reconciles: got === BigInt(line.quantity) };
        }
      }
      return { kind, invoiceStatus: invoice.status, ...(summary === undefined ? {} : { summary }), records: page, nextCursor };
    });
  }

  /**
   * One storage day's per-SKU breakdown: allowed only on a storage line, for
   * a date inside its measured segment and a warehouse in its group (else
   * 404); a malformed date or warehouse id is 400. The fold from genesis to
   * the end of the day on the line's base UoM, per SKU (non-zero, negatives
   * kept), beside the day's snapshot — Σ SKUs = snapshot, or ≤ 0 when the
   * day wrote no snapshot.
   */
  async storageBreakdown(
    tenantId: string,
    actorUserId: string,
    invoiceId: string,
    lineId: string,
    query: StorageBreakdownQuery,
  ): Promise<StorageBreakdownView> {
    if (typeof query.date !== 'string' || !isIsoDate(query.date)) {
      throw validation(`date must be a real calendar date YYYY-MM-DD (got ${JSON.stringify(query.date)}).`);
    }
    if (typeof query.warehouseId !== 'string' || !UUID_RE.test(query.warehouseId)) {
      throw validation(`warehouseId must be a uuid (got ${JSON.stringify(query.warehouseId)}).`);
    }
    const { date, warehouseId } = query;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) throw portalRefused();
      const target = await this.targetInTx(tx, tenantId, invoiceId, lineId);
      const { invoice, line } = target;
      const notHere = (why: string) =>
        new ProblemException('not-found', 404, 'No storage day to break down', `${why} — a breakdown is of one measured day of a storage line, in a warehouse of its invoice.`);
      if (line.chargeCode !== 'storage' || line.uom === null) throw notHere('This line is not a storage line');
      const days = storageDays(line, invoice);
      if (date < days.fromDay || date > days.throughDay) {
        throw notHere(`${date} is outside the line's measured days (${days.fromDay} – ${days.throughDay})`);
      }
      if (!target.warehouseIds.includes(warehouseId)) throw notHere('That warehouse is not one this invoice bills');

      const skus = await this.inventory.clientOnHandBySkuAtInTx(
        tx,
        { tenantId, clientId: invoice.clientId, warehouseId },
        line.uom,
        istMidnightOf(addIsoDays(date, 1)),
      );
      const snapshot = (await tx.execute(sql`
        select ss.on_hand_milli::text as "milli"
        from storage_snapshots ss
        where ss.tenant_id = ${tenantId}::uuid and ss.client_id = ${invoice.clientId}::uuid
          and ss.warehouse_id = ${warehouseId}::uuid and ss.snapshot_date = ${date}::date and ss.uom = ${line.uom}
      `)) as unknown as { milli: string }[];
      const snapshotMilli = snapshot[0] === undefined ? null : BigInt(snapshot[0].milli);
      const total = skus.reduce((sum, row) => sum + row.milli, 0n);
      return {
        date,
        warehouseId,
        warehouseCode: target.warehouseCodes.get(warehouseId) ?? warehouseId,
        uom: line.uom,
        skus: skus.map((row) => ({ skuId: row.skuId, skuCode: row.skuCode, skuName: row.skuName, onHand: milliToDecimal(row.milli) })),
        total: milliToDecimal(total),
        snapshotOnHand: snapshotMilli === null ? null : milliToDecimal(snapshotMilli),
        // A day that closed at ≤ 0 writes no snapshot (the projection's rule).
        reconciles: snapshotMilli === null ? total <= 0n : total === snapshotMilli,
      };
    });
  }

  /**
   * The invoice (404), the line ON it (404 — a draft's line ids change on
   * refresh), and the invoice's supplying-GSTIN group re-resolved from the
   * tenant's warehouses — empty → 409 `invoice-group-changed`.
   */
  private async targetInTx(tx: TenantTx, tenantId: string, invoiceId: string, lineId: string): Promise<DrillTarget> {
    if (!UUID_RE.test(invoiceId)) throw clientInvoiceNotFound(invoiceId);
    if (!UUID_RE.test(lineId)) throw lineNotFound(lineId);
    const invoices = await tx
      .select({
        id: clientInvoices.id,
        clientId: clientInvoices.clientId,
        status: clientInvoices.status,
        periodStart: clientInvoices.periodStart,
        periodEnd: clientInvoices.periodEnd,
        supplierGstin: clientInvoices.supplierGstin,
        storageMeasuredThrough: clientInvoices.storageMeasuredThrough,
      })
      .from(clientInvoices)
      .where(and(eq(clientInvoices.tenantId, tenantId), eq(clientInvoices.id, invoiceId)))
      .limit(1);
    const invoice = invoices[0];
    if (invoice === undefined) throw clientInvoiceNotFound(invoiceId);
    const lines = await tx
      .select({
        chargeCode: clientInvoiceLines.chargeCode,
        uom: clientInvoiceLines.uom,
        segmentFrom: clientInvoiceLines.segmentFrom,
        segmentTo: clientInvoiceLines.segmentTo,
        quantity: sql<string>`${clientInvoiceLines.quantity}::text`,
      })
      .from(clientInvoiceLines)
      .where(and(eq(clientInvoiceLines.tenantId, tenantId), eq(clientInvoiceLines.invoiceId, invoice.id), eq(clientInvoiceLines.id, lineId)))
      .limit(1);
    const line = lines[0];
    if (line === undefined) throw lineNotFound(lineId);

    const facts = await clientInvoiceSupplierFactsInTx(tx, tenantId);
    const group = groupOf(supplierGroups(facts), invoice.supplierGstin);
    if (group.warehouses.length === 0) {
      throw new ProblemException(
        'invoice-group-changed',
        409,
        'The invoice’s registration no longer maps to a warehouse',
        `No warehouse invoices under ${invoice.supplierGstin ?? 'this invoice’s (missing) registration'} any more, so this line’s records cannot be selected — the drill never shows a silent zero.`,
      );
    }
    return {
      invoice: {
        id: invoice.id,
        clientId: invoice.clientId,
        status: invoice.status as ClientInvoiceStatus,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        storageMeasuredThrough: invoice.storageMeasuredThrough,
      },
      line: {
        chargeCode: line.chargeCode as ChargeCode,
        uom: line.uom,
        segmentFrom: new Date(line.segmentFrom).toISOString(),
        segmentTo: new Date(line.segmentTo).toISOString(),
        quantity: line.quantity,
      },
      warehouseIds: group.warehouses.map((warehouse) => warehouse.id),
      warehouseCodes: new Map(facts.warehouses.map((warehouse) => [warehouse.id, warehouse.code])),
    };
  }
}
