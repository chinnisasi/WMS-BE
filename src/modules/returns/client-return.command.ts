import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, clientReturnLines, clientReturns, idempotencyKeys, returnReceiptLines } from '../../shared/db/schema';
import type { ClientReturnLineRow, ClientReturnRow } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { MAX_QUANTITY_BASE, QUANTITY_SCALE, assertRecordableQuantity, fromMilli, signedQuantity } from '../../shared/primitives/quantity';
import { assertUtcIso, istDateOf, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import {
  assertBrandDocumentDateWindow,
  assertConsignmentCaptureShape,
  CONSIGNMENT_CAPTURE_LIMITS,
  gstinStateCode,
  normalizeConsignmentCapture,
  type ConsignmentCaptureInput,
  type NormalizedConsignmentCapture,
} from '../../shared/primitives/consignment-capture';
import { GSTIN_RE, gstinPrefixProblem, normalizeGstinInput } from '../../shared/primitives/gstin';
import { damagedPoolLockKey } from '../../shared/primitives/damaged-pool';
import { assertEwayExemptionShape, normalizeEwayExemption } from '../../shared/primitives/consignment-record';
import { assertReturnEwayRuleInTx, stateCodeOfNameInTx } from '../../shared/eway/return-eway-rule';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { ensureDamagedBinInTx, ensureReturnsBinInTx, findDamagedBinInTx } from '../tenancy/receiving-bin';
import { assertSingleClientInTx, clientPartySnapshotOf, getClientInTx, lockClientInTx, type ClientSnapshot } from '../clients/clients.facade';
import { assertTransporterInTx, type TransporterSnapshotV1 } from '../partners/partners.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import type { SkuFacts } from '../catalog/catalog.facade';
import { uomPrecision } from '../catalog/uom';
import { InventoryFacade } from '../inventory/inventory.facade';
import { openVendorReturnClaimsByArmInTx } from '../inbound/vendor-return-claims';
import { clientReturnArmKey, openClientReturnClaimsByArmInTx } from './client-return-claims';
import {
  RETURN_DISPOSITION_REASONS,
  assertReceiptLineDisposable,
  exceedsAwaiting,
  receiptHeadersInTx,
  type ReceiptHeader,
  type ReturnDispositionReason,
} from './return-disposition.command';
import { assertLinesConservedInTx, dispositionDataFault } from './disposition-split';
import type { ReturnCondition } from './return-receipt.command';
import { CLIENT_RETURN_EVENTS, type ClientReturnEventPayload } from './events';
import {
  RTC_ADDRESS_KINDS,
  RTC_LINE_SOURCES,
  clientReturnNotFound,
  clientReturnViewInTx,
  liveClientReturnWarehouseInTx,
  rmaFactsByIdsInTx,
  type ClientReturnView,
  type ConsigneeAddressV1,
  type RtcAddressKind,
  type RtcItemSnapshotV1,
  type RtcLineSource,
} from './client-return.read';

export { CLIENT_RETURN_STATUSES, RTC_ADDRESS_KINDS, RTC_LINE_SOURCES } from './client-return.read';
export type { ClientReturnStatus, RtcAddressKind, RtcLineSource } from './client-return.read';

export const MAX_RTC_LINES = 200;
/** The header note and the cancel reason, in code points (0113's CHECK). */
export const MAX_RTC_NOTE = 500;
/** A9 — the declared value's ceiling (paise; 0113's CHECK). Story 4-6a (A8): the shared capture limit, re-exported. */
export const MAX_DECLARED_VALUE_PAISE = CONSIGNMENT_CAPTURE_LIMITS.declaredValueMaxPaise;
/** A9 — a line's reason when none is given. */
export const DEFAULT_RTC_REASON: ReturnDispositionReason = 'client-instruction';

/**
 * The command's clock (IMPLEMENTATION-GUIDE §7c): the dispatch's "today in
 * IST" (the brand-document date window) reads it, so a test can move it.
 * Tests ASSIGN `clientReturnClock.now` and restore it.
 */
export const clientReturnClock = { now: (): number => Date.now() };

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const RTC_TENANT_CODE = 'client_returns_tenant_code_unique';

/** The code sequence's advisory-lock key text (the `vendorReturnSequenceLockKey` shape). */
export function clientReturnSequenceLockKey(tenantId: string): string {
  return `${tenantId}:rtc-seq`;
}

/** RTC codes are `RTC-<n>`, zero-padded to 4 digits, unique per tenant. */
export function clientReturnCode(n: number): string {
  return `RTC-${String(n).padStart(4, '0')}`;
}

// ── command inputs ───────────────────────────────────────────────────────────

export interface CreateClientReturnLineInput {
  readonly source: string;
  readonly returnReceiptLineId?: string | null | undefined;
  readonly skuId?: string | null | undefined;
  readonly batchId?: string | null | undefined;
  /** Base units (scaled behind the replay lookup). */
  readonly quantity: number;
  readonly reasonCode?: string | null | undefined;
}

export interface CreateClientReturnCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly consigneeAddress?: string | null | undefined;
  readonly note?: string | null | undefined;
  readonly lines: readonly CreateClientReturnLineInput[];
}

export interface PickClientReturnCommand {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly operatorUserId: string;
  readonly clientReturnId: string;
  readonly warehouseId: string;
  readonly occurredAt: string;
  readonly lines: readonly { readonly lineId: string; readonly pickedQty: number }[];
}

export interface DispatchClientReturnCommand extends Omit<ConsignmentCaptureInput, 'debitNoteNumber'> {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientReturnId: string;
  readonly consigneeGstin?: string | null | undefined;
  readonly declaredValuePaise?: number | null | undefined;
  /** Story 4-6a (A41) — instead of an e-way bill above the threshold; hashed only when sent. */
  readonly ewayExemption?: { readonly reason?: string | null; readonly note?: string | null } | null | undefined;
}

export interface CancelClientReturnCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientReturnId: string;
  readonly reason: string;
}

// ── refusals ─────────────────────────────────────────────────────────────────

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid return to client', detail);
}

