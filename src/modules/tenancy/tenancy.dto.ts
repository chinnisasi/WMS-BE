import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

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

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  createdAt!: string;
}

export class WarehouseListResponse {
  @ApiProperty({ type: [WarehouseResponse] })
  items!: WarehouseResponse[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor' })
  nextCursor!: string | null;
}

/** Bin types are a fixed set (spec 1.3) — validated, never free-form. */
export const BIN_TYPES = ['shelf', 'pallet', 'floor', 'staging'] as const;
export type BinType = (typeof BIN_TYPES)[number];

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

  @ApiProperty({ example: 120, minimum: 1, description: 'Positive integer, base-UoM units' })
  @IsInt()
  @Min(1)
  // Postgres `integer` ceiling — a bigger number would 500 on the column, not 400.
  @Max(2147483647)
  capacity!: number;

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

  @ApiProperty({ example: 120, minimum: 1, description: 'Capacity per bin, base-UoM units' })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  capacity!: number;

  @ApiProperty({ enum: BIN_TYPES, example: 'shelf' })
  @IsIn(BIN_TYPES)
  type!: BinType;
}

export class PatchBinDto {
  @ApiProperty({ example: false, description: 'true blocks the bin (broken); false unblocks' })
  @IsBoolean()
  blocked!: boolean;
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

  // `string` here (not the BinType union): the response echoes DB rows whose
  // column is text; the enum is still pinned in the OpenAPI schema below.
  @ApiProperty({ enum: BIN_TYPES, example: 'shelf' })
  type!: string;

  @ApiProperty({ example: false })
  blocked!: boolean;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  createdAt!: string;
}

export class BinListResponse {
  @ApiProperty({ type: [BinResponse] })
  items!: BinResponse[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor' })
  nextCursor!: string | null;
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