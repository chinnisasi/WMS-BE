import { ApiProperty } from '@nestjs/swagger';
import { MAX_QUANTITY_BASE } from '../../shared/primitives/quantity';
// Story 12-1: the storage-class vocabulary — the DTO mirror of the shared
// primitive's tuple (the three-layer pattern: TS tuple / DB CHECK / @IsIn).
import { STORAGE_CLASSES } from '../../shared/primitives/storage-class';
// Story 12-4: the location-type vocabulary — same pattern, same shared
// primitive the placement/merge gates import (one source, no copy).
import {
  LOCATION_TYPES,
  type LocationType,
} from '../../shared/primitives/location-type';
// Story 11-5: the bin capacity caps (same import the SKU-attribute DTOs make
// to `sku-attributes.ts` — the DTO mirrors the command's bounds, the command
// enforces them). A standalone file (the 11-5 review triage #10): importing
// `bin.command` from a DTO would pull its whole module graph in at load time.
import { MAX_BIN_DIMENSION_MM, MAX_BIN_WEIGHT_GRAMS } from './bin-capacity';
import { ADDRESS_FIELD_LENGTHS, PINCODE_RE } from '../../shared/primitives/address';
import type { AddressSnapshot } from '../../shared/primitives/address';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
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

/**
 * Trim inputs at the validation boundary so the command layer's normalized
 * values and the validator agree: a padded `" a@b.com "` would otherwise fail
 * `@IsEmail` with a 400 even though sign-in/registration normalize with
 * `trim().toLowerCase()`, and `" BLR-01"` would become a second, distinct
 * warehouse code. A whitespace-only field trims to `''` and fails `@Length`.
 */
const Trimmed = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class RegisterTenantDto {
  @ApiProperty({ example: 'Priya Spices Pvt Ltd', minLength: 1, maxLength: 200 })
  @Trimmed()
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ example: 'priya@example.com', format: 'email' })
  @Trimmed()
  @IsEmail()
  ownerEmail!: string;

  @ApiProperty({ example: 'correct-horse-battery', minLength: 8, maxLength: 200 })
  @IsString()
  @Length(8, 200)
  password!: string;
}

export class SignInDto {
  @ApiProperty({ example: 'priya@example.com', format: 'email' })
  @Trimmed()
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'correct-horse-battery', minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  password!: string;
}

/**
 * The shipment address, on the wire (story 11-1). One field set serves both
 * the order destination (outbound) and the warehouse origin — the class is
 * shared rather than copied so the two contracts cannot drift. The shapes
 * mirror `src/shared/primitives/address.ts` (the same constants, the same
 * pincode regex); the COMMAND re-validates everything behind its replay
 * lookup, because the Epic 7 adapter path bypasses this DTO.
 *
 * No country field — India-only by design.
 */
export class AddressDto {
  @ApiProperty({ example: 'Priya Spices Pvt Ltd', maxLength: ADDRESS_FIELD_LENGTHS.contactName })
  @Trimmed()
  @IsString()
  @Length(1, ADDRESS_FIELD_LENGTHS.contactName)
  contactName!: string;

  @ApiProperty({ example: '+91 98450 12345', maxLength: ADDRESS_FIELD_LENGTHS.phone })
  @Trimmed()
  @IsString()
  @Length(1, ADDRESS_FIELD_LENGTHS.phone)
  phone!: string;

  @ApiProperty({ example: '12, Peenya Industrial Area', maxLength: ADDRESS_FIELD_LENGTHS.line1 })
  @Trimmed()
  @IsString()
  @Length(1, ADDRESS_FIELD_LENGTHS.line1)
  line1!: string;

  @ApiProperty({
    required: false,
    example: 'Gate 3',
    maxLength: ADDRESS_FIELD_LENGTHS.line2,
    description: 'Second address line — omit when there is none',
  })
  @Trimmed()
  @IsOptional()
  @IsString()
  // Optional: absent skips validation; an explicit '' is allowed at the wire
  // and normalized to "absent" by the command (the two hash identically).
  @Length(0, ADDRESS_FIELD_LENGTHS.line2)
  line2?: string;

