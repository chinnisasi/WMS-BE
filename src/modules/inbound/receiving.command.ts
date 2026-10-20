import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  advanceShipmentNotices,
  asnLines,
  auditEvents,
  devices,
  goodsReceiptLines,
  goodsReceiptNotes,
  idempotencyKeys,
  overReceipts,
  purchaseOrderLines,
  purchaseOrders,
  skus,
} from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { createHash } from 'node:crypto';
import { recordServerRejectedOpInTx } from '../tenancy/server-rejected-op';
import {
  DEFAULT_RECEIVING_POLICY,
  departedClientsInTx,
  getClientLabelsInTx,
  getClientsInTx,
  receivingPoliciesInTx,
  shareLockClientInTx,
  type ClientReceivingPolicy,
} from '../clients/clients.facade';
import { QC_RECEIPT_PLACED_EVENT, QcCommand } from './qc.command';
// Story 1-6d — licence enforcement: compliance's FREE functions (never its
// Nest module — compliance forward-references inbound, so it would cycle).
import { licenceCoverageInTx, licenceEnforcedInTx, type LicenceParty } from '../compliance/licence-enforcement';
import { missingLicencePhrase, needsOf, type LicenceHolder, type LicenceNeed } from '../../shared/primitives/licence';
import {
  MAX_QUANTITY_MILLI,
  QUANTITY_SCALE,
  assertExactQuantity,
  assertRecordableQuantity,
  fromMilli,
  signedQuantity,
} from '../../shared/primitives/quantity';
import { uomPrecision } from '../catalog/uom';
import {
  MAX_HANDLING_UNITS_PER_REQUEST,
  assertCatchWeightGrams,
} from '../catalog/handling-unit';
import type { CreateHandlingUnitInput } from '../catalog/catalog.facade';
import { assertUtcIso, isIsoDate, istDateOf, istMidnightOf, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertDeviceOperatorInTx } from '../tenancy/device-operator';
import { ensureReceivingBinInTx } from '../tenancy/receiving-bin';
import { assertWarehouseInTenant, getMemberRoleIn, getWarehouseCodeInTx } from '../tenancy/tenancy.service';
import { assertPermission } from '../tenancy/permissions';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { CatalogFacade } from '../catalog/catalog.facade';
import { kitCannotHoldStock } from '../catalog/kit.store';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { LedgerMovement } from '../inventory/inventory.facade';
import { canonicalInstant } from '../../shared/primitives/time';
import {
  RECEIVABLE_ASN_STATUSES,
  TERMINAL_ASN_STATUSES,
  asnNotFound,
  asnNotOpen,
  deriveAsnStatusInTx,
  type AsnStatus,
} from './asn.command';

// ── command inputs ────────────────────────────────────────────────────────────

/** The fixed blind-receive reason enum (the I/O matrix — 400 outside it). */
export const BLIND_REASON_CODES = ['unannounced-delivery', 'po-not-found', 'other'] as const;
export type BlindReasonCode = (typeof BLIND_REASON_CODES)[number];

/** One received (sku, batch) line of a `grn.submit`. */
export interface GrnLineInput {
  /** The PO line received against — null on a blind receipt's lines. */
  readonly poLineId: string | null;
  /**
   * Story 21-6 — the ASN line received against. Optional on the wire AND on
   * a stored pre-21-6 payload (the replay rebuild passes lines through raw),
   * so the command normalises it to `asnLineId ?? null` before validation.
   * Hashed only when present (`?? undefined`), so every pre-21-6 PO or blind
   * op hashes byte-for-byte as before.
   */
  readonly asnLineId?: string | null | undefined;
  readonly skuId: string;
  /** Catalog batch code (required for batch-tracked SKUs, forbidden otherwise). */
  readonly batchCode: string | null;
  /** Optional batch mfg date (ISO-8601 UTC). */
  readonly mfgDate: string | null;
  /**
   * Story 1-2b — the batch's expiry date as the label states it: an IST
   * CALENDAR DATE `YYYY-MM-DD` (never an instant). Optional on the wire AND
   * on a stored older payload, so the command normalises it to
   * `expiryDate ?? null`; hashed only when present (`?? undefined`), so every
   * queued older op hashes byte-for-byte as before. A malformed date is a
   * whole-op 400; every RULE about it (untracked SKU, before mfg, the batch's
   * own expiry, the client's policy) is a per-line refusal.
   */
  readonly expiryDate?: string | null | undefined;
  /**
   * Physically received quantity. In the SKU's BASE UoM on the way in (story
   * 10.2 — the controller no longer scales) and in milli-units once
   * `submitGoodsReceipt` has converted it, behind its replay lookup.
   */
  readonly qty: number;
  /**
   * Story 10.3 — catch weight: ONE captured weight, in integer GRAMS, per
   * physical unit on this line. Required for a `catch_weight_tracked` SKU,
   * forbidden for every other SKU, and `weightsGrams.length` must equal `qty`
   * — one weight per unit is the whole contract.
   *
   * It is **never a quantity**: it is not scaled, not compared against
   * `quantity_delta`, and never reaches the ATP path. Six cases of beef are
   * quantity `6` and six weights of ~18,400 g each.
   */
  readonly weightsGrams: readonly number[] | null;
}

export interface SubmitGoodsReceiptCommand {
  readonly tenantId: string;
  readonly deviceId: string;
  /** The badge-in operator — authority is re-read from the DB at command entry. */
  readonly operatorUserId: string;
  readonly warehouseId: string;
  /** Null on an ASN or blind receipt. Exactly one of poId / asnId / blindReasonCode. */
  readonly poId: string | null;
  /**
   * Story 21-6 — the advance shipment notice received against. Optional (a
   * stored pre-21-6 payload has none); hashed only when present.
   */
  readonly asnId?: string | null | undefined;
  readonly blindReasonCode: string | null;
  /**
   * Story 1-1 — the client a BLIND receipt is for (a PO or ASN receipt takes
   * its document's client; naming one beside `poId`/`asnId` is a 400).
   * Optional: an older build sends none, and the client is then derived from
   * the first line's SKU. Hashed only when present.
   */
  readonly clientId?: string | null | undefined;
  /** Device time (AD-1) — the ledger events' and GRN's business time. */
  readonly occurredAt: string;
  readonly lines: readonly GrnLineInput[];
  /**
   * Story 1-2b (decision 5) — a reviewer accepted a `grn.shelf-life-refused`
   * row: the shelf-life rule is WAIVED for this re-run only (departed,
   * tolerance, QC, the document state and late receipts apply as on any
   * receipt). Set ONLY by the review queue's apply arm — never on the HTTP
   * DTO — and hashed when present.
   */
  readonly shelfLifeWaiver?: { readonly byUserId: string; readonly note: string } | undefined;
  /**
   * Story 1-6d (decision 9) — an owner accepted a `grn.licence-refused` row:
   * the licence check is SKIPPED for this re-run only (every other rule
   * applies). Set ONLY by the review queue's apply arm — never on the HTTP
   * DTO — and hashed (as the fact, `licenceWaived: true`) when present.
   */
  readonly licenceWaiver?: { readonly byUserId: string; readonly note: string } | undefined;
}

export interface DecideOverReceiptCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly overReceiptId: string;
  readonly decision: 'approve' | 'reject';
}

// ── snapshots ─────────────────────────────────────────────────────────────────

/** One GRN line as every surface returns it — physical + applied + excess. */
export interface GoodsReceiptLineSnapshot {
  readonly id: string;
  readonly grnId: string;
  /** Null on a blind receipt's lines, an ASN receipt's, and an unmatched line. */
  readonly poLineId: string | null;
  /** Story 21-6 — the ASN line credited; present only when one was. */
  readonly asnLineId?: string;
  readonly skuId: string;
  /** The catalog batch identity — null on non-batch-tracked SKUs. */
  readonly batchId: string | null;
  readonly batchCode: string | null;
  /** Physical truth: everything that arrived. */
  readonly qty: number;
  /** The within-open portion that applied immediately (ledger + received_qty). */
  readonly appliedQty: number;
  /** The excess pended for approval (0 unless over-received). */
  readonly excessQty: number;
  /**
   * Story 1-2b — the part of `appliedQty` past the open quantity that booked
   * within the client's receiving tolerance. Present only when > 0, so a
   * receipt under the default policy is byte-identical.
   */
  readonly toleranceQty?: number;
  /**
   * Story 10.3: the handling units this line produced, in creation order —
   * present only on a catch-weight line. These ids are what a unit label is
   * printed with and what the pack bench scans back, so the receipt response
   * is where they have to surface.
   */
  readonly handlingUnitIds?: readonly string[];
}

/**
 * The per-line refusal codes. Story 1-1 adds `sku-client-mismatch`: a BLIND
 * receipt's line whose SKU belongs to another client than the receipt's
 * (§7g — the rest settles; the refused lines go to review, Discard only).
 * Story 1-2a adds `client-departed`: a line of ANY receipt (PO, ASN or
 * blind, `clientId` sent or not) whose SKU's client has departed — refused
 * the same way until an owner reactivates the client.
 */
export const REJECTED_GRN_LINE_CODES = [
  'po-line-not-found',
  'po-line-not-open',
  'asn-line-not-found',
  'sku-client-mismatch',
  'client-departed',
  // Story 1-2b — the expiry rules, each a PER-LINE refusal (§7g — a stale
  // snapshot can trip any of them, so never a whole-op 400).
  'expiry-on-untracked',
  'expiry-before-mfg',
  'batch-expiry-mismatch',
  'expiry-required',
  'shelf-life-short',
  // Story 1-6d — enforcement on, and no valid client and site licence
  // covers the line's drug or food goods on the receipt's IST date. Its own
  // review row (`grn.licence-refused` — an owner may Apply with a note).
  'licence-not-covered',
] as const;
export type RejectedGrnLineCode = (typeof REJECTED_GRN_LINE_CODES)[number];

/**
 * The per-line refusals split off before every other per-line rule: the two
 * client-level ones (1-1, 1-2a) and story 1-2b's five expiry ones. Every
 * code but `shelf-life-short` goes to the `grn.lines-refused` review row
 * (Discard only); `shelf-life-short` goes to its own `grn.shelf-life-refused`
 * row (Apply with a note, or Discard).
 */
type LineRefusalCode =
  | 'sku-client-mismatch'
  | 'client-departed'
  | 'expiry-on-untracked'
  | 'expiry-before-mfg'
  | 'batch-expiry-mismatch'
  | 'expiry-required'
  | 'shelf-life-short'
  | 'licence-not-covered';
interface ClientRefusedLine {
  readonly index: number;
  readonly line: GrnLineInput;
  readonly code: LineRefusalCode;
  /**
   * Story 1-2b — the expiry the rule judged (the line's own, or — for
   * `expiry-required` / `shelf-life-short` — the effective one: the line's,
   * else its batch's); null when none.
   */
  readonly expiryDate?: string | null;
  /** Story 1-2b — `shelf-life-short` only: the client's minimum (0 when none — an expired batch). */
  readonly minShelfLifeDays?: number;
  /** Story 1-2b — `shelf-life-short` only: IST days from the receipt's date to the expiry. */
  readonly remainingDays?: number;
  /** Story 1-6d — `licence-not-covered` only: each need no valid licence covers, and which holder lacks it. */
  readonly missing?: readonly MissingLicence[];
  /** Story 1-6d — `licence-not-covered` only: the receipt's site code (the refusal names it). */
  readonly siteCode?: string;
}

/** Story 1-6d — one need of a refused line that no valid licence covers, and the holder lacking it. */
export interface MissingLicence {
  readonly need: LicenceNeed;
  readonly holder: LicenceHolder;
}

/**
 * Story 1-2b — the `grn.lines-refused` row's `problemCode` when its lines
 * carry several codes: the departure keeps winning, as before 1-2b.
 */
export const LINES_REFUSED_CODE_PRECEDENCE = [
  'client-departed',
  'sku-client-mismatch',
  'batch-expiry-mismatch',
  'expiry-before-mfg',
  'expiry-on-untracked',
  'expiry-required',
] as const satisfies readonly LineRefusalCode[];

/** Story 1-2b — the expiry codes (the refusal entries of these carry the line's identity). */
const EXPIRY_REFUSAL_CODES: ReadonlySet<LineRefusalCode> = new Set([
  'expiry-on-untracked',
  'expiry-before-mfg',
  'batch-expiry-mismatch',
  'expiry-required',
  'shelf-life-short',
]);

/** One line the server refused to settle (naming the reason — the other lines settle). */
export interface RejectedGrnLine {
  /** Null on an ASN line's rejection (story 21-6). */
  readonly poLineId: string | null;
  /** Story 21-6 — present only on an ASN line's rejection (`asn-line-not-found`). */
  readonly asnLineId?: string;
  readonly skuId: string;
  readonly qty: number;
  readonly code: string;
  readonly reason: string;
  /**
   * Story 1-2b — present only on an EXPIRY refusal (the five 1-2b codes), so
   * every older entry — and every entry stored before 1-2b — is unchanged:
   * the line's index in the request, its batch code, the expiry judged and
   * (`shelf-life-short` only) the client's minimum remaining life.
   */
  readonly index?: number;
  readonly batchCode?: string | null;
  readonly expiryDate?: string | null;
  readonly minShelfLifeDays?: number;
  /**
   * Story 1-6d — present only on a `licence-not-covered` refusal (which also
   * carries `index`): each need no valid licence covers on the receipt's IST
   * date, and which holder — the client brand or the site — lacks it.
   */
  readonly missing?: readonly MissingLicence[];
}

/**
 * Story 21-6 — why a line settled UNMATCHED: applied in full with no line
 * reference, no ceiling and no over-receipt, so goods that arrived always
 * reach the ledger (zero-scan-loss) while the document line is not credited.
 */
export const UNMATCHED_LINE_REASONS = ['no-line-reference', 'line-sku-mismatch'] as const;
export type UnmatchedLineReason = (typeof UNMATCHED_LINE_REASONS)[number];

/** One request line (by its index in `lines`) that settled unmatched. */
export interface UnmatchedGrnLine {
  readonly index: number;
  readonly reason: UnmatchedLineReason;
}

/** The GRN as every surface returns it (the idempotency snapshot). */
export interface GoodsReceiptSnapshot {
  readonly goodsReceipt: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly code: string;
    /**
     * The PO booked against. Story 21-9: on a receipt against a closed PO
     * that was RE-TARGETED, this is the open successor, not the PO the
     * device named.
     */
    readonly poId: string | null;
    /** Story 21-9 — the successor's code, present only on a re-targeted receipt. */
    readonly poCode?: string;
    /** Story 21-6 — present only on an ASN receipt (a pre-21-6 snapshot is byte-identical). */
    readonly asnId?: string;
    readonly asnCode?: string;
    /**
     * Story 1-1 — the client whose goods the receipt booked. OPTIONAL: a
     * snapshot stored before 1-1 replays without it (§9).
     */
    readonly clientId?: string;
    readonly blindReasonCode: string | null;
    readonly status: string;
    readonly deviceId: string;
    readonly recordedBy: string;
    readonly occurredAt: string;
    readonly recordedAt: string;
    readonly lines: readonly GoodsReceiptLineSnapshot[];
    /** Present only when the submit rejected some lines (partial settlement). */
    readonly rejectedLines?: readonly RejectedGrnLine[];
    /** Story 21-6 — present only when some lines of a PO/ASN receipt settled unmatched. */
    readonly unmatchedLines?: readonly UnmatchedGrnLine[];
    /**
     * Story 1-1 — the review row raised for the `sku-client-mismatch` lines
     * (its op id, derived from the key); present only when one was raised.
     */
    readonly reviewOpId?: string;
    /**
     * Story 1-2b — the `grn.shelf-life-refused` review row raised for the
     * `shelf-life-short` lines (its op id, derived from the key with its own
     * salt); present only when one was raised.
     */
    readonly shelfLifeReviewOpId?: string;
    /**
     * Story 1-6d — the `grn.licence-refused` review row raised for the
     * `licence-not-covered` lines (its op id, derived from the key with its
     * own salt); present only when one was raised.
     */
    readonly licenceReviewOpId?: string;
    /**
     * Story 1-4b — the `grn.inactive-sku-received` review row raised for the
     * blind or unmatched lines of an inactive SKU this receipt BOOKED (its op
     * id, derived from the key with its own salt); present only when one was
     * raised, so an older snapshot is byte-identical.
     */
    readonly inactiveSkuReviewOpId?: string;
    /** Story 1-2b — how many booked lines were put on receipt QC holds (present only when > 0). */
    readonly qcHeldLines?: number;
    /**
     * Story 1-2b — how many booked lines of a QC-on-receipt client were NOT
     * held (serial-tracked or catch-weight — PENDING); present only when > 0.
     */
    readonly qcSkippedLines?: number;
  };
}

