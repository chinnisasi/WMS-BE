import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { orderLines, orderPacks, orders, shipments, courierHandovers, type Order } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { canonicalInstant, istDateOf } from '../../shared/primitives/time';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import {
  consignmentGate,
  type ConsignmentDocumentRule,
  type ConsignmentGateCode,
  type ConsignmentGateResult,
  type ConsignmentGateState,
  type ConsignmentRequiredBecause,
} from '../../shared/primitives/consignment-gate';
import { consignmentPoliciesInTx } from '../clients/clients.facade';
// Story 4-6a (A12) — the record's seam: a free-function file of invoicing
// that imports only drizzle-orm and shared/ (guide §7h), never the module.
import {
  consignmentHistoryOfOrderInTx,
  dispatchedConsignmentRecordsOfOrdersInTx,
  duplicateConsignmentDocumentsInTx,
  liveConsignmentRecordsOfOrdersInTx,
  liveEwayHolderInTx,
  nationalThresholdInForceInTx,
  type ConsignmentRecordRow,
} from '../invoicing/consignment-seam';
import { invoicePartyFactsInTx } from '../tenancy/tenancy.service';

/**
 * Story 4-6a (A13–A16, A18, A43) — outbound's consignment reads: the gate's
 * facts for a set of orders in a fixed number of queries (the orders, their
 * clients' rules, the rated values in one `GROUP BY`, the live records through
 * the seam), the judgement on a date, and the worklists. The gate itself is
 * the pure `consignmentGate` (`shared/primitives/consignment-gate.ts`).
 */

/** The A13 facts of one order, without the date-dependent threshold. */
export interface OrderConsignmentFacts {
  readonly order: Order;
  readonly label: string;
  readonly clientSystemOwned: boolean;
  readonly clientCode: string;
  readonly documentRule: ConsignmentDocumentRule;
  readonly ratedValuePaise: number | null;
  readonly live: ConsignmentRecordRow | null;
}

/** A42 — the rated value per order: floor(Σ qty × rate / 1000) over the top-level rated lines, exact (numeric). */
export async function ratedValuesOfOrdersInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ orderId: orderLines.orderId, value: sql<string>`floor(sum(${orderLines.qty}::numeric * ${orderLines.ratePaise}::numeric) / 1000)::text` })
    .from(orderLines)
    .where(and(eq(orderLines.tenantId, tenantId), inArray(orderLines.orderId, ids), isNull(orderLines.parentLineId), isNotNull(orderLines.ratePaise)))
    .groupBy(orderLines.orderId);
  const out = new Map<string, number>();
  for (const row of rows) {
    const value = Number(row.value);
    if (!Number.isSafeInteger(value)) throw new RangeError(`order ${row.orderId}: rated value ${row.value} paise is not a safe integer`);
    out.set(row.orderId, value);
  }
  return out;
}

/** A13, A14 — the facts of a set of already-read order rows (one query per kind, never per order). */
export async function consignmentFactsOfOrderRowsInTx(tx: TenantTx, tenantId: string, rows: readonly Order[]): Promise<Map<string, OrderConsignmentFacts>> {
  if (rows.length === 0) return new Map();
  const ids = rows.map((row) => row.id);
  // Sequential: one transaction is one connection.
  const policies = await consignmentPoliciesInTx(tx, tenantId, rows.map((row) => row.clientId));
  const rated = await ratedValuesOfOrdersInTx(tx, tenantId, ids);
  const live = await liveConsignmentRecordsOfOrdersInTx(tx, tenantId, ids);
  const out = new Map<string, OrderConsignmentFacts>();
  for (const order of rows) {
    const policy = policies.get(order.clientId);
    out.set(order.id, {
      order,
      label: orderLabelOf(order),
      // An unknown client reads as self: fail-safe — never blocks a shipment on a missing row.
      clientSystemOwned: policy?.systemOwned ?? true,
      clientCode: policy?.code ?? '',
      documentRule: policy?.documentRule ?? 'b2b',
      ratedValuePaise: rated.get(order.id) ?? null,
      live: live.get(order.id) ?? null,
    });
  }
  return out;
}

