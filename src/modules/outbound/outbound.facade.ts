import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { warehouseFilter, type ClientCountScope } from '../../shared/db/warehouse-filter';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { getClientsInTx } from '../clients/clients.facade';
import {
  handlingUnits,
  manifests,
  orderLines,
  orders,
  picks,
  shipments,
  skus,
  wavePolicies,
  waves,
} from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { addressFromColumns } from '../../shared/primitives/address';
import type { AddressSnapshot } from '../../shared/primitives/address';
import { fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import {
  listBackorderRefusalsInTx,
  listPackFailuresInTx,
  listPicklistLinesInTx,
} from './fact-lists';
import type {
  BackorderRefusalEntry,
  PackFailureEntry,
  PicklistLineEntry,
  WindowFilter,
} from './fact-lists';
import type { PicklistLineStatus } from './wave.command';

import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { OrderCommandService } from './order.command';
import type {
  CancelOrderCommand,
  CreateOrderCommand,
  OrderSnapshot,
  OrderSource,
  OrderStatus,
} from './order.command';

// The command/snapshot vocabulary rides the facade seam for sibling modules
// (the architecture guard allows only facade/module/dto specifiers); these
// are type-only re-exports — the command service stays outbound-owned.
export type {
  CancelOrderCommand,
  CreateOrderCommand,
  OrderSnapshot,
  OrderSource,
  OrderStatus,
};
import { WaveCommandService, policySnapshot } from './wave.command';
import { PickCommandService } from './pick.command';
import type { PickSnapshot, PickTask, RecordPickCommand } from './pick.command';
import { PackCommandService } from './pack.command';
import type { PackOrderCommand, PackSnapshot } from './pack.command';
import { DispatchCommandService } from './dispatch.command';
import type { DispatchOrderCommand, DispatchSnapshot } from './dispatch.command';
import { ShipmentCommandService } from './shipment.command';
import type { CreateShipmentLabelCommand, ShipmentSnapshot, ShipmentStatus } from './shipment.command';
import { ManifestCommandService } from './manifest.command';
import type { CreateManifestCommand, ManifestSnapshot } from './manifest.command';
import { RateService } from './rate.service';
import type { OrderRatesSnapshot } from './rate.service';
import type {
  CreateWavePolicyCommand,
  GenerateWaveCommand,
  WaveGrouping,
  WavePolicySnapshot,
  WavePolicySnapshotBody,
  WaveSnapshot,
  WaveStatus,
  WaveTransitionCommand,
} from './wave.command';

// Story 9-1 — the dashboard fact-list row types ride the facade seam.
export type { BackorderRefusalEntry, PackFailureEntry, PicklistLineEntry };

/** One header row of the order-list read (no lines — detail carries them). */
export interface OrderEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly status: OrderStatus;
  readonly source: OrderSource;
  readonly integrationId: string | null;
  readonly externalEventId: string | null;
  /** Where the shipment goes (story 11-1); null on a pre-11.1 order row. */
  readonly destination: AddressSnapshot | null;
  /** Story 21-2b — the client the order is for (derived from its SKUs). */
  readonly clientId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListOrdersQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * Story 9-1 — the order list's dashboard drill filters (all optional,
 * additive). The window is on `created_at` (server-stamped), `[from, to)`.
 * `backordered` asks whether ANY line of the order was created `backordered`
 * (the status is set only at acceptance) — counted per ORDER, so a kit's
 * backordered parent and children never count it twice.
 */
