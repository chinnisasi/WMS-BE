import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  clientInvoiceLines,
  clientInvoiceSeries,
  clientInvoices,
  idempotencyKeys,
  type ClientInvoice,
} from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import {
  asGstBps,
  asPaise,
  assertInvoiceTotals,
  computeLineTax,
  formatServiceInvoiceNo,
  fyLabelFor,
  roundToRupee,
  type SupplyType,
} from '../../shared/primitives/gst';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { decodeCursor, encodeCursor, type Page } from '../../shared/primitives/pagination';
import { QUANTITY_DECIMALS } from '../../shared/primitives/quantity';
import { addIsoDays, fullPrecisionInstant, istDateOf, istMidnightOf, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { getClientInTx, lockClientInTx, type ClientSnapshot } from '../clients/clients.facade';
import { InvoicingFacade, type GstStateResolver } from '../invoicing/facade';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import {
  clientInvoiceSupplierFactsInTx,
  getMemberClientIdIn,
  getMemberRoleIn,
  type ClientInvoiceSupplierFacts,
  type ClientInvoiceWarehouseFacts,
} from '../tenancy/tenancy.service';
import { MeteringService, milliToDecimal, type MeteredPeriod } from './metering';
import { CHARGE_CODES, type ChargeCode, type RateBasis } from './rate-cards';

/**
 * Story 21-5 — client invoices (CAP-7, FR-78): a monthly SERVICES (SAC) GST
 * tax invoice to a client brand, one per (client, IST calendar month,
 * supplying GSTIN), derived from the 21-4 metering read.
 *
 * - **Prepare** meters each supplying-GSTIN group of the tenant's warehouses
 *   over the month and stores a DRAFT for every group with usage and no live
 *   invoice. A draft is recomputable (refresh) and discardable.
 * - **Issue** re-meters under the client lock; if the figures moved since
 *   the operator last saw them (the content hash differs) the fresh draft is
 *   stored and committed and the answer is `stale` — no number spent. With
 *   no gap left, the invoice takes the next number of its own services
 *   series and FREEZES (database triggers; `drizzle/0062_client_invoices.sql`).
 * - An issued invoice is then disputed, settled or voided — nothing else
 *   ever changes it. A void stays numbered; the next prepare for its group
 *   drafts a replacement naming it.
 *
 * Everything is billing-owned: the client, the tenancy party facts and the
 * e-invoicing flag are read through their modules' seams (AD-6).
 */

// ── vocabularies (pinned against 0062's CHECKs by test/client-invoices.spec.ts) ──

export const CLIENT_INVOICE_STATUSES = ['draft', 'issued', 'disputed', 'settled', 'void'] as const;
export type ClientInvoiceStatus = (typeof CLIENT_INVOICE_STATUSES)[number];

/** The only status moves after issue (the guard trigger's allow-list). */
export const CLIENT_INVOICE_TRANSITIONS: Readonly<Record<ClientInvoiceStatus, readonly ClientInvoiceStatus[]>> = {
  draft: [],
  issued: ['disputed', 'settled', 'void'],
  disputed: ['settled', 'void'],
  settled: [],
  void: [],
};

/** The three transition verbs and the status each lands on. */
export const CLIENT_INVOICE_VERBS = { dispute: 'disputed', settle: 'settled', void: 'void' } as const;
export type ClientInvoiceVerb = keyof typeof CLIENT_INVOICE_VERBS;

/** The verbs that require a note (the CHECK and the trigger refuse without one). */
export const NOTE_REQUIRED_VERBS: readonly ClientInvoiceVerb[] = ['dispute', 'void'];
export const STATUS_NOTE_MAX = 500;

export const SUPPLY_TYPES = ['intra', 'inter'] as const;

/**
 * Decision 4 — the SAC per charge, frozen onto each line: storage is
 * "storage and warehousing services" (996729); receipt handling, picking and
 * outbound handling are cargo handling (996719). A per-tenant override is
 * PENDING.
 */
export const SAC_BY_CHARGE: Readonly<Record<ChargeCode, string>> = {
  storage: '996729',
  inbound_handling: '996719',
  pick: '996719',
  outbound_handling: '996719',
};

/** Decision 4 — every line at 18 %. */
export const CLIENT_INVOICE_GST_BPS = 1800;

/** What blocks issue (409 `invoice-has-gaps`), in the order a draft lists them. */
export const CLIENT_INVOICE_GAP_CODES = [
  'supplier-gstin-missing',
  'supplier-address-missing',
  'client-legal-name-missing',
  'client-billing-address-missing',
  'storage-not-complete',
  'line-unpriced',
  'einvoice-required',
] as const;
export type ClientInvoiceGapCode = (typeof CLIENT_INVOICE_GAP_CODES)[number];

/** What does not block issue. */
export const CLIENT_INVOICE_WARNING_CODES = ['supplier-state-differs'] as const;
export type ClientInvoiceWarningCode = (typeof CLIENT_INVOICE_WARNING_CODES)[number];

export interface ClientInvoiceGap {
  readonly code: ClientInvoiceGapCode;
  readonly detail: string;
  readonly warehouseId?: string;
  /** The IST date the line's rate-card segment starts (line-scoped gaps). */
  readonly segmentFrom?: string;
}

export interface ClientInvoiceWarning {
  readonly code: ClientInvoiceWarningCode;
  readonly detail: string;
}

/** The list page bounds. */
export const CLIENT_INVOICE_LIST_DEFAULT_LIMIT = 50;
export const CLIENT_INVOICE_LIST_MAX_LIMIT = 100;

/** The content-hash convention version (bumped only by a deliberate, recorded change). */
export const CLIENT_INVOICE_HASH_VERSION = 1;

/**
 * The command clock (the `rateCardClock` precedent): "has the month ended"
 * and the issue instant (which picks the FY) are read here, so a test can
 * move the clock across a month end or into April.
 */
export const clientInvoiceClock = {
  now: (): number => Date.now(),
};

// ── the party ────────────────────────────────────────────────────────────────

export interface ClientInvoiceParty {
  readonly supplier: {
    /** The tenant's name (decision 6). */
    readonly name: string;
    readonly gstin: string | null;
    readonly stateCode: string | null;
    readonly stateName: string | null;
    /** The `origin_*` address of the group's address warehouse (decision 6), or null. */
    readonly address: {
      readonly line1: string;
      readonly line2: string | null;
      readonly city: string;
      readonly state: string;
      readonly pincode: string;
    } | null;
    readonly warehouseCode: string | null;
  };
  readonly recipient: {
    readonly name: string;
    readonly code: string;
    readonly legalName: string | null;
    readonly gstin: string | null;
    readonly stateCode: string | null;
    readonly stateName: string | null;
    readonly address: {
      readonly line1: string | null;
      readonly line2: string | null;
      readonly city: string | null;
      readonly stateCode: string | null;
      readonly pincode: string | null;
    };
  };
}

// ── the pure draft computation ───────────────────────────────────────────────

/** One supplying-GSTIN group: `warehouses.gstin ?? tenants.gstin` (decision 2). */
export interface SupplierGroup {
  readonly supplierGstin: string | null;
  readonly warehouses: readonly ClientInvoiceWarehouseFacts[];
}

/**
 * Every tenant warehouse into exactly one group, keyed by its GSTIN, else the
 * tenant's (null allowed — a tenant with no GSTIN is one group that cannot
 * issue). Groups ordered by GSTIN, the null group last; warehouses by code.
 */
export function supplierGroups(facts: ClientInvoiceSupplierFacts): SupplierGroup[] {
  const groups = new Map<string, ClientInvoiceWarehouseFacts[]>();
  for (const warehouse of facts.warehouses) {
    const key = warehouse.gstin ?? facts.tenantGstin ?? '';
    const list = groups.get(key) ?? [];
    list.push(warehouse);
    groups.set(key, list);
  }
  return [...groups.keys()]
    .sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map((key) => ({
      supplierGstin: key === '' ? null : key,
      warehouses: [...groups.get(key)!].sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id)),
    }));
}

