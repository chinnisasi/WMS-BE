import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { returnAuthorizations } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import type { Page } from '../../shared/primitives/pagination';
import { fullPrecisionInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { CatalogFacade } from '../catalog/catalog.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import {
  ReturnAuthorizationCommand,
  canonicalUuid,
  orderNotFound,
  readReturnableInTx,
  rmaDetailInTx,
  rmaDetailsInTx,
} from './return-authorization.command';
import type {
  CancelRmaCommand,
  CreateRmaCommand,
  ReturnableOrder,
  RmaDetail,
  RmaStatus,
} from './return-authorization.command';

export {
  MAX_RMA_EXTERNAL_REFERENCE,
  MAX_RMA_LINES,
  MAX_RMA_NOTE,
  MAX_RMA_SERIALS_PER_LINE,
  MAX_RMA_SERIALS_PER_REQUEST,
  RETURN_REASON_CODES,
  RMA_STATUSES,
  rmaOrderLockKey,
} from './return-authorization.command';
export type {
  CancelRmaCommand,
  CreateRmaCommand,
  ReturnableLine,
  ReturnableOrder,
  ReturnReasonCode,
  RmaDetail,
  RmaLineSnapshot,
  RmaSerial,
  RmaStatus,
} from './return-authorization.command';
export { RETURN_AUTHORIZATION_CANCELLED_EVENT, RETURN_AUTHORIZATION_CREATED_EVENT } from './events';

/** The list's page size: 1–100, default 50 (the house list bounds). */
export const DEFAULT_RMA_PAGE_SIZE = 50;

export interface ListRmasQuery {
  readonly warehouseId?: string | undefined;
  readonly status?: RmaStatus | undefined;
  readonly orderId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** The opaque keyset cursor, validated so a crafted payload is a 400, never a cast 500. */
function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    if (!UUID_RE.test(decoded.id) || !CURSOR_INSTANT_RE.test(decoded.createdAt) || Number.isNaN(Date.parse(decoded.createdAt))) {
      throw new Error('malformed cursor payload');
    }
    return decoded;
  } catch {
    throw new ProblemException('invalid-cursor', 400, 'Malformed pagination cursor', 'The cursor parameter is not a valid opaque page cursor.');
  }
}

/**
 * The returns module's seam (story 13-1) — its only export. The two commands
 * delegate to `ReturnAuthorizationCommand`; the reads are member-open (every
 * read is — the capability gates the writes only) and run in their own
 * tenant transaction:
 *
 * - `returnable` — one order's lines with dispatched / authorized /
 *   returnable quantities and, for a serial-tracked line, the returnable
 *   serials. Computed from the outbound, catalog and inventory facades plus
 *   this module's own rows — never stored (a stored figure would be a second
 *   source of truth). A non-dispatched order answers with its status and
 *   zero everywhere rather than a refusal;
 * - `list` — newest first, keyset `(created_at, id)` DESC on the
 *   full-precision instant, optionally one warehouse (tenant-wide without
 *   it), one status, one order;
 * - `get` — one authorization, null when absent.
 */
@Injectable()
export class ReturnsFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ReturnAuthorizationCommand) private readonly command: ReturnAuthorizationCommand,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  create(command: CreateRmaCommand, idempotencyKey: string): Promise<RmaDetail> {
    return this.command.create(command, idempotencyKey);
  }

  cancel(command: CancelRmaCommand, idempotencyKey: string): Promise<RmaDetail> {
    return this.command.cancel(command, idempotencyKey);
  }

  /** One order's returnable read; 404 `not-found` when the order is unknown. */
  async returnable(tenantId: string, rawOrderId: string): Promise<ReturnableOrder> {
    const orderId = canonicalUuid(rawOrderId);
    const read = await withTenantTransaction(this.db, tenantId, (tx) =>
      readReturnableInTx(tx, { outbound: this.outbound, catalog: this.catalog, inventory: this.inventory }, tenantId, orderId),
    );
    if (read === null) {
      throw orderNotFound(orderId);
    }
    return read;
  }

  async list(tenantId: string, query: ListRmasQuery = {}): Promise<Page<RmaDetail>> {
    const pageSize = query.limit ?? DEFAULT_RMA_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ header: returnAuthorizations, createdAtText: sql<string>`${returnAuthorizations.createdAt}::text` })
        .from(returnAuthorizations)
        .where(
          and(
            eq(returnAuthorizations.tenantId, tenantId),
            query.warehouseId === undefined ? undefined : eq(returnAuthorizations.warehouseId, canonicalUuid(query.warehouseId)),
            query.status === undefined ? undefined : eq(returnAuthorizations.status, query.status),
            query.orderId === undefined ? undefined : eq(returnAuthorizations.orderId, canonicalUuid(query.orderId)),
            before === undefined
              ? undefined
              : sql`(${returnAuthorizations.createdAt}, ${returnAuthorizations.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(returnAuthorizations.createdAt), desc(returnAuthorizations.id))
        .limit(pageSize + 1);
      const details = await rmaDetailsInTx(
        tx,
        this.catalog,
        tenantId,
        rows.map((row) => row.header),
      );
      const page = buildPage(
        details.map((detail, index) => ({ createdAt: fullPrecisionInstant(rows[index]!.createdAtText), id: detail.id, detail })),
        pageSize,
      );
      return { items: page.items.map((wrapped) => wrapped.detail), nextCursor: page.nextCursor };
    });
  }

  async get(tenantId: string, rmaId: string): Promise<RmaDetail | null> {
    return withTenantTransaction(this.db, tenantId, (tx) => rmaDetailInTx(tx, this.catalog, tenantId, canonicalUuid(rmaId)));
  }
}
