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
import { getClientLabelsInTx, shareLockClientInTx } from '../clients/clients.facade';
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
import { assertUtcIso, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertDeviceOperatorInTx } from '../tenancy/device-operator';
import { ensureReceivingBinInTx } from '../tenancy/receiving-bin';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
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
 */
export const REJECTED_GRN_LINE_CODES = [
  'po-line-not-found',
  'po-line-not-open',
  'asn-line-not-found',
  'sku-client-mismatch',
] as const;

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
    readonly reviewOpId: string;
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
      occurredAt: command.occurredAt,
      lines: command.lines.map((line) => ({
        poLineId: line.poLineId,
        asnLineId: line.asnLineId ?? undefined,
        skuId: line.skuId,
        batchCode: line.batchCode,
        mfgDate: line.mfgDate,
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
      // The client must exist (404) and be active (409 `client-not-active`,
      // read under `FOR SHARE` so a suspend cannot commit in between). A line
      // whose SKU belongs to another client is refused PER LINE
      // (`sku-client-mismatch`, §7g): it is split off HERE, before every
      // per-line rule below (kit, catch weight, precision, batch identity),
      // so a refused line can never fail the whole op. An op WITHOUT
      // `clientId` (an older build — decision 7) refuses nothing for client.
      // A PO or ASN receipt refuses nothing for client either (decision 4).
      const clientRefused: { index: number; line: GrnLineInput }[] = [];
      let namedBlindClientId: string | null = null;
      let clientLabels = new Map<string, string>();
      if (blindReasonCode !== null && requestedClientId !== null) {
        const client = await shareLockClientInTx(tx, command.tenantId, requestedClientId);
        if (client.status !== 'active') {
          throw new ProblemException(
            'client-not-active',
            409,
            'The client is not active',
            `Client ${client.code} is ${client.status} — a blind receipt cannot be booked to it.`,
          );
        }
        namedBlindClientId = requestedClientId;
        for (const [index, line] of inputLines.entries()) {
          if (skuById.get(line.skuId)!.clientId !== requestedClientId) {
            clientRefused.push({ index, line });
          }
        }
        if (clientRefused.length > 0) {
          clientLabels = await getClientLabelsInTx(tx, command.tenantId, [
            requestedClientId,
            ...clientRefused.map((entry) => skuById.get(entry.line.skuId)!.clientId),
          ]);
        }
      }
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
      const lines: readonly GrnLineInput[] = receivableInput.map((line) => {
        const uom = skuById.get(line.skuId)!.uom;
        return {
          ...line,
          qty: assertRecordableQuantity(line.qty, 'qty', uom, uomPrecision(uom)),
        };
      });

      // ── story 1-1 (decision 6): EVERY line client-refused → no receipt ──
      // No GRN code is consumed, no `goods_receipt_notes` row, no
      // `grn.recorded` event: every line goes to review as
      // `sku-client-mismatch` (the `grn.lines-refused` row), and the op
      // settles 201 with `{goodsReceipt: null, refusedReceipt}`.
      if (lines.length === 0 && namedBlindClientId !== null) {
        const rejectedLines = this.clientRefusalLines(clientRefused, skuById, clientLabels, namedBlindClientId);
        const review = await this.raiseClientRefusalReviewInTx(tx, command, idempotencyKey, {
          grnId: null,
          grnCode: null,
          clientId: namedBlindClientId,
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
            clientId: namedBlindClientId,
            blindReasonCode,
            occurredAt,
            rejectedLines,
            reviewOpId: review.reviewOpId,
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
      const batchIdentity = await this.ensureBatchIdentity(tx, { ...command, lines: receivable }, skuById);

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
      }
      const settled: SettledLine[] = [];
      const rejected: RejectedGrnLine[] = [];
      const unmatched: UnmatchedGrnLine[] = [];
      const overReceiptRequests: OverReceiptRequest[] = [];
      const documentLabel =
        po !== null ? `purchase order "${po.code}"` : asn !== null ? `advance shipment notice "${asn.asnCode}"` : '';

      // Story 1-1 — the blind per-line client refusals, in request order (a
      // blind receipt has no other refusal, so the order is the request's).
      if (namedBlindClientId !== null) {
        rejected.push(...this.clientRefusalLines(clientRefused, skuById, clientLabels, namedBlindClientId));
      }
      for (const [receivableIndex, input] of lines.entries()) {
        const index = receivableIndexes[receivableIndex]!;
        const identity = batchIdentity.get(`${input.skuId}:${input.batchCode}`) ?? null;
        const base = {
          input,
          batchId: identity?.id ?? null,
          batchCode: identity?.code ?? null,
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
        const applied = Math.max(0, Math.min(input.qty, remaining));
        const excess = input.qty - applied;
        openRemaining.set(reference, remaining - applied);
        settled.push({
          ...base,
          lineId,
          poLineId: po !== null ? reference : null,
          asnLineId: asn !== null ? reference : null,
          applied,
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
      if (clientRefused.length > 0 && namedBlindClientId !== null) {
        reviewOpId = (
          await this.raiseClientRefusalReviewInTx(tx, command, idempotencyKey, {
            grnId,
            grnCode: code,
            clientId: namedBlindClientId,
            clientLabels,
            blindReasonCode,
            occurredAt,
            clientRefused,
            skuById,
          })
        ).reviewOpId;
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
          .select({ code: skus.code })
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
  ): Promise<Map<string, { id: string; code: string }>> {
    const result = new Map<string, { id: string; code: string }>();
    const inputsBySku = new Map<string, { code: string; mfgDate?: string }[]>();
    for (const line of command.lines) {
      const sku = skuById.get(line.skuId)!;
      if (sku.batchTracked) {
        if (line.batchCode === null) {
          throw grnValidation(`SKU "${sku.code}" is batch-tracked — its lines need a batch code.`);
        }
        const inputs = inputsBySku.get(line.skuId) ?? [];
        if (!inputs.some((input) => input.code === line.batchCode)) {
          inputs.push({
            code: line.batchCode,
            ...(line.mfgDate === null ? {} : { mfgDate: line.mfgDate }),
          });
          inputsBySku.set(line.skuId, inputs);
        }
      } else if (line.batchCode !== null) {
        throw grnValidation(`SKU "${sku.code}" is not batch-tracked — its lines carry no batch code.`);
      }
    }
    for (const [skuId, inputs] of inputsBySku) {
      const ensured = await this.catalog.ensureBatchesInTx(tx, command.tenantId, skuId, inputs);
      for (const batch of ensured) {
        result.set(`${skuId}:${batch.code}`, { id: batch.id, code: batch.code });
      }
    }
    return result;
  }

  /** Story 1-1 — the `rejectedLines` entries of the client-refused lines (base units, as sent). */
  private clientRefusalLines(
    clientRefused: readonly { index: number; line: GrnLineInput }[],
    skuById: Map<string, typeof skus.$inferSelect>,
    clientLabels: ReadonlyMap<string, string>,
    receiptClientId: string,
  ): RejectedGrnLine[] {
    return clientRefused.map(({ line }) => {
      const sku = skuById.get(line.skuId)!;
      return {
        poLineId: null,
        skuId: line.skuId,
        qty: line.qty,
        code: 'sku-client-mismatch',
        reason:
          `SKU "${sku.code}" belongs to client ${clientLabels.get(sku.clientId) ?? sku.clientId}, not this receipt's client ` +
          `${clientLabels.get(receiptClientId) ?? receiptClientId} — receive it on a receipt for its own client.`,
      };
    });
  }

  /**
   * Story 1-1 — ONE review row for a blind receipt's client-refused lines
   * (§7g): server-raised through tenancy (inbound writes no rejected_ops
   * row), its op id DERIVED from the key and recorded in the snapshot, so a
   * replay re-serves it and inserts nothing. Discard only. `grnId` and
   * `grnCode` are null when every line was refused (decision 6 — no receipt).
   */
  private async raiseClientRefusalReviewInTx(
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
      readonly clientRefused: readonly { index: number; line: GrnLineInput }[];
      readonly skuById: Map<string, typeof skus.$inferSelect>;
    },
  ): Promise<{ reviewOpId: string; rejectedOpId: string }> {
    const reviewOpId = refusedGrnLinesOpId(idempotencyKey);
    const clientLabel = args.clientLabels.get(args.clientId) ?? args.clientId;
    const rejectedOpId = await recordServerRejectedOpInTx(tx, this.outbox, {
      tenantId: command.tenantId,
      deviceId: command.deviceId,
      operatorUserId: command.operatorUserId,
      opId: reviewOpId,
      opType: 'grn.lines-refused',
      problemCode: 'sku-client-mismatch',
      problemDetail:
        (args.grnCode === null
          ? `No goods receipt was recorded — all ${args.clientRefused.length} line(s) belong to another client than the receipt's (${clientLabel}).`
          : `${args.clientRefused.length} line(s) of goods receipt "${args.grnCode}" were not booked — their SKUs belong to another client than the receipt's (${clientLabel}).`) +
        ' Receive them again on a receipt for their own client.',
      payload: {
        warehouseId: command.warehouseId,
        grnId: args.grnId,
        grnCode: args.grnCode,
        clientId: args.clientId,
        clientLabel,
        blindReasonCode: args.blindReasonCode,
        occurredAt: args.occurredAt,
        // The refused lines only (base units, as sent), aligned with `refusals`.
        lines: args.clientRefused.map(({ line }) => ({
          skuId: line.skuId,
          batchCode: line.batchCode,
          mfgDate: line.mfgDate,
          qty: line.qty,
          ...(line.weightsGrams === null ? {} : { weightsGrams: [...line.weightsGrams] }),
        })),
        refusals: args.clientRefused.map(({ index, line }) => {
          const sku = args.skuById.get(line.skuId)!;
          return {
            lineIndex: index,
            skuId: sku.id,
            skuCode: sku.code,
            skuClientId: sku.clientId,
            skuClientLabel: args.clientLabels.get(sku.clientId) ?? sku.clientId,
            reason: 'sku-client-mismatch',
          };
        }),
      },
      occurredAt: args.occurredAt,
    });
    if (rejectedOpId === null) {
      // The key is new (the replay lookup ran above), so its derived op id
      // cannot exist — fail loudly rather than write an audit row with no target.
      throw new Error(`grn.lines-refused review row ${reviewOpId} already existed for a new key`);
    }
    return { reviewOpId, rejectedOpId };
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
