import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateBy,
  ValidateNested,
  buildMessage,
} from 'class-validator';
import { isIsoDate } from '../shared/primitives/time';
import {
  MAX_MINIMUM_MONTHLY_PAISE,
  MINIMUM_COUNTS,
  MIN_RATE_AMOUNT_PAISE,
  RATE_CARD_LINE_BASES,
  RATE_CARD_LINE_CODES,
  RATE_CARD_STATUSES,
  type MinimumCounts,
  type RateCardLineBasis,
  type RateCardLineCode,
  type RateCardStatus,
} from '../modules/billing/rate-cards';

/**
 * Story 21-3 — the rate-card surface's DTOs. The DTO checks SHAPE only (the
 * vocabularies, the amount range, a real `YYYY-MM-DD`); the pair rule, the
 * each-charge-once rule and every time rule are the command's, behind the
 * replay lookup (IMPLEMENTATION-GUIDE §1).
 */

/** class-validator: a real calendar date in `YYYY-MM-DD` (shape AND existence). */
export function IsIsoDate(): PropertyDecorator {
  return ValidateBy({
    name: 'isIsoDate',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && isIsoDate(value),
      defaultMessage: buildMessage((each) => `${each}$property must be a real calendar date YYYY-MM-DD — got "$value"`),
    },
  });
}

export class RateCardLineDto {
  @ApiProperty({
    enum: [...RATE_CARD_LINE_CODES],
    description: 'The charge this line prices — each at most once per card. Story 5-5a: `minimum_monthly` is the minimum monthly charge (per invoice — one per GSTIN)',
  })
  @IsIn([...RATE_CARD_LINE_CODES])
  chargeCode!: RateCardLineCode;

  @ApiProperty({
    enum: [...RATE_CARD_LINE_BASES],
    description:
      'The basis — fixed per charge: storage ↔ per_thousand_units_per_day (₹ per 1,000 SKU base units per day), inbound_handling ↔ per_receipt_line, pick ↔ per_pick, outbound_handling ↔ per_order, minimum_monthly ↔ per_month',
  })
  @IsIn([...RATE_CARD_LINE_BASES])
  basis!: RateCardLineBasis;

  @ApiProperty({
    minimum: MIN_RATE_AMOUNT_PAISE,
    maximum: MAX_MINIMUM_MONTHLY_PAISE,
    example: 330,
    description:
      'Integer paise per unit of the basis, GST-exclusive. A metered rate is ₹0 .. ₹1 lakh (₹0 is billed at zero); the minimum_monthly line ₹0.01 .. ₹1 crore (the per-code bound is the command’s — 400 validation-failed)',
  })
  @IsInt()
  @Min(MIN_RATE_AMOUNT_PAISE)
  @Max(MAX_MINIMUM_MONTHLY_PAISE)
  amountPaise!: number;

  @ApiProperty({
    required: false,
    enum: [...MINIMUM_COUNTS],
    description: 'Story 5-5a — on the minimum_monthly line only: what counts toward the floor — `all` (metered + ad-hoc charges, the default) or `metered`',
  })
  @IsOptional()
  @IsIn([...MINIMUM_COUNTS])
  minimumCounts?: MinimumCounts;
}

export class RateCardLinesDto {
  @ApiProperty({
    type: [RateCardLineDto],
    maxItems: RATE_CARD_LINE_CODES.length,
    description:
      'The charges this card prices — any subset of the four metered charges, plus an optional minimum monthly charge. A charge with no line is not billed. A draft may have none; activation needs at least one',
  })
  @IsArray()
  @ArrayMaxSize(RATE_CARD_LINE_CODES.length)
  @ValidateNested({ each: true })
  @Type(() => RateCardLineDto)
  lines!: RateCardLineDto[];
}

export class CreateRateCardDto extends RateCardLinesDto {}

export class ActivateRateCardDto {
  @ApiProperty({
    example: '2026-11-01',
    description:
      "The IST date the card takes effect, at IST midnight. A client's first card: today (IST) or later; a replacement: tomorrow (IST) or later, and after every existing card's date",
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'effectiveFrom must be YYYY-MM-DD' })
  @IsIsoDate()
  effectiveFrom!: string;
}

export class RateCardLineResponseDto {
  @ApiProperty({ enum: [...RATE_CARD_LINE_CODES] })
  chargeCode!: RateCardLineCode;

  @ApiProperty({ enum: [...RATE_CARD_LINE_BASES] })
  basis!: RateCardLineBasis;

  @ApiProperty({ description: 'Integer paise per unit of the basis, GST-exclusive (the minimum: per month)' })
  amountPaise!: number;

  @ApiProperty({ required: false, enum: [...MINIMUM_COUNTS], description: 'Story 5-5a — present on the minimum_monthly line only' })
  minimumCounts?: MinimumCounts;
}

export class RateCardDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({
    enum: [...RATE_CARD_STATUSES],
    description:
      'draft (editable, undated) · active (dated, frozen; scheduled when its date is ahead) · superseded (a later card took over from its date) · cancelled (withdrawn before its date; never in force)',
  })
  status!: RateCardStatus;

  @ApiProperty({ type: String, nullable: true, example: '2026-11-01', description: 'IST date the card takes effect (from IST midnight); null for a draft' })
  effectiveFrom!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-12-01', description: 'IST date a successor took over (exclusive); null unless superseded' })
  effectiveTo!: string | null;

  @ApiProperty({ type: [RateCardLineResponseDto], description: 'The priced charges, in charge order' })
  lines!: RateCardLineResponseDto[];

  @ApiProperty({ format: 'uuid' })
  createdBy!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO-8601 UTC' })
  updatedAt!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  activatedBy!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC' })
  activatedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  cancelledBy!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC' })
  cancelledAt!: string | null;
}

export class RateCardResponse {
  @ApiProperty({ type: RateCardDto })
  rateCard!: RateCardDto;
}

export class RateCardListResponse {
  @ApiProperty({
    type: [RateCardDto],
    description: "The client's cards — the newest 100 drafts first, then EVERY dated card by effectiveFrom descending (never dropped by a bound). Unpaginated",
  })
  items!: RateCardDto[];
}

export class RateCardInForceResponse {
  @ApiProperty({ type: RateCardDto, nullable: true, description: 'The card in force at asOf, or null — the client is not billed then' })
  rateCard!: RateCardDto | null;

  @ApiProperty({ description: 'The instant resolved (ISO-8601 UTC) — the request `at`, or the server clock' })
  asOf!: string;
}
