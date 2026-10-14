import { and, desc, sql } from 'drizzle-orm';
import { auditEvents } from '../../shared/db/schema';
import { auditFilterSql } from '../../shared/db/audit-filter';
import type { AuditFilters } from '../../shared/db/audit-filter';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { SYSTEM_ACTOR_ID } from '../../shared/primitives/audit';
import { UUID_RE } from '../../shared/primitives/ids';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import type { Page } from '../../shared/primitives/pagination';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * Story 9-3a — the audit trail read (FR-28), reporting's THIRD read-only
 * exception (IMPLEMENTATION-GUIDE §7a, human decision 2026-10-12).
 *
 * Its terms, each guarded by `test/architecture.spec.ts` ("the audit read is
 * the third read-only exception"):
 *  - it reads `audit_events` ONLY: this file imports `auditEvents` and no
 *    other table from the schema, names no other table in raw SQL, and
 *    combines it with no second table;
 *  - it writes nothing and owns no table (the directory-wide reporting
 *    guards);
 *  - the role check (`audit.view`, owner-only) is NOT here — it runs in the
 *    facade, in its own transaction, before this read starts, so this file
 *    never touches `users`.
 *
 * Ordering, paging and windows use `created_at` — the server's commit stamp —
 * never `occurred_at`: some writers stamp `occurred_at` from command or
 * device time (putaway, sync resolve, excursion), and paging on a column a
 * device can set hours in the past would break the cursor and the window.
 */

/** The page size when the request names none, and the ceiling (the DTO bounds it too). */
export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;

/** The whole read's budget: past it the route answers 503 `report-unavailable` (the 21-8 pattern). */
export const AUDIT_STATEMENT_TIMEOUT_MS = 5000;

// Story 9-3b: the filter moved to `shared/db/audit-filter.ts` (the export
// reads the same rows); re-exported so existing importers are unchanged.
export { AUDIT_ACTION_PREFIX_RE, escapeLikePrefix } from '../../shared/db/audit-filter';
export type { AuditFilters } from '../../shared/db/audit-filter';

export interface AuditTrailQuery extends AuditFilters {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export type AuditActorKind = 'user' | 'system';

export interface AuditTrailEntry {
  readonly id: string;
  /** `created_at` — when the server recorded the action (the ordering column). */
  readonly recordedAt: string;
  /** `occurred_at` — the action's own time (server time for every 9-3a row; device or command time for a few older writers). */
  readonly occurredAt: string;
  readonly actorUserId: string;
  /** `'system'` when the actor is the reserved `SYSTEM_ACTOR_ID`, else `'user'`. */
  readonly actorKind: AuditActorKind;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
}

function invalidCursor(): ProblemException {
  return new ProblemException(
    'invalid-cursor',
    400,
    'Malformed pagination cursor',
    'The cursor parameter is not a valid opaque page cursor.',
  );
}

const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeAuditCursor(cursor: string): { createdAt: string; id: string } {
  let decoded: { createdAt: string; id: string };
  try {
    decoded = decodeCursor(cursor);
  } catch {
    throw invalidCursor();
  }
  if (!UUID_RE.test(decoded.id) || !CURSOR_INSTANT_RE.test(decoded.createdAt)) {
    throw invalidCursor();
  }
  return decoded;
}

/** One page of the tenant's audit trail, newest recorded first. Reads `audit_events` only. */
export async function readAuditPageInTx(
  tx: TenantTx,
  tenantId: string,
  query: AuditTrailQuery,
): Promise<Page<AuditTrailEntry>> {
  const limit = Math.min(Math.max(query.limit ?? AUDIT_DEFAULT_LIMIT, 1), AUDIT_MAX_LIMIT);
  const before = query.cursor === undefined ? undefined : decodeAuditCursor(query.cursor);
  const filters = [
    ...auditFilterSql(tenantId, query),
    before === undefined
      ? undefined
      : sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
  ];
  const rows = await tx
    .select({
      id: auditEvents.id,
      actorUserId: auditEvents.actorUserId,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      occurredAt: auditEvents.occurredAt,
      createdAt: auditEvents.createdAt,
      // The cursor needs the raw `::text` instant (the inventory.facade
      // precedent): every row a transaction writes shares its `now()` to the
      // microsecond, and a millisecond-truncated cursor's strict `<` would
      // skip the rest of that tie group on the next page.
      createdAtText: sql<string>`${auditEvents.createdAt}::text`,
    })
    .from(auditEvents)
    .where(and(...filters))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit + 1);

  const page = buildPage(
    rows.map((row) => ({
      createdAt: fullPrecisionInstant(row.createdAtText),
      id: row.id,
      entry: {
        id: row.id,
        recordedAt: canonicalInstant(row.createdAt),
        occurredAt: canonicalInstant(row.occurredAt),
        actorUserId: row.actorUserId,
        actorKind: row.actorUserId === SYSTEM_ACTOR_ID ? ('system' as const) : ('user' as const),
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
      },
    })),
    limit,
  );
  return { items: page.items.map((wrapped) => wrapped.entry), nextCursor: page.nextCursor };
}

/** Arms the transaction-local timeout for the whole read (it dies with the transaction). */
export async function armAuditDeadline(tx: TenantTx): Promise<void> {
  await tx.execute(sql`select set_config('statement_timeout', ${String(AUDIT_STATEMENT_TIMEOUT_MS)}, true)`);
}
