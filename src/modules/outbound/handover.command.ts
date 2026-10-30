import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, courierHandovers, orderCartons, orders, shipments, type CourierHandover, type Order, type OrderPack, type Shipment } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { awbProblem, normalizeAwb } from '../../shared/primitives/awb';
import { parseCartonCode } from '../../shared/primitives/carton-code';
import { parcelTagCode } from '../../shared/primitives/parcel-tag';
import { normalizeCourierInput, type NormalizedCourier } from '../../shared/primitives/courier';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { normalizePhone, PHONE_RE } from '../../shared/primitives/phone';
import { normalizeVehicleNo, VEHICLE_NO_RE } from '../../shared/primitives/vehicle';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn, getWarehouseCodeInTx, invoicePartyFactsInTx } from '../tenancy/tenancy.service';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { recordServerRejectedOpInTx } from '../tenancy/server-rejected-op';
import { clientPartySnapshotOf, getClientInTx, shareLockClientInTx } from '../clients/clients.facade';
import { assertTransporterInTx, type TransporterSnapshotV1 } from '../partners/partners.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import { openLiveRecallLinesForBatchesInTx } from '../recalls/open-recall-lines';
import { claimOwnedRefsInTx } from '../attachments/attachment-records';
import { appendDocumentSharedInTx } from './client-arranged';
import { DispatchCommandService } from './dispatch.command';
import { awbInUse, insertClientArrangedInTx, MAX_PACKAGE_COUNT } from './client-label.command';
import { replayInTx, validation, writeKeyInTx } from './shipping-support';
import { MAX_WEIGHT_GRAMS } from './pack.command';
import { shareLockLivePacksInTx } from './order-packs';
import { livePackFactsOfOrdersInTx } from './cartons.read';
import type { ConsignmentGateCode } from '../../shared/primitives/consignment-gate';
import { istDateOf } from '../../shared/primitives/time';
import { consignmentFactsOfOrderRowsInTx, consignmentRefusal, judgeConsignment, NationalThresholds } from './consignment.read';

/**
 * Story 4-4a (A12, A32, A33, A36, A37, A40) — the courier handover: one
 * courier, one client, one pickup. It records the pickup, hands over every
 * parcel that passes its classification, DISPATCHES each order in the same
 * transaction (the existing dispatch body, `dispatchOrderInTx`), freezes the
 * parties its sheet prints, and claims the handheld's sheet photos. The web
 * is all-or-nothing (409 `handover-parcels-refused`); the handheld settles
 * partially (guide §7g) — the parcels left with the courier.
 */

/** A37 — at most this many parcels per handover (measured: 100 orders × 3 lines inside 5 s). */
export const MAX_HANDOVER_PARCELS = 100;
/** A14 — at most this many sheet photos ride a device handover. */
export const MAX_HANDOVER_PHOTOS = 10;
/** A40 — the web's business-time window: `[now − 7 days, now + 2 minutes]`. */
export const HANDOVER_PAST_MS = 7 * 86_400_000;
export const HANDOVER_FUTURE_MS = 2 * 60_000;

/** D13 — the per-parcel refusal vocabulary (one reason each, in classification order). */
export const HANDOVER_PARCEL_REFUSALS = [
  'order-not-found',
  'warehouse-mismatch',
  'order-not-ready',
  'order-already-dispatched',
  'shipment-not-client-arranged',
  'label-not-verified',
  'awb-mismatch',
  'awb-required',
  'awb-in-use',
  'order-holds-recalled-batch',
  // Story 4-5a (A21, D5) — appended LAST and classified last, so a parcel is
  // judged on its cartons only once every 4-4a check passes.
  'package-count-mismatch',
  'carton-not-current',
  // Story 4-6a (A14, A31, D4) — appended at the VERY END and judged last, so a
  // consignment code never masks a recall, AWB or carton refusal. The web
  // refuses them; a device parcel is handed over and flagged instead.
  'consignment-documents-missing',
  'eway-bill-required',
  'eway-bill-expired',
] as const;
export type HandoverParcelRefusal = (typeof HANDOVER_PARCEL_REFUSALS)[number];

export const HANDOVER_SOURCES = ['web', 'handheld'] as const;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export interface HandoverParcelInput {
  readonly orderId: string;
  readonly awb?: string | null | undefined;
  readonly packageCount?: number | null | undefined;
  readonly weightGrams?: number | null | undefined;
  /** Story 4-5a (A21) — the carton labels scanned onto the courier's pickup (≤ 200). */
  readonly cartonCodes?: readonly string[] | null | undefined;
}

/** Story 4-5a (A21) — at most this many carton codes per parcel (`order_packs_carton_count_range`). */
export const MAX_HANDOVER_CARTON_CODES = 200;

export interface HandOverCommand {
  readonly tenantId: string;
  readonly surface:
    | { readonly kind: 'web'; readonly actorUserId: string }
    | { readonly kind: 'device'; readonly deviceId: string; readonly operatorUserId: string };
  readonly warehouseId: string;
  readonly clientId: string;
  readonly courier: { readonly transporterId?: string | null; readonly courierName?: string | null } | null | undefined;
  readonly pickupPersonName: string | undefined;
  readonly pickupPersonPhone?: string | null | undefined;
  readonly vehicleNumber?: string | null | undefined;
  readonly occurredAt?: string | null | undefined;
  readonly note?: string | null | undefined;
  readonly parcels: readonly HandoverParcelInput[] | undefined;
  readonly photoRefs?: readonly string[] | null | undefined;
}

