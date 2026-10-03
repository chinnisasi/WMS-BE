import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  gstStateCodes,
  invoiceLines,
  invoiceSeries,
  invoices,
  type InvoiceLine,
} from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { OutboundFacade } from '../outbound/outbound.facade';
import type { OrderInvoiceFacts } from '../outbound/outbound.facade';
import { invoicePartyFactsInTx } from '../tenancy/tenancy.service';
import type { InvoicePartyFacts } from '../tenancy/tenancy.service';
import { asGstBps, asPaise, assertInvoiceTotals, computeLineTax, type SupplyType } from './arith';

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
 * BLOCKING (they park the invoice `awaiting-data`); `hsn-gap` /
 * `pos-discrepancy` are WARNINGS (the invoice issues with the gap visible in
 * the document). Deliberately a single `place-of-supply` kind for both
 * unresolvable sides — the detail names which. `supplier-gstin` (8-1 code
 * review): neither the warehouse nor the tenant carries a GSTIN, so no tax
 * invoice can be issued in the supplier's name — the origin may still
 * resolve from address text, which is why it is its own kind.
 */
export const GAP_KINDS = ['unpriced-line', 'place-of-supply', 'supplier-gstin', 'hsn-gap', 'pos-discrepancy'] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/** The gap kinds that park an invoice `awaiting-data`. */
const BLOCKING_GAP_KINDS: ReadonlySet<GapKind> = new Set<GapKind>(['unpriced-line', 'place-of-supply', 'supplier-gstin']);