/** The group an invoice belongs to (by its frozen supplying GSTIN), or an empty one. */
export function groupOf(groups: readonly SupplierGroup[], supplierGstin: string | null): SupplierGroup {
  return groups.find((group) => group.supplierGstin === supplierGstin) ?? { supplierGstin, warehouses: [] };
}

/** One line as the draft computes it (quantity in milli-unit-days or a count, as a BigInt). */
export interface ClientInvoiceDraftLine {
  readonly rateCardId: string | null;
  /** IST-midnight instants, `[from, to)`. */
  readonly segmentFrom: string;
  readonly segmentTo: string;
  readonly chargeCode: ChargeCode;
  readonly basis: RateBasis;
  readonly uom: string | null;
  readonly quantity: bigint;
  readonly unitAmountPaise: number | null;
  readonly amountPaise: number | null;
  readonly sacCode: string;
  readonly gstBps: number;
  readonly placeOfSupply: string | null;
  readonly supplyType: SupplyType | null;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
}

export interface ClientInvoiceTotals {
  readonly subtotalPaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly taxPaise: number;
  readonly totalPaise: number;
  readonly roundOffPaise: number;
  readonly payablePaise: number;
}

export interface ClientInvoiceDraft {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly supplierGstin: string | null;
  readonly placeOfSupply: string | null;
  readonly supplyType: SupplyType | null;
  readonly party: ClientInvoiceParty;
  readonly lines: readonly ClientInvoiceDraftLine[];
  readonly totals: ClientInvoiceTotals;
  readonly gaps: readonly ClientInvoiceGap[];
  readonly warnings: readonly ClientInvoiceWarning[];
  readonly contentHash: string;
}

export interface ClientInvoiceDraftInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly tenantName: string;
  readonly group: SupplierGroup;
  readonly client: Pick<ClientSnapshot, 'code' | 'name' | 'taxDetails'>;
  /** The 21-4 metering read over the month, narrowed to the group's warehouses. */
  readonly metered: Pick<MeteredPeriod, 'segments' | 'storageCompleteThrough'>;
  readonly eInvoiceApplies: boolean;
  readonly states: Pick<GstStateResolver, 'nameOf' | 'codeOfText'>;
}

const MILLI = 10n ** BigInt(QUANTITY_DECIMALS);

/** A metered decimal quantity (`"1234.567"`, `"12"`) as an exact BigInt of milli-units. */
export function decimalToMilli(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value);
  if (match === null) throw new Error(`client invoice: malformed metered quantity "${value}"`);
  return BigInt(match[1]!) * MILLI + BigInt((match[2] ?? '').padEnd(QUANTITY_DECIMALS, '0'));
}

const chargeRank = (code: string): number => (CHARGE_CODES as readonly string[]).indexOf(code);

/** The canonical line order: (segment_from, charge — `CHARGE_CODES` order, uom — null first). */
export function compareLines(
  a: { segmentFrom: string; chargeCode: string; uom: string | null },
  b: { segmentFrom: string; chargeCode: string; uom: string | null },
): number {
  const from = Date.parse(a.segmentFrom) - Date.parse(b.segmentFrom);
  if (from !== 0) return from;
  const charge = chargeRank(a.chargeCode) - chargeRank(b.chargeCode);
  if (charge !== 0) return charge;
  if (a.uom === b.uom) return 0;
  if (a.uom === null) return -1;
  if (b.uom === null) return 1;
  return a.uom < b.uom ? -1 : 1;
}

const isFull = (value: string | null): value is string => value !== null && value.trim() !== '';

/**
 * THE draft computation, pure: lines (one per metered (segment, charge, uom)
 * with quantity > 0), the per-line tax, the totals and the rupee rounding,
 * the gaps and warnings, the party, and the content hash. Prepare, refresh
 * and issue all run it; nothing reads the stored draft to compute the next.
 */
