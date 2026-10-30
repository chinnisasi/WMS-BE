import { Transform, Type } from 'class-transformer';
import {
  MAX_QUANTITY_BASE,
  QUANTITY_FIELD_DESCRIPTION,
  } from '../../shared/primitives/quantity';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  IsNumber,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, OmitType } from '@nestjs/swagger';
import { BooleanFlag, IsInstant } from '../../shared/primitives/instant-range';
import { PACK_FAILURE_ENTRIES } from '../../shared/db/schema';
import {
  CLIENT_ORDER_REF_RE,
  MAX_CLIENT_ORDER_REF_LENGTH,
  MAX_SHIP_BY_DAYS_AHEAD,
  ORDER_SOURCES,
  ORDER_STATUSES,
} from './order.command';
import { MAX_COD_AMOUNT_PAISE, ORDER_PRIORITIES, ORDER_TYPES } from './order-urgency';
import { ORDER_IMPORT_ROW_ERROR_CODES, type OrderImportRowErrorCode } from './order-import.parse';
import { MAX_EXTERNAL_ID_LENGTH } from '../../shared/primitives/ids';
import { AddressDto } from '../tenancy/tenancy.dto';
import { SHORT_PICK_REASON_CODES } from './pick.command';
import {
  ALLOCATION_RULES,
  CONSIGNEE_MIN_SHELF_LIFE_DAYS_MAX,
  CONSIGNEE_MIN_SHELF_LIFE_DAYS_MIN,
  CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MAX,
  CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MIN,
  MIN_OUTBOUND_SHELF_LIFE_DAYS_MAX,
  MIN_OUTBOUND_SHELF_LIFE_DAYS_MIN,
  SHORTFALL_CAUSES,
} from '../../shared/primitives/batch-allocation';
import { CONSIGNEE_RESOLUTIONS } from '../partners/partners.facade';
// The pack bounds are the COMMAND's constants, imported rather than copied:
// a literal here and a constant there drift silently, and the DTO is the
// gate every HTTP caller actually hits. (`order.command` / `pick.command`
// set the precedent above; `pack.command` imports no DTO, so no cycle.)
import { MAX_DIMENSION_MM, MAX_SCAN_LINES, MAX_WEIGHT_GRAMS } from './pack.command';
import { MAX_CARTONS_PER_PACK, MAX_PACK_SEQ, MAX_SCAN_LINES_PER_CARTON, ORDER_PACK_STATUSES } from './cartons';
import { MAX_RECARTON_REASON_LENGTH } from './carton.command';
import { GSTIN_RE, gstinDtoTransform } from '../../shared/primitives/gstin';
import { MAX_HANDLING_UNITS_PER_REQUEST } from '../catalog/handling-unit';
import { MAX_CARRIER_NAME_LENGTH, MAX_TRACKING_NUMBER_LENGTH } from './dispatch.command';
import { ALLOCATION_SKIP_REASONS } from './allocation.command';
import { SHIPMENT_KINDS, SHIPMENT_STATUSES } from './shipment.command';
import { MAX_MANIFEST_SHIPMENTS } from './manifest.command';
import {
  PICKLIST_LINE_STATUSES,
  PICKLIST_STATUSES,
  WAVE_GROUPINGS,
  WAVE_STATUSES,
} from './wave.command';

// ── story 4-2a: the order header fields on the wire ─────────────────────────
// One description per field, shared by every DTO that carries them. The
// nullable `orderType` lists `null` in its enum (IMPLEMENTATION-GUIDE §4, 8-2b).

export const ORDER_TYPE_DOC =
  "Story 4-2a — the order type: 'b2b' or 'b2c' (operational only — tax treatment stays GSTIN-driven). Null on an order created before 4-2a.";
export const ORDER_PRIORITY_DOC =
  "Story 4-2a — the order priority: 'normal', 'high' or 'urgent' (every order created before 4-2a reads 'normal').";
export const SHIP_BY_DATE_DOC =
  'Story 4-2a — the ship-by date, an IST calendar date YYYY-MM-DD ("ship by the end of that IST day"); null when none.';
export const COD_AMOUNT_DOC =
  'Story 4-2a — the cash to collect on delivery, integer paise; null means prepaid (nothing to collect).';

