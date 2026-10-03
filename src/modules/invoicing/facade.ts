import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../shared/db/db';
import { DATABASE } from '../../shared/shared.module';
import { invoiceLines, invoices, type Invoice, type InvoiceLine } from '../../shared/db/schema';
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

/**
 * The invoicing module's read surface (story 8-1): the invoice list, an
 * invoice detail, and the per-order lookup the generate command and the
 * delivery handler resolve. Reads are never capability-gated (the
 * `permissions.ts` rule) — any tenant member may read the tenant's invoices.
 */

export interface ListInvoicesQuery {
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
  constructor(@Inject(DATABASE) private readonly db: Database) {}

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
      // The cursor carries the row's FULL-precision instant (`::text` —
      // the driver's own parse truncates to milliseconds, and a truncated
      // cursor makes the strict keyset `<` skip same-millisecond rows).
      const rows = await tx
        .select({ invoice: invoices, createdAtText: sql<string>`${invoices.createdAt}::text` })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenantId),
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