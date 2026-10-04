import { and, eq, inArray } from 'drizzle-orm';
import { ewayGstinSettings, gstStateCodes, invoices, type EwayBill, type Invoice } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import type { SupplyType } from './arith';
import { normalizeStateName, type InvoiceDocument, type StateCodeEntry } from './generator';
import { ewbBlockers, type EwayBlocker, type EwayInvoiceFacts, type EwayPartB, type StateCodeMaps } from './eway-json';
import { istDateOf } from './eway-threshold';
import type { EwayGateway } from './eway-gateway';

/**
 * The e-way read shapes (story 8-2b) and the in-tx helpers both the reads
 * and the commands use to turn a bill row into its view: the invoice facts,
 * the computed blockers and whether the gateway can generate it.
 */

export const EWAY_BILL_STATUSES = ['pending', 'generated', 'dismissed'] as const;
export type EwayBillStatus = (typeof EWAY_BILL_STATUSES)[number];

export const EWAY_SOURCES = ['manual', 'gateway'] as const;
export type EwaySource = (typeof EWAY_SOURCES)[number];

export const EWAY_LIST_DEFAULT_PAGE_SIZE = 50;
export const EWAY_LIST_MAX_PAGE_SIZE = 50;

/** A claim younger than this is live: generate, record and dismiss refuse. */
export const GATEWAY_CLAIM_TTL_MS = 2 * 60 * 1000;

export interface EwayBillView {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNo: string | null;
  readonly invoiceIssuedAt: string | null;
  readonly originGstin: string;
  readonly consigneeGstin: string | null;
  /** The consignee is registered (a GSTIN on the invoice). */
  readonly b2b: boolean;
  readonly status: EwayBillStatus;
  readonly consignmentValuePaise: number;
  readonly thresholdPaise: number;
  readonly thresholdRule: string;
  readonly transport: EwayPartB;
  readonly ewbNo: string | null;
  readonly ewbGeneratedAt: string | null;
  readonly ewbValidUntil: string | null;
  readonly source: EwaySource | null;
  readonly dismissedReason: string | null;
  readonly lastError: string | null;
  readonly gatewayClaimedAt: string | null;
  readonly lastExportedAt: string | null;
  readonly lastExportedBy: string | null;
  /** Computed at read time (pending bills only); never stored. */
  readonly blockers: readonly EwayBlocker[];
  /** A gateway is configured for this GSTIN and the bill is pending. */
  readonly gatewayAvailable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EwayBillSnapshot {
  readonly bill: EwayBillView;
}

export function partBOf(row: EwayBill): EwayPartB {
  return {
    transMode: row.transMode,
    vehicleNo: row.vehicleNo,
    vehicleType: row.vehicleType,
    transporterId: row.transporterId,
    transporterName: row.transporterName,
    transDocNo: row.transDocNo,
    transDocDate: row.transDocDate,
    distanceKm: row.distanceKm,
  };
}

/** The state list keyed both ways (global table — no tenant scope). */
export async function stateCodeMapsInTx(tx: TenantTx): Promise<StateCodeMaps> {
  const codes = await tx.select().from(gstStateCodes);
  return {
    byPrefix: new Map<string, StateCodeEntry>(codes.map((row) => [row.stateCode, { stateCode: row.stateCode, stateName: row.stateName }])),
    byName: new Map<string, StateCodeEntry>(
      codes.map((row) => [normalizeStateName(row.stateName), { stateCode: row.stateCode, stateName: row.stateName }]),
    ),
  };
}

/** An issued invoice row as the builder reads it; null if it cannot carry an e-way bill. */
export function invoiceFacts(invoice: Invoice): EwayInvoiceFacts | null {
  if (invoice.status !== 'issued' || invoice.invoiceNo === null || invoice.originGstin === null || invoice.issuedAt === null) {
    return null;
  }
  return {
    invoiceNo: invoice.invoiceNo,
    issuedAt: canonicalInstant(invoice.issuedAt),
    originGstin: invoice.originGstin,
    consigneeGstin: invoice.consigneeGstin,
    placeOfSupply: invoice.placeOfSupply,
    supplyType: invoice.supplyType as SupplyType | null,
    payablePaise: Number(invoice.payablePaise),
    roundOffPaise: Number(invoice.roundOffPaise),
    document: invoice.document as InvoiceDocument,
  };
}

/** The bill rows' invoices, by id. */
export async function invoicesByIdInTx(tx: TenantTx, tenantId: string, ids: readonly string[]): Promise<Map<string, Invoice>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.id, [...new Set(ids)])));
  return new Map(rows.map((row) => [row.id, row]));
}

