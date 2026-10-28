import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  bins,
  idempotencyKeys,
  orderLines,
  orders,
  picklistLines,
  picklists,
  shipments,
  skus,
} from '../../shared/db/schema';
import type { LedgerEvent, Order, Shipment } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
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
import type { LedgerReferenceDoc, ReservationSnapshot } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
// Story 4-2b — the restock names a recalled lot's recall (the 3-7a seam: the
// file, never the recalls module, which depends on this one).
import { openLiveRecallLinesForBatchesInTx } from '../recalls/open-recall-lines';
import { ORDER_OWNER_TYPE, OrderCommandService } from './order.command';
import type { OrderSnapshot, OrderStatus } from './order.command';
import type { ShipmentStatus } from './shipment.command';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * Carriers whose labels exist only in this system (no AWB at a courier), so
 * a cancel may void them locally (decision 8). Today the sandbox is the only
 * label-producing carrier; the DIRECT carriers' label arms are the typed 501.
 */
export const LOCALLY_VOIDABLE_CARRIERS: ReadonlySet<string> = new Set(['sandbox']);

/**
 * The COMMAND discriminator (outbound Gotcha 8): with no `restockBinId` the
 * hashed object would otherwise be exactly `{tenantId, orderId}` —
 * byte-identical to `cancelOrder`'s — and one key reused across the two
 * routes would re-serve the OTHER command's snapshot.
 */
export const CANCEL_RESTOCK_COMMAND_KIND = 'outbound.cancel-restock';

// ── command inputs ───────────────────────────────────────────────────────────

export interface CancelOrderWithRestockCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly orderId: string;
  /**
   * Optional: ONE storage bin of the order's warehouse every drawn unit goes
   * back to. Absent, each draw returns to the bin it was drawn from.
   */
  readonly restockBinId?: string | null | undefined;
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** One put-back line: the units of one (order line, SKU, destination, batch). Base units. */
export interface RestockLineSnapshot {
  readonly orderLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly toBinId: string;
  readonly toBinCode: string;
  readonly batchId: string | null;
  readonly batchCode: string | null;
  readonly qty: number;
  /** How many serial-tracked units (one draw each) — the serial numbers live on the ledger (A10). */
  readonly serialCount: number;
  /** The open LIVE recall the lot is on, when it is (3-7a) — its units stay blocked wherever they land. */
  readonly recallCode: string | null;
}

export interface CancelRestockSnapshot {
  readonly order: OrderSnapshot['order'];
  /**
   * What the cancel put back and undid; `null` only on the already-cancelled
   * no-op (decision 3 — the key stored, nothing done, no audit row).
   */
  readonly restock: {
    readonly restockId: string;
    readonly restockedAt: string;
    /** `origin` — every draw went back to its own bin; `bin` — all into `restockBinId`. */
    readonly destination: 'origin' | 'bin';
    readonly restockBinId: string | null;
    readonly lines: readonly RestockLineSnapshot[];
    /** Σ `lines[].qty` (base units). */
    readonly totalUnits: number;
    /** The order's `planned` / `unfulfillable` pick lines this cancel withdrew. */
    readonly cancelledPickLineCount: number;
    readonly releasedReservationIds: readonly string[];
    readonly retiredReservationIds: readonly string[];
    /** Catch-weight cases the pack had consumed, now `active` again. */
    readonly handlingUnitIds: readonly string[];
    /** The labelled, unmanifested shipment this cancel voided; null when there was none. */
    readonly voidedShipment: {
      readonly id: string;
      readonly carrierName: string;
      readonly trackingNumber: string;
    } | null;
  } | null;
}

/** The plan read's still-to-restock line (decision 12), per (order line, SKU, origin bin, batch). */
export interface RestockPlanLine {
  readonly orderLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly fromBinId: string;
  readonly fromBinCode: string;
  readonly batchId: string | null;
  readonly batchCode: string | null;
  readonly qty: number;
  /** The serials to scan back (the dialog's preview — never stored, A10). */
  readonly serialNumbers: readonly string[];
  readonly recallCode: string | null;
}

/** What a cancel already put back (A9), per (order line, SKU, destination, batch). */
export interface RestockedEntry {
  readonly orderLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly toBinId: string;
  readonly toBinCode: string;
  readonly batchId: string | null;
  readonly batchCode: string | null;
  readonly qty: number;
  readonly serialCount: number;
  readonly restockedAt: string;
  readonly restockId: string;
  readonly recallCode: string | null;
}

export interface RestockPlan {
  readonly orderId: string;
  readonly orderStatus: OrderStatus;
  /** The order's shipment (any status — a voided one shows what was voided); null before a label. */
  readonly shipment: {
    readonly id: string;
    readonly status: ShipmentStatus;
    readonly carrierName: string;
    readonly trackingNumber: string;
    readonly manifestId: string | null;
  } | null;
  /** The draws still to put back — empty unless the order is `accepted` or `ready_to_dispatch`. */
  readonly lines: readonly RestockPlanLine[];
  readonly restocked: readonly RestockedEntry[];
}

type OrderEvent = LedgerEvent;

