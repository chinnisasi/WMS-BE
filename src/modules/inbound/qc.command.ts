import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  bins,
  goodsReceiptLines,
  goodsReceiptNotes,
  idempotencyKeys,
  qcHolds,
  qcInspectionLines,
  qcInspections,
  skus,
} from '../../shared/db/schema';
import type { UserRole } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { assertRecordableQuantity, fromMilli, signedQuantity } from '../../shared/primitives/quantity';
import { uomPrecision } from '../catalog/uom';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import {
  DAMAGED_BIN_CODE,
  ensureDamagedBinInTx,
  ensureQcHoldBinInTx,
  QC_HOLD_BIN_CODE,
  RETURNS_BIN_CODE,
} from '../tenancy/receiving-bin';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertPermission, assertSecureBinAuthority } from '../tenancy/permissions';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { LedgerMovement } from '../inventory/inventory.facade';
import { canonicalInstant } from '../../shared/primitives/time';

// ── command inputs ───────────────────────────────────────────────────────────

export interface PlaceQcHoldCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  /** The scope's origin bin — captured at hold time; release returns here. */
  readonly binId: string;
  /** Why the stock is quarantined (free-form, carried verbatim). */
  readonly reason: string;
}

/**
 * Story 12-5 — the extracted in-transaction hold core's input: the same
 * fields `placeHold` carries, minus the command-shell concerns (the caller
 * owns authority, replay and idempotency; the helper owns the scope's
 * validation and every write).
 */
export interface HoldScopeInTxCommand {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly actorUserId: string;
  readonly skuId: string;
  readonly binId: string;
  readonly reason: string;
}

export interface ReleaseQcHoldCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly holdId: string;
}

/**
 * Story 1-2b — the hold kinds (`qc_holds.kind`, CHECK `qc_holds_kind_check`
 * in migration 0078): `manual` — an Ops Manager's or an excursion's (sku,
 * bin) scope hold, one open per scope; `receipt` — QC on receipt, one per
 * booked GRN line, never part of the one-per-scope rule. Story 4-7a adds
 * `return` — a returned unit quarantined out of the system RETURNS bin (its
 * origin: a release brings the units back to awaiting disposition), placed
 * by the returns module through `holdReturnLineInTx`; never part of the
 * one-per-scope rule either. Mirrored by `qc_holds_kind_check` (0097).
 */
export const QC_HOLD_KINDS = ['manual', 'receipt', 'return'] as const;
export type QcHoldKind = (typeof QC_HOLD_KINDS)[number];

/**
 * The hold statuses (`qc_holds.status`, CHECK `qc_holds_status_check`, 0014,
 * widened by 0091): `open` → `released` (a release) or `inspected` (story
 * 2-8a — an inspection outcome). Both closed states carry `released_by` /
 * `released_at`, read as "closed by / at". Pinned against the CHECK by
 * test/qc-inspection.spec.ts.
 */
export const QC_HOLD_STATUSES = ['open', 'released', 'inspected'] as const;
export type QcHoldStatus = (typeof QC_HOLD_STATUSES)[number];

/**
 * Story 2-8a — why inspected units failed (`qc_inspection_lines.fail_reason`,
 * CHECK `qc_inspection_lines_outcome_check`, 0091). `other` needs the note.
 * Pinned against the CHECK by test/qc-inspection.spec.ts.
 */
export const QC_FAIL_REASONS = ['damaged', 'expired', 'contaminated', 'wrong-item', 'spec-failure', 'other'] as const;
export type QcFailReason = (typeof QC_FAIL_REASONS)[number];

/** Story 2-8a — an inspection line's outcome (`qc_inspection_lines.outcome`). */
export const QC_INSPECTION_OUTCOMES = ['passed', 'failed'] as const;
export type QcInspectionOutcome = (typeof QC_INSPECTION_OUTCOMES)[number];

/** Story 2-8a — the outbox event of an inspection (resolves a manual hold's `qc-hold` entry). */
export const QC_HOLD_INSPECTED_EVENT = 'qc_hold.inspected';

/** Story 2-8a — the inspection note's ceiling (code points, after trimming). */
export const MAX_INSPECTION_NOTE_LENGTH = 500;

/** Story 2-8a — one held batch arm's outcome as the request sends it (base units). */
export interface InspectQcHoldLine {
  /** The arm's batch (null on an untracked SKU's single arm). */
  readonly batchId: string | null;
  /** Units that passed — back to the origin bin (Receiving for a receipt hold). */
  readonly passed: number;
  /** Units that failed, per reason — into the system DAMAGED bin. */
  readonly failed: readonly { readonly reason: QcFailReason; readonly quantity: number }[];
}

/** Story 2-8a — `POST …/qc-holds/:holdId/inspect`. */
export interface InspectQcHoldCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly holdId: string;
  /** One line per held batch arm, covering exactly the hold's arms. */
  readonly lines: readonly InspectQcHoldLine[];
  /** Optional (≤ 500 after trimming, blank = absent); required when a reason is `other`. */
  readonly note?: string | null | undefined;
}

/** Story 2-8a — one stored inspection row as every surface returns it (base units). */
export interface QcInspectionLineSnapshot {
  readonly batchId: string | null;
  readonly outcome: QcInspectionOutcome;
  readonly failReason: QcFailReason | null;
  readonly quantity: number;
}

/** Story 2-8a — the inspection that closed a hold. */
export interface QcInspectionSnapshot {
  readonly id: string;
  readonly holdId: string;
  readonly note: string | null;
  /** The hold's `released_by` / `released_at` — the single authority for who and when. */
  readonly inspectedBy: string;
  readonly inspectedAt: string;
  /** Σ passed / Σ failed, base units. */
  readonly passedQuantity: number;
  readonly failedQuantity: number;
  /** Ordered: batch (untracked first, then by id), passed before failed, failures by reason. */
  readonly lines: readonly QcInspectionLineSnapshot[];
}

/** Story 2-8a — the inspect answer (the idempotency snapshot). */
export interface InspectQcHoldSnapshot {
  readonly qcHold: QcHoldSnapshot['qcHold'];
  readonly inspection: QcInspectionSnapshot;
}

