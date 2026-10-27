import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PORTAL_PAGE_DEFAULT_LIMIT, PORTAL_PAGE_MAX_LIMIT } from '../shared/primitives/portal-page';
import { MAX_QUANTITY_BASE, QUANTITY_FIELD_DESCRIPTION } from '../shared/primitives/quantity';
import { CLIENT_ORDER_REF_RE, MAX_CLIENT_ORDER_REF_LENGTH, MAX_CONSIGNEE_LEGAL_NAME_LENGTH, MAX_SHIP_BY_DAYS_AHEAD, ORDER_SOURCES, ORDER_STATUSES, type OrderStatus } from '../modules/outbound/order.command';
import { MAX_COD_AMOUNT_PAISE, ORDER_PRIORITIES, ORDER_TYPES, PORTAL_ORDER_PRIORITIES } from '../modules/outbound/order-urgency';
import { ASN_STATUSES, MAX_ASN_CODE_LENGTH, MAX_ASN_LINES, type AsnStatus } from '../modules/inbound/asn.command';
import { PO_STATUSES, type PoStatus } from '../modules/inbound/po.command';
import { CHARGE_CODES, RATE_BASES } from '../modules/billing/rate-cards';
import { AddressDto, SessionClientResponse, USER_STATUSES } from '../modules/tenancy/tenancy.dto';
import { GSTIN_RE, gstinDtoTransform } from '../shared/primitives/gstin';
import {
  COD_AMOUNT_DOC,
  MAX_ORDER_LINES,
  ORDER_PRIORITY_DOC,
  ORDER_TYPE_DOC,
  SHIP_BY_DATE_DOC,
} from '../modules/outbound/outbound.dto';
import { MAX_EXTERNAL_ID_LENGTH } from '../shared/primitives/ids';

/** Story 4-1a — the portal order's line ceiling IS the staff order's (`CreateOrderDto`), never a copy. */
const MAX_PORTAL_ORDER_LINES = MAX_ORDER_LINES;

/**
 * Story 21-7 — the client portal's wire shapes. Every response is an EXACT
 * key allowlist (deep `toEqual` in test/portal.spec.ts): no user id or
 * email of staff, no actor, bin, warehouse code, cost, vendor, integration
 * id, hash, note, gap or warning appears at any depth. Quantities are base
 * units; money is integer paise.
 */

const PORTAL_INVOICE_STATUSES = ['issued', 'disputed', 'settled', 'void'] as const;
const SUPPLY_TYPES = ['intra', 'inter'] as const;

// ── queries ─────────────────────────────────────────────────────────────────

export class PortalPageQuery {
  @ApiProperty({ required: false, description: 'Opaque keyset cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: PORTAL_PAGE_MAX_LIMIT, default: PORTAL_PAGE_DEFAULT_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PORTAL_PAGE_MAX_LIMIT)
  limit?: number;
}

export class PortalOrdersQuery extends PortalPageQuery {
  @ApiProperty({ required: false, enum: [...ORDER_STATUSES] })
  @IsOptional()
  @IsIn([...ORDER_STATUSES])
  status?: OrderStatus;

  @ApiProperty({
    required: false,
    maxLength: MAX_EXTERNAL_ID_LENGTH,
    description:
      "Story 4-1b — an EXACT, case-sensitive match on your order number (any status, cancelled included) or the sales channel's order reference. Trimmed; blank is no search; over 200 characters is 400. Only your own orders are ever searched",
  })
  // Trimmed; a blank search reads as no search (one transform).
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  })
  @IsOptional()
  @IsString()
  @Length(1, MAX_EXTERNAL_ID_LENGTH)
  reference?: string;
}

export class PortalAsnsQuery extends PortalPageQuery {
  @ApiProperty({ required: false, enum: [...ASN_STATUSES] })
  @IsOptional()
  @IsIn([...ASN_STATUSES])
  status?: AsnStatus;
}

export class PortalPurchaseOrdersQuery extends PortalPageQuery {
  @ApiProperty({ required: false, enum: [...PO_STATUSES] })
  @IsOptional()
  @IsIn([...PO_STATUSES])
  status?: PoStatus;
}

// ── me ──────────────────────────────────────────────────────────────────────

export class PortalUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'buyer@brand-a.example' })
  email!: string;

  @ApiProperty({ enum: ['client'], example: 'client' })
  role!: string;

  @ApiProperty({ enum: USER_STATUSES, example: 'active' })
  status!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;
}

