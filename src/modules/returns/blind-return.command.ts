import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  idempotencyKeys,
  returnAuthorizationLines,
  returnAuthorizations,
  returnReceiptLines,
  returnReceipts,
} from '../../shared/db/schema';
import type { ReturnAuthorizationRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { MAX_QUANTITY_BASE, QUANTITY_SCALE, fromMilli, signedQuantity, validateRecordableQuantity } from '../../shared/primitives/quantity';
import { assertUtcIso, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { ensureReturnsBinInTx } from '../tenancy/receiving-bin';
import { recordServerRejectedOpInTx } from '../tenancy/server-rejected-op';
import { CatalogFacade } from '../catalog/catalog.facade';
import type { SkuFacts } from '../catalog/catalog.facade';
import { MAX_HANDLING_UNIT_WEIGHT_GRAMS } from '../catalog/handling-unit';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { LedgerMovement } from '../inventory/inventory.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import {
  BLIND_REJECT_REASONS,
  allocateRmaCodeInTx,
  canonicalUuid,
  orderNotFound,
  returnableFactsInTx,
  rmaDetailInTx,
  rmaNotFound,
  rmaOrderLockKey,
  rmaOrderReference,
} from './return-authorization.command';
import type { BlindMatchKind, BlindRejectReason, RmaDetail } from './return-authorization.command';
import {
  MAX_RETURN_NOTE,
  MAX_RETURN_RECEIPT_ENTRIES,
  RETURN_CONDITIONS,
  refusedEntriesOpId,
  rrnSequenceLockKey,
  rrnCode,
} from './return-receipt.command';
import type { ReturnCondition } from './return-receipt.command';
import { assertLinesConservedInTx } from './disposition-split';
import { RETURN_BLIND_ACCEPTED_EVENT, RETURN_BLIND_RECORDED_EVENT, RETURN_BLIND_REJECTED_EVENT } from './events';
import type { ReturnBlindRecordedPayload, ReturnBlindReviewedPayload } from './events';

// ── vocabularies ─────────────────────────────────────────────────────────────

/**
 * Story 4-7b (decision 5, D11) — why an entry of an unannounced parcel was
 * NOT booked. The classification runs in request order and the FIRST failing
 * rule names the refusal, in exactly this order:
 * - `not-in-catalog` — the SKU id is unknown in this tenant;
 * - `sku-not-of-client` — the SKU belongs to another client than the body's
 *   `clientId` (one parcel holds one client's goods);
 * - `kit-cannot-hold-stock` — a kit SKU (its stock is its components');
 * - `qty-precision` — a fraction finer than the SKU's unit, or a catch-weight
 *   entry that is not a whole case;
 * - `missing-capture` / `unexpected-capture` / `weight-out-of-range` — 13-2's
 *   capture rules (serial, then batch, then the case's weight);
 * - `serial-unknown` — the number is not a serial of the SKU (serials are
 *   reused, never created);
 * - `serial-blocked` — the serial's identity is `blocked` (2-6a);
 * - `serial-in-stock` — the serial is on hand in a bin (IN-TRANSIT counts)
 *   right now, so it cannot be the returned unit;
 * - `serial-duplicate` — the same serial already applied earlier in the op;
 * - `batch-unknown` — the code is not a batch of the SKU (batches are reused,
 *   never created), or (A7) for a batch-and-serial SKU not the batch of the
 *   serial's latest ledger event.
 * 13-2's `RETURN_ENTRY_REFUSALS` is unchanged.
 */
export const BLIND_ENTRY_REFUSALS = [
  'not-in-catalog',
  'sku-not-of-client',
  'kit-cannot-hold-stock',
  'qty-precision',
  'missing-capture',
  'unexpected-capture',
  'weight-out-of-range',
  'serial-unknown',
  'serial-blocked',
  'serial-in-stock',
  'serial-duplicate',
  'batch-unknown',
] as const;
export type BlindEntryRefusal = (typeof BLIND_ENTRY_REFUSALS)[number];

/** Story 4-7b (decision 3) — the parcel reference (an AWB or order number), in code points. */
export const MAX_PARCEL_REFERENCE = 64;
/** Story 4-7b (decision 8) — the reject note, in code points (0112's CHECK). */
export const MAX_BLIND_REVIEW_NOTE = 200;
const MAX_BATCH_CODE = 64;
const MAX_SERIAL_NUMBER = 200;

const RMA_TENANT_CODE = 'return_authorizations_tenant_code_unique';
const RRN_TENANT_CODE = 'return_receipts_tenant_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * Story 4-7b (A3) — the blind receipt's same-key advisory lock text: taken
 * right after the device operator check, then the replay runs — so a parked
 * same-key duplicate replays the winner's snapshot even when nothing applied
 * (and no `:rma-seq` lock was taken). Exported for the race test.
 */
export function blindKeyLockKey(tenantId: string, idempotencyKey: string): string {
  return `${tenantId}:blind-key:${idempotencyKey}`;
}

// ── inputs and snapshots ─────────────────────────────────────────────────────

/** One scanned unit (or case, or run of untracked units) of an unannounced parcel — base units. */
export interface BlindEntryInput {
  readonly skuId: string;
  readonly qty: number;
  readonly condition: string;
  readonly note?: string | null | undefined;
  readonly batchCode?: string | null | undefined;
  readonly serialNumber?: string | null | undefined;
  readonly weightGrams?: number | null | undefined;
}

export interface ReceiveBlindCommand {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly operatorUserId: string;
  readonly warehouseId: string;
  /** The parcel's client — fixed on the device by the first unit's SKU (decision 3). */
  readonly clientId: string;
  /** A24 — the operator chose the client at an ambiguous barcode. */
  readonly clientPrompted: boolean;
  readonly parcelReference?: string | null | undefined;
  readonly occurredAt: string;
  readonly entries: readonly BlindEntryInput[];
}

export interface BlindEntryApplied {
  readonly entryIndex: number;
  /** Base units. */
  readonly qty: number;
}

export interface BlindEntryRefused {
  readonly entryIndex: number;
  readonly reason: BlindEntryRefusal;
}

/** The `return.receive_blind` 201 — and its idempotency snapshot. */
export interface BlindReceiptResult {
  /** Null when every entry was refused (no RMA, no receipt). */
  readonly rmaId: string | null;
  readonly rmaCode: string | null;
  readonly returnReceiptId: string | null;
  readonly code: string | null;
  readonly suggestedOrderId: string | null;
  readonly matchKind: BlindMatchKind | null;
  readonly applied: readonly BlindEntryApplied[];
  readonly refused: readonly BlindEntryRefused[];
  readonly reviewOpId: string | null;
}

export interface AcceptBlindCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly rmaId: string;
  /** The dispatched order to link — null is the reviewer's explicit "No order". */
  readonly orderId: string | null;
}

export interface RejectBlindCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly rmaId: string;
  readonly reasonCode: string;
  readonly note?: string | null | undefined;
}

