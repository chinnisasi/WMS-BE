import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  idempotencyKeys,
  returnAuthorizationLines,
  returnAuthorizations,
} from '../../shared/db/schema';
import type { ReturnAuthorizationLineRow, ReturnAuthorizationRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { QUANTITY_SCALE, assertRecordableQuantity, fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { CatalogFacade } from '../catalog/catalog.facade';
import type { SkuFacts } from '../catalog/catalog.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import type { OrderInvoiceFacts } from '../outbound/outbound.facade';
import { RETURN_AUTHORIZATION_CANCELLED_EVENT, RETURN_AUTHORIZATION_CREATED_EVENT } from './events';
import type { ReturnAuthorizationEventPayload } from './events';
import type { ReturnReceiptView } from './return-receipt.command';

// ── vocabularies ─────────────────────────────────────────────────────────────

/**
 * Story 13-1 — the RMA lifecycle. Mirrored by
 * `return_authorizations_status_check` (0072, widened by 0073) and pinned
 * against it by `test/returns.spec.ts`. 13-1 held only `open | cancelled`;
 * story 13-2 (receipt) adds `partially_received` (some units received, some
 * still open) and `received` (every line fully received). 13-3
 * (disposition) widens it again — no state is reserved before it is
 * designed.
 */
export const RMA_STATUSES = ['open', 'partially_received', 'received', 'cancelled'] as const;
export type RmaStatus = (typeof RMA_STATUSES)[number];

/**
 * Story 13-2 — the statuses whose authorized units are SPOKEN FOR: an open
 * RMA's are expected, a partially received or received one's arrived (or are
 * arriving). Every one of them counts against what an order line can still
 * be authorized for (`returnableFactsInTx`); only a cancelled RMA releases
 * its units. Before 13-2 the sums read `status = 'open'`, so a received
 * RMA's units would have become authorizable again (design review #1).
 */
export const RMA_COMMITTED_STATUSES: readonly RmaStatus[] = ['open', 'partially_received', 'received'];

/**
 * Decision 3 (human, 2026-10-16) — the per-line reason: a fixed list plus a
 * note; `other` requires the note. Mirrored by
 * `return_authorization_lines_reason_code_check` (0072), pinned by
 * `test/returns.spec.ts`.
 */
export const RETURN_REASON_CODES = [
  'damaged',
  'defective',
  'wrong-item',
  'not-as-described',
  'changed-mind',
  'other',
] as const;
export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

/** The line limit, a purchase order's and an order's. */
export const MAX_RMA_LINES = 200;
/** Serial numbers named on one line, and on one whole request (design review #5). */
export const MAX_RMA_SERIALS_PER_LINE = 500;
export const MAX_RMA_SERIALS_PER_REQUEST = 500;
/** A channel's or customer's RMA number, in code points (0072's CHECK). */
export const MAX_RMA_EXTERNAL_REFERENCE = 64;
/** A line's reason note and a cancel reason, in code points (0072's CHECKs). */
export const MAX_RMA_NOTE = 500;

const RMA_TENANT_CODE = 'return_authorizations_tenant_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * The per-order advisory lock's key text — exported so the race tests can
 * hold the very lock a create parks on. Taken as
 * `pg_advisory_xact_lock(hashtextextended(<this>, 0))`. Lock order: this,
 * then the code sequence lock; no other path takes either.
 */
export function rmaOrderLockKey(tenantId: string, orderId: string): string {
  return `${tenantId}:rma-order:${orderId}`;
}

/** The code sequence's advisory-lock key text (the `allocateGrnCode` shape). */
export function rmaSequenceLockKey(tenantId: string): string {
  return `${tenantId}:rma-seq`;
}

/** RMA codes are `RMA-<n>`, zero-padded to 4 digits, unique per tenant. */
export function rmaCode(n: number): string {
  return `RMA-${String(n).padStart(4, '0')}`;
}

// ── command inputs ───────────────────────────────────────────────────────────

export interface RmaLineInput {
  readonly orderLineId: string;
  /** Base units, at the SKU's UoM precision (checked behind the replay). */
  readonly qty: number;
  readonly reasonCode: string;
  readonly reasonNote?: string | null | undefined;
  readonly serialNumbers?: readonly string[] | null | undefined;
}

export interface CreateRmaCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly orderId: string;
  readonly externalReference?: string | null | undefined;
  readonly lines: readonly RmaLineInput[];
}

export interface CancelRmaCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly rmaId: string;
  readonly reason: string;
}

// ── snapshots ────────────────────────────────────────────────────────────────

export interface RmaSerial {
  readonly id: string;
  readonly serialNumber: string;
}

export interface RmaLineSnapshot {
  readonly id: string;
  readonly orderLineId: string;
  readonly skuId: string;
  /** Base units. */
  readonly authorizedQty: number;
  readonly receivedQty: number;
  readonly reasonCode: ReturnReasonCode;
  readonly reasonNote: string | null;
  /** Serial-tracked lines only (empty otherwise), sorted by serial number. */
  readonly serials: readonly RmaSerial[];
}

