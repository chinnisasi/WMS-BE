import {
  completeKits,
  followOnLabelSuffix,
  followOnRemainder,
  orderLabelOf,
  stripFollowOnSuffix,
  type RemainderLine,
} from './follow-on';

/** Story 4-2c — the follow-on's pure rules (decision 2, A9, A10). Milli-units. */
describe('followOnRemainder (decision 2 / A9)', () => {
  const plain = (id: string, qty: number, rate: number | null = 1000): RemainderLine => ({ id, skuId: `sku-${id}`, qty, parentLineId: null, ratePaise: rate });

  it('a short plain line owes qty − picked; a full one owes nothing (matrix "Short dispatch")', () => {
    const plan = followOnRemainder([plain('a', 10_000, 4999), plain('b', 5_000)], new Map([['a', 7_000], ['b', 5_000]]));
    expect(plan).toEqual([{ sourceLineId: 'a', skuId: 'sku-a', qty: 3_000, ratePaise: 4999, parentSourceLineId: null }]);
  });

  it('a fully picked order owes nothing (matrix "Full dispatch")', () => {
    expect(followOnRemainder([plain('a', 10_000)], new Map([['a', 10_000]]))).toEqual([]);
  });

  it('a line that picked nothing owes all of it', () => {
    expect(followOnRemainder([plain('a', 2_000)], new Map())).toEqual([
      { sourceLineId: 'a', skuId: 'sku-a', qty: 2_000, ratePaise: 1000, parentSourceLineId: null },
    ]);
  });

  it('A9 — a sub-unit remainder opens no line (1 kg picked 0.998 kg); exactly one base unit does', () => {
    expect(followOnRemainder([plain('kg', 1_000)], new Map([['kg', 998]]))).toEqual([]);
    expect(followOnRemainder([plain('kg', 2_500)], new Map([['kg', 1_500]]))).toEqual([
      { sourceLineId: 'kg', skuId: 'sku-kg', qty: 1_000, ratePaise: 1000, parentSourceLineId: null },
    ]);
    expect(followOnRemainder([plain('kg', 2_500)], new Map([['kg', 1_501]]))).toEqual([]);
  });

  it('a kit Q 2 (A×1, B×2) picked A 2, B 3 → complete 1: parent 1, child B 1, A owed 0 (matrix "Kit partial")', () => {
    const lines: RemainderLine[] = [
      { id: 'kit', skuId: 'sku-kit', qty: 2_000, parentLineId: null, ratePaise: 25_000 },
      { id: 'ca', skuId: 'sku-a', qty: 2_000, parentLineId: 'kit', ratePaise: null },
      { id: 'cb', skuId: 'sku-b', qty: 4_000, parentLineId: 'kit', ratePaise: null },
    ];
    expect(followOnRemainder(lines, new Map([['ca', 2_000], ['cb', 3_000]]))).toEqual([
      { sourceLineId: 'kit', skuId: 'sku-kit', qty: 1_000, ratePaise: 25_000, parentSourceLineId: null },
      { sourceLineId: 'cb', skuId: 'sku-b', qty: 1_000, ratePaise: null, parentSourceLineId: 'kit' },
    ]);
  });

  it('a kit with nothing picked owes the whole kit and every component', () => {
    const lines: RemainderLine[] = [
      { id: 'kit', skuId: 'sku-kit', qty: 3_000, parentLineId: null, ratePaise: null },
      { id: 'ca', skuId: 'sku-a', qty: 3_000, parentLineId: 'kit', ratePaise: null },
      { id: 'cb', skuId: 'sku-b', qty: 6_000, parentLineId: 'kit', ratePaise: null },
    ];
    expect(followOnRemainder(lines, new Map()).map((plan) => [plan.sourceLineId, plan.qty, plan.parentSourceLineId])).toEqual([
      ['kit', 3_000, null],
      ['ca', 3_000, 'kit'],
      ['cb', 6_000, 'kit'],
    ]);
  });

  it('fractional components: a kit of 0.25 kg + 1.5 each per kit, Q 4, picked 0.8 kg / 6 each → complete 3', () => {
    const lines: RemainderLine[] = [
      { id: 'kit', skuId: 'sku-kit', qty: 4_000, parentLineId: null, ratePaise: null },
      { id: 'kg', skuId: 'sku-kg', qty: 1_000, parentLineId: 'kit', ratePaise: null },
      { id: 'ea', skuId: 'sku-ea', qty: 6_000, parentLineId: 'kit', ratePaise: null },
    ];
    // 800 × 4000 / 1000 / 1000 = 3.2 → 3 kits; 6000 → all 4 → min 3.
    expect(followOnRemainder(lines, new Map([['kg', 800], ['ea', 6_000]]))).toEqual([
      { sourceLineId: 'kit', skuId: 'sku-kit', qty: 1_000, ratePaise: null, parentSourceLineId: null },
      { sourceLineId: 'kg', skuId: 'sku-kg', qty: 200, ratePaise: null, parentSourceLineId: 'kit' },
    ]);
  });

  it('a fractional kit quantity fully picked is complete (never floored below itself)', () => {
    const lines: RemainderLine[] = [
      { id: 'kit', skuId: 'sku-kit', qty: 1_500, parentLineId: null, ratePaise: null },
      { id: 'ca', skuId: 'sku-a', qty: 1_500, parentLineId: 'kit', ratePaise: null },
    ];
    expect(followOnRemainder(lines, new Map([['ca', 1_500]]))).toEqual([]);
    expect(completeKits(1_500, [{ qty: 1_500, covered: 1_500 }])).toBe(1_500);
  });

  it('a mixed order: the plain line and the kit each follow their own rule, in source order', () => {
    const lines: RemainderLine[] = [
      plain('p', 5_000),
      { id: 'kit', skuId: 'sku-kit', qty: 1_000, parentLineId: null, ratePaise: null },
      { id: 'ca', skuId: 'sku-a', qty: 2_000, parentLineId: 'kit', ratePaise: null },
    ];
    expect(followOnRemainder(lines, new Map([['p', 4_000], ['ca', 1_000]])).map((plan) => plan.sourceLineId)).toEqual(['p', 'kit', 'ca']);
  });
});