/** The accept's 200 — the RMA's detail plus the lines no order line could take. */
export interface BlindAcceptResult extends RmaDetail {
  readonly unlinkedLines: readonly string[];
}

// ── refusals (whole op) ──────────────────────────────────────────────────────

function blindValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid unannounced return', detail);
}

function rmaNotBlind(code: string, origin: string): ProblemException {
  return new ProblemException(
    'rma-not-blind',
    409,
    'Not an unannounced return',
    `Return authorization "${code}" was authorized, not received unannounced — only an unannounced return is reviewed.`,
    { origin },
  );
}

function reviewNotPending(code: string, reviewStatus: string): ProblemException {
  return new ProblemException(
    'review-not-pending',
    409,
    'The review is already decided',
    `Unannounced return "${code}" is already ${reviewStatus} — a review is decided once.`,
    { reviewStatus },
  );
}

// ── shape (above the transaction) ────────────────────────────────────────────

function codePoints(value: string): number {
  return [...value].length;
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isUuidText(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface NormalizedBlindEntry {
  readonly skuId: string;
  readonly qty: number;
  readonly condition: ReturnCondition;
  readonly note: string | null;
  readonly batchCode: string | null;
  readonly serialNumber: string | null;
  readonly weightGrams: number | null;
}

export interface NormalizedBlind {
  readonly warehouseId: string;
  readonly clientId: string;
  readonly clientPrompted: boolean;
  readonly parcelReference: string | null;
  readonly occurredAt: string;
  readonly entries: readonly NormalizedBlindEntry[];
}

/**
 * The request-shape rules (guide §1, tier 1) — 13-2's `normalizeReceive`
 * without the RMA line, plus the client, the prompt flag and the parcel
 * reference (trimmed, blank = absent, ≤ 64). Optional keys normalise here,
 * so a stored payload re-read raw means exactly what an explicit null means.
 */
export function normalizeBlindReceive(command: Omit<ReceiveBlindCommand, 'tenantId' | 'deviceId' | 'operatorUserId'>): NormalizedBlind {
  if (!isUuidText(command.warehouseId)) throw blindValidation('warehouseId must be a uuid.');
  if (!isUuidText(command.clientId)) throw blindValidation('clientId must be a uuid.');
  const clientPrompted = (command.clientPrompted as unknown) ?? false;
  if (typeof clientPrompted !== 'boolean') throw blindValidation('clientPrompted must be a boolean.');
  if (command.parcelReference !== undefined && command.parcelReference !== null && typeof command.parcelReference !== 'string') {
    throw blindValidation('parcelReference must be a string or null.');
  }
  const parcelReference = trimmedOrNull(command.parcelReference);
  if (parcelReference !== null && codePoints(parcelReference) > MAX_PARCEL_REFERENCE) {
    throw blindValidation(`parcelReference must be at most ${MAX_PARCEL_REFERENCE} characters (got ${codePoints(parcelReference)}).`);
  }
  let occurredAt: string;
  try {
    occurredAt = assertUtcIso(command.occurredAt);
  } catch {
    throw blindValidation(`occurredAt must be a Z-suffixed ISO-8601 UTC instant (got "${String(command.occurredAt).slice(0, 64)}").`);
  }
  const entries = command.entries;
  if (!Array.isArray(entries) || entries.length === 0) throw blindValidation('An unannounced parcel needs at least one entry.');
  if (entries.length > MAX_RETURN_RECEIPT_ENTRIES) {
    throw blindValidation(
      `An unannounced parcel carries at most ${MAX_RETURN_RECEIPT_ENTRIES} entries (got ${entries.length}) — receive the rest as another parcel.`,
    );
  }
  const normalized = entries.map((entry, index): NormalizedBlindEntry => {
    const at = `entries[${index}]`;
    if (!isUuidText(entry.skuId)) throw blindValidation(`${at}: skuId must be a uuid.`);
    if (typeof entry.qty !== 'number' || !Number.isFinite(entry.qty) || entry.qty <= 0 || entry.qty > MAX_QUANTITY_BASE) {
      throw blindValidation(`${at}: qty must be a number greater than 0 (got ${String(entry.qty)}).`);
    }
    if (!(RETURN_CONDITIONS as readonly string[]).includes(entry.condition)) {
      throw blindValidation(`${at}: condition must be one of ${JSON.stringify(RETURN_CONDITIONS)} (got "${String(entry.condition)}").`);
    }
    for (const key of ['note', 'batchCode', 'serialNumber'] as const) {
      const value = entry[key];
      if (value !== undefined && value !== null && typeof value !== 'string') throw blindValidation(`${at}: ${key} must be a string or null.`);
    }
    const note = trimmedOrNull(entry.note);
    if (note !== null && codePoints(note) > MAX_RETURN_NOTE) {
      throw blindValidation(`${at}: note must be at most ${MAX_RETURN_NOTE} characters (got ${codePoints(note)}).`);
    }
    const batchCode = trimmedOrNull(entry.batchCode);
    if (batchCode !== null && codePoints(batchCode) > MAX_BATCH_CODE) throw blindValidation(`${at}: batchCode must be at most ${MAX_BATCH_CODE} characters.`);
    const serialNumber = trimmedOrNull(entry.serialNumber);
    if (serialNumber !== null && codePoints(serialNumber) > MAX_SERIAL_NUMBER) {
      throw blindValidation(`${at}: serialNumber must be at most ${MAX_SERIAL_NUMBER} characters.`);
    }
    const weightGrams = entry.weightGrams ?? null;
    if (weightGrams !== null && (typeof weightGrams !== 'number' || !Number.isInteger(weightGrams) || weightGrams <= 0)) {
      throw blindValidation(`${at}: weightGrams must be a positive whole number of grams or null (got ${String(weightGrams)}).`);
    }
    if (serialNumber !== null && entry.qty !== 1) throw blindValidation(`${at}: a serial entry is one unit — qty must be 1 (got ${entry.qty}).`);
    if (weightGrams !== null && entry.qty !== 1) {
      throw blindValidation(`${at}: a catch-weight entry is one case with its weight — qty must be 1 (got ${entry.qty}).`);
    }
    if (serialNumber !== null && weightGrams !== null) throw blindValidation(`${at}: an entry carries a serial number or a case weight, never both.`);
    return {
      skuId: canonicalUuid(entry.skuId),
      qty: entry.qty,
      condition: entry.condition as ReturnCondition,
      note,
      batchCode,
      serialNumber,
      weightGrams,
    };
  });
  return {
    warehouseId: canonicalUuid(command.warehouseId),
    clientId: canonicalUuid(command.clientId),
    clientPrompted,
    parcelReference,
    occurredAt,
    entries: normalized,
  };
}

/**
 * The blind receipt's fingerprint: `arm` first, then the whole normalized
 * body in a fixed key order — entries in request order, every key always
 * present. Pinned by a golden in `test/blind-returns.spec.ts`.
 */
export function blindReceivePayloadHash(tenantId: string, deviceId: string, operatorUserId: string, normalized: NormalizedBlind): string {
  return hashCommandPayload({
    arm: 'return-receive-blind',
    tenantId,
    deviceId,
    operatorUserId,
    warehouseId: normalized.warehouseId,
    clientId: normalized.clientId,
    clientPrompted: normalized.clientPrompted,
    parcelReference: normalized.parcelReference,
    occurredAt: normalized.occurredAt,
    entries: normalized.entries.map((entry) => ({
      skuId: entry.skuId,
      qty: Number(entry.qty),
      condition: entry.condition,
      note: entry.note,
      batchCode: entry.batchCode,
      serialNumber: entry.serialNumber,
      weightGrams: entry.weightGrams,
    })),
  });
}

export function blindAcceptPayloadHash(tenantId: string, rmaId: string, orderId: string | null): string {
  return hashCommandPayload({ arm: 'blind-accept', tenantId, rmaId, orderId });
}

export interface NormalizedReject {
  readonly reasonCode: BlindRejectReason;
  readonly note: string | null;
}

/** The reject's shape (400): a known reason; `other` needs a note; the note trimmed, ≤ 200. */
export function normalizeBlindReject(command: Pick<RejectBlindCommand, 'reasonCode' | 'note'>): NormalizedReject {
  if (!(BLIND_REJECT_REASONS as readonly string[]).includes(command.reasonCode)) {
    throw blindValidation(`reasonCode must be one of ${JSON.stringify(BLIND_REJECT_REASONS)} (got "${String(command.reasonCode)}").`);
  }
  if (command.note !== undefined && command.note !== null && typeof command.note !== 'string') throw blindValidation('note must be a string or null.');
  const note = trimmedOrNull(command.note);
  if (note !== null && codePoints(note) > MAX_BLIND_REVIEW_NOTE) {
    throw blindValidation(`note must be at most ${MAX_BLIND_REVIEW_NOTE} characters (got ${codePoints(note)}).`);
  }
  if (command.reasonCode === 'other' && note === null) throw blindValidation('reasonCode "other" requires a note saying why.');
  return { reasonCode: command.reasonCode as BlindRejectReason, note };
}

export function blindRejectPayloadHash(tenantId: string, rmaId: string, normalized: NormalizedReject): string {
  return hashCommandPayload({ arm: 'blind-reject', tenantId, rmaId, reasonCode: normalized.reasonCode, note: normalized.note });
}

// ── classification (pure) ────────────────────────────────────────────────────

/** What the classification reads — gathered under the SKU share locks and the serial locks. */
export interface BlindClassifyContext {
  readonly clientId: string;
  readonly skuFacts: ReadonlyMap<string, SkuFacts>;
  /** `${skuId}:${serialNumber}` → the serial's id and identity status. */
  readonly serialByNumber: ReadonlyMap<string, { readonly id: string; readonly status: string }>;
  /** Serials on hand in some bin → that bin. */
  readonly inStock: ReadonlyMap<string, string>;
  /** Serial id → the batch its latest ledger event carried (A7). */
  readonly latestBatchBySerial: ReadonlyMap<string, string | null>;
  /** `${skuId}:${batchCode}` → batch id (existing batches only). */
  readonly batchIdByCode: ReadonlyMap<string, string>;
  /** Serials already applied earlier in this op (decremented as entries apply). */
  readonly appliedSerials: ReadonlySet<string>;
}

/** One entry that passed every rule, ready to book (milli-units). */
export interface BlindApplicable {
  readonly entryIndex: number;
  readonly entry: NormalizedBlindEntry;
  readonly sku: SkuFacts;
  readonly milli: number;
  readonly batchId: string | null;
  readonly serialId: string | null;
}

/** One entry's verdict — decision 5's order; the first failing rule names the refusal. */
export function classifyBlindEntry(
  entryIndex: number,
  entry: NormalizedBlindEntry,
  ctx: BlindClassifyContext,
): BlindApplicable | { readonly reason: BlindEntryRefusal } {
  const sku = ctx.skuFacts.get(entry.skuId);
  if (sku === undefined) return { reason: 'not-in-catalog' };
  if (sku.clientId !== ctx.clientId) return { reason: 'sku-not-of-client' };
  if (sku.isKit) return { reason: 'kit-cannot-hold-stock' };
  const checked = validateRecordableQuantity(entry.qty, `entries[${entryIndex}].qty`, sku.uom, sku.uomPrecision, 'non-negative');
  if (!checked.ok) return { reason: 'qty-precision' };
  const milli = checked.milli;
  if (sku.catchWeightTracked && milli % QUANTITY_SCALE !== 0) return { reason: 'qty-precision' };
  // The captures (13-2's rules): serial, then batch, then the case weight.
  if (sku.serialTracked && entry.serialNumber === null) return { reason: 'missing-capture' };
  if (!sku.serialTracked && entry.serialNumber !== null) return { reason: 'unexpected-capture' };
  if (sku.batchTracked && entry.batchCode === null) return { reason: 'missing-capture' };
  if (!sku.batchTracked && entry.batchCode !== null) return { reason: 'unexpected-capture' };
  if (sku.catchWeightTracked && entry.weightGrams === null) return { reason: 'missing-capture' };
  if (!sku.catchWeightTracked && entry.weightGrams !== null) return { reason: 'unexpected-capture' };
  if (entry.weightGrams !== null && entry.weightGrams > MAX_HANDLING_UNIT_WEIGHT_GRAMS) return { reason: 'weight-out-of-range' };
  let serialId: string | null = null;
  if (sku.serialTracked) {
    const serial = ctx.serialByNumber.get(`${entry.skuId}:${entry.serialNumber}`);
    if (serial === undefined) return { reason: 'serial-unknown' };
    if (serial.status !== 'active') return { reason: 'serial-blocked' };
    if (ctx.inStock.has(serial.id)) return { reason: 'serial-in-stock' };
    if (ctx.appliedSerials.has(serial.id)) return { reason: 'serial-duplicate' };
    serialId = serial.id;
  }
  let batchId: string | null = null;
  if (sku.batchTracked) {
    const resolved = ctx.batchIdByCode.get(`${entry.skuId}:${entry.batchCode}`);
    if (resolved === undefined) return { reason: 'batch-unknown' };
    // A7 — a batch-and-serial unit comes back on the batch its serial last carried.
    if (serialId !== null && ctx.latestBatchBySerial.get(serialId) !== resolved) return { reason: 'batch-unknown' };
    batchId = resolved;
  }
  return { entryIndex, entry, sku, milli, batchId, serialId };
}

// ── accept: the linking plan (pure) ──────────────────────────────────────────

/** One blind RMA line as the accept allocates it (milli-units). */
export interface BlindLineForLink {
  readonly id: string;
  readonly lineNo: number;
  readonly skuId: string;
  readonly milli: number;
  readonly serialIds: readonly string[];
}

/** One order line as the accept sees it (milli-units; the facts' order is order-line order). */
export interface OrderLineForLink {
  readonly orderLineId: string;
  readonly skuId: string;
  readonly kitParent: boolean;
  readonly returnableMilli: number;
  /** The line's dispatched serials not on a committed authorization. */
  readonly returnableSerialIds: ReadonlySet<string>;
}

export interface LinkPlan {
  /** RMA line id → the order line it takes. */
  readonly links: ReadonlyMap<string, string>;
  /** RMA line id → the earlier RMA line it merges into (its only fitting order line was taken). */
  readonly merges: ReadonlyMap<string, string>;
  readonly unlinked: readonly string[];
}

/**
 * A11 — the accept's allocation, in `line_no` order: each blind line takes
 * the first non-kit-parent order line of its SKU (order-line order) whose
 * REMAINING returnable quantity (decremented as lines link) covers it whole
 * and — for a serial line — whose returnable serials hold every received
 * serial (the order line that dispatched them). Two blind lines never take
 * one order line (the `(rma_id, order_line_id)` unique): a line whose only
 * fitting order lines are already taken by earlier lines of this RMA MERGES
 * into the earlier line holding the first of them. A line that fits nowhere
 * stays unlinked.
 */
export function planBlindLinks(lines: readonly BlindLineForLink[], orderLines: readonly OrderLineForLink[]): LinkPlan {
  const remaining = new Map(orderLines.map((line) => [line.orderLineId, line.returnableMilli]));
  const takenBy = new Map<string, string>();
  const serialsTaken = new Set<string>();
  const links = new Map<string, string>();
  const merges = new Map<string, string>();
  const unlinked: string[] = [];
  for (const line of [...lines].sort((a, b) => a.lineNo - b.lineNo)) {
    const fitting = orderLines.filter(
      (orderLine) =>
        orderLine.skuId === line.skuId &&
        !orderLine.kitParent &&
        remaining.get(orderLine.orderLineId)! >= line.milli &&
        line.serialIds.every((id) => orderLine.returnableSerialIds.has(id) && !serialsTaken.has(id)),
    );
    if (fitting.length === 0) {
      unlinked.push(line.id);
      continue;
    }
    const free = fitting.find((orderLine) => !takenBy.has(orderLine.orderLineId));
    const chosen = free ?? fitting[0]!;
    remaining.set(chosen.orderLineId, remaining.get(chosen.orderLineId)! - line.milli);
    for (const id of line.serialIds) serialsTaken.add(id);
    if (free !== undefined) {
      takenBy.set(chosen.orderLineId, line.id);
      links.set(line.id, chosen.orderLineId);
    } else {
      merges.set(line.id, takenBy.get(chosen.orderLineId)!);
    }
  }
  return { links, merges, unlinked };
}

// ── the command ──────────────────────────────────────────────────────────────

/**
 * Story 4-7b — blind returns: an unannounced parcel (an RTO, a customer
 * self-return, a missing slip) received on the handheld with no RMA, then
 * reviewed on the web.
 *
 * - `receive` — `return.receive_blind`, the device op: each entry that passes
 *   the classification books one `return.received` into RETURNS under an
 *   auto-created BLIND RMA (`origin = 'blind'`, born `received`, review
 *   `pending`) with one RMA line and one receipt line per entry, `open_qty`
 *   0 — so 4-7a can disposition nothing until it is accepted. The refused
 *   entries land in ONE Discard-only review row. The parcel reference
 *   suggests a dispatched order (AWB, then the order reference).
 * - `accept` — `returns.manage`: optionally links a dispatched order (each
 *   line to an order line it fits, A11 — never refusing on a line), and
 *   opens the units to disposition (`open_qty = qty`).
 * - `reject` — `returns.manage`: reverses the booking (`return.reversed` per
 *   receipt line, RETURNS → out), under the write-off threshold.
 *
 * Lock order: the receipt takes the device row, its key lock, the SKU rows
 * (share), the serial advisory locks, `:rma-seq`, then `:rrn-seq` (13-2's
 * receipt takes the RMA row then `:rrn-seq`; create takes the order lock
 * then `:rma-seq` — no path takes `:rrn-seq` before `:rma-seq`). Accept takes
 * the order lock (the body names it, so it is never taken after the row),
 * then the RMA row, then its receipt lines; reject takes the RMA row, the
 * receipt lines, the handling units, the serial locks, then the warehouse
 * advisory inside the appends.
 */
@Injectable()
export class BlindReturnCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
  ) {}

  // ── the device receipt ─────────────────────────────────────────────────────

  async receive(input: ReceiveBlindCommand, idempotencyKey: string): Promise<BlindReceiptResult> {
    // 1. Shape — above the transaction (400, never a replay).
    const normalized = normalizeBlindReceive(input);
    // 2. The fingerprint.
    const payloadHash = blindReceivePayloadHash(input.tenantId, input.deviceId, input.operatorUserId, normalized);
    const tenantId = input.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // 3. The device and role guard (tenancy's), before the replay.
      await assertDeviceOperatorInTx(tx, tenantId, input.deviceId, input.operatorUserId);
      // A3 — the same-key lock, then the replay under it.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${blindKeyLockKey(tenantId, idempotencyKey)}, 0))`);
      // 4. Replay.
      const replayed = await this.replay<BlindReceiptResult>(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      // 5. The warehouse (404).
      await assertWarehouseInTenant(tx, tenantId, normalized.warehouseId);

      // 6. The SKUs, FOR SHARE (a tracking-flag flip cannot interleave).
      const skuIds = [...new Set(normalized.entries.map((entry) => entry.skuId))];
      const skuFacts = await this.catalog.skuFactsInTx(tx, tenantId, skuIds, { lock: 'share' });

      // The serials named on serial-tracked SKUs of the parcel's client.
      const numbersBySku = new Map<string, Set<string>>();
      for (const entry of normalized.entries) {
        const sku = skuFacts.get(entry.skuId);
        if (sku === undefined || !sku.serialTracked || sku.clientId !== normalized.clientId || entry.serialNumber === null) continue;
        const set = numbersBySku.get(entry.skuId) ?? new Set<string>();
        set.add(entry.serialNumber);
        numbersBySku.set(entry.skuId, set);
      }
      const serialByNumber = new Map<string, { id: string; status: string }>();
      for (const [skuId, numbers] of numbersBySku) {
        for (const serial of await this.catalog.serialIdentitiesInTx(tx, tenantId, skuId, { numbers: [...numbers] })) {
          serialByNumber.set(`${skuId}:${serial.serialNumber}`, { id: serial.id, status: serial.status });
        }
      }
      // 8. Serial locks (sorted inside the facade), then the in-stock read
      //    and each serial's latest batch (A7) — under the locks.
      const serialIds = [...new Set([...serialByNumber.values()].map((serial) => serial.id))];
      await this.inventory.lockSerialsInTx(tx, tenantId, serialIds);
      const inStock = await this.inventory.serialsInStockInTx(tx, tenantId, serialIds);
      const latest = await this.inventory.serialLatestEventsInTx(tx, tenantId, serialIds);
      const latestBatchBySerial = new Map([...latest].map(([id, event]) => [id, event.batchRef]));
      // The batches named on batch-tracked SKUs (reused, never created).
      const batchPairs = normalized.entries.flatMap((entry) =>
        entry.batchCode !== null && skuFacts.get(entry.skuId)?.batchTracked === true ? [{ skuId: entry.skuId, code: entry.batchCode }] : [],
      );
      const batchIdByCode = new Map(
        [...(await this.catalog.batchesByCodesInTx(tx, tenantId, batchPairs))].map(([key, batch]) => [key, batch.id]),
      );

      // 7. Classify, in request order.
      const appliedSerials = new Set<string>();
      const applicable: BlindApplicable[] = [];
      const refused: BlindEntryRefused[] = [];
      for (const [entryIndex, entry] of normalized.entries.entries()) {
        const verdict = classifyBlindEntry(entryIndex, entry, {
          clientId: normalized.clientId,
          skuFacts,
          serialByNumber,
          inStock,
          latestBatchBySerial,
          batchIdByCode,
          appliedSerials,
        });
        if ('reason' in verdict) {
          refused.push({ entryIndex, reason: verdict.reason });
          continue;
        }
        if (verdict.serialId !== null) appliedSerials.add(verdict.serialId);
        applicable.push(verdict);
      }

      let rmaId: string | null = null;
      let rmaCodeValue: string | null = null;
      let returnReceiptId: string | null = null;
      let code: string | null = null;
      let suggestedOrderId: string | null = null;
      let matchKind: BlindMatchKind | null = null;
      if (applicable.length > 0) {
        // Decision 6 — the order suggestion: exactly one dispatched order.
        if (normalized.parcelReference !== null) {
          const matches = await this.outbound.ordersByParcelReferenceInTx(
            tx,
            tenantId,
            normalized.clientId,
            normalized.warehouseId,
            normalized.parcelReference,
          );
          if (matches.length === 1) {
            suggestedOrderId = matches[0]!.orderId;
            matchKind = matches[0]!.matchKind;
          }
        }
        // 9. The RETURNS bin — only when something applies.
        const returnsBin = await ensureReturnsBinInTx(tx, tenantId, normalized.warehouseId);
        // 10. The RMA code (`:rma-seq`), then the RRN code (`:rrn-seq`).
        rmaCodeValue = await allocateRmaCodeInTx(tx, tenantId);
        code = await this.allocateRrnCode(tx, tenantId);
        // 11. Writes.
        rmaId = uuidv7();
        returnReceiptId = uuidv7();
        try {
          await tx.insert(returnAuthorizations).values({
            id: rmaId,
            tenantId,
            clientId: normalized.clientId,
            warehouseId: normalized.warehouseId,
            orderId: null,
            orderReference: null,
            code: rmaCodeValue,
            externalReference: null,
            // Decision 1 — what arrived is what is authorized.
            status: 'received',
            orderDispatchedAt: null,
            createdBy: input.operatorUserId,
            origin: 'blind',
            reviewStatus: 'pending',
            parcelReference: normalized.parcelReference,
            suggestedOrderId,
            matchKind,
            clientPrompted: normalized.clientPrompted,
          });
        } catch (err) {
          if (isUniqueViolationOn(err, RMA_TENANT_CODE)) {
            throw new ProblemException('conflict', 409, 'Concurrent return authorization', 'Retry to read the settled result.');
          }
          throw err;
        }
        // A11 — one RMA line per applied entry, `line_no` in request order.
        const rmaLineIds = applicable.map(() => uuidv7());
        await tx.insert(returnAuthorizationLines).values(
          applicable.map((item, i) => ({
            id: rmaLineIds[i]!,
            tenantId,
            rmaId: rmaId!,
            lineNo: i + 1,
            orderLineId: null,
            skuId: item.entry.skuId,
            authorizedQty: item.milli,
            receivedQty: item.milli,
            reasonCode: 'unannounced',
            reasonNote: null,
            serialIds: item.serialId === null ? [] : [item.serialId],
          })),
        );
        try {
          await tx.insert(returnReceipts).values({
            id: returnReceiptId,
            tenantId,
            clientId: normalized.clientId,
            warehouseId: normalized.warehouseId,
            rmaId,
            code,
            deviceId: input.deviceId,
            receivedBy: input.operatorUserId,
            idempotencyKey,
            occurredAt: normalized.occurredAt,
          });
        } catch (err) {
          if (isUniqueViolationOn(err, RRN_TENANT_CODE)) {
            throw new ProblemException('conflict', 409, 'Concurrent return receipt', 'Retry to read the settled result.');
          }
          throw err;
        }
        const receiptLineIds = applicable.map(() => uuidv7());
        const caseEntries = applicable
          .map((item, i) => ({ item, lineId: receiptLineIds[i]! }))
          .filter(({ item }) => item.entry.weightGrams !== null && item.sku.catchWeightTracked);
        const createdUnits = await this.catalog.createHandlingUnits(
          tx,
          tenantId,
          caseEntries.map(({ item, lineId }) => ({
            warehouseId: normalized.warehouseId,
            skuId: item.entry.skuId,
            batchId: item.batchId,
            returnReceiptLineId: lineId,
            weightGrams: item.entry.weightGrams!,
            status: 'returned' as const,
          })),
        );
        const unitByReceiptLine = new Map(createdUnits.map((unit) => [unit.returnReceiptLineId!, unit.id]));
        const recordedAt = nowIso();
        const ledgerEventIds: string[] = [];
        for (const [i, item] of applicable.entries()) {
          const movement: LedgerMovement = {
            tenantId,
            warehouseId: normalized.warehouseId,
            type: 'return.received',
            skuId: item.entry.skuId,
            quantityDelta: signedQuantity(item.milli),
            fromBinId: null,
            toBinId: returnsBin.binId,
            batchRef: item.batchId,
            serialRef: item.serialId,
            actorUserId: input.operatorUserId,
            occurredAt: normalized.occurredAt,
            recordedAt,
            referenceDoc: { kind: 'return-receipt', returnReceiptId, rmaId, rmaLineId: rmaLineIds[i]! },
          };
          ledgerEventIds.push((await this.inventory.appendLedgerEventInTx(tx, movement)).eventId);
        }
        await tx.insert(returnReceiptLines).values(
          applicable.map((item, i) => ({
            id: receiptLineIds[i]!,
            tenantId,
            returnReceiptId: returnReceiptId!,
            rmaLineId: rmaLineIds[i]!,
            skuId: item.entry.skuId,
            lineNo: i + 1,
            qty: item.milli,
            // Decision 2 — review gates disposition: nothing is open until accepted.
            openQty: 0,
            condition: item.entry.condition,
            note: item.entry.note,
            batchId: item.batchId,
            serialId: item.serialId,
            handlingUnitId: unitByReceiptLine.get(receiptLineIds[i]!) ?? null,
            ledgerEventId: ledgerEventIds[i]!,
          })),
        );
        // A1 — the basis is 0 while pending: open_qty 0 conserves.
        await assertLinesConservedInTx(tx, tenantId, receiptLineIds);
      }

      // 12. The refused entries — ONE server-raised, Discard-only review row.
      let reviewOpId: string | null = null;
      if (refused.length > 0) {
        reviewOpId = refusedEntriesOpId(idempotencyKey);
        const reasons = [...new Set(refused.map((item) => item.reason))];
        await recordServerRejectedOpInTx(tx, this.outbox, {
          tenantId,
          deviceId: input.deviceId,
          operatorUserId: input.operatorUserId,
          opId: reviewOpId,
          opType: 'return.receive_blind',
          problemCode: 'blind-entries-refused',
          problemDetail: `${refused.length} unit(s) of an unannounced parcel${normalized.parcelReference === null ? '' : ` (${normalized.parcelReference})`} were not booked (${reasons.join(', ')}) — the units are on the dock and booked nowhere; fix the catalog entry (batch, serial, SKU), then receive them again as an unannounced parcel.`,
          payload: {
            warehouseId: normalized.warehouseId,
            clientId: normalized.clientId,
            parcelReference: normalized.parcelReference,
            occurredAt: normalized.occurredAt,
            entries: refused.map((item) => ({ ...normalized.entries[item.entryIndex]! })),
            refusals: refused.map((item) => ({ entryIndex: item.entryIndex, reason: item.reason })),
          },
          occurredAt: normalized.occurredAt,
        });
      }

      const snapshot: BlindReceiptResult = {
        rmaId,
        rmaCode: rmaCodeValue,
        returnReceiptId,
        code,
        suggestedOrderId,
        matchKind,
        applied: applicable.map((item) => ({ entryIndex: item.entryIndex, qty: fromMilli(item.milli) })),
        refused,
        reviewOpId,
      };
      // 13. Outbox, 14. audit (the receipt, or the device when nothing applied).
      const at = nowIso();
      const payload: ReturnBlindRecordedPayload = {
        rmaId,
        rmaCode: rmaCodeValue,
        returnReceiptId,
        code,
        clientId: normalized.clientId,
        warehouseId: normalized.warehouseId,
        suggestedOrderId,
        appliedCount: applicable.length,
        refusedCount: refused.length,
      };
      await this.outbox.append(tx, { messageId: uuidv7(), tenantId, type: RETURN_BLIND_RECORDED_EVENT, occurredAt: at, payload: { ...payload } });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: input.operatorUserId,
        action: RETURN_BLIND_RECORDED_EVENT,
        targetType: returnReceiptId === null ? 'device' : 'return_receipt',
        targetId: returnReceiptId ?? input.deviceId,
        reference: idempotencyKey,
        occurredAt: at,
        changes: { rmaId, clientId: normalized.clientId, appliedCount: applicable.length, refusedCount: refused.length, reviewOpId },
      });
      // 15. Heartbeat, 16. the key LAST.
      await touchDeviceInTx(tx, input.deviceId);
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── the web review: accept ─────────────────────────────────────────────────

  async accept(input: AcceptBlindCommand, idempotencyKey: string): Promise<BlindAcceptResult> {
    if (!isUuidText(input.rmaId)) throw blindValidation('rmaId must be a uuid.');
    if (input.orderId !== null && !isUuidText(input.orderId)) throw blindValidation('orderId must be a uuid or null.');
    const rmaId = canonicalUuid(input.rmaId);
    const orderId = input.orderId === null ? null : canonicalUuid(input.orderId);
    const payloadHash = blindAcceptPayloadHash(input.tenantId, rmaId, orderId);
    const tenantId = input.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, input.actorUserId), 'returns.manage');
      const replayed = await this.replay<BlindAcceptResult>(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      // The order lock — the create's — before the RMA row (the body names
      // the order, so it is never taken after reading the row).
      if (orderId !== null) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${rmaOrderLockKey(tenantId, orderId)}, 0))`);
      }
      const rma = await this.lockRma(tx, tenantId, rmaId);
      const replayedUnderLock = await this.replay<BlindAcceptResult>(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      this.assertBlindPending(rma);

      const lines = await tx
        .select()
        .from(returnAuthorizationLines)
        .where(and(eq(returnAuthorizationLines.tenantId, tenantId), eq(returnAuthorizationLines.rmaId, rma.id)))
        .orderBy(asc(returnAuthorizationLines.lineNo))
        .for('update');
      const receiptLines = await tx
        .select({ id: returnReceiptLines.id, rmaLineId: returnReceiptLines.rmaLineId })
        .from(returnReceiptLines)
        .innerJoin(
          returnReceipts,
          and(eq(returnReceipts.tenantId, returnReceiptLines.tenantId), eq(returnReceipts.id, returnReceiptLines.returnReceiptId)),
        )
        .where(and(eq(returnReceiptLines.tenantId, tenantId), eq(returnReceipts.rmaId, rma.id)))
        .orderBy(asc(returnReceiptLines.id))
        .for('update', { of: returnReceiptLines });

      let unlinked: string[] = lines.map((line) => line.id);
      let header: { orderId: string; orderDispatchedAt: string; orderReference: string | null } | null = null;
      if (orderId !== null) {
        const computed = await returnableFactsInTx(
          tx,
          { outbound: this.outbound, catalog: this.catalog, inventory: this.inventory },
          tenantId,
          orderId,
        );
        if (computed === null) throw orderNotFound(orderId);
        if (computed.facts.clientId !== rma.clientId) {
          throw new ProblemException(
            'order-client-mismatch',
            409,
            "The order is another client's",
            `Order "${orderId}" belongs to another client than unannounced return "${rma.code}" — link an order of the parcel's own client, or choose "No order".`,
            { orderId },
          );
        }
        if (computed.facts.warehouseId !== rma.warehouseId) {
          throw new ProblemException(
            'document-warehouse-mismatch',
            409,
            "The order is another warehouse's",
            `Order "${orderId}" was dispatched from another warehouse than the one unannounced return "${rma.code}" was received in.`,
            { orderId },
          );
        }
        if (computed.facts.status !== 'dispatched') {
          throw new ProblemException(
            'order-not-dispatched',
            409,
            'Order is not dispatched',
            `Order "${orderId}" is ${computed.facts.status} — an unannounced return links only to a dispatched order.`,
            { orderId, orderStatus: computed.facts.status },
          );
        }
        if (computed.dispatchedAt === null) {
          throw new ProblemException('data-fault', 500, 'Return data is inconsistent', `Order "${orderId}" is dispatched but its ledger holds no dispatch.dispatched event.`);
        }
        header = { orderId, orderDispatchedAt: computed.dispatchedAt, orderReference: rmaOrderReference(computed.facts) };
        const plan = planBlindLinks(
          lines.map((line) => ({ id: line.id, lineNo: line.lineNo, skuId: line.skuId, milli: Number(line.receivedQty), serialIds: line.serialIds })),
          [...computed.lines.values()].map((line) => ({
            orderLineId: line.orderLineId,
            skuId: line.skuId,
            kitParent: line.kitParent,
            returnableMilli: line.returnableMilli,
            returnableSerialIds: new Set(line.dispatchedSerialIds.filter((id) => !line.authorizedSerialIds.has(id))),
          })),
        );
        // Merges first (their target lines exist until the deletes), then links.
        const lineById = new Map(lines.map((line) => [line.id, line]));
        const mergedInto = new Map<string, { milli: number; serialIds: string[] }>();
        for (const [fromId, intoId] of plan.merges) {
          const from = lineById.get(fromId)!;
          const acc = mergedInto.get(intoId) ?? { milli: 0, serialIds: [] };
          acc.milli += Number(from.receivedQty);
          acc.serialIds.push(...from.serialIds);
          mergedInto.set(intoId, acc);
          await tx
            .update(returnReceiptLines)
            .set({ rmaLineId: intoId })
            .where(and(eq(returnReceiptLines.tenantId, tenantId), eq(returnReceiptLines.rmaLineId, fromId)));
        }
        for (const [intoId, acc] of mergedInto) {
          const into = lineById.get(intoId)!;
          await tx
            .update(returnAuthorizationLines)
            .set({
              authorizedQty: sql`${returnAuthorizationLines.authorizedQty} + ${acc.milli}::bigint`,
              receivedQty: sql`${returnAuthorizationLines.receivedQty} + ${acc.milli}::bigint`,
              serialIds: [...new Set([...into.serialIds, ...acc.serialIds])],
            })
            .where(and(eq(returnAuthorizationLines.tenantId, tenantId), eq(returnAuthorizationLines.id, intoId)));
        }
        if (plan.merges.size > 0) {
          await tx
            .delete(returnAuthorizationLines)
            .where(and(eq(returnAuthorizationLines.tenantId, tenantId), inArray(returnAuthorizationLines.id, [...plan.merges.keys()])));
        }
        for (const [rmaLineId, orderLineId] of plan.links) {
          await tx
            .update(returnAuthorizationLines)
            .set({ orderLineId })
            .where(and(eq(returnAuthorizationLines.tenantId, tenantId), eq(returnAuthorizationLines.id, rmaLineId)));
        }
        unlinked = [...plan.unlinked];
      }

      // Open the units to disposition.
      await tx
        .update(returnReceiptLines)
        .set({ openQty: sql`${returnReceiptLines.qty}` })
        .where(and(eq(returnReceiptLines.tenantId, tenantId), inArray(returnReceiptLines.id, receiptLines.map((line) => line.id))));
      const at = nowIso();
      const updated = await tx
        .update(returnAuthorizations)
        .set({
          reviewStatus: 'accepted',
          reviewedBy: input.actorUserId,
          reviewedAt: at,
          ...(header === null ? {} : header),
          updatedAt: at,
        })
        .where(and(eq(returnAuthorizations.tenantId, tenantId), eq(returnAuthorizations.id, rma.id), eq(returnAuthorizations.reviewStatus, 'pending')))
        .returning({ id: returnAuthorizations.id });
      if (updated.length !== 1) throw reviewNotPending(rma.code, 'decided');
      await assertLinesConservedInTx(
        tx,
        tenantId,
        receiptLines.map((line) => line.id),
      );

      const detail = (await rmaDetailInTx(tx, this.catalog, tenantId, rma.id, { withReview: true }))!;
      const snapshot: BlindAcceptResult = { ...detail, unlinkedLines: unlinked };
      const payload: ReturnBlindReviewedPayload = {
        rmaId: rma.id,
        code: rma.code,
        clientId: rma.clientId,
        warehouseId: rma.warehouseId,
        orderId,
        lineCount: detail.lines.length,
      };
      await this.outbox.append(tx, { messageId: uuidv7(), tenantId, type: RETURN_BLIND_ACCEPTED_EVENT, occurredAt: at, payload: { ...payload } });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: input.actorUserId,
        action: RETURN_BLIND_ACCEPTED_EVENT,
        targetType: 'return_authorization',
        targetId: rma.id,
        reference: idempotencyKey,
        occurredAt: at,
        changes: { orderId, unlinkedLines: unlinked, mergedLines: lines.length - detail.lines.length },
      });
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── the web review: reject ─────────────────────────────────────────────────

  async reject(input: RejectBlindCommand, idempotencyKey: string): Promise<RmaDetail> {
    if (!isUuidText(input.rmaId)) throw blindValidation('rmaId must be a uuid.');
    const rmaId = canonicalUuid(input.rmaId);
    const normalized = normalizeBlindReject(input);
    const payloadHash = blindRejectPayloadHash(input.tenantId, rmaId, normalized);
    const tenantId = input.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, input.actorUserId), 'returns.manage');
      const replayed = await this.replay<RmaDetail>(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const rma = await this.lockRma(tx, tenantId, rmaId);
      const replayedUnderLock = await this.replay<RmaDetail>(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      this.assertBlindPending(rma);

      const lines = await tx
        .select({
          id: returnReceiptLines.id,
          skuId: returnReceiptLines.skuId,
          qty: returnReceiptLines.qty,
          batchId: returnReceiptLines.batchId,
          serialId: returnReceiptLines.serialId,
          handlingUnitId: returnReceiptLines.handlingUnitId,
          receiptKey: returnReceipts.idempotencyKey,
        })
        .from(returnReceiptLines)
        .innerJoin(
          returnReceipts,
          and(eq(returnReceipts.tenantId, returnReceiptLines.tenantId), eq(returnReceipts.id, returnReceiptLines.returnReceiptId)),
        )
        .where(and(eq(returnReceiptLines.tenantId, tenantId), eq(returnReceipts.rmaId, rma.id)))
        .orderBy(asc(returnReceiptLines.returnReceiptId), asc(returnReceiptLines.lineNo))
        .for('update', { of: returnReceiptLines });
      const totalMilli = lines.reduce((acc, line) => acc + Number(line.qty), 0);
      // A18 — the write-off threshold, the adjustment's compare (strictly greater).
      const threshold = await this.inventory.adjustmentThresholdInTx(tx, tenantId);
      if (threshold !== null && totalMilli > threshold * QUANTITY_SCALE) {
        throw new ProblemException(
          'reject-above-threshold',
          409,
          'Reject above the write-off threshold',
          `Rejecting unannounced return "${rma.code}" removes ${fromMilli(totalMilli)} units from RETURNS, above this tenant's write-off threshold of ${threshold} — accept it and scrap the units in steps, or raise the threshold in the adjustment policy.`,
          { threshold, totalQty: fromMilli(totalMilli) },
        );
      }
      // D3 — 4-7a's reconcile-quarantine rule on RETURNS (one vocabulary).
      const returnsBin = await ensureReturnsBinInTx(tx, tenantId, rma.warehouseId);
      const skuIds = [...new Set(lines.map((line) => line.skuId))];
      const skuFacts = await this.catalog.skuFactsInTx(tx, tenantId, skuIds, { lock: 'share' });
      for (const skuId of skuIds) {
        const quarantined = await this.inventory.openQuarantinedBinsInTx(tx, tenantId, rma.warehouseId, skuId, [returnsBin.binId]);
        if (quarantined.length > 0) {
          throw new ProblemException(
            'disposition-scope-quarantined',
            409,
            'The stock is under a reconcile quarantine',
            `SKU "${skuFacts.get(skuId)?.code ?? skuId}" in bin "RETURNS" is quarantined by reconciliation — its count is not trusted, so nothing moves out of it; resolve the quarantine first.`,
          );
        }
      }

      // The handling units (returned → rejected), then the serial locks, then
      // the reversals (the warehouse advisory inside each append).
      const unitIds = lines.flatMap((line) => (line.handlingUnitId === null ? [] : [line.handlingUnitId]));
      if (unitIds.length > 0) {
        await this.catalog.lockHandlingUnits(tx, tenantId, unitIds);
        await this.catalog.settleReturnedHandlingUnitsInTx(tx, tenantId, unitIds, 'rejected');
      }
      await this.inventory.lockSerialsInTx(
        tx,
        tenantId,
        lines.flatMap((line) => (line.serialId === null ? [] : [line.serialId])),
      );
      const at = nowIso();
      for (const line of lines) {
        const movement: LedgerMovement = {
          tenantId,
          warehouseId: rma.warehouseId,
          type: 'return.reversed',
          skuId: line.skuId,
          quantityDelta: signedQuantity(-Number(line.qty)),
          fromBinId: returnsBin.binId,
          toBinId: null,
          batchRef: line.batchId,
          serialRef: line.serialId,
          actorUserId: input.actorUserId,
          occurredAt: at,
          recordedAt: at,
          referenceDoc: { kind: 'return-reversal', rmaId: rma.id, returnReceiptLineId: line.id, reasonCode: normalized.reasonCode },
        };
        await this.inventory.appendLedgerEventInTx(tx, movement);
      }
      const updated = await tx
        .update(returnAuthorizations)
        .set({
          reviewStatus: 'rejected',
          reviewedBy: input.actorUserId,
          reviewedAt: at,
          reviewReasonCode: normalized.reasonCode,
          reviewNote: normalized.note,
          updatedAt: at,
        })
        .where(and(eq(returnAuthorizations.tenantId, tenantId), eq(returnAuthorizations.id, rma.id), eq(returnAuthorizations.reviewStatus, 'pending')))
        .returning({ id: returnAuthorizations.id });
      if (updated.length !== 1) throw reviewNotPending(rma.code, 'decided');
      // A1 — rejected: basis 0, `open_qty` stays 0.
      await assertLinesConservedInTx(
        tx,
        tenantId,
        lines.map((line) => line.id),
      );

      // The receipts' own review rows (their refused entries), for the trail.
      const reviewOpIds = [...new Set(lines.map((line) => line.receiptKey))]
        .map((key) => key)
        .filter((key): key is string => key !== null);
      const keyRows =
        reviewOpIds.length === 0
          ? []
          : await tx
              .select({ snapshot: idempotencyKeys.responseSnapshot })
              .from(idempotencyKeys)
              .where(and(eq(idempotencyKeys.tenantId, tenantId), inArray(idempotencyKeys.key, reviewOpIds)));
      const raised = keyRows
        .map((row) => (row.snapshot as { reviewOpId?: unknown } | null)?.reviewOpId)
        .filter((id): id is string => typeof id === 'string');

      const snapshot = (await rmaDetailInTx(tx, this.catalog, tenantId, rma.id, { withReview: true }))!;
      const payload: ReturnBlindReviewedPayload = {
        rmaId: rma.id,
        code: rma.code,
        clientId: rma.clientId,
        warehouseId: rma.warehouseId,
        orderId: null,
        lineCount: snapshot.lines.length,
      };
      await this.outbox.append(tx, { messageId: uuidv7(), tenantId, type: RETURN_BLIND_REJECTED_EVENT, occurredAt: at, payload: { ...payload } });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: input.actorUserId,
        action: RETURN_BLIND_REJECTED_EVENT,
        targetType: 'return_authorization',
        targetId: rma.id,
        reference: idempotencyKey,
        occurredAt: at,
        changes: { reasonCode: normalized.reasonCode, lineCount: lines.length, totalQty: fromMilli(totalMilli), reviewOpIds: raised },
      });
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── shared pieces ──────────────────────────────────────────────────────────

  /** The two review guards, in order: blind, then pending. */
  private assertBlindPending(rma: ReturnAuthorizationRow): void {
    if (rma.origin !== 'blind') throw rmaNotBlind(rma.code, rma.origin);
    if (rma.reviewStatus !== 'pending') throw reviewNotPending(rma.code, rma.reviewStatus ?? 'unknown');
  }

  /** The next `RRN-<n>` under `:rrn-seq` (13-2's sequence, taken after `:rma-seq`). */
  private async allocateRrnCode(tx: TenantTx, tenantId: string): Promise<string> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${rrnSequenceLockKey(tenantId)}, 0))`);
    const rows = await tx
      .select({ n: sql<number>`coalesce(max(substring(${returnReceipts.code} from '^RRN-([0-9]{1,9})$')::int), 0)` })
      .from(returnReceipts)
      .where(eq(returnReceipts.tenantId, tenantId));
    return rrnCode(Number(rows[0]?.n ?? 0) + 1);
  }

  /** Lock + 404 only — never a status check (§1, the `loadOpenPo` lesson). */
  private async lockRma(tx: TenantTx, tenantId: string, rmaId: string): Promise<ReturnAuthorizationRow> {
    const rows = await tx
      .select()
      .from(returnAuthorizations)
      .where(and(eq(returnAuthorizations.tenantId, tenantId), eq(returnAuthorizations.id, rmaId)))
      .limit(1)
      .for('update');
    const rma = rows[0];
    if (rma === undefined) throw rmaNotFound(rmaId);
    return rma;
  }

  private async replay<T>(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<T | null> {
    const rows = await tx
      .select({ payloadHash: idempotencyKeys.payloadHash, responseSnapshot: idempotencyKeys.responseSnapshot })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot as T;
  }

  private async writeIdempotencyKey(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string, snapshot: object): Promise<void> {
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
