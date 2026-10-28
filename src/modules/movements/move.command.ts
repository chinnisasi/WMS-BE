import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, batches, bins, idempotencyKeys, serials, skus } from '../../shared/db/schema';
import {
  MAX_QUANTITY_BASE,
  QUANTITY_SCALE,
  assertRecordableQuantity,
  fromMilli,
  signedQuantity,
} from '../../shared/primitives/quantity';
import { uuidv7 } from '../../shared/primitives/ids';
import { assertUtcIso, nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission, assertSecureBinAuthority } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { uomPrecision } from '../catalog/uom';
// The kit-ness read — the same file-level in-tx escape the transfer command
// and the stock adjustment use (catalog owns `kit_compositions`).
import { getKitSkuIdsInTx, kitCannotHoldStock } from '../catalog/kit.store';
import { InventoryFacade } from '../inventory/inventory.facade';
import { MAX_MOVE_SERIALS, MOVE_NOTE_MAX, MOVE_NOTE_REQUIRED_CODES, MOVE_REASON_CODES, isMoveReasonCode } from './move-reason';

/**
 * Story 3-1 — the bin-to-bin move (`MoveCommand.moveStock`): stock relocates
 * between two bins of ONE warehouse, from the handheld (the queued
 * `stock.move` op) or the web Moves page, on one route.
 *
 * One request = one move = one `moveId`. Each arm appends ONE `stock.moved`
 * ledger event carrying both bins (a batch arm, or one magnitude-1 event per
 * serial unit), so the fold debits the origin and credits the target in the
 * same transaction. There is no move table and no migration: the moveId and
 * the reason ride the event's reference doc (`bin-move` arm), and the ledger
 * is the history.
 *
 * The command order (the spec's Boundaries, IMPLEMENTATION-GUIDE §1):
 *   1 request shape above the transaction → hash → 2 device + operator
 *   (device session) → 3 `stock.move` → 4 replay → 5 warehouse → 6 SKU (kit,
 *   catch-weight, tracking, precision) → 7 both bins `FOR UPDATE` in id order
 *   (404) → 8 replay again under the locks → 9 both-bin checks (system), the
 *   origin's retired check → 10 quarantine on both scopes → 11 the target's
 *   placement gates (`InventoryFacade.assertPlacementGatesInTx`) → 12 the
 *   origin's secure authority → 13 serial locks → 14 batch lookup → 15
 *   on-hand per arm → 16 ledger appends → 17 audit → 18 idempotency key.
 *
 * Lock order is the canonical acyclic chain: bin rows (id order) → serial
 * advisory locks (sorted) → the warehouse advisory, taken inside the first
 * append. Two opposite moves (A→B and B→A) lock the same two rows in the
 * same order, so they serialise rather than deadlock.
 *
 * No outbox event: ATP is unchanged (both bins are storage bins, and both
 * quarantined scopes are refused). Not billable and not portal-visible in
 * 3-1 (a `both`-shape event meters 0).
 */

export interface MoveStockCommand {
  readonly tenantId: string;
  /** The operator — the web session's user, or the device's badge-in operator. */
  readonly actorUserId: string;
  /** The device (a badge-in session); null on the web. */
  readonly deviceId: string | null;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly fromBinId: string;
  readonly toBinId: string;
  /** Base UoM (story 10.2) — converted behind the replay lookup. */
  readonly qty: number;
  /** A batch-tracked SKU's batch CODE (the operator's observed identity); null otherwise. */
  readonly batchCode?: string | null | undefined;
  /** A serial-tracked SKU's serial numbers (one per unit); null otherwise. */
  readonly serials?: readonly string[] | null | undefined;
  readonly reasonCode: string;
  readonly note?: string | null | undefined;
  /** Device only — the op's business time; a web move uses now. */
  readonly occurredAt?: string | null | undefined;
}