export class PortalMeResponse {
  @ApiProperty({ type: PortalUserDto })
  user!: PortalUserDto;

  @ApiProperty({ type: SessionClientResponse })
  client!: SessionClientResponse;
}

// ── stock ───────────────────────────────────────────────────────────────────

export class PortalStockRowDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ example: 'each', description: 'The SKU base UoM every quantity of the row is in' })
  baseUom!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty()
  warehouseName!: string;

  @ApiProperty({ description: 'On hand across EVERY bin of the warehouse (receiving and QC included), base units' })
  onHand!: number;

  @ApiProperty({ description: 'Allocated to open orders (held or committed reservations), base units' })
  allocated!: number;
}

export class PortalStockPageResponse {
  @ApiProperty({ type: [PortalStockRowDto] })
  items!: PortalStockRowDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

// ── orders ──────────────────────────────────────────────────────────────────

export class PortalOrderRowDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: [...ORDER_STATUSES] })
  status!: string;

  @ApiProperty({ enum: [...ORDER_SOURCES] })
  source!: string;

  @ApiProperty({ type: String, nullable: true, description: "The sales channel's own order reference; null for a manual order" })
  externalRef!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: MAX_CLIENT_ORDER_REF_LENGTH,
    pattern: CLIENT_ORDER_REF_RE.source,
    description: 'Story 4-1b — your own order number, as given when the order was placed; null when none was given',
  })
  clientOrderRef!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: [...ORDER_TYPES, null], description: ORDER_TYPE_DOC })
  orderType!: string | null;

  @ApiProperty({ enum: [...ORDER_PRIORITIES], description: ORDER_PRIORITY_DOC })
  priority!: string;

  @ApiProperty({ type: String, nullable: true, format: 'date', description: SHIP_BY_DATE_DOC })
  shipByDate!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: COD_AMOUNT_DOC })
  codAmountPaise!: number | null;

  @ApiProperty()
  warehouseName!: string;

  @ApiProperty({ type: String, nullable: true })
  destinationName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  destinationCity!: string | null;

  @ApiProperty({ type: String, nullable: true })
  destinationPincode!: string | null;

  @ApiProperty({ description: 'Top-level lines — a kit counts once' })
  lineCount!: number;

  @ApiProperty()
  createdAt!: string;
}

export class PortalOrderPageResponse {
  @ApiProperty({ type: [PortalOrderRowDto] })
  items!: PortalOrderRowDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class PortalOrderComponentDto {
  @ApiProperty({ type: String, nullable: true })
  skuCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  skuName!: string | null;

  @ApiProperty({ description: 'Base units' })
  qty!: number;
}

export class PortalOrderLineDto extends PortalOrderComponentDto {
  @ApiProperty({ type: [PortalOrderComponentDto], description: "A kit line's components; empty for a plain line" })
  components!: PortalOrderComponentDto[];
}

export class PortalOrderDetailResponse extends PortalOrderRowDto {
  @ApiProperty({ type: [PortalOrderLineDto] })
  lines!: PortalOrderLineDto[];
}

// ── inbound ─────────────────────────────────────────────────────────────────

export class PortalAsnRowDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ enum: [...ASN_STATUSES] })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  expectedAt!: string | null;

  @ApiProperty()
  warehouseName!: string;

  @ApiProperty()
  lineCount!: number;

  @ApiProperty({ description: 'Σ announced across lines (base units, mixed UoMs — indicative)' })
  announcedTotal!: number;

  @ApiProperty({ description: 'Σ received across lines (base units, mixed UoMs — indicative)' })
  receivedTotal!: number;

  @ApiProperty()
  createdAt!: string;
}

export class PortalAsnPageResponse {
  @ApiProperty({ type: [PortalAsnRowDto] })
  items!: PortalAsnRowDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class PortalAsnLineDto {
  @ApiProperty({ type: String, nullable: true })
  skuCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  skuName!: string | null;

  @ApiProperty()
  announcedQty!: number;

  @ApiProperty()
  receivedQty!: number;
}

export class PortalAsnDetailResponse extends PortalAsnRowDto {
  @ApiProperty({ type: [PortalAsnLineDto] })
  lines!: PortalAsnLineDto[];
}

// ── story 21-7b: announcing a shipment from the portal ─────────────────────

/** Trim at the validation boundary (the inbound DTO pattern). */
function Trim() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Transform(({ value }: { value: any }) => (typeof value === 'string' ? value.trim() : value));
}

