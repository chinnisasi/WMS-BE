import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { auditEvents } from './schema';
import type { AuditReadTargetType } from '../primitives/audit';
import { ProblemException } from '../problem-details/problem.exception';

/**
 * Story 9-3b — the audit trail's FILTER, shared by its two readers: the
 * owner's paged read (the reporting module's `audit.ts`, its third
 * read-only exception, story 9-3a) and the async export
 * (`modules/tenancy/audit-export.runner.ts`). Moved here from `audit.ts` (the
 * `warehouse-filter.ts` precedent) because tenancy may not import reporting —
 * only the api shell may — and a copied filter would be a second definition
 * free to drift from the first: the export file must equal the paged read
 * for the same filters.
 *
 * Its terms are the audit read's own, guarded by the same block in
 * `test/architecture.spec.ts`: it imports only `auditEvents` from the schema,
 * names no other table in raw SQL, combines it with no second table, and
 * never reads a role. `audit.ts` re-exports every name moved here.
 */

/** `actionPrefix`'s shape — a lowercase dotted action stem (the DTO enforces it; the filter re-checks). */
export const AUDIT_ACTION_PREFIX_RE = /^[a-z][a-z_.-]{0,63}$/;

/** The audit trail's filters — every one optional, combined with AND. */
export interface AuditFilters {
  readonly actorUserId?: string | undefined;
  readonly actionPrefix?: string | undefined;
  readonly targetType?: AuditReadTargetType | undefined;
  readonly targetId?: string | undefined;
  /** `created_at >= from` (inclusive). */
  readonly from?: string | undefined;
  /** `created_at < to` (exclusive — the half-open window, IMPLEMENTATION-GUIDE §7a). */
  readonly to?: string | undefined;
}

/**
 * `LIKE` metacharacters escaped with `\` (the ESCAPE character itself first),
 * so a prefix of `stock_adjustment.` matches only that literal stem — never
 * `stockXadjustment.y`.
 */
export function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The tenant scope plus every given filter, as predicates over
 * `audit_events` (absent filters contribute nothing). Windows are on
 * `created_at` — the server stamp — never `occurred_at`.
 */
export function auditFilterSql(tenantId: string, filters: AuditFilters): SQL[] {
  const prefix = filters.actionPrefix;
  if (prefix !== undefined && !AUDIT_ACTION_PREFIX_RE.test(prefix)) {
    // Unreachable through the routes (the DTO refuses it first) — a caller
    // reaching the filter another way still never builds an unescaped pattern.
    throw new ProblemException('validation-failed', 400, 'Invalid actionPrefix', `actionPrefix must match ${AUDIT_ACTION_PREFIX_RE.source}.`);
  }
  const predicates: (SQL | undefined)[] = [
    eq(auditEvents.tenantId, tenantId),
    filters.actorUserId === undefined ? undefined : eq(auditEvents.actorUserId, filters.actorUserId),
    prefix === undefined ? undefined : sql`${auditEvents.action} like ${escapeLikePrefix(prefix)} || '%' escape '\\'`,
    filters.targetType === undefined ? undefined : eq(auditEvents.targetType, filters.targetType),
    filters.targetId === undefined ? undefined : eq(auditEvents.targetId, filters.targetId),
    filters.from === undefined ? undefined : sql`${auditEvents.createdAt} >= ${filters.from}::timestamptz`,
    filters.to === undefined ? undefined : sql`${auditEvents.createdAt} < ${filters.to}::timestamptz`,
  ];
  return predicates.filter((predicate): predicate is SQL => predicate !== undefined);
}
