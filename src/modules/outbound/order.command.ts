import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  idempotencyKeys,
  orderLines,
  ingestBackorderRefusals,
  orders,
  picklistLines,
  skus,
} from '../../shared/db/schema';
import type { Order, OrderLine, SkuStatus } from '../../shared/db/schema';
import { MAX_EXTERNAL_ID_LENGTH, UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { addIsoDays, canonicalInstant, isIsoDate, nowIso } from '../../shared/primitives/time';
import {
  MAX_COD_AMOUNT_PAISE,
  ORDER_PRIORITIES,
  ORDER_TYPES,
  PORTAL_ORDER_PRIORITIES,
  type OrderPriority,
  type OrderType,
} from './order-urgency';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import {
  assertWarehouseInTenant,
  getMemberPortalFactsIn,
  getMemberRoleIn,
  getWarehouseCodeInTx,
  getWarehouseNameInTx,
} from '../tenancy/tenancy.service';
// Story 1-6d — licence enforcement: compliance's FREE functions (never its
// Nest module — compliance forward-references outbound, so it would cycle).
import {
  activeLicenceFactsInTx,
  licenceCoverageInTx,
  licenceCoverageOf,
  licenceEnforcedInTx,
  licenceNotCovered,
  licenceToday,
} from '../compliance/licence-enforcement';
import { needsOf, type LicenceFacts, type LicenceGoodsProfile } from '../../shared/primitives/licence';
import { normalizeGstinInput, GSTIN_RE, gstinPrefixProblem } from '../../shared/primitives/gstin';
import { nicText } from '../../shared/primitives/nic-text';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import type { KitCompositionLine } from '../catalog/catalog.facade';
import { lockSkuStatusesInTx, skuInactive } from '../catalog/catalog.facade';
import { picklistLineDrewUnits } from './wave.command';
import {
  ORDER_LINE_OWNER_TYPE,
  ORDER_LINE_RESERVATION_TTL_SECONDS,
  grantKitBlock,
  grantLineHold,
} from './reserve-line';
import { completeKits } from './follow-on';
import type { ReservationSnapshot } from '../inventory/inventory.facade';
import {
  MAX_QUANTITY_MILLI,
  QUANTITY_DECIMALS,
  QUANTITY_SCALE,
  assertRecordableQuantity,
  fromMilli,
} from '../../shared/primitives/quantity';
import {
  addressFingerprint,
  assertAddress,
  addressFromColumns,
  normalizeAddressInput,
} from '../../shared/primitives/address';
import type { AddressInput, AddressSnapshot } from '../../shared/primitives/address';
import { uomPrecision } from '../catalog/uom';
import {
  assertSingleClientInTx,
  assertClientTakesWorkInTx,
  clientInactive,
  shareLockClientInTx,
} from '../clients/clients.facade';

// ── state machine + policy constants (the outbound module exclusively owns
// the order state machine, AD-6 — no other module may add or transition
// order states; the additive arms below are the module's registry) ───────────

/**
 * The order lifecycle arms. Story 4.1 shipped `accepted` / `cancelled`;
 * story 4.5 added `ready_to_dispatch` — the order has been verified at the
 * pack bench against what was actually picked; story 4.6 adds `dispatched`,
 * the arm that closes the order. Additive only, mirrored by
 * `orders_status_check` (migrations 0023 / 0024; `orders.spec.ts` pins the
 * two together).
 *
 * `ready_to_dispatch` is TERMINAL for every pre-dispatch flow: cancel refuses
 * it below, both wave-selection paths exclude it (they select `accepted`
 * only), and a queued pick against it quarantines.
 *
 * `dispatched` is TERMINAL outright — the order shipped, its shipment is
 * journalled as one zero-quantity `dispatch.dispatched` event per line, and
 * every `committed` hold it owned has been retired to `released` (which is
 * what finally corrects ATP). There is no un-dispatch, no return and no
 * re-open: every guard in the module is an allow-list, so the new arm is
 * refused everywhere by construction — the ONE exception audited in 4.6 was
 * `pick.command.ts`'s terminal CLASSIFICATION, which had to learn the arm to
 * quarantine a queued pick instead of retrying it forever.
 */
export const ORDER_STATUSES = ['accepted', 'ready_to_dispatch', 'dispatched', 'cancelled'] as const;

/**
 * Story 4-2c (A3) — test seams on `cancelOrder` (never set in production):
 * `afterPrecheck` runs between the hold pre-check and the flip, so a suite
 * can commit a backorder allocation in exactly that window.
 */
export const cancelOrderTestHooks: { afterPrecheck?: ((orderId: string) => Promise<void>) | undefined } = {};
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The line fulfillment arms shipped in story 4.1. */
export const ORDER_LINE_STATUSES = ['open', 'backordered'] as const;
export type OrderLineStatus = (typeof ORDER_LINE_STATUSES)[number];

/** The order state machine's source arms (Epic 7's adapters keep the union). */
export const ORDER_SOURCES = ['manual', 'ingested'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/**
 * The reservation owner type every accepted order line holds through (the
 * `reservations.owner_type` arm Epic 2 reserved for this story's writers).
 */
export const ORDER_OWNER_TYPE = ORDER_LINE_OWNER_TYPE;

/**
 * Accepted-order reservation TTL (the human decision 2026-09-10): seven
 * days. Expiry is detected downstream at commit time (409 `conflict`
 * "Reservation is not held") — no order-state machinery for expired holds
 * in this story; the reservation reaper restores the ATP either way.
 */
export const ORDER_RESERVATION_TTL_SECONDS = ORDER_LINE_RESERVATION_TTL_SECONDS;

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
/**
 * The channel-dedup partial unique index (the race backstop's name). Story
 * 4-2c (0104) — ROOT orders only, renamed from `orders_source_event_unique`
 * (a follow-on copies its root's channel event).
 */
const ORDERS_SOURCE_EVENT_UNIQUE = 'orders_source_event_root_unique';
/**
 * Story 4-1b — the per-client live client-order-number index (0088; the race
 * backstop). Story 4-2c (0104) — ROOT orders only, renamed from
 * `orders_client_order_ref_live_unique`.
 */
const ORDERS_CLIENT_ORDER_REF_LIVE_UNIQUE = 'orders_client_order_ref_live_root_unique';

/**
 * The line-quantity ceiling, in milli-units (story 10.1). The column is
 * `bigint` now, so the binding limit is the 2⁵³ exact-integer ceiling every
 * quantity crosses in JavaScript and in the Valkey script's Lua. An input
 * above it would pass every other validation and then round silently — after
 * grants were made and released. The typed 400 is the boundary.
 */
const MAX_LINE_QUANTITY = MAX_QUANTITY_MILLI;

/**
 * Story 8-1d: the buyer legal / trade name's ceiling, in CODE POINTS
 * (`[...s].length`, after the JS trim) — NIC's `toTrdName` is 100 wide.
 */
export const MAX_CONSIGNEE_LEGAL_NAME_LENGTH = 100;

/**
 * Story 8-1d: the buyer legal name's normal form — JS `trim()`, and a blank
 * value reads as ABSENT (null). Lenient: never throws, because it runs
 * before the hash; the refusals live behind the replay lookup.
 */
export function normalizeConsigneeLegalName(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const value = raw.trim();
  return value === '' ? null : value;
}

/**
 * Story 4-1b — the client order number's ceiling (characters; the shape is
 * ASCII-only, so characters, code points and UTF-16 units agree).
 */
export const MAX_CLIENT_ORDER_REF_LENGTH = 64;

/**
 * Story 4-1b — the client order number's shape: 1–64 printable ASCII
 * characters, the first and the last not a space. A byte-for-byte mirror of
 * `orders_client_order_ref_shape_check` (migration 0088), pinned against it by
 * test/order-client-ref.spec.ts.
 */
export const CLIENT_ORDER_REF_RE = /^[!-~]([ -~]{0,62}[!-~])?$/;

/**
 * Story 4-1b — the client order number's normal form: JS `trim()`, and a
 * blank (or whitespace-only) value reads as ABSENT (null). Lenient — never
 * throws, because it runs before the hash; the shape refusal lives behind the
 * replay lookup (the 8-1d precedent).
 */
export function normalizeClientOrderRef(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const value = raw.trim();
  return value === '' ? null : value;
}

// ── command inputs ───────────────────────────────────────────────────────────

/** One line as the client supplies it (manual entry and ingestion alike). */
export interface OrderLineInput {
  readonly skuId: string;
  /**
   * Ordered quantity. **In the SKU's BASE UoM on the way in** (story 10.2 —
   * the controller no longer scales), and in milli-units once
   * `assertRecordableQuantity` has converted it inside the create preflight.
   * The same shape carries both because the conversion is a step in one
   * command, not a crossing between two layers.
   */
  readonly quantity: number;
  /**
   * Story 8-1 — the line's selling rate in integer paise per the SKU's BASE
   * unit, OPTIONAL (channel-ingested orders arrive without prices; those
   * lines park `awaiting-data` at invoicing until the operator prices
   * them). Validated + normalized behind the replay lookup; stamped onto
   * `order_lines.rate_paise` at acceptance and NEVER touched again (no edit
   * command; invoicing's override freezes into the invoice document).
   * A kit line's rate is inert — the parent drops at zero picks and the
   * components ride their per-component invoice overrides.
   */
  readonly ratePaise?: number | undefined;
}

export interface CreateOrderCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  /** `manual` (default) or `ingested` (the adapter-ready ingestion surface). */
  readonly source: OrderSource;
  readonly lines: readonly OrderLineInput[];
  /**
   * Where the shipment goes (story 11-1). REQUIRED at create (the human
   * decision 2026-09-19) on manual and ingested orders alike — carriers rate,
   * label and manifest from it. Validated command-side (`assertAddress`):
   * atomic, never partial; the pincode is text. Absent on no caller today;
   * the optionality here is the adapter path's, and the preflight refuses an
   * absent address before any write.
   */
  readonly destination?: AddressInput | undefined;
  /**
   * Story 8-1 — the consignee's GSTIN when the buyer is GST-registered.
   * Optional; its first two digits are the place-of-supply code the invoice
   * resolves (Design Notes: the GSTIN outranks address text). Shape-checked
   * against `GSTIN_RE` behind the replay lookup; stamped at create only.
   */
  readonly consigneeGstin?: string | undefined;
  /**
   * Story 8-1d — the GST-registered buyer's legal / trade name. Optional;
   * only alongside `consigneeGstin`; at most 100 code points after trimming
   * (both refused behind the replay lookup). Printed as the invoice's buyer
   * (and so NIC's `toTrdName`), falling back to the destination contact.
   */
  readonly consigneeLegalName?: string | undefined;
  /**
   * Story 4-1b — the client's own order number (optional; manual orders only
   * — an ingested order carrying one is 400). Trimmed, blank = absent; 1–64
   * printable ASCII characters (refused behind the replay lookup); unique per
   * client among live orders (409 `duplicate-client-order-ref`). Create-only.
   */
  readonly clientOrderRef?: string | undefined;
  /**
   * Story 4-2a — the order header fields (all optional, create-only). Each is
   * normalized before the hash (a string trimmed; `undefined`, `null` and a
   * blank string read as ABSENT) and joins the payload hash only when sent,
   * as sent; the value checks run behind the replay lookup (`assertOrderFields`).
   * An ingested order may carry `codAmountPaise` only (A3).
   */
  readonly orderType?: unknown;
  readonly priority?: unknown;
  readonly shipByDate?: unknown;
  readonly codAmountPaise?: unknown;
  /** Channel arms — required together when `source: 'ingested'`, else absent. */
  readonly integrationId?: string | undefined;
  readonly externalEventId?: string | undefined;
  /**
   * Story 7.2 (RD-3) — the CONNECTION's backorder policy rides the ingest
   * call: `'reject'` turns ANY post-grant shortfall (`granted < demanded`,
   * zero-grant lines included) into a whole-order refusal AFTER the grants
   * and BEFORE the write tx — every hold released, no `orders` row. Default
   * `'accept'` today's semantics bit-for-bit (every manual caller unchanged).
   */
  readonly backorderPolicy?: 'accept' | 'reject' | undefined;
}

/**
 * Story 4-1a — `POST portal/orders`: a client user places an order for its
 * OWN SKUs. `clientId` is the portal session's (the guard's re-read), never
 * the body's. No source, no channel arms, no rate (the portal line carries
 * none) and no backorder policy — the portal always refuses a shortage.
 */
export interface PlacePortalOrderCommand {
  readonly tenantId: string;
  /** From `PortalSession` — never from the request body. */
  readonly clientId: string;
  /** The client-portal user (the audit actor). */
  readonly actorUserId: string;
  readonly warehouseId: string;
  /** In the SKU's BASE UoM; converted behind the replay lookup (story 10.2). */
  readonly lines: readonly { readonly skuId: string; readonly quantity: number }[];
  readonly destination?: AddressInput | undefined;
  readonly consigneeGstin?: string | undefined;
  readonly consigneeLegalName?: string | undefined;
  /** Story 4-1b — the client's own order number (the staff create's rules; the portal's 409 copy). */
  readonly clientOrderRef?: string | undefined;
  /** Story 4-2a — the order header fields (the staff create's rules; portal `urgent` refused, A12). */
  readonly orderType?: unknown;
  readonly priority?: unknown;
  readonly shipByDate?: unknown;
  readonly codAmountPaise?: unknown;
}

/**
 * Story 4-1a — the portal's answer to a placed order (and its stored
 * idempotency snapshot): an exact key allowlist. No reservation, rate, phone,
 * status or line detail — the client reads the order itself through
 * `portal/orders/{orderId}`.
 */
export interface PortalPlacedOrder {
  readonly orderId: string;
  readonly warehouseName: string;
  /** Top-level lines (the portal places no kits, so every line). */
  readonly lineCount: number;
  /** The order's `created_at`, canonical ISO-8601 UTC. */
  readonly placedAt: string;
  /**
   * Story 4-1b — the client's own order number as stored (trimmed); null when
   * none was given. Optional: a response stored before 4-1b lacks it (a reader
   * treats absent as null).
   */
  readonly clientOrderRef?: string | null;
  /**
   * Story 4-2a — the order header fields as stored (A1). Optional: a response
   * stored before 4-2a lacks them (a reader treats absent as null).
   */
  readonly orderType?: OrderType | null;
  readonly priority?: OrderPriority | null;
  readonly shipByDate?: string | null;
  readonly codAmountPaise?: number | null;
}

export interface CancelOrderCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly orderId: string;
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** One order line as every surface returns it — the shortfall always derived. */
export interface OrderLineSnapshot {
  readonly id: string;
  readonly orderId: string;
  readonly skuId: string;
  readonly qty: number;
  /** What acceptance actually holds through the reservation journal (≤ qty). */
  readonly reservedQty: number;
  /** Derived: qty − reservedQty — the backorder shortfall, never stored. */
  readonly shortfallQty: number;
  readonly status: string;
  /** The line's journal hold; null on a fully-backordered line. */
  readonly reservationId: string | null;
  /** The hold's live journal state (`held` at accept; read through the facade). */
  readonly reservationState: string | null;
  /**
   * Story 11.4 — the kit line this component line exploded from at
   * acceptance; null on every ordinary line and on kit parent lines. The
   * PARENT is found by inversion (any line whose id another line names).
   */
  readonly parentLineId: string | null;
  readonly createdAt: string;
}

/**
 * A line's client-facing fields with a fixed key order (the idempotency hash is key-order dependent).
 *
 * ── story 8-1: `ratePaise` joins the fingerprint ───────────────────────────
 * Pinned in the spec's Design Notes: a DELIBERATE 11-1-shaped hash break, not
 * a silent input change — a pre-8-1 key replayed against this build hashes
 * differently and answers 422 `idempotency-key-reuse` (or
 * `order-source-conflict` for a channel redelivery) instead of replaying.
 * `ratePaise` is the line's price at acceptance — invoicing prices from it —
 * so a payload whose price differs on redelivery is a different command.
 */
function lineFingerprint(line: OrderLineInput): Record<string, unknown> {
  return { skuId: line.skuId, quantity: line.quantity, ratePaise: line.ratePaise };
}

/** The API response body for an order (the idempotency snapshot). */
export interface OrderSnapshot {
  readonly order: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly status: OrderStatus;
    readonly source: OrderSource;
    readonly integrationId: string | null;
    readonly externalEventId: string | null;
    /**
     * Story 4-1b — the client's own order number; null when none was given.
     * Optional on the interface because a snapshot stored before 4-1b (an
     * idempotent replay) does not carry it — a reader treats absent as null.
     */
    readonly clientOrderRef?: string | null;
    /**
     * Story 4-2a — the order header fields. Optional on the interface (A1): a
     * snapshot stored before 4-2a lacks them; a reader treats absent as null.
     * `orderType` is null on a pre-4-2a order row; `priority` reads `normal`.
     */
    readonly orderType?: OrderType | null;
    readonly priority?: OrderPriority | null;
    readonly shipByDate?: string | null;
    readonly codAmountPaise?: number | null;
    /** Where the shipment goes (story 11-1); null on a pre-11.1 order row. */
    readonly destination: AddressSnapshot | null;
    /**
     * Story 21-2b — the client the order is for, derived from its lines' and
     * kit components' SKUs. Optional and nullable on the interface because a
     * stored snapshot written before 21-2b (an idempotent replay) does not
     * carry it; every snapshot built now sets it.
     */
    readonly clientId?: string | null;
    /**
     * Story 4-2c — the backorder follow-on link. On a follow-on: its parent
     * (`followOnOfOrderId`), the chain's root (`followOnRootOrderId`) and its
     * place in the chain (`followOnSeq`, the label's `-BO{seq}`); all null on
     * a root. On ANY order: the follow-on its short dispatch opened
     * (`followOnOrderId`), null when none. Optional: a snapshot stored before
     * 4-2c lacks them (read absent as null).
     */
    readonly followOnOfOrderId?: string | null;
    readonly followOnRootOrderId?: string | null;
    readonly followOnSeq?: number | null;
    readonly followOnOrderId?: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lines: readonly OrderLineSnapshot[];
  };
}