/**
 * One announced line. The validators are `AsnLineInputDto`'s, WITHOUT an
 * `id` (there is no portal amend) — a line `id` is 400 `validation-failed`
 * through the global `forbidNonWhitelisted`.
 */
export class PortalAsnLineInputDto {
  @ApiProperty({ format: 'uuid', description: "One of this client's SKUs (portal/skus) — never a kit" })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description: `Announced quantity. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  announcedQty!: number;
}

/**
 * `POST /tenants/{t}/portal/inbound/asns` body — `CreateAsnDto`'s
 * validators WITHOUT `clientId`: the client is the portal session's, never
 * the request's (a body `clientId` is 400 `validation-failed`).
 */
export class PortalCreateAsnDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse the shipment arrives at (portal/warehouses)' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ description: 'Your own ASN reference — unique per company; 1–64 characters, counted in code points', minLength: 1, maxLength: MAX_ASN_CODE_LENGTH })
  @Trim()
  @IsString()
  @Matches(new RegExp(`^.{1,${MAX_ASN_CODE_LENGTH}}$`, 'su'), {
    message: `asnCode must be 1–${MAX_ASN_CODE_LENGTH} characters`,
  })
  asnCode!: string;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    description: 'When the shipment is expected (ISO-8601 UTC, Z-suffixed); optional',
    minLength: 20,
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @Length(20, 35)
  expectedAt?: string | null;

  @ApiProperty({ type: [PortalAsnLineInputDto], minItems: 1, maxItems: MAX_ASN_LINES, description: "At least one line with one of this client's SKUs" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ASN_LINES)
  @ValidateNested({ each: true })
  @Type(() => PortalAsnLineInputDto)
  lines!: PortalAsnLineInputDto[];
}

// ── story 4-1a: placing an order from the portal ───────────────────────────

/**
 * One portal order line — its OWN DTO, never the staff `OrderLineInputDto`:
 * there is no `ratePaise` (a client never prices its own order), so a rate
 * on a line is 400 `validation-failed` through the global
 * `forbidNonWhitelisted`.
 */
export class PortalOrderLineInputDto {
  @ApiProperty({ format: 'uuid', description: "One of this client's active SKUs (portal/skus) — never a kit" })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description: `Ordered quantity. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  quantity!: number;
}

/**
 * `POST /tenants/{t}/portal/orders` body — the staff `CreateOrderDto`'s
 * validators for the warehouse, the ship-to address and the consignee,
 * WITHOUT `source`, the channel arms or a rate: the order is a `manual` order
 * of the session's client (a body `clientId` is 400 `validation-failed`).
 */
