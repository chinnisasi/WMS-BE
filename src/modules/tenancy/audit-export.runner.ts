import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, auditExports, users } from '../../shared/db/schema';
import { auditFilterSql } from '../../shared/db/audit-filter';
import { openSessionsInTx, sessionVisibilityAdviceInTx } from '../../shared/db/open-transactions';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK, type OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, fullPrecisionInstant, nowIso } from '../../shared/primitives/time';
import { AuditCsvGzipWriter, type AuditExportCsvRow } from './audit-export.csv';
import {
  AUDIT_EXPORT_EXPIRED_EVENT,
  AUDIT_EXPORT_FAILED_EVENT,
  AUDIT_EXPORT_LIFETIME_DAYS,
  AUDIT_EXPORT_READY_EVENT,
  auditFiltersOf,
  type AuditExportFailureReason,
  type StoredAuditFilters,
} from './audit-export.command';
import { AUDIT_EXPORT_STORE, type AuditExportStore } from './audit-export.store';

/**
 * The runner's limits — an exported, MUTABLE object (the `pushClock` /
 * `reservationRepairClock` precedent), so a suite can shrink them and cross
 * a page boundary or the cap with a handful of rows. Tests ASSIGN fields and
 * restore them; production never touches it.
 *  - `pageSize` — rows per page, each page its own transaction;
 *  - `maxRows` — the cap: reading row `maxRows + 1` fails `too-many-events`;
 *  - `snapshotGraceMs` — the §7d clock-skew margin: a row is claimable only
 *    once `now() >= snapshot_at + snapshotGraceMs`.
 */
export const auditExportLimits = {
  pageSize: 5_000,
  maxRows: 1_000_000,
  snapshotGraceMs: 5_000,
};

/** A `running` row whose heartbeat is older than this was abandoned by its runner. */
export const AUDIT_EXPORT_STALE_MINUTES = 15;
/** A reclaimed row goes back to `queued` while it has had fewer claims than this; then it fails `interrupted`. */
export const AUDIT_EXPORT_MAX_ATTEMPTS = 3;
/** Each page's statement budget (a timeout is `export-error`). */
export const AUDIT_EXPORT_PAGE_TIMEOUT_MS = 30_000;
/** The expiry step handles at most this many rows per tick (the rest next tick). */
const MAX_EXPIRIES_PER_TICK = 100;

/** Why nothing was claimed this tick (the §7d proof did not hold). */
export type AuditExportWaiting = 'grace' | 'open-transaction' | 'session-visibility';

/** What one `runDue` did — for the worker's log and the suites. */
export interface AuditExportRunSummary {
  /** Running rows put back to `queued`. */
  readonly requeued: number;
  /** Running rows failed `interrupted` (the third stale claim). */
  readonly interrupted: number;
  /** Ready/failed rows expired. */
  readonly expired: number;
  /** The export this tick claimed, or null. */
  readonly claimed: string | null;
  /** The claimed run's end: `ready`, `failed` with its reason, or `lost` (reclaimed meanwhile — nothing written). */
  readonly outcome: 'ready' | AuditExportFailureReason | 'lost' | null;
  /** Set when a queued row exists but the §7d proof did not hold. */
  readonly waiting: AuditExportWaiting | null;
}

interface Claim {
  readonly id: string;
  readonly requestedBy: string;
  readonly attempts: number;
  readonly filters: StoredAuditFilters;
  /** The full-precision snapshot instant (the keyset's upper bound). */
  readonly snapshotAt: string;
}

/** A failure the runner names (anything else is `export-error`). */
class ExportFailure extends Error {
  constructor(readonly reason: AuditExportFailureReason) {
    super(reason);
  }
}

/** The claimed run was reclaimed by another runner — discard everything. */
class RunLost extends Error {}

