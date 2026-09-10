import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { batchOnHand, ledgerEvents, stockOnHand } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { SignedQuantity } from '../../shared/primitives/quantity';
import { nowIso } from '../../shared/primitives/time';
import { uuidv7 } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { LEDGER_GRAMMAR_VERSION, getLedgerEventType } from './ledger-registry';
import type { LedgerReferenceDoc } from './ledger-registry';
import { LEDGER_ANCHOR_STORE } from './anchor-store';
import type { LedgerAnchorStore } from './anchor-store';

/** Genesis `prev_hash` — the chain's fixed zero digest (64 hex zeros). */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/** Input envelope for one ledger movement (registry-validated at append). */
export interface LedgerMovement {
  readonly tenantId: string;
  readonly warehouseId: string;
  /** A registered event type (`stock.adjusted`) — nothing else appends. */
  readonly type: string;
  readonly skuId: string;
  /** Signed delta in base UoM: positive into `toBinId`, negative out of `fromBinId`. */
  readonly quantityDelta: SignedQuantity;
  readonly fromBinId: string | null;
  readonly toBinId: string | null;
  /**
   * The Story 2.4 arms: the catalog-owned `batches.id` / `serials.id`
   * identity (as text), gated by the registry. A serial-tracked movement is
   * exactly one event per unit — one `serialRef` each, qty ±1. The batch
   * fold and the serial guards key off these refs.
   */
  readonly batchRef: string | null;
  readonly serialRef: string | null;
  readonly actorUserId: string;
  /** Business time (client-supplied, UTC-validated); `recorded_at` is commit time. */
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly referenceDoc: LedgerReferenceDoc;
}

/** The appended event plus the projection state it produced. */
export interface AppendedMovement {
  readonly eventId: string;
  readonly seq: number;
  readonly eventHash: string;
  readonly prevHash: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  /** The touched bin's on-hand after this event (one arm per touched bin). */
  readonly touched: readonly { binId: string; quantity: number }[];
}

/** One divergent scope: replay must match the stored projection exactly. */
export interface ReplayDivergence {
  readonly skuId: string;
  readonly binId: string;
  readonly projectedQuantity: number | null;
  readonly replayedQuantity: number;
  /**
   * Story 2.4: set when the divergence is on the `batch_on_hand` projection
   * (the batch arm of the scope) rather than the plain (sku, bin) quantity.
   */
  readonly batchRef?: string;
  /**
   * The divergent scope's event range inside the scan's compare window
   * (Story 2.2's bounded scan; the plain `replay` compares the whole ledger
   * and leaves these undefined).
   */
  readonly fromSeq?: number;
  readonly toSeq?: number;
}

export interface ReplayReport {
  readonly warehouseId: string;
  /** Number of events folded into the recomputation. */
  readonly eventCount: number;
  readonly matches: boolean;
  readonly divergences: readonly ReplayDivergence[];
}

/** A hash-chain break: scope + the failing seq range (severity-1 alert). */
export interface ChainBreakReport {
  readonly ok: false;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly reason: string;
}

export interface ChainVerifyReport {
  readonly ok: true;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly eventCount: number;
}

/** One scope repaired by a rebuild: the replayed value that was written. */
export interface RebuiltScope {
  readonly skuId: string;
  readonly binId: string;
  /**
   * Story 2.4: set when the repaired row is a `batch_on_hand` row (the batch
   * arm of the scope) rather than the plain (sku, bin) quantity row.
   */
  readonly batchRef?: string;
  /** The stored projection before the repair (null: the row was missing). */
  readonly projectedQuantity: number | null;
  /** The replayed quantity written (the scope's row is at this value now). */
  readonly quantity: number;
  /** True when the repair DELETED a fabricated row (a scope with no events). */
  readonly deleted: boolean;
}

export interface RebuildReport {
  readonly warehouseId: string;
  readonly repaired: readonly RebuiltScope[];
  /** The divergences the rebuild observed (and alerted) before repairing. */
  readonly divergences: readonly ReplayDivergence[];
}

/**
 * The per-(tenant, warehouse) advisory transaction lock — the ONE
 * serialization point per warehouse, shared by the append path (seq
 * allocation), the anchor path, and Story 2.2's rebuild path (so a rebuild's
 * absolute projection write can never clobber a concurrent increment — the
 * append either commits before the lock is taken, or blocks until after it).
 */
export function warehouseAdvisoryLock(tenantId: string, warehouseId: string): SQL {
  return sql`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':' || ${warehouseId}, 0))`;
}

/**
 * The tenant-wide serial-identity lock (Story 2.4, review loop 1): a serial's
 * location can cross warehouses, so the per-warehouse lock alone does not
 * serialize two concurrent appends of the same serial into different
 * warehouses — the serial-arm guards (duplicate-serial / serial-elsewhere)
 * read the serial's LATEST EVENT tenant-wide and are only race-free when
 * every writer of that serial holds this lock first. Keyed on the tenant +
 * serial identity (the catalog `serials.id`), transaction-scoped like the
 * warehouse lock.
 */
export function serialAdvisoryLock(tenantId: string, serialRef: string): SQL {
  return sql`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':serial:' || ${serialRef}, 0))`;
}

/** The verifiable digest artifact produced on demand over an event range. */
export interface DigestExport {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly eventCount: number;
  /** sha256 over the range's `seq:eventHash` lines, in seq order. */
  readonly digest: string;
  readonly computedAt: string;
}

/** The anchor artifact: a committed chain head over a seq range. */
export interface ChainAnchor {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly digest: string;
  readonly anchoredAt: string;
}

/**
 * Canonical event bytes (AD-16): a fixed-key-order JSON serialization of
 * the event envelope. `JSON.stringify` is key-order dependent, so the
 * object is always constructed with exactly this literal shape — the hash
 * is stable across appends, replays, and verifications, and `verifyChain`
 * recomputes it from the row to detect any tampered column.
 */
function canonicalEventBytes(event: {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly seq: number;
  readonly type: string;
  readonly schemaVersion: number;
  readonly skuId: string;
  readonly quantityDelta: number;
  readonly fromBinId: string | null;
  readonly toBinId: string | null;
  readonly batchRef: string | null;
  readonly serialRef: string | null;
  readonly actorUserId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly referenceDoc: LedgerReferenceDoc;
  readonly prevHash: string;
}): string {
  return JSON.stringify({
    id: event.id,
    tenantId: event.tenantId,
    warehouseId: event.warehouseId,
    seq: event.seq,
    type: event.type,
    schemaVersion: event.schemaVersion,
    skuId: event.skuId,
    quantityDelta: event.quantityDelta,
    fromBinId: event.fromBinId,
    toBinId: event.toBinId,
    batchRef: event.batchRef,
    serialRef: event.serialRef,
    actorUserId: event.actorUserId,
    occurredAt: canonicalInstant(event.occurredAt),
    recordedAt: canonicalInstant(event.recordedAt),
    referenceDoc: JSON.parse(canonicalReferenceBytes(event.referenceDoc)),
    prevHash: event.prevHash,
  });
}

/**
 * Timestamps canonicalize to ISO-8601 UTC millis: the row returns
 * `timestamptz` in Postgres's own text shape, so the verifier must not
 * hash the raw string — both sides normalize through the same parse.
 */
export function canonicalInstant(value: string): string {
  return new Date(value).toISOString();
}

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/**
 * Reference docs are canonicalized with alphabetically sorted keys:
 * Postgres `jsonb` does not preserve object key order, so hashing the
 * doc "as stored" would make the verifier recompute a different byte
 * shape than the appender saw. Sorting is stable on both sides.
 */
