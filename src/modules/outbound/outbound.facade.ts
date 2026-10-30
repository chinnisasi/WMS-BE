import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
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
import { anyOrderOfClient } from '../../shared/db/client-filter';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { KeysetWindow, Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { normalizeAwb } from '../../shared/primitives/awb';
import { addressFromColumns } from '../../shared/primitives/address';
import type { AddressSnapshot } from '../../shared/primitives/address';
import { fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import { PORTAL_PAGE_DEFAULT_LIMIT } from '../../shared/primitives/portal-page';
import { AllocationCommandService } from './allocation.command';
import { MIN_FOLLOW_ON_REMAINDER_MILLI } from './follow-on';
import type { AllocateOrderCommand, AllocateOrderSnapshot, BackorderSweepReport } from './allocation.command';
import { portalOrderInTx, portalOrdersInTx, type PortalOrderDetail, type PortalOrderRow } from './portal-orders';
import {
  outboundRegisterInTx as outboundRegisterInTxImpl,
  type OutboundRegisterRow,
  type OutboundRegisterScope,
} from './outbound-register';
// Story 5-3a — the register row shapes cross the seam here (reporting reads them).
export type { OutboundRegisterRow, OutboundRegisterScope } from './outbound-register';
// Story 3-7a — the batch recall's outbound reads (`recall-trace.ts`).
import {
  openOrderIdsOfClientInTx as openOrderIdsOfClientInTxImpl,
  orderTraceFactsByIdsInTx as orderTraceFactsByIdsInTxImpl,
  plannedTasksInBinsInTx as plannedTasksInBinsInTxImpl,
  type OrderTraceFacts,
  type PlannedRecallBinTask,
} from './recall-trace';
export type { OrderTraceFacts, PlannedRecallBinTask } from './recall-trace';
// Story 3-3b — the block impact preview's planned-lines read.
import { plannedPickLinesInBinInTx } from './replan';
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
import { orderUrgencyOrderBy, type OrderPriority, type OrderType } from './order-urgency';

import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { OrderCommandService } from './order.command';
import { OrderImportCommand } from './order-import.command';
import { CancelRestockCommandService } from './cancel-restock.command';
import { OrderShelfLifeReader, type OrderShelfLife } from './order-shelf-life';
import type { CancelOrderWithRestockCommand, CancelRestockSnapshot, RestockPlan } from './cancel-restock.command';
export type { CancelOrderWithRestockCommand, CancelRestockSnapshot, RestockLineSnapshot, RestockPlan, RestockPlanLine, RestockedEntry } from './cancel-restock.command';
import type {
  ImportOrdersCommand,
  ImportPortalOrdersCommand,
  OrderImportResponse,
  PortalOrderImportResponse,
} from './order-import.command';
import type {
  CancelOrderCommand,
  CreateOrderCommand,
  OrderSnapshot,
  PlacePortalOrderCommand,
  PortalPlacedOrder,
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
  PlacePortalOrderCommand,
  PortalPlacedOrder,
};
import { WaveCommandService, policySnapshot } from './wave.command';
import { PickCommandService } from './pick.command';
import type { PickSnapshot, PickTask, RecordPickCommand } from './pick.command';
import { PackCommandService } from './pack.command';
import type { PackOrderCommand, PackSnapshot } from './pack.command';
import { DispatchCommandService } from './dispatch.command';
import type { DispatchOrderCommand, DispatchSnapshot } from './dispatch.command';
import { ShipmentCommandService } from './shipment.command';
import type { CreateShipmentLabelCommand, ShipmentKind, ShipmentSnapshot, ShipmentStatus } from './shipment.command';
import { ManifestCommandService } from './manifest.command';
import type { CreateManifestCommand, ManifestSnapshot } from './manifest.command';
import { RateService } from './rate.service';
import { ClientLabelCommand } from './client-label.command';
import type {
  PortalAwbAdviceCommand,
  PortalClientLabelCommand,
  PortalShipmentCommandSnapshot,
  ShipmentCommandSnapshot,
  StaffAwbAdviceCommand,
  StaffClientLabelCommand,
  VerifyLabelCommand,
  VerifyLabelSnapshot,
  VoidShipmentCommand,
} from './client-label.command';
import { ShippingFilesCommand } from './shipping-files.command';
import type {
  PortalOrderDocumentCommand,
  RemoveShippingFileCommand,
  ShippingFileCommandSnapshot,
  StagedPhotoSnapshot,
  StageHandoverPhotoCommand,
  StaffOrderDocumentCommand,
  UploadHandoverSheetCommand,
} from './shipping-files.command';
import { ShippingService } from './shipping.service';
import type { HandoverDetailView, OrderShippingView, PortalOrderShippingView } from './shipping.service';
import type { HandOverCommand, HandoverSnapshot } from './handover.command';
import type { DispatchParcel, HandoverCandidate, HandoverListItem } from './shipping.read';
import { shipmentDocumentEmailFactsInTx, type ShipmentDocumentEmailFacts, type ShipmentDocumentFactInput } from './shipping-mail';
import type { AttachmentRow } from '../../shared/db/schema';
// Story 4-4a — the client-arranged shipping vocabularies and views ride the facade seam.
export type {
  PortalAwbAdviceCommand,
  PortalClientLabelCommand,
  PortalShipmentCommandSnapshot,
  ShipmentCommandSnapshot,
  StaffAwbAdviceCommand,
  StaffClientLabelCommand,
  VerifyLabelCommand,
  VerifyLabelSnapshot,
  VoidShipmentCommand,
} from './client-label.command';
export type {
  PortalOrderDocumentCommand,
  RemoveShippingFileCommand,
  ShippingFileCommandSnapshot,
  StagedPhotoSnapshot,
  StageHandoverPhotoCommand,
  StaffOrderDocumentCommand,
  UploadHandoverSheetCommand,
} from './shipping-files.command';
export type { FileView, HandoverDetailView, OrderShippingView, PortalFile, PortalOrderShippingView } from './shipping.service';
export type { HandOverCommand, HandoverParcelInput, HandoverRefusedParcel, HandoverSnapshot, HandoverView } from './handover.command';
export { HANDOVER_PARCEL_REFUSALS, MAX_HANDOVER_PARCELS, handoverHashInput } from './handover.command';
export type { DispatchParcel, HandoverCandidate, HandoverListItem, PortalShippingStatus } from './shipping.read';
export { PORTAL_SHIPPING_STATUSES, portalShippingStatus, DISPATCH_PARCELS_MAX } from './shipping.read';
export type { ShipmentDocumentEmailFacts, ShipmentDocumentFactInput } from './shipping-mail';
export { SHIPMENT_DOCUMENT_SHARED_EVENT } from './client-arranged';
export type { ShipmentDocumentSharedPayload } from './client-arranged';
export { SHIPMENT_KINDS, SHIPMENT_STATUSES } from './shipment.command';
export { LABEL_VERIFY_METHODS } from './client-label.command';
export { SHIPPING_DOC_KINDS } from '../attachments/attachment-records';
export { PORTAL_DOC_KINDS } from './shipping-files.command';
import { orderReferenceMatch } from './order-reference';
import type { OrderRatesSnapshot } from './rate.service';
import type {
  CreateWavePolicyCommand,
  CutoffSweepResult,
  GenerateWaveCommand,
  WaveGrouping,
  WavePolicySnapshot,
  WavePolicySnapshotBody,
  WaveSnapshot,
  WaveStatus,
  WaveTransitionCommand,
} from './wave.command';

// Story 9-2b — the sweep's result and event type ride the facade seam.
export type { CutoffSweepResult } from './wave.command';
export { WAVE_CUTOFF_AT_RISK_EVENT } from './wave.command';

// Story 9-1 — the dashboard fact-list row types ride the facade seam.
export type { BackorderRefusalEntry, PackFailureEntry, PicklistLineEntry };
export type { PortalOrderComponent, PortalOrderDetail, PortalOrderLine, PortalOrderRow } from './portal-orders';

/** One header row of the order-list read (no lines — detail carries them). */
export interface OrderEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly status: OrderStatus;
  readonly source: OrderSource;
  readonly integrationId: string | null;
  readonly externalEventId: string | null;
  /** Story 4-1b — the client's own order number; null when none. */
  readonly clientOrderRef: string | null;
  /**
   * Story 4-2a — the order header fields (a live read: always present).
   * `orderType` is null on a pre-4-2a order; `priority` reads `normal`.
   * `findOrderByChannelRef` carries `codAmountPaise` for the ingest's COD
   * drift check (A6).
   */
  readonly orderType: OrderType | null;
  readonly priority: OrderPriority;
  readonly shipByDate: string | null;
  readonly codAmountPaise: number | null;
  /** Where the shipment goes (story 11-1); null on a pre-11.1 order row. */
  readonly destination: AddressSnapshot | null;
  /** Story 21-2b — the client the order is for (derived from its SKUs). */
  readonly clientId: string;
  /**
   * Story 4-2c — the backorder chain (a live read: always present). On a
   * follow-on: its parent, the chain's root and its `-BO{seq}`; null on a
   * root. `followOnOrderId`: the follow-on this order's short dispatch opened.
   */
  readonly followOnOfOrderId: string | null;
  readonly followOnRootOrderId: string | null;
  readonly followOnSeq: number | null;
  readonly followOnOrderId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Story 4-2c — one order line as the channel writeback reads it: what SHIPPED (Σ picks), base units. */
export type WritebackOrderLine = OrderSnapshot['order']['lines'][number] & { readonly shippedQty: number };

/** Story 4-2c — the writeback's order re-read: the order and its lines with what shipped. */
export type WritebackOrder = Omit<OrderSnapshot['order'], 'lines'> & { readonly lines: readonly WritebackOrderLine[] };

export interface ListOrdersQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * Story 1-5a — a list that takes the staff client filter (orders, waves,
 * manifests). The wave-policy list keeps the bare {@link ListOrdersQuery}:
 * a policy belongs to no client.
 */
export interface ListClientFilteredQuery extends ListOrdersQuery {
  /** Only rows of one client's orders (waves, manifests: ANY order of the client). */
  readonly clientId?: string | undefined;
}

/**
 * Story 9-1 — the order list's dashboard drill filters (all optional,
 * additive). The window is on `created_at` (server-stamped), `[from, to)`.
 * `backordered` asks whether ANY line of the order was created `backordered`
 * (the status is set only at acceptance) — counted per ORDER, so a kit's
 * backordered parent and children never count it twice.
 */
export interface ListOrdersFilter extends ListClientFilteredQuery {
  readonly status?: OrderStatus | undefined;
  readonly source?: OrderSource | undefined;
  readonly backordered?: boolean | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /**
   * Story 4-1b — an exact match on the client order number (any status —
   * `orders_client_order_ref_idx`) OR the channel reference
   * (`external_event_id`, any status — `orders_external_event_client_idx`).
   * Trimmed by the DTO; case-sensitive.
   */
  readonly reference?: string | undefined;
  /** Story 4-2c (A15) — `true`: only backorder follow-ons; `false`: only root orders. */
  readonly followOn?: boolean | undefined;
}

/** Story 9-1 — the windowed fact-list reads (pack failures, refusals, picklist lines). */
export interface ListWindowQuery {
  /** Story 1-5a — only rows of one client's orders (refusals: of one client's SKUs). */
  readonly clientId?: string | undefined;
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
  /**
   * Story 4-2a — the order's priority, ship-by date and COD amount (the pack
   * card's chips and "COD ₹x"; the bench's "collect" banner). Order-level,
   * repeated on each of the order's SKU rows.
   */
  readonly orderPriority: OrderPriority;
  readonly orderShipByDate: string | null;
  readonly codAmountPaise: number | null;
  /**
   * Story 4-2c (A16) — what the order ORDERED of this SKU (Σ its leaf lines'
   * `qty`, base units), whether ANY leaf line of the order was picked below
   * its quantity (so the bench warns even when a wholly unpicked SKU has no
   * row here), and the order's `-BO{seq}` (null on a root).
   */
  readonly orderedQty: number;
  readonly orderShortfall: boolean;
  readonly followOnSeq: number | null;
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
  /**
   * Story 13-1 (additive) — the order's client (`orders.client_id`, derived
   * from its SKUs at acceptance, §7b) and its channel reference
   * (`external_event_id`; null on a manual order). The return authorization
   * reads both off this one facts read rather than a third order query.
   */
  readonly clientId: string;
  readonly externalEventId: string | null;
  /**
   * Story 4-1b (additive) — the client's own order number (null when none):
   * the RMA's `order_reference` is `clientOrderRef ?? externalEventId`.
   */
  readonly clientOrderRef: string | null;
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
/**
 * Story 4-2c — the follow-on a parent's short dispatch opened, as a correlated
 * subquery on `orders_follow_on_of_unique` (table-qualified by hand — an
 * unqualified column would resolve against the inner FROM list, Gotcha 9).
 */
// Written with literal `"orders".` qualifiers: drizzle renders a column
// interpolated into a SELECT-list fragment UNQUALIFIED, which would resolve
// against the inner `fo` (the very Gotcha 9 this guards).
const followOnChildSql = sql<string | null>`(select fo.id from orders fo where fo.tenant_id = "orders"."tenant_id" and fo.follow_on_of_order_id = "orders"."id" limit 1)`;

/** Story 4-2c — an order snapshot's header as an `OrderEntry` (the new keys read `?? null`). */
function toOrderEntry(header: Omit<OrderSnapshot['order'], 'lines'>): OrderEntry {
  // Built key by key — never a spread, so the snapshot's `lines` never leak in.
  return {
    id: header.id,
    tenantId: header.tenantId,
    warehouseId: header.warehouseId,
    status: header.status,
    source: header.source,
    integrationId: header.integrationId,
    externalEventId: header.externalEventId,
    clientOrderRef: header.clientOrderRef ?? null,
    orderType: header.orderType ?? null,
    priority: (header.priority ?? 'normal') as OrderPriority,
    shipByDate: header.shipByDate ?? null,
    codAmountPaise: header.codAmountPaise ?? null,
    destination: header.destination,
    clientId: header.clientId ?? '',
    followOnOfOrderId: header.followOnOfOrderId ?? null,
    followOnRootOrderId: header.followOnRootOrderId ?? null,
    followOnSeq: header.followOnSeq ?? null,
    followOnOrderId: header.followOnOrderId ?? null,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
  };
}

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
  /** Story 4-2a (A17) — computed live, the same figure the create froze. */
  readonly codShipmentCount: number;
  readonly codTotalPaise: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The row → view mapping the read-back and the snapshot share (4.6c). */
function toShipmentView(
  row: typeof shipments.$inferSelect,
  codAmountPaise: number | null,
): ShipmentSnapshot['shipment'] {
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
    // Story 4-2a — the order's COD (immutable, so the read agrees with the label).
    codAmountPaise,
    // Story 4-2b — the void stamps (null unless voided).
    voidedAt: row.voidedAt === null ? null : canonicalInstant(row.voidedAt),
    voidedBy: row.voidedBy,
    // Story 4-4a (A38) — the kind and the client-arranged arms.
    kind: row.kind as ShipmentKind,
    packageCount: row.packageCount,
    labelVerifiedAt: row.labelVerifiedAt === null ? null : canonicalInstant(row.labelVerifiedAt),
    handoverId: row.handoverId,
    handedOverAt: row.handedOverAt === null ? null : canonicalInstant(row.handedOverAt),
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
  private readonly logger = new Logger('OutboundFacade');

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
    // Story 4-1c — the order import (both surfaces).
    @Inject(OrderImportCommand) private readonly orderImport: OrderImportCommand,
    // Story 4-2b — cancel a picked or packed order with restock, and its plan read.
    @Inject(CancelRestockCommandService) private readonly cancelRestock: CancelRestockCommandService,
    // Story 4-2c — the backorder allocation (verb, sweep, after-dispatch attempt).
    @Inject(AllocationCommandService) private readonly allocation: AllocationCommandService,
    // Story 4-3b — the order's customer shelf life read.
    @Inject(OrderShelfLifeReader) private readonly orderShelfLife: OrderShelfLifeReader,
    // Story 4-4a — client-arranged shipping: the label and AWB commands, the
    // shipping files, and the handover and the reads.
    @Inject(ClientLabelCommand) private readonly clientLabels: ClientLabelCommand,
    @Inject(ShippingFilesCommand) private readonly shippingFiles: ShippingFilesCommand,
    @Inject(ShippingService) private readonly shipping: ShippingService,
  ) {}

  // ── story 4-4a: client-arranged shipping ──────────────────────────────────

  /** A8 — staff record the client's label PDF and AWB (`labels.execute`). */
  async recordClientLabel(command: StaffClientLabelCommand, idempotencyKey: string): Promise<ShipmentCommandSnapshot> {
    return this.clientLabels.recordClientLabel(command, idempotencyKey);
  }

  /** A8 — the portal twin (the stamp lives in the command). */
  async recordPortalClientLabel(command: PortalClientLabelCommand, idempotencyKey: string): Promise<PortalShipmentCommandSnapshot> {
    return this.clientLabels.portalRecordClientLabel(command, idempotencyKey);
  }

  /** A9 — staff pre-advise the AWB (the courier brings the label). */
  async recordAwbAdvice(command: StaffAwbAdviceCommand, idempotencyKey: string): Promise<ShipmentCommandSnapshot> {
    return this.clientLabels.recordAwbAdvice(command, idempotencyKey);
  }

  /** A9 — the portal twin (the stamp lives in the command). */
  async recordPortalAwbAdvice(command: PortalAwbAdviceCommand, idempotencyKey: string): Promise<PortalShipmentCommandSnapshot> {
    return this.clientLabels.portalRecordAwbAdvice(command, idempotencyKey);
  }

  /** A10 — void a client-arranged shipment (staff). */
  async voidClientArrangedShipment(command: VoidShipmentCommand, idempotencyKey: string): Promise<ShipmentCommandSnapshot> {
    return this.clientLabels.voidShipment(command, idempotencyKey);
  }

  /** A11 — verify the client label on the parcel (web or handheld). */
  async verifyClientLabel(command: VerifyLabelCommand, idempotencyKey: string): Promise<VerifyLabelSnapshot> {
    return this.clientLabels.verifyLabel(command, idempotencyKey);
  }

  /** A14 — an order's shipping document (staff). */
  async uploadOrderDocument(command: StaffOrderDocumentCommand, idempotencyKey: string): Promise<ShippingFileCommandSnapshot> {
    return this.shippingFiles.uploadOrderDocument(command, idempotencyKey);
  }

  /** A14 — the client's own document (the stamp lives in the command). */
  async uploadPortalOrderDocument(command: PortalOrderDocumentCommand, idempotencyKey: string): Promise<ShippingFileCommandSnapshot> {
    return this.shippingFiles.portalUploadOrderDocument(command, idempotencyKey);
  }

  /** A14 — a handover's signed sheet (web). */
  async uploadHandoverSheet(command: UploadHandoverSheetCommand, idempotencyKey: string): Promise<ShippingFileCommandSnapshot> {
    return this.shippingFiles.uploadHandoverSheet(command, idempotencyKey);
  }

  /** A14 — the handheld's signed-sheet photo (the photo's ULID is its key). */
  async stageHandoverPhoto(command: StageHandoverPhotoCommand, ref: string): Promise<StagedPhotoSnapshot> {
    return this.shippingFiles.stageHandoverPhoto(command, ref);
  }

  /** A14 — remove a shipping file (`orders.manage`). */
  async removeShippingFile(command: RemoveShippingFileCommand, idempotencyKey: string): Promise<ShippingFileCommandSnapshot> {
    return this.shippingFiles.removeFile(command, idempotencyKey);
  }

  /** A12 — the courier handover (it dispatches its orders); after-commit work never thrown. */
  async handOver(command: HandOverCommand, idempotencyKey: string): Promise<HandoverSnapshot> {
    return this.shipping.handOver(command, idempotencyKey);
  }

  /** A16 — the order's shipping (staff). Null for an unknown order. */
  async getOrderShipping(tenantId: string, orderId: string): Promise<OrderShippingView | null> {
    return this.shipping.orderShipping(tenantId, orderId);
  }

  /** A16, A49 — a client's packed orders in a warehouse (the handover builder). */
  async getHandoverCandidates(
    tenantId: string,
    warehouseId: string,
    clientId: string,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<{ items: HandoverCandidate[]; nextCursor: string | null }> {
    return this.shipping.handoverCandidates(tenantId, warehouseId, clientId, query);
  }

  /** A16, A40 — a warehouse's handovers, newest first. */
  async listHandovers(
    tenantId: string,
    warehouseId: string,
    query: { clientId?: string | undefined; from?: string | undefined; to?: string | undefined; cursor?: string | undefined; limit?: number | undefined },
  ): Promise<{ items: HandoverListItem[]; nextCursor: string | null }> {
    return this.shipping.listHandovers(tenantId, warehouseId, query);
  }

  /** A16 — one handover (the phone unmasked for a `dispatch.execute` holder). Null when unknown. */
  async getHandover(tenantId: string, handoverId: string, actorUserId: string): Promise<HandoverDetailView | null> {
    return this.shipping.handoverDetail(tenantId, handoverId, actorUserId);
  }

  /** A16 — the parcel tag file (ZPL or PDF, 4×2). */
  async renderParcelTag(tenantId: string, orderId: string, format: 'zpl' | 'pdf'): Promise<{ body: Buffer; contentType: string; fileName: string }> {
    return this.shipping.parcelTag(tenantId, orderId, format);
  }

  /** A17 — the portal order's Shipping section (two layers: the stamp here, the predicates in the read). */
  async portalOrderShipping(tenantId: string, clientId: string, orderId: string): Promise<PortalOrderShippingView | null> {
    const read = await withTenantTransaction(this.db, tenantId, (tx) => this.shipping.portalOrderShippingReadInTx(tx, tenantId, clientId, orderId), { clientId });
    return read === null ? null : this.shipping.portalOrderShippingView(read);
  }

  /** A18, A39 — the device snapshot's dispatch parcels, in their own transaction (the shell composes sequentially). */
  async getDispatchParcels(tenantId: string, warehouseId: string): Promise<{ parcels: DispatchParcel[]; truncated: boolean }> {
    return withTenantTransaction(this.db, tenantId, (tx) => this.shipping.dispatchParcelsInTx(tx, tenantId, warehouseId));
  }

  /** A18, A39 — the device snapshot's dispatch parcels (in-tx ONLY — the `getPickTasksInTx` rule). */
  async dispatchParcelsInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<{ parcels: DispatchParcel[]; truncated: boolean }> {
    return this.shipping.dispatchParcelsInTx(tx, tenantId, warehouseId);
  }

  /** FA29 — presigned links to a handover review row's still-live sheet photos. */
  async handoverPhotoLinks(tenantId: string, refs: readonly string[]): Promise<{ ref: string; url: string | null; urlExpiresAt: string | null }[]> {
    return this.shipping.photoLinksByRefs(tenantId, refs);
  }

  /** D8 — the derived file name of a shareable shipping file (the mail renderer, in its stamped transaction). */
  async shippingFileNameInTx(tx: TenantTx, tenantId: string, clientId: string, row: AttachmentRow): Promise<string | null> {
    return this.shipping.shippingFileNameInTx(tx, tenantId, clientId, row);
  }

  /** D6 — what a shipping-document email names (read at enqueue). */
  async shipmentDocumentEmailFactsInTx(tx: TenantTx, tenantId: string, fact: ShipmentDocumentFactInput): Promise<ShipmentDocumentEmailFacts | null> {
    return shipmentDocumentEmailFactsInTx(tx, tenantId, fact);
  }

  /**
   * Story 4-2c — `POST …/orders/{orderId}/allocate` ("Allocate now"):
   * re-reserves the order's backordered lines that hold nothing.
   */
  async allocateOrder(command: AllocateOrderCommand, idempotencyKey: string): Promise<AllocateOrderSnapshot> {
    return this.allocation.allocateOrder(command, idempotencyKey);
  }

  /** Story 4-2c — the backorder allocation sweep for one tenant (the jobs shell's `BackorderAllocationWorker`). System work. */
  async sweepBackorders(tenantId: string): Promise<BackorderSweepReport> {
    return this.allocation.sweepBackorders(tenantId);
  }

  /**
   * Story 4-2c (A13) — the chain's OPEN follow-on of a root order (`accepted`
   * or `ready_to_dispatch` — a follow-on exists only after its parent
   * dispatched, so at most one is open), or null. The channel cancellation
   * routes a cancellation of a dispatched root here.
   */
  async openFollowOnOfRoot(tenantId: string, rootOrderId: string): Promise<OrderEntry | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.followOnRootOrderId, rootOrderId),
            inArray(orders.status, ['accepted', 'ready_to_dispatch']),
          ),
        )
        .orderBy(desc(orders.followOnSeq))
        .limit(1);
      const id = rows[0]?.id;
      if (id === undefined) return null;
      const order = (await tx.select().from(orders).where(eq(orders.id, id)).limit(1))[0]!;
      return toOrderEntry((await this.snapshotOf(tx, order)).order);
    });
  }

  /**
   * Story 5-3a — the outbound register (`outbound-register.ts`): one row per
   * order line of the warehouse's orders received in `[from, to)`, filtered by
   * the order's own client; the latest shipment by `(labelled_at, id)`. In
   * the caller's repeatable-read transaction, at most `limit` rows.
   */
  async outboundRegisterInTx(tx: TenantTx, scope: OutboundRegisterScope, limit: number, pageSize?: number): Promise<OutboundRegisterRow[]> {
    return outboundRegisterInTxImpl(tx, scope, limit, pageSize);
  }

  // ── story 3-7a: the batch recall's reads (`recall-trace.ts`) ─────────────

  /** One client's OPEN order ids across the named warehouses (the 0101 partial index). */
  async openOrderIdsOfClientInTx(tx: TenantTx, tenantId: string, clientId: string, warehouseIds: readonly string[]): Promise<string[]> {
    return openOrderIdsOfClientInTxImpl(tx, tenantId, clientId, warehouseIds);
  }

  /** These orders' trace facts (status, label, consignee, destination, latest shipment) — one statement. */
  async orderTraceFactsByIdsInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, OrderTraceFacts>> {
    return orderTraceFactsByIdsInTxImpl(tx, tenantId, orderIds);
  }

  /** The planned pick lines of these orders at these (bin, SKU) pairs. */
  async plannedTasksInBinsInTx(
    tx: TenantTx,
    tenantId: string,
    orderIds: readonly string[],
    binSkuPairs: readonly { readonly binId: string; readonly skuId: string }[],
  ): Promise<PlannedRecallBinTask[]> {
    return plannedTasksInBinsInTxImpl(tx, tenantId, orderIds, binSkuPairs);
  }

  /**
   * Story 3-3b (A13) — the planned pick lines in one bin, per SKU (lines and
   * milli-units): the block impact preview's outbound term. A read on the
   * caller's transaction.
   */
  async plannedPickLinesInBinInTx(
    tx: TenantTx,
    tenantId: string,
    binId: string,
  ): Promise<ReadonlyArray<{ skuId: string; lines: number; units: number }>> {
    return plannedPickLinesInBinInTx(tx, tenantId, binId);
  }

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
        .select({ shipment: shipments, codAmountPaise: orders.codAmountPaise })
        .from(shipments)
        .leftJoin(orders, and(eq(orders.id, shipments.orderId), eq(orders.tenantId, shipments.tenantId)))
        .where(and(eq(shipments.tenantId, tenantId), eq(shipments.orderId, orderId)))
        // Story 4-4a (A16, folded defect) — the LIVE shipment, else the newest
        // voided one (a void then a new label left two rows, read in any order).
        .orderBy(sql`(${shipments.status} = 'voided')`, desc(shipments.createdAt), desc(shipments.id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return toShipmentView(row.shipment, row.codAmountPaise ?? null);
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

  /**
   * Story 4-1a — `POST portal/orders`: a client user places an order for its
   * own SKUs. A one-statement delegation (pinned in test/architecture.spec.ts,
   * deliberately not `portal*`-named): the client stamp lives in the command.
   */
  async placePortalOrder(command: PlacePortalOrderCommand, idempotencyKey: string): Promise<PortalPlacedOrder> {
    return this.orderCommand.placePortalOrder(command, idempotencyKey);
  }

  /**
   * Story 4-1c — `POST …/outbound/order-imports`: many orders from one
   * CSV/XLSX file, each created through `createOrder` under a key derived
   * from the import's (Check file when `dryRun`).
   */
  async importOrders(command: ImportOrdersCommand, idempotencyKey: string | null): Promise<OrderImportResponse> {
    return this.orderImport.importOrders(command, idempotencyKey);
  }

  /**
   * Story 4-1c — `POST portal/order-imports`: the client portal's import. A
   * one-statement delegation (pinned in test/architecture.spec.ts,
   * deliberately not `portal*`-named): the client stamp lives in the command.
   */
  async importPortalOrders(command: ImportPortalOrdersCommand, idempotencyKey: string | null): Promise<PortalOrderImportResponse> {
    return this.orderImport.importPortalOrders(command, idempotencyKey);
  }

  /**
   * Story 4-2b — `POST …/orders/{id}/cancel-with-restock`: cancels an
   * accepted (any pick state) or packed order, restocking every drawn unit,
   * voiding an unmanifested label, unpacking its cases and ending every hold.
   */
  async cancelOrderWithRestock(command: CancelOrderWithRestockCommand, idempotencyKey: string): Promise<CancelRestockSnapshot> {
    return this.cancelRestock.cancelOrderWithRestock(command, idempotencyKey);
  }

  /** Story 4-2b — `GET …/orders/{id}/restock-plan`: what a cancel would put back, and what it did. Null → 404. */
  async getRestockPlan(tenantId: string, orderId: string): Promise<RestockPlan | null> {
    return this.cancelRestock.getRestockPlan(tenantId, orderId);
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
          clientOrderRef: orders.clientOrderRef,
          orderType: orders.orderType,
          priority: orders.priority,
          shipByDate: orders.shipByDate,
          codAmountPaise: orders.codAmountPaise,
          clientId: orders.clientId,
          followOnOfOrderId: orders.followOnOfOrderId,
          followOnRootOrderId: orders.followOnRootOrderId,
          followOnSeq: orders.followOnSeq,
          followOnOrderId: followOnChildSql,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
        })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.integrationId, integrationId),
            eq(orders.externalEventId, externalEventId),
            // Story 4-2c — the ROOT (a follow-on shares its channel event; the
            // narrowed `orders_source_event_root_unique` population).
            isNull(orders.followOnOfOrderId),
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
        clientOrderRef: row.clientOrderRef,
        orderType: row.orderType as OrderType | null,
        priority: row.priority as OrderPriority,
        shipByDate: row.shipByDate,
        codAmountPaise: row.codAmountPaise,
        destination: null,
        clientId: row.clientId,
        followOnOfOrderId: row.followOnOfOrderId,
        followOnRootOrderId: row.followOnRootOrderId,
        followOnSeq: row.followOnSeq,
        followOnOrderId: row.followOnOrderId,
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
  async orderForWriteback(tenantId: string, orderId: string): Promise<WritebackOrder | null> {
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
      const snapshot = (await this.snapshotOf(tx, order)).order;
      // Story 4-2c (decision 8 fold-in) — what each line SHIPPED: Σ picks
      // (the dispatch command's own figure). The fulfillment posts this, never
      // the ordered quantity — a short shipment must not tell the channel the
      // order was fulfilled in full. `::bigint` — int8 arrives as a string.
      const picked = await tx
        .select({ orderLineId: picks.orderLineId, qty: sql<string>`sum(${picks.qty})::bigint` })
        .from(picks)
        .where(and(eq(picks.tenantId, tenantId), eq(picks.orderId, order.id)))
        .groupBy(picks.orderLineId);
      const shipped = new Map(picked.map((row) => [row.orderLineId, Number(row.qty)]));
      return {
        ...snapshot,
        lines: snapshot.lines.map((line) => ({ ...line, shippedQty: fromMilli(shipped.get(line.id) ?? 0) })),
      };
    });
  }

  // (the invoicing facts read's methods follow — story 8-1)

  /**
   * Story 4-7b (decision 6, A15, A23, D6, D7) — the DISPATCHED orders of one
   * client in one warehouse that a blind return's scanned parcel reference
   * names, in the caller's transaction. Arms, in order, each tried only when
   * the earlier ones found no dispatched order:
   *
   * 1. `awb` — a carrier-labelled shipment's `tracking_number` (exact,
   *    case-sensitive; a VOIDED label never counts — the
   *    `outbound-register.ts` precedent). A manually dispatched order's AWB
   *    lives only in its ledger reference doc and is not searched (A15).
   * 2. `order-reference`, EXACT — the reference is the order's own label:
   *    its client order number or its channel reference, plus `-BO{seq}` on a
   *    backorder follow-on (D6). A root's bare number therefore names the
   *    root alone, and a printed follow-on label names that follow-on.
   * 3. `order-reference`, the chain — `orderReferenceMatch` (4-2c: a printed
   *    `-BO{n}` label also finds its chain by the stripped number).
   *
   * The reference is trimmed by the caller (blank = no lookup). Every arm
   * carries the explicit client and warehouse predicates. The caller turns
   * exactly one order into a suggestion; several are no suggestion.
   */
  async ordersByParcelReferenceInTx(
    tx: TenantTx,
    tenantId: string,
    clientId: string,
    warehouseId: string,
    reference: string,
  ): Promise<{ readonly orderId: string; readonly matchKind: 'awb' | 'order-reference' }[]> {
    const awb = await tx
      .selectDistinct({ orderId: orders.id })
      .from(shipments)
      .innerJoin(orders, and(eq(orders.tenantId, shipments.tenantId), eq(orders.id, shipments.orderId)))
      .where(
        and(
          eq(shipments.tenantId, tenantId),
          // Story 4-4a (A41) — a client-arranged AWB is stored normalised
          // (no spaces or hyphens, upper case): the scanned or typed
          // reference matches either as given or normalised.
          inArray(shipments.trackingNumber, [...new Set([reference, normalizeAwb(reference)])]),
          sql`${shipments.status} <> 'voided'`,
          eq(orders.clientId, clientId),
          eq(orders.warehouseId, warehouseId),
          eq(orders.status, 'dispatched'),
        ),
      )
      .orderBy(orders.id);
    if (awb.length > 0) return awb.map((row) => ({ orderId: row.orderId, matchKind: 'awb' as const }));
    const candidates = await tx
      .select({
        orderId: orders.id,
        clientOrderRef: orders.clientOrderRef,
        externalEventId: orders.externalEventId,
        followOnSeq: orders.followOnSeq,
      })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.clientId, clientId),
          eq(orders.warehouseId, warehouseId),
          eq(orders.status, 'dispatched'),
          orderReferenceMatch(orders.id, tenantId, reference, clientId),
        ),
      )
      .orderBy(orders.id);
    const suffix = (seq: number | null): string => (seq === null ? '' : `-BO${seq}`);
    const exact = candidates.filter(
      (row) =>
        (row.clientOrderRef !== null && `${row.clientOrderRef}${suffix(row.followOnSeq)}` === reference) ||
        (row.externalEventId !== null && `${row.externalEventId}${suffix(row.followOnSeq)}` === reference),
    );
    const chosen = exact.length > 0 ? exact : candidates;
    return chosen.map((row) => ({ orderId: row.orderId, matchKind: 'order-reference' as const }));
  }

  /**
   * Story 4-7b (A19, D7) — the carrier tracking numbers of each named order
   * (every non-voided shipment), in the caller's transaction: the device
   * snapshot's open returns carry them, so a scanned forward AWB of an
   * order with an open RMA redirects to the RMA receipt. Orders with none
   * are absent.
   */
  async trackingNumbersByOrderIdsInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const ids = [...new Set(orderIds)];
    if (ids.length === 0) return out;
    const rows = await tx
      .select({ orderId: shipments.orderId, trackingNumber: shipments.trackingNumber })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), inArray(shipments.orderId, ids), sql`${shipments.status} <> 'voided'`))
      .orderBy(asc(shipments.createdAt), asc(shipments.id));
    for (const row of rows) {
      const list = out.get(row.orderId) ?? [];
      if (!list.includes(row.trackingNumber)) list.push(row.trackingNumber);
      out.set(row.orderId, list);
    }
    return out;
  }

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
        externalEventId: orders.externalEventId,
        clientOrderRef: orders.clientOrderRef,
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
      clientId: order.clientId,
      externalEventId: order.externalEventId,
      clientOrderRef: order.clientOrderRef,
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
   * Story 21-7 — the client portal's order list (AD-6: the owning module's
   * facade, never the operator route): ONE client's orders, newest first,
   * keyset `(created_at desc, id)` over the full-precision instant,
   * optionally one status. Two layers, both required: the transaction is
   * stamped with the client (`{ clientId }` — RLS on `orders`) AND the query
   * carries the explicit `client_id` predicate (`portal-orders.ts`).
   */
  async portalOrders(
    tenantId: string,
    clientId: string,
    query: { readonly status?: OrderStatus; readonly reference?: string; readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<Page<PortalOrderRow>> {
    const limit = query.limit ?? PORTAL_PAGE_DEFAULT_LIMIT;
    const before = query.cursor === undefined ? null : decodeCursorSafe(query.cursor);
    return withTenantTransaction(
      this.db,
      tenantId,
      (tx) =>
        portalOrdersInTx(tx, tenantId, clientId, {
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.reference === undefined ? {} : { reference: query.reference }),
          before,
          limit,
        }),
      { clientId },
    );
  }

  /** Story 21-7 — one order of this client with its lines (kit components nested), or null → 404. */
  async portalOrder(tenantId: string, clientId: string, orderId: string): Promise<PortalOrderDetail | null> {
    return withTenantTransaction(this.db, tenantId, (tx) => portalOrderInTx(tx, tenantId, clientId, orderId), { clientId });
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
   * Story 4-3b (decision 8) — which shelf-life rules apply to one order and
   * how much on-hand stock qualifies if it were waved today. A staff read;
   * null when the order does not exist in the tenant.
   */
  async getOrderShelfLife(tenantId: string, orderId: string): Promise<OrderShelfLife | null> {
    return this.orderShelfLife.read(tenantId, orderId);
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
          clientOrderRef: orders.clientOrderRef,
          orderType: orders.orderType,
          priority: orders.priority,
          shipByDate: orders.shipByDate,
          codAmountPaise: orders.codAmountPaise,
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
          followOnOfOrderId: orders.followOnOfOrderId,
          followOnRootOrderId: orders.followOnRootOrderId,
          followOnSeq: orders.followOnSeq,
          followOnOrderId: followOnChildSql,
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
            query.clientId === undefined ? undefined : eq(orders.clientId, query.clientId),
            query.backordered === undefined
              ? undefined
              : query.backordered
                ? anyBackordered
                : sql`not ${anyBackordered}`,
            query.from === undefined ? undefined : sql`${orders.createdAt} >= ${query.from}::timestamptz`,
            query.to === undefined ? undefined : sql`${orders.createdAt} < ${query.to}::timestamptz`,
            query.reference === undefined ? undefined : orderReferenceMatch(orders.id, tenantId, query.reference),
            // Story 4-2c (A15) — follow-ons only, or roots only (the SM-4 drill).
            query.followOn === undefined
              ? undefined
              : query.followOn
                ? sql`${orders.followOnOfOrderId} is not null`
                : isNull(orders.followOnOfOrderId),
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
        clientOrderRef: row.clientOrderRef,
        orderType: row.orderType as OrderType | null,
        priority: row.priority as OrderPriority,
        shipByDate: row.shipByDate,
        codAmountPaise: row.codAmountPaise,
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
        followOnOfOrderId: row.followOnOfOrderId,
        followOnRootOrderId: row.followOnRootOrderId,
        followOnSeq: row.followOnSeq,
        followOnOrderId: row.followOnOrderId,
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
    query: ListWindowQuery & { readonly status?: PicklistLineStatus | undefined; readonly skippedBlockedBin?: boolean | undefined } = {},
  ): Promise<Page<PicklistLineEntry>> {
    const filter = { ...this.windowFilter(query), status: query.status, skippedBlockedBin: query.skippedBlockedBin };
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      return listPicklistLinesInTx(tx, tenantId, warehouseId, filter);
    });
  }

  private windowFilter(query: ListWindowQuery): WindowFilter {
    return {
      clientId: query.clientId,
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
   * Story 9-2b — the cutoff sweep for one tenant: raises
   * `wave.cutoff_at_risk` for each planned wave inside its policy's 60-minute
   * at-risk window, once per wave per IST date. Driven by the jobs shell's
   * `WaveCutoffSweepWorker`.
   */
  async sweepCutoffRisk(tenantId: string): Promise<CutoffSweepResult> {
    return this.waveCommand.sweepCutoffRisk(tenantId);
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
    query: ListClientFilteredQuery = {},
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
            // Story 1-5a (decision 4): any order of the client on the wave's
            // pick lines — a mixed wave appears under each of its clients; a
            // wave with no lines matches none.
            query.clientId === undefined
              ? undefined
              : anyOrderOfClient(
                  sql`select pll.order_id from picklist_lines pll where pll.tenant_id = ${waves.tenantId} and pll.wave_id = ${waves.id}`,
                  tenantId,
                  query.clientId,
                ),
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
    query: ListClientFilteredQuery = {},
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
          // Story 4-2a (A17) — the member orders' COD, live (order COD is
          // immutable, so this equals the create's frozen figure). Table-
          // qualified by hand (Gotcha 9: drizzle renders a selected column
          // bare, and a bare name in a correlated subquery binds the INNER
          // from-list).
          codShipmentCount: sql<number>`(select count(o.cod_amount_paise)::int from shipments sh join orders o on o.id = sh.order_id and o.tenant_id = sh.tenant_id where sh.tenant_id = manifests.tenant_id and sh.manifest_id = manifests.id)`,
          codTotalPaise: sql<string>`(select coalesce(sum(o.cod_amount_paise), 0)::bigint from shipments sh join orders o on o.id = sh.order_id and o.tenant_id = sh.tenant_id where sh.tenant_id = manifests.tenant_id and sh.manifest_id = manifests.id)`,
          createdBy: manifests.createdBy,
          createdAt: manifests.createdAt,
          updatedAt: manifests.updatedAt,
        })
        .from(manifests)
        .where(
          and(
            eq(manifests.tenantId, tenantId),
            eq(manifests.warehouseId, warehouseId),
            // Story 1-5a (decision 4): any order of the client among the
            // manifest's shipments — a carrier pickup is never split by client.
            query.clientId === undefined
              ? undefined
              : anyOrderOfClient(
                  sql`select sh.order_id from shipments sh where sh.tenant_id = ${manifests.tenantId} and sh.manifest_id = ${manifests.id}`,
                  tenantId,
                  query.clientId,
                ),
            before === undefined
              ? undefined
              : sql`(${manifests.createdAt}, ${manifests.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(manifests.createdAt), desc(manifests.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        ...row,
        codShipmentCount: Number(row.codShipmentCount),
        codTotalPaise: Number(row.codTotalPaise),
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
    const snapshot = await this.dispatchCommand.dispatchOrder(command, idempotencyKey);
    // Story 4-2c (decision 6) — once the dispatch has committed, one
    // best-effort allocation of the follow-on it opened, so stock already
    // free (units in another bin) is reserved at once. NEVER throws (the
    // post-commit rule): the dispatch answered; the sweep retries. A replay
    // re-attempting it is harmless — a held line is not eligible twice.
    const followOnOrderId = snapshot.dispatch.followOnOrderId ?? null;
    if (followOnOrderId !== null) {
      try {
        await this.allocation.allocateOrderCore(command.tenantId, followOnOrderId, { entry: 'dispatch' });
      } catch (err) {
        this.logger.error(
          `After-dispatch allocation of follow-on ${followOnOrderId} failed — the sweep retries it: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return snapshot;
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
    todayIst: string,
  ): Promise<PickTask[]> {
    return this.pickCommand.getPickTasksInTx(tx, tenantId, warehouseId, todayIst);
  }

  /**
   * The same read in its OWN tenant transaction — what the api shell calls
   * when it joins this arm onto the device catalog snapshot. One transaction,
   * one pooled connection, taken AFTER the snapshot's own has been released:
   * the shell composes the two facades sequentially rather than nesting, so
   * neither read can queue behind the other.
   */
  async getPickTasks(tenantId: string, warehouseId: string, todayIst: string): Promise<PickTask[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getPickTasksInTx(tx, tenantId, warehouseId, todayIst),
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
    todayIst: string,
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
        orderPriority: orders.priority,
        orderShipByDate: orders.shipByDate,
        codAmountPaise: orders.codAmountPaise,
        followOnSeq: orders.followOnSeq,
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
      // Story 4-2a (A16) — the urgency key first (on the snapshot's IST date),
      // then the old order: each order's rows stay contiguous (orders.id ends
      // the key), so the whole-order truncation below never cuts an urgent
      // order before a routine one.
      .orderBy(
        orderUrgencyOrderBy(todayIst, {
          priority: sql`${orders.priority}`,
          shipByDate: sql`${orders.shipByDate}`,
          createdAt: sql`${orders.createdAt}`,
          id: sql`${orders.id}`,
        }),
        asc(skus.code),
        asc(picks.skuId),
      )
      .limit(MAX_SNAPSHOT_PACK_TASKS + 1);

    // Whole-order truncation — `truncateToWholeGroups`, keyed by order. The
    // over-read is `MAX_SNAPSHOT_PACK_TASKS + 1` so the function can see
    // whether the ceiling fell inside an order.
    const rows = truncateToWholeGroups(overRead, MAX_SNAPSHOT_PACK_TASKS, (row) => row.orderId);

    // Story 4-2c (A16) — per (order, SKU) what the order ORDERED (its LEAF
    // lines — a kit parent holds nothing and is never packed), and per order
    // whether any leaf line was picked below its quantity: the bench's
    // "Short — the rest ships later" banner. One read over the kept orders.
    const orderIds = [...new Set(rows.map((row) => row.orderId))];
    const leafFacts =
      orderIds.length === 0
        ? []
        : ((await tx.execute(sql`
            select ol.order_id as "orderId", ol.sku_id as "skuId", ol.qty::text as "qty",
                   (ol.parent_line_id is not null) as "kitComponent",
                   coalesce((select sum(p.qty) from picks p where p.tenant_id = ol.tenant_id and p.order_line_id = ol.id), 0)::bigint::text as "picked"
            from order_lines ol
            where ol.tenant_id = ${tenantId}::uuid
              and ol.order_id = any(${sql.param(orderIds)}::uuid[])
              and not exists (select 1 from order_lines c where c.tenant_id = ol.tenant_id and c.parent_line_id = ol.id)
          `)) as unknown as { orderId: string; skuId: string; qty: string; picked: string; kitComponent: boolean }[]);
    const orderedBySku = new Map<string, number>();
    const shortOrders = new Set<string>();
    for (const fact of leafFacts) {
      const key = `${fact.orderId}:${fact.skuId}`;
      orderedBySku.set(key, (orderedBySku.get(key) ?? 0) + Number(fact.qty));
      // Code review C5 — "short" means a follow-on will be opened (A9): a
      // plain line short by at least one base unit, or a kit component short
      // at all (a kit counts whole kits). A weighed line picked 0.998 of 1 kg
      // opens none, so the bench must not promise one.
      const owed = Number(fact.qty) - Number(fact.picked);
      if (fact.kitComponent ? owed > 0 : owed >= MIN_FOLLOW_ON_REMAINDER_MILLI) shortOrders.add(fact.orderId);
    }

    const packTasks: PackTask[] = rows.map((row) => ({
      orderId: row.orderId,
      skuId: row.skuId,
      skuCode: row.skuCode,
      skuName: row.skuName,
      // Base units at the response edge (story 10.1) — the count the bench's
      // exact-match gate compares against.
      pickedQty: fromMilli(Number(row.pickedQty)),
      catchWeightTracked: row.catchWeightTracked,
      orderPriority: row.orderPriority as OrderPriority,
      orderShipByDate: row.orderShipByDate,
      codAmountPaise: row.codAmountPaise,
      orderedQty: fromMilli(orderedBySku.get(`${row.orderId}:${row.skuId}`) ?? Number(row.pickedQty)),
      orderShortfall: shortOrders.has(row.orderId),
      followOnSeq: row.followOnSeq,
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
  async getPackTasks(tenantId: string, warehouseId: string, todayIst: string): Promise<PackWorkRead> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getPackTasksInTx(tx, tenantId, warehouseId, todayIst),
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

  /**
   * Story 21-5b — the `per_pick` dispute drill: the `picks` rows
   * `countPicksInTx` counts, one row each, on the SAME predicate
   * (`picksPredicate`), ascending on `(created_at, id)` and keyset-paged
   * after `window.after` (picks of one transaction share a `created_at`, so
   * the id breaks the tie). Each row names its order (source and channel
   * event id — the order row is outbound's own), the SKU, the scanned bin,
   * the quantity (milli-units, as text) and the picker. `createdAt` is the
   * raw `::text`.
   */
  async pickRecordsInTx(
    tx: TenantTx,
    scope: ClientCountScope,
    from: string,
    to: string,
    window: KeysetWindow,
  ): Promise<PickRecordRow[]> {
    const after =
      window.after === null ? sql`` : sql`and (p.created_at, p.id) > (${window.after.createdAt}::timestamptz, ${window.after.id}::uuid)`;
    const rows = (await tx.execute(sql`
      select p.id as "id", p.created_at::text as "createdAt", p.warehouse_id as "warehouseId",
        p.order_id as "orderId", o.source as "orderSource", o.external_event_id as "orderExternalEventId",
        o.client_order_ref as "orderClientOrderRef",
        o.follow_on_seq as "orderFollowOnSeq", o.follow_on_root_order_id as "orderFollowOnRootOrderId",
        p.sku_id as "skuId", s.code as "skuCode", s.name as "skuName", p.qty::text as "qtyMilli",
        b.code as "binCode", p.picked_by as "actorId"
      from picks p
      join skus s on s.tenant_id = p.tenant_id and s.id = p.sku_id
      left join orders o on o.tenant_id = p.tenant_id and o.id = p.order_id
      left join bins b on b.tenant_id = p.tenant_id and b.id = p.bin_id
      where ${picksPredicate(scope, from, to)}
        ${after}
      order by p.created_at, p.id
      limit ${window.limit}
    `)) as unknown as PickRecordRow[];
    return rows.map((row) => ({ ...row }));
  }

  /**
   * Story 21-5b — the client-facing reference of each order: its source
   * (`manual` or a channel), the channel's event id (null on a manual
   * order) and — story 4-1b — the client's own order number (null when
   * none); the web labels the order `clientOrderRef ?? externalEventId ??
   * short id`. The dispatched-order
   * drill reads its orders from the ledger (inventory) and names them here.
   * An id with no order row is absent from the map.
   */
  async orderRefsInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, OrderRef>> {
    const distinct = [...new Set(orderIds)].filter((id) => UUID_RE.test(id));
    if (distinct.length === 0) return new Map();
    const rows = (await tx.execute(sql`
      select o.id as "orderId", o.source as "source", o.external_event_id as "externalEventId",
             o.client_order_ref as "clientOrderRef",
             o.follow_on_seq as "followOnSeq", o.follow_on_root_order_id as "followOnRootOrderId"
      from orders o
      where o.tenant_id = ${tenantId}::uuid and o.id = any(${sql.param(distinct)}::uuid[])
    `)) as unknown as OrderRef[];
    return new Map(
      rows.map((row) => [
        row.orderId,
        {
          orderId: row.orderId,
          source: row.source,
          externalEventId: row.externalEventId,
          clientOrderRef: row.clientOrderRef,
          followOnSeq: row.followOnSeq === null ? null : Number(row.followOnSeq),
          followOnRootOrderId: row.followOnRootOrderId,
        },
      ]),
    );
  }

  /**
   * Story 5-2a (shared with 5-2b, decision 2) — the client of each order, in
   * the caller's transaction (the `order.dispatched` payload carries none).
   * An id with no order row is absent from the map. Read-only.
   */
  async orderClientIdsInTx(tx: TenantTx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, string>> {
    const distinct = [...new Set(orderIds)].filter((id) => UUID_RE.test(id));
    if (distinct.length === 0) return new Map();
    const rows = (await tx.execute(sql`
      select o.id::text as "orderId", o.client_id::text as "clientId"
      from orders o
      where o.tenant_id = ${tenantId}::uuid and o.id = any(${sql.param(distinct)}::uuid[])
    `)) as unknown as { orderId: string; clientId: string }[];
    return new Map(rows.map((row) => [row.orderId, row.clientId]));
  }

  /**
   * Story 5-2a (A6; shared with 5-2b) — the kit PARENT lines among
   * `orderLineIds`: a line another line names as its `parent_line_id`. A kit
   * parent carries no picks, so a client-facing dispatch drops it and lists
   * its components. Read-only, in the caller's transaction.
   */
  async kitParentLineIdsInTx(tx: TenantTx, tenantId: string, orderLineIds: readonly string[]): Promise<Set<string>> {
    const distinct = [...new Set(orderLineIds)].filter((id) => UUID_RE.test(id));
    if (distinct.length === 0) return new Set();
    const rows = (await tx.execute(sql`
      select distinct ol.parent_line_id::text as "id"
      from order_lines ol
      where ol.tenant_id = ${tenantId}::uuid and ol.parent_line_id = any(${sql.param(distinct)}::uuid[])
    `)) as unknown as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Story 1-1 — the SKU of each order line, in the caller's transaction. A
   * SKU code is unique per (tenant, client) only, so a reader that must name
   * ONE SKU (invoicing's HSN hint) keys on the line's `sku_id`, never its
   * frozen code. An id with no line row is absent from the map.
   */
  async orderLineSkuIdsInTx(
    tx: TenantTx,
    tenantId: string,
    orderLineIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const distinct = [...new Set(orderLineIds)].filter((id) => UUID_RE.test(id));
    if (distinct.length === 0) return new Map();
    const rows = await tx
      .select({ id: orderLines.id, skuId: orderLines.skuId })
      .from(orderLines)
      .where(and(eq(orderLines.tenantId, tenantId), inArray(orderLines.id, distinct)));
    return new Map(rows.map((row) => [row.id, row.skuId]));
  }
}

/** Story 21-5b — an order's client-facing reference. */
export interface OrderRef {
  readonly orderId: string;
  readonly source: string;
  /** The channel's event id; null on a manual order. */
  readonly externalEventId: string | null;
  /** Story 4-1b — the client's own order number; null when none. */
  readonly clientOrderRef: string | null;
  /** Story 4-2c — the follow-on's `-BO{seq}` and the chain's root (the label's short id); null on a root. */
  readonly followOnSeq: number | null;
  readonly followOnRootOrderId: string | null;
}

/** Story 21-5b — one pick of a pick drill (quantity milli-units as text). */
export interface PickRecordRow {
  readonly id: string;
  /** `p.created_at::text` — the raw Postgres text. */
  readonly createdAt: string;
  readonly warehouseId: string;
  readonly orderId: string;
  /** Null only when the order row is missing. */
  readonly orderSource: string | null;
  readonly orderExternalEventId: string | null;
  /** Story 4-1b — the order's client order number; null when none (or the order row is missing). */
  readonly orderClientOrderRef: string | null;
  /** Story 4-2c — the order's `-BO{seq}` and its chain's root; null on a root (or a missing order row). */
  readonly orderFollowOnSeq: number | null;
  readonly orderFollowOnRootOrderId: string | null;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly qtyMilli: string;
  readonly binCode: string | null;
  readonly actorId: string;
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
