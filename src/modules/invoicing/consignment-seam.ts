import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { orderConsignmentRecords, type OrderConsignmentRecord } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant } from '../../shared/primitives/time';
import {
  nationalThresholdInForceInTx as sharedNationalThreshold,
  thresholdForMovement,
  type MovementThreshold,
} from '../../shared/eway/eway-threshold';

/**
 * Story 4-6a (A12, A45) — the order consignment record's SEAM: free functions
 * over the caller's transaction (guide §7h). Invoicing owns
 * `order_consignment_records`, and invoicing imports outbound — so outbound
 * (the dispatch gate, the handover, the cancels, the reads), client-emails and
 * the returns reach the record ONLY through this file, which imports only
 * `drizzle-orm` and `shared/` (pinned by `test/architecture.spec.ts`). Every
 * write here is an invoicing-table write inside `invoicing/`.
 *
 * No function here takes a lock: every caller already holds the order's row
 * lock `FOR UPDATE` (A21 — order → record, the one lock order), or only reads.
 */

export type ConsignmentRecordRow = OrderConsignmentRecord;

/** A17 — one version as every staff read and the record command answer it. */
export interface ConsignmentView {
  readonly id: string;
  readonly orderId: string;
  readonly seq: number;
  readonly status: string;
  readonly brandDocument: { readonly type: string; readonly number: string; readonly date: string };
  readonly consignorGstin: string;
  readonly consignor: { readonly name: string | null; readonly legalName: string | null };
  readonly declaredValuePaise: number;
  readonly destinationStateCode: string | null;
  readonly supplyType: string | null;
  readonly thresholdPaise: number | null;
  readonly thresholdRule: string;
  readonly ewayRequired: boolean;
  readonly eway: {
    readonly status: string;
    readonly number: string | null;
    readonly date: string | null;
    readonly validUntil: string | null;
    readonly exemptionReason: string | null;
    readonly exemptionNote: string | null;
  };
  readonly recordedAfterDispatch: boolean;
  readonly dispatchedAt: string | null;
  readonly source: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly endedAt: string | null;
  readonly endedBy: string | null;
  readonly endReason: string | null;
  /**
   * A40 — the declared value is below the order's rated floor (a warning,
   * never a refusal: a short shipment ships less than was ordered). Optional:
   * present only where the reader knew the order's rated value.
   */
  readonly declaredBelowRatedValue?: boolean;
}

/** A18 — the portal's allowlisted view: no staff user ids; `recordedByYou` instead. */
export interface PortalConsignmentView {
  readonly id: string;
  readonly orderId: string;
  readonly seq: number;
  readonly status: string;
  readonly brandDocument: { readonly type: string; readonly number: string; readonly date: string };
  readonly consignorGstin: string;
  readonly consignor: { readonly name: string | null; readonly legalName: string | null };
  readonly declaredValuePaise: number;
  readonly destinationStateCode: string | null;
  readonly supplyType: string | null;
  readonly thresholdPaise: number | null;
  readonly thresholdRule: string;
  readonly ewayRequired: boolean;
  readonly eway: ConsignmentView['eway'];
  readonly recordedAfterDispatch: boolean;
  readonly dispatchedAt: string | null;
  readonly source: string;
  readonly recordedByYou: boolean;
  readonly recordedAt: string;
  readonly endedAt: string | null;
  readonly endReason: string | null;
}

function consignorOf(row: ConsignmentRecordRow): { name: string | null; legalName: string | null } {
  const snapshot = (row.consignorSnapshot ?? {}) as { name?: unknown; legalName?: unknown };
  return {
    name: typeof snapshot.name === 'string' ? snapshot.name : null,
    legalName: typeof snapshot.legalName === 'string' ? snapshot.legalName : null,
  };
}

function instantOrNull(value: string | null): string | null {
  return value === null ? null : canonicalInstant(value);
}