/** The `pick.picked` draws of an order that no `pick.restocked` reverses yet, in event order. */
export function outstandingDraws(events: readonly OrderEvent[]): OrderEvent[] {
  const reversed = new Set<string>();
  for (const event of events) {
    const doc = event.referenceDoc as LedgerReferenceDoc | null;
    if (event.type === 'pick.restocked' && doc !== null && doc.kind === 'restock') {
      reversed.add(doc.drawEventId);
    }
  }
  return events.filter(
    (event) =>
      event.type === 'pick.picked' &&
      event.quantityDelta < 0 &&
      event.fromBinId !== null &&
      !reversed.has(event.id) &&
      (event.referenceDoc as LedgerReferenceDoc | null)?.kind === 'pick',
  );
}

/** The handling units the order's `pack.packed` events recorded (A3), sorted. */
function packedHandlingUnitIds(events: readonly OrderEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    const doc = event.referenceDoc as LedgerReferenceDoc | null;
    if (event.type === 'pack.packed' && doc !== null && doc.kind === 'pack') {
      for (const id of doc.handlingUnitIds ?? []) ids.add(id);
    }
  }
  return [...ids].sort();
}

function sameIds(left: readonly OrderEvent[], right: readonly OrderEvent[]): boolean {
  const a = left.map((event) => event.id).sort();
  const b = right.map((event) => event.id).sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderLabel(order: Pick<Order, 'id' | 'clientOrderRef' | 'externalEventId'>): string {
  return order.clientOrderRef ?? order.externalEventId ?? order.id.slice(-8);
}

/**
 * Story 4-2b — cancel a picked or packed order and RESTOCK it, in ONE
 * transaction (`orders.manage`, keyed). The packed-but-abandoned leak's exit:
 * every drawn unit goes back to stock through a `pick.restocked` intake that
 * reverses its `pick.picked` draw exactly (magnitude, batch, serial), the
 * order's still-open pick lines are withdrawn, an unmanifested label is
 * voided, the pack's catch-weight cases are live again, every hold the
 * order's lines own is released or retired, and the order reads `cancelled`.
 *
 * `cancelOrder` is untouched (the channel cancellation calls it, and a
 * Shopify cancel must never restock units sitting in a tote at the bench —
 * RD-8). This command also takes an order with no draws, ending exactly where
 * `cancelOrder` would, so the web has one route.
 *
 * The lock chain (decision 10, A1 — the codebase's bin-row → serial →
 * warehouse chain with the order and its documents first): order row →
 * replay again → the non-voided shipment row → the pack's handling units (id
 * order) → each destination bin, locked inside its placement-gate call, in
 * bin-id order → the serial advisory locks (sorted) → the warehouse advisory.
 * EVERY guard and write after that uses only what is read under the
 * warehouse lock (A2); the draws read before it serve only to learn which
 * bins and serials to lock, and a different draw set afterwards is 409
 * `conflict` (a pick committed in between).
 */
@Injectable()
export class CancelRestockCommandService {
  private readonly logger = new Logger('CancelRestockCommand');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(OrderCommandService) private readonly orderCommand: OrderCommandService,
  ) {}

  /** `POST …/outbound/orders/{orderId}/cancel-with-restock`. */
  async cancelOrderWithRestock(
    command: CancelOrderWithRestockCommand,
    idempotencyKey: string,
  ): Promise<CancelRestockSnapshot> {
    // ── shape, above the transaction (a malformed id is 400, never 404) ────
    const raw = command.restockBinId ?? null;
    if (raw !== null && (typeof raw !== 'string' || !UUID_RE.test(raw))) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Invalid restock bin',
        `restockBinId must be a uuid (got ${JSON.stringify(raw)}).`,
      );
    }
    // Lower-cased before the hash (the uuid convention, A11): two spellings
    // of one bin are one intent.
    const restockBinId = raw === null ? null : raw.toLowerCase();
    const payloadHash = hashCommandPayload({
      command: CANCEL_RESTOCK_COMMAND_KIND,
      tenantId: command.tenantId,
      orderId: command.orderId,
      // Present only when given (the conditional-key rule): an origin-bin
      // cancel hashes without it.
      ...(restockBinId === null ? {} : { restockBinId }),
    });

    const committed = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── authority (re-read from the DB), then the replay ────────────────
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'orders.manage');
      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return { snapshot: replay, restores: [] as Restore[] };
      }
      if (!UUID_RE.test(command.orderId)) {
        throw orderNotFound(command.orderId);
      }

      // ── the order, locked; the replay again under the lock ──────────────
      const orderRows = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, command.orderId), eq(orders.tenantId, command.tenantId)))
        .limit(1)
        .for('update');
      const order = orderRows[0];
      if (order === undefined) {
        throw orderNotFound(command.orderId);
      }
      const raced = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (raced !== null) {
        return { snapshot: raced, restores: [] as Restore[] };
      }

      // ── the status allow-list (decision 3) ──────────────────────────────
      const status = order.status as OrderStatus;
      switch (status) {
        case 'accepted':
        case 'ready_to_dispatch':
          break;
        case 'cancelled': {
          // The idempotent no-op: the current order, nothing done, the key
          // stored, no audit row (AUDIT_NO_OP_ARMS).
          const snapshot: CancelRestockSnapshot = { order: (await this.orderCommand.snapshotOf(tx, order)).order, restock: null };
          await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
          return { snapshot, restores: [] as Restore[] };
        }
        case 'dispatched':
          throw new ProblemException(
            'order-dispatched',
            409,
            'Order has shipped',
            `Order ${orderLabel(order)} is dispatched — its parcel has left the building, so it is not cancelled; receive it back as a return (an RMA).`,
          );
        default: {
          const unknown: never = status;
          throw new ProblemException('conflict', 409, 'Order is not cancellable', `Order ${orderLabel(order)} reads "${String(unknown)}".`);
        }
      }

      // ── the shipment row, locked (A1): labelled → void, manifested → 409 ─
      const shipmentRows = await tx
        .select()
        .from(shipments)
        .where(and(eq(shipments.tenantId, command.tenantId), eq(shipments.orderId, order.id), ne(shipments.status, 'voided')))
        .orderBy(asc(shipments.id))
        .for('update');
      const manifested = shipmentRows.find((row) => row.status === 'manifested');
      if (manifested !== undefined) {
        throw shipmentManifested(order, manifested);
      }
      const labelled: Shipment | null = shipmentRows.find((row) => row.status === 'labelled') ?? null;
      // Decision 8's precondition, enforced: a label is voided LOCALLY only
      // while it was produced by a carrier with no AWB at a real courier.
      // A transport story that gives a DIRECT carrier a real label arm must
      // add its AWB cancel here before its labels can be voided.
      if (labelled !== null && !LOCALLY_VOIDABLE_CARRIERS.has(labelled.carrierCode)) {
        throw new ProblemException(
          'shipment-void-unsupported',
          409,
          'Label cannot be voided here',
          `Order ${orderLabel(order)}'s label ${labelled.carrierName} ${labelled.trackingNumber} was booked with the courier, and this build cannot cancel the AWB there — cancel it with ${labelled.carrierName} first. Nothing was written.`,
          { shipmentId: labelled.id, carrierCode: labelled.carrierCode },
        );
      }

      // ── the pre-lock read: which bins, serials and cases to lock ────────
      const preEvents = await this.inventory.ledgerEventsByOrderRefInTx(tx, command.tenantId, order.warehouseId, order.id);
      const preDraws = outstandingDraws(preEvents);
      const expectedUnits = packedHandlingUnitIds(preEvents);
      if (expectedUnits.length > 0) {
        await this.catalog.lockHandlingUnits(tx, command.tenantId, expectedUnits);
      }

      // ── the destination gates, one call per bin in bin-id order ─────────
      // Each call locks its bin row `FOR UPDATE` (the capacity mutex) and runs
      // every placement gate over the SUM of what lands there per SKU.
      const destinationOf = (draw: OrderEvent): string => restockBinId ?? draw.fromBinId!;
      const intakesByBin = new Map<string, Map<string, number>>();
      for (const draw of preDraws) {
        const bin = destinationOf(draw);
        const bySku = intakesByBin.get(bin) ?? new Map<string, number>();
        bySku.set(draw.skuId, assertExactQuantity((bySku.get(draw.skuId) ?? 0) + Math.abs(draw.quantityDelta), 'restock intake'));
        intakesByBin.set(bin, bySku);
      }
      // A named bin is gated even when nothing was drawn: an unknown,
      // foreign or system bin is refused the same way on every order.
      if (restockBinId !== null && !intakesByBin.has(restockBinId)) {
        intakesByBin.set(restockBinId, new Map());
      }
      const binCodes = new Map<string, string>();
      for (const binId of [...intakesByBin.keys()].sort()) {
        const intakes = [...intakesByBin.get(binId)!.entries()].map(([skuId, qtyMilli]) => ({ skuId, qtyMilli }));
        if (intakes.length === 0) {
          // No SKU lands here: the structural arms only (the gate reads the
          // row and refuses unknown / system / retired / blocked).
          const gated = await this.gateEmptyBinInTx(tx, command.tenantId, order.warehouseId, binId);
          binCodes.set(binId, gated.binCode);
          continue;
        }
        const gated = await this.inventory.assertPlacementGatesInTx(tx, {
          tenantId: command.tenantId,
          warehouseId: order.warehouseId,
          binId,
          intakes,
          role,
          subject: 'restock',
        });
        binCodes.set(binId, gated.binCode);
      }

      // ── the serial advisory locks (sorted inside), then the warehouse ───
      const preSerials = preDraws.flatMap((draw) => (draw.serialRef === null ? [] : [draw.serialRef]));
      await this.inventory.lockSerialsInTx(tx, command.tenantId, preSerials);
      await this.inventory.lockWarehouseInTx(tx, command.tenantId, order.warehouseId);

      // ── A2: everything the cancel acts on, re-read under the lock ───────
      const events = await this.inventory.ledgerEventsByOrderRefInTx(tx, command.tenantId, order.warehouseId, order.id);
      const draws = outstandingDraws(events);
      if (!sameIds(preDraws, draws)) {
        throw new ProblemException(
          'conflict',
          409,
          'Order was picked while it was being cancelled',
          `Order ${orderLabel(order)} was picked while it was being cancelled — nothing was written; cancel again.`,
        );
      }

      // ── A4: each serial is still exactly this order's draw ──────────────
      const serialDraws = draws.filter((draw) => draw.serialRef !== null);
      if (serialDraws.length > 0) {
        const latest = await this.inventory.serialLatestEventsInTx(
          tx,
          command.tenantId,
          serialDraws.map((draw) => draw.serialRef!),
        );
        for (const draw of serialDraws) {
          const now = latest.get(draw.serialRef!);
          if (now === undefined || now.eventId !== draw.id) {
            throw await this.serialMoved(tx, command.tenantId, draw, now);
          }
        }
      }

      // ── the reconcile quarantine on each (SKU, destination) ─────────────
      const scopes = new Map<string, Set<string>>();
      for (const draw of draws) {
        const set = scopes.get(draw.skuId) ?? new Set<string>();
        set.add(destinationOf(draw));
        scopes.set(draw.skuId, set);
      }
      for (const [skuId, binIds] of [...scopes.entries()].sort(([a], [b]) => byText(a, b))) {
        const quarantined = await this.inventory.openQuarantinedBinsInTx(tx, command.tenantId, order.warehouseId, skuId, [...binIds]);
        if (quarantined.length > 0) {
          const skuCode = (await this.skuFactsInTx(tx, command.tenantId, [skuId])).get(skuId)?.code ?? skuId;
          throw new ProblemException(
            'restock-scope-quarantined',
            409,
            'Restock destination is quarantined',
            `SKU ${skuCode} in bin ${quarantined.map((id) => binCodes.get(id) ?? id).join(', ')} is under an open reconcile quarantine — restocking into it is refused; choose another bin ("All into one bin"), or resolve the quarantine first. Nothing was written.`,
            { binIds: [...quarantined] },
          );
        }
      }

      // ── the order's lines, its open pick lines, its holds ───────────────
      const lines = await tx
        .select()
        .from(orderLines)
        .where(and(eq(orderLines.tenantId, command.tenantId), eq(orderLines.orderId, order.id)))
        .orderBy(asc(orderLines.createdAt), asc(orderLines.id));
      const lineIds = lines.map((line) => line.id);

      // A6 — the order's planned and unfulfillable pick lines are withdrawn;
      // drawn lines stay as history.
      const withdrawn = await tx
        .update(picklistLines)
        .set({ status: 'cancelled', updatedAt: nowIso() })
        .where(
          and(
            eq(picklistLines.tenantId, command.tenantId),
            eq(picklistLines.orderId, order.id),
            inArray(picklistLines.status, ['planned', 'unfulfillable']),
          ),
        )
        .returning({ id: picklistLines.id, picklistId: picklistLines.picklistId });
      const touchedPicklists = [...new Set(withdrawn.map((row) => row.picklistId))].sort();
      if (touchedPicklists.length > 0) {
        // A picklist of this order left with no non-cancelled bin-bearing
        // line is withdrawn too (`releaseWave`'s rule); a batch picklist
        // carrying another order's lines keeps them and stays `ready`. The
        // wave's status is not touched.
        await tx
          .update(picklists)
          .set({ status: 'cancelled', updatedAt: nowIso() })
          .where(
            and(
              eq(picklists.tenantId, command.tenantId),
              inArray(picklists.id, touchedPicklists),
              inArray(picklists.status, ['planned', 'ready']),
              sql`not exists (
                select 1 from ${picklistLines} pl
                where pl.tenant_id = ${picklists.tenantId}
                  and pl.picklist_id = ${picklists.id}
                  and pl.status <> 'cancelled'
                  and pl.bin_id is not null
              )`,
            ),
          );
      }

      // Decision 6 / A5 — every hold the order's lines own, owner-keyed: a
      // `held` one released, a `committed` one retired. A hold the reaper
      // ended between the read and the write is skipped, not fatal.
      const restores: Restore[] = [];
      const releasedReservationIds: string[] = [];
      const retiredReservationIds: string[] = [];
      const held = await this.inventory.heldReservationsByOwnerInTx(tx, command.tenantId, order.warehouseId, ORDER_OWNER_TYPE, lineIds);
      for (const hold of held) {
        if (await this.endHoldInTx(tx, command.tenantId, hold, 'held')) {
          releasedReservationIds.push(hold.id);
          restores.push({ warehouseId: order.warehouseId, skuId: hold.skuId, units: hold.quantity });
        }
      }
      const committedHolds = await this.inventory.committedReservationsByOwnerInTx(tx, command.tenantId, order.warehouseId, ORDER_OWNER_TYPE, lineIds);
      for (const hold of committedHolds) {
        if (await this.endHoldInTx(tx, command.tenantId, hold, 'committed')) {
          retiredReservationIds.push(hold.id);
          restores.push({ warehouseId: order.warehouseId, skuId: hold.skuId, units: hold.quantity });
        }
      }

      // ── the restock: one `pick.restocked` per draw ──────────────────────
      const restockId = uuidv7();
      const restockedAt = nowIso();
      for (const draw of draws) {
        const pickDoc = draw.referenceDoc as Extract<LedgerReferenceDoc, { kind: 'pick' }>;
        const referenceDoc: LedgerReferenceDoc = {
          kind: 'restock',
          restockId,
          orderId: order.id,
          orderLineId: pickDoc.orderLineId,
          picklistLineId: pickDoc.picklistLineId,
          drawEventId: draw.id,
        };
        await this.inventory.appendLedgerEventInTx(tx, {
          tenantId: command.tenantId,
          warehouseId: order.warehouseId,
          type: 'pick.restocked',
          skuId: draw.skuId,
          quantityDelta: signedQuantity(Math.abs(draw.quantityDelta)),
          fromBinId: null,
          toBinId: destinationOf(draw),
          batchRef: draw.batchRef,
          serialRef: draw.serialRef,
          actorUserId: command.actorUserId,
          occurredAt: restockedAt,
          recordedAt: restockedAt,
          referenceDoc,
        });
      }

      // ── A3: the pack's catch-weight cases, `packed → active` ────────────
      const expected = packedHandlingUnitIds(events);
      let handlingUnitIds: string[] = [];
      if (expected.length > 0) {
        const unpacked = await this.catalog.unpackHandlingUnitsForLinesInTx(tx, command.tenantId, lineIds, expected);
        const flipped = new Set(unpacked.map((unit) => unit.id));
        const missing = expected.filter((id) => !flipped.has(id));
        if (missing.length > 0) {
          const now = await this.catalog.lockHandlingUnits(tx, command.tenantId, missing);
          const statusOf = new Map(now.map((unit) => [unit.id, unit.status]));
          throw new ProblemException(
            'handling-unit-not-packed',
            409,
            'A packed case is no longer packed into this order',
            `The order's pack recorded ${missing.length} case(s) that are no longer packed into it: ${missing
              .map((id) => `${id} (${statusOf.get(id) ?? 'missing'})`)
              .join(', ')} — nothing was written.`,
            { handlingUnitIds: missing },
          );
        }
        handlingUnitIds = [...flipped].sort();
      }

      // ── decision 8: the label, voided (conditional on `labelled`) ───────
      let voidedShipment: { id: string; carrierName: string; trackingNumber: string } | null = null;
      let voidedRow: Shipment | null = null;
      if (labelled !== null) {
        const voided = await tx
          .update(shipments)
          .set({ status: 'voided', voidedAt: restockedAt, voidedBy: command.actorUserId, updatedAt: restockedAt })
          .where(and(eq(shipments.id, labelled.id), eq(shipments.tenantId, command.tenantId), eq(shipments.status, 'labelled')))
          .returning();
        if (voided[0] === undefined) {
          // Unreachable beneath the row lock; the backstop rolls back.
          throw shipmentManifested(order, labelled);
        }
        voidedRow = voided[0];
        voidedShipment = { id: labelled.id, carrierName: labelled.carrierName, trackingNumber: labelled.trackingNumber };
      }

      // ── the lines stop claiming stock; the order flips ──────────────────
      await tx
        .update(orderLines)
        .set({ reservedQty: 0, reservationId: null, updatedAt: restockedAt })
        .where(and(eq(orderLines.tenantId, command.tenantId), eq(orderLines.orderId, order.id)));
      const flipped = await tx
        .update(orders)
        .set({ status: 'cancelled', updatedAt: restockedAt })
        .where(and(eq(orders.id, order.id), eq(orders.tenantId, command.tenantId), inArray(orders.status, ['accepted', 'ready_to_dispatch'])))
        .returning();
      if (flipped[0] === undefined) {
        // Unreachable beneath the order lock; the backstop rolls back.
        throw new ProblemException('conflict', 409, 'Order moved while it was being cancelled', `Order ${orderLabel(order)} moved while it was being cancelled — nothing was written; cancel again.`);
      }

      // ── the put-back lines (base units, codes resolved) ─────────────────
      const restockLines = await this.restockLinesOf(tx, command.tenantId, draws, destinationOf, binCodes);
      const totalMilli = draws.reduce((sum, draw) => assertExactQuantity(sum + Math.abs(draw.quantityDelta), 'restock total units'), 0);
      const orderSnapshot = await this.orderCommand.snapshotOf(tx, flipped[0]);
      const snapshot: CancelRestockSnapshot = {
        order: orderSnapshot.order,
        restock: {
          restockId,
          restockedAt: canonicalInstant(restockedAt),
          destination: restockBinId === null ? 'origin' : 'bin',
          restockBinId,
          lines: restockLines,
          totalUnits: fromMilli(totalMilli),
          cancelledPickLineCount: withdrawn.length,
          releasedReservationIds,
          retiredReservationIds,
          handlingUnitIds,
          voidedShipment,
        },
      };

      // ── outbox (AD-7), audit, key last ──────────────────────────────────
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'order.cancelled',
        occurredAt: restockedAt,
        payload: { order: snapshot.order, restock: snapshot.restock },
      });
      if (voidedRow !== null) {
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'shipment.voided',
          occurredAt: restockedAt,
          payload: {
            shipment: {
              id: voidedRow.id,
              orderId: voidedRow.orderId,
              warehouseId: voidedRow.warehouseId,
              status: 'voided',
              carrierConnectionId: voidedRow.carrierConnectionId,
              carrierCode: voidedRow.carrierCode,
              carrierName: voidedRow.carrierName,
              trackingNumber: voidedRow.trackingNumber,
              voidedAt: canonicalInstant(restockedAt),
              voidedBy: command.actorUserId,
            },
          },
        });
      }
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'order.cancelled',
        targetType: 'order',
        targetId: order.id,
        reference: idempotencyKey,
        // One instant for the whole cancel: the ledger, outbox, void and audit agree.
        occurredAt: restockedAt,
      });
      if (voidedRow !== null) {
        // A12 — the label precedent: the shipment's audit rows target the order.
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'shipment.voided',
          targetType: 'order',
          targetId: order.id,
          reference: idempotencyKey,
          occurredAt: restockedAt,
        });
      }
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return { snapshot, restores };
    });

    // ── the counter mirror, after the commit — NOTHING HERE MAY THROW ─────
    for (const restore of committed.restores) {
      try {
        await this.inventory.restoreReservedUnits(command.tenantId, restore.warehouseId, restore.skuId, restore.units);
      } catch (err) {
        this.logger.error(
          `Cancel-with-restock counter restore failed — reserved over-counts for this scope until the next rebuild ` +
            `(order ${command.orderId}, sku ${restore.skuId}, ${restore.units} milli-unit(s)): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return committed.snapshot;
  }

  /**
   * `GET …/outbound/orders/{orderId}/restock-plan` (decision 12, A9) — a READ:
   * no capability, no key, nothing stored. Null for an unknown or foreign
   * order (the shell 404s).
   */
  async getRestockPlan(tenantId: string, orderId: string): Promise<RestockPlan | null> {
    if (!UUID_RE.test(orderId)) return null;
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const orderRows = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
        .limit(1);
      const order = orderRows[0];
      if (order === undefined) return null;
      const shipmentRows = await tx
        .select()
        .from(shipments)
        .where(and(eq(shipments.tenantId, tenantId), eq(shipments.orderId, order.id)))
        .orderBy(desc(shipments.labelledAt), desc(shipments.id))
        .limit(1);
      const shipment = shipmentRows[0] ?? null;
      const events = await this.inventory.ledgerEventsByOrderRefInTx(tx, tenantId, order.warehouseId, order.id);
      const cancellable = order.status === 'accepted' || order.status === 'ready_to_dispatch';
      const draws = cancellable ? outstandingDraws(events) : [];
      const restocks = events.filter(
        (event) => event.type === 'pick.restocked' && (event.referenceDoc as LedgerReferenceDoc | null)?.kind === 'restock' && event.toBinId !== null,
      );

      const skuIds = [...new Set([...draws, ...restocks].map((event) => event.skuId))];
      const batchIds = [...new Set([...draws, ...restocks].flatMap((event) => (event.batchRef === null ? [] : [event.batchRef])))];
      const binIds = [...new Set([...draws.map((event) => event.fromBinId!), ...restocks.map((event) => event.toBinId!)])];
      const [skuFacts, batchFacts, binCodes, recalls] = [
        await this.skuFactsInTx(tx, tenantId, skuIds),
        await this.catalog.batchFactsByIdsInTx(tx, tenantId, batchIds),
        await this.binCodesInTx(tx, tenantId, binIds),
        await this.recallCodesInTx(tx, tenantId, batchIds),
      ];
      // The serials to scan back, per SKU (the facade reads by SKU).
      const serialNumber = new Map<string, string>();
      const serialsBySku = new Map<string, string[]>();
      for (const draw of draws) {
        if (draw.serialRef === null) continue;
        const list = serialsBySku.get(draw.skuId) ?? [];
        list.push(draw.serialRef);
        serialsBySku.set(draw.skuId, list);
      }
      for (const [skuId, ids] of serialsBySku) {
        for (const serial of await this.catalog.serialIdentitiesInTx(tx, tenantId, skuId, { ids })) {
          serialNumber.set(serial.id, serial.serialNumber);
        }
      }

      const plan = new Map<string, { line: Omit<RestockPlanLine, 'qty' | 'serialNumbers'>; milli: number; serials: string[] }>();
      for (const draw of draws) {
        const doc = draw.referenceDoc as Extract<LedgerReferenceDoc, { kind: 'pick' }>;
        const key = `${doc.orderLineId}|${draw.skuId}|${draw.fromBinId}|${draw.batchRef ?? ''}`;
        const sku = skuFacts.get(draw.skuId);
        const entry = plan.get(key) ?? {
          line: {
            orderLineId: doc.orderLineId,
            skuId: draw.skuId,
            skuCode: sku?.code ?? draw.skuId,
            skuName: sku?.name ?? draw.skuId,
            uom: sku?.uom ?? '',
            fromBinId: draw.fromBinId!,
            fromBinCode: binCodes.get(draw.fromBinId!) ?? draw.fromBinId!,
            batchId: draw.batchRef,
            batchCode: draw.batchRef === null ? null : (batchFacts.get(draw.batchRef)?.code ?? draw.batchRef),
            recallCode: draw.batchRef === null ? null : (recalls.get(draw.batchRef) ?? null),
          },
          milli: 0,
          serials: [],
        };
        entry.milli += Math.abs(draw.quantityDelta);
        if (draw.serialRef !== null) entry.serials.push(serialNumber.get(draw.serialRef) ?? draw.serialRef);
        plan.set(key, entry);
      }
      const restocked = new Map<string, { entry: Omit<RestockedEntry, 'qty' | 'serialCount'>; milli: number; serials: number }>();
      for (const event of restocks) {
        const doc = event.referenceDoc as Extract<LedgerReferenceDoc, { kind: 'restock' }>;
        const key = `${doc.restockId}|${doc.orderLineId}|${event.skuId}|${event.toBinId}|${event.batchRef ?? ''}`;
        const sku = skuFacts.get(event.skuId);
        const entry = restocked.get(key) ?? {
          entry: {
            orderLineId: doc.orderLineId,
            skuId: event.skuId,
            skuCode: sku?.code ?? event.skuId,
            skuName: sku?.name ?? event.skuId,
            uom: sku?.uom ?? '',
            toBinId: event.toBinId!,
            toBinCode: binCodes.get(event.toBinId!) ?? event.toBinId!,
            batchId: event.batchRef,
            batchCode: event.batchRef === null ? null : (batchFacts.get(event.batchRef)?.code ?? event.batchRef),
            restockedAt: canonicalInstant(event.recordedAt),
            restockId: doc.restockId,
            recallCode: event.batchRef === null ? null : (recalls.get(event.batchRef) ?? null),
          },
          milli: 0,
          serials: 0,
        };
        entry.milli += Math.abs(event.quantityDelta);
        if (event.serialRef !== null) entry.serials += 1;
        restocked.set(key, entry);
      }
      const lineOrder = (left: { skuCode: string; batchCode: string | null; orderLineId: string }, right: typeof left): number =>
        byText(left.skuCode, right.skuCode) || byText(left.batchCode ?? '', right.batchCode ?? '') || byText(left.orderLineId, right.orderLineId);
      return {
        orderId: order.id,
        orderStatus: order.status as OrderStatus,
        shipment:
          shipment === null
            ? null
            : {
                id: shipment.id,
                status: shipment.status as ShipmentStatus,
                carrierName: shipment.carrierName,
                trackingNumber: shipment.trackingNumber,
                manifestId: shipment.manifestId,
              },
        lines: [...plan.values()]
          .map((item) => ({ ...item.line, qty: fromMilli(item.milli), serialNumbers: [...item.serials].sort() }))
          .sort((left, right) => lineOrder(left, right) || byText(left.fromBinCode, right.fromBinCode)),
        restocked: [...restocked.values()]
          .map((item) => ({ ...item.entry, qty: fromMilli(item.milli), serialCount: item.serials }))
          .sort((left, right) => byText(left.restockedAt, right.restockedAt) || lineOrder(left, right) || byText(left.toBinCode, right.toBinCode)),
      };
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * A5 — end one hold inside the transaction. A 0-row conditional update is
   * not a statement error (the transaction stays usable); the facade's 409
   * after it is caught, and a hold the reaper or a racing writer already
   * ended (`released` / `expired`) is skipped. Anything else rethrows.
   */
  private async endHoldInTx(tx: TenantTx, tenantId: string, hold: ReservationSnapshot, from: 'held' | 'committed'): Promise<boolean> {
    try {
      if (from === 'held') {
        await this.inventory.releaseReservationInTx(tx, tenantId, hold.id);
      } else {
        await this.inventory.retireCommittedReservationInTx(tx, tenantId, hold.id);
      }
      return true;
    } catch (err) {
      if (err instanceof ProblemException && err.getStatus() === 409) {
        const now = (await this.inventory.reservationsByIdsInTx(tx, tenantId, [hold.id]))[0]?.state;
        if (now === 'released' || now === 'expired') {
          return false;
        }
      }
      throw err;
    }
  }

  /** The structural arms for a named bin nothing lands in (the gate's own codes and wording). */
  private async gateEmptyBinInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    binId: string,
  ): Promise<{ binCode: string }> {
    const rows = await tx
      .select({ id: bins.id, code: bins.code, systemOwned: bins.systemOwned, retiredAt: bins.retiredAt, blocked: bins.blocked })
      .from(bins)
      .where(and(eq(bins.id, binId), eq(bins.tenantId, tenantId), eq(bins.warehouseId, warehouseId)))
      .limit(1)
      .for('update');
    const bin = rows[0];
    if (bin === undefined) {
      throw new ProblemException('not-found', 404, 'Bin not found', `No bin with id "${binId}" exists in this warehouse.`);
    }
    if (bin.systemOwned) {
      throw new ProblemException('validation-failed', 400, 'Bin is a system bin', `Bin "${bin.code}" is a system bin (Receiving/QC-hold/In-Transit/Returns/Damaged) — restock intake lands in storage bins only.`);
    }
    if (bin.retiredAt !== null) {
      throw new ProblemException('bin-retired', 409, 'Target bin is retired', `Bin "${bin.code}" is retired — restock intake into it is refused; retirement is terminal.`);
    }
    if (bin.blocked) {
      throw new ProblemException('bin-blocked', 409, 'Target bin is blocked', `Bin "${bin.code}" is blocked — restock intake into it is refused until it is unblocked.`);
    }
    return { binCode: bin.code };
  }

  /** A4's refusal: the serial left this order's draw while it sat in the tote. */
  private async serialMoved(
    tx: TenantTx,
    tenantId: string,
    draw: OrderEvent,
    now: { eventId: string; toBinId: string | null } | undefined,
  ): Promise<ProblemException> {
    const serial = (await this.catalog.serialIdentitiesInTx(tx, tenantId, draw.skuId, { ids: [draw.serialRef!] }))[0];
    const label = serial?.serialNumber ?? draw.serialRef!;
    const where =
      now?.toBinId !== null && now?.toBinId !== undefined
        ? `is now in bin ${(await this.binCodesInTx(tx, tenantId, [now.toBinId])).get(now.toBinId) ?? now.toBinId}`
        : 'was drawn by another event';
    return new ProblemException(
      'restock-serial-moved',
      409,
      'A serial is no longer this order’s draw',
      `Serial ${label} ${where} since this order picked it — it was counted, adjusted or moved while it sat in the tote, so it is not restocked from this order. Nothing was written; settle the serial first.`,
      { serialNumber: label },
    );
  }

  /** The put-back lines of the snapshot, per (order line, SKU, destination, batch). */
  private async restockLinesOf(
    tx: TenantTx,
    tenantId: string,
    draws: readonly OrderEvent[],
    destinationOf: (draw: OrderEvent) => string,
    binCodes: ReadonlyMap<string, string>,
  ): Promise<RestockLineSnapshot[]> {
    if (draws.length === 0) return [];
    const skuFacts = await this.skuFactsInTx(tx, tenantId, draws.map((draw) => draw.skuId));
    const batchIds = [...new Set(draws.flatMap((draw) => (draw.batchRef === null ? [] : [draw.batchRef])))];
    const batchFacts = await this.catalog.batchFactsByIdsInTx(tx, tenantId, batchIds);
    const recalls = await this.recallCodesInTx(tx, tenantId, batchIds);
    const grouped = new Map<string, { line: Omit<RestockLineSnapshot, 'qty' | 'serialCount'>; milli: number; serials: number }>();
    for (const draw of draws) {
      const doc = draw.referenceDoc as Extract<LedgerReferenceDoc, { kind: 'pick' }>;
      const toBinId = destinationOf(draw);
      const key = `${doc.orderLineId}|${draw.skuId}|${toBinId}|${draw.batchRef ?? ''}`;
      const sku = skuFacts.get(draw.skuId);
      const entry = grouped.get(key) ?? {
        line: {
          orderLineId: doc.orderLineId,
          skuId: draw.skuId,
          skuCode: sku?.code ?? draw.skuId,
          skuName: sku?.name ?? draw.skuId,
          uom: sku?.uom ?? '',
          toBinId,
          toBinCode: binCodes.get(toBinId) ?? toBinId,
          batchId: draw.batchRef,
          batchCode: draw.batchRef === null ? null : (batchFacts.get(draw.batchRef)?.code ?? draw.batchRef),
          recallCode: draw.batchRef === null ? null : (recalls.get(draw.batchRef) ?? null),
        },
        milli: 0,
        serials: 0,
      };
      entry.milli = assertExactQuantity(entry.milli + Math.abs(draw.quantityDelta), 'restock line');
      if (draw.serialRef !== null) entry.serials += 1;
      grouped.set(key, entry);
    }
    return [...grouped.values()]
      .map((item) => ({ ...item.line, qty: fromMilli(item.milli), serialCount: item.serials }))
      .sort(
        (left, right) =>
          byText(left.skuCode, right.skuCode) ||
          byText(left.batchCode ?? '', right.batchCode ?? '') ||
          byText(left.toBinCode, right.toBinCode) ||
          byText(left.orderLineId, right.orderLineId),
      );
  }

  private async skuFactsInTx(tx: TenantTx, tenantId: string, skuIds: readonly string[]): Promise<Map<string, { code: string; name: string; uom: string }>> {
    const ids = [...new Set(skuIds)];
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: skus.id, code: skus.code, name: skus.name, uom: skus.uom })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, ids)));
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async binCodesInTx(tx: TenantTx, tenantId: string, binIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(binIds)];
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: bins.id, code: bins.code })
      .from(bins)
      .where(and(eq(bins.tenantId, tenantId), inArray(bins.id, ids)));
    return new Map(rows.map((row) => [row.id, row.code]));
  }

  /** batchId → the open LIVE recall's code (3-7a; a mock recall never answers). */
  private async recallCodesInTx(tx: TenantTx, tenantId: string, batchIds: readonly string[]): Promise<Map<string, string>> {
    const lines = await openLiveRecallLinesForBatchesInTx(tx, tenantId, batchIds);
    return new Map(lines.map((line) => [line.batchId, line.recallCode]));
  }

  private async replay(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<CancelRestockSnapshot | null> {
    const rows = await tx
      .select({ payloadHash: idempotencyKeys.payloadHash, responseSnapshot: idempotencyKeys.responseSnapshot })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot as CancelRestockSnapshot;
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: CancelRestockSnapshot,
  ): Promise<void> {
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

interface Restore {
  readonly warehouseId: string;
  readonly skuId: string;
  /** Milli-units. */
  readonly units: number;
}

function orderNotFound(orderId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Order not found', `No order with id "${orderId}" exists in this tenant.`);
}

function shipmentManifested(order: Pick<Order, 'id' | 'clientOrderRef' | 'externalEventId'>, shipment: Shipment): ProblemException {
  return new ProblemException(
    'shipment-manifested',
    409,
    'Shipment is manifested',
    `Order ${orderLabel(order)}'s shipment ${shipment.carrierName} ${shipment.trackingNumber} is on manifest ${shipment.manifestId ?? '(unknown)'} — it was handed to the courier, so the order is not cancelled here; receive the parcel back as a return.`,
    { manifestId: shipment.manifestId, shipmentId: shipment.id },
  );
}
