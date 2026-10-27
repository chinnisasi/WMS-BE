import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  idempotencyKeys,
  returnAuthorizations,
  returnDispositions,
  returnReceiptLines,
  returnReceipts,
} from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { MAX_QUANTITY_BASE, QUANTITY_SCALE, fromMilli, signedQuantity, validateRecordableQuantity } from '../../shared/primitives/quantity';
import { assertUtcIso, nowIso } from '../../shared/primitives/time';
import { isBatchExpiredAt } from '../../shared/primitives/batch-expiry';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { ensureReturnsBinInTx } from '../tenancy/receiving-bin';
import { CatalogFacade } from '../catalog/catalog.facade';
import type { SkuFacts } from '../catalog/catalog.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { LedgerMovement } from '../inventory/inventory.facade';
import { QcFacade } from '../inbound/qc.facade';
import { canonicalUuid } from './return-authorization.command';
import type { ReturnCondition } from './return-receipt.command';
import { assertLinesConservedInTx, dispositionDataFault } from './disposition-split';
import {
  RETURN_DISPOSITION_RECORDED_EVENT,
  RETURN_SCRAP_RECORDED_EVENT,
  type ReturnDispositionRecordedPayload,
  type ReturnScrapRecordedPayload,
} from './events';

// ── vocabularies ─────────────────────────────────────────────────────────────

/**
 * Story 4-7a (FR-48) — what happens to a received return unit. Each outcome
 * is its own registered ledger write: `restock` → `return.restocked` (RETURNS
 * → a storage bin, ATP rises); `quarantine` → a QC hold of kind `return`
 * (QC's `qc.held` RETURNS → QC-HOLD); `scrap` → `return.scrapped` (RETURNS →
 * out). Mirrored by `return_dispositions_outcome_check` (0097), pinned by
 * test/return-dispositions.spec.ts.
 */
export const RETURN_DISPOSITION_OUTCOMES = ['restock', 'quarantine', 'scrap'] as const;
export type ReturnDispositionOutcome = (typeof RETURN_DISPOSITION_OUTCOMES)[number];

/**
 * Story 4-7a decision 7 — one reason vocabulary for quarantine and scrap
 * (a restock takes none). `other` needs a note. Mirrored by
 * `return_dispositions_reason_check` (0097).
 */
export const RETURN_DISPOSITION_REASONS = [
  'damaged',
  'defective',
  'expired',
  'missing-parts',
  'contaminated',
  'needs-inspection',
  'client-instruction',
  'other',
] as const;
export type ReturnDispositionReason = (typeof RETURN_DISPOSITION_REASONS)[number];

/**
 * Story 4-7a (A19) — the received grades a HANDHELD restock may consume. A
 * line graded `opened`, `damaged` or `missing-parts` is a web decision: the
 * device never puts a non-sellable unit back on the shelf by allocation.
 */
export const RESTOCKABLE_ON_DEVICE: readonly ReturnCondition[] = ['resaleable'];

/** A disposition note, in code points (0097's CHECK). */
export const MAX_DISPOSITION_NOTE = 200;
/** Serials one handheld restock names (the RMA's per-request bound). */
export const MAX_RESTOCK_SERIALS = 500;
/** The device's candidate read: the oldest awaiting lines it locks, at most. */
export const MAX_RESTOCK_CANDIDATE_LINES = 1_000;
const MAX_BATCH_CODE = 64;
const MAX_SERIAL_NUMBER = 200;

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const LINE_SERIAL_UNIQUE = 'return_dispositions_tenant_line_serial_unique';
const HANDLING_UNIT_UNIQUE = 'return_dispositions_tenant_handling_unit_unique';

// ── inputs and snapshot ──────────────────────────────────────────────────────

/** `POST …/returns/dispositions` — the web's disposition of one receipt line (base units). */
export interface DisposeReturnCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly receiptLineId: string;
  readonly outcome: string;
  readonly qty: number;
  readonly toBinId?: string | null | undefined;
  readonly reasonCode?: string | null | undefined;
  readonly note?: string | null | undefined;
}

/** `POST …/returns/restocks` — the handheld's `return.restock` op (base units). */
export interface RestockReturnCommand {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly operatorUserId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly qty: number;
  readonly batchCode?: string | null | undefined;
  readonly serialNumbers?: readonly string[] | null | undefined;
  readonly toBinId: string;
  /** Device time — the ledger event's and the disposition's business time. */
  readonly occurredAt: string;
}

/** One disposition as the response (and the idempotency snapshot) carries it — base units. */
export interface ReturnDispositionEntry {
  readonly id: string;
  readonly receiptLineId: string;
  readonly rmaId: string;
  readonly outcome: ReturnDispositionOutcome;
  readonly qty: number;
  readonly toBinId: string | null;
  readonly qcHoldId: string | null;
  readonly ledgerEventId: string | null;
}

/** The 201 body of both routes — and the idempotency snapshot a replay re-serves. */
export interface ReturnDispositionResult {
  readonly dispositions: readonly ReturnDispositionEntry[];
}

// ── refusals ─────────────────────────────────────────────────────────────────

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid return disposition', detail);
}

function lineNotFound(id: string): ProblemException {
  return new ProblemException('not-found', 404, 'Return receipt line not found', `No return receipt line with id "${id}" exists in this tenant.`);
}

function exceedsAwaiting(detail: string, awaitingMilli: number): ProblemException {
  return new ProblemException('exceeds-awaiting', 409, 'More than is awaiting disposition', detail, {
    awaitingQty: fromMilli(awaitingMilli),
  });
}

