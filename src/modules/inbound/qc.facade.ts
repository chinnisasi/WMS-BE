import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { qcHolds } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { canonicalInstant } from '../../shared/primitives/time';
import { QcCommand } from './qc.command';
import type {
  PlaceQcHoldCommand,
  QcHoldSnapshot,
  ReleaseQcHoldCommand,
} from './qc.command';

/** One QC-hold row of the holds-list read (the release/hold history cards). */
export interface QcHoldEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  /** The origin bin — captured at hold time; release returns the stock here. */
  readonly binId: string;
  readonly reason: string;
  readonly status: 'open' | 'released';
  readonly heldBy: string;
  readonly heldAt: string;
  readonly releasedBy: string | null;
  readonly releasedAt: string | null;
  /** Row creation time (the keyset cursor field) — part of the read contract. */
  readonly createdAt: string;
}

export interface ListQcHoldsQuery {
  readonly warehouseId?: string | undefined;
  readonly status?: 'open' | 'released' | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const DEFAULT_QC_PAGE_SIZE = 50;

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
 * The inbound module's QC-hold surface (Story 3.4): the api shell's only seam
 * to the hold/release commands and the holds-list read — `qc_holds` is an
 * inbound-module-exclusive table. The movements ride the inventory facade
 * inside the command; this facade only passes commands through and reads its
 * own module's table.
 */
@Injectable()
export class QcFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QcCommand) private readonly qc: QcCommand,
  ) {}

  /** `qc-holds.place` — the Ops Manager quarantine command (`qc.manage`). */
  async placeHold(command: PlaceQcHoldCommand, idempotencyKey: string): Promise<QcHoldSnapshot> {
    return this.qc.placeHold(command, idempotencyKey);
  }

  /** `qc-holds/:id/release` — the Ops Manager release command (`qc.manage`). */
  async releaseHold(command: ReleaseQcHoldCommand, idempotencyKey: string): Promise<QcHoldSnapshot> {
    return this.qc.releaseHold(command, idempotencyKey);
  }

  /**
   * Holds-list read: the tenant's QC holds, newest first, warehouse- and
   * status-filterable. A read — never capability-gated (the placing/release
   * mutations are; the surface hides the buttons behind `qc.manage`).
   */
  async listQcHolds(tenantId: string, query: ListQcHoldsQuery = {}): Promise<Page<QcHoldEntry>> {
    const pageSize = query.limit ?? DEFAULT_QC_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if (query.warehouseId !== undefined) {
        await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      }
      const rows = await tx
        .select()
        .from(qcHolds)
        .where(
          and(
            eq(qcHolds.tenantId, tenantId),
            query.warehouseId === undefined
              ? undefined
              : eq(qcHolds.warehouseId, query.warehouseId),
            query.status === undefined ? undefined : eq(qcHolds.status, query.status),
            before === undefined
              ? undefined
              : sql`(${qcHolds.createdAt}, ${qcHolds.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(qcHolds.createdAt), desc(qcHolds.id))
        .limit(pageSize + 1);
      const items = rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        warehouseId: row.warehouseId,
        skuId: row.skuId,
        binId: row.binId,
        reason: row.reason,
        status: row.status as QcHoldEntry['status'],
        heldBy: row.heldBy,
        heldAt: canonicalInstant(row.heldAt),
        releasedBy: row.releasedBy,
        releasedAt: row.releasedAt === null ? null : canonicalInstant(row.releasedAt),
        createdAt: canonicalInstant(row.createdAt),
      }));
      return buildPage(items, pageSize);
    });
  }
}