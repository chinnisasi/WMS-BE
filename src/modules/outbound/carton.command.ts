import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, orders, shipments, skus } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
import { nowIso } from '../../shared/primitives/time';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { InventoryFacade } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import {
  MAX_PACK_SEQ,
  aggregateCartons,
  assertCartonMeasurements,
  assertCartonQuantities,
  cartonValidation,
  cartonsHashForm,
  compareCartonContents,
  sameSplit,
  type AggregatedCarton,
  type CartonSkuFacts,
} from './cartons';
import {
  orderNotPacked,
  packHistoryOfOrderInTx,
  packRecordOfOrderInTx,
  packTotalsOf,
  packViewInTx,
  type PackHistoryRecord,
  type PackRecord,
  type PackView,
} from './cartons.read';
import {
  cartonWriteOf,
  documentPartiesInTx,
  endLivePackInTx,
  insertPackInTx,
  lockLivePackInTx,
  maxPackSeqInTx,
} from './order-packs';
import { orderNotFound, replayInTx, writeKeyInTx } from './shipping-support';

/** A re-carton's reason, 1–200 characters (`order_packs_end_reason`). */
export const MAX_RECARTON_REASON_LENGTH = 200;

export interface RecartonOrderCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly orderId: string;
  /** The new split (`PackCartonDto[]` on the web) — judged by `aggregateCartons`. */
  readonly cartons: unknown;
  readonly reason: string;
}

/** The re-carton's answer (also its idempotency snapshot). */
export interface RecartonSnapshot {
  readonly pack: PackView;
  /** True when the split was unchanged — nothing written, the key stored (`order.recarton:unchanged`). */
  readonly unchanged: boolean;
  /** A40 — a live client label's verification was cleared: re-verify it on the new boxes. */
  readonly clientLabelReverify: boolean;
}

/**
 * Story 4-5a (A8, A47, A48) — re-carton a packed order on the web: the same
 * goods, a new split. The live pack is superseded and pack seq + 1 written
 * with the OLD pack's frozen parties and physical pack facts (a re-split is
 * not a new shipment); its labels stop scanning (`carton-not-current`).
 *
 * Guard and lock order: `pack.execute` → replay → the order `FOR UPDATE` →
 * replay again → status `ready_to_dispatch` → the live pack `FOR UPDATE` (a
 * legacy order's virtual pack otherwise) → the live shipment `FOR UPDATE` (a
 * carrier label refuses) → contents → the unchanged no-op → the limit. A
 * handover takes the order before the packs before the shipments, so the two
 * serialise on the order lock and acquire in the same order (A21).
 */
