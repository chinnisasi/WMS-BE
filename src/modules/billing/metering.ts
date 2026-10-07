import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { storageSnapshots } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { divideRoundHalfUp } from '../../shared/primitives/money';
import { QUANTITY_DECIMALS } from '../../shared/primitives/quantity';
import { addIsoDays, istDateOf, istMidnightOf, isIsoDate } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertClientInTenantInTx } from '../clients/clients.facade';
import { InboundFacade } from '../inbound/inbound.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import { rateCardSegmentsInTx, type RateCardLineSnapshot } from './billing.facade';
import { CHARGE_BASIS, type ChargeCode, type RateBasis } from './rate-cards';
import { StorageSnapshotService } from './storage-snapshot';

/**
 * Story 21-4 — metering (FR-78, CAP-5): for one client and an inclusive IST
 * date period, the billable quantity of each charge, split by the rate card
 * in force (21-3's segments) and priced. 21-5's client invoice consumes
 * this read; the web shows it as an estimate.
 *
 * Counting units (`BASIS_COUNTING_UNIT`), each with its instant:
 * - storage (`per_thousand_units_per_day`): Σ over the segment's days of the
 *   daily snapshot (base milli-units at the end of the IST day), per base
 *   UoM, across warehouses — only days up to `storageCompleteThrough`. Day
 *   `D` is priced by the card in force at the START of `D`; cards begin at
 *   IST midnights, so a day lies wholly inside one segment.
 * - receipt lines: every GRN line of the client's SKUs, by the GRN's
 *   `recorded_at` (`InboundFacade.countReceiptLinesInTx`).
 * - picks: `picks` rows by `created_at` (`OutboundFacade.countPicksInTx`).
 * - orders: distinct `orderId` of `dispatch.dispatched` events by
 *   `recorded_at` and the event's client (`InventoryFacade.countDispatchedOrdersInTx`).
 *
 * Pricing: one line per (segment, charge, uom), summed across warehouses;
 * the amount in BigInt, rounded ONCE, half up — storage `Σ milli-unit-days ×
 * rate ÷ 1,000,000`, the rest `count × rate`. A charge with no card line, or
 * a stretch with no card, keeps its quantity with a null rate and amount.
 *
 * It freezes nothing and stores nothing (21-5 must meter a period only after
 * its end plus the commit guarantee, and store its own output).
 */

/** The longest period one read meters (inclusive days). */
export const MAX_METERING_DAYS = 366;

/** One priced (or unpriced) line of a segment. */
export interface MeteredLine {
  readonly chargeCode: ChargeCode;
  readonly basis: RateBasis;
  /** The SKU base UoM for storage; null for the handling counts (and an empty storage line). */
  readonly uom: string | null;
  /**
   * A decimal string: base-unit-days for storage (exact, up to three
   * decimals — `Σ milli-unit-days ÷ 1,000`), a whole count otherwise. A
   * string because a storage total can pass 2⁵³.
   */
  readonly quantity: string;
  /** Integer paise per unit of the basis, or null when the card prices no such charge (or no card). */
  readonly ratePaise: number | null;
  /** Integer paise, GST-exclusive, or null when unpriced. */
  readonly amountPaise: number | null;
}

/** One stretch of the period priced by one card — or by none (`rateCardId: null`). */
export interface MeteredSegment {
  readonly rateCardId: string | null;
  /** Inclusive IST dates. */
  readonly fromDate: string;
  readonly toDate: string;
  /**
   * The last day of this segment whose storage is measured (≤ `toDate`), or
   * null when none is. When it is short of `toDate`, the storage lines carry
   * the measured days' quantity but a null amount — never a ₹0 for days not
   * yet measured.
   */
  readonly storageMeasuredThrough: string | null;
  readonly lines: readonly MeteredLine[];
}

export interface MeteredPeriod {
  readonly clientId: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly segments: readonly MeteredSegment[];
  /**
   * The last IST day storage is complete through: the minimum watermark
   * across the client's warehouses, where a warehouse with events but no
   * snapshot yet counts as the day before its first event. Null for the
   * tenant's own client (never snapshotted) and for a client with no events.
   */
  readonly storageCompleteThrough: string | null;
  readonly totals: { readonly billedPaise: number; readonly unbilledLines: number };
}

const MILLI_PER_THOUSAND_UNITS = 1_000_000n;
const MILLI = 10n ** BigInt(QUANTITY_DECIMALS);