/** A14 — the facts of a set of orders by id (unknown ids absent). */
export async function consignmentFactsOfOrdersInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, OrderConsignmentFacts>> {
  const ids = [...new Set(orderIds)].sort();
  if (ids.length === 0) return new Map();
  const rows = await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), inArray(orders.id, ids)));
  return consignmentFactsOfOrderRowsInTx(tx, tenantId, rows);
}

/** One national threshold per IST date, read once per command or read (§7m — one clock, one figure). */
export class NationalThresholds {
  private readonly byDate = new Map<string, number>();
  constructor(private readonly tx: TenantTx) {}
  async on(istDate: string): Promise<number> {
    const cached = this.byDate.get(istDate);
    if (cached !== undefined) return cached;
    const value = await nationalThresholdInForceInTx(this.tx, istDate);
    this.byDate.set(istDate, value);
    return value;
  }
}

/** A15 — judge one order's facts on `istDate` (`orderStatus` overridable: A37 re-judges a dispatched order as it stood). */
export function judgeConsignment(facts: OrderConsignmentFacts, nationalThresholdPaise: number, istDate: string, orderStatus: string = facts.order.status): ConsignmentGateResult {
  return consignmentGate({
    clientSystemOwned: facts.clientSystemOwned,
    documentRule: facts.documentRule,
    orderStatus,
    orderType: facts.order.orderType,
    consigneeGstin: facts.order.consigneeGstin,
    ratedValuePaise: facts.ratedValuePaise,
    codAmountPaise: facts.order.codAmountPaise === null ? null : Number(facts.order.codAmountPaise),
    nationalThresholdPaise,
    live: facts.live === null ? null : { ewayStatus: facts.live.ewayStatus, ewayValidUntil: facts.live.ewayValidUntil },
    istDate,
  });
}

/** A13 — the refusal a blocking state answers (409), its detail naming the remedy. */
export function consignmentRefusal(facts: OrderConsignmentFacts, gate: ConsignmentGateResult, thresholdPaise: number): ProblemException {
  const label = facts.label;
  const code = gate.code as ConsignmentGateCode;
  const detail =
    code === 'consignment-documents-missing'
      ? `Record the brand's invoice (or challan) for order ${label} — Outbound → Documents, or the brand records it in its portal. ${requiredBecauseWords(gate.requiredBecause, thresholdPaise)}`
      : code === 'eway-bill-required'
        ? `Order ${label}'s declared value is above the e-way threshold and no e-way bill is recorded — record the brand's e-way bill number (Outbound → Documents, or the brand's portal).`
        : `Order ${label}'s e-way bill ${facts.live?.ewayBillNumber ?? ''} expired on ${facts.live?.ewayValidUntil ?? ''} — record its extension or a new bill before it leaves.`;
  return new ProblemException(code, 409, code === 'consignment-documents-missing' ? 'The brand’s documents are not recorded' : code === 'eway-bill-required' ? 'E-way bill required' : 'E-way bill expired', detail, {
    orderId: facts.order.id,
    state: gate.state,
    requiredBecause: gate.requiredBecause,
    valueFloorPaise: gate.valueFloorPaise,
    thresholdPaise,
  });
}

function requiredBecauseWords(because: ConsignmentRequiredBecause | null, thresholdPaise: number): string {
  switch (because) {
    case 'policy-all':
      return 'The client asks for the documents of every order.';
    case 'policy-b2b':
      return 'The client asks for the documents of every B2B order.';
    case 'value':
      return `The order's own value is above ₹${(thresholdPaise / 100).toLocaleString('en-IN')} — the e-way threshold.`;
    default:
      return '';
  }
}

// ── the staff worklist (A16, A43) ───────────────────────────────────────────

/** A16 — at most this many open orders are scanned per warehouse (packed first). */
export const CONSIGNMENT_WORKLIST_SCAN = 5000;
/** A16 — at most this many exception rows. */
export const CONSIGNMENT_EXCEPTIONS_MAX = 500;
/** A18 — at most this many portal needed rows. */
export const PORTAL_CONSIGNMENTS_NEEDED_MAX = 500;
const FACT_CHUNK = 500;