/**
 * Story 9-3b — the audit export worker's per-tenant pass, called by the jobs
 * shell's `AuditExportWorker` through `TenancyService.runDueAuditExports`.
 * In order:
 *
 *  1. **Reclaim** — a `running` row whose heartbeat is older than 15 minutes
 *     goes back to `queued` while `attempts < 3`; otherwise it fails
 *     `interrupted` (dates set, `audit_export.failed` appended, one tx).
 *  2. **Expire** — each `ready`/`failed` row past `expires_at`, one tx each:
 *     the file removed, `expired`, `audit_export.expired` appended.
 *  3. **Prove the snapshot** (IMPLEMENTATION-GUIDE §7d) — the oldest
 *     `queued` row is claimable only when `now() >= snapshot_at + 5 s` AND
 *     no other client backend has an open transaction that began before
 *     `snapshot_at` (a hidden session counts as not proven).
 *  4. **Claim** — `FOR UPDATE SKIP LOCKED`, `running`, `attempts + 1`,
 *     `started_at = heartbeat_at = now()`; committed before any work.
 *  5. **Write** — page the matching rows with `created_at < snapshot_at`,
 *     newest first, on the full-precision `created_at::text` keyset; each
 *     page its own transaction under a 30 s statement budget, ending with a
 *     heartbeat conditional on `(running, claimed attempts)`.
 *  6. **Finish** — one tx, conditional on `(running, claimed attempts)`: a
 *     reclaimed run updates zero rows and writes NOTHING. Ready: the row,
 *     then the file, then `audit_export.ready`. Failed: the row and
 *     `audit_export.failed`.
 *
 * Worker-written lifecycle events are outbox events ONLY — never
 * `audit_events` rows (the worker is unkeyed, outside the audit rule).
 * Nothing here throws out of a tick except a failure of the tick's own
 * bookkeeping, which the worker logs per tenant.
 */
