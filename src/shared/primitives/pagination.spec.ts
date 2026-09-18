import {
  MAX_QUANTITY_BASE,
  assertExactQuantity,
  decimalPlaces,
  fromMilli,
  gstBps,
  isAtPrecision,
  milliQuantity,
  signedQuantity,
  toMilli,
} from './quantity';
import { paise, rupees, addPaise, isPaise } from './money';
import { nowIso, assertUtcIso } from './time';
import { buildPage, decodeCursor, encodeCursor } from './pagination';

describe('deterministic primitives (AD-9)', () => {
  test('money is integer paise only', () => {
    expect(paise(19.99)).toBe(1999);
    expect(rupees(paise(19.99))).toBeCloseTo(19.99);
    expect(addPaise(paise(0.1), paise(0.2))).toBe(30); // no float dust
    expect(isPaise(1999)).toBe(true);
    expect(isPaise(19.99)).toBe(false);
    expect(() => paise(Number.NaN)).toThrow();
    expect(() => paise(1e308)).toThrow(); // rounds to Infinity — must not brand it
  });

  test('quantities are non-negative integers in milli-units; GST is basis points', () => {
    expect(milliQuantity(144)).toBe(144);
    expect(() => milliQuantity(1.5)).toThrow();
    expect(() => milliQuantity(-1)).toThrow();
    expect(() => milliQuantity(Number.MAX_SAFE_INTEGER + 2)).toThrow(); // past 2⁵³ nothing is exact
    expect(signedQuantity(-144)).toBe(-144);
    expect(() => signedQuantity(-1.5)).toThrow();
    expect(gstBps(18)).toBe(1800);
    expect(gstBps(0)).toBe(0);
    expect(() => gstBps(101)).toThrow();
    expect(() => gstBps(Number.NaN)).toThrow(); // NaN passes range comparisons
  });

  test('the quantity edge converters round-trip base UoM through milli-units (story 10.1)', () => {
    // An each-counted quantity comes back exactly as it went in — the whole
    // "no user-visible behaviour change" claim in one line.
    expect(toMilli(500)).toBe(500_000);
    expect(fromMilli(500_000)).toBe(500);
    // Three declared decimals, exactly.
    expect(toMilli(18.4)).toBe(18_400);
    expect(fromMilli(18_400)).toBe(18.4);
    expect(toMilli(0.001)).toBe(1);
    expect(fromMilli(1)).toBe(0.001);
    // Finer than the scale rounds AT THE EDGE (story 10.2 refuses instead).
    expect(toMilli(18.4567)).toBe(18_457);
    expect(fromMilli(18_457)).toBe(18.457);
    // Signed deltas convert the same way.
    expect(toMilli(-2.5)).toBe(-2_500);
    expect(fromMilli(-2_500)).toBe(-2.5);
    // `fromMilli` refuses what it cannot convert: a raw `int8` read that
    // missed its `Number(...)` coercion is a string, and a silent NaN in a
    // response body is worse than a loud failure at the boundary.
    expect(() => fromMilli('18400' as unknown as number)).toThrow();
    expect(() => fromMilli(Number.NaN)).toThrow();
    // No float dust on the values that used to produce it.
    expect(toMilli(0.1) + toMilli(0.2)).toBe(300);
    expect(fromMilli(toMilli(0.1) + toMilli(0.2))).toBe(0.3);
    // The range refusal is typed, never a silent wrap.
    expect(() => toMilli(MAX_QUANTITY_BASE * 2)).toThrow();
    expect(() => toMilli(Number.NaN)).toThrow();
  });

  test('decimal places are read from the value, not computed from it (story 10.2)', () => {
    // THE reason this is a string read rather than arithmetic. `v * 1000 % 1`
    // condemns thousands of perfectly honest three-decimal values, because the
    // product is not exact: 1.005 kg — a weight a scale prints every day —
    // multiplies to 1004.9999999999999 and would be refused as "too fine".
    expect(1.005 * 1000).not.toBe(1005);
    expect((1.005 * 1000) % 1).not.toBe(0);
    expect(decimalPlaces(1.005)).toBe(3);
    expect(isAtPrecision(1.005, 3)).toBe(true);
    // And a tolerance is not the fix: the absolute error scales with the
    // value, so the epsilon that forgives 1.005 is the wrong epsilon at 900
    // million. Reading the shortest round-tripping decimal — which, for a
    // value that arrived as JSON, IS the literal the client wrote — has no
    // magnitude dependence at all.
    expect(decimalPlaces(0.1)).toBe(1);
    expect(decimalPlaces(18.4567)).toBe(4);

    expect(decimalPlaces(500)).toBe(0);
    expect(decimalPlaces(-2.5)).toBe(1);
    expect(decimalPlaces(18.4)).toBe(1);
    expect(decimalPlaces(0.001)).toBe(3);
    // Exponential notation is what `String()` gives back below 1e-6, and a
    // naive indexOf('.') would call `1e-7` a whole number.
    expect(String(1e-7)).toBe('1e-7');
    expect(decimalPlaces(1e-7)).toBe(7);
    expect(decimalPlaces(1.5e-7)).toBe(8);
    // …and above the exponent, where the shortest round-trip has no point.
    expect(decimalPlaces(1.5e3)).toBe(0);
    expect(decimalPlaces(0)).toBe(0);
    // A non-finite value can satisfy no precision at all.
    expect(decimalPlaces(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
    expect(isAtPrecision(Number.NaN, 3)).toBe(false);

    // The two declared precisions in the vocabulary, as a unit sees them.
    expect(isAtPrecision(2, 0)).toBe(true);
    expect(isAtPrecision(2.5, 0)).toBe(false);
    expect(isAtPrecision(18.4, 3)).toBe(true);
    expect(isAtPrecision(18.457, 3)).toBe(true);
    expect(isAtPrecision(18.4567, 3)).toBe(false);
  });

  test('the fold accumulator guard fails loudly rather than rounding (story 10.1)', () => {
    expect(assertExactQuantity(1_000, 'ok')).toBe(1_000);
    // Past 2⁵³ the replay fold would round and manufacture a false quarantine.
    expect(() => assertExactQuantity(Number.MAX_SAFE_INTEGER + 2, 'replay fold')).toThrow(
      /exact integer range/,
    );
  });

  test('timestamps are ISO-8601 UTC', () => {
    expect(nowIso()).toMatch(/Z$/);
    expect(() => assertUtcIso('2026-09-08T10:00:00+05:30')).toThrow();
    expect(() => assertUtcIso('2026-02-31T00:00:00Z')).toThrow(); // impossible calendar date
  });

  test('cursor pagination round-trips and detects the next page', () => {
    const rows = [
      { id: '0198-1', createdAt: '2026-09-08T00:00:00Z' },
      { id: '0198-2', createdAt: '2026-09-08T00:00:01Z' },
      { id: '0198-3', createdAt: '2026-09-08T00:00:02Z' },
    ] as const;
    const page = buildPage(rows as unknown as { id: string; createdAt: string }[], 2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor!).id).toBe('0198-2');
    const last = buildPage(rows.slice(2) as unknown as { id: string; createdAt: string }[], 2);
    expect(last.nextCursor).toBeNull();
    expect(encodeCursor({ createdAt: '2026-09-08T00:00:00Z', id: 'x' })).not.toContain('=');
    expect(() => decodeCursor('!!!')).toThrow();
    expect(() => buildPage([] as { id: string; createdAt: string }[], 0)).toThrow();
    expect(() => buildPage([] as { id: string; createdAt: string }[], 1.5)).toThrow();
  });
});