/**
 * The order commands (story 4.1): manual entry and idempotent ingestion
 * through ONE create path — acceptance reserves ATP per line through Epic
 * 2's reservation machinery (`InventoryFacade.grantReservation`,
 * `owner_type: 'order'`), and cancellation releases every open reservation
 * through the existing release path. Both follow the established command
 * invariant order: `assertPermission` (fresh DB role read) → idempotency
 * replay → validation → writes (uuidv7) → snapshot → in-tx outbox →
 * (audit) → `writeIdempotencyKey` last.
 *
 * The grant/reserve phase composes OUTSIDE the order-create transaction by
 * design: a reservation grant is itself a multi-transaction atomic unit
 * (probe tx → Valkey script → journal tx), so it cannot nest. The ordering
 * is what fails closed instead — every grant lands BEFORE the order-create
 * transaction opens, and any failure in either phase (a 503
 * `reservation-store-unavailable` from the store, a rejected create tx)
 * releases every reservation this command granted and writes nothing: the
 * invariant is "nothing accepted half-reserved", not "one transaction".
 */
@Injectable()
export class OrderCommandService {
  private readonly logger = new Logger('OrderCommand');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition at the command layer through the facades only
    // (AD-6): the per-line grants, the ATP reads, and the reservation-state
    // read ride the inventory facade's seam.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    // Story 11.4 — the kit explosion reads the flat BOM through the catalog
    // facade (`getKitCompositionInTx`), in the same tx that accepts the order.
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  /**
   * `POST .../orders` (manual + ingested): validates, dedupes channel
   * payloads at the database level, reserves ATP per line (the fixed
   * backorder policy — `min(qty, ATP)` reserved, the shortfall marked
   * `backordered`), and accepts the order in one create transaction that
   * also appends `order.created`, the audit row, and the idempotency key.
   * A reservation-store failure fails the WHOLE creation closed.
   *
   * Story 4-1a — the three phases are shared with the portal's
   * `placePortalOrder` through private phase helpers (`preflightPhase`,
   * `grantPhase`, `writePhase`); what differs between the two surfaces is an
   * `OrderSurface` (the authority gate, the transaction opener, the SKU read,
   * the licence check, the shortage refusal, the response). The staff
   * surface below reproduces this command's pre-4-1a behaviour, codes and
   * fingerprint exactly (pinned by the goldens in
   * `test/issuance-gate-parity.spec.ts`).
   */
  async createOrder(command: CreateOrderCommand, idempotencyKey: string): Promise<OrderSnapshot> {
    const plan = this.staffOrderPlan(command);
    return this.placeOrder(plan.command, idempotencyKey, plan.hashes, plan.surface);
  }

  /**
   * Story 4-1c — the order import's Check file: `createOrder`'s phase 1 —
   * every rule up to the grants (authority, the address, the GSTIN, the
   * client order number, the 4-2a fields, the SKUs, the client, the
   * licences) — with NO key: nothing is replayed and nothing is written.
   * It reserves nothing, so it cannot promise stock.
   */
  async checkOrder(command: CreateOrderCommand): Promise<OrderCheck> {
    return this.checkPlan(this.staffOrderPlan(command));
  }

