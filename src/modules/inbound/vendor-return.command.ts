import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, vendorReturnLines, vendorReturns } from '../../shared/db/schema';
import type { VendorReturn } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { assertRecordableQuantity, fromMilli, signedQuantity } from '../../shared/primitives/quantity';
import { assertUtcIso, istDateOf, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import {
  assertBrandDocumentDateWindow,
  assertConsignmentCaptureShape,
  normalizeConsignmentCapture,
  type ConsignmentCaptureInput,
  type NormalizedConsignmentCapture,
} from '../../shared/primitives/consignment-capture';
import { damagedPoolLockKey } from '../../shared/primitives/damaged-pool';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { ensureDamagedBinInTx, findDamagedBinInTx } from '../tenancy/receiving-bin';
import {
  assertClientTakesWorkInTx,
  assertSingleClientInTx,
  clientPartySnapshotOf,
  getClientInTx,
} from '../clients/clients.facade';
import { assertTransporterInTx, assertVendorLinkedInTx, type TransporterSnapshotV1 } from '../partners/partners.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import { uomPrecision } from '../catalog/uom';
import { InventoryFacade } from '../inventory/inventory.facade';
import { damagedArmKey, openVendorReturnClaimsByArmInTx, sourceClaimsByGrnLineInTx } from './vendor-return-claims';
import {
  consigneeAddressOf,
  grnLineSourceFactsInTx,
  liveWarehouseSnapshotInTx,
  vendorReturnNotFound,
  vendorReturnViewInTx,
  type RtvItemSnapshotV1,
  type VendorReturnView,
} from './vendor-return.read';

// ── the vocabularies (IMPLEMENTATION-GUIDE §4 — mirrored by 0105's CHECKs) ────

/** Decision 3 — the lifecycle; dispatched and cancelled are terminal. */
export const VENDOR_RETURN_STATUSES = ['draft', 'picked', 'dispatched', 'cancelled'] as const;
export type VendorReturnStatus = (typeof VENDOR_RETURN_STATUSES)[number];

/** Decision 5 — why the units go back (`other` needs the header note). */
export const RTV_REASON_CODES = ['damaged', 'quality-failure', 'expired', 'wrong-item', 'recall', 'other'] as const;
export type RtvReasonCode = (typeof RTV_REASON_CODES)[number];

/** A7 — which frozen vendor address is the consignee. No silent fallback. */
export const RTV_CONSIGNEE_ADDRESS_KINDS = ['dispatch', 'registered'] as const;
export type RtvConsigneeAddressKind = (typeof RTV_CONSIGNEE_ADDRESS_KINDS)[number];

/** The returnable read's source kinds. */
export const RTV_SOURCE_KINDS = ['receipt-damage', 'qc-fail'] as const;
export type RtvSourceKind = (typeof RTV_SOURCE_KINDS)[number];

export { RTV_BRAND_DOCUMENT_TYPES } from '../../shared/primitives/consignment-capture';

export const MAX_RTV_LINES = 200;
/** The header note and the cancel reason, in code points (0105's CHECK). */
export const MAX_RTV_NOTE = 500;

/** The audit actions (`AUDIT_NEW_ACTIONS`) and the outbox event types. */
export const VENDOR_RETURN_EVENTS = {
  created: 'vendor_return.created',
  picked: 'vendor_return.picked',
  dispatched: 'vendor_return.dispatched',
  cancelled: 'vendor_return.cancelled',
} as const;

/**
 * The command's clock (IMPLEMENTATION-GUIDE §7c): the dispatch's "today in
 * IST" (the brand-document date window) reads it, so a test can move it.
 * Tests ASSIGN `vendorReturnClock.now` and restore it.
 */
export const vendorReturnClock = { now: (): number => Date.now() };

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const RTV_TENANT_CODE = 'vendor_returns_tenant_code_unique';

/** The code sequence's advisory-lock key text (the `rmaSequenceLockKey` shape). */
export function vendorReturnSequenceLockKey(tenantId: string): string {
  return `${tenantId}:rtv-seq`;
}

/** RTV codes are `RTV-<n>`, zero-padded to 4 digits, unique per tenant. */
export function vendorReturnCode(n: number): string {
  return `RTV-${String(n).padStart(4, '0')}`;
}

// ── command inputs ───────────────────────────────────────────────────────────

export interface CreateVendorReturnLineInput {
  readonly skuId: string;
  readonly batchId?: string | null | undefined;
  readonly grnLineId?: string | null | undefined;
  /** Base units (scaled behind the replay lookup). */
  readonly quantity: number;
  readonly reasonCode: string;
}

export interface CreateVendorReturnCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly vendorId: string;
  readonly consigneeAddress: string;
  readonly note?: string | null | undefined;
  readonly lines: readonly CreateVendorReturnLineInput[];
}

export interface PickVendorReturnCommand {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly operatorUserId: string;
  readonly vendorReturnId: string;
  readonly warehouseId: string;
  readonly occurredAt: string;
  readonly lines: readonly { readonly lineId: string; readonly pickedQty: number }[];
}

export interface DispatchVendorReturnCommand extends ConsignmentCaptureInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly vendorReturnId: string;
}

