import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cartonCode } from './carton-code';
import {
  consignmentRef,
  DRIVER_LICENCE_RE,
  FREIGHT_LIMITS,
  freightLoadCode,
  lrProblem,
  normalizeDriverLicence,
  normalizeLr,
  normalizeSeal,
  parsePackageScan,
  SEAL_RE,
  type PackageSetOfTag,
} from './freight';

interface Vectors {
  seal: { input: string; normalized: string; valid: boolean }[];
  licence: { input: string; normalized: string; valid: boolean }[];
  lr: { input: string; normalized: string; problem: boolean }[];
  consignmentRef: { loadCode: string; stopSeq: number; ref: string }[];
  packageScan: { input: string; tags: Record<string, PackageSetOfTag>; result: unknown }[];
}

const VECTOR_FILE = join(__dirname, 'freight.vectors.json');
const raw = readFileSync(VECTOR_FILE);
const vectors = JSON.parse(raw.toString('utf8')) as Vectors;

/** The same file sits beside wms-fe's freight-primitives.ts and wms-mobile's freight.ts; every copy pins this hash (D9). */
const VECTORS_SHA256 = createHash('sha256').update(raw).digest('hex');
const PINNED_SHA256 = '15c00f27b55110e125ef087884afbdfe1783f0b5bf7a9522232e94cc6ebef579';

describe('story 4-9a — the freight primitives', () => {
  it('the shared vector file is byte-identical across the three repos (its sha256 is pinned)', () => {
    expect(VECTORS_SHA256).toBe(PINNED_SHA256);
  });

  it.each(vectors.seal)('normalizeSeal(%j)', ({ input, normalized, valid }) => {
    expect(normalizeSeal(input)).toBe(normalized);
    expect(SEAL_RE.test(normalizeSeal(input))).toBe(valid);
  });

  it.each(vectors.licence)('normalizeDriverLicence(%j)', ({ input, normalized, valid }) => {
    expect(normalizeDriverLicence(input)).toBe(normalized);
    expect(DRIVER_LICENCE_RE.test(normalizeDriverLicence(input))).toBe(valid);
  });

  it.each(vectors.lr)('normalizeLr / lrProblem(%j)', ({ input, normalized, problem }) => {
    expect(normalizeLr(input)).toBe(normalized);
    expect(lrProblem(normalizeLr(input)) !== null).toBe(problem);
  });

  it.each(vectors.consignmentRef)('consignmentRef(%j)', ({ loadCode, stopSeq, ref }) => {
    expect(consignmentRef(loadCode, stopSeq)).toBe(ref);
  });

  it.each(vectors.packageScan)('parsePackageScan(%j)', ({ input, tags, result }) => {
    expect(parsePackageScan(input, (tag) => tags[tag])).toEqual(result);
  });

  it('a package code built by cartonCode parses back to itself', () => {
    const code = cartonCode('01a18ba8-4743-79dd-8fe5-145b99902272', 2, 15);
    expect(parsePackageScan(code, () => undefined)).toEqual({ kind: 'package', parcelTag: 'O8FE5145B99902272', packSeq: 2, seq: 15, code });
  });

  it('the load code and the limits', () => {
    expect(freightLoadCode(7)).toBe('LD-0007');
    expect(freightLoadCode(12345)).toBe('LD-12345');
    expect(FREIGHT_LIMITS.consignments * 200).toBe(FREIGHT_LIMITS.packagesPerLoad);
    expect(lrProblem('')).toMatch(/LR number/);
  });
});