/**
 * Story 1-1 (decision 6) — the answer when EVERY line of a blind receipt was
 * client-refused: no receipt was recorded (no GRN code, no row, no event);
 * the lines went to review. The op still settles 201.
 */
export interface RefusedReceiptSnapshot {
  readonly goodsReceipt: null;
  readonly refusedReceipt: {
    readonly warehouseId: string;
    readonly clientId: string;
    readonly blindReasonCode: string | null;
    readonly occurredAt: string;
    readonly rejectedLines: readonly RejectedGrnLine[];
    /**
     * The `grn.lines-refused` row's op id. Story 1-2b: absent when every line
     * was refused `shelf-life-short` (only the shelf-life row was raised) —
     * a stored pre-1-2b snapshot always carries it.
     */
    readonly reviewOpId?: string;
    /** Story 1-2b — the `grn.shelf-life-refused` row's op id, when one was raised. */
    readonly shelfLifeReviewOpId?: string;
    /** Story 1-6d — the `grn.licence-refused` row's op id, when one was raised. */
    readonly licenceReviewOpId?: string;
  };
}

/** One pending/decided over-receipt of the Conflicts & Reviews surface. */
export interface OverReceiptEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly grnId: string;
  readonly grnCode: string;
  readonly grnLineId: string;
  readonly poId: string | null;
  readonly poLineId: string | null;
  /** Story 21-6 — present only on an ASN receipt's over-receipt. */
  readonly asnId?: string;
  readonly asnLineId?: string;
  readonly asnCode?: string;
  readonly skuId: string;
  readonly excessQty: number;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  /** Row creation time (the keyset cursor field) — part of the read contract. */
  readonly createdAt: string;
  /**
   * Story 1-2b — on an approval's answer only: the receipt QC hold the
   * approved excess was put on (a QC-on-receipt client). Absent otherwise.
   */
  readonly qcHoldId?: string;
}

