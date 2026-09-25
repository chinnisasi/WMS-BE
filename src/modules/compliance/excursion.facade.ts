import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { temperatureExcursions } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { canonicalInstant } from '../../shared/primitives/time';
import { ExcursionCommand } from './excursion.command';
import type {
  ExcursionSnapshot,
  RecordExcursionCommand,
  ResolveExcursionCommand,
} from './excursion.command';

/** One excursion row of the excursions-list read (the review queue's read). */
export interface ExcursionEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  /** The origin bin the reading was taken against. */
  readonly binId: string;
  /** The operator-captured reading, °C. */
  readonly readingC: number;
  readonly note: string | null;
  /** The QC holds this excursion quarantined its affected scopes with. */
  readonly holdIds: readonly string[];
  readonly status: 'open' | 'resolved';
  readonly recordedBy: string;
  readonly occurredAt: string;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  /** Row creation time (the keyset cursor field) — part of the read contract. */
  readonly createdAt: string;
}

export interface ListExcursionsQuery {
  readonly warehouseId?: string | undefined;
  readonly status?: 'open' | 'resolved' | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const DEFAULT_EXCURSION_PAGE_SIZE = 50;

/**
 * The cursor is opaque to clients but crafted input is still possible — a
 * base64-valid payload with a non-uuid `id` would otherwise reach the
 * `::uuid` cast in SQL and surface as a 500 instead of a 400 (the shared
 * `decodeCursorSafe` pattern of the other read facades).
 */
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

/**
 * The compliance module's excursion surface (Story 12-5): the api shell's
 * only seam to the record/resolve commands and the excursions-list read —
 * `temperature_excursions` is a compliance-module-exclusive table. The
 * quarantine rides the inbound module's QC facade inside the command and the
 * ledger events ride the inventory facade; this facade only passes commands
 * through and reads its own module's table.
 */
@Injectable()
export class ExcursionFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ExcursionCommand) private readonly excursions: ExcursionCommand,
  ) {}

  /** `excursion record` — the recording command (`excursion.record`). */
  async recordExcursion(
    command: RecordExcursionCommand,
    idempotencyKey: string,
  ): Promise<ExcursionSnapshot> {
    return this.excursions.recordExcursion(command, idempotencyKey);
  }

  /** `excursion resolve` — the review-decision command (`review.decide`). */
  async resolveExcursion(
    command: ResolveExcursionCommand,
    idempotencyKey: string,
  ): Promise<ExcursionSnapshot> {
    return this.excursions.resolveExcursion(command, idempotencyKey);
  }

  /**
   * Excursions-list read: the tenant's temperature excursions, newest first,
   * warehouse- and status-filterable. A read — never capability-gated (the
   * recording mutation is; the review surface hides its buttons behind
   * `review.decide` / `excursion.record`).
   */
  async listExcursions(tenantId: string, query: ListExcursionsQuery = {}): Promise<Page<ExcursionEntry>> {
    const pageSize = query.limit ?? DEFAULT_EXCURSION_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if (query.warehouseId !== undefined) {
        await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      }
      const rows = await tx
        .select()
        .from(temperatureExcursions)
        .where(
          and(
            eq(temperatureExcursions.tenantId, tenantId),
            query.warehouseId === undefined
              ? undefined
              : eq(temperatureExcursions.warehouseId, query.warehouseId),
            query.status === undefined ? undefined : eq(temperatureExcursions.status, query.status),
            before === undefined
              ? undefined
              : sql`(${temperatureExcursions.createdAt}, ${temperatureExcursions.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(temperatureExcursions.createdAt), desc(temperatureExcursions.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        warehouseId: row.warehouseId,
        binId: row.binId,
        // `reading_c` is numeric — postgres.js hands it back as a string;
        // the read edge converts (the boundary rule).
        readingC: Number(row.readingC),
        note: row.note,
        holdIds: row.holdIds,
        status: row.status as ExcursionEntry['status'],
        recordedBy: row.recordedBy,
        occurredAt: canonicalInstant(row.occurredAt),
        resolvedBy: row.resolvedBy,
        resolvedAt: row.resolvedAt === null ? null : canonicalInstant(row.resolvedAt),
        createdAt: canonicalInstant(row.createdAt),
      }));
      return buildPage(items, pageSize);
    });
  }
}