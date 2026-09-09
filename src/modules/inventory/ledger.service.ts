import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { ledgerEvents, stockOnHand } from '../../shared/db/schema';
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
  /** Reserved for Story 2.4 — the registry rejects non-null values today. */
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
    // is transaction-scoped — it dies with the commit/rollback.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${movement.tenantId} || ':' || ${movement.warehouseId}, 0))`,
    );

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

    // Derived projection, same transaction: the to-bin RECEIVES the
    // movement's magnitude, the from-bin RELEASES it (a later two-arm
    // transfer event carries the magnitude on both arms). An over-draw is
    // rejected naming the bin and its current on-hand — the whole
    // transaction rolls back with it.
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
        quantity: delta,
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
   */
  async anchorChain(
    tenantId: string,
    warehouseId: string,
    uptoSeq?: number,
  ): Promise<ChainAnchor> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // One anchor committer per warehouse scope: two concurrent anchor
      // calls would otherwise read the same lastToSeq and commit
      // overlapping anchor rows. Same mechanism as the seq allocation.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':' || ${warehouseId}, 0))`,
      );
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
      const digest = digestOverRange(rangeRows);
      const anchoredAt = nowIso();
      await this.anchorStore.anchor({ tenantId, warehouseId, fromSeq, toSeq, digest, anchoredAt }, tx);
      return { tenantId, warehouseId, fromSeq, toSeq, digest, anchoredAt };
    });
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
  const conditions: SQL[] = [
    eq(ledgerEvents.tenantId, tenantId),
    eq(ledgerEvents.warehouseId, warehouseId),
  ];
  if (skuId !== undefined) {
    conditions.push(eq(ledgerEvents.skuId, skuId));
  }
  if (binId !== undefined) {
    // Same scope as the projected side: without this, sibling bins of the
    // SKU (excluded from the projection comparison) surface as phantom
    // divergences.
    conditions.push(or(eq(ledgerEvents.toBinId, binId), eq(ledgerEvents.fromBinId, binId))!);
  }
  const rows = await tx
    .select({
      seq: ledgerEvents.seq,
      skuId: ledgerEvents.skuId,
      quantityDelta: ledgerEvents.quantityDelta,
      fromBinId: ledgerEvents.fromBinId,
      toBinId: ledgerEvents.toBinId,
    })
    .from(ledgerEvents)
    .where(and(...conditions))
    .orderBy(asc(ledgerEvents.seq));

  const replayed = new Map<string, number>();
  for (const row of rows) {
    const magnitude = Math.abs(row.quantityDelta);
    if (row.toBinId !== null) {
      const key = replayKey(row.skuId, row.toBinId);
      replayed.set(key, (replayed.get(key) ?? 0) + magnitude);
    }
    if (row.fromBinId !== null) {
      const key = replayKey(row.skuId, row.fromBinId);
      replayed.set(key, (replayed.get(key) ?? 0) - magnitude);
    }
  }

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

  return { warehouseId, eventCount: rows.length, matches: divergences.length === 0, divergences };
}

function replayKey(skuId: string, binId: string): string {
  return `${skuId}:${binId}`;
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