/** Trim at the validation boundary (the tenancy DTO pattern). */
function Trim() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Transform(({ value }: { value: any }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

// ── Order inputs (Story 4.1) ────────────────────────────────────────────────

/** One order line as the client supplies it (manual entry and ingestion alike). */
export class OrderLineInputDto {
  @ApiProperty({ format: 'uuid', description: 'The ordered SKU' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description: `Ordered quantity. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
    example: 10,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  quantity!: number;

  @ApiProperty({
    required: false,
    description:
      'The line\'s selling rate in integer PAISE per this SKU\'s base UoM (story 8-1) — frozen at acceptance and priced from at invoicing. Optional: omit it on an unpriced (channel-ingested) line — the invoice parks awaiting-data until the operator prices it there.',
    minimum: 0,
    example: 12500,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  ratePaise?: number;
}

/**
 * An order's line ceiling (`@ArrayMaxSize`) — the staff create's, and since
 * story 4-1a the portal order's too (`PortalCreateOrderDto` imports it).
 */
export const MAX_ORDER_LINES = 200;

/** POST /tenants/{tenantId}/outbound/orders body (manual entry + ingestion). */
export class CreateOrderDto {
  @ApiProperty({ format: 'uuid', description: 'The ordering warehouse' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({
    required: false,
    default: 'manual',
    enum: [...ORDER_SOURCES],
    description: "'manual' (client entry) or 'ingested' (a channel adapter's delivery)",
  })
  @IsOptional()
  @IsIn([...ORDER_SOURCES])
  source?: 'manual' | 'ingested';

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: "The channel's integration id — required together with externalEventId on an ingested order",
  })
  @IsOptional()
  @IsUUID()
  integrationId?: string;

  @ApiProperty({
    required: false,
    description: "The channel's external event id — the dedup ref (≤200 chars)",
    maxLength: 200,
  })
  @Trim()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  externalEventId?: string;

  @ApiProperty({ type: [OrderLineInputDto], minItems: 1, maxItems: MAX_ORDER_LINES })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  lines!: OrderLineInputDto[];

  @ApiProperty({
    type: AddressDto,
    description:
      'Where the shipment goes (story 11-1). REQUIRED at create — manual and ingested alike; carriers rate, label and manifest from it. Atomic: every field is required except line2. The command re-validates everything behind its replay lookup (the adapter path bypasses this DTO).',
  })
  @ValidateNested()
  @Type(() => AddressDto)
  destination!: AddressDto;

  @ApiProperty({
    required: false,
    format: 'string',
    description:
      'The consignee\'s GSTIN (story 8-1), when the buyer is GST-registered. Place of supply resolves from its first two digits; optional — absent falls back to the destination state\'s name.',
  })
  @Transform(gstinDtoTransform)
  @IsOptional()
  @IsString()
  @Matches(GSTIN_RE, { message: 'consigneeGstin must be a 15-character GSTIN (two digits, thirteen alphanumeric characters)' })
  consigneeGstin?: string;

  @ApiProperty({
    required: false,
    description:
      "The GST-registered buyer's legal or trade name (story 8-1d), printed as the invoice's buyer and so the e-way bill's toTrdName; absent falls back to the destination contact name. Trimmed; blank reads as absent. Only alongside consigneeGstin and at most 100 characters (Unicode code points) — both refused by the command (400 validation-failed) behind its replay lookup.",
  })
  @IsOptional()
  @IsString()
  consigneeLegalName?: string;

  @ApiProperty({
    required: false,
    maxLength: MAX_CLIENT_ORDER_REF_LENGTH,
    pattern: CLIENT_ORDER_REF_RE.source,
    description:
      "Story 4-1b — the client's own order number (optional; a manual order only — 400 beside source 'ingested'). Trimmed (the pattern is the trimmed value's); blank reads as absent. 1–64 printable ASCII characters (refused by the command, 400 validation-failed, behind its replay lookup); unique among the client's live orders (409 duplicate-client-order-ref — a cancelled order frees its number). Create-only.",
  })
  @IsOptional()
  @IsString()
  // No DTO shape check (IMPLEMENTATION-GUIDE §4, the 8-1d rule): the command
  // normalizes and refuses behind its replay lookup.
  clientOrderRef?: string;

  // ── story 4-2a: the order header fields (all optional, create-only) ──────
  // Type checks only (A11): the global pipe converts nothing, so a string
  // stays a string; every VALUE check (the vocabularies, the type ↔ GSTIN
  // contradiction, the ship-by shape and bounds, the COD range) is the
  // command's, behind its replay lookup — a refused value answers 400
  // `validation-failed` there. Trimmed by the command; blank reads as absent.
  // Each joins the idempotency hash only when sent, AS SENT (an explicit
  // 'normal' hashes differently from an omitted priority).

  @ApiProperty({
    required: false,
    enum: [...ORDER_TYPES, null],
    description:
      "Story 4-2a — 'b2b' or 'b2c'. Omitted: derived — b2b with a consigneeGstin, else b2c. An explicit b2c beside a consigneeGstin is 400 (a GST-registered buyer is a business); b2b without one is allowed. Manual orders only (400 on source 'ingested').",
  })
  @IsOptional()
  @IsString()
  orderType?: string;

  @ApiProperty({
    required: false,
    enum: [...ORDER_PRIORITIES],
    description:
      "Story 4-2a — 'normal' (the default when omitted), 'high' or 'urgent'. Wave planning takes due and urgent orders first. Manual orders only.",
  })
  @IsOptional()
  @IsString()
  priority?: string;

  @ApiProperty({
    required: false,
    format: 'date',
    description: `Story 4-2a — ship by the end of this IST day, YYYY-MM-DD; from today (IST) to ${MAX_SHIP_BY_DAYS_AHEAD} days ahead, else 400. Manual orders only.`,
  })
  @IsOptional()
  @IsString()
  shipByDate?: string;

  @ApiProperty({
    required: false,
    type: 'integer',
    minimum: 1,
    maximum: MAX_COD_AMOUNT_PAISE,
    description:
      'Story 4-2a — cash on delivery: the amount the courier collects, integer paise (1 to 1,000,000,000 — ₹1 crore). Omit it for a prepaid order. A string, a fraction or a value out of range is 400.',
  })
  @IsOptional()
  codAmountPaise?: number;
}

/** POST /tenants/{tenantId}/outbound/orders/{orderId}/cancel body — none. */
export class CancelOrderDto {}

// ── Order responses ─────────────────────────────────────────────────────────

/** One order line of every order response — the shortfall always derived. */
export class OrderLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: 'Ordered quantity (base UoM)' })
  qty!: number;

  @ApiProperty({ description: 'Units acceptance actually holds through the reservation journal (≤ qty)' })
  reservedQty!: number;

  @ApiProperty({ description: 'Derived shortfall (qty − reservedQty) — the backorder remainder' })
  shortfallQty!: number;

  @ApiProperty({ description: "'open' when fully reserved, 'backordered' when any part is short", enum: ['open', 'backordered'] })
  status!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The line’s journal hold (null when nothing could be reserved)' })
  reservationId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The hold’s live journal state (held / released / committed / expired)' })
  reservationState!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Story 11.4 — the kit line this component line exploded from at acceptance (null on ordinary lines and kit parents; a parent is any line another line names here)',
  })
  parentLineId!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;
}

/** One order row of every order response (detail carries the lines). */
export class OrderDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({
    description:
      "The order's lifecycle arm. 'ready_to_dispatch' (story 4.5) is a packed order: verified at the bench against what was picked and waiting for dispatch. 'dispatched' (story 4.6) is terminal — the order shipped, its shipment is journalled and its reservations are retired; there is no un-dispatch.",
    enum: [...ORDER_STATUSES],
  })
  status!: string;

  @ApiProperty({ description: "'manual' or 'ingested'", enum: ['manual', 'ingested'] })
  source!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Channel integration (null on a manual order)' })
  integrationId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Channel external event id (null on a manual order)' })
  externalEventId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    maxLength: MAX_CLIENT_ORDER_REF_LENGTH,
    pattern: CLIENT_ORDER_REF_RE.source,
    description:
      "Story 4-1b — the client's own order number (null when none was given). Absent only on a replayed response stored before 4-1b — read absent as null",
  })
  clientOrderRef?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    enum: [...ORDER_TYPES, null],
    description: `${ORDER_TYPE_DOC} Absent only on a replayed response stored before 4-2a — read absent as null.`,
  })
  orderType?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    enum: [...ORDER_PRIORITIES, null],
    description: `${ORDER_PRIORITY_DOC} Absent only on a replayed response stored before 4-2a — read absent as null.`,
  })
  priority?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    format: 'date',
    description: `${SHIP_BY_DATE_DOC} Absent only on a replayed response stored before 4-2a — read absent as null.`,
  })
  shipByDate?: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    description: `${COD_AMOUNT_DOC} Absent only on a replayed response stored before 4-2a — read absent as null.`,
  })
  codAmountPaise?: number | null;

  @ApiProperty({
    type: AddressDto,
    nullable: true,
    description: 'Where the shipment goes (story 11-1); null on a pre-11.1 order row',
  })
  destination!: AddressDto | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description:
      "Story 21-2b — the client the order is for, derived from its lines' and kit components' SKUs. Absent or null only on a replayed response stored before 21-2b",
  })
  clientId?: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description:
      'Story 4-2c — on a backorder follow-on (the order a short dispatch opened for the unshipped remainder): its parent order; null on a root order. Absent only on a replayed response stored before 4-2c — read absent as null.',
  })
  followOnOfOrderId?: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description: "Story 4-2c — on a follow-on: the chain's root (the client's original order; the label's short id when it has no number); null on a root. Absent only on a replayed response stored before 4-2c — read absent as null.",
  })
  followOnRootOrderId?: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    description: "Story 4-2c — on a follow-on: its place in the chain, the label suffix `-BO{seq}` (`1042-BO1`, then `1042-BO2`); null on a root. Absent only on a replayed response stored before 4-2c — read absent as null.",
  })
  followOnSeq?: number | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description: "Story 4-2c — the follow-on this order's short dispatch opened; null when everything shipped (or before dispatch). Absent only on a replayed response stored before 4-2c — read absent as null.",
  })
  followOnOrderId?: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;

  @ApiProperty({ type: [OrderLineDto] })
  lines!: readonly OrderLineDto[];
}

export class OrderResponse {
  @ApiProperty({ type: OrderDto })
  order!: OrderDto;
}

const FROM_DESCRIPTION = (column: string): string =>
  `Story 9-1 — only rows whose \`${column}\` is at or after this instant (inclusive). ISO-8601 with a zone designator`;
const TO_DESCRIPTION = (column: string): string =>
  `Story 9-1 — only rows whose \`${column}\` is strictly before this instant (exclusive). Must be after \`from\``;

/** Query of the warehouse-scoped order list (keyset cursor pagination). */
export class OrderListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only one client's orders (manifests and waves: any order of the client). An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, enum: [...ORDER_STATUSES], description: 'Story 9-1 — only orders in this status' })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: (typeof ORDER_STATUSES)[number];

  @ApiProperty({ required: false, enum: [...ORDER_SOURCES], description: 'Story 9-1 — only orders of this source' })
  @IsOptional()
  @IsIn(ORDER_SOURCES)
  source?: (typeof ORDER_SOURCES)[number];

  @ApiProperty({
    required: false,
    type: Boolean,
    description:
      "Story 9-1 — `true`: only orders with at least one line created backordered (counted per order, so a kit never counts twice); `false`: only orders with none. Exactly 'true' or 'false'",
  })
  @IsOptional()
  @BooleanFlag()
  @IsBoolean()
  backordered?: boolean;

  @ApiProperty({ required: false, format: 'date-time', description: FROM_DESCRIPTION('created_at') })
  @IsOptional()
  @IsInstant()
  from?: string;

  @ApiProperty({ required: false, format: 'date-time', description: TO_DESCRIPTION('created_at') })
  @IsOptional()
  @IsInstant()
  to?: string;

  @ApiProperty({
    required: false,
    description: 'Opaque keyset cursor from the previous page',
    // A cursor encodes one timestamp + one uuid — anything near this bound is
    // crafted input, rejected at the boundary before the base64 decode.
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * Query of the wave-policy list (story 1-5a). It used to share `OrderListQuery`;
 * a policy belongs to no client, so it takes every field that DTO took EXCEPT
 * `clientId` — a `clientId` here is refused 400 (`forbidNonWhitelisted`)
 * rather than silently ignored.
 */
export class WavePolicyListQuery extends OmitType(OrderListQuery, ['clientId'] as const) {}

/**
 * Story 4-1b — `GET …/warehouses/{w}/outbound/orders` only: the shared list
 * query plus the `reference` search. A subclass, so the manifest and wave
 * lists (which reuse `OrderListQuery`) neither advertise nor accept it
 * (`forbidNonWhitelisted` refuses it there 400).
 */
export class OrdersListQuery extends OrderListQuery {
  @ApiProperty({
    required: false,
    maxLength: MAX_EXTERNAL_ID_LENGTH,
    description:
      "Story 4-1b — an EXACT, case-sensitive match on the order's client order number (any status) OR its channel reference (externalEventId). Trimmed; blank is no search; over 200 characters (a channel reference's ceiling) is 400. Composes with every other filter, the client filter included",
  })
  // Trimmed, and a blank search reads as no search (one transform — the
  // order of two stacked @Transform decorators is not one to rely on).
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  })
  @IsOptional()
  @IsString()
  @Length(1, MAX_EXTERNAL_ID_LENGTH)
  reference?: string;

  @ApiProperty({
    required: false,
    type: Boolean,
    description:
      "Story 4-2c — `true`: only backorder follow-ons (orders a short dispatch opened for the unshipped remainder); `false`: only root orders (the SM-4 drill — a follow-on is not a new client order). Exactly 'true' or 'false'",
  })
  @IsOptional()
  @BooleanFlag()
  @IsBoolean()
  followOn?: boolean;
}

/** One header row of the order list (no lines — the detail read carries them). */
export class OrderEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ enum: [...ORDER_STATUSES] })
  status!: string;

  @ApiProperty({ enum: ['manual', 'ingested'] })
  source!: string;

  @ApiProperty({ type: String, nullable: true })
  integrationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  externalEventId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: MAX_CLIENT_ORDER_REF_LENGTH,
    pattern: CLIENT_ORDER_REF_RE.source,
    description: "Story 4-1b — the client's own order number; null when none was given (a live read — always present)",
  })
  clientOrderRef!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: [...ORDER_TYPES, null],
    description: `${ORDER_TYPE_DOC}`,
  })
  orderType!: string | null;

  @ApiProperty({
    enum: [...ORDER_PRIORITIES],
    description: `${ORDER_PRIORITY_DOC}`,
  })
  priority!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date',
    description: `${SHIP_BY_DATE_DOC}`,
  })
  shipByDate!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: `${COD_AMOUNT_DOC}`,
  })
  codAmountPaise!: number | null;

  @ApiProperty({
    type: AddressDto,
    nullable: true,
    description: 'Where the shipment goes (story 11-1); null on a pre-11.1 order row',
  })
  destination!: AddressDto | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description: "Story 21-2b — the client the order is for, derived from its SKUs",
  })
  clientId?: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description:
      'Story 4-2c — on a backorder follow-on (the order a short dispatch opened for the unshipped remainder): its parent order; null on a root order.',
  })
  followOnOfOrderId?: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description: "Story 4-2c — on a follow-on: the chain's root (the client's original order; the label's short id when it has no number); null on a root.",
  })
  followOnRootOrderId?: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    description: "Story 4-2c — on a follow-on: its place in the chain, the label suffix `-BO{seq}` (`1042-BO1`, then `1042-BO2`); null on a root.",
  })
  followOnSeq?: number | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description: "Story 4-2c — the follow-on this order's short dispatch opened; null when everything shipped (or before dispatch).",
  })
  followOnOrderId?: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;

  @ApiProperty({
    required: false,
    enum: ['not-applicable', 'dispatched', 'eway-required', 'eway-expired', 'ready', 'missing', 'not-required'],
    description: "Story 4-6a — the consignment gate today (the brand's tax document and e-way bill): the Docs cell. Optional",
  })
  consignmentState?: string;
}

export class OrderListResponse {
  @ApiProperty({ type: [OrderEntryDto] })
  items!: readonly OrderEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── Wave inputs (Story 4.2) ─────────────────────────────────────────────────

/** POST /tenants/{tenantId}/outbound/wave-policies body. */
export class CreateWavePolicyDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse the policy waves in' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ description: 'Policy name — unique per warehouse', maxLength: 120 })
  @Trim()
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({
    enum: [...WAVE_GROUPINGS],
    description:
      "'single' — one picklist per order; 'batch' — ONE picklist across the wave's orders, grouped by bin so each bin is visited once",
  })
  @IsIn([...WAVE_GROUPINGS])
  grouping!: 'single' | 'batch';

  @ApiProperty({ required: false, default: 0, minimum: 0, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 500,
    description: 'Cap on the orders one wave draws (absent = the server default, 200)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxOrders?: number;

  @ApiProperty({
    required: false,
    description:
      'Carrier cutoff as a 24-hour HH:MM wall clock in Asia/Kolkata. It gates RELEASE, never generation — planning ahead of a cutoff is the point. Absent = release is always allowed. 00:00 is rejected: it would refuse release for the whole day.',
    pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
    example: '16:00',
  })
  @Trim()
  @IsOptional()
  @IsString()
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'cutoffLocalTime must be a 24-hour HH:MM wall clock',
  })
  // Midnight is the one shape the regex accepts that can never be useful:
  // the cutoff compares "is the local wall clock past HH:MM", which is true
  // at every instant of the day except that exact minute — the policy would
  // refuse release all day, every day. Omit the field to mean "no cutoff".
  @Matches(/^(?!00:00$)/, {
    message:
      'cutoffLocalTime 00:00 would refuse release for the whole day — omit the field for no cutoff',
  })
  cutoffLocalTime?: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'Carrier reference — shape-validated only: there is no carriers table until story 4.6 / Epic 7, so nothing yet proves the id names a real carrier',
  })
  @IsOptional()
  @IsUUID()
  carrierRef?: string;
}