export function computeClientInvoiceDraft(input: ClientInvoiceDraftInput): ClientInvoiceDraft {
  const { group, client, metered, states } = input;
  const tax = client.taxDetails;

  // ── the supplier (decision 6): the tenant's name; the address of the
  // lowest-code warehouse of the group with a full origin address.
  const supplierGstin = group.supplierGstin;
  const supplierStateCode = supplierGstin === null ? null : supplierGstin.slice(0, 2);
  const addressWarehouse = group.warehouses.find(
    (warehouse) => isFull(warehouse.origin.line1) && isFull(warehouse.origin.city) && isFull(warehouse.origin.state) && isFull(warehouse.origin.pincode),
  );

  // ── the recipient and the place of supply (decision 5, IGST Act s.12(2)):
  // the client GSTIN's state, else its billing state.
  const recipientStateCode = tax.gstin !== null ? tax.gstin.slice(0, 2) : tax.billingStateCode;
  const placeOfSupply = recipientStateCode;
  const supplyType: SupplyType | null =
    supplierStateCode === null || placeOfSupply === null ? null : supplierStateCode === placeOfSupply ? 'intra' : 'inter';

  const party: ClientInvoiceParty = {
    supplier: {
      name: input.tenantName,
      gstin: supplierGstin,
      stateCode: supplierStateCode,
      stateName: supplierStateCode === null ? null : states.nameOf(supplierStateCode),
      address:
        addressWarehouse === undefined
          ? null
          : {
              line1: addressWarehouse.origin.line1!,
              line2: isFull(addressWarehouse.origin.line2) ? addressWarehouse.origin.line2 : null,
              city: addressWarehouse.origin.city!,
              state: addressWarehouse.origin.state!,
              pincode: addressWarehouse.origin.pincode!,
            },
      warehouseCode: addressWarehouse?.code ?? null,
    },
    recipient: {
      name: client.name,
      code: client.code,
      legalName: tax.legalName,
      gstin: tax.gstin,
      stateCode: recipientStateCode,
      stateName: recipientStateCode === null ? null : states.nameOf(recipientStateCode),
      address: {
        line1: tax.billingLine1,
        line2: tax.billingLine2,
        city: tax.billingCity,
        stateCode: tax.billingStateCode,
        pincode: tax.billingPincode,
      },
    },
  };

  // ── the lines.
  const storageComplete = metered.storageCompleteThrough !== null && metered.storageCompleteThrough >= input.periodEnd;
  const lines: ClientInvoiceDraftLine[] = [];
  for (const segment of metered.segments) {
    const segmentFrom = istMidnightOf(segment.fromDate);
    const segmentTo = istMidnightOf(addIsoDays(segment.toDate, 1));
    for (const metric of segment.lines) {
      const quantity = metric.chargeCode === 'storage' ? decimalToMilli(metric.quantity) : BigInt(metric.quantity);
      if (quantity <= 0n) continue;
      const amount = segment.rateCardId === null ? null : metric.amountPaise;
      const lineTax =
        amount === null
          ? { cgstPaise: 0, sgstPaise: 0, igstPaise: 0 }
          : computeLineTax(1000, asPaise(amount), asGstBps(CLIENT_INVOICE_GST_BPS), supplyType);
      lines.push({
        rateCardId: segment.rateCardId,
        segmentFrom,
        segmentTo,
        chargeCode: metric.chargeCode,
        basis: metric.basis,
        uom: metric.chargeCode === 'storage' ? metric.uom : null,
        quantity,
        unitAmountPaise: amount === null ? null : metric.ratePaise,
        amountPaise: amount,
        sacCode: SAC_BY_CHARGE[metric.chargeCode],
        gstBps: CLIENT_INVOICE_GST_BPS,
        placeOfSupply,
        supplyType,
        cgstPaise: lineTax.cgstPaise,
        sgstPaise: lineTax.sgstPaise,
        igstPaise: lineTax.igstPaise,
      });
    }
  }
  lines.sort(compareLines);

  // ── the totals (sums of rounded lines; the rupee rounding on the total only).
  let subtotal = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  for (const line of lines) {
    subtotal += line.amountPaise ?? 0;
    cgst += line.cgstPaise;
    sgst += line.sgstPaise;
    igst += line.igstPaise;
  }
  const taxPaise = cgst + sgst + igst;
  const totalPaise = subtotal + taxPaise;
  assertInvoiceTotals({ subtotalPaise: subtotal, gstPaise: taxPaise, totalPaise, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst });
  const rounded = roundToRupee(asPaise(totalPaise));
  const totals: ClientInvoiceTotals = {
    subtotalPaise: subtotal,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    taxPaise,
    totalPaise,
    roundOffPaise: rounded.roundOff,
    payablePaise: rounded.payable,
  };

  // ── the gaps (blocking) — in CLIENT_INVOICE_GAP_CODES order.
  const gaps: ClientInvoiceGap[] = [];
  if (supplierGstin === null) {
    gaps.push({
      code: 'supplier-gstin-missing',
      detail: 'Neither these warehouses nor the tenant has a GSTIN — a tax invoice needs the supplier’s registration.',
    });
  }
  if (addressWarehouse === undefined) {
    gaps.push({
      code: 'supplier-address-missing',
      detail: `No warehouse invoiced under ${supplierGstin ?? 'this registration'} has a full origin address (line 1, city, state, pincode) to print as the supplier address.`,
    });
  }
  if (tax.legalName === null) {
    gaps.push({ code: 'client-legal-name-missing', detail: `Client ${client.code} has no legal name — set its tax details.` });
  }
  const missingAddress = [
    tax.billingLine1 === null ? 'line 1' : null,
    tax.billingCity === null ? 'city' : null,
    tax.billingStateCode === null ? 'state code' : null,
    tax.billingPincode === null ? 'pincode' : null,
  ].filter((part): part is string => part !== null);
  if (missingAddress.length > 0) {
    gaps.push({
      code: 'client-billing-address-missing',
      detail: `Client ${client.code}'s billing address is missing its ${missingAddress.join(', ')} — set its tax details.`,
    });
  }
  if (!storageComplete) {
    gaps.push({
      code: 'storage-not-complete',
      detail:
        metered.storageCompleteThrough === null
          ? `Storage is not measured for this month yet — the snapshot job has written nothing through ${input.periodEnd}.`
          : `Storage is measured only through ${metered.storageCompleteThrough}; the month runs to ${input.periodEnd}. Wait for the snapshot job, then refresh.`,
    });
  }
  for (const line of lines) {
    if (line.amountPaise !== null) continue;
    // An incomplete month already names its storage lines: no double gap.
    if (line.chargeCode === 'storage' && !storageComplete) continue;
    const from = istDateOf(line.segmentFrom);
    const to = addIsoDays(istDateOf(line.segmentTo), -1);
    gaps.push({
      code: 'line-unpriced',
      detail:
        line.rateCardId === null
          ? `${line.chargeCode}${line.uom === null ? '' : ` (${line.uom})`} ${from} – ${to}: no rate card is in force for this stretch.`
          : `${line.chargeCode}${line.uom === null ? '' : ` (${line.uom})`} ${from} – ${to}: the rate card in force does not price this charge.`,
      segmentFrom: from,
    });
  }
  if (input.eInvoiceApplies && tax.gstin !== null) {
    gaps.push({
      code: 'einvoice-required',
      detail: `E-invoicing applies to ${supplierGstin} and the client is registered (${tax.gstin}) — this invoice needs an IRN, which is not supported yet.`,
    });
  }

  // ── the warnings (never block).
  const warnings: ClientInvoiceWarning[] = [];
  if (supplierStateCode !== null) {
    for (const warehouse of group.warehouses) {
      if (!isFull(warehouse.origin.state)) continue;
      const code = states.codeOfText(warehouse.origin.state);
      if (code !== supplierStateCode) {
        warnings.push({
          code: 'supplier-state-differs',
          detail: `Warehouse ${warehouse.code} is in ${warehouse.origin.state}${code === null ? '' : ` (${code})`}, but invoices under ${supplierGstin} (state ${supplierStateCode}).`,
        });
      }
    }
  }

  const draft = {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    supplierGstin,
    placeOfSupply,
    supplyType,
    party,
    lines,
    totals,
    gaps,
    warnings,
  };
  return { ...draft, contentHash: clientInvoiceContentHash(draft) };
}

/**
 * Canonical JSON: object keys sorted at every depth, `undefined` members
 * dropped, BigInts as decimal strings. Two equal documents serialise to the
 * same bytes whatever order their keys were built in.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

/** A paise (or quantity) value of a bigint column, as the hash carries it: a decimal string. */
const big = (value: number | bigint | null): string | null => (value === null ? null : value.toString());

/**
 * The content hash (v1): sha256 over the canonical JSON of everything the
 * issued row would store, EXCLUDING ids (the invoice's, the lines', the
 * client's, the replaced invoice's), timestamps, the status and the
 * lifecycle fields (number, FY, stamps, note). The rate card that priced a
 * line IS content (decision: CAP-4 — the card that applied). Bigint columns
 * are decimal strings; lines in the canonical order; `"v": 1`.
 */
