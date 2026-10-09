import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { clientInvoiceLines, clientInvoices, type ClientInvoice } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { CursorPayload, Page } from '../../shared/primitives/pagination';
import { portalPageByCreatedAt } from '../../shared/primitives/portal-page';
import { addIsoDays, istDateOf } from '../../shared/primitives/time';
// Type-only from client-invoices: a value import would close an import
// cycle (client-invoices → metering → billing.facade → here) whose load
// order decides whether a Nest `@Inject` token is defined.
import type { ClientInvoiceParty, ClientInvoiceStatus, ClientInvoiceTotalsView } from './client-invoices';
import { milliToDecimal } from './metering';
import { CHARGE_CODES, type ChargeCode, type RateBasis } from './rate-cards';

const chargeRank = (code: string): number => (CHARGE_CODES as readonly string[]).indexOf(code);

/** The canonical line order — client-invoices.ts `compareLines`, restated (see the import note). */
function compareLines(
  a: { segmentFrom: string; chargeCode: string; uom: string | null },
  b: { segmentFrom: string; chargeCode: string; uom: string | null },
): number {
  const from = Date.parse(a.segmentFrom) - Date.parse(b.segmentFrom);
  if (from !== 0) return from;
  const charge = chargeRank(a.chargeCode) - chargeRank(b.chargeCode);
  if (charge !== 0) return charge;
  if (a.uom === b.uom) return 0;
  if (a.uom === null) return -1;
  if (b.uom === null) return 1;
  return a.uom < b.uom ? -1 : 1;
}

/**
 * Story 21-7 — the client portal's invoice reads (decision 3: the invoice
 * and its lines only — no drill-down, no rate card). An EXACT allowlist of
 * the operator view: no `clientId`, `supplierGstin`, `statusNote` (operator-
 * written), `gaps`, `gapCount`, `warnings`, line `id` or `rateCardId`; the
 * party drops the supplier's `warehouseCode` and the recipient's `code`.
 *
 * Non-draft only, twice over: the transaction is stamped `app.client_id`
 * (the 0062 policy hides drafts from a client-scoped session) AND the query
 * carries `client_id = $client` and `status <> 'draft'`. Lines are inherited
 * and reached ONLY through their (stamped) invoice.
 */
export type PortalInvoiceStatus = Exclude<ClientInvoiceStatus, 'draft'>;

export interface PortalInvoiceRow {
  readonly id: string;
  /** Always set: a non-draft invoice carries its number (the 0062 `client_invoices_numbered` CHECK). */
  readonly invoiceNo: string;
  readonly fyLabel: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: PortalInvoiceStatus;
  readonly issuedAt: string;
  readonly replacesInvoiceId: string | null;
  readonly placeOfSupply: string | null;
  readonly supplyType: string | null;
  readonly totals: ClientInvoiceTotalsView;
}

export interface PortalInvoiceParty {
  readonly supplier: {
    readonly name: string;
    readonly gstin: string | null;
    readonly stateCode: string | null;
    readonly stateName: string | null;
    readonly address: ClientInvoiceParty['supplier']['address'];
  };
  readonly recipient: {
    readonly name: string;
    readonly legalName: string | null;
    readonly gstin: string | null;
    readonly stateCode: string | null;
    readonly stateName: string | null;
    readonly address: ClientInvoiceParty['recipient']['address'];
  };
}

export interface PortalInvoiceLine {
  readonly segmentFrom: string;
  readonly segmentTo: string;
  readonly chargeCode: ChargeCode;
  readonly basis: RateBasis;
  readonly uom: string | null;
  readonly quantity: string;
  readonly unitAmountPaise: number | null;
  readonly amountPaise: number | null;
  readonly sac: string;
  readonly gstBps: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
}

export interface PortalInvoiceDetail extends PortalInvoiceRow {
  readonly party: PortalInvoiceParty;
  readonly lines: readonly PortalInvoiceLine[];
}

/** A non-draft invoice's number/FY/issue stamp — the CHECK guarantees them; a null is a data fault, never a silent null. */
function issuedFact(value: string | null, column: string, invoiceId: string): string {
  if (value === null) throw new Error(`client_invoices.${column} is null on non-draft invoice ${invoiceId}`);
  return value;
}
const numberOrNull = (value: string | number | null): number | null => (value === null ? null : Number(value));

function toRow(row: ClientInvoice): PortalInvoiceRow {
  return {
    id: row.id,
    invoiceNo: issuedFact(row.invoiceNo, 'invoice_no', row.id),
    fyLabel: issuedFact(row.fyLabel, 'fy_label', row.id),
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status as PortalInvoiceStatus,
    issuedAt: new Date(issuedFact(row.issuedAt, 'issued_at', row.id)).toISOString(),
    replacesInvoiceId: row.replacesInvoiceId,
    placeOfSupply: row.placeOfSupply,
    supplyType: row.supplyType,
    totals: {
      subtotal: Number(row.subtotalPaise),
      cgst: Number(row.cgstPaise),
      sgst: Number(row.sgstPaise),
      igst: Number(row.igstPaise),
      tax: Number(row.taxPaise),
      roundOff: Number(row.roundOffPaise),
      payable: Number(row.payablePaise),
    },
  };
}