function serialNotAwaiting(serialNumber: string, why: string): ProblemException {
  return new ProblemException(
    'serial-not-awaiting',
    409,
    'Serial is not awaiting a restock',
    `Serial "${serialNumber}" ${why} — nothing was restocked.`,
    { serialNumber },
  );
}

function notSupported(detail: string): ProblemException {
  return new ProblemException('disposition-not-supported', 409, 'This disposition is not supported for this unit', detail);
}

function scopeQuarantined(skuCode: string, binCode: string): ProblemException {
  return new ProblemException(
    'disposition-scope-quarantined',
    409,
    'The stock is under a reconcile quarantine',
    `SKU "${skuCode}" in bin "${binCode}" is quarantined by reconciliation — its count is not trusted, so nothing moves out of or into it; resolve the quarantine first.`,
  );
}

function documentWarehouseMismatch(receiptCode: string): ProblemException {
  return new ProblemException(
    'document-warehouse-mismatch',
    409,
    "The receipt line is another warehouse's",
    `Return receipt "${receiptCode}" belongs to another warehouse — disposition it in the warehouse it was received in.`,
  );
}

// ── shape (above the transaction) ────────────────────────────────────────────

function trimmedOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(`${field} must be text or null.`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function uuidOrFail(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw invalid(`${field} must be a uuid.`);
  return canonicalUuid(value);
}

function assertPositiveQty(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0) || value > MAX_QUANTITY_BASE) {
    throw invalid(`qty must be a number greater than 0 (got ${String(value)}).`);
  }
  return value;
}

export interface NormalizedDispose {
  readonly warehouseId: string;
  readonly receiptLineId: string;
  readonly outcome: ReturnDispositionOutcome;
  readonly qty: number;
  readonly toBinId: string | null;
  readonly reasonCode: ReturnDispositionReason | null;
  readonly note: string | null;
}

/**
 * The web dispose's request-shape rules (guide §1 tier 1 — 400 above the
 * transaction, never a replay) and its normalisation (A28): ids lowercased,
 * the note trimmed (blank = absent). A restock names a target bin and takes
 * no reason or note; a quarantine or scrap names a reason (and a note for
 * `other`) and no bin.
 */
export function normalizeDispose(command: Omit<DisposeReturnCommand, 'tenantId' | 'actorUserId'>): NormalizedDispose {
  const warehouseId = uuidOrFail(command.warehouseId, 'warehouseId');
  const receiptLineId = uuidOrFail(command.receiptLineId, 'receiptLineId');
  if (!(RETURN_DISPOSITION_OUTCOMES as readonly string[]).includes(command.outcome)) {
    throw invalid(`outcome must be one of ${JSON.stringify(RETURN_DISPOSITION_OUTCOMES)} (got "${String(command.outcome)}").`);
  }
  const outcome = command.outcome as ReturnDispositionOutcome;
  const qty = assertPositiveQty(command.qty);
  const rawBin = command.toBinId ?? null;
  const note = trimmedOrNull(command.note, 'note');
  if (note !== null && [...note].length > MAX_DISPOSITION_NOTE) {
    throw invalid(`note must be at most ${MAX_DISPOSITION_NOTE} characters (got ${[...note].length}).`);
  }
  const rawReason = command.reasonCode ?? null;
  if (outcome === 'restock') {
    if (rawBin === null) throw invalid('A restock names the storage bin the units go to (toBinId).');
    if (rawReason !== null) throw invalid('A restock takes no reasonCode — only a quarantine or a scrap gives one.');
    if (note !== null) throw invalid('A restock takes no note.');
    return { warehouseId, receiptLineId, outcome, qty, toBinId: uuidOrFail(rawBin, 'toBinId'), reasonCode: null, note: null };
  }
  if (rawBin !== null) throw invalid(`A ${outcome} names no target bin (toBinId) — only a restock does.`);
  if (rawReason === null) throw invalid(`A ${outcome} needs a reasonCode, one of ${JSON.stringify(RETURN_DISPOSITION_REASONS)}.`);
  if (!(RETURN_DISPOSITION_REASONS as readonly string[]).includes(rawReason)) {
    throw invalid(`reasonCode must be one of ${JSON.stringify(RETURN_DISPOSITION_REASONS)} (got "${String(rawReason)}").`);
  }
  if (rawReason === 'other' && note === null) throw invalid('The reason "other" needs a note saying why.');
  return { warehouseId, receiptLineId, outcome, qty, toBinId: null, reasonCode: rawReason as ReturnDispositionReason, note };
}

/**
 * The web dispose fingerprint: `arm` first, then every field always present
 * (null when absent), over the normalised form (A28) — the quantity as sent,
 * base units (A17). Pinned by a golden in test/return-dispositions.spec.ts.
 */
export function disposePayloadHash(tenantId: string, normalized: NormalizedDispose): string {
  return hashCommandPayload({
    arm: 'return-dispose',
    tenantId,
    warehouseId: normalized.warehouseId,
    receiptLineId: normalized.receiptLineId,
    outcome: normalized.outcome,
    qty: normalized.qty,
    toBinId: normalized.toBinId,
    reasonCode: normalized.reasonCode,
    note: normalized.note,
  });
}

export interface NormalizedRestock {
  readonly warehouseId: string;
  readonly skuId: string;
  readonly qty: number;
  readonly batchCode: string | null;
  /** Trimmed, distinct, SORTED — or null. */
  readonly serialNumbers: readonly string[] | null;
  readonly toBinId: string;
  readonly occurredAt: string;
}

