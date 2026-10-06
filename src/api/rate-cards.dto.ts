import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateBy,
  ValidateNested,
  buildMessage,
} from 'class-validator';
import { isIsoDate } from '../shared/primitives/time';
import {
  CHARGE_CODES,
  MAX_RATE_AMOUNT_PAISE,
  MIN_RATE_AMOUNT_PAISE,
  RATE_BASES,
  RATE_CARD_STATUSES,
  type ChargeCode,
  type RateBasis,
  type RateCardStatus,
} from '../modules/billing/rate-cards';

/**
 * Story 21-3 — the rate-card surface's DTOs. The DTO checks SHAPE only (the
 * vocabularies, the amount range, a real `YYYY-MM-DD`); the pair rule, the
 * each-charge-once rule and every time rule are the command's, behind the
 * replay lookup (IMPLEMENTATION-GUIDE §1).
 */

/** class-validator: a real calendar date in `YYYY-MM-DD` (shape AND existence). */
function IsIsoDate(): PropertyDecorator {
  return ValidateBy({
    name: 'isIsoDate',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && isIsoDate(value),
      defaultMessage: buildMessage((each) => `${each}$property must be a real calendar date YYYY-MM-DD — got "$value"`),
    },
  });
}

export class RateCardLineDto {
  @ApiProperty({ enum: [...CHARGE_CODES], description: 'The charge this line prices — each at most once per card' })
  @IsIn([...CHARGE_CODES])
  chargeCode!: ChargeCode;

  @ApiProperty({
    enum: [...RATE_BASES],
    description:
      'The basis — fixed per charge: storage ↔ per_thousand_units_per_day (₹ per 1,000 SKU base units per day), inbound_handling ↔ per_receipt_line, pick ↔ per_pick, outbound_handling ↔ per_order',
  })
  @IsIn([...RATE_BASES])
  basis!: RateBasis;

  @ApiProperty({
    minimum: MIN_RATE_AMOUNT_PAISE,
    maximum: MAX_RATE_AMOUNT_PAISE,
    example: 330,
    description: 'Integer paise per unit of the basis, GST-exclusive (₹0 is billed at zero; ₹1 lakh cap)',
  })
  @IsInt()
  @Min(MIN_RATE_AMOUNT_PAISE)
  @Max(MAX_RATE_AMOUNT_PAISE)
  amountPaise!: number;
}

export class RateCardLinesDto {
  @ApiProperty({
    type: [RateCardLineDto],
    maxItems: CHARGE_CODES.length,
    description:
      'The charges this card prices — any subset of the four. A charge with no line is not billed. A draft may have none; activation needs at least one',
  })
  @IsArray()
  @ArrayMaxSize(CHARGE_CODES.length)
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
  @ApiProperty({ enum: [...CHARGE_CODES] })
  chargeCode!: ChargeCode;

  @ApiProperty({ enum: [...RATE_BASES] })
  basis!: RateBasis;

  @ApiProperty({ description: 'Integer paise per unit of the basis, GST-exclusive' })
  amountPaise!: number;
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
