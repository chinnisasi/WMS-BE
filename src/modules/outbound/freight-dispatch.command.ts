import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, freightConsignments, freightLoads, orders, type FreightConsignment, type Order } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { addIsoDays, istDateOf, nowIso } from '../../shared/primitives/time';
import { consignmentRef, FREIGHT_LIMITS } from '../../shared/primitives/freight';
import type { ConsignmentGateCode } from '../../shared/primitives/consignment-gate';
import { documentWarehousePartyOf } from '../../shared/documents/parties';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn, getWarehouseCodeInTx, invoicePartyFactsInTx } from '../tenancy/tenancy.service';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { recordServerRejectedOpInTx } from '../tenancy/server-rejected-op';
import { clientPartySnapshotOf, getClientInTx, shareLockClientInTx, type ClientPartySnapshotV1 } from '../clients/clients.facade';
import { assertTransporterInTx, type TransporterSnapshotV1 } from '../partners/partners.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import { openLiveRecallLinesForBatchesInTx } from '../recalls/open-recall-lines';
import { claimOwnedRefsInTx } from '../attachments/attachment-records';
import { liveConsignmentRecordsOfOrdersInTx } from '../invoicing/consignment-seam';
import { DispatchCommandService } from './dispatch.command';
import { shareLockLivePacksInTx } from './order-packs';
import { consignmentFactsOfOrderRowsInTx, consignmentRefusal, judgeConsignment, NationalThresholds } from './consignment.read';
import { replayInTx, validation, writeKeyInTx } from './shipping-support';
import {
  assertUnstampedInTx,
  derivedOpId,
  FREIGHT_FUTURE_MS,
  FREIGHT_PAST_MS,
  loadNotFound,
  loadStateRefusal,
  normalizeContainer,
  normalizeDriverPhone,
  normalizeLicence,
  normalizeLrInput,
  normalizePhotoRefs,
  normalizeSeals,
  normalizeVehicle,
  normalizeVehicleType,
  optionalInstant,
  optionalText,
  removeConsignmentsInTx,
  warehouseMismatch,
} from './freight-support';
import { freightLoadViewInTx, liveConsignmentsOfLoadInTx, loadedScansOfConsignmentsInTx, lockLoadInTx, packageSetsOfOrdersInTx, progressOf, type CarriageSnapshotV1, type FreightLoadView, type OrderPackageSet, type PackMeasurementsReader } from './freight.read';
import { FREIGHT_REASONS, type FreightDispatchRefusal, type FreightLoadException } from './freight-vocabulary';
import { freightOrdersRefused } from './freight-load.command';

/**
 * Story 4-9a (A14, A41, A42, A49, A50, A53, A54, A59, A63, A65, A66, A67) —
 * the truck leaves. One transaction: the load, the dispatching clients
 * (FOR SHARE), every member order (FOR UPDATE), the consignments (FOR
 * UPDATE), the live packs (FOR SHARE), the picked batches (FOR KEY SHARE, one
 * sorted set), then each order dispatched through `dispatchOrderInTx`
 * (`pre-checked` — the classification judged 4-6a's gate once per order),
 * the load stamped and the parties frozen. The web is all-or-nothing; the
 * handheld settles partially (guide §7g) — the truck has left.
 */

export interface FreightDispatchConsignmentInput {
  readonly orderId: string;
  readonly decision: string;
  readonly lrNumber?: string | null;
  readonly lrDate?: string | null;
  readonly freightTerms?: string | null;
  readonly unscannedAcknowledged?: boolean | null;
}

export interface DispatchFreightLoadCommand {
  readonly tenantId: string;
  readonly surface:
    | { readonly kind: 'web'; readonly actorUserId: string }
    | { readonly kind: 'device'; readonly deviceId: string; readonly operatorUserId: string };
  readonly loadId: string;
  readonly warehouseId?: string | null;
  readonly vehicleNumber: string | undefined;
  readonly vehicleType?: string | null;
  readonly containerNumber?: string | null;
  readonly driverName: string | undefined;
  readonly driverPhone?: string | null;
  readonly driverLicenceNumber?: string | null;
  readonly seals?: readonly string[] | null;
  readonly departedAt?: string | null;
  readonly occurredAt?: string | null;
  readonly ewayPartBConfirmed?: boolean | null;
  readonly overCapacityAcknowledged?: boolean | null;
  readonly consignments: readonly FreightDispatchConsignmentInput[] | undefined;
  readonly photoRefs?: readonly string[] | null;
  readonly note?: string | null;
}

export interface FreightDispatchedEntry {
  readonly orderId: string;
  readonly consignmentId: string;
  readonly lrNumber: string | null;
  readonly loadException: FreightLoadException | null;
  readonly complianceException: ConsignmentGateCode | null;
  readonly followOnOrderId: string | null;
}

export interface FreightRefusedEntry {
  readonly orderId: string;
  readonly code: FreightDispatchRefusal;
  readonly detail: string;
}

export interface FreightDispatchSnapshot {
  readonly load: FreightLoadView;
  readonly dispatched: readonly FreightDispatchedEntry[];
  readonly left: readonly { readonly orderId: string; readonly reason: string }[];
  readonly refused: readonly FreightRefusedEntry[];
  readonly rejectedOpId: string | null;
}

export interface FreightDispatchOutcome {
  readonly snapshot: FreightDispatchSnapshot;
  readonly after: readonly { readonly orderId: string; readonly warehouseId: string; readonly restores: ReadonlyMap<string, number>; readonly followOnOrderId: string | null }[];
}

