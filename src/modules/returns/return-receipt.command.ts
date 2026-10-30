import { createHash } from 'node:crypto';
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
import type { ReturnAuthorizationLineRow, ReturnAuthorizationRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import {
  MAX_QUANTITY_BASE,
  QUANTITY_SCALE,
  fromMilli,
  signedQuantity,
  validateRecordableQuantity,
} from '../../shared/primitives/quantity';
import { assertUtcIso, canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { ensureReturnsBinInTx } from '../tenancy/receiving-bin';
import { recordServerRejectedOpInTx } from '../tenancy/server-rejected-op';
import { userEmailsInTx } from '../tenancy/tenancy.service';
import { CatalogFacade } from '../catalog/catalog.facade';
import type { SkuFacts } from '../catalog/catalog.facade';
import { MAX_HANDLING_UNIT_WEIGHT_GRAMS } from '../catalog/handling-unit';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { LedgerMovement } from '../inventory/inventory.facade';
import type { OutboundFacade } from '../outbound/outbound.facade';
import { canonicalUuid, rmaNotFound } from './return-authorization.command';
import type { RmaStatus } from './return-authorization.command';
import { RETURN_RECEIPT_RECORDED_EVENT } from './events';
import { EMPTY_SPLIT, lineSplitsInTx } from './disposition-split';
import type { ReturnReceiptRecordedPayload } from './events';

// ── vocabularies ─────────────────────────────────────────────────────────────

/**
 * Human decision 1 (2026-10-16) — the inspection is a condition GRADE per
 * unit, recorded on the receipt and shown to whoever dispositions; it
 * suggests a disposition, it decides nothing. Mirrored by
 * `return_receipt_lines_condition_check` (0073), pinned against it by
 * `test/return-receipts.spec.ts`.
 */
export const RETURN_CONDITIONS = ['resaleable', 'opened', 'damaged', 'missing-parts'] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

/**
 * Why an entry of a receipt was NOT booked (human decision 3 — receive what
 * matches, review the rest). Each refused entry lands in the review queue
 * with one of these, in the classification's order:
 * - `not-on-authorization` — no line, a line of another RMA, or a SKU that is
 *   not the line's;
 * - `exceeds-authorized` — more than the line still has open (or a part of a
 *   catch-weight case);
 * - `serial-not-authorized` — a serial the line does not authorize, or one
 *   already received;
 * - `serial-in-stock` — an authorized serial that is on-hand in a bin right
 *   now (it cannot be the returned unit);
 * - `batch-not-dispatched` — a batch the line was not picked from (for a
 *   batch-and-serial SKU: not that serial's own pick batch);
 * - `batch-not-dispatched` also when the entry would claim more units of a
 *   batch than the order line picked from it (earlier receipts and earlier
 *   entries of the op counted);
 * - `missing-capture` — a capture the SKU requires is absent (serial number,
 *   batch code, the case's weight);
 * - `unexpected-capture` — a capture the SKU does not take is present (a
 *   serial on an untracked SKU, a batch on an unbatched one, a weight on a
 *   non-catch-weight one);
 * - `weight-out-of-range` — a case weight past `MAX_HANDLING_UNIT_WEIGHT_GRAMS`;
 * - `qty-precision` — a quantity finer than the SKU's unit allows (one bad
 *   entry never fails the whole receipt).
 */
export const RETURN_ENTRY_REFUSALS = [
  'not-on-authorization',
  'exceeds-authorized',
  'serial-not-authorized',
  'serial-in-stock',
  'batch-not-dispatched',
  'missing-capture',
  'unexpected-capture',
  'weight-out-of-range',
  'qty-precision',
] as const;
export type ReturnEntryRefusal = (typeof RETURN_ENTRY_REFUSALS)[number];

/** Human decision 2 — units are received only against an open or partially received RMA. */
export const RECEIVABLE_RMA_STATUSES: readonly RmaStatus[] = ['open', 'partially_received'];

/**
 * Entries per op: the worst-case payload stays under the sync report's 32 KB
 * per-row budget (a whole-op refusal uploads the full payload). The device
 * splits a larger receipt into several ops.
 */
export const MAX_RETURN_RECEIPT_ENTRIES = 150;
/** An entry's inspection note, in code points (0073's CHECK). */
export const MAX_RETURN_NOTE = 200;
/** A batch code, in code points (the GRN's bound). */
const MAX_BATCH_CODE = 64;
/** A serial number, in code points (the RMA's bound). */
const MAX_SERIAL_NUMBER = 200;

const RRN_TENANT_CODE = 'return_receipts_tenant_code_unique';
const RRN_LINE_SERIAL = 'return_receipt_lines_rma_line_serial_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** The receipt code sequence's advisory-lock key text (the `allocateGrnCode` shape). */
export function rrnSequenceLockKey(tenantId: string): string {
  return `${tenantId}:rrn-seq`;
}

/** Receipt codes are `RRN-<n>`, zero-padded to 4 digits, unique per tenant. */
export function rrnCode(n: number): string {
  return `RRN-${String(n).padStart(4, '0')}`;
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The review row's op id for a receipt's refused entries: a VALID ULID
 * derived deterministically from the op's key — the key's own 10-character
 * timestamp, then 16 characters of `sha256(key + ':refused')`. It never
 * equals the key (the device's op id — which a later device upload of the
 * same op, were there one, would claim), and the same key always derives the
 * same id, so the `(tenant, op_id)` dedupe absorbs any re-insert. It is also
 * recorded in the idempotency snapshot (`reviewOpId`), so a replay re-serves
 * it and inserts nothing.
 */
export function refusedEntriesOpId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${idempotencyKey}:refused`).digest();
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ULID_ALPHABET.charAt(digest[i]! & 31);
  const derived = idempotencyKey.slice(0, 10).toUpperCase() + tail;
  if (derived !== idempotencyKey) return derived;
  // Astronomically unlikely; still never the key.
  const last = derived.charAt(25);
  return derived.slice(0, 25) + (last === '0' ? '1' : '0');
}

// ── command input and snapshot ───────────────────────────────────────────────

/** One scanned unit (or case, or run of untracked units) of a receipt — base units. */
export interface ReturnEntryInput {
  /** The authorization line it is received against; null for a unit not on the RMA. */
  readonly rmaLineId?: string | null | undefined;
  readonly skuId: string;
  /** Base units. A serial entry is 1 unit; a catch-weight entry is 1 case. */
  readonly qty: number;
  readonly condition: string;
  readonly note?: string | null | undefined;
  readonly batchCode?: string | null | undefined;
  readonly serialNumber?: string | null | undefined;
  /** The case's captured weight, integer grams (catch-weight SKUs). */
  readonly weightGrams?: number | null | undefined;
}

export interface ReceiveReturnCommand {
  readonly tenantId: string;
  /** The badge-in session's device — re-authorized from the DB at entry. */
  readonly deviceId: string;
  readonly operatorUserId: string;
  readonly warehouseId: string;
  readonly rmaId: string;
  /** Device time (AD-1) — the ledger events' and the receipt's business time. */
  readonly occurredAt: string;
  readonly entries: readonly ReturnEntryInput[];
}

export interface ReturnEntryApplied {
  readonly entryIndex: number;
  readonly rmaLineId: string;
  /** Base units. */
  readonly qty: number;
}

export interface ReturnEntryRefused {
  readonly entryIndex: number;
  readonly reason: ReturnEntryRefusal;
}

/** The 201 body — and the idempotency snapshot a replay re-serves. */
export interface ReturnReceiptResult {
  /** Null when every entry was refused (no receipt row). */
  readonly returnReceiptId: string | null;
  readonly code: string | null;
  /** The authorization's status after this receipt (unchanged when nothing applied). */
  readonly rmaStatus: RmaStatus;
  readonly applied: readonly ReturnEntryApplied[];
  readonly refused: readonly ReturnEntryRefused[];
  /** The review row's op id when entries were refused (never the op's key); null otherwise. */
  readonly reviewOpId: string | null;
}

/** One received line as the detail read shows it (base units). */
export interface ReturnReceiptLineView {
  /** Story 4-7a — the receipt line's id (the disposition's address). */
  readonly id: string;
  readonly rmaLineId: string;
  readonly skuId: string;
  readonly qty: number;
  readonly condition: ReturnCondition;
  readonly note: string | null;
  readonly batchCode: string | null;
  readonly serialNumber: string | null;
  readonly weightGrams: number | null;
  /**
   * Story 4-7a — the line's split (base units): still awaiting a disposition
   * (`openQty`), restocked, scrapped, on an open return hold, and failed at a
   * return hold's inspection (now in DAMAGED). `qty = openQty + restocked +
   * scrapped + onHold + failedInspection`.
   */
  readonly openQty: number;
  readonly restockedQty: number;
  readonly scrappedQty: number;
  readonly onHoldQty: number;
  readonly failedInspectionQty: number;
  /**
   * Story 4-7b (A1, D1) — a BLIND RMA's line: `qty` while its review is
   * pending (nothing can be dispositioned yet), and `qty` once it is
   * rejected (the booking was reversed). Optional — a stored 13-2 snapshot
   * never carried them; the detail read emits both for every blind RMA (0
   * when not in that state) and neither for an authorized one.
   */
  readonly pendingReviewQty?: number;
  readonly reversedQty?: number;
}

/** One receipt as the detail read shows it. */
export interface ReturnReceiptView {
  readonly id: string;
  readonly code: string;
  readonly occurredAt: string;
  /** The receiving operator's email, resolved by the server (null when the user is gone). */
  readonly operatorEmail: string | null;
  readonly lines: readonly ReturnReceiptLineView[];
}

/** One open RMA as the device catalog snapshot carries it (base units). */
export interface OpenReturnLine {
  readonly id: string;
  readonly skuId: string;
  readonly authorizedQty: number;
  readonly receivedQty: number;
  readonly openQty: number;
  /** The batches the order line was picked from (batch-tracked SKUs; empty otherwise). */
  readonly batchCodes: readonly string[];
  /** Serial-tracked lines: every authorized serial, whether it is received, and its picked batch. */
  readonly serials: readonly {
    readonly id: string;
    readonly serialNumber: string;
    readonly received: boolean;
    readonly batchCode: string | null;
  }[];
}

export interface OpenReturn {
  readonly id: string;
  readonly code: string;
  readonly orderReference: string | null;
  /** Story 1-1 — the RMA's client (the device resolves a typed code within it). */
  readonly clientId: string;
  /**
   * Story 4-7b (A19) — the order's carrier tracking numbers (non-voided
   * shipments): a scanned forward AWB on an unannounced parcel redirects the
   * operator to this RMA's receipt. Omitted when the order has none.
   */
  readonly trackingNumbers?: readonly string[];
  readonly lines: readonly OpenReturnLine[];
}

// ── refusals (whole op) ──────────────────────────────────────────────────────

/** A broken invariant between the module's rows and a sibling's (the 13-1 data-fault shape) — typed, 500. */
function returnDataFault(detail: string): ProblemException {
  return new ProblemException('data-fault', 500, 'Return data is inconsistent', detail);
}

function receiptValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid return receipt', detail);
}

/** 409 — the RMA is not `open` / `partially_received` (human decision 2). */
function rmaNotReceivable(code: string, status: string): ProblemException {
  return new ProblemException(
    'rma-not-receivable',
    409,
    'Return authorization cannot receive',
    `Return authorization "${code}" is ${status} — units are received only against an open or partially received authorization.`,
    { status },
  );
}

/** 409 `document-warehouse-mismatch` — the GRN's refusal (21-6), word for word in shape. */
function documentWarehouseMismatch(code: string): ProblemException {
  return new ProblemException(
    'document-warehouse-mismatch',
    409,
    "Receipt warehouse is not the document's",
    `Return authorization "${code}" belongs to another warehouse — receive it in the warehouse it was raised for.`,
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

export interface NormalizedEntry {
  readonly rmaLineId: string | null;
  readonly skuId: string;
  readonly qty: number;
  readonly condition: ReturnCondition;
  readonly note: string | null;
  readonly batchCode: string | null;
  readonly serialNumber: string | null;
  readonly weightGrams: number | null;
}

export interface NormalizedReceive {
  readonly warehouseId: string;
  readonly rmaId: string;
  readonly occurredAt: string;
  readonly entries: readonly NormalizedEntry[];
}

/**
 * The request-shape rules (IMPLEMENTATION-GUIDE §1, tier 1): no row needed,
 * so they answer 400 `validation-failed` above the transaction — never a
 * replay. Optional keys normalise here (`?? null`, trimmed, blank = absent),
 * so a stored payload re-read raw (a device that omitted a key) means
 * exactly what an explicit null means.
 */
export function normalizeReceive(command: Omit<ReceiveReturnCommand, 'tenantId' | 'deviceId' | 'operatorUserId'>): NormalizedReceive {
  if (!isUuidText(command.warehouseId)) throw receiptValidation('warehouseId must be a uuid.');
  if (!isUuidText(command.rmaId)) throw receiptValidation('rmaId must be a uuid.');
  let occurredAt: string;
  try {
    occurredAt = assertUtcIso(command.occurredAt);
  } catch {
    throw receiptValidation(`occurredAt must be a Z-suffixed ISO-8601 UTC instant (got "${String(command.occurredAt).slice(0, 64)}").`);
  }
  const entries = command.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw receiptValidation('A return receipt needs at least one entry.');
  }
  if (entries.length > MAX_RETURN_RECEIPT_ENTRIES) {
    throw receiptValidation(
      `A return receipt carries at most ${MAX_RETURN_RECEIPT_ENTRIES} entries (got ${entries.length}) — split it into several receipts.`,
    );
  }
  const normalized = entries.map((entry, index): NormalizedEntry => {
    const at = `entries[${index}]`;
    const rmaLineId = entry.rmaLineId ?? null;
    if (rmaLineId !== null && !isUuidText(rmaLineId)) throw receiptValidation(`${at}: rmaLineId must be a uuid or null.`);
    if (!isUuidText(entry.skuId)) throw receiptValidation(`${at}: skuId must be a uuid.`);
    if (typeof entry.qty !== 'number' || !Number.isFinite(entry.qty) || entry.qty <= 0 || entry.qty > MAX_QUANTITY_BASE) {
      throw receiptValidation(`${at}: qty must be a number greater than 0 (got ${String(entry.qty)}).`);
    }
    if (!(RETURN_CONDITIONS as readonly string[]).includes(entry.condition)) {
      throw receiptValidation(`${at}: condition must be one of ${JSON.stringify(RETURN_CONDITIONS)} (got "${String(entry.condition)}").`);
    }
    if (entry.note !== undefined && entry.note !== null && typeof entry.note !== 'string') {
      throw receiptValidation(`${at}: note must be a string or null.`);
    }
    const note = trimmedOrNull(entry.note);
    if (note !== null && codePoints(note) > MAX_RETURN_NOTE) {
      throw receiptValidation(`${at}: note must be at most ${MAX_RETURN_NOTE} characters (got ${codePoints(note)}).`);
    }
    if (entry.batchCode !== undefined && entry.batchCode !== null && typeof entry.batchCode !== 'string') {
      throw receiptValidation(`${at}: batchCode must be a string or null.`);
    }
    const batchCode = trimmedOrNull(entry.batchCode);
    if (batchCode !== null && codePoints(batchCode) > MAX_BATCH_CODE) {
      throw receiptValidation(`${at}: batchCode must be at most ${MAX_BATCH_CODE} characters.`);
    }
    if (entry.serialNumber !== undefined && entry.serialNumber !== null && typeof entry.serialNumber !== 'string') {
      throw receiptValidation(`${at}: serialNumber must be a string or null.`);
    }
    const serialNumber = trimmedOrNull(entry.serialNumber);
    if (serialNumber !== null && codePoints(serialNumber) > MAX_SERIAL_NUMBER) {
      throw receiptValidation(`${at}: serialNumber must be at most ${MAX_SERIAL_NUMBER} characters.`);
    }
    const weightGrams = entry.weightGrams ?? null;
    if (weightGrams !== null && (typeof weightGrams !== 'number' || !Number.isInteger(weightGrams) || weightGrams <= 0)) {
      throw receiptValidation(`${at}: weightGrams must be a positive whole number of grams or null (got ${String(weightGrams)}).`);
    }
    // One entry per unit or case: a serial names ONE unit, a weight ONE case.
    if (serialNumber !== null && entry.qty !== 1) {
      throw receiptValidation(`${at}: a serial entry is one unit — qty must be 1 (got ${entry.qty}).`);
    }
    if (weightGrams !== null && entry.qty !== 1) {
      throw receiptValidation(`${at}: a catch-weight entry is one case with its weight — qty must be 1 (got ${entry.qty}).`);
    }
    if (serialNumber !== null && weightGrams !== null) {
      throw receiptValidation(`${at}: an entry carries a serial number or a case weight, never both.`);
    }
    return {
      rmaLineId: rmaLineId === null ? null : canonicalUuid(rmaLineId),
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
    rmaId: canonicalUuid(command.rmaId),
    occurredAt,
    entries: normalized,
  };
}

/**
 * The receipt fingerprint: `arm` first, then the WHOLE body — the warehouse,
 * the RMA, the device time and every entry in request order with every key
 * always present (`rmaLineId` an explicit null when absent, the captures
 * null when absent). Built over the normalized form, so an absent key and an
 * explicit null hash the same. Pinned by a golden in
 * `test/return-receipts.spec.ts`.
 */
export function receivePayloadHash(
  tenantId: string,
  deviceId: string,
  operatorUserId: string,
  normalized: NormalizedReceive,
): string {
  return hashCommandPayload({
    arm: 'return-receive',
    tenantId,
    deviceId,
    operatorUserId,
    warehouseId: normalized.warehouseId,
    rmaId: normalized.rmaId,
    occurredAt: normalized.occurredAt,
    entries: normalized.entries.map((entry) => ({
      rmaLineId: entry.rmaLineId,
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

// ── reads shared by the command, the snapshot and the detail ────────────────

/** A serial the RMA names but the catalog cannot resolve is a data fault — never shown as its uuid (the 13-1 fix). */
function serialNumberOrFault(numberById: ReadonlyMap<string, string>, id: string): string {
  const serialNumber = numberById.get(id);
  if (serialNumber === undefined) {
    throw returnDataFault(`Serial "${id}" is named by a return authorization, but the catalog does not hold it.`);
  }
  return serialNumber;
}

type OrderLedgerEvents = Awaited<ReturnType<InventoryFacade['ledgerEventsByOrderRefInTx']>>;

/** The order's pick facts per order line: picked batch ids, and each picked serial's batch. */
export interface PickFacts {
  readonly batchIdsByOrderLine: ReadonlyMap<string, ReadonlySet<string>>;
  /** `${orderLineId}:${batchId}` → milli-units picked from that batch for the line. */
  readonly pickedMilliByLineBatch: ReadonlyMap<string, number>;
  /** serialId → the batch it was picked with (null when the pick carried none). */
  readonly batchBySerial: ReadonlyMap<string, string | null>;
}

function pickFactsOf(events: OrderLedgerEvents): PickFacts {
  const batchIdsByOrderLine = new Map<string, Set<string>>();
  const pickedMilliByLineBatch = new Map<string, number>();
  const batchBySerial = new Map<string, string | null>();
  for (const event of events) {
    if (event.type !== 'pick.picked') continue;
    const doc = event.referenceDoc as { readonly orderLineId?: unknown } | null;
    if (typeof doc?.orderLineId !== 'string') continue;
    if (event.batchRef !== null) {
      const set = batchIdsByOrderLine.get(doc.orderLineId) ?? new Set<string>();
      set.add(event.batchRef);
      batchIdsByOrderLine.set(doc.orderLineId, set);
      const key = `${doc.orderLineId}:${event.batchRef}`;
      // A pick is a draw: the delta is negative.
      pickedMilliByLineBatch.set(key, (pickedMilliByLineBatch.get(key) ?? 0) + Math.abs(Number(event.quantityDelta)));
    }
    if (event.serialRef !== null) {
      batchBySerial.set(event.serialRef, event.batchRef);
    }
  }
  return { batchIdsByOrderLine, pickedMilliByLineBatch, batchBySerial };
}

/** Σ received milli-units per `${orderLineId}:${batchId}` over every RMA line of those order lines (own rows). */
async function receivedBatchMilliInTx(
  tx: TenantTx,
  tenantId: string,
  orderLineIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderLineIds.length === 0) return out;
  const rows = await tx
    .select({
      orderLineId: returnAuthorizationLines.orderLineId,
      batchId: returnReceiptLines.batchId,
      milli: sql<string>`sum(${returnReceiptLines.qty})::bigint`,
    })
    .from(returnReceiptLines)
    .innerJoin(
      returnAuthorizationLines,
      and(
        eq(returnAuthorizationLines.id, returnReceiptLines.rmaLineId),
        eq(returnAuthorizationLines.tenantId, returnReceiptLines.tenantId),
      ),
    )
    .where(
      and(
        eq(returnReceiptLines.tenantId, tenantId),
        inArray(returnAuthorizationLines.orderLineId, [...orderLineIds]),
        sql`${returnReceiptLines.batchId} is not null`,
      ),
    )
    .groupBy(returnAuthorizationLines.orderLineId, returnReceiptLines.batchId);
  for (const row of rows) out.set(`${row.orderLineId}:${row.batchId}`, Number(row.milli));
  return out;
}

/** The serial ids already received per RMA line (this module's own rows). */
async function receivedSerialsByLineInTx(
  tx: TenantTx,
  tenantId: string,
  rmaLineIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (rmaLineIds.length === 0) return out;
  const rows = await tx
    .select({ rmaLineId: returnReceiptLines.rmaLineId, serialId: returnReceiptLines.serialId })
    .from(returnReceiptLines)
    .where(
      and(
        eq(returnReceiptLines.tenantId, tenantId),
        inArray(returnReceiptLines.rmaLineId, [...rmaLineIds]),
        sql`${returnReceiptLines.serialId} is not null`,
      ),
    );
  for (const row of rows) {
    const set = out.get(row.rmaLineId) ?? new Set<string>();
    set.add(row.serialId!);
    out.set(row.rmaLineId, set);
  }
  return out;
}

/**
 * Story 13-2 — the open RMAs of one warehouse as the device catalog snapshot
 * carries them (`openReturns`): every RMA in `open` / `partially_received`,
 * its lines with the open quantity, the order line's picked batch codes, and
 * a serial-tracked line's authorized serials with their received flag and
 * their own pick batch. Read in the caller's transaction (the facade opens
 * its own); the order facts come only through the inventory and catalog
 * facades.
 */
export async function openReturnsInTx(
  tx: TenantTx,
  deps: { readonly catalog: CatalogFacade; readonly inventory: InventoryFacade; readonly outbound?: OutboundFacade },
  tenantId: string,
  warehouseId: string,
): Promise<OpenReturn[]> {
  const headers = await tx
    .select()
    .from(returnAuthorizations)
    .where(
      and(
        eq(returnAuthorizations.tenantId, tenantId),
        eq(returnAuthorizations.warehouseId, warehouseId),
        inArray(returnAuthorizations.status, [...RECEIVABLE_RMA_STATUSES]),
      ),
    )
    .orderBy(asc(returnAuthorizations.createdAt), asc(returnAuthorizations.id));
  if (headers.length === 0) return [];
  // Story 4-7b (A19) — the orders' tracking numbers, one read.
  const trackingByOrder =
    deps.outbound === undefined
      ? new Map<string, string[]>()
      : await deps.outbound.trackingNumbersByOrderIdsInTx(
          tx,
          tenantId,
          headers.flatMap((header) => (header.orderId === null ? [] : [header.orderId])),
        );
  const lines = await tx
    .select()
    .from(returnAuthorizationLines)
    .where(
      and(
        eq(returnAuthorizationLines.tenantId, tenantId),
        inArray(
          returnAuthorizationLines.rmaId,
          headers.map((header) => header.id),
        ),
      ),
    )
    .orderBy(asc(returnAuthorizationLines.rmaId), asc(returnAuthorizationLines.lineNo));
  const skuIds = [...new Set(lines.map((line) => line.skuId))];
  const skuFacts = await deps.catalog.skuFactsInTx(tx, tenantId, skuIds);
  const batchCodeById = new Map(
    (await deps.catalog.getBatchesForSkusInTx(tx, tenantId, skuIds)).map((batch) => [batch.id, batch.code]),
  );
  const receivedSerials = await receivedSerialsByLineInTx(
    tx,
    tenantId,
    lines.map((line) => line.id),
  );
  const serialNumberById = new Map<string, string>();
  const idsBySku = new Map<string, Set<string>>();
  for (const line of lines) {
    if (line.serialIds.length === 0) continue;
    const set = idsBySku.get(line.skuId) ?? new Set<string>();
    for (const id of line.serialIds) set.add(id);
    idsBySku.set(line.skuId, set);
  }
  for (const [skuId, ids] of idsBySku) {
    for (const serial of await deps.catalog.serialIdentitiesInTx(tx, tenantId, skuId, { ids: [...ids] })) {
      serialNumberById.set(serial.id, serial.serialNumber);
    }
  }
  const out: OpenReturn[] = [];
  for (const header of headers) {
    const own = lines.filter((line) => line.rmaId === header.id);
    // The pick facts are needed only for a batch- or serial-tracked line.
    const needsPicks = own.some((line) => {
      const facts = skuFacts.get(line.skuId);
      return facts !== undefined && (facts.batchTracked || facts.serialTracked);
    });
    // A receivable RMA is always authorized (a blind one is born `received`),
    // so it names its order and every line its order line (A4: type-only).
    const orderId = header.orderId ?? '';
    const picks = needsPicks
      ? pickFactsOf(await deps.inventory.ledgerEventsByOrderRefInTx(tx, tenantId, header.warehouseId, orderId))
      : pickFactsOf([]);
    const tracking = trackingByOrder.get(orderId);
    out.push({
      id: header.id,
      code: header.code,
      orderReference: header.orderReference,
      clientId: header.clientId,
      ...(tracking === undefined || tracking.length === 0 ? {} : { trackingNumbers: tracking }),
      lines: own.map((line) => {
        const facts = skuFacts.get(line.skuId);
        const received = receivedSerials.get(line.id) ?? new Set<string>();
        const batchCodes =
          facts?.batchTracked === true
            ? [...(picks.batchIdsByOrderLine.get(line.orderLineId ?? '') ?? new Set<string>())]
                .map((id) => batchCodeById.get(id))
                .filter((code): code is string => code !== undefined)
                .sort()
            : [];
        return {
          id: line.id,
          skuId: line.skuId,
          authorizedQty: fromMilli(Number(line.authorizedQty)),
          receivedQty: fromMilli(Number(line.receivedQty)),
          openQty: fromMilli(Number(line.authorizedQty) - Number(line.receivedQty)),
          batchCodes,
          serials: line.serialIds
            .map((id) => {
              const batchId = picks.batchBySerial.get(id) ?? null;
              return {
                id,
                serialNumber: serialNumberOrFault(serialNumberById, id),
                received: received.has(id),
                batchCode: batchId === null ? null : (batchCodeById.get(batchId) ?? null),
              };
            })
            .sort((a, b) => (a.serialNumber < b.serialNumber ? -1 : a.serialNumber > b.serialNumber ? 1 : 0)),
        };
      }),
    });
  }
  return out;
}

/**
 * Story 13-2 — one RMA's receipts as the detail read shows them (oldest
 * first), each line with its grade, note, batch code, serial number and a
 * returned case's weight; the operator's email resolved through tenancy's
 * `userEmailsInTx` (returns reads no `users` table itself).
 */
export async function receiptsOfRmaInTx(
  tx: TenantTx,
  catalog: CatalogFacade,
  tenantId: string,
  rmaId: string,
  /** Story 4-7b — the RMA's review status: non-null (a blind RMA) adds `pendingReviewQty` / `reversedQty`. */
  reviewStatus: string | null = null,
): Promise<ReturnReceiptView[]> {
  const headers = await tx
    .select({
      id: returnReceipts.id,
      code: returnReceipts.code,
      occurredAt: returnReceipts.occurredAt,
      receivedBy: returnReceipts.receivedBy,
    })
    .from(returnReceipts)
    .where(and(eq(returnReceipts.tenantId, tenantId), eq(returnReceipts.rmaId, rmaId)))
    .orderBy(asc(returnReceipts.createdAt), asc(returnReceipts.id));
  if (headers.length === 0) return [];
  const lines = await tx
    .select()
    .from(returnReceiptLines)
    .where(
      and(
        eq(returnReceiptLines.tenantId, tenantId),
        inArray(
          returnReceiptLines.returnReceiptId,
          headers.map((header) => header.id),
        ),
      ),
    )
    .orderBy(asc(returnReceiptLines.returnReceiptId), asc(returnReceiptLines.lineNo));
  const skuIds = [...new Set(lines.map((line) => line.skuId))];
  const batchCodeById = new Map(
    (await catalog.getBatchesForSkusInTx(tx, tenantId, skuIds)).map((batch) => [batch.id, batch.code]),
  );
  const serialNumberById = new Map<string, string>();
  const serialIdsBySku = new Map<string, Set<string>>();
  for (const line of lines) {
    if (line.serialId === null) continue;
    const set = serialIdsBySku.get(line.skuId) ?? new Set<string>();
    set.add(line.serialId);
    serialIdsBySku.set(line.skuId, set);
  }
  for (const [skuId, ids] of serialIdsBySku) {
    for (const serial of await catalog.serialIdentitiesInTx(tx, tenantId, skuId, { ids: [...ids] })) {
      serialNumberById.set(serial.id, serial.serialNumber);
    }
  }
  const weightById = new Map(
    (
      await catalog.handlingUnitsByIdsInTx(
        tx,
        tenantId,
        lines.flatMap((line) => (line.handlingUnitId === null ? [] : [line.handlingUnitId])),
      )
    ).map((unit) => [unit.id, unit.weightGrams]),
  );
  const emails = await userEmailsInTx(
    tx,
    tenantId,
    [...new Set(headers.map((header) => header.receivedBy))],
  );
  const splits = await lineSplitsInTx(
    tx,
    tenantId,
    lines.map((line) => line.id),
  );
  return headers.map((header) => ({
    id: header.id,
    code: header.code,
    occurredAt: canonicalInstant(header.occurredAt),
    operatorEmail: emails.get(header.receivedBy) ?? null,
    lines: lines
      .filter((line) => line.returnReceiptId === header.id)
      .map((line) => {
        const split = splits.get(line.id) ?? EMPTY_SPLIT;
        return {
        id: line.id,
        rmaLineId: line.rmaLineId,
        skuId: line.skuId,
        qty: fromMilli(Number(line.qty)),
        condition: line.condition as ReturnCondition,
        note: line.note,
        batchCode: line.batchId === null ? null : (batchCodeById.get(line.batchId) ?? null),
        serialNumber: line.serialId === null ? null : (serialNumberById.get(line.serialId) ?? null),
        weightGrams: line.handlingUnitId === null ? null : (weightById.get(line.handlingUnitId) ?? null),
        openQty: fromMilli(Number(line.openQty)),
        restockedQty: fromMilli(split.restocked),
        scrappedQty: fromMilli(split.scrapped),
        onHoldQty: fromMilli(split.onHold),
        failedInspectionQty: fromMilli(split.failed),
        ...(reviewStatus === null
          ? {}
          : {
              pendingReviewQty: reviewStatus === 'pending' ? fromMilli(Number(line.qty)) : 0,
              reversedQty: reviewStatus === 'rejected' ? fromMilli(Number(line.qty)) : 0,
            }),
        };
      }),
  }));
}

/**
 * What the classification reads — every fact gathered under the RMA row lock
 * and the serial locks before the first entry is judged.
 */
export interface ClassifyContext {
  readonly lineById: ReadonlyMap<string, Pick<ReturnAuthorizationLineRow, 'id' | 'skuId' | 'orderLineId' | 'serialIds'>>;
  readonly skuFacts: ReadonlyMap<string, SkuFacts>;
  /** Per RMA line, milli-units still open (authorized − received − applied so far). */
  readonly remaining: ReadonlyMap<string, number>;
  /** Per entry index, the serial id its serial number resolved to (null: unknown on the SKU). */
  readonly serialIdByEntry: ReadonlyMap<number, string | null>;
  /** Serials currently on-hand in some bin → that bin. */
  readonly inStock: ReadonlyMap<string, string>;
  /** Per RMA line, the serials already received (this op's included). */
  readonly receivedSerials: ReadonlyMap<string, ReadonlySet<string>>;
  readonly picks: PickFacts;
  /** `${skuId}:${batchCode}` → batch id. */
  readonly batchIdByCode: ReadonlyMap<string, string>;
  /**
   * `${orderLineId}:${batchId}` → milli-units already received back from that
   * batch (earlier receipts on any RMA of the order line, plus this op's
   * applied entries so far).
   */
  readonly receivedMilliByLineBatch: ReadonlyMap<string, number>;
}

/**
 * One entry's verdict, in the spec's order: the line and its SKU → the
 * quantity against the remaining open quantity → the serial → the batch →
 * the case weight → no capture the SKU does not take.
 */
export function classifyReturnEntry(
  entryIndex: number,
  entry: NormalizedEntry,
  ctx: ClassifyContext,
): ApplicableEntry | { readonly reason: ReturnEntryRefusal } {
  // (1) On this RMA, and the line's SKU.
  const line = entry.rmaLineId === null ? undefined : ctx.lineById.get(entry.rmaLineId);
  if (line === undefined || line.skuId !== entry.skuId) return { reason: 'not-on-authorization' };
  const sku = ctx.skuFacts.get(line.skuId);
  if (sku === undefined) {
    // A data fault (the RMA names only real SKUs) — typed, never an untyped 500.
    throw returnDataFault(`Return authorization line "${line.id}" names SKU "${line.skuId}", which the catalog does not hold.`);
  }
  // (2) The quantity at the SKU's precision — a too-precise quantity is a
  //     per-entry refusal (`qty-precision`), never a whole-receipt 400 — then
  //     within what is still open, whole cases for catch weight.
  const checked = validateRecordableQuantity(entry.qty, `entries[${entryIndex}].qty`, sku.uom, sku.uomPrecision, 'non-negative');
  if (!checked.ok) return { reason: 'qty-precision' };
  const milli = checked.milli;
  if (sku.catchWeightTracked && milli % QUANTITY_SCALE !== 0) return { reason: 'exceeds-authorized' };
  if (milli > ctx.remaining.get(line.id)!) return { reason: 'exceeds-authorized' };
  // (3) Serial-tracked: the serial is one the line authorizes, not yet
  //     received, and not on-hand anywhere right now.
  let serialId: string | null = null;
  if (sku.serialTracked) {
    if (entry.serialNumber === null) return { reason: 'missing-capture' };
    serialId = ctx.serialIdByEntry.get(entryIndex) ?? null;
    if (serialId === null || !line.serialIds.includes(serialId)) return { reason: 'serial-not-authorized' };
    if (ctx.receivedSerials.get(line.id)?.has(serialId) === true) return { reason: 'serial-not-authorized' };
    if (ctx.inStock.has(serialId)) return { reason: 'serial-in-stock' };
  } else if (entry.serialNumber !== null) {
    return { reason: 'unexpected-capture' };
  }
  // (4) Batch-tracked: a batch the order line was picked from — for a
  //     batch-and-serial SKU, THAT serial's own pick batch. The resolved
  //     batch id is reused, never created.
  let batchId: string | null = null;
  if (sku.batchTracked) {
    if (entry.batchCode === null) return { reason: 'missing-capture' };
    const resolved = ctx.batchIdByCode.get(`${line.skuId}:${entry.batchCode}`);
    if (resolved === undefined) return { reason: 'batch-not-dispatched' };
    if (serialId !== null) {
      if (ctx.picks.batchBySerial.get(serialId) !== resolved) return { reason: 'batch-not-dispatched' };
    } else if (ctx.picks.batchIdsByOrderLine.get(line.orderLineId ?? '')?.has(resolved) !== true) {
      return { reason: 'batch-not-dispatched' };
    }
    // No more back from a batch than the line picked from it.
    const key = `${line.orderLineId}:${resolved}`;
    const picked = ctx.picks.pickedMilliByLineBatch.get(key) ?? 0;
    if ((ctx.receivedMilliByLineBatch.get(key) ?? 0) + milli > picked) return { reason: 'batch-not-dispatched' };
    batchId = resolved;
  } else if (entry.batchCode !== null) {
    return { reason: 'unexpected-capture' };
  }
  // (5) Catch-weight: the case's weight, within the ceiling.
  if (sku.catchWeightTracked) {
    if (entry.weightGrams === null) return { reason: 'missing-capture' };
    if (entry.weightGrams > MAX_HANDLING_UNIT_WEIGHT_GRAMS) return { reason: 'weight-out-of-range' };
  } else if (entry.weightGrams !== null) {
    return { reason: 'unexpected-capture' };
  }
  return { entryIndex, entry, line, milli, batchId, serialId };
}

// ── the command ──────────────────────────────────────────────────────────────

/** One entry that matched its line, ready to book (milli-units). */
export interface ApplicableEntry {
  readonly entryIndex: number;
  readonly entry: NormalizedEntry;
  readonly line: Pick<ReturnAuthorizationLineRow, 'id' | 'skuId' | 'orderLineId' | 'serialIds'>;
  readonly milli: number;
  readonly batchId: string | null;
  readonly serialId: string | null;
}

/**
 * Story 13-2 (FR-47) — `return.receive`: the floor receives returned units
 * scan-first against an authorization, grades each unit's condition, and the
 * units that match are booked into the system RETURNS bin — "received,
 * awaiting disposition", outside ATP until 13-3. Everything else goes to the
 * existing review queue: nothing is silently dropped or silently accepted
 * (human decision 3).
 *
 * Device-authenticated, the `grn.submit` shape (IMPLEMENTATION-GUIDE §1):
 * shape (above the tx, 400) → hash → the device and role guard (tenancy's,
 * 403) → replay → lock the RMA (404 only — the lock helper checks no status)
 * → replay again under it → the body's warehouse is the RMA's (409
 * `document-warehouse-mismatch`, before the status — the 21-6b order) → the
 * RMA receives (409 `rma-not-receivable`) → lock its lines → pre-lock the
 * named serials, sorted → classify every entry in request order → book the
 * applied ones (a returned case per catch-weight entry, one `return.received`
 * per entry, one receipt line, the line's `received_qty`) → the RMA status →
 * the refused entries' ONE review row → outbox → audit → heartbeat → key
 * LAST.
 */
@Injectable()
export class ReturnReceiptCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  async receive(input: ReceiveReturnCommand, idempotencyKey: string): Promise<ReturnReceiptResult> {
    // 0. Shape — no row needed, so above the transaction (400, never a replay).
    const normalized = normalizeReceive(input);
    // 1. The fingerprint, before the transaction.
    const payloadHash = receivePayloadHash(input.tenantId, input.deviceId, input.operatorUserId, normalized);
    const tenantId = input.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // 2. The device and role guard — tenancy's (returns reads no devices
      //    or users table), before the replay: the token is transport.
      await assertDeviceOperatorInTx(tx, tenantId, input.deviceId, input.operatorUserId);
      // 3. Replay.
      const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      // 4. Lock the RMA — existence only (404).
      const rma = await this.lockRma(tx, tenantId, normalized.rmaId);
      // 5. Replay again UNDER the lock (a parked same-key duplicate).
      const replayedUnderLock = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      // 6. The warehouse BEFORE the status (21-6b): a received RMA of another
      //    warehouse is a warehouse mismatch.
      if (rma.warehouseId !== normalized.warehouseId) {
        throw documentWarehouseMismatch(rma.code);
      }
      // 7. Human decision 2 — only an open or partially received RMA receives.
      if (!RECEIVABLE_RMA_STATUSES.includes(rma.status as RmaStatus)) {
        throw rmaNotReceivable(rma.code, rma.status);
      }

      // 8. The RMA's lines, locked (own table), in line order.
      const rmaLines = await tx
        .select()
        .from(returnAuthorizationLines)
        .where(and(eq(returnAuthorizationLines.tenantId, tenantId), eq(returnAuthorizationLines.rmaId, rma.id)))
        .orderBy(asc(returnAuthorizationLines.lineNo))
        .for('update');
      const lineById = new Map(rmaLines.map((line) => [line.id, line]));
      // Story 1-4 — FOR SHARE: a tracking-flag flip cannot interleave with
      // this posting (the SKU edit's flag guard takes the row FOR UPDATE).
      const skuFacts = await this.catalog.skuFactsInTx(
        tx,
        tenantId,
        rmaLines.map((line) => line.skuId),
        { lock: 'share' },
      );

      // 9. Resolve and pre-lock the serials named on matching lines, sorted
      //    (the serial advisory family — the ledger append re-acquires each,
      //    a no-op; the warehouse advisory comes after, inside the append).
      const serialIdByEntry = new Map<number, string | null>();
      const numbersBySku = new Map<string, Set<string>>();
      for (const [index, entry] of normalized.entries.entries()) {
        const line = entry.rmaLineId === null ? undefined : lineById.get(entry.rmaLineId);
        if (line === undefined || line.skuId !== entry.skuId || entry.serialNumber === null) continue;
        if (skuFacts.get(line.skuId)?.serialTracked !== true) continue;
        const set = numbersBySku.get(line.skuId) ?? new Set<string>();
        set.add(entry.serialNumber);
        numbersBySku.set(line.skuId, set);
        serialIdByEntry.set(index, null);
      }
      const idBySkuNumber = new Map<string, string>();
      for (const [skuId, numbers] of numbersBySku) {
        for (const serial of await this.catalog.serialIdentitiesInTx(tx, tenantId, skuId, { numbers: [...numbers] })) {
          idBySkuNumber.set(`${skuId}:${serial.serialNumber}`, serial.id);
        }
      }
      for (const index of serialIdByEntry.keys()) {
        const entry = normalized.entries[index]!;
        serialIdByEntry.set(index, idBySkuNumber.get(`${entry.skuId}:${entry.serialNumber}`) ?? null);
      }
      const namedSerialIds = [...new Set([...serialIdByEntry.values()].filter((id): id is string => id !== null))];
      await this.inventory.lockSerialsInTx(tx, tenantId, namedSerialIds);
      const inStock = await this.inventory.serialsInStockInTx(tx, tenantId, namedSerialIds);
      const receivedSerials = await receivedSerialsByLineInTx(
        tx,
        tenantId,
        rmaLines.map((line) => line.id),
      );

      // The order's pick facts — only when a batch-tracked line is named.
      const needsPicks = normalized.entries.some((entry) => {
        const line = entry.rmaLineId === null ? undefined : lineById.get(entry.rmaLineId);
        return line !== undefined && skuFacts.get(line.skuId)?.batchTracked === true;
      });
      const picks = needsPicks
        ? pickFactsOf(await this.inventory.ledgerEventsByOrderRefInTx(tx, tenantId, rma.warehouseId, rma.orderId ?? ''))
        : pickFactsOf([]);
      const batchIdByCode = new Map<string, string>();
      if (needsPicks) {
        for (const batch of await this.catalog.getBatchesForSkusInTx(
          tx,
          tenantId,
          rmaLines.map((line) => line.skuId),
        )) {
          batchIdByCode.set(`${batch.skuId}:${batch.code}`, batch.id);
        }
      }

      // Units already received back per (order line, batch), across every
      // RMA of the order (own tables) — the per-batch ceiling's other half.
      const receivedMilliByLineBatch = needsPicks
        ? await receivedBatchMilliInTx(tx, tenantId, [...new Set(rmaLines.flatMap((line) => (line.orderLineId === null ? [] : [line.orderLineId])))])
        : new Map<string, number>();

      // 10. Classify each entry, in request order, against the remaining
      //     (authorized − received) quantity, decremented as entries apply.
      const remaining = new Map(rmaLines.map((line) => [line.id, Number(line.authorizedQty) - Number(line.receivedQty)]));
      const applicable: ApplicableEntry[] = [];
      const refused: ReturnEntryRefused[] = [];
      for (const [entryIndex, entry] of normalized.entries.entries()) {
        const verdict = classifyReturnEntry(entryIndex, entry, {
          lineById,
          skuFacts,
          remaining,
          serialIdByEntry,
          inStock,
          receivedSerials,
          picks,
          batchIdByCode,
          receivedMilliByLineBatch,
        });
        if ('reason' in verdict) {
          refused.push({ entryIndex, reason: verdict.reason });
          continue;
        }
        remaining.set(verdict.line.id, remaining.get(verdict.line.id)! - verdict.milli);
        if (verdict.batchId !== null) {
          const key = `${verdict.line.orderLineId}:${verdict.batchId}`;
          receivedMilliByLineBatch.set(key, (receivedMilliByLineBatch.get(key) ?? 0) + verdict.milli);
        }
        if (verdict.serialId !== null) {
          const set = receivedSerials.get(verdict.line.id) ?? new Set<string>();
          set.add(verdict.serialId);
          receivedSerials.set(verdict.line.id, set);
        }
        applicable.push(verdict);
      }

      // 11. Book the applied entries — only when at least one applied.
      let returnReceiptId: string | null = null;
      let code: string | null = null;
      const recordedAt = nowIso();
      if (applicable.length > 0) {
        const returnsBin = await ensureReturnsBinInTx(tx, tenantId, rma.warehouseId);
        code = await this.allocateCode(tx, tenantId);
        returnReceiptId = uuidv7();
        try {
          await tx.insert(returnReceipts).values({
            id: returnReceiptId,
            tenantId,
            clientId: rma.clientId,
            warehouseId: rma.warehouseId,
            rmaId: rma.id,
            code,
            deviceId: input.deviceId,
            receivedBy: input.operatorUserId,
            idempotencyKey,
            occurredAt: normalized.occurredAt,
          });
        } catch (err) {
          if (isUniqueViolationOn(err, RRN_TENANT_CODE)) {
            // Unreachable beneath the sequence lock; the unique index is the backstop.
            throw new ProblemException('conflict', 409, 'Concurrent return receipt', 'Retry to read the settled result.');
          }
          throw err;
        }
        const receiptLineIds = applicable.map(() => uuidv7());
        // A returned case per catch-weight entry — through the catalog
        // facade (handling_units stays catalog's), status `returned`, its
        // provenance the receipt line, never a GRN line.
        const caseEntries = applicable
          .map((item, i) => ({ item, lineId: receiptLineIds[i]! }))
          .filter(({ item }) => item.entry.weightGrams !== null && skuFacts.get(item.line.skuId)?.catchWeightTracked === true);
        const createdUnits = await this.catalog.createHandlingUnits(
          tx,
          tenantId,
          caseEntries.map(({ item, lineId }) => ({
            warehouseId: rma.warehouseId,
            skuId: item.line.skuId,
            batchId: item.batchId,
            returnReceiptLineId: lineId,
            weightGrams: item.entry.weightGrams!,
            status: 'returned' as const,
          })),
        );
        const unitByReceiptLine = new Map(createdUnits.map((unit) => [unit.returnReceiptLineId!, unit.id]));

        const ledgerEventIds: string[] = [];
        for (const item of applicable) {
          const movement: LedgerMovement = {
            tenantId,
            warehouseId: rma.warehouseId,
            type: 'return.received',
            skuId: item.line.skuId,
            quantityDelta: signedQuantity(item.milli),
            fromBinId: null,
            toBinId: returnsBin.binId,
            batchRef: item.batchId,
            serialRef: item.serialId,
            actorUserId: input.operatorUserId,
            occurredAt: normalized.occurredAt,
            recordedAt,
            referenceDoc: { kind: 'return-receipt', returnReceiptId, rmaId: rma.id, rmaLineId: item.line.id },
          };
          const appended = await this.inventory.appendLedgerEventInTx(tx, movement);
          ledgerEventIds.push(appended.eventId);
        }
        try {
          await tx.insert(returnReceiptLines).values(
            applicable.map((item, i) => ({
              id: receiptLineIds[i]!,
              tenantId,
              returnReceiptId: returnReceiptId!,
              rmaLineId: item.line.id,
              skuId: item.line.skuId,
              // Request order among the applied entries, 1..n.
              lineNo: i + 1,
              qty: item.milli,
              // Story 4-7a (A1) — every received unit starts awaiting a disposition.
              openQty: item.milli,
              condition: item.entry.condition,
              note: item.entry.note,
              batchId: item.batchId,
              serialId: item.serialId,
              handlingUnitId: unitByReceiptLine.get(receiptLineIds[i]!) ?? null,
              ledgerEventId: ledgerEventIds[i]!,
            })),
          );
        } catch (err) {
          if (isUniqueViolationOn(err, RRN_LINE_SERIAL)) {
            // Unreachable beneath the serial locks and the received-serial
            // read; the partial unique index is the backstop.
            throw new ProblemException('conflict', 409, 'Serial already received', 'Retry to read the settled result.');
          }
          throw err;
        }
        // The line's `received_qty` — one typed update per credited line
        // (0073's `received_qty <= authorized_qty` CHECK is the backstop).
        const appliedByLine = new Map<string, number>();
        for (const item of applicable) {
          appliedByLine.set(item.line.id, (appliedByLine.get(item.line.id) ?? 0) + item.milli);
        }
        for (const [rmaLineId, milli] of appliedByLine) {
          await tx
            .update(returnAuthorizationLines)
            .set({ receivedQty: sql`${returnAuthorizationLines.receivedQty} + ${milli}::bigint` })
            .where(and(eq(returnAuthorizationLines.tenantId, tenantId), eq(returnAuthorizationLines.id, rmaLineId)));
        }
      }

      // 12. The status: `received` when every line is fully received,
      //     `partially_received` otherwise; unchanged when nothing applied.
      let rmaStatus = rma.status as RmaStatus;
      if (applicable.length > 0) {
        const allReceived = rmaLines.every((line) => remaining.get(line.id)! <= 0);
        rmaStatus = allReceived ? 'received' : 'partially_received';
        await tx
          .update(returnAuthorizations)
          .set({ status: rmaStatus, updatedAt: nowIso() })
          .where(and(eq(returnAuthorizations.tenantId, tenantId), eq(returnAuthorizations.id, rma.id)));
      }

      // 13. The refused entries — ONE review row, server-raised through
      //     tenancy (returns writes no rejected_ops row itself).
      let reviewOpId: string | null = null;
      if (refused.length > 0) {
        reviewOpId = refusedEntriesOpId(idempotencyKey);
        const reasons = [...new Set(refused.map((item) => item.reason))];
        await recordServerRejectedOpInTx(tx, this.outbox, {
          tenantId,
          deviceId: input.deviceId,
          operatorUserId: input.operatorUserId,
          opId: reviewOpId,
          opType: 'return.receive',
          problemCode: 'return-entries-refused',
          problemDetail: `${refused.length} unit(s) of return authorization "${rma.code}" were not booked (${reasons.join(', ')}) — create a return authorization for these units, then receive them again.`,
          payload: {
            warehouseId: normalized.warehouseId,
            rmaId: rma.id,
            rmaCode: rma.code,
            occurredAt: normalized.occurredAt,
            // The refused entries only, aligned with `refusals` (entry i of
            // `entries` is refusal i; `entryIndex` names its place in the op).
            entries: refused.map((item) => ({ ...normalized.entries[item.entryIndex]! })),
            refusals: refused.map((item) => ({ entryIndex: item.entryIndex, reason: item.reason })),
          },
          occurredAt: normalized.occurredAt,
        });
      }

      const snapshot: ReturnReceiptResult = {
        returnReceiptId,
        code,
        rmaStatus,
        applied: applicable.map((item) => ({
          entryIndex: item.entryIndex,
          rmaLineId: item.line.id,
          qty: fromMilli(item.milli),
        })),
        refused,
        reviewOpId,
      };

      // 14. Outbox, then audit (the operator; target the receipt, or the RMA
      //     when nothing applied — `target_id` is NOT NULL), heartbeat, key.
      const at = nowIso();
      const payload: ReturnReceiptRecordedPayload = {
        returnReceiptId,
        code,
        rmaId: rma.id,
        rmaCode: rma.code,
        clientId: rma.clientId,
        warehouseId: rma.warehouseId,
        appliedCount: applicable.length,
        refusedCount: refused.length,
      };
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId,
        type: RETURN_RECEIPT_RECORDED_EVENT,
        occurredAt: at,
        payload: { ...payload },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: input.operatorUserId,
        action: RETURN_RECEIPT_RECORDED_EVENT,
        targetType: returnReceiptId === null ? 'return_authorization' : 'return_receipt',
        targetId: returnReceiptId ?? rma.id,
        reference: idempotencyKey,
        occurredAt: at,
      });
      await touchDeviceInTx(tx, input.deviceId);
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /** The next `RRN-<n>` under the tenant's sequence advisory lock (the `allocateGrnCode` copy). */
  private async allocateCode(tx: TenantTx, tenantId: string): Promise<string> {
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
    if (rma === undefined) {
      throw rmaNotFound(rmaId);
    }
    return rma;
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<ReturnReceiptResult | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot as ReturnReceiptResult;
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: ReturnReceiptResult,
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
