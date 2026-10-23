import {
  ALLOCATION_RULES,
  effectiveLineRule,
  isBatchAllocatableAt,
  meetsMinimumShelfLife,
  minimumJudgementDate,
  rankSlots,
} from '../src/shared/primitives/batch-allocation';
import { istDaysBetween, istMidnightOf } from '../src/shared/primitives/time';
import { buildStockPool } from '../src/modules/outbound/replan';
import { bindChunkRows } from '../src/modules/outbound/wave.command';

/** A batch "expires <label date>" as received: the instant its IST label date begins. */
const expiring = (date: string) => ({ status: 'active', expiryDate: istMidnightOf(date) });
/** 10:00 IST on an IST date. */
const at = (date: string) => Date.parse(`${date}T04:30:00.000Z`);

describe('story 4-3a: the shared allocation primitive', () => {
  it('ALLOCATION_RULES is exactly fefo, fifo', () => {
    expect([...ALLOCATION_RULES]).toEqual(['fefo', 'fifo']);
  });

  describe('isBatchAllocatableAt', () => {
    it('A22: minimum 90, expiry 31 Mar 2027 — allocatable through 31 Dec 2026, refused from 1 Jan 2027 (non-leap)', () => {
      const batch = expiring('2027-03-31');
      expect(istDaysBetween('2026-12-31', '2027-03-31')).toBe(90);
      expect(isBatchAllocatableAt(batch, at('2026-12-31'), 90)).toBe(true);
      expect(isBatchAllocatableAt(batch, at('2027-01-01'), 90)).toBe(false);
    });

    it('A22: in a leap year (31 Mar 2028) the boundary moves a day — through 1 Jan 2028, refused from 2 Jan', () => {
      const batch = expiring('2028-03-31');
      expect(isBatchAllocatableAt(batch, at('2028-01-01'), 90)).toBe(true);
      expect(isBatchAllocatableAt(batch, at('2028-01-02'), 90)).toBe(false);
    });

    it('judges at the IST date, not the UTC one: 23:59 IST and 00:00 IST straddle the boundary', () => {
      const batch = expiring('2027-03-31');
      // 2026-12-31 23:59:59.999 IST = 18:29:59.999Z — still the 31st in IST.
      expect(isBatchAllocatableAt(batch, Date.parse('2026-12-31T18:29:59.999Z'), 90)).toBe(true);
      expect(isBatchAllocatableAt(batch, Date.parse('2026-12-31T18:30:00.000Z'), 90)).toBe(false);
    });

    it('a null minimum and an undated batch are never limited; blocked and expired are never allocatable', () => {
      expect(isBatchAllocatableAt(expiring('2027-01-02'), at('2027-01-01'), null)).toBe(true);
      expect(isBatchAllocatableAt({ status: 'active', expiryDate: null }, at('2027-01-01'), 3650)).toBe(true);
      expect(isBatchAllocatableAt({ status: 'blocked', expiryDate: null }, at('2027-01-01'), null)).toBe(false);
      // 3-3a's boundary: drawable AT the stored instant, expired a millisecond later.
      const batch = expiring('2027-01-01');
      expect(isBatchAllocatableAt(batch, Date.parse(batch.expiryDate), null)).toBe(true);
      expect(isBatchAllocatableAt(batch, Date.parse(batch.expiryDate) + 1, null)).toBe(false);
      // An unparseable expiry fails closed.
      expect(isBatchAllocatableAt({ status: 'active', expiryDate: 'not-a-date' }, at('2027-01-01'), null)).toBe(false);
      expect(meetsMinimumShelfLife('not-a-date', at('2027-01-01'), 5)).toBe(false);
    });

    it('A3: the minimum is judged on minJudgedOn when given; expiry is still judged at the op instant', () => {
      const batch = expiring('2027-03-31');
      // Picked 1 Jan (89 days) but judged on 31 Dec (90): allocatable.
      expect(isBatchAllocatableAt(batch, at('2027-01-01'), 90, '2026-12-31')).toBe(true);
      // The grace never revives an expired batch.
      const gone = expiring('2027-01-01');
      expect(isBatchAllocatableAt(gone, at('2027-01-02'), null, '2026-12-30')).toBe(false);
    });
  });

  it('A3: minimumJudgementDate = max(plan date, pick date − 1)', () => {
    // Planned 23:50 on D, picked 00:10 on D+1 → judged on D.
    expect(minimumJudgementDate('2026-12-31', '2027-01-01')).toBe('2026-12-31');
    // Planned Monday, picked Thursday → judged Wednesday.
    expect(minimumJudgementDate('2026-10-19', '2026-10-22')).toBe('2026-10-21');
    // Same day → the plan date.
    expect(minimumJudgementDate('2026-10-19', '2026-10-19')).toBe('2026-10-19');
    // Across a month and a year end.
    expect(minimumJudgementDate('2026-11-01', '2027-01-01')).toBe('2026-12-31');
  });

  it('A21: istDaysBetween has one home — dates in, whole days out, negative when earlier', () => {
    expect(istDaysBetween('2026-12-31', '2027-03-31')).toBe(90);
    expect(istDaysBetween('2028-01-01', '2028-03-31')).toBe(90);
    expect(istDaysBetween('2026-10-19', '2026-10-18')).toBe(-1);
  });

  it('a legacy (null) line rule draws as fefo', () => {
    expect(effectiveLineRule(null)).toBe('fefo');
    expect(effectiveLineRule('fifo')).toBe('fifo');
  });

  describe('rankSlots', () => {
    const facts = new Map([
      ['L-SOON', { expiryDate: istMidnightOf('2027-01-01'), createdAt: '2026-06-01T00:00:00.000Z' }],
      ['L-LATE', { expiryDate: istMidnightOf('2027-06-01'), createdAt: '2026-01-01T00:00:00.000Z' }],
      ['U-OLD', { expiryDate: null, createdAt: '2025-01-01T00:00:00.000Z' }],
      ['U-NEW', { expiryDate: null, createdAt: '2026-09-01T00:00:00.000Z' }],
    ]);
    const factsOf = (id: string) => facts.get(id);
    const slots = [
      { walkRank: 0, batchId: null, tag: 'A-uncovered' },
      { walkRank: 0, batchId: 'L-LATE', tag: 'A-late' },
      { walkRank: 0, batchId: 'U-NEW', tag: 'A-unew' },
      { walkRank: 1, batchId: 'U-OLD', tag: 'B-uold' },
      { walkRank: 1, batchId: 'L-SOON', tag: 'B-soon' },
      { walkRank: 1, batchId: null, tag: 'B-uncovered' },
    ];

    it('fefo: dated by expiry → undated by lot first received → batch-less in walk order (warehouse-wide)', () => {
      expect(rankSlots(slots, 'fefo', factsOf).map((s) => s.tag)).toEqual([
        'B-soon',
        'A-late',
        'B-uold',
        'A-unew',
        'A-uncovered',
        'B-uncovered',
      ]);
    });

    it('fifo: batches by lot first received → batch-less in walk order', () => {
      expect(rankSlots(slots, 'fifo', factsOf).map((s) => s.tag)).toEqual([
        'B-uold',
        'A-late',
        'B-soon',
        'A-unew',
        'A-uncovered',
        'B-uncovered',
      ]);
    });

    it('ties go to walk rank, then batch id; an untracked SKU keeps walk order exactly', () => {
      const tie = { expiryDate: istMidnightOf('2027-01-01'), createdAt: '2026-01-01T00:00:00.000Z' };
      const tied = (id: string) => (id.startsWith('T') ? tie : undefined);
      expect(
        rankSlots(
          [
            { walkRank: 2, batchId: 'T1' },
            { walkRank: 1, batchId: 'T2' },
            { walkRank: 1, batchId: 'T0' },
          ],
          'fefo',
          tied,
        ).map((s) => `${s.walkRank}:${s.batchId}`),
      ).toEqual(['1:T0', '1:T2', '2:T1']);
      const untracked = [2, 0, 1].map((walkRank) => ({ walkRank, batchId: null }));
      expect(rankSlots(untracked, 'fifo', tied).map((s) => s.walkRank)).toEqual([0, 1, 2]);
    });
  });

  describe('buildStockPool (the shared pool) under a policy', () => {
    const binOrder = [
      { id: 'bin-a', code: 'A-01', storageClass: 'ambient' },
      { id: 'bin-b', code: 'B-01', storageClass: 'ambient' },
    ];
    const base = {
      skuIds: ['sku'],
      binOrder,
      skuClassById: new Map([['sku', 'ambient']]),
      stock: [
        { skuId: 'sku', binId: 'bin-a', quantity: 10_000 },
        { skuId: 'sku', binId: 'bin-b', quantity: 10_000 },
      ],
      batchStock: [
        { skuId: 'sku', binId: 'bin-a', batchId: 'L2', quantity: 10_000 },
        { skuId: 'sku', binId: 'bin-b', batchId: 'L1', quantity: 10_000 },
      ],
      batchIdentities: [
        { id: 'L2', status: 'active', expiryDate: istMidnightOf('2027-06-01'), createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'L1', status: 'active', expiryDate: istMidnightOf('2027-02-01'), createdAt: '2026-06-01T00:00:00.000Z' },
      ],
      at: at('2026-12-01'),
    };

    it('fefo ranks B-01/L1 (sooner) before A-01/L2; fifo the reverse', () => {
      const fefo = buildStockPool({ ...base, policyOf: () => ({ allocationRule: 'fefo', minDays: null }) }).get('sku')!;
      expect(fefo.map((slot) => slot.batchId)).toEqual(['L1', 'L2']);
      const fifo = buildStockPool({ ...base, policyOf: () => ({ allocationRule: 'fifo', minDays: null }) }).get('sku')!;
      expect(fifo.map((slot) => slot.batchId)).toEqual(['L2', 'L1']);
    });

    it('a minimum excludes the short-life batch; minJudgedOn moves the judgement date', () => {
      // L1 has 62 days left on 2026-12-01.
      const pool = buildStockPool({ ...base, policyOf: () => ({ allocationRule: 'fefo', minDays: 90 }) }).get('sku')!;
      expect(pool.map((slot) => slot.batchId)).toEqual(['L2']);
      const judgedEarlier = buildStockPool({
        ...base,
        policyOf: () => ({ allocationRule: 'fefo', minDays: 90 }),
        minJudgedOn: '2026-11-03',
      }).get('sku')!;
      expect(judgedEarlier.map((slot) => slot.batchId)).toEqual(['L1', 'L2']);
    });

    it('batch-less units of a tracked SKU rank after every batch (A4 change 2)', () => {
      const pool = buildStockPool({
        ...base,
        stock: [
          { skuId: 'sku', binId: 'bin-a', quantity: 12_000 },
          { skuId: 'sku', binId: 'bin-b', quantity: 10_000 },
        ],
        policyOf: () => ({ allocationRule: 'fefo', minDays: null }),
      }).get('sku')!;
      expect(pool.map((slot) => `${slot.binId}:${slot.batchId}:${slot.remaining}`)).toEqual([
        'bin-b:L1:10000',
        'bin-a:L2:10000',
        'bin-a:null:2000',
      ]);
    });
  });

  it('A7: the picklist-line insert chunks at floor(65,535 / columns) — 3,640 rows at 18 columns', () => {
    expect(bindChunkRows(18, 65_535)).toBe(3_640);
    expect(bindChunkRows(16, 65_535)).toBe(4_095);
    expect(bindChunkRows(18, 36)).toBe(2);
    expect(bindChunkRows(18, 1)).toBe(1);
  });
});
