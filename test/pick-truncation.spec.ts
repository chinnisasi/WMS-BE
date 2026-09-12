import {
  MAX_SNAPSHOT_PICK_TASKS,
  truncateToWholePicklists,
} from '../src/modules/outbound/pick.command';

/**
 * The snapshot's pick-task ceiling (Story 4.3), unit-tested as a pure
 * function over the over-read rows. The e2e suite cannot reach this boundary
 * without seeding five hundred pick lines, so the branch that decides WHICH
 * rows a device gets would otherwise be unreachable from every test and
 * arbitrarily breakable.
 *
 * The contract: cut only on picklist boundaries (a half-delivered walk makes
 * the device's "next walk bin holding this SKU" hint point at a stop the
 * snapshot does not contain), and never hand back nothing while pickable
 * work exists.
 */

/** `n` rows belonging to one picklist — the ordering the query guarantees. */
function walk(picklistId: string, n: number): { picklistId: string; tag: string }[] {
  return Array.from({ length: n }, (_, i) => ({ picklistId, tag: `${picklistId}#${i}` }));
}

describe('truncateToWholePicklists (story 4.3 — the snapshot pick-task ceiling)', () => {
  it('returns everything, unchanged, when the over-read is within the ceiling', () => {
    const rows = [...walk('A', 2), ...walk('B', 3)];
    expect(truncateToWholePicklists(rows, 10)).toEqual(rows);
    // Exactly at the ceiling is still "within" — the over-read reads one
    // extra row, so `length === max` means nothing was left behind.
    expect(truncateToWholePicklists(rows, 5)).toEqual(rows);
  });

  it('drops the picklist that straddles the ceiling, whole', () => {
    // A=3, B=3: a ceiling of 4 cuts inside B, so B goes entirely.
    const rows = [...walk('A', 3), ...walk('B', 3)];
    const kept = truncateToWholePicklists(rows, 4);
    expect(kept.map((row) => row.picklistId)).toEqual(['A', 'A', 'A']);
  });

  it('keeps a picklist that ends exactly on the ceiling', () => {
    // A=3, B=3, ceiling 3: the cut falls on A's boundary, so A survives whole
    // and B is simply not included — nothing is straddling.
    const rows = [...walk('A', 3), ...walk('B', 3)];
    const kept = truncateToWholePicklists(rows, 3);
    expect(kept.map((row) => row.picklistId)).toEqual(['A', 'A', 'A']);
  });

  it('a SINGLE picklist larger than the ceiling returns truncated rather than empty', () => {
    // The reachable case: a `batch` wave policy emits ONE picklist across up
    // to 200 orders, so one walk can exceed the ceiling on its own. Every
    // kept row belongs to it, and dropping it whole would hand the
    // warehouse's devices an empty walk — forever, since nothing else is
    // pickable. A truncated walk beats no walk.
    const rows = walk('BIG', 7);
    const kept = truncateToWholePicklists(rows, 4);
    expect(kept).toHaveLength(4);
    expect(kept.every((row) => row.picklistId === 'BIG')).toBe(true);
  });

  it('never returns empty while the over-read holds rows', () => {
    for (const max of [1, 2, 3, 5, 8]) {
      for (const rows of [walk('ONE', 9), [...walk('A', 1), ...walk('B', 9)], [...walk('A', 9), ...walk('B', 1)]]) {
        const kept = truncateToWholePicklists(rows, max);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept.length).toBeLessThanOrEqual(max);
      }
    }
  });

  it('never splits a picklist across the boundary unless that picklist is the only one kept', () => {
    const rows = [...walk('A', 2), ...walk('B', 2), ...walk('C', 9)];
    const kept = truncateToWholePicklists(rows, 5);
    // The cut falls inside C, and A+B survive — so C must be absent entirely.
    expect(kept.map((row) => row.picklistId)).toEqual(['A', 'A', 'B', 'B']);
    const byList = new Map<string, number>();
    for (const row of kept) byList.set(row.picklistId, (byList.get(row.picklistId) ?? 0) + 1);
    expect([...byList.values()]).toEqual([2, 2]);
  });

  it('the shipped ceiling is a positive bound (the snapshot is never unbounded)', () => {
    expect(MAX_SNAPSHOT_PICK_TASKS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_SNAPSHOT_PICK_TASKS)).toBe(true);
  });

  it('does not mutate the input', () => {
    const rows = [...walk('A', 3), ...walk('B', 3)];
    const before = rows.map((row) => row.tag);
    truncateToWholePicklists(rows, 4);
    expect(rows.map((row) => row.tag)).toEqual(before);
  });
});
