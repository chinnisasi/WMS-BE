import {
  MAX_SNAPSHOT_PACK_TASKS,
  truncateToWholeGroups,
} from '../src/modules/outbound/outbound.facade';

/**
 * The snapshot's pack-task ceiling (Story 10.7, review W8/W9), unit-tested as
 * a pure function over the over-read rows — the `pick-truncation.spec.ts`
 * pattern. The e2e suite cannot reach this boundary without seeding five
 * hundred pack lines, so the branch that decides WHICH orders a bench sees
 * would otherwise be unreachable from every test and arbitrarily breakable.
 *
 * The contract: cut only on ORDER boundaries (the bench's exact-match gate
 * needs every SKU of an order — a half-delivered order could never commit),
 * and never hand back nothing while packable work exists. `truncateToWhole-
 * Groups` is the pick precedent parameterized by the group key, so these
 * tests also pin the row the extraction changed: the straddle decision reads
 * the row just past the ceiling, NOT the over-read's last row.
 */

/** `n` rows belonging to one order — the ordering the query guarantees. */
function orderRows(orderId: string, n: number): { orderId: string; tag: string }[] {
  return Array.from({ length: n }, (_, i) => ({ orderId, tag: `${orderId}#${i}` }));
}

const byOrder = (row: { orderId: string }): string => row.orderId;

describe('truncateToWholeGroups (story 10.7 — the snapshot pack-task ceiling)', () => {
  it('returns everything, unchanged, when the over-read is within the ceiling', () => {
    const rows = [...orderRows('A', 2), ...orderRows('B', 3)];
    expect(truncateToWholeGroups(rows, 10, byOrder)).toEqual(rows);
    // Exactly at the ceiling is still "within" — the over-read reads one
    // extra row, so `length === max` means nothing was left behind.
    expect(truncateToWholeGroups(rows, 5, byOrder)).toEqual(rows);
  });

  it('drops the order that straddles the ceiling, whole — even with orders after it', () => {
    // A=3, B=4, C=3, ceiling 6: the cut falls inside B (its rows sit at
    // indices 3..6, so the row just past the ceiling is still B's) — B goes
    // entirely, C is simply not reached. The inline version this function
    // replaced checked the over-read's LAST row (C) and would have
    // half-delivered B instead.
    const rows = [...orderRows('A', 3), ...orderRows('B', 4), ...orderRows('C', 3)];
    const kept = truncateToWholeGroups(rows, 6, byOrder);
    expect(kept.map((row) => row.orderId)).toEqual(['A', 'A', 'A']);
  });

  it('keeps an order that ends exactly on the ceiling', () => {
    // A=3, B=3, ceiling 3: the cut falls on A's boundary, so A survives whole
    // and B is simply not included — nothing is straddling.
    const rows = [...orderRows('A', 3), ...orderRows('B', 3)];
    const kept = truncateToWholeGroups(rows, 3, byOrder);
    expect(kept.map((row) => row.orderId)).toEqual(['A', 'A', 'A']);
  });

  it('a SINGLE order larger than the ceiling returns truncated rather than empty', () => {
    // The reachable exception: one order whose SKU rows alone exceed the
    // ceiling. Dropping it whole would hand the bench an empty snapshot while
    // packable work exists — a truncated order beats no order, and the
    // exact-match gate never sees a count it cannot reconcile (the snapshot
    // simply omits that order).
    const rows = orderRows('BIG', 7);
    const kept = truncateToWholeGroups(rows, 4, byOrder);
    expect(kept).toHaveLength(4);
    expect(kept.every((row) => row.orderId === 'BIG')).toBe(true);
  });

  it('never returns empty while the over-read holds rows', () => {
    for (const max of [1, 2, 3, 5, 8]) {
      for (const rows of [
        orderRows('ONE', 9),
        [...orderRows('A', 1), ...orderRows('B', 9)],
        [...orderRows('A', 9), ...orderRows('B', 1)],
      ]) {
        const kept = truncateToWholeGroups(rows, max, byOrder);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept.length).toBeLessThanOrEqual(max);
      }
    }
  });

  it('never splits an order across the boundary unless that order is the only one kept', () => {
    const rows = [...orderRows('A', 2), ...orderRows('B', 2), ...orderRows('C', 9)];
    const kept = truncateToWholeGroups(rows, 5, byOrder);
    // The cut falls inside C, and A+B survive — so C must be absent entirely.
    expect(kept.map((row) => row.orderId)).toEqual(['A', 'A', 'B', 'B']);
    const byGroup = new Map<string, number>();
    for (const row of kept) byGroup.set(row.orderId, (byGroup.get(row.orderId) ?? 0) + 1);
    expect([...byGroup.values()]).toEqual([2, 2]);
  });

  it('the shipped ceiling is a positive bound (the snapshot is never unbounded)', () => {
    expect(MAX_SNAPSHOT_PACK_TASKS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_SNAPSHOT_PACK_TASKS)).toBe(true);
  });

  it('does not mutate the input', () => {
    const rows = [...orderRows('A', 3), ...orderRows('B', 3)];
    const before = rows.map((row) => row.tag);
    truncateToWholeGroups(rows, 4, byOrder);
    expect(rows.map((row) => row.tag)).toEqual(before);
  });
});