/** The frozen party, narrowed to the portal's allowlist (rebuilt key by key — never spread). */
function toParty(party: ClientInvoiceParty): PortalInvoiceParty {
  return {
    supplier: {
      name: party.supplier.name,
      gstin: party.supplier.gstin,
      stateCode: party.supplier.stateCode,
      stateName: party.supplier.stateName,
      address:
        party.supplier.address === null
          ? null
          : {
              line1: party.supplier.address.line1,
              line2: party.supplier.address.line2,
              city: party.supplier.address.city,
              state: party.supplier.address.state,
              pincode: party.supplier.address.pincode,
            },
    },
    recipient: {
      name: party.recipient.name,
      legalName: party.recipient.legalName,
      gstin: party.recipient.gstin,
      stateCode: party.recipient.stateCode,
      stateName: party.recipient.stateName,
      address: {
        line1: party.recipient.address.line1,
        line2: party.recipient.address.line2,
        city: party.recipient.address.city,
        stateCode: party.recipient.address.stateCode,
        pincode: party.recipient.address.pincode,
      },
    },
  };
}

function clientScope(tenantId: string, clientId: string) {
  return and(
    eq(clientInvoices.tenantId, tenantId),
    eq(clientInvoices.clientId, clientId),
    ne(clientInvoices.status, 'draft'),
  );
}

export async function portalInvoicesInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  query: { readonly before: CursorPayload | null; readonly limit: number },
): Promise<Page<PortalInvoiceRow>> {
  const rows = await tx
    .select({ row: clientInvoices, createdAtText: sql<string>`${clientInvoices.createdAt}::text` })
    .from(clientInvoices)
    .where(
      and(
        clientScope(tenantId, clientId),
        query.before === null
          ? undefined
          : sql`(${clientInvoices.createdAt}, ${clientInvoices.id}) < (${query.before.createdAt}::timestamptz, ${query.before.id}::uuid)`,
      ),
    )
    .orderBy(desc(clientInvoices.createdAt), desc(clientInvoices.id))
    .limit(query.limit + 1);
  return portalPageByCreatedAt(
    rows.map((item) => ({ id: item.row.id, createdAtText: item.createdAtText, row: item.row })),
    query.limit,
    (item) => toRow(item.row),
  );
}

export async function portalInvoiceInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  invoiceId: string,
): Promise<PortalInvoiceDetail | null> {
  const rows = await tx
    .select()
    .from(clientInvoices)
    .where(and(clientScope(tenantId, clientId), eq(clientInvoices.id, invoiceId)))
    .limit(1);
  const invoice = rows[0];
  if (invoice === undefined) return null;
  const lineRows = await tx
    .select({
      segmentFrom: clientInvoiceLines.segmentFrom,
      segmentTo: clientInvoiceLines.segmentTo,
      chargeCode: clientInvoiceLines.chargeCode,
      basis: clientInvoiceLines.basis,
      uom: clientInvoiceLines.uom,
      quantity: sql<string>`${clientInvoiceLines.quantity}::text`,
      unitAmountPaise: clientInvoiceLines.unitAmountPaise,
      amountPaise: clientInvoiceLines.amountPaise,
      sacCode: clientInvoiceLines.sacCode,
      gstBps: clientInvoiceLines.gstBps,
      cgstPaise: clientInvoiceLines.cgstPaise,
      sgstPaise: clientInvoiceLines.sgstPaise,
      igstPaise: clientInvoiceLines.igstPaise,
    })
    .from(clientInvoiceLines)
    .innerJoin(
      clientInvoices,
      and(eq(clientInvoices.tenantId, clientInvoiceLines.tenantId), eq(clientInvoices.id, clientInvoiceLines.invoiceId)),
    )
    .where(and(eq(clientInvoiceLines.tenantId, tenantId), eq(clientInvoiceLines.invoiceId, invoice.id), clientScope(tenantId, clientId)));
  const lines = lineRows
    .map((row) => ({ ...row, segmentFrom: new Date(row.segmentFrom).toISOString(), segmentTo: new Date(row.segmentTo).toISOString() }))
    .sort(compareLines)
    .map((row) => ({
      segmentFrom: istDateOf(row.segmentFrom),
      segmentTo: addIsoDays(istDateOf(row.segmentTo), -1),
      chargeCode: row.chargeCode as ChargeCode,
      basis: row.basis as RateBasis,
      uom: row.uom,
      quantity: row.chargeCode === 'storage' ? milliToDecimal(BigInt(row.quantity)) : row.quantity,
      unitAmountPaise: numberOrNull(row.unitAmountPaise),
      amountPaise: numberOrNull(row.amountPaise),
      sac: row.sacCode,
      gstBps: row.gstBps,
      cgstPaise: Number(row.cgstPaise),
      sgstPaise: Number(row.sgstPaise),
      igstPaise: Number(row.igstPaise),
    }));
  return { ...toRow(invoice), party: toParty(invoice.party as ClientInvoiceParty), lines };
}
