import { Transform, Type } from 'class-transformer';
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
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ORDER_SOURCES } from './order.command';

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
    description: 'Ordered quantity in base UoM — a positive integer',
    minimum: 1,
    maximum: 2147483647,
    example: 10,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  quantity!: number;
}

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

  @ApiProperty({ type: [OrderLineInputDto], minItems: 1, maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  lines!: OrderLineInputDto[];
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

  @ApiProperty({ description: "'accepted' or 'cancelled'", enum: ['accepted', 'cancelled'] })
  status!: string;

  @ApiProperty({ description: "'manual' or 'ingested'", enum: ['manual', 'ingested'] })
  source!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Channel integration (null on a manual order)' })
  integrationId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Channel external event id (null on a manual order)' })
  externalEventId!: string | null;

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

/** Query of the warehouse-scoped order list (keyset cursor pagination). */
export class OrderListQuery {
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

/** One header row of the order list (no lines — the detail read carries them). */
export class OrderEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ enum: ['accepted', 'cancelled'] })
  status!: string;

  @ApiProperty({ enum: ['manual', 'ingested'] })
  source!: string;

  @ApiProperty({ type: String, nullable: true })
  integrationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  externalEventId!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;
}

export class OrderListResponse {
  @ApiProperty({ type: [OrderEntryDto] })
  items!: readonly OrderEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}