  /**
   * Story 4-1c — the staff surface and the hash stage `createOrder` builds
   * (extracted unchanged, so `createOrder` and `checkOrder` run one plan).
   * The cheap request-shape refusals run here, above any transaction.
   */
  private staffOrderPlan(command: CreateOrderCommand): OrderPlan<OrderSnapshot> {
    // Story 1-6d (D18) — ONE IST date for the licence check, captured here and
    // used by both phases, so an order straddling IST midnight is judged once.
    const licenceDate = licenceToday();
    // A manual order carrying channel refs would be silently stripped below —
    // a believing client would get an order with no dedup protection on
    // redelivery. 400 before anything else.
    if (command.source !== 'ingested' && (command.integrationId !== undefined || command.externalEventId !== undefined)) {
      throw validationFailed(
        'Channel refs (integrationId/externalEventId) require source: "ingested".',
      );
    }
    // Story 4-1b (decision 4) — a channel order's reference is its
    // `externalEventId`; it never takes a client order number (whose per-client
    // uniqueness could otherwise fail an ingest). 400, beside the refusal above.
    // (Normalized first: a blank value on an ingested order reads as absent, not a 400.)
    if (command.source === 'ingested' && normalizeClientOrderRef(command.clientOrderRef) !== null) {
      throw validationFailed(
        'clientOrderRef is a manual order\'s field — a channel order is named by its externalEventId.',
      );
    }
    // Story 4-2a (A3) — a channel order never carries the manual fields (type,
    // priority, ship-by); its COD comes from the channel. 400, beside 4-1b's
    // refusal (normalized first: a blank value reads as absent).
    const orderFields = normalizeOrderFields(command);
    if (
      command.source === 'ingested' &&
      (orderFields.orderType !== null || orderFields.priority !== null || orderFields.shipByDate !== null)
    ) {
      throw validationFailed(
        'orderType, priority and shipByDate are a manual order\'s fields — a channel order carries only its cash-on-delivery amount.',
      );
    }
    const integrationId = command.source === 'ingested' ? (command.integrationId ?? null) : null;
    const externalEventId =
      command.source === 'ingested' ? (command.externalEventId ?? null) : null;

    // The payload hash (fixed key order — the hash is key-order dependent).
    // For an ingested order this is also the dedup fingerprint: the same
    // channel payload redelivered under a new idempotency key resolves to
    // the same order; a divergent payload on the same ref is a 422.
    // ── story 11-1: the destination address joins BOTH hashes ──────────────
    // Normalized (trimmed, blank line2 dropped) BEFORE hashing — deterministic
    // and DB-independent, so equivalent inputs hash identically. The key is
    // always present (`?? null`): a body without an address hashes DIFFERENTLY
    // from a pre-11.1 payload (whose hash lacked the key entirely), which is
    // the accepted replay break — an in-flight pre-11.1 key answers 422
    // `idempotency-key-reuse` / `order-source-conflict` instead of replaying.
    // Pre-launch, nothing to be compatible with; pinned EXPECTED in
    // `test/shipment-addresses.spec.ts`.
    const normalizedDestination = normalizeAddressInput(command.destination);

    // ── story 10.2: BOTH hashes below are over BASE units ─────────────────
    // Conversion moved out of the controller and into the create preflight,
    // behind the replay lookup, so the hashed line quantities changed with it.
    // Two consequences, both accepted deliberately under the pre-launch
    // premise (the same call story 10.1 made about the ledger hash chain):
    // an idempotency key written by a pre-10.2 build answers 422
    // `idempotency-key-reuse` rather than replaying, and a channel payload
    // delivered by one answers `order-source-conflict` rather than resolving
    // to its original order. `test/picking.spec.ts` pins the break as
    // EXPECTED. No compatibility branch exists; there is nothing to be
    // compatible with. (Story 11-1 grew the destination into both hashes —
    // the same break again, pinned the same way.)
    //
    // ── story 8-1: `consigneeGstin` joins BOTH hashes ─────────────────────
    // The spec's Design Notes pin this as a DELIBERATE break (the 11-1
    // family, never silent): the hash above carries the address only when
    // normalized; the GSTIN adds the buyer's registration identity invoicing
    // prices place-of-supply from. Normalized (`normalizeGstinInput` — the
    // LENIENT hash step) BEFORE hashing, absent = null; the shape refusal
    // lives in the preflight behind the replay lookup.
    const consigneeGstin = normalizeGstinInput(command.consigneeGstin);
    //
    // ── story 8-1d: `consigneeLegalName` joins BOTH hashes ONLY WHEN PRESENT
    // A deliberate exception to the always-present-key convention above
    // (IMPLEMENTATION-GUIDE §4): an always-present key would change EVERY
    // order's fingerprint, so every in-flight key would answer 422 and every
    // channel redelivery `order-source-conflict` — for a field almost no
    // request carries. Normalized first (JS trim, blank = absent), then
    // spread in after `consigneeGstin` only when non-null, so a request
    // without it hashes byte-identically to the pre-8-1d build (pinned by
    // golden hashes in `test/issuance-gate-parity.spec.ts`).
    const consigneeLegalName = normalizeConsigneeLegalName(command.consigneeLegalName);
    const legalNameFingerprint = consigneeLegalName === null ? {} : { consigneeLegalName };
    //
    // ── story 4-1b: `clientOrderRef` joins the payload hash ONLY WHEN PRESENT
    // The 8-1d conditional-key rule again: normalized first (JS trim, blank =
    // absent), spread in right after the legal name only when non-null, so an
    // order without one hashes byte-identically to the pre-4-1b build (the
    // existing goldens; new goldens pin the ref). Never in the channel
    // `sourcePayloadHash` — an ingested order carries none (refused above).
    const clientOrderRef = normalizeClientOrderRef(command.clientOrderRef);
    const clientOrderRefFingerprint = clientOrderRef === null ? {} : { clientOrderRef };
    const sourcePayloadHash =
      command.source === 'ingested'
        ? hashCommandPayload({
            warehouseId: command.warehouseId,
            destination: addressFingerprint(normalizedDestination) ?? null,
            consigneeGstin,
            ...legalNameFingerprint,
            lines: command.lines.map(lineFingerprint),
          })
        : null;
    //
    // ── story 4-2a: the order fields join the payload hash ONLY WHEN SENT ──
    // The 8-1d conditional-key rule (IMPLEMENTATION-GUIDE §4): each field
    // normalized first (a string trimmed, blank = absent), then spread in AS
    // SENT — never the derived default — at fixed positions right after
    // `clientOrderRef`: orderType, priority, shipByDate, codAmountPaise. An
    // order without them hashes byte-identically to the pre-4-2a build (the
    // existing goldens); an explicit `priority: 'normal'` hashes differently
    // from an omitted one (pinned). NEVER in the channel `sourcePayloadHash`:
    // a redelivery spanning the deploy must still resolve to its order.
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      source: command.source,
      integrationId,
      externalEventId,
      destination: addressFingerprint(normalizedDestination) ?? null,
      consigneeGstin,
      ...legalNameFingerprint,
      ...clientOrderRefFingerprint,
      ...orderFieldsFingerprint(orderFields),
      lines: command.lines.map(lineFingerprint),
    });

    // The staff surface: the operator-shape transaction (never stamped — an
    // order's reads and writes span the whole tenant), `orders.manage`, every
    // SKU of the tenant, the licence check in the command's own transaction
    // naming each gap, the connection's 9-1 refusal, and the operator snapshot.
    const staff: OrderSurface<OrderSnapshot> = {
      kind: 'staff',
      transaction: (fn) => withTenantTransaction(this.db, command.tenantId, fn),
      authorize: async (tx) => {
        // Authority at command-service entry — DB role read, same tx, BEFORE
        // the replay lookup (the deliberate fail-closed carve-out).
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'orders.manage',
        );
      },
      reauthorize: async () => {},
      loadLineSkus: (tx, skuIds) => this.assertSkuIdsInTenant(tx, command.tenantId, skuIds),
      prefetchLicences: async () => null,
      assertLicences: async (tx, _prefetched, order) => {
        if (tx === null) throw new Error('createOrder: the staff licence check runs inside its phase transaction');
        await this.assertLicencesCoverInTx(tx, command.tenantId, command.warehouseId, licenceDate, order);
      },
      backorderRefusal: () => new BackorderRejectedError(),
      // Names the clashing order: its id and warehouse ride the extensions, and
      // the detail names the warehouse code (staff may search the other site).
      duplicateClientOrderRef: async (tx, ref, clash) => {
        if (clash === null) {
          return duplicateClientOrderRef(
            `${ref} is already used by another live order of this client — find it with the search, or use a different number (a cancelled order frees its number).`,
          );
        }
        const code = await getWarehouseCodeInTx(tx, command.tenantId, clash.warehouseId);
        return duplicateClientOrderRef(
          `${ref} is already used by another live order of this client (in warehouse ${code}) — find it with the search, or use a different number (a cancelled order frees its number).`,
          { orderId: clash.orderId, warehouseId: clash.warehouseId },
        );
      },
      respond: async (_tx, snapshot) => snapshot,
    };

    return {
      command,
      hashes: {
        integrationId,
        externalEventId,
        consigneeGstin,
        consigneeLegalName,
        clientOrderRef,
        orderFields,
        licenceDate,
        sourcePayloadHash,
        payloadHash,
      },
      surface: staff,
    };
  }

  /**
   * Story 4-1a — `POST portal/orders`: a client user places an outbound order
   * for its OWN SKUs from the portal. A separate command (IMPLEMENTATION-GUIDE
   * §7e — a portal write is never a flag on the operator one) sharing the
   * order pipeline with `createOrder` through the phase helpers, so both
   * surfaces keep one set of order rules. The result is an ordinary `manual`
   * order of the session's client ("not a channel order", not "staff
   * entered"); its portal origin is the audit row's actor, the client user.
   *
   * What the portal surface changes:
   * - **Stamped.** Phase 1 and phase 3 open `withTenantTransaction(…,
   *   { clientId: command.clientId })` — RLS binds them to the session's
   *   client. The grants and releases stay operator-stamped (they run in the
   *   inventory facade's own transactions: reservation counters are tenant
   *   data, never a client's), as does the licence read (below).
   * - **Authority** (both phases, before anything else): `orders.place`, then
   *   the actor re-read (`getMemberPortalFactsIn` — not active 401, another
   *   client 403 `role-denied`, which also refuses an owner, who holds every
   *   capability), then `shareLockClientInTx` with its status (departed or
   *   suspended 403 via `clientInactive`). Repeated at the start of phase 3,
   *   so a suspension or deactivation committed between the phases cannot
   *   commit an order — the refusal releases every grant.
   * - **SKUs:** the client's ACTIVE NON-KIT SKUs only — exactly what
   *   `portal/skus` lists. Another client's SKU, a kit, an inactive SKU and an
   *   unknown id are the SAME 404 (never confirming another client's row);
   *   `mixed-client` is unreachable. A SKU deactivated between the phases
   *   refuses at phase 3 (409 `sku-inactive`) even when fully reserved — the
   *   portal never sells down.
   * - **Shortages refuse** (`backorderPolicy: 'reject'`): the whole order is
   *   refused 409 `order-backorder-rejected`, naming the short SKU codes.
   * - **Licences through an unstamped seam:** the 0084 policy hides every
   *   site licence (null `client_id`) from a client-stamped transaction, so
   *   the coverage rule's facts are read in an UNSTAMPED transaction of their
   *   own (`portalLicenceSnapshot`) — once phase 1 has passed its authority
   *   gate and missed the replay (judged against phase 1's SKUs, before any
   *   grant), and again just before phase 3 opens (judged in it against the
   *   locked SKUs; a line SKU the stamped read no longer sees refuses). A
   *   missing snapshot fails closed. A gap is refused with a GENERIC
   *   409 `licence-not-covered` — never which licence, which holder or the
   *   site.
   * - **The response** (and the stored idempotency snapshot) is the portal's
   *   own `{orderId, warehouseName, lineCount, placedAt}`, built in the write
   *   transaction; a replay never serves the operator snapshot, and the
   *   fingerprint starts with `surface: 'portal'`. A same-key race loser
   *   answers 409 `conflict` (the key's unique index, as on every command).
   */
  async placePortalOrder(command: PlacePortalOrderCommand, idempotencyKey: string): Promise<PortalPlacedOrder> {
    const plan = this.portalOrderPlan(command);
    return this.placeOrder(plan.command, idempotencyKey, plan.hashes, plan.surface);
  }

  /**
   * Story 4-1c — the portal order import's Check file: `placePortalOrder`'s
   * phase 1 (the gate, every rule up to the grants, and the portal's licence
   * judgement through its unstamped seam) with NO key — nothing replayed,
   * nothing written, nothing reserved (a shortage is found only at Import).
   */
  async checkPortalOrder(command: PlacePortalOrderCommand): Promise<OrderCheck> {
    return this.checkPlan(this.portalOrderPlan(command));
  }

  /**
   * Story 4-1c — the portal surface and the hash stage `placePortalOrder`
   * builds (extracted unchanged). The surface's transaction opener is THE
   * client stamp of the portal order: every transaction the pipeline opens
   * for it goes through `{ clientId: command.clientId }`.
   */
  private portalOrderPlan(command: PlacePortalOrderCommand): OrderPlan<PortalPlacedOrder> {
    const licenceDate = licenceToday();
    const lines = command.lines.map(({ skuId, quantity }) => ({ skuId, quantity }));
    const normalizedDestination = normalizeAddressInput(command.destination);
    const consigneeGstin = normalizeGstinInput(command.consigneeGstin);
    const consigneeLegalName = normalizeConsigneeLegalName(command.consigneeLegalName);
    const clientOrderRef = normalizeClientOrderRef(command.clientOrderRef);
    const orderFields = normalizeOrderFields(command);
    // The portal fingerprint: `surface` FIRST (an identical payload must never
    // replay the operator surface's snapshot under a shared key), then the
    // session's client; the legal name only when present, at the 8-1d
    // position, and (4-1b) the client order number only when present, right
    // after it; lines in BASE units with no rate. Key order is fixed —
    // pinned by goldens in test/portal-orders-create.spec.ts.
    const payloadHash = hashCommandPayload({
      surface: 'portal',
      tenantId: command.tenantId,
      clientId: command.clientId,
      warehouseId: command.warehouseId,
      destination: addressFingerprint(normalizedDestination) ?? null,
      consigneeGstin,
      ...(consigneeLegalName === null ? {} : { consigneeLegalName }),
      ...(clientOrderRef === null ? {} : { clientOrderRef }),
      // Story 4-2a — the order fields, only when sent, at the staff positions.
      ...orderFieldsFingerprint(orderFields),
      lines,
    });

    // Story 4-1c (A9) — the portal gate is one exported function, shared with
    // the portal order import's own transactions.
    const gate = (tx: TenantTx): Promise<void> =>
      assertPortalOrderGateInTx(tx, { tenantId: command.tenantId, clientId: command.clientId, actorUserId: command.actorUserId });

    const lineSkuCount = new Set(lines.map((line) => line.skuId)).size;
    const portal: OrderSurface<PortalPlacedOrder> = {
      kind: 'portal',
      transaction: (fn) => withTenantTransaction(this.db, command.tenantId, fn, { clientId: command.clientId }),
      authorize: gate,
      reauthorize: gate,
      loadLineSkus: (tx, skuIds) => this.portalLineSkus(tx, command.tenantId, command.clientId, skuIds),
      prefetchLicences: () => this.portalLicenceSnapshot(command.tenantId),
      assertLicences: async (_tx, prefetched, order) => {
        // Fail closed: the seam must have run (a null snapshot is a wiring fault, never "off").
        if (prefetched === null) throw new Error('placePortalOrder: the licence check ran without its unstamped snapshot');
        // A line SKU the stamped read no longer sees (its client was
        // corrected away since phase 1 — RLS hides it) cannot be judged:
        // refuse rather than check fewer SKUs than the order holds.
        if (order.skus.length < lineSkuCount) throw portalOrderSkusChanged();
        if (!prefetched.enforced) return;
        const goods = order.skus.filter((sku) => needsOf(sku).length > 0);
        if (goods.length === 0) return;
        const uncovered = licenceCoverageOf(prefetched.facts, {
          warehouseId: command.warehouseId,
          date: licenceDate,
          parties: goods.map((sku) => ({
            clientId: order.clientId,
            systemOwned: order.systemOwned,
            skuCode: sku.code,
            needs: needsOf(sku),
          })),
        });
        if (uncovered.length > 0) throw portalLicenceNotCovered();
      },
      backorderRefusal: (shortLines, skuFacts) => portalStockShort(shortLines.map((line) => skuFacts.get(line.skuId)?.code ?? line.skuId)),
      // Story 4-1b (decision 9) — echoes only the user's own input.
      duplicateClientOrderRef: async (_tx, ref) =>
        duplicateClientOrderRef(
          `Order number ${ref} is already used by another of your orders (a cancelled order frees its number) — use a different number.`,
        ),
      respond: async (tx, snapshot) => ({
        orderId: snapshot.order.id,
        warehouseName: await getWarehouseNameInTx(tx, command.tenantId, snapshot.order.warehouseId),
        lineCount: snapshot.order.lines.filter((line) => line.parentLineId === null).length,
        placedAt: snapshot.order.createdAt,
        clientOrderRef: snapshot.order.clientOrderRef ?? null,
        // Story 4-2a — the four fields as stored (the exact key allowlist grows by four).
        orderType: snapshot.order.orderType ?? null,
        priority: snapshot.order.priority ?? null,
        shipByDate: snapshot.order.shipByDate ?? null,
        codAmountPaise: snapshot.order.codAmountPaise ?? null,
      }),
    };

    return {
      command: {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        warehouseId: command.warehouseId,
        source: 'manual',
        lines,
        destination: command.destination,
        ...(command.consigneeGstin === undefined ? {} : { consigneeGstin: command.consigneeGstin }),
        ...(command.consigneeLegalName === undefined ? {} : { consigneeLegalName: command.consigneeLegalName }),
        ...(command.clientOrderRef === undefined ? {} : { clientOrderRef: command.clientOrderRef }),
        backorderPolicy: 'reject',
      },
      hashes: {
        integrationId: null,
        externalEventId: null,
        consigneeGstin,
        consigneeLegalName,
        clientOrderRef,
        orderFields,
        licenceDate,
        sourcePayloadHash: null,
        payloadHash,
      },
      surface: portal,
    };
  }

  /**
   * Story 4-1c — a Check file over a plan: phase 1 with no key (no replay,
   * nothing written). The client the order derives and its top-level line
   * count, or the refusal phase 1 throws.
   */
  private async checkPlan<R>(plan: OrderPlan<R>): Promise<OrderCheck> {
    const preflight = await this.preflightPhase(plan.command, null, plan.hashes, plan.surface);
    if (preflight.replayed) {
      throw new Error('checkOrder: a keyless preflight cannot replay');
    }
    return { clientId: preflight.clientId, lineCount: plan.command.lines.length };
  }

  /**
   * Story 4-1a — the portal's SKU read: the session client's ACTIVE NON-KIT
   * SKUs among `skuIds` (the `portal/skus` population), each with the facts
   * the pipeline needs. Anything else — unknown, another client's, a kit, an
   * inactive SKU — is the SAME 404, so another client's SKU is never
   * confirmed to exist. Two layers: the explicit `client_id` predicate here,
   * and the caller's client-stamped transaction (the `skus` policy).
   */
  private async portalLineSkus(
    tx: TenantTx,
    tenantId: string,
    clientId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, SkuFacts>> {
    const distinct = [...new Set(skuIds)];
    const rows = await tx
      .select({
        id: skus.id,
        uom: skus.uom,
        clientId: skus.clientId,
        code: skus.code,
        status: skus.status,
        foodCategory: skus.foodCategory,
        drugSchedules: skus.drugSchedules,
      })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), eq(skus.clientId, clientId), eq(skus.status, 'active'), inArray(skus.id, distinct)));
    const kits = new Set(await this.catalog.getKitSkuIdsInTx(tx, tenantId, rows.map((row) => row.id)));
    const byId = new Map(
      rows
        .filter((row) => !kits.has(row.id))
        .map((row) => [
          row.id,
          {
            uom: row.uom,
            clientId: row.clientId,
            code: row.code,
            status: row.status as SkuStatus,
            foodCategory: row.foodCategory,
            drugSchedules: row.drugSchedules,
          },
        ]),
    );
    for (const skuId of distinct) {
      if (!byId.has(skuId)) {
        throw new ProblemException('not-found', 404, 'SKU not found', `No SKU with id "${skuId}" exists for this client.`);
      }
    }
    return byId;
  }

  /**
   * Story 4-1a — THE UNSTAMPED SEAM (a documented carve-out from the portal
   * write's client stamp). A client-stamped transaction cannot see a site
   * licence (0084: the policy admits only rows whose `client_id` is the
   * stamp; a site licence's is null), so a portal order judged inside one
   * would be refused for every site-covered drug or food SKU. This reads the
   * tenant's enforcement switch and its active licences in an operator-shape
   * transaction of its own — after phase 1's transaction closed and before
   * phase 3's opens, never nested inside either (a second pool connection taken while one is held
   * is the pool-deadlock gotcha). Licences and the switch only; the facts
   * never leave the command, and a gap is answered with the generic
   * `portalLicenceNotCovered`.
   */
  private async portalLicenceSnapshot(tenantId: string): Promise<LicenceSnapshot> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const enforced = await licenceEnforcedInTx(tx, tenantId);
      return { enforced, facts: enforced ? await activeLicenceFactsInTx(tx, tenantId) : [] };
    });
  }

  /**
   * Story 4-1a — the order pipeline both surfaces run: phase 1 (the read
   * transaction), phase 2 (the grants, outside any transaction), phase 2.5
   * (the sell-down and backorder-policy refusals) and phase 3 (the write
   * transaction). The surface supplies what differs; the order of every step
   * is the pre-4-1a `createOrder`'s.
   */
  private async placeOrder<R>(
    command: CreateOrderCommand,
    idempotencyKey: string,
    hashes: OrderHashStage,
    surface: OrderSurface<R>,
  ): Promise<R> {
    // Story 4-1a — the portal never carries channel refs, so it can never
    // reach the dedup-loser resolution or the channel refusal fact.
    if (surface.kind === 'portal' && (hashes.integrationId !== null || hashes.externalEventId !== null || command.source !== 'manual')) {
      throw new Error('placePortalOrder: a portal order carries no channel refs');
    }
    const preflight = await this.preflightPhase(command, idempotencyKey, hashes, surface);
    if (preflight.replayed) {
      return preflight.snapshot;
    }
    const grants = await this.grantPhase(command, preflight);
    const { lines, explosions } = preflight;
    const { plainHolds, childHolds, granted } = grants;

    // ── phase 2.5 (story 7.2, RD-3): the connection's reject policy ────────
    // A whole-order post-grant refusal. AFTER the grants (never a pre-probe —
    // no TOCTOU window can refuse what would actually have granted) and
    // BEFORE the write tx opens. The check reads PHASE-2's grant map, never
    // order rows: any line where granted < demanded — a ZERO-grant (fully
    // backordered) line included — refuses the WHOLE order; kit PARENTS are
    // excluded from the map (they reserve 0 by construction; a row-based
    // check would refuse every kit order regardless of grant success) and
    // the kit CHILDREN are the entries. The release is the exact machinery
    // the 503 path already runs — fail-safe toward understated ATP, never
    // oversold.
    // ── phase 2.5 (story 1-4b, decision 1): an inactive SKU sells down ─────
    // An order line of an inactive SKU (a kit line: its kit SKU or any
    // component) is accepted only when it reserved IN FULL — a shortfall
    // would wait for inbound an inactive SKU never takes, so it refuses the
    // whole order (409 `sku-inactive`, whatever the backorder policy; the
    // ingest maps it to a typed 422), after every grant is released. Before
    // the policy arm, so a channel refusal for an inactive SKU writes no
    // backorder-refusal fact (decision 12).
    const inactiveRefusal = inactiveShortRefusal(lines, explosions, plainHolds, childHolds, (skuId) => {
      const facts = preflight.skuFacts.get(skuId);
      return facts === undefined ? undefined : { code: facts.code, status: facts.status };
    });
    if (inactiveRefusal !== null) {
      await this.releaseAll(command.tenantId, granted, 'sku-inactive');
      throw inactiveRefusal;
    }

    const shortLines =
      command.backorderPolicy === 'reject' ? this.policyShortLines(lines, explosions, plainHolds, childHolds) : [];
    if (shortLines.length > 0) {
      await this.releaseAll(command.tenantId, granted, 'backorder-policy-reject');
      // Story 9-1 — the SM-4 "prevented" fact, written AFTER the grants were
      // released and outside any transaction, best-effort: the caller gets
      // exactly today's refusal whatever happens here. (A channel delivery
      // only — the portal's refusal carries no channel identity.)
      if (surface.kind === 'staff') {
        await this.recordBackorderRefusal(command, hashes.integrationId, hashes.externalEventId, shortLines);
      }
      throw surface.backorderRefusal(shortLines, preflight.skuFacts);
    }

    return this.writePhase(command, idempotencyKey, hashes, surface, preflight, grants);
  }

  /**
   * Phase 1 (the read transaction): authority → replay → validation → master
   * data → conversion → kit explosion → channel dedup → client → licences.
   * Returns the stored snapshot on a replay (or a channel redelivery), else
   * everything phases 2 and 3 need.
   */
  private async preflightPhase<R>(
    command: CreateOrderCommand,
    idempotencyKey: string | null,
    hashes: OrderHashStage,
    surface: OrderSurface<R>,
  ): Promise<Preflight<R>> {
    const { integrationId, externalEventId, consigneeGstin, consigneeLegalName, clientOrderRef, sourcePayloadHash, payloadHash } = hashes;
    // Story 4-1c — a keyless preflight (the import's Check file) replays
    // nothing and must write nothing: only a manual order, whose phase 1
    // never reaches the channel-dedup branch (the one phase-1 write).
    if (idempotencyKey === null && command.source !== 'manual') {
      throw new Error('preflightPhase: a keyless check is for a manual order only');
    }
    // ── phase 1 (read tx): authority → replay → validation → dedup ────────
    const preflight = await surface.transaction(async (tx): Promise<Preflight<R>> => {
      await surface.authorize(tx);

      if (idempotencyKey !== null) {
        const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replay !== null) {
          return { replayed: true, snapshot: replay as R };
        }
      }

      // ── input validation (400 before any write) ─────────────────────────
      this.assertLines(command.lines);
      // Story 8-1: the consignee GSTIN's FULL shape validation, behind the
      // replay lookup (the lenient normalize already ran above for the hash).
      if (consigneeGstin !== null && !GSTIN_RE.test(consigneeGstin)) {
        throw validationFailed(
          `consigneeGstin must be a 15-character GSTIN (two digits, thirteen alphanumeric characters; got "${consigneeGstin}").`,
        );
      }
      // Story 8-1d: the prefix must be a GST registration state code — the
      // same predicate registration and warehouse create apply (the tenancy
      // `normalizeGstin`), behind the replay lookup like the shape check.
      const prefixProblem = consigneeGstin === null ? null : gstinPrefixProblem(consigneeGstin);
      if (prefixProblem !== null) {
        throw validationFailed(
          `consigneeGstin ${prefixProblem} (got "${consigneeGstin}") — a GSTIN begins with the two-digit code of the state it is registered in.`,
        );
      }
      // Story 8-1d: the buyer legal name — only alongside a GSTIN (a B2C
      // buyer has no registered name to print), at most 100 code points
      // (NIC's toTrdName width). Behind the replay lookup, never in the DTO.
      if (consigneeLegalName !== null) {
        if (consigneeGstin === null) {
          throw validationFailed(
            'consigneeLegalName is the GST-registered buyer\'s legal or trade name — it needs a consigneeGstin; send neither for an unregistered buyer.',
          );
        }
        const codePoints = [...consigneeLegalName].length;
        if (codePoints > MAX_CONSIGNEE_LEGAL_NAME_LENGTH) {
          throw validationFailed(
            `consigneeLegalName is at most ${MAX_CONSIGNEE_LEGAL_NAME_LENGTH} characters (got ${codePoints}).`,
          );
        }
        // A control character (NUL included) can never be printed — and NUL
        // would fail the insert with a 500, never an answer.
        // eslint-disable-next-line no-control-regex -- matching control characters is the point
        if (/[\u0000-\u001F\u007F]/.test(consigneeLegalName)) {
          throw validationFailed('consigneeLegalName must not contain control characters (tabs, line breaks, NUL).');
        }
        // The name becomes the e-way bill's toTrdName, which keeps only NIC's
        // character set: a name with none of it prints blank, and the frozen
        // invoice's bill would be blocked (address-incomplete) for good.
        if (nicText(consigneeLegalName, MAX_CONSIGNEE_LEGAL_NAME_LENGTH) === '') {
          throw validationFailed(
            'consigneeLegalName must contain Latin letters or digits — the e-way portal accepts only A–Z, a–z, 0–9, spaces and @ # - / , & . so this name would print blank on the e-way bill.',
          );
        }
      }
      // Story 4-1b: the client order number's shape — behind the replay
      // lookup, never in the DTO (the 8-1d rule): 1–64 printable ASCII
      // characters (the trim already ran, so no space first or last).
      if (clientOrderRef !== null) {
        assertClientOrderRefShape(clientOrderRef);
      }
      // Story 4-2a — the order fields' value checks, behind the replay lookup
      // (A11): the vocabularies, the type ↔ GSTIN contradiction, the ship-by
      // shape and its bounds against the ONE IST date the create captured
      // (A13 — a replay tomorrow of today's order replays above, never
      // refused), the COD amount's type and range. Then the derived defaults.
      const fields = assertOrderFields(hashes.orderFields, {
        surface: surface.kind,
        consigneeGstin,
        todayIst: hashes.licenceDate,
      });
      // Story 11-1: the destination is validated HERE, behind the replay
      // lookup — the command is the boundary (the Epic 7 adapter path bypasses
      // the DTO's @ValidateNested), and a refusal must never answer 400 to an
      // op that already committed. Required at create (the human decision
      // 2026-09-19), atomic (never partial), pincode six digits as text.
      const destination = assertAddress(command.destination, 'destination');
      if (command.source === 'ingested') {
        if (integrationId === null || externalEventId === null || externalEventId === '') {
          throw validationFailed(
            'An ingested order names its channel — integrationId and externalEventId are required together.',
          );
        }
        // Non-HTTP callers (the Epic 7 adapter path) skip the DTO's @IsUUID —
        // the command is the boundary that keeps a bad ref out of the uuid
        // column (a raw 22P02 is never an answer).
        if (!UUID_RE.test(integrationId)) {
          throw validationFailed('integrationId must be a uuid.');
        }
        if (externalEventId.length > MAX_EXTERNAL_ID_LENGTH) {
          throw validationFailed(
            `externalEventId is at most ${MAX_EXTERNAL_ID_LENGTH} characters.`,
          );
        }
      }

      // ── master-data integrity in a write transaction (404 before writes) ─
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      const lineSkus = await surface.loadLineSkus(
        tx,
        command.lines.map((line) => line.skuId),
      );
      const uomBySku = uomsOf(lineSkus);

      // ── story 10.2: conversion and the precision refusal, HERE ───────────
      // Behind the replay lookup above and with each line's unit in hand.
      // Below this point every quantity is milli-units; above it, base units.
      const lines: OrderLineInput[] = command.lines.map((line) => {
        const uom = uomBySku.get(line.skuId)!;
        return {
          skuId: line.skuId,
          quantity: assertRecordableQuantity(line.quantity, 'quantity', uom, uomPrecision(uom)),
        };
      });
      // Story 8-1: the returned lines carry each line's validated rate (or
      // null) — the ONLY rate shape the grant and write phases below see.
      const linesWithRates = lines.map((line, index) => {
        const rate = command.lines[index]?.ratePaise;
        return rate === undefined ? line : { ...line, ratePaise: this.assertRatePaise(rate) };
      });

      // ── story 11.4: the kit explosion plan ───────────────────────────────
      // Which input lines are kits, and their flat BOMs — read in THIS
      // transaction (the acceptance explosion is point-in-time: the child
      // lines copied below are what the order keeps, immune to later
      // composition edits). Kit-ness is one facade lookup (composition-row
      // presence); the BOM itself is one more. The child quantities are
      // validated HERE, before any grant moves: an explosion that would
      // overflow the quantity ceiling or fall below the component's milli
      // resolution is a 400, never a half-granted surprise.
      const kitSkuIds = await this.catalog.getKitSkuIdsInTx(
        tx,
        command.tenantId,
        lines.map((line) => line.skuId),
      );
      const bomBySku = new Map<string, readonly KitCompositionLine[]>();
      for (const skuId of kitSkuIds) {
        bomBySku.set(skuId, await this.catalog.getKitCompositionInTx(tx, command.tenantId, skuId));
      }
      // The component SKUs' units: the child quantity must be expressible in
      // the COMPONENT's declared precision, not merely in milli-units — a
      // 0-decimal component (each) can never take a 0.5 child line, and a
      // grant that moved anyway would strand an unpickable line.
      const componentSkuIds = [...bomBySku.values()].flatMap((bom) =>
        bom.map((line) => line.componentSkuId),
      );
      const componentSkus =
        componentSkuIds.length === 0
          ? new Map<string, SkuFacts>()
          : await this.assertSkuIdsInTenant(tx, command.tenantId, componentSkuIds);
      const componentUomBySku = uomsOf(componentSkus);
      const explosions = new Map<number, readonly KitCompositionLine[]>();
      for (let index = 0; index < lines.length; index += 1) {
        const bom = bomBySku.get(lines[index]!.skuId);
        if (bom !== undefined) {
          explosions.set(
            index,
            explodeKitLine(
              lines[index]!,
              index,
              bom,
              componentUomBySku,
            ),
          );
        }
      }

      // ── channel dedup pre-check: the same payload twice → the same order ─
      // (the partial unique index is the concurrent-delivery backstop; this
      // read settles the sequential redelivery before any reservation moves).
      if (integrationId !== null && externalEventId !== null) {
        const existing = await tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, command.tenantId),
              eq(orders.integrationId, integrationId),
              eq(orders.externalEventId, externalEventId),
              // Story 4-2c — ROOT orders only (the narrowed index's
              // population): a follow-on shares its root's channel event, and
              // a redelivery resolves to the root.
              isNull(orders.followOnOfOrderId),
            ),
          )
          .limit(1);
        const prior = existing[0];
        if (prior !== undefined) {
          if (prior.sourcePayloadHash !== sourcePayloadHash) {
            throw orderSourceConflict(prior.id);
          }
          // Same payload redelivered: the first order's snapshot, no new
          // reservation. The key is written with that snapshot so a transport
          // retry of THIS delivery replays through the key as well.
          const snapshot = await surface.respond(tx, await this.snapshotOf(tx, prior));
          await this.writeIdempotencyKey(
            tx,
            command.tenantId,
            idempotencyKey!,
            payloadHash,
            snapshot,
          );
          return { replayed: true, snapshot };
        }
      }

      // ── story 21-2b: the order's client, DERIVED from its SKUs ──────────
      // After the kit-component assertion (the components' clients are in
      // hand) and after the dedup pre-check (a redelivery re-serves its
      // first order's snapshot whatever its SKUs say today). Every line SKU
      // and every kit component must belong to ONE client, or the order is
      // refused 409 `mixed-client` naming the codes — before any grant moves.
      const clientId = await assertSingleClientInTx(
        tx,
        command.tenantId,
        [...lineSkus.values(), ...componentSkus.values()].map((sku) => sku.clientId),
        'The order',
      );
      // Story 1-2a — an early exit for a departed client (409
      // `client-departed`) before any grant moves. NOT the guard: this phase
      // commits before phase 3 writes, so the check runs again there.
      const orderClient = await assertClientTakesWorkInTx(tx, command.tenantId, clientId);
      // Story 4-1b (decision 3) — the client order number is free among the
      // client's LIVE orders: after `client-departed`, before the licence
      // checks, and before any grant moves (a duplicate reserves nothing). Not
      // the guard: two different keys racing on one ref both pass here, and
      // the partial unique index refuses the loser's insert in phase 3 with
      // the same 409 (its grants released by the write phase's catch).
      if (clientOrderRef !== null) {
        const clash = await liveOrderWithRefInTx(tx, command.tenantId, clientId, clientOrderRef);
        if (clash !== null) {
          throw await surface.duplicateClientOrderRef(tx, clientOrderRef, clash);
        }
      }
      // Story 1-6d (decisions 4, 10) — the EARLY licence check, before any
      // grant moves: with enforcement on, every SKU of the order — each line
      // SKU, a kit parent and its components, backordered or not — must be
      // covered at this site on the captured IST date, or the WHOLE order is
      // refused 409 `licence-not-covered`. NOT the guard: phase 3 re-checks.
      // (The staff surface only — the portal judges after this transaction.)
      if (surface.kind === 'staff') {
        await surface.assertLicences(tx, null, {
          clientId,
          systemOwned: orderClient.systemOwned,
          skus: [...lineSkus.values(), ...componentSkus.values()],
        });
      }
      return {
        replayed: false,
        destination,
        fields,
        lines: linesWithRates,
        explosions,
        clientId,
        systemOwned: orderClient.systemOwned,
        // Story 1-4b — every line and component SKU's code and status.
        skuFacts: new Map<string, SkuFacts>([...lineSkus, ...componentSkus]),
      };
    });
    // Story 4-1a — the portal's EARLY licence check: its facts are read
    // through the unstamped seam only now — after the authority gate and the
    // replay miss (never for an unauthorised caller or a replay), in a
    // transaction of their own opened after phase 1's closed (never nested) —
    // and still before any grant moves.
    if (surface.kind === 'portal' && !preflight.replayed) {
      await surface.assertLicences(null, await surface.prefetchLicences(), {
        clientId: preflight.clientId,
        systemOwned: preflight.systemOwned,
        skus: [...preflight.skuFacts.values()],
      });
    }
    return preflight;
  }

  /**
   * Phase 2: the per-line ATP split + grants (each its own atomic unit,
   * through the inventory facade's own — operator-stamped — transactions).
   * Every grant lands before the order-create tx opens; any failure here
   * writes nothing (the 503 propagates; a deterministic loss under the
   * backorder policy marks the line backordered instead).
   */
  private async grantPhase(command: CreateOrderCommand, preflight: PreflightAccepted): Promise<OrderGrants> {
    // The milli-unit lines the preflight converted — the ONLY quantities the
    // grant and write phases below ever see.
    const { lines, explosions } = preflight;
    // Story 11.4: a kit line reserves through its CHILD lines — each
    // component grants against its own child line id (ownerType 'order',
    // ownerId = the child line's id), so waves/picklists/dispatch see
    // ordinary holds. All-or-nothing per kit (the human decision): if any
    // component cannot fully reserve, the siblings this attempt granted are
    // released and the whole kit line backorders — a kit never ships half
    // its contents, and it never half-holds.
    const lineIds = lines.map(() => uuidv7());
    const childIds = new Map<number, string[]>();
    for (const [index, bom] of explosions) {
      childIds.set(index, bom.map(() => uuidv7()));
    }
    const plainHolds = new Map<number, ReservationSnapshot>();
    const childHolds = new Map<string, ReservationSnapshot>();
    const granted: ReservationSnapshot[] = [];
    try {
      for (let index = 0; index < lines.length; index += 1) {
        const bom = explosions.get(index);
        if (bom === undefined) {
          const reservation = await this.reserveLine(command, lines[index]!, lineIds[index]!);
          if (reservation !== null) {
            plainHolds.set(index, reservation);
            granted.push(reservation);
          }
          continue;
        }
        // The kit's components, in composition order. All-or-nothing per kit
        // (the human decision): `reserveLine` grants min(qty, ATP) — the
        // plain line's partial grant — but a kit may not hold PART of a
        // component's requirement, so a hold below the component's full
        // exploded quantity is a shortfall too: the granted siblings release
        // and the whole kit backorders. A kit never ships half its contents
        // and never half-holds.
        // Story 4-2c — the kit block is `grantKitBlock` (`reserve-line.ts`),
        // shared with the backorder allocation; the rule is unchanged.
        const holds = await grantKitBlock(
          this.inventory,
          { tenantId: command.tenantId, warehouseId: command.warehouseId },
          bom.map((component, childIndex) => ({
            skuId: component.componentSkuId,
            quantity: component.qty,
            ownerId: childIds.get(index)![childIndex]!,
          })),
          (partial) => this.releaseAll(command.tenantId, partial, 'kit-backorder'),
        );
        if (holds === null) {
          continue;
        }
        holds.forEach((hold, childIndex) => childHolds.set(`${index}:${childIndex}`, hold));
        granted.push(...holds);
      }
    } catch (err) {
      // Fail closed (the I/O matrix): a reservation-store failure (503) or
      // any other grant error aborts the whole creation — nothing accepted
      // half-reserved.
      await this.releaseAll(command.tenantId, granted, 'create-order-abort');
      throw err;
    }
    return { lineIds, childIds, plainHolds, childHolds, granted };
  }

  /**
   * Phase 3 (the write transaction): the surface's re-authorization → the
   * client guard → the SKU re-read under lock → the licence re-check → the
   * order + lines + outbox + audit + key. Any failure releases every grant.
   */
  private async writePhase<R>(
    command: CreateOrderCommand,
    idempotencyKey: string,
    hashes: OrderHashStage,
    surface: OrderSurface<R>,
    preflight: PreflightAccepted,
    grants: OrderGrants,
  ): Promise<R> {
    const { integrationId, externalEventId, consigneeGstin, consigneeLegalName, clientOrderRef, sourcePayloadHash, payloadHash } = hashes;
    const { lines, explosions } = preflight;
    // The destination is the preflight's validated, normalized address (story
    // 11-1). (`consigneeGstin` is the preflight's normalized, shape-validated
    // value from the hash stage.)
    const destination = preflight.destination;
    const { lineIds, childIds, plainHolds, childHolds, granted } = grants;
    // ── phase 3 (write tx): the order + lines + outbox + audit + key ──────
    try {
      // The portal's licence facts, re-read unstamped BEFORE the write
      // transaction opens (null on the staff surface, which re-reads in-tx).
      const licences = await surface.prefetchLicences();
      return await surface.transaction(async (tx) => {
        // Story 4-1a — the portal re-reads its actor and takes its client
        // FOR SHARE again here (a suspension since phase 1 refuses, and the
        // catch below releases every grant); the staff surface does nothing.
        await surface.reauthorize(tx);
        const orderId = uuidv7();
        // Story 21-2b (AD-23): an order is for one client by definition —
        // the client the preflight DERIVED from its lines' and components'
        // SKUs (the tenant's `self` client on a D2C tenant; no branch).
        const clientId = preflight.clientId;
        // Story 1-2a — THE guard: the first statement of the write
        // transaction takes the client FOR KEY SHARE, so a departure (FOR
        // UPDATE) either committed first — refused here, 409
        // `client-departed`, and the grants released by the rollback path
        // below — or waits for this order, whose open status then blocks it.
        const orderClient = await assertClientTakesWorkInTx(tx, command.tenantId, clientId);
        // Story 1-4b — the SKU rows `FOR KEY SHARE` in id order (after the
        // client: the lock order client → SKU), re-reading status and
        // kit-ness. A deactivation committed since phase 1 refuses a short
        // line exactly as phase 2.5 does; a plain line (or component) whose
        // SKU became a kit since phase 1 is 409 `order-catalog-changed` (the
        // PENDING kit race — its grant holds a kit's stock). Both throw into
        // the catch below, which releases every grant.
        const locked = await lockSkuStatusesInTx(tx, command.tenantId, [...preflight.skuFacts.keys()]);
        const lockedRefusal = inactiveShortRefusal(lines, explosions, plainHolds, childHolds, (skuId) => locked.get(skuId));
        if (lockedRefusal !== null) {
          throw lockedRefusal;
        }
        const becameKits = lines
          .flatMap((line, index) => {
            const bom = explosions.get(index);
            return bom === undefined ? [line.skuId] : bom.map((component) => component.componentSkuId);
          })
          .filter((skuId) => locked.get(skuId)?.isKit === true);
        if (becameKits.length > 0) {
          throw orderCatalogChanged([...new Set(becameKits.map((skuId) => locked.get(skuId)!.code))]);
        }
        // Story 4-1a — the portal admits ACTIVE SKUs only (phase 1's 404), so
        // a SKU deactivated since then refuses the order even when it reserved
        // in full: the portal never sells down (decision 8). Into the catch,
        // which releases every grant.
        if (surface.kind === 'portal') {
          const deactivated = [...locked.values()].filter((sku) => sku.status !== 'active').map((sku) => sku.code);
          if (deactivated.length > 0) {
            throw skuInactive(deactivated, 'A SKU on this order was deactivated while it was placed — nothing was written. Remove it and place the order again.');
          }
        }
        // Story 1-6d — the licence RE-CHECK under the locks, on the same IST
        // date: the switch re-read, and each SKU's goods attributes as the
        // locked read sees them (an edit since phase 1 is caught). A refusal
        // throws into the catch below, which releases every grant.
        await surface.assertLicences(tx, licences, {
          clientId,
          systemOwned: orderClient.systemOwned,
          skus: [...locked.values()],
        });
        try {
          await tx.insert(orders).values({
            id: orderId,
            tenantId: command.tenantId,
            clientId,
            warehouseId: command.warehouseId,
            status: 'accepted',
            source: command.source,
            integrationId,
            externalEventId,
            sourcePayloadHash,
            // Story 11-1: the validated, normalized destination — flat
            // columns, copied at create (point-in-time), line2 null when
            // absent. Pincode stays text.
            destinationContactName: destination.contactName,
            destinationPhone: destination.phone,
            destinationLine1: destination.line1,
            destinationLine2: destination.line2 ?? null,
            destinationCity: destination.city,
            destinationState: destination.state,
            destinationPincode: destination.pincode,
            // Story 8-1: the buyer's registration identity (optional, absent
            // = null) — invoicing resolves place of supply from it.
            consigneeGstin,
            // Story 8-1d: the buyer's legal / trade name (normalized, only
            // alongside a GSTIN — the preflight refused anything else).
            consigneeLegalName,
            // Story 4-1b: the client's own order number (normalized and
            // shape-checked in phase 1; null when none was given).
            clientOrderRef,
            // Story 4-2a: the order header fields as phase 1 validated and
            // derived them (the type derived from the GSTIN when not sent,
            // priority `normal` when not sent).
            orderType: preflight.fields.orderType,
            priority: preflight.fields.priority,
            shipByDate: preflight.fields.shipByDate,
            codAmountPaise: preflight.fields.codAmountPaise,
          });
        } catch (err) {
          // Story 4-1b — a concurrent order of the same client took the number
          // between phase 1's check and this insert: the same 409 as the
          // check, and the catch below releases this command's grants.
          if (clientOrderRef !== null && isUniqueViolationOn(err, ORDERS_CLIENT_ORDER_REF_LIVE_UNIQUE)) {
            // The transaction is aborted: the clash is named after the rollback.
            throw new ClientOrderRefLostError(clientOrderRef);
          }
          if (isUniqueViolationOn(err, ORDERS_SOURCE_EVENT_UNIQUE)) {
            // A concurrent first delivery of the same channel payload won the
            // index — this command's grants are released (they belong to no
            // order) and the winner's snapshot is what both callers see.
            throw new DedupLostError(
              command.tenantId,
              integrationId!,
              externalEventId!,
              sourcePayloadHash,
            );
          }
          throw err;
        }
        // Story 11.4: one insert for parents, plain lines and children alike
        // — a child is an ordinary line whose `parentLineId` names the kit
        // line it exploded from (point-in-time, copied at acceptance). The
        // parent itself carries no hold — the components carry the stock —
        // and its status mirrors the kit's all-or-nothing outcome.
        await tx.insert(orderLines).values(
          lines.flatMap((line, index): (typeof orderLines.$inferInsert)[] => {
            const bom = explosions.get(index);
            if (bom === undefined) {
              const hold = plainHolds.get(index);
              const reservedQty = hold?.quantity ?? 0;
              return [
                {
                  id: lineIds[index]!,
                  tenantId: command.tenantId,
                  orderId,
                  skuId: line.skuId,
                  qty: line.quantity,
                  reservedQty,
                  reservationId: hold?.id ?? null,
                  status: reservedQty < line.quantity ? 'backordered' : 'open',
                  parentLineId: null,
                  // Story 8-1: the rate frozen at acceptance (null unpri-
                  // ced). NEVER touched again — invoicing's override freezes
                  // into the invoice document instead.
                  ratePaise: line.ratePaise ?? null,
                },
              ];
            }
            const parentRow = {
              id: lineIds[index]!,
              tenantId: command.tenantId,
              orderId,
              skuId: line.skuId,
              qty: line.quantity,
              reservedQty: 0,
              reservationId: null,
              status: childHolds.has(`${index}:0`) ? 'open' : 'backordered',
              parentLineId: null,
              // Inert at invoicing (the parent drops at zero picks), stamped
              // anyway as what acceptance froze — the components ride their
              // own rates (per-line overrides at invoicing).
              ratePaise: line.ratePaise ?? null,
            };
            const childRows = bom.map((component, childIndex) => {
              const hold = childHolds.get(`${index}:${childIndex}`);
              const reservedQty = hold?.quantity ?? 0;
              return {
                id: childIds.get(index)![childIndex]!,
                tenantId: command.tenantId,
                orderId,
                skuId: component.componentSkuId,
                qty: component.qty,
                reservedQty,
                reservationId: hold?.id ?? null,
                status: reservedQty < component.qty ? 'backordered' : 'open',
                parentLineId: lineIds[index]!,
                // Story 8-1: a component's rate is its OWN (null here — the
                // kit's price is the parent's, never decomposed at explode);
                // per-component overrides ride the invoicing command's rates.
                ratePaise: null,
              };
            });
            return [parentRow, ...childRows];
          }),
        );

        const snapshot = await this.snapshotById(tx, orderId);

        // In-transaction outbox append (AD-7) — before the idempotency key.
        // The OPERATOR payload on both surfaces: every consumer of
        // `order.created` reads one shape.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'order.created',
          occurredAt: nowIso(),
          payload: { order: snapshot.order },
        });

        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'order.created',
          targetType: 'order',
          targetId: orderId,
          // RD-2 (review patch P10): an INGESTED order's audit row names its
          // channel source — the connection + the channel ref, never a
          // secret — so "where did this order come from" answers from the
          // audit trail alone. A manual order keeps the idempotency key.
          // Story 9-3a: the ingested reference also names the per-delivery
          // idempotency key (an additive sibling of `channel`), so the audit
          // rule's guard can tie every committed key to its row.
          reference:
            command.source === 'ingested' && command.integrationId !== undefined
              ? JSON.stringify({
                  channel: {
                    connectionId: command.integrationId,
                    externalEventId: command.externalEventId ?? null,
                  },
                  key: idempotencyKey,
                })
              : idempotencyKey,
          occurredAt: nowIso(),
        });

        // The surface's response — the operator snapshot on the staff
        // surface, the portal's own shape on the portal — is what the key
        // stores, so a replay re-serves exactly what this call answers.
        const response = await surface.respond(tx, snapshot);
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, response);
        return response;
      });
    } catch (err) {
      // The create tx failed (a lost dedup race or any other write fault):
      // the grants belong to no order — release them, then resolve the
      // dedup-loser outcome against the settled state.
      await this.releaseAll(command.tenantId, granted, 'create-order-rollback');
      if (err instanceof ClientOrderRefLostError) {
        // Story 4-1b — the concurrent winner holds the number: the same 409 as
        // phase 1's check, naming the winner (read in a fresh transaction).
        throw await surface.transaction(async (tx) =>
          surface.duplicateClientOrderRef(tx, err.ref, await liveOrderWithRefInTx(tx, command.tenantId, preflight.clientId, err.ref)),
        );
      }
      if (err instanceof DedupLostError) {
        return this.resolveDedupLoser(err, idempotencyKey, payloadHash, surface);
      }
      throw err;
    }
  }

  /**
   * `POST .../orders/{id}/cancel`: allowed while `accepted` (pre-pick),
   * idempotent-keyed.
   *
   * The order flips `accepted → cancelled` through one conditional UPDATE,
   * and the line reset + `order.cancelled` + the audit row + the idempotency
   * key commit WITH that flip — the flip's winner alone emits them. Only
   * then are the holds released, each through the existing path (its own
   * serialized terminal transition).
   *
   * Flip-first is deliberate. Releasing first and flipping after leaves a
   * crash window where stock is free while the order still reads `accepted`
   * — units sellable twice. This ordering inverts that: a crash leaves the
   * order `cancelled` with its holds still live, ATP understated until the
   * reaper expires them. A consumed (`committed`) hold is refused up front,
   * before anything is written; one that commits inside the pre-check →
   * release window can no longer be refused (the cancellation is durable by
   * then) and is logged as an operational anomaly instead.
   *
   * A replay under the original key re-serves the stored snapshot; a cancel
   * of an already-cancelled order under a NEW key is an idempotent no-op
   * (200 snapshot, the key is recorded against it).
   */
  async cancelOrder(command: CancelOrderCommand, idempotencyKey: string): Promise<OrderSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      orderId: command.orderId,
    });

    // ── phase 1 (read tx): authority → replay → load + lock the order ─────
    const preflight = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx): Promise<{ replayed: OrderSnapshot | null; order: Order | null }> => {
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'orders.manage',
        );

        const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replay !== null) {
          return { replayed: replay as OrderSnapshot, order: null };
        }

        const rows = await tx
          .select()
          .from(orders)
          .where(and(eq(orders.id, command.orderId), eq(orders.tenantId, command.tenantId)))
          .limit(1)
          .for('update');
        const order = rows[0];
        if (order === undefined) {
          throw orderNotFound(command.orderId);
        }
        return { replayed: null, order };
      },
    );
    if (preflight.replayed !== null) {
      return preflight.replayed;
    }
    const order = preflight.order!;

    // An already-cancelled order under a new key: the idempotent no-op
    // (200 snapshot). The flip below would find nothing to do anyway, but
    // the releases must not run again — return before them, recording the
    // key so the replay contract holds for this caller too.
    if (order.status === 'cancelled') {
      return withTenantTransaction(this.db, command.tenantId, async (tx) => {
        const snapshot = await this.snapshotById(tx, order.id);
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      });
    }

    // Story 4.5: `accepted` is no longer the only non-cancelled arm. A
    // `ready_to_dispatch` order has been packed — its units left their bins
    // through `pick.picked` draws and its pack is journalled — so there is
    // nothing here to cancel. Without this gate the conditional flip below
    // (`where status = 'accepted'`) would simply match no row and the caller
    // would get a 200 carrying an UNCANCELLED order: a silent no-op dressed
    // as success. Refuse it explicitly, before anything is read or written,
    // and name the arm. Every future non-`accepted` arm (4.6's dispatched)
    // lands here by default rather than in the silent no-op.
    if (order.status !== 'accepted') {
      throw new ProblemException(
        'conflict',
        409,
        'Order is not cancellable',
        `Order "${order.id}" reads "${order.status}" — only an accepted order is cancelled here; its units have already left their bins.`,
      );
    }

    // ── phase 2 (read): the pre-check — every line's hold, and the refusal ─
    // A consumed (committed) hold means a consuming flow won the reservation
    // first, so the order is no longer purely pre-pick stock: refuse BEFORE
    // anything is written.
    const lines = await withTenantTransaction(this.db, command.tenantId, (tx) =>
      tx
        .select({ id: orderLines.id, reservationId: orderLines.reservationId })
        .from(orderLines)
        .where(and(eq(orderLines.tenantId, command.tenantId), eq(orderLines.orderId, order.id))),
    );
    const reservationIds = lines
      .map((line) => line.reservationId)
      .filter((id): id is string => id !== null);
    const live = await this.inventory.reservationsByIds(command.tenantId, reservationIds);
    const committed = live.filter((row) => row.state === 'committed');
    if (committed.length > 0) {
      // A consumed (committed) hold means a consuming flow won the
      // reservation first — the order is no longer purely pre-pick stock.
      throw new ProblemException(
        'conflict',
        409,
        'Order reservation is not held',
        `Order "${order.id}" has ${committed.length} committed reservation(s) — a consuming flow already claimed them; the order is not cancellable here.`,
      );
    }
    const holds = live.filter((row) => row.state === 'held');

    // Story 4.3: a COMMITTED hold is not the only way an order stops being
    // pre-pick stock. A hold settles only when the LAST open slice of its
    // order line is picked, so an order line split across two bins with one
    // slice already picked still carries a `held` reservation — and
    // releasing it here would free stock that has physically left the bin
    // through a `pick.picked` ledger draw. `cancelWave` refuses picked lines
    // for exactly this reason; the order's own cancel must refuse them too.
    //
    // Story 4.4: a `short` line that actually DREW units is the same problem
    // — the drawn units left the bin through the same ledger event. A
    // zero-unit short pick is not: nothing moved, so the order is still
    // cancellable, and `shortfall_qty < qty` is exactly the difference.
    const picked = await withTenantTransaction(this.db, command.tenantId, (tx) =>
      tx
        .select({ id: picklistLines.id })
        .from(picklistLines)
        .where(
          and(
            eq(picklistLines.tenantId, command.tenantId),
            eq(picklistLines.orderId, order.id),
            picklistLineDrewUnits(),
          ),
        ),
    );
    if (picked.length > 0) {
      throw new ProblemException(
        'conflict',
        409,
        'Order has drawn pick lines',
        `Order "${order.id}" has ${picked.length} drawn pick line(s) (${picked
          .map((line) => line.id)
          .join(', ')}) — those units have already left their bins, so the order is not cancellable here.`,
      );
    }

    // Story 4-2c (A3) — the test seam for the cancel-vs-allocation
    // interleaving: a backorder allocation committing HERE (between the
    // pre-check above and the flip below) is what the flip's own re-read of
    // the holds covers. A no-op in production.
    await cancelOrderTestHooks.afterPrecheck?.(order.id);

    // ── phase 3 (write tx): the flip + the lines + outbox + audit + key ───
    // The flip commits BEFORE the releases run. A crash between the two then
    // leaves the order `cancelled` with its holds still live — ATP
    // understated until the reaper expires them, never stock freed under an
    // order that still reads `accepted`. The fail-safe direction is the
    // whole reason this ordering was chosen over releasing first.
    const settled = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const updates = await tx
        .update(orders)
        .set({ status: 'cancelled', updatedAt: nowIso() })
        .where(
          and(
            eq(orders.id, order.id),
            eq(orders.tenantId, command.tenantId),
            eq(orders.status, 'accepted'),
          ),
        )
        .returning();
      const winner = updates[0];
      // Story 4-2c (A3) — the holds to release, re-read BY OWNER under the
      // flip's own row lock: a backorder allocation that committed after the
      // pre-check above (its phase 3 locks this row, so it either committed
      // before the flip or will read `cancelled` and release its own grants)
      // granted holds the pre-check never saw. Owner-keyed, because a short
      // pick's re-grant (and an allocation's adopted hold) is named by no
      // line column. Released after the commit with the pre-check's set.
      const ownerHeld =
        winner === undefined
          ? []
          : await this.inventory.heldReservationsByOwnerInTx(
              tx,
              command.tenantId,
              order.warehouseId,
              ORDER_OWNER_TYPE,
              lines.map((line) => line.id),
            );
      // A lost flip is the concurrent cancel's win — the idempotent no-op.
      // The WINNER's tx owns the outbox event, the audit row and the line
      // reset (one flip → one event, one audit line); the loser records only
      // its idempotency key so its replay contract still holds.
      if (winner !== undefined) {
        // The lines stop claiming stock in the same commit as the flip.
        // `reservation_id` is cleared with `reserved_qty` so no read — the
        // snapshot below, 4.2's Outbound surface, any roll-up — can report a
        // hold this order no longer owns. The journal keeps the audit trail:
        // every hold carries `owner_id` = the line id it was granted for.
        await tx
          .update(orderLines)
          .set({ reservedQty: 0, reservationId: null, updatedAt: nowIso() })
          .where(and(eq(orderLines.tenantId, command.tenantId), eq(orderLines.orderId, order.id)));
      }
      const target =
        winner ?? (await tx.select().from(orders).where(eq(orders.id, order.id)).limit(1))[0]!;
      // Story 4.5: a lost flip is only the concurrent CANCEL's win when the
      // order actually reads `cancelled` now. The phase-1 status guard above
      // ran in its own transaction and released its `FOR UPDATE` at that
      // commit, so a pack can land in the window between the two — and then
      // the flip matches no row for a completely different reason. Serving
      // the no-op here would answer 200 with a `ready_to_dispatch` order and
      // record an idempotency snapshot of it: the very "silent no-op dressed
      // as success" the phase-1 guard exists to prevent, reached by the back
      // door. Re-check under THIS transaction's own read and throw the same
      // refusal the guard would have.
      if (winner === undefined && target.status !== 'cancelled') {
        throw new ProblemException(
          'conflict',
          409,
          'Order is not cancellable',
          `Order "${order.id}" reads "${target.status}" — only an accepted order is cancelled here; its units have already left their bins.`,
        );
      }
      const snapshot = await this.snapshotOf(tx, target);

      if (winner !== undefined) {
        // In-transaction outbox append (AD-7) — before the idempotency key.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'order.cancelled',
          occurredAt: nowIso(),
          payload: { order: snapshot.order },
        });

        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'order.cancelled',
          targetType: 'order',
          targetId: order.id,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });
      }

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return { snapshot, won: winner !== undefined, ownerHeld };
    });
    const releaseSet = new Map(holds.map((hold) => [hold.id, hold]));
    for (const hold of settled.ownerHeld) releaseSet.set(hold.id, hold);

    // ── phase 4: release the holds, now that the flip is durable ──────────
    // Only the flip's winner releases (the loser's holds are the winner's to
    // settle). Nothing here may throw: the cancellation is already committed
    // and the caller's answer cannot be retracted, so a release that will not
    // settle is logged as the operational anomaly it is and left to the
    // hold's 7-day TTL — the ATP-understating direction.
    if (settled.won) {
      for (const hold of releaseSet.values()) {
        try {
          await this.inventory.releaseReservation(command.tenantId, hold.id);
        } catch (err) {
          if (err instanceof ProblemException && err.getStatus() === 409) {
            // A terminal writer won the conditional UPDATE between the
            // pre-check and this release — the 409 alone cannot say WHICH:
            // a racing cancel or the reaper's expiry is already settled and
            // nothing is owed, a consuming flow that committed inside that
            // window claimed stock this cancellation just gave away.
            const state = (await this.inventory.reservationsByIds(command.tenantId, [hold.id]))[0]
              ?.state;
            if (state === 'released' || state === 'expired') {
              continue;
            }
            this.logger.error(
              `Order cancel ${order.id}: reservation ${hold.id} is ${state ?? 'unknown'} — ` +
                `a consuming flow claimed it between the pre-check and the release, ` +
                `after the cancellation had committed. The order is cancelled and the ` +
                `committed hold stands; reconcile the pick against the cancellation.`,
            );
            continue;
          }
          this.logger.error(
            `Order cancel ${order.id}: releasing reservation ${hold.id} failed — ` +
              `${err instanceof Error ? err.message : String(err)}. The hold is left to ` +
              `its TTL (ATP understated until the reaper expires it).`,
          );
        }
      }
    }
    return settled.snapshot;
  }


  // ── shared pieces ─────────────────────────────────────────────────────────

  /**
   * One line's acceptance reservation: the per-line ATP split
   * `min(qty, ATP)` under the fixed backorder policy. A grant that loses a
   * stock race (409 `unavailable`) re-probes and reserves the remaining ATP
   * — the matrix's loser outcome — bounded retries; a line with nothing
   * left to reserve gets NO reservation (fully backordered).
   */
  private async reserveLine(
    command: CreateOrderCommand,
    line: OrderLineInput,
    lineId: string,
  ): Promise<ReservationSnapshot | null> {
    // Story 4-2c — the one grant path, shared with the backorder allocation
    // (`reserve-line.ts`): min(qty, ATP), bounded race re-probes, the
    // loser's backorder outcome, a 503 propagating.
    return grantLineHold(this.inventory, {
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      skuId: line.skuId,
      quantity: line.quantity,
      ownerId: lineId,
    });
  }

  /** Releases every reservation this command granted (the nothing-written invariant). */
  private async releaseAll(
    tenantId: string,
    granted: readonly ReservationSnapshot[],
    cause: string,
  ): Promise<void> {
    for (const reservation of granted) {
      try {
        await this.inventory.releaseReservation(tenantId, reservation.id);
      } catch (err) {
        // A release that cannot settle leaves the hold to its 7-day TTL and
        // the reaper — the fail-safe direction (ATP understated, never
        // oversold). Logged, never masked.
        this.logger.error(
          `Order ${cause}: releasing reservation ${reservation.id} failed — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * RD-3's phase-2.5 predicate over the grant phase's maps: which lines
   * demand more than they were granted? Plain lines and kit CHILDREN are the
   * entries (a zero grant counts — `?? 0`); kit parents are excluded (they
   * reserve 0 by construction — the map, never the rows, is the truth). A
   * non-empty result refuses the whole order (story 9-1 returns the lines
   * rather than a boolean so the refusal fact can name them; the predicate
   * itself — "any short entry" — is unchanged).
   */
  private policyShortLines(
    lines: readonly OrderLineInput[],
    explosions: Map<number, readonly KitCompositionLine[]>,
    plainHolds: Map<number, ReservationSnapshot>,
    childHolds: Map<string, ReservationSnapshot>,
  ): BackorderRefusalLine[] {
    const short: BackorderRefusalLine[] = [];
    for (const [index, line] of lines.entries()) {
      const bom = explosions.get(index);
      if (bom === undefined) {
        const available = plainHolds.get(index)?.quantity ?? 0;
        if (available < line.quantity) {
          short.push({ skuId: line.skuId, requestedMilli: line.quantity, availableMilli: available });
        }
        continue;
      }
      for (let childIndex = 0; childIndex < bom.length; childIndex += 1) {
        const component = bom[childIndex]!;
        const available = childHolds.get(`${index}:${childIndex}`)?.quantity ?? 0;
        if (available < component.qty) {
          short.push({ skuId: component.componentSkuId, requestedMilli: component.qty, availableMilli: available });
        }
      }
    }
    return short;
  }

  /**
   * Story 9-1 — the ingest refusal fact (SM-4's "prevented"). Only a channel
   * delivery carries both identity arms; the reject policy is reached only
   * from channel ingest today, so a refusal without them records nothing.
   * `ON CONFLICT DO NOTHING` on `(tenant, integration, external event)`:
   * a redelivered webhook mints a fresh idempotency key per delivery, so the
   * channel identity is the only dedupe that holds. Best-effort — logged,
   * never thrown.
   */
  private async recordBackorderRefusal(
    command: CreateOrderCommand,
    integrationId: string | null,
    externalEventId: string | null,
    shortLines: readonly BackorderRefusalLine[],
  ): Promise<void> {
    if (integrationId === null || externalEventId === null) {
      return;
    }
    try {
      await withTenantTransaction(this.db, command.tenantId, async (tx) => {
        await tx
          .insert(ingestBackorderRefusals)
          .values({
            id: uuidv7(),
            tenantId: command.tenantId,
            warehouseId: command.warehouseId,
            integrationId,
            externalEventId,
            lines: shortLines,
          })
          .onConflictDoNothing({
            target: [
              ingestBackorderRefusals.tenantId,
              ingestBackorderRefusals.integrationId,
              ingestBackorderRefusals.externalEventId,
            ],
          });
      });
    } catch (err) {
      this.logger.error(
        `Order refused under the backorder policy (integration ${integrationId}, event ${externalEventId}) but its refusal fact could not be written — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The concurrent-dedup-loser outcome: re-read the winner, resolve the contract. */
  private async resolveDedupLoser<R>(
    err: DedupLostError,
    idempotencyKey: string,
    payloadHash: string,
    surface: OrderSurface<R>,
  ): Promise<R> {
    if (surface.kind === 'portal') {
      throw new Error('placePortalOrder: a portal order has no channel dedup to lose');
    }
    const tenantId = err.tenantId;
    const existing = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.integrationId, err.integrationId),
            eq(orders.externalEventId, err.externalEventId),
            // Story 4-2c — the root (the narrowed index's population).
            isNull(orders.followOnOfOrderId),
          ),
        )
        .limit(1),
    );
    const prior = existing[0];
    if (prior === undefined) {
      // The winner rolled back after all — the caller retries against a
      // settled state (the grant-unique-violation re-probe precedent).
      throw new ProblemException(
        'conflict',
        409,
        'Concurrent order ingestion',
        'The same channel payload is being processed concurrently; retry to read the settled result.',
      );
    }
    if (prior.sourcePayloadHash !== err.sourcePayloadHash) {
      throw orderSourceConflict(prior.id);
    }
    // Same payload delivered concurrently: exactly one order exists — the
    // redelivery contract (the winner's snapshot, no new reservation).
    // (A channel delivery only — the staff surface, whose response is the
    // snapshot itself.)
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const snapshot = await surface.respond(tx, await this.snapshotOf(tx, prior));
      await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<unknown | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)),
      )
      .limit(1);
    const row = existing[0];
    if (row === undefined) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return row.responseSnapshot;
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: unknown,
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({
        id: uuidv7(),
        tenantId,
        key: idempotencyKey,
        payloadHash,
        responseSnapshot: snapshot,
      });
    } catch (err) {
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        // Concurrent duplicate of the same idempotent request — the winner's
        // response is authoritative; this request carries no new state.
        throw new ProblemException(
          'conflict',
          409,
          'Concurrent idempotent request',
          'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
        );
      }
      throw err;
    }
  }

  private async snapshotById(tx: TenantTx, orderId: string): Promise<OrderSnapshot> {
    const rows = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    return this.snapshotOf(tx, rows[0]!);
  }

  /** The order + lines as one snapshot (the live reservation states ride in). */
  async snapshotOf(tx: TenantTx, order: Order): Promise<OrderSnapshot> {
    return orderSnapshotInTx(tx, this.inventory, order);
  }

  /**
   * Every line's SKU must exist in the tenant (404 naming the unknown id),
   * and the read hands back each one's base UoM — story 10.2 converts the
   * line quantities against the unit, so the existence check and the unit
   * lookup are one query rather than two.
   */
  private async assertSkuIdsInTenant(
    tx: TenantTx,
    tenantId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, SkuFacts>> {
    const distinct = [...new Set(skuIds)];
    // Story 21-2b: the same read hands back each SKU's client — the order
    // derives its own from them.
    const rows = await tx
      .select({
        id: skus.id,
        uom: skus.uom,
        clientId: skus.clientId,
        code: skus.code,
        status: skus.status,
        foodCategory: skus.foodCategory,
        drugSchedules: skus.drugSchedules,
      })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, distinct)));
    // Story 1-4b — the code and status ride the same read (the phase-2.5
    // sell-down refusal names the SKU; phase 3 re-reads the status locked).
    const byId = new Map(
      rows.map((row) => [
        row.id,
        {
          uom: row.uom,
          clientId: row.clientId,
          code: row.code,
          status: row.status as SkuStatus,
          foodCategory: row.foodCategory,
          drugSchedules: row.drugSchedules,
        },
      ]),
    );
    for (const skuId of distinct) {
      if (!byId.has(skuId)) {
        throw new ProblemException(
          'not-found',
          404,
          'SKU not found',
          `No SKU with id "${skuId}" exists in this tenant.`,
        );
      }
    }
    return byId;
  }

  /**
   * Story 1-6d — with licence enforcement on, every SKU of the order must be
   * covered at the warehouse on `date` (1-6c's rule: a client licence for the
   * site or for none, AND a site licence; the `self` client the site licence
   * only) — else 409 `licence-not-covered` naming each SKU, its missing need
   * and the holder. Off → nothing read but the switch.
   */
  private async assertLicencesCoverInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    date: string,
    order: {
      readonly clientId: string;
      readonly systemOwned: boolean;
      readonly skus: readonly (LicenceGoodsProfile & { readonly code: string })[];
    },
  ): Promise<void> {
    const goods = order.skus.filter((sku) => needsOf(sku).length > 0);
    if (goods.length === 0 || !(await licenceEnforcedInTx(tx, tenantId))) return;
    const uncovered = await licenceCoverageInTx(tx, {
      tenantId,
      warehouseId,
      date,
      parties: goods.map((sku) => ({
        clientId: order.clientId,
        systemOwned: order.systemOwned,
        skuCode: sku.code,
        needs: needsOf(sku),
      })),
    });
    if (uncovered.length > 0) {
      throw licenceNotCovered(uncovered, await getWarehouseCodeInTx(tx, tenantId, warehouseId));
    }
  }

  /** Line-shape validation (400 before any write). */
  /**
   * Story 8-1 — the line rate's shape rule: a non-negative safe integer in
   * paise (null/absent = unpriced). Behind the replay lookup (its caller's
   * position); named because ONE rate rule serves manual and ingested calls
   * alike. No upper ceiling on the WIRE beyond the safe-integer range — the
   * invoice math asserts its own exact-range outputs in `arith.ts`, so an
   * absurd rate is a loud typed failure at generation, never a silent round.
   */
  private assertRatePaise(rate: number): number {
    if (!Number.isSafeInteger(rate) || rate < 0) {
      throw validationFailed(
        `ratePaise must be a non-negative integer in paise (got ${String(rate)}).`,
      );
    }
    return rate;
  }

  private assertLines(lines: readonly OrderLineInput[]): void {
    if (lines.length === 0) {
      throw validationFailed('An order carries at least one line.');
    }
    for (const line of lines) {
      if (!UUID_RE.test(line.skuId)) {
        throw validationFailed('Every line names a well-formed skuId.');
      }
      // Story 10.2: `line.quantity` is in BASE units here — the conversion
      // (and the per-unit precision refusal) happens further down, behind the
      // replay lookup. This is the shape check only: positive and inside the
      // exact range. The unit's own precision is not this function's business,
      // because it does not know which SKU each line names yet.
      if (!(line.quantity > 0) || line.quantity > fromMilli(MAX_LINE_QUANTITY)) {
        throw validationFailed(
          `Line quantity must be a positive quantity in base UoM, at most ${fromMilli(MAX_LINE_QUANTITY)} (got ${String(line.quantity)}).`,
        );
      }
    }
  }
}

