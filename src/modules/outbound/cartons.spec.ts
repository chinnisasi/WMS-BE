import {
  aggregateCartons,
  assertCartonMeasurements,
  assertCartonQuantities,
  cartonsHashForm,
  compareCartonContents,
  grossWeightOf,
  packDimensionsOf,
  sameSplit,
  shipmentWeightOf,
  type CartonTotalsTarget,
} from './cartons';

const A = '01a18ba8-4743-79dd-8fe5-000000000001';
const B = '01a18ba8-4743-79dd-8fe5-000000000002';
const CW = '01a18ba8-4743-79dd-8fe5-000000000003';
const U1 = '01a18ba8-4743-79dd-8fe5-00000000000a';
const U2 = '01a18ba8-4743-79dd-8fe5-00000000000b';
const U3 = '01a18ba8-4743-79dd-8fe5-00000000000c';

function target(entries: [string, number][], ids: [string, string[]][] = []): CartonTotalsTarget {
  return { totals: new Map(entries), handlingUnitIdsBySku: new Map(ids) };
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const e = err as { getStatus?: () => number; message: string; getResponse?: () => { code?: string } };
    expect(e.getStatus?.()).toBe(400);
    expect(e.getResponse?.().code).toBe('validation-failed');
    return e.message;
  }
  throw new Error('expected a refusal');
}

describe('story 4-5a — aggregateCartons (A6, A32)', () => {
  it('aggregates each carton per SKU in milli-units and keeps body order', () => {
    const cartons = aggregateCartons(
      [
        { scanned: [{ skuId: A, qty: 4 }, { skuId: A, qty: 2 }], weightGrams: 3200 },
        { scanned: [{ skuId: B, qty: 4 }, { skuId: A, qty: 4 }], weightGrams: 2800 },
      ],
      target([
        [A, 10_000],
        [B, 4_000],
      ]),
    );
    expect(cartons.map((c) => [c.seq, [...c.totals], c.weightGrams])).toEqual([
      [1, [[A, 6_000]], 3200],
      [2, [[B, 4_000], [A, 4_000]], 2800],
    ]);
  });

  it('refuses cartons that do not add up to the scan (the matrix row)', () => {
    expect(
      refusal(() =>
        aggregateCartons([{ scanned: [{ skuId: A, qty: 6 }] }, { scanned: [{ skuId: A, qty: 3 }] }], target([[A, 10_000]])),
      ),
    ).toMatch(/carton contents do not add up to the scanned parcel/);
    // A SKU in a carton that was never scanned.
    expect(refusal(() => aggregateCartons([{ scanned: [{ skuId: B, qty: 1 }] }], target([[A, 1_000]])))).toMatch(/do not add up/);
  });

  it('refuses an empty carton, naming it', () => {
    expect(refusal(() => aggregateCartons([{ scanned: [{ skuId: A, qty: 1 }] }, { scanned: [] }]))).toMatch(/Carton 2 is empty/);
  });

  it('refuses a case in two cartons, a case missing, and a case not scanned', () => {
    const t = target([[CW, 2_000]], [[CW, [U1, U2].sort()]]);
    expect(
      refusal(() =>
        aggregateCartons(
          [
            { scanned: [{ skuId: CW, qty: 1, handlingUnitIds: [U1] }] },
            { scanned: [{ skuId: CW, qty: 1, handlingUnitIds: [U1] }] },
          ],
          t,
        ),
      ),
    ).toMatch(/carton 1 and carton 2/);
    expect(
      refusal(() =>
        aggregateCartons(
          [{ scanned: [{ skuId: CW, qty: 1, handlingUnitIds: [U1] }] }, { scanned: [{ skuId: CW, qty: 1, handlingUnitIds: [U3] }] }],
          t,
        ),
      ),
    ).toMatch(/does not hold it under that SKU/);
    expect(
      refusal(() => aggregateCartons([{ scanned: [{ skuId: CW, qty: 2, handlingUnitIds: [U1] }] }], t)),
    ).toMatch(/no carton holds it under that SKU/);
  });

  it('compares case ids per SKU: two catch-weight SKUs with their cases swapped are refused (review)', () => {
    const CW2 = '01a18ba8-4743-79dd-8fe5-000000000004';
    const t = target(
      [
        [CW, 1_000],
        [CW2, 1_000],
      ],
      [
        [CW, [U1]],
        [CW2, [U2]],
      ],
    );
    // Same global set {U1, U2}, but U2 filed under CW and U1 under CW2.
    expect(
      refusal(() =>
        aggregateCartons(
          [{ scanned: [{ skuId: CW, qty: 1, handlingUnitIds: [U2] }] }, { scanned: [{ skuId: CW2, qty: 1, handlingUnitIds: [U1] }] }],
          t,
        ),
      ),
    ).toMatch(/does not hold it under that SKU/);
    // The right filing passes.
    expect(
      aggregateCartons(
        [{ scanned: [{ skuId: CW, qty: 1, handlingUnitIds: [U1] }] }, { scanned: [{ skuId: CW2, qty: 1, handlingUnitIds: [U2] }] }],
        t,
      ),
    ).toHaveLength(2);
  });

  it('refuses a line whose quantity rounds to zero milli-units, naming its carton (review — never a 500 at the insert)', () => {
    expect(refusal(() => aggregateCartons([{ scanned: [{ skuId: A, qty: 1 }] }, { scanned: [{ skuId: A, qty: 0.0004 }] }]))).toMatch(
      /^Carton 2: scanned quantity must be a positive quantity/,
    );
  });

  it('type-checks a payload no DTO validated — always a 400, never a TypeError (A32)', () => {
    for (const bad of ['x', {}, null, 3, [{}], [null], [{ scanned: 'x' }], [{ scanned: [null] }], [{ scanned: [{ skuId: 1, qty: 1 }] }], [{ scanned: [{ skuId: A, qty: '1' }] }], [{ scanned: [{ skuId: A, qty: 1, handlingUnitIds: 'x' }] }], [{ scanned: [{ skuId: A, qty: 1 }], weightGrams: '9' }], [{ scanned: [{ skuId: A, qty: 1 }], weightGrams: 1.5 }], [{ scanned: [{ skuId: A, qty: 1 }], dimensionsMm: { lengthMm: 1 } }], [{ scanned: [{ skuId: A, qty: 1 }], dimensionsMm: 'big' }]]) {
      refusal(() => aggregateCartons(bad));
    }
  });

  it('a null weight is absent (sync-report passes `?? null`)', () => {
    const [carton] = aggregateCartons([{ scanned: [{ skuId: A, qty: 1 }], weightGrams: null, dimensionsMm: null }]);
    expect(carton!.weightGrams).toBeNull();
    expect(carton!.dimensionsMm).toBeNull();
  });

  it('bounds the carton count, the lines per carton and the lines in all', () => {
    expect(refusal(() => aggregateCartons([]))).toMatch(/1 to 200 cartons/);
    expect(refusal(() => aggregateCartons(Array.from({ length: 201 }, () => ({ scanned: [{ skuId: A, qty: 1 }] }))))).toMatch(/1 to 200/);
    expect(refusal(() => aggregateCartons([{ scanned: Array.from({ length: 501 }, () => ({ skuId: A, qty: 1 })) }]))).toMatch(/at most 500/);
    const fiveHundred = { scanned: Array.from({ length: 500 }, () => ({ skuId: A, qty: 1 })) };
    expect(refusal(() => aggregateCartons(Array.from({ length: 5 }, () => fiveHundred)))).toMatch(/2000 scan lines in all/);
  });
});

