import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { assertUtcIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { CatalogFacade } from '../catalog/catalog.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import type {
  AdjustStockBatch,
  AdjustStockCommand,
  BatchOnHandEntry,
  StockAdjustmentPendingSnapshot,
  StockAdjustmentResult,
} from '../inventory/inventory.facade';
import { assertDeviceOperatorInTx } from './device-operator';
import { assertAdjustAuthority, assertPermission } from './permissions';
import { getMemberRoleIn } from './tenancy.service';

/**
 * Story 3-2b (design review A2) — ONE submission path for a stock adjustment,
 * shared by the HTTP route (`POST …/inventory/adjustments`, web or handheld)
 * and the review queue's Apply of a rejected `stock.adjust` device op
 * (`SyncReportCommand.applyArm`). Before 3-2b this body lived in the inventory
 * controller (`composeBatchSerialArms`, `resolveFefoBatch`, …); the sync-report
 * apply arm cannot import the api layer, and live and replayed adjustments
 * must compose identically, so it moved here — tenancy already reaches the
 * catalog and inventory facades (the sync-report command's seams).
 *
 * The order (Story 2.4's review loop 1, unchanged, plus the handheld arm):
 *
 *   1. pure arm normalization (null ≡ absent, serials trimmed, [] ≡ absent)
 *      and the request-shape checks (`InventoryFacade.assertAdjustmentShape`:
 *      business time — required on the handheld — and a non-zero delta);
 *   2. the SKU read (its tracking flags decide whether the request touches
 *      the 2.4 arms at all — a FEFO default draw carries no fields yet is armed);
 *   3. ONLY when it does: in one transaction, the handheld's device + operator
 *      re-authorization (BEFORE composition — a revoked device never mints
 *      batch or serial identity, A2) and the capability (`stock.adjust` OR
 *      `stock.adjust.request` — either may submit; A2), then the replay
 *      pre-check ("replay beats composition"; a stored APPLIED snapshot needs
 *      `stock.adjust` to re-serve — A4);
 *   4. the composition: tracked-SKU validation, identity ensure, the batch
 *      resolution (explicit override draw or the FEFO default), serial ids;
 *   5. `InventoryFacade.adjustStock` — the command re-runs the device check,
 *      the capability, the replay and every guard in its own transaction.
 *
 * A replayed 202 stored before 3-2b carries no `pendReason`; it is served
 * with `threshold` (A7 — before 3-2b a row could pend for no other reason).
 */

/** The batch arm as a caller sends it (the DTO's shape; a null field ≡ absent). */
export interface AdjustmentBatchInput {
  readonly code: string;
  readonly mfgDate?: string | null | undefined;
  readonly expiryDate?: string | null | undefined;
  readonly overrideReason?: string | null | undefined;
}

export interface AdjustmentSubmissionInput {
  readonly tenantId: string;
  /** The web session's user, or the handheld's badge-in operator. */
  readonly actorUserId: string;
  /** The handheld (a badge-in device session); null on the web. */
  readonly deviceId: string | null;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly binId: string;
  /** Signed, base UoM — converted inside the command, behind its replay lookup. */
  readonly quantityDelta: number;
  readonly reasonCode: string;
  readonly note: string;
  readonly occurredAt?: string | undefined;
  readonly batch?: AdjustmentBatchInput | null | undefined;
  readonly serials?: readonly string[] | null | undefined;
  readonly handlingUnitIds?: readonly string[] | null | undefined;
}

