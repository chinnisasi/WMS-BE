import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  batches,
  bins,
  devices,
  idempotencyKeys,
  orders,
  picklistLines,
  picklists,
  picks,
  serials,
  skus,
  waves,
} from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { signedQuantity } from '../../shared/primitives/quantity';
import { assertUtcIso, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { deviceRevoked } from '../tenancy/enrollment.command';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertPermission } from '../tenancy/permissions';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';

// ── command inputs ───────────────────────────────────────────────────────────

export interface RecordPickCommand {
  readonly tenantId: string;
  readonly deviceId: string;
  /** The badge-in operator — authority is re-read from the DB at command entry. */
  readonly operatorUserId: string;
  readonly warehouseId: string;
  /** The picklist the scanned line belongs to (the walk being executed). */
  readonly picklistId: string;
  /** The pick line — one slice of one order line, picked whole. */
  readonly picklistLineId: string;
  /** The SKU the operator scanned — verified against the line's SKU. */
  readonly skuId: string;
  /** The bin the operator scanned — a SUGGESTION is what the plan named. */
  readonly binId: string;
  /** The units drawn — this story picks a line for exactly its planned qty. */
  readonly qty: number;
  /** Device time (AD-1) — the ledger event's and the pick row's business time. */
  readonly occurredAt: string;
  /**
   * The raw serial numbers of a serial-tracked draw (one event per unit,
   * mirroring the putaway serial arm). Resolved to catalog identities inside
   * the command transaction.
   */
  readonly serials?: readonly string[] | undefined;
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** One pick as every surface returns it (the idempotency snapshot). */
export interface PickSnapshot {
  readonly pick: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly waveId: string;
    readonly picklistId: string;
    readonly picklistLineId: string;
    readonly orderId: string;
    readonly orderLineId: string;
    readonly skuId: string;
    readonly skuCode: string;
    readonly binId: string;
    readonly binCode: string;
    readonly suggestedBinId: string | null;
    readonly suggestedBinCode: string | null;
    readonly batchId: string | null;
    readonly batchCode: string | null;
    readonly suggestedBatchId: string | null;
    readonly qty: number;
    readonly reservationId: string | null;
    /** True when THIS pick settled the hold (`held → committed`). */
    readonly reservationCommitted: boolean;
    /** The line's status after the pick — always `picked` on a fresh settle. */
    readonly lineStatus: string;
    readonly pickedBy: string;
    readonly pickedAt: string;
    readonly deviceId: string;
    readonly createdAt: string;
  };
}

/**
 * One pick task as the sealed device snapshot carries it (AD-4): a released
 * wave's still-unpicked pick line, with the plan's bin/batch suggestion baked
 * in — advisory only, re-derived server-side at pick time. The whole walk
 * rides the snapshot (every task carries its `picklistId` and `walkSeq`), so
 * the device can name the NEXT bin on this walk holding the expected SKU when
 * a wrong bin is scanned, with no network call.
 */