function canonicalReferenceBytes(doc: LedgerReferenceDoc): string {
  return JSON.stringify(doc, (_key, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const entry of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        sorted[entry[0]] = entry[1];
      }
      return sorted;
    }
    return value;
  });
}

/** Digest over an event-hash range: sha256 of `seq:eventHash` lines. */
export function digestOverRange(
  events: readonly { seq: number; eventHash: string }[],
): string {
  return sha256Hex(events.map((event) => `${event.seq}:${event.eventHash}`).join('\n'));
}

function insufficientOnHand(binCode: string, current: number, delta: number): ProblemException {
  return new ProblemException(
    'insufficient-on-hand',
    422,
    'Adjustment would drive on-hand below zero',
    `Bin "${binCode}" currently holds ${current}; this movement of ${delta} would take it below zero.`,
  );
}

/** Batch over-draw: the batch's on-hand in the bin would go negative. */
function insufficientBatchOnHand(batchRef: string, current: number, delta: number): ProblemException {
  return new ProblemException(
    'insufficient-on-hand',
    422,
    'Adjustment would drive the batch on-hand below zero',
    `Batch "${batchRef}" currently holds ${current} in this bin; this movement of ${delta} would take it below zero.`,
  );
}

/** Intake of a serial that already has a ledger location — 409 naming it. */
function duplicateSerial(serialRef: string, locatedBinId: string): ProblemException {
  return new ProblemException(
    'duplicate-serial',
    409,
    'Serial is already located in a bin',
    `Serial "${serialRef}" is already located in bin "${locatedBinId}" — a serial can live in only one place; draw it out before scanning it in again.`,
  );
}

/** Draw of a serial whose current location is not the from-bin — 409 naming it. */
function serialElsewhere(serialRef: string, locatedBinId: string): ProblemException {
  return new ProblemException(
    'serial-elsewhere',
    409,
    'Serial is located in another bin',
    `Serial "${serialRef}" is currently located in bin "${locatedBinId}", not the bin this movement draws from.`,
  );
}

/** Draw of a serial the ledger has never seen — 404. */
function serialUnknown(serialRef: string): ProblemException {
  return new ProblemException(
    'serial-unknown',
    404,
    'Serial has no ledger location',
    `Serial "${serialRef}" has never been moved — there is nothing to draw it from.`,
  );
}

/**
 * The serial's latest event (Story 2.4) — the ledger-derived state a guard
 * reads: an intake event (`to_bin_id` set) means the serial IS in that bin; a
 * draw event (`from_bin_id` set) means the serial is OUT of stock (last seen
 * leaving that bin). Tenant-wide (a serial's location can cross warehouses),
 * via the `(tenant_id, serial_ref, seq)` index — never projected (AD-6: the
 * ledger is the only source of serial location and history).
 */
async function serialLatestEventInTx(
  tx: TenantTx,
  tenantId: string,
  serialRef: string,
): Promise<{ fromBinId: string | null; toBinId: string | null } | undefined> {
  const rows = await tx
    .select({ fromBinId: ledgerEvents.fromBinId, toBinId: ledgerEvents.toBinId })
    .from(ledgerEvents)
    .where(and(eq(ledgerEvents.tenantId, tenantId), eq(ledgerEvents.serialRef, serialRef)))
    .orderBy(desc(ledgerEvents.seq))
    .limit(1);
  return rows[0];
}

/**
 * The serial-arm guards (Story 2.4), enforced at ledger-write time — serial
 * uniqueness-in-a-bin is the inventory module's rule (AD-6), never a catalog
 * index. Serial-tracked movements are one event per unit (qty ±1), so the
 * per-event check IS the per-unit check:
 *
 * - intake (`quantityDelta > 0`, no `fromBinId`): the serial must not already
 *   live in a bin — its latest event being an intake (any bin, the same one
 *   included: a re-scan would double-count the unit) is a 409
 *   `duplicate-serial` naming that bin. A serial whose latest event is a DRAW
 *   is out of stock and may re-enter (nothing lives anywhere).
 * - relocation (`quantityDelta > 0` WITH a `fromBinId` — Story 3.5's
 *   directed-putaway placement, one two-arm event per serial unit): the draw
 *   and the intake are one event, so the serial's latest event must be an
 *   intake into the movement's `fromBinId` — an intake into another bin is a
 *   409 `serial-elsewhere` naming that bin, never-moved is a 404
 *   `serial-unknown`, already drawn out is a 409 `serial-elsewhere` naming
 *   its last-known bin.
 * - draw (`quantityDelta < 0`): the serial's latest event must be an intake
 *   into the movement's `fromBinId` — an intake into another bin is a 409
 *   `serial-elsewhere` naming that bin, a serial already drawn out is a 409
 *   `serial-elsewhere` naming its last-known bin, never-moved is a 404
 *   `serial-unknown`.
 *
 * Runs under the per-warehouse advisory lock AND the tenant-wide serial lock
 * (review loop 1 — the guard's read is tenant-wide, so the lock must be too)
 * inside the append transaction, and reads the transaction's own prior
 * writes — so the N events of one adjustment see each other, and a
 * concurrent append of the same serial serializes behind the lock even
 * across warehouses.
 */
async function assertSerialArmLegal(tx: TenantTx, movement: LedgerMovement): Promise<void> {
  const serialRef = movement.serialRef;
  if (serialRef === null) {
    return;
  }
  const latest = await serialLatestEventInTx(tx, movement.tenantId, serialRef);
  if (movement.quantityDelta > 0 && movement.fromBinId === null) {
    // Pure intake: the serial enters stock.
    if (latest !== undefined && latest.toBinId !== null) {
      throw duplicateSerial(serialRef, latest.toBinId);
    }
  } else if (movement.quantityDelta > 0) {
    // Two-arm relocation (a directed-putaway placement event): the serial
    // moves out of `fromBinId` and into `toBinId` in one event — the draw
    // half of the guard decides.
    if (latest === undefined) {
      throw serialUnknown(serialRef);
    }
    if (latest.toBinId !== movement.fromBinId) {
      throw serialElsewhere(serialRef, latest.toBinId ?? latest.fromBinId!);
    }
  } else {
    if (latest === undefined) {
      throw serialUnknown(serialRef);
    }
    if (latest.toBinId !== null) {
      // Currently in stock — the from-bin must be where it lives.
      if (latest.toBinId !== movement.fromBinId) {
        throw serialElsewhere(serialRef, latest.toBinId);
      }
    } else {
      // Already drawn out of stock — nothing to draw again.
      throw serialElsewhere(serialRef, latest.fromBinId!);
    }
  }
}