/** The decide response (the idempotency snapshot). */
export interface OverReceiptDecisionSnapshot {
  readonly overReceipt: OverReceiptEntry;
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * The line-quantity ceiling, in milli-units (story 10.1). The column is
 * `bigint`, so the binding limit is no longer int4 but the 2⁵³ exact-integer
 * ceiling every quantity crosses in JavaScript and in Lua — a larger (but
 * typable) quantity must be a 400, never an insert-time 500 or a silent
 * rounding.
 */
export const MAX_GRN_LINE_QTY = MAX_QUANTITY_MILLI;

/**
 * Story 10.3 — the ceiling on handling units one GRN line may declare. One
 * weight per unit means the array length IS the unit count, so an unbounded
 * array is an unbounded request body on a device endpoint; 500 cases on one
 * line is already a full pallet several times over. A typed 400 is the
 * boundary, the `MAX_SCAN_LINES` precedent.
 */
export const MAX_HANDLING_UNITS_PER_GRN_LINE = 500;

/**
 * Story 21-9 — how far a receipt against a closed PO walks its carry-forward
 * chain looking for an open successor. Each close mints at most one
 * successor, so ten closes deep is far past any real chain; the bound keeps a
 * corrupt (cyclic) chain from looping.
 */
export const MAX_SUCCESSOR_HOPS = 10;

/** GRN codes are `GRN-<n>`, zero-padded to 4 digits, unique per tenant. */
function grnCode(n: number): string {
  return `GRN-${String(n).padStart(4, '0')}`;
}

/** One over-receipt request collected during settlement (row insert pending). */
interface OverReceiptRequest {
  readonly grnLineId: string;
  /** Exactly one document pair is set (story 21-6, `over_receipts_document_pair`). */
  readonly poId: string | null;
  readonly poLineId: string | null;
  readonly asnId: string | null;
  readonly asnLineId: string | null;
  readonly skuId: string;
  readonly excessQty: number;
}

/**
 * The receipt path (Story 3.3): `grn.submit` (device-authenticated, mirroring
 * `selfTestEcho`) and the over-receipt decisions (`review.decide`), following
 * the established command invariant order inside `withTenantTransaction` —
 * authority (device re-read fail-closed / fresh DB role read) → idempotency
 * replay lookup → master-data asserts → write → in-tx outbox append →
 * idempotency-key insert with payload hash + response snapshot.
 *
 * The GRN records **physical truth** (the full received quantity per line);
 * only the within-open-qty portion applies immediately (one `grn.received`
 * ledger event per line + the PO line's `received_qty` bump, same
 * transaction); the excess lands as a pending `over_receipts` row + outbox
 * event for Ops Manager approval. Batch identity is created through the
 * catalog facade's in-transaction ensure (never a direct `batches` write);
 * stock lands in the warehouse's system Receiving bin (ensured through
 * tenancy's receiving-bin helper — bin master data stays tenancy-owned).
 * Document state is re-checked at server write time, under the document lock.
 * Story 21-9: a receipt against a TERMINAL document (a closed PO, a cancelled
 * or closed ASN) is accepted and HELD — every line pends as an over-receipt
 * against that document (with its line when it matches one, else none) for
 * an operator to approve or reject; a closed PO with an open successor is
 * re-targeted to the successor, where close moved the open quantity. Nothing
 * a device scanned is refused for its document's state.
 */
@Injectable()
export class ReceivingCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition happens at the command layer through the
    // facades only (AD-6): batch identity via catalog, ledger events and the
    // projections via the inventory facade's in-transaction passthrough.
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    // Story 1-2b — the receipt-scoped QC hold (this module's own command).
    @Inject(QcCommand) private readonly qc: QcCommand,
  ) {}

  /**
   * `grn.submit` — the substrate's first real op. The whole GRN is ONE
   * idempotent server command: device row re-read fail-closed (active +
   * badge-bound), operator role re-read from the DB (accountant → 403
   * `role-denied`; the token is transport, never authority — AD-10), then the
   * invariant order. Idempotent per client ULID (`Idempotency-Key` = the
   * queued op's id), so offline replay settles exactly once.
   */
  async submitGoodsReceipt(
    command: SubmitGoodsReceiptCommand,
    idempotencyKey: string,
  ): Promise<GoodsReceiptSnapshot | RefusedReceiptSnapshot> {
    // ── story 10.2: this fingerprint is over BASE units ────────────────────
    // Conversion moved out of the controller and into the command, behind the
    // replay lookup, so the hashed value changed with it: a key written by a
    // pre-10.2 build hashed MILLI-units and now answers 422
    // `idempotency-key-reuse` rather than replaying. Accepted deliberately
    // under the pre-launch premise — the same call story 10.1 made about the
    // ledger hash chain — and pinned as EXPECTED by the cross-version replay
    // guard in `test/picking.spec.ts`, so it is a recorded break and not a
    // surprise. No compatibility branch exists; there is nothing to be
    // compatible with.
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      deviceId: command.deviceId,
      operatorUserId: command.operatorUserId,
      warehouseId: command.warehouseId,
      poId: command.poId,
      // ── story 21-6: ADDITIVE, the 10.3 `weightsGrams` precedent ─────────
      // The hash is built from THIS hand-assembled object, where JSON drops
      // `undefined` but keeps `null`. `?? undefined` makes an absent (or
      // null) ASN reference vanish, so every queued pre-21-6 PO or blind op
      // hashes byte-for-byte as before and still replays (a literal pinned
      // in `test/asn.spec.ts`); an always-present `null` key would answer
      // every one of them 422 `idempotency-key-reuse`.
      asnId: command.asnId ?? undefined,
      blindReasonCode: command.blindReasonCode,
      // ── story 1-1: ADDITIVE, the same `?? undefined` rule ───────────────
      // A blind receipt's client is hashed only when present, so a queued
      // older blind op (no client) hashes byte-for-byte as before — pinned by
      // a literal golden in `test/per-client-sku.spec.ts`.
      clientId: command.clientId ?? undefined,
      // ── story 1-2b: ADDITIVE, the same `?? undefined` rule ─────────────
      // Set only by the review queue's apply arm (decision 5), so every
      // device op hashes exactly as before; a re-run under the waiver is a
      // different command than one without it. Only the FACT of the waiver
      // is hashed — never the reviewer or the note — so a retried Accept by
      // another reviewer (or with an edited note) after the re-run committed
      // replays rather than answering 422 forever.
      shelfLifeWaived: command.shelfLifeWaiver === undefined || command.shelfLifeWaiver === null ? undefined : true,
      // ── story 1-6d: ADDITIVE, the same `?? undefined` rule ─────────────
      // Set only by the `grn.licence-refused` apply arm: every device op and
      // every shelf-life Apply hashes exactly as before; only the FACT of
      // the waiver is hashed, so a retried Apply by another owner (or with
      // another note) after the re-run committed replays.
      licenceWaived: command.licenceWaiver === undefined || command.licenceWaiver === null ? undefined : true,
      occurredAt: command.occurredAt,
      lines: command.lines.map((line) => ({
        poLineId: line.poLineId,
        asnLineId: line.asnLineId ?? undefined,
        skuId: line.skuId,
        batchCode: line.batchCode,
        mfgDate: line.mfgDate,
        // Story 1-2b — the line's expiry (an IST date), only when present:
        // a queued older op (no key) hashes byte-for-byte as before (golden
        // in `test/client-receiving-policy.spec.ts`).
        expiryDate: line.expiryDate ?? undefined,
        qty: line.qty,
        // Story 10.3 — ADDITIVE and in the operator's own order. `null`
        // normalizes to `undefined`, which `JSON.stringify` drops, so a
        // non-catch-weight receipt hashes byte-identically to its pre-10.3
        // shape and keys already in flight still replay. The weights are NOT
        // sorted: unlike pack's scan (where A,B,C and C,B,A are the same
        // physical act), the order here is the order the operator weighed the
        // cases in, and unit i of the line IS weight i.
        weightsGrams: line.weightsGrams ?? undefined,
      })),
    });

    // ── story 10.3: the catch-weight SHAPE check, ABOVE the transaction ────
    // It needs no database row — an array length against a declared unit
    // count, and each element's own bounds — so it belongs in the top tier
    // (`IMPLEMENTATION-GUIDE.md` §1): a malformed request must answer 400
    // whether or not its key was used before. The FLAG-dependent half (this
    // SKU requires weights / must not carry them) needs the SKU row and
    // therefore runs behind the replay lookup, below.
    // ── story 21-6: normalise the optional fields BEFORE validation ──────
    // A stored payload re-applied through the sync-report rebuild passes its
    // lines through RAW: a pre-21-6 op carries no `asnId` and no
    // `asnLineId`, and a device may have omitted any optional key (the
    // weights, the batch fields) rather than sending null. Every rule below
    // reads the normalised form, so an absent key means exactly what null
    // means — an old op re-applies cleanly. The HASH above is untouched: it
    // was computed over the command as received.
    const asnId = command.asnId ?? null;
    const requestedClientId = command.clientId ?? null;
    const inputLines: readonly GrnLineInput[] = command.lines.map((line) => ({
      ...line,
      poLineId: line.poLineId ?? null,
      asnLineId: line.asnLineId ?? null,
      batchCode: line.batchCode ?? null,
      mfgDate: line.mfgDate ?? null,
      expiryDate: line.expiryDate ?? null,
      weightsGrams: line.weightsGrams ?? null,
    }));
    assertWeightShape(inputLines);

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── device re-authorization (fail-closed, the selfTestEcho mirror) ──
      // The device row (locked, active, badge-bound) and the operator's
      // CURRENT floor role — tenancy's exported guard (story 13-2 moved the
      // body there, unchanged, so the returns module runs the same one).
      await assertDeviceOperatorInTx(tx, command.tenantId, command.deviceId, command.operatorUserId);

      // ── idempotency replay (before any write) ───────────────────────────
      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.tenantId, command.tenantId), eq(idempotencyKeys.key, idempotencyKey)),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].payloadHash !== payloadHash) {
          throw idempotencyKeyReuse();
        }
        return existing[0].responseSnapshot as GoodsReceiptSnapshot | RefusedReceiptSnapshot;
      }

      // ── input validation (400 before any write) ────────────────────────
      if (inputLines.length === 0) {
        throw grnValidation('A goods receipt needs at least one line.');
      }
      if (inputLines.length > 200) {
        throw grnValidation(`A goods receipt carries at most 200 lines (got ${inputLines.length}).`);
      }
      const occurredAt = assertUtc(command.occurredAt, 'occurredAt');
      const blindReasonCode = this.validateDocumentPairing(command.poId, asnId, command.blindReasonCode);
      // Story 1-1: a client is named only on a BLIND receipt — a PO or an ASN
      // receipt takes its document's client.
      if (requestedClientId !== null && blindReasonCode === null) {
        throw grnValidation(
          'A receipt against a purchase order or an advance shipment notice takes its document\'s client — clientId is named only on a blind receipt.',
        );
      }
      if (requestedClientId !== null && !UUID_RE.test(requestedClientId)) {
        throw grnValidation('clientId must be a uuid.');
      }
      for (const line of inputLines) {
        // Story 10.2: `line.qty` is in BASE units here — shape and range only.
        // Whether the SKU's own unit may express this many decimals is asked
        // below, once `loadSkus` has read the units, and therefore behind the
        // replay lookup above.
        if (!(line.qty > 0)) {
          throw grnValidation(`Line quantity must be a positive quantity (got ${String(line.qty)}).`);
        }
        if (line.qty > fromMilli(MAX_GRN_LINE_QTY)) {
          throw grnValidation(
            `Line quantity must be at most ${fromMilli(MAX_GRN_LINE_QTY)} (got ${String(line.qty)}).`,
          );
        }
        if (line.mfgDate !== null) {
          assertUtc(line.mfgDate, 'mfgDate');
        }
        // Story 1-2b — a malformed expiry is a whole-op 400, as a malformed
        // instant is: it is the request's shape, not a rule a stale snapshot
        // can trip. Every RULE about the date is a per-line refusal below.
        if (line.expiryDate !== null && line.expiryDate !== undefined && (typeof line.expiryDate !== 'string' || !isIsoDate(line.expiryDate) || !/^2[01]\d\d-/.test(line.expiryDate))) {
          // Years 2000–2199 only: a year 0000/0001 would reach
          // `istMidnightOf` and fail in Postgres (a 500), never a label's date.
          throw grnValidation(
            `expiryDate must be a calendar date YYYY-MM-DD between 2000 and 2199 (the label's date, read in IST) — got "${String(line.expiryDate)}".`,
          );
        }
        // Story 21-6: a line reference names a line of THE document — a
        // `poLineId` only beside `poId`, an `asnLineId` only beside `asnId`.
        if (command.poId === null && line.poLineId !== null) {
          throw grnValidation(
            asnId === null
              ? 'A blind receipt carries no PO line references.'
              : 'A receipt against an advance shipment notice carries no PO line references.',
          );
        }
        if (asnId === null && line.asnLineId !== null) {
          throw grnValidation(
            command.poId === null
              ? 'A blind receipt carries no ASN line references.'
              : 'A receipt against a purchase order carries no ASN line references.',
          );
        }
      }

      // Master-data integrity in the write transaction: warehouse in tenant,
      // every line's SKU in tenant (404 before any write).
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      const skuById = await this.loadSkus(
        tx,
        command.tenantId,
        inputLines.map((line) => line.skuId),
      );

      // ── story 1-1: a BLIND receipt that names its client ────────────────
      // The client must exist (404; story 1-2a: any status — see below). A line
      // whose SKU belongs to another client is refused PER LINE
      // (`sku-client-mismatch`, §7g): it is split off HERE, before every
      // per-line rule below (kit, catch weight, precision, batch identity),
      // so a refused line can never fail the whole op. An op WITHOUT
      // `clientId` (an older build — decision 7) refuses nothing for client.
      // A PO or ASN receipt refuses nothing for client either (decision 4).
      const clientRefused: ClientRefusedLine[] = [];
      let namedBlindClientId: string | null = null;
      let clientLabels = new Map<string, string>();
      if (blindReasonCode !== null && requestedClientId !== null) {
        // The named client must exist (404), read under FOR SHARE. Story
        // 1-2a: its status no longer refuses the receipt whole — a SUSPENDED
        // client still ships and receives (decision 5), and a DEPARTED one's
        // lines are refused per line below (`client-departed`, decision 7;
        // every line refused → the `goodsReceipt: null` arm).
        await shareLockClientInTx(tx, command.tenantId, requestedClientId);
        namedBlindClientId = requestedClientId;
      }
      // ── story 1-2a (decision 7): a DEPARTED client's lines, any receipt ──
      // Whatever document the goods arrive on, and whether or not the op
      // names a client, a line whose SKU's client has departed is refused
      // per line (`client-departed`) and goes to review — re-received after
      // an owner reactivates the client. Read under FOR KEY SHARE, so a
      // departure cannot commit between this read and the booking.
      const departedClients = await departedClientsInTx(
        tx,
        command.tenantId,
        inputLines.map((line) => skuById.get(line.skuId)!.clientId),
      );
      for (const [index, line] of inputLines.entries()) {
        const skuClientId = skuById.get(line.skuId)!.clientId;
        if (departedClients.has(skuClientId)) {
          clientRefused.push({ index, line, code: 'client-departed' });
        } else if (namedBlindClientId !== null && skuClientId !== namedBlindClientId) {
          clientRefused.push({ index, line, code: 'sku-client-mismatch' });
        }
      }

      // ── story 1-2b: the receiving policies and the expiry rules ─────────
      // Read ONCE, here — beside the departed read, before any document
      // lock (the lock order stays "client first"). Expiry and QC use each
      // line's OWN SKU client; tolerance uses the document's, which is the
      // same client (a matched document line has the line's SKU). A receipt
      // reads the policy committed when it reads it (no serialisation
      // against an edit). Each expiry rule is a PER-LINE refusal, evaluated
      // with the client refusals, before the all-refused arm, the batch
      // ensure and settlement — a refused line creates no batch.
      const policyByClient = await receivingPoliciesInTx(
        tx,
        command.tenantId,
        inputLines.map((line) => skuById.get(line.skuId)!.clientId),
      );
      const policyOfSku = (skuId: string): ClientReceivingPolicy =>
        policyByClient.get(skuById.get(skuId)!.clientId) ?? DEFAULT_RECEIVING_POLICY;
      const expiryPhase = await this.expiryRefusalsInTx(tx, command.tenantId, {
        inputLines,
        alreadyRefused: new Set(clientRefused.map((entry) => entry.index)),
        skuById,
        policyOfSku,
        receiptDate: istDateOf(occurredAt),
        waived: command.shelfLifeWaiver !== undefined && command.shelfLifeWaiver !== null,
      });
      clientRefused.push(...expiryPhase.refused);
      clientRefused.sort((a, b) => a.index - b.index);
      if (clientRefused.length > 0) {
        clientLabels = await getClientLabelsInTx(tx, command.tenantId, [
          ...(namedBlindClientId === null ? [] : [namedBlindClientId]),
          ...clientRefused.map((entry) => skuById.get(entry.line.skuId)!.clientId),
        ]);
      }
      /**
       * The client a refused-lines review row (and a wholly refused receipt)
       * names: the blind receipt's named client, else the first refused
       * line's own client (every such line is a departed client's).
       */
      let refusalClientId =
        namedBlindClientId ?? (clientRefused.length > 0 ? skuById.get(clientRefused[0]!.line.skuId)!.clientId : null);
      const refusedIndexes = new Set(clientRefused.map((entry) => entry.index));
      /** The request index of each receivable line (unmatchedLines name request indexes). */
      const receivableIndexes = inputLines.map((_, index) => index).filter((index) => !refusedIndexes.has(index));
      const receivableInput = receivableIndexes.map((index) => inputLines[index]!);

      // ── story 11.4: a kit SKU never receives stock (FR-38) ──────────────
      // A kit's stock IS its components' — a GRN line against a kit SKU
      // would invent independent stock the explosion never sees. The
      // kit-ness answer is one facade lookup (catalog owns
      // `kit_compositions`); the 409 names the offending SKUs.
      const kitSkuIds = await this.catalog.getKitSkuIdsInTx(
        tx,
        command.tenantId,
        receivableInput.map((line) => line.skuId),
      );
      if (kitSkuIds.length > 0) {
        throw kitCannotHoldStock(
          'GRN line',
          kitSkuIds.map((skuId) => skuById.get(skuId)!.code),
        );
      }

      // ── story 10.3: the catch-weight FLAG rules, behind the replay ──────
      // These need the SKU row, so they sit here rather than in the shape
      // tier above: a catch-weight SKU must carry one weight per unit, and
      // every other SKU must carry none. Both directions fail CLOSED — a
      // weight list silently ignored on a non-catch-weight SKU would be a
      // weight the operator recorded and the system threw away.
      for (const line of receivableInput) {
        const sku = skuById.get(line.skuId)!;
        if (sku.catchWeightTracked) {
          if (sku.serialTracked) {
            // Refused at catalog entry (`sku.command.ts` / `import.command.ts`);
            // this is the backstop for a row that predates the rule or was
            // written by some other path. Two per-unit identity systems over
            // one physical unit is its own change.
            throw grnValidation(
              `SKU "${sku.code}" is both catch-weight tracked and serial-tracked — two per-unit identity systems over one unit are not supported. Clear one of the two flags.`,
            );
          }
          if (line.weightsGrams === null || line.weightsGrams.length === 0) {
            throw grnValidation(
              `SKU "${sku.code}" is catch-weight tracked — every unit received needs its own captured weight, so the line must carry ${String(line.qty)} weight(s) in weightsGrams (got none).`,
            );
          }
        } else if (line.weightsGrams !== null) {
          throw grnValidation(
            `SKU "${sku.code}" is not catch-weight tracked — weightsGrams is meaningless for it and is refused rather than ignored.`,
          );
        }
      }

      // ── story 10.2: conversion and the precision refusal, HERE ──────────
      // Behind the replay lookup and with each line's unit in hand. Below
      // this point every quantity is milli-units; `command.lines` is not read
      // for a quantity again.
      const convertedLines: readonly GrnLineInput[] = receivableInput.map((line) => {
        const uom = skuById.get(line.skuId)!.uom;
        return {
          ...line,
          qty: assertRecordableQuantity(line.qty, 'qty', uom, uomPrecision(uom)),
        };
      });

      // ── story 1-6d: the licence phase (decisions 3, 9) ──────────────────
      // AFTER every whole-op shape check (kit, catch weight, precision), so
      // a malformed line still fails the whole op as today and a licence-
      // refused line has passed every shape check — its Apply cannot fail on
      // shape. BEFORE the batch ensure: a refused line creates no batch. It
      // judges only the lines still receivable (every client- or expiry-
      // refused line is skipped — one line is never in two rows), each by its
      // SKU's client and this receipt's site, on the receipt's IST date (the
      // 1-2b precedent: a receipt is judged when it happened). Skipped when
      // enforcement is off (the response is byte-identical to before) and on
      // a re-run under an owner's licence waiver.
      const licenceRefusedIndexes = new Set<number>();
      if (
        (command.licenceWaiver === undefined || command.licenceWaiver === null) &&
        receivableIndexes.some((index) => needsOf(skuById.get(inputLines[index]!.skuId)!).length > 0) &&
        (await licenceEnforcedInTx(tx, command.tenantId))
      ) {
        const goodsSkuIds = [...new Set(receivableIndexes.map((index) => inputLines[index]!.skuId))].filter(
          (skuId) => needsOf(skuById.get(skuId)!).length > 0,
        );
        const clientFacts = await getClientsInTx(
          tx,
          command.tenantId,
          goodsSkuIds.map((skuId) => skuById.get(skuId)!.clientId),
        );
        const parties: LicenceParty[] = goodsSkuIds.map((skuId) => {
          const sku = skuById.get(skuId)!;
          return {
            clientId: sku.clientId,
            systemOwned: clientFacts.get(sku.clientId)?.systemOwned === true,
            skuCode: sku.code,
            needs: needsOf(sku),
          };
        });
        const uncovered = await licenceCoverageInTx(tx, {
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          date: istDateOf(occurredAt),
          parties,
        });
        if (uncovered.length > 0) {
          const missingBySku = new Map<string, MissingLicence[]>();
          for (const item of uncovered) {
            const key = `${item.clientId}|${item.skuCode}`;
            missingBySku.set(key, [...(missingBySku.get(key) ?? []), { need: item.need, holder: item.holder }]);
          }
          const siteCode = await getWarehouseCodeInTx(tx, command.tenantId, command.warehouseId);
          for (const index of receivableIndexes) {
            const line = inputLines[index]!;
            const sku = skuById.get(line.skuId)!;
            const missing = missingBySku.get(`${sku.clientId}|${sku.code}`);
            if (missing === undefined) continue;
            licenceRefusedIndexes.add(index);
            clientRefused.push({ index, line, code: 'licence-not-covered', missing, siteCode });
          }
          clientRefused.sort((a, b) => a.index - b.index);
          clientLabels = await getClientLabelsInTx(tx, command.tenantId, [
            ...(namedBlindClientId === null ? [] : [namedBlindClientId]),
            ...clientRefused.map((entry) => skuById.get(entry.line.skuId)!.clientId),
          ]);
          refusalClientId ??= skuById.get(clientRefused[0]!.line.skuId)!.clientId;
        }
      }
      // The request index of each line that settles from here on, aligned with `lines`.
      const settlingIndexes =
        licenceRefusedIndexes.size === 0 ? receivableIndexes : receivableIndexes.filter((index) => !licenceRefusedIndexes.has(index));
      const lines: readonly GrnLineInput[] =
        licenceRefusedIndexes.size === 0
          ? convertedLines
          : convertedLines.filter((_, receivableIndex) => !licenceRefusedIndexes.has(receivableIndexes[receivableIndex]!));

      // ── story 1-1 (decision 6): EVERY line client-refused → no receipt ──
      // No GRN code is consumed, no `goods_receipt_notes` row, no
      // `grn.recorded` event: every line goes to review as
      // `sku-client-mismatch` (the `grn.lines-refused` row), and the op
      // settles 201 with `{goodsReceipt: null, refusedReceipt}`.
      /**
       * Story 1-1 (decision 6) — EVERY line refused → no receipt: no GRN code
       * consumed, no header, no `grn.recorded`; the lines go to review and the
       * op settles 201 with `{goodsReceipt: null, refusedReceipt}`. Story 1-2b
       * reaches it from two places: before the document lock (the client and
       * expiry refusals), and after the batch ensure when the expiry race
       * refused every remaining line.
       */
      const settleAllRefused = async (refusalClient: string): Promise<RefusedReceiptSnapshot> => {
        const rejectedLines = this.clientRefusalLines(clientRefused, skuById, clientLabels, namedBlindClientId);
        const review = await this.raiseRefusalReviewsInTx(tx, command, idempotencyKey, {
          grnId: null,
          grnCode: null,
          clientId: refusalClient,
          clientLabels,
          blindReasonCode,
          occurredAt,
          clientRefused,
          skuById,
        });
        const refusedSnapshot: RefusedReceiptSnapshot = {
          goodsReceipt: null,
          refusedReceipt: {
            warehouseId: command.warehouseId,
            clientId: refusalClient,
            blindReasonCode,
            occurredAt,
            rejectedLines,
            // Story 1-2b — each present only when its row was raised (a
            // receipt refused only for client reasons is byte-identical).
            ...(review.reviewOpId === null ? {} : { reviewOpId: review.reviewOpId }),
            ...(review.shelfLifeReviewOpId === null ? {} : { shelfLifeReviewOpId: review.shelfLifeReviewOpId }),
            // Story 1-6d — present only when the licence row was raised.
            ...(review.licenceReviewOpId === null ? {} : { licenceReviewOpId: review.licenceReviewOpId }),
          },
        };
        // The audit row targets the review row: nothing else was written.
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.operatorUserId,
          action: 'goods_receipt.submitted',
          targetType: 'rejected_op',
          targetId: review.rejectedOpId,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });
        await tx
          .update(devices)
          .set({ lastSeenAt: nowIso(), updatedAt: nowIso() })
          .where(eq(devices.id, command.deviceId));
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, refusedSnapshot);
        return refusedSnapshot;
      };
      if (lines.length === 0 && refusalClientId !== null) {
        return settleAllRefused(refusalClientId);
      }

      // ── the receiving bin (tenancy-owned master data) ───────────────────
      const receivingBin = await ensureReceivingBinInTx(tx, command.tenantId, command.warehouseId);

      // ── the PO arm (server re-authorization at write time) ──────────────
      // Story 21-9: a receipt against a TERMINAL document is accepted and
      // held, never refused — the cartons are on the dock. Three outcomes:
      //   open PO                        → the fold as before;
      //   closed PO with an open successor (following `carried_from_po_id`)
      //                                  → RE-TARGET: booked against the
      //                                    successor, where close moved the
      //                                    open quantity (decision 5);
      //   closed PO, no open successor   → TERMINAL: every line pends as an
      //                                    over-receipt on the closed PO.
      // The warehouse check runs BEFORE the status (a terminal document of
      // another warehouse is `document-warehouse-mismatch`, deliberately).
      let po: typeof purchaseOrders.$inferSelect | null = null;
      let poLines: (typeof purchaseOrderLines.$inferSelect)[] = [];
      /** Story 21-9 — every line pends against the (terminal) document. */
      let terminal = false;
      /** Story 21-9 — the re-target arm: booked against the closed PO's open successor. */
      let retargeted = false;
      if (command.poId !== null) {
        const poRows = await tx
          .select()
          .from(purchaseOrders)
          .where(
            and(eq(purchaseOrders.id, command.poId), eq(purchaseOrders.tenantId, command.tenantId)),
          )
          .limit(1)
          .for('update');
        const poRow = poRows[0];
        if (poRow === undefined) {
          throw new ProblemException(
            'not-found',
            404,
            'Purchase order not found',
            `No purchase order with id "${command.poId}" exists in this tenant.`,
          );
        }
        // Story 21-6: a document is received only in its own warehouse.
        if (poRow.warehouseId !== command.warehouseId) {
          throw documentWarehouseMismatch(`Purchase order "${poRow.code}"`);
        }
        if (poRow.status === 'open') {
          po = poRow;
        } else if (poRow.status === 'closed') {
          const successor = await this.openSuccessorInTx(tx, command.tenantId, poRow, command.warehouseId);
          if (successor === null) {
            po = poRow;
            terminal = true;
          } else {
            // Nothing on the closed PO is read further or written.
            retargeted = true;
            po = successor;
          }
        } else {
          // Fail closed on a status this code does not know (an allow-list,
          // IMPLEMENTATION-GUIDE §4) — unreachable under the 0011 CHECK.
          throw poNotOpen(poRow.code, poRow.status);
        }
        poLines = await tx
          .select()
          .from(purchaseOrderLines)
          .where(eq(purchaseOrderLines.poId, po.id))
          .for('update');
      }

      // ── story 21-6: the ASN arm — locked exactly where the PO is ────────
      // SKUs (above) → the ASN → its lines: the same order as the PO arm and
      // as the approve arm, so a receipt, an approval and a close serialise
      // on the document row instead of deadlocking.
      let asn: typeof advanceShipmentNotices.$inferSelect | null = null;
      let asnLineRows: (typeof asnLines.$inferSelect)[] = [];
      if (asnId !== null) {
        const asnRows = await tx
          .select()
          .from(advanceShipmentNotices)
          .where(
            and(eq(advanceShipmentNotices.id, asnId), eq(advanceShipmentNotices.tenantId, command.tenantId)),
          )
          .limit(1)
          .for('update');
        const asnRow = asnRows[0];
        if (asnRow === undefined) {
          throw asnNotFound(asnId);
        }
        if (asnRow.warehouseId !== command.warehouseId) {
          throw documentWarehouseMismatch(`Advance shipment notice "${asnRow.asnCode}"`);
        }
        // Story 21-9: a cancelled or closed ASN is TERMINAL — the receipt is
        // accepted and every line pends against it (decision 1). An ASN has
        // no successor. Any other status fails closed (an allow-list).
        if (TERMINAL_ASN_STATUSES.includes(asnRow.status as AsnStatus)) {
          terminal = true;
        } else if (!RECEIVABLE_ASN_STATUSES.includes(asnRow.status as AsnStatus)) {
          throw asnNotOpen(asnRow.asnCode, asnRow.status);
        }
        asn = asnRow;
        asnLineRows = await tx
          .select()
          .from(asnLines)
          .where(eq(asnLines.asnId, asnRow.id))
          .for('update');
      }

      // ── story 1-1: the receipt's client ────────────────────────────────
      // After the document lock, warehouse and status (the document's client
      // is known only once it is in hand). A PO or ASN receipt takes its
      // document's client; a blind receipt the named client (split above),
      // or — an older build naming none (decision 7) — the single client of
      // its lines, else null (mixed lines each book to their own client).
      let receiptClientId: string | null;
      if (po !== null) {
        receiptClientId = po.clientId;
      } else if (asn !== null) {
        receiptClientId = asn.clientId;
      } else if (namedBlindClientId !== null) {
        receiptClientId = namedBlindClientId;
      } else {
        const lineClients = [...new Set(lines.map((line) => skuById.get(line.skuId)!.clientId))];
        receiptClientId = lineClients.length === 1 ? lineClients[0]! : null;
      }
      const receivable = lines;

      // ── batch identity through the catalog interface (AD-6) ────────────
      // One ensure per batch-tracked SKU (idempotent per (tenant, sku, code));
      // a batch code on a non-batch-tracked SKU, or a missing one on a
      // batch-tracked SKU, is a 400 before any write. Story 1-1: only the
      // lines that will settle (a refused line's batch is never created).
      // Story 1-2b: one input per (sku, code), carrying the receipt's merged
      // expiry; an existing batch with a NULL expiry is filled (never
      // overwritten — `fillNullExpiry`).
      const batchIdentity = await this.ensureBatchIdentity(
        tx,
        { ...command, lines: receivable },
        skuById,
        expiryPhase.batchExpiry,
      );
      // ── story 1-2b: a concurrent writer beat this receipt to the expiry ──
      // After the ensure, a batch whose resolved expiry is not the one this
      // receipt judged its lines against (another receipt filled the null
      // first) refuses those lines `batch-expiry-mismatch`, per line — never
      // a 409 (a retry replays the same input, and the device drops a 409).
      const racedLineIndexes = new Set<number>();
      for (const [receivableIndex, input] of lines.entries()) {
        if (!skuById.get(input.skuId)!.batchTracked || input.batchCode === null) {
          continue;
        }
        const key = `${input.skuId}:${input.batchCode}`;
        const expected = expiryPhase.batchExpiry.get(key) ?? null;
        if (expected === null) {
          continue;
        }
        const resolved = batchIdentity.get(key)?.expiryDate ?? null;
        if (resolved === null || istDateOf(canonicalInstant(resolved)) !== expected) {
          const index = settlingIndexes[receivableIndex]!;
          racedLineIndexes.add(index);
          clientRefused.push({ index, line: inputLines[index]!, code: 'batch-expiry-mismatch', expiryDate: input.expiryDate ?? expected });
        }
      }
      if (racedLineIndexes.size > 0) {
        clientRefused.sort((a, b) => a.index - b.index);
        clientLabels = await getClientLabelsInTx(tx, command.tenantId, [
          ...(namedBlindClientId === null ? [] : [namedBlindClientId]),
          ...clientRefused.map((entry) => skuById.get(entry.line.skuId)!.clientId),
        ]);
        refusalClientId ??= skuById.get(clientRefused[0]!.line.skuId)!.clientId;
        // Story 1-2b — the race refused every remaining line: the same
        // all-refused arm, never an empty GRN header.
        if (lines.every((_, receivableIndex) => racedLineIndexes.has(settlingIndexes[receivableIndex]!))) {
          return settleAllRefused(refusalClientId);
        }
      }

      // ── the GRN header (server-assigned code under the tenant seq lock) ──
      const grnId = uuidv7();
      const code = await this.allocateGrnCode(tx, command.tenantId);
      const recordedAt = nowIso();
      await tx.insert(goodsReceiptNotes).values({
        id: grnId,
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        code,
        poId: po?.id ?? null,
        asnId,
        // Story 1-1 — every new GRN stamps its client.
        clientId: receiptClientId,
        blindReasonCode,
        status: 'recorded',
        deviceId: command.deviceId,
        recordedBy: command.operatorUserId,
        occurredAt,
        recordedAt,
      });

      // ── settlement: within-open applies now; the excess pends ──────────
      // ONE fold for both documents (story 21-6). A document line's
      // remaining open quantity starts at `ordered|announced − received`
      // (derived, read under the line locks) and shrinks line by line, so
      // two receipt lines against the same document line settle in receipt
      // order.
      const openRemaining = new Map<string, number>();
      for (const poLine of poLines) {
        openRemaining.set(poLine.id, poLine.orderedQty - poLine.receivedQty);
      }
      for (const asnLine of asnLineRows) {
        openRemaining.set(asnLine.id, asnLine.announcedQty - asnLine.receivedQty);
      }
      const poLineById = new Map(poLines.map((line) => [line.id, line]));
      const asnLineById = new Map(asnLineRows.map((line) => [line.id, line]));

      interface SettledLine {
        readonly input: GrnLineInput;
        readonly lineId: string;
        /** The document line actually credited — null on a blind or unmatched line. */
        readonly poLineId: string | null;
        readonly asnLineId: string | null;
        readonly batchId: string | null;
        readonly batchCode: string | null;
        readonly applied: number;
        /** Story 1-2b — the within-tolerance part of `applied` (0 unless a tolerance booked excess). */
        readonly toleranceQty: number;
      }
      const settled: SettledLine[] = [];
      const rejected: RejectedGrnLine[] = [];
      const unmatched: UnmatchedGrnLine[] = [];
      const overReceiptRequests: OverReceiptRequest[] = [];
      const documentLabel =
        po !== null ? `purchase order "${po.code}"` : asn !== null ? `advance shipment notice "${asn.asnCode}"` : '';

      // Story 1-1 — the per-line refusals (client, and story 1-2b's expiry
      // rules), in request order, ahead of any document-line rejection.
      rejected.push(...this.clientRefusalLines(clientRefused, skuById, clientLabels, namedBlindClientId));
      /**
       * Story 1-2b — the tolerance ceiling still open on a document line:
       * `ordered + floor_to_uom_step(ordered × bps / 10000) − received`
       * (milli-units), started on the line's first touch and shrunk line by
       * line beside `openRemaining`. With the default policy (0 bps) it
       * equals `openRemaining`, so the fold is the pre-1-2b fold exactly.
       */
      const ceilingRemaining = new Map<string, number>();
      for (const [receivableIndex, input] of lines.entries()) {
        const index = settlingIndexes[receivableIndex]!;
        if (racedLineIndexes.has(index)) {
          continue; // story 1-2b — refused per line after the ensure (above)
        }
        const identity = batchIdentity.get(`${input.skuId}:${input.batchCode}`) ?? null;
        const base = {
          input,
          batchId: identity?.id ?? null,
          batchCode: identity?.code ?? null,
          toleranceQty: 0,
        };
        if (po === null && asn === null) {
          // Blind arm: the physical quantity applies in full (no document to gate it).
          settled.push({ ...base, lineId: uuidv7(), poLineId: null, asnLineId: null, applied: input.qty });
          continue;
        }
        /**
         * Story 21-9 — the whole line pends against the document: applied 0,
         * the physical quantity is the excess, and the GRN line names the
         * same line (or none) as its over-receipt row. Nothing reaches the
         * ledger or `received_qty` until an operator approves.
         */
        const pendWhole = (documentLineId: string | null): void => {
          const lineId = uuidv7();
          settled.push({
            ...base,
            lineId,
            poLineId: po !== null ? documentLineId : null,
            asnLineId: asn !== null ? documentLineId : null,
            applied: 0,
          });
          overReceiptRequests.push({
            grnLineId: lineId,
            poId: po?.id ?? null,
            poLineId: po !== null ? documentLineId : null,
            asnId: asn?.id ?? null,
            asnLineId: asn !== null ? documentLineId : null,
            skuId: input.skuId,
            excessQty: input.qty,
          });
        };
        const requested = po !== null ? input.poLineId : (input.asnLineId ?? null);
        if (terminal) {
          // ── story 21-9: the TERMINAL arm (decisions 1–3) ───────────────
          // A matched line (known id, same SKU) pends against that line;
          // no reference, a SKU mismatch or an unknown id pends with NO
          // line. Never `unmatchedLines` / `rejectedLines`: the device would
          // read either as booked or as lost, and the line is neither.
          const known =
            requested === null
              ? undefined
              : po !== null
                ? poLineById.get(requested)
                : asnLineById.get(requested);
          // A CARRIED line of a closed PO pends with no line: its open
          // quantity moved to a successor, so crediting it on approval would
          // count the units on both POs (the successor walk found none open,
          // but the carried quantity still lives there).
          pendWhole(
            known !== undefined && known.skuId === input.skuId && !('status' in known && known.status === 'carried') ? known.id : null,
          );
          continue;
        }
        let reference = requested;
        if (retargeted) {
          // ── story 21-9: the RE-TARGET arm (decision 5) ─────────────────
          // The SCANNED SKU is what physically arrived: the line books
          // against the successor's ONE open line of that SKU (close matched
          // carried lines by SKU alone), whatever line of the closed PO the
          // device named — none, an unknown id, or another SKU's. Zero or
          // several open successor lines of the SKU pend on the successor
          // with no line.
          const candidates = poLines.filter((line) => line.skuId === input.skuId && line.status === 'open');
          if (candidates.length !== 1) {
            pendWhole(null);
            continue;
          }
          reference = candidates[0]!.id;
        }
        if (reference === null) {
          // Story 21-6 — UNMATCHED (the old no-`poLineId` arm, now named):
          // applied in full, no line credited, no ceiling, no over-receipt.
          settled.push({ ...base, lineId: uuidv7(), poLineId: null, asnLineId: null, applied: input.qty });
          unmatched.push({ index, reason: 'no-line-reference' });
          continue;
        }
        const documentLine =
          po !== null ? poLineById.get(reference) : asnLineById.get(reference);
        if (documentLine === undefined) {
          rejected.push({
            poLineId: po !== null ? reference : null,
            ...(asn !== null ? { asnLineId: reference } : {}),
            skuId: input.skuId,
            qty: fromMilli(input.qty),
            code: po !== null ? 'po-line-not-found' : 'asn-line-not-found',
            reason: `No line with id "${reference}" exists on ${documentLabel}.`,
          });
          continue;
        }
        if (documentLine.skuId !== input.skuId) {
          // Story 21-6 — the scanned goods are not what the referenced line
          // announced: book them (they arrived) without crediting the line.
          settled.push({ ...base, lineId: uuidv7(), poLineId: null, asnLineId: null, applied: input.qty });
          unmatched.push({ index, reason: 'line-sku-mismatch' });
          continue;
        }
        if (po !== null) {
          const poLine = poLineById.get(reference)!;
          if (poLine.status !== 'open') {
            // DEFENSIVE since story 21-9: a line's status changes only at
            // close (`po.command.ts`), so an OPEN PO has no cancelled or
            // carried line, and a closed PO now takes the terminal or the
            // re-target arm above. Kept (with its `po-line-not-open` code,
            // still in the DTO enum for older clients) so a line in a state
            // this fold does not expect is refused rather than credited.
            rejected.push({
              poLineId: reference,
              skuId: input.skuId,
              qty: fromMilli(input.qty),
              code: 'po-line-not-open',
              reason: `Purchase order line "${reference}" is ${poLine.status} — it cannot receive.`,
            });
            continue;
          }
        }
        const lineId = uuidv7();
        const remaining = openRemaining.get(reference) ?? 0;
        // ── story 1-2b: the receiving tolerance (the document's client —
        // the matched line's SKU's) ────────────────────────────────────────
        // `applied = clamp(qty, 0, ceiling − received)`; the part of it past
        // the open quantity is the within-tolerance slice (`tolerance_qty`,
        // no over-receipt row); the rest pends as before.
        let ceiling = ceilingRemaining.get(reference);
        if (ceiling === undefined) {
          const ordered = po !== null ? poLineById.get(reference)!.orderedQty : asnLineById.get(reference)!.announcedQty;
          const uom = skuById.get(input.skuId)!.uom;
          ceiling = remaining + toleranceMilli(ordered, policyOfSku(input.skuId).receivingToleranceBps, uomPrecision(uom));
        }
        const applied = Math.max(0, Math.min(input.qty, ceiling));
        const toleranceQty = Math.max(0, applied - Math.max(0, remaining));
        const excess = input.qty - applied;
        openRemaining.set(reference, remaining - applied);
        ceilingRemaining.set(reference, ceiling - applied);
        settled.push({
          ...base,
          lineId,
          poLineId: po !== null ? reference : null,
          asnLineId: asn !== null ? reference : null,
          applied,
          toleranceQty,
        });
        if (excess > 0) {
          // Pending over-receipt: the excess applies only on approval.
          overReceiptRequests.push({
            grnLineId: lineId,
            poId: po?.id ?? null,
            poLineId: po !== null ? reference : null,
            asnId: asn?.id ?? null,
            asnLineId: asn !== null ? reference : null,
            skuId: input.skuId,
            excessQty: excess,
          });
        }
      }

      // An all-rejected receipt (every line named an unknown or non-open
      // line of an OPEN document — a stale cache) settles nothing and still
      // records. A terminal document's lines never reject (story 21-9).
      if (settled.length > 0) {
        await tx.insert(goodsReceiptLines).values(
          settled.map((entry) => ({
            id: entry.lineId,
            tenantId: command.tenantId,
            grnId,
            poLineId: entry.poLineId,
            asnLineId: entry.asnLineId,
            skuId: entry.input.skuId,
            batchId: entry.batchId,
            qty: entry.input.qty,
            appliedQty: entry.applied,
            toleranceQty: entry.toleranceQty,
          })),
        );
      }

      // ── story 10.3: one handling unit per physical unit received ───────
      // Written ALONGSIDE the ledger append, never as part of it: the ledger
      // records one aggregate `grn.received` per line exactly as before, and
      // these rows are the relational satellite that answers what that event
      // cannot — what each individual case weighs.
      //
      // The over-receipt split is applied here rather than deferred. ALL the
      // rows are created, because all the cases physically arrived; the slice
      // the PO's open quantity covers is `active` and the excess is
      // `pending_approval`, which `decideOverReceipt` later flips to `active`
      // or `rejected`. Neither decision ever creates or destroys a row — a
      // receipt that pretended the excess cases were not on the dock would
      // leave the warehouse holding stock nothing in the system can name.
      //
      // A unit counts as applied only when the applied slice covers it WHOLE
      // (`floor`): a fractional remainder cannot make two-thirds of a case
      // live stock, so the part-covered case pends with the rest.
      const handlingUnitInputs: CreateHandlingUnitInput[] = [];
      for (const entry of settled) {
        const weights = entry.input.weightsGrams;
        if (weights === null) {
          continue;
        }
        // The applied slice has to land on a WHOLE number of cases. A PO
        // remainder that covers two-thirds of a case would otherwise leave
        // live on-hand backed by no `active` unit — stock pack could never
        // account for, with no path back. Refused rather than floored.
        if (entry.applied % QUANTITY_SCALE !== 0) {
          throw grnValidation(
            `SKU "${skuById.get(entry.input.skuId)!.code}" is catch-weight tracked, so the portion a purchase order can absorb must be a whole number of cases — ${fromMilli(entry.applied)} is not. Amend the purchase order line, or receive this delivery blind.`,
          );
        }
        const appliedUnits = Math.max(
          0,
          Math.min(weights.length, entry.applied / QUANTITY_SCALE),
        );
        weights.forEach((weightGrams, index) => {
          handlingUnitInputs.push({
            warehouseId: command.warehouseId,
            skuId: entry.input.skuId,
            batchId: entry.batchId,
            grnLineId: entry.lineId,
            weightGrams,
            status: index < appliedUnits ? 'active' : 'pending_approval',
          });
        });
      }
      // Through the catalog facade (AD-6) — `handling_units` has exactly one
      // writer, the way `serials` does, and `test/architecture.spec.ts` fails
      // the build for any direct write from this module.
      const createdUnits = await this.catalog.createHandlingUnits(
        tx,
        command.tenantId,
        handlingUnitInputs,
      );
      const handlingUnitIdsByLine = new Map<string, string[]>();
      for (const unit of createdUnits) {
        // Every unit created here carries GRN provenance (story 13-2 made the
        // column nullable for RETURNED cases only).
        const grnLineId = unit.grnLineId!;
        const list = handlingUnitIdsByLine.get(grnLineId) ?? [];
        list.push(unit.id);
        handlingUnitIdsByLine.set(grnLineId, list);
      }

      // Ledger events: one per applied line — the batch arm rides on
      // batch-tracked receipts; the serial arm stays closed (no serial intake).
      for (const entry of settled) {
        if (entry.applied <= 0) {
          continue;
        }
        const movement: LedgerMovement = {
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          type: 'grn.received',
          skuId: entry.input.skuId,
          quantityDelta: signedQuantity(entry.applied),
          fromBinId: null,
          toBinId: receivingBin.binId,
          batchRef: entry.batchId,
          serialRef: null,
          actorUserId: command.operatorUserId,
          occurredAt,
          recordedAt,
          // Story 21-6: the document AND the line actually credited — an
          // unmatched line names its document but no line; absent keys are
          // omitted, so a PO or blind event's canonical bytes are unchanged.
          referenceDoc: grnReferenceDoc(grnId, {
            poId: po?.id ?? null,
            poLineId: entry.poLineId,
            asnId,
            asnLineId: entry.asnLineId,
          }),
        };
        await this.inventory.appendLedgerEventInTx(tx, movement);
      }

      // ── story 1-2b: QC on receipt ───────────────────────────────────────
      // A booked line of a `qc_on_receipt` client (its OWN SKU's client) is
      // put on its own receipt-scoped hold, in this transaction: one hold
      // per GRN line, moving exactly that line's applied quantity from
      // Receiving into the QC-HOLD bin — never a sweep of the (sku, bin)
      // scope (other receipts' units stay put). No bin lock, no role gate
      // (a consequence of the receipt); the actor is the device operator and
      // the business time the receipt's. Serial-tracked and catch-weight
      // lines book UNHELD (PENDING) and are counted.
      const qcHeld: { holdId: string; grnLineId: string }[] = [];
      let qcSkippedLines = 0;
      for (const entry of settled) {
        if (entry.applied <= 0 || !policyOfSku(entry.input.skuId).qcOnReceipt) {
          continue;
        }
        const sku = skuById.get(entry.input.skuId)!;
        if (sku.serialTracked || sku.catchWeightTracked) {
          qcSkippedLines += 1;
          continue;
        }
        const holdId = await this.qc.holdReceiptLineInTx(tx, {
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          skuId: entry.input.skuId,
          grnLineId: entry.lineId,
          overReceiptId: null,
          receivingBinId: receivingBin.binId,
          batchId: entry.batchId,
          quantity: entry.applied,
          actorUserId: command.operatorUserId,
          occurredAt,
          recordedAt,
          reason: `QC on receipt — ${code}`,
        });
        qcHeld.push({ holdId, grnLineId: entry.lineId });
      }

      // Applied portions move `received_qty` (open stays derived) — on the
      // document line actually credited (an unmatched line credits none).
      const appliedByPoLine = sumAppliedBy(settled, (entry) => entry.poLineId);
      const appliedByAsnLine = sumAppliedBy(settled, (entry) => entry.asnLineId);
      for (const [poLineId, applied] of appliedByPoLine) {
        // Cumulative ceiling: the per-line @Max admits quantities whose
        // summed receipts exceed the column's exact range — a 400 beats a SQL
        // overflow 500 (and an approve arm that can never land).
        if (poLineById.get(poLineId)!.receivedQty + applied > MAX_GRN_LINE_QTY) {
          throw grnValidation(
            `Purchase order line "${poLineId}" would exceed its received-quantity ceiling of ${fromMilli(MAX_GRN_LINE_QTY)}.`,
          );
        }
        await tx
          .update(purchaseOrderLines)
          // Typed parameter (story 10.1): the column is `bigint`, and the
          // bound value must be too — an untyped literal beside it invites
          // int4 inference and a 22003 at silo scale.
          .set({ receivedQty: sql`${purchaseOrderLines.receivedQty} + ${applied}::bigint` })
          .where(eq(purchaseOrderLines.id, poLineId));
      }
      if (appliedByPoLine.size > 0) {
        await tx
          .update(purchaseOrders)
          .set({ updatedAt: nowIso() })
          .where(eq(purchaseOrders.id, po!.id));
      }
      for (const [asnLineId, applied] of appliedByAsnLine) {
        // The same cumulative ceiling as the PO line.
        if (asnLineById.get(asnLineId)!.receivedQty + applied > MAX_GRN_LINE_QTY) {
          throw grnValidation(
            `ASN line "${asnLineId}" would exceed its received-quantity ceiling of ${fromMilli(MAX_GRN_LINE_QTY)}.`,
          );
        }
        await tx
          .update(asnLines)
          .set({ receivedQty: sql`${asnLines.receivedQty} + ${applied}::bigint`, updatedAt: nowIso() })
          .where(eq(asnLines.id, asnLineId));
      }
      if (asn !== null && !terminal) {
        // The ASN's status follows its lines, in this same transaction.
        // Story 21-9: a terminal ASN is never re-derived nor touched — the
        // late receipt only pends against it.
        await deriveAsnStatusInTx(tx, command.tenantId, asn.id);
        await tx
          .update(advanceShipmentNotices)
          .set({ updatedAt: nowIso() })
          .where(eq(advanceShipmentNotices.id, asn.id));
      }

      // ── over-receipt rows (the excess pends for review.decide) ──────────
      const pendingOverReceipts: { id: string; request: OverReceiptRequest }[] = [];
      for (const request of overReceiptRequests) {
        const id = uuidv7();
        pendingOverReceipts.push({ id, request });
        await tx.insert(overReceipts).values({
          id,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          grnId,
          grnLineId: request.grnLineId,
          poId: request.poId,
          poLineId: request.poLineId,
          asnId: request.asnId,
          asnLineId: request.asnLineId,
          skuId: request.skuId,
          excessQty: request.excessQty,
          status: 'pending',
          requestedBy: command.operatorUserId,
          requestedAt: recordedAt,
        });
      }

      // ── story 1-1: ONE review row for the client-refused lines (§7g) ────
      // Server-raised through tenancy (inbound writes no rejected_ops row),
      // its op id DERIVED from the key and recorded in the snapshot, so a
      // replay re-serves it and inserts nothing. Discard only.
      let reviewOpId: string | null = null;
      let shelfLifeReviewOpId: string | null = null;
      let licenceReviewOpId: string | null = null;
      if (clientRefused.length > 0 && refusalClientId !== null) {
        const review = await this.raiseRefusalReviewsInTx(tx, command, idempotencyKey, {
          grnId,
          grnCode: code,
          clientId: refusalClientId,
          clientLabels,
          blindReasonCode,
          occurredAt,
          clientRefused,
          skuById,
        });
        reviewOpId = review.reviewOpId;
        shelfLifeReviewOpId = review.shelfLifeReviewOpId;
        licenceReviewOpId = review.licenceReviewOpId;
      }

      // ── story 1-4b (decision 2): ONE flag row for inactive-SKU lines ────
      // A blind or unmatched line of an inactive SKU is BOOKED as on any
      // receipt (zero-scan-loss), and the receipt raises one server-raised
      // `grn.inactive-sku-received` row listing those lines, in this
      // transaction. A line against an existing PO/ASN line is unflagged
      // (that inbound was ordered before the SKU was retired); a line refused
      // (client, expiry) never reaches `settled`, so nothing is listed twice.
      // The status is the SKU row this command holds `FOR UPDATE`. Discard
      // only (the web's Acknowledge).
      let inactiveSkuReviewOpId: string | null = null;
      const inactiveBooked = settled.filter(
        (entry) =>
          entry.applied > 0 &&
          entry.poLineId === null &&
          entry.asnLineId === null &&
          skuById.get(entry.input.skuId)!.status !== 'active',
      );
      if (inactiveBooked.length > 0) {
        inactiveSkuReviewOpId = inactiveSkuGrnLinesOpId(idempotencyKey);
        const codes = [...new Set(inactiveBooked.map((entry) => skuById.get(entry.input.skuId)!.code))].sort();
        const raised = await recordServerRejectedOpInTx(tx, this.outbox, {
          tenantId: command.tenantId,
          deviceId: command.deviceId,
          operatorUserId: command.operatorUserId,
          opId: inactiveSkuReviewOpId,
          opType: 'grn.inactive-sku-received',
          problemCode: 'sku-inactive',
          problemDetail:
            `Goods receipt "${code}" booked ${inactiveBooked.length} line(s) of inactive SKU(s) ` +
            `${codes.map((entry) => `"${entry}"`).join(', ')} — not on the document. The units are in stock; check why they arrived.`,
          payload: {
            grnId,
            grnCode: code,
            // Base units, as booked.
            lines: inactiveBooked.map((entry) => {
              const sku = skuById.get(entry.input.skuId)!;
              return { skuId: sku.id, skuCode: sku.code, qty: fromMilli(entry.applied), uom: sku.uom };
            }),
          },
          occurredAt,
        });
        if (raised === null) {
          throw new Error(`grn.inactive-sku-received review row ${inactiveSkuReviewOpId} already existed for a new key`);
        }
      }

      // ── the snapshot (the outbox payload and idempotency replay carry it) ─
      const snapshot: GoodsReceiptSnapshot = {
        goodsReceipt: {
          id: grnId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          code,
          poId: po?.id ?? null,
          // Story 21-9: present only on a RE-TARGETED receipt — the
          // successor it was booked against, whose code the device's cache
          // may not hold. Every other snapshot is byte-identical.
          ...(!retargeted || po === null ? {} : { poCode: po.code }),
          // Story 21-6: present only on an ASN receipt, so a PO or blind
          // GRN's snapshot is byte-identical to its pre-21-6 shape.
          ...(asn === null ? {} : { asnId: asn.id, asnCode: asn.asnCode }),
          // Story 1-1 — the receipt's client (absent from a pre-1-1 stored
          // snapshot, which replays as stored, and from an older build's
          // mixed-client blind receipt — decision 7).
          ...(receiptClientId === null ? {} : { clientId: receiptClientId }),
          blindReasonCode,
          status: 'recorded',
          deviceId: command.deviceId,
          recordedBy: command.operatorUserId,
          occurredAt,
          recordedAt,
          lines: settled.map((entry) => ({
            id: entry.lineId,
            grnId,
            poLineId: entry.poLineId,
            ...(entry.asnLineId === null ? {} : { asnLineId: entry.asnLineId }),
            skuId: entry.input.skuId,
            batchId: entry.batchId,
            batchCode: entry.batchCode,
            // Story 10.1: the snapshot is the HTTP body and the outbox
            // payload — base units on the way out.
            qty: fromMilli(entry.input.qty),
            appliedQty: fromMilli(entry.applied),
            excessQty: fromMilli(entry.input.qty - entry.applied),
            // Story 1-2b: present only when a tolerance booked excess.
            ...(entry.toleranceQty > 0 ? { toleranceQty: fromMilli(entry.toleranceQty) } : {}),
            // Story 10.3: present only on a catch-weight line, so a
            // non-catch-weight GRN's snapshot is byte-identical to its
            // pre-10.3 shape (`JSON.stringify` drops absent keys).
            ...(handlingUnitIdsByLine.has(entry.lineId)
              ? { handlingUnitIds: handlingUnitIdsByLine.get(entry.lineId)! }
              : {}),
          })),
          ...(rejected.length === 0 ? {} : { rejectedLines: rejected }),
          ...(unmatched.length === 0 ? {} : { unmatchedLines: unmatched }),
          ...(reviewOpId === null ? {} : { reviewOpId }),
          ...(shelfLifeReviewOpId === null ? {} : { shelfLifeReviewOpId }),
          ...(licenceReviewOpId === null ? {} : { licenceReviewOpId }),
          ...(inactiveSkuReviewOpId === null ? {} : { inactiveSkuReviewOpId }),
          ...(qcHeld.length === 0 ? {} : { qcHeldLines: qcHeld.length }),
          ...(qcSkippedLines === 0 ? {} : { qcSkippedLines }),
        },
      };

      // ── in-transaction outbox appends (AD-7) ────────────────────────────
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'grn.recorded',
        occurredAt: nowIso(),
        payload: { goodsReceipt: snapshot.goodsReceipt },
      });
      for (const pending of pendingOverReceipts) {
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'over_receipt.requested',
          occurredAt: nowIso(),
          payload: {
            overReceiptId: pending.id,
            // Story 9-2 — additive: the panel's drill link needs the warehouse.
            warehouseId: command.warehouseId,
            grnId,
            grnCode: code,
            poId: pending.request.poId,
            poLineId: pending.request.poLineId,
            ...asnRefs(pending.request.asnId, pending.request.asnLineId),
            skuId: pending.request.skuId,
            excessQty: fromMilli(pending.request.excessQty),
            requestedBy: command.operatorUserId,
            requestedAt: recordedAt,
          },
        });
      }

      // Story 1-2b — ONE event per receipt placed on holds (never one per
      // hold): the notification panel raises ONE `qc-receipt` entry, keyed by
      // the placement (the GRN here; an approved excess's own id there).
      if (qcHeld.length > 0) {
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: QC_RECEIPT_PLACED_EVENT,
          occurredAt: nowIso(),
          payload: {
            placementId: grnId,
            grnId,
            grnCode: code,
            warehouseId: command.warehouseId,
            holdIds: qcHeld.map((hold) => hold.holdId),
            count: qcHeld.length,
          },
        });
      }

      // Story 9-3a — the audit row (step 10). The actor is the operator the
      // op was recorded by — on a replayed handheld op, the original one.
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.operatorUserId,
        action: 'goods_receipt.submitted',
        targetType: 'goods_receipt',
        targetId: grnId,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });
      // Story 1-2b — one audit row per receipt placed on QC holds.
      if (qcHeld.length > 0) {
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.operatorUserId,
          action: 'qc_hold.receipt_placed',
          targetType: 'goods_receipt',
          targetId: grnId,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });
      }
      // Story 1-2b (decision 5) — a shelf-life refusal accepted from review:
      // the re-run records who waived the rule (the reviewer), against the
      // receipt it booked. The note rides the review row's resolved outcome.
      if (command.shelfLifeWaiver !== undefined && command.shelfLifeWaiver !== null) {
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.shelfLifeWaiver.byUserId,
          action: 'goods_receipt.shelf_life_waived',
          targetType: 'goods_receipt',
          targetId: grnId,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });
      }
      // Story 1-6d (decision 3) — a licence refusal accepted from review by
      // an owner: the re-run records who waived the check, against the
      // receipt it booked. The note rides the review row's resolved outcome.
      if (command.licenceWaiver !== undefined && command.licenceWaiver !== null) {
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.licenceWaiver.byUserId,
          action: 'goods_receipt.licence_waived',
          targetType: 'goods_receipt',
          targetId: grnId,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });
      }

      // ── device heartbeat + idempotency key (the invariant order's tail) ──
      await tx
        .update(devices)
        .set({ lastSeenAt: nowIso(), updatedAt: nowIso() })
        .where(eq(devices.id, command.deviceId));

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * The over-receipt decision (review.decide): approve applies the excess (a
   * normal `grn.received` ledger append + `received_qty` bump, one
   * transaction); rejection leaves it unapplied. Both arms write the audit
   * row + outbox event; a second decision is a deterministic 409.
   */
  async decideOverReceipt(
    command: DecideOverReceiptCommand,
    idempotencyKey: string,
  ): Promise<OverReceiptDecisionSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      overReceiptId: command.overReceiptId,
      decision: command.decision,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority at command-service entry — DB role read, same tx, BEFORE
      // the replay lookup (the deliberate fail-closed carve-out).
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'review.decide',
      );

      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.tenantId, command.tenantId), eq(idempotencyKeys.key, idempotencyKey)),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].payloadHash !== payloadHash) {
          throw idempotencyKeyReuse();
        }
        return existing[0].responseSnapshot as OverReceiptDecisionSnapshot;
      }

      const rows = await tx
        .select()
        .from(overReceipts)
        .where(
          and(eq(overReceipts.id, command.overReceiptId), eq(overReceipts.tenantId, command.tenantId)),
        )
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Over-receipt not found',
          `No over-receipt with id "${command.overReceiptId}" exists in this tenant.`,
        );
      }
      if (row.status !== 'pending') {
        throw new ProblemException(
          'over-receipt-decided',
          409,
          'Over-receipt already decided',
          `Over-receipt "${row.id}" is already ${row.status} — decisions are terminal.`,
        );
      }

      const grnRows = await tx
        .select()
        .from(goodsReceiptNotes)
        .where(eq(goodsReceiptNotes.id, row.grnId))
        .limit(1);
      const grn = grnRows[0]!;
      const grnLineRows = await tx
        .select()
        .from(goodsReceiptLines)
        .where(eq(goodsReceiptLines.id, row.grnLineId))
        .limit(1);
      const grnLine = grnLineRows[0]!;

      const decidedAt = nowIso();
      const status = command.decision === 'approve' ? 'approved' : 'rejected';
      // The audit action / outbox type: over_receipt.approved | rejected.
      const decisionEvent = `over_receipt.${status}`;

      // Story 21-6 — the ASN code, for the response and the outbox payload.
      let asnCode: string | null = null;
      /** Story 1-2b — the receipt hold placed on the approved excess (a QC-on-receipt client). */
      let excessHoldId: string | null = null;
      if (command.decision === 'approve') {
        // Story 11.4: the approval is a third +stock writer — the excess
        // applies as a fresh `grn.received` delta at DECISION time, days after
        // the GRN's own kit check ran. A SKU that became a kit in between must
        // refuse here too, or the approval invents independent kit stock.
        //
        // Fix A2 (epic-11 retro F2): lock the SKU row FIRST — the `loadSkus`
        // shape, tenant-scoped, id-ordered, `.for('update')` — so a concurrent
        // kit-create serializes on the same row the kit command locks in
        // `lockSkus`, and the kit probe below decides against committed state
        // instead of racing it. The refusal then reuses the locked row's code
        // (no unlocked follow-up read). The reject arm takes NO lock: it
        // writes nothing but status, and need not serialize against a kit
        // create.
        const lockedSkus = await tx
          .select({
            code: skus.code,
            // Story 1-2b — the client whose policy decides whether the
            // approved excess is QC-held, and the two tracking flags that
            // book a line unheld.
            clientId: skus.clientId,
            serialTracked: skus.serialTracked,
            catchWeightTracked: skus.catchWeightTracked,
          })
          .from(skus)
          .where(and(eq(skus.tenantId, command.tenantId), eq(skus.id, row.skuId)))
          .orderBy(skus.id)
          .for('update');
        const overReceiptKitIds = await this.catalog.getKitSkuIdsInTx(tx, command.tenantId, [
          row.skuId,
        ]);
        if (overReceiptKitIds.length > 0) {
          throw kitCannotHoldStock('over-receipt approval', [lockedSkus[0]?.code ?? row.skuId]);
        }

        // ── story 21-6 (decision 3): lock the DOCUMENT, then its line ─────
        // The lock order everywhere: over-receipt row → SKU → PO or ASN →
        // line. A concurrent close locks the same document row and then
        // refuses while this excess is pending, so the two serialise (PENDING
        // :48). Approve NEVER refuses on the document's status — a closed PO
        // (a pre-21-6 leftover) or a `received`/`closed` ASN still takes the
        // excess, so stock that physically arrived is never stranded.
        //
        // Story 21-9: a row may carry its document and NO line (0066 — a late
        // receipt's unmatched line). Approving it locks the document, appends
        // `grn.received` naming `{grnId, poId | asnId}` only, and credits no
        // line. A lined row on a terminal document credits that line; neither
        // re-derives a terminal document (`deriveAsnStatusInTx` leaves a
        // terminal ASN as it is, and a PO's status is never derived at all).
        let poLineReceived: number | null = null;
        let asnLineReceived: number | null = null;
        if (row.poId !== null) {
          await tx
            .select({ id: purchaseOrders.id })
            .from(purchaseOrders)
            .where(and(eq(purchaseOrders.tenantId, command.tenantId), eq(purchaseOrders.id, row.poId)))
            .limit(1)
            .for('update');
          if (row.poLineId !== null) {
            const poLineRows = await tx
              .select({ receivedQty: purchaseOrderLines.receivedQty })
              .from(purchaseOrderLines)
              .where(eq(purchaseOrderLines.id, row.poLineId))
              .limit(1)
              .for('update');
            if (poLineRows[0] === undefined) {
              throw grnValidation(`Purchase order line "${row.poLineId}" no longer exists.`);
            }
            poLineReceived = poLineRows[0].receivedQty;
          }
        } else if (row.asnId !== null) {
          const asnRows = await tx
            .select({ code: advanceShipmentNotices.asnCode })
            .from(advanceShipmentNotices)
            .where(and(eq(advanceShipmentNotices.tenantId, command.tenantId), eq(advanceShipmentNotices.id, row.asnId)))
            .limit(1)
            .for('update');
          asnCode = asnRows[0]?.code ?? null;
          if (row.asnLineId !== null) {
            const asnLineRows = await tx
              .select({ receivedQty: asnLines.receivedQty })
              .from(asnLines)
              .where(eq(asnLines.id, row.asnLineId))
              .limit(1)
              .for('update');
            if (asnLineRows[0] === undefined) {
              throw grnValidation(`ASN line "${row.asnLineId}" no longer exists.`);
            }
            asnLineReceived = asnLineRows[0].receivedQty;
          }
        }
        // Cumulative ceiling (the submit arm enforces the same): an approval
        // that would overflow must be a 400, never a SQL overflow 500 that
        // leaves the row pending forever.
        if (poLineReceived !== null && poLineReceived + row.excessQty > MAX_GRN_LINE_QTY) {
          throw grnValidation(
            `Approving would push purchase order line "${row.poLineId}" past its received-quantity ceiling of ${fromMilli(MAX_GRN_LINE_QTY)}.`,
          );
        }
        if (asnLineReceived !== null && asnLineReceived + row.excessQty > MAX_GRN_LINE_QTY) {
          throw grnValidation(
            `Approving would push ASN line "${row.asnLineId}" past its received-quantity ceiling of ${fromMilli(MAX_GRN_LINE_QTY)}.`,
          );
        }

        // The excess applies as a normal ledger append (corrections are new
        // events) — the system Receiving bin (ensured, idempotent) is its
        // location, the GRN line's batch identity its batch arm.
        const receivingBin = await ensureReceivingBinInTx(tx, command.tenantId, row.warehouseId);
        await this.inventory.appendLedgerEventInTx(tx, {
          tenantId: command.tenantId,
          warehouseId: row.warehouseId,
          type: 'grn.received',
          skuId: row.skuId,
          quantityDelta: signedQuantity(row.excessQty),
          fromBinId: null,
          toBinId: receivingBin.binId,
          batchRef: grnLine.batchId,
          serialRef: null,
          actorUserId: command.actorUserId,
          occurredAt: decidedAt,
          recordedAt: decidedAt,
          // Story 21-6: the same reference shape as the submit's event.
          referenceDoc: grnReferenceDoc(row.grnId, {
            poId: row.poId,
            poLineId: row.poLineId,
            asnId: row.asnId,
            asnLineId: row.asnLineId,
          }),
        });
        if (row.poLineId !== null) {
          await tx
            .update(purchaseOrderLines)
            .set({
              receivedQty: sql`${purchaseOrderLines.receivedQty} + ${row.excessQty}::bigint`,
              updatedAt: decidedAt,
            })
            .where(eq(purchaseOrderLines.id, row.poLineId));
        }
        if (row.asnLineId !== null && row.asnId !== null) {
          await tx
            .update(asnLines)
            .set({
              receivedQty: sql`${asnLines.receivedQty} + ${row.excessQty}::bigint`,
              updatedAt: decidedAt,
            })
            .where(eq(asnLines.id, row.asnLineId));
          // Re-derived like every receipt (a terminal ASN stays terminal).
          await deriveAsnStatusInTx(tx, command.tenantId, row.asnId);
        }

        // ── story 1-2b: QC on receipt holds an approved excess too ─────────
        // The policy CURRENT at approval (read now, plainly — no
        // serialisation against an edit). The excess booked into Receiving
        // above is held the receipt's way: its own hold naming the GRN line
        // and this over-receipt, moving exactly the excess; the actor is the
        // approver. Serial-tracked and catch-weight lines book unheld.
        const sku = lockedSkus[0];
        if (sku !== undefined && !sku.serialTracked && !sku.catchWeightTracked) {
          const policy =
            (await receivingPoliciesInTx(tx, command.tenantId, [sku.clientId])).get(sku.clientId) ?? DEFAULT_RECEIVING_POLICY;
          if (policy.qcOnReceipt) {
            const holdId = await this.qc.holdReceiptLineInTx(tx, {
              tenantId: command.tenantId,
              warehouseId: row.warehouseId,
              skuId: row.skuId,
              grnLineId: row.grnLineId,
              overReceiptId: row.id,
              receivingBinId: receivingBin.binId,
              batchId: grnLine.batchId,
              quantity: row.excessQty,
              actorUserId: command.actorUserId,
              occurredAt: decidedAt,
              recordedAt: decidedAt,
              reason: `QC on receipt — ${grn.code}`,
            });
            excessHoldId = holdId;
            await this.outbox.append(tx, {
              messageId: uuidv7(),
              tenantId: command.tenantId,
              type: QC_RECEIPT_PLACED_EVENT,
              occurredAt: decidedAt,
              payload: {
                placementId: row.id,
                grnId: row.grnId,
                grnCode: grn.code,
                warehouseId: row.warehouseId,
                holdIds: [holdId],
                count: 1,
              },
            });
            await tx.insert(auditEvents).values({
              id: uuidv7(),
              tenantId: command.tenantId,
              actorUserId: command.actorUserId,
              action: 'qc_hold.receipt_placed',
              targetType: 'goods_receipt',
              targetId: row.grnId,
              reference: idempotencyKey,
              occurredAt: decidedAt,
            });
          }
        }
      } else if (row.asnId !== null) {
        // The reject arm stays lock-free beyond its own row: a plain read
        // of the code for the response.
        const asnRows = await tx
          .select({ code: advanceShipmentNotices.asnCode })
          .from(advanceShipmentNotices)
          .where(and(eq(advanceShipmentNotices.tenantId, command.tenantId), eq(advanceShipmentNotices.id, row.asnId)))
          .limit(1);
        asnCode = asnRows[0]?.code ?? null;
      }

      // ── story 10.3: the handling units that pended WITH this excess ─────
      // The path the spec's first draft missed entirely. Approval flips them
      // `pending_approval → active`; rejection flips them `→ rejected`.
      // Neither arm creates or destroys a row — the physical case arrived
      // either way — and a unit left `pending_approval` forever would be a
      // case pack can never admit and nothing can ever write off.
      //
      // It rides the SAME transaction as the decision, the ledger append and
      // the `received_qty` bump: a decision that half-landed would leave
      // quantity and units disagreeing with no path back. Non-catch-weight
      // lines simply match no rows, so this is a no-op for them.
      await this.catalog.settleHandlingUnitIntake(
        tx,
        command.tenantId,
        row.grnLineId,
        command.decision,
      );

      await tx
        .update(overReceipts)
        .set({ status, decidedBy: command.actorUserId, decidedAt, updatedAt: decidedAt })
        .where(and(eq(overReceipts.id, row.id), eq(overReceipts.status, 'pending')));

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: decisionEvent,
        targetType: 'over_receipt',
        targetId: row.id,
        reference: idempotencyKey,
        occurredAt: decidedAt,
      });

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: decisionEvent,
        occurredAt: decidedAt,
        payload: {
          overReceiptId: row.id,
          // Story 9-2 — additive, as on `over_receipt.requested`.
          warehouseId: row.warehouseId,
          grnId: row.grnId,
          grnCode: grn.code,
          poId: row.poId,
          poLineId: row.poLineId,
          ...asnRefs(row.asnId, row.asnLineId),
          skuId: row.skuId,
          excessQty: fromMilli(row.excessQty),
          decidedBy: command.actorUserId,
          decidedAt,
        },
      });

      const snapshot: OverReceiptDecisionSnapshot = {
        overReceipt: {
          id: row.id,
          tenantId: row.tenantId,
          warehouseId: row.warehouseId,
          grnId: row.grnId,
          grnCode: grn.code,
          grnLineId: row.grnLineId,
          poId: row.poId,
          poLineId: row.poLineId,
          ...asnRefs(row.asnId, row.asnLineId),
          ...(asnCode === null ? {} : { asnCode }),
          skuId: row.skuId,
          excessQty: fromMilli(row.excessQty),
          status: status as OverReceiptEntry['status'],
          requestedBy: row.requestedBy,
          requestedAt: canonicalInstant(row.requestedAt),
          decidedBy: command.actorUserId,
          decidedAt,
          createdAt: canonicalInstant(row.createdAt),
          // Story 1-2b: present only when the approved excess was QC-held.
          ...(excessHoldId === null ? {} : { qcHoldId: excessHoldId }),
        },
      };
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── shared pieces ─────────────────────────────────────────────────────────

  /**
   * Story 21-9 (decision 5) — the open successor of a CLOSED purchase order:
   * walk `carried_from_po_id` forward (the successor is the PO whose
   * `carried_from_po_id` is this one — close creates at most one) to the
   * first `open` PO in the receipt's warehouse, at most
   * `MAX_SUCCESSOR_HOPS` hops. Each hop is locked `FOR UPDATE` and its status
   * read under that lock (the PO → PO order close itself takes: the
   * predecessor first), so a successor closed concurrently is walked past,
   * never booked against. Null when the chain ends, leaves the warehouse, or
   * runs past the bound — the caller then pends on the closed PO.
   */
  private async openSuccessorInTx(
    tx: TenantTx,
    tenantId: string,
    closed: typeof purchaseOrders.$inferSelect,
    warehouseId: string,
  ): Promise<typeof purchaseOrders.$inferSelect | null> {
    let current = closed;
    for (let hop = 0; hop < MAX_SUCCESSOR_HOPS; hop += 1) {
      const rows = await tx
        .select()
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.carriedFromPoId, current.id)))
        .orderBy(purchaseOrders.createdAt, purchaseOrders.id)
        .limit(1)
        .for('update');
      const next = rows[0];
      if (next === undefined || next.warehouseId !== warehouseId) {
        return null;
      }
      if (next.status === 'open') {
        return next;
      }
      current = next;
    }
    return null;
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

  /**
   * Every line's SKU exists in the tenant (404 naming the unknown id); returns
   * the loaded rows. The read takes `.for('update')` in id order — story 11.4:
   * the row locks serialize a GRN against a concurrent kit-create on the same
   * SKU (which locks the same rows), so the "GRN commits stock onto a SKU
   * that just became a kit" race cannot interleave; the kit create's
   * stock/reservation guard then decides against committed state.
   */
  private async loadSkus(
    tx: TenantTx,
    tenantId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, typeof skus.$inferSelect>> {
    const distinct = [...new Set(skuIds)];
    const rows = await tx
      .select()
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, distinct)))
      .orderBy(skus.id)
      .for('update');
    const byId = new Map(rows.map((row) => [row.id, row]));
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
   * Story 21-6 — a receipt references EXACTLY ONE of a purchase order, an
   * advance shipment notice, or neither (blind, then with a reason from the
   * fixed enum); anything else is a 400. The friendly front end of
   * `goods_receipt_notes_blind_pairing` (0064).
   */
  private validateDocumentPairing(
    poId: string | null,
    asnId: string | null,
    blindReasonCode: string | null,
  ): string | null {
    const given = [poId, asnId, blindReasonCode].filter((value) => value !== null).length;
    if (given !== 1) {
      throw grnValidation(
        given === 0
          ? `A receipt names a purchase order (poId), an advance shipment notice (asnId), or — when blind — a reason code from ${JSON.stringify(BLIND_REASON_CODES)}.`
          : 'A receipt names exactly one of poId, asnId or blindReasonCode — never two.',
      );
    }
    if (blindReasonCode !== null) {
      if (!BLIND_REASON_CODES.includes(blindReasonCode as BlindReasonCode)) {
        throw grnValidation(
          `A blind receipt requires a reason code from ${JSON.stringify(BLIND_REASON_CODES)}.`,
        );
      }
      return blindReasonCode;
    }
    return null;
  }

  /**
   * Batch identity for every batch-tracked line, through the catalog facade's
   * in-transaction ensure (the ONLY way receipts create batches). A batch
   * code on a non-batch-tracked SKU — or a missing one on a batch-tracked
   * SKU — is a 400 before any write.
   */
  private async ensureBatchIdentity(
    tx: TenantTx,
    command: SubmitGoodsReceiptCommand,
    skuById: Map<string, typeof skus.$inferSelect>,
    batchExpiry: ReadonlyMap<string, string | null>,
  ): Promise<Map<string, { id: string; code: string; expiryDate: string | null }>> {
    const result = new Map<string, { id: string; code: string; expiryDate: string | null }>();
    const inputsBySku = new Map<string, { code: string; mfgDate?: string; expiryDate?: string }[]>();
    let fillsExpiry = false;
    for (const line of command.lines) {
      const sku = skuById.get(line.skuId)!;
      if (sku.batchTracked) {
        if (line.batchCode === null) {
          throw grnValidation(`SKU "${sku.code}" is batch-tracked — its lines need a batch code.`);
        }
        const inputs = inputsBySku.get(line.skuId) ?? [];
        if (!inputs.some((input) => input.code === line.batchCode)) {
          // Story 1-2b — ONE input per (sku, code), carrying the receipt's
          // merged expiry (a line without one and a line with one on the
          // same batch merge, taking the non-null one), stored as the
          // instant its IST date begins.
          const expiry = batchExpiry.get(`${line.skuId}:${line.batchCode}`) ?? null;
          fillsExpiry ||= expiry !== null;
          inputs.push({
            code: line.batchCode,
            ...(line.mfgDate === null ? {} : { mfgDate: line.mfgDate }),
            ...(expiry === null ? {} : { expiryDate: istMidnightOf(expiry) }),
          });
          inputsBySku.set(line.skuId, inputs);
        }
      } else if (line.batchCode !== null) {
        throw grnValidation(`SKU "${sku.code}" is not batch-tracked — its lines carry no batch code.`);
      }
    }
    for (const [skuId, inputs] of inputsBySku) {
      // `fillNullExpiry` is receiving's alone (manual movements never fill):
      // an existing batch's NULL expiry takes the receipt's; a non-null one
      // is never overwritten — the caller compares what resolved.
      const ensured = await this.catalog.ensureBatchesInTx(tx, command.tenantId, skuId, inputs, {
        fillNullExpiry: fillsExpiry,
      });
      for (const batch of ensured) {
        result.set(`${skuId}:${batch.code}`, { id: batch.id, code: batch.code, expiryDate: batch.expiryDate });
      }
    }
    return result;
  }

  /**
   * Story 1-2b — the five expiry rules, PER LINE (§7g), over the lines no
   * client rule refused, in request order. Returns the refused lines and,
   * per batch-tracked `(sku, batch code)`, the receipt's merged expiry (an
   * IST date, or null) the ensure stores and the rules judged against.
   *
   * 1. `expiry-on-untracked` — an expiry on a SKU that is not batch-tracked
   *    (expiry lives on the batch).
   * 2. `expiry-before-mfg` — the line's expiry precedes its own mfg date.
   * 3. `batch-expiry-mismatch` (any client) — the line's expiry differs, by
   *    IST date, from the existing batch's non-null expiry, or from an
   *    earlier line of this receipt naming the same batch (later lines are
   *    refused). A line without an expiry merges with one that has it.
   * 4. `expiry-required` — the client requires expiry, the SKU is
   *    batch-tracked, and the EFFECTIVE expiry (the line's, else its
   *    batch's) is null.
   * 5. `shelf-life-short` — the client requires expiry and the effective
   *    expiry is fewer IST days after the receipt's date than its minimum
   *    (0 when none — so an already expired batch is refused whenever
   *    expiry is required). Skipped under the review's waiver only.
   *
   * No query at all when no line carries an expiry and no line's client
   * requires one — the default policy reads nothing more than before.
   */
  private async expiryRefusalsInTx(
    tx: TenantTx,
    tenantId: string,
    args: {
      readonly inputLines: readonly GrnLineInput[];
      readonly alreadyRefused: ReadonlySet<number>;
      readonly skuById: Map<string, typeof skus.$inferSelect>;
      readonly policyOfSku: (skuId: string) => ClientReceivingPolicy;
      /** The receipt's business date, `istDateOf(occurredAt)`. */
      readonly receiptDate: string;
      readonly waived: boolean;
    },
  ): Promise<{ refused: ClientRefusedLine[]; batchExpiry: Map<string, string | null> }> {
    const refused: ClientRefusedLine[] = [];
    const batchExpiry = new Map<string, string | null>();
    const candidates = args.inputLines
      .map((line, index) => ({ index, line }))
      .filter(({ index }) => !args.alreadyRefused.has(index));
    const anyExpiry = candidates.some(({ line }) => (line.expiryDate ?? null) !== null);
    const anyRequired = candidates.some(({ line }) => args.policyOfSku(line.skuId).expiryRequired);
    if (!anyExpiry && !anyRequired) {
      return { refused, batchExpiry };
    }
    const out = new Set<number>();
    const refuse = (entry: ClientRefusedLine): void => {
      refused.push(entry);
      out.add(entry.index);
    };
    const tracked = (line: GrnLineInput): boolean => args.skuById.get(line.skuId)!.batchTracked;
    const batchKey = (line: GrnLineInput): string | null =>
      tracked(line) && line.batchCode !== null ? `${line.skuId}:${line.batchCode}` : null;

    // (1) + (2): the line's own facts.
    for (const { index, line } of candidates) {
      const expiry = line.expiryDate ?? null;
      if (expiry === null) continue;
      if (!tracked(line)) {
        refuse({ index, line, code: 'expiry-on-untracked', expiryDate: expiry });
      } else if (line.mfgDate !== null && expiry < istDateOf(line.mfgDate)) {
        refuse({ index, line, code: 'expiry-before-mfg', expiryDate: expiry });
      }
    }

    // The existing batches, read by (sku, code) — compared by IST date.
    const pairs = candidates
      .filter(({ index, line }) => !out.has(index) && batchKey(line) !== null)
      .map(({ line }) => ({ skuId: line.skuId, code: line.batchCode! }));
    const existing = await this.catalog.batchesByCodesInTx(tx, tenantId, pairs);
    for (const [key, batch] of existing) {
      if (batch.expiryDate !== null) {
        batchExpiry.set(key, istDateOf(canonicalInstant(batch.expiryDate)));
      }
    }
    // (2) again, against the EXISTING batch's mfg date when the line carries
    // none — else the fill below could write an expiry before the batch's mfg.
    for (const { index, line } of candidates) {
      const key = batchKey(line);
      const expiry = line.expiryDate ?? null;
      if (out.has(index) || key === null || expiry === null || line.mfgDate !== null) continue;
      const batchMfg = existing.get(key)?.mfgDate ?? null;
      if (batchMfg !== null && expiry < istDateOf(canonicalInstant(batchMfg))) {
        refuse({ index, line, code: 'expiry-before-mfg', expiryDate: expiry });
      }
    }

    // (3): one expiry per batch — the existing one, else the first line's.
    for (const { index, line } of candidates) {
      const key = batchKey(line);
      const expiry = line.expiryDate ?? null;
      if (out.has(index) || key === null || expiry === null) continue;
      const known = batchExpiry.get(key) ?? null;
      if (known === null) {
        batchExpiry.set(key, expiry);
      } else if (known !== expiry) {
        refuse({ index, line, code: 'batch-expiry-mismatch', expiryDate: expiry });
      }
    }

    // (4) + (5): the client's policy, against the EFFECTIVE expiry.
    for (const { index, line } of candidates) {
      // A tracked line WITHOUT a batch code is not judged here: it reaches
      // `ensureBatchIdentity`'s 400 ("its lines need a batch code") as before.
      if (out.has(index) || !tracked(line) || line.batchCode === null) continue;
      const policy = args.policyOfSku(line.skuId);
      if (!policy.expiryRequired) continue;
      const key = batchKey(line);
      const effective = line.expiryDate ?? (key === null ? null : (batchExpiry.get(key) ?? null));
      if (effective === null) {
        refuse({ index, line, code: 'expiry-required', expiryDate: null });
        continue;
      }
      if (args.waived) continue;
      const minimum = policy.minShelfLifeDays ?? 0;
      const remainingDays = istDaysBetween(args.receiptDate, effective);
      if (remainingDays < minimum) {
        refuse({ index, line, code: 'shelf-life-short', expiryDate: effective, minShelfLifeDays: minimum, remainingDays });
      }
    }
    return { refused, batchExpiry };
  }

  /**
   * Story 1-1 — the `rejectedLines` entries of the client-refused lines (base
   * units, as sent); story 1-2a adds the `client-departed` words. Story 1-2b
   * adds the five expiry codes, whose entries ALSO carry the line's identity
   * (`index`, `batchCode`, `expiryDate`, `minShelfLifeDays`) — a client
   * refusal's entry is unchanged. `receiptClientId` is the blind receipt's
   * named client (a mismatch line exists only beside one).
   */
  private clientRefusalLines(
    clientRefused: readonly ClientRefusedLine[],
    skuById: Map<string, typeof skus.$inferSelect>,
    clientLabels: ReadonlyMap<string, string>,
    receiptClientId: string | null,
  ): RejectedGrnLine[] {
    return clientRefused.map((entry) => {
      const { line, code } = entry;
      const sku = skuById.get(line.skuId)!;
      const skuClient = clientLabels.get(sku.clientId) ?? sku.clientId;
      if (code === 'licence-not-covered') {
        // Story 1-6d — the full entry: the line's identity plus what is missing.
        const missing = entry.missing ?? [];
        return {
          poLineId: line.poLineId,
          ...(line.asnLineId === null || line.asnLineId === undefined ? {} : { asnLineId: line.asnLineId }),
          skuId: line.skuId,
          qty: line.qty,
          code,
          reason: licenceRefusalReason(sku.code, missing, entry.siteCode ?? ''),
          index: entry.index,
          missing: missing.map((item) => ({ need: item.need, holder: item.holder })),
        };
      }
      if (EXPIRY_REFUSAL_CODES.has(code)) {
        return {
          poLineId: line.poLineId,
          ...(line.asnLineId === null || line.asnLineId === undefined ? {} : { asnLineId: line.asnLineId }),
          skuId: line.skuId,
          qty: line.qty,
          code,
          reason: expiryRefusalReason(entry, sku.code, line.batchCode, skuClient),
          index: entry.index,
          batchCode: line.batchCode,
          expiryDate: entry.expiryDate ?? null,
          ...(entry.minShelfLifeDays === undefined ? {} : { minShelfLifeDays: entry.minShelfLifeDays }),
        };
      }
      return {
        poLineId: null,
        skuId: line.skuId,
        qty: line.qty,
        code,
        reason:
          code === 'client-departed'
            ? `SKU "${sku.code}" belongs to client ${skuClient}, which has departed — an owner must reactivate the client before its goods are received.`
            : `SKU "${sku.code}" belongs to client ${skuClient}, not this receipt's client ` +
              `${clientLabels.get(receiptClientId ?? '') ?? receiptClientId} — receive it on a receipt for its own client.`,
      };
    });
  }

  /**
   * Story 1-1 — the review rows for a receipt's per-line refusals (§7g):
   * server-raised through tenancy (inbound writes no rejected_ops row), each
   * op id DERIVED from the key with its own salt and recorded in the
   * snapshot, so a replay re-serves it and inserts nothing. `grnId` and
   * `grnCode` are null when every line was refused (decision 6 — no
   * receipt).
   *
   * Story 1-2b — TWO rows: `grn.lines-refused` (every refused line but the
   * short-dated ones — Discard only, its `problemCode` by
   * `LINES_REFUSED_CODE_PRECEDENCE`, the departure still winning) and
   * `grn.shelf-life-refused` (the `shelf-life-short` lines only — Apply with
   * a note, which re-runs exactly those lines under the waiver, or Discard;
   * its payload is the original receipt's header plus only those lines).
   */
  private async raiseRefusalReviewsInTx(
    tx: TenantTx,
    command: SubmitGoodsReceiptCommand,
    idempotencyKey: string,
    args: {
      readonly grnId: string | null;
      readonly grnCode: string | null;
      readonly clientId: string;
      readonly clientLabels: ReadonlyMap<string, string>;
      readonly blindReasonCode: string | null;
      readonly occurredAt: string;
      readonly clientRefused: readonly ClientRefusedLine[];
      readonly skuById: Map<string, typeof skus.$inferSelect>;
    },
  ): Promise<{
    reviewOpId: string | null;
    shelfLifeReviewOpId: string | null;
    licenceReviewOpId: string | null;
    rejectedOpId: string;
  }> {
    // Story 1-6d — three ways: short-dated → the shelf-life row; uncovered
    // by a licence → the licence row; every other refusal → lines-refused.
    const linesRefused = args.clientRefused.filter(
      (entry) => entry.code !== 'shelf-life-short' && entry.code !== 'licence-not-covered',
    );
    const shelfLifeRefused = args.clientRefused.filter((entry) => entry.code === 'shelf-life-short');
    const licenceRefused = args.clientRefused.filter((entry) => entry.code === 'licence-not-covered');
    let reviewOpId: string | null = null;
    let shelfLifeReviewOpId: string | null = null;
    let licenceReviewOpId: string | null = null;
    let firstRejectedOpId: string | null = null;
    const clientLabel = args.clientLabels.get(args.clientId) ?? args.clientId;
    const refusalEntry = (entry: ClientRefusedLine): Record<string, unknown> => {
      const { index, line } = entry;
      const sku = args.skuById.get(line.skuId)!;
      return {
        lineIndex: index,
        skuId: sku.id,
        skuCode: sku.code,
        skuClientId: sku.clientId,
        skuClientLabel: args.clientLabels.get(sku.clientId) ?? sku.clientId,
        reason: entry.code,
        // Story 1-2b — the expiry codes name the batch and the date judged.
        ...(EXPIRY_REFUSAL_CODES.has(entry.code)
          ? {
              batchCode: line.batchCode,
              expiryDate: entry.expiryDate ?? null,
              ...(entry.minShelfLifeDays === undefined ? {} : { minShelfLifeDays: entry.minShelfLifeDays }),
              ...(entry.remainingDays === undefined ? {} : { remainingDays: entry.remainingDays }),
            }
          : {}),
        // Story 1-6d — what no valid licence covers (the web and the handheld word it).
        ...(entry.code === 'licence-not-covered'
          ? { missing: (entry.missing ?? []).map((item) => ({ need: item.need, holder: item.holder })) }
          : {}),
      };
    };

    if (linesRefused.length > 0) {
      reviewOpId = refusedGrnLinesOpId(idempotencyKey);
      const codes = new Set(linesRefused.map((entry) => entry.code));
      const problemCode = LINES_REFUSED_CODE_PRECEDENCE.find((code) => codes.has(code))!;
      const rejectedOpId = await recordServerRejectedOpInTx(tx, this.outbox, {
        tenantId: command.tenantId,
        deviceId: command.deviceId,
        operatorUserId: command.operatorUserId,
        opId: reviewOpId,
        opType: 'grn.lines-refused',
        problemCode,
        problemDetail: linesRefusedDetail(problemCode, linesRefused, args.grnCode, clientLabel),
        payload: {
          warehouseId: command.warehouseId,
          grnId: args.grnId,
          grnCode: args.grnCode,
          clientId: args.clientId,
          clientLabel,
          blindReasonCode: args.blindReasonCode,
          occurredAt: args.occurredAt,
          // The refused lines only (base units, as sent), aligned with `refusals`.
          lines: linesRefused.map(({ line }) => ({
            skuId: line.skuId,
            batchCode: line.batchCode,
            mfgDate: line.mfgDate,
            // Story 1-2b — present only when the line carried one.
            ...(line.expiryDate === null || line.expiryDate === undefined ? {} : { expiryDate: line.expiryDate }),
            qty: line.qty,
            ...(line.weightsGrams === null ? {} : { weightsGrams: [...line.weightsGrams] }),
          })),
          refusals: linesRefused.map(refusalEntry),
        },
        occurredAt: args.occurredAt,
      });
      if (rejectedOpId === null) {
        // The key is new (the replay lookup ran above), so its derived op id
        // cannot exist — fail loudly rather than write an audit row with no target.
        throw new Error(`grn.lines-refused review row ${reviewOpId} already existed for a new key`);
      }
      firstRejectedOpId = rejectedOpId;
    }

    if (shelfLifeRefused.length > 0) {
      shelfLifeReviewOpId = shelfLifeRefusedOpId(idempotencyKey);
      const minimum = Math.max(...shelfLifeRefused.map((entry) => entry.minShelfLifeDays ?? 0));
      const rejectedOpId = await recordServerRejectedOpInTx(tx, this.outbox, {
        tenantId: command.tenantId,
        deviceId: command.deviceId,
        operatorUserId: command.operatorUserId,
        opId: shelfLifeReviewOpId,
        opType: 'grn.shelf-life-refused',
        problemCode: 'shelf-life-short',
        problemDetail:
          (args.grnCode === null
            ? `No goods receipt was recorded — ${shelfLifeRefused.length} line(s) were refused`
            : `${shelfLifeRefused.length} line(s) of goods receipt "${args.grnCode}" were not booked`) +
          ` — their remaining shelf life is below the client's minimum of ${minimum} day(s) (or the batch has expired).` +
          ' Accept them anyway with a note (they book as on any receipt), or discard them.',
        // The ORIGINAL receipt's header plus only these lines — exactly what
        // Apply re-runs (under the waiver, with the row's own op id as key).
        payload: {
          warehouseId: command.warehouseId,
          poId: command.poId,
          ...(command.asnId === null || command.asnId === undefined ? {} : { asnId: command.asnId }),
          blindReasonCode: args.blindReasonCode,
          ...(command.clientId === null || command.clientId === undefined ? {} : { clientId: command.clientId }),
          occurredAt: args.occurredAt,
          grnId: args.grnId,
          grnCode: args.grnCode,
          clientLabel,
          lines: shelfLifeRefused.map(({ line }) => ({
            poLineId: line.poLineId,
            ...(line.asnLineId === null || line.asnLineId === undefined ? {} : { asnLineId: line.asnLineId }),
            skuId: line.skuId,
            batchCode: line.batchCode,
            mfgDate: line.mfgDate,
            expiryDate: line.expiryDate ?? null,
            qty: line.qty,
            ...(line.weightsGrams === null ? {} : { weightsGrams: [...line.weightsGrams] }),
          })),
          refusals: shelfLifeRefused.map(refusalEntry),
        },
        occurredAt: args.occurredAt,
      });
      if (rejectedOpId === null) {
        throw new Error(`grn.shelf-life-refused review row ${shelfLifeReviewOpId} already existed for a new key`);
      }
      firstRejectedOpId ??= rejectedOpId;
    }

    if (licenceRefused.length > 0) {
      licenceReviewOpId = licenceRefusedOpId(idempotencyKey);
      // D16 — the row's client is the first refused line's own (each line's
      // `refusals[]` entry carries its `skuClientId`).
      const licenceClientId = args.skuById.get(licenceRefused[0]!.line.skuId)!.clientId;
      const licenceClientLabel = args.clientLabels.get(licenceClientId) ?? licenceClientId;
      const shelfLifeWaiver =
        command.shelfLifeWaiver === undefined || command.shelfLifeWaiver === null ? null : command.shelfLifeWaiver;
      const rejectedOpId = await recordServerRejectedOpInTx(tx, this.outbox, {
        tenantId: command.tenantId,
        deviceId: command.deviceId,
        operatorUserId: command.operatorUserId,
        opId: licenceReviewOpId,
        opType: 'grn.licence-refused',
        problemCode: 'licence-not-covered',
        problemDetail:
          (args.grnCode === null
            ? `No goods receipt was recorded — ${licenceRefused.length} line(s) were refused`
            : `${licenceRefused.length} line(s) of goods receipt "${args.grnCode}" were not booked`) +
          ` — no valid licence covers their drug or food goods on ${istDateOf(args.occurredAt)}: ` +
          licenceRefused
            .map((entry) => licenceRefusalReason(args.skuById.get(entry.line.skuId)!.code, entry.missing ?? [], entry.siteCode ?? ''))
            .join('; ') +
          '. An owner may accept them anyway with a note (they book as on any receipt), or discard them.',
        // The ORIGINAL receipt's header plus only these lines — exactly what
        // Apply re-runs (under the licence waiver, with the row's own op id
        // as key) — the 1-2b shape.
        payload: {
          warehouseId: command.warehouseId,
          poId: command.poId,
          ...(command.asnId === null || command.asnId === undefined ? {} : { asnId: command.asnId }),
          blindReasonCode: args.blindReasonCode,
          ...(command.clientId === null || command.clientId === undefined ? {} : { clientId: command.clientId }),
          occurredAt: args.occurredAt,
          grnId: args.grnId,
          grnCode: args.grnCode,
          // NOT `clientId`: that key is the blind receipt's NAMED client,
          // which Apply carries through (above, only when the op named one).
          clientLabel: licenceClientLabel,
          lines: licenceRefused.map(({ line }) => ({
            poLineId: line.poLineId,
            ...(line.asnLineId === null || line.asnLineId === undefined ? {} : { asnLineId: line.asnLineId }),
            skuId: line.skuId,
            batchCode: line.batchCode,
            mfgDate: line.mfgDate,
            ...(line.expiryDate === null || line.expiryDate === undefined ? {} : { expiryDate: line.expiryDate }),
            qty: line.qty,
            ...(line.weightsGrams === null ? {} : { weightsGrams: [...line.weightsGrams] }),
          })),
          refusals: licenceRefused.map(refusalEntry),
          // D1 — no loop: a row raised during a re-run under a shelf-life
          // waiver keeps it, and its Apply passes it on — a short-dated,
          // uncovered line books after one shelf-life Apply and one licence Apply.
          ...(shelfLifeWaiver === null
            ? {}
            : { waivers: { shelfLife: { byUserId: shelfLifeWaiver.byUserId, note: shelfLifeWaiver.note } } }),
        },
        occurredAt: args.occurredAt,
      });
      if (rejectedOpId === null) {
        throw new Error(`grn.licence-refused review row ${licenceReviewOpId} already existed for a new key`);
      }
      firstRejectedOpId ??= rejectedOpId;
    }
    return { reviewOpId, shelfLifeReviewOpId, licenceReviewOpId, rejectedOpId: firstRejectedOpId! };
  }

  /**
   * The next `GRN-<n>` under the tenant's sequence advisory lock — the
   * unique `(tenant, code)` index is the race backstop (a concurrent submit
   * of the same tenant serializes on the lock anyway). Only codes matching
   * the `GRN-<digits>` shape take the max: a non-numeric suffix (any row not
   * written through this command — a fixture, an import) is ignored, never a
   * cast 500, and a 5-digit code (`GRN-10000`, past the 4-digit pad) sorts
   * numerically, not lexically. The digits are bounded at 9 so a forged
   * oversized numeric tail overflows nothing (it is ignored, same as a
   * non-numeric one).
   */
  private async allocateGrnCode(tx: TenantTx, tenantId: string): Promise<string> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':grn-seq', 0))`,
    );
    const headRows = await tx
      .select({
        n: sql<number>`coalesce(max(substring(code from '^GRN-([0-9]{1,9})$')::int), 0)`,
      })
      .from(goodsReceiptNotes)
      .where(eq(goodsReceiptNotes.tenantId, tenantId));
    const next = (headRows[0]?.n ?? 0) + 1;
    return grnCode(next);
  }
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Story 1-1 — the review row's op id for a receipt's client-refused lines:
 * DERIVED from the key, never the key (the device's own op id would collide
 * with a later upload of the same op) — the key's 10-character timestamp
 * prefix plus 16 characters of a salted hash (the 13-2 `refusedEntriesOpId`
 * shape, with its own salt).
 */
export function refusedGrnLinesOpId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${idempotencyKey}:grn-lines-refused`).digest();
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ULID_ALPHABET.charAt(digest[i]! & 31);
  const derived = idempotencyKey.slice(0, 10).toUpperCase() + tail;
  if (derived !== idempotencyKey) return derived;
  const last = derived.charAt(25);
  return derived.slice(0, 25) + (last === '0' ? '1' : '0');
}

