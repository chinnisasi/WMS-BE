import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  batches,
  bins,
  idempotencyKeys,
  ledgerEvents,
  serials,
  skus,
  transferOrderLines,
  transferOrders,
  type TransferOrder,
  type TransferOrderLine,
} from '../../shared/db/schema';
import { QUANTITY_SCALE, assertRecordableQuantity, fromMilli } from '../../shared/primitives/quantity';
import type { SignedQuantity } from '../../shared/primitives/quantity';
import { uuidv7 } from '../../shared/primitives/ids';
import { assertUtcIso, nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { ensureInTransitBinInTx } from '../tenancy/receiving-bin';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { uomPrecision } from '../catalog/uom';
// Story 11.4 / 5-1 — the kit-ness read, the same file-level in-tx escape the
// stock adjustment uses (catalog owns `kit_compositions`; this module cannot
// take a DI edge on `CatalogModule` without a module-evaluation cycle).
import { getKitSkuIdsInTx, kitCannotHoldStock } from '../catalog/kit.store';
import { InventoryFacade } from '../inventory/inventory.facade';

/**
 * Transfer orders (Story 5-1, FR-18/FR-29): the movements spine's first
 * occupant — a two-leg state machine (`draft → in_transit → completed`,
 * plus draft-only `cancelled`) whose legs are LEDGER events, not rows.
 *
 * The legs (spec Design Notes):
 * - **outbound confirm** — per line-arm, one `transfer.outbound` event on the
 *   SOURCE warehouse chain: `fromBinId` = the line's source bin, `toBinId` =
 *   the source warehouse's system IN-TRANSIT bin (QC-hold precedent). The
 *   units physically park there, so the serial-in-exactly-one-bin invariant
 *   survives and ATP excludes them structurally (`inTransitUnits`).
 * - **inbound confirm, same warehouse** — one `transfer.inbound` relocation
 *   event per arm: IN-TRANSIT bin → destination bin.
 * - **inbound confirm, cross-warehouse** — per arm, (a) a pure-draw drain
 *   event on the SOURCE chain (IN-TRANSIT bin → `toBinId: null`, the
 *   `pick.picked` precedent) and (b) an intake event on the DESTINATION
 *   chain (→ destination bin), in ONE transaction — a rollback rolls back
 *   BOTH chains. Locks are taken in the codebase's canonical acyclic order
 *   (putaway's documented bins-row → serial → warehouse, the
 *   `lockWarehouseInTx` doc in inventory.facade.ts): bin-row locks first,
 *   then the tenant-wide serial advisory locks sorted, then the warehouse
 *   advisory lock(s) — sorted by warehouse uuid when there are two. An
 *   advisory taken before the bin-row locks would deadlock against
 *   putaway/pick on a shared bin.
 *
 * The inbound confirm runs the destination placement gates through
 * `InventoryFacade.assertPlacementGatesInTx` — a transfer is a new stock
 * writer of the adjustment shape and MUST NOT replicate the `stock.adjust`
 * bypass (PENDING's five entries are exactly what this command refuses to
 * replicate).
 *
 * Authorization (the command-entry pattern): the capability is asserted at
 * command-service entry — a DB role read in the command's own transaction,
 * BEFORE the idempotency replay lookup — so an actor demoted after the
 * original request gets `403 role-denied`, never the snapshot. The planner
 * verbs (create / cancel / outbound confirm) take `transfers.manage`; the
 * inbound confirm is the floor verb and takes `transfers.execute` (mirroring
 * `putaway.execute`'s rationale).
 *
 * Idempotency (AD-5): the client-generated ULID key de-dupes in the same
 * transaction as the write; same key + same payload replays the original
 * response, same key + different payload is a 422 `idempotency-key-reuse`.
 * The mobile op's ULID IS the key (the spec's Boundaries).
 */
export interface TransferLineInput {
  readonly skuId: string;
  /**
   * Base UoM (story 10.2 — base on the wire, milli inside commands). The
   * conversion and the precision refusal sit BEHIND the replay lookup, in
   * the command transaction, once the SKU's declared precision is read.
   */
  readonly quantity: number;
  /** The source-side bin the units draw from (in the SOURCE warehouse). */
  readonly fromBinId: string;
  /** The PLANNED destination bin (in the DESTINATION warehouse). */
  readonly toBinId: string;
  /**
   * REQUIRED for a batch-tracked SKU — the catalog `batches.id` (the batch
   * fold needs the identity); refused on a non-batch-tracked one.
   */
  readonly batchRef?: string | undefined;
  readonly note?: string | undefined;
}

export interface CreateTransferCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly sourceWarehouseId: string;
  /** MAY equal the source (Bin→Bin). */
  readonly destWarehouseId: string;
  readonly lines: readonly TransferLineInput[];
  readonly note?: string | undefined;
  readonly occurredAt?: string | undefined;
}

/** One line's serial scan at outbound confirm — raw serial numbers, own order. */
export interface ConfirmOutboundLineInput {
  readonly lineId: string;
  /** The client's raw serial numbers — the fingerprint counterpart of the refs. */
  readonly serials?: readonly string[] | undefined;
}

export interface ConfirmOutboundCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly transferId: string;
  /**
   * Per-line serial scans, ONLY for serial-tracked lines (raw numbers, the
   * order the client scanned them — the write order, which is intent, not a
   * set). Lines not named here carry no serials (their SKU is not
   * serial-tracked, or the caller is the happy non-serial path).
   */
  readonly lines?: readonly ConfirmOutboundLineInput[] | undefined;
  readonly occurredAt?: string | undefined;
}

export interface ConfirmInboundCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly transferId: string;
  /**
   * The operator's SCANNED destination bin — authoritative when carried (the
   * pick precedent: the bin a line names is a suggestion re-derived at
   * confirm time), redirecting EVERY line there; absent, each line lands in
   * its planned `to_bin_id`.
   */
  readonly destBinId?: string | undefined;
  /**
   * The dest bin's state epoch the task read captured (pick precedent —
   * captured on the same transaction as the task). Null/absent = match (the
   * pick precedent); a carried epoch that no longer matches the landing
   * bin's live epoch is 409 `transfer-bin-changed` — the mobile client's
   * re-plannable classification.
   */
  readonly binStateEpoch?: number | null | undefined;
  readonly occurredAt?: string | undefined;
}

export interface CancelTransferCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly transferId: string;
  /** The canceller's free-text context; null when none was given. */
  readonly note?: string | undefined;
}

/** One leg event, in the transfer detail's order (base units at the edge). */
export interface TransferLegEventSnapshot {
  readonly warehouseId: string;
  readonly seq: number;
  readonly type: string;
  readonly skuId: string;
  /** The event's magnitude in BASE UoM (the wire representation). */
  readonly quantity: number;
  readonly fromBinId: string | null;
  readonly toBinId: string | null;
  readonly batchRef: string | null;
  readonly serialRef: string | null;
  readonly occurredAt: string;
}

/** The API response body (the idempotency snapshot), create/cancel shape. */
export interface TransferOrderSnapshot {
  readonly transfer: {
    readonly id: string;
    readonly status: string;
    readonly sourceWarehouseId: string;
    readonly destWarehouseId: string;
    readonly note: string | null;
    readonly createdAt: string;
  };
  readonly lines: readonly {
    readonly id: string;
    readonly skuId: string;
    readonly quantity: number;
    readonly fromBinId: string;
    readonly toBinId: string;
    readonly batchRef: string | null;
    readonly note: string | null;
  }[];
}