/** The detail, every read's item, and both commands' response (the idempotency snapshot). */
export interface RmaDetail {
  readonly id: string;
  readonly code: string;
  readonly status: RmaStatus;
  readonly orderId: string;
  readonly orderReference: string | null;
  readonly warehouseId: string;
  readonly clientId: string;
  readonly externalReference: string | null;
  readonly orderDispatchedAt: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly cancelledAt: string | null;
  readonly cancelledBy: string | null;
  readonly cancelReason: string | null;
  readonly lines: readonly RmaLineSnapshot[];
  /**
   * Story 13-2 — the receipts against it, oldest first. Present ONLY on the
   * detail read (`ReturnsFacade.get`): never on the list, never on a
   * command's stored snapshot — optional, so every pre-13-2 snapshot still
   * serves (IMPLEMENTATION-GUIDE §9).
   */
  readonly receipts?: readonly ReturnReceiptView[];
}

/** One order line of the returnable read. Quantities in base units. */
export interface ReturnableLine {
  readonly orderLineId: string;
  readonly parentLineId: string | null;
  readonly skuId: string;
  /** A line with component lines — never returnable itself; its components are. */
  readonly kitParent: boolean;
  readonly dispatchedQty: number;
  readonly authorizedQty: number;
  readonly returnableQty: number;
  readonly serialTracked: boolean;
  /** Serial-tracked lines: the dispatched serials not on an uncancelled authorization. */
  readonly returnableSerials: readonly RmaSerial[];
}

export interface ReturnableOrder {
  readonly orderId: string;
  readonly status: string;
  readonly warehouseId: string;
  readonly orderReference: string | null;
  /** The earliest `dispatch.dispatched` instant; null for an order not dispatched. */
  readonly dispatchedAt: string | null;
  readonly lines: readonly ReturnableLine[];
}

// ── refusals ─────────────────────────────────────────────────────────────────

function rmaValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid return authorization', detail);
}

export function orderNotFound(orderId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Order not found', `No order with id "${orderId}" exists in this tenant.`);
}

export function rmaNotFound(rmaId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Return authorization not found',
    `No return authorization with id "${rmaId}" exists in this tenant.`,
  );
}

function orderNotDispatched(orderId: string, status: string): ProblemException {
  return new ProblemException(
    'order-not-dispatched',
    409,
    'Order is not dispatched',
    `Order "${orderId}" is ${status} — only a dispatched order's units can be authorized for return.`,
    { orderId, status },
  );
}

function lineNotOfOrder(index: number, orderLineId: string, orderId: string): ProblemException {
  return new ProblemException(
    'line-not-of-order',
    400,
    'Line is not on the order',
    `lines[${index}]: order line "${orderLineId}" is not a line of order "${orderId}".`,
    { orderLineId },
  );
}

function kitParentNotReturnable(index: number, orderLineId: string): ProblemException {
  return new ProblemException(
    'kit-parent-not-returnable',
    400,
    'A kit parent line is not returnable',
    `lines[${index}]: order line "${orderLineId}" is a kit parent — authorize its component lines instead.`,
    { orderLineId },
  );
}

function exceedsReturnable(index: number, orderLineId: string, asked: number, returnable: number): ProblemException {
  return new ProblemException(
    'exceeds-returnable',
    409,
    'More than can be returned',
    `lines[${index}]: ${asked} asked for order line "${orderLineId}", but only ${returnable} can still be returned (dispatched minus what uncancelled authorizations already name).`,
    { orderLineId, returnableQty: returnable },
  );
}

function serialNotDispatched(index: number, orderLineId: string, serialNumber: string): ProblemException {
  return new ProblemException(
    'serial-not-dispatched',
    409,
    'Serial was not dispatched on this line',
    `lines[${index}]: serial "${serialNumber}" was not dispatched on order line "${orderLineId}".`,
    { orderLineId, serialNumber },
  );
}

function serialAlreadyAuthorized(index: number, orderLineId: string, serialNumber: string): ProblemException {
  return new ProblemException(
    'serial-already-authorized',
    409,
    'Serial is already on a return',
    `lines[${index}]: serial "${serialNumber}" of order line "${orderLineId}" is already on an uncancelled return authorization.`,
    { orderLineId, serialNumber },
  );
}

function rmaTransitionInvalid(code: string, status: string, detail: string): ProblemException {
  return new ProblemException(
    'rma-transition-invalid',
    409,
    'Return authorization cannot be cancelled',
    `Return authorization "${code}" is ${status} — ${detail}`,
    { status },
  );
}

// ── shape (above the transaction) ────────────────────────────────────────────