/** Story 21-2b — one SKU's existence facts: its base UoM and its client (1-4b: code and status; 1-6d: the goods attributes). */
interface SkuFacts {
  readonly uom: string;
  readonly clientId: string;
  readonly code: string;
  readonly status: SkuStatus;
  readonly foodCategory: string | null;
  readonly drugSchedules: readonly string[];
}

function uomsOf(facts: ReadonlyMap<string, SkuFacts>): Map<string, string> {
  return new Map([...facts].map(([id, sku]) => [id, sku.uom]));
}

/**
 * The order + lines as one snapshot (the live reservation states ride in) —
 * story 4-2c (A12) extracted it from `OrderCommandService.snapshotOf` so the
 * dispatch command builds its follow-on's snapshot through the same
 * serializer, with no new injection (it already holds the inventory facade).
 */
export async function orderSnapshotInTx(tx: TenantTx, inventory: InventoryFacade, order: Order): Promise<OrderSnapshot> {
  const lines = await tx
    .select()
    .from(orderLines)
    .where(eq(orderLines.orderId, order.id))
    .orderBy(orderLines.createdAt, orderLines.id);
  // Story 11.4: the kit parents are the ids the children name — inversion,
  // no flag, the same relational identity as kit-ness itself.
  const kitParentIds = new Set(
    lines.map((line) => line.parentLineId).filter((id): id is string => id !== null),
  );
  const reservationIds = lines
    .map((line) => line.reservationId)
    .filter((id): id is string => id !== null);
  const reservations = new Map<string, ReservationSnapshot>();
  if (reservationIds.length > 0) {
    // The live reservation STATE through the facade (AD-6) — the line row
    // carries only the id; the journal carries the truth.
    for (const row of await inventory.reservationsByIdsInTx(tx, order.tenantId, reservationIds)) {
      reservations.set(row.id, row);
    }
  }
  // Story 4-2c — the follow-on this order's short dispatch opened (one per
  // parent — `orders_follow_on_of_unique`).
  const child = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.tenantId, order.tenantId), eq(orders.followOnOfOrderId, order.id)))
    .limit(1);
  // Story 4-2c (A8) — a kit parent's LIVE shortfall, from its children's
  // reserved quantities (allocation never changes the acceptance status).
  const childrenOf = new Map<string, OrderLine[]>();
  for (const line of lines) {
    if (line.parentLineId === null) continue;
    const list = childrenOf.get(line.parentLineId) ?? [];
    list.push(line);
    childrenOf.set(line.parentLineId, list);
  }
  return {
    order: {
      id: order.id,
      tenantId: order.tenantId,
      warehouseId: order.warehouseId,
      status: order.status as OrderStatus,
      source: order.source as OrderSource,
      integrationId: order.integrationId,
      externalEventId: order.externalEventId,
      // Story 4-1b: the client's own order number (null when none).
      clientOrderRef: order.clientOrderRef,
      // Story 4-2a: the order header fields (orderType null on a pre-4-2a row).
      orderType: order.orderType as OrderType | null,
      priority: order.priority as OrderPriority,
      shipByDate: order.shipByDate,
      codAmountPaise: order.codAmountPaise,
      // Story 11-1: the destination echoes from the flat columns; a
      // pre-11.1 row (all null) reads back `destination: null`.
      destination: addressFromColumns({
        contactName: order.destinationContactName,
        phone: order.destinationPhone,
        line1: order.destinationLine1,
        line2: order.destinationLine2,
        city: order.destinationCity,
        state: order.destinationState,
        pincode: order.destinationPincode,
      }),
      clientId: order.clientId,
      followOnOfOrderId: order.followOnOfOrderId,
      followOnRootOrderId: order.followOnRootOrderId,
      followOnSeq: order.followOnSeq,
      followOnOrderId: child[0]?.id ?? null,
      createdAt: canonicalInstant(order.createdAt),
      updatedAt: canonicalInstant(order.updatedAt),
      lines: lines.map((line) => lineSnapshot(line, reservations, kitParentIds, childrenOf.get(line.id))),
    },
  };
}