  @ApiProperty({ example: 'Bengaluru', maxLength: ADDRESS_FIELD_LENGTHS.city })
  @Trimmed()
  @IsString()
  @Length(1, ADDRESS_FIELD_LENGTHS.city)
  city!: string;

  @ApiProperty({ example: 'Karnataka', maxLength: ADDRESS_FIELD_LENGTHS.state })
  @Trimmed()
  @IsString()
  @Length(1, ADDRESS_FIELD_LENGTHS.state)
  state!: string;

  @ApiProperty({
    example: '560066',
    description: 'Six-digit Indian pincode, as TEXT — leading zeros are significant, never an integer',
  })
  @Trimmed()
  @IsString()
  @Matches(PINCODE_RE, { message: 'pincode must be a 6-digit Indian pincode' })
  pincode!: string;
}

/**
 * Snapshot → wire (story 11-1): the stored `line2` null (absent at create)
 * serializes as an ABSENT optional field, not `null` — the same input that
 * omitted line2 reads back omitting it. Everything else passes verbatim.
 * Used at the response edges for both the order destination and the
 * warehouse origin.
 */
export function toAddressDto(address: AddressSnapshot | null): AddressDto | null {
  if (address === null) {
    return null;
  }
  return {
    contactName: address.contactName,
    phone: address.phone,
    line1: address.line1,
    ...(address.line2 === null ? {} : { line2: address.line2 }),
    city: address.city,
    state: address.state,
    pincode: address.pincode,
  };
}

export class CreateWarehouseDto {
  @ApiProperty({ example: 'BLR-01', minLength: 1, maxLength: 32 })
  @Trimmed()
  @IsString()
  @Length(1, 32)
  code!: string;

  @ApiProperty({ example: 'Whitefield', minLength: 1, maxLength: 120 })
  @Trimmed()
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({
    type: AddressDto,
    description:
      'The origin address — where shipments leave from (story 11-1). Required at create; carriers rate and label from it. There is no update endpoint (story 4-6d owns that decision).',
  })
  @ValidateNested()
  @Type(() => AddressDto)
  origin!: AddressDto;
}

export class TenantResponse {
  @ApiProperty({ format: 'uuid', example: '0198f7a2-1b3c-7d4e-8f90-112233445566' })
  id!: string;

  @ApiProperty({ example: 'Priya Spices Pvt Ltd' })
  name!: string;
}

export class OwnerUserResponse {
  @ApiProperty({ format: 'uuid', example: '0198f7a2-1b3c-7d4e-8f90-112233445599' })
  id!: string;

  @ApiProperty({ example: 'priya@example.com' })
  email!: string;
}

export class TenantRegistrationResponse {
  @ApiProperty({ type: TenantResponse })
  tenant!: TenantResponse;

  @ApiProperty({ type: OwnerUserResponse })
  owner!: OwnerUserResponse;
}

/** The four coarse roles (spec 1.5) — validated, never free-form. */
export const USER_ROLES = ['owner', 'ops_manager', 'operator', 'accountant'] as const;
export type UserRoleDto = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['invited', 'active'] as const;

export class UserResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'dev@example.com' })
  email!: string;

  @ApiProperty({ enum: USER_ROLES, example: 'owner' })
  role!: string;

  @ApiProperty({ enum: USER_STATUSES, example: 'active' })
  status!: string;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  createdAt!: string;
}

export class InviteUserDto {
  @ApiProperty({ example: 'dev@example.com', format: 'email' })
  @Trimmed()
  @IsEmail()
  email!: string;

  @ApiProperty({ enum: USER_ROLES, example: 'operator' })
  @IsIn(USER_ROLES)
  role!: UserRoleDto;
}

export class SetUserRoleDto {
  @ApiProperty({ enum: USER_ROLES, example: 'ops_manager' })
  @IsIn(USER_ROLES)
  role!: UserRoleDto;
}

