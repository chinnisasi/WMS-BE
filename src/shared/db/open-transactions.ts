import { sql } from 'drizzle-orm';
import type { TenantTx } from './tenant-scope';

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
 */
export async function openSessionsInTx(tx: TenantTx): Promise<{ oldestXactStart: string | null; hidden: boolean; hiddenCount: number }> {
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