/** One stored line as every read of this module returns it. */
export function lineSnapshot(
  row: OrderLine,
  reservations: ReadonlyMap<string, ReservationSnapshot>,
  kitParentIds: ReadonlySet<string> = new Set(),
  children?: readonly OrderLine[],
): OrderLineSnapshot {
  const reservation = row.reservationId === null ? undefined : reservations.get(row.reservationId);
  // A kit parent line holds nothing itself — its children hold the stock —
  // so its shortfall is never the meaningless qty − 0. Story 4-2c (A8): it is
  // the kits the children's LIVE reserved quantities do not cover
  // (`Q − complete`), so an allocated kit stops reading short; without the
  // children (a caller that has none to hand) it is the acceptance outcome
  // (0 when the kit's components reserved, the whole qty when it backordered).
  const shortfallMilli = kitParentIds.has(row.id)
    ? children !== undefined && children.length > 0
      ? row.qty - completeKits(row.qty, children.map((child) => ({ qty: child.qty, covered: child.reservedQty })))
      : row.status === 'backordered'
        ? row.qty
        : 0
    : row.qty - row.reservedQty;
  return {
    id: row.id,
    orderId: row.orderId,
    skuId: row.skuId,
    // Story 10.1: `lineSnapshot` is the module's only order-line read shape —
    // every response body and outbox payload comes through here, so base units
    // leave and milli-units stay below.
    qty: fromMilli(row.qty),
    reservedQty: fromMilli(row.reservedQty),
    shortfallQty: fromMilli(shortfallMilli),
    status: row.status,
    reservationId: row.reservationId,
    reservationState: reservation?.state ?? null,
    parentLineId: row.parentLineId,
    createdAt: canonicalInstant(row.createdAt),
  };
}

