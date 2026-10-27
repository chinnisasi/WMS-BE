import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  clientChargePolicies,
  clientCharges,
  clientInvoiceLines,
  clientInvoices,
  idempotencyKeys,
  type ClientCharge,
} from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK, type OutboxSink } from '../../shared/events/outbox.seam';
import { fyLabelFor } from '../../shared/primitives/gst';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { decodeCursor, encodeCursor, type Page } from '../../shared/primitives/pagination';
import { addIsoDays, fullPrecisionInstant, isIsoDate, istDateOf, istMidnightOf, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { lockClientInTx } from '../clients/clients.facade';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { ROLE_CAPABILITIES, assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { clientInvoiceSupplierFactsInTx, getMemberClientIdIn, getMemberRoleIn } from '../tenancy/tenancy.service';
import { rateCardInForceInTx } from './billing.facade';
import {
  CHARGE_DESCRIPTION_MAX,
  CHARGE_LATE_DAYS,
  CHARGE_NOTE_MAX,
  CHARGE_REFERENCE_MAX,
  CLIENT_CHARGE_CATEGORIES,
  CLIENT_CHARGE_LIST_DEFAULT_LIMIT,
  CLIENT_CHARGE_LIST_MAX_LIMIT,
  CLIENT_CHARGE_STATUSES,
  CLIENT_CHARGE_UNITS,
  DEFAULT_SELF_APPROVE_LIMIT_PAISE,
  MAX_CHARGE_AMOUNT_PAISE,
  MAX_CHARGE_QUANTITY_MILLI,
  MAX_CHARGE_RATE_PAISE,
  MAX_SELF_APPROVE_LIMIT_PAISE,
  OTHER_SACS,
  boundedText,
  chargeAmountPaise,
  monthLabel,
  monthOf,
  nextMonth,
  parseChargeQuantity,
  sacOfCategory,
  type ClientChargeCategory,
  type ClientChargeEventType,
  type ClientChargeStatus,
  type ClientChargeUnit,
  type ClientChargeWarningCode,
} from './client-charges';
import { InventoryFacade } from '../inventory/inventory.facade';
import { clientGstinFootprintInTx, clientInvoiceClock, portalRefused } from './client-invoices';
import { milliToDecimal } from './metering';

/**
 * Story 5-5a — ad-hoc charges (contract billing). One billable event for one
 * client in one warehouse on one IST day — extra labour, relabelling,
 * repacking, a client-requested re-slot, returns processing, overflow space
 * — recorded with its figures fixed, approved (maker/checker above the
 * tenant's self-approval limit), then billed as its own `adhoc` line on the
 * invoice of `(client, bill_month, supplier_gstin)`.
 *
 * The house skeleton on every command (IMPLEMENTATION-GUIDE §1): shape checks
 * above the transaction → capability → replay → `lockClientInTx` (the lock
 * prepare, refresh and issue take — so a charge lands before an issue's
 * recompute, which then answers `stale`, or sees the issued invoice and
 * refuses) → replay under the lock → lock the charge row → guards → write →
 * outbox → audit → the idempotency key LAST. Lock order: client row →
 * charge row; nothing locks a charge before its client. The database is the
 * backstop (`drizzle/0099_contract_billing.sql`: the CHECKs and
 * `client_charges_guard`).
 */

export interface ClientChargeBillingView {
  readonly invoiceId: string;
  readonly invoiceNo: string | null;
  readonly status: string;
}

export interface ClientChargeView {
  readonly id: string;
  readonly clientId: string;
  readonly warehouseId: string;
  /** The supplying GSTIN frozen at record (the invoice group key); null when neither the warehouse nor the tenant has one. */
  readonly supplierGstin: string | null;
  /** The IST date of the work. */
  readonly chargeDate: string;
  /** The first of the month whose invoice bills it (A4) — later than the service month when that month was already invoiced. */
  readonly billMonth: string;
  readonly category: ClientChargeCategory;
  readonly description: string;
  readonly sacCode: string;
  readonly unit: ClientChargeUnit;
  /** Units of `unit`, a decimal string (up to three places). */
  readonly quantity: string;
  readonly unitRatePaise: number;
  readonly amountPaise: number;
  readonly reference: string | null;
  readonly clientAuthorizationRef: string | null;
  /** Internal only — never printed, never in the portal. */
  readonly evidenceNote: string | null;
  readonly status: ClientChargeStatus;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly cancelledBy: string | null;
  readonly cancelledAt: string | null;
  readonly cancelNote: string | null;
  readonly createdAt: string;
  /** A31 — the latest NON-VOID invoice with a line billing this charge, or null. */
  readonly billing: ClientChargeBillingView | null;
}

export interface ClientChargeWarning {
  readonly code: ClientChargeWarningCode;
  readonly detail: string;
}

export interface RecordChargeResult {
  readonly charge: ClientChargeView;
  readonly warnings: readonly ClientChargeWarning[];
}

export interface ChargeMutationResult {
  readonly charge: ClientChargeView;
}

export interface ChargePolicyView {
  readonly selfApproveLimitPaise: number;
  /** No policy row: the ₹10,000 default applies. */
  readonly isDefault: boolean;
}

export interface RecordClientChargeCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  readonly warehouseId: string;
  readonly chargeDate: unknown;
  readonly category: unknown;
  readonly description: unknown;
  readonly sacCode?: unknown;
  readonly unit: unknown;
  readonly quantity: unknown;
  readonly unitRatePaise: unknown;
  readonly reference?: unknown;
  readonly clientAuthorizationRef?: unknown;
  readonly evidenceNote?: unknown;
}

export interface ChargeTargetCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly chargeId: string;
}