/** A17 — the staff view, key by key (A45: a pure mapper here, so outbound builds it without invoicing internals). */
export function toConsignmentView(row: ConsignmentRecordRow, opts: { readonly ratedValuePaise?: number | null } = {}): ConsignmentView {
  return {
    id: row.id,
    orderId: row.orderId,
    seq: row.seq,
    status: row.status,
    brandDocument: { type: row.brandDocumentType, number: row.brandDocumentNumber, date: row.brandDocumentDate },
    consignorGstin: row.consignorGstin,
    consignor: consignorOf(row),
    declaredValuePaise: Number(row.declaredValuePaise),
    destinationStateCode: row.destinationStateCode,
    supplyType: row.supplyType,
    thresholdPaise: row.thresholdPaise === null ? null : Number(row.thresholdPaise),
    thresholdRule: row.thresholdRule,
    ewayRequired: row.ewayRequired,
    eway: {
      status: row.ewayStatus,
      number: row.ewayBillNumber,
      date: row.ewayBillDate,
      validUntil: row.ewayValidUntil,
      exemptionReason: row.ewayExemptionReason,
      exemptionNote: row.ewayExemptionNote,
    },
    recordedAfterDispatch: row.recordedAfterDispatch,
    dispatchedAt: instantOrNull(row.dispatchedAt),
    source: row.source,
    recordedBy: row.recordedBy,
    recordedAt: canonicalInstant(row.recordedAt),
    endedAt: instantOrNull(row.endedAt),
    endedBy: row.endedBy,
    endReason: row.endReason,
    ...(opts.ratedValuePaise === undefined || opts.ratedValuePaise === null
      ? {}
      : { declaredBelowRatedValue: Number(row.declaredValuePaise) < opts.ratedValuePaise }),
  };
}

/** A18 — the portal view, rebuilt key by key (never a spread of the staff view). */
export function toPortalConsignmentView(row: ConsignmentRecordRow, viewerUserId: string): PortalConsignmentView {
  return {
    id: row.id,
    orderId: row.orderId,
    seq: row.seq,
    status: row.status,
    brandDocument: { type: row.brandDocumentType, number: row.brandDocumentNumber, date: row.brandDocumentDate },
    consignorGstin: row.consignorGstin,
    consignor: consignorOf(row),
    declaredValuePaise: Number(row.declaredValuePaise),
    destinationStateCode: row.destinationStateCode,
    supplyType: row.supplyType,
    thresholdPaise: row.thresholdPaise === null ? null : Number(row.thresholdPaise),
    thresholdRule: row.thresholdRule,
    ewayRequired: row.ewayRequired,
    eway: {
      status: row.ewayStatus,
      number: row.ewayBillNumber,
      date: row.ewayBillDate,
      validUntil: row.ewayValidUntil,
      exemptionReason: row.ewayExemptionReason,
      exemptionNote: row.ewayExemptionNote,
    },
    recordedAfterDispatch: row.recordedAfterDispatch,
    dispatchedAt: instantOrNull(row.dispatchedAt),
    source: row.source,
    recordedByYou: row.recordedBy === viewerUserId,
    recordedAt: canonicalInstant(row.recordedAt),
    endedAt: instantOrNull(row.endedAt),
    endReason: row.endReason,
  };
}

function uniqueSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** A12 — the live version of each order (on `order_consignment_records_live_unique`). */
export async function liveConsignmentRecordsOfOrdersInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, ConsignmentRecordRow>> {
  const ids = uniqueSorted(orderIds);
  if (ids.length === 0) return new Map();
  const rows = await liveConsignmentRecordsQuery(tx, tenantId, ids);
  return new Map(rows.map((row) => [row.orderId, row]));
}

/** A50 — the live read itself (exported so the suite EXPLAINs the REAL query). */
export function liveConsignmentRecordsQuery(tx: TenantTx, tenantId: string, orderIds: readonly string[]) {
  return tx
    .select()
    .from(orderConsignmentRecords)
    .where(and(eq(orderConsignmentRecords.tenantId, tenantId), inArray(orderConsignmentRecords.orderId, [...orderIds]), eq(orderConsignmentRecords.status, 'live')));
}