/**
 * The ledger core (Story 2.1): the ONLY code path that writes
 * `ledger_events` / `stock_on_hand` / `ledger_anchors`. Appends run
 * strictly inside the caller's tenant transaction (`withTenantTransaction`)
 * so each event and its derived projection commit — or roll back — as one.
 *
 * Concurrency: a `pg_advisory_xact_lock` keyed per (tenant, warehouse) is
 * taken inside the append transaction before the seq allocation — the
 * sanctioned mechanism (no retry loops on sequence races). Under the lock,
 * `seq` is `max(seq) + 1`: gap-free and unique (the unique index is the
 * backstop), and the hash-chain predecessor is deterministic.
 *
 * Chain (AD-16): per tenant+warehouse, sha256 over the canonical event
 * bytes, each event carrying its predecessor's hash (genesis = 64 zeros).
 * The head is anchored through the `LedgerAnchorStore` seam.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger('LedgerService');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(LEDGER_ANCHOR_STORE) private readonly anchorStore: LedgerAnchorStore,
  ) {}

  /**
   * Appends one registry-validated movement and updates the on-hand
   * projection in the SAME transaction. An unregistered event type, a
   * reference kind the type does not declare, a batch/serial arm on a type
   * that does not allow them, or an over-draw fails the whole transaction
   * before anything commits.
   */
  async appendMovement(tx: TenantTx, movement: LedgerMovement): Promise<AppendedMovement> {
    const definition = getLedgerEventType(movement.type);
    if (definition === undefined) {
      throw new Error(`Ledger event type is not registered: ${movement.type}`);
    }
    if (!definition.referenceKinds.includes(movement.referenceDoc.kind)) {
      throw new Error(
        `Reference kind "${movement.referenceDoc.kind}" is not registered for ${movement.type}`,
      );
    }
    if (movement.batchRef !== null && !definition.allowsBatchArm) {
      throw new Error(`Event type ${movement.type} does not allow the batch arm`);
    }
    if (movement.serialRef !== null && !definition.allowsSerialArm) {
      throw new Error(`Event type ${movement.type} does not allow the serial arm`);
    }

    // Concurrency: one writer per warehouse for this transaction. The lock
    // is transaction-scoped — it dies with the commit/rollback. A serial-arm
    // movement additionally holds the tenant-wide serial lock (a serial's
    // location can cross warehouses — the guards below are tenant-wide
    // reads); the multi-serial caller pre-locks its whole set in sorted
    // order via `lockSerialsInTx`, so this re-acquire is a no-op.
    await tx.execute(warehouseAdvisoryLock(movement.tenantId, movement.warehouseId));
    if (movement.serialRef !== null) {
      await tx.execute(serialAdvisoryLock(movement.tenantId, movement.serialRef));
    }

    // Story 2.4 serial guards: under the lock (so a concurrent scan of the
    // same serial serializes behind it), before any write — a duplicate scan
    // or a wrong-bin draw fails the whole transaction naming the conflict.
    await assertSerialArmLegal(tx, movement);

    const headRows = await tx
      .select({ seq: ledgerEvents.seq, eventHash: ledgerEvents.eventHash })
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.tenantId, movement.tenantId),
          eq(ledgerEvents.warehouseId, movement.warehouseId),
        ),
      )
      .orderBy(desc(ledgerEvents.seq))
      .limit(1);
    const head = headRows[0];
    const seq = (head?.seq ?? 0) + 1;
    const prevHash = head?.eventHash ?? GENESIS_PREV_HASH;

    const eventId = uuidv7();
    const schemaVersion = LEDGER_GRAMMAR_VERSION;
    const eventHash = sha256Hex(
      canonicalEventBytes({
        id: eventId,
        tenantId: movement.tenantId,
        warehouseId: movement.warehouseId,
        seq,
        type: movement.type,
        schemaVersion,
        skuId: movement.skuId,
        quantityDelta: movement.quantityDelta,
        fromBinId: movement.fromBinId,
        toBinId: movement.toBinId,
        batchRef: movement.batchRef,
        serialRef: movement.serialRef,
        actorUserId: movement.actorUserId,
        occurredAt: movement.occurredAt,
        recordedAt: movement.recordedAt,
        referenceDoc: movement.referenceDoc,
        prevHash,
      }),
    );

    await tx.insert(ledgerEvents).values({
      id: eventId,
      tenantId: movement.tenantId,
      warehouseId: movement.warehouseId,
      seq,
      type: movement.type,
      schemaVersion,
      skuId: movement.skuId,
      quantityDelta: movement.quantityDelta,
      fromBinId: movement.fromBinId,
      toBinId: movement.toBinId,
      batchRef: movement.batchRef,
      serialRef: movement.serialRef,
      actorUserId: movement.actorUserId,
      occurredAt: movement.occurredAt,
      recordedAt: movement.recordedAt,
      referenceDoc: movement.referenceDoc,
      prevHash,
      eventHash,
    });

    // Derived projections, same transaction: the to-bin RECEIVES the
    // movement's magnitude, the from-bin RELEASES it (a later two-arm
    // transfer event carries the magnitude on both arms). An over-draw is
    // rejected naming the bin and its current on-hand — the whole
    // transaction rolls back with it. The Story 2.4 batch arm folds the SAME
    // magnitude into `batch_on_hand` beside the (sku, bin) fold — one event,
    // one transaction, both projections.
    const touched: { binId: string; quantity: number }[] = [];
    const magnitude = Math.abs(movement.quantityDelta);
    if (movement.toBinId !== null) {
      const row = await this.addToOnHand(
        tx,
        movement.tenantId,
        movement.warehouseId,
        movement.skuId,
        movement.toBinId,
        magnitude,
      );
      touched.push({ binId: row.binId, quantity: row.quantity });
    }
    if (movement.fromBinId !== null) {
      const row = await this.addToOnHand(
        tx,
        movement.tenantId,
        movement.warehouseId,
        movement.skuId,
        movement.fromBinId,
        -magnitude,
      );
      touched.push({ binId: row.binId, quantity: row.quantity });
    }
    if (movement.batchRef !== null) {
      if (movement.toBinId !== null) {
        await this.addToBatchOnHand(
          tx,
          movement.tenantId,
          movement.warehouseId,
          movement.skuId,
          movement.toBinId,
          movement.batchRef,
          magnitude,
        );
      }
      if (movement.fromBinId !== null) {
        await this.addToBatchOnHand(
          tx,
          movement.tenantId,
          movement.warehouseId,
          movement.skuId,
          movement.fromBinId,
          movement.batchRef,
          -magnitude,
        );
      }
    }

    return {
      eventId,
      seq,
      eventHash,
      prevHash,
      occurredAt: movement.occurredAt,
      recordedAt: movement.recordedAt,
      touched,
    };
  }

  /**
   * Pre-locks a serial-tracked movement's WHOLE serial set, tenant-wide and
   * in sorted (deterministic) acquisition order — review loop 1: two
   * concurrent multi-serial adjustments whose sets overlap could otherwise
   * deadlock acquiring their per-event serial locks in input order. Call
   * once inside the movement's transaction BEFORE the first append; each
   * append's own serial lock (same key) is then a re-entrant no-op.
   */
  async lockSerialsInTx(
    tx: TenantTx,
    tenantId: string,
    serialRefs: readonly string[],
  ): Promise<void> {
    for (const serialRef of [...serialRefs].sort()) {
      await tx.execute(serialAdvisoryLock(tenantId, serialRef));
    }
  }

  /**
   * Upserts the on-hand row for one (tenant, warehouse, sku, bin) scope
   * with the signed delta. The only stock-projection write in the system —
   * the architecture test fails any second quantity-mutation path.
   */
  private async addToOnHand(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    skuId: string,
    binId: string,
    delta: number,
  ): Promise<{ binId: string; quantity: number }> {
    const currentRows = await tx
      .select({ quantity: stockOnHand.quantity })
      .from(stockOnHand)
      .where(
        and(
          eq(stockOnHand.tenantId, tenantId),
          eq(stockOnHand.warehouseId, warehouseId),
          eq(stockOnHand.skuId, skuId),
          eq(stockOnHand.binId, binId),
        ),
      )
      .limit(1);
    const current = currentRows[0]?.quantity ?? 0;
    if (current + delta < 0) {
      throw insufficientOnHand(binId, current, delta);
    }

    const rows = await tx
      .insert(stockOnHand)
      .values({
        id: uuidv7(),
        tenantId,
        warehouseId,
        skuId,
        binId,
        // Postgres evaluates the table CHECK on the speculative insert tuple
        // BEFORE the arbiter detects the conflict — a negative delta against
        // an existing row would fail the non-negative CHECK on the discarded
        // row even though the UPDATE arm below is the one that lands. The
        // insert arm only ever fires for a fresh scope, where the
        // insufficient-on-hand guard above already guarantees delta > 0 — so
        // clamping the speculative tuple at 0 changes nothing real and keeps
        // negative adjustments off the CHECK.
        quantity: sql`greatest(${delta}, 0)`,
      })
      .onConflictDoUpdate({
        target: [stockOnHand.tenantId, stockOnHand.warehouseId, stockOnHand.skuId, stockOnHand.binId],
        set: { quantity: sql`${stockOnHand.quantity} + ${delta}`, updatedAt: nowIso() },
      })
      .returning({ binId: stockOnHand.binId, quantity: stockOnHand.quantity });
    const row = rows[0]!;
    return { binId: row.binId, quantity: row.quantity };
  }

  /**
   * The batch-arm fold (Story 2.4) — the `batch_on_hand` sibling of
   * `addToOnHand`, in this same file and the same transaction: upserts the
   * (tenant, warehouse, sku, bin, batch) scope with the signed delta. An
   * over-draw beyond the BATCH's bin quantity is rejected naming the batch
   * (the api layer names the code; here the ledger names the batchRef it was
   * handed) — the whole transaction rolls back with it.
   */
  private async addToBatchOnHand(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    skuId: string,
    binId: string,
    batchId: string,
    delta: number,
  ): Promise<{ binId: string; batchId: string; quantity: number }> {
    const currentRows = await tx
      .select({ quantity: batchOnHand.quantity })
      .from(batchOnHand)
      .where(
        and(
          eq(batchOnHand.tenantId, tenantId),
          eq(batchOnHand.warehouseId, warehouseId),
          eq(batchOnHand.skuId, skuId),
          eq(batchOnHand.binId, binId),
          eq(batchOnHand.batchId, batchId),
        ),
      )
      .limit(1);
    const current = currentRows[0]?.quantity ?? 0;
    if (current + delta < 0) {
      throw insufficientBatchOnHand(batchId, current, delta);
    }

    const rows = await tx
      .insert(batchOnHand)
      .values({
        id: uuidv7(),
        tenantId,
        warehouseId,
        skuId,
        binId,
        batchId,
        // Same speculative-tuple CHECK clamp as `addToOnHand` above.
        quantity: sql`greatest(${delta}, 0)`,
      })
      .onConflictDoUpdate({
        target: [
          batchOnHand.tenantId,
          batchOnHand.warehouseId,
          batchOnHand.skuId,
          batchOnHand.binId,
          batchOnHand.batchId,
        ],
        set: { quantity: sql`${batchOnHand.quantity} + ${delta}`, updatedAt: nowIso() },
      })
      .returning({ binId: batchOnHand.binId, batchId: batchOnHand.batchId, quantity: batchOnHand.quantity });
    const row = rows[0]!;
    return { binId: row.binId, batchId: row.batchId, quantity: row.quantity };
  }

  /**
   * Replay (Story 2.1 — the debug/verification tool, consumed by Story
   * 2.2's continuous job; never auto-heals): recomputes on-hand purely from
   * one SKU/bin's events — or the whole warehouse when the SKU is omitted —
   * and compares against the stored projection exactly.
   */
  async replay(
    tenantId: string,
    warehouseId: string,
    skuId?: string,
    binId?: string,
  ): Promise<ReplayReport> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      replayInTx(tx, tenantId, warehouseId, skuId, binId),
    );
  }

  /**
   * Rebuild (Story 2.2 — derived-state repair, the operator/debug entry into
   * `rebuildProjectionsInTx`): recomputes `stock_on_hand` from
   * `ledger_events` for the requested scope (or every divergent scope of the
   * warehouse when the scope is omitted) and rewrites the rows to the
   * replayed quantities — under the same per-warehouse advisory xact lock the
   * append path uses, so no concurrent increment is clobbered, and in ONE
   * transaction with the `reconciliation.divergence` alert that names what it
   * repaired (alert + rebuild together; silence is never an outcome). A
   * scope that replays clean writes nothing — the worker never rewrites a
   * projection it has not proven divergent by replay.
   */
  async rebuildProjections(
    tenantId: string,
    warehouseId: string,
    scope?: { skuId?: string; binId?: string },
  ): Promise<RebuildReport> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await tx.execute(warehouseAdvisoryLock(tenantId, warehouseId));
      // Observe first: the repair targets exactly the scopes replay proves
      // divergent (never a blind rewrite).
      const report = await replayInTx(tx, tenantId, warehouseId, scope?.skuId, scope?.binId);
      if (report.matches) {
        return { warehouseId, repaired: [], divergences: [] };
      }
      const headRows = await tx
        .select({ seq: ledgerEvents.seq })
        .from(ledgerEvents)
        .where(
          and(eq(ledgerEvents.tenantId, tenantId), eq(ledgerEvents.warehouseId, warehouseId)),
        )
        .orderBy(desc(ledgerEvents.seq))
        .limit(1);
      const repaired = await rebuildProjectionsInTx(
        tx,
        tenantId,
        warehouseId,
        report.divergences.map((divergence) => ({ skuId: divergence.skuId, binId: divergence.binId })),
      );
      // The divergence alert, in the SAME transaction as the repair (the
      // chain_broken precedent: a small tenant transaction for an event with
      // no domain write of its own to piggyback on).
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId,
        type: 'reconciliation.divergence',
        occurredAt: nowIso(),
        payload: {
          warehouseId,
          watermark: headRows[0]?.seq ?? 0,
          trigger: 'manual-rebuild',
          divergences: report.divergences.map((divergence) => ({
            skuId: divergence.skuId,
            binId: divergence.binId,
            projected: divergence.projectedQuantity,
            replayed: divergence.replayedQuantity,
            fromSeq: divergence.fromSeq ?? 1,
            toSeq: divergence.toSeq ?? headRows[0]?.seq ?? 0,
          })),
        },
      });
      return { warehouseId, repaired, divergences: report.divergences };
    });
  }

  /**
   * Chain verification (AD-16): walks the chain in `seq` order, recomputing
   * each event's hash over its canonical bytes and checking the
   * predecessor linkage. Any break surfaces as a severity-1 alert (error
   * log + `ledger.chain_broken` alert event) naming the scope and the seq
   * range — detection only, never auto-heal.
   */
  async verifyChain(
    tenantId: string,
    warehouseId: string,
    fromSeq = 1,
    toSeq?: number,
  ): Promise<ChainVerifyReport | ChainBreakReport> {
    const report = await withTenantTransaction(this.db, tenantId, (tx) =>
      verifyChainInTx(tx, tenantId, warehouseId, fromSeq, toSeq),
    );
    if (report.ok === false) {
      this.logger.error(
        `SEVERITY-1 ledger chain break: tenant=${report.tenantId} ` +
          `warehouse=${report.warehouseId} seq=${report.fromSeq}..${report.toSeq} — ${report.reason}`,
      );
      // The severity-1 alert rides the transactional outbox like every other
      // event: it has no domain write of its own to piggyback on, so it gets
      // its own small tenant transaction (story outbox-relay). A failure here
      // propagates — a lost chain-break alert must fail loudly, not silently.
      await withTenantTransaction(this.db, tenantId, (tx) =>
        this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId,
          type: 'ledger.chain_broken',
          occurredAt: nowIso(),
          payload: {
            warehouseId: report.warehouseId,
            fromSeq: report.fromSeq,
            toSeq: report.toSeq,
            reason: report.reason,
          },
        }),
      );
    }
    return report;
  }

  /**
   * Anchors the chain head — or the tail since the last anchor — to the
   * configured anchor store: one `ledger_anchors` row (append-only) with
   * the verifiable range digest, committed in one tenant transaction.
   *
   * Verify-before-anchor (Story 2.2): the range is walked inside the anchor
   * transaction before anything is committed — an anchor is only ever
   * committed over a chain that still verifies. On a break the method
   * RETURNS the `ChainBreakReport` (no anchor row, no digest committed) and
   * the existing severity-1 alert path fires after it, exactly as
   * `verifyChain` reports a break.
   */
  async anchorChain(
    tenantId: string,
    warehouseId: string,
    uptoSeq?: number,
  ): Promise<ChainAnchor | ChainBreakReport> {
    const result = await withTenantTransaction<ChainAnchor | ChainBreakReport>(
      this.db,
      tenantId,
      async (tx) => {
      // One anchor committer per warehouse scope: two concurrent anchor
      // calls would otherwise read the same lastToSeq and commit
      // overlapping anchor rows. Same mechanism as the seq allocation.
      await tx.execute(warehouseAdvisoryLock(tenantId, warehouseId));
      const headRows = await tx
        .select({ seq: ledgerEvents.seq })
        .from(ledgerEvents)
        .where(
          and(
            eq(ledgerEvents.tenantId, tenantId),
            eq(ledgerEvents.warehouseId, warehouseId),
          ),
        )
        .orderBy(desc(ledgerEvents.seq))
        .limit(1);
      const headSeq = headRows[0]?.seq;
      if (headSeq === undefined) {
        throw new ProblemException(
          'validation-failed',
          422,
          'Nothing to anchor',
          'This warehouse has no ledger events yet — anchors cover at least one event.',
        );
      }
      const toSeq = Math.min(uptoSeq ?? headSeq, headSeq);
      const last = await this.anchorStore.latest({ tenantId, warehouseId }, tx);
      const lastToSeq = last?.toSeq ?? 0;
      const fromSeq = lastToSeq + 1;
      if (fromSeq > toSeq) {
        throw new ProblemException(
          'validation-failed',
          422,
          'Nothing new to anchor',
          `The chain is already anchored through seq ${lastToSeq}.`,
        );
      }
      const rangeRows = await tx
        .select({ seq: ledgerEvents.seq, eventHash: ledgerEvents.eventHash })
        .from(ledgerEvents)
        .where(
          and(
            eq(ledgerEvents.tenantId, tenantId),
            eq(ledgerEvents.warehouseId, warehouseId),
            gte(ledgerEvents.seq, fromSeq),
            lte(ledgerEvents.seq, toSeq),
          ),
        )
        .orderBy(asc(ledgerEvents.seq));
      // Contiguity: a gapped range would silently anchor a partial digest.
      if (rangeRows.length !== toSeq - fromSeq + 1) {
        throw new ProblemException(
          'validation-failed',
          422,
          'Seq gap in anchor range',
          `Expected ${toSeq - fromSeq + 1} events in seq ${fromSeq}..${toSeq} but found ${rangeRows.length} — the range is gapped.`,
        );
      }
      // Verify-before-anchor: walk the range's chain inside the anchor
      // transaction — a tampered (or gapped, or predecessor-missing) range
      // must never get a digest committed over it.
      const chainReport = await verifyChainInTx(tx, tenantId, warehouseId, fromSeq, toSeq);
      if (chainReport.ok === false) {
        return chainReport; // refuse: the transaction commits nothing.
      }
      const digest = digestOverRange(rangeRows);
      const anchoredAt = nowIso();
      await this.anchorStore.anchor({ tenantId, warehouseId, fromSeq, toSeq, digest, anchoredAt }, tx);
      return { tenantId, warehouseId, fromSeq, toSeq, digest, anchoredAt };
    });
    if ('reason' in result) {
      // The severity-1 alert rides the transactional outbox like every other
      // event: its own small tenant transaction (the `verifyChain`
      // precedent) — the anchor transaction committed nothing, so the alert
      // must not ride it. A failure here propagates: a lost chain-break
      // alert must fail loudly, not silently.
      this.logger.error(
        `SEVERITY-1 ledger chain break: tenant=${result.tenantId} ` +
          `warehouse=${result.warehouseId} seq=${result.fromSeq}..${result.toSeq} — ${result.reason}`,
      );
      await withTenantTransaction(this.db, tenantId, (tx) =>
        this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId,
          type: 'ledger.chain_broken',
          occurredAt: nowIso(),
          payload: {
            warehouseId: result.warehouseId,
            fromSeq: result.fromSeq,
            toSeq: result.toSeq,
            reason: result.reason,
          },
        }),
      );
    }
    return result;
  }

  /**
   * Verifiable digest export over an event range (AD-16): produced on
   * demand as an artifact — sha256 over the range's `seq:eventHash` lines
   * in seq order, independently recomputable from any export of the same
   * rows.
   */
  async exportDigest(
    tenantId: string,
    warehouseId: string,
    fromSeq: number,
    toSeq: number,
  ): Promise<DigestExport> {
    if (fromSeq < 1 || toSeq < fromSeq) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Invalid digest range',
        `The seq range must satisfy 1 <= fromSeq <= toSeq (got ${fromSeq}..${toSeq}).`,
      );
    }
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ seq: ledgerEvents.seq, eventHash: ledgerEvents.eventHash })
        .from(ledgerEvents)
        .where(
          and(
            eq(ledgerEvents.tenantId, tenantId),
            eq(ledgerEvents.warehouseId, warehouseId),
            gte(ledgerEvents.seq, fromSeq),
            lte(ledgerEvents.seq, toSeq),
          ),
        )
        .orderBy(asc(ledgerEvents.seq));
      if (rows.length === 0) {
        throw new ProblemException(
          'validation-failed',
          400,
          'Digest range has no events',
          `No ledger events exist in seq ${fromSeq}..${toSeq} for this warehouse.`,
        );
      }
      // Contiguity: a digest over a gapped range would be a silently
      // partial artifact — reject it naming the gap.
      if (rows.length !== toSeq - fromSeq + 1) {
        throw new ProblemException(
          'validation-failed',
          400,
          'Seq gap in digest range',
          `Expected ${toSeq - fromSeq + 1} events in seq ${fromSeq}..${toSeq} but found ${rows.length} — the range is gapped.`,
        );
      }
      return {
        tenantId,
        warehouseId,
        fromSeq,
        toSeq,
        eventCount: rows.length,
        digest: digestOverRange(rows),
        computedAt: nowIso(),
      };
    });
  }
}