/** POST /tenants/{tenantId}/outbound/waves body. */
export class GenerateWaveDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse being waved' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The wave policy this wave is generated under' })
  @IsUUID()
  policyId!: string;

  @ApiProperty({
    required: false,
    type: [String],
    minItems: 1,
    maxItems: 500,
    description:
      'Explicit order selection. Absent = every eligible accepted order in the warehouse, oldest first, capped by the policy.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  orderIds?: string[];
}

// ── Wave responses ──────────────────────────────────────────────────────────

export class WavePolicyDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: [...WAVE_GROUPINGS] })
  grouping!: string;

  @ApiProperty()
  priority!: number;

  @ApiProperty({ type: Number, nullable: true })
  maxOrders!: number | null;

  @ApiProperty({ type: String, nullable: true, description: 'HH:MM wall clock, or null' })
  cutoffLocalTime!: string | null;

  @ApiProperty({ description: 'The IANA zone the cutoff is compared in', example: 'Asia/Kolkata' })
  cutoffTimezone!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Unvalidated carrier ref (4.6)' })
  carrierRef!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;
}

export class WavePolicyResponse {
  @ApiProperty({ type: WavePolicyDto })
  policy!: WavePolicyDto;
}

export class WavePolicyListResponse {
  @ApiProperty({ type: [WavePolicyDto] })
  items!: readonly WavePolicyDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

/** One pick line — a bin/batch SUGGESTION re-derived at pick time (4.3). */
export class PicklistLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  picklistId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Suggested bin; null when unfulfillable' })
  binId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The suggested bin’s code — the walk key' })
  binCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Suggested batch (ranked by the client's allocation rule, story 4-3a); null when the SKU carries no batch stock" })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The order line’s journal hold, carried forward — never re-reserved here' })
  reservationId!: string | null;

  @ApiProperty({ description: 'Units to draw at this bin (0 on an unfulfillable slice) — always from the order line’s reservedQty, never its qty' })
  qty!: number;

  @ApiProperty({
    description:
      "Uncovered units — non-zero on an unfulfillable slice (nothing pickable — or nothing meeting the consignee's shelf-life rule (shortfallCause) — was found) and on a short one (story 4.4: qty − shortfallQty is what actually moved)",
  })
  shortfallQty!: number;

  // `null` rides INSIDE the enum deliberately: OAS 3.0's sibling `nullable`
  // is dropped by the client generator when an `enum` is present, which
  // would hand every consumer a non-null type for a field that is null on
  // every line except a short-picked one.
  @ApiProperty({
    type: String,
    nullable: true,
    enum: [...SHORT_PICK_REASON_CODES, null],
    description: 'Story 4.4: why a short line came up short; null on every other line',
  })
  reasonCode!: string | null;

  @ApiProperty({ description: 'The order line’s slice index (an order line may span bins)' })
  sliceSeq!: number;

  @ApiProperty({ description: 'Position on the walk (bins.code ascending)' })
  walkSeq!: number;

  @ApiProperty({ enum: [...PICKLIST_LINE_STATUSES] })
  status!: string;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  // ── Story 4-3a — OPTIONAL: a wave snapshot stored before 4-3a lacks them. ──
  @ApiProperty({ type: String, nullable: true, required: false, description: "Story 4-3a — the suggested batch's code; null when none" })
  batchCode?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, format: 'date', description: "Story 4-3a — the suggested batch's expiry date (IST, YYYY-MM-DD); null when undated or none" })
  batchExpiryDate?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    format: 'date',
    description: "Story 4-3a — the IST date the suggested batch's LOT was first received in the tenant (batches.created_at — a lot received again keeps its first date); null when none",
  })
  batchReceivedOn?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    enum: [...ALLOCATION_RULES, null],
    description: 'Story 4-3a — the allocation rule this line was planned under (frozen at generate); null on a line planned before 4-3a (drawn as fefo with no minimum)',
  })
  allocationRule?: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    required: false,
    minimum: MIN_OUTBOUND_SHELF_LIFE_DAYS_MIN,
    maximum: MIN_OUTBOUND_SHELF_LIFE_DAYS_MAX,
    description: 'Story 4-3a — the minimum remaining shelf life (IST days) this line was planned under (frozen); null when none',
  })
  minOutboundShelfLifeDays?: number | null;

  // ── Story 4-3b — OPTIONAL: a wave snapshot stored before 4-3b lacks them. ──
  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    description: "Story 4-3b — the consignee (partner display name) whose shelf-life rule this line was planned under (frozen); null when none applied",
  })
  consigneeName?: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    required: false,
    minimum: CONSIGNEE_MIN_SHELF_LIFE_DAYS_MIN,
    maximum: CONSIGNEE_MIN_SHELF_LIFE_DAYS_MAX,
    description:
      "Story 4-3b — the consignee's EFFECTIVE minimum remaining shelf life (IST days) this line was planned under (frozen: max of its days rule and its percent of the SKU's total shelf life); null when no consignee rule applied, or when it cannot be judged (a percent rule over a SKU with no total shelf life — consigneeMinShelfLifePercent is then set)",
  })
  consigneeMinShelfLifeDays?: number | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    required: false,
    minimum: CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MIN,
    maximum: CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MAX,
    description: "Story 4-3b — the consignee's percent-of-total-shelf-life rule the line was planned under (frozen; display); null when none",
  })
  consigneeMinShelfLifePercent?: number | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    required: false,
    description: "Story 4-3b — the SKU's total shelf life in days the percent rule was converted from at plan (frozen with it); null without a percent rule or a shelf life",
  })
  consigneeShelfLifeBaseDays?: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    enum: [...SHORTFALL_CAUSES, null],
    description:
      "Story 4-3b — why an unfulfillable slice was left short: consignee-shelf-life (stock existed, but not enough met the consignee's minimum) or consignee-unjudgeable (a percent rule over a SKU with no total shelf life); null = no pickable stock at all",
  })
  shortfallCause?: string | null;
}

export class PicklistDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  waveId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The single order served; null on a batch picklist' })
  orderId!: string | null;

  @ApiProperty({ enum: [...PICKLIST_STATUSES] })
  status!: string;

  @ApiProperty({ description: 'Distinct bin stops on this walk — the "steps" of the batching guarantee' })
  stopCount!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    enum: [...ORDER_PRIORITIES, null],
    description:
      "Story 4-2a — the most urgent priority among the orders of this picklist's non-cancelled lines. Absent only on a replayed wave stored before 4-2a — read absent as null.",
  })
  priority?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    format: 'date',
    description:
      "Story 4-2a — the earliest ship-by date (IST, YYYY-MM-DD) among the orders of this picklist's non-cancelled lines; null when none has one. Absent only on a replayed wave stored before 4-2a — read absent as null.",
  })
  shipByDate?: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;

  @ApiProperty({ type: [PicklistLineDto], description: 'Pick lines in walk order' })
  lines!: readonly PicklistLineDto[];
}

export class WaveDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  policyId!: string;

  @ApiProperty({ enum: [...WAVE_STATUSES] })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  releasedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancelledAt!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;

  @ApiProperty({ type: [PicklistDto] })
  picklists!: readonly PicklistDto[];
}

export class WaveResponse {
  @ApiProperty({ type: WaveDto })
  wave!: WaveDto;
}

/** One header row of the wave list (no picklists — the detail read carries them). */
export class WaveEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  policyId!: string;

  @ApiProperty({ enum: [...WAVE_STATUSES] })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  releasedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancelledAt!: string | null;

  @ApiProperty({ description: 'Picklists on this wave' })
  picklistCount!: number;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;
}

export class WaveListResponse {
  @ApiProperty({ type: [WaveEntryDto] })
  items!: readonly WaveEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

// ── Picking (Story 4.3) ─────────────────────────────────────────────────────

/**
 * POST /tenants/{tenantId}/outbound/picks body — the `pick.record` op, one
 * scan-verified pick of one picklist line. The bin is what the operator
 * SCANNED (the plan's bin is a suggestion re-derived server-side); the batch
 * is never client-supplied — the server re-derives it FEFO inside the bin
 * that was actually scanned.
 */
export class RecordPickDto {
  @ApiProperty({ format: 'uuid', description: 'Warehouse the pick draws from' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The picklist whose walk is being executed' })
  @IsUUID()
  picklistId!: string;

  @ApiProperty({ format: 'uuid', description: 'The pick line being drawn (one slice of one order line)' })
  @IsUUID()
  picklistLineId!: string;

  @ApiProperty({ format: 'uuid', description: 'The SKU the operator scanned — verified against the line' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({ format: 'uuid', description: 'The bin the operator scanned — checked against live stock, not against the plan' })
  @IsUUID()
  binId!: string;

  @ApiProperty({
    // The trailing "below 0.001 is refused" sentence came off in story 10.2 —
    // see `StockAdjustmentDto.quantityDelta` for why.
    description:
      `Units actually drawn in base UoM. Equal to the line’s planned quantity for an ordinary pick; BELOW it (down to 0, an empty bin) for a short pick, which must carry a reasonCode. Above the plan is always a 400. ${QUANTITY_FIELD_DESCRIPTION}`,
    minimum: 0,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  @ApiProperty({ description: 'Device time of the pick (ISO-8601 UTC, Z-suffixed)', minLength: 20, maxLength: 35 })
  @IsString()
  @Length(20, 35)
  occurredAt!: string;

  @ApiProperty({
    required: false,
    type: [String],
    maxItems: 200,
    description: 'The serial numbers of a serial-tracked pick (one per drawn unit, no duplicates)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  serials?: string[];

  @ApiProperty({
    required: false,
    nullable: true,
    type: Number,
    minimum: 1,
    description:
      'Story 4.3b (AD-14): the scanned bin’s state_epoch as the device read it from the sealed snapshot at task start. Opaque and compared only for equality — never interpreted. Omit it (or send null) and the replay behaves exactly as it did before this story: a device whose cache predates the field is never refused for the absence of it.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  binStateEpoch?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    enum: [...SHORT_PICK_REASON_CODES],
    description:
      'Story 4.4: why this stop came up short. REQUIRED whenever qty is below the line’s planned quantity (including 0), refused outside the fixed set with a 400 naming the whole set, and ignored when qty equals the plan (that is an ordinary full pick). It is part of the idempotency payload hash — the reason is intent, not an observation. Story 3-3b: `skipped-blocked-bin` skips a planned stop whose bin is now blocked — only with qty 0 at the stop\'s own bin (else 400 validation-failed) and only while the bin is blocked (else 409 bin-not-blocked); it re-plans the stop onto other bins and needs no bin scan.',
  })
  @IsOptional()
  // `@IsIn` over the same tuple the `enum` above documents: a generated client
  // gets a closed type, so the pipe must refuse anything outside it too —
  // otherwise the contract says one thing and the validator accepts another,
  // and the command's own 400 becomes the only real gate.
  @IsIn([...SHORT_PICK_REASON_CODES])
  reasonCode?: string | null;
}

/** One slice a short pick re-planned the remainder onto (story 4.4). */
export class ReplannedSliceDto {
  @ApiProperty({ format: 'uuid', description: 'The NEW pick line carrying the remainder' })
  picklistLineId!: string;

  @ApiProperty({ format: 'uuid', description: 'The alternate bin — never the bin that came up short' })
  binId!: string;

  @ApiProperty({ description: 'The alternate bin’s code — the walk key' })
  binCode!: string;

  @ApiProperty({ type: String, nullable: true, description: 'FEFO batch suggestion; null when untracked' })
  batchId!: string | null;

  @ApiProperty({ description: 'Units to draw at the alternate bin' })
  qty!: number;

  @ApiProperty({ description: 'The order line’s next unused slice index' })
  sliceSeq!: number;

  @ApiProperty({ description: 'Walk position — after every stop the picklist already had' })
  walkSeq!: number;
}

/** One pick as every surface returns it (the idempotency snapshot). */
export class PickDto {
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'The picks row id — NULL on a zero-unit short pick (story 4.4), which writes no picks row at all: nothing moved, so there is no ledger event and no settlement record. Every other pick, short or whole, has one.',
  })
  id!: string | null;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  waveId!: string;

  @ApiProperty({ format: 'uuid' })
  picklistId!: string;

  @ApiProperty({ format: 'uuid' })
  picklistLineId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ format: 'uuid', description: 'The bin the units were actually drawn from' })
  binId!: string;

  @ApiProperty()
  binCode!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The plan’s suggested bin (advisory)' })
  suggestedBinId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  suggestedBinCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The batch re-derived FEFO in the scanned bin; null when untracked or when the draw spanned several batches' })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The plan’s suggested batch (advisory)' })
  suggestedBatchId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The plan’s suggested batch code — paired with the id, like the bin arms' })
  suggestedBatchCode!: string | null;

  @ApiProperty({ description: 'Units drawn (base UoM)' })
  qty!: number;

  @ApiProperty({ type: String, nullable: true, description: 'The order line’s journal hold' })
  reservationId!: string | null;

  @ApiProperty({ description: 'True when this pick settled the hold (held → committed) in the same transaction as the draw' })
  reservationCommitted!: boolean;

  @ApiProperty({
    enum: [...PICKLIST_LINE_STATUSES],
    description:
      'The pick line’s status after the pick — picked on a whole-quantity draw, short (story 4.4, terminal) when the operator drew fewer units than the stop planned',
  })
  lineStatus!: string;

  @ApiProperty({ description: 'Units the stop planned but never moved — 0 on a whole-quantity pick' })
  shortfallQty!: number;

  // The same null-inside-the-enum reason as `PicklistLineDto.reasonCode`.
  @ApiProperty({
    type: String,
    nullable: true,
    enum: [...SHORT_PICK_REASON_CODES, null],
    description: 'Why the stop came up short (story 4.4); null on a whole-quantity pick',
  })
  reasonCode!: string | null;

  @ApiProperty({
    description:
      'True when this command RELEASED the order line’s hold (story 4.4): a short pick releases the whole hold and re-grants the remainder, because reservations are whole-quantity rows with no partial commit',
  })
  reservationReleased!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'The fresh hold covering everything the order line still owes after the release — null when there was no remainder, or when it could not be re-held (the partial-order path). The re-planned slices and every still-open sibling slice carry it.',
  })
  replanReservationId!: string | null;

