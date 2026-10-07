import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { storageSnapshotProgress, storageSnapshots } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { addIsoDays, istDateOf, istMidnightOf } from '../../shared/primitives/time';
import { assertClientInTenantInTx } from '../clients/clients.facade';
import { InventoryFacade, type ClientWarehouseScope } from '../inventory/inventory.facade';

/**
 * Story 21-4 — daily storage snapshots (FR-78, CAP-6; AD-25: a rebuildable
 * projection over the ledger, never a book).
 *
 * A snapshot row is a client brand's on-hand base milli-units in one
 * warehouse, per SKU base UoM, at the END of an IST day `D` — the ledger fold
 * (`InventoryFacade.clientOnHandFoldByDayInTx`, the ledger's own replay rule)
 * over every event with `recorded_at < T`, where `T` is the IST midnight that
 * ends `D`. Stock leaves storage when it is PICKED (the draw); pack and
 * dispatch move nothing in the ledger (decision 2).
 *
 * THE COMMIT GUARANTEE (renegotiated by the human, 2026-10-07).
 * `recorded_at` is the app clock, stamped before the per-warehouse advisory
 * lock, and nothing bounds how long a transaction can run — so an event
 * stamped before `T` can commit long after `T`. A fixed wait cannot prove
 * completeness. Day `D` is written only when BOTH hold:
 *   (a) `now ≥ T + 15 min` (`SNAPSHOT_GRACE_MS` — clock-skew margin), and
 *   (b) no session in `pg_stat_activity` (this database, client backends,
 *       other than this one) has an open transaction with `xact_start < T`.
 * Every ledger, GRN and pick stamp is taken inside a transaction that began
 * no later than the stamp, so (b) proves every event stamped before `T` has
 * committed (or rolled back) — with or without an xid yet — and the handling
 * counts too. If this role cannot SEE another session's transaction (an
 * `<insufficient privilege>` row), the job refuses to write and logs an
 * error; it never guesses. A deploy keeps every app connection on one role,
 * or grants the job's role `pg_read_all_stats`.
 *
 * Rows are written once (`ON CONFLICT DO NOTHING`) and the job never
 * rewrites them. A DRIFT CHECK — a re-fold of the last 7 written days plus a
 * genesis-sum check (the full fold to the watermark's end equals the stored
 * running total) — runs once per IST day per scope, or when the watermark
 * advances, and logs any mismatch loudly (it should never fire). The rebuild
 * script (`scripts/rebuild-storage-snapshots.ts`) verifies by default and
 * rewrites only on `--write`.
 *
 * Only client brands are snapshotted — never the tenant's `self` client
 * (decision 4); every entry point refuses it.
 */

/** (a) — the margin past the IST midnight before a day may be written. */
export const SNAPSHOT_GRACE_MS = 15 * 60_000;
/** A call folds at most this many days (the backfill pace: a month per tick). */
export const MAX_SNAPSHOT_DAYS_PER_CALL = 31;
/** The drift check re-folds this many of the most recently written days. */
export const DRIFT_CHECK_DAYS = 7;

/** One (day, uom) whose stored value differs from the ledger's re-fold. */
export interface SnapshotDrift {
  /** `row`: a snapshot row; `running`: the watermark's running total (the genesis-sum check). */
  readonly kind?: 'row' | 'running';
  readonly day: string;
  readonly uom: string;
  /** Stored on-hand milli-units, or null when no row exists. */
  readonly stored: string | null;
  /** The re-folded value (> 0), or null when the fold says zero. */
  readonly refolded: string | null;
}