/**
 * The shared fold (Story 2.2): walks one warehouse's events in `seq` order —
 * the replay order (AD-11) — folding each event's signed delta into
 * per-(sku, bin) buckets. Quantities are absolute, so the fold is always
 * whole (from seq 1); `toSeq` bounds WHICH events are folded (the watermark:
 * a movement committing mid-scan has seq > toSeq and is never folded).
 *
 * `windowFromSeq` additionally records, for every scope touched by an event
 * with `seq > windowFromSeq`, the min/max seq of the window's events touching
 * it — Story 2.2's bounded compare window (the checkpoint bounds what the
 * scan compares, not what it folds).
 */
async function foldLedgerInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  options: { skuId?: string; binId?: string; toSeq?: number; windowFromSeq?: number } = {},
): Promise<{
  replayed: Map<string, number>;
  windowScopes: Map<string, { fromSeq: number; toSeq: number }>;
  /** Story 2.4: the batch-arm fold — per (sku, bin, batch) buckets. */
  batchReplayed: Map<string, number>;
  batchWindowScopes: Map<string, { fromSeq: number; toSeq: number }>;
  eventCount: number;
}> {
  const conditions: SQL[] = [
    eq(ledgerEvents.tenantId, tenantId),
    eq(ledgerEvents.warehouseId, warehouseId),
  ];
  if (options.skuId !== undefined) {
    conditions.push(eq(ledgerEvents.skuId, options.skuId));
  }
  if (options.binId !== undefined) {
    // Same scope as the projected side: without this, sibling bins of the
    // SKU (excluded from the projection comparison) surface as phantom
    // divergences.
    conditions.push(or(eq(ledgerEvents.toBinId, options.binId), eq(ledgerEvents.fromBinId, options.binId))!);
  }
  if (options.toSeq !== undefined) {
    // The watermark: only events the cycle has proven committed are folded.
    conditions.push(lte(ledgerEvents.seq, options.toSeq));
  }
  const rows = await tx
    .select({
      seq: ledgerEvents.seq,
      skuId: ledgerEvents.skuId,
      quantityDelta: ledgerEvents.quantityDelta,
      fromBinId: ledgerEvents.fromBinId,
      toBinId: ledgerEvents.toBinId,
      batchRef: ledgerEvents.batchRef,
    })
    .from(ledgerEvents)
    .where(and(...conditions))
    .orderBy(asc(ledgerEvents.seq));

  const replayed = new Map<string, number>();
  const windowScopes = new Map<string, { fromSeq: number; toSeq: number }>();
  // Story 2.4: the batch arm folds the SAME events into per-(sku, bin, batch)
  // buckets — keyed `${skuId}:${binId}:${batchId}` (uuids carry no ':', so
  // the scope prefix parses unambiguously). Events without the batch arm
  // touch nothing here.
  const batchReplayed = new Map<string, number>();
  const batchWindowScopes = new Map<string, { fromSeq: number; toSeq: number }>();
  const recordWindowScope = (
    scopes: Map<string, { fromSeq: number; toSeq: number }>,
    key: string,
    seq: number,
  ): void => {
    const range = scopes.get(key);
    scopes.set(key, {
      fromSeq: Math.min(range?.fromSeq ?? seq, seq),
      toSeq: Math.max(range?.toSeq ?? seq, seq),
    });
  };
  for (const row of rows) {
    const magnitude = Math.abs(row.quantityDelta);
    const inWindow = options.windowFromSeq !== undefined && row.seq > options.windowFromSeq;
    if (row.toBinId !== null) {
      const key = replayKey(row.skuId, row.toBinId);
      replayed.set(key, (replayed.get(key) ?? 0) + magnitude);
      if (inWindow) {
        recordWindowScope(windowScopes, key, row.seq);
      }
      if (row.batchRef !== null) {
        const batchKey = batchReplayKey(row.skuId, row.toBinId, row.batchRef);
        batchReplayed.set(batchKey, (batchReplayed.get(batchKey) ?? 0) + magnitude);
        if (inWindow) {
          recordWindowScope(batchWindowScopes, batchKey, row.seq);
        }
      }
    }
    if (row.fromBinId !== null) {
      const key = replayKey(row.skuId, row.fromBinId);
      replayed.set(key, (replayed.get(key) ?? 0) - magnitude);
      if (inWindow) {
        recordWindowScope(windowScopes, key, row.seq);
      }
      if (row.batchRef !== null) {
        const batchKey = batchReplayKey(row.skuId, row.fromBinId, row.batchRef);
        batchReplayed.set(batchKey, (batchReplayed.get(batchKey) ?? 0) - magnitude);
        if (inWindow) {
          recordWindowScope(batchWindowScopes, batchKey, row.seq);
        }
      }
    }
  }

  return { replayed, windowScopes, batchReplayed, batchWindowScopes, eventCount: rows.length };
}