/** Story 2-8a — batch ids ordered untracked (null) first, then ascending — the one canonical arm order. */
export function compareBatchIds(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/** Story 2-8a — the canonical order of inspection rows (the snapshot's and the detail read's). */
export function compareInspectionLines(a: QcInspectionLineSnapshot, b: QcInspectionLineSnapshot): number {
  const byBatch = compareBatchIds(a.batchId, b.batchId);
  if (byBatch !== 0) return byBatch;
  if (a.outcome !== b.outcome) return a.outcome === 'passed' ? -1 : 1;
  const ra = a.failReason ?? '';
  const rb = b.failReason ?? '';
  return ra < rb ? -1 : ra > rb ? 1 : 0;
}

/**
 * Story 2-8a — the inspect body's SHAPE rules, above the transaction (guide
 * §1's first tier: a malformed request answers 400, never a replay): no
 * duplicate batch, no duplicate reason within a batch, `other` needs the
 * note, the note ≤ 500 after trimming (blank = absent). Returns the canonical
 * lines (sorted by batch, untracked first, failures by reason) and the
 * normalised note — exactly what the fingerprint hashes.
 */
export function normaliseInspection(command: Pick<InspectQcHoldCommand, 'lines' | 'note'>): {
  readonly lines: readonly InspectQcHoldLine[];
  readonly note: string | null;
} {
  const trimmed = command.note === undefined || command.note === null ? '' : command.note.trim();
  const note = trimmed === '' ? null : trimmed;
  if (note !== null && [...note].length > MAX_INSPECTION_NOTE_LENGTH) {
    throw qcValidation(`note is at most ${MAX_INSPECTION_NOTE_LENGTH} characters (got ${[...note].length}).`);
  }
  if (command.lines.length === 0) {
    throw qcValidation('lines must name every held batch arm of the hold (got none).');
  }
  const seen = new Set<string>();
  for (const line of command.lines) {
    const key = line.batchId ?? 'untracked';
    if (seen.has(key)) {
      throw qcValidation(
        line.batchId === null
          ? 'lines name the untracked arm (batchId null) twice — one line per held arm.'
          : `lines name batch "${line.batchId}" twice — one line per held arm.`,
      );
    }
    seen.add(key);
    const reasons = new Set<string>();
    for (const failure of line.failed) {
      if (!(QC_FAIL_REASONS as readonly string[]).includes(failure.reason)) {
        throw qcValidation(`reason must be one of ${JSON.stringify(QC_FAIL_REASONS)} (got "${String(failure.reason)}").`);
      }
      if (reasons.has(failure.reason)) {
        throw qcValidation(
          `${line.batchId === null ? 'the untracked arm' : `batch "${line.batchId}"`} names the fail reason "${failure.reason}" twice — give each reason once with its total.`,
        );
      }
      reasons.add(failure.reason);
      if (failure.reason === 'other' && note === null) {
        throw qcValidation('a failure with the reason "other" needs a note saying what failed.');
      }
    }
  }
  const lines = [...command.lines]
    .map((line) => ({
      batchId: line.batchId,
      passed: line.passed,
      failed: [...line.failed]
        .map((failure) => ({ reason: failure.reason, quantity: failure.quantity }))
        .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
    }))
    .sort((a, b) => compareBatchIds(a.batchId, b.batchId));
  return { lines, note };
}

/**
 * Story 1-2b — the outbox events of QC on receipt: ONE per receipt (or
 * approved excess) placed on holds, and one when every hold of that
 * placement is released. The notification panel's `qc-receipt` source keys
 * on `placementId` (the GRN for a receipt, the over-receipt for an approved
 * excess).
 */
export const QC_RECEIPT_PLACED_EVENT = 'qc_hold.receipt_placed';
export const QC_RECEIPT_CLEARED_EVENT = 'qc_hold.receipt_cleared';

/** Story 1-2b — one booked GRN line (or approved excess) held on receipt. */
export interface HoldReceiptLineInput {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly grnLineId: string;
  /** Set when the hold holds an approved over-receipt's excess. */
  readonly overReceiptId: string | null;
  /** The warehouse's system Receiving bin — the origin release returns to. */
  readonly receivingBinId: string;
  readonly batchId: string | null;
  /** Milli-units: exactly the line's applied quantity (or the approved excess). */
  readonly quantity: number;
  /** The device operator (a receipt) or the approver (an excess). */
  readonly actorUserId: string;
  /** The receipt's business time (or the approval's). */
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly reason: string;
}

/**
 * Story 4-7a — one return-receipt line's units (or part of them) quarantined
 * out of the system RETURNS bin. Milli-units.
 */
export interface HoldReturnLineInput {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  /** The warehouse's system RETURNS bin — the origin a release returns to. */
  readonly returnsBinId: string;
  readonly batchId: string | null;
  /** Milli-units (> 0). */
  readonly quantity: number;
  readonly actorUserId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  /** `return <RMA code> · <reasonCode>` (A14), at most 200 characters. */
  readonly reason: string;
}

/**
 * Story 4-7a (A23) — what QC's own record says about a return hold: its
 * status, the units it held (Σ its `qc.held` events) and, once closed, the
 * units that came back to the origin (all of them on a release; the passed
 * units on an inspection) and the units that failed (to DAMAGED). Milli-units.
 */
export interface ReturnHoldOutcome {
  readonly status: QcHoldStatus;
  readonly heldMilli: number;
  readonly returnedMilli: number;
  readonly failedMilli: number;
}

/** Story 2-9a — one GRN line's receipt-hold outcome, summed over its holds (milli-units). */
export interface ReceiptLineQcOutcome {
  readonly status: 'on-hold' | 'released' | 'inspected' | null;
  /** = on hold + released + passed + failed. */
  readonly heldMilli: number;
  readonly onHoldMilli: number;
  readonly releasedMilli: number;
  readonly passedMilli: number;
  readonly failedMilli: number;
}

interface InspectionTotals {
  passedMilli: number;
  failedMilli: number;
}

/**
 * Stories 4-7a and 2-9a — the per-hold arithmetic, over facts already read:
 * held = Σ the hold's `qc.held` events; returned = held on a release (a
 * release is all-or-nothing), the passed rows on an inspection; failed = the
 * failed rows. The map is a `Record` over `QcHoldStatus`, so a widened status
 * vocabulary fails `typecheck` here (A2). The ONE implementation both
 * `returnHoldOutcomeInTx` and `receiptQcOutcomesByGrnInTx` call.
 */
function holdOutcomeOf(status: QcHoldStatus, heldMilli: number, inspected: InspectionTotals | undefined): ReturnHoldOutcome {
  const byStatus: Record<QcHoldStatus, () => { returnedMilli: number; failedMilli: number }> = {
    open: () => ({ returnedMilli: 0, failedMilli: 0 }),
    released: () => ({ returnedMilli: heldMilli, failedMilli: 0 }),
    inspected: () => ({ returnedMilli: inspected?.passedMilli ?? 0, failedMilli: inspected?.failedMilli ?? 0 }),
  };
  return { status, heldMilli, ...byStatus[status]() };
}

/** Story 1-2b — `POST …/qc-holds/release-receipt`: every open receipt hold of one GRN. */
export interface ReleaseReceiptHoldsCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly grnId: string;
}

/** Story 1-2b — the release-receipt answer (the idempotency snapshot). */
export interface ReleaseReceiptHoldsSnapshot {
  readonly grnId: string;
  readonly grnCode: string;
  readonly qcHolds: readonly QcHoldSnapshot['qcHold'][];
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** One QC hold as every surface returns it (the idempotency snapshot). */
export interface QcHoldSnapshot {
  readonly qcHold: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly skuId: string;
    readonly binId: string;
    readonly reason: string;
    readonly status: QcHoldStatus;
    readonly heldBy: string;
    readonly heldAt: string;
    readonly releasedBy: string | null;
    readonly releasedAt: string | null;
    readonly createdAt: string;
    /**
     * Story 1-2b — `receipt` on a QC-on-receipt hold (with its GRN line).
     * Present only on a receipt hold, so a manual hold's answer is unchanged.
     */
    readonly kind?: QcHoldKind;
    readonly grnLineId?: string;
  };
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
/** The open-scope partial unique index (the 409 backstop's constraint name). */
const QC_HOLDS_OPEN_SCOPE_KEY = 'qc_holds_open_scope_unique';

/** Max reason length — a hold names why in one sentence, not an essay. */
const MAX_REASON_LENGTH = 200;

/**
 * The open holds riding one of the named bins, read inside the CALLER's
 * transaction (Story 3.6's bin-merge guard): a bin with an open hold can
 * neither be a merge source nor a merge target — the hold must keep its bin,
 * because the release returns the held stock to the origin bin it recorded.
 * `qc_holds` is an inbound-module-exclusive table; the tenancy command
 * composes this guard through this file-level helper (the shared
 * command-entry helper pattern — `assertWarehouseInTenant`'s mirror), never
 * by reaching into the table itself.
 */
export async function openQcHoldsForBinsInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  binIds: readonly string[],
): Promise<readonly { binId: string; holdId: string; skuId: string }[]> {
  if (binIds.length === 0) {
    return [];
  }
  const rows = await tx
    .select({ binId: qcHolds.binId, holdId: qcHolds.id, skuId: qcHolds.skuId })
    .from(qcHolds)
    .where(
      and(
        eq(qcHolds.tenantId, tenantId),
        eq(qcHolds.warehouseId, warehouseId),
        eq(qcHolds.status, 'open'),
        inArray(qcHolds.binId, [...binIds]),
      ),
    )
    .orderBy(asc(qcHolds.id));
  return rows;
}

/**
 * The same attribution, SKU-keyed (story 12-1): the open QC holds of ONE SKU,
 * tenant-wide — the catalog's SKU class-edit guard reads these to attribute
 * held stock to its ORIGIN bins (the held units sit in the QC-HOLD system
 * bin, which the on-hand scan cannot see and which the guard must not see —
 * staging is excluded there). Kept beside `openQcHoldsForBinsInTx` so both
 * guards read the table through this module's one seam.
 */
export async function openQcHoldsForSkuInTx(
  tx: TenantTx,
  tenantId: string,
  skuId: string,
): Promise<readonly { binId: string; holdId: string; skuId: string }[]> {
  const rows = await tx
    .select({ binId: qcHolds.binId, holdId: qcHolds.id, skuId: qcHolds.skuId })
    .from(qcHolds)
    .where(
      and(
        eq(qcHolds.tenantId, tenantId),
        eq(qcHolds.skuId, skuId),
        eq(qcHolds.status, 'open'),
      ),
    )
    .orderBy(asc(qcHolds.id));
  return rows;
}

/**
 * The QC hold/release commands (Story 3.4): an Ops Manager quarantines a
 * (sku, bin) scope — the stock RELOCATES through the ledger into the
 * warehouse's system QC-hold bin (real `qc.held` movements, never
 * zero-delta bookkeeping events and never direct `stock_on_hand` writes),
 * the row records the decision, and a release moves exactly the held units
 * back to the hold row's recorded origin bin with `qc.released` events (the
 * same batch arms the hold placed, derived from its own ledger events — no
 * partial release, mobile untouched). Story 2-8a adds the disposition: an
 * INSPECTION closes the hold with, per arm, passed units back to the origin
 * (`qc.released`) and failed units into the system DAMAGED bin
 * (`qc.failed`), recording the outcome and fail reasons.
 *
 * Invariant order (the `receiving.command.ts` shape) inside
 * `withTenantTransaction`: authority (fresh DB role read →
 * `assertPermission('qc.manage')`) → idempotency replay → validation →
 * movement(s) → hold-row write → in-tx outbox → idempotency-key snapshot.
 */
