import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { notificationReads, notifications } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import {
  NOTIFICATION_SOURCE_TYPES,
  visibleSourceTypes,
  type NotificationSourceType,
  type NotificationSummary,
} from './notification-sources';

export const DEFAULT_NOTIFICATION_PAGE_SIZE = 25;
export const MAX_NOTIFICATION_PAGE_SIZE = 100;

/** One panel entry, as the API serves it. */
export interface NotificationEntry {
  readonly id: string;
  readonly sourceType: NotificationSourceType;
  readonly sourceId: string;
  readonly warehouseId: string | null;
  readonly summary: NotificationSummary;
  readonly raisedAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
}

export interface NotificationPage {
  readonly items: readonly NotificationEntry[];
  readonly nextCursor: string | null;
}

export interface NotificationStatus {
  readonly hasNew: boolean;
}

/** The cursor's instant shape (the other read facades' local const). */
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    const malformedCursor =
      !UUID_RE.test(decoded.id) ||
      !CURSOR_INSTANT_RE.test(decoded.createdAt) ||
      Number.isNaN(Date.parse(decoded.createdAt));
    if (malformedCursor) {
      throw new Error('malformed cursor payload');
    }
    return decoded;
  } catch {
    throw new ProblemException(
      'invalid-cursor',
      400,
      'Malformed pagination cursor',
      'The cursor parameter is not a valid opaque page cursor.',
    );
  }
}

const KNOWN_SOURCE_TYPES: ReadonlySet<string> = new Set(NOTIFICATION_SOURCE_TYPES);

/**
 * Story 9-2 — the notification panel's reads and the one write a reader
 * makes (its last-opened time). Every method re-reads the caller's role in
 * its own tenant transaction (the role is never taken from the token) and
 * maps it through `ROLE_CAPABILITIES` to the source types it may see: a
 * member sees only the entries it holds the capability to act on, and a
 * role that can act on none gets an empty list and no dot.
 *
 * Tombstones (a resolve that arrived before its raise — `summary` null) are
 * never served.
 */
@Injectable()
export class NotificationsFacade {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Visible entries, newest `(raised_at, id)` first, keyset-paged. */
  async list(
    tenantId: string,
    userId: string,
    query: { readonly cursor?: string | undefined; readonly limit?: number | undefined } = {},
  ): Promise<NotificationPage> {
    const pageSize = query.limit ?? DEFAULT_NOTIFICATION_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const visible = visibleSourceTypes(await getMemberRoleIn(tx, tenantId, userId));
      if (visible.length === 0) {
        return { items: [], nextCursor: null };
      }
      const rows = await tx
        .select({
          row: notifications,
          // The CURSOR needs the raw `::text` instant — the driver's parse
          // truncates to milliseconds, and a truncated cursor's strict `<`
          // would skip the tail of a tie group (`fullPrecisionInstant`).
          raisedAtText: sql<string>`${notifications.raisedAt}::text`,
        })
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            inArray(notifications.sourceType, visible),
            isNotNull(notifications.summary),
            before === undefined
              ? undefined
              : sql`(${notifications.raisedAt}, ${notifications.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        // `nulls last` on both keys: exactly the 0067 index's order
        // (`raised_at DESC NULLS LAST, id DESC NULLS LAST`), so the index
        // serves the page — a bare `desc` means NULLS FIRST and does not match.
        .orderBy(sql`${notifications.raisedAt} desc nulls last`, sql`${notifications.id} desc nulls last`)
        .limit(pageSize + 1);
      const page = buildPage(
        rows.map((wrapped) => ({
          createdAt: fullPrecisionInstant(wrapped.raisedAtText),
          id: wrapped.row.id,
          entry: toEntry(wrapped.row),
        })),
        pageSize,
      );
      return { items: page.items.map((wrapped) => wrapped.entry), nextCursor: page.nextCursor };
    });
  }

  /**
   * The bell's dot: true iff a visible, non-tombstone, OPEN entry surfaced
   * after the caller's last panel open — or the caller has never opened the
   * panel (no read row) and such an open entry exists. Resolved entries
   * never light it, so a first-time member with only resolved history sees
   * no dot.
   */
  async status(tenantId: string, userId: string): Promise<NotificationStatus> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const visible = visibleSourceTypes(await getMemberRoleIn(tx, tenantId, userId));
      if (visible.length === 0) {
        return { hasNew: false };
      }
      const rows = await tx
        .select({ hasNew: sql<boolean>`true` })
        .from(notifications)
        .leftJoin(
          notificationReads,
          and(eq(notificationReads.tenantId, notifications.tenantId), eq(notificationReads.userId, userId)),
        )
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            inArray(notifications.sourceType, visible),
            isNotNull(notifications.summary),
            sql`${notifications.resolvedAt} is null`,
            sql`(${notificationReads.lastOpenedAt} is null or ${notifications.surfacedAt} > ${notificationReads.lastOpenedAt})`,
          ),
        )
        .limit(1);
      return { hasNew: rows.length > 0 };
    });
  }

  /**
   * The caller opened the panel: `last_opened_at = now()` (upserted). Setting
   * a time to now is naturally idempotent, so — the one exception among the
   * mutating routes — it takes no `Idempotency-Key`. Any member may call it
   * (a role that sees nothing just records an open).
   */
  async opened(tenantId: string, userId: string): Promise<NotificationStatus> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // Membership is still re-read: a removed user records nothing.
      await getMemberRoleIn(tx, tenantId, userId);
      await tx
        .insert(notificationReads)
        .values({ tenantId, userId, lastOpenedAt: sql`now()` })
        .onConflictDoUpdate({
          target: [notificationReads.tenantId, notificationReads.userId],
          set: { lastOpenedAt: sql`now()` },
        });
      return { hasNew: false };
    });
  }
}

function toEntry(row: typeof notifications.$inferSelect): NotificationEntry {
  if (!KNOWN_SOURCE_TYPES.has(row.sourceType) || row.summary === null || row.raisedAt === null) {
    // The CHECKs make both impossible; the read is filtered on them anyway.
    throw new Error(`notification ${row.id} is not a servable entry`);
  }
  return {
    id: row.id,
    sourceType: row.sourceType as NotificationSourceType,
    sourceId: row.sourceId,
    warehouseId: row.warehouseId,
    summary: row.summary as unknown as NotificationSummary,
    raisedAt: canonicalInstant(row.raisedAt),
    resolvedAt: row.resolvedAt === null ? null : canonicalInstant(row.resolvedAt),
    resolution: row.resolution,
  };
}
