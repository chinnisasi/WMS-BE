import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { GAP_KINDS, INVOICE_STATUSES, RATE_SOURCES } from '../modules/invoicing/generator';
import type { GapKind, InvoiceStatus, RateSource } from '../modules/invoicing/generator';
import { INVOICE_LIST_MAX_PAGE_SIZE } from '../modules/invoicing/view';
import { HSN_PERIOD_KINDS, HSN_PERIOD_SHAPE_RE, HSN_SECTIONS } from '../modules/invoicing/hsn-summary';
import type { HsnPeriodKind, HsnSection } from '../modules/invoicing/hsn-summary';
import { UQCS } from '../modules/invoicing/uqc';
import type { Uqc } from '../modules/invoicing/uqc';
import { GSTIN_RE } from '../shared/primitives/gstin';

/**
 * Upper bound on the rate overrides one generate call carries — an order's
 * line count is itself bounded at create, so this is a request-size guard,
 * not a business rule.
 */
const MAX_RATE_OVERRIDES = 500;

// ── generate / regenerate input ──────────────────────────────────────────────

/** One per-line rate override (the manual pricing arm, story 8-1). */
export class InvoiceRateInputDto {
  @ApiProperty({ format: 'uuid', description: 'The order line being priced (must be a line of this order)' })
  @IsUUID()
  orderLineId!: string;

  @ApiProperty({
    description:
      "The line's rate in integer PAISE per the SKU's base UoM — frozen into the invoice document (rateSource 'manual'); order_lines.rate_paise is never written",
    minimum: 0,
    example: 12500,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  ratePaise!: number;
}

/** POST /tenants/{tenantId}/invoices body (tenant session, `invoice.generate`). */
export class GenerateInvoiceDto {
  @ApiProperty({ format: 'uuid', description: 'The dispatched order to invoice (one invoice per order)' })
  @IsUUID()
  orderId!: string;

  @ApiProperty({
    required: false,
    type: [InvoiceRateInputDto],
    description:
      'Per-line rate overrides for UNPRICED lines only — a line priced at order acceptance keeps that frozen rate (an override naming it is refused 409 line-already-priced). Omit for a plain regenerate — manual rates already carried by the invoice hold.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RATE_OVERRIDES)
  @ValidateNested({ each: true })
  @Type(() => InvoiceRateInputDto)
  rates?: InvoiceRateInputDto[];
}

export class InvoiceListQuery {
  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: INVOICE_LIST_MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INVOICE_LIST_MAX_PAGE_SIZE)
  limit?: number;
}

// ── responses ────────────────────────────────────────────────────────────────

export class InvoiceLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ description: 'SKU code snapshot at generation' })
  skuCode!: string;

  @ApiProperty({ description: 'SKU name snapshot at generation' })
  skuName!: string;

  @ApiProperty({ type: String, nullable: true, description: 'HSN snapshot; null is the hsn-gap warning' })
  hsn!: string | null;

  @ApiProperty({ description: 'Dispatched quantity in milli-units of the base UoM (re-derived from picks)' })
  qtyMilli!: number;

  @ApiProperty({ description: 'Rate in paise per base unit' })
  ratePaise!: number;

  @ApiProperty({ enum: RATE_SOURCES, description: "'order_line' = frozen at order acceptance; 'manual' = operator override" })
  rateSource!: RateSource;

  @ApiProperty({ description: 'Taxable value, paise (half-up at the line boundary)' })
  taxablePaise!: number;

  @ApiProperty({ description: 'GST rate in basis points (1800 = 18%)' })
  gstBps!: number;

  @ApiProperty({ description: 'CGST, paise (intra-state only)' })
  cgstPaise!: number;

  @ApiProperty({ description: 'SGST/UTGST, paise (intra-state only; carries the odd remainder paise)' })
  sgstPaise!: number;

  @ApiProperty({ description: 'IGST, paise (inter-state only)' })
  igstPaise!: number;

  @ApiProperty()
  hsnGap!: boolean;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  createdAt!: string;
}

/** One header row of the invoice list. */
export class InvoiceEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The supplier GSTIN's own FY-series number, e.g. '29/2627/000001' (state code / FY digits / sequence; 8-1 invoices keep their 'FY-2627-000001' form); null until first issued. Unique per (tenant, originGstin) — never key on it alone",
  })
  invoiceNo!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "e.g. 'FY-2627'; null until first issued" })
  fyLabel!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Supplier GSTIN the invoice is issued under (its numbering series); null while unresolved' })
  originGstin!: string | null;

  @ApiProperty({ enum: INVOICE_STATUSES })
  status!: InvoiceStatus;

  @ApiProperty({ type: String, nullable: true, enum: ['intra', 'inter'], description: 'null while place of supply is unresolved' })
  supplyType!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Two-digit GST state code; null while unresolved' })
  placeOfSupply!: string | null;

  @ApiProperty({ description: 'Sum of line taxable values, paise' })
  subtotalPaise!: number;

  @ApiProperty({ description: 'Sum of line CGST+SGST+IGST, paise' })
  gstPaise!: number;

  @ApiProperty({ description: 'subtotal + gst, paise (exact)' })
  totalPaise!: number;

  @ApiProperty({ description: 'The amount due, rounded half-up to the whole rupee (paise, a multiple of 100)' })
  payablePaise!: number;

  @ApiProperty({ description: 'payablePaise − totalPaise: the signed round-off, −49…+50 paise' })
  roundOffPaise!: number;

  @ApiProperty({ description: 'Bumps only when a regenerate changes the content' })
  revision!: number;

  @ApiProperty({ enum: GAP_KINDS, isArray: true, description: 'Distinct gap kinds in the document (blocking and warning)' })
  gapKinds!: GapKind[];

  @ApiProperty({ description: 'Row creation time (the keyset cursor field), ISO-8601 UTC' })
  createdAt!: string;
}

