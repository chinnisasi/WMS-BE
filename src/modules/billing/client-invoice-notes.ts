import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  clientInvoiceLines,
  clientInvoiceNoteLines,
  clientInvoiceNotePolicies,
  clientInvoiceNoteSeries,
  clientInvoiceNotes,
  clientInvoices,
  idempotencyKeys,
  type ClientInvoice,
  type ClientInvoiceNote,
} from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK, type OutboxSink } from '../../shared/events/outbox.seam';
import {
  ArithmeticOverflowError,
  asGstBps,
  asPaise,
  assertInvoiceTotals,
  computeLineTax,
  formatServiceNoteNo,
  fyLabelFor,
  ROUND_OFF_MAX,
  ROUND_OFF_MIN,
  type SupplyType,
} from '../../shared/primitives/gst';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { decodeCursor, encodeCursor } from '../../shared/primitives/pagination';
import { addIsoDays, fullPrecisionInstant, istDateOf, istMidnightOf, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { InvoicingFacade } from '../invoicing/facade';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { getMemberClientIdIn, getMemberRoleIn } from '../tenancy/tenancy.service';
import {
  clientInvoiceClock,
  clientInvoiceNotFound,
  clientInvoiceViewInTx,
  compareLines,
  lockInvoiceInTx,
  portalRefused,
  settleInTx,
  type ClientInvoiceParty,
  type ClientInvoiceStatus,
  type ClientInvoiceTotalsView,
  type ClientInvoiceView,
} from './client-invoices';
import { assertMeteringPeriod } from './metering';
import type { ChargeCode, RateBasis } from './rate-cards';

/**
 * Story 5-6a — GST credit and debit notes (CGST Act s.34) against ONE issued,
 * disputed or settled client services invoice.
 *
 * - **Create** a draft: the lines name invoice lines and carry a taxable
 *   delta; the tax is the ORIGINAL line's (SAC, rate, place of supply, supply
 *   type — `computeLineTax`, the invoice's own rule). A credit can never take
 *   more than the invoice line still holds (taxable and each head), and
 *   never more payable than the invoice; the credit that exhausts a line takes
 *   exactly its remaining heads, the one that exhausts the whole invoice its
 *   remaining payable (A8). A debit over its line needs an override reason.
 * - **Issue** re-checks everything under the invoice lock, numbers the note
 *   from its own C / D series (FY of the issue instant) and freezes it; a
 *   settling credit moves the disputed invoice to `settled` in the same
 *   transaction.
 * - **Void** frees the cap (never a settling credit, never after the
 *   GSTR-1 due date of its month); **discard** deletes a draft.
 *
 * The house skeleton everywhere (IMPLEMENTATION-GUIDE §1): shape above the
 * transaction → `billing.invoice` → replay → lock (invoice row, then the
 * note row — never the reverse) → replay under the lock → guards → write →
 * outbox → audit → key last. The database is the backstop for the freeze,
 * the cap and the copied facts (`drizzle/0098_client_invoice_notes.sql`).
 * Product decisions, not legal advice: the system records the reason; the
 * legal conditions (an s.15(3)(b) agreement, the recipient's ITC reversal)
 * are the operator's and their CA's.
 */

// ── vocabularies (pinned against 0098's CHECKs by test/client-invoice-notes.spec.ts) ──

export const NOTE_KINDS = ['credit', 'debit'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_STATUSES = ['draft', 'issued', 'void'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** A2 — the reasons, paired with the kind (the `client_invoice_notes_reason` CHECK). */
export const NOTE_REASONS_BY_KIND = {
  credit: ['deficiency-in-service', 'post-supply-discount', 'excess-billed'],
  debit: ['short-billed'],
} as const satisfies Readonly<Record<NoteKind, readonly string[]>>;
export const NOTE_REASONS = [...NOTE_REASONS_BY_KIND.credit, ...NOTE_REASONS_BY_KIND.debit] as const;
export type NoteReason = (typeof NOTE_REASONS)[number];

/** Reason notes, void notes and override reasons: 1–500 code points, trimmed. */
export const NOTE_TEXT_MAX = 500;
/** A note's lines: 1–100, one per invoice line. */
export const NOTE_LINES_MAX = 100;

/** The register's page bounds. */
export const NOTE_REGISTER_DEFAULT_LIMIT = 100;
export const NOTE_REGISTER_MAX_LIMIT = 500;

/** The outbox events (A16) — no consumer yet. */
export const NOTE_EVENT_TYPES = ['client_invoice_note.issued', 'client_invoice_note.voided'] as const;

// ── the time rules (pure; the command reads `clientInvoiceClock`) ──────────

/**
 * A10 — the FY of the SUPPLY: the earlier of the FY the period's last day
 * falls in (the date of provision, s.13(2) with Rule 47) and the invoice's
 * own FY (the invoice date). A March period invoiced in April is a FY-2627
 * supply. Labels compare as strings ('FY-2627' < 'FY-2728').
 */
export function supplyFyLabel(periodEnd: string, invoiceFy: string): string {
  const byPeriod = fyLabelFor(istMidnightOf(periodEnd));
  return byPeriod < invoiceFy ? byPeriod : invoiceFy;
}

/**
 * s.34(2) as amended by the Finance Act 2022 — the FIRST refused instant for
 * a credit note on a supply of FY `fy`: IST midnight starting 1 December
 * after the FY ends (FY-2627 → 2027-12-01T00:00+05:30). The "annual return,
 * if earlier" arm needs a filing marker (PENDING).
 */
export function creditNoteDeadline(fy: string): string {
  return istMidnightOf(`${2000 + Number(fy.slice(5, 7))}-12-01`);
}

/** The last IST day a credit note may issue — the day before the deadline. */
export function creditNoteLastDay(fy: string): string {
  return addIsoDays(istDateOf(creditNoteDeadline(fy)), -1);
}

/**
 * A6 (interim, until a filing marker ships) — the first instant a note can
 * no longer be voided: IST midnight starting the 12th of the month after its
 * issue month (the monthly GSTR-1 due date is the 11th). QRMP filers are a
 * PENDING item.
 */
export function gstr1VoidCutoff(issuedAt: string): string {
  const [y, m] = istDateOf(issuedAt).split('-').map(Number) as [number, number];
  return istMidnightOf(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-12`);
}

// ── the figures (pure) ──────────────────────────────────────────────────────

/** One invoice line as the figures read it (an issued invoice: priced, taxed). */
export interface NoteInvoiceLineFacts {
  readonly id: string;
  readonly amountPaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly gstBps: number;
  readonly supplyType: SupplyType;
}

export interface NoteHeads {
  readonly amountPaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
}

export interface NoteFiguresInput {
  readonly kind: NoteKind;
  readonly invoicePayablePaise: number;
  readonly invoiceLines: readonly NoteInvoiceLineFacts[];
  /** Per invoice line, the sums over ISSUED credit notes (this note excluded). */
  readonly issuedCredits: ReadonlyMap<string, NoteHeads>;
  /** Σ payable of the ISSUED credit notes (this note excluded). */
  readonly priorCreditPayablePaise: number;
  readonly lines: readonly { readonly invoiceLineId: string; readonly amountPaise: number }[];
}

export interface NoteLineFigures extends NoteHeads {
  readonly invoiceLineId: string;
}

export interface NoteTotals {
  readonly subtotalPaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly taxPaise: number;
  readonly totalPaise: number;
  readonly roundOffPaise: number;
  readonly payablePaise: number;
}

export interface NoteFigures {
  readonly lines: readonly NoteLineFigures[];
  readonly totals: NoteTotals;
}

export interface NoteRemaining {
  readonly invoiceLineId: string;
  readonly remainingPaise: number;
  readonly remainingCgstPaise: number;
  readonly remainingSgstPaise: number;
  readonly remainingIgstPaise: number;
}

const ZERO_HEADS: NoteHeads = { amountPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };

export function rupees(paise: number): string {
  const sign = paise < 0 ? '−' : '';
  const abs = Math.abs(paise);
  return `${sign}₹${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}

export function creditExceedsInvoice(lines: readonly NoteRemaining[]): ProblemException {
  return new ProblemException(
    'credit-exceeds-invoice',
    409,
    'A credit note cannot exceed the invoice',
    `A credit note can take at most what the invoice line still holds: ${lines
      .map((line) => `line ${line.invoiceLineId} has ${rupees(line.remainingPaise)} taxable remaining`)
      .join('; ')}.`,
    { lines: lines.map((line) => ({ ...line })) },
  );
}

/**
 * THE note figures (A8), pure. Every head is the original line's rule —
 * `computeLineTax(1000, amount, gst_bps, supply_type)` — except:
 *  - a CREDIT line that exhausts its invoice line's remaining taxable takes
 *    exactly the remaining CGST, SGST and IGST (so Σ heads = the line's);
 *  - a CREDIT line that takes more taxable than remains, or whose computed
 *    head would pass what remains, is REFUSED (409 `credit-exceeds-invoice`,
 *    every offending line named) — never silently clamped.
 * Totals are sums of the lines. A note is NOT rounded to a rupee on its own
 * (the ₹1.50 case): a credit pays `min(total, remaining payable)` and the
 * credit that exhausts the WHOLE invoice pays exactly the remaining payable,
 * so `round_off ∈ [−49, 50]` and Σ credit payable ≤ the invoice's. A debit
 * pays its total.
 */
export function computeNoteFigures(input: NoteFiguresInput): NoteFigures {
  const byId = new Map(input.invoiceLines.map((line) => [line.id, line]));
  const refused: NoteRemaining[] = [];
  const lines: NoteLineFigures[] = [];
  for (const request of input.lines) {
    const source = byId.get(request.invoiceLineId);
    if (source === undefined) throw new Error(`computeNoteFigures: invoice line ${request.invoiceLineId} is not on the invoice`);
    const computed = computeLineTax(1000, asPaise(request.amountPaise), asGstBps(source.gstBps), source.supplyType);
    if (input.kind === 'debit') {
      lines.push({ invoiceLineId: source.id, amountPaise: request.amountPaise, cgstPaise: computed.cgstPaise, sgstPaise: computed.sgstPaise, igstPaise: computed.igstPaise });
      continue;
    }
    const issued = input.issuedCredits.get(source.id) ?? ZERO_HEADS;
    const remaining: NoteRemaining = {
      invoiceLineId: source.id,
      remainingPaise: source.amountPaise - issued.amountPaise,
      remainingCgstPaise: source.cgstPaise - issued.cgstPaise,
      remainingSgstPaise: source.sgstPaise - issued.sgstPaise,
      remainingIgstPaise: source.igstPaise - issued.igstPaise,
    };
    if (request.amountPaise > remaining.remainingPaise) {
      refused.push(remaining);
      continue;
    }
    if (request.amountPaise === remaining.remainingPaise) {
      lines.push({
        invoiceLineId: source.id,
        amountPaise: request.amountPaise,
        cgstPaise: remaining.remainingCgstPaise,
        sgstPaise: remaining.remainingSgstPaise,
        igstPaise: remaining.remainingIgstPaise,
      });
      continue;
    }
    if (
      computed.cgstPaise > remaining.remainingCgstPaise ||
      computed.sgstPaise > remaining.remainingSgstPaise ||
      computed.igstPaise > remaining.remainingIgstPaise
    ) {
      refused.push(remaining);
      continue;
    }
    lines.push({ invoiceLineId: source.id, amountPaise: request.amountPaise, cgstPaise: computed.cgstPaise, sgstPaise: computed.sgstPaise, igstPaise: computed.igstPaise });
  }
  if (refused.length > 0) throw creditExceedsInvoice(refused);

  let subtotal = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  for (const line of lines) {
    subtotal += line.amountPaise;
    cgst += line.cgstPaise;
    sgst += line.sgstPaise;
    igst += line.igstPaise;
  }
  const tax = cgst + sgst + igst;
  const total = subtotal + tax;
  assertInvoiceTotals({ subtotalPaise: subtotal, gstPaise: tax, totalPaise: total, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst });

  let payable = total;
  if (input.kind === 'credit') {
    const remainingPayable = input.invoicePayablePaise - input.priorCreditPayablePaise;
    const thisNote = new Map(lines.map((line) => [line.invoiceLineId, line.amountPaise]));
    const exhaustsWhole = input.invoiceLines.every(
      (line) => (input.issuedCredits.get(line.id)?.amountPaise ?? 0) + (thisNote.get(line.id) ?? 0) === line.amountPaise,
    );
    payable = exhaustsWhole ? remainingPayable : Math.min(total, remainingPayable);
    if (payable < 0) throw new ArithmeticOverflowError(`credit note payable below zero (${payable}): the issued credits already exceed the invoice payable`);
  }
  const roundOff = payable - total;
  if (roundOff < ROUND_OFF_MIN || roundOff > ROUND_OFF_MAX) {
    // Proven unreachable (spec Design Notes) — a loud failure, never a stored row.
    throw new ArithmeticOverflowError(`credit note round-off out of range (${ROUND_OFF_MIN}…${ROUND_OFF_MAX}): ${roundOff}`);
  }
  return {
    lines,
    totals: {
      subtotalPaise: subtotal,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: igst,
      taxPaise: tax,
      totalPaise: total,
      roundOffPaise: roundOff,
      payablePaise: payable,
    },
  };
}

// ── the views ────────────────────────────────────────────────────────────────

export interface NoteLineView {
  readonly id: string;
  readonly invoiceLineId: string;
  readonly chargeCode: ChargeCode;
  readonly basis: RateBasis;
  readonly uom: string | null;
  /** IST dates, inclusive (the invoice line's segment). */
  readonly segmentFrom: string;
  readonly segmentTo: string;
  readonly sac: string;
  readonly gstBps: number;
  readonly placeOfSupply: string;
  readonly supplyType: SupplyType;
  readonly amountPaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly overrideReason: string | null;
}

export interface NoteEntryView {
  readonly id: string;
  readonly invoiceId: string;
  readonly clientId: string;
  readonly kind: NoteKind;
  readonly status: NoteStatus;
  readonly reason: NoteReason;
  readonly reasonNote: string;
  readonly settlesDispute: boolean;
  readonly noteNo: string | null;
  readonly fyLabel: string | null;
  readonly supplierGstin: string;
  readonly placeOfSupply: string;
  readonly supplyType: SupplyType;
  readonly totals: ClientInvoiceTotalsView;
  readonly issuedAt: string | null;
  readonly issuedBy: string | null;
  readonly voidNote: string | null;
  readonly voidedAt: string | null;
  readonly voidedBy: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface NoteView extends NoteEntryView {
  readonly invoiceNo: string | null;
  readonly invoiceIssuedAt: string | null;
  /** A credit's last IST day to issue (s.34(2)); null for a debit (no time bar). */
  readonly creditDeadline: string | null;
  readonly party: ClientInvoiceParty;
  readonly lines: readonly NoteLineView[];
}

export type NetDocument = ClientInvoiceTotalsView;

export interface InvoiceNotesView {
  readonly notes: readonly NoteEntryView[];
  readonly netDocument: NetDocument;
  readonly netDocumentPayable: number;
}

export interface NotePolicyView {
  readonly requireSecondApprover: boolean;
}

const isoOrNull = (value: string | null): string | null => (value === null ? null : new Date(value).toISOString());

export function noteTotalsOf(row: Pick<ClientInvoiceNote, 'subtotalPaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise' | 'taxPaise' | 'roundOffPaise' | 'payablePaise'>): ClientInvoiceTotalsView {
  return {
    subtotal: Number(row.subtotalPaise),
    cgst: Number(row.cgstPaise),
    sgst: Number(row.sgstPaise),
    igst: Number(row.igstPaise),
    tax: Number(row.taxPaise),
    roundOff: Number(row.roundOffPaise),
    payable: Number(row.payablePaise),
  };
}

function toEntryView(row: ClientInvoiceNote): NoteEntryView {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    clientId: row.clientId,
    kind: row.kind as NoteKind,
    status: row.status as NoteStatus,
    reason: row.reason as NoteReason,
    reasonNote: row.reasonNote,
    settlesDispute: row.settlesDispute,
    noteNo: row.noteNo,
    fyLabel: row.fyLabel,
    supplierGstin: row.supplierGstin,
    placeOfSupply: row.placeOfSupply,
    supplyType: row.supplyType as SupplyType,
    totals: noteTotalsOf(row),
    issuedAt: isoOrNull(row.issuedAt),
    issuedBy: row.issuedBy,
    voidNote: row.voidNote,
    voidedAt: isoOrNull(row.voidedAt),
    voidedBy: row.voidedBy,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/**
 * The document value after notes (A14): the invoice's totals − Σ ISSUED
 * credits + Σ ISSUED debits, per figure (`ClientInvoiceTotalsView` keys).
 * Notes never touch receivables — this is not an outstanding balance.
 */
export function netDocumentOf(
  invoice: ClientInvoiceTotalsView,
  notes: readonly { readonly kind: NoteKind; readonly status: NoteStatus; readonly totals: ClientInvoiceTotalsView }[],
): NetDocument {
  const net = { ...invoice };
  for (const note of notes) {
    if (note.status !== 'issued') continue;
    const sign = note.kind === 'credit' ? -1 : 1;
    for (const key of ['subtotal', 'cgst', 'sgst', 'igst', 'tax', 'roundOff', 'payable'] as const) net[key] += sign * note.totals[key];
  }
  return net;
}

export function invoiceTotalsOf(row: ClientInvoice): ClientInvoiceTotalsView {
  return {
    subtotal: Number(row.subtotalPaise),
    cgst: Number(row.cgstPaise),
    sgst: Number(row.sgstPaise),
    igst: Number(row.igstPaise),
    tax: Number(row.taxPaise),
    roundOff: Number(row.roundOffPaise),
    payable: Number(row.payablePaise),
  };
}

async function noteLinesOfInTx(tx: TenantTx, tenantId: string, noteId: string): Promise<NoteLineView[]> {
  const rows = await tx
    .select()
    .from(clientInvoiceNoteLines)
    .where(and(eq(clientInvoiceNoteLines.tenantId, tenantId), eq(clientInvoiceNoteLines.noteId, noteId)));
  return rows
    .map((row) => ({ ...row, segmentFrom: new Date(row.segmentFrom).toISOString(), segmentTo: new Date(row.segmentTo).toISOString() }))
    .sort((a, b) => compareLines(a, b) || (a.invoiceLineId < b.invoiceLineId ? -1 : a.invoiceLineId > b.invoiceLineId ? 1 : 0))
    .map((row) => ({
      id: row.id,
      invoiceLineId: row.invoiceLineId,
      chargeCode: row.chargeCode as ChargeCode,
      basis: row.basis as RateBasis,
      uom: row.uom,
      segmentFrom: istDateOf(row.segmentFrom),
      segmentTo: addIsoDays(istDateOf(row.segmentTo), -1),
      sac: row.sacCode,
      gstBps: row.gstBps,
      placeOfSupply: row.placeOfSupply,
      supplyType: row.supplyType as SupplyType,
      amountPaise: Number(row.amountPaise),
      cgstPaise: Number(row.cgstPaise),
      sgstPaise: Number(row.sgstPaise),
      igstPaise: Number(row.igstPaise),
      overrideReason: row.overrideReason,
    }));
}

/** The credit deadline's last day for an invoice, or null when it has no FY (a draft — never noteable). */
function creditLastDayOf(invoice: Pick<ClientInvoice, 'periodEnd' | 'fyLabel'>): string | null {
  return invoice.fyLabel === null ? null : creditNoteLastDay(supplyFyLabel(invoice.periodEnd, invoice.fyLabel));
}

async function noteViewOfInTx(tx: TenantTx, row: ClientInvoiceNote, invoice: ClientInvoice): Promise<NoteView> {
  return {
    ...toEntryView(row),
    invoiceNo: invoice.invoiceNo,
    invoiceIssuedAt: isoOrNull(invoice.issuedAt),
    creditDeadline: row.kind === 'credit' ? creditLastDayOf(invoice) : null,
    party: row.party as ClientInvoiceParty,
    lines: await noteLinesOfInTx(tx, row.tenantId, row.id),
  };
}

// ── refusals ─────────────────────────────────────────────────────────────────

export function noteNotFound(noteId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Note not found', `No credit or debit note with id "${noteId}" exists in this tenant.`);
}

function validation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid note', detail);
}

function noteLabel(row: ClientInvoiceNote): string {
  return row.noteNo ?? `draft ${row.kind} note ${row.id}`;
}

/** A1 — which invoices a note may amend. */
function assertNoteable(invoice: ClientInvoice, kind: NoteKind): void {
  const status = invoice.status as ClientInvoiceStatus;
  if (
    status === 'draft' ||
    status === 'void' ||
    invoice.supplierGstin === null ||
    invoice.placeOfSupply === null ||
    invoice.supplyType === null ||
    invoice.fyLabel === null
  ) {
    throw new ProblemException(
      'invoice-not-noteable',
      409,
      'This invoice cannot take a credit or debit note',
      `Invoice ${invoice.invoiceNo ?? invoice.id} is ${status} — a note amends an issued, disputed or settled invoice only (a draft is refreshed; a void invoice is replaced).`,
    );
  }
  if (kind === 'debit' && status !== 'issued') {
    throw new ProblemException(
      'invoice-not-debitable',
      409,
      'This invoice cannot take a debit note',
      `Invoice ${invoice.invoiceNo ?? invoice.id} is ${status} — a debit note amends an issued invoice only. Resolve the dispute first, or raise a new invoice.`,
    );
  }
}

function assertDisputed(invoice: ClientInvoice): void {
  if (invoice.status !== 'disputed') {
    throw new ProblemException(
      'invoice-not-disputed',
      409,
      'The invoice is not disputed',
      `Invoice ${invoice.invoiceNo ?? invoice.id} is ${invoice.status} — only a disputed invoice is settled by a credit note. Untick "settles the dispute", or reload.`,
    );
  }
}

function assertBeforeCreditDeadline(invoice: ClientInvoice): void {
  const fy = supplyFyLabel(invoice.periodEnd, invoice.fyLabel!);
  if (clientInvoiceClock.now() >= Date.parse(creditNoteDeadline(fy))) {
    const lastDay = creditNoteLastDay(fy);
    const [y, m, d] = lastDay.split('-') as [string, string, string];
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1];
    throw new ProblemException(
      'credit-note-time-barred',
      409,
      'The credit note is time-barred',
      `The GST adjustment for this supply is time-barred under s.34(2) (last day ${Number(d)} ${month} ${y}) — a credit note can no longer reduce tax.`,
      { lastDay },
    );
  }
}

// ── the commands and reads ───────────────────────────────────────────────────

export interface NoteLineRequest {
  readonly invoiceLineId: string;
  readonly amountPaise: number;
  readonly overrideReason?: string | null | undefined;
}

export interface CreateNoteCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly invoiceId: string;
  readonly kind: string;
  readonly reason: string;
  readonly reasonNote: string;
  readonly settlesDispute?: boolean | undefined;
  readonly lines: readonly NoteLineRequest[];
}

export interface NoteTargetCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly noteId: string;
}

export interface VoidNoteCommand extends NoteTargetCommand {
  readonly voidNote: string;
}

export interface NoteResult {
  readonly note: NoteView;
}

export interface IssueNoteResult {
  readonly note: NoteView;
  /** The settled invoice, when the note settled its dispute. */
  readonly invoice?: ClientInvoiceView;
}

export interface NoteRegisterQuery {
  readonly gstin?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly kind?: NoteKind | undefined;
  readonly status?: 'issued' | 'void' | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** One CDNR row: one per (note, GST rate) — today always one rate. */
export interface NoteRegisterRow {
  readonly noteId: string;
  readonly noteNo: string;
  /** The note's IST date. */
  readonly noteDate: string;
  readonly kind: NoteKind;
  readonly status: 'issued' | 'void';
  readonly voided: boolean;
  readonly recipientGstin: string | null;
  readonly recipientName: string;
  readonly placeOfSupply: string;
  readonly supplyType: SupplyType;
  readonly invoiceNo: string;
  readonly invoiceDate: string;
  readonly gstBps: number;
  readonly taxablePaise: number;
  readonly igstPaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  /** The whole note's payable value (repeated on each of its rate rows). */
  readonly noteValuePaise: number;
}

export interface NoteRegisterPage {
  readonly rows: readonly NoteRegisterRow[];
  readonly nextCursor: string | null;
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const NOTE_NO_UNIQUE = 'client_invoice_notes_tenant_gstin_note_no_unique';
const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{13}$/;
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

type NoteAuditAction =
  | 'client_invoice_note.drafted'
  | 'client_invoice_note.discarded'
  | 'client_invoice_note.issued'
  | 'client_invoice_note.voided';

/** Trim; blank and absent alike → null. Code points are counted by the caller. */
function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

const codePoints = (value: string): number => [...value].length;

export interface NormalizedCreate {
  readonly kind: NoteKind;
  readonly reason: NoteReason;
  readonly reasonNote: string;
  readonly settlesDispute: boolean;
  /** Sorted by invoiceLineId. */
  readonly lines: readonly { readonly invoiceLineId: string; readonly amountPaise: number; readonly overrideReason: string | null }[];
}

/** The create request's SHAPE (400, above the transaction — it needs no row). */
export function normalizeCreate(command: CreateNoteCommand): NormalizedCreate {
  if (!(NOTE_KINDS as readonly string[]).includes(command.kind)) {
    throw validation(`kind must be one of ${JSON.stringify(NOTE_KINDS)} (got ${JSON.stringify(command.kind)}).`);
  }
  const kind = command.kind as NoteKind;
  const reasons: readonly string[] = NOTE_REASONS_BY_KIND[kind];
  if (!reasons.includes(command.reason)) {
    throw validation(`A ${kind} note's reason must be one of ${JSON.stringify(reasons)} (got ${JSON.stringify(command.reason)}).`);
  }
  const reasonNote = trimmedOrNull(command.reasonNote);
  if (reasonNote === null) throw validation('reasonNote is required — it is printed on the note the client receives.');
  if (codePoints(reasonNote) > NOTE_TEXT_MAX) throw validation(`reasonNote is at most ${NOTE_TEXT_MAX} characters (got ${codePoints(reasonNote)}).`);
  const settlesDispute = command.settlesDispute === true;
  if (command.settlesDispute !== undefined && typeof command.settlesDispute !== 'boolean') throw validation('settlesDispute must be a boolean.');
  if (settlesDispute && kind !== 'credit') throw validation('Only a credit note settles a dispute.');
  if (!Array.isArray(command.lines) || command.lines.length < 1 || command.lines.length > NOTE_LINES_MAX) {
    throw validation(`A note has 1–${NOTE_LINES_MAX} lines (got ${Array.isArray(command.lines) ? command.lines.length : 0}).`);
  }
  const seen = new Set<string>();
  const lines = command.lines.map((line, index) => {
    if (typeof line.invoiceLineId !== 'string' || !UUID_RE.test(line.invoiceLineId)) {
      throw validation(`lines[${index}].invoiceLineId must be a uuid (got ${JSON.stringify(line.invoiceLineId)}).`);
    }
    // uuids are compared lower-case (the ids are stored lower-case; UUID_RE admits either case).
    const invoiceLineId = line.invoiceLineId.toLowerCase();
    if (seen.has(invoiceLineId)) throw validation(`Invoice line ${invoiceLineId} appears twice — one note line per invoice line.`);
    seen.add(invoiceLineId);
    if (!Number.isSafeInteger(line.amountPaise) || line.amountPaise <= 0) {
      throw validation(`lines[${index}].amountPaise must be a positive whole number of paise (got ${JSON.stringify(line.amountPaise)}).`);
    }
    const overrideReason = trimmedOrNull(line.overrideReason);
    if (overrideReason !== null && kind !== 'debit') throw validation(`lines[${index}].overrideReason is for a debit note over its invoice line only.`);
    if (overrideReason !== null && codePoints(overrideReason) > NOTE_TEXT_MAX) {
      throw validation(`lines[${index}].overrideReason is at most ${NOTE_TEXT_MAX} characters (got ${codePoints(overrideReason)}).`);
    }
    return { invoiceLineId, amountPaise: line.amountPaise, overrideReason };
  });
  lines.sort((a, b) => (a.invoiceLineId < b.invoiceLineId ? -1 : a.invoiceLineId > b.invoiceLineId ? 1 : 0));
  return { kind, reason: command.reason as NoteReason, reasonNote, settlesDispute, lines };
}

/**
 * Credit and debit notes (story 5-6a). Lock discipline: invoice row → note
 * row → series row, always; nothing locks a note before its invoice, and the
 * invoice transitions lock only the invoice.
 */
@Injectable()
export class ClientInvoiceNoteService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(InvoicingFacade) private readonly invoicing: InvoicingFacade,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  // ── commands ──────────────────────────────────────────────────────────────

  async create(command: CreateNoteCommand, idempotencyKey: string): Promise<NoteResult> {
    if (!UUID_RE.test(command.invoiceId)) throw clientInvoiceNotFound(command.invoiceId);
    const request = normalizeCreate(command);
    const payloadHash = hashCommandPayload({
      arm: 'note-create',
      tenantId: command.tenantId,
      invoiceId: command.invoiceId,
      kind: request.kind,
      reason: request.reason,
      reasonNote: request.reasonNote,
      settlesDispute: request.settlesDispute,
      lines: request.lines.map((line) => ({ invoiceLineId: line.invoiceLineId, amountPaise: line.amountPaise, overrideReason: line.overrideReason })),
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as NoteResult;
      const invoice = await lockInvoiceInTx(tx, command.tenantId, command.invoiceId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as NoteResult;

      assertNoteable(invoice, request.kind);
      if (request.settlesDispute) assertDisputed(invoice);
      const invoiceLines = await this.invoiceLinesInTx(tx, invoice);
      const byId = new Map(invoiceLines.map((line) => [line.facts.id, line]));
      for (const line of request.lines) {
        if (!byId.has(line.invoiceLineId)) {
          throw new ProblemException('not-found', 404, 'Invoice line not found', `Invoice ${invoice.invoiceNo ?? invoice.id} has no line "${line.invoiceLineId}".`);
        }
      }
      if (request.kind === 'credit') assertBeforeCreditDeadline(invoice);
      const credits = await this.issuedCreditsInTx(tx, invoice, null);
      let figures: NoteFigures;
      try {
        figures = computeNoteFigures({
          kind: request.kind,
          invoicePayablePaise: Number(invoice.payablePaise),
          invoiceLines: invoiceLines.map((line) => line.facts),
          issuedCredits: credits.byLine,
          priorCreditPayablePaise: credits.payable,
          lines: request.lines,
        });
      } catch (err) {
        // An amount whose tax or total leaves the exact paise range is a request the server cannot represent — a 400, never a 500.
        if (err instanceof ArithmeticOverflowError) throw validation(`The note's amounts are too large to compute exactly (${err.message}).`);
        throw err;
      }
      if (request.kind === 'debit') {
        const unexplained = request.lines.filter((line) => line.overrideReason === null && line.amountPaise > byId.get(line.invoiceLineId)!.facts.amountPaise);
        if (unexplained.length > 0) {
          throw new ProblemException(
            'debit-needs-override',
            409,
            'A debit over its invoice line needs a reason',
            `A debit note line above its invoice line's taxable value needs an override reason: ${unexplained
              .map((line) => `line ${line.invoiceLineId} (${rupees(line.amountPaise)} over ${rupees(byId.get(line.invoiceLineId)!.facts.amountPaise)})`)
              .join('; ')}.`,
            { lines: unexplained.map((line) => ({ invoiceLineId: line.invoiceLineId, invoiceLinePaise: byId.get(line.invoiceLineId)!.facts.amountPaise })) },
          );
        }
      }

      const noteId = uuidv7();
      const inserted = await tx
        .insert(clientInvoiceNotes)
        .values({
          id: noteId,
          tenantId: command.tenantId,
          clientId: invoice.clientId,
          invoiceId: invoice.id,
          kind: request.kind,
          status: 'draft',
          supplierGstin: invoice.supplierGstin!,
          placeOfSupply: invoice.placeOfSupply!,
          supplyType: invoice.supplyType!,
          reason: request.reason,
          reasonNote: request.reasonNote,
          settlesDispute: request.settlesDispute,
          subtotalPaise: figures.totals.subtotalPaise,
          cgstPaise: figures.totals.cgstPaise,
          sgstPaise: figures.totals.sgstPaise,
          igstPaise: figures.totals.igstPaise,
          taxPaise: figures.totals.taxPaise,
          totalPaise: figures.totals.totalPaise,
          roundOffPaise: figures.totals.roundOffPaise,
          payablePaise: figures.totals.payablePaise,
          party: invoice.party,
          createdBy: command.actorUserId,
        })
        .returning();
      const overrides = new Map(request.lines.map((line) => [line.invoiceLineId, line.overrideReason]));
      await tx.insert(clientInvoiceNoteLines).values(
        figures.lines.map((line) => {
          const source = byId.get(line.invoiceLineId)!.row;
          return {
            id: uuidv7(),
            tenantId: command.tenantId,
            noteId,
            invoiceLineId: source.id,
            chargeCode: source.chargeCode,
            basis: source.basis,
            uom: source.uom,
            segmentFrom: source.segmentFrom,
            segmentTo: source.segmentTo,
            sacCode: source.sacCode,
            gstBps: source.gstBps,
            placeOfSupply: source.placeOfSupply!,
            supplyType: source.supplyType!,
            amountPaise: line.amountPaise,
            cgstPaise: line.cgstPaise,
            sgstPaise: line.sgstPaise,
            igstPaise: line.igstPaise,
            overrideReason: overrides.get(line.invoiceLineId) ?? null,
          };
        }),
      );

      const result: NoteResult = { note: await noteViewOfInTx(tx, inserted[0]!, invoice) };
      await this.audit(tx, command, 'client_invoice_note.drafted', noteId, idempotencyKey, {
        kind: request.kind,
        reason: request.reason,
        settlesDispute: request.settlesDispute,
        lines: request.lines.map((line) => ({
          invoiceLineId: line.invoiceLineId,
          amountPaise: line.amountPaise,
          ...(line.overrideReason === null ? {} : { overrideReason: line.overrideReason }),
        })),
      });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  async issue(command: NoteTargetCommand, idempotencyKey: string): Promise<IssueNoteResult> {
    const payloadHash = hashCommandPayload({ arm: 'note-issue', tenantId: command.tenantId, noteId: command.noteId });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as IssueNoteResult;
      const { invoice, note } = await this.lockInvoiceAndNoteInTx(tx, command.tenantId, command.noteId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as IssueNoteResult;

      if (note.status !== 'draft') {
        throw new ProblemException('note-not-draft', 409, 'The note is not a draft', `${noteLabel(note)} is ${note.status} — only a draft is issued or discarded.`);
      }
      const kind = note.kind as NoteKind;
      assertNoteable(invoice, kind);
      if (note.settlesDispute) assertDisputed(invoice);
      if (kind === 'credit' && (await this.requiresSecondApproverInTx(tx, command.tenantId)) && note.createdBy === command.actorUserId) {
        throw new ProblemException(
          'note-needs-second-approver',
          409,
          'A second person must issue this credit note',
          'You drafted this credit note — another member with billing.invoice must issue it (the tenant requires a second approver for credit notes).',
        );
      }
      if (kind === 'credit') assertBeforeCreditDeadline(invoice);

      // Recompute against the credits issued SINCE the draft: a cap refusal
      // answers as such; any other difference is `note-figures-changed`.
      const invoiceLines = await this.invoiceLinesInTx(tx, invoice);
      const stored = await tx
        .select()
        .from(clientInvoiceNoteLines)
        .where(and(eq(clientInvoiceNoteLines.tenantId, command.tenantId), eq(clientInvoiceNoteLines.noteId, note.id)));
      const credits = await this.issuedCreditsInTx(tx, invoice, note.id);
      const figures = computeNoteFigures({
        kind,
        invoicePayablePaise: Number(invoice.payablePaise),
        invoiceLines: invoiceLines.map((line) => line.facts),
        issuedCredits: credits.byLine,
        priorCreditPayablePaise: credits.payable,
        lines: stored.map((line) => ({ invoiceLineId: line.invoiceLineId, amountPaise: Number(line.amountPaise) })),
      });
      const storedById = new Map(stored.map((line) => [line.invoiceLineId, line]));
      const linesMoved = figures.lines.some((line) => {
        const was = storedById.get(line.invoiceLineId)!;
        return Number(was.cgstPaise) !== line.cgstPaise || Number(was.sgstPaise) !== line.sgstPaise || Number(was.igstPaise) !== line.igstPaise;
      });
      const totals = noteTotalsOf(note);
      const totalsMoved =
        totals.subtotal !== figures.totals.subtotalPaise ||
        totals.cgst !== figures.totals.cgstPaise ||
        totals.sgst !== figures.totals.sgstPaise ||
        totals.igst !== figures.totals.igstPaise ||
        totals.roundOff !== figures.totals.roundOffPaise ||
        totals.payable !== figures.totals.payablePaise;
      if (linesMoved || totalsMoved) {
        throw new ProblemException(
          'note-figures-changed',
          409,
          'The note’s figures changed',
          'The credit notes on this invoice changed since this draft was made (one was issued or voided), so its tax or payable is no longer right — discard this draft and create it again.',
        );
      }

      const party = note.party as ClientInvoiceParty;
      if (party.recipient.gstin !== null && (await this.invoicing.eInvoiceAppliesInTx(tx, command.tenantId, note.supplierGstin))) {
        throw new ProblemException(
          'einvoice-required',
          409,
          'This note needs an IRN',
          `E-invoicing applies to ${note.supplierGstin} and the client is registered (${party.recipient.gstin}) — this note needs an IRN, which is not supported yet.`,
        );
      }

      const issuedAt = new Date(clientInvoiceClock.now()).toISOString();
      const fyLabel = fyLabelFor(issuedAt);
      const { seq, noteNo } = await this.allocateInTx(tx, command.tenantId, note.supplierGstin, kind, fyLabel);
      let issued: ClientInvoiceNote;
      try {
        const rows = await tx
          .update(clientInvoiceNotes)
          .set({ status: 'issued', noteNo, fyLabel, seriesSeq: seq, issuedAt, issuedBy: command.actorUserId, updatedAt: nowIso() })
          .where(and(eq(clientInvoiceNotes.tenantId, command.tenantId), eq(clientInvoiceNotes.id, note.id), eq(clientInvoiceNotes.status, 'draft')))
          .returning();
        issued = rows[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, NOTE_NO_UNIQUE)) {
          throw new ProblemException('conflict', 409, 'Note number in use', `Note number ${noteNo} is already used — the series moved; retry.`);
        }
        throw err;
      }

      let settled: ClientInvoice | null = null;
      if (note.settlesDispute) {
        const statusNote = `Settled by credit note ${noteNo}`;
        settled = await settleInTx(tx, invoice, statusNote, command.actorUserId, `note: ${statusNote} (key ${idempotencyKey})`);
      }

      const view = await noteViewOfInTx(tx, issued, settled ?? invoice);
      const result: IssueNoteResult = settled === null ? { note: view } : { note: view, invoice: await clientInvoiceViewInTx(tx, settled) };
      await this.event(tx, 'client_invoice_note.issued', issued);
      await this.audit(tx, command, 'client_invoice_note.issued', note.id, idempotencyKey, { noteNo, fyLabel, payablePaise: Number(issued.payablePaise) });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  /** Discard a draft: its lines, then the row. 204; a replay 204; a repeat under a new key 404. */
  async discard(command: NoteTargetCommand, idempotencyKey: string): Promise<void> {
    const payloadHash = hashCommandPayload({ arm: 'note-discard', tenantId: command.tenantId, noteId: command.noteId });
    await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      if ((await this.replay(tx, command.tenantId, idempotencyKey, payloadHash)) !== null) return;
      const { note } = await this.lockInvoiceAndNoteInTx(tx, command.tenantId, command.noteId);
      if ((await this.replay(tx, command.tenantId, idempotencyKey, payloadHash)) !== null) return;
      if (note.status !== 'draft') {
        throw new ProblemException('note-not-draft', 409, 'The note is not a draft', `${noteLabel(note)} is ${note.status} — an issued note is voided, never deleted.`);
      }
      await tx.delete(clientInvoiceNoteLines).where(and(eq(clientInvoiceNoteLines.tenantId, command.tenantId), eq(clientInvoiceNoteLines.noteId, note.id)));
      await tx.delete(clientInvoiceNotes).where(and(eq(clientInvoiceNotes.tenantId, command.tenantId), eq(clientInvoiceNotes.id, note.id)));
      await this.audit(tx, command, 'client_invoice_note.discarded', note.id, idempotencyKey, {});
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, { noteId: note.id, discarded: true });
    });
  }

  async void(command: VoidNoteCommand, idempotencyKey: string): Promise<NoteResult> {
    const voidNote = trimmedOrNull(command.voidNote);
    if (voidNote === null) throw validation('voidNote is required — say why the note is voided.');
    if (codePoints(voidNote) > NOTE_TEXT_MAX) throw validation(`voidNote is at most ${NOTE_TEXT_MAX} characters (got ${codePoints(voidNote)}).`);
    const payloadHash = hashCommandPayload({ arm: 'note-void', tenantId: command.tenantId, noteId: command.noteId, voidNote });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as NoteResult;
      const { invoice, note } = await this.lockInvoiceAndNoteInTx(tx, command.tenantId, command.noteId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as NoteResult;

      if (note.status !== 'issued') {
        throw new ProblemException('note-not-issued', 409, 'The note is not issued', `${noteLabel(note)} is ${note.status} — only an issued note is voided (a draft is discarded).`);
      }
      if (note.settlesDispute) {
        throw new ProblemException(
          'note-settles-dispute',
          409,
          'A settling credit note cannot be voided',
          `${noteLabel(note)} settled the invoice's dispute, and a settled invoice never reopens — correct it with a further note instead.`,
        );
      }
      const cutoff = gstr1VoidCutoff(note.issuedAt!);
      if (clientInvoiceClock.now() >= Date.parse(cutoff)) {
        throw new ProblemException(
          'note-period-closed',
          409,
          'The note’s GSTR-1 period has closed',
          `${noteLabel(note)} was issued on ${istDateOf(note.issuedAt!)}; the GSTR-1 due date for that month has passed (voids close at ${istDateOf(cutoff)} 00:00 IST), so it is already reported — correct it with a further note instead.`,
          { closedFrom: istDateOf(cutoff) },
        );
      }
      if (note.kind === 'credit' && (await this.requiresSecondApproverInTx(tx, command.tenantId)) && note.issuedBy === command.actorUserId) {
        throw new ProblemException(
          'note-needs-second-approver',
          409,
          'A second person must void this credit note',
          'You issued this credit note — another member with billing.invoice must void it (the tenant requires a second approver for credit notes).',
        );
      }

      const now = nowIso();
      const rows = await tx
        .update(clientInvoiceNotes)
        .set({ status: 'void', voidNote, voidedAt: now, voidedBy: command.actorUserId, updatedAt: now })
        .where(and(eq(clientInvoiceNotes.tenantId, command.tenantId), eq(clientInvoiceNotes.id, note.id), eq(clientInvoiceNotes.status, 'issued')))
        .returning();
      const voided = rows[0]!;
      const result: NoteResult = { note: await noteViewOfInTx(tx, voided, invoice) };
      await this.event(tx, 'client_invoice_note.voided', voided);
      await this.audit(tx, command, 'client_invoice_note.voided', note.id, idempotencyKey, { noteNo: voided.noteNo });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  /** A7 — the owner sets whether credit notes need a second person (`billing.configure`). Every PUT is audited. */
  async putPolicy(command: { tenantId: string; actorUserId: string; requireSecondApprover: unknown }, idempotencyKey: string): Promise<NotePolicyView> {
    if (typeof command.requireSecondApprover !== 'boolean') throw validation('requireSecondApprover must be true or false.');
    const requireSecondApprover = command.requireSecondApprover;
    const payloadHash = hashCommandPayload({ arm: 'note-policy', tenantId: command.tenantId, requireSecondApprover });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.configure');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as NotePolicyView;
      // The row lock (insert ON CONFLICT DO NOTHING, then FOR UPDATE) serialises two PUTs.
      await tx
        .insert(clientInvoiceNotePolicies)
        .values({ id: uuidv7(), tenantId: command.tenantId, requireSecondApprover: true, updatedBy: command.actorUserId })
        .onConflictDoNothing({ target: [clientInvoiceNotePolicies.tenantId] });
      const locked = await tx
        .select()
        .from(clientInvoiceNotePolicies)
        .where(eq(clientInvoiceNotePolicies.tenantId, command.tenantId))
        .limit(1)
        .for('update');
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as NotePolicyView;
      const row = locked[0]!;
      const from = row.requireSecondApprover;
      await tx
        .update(clientInvoiceNotePolicies)
        .set({ requireSecondApprover, updatedBy: command.actorUserId, updatedAt: nowIso() })
        .where(eq(clientInvoiceNotePolicies.id, row.id));
      const result: NotePolicyView = { requireSecondApprover };
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'client_invoice_note_policy.updated',
        targetType: 'client_invoice_note_policy',
        targetId: row.id,
        reference: idempotencyKey,
        changes: { from, to: requireSecondApprover },
        occurredAt: nowIso(),
      });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  // ── reads (member-open; a client-portal session is refused) ───────────────

  async getPolicy(tenantId: string, actorUserId: string): Promise<NotePolicyView> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) throw portalRefused();
      return { requireSecondApprover: await this.requiresSecondApproverInTx(tx, tenantId) };
    });
  }

  /** The invoice's notes (drafts included — operators see drafts) and its document value after the issued ones. */
  async notesOfInvoice(tenantId: string, actorUserId: string, invoiceId: string): Promise<InvoiceNotesView> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) throw portalRefused();
      if (!UUID_RE.test(invoiceId)) throw clientInvoiceNotFound(invoiceId);
      const invoices = await tx
        .select()
        .from(clientInvoices)
        .where(and(eq(clientInvoices.tenantId, tenantId), eq(clientInvoices.id, invoiceId)))
        .limit(1);
      const invoice = invoices[0];
      if (invoice === undefined) throw clientInvoiceNotFound(invoiceId);
      const rows = await tx
        .select()
        .from(clientInvoiceNotes)
        .where(and(eq(clientInvoiceNotes.tenantId, tenantId), eq(clientInvoiceNotes.invoiceId, invoiceId)))
        .orderBy(asc(clientInvoiceNotes.createdAt), asc(clientInvoiceNotes.id));
      const notes = rows.map(toEntryView);
      const netDocument = netDocumentOf(invoiceTotalsOf(invoice), notes);
      return { notes, netDocument, netDocumentPayable: netDocument.payable };
    });
  }

  async get(tenantId: string, actorUserId: string, noteId: string): Promise<NoteView> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) throw portalRefused();
      if (!UUID_RE.test(noteId)) throw noteNotFound(noteId);
      const rows = await tx
        .select({ note: clientInvoiceNotes, invoice: clientInvoices })
        .from(clientInvoiceNotes)
        .innerJoin(clientInvoices, and(eq(clientInvoices.tenantId, clientInvoiceNotes.tenantId), eq(clientInvoices.id, clientInvoiceNotes.invoiceId)))
        .where(and(eq(clientInvoiceNotes.tenantId, tenantId), eq(clientInvoiceNotes.id, noteId)))
        .limit(1);
      if (rows[0] === undefined) throw noteNotFound(noteId);
      return noteViewOfInTx(tx, rows[0].note, rows[0].invoice);
    });
  }

  /**
   * A15 — the notes register for one supplying GSTIN over inclusive IST dates
   * (a half-open window on `issued_at`), issued and void notes only, keyset
   * on (issued_at, id) over the `(tenant, gstin, issued_at, id)` lookup. One
   * row per (note, GST rate) with the GSTR-1 CDNR fields. JSON only: the web
   * writes the CSV (billing has no server export).
   */
  async register(tenantId: string, actorUserId: string, query: NoteRegisterQuery): Promise<NoteRegisterPage> {
    const gstin = query.gstin;
    if (gstin === undefined || !GSTIN_RE.test(gstin)) throw validation(`gstin is required — a 15-character GSTIN (got ${JSON.stringify(gstin ?? null)}).`);
    if (query.from === undefined || query.to === undefined) throw validation('from and to are required — inclusive IST dates, YYYY-MM-DD.');
    assertMeteringPeriod(query.from, query.to);
    if (query.kind !== undefined && !(NOTE_KINDS as readonly string[]).includes(query.kind)) throw validation(`kind must be one of ${JSON.stringify(NOTE_KINDS)}.`);
    if (query.status !== undefined && query.status !== 'issued' && query.status !== 'void') throw validation('status must be issued or void.');
    const limit = query.limit ?? NOTE_REGISTER_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > NOTE_REGISTER_MAX_LIMIT) throw validation(`limit must be 1–${NOTE_REGISTER_MAX_LIMIT}.`);
    const after = query.cursor === undefined ? null : decodeRegisterCursor(query.cursor);
    const fromAt = istMidnightOf(query.from);
    const toAt = istMidnightOf(addIsoDays(query.to, 1));

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) throw portalRefused();
      const rows = await tx
        .select({
          note: clientInvoiceNotes,
          issuedAtText: sql<string>`${clientInvoiceNotes.issuedAt}::text`,
          invoiceNo: clientInvoices.invoiceNo,
          invoiceIssuedAt: clientInvoices.issuedAt,
        })
        .from(clientInvoiceNotes)
        .innerJoin(clientInvoices, and(eq(clientInvoices.tenantId, clientInvoiceNotes.tenantId), eq(clientInvoices.id, clientInvoiceNotes.invoiceId)))
        .where(
          and(
            eq(clientInvoiceNotes.tenantId, tenantId),
            eq(clientInvoiceNotes.supplierGstin, gstin),
            sql`${clientInvoiceNotes.issuedAt} is not null`,
            gte(clientInvoiceNotes.issuedAt, fromAt),
            lt(clientInvoiceNotes.issuedAt, toAt),
            ne(clientInvoiceNotes.status, 'draft'),
            query.kind === undefined ? undefined : eq(clientInvoiceNotes.kind, query.kind),
            query.status === undefined ? undefined : eq(clientInvoiceNotes.status, query.status),
            after === null
              ? undefined
              : sql`(${clientInvoiceNotes.issuedAt}, ${clientInvoiceNotes.id}) > (${after.issuedAt}::timestamptz, ${after.id}::uuid)`,
          ),
        )
        .orderBy(asc(clientInvoiceNotes.issuedAt), asc(clientInvoiceNotes.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const ids = page.map((row) => row.note.id);
      const byRate =
        ids.length === 0
          ? []
          : await tx
              .select({
                noteId: clientInvoiceNoteLines.noteId,
                gstBps: clientInvoiceNoteLines.gstBps,
                taxable: sql<string>`sum(${clientInvoiceNoteLines.amountPaise})::text`,
                cgst: sql<string>`sum(${clientInvoiceNoteLines.cgstPaise})::text`,
                sgst: sql<string>`sum(${clientInvoiceNoteLines.sgstPaise})::text`,
                igst: sql<string>`sum(${clientInvoiceNoteLines.igstPaise})::text`,
              })
              .from(clientInvoiceNoteLines)
              .where(and(eq(clientInvoiceNoteLines.tenantId, tenantId), inArray(clientInvoiceNoteLines.noteId, ids)))
              .groupBy(clientInvoiceNoteLines.noteId, clientInvoiceNoteLines.gstBps)
              .orderBy(asc(clientInvoiceNoteLines.noteId), asc(clientInvoiceNoteLines.gstBps));
      const out: NoteRegisterRow[] = [];
      for (const row of page) {
        const party = row.note.party as ClientInvoiceParty;
        for (const rate of byRate.filter((r) => r.noteId === row.note.id)) {
          out.push({
            noteId: row.note.id,
            noteNo: row.note.noteNo!,
            noteDate: istDateOf(row.note.issuedAt!),
            kind: row.note.kind as NoteKind,
            status: row.note.status as 'issued' | 'void',
            voided: row.note.status === 'void',
            recipientGstin: party.recipient.gstin,
            recipientName: party.recipient.legalName ?? party.recipient.name,
            placeOfSupply: row.note.placeOfSupply,
            supplyType: row.note.supplyType as SupplyType,
            invoiceNo: row.invoiceNo!,
            invoiceDate: istDateOf(row.invoiceIssuedAt!),
            gstBps: rate.gstBps,
            taxablePaise: Number(rate.taxable),
            igstPaise: Number(rate.igst),
            cgstPaise: Number(rate.cgst),
            sgstPaise: Number(rate.sgst),
            noteValuePaise: Number(row.note.payablePaise),
          });
        }
      }
      const last = page.at(-1);
      return {
        rows: out,
        nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: fullPrecisionInstant(last.issuedAtText), id: last.note.id }) : null,
      };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The note's invoice row (FOR UPDATE, 404), then the note row (FOR UPDATE, 404) — never the reverse. */
  private async lockInvoiceAndNoteInTx(tx: TenantTx, tenantId: string, noteId: string): Promise<{ invoice: ClientInvoice; note: ClientInvoiceNote }> {
    if (!UUID_RE.test(noteId)) throw noteNotFound(noteId);
    const found = await tx
      .select({ invoiceId: clientInvoiceNotes.invoiceId })
      .from(clientInvoiceNotes)
      .where(and(eq(clientInvoiceNotes.tenantId, tenantId), eq(clientInvoiceNotes.id, noteId)))
      .limit(1);
    if (found[0] === undefined) throw noteNotFound(noteId);
    const invoice = await lockInvoiceInTx(tx, tenantId, found[0].invoiceId);
    const notes = await tx
      .select()
      .from(clientInvoiceNotes)
      .where(and(eq(clientInvoiceNotes.tenantId, tenantId), eq(clientInvoiceNotes.id, noteId)))
      .limit(1)
      .for('update');
    if (notes[0] === undefined) throw noteNotFound(noteId);
    return { invoice, note: notes[0] };
  }

  private async invoiceLinesInTx(
    tx: TenantTx,
    invoice: ClientInvoice,
  ): Promise<{ row: typeof clientInvoiceLines.$inferSelect; facts: NoteInvoiceLineFacts }[]> {
    const rows = await tx
      .select()
      .from(clientInvoiceLines)
      .where(and(eq(clientInvoiceLines.tenantId, invoice.tenantId), eq(clientInvoiceLines.invoiceId, invoice.id)));
    return rows.map((row) => ({
      row,
      facts: {
        id: row.id,
        amountPaise: Number(row.amountPaise ?? 0),
        cgstPaise: Number(row.cgstPaise),
        sgstPaise: Number(row.sgstPaise),
        igstPaise: Number(row.igstPaise),
        gstBps: row.gstBps,
        supplyType: (row.supplyType ?? invoice.supplyType) as SupplyType,
      },
    }));
  }

  /** Σ over the invoice's ISSUED credit notes (optionally excluding one): per invoice line, and the payable. */
  private async issuedCreditsInTx(
    tx: TenantTx,
    invoice: ClientInvoice,
    excludeNoteId: string | null,
  ): Promise<{ byLine: Map<string, NoteHeads>; payable: number }> {
    const issued = and(
      eq(clientInvoiceNotes.tenantId, invoice.tenantId),
      eq(clientInvoiceNotes.invoiceId, invoice.id),
      eq(clientInvoiceNotes.kind, 'credit'),
      eq(clientInvoiceNotes.status, 'issued'),
      excludeNoteId === null ? undefined : ne(clientInvoiceNotes.id, excludeNoteId),
    );
    const lines = await tx
      .select({
        invoiceLineId: clientInvoiceNoteLines.invoiceLineId,
        amount: sql<string>`sum(${clientInvoiceNoteLines.amountPaise})::text`,
        cgst: sql<string>`sum(${clientInvoiceNoteLines.cgstPaise})::text`,
        sgst: sql<string>`sum(${clientInvoiceNoteLines.sgstPaise})::text`,
        igst: sql<string>`sum(${clientInvoiceNoteLines.igstPaise})::text`,
      })
      .from(clientInvoiceNoteLines)
      .innerJoin(clientInvoiceNotes, and(eq(clientInvoiceNotes.tenantId, clientInvoiceNoteLines.tenantId), eq(clientInvoiceNotes.id, clientInvoiceNoteLines.noteId)))
      .where(issued)
      .groupBy(clientInvoiceNoteLines.invoiceLineId);
    const payable = await tx
      .select({ total: sql<string>`coalesce(sum(${clientInvoiceNotes.payablePaise}), 0)::text` })
      .from(clientInvoiceNotes)
      .where(issued);
    return {
      byLine: new Map(
        lines.map((line) => [
          line.invoiceLineId,
          { amountPaise: Number(line.amount), cgstPaise: Number(line.cgst), sgstPaise: Number(line.sgst), igstPaise: Number(line.igst) },
        ]),
      ),
      payable: Number(payable[0]?.total ?? 0),
    };
  }

  /** A7 — a missing policy row means a second approver is REQUIRED. */
  private async requiresSecondApproverInTx(tx: TenantTx, tenantId: string): Promise<boolean> {
    const rows = await tx
      .select({ require: clientInvoiceNotePolicies.requireSecondApprover })
      .from(clientInvoiceNotePolicies)
      .where(eq(clientInvoiceNotePolicies.tenantId, tenantId))
      .limit(1);
    return rows[0]?.require ?? true;
  }

  /**
   * The next number of the (tenant, GSTIN, kind, FY) series: the row is
   * inserted ON CONFLICT DO NOTHING, then taken FOR UPDATE (the lock order's
   * last link). The number is formatted BEFORE the series moves, so an
   * exhausted series refuses (409 `note-series-exhausted`) without spending.
   */
  private async allocateInTx(tx: TenantTx, tenantId: string, supplierGstin: string, kind: NoteKind, fyLabel: string): Promise<{ seq: number; noteNo: string }> {
    await tx
      .insert(clientInvoiceNoteSeries)
      .values({ id: uuidv7(), tenantId, supplierGstin, kind, fyLabel, lastSeq: 0 })
      .onConflictDoNothing({ target: [clientInvoiceNoteSeries.tenantId, clientInvoiceNoteSeries.supplierGstin, clientInvoiceNoteSeries.kind, clientInvoiceNoteSeries.fyLabel] });
    const rows = await tx
      .select()
      .from(clientInvoiceNoteSeries)
      .where(
        and(
          eq(clientInvoiceNoteSeries.tenantId, tenantId),
          eq(clientInvoiceNoteSeries.supplierGstin, supplierGstin),
          eq(clientInvoiceNoteSeries.kind, kind),
          eq(clientInvoiceNoteSeries.fyLabel, fyLabel),
        ),
      )
      .limit(1)
      .for('update');
    const series = rows[0]!;
    const seq = Number(series.lastSeq) + 1;
    let noteNo: string;
    try {
      noteNo = formatServiceNoteNo(supplierGstin, kind, fyLabel, seq);
    } catch (err) {
      if (err instanceof ArithmeticOverflowError && /series exhausted/.test(err.message)) {
        throw new ProblemException(
          'note-series-exhausted',
          409,
          'The note series is exhausted',
          `The ${kind} note series for ${supplierGstin} ${fyLabel} has used all its numbers — no more ${kind} notes can issue under this GSTIN this FY.`,
        );
      }
      throw err;
    }
    await tx.update(clientInvoiceNoteSeries).set({ lastSeq: seq, updatedAt: nowIso() }).where(eq(clientInvoiceNoteSeries.id, series.id));
    return { seq, noteNo };
  }

  /** A16 — the outbox event at step 9 (no consumer yet). */
  private async event(tx: TenantTx, type: (typeof NOTE_EVENT_TYPES)[number], note: ClientInvoiceNote): Promise<void> {
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId: note.tenantId,
      type,
      occurredAt: nowIso(),
      payload: { noteId: note.id, invoiceId: note.invoiceId, clientId: note.clientId, kind: note.kind, noteNo: note.noteNo },
    });
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
    action: NoteAuditAction,
    noteId: string,
    reference: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      action,
      targetType: 'client_invoice_note',
      targetId: noteId,
      reference,
      changes,
      occurredAt: nowIso(),
    });
  }

  private async writeIdempotencyKey(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string, snapshot: unknown): Promise<void> {
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

function decodeRegisterCursor(cursor: string): { issuedAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    if (!UUID_RE.test(decoded.id) || !CURSOR_INSTANT_RE.test(decoded.createdAt) || Number.isNaN(Date.parse(decoded.createdAt))) {
      throw new Error('malformed cursor payload');
    }
    return { issuedAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new ProblemException('invalid-cursor', 400, 'Malformed pagination cursor', 'The cursor parameter is not a valid opaque page cursor.');
  }
}
