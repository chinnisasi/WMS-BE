import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  CLIENT_CONTACT_NAME_MAX,
  CLIENT_CONTACT_ROLES,
  CLIENT_NAME_MAX,
  CLIENT_STATUSES,
  type ClientContactRole,
  type ClientStatus,
} from '../modules/clients/clients.schema';
import { CLIENT_STATUS_TARGETS, type ClientStatusTarget } from '../modules/clients/clients.command';
import { ADDRESS_FIELD_LENGTHS } from '../shared/primitives/address';
import { EMAIL_MAX_LENGTH, IsEmailAddress } from '../shared/primitives/email';
import { AddressDto } from '../modules/tenancy/tenancy.dto';

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
 * Story 21-10 — suspend (`suspended`) or reactivate (`active`) a client
 * brand; story 1-2a — depart it (`departed`, offboarding). The command
 * re-checks the same tuple (it is the boundary).
 */
export class UpdateClientStatusDto {
  @ApiProperty({
    enum: [...CLIENT_STATUS_TARGETS],
    example: 'suspended',
    description:
      'The status to move the client to: `suspended` stops its portal (sign-in, every portal call, ASN announce), new portal users and new rate-card drafts and activation — operator work continues; `departed` (only once nothing is left open for it — 409 `client-not-wound-down` lists the blockers) also stops every new piece of work and ends its portal sessions, keeping its history; `active` restores either',
  })
  @IsIn(CLIENT_STATUS_TARGETS)
  status!: ClientStatusTarget;
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

/** Story 1-2a — the registered address as a request sends it. */
export class ClientRegisteredAddressInputDto {
  @ApiProperty({ example: '4th Floor, Prestige Towers', maxLength: ADDRESS_FIELD_LENGTHS.line1 })
  @Trimmed()
  @IsString()
  @Length(1, ADDRESS_FIELD_LENGTHS.line1)
  line1!: string;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: ADDRESS_FIELD_LENGTHS.line2, description: 'Omit (or null) when there is none' })
  @Trimmed()
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, ADDRESS_FIELD_LENGTHS.line2)
  line2?: string | null;

  @ApiProperty({ example: 'Mumbai', maxLength: ADDRESS_FIELD_LENGTHS.city })
  @Trimmed()
  @IsString()
  @Length(1, ADDRESS_FIELD_LENGTHS.city)
  city!: string;

  @ApiProperty({ example: '27', description: 'A two-digit GST registration state code' })
  @Trimmed()
  @IsString()
  @MaxLength(10)
  stateCode!: string;

  @ApiProperty({ example: '400001', description: 'Six digits, as text' })
  @Trimmed()
  @IsString()
  @MaxLength(20)
  pincode!: string;
}

/**
 * Story 1-2a — `PATCH …/clients/{c}/addresses`. Each group: ABSENT leaves it
 * unchanged, `null` clears it, a value replaces it whole. Every shape rule
 * (the state code, the pincode, the ceilings) is the command's too, behind
 * the replay lookup.
 */
export class UpdateClientAddressesDto {
  @ApiProperty({ required: false, nullable: true, type: ClientRegisteredAddressInputDto, description: "The client's registered address (absent = unchanged, null = cleared)" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => ClientRegisteredAddressInputDto)
  registered?: ClientRegisteredAddressInputDto | null;

  @ApiProperty({ required: false, nullable: true, type: AddressDto, description: 'Where returned goods go back to — the shipment address shape (absent = unchanged, null = cleared)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => AddressDto)
  return?: AddressDto | null;
}

/** Story 1-2a — a client's registered address as every read returns it. */
export class ClientRegisteredAddressDto {
  @ApiProperty()
  line1!: string;

  @ApiProperty({ type: String, nullable: true })
  line2!: string | null;

  @ApiProperty()
  city!: string;

  @ApiProperty({ description: 'A two-digit GST registration state code' })
  stateCode!: string;

  @ApiProperty({ description: 'Six digits' })
  pincode!: string;
}

const LowerTrimmed = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));

/** Story 1-2a — add a contact. */
export class CreateClientContactDto {
  @ApiProperty({ example: 'Asha Rao', minLength: 1, maxLength: CLIENT_CONTACT_NAME_MAX })
  @Trimmed()
  @IsString()
  @Length(1, CLIENT_CONTACT_NAME_MAX)
  name!: string;

  @ApiProperty({ example: 'asha@acme.example', maxLength: EMAIL_MAX_LENGTH, description: 'Stored trimmed and lower-cased; unique per client' })
  @LowerTrimmed()
  @IsString()
  @IsEmailAddress()
  email!: string;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: ADDRESS_FIELD_LENGTHS.phone, description: 'Omit, null or blank for none' })
  @Trimmed()
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(ADDRESS_FIELD_LENGTHS.phone)
  phone?: string | null;

  @ApiProperty({ required: false, enum: [...CLIENT_CONTACT_ROLES], isArray: true, description: 'What the contact is for — none is a general contact. No role twice' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CLIENT_CONTACT_ROLES.length)
  @IsIn(CLIENT_CONTACT_ROLES, { each: true })
  roles?: ClientContactRole[];
}

/** Story 1-2a — edit a contact: an absent field is unchanged; `isPrimary: true` makes it the primary. */
export class UpdateClientContactDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: CLIENT_CONTACT_NAME_MAX })
  @Trimmed()
  @IsOptional()
  @IsString()
  @Length(1, CLIENT_CONTACT_NAME_MAX)
  name?: string;

  @ApiProperty({ required: false, maxLength: EMAIL_MAX_LENGTH })
  @LowerTrimmed()
  @IsOptional()
  @IsString()
  @IsEmailAddress()
  email?: string;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: ADDRESS_FIELD_LENGTHS.phone, description: 'null or blank clears it' })
  @Trimmed()
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(ADDRESS_FIELD_LENGTHS.phone)
  phone?: string | null;

  @ApiProperty({ required: false, enum: [...CLIENT_CONTACT_ROLES], isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CLIENT_CONTACT_ROLES.length)
  @IsIn(CLIENT_CONTACT_ROLES, { each: true })
  roles?: ClientContactRole[];

  @ApiProperty({ required: false, description: 'true makes this the primary contact (the previous primary is cleared). false is refused — make another contact primary instead' })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

/** Story 1-2a — one client contact. */
export class ClientContactDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ description: 'Lower-cased' })
  email!: string;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ enum: [...CLIENT_CONTACT_ROLES], isArray: true, description: 'In vocabulary order; empty = a general contact' })
  roles!: ClientContactRole[];

  @ApiProperty({ description: 'Exactly one contact is primary while any exist — listed first, the default recipient of client notifications' })
  isPrimary!: boolean;

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last update' })
  updatedAt!: string;
}

export class ClientContactResponse {
  @ApiProperty({ type: ClientContactDto })
  contact!: ClientContactDto;
}

export class ClientContactListResponse {
  @ApiProperty({ type: [ClientContactDto], description: 'The primary first, then by name, then by id (at most 20)' })
  items!: readonly ClientContactDto[];
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

  @ApiProperty({ type: ClientRegisteredAddressDto, nullable: true, description: "Story 1-2a — the client's registered address (null when unset)" })
  registeredAddress!: ClientRegisteredAddressDto | null;

  @ApiProperty({ type: AddressDto, nullable: true, description: 'Story 1-2a — where returned goods go back to, in the shipment address shape (null when unset)' })
  returnAddress!: AddressDto | null;
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