/**
 * Story 1-2b — the `grn.shelf-life-refused` row's op id: derived from the
 * key like `refusedGrnLinesOpId`, with its OWN salt — so the two rows a
 * receipt may raise never share an id.
 */
export function shelfLifeRefusedOpId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${idempotencyKey}:grn-shelf-life-refused`).digest();
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ULID_ALPHABET.charAt(digest[i]! & 31);
  const derived = idempotencyKey.slice(0, 10).toUpperCase() + tail;
  if (derived !== idempotencyKey) return derived;
  const last = derived.charAt(25);
  return derived.slice(0, 25) + (last === '0' ? '1' : '0');
}

/**
 * Story 1-6d — the `grn.licence-refused` row's op id: derived from the key
 * like `refusedGrnLinesOpId`, with its OWN salt — so it never shares an id
 * with the other rows a receipt may raise.
 */
export function licenceRefusedOpId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${idempotencyKey}:grn-licence-refused`).digest();
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ULID_ALPHABET.charAt(digest[i]! & 31);
  const derived = idempotencyKey.slice(0, 10).toUpperCase() + tail;
  if (derived !== idempotencyKey) return derived;
  const last = derived.charAt(25);
  return derived.slice(0, 25) + (last === '0' ? '1' : '0');
}

/**
 * Story 1-6d — a licence refusal's reason: `SKU "RICE" needs an FSSAI
 * licence (site "W1")`; several needs are joined with "; ".
 */