export interface ChargeNoteCommand extends ChargeTargetCommand {
  readonly note: unknown;
}

export interface ListClientChargesQuery {
  readonly clientId?: string | undefined;
  readonly warehouseId?: string | undefined;
  readonly status?: string | undefined;
  /** `YYYY-MM` — filters `bill_month`. */
  readonly month?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The record request, normalised above the transaction (its shape is a 400, never a replay). */
export interface NormalizedChargeRecord {
  readonly chargeDate: string;
  readonly category: ClientChargeCategory;
  readonly description: string;
  /** The request's SAC (`other` only — null otherwise); the resolved SAC is `sacOfCategory`. */
  readonly sacCode: string | null;
  readonly unit: ClientChargeUnit;
  readonly quantityMilli: bigint;
  readonly unitRatePaise: number;
  readonly amountPaise: number;
  readonly reference: string | null;
  readonly clientAuthorizationRef: string | null;
  readonly evidenceNote: string | null;
}

type ChargeAuditAction = 'client_charge.recorded' | 'client_charge.approved' | 'client_charge.rejected' | 'client_charge.cancelled';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const INVOICED_STATUSES = ['issued', 'disputed', 'settled'] as const;

function validation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid ad-hoc charge', detail);
}

/**
 * The record request's SHAPE (400, above the transaction): the vocabularies,
 * the lengths, the quantity format and range, the rate range, the amount
 * 1..₹1 crore (a charge that rounds to zero paise is refused, never written),
 * `other` ⇒ a SAC from the four, and no SAC on any other category.
 */
export function normalizeChargeRecord(command: Omit<RecordClientChargeCommand, 'tenantId' | 'actorUserId' | 'clientId' | 'warehouseId'>): NormalizedChargeRecord {
  if (typeof command.chargeDate !== 'string' || !isIsoDate(command.chargeDate)) {
    throw validation(`chargeDate must be a real calendar date YYYY-MM-DD (got ${JSON.stringify(command.chargeDate)}).`);
  }
  if (typeof command.category !== 'string' || !(CLIENT_CHARGE_CATEGORIES as readonly string[]).includes(command.category)) {
    throw validation(`category must be one of ${JSON.stringify(CLIENT_CHARGE_CATEGORIES)} (got ${JSON.stringify(command.category)}).`);
  }
  const category = command.category as ClientChargeCategory;
  const description = boundedText(command.description, 'description', CHARGE_DESCRIPTION_MAX);
  if (description.problem !== null) throw validation(description.problem);
  if (description.value === null) throw validation('description is required — it is printed on the invoice line.');
  const sac = command.sacCode === undefined || command.sacCode === null ? null : command.sacCode;
  if (category === 'other') {
    if (typeof sac !== 'string' || !(OTHER_SACS as readonly string[]).includes(sac)) {
      throw validation(`An "other" charge needs a services SAC, one of ${JSON.stringify(OTHER_SACS)} (got ${JSON.stringify(sac)}) — goods are invoiced on a goods tax invoice, not here.`);
    }
  } else if (sac !== null) {
    throw validation(`sacCode is chosen only for an "other" charge — ${category} is always ${sacOfCategory(category, null)}.`);
  }
  if (typeof command.unit !== 'string' || !(CLIENT_CHARGE_UNITS as readonly string[]).includes(command.unit)) {
    throw validation(`unit must be one of ${JSON.stringify(CLIENT_CHARGE_UNITS)} (got ${JSON.stringify(command.unit)}).`);
  }
  const quantityMilli = parseChargeQuantity(command.quantity);
  if (quantityMilli === null) {
    throw validation(`quantity must be a decimal number with at most three decimal places, e.g. "2.5" (got ${JSON.stringify(command.quantity)}).`);
  }
  if (quantityMilli < 1n || quantityMilli > BigInt(MAX_CHARGE_QUANTITY_MILLI)) {
    throw validation(`quantity must be more than 0 and at most ${MAX_CHARGE_QUANTITY_MILLI / 1000} (got ${JSON.stringify(command.quantity)}).`);
  }
  const rate = command.unitRatePaise;
  if (typeof rate !== 'number' || !Number.isSafeInteger(rate) || rate < 1 || rate > MAX_CHARGE_RATE_PAISE) {
    throw validation(`unitRatePaise must be whole paise 1..${MAX_CHARGE_RATE_PAISE} (₹0.01 .. ₹1 lakh) (got ${JSON.stringify(rate)}).`);
  }
  const amount = chargeAmountPaise(quantityMilli, rate);
  if (amount < 1n) throw validation('The charge rounds to ₹0.00 — a quantity × rate below half a paisa cannot be billed.');
  if (amount > BigInt(MAX_CHARGE_AMOUNT_PAISE)) throw validation(`The charge is over the ₹1 crore cap (quantity × rate = ${amount.toString()} paise).`);
  const reference = boundedText(command.reference, 'reference', CHARGE_REFERENCE_MAX);
  if (reference.problem !== null) throw validation(reference.problem);
  const clientAuthorizationRef = boundedText(command.clientAuthorizationRef, 'clientAuthorizationRef', CHARGE_REFERENCE_MAX);
  if (clientAuthorizationRef.problem !== null) throw validation(clientAuthorizationRef.problem);
  const evidenceNote = boundedText(command.evidenceNote, 'evidenceNote', CHARGE_NOTE_MAX);
  if (evidenceNote.problem !== null) throw validation(evidenceNote.problem);
  return {
    chargeDate: command.chargeDate,
    category,
    description: description.value,
    sacCode: category === 'other' ? (sac as string) : null,
    unit: command.unit as ClientChargeUnit,
    quantityMilli,
    unitRatePaise: rate,
    amountPaise: Number(amount),
    reference: reference.value,
    clientAuthorizationRef: clientAuthorizationRef.value,
    evidenceNote: evidenceNote.value,
  };
}

