import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  idempotencyKeys,
  orderLines,
  orders,
  picklistLines,
  picks,
  skus,
} from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { signedQuantity } from '../../shared/primitives/quantity';
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
import type { OrderSource, OrderStatus } from './order.command';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * Measurements are Postgres-free (they live on the ledger's reference doc,
 * which is jsonb) but still bounded: a scanned quantity above the int4
 * ceiling would die as a raw 22003 at the `picks` comparison, and an absurd
 * weight is a fat-fingered scale, not a parcel. The typed 400 is the
 * boundary (the 4.1 `MAX_LINE_QUANTITY` precedent).
 */
const MAX_SCAN_QUANTITY = 2_147_483_647;
/** 1000 kg — past this the bench is reporting grams as milligrams. */
const MAX_WEIGHT_GRAMS = 1_000_000;
/** 100 m — past this the bench is reporting millimetres as micrometres. */
const MAX_DIMENSION_MM = 100_000;

// ── command inputs ───────────────────────────────────────────────────────────

/** The parcel's measured box — all three arms together, or the whole object absent. */
export interface PackDimensionsInput {
  readonly lengthMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}

/** One scanned line at the bench: a SKU and the units counted into the parcel. */
export interface PackScanLineInput {
  readonly skuId: string;
  readonly qty: number;
}

export interface PackOrderCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly orderId: string;
  /** What the operator scanned into the parcel (aggregated per SKU here). */
  readonly scanned: readonly PackScanLineInput[];
  /** Optional parcel weight in grams — absence is never an error. */
  readonly weightGrams?: number | null | undefined;
  /** Optional parcel dimensions in millimetres — absence is never an error. */
  readonly dimensionsMm?: PackDimensionsInput | null | undefined;
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** One line of the packing slip: what was ordered, and what is actually in the parcel. */
export interface PackedLineSnapshot {
  readonly orderLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  /** What the order asked for. */
  readonly orderedQty: number;
  /** What actually left the bins for this line — the PICKED units (story 4.4: may be less). */
  readonly packedQty: number;
  /** Derived: orderedQty − packedQty; non-zero on a short-picked line. */
  readonly shortfallQty: number;
  /** The `pack.packed` event this line's verification was journalled as. */
  readonly ledgerEventId: string;
}

/**
 * The packing slip as a STRUCTURED PAYLOAD (the human decision, 2026-09-15):
 * the repo has no PDF, template or download machinery and no export
 * precedent, so rendering belongs to whichever surface prints it. The data is
 * the durable part — and it is also the idempotency snapshot, so a replay
 * re-serves the same slip byte for byte.
 */
export interface PackSnapshot {
  readonly pack: {
    readonly orderId: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    /** `ready_to_dispatch` — the arm this command is the only writer of. */
    readonly orderStatus: OrderStatus;
    readonly source: OrderSource;
    readonly integrationId: string | null;
    readonly externalEventId: string | null;
    readonly packedBy: string;
    readonly packedAt: string;
    readonly weightGrams: number | null;
    readonly dimensionsMm: PackDimensionsInput | null;
    /** Total units in the parcel — the sum of every line's `packedQty`. */
    readonly totalUnits: number;
    readonly lines: readonly PackedLineSnapshot[];
  };
}

/**
 * The pack-station verification command (Story 4.5): `pack.execute`, a
 * tenant-session idempotent command. It verifies the scanned contents of a
 * parcel against what the order actually had PICKED, journals one
 * zero-quantity `pack.packed` ledger event per order line, flips the order to
 * `ready_to_dispatch`, and returns everything a packing slip needs.
 *
 * Why ONE transaction: a pack that half-landed would leave an order claiming
 * to be packed with no ledger record of the verification, or a ledger full of
 * pack events against an order still reading `accepted` that a wave could
 * pick up again. Neither direction is fail-safe, so the verification, the
 * events, the flip, the outbox event, the audit row and the idempotency key
 * all commit together.
 *
 * Why the comparison is against PICKED and never ORDERED: story 4.4 made the
 * short pick a first-class outcome, so an order legitimately reaches the
 * bench with fewer units than its lines asked for. Comparing against ordered
 * quantities would refuse every short-picked order and push operators back to
 * leaving lines `planned` forever — the behaviour 4.4 exists to end.
 *
 * Why "fully picked" is LINE-STATUS based and never `picks`-based: a
 * zero-unit short pick writes no `picks` row at all and a multi-slice line
 * writes several, so counting pick rows answers neither "is anything still
 * outstanding" nor "how many lines were there". The completeness predicate
 * reads `picklist_lines` (at least one row, none still `planned`); the
 * per-SKU quantities read `picks` (which is exactly the units that moved).
 * The two questions have two different sources on purpose.
 */