/** Trimmed text; blank → null. Non-strings pass through as null (the DTO typed them). */
function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Uuids are compared, hashed and lock-keyed as TEXT here (the order lock key,
 * the ledger's `reference_doc->>'orderId'` match, the line map), so one id
 * must have one spelling: lowercase, the form Postgres prints. The DTOs
 * lowercase at the edge; this is the command's own defence.
 */
export function canonicalUuid(value: string): string {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function codePoints(value: string): number {
  return [...value].length;
}

export interface NormalizedRmaLine {
  readonly orderLineId: string;
  readonly qty: number;
  readonly reasonCode: ReturnReasonCode;
  readonly reasonNote: string | null;
  /** Null when the request named none; trimmed, distinct, in request order otherwise. */
  readonly serialNumbers: readonly string[] | null;
}

export interface NormalizedCreate {
  readonly externalReference: string | null;
  readonly lines: readonly NormalizedRmaLine[];
}

/**
 * The request-shape checks that need no row (IMPLEMENTATION-GUIDE §1, tier 1):
 * 400 `validation-failed`, each naming its line, answered BEFORE the
 * transaction — so a malformed request is a 400 and never a replay, and a
 * request carrying a used key with a malformed body still answers 400.
 * Text is trimmed; a blank value means absent.
 */
export function normalizeCreate(command: Pick<CreateRmaCommand, 'externalReference' | 'lines'>): NormalizedCreate {
  const externalReference = trimmedOrNull(command.externalReference);
  if (externalReference !== null && codePoints(externalReference) > MAX_RMA_EXTERNAL_REFERENCE) {
    throw rmaValidation(
      `externalReference must be at most ${MAX_RMA_EXTERNAL_REFERENCE} characters (got ${codePoints(externalReference)}).`,
    );
  }
  const lines = command.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw rmaValidation('A return authorization needs at least one line.');
  }
  if (lines.length > MAX_RMA_LINES) {
    throw rmaValidation(`A return authorization carries at most ${MAX_RMA_LINES} lines (got ${lines.length}).`);
  }
  const seen = new Set<string>();
  let serialTotal = 0;
  const normalized = lines.map((rawLine, index): NormalizedRmaLine => {
    const at = `lines[${index}]`;
    const line = { ...rawLine, orderLineId: canonicalUuid(rawLine.orderLineId) };
    if (seen.has(line.orderLineId)) {
      throw rmaValidation(`${at}: order line "${line.orderLineId}" is named more than once — one line per order line.`);
    }
    seen.add(line.orderLineId);
    if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) {
      throw rmaValidation(`${at}: qty must be a number greater than 0 (got ${String(line.qty)}).`);
    }
    if (!(RETURN_REASON_CODES as readonly string[]).includes(line.reasonCode)) {
      throw rmaValidation(
        `${at}: reasonCode must be one of ${JSON.stringify(RETURN_REASON_CODES)} (got "${String(line.reasonCode)}").`,
      );
    }
    const reasonCode = line.reasonCode as ReturnReasonCode;
    const reasonNote = trimmedOrNull(line.reasonNote);
    if (reasonNote !== null && codePoints(reasonNote) > MAX_RMA_NOTE) {
      throw rmaValidation(`${at}: reasonNote must be at most ${MAX_RMA_NOTE} characters (got ${codePoints(reasonNote)}).`);
    }
    if (reasonCode === 'other' && reasonNote === null) {
      throw rmaValidation(`${at}: reasonCode "other" requires a reasonNote saying why.`);
    }
    let serialNumbers: string[] | null = null;
    // An empty list names nothing — the same as absent.
    if (line.serialNumbers !== undefined && line.serialNumbers !== null && line.serialNumbers.length > 0) {
      const raw: readonly string[] = line.serialNumbers;
      if (raw.length > MAX_RMA_SERIALS_PER_LINE) {
        throw rmaValidation(`${at}: at most ${MAX_RMA_SERIALS_PER_LINE} serial numbers per line (got ${raw.length}).`);
      }
      const trimmed: string[] = raw.map((value: string, serialIndex: number) => {
        const text = trimmedOrNull(value);
        if (text === null) {
          throw rmaValidation(`${at}: serialNumbers[${serialIndex}] is blank.`);
        }
        return text;
      });
      const repeated = trimmed.find((value, i) => trimmed.indexOf(value) !== i);
      if (repeated !== undefined) {
        throw rmaValidation(`${at}: serial "${repeated}" is named more than once.`);
      }
      if (trimmed.length !== line.qty) {
        throw rmaValidation(
          `${at}: a serial-tracked return names one serial per unit — ${trimmed.length} serial number(s) cannot authorize ${line.qty} unit(s).`,
        );
      }
      serialTotal += trimmed.length;
      serialNumbers = trimmed;
    }
    return { orderLineId: line.orderLineId, qty: line.qty, reasonCode, reasonNote, serialNumbers };
  });
  if (serialTotal > MAX_RMA_SERIALS_PER_REQUEST) {
    throw rmaValidation(
      `A return authorization names at most ${MAX_RMA_SERIALS_PER_REQUEST} serial numbers in all (got ${serialTotal}) — split it.`,
    );
  }
  return { externalReference, lines: normalized };
}

/** A cancel reason: trimmed, 1–500 code points (400 otherwise). */
export function normalizeCancelReason(reason: string): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  const length = codePoints(trimmed);
  if (length === 0 || length > MAX_RMA_NOTE) {
    throw rmaValidation(`A cancel reason of 1–${MAX_RMA_NOTE} characters is required (got ${length}).`);
  }
  return trimmed;
}

/**
 * The create fingerprint (the spec's hash): `arm` first, lines in REQUEST
 * order, `qty` canonical (the JSON number the client sent — `2` and `2.0`
 * are one number), serial numbers SORTED (their order changes nothing the
 * command does). Fixed key order — pinned by a golden in
 * `test/returns.spec.ts`.
 */
