import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, orderLines, orders, picks, skus } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { assertExactQuantity, fromMilli, signedQuantity } from '../../shared/primitives/quantity';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { LedgerReferenceDoc } from '../inventory/inventory.facade';
import { ORDER_OWNER_TYPE } from './order.command';
import type { OrderSource, OrderStatus } from './order.command';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** The no-op mirror a replay owes (the original command already applied its own). */
const EMPTY_RESTORES: ReadonlyMap<string, number> = new Map<string, number>();

/**
 * The discriminator that keeps this command's idempotency fingerprint out of
 * every sibling command's space. See the hash site for why it is required and
 * not decorative.
 */
const DISPATCH_COMMAND_KIND = 'outbound.dispatch';

/**
 * The ceiling on the free-text carrier arms. They ride the ledger's
 * reference doc (jsonb, so Postgres-free) but are still bounded: the event is
 * append-only and hash-chained, so an unbounded caller-controlled string
 * would be a permanent payload amplification in the one table nothing can
 * ever prune. 200 characters is a courier name and a consignment number with
 * room to spare — the `MAX_EXTERNAL_EVENT_ID_LENGTH` (4.1) precedent.
 */
export const MAX_CARRIER_NAME_LENGTH = 200;
export const MAX_TRACKING_NUMBER_LENGTH = 200;

// ── command inputs ───────────────────────────────────────────────────────────

export interface DispatchOrderCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly orderId: string;
  /**
   * Optional free-text carrier (the human decision, 2026-09-15). An operator
   * shipping by a manual courier records it today; the carrier stories
   * replace it with a real carrier id. Absence is never an error.
   */
  readonly carrierName?: string | null | undefined;
  /** Optional free-text tracking reference — same contract as the carrier. */
  readonly trackingNumber?: string | null | undefined;
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** One line of the dispatch record: what shipped, and the event it was journalled as. */
export interface DispatchedLineSnapshot {
  readonly orderLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  /** What the order asked for. */
  readonly orderedQty: number;
  /** What actually shipped for this line — the PICKED units (4.4: may be less). */
  readonly dispatchedQty: number;
  /** Derived: orderedQty − dispatchedQty; non-zero on a short-picked line. */
  readonly shortfallQty: number;
  /** The `dispatch.dispatched` event this line's shipment was journalled as. */
  readonly ledgerEventId: string;
}

/**
 * The dispatch record — and the idempotency snapshot, so a replay re-serves
 * it byte for byte. The `PackSnapshot` shape, deliberately: the two commands
 * are the same kind of terminal, per-order journalling act, and a surface
 * that renders one renders the other.
 */
export interface DispatchSnapshot {
  readonly dispatch: {
    readonly orderId: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    /** `dispatched` — the arm this command is the only writer of. */
    readonly orderStatus: OrderStatus;
    readonly source: OrderSource;
    readonly integrationId: string | null;
    readonly externalEventId: string | null;
    readonly dispatchedBy: string;
    readonly dispatchedAt: string;
    readonly carrierName: string | null;
    readonly trackingNumber: string | null;
    /** Total units shipped — the sum of every line's `dispatchedQty`. */
    readonly totalUnits: number;
    /**
     * The holds this dispatch retired `committed → released` — the ATP
     * correction, made visible. Empty when the order had none left (every
     * line short-picked to zero, or its holds already released).
     */
    readonly retiredReservationIds: readonly string[];
    readonly lines: readonly DispatchedLineSnapshot[];
  };
}

