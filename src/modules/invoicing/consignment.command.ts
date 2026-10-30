import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, orderConsignmentRecords } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK, type OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { istDateOf } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { assertBrandDocumentDateWindow, gstinStateCode } from '../../shared/primitives/consignment-capture';
import {
  CONSIGNMENT_RECORD_LIMITS,
  assertConsignmentRecordShape,
  formatRupees,
  normalizeConsignmentRecordInput,
  type ConsignmentEwayStatus,
  type ConsignmentRecordInput,
  type NormalizedConsignmentRecord,
  type ValidConsignmentRecord,
} from '../../shared/primitives/consignment-record';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { ROLE_CAPABILITIES, assertPermission } from '../tenancy/permissions';
import { getMemberPortalFactsIn, getMemberRoleIn, invoicePartyFactsInTx } from '../tenancy/tenancy.service';
import { clientPartySnapshotOf, getClientInTx, shareLockClientInTx } from '../clients/clients.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import { InvoicingFacade } from './facade';
import {
  consignmentHistoryOfOrderInTx,
  liveEwayHolderInTx,
  thresholdForMovementInTx,
  toConsignmentView,
  toPortalConsignmentView,
  withdrawConsignmentOnCancelInTx,
  type ConsignmentRecordRow,
  type ConsignmentView,
  type PortalConsignmentView,
} from './consignment-seam';
import { replayKeyInTx, writeKeyInTx } from './consignment-keys';

/**
 * Story 4-6a (A9, A10, A46, A51) — the order consignment record's commands:
 * record (staff and portal — separate methods, one opener each) and withdraw
 * (staff). The guide §1 skeleton: shape and hash above the transaction →
 * authority → replay → the order `FOR UPDATE` (lock + 404 only) → replay again
 * → the live version `FOR UPDATE` → one clock → the guards → writes → outbox →
 * audit → the key, last. Lock order: order → record (A21) — every writer of a
 * record row serialises on its order.
 */

/** The clock the record command judges dates by (a suite moves it, §7c). */
export const consignmentClock = { now: (): number => Date.now() };

/** The partial unique index the in-use race lands on (A9 guard 11's backstop). */
const EWAY_LIVE_UNIQUE = 'order_consignment_records_client_eway_live_unique';
const LIVE_UNIQUE = 'order_consignment_records_live_unique';

export interface RecordConsignmentCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly orderId: string;
  readonly body: ConsignmentRecordInput;
}

export interface RecordPortalConsignmentCommand extends RecordConsignmentCommand {
  /** From the portal session, never the body (§7e). */
  readonly clientId: string;
}

export interface WithdrawConsignmentCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly orderId: string;
  readonly reason: string;
}

export interface ConsignmentRecordSnapshot {
  readonly consignment: ConsignmentView;
}

export interface PortalConsignmentRecordSnapshot {
  readonly consignment: PortalConsignmentView;
}

export interface ConsignmentWithdrawSnapshot {
  readonly consignment: null;
  readonly history: ConsignmentView[];
}

/** The ten columns a no-op compares (A45, D25) — source, actor, snapshot and verdict excluded. */
const NO_OP_COLUMNS = [
  'brandDocumentType',
  'brandDocumentNumber',
  'brandDocumentDate',
  'consignorGstin',
  'declaredValuePaise',
  'ewayBillNumber',
  'ewayBillDate',
  'ewayValidUntil',
  'ewayExemptionReason',
  'ewayExemptionNote',
] as const;

function hashFields(n: NormalizedConsignmentRecord): Record<string, unknown> {
  // The consignor as SENT (the default is not hashed — the 4-7c A1 rule).
  return {
    brandDocumentType: n.brandDocumentType,
    brandDocumentNumber: n.brandDocumentNumber,
    brandDocumentDate: n.brandDocumentDate,
    consignorGstin: n.consignorGstin,
    declaredValuePaise: n.declaredValuePaise,
    ewayBillNumber: n.ewayBillNumber,
    ewayBillDate: n.ewayBillDate,
    ewayValidUntil: n.ewayValidUntil,
    ewayExemptionReason: n.ewayExemptionReason,
    ewayExemptionNote: n.ewayExemptionNote,
    reason: n.reason,
  };
}