export function createPayloadHash(tenantId: string, orderId: string, normalized: NormalizedCreate): string {
  return hashCommandPayload({
    arm: 'rma-create',
    tenantId,
    orderId,
    externalReference: normalized.externalReference,
    lines: normalized.lines.map((line) => ({
      orderLineId: line.orderLineId,
      qty: Number(line.qty),
      reasonCode: line.reasonCode,
      reasonNote: line.reasonNote,
      serialNumbers: line.serialNumbers === null ? null : [...line.serialNumbers].sort(),
    })),
  });
}

// ── the returnable computation (behind the order lock on create) ─────────────

type OrderLedgerEvents = Awaited<ReturnType<InventoryFacade['ledgerEventsByOrderRefInTx']>>;

interface ReturnableFacts {
  readonly facts: OrderInvoiceFacts;
  readonly skuFacts: ReadonlyMap<string, SkuFacts>;
  readonly dispatchedAt: string | null;
  /** Per order line, base milli-units. */
  readonly lines: ReadonlyMap<string, ReturnableLineFacts>;
}

interface ReturnableLineFacts {
  readonly orderLineId: string;
  readonly parentLineId: string | null;
  readonly skuId: string;
  readonly kitParent: boolean;
  readonly dispatchedMilli: number;
  readonly authorizedMilli: number;
  readonly returnableMilli: number;
  /** Dispatched serial ids of this line (the ledger's `serial_ref`s). */
  readonly dispatchedSerialIds: readonly string[];
  /** Serial ids already on an uncancelled authorization of this line. */
  readonly authorizedSerialIds: ReadonlySet<string>;
}

/**
 * Story 13-1 — what each line of one order can still be authorized for
 * return, from facts only (nothing stored is a second source of truth):
 *
 * - `dispatched` is Σ `picks.qty` (`orderInvoiceFactsInTx` — the one
 *   definition, reused): dispatch is all-or-nothing and terminal, and picks
 *   are never reversed. An order that is not `dispatched` has dispatched
 *   nothing yet, whatever it picked;
 * - `authorized` is Σ `authorized_qty` over this line on every authorization
 *   that is not cancelled (`RMA_COMMITTED_STATUSES` — story 13-2);
 * - `returnable` is `max(0, dispatched − authorized)`;
 * - the dispatched serials of a line are its `pick.picked` events'
 *   `serial_ref`s (one per serial unit, `orderLineId` in the reference doc),
 *   less those on a non-cancelled authorization.
 *
 * Null when the order is unknown. Run on create UNDER the order lock, so the
 * computed bound is safe against a concurrent create.
 */
export async function returnableFactsInTx(
  tx: TenantTx,
  deps: { readonly outbound: OutboundFacade; readonly catalog: CatalogFacade; readonly inventory: InventoryFacade },
  tenantId: string,
  orderId: string,
): Promise<ReturnableFacts | null> {
  const facts = await deps.outbound.orderInvoiceFactsInTx(tx, tenantId, orderId);
  if (facts === null) {
    return null;
  }
  const dispatched = facts.status === 'dispatched';
  const skuFacts = await deps.catalog.skuFactsInTx(
    tx,
    tenantId,
    facts.lines.map((line) => line.skuId),
  );
  const events: OrderLedgerEvents = dispatched
    ? await deps.inventory.ledgerEventsByOrderRefInTx(tx, tenantId, facts.warehouseId, orderId)
    : [];
  let dispatchedAt: string | null = null;
  const serialsByLine = new Map<string, string[]>();
  for (const event of events) {
    const doc = event.referenceDoc as { readonly orderLineId?: unknown } | null;
    if (event.type === 'dispatch.dispatched') {
      const at = canonicalInstant(event.occurredAt);
      if (dispatchedAt === null || at < dispatchedAt) {
        dispatchedAt = at;
      }
    } else if (event.type === 'pick.picked' && event.serialRef !== null && typeof doc?.orderLineId === 'string') {
      const list = serialsByLine.get(doc.orderLineId) ?? [];
      list.push(event.serialRef);
      serialsByLine.set(doc.orderLineId, list);
    }
  }

  // Σ authorized and the serials named, per order line, over every
  // authorization that still speaks for its units — open, partially received
  // or received (story 13-2; only a cancelled one releases them).
  const authorizedRows = await tx
    .select({
      orderLineId: returnAuthorizationLines.orderLineId,
      authorizedQty: returnAuthorizationLines.authorizedQty,
      serialIds: returnAuthorizationLines.serialIds,
    })
    .from(returnAuthorizationLines)
    .innerJoin(
      returnAuthorizations,
      and(
        eq(returnAuthorizations.id, returnAuthorizationLines.rmaId),
        eq(returnAuthorizations.tenantId, returnAuthorizationLines.tenantId),
      ),
    )
    .where(
      and(
        eq(returnAuthorizations.tenantId, tenantId),
        eq(returnAuthorizations.orderId, orderId),
        inArray(returnAuthorizations.status, [...RMA_COMMITTED_STATUSES]),
      ),
    );
  const authorizedMilli = new Map<string, number>();
  const authorizedSerials = new Map<string, Set<string>>();
  for (const row of authorizedRows) {
    authorizedMilli.set(row.orderLineId, (authorizedMilli.get(row.orderLineId) ?? 0) + Number(row.authorizedQty));
    const set = authorizedSerials.get(row.orderLineId) ?? new Set<string>();
    for (const id of row.serialIds) set.add(id);
    authorizedSerials.set(row.orderLineId, set);
  }

  const parents = new Set(facts.lines.flatMap((line) => (line.parentLineId === null ? [] : [line.parentLineId])));
  const lines = new Map<string, ReturnableLineFacts>();
  for (const line of facts.lines) {
    const kitParent = parents.has(line.orderLineId);
    const dispatchedMilli = dispatched && !kitParent ? line.dispatchedQtyMilli : 0;
    const authorized = authorizedMilli.get(line.orderLineId) ?? 0;
    lines.set(line.orderLineId, {
      orderLineId: line.orderLineId,
      parentLineId: line.parentLineId,
      skuId: line.skuId,
      kitParent,
      dispatchedMilli,
      authorizedMilli: authorized,
      returnableMilli: Math.max(0, dispatchedMilli - authorized),
      dispatchedSerialIds: dispatched && !kitParent ? (serialsByLine.get(line.orderLineId) ?? []) : [],
      authorizedSerialIds: authorizedSerials.get(line.orderLineId) ?? new Set<string>(),
    });
  }
  return { facts, skuFacts, dispatchedAt, lines };
}

