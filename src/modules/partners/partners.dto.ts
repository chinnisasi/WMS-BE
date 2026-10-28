import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PARTNER_LINK_ROLES, PARTNER_ROLES, PARTNER_STATUSES, type PartnerLinkRole, type PartnerRole, type PartnerStatus } from '../../shared/db/schema';
import { ADDRESS_FIELD_LENGTHS } from '../../shared/primitives/address';
import {
  CONSIGNEE_MIN_SHELF_LIFE_DAYS_MAX,
  CONSIGNEE_MIN_SHELF_LIFE_DAYS_MIN,
  CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MAX,
  CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MIN,
} from '../../shared/primitives/batch-allocation';

/**
 * Story 1-3 — the business partner surface's DTOs. The DTO checks types and
 * the column ceilings; every shape rule (GSTIN, PAN, state codes, pincodes,
 * the PAN/GSTIN and GSTIN/state agreements, the roles) is the command's,
 * behind the replay lookup, over the MERGED row. PATCH bodies are tri-state:
 * an absent key is unchanged, `null` clears.
 */
const Trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** The registered shape (`line1, line2?, city, stateCode, pincode`) as a request sends it. */
export class PartnerAddressInputDto {
  @ApiProperty({ example: 'Plot 12, MIDC', maxLength: ADDRESS_FIELD_LENGTHS.line1 })
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

  @ApiProperty({ example: 'Pune', maxLength: ADDRESS_FIELD_LENGTHS.city })
  @Trimmed()
  @IsString()
  @Length(1, ADDRESS_FIELD_LENGTHS.city)
  city!: string;

  @ApiProperty({ example: '27', description: 'A two-digit GST registration state code' })
  @Trimmed()
  @IsString()
  @MaxLength(10)
  stateCode!: string;

  @ApiProperty({ example: '411001', description: 'Six digits, as text' })
  @Trimmed()
  @IsString()
  @MaxLength(20)
  pincode!: string;
}

/** A registered-shape address as every read returns it. */
export class PartnerAddressDto {
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

/** The fields shared by create and PATCH (PATCH: every one optional, null clears). */
class PartnerOptionalFieldsDto {
  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 200, description: 'The registered legal name' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(400)
  legalName?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: '27ABCDE1234F1Z5',
    description: 'One GST registration — unique per tenant (409 `partner-gstin-taken` names the holder). Uppercased; absent for an unregistered supplier',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(40)
  gstin?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: 'ABCDE1234F',
    description: "Derived from the GSTIN's characters 3-12 when absent and a GSTIN is present; a different PAN is 400 `pan-gstin-mismatch`",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  pan?: string | null;

  @ApiProperty({ required: false, nullable: true, type: PartnerAddressInputDto, description: 'The registered address — its state must be the GSTIN\'s (400 `gstin-state-mismatch`)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => PartnerAddressInputDto)
  registeredAddress?: PartnerAddressInputDto | null;

  @ApiProperty({ required: false, nullable: true, type: PartnerAddressInputDto, description: 'Where goods ship from (or to, for a consignee)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => PartnerAddressInputDto)
  dispatchAddress?: PartnerAddressInputDto | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 120 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(240)
  contactName?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: ADDRESS_FIELD_LENGTHS.phone })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(40)
  contactPhone?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 254 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(400)
  contactEmail?: string | null;
}

/** `POST /tenants/{t}/partners`. */
export class CreatePartnerDto extends PartnerOptionalFieldsDto {
  @ApiProperty({ example: 'SUP-001', minLength: 1, maxLength: 64, description: 'Unique per tenant (409 `partner-code-taken`); trimmed, case kept' })
  @Trimmed()
  @IsString()
  @Length(1, 64)
  code!: string;

  @ApiProperty({ example: 'Deccan Packaging', minLength: 1, maxLength: 200, description: 'The display name' })
  @Trimmed()
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ enum: [...PARTNER_ROLES], isArray: true, minItems: 1, description: 'The roles the partner plays (at least one)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PARTNER_ROLES.length)
  @IsIn(PARTNER_ROLES, { each: true })
  roles!: PartnerRole[];
}

/** `PATCH /tenants/{t}/partners/{id}` — tri-state: absent unchanged, null clears. */
export class UpdatePartnerDto extends PartnerOptionalFieldsDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: 64 })
  @Trimmed()
  @IsOptional()
  @IsString()
  @Length(1, 64)
  code?: string;

  @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
  @Trimmed()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiProperty({
    required: false,
    enum: [...PARTNER_ROLES],
    isArray: true,
    description: 'The full new role set. Removing vendor or consignee while an active link carries it is 409 `partner-role-in-use`',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PARTNER_ROLES.length)
  @IsIn(PARTNER_ROLES, { each: true })
  roles?: PartnerRole[];
}

/** `PATCH /tenants/{t}/partners/{id}/status`. */
export class UpdatePartnerStatusDto {
  @ApiProperty({ enum: [...PARTNER_STATUSES], description: '`inactive` keeps the partner off new documents (open POs keep receiving); `active` restores it and clears the reason' })
  @IsIn(PARTNER_STATUSES)
  status!: PartnerStatus;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 200, description: 'Why it was deactivated — only with `inactive`' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(400)
  reason?: string | null;
}

/** `POST /tenants/{t}/partners/{id}/links`. */
export class CreatePartnerLinkDto {
  @ApiProperty({ format: 'uuid', description: 'The client (the tenant\'s own `self` client included)' })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ enum: [...PARTNER_ROLES], description: 'vendor or consignee — a transporter is never linked (400 `link-role-invalid`)' })
  @IsIn(PARTNER_ROLES)
  role!: PartnerRole;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 64, description: "The client's own code for this partner — trimmed, case kept; unique per client and role" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(128)
  clientCode?: string | null;

  @ApiProperty({ required: false, description: "Make it the client's default vendor (vendor links only; the previous default is cleared)" })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** `PATCH /tenants/{t}/partners/{id}/links/{linkId}`. */
