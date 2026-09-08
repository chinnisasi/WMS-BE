import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length } from 'class-validator';

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

export class SignInResponse {
  @ApiProperty({ description: 'HS256 session token (15 min), claims: sub + tenant_id' })
  accessToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 900 })
  expiresInSeconds!: number;

  @ApiProperty({ type: TenantResponse })
  tenant!: TenantResponse;
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