import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateIf } from 'class-validator';
import {
  LICENCE_EXPIRY_STATES,
  LICENCE_KINDS,
  LICENCE_NEEDS,
  LICENCE_NOTE_MAX,
  LICENCE_STATUSES,
  type LicenceExpiryState,
  type LicenceKind,
  type LicenceNeed,
  type LicenceStatus,
} from '../shared/primitives/licence';

/**
 * Story 1-6c — the drug and FSSAI licence surface's wire shapes. The DTO
 * mirrors the vocabularies (`@IsIn` over the primitive's tuples); the
 * command is the boundary for every rule (the number per kind, the dates,
 * the note), so a refusal behind the replay lookup stays where §1 puts it.
 * Date fields are `YYYY-MM-DD` IST calendar dates.
 */

/** A generous transport bound — the command's per-kind rule is the real one (50 for drug forms, 14 digits for FSSAI). */
const NUMBER_TRANSPORT_MAX = 100;
const DATE_TRANSPORT_MAX = 10;

export class AddLicenceDto {
  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'The client brand holding it. Omit (or null) for a site licence — the 3PL’s own. Never the tenant’s own (`self`) client: its goods are covered by the site licence',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  clientId?: string | null;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'The site of a site licence (required then), or the premises of a client licence. A client licence without one is a head-office or central licence, valid at every site',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  warehouseId?: string | null;

  @ApiProperty({ enum: [...LICENCE_KINDS], description: 'The statutory form: drug-20b (G/H/H1), drug-21b (C/C1), drug-20g (X), ndps, or an FSSAI tier' })
  @IsIn(LICENCE_KINDS)
  kind!: LicenceKind;

  @ApiProperty({
    example: 'MH/PUN/20B-12',
    maxLength: NUMBER_TRANSPORT_MAX,
    description: 'Stored trimmed, spaces collapsed, upper-cased. FSSAI: 14 digits (a registration starts with 2, a state or central licence with 1). Drug and NDPS: 1–50 of A–Z 0–9 space / . -',
  })
  @IsString()
  @MaxLength(NUMBER_TRANSPORT_MAX)
  number!: string;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'date', maxLength: DATE_TRANSPORT_MAX, description: 'YYYY-MM-DD; omit or null for none' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(DATE_TRANSPORT_MAX)
  validFrom?: string | null;

  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    format: 'date',
    maxLength: DATE_TRANSPORT_MAX,
    description: 'YYYY-MM-DD. Required for FSSAI and NDPS; optional on a drug form, where it is the retention due date',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(DATE_TRANSPORT_MAX)
  validUntil?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, maxLength: LICENCE_NOTE_MAX, description: `Trimmed; blank is none. At most ${LICENCE_NOTE_MAX} characters` })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(LICENCE_NOTE_MAX * 2)
  note?: string | null;
}

/** An edit: an absent field is kept, null clears it (never `number`). Kind, client and site are fixed. */
export class EditLicenceDto {
  @ApiProperty({ required: false, type: String, maxLength: NUMBER_TRANSPORT_MAX, description: 'The corrected number (same rules as the add); cannot be null' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(NUMBER_TRANSPORT_MAX)
  number?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'date', maxLength: DATE_TRANSPORT_MAX, description: 'YYYY-MM-DD; null clears it' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(DATE_TRANSPORT_MAX)
  validFrom?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'date', maxLength: DATE_TRANSPORT_MAX, description: 'YYYY-MM-DD; null clears it (refused on FSSAI and NDPS)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(DATE_TRANSPORT_MAX)
  validUntil?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, maxLength: LICENCE_NOTE_MAX, description: 'Null or blank clears it' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(LICENCE_NOTE_MAX * 2)
  note?: string | null;
}

export class LicenceListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: 'Only this client’s licences' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, format: 'uuid', description: 'Only licences of this site (site licences and client premises licences)' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ required: false, enum: [...LICENCE_STATUSES] })
  @IsOptional()
  @IsIn(LICENCE_STATUSES)
  status?: LicenceStatus;
}