  @ApiProperty({
    type: [ReplannedSliceDto],
    description: 'The new slices the remainder was re-planned onto — empty on the partial-order path',
  })
  replanned!: readonly ReplannedSliceDto[];

  @ApiProperty({ format: 'uuid' })
  pickedBy!: string;

  @ApiProperty({ description: 'Device time of the pick (AD-1)' })
  pickedAt!: string;

  @ApiProperty({ format: 'uuid' })
  deviceId!: string;

  @ApiProperty({ description: 'ISO-8601 UTC server record time' })
  createdAt!: string;

  @ApiProperty({
    enum: ['none', 'applied', 'settled'],
    description:
      'Story 4.3b (AD-14): the taxonomy arm this pick settled under — none (no epoch sent, or the bin’s epoch still matched), applied (the epoch had moved and the draw stood on its own), settled (the moved-on bin still covered the draw and this pick settled the order line’s hold). The taxonomy’s two refusal arms write nothing, so they never appear here.',
  })
  conflictClass!: 'none' | 'applied' | 'settled';
}

export class PickResponse {
  @ApiProperty({ type: PickDto })
  pick!: PickDto;
}

/**
 * One pick task of the sealed device snapshot (AD-4): a released wave's
 * still-unpicked pick line. The bin and batch it names are the plan's
 * SUGGESTION — the server re-derives both at pick time.
 */
export class PickTaskDto {
  @ApiProperty({ format: 'uuid' })
  waveId!: string;

  @ApiProperty({ format: 'uuid' })
  picklistId!: string;

  @ApiProperty({ format: 'uuid' })
  picklistLineId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ format: 'uuid', description: 'The suggested bin (the walk stop)' })
  binId!: string;

  @ApiProperty({ description: 'The suggested bin’s code — the walk key' })
  binCode!: string;

  @ApiProperty({ type: String, nullable: true })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ description: 'Units to draw at this stop' })
  qty!: number;

  @ApiProperty({ description: 'The order line’s slice index' })
  sliceSeq!: number;

  @ApiProperty({ description: 'Position on the walk (bins.code ascending)' })
  walkSeq!: number;

  @ApiProperty({ description: 'Distinct bin stops left on this picklist’s walk' })
  stopCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Story 4.3b (AD-14): the stop bin’s state_epoch at snapshot time — opaque, compared only for equality. The device carries it back on the queued pick so the server can classify a conflict instead of rejecting blindly. Null when the bin has no epoch row yet (no movement has ever touched it).',
  })
  binStateEpoch!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Story 11.7: the parent kit SKU\'s code when this task\'s order line is a kit component (order_lines.parent_line_id), null on an ordinary line. Display-only — the device renders "from kit {code}" in the task header; no pick logic reads kit-ness.',
  })
  kitParentSkuCode!: string | null;

  @ApiProperty({
    enum: [...ORDER_PRIORITIES],
    description: "Story 4-2a — the task's order priority (display: the stop's chip). The walk stays in bin order.",
  })
  orderPriority!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date',
    description: "Story 4-2a — the task's order ship-by date (IST, YYYY-MM-DD); null when none.",
  })
  orderShipByDate!: string | null;

  // ── Story 4-3a — OPTIONAL: an older server omits them; the device then shows its pre-4-3a text. ──
  @ApiProperty({ type: String, nullable: true, required: false, format: 'date', description: "Story 4-3a — the suggested batch's expiry date (IST, YYYY-MM-DD); null when undated or none" })
  batchExpiryDate?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    format: 'date',
    description: "Story 4-3a — the IST date the suggested batch's LOT was first received in the tenant (batches.created_at — a lot received again keeps its first date); null when none",
  })
  batchReceivedOn?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    enum: [...ALLOCATION_RULES, null],
    description: 'Story 4-3a — the allocation rule this line was planned under (frozen at generate); null on a line planned before 4-3a (drawn as fefo with no minimum)',
  })
  allocationRule?: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    required: false,
    minimum: MIN_OUTBOUND_SHELF_LIFE_DAYS_MIN,
    maximum: MIN_OUTBOUND_SHELF_LIFE_DAYS_MAX,
    description: 'Story 4-3a — the minimum remaining shelf life (IST days) this line was planned under (frozen); null when none',
  })
  minOutboundShelfLifeDays?: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    description: "Story 4-3b — the consignee (partner display name) whose shelf-life rule the line was planned under; null when none. Display only — an older server omits it",
  })
  consigneeName?: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    required: false,
    minimum: CONSIGNEE_MIN_SHELF_LIFE_DAYS_MIN,
    maximum: CONSIGNEE_MIN_SHELF_LIFE_DAYS_MAX,
    description: "Story 4-3b — the consignee's effective minimum remaining shelf life (IST days) the line was planned under; null when none. Display only",
  })
  consigneeMinShelfLifeDays?: number | null;
}

// ── Packing (Story 4.5) ─────────────────────────────────────────────────────

/**
 * The parcel's measured box. All three arms are required INSIDE the object —
 * a box with two sides is not a measurement — and the whole object is
 * optional, which is what makes "weight and dimensions are optional" a shape
 * rather than a rule someone has to remember.
 */
export class PackDimensionsDto {
  @ApiProperty({ description: 'Length in millimetres', minimum: 1, maximum: MAX_DIMENSION_MM })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DIMENSION_MM)
  lengthMm!: number;

  @ApiProperty({ description: 'Width in millimetres', minimum: 1, maximum: MAX_DIMENSION_MM })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DIMENSION_MM)
  widthMm!: number;

  @ApiProperty({ description: 'Height in millimetres', minimum: 1, maximum: MAX_DIMENSION_MM })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DIMENSION_MM)
  heightMm!: number;
}

/** One scanned line at the bench: a SKU and the units counted into the parcel. */
export class PackScanLineDto {
  @ApiProperty({ format: 'uuid', description: 'The SKU the operator scanned' })
  @IsUUID()
  skuId!: string;

