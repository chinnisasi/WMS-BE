import { asciiFold, zplEscapeBarcode, zplEscapeText, zplUnescapeBarcode } from './text';

describe('label text: folding and ZPL escaping (story 2-10a)', () => {
  it('asciiFold keeps printable ASCII and turns everything else into one ? per code point', () => {
    expect(asciiFold('A-01 ~^_>')).toBe('A-01 ~^_>');
    // A Devanagari zone name: every code point folds to `?`.
    expect(asciiFold('भंडार')).toBe('?????');
    expect(asciiFold('Zoné')).toBe('Zon?');
    // A character outside the BMP is one code point, so one `?`.
    expect(asciiFold('A😀B')).toBe('A?B');
    expect(asciiFold('A\tB\n')).toBe('A?B?');
  });

  it('zplEscapeText hex-escapes ^, ~ and _ (the ^FH indicator itself) and nothing else', () => {
    expect(zplEscapeText('A^XZ~JA_1')).toBe('A_5EXZ_7EJA_5F1');
    expect(zplEscapeText('A-01 >\\&')).toBe('A-01 >\\&');
  });

  it('zplEscapeBarcode doubles > as >< before the hex escapes, and round-trips', () => {
    expect(zplEscapeBarcode('A^1~_>B')).toBe('A_5E1_7E_5F><B');
    for (const code of ['A^1~_>B', '>>', 'a><b', '_3E', '^XZ', 'plain-01']) {
      expect(zplUnescapeBarcode(zplEscapeBarcode(code))).toBe(code);
      // No raw command prefix survives in the field data.
      expect(zplEscapeBarcode(code)).not.toMatch(/[\^~]/);
    }
  });
});