/** One invoice's full detail: the row, its priced lines, and the document snapshot. */
export class InvoiceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ type: String, nullable: true })
  invoiceNo!: string | null;

  @ApiProperty({ type: String, nullable: true })
  fyLabel!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: "Position in the supplier GSTIN's FY series; null until first issued" })
  seriesSeq!: number | null;

  @ApiProperty({ enum: INVOICE_STATUSES })
  status!: InvoiceStatus;

  @ApiProperty({ type: String, nullable: true, description: 'Supplier GSTIN snapshot (warehouse, else tenant)' })
  originGstin!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Consignee GSTIN snapshot; null for B2C' })
  consigneeGstin!: string | null;

  @ApiProperty({ type: String, nullable: true })
  placeOfSupply!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: ['intra', 'inter'] })
  supplyType!: string | null;

  @ApiProperty()
  subtotalPaise!: number;

  @ApiProperty()
  gstPaise!: number;

  @ApiProperty({ description: 'subtotal + gst, paise (exact)' })
  totalPaise!: number;

  @ApiProperty({ description: 'The amount due, rounded half-up to the whole rupee (paise, a multiple of 100)' })
  payablePaise!: number;

  @ApiProperty({ description: 'payablePaise − totalPaise: the signed round-off, −49…+50 paise' })
  roundOffPaise!: number;

  @ApiProperty()
  revision!: number;

  @ApiProperty({
    type: Object,
    description:
      'The pinned, client-agnostic document snapshot: { header, seller, buyer, lines, totals, gaps, revision } — what the printable invoice renders. totals is { subtotal, gst, total, roundOff, payable } in paise (total exact; payable rupee-rounded). Frozen once issued. Each gap is { kind, detail, orderLineId? }; orderLineId is set on the line-scoped kinds (unpriced-line, hsn-gap) so a client can price exactly the unpriced lines without parsing detail prose',
  })
  document!: Record<string, unknown>;

  @ApiProperty({ type: [InvoiceLineDto] })
  lines!: InvoiceLineDto[];

  @ApiProperty({ description: 'ISO-8601 UTC' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  updatedAt!: string;
}

export class InvoiceResponse {
  @ApiProperty({ type: InvoiceDto })
  invoice!: InvoiceDto;
}

export class InvoiceListResponse {
  @ApiProperty({ type: [InvoiceEntryDto] })
  items!: readonly InvoiceEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── HSN summary (story 8-2a) ─────────────────────────────────────────────────

/** GET /tenants/{tenantId}/invoices/hsn-summary query. */
export class HsnSummaryQuery {
  @ApiProperty({
    description: 'The supplier GSTIN whose return this is — matched exactly (canonical uppercase), no case folding',
    example: '29AAAPZ1234C1ZV',
  })
  @IsString()
  @Matches(GSTIN_RE, { message: 'gstin must be a GSTIN — two digits then thirteen letters or digits' })
  gstin!: string;

  @ApiProperty({
    description:
      "The accounting period, by IST issue date: a month 'YYYY-MM' (e.g. '2026-09') or an FY quarter 'FY-yyyy-Qn' (Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar; e.g. 'FY-2627-Q2')",
    example: '2026-09',
  })
  @IsString()
  @Matches(HSN_PERIOD_SHAPE_RE, { message: "period must be 'YYYY-MM' or 'FY-yyyy-Qn'" })
  period!: string;
}

export class HsnSummaryPeriodDto {
  @ApiProperty({ example: '2026-09' })
  label!: string;

  @ApiProperty({ enum: HSN_PERIOD_KINDS })
  kind!: HsnPeriodKind;

  @ApiProperty({ description: 'Inclusive lower bound: the UTC instant of the first IST midnight of the period' })
  from!: string;

  @ApiProperty({ description: 'EXCLUSIVE upper bound: the UTC instant of the first IST midnight after the period' })
  to!: string;

  @ApiProperty({ enum: [true], description: 'Always true — `to` is exclusive' })
  toExclusive!: true;
}

export class HsnSummaryRowDto {
  @ApiProperty({ type: String, nullable: true, description: 'The trimmed HSN as frozen on the lines; null = blank' })
  hsn!: string | null;

  @ApiProperty({
    description:
      'Blank or malformed HSN (not 4, 6 or 8 digits). Included in the totals so they reconcile; excluded from the Table 12 CSV (the portal accepts master HSNs only)',
  })
  hsnIssue!: boolean;

  @ApiProperty({ enum: UQCS, description: 'GST Unit Quantity Code — no quantity is ever scaled to fit one; OTH where none means the same unit' })
  uqc!: Uqc;

  @ApiProperty({ type: [String], description: 'The distinct catalog units merged into this row (sorted)' })
  sourceUoms!: string[];

  @ApiProperty({ description: 'More than one catalog unit merged under one UQC (only OTH can) — the quantity mixes units' })
  mixedUnits!: boolean;

  @ApiProperty({ description: 'GST rate in basis points (1800 = 18%)' })
  gstBps!: number;

  @ApiProperty({ description: 'Σ dispatched quantity in milli-units — unrounded' })
  qtyMilli!: number;

  @ApiProperty({ description: 'Invoice lines summed into this row' })
  lineCount!: number;

  @ApiProperty({ description: 'Σ taxable value, paise (exact)' })
  taxablePaise!: number;

  @ApiProperty({ description: 'Σ IGST, paise' })
  igstPaise!: number;

  @ApiProperty({ description: 'Σ CGST, paise' })
  cgstPaise!: number;

  @ApiProperty({ description: 'Σ SGST/UTGST, paise' })
  sgstPaise!: number;

  @ApiProperty({ description: 'Taxable + every tax, paise (Table 12 "Total Value")' })
  totalValuePaise!: number;
}

export class HsnSummaryTotalsDto {
  @ApiProperty({ description: 'Issued invoices in scope (an invoice with no lines still counts)' })
  invoiceCount!: number;

  @ApiProperty()
  taxablePaise!: number;

  @ApiProperty()
  igstPaise!: number;

  @ApiProperty()
  cgstPaise!: number;

  @ApiProperty()
  sgstPaise!: number;

  @ApiProperty({ description: 'IGST + CGST + SGST, paise' })
  gstPaise!: number;

  @ApiProperty({ description: 'Taxable + GST, paise' })
  totalValuePaise!: number;
}

export class HsnSummarySectionDto {
  @ApiProperty({ type: [HsnSummaryRowDto], description: 'HSN ascending (issue rows last), then UQC, then rate' })
  rows!: HsnSummaryRowDto[];

  @ApiProperty({ type: HsnSummaryTotalsDto, description: 'Over every row, issue rows included' })
  totals!: HsnSummaryTotalsDto;
}

export class HsnIssueLineDto {
  @ApiProperty({ enum: HSN_SECTIONS })
  section!: HsnSection;

  @ApiProperty({ format: 'uuid' })
  invoiceId!: string;

  @ApiProperty({ description: "The invoice number (unique per supplier GSTIN), e.g. '29/2627/000001'" })
  invoiceNo!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The HSN frozen on the line (trimmed); null = blank' })
  hsn!: string | null;

  @ApiProperty()
  taxablePaise!: number;

  @ApiProperty()
  gstPaise!: number;

  @ApiProperty({ description: 'Taxable + GST, paise — what leaving this line out of the CSV leaves Table 12 short by' })
  valuePaise!: number;

  @ApiProperty({ type: String, nullable: true, description: "The SKU's CURRENT catalog HSN — a hint for the correction; the issued invoice is never rewritten from it" })
  catalogHsn!: string | null;
}

export class HsnSummaryDto {
  @ApiProperty()
  gstin!: string;

  @ApiProperty({ type: HsnSummaryPeriodDto })
  period!: HsnSummaryPeriodDto;

  @ApiProperty({ type: HsnSummarySectionDto, description: 'Invoices to registered recipients (a consignee GSTIN)' })
  b2b!: HsnSummarySectionDto;

  @ApiProperty({ type: HsnSummarySectionDto, description: 'Invoices to unregistered recipients (no consignee GSTIN)' })
  b2c!: HsnSummarySectionDto;

  @ApiProperty({ type: HsnSummaryTotalsDto, description: 'B2B + B2C — equals the included invoices’ subtotal and GST to the paisa' })
  totals!: HsnSummaryTotalsDto;

  @ApiProperty({ type: [HsnIssueLineDto], description: 'Every line behind an hsnIssue row' })
  issueLines!: HsnIssueLineDto[];
}

export class HsnSummaryResponse {
  @ApiProperty({ type: HsnSummaryDto })
  summary!: HsnSummaryDto;
}

export class HsnSummaryGstinDto {
  @ApiProperty()
  gstin!: string;

  @ApiProperty({ description: 'Earliest issue instant under this GSTIN, ISO-8601 UTC' })
  firstIssuedAt!: string;

  @ApiProperty({ description: 'Latest issue instant under this GSTIN, ISO-8601 UTC' })
  lastIssuedAt!: string;

  @ApiProperty()
  invoiceCount!: number;
}

export class HsnSummaryGstinsResponse {
  @ApiProperty({ type: [HsnSummaryGstinDto], description: 'Every supplier GSTIN with issued invoices, GSTIN ascending' })
  items!: HsnSummaryGstinDto[];
}
