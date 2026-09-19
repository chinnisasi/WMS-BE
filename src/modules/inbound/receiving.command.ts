import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  devices,
  goodsReceiptLines,
  goodsReceiptNotes,
  idempotencyKeys,
  overReceipts,
  purchaseOrderLines,
  purchaseOrders,
  skus,
  users,
} from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
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
import { deviceRevoked } from '../tenancy/enrollment.command';
import { ensureReceivingBinInTx } from '../tenancy/receiving-bin';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertPermission } from '../tenancy/permissions';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { CatalogFacade } from '../catalog/catalog.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { LedgerMovement } from '../inventory/inventory.facade';
import { canonicalInstant } from '../../shared/primitives/time';

// ── command inputs ────────────────────────────────────────────────────────────

/** The fixed blind-receive reason enum (the I/O matrix — 400 outside it). */
export const BLIND_REASON_CODES = ['unannounced-delivery', 'po-not-found', 'other'] as const;
export type BlindReasonCode = (typeof BLIND_REASON_CODES)[number];

/** One received (sku, batch) line of a `grn.submit`. */
export interface GrnLineInput {
  /** The PO line received against — null on a blind receipt's lines. */
  readonly poLineId: string | null;
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
  /** Null on a blind receipt (then `blindReasonCode` is required). */
  readonly poId: string | null;
  readonly blindReasonCode: string | null;
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
  /** Null on a blind receipt's lines. */
  readonly poLineId: string | null;
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

/** One line the server refused to settle (naming the reason — the other lines settle). */
export interface RejectedGrnLine {
  readonly poLineId: string;
  readonly skuId: string;
  readonly qty: number;
  readonly code: string;
  readonly reason: string;
}

/** The GRN as every surface returns it (the idempotency snapshot). */
export interface GoodsReceiptSnapshot {
  readonly goodsReceipt: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly code: string;
    readonly poId: string | null;
    readonly blindReasonCode: string | null;
    readonly status: string;
    readonly deviceId: string;
    readonly recordedBy: string;
    readonly occurredAt: string;
    readonly recordedAt: string;
    readonly lines: readonly GoodsReceiptLineSnapshot[];
    /** Present only when the submit rejected some lines (partial settlement). */
    readonly rejectedLines?: readonly RejectedGrnLine[];
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

/** GRN codes are `GRN-<n>`, zero-padded to 4 digits, unique per tenant. */
function grnCode(n: number): string {
  return `GRN-${String(n).padStart(4, '0')}`;
}

/** One over-receipt request collected during settlement (row insert pending). */
interface OverReceiptRequest {
  readonly grnLineId: string;
  readonly poId: string;
  readonly poLineId: string;
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
 * tenancy's receiving-bin helper — bin master data stays tenancy-owned). PO
 * state is re-checked at server write time — a closed PO is a 409
 * `po-not-open`; a cancelled LINE is rejected in the response naming the line
 * state while the other lines settle.
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
  ): Promise<GoodsReceiptSnapshot> {
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
      blindReasonCode: command.blindReasonCode,
      occurredAt: command.occurredAt,
      lines: command.lines.map((line) => ({
        poLineId: line.poLineId,
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
    assertWeightShape(command.lines);

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── device re-authorization (fail-closed, the selfTestEcho mirror) ──
      const deviceRows = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.id, command.deviceId), eq(devices.tenantId, command.tenantId)))
        .for('update')
        .limit(1);
      const device = deviceRows[0];
      if (!device || device.status !== 'active' || device.pinHash === null) {
        throw deviceRevoked();
      }

      // Role re-read from the DB per command — floor devices are operator
      // surfaces; a demoted-to-accountant operator is denied per command.
      const roleRows = await tx
        .select({ role: users.role })
        .from(users)
        .where(and(eq(users.id, command.operatorUserId), eq(users.tenantId, command.tenantId)))
        .limit(1);
      const role = roleRows[0]?.role;
      if (role === undefined || role === 'accountant') {
        throw new ProblemException(
          'role-denied',
          403,
          'Role lacks the required capability',
          `Role "${role ?? 'none'}" cannot operate a floor device.`,
        );
      }

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
        return existing[0].responseSnapshot as GoodsReceiptSnapshot;
      }