@Injectable()
export class QcCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition at the command layer through the facades only
    // (AD-6): the scope's stock reads and the ledger events via the inventory
    // facade's in-transaction passthroughs.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  /**
   * `qc-holds.place`: moves the whole (sku, bin) scope's on-hand into the
   * system QC-hold bin — one `qc.held` movement per batch on-hand row (the
   * batch arm carried for traceability; an untracked SKU moves on one
   * `batchRef: null` movement) — and records the open hold. An empty scope
   * is a 400 naming it; a scope with an open hold is a 409 (the partial
   * unique index backstops). ATP drops by the moved quantity the moment the
   * movement commits — the held stock is exactly the QC bin's on-hand.
   */
  async placeHold(command: PlaceQcHoldCommand, idempotencyKey: string): Promise<QcHoldSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      skuId: command.skuId,
      binId: command.binId,
      reason: command.reason,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── authority at command entry (the deliberate fail-closed order) ──
      // The role stays in scope: story 12-3's secure-bin authority gate
      // re-uses it in the hold core below, on the locked origin bin row.
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'qc.manage');

      // ── idempotency replay (before any write) ───────────────────────────
      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.tenantId, command.tenantId), eq(idempotencyKeys.key, idempotencyKey)),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].payloadHash !== payloadHash) {
          throw idempotencyKeyReuse();
        }
        return existing[0].responseSnapshot as QcHoldSnapshot;
      }

      // ── input validation (400 before any write) ────────────────────────
      if (command.reason.trim() === '' || command.reason.length > MAX_REASON_LENGTH) {
        throw qcValidation(
          `reason is required (at most ${MAX_REASON_LENGTH} characters) — a hold names why the stock is quarantined.`,
        );
      }

      // Master-data integrity in the write transaction (404 before any write):
      // warehouse in tenant, SKU in tenant, bin in the tenant's warehouse.
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

      // ── the scope's validation + every write (Story 12-5 extraction) ───
      // The movement+row-write core lives in `holdScopeInTx` so the excursion
      // command quarantines through the ONE hold implementation; `placeHold`
      // stays the behavior-identical shell around it (its suite pins it).
      const snapshot = await this.holdScopeInTx(tx, command, role, idempotencyKey);

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 12-5 — the in-transaction hold core, extracted from `placeHold` so
   * a sibling module (the compliance module's excursion command) quarantines
   * a (sku, bin) scope through the ONE implementation of the hold semantics
   * instead of a fork: SKU tracking refusals, the locked origin-bin read, the
   * system-bin refusal, the 12-3 secure authority gate, the one-open-hold
   * 409, the per-batch `qc.held` movements into the system QC-hold bin, the
   * hold row, the outbox append and the audit row.
   *
   * The caller owns everything above the scope: authority (`assertPermission`
   * on a fresh role read), the idempotency replay lookup and the payload-hash
   * commit marker. `role` is passed in because the secure-bin gate rules on
   * the CALLER's authority, already re-read per AD-10. Runs inside the
   * CALLER's transaction (the `…InTx` convention) — it opens nothing and
   * commits nothing itself.
   */
  async holdScopeInTx(
    tx: TenantTx,
    command: HoldScopeInTxCommand,
    role: UserRole,
    auditReference: string,
  ): Promise<QcHoldSnapshot> {
    const skuRows = await tx
      .select({
        id: skus.id,
        serialTracked: skus.serialTracked,
        catchWeightTracked: skus.catchWeightTracked,
      })
      .from(skus)
      .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
      .limit(1);
    if (skuRows[0] === undefined) {
      throw notFound('SKU', command.skuId);
    }
    // A serial-tracked scope cannot be held bulk: the movements carry no
    // serial arms, so the serials' location records would stay at the
    // origin bin while their stock relocates to the QC bin — divergence
    // with no repair path. Refuse before any movement is appended.
    if (skuRows[0].serialTracked) {
      throw qcValidation(
        `SKU ${command.skuId} is serial-tracked — a bulk (sku, bin) QC hold would strand its serial location records at the origin bin, so it cannot be quarantined as a whole scope.`,
      );
    }
    // Story 10.3: the same reasoning, transferred verbatim to catch weight.
    // `placeHold` moves a whole `(sku, bin)` scope and carries NO per-unit
    // identifiers, and a handling unit has no location between receipt and
    // pack — so nothing here could say WHICH cases were quarantined. The
    // rule the story turns on is that every path which can consume a unit
    // either names units explicitly or is refused: adjustment names them,
    // and this one is refused. Accepting it silently would leave the held
    // units `active` and packable, which is the fail-open this whole
    // status column exists to prevent. Refused and deferred beats quietly
    // wrong; per-unit quarantine is epic 15's, alongside move-as-unit.
    if (skuRows[0].catchWeightTracked) {
      throw qcValidation(
        `SKU ${command.skuId} is catch-weight tracked — a bulk (sku, bin) QC hold names no handling units, so its cases would stay packable while their stock sat in the QC bin. Quarantining catch-weight stock is not supported; write the affected cases off by naming them on a stock adjustment instead.`,
      );
    }
    const binRows = await tx
      .select({
        id: bins.id,
        code: bins.code,
        systemOwned: bins.systemOwned,
        // Story 12-3 — the class the secure-origin authority gate rules on.
        storageClass: bins.storageClass,
      })
      .from(bins)
      .where(
        and(
          eq(bins.id, command.binId),
          eq(bins.tenantId, command.tenantId),
          eq(bins.warehouseId, command.warehouseId),
        ),
      )
      .limit(1)
      // The bin row locks here (the same row the merge/retire commands lock
      // id-sorted), so a hold cannot commit alongside a concurrent
      // merge/retire of its bin — stock never double-moves and a hold is
      // never stranded on a bin that retires underneath it.
      .for('update');
    const originBin = binRows[0];
    if (originBin === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'Bin not found',
        `No bin with id "${command.binId}" exists in this warehouse.`,
      );
    }
    // The QC-hold bin's contents are already held — re-holding it would
    // fabricate a second hold whose "scope" is the hold bin itself.
    if (originBin.systemOwned && originBin.code === QC_HOLD_BIN_CODE) {
      throw qcValidation(
        'The system QC-hold bin cannot be a hold origin — its contents are already quarantined.',
      );
    }
    // Story 13-2: neither can the system RETURNS bin — its contents are
    // returned units awaiting disposition (already outside ATP); only 13-3's
    // disposition moves them, and a QC hold drawing them out would strand a
    // returned unit with no disposition record.
    if (originBin.systemOwned && originBin.code === RETURNS_BIN_CODE) {
      throw qcValidation(
        'The system RETURNS bin cannot be a hold origin — its contents are returned units awaiting disposition.',
      );
    }
    // Story 2-4a: nor can the system DAMAGED bin — its contents are units
    // received damaged (already outside ATP) that leave only by a write-off;
    // a hold drawing them out would put unsellable units back on a release
    // path to a sellable bin.
    if (originBin.systemOwned && originBin.code === DAMAGED_BIN_CODE) {
      throw qcValidation(
        'The system DAMAGED bin cannot be a hold origin — its contents are units received damaged or failed at QC, which leave by a write-off or a return to vendor.',
      );
    }
    // ── story 12-3: the secure-bin authority gate (FR-42) — on the locked
    // origin row: held units LEAVE the origin bin, so a SECURE origin
    // additionally requires `secure.move`, the (role, bin) authority
    // decided on the row already in hand. Non-denying today (the matrix
    // invariant keeps the subset enforced): `qc.manage` and `secure.move`
    // are held by exactly the same roles. Non-secure holds are
    // byte-identical to the pre-12.3 build. A replayed idempotency key
    // returns the cached success before this gate — the original
    // authorized execution already decided; that is deliberate
    // idempotency semantics.
    assertSecureBinAuthority(role, [originBin]);

    // ── one open MANUAL hold per (tenant, warehouse, sku, bin) scope ───
    // Story 1-2b: the same predicate as the partial unique index
    // (`status = 'open' AND kind = 'manual'`) — a receipt hold on the scope
    // neither blocks nor counts as a manual one.
    const openRows = await tx
      .select({ id: qcHolds.id })
      .from(qcHolds)
      .where(
        and(
          eq(qcHolds.tenantId, command.tenantId),
          eq(qcHolds.warehouseId, command.warehouseId),
          eq(qcHolds.skuId, command.skuId),
          eq(qcHolds.binId, command.binId),
          eq(qcHolds.status, 'open'),
          eq(qcHolds.kind, 'manual'),
        ),
      )
      .limit(1);
    if (openRows[0] !== undefined) {
      throw new ProblemException(
        'qc-hold-open',
        409,
        'This scope is already QC-held',
        `An open QC hold (${openRows[0].id}) already covers this (sku, bin) scope — release it before placing another.`,
      );
    }

    // ── the scope's stock (the movement's magnitude, per batch arm) ────
    const scope = await this.inventory.qcScopeOnHandInTx(
      tx,
      command.tenantId,
      command.warehouseId,
      command.skuId,
      command.binId,
    );
    if (scope.quantity <= 0) {
      throw qcValidation(
        `The (sku, bin) scope (${command.skuId} at ${command.binId}) has ${fromMilli(scope.quantity)} on-hand units — a hold quarantines stock that exists.`,
      );
    }
    // The batch rows sum to the plain quantity on a batch-tracked SKU; an
    // untracked SKU carries none and moves on one `batchRef: null` arm.
    const arms =
      scope.batches.length > 0
        ? scope.batches
        : [{ batchId: null as string | null, quantity: scope.quantity }];

    // ── the movements + the hold row (one tx, the ledger is the record) ─
    const holdId = uuidv7();
    const qcBin = await ensureQcHoldBinInTx(tx, command.tenantId, command.warehouseId);
    const heldAt = nowIso();
    for (const arm of arms) {
      if (arm.quantity <= 0) {
        continue; // a zero batch row moves nothing (the plain sum still covers the scope)
      }
      const movement: LedgerMovement = {
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        type: 'qc.held',
        skuId: command.skuId,
        quantityDelta: signedQuantity(arm.quantity),
        fromBinId: command.binId,
        toBinId: qcBin.binId,
        batchRef: arm.batchId,
        serialRef: null,
        actorUserId: command.actorUserId,
        occurredAt: heldAt,
        recordedAt: heldAt,
        referenceDoc: {
          kind: 'qc-hold',
          holdId,
          fromBinId: command.binId,
        },
      };
      await this.inventory.appendLedgerEventInTx(tx, movement);
    }

    try {
      await tx.insert(qcHolds).values({
        id: holdId,
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        skuId: command.skuId,
        binId: command.binId,
        reason: command.reason,
        status: 'open',
        heldBy: command.actorUserId,
        heldAt,
      });
    } catch (err) {
      if (isUniqueViolationOn(err, QC_HOLDS_OPEN_SCOPE_KEY)) {
        // A concurrent hold for the same open scope won the index — the
        // deterministic double-hold outcome either way.
        throw new ProblemException(
          'qc-hold-open',
          409,
          'This scope is already QC-held',
          'An open QC hold already covers this (sku, bin) scope (a concurrent hold won) — release it before placing another.',
        );
      }
      throw err;
    }

    const snapshot: QcHoldSnapshot = {
      qcHold: {
        id: holdId,
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        skuId: command.skuId,
        binId: command.binId,
        reason: command.reason,
        status: 'open',
        heldBy: command.actorUserId,
        heldAt,
        releasedBy: null,
        releasedAt: null,
        createdAt: heldAt,
      },
    };

    // ── in-transaction outbox append (AD-7) ─────────────────────────────
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId: command.tenantId,
      type: 'qc_hold.placed',
      occurredAt: heldAt,
      payload: {
        holdId,
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        skuId: command.skuId,
        binId: command.binId,
        reason: command.reason,
        heldBy: command.actorUserId,
        heldAt,
      },
    });

    // ── the audit row (the caller owns the idempotency key) ─────────────
    // `auditReference` is the caller's correlation value — `placeHold`
    // passes its idempotency key (the pre-extraction behavior, unchanged);
    // the excursion passes the excursion id.
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      action: 'qc_hold.placed',
      targetType: 'qc_hold',
      targetId: holdId,
      reference: auditReference,
      occurredAt: heldAt,
    });

    return snapshot;
  }

  /**
   * Story 1-2b — QC on receipt: hold ONE booked GRN line (or one approved
   * excess), in the CALLER's transaction. The movement write of
   * `holdScopeInTx` WITHOUT the scope read, the bin lock or the role gate:
   * it never reads or sweeps the (sku, Receiving) scope — exactly this
   * line's quantity moves, one `qc.held` on the line's batch arm, from the
   * Receiving bin into the QC-HOLD bin — and it is a consequence of the
   * receipt, not an Ops Manager's act. The hold row is `kind = 'receipt'`,
   * names its GRN line (and the over-receipt, for an excess), and records
   * the Receiving bin as its origin (release returns the units there, where
   * they become putaway work). No outbox event and no audit row here: the
   * caller writes ONE of each per receipt. Returns the hold id.
   */
  async holdReceiptLineInTx(tx: TenantTx, input: HoldReceiptLineInput): Promise<string> {
    const holdId = uuidv7();
    const qcBin = await ensureQcHoldBinInTx(tx, input.tenantId, input.warehouseId);
    await this.inventory.appendLedgerEventInTx(tx, {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      type: 'qc.held',
      skuId: input.skuId,
      quantityDelta: signedQuantity(input.quantity),
      fromBinId: input.receivingBinId,
      toBinId: qcBin.binId,
      batchRef: input.batchId,
      serialRef: null,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      recordedAt: input.recordedAt,
      referenceDoc: {
        kind: 'qc-hold',
        holdId,
        fromBinId: input.receivingBinId,
      },
    });
    await tx.insert(qcHolds).values({
      id: holdId,
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      skuId: input.skuId,
      binId: input.receivingBinId,
      reason: input.reason,
      status: 'open',
      heldBy: input.actorUserId,
      heldAt: input.occurredAt,
      kind: 'receipt',
      grnLineId: input.grnLineId,
      overReceiptId: input.overReceiptId,
    });
    return holdId;
  }

  /**
   * Story 4-7a — quarantine part of a return-receipt line, in the CALLER's
   * transaction (the returns module's disposition command, through
   * `QcFacade`): one `qc.held` RETURNS → QC-HOLD on the line's batch arm and
   * an open hold of kind `return` whose origin is the RETURNS bin, so a
   * release (or 2-8a's passed units) brings the units back to awaiting
   * disposition. The `holdReceiptLineInTx` shape — no scope read, no bin lock,
   * no role gate (the caller holds `returns.manage`) — plus the
   * `qc_hold.placed` outbox event in the manual hold's exact payload shape, so
   * the existing `qc-hold` notification raises and its release resolves it
   * (a return hold's release payload carries no `kind`). No audit row: the
   * caller writes one per command. Returns the hold id.
   */
  async holdReturnLineInTx(tx: TenantTx, input: HoldReturnLineInput): Promise<string> {
    if (input.reason.trim() === '' || input.reason.length > MAX_REASON_LENGTH) {
      throw qcValidation(`reason is required (at most ${MAX_REASON_LENGTH} characters).`);
    }
    const holdId = uuidv7();
    const qcBin = await ensureQcHoldBinInTx(tx, input.tenantId, input.warehouseId);
    await this.inventory.appendLedgerEventInTx(tx, {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      type: 'qc.held',
      skuId: input.skuId,
      quantityDelta: signedQuantity(input.quantity),
      fromBinId: input.returnsBinId,
      toBinId: qcBin.binId,
      batchRef: input.batchId,
      serialRef: null,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      recordedAt: input.recordedAt,
      referenceDoc: { kind: 'qc-hold', holdId, fromBinId: input.returnsBinId },
    });
    await tx.insert(qcHolds).values({
      id: holdId,
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      skuId: input.skuId,
      binId: input.returnsBinId,
      reason: input.reason,
      status: 'open',
      heldBy: input.actorUserId,
      heldAt: input.recordedAt,
      kind: 'return',
    });
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId: input.tenantId,
      type: 'qc_hold.placed',
      occurredAt: input.recordedAt,
      payload: {
        holdId,
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        skuId: input.skuId,
        binId: input.returnsBinId,
        reason: input.reason,
        heldBy: input.actorUserId,
        heldAt: input.recordedAt,
      },
    });
    return holdId;
  }

  /**
   * Story 4-7a (A23) — one hold's outcome from QC's OWN record, in the
   * caller's transaction (the returns hold-settlement subscriber reads it;
   * it never trusts an event payload): held = Σ the hold's `qc.held` events;
   * returned = held on a release (a release is all-or-nothing), the passed
   * rows on an inspection; failed = the failed rows. Null for an unknown hold.
   * The status map is a `Record` over `QcHoldStatus`, so a widened status
   * vocabulary fails `typecheck` here (A2).
   */
  async returnHoldOutcomeInTx(tx: TenantTx, tenantId: string, holdId: string): Promise<ReturnHoldOutcome | null> {
    const rows = await tx
      .select({ id: qcHolds.id, status: qcHolds.status, warehouseId: qcHolds.warehouseId })
      .from(qcHolds)
      .where(and(eq(qcHolds.tenantId, tenantId), eq(qcHolds.id, holdId)))
      .limit(1);
    const hold = rows[0];
    if (hold === undefined) return null;
    const arms = await this.inventory.qcHeldArmsInTx(tx, tenantId, hold.warehouseId, hold.id);
    const heldMilli = arms.reduce((sum, arm) => sum + arm.quantity, 0);
    const status = hold.status as QcHoldStatus;
    // The inspection rows are read only for an inspected hold (one-hold map).
    const inspected = status === 'inspected' ? await this.inspectionTotalsInTx(tx, tenantId, [hold.id]) : new Map<string, InspectionTotals>();
    return holdOutcomeOf(status, heldMilli, inspected.get(hold.id));
  }

  /**
   * Story 2-9a (decision 9, A12) — the QC outcome of every RECEIPT hold on
   * the given lines of one GRN, from QC's own record, summed per line (two
   * holds may share a line — PENDING 1-2b). Three set-based reads, never one
   * per hold: the holds; the grouped `qc.held` ledger totals
   * (`InventoryFacade.qcHeldTotalsInTx`, the grouped form of
   * `qcHeldArmsInTx`'s predicate); one inspection aggregate. Each hold goes
   * through `holdOutcomeOf` — the SAME per-hold arithmetic
   * `returnHoldOutcomeInTx` uses, so the two can never diverge. A line's
   * status is `on-hold` if any hold is open, else `inspected` if any was
   * inspected, else `released`, else absent from the map. A manual hold
   * names no GRN line and is out of scope. `grnLineIds` are the caller's
   * already-scoped lines (the portal read reached them through the client's
   * SKUs), so the read never widens the scope.
   */
  async receiptQcOutcomesByGrnInTx(
    tx: TenantTx,
    tenantId: string,
    grnId: string,
    grnLineIds: readonly string[],
  ): Promise<Map<string, ReceiptLineQcOutcome>> {
    const out = new Map<string, ReceiptLineQcOutcome>();
    if (grnLineIds.length === 0) return out;
    const holds = await tx
      .select({ id: qcHolds.id, status: qcHolds.status, warehouseId: qcHolds.warehouseId, grnLineId: qcHolds.grnLineId })
      .from(qcHolds)
      .innerJoin(goodsReceiptLines, and(eq(goodsReceiptLines.tenantId, qcHolds.tenantId), eq(goodsReceiptLines.id, qcHolds.grnLineId)))
      .where(
        and(
          eq(qcHolds.tenantId, tenantId),
          eq(qcHolds.kind, 'receipt'),
          inArray(qcHolds.grnLineId, [...grnLineIds]),
          eq(goodsReceiptLines.grnId, grnId),
        ),
      );
    if (holds.length === 0) return out;
    const held = await this.inventory.qcHeldTotalsInTx(
      tx,
      tenantId,
      [...new Set(holds.map((hold) => hold.warehouseId))],
      holds.map((hold) => hold.id),
    );
    const inspectedIds = holds.filter((hold) => hold.status === 'inspected').map((hold) => hold.id);
    const inspected = inspectedIds.length === 0 ? new Map<string, InspectionTotals>() : await this.inspectionTotalsInTx(tx, tenantId, inspectedIds);
    const acc = new Map<string, { held: number; onHold: number; released: number; passed: number; failed: number; statuses: Set<QcHoldStatus> }>();
    for (const hold of holds) {
      const status = hold.status as QcHoldStatus;
      const outcome = holdOutcomeOf(status, held.get(hold.id)?.quantity ?? 0, inspected.get(hold.id));
      const entry = acc.get(hold.grnLineId!) ?? { held: 0, onHold: 0, released: 0, passed: 0, failed: 0, statuses: new Set<QcHoldStatus>() };
      entry.held += outcome.heldMilli;
      if (status === 'open') entry.onHold += outcome.heldMilli;
      if (status === 'released') entry.released += outcome.returnedMilli;
      if (status === 'inspected') entry.passed += outcome.returnedMilli;
      entry.failed += outcome.failedMilli;
      entry.statuses.add(status);
      acc.set(hold.grnLineId!, entry);
    }
    for (const [lineId, entry] of acc) {
      out.set(lineId, {
        status: entry.statuses.has('open') ? 'on-hold' : entry.statuses.has('inspected') ? 'inspected' : entry.statuses.has('released') ? 'released' : null,
        heldMilli: entry.held,
        onHoldMilli: entry.onHold,
        releasedMilli: entry.released,
        passedMilli: entry.passed,
        failedMilli: entry.failed,
      });
    }
    return out;
  }

  /** Passed and failed milli-units per hold, one grouped read over the inspection lines. */
  private async inspectionTotalsInTx(tx: TenantTx, tenantId: string, holdIds: readonly string[]): Promise<Map<string, InspectionTotals>> {
    const rows = await tx
      .select({
        holdId: qcInspections.holdId,
        outcome: qcInspectionLines.outcome,
        quantity: sql<string>`sum(${qcInspectionLines.quantity})::bigint`,
      })
      .from(qcInspectionLines)
      .innerJoin(
        qcInspections,
        and(eq(qcInspections.tenantId, qcInspectionLines.tenantId), eq(qcInspections.id, qcInspectionLines.inspectionId)),
      )
      .where(and(eq(qcInspections.tenantId, tenantId), inArray(qcInspections.holdId, [...holdIds])))
      .groupBy(qcInspections.holdId, qcInspectionLines.outcome);
    const out = new Map<string, InspectionTotals>();
    for (const row of rows) {
      const entry = out.get(row.holdId) ?? { passedMilli: 0, failedMilli: 0 };
      if (row.outcome === 'passed') entry.passedMilli += Number(row.quantity);
      else entry.failedMilli += Number(row.quantity);
      out.set(row.holdId, entry);
    }
    return out;
  }

  /**
   * `qc-holds/:id/release`: moves the hold's stock back to the hold row's
   * recorded origin bin — exactly the units its own `qc.held` events moved
   * in (same batch arms, replayed from the ledger), never a caller-chosen
   * bin — and marks the row `released`. A second release (or a release of an
   * inspected hold) is a deterministic 409; an origin bin that has gone
   * missing mid-hold is a 409 and the hold stays open. A failed inspection is
   * `inspectHold` (story 2-8a), not a release.
   */
  async releaseHold(command: ReleaseQcHoldCommand, idempotencyKey: string): Promise<QcHoldSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      holdId: command.holdId,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── authority at command-service entry (the fail-closed order) ──────
      // The role stays in scope: story 12-3's secure-bin authority gate
      // re-uses it below, on the origin bin read.
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'qc.manage');

      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.tenantId, command.tenantId), eq(idempotencyKeys.key, idempotencyKey)),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].payloadHash !== payloadHash) {
          throw idempotencyKeyReuse();
        }
        return existing[0].responseSnapshot as QcHoldSnapshot;
      }

      const rows = await tx
        .select()
        .from(qcHolds)
        .where(and(eq(qcHolds.id, command.holdId), eq(qcHolds.tenantId, command.tenantId)))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'QC hold not found',
          `No QC hold with id "${command.holdId}" exists in this tenant.`,
        );
      }
      if (row.status !== 'open') {
        throw qcHoldClosed(row.id, row.status);
      }

      const snapshot = await this.releaseHoldCoreInTx(tx, row, role, command.actorUserId);

      // ── the audit row (the outbox event rode the core) ──────────────────
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'qc_hold.released',
        targetType: 'qc_hold',
        targetId: row.id,
        reference: idempotencyKey,
        occurredAt: snapshot.qcHold.releasedAt!,
      });

      // Story 1-2b — releasing the last open hold of a receipt placement
      // resolves its `qc-receipt` notification.
      if (row.kind === 'receipt') {
        await this.emitReceiptClearedInTx(tx, command.tenantId, [row]);
      }

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 1-2b — `POST …/qc-holds/release-receipt {grnId}` (`qc.manage`,
   * keyed): releases EVERY open receipt hold of one GRN in one transaction,
   * each exactly as `releaseHold` releases one (its own arms back to the
   * Receiving bin — putaway work again). The skeleton: hash `{arm:
   * 'release-receipt', tenantId, grnId}` → authority → replay → the GRN
   * (404) → its open receipt holds locked `FOR UPDATE` in id order → replay
   * again under the locks → none open: 409 `qc-hold-released` → each
   * release → ONE audit row `qc_hold.receipt_released` (target the GRN) →
   * the placements' notifications resolve → the key LAST.
   */
  async releaseReceiptHolds(
    command: ReleaseReceiptHoldsCommand,
    idempotencyKey: string,
  ): Promise<ReleaseReceiptHoldsSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'release-receipt',
      tenantId: command.tenantId,
      grnId: command.grnId,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'qc.manage');
      const replayed = await this.replayReceipt(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      const grnRows = await tx
        .select({ id: goodsReceiptNotes.id, code: goodsReceiptNotes.code })
        .from(goodsReceiptNotes)
        .where(and(eq(goodsReceiptNotes.tenantId, command.tenantId), eq(goodsReceiptNotes.id, command.grnId)))
        .limit(1);
      const grn = grnRows[0];
      if (grn === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Goods receipt not found',
          `No goods receipt with id "${command.grnId}" exists in this tenant.`,
        );
      }
      const rows = await tx
        .select()
        .from(qcHolds)
        .where(
          and(
            eq(qcHolds.tenantId, command.tenantId),
            eq(qcHolds.kind, 'receipt'),
            eq(qcHolds.status, 'open'),
            inArray(
              qcHolds.grnLineId,
              tx
                .select({ id: goodsReceiptLines.id })
                .from(goodsReceiptLines)
                .where(and(eq(goodsReceiptLines.tenantId, command.tenantId), eq(goodsReceiptLines.grnId, grn.id))),
            ),
          ),
        )
        .orderBy(asc(qcHolds.id))
        .for('update');
      const replayedUnderLock = await this.replayReceipt(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }
      if (rows.length === 0) {
        throw new ProblemException(
          'qc-hold-released',
          409,
          'No open receipt holds',
          `Goods receipt "${grn.code}" has no open QC-on-receipt hold — every one is already released.`,
        );
      }
      const released: QcHoldSnapshot['qcHold'][] = [];
      for (const row of rows) {
        released.push((await this.releaseHoldCoreInTx(tx, row, role, command.actorUserId)).qcHold);
      }
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'qc_hold.receipt_released',
        targetType: 'goods_receipt',
        targetId: grn.id,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });
      await this.emitReceiptClearedInTx(tx, command.tenantId, rows);
      const snapshot: ReleaseReceiptHoldsSnapshot = { grnId: grn.id, grnCode: grn.code, qcHolds: released };
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 2-8a — `POST …/qc-holds/:holdId/inspect` (`qc.manage`, keyed): the
   * inspection outcome closes an OPEN hold in one transaction. For every batch
   * arm the hold moved, the request gives the passed units and the failed
   * units per reason, summing exactly to the arm (whole-hold inspection — no
   * remainder stays held). Passed units go back exactly as a release returns
   * them (`qc.released`, QC-HOLD → the origin; Receiving for a receipt hold,
   * where they are putaway work again); failed units relocate QC-HOLD →
   * DAMAGED (`qc.failed`), where 2-4a's rules apply (ATP-excluded, write-off
   * only). The hold closes `inspected` (`released_by` / `released_at` = the
   * inspector, now); the inspection and its lines are stored.
   *
   * The skeleton: shape (above the tx) → hash → `qc.manage` → replay → the
   * hold `FOR UPDATE` (404) → replay again → status (409 `qc-hold-released`)
   * → the SKU's precision → the held arms match (422
   * `qc-inspection-mismatch`) → passed > 0: the origin `FOR UPDATE`, gone,
   * secure gate → the QC-HOLD bin → failed > 0: the DAMAGED bin (409
   * `damaged-bin-conflict`) → the ledger → the conditional UPDATE → the
   * inspection rows → outbox `qc_hold.inspected` (and, for a receipt hold,
   * `qc_hold.receipt_cleared` when its placement has nothing open) → audit
   * `qc_hold.inspected` → the key LAST. Lock order: hold → origin → (the
   * system bins are ensured, never locked) → the warehouse advisory inside the
   * ledger append.
   */
  async inspectHold(command: InspectQcHoldCommand, idempotencyKey: string): Promise<InspectQcHoldSnapshot> {
    // ── shape, above the transaction (400 before any replay) ─────────────
    const normalised = normaliseInspection(command);
    // The fingerprint: the hold, the canonical lines with the quantities as
    // sent (base units) and the normalised note.
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      holdId: command.holdId,
      lines: normalised.lines.map((line) => ({
        batchId: line.batchId,
        passed: line.passed,
        failed: line.failed.map((failure) => ({ reason: failure.reason, quantity: failure.quantity })),
      })),
      note: normalised.note,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'qc.manage');

      const replayed = await this.replayInspection(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      // ── the hold, locked (a lock helper never checks status — guide §1) ─
      const rows = await tx
        .select()
        .from(qcHolds)
        .where(and(eq(qcHolds.id, command.holdId), eq(qcHolds.tenantId, command.tenantId)))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'QC hold not found',
          `No QC hold with id "${command.holdId}" exists in this tenant.`,
        );
      }
      // A same-key duplicate parked on the lock replays the winner's answer.
      const replayedUnderLock = await this.replayInspection(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (row.status !== 'open') {
        throw qcHoldClosed(row.id, row.status);
      }

      // ── the precision refusal (behind the replay lookup, after the SKU) ─
      const skuRows = await tx
        .select({ uom: skus.uom })
        .from(skus)
        .where(and(eq(skus.id, row.skuId), eq(skus.tenantId, command.tenantId)))
        .limit(1);
      if (skuRows[0] === undefined) {
        throw notFound('SKU', row.skuId);
      }
      const uom = skuRows[0].uom;
      const precision = uomPrecision(uom);
      const lines = normalised.lines.map((line, index) => ({
        batchId: line.batchId,
        passed: assertRecordableQuantity(line.passed, `lines[${index}].passed`, uom, precision),
        failed: line.failed.map((failure, at) => ({
          reason: failure.reason,
          quantity: assertRecordableQuantity(failure.quantity, `lines[${index}].failed[${at}].quantity`, uom, precision),
        })),
      }));

      // ── the held arms are the truth: the lines must cover exactly them ──
      const heldEvents = await this.inventory.qcHeldArmsInTx(tx, command.tenantId, row.warehouseId, row.id);
      const held = new Map<string | null, number>();
      for (const event of heldEvents) {
        held.set(event.batchRef, (held.get(event.batchRef) ?? 0) + event.quantity);
      }
      if (held.size === 0) {
        // Unreachable short of ledger tampering (the release core's twin).
        throw new ProblemException(
          'qc-hold-origin-bin-gone',
          409,
          'QC hold has no ledger movements',
          `QC hold "${row.id}" carries no qc.held movements — the ledger is its movement record; refusing a blind inspection.`,
        );
      }
      const heldText = (): string =>
        [...held]
          .sort(([a], [b]) => compareBatchIds(a, b))
          .map(([batch, qty]) => `${batch === null ? 'the untracked arm' : `batch "${batch}"`} ${fromMilli(qty)} ${uom}`)
          .join(', ');
      for (const line of lines) {
        const arm = held.get(line.batchId);
        if (arm === undefined) {
          throw qcInspectionMismatch(
            `QC hold "${row.id}" holds no ${line.batchId === null ? 'untracked arm' : `batch "${line.batchId}"`} — it holds ${heldText()}. Send one line per held arm.`,
          );
        }
        const total = line.passed + line.failed.reduce((sum, failure) => sum + failure.quantity, 0);
        if (total !== arm) {
          throw qcInspectionMismatch(
            `${line.batchId === null ? 'The untracked arm' : `Batch "${line.batchId}"`} of QC hold "${row.id}" holds ${fromMilli(arm)} ${uom}, but passed + failed is ${fromMilli(total)} — they must add up exactly (it holds ${heldText()}).`,
          );
        }
      }
      if (lines.length !== held.size) {
        const named = new Set(lines.map((line) => line.batchId));
        const missing = [...held.keys()].filter((batch) => !named.has(batch)).sort(compareBatchIds);
        throw qcInspectionMismatch(
          `The inspection leaves ${missing.map((batch) => (batch === null ? 'the untracked arm' : `batch "${batch}"`)).join(', ')} of QC hold "${row.id}" out — it holds ${heldText()}. Every held arm needs a line.`,
        );
      }
      const passedTotal = lines.reduce((sum, line) => sum + line.passed, 0);
      const failedTotal = lines.reduce((sum, line) => sum + line.failed.reduce((s2, failure) => s2 + failure.quantity, 0), 0);

      // ── where the units go: the origin only when something passes ──────
      if (passedTotal > 0) {
        await this.lockOriginBinInTx(tx, row, role);
      }
      const qcBin = await ensureQcHoldBinInTx(tx, command.tenantId, row.warehouseId);
      const damagedBin = failedTotal > 0 ? await ensureDamagedBinInTx(tx, command.tenantId, row.warehouseId) : null;

      // ── the ledger: qc.released for passed units, qc.failed for failed ──
      const inspectionId = uuidv7();
      const inspectedAt = nowIso();
      for (const line of lines) {
        const failed = line.failed.reduce((sum, failure) => sum + failure.quantity, 0);
        if (line.passed > 0) {
          await this.inventory.appendLedgerEventInTx(tx, {
            tenantId: command.tenantId,
            warehouseId: row.warehouseId,
            type: 'qc.released',
            skuId: row.skuId,
            quantityDelta: signedQuantity(line.passed),
            fromBinId: qcBin.binId,
            toBinId: row.binId,
            batchRef: line.batchId,
            serialRef: null,
            actorUserId: command.actorUserId,
            occurredAt: inspectedAt,
            recordedAt: inspectedAt,
            referenceDoc: { kind: 'qc-hold', holdId: row.id, inspectionId },
          });
        }
        if (failed > 0 && damagedBin !== null) {
          await this.inventory.appendLedgerEventInTx(tx, {
            tenantId: command.tenantId,
            warehouseId: row.warehouseId,
            type: 'qc.failed',
            skuId: row.skuId,
            quantityDelta: signedQuantity(failed),
            fromBinId: qcBin.binId,
            toBinId: damagedBin.binId,
            batchRef: line.batchId,
            serialRef: null,
            actorUserId: command.actorUserId,
            occurredAt: inspectedAt,
            recordedAt: inspectedAt,
            // `grnLineId` only on a receipt hold — omitted, never null (guide §4).
            referenceDoc: {
              kind: 'qc-hold',
              holdId: row.id,
              ...(row.grnLineId === null ? {} : { grnLineId: row.grnLineId }),
              inspectionId,
            },
          });
        }
      }

      // ── the hold closes (conditional — a terminal transition) ──────────
      const closed = await tx
        .update(qcHolds)
        .set({ status: 'inspected', releasedBy: command.actorUserId, releasedAt: inspectedAt, updatedAt: inspectedAt })
        .where(and(eq(qcHolds.id, row.id), eq(qcHolds.status, 'open')))
        .returning({ id: qcHolds.id });
      if (closed.length === 0) {
        // Unreachable under the row lock; refuse rather than write a second outcome.
        throw qcHoldClosed(row.id, 'closed');
      }

      // ── the inspection record ───────────────────────────────────────────
      await tx.insert(qcInspections).values({
        id: inspectionId,
        tenantId: command.tenantId,
        holdId: row.id,
        note: normalised.note,
        createdAt: inspectedAt,
        updatedAt: inspectedAt,
      });
      const stored: { batchId: string | null; outcome: QcInspectionOutcome; failReason: QcFailReason | null; quantity: number }[] = [];
      for (const line of lines) {
        if (line.passed > 0) stored.push({ batchId: line.batchId, outcome: 'passed', failReason: null, quantity: line.passed });
        for (const failure of line.failed) {
          stored.push({ batchId: line.batchId, outcome: 'failed', failReason: failure.reason, quantity: failure.quantity });
        }
      }
      await tx.insert(qcInspectionLines).values(
        stored.map((entry) => ({
          id: uuidv7(),
          tenantId: command.tenantId,
          inspectionId,
          batchId: entry.batchId,
          outcome: entry.outcome,
          failReason: entry.failReason,
          quantity: entry.quantity,
          createdAt: inspectedAt,
          updatedAt: inspectedAt,
        })),
      );

      const snapshot: InspectQcHoldSnapshot = {
        qcHold: {
          id: row.id,
          tenantId: row.tenantId,
          warehouseId: row.warehouseId,
          skuId: row.skuId,
          binId: row.binId,
          reason: row.reason,
          status: 'inspected',
          heldBy: row.heldBy,
          heldAt: canonicalInstant(row.heldAt),
          releasedBy: command.actorUserId,
          releasedAt: inspectedAt,
          createdAt: canonicalInstant(row.createdAt),
          ...(row.kind === 'receipt' && row.grnLineId !== null ? { kind: 'receipt' as const, grnLineId: row.grnLineId } : {}),
        },
        inspection: {
          id: inspectionId,
          holdId: row.id,
          note: normalised.note,
          inspectedBy: command.actorUserId,
          inspectedAt,
          passedQuantity: fromMilli(passedTotal),
          failedQuantity: fromMilli(failedTotal),
          lines: stored.map((entry) => ({ ...entry, quantity: fromMilli(entry.quantity) })),
        },
      };

      // ── outbox (AD-7): totals in base units ─────────────────────────────
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: QC_HOLD_INSPECTED_EVENT,
        occurredAt: inspectedAt,
        payload: {
          holdId: row.id,
          tenantId: command.tenantId,
          warehouseId: row.warehouseId,
          skuId: row.skuId,
          binId: row.binId,
          reason: row.reason,
          inspectionId,
          passedQuantity: fromMilli(passedTotal),
          failedQuantity: fromMilli(failedTotal),
          // Every stored row; quantities as base-unit decimal strings (the
          // outbox's exact-quantity convention — never a float).
          lines: stored.map((entry) => ({
            batchId: entry.batchId,
            outcome: entry.outcome,
            reason: entry.failReason,
            quantity: String(fromMilli(entry.quantity)),
          })),
          inspectedBy: command.actorUserId,
          inspectedAt,
          // A receipt hold raised no `qc-hold` entry: its placement's
          // `qc-receipt` entry resolves through `qc_hold.receipt_cleared`.
          ...(row.kind === 'receipt' ? { kind: 'receipt' } : {}),
        },
      });
      if (row.kind === 'receipt') {
        await this.emitReceiptClearedInTx(tx, command.tenantId, [row]);
      }

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'qc_hold.inspected',
        targetType: 'qc_hold',
        targetId: row.id,
        reference: idempotencyKey,
        occurredAt: inspectedAt,
      });

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  private async replayInspection(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<InspectQcHoldSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    if (existing[0] === undefined) return null;
    if (existing[0].payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return existing[0].responseSnapshot as InspectQcHoldSnapshot;
  }

  /**
   * The release of ONE open hold row (locked by the caller): the origin-bin
   * checks, the 12-3 secure gate, the hold's own `qc.held` arms replayed
   * back as `qc.released`, the conditional status flip and the per-hold
   * `qc_hold.released` outbox event. Extracted unchanged from `releaseHold`
   * (story 1-2b) so the release-receipt command releases each hold the one
   * way; the callers write their own audit row and key.
   */
  private async releaseHoldCoreInTx(
    tx: TenantTx,
    row: typeof qcHolds.$inferSelect,
    role: UserRole,
    actorUserId: string,
  ): Promise<QcHoldSnapshot> {
    const command = { tenantId: row.tenantId, actorUserId };
    await this.lockOriginBinInTx(tx, row, role);

    // The release replays the hold's OWN qc.held arms — a concurrent hold
    // of the same SKU from another origin bin never returns with this one.
    const arms = await this.inventory.qcHeldArmsInTx(
      tx,
      command.tenantId,
      row.warehouseId,
      row.id,
    );
    if (arms.length === 0) {
      // Unreachable short of ledger tampering — a hold without movements
      // has nothing to release; refuse loudly rather than release blind.
      throw new ProblemException(
        'qc-hold-origin-bin-gone',
        409,
        'QC hold has no ledger movements',
        `QC hold "${row.id}" carries no qc.held movements — the ledger is its movement record; refusing a blind release.`,
      );
    }

    const qcBin = await ensureQcHoldBinInTx(tx, command.tenantId, row.warehouseId);
    const releasedAt = nowIso();
    for (const arm of arms) {
      const movement: LedgerMovement = {
        tenantId: command.tenantId,
        warehouseId: row.warehouseId,
        type: 'qc.released',
        skuId: row.skuId,
        quantityDelta: signedQuantity(arm.quantity),
        fromBinId: qcBin.binId,
        toBinId: row.binId,
        batchRef: arm.batchRef,
        serialRef: null,
        actorUserId: command.actorUserId,
        occurredAt: releasedAt,
        recordedAt: releasedAt,
        referenceDoc: {
          kind: 'qc-hold',
          holdId: row.id,
        },
      };
      await this.inventory.appendLedgerEventInTx(tx, movement);
    }

    await tx
      .update(qcHolds)
      .set({ status: 'released', releasedBy: command.actorUserId, releasedAt, updatedAt: releasedAt })
      .where(and(eq(qcHolds.id, row.id), eq(qcHolds.status, 'open')));

    const snapshot: QcHoldSnapshot = {
      qcHold: {
        id: row.id,
        tenantId: row.tenantId,
        warehouseId: row.warehouseId,
        skuId: row.skuId,
        binId: row.binId,
        reason: row.reason,
        status: 'released',
        heldBy: row.heldBy,
        heldAt: canonicalInstant(row.heldAt),
        releasedBy: command.actorUserId,
        releasedAt,
        createdAt: canonicalInstant(row.createdAt),
        // Story 1-2b — present only on a receipt hold.
        ...(row.kind === 'receipt' && row.grnLineId !== null ? { kind: 'receipt' as const, grnLineId: row.grnLineId } : {}),
      },
    };

    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId: command.tenantId,
      type: 'qc_hold.released',
      occurredAt: releasedAt,
      payload: {
        holdId: row.id,
        tenantId: command.tenantId,
        warehouseId: row.warehouseId,
        skuId: row.skuId,
        binId: row.binId,
        reason: row.reason,
        releasedBy: command.actorUserId,
        releasedAt,
        // Story 1-2b — present only on a receipt hold: its release resolves
        // the placement's `qc-receipt` entry, not a `qc-hold` one.
        ...(row.kind === 'receipt' ? { kind: 'receipt' } : {}),
      },
    });
    return snapshot;
  }


  /**
   * The origin bin of ONE locked hold row, locked `FOR UPDATE`: it must still
   * exist and not be retired (409 `qc-hold-origin-bin-gone`), and the 12-3
   * secure gate rules on it. Extracted unchanged from the release core (story
   * 2-8a) so an inspection that passes units checks its origin the one way;
   * an all-fail inspection never calls it.
   */
  private async lockOriginBinInTx(
    tx: TenantTx,
    row: typeof qcHolds.$inferSelect,
    role: UserRole,
  ): Promise<void> {
    const command = { tenantId: row.tenantId };
    // The origin bin must still exist and not be retired (the matrix's
    // retired/missing arm — a gone bin cannot receive the stock back; the
    // hold stays open and the decision retried once the bin state is
    // resolved). Story 3.6: retirement is the one-way state that extends
    // this check — a retired origin bin is operationally gone even though
    // its row remains.
    const originRows = await tx
      .select({
        id: bins.id,
        code: bins.code,
        retiredAt: bins.retiredAt,
        // Story 12-3 — the class the secure-origin authority gate rules on.
        storageClass: bins.storageClass,
      })
      .from(bins)
      .where(
        and(
          eq(bins.id, row.binId),
          eq(bins.tenantId, command.tenantId),
          eq(bins.warehouseId, row.warehouseId),
        ),
      )
      .limit(1)
      // Story 1-5b — the origin bin locks before the release writes (closing
      // PENDING "releaseHold lacks .for('update')"): the bin edit's dedicate
      // guard locks the same row and then counts the bin's open holds, so a
      // release and a dedication serialise — one waits, and foreign units
      // never land in a freshly dedicated bin. Lock order: the hold row(s)
      // (the caller) → this bin row → the warehouse advisory inside the
      // ledger append — the canonical bin-row → advisory chain; nothing
      // locks a bin row and then a hold row.
      .for('update');
    const origin = originRows[0];
    if (origin === undefined) {
      throw new ProblemException(
        'qc-hold-origin-bin-gone',
        409,
        'Origin bin no longer exists',
        `The hold's origin bin ("${row.binId}") no longer exists in this warehouse — the held stock cannot return to it. Resolve the bin state first; the hold stays open.`,
      );
    }
    if (origin.retiredAt !== null) {
      throw new ProblemException(
        'qc-hold-origin-bin-gone',
        409,
        'Origin bin is retired',
        `The hold's origin bin ("${origin.code}") is retired — the held stock cannot return to a retired bin. Resolve the bin state first; the hold stays open.`,
      );
    }
    // ── story 12-3: the secure-bin authority gate (FR-42) — on the origin
    // read: released units RETURN to the origin bin, so a SECURE origin
    // additionally requires `secure.move`, the (role, bin) authority
    // decided on the row already in hand. (The PENDING `inbound:45`
    // currency note on this read stands — story 12-3 adds the assert on
    // the class read here, not the lock.) Non-denying today (the matrix
    // invariant keeps the subset enforced): `qc.manage` and `secure.move`
    // are held by exactly the same roles. Non-secure releases are
    // byte-identical to the pre-12.3 build. A replayed idempotency key
    // returns the cached success before this gate — the original
    // authorized execution already decided; that is deliberate
    // idempotency semantics.
    assertSecureBinAuthority(role, [origin]);
  }

  /**
   * Story 1-2b — for each receipt placement the released rows belong to (the
   * GRN, or the approved over-receipt), emit `qc_hold.receipt_cleared` once
   * no open receipt hold of that placement remains: the `qc-receipt`
   * notification resolves when none remain open.
   */
  private async emitReceiptClearedInTx(
    tx: TenantTx,
    tenantId: string,
    rows: readonly (typeof qcHolds.$inferSelect)[],
  ): Promise<void> {
    const lineIds = [...new Set(rows.map((row) => row.grnLineId).filter((id): id is string => id !== null))];
    if (lineIds.length === 0) return;
    const lines = await tx
      .select({ id: goodsReceiptLines.id, grnId: goodsReceiptLines.grnId })
      .from(goodsReceiptLines)
      .where(and(eq(goodsReceiptLines.tenantId, tenantId), inArray(goodsReceiptLines.id, lineIds)));
    const grnOfLine = new Map(lines.map((line) => [line.id, line.grnId]));
    const placements = new Map<string, { grnId: string; warehouseId: string; overReceiptId: string | null }>();
    for (const row of rows) {
      const grnId = grnOfLine.get(row.grnLineId ?? '');
      if (grnId === undefined) continue;
      placements.set(row.overReceiptId ?? grnId, { grnId, warehouseId: row.warehouseId, overReceiptId: row.overReceiptId });
    }
    // Lock order: hold row(s) → the GRN row. Two LAST holds of one placement
    // released concurrently would each see the other open and neither would
    // emit; the GRN row lock serialises them, and the later one — READ
    // COMMITTED — sees the earlier release and emits. Sorted by GRN id.
    const ordered = [...placements].sort(([, a], [, b]) => (a.grnId < b.grnId ? -1 : a.grnId > b.grnId ? 1 : 0));
    for (const [placementId, placement] of ordered) {
      await tx
        .select({ id: goodsReceiptNotes.id })
        .from(goodsReceiptNotes)
        .where(and(eq(goodsReceiptNotes.tenantId, tenantId), eq(goodsReceiptNotes.id, placement.grnId)))
        .limit(1)
        .for('update');
      const open = await tx
        .select({ id: qcHolds.id })
        .from(qcHolds)
        .innerJoin(goodsReceiptLines, eq(goodsReceiptLines.id, qcHolds.grnLineId))
        .where(
          and(
            eq(qcHolds.tenantId, tenantId),
            eq(qcHolds.kind, 'receipt'),
            eq(qcHolds.status, 'open'),
            eq(goodsReceiptLines.grnId, placement.grnId),
            placement.overReceiptId === null
              ? isNull(qcHolds.overReceiptId)
              : eq(qcHolds.overReceiptId, placement.overReceiptId),
          ),
        )
        .limit(1);
      if (open[0] !== undefined) continue;
      // Story 2-8a — the placement resolves `inspected` when ANY of its holds
      // was inspected (whichever closed last — a release after an inspection
      // still cleared a placement that had a QC outcome); a placement of only
      // releases carries no `resolution` key, so its payload keeps the 1-2b bytes.
      const inspected = await tx
        .select({ id: qcHolds.id })
        .from(qcHolds)
        .innerJoin(goodsReceiptLines, eq(goodsReceiptLines.id, qcHolds.grnLineId))
        .where(
          and(
            eq(qcHolds.tenantId, tenantId),
            eq(qcHolds.kind, 'receipt'),
            eq(qcHolds.status, 'inspected'),
            eq(goodsReceiptLines.grnId, placement.grnId),
            placement.overReceiptId === null
              ? isNull(qcHolds.overReceiptId)
              : eq(qcHolds.overReceiptId, placement.overReceiptId),
          ),
        )
        .limit(1);
      const resolution = inspected[0] === undefined ? undefined : ('inspected' as const);
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId,
        type: QC_RECEIPT_CLEARED_EVENT,
        occurredAt: nowIso(),
        payload: {
          placementId,
          grnId: placement.grnId,
          warehouseId: placement.warehouseId,
          ...(resolution === undefined ? {} : { resolution }),
        },
      });
    }
  }

  private async replayReceipt(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<ReleaseReceiptHoldsSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    if (existing[0] === undefined) return null;
    if (existing[0].payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return existing[0].responseSnapshot as ReleaseReceiptHoldsSnapshot;
  }

  // ── shared pieces ─────────────────────────────────────────────────────────

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: unknown,
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
        // Concurrent duplicate of the same idempotent request — the winner's
        // response is authoritative; this request carries no new state.
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

/**
 * 409 `qc-hold-released` — the hold is already closed. The code is kept from
 * story 3.4 (clients branch on it); story 2-8a's wording names both closed
 * states, since a hold now closes by a release OR an inspection.
 */
function qcHoldClosed(holdId: string, status: string): ProblemException {
  return new ProblemException(
    'qc-hold-released',
    409,
    'QC hold already closed',
    `QC hold "${holdId}" is already closed (${status}) — a release or an inspection is terminal.`,
  );
}

function qcInspectionMismatch(detail: string): ProblemException {
  return new ProblemException('qc-inspection-mismatch', 422, 'Inspection does not match the held stock', detail);
}

function qcValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid QC hold', detail);
}

function notFound(kind: string, id: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    `${kind} not found`,
    `No ${kind.toLowerCase()} with id "${id}" exists in this tenant.`,
  );
}