export function licenceRefusalReason(skuCode: string, missing: readonly MissingLicence[], siteCode: string): string {
  return `SKU "${skuCode}" ${missing.map((item) => missingLicencePhrase(item.need, item.holder, siteCode)).join('; ')}`;
}

/**
 * Story 1-4b — the `grn.inactive-sku-received` row's op id: derived from the
 * key like `refusedGrnLinesOpId`, with its OWN salt — so it never shares an
 * id with the other rows a receipt may raise.
 */
export function inactiveSkuGrnLinesOpId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${idempotencyKey}:grn-inactive-sku-received`).digest();
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ULID_ALPHABET.charAt(digest[i]! & 31);
  const derived = idempotencyKey.slice(0, 10).toUpperCase() + tail;
  if (derived !== idempotencyKey) return derived;
  const last = derived.charAt(25);
  return derived.slice(0, 25) + (last === '0' ? '1' : '0');
}

/**
 * Story 1-2b — the receiving tolerance of one document line, milli-units:
 * `floor_to_uom_step(ordered × bps / 10000)`, where the step is one unit of
 * the SKU's declared precision (1 each = 1000 milli; 1 g of kg = 1 milli).
 * Exact integer arithmetic (BigInt — `ordered × bps` can pass 2⁵³). 0 bps →
 * 0, so the default policy's ceiling is the ordered quantity exactly.
 */
export function toleranceMilli(orderedMilli: number, bps: number, precision: number): number {
  if (bps <= 0 || orderedMilli <= 0) {
    return 0;
  }
  const step = BigInt(QUANTITY_SCALE / 10 ** Math.min(Math.max(precision, 0), 3));
  const raw = (BigInt(orderedMilli) * BigInt(bps)) / 10_000n;
  return Number((raw / step) * step);
}

/** Story 1-2b — IST calendar days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function istDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Story 1-2b — the operator-facing reason of one expiry refusal (the device shows its own words by code). */
function expiryRefusalReason(entry: ClientRefusedLine, skuCode: string, batchCode: string | null, clientLabel: string): string {
  const batch = batchCode === null ? '' : ` batch "${batchCode}"`;
  switch (entry.code) {
    case 'expiry-on-untracked':
      return `SKU "${skuCode}" is not batch-tracked — an expiry date (${entry.expiryDate}) lives on a batch, so this line was not booked. Receive it again without the expiry date.`;
    case 'expiry-before-mfg':
      return `SKU "${skuCode}"${batch}: the expiry date ${entry.expiryDate} is before the line's mfg date — check the label and receive it again.`;
    case 'batch-expiry-mismatch':
      return `SKU "${skuCode}"${batch}: the expiry date ${entry.expiryDate} differs from the batch's — one batch has one expiry. Check the label; receive it with the batch's expiry or under its own batch code.`;
    case 'expiry-required':
      return `SKU "${skuCode}"${batch}: client ${clientLabel} requires an expiry date on batch-tracked goods and none was given — receive it again with the label's expiry date.`;
    case 'shelf-life-short':
      return `SKU "${skuCode}"${batch} expires ${entry.expiryDate} — ${entry.remainingDays} day(s) of shelf life left, below client ${clientLabel}'s minimum of ${entry.minShelfLifeDays} — not booked; it is in review (accept anyway, or discard).`;
    default:
      return `SKU "${skuCode}" was refused (${entry.code}).`;
  }
}

