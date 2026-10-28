import {
  consigneeArmOf,
  consigneeMinimumDays,
  meetsConsigneeShelfLife,
  SHORTFALL_CAUSES,
} from '../src/shared/primitives/batch-allocation';
import { istMidnightOf } from '../src/shared/primitives/time';
import { bindChunkRows, picklistLineValues, type PlannedSlice } from '../src/modules/outbound/wave.command';

/**
 * Story 4-3b — the pure halves of the consignee shelf-life rule: the percent
 * conversion, the consignee predicate (undated, batch-less, unjudgeable,
 * untracked), the ONE reading of a line's frozen columns (A3), and the
 * insert rows' key set (A5). The HTTP matrix lives in
 * `test/consignee-shelf-life.spec.ts`.
 */

/** 10:00 IST on an IST date. */
const at = (date: string) => Date.parse(`${date}T04:30:00.000Z`);
const dated = (batchId: string, label: string) => ({ batchId, expiryDate: istMidnightOf(label) });

describe('story 4-3b: consigneeMinimumDays (decision 3)', () => {
  it('days only: the days', () => {
    expect(consigneeMinimumDays({ minShelfLifeDays: 120, minShelfLifePercent: null }, 180)).toEqual({ days: 120, judgeable: true });
    expect(consigneeMinimumDays({ minShelfLifeDays: 120, minShelfLifePercent: null }, null)).toEqual({ days: 120, judgeable: true });
  });

  it('percent of the SKU total shelf life, rounded UP: 70 % of 180 → 126; 33 % of 7 → 3 (ceil 2.31); 1 % of 1 → 1; 100 % of 3650 → 3650', () => {
    expect(consigneeMinimumDays({ minShelfLifeDays: null, minShelfLifePercent: 70 }, 180)).toEqual({ days: 126, judgeable: true });
    expect(consigneeMinimumDays({ minShelfLifeDays: null, minShelfLifePercent: 33 }, 7)).toEqual({ days: 3, judgeable: true });
    expect(consigneeMinimumDays({ minShelfLifeDays: null, minShelfLifePercent: 1 }, 1)).toEqual({ days: 1, judgeable: true });
    expect(consigneeMinimumDays({ minShelfLifeDays: null, minShelfLifePercent: 100 }, 3650)).toEqual({ days: 3650, judgeable: true });
    // An exact quotient is not bumped: 50 % of 10 → 5.
    expect(consigneeMinimumDays({ minShelfLifeDays: null, minShelfLifePercent: 50 }, 10)).toEqual({ days: 5, judgeable: true });
  });

  it('both set: the larger (100 d and 70 % of 180 → 126; 150 d and 70 % of 180 → 150)', () => {
    expect(consigneeMinimumDays({ minShelfLifeDays: 100, minShelfLifePercent: 70 }, 180)).toEqual({ days: 126, judgeable: true });
    expect(consigneeMinimumDays({ minShelfLifeDays: 150, minShelfLifePercent: 70 }, 180)).toEqual({ days: 150, judgeable: true });
  });

  it('a percent rule on a SKU with no total shelf life is UNJUDGEABLE — days null, whatever the days rule says', () => {
    expect(consigneeMinimumDays({ minShelfLifeDays: null, minShelfLifePercent: 70 }, null)).toEqual({ days: null, judgeable: false });
    expect(consigneeMinimumDays({ minShelfLifeDays: 120, minShelfLifePercent: 70 }, null)).toEqual({ days: null, judgeable: false });
  });
});

describe('story 4-3b: meetsConsigneeShelfLife (decision 4, A1)', () => {
  const arm = { days: 120, judgeable: true };
  it('no rule: everything meets it', () => {
    expect(meetsConsigneeShelfLife({ batchId: null, expiryDate: null }, true, at('2026-01-01'), null)).toBe(true);
  });

  it('a dated batch meets it from the minimum (E−120) and not past it (E−119), judged on the op date or the given date', () => {
    // Expiry 2026-05-01: 120 IST days from 2026-01-01.
    expect(meetsConsigneeShelfLife(dated('b', '2026-05-01'), true, at('2026-01-01'), arm)).toBe(true);
    expect(meetsConsigneeShelfLife(dated('b', '2026-05-01'), true, at('2026-01-02'), arm)).toBe(false);
    // The pick's one-day grace: judged on the given date, not the op's.
    expect(meetsConsigneeShelfLife(dated('b', '2026-05-01'), true, at('2026-01-02'), arm, '2026-01-01')).toBe(true);
  });

  it('A1 — a batch-tracked SKU refuses what cannot be proven: an undated batch and batch-less units', () => {
    expect(meetsConsigneeShelfLife({ batchId: 'b', expiryDate: null }, true, at('2026-01-01'), arm)).toBe(false);
    expect(meetsConsigneeShelfLife({ batchId: null, expiryDate: null }, true, at('2026-01-01'), arm)).toBe(false);
  });

  it('A1 — an untracked SKU is never limited', () => {
    expect(meetsConsigneeShelfLife({ batchId: null, expiryDate: null }, false, at('2026-01-01'), arm)).toBe(true);
  });

  it('unjudgeable: no dated batch qualifies (fail closed)', () => {
    expect(meetsConsigneeShelfLife(dated('b', '2036-01-01'), true, at('2026-01-01'), { days: null, judgeable: false })).toBe(false);
  });

  it('an expiry that does not parse fails closed', () => {
    expect(meetsConsigneeShelfLife({ batchId: 'b', expiryDate: 'not-a-date' }, true, at('2026-01-01'), arm)).toBe(false);
  });
});