export function clientInvoiceContentHash(draft: Omit<ClientInvoiceDraft, 'contentHash'>): string {
  const lines = [...draft.lines].sort(compareLines).map((line) => ({
    rateCardId: line.rateCardId,
    segmentFrom: new Date(line.segmentFrom).toISOString(),
    segmentTo: new Date(line.segmentTo).toISOString(),
    chargeCode: line.chargeCode,
    basis: line.basis,
    uom: line.uom,
    quantity: big(line.quantity),
    unitAmountPaise: big(line.unitAmountPaise),
    amountPaise: big(line.amountPaise),
    sacCode: line.sacCode,
    gstBps: line.gstBps,
    placeOfSupply: line.placeOfSupply,
    supplyType: line.supplyType,
    cgstPaise: big(line.cgstPaise),
    sgstPaise: big(line.sgstPaise),
    igstPaise: big(line.igstPaise),
  }));
  const totals = Object.fromEntries(Object.entries(draft.totals).map(([key, value]) => [key, big(value)]));
  const content = {
    v: CLIENT_INVOICE_HASH_VERSION,
    periodStart: draft.periodStart,
    periodEnd: draft.periodEnd,
    supplierGstin: draft.supplierGstin,
    placeOfSupply: draft.placeOfSupply,
    supplyType: draft.supplyType,
    party: draft.party,
    lines,
    totals,
    gaps: draft.gaps,
    warnings: draft.warnings,
  };
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

/** A draft as a compute stores it: the hashed content plus the (unhashed) storage measured-through day. */
export interface ComputedDraft extends ClientInvoiceDraft {
  /** Story 21-5b — the group's snapshot watermark clipped to `period_end` (`period_start − 1`: the group has no snapshot scope). */
  readonly storageMeasuredThrough: string;
}

/**
 * The group watermark, clipped to the month's last day. A group with NO
 * watermark (no snapshot scope) stores `period_start − 1` — nothing measured
 * — never NULL: NULL is reserved for a row stored before 0063 (read as
 * `period_end` only on a non-draft invoice; see `storageDays`).
 */
export function measuredThroughOf(groupWatermark: string | null, periodStart: string, periodEnd: string): string {
  if (groupWatermark === null) return addIsoDays(periodStart, -1);
  return groupWatermark < periodEnd ? groupWatermark : periodEnd;
}

// ── the period ───────────────────────────────────────────────────────────────

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `YYYY-MM` → the IST calendar month's first and last day; 400 when malformed. */
export function monthPeriod(month: string): { periodStart: string; periodEnd: string } {
  const match = typeof month === 'string' ? MONTH_RE.exec(month) : null;
  if (match === null) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Invalid invoice month',
      `month must be a calendar month YYYY-MM (got ${JSON.stringify(month)}).`,
    );
  }
  const periodStart = `${match[1]}-${match[2]}-01`;
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
  return { periodStart, periodEnd: addIsoDays(next.toISOString().slice(0, 10), -1) };
}

// ── the views ────────────────────────────────────────────────────────────────

export interface ClientInvoiceLineView {
  /** Story 21-5b — the line's id (the drill's address). A draft's lines are rewritten on refresh and issue (new ids). */
  readonly id: string;
  readonly rateCardId: string | null;
  /** IST dates, inclusive. */
  readonly segmentFrom: string;
  readonly segmentTo: string;
  readonly chargeCode: ChargeCode;
  readonly basis: RateBasis;
  readonly uom: string | null;
  /** Base-unit-days for storage (to three decimals), a whole count otherwise — a decimal string. */
  readonly quantity: string;
  readonly unitAmountPaise: number | null;
  readonly amountPaise: number | null;
  readonly sac: string;
  readonly gstBps: number;
  readonly placeOfSupply: string | null;
  readonly supplyType: SupplyType | null;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
}

export interface ClientInvoiceTotalsView {
  readonly subtotal: number;
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
  readonly tax: number;
  readonly roundOff: number;
  readonly payable: number;
}

export interface ClientInvoiceEntryView {
  readonly id: string;
  readonly clientId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: ClientInvoiceStatus;
  readonly invoiceNo: string | null;
  readonly fyLabel: string | null;
  readonly supplierGstin: string | null;
  readonly placeOfSupply: string | null;
  readonly supplyType: SupplyType | null;
  readonly totals: ClientInvoiceTotalsView;
  readonly gapCount: number;
  readonly issuedAt: string | null;
  readonly statusNote: string | null;
  readonly replacesInvoiceId: string | null;
  readonly createdAt: string;
}

export interface ClientInvoiceView extends Omit<ClientInvoiceEntryView, 'gapCount'> {
  readonly gaps: readonly ClientInvoiceGap[];
  readonly warnings: readonly ClientInvoiceWarning[];
  readonly party: ClientInvoiceParty;
  readonly lines: readonly ClientInvoiceLineView[];
}

const iso = (value: string | null): string | null => (value === null ? null : new Date(value).toISOString());

function toEntryView(row: ClientInvoice): ClientInvoiceEntryView {
  return {
    id: row.id,
    clientId: row.clientId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status as ClientInvoiceStatus,
    invoiceNo: row.invoiceNo,
    fyLabel: row.fyLabel,
    supplierGstin: row.supplierGstin,
    placeOfSupply: row.placeOfSupply,
    supplyType: row.supplyType as SupplyType | null,
    totals: {
      subtotal: Number(row.subtotalPaise),
      cgst: Number(row.cgstPaise),
      sgst: Number(row.sgstPaise),
      igst: Number(row.igstPaise),
      tax: Number(row.taxPaise),
      roundOff: Number(row.roundOffPaise),
      payable: Number(row.payablePaise),
    },
    gapCount: (row.gaps as unknown[]).length,
    issuedAt: iso(row.issuedAt),
    statusNote: row.statusNote,
    replacesInvoiceId: row.replacesInvoiceId,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

const numberOrNull = (value: string | number | null): number | null => (value === null ? null : Number(value));

/** The stored lines of one invoice, in the canonical order, quantities read raw (they can pass 2⁵³). */
async function linesOfInTx(tx: TenantTx, tenantId: string, invoiceId: string): Promise<ClientInvoiceLineView[]> {
  const rows = await tx
    .select({
      id: clientInvoiceLines.id,
      rateCardId: clientInvoiceLines.rateCardId,
      segmentFrom: clientInvoiceLines.segmentFrom,
      segmentTo: clientInvoiceLines.segmentTo,
      chargeCode: clientInvoiceLines.chargeCode,
      basis: clientInvoiceLines.basis,
      uom: clientInvoiceLines.uom,
      quantity: sql<string>`${clientInvoiceLines.quantity}::text`,
      unitAmountPaise: clientInvoiceLines.unitAmountPaise,
      amountPaise: clientInvoiceLines.amountPaise,
      sacCode: clientInvoiceLines.sacCode,
      gstBps: clientInvoiceLines.gstBps,
      placeOfSupply: clientInvoiceLines.placeOfSupply,
      supplyType: clientInvoiceLines.supplyType,
      cgstPaise: clientInvoiceLines.cgstPaise,
      sgstPaise: clientInvoiceLines.sgstPaise,
      igstPaise: clientInvoiceLines.igstPaise,
    })
    .from(clientInvoiceLines)
    .where(and(eq(clientInvoiceLines.tenantId, tenantId), eq(clientInvoiceLines.invoiceId, invoiceId)));
  return rows
    .map((row) => ({ ...row, segmentFrom: new Date(row.segmentFrom).toISOString(), segmentTo: new Date(row.segmentTo).toISOString() }))
    .sort(compareLines)
    .map((row) => ({
      id: row.id,
      rateCardId: row.rateCardId,
      segmentFrom: istDateOf(row.segmentFrom),
      segmentTo: addIsoDays(istDateOf(row.segmentTo), -1),
      chargeCode: row.chargeCode as ChargeCode,
      basis: row.basis as RateBasis,
      uom: row.uom,
      quantity: row.chargeCode === 'storage' ? milliToDecimal(BigInt(row.quantity)) : row.quantity,
      unitAmountPaise: numberOrNull(row.unitAmountPaise),
      amountPaise: numberOrNull(row.amountPaise),
      sac: row.sacCode,
      gstBps: row.gstBps,
      placeOfSupply: row.placeOfSupply,
      supplyType: row.supplyType as SupplyType | null,
      cgstPaise: Number(row.cgstPaise),
      sgstPaise: Number(row.sgstPaise),
      igstPaise: Number(row.igstPaise),
    }));
}

async function viewOfInTx(tx: TenantTx, row: ClientInvoice): Promise<ClientInvoiceView> {
  const entry: { -readonly [K in keyof ClientInvoiceEntryView]?: ClientInvoiceEntryView[K] } = { ...toEntryView(row) };
  delete entry.gapCount;
  return {
    ...(entry as Omit<ClientInvoiceEntryView, 'gapCount'>),
    gaps: row.gaps as ClientInvoiceGap[],
    warnings: row.warnings as ClientInvoiceWarning[],
    party: row.party as ClientInvoiceParty,
    lines: await linesOfInTx(tx, row.tenantId, row.id),
  };
}

// ── refusals ─────────────────────────────────────────────────────────────────

export function clientInvoiceNotFound(invoiceId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Client invoice not found', `No client invoice with id "${invoiceId}" exists in this tenant.`);
}

function invoiceNotDraft(row: ClientInvoice): ProblemException {
  return new ProblemException(
    'invoice-not-draft',
    409,
    'Client invoice is not a draft',
    `Invoice ${row.invoiceNo ?? row.id} is ${row.status} — only a draft is refreshed, discarded or issued. An issued invoice never changes.`,
  );
}

export function portalRefused(): ProblemException {
  return new ProblemException(
    'role-denied',
    403,
    'Client-portal sessions cannot read client invoices here',
    'Client invoices are an operator surface; a client-portal user cannot read them through this route.',
  );
}

// ── the commands and reads ───────────────────────────────────────────────────

export interface PrepareClientInvoicesCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  /** `YYYY-MM` — one IST calendar month. */
  readonly month: string;
}

export interface ClientInvoiceTargetCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly invoiceId: string;
}