      // ── input validation (400 before any write) ────────────────────────
      if (command.lines.length === 0) {
        throw grnValidation('A goods receipt needs at least one line.');
      }
      if (command.lines.length > 200) {
        throw grnValidation(`A goods receipt carries at most 200 lines (got ${command.lines.length}).`);
      }
      const occurredAt = assertUtc(command.occurredAt, 'occurredAt');
      const blindReasonCode = this.validateBlindPairing(command.poId, command.blindReasonCode);
      for (const line of command.lines) {
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
        if (command.poId === null && line.poLineId !== null) {
          throw grnValidation('A blind receipt carries no PO line references.');
        }
      }

      // Master-data integrity in the write transaction: warehouse in tenant,
      // every line's SKU in tenant (404 before any write).
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      const skuById = await this.loadSkus(
        tx,
        command.tenantId,
        command.lines.map((line) => line.skuId),
      );

      // ── story 10.3: the catch-weight FLAG rules, behind the replay ──────
      // These need the SKU row, so they sit here rather than in the shape
      // tier above: a catch-weight SKU must carry one weight per unit, and
      // every other SKU must carry none. Both directions fail CLOSED — a
      // weight list silently ignored on a non-catch-weight SKU would be a
      // weight the operator recorded and the system threw away.
      for (const line of command.lines) {
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
      const lines: readonly GrnLineInput[] = command.lines.map((line) => {
        const uom = skuById.get(line.skuId)!.uom;
        return {
          ...line,
          qty: assertRecordableQuantity(line.qty, 'qty', uom, uomPrecision(uom)),
        };
      });

      // ── the receiving bin (tenancy-owned master data) ───────────────────
      const receivingBin = await ensureReceivingBinInTx(tx, command.tenantId, command.warehouseId);

      // ── the PO arm (server re-authorization at write time) ──────────────
      let po: typeof purchaseOrders.$inferSelect | null = null;
      let poLines: (typeof purchaseOrderLines.$inferSelect)[] = [];
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
        if (poRow.status !== 'open') {
          // 409 naming the state — a stale queued receipt retracts visibly.
          throw poNotOpen(poRow.code, poRow.status);
        }
        po = poRow;
        poLines = await tx
          .select()
          .from(purchaseOrderLines)
          .where(eq(purchaseOrderLines.poId, poRow.id))
          .for('update');
      }

      // ── batch identity through the catalog interface (AD-6) ────────────
      // One ensure per batch-tracked SKU (idempotent per (tenant, sku, code));
      // a batch code on a non-batch-tracked SKU, or a missing one on a
      // batch-tracked SKU, is a 400 before any write.
      const batchIdentity = await this.ensureBatchIdentity(tx, command, skuById);

      // ── the GRN header (server-assigned code under the tenant seq lock) ──
      const grnId = uuidv7();
      const code = await this.allocateGrnCode(tx, command.tenantId);
      const recordedAt = nowIso();
      await tx.insert(goodsReceiptNotes).values({
        id: grnId,
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        code,
        poId: command.poId,
        blindReasonCode,
        status: 'recorded',
        deviceId: command.deviceId,
        recordedBy: command.operatorUserId,
        occurredAt,
        recordedAt,
      });

      // ── settlement: within-open applies now; the excess pends ──────────
      // The line's remaining open quantity starts at `ordered − received`
      // (derived, read under the PO-line locks) and shrinks line by line, so
      // two lines for the same PO line settle in receipt order.
      const openRemaining = new Map<string, number>();
      for (const poLine of poLines) {
        openRemaining.set(poLine.id, poLine.orderedQty - poLine.receivedQty);
      }
      const poLineById = new Map(poLines.map((line) => [line.id, line]));