export interface InvoiceGap {
  readonly kind: GapKind;
  readonly detail: string;
  /**
   * The order line a LINE-scoped gap (`unpriced-line`, `hsn-gap`) is about —
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
  readonly totals: { readonly subtotal: number; readonly gst: number; readonly payAble: number };
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
  readonly gaps: readonly InvoiceGap[];
}

// ── FY numbering ─────────────────────────────────────────────────────────────

/** India is UTC+05:30 year-round (no DST) — the FY is read off the IST clock. */
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/**
 * The financial-year label of an issuance instant: April 1 – March 31 in
 * Asia/Kolkata, rendered `FY-2627` (October 2026 opens FY-2627; March 2027
 * still closes FY-2627 — the label of the FY the instant falls INSIDE).
 */
export function fyLabelFor(instant: string): string {
  const ist = new Date(Date.parse(instant) + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  // getUTCMonth(): 0 = January … 3 = April. Month ≥ 3 (April) opens the FY
  // named for THAT year; Jan–Mar belongs to the FY the previous year opened.
  const startYear = ist.getUTCMonth() >= 3 ? year : year - 1;
  const pad = (n: number): string => String(n % 100).padStart(2, '0');
  return `FY-${pad(startYear)}${pad(startYear + 1)}`;
}

/**
 * The series-row allocation: one row per tenant per FY, `last_seq` advanced
 * under the row's FOR UPDATE lock (the concurrency guarantee behind gap-free
 * numbering). Absent row → inserted then re-locked: a concurrent first
 * issuance of a DIFFERENT order in the same FY holds the lock, the
 * ON-CONFLICT-DO-NOTHING insert loses silently, and the re-select waits for
 * the winner's commit and reads its settled value — the seq comes from the
 * lock, never from the read.
 */
async function allocateSeriesSeq(tx: TenantTx, tenantId: string, fy: string): Promise<number> {
  const scope = and(eq(invoiceSeries.tenantId, tenantId), eq(invoiceSeries.fyLabel, fy));
  let rows = await tx.select().from(invoiceSeries).where(scope).limit(1).for('update');
  if (rows[0] === undefined) {
    await tx
      .insert(invoiceSeries)
      .values({ tenantId, fyLabel: fy, lastSeq: 0 })
      .onConflictDoNothing({ target: [invoiceSeries.tenantId, invoiceSeries.fyLabel] });
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
 */
export function resolveStateCode(
  codeByGstinPrefix: ReadonlyMap<string, StateCodeEntry>,
  codeByStateName: ReadonlyMap<string, StateCodeEntry>,
  gstin: string | null,
  stateText: string | null,
): { code: string; name: string; textCode: string | null } | null {
  const gstinCode = gstin !== null ? codeByGstinPrefix.get(gstin.slice(0, 2)) ?? null : null;
  const normalized = normalizeStateName(stateText);
  if (normalized === '') {
    return gstinCode === null ? null : { code: gstinCode.stateCode, name: gstinCode.stateName, textCode: null };
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
  };
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
   * transaction. Reads the dispatch facts through the outbound facade and
   * the party facts through the tenancy seam, computes, and settles the ONE
   * invoice row for the order:
   *
   *   absent → INSERT (a concurrent twin's unique violation throws
   *   `InvoiceRaceLostError` — the caller adopts the winner with a fresh
   *   transaction; this one rolls back whole);
   *   present → content-compare: identical → nothing written (a pure
   *   re-derivation pass); changed → revision bump + column update + line
   *   rewrite (the lines table is the computation's OUTPUT, rebuilt whole —
   *   it carries no identity of its own).
   *
   * A flip to `issued` (the settled row carries no number yet) allocates the
   * FY sequence under the series-row lock and stamps `invoice_no` /
   * `fy_label` / `series_seq` ONLY on first issuance — an already-issued
   * regenerate keeps its number whatever the recompute finds (the flip's
   * number is forever; the void command is the spec's deferred item).
   */
  async generateCoreInTx(
    tx: TenantTx,
    tenantId: string,
    orderId: string,
    overrides: readonly RateOverride[],
  ): Promise<InvoiceGenerationOutcome> {
    // 1. The dispatch facts — generation re-derives, never trusts the
    // payload (unknown order → 404; not dispatched → 409; the delivery
    // handler surfaces both through its own error posture).
    const facts = await this.outbound.orderInvoiceFactsInTx(tx, tenantId, orderId);
    if (facts === null) {
      throw invoiceNotFound();
    }
    if (facts.status !== 'dispatched') {
      throw orderNotDispatched(facts.status);
    }

    // 2. The parties (tenancy's seam — invoicing writes no tenancy table).
    const party = await invoicePartyFactsInTx(tx, tenantId, facts.warehouseId);

    // 3. The state-code reference (global — no tenant scope, like app_metadata).
    const codes = await tx.select().from(gstStateCodes);
    const codeByGstinPrefix = new Map<string, StateCodeEntry>(
      codes.map((row) => [row.stateCode, { stateCode: row.stateCode, stateName: row.stateName }]),
    );
    const codeByStateName = new Map<string, StateCodeEntry>(
      codes.map((row) => [normalizeStateName(row.stateName), { stateCode: row.stateCode, stateName: row.stateName }]),
    );

    // 4. The CURRENT invoice row (locked) + its lines — both a rate carrier
    // (the document's frozen manual rates re-apply on an operator regenerate
    // that sends no overrides) and the upsert's lock.
    const existingRows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.orderId, orderId)))
      .limit(1)
      .for('update');
    const existing = existingRows[0];
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

    // 5. Every override names an UNPRICED line OF this order — the two 409
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

    // 6. The issuance bookkeeping: number + revision + pinned stamps. The
    // SETTLED status is computed here so the stamp decision reads the same
    // status the write will store — an existing `issued`/`voided` row never
    // regresses (an issued row whose recompute now finds blocking gaps stays
    // issued with the gaps visible; issuance was a decision the document
    // still shows), and only an issuance that SETTLES issued allocates a
    // number (a void outcome never burns a sequence).
    const nextStatus: InvoiceStatus =
      existing === undefined
        ? draft.status
        : existing.status === 'voided'
          ? 'voided'
          : existing.status === 'issued'
            ? 'issued'
            : draft.status;
    let invoiceNo: string | null = null;
    let fyLabel: string | null = null;
    let seriesSeq: number | null = null;
    let issuedAt: string | null = null;
    let firstIssuance = false;
    if (nextStatus === 'issued' && (existing === undefined || existing.invoiceNo === null)) {
      // ONE instant for both the FY and the printed date — two clock reads
      // straddling 31 March midnight IST would number an invoice in one FY
      // and date it in the next.
      const issuedInstant = nowIso();
      const fy = fyLabelFor(issuedInstant);
      const seq = await allocateSeriesSeq(tx, tenantId, fy);
      invoiceNo = `${fy}-${String(seq).padStart(6, '0')}`;
      fyLabel = fy;
      seriesSeq = seq;
      issuedAt = issuedInstant;
      firstIssuance = true;
    } else if (existing !== undefined) {
      // An already-stamped regenerate keeps its number and its printed
      // issuance instant — the number is forever, the instant is the
      // document's own (the prior document carries it). Voided rows keep
      // whatever the void found too.
      invoiceNo = existing.invoiceNo;
      fyLabel = existing.fyLabel;
      seriesSeq = existing.seriesSeq === null ? null : Number(existing.seriesSeq);
      issuedAt = (existing.document as InvoiceDocument).header.issuedAt ?? null;
    }

    let revision = existing?.revision ?? 1;
    let document = this.buildDocument(draft, { invoiceNo, fyLabel, issuedAt, revision });

    // 7. The write.
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
          revision,
          document,
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
      return {
        invoiceId,
        orderId,
        tenantId,
        warehouseId: facts.warehouseId,
        invoiceNo,
        fyLabel,
        seriesSeq,
        status: draft.status,
        revision,
        subtotalPaise: draft.subtotalPaise,
        gstPaise: draft.gstPaise,
        totalPaise: draft.totalPaise,
        document,
        contentChanged: true,
        firstIssuance,
      };
    }

    // 8. Regeneration: content-compare → update or pure no-op. The revision
    // is stripped before the compare (its only job is to NUMBER a change;
    // it must never trigger its own bump).
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
        status: nextStatus,
        originGstin: draft.originGstin,
        consigneeGstin: draft.consigneeGstin,
        placeOfSupply: draft.placeOfSupply,
        supplyType: draft.supplyType,
        subtotalPaise: draft.subtotalPaise,
        gstPaise: draft.gstPaise,
        totalPaise: draft.totalPaise,
        revision,
        document,
      })
      .where(eq(invoices.id, existing.id));
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, existing.id));
    await this.writeLines(tx, tenantId, existing.id, draft.lines);
    return {
      invoiceId: existing.id,
      orderId,
      tenantId,
      warehouseId: facts.warehouseId,
      invoiceNo,
      fyLabel,
      seriesSeq,
      status: nextStatus,
      revision,
      subtotalPaise: draft.subtotalPaise,
      gstPaise: draft.gstPaise,
      totalPaise: draft.totalPaise,
      document,
      contentChanged: true,
      firstIssuance,
    };
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
    if (destination === null) {
      gaps.push({
        kind: 'place-of-supply',
        detail: `place of supply unresolvable — the consignee carries no GSTIN and its destination state is not on the CBIC code list (${facts.destination?.state ?? 'no destination address'})`,
      });
    }
    if (origin === null) {
      gaps.push({
        kind: 'place-of-supply',
        detail: `supply origin unresolvable — the warehouse (${party.warehouseName}) has no GSTIN-derived state and its origin state is not on the CBIC code list (${party.originAddress?.state ?? 'no origin address'})`,
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
    if (origin !== null && origin.textCode !== null && origin.textCode !== origin.code) {
      const detail = `supply-origin discrepancy: supplier GSTIN ${originGstin} resolves to code ${origin.code} (${origin.name}) but the warehouse's origin state resolves to code ${origin.textCode} — the GSTIN wins`;
      gaps.push({ kind: 'pos-discrepancy', detail });
      this.logger.warn(`pos-discrepancy on order ${facts.orderId}: ${detail}`);
    }
    if (destination !== null && destination.textCode !== null && destination.textCode !== destination.code) {
      const detail = `place-of-supply discrepancy: consignee GSTIN ${facts.consigneeGstin} resolves to code ${destination.code} (${destination.name}) but its address state resolves to code ${destination.textCode} — the GSTIN wins`;
      gaps.push({ kind: 'pos-discrepancy', detail });
      this.logger.warn(`pos-discrepancy on order ${facts.orderId}: ${detail}`);
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
        name: draft.facts.destination?.contactName ?? null,
        gstin: draft.facts.consigneeGstin,
      },
      lines: draft.lines.map((line) => ({ ...line })),
      totals: {
        subtotal: draft.subtotalPaise,
        gst: draft.gstPaise,
        payAble: draft.totalPaise,
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