/**
 * The dispatch command (Story 4.6): `dispatch.execute`, a tenant-session
 * idempotent command, and the TERMINAL transition of the order state machine.
 * It flips a packed order to `dispatched`, journals one zero-quantity
 * `dispatch.dispatched` ledger event per order line, and retires every
 * `committed` reservation the order still owns to `released`.
 *
 * ── why the hold retirement is the point of the story ────────────────────────
 *
 * A pick settles its hold `held → committed` and draws the units out of stock
 * entirely. `schema.ts` says committed units "stay deducted until the
 * consuming ledger movement (Epic 4's dispatch)" — but until this story there
 * was no such movement, so nothing ever retired the hold. A fully-picked
 * order's units were therefore subtracted from ATP TWICE: once as on-hand the
 * draw removed, once as reserved nobody restored. Seed 100, accept 10, pick
 * it all, and ATP read 80 against an on-hand of 90 — permanently, because the
 * counter rebuild sums `state in ('held','committed')` and faithfully
 * reproduced the same wrong number. Retiring the hold here is what corrects
 * it, and `released` is the lifecycle's own documented exit, so no new
 * reservation state, no migration and no change to the rebuild.
 *
 * ATP stays understated for the pick→dispatch window. That is the deliberate
 * decision (2026-09-15): retiring at pick would mean editing the path 4.3/4.4
 * built and changing what `committed` means in the rebuild.
 *
 * ── why ONE transaction ──────────────────────────────────────────────────────
 *
 * A half-landed dispatch is unfixable in either direction: an order reading
 * `dispatched` with its holds still live understates ATP until the 7-day TTL,
 * and retired holds under an order still reading `ready_to_dispatch` free
 * stock for a shipment nothing records. So the flip, the events, the
 * retirements, the outbox event, the audit row and the idempotency key all
 * commit together — and the Valkey counter restore is applied only AFTER that
 * commit (4.4's journal-first ordering), because a decrement that outlived a
 * rollback would read as ATP the journal still holds.
 */
@Injectable()
export class DispatchCommandService {
  private readonly logger = new Logger('DispatchCommandService');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition through the facade only (AD-6): both the
    // `dispatch.dispatched` events and the hold retirements ride
    // `InventoryFacade`'s in-tx passthroughs inside THIS command's
    // transaction — the outbound module writes no inventory table.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  /**
   * `POST .../orders/{orderId}/dispatch` — one dispatch per order. A replay
   * under the same key re-serves the stored record; the same key with a
   * different payload is the deterministic 422; a SECOND dispatch under a NEW
   * key is a 409 (an order dispatches once, and `dispatched` is terminal —
   * there is no un-dispatch, no return and no re-open).
   */
  async dispatchOrder(
    command: DispatchOrderCommand,
    idempotencyKey: string,
  ): Promise<DispatchSnapshot> {
    // Shape and normalization BEFORE the hash (the `aggregateScan`
    // precedent): a trailing space on a courier name is not a different
    // intent, so " BlueDart " and "BlueDart" must replay rather than collide
    // on `idempotency-key-reuse`, and an empty string must hash identically
    // to an absent field.
    const carrierName = this.assertText(command.carrierName, 'carrierName', MAX_CARRIER_NAME_LENGTH);
    const trackingNumber = this.assertText(
      command.trackingNumber,
      'trackingNumber',
      MAX_TRACKING_NUMBER_LENGTH,
    );
    const payloadHash = hashCommandPayload({
      // The COMMAND discriminator, and it is load-bearing. `JSON.stringify`
      // drops `undefined` keys, so a dispatch with neither carrier arm would
      // otherwise serialize to exactly `{tenantId, orderId}` — byte-identical
      // to `cancelOrder`'s hashed object for the same order. `replay()` runs
      // before the status guard, so a client reusing one Idempotency-Key
      // across the two commands would be served the OTHER command's snapshot,
      // with the payload-hash check that exists to catch precisely this
      // agreeing. A constant arm nobody else uses makes the collision
      // impossible rather than merely unlikely.
      command: DISPATCH_COMMAND_KIND,
      tenantId: command.tenantId,
      orderId: command.orderId,
      carrierName: carrierName ?? undefined,
      trackingNumber: trackingNumber ?? undefined,
    });

    // The Valkey counter restores the retired holds owe are RETURNED by the
    // transaction callback, never staged in a closure variable (the 4.4
    // rule): a mirror applied for a transaction that did not commit reads as
    // ATP the journal still holds — the overselling direction.
    const committed = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── authority: the role is re-read from the DB per command (AD-10) ──
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'dispatch.execute',
      );