export class AcceptInviteDto {
  @ApiProperty({ description: 'The one-time invite token from the invite response' })
  @IsString()
  @Length(1, 512)
  token!: string;

  @ApiProperty({ example: 'correct-horse-battery', minLength: 8, maxLength: 200 })
  @IsString()
  @Length(8, 200)
  password!: string;
}

export class UserListResponse {
  @ApiProperty({ type: [UserResponse] })
  items!: UserResponse[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor' })
  nextCursor!: string | null;
}

export class InviteUserResponse {
  @ApiProperty({ type: UserResponse })
  user!: UserResponse;

  @ApiProperty({ description: 'The one-time invite token — share the accept link out-of-band' })
  inviteToken!: string;

  @ApiProperty({ example: '2026-09-15T00:00:00.000Z', description: 'One-time link expiry (7 days)' })
  inviteExpiresAt!: string;
}

export class AcceptInviteResponse {
  @ApiProperty({ type: UserResponse })
  user!: UserResponse;
}

export class MeResponse {
  @ApiProperty({ type: UserResponse })
  user!: UserResponse;
}

export class SignInResponse {
  @ApiProperty({ description: 'HS256 session token (15 min), claims: sub + tenant_id' })
  accessToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 900 })
  expiresInSeconds!: number;

  @ApiProperty({ type: TenantResponse })
  tenant!: TenantResponse;

  @ApiProperty({ type: UserResponse })
  user!: UserResponse;
}

export class WarehouseResponse {
  @ApiProperty({ format: 'uuid', example: '0198f7a2-1b3c-7d4e-8f90-112233445577' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: '0198f7a2-1b3c-7d4e-8f90-112233445566' })
  tenantId!: string;

  @ApiProperty({ example: 'BLR-01' })
  code!: string;

  @ApiProperty({ example: 'Whitefield' })
  name!: string;

  @ApiProperty({
    type: AddressDto,
    nullable: true,
    description: 'The origin address (story 11-1); null on a pre-11.1 warehouse row',
  })
  origin!: AddressDto | null;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  createdAt!: string;
}

export class WarehouseListResponse {
  @ApiProperty({ type: [WarehouseResponse] })
  items!: WarehouseResponse[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor' })
  nextCursor!: string | null;
}

/**
 * Bin types are a fixed set (spec 1.3) — validated, never free-form.
 * Story 12-4: the vocabulary moved to the shared primitive
 * (`location-type.ts`) and grew the four non-bin location types (yard,
 * floor-stack, tank, silo — one table, no fork). This re-exported alias keeps
 * the three DTO call sites (:452 create, :566 grid, :748 response) churn-free;
 * the DB CHECK backstop lives in `drizzle/0037_location_type_check.sql`.
 */
export const BIN_TYPES = LOCATION_TYPES;
export type BinType = LocationType;

export class CreateZoneDto {
  @ApiProperty({ example: 'A', minLength: 1, maxLength: 32 })
  @Trimmed()
  @IsString()
  @Length(1, 32)
  code!: string;

  @ApiProperty({ example: 'Fast movers', minLength: 1, maxLength: 120 })
  @Trimmed()
  @IsString()
  @Length(1, 120)
  name!: string;
}

export class CreateBinDto {
  @ApiProperty({ example: 'A-01-01', minLength: 1, maxLength: 32 })
  @Trimmed()
  @IsString()
  @Length(1, 32)
  code!: string;

  @ApiProperty({
    example: 120,
    minimum: 1,
    maximum: MAX_QUANTITY_BASE,
    description: `Bin capacity. A bin's shared space across every SKU it holds — the one quantity with no unit of its own, so it counts WHOLE units, at least one. A fractional or zero capacity is refused.`,
  })
  // Story 10.2: the whole-unit rule is DOCUMENTED here and ENFORCED in the
  // command (`assertWholeUnitCapacity`), behind the idempotency replay lookup
  // — the same position every other quantity edge in this story took. A
  // `@IsInt()` here would refuse a fractional value in the ValidationPipe, in
  // FRONT of that lookup, which is exactly what would answer 400 to a queued
  // op that already committed. Only the upper bound stays, because a value
  // past the exact-integer ceiling (story 10.1) cannot be converted at all.
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Max(MAX_QUANTITY_BASE)
  capacity!: number;

