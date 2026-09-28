import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  bins,
  idempotencyKeys,
  skus,
  stockAdjustmentPendings,
  stockAdjustmentPolicies,
} from '../../shared/db/schema';
import {
  QUANTITY_SCALE,
  assertRecordableQuantity,
  fromMilli,
  signedQuantity,
} from '../../shared/primitives/quantity';
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
import { IN_TRANSIT_BIN_CODE, QC_HOLD_BIN_CODE } from '../tenancy/receiving-bin';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { uomPrecision } from '../catalog/uom';
import { LedgerService } from './ledger.service';
// Story 10.3 — the catch-weight write seam. `handling_units` is CATALOG-owned
// and has exactly one writer (AD-6); this module never touches the table.
//
// It is imported as file-level in-tx functions rather than through
// `CatalogFacade`, because the status flip must commit in the SAME transaction
// as the ledger event — a flip that half-landed would either ship a written-off
// case or strand a live one — and this module cannot take a DI edge on
// `CatalogModule`: catalog reaches tenancy, tenancy reaches putaway, putaway
// reaches back here, so the edge is a module-EVALUATION cycle no `forwardRef`
// can unwind. The repo's established escape for exactly this is the file-level
// in-tx helper (`ensureReceivingBinInTx`, `openQcHoldsForBinsInTx`), and
// `CatalogFacade` exposes the very same functions to the siblings that can
// hold it.
import {
  lockHandlingUnitsInTx,
  markHandlingUnitsAdjustedInTx,
} from '../catalog/handling-unit.store';
import { MAX_HANDLING_UNITS_PER_REQUEST } from '../catalog/handling-unit';
// Story 11.4 — the kit-ness reads, same escape: file-level in-tx helpers out
// of catalog (the store above), never a DI edge on `CatalogModule`.
import { getKitSkuIdsInTx, kitCannotHoldStock } from '../catalog/kit.store';

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
  /**
   * Signed delta in the SKU's BASE UoM; zero is rejected (a nothing movement).
   *
   * Story 10.2: base units, not milli-units. The controller used to scale it
   * while building this argument — which would have put the precision refusal
   * in front of the replay lookup below. It is converted inside `adjust`,
   * after the SKU's row (and therefore its declared precision) is read.
   */
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
  /**
   * Story 10.3 — the per-unit channel for a catch-weight SKU, mirroring
   * `serialRefs`. It is REQUIRED on a catch-weight adjustment and its length
   * must equal `|quantityDelta|`.
   *
   * Without a way to NAME the units, this write-off would be untargetable: a
   * handling unit has no location, so an aggregate `quantityDelta` alone
   * cannot say WHICH of N cases was damaged — and every named unit that is
   * not moved out of `active` stays packable, which means a case written off
   * as damaged still ships. That is the fail-open the review found; this
   * field is its fix.
   */
  readonly handlingUnitIds?: readonly string[] | undefined;
  /**
   * Story 5-2 — the approval path's restored FEFO-override reason. The pend
   * row stores the override draw's `batch.overrideReason` (the referenceDoc
   * audit field the immediate path 400-requires), but NOT the raw `batch`
   * input — it stores the RESOLVED arms. When the approval re-executes those
   * arms it has the resolved `batchRef` but no batch object, so it passes the
   * stored reason here instead; `adjustToSnapshot` resolves the referenceDoc
   * field as `command.batch?.overrideReason ?? command.approvedOverrideReason`,
   * making the approved event's referenceDoc byte-identical to what the same
   * request would have produced immediately. Always undefined on the HTTP
   * immediate path.
   */
  readonly approvedOverrideReason?: string | undefined;
}

/**
 * The API response body (the idempotency snapshot).
 *
 * Story 5-2 (retro A4, multi-serial arm only): a MULTI-serial adjustment
 * appends one event per serial unit, so no single (id, seq) represents the
 * response — the snapshot carries `id: null, seq: null` with the AGGREGATE
 * `quantityDelta`. A SINGLE-serial adjustment keeps its exact `id`/`seq`
 * pairing (the pre-story contract); non-serial snapshots are byte-identical
 * to before. The outbox payload mirrors this pairing.
 */