@Injectable()
export class AdjustmentSubmission {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // forwardRef: catalog ↔ tenancy is the spine's two-way dependency.
    @Inject(forwardRef(() => CatalogFacade)) private readonly catalog: CatalogFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  async submit(input: AdjustmentSubmissionInput, idempotencyKey: string): Promise<StockAdjustmentResult> {
    // ── 1. normalization + the request shape ──────────────────────────────
    // Code review — the handheld has no catch-weight arm (the screen never
    // offers one, and the review Apply carries none): refuse it rather than
    // accept a field the replay path would silently drop.
    if (input.deviceId !== null && (input.handlingUnitIds ?? []).length > 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'handlingUnitIds is not accepted from a handheld',
        'A handheld adjustment carries no handling units — a catch-weight SKU is adjusted by handling unit on the web, not from a device.',
      );
    }
    const arms = normalizeArms(input, input.deviceId !== null);
    const command: AdjustStockCommand = {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      deviceId: input.deviceId,
      warehouseId: input.warehouseId,
      skuId: input.skuId,
      binId: input.binId,
      // Story 10.2: base units — the command converts behind its replay lookup.
      quantityDelta: input.quantityDelta,
      reasonCode: input.reasonCode,
      note: input.note,
      occurredAt: input.occurredAt,
      batch: arms.batch,
      serials: arms.serials,
      // Story 10.3: the catch-weight channel crosses untouched — ids, not
      // quantities; the command asks whether this SKU requires it.
      handlingUnitIds: arms.handlingUnitIds,
    };
    this.inventory.assertAdjustmentShape(command);

    // ── 2. the SKU's tracking flags ───────────────────────────────────────
    const sku = await this.catalog.findSku(input.tenantId, input.skuId);
    const touchesArms =
      arms.batch !== undefined ||
      arms.serials !== undefined ||
      arms.handlingUnitIds !== undefined ||
      (sku !== null && (sku.batchTracked || sku.serialTracked || sku.catchWeightTracked));
    if (touchesArms) {
      // ── 3. device + authority, then replay — before ANY composition ─────
      const authority = await withTenantTransaction(this.db, input.tenantId, async (tx) => {
        if (input.deviceId !== null) {
          await assertDeviceOperatorInTx(tx, input.tenantId, input.deviceId, input.actorUserId);
        }
        const role = await getMemberRoleIn(tx, input.tenantId, input.actorUserId);
        return { role, kind: assertAdjustAuthority(role) };
      });
      // Replay precedes composition: the stored snapshot is the answer for a
      // retry even when the FEFO batch has since been exhausted. The hash is
      // command-owned (via the facade) and covers the RAW request arms.
      const replayed = await this.inventory.replayAdjustment(
        input.tenantId,
        idempotencyKey,
        this.inventory.adjustmentFingerprint(command),
      );
      if (replayed !== null) {
        if ('pendingAdjustment' in replayed) {
          return { kind: 'pending', pending: withPendReason(replayed), replayed: true };
        }
        // A4 — a stored applied adjustment is `stock.adjust`'s to re-serve.
        if (authority.kind !== 'adjust') {
          assertPermission(authority.role, 'stock.adjust');
        }
        return { kind: 'applied', snapshot: replayed, replayed: true };
      }
    }

    // ── 4. composition ────────────────────────────────────────────────────
    const { batchRef, serialRefs } = await this.composeBatchSerialArms(input, arms, sku);