export interface ListOrdersFilter extends ListOrdersQuery {
  readonly status?: OrderStatus | undefined;
  readonly source?: OrderSource | undefined;
  readonly backordered?: boolean | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** Story 9-1 — the windowed fact-list reads (pack failures, refusals, picklist lines). */
export interface ListWindowQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** One header row of the wave-list read (no picklists — detail carries them). */
export interface WaveEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly policyId: string;
  readonly status: WaveStatus;
  readonly releasedAt: string | null;
  readonly cancelledAt: string | null;
  /** Picklists on this wave (the list's at-a-glance size, no N+1 detail read). */
  readonly picklistCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The device's pack bench unit of work (story 10.7, additive): ONE
 * fully-picked order's per-SKU picked totals — the dataset the bench
 * pre-verifies its scan against, offline. A pack task exists per (order,
 * SKU) that actually moved units; the shape mirrors what
 * `PackCommandService.assertScanMatchesPicked` compares (`picks` grouped by
 * (order, sku), base units at the edge), so the device's exact-match gate
 * verifies against the same numbers the server will.
 */
export interface PackTask {
  readonly orderId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  /** What the order actually had PICKED, in base units (a whole count at the bench). */
  readonly pickedQty: number;
  /**
   * Story 10.3: the SKU is handled by unit — the bench must scan each
   * case's label and the count must equal `pickedQty`, never a typed quantity.
   */
  readonly catchWeightTracked: boolean;
}

/**
 * One `active` handling unit of the warehouse (story 10.7, additive): the
 * id + skuId pair the bench resolves a catch-weight case label against,
 * offline. Active-only self-prunes — a unit flips to `packed` at pack —
 * so the array is bounded by received-not-yet-packed stock. DELIBERATELY
 * uncapped: a unit the snapshot omits is a real case the bench would refuse
 * to scan (its unknown-id gate), so an artificial ceiling here would
 * queue-and-die a legitimate scan — the exact hole this array exists to close.
 */
export interface CatalogHandlingUnit {
  readonly id: string;
  readonly skuId: string;
}

/** The snapshot's pack arm, read in ONE transaction (one consistent read). */
export interface PackWorkRead {
  readonly packTasks: readonly PackTask[];
  readonly handlingUnits: readonly CatalogHandlingUnit[];
}

export const DEFAULT_OUTBOUND_PAGE_SIZE = 50;

// ── invoicing's dispatch-facts read (Story 8-1) ───────────────────────────

/**
 * One order line's INVOICE FACTS (what `orderInvoiceFactsInTx` hands the
 * invoicing module): the ordered qty, the DISPATCHED qty re-derived from
 * `picks` (generation re-derives from persisted facts — never trusts the
 * event payload), the SKU's GST data as it stood at the read, and the
 * frozen-acceptance rate (null on an unpriced line — parks `awaiting-data`).
 * Kit composition rides `parentLineId`; the invoicing generator drops
 * zero-picked kit parents at its own boundary.
 */
export interface OrderInvoiceLineFact {
  readonly orderLineId: string;
  readonly parentLineId: string | null;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly hsn: string | null;
  readonly gstRateBps: number;
  readonly uom: string;
  readonly orderedQtyMilli: number;
  /** Sum of this line's picks, in milli-units (zero when the line has none — a kit parent). */
  readonly dispatchedQtyMilli: number;
  readonly ratePaise: number | null;
}

/** One order's full invoicing fact set, read in ONE transaction. */
export interface OrderInvoiceFacts {
  readonly orderId: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly status: OrderStatus;
  readonly consigneeGstin: string | null;
  /** Story 8-1d — the buyer's legal / trade name; null = print the contact name. */
  readonly consigneeLegalName: string | null;
  readonly destination: AddressSnapshot | null;
  readonly createdAt: string;
  /**
   * Story 21-2b (decision 5) — whether the order's client is the tenant's
   * OWN (`system_owned`). A client brand's order is NOT GST-invoiced by the
   * 3PL: the brand sells its goods and invoices its own customer; invoicing
   * on a client's behalf is PENDING. `null` when the order's client row is
   * MISSING — a data fault, never read as "a client brand".
   */
  readonly clientSystemOwned: boolean | null;
  readonly lines: readonly OrderInvoiceLineFact[];
}

/**
 * The cap on the snapshot's pack tasks (the `MAX_SNAPSHOT_PICK_TASKS`
 * precedent), truncated on ORDER boundaries so no order is ever
 * half-delivered — a bench that saw one SKU of a two-SKU order could never
 * reach the exact match its commit gate requires.
 */
export const MAX_SNAPSHOT_PACK_TASKS = 500;

/**
 * Caps an over-read at `max`, cutting only on GROUP boundaries (the rows
 * arrive ordered by group; `keyOf` names the group a row belongs to). A
 * half-delivered group is exactly what the cap must never emit — the pack
 * bench's exact-match gate needs EVERY SKU of an order, so the order
 * straddling the ceiling is dropped whole (the `truncateToWholePicklists`
 * shape, extracted parameterized by the group key so the boundary is
 * unit-testable without seeding five hundred pack lines — review W8/W9,
 * story 10.7).
 *
 * The one exception, and the reason this is a named function: when a SINGLE
 * group occupies the entire ceiling on its own, dropping it whole would hand
 * the devices an empty snapshot while packable work exists. There, a
 * truncated group beats no group — the group is kept at the ceiling,
 * TRUNCATED (never "returned as it is": the rows past the ceiling are cut,
 * and the device's exact-match gate simply never sees a count it cannot
 * reconcile against a snapshot that omits them). Pure.
 */
export function truncateToWholeGroups<T>(
  overRead: readonly T[],
  max: number,
  keyOf: (row: T) => string,
): T[] {
  if (overRead.length <= max) {
    return [...overRead];
  }
  const kept = overRead.slice(0, max);
  const straddling = keyOf(kept[kept.length - 1]!);
  // The cut fell inside `straddling` only if that group also has a row
  // beyond the ceiling (the pick precedent's `overRead[max]` check — NOT the
  // over-read's last row: a straddling order followed by other orders still
  // straddles).
  if (keyOf(overRead[max]!) !== straddling) {
    return kept;
  }
  const whole = kept.filter((row) => keyOf(row) !== straddling);
  // Never hand back nothing while packable work exists.
  return whole.length === 0 ? kept : whole;
}

/**
 * The cursor is opaque to clients but crafted input is still possible — a
 * base64-valid payload with a non-uuid `id` would otherwise reach the
 * `::uuid` cast in SQL and surface as a 500 instead of a 400 (the
 * `decodeCursorSafe` pattern; the shared `UUID_RE` is retro A3's one
 * matcher).
 */
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    const malformedCursor =
      !UUID_RE.test(decoded.id) ||
      !CURSOR_INSTANT_RE.test(decoded.createdAt) ||
      Number.isNaN(Date.parse(decoded.createdAt));
    if (malformedCursor) {
      throw new Error('malformed cursor payload');
    }
    return decoded;
  } catch {
    throw new ProblemException(
      'invalid-cursor',
      400,
      'Malformed pagination cursor',
      'The cursor parameter is not a valid opaque page cursor.',
    );
  }
}

/** One header row of the manifest-list read (Story 4.6c). */
export interface ManifestEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly carrierConnectionId: string;
  readonly carrierCode: string;
  readonly shipmentCount: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The row → view mapping the read-back and the snapshot share (4.6c). */