function codePoints(value: string): number {
  return [...value].length;
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function armLabel(skuCode: string, batchCode: string | null): string {
  return batchCode === null ? `SKU "${skuCode}"` : `SKU "${skuCode}" batch "${batchCode}"`;
}

function notDraft(code: string, status: string): ProblemException {
  return new ProblemException(
    'rtc-not-draft',
    409,
    'The return to client is not awaiting a pick',
    `${code} is ${status} — only a draft return to client is picked. Nothing was recorded.`,
    { rtcStatus: status },
  );
}

function pickMismatch(detail: string): ProblemException {
  return new ProblemException('rtc-pick-mismatch', 422, "The pick does not match the return's lines", detail);
}

function receiptLineNotFound(id: string): ProblemException {
  return new ProblemException('not-found', 404, 'Return receipt line not found', `No return receipt line with id "${id}" exists in this tenant.`);
}

function skuUnsupported(skuCode: string, what: string): ProblemException {
  return new ProblemException(
    'rtc-sku-unsupported',
    409,
    'This SKU cannot go on a return to client',
    `SKU "${skuCode}" is ${what} — a return to client carries no catch-weight case, no kit and no serial from DAMAGED.`,
    { skuCode },
  );
}

// ── the create's shape (above the transaction) ──────────────────────────────

interface NormalizedCreateLine {
  readonly source: RtcLineSource;
  readonly returnReceiptLineId: string | null;
  readonly skuId: string | null;
  readonly batchId: string | null;
  readonly quantity: number;
  readonly reasonCode: ReturnDispositionReason;
}

export interface NormalizedCreate {
  readonly warehouseId: string;
  readonly consigneeAddress: RtcAddressKind;
  readonly note: string | null;
  readonly lines: readonly NormalizedCreateLine[];
}

/** A1 — the canonical line order: source, then receipt line, SKU and batch, each null-first. */
export function compareRtcLines(a: NormalizedCreateLine, b: NormalizedCreateLine): number {
  return (
    (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
    compareNullable(a.returnReceiptLineId, b.returnReceiptLineId) ||
    compareNullable(a.skuId, b.skuId) ||
    compareNullable(a.batchId, b.batchId)
  );
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw invalid(`${field} must be a uuid, or null.`);
  return value.toLowerCase();
}

/** The create's request shape (400s above the transaction) and its canonical form (A1). */
export function normalizeCreate(command: Omit<CreateClientReturnCommand, 'tenantId' | 'actorUserId'>): NormalizedCreate {
  if (typeof command.warehouseId !== 'string' || !UUID_RE.test(command.warehouseId)) throw invalid('warehouseId must be a uuid.');
  // A1 — the server default is applied BEFORE hashing: absent reads as `return`.
  const consigneeAddress = command.consigneeAddress ?? 'return';
  if (!(RTC_ADDRESS_KINDS as readonly string[]).includes(consigneeAddress)) {
    throw invalid(`consigneeAddress must be one of ${JSON.stringify(RTC_ADDRESS_KINDS)}.`);
  }
  const rawNote = command.note ?? null;
  if (rawNote !== null && typeof rawNote !== 'string') throw invalid('note must be text.');
  const note = rawNote === null || rawNote.trim() === '' ? null : rawNote.trim();
  if (note !== null && codePoints(note) > MAX_RTC_NOTE) throw invalid(`note is at most ${MAX_RTC_NOTE} characters.`);
  if (!Array.isArray(command.lines) || command.lines.length === 0) throw invalid('A return to client names at least one line.');
  if (command.lines.length > MAX_RTC_LINES) {
    throw invalid(`A return to client names at most ${MAX_RTC_LINES} lines (got ${command.lines.length}) — split it.`);
  }
  const lines = command.lines.map((line, index): NormalizedCreateLine => {
    const at = `lines[${index}]`;
    if (!(RTC_LINE_SOURCES as readonly string[]).includes(line.source)) {
      throw invalid(`${at}.source must be one of ${JSON.stringify(RTC_LINE_SOURCES)} (got ${JSON.stringify(line.source)}).`);
    }
    const source = line.source as RtcLineSource;
    const returnReceiptLineId = optionalUuid(line.returnReceiptLineId, `${at}.returnReceiptLineId`);
    const skuId = optionalUuid(line.skuId, `${at}.skuId`);
    const batchId = optionalUuid(line.batchId, `${at}.batchId`);
    if (source === 'returns') {
      if (returnReceiptLineId === null) throw invalid(`${at} is a returns line — name its returnReceiptLineId.`);
      if (skuId !== null || batchId !== null) {
        throw invalid(`${at} is a returns line — its SKU and batch come from the receipt line; send neither skuId nor batchId.`);
      }
    } else {
      if (skuId === null) throw invalid(`${at} is a damaged line — name its skuId (and batchId for a batch-tracked SKU).`);
      if (returnReceiptLineId !== null) throw invalid(`${at} is a damaged line — it names no returnReceiptLineId.`);
    }
    if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw invalid(`${at}.quantity must be above 0.`);
    }
    if (line.quantity > MAX_QUANTITY_BASE) throw invalid(`${at}.quantity is at most ${MAX_QUANTITY_BASE}.`);
    // A9 — the reason is optional and defaults (before hashing) to `client-instruction`.
    const reasonCode = line.reasonCode ?? DEFAULT_RTC_REASON;
    if (!(RETURN_DISPOSITION_REASONS as readonly string[]).includes(reasonCode)) {
      throw invalid(`${at}.reasonCode must be one of ${JSON.stringify(RETURN_DISPOSITION_REASONS)} (got ${JSON.stringify(reasonCode)}).`);
    }
    return { source, returnReceiptLineId, skuId, batchId, quantity: line.quantity, reasonCode: reasonCode as ReturnDispositionReason };
  });
  const sorted = [...lines].sort(compareRtcLines);
  for (let i = 1; i < sorted.length; i += 1) {
    if (compareRtcLines(sorted[i - 1]!, sorted[i]!) === 0) {
      throw invalid(
        sorted[i]!.source === 'returns'
          ? 'Two lines name the same receipt line — merge them into one line.'
          : 'Two damaged lines name the same SKU and batch — merge them into one line.',
      );
    }
  }
  if (note === null && sorted.some((line) => line.reasonCode === 'other')) {
    throw invalid('A line whose reason is "other" needs the note to say why.');
  }
  return { warehouseId: command.warehouseId.toLowerCase(), consigneeAddress: consigneeAddress as RtcAddressKind, note, lines: sorted };
}

/** A1 — the create's fingerprint: the canonical lines with the quantity as sent. */
export function createPayloadHash(tenantId: string, normalized: NormalizedCreate): string {
  return hashCommandPayload({
    tenantId,
    arm: 'rtc-create',
    warehouseId: normalized.warehouseId,
    consigneeAddress: normalized.consigneeAddress,
    lines: normalized.lines.map((line) => ({
      source: line.source,
      returnReceiptLineId: line.returnReceiptLineId,
      skuId: line.skuId,
      batchId: line.batchId,
      quantity: line.quantity,
      reasonCode: line.reasonCode,
    })),
    note: normalized.note,
  });
}

// ── the dispatch's shape (above the transaction) ────────────────────────────

export interface NormalizedRtcDispatch {
  readonly capture: NormalizedConsignmentCapture;
  /** Normalised (trimmed, upper-cased), as SENT — absent is null, never the defaulted value (A1). */
  readonly consigneeGstin: string | null;
  readonly declaredValuePaise: number | null;
  /** Story 4-6a (A41) — the exemption, trimmed (both null when none was sent). */
  readonly ewayExemption?: { readonly reason: string | null; readonly note: string | null };
}

/** The lenient normalize (hashed; never throws). D8 — the RTC carries no debit note. */
export function normalizeRtcDispatch(command: Omit<DispatchClientReturnCommand, 'tenantId' | 'actorUserId' | 'clientReturnId'>): NormalizedRtcDispatch {
  const capture = normalizeConsignmentCapture({ ...command, debitNoteNumber: null });
  const consigneeGstin = typeof command.consigneeGstin === 'string' ? normalizeGstinInput(command.consigneeGstin) : (command.consigneeGstin ?? null);
  return {
    capture,
    consigneeGstin,
    declaredValuePaise: (command.declaredValuePaise ?? null) as number | null,
    ewayExemption: normalizeEwayExemption(command.ewayExemption),
  };
}

/**
 * A1, D8 — the dispatch's fingerprint: its own fixed-order object — every
 * capture key but `debitNoteNumber`, then `consigneeGstin` and
 * `declaredValuePaise` as sent (absent → null).
 */
export function dispatchPayloadHash(tenantId: string, clientReturnId: string, normalized: NormalizedRtcDispatch): string {
  const c = normalized.capture;
  return hashCommandPayload({
    tenantId,
    arm: 'rtc-dispatch',
    clientReturnId,
    brandDocumentType: c.brandDocumentType,
    brandDocumentNumber: c.brandDocumentNumber,
    brandDocumentDate: c.brandDocumentDate,
    consignorGstin: c.consignorGstin,
    ewayBillNumber: c.ewayBillNumber,
    ewayBillDate: c.ewayBillDate,
    ewayValidUntil: c.ewayValidUntil,
    transporterId: c.transporterId === null ? null : String(c.transporterId).toLowerCase(),
    carrierName: c.carrierName,
    vehicleNumber: c.vehicleNumber,
    trackingRef: c.trackingRef,
    packageCount: c.packageCount,
    consigneeGstin: normalized.consigneeGstin,
    declaredValuePaise: normalized.declaredValuePaise,
    // Story 4-6a (A41) — only when sent, so every pre-4-6a body hashes as before (the golden).
    ...(normalized.ewayExemption === undefined || normalized.ewayExemption.reason === null
      ? {}
      : { ewayExemption: { reason: normalized.ewayExemption.reason, note: normalized.ewayExemption.note } }),
  });
}

/** The RTC-only shape rules beside the shared capture's (400 `validation-failed`). */
function assertRtcDispatchExtras(normalized: NormalizedRtcDispatch): void {
  const gstin = normalized.consigneeGstin;
  if (gstin !== null) {
    if (typeof gstin !== 'string' || !GSTIN_RE.test(gstin)) throw invalid('consigneeGstin must be a GSTIN — 2 digits and 13 letters or digits.');
    const prefix = gstinPrefixProblem(gstin);
    if (prefix !== null) throw invalid(`consigneeGstin: ${prefix}.`);
  }
  const value = normalized.declaredValuePaise;
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_DECLARED_VALUE_PAISE)) {
    throw invalid(`declaredValuePaise is a whole number of paise, 0–${MAX_DECLARED_VALUE_PAISE}.`);
  }
  const exemption = normalized.ewayExemption ?? { reason: null, note: null };
  if ((exemption.reason !== null || exemption.note !== null) && normalized.declaredValuePaise === null) {
    throw invalid('ewayExemption goes with a declaredValuePaise — an exemption answers a value above the e-way threshold.');
  }
  assertEwayExemptionShape(exemption.reason, exemption.note, normalized.capture.ewayBillNumber !== null);
}