export interface ConsignmentWorklistRow {
  readonly orderId: string;
  readonly orderLabel: string;
  readonly clientId: string;
  readonly clientCode: string;
  readonly orderType: string | null;
  readonly stage: 'accepted' | 'packed';
  readonly state: ConsignmentGateState;
  readonly requiredBecause: ConsignmentRequiredBecause | null;
  readonly valueFloorPaise: number | null;
  readonly eway: { readonly number: string | null; readonly validUntil: string | null } | null;
  readonly declaredBelowRatedValue: boolean;
  readonly createdAt: string;
  readonly packedAt: string | null;
}

export interface ConsignmentExceptionRow {
  readonly orderId: string;
  readonly orderLabel: string;
  readonly clientId: string;
  readonly clientCode: string;
  readonly shipmentId: string;
  readonly handoverId: string | null;
  readonly handoverCode: string | null;
  readonly handedOverAt: string | null;
  readonly code: string;
  /** The live record's state on the handover day now (still blocking — a cleared exception is not listed). */
  readonly state: ConsignmentGateState;
}

async function inChunks<T>(rows: readonly Order[], fn: (chunk: readonly Order[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += FACT_CHUNK) out.push(...(await fn(rows.slice(i, i + FACT_CHUNK))));
  return out;
}

/**
 * A16 `needed`, A43 — the warehouse's open orders whose gate is blocking or
 * expires today, packed first: every `ready_to_dispatch` order (on 0116's
 * `orders_ready_to_dispatch_idx`), then `accepted` ones (0104's
 * `orders_accepted_tenant_warehouse_idx`), at most 5,000 scanned in all.
 */
export async function consignmentNeededInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  clientId: string | null,
  todayIst: string,
): Promise<{ rows: ConsignmentWorklistRow[]; truncated: boolean }> {
  const scope = (status: 'ready_to_dispatch' | 'accepted') => consignmentNeededScope(tenantId, warehouseId, clientId, status);
  const packed = await consignmentNeededPassQuery(tx, tenantId, warehouseId, clientId, 'ready_to_dispatch', CONSIGNMENT_WORKLIST_SCAN + 1);
  let truncated = packed.length > CONSIGNMENT_WORKLIST_SCAN;
  const packedRows = packed.slice(0, CONSIGNMENT_WORKLIST_SCAN);
  const room = CONSIGNMENT_WORKLIST_SCAN - packedRows.length;
  let acceptedRows: Order[] = [];
  if (room > 0) {
    const accepted = await consignmentNeededPassQuery(tx, tenantId, warehouseId, clientId, 'accepted', room + 1);
    if (accepted.length > room) truncated = true;
    acceptedRows = accepted.slice(0, room);
  } else if (!truncated) {
    const more = await tx.select({ id: orders.id }).from(orders).where(scope('accepted')).limit(1);
    if (more.length > 0) truncated = true;
  }
  const thresholds = new NationalThresholds(tx);
  const national = await thresholds.on(todayIst);
  const rows = await inChunks([...packedRows, ...acceptedRows], async (chunk) => {
    const facts = await consignmentFactsOfOrderRowsInTx(tx, tenantId, chunk);
    const packs = await livePackedAtInTx(tx, tenantId, chunk.filter((order) => order.status === 'ready_to_dispatch').map((order) => order.id));
    const out: ConsignmentWorklistRow[] = [];
    for (const order of chunk) {
      const fact = facts.get(order.id)!;
      if (fact.clientSystemOwned) continue;
      const gate = judgeConsignment(fact, national, todayIst);
      if (!gate.blocking && !gate.expiresToday) continue;
      out.push(worklistRowOf(fact, gate, packs.get(order.id) ?? null));
    }
    return out;
  });
  return { rows, truncated };
}

function consignmentNeededScope(tenantId: string, warehouseId: string, clientId: string | null, status: 'ready_to_dispatch' | 'accepted') {
  return and(eq(orders.tenantId, tenantId), eq(orders.warehouseId, warehouseId), eq(orders.status, status), ...(clientId === null ? [] : [eq(orders.clientId, clientId)]));
}

/**
 * A43, D3 — one worklist pass (exported so the suite EXPLAINs the REAL query):
 * packed orders by `(updated_at, id)` on 0116's `orders_ready_to_dispatch_idx`,
 * accepted ones by `(created_at, id)` on 0104's `orders_accepted_tenant_warehouse_idx`.
 */
