import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, freightConsignments, freightLoads, orders, type FreightConsignment } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { addIsoDays, canonicalInstant, istDateOf, nowIso } from '../../shared/primitives/time';
import { consignmentRef, DELIVERY_OUTCOMES, FREIGHT_LIMITS, type DeliveryOutcome } from '../../shared/primitives/freight';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission, ROLE_CAPABILITIES } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { replayInTx, validation, writeKeyInTx } from './shipping-support';
import { FREIGHT_FUTURE_MS, normalizeLrInput, optionalInstant, optionalText } from './freight-support';
import { deliveryViewOf, type CarriageSnapshotV1, type FreightDeliveryView } from './freight.read';

/**
 * Story 4-9a (A16, A17, A48, A49) — a consignment's LR (captured, never
 * issued — D5) and its proof of delivery (a fact on the consignment; the
 * order stays `dispatched`). Lock order: the load (A49: two LR records
 * serialise), the order FOR SHARE, the consignment FOR UPDATE.
 */

export interface FreightConsignmentSnapshotView {
  readonly id: string;
  readonly orderId: string;
  readonly loadId: string;
  readonly status: string;
  readonly consignmentRef: string;
  readonly lr: { readonly number: string | null; readonly date: string | null; readonly terms: string | null };
  readonly delivery: FreightDeliveryView | null;
}

export interface FreightConsignmentSnapshot {
  readonly consignment: FreightConsignmentSnapshotView;
  /** Present (true) only on the unchanged no-op (the 200). */
  readonly unchanged?: true;
}

export interface RecordFreightLrCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly consignmentId: string;
  readonly lrNumber?: string | null;
  readonly lrDate?: string | null;
  readonly freightTerms?: string | null;
  readonly reason?: string | null;
}

export interface RecordFreightDeliveryCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly consignmentId: string;
  readonly outcome: string | undefined;
  readonly deliveredAt: string | undefined;
  readonly receiverName?: string | null;
  readonly shortPackageCount?: number | null;
  readonly damagedPackageCount?: number | null;
  readonly note?: string | null;
  readonly reason?: string | null;
}

function viewOf(row: FreightConsignment, loadCode: string): FreightConsignmentSnapshotView {
  return {
    id: row.id,
    orderId: row.orderId,
    loadId: row.loadId,
    status: row.status,
    consignmentRef: consignmentRef(loadCode, row.stopSeq),
    lr: { number: row.lrNumber, date: row.lrDate, terms: row.freightTerms },
    delivery: deliveryViewOf(row),
  };
}

function consignmentNotFound(id: string): ProblemException {
  return new ProblemException('not-found', 404, 'Consignment not found', `No freight consignment with id "${id}" exists in this tenant.`);
}