/** The returnable read's shape (base units, serials resolved to numbers). Null when the order is unknown. */
export async function readReturnableInTx(
  tx: TenantTx,
  deps: { readonly outbound: OutboundFacade; readonly catalog: CatalogFacade; readonly inventory: InventoryFacade },
  tenantId: string,
  orderId: string,
): Promise<ReturnableOrder | null> {
  const computed = await returnableFactsInTx(tx, deps, tenantId, orderId);
  if (computed === null) {
    return null;
  }
  const isSerial = (skuId: string) => computed.skuFacts.get(skuId)?.serialTracked ?? false;
  const returnableIds = (line: ReturnableLineFacts) => line.dispatchedSerialIds.filter((id) => !line.authorizedSerialIds.has(id));
  // One serial read per SKU over every serial line (the `rmaDetailsInTx` shape).
  const idsBySku = new Map<string, Set<string>>();
  for (const line of computed.lines.values()) {
    if (!isSerial(line.skuId)) continue;
    const set = idsBySku.get(line.skuId) ?? new Set<string>();
    for (const id of returnableIds(line)) set.add(id);
    idsBySku.set(line.skuId, set);
  }
  const numberById = new Map<string, string>();
  for (const [skuId, ids] of idsBySku) {
    for (const serial of await deps.catalog.serialIdentitiesInTx(tx, tenantId, skuId, { ids: [...ids] })) {
      numberById.set(serial.id, serial.serialNumber);
    }
  }
  const lines: ReturnableLine[] = [];
  for (const line of computed.lines.values()) {
    const serialTracked = isSerial(line.skuId);
    const returnableSerials: RmaSerial[] = serialTracked
      ? returnableIds(line)
          .map((id) => ({ id, serialNumber: serialNumberOf(numberById, id) }))
          .sort(bySerialNumber)
      : [];
    lines.push({
      orderLineId: line.orderLineId,
      parentLineId: line.parentLineId,
      skuId: line.skuId,
      kitParent: line.kitParent,
      dispatchedQty: fromMilli(line.dispatchedMilli),
      authorizedQty: fromMilli(line.authorizedMilli),
      returnableQty: fromMilli(line.returnableMilli),
      serialTracked,
      returnableSerials,
    });
  }
  return {
    orderId: computed.facts.orderId,
    status: computed.facts.status,
    warehouseId: computed.facts.warehouseId,
    orderReference: computed.facts.externalEventId,
    dispatchedAt: computed.dispatchedAt,
    lines,
  };
}

// ── the snapshot read ────────────────────────────────────────────────────────

/** The RMA rows as their DTO, serial ids resolved to numbers through the catalog. */
export async function rmaDetailsInTx(
  tx: TenantTx,
  catalog: CatalogFacade,
  tenantId: string,
  headers: readonly ReturnAuthorizationRow[],
): Promise<RmaDetail[]> {
  if (headers.length === 0) {
    return [];
  }
  const lineRows = await tx
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
  // One serial read per SKU over every line that names serials.
  const idsBySku = new Map<string, Set<string>>();
  for (const line of lineRows) {
    if (line.serialIds.length === 0) continue;
    const set = idsBySku.get(line.skuId) ?? new Set<string>();
    for (const id of line.serialIds) set.add(id);
    idsBySku.set(line.skuId, set);
  }
  const numberById = new Map<string, string>();
  for (const [skuId, ids] of idsBySku) {
    for (const serial of await catalog.serialIdentitiesInTx(tx, tenantId, skuId, { ids: [...ids] })) {
      numberById.set(serial.id, serial.serialNumber);
    }
  }
  const linesByRma = new Map<string, ReturnAuthorizationLineRow[]>();
  for (const line of lineRows) {
    const list = linesByRma.get(line.rmaId) ?? [];
    list.push(line);
    linesByRma.set(line.rmaId, list);
  }
  return headers.map((header) => ({
    id: header.id,
    code: header.code,
    status: header.status as RmaStatus,
    orderId: header.orderId,
    orderReference: header.orderReference,
    warehouseId: header.warehouseId,
    clientId: header.clientId,
    externalReference: header.externalReference,
    orderDispatchedAt: canonicalInstant(header.orderDispatchedAt),
    createdAt: canonicalInstant(header.createdAt),
    createdBy: header.createdBy,
    cancelledAt: header.cancelledAt === null ? null : canonicalInstant(header.cancelledAt),
    cancelledBy: header.cancelledBy,
    cancelReason: header.cancelReason,
    lines: (linesByRma.get(header.id) ?? []).map((line) => ({
      id: line.id,
      orderLineId: line.orderLineId,
      skuId: line.skuId,
      authorizedQty: fromMilli(Number(line.authorizedQty)),
      receivedQty: fromMilli(Number(line.receivedQty)),
      reasonCode: line.reasonCode as ReturnReasonCode,
      reasonNote: line.reasonNote,
      serials: line.serialIds.map((id) => ({ id, serialNumber: serialNumberOf(numberById, id) })).sort(bySerialNumber),
    })),
  }));
}