/** One event of the move, base units at the edge. */
export interface MoveEventSnapshot {
  readonly seq: number;
  readonly skuId: string;
  readonly quantity: number;
  readonly fromBinId: string;
  readonly toBinId: string;
  readonly batchRef: string | null;
  readonly serialRef: string | null;
  readonly occurredAt: string;
}

/** The API response body (and the idempotency snapshot). */
export interface MoveStockSnapshot {
  readonly moveId: string;
  readonly events: readonly MoveEventSnapshot[];
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid move', detail);
}

/** 409 — a system bin on either end (decision 4). */
function binNotMovable(binCode: string): ProblemException {
  return new ProblemException(
    'bin-not-movable',
    409,
    'System bins are not moved by hand',
    `Bin "${binCode}" is a system bin (Receiving, QC-hold, In-Transit, Returns) — its stock moves only by its own commands; pick a storage bin.`,
  );
}

/** 409 — a retired origin (decision 4; a retired target answers the gate's own `bin-retired`). */
function originRetired(binCode: string): ProblemException {
  return new ProblemException(
    'bin-retired',
    409,
    'Origin bin is retired',
    `Bin "${binCode}" is retired — it holds no stock to move; retirement is terminal.`,
  );
}

function moveScopeQuarantined(skuCode: string, binCode: string): ProblemException {
  return new ProblemException(
    'move-scope-quarantined',
    409,
    'The stock is under a reconcile quarantine',
    `SKU "${skuCode}" in bin "${binCode}" is quarantined by reconciliation — its count is not trusted, so it is neither moved out of nor into; resolve the quarantine first.`,
  );
}

function moveSourceShort(binCode: string, skuCode: string, batchCode: string | null, available: number, needed: number): ProblemException {
  const what = batchCode === null ? `SKU "${skuCode}"` : `SKU "${skuCode}" batch "${batchCode}"`;
  return new ProblemException(
    'move-source-short',
    409,
    'The origin bin holds less than the move',
    `Bin "${binCode}" holds ${fromMilli(available)} of ${what} but the move takes ${fromMilli(needed)} — nothing was moved; move what is on hand.`,
  );
}

/** The machine code of a thrown ProblemException, else null. */
function problemCodeOf(err: unknown): string | null {
  if (!(err instanceof ProblemException)) return null;
  const body = err.getResponse();
  return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
    ? (body as { code: string }).code
    : null;
}

/** The request-shape refusals (step 1) — no row needed, above the transaction. */
interface MoveShape {
  readonly surface: 'device' | 'web';
  readonly batchCode: string | null;
  readonly serials: readonly string[] | null;
  readonly note: string | null;
  readonly occurredAt: string | null;
}

