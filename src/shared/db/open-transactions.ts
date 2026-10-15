import { sql } from 'drizzle-orm';
import type { TenantDb, TenantTx } from './tenant-scope';

/**
 * IMPLEMENTATION-GUIDE §7d's probe — proving "every transaction that began
 * before T has finished". Moved here from `billing/storage-snapshot.ts`
 * (story 9-3b) because a second module needs it: the storage snapshots
 * (21-4) and the async audit export (9-3b, `tenancy/audit-export.runner.ts`)
 * both read rows stamped by a transaction's start and must not read before
 * every such transaction has committed or rolled back.
 *
 * Returns the oldest `xact_start` among OTHER client backends of this
 * database with an open transaction, and whether any such backend is hidden
 * from this role (`<insufficient privilege>` — its transaction state
 * unreadable). A caller must REFUSE when `hidden` — an invisible session is
 * never idle — and treat `oldestXactStart <= T` as "not yet proven". The
 * instant is millisecond-truncated (`Date`), which only ever moves it
 * earlier: a caller comparing `<=` against T stays on the safe side.
 *
 * The filter admits `backend_type is null` ON PURPOSE. A row hidden from
 * this role (another role's session, no `pg_read_all_stats`) NULLs every
 * per-backend column except `datname` and `usename` — `backend_type`,
 * `state`, `xact_start` included — so filtering on `backend_type = 'client
 * backend'` alone dropped every hidden session BEFORE it was counted: the
 * probe read `hidden = 0, oldest = NULL` and both callers proceeded without
 * their guarantee (Epic 9 retro F1). A VISIBLE non-client backend
 * (autovacuum, walsender) still carries its non-null type and stays
 * excluded; a hidden one counts as hidden, which only ever refuses (fails
 * safe). `scripts/provision-roles.sql` grants the app role
 * `pg_read_all_stats`, so the provisioned deployment sees every session.
 * That grant is REQUIRED — one role for every connection is not a substitute,
 * since a hidden autovacuum worker would still refuse at random.
 */
export async function openSessionsInTx(tx: TenantTx): Promise<{ oldestXactStart: string | null; hidden: boolean; hiddenCount: number }> {
  const [row] = (await tx.execute(sql`
    select
      min(xact_start) filter (where xact_start is not null) as "oldest",
      count(*) filter (where state is null or query = '<insufficient privilege>')::int as "hidden"
    from pg_stat_activity
    where datname = current_database()
      and pid <> pg_backend_pid()
      and (backend_type = 'client backend' or backend_type is null)
  `)) as unknown as { oldest: string | Date | null; hidden: number }[];
  const hiddenCount = Number(row?.hidden ?? 0);
  return {
    oldestXactStart: row?.oldest == null ? null : new Date(row.oldest).toISOString(),
    hidden: hiddenCount > 0,
    hiddenCount,
  };
}

/**
 * The refusal advice both callers log when `hidden`: names this session's
 * role (`current_user`, identifier-quoted) and prints the exact GRANT that
 * fixes it. Runs only on the refusal path.
 */
export async function sessionVisibilityAdviceInTx(tx: TenantTx): Promise<string> {
  const [row] = (await tx.execute(sql`select quote_ident(current_user) as "role"`)) as unknown as { role: string }[];
  return grantAdvice(row?.role ?? 'current_user');
}

function grantAdvice(role: string): string {
  return (
    `the role ${role} lacks pg_read_all_stats — run \`GRANT pg_read_all_stats TO ${role};\` as a superuser or the managed-Postgres master user ` +
    '(scripts/provision-roles.sql grants it to the app role)'
  );
}

/**
 * The boot-time check for the two §7d workers (audit export, storage
 * snapshots): does the app DATABASE role hold `pg_read_all_stats`? A missing
 * grant otherwise surfaces only at the first tick, then once per scope per
 * tick. Logs ONE warning when it is missing and returns false; never throws
 * (a failed check is itself one warning) — the boot never fails on it. A
 * superuser reads true.
 */
export async function checkSessionVisibility(
  db: Pick<TenantDb, 'execute'>,
  logger: { warn(message: string): void },
  worker: string,
): Promise<boolean> {
  try {
    const [row] = (await db.execute(
      sql`select quote_ident(current_user) as "role", pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') as "visible"`,
    )) as unknown as { role: string; visible: boolean }[];
    if (row?.visible === true) return true;
    logger.warn(`${worker}: every tick will refuse (session-visibility) — ${grantAdvice(row?.role ?? 'current_user')}`);
    return false;
  } catch (err) {
    logger.warn(`${worker}: could not check pg_read_all_stats at boot (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}