/** The handover as a command answers it (no phone — DPDP; the detail read unmasks it for `dispatch.execute`). */
export interface HandoverView {
  readonly id: string;
  readonly code: string;
  readonly warehouseId: string;
  readonly clientId: string;
  readonly courierName: string;
  readonly transporterId: string | null;
  readonly pickupPersonName: string;
  readonly vehicleNumber: string | null;
  readonly handedOverAt: string;
  readonly shipmentCount: number;
  readonly packageCount: number;
  readonly codShipmentCount: number;
  readonly codTotalPaise: number;
  readonly source: 'web' | 'handheld';
}

export interface HandoverParcelResult {
  readonly orderId: string;
  readonly shipmentId: string;
  readonly awb: string;
  readonly dispatched: true;
  readonly followOnOrderId: string | null;
  /**
   * Story 4-6a (A14) — a device parcel that left without the brand's
   * documents (a stale snapshot): the gate's code, also on its shipment row.
   * Present only when set, so a 4-4a snapshot's bytes stand.
   */
  readonly complianceException?: ConsignmentGateCode;
}

export interface HandoverRefusedParcel {
  readonly orderId: string;
  readonly code: HandoverParcelRefusal;
  readonly detail: string;
  /** FB11 — the order's status under its lock; absent when the order was not found. */
  readonly orderStatus?: string;
}

export interface HandoverSnapshot {
  readonly handover: HandoverView | null;
  readonly parcels: readonly HandoverParcelResult[];
  readonly refused: readonly HandoverRefusedParcel[];
  readonly rejectedOpId: string | null;
}

/** What the facade applies after the commit (counter restores, the follow-on allocations). */
export interface HandoverOutcome {
  readonly snapshot: HandoverSnapshot;
  readonly after: readonly { readonly orderId: string; readonly warehouseId: string; readonly restores: ReadonlyMap<string, number>; readonly followOnOrderId: string | null }[];
}

interface NormalizedHandover {
  readonly courier: NormalizedCourier;
  readonly pickupPersonName: string;
  readonly pickupPersonPhone: string | null;
  readonly vehicleNumber: string | null;
  readonly occurredAt: string | null;
  readonly note: string | null;
  readonly parcels: readonly NormalizedHandoverParcel[];
  readonly photoRefs: readonly string[];
}

interface NormalizedHandoverParcel {
  readonly orderId: string;
  readonly awb: string | null;
  readonly packageCount: number | null;
  readonly weightGrams: number | null;
  /** Story 4-5a — trimmed and upper-cased; absent (never empty) when none was scanned. */
  readonly cartonCodes?: readonly string[];
}

/**
 * D13 — the handover hash's ONE builder, so a later story adds a key only
 * when present. Normalised, absent as null, parcels sorted by order id,
 * photo refs sorted.
 */
export function handoverHashInput(tenantId: string, surface: 'web' | 'device', warehouseId: string, clientId: string, input: NormalizedHandover): Record<string, unknown> {
  return {
    arm: 'handover',
    surface,
    tenantId,
    warehouseId,
    clientId,
    courier: { transporterId: input.courier.transporterId, courierName: input.courier.courierName },
    pickupPersonName: input.pickupPersonName,
    pickupPersonPhone: input.pickupPersonPhone,
    vehicleNumber: input.vehicleNumber,
    occurredAt: input.occurredAt,
    note: input.note,
    parcels: [...input.parcels]
      .sort((a, b) => (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0))
      .map((parcel) => ({
        orderId: parcel.orderId,
        awb: parcel.awb,
        packageCount: parcel.packageCount,
        weightGrams: parcel.weightGrams,
        // Story 4-5a (A21, D5) — only when present, so a 4-4a key replays.
        ...(parcel.cartonCodes === undefined ? {} : { cartonCodes: [...parcel.cartonCodes].sort() }),
      })),
    photoRefs: input.photoRefs.length === 0 ? null : [...input.photoRefs].sort(),
  };
}

/** The handover code sequence's advisory-lock key text (the RTV allocator shape). */
export function handoverSequenceLockKey(tenantId: string): string {
  return `${tenantId}:handover-seq`;
}

export function handoverCode(n: number): string {
  return `HO-${String(n).padStart(4, '0')}`;
}