export interface PickTask {
  readonly waveId: string;
  readonly picklistId: string;
  readonly picklistLineId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly binId: string;
  readonly binCode: string;
  readonly batchId: string | null;
  readonly batchCode: string | null;
  readonly qty: number;
  readonly sliceSeq: number;
  readonly walkSeq: number;
  /** Distinct bin stops on this picklist's walk (the card's at-a-glance size). */
  readonly stopCount: number;
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
/** One pick per picklist line — the diverged-replay backstop. */
const PICKS_LINE_UNIQUE = 'picks_line_unique';

/**
 * The ceiling on pick stops the sealed device snapshot carries (story 4.3).
 * This read rides the catalog snapshot, which every device fetches on every
 * refresh — the one endpoint the offline substrate's latency depends on — so
 * it is bounded rather than "however much open floor work exists". 500 stops
 * is several full waves (a wave caps at 200 orders) and far more walking than
 * one shift; past it, a device refreshes again after picking what it has.
 *
 * Truncation drops WHOLE picklists, never the tail of one: a half-delivered
 * walk would make the device's "next walk bin holding this SKU" hint point at
 * a stop the snapshot does not contain, which is worse than offering fewer
 * picklists.
 */
export const MAX_SNAPSHOT_PICK_TASKS = 500;

/**
 * The scan-verified pick command (Story 4.3): `pick.record`, a
 * device-authenticated idempotent command (the `putaway.place` pattern —
 * DeviceSessionGuard at the shell, badge-in session, real authority re-read
 * inside the command tx). A pick is a REAL ledger movement: the reserved
 * units leave the scanned bin on one `pick.picked` event per (sku, batch)
 * arm — or one per serial unit on a serial-tracked SKU — and the order
 * line's reservation settles `held → committed` in the SAME transaction.
 *
 * Why one transaction (the design note): the reservation is what makes the
 * units this order's; the ledger event is what moves them. Split across two,
 * a crash between them either frees stock that has physically left the bin
 * (overselling it) or holds stock that was never drawn. Both directions of a
 * half-completed pick are wrong, so there is no fail-safe ordering — hence
 * `InventoryFacade.commitReservationInTx`.
 *
 * Invariant order inside `withTenantTransaction`: device re-read fail-closed
 * → role re-read → `assertPermission('picks.execute')` → idempotency replay
 * → validation → bin row lock → ledger draw + hold settlement → line flip →
 * pick row → in-tx outbox → audit → `writeIdempotencyKey` last.
 *
 * Guards are server-side truth (AD-4/AD-10): the plan's bin and batch are a
 * SUGGESTION re-derived here (the batch is chosen FEFO within the bin the
 * operator actually scanned), and a draw that would drive the bin below zero
 * is the 422 `insufficient-on-hand` quarantine — nothing persists, the
 * idempotency key is never consumed, and the client parks the op. That is
 * this story's entire conflict behaviour: no `state_epoch`, no taxonomy
 * (4.3b), no short-pick re-planning (4.4).
 */
@Injectable()
export class PickCommandService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition at the command layer through the facades only
    // (AD-6): the ledger draw, the serial locks and the reservation
    // settlement ride the inventory facade's in-transaction passthroughs;
    // batch identity/expiry (catalog-owned) rides the catalog facade.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  /**
   * `pick.record` — one idempotent server command per picked line. The
   * client-generated ULID (`Idempotency-Key` = the queued op's id) replays
   * exactly once: same key + payload re-serves the original snapshot, same
   * key + different payload is the deterministic 422.
   */
  async recordPick(command: RecordPickCommand, idempotencyKey: string): Promise<PickSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      deviceId: command.deviceId,
      operatorUserId: command.operatorUserId,
      warehouseId: command.warehouseId,
      picklistId: command.picklistId,
      picklistLineId: command.picklistLineId,
      skuId: command.skuId,
      binId: command.binId,
      qty: command.qty,
      occurredAt: command.occurredAt,
      // The RAW serial numbers fingerprint (never the resolved ids) — a
      // retry of the same request body replays regardless of current state.
      serials: command.serials === undefined ? undefined : [...command.serials],
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── device re-authorization (fail-closed, the putaway mirror) ────────
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

      // Role re-read from the DB per command — the token is transport, never
      // authority (AD-10). The badge-in session that created the op is what
      // authorizes its replay.
      const role = await getMemberRoleIn(tx, command.tenantId, command.operatorUserId);
      assertPermission(role, 'picks.execute');

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
        return existing[0].responseSnapshot as PickSnapshot;
      }

      // ── input validation (400 before any write) ─────────────────────────
      const occurredAt = assertUtc(command.occurredAt, 'occurredAt');
      if (!Number.isInteger(command.qty) || command.qty < 1) {
        throw pickValidation(`Pick quantity must be a positive integer (got ${command.qty}).`);
      }
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

