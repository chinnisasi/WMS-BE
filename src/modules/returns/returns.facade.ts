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
import { ReturnReceiptCommand, openReturnsInTx, receiptsOfRmaInTx } from './return-receipt.command';
import type { OpenReturn, ReceiveReturnCommand, ReturnReceiptResult } from './return-receipt.command';
import { ReturnDispositionCommand } from './return-disposition.command';
import type { DisposeReturnCommand, RestockReturnCommand, ReturnDispositionResult } from './return-disposition.command';
import {
  awaitingDispositionsInTx,
  portalReturnInTx,
  portalReturnsInTx,
  rmaCodesByHoldIdsInTx,
  type AwaitingDispositionRow,
  type PortalDispositionState,
  type PortalReturnDetail,
  type PortalReturnRow,
} from './disposition-reads';
import { PORTAL_PAGE_DEFAULT_LIMIT } from '../../shared/primitives/portal-page';

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
export { RETURN_AUTHORIZATION_CANCELLED_EVENT, RETURN_AUTHORIZATION_CREATED_EVENT, RETURN_RECEIPT_RECORDED_EVENT } from './events';
export {
  MAX_RETURN_NOTE,
  MAX_RETURN_RECEIPT_ENTRIES,
  RETURN_CONDITIONS,
  RETURN_ENTRY_REFUSALS,
} from './return-receipt.command';
export {
  MAX_DISPOSITION_NOTE,
  MAX_RESTOCK_SERIALS,
  RESTOCKABLE_ON_DEVICE,
  RETURN_DISPOSITION_OUTCOMES,
  RETURN_DISPOSITION_REASONS,
} from './return-disposition.command';
export type {
  DisposeReturnCommand,
  RestockReturnCommand,
  ReturnDispositionEntry,
  ReturnDispositionOutcome,
  ReturnDispositionReason,
  ReturnDispositionResult,
} from './return-disposition.command';
export { PORTAL_DISPOSITION_STATES } from './disposition-reads';
export type {
  AwaitingDispositionRow,
  PortalDispositionState,
  PortalReturnDetail,
  PortalReturnDisposition,
  PortalReturnLine,
  PortalReturnRow,
} from './disposition-reads';
export { RETURN_DISPOSITION_RECORDED_EVENT, RETURN_SCRAP_RECORDED_EVENT } from './events';
export type {
  OpenReturn,
  OpenReturnLine,
  ReceiveReturnCommand,
  ReturnCondition,
  ReturnEntryInput,
  ReturnEntryRefusal,
  ReturnReceiptResult,
  ReturnReceiptView,
} from './return-receipt.command';

/** The list's page size: 1–100, default 50 (the house list bounds). */
export const DEFAULT_RMA_PAGE_SIZE = 50;

/** Story 4-7a — the awaiting-disposition queue's query (keyset ASC). */
export interface ListAwaitingQuery {
  readonly warehouseId?: string | undefined;
  readonly clientId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListRmasQuery {
  readonly warehouseId?: string | undefined;
  readonly status?: RmaStatus | undefined;
  readonly orderId?: string | undefined;
  /** Story 1-5a — only one client's return authorizations (an unknown id is an empty page). */
  readonly clientId?: string | undefined;
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
 * - `get` — one authorization with its receipts (13-2), null when absent.
 *
 * Story 13-2 adds `receive` (the device's `return.receive`, delegated to
 * `ReturnReceiptCommand`) and `getOpenReturns` (the catalog snapshot arm).
 */
@Injectable()
export class ReturnsFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ReturnAuthorizationCommand) private readonly command: ReturnAuthorizationCommand,
    @Inject(ReturnReceiptCommand) private readonly receipts: ReturnReceiptCommand,
    @Inject(ReturnDispositionCommand) private readonly dispositions: ReturnDispositionCommand,
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

  /** Story 13-2 — `return.receive`, the device op (see `ReturnReceiptCommand`). */
  receive(command: ReceiveReturnCommand, idempotencyKey: string): Promise<ReturnReceiptResult> {
    return this.receipts.receive(command, idempotencyKey);
  }

  /** Story 4-7a — the web's disposition of one receipt line (see `ReturnDispositionCommand.dispose`). */
  dispose(command: DisposeReturnCommand, idempotencyKey: string): Promise<ReturnDispositionResult> {
    return this.dispositions.dispose(command, idempotencyKey);
  }

