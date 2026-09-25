import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  bins,
  idempotencyKeys,
  skus,
  temperatureExcursions,
} from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { signedQuantity } from '../../shared/primitives/quantity';
import { assertUtcIso, canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertPermission } from '../tenancy/permissions';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { LedgerMovement } from '../inventory/inventory.facade';
import { QcFacade } from '../inbound/qc.facade';

// ── command inputs ───────────────────────────────────────────────────────────

export interface RecordExcursionCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  /** The bin the reading was taken against (the holds' origin bin). */
  readonly binId: string;
  /** The operator-captured reading, °C (−100..200, two decimal places). */
  readonly readingC: number;
  /** The operator's free-text context; null when none was given. */
  readonly note: string | null;
  /** Business time (AD-1) — when the reading was observed; server clock when absent. */
  readonly occurredAt: string | null;
}

export interface ResolveExcursionCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly excursionId: string;
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** One excursion as every surface returns it (the idempotency snapshot). */
export interface ExcursionSnapshot {
  readonly excursion: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly binId: string;
    readonly readingC: number;
    readonly note: string | null;
    /** The QC holds this excursion quarantined its affected scopes with. */
    readonly holdIds: readonly string[];
    readonly status: 'open' | 'resolved';
    readonly recordedBy: string;
    readonly occurredAt: string;
    readonly resolvedBy: string | null;
    readonly resolvedAt: string | null;
    readonly createdAt: string;
  };
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** A note names the context in one sentence, not an essay (the QC-reason cap). */
const MAX_NOTE_LENGTH = 200;

/** The reading vocabulary (UX-DR30, manual capture): °C only, sensor-bounded. */
export const MIN_READING_C = -100;
export const MAX_READING_C = 200;

/**
 * The temperature-excursion commands (Story 12-5, FR-44): an operator records
 * a °C reading against a bin; the command sweeps the bin's affected scopes
 * (every distinct SKU with on-hand quantity > 0) and quarantines each through
 * the inbound module's ONE hold implementation (`QcFacade.holdScopeInTx` —
 * ordinary QC holds, so ATP exclusion, the release path, the merge/SKU-class
 * guards and the ledger timeline all work unchanged), appends one
 * ZERO-quantity `excursion.recorded` ledger event per affected scope (AD-11 —
 * the ledger is the excursion's only record; FR-45 reconstructs from it
 * alone), and writes the excursion row the review queue reads.
 *
 * All-or-nothing: any serial-tracked or catch-weight SKU in the bin refuses
 * the ENTIRE excursion (400 naming the offenders) — FR-44 never leaves units
 * in ATP; per-unit quarantine stays Epic 15's. A scope already under an open
 * hold is skipped (already out of ATP), not a 409. `resolve` is a
 * review-status flip only: it releases nothing (disposition is `qc.manage`'s
 * / `stock.adjust`'s).
 *
 * Invariant order (the shared command skeleton) inside
 * `withTenantTransaction`: authority (fresh DB role read →
 * `assertPermission('excursion.record')`) → idempotency replay → validation →
 * sweep → per-scope holds → excursion row → per-scope ledger events → in-tx
 * outbox → audit → idempotency-key snapshot.
 */