/**
 * The handheld restock's request-shape rules: uuids, a positive quantity, a
 * Z-suffixed `occurredAt` (required — the move precedent, A29), the batch
 * code trimmed (blank = absent), serial numbers trimmed, distinct, one per
 * unit and sorted (A28), never both a batch code and serials (a
 * batch-and-serial unit's batch is its receipt line's — A13).
 */
export function normalizeRestock(command: Omit<RestockReturnCommand, 'tenantId' | 'deviceId' | 'operatorUserId'>): NormalizedRestock {
  const warehouseId = uuidOrFail(command.warehouseId, 'warehouseId');
  const skuId = uuidOrFail(command.skuId, 'skuId');
  const toBinId = uuidOrFail(command.toBinId, 'toBinId');
  const qty = assertPositiveQty(command.qty);
  let occurredAt: string;
  try {
    occurredAt = assertUtcIso(String(command.occurredAt));
  } catch {
    throw invalid(`occurredAt must be a Z-suffixed ISO-8601 UTC instant (got "${String(command.occurredAt).slice(0, 64)}").`);
  }
  const batchCode = trimmedOrNull(command.batchCode, 'batchCode');
  if (batchCode !== null && [...batchCode].length > MAX_BATCH_CODE) {
    throw invalid(`batchCode must be at most ${MAX_BATCH_CODE} characters.`);
  }
  const raw = command.serialNumbers ?? null;
  let serialNumbers: string[] | null = null;
  if (raw !== null) {
    if (!Array.isArray(raw) || raw.some((serial) => typeof serial !== 'string' || serial.trim() === '')) {
      throw invalid('serialNumbers must be a list of serial numbers, or null.');
    }
    if (raw.length === 0) throw invalid('serialNumbers must name at least one serial, or be null.');
    if (raw.length > MAX_RESTOCK_SERIALS) {
      throw invalid(`A restock names at most ${MAX_RESTOCK_SERIALS} serials (got ${raw.length}) — split it.`);
    }
    const trimmed = raw.map((serial) => serial.trim());
    if (trimmed.some((serial) => [...serial].length > MAX_SERIAL_NUMBER)) {
      throw invalid(`A serial number is at most ${MAX_SERIAL_NUMBER} characters.`);
    }
    if (new Set(trimmed).size !== trimmed.length) throw invalid('serialNumbers lists the same serial twice — one serial is one unit.');
    if (qty !== trimmed.length) {
      throw invalid(`qty must equal the number of serials (qty ${qty}, ${trimmed.length} serial(s)).`);
    }
    if (batchCode !== null) {
      throw invalid("A serial restock carries no batchCode — each unit's batch is the one it was received with.");
    }
    serialNumbers = [...trimmed].sort();
  }
  return { warehouseId, skuId, qty, batchCode, serialNumbers, toBinId, occurredAt };
}

/** The handheld restock fingerprint (pinned by a golden — the spec's Design Notes). */
export function restockPayloadHash(tenantId: string, deviceId: string, operatorUserId: string, normalized: NormalizedRestock): string {
  return hashCommandPayload({
    arm: 'return-restock',
    tenantId,
    deviceId,
    operatorUserId,
    warehouseId: normalized.warehouseId,
    skuId: normalized.skuId,
    qty: normalized.qty,
    batchCode: normalized.batchCode,
    serialNumbers: normalized.serialNumbers,
    toBinId: normalized.toBinId,
    occurredAt: normalized.occurredAt,
  });
}

// ── the locked line and the allocation ───────────────────────────────────────

interface LockedLine {
  readonly id: string;
  readonly returnReceiptId: string;
  readonly skuId: string;
  readonly qty: number;
  readonly openQty: number;
  readonly condition: string;
  readonly batchId: string | null;
  readonly serialId: string | null;
  readonly handlingUnitId: string | null;
}

interface ReceiptHeader {
  readonly id: string;
  readonly code: string;
  readonly clientId: string;
  readonly warehouseId: string;
  readonly rmaId: string;
}

/** One planned disposition (milli-units). */
interface Allocation {
  readonly line: LockedLine;
  readonly header: ReceiptHeader;
  readonly milli: number;
}

const LINE_COLUMNS = {
  id: returnReceiptLines.id,
  returnReceiptId: returnReceiptLines.returnReceiptId,
  skuId: returnReceiptLines.skuId,
  qty: returnReceiptLines.qty,
  openQty: returnReceiptLines.openQty,
  condition: returnReceiptLines.condition,
  batchId: returnReceiptLines.batchId,
  serialId: returnReceiptLines.serialId,
  handlingUnitId: returnReceiptLines.handlingUnitId,
};

function toLockedLine(row: { [K in keyof typeof LINE_COLUMNS]: unknown }): LockedLine {
  return {
    id: row.id as string,
    returnReceiptId: row.returnReceiptId as string,
    skuId: row.skuId as string,
    qty: Number(row.qty),
    openQty: Number(row.openQty),
    condition: row.condition as string,
    batchId: row.batchId as string | null,
    serialId: row.serialId as string | null,
    handlingUnitId: row.handlingUnitId as string | null,
  };
}

/** The settlement shape of a disposition command — what `applyDispositionsInTx` writes. */
interface DispositionPlan {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly actorUserId: string;
  readonly deviceId: string | null;
  readonly outcome: ReturnDispositionOutcome;
  readonly toBin: { readonly binId: string; readonly binCode: string } | null;
  readonly reasonCode: ReturnDispositionReason | null;
  readonly note: string | null;
  readonly occurredAt: string;
  readonly sku: SkuFacts & { readonly id: string };
  readonly allocations: readonly Allocation[];
  readonly returnsBinId: string;
  readonly idempotencyKey: string;
}