/** §7g — the review row's op id: derived from the key, never the key. */
export function refusedParcelsOpId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${idempotencyKey}:handover-refused`).digest();
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ULID_ALPHABET.charAt(digest[i]! & 31);
  const derived = idempotencyKey.slice(0, 10).toUpperCase().padEnd(10, '0') + tail;
  if (derived !== idempotencyKey) return derived;
  const last = derived.charAt(25);
  return derived.slice(0, 25) + (last === '0' ? '1' : '0');
}

@Injectable()
export class HandoverCommand {
  private readonly logger = new Logger('HandoverCommand');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(DispatchCommandService) private readonly dispatch: DispatchCommandService,
  ) {}

  async handOver(raw: HandOverCommand, key: string): Promise<HandoverOutcome> {
    const surface = raw.surface.kind;
    if (typeof raw.warehouseId !== 'string' || !UUID_RE.test(raw.warehouseId)) throw validation('warehouseId must be a uuid.');
    if (typeof raw.clientId !== 'string' || !UUID_RE.test(raw.clientId)) throw validation('clientId must be a uuid.');
    // E1 — the ids normalised ONCE: the hash, every compare and every insert read these.
    const command: HandOverCommand = { ...raw, warehouseId: raw.warehouseId.toLowerCase(), clientId: raw.clientId.toLowerCase() };
    const input = normalizeHandover(command);
    const payloadHash = hashCommandPayload(handoverHashInput(command.tenantId, surface, command.warehouseId, command.clientId, input));
    const actorUserId = command.surface.kind === 'web' ? command.surface.actorUserId : command.surface.operatorUserId;
    const tenantId = command.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx): Promise<HandoverOutcome> => {
      // 1. authority (the device: its operator, which locks the device row).
      if (command.surface.kind === 'device') {
        await assertDeviceOperatorInTx(tx, tenantId, command.surface.deviceId, command.surface.operatorUserId);
      }
      assertPermission(await getMemberRoleIn(tx, tenantId, actorUserId), 'dispatch.execute');
      // 2. replay.
      const first = await replayInTx(tx, tenantId, key, payloadHash);
      if (first !== null) return { snapshot: first as HandoverSnapshot, after: [] };

      // A40 — one clock reading; the web window is judged AFTER the replay.
      const now = nowIso();
      const nowMs = Date.parse(now);
      if (surface === 'web' && input.occurredAt !== null) {
        const at = Date.parse(input.occurredAt);
        if (at < nowMs - HANDOVER_PAST_MS || at > nowMs + HANDOVER_FUTURE_MS) {
          throw validation('occurredAt must be within the last 7 days (and not in the future) — the courier’s pickup time.');
        }
      }
      const handedOverAt = new Date(Math.min(input.occurredAt === null ? nowMs : Date.parse(input.occurredAt), nowMs)).toISOString();

      await assertWarehouseInTenant(tx, tenantId, command.warehouseId);
      // 3. the client FOR SHARE (a suspended client still ships; a departed one does not).
      const client = await shareLockClientInTx(tx, tenantId, command.clientId);
      if (client.status === 'departed') {
        throw new ProblemException('client-departed', 409, 'The client has departed', `Client ${client.code} has departed — its parcels are not handed over here.`);
      }
      // 4. the named orders FOR UPDATE in id order.
      const orderIds = [...new Set(input.parcels.map((parcel) => parcel.orderId))].sort();
      const orderRows = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, orderIds)))
        .orderBy(asc(orders.id))
        .for('update');
      // 5. replay again, under the order locks.
      const second = await replayInTx(tx, tenantId, key, payloadHash);
      if (second !== null) return { snapshot: second as HandoverSnapshot, after: [] };
      const orderById = new Map(orderRows.map((row) => [row.id, row]));
      // A36 — one mixed-client rule, both surfaces: whole-op.
      const foreign = orderRows.filter((row) => row.clientId !== command.clientId).map((row) => row.id);
      if (foreign.length > 0) {
        throw new ProblemException(
          'handover-client-mismatch',
          409,
          'Parcels of another client',
          `${foreign.length} of the parcels belong to another client — one handover carries one client's parcels; hand the others over separately.`,
          { orderIds: foreign },
        );
      }
      // Story 4-5a (A21, D5) — their live packs FOR SHARE in order-id order,
      // after the orders and before the shipments: a re-carton takes order →
      // pack → shipment, so the two serialise on the order lock and acquire
      // in the same order.
      const livePacks = await shareLockLivePacksInTx(tx, tenantId, orderRows.map((row) => row.id));
      // 6. their live shipments FOR UPDATE in id order.
      const shipmentRows =
        orderRows.length === 0
          ? []
          : await tx
              .select()
              .from(shipments)
              .where(and(eq(shipments.tenantId, tenantId), inArray(shipments.orderId, orderRows.map((row) => row.id)), ne(shipments.status, 'voided')))
              .orderBy(asc(shipments.id))
              .for('update');
      const shipmentByOrder = new Map(shipmentRows.map((row) => [row.orderId, row]));
      // 7. every member order's picked batches, together, FOR KEY SHARE in one sorted set.
      const batchesByOrder = await this.inventory.pickedBatchRefsOfOrdersInTx(tx, tenantId, orderRows.map((row) => row.id));
      const allBatches = [...new Set([...batchesByOrder.values()].flat())];
      await this.catalog.keyShareLockBatchesInTx(tx, tenantId, allBatches);
      // 8. the transporter.
      const transporter: TransporterSnapshotV1 | null =
        input.courier.transporterId === null ? null : await assertTransporterInTx(tx, tenantId, input.courier.transporterId, 'a courier handover');
      const courierName = transporter?.name ?? input.courier.courierName!;

      // Story 4-6a (A14, A32) — the consignment facts of every member order in
      // one batch (under the order locks), and the pack times each order's
      // dispatch is dated by (A40: never before its pack) — read here so the
      // classification judges the gate on the SAME date the dispatch takes.
      const consignmentFacts = await consignmentFactsOfOrderRowsInTx(tx, tenantId, orderRows);
      const packs = await this.inventory.packMeasurementsOfOrdersInTx(tx, tenantId, orderRows.map((order) => order.id));
      const occurredAtOf = (orderId: string): string => {
        const pack = packs.get(orderId) ?? null;
        return pack !== null && Date.parse(pack.packedAt) > Date.parse(handedOverAt) ? new Date(Date.parse(pack.packedAt)).toISOString() : handedOverAt;
      };
      const thresholds = new NationalThresholds(tx);
      const todayIst = istDateOf(now);

      // ── the per-parcel classification, in body order ─────────────────────
      const passing: {
        parcel: (typeof input.parcels)[number];
        order: Order;
        shipment: Shipment | null;
        livePack: OrderPack | null;
        cartons: CartonJudgement;
        complianceException: ConsignmentGateCode | null;
      }[] = [];
      const refused: HandoverRefusedParcel[] = [];
      const refuse = (orderId: string, code: HandoverParcelRefusal, detail: string) => {
        const status = orderById.get(orderId)?.status;
        refused.push({ orderId, code, detail, ...(status === undefined ? {} : { orderStatus: status }) });
      };
      const awbsTaken = new Set<string>();
      for (const parcel of input.parcels) {
        const order = orderById.get(parcel.orderId);
        if (order === undefined) {
          refuse(parcel.orderId, 'order-not-found', `No order ${parcel.orderId} in this tenant.`);
          continue;
        }
        const label = orderLabelOf(order);
        const shipment = shipmentByOrder.get(order.id) ?? null;
        if (order.warehouseId !== command.warehouseId) {
          refuse(order.id, 'warehouse-mismatch', `Order ${label} ships from another warehouse.`);
          continue;
        }
        if (order.status === 'dispatched') {
          refuse(order.id, 'order-already-dispatched', `Order ${label} was already dispatched.`);
          continue;
        }
        if (order.status !== 'ready_to_dispatch') {
          refuse(order.id, 'order-not-ready', `Order ${label} reads "${order.status}" — only a packed order is handed over.`);
          continue;
        }
        if (shipment !== null && shipment.kind === 'carrier') {
          refuse(order.id, 'shipment-not-client-arranged', `Order ${label} has a carrier label (${shipment.carrierName}) — put it on that carrier's manifest.`);
          continue;
        }
        if (shipment !== null && parcel.awb !== null && parcel.awb !== shipment.trackingNumber) {
          refuse(order.id, 'awb-mismatch', `The scanned AWB …${parcel.awb.slice(-4)} is not order ${label}'s (…${shipment.trackingNumber.slice(-4)}).`);
          continue;
        }
        if (shipment !== null && shipment.kind === 'client-label' && parcel.awb === null && shipment.labelVerifiedAt === null) {
          refuse(order.id, 'label-not-verified', `Order ${label}'s client label was not scanned onto the parcel — scan its AWB here.`);
          continue;
        }
        if ((shipment === null || shipment.kind === 'courier-label') && parcel.awb === null) {
          refuse(order.id, 'awb-required', `Order ${label} has no verified label — scan the courier's AWB on the parcel.`);
          continue;
        }
        if (shipment === null) {
          const awb = parcel.awb!;
          const holder = await openAwbHolderInTx(tx, tenantId, order.clientId, awb);
          if ((holder !== null && holder.orderId !== order.id) || awbsTaken.has(awb)) {
            refuse(order.id, 'awb-in-use', awbInUse(awb, holder?.orderId ?? order.id, holder === null ? label : orderLabelOf(holder.order), label).message);
            continue;
          }
        }
        const recalled = await openLiveRecallLinesForBatchesInTx(tx, tenantId, batchesByOrder.get(order.id) ?? []);
        if (recalled.length > 0) {
          const codes = [...new Set(recalled.map((line) => line.recallCode))].sort();
          refuse(order.id, 'order-holds-recalled-batch', `Order ${label} holds a lot under recall ${codes.join(', ')} — it cannot ship.`);
          continue;
        }
        // Story 4-5a (A21, A34, A37) — the cartons, judged last.
        const livePack = livePacks.get(order.id) ?? null;
        const cartons = judgeCartons(order, label, parcel, livePack, surface);
        if (cartons.refusal !== null) {
          refuse(order.id, cartons.refusal.code, cartons.refusal.detail);
          continue;
        }
        // Story 4-6a (A14, A31, A32) — the consignment gate, judged LAST and
        // once per parcel on the dispatch's own date. The web also judges
        // today (a backdated pickup cannot pass an expired bill); the device
        // judges only the dispatch date — the parcel left then — and flags
        // instead of refusing (decision 6: the parcel is gone; the office
        // records the documents afterwards).
        let complianceException: ConsignmentGateCode | null = null;
        const facts = consignmentFacts.get(order.id)!;
        const dispatchDay = istDateOf(occurredAtOf(order.id));
        const threshold = await thresholds.on(dispatchDay);
        let gate = judgeConsignment(facts, threshold, dispatchDay);
        if (!gate.blocking && surface === 'web' && todayIst !== dispatchDay) {
          gate = judgeConsignment(facts, await thresholds.on(todayIst), todayIst);
        }
        if (gate.blocking) {
          if (surface === 'web') {
            refuse(order.id, gate.code!, consignmentRefusal(facts, gate, threshold).message);
            continue;
          }
          complianceException = gate.code;
        }
        awbsTaken.add(parcel.awb ?? shipment!.trackingNumber);
        passing.push({ parcel, order, shipment, livePack, cartons, complianceException });
      }

      if (surface === 'web' && refused.length > 0) {
        throw new ProblemException(
          'handover-parcels-refused',
          409,
          'Some parcels cannot be handed over',
          `${refused.length} of ${input.parcels.length} parcels cannot be handed over: ${refused.map((r) => r.code).join(', ')} — nothing was written.`,
          { parcels: refused.map((r) => ({ orderId: r.orderId, code: r.code, detail: r.detail, ...(r.orderStatus === undefined ? {} : { orderStatus: r.orderStatus }) })) },
        );
      }

      const deviceId = command.surface.kind === 'device' ? command.surface.deviceId : null;
      const header = {
        warehouseId: command.warehouseId,
        clientId: command.clientId,
        courier: { transporterId: input.courier.transporterId, courierName: input.courier.courierName },
        pickupPersonName: input.pickupPersonName,
        pickupPersonPhone: input.pickupPersonPhone,
        vehicleNumber: input.vehicleNumber,
        occurredAt: input.occurredAt,
        note: input.note,
      };
      let rejectedOpId: string | null = null;
      let reviewRowId: string | null = null;
      const raiseReview = async (): Promise<void> => {
        if (refused.length === 0 || deviceId === null) return;
        const opId = refusedParcelsOpId(key);
        reviewRowId = await recordServerRejectedOpInTx(tx, this.outbox, {
          tenantId,
          deviceId,
          operatorUserId: actorUserId,
          opId,
          opType: 'handover.create',
          problemCode: 'handover-parcels-refused',
          problemDetail: `${refused.length} parcel(s) left with ${courierName} but were not handed over (${[...new Set(refused.map((r) => r.code))].join(', ')}).`,
          payload: {
            ...header,
            parcels: refused.map((r) => ({ ...input.parcels.find((p) => p.orderId === r.orderId)! })),
            photoRefs: [...input.photoRefs],
            refusals: refused.map((r) => ({ orderId: r.orderId, code: r.code, detail: r.detail, ...(r.orderStatus === undefined ? {} : { orderStatus: r.orderStatus }) })),
          },
          occurredAt: handedOverAt,
        });
        rejectedOpId = opId;
      };

      // §7g — every parcel refused on the device: no handover row; the review
      // row carries them all, and the audit targets it.
      if (passing.length === 0) {
        await raiseReview();
        const snapshot: HandoverSnapshot = { handover: null, parcels: [], refused, rejectedOpId };
        // The review row is new on every non-replayed execution (its op id is
        // derived from this key); the fallback is unreachable.
        const reviewId = (reviewRowId as string | null) ?? uuidv7();
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId,
          actorUserId,
          action: 'handover.parcels_refused',
          targetType: 'rejected_op',
          targetId: reviewId,
          reference: key,
          changes: { refused: refused.map((r) => ({ orderId: r.orderId, code: r.code })) },
          occurredAt: now,
        });
        if (deviceId !== null) await touchDeviceInTx(tx, deviceId);
        await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
        return { snapshot, after: [] };
      }

      // ── the writes ──────────────────────────────────────────────────────
      // 9. the HO- sequence.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${handoverSequenceLockKey(tenantId)}, 0))`);
      const seq = await tx
        .select({ n: sql<number>`coalesce(max(substring(${courierHandovers.code} from '^HO-([0-9]{1,9})$')::int), 0)` })
        .from(courierHandovers)
        .where(eq(courierHandovers.tenantId, tenantId));
      const code = handoverCode(Number(seq[0]?.n ?? 0) + 1);

      const memberOrders = passing.map((entry) => entry.order);
      const codOrders = memberOrders.filter((order) => order.codAmountPaise !== null);
      const codTotalPaise = codOrders.reduce((sum, order) => sum + Number(order.codAmountPaise), 0);
      // Story 4-5a (A40) — the typed count, else the STORED live pack's cartons
      // (never a virtual pack's — 4-4a's legacy default holds), else the
      // shipment's, else 1.
      const packages = passing.map((entry) => entry.parcel.packageCount ?? entry.livePack?.cartonCount ?? entry.shipment?.packageCount ?? 1);
      const packageCount = packages.reduce((sum, n) => sum + n, 0);
      const clientSnapshot = clientPartySnapshotOf(await getClientInTx(tx, tenantId, command.clientId));
      const party = await invoicePartyFactsInTx(tx, tenantId, command.warehouseId);
      const warehouseSnapshot = {
        v: 1,
        code: await getWarehouseCodeInTx(tx, tenantId, command.warehouseId),
        name: party.warehouseName,
        gstin: party.warehouseGstin,
        originAddress: party.originAddress,
        operatorName: party.tenantName,
      };
      const handoverId = uuidv7();
      const [handover] = await tx
        .insert(courierHandovers)
        .values({
          id: handoverId,
          tenantId,
          warehouseId: command.warehouseId,
          clientId: command.clientId,
          code,
          courierPartnerId: input.courier.transporterId,
          courierSnapshot: transporter,
          courierName,
          pickupPersonName: input.pickupPersonName,
          pickupPersonPhone: input.pickupPersonPhone,
          vehicleNumber: input.vehicleNumber,
          handedOverAt,
          shipmentCount: passing.length,
          packageCount,
          codShipmentCount: codOrders.length,
          codTotalPaise,
          clientSnapshot,
          warehouseSnapshot,
          source: surface === 'web' ? 'web' : 'handheld',
          deviceId,
          note: input.note,
          createdBy: actorUserId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      // The pack measurements and times (A12 step 2, A40) — read above, with the classification.
      // Story 4-5a (A33, A39, D4) — a stored live pack is the measurement
      // source (the gross only within the shipment bound; dimensions only for
      // one carton); the ledger's pack docs serve a virtual pack only.
      const packFacts = await livePackFactsOfOrdersInTx(tx, tenantId, memberOrders.map((order) => order.id));
      const results: HandoverParcelResult[] = [];
      const after: { orderId: string; warehouseId: string; restores: ReadonlyMap<string, number>; followOnOrderId: string | null }[] = [];
      const shipmentIds: string[] = [];
      for (const [index, entry] of passing.entries()) {
        const { parcel, order } = entry;
        const label = orderLabelOf(order);
        const pack = packs.get(order.id) ?? null;
        const facts = packFacts.get(order.id) ?? null;
        const weightGrams = parcel.weightGrams ?? (facts !== null ? facts.weightGrams : (pack?.weightGrams ?? null));
        const dims =
          facts !== null
            ? facts.dimensionsMm
            : pack !== null && pack.lengthMm !== null && pack.widthMm !== null && pack.heightMm !== null
              ? { lengthMm: pack.lengthMm, widthMm: pack.widthMm, heightMm: pack.heightMm }
              : null;
        const count = packages[index]!;
        let shipment: Shipment;
        if (entry.shipment === null) {
          // An order with no shipment and a scanned AWB: a courier-label row,
          // created handed over (A12, A50 D39).
          try {
            shipment = await insertClientArrangedInTx(tx, {
              tenantId,
              order,
              kind: 'courier-label',
              courierName,
              transporterId: input.courier.transporterId,
              transporter,
              awb: parcel.awb!,
              packageCount: count,
              labelAttachmentId: null,
              actorUserId,
              labelledAt: handedOverAt,
              surface: surface === 'web' ? 'web' : 'handheld',
              status: 'handed_over',
              label,
              // B6 — the AWB scanned here IS the verification (as on a pre-advised row).
              handover: { id: handoverId, at: handedOverAt, weightGrams, dims, verify: { at: handedOverAt, by: actorUserId, deviceId } },
            });
          } catch (err) {
            // A33 — another command took this AWB meanwhile: a kept conflict.
            if (err instanceof ProblemException && (err.getResponse() as { code?: string }).code === 'awb-in-use') {
              throw new ProblemException('conflict', 409, 'AWB taken concurrently', `AWB ${parcel.awb} was just recorded elsewhere — retry the handover.`);
            }
            throw err;
          }
        } else {
          const verifyNow = parcel.awb !== null && entry.shipment.labelVerifiedAt === null;
          const [updated] = await tx
            .update(shipments)
            .set({
              status: 'handed_over',
              handoverId,
              handedOverAt,
              packageCount: count,
              weightGrams: weightGrams ?? entry.shipment.weightGrams,
              // Story 4-6a (A14) — set only on a flagged device parcel.
              complianceException: entry.complianceException,
              ...(dims === null ? {} : { lengthMm: dims.lengthMm, widthMm: dims.widthMm, heightMm: dims.heightMm }),
              ...(verifyNow
                ? { labelVerifiedAt: handedOverAt, labelVerifiedBy: actorUserId, labelVerifiedDeviceId: deviceId, labelVerifyMethod: 'handover-scan' }
                : {}),
              updatedAt: now,
            })
            .where(and(eq(shipments.id, entry.shipment.id), eq(shipments.status, 'labelled')))
            .returning();
          if (updated === undefined) {
            throw new ProblemException('conflict', 409, 'Shipment moved', `Order ${label}'s shipment changed during the handover — retry it.`);
          }
          shipment = updated;
        }
        if (entry.shipment === null && entry.complianceException !== null) {
          // Story 4-6a (A14) — the courier-label row created handed over above carries the flag too.
          const [flagged] = await tx
            .update(shipments)
            .set({ complianceException: entry.complianceException, updatedAt: now })
            .where(and(eq(shipments.tenantId, tenantId), eq(shipments.id, shipment.id)))
            .returning();
          shipment = flagged!;
        }
        shipmentIds.push(shipment.id);
        // Story 4-5a (A21) — the scanned cartons of the live pack carry this handover.
        if (entry.livePack !== null && entry.cartons.record.length > 0) {
          await tx
            .update(orderCartons)
            .set({ handoverId, handoverScannedAt: handedOverAt })
            .where(
              and(
                eq(orderCartons.tenantId, tenantId),
                eq(orderCartons.packId, entry.livePack.id),
                inArray(orderCartons.seq, [...entry.cartons.record]),
                sql`${orderCartons.handoverId} is null`,
              ),
            );
        }
        // A40 — a dispatch is never dated before its pack (the date the gate judged).
        const occurredAt = occurredAtOf(order.id);
        const dispatched = await this.dispatch.dispatchOrderInTx(tx, {
          tenantId,
          order,
          actorUserId,
          carrierName: shipment.carrierName,
          trackingNumber: shipment.trackingNumber,
          occurredAt,
          recordedAt: now,
          batchesLocked: true,
          idempotencyKey: key,
          handoverId,
          // Story 4-6a (A32) — judged once, above.
          consignment: 'pre-checked',
          complianceException: entry.complianceException,
        });
        results.push({
          orderId: order.id,
          shipmentId: shipment.id,
          awb: shipment.trackingNumber,
          dispatched: true,
          followOnOrderId: dispatched.followOnOrderId,
          ...(entry.complianceException === null ? {} : { complianceException: entry.complianceException }),
        });
        after.push({ orderId: order.id, warehouseId: order.warehouseId, restores: dispatched.counterRestores, followOnOrderId: dispatched.followOnOrderId });
      }

      // 11. last, the device's sheet photos (2-5a A1's claim, sorted).
      if (deviceId !== null && input.photoRefs.length > 0) {
        const claim = await claimOwnedRefsInTx(tx, {
          tenantId,
          deviceId,
          ownerType: 'courier_handover',
          ownerId: handoverId,
          purpose: 'handover-sheet',
          clientId: command.clientId,
          warehouseId: command.warehouseId,
          actorUserId,
          refs: input.photoRefs,
        });
        for (const page of claim.attached) {
          await appendDocumentSharedInTx(tx, this.outbox, {
            tenantId,
            at: now,
            payload: { attachmentId: page.attachmentId, clientId: command.clientId, orderId: null, handoverId, purpose: 'handover-sheet', docKind: null },
          });
        }
      }

      const view = handoverViewOf(handover!);
      // Story 4-5a (A21, A37, A44) — per order: its cartons, how many were
      // scanned, whether the COD carton left, and any stale labels accepted.
      const cartonChanges = passing
        .filter((entry) => entry.livePack !== null || entry.parcel.cartonCodes !== undefined)
        .map((entry) => ({
          orderId: entry.order.id,
          cartonCount: entry.livePack?.cartonCount ?? 1,
          scanned: entry.cartons.accepted.length,
          ...(entry.cartons.codCartonScanned === null ? {} : { codCartonScanned: entry.cartons.codCartonScanned }),
          ...(entry.cartons.stale ? { staleCartonLabels: true } : {}),
        }));
      const complianceExceptions = passing
        .filter((entry) => entry.complianceException !== null)
        .map((entry) => ({ orderId: entry.order.id, code: entry.complianceException! }));
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId,
        type: 'handover.created',
        occurredAt: handedOverAt,
        payload: { handoverId, code, clientId: command.clientId, warehouseId: command.warehouseId, shipmentIds },
      });
      await raiseReview();
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId,
        action: 'handover.created',
        targetType: 'courier_handover',
        targetId: handoverId,
        reference: key,
        changes: {
          code,
          parcels: results.length,
          refused: refused.length,
          source: view.source,
          ...(cartonChanges.length === 0 ? {} : { cartons: cartonChanges }),
          // Story 4-6a (A14) — the device parcels that left without their documents.
          ...(complianceExceptions.length === 0 ? {} : { complianceExceptions }),
        },
        occurredAt: now,
      });
      if (deviceId !== null) await touchDeviceInTx(tx, deviceId);
      const snapshot: HandoverSnapshot = { handover: view, parcels: results, refused, rejectedOpId };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return { snapshot, after };
    });
  }
}