  // Story 11-5: the bin's OPTIONAL physical capacity (FR-39) — the 11.2
  // SKU-attribute DTO mirror. Absent = unconstrained on a fresh bin; the
  // value rules live in the command (`assertBinCapacityAttributes`, behind
  // the replay lookup — the 10.2 rule); the caps here document what the
  // command enforces.
  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_DIMENSION_MM,
    description: `Internal length in millimetres. Omit to leave the bin unconstrained; null to clear. At most ${MAX_BIN_DIMENSION_MM}.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_DIMENSION_MM)
  lengthMm?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_DIMENSION_MM,
    description: `Internal width in millimetres. Omit to leave the bin unconstrained; null to clear. At most ${MAX_BIN_DIMENSION_MM}.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_DIMENSION_MM)
  widthMm?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_DIMENSION_MM,
    description: `Internal height in millimetres. Omit to leave the bin unconstrained; null to clear. At most ${MAX_BIN_DIMENSION_MM}.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_DIMENSION_MM)
  heightMm?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_WEIGHT_GRAMS,
    description: `Max weight in grams. Omit to leave the bin unconstrained; null to clear. At most ${MAX_BIN_WEIGHT_GRAMS}.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_WEIGHT_GRAMS)
  maxWeightGrams?: number | null;

  // Story 12-1: the bin's storage class (FR-40) — the vocabulary is pinned
  // HERE with `@IsIn` and re-checked in the command (`assertStorageClass`,
  // behind the replay lookup — the mirror is not the boundary). Absent
  // stores 'ambient'; there is no null (the column is NOT NULL).
  @ApiProperty({
    required: false,
    enum: STORAGE_CLASSES,
    example: 'ambient',
    description:
      'The bin\'s storage class (FR-40): ambient, chilled, frozen, controlled, hazardous or secure. Omit for ambient.',
  })
  @IsOptional()
  @IsIn(STORAGE_CLASSES)
  storageClass?: string;

  @ApiProperty({ enum: BIN_TYPES, example: 'shelf' })
  @IsIn(BIN_TYPES)
  type!: BinType;
}

export class GenerateBinsDto {
  @ApiProperty({ example: 'A', description: 'First aisle letter (A–Z, ascending range)' })
  @Trimmed()
  @IsString()
  @Length(1, 1)
  @Matches(/^[A-Za-z]$/, { message: 'aisleFrom must be a single letter A–Z' })
  aisleFrom!: string;

  @ApiProperty({ example: 'C', description: 'Last aisle letter (A–Z, inclusive)' })
  @Trimmed()
  @IsString()
  @Length(1, 1)
  @Matches(/^[A-Za-z]$/, { message: 'aisleTo must be a single letter A–Z' })
  aisleTo!: string;

  @ApiProperty({ example: 10, minimum: 1, maximum: 99 })
  @IsInt()
  @Min(1)
  @Max(99)
  baysPerAisle!: number;

  @ApiProperty({ example: 4, minimum: 1, maximum: 99 })
  @IsInt()
  @Min(1)
  @Max(99)
  levelsPerBay!: number;

  @ApiProperty({
    example: 120,
    minimum: 1,
    maximum: MAX_QUANTITY_BASE,
    description: `Capacity per bin. A bin's shared space across every SKU it holds — the one quantity with no unit of its own, so it counts WHOLE units, at least one. A fractional or zero capacity is refused.`,
  })
  // Story 10.2: documented here, enforced in the command (see
  // `CreateBinDto.capacity` for why the validator does not own this rule).
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Max(MAX_QUANTITY_BASE)
  capacity!: number;

