import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { bins } from '../../shared/db/schema';
import type { LedgerEvent } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { canonicalInstant } from '../../shared/primitives/time';
import { fromMilli } from '../../shared/primitives/quantity';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { LedgerReferenceDoc } from '../inventory/inventory.facade';
import { OutboundFacade } from '../outbound/outbound.facade';

// ── the response shape ───────────────────────────────────────────────────────

/** One chain hop: a raw ledger row, annotated with its bins' CURRENT classes. */
export interface ColdChainEvent {
  readonly seq: number;
  readonly type: string;
  readonly skuId: string;
  /** Base units at this HTTP edge (story 10.1) — raw rows are milli-units. */
  readonly quantityDelta: number;
  readonly fromBinId: string | null;
  /** The from-bin's CURRENT storage class; null when the bin row is gone. */
  readonly fromBinStorageClass: string | null;
  readonly toBinId: string | null;
  /** The to-bin's CURRENT storage class; null when the bin row is gone. */
  readonly toBinStorageClass: string | null;
  readonly batchRef: string | null;
  readonly serialRef: string | null;
  readonly occurredAt: string;
  /** The typed reference doc verbatim — the ledger context (UX-DR30). */
  readonly referenceDoc: LedgerReferenceDoc;
}

/** One picked scope: a batch or a serial, and its COMPLETE chain. */
export interface ColdChainScope {
  readonly batchRef: string | null;
  readonly serialRef: string | null;
  readonly chain: readonly ColdChainEvent[];
}

/** One dwell-window-correlated excursion, reconstructed from the ledger. */
export interface ColdChainExcursion {
  readonly excursionId: string;
  readonly binId: string;
  /** The operator-captured reading, °C (from the event's reference doc). */
  readonly readingC: number;
  readonly occurredAt: string;
}

/** One order line: what shipped, every picked scope, its excursions. */
export interface ColdChainLine {
  readonly orderLineId: string;
  readonly skuId: string;
  /** Base units (the dispatch reference doc's `dispatchedQty`). */
  readonly dispatchedQty: number;
  readonly scopes: readonly ColdChainScope[];
  readonly excursions: readonly ColdChainExcursion[];
}

/** One bin on a chain: the dictionary the trace UI resolves bin ids with. */
export interface ColdChainBin {
  readonly id: string;
  readonly code: string;
  /** The CURRENT class (12-1 guard makes the annotation honest). */
  readonly storageClass: string;
}

/** The order block: identity + the dispatch's carrier facts, from the ledger. */
export interface ColdChainOrder {
  readonly id: string;
  readonly status: string;
  readonly carrierName: string | null;
  readonly trackingNumber: string | null;
  readonly dispatchedAt: string;
}

export interface ColdChainTrace {
  readonly order: ColdChainOrder;
  readonly bins: readonly ColdChainBin[];
  readonly lines: readonly ColdChainLine[];
}

// ── internals ────────────────────────────────────────────────────────────────

type PickRefDoc = Extract<LedgerReferenceDoc, { kind: 'pick' }>;
type DispatchRefDoc = Extract<LedgerReferenceDoc, { kind: 'dispatch' }>;
type ExcursionRefDoc = Extract<LedgerReferenceDoc, { kind: 'excursion' }>;

/** Casts a raw event's reference doc to one arm — the caller knows the type. */
function refAs<T extends LedgerReferenceDoc>(event: LedgerEvent): T {
  return event.referenceDoc as T;
}