export function handoverViewOf(row: CourierHandover): HandoverView {
  return {
    id: row.id,
    code: row.code,
    warehouseId: row.warehouseId,
    clientId: row.clientId,
    courierName: row.courierName,
    transporterId: row.courierPartnerId,
    pickupPersonName: row.pickupPersonName,
    vehicleNumber: row.vehicleNumber,
    handedOverAt: canonicalInstant(row.handedOverAt),
    shipmentCount: row.shipmentCount,
    packageCount: row.packageCount,
    codShipmentCount: row.codShipmentCount,
    codTotalPaise: Number(row.codTotalPaise),
    source: row.source as 'web' | 'handheld',
  };
}

/** Story 4-5a — how one parcel's cartons were judged. */
interface CartonJudgement {
  readonly refusal: { readonly code: 'package-count-mismatch' | 'carton-not-current'; readonly detail: string } | null;
  /** The live pack's carton numbers scanned (recorded on `order_cartons` — a stored pack only). */
  readonly record: readonly number[];
  /** The current pack's carton numbers scanned (a virtual pack's too — accepted, not recorded). */
  readonly accepted: readonly number[];
  /** A44 — a COD order with cartons scanned: was carton 1 among them? Null when not judged. */
  readonly codCartonScanned: boolean | null;
  /** A37 — the device scanned a superseded pack's label (accepted: the parcel has left). */
  readonly stale: boolean;
}