      // ── idempotency replay (before any read of state, before any write) ─
      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        // A replay re-serves and mirrors NOTHING — the original command
        // already applied its counter restore.
        return { snapshot: replay, counterRestores: EMPTY_RESTORES, warehouseId: null };
      }

      // ── the order, locked (the exactly-once serializer) ─────────────────
      // `for('update')` is what makes "an order dispatches once" true under
      // concurrency: two dispatches of the same order queue, and the second
      // reads the first's committed `dispatched`.
      const orderRows = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, command.orderId), eq(orders.tenantId, command.tenantId)))
        .limit(1)
        .for('update');
      const order = orderRows[0];
      if (order === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Order not found',
          `No order with id "${command.orderId}" exists in this tenant.`,
        );
      }
      if (order.status === 'dispatched') {
        // Two requests under the SAME key both pass the replay read above
        // (neither key row exists yet), then serialize on this row lock. The
        // loser must not be told to "replay the original Idempotency-Key" —
        // that is precisely what it sent. Re-read the key HERE, under the
        // lock, where the winner's row is now visible (the 4.5 same-key race
        // fix).
        const raced = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (raced !== null) {
          return { snapshot: raced, counterRestores: EMPTY_RESTORES, warehouseId: null };
        }
        // A DIFFERENT key against a dispatched order stays a 409 — the
        // frozen matrix row: an order dispatches once.
        throw dispatchConflict(
          'Order is already dispatched',
          `Order "${order.id}" already reads "dispatched" — an order dispatches once, and the arm is terminal. Replay the original Idempotency-Key to re-read its dispatch record.`,
        );
      }
      if (order.status !== 'ready_to_dispatch') {
        throw dispatchConflict(
          'Order is not dispatchable',
          `Order "${order.id}" reads "${order.status}" — only a packed (ready_to_dispatch) order is dispatched.`,
        );
      }

      // ── the flip (conditional — the exactly-once backstop) ──────────────
      const dispatchedAt = nowIso();
      const flipped = await tx
        .update(orders)
        .set({ status: 'dispatched', updatedAt: dispatchedAt })
        .where(
          and(
            eq(orders.id, order.id),
            eq(orders.tenantId, command.tenantId),
            eq(orders.status, 'ready_to_dispatch'),
          ),
        )
        .returning();
      if (flipped[0] === undefined) {
        // Unreachable beneath the row lock above; kept as the backstop that
        // rolls the whole transaction back rather than journalling a
        // shipment against an order this command did not actually move.
        throw dispatchConflict(
          'Order is already dispatched',
          `Order "${order.id}" moved out of "ready_to_dispatch" concurrently — an order dispatches once.`,
        );
      }

      // ── the order's lines and what actually shipped on each ─────────────
      // `picks` is the record of units that MOVED: a zero-unit short pick
      // wrote no row (contributing nothing, correctly) and a multi-slice
      // order line wrote several (which sum, correctly). What shipped is
      // exactly what was picked — the pack bench already verified that.
      const lines = await tx
        .select()
        .from(orderLines)
        .where(and(eq(orderLines.tenantId, command.tenantId), eq(orderLines.orderId, order.id)))
        .orderBy(asc(orderLines.createdAt), asc(orderLines.id));
      const pickRows = await tx
        // Story 10.1: `::bigint`; `int8` returns as a string, coerced below.
        .select({ orderLineId: picks.orderLineId, qty: sql<string>`sum(${picks.qty})::bigint` })
        .from(picks)
        .where(and(eq(picks.tenantId, command.tenantId), eq(picks.orderId, order.id)))
        .groupBy(picks.orderLineId);
      const pickedByLine = new Map(pickRows.map((row) => [row.orderLineId, Number(row.qty)]));

      const skuIds = [...new Set(lines.map((line) => line.skuId))];
      const skuRows =
        skuIds.length === 0
          ? []
          : await tx
              .select({ id: skus.id, code: skus.code, name: skus.name })
              .from(skus)
              .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.id, skuIds)));
      const skuById = new Map(skuRows.map((row) => [row.id, row]));

      // ── the ledger: one ZERO-quantity event per order line ──────────────
      // Picking already drew these units out of stock entirely (`pick.picked`
      // carries `toBinId: null`), so a dispatch has no bin to move between:
      // both arms are null, the magnitude is 0, and `appendMovement` folds no
      // projection. The event is the durable record of the SHIPMENT — and of
      // the carrier arms, which have nowhere else durable to live.
      const dispatchedLines: DispatchedLineSnapshot[] = [];
      let totalUnits = 0;
      for (const line of lines) {
        const dispatchedQty = pickedByLine.get(line.id) ?? 0;
        // ANNOTATED, not inferred: an object literal assigned to a typed
        // binding is excess-property checked, so a key the grammar's
        // `dispatch` arm does not declare is a compile error rather than a
        // field the ledger quietly persists outside its declared shape.
        const referenceDoc: LedgerReferenceDoc = {
          kind: 'dispatch',
          orderId: order.id,
          orderLineId: line.id,
          // Story 10.1: the reference doc is a DOCUMENT — it ships verbatim
          // on the ledger timeline, so it speaks base units.
          dispatchedQty: fromMilli(dispatchedQty),
          // Optional and additive: the keys serialize only when present, so
          // a dispatch with no carrier recorded carries neither.
          ...(carrierName === null ? {} : { carrierName }),
          ...(trackingNumber === null ? {} : { trackingNumber }),
        };
        const appended = await this.inventory.appendLedgerEventInTx(tx, {
          tenantId: command.tenantId,
          warehouseId: order.warehouseId,
          type: 'dispatch.dispatched',
          skuId: line.skuId,
          quantityDelta: signedQuantity(0),
          fromBinId: null,
          toBinId: null,
          batchRef: null,
          serialRef: null,
          actorUserId: command.actorUserId,
          occurredAt: dispatchedAt,
          recordedAt: dispatchedAt,
          referenceDoc,
        });
        const sku = skuById.get(line.skuId);
        // A SKU the read did not return falls back to its ID, never to an
        // empty string: this record is durable (it IS the idempotency
        // snapshot), and a blank code is a line nobody can identify later.
        dispatchedLines.push({
          orderLineId: line.id,
          skuId: line.skuId,
          skuCode: sku?.code ?? line.skuId,
          skuName: sku?.name ?? line.skuId,
          // Base units at the response/outbox edge (story 10.1).
          orderedQty: fromMilli(line.qty),
          dispatchedQty: fromMilli(dispatchedQty),
          shortfallQty: fromMilli(line.qty - dispatchedQty),
          ledgerEventId: appended.eventId,
        });
        totalUnits = assertExactQuantity(totalUnits + dispatchedQty, 'dispatch total units');
      }

      // ── the ATP correction: every `committed` hold retires ──────────────
      // Owner-keyed through the facade (AD-6), never id-keyed: 4.4's short
      // pick releases an order line's whole hold and re-grants the remainder
      // as a NEW row that no outbound column references, so a caller
      // collecting `order_lines.reservation_id` would miss holds.
      //
      // Conditional on `state = 'committed'` inside the facade, which is what
      // preserves AD-12: exactly one dispatch retires a hold. A line whose
      // hold is already `released` (4.4's re-grant path, 4.5's dead-hold
      // sweep, a zero-unit short pick) simply does not come back from the
      // read — nothing to retire and nothing double-restored.
      //
      // In the SAME transaction as the flip and the events, under the
      // warehouse advisory lock the appends above already took. The Valkey
      // mirror is NOT applied here — it rides OUT and lands after the commit.
      const committedHolds = await this.inventory.committedReservationsByOwnerInTx(
        tx,
        command.tenantId,
        order.warehouseId,
        ORDER_OWNER_TYPE,
        lines.map((line) => line.id),
      );
      const counterRestores = new Map<string, number>();
      const retiredReservationIds: string[] = [];
      for (const hold of committedHolds) {
        await this.inventory.retireCommittedReservationInTx(tx, command.tenantId, hold.id);
        counterRestores.set(
          hold.skuId,
          // The sum reaches the Valkey counter, where a rounded value is a
          // permanently wrong ATP nobody notices (story 10.1).
          assertExactQuantity(
            (counterRestores.get(hold.skuId) ?? 0) + hold.quantity,
            `dispatch counter restore for sku ${hold.skuId}`,
          ),
        );
        retiredReservationIds.push(hold.id);
      }
      // `order_lines.reservation_id` / `reserved_qty` are deliberately NOT
      // cleared, for the same reason 4.5 left them alone: the journal is the
      // state authority (the order detail reads it live through the facade),
      // so a retired hold already reads `released` everywhere, and the line
      // keeps naming the hold that actually served it.

      const snapshot: DispatchSnapshot = {
        dispatch: {
          orderId: order.id,
          tenantId: order.tenantId,
          warehouseId: order.warehouseId,
          orderStatus: 'dispatched',
          source: order.source as OrderSource,
          integrationId: order.integrationId,
          externalEventId: order.externalEventId,
          dispatchedBy: command.actorUserId,
          dispatchedAt: canonicalInstant(dispatchedAt),
          carrierName,
          trackingNumber,
          totalUnits: fromMilli(totalUnits),
          retiredReservationIds,
          lines: dispatchedLines,
        },
      };

      // ── in-transaction outbox append (AD-7) — before the idempotency key ─
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'order.dispatched',
        occurredAt: dispatchedAt,
        payload: { dispatch: snapshot.dispatch },
      });

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'order.dispatched',
        targetType: 'order',
        targetId: order.id,
        reference: idempotencyKey,
        occurredAt: dispatchedAt,
      });

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return { snapshot, counterRestores, warehouseId: order.warehouseId };
    });

    // ── the counter mirror, now that the journal half is durable ──────────
    // Journal first, mirror second (the 4.4 ordering): a mirror that never
    // lands only leaves ATP understated until the next rebuild — the same
    // state the order was already in — which is the fail-safe direction; one
    // applied for a rolled-back transaction would hand out stock the journal
    // still holds.
    //
    // NOTHING HERE MAY THROW (the cancel phase-4 rule). The dispatch is
    // already committed and the caller's answer cannot be retracted, so a
    // throw would turn a landed shipment into a 500 — and, worse, abandon
    // every LATER sku in the loop while a replay under the same key serves
    // the stored snapshot without ever re-attempting the mirror. That leaves
    // ATP understated permanently, which is the precise defect this story
    // exists to end. Each restore is therefore isolated: one scope's failure
    // is logged as the operational anomaly it is, the rest still run, and the
    // journal (which already reads `released`) repairs the counter at the
    // next rebuild or reaper parity pass.
    if (committed.warehouseId !== null) {
      for (const [skuId, units] of committed.counterRestores) {
        try {
          await this.inventory.restoreReservedUnits(
            command.tenantId,
            committed.warehouseId,
            skuId,
            units,
          );
        } catch (err) {
          this.logger.error(
            `Dispatch counter restore failed — reserved over-counts for this scope until the ` +
              `next rebuild (order ${committed.snapshot.dispatch.orderId}, sku ${skuId}, ` +
              `${units} unit(s)): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return committed.snapshot;
  }

  // ── input validation (400 before any write) ───────────────────────────────

  /**
   * One optional free-text carrier arm: trimmed, bounded, and normalized so
   * that absent, null and blank are the SAME intent (and therefore the same
   * payload hash). Absence is never an error — the whole point of the
   * pre-adapter carrier fields.
   */
  private assertText(
    value: string | null | undefined,
    field: string,
    maxLength: number,
  ): string | null {
    if (value === undefined || value === null) {
      return null; // optional: absence is never an error
    }
    // The DTO's `@IsString()` is the HTTP gate; this is the runtime backstop
    // for any non-HTTP caller (the type says `string`, so TS narrows it away,
    // but the emitted check still runs).
    if (typeof value !== 'string') {
      throw dispatchValidation(`${field} must be a string when present.`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null; // a blank is an absent field, not a recorded empty string
    }
    if (trimmed.length > maxLength) {
      throw dispatchValidation(
        `${field} must be at most ${maxLength} characters (got ${trimmed.length}).`,
      );
    }
    return trimmed;
  }

  // ── shared pieces (the 4.1 idempotency shape) ─────────────────────────────

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<DispatchSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (row === undefined) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return row.responseSnapshot as DispatchSnapshot;
  }

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

// ── outcomes ─────────────────────────────────────────────────────────────────

function dispatchValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Dispatch validation failed', detail);
}

function dispatchConflict(title: string, detail: string): ProblemException {
  return new ProblemException('conflict', 409, title, detail);
}
