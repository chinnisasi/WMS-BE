import { DOCUMENT_FONTS, documentText, normaliseDocumentText, winAnsiFold } from './text';
import { drawDocumentPdf } from './a4-pdf';

/**
 * Story 2-9a (decision 16, A11) — every string a document prints is
 * normalised and WinAnsi-folded before pdf-lib sees it: pdf-lib's standard
 * fonts THROW on an unencodable character, so one Devanagari name must not
 * fail a whole GRN.
 */
describe('document text (story 2-9a)', () => {
  const { regular, bold } = DOCUMENT_FONTS;

  it('Latin-1 and the WinAnsi extras survive ("Café", "€", "…", "·", "—")', () => {
    expect(winAnsiFold('Café € … · —', regular)).toBe('Café € … · —');
  });

  it('Devanagari folds to one ? per code point; an emoji (a surrogate pair) is ONE ?', () => {
    expect(winAnsiFold('नमस्ते', regular)).toBe('??????');
    expect(winAnsiFold('Box 📦 ok', regular)).toBe('Box ? ok');
  });

  it('control characters fold to ?; \\r\\n, \\n and \\t become a space and runs collapse', () => {
    expect(winAnsiFold('a\u0000b\u007f', regular)).toBe('a?b?');
    expect(normaliseDocumentText('  Line one\r\nLine two\n\tthree   four ')).toBe('Line one Line two three four');
    expect(documentText('A\u0000\nB', regular)).toBe('A? B');
  });

  it('a 10,000-character name folds whole and draws without throwing', async () => {
    const long = 'ब'.repeat(5000) + 'x'.repeat(5000);
    const folded = documentText(long, bold);
    expect(folded).toHaveLength(10_000);
    expect(folded.startsWith('?'.repeat(5000))).toBe(true);
    const pdf = await drawDocumentPdf([{ runs: [{ x: 10, y: 10, size: 8, font: 'bold', text: folded.slice(0, 200) }], rules: [] }], {
      title: 't',
      creationDate: '2026-10-30T00:00:00.000Z',
    });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('every folded string is drawable: the fold over every BMP code point never yields one pdf-lib refuses', async () => {
    let all = '';
    for (let code = 0; code < 0x3000; code += 1) all += String.fromCodePoint(code);
    const folded = documentText(all, regular);
    await expect(
      drawDocumentPdf([{ runs: [{ x: 0, y: 0, size: 4, font: 'regular', text: folded }], rules: [] }], { title: 't', creationDate: '2026-10-30T00:00:00.000Z' }),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