@Injectable()
export class AuditExportRunner {
  private readonly logger = new Logger('AuditExportRunner');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(AUDIT_EXPORT_STORE) private readonly store: AuditExportStore,
  ) {}

  /**
   * The §7d probe (`shared/db/open-transactions.ts`). A plain field so a
   * suite can stand in a hidden session without a second production path
   * (the `ReportingFacade.auditRead` precedent).
   */
  openSessions: (tx: TenantTx) => Promise<{ oldestXactStart: string | null; hidden: boolean; hiddenCount: number }> = openSessionsInTx;

  async runDue(tenantId: string): Promise<AuditExportRunSummary> {
    const { requeued, interrupted } = await this.reclaim(tenantId);
    const expired = await this.expire(tenantId);
    const claimed = await this.claim(tenantId);
    if ('waiting' in claimed) {
      return { requeued, interrupted, expired, claimed: null, outcome: null, waiting: claimed.waiting };
    }
    if (claimed.claim === null) {
      return { requeued, interrupted, expired, claimed: null, outcome: null, waiting: null };
    }
    const outcome = await this.run(tenantId, claimed.claim);
    return { requeued, interrupted, expired, claimed: claimed.claim.id, outcome, waiting: null };
  }

  // ── 1. reclaim ─────────────────────────────────────────────────────────────

  private async reclaim(tenantId: string): Promise<{ requeued: number; interrupted: number }> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const stale = and(
        eq(auditExports.tenantId, tenantId),
        eq(auditExports.status, 'running'),
        sql`${auditExports.heartbeatAt} < now() - make_interval(mins => ${AUDIT_EXPORT_STALE_MINUTES})`,
      );
      const requeued = await tx
        .update(auditExports)
        .set({ status: 'queued', startedAt: null, heartbeatAt: null, updatedAt: sql`now()` })
        .where(and(stale, lt(auditExports.attempts, AUDIT_EXPORT_MAX_ATTEMPTS)))
        .returning({ id: auditExports.id });
      const failed = await tx
        .update(auditExports)
        .set({
          status: 'failed',
          failureReason: 'interrupted',
          finishedAt: sql`now()`,
          expiresAt: sql`now() + make_interval(days => ${AUDIT_EXPORT_LIFETIME_DAYS})`,
          updatedAt: sql`now()`,
        })
        .where(and(stale, sql`${auditExports.attempts} >= ${AUDIT_EXPORT_MAX_ATTEMPTS}`))
        .returning({ id: auditExports.id, requestedBy: auditExports.requestedBy });
      for (const row of failed) {
        await this.append(tx, tenantId, AUDIT_EXPORT_FAILED_EVENT, { exportId: row.id, requestedBy: row.requestedBy, reason: 'interrupted' });
        this.logger.warn(`audit export ${row.id} (tenant ${tenantId}) failed: interrupted after ${AUDIT_EXPORT_MAX_ATTEMPTS} stale claims`);
      }
      return { requeued: requeued.length, interrupted: failed.length };
    });
  }

  // ── 2. expire ──────────────────────────────────────────────────────────────

  private async expire(tenantId: string): Promise<number> {
    let expired = 0;
    for (let i = 0; i < MAX_EXPIRIES_PER_TICK; i += 1) {
      const done = await withTenantTransaction(this.db, tenantId, async (tx) => {
        const [due] = await tx
          .select({ id: auditExports.id, requestedBy: auditExports.requestedBy })
          .from(auditExports)
          .where(
            and(
              eq(auditExports.tenantId, tenantId),
              inArray(auditExports.status, ['ready', 'failed']),
              sql`${auditExports.expiresAt} < now()`,
            ),
          )
          .orderBy(asc(auditExports.expiresAt), asc(auditExports.id))
          .limit(1)
          .for('update', { skipLocked: true });
        if (due === undefined) return false;
        await this.store.remove(tx, tenantId, due.id);
        await tx
          .update(auditExports)
          .set({ status: 'expired', updatedAt: sql`now()` })
          .where(and(eq(auditExports.tenantId, tenantId), eq(auditExports.id, due.id)));
        await this.append(tx, tenantId, AUDIT_EXPORT_EXPIRED_EVENT, { exportId: due.id, requestedBy: due.requestedBy });
        return true;
      });
      if (!done) break;
      expired += 1;
    }
    return expired;
  }

  // ── 3 + 4. prove the snapshot, then claim ──────────────────────────────────

  private async claim(tenantId: string): Promise<{ claim: Claim | null } | { waiting: AuditExportWaiting }> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const [oldest] = await tx
        .select({
          id: auditExports.id,
          snapshotAt: auditExports.snapshotAt,
          snapshotAtText: sql<string>`${auditExports.snapshotAt}::text`,
          graceOver: sql<boolean>`now() >= ${auditExports.snapshotAt} + make_interval(secs => ${auditExportLimits.snapshotGraceMs / 1000}::double precision)`,
        })
        .from(auditExports)
        .where(and(eq(auditExports.tenantId, tenantId), eq(auditExports.status, 'queued')))
        .orderBy(asc(auditExports.createdAt), asc(auditExports.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (oldest === undefined) return { claim: null };
      if (!oldest.graceOver) return { waiting: 'grace' as const };

      // §7d: every transaction that began before the snapshot has finished.
      // The probe's instant is millisecond-truncated (only ever earlier), so
      // `<=` against the truncated snapshot stays on the safe side.
      const sessions = await this.openSessions(tx);
      if (sessions.hidden) {
        this.logger.error(
          `AUDIT EXPORT WAITING ${oldest.id} (tenant ${tenantId}): ${sessions.hiddenCount} session(s) hidden from this role — ` +
            `the snapshot cannot be proven; ${await sessionVisibilityAdviceInTx(tx)}`,
        );
        return { waiting: 'session-visibility' as const };
      }
      if (sessions.oldestXactStart !== null && Date.parse(sessions.oldestXactStart) <= Date.parse(canonicalInstant(oldest.snapshotAt))) {
        return { waiting: 'open-transaction' as const };
      }

      const [row] = await tx
        .update(auditExports)
        .set({
          status: 'running',
          attempts: sql`${auditExports.attempts} + 1`,
          startedAt: sql`now()`,
          heartbeatAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(auditExports.tenantId, tenantId), eq(auditExports.id, oldest.id), eq(auditExports.status, 'queued')))
        .returning();
      if (row === undefined) return { claim: null };
      return {
        claim: {
          id: row.id,
          requestedBy: row.requestedBy,
          attempts: row.attempts,
          filters: row.filters as StoredAuditFilters,
          snapshotAt: fullPrecisionInstant(oldest.snapshotAtText),
        },
      };
    });
  }

  // ── 5 + 6. write, then finish ──────────────────────────────────────────────

  private async run(tenantId: string, claim: Claim): Promise<'ready' | AuditExportFailureReason | 'lost'> {
    const writer = new AuditCsvGzipWriter();
    let failure: AuditExportFailureReason;
    try {
      await this.writeRows(tenantId, claim, writer);
      const file = await writer.finish();
      const finished = await this.finishReady(tenantId, claim, file.gzipped, file.rowCount, file.sha256);
      if (!finished) return 'lost';
      return 'ready';
    } catch (err) {
      writer.discard();
      if (err instanceof RunLost) return 'lost';
      if (err instanceof ExportFailure) {
        failure = err.reason;
      } else {
        failure = 'export-error';
        this.logger.error(
          `audit export ${claim.id} (tenant ${tenantId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      const finished = await this.finishFailed(tenantId, claim, failure);
      return finished ? failure : 'lost';
    } catch (err) {
      // The row stays `running`; the reclaim step picks it up once its
      // heartbeat is stale. Never thrown out of the tick.
      this.logger.error(
        `audit export ${claim.id} (tenant ${tenantId}) could not record its failure (${failure}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return failure;
    }
  }

  private async writeRows(tenantId: string, claim: Claim, writer: AuditCsvGzipWriter): Promise<void> {
    const filters = auditFiltersOf(claim.filters);
    const { pageSize, maxRows } = auditExportLimits;
    let before: { createdAt: string; id: string } | null = null;
    let read = 0;
    for (;;) {
      const page = await withTenantTransaction(this.db, tenantId, async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', ${String(AUDIT_EXPORT_PAGE_TIMEOUT_MS)}, true)`);
        const rows = await tx
          .select({
            id: auditEvents.id,
            createdAt: auditEvents.createdAt,
            createdAtText: sql<string>`${auditEvents.createdAt}::text`,
            occurredAt: auditEvents.occurredAt,
            actorUserId: auditEvents.actorUserId,
            actorEmail: users.email,
            action: auditEvents.action,
            targetType: auditEvents.targetType,
            targetId: auditEvents.targetId,
          })
          .from(auditEvents)
          .leftJoin(users, and(eq(users.tenantId, auditEvents.tenantId), eq(users.id, auditEvents.actorUserId)))
          .where(
            and(
              ...auditFilterSql(tenantId, filters),
              sql`${auditEvents.createdAt} < ${claim.snapshotAt}::timestamptz`,
              before === null
                ? undefined
                : sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
            ),
          )
          .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
          .limit(pageSize);
        const beat = await tx
          .update(auditExports)
          .set({ heartbeatAt: sql`now()`, updatedAt: sql`now()` })
          .where(this.stillOurs(tenantId, claim))
          .returning({ id: auditExports.id });
        if (beat.length === 0) throw new RunLost();
        return rows;
      });
      read += page.length;
      if (read > maxRows) throw new ExportFailure('too-many-events');
      await writer.write(page.map((row): AuditExportCsvRow => ({ ...row })));
      if (page.length < pageSize) return;
      const last = page[page.length - 1]!;
      // The cursor carries the FULL-precision instant (`audit.ts`'s rule):
      // every row a transaction writes shares its now() to the microsecond,
      // and a millisecond-truncated strict `<` would skip the tie group's tail.
      before = { createdAt: fullPrecisionInstant(last.createdAtText), id: last.id };
    }
  }

  private async finishReady(tenantId: string, claim: Claim, gzipped: Buffer, rowCount: number, sha256: string): Promise<boolean> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .update(auditExports)
        .set({
          status: 'ready',
          rowCount,
          byteSize: gzipped.length,
          sha256,
          finishedAt: sql`now()`,
          expiresAt: sql`now() + make_interval(days => ${AUDIT_EXPORT_LIFETIME_DAYS})`,
          updatedAt: sql`now()`,
        })
        .where(this.stillOurs(tenantId, claim))
        .returning({ id: auditExports.id });
      if (row === undefined) return false; // reclaimed meanwhile: store nothing, append nothing
      await this.store.put(tx, tenantId, claim.id, gzipped);
      await this.append(tx, tenantId, AUDIT_EXPORT_READY_EVENT, { exportId: claim.id, requestedBy: claim.requestedBy, rowCount });
      return true;
    });
  }

  private async finishFailed(tenantId: string, claim: Claim, reason: AuditExportFailureReason): Promise<boolean> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .update(auditExports)
        .set({
          status: 'failed',
          failureReason: reason,
          finishedAt: sql`now()`,
          expiresAt: sql`now() + make_interval(days => ${AUDIT_EXPORT_LIFETIME_DAYS})`,
          updatedAt: sql`now()`,
        })
        .where(this.stillOurs(tenantId, claim))
        .returning({ id: auditExports.id });
      if (row === undefined) return false;
      await this.append(tx, tenantId, AUDIT_EXPORT_FAILED_EVENT, { exportId: claim.id, requestedBy: claim.requestedBy, reason });
      return true;
    });
  }

  /** The claimed run still owns the row: still `running` under the attempts it claimed. */
  private stillOurs(tenantId: string, claim: Claim) {
    return and(
      eq(auditExports.tenantId, tenantId),
      eq(auditExports.id, claim.id),
      eq(auditExports.status, 'running'),
      eq(auditExports.attempts, claim.attempts),
    );
  }

  private async append(tx: TenantTx, tenantId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.outbox.append(tx, { messageId: uuidv7(), tenantId, type, payload, occurredAt: nowIso() });
  }
}