function assertMoveShape(command: MoveStockCommand): MoveShape {
  const surface = command.deviceId === null ? 'web' : 'device';
  if (typeof command.qty !== 'number' || !Number.isFinite(command.qty) || !(command.qty > 0)) {
    throw invalid(`qty must be a positive quantity (got ${String(command.qty)}).`);
  }
  if (command.qty > MAX_QUANTITY_BASE) {
    throw invalid(`qty must be at most ${MAX_QUANTITY_BASE} (got ${String(command.qty)}).`);
  }
  if (command.fromBinId === command.toBinId) {
    throw invalid('The origin and the target are the same bin — pick a different target bin.');
  }
  if (!isMoveReasonCode(command.reasonCode)) {
    throw invalid(`reasonCode must be one of ${JSON.stringify(MOVE_REASON_CODES)} (got "${String(command.reasonCode)}").`);
  }
  const rawNote = command.note ?? null;
  if (rawNote !== null && typeof rawNote !== 'string') {
    throw invalid('note must be text.');
  }
  const note = rawNote === null || rawNote.trim() === '' ? null : rawNote.trim();
  if (note !== null && [...note].length > MOVE_NOTE_MAX) {
    throw invalid(`note must be at most ${MOVE_NOTE_MAX} characters (got ${[...note].length}).`);
  }
  if (note === null && MOVE_NOTE_REQUIRED_CODES.includes(command.reasonCode)) {
    throw invalid(`The reason "${command.reasonCode}" needs a note saying why.`);
  }
  const rawBatchCode = command.batchCode ?? null;
  if (rawBatchCode !== null && (typeof rawBatchCode !== 'string' || rawBatchCode.trim() === '')) {
    throw invalid('batchCode must be a non-empty batch code, or null.');
  }
  // Trimmed: the value the lookup and the hash both use.
  const batchCode = rawBatchCode === null ? null : rawBatchCode.trim();
  const rawSerials = command.serials ?? null;
  let serialList: readonly string[] | null = null;
  if (rawSerials !== null) {
    if (!Array.isArray(rawSerials) || rawSerials.some((serial) => typeof serial !== 'string' || serial.trim() === '')) {
      throw invalid('serials must be a list of serial numbers, or null.');
    }
    if (rawSerials.length === 0) {
      throw invalid('serials must name at least one serial, or be null.');
    }
    if (rawSerials.length > MAX_MOVE_SERIALS) {
      throw invalid(`A move carries at most ${MAX_MOVE_SERIALS} serials (got ${rawSerials.length}) — split it.`);
    }
    const trimmedSerials = rawSerials.map((serial) => serial.trim());
    if (new Set(trimmedSerials).size !== trimmedSerials.length) {
      throw invalid('serials lists the same serial twice — one serial moves one unit.');
    }
    if (command.qty !== rawSerials.length) {
      throw invalid(`qty must equal the number of serials (qty ${String(command.qty)}, ${rawSerials.length} serial(s)).`);
    }
    if (batchCode !== null) {
      throw invalid("A serial move carries no batchCode — each serial's batch is the one it is held under.");
    }
    serialList = trimmedSerials;
  }
  const rawOccurredAt = command.occurredAt ?? null;
  let occurredAt: string | null = null;
  if (surface === 'web') {
    if (rawOccurredAt !== null) {
      throw invalid('occurredAt is set by the handheld only — a web move happens now.');
    }
  } else {
    if (rawOccurredAt === null) {
      throw invalid('occurredAt is required on a handheld move — the time the move was confirmed.');
    }
    try {
      occurredAt = assertUtcIso(String(rawOccurredAt));
    } catch {
      throw invalid(`occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${String(rawOccurredAt).slice(0, 64)}").`);
    }
  }
  return { surface, batchCode, serials: serialList, note, occurredAt };
}

/**
 * The move's idempotency fingerprint (the spec's Boundaries), fixed key order:
 * the surface first (one key cannot serve the device and the web — a
 * byte-identical body under one key must not replay the other surface), the
 * device or null, the operator, then the request. Serials are a SET (sorted);
 * `occurredAt` is hashed on the device surface only — a web move's time is
 * the server's, never part of the request.
 */
export function moveFingerprint(command: MoveStockCommand): string {
  const surface = command.deviceId === null ? 'web' : 'device';
  // Trimmed before hashing — the same values the lookups use (the shape
  // check ran first, so every present arm is a string).
  const serialList = command.serials == null ? null : command.serials.map((serial) => serial.trim());
  const batchCode = command.batchCode == null ? null : command.batchCode.trim();
  const note = command.note == null || command.note.trim() === '' ? null : command.note.trim();
  return hashCommandPayload({
    surface,
    tenantId: command.tenantId,
    deviceId: command.deviceId ?? null,
    operatorUserId: command.actorUserId,
    warehouseId: command.warehouseId,
    skuId: command.skuId,
    batchCode,
    qty: command.qty,
    fromBinId: command.fromBinId,
    toBinId: command.toBinId,
    reasonCode: command.reasonCode,
    note,
    serials: serialList === null ? null : [...serialList].sort(),
    ...(surface === 'device' ? { occurredAt: command.occurredAt ?? null } : {}),
  });
}