/**
 * Story 4-7a — returns disposition (FR-48). Two entry points, one write path
 * (`applyDispositionsInTx`):
 *
 * - `dispose` — the web (`returns.manage`): ONE receipt line (or part of it)
 *   restocked into a named storage bin, quarantined on a QC hold of kind
 *   `return`, or scrapped with a reason.
 * - `restock` — the handheld's `return.restock` (badge-in floor role): a SKU
 *   (and batch, or serials) restocked into a scanned bin, allocated
 *   oldest-first across the warehouse's sellable awaiting lines.
 *
 * The skeleton (IMPLEMENTATION-GUIDE §1): shape → hash → (device operator) →
 * authority → replay → warehouse → SKU `FOR SHARE` → lines `FOR UPDATE` →
 * replay again → guards on the locked rows → the target's placement gates
 * (restock) → serial locks → writes (the ledger event or the QC hold, the
 * disposition, `open_qty −=`, the returned case) → the conservation
 * assertion (A20) → outbox → audit → (heartbeat) → the key LAST.
 *
 * Lock order (the canonical chain): receipt lines (oldest first) → the target
 * bin row (inside the gate runner) → the handling-unit rows / the serial
 * advisory locks (sorted) → the warehouse advisory (inside the ledger append).
 * The hold-settlement subscriber locks one receipt line in its own
 * transaction and nothing else of this chain before it.
 */