/** Milli-units as an exact base-unit decimal string (`1234567` → `1234.567`, `2000` → `2`). */
export function milliToDecimal(milli: bigint): string {
  const negative = milli < 0n;
  const abs = negative ? -milli : milli;
  const whole = (abs / MILLI).toString();
  const frac = (abs % MILLI).toString().padStart(QUANTITY_DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${frac.length === 0 ? whole : `${whole}.${frac}`}`;
}

/** BigInt paise → a JS number, refusing anything past the exact range (a typed 422, never a silent round). */
function safePaise(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProblemException(
      'metering-amount-out-of-range',
      422,
      'Amount out of range',
      `metering: an amount left the exact paise range (${value.toString()} > ${Number.MAX_SAFE_INTEGER}) — meter a shorter period.`,
    );
  }
  return Number(value);
}

/** The storage amount: Σ milli-unit-days × rate ÷ 1,000,000, rounded once, half up. */
export function storageAmountPaise(milliUnitDays: bigint, ratePaise: number): number {
  return safePaise(divideRoundHalfUp(milliUnitDays * BigInt(ratePaise), MILLI_PER_THOUSAND_UNITS));
}

function validation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid metering period', detail);
}

/** The period rules, checked before anything reads (the segments read throws on `from ≥ to`). */
export function assertMeteringPeriod(fromDate: string, toDate: string): void {
  if (!isIsoDate(fromDate)) throw validation(`from must be a real calendar date YYYY-MM-DD (got "${fromDate}").`);
  if (!isIsoDate(toDate)) throw validation(`to must be a real calendar date YYYY-MM-DD (got "${toDate}").`);
  if (fromDate > toDate) throw validation(`from (${fromDate}) is after to (${toDate}).`);
  const days = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_METERING_DAYS) {
    throw validation(`A period covers at most ${MAX_METERING_DAYS} days (got ${days}, ${fromDate} → ${toDate}).`);
  }
}

@Injectable()
export class MeteringService {
  constructor(
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(InboundFacade) private readonly inbound: InboundFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(StorageSnapshotService) private readonly snapshots: StorageSnapshotService,
  ) {}

  /**
   * Story 21-5 — the CLIENT-wide storage watermark (the minimum over every
   * warehouse the client has events in), whatever warehouses a read narrows
   * to: a client invoice's `storage-not-complete` gap reads THIS, so a GSTIN
   * group with counts but no stock events (no snapshot scope) can still
   * issue. Null for the tenant's own client and a client with no events.
   */
  async clientStorageCompleteThroughInTx(tx: TenantTx, tenantId: string, clientId: string): Promise<string | null> {
    const client = await assertClientInTenantInTx(tx, tenantId, clientId);
    if (client.systemOwned) return null;
    const scopes = (await this.inventory.clientWarehousesWithEventsInTx(tx, tenantId, [clientId])).map((scope) => ({
      tenantId,
      clientId,
      warehouseId: scope.warehouseId,
    }));
    return this.snapshots.storageCompleteThroughInTx(tx, scopes);
  }

  /**
   * Meter `[fromDate, toDate]` (IST dates, inclusive) for one client: guards
   * the period FIRST (400s), then the client (404), then reads.
   *
   * Story 21-5 — `options.warehouseIds` narrows the whole read to a set of
   * warehouses (a client invoice meters each supplying GSTIN over its own
   * warehouses): the storage scopes and sum, the receipt-line, pick and
   * dispatched-order counts (the order count's "no earlier dispatch" probe
   * stays tenant-wide). `storageCompleteThrough` is then the minimum over
   * THOSE warehouses' scopes. Absent = every warehouse — byte-identical to
   * 21-4 (the metering suite proves it); the sum over a partition of the
   * tenant's warehouses equals the unfiltered read, charge by charge.
   */
  async meterPeriodInTx(
    tx: TenantTx,
    tenantId: string,
    clientId: string,
    fromDate: string,
    toDate: string,
    options: { readonly warehouseIds?: readonly string[] | undefined } = {},
  ): Promise<MeteredPeriod> {
    const warehouseIds = options.warehouseIds === undefined ? undefined : [...new Set(options.warehouseIds)];
    assertMeteringPeriod(fromDate, toDate);
    const client = await assertClientInTenantInTx(tx, tenantId, clientId);
    const periodFrom = istMidnightOf(fromDate);
    const periodTo = istMidnightOf(addIsoDays(toDate, 1));

    // The card segments, with the no-card stretches filled in as null
    // segments — every instant of the period is in exactly one segment.
    const cardSegments = await rateCardSegmentsInTx(tx, tenantId, clientId, periodFrom, periodTo);
    const stretches: { rateCardId: string | null; lines: readonly RateCardLineSnapshot[]; from: string; to: string }[] = [];
    let cursor = periodFrom;
    for (const segment of cardSegments) {
      if (Date.parse(segment.from) > Date.parse(cursor)) {
        stretches.push({ rateCardId: null, lines: [], from: cursor, to: segment.from });
      }
      stretches.push({ rateCardId: segment.card.id, lines: segment.lines, from: segment.from, to: segment.to });
      cursor = segment.to;
    }
    if (Date.parse(cursor) < Date.parse(periodTo)) {
      stretches.push({ rateCardId: null, lines: [], from: cursor, to: periodTo });
    }

    // Storage: measured for client brands only (decision 4) and complete
    // only through the minimum watermark across the client's scopes.
    let storageCompleteThrough: string | null = null;
    const storageByDay = new Map<string, Map<string, bigint>>();
    if (!client.systemOwned) {
      const scopes = (await this.inventory.clientWarehousesWithEventsInTx(tx, tenantId, [clientId]))
        .filter((scope) => warehouseIds === undefined || warehouseIds.includes(scope.warehouseId))
        .map((scope) => ({
          tenantId,
          clientId,
          warehouseId: scope.warehouseId,
        }));
      storageCompleteThrough = await this.snapshots.storageCompleteThroughInTx(tx, scopes);
      if (storageCompleteThrough !== null && storageCompleteThrough >= fromDate && (warehouseIds === undefined || warehouseIds.length > 0)) {
        const through = storageCompleteThrough < toDate ? storageCompleteThrough : toDate;
        const rows = await tx
          .select({
            day: storageSnapshots.snapshotDate,
            uom: storageSnapshots.uom,
            milli: sql<string>`sum(${storageSnapshots.onHandMilli})::text`,
          })
          .from(storageSnapshots)
          .where(
            and(
              eq(storageSnapshots.tenantId, tenantId),
              eq(storageSnapshots.clientId, clientId),
              gte(storageSnapshots.snapshotDate, fromDate),
              lte(storageSnapshots.snapshotDate, through),
              warehouseIds === undefined ? undefined : inArray(storageSnapshots.warehouseId, warehouseIds),
            ),
          )
          .groupBy(storageSnapshots.snapshotDate, storageSnapshots.uom);
        for (const row of rows) {
          const day = storageByDay.get(row.day) ?? new Map<string, bigint>();
          day.set(row.uom, (day.get(row.uom) ?? 0n) + BigInt(row.milli));
          storageByDay.set(row.day, day);
        }
      }
    }

    const scope = warehouseIds === undefined ? { tenantId, clientId } : { tenantId, clientId, warehouseIds };
    let billedPaise = 0n;
    let unbilledLines = 0;
    const segments: MeteredSegment[] = [];
    for (const stretch of stretches) {
      const fromDay = istDateOf(stretch.from);
      const toDay = addIsoDays(istDateOf(stretch.to), -1);
      const rateOf = (charge: ChargeCode): number | null =>
        stretch.lines.find((line) => line.chargeCode === charge)?.amountPaise ?? null;
      const lines: MeteredLine[] = [];
      const push = (line: MeteredLine): void => {
        lines.push(line);
        if (line.amountPaise === null) unbilledLines += 1;
        else billedPaise += BigInt(line.amountPaise);
      };

      // Storage — one line per base UoM (decision 1), each priced by the
      // card in force at the start of each of its days (this segment's).
      // Only measured days count; a line covering unmeasured days is not
      // priced yet (null amount — never a ₹0 that reads as billed).
      const measuredThrough =
        storageCompleteThrough === null || storageCompleteThrough < fromDay ? null : storageCompleteThrough < toDay ? storageCompleteThrough : toDay;
      const fullyMeasured = measuredThrough === toDay;
      const storageRate = rateOf('storage');
      const perUom = new Map<string, bigint>();
      for (const [day, values] of storageByDay) {
        if (day < fromDay || day > toDay) continue;
        for (const [uom, milli] of values) perUom.set(uom, (perUom.get(uom) ?? 0n) + milli);
      }
      if (perUom.size === 0) {
        push({
          chargeCode: 'storage',
          basis: CHARGE_BASIS.storage,
          uom: null,
          quantity: '0',
          ratePaise: storageRate,
          amountPaise: storageRate === null || !fullyMeasured ? null : 0,
        });
      }
      for (const uom of [...perUom.keys()].sort()) {
        const milliDays = perUom.get(uom)!;
        push({
          chargeCode: 'storage',
          basis: CHARGE_BASIS.storage,
          uom,
          quantity: milliToDecimal(milliDays),
          ratePaise: storageRate,
          amountPaise: storageRate === null || !fullyMeasured ? null : storageAmountPaise(milliDays, storageRate),
        });
      }

      // The handling counts, each over the segment's instants.
      const counts: [ChargeCode, number][] = [
        ['inbound_handling', await this.inbound.countReceiptLinesInTx(tx, scope, stretch.from, stretch.to)],
        ['pick', await this.outbound.countPicksInTx(tx, scope, stretch.from, stretch.to)],
        ['outbound_handling', await this.inventory.countDispatchedOrdersInTx(tx, scope, stretch.from, stretch.to)],
      ];
      for (const [charge, count] of counts) {
        const rate = rateOf(charge);
        push({
          chargeCode: charge,
          basis: CHARGE_BASIS[charge],
          uom: null,
          quantity: String(count),
          ratePaise: rate,
          amountPaise: rate === null ? null : safePaise(BigInt(count) * BigInt(rate)),
        });
      }
      segments.push({ rateCardId: stretch.rateCardId, fromDate: fromDay, toDate: toDay, storageMeasuredThrough: measuredThrough, lines });
    }

    return {
      clientId,
      fromDate,
      toDate,
      segments,
      storageCompleteThrough,
      totals: { billedPaise: safePaise(billedPaise), unbilledLines },
    };
  }
}
