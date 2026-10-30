import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { returnAuthorizations } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
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
  RmaOrigin,
  RmaReviewStatus,
  RmaStatus,
} from './return-authorization.command';
import { ReturnReceiptCommand, openReturnsInTx, receiptsOfRmaInTx } from './return-receipt.command';
import type { OpenReturn, ReceiveReturnCommand, ReturnReceiptResult } from './return-receipt.command';
import { ReturnDispositionCommand } from './return-disposition.command';
import { BlindReturnCommand } from './blind-return.command';
import type { AcceptBlindCommand, BlindAcceptResult, BlindReceiptResult, ReceiveBlindCommand, RejectBlindCommand } from './blind-return.command';
import { RECEIVABLE_RMA_STATUSES } from './return-receipt.command';
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
  AUTHORIZABLE_REASON_CODES,
  BLIND_MATCH_KINDS,
  BLIND_REJECT_REASONS,
  RMA_ORIGINS,
  RMA_REVIEW_STATUSES,
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
  RmaOrigin,
  RmaReviewStatus,
  BlindMatchKind,
  BlindRejectReason,
  AuthorizableReasonCode,
} from './return-authorization.command';
export { BLIND_ENTRY_REFUSALS, MAX_BLIND_REVIEW_NOTE, MAX_PARCEL_REFERENCE } from './blind-return.command';
export type {
  AcceptBlindCommand,
  BlindAcceptResult,
  BlindEntryInput,
  BlindEntryRefusal,
  BlindReceiptResult,
  ReceiveBlindCommand,
  RejectBlindCommand,
} from './blind-return.command';
export { RETURN_BLIND_ACCEPTED_EVENT, RETURN_BLIND_RECORDED_EVENT, RETURN_BLIND_REJECTED_EVENT } from './events';
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
  /** Story 4-7b — only authorized or only blind (unannounced) RMAs. */
  readonly origin?: RmaOrigin | undefined;
  /** Story 4-7b — only blind RMAs in one review state (the Unannounced tab reads `pending`). */
  readonly reviewStatus?: RmaReviewStatus | undefined;
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
    @Inject(BlindReturnCommand) private readonly blind: BlindReturnCommand,
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

  /** Story 4-7b — `return.receive_blind`, the device's unannounced parcel (see `BlindReturnCommand.receive`). */
  receiveBlind(command: ReceiveBlindCommand, idempotencyKey: string): Promise<BlindReceiptResult> {
    return this.blind.receive(command, idempotencyKey);
  }

  /** Story 4-7b — accept an unannounced return at review, optionally linking a dispatched order. */
  acceptBlind(command: AcceptBlindCommand, idempotencyKey: string): Promise<BlindAcceptResult> {
    return this.blind.accept(command, idempotencyKey);
  }

  /** Story 4-7b — reject an unannounced return at review, reversing its booking. */
  rejectBlind(command: RejectBlindCommand, idempotencyKey: string): Promise<RmaDetail> {
    return this.blind.reject(command, idempotencyKey);
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
      openReturnsInTx(tx, { catalog: this.catalog, inventory: this.inventory, outbound: this.outbound }, tenantId, canonicalUuid(warehouseId)),
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
            query.origin === undefined ? undefined : eq(returnAuthorizations.origin, query.origin),
            query.reviewStatus === undefined ? undefined : eq(returnAuthorizations.reviewStatus, query.reviewStatus),
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
        // Story 4-7b — the list always emits origin and review.
        { withReview: true },
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
      const detail = await rmaDetailInTx(tx, this.catalog, tenantId, id, { withReview: true });
      if (detail === null) return null;
      const reviewStatus = detail.reviewStatus ?? null;
      return {
        ...detail,
        receipts: await receiptsOfRmaInTx(tx, this.catalog, tenantId, id, reviewStatus),
        // Story 4-7b — the review card's two read-only facts (detail only).
        ...(detail.origin === 'blind'
          ? {
              openRmasForSuggestedOrder: await this.openRmasOfOrderInTx(tx, tenantId, detail.suggestedOrderId ?? null),
              sameParcelRmas: await this.sameParcelRmasInTx(tx, tenantId, id, detail.parcelReference ?? null),
            }
          : {}),
      };
    });
  }

  /** Story 4-7b — the receivable RMAs of an order (own tables; the card's "an RMA is open for this order"). */
  private async openRmasOfOrderInTx(
    tx: TenantTx,
    tenantId: string,
    orderId: string | null,
  ): Promise<{ id: string; code: string; status: RmaStatus }[]> {
    if (orderId === null) return [];
    const rows = await tx
      .select({ id: returnAuthorizations.id, code: returnAuthorizations.code, status: returnAuthorizations.status })
      .from(returnAuthorizations)
      .where(
        and(
          eq(returnAuthorizations.tenantId, tenantId),
          eq(returnAuthorizations.orderId, orderId),
          inArray(returnAuthorizations.status, [...RECEIVABLE_RMA_STATUSES]),
        ),
      )
      .orderBy(asc(returnAuthorizations.createdAt), asc(returnAuthorizations.id));
    return rows.map((row) => ({ id: row.id, code: row.code, status: row.status as RmaStatus }));
  }

  /** Story 4-7b (A20) — the other blind RMAs received with the same parcel reference, any review state. */
  private async sameParcelRmasInTx(
    tx: TenantTx,
    tenantId: string,
    rmaId: string,
    parcelReference: string | null,
  ): Promise<{ id: string; code: string; reviewStatus: RmaReviewStatus }[]> {
    if (parcelReference === null) return [];
    const rows = await tx
      .select({ id: returnAuthorizations.id, code: returnAuthorizations.code, reviewStatus: returnAuthorizations.reviewStatus })
      .from(returnAuthorizations)
      .where(
        and(
          eq(returnAuthorizations.tenantId, tenantId),
          eq(returnAuthorizations.origin, 'blind'),
          eq(returnAuthorizations.parcelReference, parcelReference),
          ne(returnAuthorizations.id, rmaId),
        ),
      )
      .orderBy(asc(returnAuthorizations.createdAt), asc(returnAuthorizations.id));
    return rows.map((row) => ({ id: row.id, code: row.code, reviewStatus: row.reviewStatus as RmaReviewStatus }));
  }
}