/** What one `snapshotScopeInTx` call did. */
export interface SnapshotTickResult {
  /** The watermark after the call — the last IST day written (null: the scope has no events yet). */
  readonly lastDay: string | null;
  readonly daysWritten: number;
  readonly rowsWritten: number;
  /**
   * Why nothing (more) was written: inside the grace; a transaction that
   * began before the next day's end is still open; or this role cannot see
   * other sessions (refused — logged as an error).
   */
  readonly waiting: 'grace' | 'commit-guarantee' | 'session-visibility' | null;
  /** The drift check's findings — empty when clean, or when it was not due this call. */
  readonly drift: readonly SnapshotDrift[];
  /** Whether the drift check ran this call (once per IST day per scope, or when the watermark advanced). */
  readonly driftChecked: boolean;
}

/** A dry-run re-fold from genesis, diffed against the stored set. */
export interface SnapshotVerifyResult {
  readonly lastDay: string | null;
  /** The (day, uom, value) set the ledger says, through the watermark. */
  readonly expectedRows: number;
  readonly storedRows: number;
  readonly drift: readonly SnapshotDrift[];
}

/** Values per base UoM, milli-units. */
type UomValues = Map<string, bigint>;

/**
 * The per-scope serialisation point: two job instances (or a job tick and the
 * rebuild script) on the same (client, warehouse) run one at a time. A
 * transaction-scoped advisory lock.
 */
function scopeAdvisoryLock(scope: ClientWarehouseScope) {
  return sql`select pg_advisory_xact_lock(hashtextextended(${scope.tenantId} || ':storage-snapshot:' || ${scope.clientId} || ':' || ${scope.warehouseId}, 0))`;
}

/** The IST day `D` the instant `ms` is past the grace of — the latest day `(a)` admits. */
export function lastClosableDay(nowMs: number): string {
  return addIsoDays(istDateOf(new Date(nowMs - SNAPSHOT_GRACE_MS).toISOString()), -1);
}

function maxDay(a: string, b: string): string {
  return a >= b ? a : b;
}

function minDay(a: string, b: string): string {
  return a <= b ? a : b;
}

function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addIsoDays(day, 1)) days.push(day);
  return days;
}

function runningFromJson(value: unknown): UomValues {
  const running: UomValues = new Map();
  if (value !== null && typeof value === 'object') {
    for (const [uom, milli] of Object.entries(value as Record<string, unknown>)) {
      if (typeof milli === 'string' || typeof milli === 'number') running.set(uom, BigInt(milli));
    }
  }
  return running;
}