  @ApiProperty({
    description:
      'Units of this SKU counted into the parcel, in base UoM. Two lines naming the same SKU sum — the bench scans items, not lines.',
    minimum: 0.001,
    maximum: MAX_QUANTITY_BASE,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(MAX_QUANTITY_BASE)
  qty!: number;

  @ApiProperty({
    required: false,
    type: [String],
    format: 'uuid',
    maxItems: MAX_HANDLING_UNITS_PER_REQUEST,
    description:
      'Catch weight (story 10.3): the handling units of this SKU counted into the parcel — supplied PER SKU, never per order line, because the bench cannot tell which line of a two-line order a case belongs to. The server derives that split from the picks. Required for a catch-weight-tracked SKU (one id per picked unit), refused for every other SKU.',
  })
  @IsOptional()
  @IsArray()
  // The SAME named constant the command tier enforces request-wide.
  @ArrayMaxSize(MAX_HANDLING_UNITS_PER_REQUEST)
  @IsUUID('all', { each: true })
  handlingUnitIds?: string[];
}

/**
 * Story 4-5a (A7) — one carton of a pack: the units scanned into it and its
 * own measurements. The DEVICE shape (`DevicePackCartonDto`) omits the
 * dimensions — the handheld never measures boxes.
 */
export class DevicePackCartonDto {
  @ApiProperty({
    type: [PackScanLineDto],
    description: 'What the operator scanned into THIS carton (per SKU, summed as the top-level scan is). At least one line.',
    minItems: 1,
    maxItems: MAX_SCAN_LINES_PER_CARTON,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SCAN_LINES_PER_CARTON)
  @ValidateNested({ each: true })
  @Type(() => PackScanLineDto)
  scanned!: PackScanLineDto[];

  @ApiProperty({
    required: false,
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: MAX_WEIGHT_GRAMS,
    description: 'Optional carton weight in grams.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_WEIGHT_GRAMS)
  weightGrams?: number | null;
}

/** Story 4-5a (A7) — one carton on the web: the device shape plus optional dimensions. */
export class PackCartonDto extends DevicePackCartonDto {
  @ApiProperty({
    required: false,
    nullable: true,
    type: PackDimensionsDto,
    description: 'Optional carton dimensions in millimetres — all three sides together, or the object omitted.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PackDimensionsDto)
  dimensionsMm?: PackDimensionsDto | null;
}

const PACK_CARTONS_DOC =
  'Story 4-5a — optional: the cartons the parcel was packed into, in order (carton 1 first). Per SKU the cartons must add up to `scanned` exactly, a catch-weight case sits in exactly one carton, and the top-level weightGrams and dimensionsMm must then be absent (weigh each carton). Omitted, the pack is one carton holding the whole scan.';

/**
 * POST /tenants/{tenantId}/outbound/orders/{orderId}/pack body — the scanned
 * contents of the parcel, verified against what the order actually had
 * PICKED (never against what it ordered: after story 4.4 a short-picked order
 * legitimately reaches the bench with fewer units than its lines asked for).
 */
export class PackOrderDto {
  @ApiProperty({
    type: [PackScanLineDto],
    description:
      'What the operator scanned into the parcel. May be empty only when the order picked nothing at all (every stop reported an empty bin).',
    maxItems: MAX_SCAN_LINES,
  })
  @IsArray()
  @ArrayMaxSize(MAX_SCAN_LINES)
  @ValidateNested({ each: true })
  @Type(() => PackScanLineDto)
  scanned!: PackScanLineDto[];

  @ApiProperty({
    required: false,
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: MAX_WEIGHT_GRAMS,
    description: 'Optional parcel weight in grams. Absence is never an error; a non-positive value is a 400.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_WEIGHT_GRAMS)
  weightGrams?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: PackDimensionsDto,
    description: 'Optional parcel dimensions in millimetres — all three sides together, or the object omitted.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PackDimensionsDto)
  dimensionsMm?: PackDimensionsDto | null;

  @ApiProperty({
    required: false,
    type: [PackCartonDto],
    minItems: 1,
    maxItems: MAX_CARTONS_PER_PACK,
    description: PACK_CARTONS_DOC,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CARTONS_PER_PACK)
  @ValidateNested({ each: true })
  @Type(() => PackCartonDto)
  cartons?: PackCartonDto[];
}

/** Story 4-5a — one SKU in one packed carton (base units). */
export class PackedCartonLineDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ description: 'Units of this SKU in the carton, in base UoM' })
  qty!: number;
}

/** Story 4-5a — one carton of a pack, as the pack response carries it. */
export class PackedCartonDto {
  @ApiProperty({ minimum: 1, maximum: MAX_CARTONS_PER_PACK })
  seq!: number;

  @ApiProperty({ description: 'The carton code printed on its label: the parcel tag + ".{pack}.{carton}"' })
  code!: string;

  @ApiProperty({ type: Number, nullable: true })
  weightGrams!: number | null;

  @ApiProperty({ type: PackDimensionsDto, nullable: true })
  dimensionsMm!: PackDimensionsDto | null;

  @ApiProperty({ description: 'Units in the carton, in base UoM (across SKUs — a count, not a measure)' })
  unitCount!: number;

  @ApiProperty({ type: [PackedCartonLineDto] })
  lines!: readonly PackedCartonLineDto[];
}

/** One line of the packing slip. */
export class PackedLineDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ description: 'What the order asked for' })
  orderedQty!: number;

  @ApiProperty({ description: 'What is actually in the parcel — the PICKED units' })
  packedQty!: number;

  @ApiProperty({ description: 'Derived: orderedQty − packedQty (non-zero on a short-picked line)' })
  shortfallQty!: number;

  @ApiProperty({ format: 'uuid', description: 'The pack.packed event this line’s verification was journalled as' })
  ledgerEventId!: string;
}

/**
 * The packing slip as a STRUCTURED PAYLOAD — the repo has no PDF, template or
 * download machinery, so rendering belongs to whichever surface prints it.
 * This is also the idempotency snapshot: a replay re-serves the same slip.
 */
export class PackDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ enum: [...ORDER_STATUSES], description: 'Always ready_to_dispatch on a successful pack' })
  orderStatus!: string;

  @ApiProperty({ enum: [...ORDER_SOURCES] })
  source!: string;

  @ApiProperty({ type: String, nullable: true })
  integrationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  externalEventId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    maxLength: MAX_CLIENT_ORDER_REF_LENGTH,
    pattern: CLIENT_ORDER_REF_RE.source,
    description:
      "Story 4-1b — the client's own order number (null when none was given). Absent only on a replayed response stored before 4-1b — read absent as null",
  })
  clientOrderRef?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    enum: [...ORDER_TYPES, null],
    description: `${ORDER_TYPE_DOC} Absent only on a replayed response stored before 4-2a — read absent as null.`,
  })
  orderType?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    enum: [...ORDER_PRIORITIES, null],
    description: `${ORDER_PRIORITY_DOC} Absent only on a replayed response stored before 4-2a — read absent as null.`,
  })
  priority?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    format: 'date',
    description: `${SHIP_BY_DATE_DOC} Absent only on a replayed response stored before 4-2a — read absent as null.`,
  })
  shipByDate?: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    description: `${COD_AMOUNT_DOC} Absent only on a replayed response stored before 4-2a — read absent as null.`,
  })
  codAmountPaise?: number | null;

  @ApiProperty({ format: 'uuid', description: 'The operator who packed it' })
  packedBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC pack time' })
  packedAt!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Parcel weight in grams; null when unmeasured' })
  weightGrams!: number | null;

  @ApiProperty({ type: PackDimensionsDto, nullable: true, description: 'Parcel dimensions in millimetres; null when unmeasured' })
  dimensionsMm!: PackDimensionsDto | null;

  @ApiProperty({ description: 'Total units in the parcel — the sum of every line’s packedQty' })
  totalUnits!: number;

  @ApiProperty({ type: [PackedLineDto] })
  lines!: readonly PackedLineDto[];

  @ApiProperty({
    required: false,
    minimum: 1,
    description: 'Story 4-5a — the pack number (1 at pack). Absent only on a replayed response stored before 4-5a — read absent as 1.',
  })
  packSeq?: number;

  @ApiProperty({
    required: false,
    type: () => [PackedCartonDto],
    description: 'Story 4-5a — the cartons the parcel was packed into. Absent only on a replayed response stored before 4-5a — read absent as one carton.',
  })
  cartons?: readonly PackedCartonDto[];
}

export class PackResponse {
  @ApiProperty({ type: PackDto })
  pack!: PackDto;
}

/**
 * POST /tenants/{tenantId}/outbound/packs body — the DEVICE pack route
 * (story 10.7). The same scan shape the tenant pack route verifies
 * (`PackOrderDto`, inherited validators and all), with the order id moved
 * into the BODY because a device route names no path order id. The device
 * client never captures parcel dimensions, so `dimensionsMm` is OMITTED —
 * the OpenAPI stops advertising it and (the whitelist pipe runs
 * `forbidNonWhitelisted`) a device body that sends it is REFUSED with a 400;
 * the web surface keeps the arm (review W6, story 10.7).
 */
export class DevicePackDto extends OmitType(PackOrderDto, ['dimensionsMm', 'cartons'] as const) {
  @ApiProperty({ format: 'uuid', description: 'The fully-picked order being packed' })
  @IsUUID()
  orderId!: string;

  @ApiProperty({
    required: false,
    type: [DevicePackCartonDto],
    minItems: 1,
    maxItems: MAX_CARTONS_PER_PACK,
    description: `${PACK_CARTONS_DOC} The device never measures boxes, so a carton carries no dimensionsMm.`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CARTONS_PER_PACK)
  @ValidateNested({ each: true })
  @Type(() => DevicePackCartonDto)
  cartons?: DevicePackCartonDto[];
}

// ── Cartons (Story 4-5a) ────────────────────────────────────────────────────

/** POST /tenants/{tenantId}/outbound/orders/{orderId}/cartons body — re-split a packed order (A8). */
export class RecartonOrderDto {
  @ApiProperty({
    type: [PackCartonDto],
    minItems: 1,
    maxItems: MAX_CARTONS_PER_PACK,
    description:
      'The new split, carton 1 first: per SKU it must hold exactly what was packed (and every catch-weight case, each in one carton).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CARTONS_PER_PACK)
  @ValidateNested({ each: true })
  @Type(() => PackCartonDto)
  cartons!: PackCartonDto[];

  @ApiProperty({ minLength: 1, maxLength: MAX_RECARTON_REASON_LENGTH, description: 'Why the order is re-packed (1–200 characters)' })
  @IsString()
  @Length(1, MAX_RECARTON_REASON_LENGTH)
  reason!: string;
}

export class PackCartonLineViewDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ description: 'The SKU’s base UoM' })
  uom!: string;

  @ApiProperty({ description: 'Units of this SKU in the carton, in base UoM' })
  qty!: number;

  @ApiProperty({ type: [String], nullable: true, description: 'Catch weight — the cases in this carton, sorted; null otherwise' })
  handlingUnitIds!: string[] | null;

  @ApiProperty({
    type: () => [CartonCaseViewDto],
    required: false,
    description: 'Catch weight — each case as a person finds it (beside handlingUnitIds, same order): its label’s barcode text and its receipt weight',
  })
  handlingUnits?: CartonCaseViewDto[];
}

export class CartonCaseViewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'The case label’s barcode text (a case label encodes its handling-unit id)' })
  code!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Grams captured at receipt; null when the case is no longer on record' })
  weightGrams!: number | null;
}

export class UomTotalDto {
  @ApiProperty()
  uom!: string;

  @ApiProperty({ description: 'Base units of this UoM' })
  qty!: number;
}

export class PackCartonViewDto {
  @ApiProperty({ minimum: 1, maximum: MAX_CARTONS_PER_PACK })
  seq!: number;

  @ApiProperty({ description: 'The carton code on its label: the parcel tag + ".{pack}.{carton}"' })
  code!: string;

  @ApiProperty({ type: Number, nullable: true })
  weightGrams!: number | null;

  @ApiProperty({ type: PackDimensionsDto, nullable: true })
  dimensionsMm!: PackDimensionsDto | null;

  @ApiProperty({ description: 'SKUs in the carton' })
  lineCount!: number;

  @ApiProperty({ type: [UomTotalDto], description: 'Per-UoM totals — never a cross-UoM unit total' })
  totals!: UomTotalDto[];

  @ApiProperty({ type: [PackCartonLineViewDto] })
  lines!: PackCartonLineViewDto[];
}

export class PackViewDto {
  @ApiProperty({ minimum: 1, maximum: MAX_PACK_SEQ })
  packSeq!: number;

  @ApiProperty({ enum: [...ORDER_PACK_STATUSES] })
  status!: string;

  @ApiProperty({ description: 'True for an order packed before cartons were recorded (one virtual carton)' })
  legacy!: boolean;

  @ApiProperty({ description: 'False when the documents print the live parties ("Party details are current, not as at packing")' })
  partiesFrozen!: boolean;

  @ApiProperty()
  cartonCount!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Σ carton weights when every carton is weighed, else null' })
  grossWeightGrams!: number | null;

  @ApiProperty({ description: 'ISO-8601 UTC — the physical pack (a re-carton keeps it)' })
  packedAt!: string;

  @ApiProperty({ format: 'uuid' })
  packedBy!: string;

  @ApiProperty({ type: [PackCartonViewDto] })
  cartons!: PackCartonViewDto[];
}

export class PackHistoryDto {
  @ApiProperty()
  packSeq!: number;

  @ApiProperty({ enum: [...ORDER_PACK_STATUSES] })
  status!: string;