function replayKey(skuId: string, binId: string): string {
  return `${skuId}:${binId}`;
}

function batchReplayKey(skuId: string, binId: string, batchId: string): string {
  return `${skuId}:${binId}:${batchId}`;
}

/**
 * Replay recomputation inside an existing transaction: folds every event's
 * signed delta into per-(sku, bin) buckets in `seq` order — the replay
 * order (AD-11) — then compares the buckets against the stored projection
 * exactly (`matches` names every divergence; never auto-heals).
 */
export async function replayInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  skuId?: string,
  binId?: string,
): Promise<ReplayReport> {
  const { replayed, batchReplayed, eventCount } = await foldLedgerInTx(
    tx,
    tenantId,
    warehouseId,
    // `exactOptionalPropertyTypes`: the filters are absent, not undefined.
    {
      ...(skuId !== undefined ? { skuId } : {}),
      ...(binId !== undefined ? { binId } : {}),
    },
  );

  // The stored projection for the same scope — compared entry by entry.
  const scopeConditions: SQL[] = [
    eq(stockOnHand.tenantId, tenantId),
    eq(stockOnHand.warehouseId, warehouseId),
  ];
  if (skuId !== undefined) {
    scopeConditions.push(eq(stockOnHand.skuId, skuId));
  }
  if (binId !== undefined) {
    scopeConditions.push(eq(stockOnHand.binId, binId));
  }
  const projectedRows = await tx
    .select({ skuId: stockOnHand.skuId, binId: stockOnHand.binId, quantity: stockOnHand.quantity })
    .from(stockOnHand)
    .where(and(...scopeConditions));

  const divergences: ReplayDivergence[] = [];
  for (const projected of projectedRows) {
    const key = replayKey(projected.skuId, projected.binId);
    const replayedQuantity = replayed.get(key) ?? 0;
    if (replayedQuantity !== projected.quantity) {
      divergences.push({
        skuId: projected.skuId,
        binId: projected.binId,
        projectedQuantity: projected.quantity,
        replayedQuantity,
      });
    }
    replayed.delete(key);
  }
  // A replay bucket with no projection row at all is equally divergent.
  for (const [key, replayedQuantity] of replayed) {
    const [skuIdPart, binIdPart] = key.split(':');
    divergences.push({
      skuId: skuIdPart!,
      binId: binIdPart!,
      projectedQuantity: null,
      replayedQuantity,
    });
  }

  // Story 2.4 rebuild parity: the `batch_on_hand` projection is replayed and
  // compared by the same exactness rule — the ledger re-derives it too.
  const batchScopeConditions: SQL[] = [
    eq(batchOnHand.tenantId, tenantId),
    eq(batchOnHand.warehouseId, warehouseId),
  ];
  if (skuId !== undefined) {
    batchScopeConditions.push(eq(batchOnHand.skuId, skuId));
  }
  if (binId !== undefined) {
    batchScopeConditions.push(eq(batchOnHand.binId, binId));
  }
  const projectedBatchRows = await tx
    .select({
      skuId: batchOnHand.skuId,
      binId: batchOnHand.binId,
      batchId: batchOnHand.batchId,
      quantity: batchOnHand.quantity,
    })
    .from(batchOnHand)
    .where(and(...batchScopeConditions));
  for (const projected of projectedBatchRows) {
    const key = batchReplayKey(projected.skuId, projected.binId, projected.batchId);
    const replayedQuantity = batchReplayed.get(key) ?? 0;
    if (replayedQuantity !== projected.quantity) {
      divergences.push({
        skuId: projected.skuId,
        binId: projected.binId,
        batchRef: projected.batchId,
        projectedQuantity: projected.quantity,
        replayedQuantity,
      });
    }
    batchReplayed.delete(key);
  }
  for (const [key, replayedQuantity] of batchReplayed) {
    const [skuIdPart, binIdPart, batchIdPart] = key.split(':');
    divergences.push({
      skuId: skuIdPart!,
      binId: binIdPart!,
      batchRef: batchIdPart!,
      projectedQuantity: null,
      replayedQuantity,
    });
  }

  return { warehouseId, eventCount, matches: divergences.length === 0, divergences };
}