@Injectable()
export class CartonCommandService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  /** The cases' weights for the pack view (the catalog seam). */
  private readonly caseFacts = (tx: TenantTx, tenantId: string, ids: readonly string[]) => this.catalog.handlingUnitsByIdsInTx(tx, tenantId, ids);

  async recartonOrder(command: RecartonOrderCommand, idempotencyKey: string): Promise<RecartonSnapshot> {
    // ── shape, above the transaction (400) ─────────────────────────────────
    const reason = typeof command.reason === 'string' ? command.reason.trim() : '';
    if (reason.length < 1 || reason.length > MAX_RECARTON_REASON_LENGTH) {
      throw cartonValidation(`A re-carton names its reason, 1 to ${MAX_RECARTON_REASON_LENGTH} characters.`);
    }
    const cartons = aggregateCartons(command.cartons);
    const payloadHash = hashCommandPayload({
      command: 'outbound.order.recarton',
      tenantId: command.tenantId,
      orderId: command.orderId,
      cartons: cartonsHashForm(cartons),
      reason,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // 1. authority
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'pack.execute');
      // 2. replay
      const replayed = (await replayInTx(tx, command.tenantId, idempotencyKey, payloadHash)) as RecartonSnapshot | null;
      if (replayed !== null) return replayed;
      // 3. the order, locked
      if (!UUID_RE.test(command.orderId)) throw orderNotFound(command.orderId);
      const orderRows = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, command.orderId), eq(orders.tenantId, command.tenantId)))
        .limit(1)
        .for('update');
      const order = orderRows[0];
      if (order === undefined) throw orderNotFound(command.orderId);
      // 4. replay again under the lock (the same-key race)
      const raced = (await replayInTx(tx, command.tenantId, idempotencyKey, payloadHash)) as RecartonSnapshot | null;
      if (raced !== null) return raced;
      const label = orderLabelOf(order);
      // 5. status
      if (order.status !== 'ready_to_dispatch') {
        throw orderNotPacked(
          label,
          order.status,
          `Order ${label} reads "${order.status.replace(/_/g, ' ')}" — only a packed order that has not left is re-packed into cartons.`,
        );
      }
      // 6. the live pack, locked — none is a legacy order's virtual pack
      const livePack = await lockLivePackInTx(tx, command.tenantId, order.id);
      const record = await packRecordOfOrderInTx(tx, command.tenantId, order, (t, tenant, warehouse, orderId) =>
        this.inventory.ledgerEventsByOrderRefInTx(t, tenant, warehouse, orderId),
      );
      if (record === null || record.status !== 'live') {
        throw orderNotPacked(label, order.status, `Order ${label} has no live pack to re-split.`);
      }
      // 7. the live shipment, locked: a carrier's label counts its pieces
      const liveShipments = await tx
        .select()
        .from(shipments)
        .where(and(eq(shipments.tenantId, command.tenantId), eq(shipments.orderId, order.id), sql`${shipments.status} <> 'voided'`))
        .orderBy(asc(shipments.id))
        .for('update');
      const carrier = liveShipments.find((row) => row.kind === 'carrier');
      if (carrier !== undefined) {
        throw new ProblemException(
          'shipment-labelled-by-carrier',
          409,
          'A carrier label covers this order',
          `Order ${label} holds the carrier label ${carrier.carrierName} ${carrier.trackingNumber} — the carrier's label counts its pieces; cancel and re-pack to change them.`,
          { shipmentId: carrier.id },
        );
      }
      // 8. contents: the same goods, each carton a quantity its SKU can hold
      const skuFacts = await this.skuFactsInTx(tx, command.tenantId, [
        ...new Set([...cartons.flatMap((carton) => [...carton.totals.keys()]), ...packTotalsOf(record).totals.keys()]),
      ]);
      for (const carton of cartons) {
        for (const skuId of carton.totals.keys()) {
          if (!skuFacts.has(skuId)) {
            throw new ProblemException('not-found', 404, 'SKU not found', `No SKU with id "${skuId}" exists in this tenant.`);
          }
        }
      }
      assertCartonMeasurements(cartons, { device: false });
      assertCartonQuantities(cartons, skuFacts);
      const mismatches = compareCartonContents(packTotalsOf(record), cartons);
      if (mismatches.length > 0) {
        throw new ProblemException(
          'carton-contents-mismatch',
          422,
          'The new cartons do not hold what was packed',
          `Order ${label}: a re-carton changes the split, never the goods — ${mismatches
            .map((entry) => `${skuFacts.get(entry.skuId)?.code ?? entry.skuId} packed ${fromMilli(entry.packed)}, cartoned ${fromMilli(entry.cartoned)}`)
            .join('; ')}. Nothing was written.`,
          {
            skus: mismatches.map((entry) => ({
              skuCode: skuFacts.get(entry.skuId)?.code ?? entry.skuId,
              packed: fromMilli(entry.packed),
              cartoned: fromMilli(entry.cartoned),
            })),
          },
        );
      }
      // 9. the unchanged split: a no-op that stores the key
      if (sameSplit(aggregatedOf(record), cartons)) {
        const snapshot: RecartonSnapshot = {
          pack: await packViewInTx(tx, command.tenantId, record, this.caseFacts),
          unchanged: true,
          clientLabelReverify: false,
        };
        await writeKeyInTx(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }
      // A48 — the 99th pack is the last.
      const previousSeq = livePack === null ? Math.max(record.seq, await maxPackSeqInTx(tx, command.tenantId, order.id)) : livePack.seq;
      if (previousSeq >= MAX_PACK_SEQ) {
        throw new ProblemException(
          'recarton-limit',
          409,
          'This order has been re-packed too often',
          `Order ${label} is on pack ${previousSeq}, the last a pack can be — cancel and re-pack the order instead.`,
        );
      }

      // ── writes (one clock, A47) ──────────────────────────────────────────
      const now = nowIso();
      if (livePack !== null) {
        const ended = await endLivePackInTx(tx, {
          tenantId: command.tenantId,
          packId: livePack.id,
          status: 'superseded',
          endedAt: now,
          endedBy: command.actorUserId,
          endReason: reason,
        });
        if (!ended) {
          // Unreachable beneath the row lock; the backstop rolls back.
          throw orderNotPacked(label, order.status, `Order ${label}'s pack moved while it was being re-split — nothing was written; try again.`);
        }
      }
      // A9 — a legacy order's first re-carton freezes its parties NOW.
      const parties =
        record.parties ?? (await documentPartiesInTx(tx, command.tenantId, order.clientId, order.warehouseId));
      const partiesFrozenAt = record.partiesFrozenAt ?? now;
      const written = await insertPackInTx(tx, {
        tenantId: command.tenantId,
        warehouseId: order.warehouseId,
        clientId: order.clientId,
        orderId: order.id,
        seq: previousSeq + 1,
        source: 'recarton',
        deviceId: null,
        // A47 — "Packed" stays the physical pack.
        packedBy: record.packedBy,
        packedAt: record.packedAt,
        parties,
        partiesFrozenAt,
        now,
        cartons: cartons.map(cartonWriteOf),
      });
      // A40 — a live client-arranged labelled shipment counts the new cartons,
      // and its verification is cleared: the label sits on a box of the old split.
      let clientLabelReverify = false;
      for (const shipment of liveShipments) {
        if (shipment.kind === 'carrier' || shipment.status !== 'labelled') continue;
        clientLabelReverify ||= shipment.labelVerifiedAt !== null;
        await tx
          .update(shipments)
          .set({
            packageCount: written.cartons.length,
            labelVerifiedAt: null,
            labelVerifiedBy: null,
            labelVerifiedDeviceId: null,
            labelVerifyMethod: null,
            updatedAt: now,
          })
          .where(and(eq(shipments.id, shipment.id), eq(shipments.tenantId, command.tenantId)));
      }

      const next = await packRecordOfOrderInTx(tx, command.tenantId, order, (t, tenant, warehouse, orderId) =>
        this.inventory.ledgerEventsByOrderRefInTx(t, tenant, warehouse, orderId),
      );
      const snapshot: RecartonSnapshot = {
        pack: await packViewInTx(tx, command.tenantId, next!, this.caseFacts),
        unchanged: false,
        clientLabelReverify,
      };
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'order.recartoned',
        occurredAt: now,
        payload: {
          orderId: order.id,
          packId: written.id,
          packSeq: written.seq,
          previousPackSeq: record.seq,
          cartons: written.cartons.map((carton) => ({
            seq: carton.seq,
            code: carton.code,
            weightGrams: carton.weightGrams,
            unitCount: fromMilli(carton.unitCount),
          })),
        },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'order.recartoned',
        targetType: 'order',
        targetId: order.id,
        reference: idempotencyKey,
        occurredAt: now,
        changes: { packSeq: written.seq, previousPackSeq: record.seq, cartonCount: written.cartons.length, reason },
      });
      await writeKeyInTx(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * The order's pack record in the caller's transaction (A9, A48) — the live
   * pack, else the latest stored, else the virtual pack, else null. Chunk-wide
   * seam: the documents, the handover and the reads all build on it.
   */
  async packRecordInTx(
    tx: TenantTx,
    tenantId: string,
    order: { readonly id: string; readonly warehouseId: string; readonly status: string },
  ): Promise<PackRecord | null> {
    return packRecordOfOrderInTx(tx, tenantId, order, (t, tenant, warehouse, orderId) =>
      this.inventory.ledgerEventsByOrderRefInTx(t, tenant, warehouse, orderId),
    );
  }

  /**
   * A11 — `GET …/outbound/orders/{orderId}/cartons` (ungated read): the pack
   * (A48's choice) and its history. 404 unknown; 409 `order-not-packed` when
   * the order has neither a pack nor a `pack.packed` event.
   */
  async getOrderCartons(tenantId: string, orderId: string): Promise<{ pack: PackView; history: PackHistoryRecord[] }> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if (!UUID_RE.test(orderId)) throw orderNotFound(orderId);
      const rows = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
        .limit(1);
      const order = rows[0];
      if (order === undefined) throw orderNotFound(orderId);
      const record = await this.packRecordInTx(tx, tenantId, order);
      if (record === null) throw orderNotPacked(orderLabelOf(order), order.status);
      const history = await packHistoryOfOrderInTx(tx, tenantId, order, (t, tenant, warehouse, id) =>
        this.inventory.ledgerEventsByOrderRefInTx(t, tenant, warehouse, id),
      );
      return { pack: await packViewInTx(tx, tenantId, record, this.caseFacts), history };
    });
  }

  private async skuFactsInTx(tx: TenantTx, tenantId: string, skuIds: readonly string[]): Promise<Map<string, CartonSkuFacts>> {
    if (skuIds.length === 0) return new Map();
    const rows = await tx
      .select({ id: skus.id, code: skus.code, uom: skus.uom, catchWeight: skus.catchWeightTracked })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, [...skuIds])));
    return new Map(rows.map((row) => [row.id, { code: row.code, uom: row.uom, catchWeight: row.catchWeight }]));
  }
}

/** A stored or virtual pack in the aggregated shape, so `sameSplit` can compare it with a body. */
function aggregatedOf(record: PackRecord): AggregatedCarton[] {
  return record.cartons.map((carton) => {
    const totals = new Map<string, number>();
    const handlingUnitIdsBySku = new Map<string, readonly string[]>();
    for (const line of carton.lines) {
      totals.set(line.skuId, line.qty);
      if (line.handlingUnitIds !== null && line.handlingUnitIds.length > 0) {
        handlingUnitIdsBySku.set(line.skuId, [...line.handlingUnitIds].sort());
      }
    }
    return {
      seq: carton.seq,
      scanned: [],
      totals,
      handlingUnitIdsBySku,
      weightGrams: carton.weightGrams,
      dimensionsMm: carton.dimensionsMm,
    };
  });
}
