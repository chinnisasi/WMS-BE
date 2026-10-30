/**
 * Story 4-9a — the freight load's vocabularies (guide §4: the TS tuple beside
 * its owner, the 0119 CHECK, the DTO enum over the same tuple). A pure file:
 * it imports only `shared/`, so the commands, the reads and the DTOs import it
 * by value without a cycle (the 5-5a rule).
 */

export const FREIGHT_LOAD_STATUSES = ['open', 'dispatched', 'cancelled'] as const;
export type FreightLoadStatus = (typeof FREIGHT_LOAD_STATUSES)[number];

export const FREIGHT_CONSIGNMENT_STATUSES = ['planned', 'removed', 'dispatched'] as const;
export type FreightConsignmentStatus = (typeof FREIGHT_CONSIGNMENT_STATUSES)[number];

export const FREIGHT_SCAN_STATUSES = ['loaded', 'unloaded'] as const;
export type FreightScanStatus = (typeof FREIGHT_SCAN_STATUSES)[number];

/** A2, A42 — why a dispatched consignment's loading is not evidence of every package. */
export const FREIGHT_LOAD_EXCEPTIONS = ['packages-unscanned', 'not-on-device-list'] as const;
export type FreightLoadException = (typeof FREIGHT_LOAD_EXCEPTIONS)[number];

export const FREIGHT_SOURCES = ['web', 'handheld'] as const;

/** A10 — an order refused by the add (one code each, in classification order). */
export const FREIGHT_ADD_REFUSALS = [
  'order-not-found',
  'warehouse-mismatch',
  'order-not-open',
  'order-on-freight-load',
  'order-has-courier-shipment',
] as const;
export type FreightAddRefusal = (typeof FREIGHT_ADD_REFUSALS)[number];

/**
 * A14 — an order refused at departure (one code each, in classification order):
 * 4-6a's three gate codes LAST, so a consignment code never masks a recall.
 */
export const FREIGHT_DISPATCH_REFUSALS = [
  'consignment-removed',
  'order-not-ready',
  'order-already-dispatched',
  'client-departed',
  'packages-not-loaded',
  'order-holds-recalled-batch',
  'consignment-documents-missing',
  'eway-bill-required',
  'eway-bill-expired',
] as const;
export type FreightDispatchRefusal = (typeof FREIGHT_DISPATCH_REFUSALS)[number];

export const FREIGHT_LIST_VIEWS = ['open', 'dispatched', 'pod-pending', 'delivery-exceptions', 'cancelled'] as const;
export type FreightListView = (typeof FREIGHT_LIST_VIEWS)[number];

export const FREIGHT_CANDIDATE_STATUSES = ['packed', 'accepted', 'all'] as const;
export type FreightCandidateStatus = (typeof FREIGHT_CANDIDATE_STATUSES)[number];

export const FREIGHT_SCAN_ACTIONS = ['load', 'unload'] as const;
export type FreightScanAction = (typeof FREIGHT_SCAN_ACTIONS)[number];

export const FREIGHT_DECISIONS = ['dispatch', 'leave'] as const;
export type FreightDecision = (typeof FREIGHT_DECISIONS)[number];

/** The reasons the commands write (removal, unloading). */
export const FREIGHT_REASONS = {
  leftAtDeparture: 'Left on the dock at departure',
  notOnDeviceList: "Not on the device's dispatch list",
  orderCancelled: 'Order cancelled',
  removedFromLoad: 'Removed from the load',
} as const;