export class PortalCreateOrderDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse the order ships from (portal/warehouses)' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ type: [PortalOrderLineInputDto], minItems: 1, maxItems: MAX_PORTAL_ORDER_LINES, description: "At least one line with one of this client's active SKUs" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PORTAL_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => PortalOrderLineInputDto)
  lines!: PortalOrderLineInputDto[];

  @ApiProperty({
    type: AddressDto,
    description: 'Where the shipment goes — every field required except line2; the pincode is six digits, as text',
  })
  @ValidateNested()
  @Type(() => AddressDto)
  destination!: AddressDto;

  @ApiProperty({
    required: false,
    description: "The consignee's GSTIN, when the buyer is GST-registered (optional)",
  })
  @Transform(gstinDtoTransform)
  @IsOptional()
  @IsString()
  @Matches(GSTIN_RE, { message: 'consigneeGstin must be a 15-character GSTIN (two digits, thirteen alphanumeric characters)' })
  consigneeGstin?: string;

  @ApiProperty({
    required: false,
    description:
      "The GST-registered buyer's legal or trade name (optional, only alongside consigneeGstin, at most 100 characters — counted in code points after the trim, by the command). Trimmed; blank reads as absent.",
    maxLength: MAX_CONSIGNEE_LEGAL_NAME_LENGTH,
  })
  @IsOptional()
  @IsString()
  // No DTO length cap (IMPLEMENTATION-GUIDE §4, the 8-1d rule): the 100 is
  // counted in code points after the trim, by the command, behind its replay
  // lookup — a UTF-16 @MaxLength here would refuse names the command accepts.
  consigneeLegalName?: string;

  @ApiProperty({
    required: false,
    maxLength: MAX_CLIENT_ORDER_REF_LENGTH,
    pattern: CLIENT_ORDER_REF_RE.source,
    description:
      'Story 4-1b — your own order number (optional). Trimmed (the pattern is the trimmed value\'s); blank reads as absent. 1–64 printable ASCII characters (400 validation-failed otherwise); must not be already used by another of your orders (409 duplicate-client-order-ref — a cancelled order frees its number).',
  })
  @IsOptional()
  @IsString()
  // No DTO shape check (the 8-1d rule): the command normalizes and refuses
  // behind its replay lookup.
  clientOrderRef?: string;

  // ── story 4-2a: the order header fields — type checks only (A11); the
  // command checks every value behind its replay lookup (400 validation-failed).

  @ApiProperty({
    required: false,
    enum: [...ORDER_TYPES, null],
    description:
      "Story 4-2a — 'b2b' or 'b2c' (optional). Omitted: b2b when a consigneeGstin is given, else b2c. b2c beside a consigneeGstin is 400.",
  })
  @IsOptional()
  @IsString()
  orderType?: string;

  @ApiProperty({
    required: false,
    enum: [...PORTAL_ORDER_PRIORITIES],
    description: "Story 4-2a — 'normal' (the default) or 'high'. 'urgent' is set by the warehouse only (400 here).",
  })
  @IsOptional()
  @IsString()
  priority?: string;

  @ApiProperty({
    required: false,
    format: 'date',
    description: `Story 4-2a — ship by the end of this IST day, YYYY-MM-DD, from today (IST) to ${MAX_SHIP_BY_DAYS_AHEAD} days ahead (optional).`,
  })
  @IsOptional()
  @IsString()
  shipByDate?: string;

  @ApiProperty({
    required: false,
    type: 'integer',
    minimum: 1,
    maximum: MAX_COD_AMOUNT_PAISE,
    description: 'Story 4-2a — cash on delivery: the amount to collect, integer paise (1 to 1,000,000,000). Omit it for a prepaid order.',
  })
  @IsOptional()
  codAmountPaise?: number;
}

/** `POST portal/orders` 201 — the placed order, an exact key allowlist (and the stored replay). */
export class PortalPlacedOrderResponse {
  @ApiProperty({ format: 'uuid', description: 'The new order — read it through portal/orders/{orderId}' })
  orderId!: string;

  @ApiProperty({ description: 'The warehouse the order was placed into' })
  warehouseName!: string;

  @ApiProperty({ type: 'integer', minimum: 1, description: 'Lines on the order' })
  lineCount!: number;

  @ApiProperty({ format: 'date-time', description: 'When the order was placed' })
  placedAt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    maxLength: MAX_CLIENT_ORDER_REF_LENGTH,
    pattern: CLIENT_ORDER_REF_RE.source,
    description: 'Story 4-1b — your order number as stored (trimmed); null when none was given. Absent only on a replay of an order placed before 4-1b — read absent as null',
  })
  clientOrderRef?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    enum: [...ORDER_TYPES, null],
    description: `${ORDER_TYPE_DOC} Absent only on a replay of an order placed before 4-2a — read absent as null.`,
  })
  orderType?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    enum: [...ORDER_PRIORITIES, null],
    description: `${ORDER_PRIORITY_DOC} Absent only on a replay of an order placed before 4-2a — read absent as null.`,
  })
  priority?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    format: 'date',
    description: `${SHIP_BY_DATE_DOC} Absent only on a replay of an order placed before 4-2a — read absent as null.`,
  })
  shipByDate?: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    description: `${COD_AMOUNT_DOC} Absent only on a replay of an order placed before 4-2a — read absent as null.`,
  })
  codAmountPaise?: number | null;
}

/** One option of the announce form's SKU picker (portal vocabulary, as on `portal/stock`). */
export class PortalSkuDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ example: 'each', description: 'The SKU base UoM — announced quantities are in it' })
  baseUom!: string;

  @ApiProperty({ example: 0, description: 'Decimal places the unit admits (0 = whole units only)' })
  uomPrecision!: number;
}