      // ── the pick line, its picklist and its wave (404 before any write) ─
      const lineRows = await tx
        .select({
          line: picklistLines,
          picklistStatus: picklists.status,
          picklistWarehouseId: picklists.warehouseId,
          waveStatus: waves.status,
        })
        .from(picklistLines)
        .innerJoin(picklists, eq(picklists.id, picklistLines.picklistId))
        .innerJoin(waves, eq(waves.id, picklistLines.waveId))
        .where(
          and(
            eq(picklistLines.id, command.picklistLineId),
            eq(picklistLines.tenantId, command.tenantId),
          ),
        )
        .limit(1);
      const found = lineRows[0];
      if (found === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Pick line not found',
          `No picklist line with id "${command.picklistLineId}" exists in this tenant.`,
        );
      }
      const line = found.line;
      if (line.picklistId !== command.picklistId) {
        throw pickValidation(
          `Pick line "${command.picklistLineId}" belongs to picklist "${line.picklistId}", not "${command.picklistId}".`,
        );
      }
      if (found.picklistWarehouseId !== command.warehouseId) {
        throw pickValidation(
          `Picklist "${command.picklistId}" is in warehouse "${found.picklistWarehouseId}", not "${command.warehouseId}".`,
        );
      }

      // ── the pick line's state gates (409 before any write) ──────────────
      if (found.waveStatus !== 'released') {
        throw new ProblemException(
          'conflict',
          409,
          'Wave is not released',
          `Wave "${line.waveId}" reads "${found.waveStatus}" — only a released wave is the floor's work.`,
        );
      }
      if (found.picklistStatus !== 'ready') {
        throw new ProblemException(
          'conflict',
          409,
          'Picklist is not ready',
          `Picklist "${command.picklistId}" reads "${found.picklistStatus}" — only a ready picklist is picked.`,
        );
      }
      if (line.status === 'picked') {
        // A DIFFERENT key against an already-picked line: the pick happened,
        // this command is not it. Deterministic 409 — never a second draw.
        throw new ProblemException(
          'conflict',
          409,
          'Pick line is already picked',
          `Pick line "${command.picklistLineId}" is already picked — a line is drawn exactly once.`,
        );
      }
      if (line.status !== 'planned') {
        throw new ProblemException(
          'conflict',
          409,
          'Pick line is not pickable',
          `Pick line "${command.picklistLineId}" reads "${line.status}" — only a planned line is picked.`,
        );
      }
      if (line.binId === null) {
        // An `unfulfillable` slice has no units to draw (it names the
        // shortfall) — the `planned` check above already excludes it, so
        // this is the shape backstop.
        throw pickValidation(
          `Pick line "${command.picklistLineId}" names no bin — it is a shortfall slice, not pickable stock.`,
        );
      }

      // ── the order (a cancelled order's units are not picked) ────────────
      const orderRows = await tx
        .select({ status: orders.status })
        .from(orders)
        .where(and(eq(orders.id, line.orderId), eq(orders.tenantId, command.tenantId)))
        .limit(1);
      const order = orderRows[0];
      if (order === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Order not found',
          `No order with id "${line.orderId}" exists in this tenant.`,
        );
      }
      if (order.status !== 'accepted') {
        throw new ProblemException(
          'conflict',
          409,
          'Order is not accepted',
          `Order "${line.orderId}" reads "${order.status}" — its units are not picked.`,
        );
      }

      // ── the scanned item (the wrong-item rejection, mirrored on-device) ──
      if (command.skuId !== line.skuId) {
        throw wrongItem(line.skuId, command.skuId);
      }
      const skuRows = await tx
        .select({ id: skus.id, code: skus.code, batchTracked: skus.batchTracked, serialTracked: skus.serialTracked })
        .from(skus)
        .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
        .limit(1);
      const sku = skuRows[0];
      if (sku === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'SKU not found',
          `No SKU with id "${command.skuId}" exists in this tenant.`,
        );
      }

      // ── full-quantity picks only (4.4 brings the short-pick) ────────────
      if (command.qty !== line.qty) {
        throw pickValidation(
          `Pick line "${command.picklistLineId}" plans ${line.qty} unit(s) — a line is picked whole; short-picking is not in this release.`,
        );
      }

      // ── the scanned bin (server-side truth, mirrored on-device) ─────────
      // `for('update')` mutexes the bin's draw against a concurrent pick of
      // the same bin: the sufficiency read below runs before the append's
      // advisory lock, so two concurrent draws would otherwise both pass and
      // then append serially — below zero. The lock order stays putaway's
      // documented acyclic bins-row → serial → warehouse.
      const binRows = await tx
        .select({
          id: bins.id,
          code: bins.code,
          blocked: bins.blocked,
          systemOwned: bins.systemOwned,
          retiredAt: bins.retiredAt,
        })
        .from(bins)
        .where(
          and(
            eq(bins.id, command.binId),
            eq(bins.tenantId, command.tenantId),
            eq(bins.warehouseId, command.warehouseId),
          ),
        )
        .for('update')
        .limit(1);
      const drawBin = binRows[0];
      if (drawBin === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Bin not found',
          `No bin with id "${command.binId}" exists in this warehouse.`,
        );
      }
      if (drawBin.systemOwned) {
        throw pickValidation(
          `Bin "${drawBin.code}" is a system bin (Receiving/QC-hold) — picks draw from storage bins only.`,
        );
      }
      if (drawBin.retiredAt !== null) {
        throw binRetiredAsSource(drawBin.code);
      }
      if (drawBin.blocked) {
        throw binBlocked(drawBin.code);
      }

      // ── the batch arms, RE-DERIVED FEFO in the scanned bin ──────────────
      // The plan's `batch_id` is advisory: the operator may legitimately be
      // standing at a different bin, and the plan's batch may have been drawn
      // since. The draw is composed here against LIVE per-batch stock.
      const allocation = sku.batchTracked
        ? await this.deriveBatchArms(tx, command, drawBin.code, occurredAt)
        : [{ batchId: null, qty: command.qty }];

      // ── the sufficiency pre-check (the 422 that names the live on-hand) ─
      // The ledger's own fold guard is the backstop; this check exists so the
      // stale-replay outcome names the bin CODE and what it actually holds
      // rather than a raw id.
      const onHand = await this.binOnHandInTx(tx, command, drawBin.id);
      if (onHand < command.qty) {
        throw insufficientOnHand(drawBin.code, onHand, command.qty);
      }

      // ── the serial arm (serial-tracked SKUs, the putaway mirror) ────────
      let serialNumbers: readonly string[] = [];
      if (sku.serialTracked) {
        if (command.serials === undefined || command.serials.length === 0) {
          throw pickValidation(
            `SKU "${sku.code}" is serial-tracked — its pick needs one serial per unit (${command.qty}).`,
          );
        }
        if (new Set(command.serials).size !== command.serials.length) {
          throw pickValidation(
            'serials contains duplicates — a serial-tracked pick draws one ledger event per serial unit; the same serial cannot appear twice.',
          );
        }
        if (command.serials.length !== command.qty) {
          throw pickValidation(
            `A serial-tracked pick draws one ledger event per serial unit — ${command.serials.length} serials cannot draw ${command.qty} units.`,
          );
        }
        serialNumbers = command.serials;
      } else if (command.serials !== undefined && command.serials.length > 0) {
        throw pickValidation(`SKU "${sku.code}" is not serial-tracked — its pick carries no serials.`);
      }
      const serialRefs =
        serialNumbers.length === 0
          ? []
          : await resolveSerialRefsInTx(tx, command.tenantId, command.skuId, serialNumbers);

      // ── the draw (one event per batch arm, or per serial unit) ──────────
      // AD-1: the row's pickedAt is the DEVICE time; the ledger's recordedAt
      // and the row's createdAt stay the server commit time.
      const recordedAt = nowIso();
      const pickedAt = occurredAt;
      const suggestedBinId = line.binId;
      const suggestedBatchId = line.batchId;
      const referenceDoc = {
        kind: 'pick' as const,
        picklistId: command.picklistId,
        picklistLineId: command.picklistLineId,
        waveId: line.waveId,
        orderId: line.orderId,
        orderLineId: line.orderLineId,
        ...(line.reservationId === null ? {} : { reservationId: line.reservationId }),
        // Suggestion-vs-actual on the event itself: recorded only when the
        // operator drew somewhere other than the plan's bin.
        ...(suggestedBinId === null || suggestedBinId === drawBin.id ? {} : { suggestedBinId }),
      };

      if (serialRefs.length > 0) {
        // Lock the whole serial set tenant-wide in sorted order BEFORE the
        // first append (the stock.adjustment deadlock rule), then one event
        // per serial unit — magnitude 1, drawn OUT of the bin (`toBinId`
        // null: the units leave stock; pack/dispatch are 4.5/4.6). The batch
        // arm rides the per-serial events too, walking the FEFO allocation
        // in order, so a batch+serial-tracked pick drains both projections.
        await this.inventory.lockSerialsInTx(tx, command.tenantId, serialRefs);
        const batchPerUnit = expandAllocation(allocation);
        for (const [index, serialRef] of serialRefs.entries()) {
          await this.inventory.appendLedgerEventInTx(tx, {
            tenantId: command.tenantId,
            warehouseId: command.warehouseId,
            type: 'pick.picked',
            skuId: command.skuId,
            quantityDelta: signedQuantity(-1),
            fromBinId: drawBin.id,
            toBinId: null,
            batchRef: batchPerUnit[index] ?? null,
            serialRef,
            actorUserId: command.operatorUserId,
            occurredAt,
            recordedAt,
            referenceDoc,
          });
        }
      } else {
        for (const arm of allocation) {
          await this.inventory.appendLedgerEventInTx(tx, {
            tenantId: command.tenantId,
            warehouseId: command.warehouseId,
            type: 'pick.picked',
            skuId: command.skuId,
            quantityDelta: signedQuantity(-arm.qty),
            fromBinId: drawBin.id,
            toBinId: null,
            batchRef: arm.batchId,
            serialRef: null,
            actorUserId: command.operatorUserId,
            occurredAt,
            recordedAt,
            referenceDoc,
          });
        }
      }

      // ── the line flip (planned → picked, in the same commit) ────────────
      // `picked` stays OUTSIDE `'cancelled'`, so the line keeps its claim in
      // `picklist_lines_open_order_line_unique` — dropping out would free the
      // order to be re-waved against stock that has already left the bin.
      const flipped = await tx
        .update(picklistLines)
        .set({ status: 'picked', updatedAt: nowIso() })
        .where(
          and(
            eq(picklistLines.id, line.id),
            eq(picklistLines.tenantId, command.tenantId),
            eq(picklistLines.status, 'planned'),
          ),
        )
        .returning({ id: picklistLines.id });
      if (flipped[0] === undefined) {
        // A concurrent pick of the same line won the flip — this transaction
        // carries no new state and rolls back whole.
        throw new ProblemException(
          'conflict',
          409,
          'Pick line is already picked',
          `Pick line "${command.picklistLineId}" was picked concurrently — a line is drawn exactly once.`,
        );
      }

      // ── the hold settlement (same transaction as the draw) ──────────────
      // A reservation is a whole-quantity row with no partial commit, and an
      // order line may span several bins (several slices). The hold settles
      // when the LAST open slice of its order line is picked — settling on
      // the first would commit units still sitting in another bin.
      let reservationCommitted = false;
      if (line.reservationId !== null) {
        const openSiblings = await tx
          .select({ id: picklistLines.id })
          .from(picklistLines)
          .where(
            and(
              eq(picklistLines.tenantId, command.tenantId),
              eq(picklistLines.orderLineId, line.orderLineId),
              eq(picklistLines.status, 'planned'),
            ),
          )
          .limit(1);
        if (openSiblings[0] === undefined) {
          await this.inventory.commitReservationInTx(tx, command.tenantId, line.reservationId);
          reservationCommitted = true;
        }
      }

      // ── the pick row (the settlement record) ────────────────────────────
      const pickId = uuidv7();
      const batchId = allocation.length === 1 ? allocation[0]!.batchId : null;
      try {
        await tx.insert(picks).values({
          id: pickId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          waveId: line.waveId,
          picklistId: command.picklistId,
          picklistLineId: line.id,
          orderId: line.orderId,
          orderLineId: line.orderLineId,
          skuId: command.skuId,
          binId: drawBin.id,
          suggestedBinId,
          batchId,
          suggestedBatchId,
          reservationId: line.reservationId,
          reservationCommitted,
          qty: command.qty,
          pickedBy: command.operatorUserId,
          pickedAt,
          deviceId: command.deviceId,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, PICKS_LINE_UNIQUE)) {
          throw new ProblemException(
            'conflict',
            409,
            'Pick line is already picked',
            `Pick line "${command.picklistLineId}" already carries a pick — a line is drawn exactly once.`,
          );
        }
        throw err;
      }

      const batchCode = batchId === null ? null : await batchCodeInTx(tx, command.tenantId, batchId);
      const snapshot: PickSnapshot = {
        pick: {
          id: pickId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          waveId: line.waveId,
          picklistId: command.picklistId,
          picklistLineId: line.id,
          orderId: line.orderId,
          orderLineId: line.orderLineId,
          skuId: command.skuId,
          skuCode: sku.code,
          binId: drawBin.id,
          binCode: drawBin.code,
          suggestedBinId,
          suggestedBinCode: line.binCode,
          batchId,
          batchCode,
          suggestedBatchId,
          qty: command.qty,
          reservationId: line.reservationId,
          reservationCommitted,
          lineStatus: 'picked',
          pickedBy: command.operatorUserId,
          pickedAt,
          deviceId: command.deviceId,
          createdAt: recordedAt,
        },
      };

      // ── in-transaction outbox append (AD-7) ─────────────────────────────
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'pick.recorded',
        occurredAt: pickedAt,
        payload: { pick: snapshot.pick },
      });

      // ── the audit row ───────────────────────────────────────────────────
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.operatorUserId,
        action: 'pick.picked',
        targetType: 'pick',
        targetId: pickId,
        reference: idempotencyKey,
        occurredAt: pickedAt,
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
   * The FEFO batch arms of one draw, RE-DERIVED in the bin the operator
   * actually scanned (never the plan's bin): drawable batches only (a
   * blocked batch is never drawn — epic-2 retro a13's draw side; an expired
   * batch is never drawn), expiry ascending with no-expiry last, taking from
   * each until the quantity is covered. A bin that cannot cover the line is
   * the 422 that names what it holds.
   */
  private async deriveBatchArms(
    tx: TenantTx,
    command: RecordPickCommand,
    binCode: string,
    occurredAt: string,
  ): Promise<{ batchId: string | null; qty: number }[]> {
    const [batchStock, identities] = await Promise.all([
      this.inventory.batchOnHandByBinsInTx(tx, command.tenantId, command.warehouseId, [command.skuId]),
      this.catalog.getBatchesForSkusInTx(tx, command.tenantId, [command.skuId]),
    ]);
    const byId = new Map(identities.map((batch) => [batch.id, batch]));
    // The draw's own business time decides expiry — a queued pick replayed
    // later must not be re-judged against the replay instant.
    const at = Date.parse(occurredAt);
    const drawable = batchStock
      .filter((row) => row.binId === command.binId && row.quantity > 0)
      .filter((row) => {
        const batch = byId.get(row.batchId);
        if (batch === undefined || batch.status !== 'active') return false;
        return batch.expiryDate === null || Date.parse(batch.expiryDate) >= at;
      })
      .sort((a, b) => {
        const left = byId.get(a.batchId)?.expiryDate ?? null;
        const right = byId.get(b.batchId)?.expiryDate ?? null;
        if (left === right) return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
        if (left === null) return 1;
        if (right === null) return -1;
        return left < right ? -1 : 1;
      });

    const arms: { batchId: string | null; qty: number }[] = [];
    let need = command.qty;
    for (const row of drawable) {
      if (need === 0) break;
      const take = Math.min(need, row.quantity);
      need -= take;
      arms.push({ batchId: row.batchId, qty: take });
    }
    if (need > 0) {
      const drawableUnits = command.qty - need;
      throw insufficientOnHand(binCode, drawableUnits, command.qty);
    }
    return arms;
  }

  /** The scanned bin's live on-hand for the picked SKU (the 422's figure). */
  private async binOnHandInTx(
    tx: TenantTx,
    command: RecordPickCommand,
    binId: string,
  ): Promise<number> {
    const rows = await this.inventory.stockByBinsInTx(
      tx,
      command.tenantId,
      command.warehouseId,
      [command.skuId],
    );
    return rows.find((row) => row.binId === binId)?.quantity ?? 0;
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
   * The device's pick tasks (AD-4): every still-pickable line of every ready
   * picklist on a released wave in the warehouse, in walk order. The bin and
   * batch each task names are the plan's SUGGESTION — baked in as advisory
   * data, re-derived server-side at pick time. `unfulfillable` slices carry
   * no bin and are not tasks; picked and cancelled lines drop out.
   *
   * Bounded at `MAX_SNAPSHOT_PICK_TASKS` stops, truncated on picklist
   * boundaries so no walk is ever half-delivered, and served by the partial
   * `picklist_lines_pickable_walk_idx` (plus the `picklists` warehouse/status
   * and `waves` status indexes) — this runs inside the device catalog
   * snapshot, so it must not degrade with picking history.
   */
  async getPickTasks(tx: TenantTx, tenantId: string, warehouseId: string): Promise<PickTask[]> {
    const overRead = await tx
      .select({
        waveId: picklistLines.waveId,
        picklistId: picklistLines.picklistId,
        picklistLineId: picklistLines.id,
        orderId: picklistLines.orderId,
        orderLineId: picklistLines.orderLineId,
        skuId: picklistLines.skuId,
        skuCode: skus.code,
        skuName: skus.name,
        binId: picklistLines.binId,
        binCode: picklistLines.binCode,
        batchId: picklistLines.batchId,
        qty: picklistLines.qty,
        sliceSeq: picklistLines.sliceSeq,
        walkSeq: picklistLines.walkSeq,
      })
      .from(picklistLines)
      .innerJoin(picklists, eq(picklists.id, picklistLines.picklistId))
      .innerJoin(waves, eq(waves.id, picklistLines.waveId))
      .innerJoin(skus, eq(skus.id, picklistLines.skuId))
      .where(
        and(
          eq(picklistLines.tenantId, tenantId),
          eq(picklists.warehouseId, warehouseId),
          eq(picklists.status, 'ready'),
          eq(waves.status, 'released'),
          eq(picklistLines.status, 'planned'),
          sql`${picklistLines.binId} is not null`,
        ),
      )
      .orderBy(asc(picklistLines.picklistId), asc(picklistLines.walkSeq), asc(picklistLines.id))
      // One row over the ceiling: reading it is how we learn the result was
      // truncated without a second COUNT query.
      .limit(MAX_SNAPSHOT_PICK_TASKS + 1);

    // Truncate on a PICKLIST boundary (see `MAX_SNAPSHOT_PICK_TASKS`): the
    // rows are ordered by picklist, so dropping every row of the first
    // picklist that crosses the ceiling leaves only whole walks.
    const rows = overRead.length > MAX_SNAPSHOT_PICK_TASKS
      ? (() => {
          const kept = overRead.slice(0, MAX_SNAPSHOT_PICK_TASKS);
          const lastWhole = kept[kept.length - 1]?.picklistId;
          // The cut fell inside `lastWhole` only if that picklist also has a
          // row beyond the ceiling; drop it whole when it does.
          return overRead[MAX_SNAPSHOT_PICK_TASKS]?.picklistId === lastWhole
            ? kept.filter((row) => row.picklistId !== lastWhole)
            : kept;
        })()
      : overRead;

    const batchIds = [...new Set(rows.flatMap((row) => (row.batchId === null ? [] : [row.batchId])))];
    const batchCodes = new Map(
      batchIds.length === 0
        ? []
        : (
            await tx
              .select({ id: batches.id, code: batches.code })
              .from(batches)
              .where(and(eq(batches.tenantId, tenantId), inArray(batches.id, batchIds)))
          ).map((batch) => [batch.id, batch.code] as const),
    );
    // Distinct bin stops per picklist — the card's at-a-glance walk size.
    const stops = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = stops.get(row.picklistId) ?? new Set<string>();
      set.add(row.binId!);
      stops.set(row.picklistId, set);
    }
    return rows.map((row) => ({
      waveId: row.waveId,
      picklistId: row.picklistId,
      picklistLineId: row.picklistLineId,
      orderId: row.orderId,
      orderLineId: row.orderLineId,
      skuId: row.skuId,
      skuCode: row.skuCode,
      skuName: row.skuName,
      binId: row.binId!,
      binCode: row.binCode ?? '',
      batchId: row.batchId,
      batchCode: row.batchId === null ? null : (batchCodes.get(row.batchId) ?? null),
      qty: row.qty,
      sliceSeq: row.sliceSeq,
      walkSeq: row.walkSeq,
      stopCount: stops.get(row.picklistId)?.size ?? 0,
    }));
  }
}