export interface CancelVendorReturnCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly vendorReturnId: string;
  readonly reason: string;
}

// ── refusals ─────────────────────────────────────────────────────────────────

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid return to vendor', detail);
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

/** The canonical line order (A9): skuId, then batchId null-first, then grnLineId null-first. */
export function compareRtvLines(
  a: { readonly skuId: string; readonly batchId: string | null; readonly grnLineId: string | null },
  b: { readonly skuId: string; readonly batchId: string | null; readonly grnLineId: string | null },
): number {
  return (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0) || compareNullable(a.batchId, b.batchId) || compareNullable(a.grnLineId, b.grnLineId);
}

interface NormalizedCreateLine {
  readonly skuId: string;
  readonly batchId: string | null;
  readonly grnLineId: string | null;
  readonly quantity: number;
  readonly reasonCode: string;
}

interface NormalizedCreate {
  readonly warehouseId: string;
  readonly vendorId: string;
  readonly consigneeAddress: string;
  readonly note: string | null;
  readonly lines: readonly NormalizedCreateLine[];
}

/** The create's request shape (400s above the transaction) and its canonical form. */
export function normalizeCreate(command: CreateVendorReturnCommand): NormalizedCreate {
  if (!UUID_RE.test(command.warehouseId)) throw invalid('warehouseId must be a uuid.');
  if (!UUID_RE.test(command.vendorId)) throw invalid('vendorId must be a uuid.');
  if (!(RTV_CONSIGNEE_ADDRESS_KINDS as readonly string[]).includes(command.consigneeAddress)) {
    throw invalid(`consigneeAddress must be one of ${JSON.stringify(RTV_CONSIGNEE_ADDRESS_KINDS)}.`);
  }
  const rawNote = command.note ?? null;
  if (rawNote !== null && typeof rawNote !== 'string') throw invalid('note must be text.');
  const note = rawNote === null || rawNote.trim() === '' ? null : rawNote.trim();
  if (note !== null && codePoints(note) > MAX_RTV_NOTE) throw invalid(`note is at most ${MAX_RTV_NOTE} characters.`);
  if (!Array.isArray(command.lines) || command.lines.length === 0) throw invalid('A return to vendor names at least one line.');
  if (command.lines.length > MAX_RTV_LINES) throw invalid(`A return to vendor names at most ${MAX_RTV_LINES} lines (got ${command.lines.length}) — split it.`);
  const lines = command.lines.map((line, index): NormalizedCreateLine => {
    const at = `lines[${index}]`;
    if (!UUID_RE.test(line.skuId)) throw invalid(`${at}.skuId must be a uuid.`);
    const batchId = line.batchId ?? null;
    if (batchId !== null && !UUID_RE.test(batchId)) throw invalid(`${at}.batchId must be a uuid, or null.`);
    const grnLineId = line.grnLineId ?? null;
    if (grnLineId !== null && !UUID_RE.test(grnLineId)) throw invalid(`${at}.grnLineId must be a uuid, or null.`);
    if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw invalid(`${at}.quantity must be above 0.`);
    }
    if (!(RTV_REASON_CODES as readonly string[]).includes(line.reasonCode)) {
      throw invalid(`${at}.reasonCode must be one of ${JSON.stringify(RTV_REASON_CODES)} (got ${JSON.stringify(line.reasonCode)}).`);
    }
    return { skuId: line.skuId.toLowerCase(), batchId: batchId?.toLowerCase() ?? null, grnLineId: grnLineId?.toLowerCase() ?? null, quantity: line.quantity, reasonCode: line.reasonCode };
  });
  const sorted = [...lines].sort(compareRtvLines);
  for (let i = 1; i < sorted.length; i += 1) {
    if (compareRtvLines(sorted[i - 1]!, sorted[i]!) === 0) {
      throw invalid('Two lines name the same SKU, batch and source — merge them into one line.');
    }
  }
  if (note === null && sorted.some((line) => line.reasonCode === 'other')) {
    throw invalid('A line whose reason is "other" needs the note to say why.');
  }
  return { warehouseId: command.warehouseId.toLowerCase(), vendorId: command.vendorId.toLowerCase(), consigneeAddress: command.consigneeAddress, note, lines: sorted };
}

/** A9 — the create's fingerprint: the canonical lines with the quantity as sent. */
export function createPayloadHash(tenantId: string, normalized: NormalizedCreate): string {
  return hashCommandPayload({
    tenantId,
    warehouseId: normalized.warehouseId,
    vendorId: normalized.vendorId,
    consigneeAddress: normalized.consigneeAddress,
    lines: normalized.lines.map((line) => ({
      skuId: line.skuId,
      batchId: line.batchId,
      grnLineId: line.grnLineId,
      quantity: line.quantity,
      reasonCode: line.reasonCode,
    })),
    note: normalized.note,
  });
}

function armLabel(skuCode: string, batchCode: string | null): string {
  return batchCode === null ? `SKU "${skuCode}"` : `SKU "${skuCode}" batch "${batchCode}"`;
}