      interface SettledLine {
        readonly input: GrnLineInput;
        readonly lineId: string;
        readonly batchId: string | null;
        readonly batchCode: string | null;
        readonly applied: number;
      }
      const settled: SettledLine[] = [];
      const rejected: RejectedGrnLine[] = [];
      const overReceiptRequests: OverReceiptRequest[] = [];

      for (const input of lines) {
        const identity = batchIdentity.get(`${input.skuId}:${input.batchCode}`) ?? null;
        if (command.poId === null || input.poLineId === null) {
          // Blind arm: the physical quantity applies in full (no PO to gate it).
          settled.push({
            input,
            lineId: uuidv7(),
            batchId: identity?.id ?? null,
            batchCode: identity?.code ?? null,
            applied: input.qty,
          });
          continue;
        }
        const poLine = poLineById.get(input.poLineId);
        if (poLine === undefined) {
          rejected.push({
            poLineId: input.poLineId,
            skuId: input.skuId,
            qty: fromMilli(input.qty),
            code: 'po-line-not-found',
            reason: `No line with id "${input.poLineId}" exists on purchase order "${po!.code}".`,
          });
          continue;
        }
        if (poLine.status !== 'open') {
          // The line-state rejection: the other lines still settle.
          rejected.push({
            poLineId: input.poLineId,
            skuId: input.skuId,
            qty: fromMilli(input.qty),
            code: 'po-line-not-open',
            reason: `Purchase order line "${input.poLineId}" is ${poLine.status} — it cannot receive.`,
          });
          continue;
        }
        const lineId = uuidv7();
        const remaining = openRemaining.get(input.poLineId) ?? 0;
        const applied = Math.max(0, Math.min(input.qty, remaining));
        const excess = input.qty - applied;
        openRemaining.set(input.poLineId, remaining - applied);
        settled.push({
          input,
          lineId,
          batchId: identity?.id ?? null,
          batchCode: identity?.code ?? null,
          applied,
        });
        if (excess > 0) {
          // Pending over-receipt: the excess applies only on approval.
          overReceiptRequests.push({
            grnLineId: lineId,
            poId: command.poId,
            poLineId: input.poLineId,
            skuId: input.skuId,
            excessQty: excess,
          });
        }
      }

