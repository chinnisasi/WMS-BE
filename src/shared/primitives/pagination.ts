/**
 * Cursor pagination primitive (AD-9). Every list endpoint in the system uses
 * opaque cursors — offset/limit pagination and infinite scroll are banned
 * (UX-DR25). A cursor is a base64url-encoded keyset bound to a stable sort
 * column (created_at + id tiebreaker for UUIDv7 ordering).
 */

export interface CursorPayload {
  readonly createdAt: string; // ISO-8601 UTC
  readonly id: string; // UUIDv7 tiebreaker
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  const json = Buffer.from(cursor, 'base64url').toString('utf8');
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as CursorPayload).createdAt !== 'string' ||
    typeof (parsed as CursorPayload).id !== 'string'
  ) {
    throw new Error('Malformed pagination cursor');
  }
  return parsed as CursorPayload;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Cursor to fetch the next page; null when no more rows exist. */
  readonly nextCursor: string | null;
}

/**
 * Builds a page from a fetched batch. Fetch `limit + 1` rows and pass them;
 * the extra row tells us there is a next page without a count query.
 */
export function buildPage<T extends { createdAt: string; id: string }>(
  rows: readonly T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}