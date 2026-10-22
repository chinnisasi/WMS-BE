import { ApiProperty } from '@nestjs/swagger';
import { MAX_QUANTITY_BASE } from '../../shared/primitives/quantity';
// Story 12-1: the storage-class vocabulary — the DTO mirror of the shared
// primitive's tuple (the three-layer pattern: TS tuple / DB CHECK / @IsIn).
import { STORAGE_CLASSES } from '../../shared/primitives/storage-class';
// Story 12-4: the location-type vocabulary — same pattern, same shared
// primitive the placement/merge gates import (one source, no copy).
import {
  GRID_TYPES,
  LOCATION_TYPES,
  type BulkAssetType,
  type LocationType,
} from '../../shared/primitives/location-type';
// Story 11-5: the bin capacity caps (same import the SKU-attribute DTOs make
// to `sku-attributes.ts` — the DTO mirrors the command's bounds, the command
// enforces them). A standalone file (the 11-5 review triage #10): importing
// `bin.command` from a DTO would pull its whole module graph in at load time.
import { MAX_BIN_DIMENSION_MM, MAX_BIN_WEIGHT_GRAMS } from './bin-capacity';
import { ADDRESS_FIELD_LENGTHS, PINCODE_RE } from '../../shared/primitives/address';
import { GSTIN_RE, gstinDtoTransform } from '../../shared/primitives/gstin';
import type { AddressSnapshot } from '../../shared/primitives/address';
import { Transform, Type } from 'class-transformer';
import {
  DEFAULT_LABEL_SIZE,
  LABEL_FORMATS,
  MAX_LABELS_PER_PRINT,
  LABEL_LAYOUTS,
  LABEL_SIZES,
  type LabelFormat,
  type LabelLayout,
  type LabelSize,
} from '../../shared/labels/layout';

import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
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

  @ApiProperty({
    example: '27PQAPQ3345K1ZV',
    description:
      'The tenant GSTIN, optional (story 8-1) — the invoicing default the warehouse GSTIN overrides. The settings-edit route is deferred (stamped at registration only).',
    required: false,
  })
  @Transform(gstinDtoTransform)
  @IsOptional()
  @IsString()
  @Matches(GSTIN_RE, { message: 'gstin must be a 15-character GSTIN (two digits, thirteen alphanumeric characters)' })
  gstin?: string;
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

  @ApiProperty({
    example: '29PQAPQ3345K1ZV',
    description:
      'The warehouse GSTIN, optional (story 8-1) — the invoicing supplier identity for dispatches leaving this warehouse, preferred over the tenant default.',
    required: false,
  })
  @Transform(gstinDtoTransform)
  @IsOptional()
  @IsString()
  @Matches(GSTIN_RE, { message: 'gstin must be a 15-character GSTIN (two digits, thirteen alphanumeric characters)' })
  gstin?: string;
}

export class TenantResponse {
  @ApiProperty({ format: 'uuid', example: '0198f7a2-1b3c-7d4e-8f90-112233445566' })
  id!: string;

  @ApiProperty({ example: 'Priya Spices Pvt Ltd' })
  name!: string;

  @ApiProperty({ type: String, description: 'The tenant GSTIN (8-1); null when none registered.', nullable: true })
  gstin!: string | null;
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

/**
 * The coarse roles (spec 1.5) — validated, never free-form. Story 21-7 adds
 * `client`, the client-portal persona (an invite names its client; a user
 * response carries it). Every response DTO naming a role derives from THIS
 * tuple (`BadgeInOperatorResponse` included), so the generated clients see
 * one vocabulary.
 */
export const USER_ROLES = ['owner', 'ops_manager', 'operator', 'accountant', 'client'] as const;
export type UserRoleDto = (typeof USER_ROLES)[number];

/**
 * Story 21-7 — the roles a role change may ASSIGN: the four staff roles. A
 * portal user is created only by an invite naming its client (`client` is
 * never assigned, and a client user's role never changes — the command
 * refuses the target too), so `users.client_id` cannot go stale.
 */
export const ASSIGNABLE_ROLES = ['owner', 'ops_manager', 'operator', 'accountant'] as const;
export type AssignableRoleDto = (typeof ASSIGNABLE_ROLES)[number];

/** Story 6-1a: `deactivated` added — mirrors `USER_STATUSES` in shared/db/schema.ts (pinned by test/sessions.spec.ts). */
export const USER_STATUSES = ['invited', 'active', 'deactivated'] as const;

export class UserResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'dev@example.com' })
  email!: string;

  @ApiProperty({ enum: USER_ROLES, example: 'owner' })
  role!: string;

  @ApiProperty({ enum: USER_STATUSES, example: 'active' })
  status!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Story 21-7 — the client brand a client-portal user belongs to (role `client`); null for the tenant’s own staff',
  })
  clientId!: string | null;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    description:
      'Story 6-1a — sign-in is locked for this email (5 failed attempts from one address) until this instant; on the user list only, null or absent when not locked',
  })
  lockedUntil?: string | null;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'Story 6-1b — the user has two-factor sign-in set up; on the user list only (absent on stored invite / role-change snapshots)',
  })
  secondFactorEnabled?: boolean;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'Story 6-1b — an owner reset this user’s two-factor sign-in and they have not set it up again (an enrolment code is outstanding); on the user list only',
  })
  secondFactorResetPending?: boolean;
}