// ── story 4-1a: the order pipeline's surfaces ─────────────────────────────────

/** The hash-stage values a surface computes before phase 1 (both surfaces). */
interface OrderHashStage {
  readonly integrationId: string | null;
  readonly externalEventId: string | null;
  /** Normalized (lenient) — the shape refusal is phase 1's. */
  readonly consigneeGstin: string | null;
  /** Normalized (trim, blank = absent) — the refusals are phase 1's. */
  readonly consigneeLegalName: string | null;
  /** Story 4-1b — normalized (trim, blank = absent); the shape refusal and the duplicate check are phase 1's. */
  readonly clientOrderRef: string | null;
  /** Story 4-2a — normalized (a string trimmed, blank = absent); the value checks are phase 1's. */
  readonly orderFields: NormalizedOrderFields;
  /** Story 4-2a (A13) — the ONE IST date the create captured (`licenceToday()`), the ship-by bound's today. */
  readonly licenceDate: string;
  readonly sourcePayloadHash: string | null;
  readonly payloadHash: string;
}

/** The licence check's subject: the order's client and every SKU it holds. */
interface LicenceOrder {
  readonly clientId: string;
  readonly systemOwned: boolean;
  readonly skus: readonly (LicenceGoodsProfile & { readonly code: string })[];
}