@Injectable()
export class ReturnDispositionCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(QcFacade) private readonly qc: QcFacade,
  ) {}

  // ── the web ────────────────────────────────────────────────────────────────

  async dispose(input: DisposeReturnCommand, idempotencyKey: string): Promise<ReturnDispositionResult> {
    const normalized = normalizeDispose(input);
    const payloadHash = disposePayloadHash(input.tenantId, normalized);
    const tenantId = input.tenantId;
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // Authority first, re-read from the DB (decision 8: returns.manage).
      const role = await getMemberRoleIn(tx, tenantId, input.actorUserId);
      assertPermission(role, 'returns.manage');
      const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      await assertWarehouseInTenant(tx, tenantId, normalized.warehouseId);

      // The line's SKU (it never changes), FOR SHARE before the line lock —
      // the device's order (SKU → lines), so a tracking-flag flip cannot
      // interleave with the disposition.
      const peek = await tx
        .select({ skuId: returnReceiptLines.skuId })
        .from(returnReceiptLines)
        .where(and(eq(returnReceiptLines.tenantId, tenantId), eq(returnReceiptLines.id, normalized.receiptLineId)))
        .limit(1);
      if (peek[0] === undefined) throw lineNotFound(normalized.receiptLineId);
      const sku = await this.skuOrFail(tx, tenantId, peek[0].skuId);
      // The line, locked (404 only — the lock helper checks nothing else).
      const locked = await tx
        .select(LINE_COLUMNS)
        .from(returnReceiptLines)
        .where(and(eq(returnReceiptLines.tenantId, tenantId), eq(returnReceiptLines.id, normalized.receiptLineId)))
        .for('update');
      if (locked[0] === undefined) throw lineNotFound(normalized.receiptLineId);
      const line = toLockedLine(locked[0]);
      const replayedUnderLock = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;

      const header = (await this.headersInTx(tx, tenantId, [line.returnReceiptId])).get(line.returnReceiptId);
      if (header === undefined) throw dispositionDataFault(`Return receipt line "${line.id}" names a receipt that does not exist.`);
      // ── guards, in the spec's order ─────────────────────────────────────
      if (header.warehouseId !== normalized.warehouseId) throw documentWarehouseMismatch(header.code);
      const checked = validateRecordableQuantity(normalized.qty, 'qty', sku.uom, sku.uomPrecision, 'non-negative');
      if (!checked.ok) throw invalid(checked.detail);
      const milli = checked.milli;
      if (line.serialId !== null || line.handlingUnitId !== null || sku.catchWeightTracked) {
        // A serial unit or a returned case is one unit, disposed whole.
        if (milli % QUANTITY_SCALE !== 0) throw invalid(`A ${line.serialId !== null ? 'serial unit' : 'returned case'} is disposed whole (qty 1).`);
      }
      if (normalized.outcome === 'quarantine' && (sku.serialTracked || sku.catchWeightTracked || line.serialId !== null || line.handlingUnitId !== null)) {
        throw notSupported(
          `SKU "${sku.code}" is ${sku.serialTracked || line.serialId !== null ? 'serial-tracked' : 'catch-weight tracked'} — a QC hold cannot carry its unit identity, so it cannot be quarantined; restock it or scrap it.`,
        );
      }
      if (normalized.outcome === 'restock') {
        await this.assertBatchesRestockableInTx(tx, tenantId, sku, [line.batchId], header.code, this.webNow());
      }
      if (milli > line.openQty) {
        throw exceedsAwaiting(
          `Return receipt line of "${header.code}" has ${fromMilli(line.openQty)} ${sku.uom} awaiting disposition — the ${normalized.outcome} names ${fromMilli(milli)}.`,
          line.openQty,
        );
      }
      if (normalized.outcome === 'scrap') {
        const threshold = await this.inventory.adjustmentThresholdInTx(tx, tenantId);
        if (threshold !== null && milli > threshold * QUANTITY_SCALE) {
          throw new ProblemException(
            'scrap-above-threshold',
            409,
            'Scrap above the write-off threshold',
            `Scrapping ${fromMilli(milli)} ${sku.uom} is above this tenant's write-off threshold of ${threshold} — scrap at most ${threshold} at a time, or raise the threshold in the adjustment policy.`,
            { awaitingQty: fromMilli(line.openQty), threshold },
          );
        }
      }
      const returnsBin = await ensureReturnsBinInTx(tx, tenantId, normalized.warehouseId);
      await this.assertNotQuarantinedInTx(tx, tenantId, normalized.warehouseId, sku, returnsBin.binId, normalized.toBinId);
      const toBin =
        normalized.outcome === 'restock'
          ? await this.inventory.assertPlacementGatesInTx(tx, {
              tenantId,
              warehouseId: normalized.warehouseId,
              binId: normalized.toBinId!,
              intakes: [{ skuId: sku.id, qtyMilli: milli }],
              role,
              subject: 'restock',
            })
          : null;
      return this.applyDispositionsInTx(
        tx,
        {
          tenantId,
          warehouseId: normalized.warehouseId,
          actorUserId: input.actorUserId,
          deviceId: null,
          outcome: normalized.outcome,
          toBin,
          reasonCode: normalized.reasonCode,
          note: normalized.note,
          occurredAt: this.webNow(),
          sku,
          allocations: [{ line, header, milli }],
          returnsBinId: returnsBin.binId,
          idempotencyKey,
        },
        payloadHash,
      );
    });
  }

  // ── the handheld ───────────────────────────────────────────────────────────

  async restock(input: RestockReturnCommand, idempotencyKey: string): Promise<ReturnDispositionResult> {
    const normalized = normalizeRestock(input);
    const payloadHash = restockPayloadHash(input.tenantId, input.deviceId, input.operatorUserId, normalized);
    const tenantId = input.tenantId;
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // The device and its operator's floor role (tenancy's guard), then the
      // role the gate runner's secure-bin authority rules on.
      await assertDeviceOperatorInTx(tx, tenantId, input.deviceId, input.operatorUserId);
      const role = await getMemberRoleIn(tx, tenantId, input.operatorUserId);
      const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      await assertWarehouseInTenant(tx, tenantId, normalized.warehouseId);
      const sku = await this.skuOrFail(tx, tenantId, normalized.skuId);

      // ── the SKU-shaped rules (behind the replay: they can tighten) ──────
      if (sku.catchWeightTracked) {
        throw invalid(`SKU "${sku.code}" is catch-weight tracked — a returned case is restocked on the web, where it is named.`);
      }
      if (sku.serialTracked && normalized.serialNumbers === null) {
        throw invalid(`SKU "${sku.code}" is serial-tracked — a restock names the serial of every unit.`);
      }
      if (!sku.serialTracked && normalized.serialNumbers !== null) {
        throw invalid(`SKU "${sku.code}" is not serial-tracked — its restock carries no serials.`);
      }
      if (!sku.serialTracked && sku.batchTracked && normalized.batchCode === null) {
        throw new ProblemException('batch-required', 400, 'Batch required', `SKU "${sku.code}" is batch-tracked — a restock names the batch it puts away.`);
      }
      if (!sku.batchTracked && normalized.batchCode !== null) {
        throw invalid(`SKU "${sku.code}" is not batch-tracked — its restock carries no batch.`);
      }
      const checked = validateRecordableQuantity(normalized.qty, 'qty', sku.uom, sku.uomPrecision, 'non-negative');
      if (!checked.ok) throw invalid(checked.detail);
      const milli = checked.milli;

      // ── the candidate lines, locked oldest first ────────────────────────
      const receiptsOfWarehouse = tx
        .select({ id: returnReceipts.id })
        .from(returnReceipts)
        .where(and(eq(returnReceipts.tenantId, tenantId), eq(returnReceipts.warehouseId, normalized.warehouseId)));
      let candidates: LockedLine[];
      let serialIdByNumber = new Map<string, string>();
      if (normalized.serialNumbers !== null) {
        serialIdByNumber = new Map(
          (await this.catalog.serialIdentitiesInTx(tx, tenantId, sku.id, { numbers: normalized.serialNumbers })).map((serial) => [
            serial.serialNumber,
            serial.id,
          ]),
        );
        const ids = [...serialIdByNumber.values()];
        candidates =
          ids.length === 0
            ? []
            : (
                await tx
                  .select(LINE_COLUMNS)
                  .from(returnReceiptLines)
                  .where(
                    and(
                      eq(returnReceiptLines.tenantId, tenantId),
                      eq(returnReceiptLines.skuId, sku.id),
                      inArray(returnReceiptLines.serialId, ids),
                      gt(returnReceiptLines.openQty, 0),
                      inArray(returnReceiptLines.returnReceiptId, receiptsOfWarehouse),
                    ),
                  )
                  .orderBy(asc(returnReceiptLines.createdAt), asc(returnReceiptLines.id))
                  .for('update')
              ).map(toLockedLine);
      } else {
        let batchId: string | null = null;
        let batchKnown = true;
        if (normalized.batchCode !== null) {
          const found = (await this.catalog.batchesByCodesInTx(tx, tenantId, [{ skuId: sku.id, code: normalized.batchCode }])).get(
            `${sku.id}:${normalized.batchCode}`,
          );
          batchKnown = found !== undefined;
          batchId = found?.id ?? null;
        }
        candidates = !batchKnown
          ? []
          : (
              await tx
                .select(LINE_COLUMNS)
                .from(returnReceiptLines)
                .where(
                  and(
                    eq(returnReceiptLines.tenantId, tenantId),
                    eq(returnReceiptLines.skuId, sku.id),
                    batchId === null ? isNull(returnReceiptLines.batchId) : eq(returnReceiptLines.batchId, batchId),
                    gt(returnReceiptLines.openQty, 0),
                    inArray(returnReceiptLines.condition, [...RESTOCKABLE_ON_DEVICE]),
                    inArray(returnReceiptLines.returnReceiptId, receiptsOfWarehouse),
                  ),
                )
                .orderBy(asc(returnReceiptLines.createdAt), asc(returnReceiptLines.id))
                .limit(MAX_RESTOCK_CANDIDATE_LINES)
                .for('update')
            ).map(toLockedLine);
      }
      const replayedUnderLock = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      const headers = await this.headersInTx(
        tx,
        tenantId,
        candidates.map((line) => line.returnReceiptId),
      );

      // ── the allocation (on the locked, fresh `open_qty`) ────────────────
      const allocations: Allocation[] = [];
      const headerOf = (line: LockedLine): ReceiptHeader => {
        const header = headers.get(line.returnReceiptId);
        if (header === undefined) throw dispositionDataFault(`Return receipt line "${line.id}" names a receipt that does not exist.`);
        return header;
      };
      if (normalized.serialNumbers !== null) {
        const lineBySerial = new Map(candidates.map((line) => [line.serialId!, line]));
        for (const serialNumber of normalized.serialNumbers) {
          const serialId = serialIdByNumber.get(serialNumber);
          const line = serialId === undefined ? undefined : lineBySerial.get(serialId);
          if (line === undefined) throw serialNotAwaiting(serialNumber, `of SKU "${sku.code}" is not awaiting disposition in this warehouse`);
          if (!RESTOCKABLE_ON_DEVICE.includes(line.condition as ReturnCondition)) {
            throw serialNotAwaiting(serialNumber, `was received graded "${line.condition}" — a non-sellable unit is dispositioned on the web`);
          }
          allocations.push({ line, header: headerOf(line), milli: QUANTITY_SCALE });
        }
      } else {
        let remaining = milli;
        for (const line of candidates) {
          if (remaining <= 0) break;
          const take = Math.min(line.openQty, remaining);
          allocations.push({ line, header: headerOf(line), milli: take });
          remaining -= take;
        }
        if (remaining > 0) {
          const awaiting = candidates.reduce((sum, line) => sum + line.openQty, 0);
          throw exceedsAwaiting(
            `${fromMilli(awaiting)} ${sku.uom} of SKU "${sku.code}"${normalized.batchCode === null ? '' : ` batch "${normalized.batchCode}"`} ${awaiting === 0 ? 'is' : 'are'} awaiting a restock in this warehouse (sellable returns only) — the restock names ${fromMilli(milli)}.`,
            awaiting,
          );
        }
      }
      await this.assertBatchesRestockableInTx(
        tx,
        tenantId,
        sku,
        allocations.map((item) => item.line.batchId),
        null,
        Date.parse(normalized.occurredAt),
      );
      const returnsBin = await ensureReturnsBinInTx(tx, tenantId, normalized.warehouseId);
      await this.assertNotQuarantinedInTx(tx, tenantId, normalized.warehouseId, sku, returnsBin.binId, normalized.toBinId);
      const toBin = await this.inventory.assertPlacementGatesInTx(tx, {
        tenantId,
        warehouseId: normalized.warehouseId,
        binId: normalized.toBinId,
        intakes: [{ skuId: sku.id, qtyMilli: milli }],
        role,
        subject: 'restock',
      });
      const result = await this.applyDispositionsInTx(
        tx,
        {
          tenantId,
          warehouseId: normalized.warehouseId,
          actorUserId: input.operatorUserId,
          deviceId: input.deviceId,
          outcome: 'restock',
          toBin,
          reasonCode: null,
          note: null,
          occurredAt: normalized.occurredAt,
          sku,
          allocations,
          returnsBinId: returnsBin.binId,
          idempotencyKey,
        },
        payloadHash,
        async () => touchDeviceInTx(tx, input.deviceId),
      );
      return result;
    });
  }

  // ── the shared write path ──────────────────────────────────────────────────

  /**
   * Every write of a disposition command, after its guards and gates: serial
   * locks → per allocation the ledger event (restock / scrap) or the return
   * hold (quarantine), the disposition row, `open_qty −=` and the returned
   * case's status → the conservation assertion → outbox → audit → the
   * caller's tail (the device heartbeat) → the key LAST.
   */
  private async applyDispositionsInTx(
    tx: TenantTx,
    plan: DispositionPlan,
    payloadHash: string,
    beforeKey?: () => Promise<void>,
  ): Promise<ReturnDispositionResult> {
    const { tenantId, sku } = plan;
    // Serial locks (sorted inside the helper) — the advisory family after the
    // bin row the gate runner locked, before the warehouse advisory.
    const serialIds = plan.allocations.flatMap((item) => (item.line.serialId === null ? [] : [item.line.serialId]));
    await this.inventory.lockSerialsInTx(tx, tenantId, serialIds);
    // Returned cases: locked, and still `returned` (no other path moves one).
    const unitIds = plan.allocations.flatMap((item) => (item.line.handlingUnitId === null ? [] : [item.line.handlingUnitId]));
    if (unitIds.length > 0) {
      const units = await this.catalog.lockHandlingUnits(tx, tenantId, unitIds);
      for (const id of unitIds) {
        const unit = units.find((row) => row.id === id);
        if (unit === undefined || unit.status !== 'returned') {
          throw dispositionDataFault(`Returned case "${id}" is ${unit === undefined ? 'missing' : `"${unit.status}"`}, not "returned" — its receipt line still awaits a disposition.`);
        }
      }
    }
    const recordedAt = nowIso();
    const rmaCodes = await this.rmaCodesInTx(
      tx,
      tenantId,
      plan.allocations.map((item) => item.header.rmaId),
    );
    const entries: ReturnDispositionEntry[] = [];
    for (const item of plan.allocations) {
      const dispositionId = uuidv7();
      const handlingUnitIds = item.line.handlingUnitId === null ? undefined : [item.line.handlingUnitId];
      let ledgerEventId: string | null = null;
      let qcHoldId: string | null = null;
      if (plan.outcome === 'quarantine') {
        qcHoldId = await this.qc.holdReturnLineInTx(tx, {
          tenantId,
          warehouseId: plan.warehouseId,
          skuId: sku.id,
          returnsBinId: plan.returnsBinId,
          batchId: item.line.batchId,
          quantity: item.milli,
          actorUserId: plan.actorUserId,
          occurredAt: plan.occurredAt,
          recordedAt,
          // A14 — the QC desk reads which return and why; the note stays here.
          reason: `return ${rmaCodes.get(item.header.rmaId) ?? item.header.rmaId} · ${plan.reasonCode!}`,
        });
      } else {
        const restock = plan.outcome === 'restock';
        const movement: LedgerMovement = {
          tenantId,
          warehouseId: plan.warehouseId,
          type: restock ? 'return.restocked' : 'return.scrapped',
          skuId: sku.id,
          // A relocation is a positive two-arm event; a scrap is a draw.
          quantityDelta: signedQuantity(restock ? item.milli : -item.milli),
          fromBinId: plan.returnsBinId,
          toBinId: restock ? plan.toBin!.binId : null,
          batchRef: item.line.batchId,
          serialRef: item.line.serialId,
          actorUserId: plan.actorUserId,
          occurredAt: plan.occurredAt,
          recordedAt,
          // A8 — the optional keys are omitted when absent, never null.
          referenceDoc: {
            kind: 'return-disposition',
            dispositionId,
            returnReceiptLineId: item.line.id,
            rmaId: item.header.rmaId,
            outcome: restock ? 'restock' : 'scrap',
            ...(plan.reasonCode === null ? {} : { reasonCode: plan.reasonCode }),
            ...(handlingUnitIds === undefined ? {} : { handlingUnitIds }),
          },
        };
        ledgerEventId = (await this.inventory.appendLedgerEventInTx(tx, movement)).eventId;
      }
      try {
        await tx.insert(returnDispositions).values({
          id: dispositionId,
          tenantId,
          clientId: item.header.clientId,
          warehouseId: plan.warehouseId,
          returnReceiptId: item.header.id,
          returnReceiptLineId: item.line.id,
          rmaId: item.header.rmaId,
          skuId: sku.id,
          outcome: plan.outcome,
          qty: item.milli,
          batchId: item.line.batchId,
          // A quarantine names no unit identity (0097's outcome shape).
          serialId: plan.outcome === 'quarantine' ? null : item.line.serialId,
          handlingUnitId: plan.outcome === 'quarantine' ? null : item.line.handlingUnitId,
          toBinId: plan.toBin?.binId ?? null,
          qcHoldId,
          reasonCode: plan.reasonCode,
          note: plan.note,
          deviceId: plan.deviceId,
          decidedBy: plan.actorUserId,
          ledgerEventId,
          occurredAt: plan.occurredAt,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, LINE_SERIAL_UNIQUE) || isUniqueViolationOn(err, HANDLING_UNIT_UNIQUE)) {
          // Unreachable beneath the line lock and `open_qty`; the unique is the backstop.
          throw new ProblemException('conflict', 409, 'Unit already dispositioned', 'Retry to read the settled result.');
        }
        throw err;
      }
      // The line's open quantity, decremented in the same transaction (0097's
      // `0 ≤ open_qty` CHECK is the backstop beneath the locked guard).
      await tx
        .update(returnReceiptLines)
        .set({ openQty: sql`${returnReceiptLines.openQty} - ${item.milli}::bigint` })
        .where(and(eq(returnReceiptLines.tenantId, tenantId), eq(returnReceiptLines.id, item.line.id)));
      entries.push({
        id: dispositionId,
        receiptLineId: item.line.id,
        rmaId: item.header.rmaId,
        outcome: plan.outcome,
        qty: fromMilli(item.milli),
        toBinId: plan.toBin?.binId ?? null,
        qcHoldId,
        ledgerEventId,
      });
    }
    // A restocked case is back in stock (packable); a scrapped one is written off.
    if (unitIds.length > 0 && plan.outcome !== 'quarantine') {
      const settled = await this.catalog.settleReturnedHandlingUnitsInTx(tx, tenantId, unitIds, plan.outcome === 'restock' ? 'active' : 'rejected');
      if (settled.length !== unitIds.length) throw dispositionDataFault('A returned case changed state under its lock.');
    }
    // A20 — the line split still conserves, inside this transaction.
    await assertLinesConservedInTx(
      tx,
      tenantId,
      plan.allocations.map((item) => item.line.id),
    );

    const snapshot: ReturnDispositionResult = { dispositions: entries };
    const at = nowIso();
    const totalMilli = plan.allocations.reduce((sum, item) => sum + item.milli, 0);
    const firstHeader = plan.allocations[0]!.header;
    const payload: ReturnDispositionRecordedPayload = {
      warehouseId: plan.warehouseId,
      clientId: firstHeader.clientId,
      skuId: sku.id,
      outcome: plan.outcome,
      qty: String(fromMilli(totalMilli)),
      dispositionCount: entries.length,
      firstDispositionId: entries[0]!.id,
    };
    await this.outbox.append(tx, { messageId: uuidv7(), tenantId, type: RETURN_DISPOSITION_RECORDED_EVENT, occurredAt: at, payload: { ...payload } });
    if (plan.outcome === 'scrap') {
      for (const [i, item] of plan.allocations.entries()) {
        const scrap: ReturnScrapRecordedPayload = {
          rmaId: item.header.rmaId,
          rmaCode: rmaCodes.get(item.header.rmaId) ?? '',
          clientId: item.header.clientId,
          warehouseId: plan.warehouseId,
          skuId: sku.id,
          qty: String(fromMilli(item.milli)),
          reasonCode: plan.reasonCode!,
          dispositionId: entries[i]!.id,
        };
        await this.outbox.append(tx, { messageId: uuidv7(), tenantId, type: RETURN_SCRAP_RECORDED_EVENT, occurredAt: at, payload: { ...scrap } });
      }
    }
    // A25 — ONE audit row per command, server time, the first disposition.
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId: plan.actorUserId,
      action: RETURN_DISPOSITION_RECORDED_EVENT,
      targetType: 'return_disposition',
      targetId: entries[0]!.id,
      reference: plan.idempotencyKey,
      changes: {
        dispositionIds: entries.map((entry) => entry.id),
        outcome: plan.outcome,
        deviceId: plan.deviceId,
        operatorUserId: plan.deviceId === null ? null : plan.actorUserId,
      },
      occurredAt: at,
    });
    if (beforeKey !== undefined) await beforeKey();
    await this.writeIdempotencyKey(tx, tenantId, plan.idempotencyKey, payloadHash, snapshot);
    return snapshot;
  }

  // ── reads and guards ───────────────────────────────────────────────────────

  /** The web's business time is the server's (A29). */
  private webNow(): string {
    return nowIso();
  }

  private async skuOrFail(tx: TenantTx, tenantId: string, skuId: string): Promise<SkuFacts & { readonly id: string }> {
    const facts = (await this.catalog.skuFactsInTx(tx, tenantId, [skuId], { lock: 'share' })).get(skuId);
    if (facts === undefined) {
      throw new ProblemException('not-found', 404, 'SKU not found', `No SKU with id "${skuId}" exists in this tenant.`);
    }
    return { ...facts, id: skuId };
  }

  private async headersInTx(tx: TenantTx, tenantId: string, receiptIds: readonly string[]): Promise<Map<string, ReceiptHeader>> {
    const ids = [...new Set(receiptIds)];
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({
        id: returnReceipts.id,
        code: returnReceipts.code,
        clientId: returnReceipts.clientId,
        warehouseId: returnReceipts.warehouseId,
        rmaId: returnReceipts.rmaId,
      })
      .from(returnReceipts)
      .where(and(eq(returnReceipts.tenantId, tenantId), inArray(returnReceipts.id, ids)));
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async rmaCodesInTx(tx: TenantTx, tenantId: string, rmaIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(rmaIds)];
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: returnAuthorizations.id, code: returnAuthorizations.code })
      .from(returnAuthorizations)
      .where(and(eq(returnAuthorizations.tenantId, tenantId), inArray(returnAuthorizations.id, ids)));
    return new Map(rows.map((row) => [row.id, row.code]));
  }

  /**
   * A21 — a restock puts units back where they can be promised, so the batch
   * must be promisable: not expired at the business time (the draw side's
   * predicate, 3-3a's `isBatchExpiredAt`) and `active` (not blocked).
   */
  private async assertBatchesRestockableInTx(
    tx: TenantTx,
    tenantId: string,
    sku: SkuFacts & { readonly id: string },
    batchIds: readonly (string | null)[],
    receiptCode: string | null,
    atMs: string | number,
  ): Promise<void> {
    const ids = [...new Set(batchIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return;
    const at = typeof atMs === 'number' ? atMs : Date.parse(atMs);
    const batches = (await this.catalog.getBatchesForSkusInTx(tx, tenantId, [sku.id])).filter((batch) => ids.includes(batch.id));
    for (const batch of batches) {
      if (isBatchExpiredAt(batch.expiryDate, at)) {
        throw new ProblemException(
          'batch-expired',
          409,
          'Batch is expired',
          `Batch "${batch.code}" of SKU "${sku.code}" is expired — an expired unit is not restocked${receiptCode === null ? '' : ` (receipt "${receiptCode}")`}; quarantine or scrap it on the web.`,
          { batchCode: batch.code },
        );
      }
      if (batch.status !== 'active') {
        throw new ProblemException(
          'batch-blocked',
          409,
          'Batch is blocked',
          `Batch "${batch.code}" of SKU "${sku.code}" is blocked — a blocked lot is not restocked; unblock it, or quarantine or scrap the unit.`,
          { batchCode: batch.code },
        );
      }
    }
  }

  /** The reconcile quarantine on both scopes — RETURNS (the origin) and the restock's target. */
  private async assertNotQuarantinedInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    sku: SkuFacts & { readonly id: string },
    returnsBinId: string,
    toBinId: string | null,
  ): Promise<void> {
    const scopes = toBinId === null ? [returnsBinId] : [returnsBinId, toBinId];
    const quarantined = await this.inventory.openQuarantinedBinsInTx(tx, tenantId, warehouseId, sku.id, scopes);
    if (quarantined.length > 0) {
      throw scopeQuarantined(sku.code, quarantined.includes(returnsBinId) ? 'RETURNS' : 'the target bin');
    }
  }

  private async replay(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<ReturnDispositionResult | null> {
    const rows = await tx
      .select({ payloadHash: idempotencyKeys.payloadHash, responseSnapshot: idempotencyKeys.responseSnapshot })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot as ReturnDispositionResult;
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: ReturnDispositionResult,
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