/** A serial id the catalog cannot resolve is a data fault (the ledger and the RMA name only real serials) — never shown as its uuid. */
function serialNumberOf(numberById: ReadonlyMap<string, string>, id: string): string {
  const serialNumber = numberById.get(id);
  if (serialNumber === undefined) {
    throw new Error(`Serial "${id}" is named by the ledger or a return authorization, but the catalog does not hold it.`);
  }
  return serialNumber;
}

function bySerialNumber(a: RmaSerial, b: RmaSerial): number {
  return a.serialNumber < b.serialNumber ? -1 : a.serialNumber > b.serialNumber ? 1 : 0;
}

/** One RMA by id (null when absent or foreign). */
export async function rmaDetailInTx(
  tx: TenantTx,
  catalog: CatalogFacade,
  tenantId: string,
  rmaId: string,
): Promise<RmaDetail | null> {
  const rows = await tx
    .select()
    .from(returnAuthorizations)
    .where(and(eq(returnAuthorizations.tenantId, tenantId), eq(returnAuthorizations.id, rmaId)))
    .limit(1);
  const header = rows[0];
  if (header === undefined) {
    return null;
  }
  return (await rmaDetailsInTx(tx, catalog, tenantId, [header]))[0]!;
}

// ── the commands ─────────────────────────────────────────────────────────────

/**
 * Story 13-1 (FR-46) — return authorizations: an operator authorizes part of a
 * DISPATCHED order for return, naming per line the quantity, the serial
 * numbers of a serial-tracked SKU, and a reason; and may cancel an
 * authorization nothing was received against. No stock moves: an
 * authorization writes no ledger event.
 *
 * Create, on the house skeleton (IMPLEMENTATION-GUIDE §1):
 * shape (above the tx, 400) → hash → `returns.manage` → replay → the ORDER
 * advisory lock → replay again under it (the same-key race: a parked
 * duplicate re-serves the winner's 201) → order facts (404 / 409
 * `order-not-dispatched`) → SKU facts → the ledger (dispatched serials, the
 * dispatch instant) → serial identities → per-line validation → the code
 * (sequence lock) → insert → outbox → audit → key LAST.
 *
 * Other modules are read only through `OutboundFacade`, `InventoryFacade` and
 * `CatalogFacade` (guarded by `test/architecture.spec.ts`).
 */
