import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSIGNMENT_GATE_CODES,
  consignmentGate,
  isB2bOrder,
  ratedValuePaiseOf,
  valueFloorOf,
  type ConsignmentGateFacts,
  type ConsignmentGateResult,
} from './consignment-gate';

interface GateVector { name: string; facts: ConsignmentGateFacts; expected: ConsignmentGateResult }

const VECTOR_FILE = join(__dirname, 'consignment-gate.vectors.json');
const raw = readFileSync(VECTOR_FILE);
const vectors = JSON.parse(raw.toString('utf8')) as { vectors: GateVector[] };

/** The same file sits beside wms-fe's `src/lib/consignment-gate.ts`; both copies pin this hash (A8, D10). */
const VECTORS_SHA256 = '654e52b466feb8ce5478c4fa53bb10baaa60525881e2f0d5579440ce0421699d';

describe('story 4-6a — the consignment gate (A15, A36)', () => {
  it('the shared vector file is byte-identical across the repos (its sha256 is pinned)', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256);
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(20);
  });

  it.each(vectors.vectors)('$name', ({ facts, expected }) => {
    expect(consignmentGate(facts)).toEqual(expected);
  });

  it('every gate row is covered by a vector (a row nobody pins can drift silently)', () => {
    const states = new Set(vectors.vectors.map((v) => v.expected.state));
    expect([...states].sort()).toEqual(['dispatched', 'eway-expired', 'eway-required', 'missing', 'not-applicable', 'not-required', 'ready']);
    const because = new Set(vectors.vectors.map((v) => v.expected.requiredBecause));
    expect([...because].sort()).toEqual(['policy-all', 'policy-b2b', 'value', null].sort());
    expect(new Set(vectors.vectors.map((v) => v.expected.code).filter((c) => c !== null))).toEqual(new Set(CONSIGNMENT_GATE_CODES));
  });

  it('the value floor is max(rated, COD), null only when both are null', () => {
    expect(valueFloorOf(null, null)).toBeNull();
    expect(valueFloorOf(0, null)).toBe(0);
    expect(valueFloorOf(null, 700)).toBe(700);
    expect(valueFloorOf(900, 700)).toBe(900);
  });

  it('B2B is the type, or a legacy NULL type with a consignee GSTIN (4-2a)', () => {
    expect(isB2bOrder('b2b', null)).toBe(true);
    expect(isB2bOrder('b2c', null)).toBe(false);
    expect(isB2bOrder(null, '27ABCDE1234F1Z5')).toBe(true);
    expect(isB2bOrder(null, null)).toBe(false);
  });

  it('A42 — the rated value: floor(Σ qty × rate / 1000) over top-level rated lines, exact past 2^53, null without a rate', () => {
    // 2 × ₹30,000 (qty milli-units, rate per base unit).
    expect(ratedValuePaiseOf([{ qty: 2000, ratePaise: 3_000_000, parentLineId: null }])).toBe(6_000_000);
    // A kit's components are skipped; an unrated line contributes nothing; the floor is taken once on the sum.
    expect(
      ratedValuePaiseOf([
        { qty: 1500, ratePaise: 333, parentLineId: null },
        { qty: 1500, ratePaise: 333, parentLineId: null },
        { qty: 9000, ratePaise: 99_999, parentLineId: 'kit' },
        { qty: 4000, ratePaise: null, parentLineId: null },
      ]),
    ).toBe(999);
    expect(ratedValuePaiseOf([{ qty: 4000, ratePaise: null, parentLineId: null }])).toBeNull();
    expect(ratedValuePaiseOf([])).toBeNull();
    // qty × rate exceeds 2^53 in the intermediate product; the BigInt sum is exact.
    expect(ratedValuePaiseOf([{ qty: 9_000_000_000, ratePaise: 1_000_000_007, parentLineId: null }])).toBe(9_000_000_063_000_000);
    expect(() => ratedValuePaiseOf([{ qty: 9_000_000_000_000_000, ratePaise: 9_000_000_000_000, parentLineId: null }])).toThrow(RangeError);
  });
});