/** Story 6-1a — deactivate / reactivate. A reactivated never-accepted invitee carries a fresh invite token. */
export class UserStatusResponse {
  @ApiProperty({ type: UserResponse })
  user!: UserResponse;

  @ApiProperty({ required: false, description: 'Present only when reactivation restored an `invited` user — the new one-time invite token' })
  inviteToken?: string;

  @ApiProperty({ required: false })
  inviteExpiresAt?: string;
}

export class InviteUserDto {
  @ApiProperty({ example: 'dev@example.com', format: 'email' })
  @Trimmed()
  @IsEmail()
  email!: string;

  @ApiProperty({ enum: USER_ROLES, example: 'operator' })
  @IsIn(USER_ROLES)
  role!: UserRoleDto;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'Story 21-7 — required when role is `client` (the client brand the portal user belongs to); refused for every other role',
  })
  @IsOptional()
  @IsUUID()
  clientId?: string;
}

export class SetUserRoleDto {
  @ApiProperty({ enum: ASSIGNABLE_ROLES, example: 'ops_manager' })
  @IsIn(ASSIGNABLE_ROLES)
  role!: AssignableRoleDto;
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

/** Story 21-7 — the client brand a portal session belongs to (no tax details, no status). */
export class SessionClientResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'BRAND-A' })
  code!: string;

  @ApiProperty({ example: 'Brand A Apparel' })
  name!: string;
}

/** Story 6-1a — `POST /tenants/session/refresh`: a new access token (the rotated refresh token rides the cookie). */
export class RefreshResponse {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 900 })
  expiresInSeconds!: number;

  @ApiProperty({ example: 43200, description: "Seconds until the session's absolute end." })
  refreshExpiresInSeconds!: number;
}

export class SignInResponse {
  @ApiProperty({
    description:
      'HS256 session token (15 min), claims: sub + tenant_id (+ client_id for a client-portal user, story 21-7)',
  })
  accessToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 900 })
  expiresInSeconds!: number;

  @ApiProperty({
    example: 43200,
    description:
      'Story 6-1a — seconds until the session can no longer be refreshed (its absolute end). The refresh token itself rides an httpOnly cookie; the client stores this to tell a refreshable session from an ended one.',
  })
  refreshExpiresInSeconds!: number;

  @ApiProperty({ type: TenantResponse })
  tenant!: TenantResponse;

  @ApiProperty({ type: UserResponse })
  user!: UserResponse;

  @ApiProperty({
    type: SessionClientResponse,
    nullable: true,
    description:
      'Story 21-7 — the client brand of a client-portal user (the portal shell prints its name); null for the tenant’s own staff',
  })
  client!: SessionClientResponse | null;
}

/** Story 6-1b — an enrolled user's second step: the right password, then a code from the authenticator app. */
export class TotpChallengeResponse {
  @ApiProperty({ enum: ['totp'], example: 'totp' })
  challenge!: 'totp';

  @ApiProperty({ description: 'The one-time token for `POST /tenants/sign-in/second-factor` (no session exists yet)' })
  challengeToken!: string;

  @ApiProperty({ example: 300 })
  expiresInSeconds!: number;
}

/** Story 6-1b — an owner who has not set up two-factor sign-in yet: the enrolment step. */
export class EnrollChallengeResponse {
  @ApiProperty({ enum: ['enroll'], example: 'enroll' })
  challenge!: 'enroll';

  @ApiProperty({ description: 'The one-time token for `POST /tenants/sign-in/second-factor` (no session exists yet)' })
  challengeToken!: string;

  @ApiProperty({ example: 600 })
  expiresInSeconds!: number;

  @ApiProperty({ description: 'The authenticator secret (base32) — the QR code\u2019s fallback. The same one for 24 h, so an app that scanned it keeps working' })
  secret!: string;