  @ApiProperty()
  cartonCount!: number;

  @ApiProperty({ type: String, nullable: true })
  endedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  endedBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  endReason!: string | null;
}

export class OrderCartonsResponse {
  @ApiProperty({ type: PackViewDto, description: 'The live pack, else the latest (a cancelled order shows its cancelled pack)' })
  pack!: PackViewDto;

  @ApiProperty({ type: [PackHistoryDto], description: 'Every pack of the order, newest first' })
  history!: PackHistoryDto[];
}

export class RecartonResponse {
  @ApiProperty({ type: PackViewDto, description: 'The live pack after the re-carton' })
  pack!: PackViewDto;

  @ApiProperty({ description: 'True when the split was the live one — nothing was written' })
  unchanged!: boolean;

  @ApiProperty({ description: 'True when a client label’s verification was cleared — re-verify the client label on the new boxes' })
  clientLabelReverify!: boolean;
}

// ── Dispatch (Story 4.6) ────────────────────────────────────────────────────

/**
 * POST /tenants/{tenantId}/outbound/orders/{orderId}/dispatch body — the
 * order's terminal transition. Both fields are OPTIONAL free text (the human
 * decision, 2026-09-15): an operator shipping by a manual courier records
 * what they have today, and the carrier-adapter stories later replace them
 * with a real carrier id and an adapter-issued tracking number. An empty
 * body is a complete, valid dispatch.
 */
export class DispatchOrderDto {
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    maxLength: MAX_CARRIER_NAME_LENGTH,
    description:
      'Optional free-text carrier (e.g. a manual courier). Absence is never an error; a blank string is treated as absent.',
  })
  @IsOptional()
  @IsString()
  @Trim()
  @Length(0, MAX_CARRIER_NAME_LENGTH)
  carrierName?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    maxLength: MAX_TRACKING_NUMBER_LENGTH,
    description:
      'Optional free-text tracking or consignment reference. Absence is never an error; a blank string is treated as absent.',
  })
  @IsOptional()
  @IsString()
  @Trim()
  @Length(0, MAX_TRACKING_NUMBER_LENGTH)
  trackingNumber?: string | null;
}

/** One line of the dispatch record. */
export class DispatchedLineDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ description: 'What the order asked for' })
  orderedQty!: number;

  @ApiProperty({ description: 'What actually shipped for this line — the PICKED units' })
  dispatchedQty!: number;

  @ApiProperty({ description: 'Derived: orderedQty − dispatchedQty (non-zero on a short-picked line)' })
  shortfallQty!: number;

  @ApiProperty({ format: 'uuid', description: 'The dispatch.dispatched event this line’s shipment was journalled as' })
  ledgerEventId!: string;
}

/**
 * The dispatch record — also the idempotency snapshot, so a replay re-serves
 * it unchanged. `dispatched` is terminal: there is no un-dispatch, no return
 * and no re-open.
 */
export class DispatchDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ enum: [...ORDER_STATUSES], description: 'Always dispatched on a successful dispatch' })
  orderStatus!: string;

  @ApiProperty({ enum: [...ORDER_SOURCES] })
  source!: string;

  @ApiProperty({ type: String, nullable: true })
  integrationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  externalEventId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    maxLength: MAX_CLIENT_ORDER_REF_LENGTH,
    pattern: CLIENT_ORDER_REF_RE.source,
    description:
      "Story 4-1b — the client's own order number (null when none was given). Absent only on a replayed response stored before 4-1b — read absent as null",
  })
  clientOrderRef?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    enum: [...ORDER_TYPES, null],
    description: `${ORDER_TYPE_DOC} Absent only on a replayed response stored before 4-2a — read absent as null.`,
  })
  orderType?: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    description: `${COD_AMOUNT_DOC} Absent only on a replayed response stored before 4-2a — read absent as null.`,
  })
  codAmountPaise?: number | null;

  @ApiProperty({ format: 'uuid', description: 'The operator who dispatched it' })
  dispatchedBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC dispatch time' })
  dispatchedAt!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Free-text carrier; null when none was recorded' })
  carrierName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Free-text tracking reference; null when none was recorded' })
  trackingNumber!: string | null;

  @ApiProperty({ description: 'Total units shipped — the sum of every line’s dispatchedQty' })
  totalUnits!: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description:
      'Story 4-2c — the follow-on order this dispatch opened for what did not ship (accepted, every line backordered; it ships when stock arrives — `followOnSeq + 1`, or 1, names it `-BO{n}`); null when everything shipped. Absent only on a replayed response stored before 4-2c — read absent as null.',
  })
  followOnOrderId?: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, required: false, description: 'Story 4-2c — THIS order\'s parent when it is itself a follow-on; null on a root. Absent before 4-2c.' })
  followOnOfOrderId?: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, required: false, description: "Story 4-2c — THIS order's chain root when it is a follow-on; null on a root. Absent before 4-2c." })
  followOnRootOrderId?: string | null;

  @ApiProperty({ type: Number, nullable: true, required: false, description: "Story 4-2c — THIS order's `-BO{seq}` when it is a follow-on; null on a root. Absent before 4-2c." })
  followOnSeq?: number | null;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'The reservation holds this dispatch retired committed → released — the ATP correction. Empty when the order had none left to retire.',
  })
  retiredReservationIds!: readonly string[];

  @ApiProperty({ type: [DispatchedLineDto] })
  lines!: readonly DispatchedLineDto[];
}

export class DispatchResponse {
  @ApiProperty({ type: DispatchDto })
  dispatch!: DispatchDto;
}

// ── Label + manifest (Story 4.6c) ───────────────────────────────────────────

/**
 * POST /tenants/{tenantId}/outbound/orders/{orderId}/label body — the 4.6c
 * label command. The connection is REQUIRED (a label generates through one
 * configured carrier account); the measurements are OPTIONAL and share the
 * pack bounds (the same constants — the two gates cannot disagree).
 */
export class LabelOrderDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'The carrier connection (this tenant’s) the label generates through. A foreign tenant’s connection id is a 404.',
  })
  @IsUUID()
  carrierConnectionId!: string;

  @ApiProperty({
    required: false,
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: MAX_WEIGHT_GRAMS,
    description: 'Optional parcel weight in grams, same bounds as pack. Absence is never an error.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_WEIGHT_GRAMS)
  weightGrams?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: PackDimensionsDto,
    description: 'Optional parcel dimensions in millimetres — all three sides together, or the object omitted.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PackDimensionsDto)
  dimensionsMm?: PackDimensionsDto | null;
}

/** The shipment — one label per order, the adapter-issued identity of the parcel. */
export class ShipmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({
    enum: [...SHIPMENT_STATUSES],
    description:
      'labelled, manifested, (story 4-2b) voided — the label of an order cancelled before it was manifested, or replaced — or (story 4-4a) handed_over — a client-arranged shipment closed by a courier handover',
  })
  status!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The connection the label generated through; null on a client-arranged shipment (story 4-4a)' })
  carrierConnectionId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The adapter code at label time; null on a client-arranged shipment (story 4-4a)' })
  carrierCode!: string | null;

  @ApiProperty({ description: 'The registry display name resolved at label time' })
  carrierName!: string;

  @ApiProperty({ description: 'The adapter-issued tracking number — what dispatch auto-stamps' })
  trackingNumber!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The adapter’s opaque handle for the label document — never the bytes; null on a client-arranged shipment (story 4-4a)' })
  labelDocumentRef!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Parcel weight in grams; null when unmeasured' })
  weightGrams!: number | null;

  @ApiProperty({ type: PackDimensionsDto, nullable: true, description: 'Parcel dimensions; null when unmeasured' })
  dimensionsMm!: PackDimensionsDto | null;

  @ApiProperty({ format: 'uuid', description: 'The operator who labelled it' })
  labelledBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC label time' })
  labelledAt!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The manifest the shipment closed onto; null while labelled' })
  manifestId!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    description: `${COD_AMOUNT_DOC} Absent only on a replayed response stored before 4-2a — read absent as null.`,
  })
  codAmountPaise?: number | null;

  @ApiProperty({ type: String, nullable: true, required: false, description: 'Story 4-2b — when the label was voided (status voided); null otherwise. Absent on a response stored before 4-2b — read absent as null.' })
  voidedAt?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, format: 'uuid', description: 'Story 4-2b — who voided it; null otherwise. Absent on a response stored before 4-2b.' })
  voidedBy?: string | null;

  @ApiProperty({ enum: [...SHIPMENT_KINDS], required: false, description: 'Story 4-4a — carrier (an adapter label), client-label (the client’s label PDF) or courier-label (the courier brings the label). Absent on a label response (read absent as carrier).' })
  kind?: string;

  @ApiProperty({ type: Number, nullable: true, required: false, description: 'Story 4-4a — parcels in the shipment (1–999); absent on a label response.' })
  packageCount?: number | null;

  @ApiProperty({ type: String, nullable: true, required: false, description: 'Story 4-4a — when the client label was scanned onto the parcel; absent on a label response.' })
  labelVerifiedAt?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, format: 'uuid', description: 'Story 4-4a — the courier handover that closed it; absent on a label response.' })
  handoverId?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false, description: 'Story 4-4a — when it was handed over; absent on a label response.' })
  handedOverAt?: string | null;
}

export class ShipmentResponse {
  @ApiProperty({ type: ShipmentDto })
  shipment!: ShipmentDto;
}

// ── story 4-2b: cancel with restock ─────────────────────────────────────────

/** `POST …/orders/{orderId}/cancel-with-restock` body. */
export class CancelOrderWithRestockDto {
  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'ONE storage bin of the order’s warehouse every drawn unit goes back to. Absent (or null): each draw returns to the bin it was drawn from. The bin passes every placement gate (system, retired, blocked, storage class, dedicated client, secure, bulk, hazard, capacity, weight, volume, fit) and the reconcile-quarantine check',
  })
  @IsOptional()
  @IsUUID()
  restockBinId?: string | null;
}

/** One put-back line of a cancel-with-restock (base units). */
export class RestockLineDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ description: 'The SKU’s base unit of measure' })
  uom!: string;

  @ApiProperty({ format: 'uuid', description: 'The bin the units were booked into' })
  toBinId!: string;

  @ApiProperty()
  toBinCode!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ description: 'Units put back, base UoM' })
  qty!: number;

  @ApiProperty({ description: 'Serial-tracked units among them (the serial numbers are on the ledger)' })
  serialCount!: number;

  @ApiProperty({ type: String, nullable: true, description: 'The open live recall (RCL-…) the lot is on — its units stay blocked wherever they land; null otherwise' })
  recallCode!: string | null;
}

export class VoidedShipmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  carrierName!: string;

  @ApiProperty()
  trackingNumber!: string;
}

export class RestockSummaryDto {
  @ApiProperty({ format: 'uuid', description: 'The restock — every pick.restocked event of this cancel names it' })
  restockId!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  restockedAt!: string;

  @ApiProperty({ enum: ['origin', 'bin'], description: 'origin — every draw went back to its own bin; bin — all into restockBinId' })
  destination!: 'origin' | 'bin';

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  restockBinId!: string | null;

  @ApiProperty({ type: [RestockLineDto] })
  lines!: RestockLineDto[];

  @ApiProperty({ description: 'Σ lines[].qty, base units' })
  totalUnits!: number;

