import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import { CLIENT_NAME_MAX, CLIENT_STATUSES, type ClientStatus } from '../modules/clients/clients.schema';

/**
 * Story 21-2b — the client admin surface's DTOs. The DTO mirrors the shape
 * rules; the command is the boundary (`assertClientCode` /
 * `assertClientName`), and the 0059 CHECKs back both.
 */
const TrimmedUpper = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value));
const Trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateClientDto {
  @ApiProperty({
    example: 'ACME',
    minLength: 2,
    maxLength: 32,
    pattern: '^[A-Za-z0-9][A-Za-z0-9-]{1,31}$',
    description:
      'Operator-facing short code, unique per tenant. Trimmed and stored UPPERCASE: 2-32 characters of A-Z, 0-9 and "-", starting with a letter or digit. "SELF" is reserved for the tenant\'s own client',
  })
  @TrimmedUpper()
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9-]{1,31}$/, {
    message: 'code must be 2-32 characters of A-Z, 0-9 and "-", starting with a letter or digit',
  })
  code!: string;

  @ApiProperty({ example: 'Acme Foods', minLength: 1, maxLength: CLIENT_NAME_MAX })
  @Trimmed()
  @IsString()
  @Length(1, CLIENT_NAME_MAX)
  name!: string;
}

export class RenameClientDto {
  @ApiProperty({ example: 'Acme Foods Pvt Ltd', minLength: 1, maxLength: CLIENT_NAME_MAX })
  @Trimmed()
  @IsString()
  @Length(1, CLIENT_NAME_MAX)
  name!: string;
}

/**
 * Story 21-5 — the tax-details patch. Every field optional: ABSENT leaves it
 * unchanged, `null` (or a blank string) clears it. The DTO checks only that
 * a present value is a string (or null) within the column ceilings; every
 * shape rule (GSTIN, state code, pincode, the GSTIN-vs-state agreement) is
 * the command's, behind the replay lookup.
 */
export class UpdateClientTaxDetailsDto {
  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 200, example: 'Acme Foods Private Limited', description: 'The legal name printed as the recipient' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(400)
  legalName?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, example: '27AAACA1234A1Z5', description: 'The client GSTIN (uppercased). Its two-digit prefix must equal billingStateCode when both are set' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(40)
  gstin?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 200 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(400)
  billingLine1?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 200 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(400)
  billingLine2?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 100 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(200)
  billingCity?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, example: '27', description: 'A two-digit GST registration state code' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(10)
  billingStateCode?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, example: '400001', description: 'Six digits' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  billingPincode?: string | null;
}

/** Story 21-5 — a client's tax details as every read returns them (each nullable). */
export class ClientTaxDetailsDto {
  @ApiProperty({ type: String, nullable: true })
  legalName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gstin!: string | null;

  @ApiProperty({ type: String, nullable: true })
  billingLine1!: string | null;

  @ApiProperty({ type: String, nullable: true })
  billingLine2!: string | null;

  @ApiProperty({ type: String, nullable: true })
  billingCity!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'A two-digit GST registration state code' })
  billingStateCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  billingPincode!: string | null;
}

export class ClientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({
    example: 'ACME',
    description: "The client's code. The tenant's own client carries the fixed code `self` (lowercase)",
  })
  code!: string;

  @ApiProperty({ example: 'Acme Foods', description: "The client's name. The tenant's own client mirrors the tenant name" })
  name!: string;

  @ApiProperty({ enum: [...CLIENT_STATUSES] })
  status!: ClientStatus;

  @ApiProperty({
    description:
      "True only for the tenant's own `self` client — its goods are the tenant's own, and only its orders are GST-invoiced by the tenant",
  })
  systemOwned!: boolean;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;

  @ApiProperty({
    type: ClientTaxDetailsDto,
    description: "Story 21-5 — the recipient's tax details a services tax invoice names (every field nullable; never required)",
  })
  taxDetails!: ClientTaxDetailsDto;
}

export class ClientResponse {
  @ApiProperty({ type: ClientDto })
  client!: ClientDto;
}

export class ClientListResponse {
  @ApiProperty({
    type: [ClientDto],
    description: 'Every client of the tenant, any status — the system-owned client first, then by code. Unpaginated, bounded at 500',
  })
  items!: readonly ClientDto[];
}