export function consignmentNeededPassQuery(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  clientId: string | null,
  status: 'ready_to_dispatch' | 'accepted',
  limit: number,
) {
  return tx
    .select()
    .from(orders)
    .where(consignmentNeededScope(tenantId, warehouseId, clientId, status))
    .orderBy(...(status === 'ready_to_dispatch' ? [asc(orders.updatedAt), asc(orders.id)] : [asc(orders.createdAt), asc(orders.id)]))
    .limit(limit);
}

function worklistRowOf(fact: OrderConsignmentFacts, gate: ConsignmentGateResult, packedAt: string | null): ConsignmentWorklistRow {
  return {
    orderId: fact.order.id,
    orderLabel: fact.label,
    clientId: fact.order.clientId,
    clientCode: fact.clientCode,
    orderType: fact.order.orderType,
    stage: fact.order.status === 'ready_to_dispatch' ? 'packed' : 'accepted',
    state: gate.state,
    requiredBecause: gate.requiredBecause,
    valueFloorPaise: gate.valueFloorPaise,
    eway: fact.live === null ? null : { number: fact.live.ewayBillNumber, validUntil: fact.live.ewayValidUntil },
    declaredBelowRatedValue: fact.live !== null && fact.ratedValuePaise !== null && Number(fact.live.declaredValuePaise) < fact.ratedValuePaise,
    createdAt: canonicalInstant(fact.order.createdAt),
    packedAt,
  };
}

/** The live pack's `packed_at` per order (a virtual pre-4-5a pack has none). */
async function livePackedAtInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, string>> {
  if (orderIds.length === 0) return new Map();
  const rows = await tx
    .select({ orderId: orderPacks.orderId, packedAt: orderPacks.packedAt })
    .from(orderPacks)
    .where(and(eq(orderPacks.tenantId, tenantId), inArray(orderPacks.orderId, [...orderIds]), eq(orderPacks.status, 'live')));
  return new Map(rows.map((row) => [row.orderId, canonicalInstant(row.packedAt)]));
}

/**
 * A16 `exceptions`, A37 — the device handovers that left without documents
 * (`shipments.compliance_exception`, on `shipments_compliance_exception_idx`,
 * at most 500), each re-judged on its handover's IST date: a live record that
 * would have read `ready` that day clears it (a later expiry never brings it
 * back). The column is never rewritten.
 */
export async function consignmentExceptionsInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  clientId: string | null,
): Promise<ConsignmentExceptionRow[]> {
  const rows = await consignmentExceptionsQuery(tx, tenantId, warehouseId, clientId);
  if (rows.length === 0) return [];
  const facts = await consignmentFactsOfOrdersInTx(tx, tenantId, rows.map((row) => row.shipment.orderId));
  const thresholds = new NationalThresholds(tx);
  const out: ConsignmentExceptionRow[] = [];
  for (const { shipment, handoverCode } of rows) {
    const fact = facts.get(shipment.orderId);
    if (fact === undefined) continue;
    const day = shipment.handedOverAt === null ? istDateOf(shipment.updatedAt) : istDateOf(shipment.handedOverAt);
    // A37 — judged as the order stood on the handover day (open), never as `dispatched`.
    const gate = judgeConsignment(fact, await thresholds.on(day), day, 'ready_to_dispatch');
    if (fact.live !== null && gate.state === 'ready') continue;
    out.push({
      orderId: fact.order.id,
      orderLabel: fact.label,
      clientId: fact.order.clientId,
      clientCode: fact.clientCode,
      shipmentId: shipment.id,
      handoverId: shipment.handoverId,
      handoverCode: handoverCode ?? null,
      handedOverAt: shipment.handedOverAt === null ? null : canonicalInstant(shipment.handedOverAt),
      code: shipment.complianceException!,
      state: gate.state,
    });
  }
  return out;
}