/** The portal's licence facts, read through the unstamped seam. */
interface LicenceSnapshot {
  readonly enforced: boolean;
  readonly facts: readonly LicenceFacts[];
}

/**
 * Story 4-1a — what differs between the staff (`createOrder`) and portal
 * (`placePortalOrder`) surfaces of the one order pipeline. Everything else —
 * the validation, the conversion, the kit explosion, the client derivation,
 * the grants, the sell-down and policy refusals, the SKU re-read under lock
 * and the write set — is shared, in the order `createOrder` always ran it.
 */
interface OrderSurface<R> {
  /**
   * Which surface: the staff path checks licences inside phase 1's
   * transaction and records a channel refusal fact; the portal judges its
   * licences after phase 1 (the unstamped seam), refuses ANY inactive SKU at
   * phase 3, and never reaches the channel arms.
   */
  readonly kind: 'staff' | 'portal';
  /** Opens phase 1's and phase 3's transactions (the portal: client-stamped). */
  readonly transaction: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  /** Authority, first in phase 1 — before the replay lookup. */
  readonly authorize: (tx: TenantTx) => Promise<void>;
  /** First in phase 3 (the portal repeats its gate; staff: nothing). */
  readonly reauthorize: (tx: TenantTx) => Promise<void>;
  /** The line SKUs' facts — 404 for any the surface does not admit. */
  readonly loadLineSkus: (tx: TenantTx, skuIds: readonly string[]) => Promise<Map<string, SkuFacts>>;
  /** The portal's unstamped seam — read after phase 1's authority and replay miss, and before phase 3's transaction; staff: null. */
  readonly prefetchLicences: () => Promise<LicenceSnapshot | null>;
  /**
   * The licence check (phase 1, and again in phase 3 against the locked
   * SKUs). Staff: in the phase transaction (`tx`), `prefetched` null. Portal:
   * over `prefetched` (never null — a missing snapshot refuses), `tx` unused
   * (null after phase 1).
   */
  readonly assertLicences: (tx: TenantTx | null, prefetched: LicenceSnapshot | null, order: LicenceOrder) => Promise<void>;
  /** The refusal under `backorderPolicy: 'reject'`. */
  readonly backorderRefusal: (shortLines: readonly BackorderRefusalLine[], skuFacts: ReadonlyMap<string, SkuFacts>) => ProblemException;
  /** Story 4-1b — the 409 `duplicate-client-order-ref` in the surface's own words (decision 9). */
  readonly duplicateClientOrderRef: (tx: TenantTx, ref: string, clash: LiveOrderClash | null) => Promise<ProblemException>;
  /** The response and the stored idempotency snapshot, built in the write transaction. */
  readonly respond: (tx: TenantTx, snapshot: OrderSnapshot) => Promise<R>;
}

/**
 * Story 4-1c (A9) — the portal order gate, one function for `placePortalOrder`
 * (phase 1 and again at the start of phase 3) and the portal order import's
 * own transactions (before its replay and again before its key): `orders.place`
 * → the actor re-read (not active 401, another client 403 `role-denied`, which
 * also refuses an owner, who holds every capability) → the client `FOR SHARE`
 * (departed or suspended 403). Behaviour and wording are 4-1a's.
 */
export async function assertPortalOrderGateInTx(
  tx: TenantTx,
  scope: { readonly tenantId: string; readonly clientId: string; readonly actorUserId: string },
): Promise<void> {
  assertPermission(await getMemberRoleIn(tx, scope.tenantId, scope.actorUserId), 'orders.place');
  const actor = await getMemberPortalFactsIn(tx, scope.tenantId, scope.actorUserId);
  if (actor === null || actor.status !== 'active') {
    throw new ProblemException(
      'unauthenticated',
      401,
      'Authentication required',
      'The session no longer describes an active client-portal user — sign in again.',
    );
  }
  if (actor.clientId !== scope.clientId) {
    throw new ProblemException(
      'role-denied',
      403,
      'Role lacks the required capability',
      'Only a client-portal user of this client may place its orders.',
    );
  }
  // FOR SHARE (21-10): a suspend committing mid-phase either waits for
  // this transaction or is re-read here once it commits.
  const client = await shareLockClientInTx(tx, scope.tenantId, scope.clientId);
  if (client.status !== 'active') {
    throw clientInactive(client.status);
  }
}

/** Story 4-1c — what a keyless Check (`checkOrder` / `checkPortalOrder`) answers. */
export interface OrderCheck {
  /** The client the order derives from its SKUs. */
  readonly clientId: string;
  /** Top-level lines (as given). */
  readonly lineCount: number;
}

/** Story 4-1c — one surface's plan: the pipeline command, its hash stage and its surface. */
interface OrderPlan<R> {
  readonly command: CreateOrderCommand;
  readonly hashes: OrderHashStage;
  readonly surface: OrderSurface<R>;
}

/** Phase 1's outcome when the order goes on to the grants. */
interface PreflightAccepted {
  readonly replayed: false;
  readonly destination: AddressInput;
  /** Story 4-2a — the validated, derived order header fields. */
  readonly fields: ValidatedOrderFields;
  /** Milli-units, each with its validated rate (story 8-1). */
  readonly lines: readonly OrderLineInput[];
  readonly explosions: Map<number, readonly KitCompositionLine[]>;
  readonly clientId: string;
  /** The order client's `self` flag (the licence rule's party fact). */
  readonly systemOwned: boolean;
  readonly skuFacts: ReadonlyMap<string, SkuFacts>;
}

type Preflight<R> = { readonly replayed: true; readonly snapshot: R } | PreflightAccepted;

/** Phase 2's grants, by line index (plain lines) and `index:childIndex` (kit children). */
interface OrderGrants {
  readonly lineIds: readonly string[];
  readonly childIds: ReadonlyMap<number, readonly string[]>;
  readonly plainHolds: Map<number, ReservationSnapshot>;
  readonly childHolds: Map<string, ReservationSnapshot>;
  readonly granted: readonly ReservationSnapshot[];
}

/**
 * Story 4-1a — the portal's shortage refusal (decision 6): the whole order is
 * refused, naming the client's own short SKU codes — never a reservation, an
 * ATP figure or another order. The code is the reject policy's
 * (`order-backorder-rejected`); `extensions.skuCodes` carries the codes
 * (sorted, distinct) for the web's own sentence.
 */
export function portalStockShort(skuCodes: readonly string[]): ProblemException {
  const codes = [...new Set(skuCodes)].sort();
  return new ProblemException(
    'order-backorder-rejected',
    409,
    'Not enough stock for the order',
    `Not enough stock at this warehouse for ${codes.map((code) => `"${code}"`).join(', ')} — nothing was placed. Lower the quantities or choose another warehouse.`,
    { skuCodes: codes },
  );
}

/**
 * Story 4-1a — a line SKU the client-stamped phase-3 read no longer sees (its
 * client was corrected since phase 1): the order is refused rather than
 * judged over fewer SKUs than it holds. Every grant is released.
 */
export function portalOrderSkusChanged(): ProblemException {
  return new ProblemException(
    'order-catalog-changed',
    409,
    'The catalog changed while the order was placed',
    'A product on this order changed while it was placed — nothing was written. Reload and place the order again.',
  );
}

