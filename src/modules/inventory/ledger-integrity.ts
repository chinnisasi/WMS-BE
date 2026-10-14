import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  ledgerAnchors,
  ledgerAnchorWormCopies,
  ledgerChainBreaks,
  ledgerEvents,
  ledgerIntegrityState,
  warehouses,
} from '../../shared/db/schema';
import type {
  LedgerAnchor,
  LedgerAnchorKind,
  LedgerAnchorWormCopy,
  LedgerChainBreak,
  LedgerChainBreakDetector,
  LedgerChainBreakKind,
} from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { LEDGER_ANCHOR_STORE } from './anchor-store';
import type { LedgerAnchorStore } from './anchor-store';
import {
  GENESIS_PREV_HASH,
  LedgerService,
  breakInputOf,
  canonicalEventOf,
  digestOverRange,
  gapReport,
  legacyEventHashOf,
  walkChain,
  warehouseAdvisoryLock,
} from './ledger.service';
import type { ChainBreakReport } from './ledger.service';
import { LEDGER_ANCHOR_WORM_STORE } from './ledger-anchor-worm';
import { s3ErrorCode } from './ledger-anchor-worm';
import type { LedgerAnchorWormMode, LedgerAnchorWormStore, WormAnchor } from './ledger-anchor-worm';

/**
 * Story 9-3c — the scheduled ledger integrity check (AD-16): per warehouse,
 * baseline the pre-0026 prefix once, anchor the tail in bounded chunks,
 * re-verify one anchored range per run in rotation, and copy anchors to
 * WORM storage. Driven by the jobs shell's `LedgerIntegrityWorker` through
 * `InventoryFacade.runLedgerIntegrity`; the reads behind the web's "Ledger
 * integrity" section live here too. Every write is inventory's
 * (`test/architecture.spec.ts`).
 */

/** Default anchor chunk: one anchor covers at most this many events (bounds the lock hold, the verify and a proof file). */
export const DEFAULT_LEDGER_ANCHOR_MAX_RANGE = 10_000;
/** Default anchor chunks per run: the tail advances at most `MAX_RANGE × CHUNKS` events per tick. */
export const DEFAULT_LEDGER_ANCHOR_CHUNKS_PER_TICK = 10;
/** WORM copies per warehouse per run. */
export const MAX_WORM_COPIES_PER_RUN = 20;
/** The baseline scan's chunk (rows read per query, outside the lock). */
export const BASELINE_SCAN_CHUNK = 1_000;
/** The integrity read lists at most this many breaks per warehouse (open and acknowledged, newest first). */
export const MAX_BREAKS_PER_WAREHOUSE = 10;
export const DEFAULT_ANCHOR_PAGE_SIZE = 50;
export const MAX_ANCHOR_PAGE_SIZE = 200;

/** A positive-integer env knob; unset → the default; anything else fails the boot. */
export function parsePositiveIntEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return parsed;
}

/** The proof file's statement of the digest algorithm (the `digestOverRange` contract). */
export const LEDGER_PROOF_ALGORITHM =
  "sha256 over the '\\n'-joined 'seq:eventHash' lines, seq ascending, no trailing newline; hex-encoded lowercase";

/** The proof file's statement of the pre-0026 form, for a `legacy` anchor. */
export const LEDGER_PROOF_LEGACY_FORM =
  'This range was verified in the pre-0026 form: migration 0026 multiplied each older event\'s quantity_delta by 1000 ' +
  '(base units to milli-units) without rehashing, so each event_hash here reproduces when the event is hashed with ' +
  'quantity_delta / 1000. The digest itself is over the stored event hashes and recomputes exactly as for any anchor.';

// ── the shapes the reads serve ───────────────────────────────────────────────

export interface LedgerAnchorWormView {
  readonly bucket: string;
  readonly objectKey: string;
  readonly versionId: string;
  readonly retainUntil: string;
  readonly copiedAt: string;
}

export interface LedgerAnchorView {
  readonly id: string;
  readonly kind: LedgerAnchorKind;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly digest: string;
  readonly anchoredAt: string;
  readonly worm: LedgerAnchorWormView | null;
}

export interface ChainBreakView {
  readonly id: string;
  readonly kind: LedgerChainBreakKind;
  readonly firstSeq: number;
  readonly anchorId: string | null;
  readonly reason: string;
  readonly detectedBy: LedgerChainBreakDetector;
  readonly detectedAt: string;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: string | null;
}

export interface WarehouseIntegrityView {
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly baselined: boolean;
  readonly legacyThroughSeq: number;
  readonly verifiedThroughSeq: number | null;
  readonly verifiedAt: string | null;
  readonly lastRunAt: string | null;
  readonly brokenAtSeq: number | null;
  readonly brokenDetectedAt: string | null;
  readonly lastAnchor: LedgerAnchorView | null;
  /** Anchors with no WORM copy row yet. */
  readonly wormPending: number;
  readonly breaks: readonly ChainBreakView[];
  /** Every unacknowledged break of the warehouse — not only the listed newest 10. */
  readonly openBreakCount: number;
}

