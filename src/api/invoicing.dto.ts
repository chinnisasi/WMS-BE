import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { GAP_KINDS, INVOICE_STATUSES, RATE_SOURCES } from '../modules/invoicing/generator';
import type { GapKind, InvoiceStatus, RateSource } from '../modules/invoicing/generator';
import { INVOICE_LIST_MAX_PAGE_SIZE } from '../modules/invoicing/view';

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

  @ApiProperty({ type: String, nullable: true, description: 'FY-series number; null until first issued' })
  invoiceNo!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "e.g. 'FY-2627'; null until first issued" })
  fyLabel!: string | null;

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

  @ApiProperty({ description: 'subtotal + gst, paise (exact; no rupee rounding)' })
  totalPaise!: number;

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

  @ApiProperty({ type: Number, nullable: true, description: 'Position in the tenant FY series; null until first issued' })
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

  @ApiProperty()
  totalPaise!: number;

  @ApiProperty()
  revision!: number;

  @ApiProperty({
    type: Object,
    description:
      'The pinned, client-agnostic document snapshot: { header, seller, buyer, lines, totals, gaps, revision } — what the printable invoice renders',
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