/**
 * The bounded scan (Story 2.2): folds events with `seq <= toSeq` from seq 1
 * (quantities are absolute — the fold is whole) but compares ONLY the
 * (sku, bin) scopes touched by events in `(fromSeq, toSeq]` — the checkpoint's
 * bounded compare window. A pre-existing divergence on an untouched scope is
 * caught by a full pass (no checkpoint) or a rebuild, not this scan. Each
 * divergence names its scope's event range inside the window.
 */
export async function reconcileScanInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  fromSeq: number,
  toSeq: number,
): Promise<ReplayReport> {
  const { replayed, windowScopes, batchReplayed, batchWindowScopes, eventCount } =
    await foldLedgerInTx(tx, tenantId, warehouseId, {
      toSeq,
      windowFromSeq: fromSeq,
    });

  // The stored projection, read warehouse-wide (one MVCC-consistent read —
  // the scan takes no lock) and filtered in memory to the window's scopes.
  const projectedRows = await tx
    .select({ skuId: stockOnHand.skuId, binId: stockOnHand.binId, quantity: stockOnHand.quantity })
    .from(stockOnHand)
    .where(
      and(eq(stockOnHand.tenantId, tenantId), eq(stockOnHand.warehouseId, warehouseId)),
    );
  const projectedByKey = new Map(projectedRows.map((row) => [replayKey(row.skuId, row.binId), row]));

  const divergences: ReplayDivergence[] = [];
  for (const [key, range] of windowScopes) {
    const projected = projectedByKey.get(key);
    const replayedQuantity = replayed.get(key) ?? 0;
    // A scope touched in the window must have a projection row whose
    // quantity matches the replay exactly (the same rule the full replay
    // applies to every scope — including a missing row, which is itself
    // divergence).
    if (projected === undefined || projected.quantity !== replayedQuantity) {
      const [skuIdPart, binIdPart] = key.split(':');
      divergences.push({
        skuId: skuIdPart!,
        binId: binIdPart!,
        projectedQuantity: projected?.quantity ?? null,
        replayedQuantity,
        fromSeq: range.fromSeq,
        toSeq: range.toSeq,
      });
    }
  }

  // Story 2.4: the batch arm is scanned under the same bounded-window rule —
  // only batch scopes touched by window events are compared.
  const projectedBatchRows = await tx
    .select({
      skuId: batchOnHand.skuId,
      binId: batchOnHand.binId,
      batchId: batchOnHand.batchId,
      quantity: batchOnHand.quantity,
    })
    .from(batchOnHand)
    .where(
      and(eq(batchOnHand.tenantId, tenantId), eq(batchOnHand.warehouseId, warehouseId)),
    );
  const projectedBatchByKey = new Map(
    projectedBatchRows.map((row) => [batchReplayKey(row.skuId, row.binId, row.batchId), row]),
  );
  for (const [key, range] of batchWindowScopes) {
    const projected = projectedBatchByKey.get(key);
    const replayedQuantity = batchReplayed.get(key) ?? 0;
    if (projected === undefined || projected.quantity !== replayedQuantity) {
      const [skuIdPart, binIdPart, batchIdPart] = key.split(':');
      divergences.push({
        skuId: skuIdPart!,
        binId: binIdPart!,
        batchRef: batchIdPart!,
        projectedQuantity: projected?.quantity ?? null,
        replayedQuantity,
        fromSeq: range.fromSeq,
        toSeq: range.toSeq,
      });
    }
  }

  return { warehouseId, eventCount, matches: divergences.length === 0, divergences };
}