@Injectable()
export class PackCommandService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition through the facade only (AD-6): the
    // `pack.packed` events ride `appendLedgerEventInTx` inside THIS
    // command's transaction — the outbound module writes no ledger table.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  /**
   * `POST .../orders/{orderId}/pack` — one idempotent pack per order. A
   * replay under the same key re-serves the stored slip; the same key with a
   * different payload is the deterministic 422; a SECOND pack of an order
   * that already reached `ready_to_dispatch` under a NEW key is a 409 (an
   * order reaches Ready-to-Dispatch once).
   */
  async packOrder(command: PackOrderCommand, idempotencyKey: string): Promise<PackSnapshot> {
    // Scans are aggregated and SORTED before hashing: the bench counts units,
    // it does not choose an order to count them in, so two postings of the
    // same physical parcel carry the same intent and must replay rather than
    // collide on `idempotency-key-reuse`. The measurements ARE intent (a
    // re-weigh is a different claim about the parcel) and hash as given.
    const scannedBySku = aggregateScan(command.scanned);
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      orderId: command.orderId,
      scanned: [...scannedBySku.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([skuId, qty]) => ({ skuId, qty })),
      weightGrams: command.weightGrams ?? undefined,
      dimensionsMm: command.dimensionsMm ?? undefined,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── authority: the role is re-read from the DB per command (AD-10) ──
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'pack.execute',
      );

      // ── idempotency replay (before any read of state, before any write) ─
      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return replay;
      }

      // ── input shape (400 before anything is read) ───────────────────────
      const weightGrams = this.assertWeight(command.weightGrams);
      const dimensionsMm = this.assertDimensions(command.dimensionsMm);

      // ── the order, locked (the exactly-once serializer) ─────────────────
      // `for('update')` is what makes "an order reaches Ready-to-Dispatch
      // once" true under concurrency: two packs of the same order queue, and
      // the second reads the first's committed `ready_to_dispatch`.
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
      if (order.status === 'ready_to_dispatch') {
        throw packConflict(
          'Order is already packed',
          `Order "${order.id}" already reads "ready_to_dispatch" — an order reaches Ready-to-Dispatch once. Replay the original Idempotency-Key to re-read its packing slip.`,
        );
      }
      if (order.status !== 'accepted') {
        throw packConflict(
          'Order is not packable',
          `Order "${order.id}" reads "${order.status}" — only an accepted order is packed.`,
        );
      }

      // ── completeness: LINE-STATUS based, never `picks`-based ────────────
      // An order is fully picked when it has at least one `picklist_lines`
      // row and none of them is still `planned`. `short`, `unfulfillable` and
      // `cancelled` are all SETTLED: the floor has said what it can about
      // each of them and nothing further is coming. A `planned` row is the
      // only one that means "an operator is still walking to this stop".
      const planLines = await tx
        .select({ id: picklistLines.id, status: picklistLines.status, skuId: picklistLines.skuId })
        .from(picklistLines)
        .where(
          and(
            eq(picklistLines.tenantId, command.tenantId),
            eq(picklistLines.orderId, order.id),
          ),
        )
        .orderBy(asc(picklistLines.createdAt), asc(picklistLines.id));
      if (planLines.length === 0) {
        throw packConflict(
          'Order has not been picked',
          `Order "${order.id}" is on no picklist — an unwaved order has not been picked, so there is nothing at the bench to verify.`,
        );
      }
      const outstanding = planLines.filter((line) => line.status === 'planned');
      if (outstanding.length > 0) {
        throw packConflict(
          'Order is not fully picked',
          `Order "${order.id}" still has ${outstanding.length} planned pick line(s) (${outstanding
            .map((line) => line.id)
            .join(', ')}) — every stop settles before the order is packed.`,
        );
      }

      // ── what was actually PICKED ────────────────────────────────────────
      // `picks` is the record of units that MOVED: a zero-unit short pick
      // wrote no row (contributing nothing, correctly), and a multi-slice
      // order line wrote one row per slice (which sum, correctly). Both
      // roll-ups come from the same read — per order line for the slip, per
      // SKU for the verification, because the bench counts SKUs and cannot
      // tell which line of a two-line order a unit belongs to.
      const pickRows = await tx
        .select({
          orderLineId: picks.orderLineId,
          skuId: picks.skuId,
          qty: sql<number>`sum(${picks.qty})::int`,
        })
        .from(picks)
        .where(and(eq(picks.tenantId, command.tenantId), eq(picks.orderId, order.id)))
        .groupBy(picks.orderLineId, picks.skuId);
      const pickedByLine = new Map<string, number>();
      const pickedBySku = new Map<string, number>();
      for (const row of pickRows) {
        pickedByLine.set(row.orderLineId, (pickedByLine.get(row.orderLineId) ?? 0) + Number(row.qty));
        pickedBySku.set(row.skuId, (pickedBySku.get(row.skuId) ?? 0) + Number(row.qty));
      }

      // ── the order's lines (one `pack.packed` event each) ────────────────
      const lines = await tx
        .select()
        .from(orderLines)
        .where(and(eq(orderLines.tenantId, command.tenantId), eq(orderLines.orderId, order.id)))
        .orderBy(asc(orderLines.createdAt), asc(orderLines.id));

      // ── the verification (a discrepancy is refused before ANY write) ────
      const skuIds = [
        ...new Set([...pickedBySku.keys(), ...scannedBySku.keys(), ...lines.map((l) => l.skuId)]),
      ];
      const skuRows =
        skuIds.length === 0
          ? []
          : await tx
              .select({ id: skus.id, code: skus.code, name: skus.name })
              .from(skus)
              .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.id, skuIds)));
      const skuById = new Map(skuRows.map((row) => [row.id, row]));
      for (const skuId of scannedBySku.keys()) {
        if (!skuById.has(skuId)) {
          throw new ProblemException(
            'not-found',
            404,
            'SKU not found',
            `No SKU with id "${skuId}" exists in this tenant.`,
          );
        }
      }
      this.assertScanMatchesPicked(order.id, pickedBySku, scannedBySku, skuById);

      // ── the flip (conditional — the exactly-once backstop) ──────────────
      const packedAt = nowIso();
      const flipped = await tx
        .update(orders)
        .set({ status: 'ready_to_dispatch', updatedAt: packedAt })
        .where(
          and(
            eq(orders.id, order.id),
            eq(orders.tenantId, command.tenantId),
            eq(orders.status, 'accepted'),
          ),
        )
        .returning();
      if (flipped[0] === undefined) {
        // Unreachable beneath the row lock above; kept as the backstop that
        // rolls the whole transaction back rather than journalling a pack
        // against an order this command did not actually move.
        throw packConflict(
          'Order is already packed',
          `Order "${order.id}" moved out of "accepted" concurrently — an order reaches Ready-to-Dispatch once.`,
        );
      }

      // ── the ledger: one ZERO-quantity event per order line ──────────────
      // Picking already drew these units out of stock entirely (`pick.picked`
      // carries `toBinId: null`), so a pack has no bin to move between: both
      // arms are null, the magnitude is 0, and `appendMovement` folds no
      // projection. The event is the durable record of the VERIFICATION —
      // and of the measurements, which have nowhere else durable to live.
      const packedLines: PackedLineSnapshot[] = [];
      let totalUnits = 0;
      for (const line of lines) {
        const packedQty = pickedByLine.get(line.id) ?? 0;
        // ANNOTATED, not inferred: an object literal assigned to a typed
        // binding is excess-property checked, so a key the grammar's `pack`
        // arm does not declare is a compile error rather than a field the
        // ledger quietly persists outside its own declared shape.
        const referenceDoc: LedgerReferenceDoc = {
          kind: 'pack',
          orderId: order.id,
          orderLineId: line.id,
          packedQty,
          // Optional and additive: the keys serialize only when present, so
          // an unmeasured parcel's canonical bytes carry neither.
          ...(weightGrams === null ? {} : { weightGrams }),
          ...(dimensionsMm === null
            ? {}
            : {
                lengthMm: dimensionsMm.lengthMm,
                widthMm: dimensionsMm.widthMm,
                heightMm: dimensionsMm.heightMm,
              }),
        };
        const appended = await this.inventory.appendLedgerEventInTx(tx, {
          tenantId: command.tenantId,
          warehouseId: order.warehouseId,
          type: 'pack.packed',
          skuId: line.skuId,
          quantityDelta: signedQuantity(0),
          fromBinId: null,
          toBinId: null,
          batchRef: null,
          serialRef: null,
          actorUserId: command.actorUserId,
          occurredAt: packedAt,
          recordedAt: packedAt,
          referenceDoc,
        });
        const sku = skuById.get(line.skuId);
        packedLines.push({
          orderLineId: line.id,
          skuId: line.skuId,
          skuCode: sku?.code ?? '',
          skuName: sku?.name ?? '',
          orderedQty: line.qty,
          packedQty,
          shortfallQty: line.qty - packedQty,
          ledgerEventId: appended.eventId,
        });
        totalUnits += packedQty;
      }

      const snapshot: PackSnapshot = {
        pack: {
          orderId: order.id,
          tenantId: order.tenantId,
          warehouseId: order.warehouseId,
          orderStatus: 'ready_to_dispatch',
          source: order.source as OrderSource,
          integrationId: order.integrationId,
          externalEventId: order.externalEventId,
          packedBy: command.actorUserId,
          packedAt: canonicalInstant(packedAt),
          weightGrams,
          dimensionsMm,
          totalUnits,
          lines: packedLines,
        },
      };

      // ── in-transaction outbox append (AD-7) — before the idempotency key ─
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'order.packed',
        occurredAt: packedAt,
        payload: { pack: snapshot.pack },
      });

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'order.packed',
        targetType: 'order',
        targetId: order.id,
        reference: idempotencyKey,
        occurredAt: packedAt,
      });

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── the verification ───────────────────────────────────────────────────────

  /**
   * The scan against what was picked, per SKU. Every divergence is named —
   * the SKU, what was picked, what was scanned — because the operator at the
   * bench has to reconcile the parcel and one discrepancy at a time would
   * mean one round trip per missing item. An EXTRA sku reads as picked 0, a
   * MISSING one as scanned 0, so all three matrix rows are the same check.
   *
   * Refusing is the point of the story: a silent accept ships the wrong
   * parcel and the customer discovers it.
   */
  private assertScanMatchesPicked(
    orderId: string,
    picked: ReadonlyMap<string, number>,
    scanned: ReadonlyMap<string, number>,
    skuById: ReadonlyMap<string, { code: string; name: string }>,
  ): void {
    const discrepancies: string[] = [];
    for (const skuId of [...new Set([...picked.keys(), ...scanned.keys()])].sort()) {
      const pickedQty = picked.get(skuId) ?? 0;
      const scannedQty = scanned.get(skuId) ?? 0;
      if (pickedQty === scannedQty) {
        continue;
      }
      const code = skuById.get(skuId)?.code ?? skuId;
      discrepancies.push(`SKU ${code} (${skuId}): picked ${pickedQty}, scanned ${scannedQty}`);
    }
    if (discrepancies.length === 0) {
      return;
    }
    throw new ProblemException(
      'pack-mismatch',
      422,
      'Scanned contents do not match what was picked',
      `Order "${orderId}" was not packed — ${discrepancies.length} discrepancy(ies): ${discrepancies.join('; ')}. Nothing was written.`,
    );
  }

  // ── input validation (400 before any write) ───────────────────────────────

  private assertWeight(value: number | null | undefined): number | null {
    if (value === undefined || value === null) {
      return null; // optional: absence is never an error
    }
    if (!Number.isInteger(value) || value <= 0 || value > MAX_WEIGHT_GRAMS) {
      throw packValidation(
        `weightGrams must be a positive integer of at most ${MAX_WEIGHT_GRAMS} (got ${String(value)}).`,
      );
    }
    return value;
  }

  private assertDimensions(
    value: PackDimensionsInput | null | undefined,
  ): PackDimensionsInput | null {
    if (value === undefined || value === null) {
      return null; // optional: absence is never an error
    }
    // All three arms together or the whole object absent — a box with two
    // sides is not a measurement, and modelling the triple as one object is
    // what makes that structural rather than a rule someone has to remember.
    for (const arm of ['lengthMm', 'widthMm', 'heightMm'] as const) {
      const side = value[arm];
      if (!Number.isInteger(side) || side <= 0 || side > MAX_DIMENSION_MM) {
        throw packValidation(
          `dimensionsMm.${arm} must be a positive integer of at most ${MAX_DIMENSION_MM} (got ${String(side)}).`,
        );
      }
    }
    return { lengthMm: value.lengthMm, widthMm: value.widthMm, heightMm: value.heightMm };
  }

  // ── shared pieces (the 4.1 idempotency shape) ─────────────────────────────

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<PackSnapshot | null> {
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
    return row.responseSnapshot as PackSnapshot;
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

/**
 * The scan aggregated per SKU. The bench scans items, not lines: two scans of
 * the same SKU are two units of it, so duplicate entries SUM rather than
 * colliding. Shape validation rides here so a malformed line is a 400 before
 * the command opens its transaction.
 */
function aggregateScan(scanned: readonly PackScanLineInput[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of scanned) {
    if (!UUID_RE.test(line.skuId)) {
      throw packValidation('Every scanned line names a well-formed skuId.');
    }
    if (!Number.isInteger(line.qty) || line.qty <= 0 || line.qty > MAX_SCAN_QUANTITY) {
      throw packValidation(
        `Scanned quantity must be a positive integer in base UoM, at most ${MAX_SCAN_QUANTITY} (got ${String(line.qty)}).`,
      );
    }
    totals.set(line.skuId, (totals.get(line.skuId) ?? 0) + line.qty);
  }
  return totals;
}

function packValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Pack validation failed', detail);
}

function packConflict(title: string, detail: string): ProblemException {
  return new ProblemException('conflict', 409, title, detail);
}