export class UpdatePartnerLinkDto {
  @ApiProperty({ required: false, nullable: true, type: String, maxLength: 64, description: 'Absent unchanged, null clears' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(128)
  clientCode?: string | null;

  @ApiProperty({ required: false, description: 'false switches the link off (and clears its default); true switches it back on' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({ required: false, description: "true makes it the client's default vendor; false clears it" })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** `GET /tenants/{t}/partners` query. */
export class PartnerListQuery {
  @ApiProperty({ required: false, enum: [...PARTNER_ROLES], description: 'Partners holding this role (with clientId: an active link in this role)' })
  @IsOptional()
  @IsIn(PARTNER_ROLES)
  role?: PartnerRole;

  @ApiProperty({ required: false, format: 'uuid', description: 'Partners with an ACTIVE link to this client' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, enum: [...PARTNER_STATUSES] })
  @IsOptional()
  @IsIn(PARTNER_STATUSES)
  status?: PartnerStatus;

  @ApiProperty({ required: false, maxLength: 100, description: 'Matches code, name, legal name or GSTIN (case-insensitive, literal)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** One client link of a partner. */
export class PartnerLinkDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ enum: [...PARTNER_LINK_ROLES] })
  role!: PartnerLinkRole;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ description: "The client's default vendor (at most one per client)" })
  isDefault!: boolean;

  @ApiProperty({ type: String, nullable: true, description: "The client's own code for the partner" })
  clientCode!: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    required: false,
    minimum: CONSIGNEE_MIN_SHELF_LIFE_DAYS_MIN,
    maximum: CONSIGNEE_MIN_SHELF_LIFE_DAYS_MAX,
    description:
      "Story 4-3b — a consignee link's own minimum remaining shelf life for the client's orders, in IST days; null = none. Optional: a stored reply predates it",
  })
  minShelfLifeDays?: number | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    required: false,
    minimum: CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MIN,
    maximum: CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MAX,
    description:
      "Story 4-3b — the same minimum as a percent of each SKU's TOTAL shelf life (skus.shelfLifeDays); null = none. Both must hold when both are set. Optional: a stored reply predates it",
  })
  minShelfLifePercent?: number | null;
}

/**
 * Story 4-3b — `PUT /partners/{id}/links/{linkId}/shelf-life`: a full replace
 * of a consignee link's two minimums. BOTH keys are required (`null` = none —
 * a missing key is a 400, the 4-3a A11 precedent); the command re-checks each
 * behind the replay lookup.
 */
export class UpdatePartnerLinkShelfLifeDto {
  @ApiProperty({
    type: 'integer',
    nullable: true,
    minimum: CONSIGNEE_MIN_SHELF_LIFE_DAYS_MIN,
    maximum: CONSIGNEE_MIN_SHELF_LIFE_DAYS_MAX,
    description: 'IST days of remaining shelf life the consignee requires; null for none (required — send null explicitly)',
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(CONSIGNEE_MIN_SHELF_LIFE_DAYS_MIN)
  @Max(CONSIGNEE_MIN_SHELF_LIFE_DAYS_MAX)
  minShelfLifeDays!: number | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    minimum: CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MIN,
    maximum: CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MAX,
    description: "Percent of each SKU's total shelf life that must remain; null for none (required — send null explicitly)",
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MIN)
  @Max(CONSIGNEE_MIN_SHELF_LIFE_PERCENT_MAX)
  minShelfLifePercent!: number | null;
}

/** One business partner — its links inline. */
export class PartnerDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ description: 'The display name' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  legalName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gstin!: string | null;

  @ApiProperty({ type: String, nullable: true })
  pan!: string | null;

  @ApiProperty({ enum: [...PARTNER_ROLES], isArray: true })
  roles!: PartnerRole[];

  @ApiProperty({ type: PartnerAddressDto, nullable: true })
  registeredAddress!: PartnerAddressDto | null;

  @ApiProperty({ type: PartnerAddressDto, nullable: true })
  dispatchAddress!: PartnerAddressDto | null;

  @ApiProperty({ type: String, nullable: true })
  contactName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  contactPhone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  contactEmail!: string | null;

  @ApiProperty({ enum: [...PARTNER_STATUSES] })
  status!: PartnerStatus;

  @ApiProperty({ type: String, nullable: true, description: 'Why it is inactive (null while active)' })
  inactiveReason!: string | null;

  @ApiProperty({ type: [PartnerLinkDto] })
  links!: PartnerLinkDto[];

  @ApiProperty({ description: 'ISO-8601 UTC creation time' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC last-mutation time' })
  updatedAt!: string;
}

export class PartnerResponse {
  @ApiProperty({ type: PartnerDto })
  partner!: PartnerDto;
}

export class PartnerListResponse {
  @ApiProperty({ type: [PartnerDto] })
  items!: PartnerDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

/**
 * Story 1-3 — the vendor as a purchase order froze it at creation (shape
 * v1; every key present, null where empty).
 */
export class VendorSnapshotDto {
  @ApiProperty({ enum: [1], description: 'The snapshot shape version' })
  v!: 1;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  legalName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gstin!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The registered state, else the GSTIN\'s prefix' })
  stateCode!: string | null;

  @ApiProperty({ type: PartnerAddressDto, nullable: true })
  registeredAddress!: PartnerAddressDto | null;

  @ApiProperty({ type: PartnerAddressDto, nullable: true })
  dispatchAddress!: PartnerAddressDto | null;
}