/**
 * Story 4-5a (A21, A34, A37) — judge a parcel's cartons against the order's
 * live pack (a stored row) or its virtual pack (packed before 4-5a: pack 1,
 * one carton). `package-count-mismatch` only with a stored pack, and on the
 * device only when the parcel carries carton codes (a pre-4-5a handheld's
 * queued op is judged as 4-4a judged it). `carton-not-current`: an unreadable
 * code, another order's, a pack number that is not the live one (a
 * superseded pack's label is accepted on the device and flagged — the parcel
 * has left), or a carton number past the count.
 */
function judgeCartons(
  order: Order,
  label: string,
  parcel: NormalizedHandoverParcel,
  livePack: OrderPack | null,
  surface: 'web' | 'device',
): CartonJudgement {
  const codes = parcel.cartonCodes ?? [];
  const refuse = (code: 'package-count-mismatch' | 'carton-not-current', detail: string): CartonJudgement => ({
    refusal: { code, detail },
    record: [],
    accepted: [],
    codCartonScanned: null,
    stale: false,
  });
  if (livePack !== null && parcel.packageCount !== null && parcel.packageCount !== livePack.cartonCount && (surface === 'web' || codes.length > 0)) {
    return refuse(
      'package-count-mismatch',
      `Order ${label} is packed in ${livePack.cartonCount} carton${livePack.cartonCount === 1 ? '' : 's'} — the parcel count reads ${parcel.packageCount}.`,
    );
  }
  const tag = parcelTagCode(order.id);
  const packSeq = livePack?.seq ?? 1;
  const cartonCount = livePack?.cartonCount ?? 1;
  const accepted: number[] = [];
  let stale = false;
  for (const code of codes) {
    const parsed = parseCartonCode(code);
    if (parsed === null || parsed.parcelTag !== tag) {
      return refuse('carton-not-current', `Carton label ${code} is not order ${label}'s.`);
    }
    if (parsed.packSeq !== packSeq) {
      if (livePack !== null && parsed.packSeq < packSeq && surface === 'device') {
        stale = true;
        continue;
      }
      return refuse('carton-not-current', `Carton label ${code} is from pack ${parsed.packSeq} — order ${label} is packed as pack ${packSeq}; reprint its labels.`);
    }
    if (parsed.seq > cartonCount) {
      return refuse('carton-not-current', `Order ${label} has ${cartonCount} carton${cartonCount === 1 ? '' : 's'} — there is no carton ${parsed.seq}.`);
    }
    accepted.push(parsed.seq);
  }
  const scannedAny = codes.length > 0;
  return {
    refusal: null,
    record: livePack === null ? [] : accepted,
    accepted,
    codCartonScanned: order.codAmountPaise !== null && scannedAny ? accepted.includes(1) : null,
    stale,
  };
}

