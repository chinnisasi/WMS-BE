import {
  CODE128_PATTERNS,
  NotBarcodableError,
  START_B,
  assertBarcodable,
  code128BSymbols,
  decodeCode128B,
  encodeCode128B,
  isBarcodable,
  moduleCount,
} from './code128';

/**
 * Story 2-10a — the in-house Code 128 subset-B encoder. The pattern table was
 * also checked once, outside the suite, against an independent decoder
 * (ZXing, zxing-wasm 3.1.3): every printable character and every check value
 * 0–102 decoded to the payload that produced it (Implementation Notes).
 */
describe('Code 128 subset B (story 2-10a)', () => {
  it('the pattern table: 107 distinct patterns, 11 modules each, the stop 13', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.forEach((pattern, value) => {
      const sum = [...pattern].reduce((a, d) => a + Number(d), 0);
      expect({ value, sum }).toEqual({ value, sum: value === 106 ? 13 : 11 });
      // Code 128 bars and spaces are 1–4 modules.
      expect(/^[1-4]+$/.test(pattern)).toBe(true);
    });
  });

  it('a known symbol: "A-01" is start B, the values, the mod-103 check and stop', () => {
    // A=33, -=13, 0=16, 1=17; check = (104 + 33·1 + 13·2 + 16·3 + 17·4) mod 103 = 279 mod 103 = 73.
    expect(code128BSymbols('A-01')).toEqual([START_B, 33, 13, 16, 17, 73, 106]);
  });

  it('the width is 11·n + 35 modules, and the widths decode back to the payload', () => {
    for (const payload of ['A', 'A-01-01', 'A^1~_>B', ' x y', '~~~~~~~~~~~~~~~~~~~~~~~~~~~~']) {
      const trimmed = payload.trim();
      const widths = encodeCode128B(trimmed);
      expect(widths.reduce((a, b) => a + b, 0)).toBe(moduleCount(trimmed.length));
      expect(decodeCode128B(widths)).toBe(trimmed);
    }
    expect(moduleCount(7)).toBe(112);
  });

  it('every printable ASCII character round-trips, in every position', () => {
    let all = '';
    for (let c = 0x21; c <= 0x7e; c += 1) all += String.fromCharCode(c);
    const payload = `${all.slice(0, 40)} ${all.slice(40)}`;
    expect(decodeCode128B(encodeCode128B(payload))).toBe(payload);
  });

  it('the decoder refuses a corrupted check symbol', () => {
    const widths = encodeCode128B('A-01');
    // Swap the check symbol (the 6 elements before the 7-element stop) for value 0's pattern.
    const corrupted = [...widths.slice(0, widths.length - 13), 2, 1, 2, 2, 2, 2, ...widths.slice(widths.length - 7)];
    expect(() => decodeCode128B(corrupted)).toThrow(/check symbol/);
  });

  it('barcodable = printable ASCII, non-empty, no leading or trailing space', () => {
    expect(isBarcodable('A-01-01')).toBe(true);
    expect(isBarcodable('A 01')).toBe(true);
    expect(isBarcodable('A^1~_>B')).toBe(true);
    for (const bad of ['', ' A', 'A ', 'A\t1', 'A\n', 'Ä-01', 'क-01', 'A\u007f']) {
      expect({ bad, ok: isBarcodable(bad) }).toEqual({ bad, ok: false });
      expect(() => assertBarcodable(bad)).toThrow(NotBarcodableError);
    }
    expect(() => encodeCode128B('Ä')).toThrow(NotBarcodableError);
  });
});
