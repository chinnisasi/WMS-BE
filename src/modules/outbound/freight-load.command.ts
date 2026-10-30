import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, freightConsignments, freightLoads, freightLoadScans, orders, shipments, type FreightConsignment, type FreightLoad, type Order } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { parcelTagCode } from '../../shared/primitives/parcel-tag';
import { FREIGHT_LIMITS, freightLoadCode, parsePackageScan, type PackageSetOfTag } from '../../shared/primitives/freight';
import { istDateOf, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { assertTransporterInTx, type TransporterSnapshotV1 } from '../partners/partners.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import { replayInTx, validation, writeKeyInTx } from './shipping-support';
import {
  assertUnstampedInTx,
  FREIGHT_FUTURE_MS,
  FREIGHT_PAST_MS,
  freightLoadSequenceLockKey,
  loadHeaderHash,
  loadNotFound,
  loadNotOpen,
  loadStateRefusal,
  normalizeLoadHeader,
  normalizeOrderIds,
  optionalInstant,
  removeConsignmentsInTx,
  requiredReason,
  warehouseMismatch,
  type LoadHeaderInput,
  type NormalizedLoadHeader,
} from './freight-support';
import {
  freightLoadViewInTx,
  liveConsignmentsOfLoadInTx,
  lockLoadInTx,
  packageSetsOfOrdersInTx,
  progressOf,
  loadedScansOfConsignmentsInTx,
  type FreightLoadView,
  type PackMeasurementsReader,
} from './freight.read';
import { FREIGHT_REASONS, type FreightAddRefusal } from './freight-vocabulary';

/**
 * Story 4-9a (A9–A13, A15, A44–A46, A51, A55, A62, A64) — the freight load's
 * header and membership commands, its cancel and the per-package scan. Every
 * command is one transaction on the guide §1 skeleton; every write to the
 * staff-only load and scan tables runs unstamped (A64). The departure is
 * `FreightDispatchCommand` (freight-dispatch.command.ts).
 */

export interface FreightLoadSnapshot {
  readonly load: FreightLoadView;
}

export interface CreateFreightLoadCommand extends LoadHeaderInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly orderIds?: readonly string[] | null;
}

export interface UpdateFreightLoadCommand extends LoadHeaderInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly loadId: string;
}

export interface FreightOrdersCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly loadId: string;
  readonly orderIds: readonly string[] | undefined;
}

export interface RemoveFreightOrderCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly loadId: string;
  readonly orderId: string;
  readonly reason: string | undefined;
}

export interface CancelFreightLoadCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly loadId: string;
  readonly reason: string | undefined;
}

export interface RecordFreightScanCommand {
  readonly tenantId: string;
  readonly surface:
    | { readonly kind: 'web'; readonly actorUserId: string }
    | { readonly kind: 'device'; readonly deviceId: string; readonly operatorUserId: string };
  readonly loadId: string;
  readonly packageCode: string | undefined;
  readonly action: string | undefined;
  readonly occurredAt?: string | null | undefined;
  readonly reason?: string | null | undefined;
  /** A55 — the device names its warehouse (from its snapshot). */
  readonly warehouseId?: string | null | undefined;
}

export interface FreightScanSnapshot {
  readonly scan: { readonly packageCode: string; readonly orderId: string; readonly status: 'loaded' | 'unloaded' };
  readonly alreadyLoaded: boolean;
  readonly progress: { readonly consignmentId: string; readonly loaded: number; readonly total: number };
}

interface AddRefusal {
  readonly orderId: string;
  readonly code: FreightAddRefusal;
  readonly detail: string;
  readonly loadCode?: string;
}