  // Story 11-5: the bin's OPTIONAL physical capacity, per generated bin
  // (the `CreateBinDto` mirror — see its field comments).
  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_DIMENSION_MM,
    description: `Internal length in millimetres, per bin. Omit for unconstrained bins. At most ${MAX_BIN_DIMENSION_MM}.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_DIMENSION_MM)
  lengthMm?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_DIMENSION_MM,
    description: `Internal width in millimetres, per bin. Omit for unconstrained bins. At most ${MAX_BIN_DIMENSION_MM}.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_DIMENSION_MM)
  widthMm?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_DIMENSION_MM,
    description: `Internal height in millimetres, per bin. Omit for unconstrained bins. At most ${MAX_BIN_DIMENSION_MM}.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_DIMENSION_MM)
  heightMm?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_WEIGHT_GRAMS,
    description: `Max weight in grams, per bin. Omit for unconstrained bins. At most ${MAX_BIN_WEIGHT_GRAMS}.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_WEIGHT_GRAMS)
  maxWeightGrams?: number | null;

  // Story 12-1: the storage class, per generated bin (the CreateBinDto mirror).
  @ApiProperty({
    required: false,
    enum: STORAGE_CLASSES,
    example: 'ambient',
    description:
      'The storage class, per bin (FR-40). Omit for ambient.',
  })
  @IsOptional()
  @IsIn(STORAGE_CLASSES)
  storageClass?: string;

  @ApiProperty({ enum: BIN_TYPES, example: 'shelf' })
  @IsIn(BIN_TYPES)
  type!: BinType;
}

export class PatchBinDto {
  // Story 11-5: the PATCH body now carries BOTH of the route's arms —
  // putaway's `{blocked}` state command and tenancy's capacity-attribute
  // edit. The two never mix in one request (a body with both is refused —
  // one idempotency key per request); a body with neither is a 400.
  // `blocked` went from required to optional, but a blocked-only body is the
  // only body the route ever accepted pre-11.5, so no client broke.
  @ApiProperty({
    required: false,
    example: false,
    description: 'true blocks the bin (broken); false unblocks. Mutually exclusive with the capacity attributes.',
  })
  @IsOptional()
  @IsBoolean()
  blocked?: boolean;