interface NormalizedConsignmentInput {
  readonly orderId: string;
  readonly decision: 'dispatch' | 'leave';
  readonly lrNumber: string | null;
  readonly lrDate: string | null;
  readonly freightTerms: string | null;
  readonly unscannedAcknowledged: boolean;
}

interface NormalizedDispatch {
  readonly warehouseId: string | null;
  readonly vehicleNumber: string;
  readonly vehicleType: string | null;
  readonly containerNumber: string | null;
  readonly driverName: string;
  readonly driverPhone: string | null;
  readonly driverLicenceNumber: string | null;
  readonly seals: readonly string[];
  readonly departedAt: string | null;
  readonly occurredAt: string | null;
  readonly ewayPartBConfirmed: boolean;
  readonly overCapacityAcknowledged: boolean;
  readonly consignments: readonly NormalizedConsignmentInput[];
  readonly photoRefs: readonly string[];
  readonly note: string | null;
}

/**
 * The departure hash's ONE builder (D20: 4-10a extends it with a conditional
 * key). Normalised, absent as null, consignments sorted by order id, seals
 * and photo refs sorted, `ewayPartBConfirmed` false when absent.
 */
export function freightDispatchHashInput(tenantId: string, surface: 'web' | 'device', loadId: string, input: NormalizedDispatch): Record<string, unknown> {
  return {
    arm: 'freight-dispatch',
    surface,
    tenantId,
    loadId,
    warehouseId: input.warehouseId,
    vehicleNumber: input.vehicleNumber,
    vehicleType: input.vehicleType,
    containerNumber: input.containerNumber,
    driverName: input.driverName,
    driverPhone: input.driverPhone,
    driverLicenceNumber: input.driverLicenceNumber,
    seals: [...input.seals].sort(),
    departedAt: input.departedAt,
    occurredAt: input.occurredAt,
    ewayPartBConfirmed: input.ewayPartBConfirmed,
    overCapacityAcknowledged: input.overCapacityAcknowledged,
    note: input.note,
    consignments: [...input.consignments]
      .sort((a, b) => (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0))
      .map((c) => ({ orderId: c.orderId, decision: c.decision, lrNumber: c.lrNumber, lrDate: c.lrDate, freightTerms: c.freightTerms, unscannedAcknowledged: c.unscannedAcknowledged })),
    photoRefs: input.photoRefs.length === 0 ? null : [...input.photoRefs].sort(),
  };
}

function normalizeDispatch(command: DispatchFreightLoadCommand): NormalizedDispatch {
  const surface = command.surface.kind;
  const vehicleNumber = normalizeVehicle(command.vehicleNumber);
  if (vehicleNumber === null) throw validation('vehicleNumber is required — the truck that leaves.');
  const driverName = optionalText(command.driverName, 'driverName', FREIGHT_LIMITS.driverName);
  if (driverName === null) throw validation('driverName is required — who drives the truck.');
  let warehouseId: string | null = null;
  if (surface === 'device') {
    if (typeof command.warehouseId !== 'string' || !UUID_RE.test(command.warehouseId)) throw validation('warehouseId is required on the device (its snapshot’s warehouse).');
    warehouseId = command.warehouseId.toLowerCase();
  }
  const departedAt = optionalInstant(command.departedAt, 'departedAt');
  if (surface === 'device' && departedAt !== null) throw validation('departedAt is the web’s — the handheld sends occurredAt.');
  const occurredAt = optionalInstant(command.occurredAt, 'occurredAt');
  if (surface === 'web' && occurredAt !== null) throw validation('occurredAt is the handheld’s — the web sends departedAt.');
  if (surface === 'device' && occurredAt === null) throw validation('occurredAt is required on the device — when the truck left.');
  const raw = command.consignments;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > FREIGHT_LIMITS.consignments) {
    throw validation(`consignments must list 1–${FREIGHT_LIMITS.consignments} orders with a decision each.`);
  }
  const seen = new Set<string>();
  const consignments = raw.map((entry, index): NormalizedConsignmentInput => {
    const orderId = typeof entry?.orderId === 'string' ? entry.orderId.toLowerCase() : '';
    if (!UUID_RE.test(orderId)) throw validation(`consignments[${index}].orderId must be a uuid.`);
    if (seen.has(orderId)) throw validation(`consignments[${index}]: order ${orderId} is listed twice.`);
    seen.add(orderId);
    if (entry.decision !== 'dispatch' && entry.decision !== 'leave') throw validation(`consignments[${index}].decision must be dispatch or leave.`);
    const lr = normalizeLrInput(entry, `consignments[${index}]`);
    if (entry.unscannedAcknowledged !== undefined && entry.unscannedAcknowledged !== null && typeof entry.unscannedAcknowledged !== 'boolean') {
      throw validation(`consignments[${index}].unscannedAcknowledged must be a boolean.`);
    }
    return { orderId, decision: entry.decision, ...lr, unscannedAcknowledged: entry.unscannedAcknowledged === true };
  });
  if (!consignments.some((c) => c.decision === 'dispatch')) {
    throw validation('At least one order must be dispatched — to send none, cancel the load instead.');
  }
  for (const flag of ['ewayPartBConfirmed', 'overCapacityAcknowledged'] as const) {
    const value = command[flag];
    if (value !== undefined && value !== null && typeof value !== 'boolean') throw validation(`${flag} must be a boolean.`);
  }
  return {
    warehouseId,
    vehicleNumber,
    vehicleType: normalizeVehicleType(command.vehicleType),
    containerNumber: normalizeContainer(command.containerNumber),
    driverName,
    driverPhone: normalizeDriverPhone(command.driverPhone),
    driverLicenceNumber: normalizeLicence(command.driverLicenceNumber),
    seals: normalizeSeals(command.seals),
    departedAt,
    occurredAt,
    ewayPartBConfirmed: command.ewayPartBConfirmed === true,
    overCapacityAcknowledged: command.overCapacityAcknowledged === true,
    consignments,
    photoRefs: normalizePhotoRefs(command.photoRefs, surface),
    note: optionalText(command.note, 'note', FREIGHT_LIMITS.note),
  };
}

