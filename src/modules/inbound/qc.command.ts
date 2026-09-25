import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, bins, idempotencyKeys, qcHolds, skus } from '../../shared/db/schema';
import type { UserRole } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { fromMilli, signedQuantity } from '../../shared/primitives/quantity';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { ensureQcHoldBinInTx, QC_HOLD_BIN_CODE } from '../tenancy/receiving-bin';
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
    readonly status: 'open' | 'released';
    readonly heldBy: string;
    readonly heldAt: string;
    readonly releasedBy: string | null;
    readonly releasedAt: string | null;
    readonly createdAt: string;
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
 * scrap disposition, no partial release, mobile untouched).
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

    // ── one open hold per (tenant, warehouse, sku, bin) scope ──────────
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
   * `qc-holds/:id/release`: moves the hold's stock back to the hold row's
   * recorded origin bin — exactly the units its own `qc.held` events moved
   * in (same batch arms, replayed from the ledger), never a caller-chosen
   * bin — and marks the row `released`. A second release is a deterministic
   * 409; an origin bin that has gone missing mid-hold is a 409 and the hold
   * stays open (a failed inspection keeps the hold open — no scrap
   * disposition; Epic 5's adjustment path shrinks quantities).
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
        throw new ProblemException(
          'qc-hold-released',
          409,
          'QC hold already released',
          `QC hold "${row.id}" is already released — releases are terminal.`,
        );
      }

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
        .limit(1);
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
        },
      };

      // ── the audit row + outbox event ────────────────────────────────────
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'qc_hold.released',
        targetType: 'qc_hold',
        targetId: row.id,
        reference: idempotencyKey,
        occurredAt: releasedAt,
      });

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
        },
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