export interface TransitionClientInvoiceCommand extends ClientInvoiceTargetCommand {
  readonly verb: ClientInvoiceVerb;
  readonly note?: string | null | undefined;
}

export interface PrepareClientInvoicesResult {
  readonly created: readonly ClientInvoiceView[];
  readonly existing: readonly ClientInvoiceView[];
}

export interface IssueClientInvoiceResult {
  readonly outcome: 'issued' | 'stale';
  readonly invoice: ClientInvoiceView;
}

export interface ClientInvoiceMutationResult {
  readonly invoice: ClientInvoiceView;
}

export interface ListClientInvoicesQuery {
  readonly clientId?: string | undefined;
  readonly status?: ClientInvoiceStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

type AuditAction =
  | 'client_invoice.prepared'
  | 'client_invoice.refreshed'
  | 'client_invoice.discarded'
  | 'client_invoice.issued'
  | 'client_invoice.disputed'
  | 'client_invoice.settled'
  | 'client_invoice.voided';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const ONE_LIVE_INDEX = 'client_invoices_one_live_per_group';
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** The trimmed note, or null (blank and absent alike). */
export function normalizeNote(note: string | null | undefined): string | null {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The request-shape rule for a transition's note (above the transaction —
 * it needs no row): dispute and void need one; any note is 1..500 chars.
 */
export function assertTransitionNote(verb: ClientInvoiceVerb, note: string | null): void {
  if (note === null && NOTE_REQUIRED_VERBS.includes(verb)) {
    throw new ProblemException('validation-failed', 400, 'A note is required', `To ${verb} an invoice, say why — a note is required.`);
  }
  if (note !== null && [...note].length > STATUS_NOTE_MAX) {
    throw new ProblemException('validation-failed', 400, 'Note too long', `A note is at most ${STATUS_NOTE_MAX} characters (got ${[...note].length}).`);
  }
}

/**
 * Client invoices (story 21-5) — the house skeleton on every command
 * (IMPLEMENTATION-GUIDE §1): hash before the transaction; authority
 * (`billing.invoice` — owner + accountant) → replay → locks → replay again
 * under the lock → guards → the write → audit → the idempotency key LAST.
 *
 * Lock discipline: prepare, refresh and issue take the CLIENT row
 * (`lockClientInTx`) and then (refresh, issue) the invoice row; discard and
 * the transitions lock only the invoice row. Nothing locks an invoice before
 * the client row, so there is no cycle.
 */
@Injectable()
export class ClientInvoiceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MeteringService) private readonly metering: MeteringService,
    @Inject(InvoicingFacade) private readonly invoicing: InvoicingFacade,
  ) {}

  // ── commands ──────────────────────────────────────────────────────────────

  /**
   * Prepare the drafts for a client and a past IST month: one per supplying
   * GSTIN group with usage and no live invoice. `{created, existing}`; 409
   * `nothing-to-invoice` only when no group has usage.
   */
  async prepare(command: PrepareClientInvoicesCommand, idempotencyKey: string): Promise<PrepareClientInvoicesResult> {
    const payloadHash = hashCommandPayload({ arm: 'prepare', tenantId: command.tenantId, clientId: command.clientId, month: command.month });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as PrepareClientInvoicesResult;

      const { periodStart, periodEnd } = monthPeriod(command.month);
      if (!UUID_RE.test(command.clientId)) throw clientNotFoundProblem(command.clientId);
      await lockClientInTx(tx, command.tenantId, command.clientId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as PrepareClientInvoicesResult;

      const client = await getClientInTx(tx, command.tenantId, command.clientId);
      assertBillableClient(client);
      assertPeriodEnded(periodEnd);

      const context = await this.contextInTx(tx, command.tenantId);
      const live = await tx
        .select()
        .from(clientInvoices)
        .where(
          and(
            eq(clientInvoices.tenantId, command.tenantId),
            eq(clientInvoices.clientId, client.id),
            eq(clientInvoices.periodStart, periodStart),
            ne(clientInvoices.status, 'void'),
          ),
        );

      const created: ClientInvoiceView[] = [];
      const existing: ClientInvoiceView[] = [];
      let anyUsage = false;
      for (const group of context.groups) {
        const draft = await this.computeInTx(tx, command.tenantId, client, group, periodStart, periodEnd, context);
        const liveRow = live.find((row) => row.supplierGstin === group.supplierGstin);
        if (draft.lines.length > 0) anyUsage = true;
        if (liveRow !== undefined) {
          existing.push(await viewOfInTx(tx, liveRow));
          continue;
        }
        if (draft.lines.length === 0) continue;
        const replaces = await this.latestUnreplacedVoidInTx(tx, command.tenantId, client.id, periodStart, group.supplierGstin);
        const row = await this.insertDraftInTx(tx, command, client.id, draft, replaces);
        await this.audit(tx, command, 'client_invoice.prepared', row.id, idempotencyKey);
        created.push(await viewOfInTx(tx, row));
      }
      if (!anyUsage) {
        throw new ProblemException(
          'nothing-to-invoice',
          409,
          'Nothing to invoice',
          `Client ${client.code} has no billable usage in ${command.month} — no receipt line, pick, dispatched order or stored unit.`,
        );
      }

      const result: PrepareClientInvoicesResult = { created, existing };
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  /** Re-derive a draft from the current figures (stored only when they moved). */
  async refresh(command: ClientInvoiceTargetCommand, idempotencyKey: string): Promise<ClientInvoiceMutationResult> {
    const payloadHash = hashCommandPayload({ arm: 'refresh', tenantId: command.tenantId, invoiceId: command.invoiceId });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as ClientInvoiceMutationResult;

      const { row, client } = await this.lockClientAndInvoiceInTx(tx, command.tenantId, command.invoiceId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as ClientInvoiceMutationResult;
      if (row.status !== 'draft') throw invoiceNotDraft(row);

      const context = await this.contextInTx(tx, command.tenantId);
      const draft = await this.computeInTx(tx, command.tenantId, client, groupOf(context.groups, row.supplierGstin), row.periodStart, row.periodEnd, context);
      const stored =
        draft.contentHash !== row.contentHash
          ? await this.rewriteDraftInTx(tx, row, draft)
          : await this.restampMeasuredThroughInTx(tx, row, draft.storageMeasuredThrough);

      const result: ClientInvoiceMutationResult = { invoice: await viewOfInTx(tx, stored) };
      await this.audit(tx, command, 'client_invoice.refreshed', row.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  /**
   * Issue a draft. Under the client lock and the invoice lock: re-meter and
   * recompute; a different content hash stores the fresh draft and answers
   * `stale` (committed — no number spent); any gap is 409
   * `invoice-has-gaps`; then the number from the series row (inserted ON
   * CONFLICT, then taken FOR UPDATE), the stamps, the party, audit, key.
   */
  async issue(command: ClientInvoiceTargetCommand, idempotencyKey: string): Promise<IssueClientInvoiceResult> {
    const payloadHash = hashCommandPayload({ arm: 'issue', tenantId: command.tenantId, invoiceId: command.invoiceId });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as IssueClientInvoiceResult;

      // 1–2. the client, then the draft.
      const { row, client } = await this.lockClientAndInvoiceInTx(tx, command.tenantId, command.invoiceId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as IssueClientInvoiceResult;
      if (row.status !== 'draft') throw invoiceNotDraft(row);

      // 3. re-meter, recompute the gaps and the hash.
      const context = await this.contextInTx(tx, command.tenantId);
      const draft = await this.computeInTx(tx, command.tenantId, client, groupOf(context.groups, row.supplierGstin), row.periodStart, row.periodEnd, context);

      // 4. the figures moved: store the fresh draft, COMMIT, answer stale.
      if (draft.contentHash !== row.contentHash) {
        const fresh = await this.rewriteDraftInTx(tx, row, draft);
        const stale: IssueClientInvoiceResult = { outcome: 'stale', invoice: await viewOfInTx(tx, fresh) };
        await this.audit(tx, command, 'client_invoice.refreshed', row.id, idempotencyKey);
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, stale);
        return stale;
      }

      // 5. any gap refuses; so does an empty draft.
      if (draft.gaps.length > 0) {
        throw new ProblemException(
          'invoice-has-gaps',
          409,
          'Client invoice has gaps',
          `Invoice cannot issue while it has gaps: ${draft.gaps.map((gap) => gap.code).join(', ')}.`,
          { gaps: draft.gaps },
        );
      }
      if (draft.lines.length === 0) {
        throw new ProblemException('nothing-to-invoice', 409, 'Nothing to invoice', 'This draft has no billable line — discard it.');
      }

      // 6. the number: gap-free, per supplying GSTIN per FY of the issue instant.
      const issuedAt = new Date(clientInvoiceClock.now()).toISOString();
      const supplierGstin = row.supplierGstin!;
      const fyLabel = fyLabelFor(issuedAt);
      const seq = await this.allocateSeqInTx(tx, command.tenantId, supplierGstin, fyLabel);
      const invoiceNo = formatServiceInvoiceNo(supplierGstin, fyLabel, seq);

      // 7. the stamps and the party, then audit and the key.
      const issued = await tx
        .update(clientInvoices)
        .set({
          status: 'issued',
          invoiceNo,
          fyLabel,
          seriesSeq: seq,
          issuedAt,
          issuedBy: command.actorUserId,
          party: draft.party,
          storageMeasuredThrough: draft.storageMeasuredThrough,
          updatedAt: nowIso(),
        })
        .where(and(eq(clientInvoices.tenantId, command.tenantId), eq(clientInvoices.id, row.id), eq(clientInvoices.status, 'draft')))
        .returning();
      const result: IssueClientInvoiceResult = { outcome: 'issued', invoice: await viewOfInTx(tx, issued[0]!) };
      await this.audit(tx, command, 'client_invoice.issued', row.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  /**
   * Discard a draft: its lines, then the row (the trigger refuses any other
   * delete). DELETE has no body to replay: a replay under the same key
   * settles (204); a repeat under a new key is 404.
   */
  async discard(command: ClientInvoiceTargetCommand, idempotencyKey: string): Promise<void> {
    const payloadHash = hashCommandPayload({ arm: 'discard', tenantId: command.tenantId, invoiceId: command.invoiceId });

    await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      if ((await this.replay(tx, command.tenantId, idempotencyKey, payloadHash)) !== null) return;
      const row = await this.lockInvoiceInTx(tx, command.tenantId, command.invoiceId);
      if ((await this.replay(tx, command.tenantId, idempotencyKey, payloadHash)) !== null) return;
      if (row.status !== 'draft') throw invoiceNotDraft(row);

      await tx.delete(clientInvoiceLines).where(and(eq(clientInvoiceLines.tenantId, command.tenantId), eq(clientInvoiceLines.invoiceId, row.id)));
      await tx.delete(clientInvoices).where(and(eq(clientInvoices.tenantId, command.tenantId), eq(clientInvoices.id, row.id)));
      await this.audit(tx, command, 'client_invoice.discarded', row.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, { invoiceId: row.id, discarded: true });
    });
  }

  /**
   * Dispute, settle or void an issued invoice: `issued → disputed | settled
   * | void`, `disputed → settled | void` — any other move is 409
   * `invoice-transition-invalid`. Dispute and void need a note (400, above
   * the transaction); `status_note` holds the transition's own note (null
   * when none) and the audit row keeps every one. A void keeps its number.
   */
  async transition(command: TransitionClientInvoiceCommand, idempotencyKey: string): Promise<ClientInvoiceMutationResult> {
    const note = normalizeNote(command.note);
    assertTransitionNote(command.verb, note);
    const target = CLIENT_INVOICE_VERBS[command.verb];
    const payloadHash = hashCommandPayload({ arm: command.verb, tenantId: command.tenantId, invoiceId: command.invoiceId, note });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as ClientInvoiceMutationResult;
      const row = await this.lockInvoiceInTx(tx, command.tenantId, command.invoiceId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as ClientInvoiceMutationResult;

      const from = row.status as ClientInvoiceStatus;
      if (!CLIENT_INVOICE_TRANSITIONS[from].includes(target)) {
        throw new ProblemException(
          'invoice-transition-invalid',
          409,
          'Not an allowed invoice transition',
          `Invoice ${row.invoiceNo ?? row.id} is ${from} — it cannot become ${target}. Allowed: issued → disputed, settled or void; disputed → settled or void.`,
        );
      }
      const now = nowIso();
      const updated = await tx
        .update(clientInvoices)
        .set({
          status: target,
          // Each transition stores its own note (or none): a settle never
          // inherits the dispute's reason. The audit keeps every note.
          statusNote: note,
          statusChangedAt: now,
          statusChangedBy: command.actorUserId,
          updatedAt: now,
        })
        .where(and(eq(clientInvoices.tenantId, command.tenantId), eq(clientInvoices.id, row.id), eq(clientInvoices.status, from)))
        .returning();
      const result: ClientInvoiceMutationResult = { invoice: await viewOfInTx(tx, updated[0]!) };
      const action: AuditAction =
        target === 'disputed' ? 'client_invoice.disputed' : target === 'settled' ? 'client_invoice.settled' : 'client_invoice.voided';
      await this.audit(tx, command, action, row.id, note === null ? idempotencyKey : `note: ${note} (key ${idempotencyKey})`);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  // ── reads (member-open; a client-portal session is refused) ───────────────

  async list(tenantId: string, actorUserId: string, query: ListClientInvoicesQuery = {}): Promise<Page<ClientInvoiceEntryView>> {
    const limit = Math.min(Math.max(query.limit ?? CLIENT_INVOICE_LIST_DEFAULT_LIMIT, 1), CLIENT_INVOICE_LIST_MAX_LIMIT);
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) throw portalRefused();
      const rows = await tx
        .select({ row: clientInvoices, createdAtText: sql<string>`${clientInvoices.createdAt}::text` })
        .from(clientInvoices)
        .where(
          and(
            eq(clientInvoices.tenantId, tenantId),
            query.clientId === undefined ? undefined : eq(clientInvoices.clientId, query.clientId),
            query.status === undefined ? undefined : eq(clientInvoices.status, query.status),
            before === undefined
              ? undefined
              : sql`(${clientInvoices.createdAt}, ${clientInvoices.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(clientInvoices.createdAt), desc(clientInvoices.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((item) => toEntryView(item.row)),
        nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: fullPrecisionInstant(last.createdAtText), id: last.row.id }) : null,
      };
    });
  }

  async get(tenantId: string, actorUserId: string, invoiceId: string): Promise<ClientInvoiceView> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) throw portalRefused();
      if (!UUID_RE.test(invoiceId)) throw clientInvoiceNotFound(invoiceId);
      const rows = await tx
        .select()
        .from(clientInvoices)
        .where(and(eq(clientInvoices.tenantId, tenantId), eq(clientInvoices.id, invoiceId)))
        .limit(1);
      if (rows[0] === undefined) throw clientInvoiceNotFound(invoiceId);
      return viewOfInTx(tx, rows[0]);
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async contextInTx(
    tx: TenantTx,
    tenantId: string,
  ): Promise<{ supplier: ClientInvoiceSupplierFacts; groups: SupplierGroup[]; states: GstStateResolver }> {
    const supplier = await clientInvoiceSupplierFactsInTx(tx, tenantId);
    return { supplier, groups: supplierGroups(supplier), states: await this.invoicing.gstStateResolverInTx(tx) };
  }

  /** Meter the month over the group's warehouses and compute the draft. */
  private async computeInTx(
    tx: TenantTx,
    tenantId: string,
    client: ClientSnapshot,
    group: SupplierGroup,
    periodStart: string,
    periodEnd: string,
    context: { supplier: ClientInvoiceSupplierFacts; states: GstStateResolver },
  ): Promise<ComputedDraft> {
    const narrowed = await this.metering.meterPeriodInTx(tx, tenantId, client.id, periodStart, periodEnd, {
      warehouseIds: group.warehouses.map((warehouse) => warehouse.id),
    });
    // The line quantities are the group's; the `storage-not-complete` gap
    // reads the CLIENT's watermark (the frozen Boundaries) — a group with
    // counts but no stock events has no snapshot scope of its own.
    const metered = {
      ...narrowed,
      storageCompleteThrough: await this.metering.clientStorageCompleteThroughInTx(tx, tenantId, client.id),
    };
    const eInvoiceApplies = group.supplierGstin === null ? false : await this.invoicing.eInvoiceAppliesInTx(tx, tenantId, group.supplierGstin);
    const draft = computeClientInvoiceDraft({
      periodStart,
      periodEnd,
      tenantName: context.supplier.tenantName,
      group,
      client,
      metered,
      eInvoiceApplies,
      states: context.states,
    });
    // Story 21-5b: the storage lines counted the GROUP's measured days (the
    // narrowed watermark), clipped to the month — what the drill lists.
    return { ...draft, storageMeasuredThrough: measuredThroughOf(narrowed.storageCompleteThrough, periodStart, periodEnd) };
  }

  private draftColumns(draft: ComputedDraft) {
    return {
      storageMeasuredThrough: draft.storageMeasuredThrough,
      placeOfSupply: draft.placeOfSupply,
      supplyType: draft.supplyType,
      subtotalPaise: draft.totals.subtotalPaise,
      cgstPaise: draft.totals.cgstPaise,
      sgstPaise: draft.totals.sgstPaise,
      igstPaise: draft.totals.igstPaise,
      taxPaise: draft.totals.taxPaise,
      totalPaise: draft.totals.totalPaise,
      roundOffPaise: draft.totals.roundOffPaise,
      payablePaise: draft.totals.payablePaise,
      gaps: draft.gaps,
      warnings: draft.warnings,
      party: draft.party,
      contentHash: draft.contentHash,
    };
  }

  private async insertDraftInTx(
    tx: TenantTx,
    command: { tenantId: string; actorUserId: string },
    clientId: string,
    draft: ComputedDraft,
    replacesInvoiceId: string | null,
  ): Promise<ClientInvoice> {
    let row: ClientInvoice;
    try {
      const rows = await tx
        .insert(clientInvoices)
        .values({
          id: uuidv7(),
          tenantId: command.tenantId,
          clientId,
          periodStart: draft.periodStart,
          periodEnd: draft.periodEnd,
          status: 'draft',
          supplierGstin: draft.supplierGstin,
          ...this.draftColumns(draft),
          replacesInvoiceId,
          createdBy: command.actorUserId,
        })
        .returning();
      row = rows[0]!;
    } catch (err) {
      if (isUniqueViolationOn(err, ONE_LIVE_INDEX)) {
        throw new ProblemException(
          'invoice-exists',
          409,
          'A live invoice already exists',
          `A live (not void) invoice already covers ${draft.periodStart.slice(0, 7)} under ${draft.supplierGstin ?? 'this registration'} for this client — reload.`,
        );
      }
      throw err;
    }
    await this.insertLinesInTx(tx, row, draft.lines);
    return row;
  }

  private async rewriteDraftInTx(tx: TenantTx, row: ClientInvoice, draft: ComputedDraft): Promise<ClientInvoice> {
    await tx.delete(clientInvoiceLines).where(and(eq(clientInvoiceLines.tenantId, row.tenantId), eq(clientInvoiceLines.invoiceId, row.id)));
    await this.insertLinesInTx(tx, row, draft.lines);
    const rows = await tx
      .update(clientInvoices)
      .set({ ...this.draftColumns(draft), updatedAt: nowIso() })
      .where(and(eq(clientInvoices.tenantId, row.tenantId), eq(clientInvoices.id, row.id), eq(clientInvoices.status, 'draft')))
      .returning();
    return rows[0]!;
  }

  /**
   * Story 21-5b — a refresh whose figures did not move still records the
   * group's measured-through day when it moved (a watermark crossing only
   * zero-stock days changes no figure). Only that column — the row and its
   * lines are otherwise untouched (`updated_at` included); nothing at all
   * when it is unchanged.
   */
  private async restampMeasuredThroughInTx(tx: TenantTx, row: ClientInvoice, measuredThrough: string): Promise<ClientInvoice> {
    if (row.storageMeasuredThrough === measuredThrough) return row;
    const rows = await tx
      .update(clientInvoices)
      .set({ storageMeasuredThrough: measuredThrough })
      .where(and(eq(clientInvoices.tenantId, row.tenantId), eq(clientInvoices.id, row.id), eq(clientInvoices.status, 'draft')))
      .returning();
    return rows[0]!;
  }

  private async insertLinesInTx(tx: TenantTx, row: ClientInvoice, lines: readonly ClientInvoiceDraftLine[]): Promise<void> {
    if (lines.length === 0) return;
    await tx.insert(clientInvoiceLines).values(
      lines.map((line) => ({
        id: uuidv7(),
        tenantId: row.tenantId,
        invoiceId: row.id,
        rateCardId: line.rateCardId,
        segmentFrom: line.segmentFrom,
        segmentTo: line.segmentTo,
        chargeCode: line.chargeCode,
        basis: line.basis,
        uom: line.uom,
        // A storage quantity (milli-unit-days) can pass 2⁵³ — bound as text, cast in SQL.
        quantity: sql`${line.quantity.toString()}::bigint`,
        unitAmountPaise: line.unitAmountPaise,
        amountPaise: line.amountPaise,
        sacCode: line.sacCode,
        gstBps: line.gstBps,
        placeOfSupply: line.placeOfSupply,
        supplyType: line.supplyType,
        cgstPaise: line.cgstPaise,
        sgstPaise: line.sgstPaise,
        igstPaise: line.igstPaise,
      })),
    );
  }

  /** The latest void of the group that nothing has replaced yet (the next draft names it). */
  private async latestUnreplacedVoidInTx(
    tx: TenantTx,
    tenantId: string,
    clientId: string,
    periodStart: string,
    supplierGstin: string | null,
  ): Promise<string | null> {
    const rows = (await tx.execute(sql`
      select v.id as "id"
      from client_invoices v
      where v.tenant_id = ${tenantId}::uuid
        and v.client_id = ${clientId}::uuid
        and v.period_start = ${periodStart}::date
        and coalesce(v.supplier_gstin, '') = ${supplierGstin ?? ''}
        and v.status = 'void'
        and not exists (
          select 1 from client_invoices r
          where r.tenant_id = v.tenant_id and r.replaces_invoice_id = v.id
        )
      order by v.status_changed_at desc, v.id desc
      limit 1
    `)) as unknown as { id: string }[];
    return rows[0]?.id ?? null;
  }

  /**
   * The next number of the (tenant, supplying GSTIN, FY) series: the row is
   * inserted ON CONFLICT DO NOTHING, then taken FOR UPDATE — a concurrent
   * first issue of the same series waits on the lock and reads the winner's
   * settled value; the sequence comes from the lock, never from a read.
   */
  private async allocateSeqInTx(tx: TenantTx, tenantId: string, supplierGstin: string, fyLabel: string): Promise<number> {
    await tx
      .insert(clientInvoiceSeries)
      .values({ id: uuidv7(), tenantId, supplierGstin, fyLabel, lastSeq: 0 })
      .onConflictDoNothing({ target: [clientInvoiceSeries.tenantId, clientInvoiceSeries.supplierGstin, clientInvoiceSeries.fyLabel] });
    const rows = await tx
      .select()
      .from(clientInvoiceSeries)
      .where(
        and(
          eq(clientInvoiceSeries.tenantId, tenantId),
          eq(clientInvoiceSeries.supplierGstin, supplierGstin),
          eq(clientInvoiceSeries.fyLabel, fyLabel),
        ),
      )
      .limit(1)
      .for('update');
    const series = rows[0]!;
    const seq = Number(series.lastSeq) + 1;
    await tx
      .update(clientInvoiceSeries)
      .set({ lastSeq: seq, updatedAt: nowIso() })
      .where(eq(clientInvoiceSeries.id, series.id));
    return seq;
  }

  /** Find the invoice's client (404), lock the client row, then the invoice row. */
  private async lockClientAndInvoiceInTx(
    tx: TenantTx,
    tenantId: string,
    invoiceId: string,
  ): Promise<{ row: ClientInvoice; client: ClientSnapshot }> {
    if (!UUID_RE.test(invoiceId)) throw clientInvoiceNotFound(invoiceId);
    const found = await tx
      .select({ clientId: clientInvoices.clientId })
      .from(clientInvoices)
      .where(and(eq(clientInvoices.tenantId, tenantId), eq(clientInvoices.id, invoiceId)))
      .limit(1);
    if (found[0] === undefined) throw clientInvoiceNotFound(invoiceId);
    await lockClientInTx(tx, tenantId, found[0].clientId);
    const row = await this.lockInvoiceInTx(tx, tenantId, invoiceId);
    return { row, client: await getClientInTx(tx, tenantId, row.clientId) };
  }

  private async lockInvoiceInTx(tx: TenantTx, tenantId: string, invoiceId: string): Promise<ClientInvoice> {
    if (!UUID_RE.test(invoiceId)) throw clientInvoiceNotFound(invoiceId);
    const rows = await tx
      .select()
      .from(clientInvoices)
      .where(and(eq(clientInvoices.tenantId, tenantId), eq(clientInvoices.id, invoiceId)))
      .orderBy(asc(clientInvoices.id))
      .limit(1)
      .for('update');
    if (rows[0] === undefined) throw clientInvoiceNotFound(invoiceId);
    return rows[0];
  }

  private async replay(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<unknown> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot;
  }

  private async audit(
    tx: TenantTx,
    command: { tenantId: string; actorUserId: string },
    action: AuditAction,
    invoiceId: string,
    reference: string,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      action,
      targetType: 'client_invoice',
      targetId: invoiceId,
      reference,
      occurredAt: nowIso(),
    });
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: unknown,
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key: idempotencyKey, payloadHash, responseSnapshot: snapshot });
    } catch (err) {
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        throw new ProblemException(
          'conflict',
          409,
          'Concurrent idempotent request',
          'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
        );
      }
      throw err;
    }
  }
}

/** The tenant's own client is never invoiced (409 `client-not-billable`). */
function assertBillableClient(client: ClientSnapshot): void {
  if (client.systemOwned) {
    throw new ProblemException(
      'client-not-billable',
      409,
      'Your own company is not invoiced',
      "Client invoices bill a client brand for storage and handling — the tenant's own client is never billed.",
    );
  }
}

/** The month must have ended on the command clock (409 `period-not-ended`). */
function assertPeriodEnded(periodEnd: string): void {
  const endsAt = Date.parse(istMidnightOf(addIsoDays(periodEnd, 1)));
  if (clientInvoiceClock.now() < endsAt) {
    throw new ProblemException(
      'period-not-ended',
      409,
      'The month has not ended',
      `${periodEnd.slice(0, 7)} runs to ${periodEnd} (IST) — a month is invoiced only after it ends.`,
    );
  }
}

function clientNotFoundProblem(clientId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Client not found', `No client with id "${clientId}" exists in this tenant.`);
}

export function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    if (!UUID_RE.test(decoded.id) || !CURSOR_INSTANT_RE.test(decoded.createdAt) || Number.isNaN(Date.parse(decoded.createdAt))) {
      throw new Error('malformed cursor payload');
    }
    return decoded;
  } catch {
    throw new ProblemException('invalid-cursor', 400, 'Malformed pagination cursor', 'The cursor parameter is not a valid opaque page cursor.');
  }
}
