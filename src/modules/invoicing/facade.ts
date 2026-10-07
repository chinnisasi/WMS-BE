import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../shared/db/db';
import { DATABASE } from '../../shared/shared.module';
import {
  ewayBills,
  ewayGstinSettings,
  gstStateCodes,
  ewayStateThresholds,
  invoiceLines,
  invoices,
  type Invoice,
  type InvoiceLine,
} from '../../shared/db/schema';
import { assertWarehouseInTenant, tenantGstinsInTx } from '../tenancy/tenancy.service';
import { EWAY_GATEWAY, type EwayGateway } from './eway-gateway';
import {
  EWAY_LIST_DEFAULT_PAGE_SIZE,
  EWAY_LIST_MAX_PAGE_SIZE,
  toEwayBillView,
  viewContextInTx,
  type EwayBillStatus,
  type EwaySource,
  type EwayBillView,
} from './eway-view';
import {
  toGstinSettingView,
  toStateThresholdView,
  type EwayGstinSettingView,
  type EwayStateThresholdView,
} from './eway.command';
import { decodeCursor, encodeCursor } from '../../shared/primitives/pagination';
import { fullPrecisionInstant } from '../../shared/primitives/time';
import type { Page } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import {
  INVOICE_LIST_DEFAULT_PAGE_SIZE,
  INVOICE_LIST_MAX_PAGE_SIZE,
  toInvoiceEntry,
  toInvoiceView,
} from './view';
import type { InvoiceEntry, InvoiceView } from './view';
import { CatalogFacade } from '../catalog/catalog.facade';
import { normalizeStateName, resolveStateCode, type StateCodeEntry } from './generator';
import {
  assertGstinParam,
  hsnSummaryGstinsInTx,
  hsnSummaryInTx,
  parsePeriod,
  type HsnSummaryGstin,
  type HsnSummaryView,
} from './hsn-summary';

/** Story 21-5 — the state-code list as a resolver (`InvoicingFacade.gstStateResolverInTx`). */
export interface GstStateResolver {
  /** The official state name of a two-digit code, or null. */
  nameOf(code: string): string | null;
  /** An address's free-text state resolved to its code (normalised, aliases applied), or null. */
  codeOfText(text: string | null): string | null;
}

/**
 * The invoicing module's read surface (story 8-1): the invoice list, an
 * invoice detail, and the per-order lookup the generate command and the
 * delivery handler resolve. Reads are never capability-gated (the
 * `permissions.ts` rule) — any tenant member may read the tenant's invoices.
 */