@Injectable()
export class ExcursionCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition at the command layer through the facades only
    // (AD-6): the ledger events via the inventory facade, the quarantine via
    // the inbound module's QC facade (the extracted in-tx hold core).
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(QcFacade) private readonly qc: QcFacade,
  ) {}

  /**
   * `excursion.record`: records the reading, quarantines every affected
   * scope, and appends the per-scope zero-delta ledger events — all in one
   * transaction, all-or-nothing.
   */
  async recordExcursion(
    command: RecordExcursionCommand,
    idempotencyKey: string,
  ): Promise<ExcursionSnapshot> {
    // ── shape checks above the transaction (no DB row needed) ────────────
    // The reading's vocabulary is the DTO's bounds; this is the command's
    // own backstop (the api layer composes, this refuses the raw 500 a
    // numeric(6,2) out-of-range would never give — bounds are checked here
    // so a queued replay of a committed op re-serves its snapshot).
    if (
      !Number.isFinite(command.readingC) ||
      command.readingC < MIN_READING_C ||
      command.readingC > MAX_READING_C
    ) {
      throw excursionValidation(
        `readingC must be a °C reading between ${MIN_READING_C} and ${MAX_READING_C} (got ${command.readingC}).`,
      );
    }
    if (command.note !== null && (command.note.trim() === '' || command.note.length > MAX_NOTE_LENGTH)) {
      throw excursionValidation(
        `note must be empty or at most ${MAX_NOTE_LENGTH} characters of context.`,
      );
    }
    // The business time is client-supplied and UTC-validated (the
    // adjustment's `occurredAt` pattern — the primitive's raw throw is
    // mapped to 400 so it never renders as 500).
    let occurredAt: string;
    if (command.occurredAt === null) {
      occurredAt = nowIso();
    } else {
      try {
        occurredAt = assertUtcIso(command.occurredAt);
      } catch {
        throw excursionValidation(
          `occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${command.occurredAt}").`,
        );
      }
    }
    // The reading normalizes to the column's two decimal places BEFORE any
    // write, so the ledger's reference doc and the row never disagree.
    const readingC = Math.round(command.readingC * 100) / 100;

    // Hash the payload BEFORE the transaction, over the RAW request fields
    // (never the resolved instant — a replay of the same request must
    // fingerprint identically whatever the server clock now reads).
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      binId: command.binId,
      readingC: command.readingC,
      note: command.note,
      occurredAt: command.occurredAt,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── authority at command entry (the deliberate fail-closed order) ──
      // The role stays in scope: the hold core's 12-3 secure-bin gate
      // re-uses it below, on the locked origin bin row.
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'excursion.record');

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
        return existing[0].responseSnapshot as ExcursionSnapshot;
      }

      // ── master-data integrity (404 before any write) ────────────────────
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      const binRows = await tx
        .select({
          id: bins.id,
          code: bins.code,
          systemOwned: bins.systemOwned,
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
        // The bin row locks here (the same row the hold core locks, and the
        // row the merge/retire commands lock id-sorted): an excursion cannot
        // commit alongside a concurrent merge/retire of its bin.
        .for('update');
      const bin = binRows[0];
      if (bin === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Bin not found',
          `No bin with id "${command.binId}" exists in this warehouse.`,
        );
      }
      // FR-44 is against affected stock: a system-owned bin (the QC-hold
      // bin) has no ordinary on-hand to quarantine — its contents are
      // already held.
      if (bin.systemOwned) {
        throw excursionValidation(
          `Bin ${bin.code} is system-owned — a temperature excursion is recorded against a storage bin, not a system bin.`,
        );
      }

      // ── the sweep: every distinct SKU with on-hand quantity > 0 ─────────
      const affected = await this.inventory.onHandInBinInTx(
        tx,
        command.tenantId,
        command.warehouseId,
        command.binId,
      );
      if (affected.length === 0) {
        throw excursionValidation(
          `Bin ${bin.code} has no on-hand stock — a temperature excursion quarantines the stock it affects, so an empty bin is refused.`,
        );
      }

      // All-or-nothing: any serial-tracked or catch-weight SKU refuses the
      // ENTIRE excursion naming every offender — the hold core would refuse
      // each one anyway, but per-scope refusals would quarantine the earlier
      // scopes' stock while stranding the offender's: FR-44 never leaves
      // units in ATP. Pre-flight, before any write (the per-scope refusals
      // in the hold core stay as defence in depth).
      const skuRows = await tx
        .select({
          id: skus.id,
          code: skus.code,
          serialTracked: skus.serialTracked,
          catchWeightTracked: skus.catchWeightTracked,
        })
        .from(skus)
        .where(
          and(
            eq(skus.tenantId, command.tenantId),
            inArray(
              skus.id,
              affected.map((row) => row.skuId),
            ),
          ),
        )
        .orderBy(asc(skus.id));
      const unquarantinable = skuRows.filter((row) => row.serialTracked || row.catchWeightTracked);
      if (unquarantinable.length > 0) {
        const named = unquarantinable
          .map((row) => `${row.code} (${row.id})`)
          .join(', ');
        const why = unquarantinable.some((row) => row.serialTracked)
          ? 'a bulk (sku, bin) hold would strand a serial-tracked SKU\'s location records at the origin bin'
          : 'a bulk (sku, bin) hold names no handling units, so a catch-weight SKU\'s cases would stay packable while their stock sat in the QC bin';
        throw excursionValidation(
          `Bin ${bin.code} holds stock that cannot be quarantined as a whole scope — ${named} — because ${why}. The excursion is refused in full (nothing written); quarantine the affected cases by naming them on stock adjustments, or relocate the offending SKUs first.`,
        );
      }

      // ── already-held scopes are SKIPPED (already out of ATP), not a 409 ──
      const openHolds = await this.qc.openHoldsForBinsInTx(
        tx,
        command.tenantId,
        command.warehouseId,
        [command.binId],
      );
      const heldSkuIds = new Set(openHolds.map((hold) => hold.skuId));
      const scopes = affected.filter((row) => !heldSkuIds.has(row.skuId));

      // ── quarantine each affected scope through the ONE hold core ────────
      // The hold's reason names why, within the QC reason cap; the caller's
      // fresh role read feeds the hold core's 12-3 secure-bin gate (held
      // units LEAVE the origin bin — a SECURE bin additionally requires
      // `secure.move`, so an operator on a cage-class bin is refused, the
      // cage staying off-limits to floor staff).
      const excursionId = uuidv7();
      const holdIds: string[] = [];
      for (const scope of scopes) {
        const reason =
          command.note === null
            ? 'temperature-excursion'
            : `temperature-excursion: ${command.note}`.slice(0, 200);
        const hold = await this.qc.holdScopeInTx(
          tx,
          {
            tenantId: command.tenantId,
            warehouseId: command.warehouseId,
            actorUserId: command.actorUserId,
            skuId: scope.skuId,
            binId: command.binId,
            reason,
          },
          role,
          excursionId,
        );
        holdIds.push(hold.qcHold.id);
      }

      // ── the excursion row (the review queue's data) ─────────────────────
      await tx.insert(temperatureExcursions).values({
        id: excursionId,
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        binId: command.binId,
        readingC: readingC.toFixed(2),
        note: command.note,
        holdIds,
        status: 'open',
        recordedBy: command.actorUserId,
        occurredAt,
      });

      // ── the per-scope ZERO-delta ledger events (AD-11) ──────────────────
      // One `excursion.recorded` event per affected scope: `skuId` is never
      // null on a ledger event, hence one event per scope; both bin arms
      // stay null (the zero-quantity envelope rule) and both identity arms
      // are registry-closed. The relocation of the affected units is the
      // `qc.held` movements' work above — the event records the excursion
      // itself, reference doc carrying enough for FR-45 reconstruction.
      for (const scope of scopes) {
        const movement: LedgerMovement = {
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          type: 'excursion.recorded',
          skuId: scope.skuId,
          quantityDelta: signedQuantity(0),
          fromBinId: null,
          toBinId: null,
          batchRef: null,
          serialRef: null,
          actorUserId: command.actorUserId,
          occurredAt,
          recordedAt: nowIso(),
          referenceDoc: {
            kind: 'excursion',
            excursionId,
            binId: command.binId,
            readingC,
          },
        };
        await this.inventory.appendLedgerEventInTx(tx, movement);
      }

      const snapshot: ExcursionSnapshot = {
        excursion: {
          id: excursionId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          binId: command.binId,
          readingC,
          note: command.note,
          holdIds,
          status: 'open',
          recordedBy: command.actorUserId,
          occurredAt,
          resolvedBy: null,
          resolvedAt: null,
          createdAt: occurredAt,
        },
      };

      // ── in-transaction outbox append (AD-7) ─────────────────────────────
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'excursion.recorded',
        occurredAt,
        payload: {
          excursionId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          binId: command.binId,
          readingC,
          note: command.note,
          holdIds,
          affectedSkus: scopes.map((scope) => scope.skuId),
          recordedBy: command.actorUserId,
          occurredAt,
        },
      });

      // ── the audit row + idempotency key (the invariant order's tail) ────
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'excursion.recorded',
        targetType: 'temperature_excursion',
        targetId: excursionId,
        reference: idempotencyKey,
        occurredAt,
      });

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * `excursion resolve`: the review-status flip (`review.decide` — the
   * decision is the reviewer's), NOT a release: the holds this excursion
   * created are untouched, and stock disposition stays the existing
   * `qc.manage` release / `stock.adjust` verbs. Terminal — a second resolve
   * is a deterministic 409.
   */
  async resolveExcursion(
    command: ResolveExcursionCommand,
    idempotencyKey: string,
  ): Promise<ExcursionSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      excursionId: command.excursionId,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── authority at command entry (the deliberate fail-closed order) ──
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'review.decide');

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
        return existing[0].responseSnapshot as ExcursionSnapshot;
      }

      const rows = await tx
        .select()
        .from(temperatureExcursions)
        .where(
          and(
            eq(temperatureExcursions.id, command.excursionId),
            eq(temperatureExcursions.tenantId, command.tenantId),
          ),
        )
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Excursion not found',
          `No excursion with id "${command.excursionId}" exists in this tenant.`,
        );
      }
      if (row.status !== 'open') {
        throw new ProblemException(
          'excursion-resolved',
          409,
          'Excursion already resolved',
          `Excursion "${row.id}" is already resolved — resolutions are terminal.`,
        );
      }

      const resolvedAt = nowIso();
      const updated = await tx
        .update(temperatureExcursions)
        .set({
          status: 'resolved',
          resolvedBy: command.actorUserId,
          resolvedAt,
          updatedAt: resolvedAt,
        })
        // Conditional on the open status — exactly one resolve wins (AD-12's
        // rowcount proof; the `.for('update')` read already serialized the
        // racers, the predicate is the backstop).
        .where(
          and(
            eq(temperatureExcursions.id, row.id),
            eq(temperatureExcursions.status, 'open'),
          ),
        )
        .returning({ id: temperatureExcursions.id });
      if (updated.length === 0) {
        throw new ProblemException(
          'excursion-resolved',
          409,
          'Excursion already resolved',
          `Excursion "${row.id}" is already resolved (a concurrent resolve won) — resolutions are terminal.`,
        );
      }

      const snapshot: ExcursionSnapshot = {
        excursion: {
          id: row.id,
          tenantId: row.tenantId,
          warehouseId: row.warehouseId,
          binId: row.binId,
          readingC: Number(row.readingC),
          note: row.note,
          holdIds: row.holdIds,
          status: 'resolved',
          recordedBy: row.recordedBy,
          occurredAt: canonicalInstant(row.occurredAt),
          resolvedBy: command.actorUserId,
          resolvedAt,
          createdAt: canonicalInstant(row.createdAt),
        },
      };

      // ── in-transaction outbox append (AD-7) ─────────────────────────────
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'excursion.resolved',
        occurredAt: resolvedAt,
        payload: {
          excursionId: row.id,
          tenantId: row.tenantId,
          warehouseId: row.warehouseId,
          binId: row.binId,
          resolvedBy: command.actorUserId,
          resolvedAt,
        },
      });

      // ── the audit row + idempotency key (the invariant order's tail) ────
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'excursion.resolved',
        targetType: 'temperature_excursion',
        targetId: row.id,
        reference: idempotencyKey,
        occurredAt: resolvedAt,
      });

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
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

function excursionValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid excursion', detail);
}