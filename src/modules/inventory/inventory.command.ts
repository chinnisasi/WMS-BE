import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { bins, idempotencyKeys, skus } from '../../shared/db/schema';
import { signedQuantity } from '../../shared/primitives/quantity';
import type { SignedQuantity } from '../../shared/primitives/quantity';
import { uuidv7 } from '../../shared/primitives/ids';
import { assertUtcIso, nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { QC_HOLD_BIN_CODE } from '../tenancy/receiving-bin';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { LedgerService } from './ledger.service';

/**
 * `stock.adjustment` (Story 2.1): the first movement producer, exercisable
 * end-to-end. One command → exactly one ledger event + the updated on-hand
 * projection, committed in ONE transaction (`withTenantTransaction`).
 *
 * Authorization (epic-1 carve-out parity): the capability is asserted at
 * command-service entry — a DB role read in the command's own transaction,
 * BEFORE the idempotency replay lookup — so an actor demoted after the
 * original request gets `403 role-denied` naming the role and capability,
 * never the snapshot.
 *
 * Idempotency (AD-5): the client-generated ULID key de-dupes in the same
 * transaction as the write; same key + same payload replays the original
 * response (no second event), same key + different payload is a 422
 * `idempotency-key-reuse`.
 */
/** The client's batch input (Story 2.4) — identity fields plus the override reason. */
export interface AdjustStockBatch {
  readonly code: string;
  readonly mfgDate?: string | undefined;
  readonly expiryDate?: string | undefined;
  /**
   * Required when an explicit batch overrides the FEFO default on a draw —
   * recorded verbatim in the ledger reference doc (the audit trail).
   */
  readonly overrideReason?: string | undefined;
}

export interface AdjustStockCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly binId: string;
  /** Signed base-UoM delta; zero is rejected (a nothing movement). */
  readonly quantityDelta: number;
  readonly reasonCode: string;
  readonly note: string;
  /**
   * Business time; defaults to the commit clock when the client omits it.
   * (`string | undefined` explicit for `exactOptionalPropertyTypes` — the
   * controller passes the DTO's maybe-undefined field straight through.)
   */
  readonly occurredAt?: string | undefined;
  // ── Story 2.4 (additive; all omitted on the untracked passthrough) ───────
  /**
   * The client's raw batch input — part of the idempotency fingerprint (a
   * retry must replay on the same request body, not on FEFO's current
   * opinion). The api layer resolves it to `batchRef` before calling.
   */
  readonly batch?: AdjustStockBatch | undefined;
  /** The client's raw serial numbers — the fingerprint counterpart of `serialRefs`. */
  readonly serials?: readonly string[] | undefined;
  /**
   * The resolved batch identity (the catalog `batches.id`) for the
   * movement's batch arm — explicit code or FEFO default, composed at the
   * api layer (catalog owns batch identity, AD-6). Null/omitted = no batch arm.
   */
  readonly batchRef?: string | null | undefined;
  /**
   * The resolved serial identities (catalog `serials.id`), same order as
   * `serials`. Present only on serial-tracked movements: the command emits
   * exactly one ledger event per serial unit (qty ±1, one transaction).
   */
  readonly serialRefs?: readonly string[] | undefined;
}