/**
 * Story 1-2b — the `grn.lines-refused` row's `problemDetail`, by its
 * winning code. A row of client refusals only keeps its pre-1-2b words
 * byte for byte; expiry codes add their own sentence.
 */
function linesRefusedDetail(
  problemCode: (typeof LINES_REFUSED_CODE_PRECEDENCE)[number],
  refused: readonly ClientRefusedLine[],
  grnCode: string | null,
  clientLabel: string,
): string {
  const clientOnly = refused.every((entry) => entry.code === 'client-departed' || entry.code === 'sku-client-mismatch');
  const mixedTail = clientOnly ? '' : ' Other lines were refused for their expiry date — each line names its reason.';
  if (problemCode === 'client-departed') {
    return (
      (grnCode === null
        ? `No goods receipt was recorded — all ${refused.length} line(s) were refused, their SKUs' client (${clientLabel}) having departed or differing from the receipt's.`
        : `${refused.length} line(s) of goods receipt "${grnCode}" were not booked — their SKUs' client has departed or differs from the receipt's.`) +
      ' Re-receive them after an owner reactivates the client.' +
      mixedTail
    );
  }
  if (problemCode === 'sku-client-mismatch') {
    return (
      (grnCode === null
        ? `No goods receipt was recorded — all ${refused.length} line(s) belong to another client than the receipt's (${clientLabel}).`
        : `${refused.length} line(s) of goods receipt "${grnCode}" were not booked — their SKUs belong to another client than the receipt's (${clientLabel}).`) +
      ' Receive them again on a receipt for their own client.' +
      mixedTail
    );
  }
  const head =
    grnCode === null
      ? `No goods receipt was recorded — all ${refused.length} line(s) were refused for their expiry date`
      : `${refused.length} line(s) of goods receipt "${grnCode}" were not booked for their expiry date`;
  const why: Record<string, string> = {
    'batch-expiry-mismatch': "an expiry that differs from its batch's",
    'expiry-before-mfg': 'an expiry before its mfg date',
    'expiry-on-untracked': 'an expiry on a SKU that is not batch-tracked',
    'expiry-required': `no expiry date, which client ${clientLabel} requires`,
  };
  const counts = new Map<string, number>();
  for (const entry of refused) counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1);
  const parts = LINES_REFUSED_CODE_PRECEDENCE.filter((code) => counts.has(code) && why[code] !== undefined).map(
    (code) => `${counts.get(code)} with ${why[code]}`,
  );
  return `${head} (${parts.join('; ')}). Check the labels and receive them again.`;
}

function grnValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid goods receipt', detail);
}

/**
 * Story 10.3 — the catch-weight SHAPE checks, answerable without a database
 * row and therefore run ABOVE the transaction (`IMPLEMENTATION-GUIDE.md` §1,
 * tier 1): each declared weight's own bounds, and the one-weight-per-unit
 * contract between the array's length and the line's declared quantity.
 *
 * Whether THIS SKU may (or must) carry weights at all is a different
 * question — it needs the SKU row, and so it is asked inside the transaction,
 * behind the replay lookup, where a rule that tightened since the op was
 * queued cannot refuse an op that already committed.
 */
function assertWeightShape(lines: readonly GrnLineInput[]): void {
  // Request-WIDE first: a per-line cap alone is defeated by 200 lines naming
  // 500 units each, and every unit costs an insert tuple and a row.
  const declared = lines.reduce((total, line) => total + (line.weightsGrams?.length ?? 0), 0);
  if (declared > MAX_HANDLING_UNITS_PER_REQUEST) {
    throw grnValidation(
      `A goods receipt declares at most ${MAX_HANDLING_UNITS_PER_REQUEST} handling units across all of its lines (got ${declared}).`,
    );
  }
  for (const line of lines) {
    const weights = line.weightsGrams;
    if (weights === null) {
      continue;
    }
    if (weights.length > MAX_HANDLING_UNITS_PER_GRN_LINE) {
      throw grnValidation(
        `A goods-receipt line declares at most ${MAX_HANDLING_UNITS_PER_GRN_LINE} handling units (got ${weights.length}).`,
      );
    }
    for (const weight of weights) {
      assertCatchWeightGrams(weight, 'weightsGrams');
    }
    // One weight per unit, so the array length IS the unit count — and a
    // fractional quantity cannot be a count of physical cases. Both counts
    // are named: an operator who weighed five cases and typed six needs to
    // know which of the two numbers to correct.
    if (!Number.isInteger(line.qty) || weights.length !== line.qty) {
      throw grnValidation(
        `A catch-weight line carries exactly one weight per unit received: qty is ${String(line.qty)} but weightsGrams has ${weights.length} entry(ies). A catch-weight receipt counts whole units.`,
      );
    }
  }
}