/** A50 — the exceptions read (exported so the suite EXPLAINs the REAL query; on `shipments_compliance_exception_idx`). */
export function consignmentExceptionsQuery(tx: TenantTx, tenantId: string, warehouseId: string, clientId: string | null) {
  return tx
    .select({ shipment: shipments, handoverCode: courierHandovers.code })
    .from(shipments)
    .leftJoin(courierHandovers, and(eq(courierHandovers.tenantId, shipments.tenantId), eq(courierHandovers.id, shipments.handoverId)))
    .where(
      and(
        eq(shipments.tenantId, tenantId),
        eq(shipments.warehouseId, warehouseId),
        isNotNull(shipments.complianceException),
        ...(clientId === null ? [] : [eq(shipments.clientId, clientId)]),
      ),
    )
    .orderBy(desc(shipments.handedOverAt), desc(shipments.id))
    .limit(CONSIGNMENT_EXCEPTIONS_MAX);
}

/** A50 — the portal needed list's scan (exported so the suite EXPLAINs the REAL query; on 0101's `orders_tenant_client_open_idx`). */
export function portalOpenOrdersQuery(tx: TenantTx, tenantId: string, clientId: string) {
  return tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.clientId, clientId), sql`${orders.status} IN ('accepted','ready_to_dispatch')`));
}

/** A18 — one row of the portal's needed list (no warehouse flag, no staff fact). */
export interface PortalConsignmentNeededRow {
  readonly orderId: string;
  readonly orderLabel: string;
  readonly clientOrderRef: string | null;
  readonly stage: 'accepted' | 'packed';
  readonly state: ConsignmentGateState;
  readonly requiredBecause: ConsignmentRequiredBecause | null;
  readonly ewayValidUntil: string | null;
}

/**
 * A18 — the client's open orders with a blocking or expiring gate, at most
 * 500, on 0101's `orders_tenant_client_open_idx` (sorted in memory — at most
 * 500 rows kept). The caller's transaction is client-stamped; this query adds
 * the explicit `client_id = $client` (the two layers).
 */
export async function portalConsignmentsNeededInTx(tx: TenantTx, tenantId: string, clientId: string, todayIst: string): Promise<PortalConsignmentNeededRow[]> {
  const open = await portalOpenOrdersQuery(tx, tenantId, clientId);
  const national = await nationalThresholdInForceInTx(tx, todayIst);
  const kept = await inChunks(open, async (chunk) => {
    const facts = await consignmentFactsOfOrderRowsInTx(tx, tenantId, chunk);
    const out: { row: PortalConsignmentNeededRow; packed: boolean; createdAt: string }[] = [];
    for (const order of chunk) {
      const fact = facts.get(order.id)!;
      const gate = judgeConsignment(fact, national, todayIst);
      if (!gate.blocking && !gate.expiresToday) continue;
      out.push({
        packed: order.status === 'ready_to_dispatch',
        createdAt: order.createdAt,
        row: {
          orderId: order.id,
          orderLabel: fact.label,
          clientOrderRef: order.clientOrderRef,
          stage: order.status === 'ready_to_dispatch' ? 'packed' : 'accepted',
          state: gate.state,
          requiredBecause: gate.requiredBecause,
          ewayValidUntil: fact.live?.ewayValidUntil ?? null,
        },
      });
    }
    return out;
  });
  kept.sort((a, b) => (a.packed === b.packed ? (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) : a.packed ? -1 : 1));
  return kept.slice(0, PORTAL_CONSIGNMENTS_NEEDED_MAX).map((entry) => entry.row);
}

/** A9 step 3 — the locked order as the record command sees it. */
export interface ConsignmentOrderLock {
  readonly id: string;
  readonly clientId: string;
  readonly warehouseId: string;
  readonly status: string;
  readonly orderType: string | null;
  readonly consigneeGstin: string | null;
  readonly destinationState: string | null;
  readonly createdAt: string;
  readonly codAmountPaise: number | null;
  readonly ratedValuePaise: number | null;
  readonly label: string;
}

/**
 * A9 step 3 — the order `FOR UPDATE` (the one lock every record writer takes
 * first, A21) — lock and 404 only, no status check (guide §1: the replay runs
 * again under it). On the portal, an unknown order and another client's are
 * the same 404.
 */
