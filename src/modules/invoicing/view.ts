import type { Invoice, InvoiceLine } from '../../shared/db/schema';
import { canonicalInstant } from '../../shared/primitives/time';
import type { InvoiceStatus, InvoiceDocument, GapKind, RateSource } from './generator';

/**
 * The invoicing read shapes (story 8-1). Deliberately separate from the
 * generator's computation types: the views are what the facade serves (and
 * what 21-5's billing reader will compose); the computation's drafts never
 * leave the module.
 */

export const INVOICE_LIST_DEFAULT_PAGE_SIZE = 50;
export const INVOICE_LIST_MAX_PAGE_SIZE = 100;

/** One priced line of an invoice detail read (the row's view). */
export interface InvoiceLineView {
  readonly id: string;
  readonly orderLineId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly hsn: string | null;
  readonly qtyMilli: number;
  readonly ratePaise: number;
  readonly rateSource: RateSource;
  readonly taxablePaise: number;
  readonly gstBps: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly hsnGap: boolean;
  readonly createdAt: string;
}

/** One invoice's full detail view — the settled row + its priced lines. */
export interface InvoiceView {
  readonly id: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly warehouseId: string;
  readonly invoiceNo: string | null;
  readonly fyLabel: string | null;
  readonly seriesSeq: number | null;
  readonly status: InvoiceStatus;
  readonly originGstin: string | null;
  readonly consigneeGstin: string | null;
  readonly placeOfSupply: string | null;
  readonly supplyType: string | null;
  readonly subtotalPaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
  /** The rupee-rounded amount due (story 8-1b): ⌊(total + 50) / 100⌋ × 100. */
  readonly payablePaise: number;
  /** payable − total, signed, −49…+50. */
  readonly roundOffPaise: number;
  readonly revision: number;
  /** The pinned document snapshot (Design Notes shape) as it stands. */
  readonly document: InvoiceDocument;
  readonly lines: readonly InvoiceLineView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One header row of the invoice list read — no document, no lines. */
export interface InvoiceEntry {
  readonly id: string;
  readonly orderId: string;
  readonly warehouseId: string;
  readonly invoiceNo: string | null;
  readonly fyLabel: string | null;
  /**
   * The supplier GSTIN (story 8-1b): numbering is per GSTIN, so two
   * same-state GSTINs print identical numbers — the pair identifies one.
   */
  readonly originGstin: string | null;
  readonly status: InvoiceStatus;
  readonly supplyType: string | null;
  readonly placeOfSupply: string | null;
  readonly subtotalPaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
  readonly payablePaise: number;
  readonly roundOffPaise: number;
  readonly revision: number;
  /** The gaps count of the pinned document (the list surfaces the blockage). */
  readonly gapKinds: readonly GapKind[];
  readonly createdAt: string;
}

/**
 * The idempotency snapshot of the generate/regenerate command — replayed
 * byte-for-byte (every other command's `*Snapshot` shape family).
 */
export interface InvoiceSnapshot {
  readonly invoice: InvoiceView;
}

export function toInvoiceLineView(row: InvoiceLine): InvoiceLineView {
  return {
    id: row.id,
    orderLineId: row.orderLineId,
    skuCode: row.skuCode,
    skuName: row.skuName,
    hsn: row.hsn,
    qtyMilli: row.qtyMilli,
    ratePaise: row.ratePaise,
    rateSource: row.rateSource as RateSource,
    taxablePaise: row.taxablePaise,
    gstBps: row.gstBps,
    cgstPaise: row.cgstPaise,
    sgstPaise: row.sgstPaise,
    igstPaise: row.igstPaise,
    hsnGap: row.hsnGap,
    createdAt: canonicalInstant(row.createdAt),
  };
}

export function toInvoiceView(row: Invoice, lines: readonly InvoiceLine[]): InvoiceView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    orderId: row.orderId,
    warehouseId: row.warehouseId,
    invoiceNo: row.invoiceNo,
    fyLabel: row.fyLabel,
    seriesSeq: row.seriesSeq,
    status: row.status as InvoiceStatus,
    originGstin: row.originGstin,
    consigneeGstin: row.consigneeGstin,
    placeOfSupply: row.placeOfSupply,
    supplyType: row.supplyType,
    subtotalPaise: row.subtotalPaise,
    gstPaise: row.gstPaise,
    totalPaise: row.totalPaise,
    payablePaise: row.payablePaise,
    roundOffPaise: row.roundOffPaise,
    revision: row.revision,
    document: row.document as InvoiceDocument,
    lines: lines.map(toInvoiceLineView),
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

export function toInvoiceEntry(row: Invoice): InvoiceEntry {
  const document = row.document as InvoiceDocument;
  const gapKinds = [...new Set(document.gaps.map((gap) => gap.kind))];
  return {
    id: row.id,
    orderId: row.orderId,
    warehouseId: row.warehouseId,
    invoiceNo: row.invoiceNo,
    fyLabel: row.fyLabel,
    originGstin: row.originGstin,
    status: row.status as InvoiceStatus,
    supplyType: row.supplyType,
    placeOfSupply: row.placeOfSupply,
    subtotalPaise: row.subtotalPaise,
    gstPaise: row.gstPaise,
    totalPaise: row.totalPaise,
    payablePaise: row.payablePaise,
    roundOffPaise: row.roundOffPaise,
    revision: row.revision,
    gapKinds,
    createdAt: canonicalInstant(row.createdAt),
  };
}