/** The client's open client-arranged holder of an AWB, if any (the D6 read). */
async function openAwbHolderInTx(tx: TenantTx, tenantId: string, clientId: string, awb: string): Promise<{ orderId: string; order: Order } | null> {
  const rows = await tx
    .select({ orderId: shipments.orderId, order: orders })
    .from(shipments)
    .innerJoin(orders, and(eq(orders.tenantId, shipments.tenantId), eq(orders.id, shipments.orderId)))
    .where(
      and(
        eq(shipments.tenantId, tenantId),
        eq(shipments.clientId, clientId),
        eq(shipments.trackingNumber, awb),
        eq(shipments.status, 'labelled'),
        sql`${shipments.kind} <> 'carrier'`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Story 4-5a (A21, A38) — a parcel's scanned carton codes: an array of at most
 * 200 strings, each trimmed and upper-cased; an empty array is absent; unique
 * by the parsed `(parcelTag, packSeq, seq)` (an unreadable code by its text —
 * it is refused per parcel as `carton-not-current`, never here).
 */
function normalizeCartonCodes(raw: unknown, index: number): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw validation(`parcels[${index}].cartonCodes must be an array of carton codes.`);
  if (raw.length === 0) return null;
  if (raw.length > MAX_HANDOVER_CARTON_CODES) throw validation(`parcels[${index}].cartonCodes: at most ${MAX_HANDOVER_CARTON_CODES} cartons.`);
  const seen = new Set<string>();
  return raw.map((value: unknown) => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 64) {
      throw validation(`parcels[${index}].cartonCodes must be carton codes (e.g. O0123456789ABCDEF.1.2).`);
    }
    const code = value.trim().toUpperCase();
    const parsed = parseCartonCode(code);
    const identity = parsed === null ? `raw:${code}` : `${parsed.parcelTag}.${parsed.packSeq}.${parsed.seq}`;
    if (seen.has(identity)) throw validation(`parcels[${index}].cartonCodes lists carton ${code} twice.`);
    seen.add(identity);
    return code;
  });
}