export interface StockAdjustmentSnapshot {
  readonly event: {
    readonly id: string | null;
    readonly seq: number | null;
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

/**
 * The 202 response body (story 5-2): the pend creation snapshot — the
 * request's resolved arms, frozen at request time. The idempotency snapshot
 * stores this shape too, so a replayed pend creation re-serves the stored
 * 202 (frozen matrix row: nothing below replay runs on a replay).
 */
export interface StockAdjustmentPendingSnapshot {
  readonly pendingAdjustment: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly binId: string;
    readonly skuId: string;
    /** The signed delta in BASE units — base units at the edge (story 10.1). */
    readonly quantityDelta: number;
    readonly reasonCode: string;
    readonly note: string;
    /** The override draw's FEFO-override reason; null on every other adjustment. */
    readonly batchOverrideReason: string | null;
    readonly batchId: string | null;
    readonly serialIds: readonly string[] | null;
    readonly handlingUnitIds: readonly string[] | null;
    readonly occurredAt: string;
    readonly requestedBy: string;
    readonly requestedAt: string;
    readonly status: 'pending';
    readonly decidedBy: null;
    readonly decidedAt: null;
    /** The policy threshold (base units) as it read at request time. */
    readonly thresholdQuantityAtRequest: number;
  };
}

/**
 * `adjust`'s outcome (story 5-2): the over-threshold branch turns what used
 * to be a single shape into this discriminated union — `applied` is the
 * pre-story 201 behavior byte-identically, `pending` is the 202. The
 * idempotency snapshot stores whichever shape the original request produced,
 * so a replay re-serves it verbatim.
 */
export type StockAdjustmentResult =
  | { readonly kind: 'applied'; readonly snapshot: StockAdjustmentSnapshot; readonly replayed: boolean }
  | { readonly kind: 'pending'; readonly pending: StockAdjustmentPendingSnapshot; readonly replayed: boolean };

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
    // ── story 10.2: this fingerprint is over BASE units ────────────────────
    // Conversion moved out of the controller and into the command, behind the
    // replay lookup, so the hashed value changed with it: a key written by a
    // pre-10.2 build hashed MILLI-units and now answers 422
    // `idempotency-key-reuse` rather than replaying. Accepted deliberately
    // under the pre-launch premise — the same call story 10.1 made about the
    // ledger hash chain — and pinned as EXPECTED by the cross-version replay
    // guard in `test/picking.spec.ts`, so it is a recorded break and not a
    // surprise. No compatibility branch exists; there is nothing to be
    // compatible with.
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
      // Story 10.3 — ADDITIVE, and in the operator's own order like
      // `serials`: it is an identity list the client chose, not a set the
      // command normalizes. Absent normalizes to `undefined`, which
      // `JSON.stringify` drops, so a non-catch-weight adjustment hashes
      // byte-identically to its pre-10.3 shape.
      // SORTED, matching the sibling list in `pack.command.ts`: scanning
      // cases A,B,C off a damaged pallet is the same physical act as C,B,A,
      // so the two orderings must replay rather than answer 422. (`serials`
      // above is deliberately left unsorted — its order is the order the
      // ledger writes one event per serial in, which is intent, not a set.)
      handlingUnitIds:
        command.handlingUnitIds == null ? undefined : [...command.handlingUnitIds].sort(),
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
  ): Promise<StockAdjustmentSnapshot | StockAdjustmentPendingSnapshot | null> {
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
      return existing.responseSnapshot as StockAdjustmentSnapshot | StockAdjustmentPendingSnapshot;
    });
  }

  async adjust(
    command: AdjustStockCommand,
    idempotencyKey: string,
  ): Promise<StockAdjustmentResult> {
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
    this.assertNonZeroDelta(command.quantityDelta);

    // Serial-tracked movements move exactly one unit per event: the serial
    // count must equal the movement's magnitude (400 otherwise — the api
    // layer's DTO validation composes, this is the command's own backstop).
    // `serialRefs.length` is an array length, which is a UNIT count and can
    // never be anything else, so story 10.2 makes the comparison where the
    // delta is ALSO in units: base UoM, before the transaction. It is a shape
    // check on the request, needs no SKU row, and stays exactly where it was.
    const serialRefs = command.serialRefs ?? [];
    if (serialRefs.length > 0 && serialRefs.length !== Math.abs(command.quantityDelta)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'quantityDelta must match the serial count',
        `A serial-tracked movement writes one ledger event per serial unit — ${serialRefs.length} serials cannot move ${command.quantityDelta} units.`,
      );
    }

    // Story 10.3: the same shape check for the catch-weight channel, in the
    // same tier and for the same reason — an array length is a UNIT count,
    // comparable against a base-UoM delta with no SKU row in hand. Whether
    // THIS SKU requires the channel at all needs the row, so it is asked
    // behind the replay lookup below.
    const handlingUnitIds = command.handlingUnitIds ?? [];
    if (handlingUnitIds.length > 0) {
      // The command tier's own bound — the DTO publishes the same number, so
      // the two gates cannot disagree and a non-HTTP caller meets the rule.
      if (handlingUnitIds.length > MAX_HANDLING_UNITS_PER_REQUEST) {
        throw new ProblemException(
          'validation-failed',
          400,
          'Too many handling units in one adjustment',
          `An adjustment names at most ${MAX_HANDLING_UNITS_PER_REQUEST} handling units (got ${handlingUnitIds.length}).`,
        );
      }
      if (new Set(handlingUnitIds).size !== handlingUnitIds.length) {
        throw new ProblemException(
          'validation-failed',
          400,
          'handlingUnitIds repeats a unit',
          'A handling unit is one physical case — naming it twice in one adjustment would write it off twice.',
        );
      }
      if (handlingUnitIds.length !== Math.abs(command.quantityDelta)) {
        throw new ProblemException(
          'validation-failed',
          400,
          'quantityDelta must match the handling-unit count',
          `A catch-weight movement moves one handling unit per unit of quantity — ${handlingUnitIds.length} handling unit(s) cannot move ${command.quantityDelta} units.`,
        );
      }
    }

    // Stable fingerprint over the command's business fields (fixed key
    // order — see hashCommandPayload). An omitted occurredAt is absent
    // from both attempts, so the fingerprint is stable across retries.
    // The Story 2.4 fields fingerprint the RAW request body (not the
    // FEFO-resolved ref): `JSON.stringify` drops undefined properties, so a
    // fieldless adjustment hashes byte-identically to its pre-2.4 shape.
    const payloadHash = this.fingerprint(command);

    const result: StockAdjustmentResult = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx): Promise<StockAdjustmentResult> => {
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
          // The stored snapshot is whichever shape the original request
          // produced — a 201 applied snapshot or a 202 pend creation (the
          // frozen matrix row: a replay re-serves it unconditionally; nothing
          // below replay runs).
          const stored = existing[0].responseSnapshot as
            | StockAdjustmentSnapshot
            | StockAdjustmentPendingSnapshot;
          return 'pendingAdjustment' in stored
            ? { kind: 'pending', pending: stored, replayed: true }
            : { kind: 'applied', snapshot: stored, replayed: true };
        }

        // ── the full guard set (story 5-2 extraction) ───────────────────────
        // Master-data integrity, the kit refusal, conversion + the precision
        // refusal, the catch-weight refusals, the arm-required parity checks
        // and the handling-unit guards all live in `assertAdjustableInTx`.
        // The threshold branch below sits AFTER the full guard set — only an
        // adjustment that would have applied can pend (a request failing a
        // shape/stock guard answers its 4xx, never pends).
        const { delta, handlingUnitIds } = await this.assertAdjustableInTx(tx, command);

        // ── story 5-2: the approval-threshold branch ────────────────────────
        // POSITION IS LOAD-BEARING: behind the replay lookup (a committed
        // adjustment replays its stored snapshot whatever today's threshold
        // says), after the full guard set (only an executable adjustment
        // pends), and immediately before the ledger writes — a pending
        // adjustment writes NO ledger event, NO on-hand/ATP change, NO
        // handling-unit status change (the HU write-off runs in
        // `applyAdjustmentInTx`, below this branch).
        //
        // Semantics (frozen I/O note): approval is required when
        // |quantityDelta| > threshold, STRICTLY greater — at-threshold
        // applies immediately. The comparison runs in milli-units against
        // the threshold scaled to milli (`threshold` is an integer in base
        // units); `fromMilli` round-trips exactly (AD-9), so this is the
        // base-unit comparison without a float in sight. With NO policy row
        // the flow is DISABLED — config-not-code: a tenant opts in by
        // creating its policy row, and default-on would 202 every existing
        // adjustment.
        const policyRows = await tx
          .select({ quantityThreshold: stockAdjustmentPolicies.quantityThreshold })
          .from(stockAdjustmentPolicies)
          .where(eq(stockAdjustmentPolicies.tenantId, command.tenantId))
          .limit(1);
        const threshold = policyRows[0]?.quantityThreshold ?? null;
        if (threshold !== null && Math.abs(delta) > threshold * QUANTITY_SCALE) {
          const pendingId = uuidv7();
          const requestedAt = nowIso();
          await tx.insert(stockAdjustmentPendings).values({
            id: pendingId,
            tenantId: command.tenantId,
            warehouseId: command.warehouseId,
            binId: command.binId,
            skuId: command.skuId,
            // Signed milli-units — the converted delta, frozen at request.
            // The approval rebuilds the base delta with `fromMilli`, whose
            // round-trip is exact.
            quantityMilli: delta,
            reasonCode: command.reasonCode,
            note: command.note,
            // The override draw's mandatory FEFO-override reason — restored
            // into the approved event's referenceDoc at decision time (the
            // pend stores the RESOLVED arms, so the raw `batch` input does
            // not survive; only this reason does).
            batchOverrideReason: command.batch?.overrideReason ?? null,
            batchId: command.batchRef ?? null,
            serialIds: serialRefs.length > 0 ? [...serialRefs] : null,
            handlingUnitIds: handlingUnitIds.length > 0 ? [...handlingUnitIds] : null,
            occurredAt,
            requestedBy: command.actorUserId,
            requestedAt,
            status: 'pending',
            thresholdQuantityAtRequest: threshold,
          });

          // The audit row rides the same transaction (the decision-time
          // sibling writes `stock_adjustment.approved`/`.rejected`). The
          // pend REQUEST shares the immediate path's action — the targetType
          // (`stock_adjustment_pending`) is what distinguishes it (triage #22).
          await tx.insert(auditEvents).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            actorUserId: command.actorUserId,
            action: 'stock_adjustment.recorded',
            targetType: 'stock_adjustment_pending',
            targetId: pendingId,
            reference: idempotencyKey,
            occurredAt,
          });

          // Functional entry (Epic 9 surfaces the notification): the Owner
          // is told an adjustment awaits their decision. Outbox-only — no
          // delivery here.
          await this.outbox.append(tx, {
            messageId: uuidv7(),
            tenantId: command.tenantId,
            type: 'stock_adjustment.pending_approval',
            occurredAt,
            payload: {
              pendingAdjustmentId: pendingId,
              warehouseId: command.warehouseId,
              skuId: command.skuId,
              binId: command.binId,
              quantityDelta: command.quantityDelta,
              reasonCode: command.reasonCode,
              requestedBy: command.actorUserId,
              requestedAt,
              thresholdQuantity: threshold,
              notifyRole: 'owner',
            },
          });

          const pending: StockAdjustmentPendingSnapshot = {
            pendingAdjustment: {
              id: pendingId,
              tenantId: command.tenantId,
              warehouseId: command.warehouseId,
              binId: command.binId,
              skuId: command.skuId,
              // Base units at the edge (story 10.1).
              quantityDelta: command.quantityDelta,
              reasonCode: command.reasonCode,
              note: command.note,
              batchOverrideReason: command.batch?.overrideReason ?? null,
              batchId: command.batchRef ?? null,
              serialIds: serialRefs.length > 0 ? [...serialRefs] : null,
              handlingUnitIds: handlingUnitIds.length > 0 ? [...handlingUnitIds] : null,
              occurredAt,
              requestedBy: command.actorUserId,
              requestedAt,
              status: 'pending',
              decidedBy: null,
              decidedAt: null,
              thresholdQuantityAtRequest: threshold,
            },
          };
          await this.writeIdempotencyKeySnapshot(tx, command.tenantId, idempotencyKey, payloadHash, pending);
          return { kind: 'pending', pending, replayed: false };
        }

        // The immediate path — byte-identical to the pre-story behavior plus
        // its audit row (the frozen matrix row's `stock_adjustment.recorded`).
        const { snapshot, firstEventId } = await this.applyAdjustmentInTx(
          tx,
          command,
          delta,
          handlingUnitIds,
          occurredAt,
        );
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'stock_adjustment.recorded',
          targetType: 'ledger_event',
          // A multi-serial adjustment appends one event per serial unit; the
          // audit row points at the FIRST appended event (the response's
          // aggregate snapshot carries null id/seq — retro A4).
          targetId: firstEventId,
          reference: idempotencyKey,
          occurredAt,
        });

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
            // Story 10.1: a quantity leaves the domain in BASE units. The
            // outbox contract is unchanged by the representation migration —
            // an each-counted subscriber sees the identical number it always
            // saw. (Story 10.2: the command field is already base units.)
            quantityDelta: command.quantityDelta,
            // Retro A4 (story 5-2): the pairing mirrors the response snapshot
            // — null/null with the aggregate delta on a MULTI-serial
            // adjustment, the exact event id/seq on a single-serial one.
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
        return { kind: 'applied', snapshot, replayed: false };
      },
    );

    return result;
  }

  /**
   * The FULL adjustment guard set, in one transaction-scoped method (story
   * 5-2 extraction — the KEEP list: the threshold branch and the approval
   * apply both need "the same guards the immediate path runs", stated once).
   *
   * Order is unchanged from the pre-story adjust body: master-data integrity
   * (warehouse → bin → SKU), the kit refusal, conversion + the precision
   * refusal, the catch-weight refusals, the NEW arm-required parity checks,
   * then the handling-unit guards. Everything here answers its 4xx BEFORE the
   * threshold branch — a request failing a guard pends never.
   *
   * The approval path (adjustment-approval.command.ts) re-runs this exact
   * method on the stored arms, so an approval inherits the full guard set —
   * including a SKU flagged batch/serial-tracked AFTER the pend was raised
   * (the parity checks refuse the un-serialized / batch-less apply). It is
   * therefore public-not-private: the same-module approval command holds the
   * re-execution seam, and both classes live in the inventory module's own
   * command layer (no cross-module edge).
   */
  async assertAdjustableInTx(
    tx: TenantTx,
    command: AdjustStockCommand,
  ): Promise<{ delta: SignedQuantity; handlingUnitIds: readonly string[] }> {
    const serialRefs = command.serialRefs ?? [];
    const handlingUnitIds = command.handlingUnitIds ?? [];
    // Master-data integrity in the command transaction (no FK repo
    // convention): warehouse in tenant, bin in that warehouse, SKU in
    // tenant — a foreign or nonexistent scope is 404 before any write.
    await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
    // Integrity-only reads: a missing scope is 404 before any write
    // (the bin row is not used beyond existence; the SKU row carries the
    // unit the delta is measured in).
    await this.assertBinInWarehouse(tx, command);
    const sku = await this.assertSkuInTenant(tx, command);

    // ── story 11.4: a kit SKU never adjusts stock (FR-38) ───────────────
    // A kit's stock IS its components' — an adjustment against a kit SKU
    // would invent independent stock the explosion never sees. The
    // kit-ness answer is one file-level lookup (catalog owns
    // `kit_compositions`; this module cannot take a DI edge on
    // `CatalogModule`), read in this same transaction.
    const kitSkuIds = await getKitSkuIdsInTx(tx, command.tenantId, [command.skuId]);
    if (kitSkuIds.length > 0) {
      throw kitCannotHoldStock('stock.adjustment', [sku.code]);
    }

    // ── story 10.2: conversion and the precision refusal, HERE ─────────
    // ONLY the precision rule moved behind the replay lookup, because only
    // it can tighten: the shape checks above the transaction are the same
    // checks, in the same order, that they were before this story — a
    // malformed request still answers 400 rather than 404, and a used key
    // still answers 400 rather than replaying.
    //
    // Everything above this line is in the SKU's base UoM; everything
    // below it is in milli-units.
    const delta = signedQuantity(
      assertRecordableQuantity(
        command.quantityDelta,
        'quantityDelta',
        sku.uom,
        uomPrecision(sku.uom),
      ),
    );

    // ── story 10.3: the catch-weight arm, behind the replay lookup ────
    // Both directions fail CLOSED. A catch-weight SKU with no named units
    // is refused, because an untargeted write-off leaves every case
    // `active` and therefore packable — goods shipped that inventory says
    // do not exist. A non-catch-weight SKU carrying the field is refused
    // too, rather than having it quietly ignored.
    // A POSITIVE catch-weight adjustment has no coherent meaning here.
    // The only path that CREATES handling units is receipt, because a unit
    // cannot exist without a captured weight and there is nowhere on this
    // command to supply one. Left unrefused, the guard below would demand
    // ids for an intake and the write-off below would then write off live
    // cases to "add" stock — the exact inverse of intent.
    // Refused by name, the same way a catch-weight QC hold is: intake
    // outside receipt is deferred, not silently wrong.
    if (sku.catchWeightTracked && command.quantityDelta > 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'A catch-weight SKU cannot be adjusted upward',
        `SKU "${command.skuId}" is catch-weight tracked: every unit carries a captured weight, and receipt is the only path that can capture one. Receive the stock instead of adjusting it in.`,
      );
    }
    if (sku.catchWeightTracked && handlingUnitIds.length === 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'A catch-weight adjustment must name its handling units',
        `SKU "${command.skuId}" is catch-weight tracked: a handling unit has no location, so nothing but handlingUnitIds can say WHICH case this adjustment moves. Name ${Math.abs(command.quantityDelta)} handling unit(s).`,
      );
    }
    if (!sku.catchWeightTracked && handlingUnitIds.length > 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'SKU is not catch-weight tracked',
        `SKU "${command.skuId}" is not catch-weight tracked — it has no handling units, so handlingUnitIds is refused rather than ignored.`,
      );
    }

    // ── story 5-2: the arm-required parity checks ────────────────────────
    // Mirrored from the controller's `composeBatchSerialArms` (review loop 1
    // finding 2): a SKU's tracking flags are PATCHABLE, so a pend raised
    // while the SKU was untracked can face a serial/batch-tracked SKU at
    // approval time — and the approval re-executing un-armed would write
    // un-serialized / batch-less stock on a tracked SKU. Behind the replay
    // lookup, tighten-only: the immediate path ALWAYS satisfies these (the
    // controller resolves a batchRef for every batch-tracked movement and
    // requires serials on every serial-tracked one), so no immediate
    // adjustment changes behavior. The serial count parity is the
    // above-the-transaction shape check (an array length is a unit count).
    if (sku.serialTracked && serialRefs.length === 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'serials are required for a serial-tracked movement',
        'A serial-tracked movement writes one ledger event per serial unit — supply serials: [s1..sN] with quantityDelta = N.',
      );
    }
    if (sku.batchTracked && (command.batchRef ?? null) === null) {
      throw new ProblemException(
        'validation-failed',
        400,
        'batch is required for a batch-tracked movement',
        'A batch-tracked movement folds against a batch — the resolved batchRef must name it (intake identity or the FEFO default draw).',
      );
    }

    // The handling-unit guards (unknown/foreign/wrong-batch unit) decide
    // here; the STATUS WRITE-OFF runs later, in `applyAdjustmentInTx` —
    // a pend must not move a handling unit out of active.
    if (handlingUnitIds.length > 0) {
      await this.assertHandlingUnitsAdjustableInTx(tx, command, handlingUnitIds);
    }

    return { delta, handlingUnitIds };
  }

  /**
   * The movement itself (story 5-2 extraction): the handling-unit write-off
   * (immediate path only — a pend stops before it) plus the ledger appends.
   * The approval path calls exactly this on the stored arms, so the approved
   * events are what the same request would have produced immediately —
   * public for the same reason `assertAdjustableInTx` is.
   */
  async applyAdjustmentInTx(
    tx: TenantTx,
    command: AdjustStockCommand,
    delta: SignedQuantity,
    handlingUnitIds: readonly string[],
    occurredAt: string,
  ): Promise<{ snapshot: StockAdjustmentSnapshot; firstEventId: string }> {
    if (handlingUnitIds.length > 0) {
      await this.moveHandlingUnitsOutOfActive(tx, command, handlingUnitIds);
    }
    return this.adjustToSnapshot(tx, command, delta, occurredAt);
  }

  /**
   * The idempotency-key write (the invariant order's tail — key LAST), the
   * shared shape of the immediate and pend arms and of the approval
   * command's decisions. (The per-command convention: 26 command files
   * declare the constant, 15 carry their own `writeIdempotencyKey` — this
   * file now does too, triage #18.)
   */
  private async writeIdempotencyKeySnapshot(
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

  /**
   * Signed, non-zero delta (a zero-delta event is pure noise). Story 10.2:
   * this runs BEFORE the transaction on the base-UoM value — "is this a
   * movement at all" is a question about the request, not about the SKU's
   * unit, and it answered 400 before this story too.
   */
  private assertNonZeroDelta(raw: number): void {
    if (raw === 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'quantityDelta must be a non-zero integer',
        'A stock adjustment moves a non-zero quantity — zero deltas write no ledger event.',
      );
    }
  }

  /**
   * The bin must exist in this tenant's warehouse (404 otherwise). The
   * `bins` row is tenancy master data read here only for referential
   * integrity (uuid columns, no FKs — the repo convention); stock tables
   * stay inventory-exclusive (the architecture test enforces the writes).
   *
   * `stock.adjust` is the NAMED bypass for the gated writers' bin gates —
   * capacity (story 11-5) and the storage (12-1) / hazard (12-2) class
   * gates all ride it; each bypass is recorded in PENDING.
   */
  private async assertBinInWarehouse(
    tx: TenantTx,
    command: AdjustStockCommand,
  ): Promise<{ id: string; code: string }> {
    const rows = await tx
      .select({ id: bins.id, code: bins.code, systemOwned: bins.systemOwned, retiredAt: bins.retiredAt })
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
    // Story 3.6: a retired bin is operationally gone — excluded from the
    // adjustments' target choice. Referenced as a movement target it always
    // refuses (and a retired bin has no on-hand to draw from anyway).
    if (bin.retiredAt !== null) {
      throw new ProblemException(
        'bin-retired',
        400,
        'Bin is retired',
        `Bin "${bin.code}" is retired — stock adjustments cannot target it; retirement is terminal.`,
      );
    }
    // The system QC-hold bin is hold/release-owned (story 3.4): an adjustment
    // moving stock into or out of it would drop ATP with no hold row and no
    // release path — only the QC hold/release commands ever move stock
    // through it. The system IN-TRANSIT bin is the movements module's
    // (story 5-1) for the same reason: only a transfer's two legs ever move
    // stock through it — an adjustment parking units there would strand them
    // ATP-excluded with no transfer to complete and no drain path.
    if (
      bin.systemOwned &&
      (bin.code === QC_HOLD_BIN_CODE || bin.code === IN_TRANSIT_BIN_CODE)
    ) {
      throw new ProblemException(
        'qc-bin-not-adjustable',
        400,
        'The system QC-hold bin is not adjustable',
        'The system QC-hold bin is moved only by QC hold and release commands — stock adjustments cannot touch it.',
      );
    }
    return bin;
  }

  /**
   * The SKU must exist in this tenant (404 otherwise). Story 10.2: the read
   * also carries `uom` back, because the unit is what says how precise this
   * movement's quantity is allowed to be.
   *
   * Fix A2 (epic-11 retro F2): the read locks the SKU row `.for('update')` —
   * the same read it already performed, now serializing this +stock writer
   * against a concurrent kit-create on the same SKU (which locks the same row
   * in `lockSkus` before its stock guard). Without the lock, the adjustment's
   * kit probe could read not-a-kit while a kit create that saw stock = 0
   * committed in parallel — a kit SKU stranded with on-hand stock no command
   * can remove. The lock sits after the replay lookup, so a replayed
   * adjustment returns before this read and takes no lock.
   */
  private async assertSkuInTenant(
    tx: TenantTx,
    command: AdjustStockCommand,
  ): Promise<{
    id: string;
    code: string;
    uom: string;
    catchWeightTracked: boolean;
    // Story 5-2 — the flags the arm-required parity checks read (PATCHABLE,
    // so the approval path re-asks them against committed state).
    batchTracked: boolean;
    serialTracked: boolean;
  }> {
    const rows = await tx
      .select({
        id: skus.id,
        code: skus.code,
        uom: skus.uom,
        catchWeightTracked: skus.catchWeightTracked,
        batchTracked: skus.batchTracked,
        serialTracked: skus.serialTracked,
      })
      .from(skus)
      .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
      .limit(1)
      .for('update');
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
   * Story 5-2 — the GUARD half of the handling-unit write-off, split from
   * `moveHandlingUnitsOutOfActive` so the threshold branch can run it while
   * the status WRITE-OFF waits for the apply: a pending adjustment locks and
   * validates the named units (the 404/422 arms answer before a pend row
   * exists) but leaves every unit `active` — a pend writes no status change.
   *
   * Story 10.3's guard rules, verbatim: the rows are LOCKED first, so the
   * guards below decide against state that cannot move under them, and the
   * write is then conditional on `active` as the backstop rather than as the
   * gate. Refusal order mirrors pack's, because they are the same questions
   * about the same rows: a unit that is unknown, another tenant's or another
   * warehouse's is a 404 (an id that does not resolve here must never reveal
   * that it resolves elsewhere); one belonging to a different SKU is a 422
   * naming both; one that is no longer `active` is a 409 naming the status
   * it actually holds (that 409 rides the WRITE below, not this guard).
   */
  private async assertHandlingUnitsAdjustableInTx(
    tx: TenantTx,
    command: AdjustStockCommand,
    handlingUnitIds: readonly string[],
  ): Promise<void> {
    const units = await lockHandlingUnitsInTx(tx, command.tenantId, handlingUnitIds);
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    for (const id of handlingUnitIds) {
      const unit = byId.get(id);
      if (unit === undefined || unit.warehouseId !== command.warehouseId) {
        throw new ProblemException(
          'not-found',
          404,
          'Handling unit not found',
          `No handling unit with id "${id}" exists in this warehouse.`,
        );
      }
      if (unit.skuId !== command.skuId) {
        throw new ProblemException(
          'validation-failed',
          422,
          'Handling unit belongs to another SKU',
          `Handling unit "${id}" belongs to SKU "${unit.skuId}", but this adjustment moves SKU "${command.skuId}".`,
        );
      }
      // Story 10.3: the case must belong to the LOT this movement debits.
      // `batchRef` is what `batch_on_hand` folds against, so writing off a
      // LOT-B case while debiting LOT-A would leave both lots wrong and the
      // recall trace pointing at the wrong one.
      if ((unit.batchId ?? null) !== (command.batchRef ?? null)) {
        throw new ProblemException(
          'validation-failed',
          422,
          'Handling unit belongs to another batch',
          `Handling unit "${id}" carries batch "${unit.batchId ?? 'none'}", but this adjustment moves batch "${command.batchRef ?? 'none'}". A catch-weight case is written off against the lot it was received into.`,
        );
      }
      // NOTE what is deliberately NOT checked here: the unit's STATUS. A
      // status read and a separate status write are two chances to disagree,
      // and a guard duplicating the write's own predicate makes the write
      // untestable — remove the predicate and nothing fails. The single
      // authority is the conditional `.where(status = 'active')` write in
      // `moveHandlingUnitsOutOfActive`; its 409 names each offending unit's
      // real status by re-reading the rows the transaction holds locked.
    }
  }

  /**
   * Story 10.3 — the named handling units leave `active`: the guard above,
   * then the conditional write (`.where(status = 'active')` inside the
   * catalog store) whose moved-count check is the 409's authority.
   */
  private async moveHandlingUnitsOutOfActive(
    tx: TenantTx,
    command: AdjustStockCommand,
    handlingUnitIds: readonly string[],
  ): Promise<void> {
    await this.assertHandlingUnitsAdjustableInTx(tx, command, handlingUnitIds);
    const moved = await markHandlingUnitsAdjustedInTx(tx, command.tenantId, handlingUnitIds);
    if (moved.length !== handlingUnitIds.length) {
      const writtenOffIds = new Set(moved.map((unit) => unit.id));
      const refused = handlingUnitIds.filter((id) => !writtenOffIds.has(id));
      const rows = await lockHandlingUnitsInTx(tx, command.tenantId, refused);
      throw new ProblemException(
        'conflict',
        409,
        'Handling unit is not active',
        `${refused.length} handling unit(s) are not active and cannot be adjusted away: ` +
          `${rows.map((row) => `${row.id} (${row.status})`).join(', ')}. ` +
          'Only an active unit can be written off — one already packed or already written off is refused. Nothing was written.',
      );
    }
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
   * transaction, each with its own `serialRef`. The snapshot reports the bin's
   * final on-hand; a SINGLE-serial (or non-serial) movement's snapshot names
   * the appended event exactly, while a MULTI-serial one carries the
   * aggregate `id: null / seq: null` pairing (retro A4, story 5-2).
   */
  private async adjustToSnapshot(
    tx: TenantTx,
    command: AdjustStockCommand,
    delta: SignedQuantity,
    occurredAt: string,
  ): Promise<{ snapshot: StockAdjustmentSnapshot; firstEventId: string }> {
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
    // One serial is one whole unit — `QUANTITY_SCALE` milli-units, carrying
    // the movement's direction.
    const perEventDelta = (
      serialRefs.length > 0 ? Math.sign(delta) * QUANTITY_SCALE : delta
    ) as SignedQuantity;
    // The override reason rides the reference doc verbatim — the
    // hash-chained ledger is the audit log (CHECKPOINT 1 resolution).
    // Story 10.3: the handling units this adjustment consumed ride the
    // already-hashed reference doc, SORTED — exactly as pack's do. Without
    // them the bench's consumption of a case is tamper-evident and the
    // write-off of one is not, which is the half of the story that decides
    // whether a case that never shipped can be proven to have been scrapped.
    // An optional key: a non-catch-weight adjustment's canonical bytes are
    // unchanged, because `JSON.stringify` drops the absent key.
    const adjustedHandlingUnitIds =
      command.handlingUnitIds === undefined || command.handlingUnitIds.length === 0
        ? undefined
        : [...command.handlingUnitIds].sort();
    // Story 5-2: the override reason's two carriers — the HTTP immediate
    // path carries it on `command.batch.overrideReason` (the controller
    // 400-requires it exactly on an override draw); the approval path
    // carries it on `approvedOverrideReason`, restored from the pend row
    // (the pend stores the RESOLVED arms, so the raw batch input does not
    // survive). Both make the referenceDoc byte-identical — the approved
    // event shows the timeline exactly what the immediate path would have.
    const overrideReason = command.batch?.overrideReason ?? command.approvedOverrideReason;
    const referenceDoc = {
      kind: 'manual-adjustment' as const,
      reasonCode: command.reasonCode,
      note: command.note,
      ...(overrideReason !== undefined ? { overrideReason } : {}),
      ...(adjustedHandlingUnitIds === undefined
        ? {}
        : { handlingUnitIds: adjustedHandlingUnitIds }),
    };

    // Zero deltas are rejected upstream (`assertNonZeroDelta`), so `< 0` /
    // `> 0` partition every reachable delta — a zero-delta event would carry
    // no bin on either arm. The FIRST appended event is kept separately: the
    // audit row points at it even when the response snapshot cannot name a
    // single event (multi-serial, below).
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
    const firstEventId = appended.eventId;
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

    // ── retro A4 (epic-2), scoped exactly as the frozen matrix row states ──
    // A MULTI-serial adjustment (serialRefs.length > 1) appends one event per
    // serial unit, so no single (id, seq) represents the response — the old
    // code reported the LAST event's id/seq against the AGGREGATE delta, a
    // snapshot that replays and outbox consumers could not reconcile with
    // the timeline. The aggregate snapshot carries `id: null, seq: null`
    // with the aggregate delta; the outbox payload mirrors the same pairing.
    // A SINGLE-serial adjustment keeps its exact id/seq pairing (the
    // pre-story contract — triage finding 3 scoped the fix to multi-serial
    // only), and non-serial snapshots are byte-identical to before.
    const multiSerial = serialRefs.length > 1;

    const touched = appended.touched[0]!;
    return {
      snapshot: {
        event: {
          id: multiSerial ? null : appended.eventId,
          seq: multiSerial ? null : appended.seq,
          type: 'stock.adjusted',
          skuId: command.skuId,
          binId: command.binId,
          // The snapshot IS the HTTP response body (and the idempotent replay's
          // stored copy) — base units at the edge, milli-units below it.
          quantityDelta: command.quantityDelta,
          occurredAt: appended.occurredAt,
          recordedAt: appended.recordedAt,
        },
        onHand: {
          skuId: command.skuId,
          binId: touched.binId,
          quantity: fromMilli(touched.quantity),
        },
      },
      firstEventId,
    };
  }
}