function runningToJson(running: UomValues): Record<string, string> {
  const json: Record<string, string> = {};
  for (const [uom, milli] of [...running.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (milli !== 0n) json[uom] = milli.toString();
  }
  return json;
}

@Injectable()
export class StorageSnapshotService {
  private readonly logger = new Logger('StorageSnapshots');

  constructor(@Inject(InventoryFacade) private readonly inventory: InventoryFacade) {}

  /**
   * One tick for one (client, warehouse) scope, in the caller's tenant
   * transaction: lock the scope → the commit guarantee (grace, then the open
   * sessions) → read the watermark (or, for a scope never written, its first
   * event — read AFTER the guarantee, so an earlier-stamped event that has
   * since committed is seen) → fold the new days (≤ 31) from the running
   * total → insert the positive rows → advance the watermark (`GREATEST`;
   * the progress row is born here, with the first written day) → the drift
   * check when due. Idempotent: a re-run, a crash or a second instance
   * yields the same rows, and the watermark never moves back.
   */
  async snapshotScopeInTx(
    tx: TenantTx,
    tenantId: string,
    clientId: string,
    warehouseId: string,
    nowMs: number,
  ): Promise<SnapshotTickResult> {
    const scope: ClientWarehouseScope = { tenantId, clientId, warehouseId };
    await this.assertClientBrandInTx(tx, scope);
    await tx.execute(scopeAdvisoryLock(scope));
    const today = istDateOf(new Date(nowMs).toISOString());
    const idle = { lastDay: null, daysWritten: 0, rowsWritten: 0, drift: [], driftChecked: false } as const;

    const closable = lastClosableDay(nowMs);
    const progressBefore = await this.readProgressInTx(tx, scope);
    if (progressBefore !== null && closable <= progressBefore.lastDay) {
      // (a) not yet: the next day has not ended + the grace.
      const checked = await this.maybeDriftCheckInTx(tx, scope, progressBefore, today, false);
      return { ...idle, lastDay: progressBefore.lastDay, waiting: 'grace', ...checked };
    }

    // (b) — BEFORE any read the fold depends on: a transaction open at this
    // probe that began before a day's end holds that day back; one that is
    // not open here has committed (or rolled back) and every read below
    // (a fresh statement snapshot each, READ COMMITTED) sees its effects.
    const sessions = await this.openSessionsInTx(tx);
    if (sessions.hidden) {
      this.logger.error(
        `STORAGE SNAPSHOT REFUSED — client ${clientId}, warehouse ${warehouseId} (tenant ${tenantId}): this database role ` +
          `cannot see ${sessions.hiddenCount} other session(s) in pg_stat_activity, so it cannot prove that every transaction ` +
          `which began before a day's end has finished. Keep every app connection on one role, or grant the job's role ` +
          `pg_read_all_stats. Nothing was written.`,
      );
      return { ...idle, lastDay: progressBefore?.lastDay ?? null, waiting: 'session-visibility' };
    }
    // The latest day D whose end T ≤ the oldest open transaction's start.
    const guaranteedThrough =
      sessions.oldestXactStart === null ? closable : minDay(closable, addIsoDays(istDateOf(sessions.oldestXactStart), -1));

    const progress = await this.readProgressInTx(tx, scope);
    let lastDay: string;
    let running: UomValues;
    if (progress === null) {
      // Never written: the first day is the first event's — read NOW, under
      // the guarantee, never persisted before it (an event stamped earlier
      // that committed late must not lose its days).
      const first = await this.inventory.firstEventInstantInTx(tx, scope);
      if (first === null) return { ...idle, waiting: null };
      lastDay = addIsoDays(istDateOf(first), -1);
      running = new Map();
    } else {
      lastDay = progress.lastDay;
      running = runningFromJson(progress.running);
    }
    if (guaranteedThrough <= lastDay) {
      const waiting = closable <= lastDay ? 'grace' : 'commit-guarantee';
      const checked = progress === null ? { drift: [], driftChecked: false } : await this.maybeDriftCheckInTx(tx, scope, progress, today, false);
      return { ...idle, lastDay: progress?.lastDay ?? null, waiting, ...checked };
    }

    const start = addIsoDays(lastDay, 1);
    const end = minDay(guaranteedThrough, addIsoDays(start, MAX_SNAPSHOT_DAYS_PER_CALL - 1));
    const folded = await this.foldDaysInTx(tx, scope, start, end, running, progress === null);
    let rowsWritten = 0;
    for (const [day, values] of folded) {
      for (const [uom, milli] of values) {
        if (milli <= 0n) continue;
        const inserted = (await tx.execute(sql`
          insert into storage_snapshots (id, tenant_id, client_id, warehouse_id, snapshot_date, uom, on_hand_milli)
          values (${uuidv7()}::uuid, ${tenantId}::uuid, ${clientId}::uuid, ${warehouseId}::uuid,
                  ${day}::date, ${uom}, ${milli.toString()}::bigint)
          on conflict (tenant_id, client_id, warehouse_id, snapshot_date, uom) do nothing
          returning id
        `)) as unknown as unknown[];
        rowsWritten += inserted.length;
      }
      running = values;
    }

    // The watermark only moves forward: GREATEST, and `running` follows it
    // only when it moved (the advisory lock already serialises writers —
    // this is the backstop). The progress row is born here.
    await tx.execute(sql`
      insert into storage_snapshot_progress (tenant_id, client_id, warehouse_id, last_day, running, updated_at)
      values (${tenantId}::uuid, ${clientId}::uuid, ${warehouseId}::uuid, ${end}::date,
              ${JSON.stringify(runningToJson(running))}::jsonb, now())
      on conflict (tenant_id, client_id, warehouse_id) do update set
        running = case when excluded.last_day > storage_snapshot_progress.last_day
                       then excluded.running else storage_snapshot_progress.running end,
        last_day = greatest(storage_snapshot_progress.last_day, excluded.last_day),
        updated_at = now()
    `);
    const after = (await this.readProgressInTx(tx, scope))!;
    const checked = await this.maybeDriftCheckInTx(tx, scope, after, today, true);
    const waiting = after.lastDay >= closable ? null : guaranteedThrough <= after.lastDay ? 'commit-guarantee' : null;
    return { lastDay: after.lastDay, daysWritten: folded.size, rowsWritten, waiting, ...checked };
  }

  /**
   * (b)'s probe: the oldest `xact_start` among OTHER client backends of this
   * database with an open transaction, and whether any such backend is
   * hidden from this role (`<insufficient privilege>` — its transaction
   * state unreadable).
   */
  private async openSessionsInTx(tx: TenantTx): Promise<{ oldestXactStart: string | null; hidden: boolean; hiddenCount: number }> {
    const [row] = (await tx.execute(sql`
      select
        min(xact_start) filter (where xact_start is not null) as "oldest",
        count(*) filter (where state is null or query = '<insufficient privilege>')::int as "hidden"
      from pg_stat_activity
      where datname = current_database()
        and backend_type = 'client backend'
        and pid <> pg_backend_pid()
    `)) as unknown as { oldest: string | Date | null; hidden: number }[];
    const hiddenCount = Number(row?.hidden ?? 0);
    return {
      oldestXactStart: row?.oldest == null ? null : new Date(row.oldest).toISOString(),
      hidden: hiddenCount > 0,
      hiddenCount,
    };
  }

  /** The drift check, once per IST day per scope — or whenever the watermark advanced. */
  private async maybeDriftCheckInTx(
    tx: TenantTx,
    scope: ClientWarehouseScope,
    progress: { lastDay: string; running: unknown; driftCheckedOn: string | null },
    today: string,
    advanced: boolean,
  ): Promise<{ drift: SnapshotDrift[]; driftChecked: boolean }> {
    if (!advanced && progress.driftCheckedOn !== null && progress.driftCheckedOn >= today) {
      return { drift: [], driftChecked: false };
    }
    const drift = await this.driftCheckInTx(tx, scope, progress.lastDay, runningFromJson(progress.running));
    await tx.execute(sql`
      update storage_snapshot_progress set drift_checked_on = ${today}::date
      where tenant_id = ${scope.tenantId}::uuid and client_id = ${scope.clientId}::uuid and warehouse_id = ${scope.warehouseId}::uuid
    `);
    return { drift, driftChecked: true };
  }

  /**
   * Dry run: re-fold the scope from genesis through its watermark and diff
   * the `(day, uom, on_hand_milli)` set against the stored rows. Writes
   * nothing. Set equality on key plus value — ids and `created_at` differ by
   * construction — plus the watermark's running total against the genesis
   * sum. Under the scope lock, so a concurrent tick cannot read as drift.
   */
  async verifySnapshotsInTx(tx: TenantTx, tenantId: string, clientId: string, warehouseId: string): Promise<SnapshotVerifyResult> {
    const scope: ClientWarehouseScope = { tenantId, clientId, warehouseId };
    await this.assertClientBrandInTx(tx, scope);
    await tx.execute(scopeAdvisoryLock(scope));
    const progress = await this.readProgressInTx(tx, scope);
    const first = await this.inventory.firstEventInstantInTx(tx, scope);
    if (progress === null || first === null) {
      const stored = await this.storedRowsInTx(tx, scope, null, null);
      return { lastDay: progress?.lastDay ?? null, expectedRows: 0, storedRows: stored.length, drift: stored.map((row) => ({ day: row.day, uom: row.uom, stored: row.milli, refolded: null })) };
    }
    const expected = await this.expectedThroughInTx(tx, scope, istDateOf(first), progress.lastDay);
    const stored = await this.storedRowsInTx(tx, scope, null, null);
    const drift = [
      ...diffRows(expected, stored),
      ...(await this.runningDriftInTx(tx, scope, progress.lastDay, runningFromJson(progress.running))),
    ];
    return { lastDay: progress.lastDay, expectedRows: expected.size, storedRows: stored.length, drift };
  }

  /**
   * Rebuild under the scope lock: delete the scope's rows, re-fold from
   * genesis through the EXISTING watermark (already covered by the commit
   * guarantee — the watermark never moves), insert the positive rows, and
   * reset `running` to the re-fold's end. The operator path (`--write`) and
   * the tests'; the job never calls it.
   */
  async rebuildScopeInTx(tx: TenantTx, tenantId: string, clientId: string, warehouseId: string): Promise<SnapshotVerifyResult> {
    const scope: ClientWarehouseScope = { tenantId, clientId, warehouseId };
    await this.assertClientBrandInTx(tx, scope);
    await tx.execute(scopeAdvisoryLock(scope));
    const before = await this.verifySnapshotsInTx(tx, tenantId, clientId, warehouseId);
    const progress = await this.readProgressInTx(tx, scope);
    const first = await this.inventory.firstEventInstantInTx(tx, scope);
    await tx
      .delete(storageSnapshots)
      .where(
        and(
          eq(storageSnapshots.tenantId, tenantId),
          eq(storageSnapshots.clientId, clientId),
          eq(storageSnapshots.warehouseId, warehouseId),
        ),
      );
    if (progress === null || first === null) return before;
    const folded = await this.foldDaysInTx(tx, scope, istDateOf(first), progress.lastDay, new Map(), true);
    let running: UomValues = new Map();
    for (const [day, values] of folded) {
      for (const [uom, milli] of values) {
        if (milli <= 0n) continue;
        await tx.execute(sql`
          insert into storage_snapshots (id, tenant_id, client_id, warehouse_id, snapshot_date, uom, on_hand_milli)
          values (${uuidv7()}::uuid, ${tenantId}::uuid, ${clientId}::uuid, ${warehouseId}::uuid,
                  ${day}::date, ${uom}, ${milli.toString()}::bigint)
        `);
      }
      running = values;
    }
    await tx.execute(sql`
      update storage_snapshot_progress
      set running = ${JSON.stringify(runningToJson(running))}::jsonb, updated_at = now()
      where tenant_id = ${tenantId}::uuid and client_id = ${clientId}::uuid and warehouse_id = ${warehouseId}::uuid
    `);
    return before;
  }

  /**
   * The minimum watermark across these scopes — the last day a period's
   * storage is complete through. A scope with events but no progress counts
   * as "the day before its first event". Null when there are no scopes.
   */
  async storageCompleteThroughInTx(tx: TenantTx, scopes: readonly ClientWarehouseScope[]): Promise<string | null> {
    let through: string | null = null;
    for (const scope of scopes) {
      const progress = await this.readProgressInTx(tx, scope);
      let day: string | null = progress?.lastDay ?? null;
      if (day === null) {
        const first = await this.inventory.firstEventInstantInTx(tx, scope);
        if (first === null) continue;
        day = addIsoDays(istDateOf(first), -1);
      }
      through = through === null ? day : minDay(through, day);
    }
    return through;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async assertClientBrandInTx(tx: TenantTx, scope: ClientWarehouseScope): Promise<void> {
    const client = await assertClientInTenantInTx(tx, scope.tenantId, scope.clientId);
    if (client.systemOwned) {
      throw new Error(`storage snapshots: the self client (${scope.clientId}) is never snapshotted (decision 4)`);
    }
  }

  /** The genesis-sum check: the full fold to the end of `lastDay` vs the stored running total, per uom. */
  private async runningDriftInTx(tx: TenantTx, scope: ClientWarehouseScope, lastDay: string, running: UomValues): Promise<SnapshotDrift[]> {
    const genesis = await this.inventory.clientOnHandAtInTx(tx, scope, istMidnightOf(addIsoDays(lastDay, 1)));
    const drift: SnapshotDrift[] = [];
    for (const uom of [...new Set([...genesis.keys(), ...running.keys()])].sort()) {
      const want = genesis.get(uom) ?? 0n;
      const have = running.get(uom) ?? 0n;
      if (want !== have) {
        drift.push({ kind: 'running', day: lastDay, uom, stored: have === 0n ? null : have.toString(), refolded: want === 0n ? null : want.toString() });
      }
    }
    return drift;
  }

  private async readProgressInTx(tx: TenantTx, scope: ClientWarehouseScope) {
    const rows = await tx
      .select()
      .from(storageSnapshotProgress)
      .where(
        and(
          eq(storageSnapshotProgress.tenantId, scope.tenantId),
          eq(storageSnapshotProgress.clientId, scope.clientId),
          eq(storageSnapshotProgress.warehouseId, scope.warehouseId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Fold `[start, end]` day by day: the closing value per uom of each day,
   * from `baseline` (the closing value of the day before `start`). With
   * `fromGenesis`, every event before `start` folds into the baseline too
   * (one grouped query either way).
   */
  private async foldDaysInTx(
    tx: TenantTx,
    scope: ClientWarehouseScope,
    start: string,
    end: string,
    baseline: UomValues,
    fromGenesis: boolean,
  ): Promise<Map<string, UomValues>> {
    const deltas = await this.inventory.clientOnHandFoldByDayInTx(
      tx,
      scope,
      fromGenesis ? null : istMidnightOf(start),
      istMidnightOf(addIsoDays(end, 1)),
    );
    const running: UomValues = new Map(baseline);
    const byDay = new Map<string, { uom: string; deltaMilli: bigint }[]>();
    for (const delta of deltas) {
      if (delta.day < start) {
        running.set(delta.uom, (running.get(delta.uom) ?? 0n) + delta.deltaMilli);
        continue;
      }
      const list = byDay.get(delta.day) ?? [];
      list.push(delta);
      byDay.set(delta.day, list);
    }
    const out = new Map<string, UomValues>();
    for (const day of daysBetween(start, end)) {
      for (const delta of byDay.get(day) ?? []) {
        running.set(delta.uom, (running.get(delta.uom) ?? 0n) + delta.deltaMilli);
      }
      out.set(day, new Map(running));
    }
    return out;
  }

  /** The positive (day, uom) → milli set the ledger says for `[first, through]`. */
  private async expectedThroughInTx(
    tx: TenantTx,
    scope: ClientWarehouseScope,
    firstDay: string,
    through: string,
  ): Promise<Map<string, string>> {
    const expected = new Map<string, string>();
    if (through < firstDay) return expected;
    const folded = await this.foldDaysInTx(tx, scope, firstDay, through, new Map(), true);
    for (const [day, values] of folded) {
      for (const [uom, milli] of values) {
        if (milli > 0n) expected.set(`${day}|${uom}`, milli.toString());
      }
    }
    return expected;
  }

  private async storedRowsInTx(
    tx: TenantTx,
    scope: ClientWarehouseScope,
    from: string | null,
    to: string | null,
  ): Promise<{ day: string; uom: string; milli: string }[]> {
    const rows = await tx
      .select({
        day: storageSnapshots.snapshotDate,
        uom: storageSnapshots.uom,
        milli: sql<string>`${storageSnapshots.onHandMilli}::text`,
      })
      .from(storageSnapshots)
      .where(
        and(
          eq(storageSnapshots.tenantId, scope.tenantId),
          eq(storageSnapshots.clientId, scope.clientId),
          eq(storageSnapshots.warehouseId, scope.warehouseId),
          from === null ? undefined : gte(storageSnapshots.snapshotDate, from),
          to === null ? undefined : lte(storageSnapshots.snapshotDate, to),
        ),
      )
      .orderBy(asc(storageSnapshots.snapshotDate), asc(storageSnapshots.uom));
    return rows.map((row) => ({ day: row.day, uom: row.uom, milli: String(row.milli) }));
  }

  /**
   * The drift check: re-fold the last `DRIFT_CHECK_DAYS` written days from
   * the stored closing value of the day before them and compare to the
   * stored rows, plus the genesis-sum check of the running total (which sees
   * a wrong baseline the window cannot). A
   * mismatch means an event committed after its day was written — which the
   * commit guarantee says cannot happen — so it is logged as an ERROR, never
   * silently corrected (the rebuild script is the repair).
   */
  private async driftCheckInTx(tx: TenantTx, scope: ClientWarehouseScope, lastDay: string, running: UomValues): Promise<SnapshotDrift[]> {
    const first = await this.inventory.firstEventInstantInTx(tx, scope);
    if (first === null) return [];
    const firstDay = istDateOf(first);
    if (lastDay < firstDay) return [];
    const start = maxDay(firstDay, addIsoDays(lastDay, -(DRIFT_CHECK_DAYS - 1)));
    const baseline: UomValues = new Map();
    if (start > firstDay) {
      for (const row of await this.storedRowsInTx(tx, scope, addIsoDays(start, -1), addIsoDays(start, -1))) {
        baseline.set(row.uom, BigInt(row.milli));
      }
    }
    // From the window's start when a stored baseline exists; from genesis
    // when the window starts at the scope's first day (nothing before it).
    const folded = await this.foldDaysInTx(tx, scope, start, lastDay, baseline, start === firstDay);
    const expected = new Map<string, string>();
    for (const [day, values] of folded) {
      for (const [uom, milli] of values) {
        if (milli > 0n) expected.set(`${day}|${uom}`, milli.toString());
      }
    }
    const drift = [
      ...diffRows(expected, await this.storedRowsInTx(tx, scope, start, lastDay)),
      // The window cannot see a wrong baseline outside it: the genesis sum
      // to the watermark's end must equal the stored running total.
      ...(await this.runningDriftInTx(tx, scope, lastDay, running)),
    ];
    if (drift.length > 0) {
      this.logger.error(
        `STORAGE SNAPSHOT DRIFT — client ${scope.clientId}, warehouse ${scope.warehouseId} (tenant ${scope.tenantId}): ` +
          `${drift.length} (day, uom) value(s) differ from the ledger re-fold — an event committed after its day was ` +
          `written. Run scripts/rebuild-storage-snapshots.ts to verify and repair: ` +
          JSON.stringify(drift.slice(0, 10)),
      );
    }
    return drift;
  }
}

/** Set difference on (day, uom) → value, both ways. */
function diffRows(expected: Map<string, string>, stored: readonly { day: string; uom: string; milli: string }[]): SnapshotDrift[] {
  const drift: SnapshotDrift[] = [];
  const seen = new Set<string>();
  for (const row of stored) {
    const key = `${row.day}|${row.uom}`;
    seen.add(key);
    const want = expected.get(key) ?? null;
    if (want !== row.milli) drift.push({ kind: 'row', day: row.day, uom: row.uom, stored: row.milli, refolded: want });
  }
  for (const [key, value] of expected) {
    if (seen.has(key)) continue;
    const [day, uom] = key.split('|') as [string, string];
    drift.push({ kind: 'row', day, uom, stored: null, refolded: value });
  }
  return drift.sort((a, b) => a.day.localeCompare(b.day) || a.uom.localeCompare(b.uom));
}