@Injectable()
export class FreightLoadCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  private readonly measurements: PackMeasurementsReader = (tx, tenantId, orderIds) => this.inventory.packMeasurementsOfOrdersInTx(tx, tenantId, orderIds);

  async viewInTx(tx: TenantTx, tenantId: string, load: FreightLoad, now: string): Promise<FreightLoadView> {
    return (await freightLoadViewInTx(tx, tenantId, load, { unmask: true, todayIst: istDateOf(now), measurements: this.measurements })).view;
  }

  // ── A9: create ─────────────────────────────────────────────────────────

  async createLoad(command: CreateFreightLoadCommand, key: string): Promise<FreightLoadSnapshot> {
    if (typeof command.warehouseId !== 'string' || !UUID_RE.test(command.warehouseId)) throw validation('warehouseId must be a uuid.');
    const warehouseId = command.warehouseId.toLowerCase();
    const header = normalizeLoadHeader(command);
    const orderIds = command.orderIds === undefined || command.orderIds === null || command.orderIds.length === 0 ? [] : normalizeOrderIds(command.orderIds, 'orderIds', 1, FREIGHT_LIMITS.consignments);
    const payloadHash = hashCommandPayload({
      arm: 'freight-load-create',
      tenantId: command.tenantId,
      warehouseId,
      ...loadHeaderHash(header),
      orderIds: orderIds.length === 0 ? null : [...orderIds].sort(),
    });
    const tenantId = command.tenantId;
    return withTenantTransaction(this.db, tenantId, async (tx): Promise<FreightLoadSnapshot> => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'dispatch.execute');
      const replayed = await replayInTx(tx, tenantId, key, payloadHash);
      if (replayed !== null) return replayed as FreightLoadSnapshot;
      await assertUnstampedInTx(tx);
      const now = nowIso();
      assertReportedAtWindow(header, now);
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const transporter: TransporterSnapshotV1 | null =
        header.transporter.transporterId === null ? null : await assertTransporterInTx(tx, tenantId, header.transporter.transporterId, 'a freight load');
      const loadId = uuidv7();
      let added: Order[] = [];
      if (orderIds.length > 0) {
        await lockOrdersInTx(tx, tenantId, orderIds);
        // Replay under the order locks, before the classification would refuse the winner's own orders.
        const parked = await replayInTx(tx, tenantId, key, payloadHash);
        if (parked !== null) return parked as FreightLoadSnapshot;
        added = await this.classifyAdditionsInTx(tx, tenantId, warehouseId, orderIds, 0);
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${freightLoadSequenceLockKey(tenantId)}, 0))`);
      // The second replay, under the sequence lock (and the order locks): a same-key
      // duplicate parked behind the winner wakes to its snapshot (guide §1).
      const raced = await replayInTx(tx, tenantId, key, payloadHash);
      if (raced !== null) return raced as FreightLoadSnapshot;
      const seq = await tx
        .select({ n: sql<number>`coalesce(max(substring(${freightLoads.code} from '^LD-([0-9]{1,9})$')::int), 0)` })
        .from(freightLoads)
        .where(eq(freightLoads.tenantId, tenantId));
      const code = freightLoadCode(Number(seq[0]?.n ?? 0) + 1);
      const [load] = await tx
        .insert(freightLoads)
        .values({
          id: loadId,
          tenantId,
          warehouseId,
          code,
          status: 'open',
          mode: header.mode,
          transporterPartnerId: header.transporter.transporterId,
          transporterSnapshot: transporter,
          transporterName: transporter?.name ?? header.transporter.courierName!,
          vehicleType: header.vehicleType,
          vehicleNumber: header.vehicleNumber,
          containerNumber: header.containerNumber,
          vehicleCapacityKg: header.vehicleCapacityKg,
          vehicleReportedAt: header.vehicleReportedAt,
          driverName: header.driverName,
          driverPhone: header.driverPhone,
          driverLicenceNumber: header.driverLicenceNumber,
          dockDoor: header.dockDoor,
          note: header.note,
          createdBy: command.actorUserId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (added.length > 0) await this.insertConsignmentsInTx(tx, tenantId, load!, added, command.actorUserId, now, []);
      await this.outbox.append(tx, { messageId: uuidv7(), tenantId, type: 'freight_load.created', occurredAt: now, payload: { loadId, code, warehouseId } });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: command.actorUserId,
        action: 'freight_load.created',
        targetType: 'freight_load',
        targetId: loadId,
        reference: key,
        changes: { code, mode: header.mode, transporterName: load!.transporterName, vehicleNumber: header.vehicleNumber },
        occurredAt: now,
      });
      if (added.length > 0) {
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId,
          actorUserId: command.actorUserId,
          action: 'freight_load.orders_added',
          targetType: 'freight_load',
          targetId: loadId,
          reference: key,
          changes: { orderIds: added.map((order) => order.id) },
          occurredAt: now,
        });
      }
      const snapshot: FreightLoadSnapshot = { load: await this.viewInTx(tx, tenantId, load!, now) };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── A9: update (a full replacement of the header) ─────────────────────

  async updateLoad(command: UpdateFreightLoadCommand, key: string): Promise<FreightLoadSnapshot> {
    const header = normalizeLoadHeader(command);
    const loadId = command.loadId.toLowerCase();
    const payloadHash = hashCommandPayload({ arm: 'freight-load-update', tenantId: command.tenantId, loadId, ...loadHeaderHash(header) });
    const tenantId = command.tenantId;
    return withTenantTransaction(this.db, tenantId, async (tx): Promise<FreightLoadSnapshot> => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'dispatch.execute');
      const first = await replayInTx(tx, tenantId, key, payloadHash);
      if (first !== null) return first as FreightLoadSnapshot;
      await assertUnstampedInTx(tx);
      const load = await lockLoadInTx(tx, tenantId, loadId, 'update');
      const second = await replayInTx(tx, tenantId, key, payloadHash);
      if (second !== null) return second as FreightLoadSnapshot;
      if (load === null) throw loadNotFound(loadId);
      if (load.status !== 'open') throw loadNotOpen(load);
      const now = nowIso();
      assertReportedAtWindow(header, now);
      const transporterChanged = header.transporter.transporterId !== load.transporterPartnerId || (header.transporter.transporterId === null && header.transporter.courierName !== load.transporterName);
      const transporter: TransporterSnapshotV1 | null =
        header.transporter.transporterId === null
          ? null
          : transporterChanged
            ? await assertTransporterInTx(tx, tenantId, header.transporter.transporterId, 'a freight load')
            : (load.transporterSnapshot as TransporterSnapshotV1);
      const next = {
        mode: header.mode,
        transporterPartnerId: header.transporter.transporterId,
        transporterName: transporter?.name ?? header.transporter.courierName!,
        vehicleType: header.vehicleType,
        vehicleNumber: header.vehicleNumber,
        containerNumber: header.containerNumber,
        vehicleCapacityKg: header.vehicleCapacityKg,
        vehicleReportedAt: header.vehicleReportedAt,
        driverName: header.driverName,
        driverPhone: header.driverPhone,
        driverLicenceNumber: header.driverLicenceNumber,
        dockDoor: header.dockDoor,
        note: header.note,
      };
      const before: Record<string, unknown> = {
        mode: load.mode,
        transporterPartnerId: load.transporterPartnerId,
        transporterName: load.transporterName,
        vehicleType: load.vehicleType,
        vehicleNumber: load.vehicleNumber,
        containerNumber: load.containerNumber,
        vehicleCapacityKg: load.vehicleCapacityKg,
        vehicleReportedAt: load.vehicleReportedAt === null ? null : new Date(Date.parse(load.vehicleReportedAt)).toISOString(),
        driverName: load.driverName,
        driverPhone: load.driverPhone,
        driverLicenceNumber: load.driverLicenceNumber,
        dockDoor: load.dockDoor,
        note: load.note,
      };
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      for (const [field, after] of Object.entries(next)) {
        if (before[field] !== after) changes[field] = { before: before[field], after };
      }
      if (Object.keys(changes).length === 0) {
        // The no-op stores the key (`freight.load-update:unchanged`): no write, no audit.
        const snapshot: FreightLoadSnapshot = { load: await this.viewInTx(tx, tenantId, load, now) };
        await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
        return snapshot;
      }
      const [updated] = await tx
        .update(freightLoads)
        .set({ ...next, transporterSnapshot: transporter, updatedAt: now })
        .where(and(eq(freightLoads.tenantId, tenantId), eq(freightLoads.id, load.id)))
        .returning();
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: command.actorUserId,
        action: 'freight_load.updated',
        targetType: 'freight_load',
        targetId: load.id,
        reference: key,
        changes,
        occurredAt: now,
      });
      const snapshot: FreightLoadSnapshot = { load: await this.viewInTx(tx, tenantId, updated!, now) };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── A10: add orders ───────────────────────────────────────────────────

  async addOrders(command: FreightOrdersCommand, key: string): Promise<FreightLoadSnapshot> {
    const orderIds = normalizeOrderIds(command.orderIds, 'orderIds', 1, FREIGHT_LIMITS.consignments);
    const loadId = command.loadId.toLowerCase();
    const payloadHash = hashCommandPayload({ arm: 'freight-orders-add', tenantId: command.tenantId, loadId, orderIds: [...orderIds].sort() });
    const tenantId = command.tenantId;
    return withTenantTransaction(this.db, tenantId, async (tx): Promise<FreightLoadSnapshot> => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'dispatch.execute');
      const first = await replayInTx(tx, tenantId, key, payloadHash);
      if (first !== null) return first as FreightLoadSnapshot;
      await assertUnstampedInTx(tx);
      const load = await lockLoadInTx(tx, tenantId, loadId, 'update');
      const second = await replayInTx(tx, tenantId, key, payloadHash);
      if (second !== null) return second as FreightLoadSnapshot;
      if (load === null) throw loadNotFound(loadId);
      if (load.status !== 'open') throw loadNotOpen(load);
      const live = await liveConsignmentsOfLoadInTx(tx, tenantId, load.id);
      const added = await this.classifyAdditionsInTx(tx, tenantId, load.warehouseId, orderIds, live.length);
      const now = nowIso();
      await this.insertConsignmentsInTx(tx, tenantId, load, added, command.actorUserId, now, live);
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: command.actorUserId,
        action: 'freight_load.orders_added',
        targetType: 'freight_load',
        targetId: load.id,
        reference: key,
        changes: { orderIds: added.map((order) => order.id) },
        occurredAt: now,
      });
      const snapshot: FreightLoadSnapshot = { load: await this.viewInTx(tx, tenantId, load, now) };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * A10 — the named orders `FOR UPDATE` in id order, then one refusal each in
   * classification order, all-or-nothing (409 `freight-orders-refused`), then
   * the count (409 `load-full`). Returns the orders in body order.
   */
  private async classifyAdditionsInTx(tx: TenantTx, tenantId: string, warehouseId: string, orderIds: readonly string[], current: number): Promise<Order[]> {
    const sorted = [...orderIds].sort();
    const rows = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, sorted)))
      .orderBy(asc(orders.id))
      .for('update');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const consignments = rows.length === 0
      ? []
      : await tx
          .select({ orderId: freightConsignments.orderId, loadCode: freightLoads.code })
          .from(freightConsignments)
          .innerJoin(freightLoads, and(eq(freightLoads.tenantId, freightConsignments.tenantId), eq(freightLoads.id, freightConsignments.loadId)))
          .where(and(eq(freightConsignments.tenantId, tenantId), inArray(freightConsignments.orderId, rows.map((row) => row.id)), ne(freightConsignments.status, 'removed')));
    const onLoad = new Map(consignments.map((row) => [row.orderId, row.loadCode]));
    const liveShipments = rows.length === 0
      ? []
      : await tx
          .select({ orderId: shipments.orderId, kind: shipments.kind, carrierName: shipments.carrierName })
          .from(shipments)
          .where(and(eq(shipments.tenantId, tenantId), inArray(shipments.orderId, rows.map((row) => row.id)), ne(shipments.status, 'voided')));
    const shipped = new Map(liveShipments.map((row) => [row.orderId, row]));
    const refused: AddRefusal[] = [];
    const accepted: Order[] = [];
    for (const id of orderIds) {
      const order = byId.get(id);
      if (order === undefined) {
        refused.push({ orderId: id, code: 'order-not-found', detail: `No order ${id} in this tenant.` });
        continue;
      }
      const label = orderLabelOf(order);
      if (order.warehouseId !== warehouseId) {
        refused.push({ orderId: id, code: 'warehouse-mismatch', detail: `Order ${label} ships from another warehouse.` });
        continue;
      }
      if (order.status !== 'accepted' && order.status !== 'ready_to_dispatch') {
        refused.push({ orderId: id, code: 'order-not-open', detail: `Order ${label} reads "${order.status}" — only an accepted or packed order rides a truck.` });
        continue;
      }
      const loadCode = onLoad.get(id);
      if (loadCode !== undefined) {
        refused.push({ orderId: id, code: 'order-on-freight-load', detail: `Order ${label} is already on truck ${loadCode} — remove it there first.`, loadCode });
        continue;
      }
      const shipment = shipped.get(id);
      if (shipment !== undefined) {
        refused.push({
          orderId: id,
          code: 'order-has-courier-shipment',
          detail: `Order ${label} has a ${shipment.kind === 'carrier' ? 'carrier' : 'client-arranged'} label (${shipment.carrierName}) — void it first; an order leaves one way.`,
        });
        continue;
      }
      accepted.push(order);
    }
    if (refused.length > 0) throw freightOrdersRefused(refused, orderIds.length, 'added to the truck');
    if (current + accepted.length > FREIGHT_LIMITS.consignments) {
      throw new ProblemException(
        'load-full',
        409,
        'The load is full',
        `This truck carries ${current} orders; adding ${accepted.length} would pass ${FREIGHT_LIMITS.consignments} — start a second load.`,
        { current, adding: accepted.length, max: FREIGHT_LIMITS.consignments },
      );
    }
    return accepted;
  }

  /** A10, A46 — one planned consignment per order, stops continuing from the highest live stop (renumbered first if they would pass 100). */
  private async insertConsignmentsInTx(tx: TenantTx, tenantId: string, load: FreightLoad, added: readonly Order[], actorUserId: string, now: string, live: readonly FreightConsignment[]): Promise<void> {
    let next = live.reduce((max, row) => Math.max(max, row.stopSeq), 0) + 1;
    if (next + added.length - 1 > FREIGHT_LIMITS.consignments) {
      for (const [index, row] of live.entries()) {
        await tx.update(freightConsignments).set({ stopSeq: index + 1, updatedAt: now }).where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.id, row.id)));
      }
      next = live.length + 1;
    }
    for (const order of added) {
      try {
        await tx.insert(freightConsignments).values({
          id: uuidv7(),
          tenantId,
          warehouseId: load.warehouseId,
          loadId: load.id,
          orderId: order.id,
          clientId: order.clientId,
          status: 'planned',
          stopSeq: next,
          addedBy: actorUserId,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, 'freight_consignments_order_live_unique')) {
          throw freightOrdersRefused([{ orderId: order.id, code: 'order-on-freight-load', detail: `Order ${orderLabelOf(order)} was just put on another truck.` }], added.length, 'added to the truck');
        }
        throw err;
      }
      next += 1;
    }
  }

  // ── A11: remove one order ─────────────────────────────────────────────

  async removeOrder(command: RemoveFreightOrderCommand, key: string): Promise<FreightLoadSnapshot> {
    const reason = requiredReason(command.reason);
    const loadId = command.loadId.toLowerCase();
    const orderId = command.orderId.toLowerCase();
    const payloadHash = hashCommandPayload({ arm: 'freight-order-remove', tenantId: command.tenantId, loadId, orderId, reason });
    const tenantId = command.tenantId;
    return withTenantTransaction(this.db, tenantId, async (tx): Promise<FreightLoadSnapshot> => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'dispatch.execute');
      const first = await replayInTx(tx, tenantId, key, payloadHash);
      if (first !== null) return first as FreightLoadSnapshot;
      await assertUnstampedInTx(tx);
      const load = await lockLoadInTx(tx, tenantId, loadId, 'update');
      const second = await replayInTx(tx, tenantId, key, payloadHash);
      if (second !== null) return second as FreightLoadSnapshot;
      if (load === null) throw loadNotFound(loadId);
      // The order, then its consignment (the global order).
      const orderRows = UUID_RE.test(orderId)
        ? await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId))).limit(1).for('update')
        : [];
      const consignmentRows = orderRows.length === 0
        ? []
        : await tx
            .select()
            .from(freightConsignments)
            .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.loadId, load.id), eq(freightConsignments.orderId, orderId), eq(freightConsignments.status, 'planned')))
            .limit(1)
            .for('update');
      if (load.status !== 'open') throw loadNotOpen(load);
      const consignment = consignmentRows[0];
      if (consignment === undefined) {
        throw new ProblemException('not-found', 404, 'Order not on this load', `Order ${orderId} is not planned on ${load.code}.`);
      }
      const now = nowIso();
      const { unloaded } = await removeConsignmentsInTx(tx, { tenantId, consignmentIds: [consignment.id], actorUserId: command.actorUserId, reason, at: now });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: command.actorUserId,
        action: 'freight_load.order_removed',
        targetType: 'freight_load',
        targetId: load.id,
        reference: key,
        changes: { orderId, reason, stopSeq: consignment.stopSeq, unloadedScans: unloaded },
        occurredAt: now,
      });
      const snapshot: FreightLoadSnapshot = { load: await this.viewInTx(tx, tenantId, load, now) };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── A12: reorder the stops ────────────────────────────────────────────

  async reorderStops(command: FreightOrdersCommand, key: string): Promise<FreightLoadSnapshot> {
    const orderIds = normalizeOrderIds(command.orderIds, 'orderIds', 1, FREIGHT_LIMITS.consignments);
    const loadId = command.loadId.toLowerCase();
    // The order IS the request: the list is hashed as sent.
    const payloadHash = hashCommandPayload({ arm: 'freight-stops', tenantId: command.tenantId, loadId, orderIds });
    const tenantId = command.tenantId;
    return withTenantTransaction(this.db, tenantId, async (tx): Promise<FreightLoadSnapshot> => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'dispatch.execute');
      const first = await replayInTx(tx, tenantId, key, payloadHash);
      if (first !== null) return first as FreightLoadSnapshot;
      await assertUnstampedInTx(tx);
      const load = await lockLoadInTx(tx, tenantId, loadId, 'update');
      const second = await replayInTx(tx, tenantId, key, payloadHash);
      if (second !== null) return second as FreightLoadSnapshot;
      if (load === null) throw loadNotFound(loadId);
      if (load.status !== 'open') throw loadNotOpen(load);
      const planned = (await liveConsignmentsOfLoadInTx(tx, tenantId, load.id)).filter((row) => row.status === 'planned');
      const current = planned.map((row) => row.orderId);
      if (current.length !== orderIds.length || [...current].sort().join() !== [...orderIds].sort().join()) {
        throw new ProblemException(
          'freight-members-changed',
          409,
          'The load’s orders changed',
          `The stops list ${orderIds.length} orders; ${load.code} now carries ${current.length} — reload and reorder again.`,
          { orderIds: current },
        );
      }
      const now = nowIso();
      if (current.join() === orderIds.join() && planned.every((row, index) => row.stopSeq === index + 1)) {
        const snapshot: FreightLoadSnapshot = { load: await this.viewInTx(tx, tenantId, load, now) };
        await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
        return snapshot;
      }
      const byOrder = new Map(planned.map((row) => [row.orderId, row]));
      for (const [index, orderId] of orderIds.entries()) {
        await tx
          .update(freightConsignments)
          .set({ stopSeq: index + 1, updatedAt: now })
          .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.id, byOrder.get(orderId)!.id)));
      }
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: command.actorUserId,
        action: 'freight_load.stops_reordered',
        targetType: 'freight_load',
        targetId: load.id,
        reference: key,
        changes: { before: current, after: orderIds },
        occurredAt: now,
      });
      const snapshot: FreightLoadSnapshot = { load: await this.viewInTx(tx, tenantId, load, now) };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── A15: cancel the load ──────────────────────────────────────────────

  async cancelLoad(command: CancelFreightLoadCommand, key: string): Promise<FreightLoadSnapshot> {
    const reason = requiredReason(command.reason);
    const loadId = command.loadId.toLowerCase();
    const payloadHash = hashCommandPayload({ arm: 'freight-load-cancel', tenantId: command.tenantId, loadId, reason });
    const tenantId = command.tenantId;
    return withTenantTransaction(this.db, tenantId, async (tx): Promise<FreightLoadSnapshot> => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'dispatch.execute');
      const first = await replayInTx(tx, tenantId, key, payloadHash);
      if (first !== null) return first as FreightLoadSnapshot;
      await assertUnstampedInTx(tx);
      const load = await lockLoadInTx(tx, tenantId, loadId, 'update');
      const second = await replayInTx(tx, tenantId, key, payloadHash);
      if (second !== null) return second as FreightLoadSnapshot;
      if (load === null) throw loadNotFound(loadId);
      if (load.status !== 'open') throw loadNotOpen(load);
      const now = nowIso();
      const planned = (await liveConsignmentsOfLoadInTx(tx, tenantId, load.id)).filter((row) => row.status === 'planned');
      const { removed } = await removeConsignmentsInTx(tx, {
        tenantId,
        consignmentIds: planned.map((row) => row.id),
        actorUserId: command.actorUserId,
        reason: `Load cancelled: ${reason}`,
        at: now,
      });
      const [cancelled] = await tx
        .update(freightLoads)
        .set({ status: 'cancelled', cancelledAt: now, cancelledBy: command.actorUserId, cancelReason: reason, updatedAt: now })
        .where(and(eq(freightLoads.tenantId, tenantId), eq(freightLoads.id, load.id), eq(freightLoads.status, 'open')))
        .returning();
      const orderIds = planned.filter((row) => removed.includes(row.id)).map((row) => row.orderId);
      await this.outbox.append(tx, { messageId: uuidv7(), tenantId, type: 'freight_load.cancelled', occurredAt: now, payload: { loadId: load.id, code: load.code, orderIds } });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: command.actorUserId,
        action: 'freight_load.cancelled',
        targetType: 'freight_load',
        targetId: load.id,
        reference: key,
        changes: { status: { before: 'open', after: 'cancelled' }, reason, orderIds },
        occurredAt: now,
      });
      const snapshot: FreightLoadSnapshot = { load: await this.viewInTx(tx, tenantId, cancelled!, now) };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── A13, A44, A45, A51, A55, A62: one package scanned ─────────────────

  async recordScan(command: RecordFreightScanCommand, key: string): Promise<FreightScanSnapshot> {
    const surface = command.surface.kind;
    const loadId = typeof command.loadId === 'string' ? command.loadId.toLowerCase() : '';
    const packageCode = typeof command.packageCode === 'string' ? command.packageCode.trim().toUpperCase() : '';
    if (packageCode === '' || packageCode.length > 64) throw validation('packageCode is required — scan the package label.');
    const action = command.action;
    if (action !== 'load' && action !== 'unload') throw validation('action must be load or unload.');
    const reason = action === 'unload' ? requiredReason(command.reason) : null;
    if (action === 'load' && command.reason !== undefined && command.reason !== null && command.reason !== '') throw validation('reason is for an unload only.');
    let occurredAt: string | null = null;
    if (command.occurredAt !== undefined && command.occurredAt !== null) {
      if (surface === 'web') throw validation('occurredAt is the handheld’s — the web scans now.');
      occurredAt = optionalInstant(command.occurredAt, 'occurredAt');
    }
    if (surface === 'device' && occurredAt === null) throw validation('occurredAt is required on the device — when the package was scanned.');
    let warehouseId: string | null = null;
    if (surface === 'device') {
      if (typeof command.warehouseId !== 'string' || !UUID_RE.test(command.warehouseId)) throw validation('warehouseId is required on the device (its snapshot’s warehouse).');
      warehouseId = command.warehouseId.toLowerCase();
    }
    const payloadHash = hashCommandPayload({ arm: 'freight-scan', surface, tenantId: command.tenantId, loadId, warehouseId, packageCode, action, occurredAt, reason });
    const actorUserId = command.surface.kind === 'web' ? command.surface.actorUserId : command.surface.operatorUserId;
    const deviceId = command.surface.kind === 'device' ? command.surface.deviceId : null;
    const tenantId = command.tenantId;
    return withTenantTransaction(this.db, tenantId, async (tx): Promise<FreightScanSnapshot> => {
      if (deviceId !== null) await assertDeviceOperatorInTx(tx, tenantId, deviceId, actorUserId);
      assertPermission(await getMemberRoleIn(tx, tenantId, actorUserId), 'dispatch.execute');
      const first = await replayInTx(tx, tenantId, key, payloadHash);
      if (first !== null) return first as FreightScanSnapshot;
      await assertUnstampedInTx(tx);
      // FOR SHARE: scanners never queue each other; the departure's FOR UPDATE waits for them.
      const load = await lockLoadInTx(tx, tenantId, loadId, 'share');
      // The load is only SHARED, so two same-key scans would not queue on it:
      // a per-key advisory serialises them, and the replay under it hands the
      // parked duplicate the winner's snapshot (guide §1).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:freight-scan:${key}`}, 0))`);
      const second = await replayInTx(tx, tenantId, key, payloadHash);
      if (second !== null) return second as FreightScanSnapshot;
      if (load === null) throw loadNotFound(loadId);
      if (warehouseId !== null && load.warehouseId !== warehouseId) throw warehouseMismatch(load);
      const now = nowIso();
      // The device's time, never in the future and never before the load existed.
      const scannedAt = occurredAt === null ? now : new Date(Math.max(Math.min(Date.parse(occurredAt), Date.parse(now)), Date.parse(load.createdAt))).toISOString();
      if (load.status === 'cancelled') throw loadStateRefusal(load)!;
      const lateScan = load.status === 'dispatched';
      if (lateScan && (action !== 'load' || occurredAt === null || Date.parse(scannedAt) > Date.parse(load.dispatchedAt!))) throw loadStateRefusal(load)!;

      // The load's consignments a package may belong to: planned before the
      // departure; dispatched on this load for a late scan (A44).
      const members = (await liveConsignmentsOfLoadInTx(tx, tenantId, load.id)).filter((row) => (lateScan ? row.status === 'dispatched' : row.status === 'planned'));
      const sets = await packageSetsOfOrdersInTx(tx, tenantId, members.map((row) => row.orderId), this.measurements);
      const byTag = new Map(members.map((row) => [parcelTagCode(row.orderId), row]));
      const parsed = parsePackageScan(packageCode, (tag): PackageSetOfTag | undefined => {
        const member = byTag.get(tag);
        const set = member === undefined ? undefined : sets.get(member.orderId);
        return set === undefined ? undefined : { packSeq: set.packSeq, packageCount: set.packageCount };
      });
      if (parsed.kind === 'invalid') {
        throw new ProblemException('package-code-invalid', 422, 'Not a package label', `${packageCode} is not a package label — scan the carton or pallet label.`);
      }
      if (parsed.kind === 'ambiguous') {
        throw new ProblemException(
          'package-code-ambiguous',
          422,
          'Scan each package label',
          `This is the order's parcel tag and the order has ${parsed.packageCount} packages — scan each carton or pallet label.`,
          { packageCount: parsed.packageCount },
        );
      }
      const member = byTag.get(parsed.parcelTag);
      if (member === undefined) {
        const otherLoadCode = await otherOpenLoadOfTagInTx(tx, tenantId, load, parsed.parcelTag);
        throw new ProblemException(
          'package-not-on-load',
          409,
          'Not on this truck',
          otherLoadCode === null ? `${packageCode} is not a package of any order on ${load.code}.` : `${packageCode} belongs to ${otherLoadCode}, not ${load.code}.`,
          { loadCode: otherLoadCode },
        );
      }
      // A45 — the consignment under its own lock, its status re-checked.
      const locked = await tx
        .select()
        .from(freightConsignments)
        .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.id, member.id)))
        .limit(1)
        .for(lateScan ? 'update' : 'share');
      const consignment = locked[0]!;
      if (consignment.status !== (lateScan ? 'dispatched' : 'planned')) {
        throw new ProblemException('consignment-removed', 409, 'The order left the load', `The order of ${packageCode} was removed from ${load.code}.`, { orderId: consignment.orderId });
      }
      const set = sets.get(consignment.orderId) ?? null;
      if (set === null) {
        throw new ProblemException('order-not-packed', 409, 'The order is not packed', `The order of ${packageCode} is not packed yet — pack it, print its labels, then load.`, { orderId: consignment.orderId });
      }
      if (parsed.kind !== 'package') throw new Error('unreachable');
      if (parsed.packSeq !== set.packSeq || parsed.seq > set.packageCount) {
        throw new ProblemException(
          'carton-not-current',
          409,
          'Old label',
          parsed.packSeq !== set.packSeq
            ? `${packageCode} is from pack ${parsed.packSeq} — the order was re-packed as pack ${set.packSeq}; reprint its labels.`
            : `The order has ${set.packageCount} packages — there is no package ${parsed.seq}.`,
          { orderId: consignment.orderId, packSeq: set.packSeq, packageCount: set.packageCount },
        );
      }
      const existing = await tx
        .select()
        .from(freightLoadScans)
        .where(and(eq(freightLoadScans.tenantId, tenantId), eq(freightLoadScans.consignmentId, consignment.id), eq(freightLoadScans.packageCode, parsed.code), eq(freightLoadScans.status, 'loaded')))
        .limit(1);
      const progress = async () => {
        if (lateScan) {
          const [row] = await tx.select().from(freightConsignments).where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.id, consignment.id))).limit(1);
          return { consignmentId: consignment.id, loaded: row!.loadedPackageCount ?? 0, total: row!.packageCount ?? set.packageCount };
        }
        const p = progressOf(await loadedScansOfConsignmentsInTx(tx, tenantId, [consignment.id]), set);
        return { consignmentId: consignment.id, loaded: p.loaded, total: p.total };
      };
      if (action === 'load' && existing.length > 0) {
        const snapshot: FreightScanSnapshot = { scan: { packageCode: parsed.code, orderId: consignment.orderId, status: 'loaded' }, alreadyLoaded: true, progress: await progress() };
        await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
        return snapshot;
      }
      if (action === 'unload' && existing.length === 0) {
        const snapshot: FreightScanSnapshot = { scan: { packageCode: parsed.code, orderId: consignment.orderId, status: 'unloaded' }, alreadyLoaded: false, progress: await progress() };
        await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
        return snapshot;
      }
      if (action === 'load') {
        const inserted = await tx
          .insert(freightLoadScans)
          .values({
            id: uuidv7(),
            tenantId,
            loadId: load.id,
            consignmentId: consignment.id,
            orderId: consignment.orderId,
            packageCode: parsed.code,
            packSeq: parsed.packSeq,
            packageSeq: parsed.seq,
            status: 'loaded',
            scannedAt,
            scannedBy: actorUserId,
            source: surface === 'web' ? 'web' : 'handheld',
            deviceId,
            afterDeparture: lateScan,
            createdAt: now,
          })
          .onConflictDoNothing({ target: [freightLoadScans.tenantId, freightLoadScans.consignmentId, freightLoadScans.packageCode], where: sql`status = 'loaded'` })
          .returning({ id: freightLoadScans.id });
        if (inserted.length === 0) {
          // A concurrent device won: the same no-op answer.
          const snapshot: FreightScanSnapshot = { scan: { packageCode: parsed.code, orderId: consignment.orderId, status: 'loaded' }, alreadyLoaded: true, progress: await progress() };
          await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
          return snapshot;
        }
        if (lateScan) {
          // A44 — a scan taken before the truck left, synced after: counted.
          const count = Math.min((consignment.loadedPackageCount ?? 0) + 1, consignment.packageCount ?? 0);
          const complete = count >= (consignment.packageCount ?? 0);
          await tx
            .update(freightConsignments)
            .set({ loadedPackageCount: count, ...(complete && consignment.loadException !== null ? { loadException: null } : {}), updatedAt: now })
            .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.id, consignment.id)));
        }
      } else {
        await tx
          .update(freightLoadScans)
          .set({ status: 'unloaded', unloadedAt: now, unloadedBy: actorUserId, unloadReason: reason! })
          .where(and(eq(freightLoadScans.tenantId, tenantId), eq(freightLoadScans.id, existing[0]!.id), eq(freightLoadScans.status, 'loaded')));
      }
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId,
        action: action === 'load' ? 'freight_load.package_loaded' : 'freight_load.package_unloaded',
        targetType: 'freight_load',
        targetId: load.id,
        reference: key,
        changes: { packageCode: parsed.code, orderId: consignment.orderId, ...(lateScan ? { afterDeparture: true } : {}), ...(reason === null ? {} : { reason }) },
        occurredAt: now,
      });
      if (deviceId !== null) await touchDeviceInTx(tx, deviceId);
      const snapshot: FreightScanSnapshot = {
        scan: { packageCode: parsed.code, orderId: consignment.orderId, status: action === 'load' ? 'loaded' : 'unloaded' },
        alreadyLoaded: false,
        progress: await progress(),
      };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }
}