function notDraft(code: string, status: string): ProblemException {
  return new ProblemException(
    'rtv-not-draft',
    409,
    'The return to vendor is not awaiting a pick',
    `${code} is ${status} — only a draft return to vendor is picked. Nothing was recorded.`,
    { rtvStatus: status },
  );
}

function pickMismatch(detail: string): ProblemException {
  return new ProblemException('rtv-pick-mismatch', 422, "The pick does not match the return's lines", detail);
}

// ── the command ──────────────────────────────────────────────────────────────

/**
 * Story 2-8b — the return-to-vendor commands. Each is one transaction in the
 * guide §1 skeleton: shape → hash → capability → replay → locks → replay
 * again → state guards → writes → outbox → audit → key LAST. Every answer is
 * the document's detail (`vendorReturnViewInTx`), stored as the snapshot.
 *
 * Lock order (A3): create — SKUs `FOR SHARE` → the client `FOR KEY SHARE` →
 * the vendor and its link `FOR KEY SHARE` → the DAMAGED pool advisory → the
 * code sequence advisory (no RTV row lock). Dispatch — the RTV row `FOR
 * UPDATE` → the transporter `FOR KEY SHARE` → the DAMAGED pool advisory →
 * the warehouse advisory (`lockWarehouseInTx`, re-entrant with the append's)
 * → the pre-check → the appends. Pick and cancel lock the RTV row only.
 */