/** First defined value in seq order — the carrier/tracking aggregate. */
function firstDefined<T>(
  events: readonly LedgerEvent[],
  pick: (event: LedgerEvent) => T | undefined,
): T | undefined {
  for (const event of events) {
    const value = pick(event);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * One raw ledger row → one chain hop: canonical instant, base-unit
 * quantity, the bins' CURRENT storage classes from the annotation map.
 */
function toChainEvent(
  event: LedgerEvent,
  binClassById: ReadonlyMap<string, string>,
): ColdChainEvent {
  return {
    seq: event.seq,
    type: event.type,
    skuId: event.skuId,
    quantityDelta: fromMilli(event.quantityDelta),
    fromBinId: event.fromBinId,
    fromBinStorageClass:
      event.fromBinId === null ? null : (binClassById.get(event.fromBinId) ?? null),
    toBinId: event.toBinId,
    toBinStorageClass:
      event.toBinId === null ? null : (binClassById.get(event.toBinId) ?? null),
    batchRef: event.batchRef,
    serialRef: event.serialRef,
    occurredAt: canonicalInstant(event.occurredAt),
    referenceDoc: event.referenceDoc as LedgerReferenceDoc,
  };
}

/** A serial-scope chain rides the serial arm; a batch-scope chain the batch arm. */
function scopeKey(scope: { readonly batchRef: string | null; readonly serialRef: string | null }): string {
  return scope.serialRef !== null ? `s:${scope.serialRef}` : `b:${scope.batchRef ?? ''}`;
}

/**
 * Per-bin dwell windows of one scope's chain: arrival = the earliest event
 * that moved the scope INTO the bin, departure = the latest event that moved
 * it OUT (null = still there — open-ended). Times are epoch millis. A bin the
 * scope visited twice merges its visits into one window — the spec's dwell is
 * [min arrival, max departure] per bin, not per visit.
 */
function dwellWindows(
  chain: readonly ColdChainEvent[],
): Map<string, { arrival: number; departure: number | null }> {
  const windows = new Map<string, { arrival: number; departure: number | null }>();
  for (const event of chain) {
    const occurred = Date.parse(event.occurredAt);
    if (event.toBinId !== null) {
      const existing = windows.get(event.toBinId);
      if (existing === undefined || occurred < existing.arrival) {
        windows.set(event.toBinId, {
          arrival: occurred,
          departure: existing?.departure ?? null,
        });
      }
    }
    if (event.fromBinId !== null) {
      const existing = windows.get(event.fromBinId);
      if (existing === undefined) {
        windows.set(event.fromBinId, { arrival: occurred, departure: occurred });
      } else {
        windows.set(event.fromBinId, {
          arrival: existing.arrival,
          departure:
            existing.departure === null ? occurred : Math.max(existing.departure, occurred),
        });
      }
    }
  }
  // Business times are client-supplied, so a backdated draw can invert a
  // window (departure < arrival) — left alone, the correlation predicate
  // would be unsatisfiable and silently drop every excursion at that bin.
  // Clamp to a point window at the arrival instead: the units provably dwelt
  // AT the arrival instant, and a reading at that instant still correlates.
  for (const [binId, window] of windows) {
    if (window.departure !== null && window.departure < window.arrival) {
      windows.set(binId, { arrival: window.arrival, departure: window.arrival });
    }
  }
  return windows;
}

function orderNotFound(): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Order not found',
    'No order with this id exists in this warehouse.',
  );
}

/**
 * The compliance module's cold-chain read (Story 12-6, FR-45): one
 * READ-ONLY reconstruction of a dispatched order's storage trace from
 * `ledger_events` alone — never from projections, never from the
 * `temperature_excursions` rows. The join chain rides the ledger's own
 * reference docs: `dispatch.dispatched` (orderId) → the `pick.picked` events
 * with the same orderId → those picks' batch/serial scopes → each scope's
 * complete chain via the tenant batch/serial trace indexes.
 *
 * Everything here is a read: the facade composes the inventory facade's
 * in-transaction ledger feeds, a direct `bins` read (the shared-substrate
 * precedent 12-5 set) and the outbound facade's order-identity read — the
 * ledger feeds and the bins read share ONE transaction; the order identity
 * is a separate facade call in its own transaction (AD-6 keeps it outside,
 * sibling state through facades only), so the composite is not a single
 * snapshot. Conversion to the response shape happens at this facade's own
 * edge (`fromMilli` + `canonicalInstant`). No capability gate, no
 * idempotency, no writes.
 */