describe('story 4-5a — the hash normal form', () => {
  it('sorts SKUs and ids inside a carton, keeps carton order, drops absent measurements', () => {
    const cartons = aggregateCartons([
      { scanned: [{ skuId: B, qty: 1 }, { skuId: A, qty: 2 }], dimensionsMm: { heightMm: 3, widthMm: 2, lengthMm: 1 } },
      { scanned: [{ skuId: CW, qty: 2, handlingUnitIds: [U2, U1] }], weightGrams: 900 },
    ]);
    expect(JSON.stringify(cartonsHashForm(cartons))).toBe(
      `[{"scanned":[{"skuId":"${A}","qty":2000},{"skuId":"${B}","qty":1000}],"dimensionsMm":{"lengthMm":1,"widthMm":2,"heightMm":3}},` +
        `{"scanned":[{"skuId":"${CW}","qty":2000,"handlingUnitIds":["${U1}","${U2}"]}],"weightGrams":900}]`,
    );
  });

  it('sameSplit is order-sensitive across cartons, insensitive within one', () => {
    const one = aggregateCartons([{ scanned: [{ skuId: A, qty: 1 }, { skuId: B, qty: 1 }] }, { scanned: [{ skuId: A, qty: 1 }] }]);
    const same = aggregateCartons([{ scanned: [{ skuId: B, qty: 1 }, { skuId: A, qty: 1 }] }, { scanned: [{ skuId: A, qty: 1 }] }]);
    const swapped = aggregateCartons([{ scanned: [{ skuId: A, qty: 1 }] }, { scanned: [{ skuId: A, qty: 1 }, { skuId: B, qty: 1 }] }]);
    const reweighed = aggregateCartons([{ scanned: [{ skuId: A, qty: 1 }, { skuId: B, qty: 1 }], weightGrams: 5 }, { scanned: [{ skuId: A, qty: 1 }] }]);
    expect(sameSplit(one, same)).toBe(true);
    expect(sameSplit(one, swapped)).toBe(false);
    expect(sameSplit(one, reweighed)).toBe(false);
  });
});