    // ── 5. the command ────────────────────────────────────────────────────
    const result = await this.inventory.adjustStock({ ...command, batchRef, serialRefs }, idempotencyKey);
    return result.kind === 'pending' ? { ...result, pending: withPendReason(result.pending) } : result;
  }

  /**
   * The Story 2.4 composition (AD-6): the ONLY place catalog identity and
   * inventory stock state join for an adjustment. Runs only on the non-replay
   * path. It validates the tracked-SKU requirements, ensures identity
   * idempotently, and resolves the movement's batchRef — explicit (override,
   * reason required) or the FEFO default (oldest non-expired batch with stock
   * in the bin, expiry ASC nulls-last — CHECKPOINT 1). Serial ids resolve
   * order-preserving through `ensureSerials`; the ledger then enforces
   * uniqueness-in-a-bin at write time. Moved verbatim from the inventory
   * controller (3-2b): the rules are unchanged.
   */
  async composeBatchSerialArms(
    input: Pick<AdjustmentSubmissionInput, 'tenantId' | 'warehouseId' | 'skuId' | 'binId' | 'quantityDelta'>,
    arms: { batch: AdjustStockBatch | undefined; serials: string[] | undefined },
    sku: { batchTracked: boolean; serialTracked: boolean } | null,
  ): Promise<{ batchRef: string | null; serialRefs: string[] | undefined }> {
    const batch = arms.batch;
    const serials = arms.serials;
    const hasBatch = batch !== undefined;
    const hasSerials = serials !== undefined;
    if (!hasBatch && !hasSerials) {
      // The flagless passthrough stays byte-identical — but only when the SKU
      // actually tracks neither arm (a read; no identity rows are touched).
      // A tracked SKU without its arm falls through to the 400s below.
      if (sku === null || (!sku.batchTracked && !sku.serialTracked)) {
        return { batchRef: null, serialRefs: undefined };
      }
    } else if (sku === null) {
      // An unknown SKU with the new fields is 404 here (with no fields the
      // command's own assert keeps the passthrough byte-identical).
      throw new ProblemException('not-found', 404, 'SKU not found', 'No SKU with this id exists in this tenant.');
    }

    let batchRef: string | null = null;
    let serialRefs: string[] | undefined;

    if (hasBatch) {
      if (!sku!.batchTracked) {
        throw untrackedSku('batch', 'batch');
      }
      // Dates are optional but must be well-formed UTC instants — 400
      // otherwise. Validation only (no transform): the fingerprint hashed the
      // raw instants and the command re-hashes the same values.
      void assertBatchInstant(batch!.mfgDate, 'mfgDate');
      void assertBatchInstant(batch!.expiryDate, 'expiryDate');
      // An expiry before manufacturing is a data-entry error that would
      // otherwise jump the FEFO queue forever (earliest expiry draws first).
      if (
        batch!.mfgDate !== undefined &&
        batch!.expiryDate !== undefined &&
        Date.parse(batch!.expiryDate) < Date.parse(batch!.mfgDate)
      ) {
        throw new ProblemException(
          'validation-failed',
          400,
          'batch.expiryDate precedes mfgDate',
          `batch.expiryDate (${batch!.expiryDate}) must not precede batch.mfgDate (${batch!.mfgDate}).`,
        );
      }
    }
    if (hasSerials && !sku!.serialTracked) {
      throw untrackedSku('serials', 'serial');
    }

    if (hasSerials) {
      // Duplicates within one request are a client error — a retried scan
      // line, not a multi-unit movement (400 before any identity ensure).
      if (new Set(serials!).size !== serials!.length) {
        throw new ProblemException(
          'validation-failed',
          400,
          'serials contains duplicates',
          'A serial-tracked movement writes one ledger event per serial unit — the same serial cannot appear twice in one request.',
        );
      }
      if (Math.abs(input.quantityDelta) !== serials!.length) {
        throw new ProblemException(
          'validation-failed',
          400,
          'quantityDelta must match the serial count',
          `A serial-tracked movement writes one ledger event per serial unit — ${serials!.length} serials cannot move ${input.quantityDelta} units.`,
        );
      }
      const ensured = await this.catalog.ensureSerials(input.tenantId, input.skuId, serials!);
      serialRefs = ensured.map((serial) => serial.id);
    }

    if (hasBatch) {
      if (input.quantityDelta > 0) {
        // The override reason is the override-draw's audit field only — an
        // intake carries no FEFO decision to record (400, not a silent doc).
        if (batch!.overrideReason !== undefined) {
          throw new ProblemException(
            'validation-failed',
            400,
            'overrideReason applies only to an override draw',
            'batch.overrideReason records why a draw overrode the FEFO default — a positive intake names its batch outright and must omit it.',
          );
        }
        // Intake: identity is ensured idempotently (code unique per
        // tenant+sku; a retry with the same code returns the SAME batch).
        const [ensured] = await this.catalog.ensureBatches(input.tenantId, input.skuId, [
          { code: batch!.code, mfgDate: batch!.mfgDate, expiryDate: batch!.expiryDate },
        ]);
        batchRef = ensured!.id;
      } else {
        // Explicit draw = FEFO override: the reason is required and recorded
        // in the ledger reference doc (the hash chain is the audit log).
        if (batch!.overrideReason === undefined) {
          throw new ProblemException(
            'validation-failed',
            400,
            'overrideReason is required to override the FEFO default batch',
            'Drawing an explicit batch instead of the FEFO default must record a reason — supply batch.overrideReason.',
          );
        }
        const found = (await this.catalog.getBatches(input.tenantId, input.skuId)).find(
          (candidate) => candidate.code === batch!.code,
        );
        if (found === undefined) {
          throw new ProblemException('not-found', 404, 'Batch not found', `No batch with code "${batch!.code}" exists for this SKU.`);
        }
        batchRef = found.id;
        await this.assertBatchCoversDraw(input, found.id, batch!.code);
      }
    } else if (sku!.batchTracked && input.quantityDelta < 0) {
      // FEFO default draw (CHECKPOINT 1): oldest non-expired batch with stock
      // in the bin, expiry ASC nulls-last — expired batches are never
      // default-drawn. Judged against the SERVER clock at receipt (A10).
      batchRef = await this.resolveFefoBatch(input);
    } else if (sku!.batchTracked) {
      // Batch-tracked intake without the batch arm: identity cannot be
      // ensured and the ledger's batch fold cannot key — reject.
      throw new ProblemException(
        'validation-failed',
        400,
        'batch is required for a batch-tracked intake',
        'A positive movement of a batch-tracked SKU must name its batch — supply batch { code, mfgDate?, expiryDate? }.',
      );
    }
    if (!hasSerials && sku!.serialTracked) {
      throw new ProblemException(
        'validation-failed',
        400,
        'serials are required for a serial-tracked movement',
        'A serial-tracked movement writes one ledger event per serial unit — supply serials: [s1..sN] with quantityDelta = N.',
      );
    }

    return { batchRef, serialRefs };
  }

  /**
   * The explicit-batch draw pre-check: the batch's bin quantity must cover
   * the movement (422 naming the batch CODE — the ledger's own fold guard is
   * the race backstop and names the batchRef).
   */
  private async assertBatchCoversDraw(
    input: Pick<AdjustmentSubmissionInput, 'tenantId' | 'warehouseId' | 'skuId' | 'binId' | 'quantityDelta'>,
    batchId: string,
    batchCode: string,
  ): Promise<void> {
    const rows = await this.inventory.batchOnHand(input.tenantId, input.warehouseId, {
      skuId: input.skuId,
      binId: input.binId,
    });
    const held = rows.find((row) => row.batchId === batchId)?.quantity ?? 0;
    if (held < Math.abs(input.quantityDelta)) {
      throw new ProblemException(
        'insufficient-on-hand',
        422,
        'Adjustment would drive the batch on-hand below zero',
        `Batch "${batchCode}" currently holds ${held} in this bin; this movement of ${input.quantityDelta} would take it below zero.`,
      );
    }
  }

  /** The FEFO resolution (CHECKPOINT 1): the catalog expiry × inventory on-hand join. */
  private async resolveFefoBatch(
    input: Pick<AdjustmentSubmissionInput, 'tenantId' | 'warehouseId' | 'skuId' | 'binId'>,
  ): Promise<string> {
    const [onHand, batches] = await Promise.all([
      this.inventory.batchOnHand(input.tenantId, input.warehouseId, { skuId: input.skuId, binId: input.binId }),
      this.catalog.getBatches(input.tenantId, input.skuId),
    ]);
    const byId = new Map(batches.map((batch) => [batch.id, batch]));
    const now = Date.now();
    const candidates: { batchId: string; expiry: string | null }[] = onHand
      .filter((row: BatchOnHandEntry) => row.quantity > 0 && byId.has(row.batchId))
      .map((row) => ({ batchId: row.batchId, expiry: byId.get(row.batchId)!.expiryDate }))
      // Expired batches are never default-drawn (null expiry never expires).
      .filter((candidate) => candidate.expiry === null || Date.parse(candidate.expiry) >= now)
      // FEFO: expiry ASC, nulls LAST (a batch without expiry is drawn last).
      .sort((a, b) => {
        if (a.expiry === null) return b.expiry === null ? 0 : 1;
        if (b.expiry === null) return -1;
        return a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0;
      });
    if (candidates.length === 0) {
      throw new ProblemException(
        'insufficient-on-hand',
        422,
        'No batch to draw',
        `Bin "${input.binId}" holds no non-expired batch stock of this SKU — name a batch explicitly (with an override reason) to draw.`,
      );
    }
    return candidates[0]!.batchId;
  }
}