/**
 * Story 4-1a (decision 5) — the portal's GENERIC licence refusal: the same
 * code as the staff refusal (`licence-not-covered`), but never which licence
 * is missing, which holder lacks it, the site or its code — a client must not
 * learn the warehouse's own licence gaps.
 */
export function portalLicenceNotCovered(): ProblemException {
  return new ProblemException(
    'licence-not-covered',
    409,
    'A required licence is not on file',
    'A licence for one of these products is not on file with the warehouse — nothing was placed. Contact the warehouse.',
  );
}

// ── outcomes ─────────────────────────────────────────────────────────────────

/**
 * Story 11.4 — one kit line's explosion into its component child lines, with
 * the quantity math validated HERE (phase 1, before any grant moves).
 *
 * 1 kit = 1 base-UoM unit of the kit SKU (the kit's own `uom_conversions`
 * play no part). Component qty is per ONE kit, in the component's base-UoM
 * milli-units; a kit line of Q (kit-milli) therefore needs Q × per-kit-milli
 * ÷ 1000 milli of the component. Two refusals fall out of that arithmetic:
 * a product or quotient above the exact-integer / quantity ceilings, and a
 * child quantity the COMPONENT's own unit cannot express — `child % 10^(3 −
 * precision) ≠ 0` covers both a sub-milli remainder and (for a 0- or 1-
 * decimal unit like `each`) a finer-than-declared fraction such as 0.5 each,
 * which a pick could never record (`assertRecordableQuantity` refuses it) and
 * which would strand the child line with its hold until TTL. Both are 400s —
 * never silent rounding after grants were made (the `MAX_LINE_QUANTITY`
 * rationale).
 */
function explodeKitLine(
  line: OrderLineInput,
  lineIndex: number,
  bom: readonly KitCompositionLine[],
  uomByComponentSku: ReadonlyMap<string, string>,
): KitCompositionLine[] {
  return bom.map((component) => {
    const product = line.quantity * component.qty;
    if (!Number.isSafeInteger(product) || product / QUANTITY_SCALE > MAX_LINE_QUANTITY) {
      throw validationFailed(
        `Line ${lineIndex} (kit ${line.skuId}) explodes past the quantity ceiling: ${String(line.quantity)} × ${String(component.qty)} milli is more than any line can carry. Split the order line.`,
      );
    }
    const child = product / QUANTITY_SCALE;
    const precision = uomPrecision(uomByComponentSku.get(component.componentSkuId)!);
    if (child % 10 ** (QUANTITY_DECIMALS - precision) !== 0) {
      throw validationFailed(
        `Line ${lineIndex} (kit ${line.skuId}) explodes to a component quantity the component's UoM cannot express (child ${String(child)} milli at ${String(precision)} decimal place(s)) — adjust the kit line quantity or the composition.`,
      );
    }
    return { componentSkuId: component.componentSkuId, qty: child };
  });
}

function validationFailed(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Order validation failed', detail);
}

// ── story 4-2a: the order header fields ───────────────────────────────────────

/** How far ahead a manual order's ship-by date may be (inclusive), in IST days. */
export const MAX_SHIP_BY_DAYS_AHEAD = 365;

/**
 * Story 4-2a — the four fields as normalized before the hash: a string is
 * trimmed, and `undefined`, `null` and a blank string read as ABSENT (null).
 * Any other value is kept AS SENT (so it hashes as sent) and refused behind
 * the replay lookup — `assertOrderFields`.
 */
export interface NormalizedOrderFields {
  readonly orderType: unknown;
  readonly priority: unknown;
  readonly shipByDate: unknown;
  readonly codAmountPaise: unknown;
}

/** The fields as phase 1 validated and derived them — what the insert writes. */
export interface ValidatedOrderFields {
  readonly orderType: OrderType;
  readonly priority: OrderPriority;
  readonly shipByDate: string | null;
  readonly codAmountPaise: number | null;
}

function normalizeOrderFieldValue(raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const value = raw.trim();
    return value === '' ? null : value;
  }
  return raw;
}

/** Story 4-2a — the lenient pre-hash normal form (never throws). */
export function normalizeOrderFields(input: {
  readonly orderType?: unknown;
  readonly priority?: unknown;
  readonly shipByDate?: unknown;
  readonly codAmountPaise?: unknown;
}): NormalizedOrderFields {
  return {
    orderType: normalizeOrderFieldValue(input.orderType),
    priority: normalizeOrderFieldValue(input.priority),
    shipByDate: normalizeOrderFieldValue(input.shipByDate),
    codAmountPaise: normalizeOrderFieldValue(input.codAmountPaise),
  };
}

/**
 * Story 4-2a (decision 7) — the fields' contribution to the payload hash:
 * each key ONLY when sent, as sent (never a derived default), at fixed
 * positions in this order. Spread right after `clientOrderRef`.
 */
export function orderFieldsFingerprint(fields: NormalizedOrderFields): Record<string, unknown> {
  return {
    ...(fields.orderType === null ? {} : { orderType: fields.orderType }),
    ...(fields.priority === null ? {} : { priority: fields.priority }),
    ...(fields.shipByDate === null ? {} : { shipByDate: fields.shipByDate }),
    ...(fields.codAmountPaise === null ? {} : { codAmountPaise: fields.codAmountPaise }),
  };
}

/**
 * Story 4-2a — the value checks (400 `validation-failed`), behind the replay
 * lookup, then the derived defaults. The command is the boundary: a non-HTTP
 * caller (the channel ingest) bypasses the DTO, and the DTO checks types only.
 */
export function assertOrderFields(
  fields: NormalizedOrderFields,
  context: { readonly surface: 'staff' | 'portal'; readonly consigneeGstin: string | null; readonly todayIst: string },
): ValidatedOrderFields {
  const { orderType, priority, shipByDate, codAmountPaise } = fields;
  if (orderType !== null && !(typeof orderType === 'string' && (ORDER_TYPES as readonly string[]).includes(orderType))) {
    throw validationFailed(`orderType must be one of ${JSON.stringify(ORDER_TYPES)} (got ${JSON.stringify(orderType)}).`);
  }
  // Decision 4 (A7): only an EXPLICIT b2c contradicts a GSTIN — a derived type never refuses.
  if (orderType === 'b2c' && context.consigneeGstin !== null) {
    throw validationFailed(
      'orderType b2c contradicts the consignee GSTIN — a GST-registered buyer is a business: send b2b, or leave orderType out.',
    );
  }
  if (priority !== null && !(typeof priority === 'string' && (ORDER_PRIORITIES as readonly string[]).includes(priority))) {
    throw validationFailed(`priority must be one of ${JSON.stringify(ORDER_PRIORITIES)} (got ${JSON.stringify(priority)}).`);
  }
  // A12 — urgent is the warehouse's call; a portal client may ask for high.
  if (context.surface === 'portal' && priority !== null && !(PORTAL_ORDER_PRIORITIES as readonly string[]).includes(priority as string)) {
    throw validationFailed('Urgent priority is set by the warehouse — choose Normal or High.');
  }
  if (shipByDate !== null) {
    if (typeof shipByDate !== 'string' || !isIsoDate(shipByDate)) {
      throw validationFailed(
        `shipByDate must be a calendar date YYYY-MM-DD (an IST day, not a time; got ${JSON.stringify(shipByDate)}).`,
      );
    }
    const latest = addIsoDays(context.todayIst, MAX_SHIP_BY_DAYS_AHEAD);
    if (shipByDate < context.todayIst || shipByDate > latest) {
      throw validationFailed(
        `shipByDate must fall from today (${context.todayIst}, IST) to ${latest} — ${MAX_SHIP_BY_DAYS_AHEAD} days ahead (got ${shipByDate}).`,
      );
    }
  }
  if (codAmountPaise !== null) {
    if (
      typeof codAmountPaise !== 'number' ||
      !Number.isSafeInteger(codAmountPaise) ||
      codAmountPaise < 1 ||
      codAmountPaise > MAX_COD_AMOUNT_PAISE
    ) {
      throw validationFailed(
        `codAmountPaise is the cash to collect in whole paise, a number from 1 to ${MAX_COD_AMOUNT_PAISE} (₹1 crore) — leave it out for a prepaid order (got ${JSON.stringify(codAmountPaise)}).`,
      );
    }
  }
  return {
    orderType: (orderType as OrderType | null) ?? (context.consigneeGstin !== null ? 'b2b' : 'b2c'),
    priority: (priority as OrderPriority | null) ?? 'normal',
    shipByDate: shipByDate as string | null,
    codAmountPaise: codAmountPaise as number | null,
  };
}

/**
 * Story 4-1b — the client order number's shape refusal (400
 * `validation-failed`), run on the NORMALIZED value behind the replay lookup.
 */
export function assertClientOrderRefShape(ref: string): void {
  // The character rule first, so an over-long value with a bad character
  // reports the character, not the length.
  const characters =
    'clientOrderRef must be plain ASCII letters, digits, spaces and punctuation — no control characters (tabs, line breaks) and no accented or other non-ASCII characters.';
  if (!/^[ -~]*$/.test(ref)) throw validationFailed(characters);
  if (ref.length > MAX_CLIENT_ORDER_REF_LENGTH) {
    throw validationFailed(`clientOrderRef is at most ${MAX_CLIENT_ORDER_REF_LENGTH} characters (got ${ref.length}).`);
  }
  // The column CHECK's full shape (the edges are not spaces after the trim).
  if (!CLIENT_ORDER_REF_RE.test(ref)) throw validationFailed(characters);
}

/** Story 4-1b — 409 `duplicate-client-order-ref`; `detail` is the surface's sentence (decision 9). */
export function duplicateClientOrderRef(detail: string, extensions?: Record<string, unknown>): ProblemException {
  return new ProblemException('duplicate-client-order-ref', 409, 'Client order number already in use', detail, extensions);
}

/** Story 4-1b — the live order of the client holding the number (the duplicate's subject). */
export interface LiveOrderClash {
  readonly orderId: string;
  readonly warehouseId: string;
}

/** Story 4-1b — the client's LIVE order holding `ref`, or null (the unique index's population). */
async function liveOrderWithRefInTx(tx: TenantTx, tenantId: string, clientId: string, ref: string): Promise<LiveOrderClash | null> {
  const rows = await tx
    .select({ orderId: orders.id, warehouseId: orders.warehouseId })
    .from(orders)
    // Story 4-2c — the ROOT holding the number (a follow-on shares it).
    .where(and(eq(orders.tenantId, tenantId), eq(orders.clientOrderRef, ref), eq(orders.clientId, clientId), ne(orders.status, 'cancelled'), isNull(orders.followOnOfOrderId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Story 4-1b — a concurrent order took the number (thrown in the aborted write tx; named after the rollback). */
class ClientOrderRefLostError extends Error {
  constructor(readonly ref: string) {
    super('a concurrent order of the same client took the client order number');
  }
}

function orderNotFound(orderId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Order not found',
    `No order with id "${orderId}" exists in this tenant.`,
  );
}

/** A divergent payload on a channel ref that already created an order. */
function orderSourceConflict(existingOrderId: string): ProblemException {
  return new ProblemException(
    'order-source-conflict',
    422,
    'Channel order ref already used by another payload',
    `The (integration, external event) ref already created order "${existingOrderId}" with a DIFFERENT payload — this is a data conflict, not a retry.`,
  );
}

/**
 * The concurrent-dedup-loser marker: thrown inside the create tx (its
 * rollback releases the grants through the outer catch) and resolved against
 * the settled winner outside it.
 */
class DedupLostError extends Error {
  constructor(
    readonly tenantId: string,
    readonly integrationId: string,
    readonly externalEventId: string,
    readonly sourcePayloadHash: string | null,
  ) {
    super('a concurrent delivery of the same channel payload won the dedup index');
  }
}

/** Story 9-1 — one short line of a refused channel order, in milli-units (the fact row's shape). */
export interface BackorderRefusalLine {
  readonly skuId: string;
  readonly requestedMilli: number;
  readonly availableMilli: number;
}

/**
 * Story 7.2 (RD-3): the whole-order refusal under `backorder_policy:
 * 'reject'` — thrown between the grant phase and the write tx, so NO
 * `orders` row exists behind it. The ingest arm maps this (by its code
 * string) onto the connection-naming refusal; a manual caller would see it
 * verbatim, and no existing caller passes `'reject'` today.
 */
export class BackorderRejectedError extends ProblemException {
  constructor() {
    super(
      'order-backorder-rejected',
      409,
      'Order rejected under the backorder policy',
      "The order's backorder policy is REJECT and some line could not fully reserve at grant time — the whole order was refused and every reservation it moved was released.",
    );
  }
}

/**
 * Story 1-4b (decision 1) — the sell-down refusal: every order line of an
 * inactive SKU that did not reserve in full. A plain line is short when its
 * hold is below its quantity; a kit line is short when its kit could not be
 * reserved in full (a failed kit released its holds, so no per-component
 * numbers are given) and its kit SKU or any component is inactive. `statusOf`
 * reads the phase-1 facts or the phase-3 locked rows. Null when nothing is
 * short. The refusal is 409 `sku-inactive` naming the inactive codes in
 * `extensions.skuCodes`; the available quantity excludes buffered units.
 */
export function inactiveShortRefusal(
  lines: readonly OrderLineInput[],
  explosions: ReadonlyMap<number, readonly KitCompositionLine[]>,
  plainHolds: ReadonlyMap<number, ReservationSnapshot>,
  childHolds: ReadonlyMap<string, ReservationSnapshot>,
  statusOf: (skuId: string) => { readonly code: string; readonly status: SkuStatus } | undefined,
): ProblemException | null {
  const codes: string[] = [];
  const parts: string[] = [];
  const inactiveCode = (skuId: string): string | null => {
    const facts = statusOf(skuId);
    return facts !== undefined && facts.status !== 'active' ? facts.code : null;
  };
  for (const [index, line] of lines.entries()) {
    const bom = explosions.get(index);
    if (bom === undefined) {
      const code = inactiveCode(line.skuId);
      if (code === null) continue;
      const available = plainHolds.get(index)?.quantity ?? 0;
      if (available >= line.quantity) continue;
      codes.push(code);
      parts.push(`SKU "${code}" — ordered ${fromMilli(line.quantity)}, available ${fromMilli(available)}`);
      continue;
    }
    const kitReserved = bom.every((component, childIndex) => {
      const hold = childHolds.get(`${index}:${childIndex}`);
      return hold !== undefined && hold.quantity >= component.qty;
    });
    if (kitReserved) continue;
    const inactive = [line.skuId, ...bom.map((component) => component.componentSkuId)]
      .map(inactiveCode)
      .filter((code): code is string => code !== null);
    if (inactive.length === 0) continue;
    const kitCode = statusOf(line.skuId)?.code ?? line.skuId;
    codes.push(...inactive);
    parts.push(
      `kit "${kitCode}" (inactive: ${[...new Set(inactive)].map((code) => `"${code}"`).join(', ')}) — the kit could not be reserved in full`,
    );
  }
  if (codes.length === 0) return null;
  return skuInactive(
    codes,
    `An inactive SKU sells existing stock only — its order line is accepted only when stock covers it in full, never backordered: ${parts.join('; ')}.`,
  );
}

/**
 * Story 1-4b — 409 `order-catalog-changed`: a line's SKU became a kit while
 * the order was placed (the PENDING kit race), so its grant would hold a
 * kit's stock. Nothing was written; every grant is released. Retry.
 */
export function orderCatalogChanged(skuCodes: readonly string[]): ProblemException {
  return new ProblemException(
    'order-catalog-changed',
    409,
    'The catalog changed while the order was placed',
    `The catalog changed while the order was placed — ${skuCodes.map((code) => `"${code}"`).join(', ')} became a kit. Nothing was written; retry.`,
    { skuCodes: [...skuCodes].sort() },
  );
}