  /** Story 4-7a — the handheld's `return.restock` (see `ReturnDispositionCommand.restock`). */
  restock(command: RestockReturnCommand, idempotencyKey: string): Promise<ReturnDispositionResult> {
    return this.dispositions.restock(command, idempotencyKey);
  }

  /**
   * Story 4-7a — the awaiting-disposition queue: receipt lines with units
   * still awaiting a disposition, oldest first. A member-open read (the
   * capability gates the writes; the web shows the actions behind it).
   */
  async listAwaiting(tenantId: string, query: ListAwaitingQuery = {}): Promise<Page<AwaitingDispositionRow>> {
    const limit = query.limit ?? DEFAULT_RMA_PAGE_SIZE;
    const after = query.cursor === undefined ? null : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, (tx) =>
      awaitingDispositionsInTx(tx, this.catalog, tenantId, {
        warehouseId: query.warehouseId === undefined ? undefined : canonicalUuid(query.warehouseId),
        clientId: query.clientId === undefined ? undefined : canonicalUuid(query.clientId),
        after,
        limit,
      }),
    );
  }

  /**
   * Story 4-7a (A14) — the RMA code of each return hold among the named QC
   * holds, in its own transaction: the api shell composes it onto the QC
   * desk's list (QC never reads a returns table).
   */
  async rmaCodesByHoldIds(tenantId: string, holdIds: readonly string[]): Promise<Map<string, string>> {
    if (holdIds.length === 0) return new Map();
    return withTenantTransaction(this.db, tenantId, (tx) => rmaCodesByHoldIdsInTx(tx, tenantId, holdIds));
  }

  /**
   * Story 4-7a — the client portal's returns (decision 11): newest first,
   * each with its disposition totals. Two layers: the client-stamped
   * transaction (RLS) and the `client_id = $client` predicate.
   */
  async portalReturns(
    tenantId: string,
    clientId: string,
    query: { readonly cursor?: string; readonly limit?: number; readonly dispositionState?: PortalDispositionState } = {},
  ): Promise<Page<PortalReturnRow>> {
    const limit = query.limit ?? PORTAL_PAGE_DEFAULT_LIMIT;
    const before = query.cursor === undefined ? null : decodeCursorSafe(query.cursor);
    return withTenantTransaction(
      this.db,
      tenantId,
      (tx) => portalReturnsInTx(tx, tenantId, clientId, { before, limit, dispositionState: query.dispositionState }),
      { clientId },
    );
  }

  /** Story 4-7a — one of the client's returns (null: unknown or another client's — the same 404). */
  async portalReturn(tenantId: string, clientId: string, rmaId: string): Promise<PortalReturnDetail | null> {
    return withTenantTransaction(this.db, tenantId, (tx) => portalReturnInTx(tx, this.catalog, tenantId, clientId, canonicalUuid(rmaId)), {
      clientId,
    });
  }

  /**
   * Story 13-2 — the device catalog snapshot's `openReturns` arm: the
   * warehouse's RMAs in `open` / `partially_received`, in their own tenant
   * transaction (a plain facade call the api shell composes beside the task
   * lists — never nested inside another facade's transaction).
   */
  async getOpenReturns(tenantId: string, warehouseId: string): Promise<OpenReturn[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      openReturnsInTx(tx, { catalog: this.catalog, inventory: this.inventory }, tenantId, canonicalUuid(warehouseId)),
    );
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
            query.clientId === undefined ? undefined : eq(returnAuthorizations.clientId, canonicalUuid(query.clientId)),
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

  /**
   * One authorization — story 13-2: WITH its receipts (each line's grade,
   * note, batch, serial and case weight, the operator's email). Receipts
   * ride only here, never on the list (design review #20), and never on a
   * command's stored snapshot — `receipts` is optional on `RmaDetail`, so a
   * pre-13-2 snapshot still serves.
   */
  async get(tenantId: string, rmaId: string): Promise<RmaDetail | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const id = canonicalUuid(rmaId);
      const detail = await rmaDetailInTx(tx, this.catalog, tenantId, id);
      if (detail === null) return null;
      return { ...detail, receipts: await receiptsOfRmaInTx(tx, this.catalog, tenantId, id) };
    });
  }
}