/** The named orders `FOR UPDATE` in id order (lock only). */
async function lockOrdersInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<void> {
  await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.tenantId, tenantId), inArray(orders.id, [...orderIds].sort()))).orderBy(asc(orders.id)).for('update');
}

/** A9 — `vehicleReportedAt` in `[now − 7 days, now + 2 min]`, judged after the replay. */
function assertReportedAtWindow(header: NormalizedLoadHeader, now: string): void {
  if (header.vehicleReportedAt === null) return;
  const at = Date.parse(header.vehicleReportedAt);
  const nowMs = Date.parse(now);
  if (at < nowMs - FREIGHT_PAST_MS || at > nowMs + FREIGHT_FUTURE_MS) {
    throw validation('vehicleReportedAt must be within the last 7 days (and not in the future) — when the truck reported at the gate.');
  }
}

export function freightOrdersRefused(refused: readonly { orderId: string; code: string; detail: string; loadCode?: string }[], total: number, verb: string): ProblemException {
  return new ProblemException(
    'freight-orders-refused',
    409,
    'Some orders cannot be taken',
    `${refused.length} of ${total} orders cannot be ${verb}: ${[...new Set(refused.map((r) => r.code))].join(', ')} — nothing was written.`,
    { orders: refused.map((r) => ({ orderId: r.orderId, code: r.code, detail: r.detail, ...(r.loadCode === undefined ? {} : { loadCode: r.loadCode }) })) },
  );
}

/**
 * A62 — the code of the one open load (of this warehouse) whose planned
 * consignments carry the scanned parcel tag; null on zero or several matches
 * (the match is in memory over ≤ 50 × 100 consignments, 4-4a's match-key rule).
 */
async function otherOpenLoadOfTagInTx(tx: TenantTx, tenantId: string, load: FreightLoad, parcelTag: string): Promise<string | null> {
  const rows = await tx
    .select({ orderId: freightConsignments.orderId, loadCode: freightLoads.code })
    .from(freightConsignments)
    .innerJoin(freightLoads, and(eq(freightLoads.tenantId, freightConsignments.tenantId), eq(freightLoads.id, freightConsignments.loadId)))
    .where(
      and(
        eq(freightConsignments.tenantId, tenantId),
        eq(freightConsignments.status, 'planned'),
        eq(freightLoads.warehouseId, load.warehouseId),
        eq(freightLoads.status, 'open'),
        ne(freightLoads.id, load.id),
      ),
    )
    .limit(5_000);
  const matches = new Set(rows.filter((row) => parcelTagCode(row.orderId) === parcelTag).map((row) => row.loadCode));
  return matches.size === 1 ? [...matches][0]! : null;
}

export { FREIGHT_REASONS };