export interface LedgerIntegrityView {
  readonly wormStore: LedgerAnchorWormMode;
  readonly warehouses: readonly WarehouseIntegrityView[];
}

export interface LedgerAnchorPage {
  readonly items: readonly LedgerAnchorView[];
  readonly nextCursor: string | null;
}

export interface LedgerProof {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly anchor: LedgerAnchorView;
  readonly algorithm: string;
  /** Set for a `legacy` anchor only (the ÷1000 rule); null otherwise. */
  readonly legacyForm: string | null;
  /** `seq:eventHash`, seq ascending — exactly the digest's input lines. */
  readonly lines: readonly string[];
  readonly recomputedDigest: string;
  readonly matches: boolean;
}

/** What one run did (logged by the worker; read by the suites). */
export interface LedgerIntegrityRunSummary {
  readonly tenantId: string;
  readonly warehouseId: string;
  /** True when THIS run wrote the state row. */
  readonly baselined: boolean;
  readonly legacyThroughSeq: number | null;
  readonly anchored: number;
  /** The tail break recorded (or re-detected) by this run's anchoring, if any. */
  readonly anchorBreakId: string | null;
  /** The anchor this run re-verified, if any. */
  readonly reverifiedAnchorId: string | null;
  readonly reverifyBreakIds: readonly string[];
  readonly wormCopied: number;
  readonly wormFailed: number;
  /** Steps that threw (logged; each retried next tick). */
  readonly failedSteps: readonly ('baseline' | 'anchor' | 'reverify' | 'worm-copy')[];
}

export function toAnchorView(anchor: LedgerAnchor, copy: LedgerAnchorWormCopy | null): LedgerAnchorView {
  return {
    id: anchor.id,
    kind: anchor.kind as LedgerAnchorKind,
    fromSeq: anchor.fromSeq,
    toSeq: anchor.toSeq,
    digest: anchor.digest,
    anchoredAt: canonicalInstant(anchor.anchoredAt),
    worm:
      copy === null
        ? null
        : {
            bucket: copy.bucket,
            objectKey: copy.objectKey,
            versionId: copy.versionId,
            retainUntil: canonicalInstant(copy.retainUntil),
            copiedAt: canonicalInstant(copy.copiedAt),
          },
  };
}

export function toBreakView(row: LedgerChainBreak): ChainBreakView {
  return {
    id: row.id,
    kind: row.kind as LedgerChainBreakKind,
    firstSeq: row.firstSeq,
    anchorId: row.anchorId,
    reason: row.reason,
    detectedBy: row.detectedBy as LedgerChainBreakDetector,
    detectedAt: canonicalInstant(row.detectedAt),
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: row.acknowledgedAt === null ? null : canonicalInstant(row.acknowledgedAt),
  };
}

function anchorNotFound(): ProblemException {
  return new ProblemException(
    'anchor-not-found',
    404,
    'Anchor not found',
    'No ledger anchor with this id exists in this warehouse.',
  );
}

function invalidCursor(): ProblemException {
  return new ProblemException(
    'invalid-cursor',
    400,
    'Malformed pagination cursor',
    'The cursor parameter is not a valid opaque page cursor.',
  );
}

/** The anchors list's cursor: the last row's `to_seq`, opaque. */
export function encodeAnchorCursor(toSeq: number): string {
  return Buffer.from(JSON.stringify({ toSeq }), 'utf8').toString('base64url');
}

export function decodeAnchorCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const toSeq = (parsed as { toSeq?: unknown } | null)?.toSeq;
    if (typeof toSeq !== 'number' || !Number.isInteger(toSeq) || toSeq < 1 || toSeq > 2_147_483_647) {
      throw new Error('malformed');
    }
    return toSeq;
  } catch {
    throw invalidCursor();
  }
}

@Injectable()
export class LedgerIntegrityService {
  private readonly logger = new Logger('LedgerIntegrity');