  @ApiProperty({ description: 'The order’s planned / unfulfillable pick lines withdrawn' })
  cancelledPickLineCount!: number;

  @ApiProperty({ type: [String] })
  releasedReservationIds!: string[];

  @ApiProperty({ type: [String] })
  retiredReservationIds!: string[];

  @ApiProperty({ type: [String], description: 'Catch-weight cases the pack consumed, now active again' })
  handlingUnitIds!: string[];

  @ApiProperty({ type: VoidedShipmentDto, nullable: true, description: 'The labelled, unmanifested shipment this cancel voided; null when there was none' })
  voidedShipment!: VoidedShipmentDto | null;
}

export class CancelWithRestockResponse {
  @ApiProperty({ type: OrderDto })
  order!: OrderDto;

  @ApiProperty({ type: RestockSummaryDto, nullable: true, description: 'null only when the order was already cancelled (the idempotent no-op)' })
  restock!: RestockSummaryDto | null;
}

export class RestockPlanLineDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty()
  uom!: string;

  @ApiProperty({ format: 'uuid', description: 'The bin the units were drawn from' })
  fromBinId!: string;

  @ApiProperty()
  fromBinCode!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ description: 'Units still to put back, base UoM' })
  qty!: number;

  @ApiProperty({ type: [String], description: 'The serials to scan back' })
  serialNumbers!: string[];

  @ApiProperty({ type: String, nullable: true, description: 'The open live recall the lot is on; null otherwise' })
  recallCode!: string | null;
}

export class RestockedEntryDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty()
  uom!: string;

  @ApiProperty({ format: 'uuid' })
  toBinId!: string;

  @ApiProperty()
  toBinCode!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  batchId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ description: 'Units put back, base UoM' })
  qty!: number;

  @ApiProperty()
  serialCount!: number;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  restockedAt!: string;

  @ApiProperty({ format: 'uuid' })
  restockId!: string;

  @ApiProperty({ type: String, nullable: true })
  recallCode!: string | null;
}

export class RestockPlanShipmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: [...SHIPMENT_STATUSES] })
  status!: string;

  @ApiProperty()
  carrierName!: string;

  @ApiProperty()
  trackingNumber!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  manifestId!: string | null;
}

export class RestockPlanResponse {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ enum: [...ORDER_STATUSES] })
  orderStatus!: string;

  @ApiProperty({ type: RestockPlanShipmentDto, nullable: true, description: 'The order’s shipment (any status); null before a label' })
  shipment!: RestockPlanShipmentDto | null;

  @ApiProperty({ type: [RestockPlanLineDto], description: 'The draws still to put back — empty unless the order is accepted or ready_to_dispatch' })
  lines!: RestockPlanLineDto[];

  @ApiProperty({ type: [RestockedEntryDto], description: 'What a cancel already put back (the "Put back" list)' })
  restocked!: RestockedEntryDto[];
}

/**
 * POST /tenants/{tenantId}/warehouses/{warehouseId}/outbound/manifests body —
 * the 4.6c manifest command: a non-empty, bounded set of labelled shipments,
 * all on ONE carrier connection, all in this warehouse. Duplicates collapse
 * and order is irrelevant (the set is the intent).
 */
export class CreateManifestDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: MAX_MANIFEST_SHIPMENTS,
    description: 'The labelled shipments to close (≥ 1, at most 500; duplicates collapse).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MANIFEST_SHIPMENTS)
  @IsUUID('all', { each: true })
  shipmentIds!: string[];
}

/** One header row of the manifest list. */
export class ManifestDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'The ONE connection every closed shipment labelled through' })
  carrierConnectionId!: string;

  @ApiProperty({ description: 'The adapter code at manifest time' })
  carrierCode!: string;

  @ApiProperty({ description: 'How many shipments the manifest closed' })
  shipmentCount!: number;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    required: false,
    description:
      'The closed shipment ids — carried by the CREATE response only (the idempotency snapshot); list rows are header rows (the shipments point back through their manifestId)',
  })
  shipmentIds?: readonly string[];

  @ApiProperty({
    type: Number,
    required: false,
    description:
      "Story 4-2a — how many of the manifest's shipments are cash on delivery (the courier's hand-over count); frozen in the create snapshot, computed the same way on a list row. Absent only on a replayed create stored before 4-2a — read absent as 0.",
  })
  codShipmentCount?: number;

  @ApiProperty({
    type: Number,
    required: false,
    description:
      "Story 4-2a — the cash the courier collects across the manifest's COD shipments, integer paise (0 when none). Frozen in the create snapshot; a list row computes the same (order COD never changes). Absent only on a replayed create stored before 4-2a — read absent as 0.",
  })
  codTotalPaise?: number;

  @ApiProperty({ format: 'uuid', description: 'The operator who created it' })
  createdBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC manifest time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC manifest time' })
  updatedAt!: string;
}

export class ManifestResponse {
  @ApiProperty({ type: ManifestDto })
  manifest!: ManifestDto;
}

export class ManifestListResponse {
  @ApiProperty({ type: [ManifestDto] })
  items!: ManifestDto[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor; null when exhausted' })
  nextCursor!: string | null;
}

// ── Rate shopping (Story 4.6d) ──────────────────────────────────────────────

/** One quoted item's money — integer paise (AD-9), an INR rate. */
export class RateQuoteDto {
  @ApiProperty({
    type: Number,
    description: 'The quote in integer paise — the sandbox arm’s deterministic formula',
  })
  amountPaise!: number;
}

/** One refused item — the carrier's typed refusal, in the problem's own words. */
export class RateRefusalDto {
  @ApiProperty({ description: 'The machine-readable problem code the client branches on' })
  code!: string;

  @ApiProperty({ type: Number, description: 'The problem’s HTTP status (501 for an unconfigured transport)' })
  status!: number;

  @ApiProperty({ description: 'The problem’s title' })
  title!: string;

  @ApiProperty({ description: 'The problem’s detail' })
  detail!: string;
}

/** One live connection's answer: quoted OR refused, exactly one. */
export class RateItemDto {
  @ApiProperty({ format: 'uuid', description: 'The carrier connection that produced this item' })
  connectionId!: string;

  @ApiProperty({ description: 'The adapter code (items are sorted by it)' })
  carrierCode!: string;

  @ApiProperty({ description: 'The carrier’s display name' })
  carrierName!: string;

  @ApiProperty({ type: RateQuoteDto, nullable: true, description: 'The quote — null on a refused item' })
  quote!: RateQuoteDto | null;

  @ApiProperty({ type: RateRefusalDto, nullable: true, description: 'The typed refusal — null on a quoted item' })
  refusal!: RateRefusalDto | null;
}

/** The rate-shopping read's answer — recomputed per request, never stored. */
export class OrderRatesDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ type: [RateItemDto], description: 'One item per live carrier connection, sorted by carrierCode' })
  items!: RateItemDto[];
}

export class OrderRatesResponse {
  @ApiProperty({ type: OrderRatesDto })
  rates!: OrderRatesDto;
}

// ── story 9-1: the dashboard's outbound fact lists ─────────────────────────

/** Query of a windowed fact list (pack failures, backorder refusals): `[from, to)` on `created_at`. */
export class OutboundWindowListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only rows of one client's orders or SKUs. An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, format: 'date-time', description: FROM_DESCRIPTION('created_at') })
  @IsOptional()
  @IsInstant()
  from?: string;

  @ApiProperty({ required: false, format: 'date-time', description: TO_DESCRIPTION('created_at') })
  @IsOptional()
  @IsInstant()
  to?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** Query of the picklist-line list: optional status, `[from, to)` on `updated_at` (the flip time of a terminal status). */
export class PicklistLineListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "Story 1-5a — only lines of one client's orders. An unknown id is an empty page" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, enum: [...PICKLIST_LINE_STATUSES], description: 'Only lines in this status' })
  @IsOptional()
  @IsIn(PICKLIST_LINE_STATUSES)
  status?: (typeof PICKLIST_LINE_STATUSES)[number];

  @ApiProperty({
    required: false,
    type: String,
    enum: ['true', 'false'],
    description:
      "Story 3-3b — `true`: only stops skipped because their bin was blocked (reasonCode `skipped-blocked-bin`); `false`: every other line (the short-picks tile's drill — a skip is warehouse state, not a picking error). Exactly 'true' or 'false'",
  })
  @IsOptional()
  @BooleanFlag()
  @IsBoolean()
  skippedBlockedBin?: boolean;

  @ApiProperty({ required: false, format: 'date-time', description: FROM_DESCRIPTION('updated_at') })
  @IsOptional()
  @IsInstant()
  from?: string;

  @ApiProperty({ required: false, format: 'date-time', description: TO_DESCRIPTION('updated_at') })
  @IsOptional()
  @IsInstant()
  to?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class PackFailureMismatchDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ description: `What the order had picked. ${QUANTITY_FIELD_DESCRIPTION}` })
  pickedQty!: number;

  @ApiProperty({ description: `What the bench scanned. ${QUANTITY_FIELD_DESCRIPTION}` })
  scannedQty!: number;
}

export class PackFailureEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ enum: [...PACK_FAILURE_ENTRIES], description: 'The entry path: the tenant route, the device bench route, or a device sync-report apply' })
  entry!: string;

  @ApiProperty({ format: 'uuid' })
  actorUserId!: string;

  @ApiProperty({ type: [PackFailureMismatchDto], description: 'Every SKU whose scan differed from the pick' })
  mismatch!: readonly PackFailureMismatchDto[];

  @ApiProperty({ description: 'ISO-8601 UTC — when the refused attempt was recorded (server time)' })
  createdAt!: string;
}

export class PackFailureListResponse {
  @ApiProperty({ type: [PackFailureEntryDto] })
  items!: readonly PackFailureEntryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class BackorderRefusalLineDto {
  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ description: `What the channel order asked for. ${QUANTITY_FIELD_DESCRIPTION}` })
  requestedQty!: number;

  @ApiProperty({ description: `What could be reserved at grant time. ${QUANTITY_FIELD_DESCRIPTION}` })
  availableQty!: number;
}

export class BackorderRefusalEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  integrationId!: string;

  @ApiProperty({ description: "The channel's own order event id" })
  externalEventId!: string;

  @ApiProperty({ type: [BackorderRefusalLineDto], description: 'The lines that could not fully reserve' })
  lines!: readonly BackorderRefusalLineDto[];

  @ApiProperty({ description: 'ISO-8601 UTC — when the first delivery was refused (redeliveries add no row)' })
  createdAt!: string;
}

export class BackorderRefusalListResponse {
  @ApiProperty({ type: [BackorderRefusalEntryDto] })
  items!: readonly BackorderRefusalEntryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class PicklistLineEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  picklistId!: string;

  @ApiProperty({ format: 'uuid' })
  waveId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  binId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  binCode!: string | null;

  @ApiProperty({ description: `Planned quantity. ${QUANTITY_FIELD_DESCRIPTION}` })
  qty!: number;

  @ApiProperty({ description: `Never drawn. ${QUANTITY_FIELD_DESCRIPTION}` })
  shortfallQty!: number;

  @ApiProperty({ type: String, nullable: true, enum: [...SHORT_PICK_REASON_CODES, null] })
  reasonCode!: string | null;