  @ApiProperty({ example: 'otpauth://totp/WMS%20(Acme)%3Aowner%40example.com?secret=…&issuer=WMS%20(Acme)' })
  otpauthUri!: string;

  @ApiProperty({ description: 'An owner reset this user\u2019s two-factor sign-in: the one-time enrolment code they handed over is needed too' })
  enrolmentCodeRequired!: boolean;
}

export class SecondFactorSignInDto {
  @ApiProperty({ description: 'The `challengeToken` from the sign-in response' })
  @IsString()
  @Length(1, 200)
  challengeToken!: string;

  @ApiProperty({ example: '123456', description: 'A 6-digit code from the authenticator app, or (code step only) a backup code `XXXXX-XXXXX`' })
  @IsString()
  @Length(1, 40)
  code!: string;

  @ApiProperty({ required: false, example: 'K7PQ2MXA', description: 'Enrolment after an owner\u2019s reset — the one-time code they handed over' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  enrolmentCode?: string;
}

/** Story 6-1b — the second step's answer: the sign-in body, plus what this step adds. */
export class SecondFactorSignInResponse extends SignInResponse {
  @ApiProperty({
    type: [String],
    required: false,
    description: 'Enrolment only — the ten single-use backup codes, shown this once and never again',
  })
  backupCodes?: string[];

  @ApiProperty({ required: false, example: 3, description: 'Wrong codes since the last successful sign-in (present only when there were any)' })
  secondFactorFailedAttempts?: number;
}

/** Story 6-1b — My account → Security. */
export class SecondFactorStatusResponse {
  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-18T09:00:00.000Z' })
  enabledAt!: string | null;

  @ApiProperty({ description: 'The role must use two-factor sign-in (owners) — it cannot be turned off' })
  required!: boolean;

  @ApiProperty({ example: 10 })
  backupCodesRemaining!: number;
}

export class SecondFactorSetupDto {
  @ApiProperty({ required: false, description: 'With two-factor sign-in off: the current password' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  password?: string;

  @ApiProperty({ required: false, description: 'With two-factor sign-in on: a current code or a backup code' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  code?: string;
}

export class SecondFactorSetupResponse {
  @ApiProperty({ description: 'The new authenticator secret (base32) — confirm it with a code from the app' })
  secret!: string;

  @ApiProperty()
  otpauthUri!: string;
}

export class SecondFactorCodeDto {
  @ApiProperty({ example: '123456', description: 'A code from the authenticator app (or, where accepted, a backup code)' })
  @IsString()
  @Length(1, 40)
  code!: string;
}

export class BackupCodesResponse {
  @ApiProperty({ type: [String], description: 'Ten single-use backup codes `XXXXX-XXXXX` — shown this once' })
  backupCodes!: string[];
}

/** Story 6-1b — an owner reset a colleague's two-factor sign-in. Null on the no-op arm (nothing to reset). */
export class SecondFactorResetResponse {
  @ApiProperty({ type: String, nullable: true, example: 'K7PQ2MXA', description: 'Hand this to the user in person — they need it to set up again (72 h)' })
  enrolmentCode!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-21T09:00:00.000Z' })
  enrolmentCodeExpiresAt!: string | null;
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

  @ApiProperty({ type: String, description: 'The warehouse GSTIN (8-1); null when none was given', nullable: true })
  gstin!: string | null;

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
    description: `Max weight in grams. Omit to leave the bin unconstrained; null to clear. At most ${MAX_BIN_WEIGHT_GRAMS}. On a bulk asset (tank, silo) the field is REQUIRED and neither the omission nor a null clear is accepted.`,
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

  // Story 1-5b: the client the bin is dedicated to (decision 1 — bins only).
  // Absent or null = shared (the default). A malformed id is a shape 400
  // here; the client checks (unknown 404, departed 409 `client-departed`)
  // run in the command, behind the replay lookup.
  @ApiProperty({
    required: false,
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Story 1-5b: the client this bin is dedicated to — it then refuses any other client\'s stock in putaway, merge and transfer receive. Omit (or null) for a shared bin. Unknown client 404; a departed client 409 client-departed.',
  })
  @IsOptional()
  @IsUUID()
  dedicatedClientId?: string | null;

  // Story 12-4: the location type documents the bulk-asset create rules —
  // the DTO is the API contract; the weight requirement and the grid refusal
  // stay command-enforced (behind the replay lookup, the 10.2 rule).
  @ApiProperty({
    enum: BIN_TYPES,
    example: 'shelf',
    description:
      "The bin's location type (12-4 vocabulary). A bulk asset (tank, silo) is weight-defined: maxWeightGrams is REQUIRED at create and can never be cleared; a bulk asset is never gridded.",
  })
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
    description: `Max weight in grams, per bin. Omit for unconstrained bins. At most ${MAX_BIN_WEIGHT_GRAMS}. On a bulk asset (tank, silo) the field is REQUIRED at create and cannot be cleared.`,
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

  // Story 1-5b: the client the bin is dedicated to (decision 1 — bins only).
  // Absent or null = shared (the default). A malformed id is a shape 400
  // here; the client checks (unknown 404, departed 409 `client-departed`)
  // run in the command, behind the replay lookup.
  @ApiProperty({
    required: false,
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Story 1-5b: the client every generated bin is dedicated to (decision 1: the generator can dedicate a whole new grid) — it then refuses any other client\'s stock in putaway, merge and transfer receive. Omit (or null) for shared bins. Unknown client 404; a departed client 409 client-departed.',
  })
  @IsOptional()
  @IsUUID()
  dedicatedClientId?: string | null;

  // Story 12-4: the grid's enum narrows to the SIX grid-able types — a bulk
  // asset is operator-directed, never gridded, so the contract must not
  // advertise types the route always refuses. The command's runtime refusal
  // (`refuseBulkAssetGrid`) stays as the backstop.
  @ApiProperty({
    enum: GRID_TYPES,
    example: 'shelf',
    description:
      'The location type, per bin (12-4 vocabulary). A bulk asset (tank, silo) is never gridded — the grid mints only the six conventional storage types.',
  })
  @IsIn(GRID_TYPES)
  type!: Exclude<LocationType, BulkAssetType>;
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
    description: `Max weight in grams. Omit to leave unchanged; null to clear. Mutually exclusive with blocked. On a bulk asset (tank, silo) the field cannot be cleared, and a re-value below the mass the asset already holds is refused.`,
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

  // Story 1-5b: the bin's dedicated client — absent = unchanged, `null` =
  // clear (shared — unlike `storageClass: null`, which stays a 400), a uuid =
  // dedicate. Routed to tenancy's `editBinCapacity` with the structure
  // attributes; mutually exclusive with `blocked`.
  @ApiProperty({
    required: false,
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Story 1-5b: the client this bin is dedicated to. Omit to leave unchanged; null to clear (shared — always allowed); a client id to dedicate. Refused on a system bin (400 validation-failed); an unknown client 404; a departed client 409 client-departed; a bin holding another client\'s stock or open QC holds 409 bin-client-conflict naming the SKUs. Mutually exclusive with blocked.',
  })
  @IsOptional()
  @IsUUID()
  dedicatedClientId?: string | null;
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

  // Story 1-5b: the dedicated client (null = shared; a stored pre-1.5b
  // snapshot replays null through `normalizeBin`).
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Story 1-5b: the client this bin is dedicated to (null = shared)',
  })
  dedicatedClientId!: string | null;

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
/**
 * Story 2-10a — `POST …/warehouses/{w}/bins/labels`. Exactly one of `binIds`
 * (1–1000 distinct bin ids of this warehouse) or `zoneId` (the zone's
 * non-retired, non-system bins); `size` only with the `label` layout; `a4`
 * only with `pdf` — the cross-field rules are 400s in the controller.
 */
export class BinLabelsRequestDto {
  @ApiProperty({
    required: false,
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: MAX_LABELS_PER_PRINT,
    uniqueItems: true,
    description: 'The bins to print (distinct ids of this warehouse). Send this or `zoneId`, never both.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LABELS_PER_PRINT)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  binIds?: string[];

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: "Print every printable bin of this zone (retired and system bins are skipped). Send this or `binIds`, never both.",
  })
  @IsOptional()
  @IsUUID('all')
  zoneId?: string;

  @ApiProperty({ enum: [...LABEL_FORMATS], description: '`zpl` (Zebra thermal, 203 dpi) or `pdf`' })
  @IsIn([...LABEL_FORMATS])
  format!: LabelFormat;

  @ApiProperty({
    required: false,
    enum: [...LABEL_LAYOUTS],
    default: 'label',
    description: '`label` — one label per page or per ^XA…^XZ (default); `a4` — a 3 × 8 sheet of 70 × 36 mm cells (PDF only)',
  })
  @IsOptional()
  @IsIn([...LABEL_LAYOUTS])
  layout?: LabelLayout;

  @ApiProperty({
    required: false,
    enum: [...LABEL_SIZES],
    default: DEFAULT_LABEL_SIZE,
    description: 'The label size in inches (`label` layout only; sending it with `a4` is a 400)',
  })
  @IsOptional()
  @IsIn([...LABEL_SIZES])
  size?: LabelSize;
}