  /** `LEDGER_ANCHOR_MAX_RANGE` — a plain field so a suite can shrink it (the `auditRead` precedent). */
  maxRange: number;
  /** `LEDGER_ANCHOR_CHUNKS_PER_TICK` — a plain field so a suite can shrink it. */
  chunksPerTick: number;
  /** The baseline scan's chunk — a plain field so a suite can shrink it. */
  baselineScanChunk: number = BASELINE_SCAN_CHUNK;
  /**
   * The WORM port — a plain field so a suite can drive the `s3` arms
   * through a fake store (no second production code path; the
   * `ReportingFacade.auditRead` precedent).
   */
  wormStore: LedgerAnchorWormStore;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(LEDGER_ANCHOR_STORE) private readonly anchorStore: LedgerAnchorStore,
    @Inject(LEDGER_ANCHOR_WORM_STORE) wormStore: LedgerAnchorWormStore,
  ) {
    this.wormStore = wormStore;
    this.maxRange = parsePositiveIntEnv('LEDGER_ANCHOR_MAX_RANGE', process.env.LEDGER_ANCHOR_MAX_RANGE, DEFAULT_LEDGER_ANCHOR_MAX_RANGE);
    this.chunksPerTick = parsePositiveIntEnv(
      'LEDGER_ANCHOR_CHUNKS_PER_TICK',
      process.env.LEDGER_ANCHOR_CHUNKS_PER_TICK,
      DEFAULT_LEDGER_ANCHOR_CHUNKS_PER_TICK,
    );
  }

  // ── the worker's per-warehouse run ─────────────────────────────────────────

  /**
   * One integrity run over one warehouse. Step 1 (the baseline, once) gates
   * the rest — without B a pre-0026 event would read as a break. Steps 2–4
   * then run INDEPENDENTLY, each in its own try/catch: a tail break stops
   * step 2 only; re-verify and the WORM copy still run, so an anchored range
   * keeps being re-proved and copied while the tail is broken.
   */
  async run(tenantId: string, warehouseId: string): Promise<LedgerIntegrityRunSummary> {
    const failedSteps: LedgerIntegrityRunSummary['failedSteps'][number][] = [];
    let baseline: { created: boolean; legacyThroughSeq: number };
    try {
      baseline = await this.ensureBaseline(tenantId, warehouseId);
    } catch (err) {
      this.logger.error(`baseline failed (tenant ${tenantId}, warehouse ${warehouseId}) — retried next tick: ${messageOf(err)}`);
      return {
        tenantId,
        warehouseId,
        baselined: false,
        legacyThroughSeq: null,
        anchored: 0,
        anchorBreakId: null,
        reverifiedAnchorId: null,
        reverifyBreakIds: [],
        wormCopied: 0,
        wormFailed: 0,
        failedSteps: ['baseline'],
      };
    }

    let anchored = 0;
    let anchorBreakId: string | null = null;
    try {
      ({ anchored, anchorBreakId } = await this.anchorTail(tenantId, warehouseId));
    } catch (err) {
      failedSteps.push('anchor');
      this.logger.error(`anchoring failed (tenant ${tenantId}, warehouse ${warehouseId}) — retried next tick: ${messageOf(err)}`);
    }

    let reverifiedAnchorId: string | null = null;
    let reverifyBreakIds: string[] = [];
    try {
      ({ reverifiedAnchorId, reverifyBreakIds } = await this.reverifyNext(tenantId, warehouseId));
    } catch (err) {
      failedSteps.push('reverify');
      this.logger.error(`re-verify failed (tenant ${tenantId}, warehouse ${warehouseId}) — retried next tick: ${messageOf(err)}`);
    }

    let wormCopied = 0;
    let wormFailed = 0;
    if (this.wormStore.mode === 's3') {
      try {
        ({ wormCopied, wormFailed } = await this.copyToWorm(tenantId, warehouseId));
      } catch (err) {
        failedSteps.push('worm-copy');
        this.logger.error(`WORM copy failed (tenant ${tenantId}, warehouse ${warehouseId}) — retried next tick: ${messageOf(err)}`);
      }
    }

    return {
      tenantId,
      warehouseId,
      baselined: baseline.created,
      legacyThroughSeq: baseline.legacyThroughSeq,
      anchored,
      anchorBreakId,
      reverifiedAnchorId,
      reverifyBreakIds,
      wormCopied,
      wormFailed,
      failedSteps,
    };
  }

  /**
   * Step 1 — the baseline (human decision 1). Once per warehouse, when no
   * state row exists:
   *
   *  1. a chunked scan (BASELINE_SCAN_CHUNK rows per read, OUTSIDE the lock —
   *     events at or below any seq it reads are immutable, so the answer
   *     cannot change under it) finds B: the largest s such that every event
   *     of [1..s] reproduces its stored hash in the pre-0026 form and links
   *     to its predecessor. It stops at the first event that does not. A run
   *     of zero-delta events at the END of that prefix is trimmed off B
   *     (they hash identically in both forms, so "pre-0026" would only
   *     overstate the count — they verify in the current form just the same);
   *  2. under `warehouseAdvisoryLock`, in one transaction: re-check that no
   *     state row exists (a concurrent baseline lost the race → done); take
   *     `latest()` (an anchor from before this story is possible on a dev
   *     database); when B ≥ 1 and NO anchor exists, commit `legacy` anchors
   *     over [1..B] in chunks of `maxRange` (each digest over the stored
   *     hashes); insert the state row `ON CONFLICT DO NOTHING`, seeding
   *     `broken_at_seq` from any break above B recorded before the
   *     warehouse was baselined (a manual `verifyChain`; one at or below B
   *     read a pre-0026 event in the current form and is not seeded). Existing anchors are kept and
   *     re-verify with this B.
   *
   * An empty warehouse gets a state row with B = 0.
   */
  async ensureBaseline(tenantId: string, warehouseId: string): Promise<{ created: boolean; legacyThroughSeq: number }> {
    const existing = await withTenantTransaction(this.db, tenantId, (tx) => this.stateRowInTx(tx, tenantId, warehouseId));
    if (existing !== null) {
      return { created: false, legacyThroughSeq: existing.legacyThroughSeq };
    }
    const boundary = await this.scanLegacyPrefix(tenantId, warehouseId);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await tx.execute(warehouseAdvisoryLock(tenantId, warehouseId));
      const raced = await this.stateRowInTx(tx, tenantId, warehouseId);
      if (raced !== null) {
        return { created: false, legacyThroughSeq: raced.legacyThroughSeq };
      }
      const latest = await this.anchorStore.latest({ tenantId, warehouseId }, tx);
      if (boundary >= 1 && latest === null) {
        for (let fromSeq = 1; fromSeq <= boundary; fromSeq += this.maxRange) {
          const toSeq = Math.min(fromSeq + this.maxRange - 1, boundary);
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
          if (rows.length !== toSeq - fromSeq + 1) {
            // The scan proved [1..B] contiguous and events are immutable; a
            // short read here is an out-of-band deletion mid-baseline.
            throw new Error(`baseline: seq ${fromSeq}..${toSeq} is no longer contiguous`);
          }
          await this.anchorStore.anchor(
            { tenantId, warehouseId, fromSeq, toSeq, digest: digestOverRange(rows), anchoredAt: nowIso(), kind: 'legacy' },
            tx,
          );
        }
      }
      const priorBreak = await tx
        .select({ firstSeq: ledgerChainBreaks.firstSeq, detectedAt: ledgerChainBreaks.detectedAt })
        .from(ledgerChainBreaks)
        .where(
          and(
            eq(ledgerChainBreaks.tenantId, tenantId),
            eq(ledgerChainBreaks.warehouseId, warehouseId),
            // A break at or below B was a pre-baseline verify reading a
            // pre-0026 event in the current form — not a break in B's light.
            gt(ledgerChainBreaks.firstSeq, boundary),
          ),
        )
        .orderBy(asc(ledgerChainBreaks.firstSeq), asc(ledgerChainBreaks.detectedAt))
        .limit(1);
      const now = nowIso();
      await tx
        .insert(ledgerIntegrityState)
        .values({
          tenantId,
          warehouseId,
          legacyThroughSeq: boundary,
          baselinedAt: now,
          brokenAtSeq: priorBreak[0]?.firstSeq ?? null,
          brokenDetectedAt: priorBreak[0]?.detectedAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [ledgerIntegrityState.tenantId, ledgerIntegrityState.warehouseId] });
      this.logger.log(
        `baselined tenant ${tenantId} warehouse ${warehouseId}: ${boundary} event(s) verified in the pre-0026 form` +
          (boundary >= 1 && latest !== null ? ` (existing anchors kept — they re-verify with B = ${boundary})` : ''),
      );
      return { created: true, legacyThroughSeq: boundary };
    });
  }

  /** The baseline scan (outside the lock): the pre-0026 prefix boundary B. */
  private async scanLegacyPrefix(tenantId: string, warehouseId: string): Promise<number> {
    let expectedSeq = 1;
    let expectedPrev = GENESIS_PREV_HASH;
    let lastNonZero = 0;
    for (;;) {
      const rows = await withTenantTransaction(this.db, tenantId, (tx) =>
        tx
          .select()
          .from(ledgerEvents)
          .where(
            and(
              eq(ledgerEvents.tenantId, tenantId),
              eq(ledgerEvents.warehouseId, warehouseId),
              gte(ledgerEvents.seq, expectedSeq),
              lt(ledgerEvents.seq, expectedSeq + this.baselineScanChunk),
            ),
          )
          .orderBy(asc(ledgerEvents.seq)),
      );
      for (const row of rows) {
        if (row.seq !== expectedSeq || row.prevHash !== expectedPrev) {
          return lastNonZero;
        }
        let legacy: string | null;
        try {
          legacy = legacyEventHashOf(canonicalEventOf(row));
        } catch {
          return lastNonZero; // an unparseable timestamp ends the prefix
        }
        if (legacy !== row.eventHash) {
          return lastNonZero;
        }
        if (row.quantityDelta !== 0) {
          lastNonZero = row.seq;
        }
        expectedPrev = row.eventHash;
        expectedSeq += 1;
      }
      if (rows.length < this.baselineScanChunk) {
        return lastNonZero;
      }
    }
  }

  /**
   * Step 2 — anchor the tail, bounded: up to `chunksPerTick` calls of
   * `anchorChain(…, latest.toSeq + maxRange)`. A typed no-op ends the step
   * as a success; a break (recorded by `anchorChain` itself, `detectedBy:
   * 'anchor'`, a gap included) ends it WITHOUT touching `verified_*`.
   * Success stamps `verified_through_seq` (the latest anchor's `to_seq`, 0
   * for an empty warehouse), `verified_at` and `last_run_at` — never
   * `broken_*`.
   */
  private async anchorTail(tenantId: string, warehouseId: string): Promise<{ anchored: number; anchorBreakId: string | null }> {
    let anchored = 0;
    for (let chunk = 0; chunk < this.chunksPerTick; chunk += 1) {
      const latestToSeq = await withTenantTransaction(this.db, tenantId, async (tx) =>
        (await this.anchorStore.latest({ tenantId, warehouseId }, tx))?.toSeq ?? 0,
      );
      const result = await this.ledger.anchorChain(tenantId, warehouseId, latestToSeq + this.maxRange);
      if ('nothing' in result) {
        break;
      }
      if ('reason' in result) {
        const breakId = await this.breakIdOf(tenantId, warehouseId, 'chain', breakInputOf(result, 'anchor').firstSeq);
        await this.stampRun(tenantId, warehouseId, false);
        return { anchored, anchorBreakId: breakId };
      }
      anchored += 1;
    }
    await this.stampRun(tenantId, warehouseId, true);
    return { anchored, anchorBreakId: null };
  }

  /** `last_run_at` always; `verified_*` only on a clean anchoring step. */
  private async stampRun(tenantId: string, warehouseId: string, verified: boolean): Promise<void> {
    await withTenantTransaction(this.db, tenantId, async (tx) => {
      const now = nowIso();
      const latest = verified ? await this.anchorStore.latest({ tenantId, warehouseId }, tx) : null;
      await tx
        .update(ledgerIntegrityState)
        .set({
          ...(verified ? { verifiedThroughSeq: latest?.toSeq ?? 0, verifiedAt: now } : {}),
          lastRunAt: now,
          updatedAt: now,
        })
        .where(and(eq(ledgerIntegrityState.tenantId, tenantId), eq(ledgerIntegrityState.warehouseId, warehouseId)));
    });
  }

  private async breakIdOf(tenantId: string, warehouseId: string, kind: LedgerChainBreakKind, firstSeq: number): Promise<string | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ id: ledgerChainBreaks.id })
        .from(ledgerChainBreaks)
        .where(
          and(
            eq(ledgerChainBreaks.tenantId, tenantId),
            eq(ledgerChainBreaks.warehouseId, warehouseId),
            eq(ledgerChainBreaks.kind, kind),
            eq(ledgerChainBreaks.firstSeq, firstSeq),
          ),
        )
        .limit(1);
      return rows[0]?.id ?? null;
    });
  }

  /**
   * Step 3 — re-verify ONE anchored range, in rotation: the next anchor with
   * `to_seq > reverify_after_seq` (wrapping to the first), recomputed with
   * the warehouse's B and required to reproduce the anchor's digest (a
   * `chain` break, `detectedBy: 'reverify'`). With `s3` and the anchor
   * copied, the WORM object is read back and its digest compared: `missing`
   * or a different digest/range is a `worm` break (`first_seq` = the
   * anchor's `from_seq`; the id, kind and anchoredAt are compared too); a
   * transport error is logged and never a break — the cursor still
   * advances, and that read-back retries when the rotation comes back round.
   */
  private async reverifyNext(tenantId: string, warehouseId: string): Promise<{ reverifiedAnchorId: string | null; reverifyBreakIds: string[] }> {
    const picked = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const state = await this.stateRowInTx(tx, tenantId, warehouseId);
      if (state === null) return null;
      const scope = and(eq(ledgerAnchors.tenantId, tenantId), eq(ledgerAnchors.warehouseId, warehouseId));
      const next =
        (
          await tx
            .select()
            .from(ledgerAnchors)
            .where(and(scope, gt(ledgerAnchors.toSeq, state.reverifyAfterSeq)))
            .orderBy(asc(ledgerAnchors.toSeq))
            .limit(1)
        )[0] ??
        (await tx.select().from(ledgerAnchors).where(scope).orderBy(asc(ledgerAnchors.toSeq)).limit(1))[0];
      if (next === undefined) return null;
      const rows = await tx
        .select()
        .from(ledgerEvents)
        .where(
          and(
            eq(ledgerEvents.tenantId, tenantId),
            eq(ledgerEvents.warehouseId, warehouseId),
            gte(ledgerEvents.seq, next.fromSeq),
            lte(ledgerEvents.seq, next.toSeq),
          ),
        )
        .orderBy(asc(ledgerEvents.seq));
      let report: ChainBreakReport | null = gapReport(tenantId, warehouseId, next.fromSeq, next.toSeq, rows);
      if (report === null) {
        const walked = await walkChain(tx, tenantId, warehouseId, next.fromSeq, next.toSeq, rows, state.legacyThroughSeq);
        if (walked.ok === false) {
          report = walked;
        } else {
          const digest = digestOverRange(rows);
          if (digest !== next.digest) {
            report = {
              ok: false,
              tenantId,
              warehouseId,
              fromSeq: next.fromSeq,
              toSeq: next.toSeq,
              reason: `anchor digest mismatch over seq ${next.fromSeq}..${next.toSeq}: the stored event hashes no longer reproduce anchor ${next.id}`,
            };
          }
        }
      }
      const copy = (
        await tx.select().from(ledgerAnchorWormCopies).where(and(eq(ledgerAnchorWormCopies.tenantId, tenantId), eq(ledgerAnchorWormCopies.anchorId, next.id))).limit(1)
      )[0] ?? null;
      return { anchor: next, report, copy };
    });
    if (picked === null) {
      return { reverifiedAnchorId: null, reverifyBreakIds: [] };
    }
    const { anchor, report, copy } = picked;
    const breakIds: string[] = [];
    if (report !== null) {
      breakIds.push((await this.ledger.recordChainBreak(tenantId, breakInputOf(report, 'reverify'))).breakId);
    }
    if (this.wormStore.mode === 's3' && copy !== null) {
      try {
        const back = await this.wormStore.get({ bucket: copy.bucket, objectKey: copy.objectKey, versionId: copy.versionId });
        const reason =
          back === 'missing'
            ? `WORM copy missing: ${copy.bucket}/${copy.objectKey} version ${copy.versionId} no longer exists`
            : back.id !== anchor.id ||
                back.kind !== anchor.kind ||
                back.anchoredAt !== canonicalInstant(anchor.anchoredAt) ||
                back.digest !== anchor.digest ||
                back.fromSeq !== anchor.fromSeq ||
                back.toSeq !== anchor.toSeq
              ? `WORM copy mismatch: ${copy.bucket}/${copy.objectKey} version ${copy.versionId} no longer holds anchor ${anchor.id} (seq ${anchor.fromSeq}..${anchor.toSeq}, digest ${anchor.digest})`
              : null;
        if (reason !== null) {
          const recorded = await this.ledger.recordChainBreak(tenantId, {
            warehouseId,
            kind: 'worm',
            fromSeq: anchor.fromSeq,
            toSeq: anchor.toSeq,
            firstSeq: anchor.fromSeq,
            anchorId: anchor.id,
            reason,
            detectedBy: 'reverify',
          });
          breakIds.push(recorded.breakId);
        }
      } catch (err) {
        // Not a break, and never a pinned rotation: the cursor advances, and
        // this anchor's read-back retries when the rotation comes back round.
        this.logger.warn(
          `WORM read-back of anchor ${anchor.id} (tenant ${tenantId}, warehouse ${warehouseId}) failed [${s3ErrorCode(err)}] — not a break, retried on the next rotation: ${messageOf(err)}`,
        );
      }
    }
    await withTenantTransaction(this.db, tenantId, async (tx) => {
      await tx
        .update(ledgerIntegrityState)
        .set({ reverifyAfterSeq: anchor.toSeq, updatedAt: nowIso() })
        .where(and(eq(ledgerIntegrityState.tenantId, tenantId), eq(ledgerIntegrityState.warehouseId, warehouseId)));
    });
    return { reverifiedAnchorId: anchor.id, reverifyBreakIds: breakIds };
  }

  /**
   * Step 4 (`s3` only) — copy anchors to WORM: every anchor of this
   * warehouse with no copy row, oldest first, at most
   * `MAX_WORM_COPIES_PER_RUN`: `put`, then insert the copy row `ON CONFLICT
   * (anchor_id) DO NOTHING` (two racing instances: the first committed copy
   * row wins; the other S3 version stays orphaned and harmless). A put
   * failure (a bucket without Object Lock included) is logged with its error
   * code and retried next tick; the anchor stays in `wormPending`.
   */
  private async copyToWorm(tenantId: string, warehouseId: string): Promise<{ wormCopied: number; wormFailed: number }> {
    const pending = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select({ anchor: ledgerAnchors })
        .from(ledgerAnchors)
        .leftJoin(ledgerAnchorWormCopies, eq(ledgerAnchorWormCopies.anchorId, ledgerAnchors.id))
        .where(
          and(
            eq(ledgerAnchors.tenantId, tenantId),
            eq(ledgerAnchors.warehouseId, warehouseId),
            isNull(ledgerAnchorWormCopies.anchorId),
          ),
        )
        .orderBy(asc(ledgerAnchors.toSeq))
        .limit(MAX_WORM_COPIES_PER_RUN),
    );
    let wormCopied = 0;
    let wormFailed = 0;
    for (const { anchor } of pending) {
      const body: WormAnchor = {
        id: anchor.id,
        tenantId,
        warehouseId,
        kind: anchor.kind as LedgerAnchorKind,
        fromSeq: anchor.fromSeq,
        toSeq: anchor.toSeq,
        digest: anchor.digest,
        anchoredAt: canonicalInstant(anchor.anchoredAt),
      };
      try {
        const ref = await this.wormStore.put(body);
        await withTenantTransaction(this.db, tenantId, (tx) =>
          tx
            .insert(ledgerAnchorWormCopies)
            .values({
              anchorId: anchor.id,
              tenantId,
              bucket: ref.bucket,
              objectKey: ref.objectKey,
              versionId: ref.versionId,
              retainUntil: ref.retainUntil,
              copiedAt: nowIso(),
            })
            .onConflictDoNothing({ target: ledgerAnchorWormCopies.anchorId }),
        );
        wormCopied += 1;
      } catch (err) {
        // A put OR a copy-row failure: logged, counted, and the remaining
        // anchors still copy; this one retries next tick.
        wormFailed += 1;
        this.logger.error(
          `WORM copy of anchor ${anchor.id} (tenant ${tenantId}, warehouse ${warehouseId}) failed [${s3ErrorCode(err)}] — retried next tick: ${messageOf(err)}`,
        );
      }
    }
    return { wormCopied, wormFailed };
  }

  private async stateRowInTx(tx: TenantTx, tenantId: string, warehouseId: string) {
    const rows = await tx
      .select()
      .from(ledgerIntegrityState)
      .where(and(eq(ledgerIntegrityState.tenantId, tenantId), eq(ledgerIntegrityState.warehouseId, warehouseId)))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── the gated reads (audit.view) ───────────────────────────────────────────

  /** The `audit.view` gate, in its OWN transaction (the `ReportingFacade.auditTrail` gated-read shape). */
  private async assertAuditView(tenantId: string, actorUserId: string): Promise<void> {
    await withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, actorUserId), 'audit.view');
    });
  }

  /**
   * `GET …/inventory/ledger/integrity` — one row per warehouse of the
   * tenant. UNPAGED, a documented exception: bounded by the warehouse count
   * (and at most `MAX_BREAKS_PER_WAREHOUSE` breaks each).
   */
  async integrity(tenantId: string, actorUserId: string): Promise<LedgerIntegrityView> {
    await this.assertAuditView(tenantId, actorUserId);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const houses = await tx
        .select({ id: warehouses.id, code: warehouses.code, state: ledgerIntegrityState })
        .from(warehouses)
        .leftJoin(
          ledgerIntegrityState,
          and(eq(ledgerIntegrityState.tenantId, warehouses.tenantId), eq(ledgerIntegrityState.warehouseId, warehouses.id)),
        )
        .where(eq(warehouses.tenantId, tenantId))
        .orderBy(asc(warehouses.code), asc(warehouses.id));
      const lastAnchors = await tx
        .selectDistinctOn([ledgerAnchors.warehouseId], { anchor: ledgerAnchors, copy: ledgerAnchorWormCopies })
        .from(ledgerAnchors)
        .leftJoin(ledgerAnchorWormCopies, eq(ledgerAnchorWormCopies.anchorId, ledgerAnchors.id))
        .where(eq(ledgerAnchors.tenantId, tenantId))
        .orderBy(ledgerAnchors.warehouseId, desc(ledgerAnchors.toSeq));
      const pendingRows = await tx
        .select({ warehouseId: ledgerAnchors.warehouseId, pending: sql<number>`count(*)::int` })
        .from(ledgerAnchors)
        .leftJoin(ledgerAnchorWormCopies, eq(ledgerAnchorWormCopies.anchorId, ledgerAnchors.id))
        .where(and(eq(ledgerAnchors.tenantId, tenantId), isNull(ledgerAnchorWormCopies.anchorId)))
        .groupBy(ledgerAnchors.warehouseId);
      const openRows = await tx
        .select({ warehouseId: ledgerChainBreaks.warehouseId, open: sql<number>`count(*)::int` })
        .from(ledgerChainBreaks)
        .where(and(eq(ledgerChainBreaks.tenantId, tenantId), isNull(ledgerChainBreaks.acknowledgedAt)))
        .groupBy(ledgerChainBreaks.warehouseId);
      const openByHouse = new Map(openRows.map((row) => [row.warehouseId, Number(row.open)]));
      const breakRows = await tx.execute(sql`
        select id from (
          select id, row_number() over (partition by warehouse_id order by detected_at desc, id desc) as rn
          from ledger_chain_breaks where tenant_id = ${tenantId}::uuid
        ) ranked where rn <= ${MAX_BREAKS_PER_WAREHOUSE}::int
      `) as unknown as { id: string }[];
      const breakIds = breakRows.map((row) => row.id);
      const breaks =
        breakIds.length === 0
          ? []
          : await tx
              .select()
              .from(ledgerChainBreaks)
              .where(and(eq(ledgerChainBreaks.tenantId, tenantId), inArray(ledgerChainBreaks.id, breakIds)))
              .orderBy(desc(ledgerChainBreaks.detectedAt), desc(ledgerChainBreaks.id));
      const anchorByHouse = new Map(lastAnchors.map((row) => [row.anchor.warehouseId, toAnchorView(row.anchor, row.copy)]));
      const pendingByHouse = new Map(pendingRows.map((row) => [row.warehouseId, Number(row.pending)]));
      return {
        wormStore: this.wormStore.mode,
        warehouses: houses.map((house): WarehouseIntegrityView => ({
          warehouseId: house.id,
          warehouseCode: house.code,
          baselined: house.state !== null,
          legacyThroughSeq: house.state?.legacyThroughSeq ?? 0,
          verifiedThroughSeq: house.state?.verifiedThroughSeq ?? null,
          verifiedAt: house.state?.verifiedAt == null ? null : canonicalInstant(house.state.verifiedAt),
          lastRunAt: house.state?.lastRunAt == null ? null : canonicalInstant(house.state.lastRunAt),
          brokenAtSeq: house.state?.brokenAtSeq ?? null,
          brokenDetectedAt: house.state?.brokenDetectedAt == null ? null : canonicalInstant(house.state.brokenDetectedAt),
          lastAnchor: anchorByHouse.get(house.id) ?? null,
          wormPending: pendingByHouse.get(house.id) ?? 0,
          breaks: breaks.filter((row) => row.warehouseId === house.id).map(toBreakView),
          openBreakCount: openByHouse.get(house.id) ?? 0,
        })),
      };
    });
  }

  /** `GET …/warehouses/{w}/inventory/ledger/anchors` — `to_seq DESC`, keyset on `to_seq`. */
  async anchors(
    tenantId: string,
    actorUserId: string,
    warehouseId: string,
    query: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
  ): Promise<LedgerAnchorPage> {
    await this.assertAuditView(tenantId, actorUserId);
    const limit = query.limit ?? DEFAULT_ANCHOR_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeAnchorCursor(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const rows = await tx
        .select({ anchor: ledgerAnchors, copy: ledgerAnchorWormCopies })
        .from(ledgerAnchors)
        .leftJoin(ledgerAnchorWormCopies, eq(ledgerAnchorWormCopies.anchorId, ledgerAnchors.id))
        .where(
          and(
            eq(ledgerAnchors.tenantId, tenantId),
            eq(ledgerAnchors.warehouseId, warehouseId),
            before === undefined ? undefined : lt(ledgerAnchors.toSeq, before),
          ),
        )
        .orderBy(desc(ledgerAnchors.toSeq))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map((row) => toAnchorView(row.anchor, row.copy));
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last !== undefined ? encodeAnchorCursor(last.toSeq) : null };
    });
  }

  /**
   * `GET …/anchors/{anchorId}/proof` — the downloadable proof of one anchored
   * range: its `seq:eventHash` lines, the digest recomputed from them, the
   * anchor (with its WORM reference once copied) and how to recompute it.
   * Served from Postgres and the copy row only (no S3 read). Bounded by
   * `LEDGER_ANCHOR_MAX_RANGE` (anchors are chunked).
   */
  async proof(tenantId: string, actorUserId: string, warehouseId: string, anchorId: string): Promise<LedgerProof> {
    await this.assertAuditView(tenantId, actorUserId);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const found = (
        await tx
          .select({ anchor: ledgerAnchors, copy: ledgerAnchorWormCopies })
          .from(ledgerAnchors)
          .leftJoin(ledgerAnchorWormCopies, eq(ledgerAnchorWormCopies.anchorId, ledgerAnchors.id))
          .where(and(eq(ledgerAnchors.tenantId, tenantId), eq(ledgerAnchors.warehouseId, warehouseId), eq(ledgerAnchors.id, anchorId)))
          .limit(1)
      )[0];
      if (found === undefined) {
        throw anchorNotFound();
      }
      const rows = await tx
        .select({ seq: ledgerEvents.seq, eventHash: ledgerEvents.eventHash })
        .from(ledgerEvents)
        .where(
          and(
            eq(ledgerEvents.tenantId, tenantId),
            eq(ledgerEvents.warehouseId, warehouseId),
            gte(ledgerEvents.seq, found.anchor.fromSeq),
            lte(ledgerEvents.seq, found.anchor.toSeq),
          ),
        )
        .orderBy(asc(ledgerEvents.seq));
      const anchor = toAnchorView(found.anchor, found.copy);
      const recomputedDigest = digestOverRange(rows);
      return {
        tenantId,
        warehouseId,
        anchor,
        algorithm: LEDGER_PROOF_ALGORITHM,
        legacyForm: anchor.kind === 'legacy' ? LEDGER_PROOF_LEGACY_FORM : null,
        lines: rows.map((row) => `${row.seq}:${row.eventHash}`),
        recomputedDigest,
        matches: recomputedDigest === anchor.digest && rows.length === anchor.toSeq - anchor.fromSeq + 1,
      };
    });
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
