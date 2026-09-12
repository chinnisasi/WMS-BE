import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  idempotencyKeys,
  orderLines,
  orders,
  picklistLines,
  skus,
} from '../../shared/db/schema';
import type { Order, OrderLine } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { ReservationSnapshot } from '../inventory/inventory.facade';

// ── state machine + policy constants (the outbound module exclusively owns
// the order state machine, AD-6 — no other module may add or transition
// order states; the additive arms below are the module's registry) ───────────

/** The order lifecycle arms shipped in story 4.1 (additive: 4.3/4.5/4.6 extend). */
export const ORDER_STATUSES = ['accepted', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The line fulfillment arms shipped in story 4.1. */
export const ORDER_LINE_STATUSES = ['open', 'backordered'] as const;
export type OrderLineStatus = (typeof ORDER_LINE_STATUSES)[number];

/** The order state machine's source arms (Epic 7's adapters keep the union). */
export const ORDER_SOURCES = ['manual', 'ingested'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/**
 * The reservation owner type every accepted order line holds through (the
 * `reservations.owner_type` arm Epic 2 reserved for this story's writers).
 */
export const ORDER_OWNER_TYPE = 'order';

/**
 * Accepted-order reservation TTL (the human decision 2026-09-10): seven
 * days. Expiry is detected downstream at commit time (409 `conflict`
 * "Reservation is not held") — no order-state machinery for expired holds
 * in this story; the reservation reaper restores the ATP either way.
 */
export const ORDER_RESERVATION_TTL_SECONDS = 7 * 24 * 3600;

/** Bounded ATP re-probe attempts when a line's grant loses a stock race. */
const MAX_GRANT_ATTEMPTS = 4;

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
/** The channel-dedup partial unique index (the race backstop's name). */
const ORDERS_SOURCE_EVENT_UNIQUE = 'orders_source_event_unique';

/** Max length of an ingested order's external event id (a channel ref). */
const MAX_EXTERNAL_EVENT_ID_LENGTH = 200;

/**
 * Line quantities are Postgres `integer`s — an input above the int4 ceiling
 * would pass every other validation and die as a raw 22003 at the INSERT
 * (after grants were made and released). The typed 400 is the boundary.
 */
const MAX_LINE_QUANTITY = 2_147_483_647;

// ── command inputs ───────────────────────────────────────────────────────────

/** One line as the client supplies it (manual entry and ingestion alike). */
export interface OrderLineInput {
  readonly skuId: string;
  /** Ordered quantity in base UoM — a positive integer. */
  readonly quantity: number;
}

export interface CreateOrderCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  /** `manual` (default) or `ingested` (the adapter-ready ingestion surface). */
  readonly source: OrderSource;
  readonly lines: readonly OrderLineInput[];
  /** Channel arms — required together when `source: 'ingested'`, else absent. */
  readonly integrationId?: string | undefined;
  readonly externalEventId?: string | undefined;
}

export interface CancelOrderCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly orderId: string;
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** One order line as every surface returns it — the shortfall always derived. */
export interface OrderLineSnapshot {
  readonly id: string;
  readonly orderId: string;
  readonly skuId: string;
  readonly qty: number;
  /** What acceptance actually holds through the reservation journal (≤ qty). */
  readonly reservedQty: number;
  /** Derived: qty − reservedQty — the backorder shortfall, never stored. */
  readonly shortfallQty: number;
  readonly status: string;
  /** The line's journal hold; null on a fully-backordered line. */
  readonly reservationId: string | null;
  /** The hold's live journal state (`held` at accept; read through the facade). */
  readonly reservationState: string | null;
  readonly createdAt: string;
}

/** The API response body for an order (the idempotency snapshot). */
export interface OrderSnapshot {
  readonly order: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly status: OrderStatus;
    readonly source: OrderSource;
    readonly integrationId: string | null;
    readonly externalEventId: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lines: readonly OrderLineSnapshot[];
  };
}

/** A line's client-facing fields with a fixed key order (the idempotency hash is key-order dependent). */
function lineFingerprint(line: OrderLineInput): Record<string, unknown> {
  return { skuId: line.skuId, quantity: line.quantity };
}

