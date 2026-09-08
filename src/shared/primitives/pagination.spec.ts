import { baseQuantity, gstBps } from './quantity';
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

  test('quantities are non-negative integers in base UoM; GST is basis points', () => {
    expect(baseQuantity(144)).toBe(144);
    expect(() => baseQuantity(1.5)).toThrow();
    expect(() => baseQuantity(-1)).toThrow();
    expect(gstBps(18)).toBe(1800);
    expect(gstBps(0)).toBe(0);
    expect(() => gstBps(101)).toThrow();
    expect(() => gstBps(Number.NaN)).toThrow(); // NaN passes range comparisons
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