/** The GSTINs whose "e-invoicing applies" flag is on. */
export async function eInvoiceGstinsInTx(tx: TenantTx, tenantId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ gstin: ewayGstinSettings.gstin })
    .from(ewayGstinSettings)
    .where(and(eq(ewayGstinSettings.tenantId, tenantId), eq(ewayGstinSettings.eInvoiceApplies, true)));
  return new Set(rows.map((row) => row.gstin));
}

export function claimLive(row: EwayBill, now: string = nowIso()): boolean {
  return row.gatewayClaimedAt !== null && Date.parse(now) - Date.parse(canonicalInstant(row.gatewayClaimedAt)) < GATEWAY_CLAIM_TTL_MS;
}

/** Everything a view needs beyond the row, read once per batch. */
export interface EwayViewContext {
  readonly invoices: ReadonlyMap<string, Invoice>;
  readonly maps: StateCodeMaps;
  readonly eInvoiceGstins: ReadonlySet<string>;
  readonly configuredGstins: ReadonlySet<string>;
  readonly todayIst: string;
}

export async function viewContextInTx(
  tx: TenantTx,
  tenantId: string,
  rows: readonly EwayBill[],
  gateway: EwayGateway,
): Promise<EwayViewContext> {
  const configured = new Set<string>();
  for (const gstin of new Set(rows.map((row) => row.originGstin))) {
    if (await gateway.configuredFor(tenantId, gstin)) configured.add(gstin);
  }
  return {
    invoices: await invoicesByIdInTx(tx, tenantId, rows.map((row) => row.invoiceId)),
    maps: await stateCodeMapsInTx(tx),
    eInvoiceGstins: await eInvoiceGstinsInTx(tx, tenantId),
    configuredGstins: configured,
    todayIst: istDateOf(nowIso()),
  };
}

/** The blockers of a pending bill (a missing or no-longer-issued invoice is `invoice-unavailable`, terminal). */
export function blockersFor(row: EwayBill, ctx: EwayViewContext): EwayBlocker[] {
  const invoice = ctx.invoices.get(row.invoiceId);
  const facts = invoice === undefined ? null : invoiceFacts(invoice);
  if (facts === null) {
    return [{ code: 'invoice-unavailable', terminal: true }];
  }
  return ewbBlockers(facts, partBOf(row), {
    maps: ctx.maps,
    eInvoiceApplies: ctx.eInvoiceGstins.has(row.originGstin),
    todayIst: ctx.todayIst,
  });
}

const instantOrNull = (value: string | null): string | null => (value === null ? null : canonicalInstant(value));

export function toEwayBillView(row: EwayBill, ctx: EwayViewContext): EwayBillView {
  const invoice = ctx.invoices.get(row.invoiceId);
  const pending = row.status === 'pending';
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceNo: invoice?.invoiceNo ?? null,
    invoiceIssuedAt: instantOrNull(invoice?.issuedAt ?? null),
    originGstin: row.originGstin,
    consigneeGstin: invoice?.consigneeGstin ?? null,
    b2b: (invoice?.consigneeGstin ?? null) !== null,
    status: row.status as EwayBillStatus,
    consignmentValuePaise: Number(row.consignmentValuePaise),
    thresholdPaise: Number(row.thresholdPaise),
    thresholdRule: row.thresholdRule,
    transport: partBOf(row),
    ewbNo: row.ewbNo,
    ewbGeneratedAt: instantOrNull(row.ewbGeneratedAt),
    ewbValidUntil: instantOrNull(row.ewbValidUntil),
    source: row.source as EwaySource | null,
    dismissedReason: row.dismissedReason,
    lastError: row.lastError,
    gatewayClaimedAt: instantOrNull(row.gatewayClaimedAt),
    lastExportedAt: instantOrNull(row.lastExportedAt),
    lastExportedBy: row.lastExportedBy,
    blockers: pending ? blockersFor(row, ctx) : [],
    gatewayAvailable: pending && ctx.configuredGstins.has(row.originGstin),
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}