/** A decision or cancel note: required, 1..500 code points (400, above the transaction). */
function requiredNote(note: unknown, what: string): string {
  const parsed = boundedText(note, 'note', CHARGE_NOTE_MAX);
  if (parsed.problem !== null) throw validation(parsed.problem);
  if (parsed.value === null) throw validation(`A note is required to ${what} a charge — say why.`);
  return parsed.value;
}

/**
 * A10 — the earliest `chargeDate` accepted: 1 April of the PREVIOUS financial
 * year of `today` (FY-2627 → 2025-04-01).
 */
export function earliestChargeDate(today: string): string {
  const fy = fyLabelFor(istMidnightOf(today));
  return `${2000 + Number(fy.slice(3, 5)) - 1}-04-01`;
}

export function chargeNotFound(chargeId: string): ProblemException {
  return new ProblemException('charge-not-found', 404, 'Ad-hoc charge not found', `No ad-hoc charge with id "${chargeId}" exists in this tenant.`);
}

function chargePeriodInvoiced(charge: Pick<ClientCharge, 'billMonth' | 'supplierGstin'>): ProblemException {
  return new ProblemException(
    'charge-period-invoiced',
    409,
    'The charge’s billing month is invoiced',
    `This charge's billing month (${monthLabel(charge.billMonth)}) is already invoiced under ${charge.supplierGstin ?? 'this registration'} — it can no longer change.`,
    { billMonth: charge.billMonth.slice(0, 7) },
  );
}