/** The API response body (the idempotency snapshot). */
export interface StockAdjustmentSnapshot {
  readonly event: {
    readonly id: string;
    readonly seq: number;
    readonly type: string;
    readonly skuId: string;
    readonly binId: string | null;
    readonly quantityDelta: number;
    readonly occurredAt: string;
    readonly recordedAt: string;
  };
  readonly onHand: {
    readonly skuId: string;
    readonly binId: string;
    readonly quantity: number;
  };
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

@Injectable()
export class StockAdjustmentCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // No cycle: the command consumes the ledger one-way.
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  /**
   * The idempotency fingerprint over the command's business fields (fixed
   * key order — see `hashCommandPayload`). Command-owned by design (review
   * loop 1): the api layer's replay pre-check hashes through THIS method
   * (via the facade) so a retry's replay decision and the command's own
   * in-transaction comparison can never diverge. The Story 2.4 arms
   * fingerprint the NORMALIZED raw request body — never the FEFO-resolved
   * refs — so `JSON.stringify` drops undefined properties and a fieldless
   * adjustment hashes byte-identically to its pre-2.4 shape.
   */
  fingerprint(command: AdjustStockCommand): string {
    return hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      skuId: command.skuId,
      binId: command.binId,
      quantityDelta: command.quantityDelta,
      reasonCode: command.reasonCode,
      note: command.note,
      occurredAt: command.occurredAt,
      batch:
        command.batch === undefined
          ? undefined
          : {
              code: command.batch.code,
              mfgDate: command.batch.mfgDate,
              expiryDate: command.batch.expiryDate,
              overrideReason: command.batch.overrideReason,
            },
      // Null behaves as absent (normalized upstream too — never a 500 here).
      serials: command.serials == null ? undefined : [...command.serials],
    });
  }

  /**
   * The api layer's replay pre-check (review loop 1 — "replay beats
   * composition"): looks up the key's stored record OUTSIDE any composition
   * and compares the payload hash — a match returns the stored snapshot so a
   * retry replays even when the composition's current-state inputs (the
   * FEFO batch's remaining stock, the bin's batch state) have since changed;
   * a mismatch throws the deterministic 422 `idempotency-key-reuse` BEFORE
   * the composition can create identity or surface a validation error; no
   * row returns null and the caller proceeds to composition. The
   * comparison stays command-owned (this is the same payload hash `adjust`
   * re-checks inside its transaction — the in-transaction lookup remains
   * the authority for concurrent duplicates).
   */
  async replayPriorSnapshot(
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<StockAdjustmentSnapshot | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)),
        )
        .limit(1);
      const existing = rows[0];
      if (existing === undefined) {
        return null;
      }
      if (existing.payloadHash !== payloadHash) {
        throw idempotencyKeyReuse();
      }
      return existing.responseSnapshot as StockAdjustmentSnapshot;
    });
  }

  async adjust(
    command: AdjustStockCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: StockAdjustmentSnapshot; replayed: boolean }> {
    // The business time is client-supplied and UTC-validated (the primitive
    // throws a plain error — mapped to 400 here so it never renders as 500).
    let occurredAt: string;
    if (command.occurredAt === undefined) {
      occurredAt = nowIso();
    } else {
      try {
        occurredAt = assertUtcIso(command.occurredAt);
      } catch {
        throw new ProblemException(
          'validation-failed',
          400,
          'occurredAt must be a valid ISO-8601 UTC instant',
          `occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${command.occurredAt}").`,
        );
      }
    }
    const delta = this.assertNonZeroDelta(command.quantityDelta);

    // Serial-tracked movements move exactly one unit per event: the serial
    // count must equal the movement's magnitude (400 otherwise — the api
    // layer's DTO validation composes, this is the command's own backstop).
    const serialRefs = command.serialRefs ?? [];
    if (serialRefs.length > 0 && serialRefs.length !== Math.abs(delta)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'quantityDelta must match the serial count',
        `A serial-tracked movement writes one ledger event per serial unit — ${serialRefs.length} serials cannot move ${delta} units.`,
      );
    }

    // Stable fingerprint over the command's business fields (fixed key
    // order — see hashCommandPayload). An omitted occurredAt is absent
    // from both attempts, so the fingerprint is stable across retries.
    // The Story 2.4 fields fingerprint the RAW request body (not the
    // FEFO-resolved ref): `JSON.stringify` drops undefined properties, so a
    // fieldless adjustment hashes byte-identically to its pre-2.4 shape.
    const payloadHash = this.fingerprint(command);

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry — DB read, same tx, BEFORE the
        // replay lookup (the deliberate fail-closed carve-out).
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'stock.adjust',
        );

        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, command.tenantId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0] !== undefined) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as StockAdjustmentSnapshot,
            replayed: true,
          };
        }

        // Master-data integrity in the command transaction (no FK repo
        // convention): warehouse in tenant, bin in that warehouse, SKU in
        // tenant — a foreign or nonexistent scope is 404 before any write.
        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
        // Integrity-only reads: a missing scope is 404 before any write
        // (the rows themselves are not used beyond existence).
        await this.assertBinInWarehouse(tx, command);
        await this.assertSkuInTenant(tx, command);

        const snapshot = await this.adjustToSnapshot(tx, command, delta, occurredAt);

        // In-transaction outbox append (AD-7, story outbox-relay) — replaces
        // the post-commit publish, and keeps the old `!replayed` gate
        // structurally: the idempotent replay returned above (and a
        // concurrent duplicate's transaction rolls back whole), so a replayed
        // adjustment appends nothing.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'stock.adjusted',
          // Business time — the same instant the event committed with,
          // not the relay's publish clock.
          occurredAt,
          payload: {
            warehouseId: command.warehouseId,
            skuId: command.skuId,
            binId: command.binId,
            quantityDelta: command.quantityDelta,
            seq: snapshot.event.seq,
            eventId: snapshot.event.id,
          },
        });

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
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
        return { snapshot, replayed: false };
      },
    );

    return { snapshot, replayed };
  }

  /** Signed, non-zero integer delta (a zero-delta event is pure noise). */
  private assertNonZeroDelta(raw: number): SignedQuantity {
    if (raw === 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'quantityDelta must be a non-zero integer',
        'A stock adjustment moves a non-zero quantity — zero deltas write no ledger event.',
      );
    }
    return signedQuantity(raw);
  }

  /**
   * The bin must exist in this tenant's warehouse (404 otherwise). The
   * `bins` row is tenancy master data read here only for referential
   * integrity (uuid columns, no FKs — the repo convention); stock tables
   * stay inventory-exclusive (the architecture test enforces the writes).
   */
  private async assertBinInWarehouse(
    tx: TenantTx,
    command: AdjustStockCommand,
  ): Promise<{ id: string; code: string }> {
    const rows = await tx
      .select({ id: bins.id, code: bins.code, systemOwned: bins.systemOwned })
      .from(bins)
      .where(
        and(
          eq(bins.id, command.binId),
          eq(bins.warehouseId, command.warehouseId),
          eq(bins.tenantId, command.tenantId),
        ),
      )
      .limit(1);
    const bin = rows[0];
    if (bin === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'Bin not found',
        'No bin with this id exists in this warehouse.',
      );
    }
    // The system QC-hold bin is hold/release-owned (story 3.4): an adjustment
    // moving stock into or out of it would drop ATP with no hold row and no
    // release path — only the QC hold/release commands ever move stock
    // through it.
    if (bin.systemOwned && bin.code === QC_HOLD_BIN_CODE) {
      throw new ProblemException(
        'qc-bin-not-adjustable',
        400,
        'The system QC-hold bin is not adjustable',
        'The system QC-hold bin is moved only by QC hold and release commands — stock adjustments cannot touch it.',
      );
    }
    return bin;
  }

  private async assertSkuInTenant(
    tx: TenantTx,
    command: AdjustStockCommand,
  ): Promise<{ id: string }> {
    const rows = await tx
      .select({ id: skus.id })
      .from(skus)
      .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
      .limit(1);
    if (rows[0] === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'SKU not found',
        'No SKU with this id exists in this tenant.',
      );
    }
    return rows[0];
  }

  /**
   * The movement itself: a positive delta is an into-bin movement
   * (`to_bin_id`), a negative delta an out-of-bin movement (`from_bin_id`)
   * — the signed-delta envelope convention documented on `ledger_events`.
   *
   * Story 2.4 arms: a batch-tracked movement carries the resolved `batchRef`
   * (and its reference doc carries the override reason when the client drew
   * an explicit batch over the FEFO default); a serial-tracked movement is
   * exactly ONE event per serial unit — N qty-±1 events in this one
   * transaction, each with its own `serialRef`. The snapshot reports the
   * last appended event and the bin's final on-hand (the response shape is
   * unchanged — additive arms only).
   */
  private async adjustToSnapshot(
    tx: TenantTx,
    command: AdjustStockCommand,
    delta: SignedQuantity,
    occurredAt: string,
  ): Promise<StockAdjustmentSnapshot> {
    const serialRefs = command.serialRefs ?? [];
    // Review loop 1: lock the whole serial set tenant-wide in sorted order
    // BEFORE the first append — two concurrent multi-serial adjustments with
    // overlapping serials must not deadlock acquiring per-event locks in
    // input order (each append re-acquires its own serial's lock as a no-op).
    if (serialRefs.length > 0) {
      await this.ledger.lockSerialsInTx(tx, command.tenantId, serialRefs);
    }
    // One unit per serial event; a fieldless/batch-only movement moves the
    // whole delta on one event.
    const perEventDelta = (serialRefs.length > 0 ? Math.sign(delta) : delta) as SignedQuantity;
    // The override reason rides the reference doc verbatim — the
    // hash-chained ledger is the audit log (CHECKPOINT 1 resolution).
    const referenceDoc = {
      kind: 'manual-adjustment' as const,
      reasonCode: command.reasonCode,
      note: command.note,
      ...(command.batch?.overrideReason !== undefined
        ? { overrideReason: command.batch.overrideReason }
        : {}),
    };

    // Zero deltas are rejected upstream (`assertNonZeroDelta`), so `< 0` /
    // `> 0` partition every reachable delta — a zero-delta event would carry
    // no bin on either arm.
    let appended = await this.ledger.appendMovement(tx, {
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      type: 'stock.adjusted',
      skuId: command.skuId,
      quantityDelta: perEventDelta,
      fromBinId: delta < 0 ? command.binId : null,
      toBinId: delta > 0 ? command.binId : null,
      batchRef: command.batchRef ?? null,
      serialRef: serialRefs[0] ?? null,
      actorUserId: command.actorUserId,
      occurredAt,
      recordedAt: nowIso(),
      referenceDoc,
    });
    for (let i = 1; i < serialRefs.length; i += 1) {
      appended = await this.ledger.appendMovement(tx, {
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        type: 'stock.adjusted',
        skuId: command.skuId,
        quantityDelta: perEventDelta,
        fromBinId: delta < 0 ? command.binId : null,
        toBinId: delta > 0 ? command.binId : null,
        batchRef: command.batchRef ?? null,
        serialRef: serialRefs[i]!,
        actorUserId: command.actorUserId,
        occurredAt,
        recordedAt: nowIso(),
        referenceDoc,
      });
    }

    const touched = appended.touched[0]!;
    return {
      event: {
        id: appended.eventId,
        seq: appended.seq,
        type: 'stock.adjusted',
        skuId: command.skuId,
        binId: command.binId,
        quantityDelta: command.quantityDelta,
        occurredAt: appended.occurredAt,
        recordedAt: appended.recordedAt,
      },
      onHand: {
        skuId: command.skuId,
        binId: touched.binId,
        quantity: touched.quantity,
      },
    };
  }
}