/** A2 — the frozen consignee address of the chosen kind, or null when the client has none. */
export function consigneeAddressOf(client: ClientSnapshot, kind: RtcAddressKind): ConsigneeAddressV1 | null {
  if (kind === 'return') {
    const address = client.returnAddress;
    if (address === null) return null;
    return {
      v: 1,
      kind,
      contactName: address.contactName,
      phone: address.phone,
      line1: address.line1,
      line2: address.line2 ?? null,
      city: address.city,
      state: address.state,
      // 1-2a stores the return state as free text — no GST state code (PENDING).
      stateCode: null,
      pincode: address.pincode,
    };
  }
  const address = client.registeredAddress;
  if (address === null) return null;
  return {
    v: 1,
    kind,
    contactName: null,
    phone: null,
    line1: address.line1,
    line2: address.line2 ?? null,
    city: address.city,
    state: null,
    stateCode: address.stateCode,
    pincode: address.pincode,
  };
}

/**
 * Decision 12 — THE rule of what a return to client cannot carry, shared by
 * the create and both returnable lists (so the dialog offers exactly what the
 * create accepts): a catch-weight SKU, a kit (by the catalog flag or the kit
 * table), a returned case (a handling-unit receipt line), and from DAMAGED a
 * serial-tracked SKU. Returns why, or null when supported.
 */
export function rtcSkuUnsupported(sku: SkuFacts, isKitFromTable: boolean, source: RtcLineSource, handlingUnit: boolean): string | null {
  if (sku.catchWeightTracked) return 'catch-weight (a returned or damaged case has no shipped-back state)';
  if (isKitFromTable || sku.isKit) return 'a kit';
  if (handlingUnit) return 'a returned case';
  if (source === 'damaged' && sku.serialTracked) return 'serial-tracked (DAMAGED holds no serials)';
  return null;
}

/** One returns line's locked receipt line. */
interface LockedReceiptLine {
  readonly id: string;
  readonly returnReceiptId: string;
  readonly skuId: string;
  readonly openQty: number;
  readonly condition: string;
  readonly batchId: string | null;
  readonly serialId: string | null;
  readonly handlingUnitId: string | null;
}

// ── the command ──────────────────────────────────────────────────────────────

/**
 * Story 4-7c — the return-to-client commands. Each is one transaction in the
 * guide §1 skeleton: shape → hash → capability → replay → locks → replay
 * again → state guards → writes → outbox → audit → key LAST. Every answer is
 * the document's detail (`clientReturnViewInTx`), stored as the snapshot.
 *
 * Lock order (A3, D5): create — the receipt lines read UNLOCKED → the SKUs
 * `FOR SHARE` → the receipt lines `FOR UPDATE` in id order → (replay) → the
 * client `FOR KEY SHARE` → the DAMAGED pool advisory → (replay) → the code
 * sequence advisory. Pick and cancel — the RTC row `FOR UPDATE` → its
 * receipt lines `FOR UPDATE` in id order. Dispatch — the RTC row → the
 * transporter `FOR KEY SHARE` → the DAMAGED pool advisory (a damaged line)
 * → the serial advisories (sorted) → the warehouse advisory (re-entrant
 * with the appends') → the pre-check → the appends. Nothing that holds a
 * receipt line waits on an RTC row, so the two families never cycle.
 */