@Injectable()
export class MoveCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // The ledger, the gate runner, the quarantine and on-hand reads — the
    // PROJECTION_OWNER seam (movements never touches a stock table).
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  async moveStock(command: MoveStockCommand, idempotencyKey: string): Promise<MoveStockSnapshot> {
    // ── 1. request shape, above the transaction ──────────────────────────
    const shape = assertMoveShape(command);
    const payloadHash = moveFingerprint(command);

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── 2. the device and its operator (device session only) ──────────
      if (command.deviceId !== null) {
        await assertDeviceOperatorInTx(tx, command.tenantId, command.deviceId, command.actorUserId);
      }
      // ── 3. authority — re-read from the DB, before the replay ──────────
      const role = await getMemberRoleIn(tx, command.tenantId, command.actorUserId);
      assertPermission(role, 'stock.move');

      // ── 4. replay ───────────────────────────────────────────────────────
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      // ── 5. the warehouse ────────────────────────────────────────────────
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

      // ── 6. the SKU: kit, catch-weight, tracking, precision ─────────────
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
        .where(and(eq(skus.tenantId, command.tenantId), eq(skus.id, command.skuId)))
        .limit(1);
      const sku = skuRows[0];
      if (sku === undefined) {
        throw new ProblemException('not-found', 404, 'SKU not found', `No SKU with id "${command.skuId}" exists in this tenant.`);
      }
      if ((await getKitSkuIdsInTx(tx, command.tenantId, [sku.id])).length > 0) {
        throw kitCannotHoldStock('A move', [sku.code]);
      }
      if (sku.catchWeightTracked) {
        // Handling units carry no location (PENDING) — a catch-weight move
        // cannot say which cases moved.
        throw invalid(`SKU "${sku.code}" is catch-weight tracked — its cases carry no bin, so it cannot be moved between bins yet.`);
      }
      if (sku.serialTracked) {
        if (shape.serials === null) {
          throw invalid(`SKU "${sku.code}" is serial-tracked — a move names the serial of every unit it moves.`);
        }
      } else if (shape.serials !== null) {
        throw invalid(`SKU "${sku.code}" is not serial-tracked — its move carries no serials.`);
      }
      if (!sku.serialTracked) {
        if (sku.batchTracked && shape.batchCode === null) {
          throw invalid(`SKU "${sku.code}" is batch-tracked — a move names the batch it moves.`);
        }
        if (!sku.batchTracked && shape.batchCode !== null) {
          throw invalid(`SKU "${sku.code}" is not batch-tracked — its move carries no batch.`);
        }
      }
      const qtyMilli = assertRecordableQuantity(command.qty, 'qty', sku.uom, uomPrecision(sku.uom));

      // ── 7. both bins, FOR UPDATE in id order ────────────────────────────
      const lockedBins = await tx
        .select({
          id: bins.id,
          code: bins.code,
          systemOwned: bins.systemOwned,
          retiredAt: bins.retiredAt,
          storageClass: bins.storageClass,
        })
        .from(bins)
        .where(
          and(
            eq(bins.tenantId, command.tenantId),
            eq(bins.warehouseId, command.warehouseId),
            inArray(bins.id, [command.fromBinId, command.toBinId]),
          ),
        )
        .orderBy(asc(bins.id))
        .for('update');
      const origin = lockedBins.find((row) => row.id === command.fromBinId);
      const target = lockedBins.find((row) => row.id === command.toBinId);
      if (origin === undefined || target === undefined) {
        const missing = origin === undefined ? command.fromBinId : command.toBinId;
        throw new ProblemException('not-found', 404, 'Bin not found', `No bin with id "${missing}" exists in this warehouse.`);
      }

      // ── 8. replay again, under the locks (the same-key race) ───────────
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;

      // ── 9. both-bin checks, then the origin's retired check ────────────
      // Before the gate: the gate answers a system target 400, the command
      // answers both ends 409 `bin-not-movable` — one code per refusal.
      if (origin.systemOwned) throw binNotMovable(origin.code);
      if (target.systemOwned) throw binNotMovable(target.code);
      if (origin.retiredAt !== null) throw originRetired(origin.code);
      // A BLOCKED origin is allowed (decision 4): emptying it is the point.

      // ── 10. quarantine, both scopes ─────────────────────────────────────
      const quarantined = await this.inventory.openQuarantinedBinsInTx(tx, command.tenantId, command.warehouseId, sku.id, [
        origin.id,
        target.id,
      ]);
      if (quarantined.length > 0) {
        throw moveScopeQuarantined(sku.code, quarantined.includes(origin.id) ? origin.code : target.code);
      }

      // ── 11. the target's placement gates (retired, blocked, class,
      // client, secure, bulk, segregation, capacity) — 409 with each gate's
      // own code, the transfer receive's precedent ──────────────────────────
      await this.inventory.assertPlacementGatesInTx(tx, {
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        binId: target.id,
        intakes: [{ skuId: sku.id, qtyMilli }],
        role,
        subject: 'move',
      });

      // ── 12. the origin's secure authority (FR-42) ──────────────────────
      assertSecureBinAuthority(role, [origin]);

      // ── 13. serials: resolve the codes, lock the set (sorted) ──────────
      let serialArms: { serialRef: string; batchRef: string | null }[] = [];
      if (shape.serials !== null) {
        const numbers = [...shape.serials];
        const rows = await tx
          .select({ id: serials.id, serialNumber: serials.serialNumber })
          .from(serials)
          .where(and(eq(serials.tenantId, command.tenantId), eq(serials.skuId, sku.id), inArray(serials.serialNumber, numbers)));
        const byNumber = new Map(rows.map((row) => [row.serialNumber, row.id]));
        const refs: string[] = [];
        for (const number of numbers) {
          const id = byNumber.get(number);
          if (id === undefined) {
            throw new ProblemException(
              'serial-unknown',
              404,
              'Serial has no ledger location',
              `Serial "${number}" does not exist for SKU "${sku.code}" — there is nothing to move.`,
            );
          }
          refs.push(id);
        }
        await this.inventory.lockSerialsInTx(tx, command.tenantId, refs);
        // Each serial's batch is the one its latest event carried (the merge
        // precedent). A serial that is not in the origin gets none here — the
        // ledger's serial guard refuses it (`serial-elsewhere` /
        // `serial-unknown`) before anything folds.
        const located = sku.batchTracked
          ? new Map(
              (await this.inventory.serialsLocatedInBinInTx(tx, command.tenantId, sku.id, origin.id)).map((entry) => [
                entry.serialRef,
                entry.batchRef,
              ]),
            )
          : new Map<string, string | null>();
        serialArms = refs.map((ref) => ({ serialRef: ref, batchRef: located.get(ref) ?? null }));
      }

      // ── 14. the batch, by (tenant, sku, code) ──────────────────────────
      let batchId: string | null = null;
      if (shape.batchCode !== null) {
        const batchRows = await tx
          .select({ id: batches.id })
          .from(batches)
          .where(and(eq(batches.tenantId, command.tenantId), eq(batches.skuId, sku.id), eq(batches.code, shape.batchCode)))
          .limit(1);
        if (batchRows[0] === undefined) {
          throw new ProblemException(
            'not-found',
            404,
            'Batch not found',
            `No batch "${shape.batchCode}" exists for SKU "${sku.code}".`,
          );
        }
        batchId = batchRows[0].id;
      }

      // ── 15. on-hand per arm (serial arms: the serial guard decides) ────
      if (shape.serials === null) {
        const onHand = await this.inventory.stockByBinsInTx(tx, command.tenantId, command.warehouseId, [sku.id]);
        const available = onHand.find((row) => row.binId === origin.id)?.quantity ?? 0;
        if (available < qtyMilli) {
          throw moveSourceShort(origin.code, sku.code, null, available, qtyMilli);
        }
        if (batchId !== null) {
          const batchRows = await this.inventory.batchOnHandByBinsInTx(tx, command.tenantId, command.warehouseId, [sku.id]);
          const batchAvailable = batchRows.find((row) => row.binId === origin.id && row.batchId === batchId)?.quantity ?? 0;
          if (batchAvailable < qtyMilli) {
            throw moveSourceShort(origin.code, sku.code, shape.batchCode, batchAvailable, qtyMilli);
          }
        }
      }

      // ── 16. the ledger appends — one event per arm ──────────────────────
      const moveId = uuidv7();
      const recordedAt = nowIso();
      const occurredAt = shape.occurredAt ?? recordedAt;
      const referenceDoc = {
        kind: 'bin-move' as const,
        moveId,
        reasonCode: command.reasonCode,
        ...(shape.note === null ? {} : { note: shape.note }),
      };
      const arms =
        shape.serials === null
          ? [{ qty: qtyMilli, batchRef: batchId, serialRef: null as string | null }]
          : serialArms.map((arm) => ({ qty: QUANTITY_SCALE, batchRef: arm.batchRef, serialRef: arm.serialRef as string | null }));
      const events: MoveEventSnapshot[] = [];
      for (const arm of arms) {
        const appended = await this.appendOrShort(tx, origin.code, sku.code, {
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          type: 'stock.moved',
          // Story 3-5b (A1) — the freeze admits a handheld move, never a web one.
          ...(command.deviceId === null ? {} : { surface: 'device' as const }),
          skuId: sku.id,
          quantityDelta: signedQuantity(arm.qty),
          fromBinId: origin.id,
          toBinId: target.id,
          batchRef: arm.batchRef,
          serialRef: arm.serialRef,
          actorUserId: command.actorUserId,
          occurredAt,
          recordedAt,
          referenceDoc,
        });
        events.push({
          seq: appended.seq,
          skuId: sku.id,
          quantity: fromMilli(arm.qty),
          fromBinId: origin.id,
          toBinId: target.id,
          batchRef: arm.batchRef,
          serialRef: arm.serialRef,
          occurredAt: appended.occurredAt,
        });
      }
      const snapshot: MoveStockSnapshot = { moveId, events };

      // ── 17. audit — one row, the operator as actor (a review Apply too) ─
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'stock.moved',
        targetType: 'bin_move',
        targetId: moveId,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });
      if (command.deviceId !== null) {
        await touchDeviceInTx(tx, command.deviceId);
      }

      // ── 18. the idempotency key, LAST ───────────────────────────────────
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
      return snapshot;
    });
  }

  /**
   * One ledger append. A concurrent debit of the origin between the step-15
   * read and the fold (an adjustment takes no bin-row lock) makes the ledger
   * answer 422 `insufficient-on-hand`; the move's own answer for a short
   * origin is 409 `move-source-short` (documented, re-plannable), so it is
   * rethrown as that. Nothing was written — the transaction rolls back.
   */
  private async appendOrShort(
    tx: TenantTx,
    originCode: string,
    skuCode: string,
    movement: Parameters<InventoryFacade['appendLedgerEventInTx']>[1],
  ): ReturnType<InventoryFacade['appendLedgerEventInTx']> {
    try {
      return await this.inventory.appendLedgerEventInTx(tx, movement);
    } catch (err) {
      if (problemCodeOf(err) === 'insufficient-on-hand') {
        throw new ProblemException(
          'move-source-short',
          409,
          'The origin bin holds less than the move',
          `Bin "${originCode}" no longer holds enough of SKU "${skuCode}" for this move — nothing was moved; move what is on hand.`,
        );
      }
      throw err;
    }
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<MoveStockSnapshot | null> {
    const rows = await tx
      .select({ payloadHash: idempotencyKeys.payloadHash, responseSnapshot: idempotencyKeys.responseSnapshot })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const existing = rows[0];
    if (existing === undefined) return null;
    if (existing.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return existing.responseSnapshot as MoveStockSnapshot;
  }
}
