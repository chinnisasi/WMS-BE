import type { TenantTx } from '../../shared/db/tenant-scope';
import { rearmTxDeadline } from '../../shared/db/tx-deadline';
import type { ExportCell, ExportColumn } from '../../shared/export/cells';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { istDateOf, istMidnightOf } from '../../shared/primitives/time';
import { getClientsInTx } from '../clients/clients.facade';
import type { CatalogFacade } from '../catalog/catalog.facade';
import type { InboundFacade } from '../inbound/inbound.facade';
import type { InventoryFacade, LedgerReferenceDoc } from '../inventory/inventory.facade';
import type { OutboundFacade } from '../outbound/outbound.facade';
import { memberDisplayNamesInTx } from '../tenancy/tenancy.service';

/**
 * Story 5-3a — the operational registers: stock on hand, inbound, outbound,
 * the ledger and batch ageing / near expiry, as client-filtered CSV or Excel
 * files behind ONE read-only route (`GET …/warehouses/{w}/reports/{report}`).
 *
 * This file is the REGISTRY: per register, its columns (the header golden is
 * `test/registers.spec.ts`), its period rule, and its read. Every row comes
 * from a read on the OWNING module's facade (AD-6 — unlike the tiles, the
 * registers are not a read-model exception): inventory (stock, ageing, the
 * ledger, the first dispatch of an order), inbound (GRN lines, GRN codes),
 * outbound (order lines), catalog (batch facts) and tenancy (actor display
 * names — never an email). Reporting owns the route, this registry, the
 * writers' composition, the slots and the deadline (`reporting.facade.ts`).
 *
 * Quantities are BASE units in the SKU's precision, written as numbers.
 * Instants are IST wall clock (`_ist` columns), calendar dates IST dates.
 */

export const REGISTER_NAMES = ['stock-on-hand', 'inbound-register', 'outbound-register', 'ledger', 'batch-ageing'] as const;
export type RegisterName = (typeof REGISTER_NAMES)[number];

export const REGISTER_FORMATS = ['csv', 'xlsx'] as const;
export type RegisterFormat = (typeof REGISTER_FORMATS)[number];

/** The most rows one synchronous register answers; the 50,001st is 422 `report-too-large` (decision 2). */
export const REGISTER_MAX_ROWS = 50_000;
/** The WHOLE read's budget — re-armed before every statement; past it, 503 `report-unavailable`. */
export const REGISTER_DEADLINE_MS = 15_000;
/** Register reads in flight at once IN THE PROCESS; a third is 503 before it reads. */
export const REGISTER_CONCURRENCY = 2;

/** `dated`: a required inclusive IST period; `as-of-now`: no period (a snapshot). */
export type RegisterPeriodRule = 'dated' | 'as-of-now';

/** The facades a register reads through. */
export interface RegisterSources {
  readonly inventory: InventoryFacade;
  readonly inbound: InboundFacade;
  readonly outbound: OutboundFacade;
  readonly catalog: CatalogFacade;
}

export interface RegisterContext {
  readonly name: RegisterName;
  readonly tx: TenantTx;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly clientId: string | null;
  /** `[from, to)` instants for a dated register; null for a snapshot. */
  readonly window: { readonly from: string; readonly to: string } | null;
  readonly now: Date;
  /** The row cap (`REGISTER_MAX_ROWS` in production). */
  readonly maxRows: number;
  /** The read stops at this many rows (the cap + 1, so an overflow is visible). */
  readonly limit: number;
  readonly sources: RegisterSources;
}

export interface RegisterDefinition {
  readonly name: RegisterName;
  readonly period: RegisterPeriodRule;
  readonly columns: readonly ExportColumn[];
  read(ctx: RegisterContext): Promise<ExportCell[][]>;
}

function text(header: string): ExportColumn {
  return { header, kind: 'text' };
}
function number(header: string): ExportColumn {
  return { header, kind: 'number' };
}
function instant(header: string): ExportColumn {
  return { header, kind: 'instant' };
}
function date(header: string): ExportColumn {
  return { header, kind: 'date' };
}

