import { ApiProperty } from '@nestjs/swagger';
import { CHARGE_CODES, RATE_BASES, type ChargeCode, type RateBasis } from '../modules/billing/rate-cards';

/**
 * Story 21-4 — the usage (metering) read's response DTOs. (The query class
 * lives beside its route in `billing-usage.controller.ts` — `@Query()` needs
 * it as a VALUE for the validation pipe.)
 */
export class UsageLineDto {
  @ApiProperty({ enum: [...CHARGE_CODES] })
  chargeCode!: ChargeCode;

  @ApiProperty({ enum: [...RATE_BASES], description: 'The basis the charge is metered and priced on (fixed per charge)' })
  basis!: RateBasis;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'kg',
    description:
      'The SKU base UoM of a storage line — storage is counted separately per base unit. Null for the handling counts, and for the single zero storage line of a stretch with no measured stock',
  })
  uom!: string | null;

  @ApiProperty({
    example: '1234.567',
    description:
      'A decimal string. Storage: base-unit-days (Σ of each day’s closing stock in base units, exact to three decimals). Receipt lines, picks, orders: a whole count. A string because a storage total can pass 2^53',
  })
  quantity!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Integer paise per unit of the basis from the rate card in force (storage: per 1,000 base units per day). Null when the card prices no such charge, or no card is in force',
  })
  ratePaise!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Integer paise, GST-exclusive, rounded once half-up (storage: Σ milli-unit-days × rate ÷ 1,000,000). Null = not billed (no card line, no card) — or, for storage, not yet billable (the stretch has unmeasured days)',
  })
  amountPaise!: number | null;
}

export class UsageSegmentDto {
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'The rate card in force over this stretch, or null — no card, so nothing in it is billed',
  })
  rateCardId!: string | null;

  @ApiProperty({ example: '2026-09-01', description: 'First IST date of the stretch (inclusive)' })
  fromDate!: string;

  @ApiProperty({ example: '2026-09-14', description: 'Last IST date of the stretch (inclusive)' })
  toDate!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-09-14',
    description:
      'The last day of this stretch whose storage is measured (≤ toDate), or null when none is. When it is short of toDate, the storage lines carry the measured days only and a null amount (not yet billable) — never ₹0 for unmeasured days',
  })
  storageMeasuredThrough!: string | null;

  @ApiProperty({
    type: [UsageLineDto],
    description: 'Storage (one line per base UoM), then inbound_handling, pick and outbound_handling — summed across warehouses',
  })
  lines!: UsageLineDto[];
}

export class UsageTotalsDto {
  @ApiProperty({ description: 'Σ of every priced line’s amountPaise (GST-exclusive)' })
  billedPaise!: number;

  @ApiProperty({ description: 'How many lines carry no price (no card line, or no card)' })
  unbilledLines!: number;
}

export class ClientUsageResponse {
  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty({ example: '2026-09-01' })
  from!: string;

  @ApiProperty({ example: '2026-09-30' })
  to!: string;

  @ApiProperty({ description: 'The server instant the read ran (ISO-8601 UTC) — counts run to it; a period past it is in progress' })
  asOf!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-09-29',
    description:
      'The last IST date storage is measured through: the minimum snapshot watermark across the client’s warehouses, where a warehouse with events but no snapshot yet counts as the day before its first event. Storage days after it are not in the lines yet. Null: not measured — the tenant’s own client (never snapshotted), or a client with no ledger events',
  })
  storageCompleteThrough!: string | null;

  @ApiProperty({ type: [UsageSegmentDto], description: 'The period split at every rate-card boundary (IST midnights), in time order' })
  segments!: UsageSegmentDto[];

  @ApiProperty({ type: UsageTotalsDto })
  totals!: UsageTotalsDto;
}
