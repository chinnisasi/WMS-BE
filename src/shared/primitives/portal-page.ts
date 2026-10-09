/**
 * Story 21-7 — the client-portal read conventions every owning module's
 * portal read shares: the page bounds (the controller's DTO enforces them;
 * the facade defaults) and the `(created_at desc, id)` page builder over a
 * FULL-precision cursor instant (a millisecond-truncated cursor skips
 * same-millisecond rows — the 9-1 rule).
 */
import { encodeCursor } from './pagination';
import type { Page } from './pagination';
import { fullPrecisionInstant } from './time';

export const PORTAL_PAGE_DEFAULT_LIMIT = 50;
export const PORTAL_PAGE_MAX_LIMIT = 100;

export interface PortalPageQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * One page from `limit + 1` fetched rows, each carrying its own
 * `createdAt::text` (`createdAtText`) for the cursor. `toItem` maps a kept
 * row to its response shape.
 */
export function portalPageByCreatedAt<R extends { id: string; createdAtText: string }, T>(
  rows: readonly R[],
  limit: number,
  toItem: (row: R) => T,
): Page<T> {
  const kept = rows.slice(0, limit);
  const last = kept.at(-1);
  return {
    items: kept.map(toItem),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ createdAt: fullPrecisionInstant(last.createdAtText), id: last.id })
        : null,
  };
}
