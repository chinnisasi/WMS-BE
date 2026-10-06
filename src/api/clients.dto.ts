import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
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