/**
 * Derived-state repair inside an existing transaction (Story 2.2): rewrites
 * `stock_on_hand` rows to the replayed quantities for the requested scopes —
 * the single sanctioned stock write, beside the append path's `addToOnHand`
 * in this same file. Callers hold the per-warehouse advisory lock (so no
 * concurrent increment is clobbered) and own the divergence alert that
 * travels with the rebuild. A requested scope with NO ledger events at all
 * has a fabricated row at best: the repair deletes it — the ledger is the
 * only stock truth. A scope that already matches is left untouched.
 */
export async function rebuildProjectionsInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  scopes: readonly { skuId: string; binId: string }[],
): Promise<readonly RebuiltScope[]> {
  // Quantities are absolute: fold the whole ledger once (fresh reads — the
  // caller's repair transaction is read-committed, so anything that committed
  // between detection and this lock is included rather than clobbered).
  const { replayed, batchReplayed } = await foldLedgerInTx(tx, tenantId, warehouseId, {});

  const repaired: RebuiltScope[] = [];
  for (const scope of scopes) {
    const key = replayKey(scope.skuId, scope.binId);
    const existingRows = await tx
      .select({ quantity: stockOnHand.quantity })
      .from(stockOnHand)
      .where(
        and(
          eq(stockOnHand.tenantId, tenantId),
          eq(stockOnHand.warehouseId, warehouseId),
          eq(stockOnHand.skuId, scope.skuId),
          eq(stockOnHand.binId, scope.binId),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!replayed.has(key)) {
      // No events support this scope at all: any row here is fabricated.
      if (existing !== undefined) {
        await tx
          .delete(stockOnHand)
          .where(
            and(
              eq(stockOnHand.tenantId, tenantId),
              eq(stockOnHand.warehouseId, warehouseId),
              eq(stockOnHand.skuId, scope.skuId),
              eq(stockOnHand.binId, scope.binId),
            ),
          );
        repaired.push({
          skuId: scope.skuId,
          binId: scope.binId,
          projectedQuantity: existing.quantity,
          quantity: 0,
          deleted: true,
        });
      }
      // The batch arm of a scope with no events is empty by the same proof
      // (batch buckets are a subset of the scope's events) — the shared
      // batch re-fold below deletes any fabricated batch rows.
      await rebuildBatchArmInTx(tx, tenantId, warehouseId, scope, batchReplayed, repaired);
      continue;
    }
    const quantity = replayed.get(key)!;
    if (existing !== undefined && existing.quantity === quantity) {
      // The plain quantity already matches (e.g. fixed between detection and
      // repair), but the batch arm of the SAME scope may still diverge — the
      // re-fold below is unconditional and idempotent from the ledger.
      await rebuildBatchArmInTx(tx, tenantId, warehouseId, scope, batchReplayed, repaired);
      continue; // already matches (e.g. fixed between detection and repair)
    }
    await tx
      .insert(stockOnHand)
      .values({
        id: uuidv7(),
        tenantId,
        warehouseId,
        skuId: scope.skuId,
        binId: scope.binId,
        quantity,
      })
      .onConflictDoUpdate({
        target: [stockOnHand.tenantId, stockOnHand.warehouseId, stockOnHand.skuId, stockOnHand.binId],
        set: { quantity, updatedAt: nowIso() },
      });
    repaired.push({
      skuId: scope.skuId,
      binId: scope.binId,
      projectedQuantity: existing?.quantity ?? null,
      quantity,
      deleted: false,
    });
    await rebuildBatchArmInTx(tx, tenantId, warehouseId, scope, batchReplayed, repaired);
  }
  return repaired;
}

/**
 * The batch-arm re-fold (Story 2.4): rewrites every `batch_on_hand` row of
 * one (sku, bin) scope to the replayed per-(sku, bin, batch) buckets —
 * `batch_on_hand` re-derives exactly from the ledger, the same absolute
 * recompute the plain quantity gets. Rows with no supporting event are
 * fabricated (deleted); a row that already matches is left untouched.
 * Mutates `repaired` (the caller's report) with one entry per rewritten row.
 */
async function rebuildBatchArmInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  scope: { skuId: string; binId: string },
  batchReplayed: Map<string, number>,
  repaired: RebuiltScope[],
): Promise<void> {
  const prefix = `${scope.skuId}:${scope.binId}:`;
  const scopeBuckets = new Map<string, number>();
  for (const [key, quantity] of batchReplayed) {
    if (key.startsWith(prefix)) {
      scopeBuckets.set(key.slice(prefix.length), quantity);
    }
  }

  const existingRows = await tx
    .select({ id: batchOnHand.id, batchId: batchOnHand.batchId, quantity: batchOnHand.quantity })
    .from(batchOnHand)
    .where(
      and(
        eq(batchOnHand.tenantId, tenantId),
        eq(batchOnHand.warehouseId, warehouseId),
        eq(batchOnHand.skuId, scope.skuId),
        eq(batchOnHand.binId, scope.binId),
      ),
    );
  for (const row of existingRows) {
    const quantity = scopeBuckets.get(row.batchId);
    if (quantity === undefined) {
      // No events support this batch scope: the row is fabricated.
      await tx.delete(batchOnHand).where(eq(batchOnHand.id, row.id));
      repaired.push({
        skuId: scope.skuId,
        binId: scope.binId,
        batchRef: row.batchId,
        projectedQuantity: row.quantity,
        quantity: 0,
        deleted: true,
      });
      continue;
    }
    scopeBuckets.delete(row.batchId);
    if (row.quantity === quantity) {
      continue; // already matches
    }
    await tx
      .update(batchOnHand)
      .set({ quantity, updatedAt: nowIso() })
      .where(eq(batchOnHand.id, row.id));
    repaired.push({
      skuId: scope.skuId,
      binId: scope.binId,
      batchRef: row.batchId,
      projectedQuantity: row.quantity,
      quantity,
      deleted: false,
    });
  }
  for (const [batchId, quantity] of scopeBuckets) {
    await tx.insert(batchOnHand).values({
      id: uuidv7(),
      tenantId,
      warehouseId,
      skuId: scope.skuId,
      binId: scope.binId,
      batchId,
      quantity,
    });
    repaired.push({
      skuId: scope.skuId,
      binId: scope.binId,
      batchRef: batchId,
      projectedQuantity: null,
      quantity,
      deleted: false,
    });
  }
}