  // Story 11-5: the capacity attributes (the `CreateBinDto` mirror) —
  // absent = leave unchanged, null = clear. Dispatched to tenancy's
  // `editBinCapacity` (structure is tenancy's; `blocked` is putaway's).
  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_DIMENSION_MM,
    description: `Internal length in millimetres. Omit to leave unchanged; null to clear. Mutually exclusive with blocked.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_DIMENSION_MM)
  lengthMm?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_DIMENSION_MM,
    description: `Internal width in millimetres. Omit to leave unchanged; null to clear. Mutually exclusive with blocked.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_DIMENSION_MM)
  widthMm?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_DIMENSION_MM,
    description: `Internal height in millimetres. Omit to leave unchanged; null to clear. Mutually exclusive with blocked.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_DIMENSION_MM)
  heightMm?: number | null;

  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: MAX_BIN_WEIGHT_GRAMS,
    description: `Max weight in grams. Omit to leave unchanged; null to clear. Mutually exclusive with blocked.`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BIN_WEIGHT_GRAMS)
  maxWeightGrams?: number | null;

  // Story 12-1: the bin's storage class — absent = unchanged (there is no
  // null: the column is NOT NULL, a bin always carries a class). Dispatched
  // to tenancy's `editBinCapacity` with the capacity attributes; mutually
  // exclusive with `blocked`. A change runs the stock-conformance guard
  // (409 `storage-class-conflict`).
  @ApiProperty({
    required: false,
    enum: STORAGE_CLASSES,
    example: 'ambient',
    description:
      'The bin\'s storage class (FR-40). Omit to leave unchanged. Mutually exclusive with blocked.',
  })
  @IsOptional()
  @IsIn(STORAGE_CLASSES)
  storageClass?: string;
}

export class ZoneResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ example: 'A' })
  code!: string;

  @ApiProperty({ example: 'Fast movers' })
  name!: string;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  createdAt!: string;
}

export class ZoneListResponse {
  @ApiProperty({ type: [ZoneResponse] })
  items!: ZoneResponse[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor' })
  nextCursor!: string | null;
}

export class BinResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  zoneId!: string;

  @ApiProperty({ example: 'A-01-01' })
  code!: string;

  @ApiProperty({ example: 120, description: 'Base-UoM units' })
  capacity!: number;

  // Story 11-5: the optional physical capacity echoes as RAW integers (the
  // 11.2 SKU-attribute precedent — attributes are facts, not quantities; no
  // fromMilli anywhere on them).
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Internal length in millimetres (null = unconstrained)',
  })
  lengthMm!: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Internal width in millimetres (null = unconstrained)',
  })
  widthMm!: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Internal height in millimetres (null = unconstrained)',
  })
  heightMm!: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Max weight in grams (null = unconstrained)',
  })
  maxWeightGrams!: number | null;

  // Story 12-1: the controlled-vocabulary storage class (required — every bin
  // carries one; pre-12.1 rows read 'ambient').
  @ApiProperty({ enum: STORAGE_CLASSES, example: 'ambient' })
  storageClass!: string;

  // `string` here (not the BinType union): the response echoes DB rows whose
  // column is text; the enum is still pinned in the OpenAPI schema below.
  @ApiProperty({ enum: BIN_TYPES, example: 'shelf' })
  type!: string;

  @ApiProperty({ example: false })
  blocked!: boolean;

  @ApiProperty({
    example: null,
    nullable: true,
    type: String,
    description: 'The one-way retirement instant (null while the bin is live) — Story 3.6',
  })
  retiredAt!: string | null;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Who retired the bin (null while the bin is live) — Story 3.6',
  })
  retiredBy!: string | null;

  @ApiProperty({
    example: false,
    description: 'The Receiving/QC-hold system bins (never blockable, mergeable, or retired)',
  })
  systemOwned!: boolean;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  createdAt!: string;
}

export class BinListResponse {
  @ApiProperty({ type: [BinResponse] })
  items!: BinResponse[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor' })
  nextCursor!: string | null;
}

export class MergeBinDto {
  @ApiProperty({ format: 'uuid', description: 'The bin the source bin\'s stock consolidates into' })
  @IsUUID()
  targetBinId!: string;
}

/** The merge's moved summary — declared so the generated client type is shaped. */
export class BinMovedSummary {
  @ApiProperty({ example: 2, description: 'Distinct SKUs whose arms moved' })
  skus!: number;

  @ApiProperty({ example: 17, description: 'Total base-UoM units moved' })
  units!: number;
}

export class BinMergeResponse {
  @ApiProperty({ type: BinResponse, description: 'The source bin, post-merge (retired in the same commit)' })
  source!: BinResponse;

  @ApiProperty({ type: BinResponse })
  target!: BinResponse;

  @ApiProperty({
    type: BinMovedSummary,
    example: { skus: 2, units: 17 },
    description: 'Distinct SKUs whose arms moved, and the total base-UoM units moved',
  })
  moved!: BinMovedSummary;
}

export class BinGridResponse {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  zoneId!: string;

  @ApiProperty({ example: 12, description: 'Bins created by this run (≤ 500)' })
  generatedCount!: number;

  @ApiProperty({ example: 'A-01-01' })
  firstCode!: string;

  @ApiProperty({ example: 'C-10-04' })
  lastCode!: string;
}

export class SetupChecklistStepResponse {
  @ApiProperty({ enum: ['warehouse', 'bins', 'catalog', 'users'], example: 'bins' })
  key!: string;

  @ApiProperty({ example: 'Define zones and bins' })
  label!: string;

  @ApiProperty({ example: true })
  done!: boolean;

  @ApiProperty({ example: 'Done · 312 bins defined' })
  detail!: string;

  @ApiProperty({ example: '/settings', description: 'Deep link for the Continue affordance' })
  href!: string;
}

export class SetupChecklistResponse {
  @ApiProperty({ type: [SetupChecklistStepResponse] })
  steps!: SetupChecklistStepResponse[];
}