/** A9 — the staff record's fingerprint. */
export function staffRecordHash(tenantId: string, orderId: string, n: NormalizedConsignmentRecord): string {
  return hashCommandPayload({ arm: 'consignment-record', surface: 'staff', tenantId, orderId, ...hashFields(n) });
}

/** A9 — the portal record's fingerprint (`surface: 'portal'` and the client — §7e). */
export function portalRecordHash(tenantId: string, clientId: string, orderId: string, n: NormalizedConsignmentRecord): string {
  return hashCommandPayload({ arm: 'consignment-record', surface: 'portal', tenantId, clientId, orderId, ...hashFields(n) });
}

/** A10 — the withdraw's fingerprint. */
export function withdrawHash(tenantId: string, orderId: string, reason: string): string {
  return hashCommandPayload({ arm: 'consignment-withdraw', tenantId, orderId, reason });
}

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid consignment record', detail);
}

type Surface =
  | { readonly kind: 'staff'; readonly actorUserId: string; readonly elevated: boolean }
  | { readonly kind: 'portal'; readonly actorUserId: string; readonly clientId: string };

@Injectable()
export class ConsignmentCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(InvoicingFacade) private readonly invoicing: InvoicingFacade,
  ) {}

  /** A9 — `POST …/outbound/orders/{orderId}/consignment` (`dispatch.execute`; A46's elevated cases `orders.manage`). */
  async recordConsignment(command: RecordConsignmentCommand, key: string): Promise<ConsignmentRecordSnapshot> {
    const normalized = normalizeConsignmentRecordInput(command.body);
    const valid = assertConsignmentRecordShape(normalized);
    const orderId = command.orderId.toLowerCase();
    const payloadHash = staffRecordHash(command.tenantId, orderId, normalized);
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // 1. authority — the first capability before the replay; the elevated one behind it (A46).
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'dispatch.execute');
      // 2. replay.
      const first = await replayKeyInTx(tx, command.tenantId, key, payloadHash);
      if (first !== null) return first as ConsignmentRecordSnapshot;
      const surface: Surface = { kind: 'staff', actorUserId: command.actorUserId, elevated: ROLE_CAPABILITIES[role].has('orders.manage') };
      const row = await this.recordInTx(tx, command.tenantId, orderId, valid, surface, key, payloadHash);
      if ('replayed' in row) return row.replayed as ConsignmentRecordSnapshot;
      return { consignment: toConsignmentView(row.record, { ratedValuePaise: row.ratedValuePaise }) };
    });
  }

  /**
   * A9, A51 — `POST …/portal/orders/{orderId}/consignment`: the portal write
   * opens its OWN client-stamped transaction (§7e): `orders.place` → the user
   * re-read → the client `FOR SHARE` (a departed brand 409 — A45; a suspended
   * one still ships, so it still records) → replay. The stored snapshot is the
   * portal's allowlisted view (A45, D19).
   */
  async recordPortalConsignment(command: RecordPortalConsignmentCommand, key: string): Promise<PortalConsignmentRecordSnapshot> {
    const normalized = normalizeConsignmentRecordInput(command.body);
    const valid = assertConsignmentRecordShape(normalized);
    const orderId = command.orderId.toLowerCase();
    const payloadHash = portalRecordHash(command.tenantId, command.clientId, orderId, normalized);
    return withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'orders.place');
        const actor = await getMemberPortalFactsIn(tx, command.tenantId, command.actorUserId);
        if (actor === null || actor.status !== 'active') {
          throw new ProblemException('unauthenticated', 401, 'Authentication required', 'The session no longer describes an active client-portal user — sign in again.');
        }
        if (actor.clientId !== command.clientId) {
          throw new ProblemException('role-denied', 403, 'Role lacks the required capability', 'Only a client-portal user of this client may do this.');
        }
        const client = await shareLockClientInTx(tx, command.tenantId, command.clientId);
        if (client.status === 'departed') {
          throw new ProblemException('client-departed', 409, 'The client has departed', `Client ${client.code} has departed — its documents are no longer recorded here.`);
        }
        const first = await replayKeyInTx(tx, command.tenantId, key, payloadHash);
        if (first !== null) return first as PortalConsignmentRecordSnapshot;
        const surface: Surface = { kind: 'portal', actorUserId: command.actorUserId, clientId: command.clientId };
        const row = await this.recordInTx(tx, command.tenantId, orderId, valid, surface, key, payloadHash);
        if ('replayed' in row) return row.replayed as PortalConsignmentRecordSnapshot;
        return { consignment: toPortalConsignmentView(row.record, command.actorUserId) };
      },
      { clientId: command.clientId },
    );
  }

  /** A10 — `POST …/outbound/orders/{orderId}/consignment/withdraw` (`orders.manage`). */
  async withdrawConsignment(command: WithdrawConsignmentCommand, key: string): Promise<ConsignmentWithdrawSnapshot> {
    const reason = typeof command.reason === 'string' ? command.reason.trim() : '';
    if (reason === '' || [...reason].length > CONSIGNMENT_RECORD_LIMITS.reason) {
      throw invalid(`reason is required — 1–${CONSIGNMENT_RECORD_LIMITS.reason} characters saying why the record is withdrawn.`);
    }
    const orderId = command.orderId.toLowerCase();
    const payloadHash = withdrawHash(command.tenantId, orderId, reason);
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'orders.manage');
      const first = await replayKeyInTx(tx, command.tenantId, key, payloadHash);
      if (first !== null) return first as ConsignmentWithdrawSnapshot;
      const order = await this.outbound.lockOrderForConsignmentInTx(tx, command.tenantId, orderId);
      const second = await replayKeyInTx(tx, command.tenantId, key, payloadHash);
      if (second !== null) return second as ConsignmentWithdrawSnapshot;
      const live = await this.lockLiveInTx(tx, command.tenantId, order.id);
      if (live === null) {
        throw new ProblemException('consignment-not-found', 409, 'No consignment record', `Order ${order.label} has no live consignment record to withdraw.`);
      }
      if (order.status === 'dispatched') {
        throw new ProblemException(
          'order-dispatched',
          409,
          'Order has shipped',
          `Order ${order.label} is dispatched — amend its record instead: a record the goods left under stays.`,
        );
      }
      const at = new Date(consignmentClock.now()).toISOString();
      await withdrawConsignmentOnCancelInTx(tx, this.outbox, { tenantId: command.tenantId, orderId: order.id, actorUserId: command.actorUserId, at, reason });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'consignment.withdrawn',
        targetType: 'order',
        targetId: order.id,
        reference: key,
        changes: { recordId: live.id, seq: live.seq, reason },
        occurredAt: new Date().toISOString(),
      });
      const history = (await consignmentHistoryOfOrderInTx(tx, command.tenantId, order.id)).map((row) => toConsignmentView(row));
      const snapshot: ConsignmentWithdrawSnapshot = { consignment: null, history };
      await writeKeyInTx(tx, command.tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  private async lockLiveInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<ConsignmentRecordRow | null> {
    const rows = await tx
      .select()
      .from(orderConsignmentRecords)
      .where(and(eq(orderConsignmentRecords.tenantId, tenantId), eq(orderConsignmentRecords.orderId, orderId), eq(orderConsignmentRecords.status, 'live')))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /**
   * A9 steps 3–11 and the writes, shared by both surfaces (their phases,
   * never a flag on the hash or the answer — §7e).
   */
  private async recordInTx(
    tx: TenantTx,
    tenantId: string,
    orderId: string,
    valid: ValidConsignmentRecord,
    surface: Surface,
    key: string,
    payloadHash: string,
  ): Promise<{ record: ConsignmentRecordRow; ratedValuePaise: number | null } | { replayed: unknown }> {
    // 3. the order FOR UPDATE (portal: its client's — unknown and foreign the same 404).
    const order = await this.outbound.lockOrderForConsignmentInTx(tx, tenantId, orderId, surface.kind === 'portal' ? { clientId: surface.clientId } : {});
    // 4. replay again, under the order lock (the same-key race).
    const second = await replayKeyInTx(tx, tenantId, key, payloadHash);
    if (second !== null) return { replayed: second };
    // 5. the live version FOR UPDATE.
    const live = await this.lockLiveInTx(tx, tenantId, order.id);
    // 6. one clock.
    const nowMs = consignmentClock.now();
    const now = new Date(nowMs).toISOString();
    const todayIst = istDateOf(now);

    // 7.1 an open order (a dispatched one takes a late record or an amendment).
    if (order.status === 'cancelled') {
      throw new ProblemException('order-not-open', 409, 'Order is not open', `Order ${order.label} is cancelled — a cancelled order carries no consignment record.`, {
        orderStatus: order.status,
      });
    }
    // 7.2 the tenant's own goods.
    const client = await getClientInTx(tx, tenantId, order.clientId);
    if (client.systemOwned) {
      throw new ProblemException(
        'own-goods-invoiced',
        409,
        'The tenant’s own goods are invoiced by the WMS',
        'The tenant’s own goods are invoiced by the WMS — see Compliance → Invoices.',
      );
    }
    // 7.3 the document's date window (behind the replay: it reads the clock).
    assertBrandDocumentDateWindow(valid.brandDocumentDate, istDateOf(order.createdAt), todayIst);
    // 7.4 an e-way bill is not dated in the future.
    if (valid.ewayBillDate !== null && valid.ewayBillDate > todayIst) {
      throw invalid(`ewayBill.date (${valid.ewayBillDate}) is after today (${todayIst}, IST).`);
    }
    // 7.5 the consignor: sent, else the client's GSTIN (21-5).
    const consignorGstin = valid.consignorGstin ?? client.taxDetails.gstin ?? null;
    if (consignorGstin === null) {
      throw invalid("consignorGstin is required — the brand's GSTIN registered in the warehouse's state (the client has no GSTIN on file).");
    }
    // 7.6 the destination: the ship-to state (the e-way bill follows the movement), else the consignee GSTIN prefix.
    const resolver = await this.invoicing.gstStateResolverInTx(tx);
    const destinationStateCode = resolver.codeOfText(order.destinationState) ?? gstinStateCode(order.consigneeGstin);
    // 7.7 the threshold from the dispatch point (the warehouse's state) on the document's date.
    const party = await invoicePartyFactsInTx(tx, tenantId, order.warehouseId);
    const fromState = gstinStateCode(party.warehouseGstin) ?? resolver.codeOfText(party.originAddress?.state ?? null) ?? gstinStateCode(consignorGstin);
    const threshold = await thresholdForMovementInTx(tx, tenantId, { fromState, toState: destinationStateCode, istDate: valid.brandDocumentDate });
    const ewayRequired = threshold.thresholdPaise !== null && valid.declaredValuePaise > threshold.thresholdPaise;
    // 7.8 the e-way verdict.
    const ewayStatus: ConsignmentEwayStatus =
      valid.ewayBillNumber !== null ? 'recorded' : valid.ewayExemptionReason !== null ? 'exempt' : ewayRequired ? 'pending' : 'not-required';
    // A40 — a document worth less than the cash the consignee pays is an error.
    if (order.codAmountPaise !== null && valid.declaredValuePaise < order.codAmountPaise) {
      throw new ProblemException(
        'declared-value-below-order-value',
        422,
        'Declared value below the order’s value',
        `The declared value ${formatRupees(valid.declaredValuePaise)} is below the COD amount ${formatRupees(order.codAmountPaise)} — check the brand's document.`,
        { declaredValuePaise: valid.declaredValuePaise, codAmountPaise: order.codAmountPaise },
      );
    }
    // A46 — who may clear the gate (staff): an exemption, an amendment after
    // dispatch, or a value that turns a required bill into not-required needs
    // an office role. The brand (portal) speaks for its own documents.
    if (surface.kind === 'staff' && !surface.elevated) {
      const dropsRequirement = live !== null && live.ewayRequired && !ewayRequired;
      if (ewayStatus === 'exempt' || order.status === 'dispatched' || dropsRequirement) {
        throw new ProblemException(
          'role-denied',
          403,
          'Role lacks the required capability',
          ewayStatus === 'exempt'
            ? 'Only an office role can record an e-way exemption.'
            : order.status === 'dispatched'
              ? 'Only an office role can amend a record after the goods left.'
              : 'Only an office role can lower a declared value below the e-way threshold.',
        );
      }
    }
    // 7.9 unchanged → a no-op that stores the key (`consignment.record:unchanged`).
    const wouldBe: Record<(typeof NO_OP_COLUMNS)[number], unknown> = {
      brandDocumentType: valid.brandDocumentType,
      brandDocumentNumber: valid.brandDocumentNumber,
      brandDocumentDate: valid.brandDocumentDate,
      consignorGstin,
      declaredValuePaise: valid.declaredValuePaise,
      ewayBillNumber: valid.ewayBillNumber,
      ewayBillDate: valid.ewayBillDate,
      ewayValidUntil: valid.ewayValidUntil,
      ewayExemptionReason: valid.ewayExemptionReason,
      ewayExemptionNote: valid.ewayExemptionNote,
    };
    if (live !== null && NO_OP_COLUMNS.every((column) => normalizeColumn(live[column]) === normalizeColumn(wouldBe[column]))) {
      const snapshot =
        surface.kind === 'portal'
          ? { consignment: toPortalConsignmentView(live, surface.actorUserId) }
          : { consignment: toConsignmentView(live, { ratedValuePaise: order.ratedValuePaise }) };
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return { replayed: snapshot };
    }
    // A35 — the version limit.
    if (live !== null && live.seq >= CONSIGNMENT_RECORD_LIMITS.maxVersions) {
      throw new ProblemException(
        'consignment-version-limit',
        409,
        'Too many versions',
        `Order ${order.label}'s record has been amended ${CONSIGNMENT_RECORD_LIMITS.maxVersions} times — contact support.`,
      );
    }
    // 7.10 an amendment after dispatch says why.
    if (order.status === 'dispatched' && valid.reason === null) {
      throw invalid('reason is required to amend after dispatch — say what changed (e.g. the e-way bill was extended).');
    }
    // 7.11 the e-way number is not live on another order of this client.
    if (valid.ewayBillNumber !== null) {
      const holder = await liveEwayHolderInTx(tx, tenantId, order.clientId, valid.ewayBillNumber, 'same-client');
      if (holder !== null && holder.orderId !== order.id) {
        // A45 (D30) — a dead order's record (an old task's cancel) is withdrawn, never a refusal.
        const holderOrder = await this.outbound.lockOrderStatusInTx(tx, tenantId, holder.orderId);
        if (holderOrder !== null && holderOrder.status === 'cancelled') {
          await withdrawConsignmentOnCancelInTx(tx, this.outbox, { tenantId, orderId: holder.orderId, actorUserId: surface.actorUserId, at: now });
          await tx.insert(auditEvents).values({
            id: uuidv7(),
            tenantId,
            actorUserId: surface.actorUserId,
            action: 'consignment.withdrawn',
            targetType: 'order',
            targetId: holder.orderId,
            reference: key,
            changes: { reason: 'Order cancelled', selfHeal: true },
            occurredAt: new Date().toISOString(),
          });
        } else {
          throw ewayInUse(valid.ewayBillNumber, holder.orderId, holderOrder?.label ?? holder.orderId);
        }
      }
    }

    // ── the writes ───────────────────────────────────────────────────────
    if (live !== null) {
      await tx
        .update(orderConsignmentRecords)
        .set({ status: 'superseded', endedAt: now, endedBy: surface.actorUserId, endReason: valid.reason ?? 'Amended', updatedAt: now })
        .where(and(eq(orderConsignmentRecords.id, live.id), eq(orderConsignmentRecords.status, 'live')));
    }
    const maxSeq = await tx
      .select({ n: sql<number>`coalesce(max(${orderConsignmentRecords.seq}), 0)::int` })
      .from(orderConsignmentRecords)
      .where(and(eq(orderConsignmentRecords.tenantId, tenantId), eq(orderConsignmentRecords.orderId, order.id)));
    const seq = Number(maxSeq[0]?.n ?? 0) + 1;
    if (seq > CONSIGNMENT_RECORD_LIMITS.maxVersions) {
      throw new ProblemException('consignment-version-limit', 409, 'Too many versions', `Order ${order.label}'s record has ${CONSIGNMENT_RECORD_LIMITS.maxVersions} versions — contact support.`);
    }
    const consignorSnapshot = { ...clientPartySnapshotOf(client), gstin: consignorGstin };
    let inserted: ConsignmentRecordRow;
    try {
      [inserted] = (await tx
        .insert(orderConsignmentRecords)
        .values({
          id: uuidv7(),
          tenantId,
          clientId: order.clientId,
          warehouseId: order.warehouseId,
          orderId: order.id,
          seq,
          status: 'live',
          brandDocumentType: valid.brandDocumentType,
          brandDocumentNumber: valid.brandDocumentNumber,
          brandDocumentDate: valid.brandDocumentDate,
          consignorGstin,
          consignorSnapshot,
          declaredValuePaise: valid.declaredValuePaise,
          destinationStateCode: threshold.supplyType === null ? null : destinationStateCode,
          supplyType: threshold.supplyType,
          thresholdPaise: threshold.thresholdPaise,
          thresholdRule: threshold.rule,
          ewayRequired,
          ewayStatus,
          ewayBillNumber: valid.ewayBillNumber,
          ewayBillDate: valid.ewayBillDate,
          ewayValidUntil: valid.ewayValidUntil,
          ewayExemptionReason: valid.ewayExemptionReason,
          ewayExemptionNote: valid.ewayExemptionNote,
          recordedAfterDispatch: order.status === 'dispatched',
          dispatchedAt: null,
          source: surface.kind === 'portal' ? 'portal' : 'web',
          recordedBy: surface.actorUserId,
          recordedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()) as [ConsignmentRecordRow];
    } catch (err) {
      if (isUniqueViolationOn(err, EWAY_LIVE_UNIQUE)) throw ewayInUse(valid.ewayBillNumber ?? '', null, null);
      if (isUniqueViolationOn(err, LIVE_UNIQUE)) {
        throw new ProblemException('conflict', 409, 'Recorded concurrently', `Order ${order.label}'s record changed while this was recorded — reload it.`);
      }
      throw err;
    }

    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type: 'consignment.recorded',
      occurredAt: now,
      payload: {
        recordId: inserted.id,
        orderId: order.id,
        clientId: order.clientId,
        warehouseId: order.warehouseId,
        seq,
        brandDocumentType: inserted.brandDocumentType,
        brandDocumentNumber: inserted.brandDocumentNumber,
        ewayStatus: inserted.ewayStatus,
        ewayBillNumber: inserted.ewayBillNumber,
        recordedAfterDispatch: inserted.recordedAfterDispatch,
      },
    });
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const column of NO_OP_COLUMNS) {
      const before = live === null ? null : normalizeColumn(live[column]);
      const after = normalizeColumn(wouldBe[column]);
      if (before !== after) changes[column] = { before, after };
    }
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId: surface.actorUserId,
      action: 'consignment.recorded',
      targetType: 'order',
      targetId: order.id,
      reference: key,
      changes: { recordId: inserted.id, seq, source: inserted.source, ...(valid.reason === null ? {} : { reason: valid.reason }), fields: changes },
      occurredAt: new Date().toISOString(),
    });
    const snapshot =
      surface.kind === 'portal'
        ? { consignment: toPortalConsignmentView(inserted, surface.actorUserId) }
        : { consignment: toConsignmentView(inserted, { ratedValuePaise: order.ratedValuePaise }) };
    await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
    return { record: inserted, ratedValuePaise: order.ratedValuePaise };
  }
}

function normalizeColumn(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value) && value.length < 16) return Number(value);
  return String(value);
}

function ewayInUse(ewayBillNumber: string, orderId: string | null, orderLabel: string | null): ProblemException {
  return new ProblemException(
    'eway-bill-in-use',
    409,
    'E-way bill already recorded',
    orderLabel === null
      ? `E-way bill ${ewayBillNumber} was just recorded on another of your orders — reload and check.`
      : `E-way bill ${ewayBillNumber} is already recorded on order ${orderLabel} — an e-way bill covers one consignment.`,
    orderId === null ? {} : { orderId, orderLabel },
  );
}