      // An all-rejected receipt (every line named an unknown or non-open
      // PO line — a stale cache) settles nothing and still records.
      if (settled.length > 0) {
        await tx.insert(goodsReceiptLines).values(
          settled.map((entry) => ({
            id: entry.lineId,
            tenantId: command.tenantId,
            grnId,
            poLineId: entry.input.poLineId,
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
        const list = handlingUnitIdsByLine.get(unit.grnLineId) ?? [];
        list.push(unit.id);
        handlingUnitIdsByLine.set(unit.grnLineId, list);
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
          referenceDoc: {
            kind: 'grn-receipt',
            grnId,
            ...(command.poId === null ? {} : { poId: command.poId }),
            ...(entry.input.poLineId === null ? {} : { poLineId: entry.input.poLineId }),
          },
        };
        await this.inventory.appendLedgerEventInTx(tx, movement);
      }

      // Applied portions move `received_qty` (open stays derived).
      const appliedByPoLine = new Map<string, number>();
      for (const entry of settled) {
        if (entry.input.poLineId === null || entry.applied <= 0) {
          continue;
        }
        appliedByPoLine.set(
          entry.input.poLineId,
          // Compared against the received-quantity ceiling below, so a sum
          // that rounded would compare against the wrong number (story 10.1).
          assertExactQuantity(
            (appliedByPoLine.get(entry.input.poLineId) ?? 0) + entry.applied,
            `received quantity for po line ${entry.input.poLineId}`,
          ),
        );
      }
      for (const [poLineId, applied] of appliedByPoLine) {
        // Cumulative ceiling: the per-line @Max admits quantities whose
        // summed receipts exceed the int4 column — a 400 beats a SQL
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
          .where(eq(purchaseOrders.id, command.poId!));
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
          skuId: request.skuId,
          excessQty: request.excessQty,
          status: 'pending',
          requestedBy: command.operatorUserId,
          requestedAt: recordedAt,
        });
      }

      // ── the snapshot (the outbox payload and idempotency replay carry it) ─
      const snapshot: GoodsReceiptSnapshot = {
        goodsReceipt: {
          id: grnId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          code,
          poId: command.poId,
          blindReasonCode,
          status: 'recorded',
          deviceId: command.deviceId,
          recordedBy: command.operatorUserId,
          occurredAt,
          recordedAt,
          lines: settled.map((entry) => ({
            id: entry.lineId,
            grnId,
            poLineId: entry.input.poLineId,
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
            grnId,
            grnCode: code,
            poId: pending.request.poId,
            poLineId: pending.request.poLineId,
            skuId: pending.request.skuId,
            excessQty: fromMilli(pending.request.excessQty),
            requestedBy: command.operatorUserId,
            requestedAt: recordedAt,
          },
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

      if (command.decision === 'approve') {
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
          referenceDoc: {
            kind: 'grn-receipt',
            grnId: row.grnId,
            ...(row.poId === null ? {} : { poId: row.poId }),
            ...(row.poLineId === null ? {} : { poLineId: row.poLineId }),
          },
        });
        if (row.poLineId !== null) {
          // Cumulative ceiling (the submit arm enforces the same): an
          // approval that would overflow the int4 column must be a 400,
          // never a SQL overflow 500 that leaves the row pending forever.
          const poLineRows = await tx
            .select({ receivedQty: purchaseOrderLines.receivedQty })
            .from(purchaseOrderLines)
            .where(eq(purchaseOrderLines.id, row.poLineId))
            .limit(1);
          if (poLineRows[0] === undefined) {
            throw grnValidation(`Purchase order line "${row.poLineId}" no longer exists.`);
          }
          if (poLineRows[0].receivedQty + row.excessQty > MAX_GRN_LINE_QTY) {
            throw grnValidation(
              `Approving would push purchase order line "${row.poLineId}" past its received-quantity ceiling of ${fromMilli(MAX_GRN_LINE_QTY)}.`,
            );
          }
          await tx
            .update(purchaseOrderLines)
            .set({
              receivedQty: sql`${purchaseOrderLines.receivedQty} + ${row.excessQty}::bigint`,
              updatedAt: decidedAt,
            })
            .where(eq(purchaseOrderLines.id, row.poLineId));
        }
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
          grnId: row.grnId,
          grnCode: grn.code,
          poId: row.poId,
          poLineId: row.poLineId,
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

  /** Every line's SKU exists in the tenant (404 naming the unknown id); returns the loaded rows. */
  private async loadSkus(
    tx: TenantTx,
    tenantId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, typeof skus.$inferSelect>> {
    const distinct = [...new Set(skuIds)];
    const rows = await tx
      .select()
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, distinct)));
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

  /** `poId: null` ⇔ `blindReasonCode` present and inside the fixed enum. */
  private validateBlindPairing(poId: string | null, blindReasonCode: string | null): string | null {
    if (poId === null) {
      if (blindReasonCode === null || !BLIND_REASON_CODES.includes(blindReasonCode as BlindReasonCode)) {
        throw grnValidation(
          `A blind receipt requires a reason code from ${JSON.stringify(BLIND_REASON_CODES)}.`,
        );
      }
      return blindReasonCode;
    }
    if (blindReasonCode !== null) {
      throw grnValidation('A receipt against a purchase order carries no blind reason code.');
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

/** The PO-state rejection (409 naming the status — the stale-receipt retraction). */
export function poNotOpen(code: string, status: string): ProblemException {
  return new ProblemException(
    'po-not-open',
    409,
    'Purchase order is not open',
    `Purchase order "${code}" is ${status} — receipts land only against an open PO.`,
  );
}