/**
 * A7 — a 202 stored before 3-2b has no `pendReason`; it pended because
 * |delta| exceeded the threshold, the only reason a row could pend then.
 */
function withPendReason(pending: StockAdjustmentPendingSnapshot): StockAdjustmentPendingSnapshot {
  if (pending.pendingAdjustment.pendReason !== undefined) return pending;
  return { pendingAdjustment: { ...pending.pendingAdjustment, pendReason: 'threshold' } };
}

/**
 * Pure arm normalization (review loop 1 — runs BEFORE the permission assert,
 * the fingerprint, and any identity work; throws nothing): a null batch or
 * serials behaves as absent (never a 500 on a tracked SKU, never a different
 * fingerprint than an omitted field); serial elements are trimmed (the DTO
 * trims too — idempotent) and an empty array is absent. Story 3-2b: on the
 * HANDHELD a null batch FIELD is absent too (it sends explicit nulls); the web
 * keeps its pre-3-2b bytes exactly (see `device`). The NORMALIZED arms feed both
 * `ensureSerials`/`ensureBatches` and the idempotency fingerprint.
 */
export function normalizeArms(
  input: Pick<AdjustmentSubmissionInput, 'batch' | 'serials' | 'handlingUnitIds'>,
  /**
   * Code review — the null-FIELD normalization applies on the HANDHELD only.
   * On the web an explicit `batch.overrideReason: null` was hashed (and
   * accepted on a draw) before 3-2b, so mapping it to absent there would
   * change a stored key's hash (422 on a retry across the deploy) — pinned by
   * a golden captured from the pre-3-2b code.
   */
  device: boolean,
): {
  batch: AdjustStockBatch | undefined;
  serials: string[] | undefined;
  handlingUnitIds: string[] | undefined;
} {
  const rawBatch = input.batch ?? undefined;
  const batch =
    rawBatch === undefined
      ? undefined
      : {
          code: rawBatch.code,
          mfgDate: device ? (rawBatch.mfgDate ?? undefined) : (rawBatch.mfgDate as string | undefined),
          expiryDate: device ? (rawBatch.expiryDate ?? undefined) : (rawBatch.expiryDate as string | undefined),
          overrideReason: device ? (rawBatch.overrideReason ?? undefined) : (rawBatch.overrideReason as string | undefined),
        };
  const trimmed = (input.serials ?? []).map((serial) => serial.trim());
  // Story 10.3: an empty array is absent, exactly as `serials` is — the two
  // spellings of "no handling units" must fingerprint identically.
  const handlingUnitIds = input.handlingUnitIds ?? [];
  return {
    batch,
    serials: trimmed.length > 0 ? trimmed : undefined,
    handlingUnitIds: handlingUnitIds.length > 0 ? [...handlingUnitIds] : undefined,
  };
}

/** A batch/serial arm on a SKU that does not track it — 400 (the I/O matrix). */
function untrackedSku(field: 'batch' | 'serials', arm: 'batch' | 'serial'): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    `SKU is not ${arm}-tracked`,
    `The "${field}" arm applies only to ${arm}-tracked SKUs — this SKU's tracking flags are false.`,
  );
}

/** Batch dates are optional but must be well-formed UTC instants — 400 otherwise. */
function assertBatchInstant(value: string | undefined, field: 'mfgDate' | 'expiryDate'): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return assertUtcIso(value);
  } catch {
    throw new ProblemException(
      'validation-failed',
      400,
      `batch.${field} must be a valid ISO-8601 UTC instant`,
      `batch.${field} must be a Z-suffixed ISO-8601 UTC timestamp (got "${value}").`,
    );
  }
}