export class PortalSkuPageResponse {
  @ApiProperty({ type: [PortalSkuDto] })
  items!: PortalSkuDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

/** One warehouse a client may announce into — never a code, address line or GSTIN. */
export class PortalWarehouseDto {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty()
  warehouseName!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The origin city — tells apart two warehouses of one name' })
  city!: string | null;
}

export class PortalWarehouseListResponse {
  @ApiProperty({ type: [PortalWarehouseDto] })
  items!: PortalWarehouseDto[];
}

export class PortalPurchaseOrderRowDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ enum: [...PO_STATUSES] })
  status!: string;

  @ApiProperty()
  warehouseName!: string;

  @ApiProperty()
  lineCount!: number;

  @ApiProperty()
  orderedTotal!: number;

  @ApiProperty()
  receivedTotal!: number;

  @ApiProperty()
  createdAt!: string;
}

export class PortalPurchaseOrderPageResponse {
  @ApiProperty({ type: [PortalPurchaseOrderRowDto] })
  items!: PortalPurchaseOrderRowDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class PortalPurchaseOrderLineDto {
  @ApiProperty({ type: String, nullable: true })
  skuCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  skuName!: string | null;

  @ApiProperty()
  orderedQty!: number;

  @ApiProperty()
  receivedQty!: number;

  @ApiProperty({ type: String, nullable: true })
  expectedDate!: string | null;
}

export class PortalPurchaseOrderDetailResponse extends PortalPurchaseOrderRowDto {
  @ApiProperty({ type: [PortalPurchaseOrderLineDto] })
  lines!: PortalPurchaseOrderLineDto[];
}

// ── invoices ────────────────────────────────────────────────────────────────

export class PortalInvoiceTotalsDto {
  @ApiProperty() subtotal!: number;
  @ApiProperty() cgst!: number;
  @ApiProperty() sgst!: number;
  @ApiProperty() igst!: number;
  @ApiProperty() tax!: number;
  @ApiProperty() roundOff!: number;
  @ApiProperty() payable!: number;
}

export class PortalInvoiceRowDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Always set — the portal serves non-draft invoices only' })
  invoiceNo!: string;

  @ApiProperty({ example: 'FY-2627' })
  fyLabel!: string;

  @ApiProperty({ example: '2026-09-01' })
  periodStart!: string;

  @ApiProperty({ example: '2026-09-30' })
  periodEnd!: string;

  @ApiProperty({ enum: [...PORTAL_INVOICE_STATUSES], description: 'Never draft — a portal sees issued documents only' })
  status!: string;

  @ApiProperty()
  issuedAt!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  replacesInvoiceId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  placeOfSupply!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: [...SUPPLY_TYPES, null] })
  supplyType!: string | null;

  @ApiProperty({ type: PortalInvoiceTotalsDto, description: 'Integer paise' })
  totals!: PortalInvoiceTotalsDto;
}

export class PortalInvoicePageResponse {
  @ApiProperty({ type: [PortalInvoiceRowDto] })
  items!: PortalInvoiceRowDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class PortalSupplierAddressDto {
  @ApiProperty() line1!: string;
  @ApiProperty({ type: String, nullable: true }) line2!: string | null;
  @ApiProperty() city!: string;
  @ApiProperty() state!: string;
  @ApiProperty() pincode!: string;
}

export class PortalRecipientAddressDto {
  @ApiProperty({ type: String, nullable: true }) line1!: string | null;
  @ApiProperty({ type: String, nullable: true }) line2!: string | null;
  @ApiProperty({ type: String, nullable: true }) city!: string | null;
  @ApiProperty({ type: String, nullable: true }) stateCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) pincode!: string | null;
}

export class PortalInvoiceSupplierDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) gstin!: string | null;
  @ApiProperty({ type: String, nullable: true }) stateCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) stateName!: string | null;
  @ApiProperty({ type: PortalSupplierAddressDto, nullable: true }) address!: PortalSupplierAddressDto | null;
}

export class PortalInvoiceRecipientDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) legalName!: string | null;
  @ApiProperty({ type: String, nullable: true }) gstin!: string | null;
  @ApiProperty({ type: String, nullable: true }) stateCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) stateName!: string | null;
  @ApiProperty({ type: PortalRecipientAddressDto }) address!: PortalRecipientAddressDto;
}

