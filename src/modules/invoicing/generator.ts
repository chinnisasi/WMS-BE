import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  gstStateCodes,
  invoiceLines,
  invoiceSeries,
  invoices,
  type InvoiceLine,
} from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { isGstinStateCode } from '../../shared/primitives/gstin';
import { nicText } from '../../shared/primitives/nic-text';
import { IST_OFFSET_MS, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { OutboundFacade } from '../outbound/outbound.facade';
import type { OrderInvoiceFacts } from '../outbound/outbound.facade';
import { invoicePartyFactsInTx } from '../tenancy/tenancy.service';
import type { InvoicePartyFacts } from '../tenancy/tenancy.service';
import {
  ArithmeticOverflowError,
  asGstBps,
  asPaise,
  assertInvoiceTotals,
  computeLineTax,
  roundToRupee,
  type SupplyType,
} from './arith';
import { isValidHsn, normalizeHsn } from './hsn';
import { fyLabelFor, formatInvoiceNo } from '../../shared/primitives/gst';

/**
 * The derive-from-facts generator (story 8-1): ONE computation both the
 * delivery handler (over `order.dispatched`) and the manual
 * generate/regenerate command run — the spec's "generation re-derives from
 * `orders`/`order_lines`/`picks`/`warehouses`/`skus` via facades — never
 * trusts the payload"; retries are idempotent by derivation, not by caching.
 *
 * In-tx ONLY: the facts read, the party facts, the state-code table, the
 * series-row lock and the invoice writes compose in ONE tenant transaction
 * (the `getPickTasksInTx` pool rule). The command and the delivery handler
 * open their own tenant transactions and call down to `generateCoreInTx`.
 */

export const INVOICE_STATUSES = ['awaiting-data', 'issued', 'voided'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const RATE_SOURCES = ['order_line', 'manual'] as const;
export type RateSource = (typeof RATE_SOURCES)[number];

/** One operator-supplied rate override (the manual pricing arm). */
export interface RateOverride {
  readonly orderLineId: string;
  readonly ratePaise: number;
}

/**
 * The gap kinds. `unpriced-line` / `place-of-supply` / `supplier-gstin` are
 * BLOCKING (they park the invoice `awaiting-data`); every other kind is a
 * WARNING (the invoice issues with the gap visible in the document).
 * Deliberately a single `place-of-supply` kind for both unresolvable sides —
 * the detail names which side and why. `supplier-gstin` (8-1 code review):
 * neither the warehouse nor the tenant carries a GSTIN, so no tax invoice
 * can be issued in the supplier's name — the origin may still resolve from
 * address text, which is why it is its own kind.
 *
 * The warnings:
 * - `hsn-gap` — the line's HSN is null (blank in the catalog);
 * - `hsn-invalid` (8-1d) — the line's HSN is non-null but, after the shared
 *   normaliser, blank or not 4/6/8 digits (`hsn.ts`). Exclusive with
 *   `hsn-gap`; the HSN summary flags it and an e-way bill blocks on it;
 * - `pos-discrepancy` — a side's GSTIN and address text name different
 *   states (the GSTIN wins); the detail names the e-way consequence;
 * - `gstin-prefix-unknown` (8-1d) — a side's stored GSTIN prefix is not a
 *   registration state code (a legacy row; entry now refuses it), so the
 *   side resolved from its address text;
 * - `state-text-unknown` (8-1d) — a side's address state is not on the
 *   official list, or is missing (no address, or a blank state), so the side
 *   resolved from its GSTIN (an e-way bill blocks on `state-unresolved`, or
 *   `address-incomplete` when there is no address);
 * - `party-name-unprintable` (8-1d) — the seller or buyer name has no
 *   character NIC's text rule keeps (`nicText`), so the e-way bill would
 *   print it blank and block on `address-incomplete`.
 *
 * New kinds append at the end: the order of this tuple is the OpenAPI enum's.
 */
export const GAP_KINDS = [
  'unpriced-line',
  'place-of-supply',
  'supplier-gstin',
  'hsn-gap',
  'pos-discrepancy',
  'hsn-invalid',
  'state-text-unknown',
  'gstin-prefix-unknown',
  'party-name-unprintable',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/** The gap kinds that park an invoice `awaiting-data`. */
const BLOCKING_GAP_KINDS: ReadonlySet<GapKind> = new Set<GapKind>(['unpriced-line', 'place-of-supply', 'supplier-gstin']);

export interface InvoiceGap {
  readonly kind: GapKind;
  readonly detail: string;
  /**
   * The order line a LINE-scoped gap (`unpriced-line`, `hsn-gap`,
   * `hsn-invalid`) is about —
   * structured so a client can act on it (the pricing dialog lists exactly
   * these lines) without parsing `detail` prose. Absent on the
   * invoice-scoped kinds. Additive to the pinned snapshot shape (8-1 FE).
   */
  readonly orderLineId?: string;
}

/** One priced line of the pinned document snapshot (Design Notes shape). */
export interface InvoiceDocumentLine {
  readonly orderLineId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly hsn: string | null;
  readonly qtyMilli: number;
  readonly uom: string;
  readonly ratePaise: number;
  readonly rateSource: RateSource;
  readonly taxablePaise: number;
  readonly gstBps: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly hsnGap: boolean;
}

/** The pinned client-agnostic document snapshot (Design Notes shape). */
export interface InvoiceDocument {
  readonly header: {
    readonly invoiceNo: string | null;
    readonly fyLabel: string | null;
    readonly orderRef: string;
    readonly issuedAt: string | null;
    readonly supplyType: SupplyType | null;
    readonly placeOfSupply: string | null;
    readonly originGstin: string | null;
    readonly consigneeGstin: string | null;
    readonly originAddress: InvoicePartyFacts['originAddress'];
    readonly consigneeAddress: OrderInvoiceFacts['destination'];
  };
  readonly seller: { readonly name: string; readonly gstin: string | null };
  readonly buyer: { readonly name: string | null; readonly gstin: string | null };
  readonly lines: readonly InvoiceDocumentLine[];
  /**
   * Story 8-1b: `total` is the exact paise sum (8-1's `payAble`, renamed);
   * `payable` is the rupee-rounded amount due and `roundOff = payable − total`
   * (signed, −49…+50) — both stored, printed as the "Round off" line.
   */
  readonly totals: {
    readonly subtotal: number;
    readonly gst: number;
    readonly total: number;
    readonly roundOff: number;
    readonly payable: number;
  };
  readonly gaps: readonly InvoiceGap[];
  readonly revision: number;
}

/** One computed line, before storage (the invoice_lines insert's body). */
type InvoiceLineDraft = InvoiceDocumentLine;

/** The computation's result, before the row write. */
export interface InvoiceDraft {
  readonly facts: OrderInvoiceFacts;
  readonly party: InvoicePartyFacts;
  readonly status: InvoiceStatus;
  readonly supplyType: SupplyType | null;
  readonly placeOfSupply: string | null;
  readonly originGstin: string | null;
  readonly consigneeGstin: string | null;
  readonly lines: readonly InvoiceLineDraft[];
  readonly subtotalPaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
  readonly payablePaise: number;
  readonly roundOffPaise: number;
  readonly gaps: readonly InvoiceGap[];
}

// ── FY numbering ─────────────────────────────────────────────────────────────

/**
 * India is UTC+05:30 year-round (no DST) — the FY is read off the IST clock.
 * Story 9-1 moved the constant to `shared/primitives/time.ts` (reporting's
 * IST windows read it too); re-exported here so invoicing's importers stand.
 */
export { IST_OFFSET_MS };

/**
 * The FY label, the Rule 46 length ceiling and the goods number format moved
 * UNCHANGED to `shared/primitives/gst.ts` (story 21-5: the services invoice
 * shares the FY rule and numbers beside them with `formatServiceInvoiceNo`).
 * Re-exported here so invoicing's importers stand.
 */
export { fyLabelFor, formatInvoiceNo, INVOICE_NO_MAX_LENGTH } from '../../shared/primitives/gst';

/**
 * The series-row allocation: one row per (tenant, supplier GSTIN, FY),
 * `last_seq` advanced under the row's FOR UPDATE lock (the concurrency
 * guarantee behind gap-free numbering). Absent row → inserted then
 * re-locked: a concurrent first issuance of a DIFFERENT order for the same
 * GSTIN and FY holds the lock, the ON-CONFLICT-DO-NOTHING insert loses
 * silently, and the re-select waits for the winner's commit and reads its
 * settled value — the seq comes from the lock, never from the read.
 *
 * The unique is PARTIAL (`WHERE origin_gstin IS NOT NULL` — legacy 8-1
 * per-tenant rows carry NULL), and Postgres infers a partial unique index as
 * the conflict arbiter only when the ON CONFLICT clause states the matching
 * predicate: the `where` below is load-bearing, not decoration.
 */
async function allocateSeriesSeq(tx: TenantTx, tenantId: string, originGstin: string, fy: string): Promise<number> {
  const scope = and(
    eq(invoiceSeries.tenantId, tenantId),
    eq(invoiceSeries.originGstin, originGstin),
    eq(invoiceSeries.fyLabel, fy),
  );
  let rows = await tx.select().from(invoiceSeries).where(scope).limit(1).for('update');
  if (rows[0] === undefined) {
    await tx
      .insert(invoiceSeries)
      .values({ tenantId, originGstin, fyLabel: fy, lastSeq: 0 })
      .onConflictDoNothing({
        target: [invoiceSeries.tenantId, invoiceSeries.originGstin, invoiceSeries.fyLabel],
        where: sql`origin_gstin is not null`,
      });
    rows = await tx.select().from(invoiceSeries).where(scope).limit(1).for('update');
  }
  const row = rows[0]!;
  const seq = Number(row.lastSeq) + 1;
  await tx.update(invoiceSeries).set({ lastSeq: seq }).where(eq(invoiceSeries.id, row.id));
  return seq;
}

// ── CBIC state-code resolution ──────────────────────────────────────────────

/** One member of the official list, as the resolution functions see it. */
export interface StateCodeEntry {
  readonly stateCode: string;
  readonly stateName: string;
}

/**
 * The tiny alias list over the OFFICIAL seeded names — historical spellings
 * a destination address may carry (`Orissa` was renamed Odisha in 2011,
 * `Pondicherry` Puducherry in 2006, `Uttaranchal` Uttarakhand in 2007). The
 * seeded rows stay the official 38; normalization is lower-case/trim/
 * collapse-`&`-to-`and`, then this map.
 */
const STATE_NAME_ALIASES: Readonly<Record<string, string>> = {
  orissa: 'odisha',
  pondicherry: 'puducherry',
  uttaranchal: 'uttarakhand',
};

export function normalizeStateName(state: string | null | undefined): string {
  if (state === undefined || state === null) return '';
  return state
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ');
}

/**
 * Place-of-supply resolution (Design Notes): a GSTIN's first two digits ARE
 * the state code and OUTRANK address text for registered parties; the
 * text-based lookup exists for the GSTIN-lacking (B2C) arm. A GSTIN/text
 * MISMATCH is reported (a `pos-discrepancy` warning) and the GSTIN wins.
 * Unresolvable → null (a blocking `place-of-supply` gap — the invoice parks
 * `awaiting-data`).
 *
 * Story 8-1d, two ADDITIVE signals for the issue-time warnings (the existing
 * fields are unchanged):
 * - `gstinKnown` — a GSTIN was given AND its prefix is in
 *   `codeByGstinPrefix` (the generator builds that map from registration
 *   state codes only, so a legacy `92…`/`99…` GSTIN is not known and the
 *   side falls back to its address text);
 * - `textUnresolved` — the address state text is non-blank but not on the
 *   list (aliases applied), so the side resolved from its GSTIN.
 */
export function resolveStateCode(
  codeByGstinPrefix: ReadonlyMap<string, StateCodeEntry>,
  codeByStateName: ReadonlyMap<string, StateCodeEntry>,
  gstin: string | null,
  stateText: string | null,
): { code: string; name: string; textCode: string | null; gstinKnown: boolean; textUnresolved: boolean } | null {
  const gstinCode = gstin !== null ? codeByGstinPrefix.get(gstin.slice(0, 2)) ?? null : null;
  const normalized = normalizeStateName(stateText);
  if (normalized === '') {
    return gstinCode === null
      ? null
      : { code: gstinCode.stateCode, name: gstinCode.stateName, textCode: null, gstinKnown: true, textUnresolved: false };
  }
  const aliased = STATE_NAME_ALIASES[normalized] ?? normalized;
  const fromText = codeByStateName.get(aliased) ?? null;
  const resolved = gstinCode ?? fromText;
  if (resolved === null) {
    return null;
  }
  return {
    code: resolved.stateCode,
    name: resolved.stateName,
    textCode: fromText === null ? null : fromText.stateCode,
    gstinKnown: gstinCode !== null,
    textUnresolved: fromText === null,
  };
}

/** The e-way consequence the issue-time warnings name (8-1d) — the blocker is terminal on a frozen invoice. */
function ewayWillBlock(blocker: 'ship-to-differs' | 'state-unresolved' | 'hsn-issue' | 'address-incomplete'): string {
  return `if an e-way bill is required it will be blocked (${blocker}); generate it on the portal`;
}

// ── refusals (the generator throws them; the HTTP arms live on the command) ─

function invoiceNotFound(): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Order not found',
    'No order with this id exists in this tenant — there is nothing to invoice.',
  );
}

export function orderNotDispatched(status: string): ProblemException {
  return new ProblemException(
    'order-not-dispatched',
    409,
    'Order is not dispatched',
    `Order reads "${status}" — invoices derive from dispatched orders only; dispatch it first.`,
  );
}

/**
 * An override naming a line that already carries its acceptance-time rate
 * (8-1 code review): `order_lines.rate_paise` is the frozen point-in-time
 * truth and always wins; the override path prices UNPRICED lines only.
 */
export function lineAlreadyPriced(lineId: string): ProblemException {
  return new ProblemException(
    'line-already-priced',
    409,
    'Rate line is already priced',
    `Rate override names orderLineId "${lineId}", which carries the rate frozen at order acceptance — overrides price unpriced lines only.`,
  );
}

export function lineNotOfOrder(lineId: string): ProblemException {
  return new ProblemException(
    'line-not-of-order',
    409,
    'Rate line is not of this order',
    `Rate override names orderLineId "${lineId}" which is not a line of this order.`,
  );
}

/**
 * Rates sent to an issued (or voided) invoice (story 8-1b). An issued invoice
 * is a frozen legal document: generation never recomputes or rewrites it, so
 * an override could only be silently ignored — refused instead. It outranks
 * the line checks (`line-not-of-order`, `line-already-priced`): whatever the
 * lines say, nothing about a frozen invoice can change. Corrections need
 * credit/debit notes (deferred).
 */
export function invoiceFrozen(status: string, invoiceNo: string | null): ProblemException {
  return new ProblemException(
    'invoice-frozen',
    409,
    'Invoice is frozen',
    `The invoice for this order is ${status}${invoiceNo === null ? '' : ` (${invoiceNo})`} — an issued invoice is never re-priced or rewritten; corrections need a credit or debit note.`,
  );
}

/**
 * Story 21-2b (decision 5) — a client brand's order is NOT GST-invoiced by
 * the 3PL: the brand sells its own goods and invoices its own customer,
 * while the 3PL bills the brand for services (21-5, SAC codes). Only an
 * order whose client is the tenant's own (`system_owned`) gets a tax invoice
 * — and therefore an e-way bill, which queues off `invoice.issued`.
 * Invoicing on a client's behalf is PENDING. A 409: the manual generate
 * answers it; the dispatch delivery handler acks it with a log line.
 */
export class ClientOrderNotInvoicedError extends ProblemException {
  constructor(readonly orderId: string) {
    super(
      'client-order-not-invoiced',
      409,
      'Client orders are not invoiced by the warehouse',
      `Order ${orderId} is for a client brand, not the tenant's own goods — the brand invoices its own customer, so no tax invoice or e-way bill is issued here.`,
    );
  }
}

/** Story 21-2b — the order's client row does not exist (a data fault). */
export function orderClientMissing(orderId: string): ProblemException {
  return new ProblemException(
    'order-client-missing',
    409,
    "The order's client does not exist",
    `Order ${orderId} names a client that does not exist in this tenant — no invoice can be attributed. Fix the data, then regenerate.`,
  );
}

/** The loser of the ONE-invoice-per-order insert race (the unique violation). */
export class InvoiceRaceLostError extends Error {
  constructor(
    readonly tenantId: string,
    readonly orderId: string,
  ) {
    super(`invoice generation race lost for order ${orderId}`);
  }
}

/**
 * What a generation attempt returns: the settled row (the winner's after a
 * race loss is adopted by the caller), whether the CONTENT changed (the
 * revision-bump decision's input — an identical regenerate is false), and
 * whether this attempt flipped the invoice to `issued` (the
 * `invoice.issued` emission's gate — BOTH writers emit in their own
 * transaction only on that flip).
 */
export interface InvoiceGenerationOutcome {
  readonly invoiceId: string;
  readonly orderId: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly invoiceNo: string | null;
  readonly fyLabel: string | null;
  readonly seriesSeq: number | null;
  readonly status: InvoiceStatus;
  readonly revision: number;
  readonly subtotalPaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
  /** The rupee-rounded payable and its signed round-off (story 8-1b). */
  readonly payablePaise: number;
  readonly roundOffPaise: number;
  /** The supplier GSTIN the invoice is issued under (its series' key). */
  readonly originGstin: string | null;
  readonly document: InvoiceDocument;
  /** This attempt's write changed content (a replay/identical pass is false). */
  readonly contentChanged: boolean;
  /** This attempt flipped the invoice to `issued` (first issuance). */
  readonly firstIssuance: boolean;
}

@Injectable()
export class InvoiceGenerator {
  private readonly logger = new Logger(InvoiceGenerator.name);

  constructor(@Inject(OutboundFacade) private readonly outbound: OutboundFacade) {}

  /**
   * The generate/regenerate core, called INSIDE the caller's tenant
   * transaction. Locks the order's invoice row first, then reads the
   * dispatch facts through the outbound facade and the party facts through
   * the tenancy seam, computes, and settles the ONE invoice row:
   *
   *   issued / voided → FROZEN (story 8-1b): returned from the stored row
   *   before any fact is read — no recompute, no write, no revision bump, no
   *   event, whatever the catalog now says. Non-empty overrides are refused
   *   `409 invoice-frozen` (they could only be silently ignored);
   *   absent → INSERT (a concurrent twin's unique violation throws
   *   `InvoiceRaceLostError` — the caller adopts the winner with a fresh
   *   transaction; this one rolls back whole);
   *   awaiting-data → content-compare: identical → nothing written (a pure
   *   re-derivation pass); changed → revision bump + column update + line
   *   rewrite (the lines table is the computation's OUTPUT, rebuilt whole —
   *   it carries no identity of its own).
   *
   * A flip to `issued` allocates the sequence of the supplier GSTIN's own
   * FY series under its series-row lock and stamps `invoice_no` /
   * `fy_label` / `series_seq` — once; the freeze above is what makes the
   * number (and everything else on the document) forever.
   */
  async generateCoreInTx(
    tx: TenantTx,
    tenantId: string,
    orderId: string,
    overrides: readonly RateOverride[],
  ): Promise<InvoiceGenerationOutcome> {
    // 1. The CURRENT invoice row, locked FIRST: it is the upsert's lock, the
    // freeze's input, and (for an awaiting row) the carrier of the frozen
    // manual rates. Locking before the facts read means a concurrent
    // awaiting→issued flip is observed here, after its commit — the waiter
    // then reads `issued` and freezes rather than recomputing over it.
    const existingRows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.orderId, orderId)))
      .limit(1)
      .for('update');
    const existing = existingRows[0];

    // 2. The freeze (story 8-1b). An issued or voided invoice is a legal
    // document: it short-circuits BEFORE the facts read, the override checks
    // and the computation — a later catalog edit can never reach it.
    if (existing !== undefined && (existing.status === 'issued' || existing.status === 'voided')) {
      if (overrides.length > 0) {
        throw invoiceFrozen(existing.status, existing.invoiceNo);
      }
      return {
        invoiceId: existing.id,
        orderId,
        tenantId,
        warehouseId: existing.warehouseId,
        invoiceNo: existing.invoiceNo,
        fyLabel: existing.fyLabel,
        seriesSeq: existing.seriesSeq === null ? null : Number(existing.seriesSeq),
        status: existing.status as InvoiceStatus,
        revision: existing.revision,
        subtotalPaise: Number(existing.subtotalPaise),
        gstPaise: Number(existing.gstPaise),
        totalPaise: Number(existing.totalPaise),
        payablePaise: Number(existing.payablePaise),
        roundOffPaise: Number(existing.roundOffPaise),
        originGstin: existing.originGstin,
        document: existing.document as InvoiceDocument,
        contentChanged: false,
        firstIssuance: false,
      };
    }

    // 3. The dispatch facts — generation re-derives, never trusts the
    // payload (unknown order → 404; not dispatched → 409; the delivery
    // handler surfaces both through its own error posture).
    const facts = await this.outbound.orderInvoiceFactsInTx(tx, tenantId, orderId);
    if (facts === null) {
      throw invoiceNotFound();
    }
    if (facts.status !== 'dispatched') {
      throw orderNotDispatched(facts.status);
    }
    // Story 21-2b (decision 5): no tax invoice for a client brand's order —
    // refused before anything is computed or written.
    if (facts.clientSystemOwned === null) {
      // A missing client row is a DATA FAULT (an order no client owns), not
      // the client-brand skip: its own 409, which the delivery handler logs
      // at error on its data-fault arm.
      throw orderClientMissing(orderId);
    }
    if (!facts.clientSystemOwned) {
      throw new ClientOrderNotInvoicedError(orderId);
    }

    // 4. The parties (tenancy's seam — invoicing writes no tenancy table).
    const party = await invoicePartyFactsInTx(tx, tenantId, facts.warehouseId);

    // 5. The state-code reference (global — no tenant scope, like app_metadata).
    // Story 8-1d: a GSTIN prefix resolves only through a REGISTRATION state
    // code (`isGstinStateCode` — the predicate entry refuses on), so a legacy
    // `99…` GSTIN falls back to its address text and warns, exactly like a
    // `92…` one. Address TEXT still resolves against every row.
    const codes = await tx.select().from(gstStateCodes);
    const codeByGstinPrefix = new Map<string, StateCodeEntry>(
      codes
        .filter((row) => isGstinStateCode(row.stateCode))
        .map((row) => [row.stateCode, { stateCode: row.stateCode, stateName: row.stateName }]),
    );
    const codeByStateName = new Map<string, StateCodeEntry>(
      codes.map((row) => [normalizeStateName(row.stateName), { stateCode: row.stateCode, stateName: row.stateName }]),
    );

    // 6. The awaiting row's lines: the document's frozen manual rates
    // re-apply on an operator regenerate that sends no overrides.
    const existingLines: InvoiceLine[] =
      existing === undefined
        ? []
        : await tx
            .select()
            .from(invoiceLines)
            .where(and(eq(invoiceLines.tenantId, tenantId), eq(invoiceLines.invoiceId, existing.id)));
    const carriedManual = new Map<string, number>(
      existingLines
        .filter((line) => line.rateSource === 'manual')
        .map((line) => [line.orderLineId, Number(line.ratePaise)]),
    );

    // 7. Every override names an UNPRICED line OF this order — the two 409
    // arms (the frozen acceptance rate is never overridden).
    const overrideByLine = new Map(overrides.map((ov) => [ov.orderLineId, ov.ratePaise]));
    for (const lineId of overrideByLine.keys()) {
      const fact = facts.lines.find((line) => line.orderLineId === lineId);
      if (fact === undefined) {
        throw lineNotOfOrder(lineId);
      }
      if (fact.ratePaise !== null) {
        throw lineAlreadyPriced(lineId);
      }
    }

    const draft = this.computeDraft({
      facts,
      party,
      overrideByLine,
      carriedManual,
      codeByGstinPrefix,
      codeByStateName,
    });

    // 8. The issuance bookkeeping. `existing` (if any) is `awaiting-data`
    // here — the freeze returned every other status — so the settled status
    // is the draft's, and only a draft that settles `issued` takes a number.
    let invoiceNo: string | null = null;
    let fyLabel: string | null = null;
    let seriesSeq: number | null = null;
    let issuedAt: string | null = null;
    let firstIssuance = false;
    if (draft.status === 'issued') {
      if (draft.originGstin === null) {
        // Unreachable: a missing supplier GSTIN is a BLOCKING gap, so the
        // draft cannot settle issued without one. Named, because the
        // invoices_issued_stamped_check would otherwise refuse the write
        // with no context.
        throw new ArithmeticOverflowError(`order ${orderId}: an issued draft without a supplier GSTIN`);
      }
      // ONE instant for both the FY and the printed date — two clock reads
      // straddling 31 March midnight IST would number an invoice in one FY
      // and date it in the next.
      const issuedInstant = nowIso();
      const fy = fyLabelFor(issuedInstant);
      const seq = await allocateSeriesSeq(tx, tenantId, draft.originGstin, fy);
      invoiceNo = formatInvoiceNo(draft.originGstin, fy, seq);
      fyLabel = fy;
      seriesSeq = seq;
      issuedAt = issuedInstant;
      firstIssuance = true;
    }

    let revision = existing?.revision ?? 1;
    let document = this.buildDocument(draft, { invoiceNo, fyLabel, issuedAt, revision });
    const settled = {
      orderId,
      tenantId,
      warehouseId: facts.warehouseId,
      invoiceNo,
      fyLabel,
      seriesSeq,
      status: draft.status,
      subtotalPaise: draft.subtotalPaise,
      gstPaise: draft.gstPaise,
      totalPaise: draft.totalPaise,
      payablePaise: draft.payablePaise,
      roundOffPaise: draft.roundOffPaise,
      originGstin: draft.originGstin,
      firstIssuance,
    };

    // 9. The write.
    if (existing === undefined) {
      const invoiceId = uuidv7();
      try {
        await tx.insert(invoices).values({
          id: invoiceId,
          tenantId,
          orderId,
          warehouseId: facts.warehouseId,
          invoiceNo,
          fyLabel,
          seriesSeq,
          status: draft.status,
          originGstin: draft.originGstin,
          consigneeGstin: draft.consigneeGstin,
          placeOfSupply: draft.placeOfSupply,
          supplyType: draft.supplyType,
          subtotalPaise: draft.subtotalPaise,
          gstPaise: draft.gstPaise,
          totalPaise: draft.totalPaise,
          payablePaise: draft.payablePaise,
          roundOffPaise: draft.roundOffPaise,
          revision,
          document,
          // Story 8-2a: the read-model twin of `document.header.issuedAt` —
          // the SAME variable (one clock read), null while awaiting-data.
          issuedAt,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, 'invoices_tenant_order_unique')) {
          // A concurrent generation (event delivery vs command) won the
          // ONE-invoice index: this transaction rolls back whole and the
          // CALLER adopts the winner (fresh tx, re-read, return) — never a
          // 500, never a second row, never a double tax (the replay posture).
          throw new InvoiceRaceLostError(tenantId, orderId);
        }
        throw err;
      }
      await this.writeLines(tx, tenantId, invoiceId, draft.lines);
      return { ...settled, invoiceId, revision, document, contentChanged: true };
    }

    // 10. Regeneration of an awaiting row: content-compare → update or pure
    // no-op. The revision is stripped before the compare (its only job is to
    // NUMBER a change; it must never trigger its own bump).
    const priorDocument = existing.document as InvoiceDocument;
    if (documentsEqual(priorDocument, document)) {
      return {
        invoiceId: existing.id,
        orderId,
        tenantId,
        warehouseId: facts.warehouseId,
        invoiceNo: existing.invoiceNo,
        fyLabel: existing.fyLabel,
        seriesSeq: existing.seriesSeq === null ? null : Number(existing.seriesSeq),
        status: existing.status as InvoiceStatus,
        revision: existing.revision,
        subtotalPaise: Number(existing.subtotalPaise),
        gstPaise: Number(existing.gstPaise),
        totalPaise: Number(existing.totalPaise),
        payablePaise: Number(existing.payablePaise),
        roundOffPaise: Number(existing.roundOffPaise),
        originGstin: existing.originGstin,
        document: priorDocument,
        contentChanged: false,
        firstIssuance: false,
      };
    }

    revision = existing.revision + 1;
    document = this.buildDocument(draft, { invoiceNo, fyLabel, issuedAt, revision });
    await tx
      .update(invoices)
      .set({
        // The number columns ride the update so the PARKED→issued flip —
        // which allocated them under the series lock above — actually lands
        // them (the set is the settled row's whole content).
        invoiceNo,
        fyLabel,
        seriesSeq,
        status: draft.status,
        originGstin: draft.originGstin,
        consigneeGstin: draft.consigneeGstin,
        placeOfSupply: draft.placeOfSupply,
        supplyType: draft.supplyType,
        subtotalPaise: draft.subtotalPaise,
        gstPaise: draft.gstPaise,
        totalPaise: draft.totalPaise,
        payablePaise: draft.payablePaise,
        roundOffPaise: draft.roundOffPaise,
        revision,
        document,
        // Story 8-2a: the awaiting→issued flip stamps the issuance instant
        // from the SAME variable the document carries; a re-park stays null.
        issuedAt,
      })
      .where(eq(invoices.id, existing.id));
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, existing.id));
    await this.writeLines(tx, tenantId, existing.id, draft.lines);
    return { ...settled, invoiceId: existing.id, revision, document, contentChanged: true };
  }

  // ── the pure computation ──────────────────────────────────────────────────

  private computeDraft(input: {
    facts: OrderInvoiceFacts;
    party: InvoicePartyFacts;
    overrideByLine: ReadonlyMap<string, number>;
    carriedManual: ReadonlyMap<string, number>;
    codeByGstinPrefix: ReadonlyMap<string, StateCodeEntry>;
    codeByStateName: ReadonlyMap<string, StateCodeEntry>;
  }): InvoiceDraft {
    const { facts, party, overrideByLine, carriedManual, codeByGstinPrefix, codeByStateName } = input;

    // ── the two parties' state codes ─────────────────────────────────────
    const originGstin = party.warehouseGstin ?? party.tenantGstin;
    const origin = resolveStateCode(codeByGstinPrefix, codeByStateName, originGstin, party.originAddress?.state ?? null);
    const destination = resolveStateCode(
      codeByGstinPrefix,
      codeByStateName,
      facts.consigneeGstin,
      facts.destination?.state ?? null,
    );
    const supplyType: SupplyType | null =
      origin === null || destination === null ? null : origin.code === destination.code ? 'intra' : 'inter';
    const placeOfSupply = destination?.code ?? null;

    const gaps: InvoiceGap[] = [];
    // The `place-of-supply` detail names the CASE (8-1d): no GSTIN at all, or
    // a stored GSTIN whose prefix is not a registration state code — either
    // way the address text could not stand in.
    if (destination === null) {
      const why =
        facts.consigneeGstin === null
          ? 'the consignee carries no GSTIN'
          : `the consignee GSTIN ${facts.consigneeGstin} begins "${facts.consigneeGstin.slice(0, 2)}", which is not a GST state code,`;
      gaps.push({
        kind: 'place-of-supply',
        detail: `place of supply unresolvable — ${why} and its destination state is not on the CBIC code list (${facts.destination?.state ?? 'no destination address'})`,
      });
    }
    if (origin === null) {
      const why =
        originGstin === null
          ? `neither the warehouse (${party.warehouseName}) nor the tenant carries a GSTIN`
          : `the supplier GSTIN ${originGstin} begins "${originGstin.slice(0, 2)}", which is not a GST state code,`;
      gaps.push({
        kind: 'place-of-supply',
        detail: `supply origin unresolvable — ${why} and the warehouse's origin state is not on the CBIC code list (${party.originAddress?.state ?? 'no origin address'})`,
      });
    }
    if (originGstin === null) {
      gaps.push({
        kind: 'supplier-gstin',
        detail: `no supplier GSTIN — neither the warehouse (${party.warehouseName}) nor the tenant carries one, so no tax invoice can issue in the supplier's name`,
      });
    }
    // Design Notes: a GSTIN outranks address text; a mismatch is a WARNING
    // (never blocking) and the code stays the GSTIN's. Checked on BOTH sides
    // and independently — the origin arm matters most when the tenant's
    // GSTIN (another state's registration) backs a warehouse that has none.
    // Story 8-1d: each side's detail names its e-way consequence — NIC's
    // actual-from/actual-to states come from the address text, so the
    // mismatch is the e-way `ship-to-differs` block on a frozen invoice.
    if (origin !== null && origin.textCode !== null && origin.textCode !== origin.code) {
      const detail = `dispatch-from discrepancy: supplier GSTIN ${originGstin} resolves to code ${origin.code} (${origin.name}) but the warehouse's origin state resolves to code ${origin.textCode} — the GSTIN wins; ${ewayWillBlock('ship-to-differs')}`;
      gaps.push({ kind: 'pos-discrepancy', detail });
      this.logger.warn(`pos-discrepancy on order ${facts.orderId}: ${detail}`);
    }
    if (destination !== null && destination.textCode !== null && destination.textCode !== destination.code) {
      const detail = `ship-to discrepancy: consignee GSTIN ${facts.consigneeGstin} resolves to code ${destination.code} (${destination.name}) but its address state resolves to code ${destination.textCode} — the GSTIN wins; ${ewayWillBlock('ship-to-differs')}`;
      gaps.push({ kind: 'pos-discrepancy', detail });
      this.logger.warn(`pos-discrepancy on order ${facts.orderId}: ${detail}`);
    }
    // Story 8-1d: a stored GSTIN whose prefix is not a registration state
    // code (legacy — entry refuses it now). The side resolved from its
    // address text; on the ORIGIN side NIC compares the text state with the
    // GSTIN's prefix, so the e-way bill blocks on `ship-to-differs` as well.
    if (origin !== null && originGstin !== null && !origin.gstinKnown) {
      gaps.push({
        kind: 'gstin-prefix-unknown',
        detail: `supplier GSTIN ${originGstin} begins "${originGstin.slice(0, 2)}", which is not a GST state code — the supply origin resolved from the warehouse's origin state, code ${origin.code} (${origin.name}); ${ewayWillBlock('ship-to-differs')}`,
      });
    }
    if (destination !== null && facts.consigneeGstin !== null && !destination.gstinKnown) {
      gaps.push({
        kind: 'gstin-prefix-unknown',
        detail: `consignee GSTIN ${facts.consigneeGstin} begins "${facts.consigneeGstin.slice(0, 2)}", which is not a GST state code — the place of supply resolved from its address state, code ${destination.code} (${destination.name}); NIC may refuse this buyer GSTIN on the e-way bill`,
      });
    }
    // Story 8-1d: an address state off the official list, the side resolved
    // from its GSTIN. NIC resolves the actual states from the text alone.
    // A MISSING state (no address, or a blank state) is the same silent
    // e-way block: NIC needs the text state (address-incomplete without an
    // address, state-unresolved with a blank state).
    const originStateMissing = normalizeStateName(party.originAddress?.state) === '';
    if (origin !== null && (origin.textUnresolved || originStateMissing)) {
      const what = originStateMissing
        ? `the warehouse's origin address state is missing`
        : `the warehouse's origin state "${party.originAddress?.state ?? ''}" is not on the CBIC code list`;
      gaps.push({
        kind: 'state-text-unknown',
        detail: `${what} — the supply origin resolved from the supplier GSTIN, code ${origin.code} (${origin.name}); ${ewayWillBlock(party.originAddress === null ? 'address-incomplete' : 'state-unresolved')}`,
      });
    }
    const destinationStateMissing = normalizeStateName(facts.destination?.state) === '';
    if (destination !== null && (destination.textUnresolved || destinationStateMissing)) {
      const what = destinationStateMissing
        ? 'the destination address state is missing'
        : `the destination state "${facts.destination?.state ?? ''}" is not on the CBIC code list`;
      gaps.push({
        kind: 'state-text-unknown',
        detail: `${what} — the place of supply resolved from the consignee GSTIN, code ${destination.code} (${destination.name}); ${ewayWillBlock(facts.destination === null ? 'address-incomplete' : 'state-unresolved')}`,
      });
    }
    // Story 8-1d: the printed party names must survive NIC's text rule, or
    // the e-way bill prints them blank (seller first, then buyer — the same
    // names `buildDocument` prints).
    const sellerName = party.tenantName;
    const buyerName = facts.consigneeLegalName ?? facts.destination?.contactName ?? null;
    for (const [role, name] of [
      ['seller', sellerName],
      ['buyer', buyerName],
    ] as const) {
      if (nicText(name, 100) === '') {
        gaps.push({
          kind: 'party-name-unprintable',
          detail: `${role} name ${name === null ? '(none)' : `"${name}"`} has no characters the e-way portal accepts — ${ewayWillBlock('address-incomplete')}`,
        });
      }
    }

    // ── the lines ─────────────────────────────────────────────────────────
    const lines: InvoiceLineDraft[] = [];
    for (const fact of facts.lines) {
      if (fact.dispatchedQtyMilli <= 0) {
        continue; // the kit-parent drop: zero picks invoice nothing
      }
      // Rate resolution, three tiers: the order line's frozen-acceptance rate
      // (always wins — an override on a priced line was refused above) → the
      // command's explicit override → the document's carried manual rate (the
      // freeze lives in the document — an operator's pricing survives every
      // regenerate that does not override it). Else unpriced.
      const override = overrideByLine.get(fact.orderLineId);
      const ratePaise: number | null = fact.ratePaise ?? override ?? carriedManual.get(fact.orderLineId) ?? null;
      if (ratePaise === null) {
        gaps.push({
          kind: 'unpriced-line',
          orderLineId: fact.orderLineId,
          detail: `line ${fact.skuCode} (${fact.orderLineId}) has no rate — parked awaiting-data until the operator prices it`,
        });
        continue;
      }
      const rateSource: RateSource = fact.ratePaise === null ? 'manual' : 'order_line';
      // An overflow is a generation failure — a DATA fault (an absurd rate),
      // not transport: it throws, the caller (relay or command) surfaces it
      // through its own failure posture, the operator fixes the data, the
      // next delivery/command lands it.
      const tax = computeLineTax(fact.dispatchedQtyMilli, asPaise(ratePaise), asGstBps(fact.gstRateBps), supplyType);
      const hsnGap = fact.hsn === null;
      if (hsnGap) {
        // A warning, not a blocker (the HSN row of the spec's matrix).
        gaps.push({
          kind: 'hsn-gap',
          orderLineId: fact.orderLineId,
          detail: `line ${fact.skuCode} issued with a blank HSN — the SKU carries none in the catalog`,
        });
      } else if (!isValidHsn(normalizeHsn(fact.hsn))) {
        // Story 8-1d: the ONE HSN rule the HSN summary and e-way apply
        // (`hsn.ts`) — a non-null HSN that is whitespace-only or malformed.
        // A warning, never a blocker; exclusive with `hsn-gap` (null only).
        gaps.push({
          kind: 'hsn-invalid',
          orderLineId: fact.orderLineId,
          detail: `line ${fact.skuCode} issued with a malformed HSN "${fact.hsn}" — not 4, 6 or 8 digits; the HSN summary flags it and, ${ewayWillBlock('hsn-issue')}`,
        });
      }
      lines.push({
        orderLineId: fact.orderLineId,
        skuCode: fact.skuCode,
        skuName: fact.skuName,
        hsn: fact.hsn,
        qtyMilli: fact.dispatchedQtyMilli,
        uom: fact.uom,
        ratePaise,
        rateSource,
        taxablePaise: tax.taxablePaise,
        gstBps: fact.gstRateBps,
        cgstPaise: tax.cgstPaise,
        sgstPaise: tax.sgstPaise,
        igstPaise: tax.igstPaise,
        hsnGap,
      });
    }

    const subtotalPaise = lines.reduce((sum, line) => sum + line.taxablePaise, 0);
    const gstPaise = lines.reduce((sum, line) => sum + line.cgstPaise + line.sgstPaise + line.igstPaise, 0);
    const totalPaise = subtotalPaise + gstPaise;
    // The two-sum invariants hold by construction (sums of already-rounded
    // lines); `assertInvoiceTotals` re-checks them loudly — FR-26's
    // reconciliation gate.
    assertInvoiceTotals({
      subtotalPaise,
      gstPaise,
      totalPaise,
      cgstPaise: lines.reduce((s, l) => s + l.cgstPaise, 0),
      sgstPaise: lines.reduce((s, l) => s + l.sgstPaise, 0),
      igstPaise: lines.reduce((s, l) => s + l.igstPaise, 0),
    });

    // Story 8-1b: the rupee rounding touches ONLY total → payable.
    const { payable: payablePaise, roundOff: roundOffPaise } = roundToRupee(asPaise(totalPaise));

    const status: InvoiceStatus = gaps.some((gap) => BLOCKING_GAP_KINDS.has(gap.kind)) ? 'awaiting-data' : 'issued';

    return {
      facts,
      party,
      status,
      supplyType,
      placeOfSupply,
      originGstin,
      consigneeGstin: facts.consigneeGstin,
      lines,
      subtotalPaise,
      gstPaise,
      totalPaise,
      payablePaise,
      roundOffPaise,
      gaps,
    };
  }

  private buildDocument(
    draft: InvoiceDraft,
    stamps: { invoiceNo: string | null; fyLabel: string | null; issuedAt: string | null; revision: number },
  ): InvoiceDocument {
    return {
      header: {
        invoiceNo: stamps.invoiceNo,
        fyLabel: stamps.fyLabel,
        orderRef: draft.facts.orderId,
        issuedAt: stamps.issuedAt,
        supplyType: draft.supplyType,
        placeOfSupply: draft.placeOfSupply,
        originGstin: draft.originGstin,
        consigneeGstin: draft.consigneeGstin,
        originAddress: draft.party.originAddress,
        consigneeAddress: draft.facts.destination,
      },
      seller: {
        // The registered supplier is the TENANT (the legal entity); the
        // warehouse is a dispatch site, never the seller of record.
        name: draft.party.tenantName,
        gstin: draft.originGstin,
      },
      buyer: {
        // Story 8-1d: the registered buyer's legal / trade name when the
        // order carries one (so NIC's toTrdName is the legal entity), else
        // the delivery contact — the pre-8-1d value, unchanged for every
        // order without it.
        name: draft.facts.consigneeLegalName ?? draft.facts.destination?.contactName ?? null,
        gstin: draft.facts.consigneeGstin,
      },
      lines: draft.lines.map((line) => ({ ...line })),
      totals: {
        subtotal: draft.subtotalPaise,
        gst: draft.gstPaise,
        total: draft.totalPaise,
        roundOff: draft.roundOffPaise,
        payable: draft.payablePaise,
      },
      gaps: draft.gaps.map((gap) => ({ ...gap })),
      revision: stamps.revision,
    };
  }

  private async writeLines(
    tx: TenantTx,
    tenantId: string,
    invoiceId: string,
    lines: readonly InvoiceLineDraft[],
  ): Promise<void> {
    if (lines.length === 0) return;
    await tx.insert(invoiceLines).values(
      lines.map((line) => ({
        id: uuidv7(),
        tenantId,
        invoiceId,
        orderLineId: line.orderLineId,
        skuCode: line.skuCode,
        skuName: line.skuName,
        hsn: line.hsn,
        qtyMilli: line.qtyMilli,
        ratePaise: line.ratePaise,
        rateSource: line.rateSource,
        taxablePaise: line.taxablePaise,
        gstBps: line.gstBps,
        cgstPaise: line.cgstPaise,
        sgstPaise: line.sgstPaise,
        igstPaise: line.igstPaise,
        hsnGap: line.hsnGap,
        // Story 8-2a: the read-model unit snapshot (the document line's uom).
        uom: line.uom,
      })),
    );
  }
}

// ── document identity (revision unchanged ⇔ content identical) ─────────────

/**
 * Structural equality over the document EXCEPT the revision (whose only job
 * is to NUMBER a change — it must never trigger its own bump). Key-order
 * CANONICAL: the prior document round-trips through the `jsonb` column,
 * which does not preserve insertion order — Postgres re-sorts object keys
 * (shorter-or-equal length first, then bytewise) — so a stringify against a
 * freshly built literal would flip on ORDERING alone, bumping the revision
 * on an identical re-derivation (exactly the double-delivery defect). Both
 * sides are canonicalized before the compare: equal documents are equal
 * whatever bytes produced them, arrays stay ordered (line order is data).
 */
export function documentsEqual(a: InvoiceDocument, b: InvoiceDocument): boolean {
  // `revision: undefined` is dropped by stringify — the stripped-compare
  // without a dead destructure.
  const content = (doc: InvoiceDocument): string => JSON.stringify(canonicalize({ ...doc, revision: undefined }));
  return content(a) === content(b);
}

/** Recursively sorts object keys; scalars and array ELEMENT ORDER untouched. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, v]) => [key, canonicalize(v)] as const)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    );
  }
  return value;
}