// ── shared helpers (module-level, read-only) ─────────────────────────────────

/** One batch id per drawn unit, walking the FEFO allocation in order. */
function expandAllocation(
  allocation: readonly { batchId: string | null; qty: number }[],
): (string | null)[] {
  const units: (string | null)[] = [];
  for (const arm of allocation) {
    for (let i = 0; i < arm.qty; i++) units.push(arm.batchId);
  }
  return units;
}

async function batchCodeInTx(tx: TenantTx, tenantId: string, batchId: string): Promise<string | null> {
  const rows = await tx
    .select({ code: batches.code })
    .from(batches)
    .where(and(eq(batches.id, batchId), eq(batches.tenantId, tenantId)))
    .limit(1);
  return rows[0]?.code ?? null;
}

/**
 * Serials named by a pick, resolved to catalog identities inside the
 * command's transaction — order-preserving. A number the catalog has never
 * seen for the SKU is a 400 (a pick draws stock that exists; it creates no
 * serial identity). The ledger's own guards (serial-elsewhere / unknown) are
 * the location-truth backstops at append time.
 */
export async function resolveSerialRefsInTx(
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
      throw pickValidation(`Serial "${serial}" does not exist for this SKU — a pick draws existing stock only.`);
    }
    resolved.push(id);
  }
  return resolved;
}

function pickValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid pick', detail);
}

/**
 * The wrong-item rejection: it names the SKU the line expects. The device
 * mirrors this check synchronously against the sealed snapshot, so a wrong
 * item never queues — this is the server-side backstop for a diverged replay.
 */
export function wrongItem(expectedSkuId: string, scannedSkuId: string): ProblemException {
  return new ProblemException(
    'wrong-item',
    400,
    'Scanned item is not this pick line',
    `This pick line draws SKU "${expectedSkuId}"; the scan was "${scannedSkuId}" — the wrong item is never picked.`,
  );
}

/**
 * The stale-replay conflict (the I/O matrix): the bin drained before the
 * queued pick replayed. 422, naming the bin and its LIVE on-hand — nothing
 * persists, the idempotency key is never consumed, and the client parks the
 * op with session attribution. This is the whole of 4.3's conflict behaviour
 * (the ledger's fold guard is the backstop below it).
 */
export function insufficientOnHand(
  binCode: string,
  onHand: number,
  requested: number,
): ProblemException {
  return new ProblemException(
    'insufficient-on-hand',
    422,
    'Bin cannot cover this pick',
    `Bin "${binCode}" holds ${onHand} drawable unit(s) of this SKU; the pick draws ${requested}. Nothing was recorded.`,
  );
}

/** The blocked-bin rejection (FR-10): a blocked bin is unpickable. */
export function binBlocked(binCode: string): ProblemException {
  return new ProblemException(
    'bin-blocked',
    400,
    'Bin is blocked',
    `Bin "${binCode}" is blocked — picks from it are refused until it is unblocked.`,
  );
}

/** The retired-bin SOURCE rejection (Story 3.6): retirement is terminal. */
export function binRetiredAsSource(binCode: string): ProblemException {
  return new ProblemException(
    'bin-retired',
    400,
    'Bin is retired',
    `Bin "${binCode}" is retired — picking from it is refused; retirement is terminal.`,
  );
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