/** Every version of one order, newest first (the history the reads print). */
export async function consignmentHistoryOfOrderInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<ConsignmentRecordRow[]> {
  return tx
    .select()
    .from(orderConsignmentRecords)
    .where(and(eq(orderConsignmentRecords.tenantId, tenantId), eq(orderConsignmentRecords.orderId, orderId)))
    .orderBy(desc(orderConsignmentRecords.seq));
}

/**
 * A12, A45 (D16) — the version each order LEFT under: the one stamped
 * `dispatched_at` (immutable). For an order dispatched by an old api task
 * during the rollout (no stamp), the version that was live at the dispatch —
 * `recorded_at ≤ dispatchedAt < coalesce(ended_at, ∞)` — when the caller
 * knows the dispatch's instant. The handover sheet, the detail and the
 * dispatch email all read through here, so they agree.
 */
export async function dispatchedConsignmentRecordsOfOrdersInTx(
  tx: TenantTx,
  tenantId: string,
  orderIds: readonly string[],
  dispatchedAtByOrder: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, ConsignmentRecordRow>> {
  const ids = uniqueSorted(orderIds);
  if (ids.length === 0) return new Map();
  const stamped = await tx
    .select()
    .from(orderConsignmentRecords)
    .where(and(eq(orderConsignmentRecords.tenantId, tenantId), inArray(orderConsignmentRecords.orderId, ids), isNotNull(orderConsignmentRecords.dispatchedAt)))
    .orderBy(asc(orderConsignmentRecords.seq));
  const out = new Map<string, ConsignmentRecordRow>();
  for (const row of stamped) if (!out.has(row.orderId)) out.set(row.orderId, row);
  const unstamped = ids.filter((id) => !out.has(id) && dispatchedAtByOrder.has(id));
  if (unstamped.length > 0) {
    const candidates = await tx
      .select()
      .from(orderConsignmentRecords)
      .where(and(eq(orderConsignmentRecords.tenantId, tenantId), inArray(orderConsignmentRecords.orderId, unstamped)))
      .orderBy(desc(orderConsignmentRecords.seq));
    for (const row of candidates) {
      if (out.has(row.orderId)) continue;
      const at = Date.parse(dispatchedAtByOrder.get(row.orderId)!);
      if (Date.parse(row.recordedAt) <= at && (row.endedAt === null || at < Date.parse(row.endedAt))) out.set(row.orderId, row);
    }
  }
  return out;
}

/**
 * A12, A13 — stamp the live version of a dispatching order (`dispatched_at`
 * NULL → `at`; the trigger allows exactly this once). Returns the record id,
 * or null when the order has no live version.
 */
export async function stampConsignmentDispatchedInTx(tx: TenantTx, tenantId: string, orderId: string, at: string): Promise<string | null> {
  const rows = await tx
    .update(orderConsignmentRecords)
    .set({ dispatchedAt: at, updatedAt: at })
    .where(
      and(
        eq(orderConsignmentRecords.tenantId, tenantId),
        eq(orderConsignmentRecords.orderId, orderId),
        eq(orderConsignmentRecords.status, 'live'),
        isNull(orderConsignmentRecords.dispatchedAt),
      ),
    )
    .returning({ id: orderConsignmentRecords.id });
  return rows[0]?.id ?? null;
}

/**
 * A21, A38 — a cancel withdraws the order's live version (end reason "Order
 * cancelled"), so its e-way number is free for the brand's re-issue, and
 * appends `consignment.withdrawn` through the caller's outbox. Returns the
 * withdrawn record id, or null when none was live.
 */
export async function withdrawConsignmentOnCancelInTx(
  tx: TenantTx,
  outbox: OutboxSink,
  input: { readonly tenantId: string; readonly orderId: string; readonly actorUserId: string; readonly at: string; readonly reason?: string },
): Promise<string | null> {
  const reason = input.reason ?? 'Order cancelled';
  const rows = await tx
    .update(orderConsignmentRecords)
    .set({ status: 'withdrawn', endedAt: input.at, endedBy: input.actorUserId, endReason: reason, updatedAt: input.at })
    .where(and(eq(orderConsignmentRecords.tenantId, input.tenantId), eq(orderConsignmentRecords.orderId, input.orderId), eq(orderConsignmentRecords.status, 'live')))
    .returning({ id: orderConsignmentRecords.id, clientId: orderConsignmentRecords.clientId });
  const row = rows[0];
  if (row === undefined) return null;
  await outbox.append(tx, {
    messageId: uuidv7(),
    tenantId: input.tenantId,
    type: 'consignment.withdrawn',
    occurredAt: input.at,
    payload: { recordId: row.id, orderId: input.orderId, clientId: row.clientId, reason },
  });
  return row.id;
}

/** A12 — the national e-way threshold in force on `istDate` (409 `eway-threshold-missing` when none is). */
export async function nationalThresholdInForceInTx(tx: TenantTx, istDate: string): Promise<number> {
  return sharedNationalThreshold(tx, istDate);
}

/** A12 — a movement's threshold (`shared/eway`'s rule). */
export async function thresholdForMovementInTx(
  tx: TenantTx,
  tenantId: string,
  movement: { readonly fromState: string | null; readonly toState: string | null; readonly istDate: string },
): Promise<MovementThreshold> {
  return thresholdForMovement(tx, tenantId, movement);
}

/**
 * A16 (staff) — other LIVE versions of the client carrying the same document
 * (type, number, consignor): a warning, never a refusal. On
 * `order_consignment_records_client_document_idx`.
 */
export async function duplicateConsignmentDocumentsInTx(
  tx: TenantTx,
  tenantId: string,
  row: Pick<ConsignmentRecordRow, 'clientId' | 'orderId' | 'brandDocumentType' | 'brandDocumentNumber' | 'consignorGstin'>,
): Promise<string[]> {
  const rows = await tx
    .select({ orderId: orderConsignmentRecords.orderId })
    .from(orderConsignmentRecords)
    .where(
      and(
        eq(orderConsignmentRecords.tenantId, tenantId),
        eq(orderConsignmentRecords.clientId, row.clientId),
        eq(orderConsignmentRecords.brandDocumentNumber, row.brandDocumentNumber),
        eq(orderConsignmentRecords.status, 'live'),
        eq(orderConsignmentRecords.brandDocumentType, row.brandDocumentType),
        eq(orderConsignmentRecords.consignorGstin, row.consignorGstin),
        sql`${orderConsignmentRecords.orderId} <> ${row.orderId}`,
      ),
    )
    .limit(20);
  return rows.map((r) => r.orderId);
}

/**
 * A9 guard 11, A45 (D32) — the live version holding an e-way number, filtered
 * to ONE client explicitly (a tenant-stamped read sees every client), or —
 * `otherClient` — any other client's (the staff-only warning).
 */
export async function liveEwayHolderInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  ewayBillNumber: string,
  scope: 'same-client' | 'other-client',
): Promise<{ readonly id: string; readonly seq: number; readonly orderId: string; readonly clientId: string } | null> {
  const rows = await tx
    .select({ id: orderConsignmentRecords.id, seq: orderConsignmentRecords.seq, orderId: orderConsignmentRecords.orderId, clientId: orderConsignmentRecords.clientId })
    .from(orderConsignmentRecords)
    .where(
      and(
        eq(orderConsignmentRecords.tenantId, tenantId),
        scope === 'same-client' ? eq(orderConsignmentRecords.clientId, clientId) : sql`${orderConsignmentRecords.clientId} <> ${clientId}`,
        eq(orderConsignmentRecords.ewayBillNumber, ewayBillNumber),
        eq(orderConsignmentRecords.status, 'live'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