@Injectable()
export class ColdChainFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
  ) {}

  async getOrderColdChainTrace(
    tenantId: string,
    warehouseId: string,
    orderId: string,
  ): Promise<ColdChainTrace> {
    // Order identity rides the outbound facade (its own transaction — the
    // facade's `getOrder` shape): a missing or foreign order is null, and an
    // order that belongs to a DIFFERENT warehouse of the same tenant is as
    // invisible on this warehouse-scoped route as a missing one.
    const order = await this.outbound.getOrder(tenantId, orderId);
    if (order === null || order.warehouseId !== warehouseId) {
      throw orderNotFound();
    }

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // The warehouse must belong to the tenant (404 otherwise) — the same
      // assertion every warehouse-scoped read takes.
      await assertWarehouseInTenant(tx, tenantId, warehouseId);

      // The dispatch events that say the order shipped. FR-45 names
      // DISPATCHED units: no dispatch events, no trace (409), even though
      // the order row exists.
      const orderEvents = await this.inventory.ledgerEventsByOrderRefInTx(
        tx,
        tenantId,
        warehouseId,
        orderId,
      );
      const dispatchEvents = orderEvents.filter((e) => e.type === 'dispatch.dispatched');
      if (dispatchEvents.length === 0) {
        throw new ProblemException(
          'order-not-dispatched',
          409,
          'Order not dispatched',
          'The order has no dispatch events in the ledger; a cold-chain trace is defined only for dispatched orders.',
        );
      }
      const pickEvents = orderEvents.filter((e) => e.type === 'pick.picked');

      // ── lines from the dispatch events (seq order) ───────────────────────
      // One dispatch event per order line — dispatch is the terminal
      // transition with a single writer and a status guard (dispatch.command),
      // so no dedupe is needed; the loop simply reports what shipped.
      const carrierName = firstDefined(
        dispatchEvents,
        (e) => refAs<DispatchRefDoc>(e).carrierName,
      );
      const trackingNumber = firstDefined(
        dispatchEvents,
        (e) => refAs<DispatchRefDoc>(e).trackingNumber,
      );
      const lines: { orderLineId: string; skuId: string; dispatchedQty: number }[] = [];
      const lineSkuIds = new Set<string>();
      for (const dispatchEvent of dispatchEvents) {
        const ref = refAs<DispatchRefDoc>(dispatchEvent);
        lines.push({
          orderLineId: ref.orderLineId,
          skuId: dispatchEvent.skuId,
          dispatchedQty: ref.dispatchedQty,
        });
        lineSkuIds.add(dispatchEvent.skuId);
      }

      // ── scopes from the picks (seq order = pick order) ───────────────────
      // A serial pick names exactly one serial (one event per unit); a batch
      // pick names one batch (one event per allocation arm). Distinct
      // (batch, serial) pairs per line, first-seen order.
      const scopesByLine = new Map<
        string,
        { batchRef: string | null; serialRef: string | null }[]
      >();
      const batchRefs: string[] = [];
      const serialRefs: string[] = [];
      for (const pickEvent of pickEvents) {
        const ref = refAs<PickRefDoc>(pickEvent);
        // A serial-tracked SKU's pick events carry only the serial arm (the
        // pick command refuses a SKU tracked both ways); a batch pick carries
        // only the batch arm.
        const batchRef = pickEvent.serialRef === null ? pickEvent.batchRef : null;
        const serialRef = pickEvent.serialRef;
        if (batchRef === null && serialRef === null) {
          continue; // a pick whose identity arms are both null contributes no scope
        }
        const scopeList = scopesByLine.get(ref.orderLineId) ?? [];
        if (!scopeList.some((s) => s.batchRef === batchRef && s.serialRef === serialRef)) {
          scopeList.push({ batchRef, serialRef });
          scopesByLine.set(ref.orderLineId, scopeList);
          if (batchRef !== null) {
            batchRefs.push(batchRef);
          }
          if (serialRef !== null) {
            serialRefs.push(serialRef);
          }
        }
      }

      // ── per-scope chains: each scope's COMPLETE batch/serial history ─────
      // (other orders' picks included — the batch's history is the batch's
      // history). One query for every scope of the order; the grouping below
      // matches each event to its scope key. Serial-armed events group under
      // their serial; batch-armed events under their batch (the pick command
      // refuses a SKU tracked both ways — pick.command.ts — so an event
      // carries one arm at most).
      const scopeEvents = await this.inventory.ledgerEventsByScopeRefsInTx(
        tx,
        tenantId,
        warehouseId,
        { batchRefs, serialRefs },
      );
      const eventsByScope = new Map<string, LedgerEvent[]>();
      for (const event of scopeEvents) {
        const key =
          event.serialRef !== null
            ? `s:${event.serialRef}`
            : event.batchRef !== null
              ? `b:${event.batchRef}`
              : null; // no identity arm — belongs to no scope chain
        if (key === null) {
          continue;
        }
        const list = eventsByScope.get(key) ?? [];
        list.push(event);
        eventsByScope.set(key, list);
      }

      // ── the bins annotation map + dictionary ─────────────────────────────
      // A direct `bins` read (the 12-5 precedent): every bin id any chain
      // event touches, with its CURRENT class — the annotation is
      // honest-by-construction (12-1/12-3 refuse a class change that would
      // strand stock; temperature classes may only have moved colder), and a
      // bin whose row is gone annotates null rather than a fabricated class.
      const binIds = new Set<string>();
      for (const event of scopeEvents) {
        if (event.fromBinId !== null) binIds.add(event.fromBinId);
        if (event.toBinId !== null) binIds.add(event.toBinId);
      }
      const binRows =
        binIds.size === 0
          ? []
          : await tx
              .select({
                id: bins.id,
                code: bins.code,
                storageClass: bins.storageClass,
              })
              .from(bins)
              .where(
                and(
                  eq(bins.tenantId, tenantId),
                  eq(bins.warehouseId, warehouseId),
                  inArray(bins.id, [...binIds]),
                ),
              );
      const binClassById = new Map(binRows.map((row) => [row.id, row.storageClass]));
      const binsDictionary: ColdChainBin[] = binRows
        .map((row) => ({ id: row.id, code: row.code, storageClass: row.storageClass }))
        .sort((a, b) => a.code.localeCompare(b.code));

      const chainsByScope = new Map<string, ColdChainEvent[]>();
      for (const [key, events] of eventsByScope) {
        chainsByScope.set(key, events.map((event) => toChainEvent(event, binClassById)));
      }

      // ── excursion correlation: dwell windows per (scope, bin) ────────────
      // An `excursion.recorded` event attaches to a scope when its skuId
      // matches the scope's line, its reference doc's binId is a bin on the
      // scope's chain, and its business time falls inside that bin's dwell
      // window — [first arrival (to_bin_id = bin), last departure
      // (from_bin_id = bin)], open-ended when the scope never left (its last
      // event at the bin is the draw itself). One event per AFFECTED (sku,
      // bin) scope is written (12-5), so the scope link is skuId + dwell
      // window — the excursion arm carries no batch/serial.
      const excursionEvents = await this.inventory.ledgerExcursionEventsBySkuInTx(
        tx,
        tenantId,
        warehouseId,
        [...lineSkuIds],
      );

      const traceLines: ColdChainLine[] = lines.map((line) => {
        const scopeList = scopesByLine.get(line.orderLineId) ?? [];
        const scopes: ColdChainScope[] = scopeList.map((scope) => ({
          batchRef: scope.batchRef,
          serialRef: scope.serialRef,
          chain: chainsByScope.get(scopeKey(scope)) ?? [],
        }));
        // Dedupe by excursionId across the line's scopes — two scopes that
        // dwelt in the same bin correlate the same excursion, and the
        // excursion appears EXACTLY ONCE per line.
        const seenExcursionIds = new Set<string>();
        const excursions: ColdChainExcursion[] = [];
        for (const scope of scopes) {
          const dwell = dwellWindows(scope.chain);
          for (const excursionEvent of excursionEvents) {
            if (excursionEvent.skuId !== line.skuId) {
              continue;
            }
            const ref = refAs<ExcursionRefDoc>(excursionEvent);
            const window = dwell.get(ref.binId);
            if (window === undefined) {
              continue; // the bin is not on this scope's chain
            }
            const occurred = Date.parse(excursionEvent.occurredAt);
            const inWindow =
              occurred >= window.arrival &&
              (window.departure === null || occurred <= window.departure);
            if (!inWindow || seenExcursionIds.has(ref.excursionId)) {
              continue; // outside the dwell, or already correlated for this line
            }
            seenExcursionIds.add(ref.excursionId);
            excursions.push({
              excursionId: ref.excursionId,
              binId: ref.binId,
              readingC: ref.readingC,
              occurredAt: canonicalInstant(excursionEvent.occurredAt),
            });
          }
        }
        excursions.sort(
          (a, b) =>
            Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
            a.excursionId.localeCompare(b.excursionId),
        );
        return { ...line, scopes, excursions };
      });

      // ── assemble ─────────────────────────────────────────────────────────
      const firstDispatch = dispatchEvents[0]!;
      return {
        order: {
          id: order.id,
          status: order.status,
          carrierName: carrierName ?? null,
          trackingNumber: trackingNumber ?? null,
          dispatchedAt: canonicalInstant(firstDispatch.occurredAt),
        },
        bins: binsDictionary,
        lines: traceLines,
      };
    });
  }
}