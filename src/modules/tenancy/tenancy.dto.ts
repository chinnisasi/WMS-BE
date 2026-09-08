import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length } from 'class-validator';

export class RegisterTenantDto {
  @ApiProperty({ example: 'Priya Spices Pvt Ltd', minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ example: 'priya@example.com' })
  @IsEmail()
  ownerEmail!: string;

  @ApiProperty({ example: 'correct-horse-battery', minLength: 8, maxLength: 200 })
  @IsString()
  @Length(8, 200)
  password!: string;
}

export class SignInDto {
  @ApiProperty({ example: 'priya@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'correct-horse-battery', minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  password!: string;
}

export class CreateWarehouseDto {
  @ApiProperty({ example: 'BLR-01', minLength: 1, maxLength: 32 })
  @IsString()
  @Length(1, 32)
  code!: string;

  @ApiProperty({ example: 'Whitefield', minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;
}

export class TenantResponse {
  @ApiProperty({ example: '0198abcdef0102030405060708090ab' })
  id!: string;

  @ApiProperty({ example: 'Priya Spices Pvt Ltd' })
  name!: string;
}

export class OwnerUserResponse {
  @ApiProperty({ example: '0198abcdef0102030405060708090cd' })
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
  @ApiProperty({ example: '0198abcdef0102030405060708090ef' })
  id!: string;

  @ApiProperty({ example: '0198abcdef0102030405060708090ab' })
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