  @ApiProperty({ enum: [...PICKLIST_LINE_STATUSES] })
  status!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC — the last transition (a terminal status: its flip time)' })
  updatedAt!: string;
}

export class PicklistLineListResponse {
  @ApiProperty({ type: [PicklistLineEntryDto] })
  items!: readonly PicklistLineEntryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

// ── story 4-1c: the order import ──────────────────────────────────────────────

/** `POST …/outbound/order-imports` multipart fields (beside the `file`). */
export class ImportOrdersDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse every order of the file is for (the Orders page’s selected warehouse)' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({
    required: false,
    enum: ['true', 'false'],
    description: '`true`: Check file — every order through the create’s rules, nothing written (no Idempotency-Key needed). Omitted or `false`: Import',
  })
  @IsOptional()
  @BooleanFlag()
  @IsBoolean()
  dryRun?: boolean;
}

/** One refused row of an order import. */
export class OrderImportRowErrorDto {
  @ApiProperty({ example: 7, description: 'The spreadsheet row — the header is row 1' })
  rowNumber!: number;

  @ApiProperty({ type: String, nullable: true, example: 'SO-1042', description: 'The row’s order_ref (trimmed); null when blank' })
  orderRef!: string | null;

  @ApiProperty({
    enum: [...ORDER_IMPORT_ROW_ERROR_CODES],
    description:
      'Why the row (and with it its whole order) was refused — the file’s rules, the create’s own refusal passed through with its detail (an order’s refusal sits on its first row), order-changed-since-first-run, or order-refused (any other code, named in the detail)',
  })
  code!: OrderImportRowErrorCode;

  @ApiProperty({ example: 'No SKU with code "GLOW-SERUM-X" exists in this tenant.' })
  detail!: string;

  @ApiProperty({ type: String, nullable: true, example: 'GLOW-SERUM-X', description: 'The row’s sku cell as written; null when blank' })
  sku!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '12', description: 'The row’s quantity cell as written; null when blank' })
  quantity!: string | null;
}

/** One order the import created — or, on a dry run, found ready. */
export class OrderImportOrderDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'The created order; null on a dry run' })
  orderId!: string | null;

  @ApiProperty({ example: 'SO-1042', description: 'The client order number (the order_ref cell, trimmed)' })
  clientOrderRef!: string;

  @ApiProperty({ example: 3, description: 'Top-level lines (a kit line counts once)' })
  lineCount!: number;

  @ApiProperty({ example: 2, description: 'The spreadsheet row of the order’s first line' })
  firstRow!: number;

  @ApiProperty({ description: 'True when an earlier run of the same import created this order (it replayed)' })
  replayed!: boolean;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ example: 'ACME', description: 'The client as people read it (the tenant’s own: "<name> (your company)")' })
  clientLabel!: string;

  @ApiProperty({ type: Number, nullable: true, example: 1, description: 'Top-level lines left backordered (a kit counts once); null on a dry run' })
  backorderedLineCount!: number | null;
}

/** `POST …/outbound/order-imports` — the result (and, for a complete import, the idempotency snapshot). */
export class OrderImportResponseDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'The import (its audit row’s target); null on a dry run and on an incomplete run' })
  importId!: string | null;

  @ApiProperty()
  dryRun!: boolean;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ description: 'SHA-256 of the uploaded file (hex) — with the warehouse, the import’s idempotency fingerprint' })
  fileSha256!: string;

  @ApiProperty({ description: 'Data rows read (blank rows not counted)' })
  rowCount!: number;

  @ApiProperty({ description: 'Orders the file describes' })
  orderCount!: number;

  @ApiProperty({ description: 'Orders created — on a dry run, ready to create' })
  acceptedCount!: number;

  @ApiProperty({ description: 'Orders refused whole (an order with any bad row)' })
  refusedCount!: number;

  @ApiProperty({ description: 'False when the 15-second budget stopped the run before every order was tried (answered 200, nothing stored) — Import again with the same file to finish; on a Check, the orders not reached were not checked' })
  complete!: boolean;

  @ApiProperty({ description: 'Orders the run did not reach (0 when complete)' })
  notAttemptedCount!: number;

  @ApiProperty({ type: [OrderImportOrderDto] })
  orders!: OrderImportOrderDto[];

  @ApiProperty({ type: [OrderImportRowErrorDto], description: 'Every refused row, in sheet order' })
  errors!: OrderImportRowErrorDto[];
}

// ── Story 4-2c — "Allocate now" ─────────────────────────────────────────────

export class AllocatedLineDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ description: 'Ordered, base units' })
  qty!: number;

  @ApiProperty({ description: 'What the line now holds, base units (may be below qty — a partial grant, as at acceptance)' })
  reservedQty!: number;
}

export class StillShortLineDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ description: 'Still awaiting stock, base units' })
  shortQty!: number;
}

export class SkippedAllocationLineDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({
    enum: [...ALLOCATION_SKIP_REASONS],
    description:
      "Why the line was not reserved this run: `sku-inactive` — the SKU is inactive and its stock does not cover the line in full (an inactive SKU sells existing stock only); `licence-not-covered` — licence enforcement is on and the order's goods are not covered at this warehouse today; `contended` — another allocation reserved it at the same moment",
  })
  reason!: string;
}

export class AllocationDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ type: [AllocatedLineDto], description: 'Lines reserved by this run (empty when nothing could be — still 200)' })
  allocated!: AllocatedLineDto[];

  @ApiProperty({ type: [StillShortLineDto], description: 'Eligible lines still awaiting stock after this run' })
  stillShort!: StillShortLineDto[];

  @ApiProperty({ type: [SkippedAllocationLineDto], description: 'Eligible lines this run did not reserve, with the reason' })
  skipped!: SkippedAllocationLineDto[];
}

export class AllocateOrderResponse {
  @ApiProperty({ type: AllocationDto })
  allocation!: AllocationDto;
}


// ── Story 4-3b — the order's customer shelf life read ───────────────────────

export class OrderShelfLifeConsigneeDto {
  @ApiProperty({ format: 'uuid' })
  partnerId!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ description: 'The partner display name' })
  name!: string;

  @ApiProperty({ type: 'integer', nullable: true, minimum: CONSIGNEE_MIN_SHELF_LIFE_DAYS_MIN, maximum: CONSIGNEE_MIN_SHELF_LIFE_DAYS_MAX })
  minShelfLifeDays!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, minimum: CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MIN, maximum: CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MAX })
  minShelfLifePercent!: number | null;
}

export class OrderShelfLifeResolvedPartnerDto {
  @ApiProperty({ format: 'uuid' })
  partnerId!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ description: 'The partner display name' })
  name!: string;
}

export class OrderShelfLifeLineDto {
  @ApiProperty({ format: 'uuid' })
  orderLineId!: string;

  @ApiProperty({ format: 'uuid' })
  skuId!: string;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty({ description: 'Base units the line holds (its reservation)' })
  reservedQty!: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      "The binding minimum remaining shelf life (IST days) a batch needs for this line: the larger of the client minimum and the consignee's effective minimum; null when neither applies, or when the line cannot be judged (judgeable: false)",
  })
  effectiveMinDays!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, description: "The SKU's total shelf life in days (the percent rule's base); null when not set" })
  shelfLifeBaseDays!: number | null;

  @ApiProperty({
    description:
      "False when the consignee has a percent rule and the SKU has no total shelf life — no dated batch can be shown to meet it (set the SKU's shelf life to fix)",
  })
  judgeable!: boolean;

  @ApiProperty({
    description:
      "Base units on hand in the order's warehouse's pickable bins that meet every rule, if waved today (other orders' claims ignored) — per line, after the earlier lines of the same SKU (in line order) have taken their reserved units",
  })
  qualifyingOnHand!: number;

  @ApiProperty({
    description:
      "What still qualifies after other open lines' claims are spent in rank order (not qualifyingOnHand minus claims); this order's own lines are not claims. Per line, after the earlier lines of the same SKU",
  })
  qualifyingUnclaimed!: number;

  @ApiProperty({ description: "Base units the client rule allows but the consignee's rule does not (undated or unattributed stock of a batch-tracked SKU included)" })
  belowConsigneeMinimumOnHand!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'When the line is on an open wave: the units its planned slices name (base units); null otherwise' })
  plannedQty!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'When the line is on an open wave: the units it planned as unfulfillable (base units); null otherwise' })
  shortfallQty!: number | null;

  @ApiProperty({ type: String, nullable: true, enum: [...SHORTFALL_CAUSES, null], description: "The planner's frozen cause of that shortfall; null when none or no stock at all" })
  shortfallCause!: string | null;
}

export class OrderShelfLifeDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'date', description: "The IST date judged on — the server's today, the date a wave generated now would plan on" })
  judgedOn!: string;

  @ApiProperty({ type: 'integer', nullable: true, description: "The order's client's minimum remaining shelf life at dispatch (4-3a); null when none" })
  clientMinShelfLifeDays!: number | null;

  @ApiProperty({
    enum: [...CONSIGNEE_RESOLUTIONS],
    description:
      "Why the consignee rule did or did not apply: no-gstin (the order names no consignee GSTIN), no-partner (no partner holds that GSTIN), no-consignee-link (the partner has no consignee link to the order's client), no-rule (the link sets no minimum), applied",
  })
  consigneeResolution!: string;

  @ApiProperty({ type: String, nullable: true, description: "The order's consignee GSTIN as stored; null when none" })
  consigneeGstin!: string | null;

  @ApiProperty({
    type: OrderShelfLifeResolvedPartnerDto,
    nullable: true,
    description: 'The partner holding that GSTIN (any status) — set for no-consignee-link, no-rule and applied; null otherwise',
  })
  resolvedPartner!: OrderShelfLifeResolvedPartnerDto | null;

  @ApiProperty({ type: OrderShelfLifeConsigneeDto, nullable: true, description: 'The consignee whose rule applies; null unless consigneeResolution is applied' })
  consignee!: OrderShelfLifeConsigneeDto | null;

  @ApiProperty({ type: [OrderShelfLifeLineDto] })
  lines!: OrderShelfLifeLineDto[];
}

export class OrderShelfLifeResponse {
  @ApiProperty({ type: OrderShelfLifeDto })
  orderShelfLife!: OrderShelfLifeDto;
}

/**
 * Story 4-5a (A13, A14, A48) — the packing-document file routes' query. The
 * pipe checks only that each is a string: the vocabularies, the `zpl` + `a4`
 * refusal and the carton list are judged by `parsePackFileQuery` — AFTER the
 * carton labels' `labels.execute` check, so a role without it gets 403
 * whatever it sent.
 */
export class PackFileQueryDto {
  @ApiProperty({ required: false, enum: ['pdf', 'zpl'], description: 'The file format (the slip defaults to pdf, the carton labels to zpl)' })
  @IsOptional()
  @IsString()
  format?: string;

  @ApiProperty({ required: false, enum: ['a4', 'label'], description: 'a4 (PDF only) or label (4×6 per carton); the slip defaults to a4, the carton labels to label' })
  @IsOptional()
  @IsString()
  layout?: string;

  @ApiProperty({ required: false, description: 'Comma-separated carton numbers, unique, 1–200 (default every carton)', example: '1,3' })
  @IsOptional()
  @IsString()
  cartons?: string;
}