describe('completeKits (A8 / A9)', () => {
  it('counts whole kits, in BigInt, beyond 2^53 intermediate products', () => {
    // 9e12 base units of a kit: the product overflows a double, BigInt does not.
    const q = 9_000_000_000_000_000;
    expect(completeKits(q, [{ qty: q, covered: q - 1_000 }])).toBe(q - 1_000);
  });
  it('no coverage → 0', () => {
    expect(completeKits(2_000, [{ qty: 2_000, covered: 0 }, { qty: 4_000, covered: 4_000 }])).toBe(0);
  });
});

describe('the order label (A10)', () => {
  const id = '019a0000-0000-7000-8000-0000a1b2c3d4';
  const root = '019a0000-0000-7000-8000-0000deadbeef';
  it('a root reads clientOrderRef ?? externalEventId ?? its short id', () => {
    expect(orderLabelOf({ id, clientOrderRef: '1042' })).toBe('1042');
    expect(orderLabelOf({ id, clientOrderRef: null, externalEventId: '5001' })).toBe('5001');
    expect(orderLabelOf({ id })).toBe('a1b2c3d4');
  });
  it('a follow-on carries -BO{seq}, and an unnamed one the ROOT short id', () => {
    expect(orderLabelOf({ id, clientOrderRef: '1042', followOnSeq: 1, followOnRootOrderId: root })).toBe('1042-BO1');
    expect(orderLabelOf({ id, followOnSeq: 2, followOnRootOrderId: root })).toBe('deadbeef-BO2');
    expect(followOnLabelSuffix(null)).toBe('');
  });
  it('the search strips a trailing -BO{n} (and nothing else)', () => {
    expect(stripFollowOnSuffix('1042-BO1')).toBe('1042');
    expect(stripFollowOnSuffix('SO-7-BO12')).toBe('SO-7');
    expect(stripFollowOnSuffix('1042')).toBeNull();
    expect(stripFollowOnSuffix('1042-bo1')).toBeNull();
    expect(stripFollowOnSuffix('-BO1')).toBeNull();
  });
});