export class PortalInvoicePartyDto {
  @ApiProperty({ type: PortalInvoiceSupplierDto }) supplier!: PortalInvoiceSupplierDto;
  @ApiProperty({ type: PortalInvoiceRecipientDto }) recipient!: PortalInvoiceRecipientDto;
}

export class PortalInvoiceLineDto {
  @ApiProperty({ example: '2026-09-01', description: 'IST date, inclusive' }) segmentFrom!: string;
  @ApiProperty({ example: '2026-09-30', description: 'IST date, inclusive' }) segmentTo!: string;
  @ApiProperty({ enum: [...CHARGE_CODES] }) chargeCode!: string;
  @ApiProperty({ enum: [...RATE_BASES] }) basis!: string;
  @ApiProperty({ type: String, nullable: true }) uom!: string | null;
  @ApiProperty({ description: 'A decimal string — base-unit-days for storage, a whole count otherwise' }) quantity!: string;
  @ApiProperty({ type: Number, nullable: true }) unitAmountPaise!: number | null;
  @ApiProperty({ type: Number, nullable: true }) amountPaise!: number | null;
  @ApiProperty() sac!: string;
  @ApiProperty() gstBps!: number;
  @ApiProperty() cgstPaise!: number;
  @ApiProperty() sgstPaise!: number;
  @ApiProperty() igstPaise!: number;
}

export class PortalInvoiceDetailResponse extends PortalInvoiceRowDto {
  @ApiProperty({ type: PortalInvoicePartyDto })
  party!: PortalInvoicePartyDto;

  @ApiProperty({ type: [PortalInvoiceLineDto] })
  lines!: PortalInvoiceLineDto[];
}

// ── story 5-6a — credit and debit notes ─────────────────────────────────────

export class PortalNoteRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['credit', 'debit'] }) kind!: string;
  @ApiProperty({ example: '29/C2627/000001' }) noteNo!: string;
  @ApiProperty({ example: 'FY-2627' }) fyLabel!: string;
  @ApiProperty({ description: 'ISO-8601 UTC' }) issuedAt!: string;
  @ApiProperty({ enum: ['issued', 'void'], description: 'Never draft — a portal sees issued documents only' }) status!: string;
  @ApiProperty({ enum: ['deficiency-in-service', 'post-supply-discount', 'excess-billed', 'short-billed'] }) reason!: string;
  @ApiProperty({ description: 'Why — as printed on the note' }) reasonNote!: string;
  @ApiProperty({ type: PortalInvoiceTotalsDto, description: 'Positive magnitudes, integer paise; a credit subtracts, a debit adds' }) totals!: PortalInvoiceTotalsDto;
}

export class PortalInvoiceNotesResponse {
  @ApiProperty({ type: [PortalNoteRowDto] }) notes!: PortalNoteRowDto[];
  @ApiProperty({ type: PortalInvoiceTotalsDto, description: 'The invoice after its issued notes — the document value, not a balance due' })
  netDocument!: PortalInvoiceTotalsDto;
  @ApiProperty() netDocumentPayable!: number;
}

export class PortalNoteLineDto {
  @ApiProperty({ enum: [...CHARGE_CODES] }) chargeCode!: string;
  @ApiProperty({ enum: [...RATE_BASES] }) basis!: string;
  @ApiProperty({ type: String, nullable: true }) uom!: string | null;
  @ApiProperty({ example: '2026-09-01', description: 'IST date, inclusive' }) segmentFrom!: string;
  @ApiProperty({ example: '2026-09-30', description: 'IST date, inclusive' }) segmentTo!: string;
  @ApiProperty() sac!: string;
  @ApiProperty() gstBps!: number;
  @ApiProperty() amountPaise!: number;
  @ApiProperty() cgstPaise!: number;
  @ApiProperty() sgstPaise!: number;
  @ApiProperty() igstPaise!: number;
}

export class PortalNoteDetailResponse extends PortalNoteRowDto {
  @ApiProperty() invoiceNo!: string;
  @ApiProperty({ description: 'ISO-8601 UTC' }) invoiceIssuedAt!: string;
  @ApiProperty() placeOfSupply!: string;
  @ApiProperty({ enum: [...SUPPLY_TYPES] }) supplyType!: string;
  @ApiProperty({ type: PortalInvoicePartyDto }) party!: PortalInvoicePartyDto;
  @ApiProperty({ type: [PortalNoteLineDto] }) lines!: PortalNoteLineDto[];
}