export async function lockOrderForConsignmentInTx(
  tx: TenantTx,
  tenantId: string,
  orderId: string,
  opts: { readonly clientId?: string } = {},
): Promise<ConsignmentOrderLock> {
  const notFound = new ProblemException('not-found', 404, 'Order not found', `No order with id "${orderId}" exists here.`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) throw notFound;
  const rows = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId.toLowerCase()), ...(opts.clientId === undefined ? [] : [eq(orders.clientId, opts.clientId)])))
    .limit(1)
    .for('update');
  const order = rows[0];
  if (order === undefined) throw notFound;
  const rated = await ratedValuesOfOrdersInTx(tx, tenantId, [order.id]);
  return {
    id: order.id,
    clientId: order.clientId,
    warehouseId: order.warehouseId,
    status: order.status,
    orderType: order.orderType,
    consigneeGstin: order.consigneeGstin,
    destinationState: order.destinationState,
    createdAt: order.createdAt,
    codAmountPaise: order.codAmountPaise === null ? null : Number(order.codAmountPaise),
    ratedValuePaise: rated.get(order.id) ?? null,
    label: orderLabelOf(order),
  };
}

/** A45 (D30) — lock another order (an e-way holder) to see whether it is cancelled; null when absent. */
export async function lockOrderStatusInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<{ readonly status: string; readonly label: string } | null> {
  const rows = await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId))).limit(1).for('update');
  const order = rows[0];
  return order === undefined ? null : { status: order.status, label: orderLabelOf(order) };
}

/** A16 — the gate as a read answers it (the threshold it judged against included). */
export interface ConsignmentGateView {
  readonly state: ConsignmentGateState;
  readonly blocking: boolean;
  readonly requiredBecause: ConsignmentRequiredBecause | null;
  readonly valueFloorPaise: number | null;
  readonly nationalThresholdPaise: number;
  readonly expiresToday: boolean;
}

export function gateViewOf(gate: ConsignmentGateResult, nationalThresholdPaise: number): ConsignmentGateView {
  return {
    state: gate.state,
    blocking: gate.blocking,
    requiredBecause: gate.requiredBecause,
    valueFloorPaise: gate.valueFloorPaise,
    nationalThresholdPaise,
    expiresToday: gate.expiresToday,
  };
}

/** A16 — the staff read's raw facts (the facade adds the presigned scans). */
export interface OrderConsignmentReadInTx {
  readonly facts: OrderConsignmentFacts;
  readonly gate: ConsignmentGateView;
  readonly history: readonly ConsignmentRecordRow[];
  readonly dispatchedRecordId: string | null;
  readonly duplicates: readonly { readonly orderId: string; readonly orderLabel: string }[];
  readonly consignorStateMismatch: boolean;
  readonly ewayUsedByOtherClient: { readonly clientCode: string; readonly orderLabel: string } | null;
  readonly complianceException: string | null;
}

async function labelsOfOrdersInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, { label: string; clientId: string }>> {
  if (orderIds.length === 0) return new Map();
  const rows = await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), inArray(orders.id, [...new Set(orderIds)])));
  return new Map(rows.map((row) => [row.id, { label: orderLabelOf(row), clientId: row.clientId }]));
}

/**
 * A16 — one order's consignment (staff, ungated): the gate for today, the
 * live version and its history, the version the goods left under, the
 * duplicate-document and consignor-state warnings, the staff-only
 * cross-client e-way warning (A45 D32) and the device-handover exception.
 * Null for an unknown order.
 */