describe('story 4-5a — the per-carton rules', () => {
  const facts = new Map([
    [A, { code: 'A', uom: 'EA', catchWeight: false }],
    [CW, { code: 'CW', uom: 'EA', catchWeight: true }],
  ]);

  it('A31: an each-counted SKU split 6.5 + 3.5 is refused although the total is 10', () => {
    const cartons = aggregateCartons([{ scanned: [{ skuId: A, qty: 6.5 }] }, { scanned: [{ skuId: A, qty: 3.5 }] }], target([[A, 10_000]]));
    expect(refusal(() => assertCartonQuantities(cartons, facts))).toMatch(/^Carton 1:/);
  });

  it('A31: a catch-weight carton qty must equal its case count; ids on a plain SKU are refused', () => {
    const wrong = aggregateCartons([{ scanned: [{ skuId: CW, qty: 3, handlingUnitIds: [U1] }] }]);
    expect(refusal(() => assertCartonQuantities(wrong, facts))).toMatch(/must equal the cases/);
    const plainIds = aggregateCartons([{ scanned: [{ skuId: A, qty: 1, handlingUnitIds: [U1] }] }]);
    expect(refusal(() => assertCartonQuantities(plainIds, facts))).toMatch(/not catch-weight/);
    const right = aggregateCartons([{ scanned: [{ skuId: CW, qty: 2, handlingUnitIds: [U1, U2] }] }, { scanned: [{ skuId: A, qty: 4 }] }]);
    expect(() => assertCartonQuantities(right, facts)).not.toThrow();
  });

  it('measurements: bounds on every surface, and the device never sends dimensions', () => {
    const heavy = aggregateCartons([{ scanned: [{ skuId: A, qty: 1 }], weightGrams: 1_000_001 }]);
    expect(refusal(() => assertCartonMeasurements(heavy, { device: false }))).toMatch(/Carton 1: weightGrams/);
    const zero = aggregateCartons([{ scanned: [{ skuId: A, qty: 1 }] }, { scanned: [{ skuId: A, qty: 1 }], weightGrams: 0 }]);
    expect(refusal(() => assertCartonMeasurements(zero, { device: false }))).toMatch(/Carton 2/);
    const dims = aggregateCartons([{ scanned: [{ skuId: A, qty: 1 }], dimensionsMm: { lengthMm: 1, widthMm: 1, heightMm: 1 } }]);
    expect(() => assertCartonMeasurements(dims, { device: false })).not.toThrow();
    expect(refusal(() => assertCartonMeasurements(dims, { device: true }))).toMatch(/handheld pack does not record carton dimensions/);
  });
});

describe('story 4-5a — contents and weights', () => {
  it('compareCartonContents names every SKU whose quantity or case ids differ, dropping zero entries (A8, A36)', () => {
    const packed = target(
      [
        [A, 10_000],
        [B, 0],
        [CW, 1_000],
      ],
      [[CW, [U1]]],
    );
    expect(compareCartonContents(packed, aggregateCartons([{ scanned: [{ skuId: A, qty: 10 }, { skuId: CW, qty: 1, handlingUnitIds: [U1] }] }]))).toEqual([]);
    expect(compareCartonContents(packed, aggregateCartons([{ scanned: [{ skuId: A, qty: 9 }, { skuId: CW, qty: 1, handlingUnitIds: [U2] }] }]))).toEqual([
      { skuId: A, packed: 10_000, cartoned: 9_000 },
      { skuId: CW, packed: 1_000, cartoned: 1_000 },
    ]);
  });

  it('gross weight only when every carton is weighed; a shipment sees it only within its bound (A33); dims only for one carton (A39)', () => {
    expect(grossWeightOf([{ weightGrams: 3200 }, { weightGrams: 2800 }])).toBe(6000);
    expect(grossWeightOf([{ weightGrams: 3200 }, { weightGrams: null }])).toBeNull();
    const forty = Array.from({ length: 40 }, () => ({ weightGrams: 30_000 }));
    expect(grossWeightOf(forty)).toBe(1_200_000);
    expect(shipmentWeightOf(1_200_000, 1_000_000)).toBeNull();
    expect(shipmentWeightOf(6000, 1_000_000)).toBe(6000);
    const d = { lengthMm: 1, widthMm: 2, heightMm: 3 };
    expect(packDimensionsOf([{ dimensionsMm: d }])).toEqual(d);
    expect(packDimensionsOf([{ dimensionsMm: null }, { dimensionsMm: d }])).toBeNull();
  });
});