describe('story 4-3b: consigneeArmOf — the one reading of a line (A3)', () => {
  it('null partner = no consignee rule (every pre-4-3b line)', () => {
    expect(consigneeArmOf({ consigneePartnerId: null, consigneeMinShelfLifeDays: null, consigneeMinShelfLifePercent: null })).toBeNull();
  });

  it('partner + days: judgeable with the days; partner + percent + days: judgeable with the days', () => {
    expect(consigneeArmOf({ consigneePartnerId: 'p', consigneeMinShelfLifeDays: 120, consigneeMinShelfLifePercent: null })).toEqual({
      partnerId: 'p',
      days: 120,
      percent: null,
      judgeable: true,
    });
    expect(consigneeArmOf({ consigneePartnerId: 'p', consigneeMinShelfLifeDays: 126, consigneeMinShelfLifePercent: 70 })).toEqual({
      partnerId: 'p',
      days: 126,
      percent: 70,
      judgeable: true,
    });
  });

  it('partner + percent, days NULL: UNJUDGEABLE — never "no minimum"', () => {
    const arm = consigneeArmOf({ consigneePartnerId: 'p', consigneeMinShelfLifeDays: null, consigneeMinShelfLifePercent: 70 });
    expect(arm).toEqual({ partnerId: 'p', days: null, percent: 70, judgeable: false });
    expect(meetsConsigneeShelfLife(dated('b', '2036-01-01'), true, at('2026-01-01'), arm)).toBe(false);
  });

  it('SHORTFALL_CAUSES is exactly the two consignee causes', () => {
    expect([...SHORTFALL_CAUSES]).toEqual(['consignee-shelf-life', 'consignee-unjudgeable']);
  });
});

describe('story 4-3b (A5): every picklist_lines insert row carries every key', () => {
  const base: Omit<PlannedSlice, 'consigneePartnerId' | 'consigneeMinShelfLifeDays' | 'consigneeMinShelfLifePercent' | 'shortfallCause'> = {
    orderId: 'o1',
    orderLineId: 'ol1',
    skuId: 's1',
    reservationId: 'r1',
    binId: 'b1',
    binCode: 'A-01',
    batchId: null,
    qty: 1000,
    shortfallQty: 0,
    sliceSeq: 0,
    status: 'planned',
    allocationRule: 'fefo',
    minOutboundShelfLifeDays: null,
  };

  it('a row with no consignee rule and one with a rule have the same 22 keys → 2,978 rows per statement', () => {
    const rows = picklistLineValues('t', 'w', [
      {
        picklistId: 'p1',
        slices: [
          { ...base, consigneePartnerId: null, consigneeMinShelfLifeDays: null, consigneeMinShelfLifePercent: null, shortfallCause: null },
          {
            ...base,
            orderLineId: 'ol2',
            binId: null,
            binCode: null,
            qty: 0,
            shortfallQty: 1000,
            status: 'unfulfillable',
            consigneePartnerId: 'cp',
            consigneeMinShelfLifeDays: null,
            consigneeMinShelfLifePercent: 70,
            shortfallCause: 'consignee-unjudgeable',
          },
        ],
      },
    ]);
    expect(rows).toHaveLength(2);
    const keys = rows.map((row) => Object.keys(row).sort());
    expect(keys[0]).toEqual(keys[1]);
    expect(keys[0]).toHaveLength(22);
    expect(keys[0]).toEqual(
      expect.arrayContaining(['consigneePartnerId', 'consigneeMinShelfLifeDays', 'consigneeMinShelfLifePercent', 'shortfallCause']),
    );
    expect(bindChunkRows(Object.keys(rows[0]!).length, 65_535)).toBe(2_978);
  });
});