export async function orderConsignmentReadInTx(
  tx: TenantTx,
  tenantId: string,
  orderId: string,
  todayIst: string,
  clientId?: string,
): Promise<OrderConsignmentReadInTx | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) return null;
  const rows = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId.toLowerCase()), ...(clientId === undefined ? [] : [eq(orders.clientId, clientId)])))
    .limit(1);
  const order = rows[0];
  if (order === undefined) return null;
  const facts = (await consignmentFactsOfOrderRowsInTx(tx, tenantId, [order])).get(order.id)!;
  const national = await nationalThresholdInForceInTx(tx, todayIst);
  const gate = gateViewOf(judgeConsignment(facts, national, todayIst), national);
  const history = await consignmentHistoryOfOrderInTx(tx, tenantId, order.id);
  const dispatchedAt = order.status === 'dispatched' ? new Map([[order.id, order.updatedAt]]) : new Map<string, string>();
  const dispatched = order.status === 'dispatched' ? (await dispatchedConsignmentRecordsOfOrdersInTx(tx, tenantId, [order.id], dispatchedAt)).get(order.id) ?? null : null;
  let duplicates: { orderId: string; orderLabel: string }[] = [];
  let consignorStateMismatch = false;
  let ewayUsedByOtherClient: { clientCode: string; orderLabel: string } | null = null;
  if (facts.live !== null && clientId === undefined) {
    const dupIds = await duplicateConsignmentDocumentsInTx(tx, tenantId, facts.live);
    const labels = await labelsOfOrdersInTx(tx, tenantId, dupIds);
    duplicates = dupIds.map((id) => ({ orderId: id, orderLabel: labels.get(id)?.label ?? id }));
    const warehouseGstin = (await invoicePartyFactsInTx(tx, tenantId, order.warehouseId)).warehouseGstin;
    // A45 (D18) — false when the warehouse's state is unknown.
    consignorStateMismatch = warehouseGstin !== null && warehouseGstin.slice(0, 2) !== facts.live.consignorGstin.slice(0, 2);
    if (facts.live.ewayBillNumber !== null) {
      const holder = await liveEwayHolderInTx(tx, tenantId, order.clientId, facts.live.ewayBillNumber, 'other-client');
      if (holder !== null) {
        const policy = (await consignmentPoliciesInTx(tx, tenantId, [holder.clientId])).get(holder.clientId);
        const label = (await labelsOfOrdersInTx(tx, tenantId, [holder.orderId])).get(holder.orderId)?.label ?? holder.orderId;
        ewayUsedByOtherClient = { clientCode: policy?.code ?? holder.clientId, orderLabel: label };
      }
    }
  }
  let complianceException: string | null = null;
  if (clientId === undefined) {
    const flagged = await tx
      .select({ code: shipments.complianceException })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), eq(shipments.orderId, order.id), isNotNull(shipments.complianceException)))
      .limit(1);
    complianceException = flagged[0]?.code ?? null;
  }
  return {
    facts,
    gate,
    history,
    dispatchedRecordId: dispatched?.id ?? null,
    duplicates,
    consignorStateMismatch,
    ewayUsedByOtherClient,
    complianceException,
  };
}

/** The clock the consignment READS judge "today" by (a suite moves it; the record command has its own). */
export const consignmentReadClock = { now: (): number => Date.now() };

export function consignmentTodayIst(): string {
  return istDateOf(new Date(consignmentReadClock.now()).toISOString());
}

/** A16 — one parcel's consignment as the 4-4a candidates and the device snapshot carry it. */
export interface ParcelConsignment {
  readonly state: ConsignmentGateState;
  readonly blocking: boolean;
  readonly ewayBillNumber: string | null;
  readonly ewayValidUntil: string | null;
}

/** A16, D15 — the parcel consignments of a set of orders judged today (batches of 500; one threshold read). */
export async function parcelConsignmentsInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[], todayIst: string): Promise<Map<string, ParcelConsignment>> {
  const out = new Map<string, ParcelConsignment>();
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return out;
  const national = await nationalThresholdInForceInTx(tx, todayIst);
  for (let i = 0; i < ids.length; i += FACT_CHUNK) {
    const facts = await consignmentFactsOfOrdersInTx(tx, tenantId, ids.slice(i, i + FACT_CHUNK));
    for (const [orderId, fact] of facts) {
      const gate = judgeConsignment(fact, national, todayIst);
      out.set(orderId, { state: gate.state, blocking: gate.blocking, ewayBillNumber: fact.live?.ewayBillNumber ?? null, ewayValidUntil: fact.live?.ewayValidUntil ?? null });
    }
  }
  return out;
}

/** A16 — the gate state of each order (the order list rows). */
export async function consignmentStatesOfOrdersInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, ConsignmentGateState>> {
  const parcels = await parcelConsignmentsInTx(tx, tenantId, orderIds, consignmentTodayIst());
  return new Map([...parcels].map(([id, p]) => [id, p.state]));
}