/** One consignment the departure judges: its order, its decision and what it carries. */
interface Member {
  readonly consignment: FreightConsignment;
  readonly input: NormalizedConsignmentInput | null;
  /** A42 — a planned consignment the device did not list, with live scans: dispatched, flagged. */
  readonly notOnDeviceList: boolean;
}

@Injectable()
export class FreightDispatchCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(DispatchCommandService) private readonly dispatch: DispatchCommandService,
  ) {}

  private readonly measurements: PackMeasurementsReader = (tx, tenantId, orderIds) => this.inventory.packMeasurementsOfOrdersInTx(tx, tenantId, orderIds);

  async dispatchLoad(command: DispatchFreightLoadCommand, key: string): Promise<FreightDispatchOutcome> {
    const surface = command.surface.kind;
    const loadId = typeof command.loadId === 'string' ? command.loadId.toLowerCase() : '';
    const input = normalizeDispatch(command);
    const payloadHash = hashCommandPayload(freightDispatchHashInput(command.tenantId, surface, loadId, input));
    const actorUserId = command.surface.kind === 'web' ? command.surface.actorUserId : command.surface.operatorUserId;
    const deviceId = command.surface.kind === 'device' ? command.surface.deviceId : null;
    const tenantId = command.tenantId;

    return withTenantTransaction(this.db, tenantId, async (tx): Promise<FreightDispatchOutcome> => {
      // 1. authority (the device: its operator, which locks the device row).
      if (deviceId !== null) await assertDeviceOperatorInTx(tx, tenantId, deviceId, actorUserId);
      assertPermission(await getMemberRoleIn(tx, tenantId, actorUserId), 'dispatch.execute');
      // 2. replay.
      const first = await replayInTx(tx, tenantId, key, payloadHash);
      if (first !== null) return { snapshot: first as FreightDispatchSnapshot, after: [] };
      await assertUnstampedInTx(tx);
      // 3. the load FOR UPDATE; 4. replay again.
      const load = await lockLoadInTx(tx, tenantId, loadId, 'update');
      const second = await replayInTx(tx, tenantId, key, payloadHash);
      if (second !== null) return { snapshot: second as FreightDispatchSnapshot, after: [] };
      if (load === null) throw loadNotFound(loadId);
      if (input.warehouseId !== null && load.warehouseId !== input.warehouseId) throw warehouseMismatch(load);
      // 5. the state.
      const stateRefusal = loadStateRefusal(load);
      if (stateRefusal !== null) throw stateRefusal;

      // One clock.
      const now = nowIso();
      const nowMs = Date.parse(now);
      if (surface === 'web' && input.departedAt !== null) {
        const at = Date.parse(input.departedAt);
        if (at < nowMs - FREIGHT_PAST_MS || at > nowMs + FREIGHT_FUTURE_MS) {
          throw validation('departedAt must be within the last 7 days (and not in the future) — when the truck left.');
        }
      }

      // A59 — the transporter frozen at departure: the web re-asserts the partner.
      let transporter = load.transporterSnapshot as TransporterSnapshotV1 | null;
      let transporterAsserted = false;
      if (load.transporterPartnerId !== null && surface === 'web') {
        transporter = await assertTransporterInTx(tx, tenantId, load.transporterPartnerId, 'a freight load');
        transporterAsserted = true;
      }
      const transporterName = transporter?.name ?? load.transporterName;

      // 6. the live consignments.
      const planned = (await liveConsignmentsOfLoadInTx(tx, tenantId, load.id)).filter((row) => row.status === 'planned');
      const plannedByOrder = new Map(planned.map((row) => [row.orderId, row]));
      if (surface === 'web') {
        const body = input.consignments.map((c) => c.orderId).sort();
        const current = planned.map((row) => row.orderId).sort();
        if (body.join() !== current.join()) {
          throw new ProblemException(
            'freight-members-changed',
            409,
            'The load’s orders changed',
            `The departure lists ${body.length} orders; ${load.code} now carries ${current.length} — reload the list.`,
            { orderIds: planned.map((row) => row.orderId) },
          );
        }
      }
      const listed = new Set(input.consignments.map((c) => c.orderId));
      const absent = planned.filter((row) => !listed.has(row.orderId));
      const absentScans = await loadedScansOfConsignmentsInTx(tx, tenantId, absent.map((row) => row.id));
      const absentWithScans = new Set(absentScans.map((scan) => scan.consignmentId));

      // The members the departure judges, in body order, then the device-absent ones.
      const members: Member[] = [];
      for (const entry of input.consignments) {
        const row = plannedByOrder.get(entry.orderId);
        members.push({ consignment: row ?? missingConsignment(entry.orderId), input: entry, notOnDeviceList: false });
      }
      for (const row of absent) members.push({ consignment: row, input: null, notOnDeviceList: absentWithScans.has(row.id) });
      const dispatching = members.filter((m) => (m.input !== null ? m.input.decision === 'dispatch' : m.notOnDeviceList));

      // 7. the dispatching orders' clients FOR SHARE, in id order.
      const clientIds = [...new Set(dispatching.filter((m) => m.consignment.id !== '').map((m) => m.consignment.clientId))].sort();
      const clientStatus = new Map<string, { status: string; code: string }>();
      for (const clientId of clientIds) {
        const client = await shareLockClientInTx(tx, tenantId, clientId);
        clientStatus.set(clientId, { status: client.status, code: client.code });
      }
      // 8. every member order FOR UPDATE in id order.
      const memberOrderIds = [...new Set(members.map((m) => m.consignment.orderId))].sort();
      const orderRows = memberOrderIds.length === 0
        ? []
        : await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), inArray(orders.id, memberOrderIds))).orderBy(asc(orders.id)).for('update');
      const orderById = new Map(orderRows.map((row) => [row.id, row]));
      // 9. the consignment rows FOR UPDATE in id order, status re-read.
      const consignmentIds = members.map((m) => m.consignment.id).filter((id) => id !== '').sort();
      const lockedRows = consignmentIds.length === 0
        ? []
        : await tx
            .select()
            .from(freightConsignments)
            .where(and(eq(freightConsignments.tenantId, tenantId), inArray(freightConsignments.id, consignmentIds)))
            .orderBy(asc(freightConsignments.id))
            .for('update');
      const lockedById = new Map(lockedRows.map((row) => [row.id, row]));
      // 10. the dispatching orders' live packs FOR SHARE and their live scans.
      const dispatchingOrderIds = [...new Set(dispatching.map((m) => m.consignment.orderId))].sort();
      await shareLockLivePacksInTx(tx, tenantId, dispatchingOrderIds);
      const sets = await packageSetsOfOrdersInTx(tx, tenantId, dispatchingOrderIds, this.measurements);
      const scans = await loadedScansOfConsignmentsInTx(tx, tenantId, members.map((m) => m.consignment.id).filter((id) => id !== ''));
      const scansByConsignment = new Map<string, typeof scans>();
      for (const scan of scans) scansByConsignment.set(scan.consignmentId, [...(scansByConsignment.get(scan.consignmentId) ?? []), scan]);
      // 11. the picked batches of every dispatching order, together, FOR KEY SHARE.
      const batchesByOrder = await this.inventory.pickedBatchRefsOfOrdersInTx(tx, tenantId, dispatchingOrderIds);
      await this.catalog.keyShareLockBatchesInTx(tx, tenantId, [...new Set([...batchesByOrder.values()].flat())]);

      // A54 — departure is never before loading.
      const latestScanMs = scans.reduce((max, scan) => Math.max(max, Date.parse(scan.scannedAt)), 0);
      let dispatchedAt: string;
      if (surface === 'web') {
        const departed = input.departedAt === null ? nowMs : Math.min(Date.parse(input.departedAt), nowMs);
        const floor = Math.max(Date.parse(load.createdAt), latestScanMs, load.vehicleReportedAt === null ? 0 : Date.parse(load.vehicleReportedAt));
        if (departed < floor) throw validation('departedAt is before the load was created, the truck reported or the last package was scanned — the truck left after its loading.');
        dispatchedAt = new Date(departed).toISOString();
      } else {
        // The floor's record, but never before the load existed, the truck reported or the last scan (A54).
        const floor = Math.max(latestScanMs, Date.parse(load.createdAt), load.vehicleReportedAt === null ? 0 : Date.parse(load.vehicleReportedAt));
        dispatchedAt = new Date(Math.min(Math.max(Math.min(Date.parse(input.occurredAt!), nowMs), floor), nowMs)).toISOString();
      }
      const departureIst = istDateOf(dispatchedAt);
      const packs = await this.inventory.packMeasurementsOfOrdersInTx(tx, tenantId, dispatchingOrderIds);
      const occurredAtOf = (orderId: string): string => {
        const pack = packs.get(orderId) ?? null;
        return pack !== null && Date.parse(pack.packedAt) > Date.parse(dispatchedAt) ? new Date(Date.parse(pack.packedAt)).toISOString() : dispatchedAt;
      };

      // ── the per-order classification, in body order ─────────────────────
      const consignmentFacts = await consignmentFactsOfOrderRowsInTx(tx, tenantId, dispatchingOrderIds.map((id) => orderById.get(id)).filter((o): o is Order => o !== undefined));
      const thresholds = new NationalThresholds(tx);
      const todayIst = istDateOf(now);
      const refused: FreightRefusedEntry[] = [];
      const passing: { member: Member; order: Order; set: OrderPackageSet | null; loaded: number; loadException: FreightLoadException | null; complianceException: ConsignmentGateCode | null }[] = [];
      for (const member of dispatching) {
        const orderId = member.consignment.orderId;
        const refuse = (code: FreightDispatchRefusal, detail: string) => refused.push({ orderId, code, detail });
        const locked = member.consignment.id === '' ? undefined : lockedById.get(member.consignment.id);
        const order = orderById.get(orderId);
        const label = order === undefined ? orderId : orderLabelOf(order);
        if (locked === undefined || locked.status !== 'planned' || locked.loadId !== load.id) {
          refuse('consignment-removed', `Order ${label} is no longer on ${load.code}.`);
          continue;
        }
        if (order === undefined) {
          refuse('consignment-removed', `Order ${orderId} is no longer on ${load.code}.`);
          continue;
        }
        if (order.status === 'dispatched') {
          refuse('order-already-dispatched', `Order ${label} was already dispatched.`);
          continue;
        }
        if (order.status !== 'ready_to_dispatch') {
          refuse('order-not-ready', `Order ${label} reads "${order.status}" — only a packed order leaves.`);
          continue;
        }
        const client = clientStatus.get(locked.clientId);
        if (client?.status === 'departed') {
          refuse('client-departed', `Client ${client.code} has departed — order ${label} does not leave here.`);
          continue;
        }
        const set = sets.get(orderId) ?? null;
        const progress = progressOf(scansByConsignment.get(locked.id) ?? [], set);
        let loadException: FreightLoadException | null = member.notOnDeviceList ? 'not-on-device-list' : null;
        if (set !== null && progress.loaded < set.packageCount && loadException === null) {
          if (surface === 'web' && member.input?.unscannedAcknowledged !== true) {
            refuse('packages-not-loaded', `Order ${label}: ${progress.loaded} of ${set.packageCount} packages loaded — scan the rest, or send it with them unscanned.`);
            continue;
          }
          loadException = 'packages-unscanned';
        }
        const recalled = await openLiveRecallLinesForBatchesInTx(tx, tenantId, batchesByOrder.get(orderId) ?? []);
        if (recalled.length > 0) {
          const codes = [...new Set(recalled.map((line) => line.recallCode))].sort();
          refuse('order-holds-recalled-batch', `Order ${label} holds a lot under recall ${codes.join(', ')} — it cannot ship.`);
          continue;
        }
        // 4-6a's gate LAST, once per order, on the dispatch's own date (and on the web also today).
        let complianceException: ConsignmentGateCode | null = null;
        const facts = consignmentFacts.get(orderId)!;
        const day = istDateOf(occurredAtOf(orderId));
        let threshold = await thresholds.on(day);
        let gate = judgeConsignment(facts, threshold, day);
        if (!gate.blocking && surface === 'web' && todayIst !== day) {
          threshold = await thresholds.on(todayIst);
          gate = judgeConsignment(facts, threshold, todayIst);
        }
        if (gate.blocking) {
          if (surface === 'web') {
            refuse(gate.code! as FreightDispatchRefusal, consignmentRefusal(facts, gate, threshold).message);
            continue;
          }
          complianceException = gate.code;
        }
        passing.push({ member: { ...member, consignment: locked }, order, set, loaded: Math.min(progress.loaded, set?.packageCount ?? 0), loadException, complianceException });
      }

      if (surface === 'web' && refused.length > 0) {
        throw freightOrdersRefused(refused, dispatching.length, 'dispatched');
      }

      // A48 / A49 — the LRs: dates and terms only with a number; one LR, one client; the date window.
      // The web refuses a breach (400, nothing written); on the DEVICE the truck has
      // left, so the offending consignment is dispatched WITHOUT its LR (recorded
      // in the audit as `lrDropped`) — never a whole-op refusal after departure.
      const lrOf = (entry: (typeof passing)[number]) => entry.member.input?.lrNumber ?? entry.member.consignment.lrNumber;
      const lrDateOf = (entry: (typeof passing)[number]) => (entry.member.input?.lrNumber != null ? entry.member.input.lrDate : entry.member.consignment.lrDate);
      const lrDropped = new Map<string, { lrNumber: string; reason: string }>();
      const breach = (entry: (typeof passing)[number], detail: string, reason: string): void => {
        if (surface === 'web') throw validation(detail);
        lrDropped.set(entry.order.id, { lrNumber: lrOf(entry)!, reason });
      };
      const firstClientOfLr = new Map<string, string>();
      for (const entry of passing) {
        const lr = lrOf(entry);
        const sent = entry.member.input;
        if (lr === null && sent !== null && (sent.lrDate !== null || sent.freightTerms !== null)) {
          throw validation(`Order ${orderLabelOf(entry.order)}: an LR date or freight terms need the LR number.`);
        }
        if (lr === null) continue;
        const date = lrDateOf(entry);
        if (date !== null && (date > departureIst || date < addIsoDays(departureIst, -30))) {
          breach(entry, `Order ${orderLabelOf(entry.order)}: the LR date must be within 30 days before the departure (${departureIst}).`, 'lr-date-outside-window');
          continue;
        }
        const holder = firstClientOfLr.get(lr);
        if (holder === undefined) firstClientOfLr.set(lr, entry.member.consignment.clientId);
        else if (holder !== entry.member.consignment.clientId) {
          breach(entry, `LR ${lr} is given to orders of more than one client — an LR covers one client's goods.`, 'lr-of-another-client');
        }
      }

      // Part B: any dispatching order's live record holds a recorded e-way bill.
      const records = await liveConsignmentRecordsOfOrdersInTx(tx, tenantId, passing.map((entry) => entry.order.id));
      const ewayOrders = passing
        .map((entry) => ({ orderId: entry.order.id, record: records.get(entry.order.id) }))
        .filter((e) => e.record !== undefined && e.record.ewayStatus === 'recorded')
        .map((e) => ({ orderId: e.orderId, ewayBillNumber: e.record!.ewayBillNumber }));
      if (surface === 'web' && ewayOrders.length > 0 && !input.ewayPartBConfirmed) {
        throw new ProblemException(
          'eway-part-b-unconfirmed',
          409,
          'Update the e-way bills with the vehicle',
          `${ewayOrders.length} order(s) carry an e-way bill — update Part B with vehicle ${input.vehicleNumber} on the e-way portal, then confirm it here.`,
          { orders: ewayOrders, vehicleNumber: input.vehicleNumber },
        );
      }
      // Stamped only when some dispatching order holds a recorded e-way bill.
      const partBConfirmed = input.ewayPartBConfirmed && ewayOrders.length > 0;

      // A66 — capacity.
      const weights = passing.map((entry) => entry.set?.grossWeightGrams ?? null);
      const weightKnown = passing.length > 0 && weights.every((w) => w !== null);
      const grossWeightGrams = weightKnown ? weights.reduce<number>((sum, w) => sum + (w ?? 0), 0) : null;
      const capacityExceeded = grossWeightGrams !== null && load.vehicleCapacityKg !== null && grossWeightGrams > load.vehicleCapacityKg * 1000;
      if (surface === 'web' && capacityExceeded && !input.overCapacityAcknowledged) {
        throw new ProblemException(
          'load-over-capacity',
          409,
          'Over the stated capacity',
          `The truck carries ${(grossWeightGrams! / 1000).toLocaleString('en-IN')} kg against a stated capacity of ${load.vehicleCapacityKg!.toLocaleString('en-IN')} kg — acknowledge to send it.`,
          { grossWeightGrams, capacityKg: load.vehicleCapacityKg },
        );
      }

      // ── the writes ───────────────────────────────────────────────────────
      const left: { orderId: string; reason: string }[] = [];
      // 1. leave decisions, device-absent without scans, and (A41) device-refused orders → removed.
      const leaveIds = members.filter((m) => m.input?.decision === 'leave' && m.consignment.id !== '').map((m) => m.consignment);
      const absentIds = members.filter((m) => m.input === null && !m.notOnDeviceList).map((m) => m.consignment);
      const removedOrderIds: string[] = [];
      const removedReasons = new Map<string, string>();
      for (const [rows, reason] of [
        [leaveIds, FREIGHT_REASONS.leftAtDeparture],
        [absentIds, FREIGHT_REASONS.notOnDeviceList],
      ] as const) {
        const { removed } = await removeConsignmentsInTx(tx, { tenantId, consignmentIds: rows.map((r) => r.id), actorUserId, reason, at: now });
        for (const row of rows) {
          if (!removed.includes(row.id)) continue;
          left.push({ orderId: row.orderId, reason });
          removedOrderIds.push(row.orderId);
        }
      }
      for (const entry of refused) {
        const member = members.find((m) => m.consignment.orderId === entry.orderId && m.consignment.id !== '');
        if (member === undefined) continue;
        const reason = `Not dispatched at departure: ${entry.code}`;
        const { removed } = await removeConsignmentsInTx(tx, { tenantId, consignmentIds: [member.consignment.id], actorUserId, reason, at: now });
        if (removed.length === 0) continue;
        // A41 — not in `left` (the answer's `refused` names it), but audited as a removal like the others.
        removedReasons.set(entry.orderId, reason);
        removedOrderIds.push(entry.orderId);
      }

      // One `freight_load.order_removed` row per consignment the departure removed (left, absent, refused).
      const auditRemovals = async (): Promise<void> => {
        for (const orderId of removedOrderIds) {
          await tx.insert(auditEvents).values({
            id: uuidv7(),
            tenantId,
            actorUserId,
            action: 'freight_load.order_removed',
            targetType: 'freight_load',
            targetId: load.id,
            reference: key,
            changes: { orderId, reason: removedReasons.get(orderId) ?? left.find((l) => l.orderId === orderId)?.reason ?? null, atDeparture: true },
            occurredAt: now,
          });
        }
      };

      let rejectedOpId: string | null = null;
      if (refused.length > 0 && deviceId !== null) {
        const opId = derivedOpId(key, 'freight-refused');
        await recordServerRejectedOpInTx(tx, this.outbox, {
          tenantId,
          deviceId,
          operatorUserId: actorUserId,
          opId,
          opType: 'freight.dispatch',
          problemCode: 'freight-orders-refused',
          problemDetail:
            passing.length === 0
              ? `Every order on ${load.code} physically left with vehicle ${input.vehicleNumber}, but none could be dispatched (${[...new Set(refused.map((r) => r.code))].join(', ')}) — the load was closed; record each order on the web.`
              : `${refused.length} order(s) left on ${load.code} with vehicle ${input.vehicleNumber} but were not dispatched (${[...new Set(refused.map((r) => r.code))].join(', ')}) — they were taken off the load.`,
          payload: {
            loadId: load.id,
            loadCode: load.code,
            vehicleNumber: input.vehicleNumber,
            driverName: input.driverName,
            seals: [...input.seals],
            occurredAt: input.occurredAt,
            consignments: refused.map((r) => ({ ...(input.consignments.find((c) => c.orderId === r.orderId) ?? { orderId: r.orderId, decision: 'dispatch' }) })),
            photoRefs: [...input.photoRefs],
            refusals: refused.map((r) => ({ orderId: r.orderId, code: r.code, detail: r.detail })),
          },
          occurredAt: dispatchedAt,
        });
        rejectedOpId = opId;
      }

      const vehicleFacts = {
        vehicleNumber: input.vehicleNumber,
        vehicleType: input.vehicleType ?? load.vehicleType,
        containerNumber: input.containerNumber ?? load.containerNumber,
        driverName: input.driverName,
        driverPhone: input.driverPhone ?? load.driverPhone,
        driverLicenceNumber: input.driverLicenceNumber ?? load.driverLicenceNumber,
        seals: [...input.seals],
      };

      // A50 — a device departure that dispatches nothing still closes the load.
      if (passing.length === 0) {
        const reason = [...`Departed with no dispatchable order — see review ${rejectedOpId ?? ''}`.trim()].slice(0, FREIGHT_LIMITS.reason).join('');
        const [closed] = await tx
          .update(freightLoads)
          .set({ ...vehicleFacts, status: 'cancelled', cancelledAt: now, cancelledBy: actorUserId, cancelReason: reason, updatedAt: now, ...(input.note === null ? {} : { note: input.note }) })
          .where(and(eq(freightLoads.tenantId, tenantId), eq(freightLoads.id, load.id), eq(freightLoads.status, 'open')))
          .returning();
        await this.claimPhotos(tx, tenantId, deviceId, load.id, load.warehouseId, actorUserId, input.photoRefs);
        await this.outbox.append(tx, { messageId: uuidv7(), tenantId, type: 'freight_load.cancelled', occurredAt: now, payload: { loadId: load.id, code: load.code, orderIds: [] } });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId,
          actorUserId,
          action: 'freight_load.cancelled',
          targetType: 'freight_load',
          targetId: load.id,
          reference: key,
          changes: { status: { before: 'open', after: 'cancelled' }, reason, departure: true, refused: refused.map((r) => ({ orderId: r.orderId, code: r.code })), left },
          occurredAt: now,
        });
        await auditRemovals();
        await this.assertNoPlanned(tx, tenantId, load.id);
        if (deviceId !== null) await touchDeviceInTx(tx, deviceId);
        const snapshot: FreightDispatchSnapshot = { load: (await freightLoadViewInTx(tx, tenantId, closed!, { unmask: true, todayIst, measurements: this.measurements })).view, dispatched: [], left, refused, rejectedOpId };
        await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
        return { snapshot, after: [] };
      }

      // The parties the documents print, frozen now (A63, A65).
      const party = await invoicePartyFactsInTx(tx, tenantId, load.warehouseId);
      const warehouseSnapshot = {
        v: 1,
        ...documentWarehousePartyOf({ code: await getWarehouseCodeInTx(tx, tenantId, load.warehouseId), name: party.warehouseName, gstin: party.warehouseGstin, originAddress: party.originAddress }),
      };
      const transporterParty = {
        name: transporterName,
        gstin: transporter?.gstin ?? null,
        address: transporter?.registeredAddress ?? null,
      };
      const clientParties = new Map<string, ClientPartySnapshotV1>();
      const dispatched: FreightDispatchedEntry[] = [];
      const after: { orderId: string; warehouseId: string; restores: ReadonlyMap<string, number>; followOnOrderId: string | null }[] = [];
      const loadExceptions: { orderId: string; code: string }[] = [];
      const complianceExceptions: { orderId: string; code: string }[] = [];
      const consignmentPayload: { consignmentId: string; orderId: string; clientId: string; lrNumber: string | null }[] = [];
      for (const entry of passing) {
        const { order, set } = entry;
        const consignment = entry.member.consignment;
        const occurredAt = occurredAtOf(order.id);
        let client: ClientPartySnapshotV1 | null = set?.packClientParty ?? null;
        if (client === null) {
          client = clientParties.get(order.clientId) ?? clientPartySnapshotOf(await getClientInTx(tx, tenantId, order.clientId));
          clientParties.set(order.clientId, client);
        }
        const sent = entry.member.input;
        const dropped = lrDropped.has(order.id);
        const lrNumber = dropped ? null : (sent?.lrNumber ?? consignment.lrNumber);
        const carriage: CarriageSnapshotV1 = {
          v: 1,
          loadCode: load.code,
          consignmentRef: consignmentRef(load.code, consignment.stopSeq),
          mode: load.mode,
          transporterName,
          transporterGstin: transporterParty.gstin,
          transporter: transporterParty,
          vehicleNumber: input.vehicleNumber,
          vehicleType: vehicleFacts.vehicleType,
          containerNumber: vehicleFacts.containerNumber,
          driverName: input.driverName,
          seals: [...input.seals],
          dispatchedAt: occurredAt,
          warehouse: warehouseSnapshot,
        };
        // 2. the consignment.
        await tx
          .update(freightConsignments)
          .set({
            ...(dropped
              ? { lrNumber: null, lrDate: null, freightTerms: null, lrRecordedAt: null, lrRecordedBy: null }
              : sent?.lrNumber != null
                ? { lrNumber: sent.lrNumber, lrDate: sent.lrDate, freightTerms: sent.freightTerms, lrRecordedAt: now, lrRecordedBy: actorUserId }
                : {}),
            status: 'dispatched',
            dispatchedAt: occurredAt,
            packageCount: set?.packageCount ?? 1,
            palletCount: set?.palletCount ?? 0,
            loadedPackageCount: entry.loaded,
            weightGrams: set?.grossWeightGrams ?? null,
            loadException: entry.loadException,
            complianceException: entry.complianceException,
            clientSnapshot: client,
            carriageSnapshot: carriage,
            updatedAt: now,
          })
          .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.id, consignment.id), eq(freightConsignments.status, 'planned')));
        // 3. the order, through the shared dispatch body.
        const result = await this.dispatch.dispatchOrderInTx(tx, {
          tenantId,
          order,
          actorUserId,
          carrierName: transporterName,
          trackingNumber: lrNumber,
          occurredAt,
          recordedAt: now,
          batchesLocked: true,
          idempotencyKey: key,
          handoverId: null,
          // Judged once, in the classification above (4-6a A32).
          consignment: 'pre-checked',
          complianceException: entry.complianceException,
        });
        dispatched.push({
          orderId: order.id,
          consignmentId: consignment.id,
          lrNumber,
          loadException: entry.loadException,
          complianceException: entry.complianceException,
          followOnOrderId: result.followOnOrderId,
        });
        if (entry.loadException !== null) loadExceptions.push({ orderId: order.id, code: entry.loadException });
        if (entry.complianceException !== null) complianceExceptions.push({ orderId: order.id, code: entry.complianceException });
        consignmentPayload.push({ consignmentId: consignment.id, orderId: order.id, clientId: consignment.clientId, lrNumber });
        after.push({ orderId: order.id, warehouseId: order.warehouseId, restores: result.counterRestores, followOnOrderId: result.followOnOrderId });
      }

      // 4. the load.
      const packageCount = passing.reduce((sum, entry) => sum + (entry.set?.packageCount ?? 1), 0);
      const earliestScan = scans.length === 0 ? null : scans.reduce((min, scan) => (Date.parse(scan.scannedAt) < Date.parse(min) ? scan.scannedAt : min), scans[0]!.scannedAt);
      const [departed] = await tx
        .update(freightLoads)
        .set({
          ...vehicleFacts,
          status: 'dispatched',
          transporterSnapshot: transporter,
          transporterName,
          dispatchedAt,
          dispatchedBy: actorUserId,
          dispatchSource: surface === 'web' ? 'web' : 'handheld',
          dispatchDeviceId: deviceId,
          dispatchedOrderCount: passing.length,
          packageCount,
          grossWeightGrams,
          warehouseSnapshot,
          capacityExceeded,
          ...(partBConfirmed ? { ewayPartBConfirmedAt: now, ewayPartBConfirmedBy: actorUserId } : {}),
          ...(load.loadingStartedAt === null && earliestScan !== null ? { loadingStartedAt: earliestScan } : {}),
          ...(input.note === null ? {} : { note: input.note }),
          updatedAt: now,
        })
        .where(and(eq(freightLoads.tenantId, tenantId), eq(freightLoads.id, load.id), eq(freightLoads.status, 'open')))
        .returning();
      // 5. the device's sheet photos.
      await this.claimPhotos(tx, tenantId, deviceId, load.id, load.warehouseId, actorUserId, input.photoRefs);
      // 6. outbox (no consumer: the relay acks it — the 2-8b precedent).
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId,
        type: 'freight_load.dispatched',
        occurredAt: dispatchedAt,
        payload: { loadId: load.id, code: load.code, warehouseId: load.warehouseId, dispatchedAt, consignments: consignmentPayload },
      });
      // 7. audit.
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId,
        action: 'freight_load.dispatched',
        targetType: 'freight_load',
        targetId: load.id,
        reference: key,
        changes: {
          code: load.code,
          decisions: input.consignments.map((c) => ({ orderId: c.orderId, decision: c.decision })),
          dispatched: passing.map((entry) => entry.order.id),
          ...(loadExceptions.length === 0 ? {} : { loadExceptions }),
          ...(complianceExceptions.length === 0 ? {} : { complianceExceptions }),
          ...(refused.length === 0 ? {} : { refused: refused.map((r) => ({ orderId: r.orderId, code: r.code })) }),
          partBConfirmed,
          capacityExceeded,
          ...(lrDropped.size === 0 ? {} : { lrDropped: [...lrDropped].map(([orderId, drop]) => ({ orderId, ...drop })) }),
          ...(load.transporterPartnerId !== null && !transporterAsserted ? { transporterSnapshotKept: true } : {}),
        },
        occurredAt: now,
      });
      await auditRemovals();
      // A41 — no planned consignment survives a departure.
      await this.assertNoPlanned(tx, tenantId, load.id);
      if (deviceId !== null) await touchDeviceInTx(tx, deviceId);
      const snapshot: FreightDispatchSnapshot = {
        load: (await freightLoadViewInTx(tx, tenantId, departed!, { unmask: true, todayIst, measurements: this.measurements })).view,
        dispatched,
        left,
        refused,
        rejectedOpId,
      };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return { snapshot, after };
    });
  }

  private async claimPhotos(tx: TenantTx, tenantId: string, deviceId: string | null, loadId: string, warehouseId: string, actorUserId: string, refs: readonly string[]): Promise<void> {
    if (deviceId === null || refs.length === 0) return;
    await claimOwnedRefsInTx(tx, {
      tenantId,
      deviceId,
      ownerType: 'freight_load',
      ownerId: loadId,
      purpose: 'loading-sheet',
      clientId: null,
      warehouseId,
      actorUserId,
      refs,
    });
  }

  private async assertNoPlanned(tx: TenantTx, tenantId: string, loadId: string): Promise<void> {
    const rows = (await tx.execute(
      sql`select count(*)::int as n from freight_consignments where tenant_id = ${tenantId}::uuid and load_id = ${loadId}::uuid and status = 'planned'`,
    )) as unknown as { n: number }[];
    if (Number(rows[0]?.n ?? 0) !== 0) {
      throw new Error(`A41: a departure of load ${loadId} left ${rows[0]!.n} planned consignment(s) behind.`);
    }
  }
}

/** A body order with no planned consignment on the load (device: `consignment-removed`). */
function missingConsignment(orderId: string): FreightConsignment {
  return { id: '', orderId, clientId: '', status: 'removed', loadId: '' } as unknown as FreightConsignment;
}