function at(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

const DAY_MS = 86_400_000;

/** Whole IST calendar days (over INSTANTS — renamed 4-3a, A21, so it never shares a name with the date-taking `istDaysBetween`) from `fromInstant`'s IST date to `toInstant`'s (negative when `to` is earlier). */
function istDaysBetweenInstants(fromInstant: string, toInstant: string): number {
  return Math.round((Date.parse(`${istDateOf(toInstant)}T00:00:00Z`) - Date.parse(`${istDateOf(fromInstant)}T00:00:00Z`)) / DAY_MS);
}

async function clientCodesInTx(tx: TenantTx, tenantId: string, clientIds: readonly string[]): Promise<Map<string, string>> {
  await rearmTxDeadline(tx);
  const facts = await getClientsInTx(tx, tenantId, [...new Set(clientIds)]);
  return new Map([...facts].map(([id, row]) => [id, row.code]));
}

/**
 * The 50,001st row is a 422 — checked as soon as the facade read returns,
 * before any lookup, so an oversized register costs one read and no file.
 */
export function assertWithinCap(name: RegisterName, rows: number, maxRows: number): void {
  if (rows > maxRows) {
    // A snapshot register has no period to shorten — only a client narrows it.
    const advice = REGISTERS[name].period === 'dated' ? 'pick a client or a shorter period' : 'pick a client';
    throw new ProblemException(
      'report-too-large',
      422,
      'Register too large',
      `The ${name} register has more than ${maxRows.toLocaleString('en-IN')} rows — ${advice}.`,
      { maxRows },
    );
  }
}

function requireWindow(ctx: RegisterContext): { from: string; to: string } {
  if (ctx.window === null) throw new Error(`register read without its window`);
  return ctx.window;
}

// ── stock on hand ────────────────────────────────────────────────────────────

const STOCK_COLUMNS: readonly ExportColumn[] = [
  text('warehouse'),
  text('zone'),
  text('bin'),
  text('system_bin'),
  text('sku_code'),
  text('sku_name'),
  text('hsn'),
  text('client_code'),
  text('uom'),
  text('batch_code'),
  date('expiry_date'),
  number('quantity'),
];

const stockOnHand: RegisterDefinition = {
  name: 'stock-on-hand',
  period: 'as-of-now',
  columns: STOCK_COLUMNS,
  async read(ctx) {
    const rows = await ctx.sources.inventory.stockOnHandRegisterInTx(
      ctx.tx,
      { tenantId: ctx.tenantId, warehouseId: ctx.warehouseId, clientId: ctx.clientId },
      ctx.limit,
    );
    assertWithinCap(ctx.name, rows.length, ctx.maxRows);
    const batches = await ctx.sources.catalog.batchFactsByIdsInTx(
      ctx.tx,
      ctx.tenantId,
      rows.flatMap((row) => (row.batchId === null ? [] : [row.batchId])),
    );
    const clients = await clientCodesInTx(ctx.tx, ctx.tenantId, rows.map((row) => row.clientId));
    return rows.map((row) => {
      const batch = row.batchId === null ? undefined : batches.get(row.batchId);
      return [
        ctx.warehouseCode,
        row.zoneCode,
        row.binCode,
        row.systemBin ? 'yes' : 'no',
        row.skuCode,
        row.skuName,
        row.hsn,
        clients.get(row.clientId) ?? null,
        row.uom,
        batch?.code ?? null,
        at(batch?.expiryDate ?? null),
        row.quantity,
      ];
    });
  },
};

// ── inbound register ─────────────────────────────────────────────────────────

const INBOUND_COLUMNS: readonly ExportColumn[] = [
  text('grn_code'),
  instant('created_ist'),
  instant('recorded_ist'),
  text('document'),
  text('vendor_name'),
  text('client_code'),
  text('gate_in_code'),
  text('supplier_documents'),
  text('supplier_document_dates'),
  text('eway_bill_numbers'),
  text('sku_code'),
  text('sku_name'),
  text('uom'),
  text('batch_code'),
  number('qty'),
  number('applied_qty'),
  text('recorded_by'),
];

const inboundRegister: RegisterDefinition = {
  name: 'inbound-register',
  period: 'dated',
  columns: INBOUND_COLUMNS,
  async read(ctx) {
    const window = requireWindow(ctx);
    const rows = await ctx.sources.inbound.inboundRegisterInTx(
      ctx.tx,
      { tenantId: ctx.tenantId, warehouseId: ctx.warehouseId, clientId: ctx.clientId, from: window.from, to: window.to },
      ctx.limit,
    );
    assertWithinCap(ctx.name, rows.length, ctx.maxRows);
    const batches = await ctx.sources.catalog.batchFactsByIdsInTx(
      ctx.tx,
      ctx.tenantId,
      rows.flatMap((row) => (row.batchId === null ? [] : [row.batchId])),
    );
    const clients = await clientCodesInTx(ctx.tx, ctx.tenantId, rows.map((row) => row.clientId));
    const names = await memberDisplayNamesInTx(ctx.tx, ctx.tenantId, rows.map((row) => row.recordedBy));
    return rows.map((row) => [
      row.grnCode,
      at(row.createdAt),
      at(row.recordedAt),
      row.document,
      row.vendorName,
      clients.get(row.clientId) ?? null,
      row.gateInCode,
      row.supplierDocuments,
      row.supplierDocumentDates,
      row.ewayBillNumbers,
      row.skuCode,
      row.skuName,
      row.uom,
      row.batchId === null ? null : (batches.get(row.batchId)?.code ?? null),
      row.qty,
      row.appliedQty,
      names.get(row.recordedBy) ?? null,
    ]);
  },
};

// ── outbound register ────────────────────────────────────────────────────────

const OUTBOUND_COLUMNS: readonly ExportColumn[] = [
  text('order_id'),
  instant('created_ist'),
  text('status'),
  text('source'),
  text('channel_order_ref'),
  text('client_code'),
  text('consignee_legal_name'),
  text('consignee_gstin'),
  text('destination_city'),
  text('destination_state'),
  text('destination_pincode'),
  text('sku_code'),
  text('sku_name'),
  text('kit_of'),
  text('uom'),
  number('ordered_qty'),
  instant('first_dispatched_ist'),
  text('carrier'),
  text('awb'),
  // Story 4-1b — the client's own order number (blank when none), appended
  // LAST so every existing column keeps its position for file consumers.
  text('client_order_ref'),
  // Story 4-2a (A20) — the order header fields, appended at the END (every
  // earlier position unchanged). ORDER-level: each is repeated on every line
  // of a multi-line order — `cod_amount_paise` (integer paise, blank when
  // prepaid) is the order's amount once, never a per-line figure to sum.
  text('order_type'),
  text('priority'),
  date('ship_by_date'),
  number('cod_amount_paise'),
];

const outboundRegister: RegisterDefinition = {
  name: 'outbound-register',
  period: 'dated',
  columns: OUTBOUND_COLUMNS,
  async read(ctx) {
    const window = requireWindow(ctx);
    const rows = await ctx.sources.outbound.outboundRegisterInTx(
      ctx.tx,
      { tenantId: ctx.tenantId, warehouseId: ctx.warehouseId, clientId: ctx.clientId, from: window.from, to: window.to },
      ctx.limit,
    );
    assertWithinCap(ctx.name, rows.length, ctx.maxRows);
    const dispatches = await ctx.sources.inventory.firstDispatchByOrderInTx(ctx.tx, ctx.tenantId, rows.map((row) => row.orderId));
    const clients = await clientCodesInTx(ctx.tx, ctx.tenantId, rows.map((row) => row.clientId));
    return rows.map((row) => {
      const dispatch = dispatches.get(row.orderId);
      return [
        row.orderId,
        at(row.createdAt),
        row.status,
        row.source,
        row.channelOrderRef,
        clients.get(row.clientId) ?? null,
        row.consigneeLegalName,
        row.consigneeGstin,
        row.destinationCity,
        row.destinationState,
        row.destinationPincode,
        row.skuCode,
        row.skuName,
        row.kitOf,
        row.uom,
        row.quantity,
        at(dispatch?.dispatchedAt ?? null),
        ...carrierPair(dispatch, row),
        row.clientOrderRef,
        row.orderType,
        row.priority,
        // An IST calendar date — the date cell prints the IST date of its
        // instant, so the IST midnight that begins it.
        row.shipByDate === null ? null : new Date(istMidnightOf(row.shipByDate)),
        row.codAmountPaise,
      ];
    });
  },
};

/** '' is absent — a blank carrier field is no carrier. */
function present(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === '' ? null : value;
}

/**
 * Carrier and AWB as a PAIR: the first dispatch event's reference when it
 * named either, else the latest shipment's — never one from each source.
 */
function carrierPair(
  dispatch: { carrierName: string | null; trackingNumber: string | null } | undefined,
  row: { shipmentCarrier: string | null; shipmentTracking: string | null },
): [string | null, string | null] {
  const carrier = present(dispatch?.carrierName);
  const awb = present(dispatch?.trackingNumber);
  if (carrier !== null || awb !== null) return [carrier, awb];
  return [present(row.shipmentCarrier), present(row.shipmentTracking)];
}

// ── the ledger ───────────────────────────────────────────────────────────────

const LEDGER_COLUMNS: readonly ExportColumn[] = [
  instant('created_ist'),
  instant('recorded_ist'),
  instant('occurred_ist'),
  text('type'),
  text('sku_code'),
  text('client_code'),
  text('uom'),
  text('from_bin'),
  text('to_bin'),
  text('batch_code'),
  number('quantity'),
  text('reference'),
  text('actor'),
];

/**
 * A one-line summary of an event's reference document. An EXHAUSTIVE switch
 * over the `LedgerReferenceDoc` union (a new arm is a compile error here
 * until it is summarised); a stored kind this build does not know — a
 * legacy row, a newer writer — prints its kind, never throws.
 */
export function referenceSummary(doc: LedgerReferenceDoc, grnCodes: ReadonlyMap<string, string>): string {
  if (typeof doc !== 'object' || doc === null) return 'unknown';
  const grn = (id: string): string => `GRN ${grnCodes.get(id) ?? id}`;
  switch (doc.kind) {
    case 'manual-adjustment':
      return `adjustment ${doc.reasonCode}${doc.note === '' ? '' : ` — ${doc.note}`}`;
    case 'grn-receipt':
      return `receipt ${grn(doc.grnId)}`;
    case 'qc-hold':
      return `QC hold ${doc.holdId}`;
    case 'putaway':
      return `putaway ${grn(doc.grnId)}`;
    case 'bin-merge':
      return `bin merge ${doc.mergeId}`;
    // Story 3-1's reference kind (#118). 5-3a's exhaustive switch (#121) was
    // written before 3-1 merged, so main failed `tsc` on the merge of the two.
    case 'bin-move':
      return `bin move ${doc.moveId}`;
    case 'pick':
      return `pick order ${doc.orderId}${doc.shortPick === true ? ' (short)' : ''}`;
    case 'pack':
      return `pack order ${doc.orderId}`;
    case 'dispatch': {
      const carrier = [doc.carrierName, doc.trackingNumber].filter((part): part is string => typeof part === 'string' && part !== '');
      return `dispatch order ${doc.orderId}${carrier.length === 0 ? '' : ` · ${carrier.join(' ')}`}`;
    }
    case 'excursion':
      return `excursion ${doc.readingC} °C`;
    case 'transfer':
      return `transfer ${doc.transferId}`;
    case 'return-receipt':
      return `return ${doc.rmaId}`;
    default: {
      const unknown: never = doc;
      const kind = (unknown as { kind?: unknown }).kind;
      return typeof kind === 'string' ? kind : 'unknown';
    }
  }
}

const ledger: RegisterDefinition = {
  name: 'ledger',
  period: 'dated',
  columns: LEDGER_COLUMNS,
  async read(ctx) {
    const window = requireWindow(ctx);
    const rows = await ctx.sources.inventory.ledgerRegisterInTx(
      ctx.tx,
      { tenantId: ctx.tenantId, warehouseId: ctx.warehouseId, clientId: ctx.clientId, from: window.from, to: window.to },
      ctx.limit,
    );
    assertWithinCap(ctx.name, rows.length, ctx.maxRows);
    const grnIds = rows.flatMap((row) =>
      row.referenceDoc !== null && typeof row.referenceDoc === 'object' && (row.referenceDoc.kind === 'grn-receipt' || row.referenceDoc.kind === 'putaway')
        ? [row.referenceDoc.grnId]
        : [],
    );
    const grnCodes = await ctx.sources.inbound.grnCodesByIdsInTx(ctx.tx, ctx.tenantId, grnIds);
    const batches = await ctx.sources.catalog.batchFactsByIdsInTx(
      ctx.tx,
      ctx.tenantId,
      rows.flatMap((row) => (row.batchId === null ? [] : [row.batchId])),
    );
    const clients = await clientCodesInTx(ctx.tx, ctx.tenantId, rows.map((row) => row.clientId));
    const names = await memberDisplayNamesInTx(ctx.tx, ctx.tenantId, rows.map((row) => row.actorUserId));
    return rows.map((row) => [
      at(row.createdAt),
      at(row.recordedAt),
      at(row.occurredAt),
      row.type,
      row.skuCode,
      clients.get(row.clientId) ?? null,
      row.uom,
      row.fromBinCode,
      row.toBinCode,
      row.batchId === null ? null : (batches.get(row.batchId)?.code ?? row.batchId),
      row.quantity,
      referenceSummary(row.referenceDoc, grnCodes),
      names.get(row.actorUserId) ?? null,
    ]);
  },
};

// ── batch ageing / near expiry ───────────────────────────────────────────────

const AGEING_COLUMNS: readonly ExportColumn[] = [
  text('sku_code'),
  text('sku_name'),
  text('client_code'),
  text('bin'),
  text('batch_code'),
  date('mfg_date'),
  date('expiry_date'),
  number('days_to_expiry'),
  instant('batch_created_ist'),
  number('days_since_batch_created'),
  text('uom'),
  number('quantity'),
];

const batchAgeing: RegisterDefinition = {
  name: 'batch-ageing',
  period: 'as-of-now',
  columns: AGEING_COLUMNS,
  async read(ctx) {
    const rows = await ctx.sources.inventory.batchAgeingRegisterInTx(
      ctx.tx,
      { tenantId: ctx.tenantId, warehouseId: ctx.warehouseId, clientId: ctx.clientId },
      ctx.limit,
    );
    assertWithinCap(ctx.name, rows.length, ctx.maxRows);
    const batches = await ctx.sources.catalog.batchFactsByIdsInTx(ctx.tx, ctx.tenantId, rows.map((row) => row.batchId));
    const clients = await clientCodesInTx(ctx.tx, ctx.tenantId, rows.map((row) => row.clientId));
    const now = ctx.now.toISOString();
    const enriched = rows.map((row) => ({ row, batch: batches.get(row.batchId) }));
    // Expiry ascending, no expiry last; then SKU, bin, batch code — a stable, total order.
    enriched.sort((a, b) => {
      const ea = a.batch?.expiryDate ?? null;
      const eb = b.batch?.expiryDate ?? null;
      if (ea !== eb) {
        if (ea === null) return 1;
        if (eb === null) return -1;
        return ea < eb ? -1 : 1;
      }
      return (
        compareText(a.row.skuCode, b.row.skuCode) ||
        compareText(a.row.binCode, b.row.binCode) ||
        compareText(a.batch?.code ?? a.row.batchId, b.batch?.code ?? b.row.batchId)
      );
    });
    return enriched.map(({ row, batch }) => [
      row.skuCode,
      row.skuName,
      clients.get(row.clientId) ?? null,
      row.binCode,
      batch?.code ?? null,
      at(batch?.mfgDate ?? null),
      at(batch?.expiryDate ?? null),
      batch === undefined || batch.expiryDate === null ? null : istDaysBetweenInstants(now, batch.expiryDate),
      at(batch?.createdAt ?? null),
      batch === undefined ? null : istDaysBetweenInstants(batch.createdAt, now),
      row.uom,
      row.quantity,
    ]);
  },
};

/** Byte order, like the SQL's `COLLATE "C"`. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const REGISTERS: Readonly<Record<RegisterName, RegisterDefinition>> = {
  'stock-on-hand': stockOnHand,
  'inbound-register': inboundRegister,
  'outbound-register': outboundRegister,
  ledger,
  'batch-ageing': batchAgeing,
};

// ── the shape rules (above the slot and the transaction) ─────────────────────

export function invalidRegisterQuery(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid register request', detail);
}

export function isRegisterName(value: string): value is RegisterName {
  return (REGISTER_NAMES as readonly string[]).includes(value);
}

/** The XLSX content type (the OpenAPI `@ApiProduces` names it too). */
export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/** The process-wide register slots — `tryAcquire` never waits: full means 503 before any read. */
export class RegisterSlots {
  private active = 0;

  constructor(readonly capacity: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.capacity) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }

  get inFlight(): number {
    return this.active;
  }
}