/**
 * Chain walk inside an existing transaction: recomputes each event's hash
 * over its canonical bytes and checks the predecessor linkage in seq
 * order. A mid-chain start verifies against the actual predecessor row, so
 * a deleted/inserted row inside the range is caught by the linkage check.
 */
export async function verifyChainInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  fromSeq = 1,
  toSeq?: number,
): Promise<ChainVerifyReport | ChainBreakReport> {
  const rangeConditions: SQL[] = [
    eq(ledgerEvents.tenantId, tenantId),
    eq(ledgerEvents.warehouseId, warehouseId),
    gte(ledgerEvents.seq, fromSeq),
  ];
  if (toSeq !== undefined) {
    rangeConditions.push(lte(ledgerEvents.seq, toSeq));
  }
  const rows = await tx
    .select()
    .from(ledgerEvents)
    .where(and(...rangeConditions))
    .orderBy(asc(ledgerEvents.seq));

  // An out-of-band deletion (the replication-role bypass the append-only
  // trigger does not cover) shows up as a short range, not a hash break —
  // report it naming the gap instead of walking a silently short chain.
  if (toSeq !== undefined && rows.length !== toSeq - fromSeq + 1) {
    return {
      ok: false,
      tenantId,
      warehouseId,
      fromSeq,
      toSeq,
      reason: `missing events in seq range ${fromSeq}..${toSeq}: found ${rows.length} of ${toSeq - fromSeq + 1}`,
    };
  }
  const lastSeq = rows[rows.length - 1]?.seq ?? fromSeq - 1;

  let expectedPrev: string | undefined;
  if (fromSeq === 1) {
    expectedPrev = GENESIS_PREV_HASH;
  } else {
    const prevRows = await tx
      .select({ eventHash: ledgerEvents.eventHash })
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.tenantId, tenantId),
          eq(ledgerEvents.warehouseId, warehouseId),
          eq(ledgerEvents.seq, fromSeq - 1),
        ),
      )
      .limit(1);
    expectedPrev = prevRows[0]?.eventHash;
    if (expectedPrev === undefined) {
      return {
        ok: false,
        tenantId,
        warehouseId,
        fromSeq,
        toSeq: toSeq ?? fromSeq,
        reason: `predecessor event at seq ${fromSeq - 1} is missing`,
      };
    }
  }

  for (const row of rows) {
    let recomputed: string;
    try {
      recomputed = sha256Hex(
        canonicalEventBytes({
        id: row.id,
        tenantId: row.tenantId,
        warehouseId: row.warehouseId,
        seq: row.seq,
        type: row.type,
        schemaVersion: row.schemaVersion,
        skuId: row.skuId,
        quantityDelta: row.quantityDelta,
        fromBinId: row.fromBinId,
        toBinId: row.toBinId,
        batchRef: row.batchRef,
        serialRef: row.serialRef,
        actorUserId: row.actorUserId,
        occurredAt: row.occurredAt,
        recordedAt: row.recordedAt,
        referenceDoc: row.referenceDoc as LedgerReferenceDoc,
        prevHash: row.prevHash,
      }),
      );
    } catch {
      return {
        ok: false,
        tenantId,
        warehouseId,
        fromSeq: row.seq,
        toSeq: lastSeq,
        reason: `unparseable timestamp at seq ${row.seq}: occurred_at/recorded_at no longer parse as instants`,
      };
    }
    if (row.prevHash !== expectedPrev) {
      return {
        ok: false,
        tenantId,
        warehouseId,
        fromSeq: row.seq,
        toSeq: lastSeq,
        reason: `chain break at seq ${row.seq}: stored prev_hash does not match the predecessor's event_hash`,
      };
    }
    if (row.eventHash !== recomputed) {
      return {
        ok: false,
        tenantId,
        warehouseId,
        fromSeq: row.seq,
        toSeq: lastSeq,
        reason: `hash mismatch at seq ${row.seq}: the event's canonical bytes no longer hash to its stored event_hash`,
      };
    }
    expectedPrev = row.eventHash;
  }

  return {
    ok: true,
    tenantId,
    warehouseId,
    fromSeq,
    toSeq: rows[rows.length - 1]?.seq ?? fromSeq - 1,
    eventCount: rows.length,
  };
}