@Injectable()
export class VendorReturnCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  // ── create ─────────────────────────────────────────────────────────────

  async create(command: CreateVendorReturnCommand, idempotencyKey: string): Promise<VendorReturnView> {
    const normalized = normalizeCreate(command);
    const payloadHash = createPayloadHash(command.tenantId, normalized);
    const tenantId = command.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'rtv.manage');
      const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      await assertWarehouseInTenant(tx, tenantId, normalized.warehouseId);

      // ── the SKUs, FOR SHARE (a tracking-flag flip cannot interleave) ────
      const skuIds = [...new Set(normalized.lines.map((line) => line.skuId))];
      const facts = await this.catalog.skuFactsInTx(tx, tenantId, skuIds, { lock: 'share' });
      for (const skuId of skuIds) {
        if (!facts.has(skuId)) throw new ProblemException('not-found', 404, 'SKU not found', `No SKU with id "${skuId}" exists in this tenant.`);
      }
      const kits = new Set(await this.catalog.getKitSkuIdsInTx(tx, tenantId, skuIds));
      for (const skuId of skuIds) {
        const sku = facts.get(skuId)!;
        if (sku.serialTracked || sku.catchWeightTracked || kits.has(skuId)) {
          const what = sku.serialTracked ? 'serial-tracked' : sku.catchWeightTracked ? 'catch-weight' : 'a kit';
          throw new ProblemException(
            'rtv-sku-unsupported',
            409,
            'This SKU cannot go on a return to vendor',
            `SKU "${sku.code}" is ${what} — DAMAGED holds no such units (damage and QC fails keep their serial, case and kit arms closed), so a return to vendor names none.`,
            { skuCode: sku.code },
          );
        }
      }
      for (const line of normalized.lines) {
        const sku = facts.get(line.skuId)!;
        if (sku.batchTracked && line.batchId === null) {
          throw invalid(`SKU "${sku.code}" is batch-tracked — name the batch (its damaged units carry one).`);
        }
        if (!sku.batchTracked && line.batchId !== null) {
          throw invalid(`SKU "${sku.code}" is not batch-tracked — its line names no batch.`);
        }
      }
      const batchIds = [...new Set(normalized.lines.flatMap((line) => (line.batchId === null ? [] : [line.batchId])))];
      const batchViews = await this.catalog.batchViewsByIdsInTx(tx, tenantId, batchIds);
      for (const line of normalized.lines) {
        if (line.batchId === null) continue;
        const batch = batchViews.get(line.batchId);
        if (batch === undefined || batch.skuId !== line.skuId) {
          throw new ProblemException('not-found', 404, 'Batch not found', `No batch "${line.batchId}" of SKU "${facts.get(line.skuId)!.code}" exists in this tenant.`);
        }
      }

      // ── the client (from the SKUs, §7b), its "no new work" gate, the vendor ─
      const clientIds = await this.catalog.skuClientIdsInTx(tx, tenantId, skuIds);
      const clientId = await assertSingleClientInTx(tx, tenantId, skuIds.map((id) => clientIds.get(id)!), 'A return to vendor');
      await assertClientTakesWorkInTx(tx, tenantId, clientId);
      const vendor = await assertVendorLinkedInTx(tx, tenantId, normalized.vendorId, clientId, 'a new return to vendor');
      const kind = normalized.consigneeAddress as RtvConsigneeAddressKind;
      if (consigneeAddressOf(vendor, kind) === null) {
        throw invalid(
          `Vendor "${vendor.code}" has no ${kind === 'dispatch' ? 'dispatch' : 'registered'} address — add it in Settings → Partners, or send the goods to its ${kind === 'dispatch' ? 'registered' : 'dispatch'} address.`,
        );
      }
      const client = clientPartySnapshotOf(await getClientInTx(tx, tenantId, clientId));

      // ── precision (behind the replay lookup) ────────────────────────────
      const lines = normalized.lines.map((line, index) => {
        const sku = facts.get(line.skuId)!;
        return { ...line, milli: assertRecordableQuantity(line.quantity, `lines[${index}].quantity`, sku.uom, sku.uomPrecision) };
      });

      // ── the DAMAGED pool: one advisory, the on-hand, the open claims ────
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${damagedPoolLockKey(tenantId, normalized.warehouseId)}, 0))`);
      // A same-key duplicate parked on the pool lock replays the winner's
      // answer (§1 step 6) — it would otherwise read the winner's claim and
      // answer rtv-exceeds-damaged.
      const replayedUnderLock = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      const damagedBin = await findDamagedBinInTx(tx, tenantId, normalized.warehouseId);
      const arms = damagedBin === null ? [] : await this.inventory.damagedArmsInTx(tx, tenantId, normalized.warehouseId, damagedBin.binId, { skuIds });
      const onHand = new Map(arms.map((arm) => [damagedArmKey(arm.skuId, arm.batchId), arm.quantity]));
      const claims = await openVendorReturnClaimsByArmInTx(tx, tenantId, normalized.warehouseId, skuIds);
      // A4 — the request is summed PER ARM across its lines (two sources, one arm).
      const requested = new Map<string, { milli: number; skuId: string; batchId: string | null }>();
      for (const line of lines) {
        const key = damagedArmKey(line.skuId, line.batchId);
        const entry = requested.get(key);
        requested.set(key, { milli: (entry?.milli ?? 0) + line.milli, skuId: line.skuId, batchId: line.batchId });
      }
      for (const [key, entry] of requested) {
        const have = onHand.get(key) ?? 0;
        const claimed = claims.get(key)?.claimedMilli ?? 0;
        if (entry.milli + claimed > have) {
          const sku = facts.get(entry.skuId)!;
          const batchCode = entry.batchId === null ? null : (batchViews.get(entry.batchId)?.code ?? entry.batchId);
          const available = Math.max(0, have - claimed);
          const codes = claims.get(key)?.codes ?? [];
          throw new ProblemException(
            'rtv-exceeds-damaged',
            409,
            'More than DAMAGED holds for the return',
            `${armLabel(sku.code, batchCode)}: DAMAGED holds ${fromMilli(have)} ${sku.uom}${claimed > 0 ? `, of which ${fromMilli(claimed)} ${sku.uom} are already claimed by ${codes.join(', ')}` : ''} — at most ${fromMilli(available)} ${sku.uom} can go on a new return (asked ${fromMilli(entry.milli)}).`,
            {
              skuId: entry.skuId,
              batchId: entry.batchId,
              onHandQty: fromMilli(have),
              claimedQty: fromMilli(claimed),
              availableQty: fromMilli(available),
              requestedQty: fromMilli(entry.milli),
            },
          );
        }
      }

      // ── the sources: warehouse, arm, vendor and the per-line cap ────────
      const sourced = lines.filter((line) => line.grnLineId !== null);
      if (sourced.length > 0) {
        const grnLineIds = sourced.map((line) => line.grnLineId!);
        const sources = await grnLineSourceFactsInTx(tx, tenantId, grnLineIds);
        const sourceClaims = await sourceClaimsByGrnLineInTx(tx, tenantId, grnLineIds);
        for (const line of sourced) {
          const source = sources.get(line.grnLineId!);
          const sku = facts.get(line.skuId)!;
          if (source === undefined || source.warehouseId !== normalized.warehouseId || source.skuId !== line.skuId || source.batchId !== line.batchId) {
            throw new ProblemException(
              'rtv-source-mismatch',
              422,
              "The source GRN line is not this line's",
              `GRN line "${line.grnLineId}" is not a receipt of ${armLabel(sku.code, line.batchId === null ? null : (batchViews.get(line.batchId)?.code ?? line.batchId))} in this warehouse — name the line the damaged units came from, or none.`,
              { grnLineId: line.grnLineId },
            );
          }
          if (source.poVendorId !== null && source.poVendorId !== normalized.vendorId) {
            throw new ProblemException(
              'rtv-vendor-mismatch',
              409,
              "The source is another vendor's",
              `GRN ${source.grnCode} was received against ${source.poCode ?? 'a purchase order'} of vendor ${source.poVendorName ?? source.poVendorId} — its damaged units go back to that vendor, not "${vendor.code}".`,
              { grnLineId: line.grnLineId, vendorId: source.poVendorId },
            );
          }
          const total = source.damagedMilli + source.qcFailedMilli;
          const claimed = sourceClaims.get(line.grnLineId!) ?? 0;
          const remaining = Math.max(0, total - claimed);
          if (line.milli > remaining) {
            throw new ProblemException(
              'rtv-exceeds-source',
              409,
              'More than the source GRN line can claim',
              `GRN ${source.grnCode} put ${fromMilli(total)} ${sku.uom} of ${sku.code} into DAMAGED${claimed > 0 ? `, ${fromMilli(claimed)} of them already on returns to vendor` : ''} — at most ${fromMilli(remaining)} ${sku.uom} can be claimed against it (asked ${fromMilli(line.milli)}).`,
              { grnLineId: line.grnLineId, claimableQty: fromMilli(remaining), requestedQty: fromMilli(line.milli) },
            );
          }
        }
      }

      // ── the frozen line identity (A6) ───────────────────────────────────
      const hsn = await this.catalog.getSkuHsnByIdsInTx(tx, tenantId, skuIds);
      const items = new Map<string, RtvItemSnapshotV1>();
      for (const line of lines) {
        const sku = facts.get(line.skuId)!;
        const batch = line.batchId === null ? undefined : batchViews.get(line.batchId);
        items.set(damagedArmKey(line.skuId, line.batchId), {
          skuCode: sku.code,
          name: sku.name,
          hsn: hsn.get(line.skuId) ?? null,
          uom: sku.uom,
          batchCode: batch?.code ?? null,
          batchExpiry: batch?.expiryDate ?? null,
        });
      }

      // ── the code, the rows ──────────────────────────────────────────────
      const code = await this.allocateCode(tx, tenantId);
      const id = uuidv7();
      const at = nowIso();
      try {
        await tx.insert(vendorReturns).values({
          id,
          tenantId,
          warehouseId: normalized.warehouseId,
          clientId,
          vendorId: normalized.vendorId,
          code,
          status: 'draft',
          consigneeAddressKind: kind,
          vendorSnapshot: vendor,
          clientSnapshot: client,
          note: normalized.note,
          createdBy: command.actorUserId,
          createdAt: at,
          updatedAt: at,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, RTV_TENANT_CODE)) {
          // Unreachable beneath the sequence lock; the unique index is the backstop.
          throw new ProblemException('conflict', 409, 'Return code collision', 'Another return to vendor took this code concurrently — retry.');
        }
        throw err;
      }
      await tx.insert(vendorReturnLines).values(
        lines.map((line, index) => ({
          id: uuidv7(),
          tenantId,
          vendorReturnId: id,
          lineNo: index + 1,
          skuId: line.skuId,
          batchId: line.batchId,
          grnLineId: line.grnLineId,
          qty: line.milli,
          pickedQty: null,
          reasonCode: line.reasonCode,
          itemSnapshot: items.get(damagedArmKey(line.skuId, line.batchId))!,
          createdAt: at,
          updatedAt: at,
        })),
      );

      const view = await vendorReturnViewInTx(tx, tenantId, id);
      await this.emit(tx, tenantId, VENDOR_RETURN_EVENTS.created, view, at);
      await this.audit(tx, tenantId, command.actorUserId, VENDOR_RETURN_EVENTS.created, id, idempotencyKey);
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, view);
      return view;
    });
  }

  // ── pick (the handheld) ────────────────────────────────────────────────

  async pick(command: PickVendorReturnCommand, idempotencyKey: string): Promise<VendorReturnView> {
    // ── shape, above the transaction ────────────────────────────────────
    if (!UUID_RE.test(command.vendorReturnId)) throw invalid('The return id must be a uuid.');
    if (!UUID_RE.test(command.warehouseId)) throw invalid('warehouseId must be a uuid.');
    if (typeof command.occurredAt !== 'string') throw invalid('occurredAt is required (ISO-8601 UTC).');
    try {
      assertUtcIso(command.occurredAt);
    } catch {
      throw invalid('occurredAt must be an ISO-8601 UTC instant (…Z).');
    }
    if (!Array.isArray(command.lines) || command.lines.length === 0) throw invalid('The pick names every line of the return.');
    if (command.lines.length > MAX_RTV_LINES) throw invalid(`A pick names at most ${MAX_RTV_LINES} lines.`);
    const picks = command.lines.map((line, index) => {
      if (!UUID_RE.test(line.lineId)) throw invalid(`lines[${index}].lineId must be a uuid.`);
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
    const vendorReturnId = command.vendorReturnId.toLowerCase();
    // A9 — the pick's fingerprint.
    const payloadHash = hashCommandPayload({ tenantId: command.tenantId, arm: 'pick', vendorReturnId, lines: picks, occurredAt });
    const tenantId = command.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // The device and its operator's floor role, then the pick capability.
      await assertDeviceOperatorInTx(tx, tenantId, command.deviceId, command.operatorUserId);
      assertPermission(await getMemberRoleIn(tx, tenantId, command.operatorUserId), 'picks.execute');
      const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      // A10 — another warehouse's RTV is not this device's to see: 404.
      const row = await this.lockVendorReturn(tx, tenantId, vendorReturnId);
      if (row.warehouseId !== command.warehouseId.toLowerCase()) throw vendorReturnNotFound(vendorReturnId);
      const replayedUnderLock = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (row.status !== 'draft') throw notDraft(row.code, row.status);

      const lines = await tx
        .select()
        .from(vendorReturnLines)
        .where(and(eq(vendorReturnLines.tenantId, tenantId), eq(vendorReturnLines.vendorReturnId, row.id)));
      const byId = new Map(lines.map((line) => [line.id, line]));
      if (picks.length !== lines.length || picks.some((pick) => !byId.has(pick.lineId))) {
        throw pickMismatch(`The pick must name every line of ${row.code} exactly once (it has ${lines.length}) — reload the return and pick it again.`);
      }
      const scaled = picks.map((pick, index) => {
        const line = byId.get(pick.lineId)!;
        const item = line.itemSnapshot as RtvItemSnapshotV1;
        const milli = pick.pickedQty === 0 ? 0 : assertRecordableQuantity(pick.pickedQty, `lines[${index}].pickedQty`, item.uom, uomPrecision(item.uom));
        if (milli > line.qty) {
          throw pickMismatch(`Line ${line.lineNo} (${item.skuCode}) asks ${fromMilli(line.qty)} ${item.uom} — ${pick.pickedQty} cannot be picked against it.`);
        }
        return { line, milli };
      });
      if (scaled.every((entry) => entry.milli === 0)) {
        throw new ProblemException(
          'rtv-pick-empty',
          422,
          'Nothing was picked',
          `Every line of ${row.code} was picked 0 — nothing to send back. Cancel the return on the web instead.`,
        );
      }

      const at = nowIso();
      for (const entry of scaled) {
        await tx
          .update(vendorReturnLines)
          .set({ pickedQty: entry.milli, updatedAt: at })
          .where(and(eq(vendorReturnLines.id, entry.line.id), eq(vendorReturnLines.tenantId, tenantId)));
      }
      const updated = await tx
        .update(vendorReturns)
        .set({ status: 'picked', pickedBy: command.operatorUserId, pickedAt: occurredAt, pickedDeviceId: command.deviceId, updatedAt: at })
        .where(and(eq(vendorReturns.id, row.id), eq(vendorReturns.status, 'draft')))
        .returning({ id: vendorReturns.id });
      if (updated.length === 0) throw notDraft(row.code, 'closed');
      await touchDeviceInTx(tx, command.deviceId);

      const view = await vendorReturnViewInTx(tx, tenantId, row.id);
      await this.emit(tx, tenantId, VENDOR_RETURN_EVENTS.picked, view, at);
      // The 3-2b rule: a handheld op's audit stamps the server clock.
      await this.audit(tx, tenantId, command.operatorUserId, VENDOR_RETURN_EVENTS.picked, row.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, view);
      return view;
    });
  }

  // ── dispatch (the web) ─────────────────────────────────────────────────

  async dispatch(command: DispatchVendorReturnCommand, idempotencyKey: string): Promise<VendorReturnView> {
    if (!UUID_RE.test(command.vendorReturnId)) throw invalid('The return id must be a uuid.');
    const capture = normalizeConsignmentCapture(command);
    const valid = assertConsignmentCaptureShape(capture);
    const vendorReturnId = command.vendorReturnId.toLowerCase();
    // A9 — the dispatch's fingerprint: every capture field after normalisation.
    const payloadHash = hashCommandPayload({ tenantId: command.tenantId, arm: 'dispatch', vendorReturnId, ...captureHashFields(capture) });
    const tenantId = command.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'dispatch.execute');
      const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      const row = await this.lockVendorReturn(tx, tenantId, vendorReturnId);
      const replayedUnderLock = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (row.status !== 'picked') {
        throw new ProblemException(
          'rtv-not-picked',
          409,
          'The return to vendor is not picked',
          row.status === 'draft'
            ? `${row.code} has not been picked yet — pick it on the handheld first (the pick scan-verifies the units).`
            : `${row.code} is ${row.status} — only a picked return to vendor is dispatched.`,
          { rtvStatus: row.status },
        );
      }

      // ── the time rule, behind the replay lookup (A8) ────────────────────
      assertBrandDocumentDateWindow(valid.brandDocumentDate, istDateOf(row.createdAt), istDateOf(new Date(vendorReturnClock.now()).toISOString()));
      // ── the transporter, frozen (when one is named) ─────────────────────
      const transporter: TransporterSnapshotV1 | null =
        valid.transporterId === null ? null : await assertTransporterInTx(tx, tenantId, valid.transporterId, 'a return-to-vendor dispatch');
      // A7 — the vendor is deliberately NOT re-checked: a deactivation is
      // often the reason for the return; the frozen vendor is printed.

      // ── the locks: the DAMAGED pool, then the warehouse advisory (A3) ───
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${damagedPoolLockKey(tenantId, row.warehouseId)}, 0))`);
      await this.inventory.lockWarehouseInTx(tx, tenantId, row.warehouseId);
      const damagedBin = await ensureDamagedBinInTx(tx, tenantId, row.warehouseId);

      const lines = await tx
        .select()
        .from(vendorReturnLines)
        .where(and(eq(vendorReturnLines.tenantId, tenantId), eq(vendorReturnLines.vendorReturnId, row.id)));
      const shipping = lines.filter((line) => (line.pickedQty ?? 0) > 0).sort((a, b) => a.lineNo - b.lineNo);
      const skuIds = [...new Set(shipping.map((line) => line.skuId))];

      // ── a reconcile quarantine on DAMAGED stops the shipment (2-8b × 4-7a) ─
      for (const skuId of skuIds) {
        const quarantined = await this.inventory.openQuarantinedBinsInTx(tx, tenantId, row.warehouseId, skuId, [damagedBin.binId]);
        if (quarantined.length > 0) {
          const item = shipping.find((line) => line.skuId === skuId)!.itemSnapshot as RtvItemSnapshotV1;
          throw new ProblemException(
            'disposition-scope-quarantined',
            409,
            'The stock is under a reconcile quarantine',
            `SKU "${item.skuCode}" in DAMAGED is quarantined by reconciliation — its count is not trusted, so nothing moves out of it; resolve the quarantine first. Nothing was dispatched.`,
          );
        }
      }

      // ── the pre-check, per arm, under both locks (A3, A4) ───────────────
      const arms = await this.inventory.damagedArmsInTx(tx, tenantId, row.warehouseId, damagedBin.binId, { skuIds });
      const onHand = new Map(arms.map((arm) => [damagedArmKey(arm.skuId, arm.batchId), arm.quantity]));
      const needed = new Map<string, { milli: number; item: RtvItemSnapshotV1 }>();
      for (const line of shipping) {
        const key = damagedArmKey(line.skuId, line.batchId);
        needed.set(key, { milli: (needed.get(key)?.milli ?? 0) + (line.pickedQty ?? 0), item: line.itemSnapshot as RtvItemSnapshotV1 });
      }
      for (const [key, entry] of needed) {
        const have = onHand.get(key) ?? 0;
        if (entry.milli > have) {
          throw new ProblemException(
            'rtv-damaged-short',
            409,
            'DAMAGED no longer holds the picked units',
            `${armLabel(entry.item.skuCode, entry.item.batchCode)}: ${row.code} ships ${fromMilli(entry.milli)} ${entry.item.uom} but DAMAGED holds ${fromMilli(have)} — units were taken out of DAMAGED after the return was created. Cancel the return and create it again for what is there. Nothing was dispatched.`,
            { skuCode: entry.item.skuCode, batchCode: entry.item.batchCode, onHandQty: fromMilli(have), pickedQty: fromMilli(entry.milli) },
          );
        }
      }

      // ── the ledger: one rtv.dispatched draw per picked line ─────────────
      const at = nowIso();
      for (const line of shipping) {
        await this.inventory.appendLedgerEventInTx(tx, {
          tenantId,
          warehouseId: row.warehouseId,
          type: 'rtv.dispatched',
          skuId: line.skuId,
          quantityDelta: signedQuantity(-(line.pickedQty ?? 0)),
          fromBinId: damagedBin.binId,
          toBinId: null,
          batchRef: line.batchId,
          serialRef: null,
          actorUserId: command.actorUserId,
          occurredAt: at,
          recordedAt: at,
          // `grnLineId` only when the line names one — omitted, never null (§4).
          referenceDoc: {
            kind: 'vendor-return',
            vendorReturnId: row.id,
            vendorReturnLineId: line.id,
            ...(line.grnLineId === null ? {} : { grnLineId: line.grnLineId }),
          },
        });
      }

      // ── the dispatch, frozen (A6 — the warehouse too) ───────────────────
      const warehouse = await liveWarehouseSnapshotInTx(tx, tenantId, row.warehouseId);
      const updated = await tx
        .update(vendorReturns)
        .set({
          status: 'dispatched',
          dispatchedBy: command.actorUserId,
          dispatchedAt: at,
          brandDocumentType: valid.brandDocumentType,
          brandDocumentNumber: valid.brandDocumentNumber,
          brandDocumentDate: valid.brandDocumentDate,
          consignorGstin: valid.consignorGstin,
          debitNoteNumber: valid.debitNoteNumber,
          ewayBillNumber: valid.ewayBillNumber,
          ewayBillDate: valid.ewayBillDate,
          ewayValidUntil: valid.ewayValidUntil,
          transporterId: valid.transporterId,
          transporterSnapshot: transporter,
          carrierName: valid.carrierName,
          trackingRef: valid.trackingRef,
          vehicleNumber: valid.vehicleNumber,
          packageCount: valid.packageCount,
          warehouseSnapshot: warehouse,
          updatedAt: at,
        })
        .where(and(eq(vendorReturns.id, row.id), eq(vendorReturns.status, 'picked')))
        .returning({ id: vendorReturns.id });
      if (updated.length === 0) {
        // Unreachable under the row lock; refuse rather than ship twice.
        throw new ProblemException('rtv-not-picked', 409, 'The return to vendor is not picked', `${row.code} changed while it was being dispatched — reload it.`);
      }

      const view = await vendorReturnViewInTx(tx, tenantId, row.id);
      await this.emit(tx, tenantId, VENDOR_RETURN_EVENTS.dispatched, view, at);
      await this.audit(tx, tenantId, command.actorUserId, VENDOR_RETURN_EVENTS.dispatched, row.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, view);
      return view;
    });
  }

  // ── cancel ─────────────────────────────────────────────────────────────

  async cancel(command: CancelVendorReturnCommand, idempotencyKey: string): Promise<VendorReturnView> {
    if (!UUID_RE.test(command.vendorReturnId)) throw invalid('The return id must be a uuid.');
    const reason = typeof command.reason === 'string' ? command.reason.trim() : '';
    if (reason === '') throw invalid('reason is required — say why the return is cancelled.');
    if (codePoints(reason) > MAX_RTV_NOTE) throw invalid(`reason is at most ${MAX_RTV_NOTE} characters.`);
    const vendorReturnId = command.vendorReturnId.toLowerCase();
    const payloadHash = hashCommandPayload({ tenantId: command.tenantId, arm: 'cancel', vendorReturnId, reason });
    const tenantId = command.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'rtv.manage');
      const replayed = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const row = await this.lockVendorReturn(tx, tenantId, vendorReturnId);
      const replayedUnderLock = await this.replay(tx, tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (row.status !== 'draft' && row.status !== 'picked') {
        throw new ProblemException(
          'rtv-closed',
          409,
          'The return to vendor is closed',
          `${row.code} is ${row.status} — ${row.status === 'dispatched' ? 'the goods have left; a dispatched return is not cancelled' : 'it is already cancelled'}.`,
          { rtvStatus: row.status },
        );
      }
      const at = nowIso();
      const updated = await tx
        .update(vendorReturns)
        .set({ status: 'cancelled', cancelledBy: command.actorUserId, cancelledAt: at, cancelReason: reason, updatedAt: at })
        .where(and(eq(vendorReturns.id, row.id), eq(vendorReturns.status, row.status)))
        .returning({ id: vendorReturns.id });
      if (updated.length === 0) {
        throw new ProblemException('rtv-closed', 409, 'The return to vendor is closed', `${row.code} changed while it was being cancelled — reload it.`);
      }
      const view = await vendorReturnViewInTx(tx, tenantId, row.id);
      await this.emit(tx, tenantId, VENDOR_RETURN_EVENTS.cancelled, view, at);
      await this.audit(tx, tenantId, command.actorUserId, VENDOR_RETURN_EVENTS.cancelled, row.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, view);
      return view;
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /** Lock + 404 only — never a status check (§1, the `loadOpenPo` lesson). */
  private async lockVendorReturn(tx: TenantTx, tenantId: string, id: string): Promise<VendorReturn> {
    const rows = await tx
      .select()
      .from(vendorReturns)
      .where(and(eq(vendorReturns.tenantId, tenantId), eq(vendorReturns.id, id)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (row === undefined) throw vendorReturnNotFound(id);
    return row;
  }

  /** The next `RTV-<n>` under the tenant's sequence advisory (the `allocateCode` copy). */
  private async allocateCode(tx: TenantTx, tenantId: string): Promise<string> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${vendorReturnSequenceLockKey(tenantId)}, 0))`);
    const rows = await tx
      .select({ n: sql<number>`coalesce(max(substring(${vendorReturns.code} from '^RTV-([0-9]{1,9})$')::int), 0)` })
      .from(vendorReturns)
      .where(eq(vendorReturns.tenantId, tenantId));
    return vendorReturnCode(Number(rows[0]?.n ?? 0) + 1);
  }

  /** The outbox event (A16 — no consumer until 2-8c): flat ids and counts, no PII. */
  private async emit(tx: TenantTx, tenantId: string, type: string, view: VendorReturnView, at: string): Promise<void> {
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type,
      occurredAt: at,
      payload: {
        vendorReturnId: view.id,
        code: view.code,
        clientId: view.clientId,
        warehouseId: view.warehouseId,
        vendorId: view.vendorId,
        status: view.status,
        lineCount: view.lines.length,
        // Base units as a decimal string (the outbox's exact-quantity convention).
        qty: String(view.totalPickedQuantity ?? view.totalQuantity),
        ...(view.dispatch?.trackingRef ? { trackingRef: view.dispatch.trackingRef } : {}),
      },
    });
  }

  private async audit(tx: TenantTx, tenantId: string, actorUserId: string, action: string, targetId: string, idempotencyKey: string): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId,
      action,
      targetType: 'vendor_return',
      targetId,
      reference: idempotencyKey,
      occurredAt: nowIso(),
    });
  }

  private async replay(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<VendorReturnView | null> {
    const rows = await tx
      .select({ payloadHash: idempotencyKeys.payloadHash, responseSnapshot: idempotencyKeys.responseSnapshot })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot as VendorReturnView;
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

/** A9 — the dispatch hash's capture fields, in a fixed order, absent as null. */
export function captureHashFields(capture: NormalizedConsignmentCapture): Record<string, unknown> {
  return {
    brandDocumentType: capture.brandDocumentType,
    brandDocumentNumber: capture.brandDocumentNumber,
    brandDocumentDate: capture.brandDocumentDate,
    consignorGstin: capture.consignorGstin,
    debitNoteNumber: capture.debitNoteNumber,
    ewayBillNumber: capture.ewayBillNumber,
    ewayBillDate: capture.ewayBillDate,
    ewayValidUntil: capture.ewayValidUntil,
    transporterId: capture.transporterId === null ? null : String(capture.transporterId).toLowerCase(),
    carrierName: capture.carrierName,
    vehicleNumber: capture.vehicleNumber,
    trackingRef: capture.trackingRef,
    packageCount: capture.packageCount,
  };
}