/**
 * The order commands (story 4.1): manual entry and idempotent ingestion
 * through ONE create path — acceptance reserves ATP per line through Epic
 * 2's reservation machinery (`InventoryFacade.grantReservation`,
 * `owner_type: 'order'`), and cancellation releases every open reservation
 * through the existing release path. Both follow the established command
 * invariant order: `assertPermission` (fresh DB role read) → idempotency
 * replay → validation → writes (uuidv7) → snapshot → in-tx outbox →
 * (audit) → `writeIdempotencyKey` last.
 *
 * The grant/reserve phase composes OUTSIDE the order-create transaction by
 * design: a reservation grant is itself a multi-transaction atomic unit
 * (probe tx → Valkey script → journal tx), so it cannot nest. The ordering
 * is what fails closed instead — every grant lands BEFORE the order-create
 * transaction opens, and any failure in either phase (a 503
 * `reservation-store-unavailable` from the store, a rejected create tx)
 * releases every reservation this command granted and writes nothing: the
 * invariant is "nothing accepted half-reserved", not "one transaction".
 */
@Injectable()
export class OrderCommandService {
  private readonly logger = new Logger('OrderCommand');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition at the command layer through the facades only
    // (AD-6): the per-line grants, the ATP reads, and the reservation-state
    // read ride the inventory facade's seam.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  /**
   * `POST .../orders` (manual + ingested): validates, dedupes channel
   * payloads at the database level, reserves ATP per line (the fixed
   * backorder policy — `min(qty, ATP)` reserved, the shortfall marked
   * `backordered`), and accepts the order in one create transaction that
   * also appends `order.created`, the audit row, and the idempotency key.
   * A reservation-store failure fails the WHOLE creation closed.
   */
  async createOrder(command: CreateOrderCommand, idempotencyKey: string): Promise<OrderSnapshot> {
    // A manual order carrying channel refs would be silently stripped below —
    // a believing client would get an order with no dedup protection on
    // redelivery. 400 before anything else.
    if (command.source !== 'ingested' && (command.integrationId !== undefined || command.externalEventId !== undefined)) {
      throw validationFailed(
        'Channel refs (integrationId/externalEventId) require source: "ingested".',
      );
    }
    const integrationId = command.source === 'ingested' ? (command.integrationId ?? null) : null;
    const externalEventId =
      command.source === 'ingested' ? (command.externalEventId ?? null) : null;

    // The payload hash (fixed key order — the hash is key-order dependent).
    // For an ingested order this is also the dedup fingerprint: the same
    // channel payload redelivered under a new idempotency key resolves to
    // the same order; a divergent payload on the same ref is a 422.
    const sourcePayloadHash =
      command.source === 'ingested'
        ? hashCommandPayload({
            warehouseId: command.warehouseId,
            lines: command.lines.map(lineFingerprint),
          })
        : null;
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      source: command.source,
      integrationId,
      externalEventId,
      lines: command.lines.map(lineFingerprint),
    });

    // ── phase 1 (read tx): authority → replay → validation → dedup ────────
    const preflight = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority at command-service entry — DB role read, same tx, BEFORE
      // the replay lookup (the deliberate fail-closed carve-out).
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'orders.manage',
      );

      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return { replayed: replay as OrderSnapshot };
      }

      // ── input validation (400 before any write) ─────────────────────────
      this.assertLines(command.lines);
      if (command.source === 'ingested') {
        if (integrationId === null || externalEventId === null || externalEventId === '') {
          throw validationFailed(
            'An ingested order names its channel — integrationId and externalEventId are required together.',
          );
        }
        // Non-HTTP callers (the Epic 7 adapter path) skip the DTO's @IsUUID —
        // the command is the boundary that keeps a bad ref out of the uuid
        // column (a raw 22P02 is never an answer).
        if (!UUID_RE.test(integrationId)) {
          throw validationFailed('integrationId must be a uuid.');
        }
        if (externalEventId.length > MAX_EXTERNAL_EVENT_ID_LENGTH) {
          throw validationFailed(
            `externalEventId is at most ${MAX_EXTERNAL_EVENT_ID_LENGTH} characters.`,
          );
        }
      }

      // ── master-data integrity in a write transaction (404 before writes) ─
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      await this.assertSkuIdsInTenant(
        tx,
        command.tenantId,
        command.lines.map((line) => line.skuId),
      );

      // ── channel dedup pre-check: the same payload twice → the same order ─
      // (the partial unique index is the concurrent-delivery backstop; this
      // read settles the sequential redelivery before any reservation moves).
      if (integrationId !== null && externalEventId !== null) {
        const existing = await tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, command.tenantId),
              eq(orders.integrationId, integrationId),
              eq(orders.externalEventId, externalEventId),
            ),
          )
          .limit(1);
        const prior = existing[0];
        if (prior !== undefined) {
          if (prior.sourcePayloadHash !== sourcePayloadHash) {
            throw orderSourceConflict(prior.id);
          }
          // Same payload redelivered: the first order's snapshot, no new
          // reservation. The key is written with that snapshot so a transport
          // retry of THIS delivery replays through the key as well.
          const snapshot = await this.snapshotOf(tx, prior);
          await this.writeIdempotencyKey(
            tx,
            command.tenantId,
            idempotencyKey,
            payloadHash,
            snapshot,
          );
          return { replayed: snapshot };
        }
      }
      return { replayed: null };
    });
    if (preflight.replayed !== null) {
      return preflight.replayed;
    }

    // ── phase 2: the per-line ATP split + grants (each its own atomic unit).
    // Every grant lands before the order-create tx opens; any failure here
    // writes nothing (the 503 propagates; a deterministic loss under the
    // backorder policy marks the line backordered instead).
    const lineIds = command.lines.map(() => uuidv7());
    const granted: { lineIndex: number; reservation: ReservationSnapshot }[] = [];
    try {
      for (let index = 0; index < command.lines.length; index += 1) {
        const line = command.lines[index]!;
        const reservation = await this.reserveLine(command, line, lineIds[index]!);
        if (reservation !== null) {
          granted.push({ lineIndex: index, reservation });
        }
      }
    } catch (err) {
      // Fail closed (the I/O matrix): a reservation-store failure (503) or
      // any other grant error aborts the whole creation — nothing accepted
      // half-reserved.
      await this.releaseAll(command.tenantId, granted, 'create-order-abort');
      throw err;
    }

    // ── phase 3 (write tx): the order + lines + outbox + audit + key ──────
    try {
      return await withTenantTransaction(this.db, command.tenantId, async (tx) => {
        const orderId = uuidv7();
        try {
          await tx.insert(orders).values({
            id: orderId,
            tenantId: command.tenantId,
            warehouseId: command.warehouseId,
            status: 'accepted',
            source: command.source,
            integrationId,
            externalEventId,
            sourcePayloadHash,
          });
        } catch (err) {
          if (isUniqueViolationOn(err, ORDERS_SOURCE_EVENT_UNIQUE)) {
            // A concurrent first delivery of the same channel payload won the
            // index — this command's grants are released (they belong to no
            // order) and the winner's snapshot is what both callers see.
            throw new DedupLostError(
              command.tenantId,
              integrationId!,
              externalEventId!,
              sourcePayloadHash,
            );
          }
          throw err;
        }
        await tx.insert(orderLines).values(
          command.lines.map((line, index) => {
            const hold = granted.find((entry) => entry.lineIndex === index);
            const reservedQty = hold?.reservation.quantity ?? 0;
            return {
              id: lineIds[index]!,
              tenantId: command.tenantId,
              orderId,
              skuId: line.skuId,
              qty: line.quantity,
              reservedQty,
              reservationId: hold?.reservation.id ?? null,
              status: reservedQty < line.quantity ? 'backordered' : 'open',
            };
          }),
        );

        const snapshot = await this.snapshotById(tx, orderId);

        // In-transaction outbox append (AD-7) — before the idempotency key.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'order.created',
          occurredAt: nowIso(),
          payload: { order: snapshot.order },
        });

        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'order.created',
          targetType: 'order',
          targetId: orderId,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });

        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      });
    } catch (err) {
      // The create tx failed (a lost dedup race or any other write fault):
      // the grants belong to no order — release them, then resolve the
      // dedup-loser outcome against the settled state.
      await this.releaseAll(command.tenantId, granted, 'create-order-rollback');
      if (err instanceof DedupLostError) {
        return this.resolveDedupLoser(err, idempotencyKey, payloadHash);
      }
      throw err;
    }
  }

  /**
   * `POST .../orders/{id}/cancel`: allowed while `accepted` (pre-pick),
   * idempotent-keyed.
   *
   * The order flips `accepted → cancelled` through one conditional UPDATE,
   * and the line reset + `order.cancelled` + the audit row + the idempotency
   * key commit WITH that flip — the flip's winner alone emits them. Only
   * then are the holds released, each through the existing path (its own
   * serialized terminal transition).
   *
   * Flip-first is deliberate. Releasing first and flipping after leaves a
   * crash window where stock is free while the order still reads `accepted`
   * — units sellable twice. This ordering inverts that: a crash leaves the
   * order `cancelled` with its holds still live, ATP understated until the
   * reaper expires them. A consumed (`committed`) hold is refused up front,
   * before anything is written; one that commits inside the pre-check →
   * release window can no longer be refused (the cancellation is durable by
   * then) and is logged as an operational anomaly instead.
   *
   * A replay under the original key re-serves the stored snapshot; a cancel
   * of an already-cancelled order under a NEW key is an idempotent no-op
   * (200 snapshot, the key is recorded against it).
   */
  async cancelOrder(command: CancelOrderCommand, idempotencyKey: string): Promise<OrderSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      orderId: command.orderId,
    });

    // ── phase 1 (read tx): authority → replay → load + lock the order ─────
    const preflight = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx): Promise<{ replayed: OrderSnapshot | null; order: Order | null }> => {
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'orders.manage',
        );

        const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replay !== null) {
          return { replayed: replay as OrderSnapshot, order: null };
        }

        const rows = await tx
          .select()
          .from(orders)
          .where(and(eq(orders.id, command.orderId), eq(orders.tenantId, command.tenantId)))
          .limit(1)
          .for('update');
        const order = rows[0];
        if (order === undefined) {
          throw orderNotFound(command.orderId);
        }
        return { replayed: null, order };
      },
    );
    if (preflight.replayed !== null) {
      return preflight.replayed;
    }
    const order = preflight.order!;

    // An already-cancelled order under a new key: the idempotent no-op
    // (200 snapshot). The flip below would find nothing to do anyway, but
    // the releases must not run again — return before them, recording the
    // key so the replay contract holds for this caller too.
    if (order.status === 'cancelled') {
      return withTenantTransaction(this.db, command.tenantId, async (tx) => {
        const snapshot = await this.snapshotById(tx, order.id);
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      });
    }

    // ── phase 2 (read): the pre-check — every line's hold, and the refusal ─
    // A consumed (committed) hold means a consuming flow won the reservation
    // first, so the order is no longer purely pre-pick stock: refuse BEFORE
    // anything is written.
    const lines = await withTenantTransaction(this.db, command.tenantId, (tx) =>
      tx
        .select({ reservationId: orderLines.reservationId })
        .from(orderLines)
        .where(and(eq(orderLines.tenantId, command.tenantId), eq(orderLines.orderId, order.id))),
    );
    const reservationIds = lines
      .map((line) => line.reservationId)
      .filter((id): id is string => id !== null);
    const live = await this.inventory.reservationsByIds(command.tenantId, reservationIds);
    const committed = live.filter((row) => row.state === 'committed');
    if (committed.length > 0) {
      // A consumed (committed) hold means a consuming flow won the
      // reservation first — the order is no longer purely pre-pick stock.
      throw new ProblemException(
        'conflict',
        409,
        'Order reservation is not held',
        `Order "${order.id}" has ${committed.length} committed reservation(s) — a consuming flow already claimed them; the order is not cancellable here.`,
      );
    }
    const holds = live.filter((row) => row.state === 'held');

    // Story 4.3: a COMMITTED hold is not the only way an order stops being
    // pre-pick stock. A hold settles only when the LAST open slice of its
    // order line is picked, so an order line split across two bins with one
    // slice already picked still carries a `held` reservation — and
    // releasing it here would free stock that has physically left the bin
    // through a `pick.picked` ledger draw. `cancelWave` refuses picked lines
    // for exactly this reason; the order's own cancel must refuse them too.
    const picked = await withTenantTransaction(this.db, command.tenantId, (tx) =>
      tx
        .select({ id: picklistLines.id })
        .from(picklistLines)
        .where(
          and(
            eq(picklistLines.tenantId, command.tenantId),
            eq(picklistLines.orderId, order.id),
            eq(picklistLines.status, 'picked'),
          ),
        ),
    );
    if (picked.length > 0) {
      throw new ProblemException(
        'conflict',
        409,
        'Order has picked lines',
        `Order "${order.id}" has ${picked.length} picked pick line(s) (${picked
          .map((line) => line.id)
          .join(', ')}) — those units have already left their bins, so the order is not cancellable here.`,
      );
    }

    // ── phase 3 (write tx): the flip + the lines + outbox + audit + key ───
    // The flip commits BEFORE the releases run. A crash between the two then
    // leaves the order `cancelled` with its holds still live — ATP
    // understated until the reaper expires them, never stock freed under an
    // order that still reads `accepted`. The fail-safe direction is the
    // whole reason this ordering was chosen over releasing first.
    const settled = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const updates = await tx
        .update(orders)
        .set({ status: 'cancelled', updatedAt: nowIso() })
        .where(
          and(
            eq(orders.id, order.id),
            eq(orders.tenantId, command.tenantId),
            eq(orders.status, 'accepted'),
          ),
        )
        .returning();
      const winner = updates[0];
      // A lost flip is the concurrent cancel's win — the idempotent no-op.
      // The WINNER's tx owns the outbox event, the audit row and the line
      // reset (one flip → one event, one audit line); the loser records only
      // its idempotency key so its replay contract still holds.
      if (winner !== undefined) {
        // The lines stop claiming stock in the same commit as the flip.
        // `reservation_id` is cleared with `reserved_qty` so no read — the
        // snapshot below, 4.2's Outbound surface, any roll-up — can report a
        // hold this order no longer owns. The journal keeps the audit trail:
        // every hold carries `owner_id` = the line id it was granted for.
        await tx
          .update(orderLines)
          .set({ reservedQty: 0, reservationId: null, updatedAt: nowIso() })
          .where(and(eq(orderLines.tenantId, command.tenantId), eq(orderLines.orderId, order.id)));
      }
      const target =
        winner ?? (await tx.select().from(orders).where(eq(orders.id, order.id)).limit(1))[0]!;
      const snapshot = await this.snapshotOf(tx, target);

      if (winner !== undefined) {
        // In-transaction outbox append (AD-7) — before the idempotency key.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'order.cancelled',
          occurredAt: nowIso(),
          payload: { order: snapshot.order },
        });

        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'order.cancelled',
          targetType: 'order',
          targetId: order.id,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });
      }

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return { snapshot, won: winner !== undefined };
    });

    // ── phase 4: release the holds, now that the flip is durable ──────────
    // Only the flip's winner releases (the loser's holds are the winner's to
    // settle). Nothing here may throw: the cancellation is already committed
    // and the caller's answer cannot be retracted, so a release that will not
    // settle is logged as the operational anomaly it is and left to the
    // hold's 7-day TTL — the ATP-understating direction.
    if (settled.won) {
      for (const hold of holds) {
        try {
          await this.inventory.releaseReservation(command.tenantId, hold.id);
        } catch (err) {
          if (err instanceof ProblemException && err.getStatus() === 409) {
            // A terminal writer won the conditional UPDATE between the
            // pre-check and this release — the 409 alone cannot say WHICH:
            // a racing cancel or the reaper's expiry is already settled and
            // nothing is owed, a consuming flow that committed inside that
            // window claimed stock this cancellation just gave away.
            const state = (await this.inventory.reservationsByIds(command.tenantId, [hold.id]))[0]
              ?.state;
            if (state === 'released' || state === 'expired') {
              continue;
            }
            this.logger.error(
              `Order cancel ${order.id}: reservation ${hold.id} is ${state ?? 'unknown'} — ` +
                `a consuming flow claimed it between the pre-check and the release, ` +
                `after the cancellation had committed. The order is cancelled and the ` +
                `committed hold stands; reconcile the pick against the cancellation.`,
            );
            continue;
          }
          this.logger.error(
            `Order cancel ${order.id}: releasing reservation ${hold.id} failed — ` +
              `${err instanceof Error ? err.message : String(err)}. The hold is left to ` +
              `its TTL (ATP understated until the reaper expires it).`,
          );
        }
      }
    }
    return settled.snapshot;
  }


  // ── shared pieces ─────────────────────────────────────────────────────────

  /**
   * One line's acceptance reservation: the per-line ATP split
   * `min(qty, ATP)` under the fixed backorder policy. A grant that loses a
   * stock race (409 `unavailable`) re-probes and reserves the remaining ATP
   * — the matrix's loser outcome — bounded retries; a line with nothing
   * left to reserve gets NO reservation (fully backordered).
   */
  private async reserveLine(
    command: CreateOrderCommand,
    line: OrderLineInput,
    lineId: string,
  ): Promise<ReservationSnapshot | null> {
    for (let attempt = 0; attempt < MAX_GRANT_ATTEMPTS; attempt += 1) {
      const atp = await this.inventory.atp(command.tenantId, command.warehouseId, line.skuId);
      const target = Math.min(line.quantity, atp.atp);
      if (target <= 0) {
        return null; // the fixed backorder policy: the shortfall is the line's status
      }
      try {
        return await this.inventory.grantReservation({
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          skuId: line.skuId,
          ownerType: ORDER_OWNER_TYPE,
          ownerId: lineId,
          quantity: target,
          ttlSeconds: ORDER_RESERVATION_TTL_SECONDS,
        });
      } catch (err) {
        const raceLoser =
          err instanceof ProblemException && err.getStatus() === 409 && codeOf(err) === 'unavailable';
        if (!raceLoser) {
          // 503 store-down (and any other fault) propagates — the whole
          // creation fails closed, nothing accepted half-reserved.
          throw err;
        }
        if (attempt < MAX_GRANT_ATTEMPTS - 1) {
          continue; // re-probe: a concurrent accept consumed units mid-grant
        }
        // The bounded retries are exhausted against a contended scope: the
        // fixed backorder policy's loser outcome, never a whole-creation 409.
        return null;
      }
    }
    // Unreachable (MAX_GRANT_ATTEMPTS ≥ 1 and every arm returns/continues/
    // throws) — kept so the compiler sees the loop can end.
    return null;
  }

  /** Releases every reservation this command granted (the nothing-written invariant). */
  private async releaseAll(
    tenantId: string,
    granted: readonly { lineIndex: number; reservation: ReservationSnapshot }[],
    cause: string,
  ): Promise<void> {
    for (const { reservation } of granted) {
      try {
        await this.inventory.releaseReservation(tenantId, reservation.id);
      } catch (err) {
        // A release that cannot settle leaves the hold to its 7-day TTL and
        // the reaper — the fail-safe direction (ATP understated, never
        // oversold). Logged, never masked.
        this.logger.error(
          `Order ${cause}: releasing reservation ${reservation.id} failed — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** The concurrent-dedup-loser outcome: re-read the winner, resolve the contract. */
  private async resolveDedupLoser(
    err: DedupLostError,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<OrderSnapshot> {
    const tenantId = err.tenantId;
    const existing = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.integrationId, err.integrationId),
            eq(orders.externalEventId, err.externalEventId),
          ),
        )
        .limit(1),
    );
    const prior = existing[0];
    if (prior === undefined) {
      // The winner rolled back after all — the caller retries against a
      // settled state (the grant-unique-violation re-probe precedent).
      throw new ProblemException(
        'conflict',
        409,
        'Concurrent order ingestion',
        'The same channel payload is being processed concurrently; retry to read the settled result.',
      );
    }
    if (prior.sourcePayloadHash !== err.sourcePayloadHash) {
      throw orderSourceConflict(prior.id);
    }
    // Same payload delivered concurrently: exactly one order exists — the
    // redelivery contract (the winner's snapshot, no new reservation).
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const snapshot = await this.snapshotOf(tx, prior);
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<unknown | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)),
      )
      .limit(1);
    const row = existing[0];
    if (row === undefined) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return row.responseSnapshot;
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

  private async snapshotById(tx: TenantTx, orderId: string): Promise<OrderSnapshot> {
    const rows = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    return this.snapshotOf(tx, rows[0]!);
  }

  /** The order + lines as one snapshot (the live reservation states ride in). */
  async snapshotOf(tx: TenantTx, order: Order): Promise<OrderSnapshot> {
    const lines = await tx
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, order.id))
      .orderBy(orderLines.createdAt, orderLines.id);
    const reservationIds = lines
      .map((line) => line.reservationId)
      .filter((id): id is string => id !== null);
    const reservations = new Map<string, ReservationSnapshot>();
    if (reservationIds.length > 0) {
      // The live reservation STATE through the facade (AD-6) — the line row
      // carries only the id; the journal carries the truth. The in-tx
      // passthrough (`appendLedgerEventInTx` precedent) keeps the snapshot's
      // reads in the caller's own transaction.
      for (const row of await this.inventory.reservationsByIdsInTx(tx, order.tenantId, reservationIds)) {
        reservations.set(row.id, row);
      }
    }
    return {
      order: {
        id: order.id,
        tenantId: order.tenantId,
        warehouseId: order.warehouseId,
        status: order.status as OrderStatus,
        source: order.source as OrderSource,
        integrationId: order.integrationId,
        externalEventId: order.externalEventId,
        createdAt: canonicalInstant(order.createdAt),
        updatedAt: canonicalInstant(order.updatedAt),
        lines: lines.map((line) => lineSnapshot(line, reservations)),
      },
    };
  }

  /** Every line's SKU must exist in the tenant (404 naming the unknown id). */
  private async assertSkuIdsInTenant(
    tx: TenantTx,
    tenantId: string,
    skuIds: readonly string[],
  ): Promise<void> {
    const distinct = [...new Set(skuIds)];
    const rows = await tx
      .select({ id: skus.id })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, distinct)));
    const found = new Set(rows.map((row) => row.id));
    for (const skuId of distinct) {
      if (!found.has(skuId)) {
        throw new ProblemException(
          'not-found',
          404,
          'SKU not found',
          `No SKU with id "${skuId}" exists in this tenant.`,
        );
      }
    }
  }

  /** Line-shape validation (400 before any write). */
  private assertLines(lines: readonly OrderLineInput[]): void {
    if (lines.length === 0) {
      throw validationFailed('An order carries at least one line.');
    }
    for (const line of lines) {
      if (!UUID_RE.test(line.skuId)) {
        throw validationFailed('Every line names a well-formed skuId.');
      }
      if (!Number.isInteger(line.quantity) || line.quantity <= 0 || line.quantity > MAX_LINE_QUANTITY) {
        throw validationFailed(
          `Line quantity must be a positive integer in base UoM, at most ${MAX_LINE_QUANTITY} (got ${String(line.quantity)}).`,
        );
      }
    }
  }
}

/** One stored line as every read of this module returns it. */
export function lineSnapshot(
  row: OrderLine,
  reservations: ReadonlyMap<string, ReservationSnapshot>,
): OrderLineSnapshot {
  const reservation = row.reservationId === null ? undefined : reservations.get(row.reservationId);
  return {
    id: row.id,
    orderId: row.orderId,
    skuId: row.skuId,
    qty: row.qty,
    reservedQty: row.reservedQty,
    shortfallQty: row.qty - row.reservedQty,
    status: row.status,
    reservationId: row.reservationId,
    reservationState: reservation?.state ?? null,
    createdAt: canonicalInstant(row.createdAt),
  };
}

// ── outcomes ─────────────────────────────────────────────────────────────────

function validationFailed(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Order validation failed', detail);
}

function orderNotFound(orderId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Order not found',
    `No order with id "${orderId}" exists in this tenant.`,
  );
}

/** A divergent payload on a channel ref that already created an order. */
function orderSourceConflict(existingOrderId: string): ProblemException {
  return new ProblemException(
    'order-source-conflict',
    422,
    'Channel order ref already used by another payload',
    `The (integration, external event) ref already created order "${existingOrderId}" with a DIFFERENT payload — this is a data conflict, not a retry.`,
  );
}

function codeOf(error: ProblemException): string {
  return (error.getResponse() as { code: string }).code;
}

/**
 * The concurrent-dedup-loser marker: thrown inside the create tx (its
 * rollback releases the grants through the outer catch) and resolved against
 * the settled winner outside it.
 */
class DedupLostError extends Error {
  constructor(
    readonly tenantId: string,
    readonly integrationId: string,
    readonly externalEventId: string,
    readonly sourcePayloadHash: string | null,
  ) {
    super('a concurrent delivery of the same channel payload won the dedup index');
  }
}
