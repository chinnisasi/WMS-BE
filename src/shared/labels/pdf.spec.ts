import { PDFArray, PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { readPdfLabels } from '../../../test/support/labels';
import { renderBinLabelsPdf } from './pdf';
import { LABEL_GEOMETRY, POINTS_PER_DOT, POINTS_PER_MM, type BinLabel } from './layout';

const label = (code: string, extra: Partial<BinLabel> = {}): BinLabel => ({
  code,
  zoneCode: 'A',
  warehouseCode: 'BLR1',
  storageClass: 'ambient',
  clientCode: null,
  ...extra,
});

describe('bin labels as PDF (story 2-10a)', () => {
  it('label layout, 2x1: one 144 × 72 pt page per label, and the decoded bars are the code', async () => {
    const pdf = await renderBinLabelsPdf([label('A-01-01'), label('A^1~_>B')], { layout: 'label', size: '2x1' });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = await readPdfLabels(pdf);
    expect(pages.map((p) => [p.width, p.height])).toEqual([[144, 72], [144, 72]]);
    expect(pages.map((p) => p.payloads)).toEqual([['A-01-01'], ['A^1~_>B']]);
  });

  it('label layout, 4x2 (the default size): 288 × 144 pt', async () => {
    const pages = await readPdfLabels(await renderBinLabelsPdf([label('Z-99-99-ABCDEFGHIJKLMNOPQRST')], { layout: 'label' }));
    expect(pages).toEqual([{ width: 288, height: 144, payloads: ['Z-99-99-ABCDEFGHIJKLMNOPQRST'] }]);
  });

  it('a4 layout: 30 labels are 2 A4 pages (24 + 6), in the order given, row by row', async () => {
    const codes = Array.from({ length: 30 }, (_v, i) => `A-${String(i + 1).padStart(2, '0')}`);
    const pdf = await renderBinLabelsPdf(codes.map((c) => label(c)), { layout: 'a4' });
    const pages = await readPdfLabels(pdf);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.width).toBeCloseTo(210 * POINTS_PER_MM, 3);
      expect(page.height).toBeCloseTo(297 * POINTS_PER_MM, 3);
    }
    expect(pages[0]!.payloads).toEqual(codes.slice(0, 24));
    expect(pages[1]!.payloads).toEqual(codes.slice(24));
    // An 18-character code (the A4 limit) still decodes.
    const longest = await readPdfLabels(await renderBinLabelsPdf([label('ABCDEFGHIJKLMNOPQR')], { layout: 'a4' }));
    expect(longest[0]!.payloads).toEqual(['ABCDEFGHIJKLMNOPQR']);
  });

  it('non-ASCII zone, warehouse and client text folds instead of throwing; the page count reads back with pdf-lib', async () => {
    const pdf = await renderBinLabelsPdf(
      [label('A-1', { zoneCode: 'भंडार', warehouseCode: 'गोदाम', clientCode: 'ÄCME', storageClass: 'frozen' })],
      { layout: 'label', size: '4x2' },
    );
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    expect((await readPdfLabels(pdf))[0]!.payloads).toEqual(['A-1']);
  });

  it('long zone and warehouse codes: every drawn text (shrunk, then truncated with ...) fits the printable width', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold);
    for (const size of ['4x2', '2x1'] as const) {
      const g = LABEL_GEOMETRY[size];
      const printable = (g.widthDots - 2 * g.marginDots) * POINTS_PER_DOT;
      const pdf = await renderBinLabelsPdf([label('A-1', { zoneCode: 'Z'.repeat(32), warehouseCode: 'W'.repeat(32) })], { layout: 'label', size });
      const doc = await PDFDocument.load(pdf);
      const contents = doc.getPages()[0]!.node.Contents()!;
      const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
      let content = '';
      for (const ref of refs) {
        const stream = doc.context.lookup(ref);
        if (stream instanceof PDFRawStream) content += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      }
      const drawn = [...content.matchAll(/ ([\d.]+) Tf\n[\s\S]*?<([0-9A-F]+)> Tj/g)].map((m) => ({
        size: Number(m[1]),
        text: Buffer.from(m[2]!, 'hex').toString('latin1'),
      }));
      expect(drawn.length).toBeGreaterThanOrEqual(2);
      const line1 = drawn.find((d) => d.text.startsWith('ZZZ'));
      expect(line1).toBeDefined();
      // Shrunk to fit, and truncated with ... once below the minimum size.
      if (line1!.text.length < 67) expect(line1!.text.endsWith('...')).toBe(true);
      for (const d of drawn) {
        expect(font.widthOfTextAtSize(d.text, d.size)).toBeLessThanOrEqual(printable + 1e-6);
      }
    }
  });

  it('a code that cannot fit throws (the service refuses it first)', async () => {
    await expect(renderBinLabelsPdf([label('X'.repeat(19))], { layout: 'a4' })).rejects.toThrow(/does not fit/);
  });
});