@Injectable()
export class ClientReturnCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  // ── create ─────────────────────────────────────────────────────────────

  async create(command: CreateClientReturnCommand, idempotencyKey: string): Promise<ClientReturnView> {
    const normalized = normalizeCreate(command);
    const payloadHash = createPayloadHash(command.tenantId, normalized);
    const tenantId = command.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'returns.manage');
      const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      await assertWarehouseInTenant(tx, tenantId, normalized.warehouseId);

      // ── the receipt lines, read UNLOCKED for their SKUs (A3 step 1) ─────
      const returnsLines = normalized.lines.filter((line) => line.source === 'returns');
      const damagedLines = normalized.lines.filter((line) => line.source === 'damaged');
      const receiptLineIds = returnsLines.map((line) => line.returnReceiptLineId!).sort();
      const peek =
        receiptLineIds.length === 0
          ? []
          : await tx
              .select({ id: returnReceiptLines.id, skuId: returnReceiptLines.skuId })
              .from(returnReceiptLines)
              .where(and(eq(returnReceiptLines.tenantId, tenantId), inArray(returnReceiptLines.id, receiptLineIds)));
      const skuOfReceiptLine = new Map(peek.map((row) => [row.id, row.skuId]));
      for (const id of receiptLineIds) {
        if (!skuOfReceiptLine.has(id)) throw receiptLineNotFound(id);
      }

      // ── the SKUs, FOR SHARE (a tracking-flag flip cannot interleave) ────
      const skuIds = [...new Set([...skuOfReceiptLine.values(), ...damagedLines.map((line) => line.skuId!)])].sort();
      const facts = await this.catalog.skuFactsInTx(tx, tenantId, skuIds, { lock: 'share' });
      for (const skuId of skuIds) {
        if (!facts.has(skuId)) throw new ProblemException('not-found', 404, 'SKU not found', `No SKU with id "${skuId}" exists in this tenant.`);
      }

      // ── the receipt lines, FOR UPDATE in id order (A3 step 3) ───────────
      const locked =
        receiptLineIds.length === 0
          ? []
          : await tx
              .select({
                id: returnReceiptLines.id,
                returnReceiptId: returnReceiptLines.returnReceiptId,
                skuId: returnReceiptLines.skuId,
                openQty: returnReceiptLines.openQty,
                condition: returnReceiptLines.condition,
                batchId: returnReceiptLines.batchId,
                serialId: returnReceiptLines.serialId,
                handlingUnitId: returnReceiptLines.handlingUnitId,
              })
              .from(returnReceiptLines)
              .where(and(eq(returnReceiptLines.tenantId, tenantId), inArray(returnReceiptLines.id, receiptLineIds)))
              .orderBy(asc(returnReceiptLines.id))
              .for('update');
      const receiptLines = new Map<string, LockedReceiptLine>(locked.map((row) => [row.id, { ...row, openQty: Number(row.openQty) }]));
      for (const id of receiptLineIds) {
        if (!receiptLines.has(id)) throw receiptLineNotFound(id);
      }
      // A same-key duplicate parked on a line lock replays the winner (§1 step 6).
      const replayedUnderLines = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLines !== null) return replayedUnderLines;

      // ── the header guards of each returns line (D5 — dispose's own) ─────
      const headers = await receiptHeadersInTx(
        tx,
        tenantId,
        locked.map((row) => row.returnReceiptId),
      );
      const headerOf = (lineId: string): ReceiptHeader => {
        const line = receiptLines.get(lineId)!;
        const header = headers.get(line.returnReceiptId);
        if (header === undefined) throw dispositionDataFault(`Return receipt line "${line.id}" names a receipt that does not exist.`);
        return header;
      };
      for (const line of returnsLines) assertReceiptLineDisposable(headerOf(line.returnReceiptLineId!), normalized.warehouseId);

      // ── the SKU rules (decision 12; 2-8b A4's batch rule) ───────────────
      const kits = new Set(await this.catalog.getKitSkuIdsInTx(tx, tenantId, skuIds));
      for (const line of normalized.lines) {
        const skuId = line.source === 'returns' ? receiptLines.get(line.returnReceiptLineId!)!.skuId : line.skuId!;
        const sku = facts.get(skuId)!;
        const why = rtcSkuUnsupported(sku, kits.has(skuId), line.source, line.source === 'returns' && receiptLines.get(line.returnReceiptLineId!)!.handlingUnitId !== null);
        if (why !== null) throw skuUnsupported(sku.code, why);
      }
      for (const line of damagedLines) {
        const sku = facts.get(line.skuId!)!;
        if (sku.batchTracked && line.batchId === null) throw invalid(`SKU "${sku.code}" is batch-tracked — name the batch (its damaged units carry one).`);
        if (!sku.batchTracked && line.batchId !== null) throw invalid(`SKU "${sku.code}" is not batch-tracked — its line names no batch.`);
      }
      const batchIds = [
        ...new Set([
          ...damagedLines.flatMap((line) => (line.batchId === null ? [] : [line.batchId])),
          ...locked.flatMap((row) => (row.batchId === null ? [] : [row.batchId])),
        ]),
      ];
      const batchViews = await this.catalog.batchViewsByIdsInTx(tx, tenantId, batchIds);
      for (const line of damagedLines) {
        if (line.batchId === null) continue;
        const batch = batchViews.get(line.batchId);
        if (batch === undefined || batch.skuId !== line.skuId) {
          throw new ProblemException('not-found', 404, 'Batch not found', `No batch "${line.batchId}" of SKU "${facts.get(line.skuId!)!.code}" exists in this tenant.`);
        }
      }

      // ── the client: from the SKUs (§7b) and the receipts; A8 — no departed refusal ─
      const clientIds = [...skuIds.map((id) => facts.get(id)!.clientId), ...[...headers.values()].map((header) => header.clientId)];
      const clientId = await assertSingleClientInTx(tx, tenantId, clientIds, 'A return to client');
      await lockClientInTx(tx, tenantId, clientId, 'key share');
      const clientRow = await getClientInTx(tx, tenantId, clientId);
      const consigneeAddress = consigneeAddressOf(clientRow, normalized.consigneeAddress);
      if (consigneeAddress === null) {
        throw new ProblemException(
          'client-address-missing',
          409,
          'The client has no such address',
          `Client "${clientRow.code}" has no ${normalized.consigneeAddress === 'return' ? 'return' : 'registered'} address — add it on the client's page, or send the goods to its ${normalized.consigneeAddress === 'return' ? 'registered' : 'return'} address.`,
          { addressKind: normalized.consigneeAddress, clientId },
        );
      }
      const client = clientPartySnapshotOf(clientRow);

      // ── precision (behind the replay lookup) ────────────────────────────
      const lines = normalized.lines.map((line, index) => {
        const skuId = line.source === 'returns' ? receiptLines.get(line.returnReceiptLineId!)!.skuId : line.skuId!;
        const sku = facts.get(skuId)!;
        const milli = assertRecordableQuantity(line.quantity, `lines[${index}].quantity`, sku.uom, sku.uomPrecision);
        const receiptLine = line.source === 'returns' ? receiptLines.get(line.returnReceiptLineId!)! : null;
        return {
          ...line,
          skuId,
          batchId: receiptLine === null ? line.batchId : receiptLine.batchId,
          serialId: receiptLine?.serialId ?? null,
          sku,
          milli,
          receiptLine,
        };
      });

      // ── the returns lines: the open quantity, a serial whole (decision 5) ─
      for (const line of lines) {
        if (line.receiptLine === null) continue;
        const header = headerOf(line.receiptLine.id);
        if (line.serialId !== null && line.milli !== QUANTITY_SCALE) {
          throw invalid(`The receipt line of "${header.code}" is one serial unit — it returns whole (quantity 1).`);
        }
        if (line.milli > line.receiptLine.openQty) {
          throw exceedsAwaiting(
            `Return receipt line of "${header.code}" has ${fromMilli(line.receiptLine.openQty)} ${line.sku.uom} awaiting disposition — the return to client names ${fromMilli(line.milli)}.`,
            line.receiptLine.openQty,
          );
        }
      }

      // ── the DAMAGED pool: one advisory, the on-hand, RTV + RTC claims ───
      const damaged = lines.filter((line) => line.source === 'damaged');
      if (damaged.length > 0) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${damagedPoolLockKey(tenantId, normalized.warehouseId)}, 0))`);
        // A same-key duplicate parked on the pool lock replays the winner's answer.
        const replayedUnderPool = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
        if (replayedUnderPool !== null) return replayedUnderPool;
        const damagedSkuIds = [...new Set(damaged.map((line) => line.skuId))];
        const bin = await findDamagedBinInTx(tx, tenantId, normalized.warehouseId);
        const arms = bin === null ? [] : await this.inventory.damagedArmsInTx(tx, tenantId, normalized.warehouseId, bin.binId, { skuIds: damagedSkuIds });
        const onHand = new Map(arms.map((arm) => [clientReturnArmKey(arm.skuId, arm.batchId), arm.quantity]));
        const rtvClaims = await openVendorReturnClaimsByArmInTx(tx, tenantId, normalized.warehouseId, damagedSkuIds);
        const rtcClaims = await openClientReturnClaimsByArmInTx(tx, tenantId, normalized.warehouseId, damagedSkuIds);
        for (const line of damaged) {
          const key = clientReturnArmKey(line.skuId, line.batchId);
          const have = onHand.get(key) ?? 0;
          const rtv = rtvClaims.get(key);
          const rtc = rtcClaims.get(key);
          const claimed = (rtv?.claimedMilli ?? 0) + (rtc?.claimedMilli ?? 0);
          if (line.milli + claimed > have) {
            const batchCode = line.batchId === null ? null : (batchViews.get(line.batchId)?.code ?? line.batchId);
            const available = Math.max(0, have - claimed);
            const codes = [...(rtv?.codes ?? []), ...(rtc?.codes ?? [])].sort();
            throw new ProblemException(
              'rtc-exceeds-damaged',
              409,
              'More than DAMAGED holds for the return',
              `${armLabel(line.sku.code, batchCode)}: DAMAGED holds ${fromMilli(have)} ${line.sku.uom}${claimed > 0 ? `, of which ${fromMilli(claimed)} ${line.sku.uom} are already claimed by ${codes.join(', ')}` : ''} — at most ${fromMilli(available)} ${line.sku.uom} can go on a new return (asked ${fromMilli(line.milli)}).`,
              {
                skuId: line.skuId,
                batchId: line.batchId,
                onHandQty: fromMilli(have),
                claimedQty: fromMilli(claimed),
                availableQty: fromMilli(available),
                requestedQty: fromMilli(line.milli),
              },
            );
          }
        }
      }

      // ── the frozen line identity (decision 7, A9) ───────────────────────
      const hsn = await this.catalog.getSkuHsnByIdsInTx(tx, tenantId, skuIds);
      const serialNumbers = await this.catalog.serialNumbersByIdsInTx(
        tx,
        tenantId,
        lines.flatMap((line) => (line.serialId === null ? [] : [line.serialId])),
      );
      const rmaIds = [...new Set(lines.flatMap((line) => (line.receiptLine === null ? [] : [headerOf(line.receiptLine.id).rmaId])))];
      const rmas = await rmaFactsByIdsInTx(tx, tenantId, rmaIds);
      const items = lines.map((line): RtcItemSnapshotV1 => {
        const batch = line.batchId === null ? undefined : batchViews.get(line.batchId);
        const rmaId = line.receiptLine === null ? null : headerOf(line.receiptLine.id).rmaId;
        const rma = rmaId === null ? undefined : rmas.get(rmaId);
        return {
          skuCode: line.sku.code,
          name: line.sku.name,
          hsn: hsn.get(line.skuId) ?? null,
          uom: line.sku.uom,
          batchCode: batch?.code ?? null,
          batchExpiry: batch?.expiryDate ?? null,
          serialNumber: line.serialId === null ? null : (serialNumbers.get(line.serialId) ?? null),
          rmaCode: rma?.code ?? null,
          condition: line.receiptLine === null ? null : (line.receiptLine.condition as ReturnCondition),
          orderReference: rma?.orderReference ?? null,
        };
      });

      // ── the code, the rows, the claim on the receipt lines ──────────────
      const code = await this.allocateCode(tx, tenantId);
      const id = uuidv7();
      const at = nowIso();
      try {
        await tx.insert(clientReturns).values({
          id,
          tenantId,
          clientId,
          warehouseId: normalized.warehouseId,
          code,
          status: 'draft',
          clientSnapshot: client,
          consigneeAddressKind: normalized.consigneeAddress,
          consigneeAddress,
          note: normalized.note,
          createdBy: command.actorUserId,
          createdAt: at,
          updatedAt: at,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, RTC_TENANT_CODE)) {
          // Unreachable beneath the sequence lock; the unique index is the backstop.
          throw new ProblemException('conflict', 409, 'Return code collision', 'Another return to client took this code concurrently — retry.');
        }
        throw err;
      }
      await tx.insert(clientReturnLines).values(
        lines.map((line, index) => ({
          id: uuidv7(),
          tenantId,
          clientReturnId: id,
          lineNo: index + 1,
          source: line.source,
          skuId: line.skuId,
          batchId: line.batchId,
          serialId: line.serialId,
          returnReceiptLineId: line.receiptLine?.id ?? null,
          rmaId: line.receiptLine === null ? null : headerOf(line.receiptLine.id).rmaId,
          qty: line.milli,
          pickedQty: null,
          reasonCode: line.reasonCode,
          itemSnapshot: items[index]!,
          createdAt: at,
          updatedAt: at,
        })),
      );
      // Decision 5 — the claim leaves the receipt line's open quantity, in
      // this transaction, under the line lock (0097's `0 ≤ open_qty` CHECK
      // is the backstop beneath the guard above).
      for (const line of lines) {
        if (line.receiptLine === null) continue;
        await tx
          .update(returnReceiptLines)
          .set({ openQty: sql`${returnReceiptLines.openQty} - ${line.milli}::bigint` })
          .where(and(eq(returnReceiptLines.tenantId, tenantId), eq(returnReceiptLines.id, line.receiptLine.id)));
      }
      await assertLinesConservedInTx(tx, tenantId, receiptLineIds);

      const view = await clientReturnViewInTx(tx, tenantId, id);
      await this.emit(tx, tenantId, CLIENT_RETURN_EVENTS.created, view, at);
      await this.audit(tx, tenantId, command.actorUserId, CLIENT_RETURN_EVENTS.created, id, idempotencyKey);
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, view);
      return view;
    });
  }

  // ── pick (the handheld) ────────────────────────────────────────────────

  async pick(command: PickClientReturnCommand, idempotencyKey: string): Promise<ClientReturnView> {
    // ── shape, above the transaction ────────────────────────────────────
    if (!UUID_RE.test(command.clientReturnId)) throw invalid('The return id must be a uuid.');
    if (!UUID_RE.test(command.warehouseId)) throw invalid('warehouseId must be a uuid.');
    if (typeof command.occurredAt !== 'string') throw invalid('occurredAt is required (ISO-8601 UTC).');
    try {
      assertUtcIso(command.occurredAt);
    } catch {
      throw invalid('occurredAt must be an ISO-8601 UTC instant (…Z).');
    }
    if (!Array.isArray(command.lines) || command.lines.length === 0) throw invalid('The pick names every line of the return.');
    if (command.lines.length > MAX_RTC_LINES) throw invalid(`A pick names at most ${MAX_RTC_LINES} lines.`);
    const picks = command.lines.map((line, index) => {
      if (typeof line.lineId !== 'string' || !UUID_RE.test(line.lineId)) throw invalid(`lines[${index}].lineId must be a uuid.`);
      if (typeof line.pickedQty !== 'number' || !Number.isFinite(line.pickedQty) || line.pickedQty < 0) {
        throw invalid(`lines[${index}].pickedQty must be 0 or more.`);
      }
      return { lineId: line.lineId.toLowerCase(), pickedQty: line.pickedQty };
    });
    picks.sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));
    for (let i = 1; i < picks.length; i += 1) {
      if (picks[i - 1]!.lineId === picks[i]!.lineId) throw invalid('The pick names a line twice.');
    }
    const occurredAt = command.occurredAt;
    const clientReturnId = command.clientReturnId.toLowerCase();
    // A1 — the pick's fingerprint.
    const payloadHash = hashCommandPayload({ tenantId: command.tenantId, arm: 'rtc-pick', clientReturnId, lines: picks, occurredAt });
    const tenantId = command.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertDeviceOperatorInTx(tx, tenantId, command.deviceId, command.operatorUserId);
      assertPermission(await getMemberRoleIn(tx, tenantId, command.operatorUserId), 'picks.execute');
      const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      // Another warehouse's RTC is not this device's to see: 404.
      const row = await this.lockClientReturn(tx, tenantId, clientReturnId);
      if (row.warehouseId !== command.warehouseId.toLowerCase()) throw clientReturnNotFound(clientReturnId);
      const replayedUnderLock = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (row.status !== 'draft') throw notDraft(row.code, row.status);

      const lines = await this.linesOf(tx, tenantId, row.id);
      const byId = new Map(lines.map((line) => [line.id, line]));
      if (picks.length !== lines.length || picks.some((pick) => !byId.has(pick.lineId))) {
        throw pickMismatch(`The pick must name every line of ${row.code} exactly once (it has ${lines.length}) — reload the return and pick it again.`);
      }
      const scaled = picks.map((pick, index) => {
        const line = byId.get(pick.lineId)!;
        const item = line.itemSnapshot as RtcItemSnapshotV1;
        const milli = pick.pickedQty === 0 ? 0 : assertRecordableQuantity(pick.pickedQty, `lines[${index}].pickedQty`, item.uom, uomPrecision(item.uom));
        if (milli > line.qty) {
          throw pickMismatch(`Line ${line.lineNo} (${item.skuCode}) asks ${fromMilli(line.qty)} ${item.uom} — ${pick.pickedQty} cannot be picked against it.`);
        }
        if (line.serialId !== null && milli !== 0 && milli !== QUANTITY_SCALE) {
          throw pickMismatch(`Line ${line.lineNo} (${item.skuCode}) is one serial unit — it is picked 0 or 1.`);
        }
        return { line, milli };
      });
      if (scaled.every((entry) => entry.milli === 0)) {
        throw new ProblemException(
          'rtc-pick-empty',
          422,
          'Nothing was picked',
          `Every line of ${row.code} was picked 0 — nothing to send back. Cancel the return on the web instead.`,
        );
      }

      // ── a short pick returns the rest to awaiting disposition (decision 5) ─
      const receiptLineIds = await this.lockReceiptLinesOf(tx, tenantId, lines);
      const at = nowIso();
      for (const entry of scaled) {
        await tx
          .update(clientReturnLines)
          .set({ pickedQty: entry.milli, updatedAt: at })
          .where(and(eq(clientReturnLines.id, entry.line.id), eq(clientReturnLines.tenantId, tenantId)));
        const released = entry.line.qty - entry.milli;
        if (entry.line.returnReceiptLineId !== null && released > 0) {
          await tx
            .update(returnReceiptLines)
            .set({ openQty: sql`${returnReceiptLines.openQty} + ${released}::bigint` })
            .where(and(eq(returnReceiptLines.tenantId, tenantId), eq(returnReceiptLines.id, entry.line.returnReceiptLineId)));
        }
      }
      const updated = await tx
        .update(clientReturns)
        .set({ status: 'picked', pickedBy: command.operatorUserId, pickedAt: occurredAt, pickedDeviceId: command.deviceId, updatedAt: at })
        .where(and(eq(clientReturns.id, row.id), eq(clientReturns.status, 'draft')))
        .returning({ id: clientReturns.id });
      if (updated.length === 0) throw notDraft(row.code, 'closed');
      await assertLinesConservedInTx(tx, tenantId, receiptLineIds);
      await touchDeviceInTx(tx, command.deviceId);

      const view = await clientReturnViewInTx(tx, tenantId, row.id);
      await this.emit(tx, tenantId, CLIENT_RETURN_EVENTS.picked, view, at);
      // The 3-2b rule: a handheld op's audit stamps the server clock.
      await this.audit(tx, tenantId, command.operatorUserId, CLIENT_RETURN_EVENTS.picked, row.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, view);
      return view;
    });
  }

  // ── dispatch (the web) ─────────────────────────────────────────────────

  async dispatch(command: DispatchClientReturnCommand, idempotencyKey: string): Promise<ClientReturnView> {
    if (!UUID_RE.test(command.clientReturnId)) throw invalid('The return id must be a uuid.');
    const normalized = normalizeRtcDispatch(command);
    const valid = assertConsignmentCaptureShape(normalized.capture);
    assertRtcDispatchExtras(normalized);
    const clientReturnId = command.clientReturnId.toLowerCase();
    const payloadHash = dispatchPayloadHash(command.tenantId, clientReturnId, normalized);
    const tenantId = command.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'dispatch.execute');
      const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      const row = await this.lockClientReturn(tx, tenantId, clientReturnId);
      const replayedUnderLock = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (row.status !== 'picked') {
        throw new ProblemException(
          'rtc-not-picked',
          409,
          'The return to client is not picked',
          row.status === 'draft'
            ? `${row.code} has not been picked yet — pick it on the handheld first (the pick scan-verifies the units).`
            : `${row.code} is ${row.status} — only a picked return to client is dispatched.`,
          { rtcStatus: row.status },
        );
      }

      // ── the time rule, behind the replay lookup (D8) ────────────────────
      // §7m — ONE clock reading: the date window, `dispatched_at` and the ledger's business time.
      const at = new Date(clientReturnClock.now()).toISOString();
      assertBrandDocumentDateWindow(valid.brandDocumentDate, istDateOf(row.createdAt), istDateOf(at));
      // ── story 4-6a (A22, A41): the declared value is judged against the
      // e-way threshold for the movement — from the warehouse's state (else
      // the consignor's, else the frozen brand's) to the consignee's (its
      // frozen address's state, else the consignee GSTIN's prefix).
      const exemption = normalized.ewayExemption ?? { reason: null, note: null };
      const warehouseNow = await liveClientReturnWarehouseInTx(tx, tenantId, row.warehouseId);
      const frozenClient = row.clientSnapshot as { gstin?: string | null };
      const consignee = row.consigneeAddress as ConsigneeAddressV1;
      await assertReturnEwayRuleInTx(tx, tenantId, {
        declaredValuePaise: normalized.declaredValuePaise,
        fromState: gstinStateCode(warehouseNow.gstin) ?? gstinStateCode(valid.consignorGstin) ?? gstinStateCode(frozenClient.gstin ?? null),
        toState: consignee.stateCode ?? (await stateCodeOfNameInTx(tx, consignee.state)) ?? gstinStateCode(normalized.consigneeGstin ?? frozenClient.gstin ?? null),
        documentDate: valid.brandDocumentDate,
        todayIst: istDateOf(at),
        ewayBillNumber: valid.ewayBillNumber,
        ewayValidUntil: valid.ewayValidUntil,
        exempt: exemption.reason !== null,
      });
      // ── the transporter, frozen (when one is named) ─────────────────────
      const transporter: TransporterSnapshotV1 | null =
        valid.transporterId === null ? null : await assertTransporterInTx(tx, tenantId, valid.transporterId, 'a return-to-client dispatch');
      // A8 — the client's status is deliberately NOT re-checked: the goods go
      // to their owner whatever its status (the web warns when suspended).

      const lines = await this.linesOf(tx, tenantId, row.id);
      const shipping = lines.filter((line) => (line.pickedQty ?? 0) > 0).sort((a, b) => a.lineNo - b.lineNo);
      const fromDamaged = shipping.filter((line) => line.source === 'damaged');
      const fromReturns = shipping.filter((line) => line.source === 'returns');

      // ── the locks: the DAMAGED pool, the serials, the warehouse advisory ─
      if (fromDamaged.length > 0) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${damagedPoolLockKey(tenantId, row.warehouseId)}, 0))`);
      }
      const serialIds = [...new Set(shipping.flatMap((line) => (line.serialId === null ? [] : [line.serialId])))].sort();
      await this.inventory.lockSerialsInTx(tx, tenantId, serialIds);
      await this.inventory.lockWarehouseInTx(tx, tenantId, row.warehouseId);
      const damagedBin = fromDamaged.length > 0 ? await ensureDamagedBinInTx(tx, tenantId, row.warehouseId) : null;
      const returnsBin = fromReturns.length > 0 ? await ensureReturnsBinInTx(tx, tenantId, row.warehouseId) : null;

      // ── a reconcile quarantine on RETURNS or DAMAGED stops the shipment (A12) ─
      for (const [bin, group, area] of [
        [returnsBin, fromReturns, 'RETURNS'],
        [damagedBin, fromDamaged, 'DAMAGED'],
      ] as const) {
        if (bin === null) continue;
        for (const skuId of [...new Set(group.map((line) => line.skuId))]) {
          const quarantined = await this.inventory.openQuarantinedBinsInTx(tx, tenantId, row.warehouseId, skuId, [bin.binId]);
          if (quarantined.length > 0) {
            const item = group.find((line) => line.skuId === skuId)!.itemSnapshot as RtcItemSnapshotV1;
            throw new ProblemException(
              'disposition-scope-quarantined',
              409,
              'The stock is under a reconcile quarantine',
              `SKU "${item.skuCode}" in ${area} is quarantined by reconciliation — its count is not trusted, so nothing moves out of it; resolve the quarantine first. Nothing was dispatched.`,
            );
          }
        }
      }

      // ── the pre-check, per arm, under the locks (decision 11) ───────────
      for (const [bin, group, area] of [
        [damagedBin, fromDamaged, 'DAMAGED'],
        [returnsBin, fromReturns, 'RETURNS'],
      ] as const) {
        if (bin === null) continue;
        const arms = await this.inventory.damagedArmsInTx(tx, tenantId, row.warehouseId, bin.binId, { skuIds: [...new Set(group.map((line) => line.skuId))] });
        const onHand = new Map(arms.map((arm) => [clientReturnArmKey(arm.skuId, arm.batchId), arm.quantity]));
        const needed = new Map<string, { milli: number; item: RtcItemSnapshotV1 }>();
        for (const line of group) {
          const key = clientReturnArmKey(line.skuId, line.batchId);
          needed.set(key, { milli: (needed.get(key)?.milli ?? 0) + (line.pickedQty ?? 0), item: line.itemSnapshot as RtcItemSnapshotV1 });
        }
        for (const [key, entry] of needed) {
          const have = onHand.get(key) ?? 0;
          if (entry.milli <= have) continue;
          if (area === 'RETURNS') {
            // Conservation keeps every RETURNS claim covered — reaching here is a data fault.
            throw dispositionDataFault(
              `${row.code} ships ${fromMilli(entry.milli)} ${entry.item.uom} of ${armLabel(entry.item.skuCode, entry.item.batchCode)} from RETURNS, which holds ${fromMilli(have)}.`,
            );
          }
          throw new ProblemException(
            'rtc-damaged-short',
            409,
            'DAMAGED no longer holds the picked units',
            `${armLabel(entry.item.skuCode, entry.item.batchCode)}: ${row.code} ships ${fromMilli(entry.milli)} ${entry.item.uom} but DAMAGED holds ${fromMilli(have)} — units were taken out of DAMAGED after the return was created. Cancel the return and create it again for what is there. Nothing was dispatched.`,
            { skuCode: entry.item.skuCode, batchCode: entry.item.batchCode, onHandQty: fromMilli(have), pickedQty: fromMilli(entry.milli) },
          );
        }
      }

      // ── the ledger: one rtc.dispatched draw per picked line (per serial unit) ─
      for (const line of shipping) {
        const fromBinId = line.source === 'returns' ? returnsBin!.binId : damagedBin!.binId;
        await this.inventory.appendLedgerEventInTx(tx, {
          tenantId,
          warehouseId: row.warehouseId,
          type: 'rtc.dispatched',
          skuId: line.skuId,
          // A serial line is one unit (0113's CHECK): magnitude 1, its serial arm.
          quantityDelta: signedQuantity(-(line.pickedQty ?? 0)),
          fromBinId,
          toBinId: null,
          batchRef: line.batchId,
          serialRef: line.serialId,
          actorUserId: command.actorUserId,
          occurredAt: at,
          recordedAt: at,
          // The RETURNS keys only on a returns line — omitted, never null (§4).
          referenceDoc: {
            kind: 'client-return',
            clientReturnId: row.id,
            clientReturnLineId: line.id,
            ...(line.returnReceiptLineId === null ? {} : { returnReceiptLineId: line.returnReceiptLineId }),
            ...(line.rmaId === null ? {} : { rmaId: line.rmaId }),
          },
        });
      }

      // ── the dispatch, frozen (D7 — the warehouse too) ───────────────────
      const warehouse = await liveClientReturnWarehouseInTx(tx, tenantId, row.warehouseId);
      const updated = await tx
        .update(clientReturns)
        .set({
          status: 'dispatched',
          dispatchedBy: command.actorUserId,
          dispatchedAt: at,
          brandDocumentType: valid.brandDocumentType,
          brandDocumentNumber: valid.brandDocumentNumber,
          brandDocumentDate: valid.brandDocumentDate,
          consignorGstin: valid.consignorGstin,
          consigneeGstin: normalized.consigneeGstin,
          declaredValuePaise: normalized.declaredValuePaise,
          ewayBillNumber: valid.ewayBillNumber,
          ewayBillDate: valid.ewayBillDate,
          ewayValidUntil: valid.ewayValidUntil,
          transporterId: valid.transporterId === null ? null : valid.transporterId.toLowerCase(),
          transporterSnapshot: transporter,
          carrierName: valid.carrierName,
          trackingRef: valid.trackingRef,
          vehicleNumber: valid.vehicleNumber,
          packageCount: valid.packageCount,
          warehouseSnapshot: warehouse,
          updatedAt: at,
        })
        .where(and(eq(clientReturns.id, row.id), eq(clientReturns.status, 'picked')))
        .returning({ id: clientReturns.id });
      if (updated.length === 0) {
        // Unreachable under the row lock; refuse rather than ship twice.
        throw new ProblemException('rtc-not-picked', 409, 'The return to client is not picked', `${row.code} changed while it was being dispatched — reload it.`);
      }

      const view = await clientReturnViewInTx(tx, tenantId, row.id);
      await this.emit(tx, tenantId, CLIENT_RETURN_EVENTS.dispatched, view, at);
      // Story 4-6a (A41) — the audit row says when the threshold was not judged, and names an exemption.
      await this.audit(tx, tenantId, command.actorUserId, CLIENT_RETURN_EVENTS.dispatched, row.id, idempotencyKey, {
        ...(normalized.declaredValuePaise === null ? { ewayUnjudged: true } : { declaredValuePaise: normalized.declaredValuePaise }),
        ...(exemption.reason === null ? {} : { ewayExemption: { reason: exemption.reason, note: exemption.note } }),
      });
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, view);
      return view;
    });
  }

  // ── cancel ─────────────────────────────────────────────────────────────

  async cancel(command: CancelClientReturnCommand, idempotencyKey: string): Promise<ClientReturnView> {
    if (!UUID_RE.test(command.clientReturnId)) throw invalid('The return id must be a uuid.');
    const reason = typeof command.reason === 'string' ? command.reason.trim() : '';
    if (reason === '') throw invalid('reason is required — say why the return is cancelled.');
    if (codePoints(reason) > MAX_RTC_NOTE) throw invalid(`reason is at most ${MAX_RTC_NOTE} characters.`);
    const clientReturnId = command.clientReturnId.toLowerCase();
    const payloadHash = hashCommandPayload({ tenantId: command.tenantId, arm: 'rtc-cancel', clientReturnId, reason });
    const tenantId = command.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'returns.manage');
      const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const row = await this.lockClientReturn(tx, tenantId, clientReturnId);
      const replayedUnderLock = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (row.status !== 'draft' && row.status !== 'picked') {
        throw new ProblemException(
          'rtc-closed',
          409,
          'The return to client is closed',
          `${row.code} is ${row.status} — ${row.status === 'dispatched' ? 'the goods have left; a dispatched return is not cancelled' : 'it is already cancelled'}.`,
          { rtcStatus: row.status },
        );
      }
      const lines = await this.linesOf(tx, tenantId, row.id);
      const receiptLineIds = await this.lockReceiptLinesOf(tx, tenantId, lines);
      const at = nowIso();
      // The whole remaining claim goes back to awaiting disposition.
      for (const line of lines) {
        if (line.returnReceiptLineId === null) continue;
        const claim = row.status === 'draft' ? line.qty : (line.pickedQty ?? 0);
        if (claim <= 0) continue;
        await tx
          .update(returnReceiptLines)
          .set({ openQty: sql`${returnReceiptLines.openQty} + ${claim}::bigint` })
          .where(and(eq(returnReceiptLines.tenantId, tenantId), eq(returnReceiptLines.id, line.returnReceiptLineId)));
      }
      const updated = await tx
        .update(clientReturns)
        .set({ status: 'cancelled', cancelledBy: command.actorUserId, cancelledAt: at, cancelReason: reason, updatedAt: at })
        .where(and(eq(clientReturns.id, row.id), eq(clientReturns.status, row.status)))
        .returning({ id: clientReturns.id });
      if (updated.length === 0) {
        throw new ProblemException('rtc-closed', 409, 'The return to client is closed', `${row.code} changed while it was being cancelled — reload it.`);
      }
      await assertLinesConservedInTx(tx, tenantId, receiptLineIds);
      const view = await clientReturnViewInTx(tx, tenantId, row.id);
      await this.emit(tx, tenantId, CLIENT_RETURN_EVENTS.cancelled, view, at);
      await this.audit(tx, tenantId, command.actorUserId, CLIENT_RETURN_EVENTS.cancelled, row.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, view);
      return view;
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /** Lock + 404 only — never a status check (§1, the `loadOpenPo` lesson). */
  private async lockClientReturn(tx: TenantTx, tenantId: string, id: string): Promise<ClientReturnRow> {
    const rows = await tx
      .select()
      .from(clientReturns)
      .where(and(eq(clientReturns.tenantId, tenantId), eq(clientReturns.id, id)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (row === undefined) throw clientReturnNotFound(id);
    return row;
  }

  private async linesOf(tx: TenantTx, tenantId: string, clientReturnId: string): Promise<ClientReturnLineRow[]> {
    return tx
      .select()
      .from(clientReturnLines)
      .where(and(eq(clientReturnLines.tenantId, tenantId), eq(clientReturnLines.clientReturnId, clientReturnId)));
  }

  /** The returns lines' receipt lines, `FOR UPDATE` in id order (after the RTC row); their ids. */
  private async lockReceiptLinesOf(tx: TenantTx, tenantId: string, lines: readonly ClientReturnLineRow[]): Promise<string[]> {
    const ids = [...new Set(lines.flatMap((line) => (line.returnReceiptLineId === null ? [] : [line.returnReceiptLineId])))].sort();
    if (ids.length === 0) return [];
    const locked = await tx
      .select({ id: returnReceiptLines.id })
      .from(returnReceiptLines)
      .where(and(eq(returnReceiptLines.tenantId, tenantId), inArray(returnReceiptLines.id, ids)))
      .orderBy(asc(returnReceiptLines.id))
      .for('update');
    if (locked.length !== ids.length) throw dispositionDataFault('A return-to-client line names a receipt line that does not exist.');
    return ids;
  }

  /** The next `RTC-<n>` under the tenant's sequence advisory (the `allocateCode` copy). */
  private async allocateCode(tx: TenantTx, tenantId: string): Promise<string> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${clientReturnSequenceLockKey(tenantId)}, 0))`);
    const rows = await tx
      .select({ n: sql<number>`coalesce(max(substring(${clientReturns.code} from '^RTC-([0-9]{1,9})$')::int), 0)` })
      .from(clientReturns)
      .where(eq(clientReturns.tenantId, tenantId));
    return clientReturnCode(Number(rows[0]?.n ?? 0) + 1);
  }

  /** A13 — the outbox event (no consumer until 4-7e): flat ids and counts, no PII. */
  private async emit(tx: TenantTx, tenantId: string, type: string, view: ClientReturnView, at: string): Promise<void> {
    const payload: ClientReturnEventPayload = {
      clientReturnId: view.id,
      code: view.code,
      clientId: view.clientId,
      warehouseId: view.warehouseId,
      status: view.status,
      lineCount: view.lines.length,
      qty: String(view.totalPickedQuantity ?? view.totalQuantity),
      ...(view.dispatch?.trackingRef ? { trackingRef: view.dispatch.trackingRef } : {}),
    };
    await this.outbox.append(tx, { messageId: uuidv7(), tenantId, type, occurredAt: at, payload: { ...payload } });
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    actorUserId: string,
    action: string,
    targetId: string,
    idempotencyKey: string,
    changes?: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId,
      action,
      targetType: 'client_return',
      targetId,
      reference: idempotencyKey,
      ...(changes === undefined ? {} : { changes }),
      occurredAt: nowIso(),
    });
  }

  private async replay(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<ClientReturnView | null> {
    const rows = await tx
      .select({ payloadHash: idempotencyKeys.payloadHash, responseSnapshot: idempotencyKeys.responseSnapshot })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot as ClientReturnView;
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
