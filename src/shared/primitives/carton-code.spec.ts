import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { awbProblem, normalizeAwb } from './awb';
import { cartonCode, parseCartonCode } from './carton-code';
import { parcelTagCode } from './parcel-tag';

interface BuildVector { orderId: string; packSeq: number; seq: number; code: string }
interface ParseVector { input: string; result: { parcelTag: string; packSeq: number; seq: number } | null }

const VECTOR_FILE = join(__dirname, 'carton-code.vectors.json');
const raw = readFileSync(VECTOR_FILE);
const vectors = JSON.parse(raw.toString('utf8')) as { build: BuildVector[]; parse: ParseVector[] };

/** The same file sits beside wms-fe's and wms-mobile's carton-code.ts; every copy pins this hash (A49). */
const VECTORS_SHA256 = '8a1b4e8a483b3813554bd7af2b69de5f78408affd7b3c8decb10dc4c73374bfa';

describe('story 4-5a — the carton code', () => {
  it('the shared vector file is byte-identical across the three repos (its sha256 is pinned)', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256);
  });

  it.each(vectors.build)('cartonCode($orderId, $packSeq, $seq) → $code', ({ orderId, packSeq, seq, code }) => {
    expect(cartonCode(orderId, packSeq, seq)).toBe(code);
    expect(code.startsWith(`${parcelTagCode(orderId)}.`)).toBe(true);
    expect(code.length).toBeLessThanOrEqual(24);
    expect(parseCartonCode(code)).toEqual({ parcelTag: parcelTagCode(orderId), packSeq, seq });
  });

  it.each(vectors.parse)('parseCartonCode(%j)', ({ input, result }) => {
    expect(parseCartonCode(input)).toEqual(result);
  });

  it('refuses out-of-range numbers when building', () => {
    const id = '01a18ba8-4743-79dd-8fe5-145b99902272';
    expect(() => cartonCode(id, 0, 1)).toThrow(RangeError);
    expect(() => cartonCode(id, 100, 1)).toThrow(RangeError);
    expect(() => cartonCode(id, 1, 201)).toThrow(RangeError);
    expect(() => cartonCode(id, 1, 1.5)).toThrow(RangeError);
  });

  it('a carton code is never an AWB, and awbProblem names it (after the parcel-tag arm)', () => {
    const code = cartonCode('01a18ba8-4743-79dd-8fe5-145b99902272', 1, 2);
    expect(awbProblem(normalizeAwb(code))).toBe('This is a carton label — scan the courier’s label.');
    expect(awbProblem('O8FE5145B99902272')).toMatch(/parcel tag/);
  });
});
