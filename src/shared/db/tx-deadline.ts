import { sql } from 'drizzle-orm';
import type { TenantTx } from './tenant-scope';

/**
 * Story 5-3a — a WHOLE-read deadline for a transaction whose statements run
 * in several modules' facades (the operational registers).
 *
 * `statement_timeout` bounds ONE statement (design review B2), so a read of
 * many statements re-arms it to the time left before each one — the 21-8
 * `armServiceDeadline` shape. The reporting module owns the deadline and
 * registers it on its transaction (`setTxDeadline`); each facade read it
 * calls re-arms before every statement (`rearmTxDeadline`) without knowing
 * whose deadline it is. A transaction with no deadline is untouched — the
 * same facade reads stay usable everywhere else.
 *
 * Transaction-local (`set_config(…, true)`): the setting dies with the
 * transaction and never leaks onto the pooled connection. A deadline already
 * passed arms 1 ms, so the next statement fails 57014 at once.
 */
const DEADLINES = new WeakMap<object, number>();

export function setTxDeadline(tx: TenantTx, deadlineAt: number): void {
  DEADLINES.set(tx, deadlineAt);
}

export function txDeadlineOf(tx: TenantTx): number | undefined {
  return DEADLINES.get(tx);
}

export async function rearmTxDeadline(tx: TenantTx): Promise<void> {
  const deadlineAt = DEADLINES.get(tx);
  if (deadlineAt === undefined) return;
  const timeoutMs = Math.max(1, deadlineAt - Date.now());
  await tx.execute(sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`);
}