@Injectable()
export class FreightConsignmentCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  /** The consignment (no lock) → its load FOR UPDATE → its order FOR SHARE → the consignment FOR UPDATE. */
  private async lockChainInTx(tx: TenantTx, tenantId: string, consignmentId: string, loadLock: boolean) {
    if (!UUID_RE.test(consignmentId)) return null;
    const plain = await tx
      .select()
      .from(freightConsignments)
      .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.id, consignmentId)))
      .limit(1);
    const found = plain[0];
    if (found === undefined) return null;
    const loadQuery = tx.select().from(freightLoads).where(and(eq(freightLoads.tenantId, tenantId), eq(freightLoads.id, found.loadId))).limit(1);
    const load = (loadLock ? await loadQuery.for('update') : await loadQuery)[0]!;
    const order = (await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.id, found.orderId))).limit(1).for('share'))[0]!;
    const row = (
      await tx
        .select()
        .from(freightConsignments)
        .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.id, consignmentId)))
        .limit(1)
        .for('update')
    )[0]!;
    return { load, order, row };
  }

  // ── A16: the LR ───────────────────────────────────────────────────────

  async recordLr(command: RecordFreightLrCommand, key: string): Promise<FreightConsignmentSnapshot> {
    const consignmentId = command.consignmentId.toLowerCase();
    const lr = normalizeLrInput(command, 'lr');
    const lrNumber = lr.lrNumber;
    if (lrNumber === null) throw validation('lrNumber is required — the transporter’s LR number.');
    const reason = optionalText(command.reason, 'reason', FREIGHT_LIMITS.reason);
    const payloadHash = hashCommandPayload({ arm: 'freight-lr', tenantId: command.tenantId, consignmentId, lrNumber: lr.lrNumber, lrDate: lr.lrDate, freightTerms: lr.freightTerms, reason });
    const tenantId = command.tenantId;
    return withTenantTransaction(this.db, tenantId, async (tx): Promise<FreightConsignmentSnapshot> => {
      assertPermission(await getMemberRoleIn(tx, tenantId, command.actorUserId), 'dispatch.execute');
      const first = await replayInTx(tx, tenantId, key, payloadHash);
      if (first !== null) return first as FreightConsignmentSnapshot;
      const chain = await this.lockChainInTx(tx, tenantId, consignmentId, true);
      const second = await replayInTx(tx, tenantId, key, payloadHash);
      if (second !== null) return second as FreightConsignmentSnapshot;
      if (chain === null) throw consignmentNotFound(consignmentId);
      const { load, order, row } = chain;
      if (row.status === 'removed') {
        throw new ProblemException('consignment-removed', 409, 'The order left the load', `Order ${orderLabelOf(order)} was removed from ${load.code} — its LR is not recorded.`);
      }
      // A49 — the date window: the departure's IST date (before departure, today's).
      const now = nowIso();
      const anchor = istDateOf(row.dispatchedAt ?? now);
      if (lr.lrDate !== null && (lr.lrDate > anchor || lr.lrDate < addIsoDays(anchor, -30))) {
        throw validation(`lrDate must be within 30 days before ${row.status === 'dispatched' ? 'the departure' : 'today'} (${anchor}).`);
      }
      // A49 — one LR, one client, on this load.
      const holders = await tx
        .select({ clientId: freightConsignments.clientId })
        .from(freightConsignments)
        .where(
          and(
            eq(freightConsignments.tenantId, tenantId),
            eq(freightConsignments.loadId, load.id),
            eq(freightConsignments.lrNumber, lrNumber),
            ne(freightConsignments.status, 'removed'),
            ne(freightConsignments.id, row.id),
          ),
        );
      if (holders.some((holder) => holder.clientId !== row.clientId)) {
        throw validation(`LR ${lr.lrNumber} is already given to another client's order on ${load.code} — an LR covers one client's goods.`);
      }
      if (row.lrNumber === lr.lrNumber && row.lrDate === lr.lrDate && row.freightTerms === lr.freightTerms) {
        const snapshot: FreightConsignmentSnapshot = { consignment: viewOf(row, load.code), unchanged: true };
        await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
        return snapshot;
      }
      if (row.status === 'dispatched' && reason === null) {
        throw validation('reason is required to change the LR after departure.');
      }
      const [updated] = await tx
        .update(freightConsignments)
        .set({ lrNumber: lr.lrNumber, lrDate: lr.lrDate, freightTerms: lr.freightTerms, lrRecordedAt: now, lrRecordedBy: command.actorUserId, updatedAt: now })
        .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.id, row.id)))
        .returning();
      if (row.status === 'dispatched') {
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId,
          type: 'freight_consignment.lr_recorded',
          occurredAt: now,
          payload: { consignmentId: row.id, orderId: row.orderId, clientId: row.clientId, lrNumber: lr.lrNumber, previous: row.lrNumber },
        });
      }
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: command.actorUserId,
        action: 'freight_consignment.lr_recorded',
        targetType: 'order',
        targetId: row.orderId,
        reference: key,
        changes: {
          consignmentId: row.id,
          loadCode: load.code,
          lrNumber: { before: row.lrNumber, after: lr.lrNumber },
          lrDate: { before: row.lrDate, after: lr.lrDate },
          freightTerms: { before: row.freightTerms, after: lr.freightTerms },
          ...(reason === null ? {} : { reason }),
          afterDeparture: row.status === 'dispatched',
        },
        occurredAt: now,
      });
      const snapshot: FreightConsignmentSnapshot = { consignment: viewOf(updated!, load.code) };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── A17: proof of delivery ────────────────────────────────────────────

  async recordDelivery(command: RecordFreightDeliveryCommand, key: string): Promise<FreightConsignmentSnapshot> {
    const consignmentId = command.consignmentId.toLowerCase();
    if (typeof command.outcome !== 'string' || !(DELIVERY_OUTCOMES as readonly string[]).includes(command.outcome)) {
      throw validation(`outcome must be one of ${DELIVERY_OUTCOMES.join(', ')}.`);
    }
    const outcome = command.outcome as DeliveryOutcome;
    const deliveredAt = optionalInstant(command.deliveredAt, 'deliveredAt');
    if (deliveredAt === null) throw validation('deliveredAt is required — when the consignee received the goods.');
    const count = (value: unknown, field: string): number | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 200) throw validation(`${field} must be a whole number, 0–200.`);
      return value;
    };
    const shortPackageCount = count(command.shortPackageCount, 'shortPackageCount');
    const damagedPackageCount = count(command.damagedPackageCount, 'damagedPackageCount');
    const receiverName = optionalText(command.receiverName, 'receiverName', FREIGHT_LIMITS.receiverName);
    const note = optionalText(command.note, 'note', FREIGHT_LIMITS.note);
    const reason = optionalText(command.reason, 'reason', FREIGHT_LIMITS.reason);
    const exceptions = (shortPackageCount ?? 0) + (damagedPackageCount ?? 0);
    if (outcome === 'delivered' && exceptions > 0) throw validation('A delivery with short or damaged packages is "delivered-with-exceptions".');
    if (outcome === 'delivered-with-exceptions' && (note === null || exceptions < 1)) {
      throw validation('Delivered with exceptions needs the short or damaged count (at least 1) and a note.');
    }
    if (outcome === 'refused' && note === null) throw validation('A refused delivery needs a note — why the consignee refused it.');
    const payloadHash = hashCommandPayload({
      arm: 'freight-delivery',
      tenantId: command.tenantId,
      consignmentId,
      outcome,
      deliveredAt,
      receiverName,
      shortPackageCount,
      damagedPackageCount,
      note,
      reason,
    });
    const tenantId = command.tenantId;
    return withTenantTransaction(this.db, tenantId, async (tx): Promise<FreightConsignmentSnapshot> => {
      const role = await getMemberRoleIn(tx, tenantId, command.actorUserId);
      assertPermission(role, 'dispatch.execute');
      const first = await replayInTx(tx, tenantId, key, payloadHash);
      if (first !== null) return first as FreightConsignmentSnapshot;
      const chain = await this.lockChainInTx(tx, tenantId, consignmentId, false);
      const second = await replayInTx(tx, tenantId, key, payloadHash);
      if (second !== null) return second as FreightConsignmentSnapshot;
      if (chain === null) throw consignmentNotFound(consignmentId);
      const { load, order, row } = chain;
      // 1. dispatched only.
      if (row.status !== 'dispatched') {
        throw new ProblemException('consignment-not-dispatched', 409, 'Not dispatched', `Order ${orderLabelOf(order)} has not left on ${load.code} — a delivery is recorded after the truck leaves.`);
      }
      // 2. one clock.
      const now = nowIso();
      if (Date.parse(deliveredAt) < Date.parse(row.dispatchedAt!)) throw validation('deliveredAt is before the truck left.');
      if (Date.parse(deliveredAt) > Date.parse(now) + FREIGHT_FUTURE_MS) throw validation('deliveredAt is in the future.');
      // 3. the counts.
      if (exceptions > (row.packageCount ?? 0)) throw validation(`Short plus damaged (${exceptions}) is more than the ${row.packageCount} packages sent.`);
      // 4. an existing delivery: unchanged → the no-op; changed → an office amendment.
      const amended = row.deliveryOutcome !== null;
      if (amended) {
        const same =
          row.deliveryOutcome === outcome &&
          canonicalInstant(row.deliveredAt!) === canonicalInstant(deliveredAt) &&
          row.receiverName === receiverName &&
          row.shortPackageCount === shortPackageCount &&
          row.damagedPackageCount === damagedPackageCount &&
          row.deliveryNote === note;
        if (same) {
          const snapshot: FreightConsignmentSnapshot = { consignment: viewOf(row, load.code), unchanged: true };
          await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
          return snapshot;
        }
        if (!ROLE_CAPABILITIES[role].has('orders.manage')) {
          throw new ProblemException('role-denied', 403, 'Role lacks the required capability', 'Only an office role can amend a recorded delivery.');
        }
        if (reason === null) throw validation('reason is required to amend a recorded delivery.');
        if (row.deliverySeq >= FREIGHT_LIMITS.deliverySeqMax) {
          throw new ProblemException('delivery-amend-limit', 409, 'Too many amendments', `This delivery was amended ${row.deliverySeq - 1} times — at most ${FREIGHT_LIMITS.deliverySeqMax - 1}.`);
        }
      }
      const [updated] = await tx
        .update(freightConsignments)
        .set({
          deliveryOutcome: outcome,
          deliveredAt,
          receiverName,
          shortPackageCount,
          damagedPackageCount,
          deliveryNote: note,
          deliverySeq: row.deliverySeq + 1,
          deliveryRecordedAt: now,
          deliveryRecordedBy: command.actorUserId,
          updatedAt: now,
        })
        .where(and(eq(freightConsignments.tenantId, tenantId), eq(freightConsignments.id, row.id)))
        .returning();
      const carriage = row.carriageSnapshot as CarriageSnapshotV1;
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId,
        type: 'freight_consignment.delivered',
        occurredAt: now,
        payload: {
          consignmentId: row.id,
          orderId: row.orderId,
          clientId: row.clientId,
          warehouseId: row.warehouseId,
          deliverySeq: updated!.deliverySeq,
          outcome,
          deliveredAt,
          receiverName,
          shortPackageCount,
          damagedPackageCount,
          note,
          lrNumber: row.lrNumber,
          transporterName: carriage.transporterName,
          vehicleNumber: carriage.vehicleNumber,
          dispatchedAt: canonicalInstant(row.dispatchedAt!),
          consignmentRef: carriage.consignmentRef,
          consigneeCity: order.destinationCity,
          amended,
          recordedAt: now,
        },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: command.actorUserId,
        action: 'freight_consignment.delivery_recorded',
        targetType: 'order',
        targetId: row.orderId,
        reference: key,
        changes: {
          consignmentId: row.id,
          deliverySeq: updated!.deliverySeq,
          before: deliveryViewOf(row),
          after: { outcome, deliveredAt, receiverName, short: shortPackageCount, damaged: damagedPackageCount, note },
          ...(reason === null ? {} : { reason }),
        },
        occurredAt: now,
      });
      const snapshot: FreightConsignmentSnapshot = { consignment: viewOf(updated!, load.code) };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }
}