export class LicenceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['client', 'site'], description: '`client` — a brand’s licence (head office when warehouseId is null, else for that premises); `site` — the 3PL’s own site licence' }) holder!: 'client' | 'site';
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) clientId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) warehouseId!: string | null;
  @ApiProperty({ enum: [...LICENCE_KINDS] }) kind!: LicenceKind;
  @ApiProperty() number!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) validFrom!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date', description: 'On a drug form: the retention due date' }) validUntil!: string | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ enum: [...LICENCE_STATUSES] }) status!: LicenceStatus;
  @ApiProperty({ description: 'ISO-8601 UTC' }) createdAt!: string;
  @ApiProperty({ description: 'ISO-8601 UTC' }) updatedAt!: string;
}

export class LicenceResponse {
  @ApiProperty({ type: LicenceDto }) licence!: LicenceDto;
}

export class LicenceListItemDto extends LicenceDto {
  @ApiProperty({ enum: [...LICENCE_EXPIRY_STATES], description: 'On asOfDate (IST): upcoming from 60 days before validUntil, expired after it' }) expiryState!: LicenceExpiryState;
  @ApiProperty({ type: Number, nullable: true, description: 'Days from asOfDate to validUntil (negative once expired); null without a date or once withdrawn' }) daysLeft!: number | null;
}

export class LicenceListResponse {
  @ApiProperty({ format: 'date', description: 'The IST date the badges were computed for (the server’s clock)' }) asOfDate!: string;
  @ApiProperty({ type: [LicenceListItemDto], description: 'Active first, then by validUntil (soonest first, none last); at most 500' }) items!: LicenceListItemDto[];
}

export class CoverageGapDto {
  @ApiProperty({ enum: ['client', 'site'], description: '`client` — the brand’s licence for this site is missing; `site` — the site’s own' }) holder!: 'client' | 'site';
  @ApiProperty({ required: false, format: 'uuid', description: 'The client of a client gap' }) clientId?: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty({ enum: [...LICENCE_NEEDS] }) need!: LicenceNeed;
  @ApiProperty({ enum: [...LICENCE_KINDS], isArray: true, description: 'The kinds that would close the gap' }) coveredBy!: LicenceKind[];
  @ApiProperty({ minimum: 1, description: 'Distinct SKUs needing it there — on hand, or on an open PO or ASN' }) skuCount!: number;
}

export class CoverageGapsResponse {
  @ApiProperty({ format: 'date', description: 'The IST date the gaps were judged for' }) asOfDate!: string;
  @ApiProperty({ type: [CoverageGapDto], description: 'Empty when every drug and food good is covered' }) gaps!: CoverageGapDto[];
}

/** Story 1-6d — the enforcement switch's PUT. */
export class SetLicencePolicyDto {
  @ApiProperty({ description: 'On: an uncovered drug or food receipt line goes to review (grn.licence-refused) and such an order is refused (409 licence-not-covered). Off by default' })
  @IsBoolean()
  enforce!: boolean;

  @ApiProperty({
    required: false,
    type: 'integer',
    minimum: 0,
    description:
      'The known coverage gap count the owner saw and accepted (absent = 0). Turning enforcement ON while the live count exceeds it is refused 409 licence-gaps-unacknowledged with the live gapCount — re-confirm with that count. A precondition only — not part of the idempotency fingerprint. Ignored when turning off',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  acknowledgedGapCount?: number;
}

/** Story 1-6d — the switch as the GET and the PUT answer it. */
export class LicencePolicyResponse {
  @ApiProperty({ description: 'Whether licence enforcement is on (a tenant that never set it is off)' }) enforce!: boolean;
  @ApiProperty({
    minimum: 0,
    description:
      'Known coverage gaps today (IST) — the length of GET …/licences/coverage. A lower bound: a blind receipt, or an order of goods with no stock or open document anywhere, can be refused without having been a gap',
  })
  gapCount!: number;
}

/** Story 1-6d — the PUT's answer: `gapCount` only on an off→on transition (the one arm that scans the gaps). */
export class SetLicencePolicyResponse {
  @ApiProperty({ description: 'Whether licence enforcement is now on' }) enforce!: boolean;
  @ApiProperty({
    required: false,
    minimum: 0,
    description: 'The known coverage gaps when this PUT turned enforcement on; absent otherwise (read GET …/licence-policy for today\'s count)',
  })
  gapCount?: number;
}