function decodeChargeCursor(cursor: string): { createdAt: string; id: string } {
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

const isoOrNull = (value: string | null): string | null => (value === null ? null : new Date(value).toISOString());

function toView(row: ClientCharge, billing: ClientChargeBillingView | null): ClientChargeView {
  return {
    id: row.id,
    clientId: row.clientId,
    warehouseId: row.warehouseId,
    supplierGstin: row.supplierGstin,
    chargeDate: row.chargeDate,
    billMonth: row.billMonth,
    category: row.category as ClientChargeCategory,
    description: row.description,
    sacCode: row.sacCode,
    unit: row.unit as ClientChargeUnit,
    quantity: milliToDecimal(BigInt(row.quantityMilli)),
    unitRatePaise: Number(row.unitRatePaise),
    amountPaise: Number(row.amountPaise),
    reference: row.reference,
    clientAuthorizationRef: row.clientAuthorizationRef,
    evidenceNote: row.evidenceNote,
    status: row.status as ClientChargeStatus,
    recordedBy: row.recordedBy,
    recordedAt: new Date(row.recordedAt).toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: isoOrNull(row.decidedAt),
    decisionNote: row.decisionNote,
    cancelledBy: row.cancelledBy,
    cancelledAt: isoOrNull(row.cancelledAt),
    cancelNote: row.cancelNote,
    createdAt: new Date(row.createdAt).toISOString(),
    billing,
  };
}

@Injectable()
export class ClientChargeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  // ── commands ──────────────────────────────────────────────────────────────

  /**
   * Record a charge (`billing.charge`). Approved at record when the recorder
   * holds `billing.invoice` AND the amount is within the tenant's
   * self-approval limit (A22); otherwise pending. `bill_month` is the
   * earliest month ≥ the service month whose (client, month, GSTIN) is not
   * invoiced (A4) — so record never answers `charge-period-invoiced`.
   */
  async record(command: RecordClientChargeCommand, idempotencyKey: string): Promise<RecordChargeResult> {
    if (!UUID_RE.test(command.clientId)) throw validation(`clientId must be a uuid (got ${JSON.stringify(command.clientId)}).`);
    if (!UUID_RE.test(command.warehouseId)) throw validation(`warehouseId must be a uuid (got ${JSON.stringify(command.warehouseId)}).`);
    const request = normalizeChargeRecord(command);
    const clientId = command.clientId.toLowerCase();
    const warehouseId = command.warehouseId.toLowerCase();
    // A18 — the quantity hashes as its normalised milli (a decimal string):
    // "2.5" and "2.50" are one request.
    const payloadHash = hashCommandPayload({
      arm: 'charge-record',
      tenantId: command.tenantId,
      clientId,
      warehouseId,
      chargeDate: request.chargeDate,
      category: request.category,
      description: request.description,
      sacCode: request.sacCode,
      unit: request.unit,
      quantityMilli: request.quantityMilli.toString(),
      unitRatePaise: request.unitRatePaise,
      reference: request.reference,
      clientAuthorizationRef: request.clientAuthorizationRef,
      evidenceNote: request.evidenceNote,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'billing.charge');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as RecordChargeResult;
      const client = await lockClientInTx(tx, command.tenantId, clientId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as RecordChargeResult;

      if (client.systemOwned) {
        throw new ProblemException(
          'client-not-billable',
          409,
          'Your own company is not invoiced',
          "Ad-hoc charges bill a client brand — the tenant's own client is never billed.",
        );
      }
      if (client.status !== 'active') {
        throw new ProblemException(
          'client-not-active',
          409,
          'Client is not active',
          `Client ${client.code} is ${client.status} — a new charge is recorded only for an active client (its pending charges can still be approved, rejected or cancelled).`,
        );
      }
      const facts = await clientInvoiceSupplierFactsInTx(tx, command.tenantId);
      const warehouse = facts.warehouses.find((row) => row.id === warehouseId);
      if (warehouse === undefined) {
        throw new ProblemException('not-found', 404, 'Warehouse not found', `No warehouse with id "${warehouseId}" exists in this tenant.`);
      }
      // A10 — the date window, behind the replay lookup on the command clock.
      const today = istDateOf(new Date(clientInvoiceClock.now()).toISOString());
      const earliest = earliestChargeDate(today);
      if (request.chargeDate > today || request.chargeDate < earliest) {
        throw validation(
          request.chargeDate > today
            ? `chargeDate ${request.chargeDate} is in the future — record work once it is done (today is ${today}, IST).`
            : `chargeDate ${request.chargeDate} is too far back — the earliest is ${earliest} (1 April of the previous financial year).`,
        );
      }

      const supplierGstin = warehouse.gstin ?? facts.tenantGstin;
      const serviceMonth = monthOf(request.chargeDate);
      const billMonth = await this.openBillMonthInTx(tx, command.tenantId, client.id, supplierGstin, serviceMonth);
      const limit = await this.selfApproveLimitInTx(tx, command.tenantId);
      const autoApproved = ROLE_CAPABILITIES[role].has('billing.invoice') && request.amountPaise <= limit;
      const now = nowIso();

      const inserted = await tx
        .insert(clientCharges)
        .values({
          id: uuidv7(),
          tenantId: command.tenantId,
          clientId: client.id,
          warehouseId,
          supplierGstin,
          chargeDate: request.chargeDate,
          billMonth,
          category: request.category,
          description: request.description,
          sacCode: sacOfCategory(request.category, request.sacCode)!,
          unit: request.unit,
          // ≤ 10,000,000 milli (the A29 bound) — exact as a number.
          quantityMilli: Number(request.quantityMilli),
          unitRatePaise: request.unitRatePaise,
          amountPaise: request.amountPaise,
          reference: request.reference,
          clientAuthorizationRef: request.clientAuthorizationRef,
          evidenceNote: request.evidenceNote,
          status: autoApproved ? 'approved' : 'pending',
          recordedBy: command.actorUserId,
          recordedAt: now,
          decidedBy: autoApproved ? command.actorUserId : null,
          decidedAt: autoApproved ? now : null,
        })
        .returning();
      const row = inserted[0]!;

      const warnings: ClientChargeWarning[] = [];
      if (request.chargeDate < addIsoDays(today, -CHARGE_LATE_DAYS)) {
        warnings.push({
          code: 'charge-late',
          detail: `This charge is for work done more than ${CHARGE_LATE_DAYS} days ago (${request.chargeDate}) — check it was agreed with the client.`,
        });
      }
      if (billMonth !== serviceMonth) {
        warnings.push({
          code: 'charge-billed-later',
          detail: `${monthLabel(serviceMonth)} is already invoiced under ${supplierGstin ?? 'this registration'}, so this charge bills on the ${monthLabel(billMonth)} invoice (its line keeps the true date ${request.chargeDate}).`,
        });
      }
      const card = await rateCardInForceInTx(tx, command.tenantId, client.id, istMidnightOf(billMonth));
      if (card !== null && card.lines.some((line) => line.chargeCode === 'minimum_monthly')) {
        // Code review C2 — a charge whose GSTIN widens the client's footprint
        // past one group switches its per-invoice minimum off (A21): say so
        // at record, not only as a later draft warning.
        const scopes = await this.inventory.clientWarehousesWithEventsInTx(tx, command.tenantId, [client.id]);
        const footprint = await clientGstinFootprintInTx(tx, command.tenantId, client.id, scopes.map((scope) => scope.warehouseId), facts);
        if (footprint.length > 1) {
          warnings.push({
            code: 'charge-disables-minimum',
            detail: `${client.code} is now billed under ${footprint.length} GSTINs (${footprint.map((gstin) => gstin ?? 'no GSTIN').join(', ')}) — its minimum monthly charge is per invoice, so it will not be applied while it bills under more than one. Cancel this charge if the warehouse was a mistake.`,
          });
        }
        const live = await tx
          .select({ id: clientInvoices.id })
          .from(clientInvoices)
          .where(
            and(
              eq(clientInvoices.tenantId, command.tenantId),
              eq(clientInvoices.clientId, client.id),
              eq(clientInvoices.periodStart, billMonth),
              ne(clientInvoices.status, 'void'),
              sql`coalesce(${clientInvoices.supplierGstin}, '') = ${supplierGstin ?? ''}`,
            ),
          )
          .limit(1);
        if (live.length === 0) {
          warnings.push({
            code: 'charge-may-bring-minimum',
            detail: `${client.code}'s rate card carries a minimum monthly charge, and ${monthLabel(billMonth)} has no invoice yet under ${supplierGstin ?? 'this registration'} — this charge may bring the minimum onto that month's invoice.`,
          });
        }
      }

      const result: RecordChargeResult = { charge: toView(row, null), warnings };
      if (!autoApproved) await this.event(tx, 'client_charge.pending', row);
      await this.audit(tx, command, 'client_charge.recorded', row.id, idempotencyKey, autoApproved ? { status: 'approved', autoApproved: true } : { status: 'pending' });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  /** Approve a pending charge (`billing.invoice`) — a SECOND person: never its recorder. */
  async approve(command: ChargeTargetCommand, idempotencyKey: string): Promise<ChargeMutationResult> {
    const payloadHash = hashCommandPayload({ arm: 'charge-approve', tenantId: command.tenantId, chargeId: command.chargeId });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as ChargeMutationResult;
      const locked = await this.lockClientAndChargeInTx(tx, command.tenantId, command.chargeId, idempotencyKey, payloadHash);
      if ('replayed' in locked) return locked.replayed as ChargeMutationResult;
      const charge = locked.charge;
      if (charge.status !== 'pending') throw chargeNotPending(charge);
      if (charge.recordedBy === command.actorUserId) {
        throw new ProblemException(
          'charge-needs-second-approver',
          409,
          'A second person must approve this charge',
          'You recorded this charge — another member with billing.invoice must approve it.',
        );
      }
      await this.assertBillMonthOpenInTx(tx, charge);
      const now = nowIso();
      const updated = await this.transitionInTx(tx, charge, { status: 'approved', decidedBy: command.actorUserId, decidedAt: now, updatedAt: now });
      const result: ChargeMutationResult = { charge: toView(updated, null) };
      await this.event(tx, 'client_charge.approved', updated);
      await this.audit(tx, command, 'client_charge.approved', charge.id, idempotencyKey, { from: 'pending', to: 'approved' });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  /** Reject a pending charge with a note (`billing.invoice`). */
  async reject(command: ChargeNoteCommand, idempotencyKey: string): Promise<ChargeMutationResult> {
    const note = requiredNote(command.note, 'reject');
    const payloadHash = hashCommandPayload({ arm: 'charge-reject', tenantId: command.tenantId, chargeId: command.chargeId, note });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as ChargeMutationResult;
      const locked = await this.lockClientAndChargeInTx(tx, command.tenantId, command.chargeId, idempotencyKey, payloadHash);
      if ('replayed' in locked) return locked.replayed as ChargeMutationResult;
      const charge = locked.charge;
      if (charge.status !== 'pending') throw chargeNotPending(charge);
      await this.assertBillMonthOpenInTx(tx, charge);
      const now = nowIso();
      const updated = await this.transitionInTx(tx, charge, { status: 'rejected', decidedBy: command.actorUserId, decidedAt: now, decisionNote: note, updatedAt: now });
      const result: ChargeMutationResult = { charge: toView(updated, null) };
      await this.event(tx, 'client_charge.rejected', updated);
      await this.audit(tx, command, 'client_charge.rejected', charge.id, idempotencyKey, { from: 'pending', to: 'rejected', note });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  /**
   * Cancel a charge with a note (`billing.charge`): a pending one by its
   * recorder or a `billing.invoice` holder (no decision stamp), an approved
   * one by a `billing.invoice` holder — never once it is billed on an issued,
   * disputed or settled invoice, nor while its billing month is invoiced.
   */
  async cancel(command: ChargeNoteCommand, idempotencyKey: string): Promise<ChargeMutationResult> {
    const note = requiredNote(command.note, 'cancel');
    const payloadHash = hashCommandPayload({ arm: 'charge-cancel', tenantId: command.tenantId, chargeId: command.chargeId, note });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'billing.charge');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as ChargeMutationResult;
      const locked = await this.lockClientAndChargeInTx(tx, command.tenantId, command.chargeId, idempotencyKey, payloadHash);
      if ('replayed' in locked) return locked.replayed as ChargeMutationResult;
      const charge = locked.charge;
      if (charge.status !== 'pending' && charge.status !== 'approved') {
        throw new ProblemException(
          'charge-not-cancellable',
          409,
          'The charge cannot be cancelled',
          `This charge is ${charge.status} — only a pending or approved charge is cancelled.`,
        );
      }
      const holdsInvoice = ROLE_CAPABILITIES[role].has('billing.invoice');
      if (charge.status === 'pending' ? !holdsInvoice && charge.recordedBy !== command.actorUserId : !holdsInvoice) {
        throw new ProblemException(
          'permission-denied',
          403,
          'You cannot cancel this charge',
          charge.status === 'pending'
            ? 'Only the member who recorded this pending charge, or a member with billing.invoice, can cancel it.'
            : 'This charge is approved — only a member with billing.invoice can cancel it.',
        );
      }
      const billed = await tx
        .select({ invoiceNo: clientInvoices.invoiceNo })
        .from(clientInvoiceLines)
        .innerJoin(clientInvoices, and(eq(clientInvoices.tenantId, clientInvoiceLines.tenantId), eq(clientInvoices.id, clientInvoiceLines.invoiceId)))
        .where(
          and(
            eq(clientInvoiceLines.tenantId, command.tenantId),
            eq(clientInvoiceLines.adhocChargeId, charge.id),
            inArray(clientInvoices.status, [...INVOICED_STATUSES]),
          ),
        )
        .limit(1);
      if (billed.length > 0) throw chargePeriodInvoiced(charge);
      await this.assertBillMonthOpenInTx(tx, charge);
      const now = nowIso();
      const wasPending = charge.status === 'pending';
      const updated = await this.transitionInTx(tx, charge, { status: 'cancelled', cancelledBy: command.actorUserId, cancelledAt: now, cancelNote: note, updatedAt: now });
      const result: ChargeMutationResult = { charge: toView(updated, null) };
      if (wasPending) await this.event(tx, 'client_charge.cancelled', updated);
      await this.audit(tx, command, 'client_charge.cancelled', charge.id, idempotencyKey, { from: charge.status, to: 'cancelled', note });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  /** A22 — set the tenant's self-approval limit (`billing.invoice`). Every PUT is audited. */
  async putPolicy(command: { tenantId: string; actorUserId: string; selfApproveLimitPaise: unknown }, idempotencyKey: string): Promise<ChargePolicyView> {
    const limit = command.selfApproveLimitPaise;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0 || limit > MAX_SELF_APPROVE_LIMIT_PAISE) {
      throw validation(`selfApproveLimitPaise must be whole paise 0..${MAX_SELF_APPROVE_LIMIT_PAISE} (₹0 .. ₹1 crore) (got ${JSON.stringify(limit)}).`);
    }
    const payloadHash = hashCommandPayload({ arm: 'charge-policy', tenantId: command.tenantId, selfApproveLimitPaise: limit });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'billing.invoice');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as ChargePolicyView;
      // The row lock (insert ON CONFLICT DO NOTHING, then FOR UPDATE) serialises two PUTs.
      await tx
        .insert(clientChargePolicies)
        .values({ id: uuidv7(), tenantId: command.tenantId, selfApproveLimitPaise: DEFAULT_SELF_APPROVE_LIMIT_PAISE, updatedBy: command.actorUserId })
        .onConflictDoNothing({ target: [clientChargePolicies.tenantId] });
      const locked = await tx.select().from(clientChargePolicies).where(eq(clientChargePolicies.tenantId, command.tenantId)).limit(1).for('update');
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as ChargePolicyView;
      const row = locked[0]!;
      const from = Number(row.selfApproveLimitPaise);
      await tx
        .update(clientChargePolicies)
        .set({ selfApproveLimitPaise: limit, updatedBy: command.actorUserId, updatedAt: nowIso() })
        .where(eq(clientChargePolicies.id, row.id));
      const result: ChargePolicyView = { selfApproveLimitPaise: limit, isDefault: false };
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'client_charge_policy.updated',
        targetType: 'client_charge_policy',
        targetId: row.id,
        reference: idempotencyKey,
        changes: { from, to: limit },
        occurredAt: nowIso(),
      });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  // ── reads (member-open; a client-portal session is refused) ───────────────

  async getPolicy(tenantId: string, actorUserId: string): Promise<ChargePolicyView> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) throw portalRefused();
      const rows = await tx
        .select({ limit: clientChargePolicies.selfApproveLimitPaise })
        .from(clientChargePolicies)
        .where(eq(clientChargePolicies.tenantId, tenantId))
        .limit(1);
      return rows[0] === undefined ? { selfApproveLimitPaise: DEFAULT_SELF_APPROVE_LIMIT_PAISE, isDefault: true } : { selfApproveLimitPaise: Number(rows[0].limit), isDefault: false };
    });
  }

  async get(tenantId: string, actorUserId: string, chargeId: string): Promise<ClientChargeView> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) throw portalRefused();
      if (!UUID_RE.test(chargeId)) throw chargeNotFound(chargeId);
      const rows = await tx
        .select()
        .from(clientCharges)
        .where(and(eq(clientCharges.tenantId, tenantId), eq(clientCharges.id, chargeId)))
        .limit(1);
      if (rows[0] === undefined) throw chargeNotFound(chargeId);
      const billing = await this.billingOfInTx(tx, tenantId, [rows[0].id]);
      return toView(rows[0], billing.get(rows[0].id) ?? null);
    });
  }

  /** Newest first, keyset on `(created_at, id)`; `month` filters `bill_month`. */
  async list(tenantId: string, actorUserId: string, query: ListClientChargesQuery = {}): Promise<Page<ClientChargeView>> {
    for (const [name, value] of [
      ['clientId', query.clientId],
      ['warehouseId', query.warehouseId],
    ] as const) {
      if (value !== undefined && !UUID_RE.test(value)) throw validation(`${name} must be a uuid (got ${JSON.stringify(value)}).`);
    }
    if (query.status !== undefined && !(CLIENT_CHARGE_STATUSES as readonly string[]).includes(query.status)) {
      throw validation(`status must be one of ${JSON.stringify(CLIENT_CHARGE_STATUSES)} (got ${JSON.stringify(query.status)}).`);
    }
    if (query.month !== undefined && !MONTH_RE.test(query.month)) throw validation(`month must be a calendar month YYYY-MM (got ${JSON.stringify(query.month)}).`);
    const limit = query.limit ?? CLIENT_CHARGE_LIST_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLIENT_CHARGE_LIST_MAX_LIMIT) throw validation(`limit must be 1–${CLIENT_CHARGE_LIST_MAX_LIMIT}.`);
    const before = query.cursor === undefined ? null : decodeChargeCursor(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) throw portalRefused();
      const rows = await tx
        .select({ row: clientCharges, createdAtText: sql<string>`${clientCharges.createdAt}::text` })
        .from(clientCharges)
        .where(
          and(
            eq(clientCharges.tenantId, tenantId),
            query.clientId === undefined ? undefined : eq(clientCharges.clientId, query.clientId),
            query.warehouseId === undefined ? undefined : eq(clientCharges.warehouseId, query.warehouseId),
            query.status === undefined ? undefined : eq(clientCharges.status, query.status),
            query.month === undefined ? undefined : eq(clientCharges.billMonth, `${query.month}-01`),
            before === null ? undefined : sql`(${clientCharges.createdAt}, ${clientCharges.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(clientCharges.createdAt), desc(clientCharges.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const billing = await this.billingOfInTx(
        tx,
        tenantId,
        page.map((item) => item.row.id),
      );
      const last = page.at(-1);
      return {
        items: page.map((item) => toView(item.row, billing.get(item.row.id) ?? null)),
        nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: fullPrecisionInstant(last.createdAtText), id: last.row.id }) : null,
      };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Read the charge's client (404 `charge-not-found`), lock the CLIENT row,
   * replay under that lock, then lock the charge row — never the reverse.
   * A lock helper and nothing else: every state guard runs after it.
   */
  private async lockClientAndChargeInTx(
    tx: TenantTx,
    tenantId: string,
    chargeId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<{ charge: ClientCharge } | { replayed: unknown }> {
    if (!UUID_RE.test(chargeId)) throw chargeNotFound(chargeId);
    const found = await tx
      .select({ clientId: clientCharges.clientId })
      .from(clientCharges)
      .where(and(eq(clientCharges.tenantId, tenantId), eq(clientCharges.id, chargeId)))
      .limit(1);
    if (found[0] === undefined) throw chargeNotFound(chargeId);
    await lockClientInTx(tx, tenantId, found[0].clientId);
    const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
    if (replayed !== null) return { replayed };
    const rows = await tx
      .select()
      .from(clientCharges)
      .where(and(eq(clientCharges.tenantId, tenantId), eq(clientCharges.id, chargeId)))
      .orderBy(asc(clientCharges.id))
      .limit(1)
      .for('update');
    if (rows[0] === undefined) throw chargeNotFound(chargeId);
    return { charge: rows[0] };
  }

  /** The charge's `bill_month` under its GSTIN must have no issued, disputed or settled invoice. */
  private async assertBillMonthOpenInTx(tx: TenantTx, charge: ClientCharge): Promise<void> {
    const invoiced = await tx
      .select({ id: clientInvoices.id })
      .from(clientInvoices)
      .where(
        and(
          eq(clientInvoices.tenantId, charge.tenantId),
          eq(clientInvoices.clientId, charge.clientId),
          eq(clientInvoices.periodStart, charge.billMonth),
          inArray(clientInvoices.status, [...INVOICED_STATUSES]),
          sql`coalesce(${clientInvoices.supplierGstin}, '') = ${charge.supplierGstin ?? ''}`,
        ),
      )
      .limit(1);
    if (invoiced.length > 0) throw chargePeriodInvoiced(charge);
  }

  /** A4 — the earliest month ≥ `from` whose (client, month, GSTIN) has no issued, disputed or settled invoice. */
  private async openBillMonthInTx(tx: TenantTx, tenantId: string, clientId: string, supplierGstin: string | null, from: string): Promise<string> {
    const rows = await tx
      .select({ periodStart: clientInvoices.periodStart })
      .from(clientInvoices)
      .where(
        and(
          eq(clientInvoices.tenantId, tenantId),
          eq(clientInvoices.clientId, clientId),
          inArray(clientInvoices.status, [...INVOICED_STATUSES]),
          sql`coalesce(${clientInvoices.supplierGstin}, '') = ${supplierGstin ?? ''}`,
          sql`${clientInvoices.periodStart} >= ${from}::date`,
        ),
      );
    const invoiced = new Set(rows.map((row) => row.periodStart));
    let month = from;
    // The current month is never invoiced (prepare refuses a month that has
    // not ended), so this ends at the latest by today's month.
    while (invoiced.has(month)) month = nextMonth(month);
    return month;
  }

  private async selfApproveLimitInTx(tx: TenantTx, tenantId: string): Promise<number> {
    const rows = await tx
      .select({ limit: clientChargePolicies.selfApproveLimitPaise })
      .from(clientChargePolicies)
      .where(eq(clientChargePolicies.tenantId, tenantId))
      .limit(1);
    return rows[0] === undefined ? DEFAULT_SELF_APPROVE_LIMIT_PAISE : Number(rows[0].limit);
  }

  /** A31 — per charge, the latest NON-VOID invoice with a line billing it. */
  private async billingOfInTx(tx: TenantTx, tenantId: string, chargeIds: readonly string[]): Promise<Map<string, ClientChargeBillingView>> {
    const out = new Map<string, ClientChargeBillingView>();
    if (chargeIds.length === 0) return out;
    const rows = await tx
      .select({ chargeId: clientInvoiceLines.adhocChargeId, invoiceId: clientInvoices.id, invoiceNo: clientInvoices.invoiceNo, status: clientInvoices.status })
      .from(clientInvoiceLines)
      .innerJoin(clientInvoices, and(eq(clientInvoices.tenantId, clientInvoiceLines.tenantId), eq(clientInvoices.id, clientInvoiceLines.invoiceId)))
      .where(and(eq(clientInvoiceLines.tenantId, tenantId), inArray(clientInvoiceLines.adhocChargeId, [...chargeIds]), ne(clientInvoices.status, 'void')))
      .orderBy(desc(clientInvoices.createdAt), desc(clientInvoices.id));
    for (const row of rows) {
      if (row.chargeId !== null && !out.has(row.chargeId)) out.set(row.chargeId, { invoiceId: row.invoiceId, invoiceNo: row.invoiceNo, status: row.status });
    }
    return out;
  }

  private async transitionInTx(tx: TenantTx, charge: ClientCharge, set: Partial<typeof clientCharges.$inferInsert>): Promise<ClientCharge> {
    const rows = await tx
      .update(clientCharges)
      .set(set)
      .where(and(eq(clientCharges.tenantId, charge.tenantId), eq(clientCharges.id, charge.id), eq(clientCharges.status, charge.status)))
      .returning();
    if (rows[0] === undefined) throw new Error(`client charge ${charge.id} was not ${charge.status} under its lock`);
    return rows[0];
  }

  /** A28 — the outbox event at step 9 (no consumer yet). */
  private async event(tx: TenantTx, type: ClientChargeEventType, charge: ClientCharge): Promise<void> {
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId: charge.tenantId,
      type,
      occurredAt: nowIso(),
      payload: { chargeId: charge.id, clientId: charge.clientId, warehouseId: charge.warehouseId, amountPaise: Number(charge.amountPaise) },
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
    action: ChargeAuditAction,
    chargeId: string,
    reference: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      action,
      targetType: 'client_charge',
      targetId: chargeId,
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

function chargeNotPending(charge: ClientCharge): ProblemException {
  return new ProblemException(
    'charge-not-pending',
    409,
    'The charge is not pending',
    `This charge is ${charge.status} — only a pending charge is approved or rejected.`,
  );
}