export interface ListEwayBillsQuery {
  readonly status?: EwayBillStatus | undefined;
  readonly gstin?: string | undefined;
  /** Story 9-1 — bills of this warehouse's invoices (asserted in-tenant first). */
  readonly warehouseId?: string | undefined;
  /** Story 9-1 — `generated` bills of this source. */
  readonly source?: EwaySource | undefined;
  /** Story 9-1 — `[from, to)` on `created_at` (when the bill was queued). */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface ListInvoicesQuery {
  /** Story 9-1 — one warehouse (asserted in-tenant first). */
  readonly warehouseId?: string | undefined;
  /** Story 9-1 — `[from, to)` on `issued_at` (an awaiting invoice has none, so it never matches a window). */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/**
 * The cursor is opaque to clients but crafted input is still possible — a
 * base64-valid payload with a non-uuid `id` would otherwise reach the
 * `::uuid` cast in SQL and surface as a 500 instead of a 400 (the
 * `decodeCursorSafe` pattern, one per module).
 */
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    if (
      !UUID_RE.test(decoded.id) ||
      !CURSOR_INSTANT_RE.test(decoded.createdAt) ||
      Number.isNaN(Date.parse(decoded.createdAt))
    ) {
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

@Injectable()
export class InvoicingFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(EWAY_GATEWAY) private readonly ewayGateway: EwayGateway,
  ) {}

  /**
   * The e-way bills (story 8-2b), newest first over `(created_at, id)`, at
   * most 50 per page, optionally filtered by status and supplier GSTIN. Each
   * row carries its computed blockers and whether a gateway can generate it.
   * A read — never capability-gated.
   */
  async listEwayBills(tenantId: string, query: ListEwayBillsQuery = {}): Promise<Page<EwayBillView>> {
    const limit = Math.min(query.limit ?? EWAY_LIST_DEFAULT_PAGE_SIZE, EWAY_LIST_MAX_PAGE_SIZE);
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    // GSTINs are stored uppercase (the canonical form): a lowercase filter matches too.
    const gstin = query.gstin === undefined ? undefined : assertGstinParam(query.gstin.trim().toUpperCase());
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if (query.warehouseId !== undefined) {
        await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      }
      const rows = await tx
        .select({ bill: ewayBills, createdAtText: sql<string>`${ewayBills.createdAt}::text` })
        .from(ewayBills)
        .where(
          and(
            eq(ewayBills.tenantId, tenantId),
            query.status === undefined ? undefined : eq(ewayBills.status, query.status),
            gstin === undefined ? undefined : eq(ewayBills.originGstin, gstin),
            // Story 9-1 — a bill has no warehouse column; it belongs to the
            // warehouse of its invoice (table-qualified by hand inside the
            // correlated subquery — outbound Gotcha 9).
            query.warehouseId === undefined
              ? undefined
              : sql`exists (select 1 from invoices inv where inv.tenant_id = ${ewayBills.tenantId} and inv.id = ${ewayBills.invoiceId} and inv.warehouse_id = ${query.warehouseId}::uuid)`,
            query.source === undefined ? undefined : eq(ewayBills.source, query.source),
            query.from === undefined ? undefined : sql`${ewayBills.createdAt} >= ${query.from}::timestamptz`,
            query.to === undefined ? undefined : sql`${ewayBills.createdAt} < ${query.to}::timestamptz`,
            before === undefined
              ? undefined
              : sql`(${ewayBills.createdAt}, ${ewayBills.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(ewayBills.createdAt), desc(ewayBills.id))
        .limit(limit + 1);
      const pageRows = rows.slice(0, limit);
      const ctx = await viewContextInTx(tx, tenantId, pageRows.map((row) => row.bill), this.ewayGateway);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map((row) => toEwayBillView(row.bill, ctx)),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ createdAt: fullPrecisionInstant(last.createdAtText), id: last.bill.id })
            : null,
      };
    });
  }

  /** Every state-threshold override row (append-only history), state then newest first. */
  async listEwayStateThresholds(tenantId: string): Promise<EwayStateThresholdView[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(ewayStateThresholds)
        .where(eq(ewayStateThresholds.tenantId, tenantId))
        .orderBy(
          asc(ewayStateThresholds.stateCode),
          desc(ewayStateThresholds.effectiveFrom),
          desc(ewayStateThresholds.createdAt),
          desc(ewayStateThresholds.id),
        );
      return rows.map(toStateThresholdView);
    });
  }

  /**
   * The e-way settings of every GSTIN the tenant holds (its own and its
   * warehouses'), GSTIN ascending; a GSTIN never set reads `false`.
   */
  async listEwayGstinSettings(tenantId: string): Promise<EwayGstinSettingView[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const owned = await tenantGstinsInTx(tx, tenantId);
      const rows = await tx.select().from(ewayGstinSettings).where(eq(ewayGstinSettings.tenantId, tenantId));
      const byGstin = new Map(rows.map((row) => [row.gstin, toGstinSettingView(row)]));
      const gstins = [...new Set([...owned, ...byGstin.keys()])].sort();
      return gstins.map(
        (gstin) => byGstin.get(gstin) ?? { gstin, eInvoiceApplies: false, updatedBy: null, updatedAt: null },
      );
    });
  }

  /**
   * Story 21-5 — whether e-invoicing (IRN) applies to one of the tenant's
   * GSTINs: the 8-2b per-GSTIN setting (`e_invoice_applies`), false when
   * never set. In the caller's transaction — billing's client-invoice draft
   * raises an `einvoice-required` gap on it (IRN itself is out of scope).
   */
  async eInvoiceAppliesInTx(tx: TenantTx, tenantId: string, gstin: string): Promise<boolean> {
    const rows = await tx
      .select({ applies: ewayGstinSettings.eInvoiceApplies })
      .from(ewayGstinSettings)
      .where(and(eq(ewayGstinSettings.tenantId, tenantId), eq(ewayGstinSettings.gstin, gstin)))
      .limit(1);
    return rows[0]?.applies ?? false;
  }

  /**
   * Story 21-5 — the CBIC state-code list as a resolver, in the caller's
   * transaction: `nameOf(code)` (the official name, or null) and
   * `codeOfText(text)` (an address's free-text state resolved the way the
   * goods invoice resolves it — normalised, aliases applied — or null).
   * Billing's client invoice prints the place of supply by name and code and
   * compares a warehouse's origin state against its GSTIN's state.
   */
  async gstStateResolverInTx(tx: TenantTx): Promise<GstStateResolver> {
    const rows = await tx.select().from(gstStateCodes);
    const byCode = new Map<string, StateCodeEntry>();
    const byName = new Map<string, StateCodeEntry>();
    for (const row of rows) {
      const entry: StateCodeEntry = { stateCode: row.stateCode, stateName: row.stateName };
      byCode.set(entry.stateCode, entry);
      byName.set(normalizeStateName(entry.stateName), entry);
    }
    const noGstin = new Map<string, StateCodeEntry>();
    return {
      nameOf: (code) => byCode.get(code)?.stateName ?? null,
      codeOfText: (text) => resolveStateCode(noGstin, byName, null, text)?.code ?? null,
    };
  }

  /**
   * The HSN summary (story 8-2a) of ONE supplier GSTIN over ONE period —
   * GSTR-1 Table 12's figures over the issued invoices, B2B / B2C. A read
   * (never capability-gated). A malformed `gstin` or `period` is `400
   * validation-failed`; a well-formed GSTIN with nothing issued in the
   * period is an empty summary, not a 404.
   */
  async hsnSummary(tenantId: string, gstin: string, period: string): Promise<HsnSummaryView> {
    const parsedGstin = assertGstinParam(gstin);
    const parsedPeriod = parsePeriod(period);
    // REPEATABLE READ: the summary's three reads (grouped sums, invoice
    // counts, issue lines) must see ONE snapshot — an invoice issued between
    // them under READ COMMITTED would make rows, counts and issue lines disagree.
    return withTenantTransaction(
      this.db,
      tenantId,
      async (tx) =>
        hsnSummaryInTx(tx, tenantId, parsedGstin, parsedPeriod, (codes) => this.catalog.getSkuHsnByCodesInTx(tx, tenantId, codes)),
      { isolationLevel: 'repeatable read' },
    );
  }

  /** Every supplier GSTIN with issued invoices, with its first/last issue instant (story 8-2a). */
  async hsnSummaryGstins(tenantId: string): Promise<HsnSummaryGstin[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => hsnSummaryGstinsInTx(tx, tenantId));
  }

  /** One invoice's detail (row + priced lines), or null. In-tx variant. */
  async getInvoiceInTx(tx: TenantTx, tenantId: string, invoiceId: string): Promise<InvoiceView | null> {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const lines = await this.readLinesInTx(tx, tenantId, row.id);
    return toInvoiceView(row, lines);
  }

  /** The ONE invoice an order carries, or null. In-tx variant. */
  async getInvoiceForOrderInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<InvoiceView | null> {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.orderId, orderId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const lines = await this.readLinesInTx(tx, tenantId, row.id);
    return toInvoiceView(row, lines);
  }

  /** One invoice's detail outside a caller's transaction. */
  async getInvoice(tenantId: string, invoiceId: string): Promise<InvoiceView | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) =>
      this.getInvoiceInTx(tx, tenantId, invoiceId),
    );
  }

  /**
   * The invoice list, newest-first over `(created_at, id)` on the
   * `invoices_tenant_created_at_id_idx` keyset (every other list read's
   * shape). Cursor-paginated — offset pagination is banned (UX-DR25).
   */
  async listInvoices(tenantId: string, query: ListInvoicesQuery = {}): Promise<Page<InvoiceEntry>> {
    const limit = Math.min(query.limit ?? INVOICE_LIST_DEFAULT_PAGE_SIZE, INVOICE_LIST_MAX_PAGE_SIZE);
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if (query.warehouseId !== undefined) {
        await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      }
      // The cursor carries the row's FULL-precision instant (`::text` —
      // the driver's own parse truncates to milliseconds, and a truncated
      // cursor makes the strict keyset `<` skip same-millisecond rows).
      const rows = await tx
        .select({ invoice: invoices, createdAtText: sql<string>`${invoices.createdAt}::text` })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenantId),
            query.warehouseId === undefined ? undefined : eq(invoices.warehouseId, query.warehouseId),
            query.from === undefined ? undefined : sql`${invoices.issuedAt} >= ${query.from}::timestamptz`,
            query.to === undefined ? undefined : sql`${invoices.issuedAt} < ${query.to}::timestamptz`,
            before === undefined
              ? undefined
              : sql`(${invoices.createdAt}, ${invoices.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(invoices.createdAt), desc(invoices.id))
        .limit(limit + 1);
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map((row) => toInvoiceEntry(row.invoice)),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ createdAt: fullPrecisionInstant(last.createdAtText), id: last.invoice.id })
            : null,
      };
    });
  }

  private async readLinesInTx(tx: TenantTx, tenantId: string, invoiceId: string): Promise<InvoiceLine[]> {
    return tx
      .select()
      .from(invoiceLines)
      .where(and(eq(invoiceLines.tenantId, tenantId), eq(invoiceLines.invoiceId, invoiceId)))
      .orderBy(asc(invoiceLines.id));
  }
}

/** The module-internal row type re-export (the facade's own seam, not public). */
export type InvoiceRow = Invoice;