/** The confirm legs' response body (and the idempotent replay's stored copy). */
export interface TransferConfirmSnapshot {
  readonly transfer: {
    readonly id: string;
    readonly status: string;
    readonly confirmedAt: string;
  };
  readonly events: readonly TransferLegEventSnapshot[];
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

// ── machine-code helpers (the spec's matrix fixes these) ─────────────────────

/** Any non-draft order a planner verb meets; any non-in-transit order the inbound confirm meets. */
function transferWrongState(status: string, action: string): ProblemException {
  return new ProblemException(
    'transfer-wrong-state',
    409,
    'Transfer order is in the wrong state',
    `A transfer in status "${status}" cannot be ${action} — the legs are a fixed state machine (draft → in_transit → completed; cancel is draft-only).`,
  );
}

/** The outbound confirm's source draw-down (the order stays draft). */
function transferSourceShort(
  binCode: string,
  skuCode: string,
  available: number,
  needed: number,
): ProblemException {
  return new ProblemException(
    'transfer-source-short',
    409,
    'Source bin is short of the planned quantity',
    `Bin "${binCode}" holds ${fromMilli(available)} of the SKU but the transfer draws ${fromMilli(needed)} — the order stays draft; plan against what is on hand.`,
  );
}

/** The inbound confirm's stale-epoch refusal (the mobile re-plannable arm). */
function transferBinChanged(binCode: string, expectedEpoch: number, liveEpoch: number | null): ProblemException {
  return new ProblemException(
    'transfer-bin-changed',
    409,
    'Destination bin changed since the task was read',
    `Bin "${binCode}" is at state epoch ${liveEpoch ?? 'none'}, but the confirm quotes ${expectedEpoch} — the bin moved since the task was loaded; re-read the task and confirm again.`,
  );
}

/**
 * Resolves a serial-tracked line's raw serial numbers to the catalog
 * `serials.id` identities the ledger's serial arms carry (the pick command's
 * resolver shape — catalog owns serial identity, AD-6; this is a READ of the
 * catalog table, never a write). One refusal difference, deliberate (the
 * spec's matrix pins it): an unknown serial answers the LEDGER's machine
 * code — 404 `serial-unknown`, the same code the append guard would raise —
 * not pick's 400 `validation-failed`, because the transfer matrix's serial
 * row commits to the existing serial machine codes.
 */
async function resolveTransferSerialRefsInTx(
  tx: TenantTx,
  tenantId: string,
  skuId: string,
  serialNumbers: readonly string[],
): Promise<string[]> {
  const distinct = [...new Set(serialNumbers)];
  const rows =
    distinct.length === 0
      ? []
      : await tx
          .select({ id: serials.id, serialNumber: serials.serialNumber })
          .from(serials)
          .where(
            and(
              eq(serials.tenantId, tenantId),
              eq(serials.skuId, skuId),
              inArray(serials.serialNumber, distinct),
            ),
          );
  const byNumber = new Map(rows.map((row) => [row.serialNumber, row.id]));
  const resolved: string[] = [];
  for (const serial of serialNumbers) {
    const id = byNumber.get(serial);
    if (id === undefined) {
      throw new ProblemException(
        'serial-unknown',
        404,
        'Serial has no ledger location',
        `Serial "${serial}" does not exist for this SKU — there is nothing to draw it from.`,
      );
    }
    resolved.push(id);
  }
  return resolved;
}

/**
 * The outbound leg's serial arms, per SKU, in seq order (the
 * `qcHeldArmsInTx` precedent — the hash chain is the movement record, no
 * second source of truth). The inbound leg derives its serial arms from
 * these — PER LINE, keyed on the reference doc's `lineId` (review round 1):
 * the units that were parked are the units that arrive, so each line's
 * inbound events replay exactly ITS OWN outbound serial refs, and a serial
 * the outbound leg never scanned cannot appear at the inbound leg. Keying by
 * skuId instead would replay BOTH same-SKU lines' serials on each line —
 * the second line's drains would hit serials already drained in the same
 * transaction and the confirm would fail forever.
 *
 * All outbound events live on the one source chain, so `seq` orders them.
 */
async function transferOutboundSerialArmsByLineInTx(
  tx: TenantTx,
  tenantId: string,
  transferId: string,
): Promise<ReadonlyMap<string, string[]>> {
  const rows = await tx
    .select({
      lineId: sql<string>`${ledgerEvents.referenceDoc}->>'lineId'`,
      seq: ledgerEvents.seq,
      serialRef: ledgerEvents.serialRef,
    })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.tenantId, tenantId),
        eq(ledgerEvents.type, 'transfer.outbound'),
        // The join key the reference doc was built for (the qc.held shape);
        // the `reference_doc ? 'transferId'` qual rides along for the same
        // plan reason 0039's orderId index documents.
        sql`${ledgerEvents.referenceDoc}->>'transferId' = ${transferId}`,
      ),
    )
    .orderBy(asc(ledgerEvents.seq));
  const byLine = new Map<string, string[]>();
  for (const row of rows) {
    if (row.serialRef === null || row.lineId === null) {
      continue;
    }
    const list = byLine.get(row.lineId) ?? [];
    list.push(row.serialRef);
    byLine.set(row.lineId, list);
  }
  return byLine;
}

/**
 * The raw leg events of ONE transfer, across BOTH chains, in a stable order
 * (warehouse id, then per-warehouse seq) — the transfer detail read's
 * ledger query. `seq` is per-warehouse, so the cross-chain sort keys on the
 * warehouse first; within a chain seq is gap-free and monotonic.
 */
async function transferLegEventsInTx(
  tx: TenantTx,
  tenantId: string,
  transferId: string,
): Promise<
  readonly {
    warehouseId: string;
    seq: number;
    type: string;
    skuId: string;
    quantityDelta: number;
    fromBinId: string | null;
    toBinId: string | null;
    batchRef: string | null;
    serialRef: string | null;
    occurredAt: string;
  }[]
> {
  const rows = await tx
    .select({
      warehouseId: ledgerEvents.warehouseId,
      seq: ledgerEvents.seq,
      type: ledgerEvents.type,
      skuId: ledgerEvents.skuId,
      quantityDelta: ledgerEvents.quantityDelta,
      fromBinId: ledgerEvents.fromBinId,
      toBinId: ledgerEvents.toBinId,
      batchRef: ledgerEvents.batchRef,
      serialRef: ledgerEvents.serialRef,
      occurredAt: ledgerEvents.occurredAt,
    })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.tenantId, tenantId),
        sql`${ledgerEvents.referenceDoc}->>'transferId' = ${transferId}`,
      ),
    )
    .orderBy(asc(ledgerEvents.warehouseId), asc(ledgerEvents.seq));
  return rows;
}