function toShipmentView(row: typeof shipments.$inferSelect): ShipmentSnapshot['shipment'] {
  return {
    id: row.id,
    orderId: row.orderId,
    tenantId: row.tenantId,
    warehouseId: row.warehouseId,
    status: row.status as ShipmentStatus,
    carrierConnectionId: row.carrierConnectionId,
    carrierCode: row.carrierCode,
    carrierName: row.carrierName,
    trackingNumber: row.trackingNumber,
    labelDocumentRef: row.labelDocumentRef,
    weightGrams: row.weightGrams,
    dimensionsMm:
      row.lengthMm !== null && row.widthMm !== null && row.heightMm !== null
        ? { lengthMm: row.lengthMm, widthMm: row.widthMm, heightMm: row.heightMm }
        : null,
    labelledBy: row.labelledBy,
    labelledAt: canonicalInstant(row.labelledAt),
    manifestId: row.manifestId,
  };
}

/**
 * The outbound module's public surface (Story 4.1): the ONLY way any other
 * module — or the api shell — consumes order state. The `orders` /
 * `order_lines` tables are module-exclusive; the architecture test fails
 * any write from outside this module. Stock composition stays the inventory
 * facade's (the reservation holds are read through `reservationsByIdsInTx`).
 */
@Injectable()
export class OutboundFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OrderCommandService) private readonly orderCommand: OrderCommandService,
    @Inject(WaveCommandService) private readonly waveCommand: WaveCommandService,
    @Inject(PickCommandService) private readonly pickCommand: PickCommandService,
    @Inject(PackCommandService) private readonly packCommand: PackCommandService,
    @Inject(DispatchCommandService) private readonly dispatchCommand: DispatchCommandService,
    @Inject(ShipmentCommandService) private readonly shipmentCommand: ShipmentCommandService,
    @Inject(ManifestCommandService) private readonly manifestCommand: ManifestCommandService,
    @Inject(RateService) private readonly rateService: RateService,
  ) {}

  /** `POST .../outbound/orders/{orderId}/label` — the 4.6c label command. */
  async createShipmentLabel(
    command: CreateShipmentLabelCommand,
    idempotencyKey: string,
  ): Promise<ShipmentSnapshot> {
    return this.shipmentCommand.createShipmentLabel(command, idempotencyKey);
  }

  /** `POST .../warehouses/{wid}/outbound/manifests` — the 4.6c manifest command. */
  async createManifest(
    command: CreateManifestCommand,
    idempotencyKey: string,
  ): Promise<ManifestSnapshot> {
    return this.manifestCommand.createManifest(command, idempotencyKey);
  }

  /**
   * The order's shipment read-back (Story 4.6c): the one shipment record an
   * order's label arc produced, whatever arm it now reads. Unknown or
   * foreign order id — or an order never labelled — is null → the api layer
   * 404s (the `getOrder` shape). A read — never capability-gated.
   */
  async getShipmentForOrder(tenantId: string, orderId: string): Promise<ShipmentSnapshot['shipment'] | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(shipments)
        .where(and(eq(shipments.tenantId, tenantId), eq(shipments.orderId, orderId)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return toShipmentView(row);
    });
  }

  /**
   * The order's rate-shopping read (Story 4.6d): one quoted-or-refused item
   * per live carrier connection, recomputed per request and never stored.
   * Unknown or foreign order id is null → the api layer 404s (the
   * `getShipmentForOrder` shape). A read — never capability-gated.
   */
  async getOrderRates(tenantId: string, orderId: string): Promise<OrderRatesSnapshot | null> {
    return this.rateService.getOrderRates(tenantId, orderId);
  }

  /** `POST .../outbound/orders` — manual entry and (adapter-ready) ingestion. */
  async createOrder(command: CreateOrderCommand, idempotencyKey: string): Promise<OrderSnapshot> {
    return this.orderCommand.createOrder(command, idempotencyKey);
  }

  /** `POST .../outbound/orders/{id}/cancel` — releases every open hold. */
  async cancelOrder(command: CancelOrderCommand, idempotencyKey: string): Promise<OrderSnapshot> {
    return this.orderCommand.cancelOrder(command, idempotencyKey);
  }

  /**
   * Story 7.2 (RD-1/RD-8): the order a channel ref resolves to, or null —
   * the cancellation ingest's lookup and the ingest command's `replayed`
   * redelivery determination. Scoped to (tenant, integration, external
   * event id) — the same identity the dedup index is partial over.
   */
  async findOrderByChannelRef(
    tenantId: string,
    integrationId: string,
    externalEventId: string,
  ): Promise<OrderEntry | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: orders.id,
          tenantId: orders.tenantId,
          warehouseId: orders.warehouseId,
          status: orders.status,
          source: orders.source,
          integrationId: orders.integrationId,
          externalEventId: orders.externalEventId,
          clientId: orders.clientId,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
        })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.integrationId, integrationId),
            eq(orders.externalEventId, externalEventId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        id: row.id,
        tenantId: row.tenantId,
        warehouseId: row.warehouseId,
        status: row.status as OrderStatus,
        source: row.source as OrderSource,
        integrationId: row.integrationId,
        externalEventId: row.externalEventId,
        destination: null,
        clientId: row.clientId,
        createdAt: canonicalInstant(row.createdAt),
        updatedAt: canonicalInstant(row.updatedAt),
      };
    });
  }

  /**
   * Story 7.2 (RD-7): ONE consistent re-read of an order and its lines for
   * the writeback delivery — the source of truth the delivery derives its
   * arm request from (never the event payload's word). Unknown or foreign
   * id is null (the delivery ACKs — the order cannot have moved anywhere).
   */
  async orderForWriteback(tenantId: string, orderId: string): Promise<OrderSnapshot['order'] | null> {
    return this.getOrder(tenantId, orderId);
  }

  // (the invoicing facts read's methods follow — story 8-1)

  /**
   * The dispatch facts invoicing's generator derives an invoice from (story
   * 8-1): the order header (status, consignee GSTIN, destination address) and
   * its lines with the SKU join and the per-line picks sum — the "picks
   * re-derived by the handler" rule, never the event payload's word. In-tx
   * ONLY (the `getPickTasksInTx` reason verbatim: the generation composes
   * this read with tenancy party facts and its own writes in ONE tenant
   * transaction; a pool-opening sibling would reserve a second connection
   * while the outer one is held). A READ — sku joins are precedented
   * (`pick.command.ts`); the architecture guard binds WRITES only.
   *
   * Unknown or foreign order id is null — the invoicing command maps that to
   * its 404 arm and the delivery handler ACKs.
   */
  async orderInvoiceFactsInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<OrderInvoiceFacts | null> {
    const rows = await tx
      .select({
        id: orders.id,
        tenantId: orders.tenantId,
        warehouseId: orders.warehouseId,
        status: orders.status,
        consigneeGstin: orders.consigneeGstin,
        consigneeLegalName: orders.consigneeLegalName,
        destinationContactName: orders.destinationContactName,
        destinationPhone: orders.destinationPhone,
        destinationLine1: orders.destinationLine1,
        destinationLine2: orders.destinationLine2,
        destinationCity: orders.destinationCity,
        destinationState: orders.destinationState,
        destinationPincode: orders.destinationPincode,
        createdAt: orders.createdAt,
        clientId: orders.clientId,
      })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    const order = rows[0];
    if (order === undefined) {
      return null;
    }

    // Lines + sku join + the picks sum. `::bigint` — an int4 sum overflows
    // (the pack-read's own lesson); int8 comes back as a string and
    // `Number(...)` is the boundary coercion. A line with no pick rows sums
    // to NULL (left join) — a zero-picked kit parent, dropped by the
    // generator, never a 500. Primary-key columns ride the group by so
    // Postgres's functional dependency admits the other selected columns.
    const lines = await tx
      .select({
        orderLineId: orderLines.id,
        parentLineId: orderLines.parentLineId,
        skuId: orderLines.skuId,
        skuCode: skus.code,
        skuName: skus.name,
        hsn: skus.hsn,
        gstRateBps: skus.gstRateBps,
        uom: skus.uom,
        orderedQtyMilli: orderLines.qty,
        ratePaise: orderLines.ratePaise,
        dispatchedQtySum: sql<string | null>`sum(${picks.qty})::bigint`,
      })
      .from(orderLines)
      .innerJoin(skus, and(eq(skus.id, orderLines.skuId), eq(skus.tenantId, orderLines.tenantId)))
      .leftJoin(picks, and(eq(picks.orderLineId, orderLines.id), eq(picks.tenantId, orderLines.tenantId)))
      .where(and(eq(orderLines.orderId, orderId), eq(orderLines.tenantId, tenantId)))
      .groupBy(orderLines.id, skus.id)
      .orderBy(asc(orderLines.createdAt), asc(orderLines.id));

    return {
      orderId: order.id,
      tenantId: order.tenantId,
      warehouseId: order.warehouseId,
      status: order.status as OrderStatus,
      consigneeGstin: order.consigneeGstin,
      consigneeLegalName: order.consigneeLegalName,
      destination: addressFromColumns({
        contactName: order.destinationContactName,
        phone: order.destinationPhone,
        line1: order.destinationLine1,
        line2: order.destinationLine2,
        city: order.destinationCity,
        state: order.destinationState,
        pincode: order.destinationPincode,
      }),
      createdAt: canonicalInstant(order.createdAt),
      // Story 21-2b: the client's ownership flag, through the clients
      // module's read seam (one primary-key probe). A missing client row is
      // `null` — the generator reports it as a data fault, distinct from the
      // designed client-brand skip.
      clientSystemOwned: (await getClientsInTx(tx, tenantId, [order.clientId])).get(order.clientId)?.systemOwned ?? null,
      lines: lines.map((line) => ({
        orderLineId: line.orderLineId,
        parentLineId: line.parentLineId,
        skuId: line.skuId,
        skuCode: line.skuCode,
        skuName: line.skuName,
        hsn: line.hsn,
        gstRateBps: line.gstRateBps,
        uom: line.uom,
        orderedQtyMilli: line.orderedQtyMilli,
        dispatchedQtyMilli: line.dispatchedQtySum === null ? 0 : Number(line.dispatchedQtySum),
        ratePaise: line.ratePaise,
      })),
    };
  }

  /**
   * Order-detail read (Story 4.1): one order with its lines — per line the
   * ordered / reserved / derived shortfall quantities and the hold's live
   * journal state (read through the inventory facade inside this
   * transaction). The existence check precedes the line query (the
   * inventory.facade CHECKPOINT 1 shape): an unknown or foreign order id is
   * null → the api layer 404s.
   */
  async getOrder(tenantId: string, orderId: string): Promise<OrderSnapshot['order'] | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
        .limit(1);
      const order = rows[0];
      if (order === undefined) {
        return null;
      }
      return (await this.snapshotOf(tx, order)).order;
    });
  }

  /**
   * Warehouse-scoped order list (Story 4.1): keyset cursor pagination over
   * `(created_at, id)` (offset pagination is banned — UX-DR25), newest
   * first, headers only — the detail read carries the lines. A read —
   * never capability-gated; the warehouse must belong to the tenant (404
   * otherwise).
   */
  async listOrders(
    tenantId: string,
    warehouseId: string,
    query: ListOrdersFilter = {},
  ): Promise<Page<OrderEntry>> {
    const pageSize = query.limit ?? DEFAULT_OUTBOUND_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      // Story 9-1 — "any line created backordered" (table-qualified by hand:
      // an unqualified column in a correlated subquery resolves against the
      // INNER from-list — Gotcha 9).
      const anyBackordered = sql`exists (select 1 from order_lines ol where ol.tenant_id = ${orders.tenantId} and ol.order_id = ${orders.id} and ol.status = 'backordered')`;
      const rows = await tx
        .select({
          id: orders.id,
          tenantId: orders.tenantId,
          warehouseId: orders.warehouseId,
          status: orders.status,
          source: orders.source,
          integrationId: orders.integrationId,
          externalEventId: orders.externalEventId,
          // Story 11-1: the list row carries the destination (city + pincode
          // are what the dispatch surface shows first); pre-11.1 rows null.
          destinationContactName: orders.destinationContactName,
          destinationPhone: orders.destinationPhone,
          destinationLine1: orders.destinationLine1,
          destinationLine2: orders.destinationLine2,
          destinationCity: orders.destinationCity,
          destinationState: orders.destinationState,
          destinationPincode: orders.destinationPincode,
          clientId: orders.clientId,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
          // Story 9-1: the cursor carries the FULL-precision instant (a
          // millisecond-truncated one skips same-millisecond rows, and a
          // drill paged to exhaustion must see every row).
          createdAtText: sql<string>`${orders.createdAt}::text`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.warehouseId, warehouseId),
            query.status === undefined ? undefined : eq(orders.status, query.status),
            query.source === undefined ? undefined : eq(orders.source, query.source),
            query.backordered === undefined
              ? undefined
              : query.backordered
                ? anyBackordered
                : sql`not ${anyBackordered}`,
            query.from === undefined ? undefined : sql`${orders.createdAt} >= ${query.from}::timestamptz`,
            query.to === undefined ? undefined : sql`${orders.createdAt} < ${query.to}::timestamptz`,
            before === undefined
              ? undefined
              : sql`(${orders.createdAt}, ${orders.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        warehouseId: row.warehouseId,
        status: row.status as OrderStatus,
        source: row.source as OrderSource,
        integrationId: row.integrationId,
        externalEventId: row.externalEventId,
        destination: addressFromColumns({
          contactName: row.destinationContactName,
          phone: row.destinationPhone,
          line1: row.destinationLine1,
          line2: row.destinationLine2,
          city: row.destinationCity,
          state: row.destinationState,
          pincode: row.destinationPincode,
        }),
        clientId: row.clientId,
        createdAt: canonicalInstant(row.createdAt),
        updatedAt: canonicalInstant(row.updatedAt),
      }));
      const page = buildPage(
        rows.map((row, index) => ({
          createdAt: fullPrecisionInstant(row.createdAtText),
          id: row.id,
          entry: items[index]!,
        })),
        pageSize,
      );
      return { items: page.items.map((wrapped) => wrapped.entry), nextCursor: page.nextCursor };
    });
  }

  // ── story 9-1: the dashboard's outbound fact lists ────────────────────────

  /** `GET …/outbound/pack-failures` — failed pack verifications, newest first. */
  async listPackFailures(
    tenantId: string,
    warehouseId: string,
    query: ListWindowQuery = {},
  ): Promise<Page<PackFailureEntry>> {
    const filter = this.windowFilter(query);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      return listPackFailuresInTx(tx, tenantId, warehouseId, filter);
    });
  }

  /** `GET …/outbound/backorder-refusals` — channel orders refused under the reject policy. */
  async listBackorderRefusals(
    tenantId: string,
    warehouseId: string,
    query: ListWindowQuery = {},
  ): Promise<Page<BackorderRefusalEntry>> {
    const filter = this.windowFilter(query);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      return listBackorderRefusalsInTx(tx, tenantId, warehouseId, filter);
    });
  }

  /** `GET …/outbound/picklist-lines` — picklist lines by status, windowed on `updated_at`. */
  async listPicklistLines(
    tenantId: string,
    warehouseId: string,
    query: ListWindowQuery & { readonly status?: PicklistLineStatus | undefined } = {},
  ): Promise<Page<PicklistLineEntry>> {
    const filter = { ...this.windowFilter(query), status: query.status };
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      return listPicklistLinesInTx(tx, tenantId, warehouseId, filter);
    });
  }

  private windowFilter(query: ListWindowQuery): WindowFilter {
    return {
      from: query.from,
      to: query.to,
      cursor: query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor),
      limit: query.limit ?? DEFAULT_OUTBOUND_PAGE_SIZE,
    };
  }

  // ── waves and picklists (Story 4.2) ───────────────────────────────────────

  /** `POST .../outbound/wave-policies` — the rule a wave is generated under. */
  async createWavePolicy(
    command: CreateWavePolicyCommand,
    idempotencyKey: string,
  ): Promise<WavePolicySnapshot> {
    return this.waveCommand.createWavePolicy(command, idempotencyKey);
  }

  /** `POST .../outbound/waves` — gathers accepted orders into picklists. */
  async generateWave(command: GenerateWaveCommand, idempotencyKey: string): Promise<WaveSnapshot> {
    return this.waveCommand.generateWave(command, idempotencyKey);
  }

  /** `POST .../outbound/waves/{id}/release` — makes the wave the floor's work. */
  async releaseWave(command: WaveTransitionCommand, idempotencyKey: string): Promise<WaveSnapshot> {
    return this.waveCommand.releaseWave(command, idempotencyKey);
  }

  /** `POST .../outbound/waves/{id}/cancel` — frees its orders to be re-waved. */
  async cancelWave(command: WaveTransitionCommand, idempotencyKey: string): Promise<WaveSnapshot> {
    return this.waveCommand.cancelWave(command, idempotencyKey);
  }

  /**
   * Wave-detail read (Story 4.2): one wave with its picklists and every pick
   * line in WALK ORDER (`bins.code` ascending — bins carry no spatial data).
   * The existence check precedes the picklist query (the CHECKPOINT 1
   * shape): an unknown or foreign wave id is null → the api layer 404s.
   */
  async getWave(tenantId: string, waveId: string): Promise<WaveSnapshot['wave'] | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(waves)
        .where(and(eq(waves.id, waveId), eq(waves.tenantId, tenantId)))
        .limit(1);
      const wave = rows[0];
      if (wave === undefined) {
        return null;
      }
      // One serializer for reads and writes alike (the `snapshotOf` rule).
      return (await this.waveCommand.snapshotOf(tx, wave)).wave;
    });
  }

  /**
   * Warehouse-scoped wave list (Story 4.2): keyset cursor pagination over
   * `(created_at, id)` from day one (offset pagination is banned — UX-DR25),
   * newest first, headers only — the detail read carries the picklists. A
   * read — never capability-gated; the warehouse must belong to the tenant.
   */
  async listWaves(
    tenantId: string,
    warehouseId: string,
    query: ListOrdersQuery = {},
  ): Promise<Page<WaveEntry>> {
    const pageSize = query.limit ?? DEFAULT_OUTBOUND_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await tx
        .select({
          id: waves.id,
          tenantId: waves.tenantId,
          warehouseId: waves.warehouseId,
          policyId: waves.policyId,
          status: waves.status,
          releasedAt: waves.releasedAt,
          cancelledAt: waves.cancelledAt,
          createdAt: waves.createdAt,
          updatedAt: waves.updatedAt,
          // Table-qualified by hand: an unqualified `id` inside this
          // correlated subquery is ambiguous, and Postgres resolves an
          // ambiguous name against the INNER from list — `pl.id` — which
          // silently counts nothing rather than erroring. Naming `waves.id`
          // says which one is meant. (The `where`-clause fragments elsewhere
          // in this story pass drizzle column references instead, which
          // render qualified; verified against the pinned 0.45.2.)
          picklistCount: sql<number>`(
            select count(*)::int from picklists pl where pl.wave_id = waves.id
          )`,
        })
        .from(waves)
        .where(
          and(
            eq(waves.tenantId, tenantId),
            eq(waves.warehouseId, warehouseId),
            before === undefined
              ? undefined
              : sql`(${waves.createdAt}, ${waves.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(waves.createdAt), desc(waves.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        ...row,
        status: row.status as WaveStatus,
        releasedAt: row.releasedAt === null ? null : canonicalInstant(row.releasedAt),
        cancelledAt: row.cancelledAt === null ? null : canonicalInstant(row.cancelledAt),
        createdAt: canonicalInstant(row.createdAt),
        updatedAt: canonicalInstant(row.updatedAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * Warehouse-scoped manifest list (Story 4.6c): keyset cursor pagination
   * over `(created_at, id)` (offset is banned — UX-DR25), newest first,
   * header rows only. A read — never capability-gated; the warehouse must
   * belong to the tenant (404 otherwise).
   */
  async listManifests(
    tenantId: string,
    warehouseId: string,
    query: ListOrdersQuery = {},
  ): Promise<Page<ManifestEntry>> {
    const pageSize = query.limit ?? DEFAULT_OUTBOUND_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await tx
        .select({
          id: manifests.id,
          tenantId: manifests.tenantId,
          warehouseId: manifests.warehouseId,
          carrierConnectionId: manifests.carrierConnectionId,
          carrierCode: manifests.carrierCode,
          shipmentCount: manifests.shipmentCount,
          createdBy: manifests.createdBy,
          createdAt: manifests.createdAt,
          updatedAt: manifests.updatedAt,
        })
        .from(manifests)
        .where(
          and(
            eq(manifests.tenantId, tenantId),
            eq(manifests.warehouseId, warehouseId),
            before === undefined
              ? undefined
              : sql`(${manifests.createdAt}, ${manifests.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(manifests.createdAt), desc(manifests.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        ...row,
        createdAt: canonicalInstant(row.createdAt),
        updatedAt: canonicalInstant(row.updatedAt),
      }));
      return buildPage(items, pageSize);
    });
  }

  /**
   * Warehouse-scoped wave-policy list (Story 4.2): the same keyset shape —
   * a policy must be discoverable to be referenced by a generate call.
   */
  async listWavePolicies(
    tenantId: string,
    warehouseId: string,
    query: ListOrdersQuery = {},
  ): Promise<Page<WavePolicySnapshotBody & { readonly grouping: WaveGrouping }>> {
    const pageSize = query.limit ?? DEFAULT_OUTBOUND_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await tx
        .select()
        .from(wavePolicies)
        .where(
          and(
            eq(wavePolicies.tenantId, tenantId),
            eq(wavePolicies.warehouseId, warehouseId),
            before === undefined
              ? undefined
              : sql`(${wavePolicies.createdAt}, ${wavePolicies.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(wavePolicies.createdAt), desc(wavePolicies.id))
        .limit(pageSize + 1);
      return buildPage(rows.map(policySnapshot), pageSize);
    });
  }

  // ── picking (Story 4.3) ───────────────────────────────────────────────────

  /**
   * `POST .../outbound/picks` (device-gated, `picks.execute`): one
   * scan-verified pick — the `pick.picked` ledger draw and the reservation's
   * `held → committed` settlement in ONE transaction.
   */
  async recordPick(command: RecordPickCommand, idempotencyKey: string): Promise<PickSnapshot> {
    return this.pickCommand.recordPick(command, idempotencyKey);
  }

  // ── packing (Story 4.5) ───────────────────────────────────────────────────

  /**
   * `POST .../outbound/orders/{orderId}/pack` (`pack.execute`): verifies the
   * parcel's scanned contents against what the order actually had PICKED,
   * journals one zero-quantity `pack.packed` event per order line, flips the
   * order to `ready_to_dispatch` and returns the packing-slip payload — all
   * in ONE transaction. A discrepancy is refused before anything is written.
   */
  async packOrder(command: PackOrderCommand, idempotencyKey: string): Promise<PackSnapshot> {
    return this.packCommand.packOrder(command, idempotencyKey);
  }

  // ── dispatch (Story 4.6) ──────────────────────────────────────────────────

  /**
   * `POST .../outbound/orders/{orderId}/dispatch` (`dispatch.execute`): the
   * order's TERMINAL transition. The `ready_to_dispatch → dispatched` flip,
   * one zero-quantity `dispatch.dispatched` event per order line, and the
   * retirement of every `committed` hold the order owns to `released` — the
   * transition that finally restores the reserved counter and corrects ATP —
   * all in ONE transaction. The optional free-text carrier and tracking
   * reference ride the events' reference doc.
   */
  async dispatchOrder(
    command: DispatchOrderCommand,
    idempotencyKey: string,
  ): Promise<DispatchSnapshot> {
    return this.dispatchCommand.dispatchOrder(command, idempotencyKey);
  }

  /**
   * The device's pick tasks (AD-4): the still-pickable lines of every ready
   * picklist on a released wave in the warehouse, in walk order — composed
   * into the sealed device catalog snapshot additively (the `putawayTasks`
   * precedent). The bin and batch each task names are advisory suggestions,
   * re-derived server-side at pick time.
   *
   * In-tx ONLY, deliberately: the snapshot composes bins, putaway tasks and
   * pick tasks in ONE tenant transaction. A pool-opening sibling would
   * reserve a SECOND connection while the outer one is held, and postgres.js
   * queues connection requests with no timeout, so enough concurrent
   * snapshots deadlock the pool permanently — which is exactly what a
   * convenience wrapper here invited last time.
   */
  async getPickTasksInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
  ): Promise<PickTask[]> {
    return this.pickCommand.getPickTasksInTx(tx, tenantId, warehouseId);
  }

  /**
   * The same read in its OWN tenant transaction — what the api shell calls
   * when it joins this arm onto the device catalog snapshot. One transaction,
   * one pooled connection, taken AFTER the snapshot's own has been released:
   * the shell composes the two facades sequentially rather than nesting, so
   * neither read can queue behind the other.
   */
  async getPickTasks(tenantId: string, warehouseId: string): Promise<PickTask[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getPickTasksInTx(tx, tenantId, warehouseId),
    );
  }

  /**
   * The device's pack bench work (story 10.7, AD-4): the packable orders'
   * per-SKU picked totals plus every active handling unit of the warehouse —
   * composed into the sealed device catalog snapshot additively (the
   * `pickTasks` precedent).
   *
   * The PACKABLE predicate mirrors `packOrder`'s own guards, read-only: an
   * `accepted` order in the warehouse whose pick plan has at least one
   * `picklist_lines` row, none still `planned`, and not every one
   * `cancelled` (the command's whole-withdrawn FLOOR clause — a wave-cancelled
   * order was never picked and stays re-wavable), and which actually moved
   * units (`sum(picks.qty) > 0` — `picks` rows are strictly positive, so the
   * grouped rows below imply it). The completeness is deliberately
   * LINE-STATUS based, never `picks`-based: a zero-unit short pick writes no
   * picks row (the command's own header documents why). Per-SKU `pickedQty`
   * comes from the SAME grouped-`picks` read the command verifies against —
   * one roll-up, so the snapshot cannot tell the bench a different number
   * than the server will verify against.
   *
   * A READ of the catalog-owned `handling_units` table from this module:
   * reads are precedented (`pick.command.ts` joins `skus` directly) — the
   * architecture test's exclusive-writer rule binds WRITES only, and this
   * module writes none (the `active → packed` flip stays in
   * `handling-unit.store.ts` through the catalog facade).
   *
   * In-tx ONLY, deliberately (the `getPickTasksInTx` reason verbatim): the
   * snapshot composes its parts in ONE tenant transaction — a pool-opening
   * sibling would reserve a second connection while the outer one is held,
   * and postgres.js queues connection requests with no timeout.
   */
  async getPackTasksInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
  ): Promise<PackWorkRead> {
    // The packable predicate: `picks` joined to its order (which carries the
    // warehouse scope and the accepted status), with the line-status arms as
    // correlated EXISTS fragments — the same shape the wave-list read's
    // `picklistCount` subquery uses. `picks_tenant_order_idx` serves the
    // grouped read; the subqueries ride `picklist_lines_tenant_order_idx`.
    const overRead = await tx
      .select({
        orderId: picks.orderId,
        orderCreatedAt: orders.createdAt,
        skuId: picks.skuId,
        skuCode: skus.code,
        skuName: skus.name,
        catchWeightTracked: skus.catchWeightTracked,
        // Story 10.1: `::bigint` — an int4 sum overflows at ~2.1M base units;
        // int8 comes back as a string and `Number(...)` is the boundary
        // coercion, exactly as the pack command's own verification query does.
        pickedQty: sql<string>`sum(${picks.qty})::bigint`,
      })
      .from(picks)
      .innerJoin(orders, and(eq(orders.id, picks.orderId), eq(orders.tenantId, picks.tenantId)))
      .innerJoin(skus, eq(skus.id, picks.skuId))
      .where(
        and(
          eq(picks.tenantId, tenantId),
          eq(orders.warehouseId, warehouseId),
          eq(orders.status, 'accepted'),
          sql`exists (select 1 from picklist_lines pl where pl.tenant_id = ${picks.tenantId} and pl.order_id = ${picks.orderId})`,
          sql`not exists (select 1 from picklist_lines pl where pl.tenant_id = ${picks.tenantId} and pl.order_id = ${picks.orderId} and pl.status = 'planned')`,
          sql`exists (select 1 from picklist_lines pl where pl.tenant_id = ${picks.tenantId} and pl.order_id = ${picks.orderId} and pl.status <> 'cancelled')`,
        ),
      )
      // Primary key columns ride the group by so Postgres's functional
      // dependency admits the other selected columns without listing them.
      .groupBy(picks.orderId, orders.id, picks.skuId, skus.id)
      .orderBy(asc(orders.createdAt), asc(orders.id), asc(skus.code), asc(picks.skuId))
      .limit(MAX_SNAPSHOT_PACK_TASKS + 1);

    // Whole-order truncation — `truncateToWholeGroups`, keyed by order. The
    // over-read is `MAX_SNAPSHOT_PACK_TASKS + 1` so the function can see
    // whether the ceiling fell inside an order.
    const rows = truncateToWholeGroups(overRead, MAX_SNAPSHOT_PACK_TASKS, (row) => row.orderId);

    const packTasks: PackTask[] = rows.map((row) => ({
      orderId: row.orderId,
      skuId: row.skuId,
      skuCode: row.skuCode,
      skuName: row.skuName,
      // Base units at the response edge (story 10.1) — the count the bench's
      // exact-match gate compares against.
      pickedQty: fromMilli(Number(row.pickedQty)),
      catchWeightTracked: row.catchWeightTracked,
    }));

    // Active units, id + skuId only (the bench resolves labels, nothing more).
    // Uncapped — see `CatalogHandlingUnit` for why a cap would queue-and-die
    // legitimate scans. Ordered by id so a re-serialized cache cannot change
    // the list the device reasons over.
    const units = await tx
      .select({ id: handlingUnits.id, skuId: handlingUnits.skuId })
      .from(handlingUnits)
      .where(
        and(
          eq(handlingUnits.tenantId, tenantId),
          eq(handlingUnits.warehouseId, warehouseId),
          eq(handlingUnits.status, 'active'),
        ),
      )
      .orderBy(asc(handlingUnits.id));

    return { packTasks, handlingUnits: units };
  }

  /**
   * The same read in its OWN tenant transaction — what the api shell calls
   * when it joins this arm onto the device catalog snapshot. One transaction,
   * one pooled connection, taken AFTER the snapshot's own has been released:
   * the shell composes the facades sequentially rather than nesting, so
   * neither read can queue behind the other.
   */
  async getPackTasks(tenantId: string, warehouseId: string): Promise<PackWorkRead> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getPackTasksInTx(tx, tenantId, warehouseId),
    );
  }

  /**
   * The order + lines as one snapshot (the in-tx seam `OrderCommandService`
   * composes for writes; the detail read composes the same shape for reads —
   * one serializer, no drift between the two).
   */
  private async snapshotOf(
    tx: TenantTx,
    order: typeof orders.$inferSelect,
  ): Promise<OrderSnapshot> {
    return this.orderCommand.snapshotOf(tx, order);
  }

  /**
   * Story 21-4 — the `per_pick` count: `picks` rows (one per picklist line —
   * `picks_line_unique`) of the client's SKUs created in `[from, to)`, across
   * warehouses (`picksPredicate`). In the caller's transaction (billing's
   * metering read).
   */
  async countPicksInTx(
    tx: TenantTx,
    scope: ClientCountScope,
    from: string,
    to: string,
  ): Promise<number> {
    const rows = (await tx.execute(sql`
      select count(*)::bigint as "n"
      from picks p
      join skus s on s.tenant_id = p.tenant_id and s.id = p.sku_id
      where ${picksPredicate(scope, from, to)}
    `)) as unknown as { n: string | number }[];
    return Number(rows[0]?.n ?? 0);
  }
}

/**
 * Story 21-4 — THE pick billing predicate, the one definition behind the
 * `per_pick` count and (21-5) its dispute drill-down: a `picks` row (`p`) of
 * a SKU (`s`) owned by the client, created in `[from, to)`. One row per
 * picklist line (`pick.picked` events are per batch arm or serial — never
 * counted); `created_at` is the pick transaction's start, the server's clock.
 * A zero-unit short pick writes no row, and transfers create no picks — so
 * neither is billed as a pick.
 */
export function picksPredicate(scope: ClientCountScope, from: string, to: string): SQL {
  // Story 21-5: `scope.warehouseIds` narrows to the pick's warehouse.
  return sql`p.tenant_id = ${scope.tenantId}::uuid
    and s.client_id = ${scope.clientId}::uuid
    and p.created_at >= ${from}::timestamptz
    and p.created_at < ${to}::timestamptz${warehouseFilter(sql`p.warehouse_id`, scope.warehouseIds)}`;
}