function assertUtc(value: string, field: string): string {
  try {
    return assertUtcIso(value);
  } catch {
    throw new ProblemException(
      'validation-failed',
      400,
      `${field} must be a valid ISO-8601 UTC instant`,
      `${field} must be a Z-suffixed ISO-8601 UTC timestamp (got "${value}").`,
    );
  }
}

/** Postgres returns `timestamptz` in its own text shape; the read contract is ISO-8601 UTC. */

/**
 * The PO-state rejection (409 naming the status). Story 21-9: receiving no
 * longer refuses a closed PO (it pends or re-targets) — this survives only as
 * the fail-closed arm for a status the receiving fold does not know.
 */
export function poNotOpen(code: string, status: string): ProblemException {
  return new ProblemException(
    'po-not-open',
    409,
    'Purchase order is not open',
    `Purchase order "${code}" has status ${status} — it cannot receive.`,
  );
}

/** 409 `document-warehouse-mismatch` — a receipt lands only in its document's warehouse (story 21-6). */
export function documentWarehouseMismatch(subject: string): ProblemException {
  return new ProblemException(
    'document-warehouse-mismatch',
    409,
    "Receipt warehouse is not the document's",
    `${subject} belongs to another warehouse — receive it in the warehouse it was raised for.`,
  );
}

/**
 * Story 21-6 — the `grn.received` reference: the GRN, plus the document and
 * the line it credited, each key OMITTED when absent — so a PO or blind
 * event's canonical bytes are exactly their pre-21-6 shape. Used by the
 * submit AND the approve arm, so the two can never disagree.
 */
export function grnReferenceDoc(
  grnId: string,
  refs: {
    readonly poId: string | null;
    readonly poLineId: string | null;
    readonly asnId: string | null;
    readonly asnLineId: string | null;
  },
): {
  kind: 'grn-receipt';
  grnId: string;
  poId?: string;
  poLineId?: string;
  asnId?: string;
  asnLineId?: string;
} {
  return {
    kind: 'grn-receipt',
    grnId,
    ...(refs.poId === null ? {} : { poId: refs.poId }),
    ...(refs.poLineId === null ? {} : { poLineId: refs.poLineId }),
    ...(refs.asnId === null ? {} : { asnId: refs.asnId }),
    ...(refs.asnLineId === null ? {} : { asnLineId: refs.asnLineId }),
  };
}

/** `{asnId, asnLineId}` when set — omitted entirely on a PO's over-receipt. */
function asnRefs(asnId: string | null, asnLineId: string | null): { asnId?: string; asnLineId?: string } {
  return {
    ...(asnId === null ? {} : { asnId }),
    ...(asnLineId === null ? {} : { asnLineId }),
  };
}

/** Σ applied per credited document line (exact — compared against a ceiling). */
function sumAppliedBy<T extends { readonly applied: number }>(
  settled: readonly T[],
  lineOf: (entry: T) => string | null,
): Map<string, number> {
  const sums = new Map<string, number>();
  for (const entry of settled) {
    const lineId = lineOf(entry);
    if (lineId === null || entry.applied <= 0) {
      continue;
    }
    sums.set(lineId, assertExactQuantity((sums.get(lineId) ?? 0) + entry.applied, `received quantity for line ${lineId}`));
  }
  return sums;
}