@Injectable()
export class TransferService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition through the facade only (AD-6): the ledger
    // appends, the serial/warehouse locks, the epoch read and the placement
    // gates all ride the inventory facade's in-transaction passthroughs.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  // ── createTransfer ───────────────────────────────────────────────────────

  /**
   * The create fingerprint over the command's business fields (fixed key
   * order — see `hashCommandPayload`). The lines fingerprint the RAW request
   * body in the client's own order — a retry must replay on the same body.
   */
  createFingerprint(command: CreateTransferCommand): string {
    return hashCommandPayload({
      tenantId: command.tenantId,
      sourceWarehouseId: command.sourceWarehouseId,
      destWarehouseId: command.destWarehouseId,
      note: command.note,
      occurredAt: command.occurredAt,
      lines: command.lines.map((line) => ({
        skuId: line.skuId,
        quantity: line.quantity,
        fromBinId: line.fromBinId,
        toBinId: line.toBinId,
        batchRef: line.batchRef,
        note: line.note,
      })),
    });
  }

  async createTransfer(
    command: CreateTransferCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: TransferOrderSnapshot; replayed: boolean }> {
    // Shape checks above the transaction: business time validation (the
    // primitive throws a plain error — mapped to 400 here so it never
    // renders as 500) and the line-list minimum (a transfer with no lines
    // moves nothing — noise, refused like the zero-delta adjustment).
    let occurredAt: string;
    if (command.occurredAt === undefined) {
      occurredAt = nowIso();
    } else {
      try {
        occurredAt = assertUtcIso(command.occurredAt);
      } catch {
        throw new ProblemException(
          'validation-failed',
          400,
          'occurredAt must be a valid ISO-8601 UTC instant',
          `occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${command.occurredAt}").`,
        );
      }
    }
    if (command.lines.length === 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'A transfer needs at least one line',
        'A transfer order moves a non-zero quantity of at least one SKU — an empty line list writes nothing.',
      );
    }
    for (const line of command.lines) {
      if (!(line.quantity > 0)) {
        throw new ProblemException(
          'validation-failed',
          400,
          'Line quantity must be a positive number',
          `The line for SKU "${line.skuId}" carries quantity ${line.quantity} — a transfer line moves a positive quantity.`,
        );
      }
    }

    const payloadHash = this.createFingerprint(command);

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry — DB read, same tx, BEFORE the
        // replay lookup (the deliberate fail-closed carve-out).
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'transfers.manage',
        );

        const existing = await this.lookupIdempotencyKey(tx, command.tenantId, idempotencyKey);
        if (existing !== undefined) {
          if (existing.payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing.responseSnapshot as TransferOrderSnapshot,
            replayed: true,
          };
        }

        // Master-data integrity (no-FK convention): both warehouses in the
        // tenant — a foreign or nonexistent scope is 404 before any write.
        // Same-warehouse (Bin→Bin) is legal and passes both asserts.
        await assertWarehouseInTenant(tx, command.tenantId, command.sourceWarehouseId);
        await assertWarehouseInTenant(tx, command.tenantId, command.destWarehouseId);

        // Per line: the scope asserts and the SKU-row rules. The bins are
        // integrity-only reads (404 before any write); a SYSTEM bin is
        // refused on both ends — the system bins (Receiving / QC-hold /
        // In-Transit) are moved only by their owning commands, and a
        // transfer line naming one would park or draw stock no command owns.
        const skuIds = [...new Set(command.lines.map((line) => line.skuId))];
        const skuRows = await tx
          .select({
            id: skus.id,
            code: skus.code,
            uom: skus.uom,
            batchTracked: skus.batchTracked,
            serialTracked: skus.serialTracked,
            catchWeightTracked: skus.catchWeightTracked,
          })
          .from(skus)
          .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.id, skuIds)))
          .for('update');
        const skuById = new Map(skuRows.map((row) => [row.id, row]));
        for (const skuId of skuIds) {
          if (!skuById.has(skuId)) {
            throw new ProblemException(
              'not-found',
              404,
              'SKU not found',
              `No SKU with id "${skuId}" exists in this tenant.`,
            );
          }
        }

        const binIds = [
          ...new Set(command.lines.flatMap((line) => [line.fromBinId, line.toBinId])),
        ];
        const binRows = await tx
          .select({
            id: bins.id,
            warehouseId: bins.warehouseId,
            code: bins.code,
            systemOwned: bins.systemOwned,
          })
          .from(bins)
          .where(and(eq(bins.tenantId, command.tenantId), inArray(bins.id, binIds)));
        const binById = new Map(binRows.map((row) => [row.id, row]));
        for (const line of command.lines) {
          const from = binById.get(line.fromBinId);
          if (from === undefined || from.warehouseId !== command.sourceWarehouseId) {
            throw new ProblemException(
              'not-found',
              404,
              'Source bin not found',
              `No bin with id "${line.fromBinId}" exists in the source warehouse.`,
            );
          }
          const to = binById.get(line.toBinId);
          if (to === undefined || to.warehouseId !== command.destWarehouseId) {
            throw new ProblemException(
              'not-found',
              404,
              'Destination bin not found',
              `No bin with id "${line.toBinId}" exists in the destination warehouse.`,
            );
          }
          if (from.systemOwned) {
            throw new ProblemException(
              'validation-failed',
              400,
              'Source bin is a system bin',
              `Bin "${from.code}" is a system bin (Receiving/QC-hold/In-Transit) — a transfer draws from storage bins only; the system bins are moved by their own commands.`,
            );
          }
          if (to.systemOwned) {
            throw new ProblemException(
              'validation-failed',
              400,
              'Destination bin is a system bin',
              `Bin "${to.code}" is a system bin (Receiving/QC-hold/In-Transit) — transfer intake lands in storage bins only.`,
            );
          }
        }

        // The per-SKU tracking rules (the kit and the tracking-arm shape).
        const kitSkuIds = await getKitSkuIdsInTx(tx, command.tenantId, skuIds);
        const kitCodes = kitSkuIds
          .map((id) => skuById.get(id)?.code)
          .filter((code): code is string => code !== undefined);
        if (kitCodes.length > 0) {
          throw kitCannotHoldStock('transfer', kitCodes);
        }

        // Batch identity: a batch-tracked line's `batchRef` must resolve to
        // a real catalog batch in this tenant (404 otherwise — a foreign id
        // must never reveal that it resolves elsewhere).
        const batchRefIds = [
          ...new Set(
            command.lines
              .map((line) => line.batchRef)
              .filter((ref): ref is string => ref !== undefined && ref !== null),
          ),
        ];
        const batchRows =
          batchRefIds.length === 0
            ? []
            : await tx
                .select({ id: batches.id })
                .from(batches)
                .where(and(eq(batches.tenantId, command.tenantId), inArray(batches.id, batchRefIds)));
        const knownBatchIds = new Set(batchRows.map((row) => row.id));

        // Everything above this line is in base units; everything below is
        // in milli-units. The conversion + precision refusal sit HERE
        // (behind the replay lookup — story 10.2's placement rule): only the
        // precision rule can tighten, so only it moved behind the replay.
        const milliByIndex = new Map<number, number>();
        for (const [index, line] of command.lines.entries()) {
          const sku = skuById.get(line.skuId)!;
          // Fail-closed arms (the epic's taxonomy): a catch-weight SKU has
          // no representation here (a transfer names no handling units —
          // intake outside receipt is deferred, the stock.adjust answer);
          // both-batch-and-serial-tracked is refused (the pick precedent —
          // picking it is not in this release either).
          if (sku.catchWeightTracked) {
            throw new ProblemException(
              'validation-failed',
              400,
              'A catch-weight SKU cannot be transferred',
              `SKU "${sku.code}" is catch-weight tracked: every unit carries a captured weight, and a transfer line names no handling units. Move catch-weight stock through receipt and pick instead.`,
            );
          }
          if (sku.batchTracked && sku.serialTracked) {
            throw new ProblemException(
              'validation-failed',
              400,
              'A batch- and serial-tracked SKU cannot be transferred',
              `SKU "${sku.code}" is both batch- and serial-tracked — transferring it is not in this release (the pick precedent); move it through pick and putaway.`,
            );
          }
          if (sku.batchTracked && (line.batchRef === undefined || line.batchRef === null)) {
            throw new ProblemException(
              'validation-failed',
              400,
              'A batch-tracked line must name its batch',
              `SKU "${sku.code}" is batch-tracked — the line must carry the catalog batch identity the fold keys on.`,
            );
          }
          if (!sku.batchTracked && line.batchRef !== undefined && line.batchRef !== null) {
            throw new ProblemException(
              'validation-failed',
              400,
              'SKU is not batch-tracked',
              `SKU "${sku.code}" is not batch-tracked — the line's batchRef is refused rather than ignored.`,
            );
          }
          if (sku.batchTracked && line.batchRef !== undefined && !knownBatchIds.has(line.batchRef)) {
            throw new ProblemException(
              'not-found',
              404,
              'Batch not found',
              `No batch with id "${line.batchRef}" exists in this tenant.`,
            );
          }
          milliByIndex.set(
            index,
            assertRecordableQuantity(line.quantity, 'quantity', sku.uom, uomPrecision(sku.uom)),
          );
          if (sku.serialTracked) {
            // The serial-tracked line's scannability guards (review round 1):
            // a serial line moves ONE unit per scanned serial, so its
            // base-unit quantity must be a whole number (a fractional draft
            // can never pass the outbound confirm's integer unit-count
            // check) and at most 200 (the per-confirm serial cap,
            // `ConfirmOutboundLineDto`'s `@ArrayMaxSize(200)` — a larger
            // draft can never supply enough scans). Both belong at create,
            // where the draft can be corrected.
            const unitCount = milliByIndex.get(index)! / QUANTITY_SCALE;
            if (!Number.isInteger(unitCount)) {
              throw new ProblemException(
                'validation-failed',
                400,
                'A serial-tracked line moves whole units',
                `SKU "${sku.code}" is serial-tracked — the line moves ${line.quantity} base unit(s), and serials scan one per whole unit; use a whole-unit quantity.`,
              );
            }
            if (unitCount > 200) {
              throw new ProblemException(
                'validation-failed',
                400,
                'A serial-tracked line exceeds the serial cap',
                `SKU "${sku.code}" is serial-tracked and the line moves ${unitCount} unit(s) — a confirm supplies at most 200 serial scans; split the transfer into smaller orders.`,
              );
            }
          }
        }

        // ── writes (order + lines) ────────────────────────────────────────
        const orderId = uuidv7();
        await tx.insert(transferOrders).values({
          id: orderId,
          tenantId: command.tenantId,
          sourceWarehouseId: command.sourceWarehouseId,
          destWarehouseId: command.destWarehouseId,
          status: 'draft',
          note: command.note ?? null,
          createdBy: command.actorUserId,
        });
        const lineValues = command.lines.map((line, index) => ({
          id: uuidv7(),
          tenantId: command.tenantId,
          transferId: orderId,
          skuId: line.skuId,
          quantity: milliByIndex.get(index)!,
          fromBinId: line.fromBinId,
          toBinId: line.toBinId,
          batchRef: line.batchRef ?? null,
          note: line.note ?? null,
        }));
        await tx.insert(transferOrderLines).values(lineValues);

        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'transfer.created',
          occurredAt,
          payload: {
            transferId: orderId,
            sourceWarehouseId: command.sourceWarehouseId,
            destWarehouseId: command.destWarehouseId,
            lineCount: lineValues.length,
          },
        });

        const snapshot = await this.orderSnapshotInTx(tx, command.tenantId, orderId);

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snapshot,
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent idempotent request',
              'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
        return { snapshot, replayed: false };
      },
    );

    return { snapshot, replayed };
  }

  // ── confirmOutbound ──────────────────────────────────────────────────────

  /**
   * The outbound fingerprint. The per-line serial scans fingerprint RAW (the
   * client's scanned numbers, in scan order — the order the ledger writes
   * one event per serial in, which is intent, not a set; the
   * `stock.adjustment` precedent) and only for the lines the client named,
   * so a non-serial confirm hashes byte-identically to its fieldless shape.
   */
  outboundFingerprint(command: ConfirmOutboundCommand): string {
    return hashCommandPayload({
      transferId: command.transferId,
      occurredAt: command.occurredAt,
      lines: (command.lines ?? []).map((line) => ({
        lineId: line.lineId,
        serials: line.serials == null ? undefined : [...line.serials],
      })),
    });
  }

  async confirmOutbound(
    command: ConfirmOutboundCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: TransferConfirmSnapshot; replayed: boolean }> {
    let occurredAt: string;
    if (command.occurredAt === undefined) {
      occurredAt = nowIso();
    } else {
      try {
        occurredAt = assertUtcIso(command.occurredAt);
      } catch {
        throw new ProblemException(
          'validation-failed',
          400,
          'occurredAt must be a valid ISO-8601 UTC instant',
          `occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${command.occurredAt}").`,
        );
      }
    }
    // Shape check above the transaction: a named line's serial list carries
    // non-empty numbers (an empty scan is a client bug, not a state).
    for (const line of command.lines ?? []) {
      for (const serial of line.serials ?? []) {
        if (typeof serial !== 'string' || serial.length === 0) {
          throw new ProblemException(
            'validation-failed',
            400,
            'Serial scans must be non-empty',
            `The serial scan for line "${line.lineId}" carries an empty serial number.`,
          );
        }
      }
    }

    const payloadHash = this.outboundFingerprint(command);

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'transfers.manage',
        );

        const existing = await this.lookupIdempotencyKey(tx, command.tenantId, idempotencyKey);
        if (existing !== undefined) {
          if (existing.payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing.responseSnapshot as TransferConfirmSnapshot,
            replayed: true,
          };
        }

        // The order row, LOCKED — the state machine's mutex (two concurrent
        // confirms of one order must serialize, and the loser reads the
        // winner's committed status).
        const order = await this.lockOrderInTx(tx, command.tenantId, command.transferId);
        if (order.status !== 'draft') {
          throw transferWrongState(order.status, 'outbound-confirmed');
        }

        const lines = await this.readLinesInTx(tx, command.tenantId, command.transferId);

        // Resolve the client's per-line serial scans (unknown line → 400).
        const serialsByLineId = new Map<string, string[]>();
        for (const named of command.lines ?? []) {
          if (!lines.some((line) => line.id === named.lineId)) {
            throw new ProblemException(
              'validation-failed',
              400,
              'Unknown transfer line',
              `No line with id "${named.lineId}" exists on transfer ${command.transferId}.`,
            );
          }
          serialsByLineId.set(named.lineId, [...(named.serials ?? [])]);
        }

        // Per line: the SKU row (locked, the kit-create race) and the
        // serial-tracked line's scans. The kit/catch-weight refusals repeat
        // the create-time guards DELIBERATELY: the SKU row can change
        // between create and confirm (a kit created against a drafted
        // line's SKU, a catch-weight flip via sku.edit), and the confirm is
        // the write that must not land on a SKU that cannot hold stock.
        const skuIds = [...new Set(lines.map((line) => line.skuId))];
        const skuRows = await tx
          .select({
            id: skus.id,
            code: skus.code,
            batchTracked: skus.batchTracked,
            serialTracked: skus.serialTracked,
            catchWeightTracked: skus.catchWeightTracked,
          })
          .from(skus)
          .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.id, skuIds)))
          .for('update');
        const skuById = new Map(skuRows.map((row) => [row.id, row]));
        const kitSkuIds = await getKitSkuIdsInTx(tx, command.tenantId, skuIds);
        const kitCodes = kitSkuIds
          .map((id) => skuById.get(id)?.code)
          .filter((code): code is string => code !== undefined);
        if (kitCodes.length > 0) {
          throw kitCannotHoldStock('transfer', kitCodes);
        }
        for (const line of lines) {
          const sku = skuById.get(line.skuId)!;
          if (sku.catchWeightTracked) {
            throw new ProblemException(
              'validation-failed',
              400,
              'A catch-weight SKU cannot be transferred',
              `SKU "${sku.code}" is catch-weight tracked — the transfer cannot be confirmed; create a compensating order instead.`,
            );
          }
          if (sku.serialTracked) {
            const scans = serialsByLineId.get(line.id) ?? [];
            const unitCount = line.quantity / QUANTITY_SCALE;
            if (!Number.isInteger(unitCount) || scans.length !== unitCount) {
              throw new ProblemException(
                'validation-failed',
                400,
                'Serial count must match the line quantity',
                `The serial-tracked line for SKU "${sku.code}" moves ${fromMilli(line.quantity)} unit(s) — it needs exactly that many serial scans (got ${scans.length}).`,
              );
            }
            if (new Set(scans).size !== scans.length) {
              throw new ProblemException(
                'validation-failed',
                400,
                'Serial scans repeat a serial',
                `The serial-tracked line for SKU "${sku.code}" lists the same serial twice — one serial moves one unit.`,
              );
            }
          }
        }

        // Locks, in the codebase's canonical acyclic order (putaway's
        // documented bins-row → serial → warehouse, inventory.facade.ts's
        // lockWarehouseInTx doc): the source bin rows sorted by uuid, then
        // the whole serial set tenant-wide sorted. The source warehouse
        // advisory comes LAST — the first append acquires it inside
        // `appendLedgerEventInTx` (a re-entrant no-op for the serial locks),
        // exactly like putaway; acquiring it here, before the bin-row
        // locks, would invert the order and deadlock against putaway/pick
        // on a shared bin (both hold the bin row and block on the advisory
        // inside their own append while this command holds the advisory and
        // blocks on the bin row).
        const fromBinIds = [...new Set(lines.map((line) => line.fromBinId))].sort();
        await tx
          .select({ id: bins.id })
          .from(bins)
          .where(and(eq(bins.tenantId, command.tenantId), inArray(bins.id, fromBinIds)))
          .for('update');
        const serialRefsByLine = new Map<string, string[]>();
        const allSerialRefs: string[] = [];
        for (const line of lines) {
          const sku = skuById.get(line.skuId)!;
          if (!sku.serialTracked) {
            continue;
          }
          const refs = await resolveTransferSerialRefsInTx(
            tx,
            command.tenantId,
            line.skuId,
            serialsByLineId.get(line.id) ?? [],
          );
          serialRefsByLine.set(line.id, refs);
          allSerialRefs.push(...refs);
        }
        if (allSerialRefs.length > 0) {
          await this.inventory.lockSerialsInTx(tx, command.tenantId, allSerialRefs);
        }

        // The source-short guard (the matrix's 409, order stays draft):
        // aggregate the planned draw per (sku, bin) — and per (sku, bin,
        // batch) for a batch-tracked line, because the batch fold keys on
        // the lot — and compare against what is on hand. The ledger's own
        // `insufficient-on-hand` 422 stays the backstop; this guard is the
        // transfer's OWN answer naming the machine code the spec fixed.
        // Serial-tracked lines skip the quantity probe: the serial guards
        // (serial-elsewhere / serial-unknown) are the per-unit authority.
        const drawByScope = new Map<string, number>();
        for (const line of lines) {
          const sku = skuById.get(line.skuId)!;
          if (sku.serialTracked) {
            continue;
          }
          const key = `${line.skuId}|${line.fromBinId}`;
          drawByScope.set(key, (drawByScope.get(key) ?? 0) + line.quantity);
        }
        if (drawByScope.size > 0) {
          const onHand = await this.inventory.stockByBinsInTx(
            tx,
            command.tenantId,
            order.sourceWarehouseId,
            [...new Set(lines.map((line) => line.skuId))],
          );
          const availableByScope = new Map<string, number>(
            onHand.map((row) => [`${row.skuId}|${row.binId}`, row.quantity] as const),
          );
          for (const key of drawByScope.keys()) {
            const [skuId, binId] = key.split('|');
            if ((availableByScope.get(key) ?? 0) < drawByScope.get(key)!) {
              const binRows = await tx
                .select({ code: bins.code })
                .from(bins)
                .where(and(eq(bins.tenantId, command.tenantId), eq(bins.id, binId!)))
                .limit(1);
              throw transferSourceShort(
                binRows[0]?.code ?? binId!,
                skuById.get(skuId!)?.code ?? skuId!,
                availableByScope.get(key) ?? 0,
                drawByScope.get(key)!,
              );
            }
          }
        }
        const batchDrawByScope = new Map<string, number>();
        for (const line of lines) {
          const sku = skuById.get(line.skuId)!;
          if (!sku.batchTracked || line.batchRef === null) {
            continue;
          }
          const key = `${line.skuId}|${line.fromBinId}|${line.batchRef}`;
          batchDrawByScope.set(key, (batchDrawByScope.get(key) ?? 0) + line.quantity);
        }
        if (batchDrawByScope.size > 0) {
          const batchRows = await this.inventory.batchOnHandByBinsInTx(
            tx,
            command.tenantId,
            order.sourceWarehouseId,
            [...new Set(lines.map((line) => line.skuId))],
          );
          const availableByScope = new Map<string, number>(
            batchRows.map(
              (row) => [`${row.skuId}|${row.binId}|${row.batchId}`, row.quantity] as const,
            ),
          );
          for (const [key, needed] of batchDrawByScope) {
            if ((availableByScope.get(key) ?? 0) < needed) {
              const [skuId, binId] = key.split('|');
              const binRows = await tx
                .select({ code: bins.code })
                .from(bins)
                .where(and(eq(bins.tenantId, command.tenantId), eq(bins.id, binId!)))
                .limit(1);
              throw transferSourceShort(
                binRows[0]?.code ?? binId!,
                skuById.get(skuId!)?.code ?? skuId!,
                availableByScope.get(key) ?? 0,
                needed,
              );
            }
          }
        }

        // The parking spot: the source warehouse's system IN-TRANSIT bin
        // (migration 0043 seeded it; this ensure re-selects or creates it —
        // idempotent, QC-hold precedent).
        const inTransit = await ensureInTransitBinInTx(
          tx,
          command.tenantId,
          order.sourceWarehouseId,
        );

        // ── the outbound leg: one relocation event per arm on the SOURCE
        // chain (source bin → IN-TRANSIT bin), serial-tracked arms one event
        // per unit. The magnitude folds BOTH projections (the two-arm
        // relocation shape the putaway placement event established).
        const events: TransferLegEventSnapshot[] = [];
        for (const line of lines) {
          const serialRefs = serialRefsByLine.get(line.id) ?? [];
          const referenceDoc = {
            kind: 'transfer' as const,
            transferId: command.transferId,
            lineId: line.id,
          };
          const arms: { quantityDelta: SignedQuantity; serialRef: string | null }[] =
            serialRefs.length > 0
              ? serialRefs.map((ref) => ({
                  quantityDelta: QUANTITY_SCALE as SignedQuantity,
                  serialRef: ref,
                }))
              : [{ quantityDelta: line.quantity as SignedQuantity, serialRef: null }];
          for (const arm of arms) {
            const appended = await this.inventory.appendLedgerEventInTx(tx, {
              tenantId: command.tenantId,
              warehouseId: order.sourceWarehouseId,
              type: 'transfer.outbound',
              skuId: line.skuId,
              quantityDelta: arm.quantityDelta,
              fromBinId: line.fromBinId,
              toBinId: inTransit.binId,
              batchRef: line.batchRef,
              serialRef: arm.serialRef,
              actorUserId: command.actorUserId,
              occurredAt,
              recordedAt: nowIso(),
              referenceDoc,
            });
            events.push({
              warehouseId: order.sourceWarehouseId,
              seq: appended.seq,
              type: 'transfer.outbound',
              skuId: line.skuId,
              quantity: fromMilli(Math.abs(arm.quantityDelta)),
              fromBinId: line.fromBinId,
              toBinId: inTransit.binId,
              batchRef: line.batchRef,
              serialRef: arm.serialRef,
              occurredAt: appended.occurredAt,
            });
          }
        }

        await tx
          .update(transferOrders)
          .set({
            status: 'in_transit',
            outboundConfirmedBy: command.actorUserId,
            outboundConfirmedAt: occurredAt,
          })
          .where(
            and(eq(transferOrders.tenantId, command.tenantId), eq(transferOrders.id, command.transferId)),
          );

        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'transfer.outbound-confirmed',
          occurredAt,
          payload: {
            transferId: command.transferId,
            sourceWarehouseId: order.sourceWarehouseId,
            destWarehouseId: order.destWarehouseId,
          },
        });

        const snapshot: TransferConfirmSnapshot = {
          transfer: {
            id: command.transferId,
            status: 'in_transit',
            confirmedAt: occurredAt,
          },
          events,
        };

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snapshot,
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent idempotent request',
              'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
        return { snapshot, replayed: false };
      },
    );

    return { snapshot, replayed };
  }

  // ── confirmInbound ───────────────────────────────────────────────────────

  /**
   * The inbound fingerprint: the confirm's own inputs — the scanned dest bin
   * and the epoch the task read quoted. Null/absent normalize to absent (the
   * pick precedent: a null epoch on the op means "match"), so a retry that
   * omitted the epoch replays rather than 422s.
   */
  inboundFingerprint(command: ConfirmInboundCommand): string {
    return hashCommandPayload({
      transferId: command.transferId,
      destBinId: command.destBinId,
      binStateEpoch: command.binStateEpoch == null ? undefined : command.binStateEpoch,
      occurredAt: command.occurredAt,
    });
  }

  async confirmInbound(
    command: ConfirmInboundCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: TransferConfirmSnapshot; replayed: boolean }> {
    let occurredAt: string;
    if (command.occurredAt === undefined) {
      occurredAt = nowIso();
    } else {
      try {
        occurredAt = assertUtcIso(command.occurredAt);
      } catch {
        throw new ProblemException(
          'validation-failed',
          400,
          'occurredAt must be a valid ISO-8601 UTC instant',
          `occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${command.occurredAt}").`,
        );
      }
    }

    const payloadHash = this.inboundFingerprint(command);

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // The floor verb — the actor's role is re-read per AD-10, and the
        // placement gates below rule on the SAME role read.
        const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
        assertPermission(role, 'transfers.execute');

        const existing = await this.lookupIdempotencyKey(tx, command.tenantId, idempotencyKey);
        if (existing !== undefined) {
          if (existing.payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing.responseSnapshot as TransferConfirmSnapshot,
            replayed: true,
          };
        }

        const order = await this.lockOrderInTx(tx, command.tenantId, command.transferId);
        if (order.status !== 'in_transit') {
          throw transferWrongState(order.status, 'inbound-confirmed');
        }

        const lines = await this.readLinesInTx(tx, command.tenantId, command.transferId);

        // The landing bins: the scanned bin is authoritative when carried
        // (redirecting every line — the pick's suggestion precedent);
        // absent, each line lands in its planned to_bin_id. A landing bin
        // must exist in the DEST warehouse (404 — the scanned bin's scope).
        const landingBinByLine = new Map<string, string>();
        for (const line of lines) {
          landingBinByLine.set(line.id, command.destBinId ?? line.toBinId);
        }
        const landingBinIds = [...new Set(landingBinByLine.values())].sort();

        // Locks, in the codebase's canonical acyclic order (putaway's
        // documented bins-row → serial → warehouse, inventory.facade.ts's
        // lockWarehouseInTx doc): the landing bin rows sorted by uuid first,
        // then the inbound serial arms' whole serial set tenant-wide sorted,
        // then the warehouse advisory lock(s) — sorted by warehouse uuid
        // when there are two (a same-warehouse transfer's single lock
        // trivially satisfies it). The append re-acquires each as a
        // re-entrant no-op; acquiring an advisory before the bin-row locks
        // would invert the order and deadlock against putaway/pick on a
        // shared bin (both hold the bin row and block on the advisory
        // inside their own append while this command holds the advisory
        // and blocks on the bin row).
        const landingBinRows = await tx
          .select({ id: bins.id, code: bins.code })
          .from(bins)
          .where(
            and(
              eq(bins.tenantId, command.tenantId),
              eq(bins.warehouseId, order.destWarehouseId),
              inArray(bins.id, landingBinIds),
            ),
          )
          .for('update');
        const landingBinCode = new Map(landingBinRows.map((row) => [row.id, row.code]));
        for (const binId of landingBinIds) {
          if (!landingBinCode.has(binId)) {
            throw new ProblemException(
              'not-found',
              404,
              'Destination bin not found',
              `No bin with id "${binId}" exists in the destination warehouse.`,
            );
          }
        }

        // The inbound serial arms derive from the outbound leg's own events
        // — PER LINE, keyed on the reference doc's lineId (a same-SKU
        // keying would replay both same-SKU lines' serials on each line) —
        // locked tenant-wide in sorted order before the first append.
        const outboundSerialArms = await transferOutboundSerialArmsByLineInTx(
          tx,
          command.tenantId,
          command.transferId,
        );
        const allSerialRefs = [...outboundSerialArms.values()].flat();
        if (allSerialRefs.length > 0) {
          await this.inventory.lockSerialsInTx(tx, command.tenantId, allSerialRefs);
        }

        const warehouseIds = [...new Set([order.sourceWarehouseId, order.destWarehouseId])].sort();
        for (const warehouseId of warehouseIds) {
          await this.inventory.lockWarehouseInTx(tx, command.tenantId, warehouseId);
        }

        // The epoch gate (the matrix's re-plannable refusal): the op's
        // epoch, quoted from the task read, must still be the landing bins'
        // live epoch — captured on the same transaction as the task (the
        // pick precedent). The read and compare sit UNDER the locks: an
        // epoch read taken before them would race a concurrent
        // epoch-bumping write between read and lock, and a staleness gate
        // that read a pre-lock epoch would slip a genuinely moved bin past
        // the refusal. Absent on the op = match.
        if (command.binStateEpoch != null) {
          const epochs = await this.inventory.binStateEpochsInTx(
            tx,
            command.tenantId,
            order.destWarehouseId,
            landingBinIds,
          );
          for (const binId of landingBinIds) {
            const live = epochs.get(binId) ?? null;
            if (live !== command.binStateEpoch) {
              throw transferBinChanged(landingBinCode.get(binId)!, command.binStateEpoch, live);
            }
          }
        }

        // The kit/catch-weight refusals repeat the create/outbound guards
        // DELIBERATELY (the outbound confirm's own rationale): the SKU row
        // can flip between the outbound confirm and the inbound confirm (a
        // kit created against the parked line's SKU, a catch-weight flip
        // via sku.edit), and the inbound confirm is the write that would
        // land the unrepresentable stock — parked units are exactly the
        // stock these guards exist to keep out.
        const skuIds = [...new Set(lines.map((line) => line.skuId))];
        const skuRows = await tx
          .select({ id: skus.id, code: skus.code, catchWeightTracked: skus.catchWeightTracked })
          .from(skus)
          .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.id, skuIds)))
          .for('update');
        const skuById = new Map(skuRows.map((row) => [row.id, row]));
        const kitSkuIds = await getKitSkuIdsInTx(tx, command.tenantId, skuIds);
        const kitCodes = kitSkuIds
          .map((id) => skuById.get(id)?.code)
          .filter((code): code is string => code !== undefined);
        if (kitCodes.length > 0) {
          throw kitCannotHoldStock('transfer', kitCodes);
        }
        for (const line of lines) {
          const sku = skuById.get(line.skuId)!;
          if (sku.catchWeightTracked) {
            throw new ProblemException(
              'validation-failed',
              400,
              'A catch-weight SKU cannot be transferred',
              `SKU "${sku.code}" is catch-weight tracked — the transfer cannot be confirmed; create a compensating order instead.`,
            );
          }
        }

        // The placement gates, ONE call per landing bin with the SUMMED
        // intake per SKU (two lines of one SKU into one bin are one gate
        // answer and the capacity read carries the whole planned intake).
        // The refusal is 409 with the gate's own machine code (the matrix
        // fixes the status; putaway's refusals of the same codes answer 400
        // on its own surface), and `assertSecureBinAuthority` keeps its 403
        // shape — a (role, bin) authority answer.
        const intakeByBin = new Map<string, { skuId: string; qtyMilli: number }[]>();
        for (const line of lines) {
          const binId = landingBinByLine.get(line.id)!;
          const intakes = intakeByBin.get(binId) ?? [];
          intakes.push({ skuId: line.skuId, qtyMilli: line.quantity });
          intakeByBin.set(binId, intakes);
        }
        for (const binId of landingBinIds) {
          await this.inventory.assertPlacementGatesInTx(tx, {
            tenantId: command.tenantId,
            warehouseId: order.destWarehouseId,
            binId,
            intakes: intakeByBin.get(binId)!,
            role,
          });
        }

        // ── the inbound leg ───────────────────────────────────────────────
        const sameWarehouse = order.sourceWarehouseId === order.destWarehouseId;
        const inTransit = await ensureInTransitBinInTx(
          tx,
          command.tenantId,
          order.sourceWarehouseId,
        );
        const events: TransferLegEventSnapshot[] = [];
        for (const line of lines) {
          const landingBinId = landingBinByLine.get(line.id)!;
          const referenceDoc = {
            kind: 'transfer' as const,
            transferId: command.transferId,
            lineId: line.id,
          };
          const serialRefs = outboundSerialArms.get(line.id) ?? [];
          if (sameWarehouse) {
            // One relocation event per arm on the single chain: IN-TRANSIT
            // bin → destination bin.
            const arms: { quantityDelta: SignedQuantity; serialRef: string | null }[] =
              serialRefs.length > 0
                ? serialRefs.map((ref) => ({
                    quantityDelta: QUANTITY_SCALE as SignedQuantity,
                    serialRef: ref,
                  }))
                : [{ quantityDelta: line.quantity as SignedQuantity, serialRef: null }];
            for (const arm of arms) {
              const appended = await this.inventory.appendLedgerEventInTx(tx, {
                tenantId: command.tenantId,
                warehouseId: order.sourceWarehouseId,
                type: 'transfer.inbound',
                skuId: line.skuId,
                quantityDelta: arm.quantityDelta,
                fromBinId: inTransit.binId,
                toBinId: landingBinId,
                batchRef: line.batchRef,
                serialRef: arm.serialRef,
                actorUserId: command.actorUserId,
                occurredAt,
                recordedAt: nowIso(),
                referenceDoc,
              });
              events.push({
                warehouseId: order.sourceWarehouseId,
                seq: appended.seq,
                type: 'transfer.inbound',
                skuId: line.skuId,
                quantity: fromMilli(Math.abs(arm.quantityDelta)),
                fromBinId: inTransit.binId,
                toBinId: landingBinId,
                batchRef: line.batchRef,
                serialRef: arm.serialRef,
                occurredAt: appended.occurredAt,
              });
            }
          } else {
            // Cross-warehouse: the drain (pure draw on the SOURCE chain —
            // `pick.picked` precedent, toBin null) and the intake (pure
            // intake on the DEST chain) in ONE transaction; a rollback rolls
            // back BOTH chains. Serial arms ride both halves (draw then
            // intake), one event per serial per half.
            const drawArms: { quantityDelta: SignedQuantity; serialRef: string | null }[] =
              serialRefs.length > 0
                ? serialRefs.map((ref) => ({
                    quantityDelta: -QUANTITY_SCALE as SignedQuantity,
                    serialRef: ref,
                  }))
                : [{ quantityDelta: -line.quantity as SignedQuantity, serialRef: null }];
            for (const arm of drawArms) {
              const appended = await this.inventory.appendLedgerEventInTx(tx, {
                tenantId: command.tenantId,
                warehouseId: order.sourceWarehouseId,
                type: 'transfer.inbound',
                skuId: line.skuId,
                quantityDelta: arm.quantityDelta,
                fromBinId: inTransit.binId,
                toBinId: null,
                batchRef: line.batchRef,
                serialRef: arm.serialRef,
                actorUserId: command.actorUserId,
                occurredAt,
                recordedAt: nowIso(),
                referenceDoc,
              });
              events.push({
                warehouseId: order.sourceWarehouseId,
                seq: appended.seq,
                type: 'transfer.inbound',
                skuId: line.skuId,
                quantity: fromMilli(Math.abs(arm.quantityDelta)),
                fromBinId: inTransit.binId,
                toBinId: null,
                batchRef: line.batchRef,
                serialRef: arm.serialRef,
                occurredAt: appended.occurredAt,
              });
            }
            const intakeArms: { quantityDelta: SignedQuantity; serialRef: string | null }[] =
              serialRefs.length > 0
                ? serialRefs.map((ref) => ({
                    quantityDelta: QUANTITY_SCALE as SignedQuantity,
                    serialRef: ref,
                  }))
                : [{ quantityDelta: line.quantity as SignedQuantity, serialRef: null }];
            for (const arm of intakeArms) {
              const appended = await this.inventory.appendLedgerEventInTx(tx, {
                tenantId: command.tenantId,
                warehouseId: order.destWarehouseId,
                type: 'transfer.inbound',
                skuId: line.skuId,
                quantityDelta: arm.quantityDelta,
                fromBinId: null,
                toBinId: landingBinId,
                batchRef: line.batchRef,
                serialRef: arm.serialRef,
                actorUserId: command.actorUserId,
                occurredAt,
                recordedAt: nowIso(),
                referenceDoc,
              });
              events.push({
                warehouseId: order.destWarehouseId,
                seq: appended.seq,
                type: 'transfer.inbound',
                skuId: line.skuId,
                quantity: fromMilli(Math.abs(arm.quantityDelta)),
                fromBinId: null,
                toBinId: landingBinId,
                batchRef: line.batchRef,
                serialRef: arm.serialRef,
                occurredAt: appended.occurredAt,
              });
            }
          }
        }

        await tx
          .update(transferOrders)
          .set({
            status: 'completed',
            inboundConfirmedBy: command.actorUserId,
            inboundConfirmedAt: occurredAt,
          })
          .where(
            and(eq(transferOrders.tenantId, command.tenantId), eq(transferOrders.id, command.transferId)),
          );

        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'transfer.inbound-confirmed',
          occurredAt,
          payload: {
            transferId: command.transferId,
            sourceWarehouseId: order.sourceWarehouseId,
            destWarehouseId: order.destWarehouseId,
          },
        });

        const snapshot: TransferConfirmSnapshot = {
          transfer: { id: command.transferId, status: 'completed', confirmedAt: occurredAt },
          events,
        };

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snapshot,
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent idempotent request',
              'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
        return { snapshot, replayed: false };
      },
    );

    return { snapshot, replayed };
  }

  // ── cancelTransfer ───────────────────────────────────────────────────────

  cancelFingerprint(command: CancelTransferCommand): string {
    return hashCommandPayload({
      transferId: command.transferId,
      note: command.note,
    });
  }

  /**
   * Draft-only cancel (Decision 3): no stock has moved yet, so the cancel is
   * a status flip with zero stock effect — an in-transit order has units
   * parked and a completed one has landed, and reversing either is deferred
   * (the compensating-order path). The refusal is 409 `transfer-wrong-state`
   * naming the status the order actually holds.
   */
  async cancelTransfer(
    command: CancelTransferCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: TransferOrderSnapshot; replayed: boolean }> {
    const payloadHash = this.cancelFingerprint(command);

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'transfers.manage',
        );

        const existing = await this.lookupIdempotencyKey(tx, command.tenantId, idempotencyKey);
        if (existing !== undefined) {
          if (existing.payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing.responseSnapshot as TransferOrderSnapshot,
            replayed: true,
          };
        }

        const order = await this.lockOrderInTx(tx, command.tenantId, command.transferId);
        if (order.status !== 'draft') {
          throw transferWrongState(order.status, 'cancelled');
        }

        await tx
          .update(transferOrders)
          .set({
            status: 'cancelled',
            cancelledBy: command.actorUserId,
            cancelledAt: nowIso(),
          })
          .where(
            and(eq(transferOrders.tenantId, command.tenantId), eq(transferOrders.id, command.transferId)),
          );

        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'transfer.cancelled',
          occurredAt: nowIso(),
          payload: {
            transferId: command.transferId,
            sourceWarehouseId: order.sourceWarehouseId,
            destWarehouseId: order.destWarehouseId,
          },
        });

        const snapshot = await this.orderSnapshotInTx(tx, command.tenantId, command.transferId);

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snapshot,
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent idempotent request',
              'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
        return { snapshot, replayed: false };
      },
    );

    return { snapshot, replayed };
  }

  // ── shared in-tx helpers ─────────────────────────────────────────────────

  private async lookupIdempotencyKey(tx: TenantTx, tenantId: string, key: string) {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
      .limit(1);
    return rows[0];
  }

  /** The order row, LOCKED — the state machine's mutex (404 when foreign). */
  private async lockOrderInTx(tx: TenantTx, tenantId: string, transferId: string): Promise<TransferOrder> {
    const rows = await tx
      .select()
      .from(transferOrders)
      .where(and(eq(transferOrders.tenantId, tenantId), eq(transferOrders.id, transferId)))
      .limit(1)
      .for('update');
    const order = rows[0];
    if (order === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'Transfer order not found',
        'No transfer order with this id exists in this tenant.',
      );
    }
    return order;
  }

  private async readLinesInTx(tx: TenantTx, tenantId: string, transferId: string): Promise<TransferOrderLine[]> {
    return tx
      .select()
      .from(transferOrderLines)
      .where(
        and(eq(transferOrderLines.tenantId, tenantId), eq(transferOrderLines.transferId, transferId)),
      )
      .orderBy(asc(transferOrderLines.id));
  }

  /** The response body (and the idempotent replay's stored copy). */
  private async orderSnapshotInTx(
    tx: TenantTx,
    tenantId: string,
    transferId: string,
  ): Promise<TransferOrderSnapshot> {
    const rows = await tx
      .select()
      .from(transferOrders)
      .where(and(eq(transferOrders.tenantId, tenantId), eq(transferOrders.id, transferId)))
      .limit(1);
    const order = rows[0];
    if (order === undefined) {
      throw new Error(`transfer order ${transferId} disappeared mid-command`);
    }
    const lineRows = await tx
      .select()
      .from(transferOrderLines)
      .where(
        and(eq(transferOrderLines.tenantId, tenantId), eq(transferOrderLines.transferId, transferId)),
      )
      .orderBy(asc(transferOrderLines.id));
    return {
      transfer: {
        id: order.id,
        status: order.status,
        sourceWarehouseId: order.sourceWarehouseId,
        destWarehouseId: order.destWarehouseId,
        note: order.note,
        createdAt: order.createdAt,
      },
      lines: lineRows.map((line) => ({
        id: line.id,
        skuId: line.skuId,
        quantity: fromMilli(line.quantity),
        fromBinId: line.fromBinId,
        toBinId: line.toBinId,
        batchRef: line.batchRef,
        note: line.note,
      })),
    };
  }
}

/** Re-exported for the facade's detail read (the legs' event shape). */
export { transferLegEventsInTx };