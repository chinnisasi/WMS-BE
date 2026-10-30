import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AWB_RE, awbProblem, normalizeAwb } from './awb';
import { normalizeCourierInput } from './courier';
import { parcelTagCode, parcelTagMatches, parcelTagOrderSuffix } from './parcel-tag';

interface AwbVector { raw: string; normalized: string; valid: boolean }
interface TagVector { orderId: string; code: string }
const vectors = JSON.parse(readFileSync(join(__dirname, 'awb.vectors.json'), 'utf8')) as { cases: AwbVector[] };
const tagVectors = JSON.parse(readFileSync(join(__dirname, 'parcel-tag.vectors.json'), 'utf8')) as { cases: TagVector[] };

describe('story 4-4a — the AWB, parcel tag and courier primitives', () => {
  it.each(vectors.cases)('normalizeAwb($raw) → $normalized, valid $valid (the shared vectors)', ({ raw, normalized, valid }) => {
    expect(normalizeAwb(raw)).toBe(normalized);
    expect(awbProblem(normalized) === null).toBe(valid);
  });

  it('refuses the parcel tag by name, and the regex is the DB CHECK’s', () => {
    expect(awbProblem('O0123456789ABCDEF')).toMatch(/parcel tag/);
    expect(AWB_RE.source).toBe('^[A-Z0-9][A-Z0-9/]{3,49}$');
  });

  it.each(tagVectors.cases)('parcelTagCode($orderId) → $code, and the code matches back', ({ orderId, code }) => {
    expect(parcelTagCode(orderId)).toBe(code);
    expect(code).toHaveLength(17);
    expect(parcelTagMatches(code, orderId)).toBe(true);
    expect(parcelTagMatches(code.toLowerCase(), orderId)).toBe(true);
    expect(parcelTagOrderSuffix(code)).toBe(orderId.replace(/-/g, '').slice(-16));
    // A tag code is never a storable AWB.
    expect(awbProblem(normalizeAwb(code))).not.toBeNull();
  });

  it('a tag matches only its own order, and a non-tag is no suffix', () => {
    expect(parcelTagMatches(parcelTagCode('01a18ba8-4743-79dd-8fe5-145b99902272'), '01a18ba8-4743-79dd-8fe5-145b99902273')).toBe(false);
    expect(parcelTagOrderSuffix('123456789012')).toBeNull();
  });

  it('normalizeCourierInput: exactly one of a transporter and a name, trimmed and bounded', () => {
    expect(normalizeCourierInput({ courierName: '  Delhivery ' })).toEqual({ transporterId: null, courierName: 'Delhivery' });
    expect(normalizeCourierInput({ transporterId: '01A18BA8-4743-79DD-8FE5-145B99902272' })).toEqual({
      transporterId: '01a18ba8-4743-79dd-8fe5-145b99902272',
      courierName: null,
    });
    expect(() => normalizeCourierInput({})).toThrow(/exactly one/);
    expect(() => normalizeCourierInput({ courierName: '  ' })).toThrow(/exactly one/);
    expect(() => normalizeCourierInput({ courierName: 'A', transporterId: '01a18ba8-4743-79dd-8fe5-145b99902272' })).toThrow(/exactly one/);
    expect(() => normalizeCourierInput({ transporterId: 'nope' })).toThrow(/uuid/);
    // 100 code points (Devanagari is one code point per letter here) pass; 101 do not.
    expect(normalizeCourierInput({ courierName: 'द'.repeat(100) }).courierName).toHaveLength(100);
    expect(() => normalizeCourierInput({ courierName: 'द'.repeat(101) })).toThrow(/at most 100/);
  });
});