@Injectable()
export class ReturnAuthorizationCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  async create(input: CreateRmaCommand, idempotencyKey: string): Promise<RmaDetail> {
    // Uuids lowercased before the hash and the lock key (see `canonicalUuid`).
    const command: CreateRmaCommand = { ...input, orderId: canonicalUuid(input.orderId) };
    // 0. Shape — no row needed, so above the transaction (400, never a replay).
    const normalized = normalizeCreate(command);
    // 1. The fingerprint, before the transaction.
    const payloadHash = createPayloadHash(command.tenantId, command.orderId, normalized);

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // 2. Authority first, re-read from the DB.
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'returns.manage');
      // 3. Replay.
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      // 4. The order lock — a create has no row to lock; this serialises
      //    over-authorization AND same-key creates on one order.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${rmaOrderLockKey(command.tenantId, command.orderId)}, 0))`,
      );
      // 5. Replay again UNDER the lock: a same-key duplicate parked here wakes
      //    to the winner's committed key and re-serves its snapshot.
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }

      // 6. The facts (order, SKUs, ledger), computed under the lock.
      const computed = await returnableFactsInTx(
        tx,
        { outbound: this.outbound, catalog: this.catalog, inventory: this.inventory },
        command.tenantId,
        command.orderId,
      );
      if (computed === null) {
        throw orderNotFound(command.orderId);
      }
      if (computed.facts.status !== 'dispatched') {
        throw orderNotDispatched(command.orderId, computed.facts.status);
      }
      if (computed.dispatchedAt === null) {
        // A dispatched order always journals one `dispatch.dispatched` per
        // line (dispatch.command.ts) — no event is a data fault, never a
        // silent "now".
        throw new Error(`Order "${command.orderId}" is dispatched but its ledger holds no dispatch.dispatched event.`);
      }

      // 7. Per-line validation, in the spec's order, each refusal naming its line.
      const lines = await this.validateLines(tx, command.tenantId, command.orderId, normalized.lines, computed);

      // 8. The code, under the tenant's sequence lock (order lock first).
      const code = await this.allocateCode(tx, command.tenantId);

      // 9. The write.
      const rmaId = uuidv7();
      try {
        await tx.insert(returnAuthorizations).values({
          id: rmaId,
          tenantId: command.tenantId,
          clientId: computed.facts.clientId,
          warehouseId: computed.facts.warehouseId,
          orderId: command.orderId,
          orderReference: computed.facts.externalEventId,
          code,
          externalReference: normalized.externalReference,
          status: 'open',
          orderDispatchedAt: computed.dispatchedAt,
          createdBy: command.actorUserId,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, RMA_TENANT_CODE)) {
          // Unreachable beneath the sequence lock; the unique index is the backstop.
          throw new ProblemException('conflict', 409, 'Concurrent return authorization', 'Retry to read the settled result.');
        }
        throw err;
      }
      await tx.insert(returnAuthorizationLines).values(
        lines.map((line, index) => ({
          id: uuidv7(),
          tenantId: command.tenantId,
          rmaId,
          // Request order, 1..n — the read order.
          lineNo: index + 1,
          orderLineId: line.orderLineId,
          skuId: line.skuId,
          authorizedQty: line.authorizedMilli,
          receivedQty: 0,
          reasonCode: line.reasonCode,
          reasonNote: line.reasonNote,
          serialIds: line.serialIds,
        })),
      );

      return this.finish(tx, command.tenantId, command.actorUserId, rmaId, RETURN_AUTHORIZATION_CREATED_EVENT, idempotencyKey, payloadHash);
    });
  }

  /**
   * Cancel an open authorization nothing was received against. Order: hash →
   * `returns.manage` → replay → lock the RMA (`FOR UPDATE`; 404 only — the
   * lock helper never checks status, the `loadOpenPo` lesson) → replay again
   * under it → the status guard (409 `rma-transition-invalid`) → write →
   * outbox → audit → key. Its quantity and serials become returnable again.
   */
  async cancel(input: CancelRmaCommand, idempotencyKey: string): Promise<RmaDetail> {
    const command: CancelRmaCommand = { ...input, rmaId: canonicalUuid(input.rmaId) };
    const reason = normalizeCancelReason(command.reason);
    const payloadHash = hashCommandPayload({
      arm: 'rma-cancel',
      tenantId: command.tenantId,
      rmaId: command.rmaId,
      reason,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'returns.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      const rma = await this.lockRma(tx, command.tenantId, command.rmaId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }
      if (rma.status !== 'open') {
        throw rmaTransitionInvalid(rma.code, rma.status, 'only an open return authorization can be cancelled.');
      }
      const received = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(returnAuthorizationLines)
        .where(
          and(
            eq(returnAuthorizationLines.tenantId, command.tenantId),
            eq(returnAuthorizationLines.rmaId, rma.id),
            sql`${returnAuthorizationLines.receivedQty} > 0`,
          ),
        );
      if (Number(received[0]?.n ?? 0) > 0) {
        throw rmaTransitionInvalid(rma.code, rma.status, 'units were already received against it.');
      }
      const at = nowIso();
      const updated = await tx
        .update(returnAuthorizations)
        .set({ status: 'cancelled', cancelledBy: command.actorUserId, cancelledAt: at, cancelReason: reason, updatedAt: at })
        .where(and(eq(returnAuthorizations.id, rma.id), eq(returnAuthorizations.status, 'open')))
        .returning({ id: returnAuthorizations.id });
      if (updated.length !== 1) {
        // Unreachable beneath the row lock; the conditional write is the backstop.
        throw rmaTransitionInvalid(rma.code, rma.status, 'it moved concurrently.');
      }
      return this.finish(tx, command.tenantId, command.actorUserId, rma.id, RETURN_AUTHORIZATION_CANCELLED_EVENT, idempotencyKey, payloadHash);
    });
  }

  // ── shared pieces ─────────────────────────────────────────────────────────

  private async validateLines(
    tx: TenantTx,
    tenantId: string,
    orderId: string,
    lines: readonly NormalizedRmaLine[],
    computed: ReturnableFacts,
  ): Promise<
    {
      orderLineId: string;
      skuId: string;
      authorizedMilli: number;
      reasonCode: ReturnReasonCode;
      reasonNote: string | null;
      serialIds: string[];
    }[]
  > {
    const out = [];
    for (const [index, line] of lines.entries()) {
      // 1. The order line must belong to the order.
      const facts = computed.lines.get(line.orderLineId);
      if (facts === undefined) {
        throw lineNotOfOrder(index, line.orderLineId, orderId);
      }
      // 2. A kit parent is never returnable; its components are.
      if (facts.kitParent) {
        throw kitParentNotReturnable(index, line.orderLineId);
      }
      const sku = computed.skuFacts.get(facts.skuId);
      if (sku === undefined) {
        throw new Error(`Order line "${line.orderLineId}" names SKU "${facts.skuId}", which the catalog does not hold.`);
      }
      // 3. The quantity at the SKU's UoM precision (the Epic 10 rule).
      const milli = assertRecordableQuantity(line.qty, `lines[${index}].qty`, sku.uom, sku.uomPrecision);
      // A catch-weight SKU is handled by the case — a return of 1.5 cases is
      // a quantity no set of cases can account for (the pick's own refusal,
      // pick.command.ts), whatever the unit's precision allows.
      if (sku.catchWeightTracked && milli % QUANTITY_SCALE !== 0) {
        throw rmaValidation(
          `lines[${index}]: order line "${line.orderLineId}" is catch-weight tracked — a return counts whole cases, and ${line.qty} is not a whole number of them.`,
        );
      }
      // 4. No more than is still returnable.
      if (milli > facts.returnableMilli) {
        throw exceedsReturnable(index, line.orderLineId, line.qty, fromMilli(facts.returnableMilli));
      }
      let serialIds: string[] = [];
      if (sku.serialTracked) {
        // 5. Serial-tracked: the serial numbers are required (one per unit —
        //    the count was matched to qty above the transaction, so qty is
        //    whole), each dispatched on THIS line and not already authorized.
        if (line.serialNumbers === null) {
          throw rmaValidation(
            `lines[${index}]: order line "${line.orderLineId}" is serial-tracked — name the serial number of every unit returned (serialNumbers).`,
          );
        }
        const identities = await this.catalog.serialIdentitiesInTx(tx, tenantId, facts.skuId, {
          numbers: line.serialNumbers,
        });
        const idByNumber = new Map(identities.map((serial) => [serial.serialNumber, serial.id]));
        const dispatched = new Set(facts.dispatchedSerialIds);
        for (const serialNumber of line.serialNumbers) {
          const id = idByNumber.get(serialNumber);
          if (id === undefined || !dispatched.has(id)) {
            throw serialNotDispatched(index, line.orderLineId, serialNumber);
          }
          if (facts.authorizedSerialIds.has(id)) {
            throw serialAlreadyAuthorized(index, line.orderLineId, serialNumber);
          }
        }
        serialIds = line.serialNumbers.map((serialNumber) => idByNumber.get(serialNumber)!);
      } else if (line.serialNumbers !== null) {
        // 6. Any other SKU carries no serial numbers. 7–8: a catch-weight SKU
        //    is authorized by quantity only (13-2 binds the physical cases at
        //    receipt); a batch-tracked SKU names no batch (13-2 binds it at
        //    the scan, against the line's picked batches).
        throw rmaValidation(
          `lines[${index}]: order line "${line.orderLineId}" is not serial-tracked — its return carries no serial numbers.`,
        );
      }
      out.push({
        orderLineId: line.orderLineId,
        skuId: facts.skuId,
        authorizedMilli: milli,
        reasonCode: line.reasonCode,
        reasonNote: line.reasonNote,
        serialIds,
      });
    }
    return out;
  }

  /**
   * The next `RMA-<n>` under the tenant's sequence advisory lock — the
   * `allocateGrnCode` copy: only codes matching `RMA-<1–9 digits>` take the
   * max (a forged or oversized tail is ignored, never a cast 500), and a
   * 5-digit code sorts numerically. The unique `(tenant, code)` index is the
   * backstop.
   */
  private async allocateCode(tx: TenantTx, tenantId: string): Promise<string> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${rmaSequenceLockKey(tenantId)}, 0))`);
    const rows = await tx
      .select({ n: sql<number>`coalesce(max(substring(${returnAuthorizations.code} from '^RMA-([0-9]{1,9})$')::int), 0)` })
      .from(returnAuthorizations)
      .where(eq(returnAuthorizations.tenantId, tenantId));
    return rmaCode(Number(rows[0]?.n ?? 0) + 1);
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

  /** Snapshot → outbox → audit → idempotency key (the skeleton's tail, §1 steps 9–11). */
  private async finish(
    tx: TenantTx,
    tenantId: string,
    actorUserId: string,
    rmaId: string,
    event: typeof RETURN_AUTHORIZATION_CREATED_EVENT | typeof RETURN_AUTHORIZATION_CANCELLED_EVENT,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<RmaDetail> {
    const snapshot = (await rmaDetailInTx(tx, this.catalog, tenantId, rmaId))!;
    const at = nowIso();
    const payload: ReturnAuthorizationEventPayload = {
      rmaId,
      code: snapshot.code,
      orderId: snapshot.orderId,
      warehouseId: snapshot.warehouseId,
      clientId: snapshot.clientId,
    };
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type: event,
      occurredAt: at,
      payload: { ...payload },
    });
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId,
      action: event,
      targetType: 'return_authorization',
      targetId: rmaId,
      reference: idempotencyKey,
      occurredAt: at,
    });
    await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, snapshot);
    return snapshot;
  }

  private async replay(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<RmaDetail | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return row.responseSnapshot as RmaDetail;
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: RmaDetail,
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({
        id: uuidv7(),
        tenantId,
        key: idempotencyKey,
        payloadHash,
        responseSnapshot: snapshot,
      });
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