/** Shape (400), above the transaction. */
function normalizeHandover(command: HandOverCommand): NormalizedHandover {
  const courier = normalizeCourierInput(command.courier ?? {});
  const name = typeof command.pickupPersonName === 'string' ? command.pickupPersonName.trim() : '';
  if (name.length < 1 || [...name].length > 100) throw validation('pickupPersonName must be 1–100 characters (who collected the parcels).');
  const phone = normalizePhone(command.pickupPersonPhone ?? null);
  if (phone !== null && !PHONE_RE.test(phone)) throw validation('pickupPersonPhone must be 7–15 digits, optionally with a leading +.');
  const vehicle = normalizeVehicleNo(command.vehicleNumber ?? null);
  if (vehicle !== null && !VEHICLE_NO_RE.test(vehicle)) throw validation('vehicleNumber must be 4–15 letters or digits (e.g. KA01AB1234).');
  const rawNote = typeof command.note === 'string' ? command.note.trim() : '';
  if ([...rawNote].length > 500) throw validation('note must be at most 500 characters.');
  const note = rawNote === '' ? null : rawNote;
  let occurredAt: string | null = null;
  if (command.occurredAt !== undefined && command.occurredAt !== null) {
    if (typeof command.occurredAt !== 'string' || !INSTANT_RE.test(command.occurredAt) || Number.isNaN(Date.parse(command.occurredAt))) {
      throw validation('occurredAt must be an ISO-8601 instant.');
    }
    occurredAt = new Date(Date.parse(command.occurredAt)).toISOString();
  }
  if (command.surface.kind === 'device' && occurredAt === null) {
    throw validation('occurredAt is required on the device — when the courier collected the parcels.');
  }
  const parcels = command.parcels;
  if (!Array.isArray(parcels) || parcels.length < 1 || parcels.length > MAX_HANDOVER_PARCELS) {
    throw validation(`parcels must list 1–${MAX_HANDOVER_PARCELS} parcels (a larger pickup is two handovers).`);
  }
  const seenOrders = new Set<string>();
  const seenAwbs = new Set<string>();
  const normalized = parcels.map((parcel, index) => {
    const orderId = typeof parcel?.orderId === 'string' ? parcel.orderId.toLowerCase() : '';
    if (!UUID_RE.test(orderId)) throw validation(`parcels[${index}].orderId must be a uuid.`);
    if (seenOrders.has(orderId)) throw validation(`parcels[${index}]: order ${orderId} is listed twice.`);
    seenOrders.add(orderId);
    let awb: string | null = null;
    if (parcel.awb !== undefined && parcel.awb !== null && String(parcel.awb).trim() !== '') {
      awb = normalizeAwb(String(parcel.awb));
      const problem = awbProblem(awb);
      if (problem !== null) throw validation(`parcels[${index}].awb: ${problem}`);
      if (seenAwbs.has(awb)) throw validation(`parcels[${index}]: AWB ${awb} is listed twice.`);
      seenAwbs.add(awb);
    }
    const count = parcel.packageCount ?? null;
    if (count !== null && (!Number.isInteger(count) || count < 1 || count > MAX_PACKAGE_COUNT)) {
      throw validation(`parcels[${index}].packageCount must be 1–${MAX_PACKAGE_COUNT}.`);
    }
    const weight = parcel.weightGrams ?? null;
    if (weight !== null && (!Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT_GRAMS)) {
      throw validation(`parcels[${index}].weightGrams must be a whole number of grams, 1–${MAX_WEIGHT_GRAMS}.`);
    }
    const cartonCodes = normalizeCartonCodes(parcel.cartonCodes, index);
    return { orderId, awb, packageCount: count, weightGrams: weight, ...(cartonCodes === null ? {} : { cartonCodes }) };
  });
  const refs = command.photoRefs ?? null;
  let photoRefs: string[] = [];
  if (refs !== null && refs.length > 0) {
    if (command.surface.kind === 'web') throw validation('photoRefs are the handheld’s — upload the signed sheet on the handover instead.');
    if (!Array.isArray(refs) || refs.length > MAX_HANDOVER_PHOTOS) throw validation(`photoRefs: at most ${MAX_HANDOVER_PHOTOS} photos.`);
    for (const ref of refs) {
      if (typeof ref !== 'string' || !ULID_RE.test(ref)) throw validation('photoRefs must be photo ULIDs.');
    }
    if (new Set(refs).size !== refs.length) throw validation('photoRefs lists a photo twice.');
    photoRefs = [...refs];
  }
  return { courier, pickupPersonName: name, pickupPersonPhone: phone, vehicleNumber: vehicle, occurredAt, note, parcels: normalized, photoRefs };
}
