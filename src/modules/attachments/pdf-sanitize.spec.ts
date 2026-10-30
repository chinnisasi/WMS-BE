import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { MAX_PDF_PAGES, sanitizePdf, sanitizeShippingFile } from './pdf-sanitize';

const FIXTURES = join(__dirname, '../../../test/fixtures/images');

/** A 4×6 label PDF (288 × 432 pt) of `pages` pages, optionally carrying active content. */
async function labelPdf(pages: number, active = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([288, 432]);
    page.drawText(`AWB 1234 5678 9012 — page ${i + 1}`, { x: 20, y: 400, size: 10 });
    if (active) {
      const js = doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("page")') });
      page.node.set(PDFName.of('AA'), doc.context.obj({ O: js }));
      const link = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [0, 0, 100, 100],
        A: doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("link")') }),
      });
      page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]));
    }
  }
  if (active) {
    doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("open")') }));
    doc.catalog.set(PDFName.of('Names'), doc.context.obj({ JavaScript: doc.context.obj({ Names: [PDFString.of('x'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('1') })] }) }));
  }
  return doc.save({ useObjectStreams: false });
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ProblemException) return (err.getResponse() as { code: string }).code;
    throw err;
  }
  return 'accepted';
}

describe('story 4-4a — sanitizePdf (A15, A34)', () => {
  it('re-serialises a 2-page 4×6 label: the page count, the first page size in points, the MediaBox kept', async () => {
    const out = await sanitizePdf(await labelPdf(2));
    expect(out.pageCount).toBe(2);
    expect([out.width, out.height]).toEqual([288, 432]);
    expect(out.contentType).toBe('application/pdf');
    expect(latin1(out.bytes).startsWith('%PDF-')).toBe(true);
    const reread = await PDFDocument.load(out.bytes);
    expect(reread.getPageCount()).toBe(2);
    expect(reread.getPage(1).getSize()).toEqual({ width: 288, height: 432 });
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('drops the page-level /AA action, the link annotation with /JS, the OpenAction and the document JavaScript', async () => {
    const raw = await labelPdf(1, true);
    expect(latin1(raw)).toContain('/JavaScript');
    expect(latin1(raw)).toContain('/OpenAction');
    expect(latin1(raw)).toContain('/AA');
    expect(latin1(raw)).toContain('/Annots');
    const out = await sanitizePdf(raw);
    const text = latin1(out.bytes);
    expect(text).not.toContain('/JavaScript');
    expect(text).not.toContain('/JS');
    expect(text).not.toContain('/OpenAction');
    expect(text).not.toContain('/AA');
    expect(text).not.toContain('/Annots');
    const page = (await PDFDocument.load(out.bytes)).getPage(0).node;
    expect(page.get(PDFName.of('Annots'))).toBeUndefined();
    expect(page.get(PDFName.of('AA'))).toBeUndefined();
  });

  it('is deterministic: one input, the same bytes (a same-key retry re-puts identical bytes)', async () => {
    const raw = await labelPdf(1, true);
    const a = await sanitizePdf(raw);
    const b = await sanitizePdf(raw);
    expect(a.sha256).toBe(b.sha256);
  });

  it('refuses an encrypted PDF (422 pdf-unreadable), naming the remedy', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([288, 432]);
    doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -4 }) as PDFDict;
    const raw = await doc.save({ useObjectStreams: false });
    await expect(code(sanitizePdf(raw))).resolves.toBe('pdf-unreadable');
    await expect(sanitizePdf(raw)).rejects.toThrow(/password or print restriction/);
  });

  it(`refuses ${MAX_PDF_PAGES + 1} pages (422 pdf-too-many-pages) and accepts ${MAX_PDF_PAGES}`, async () => {
    await expect(code(sanitizePdf(await labelPdf(MAX_PDF_PAGES + 1)))).resolves.toBe('pdf-too-many-pages');
    await expect(sanitizePdf(await labelPdf(MAX_PDF_PAGES))).resolves.toMatchObject({ pageCount: MAX_PDF_PAGES });
  });

  it('refuses a JPEG as a PDF (415), garbage after the magic (422 pdf-unreadable), and a past-budget parse', async () => {
    const jpeg = readFileSync(join(FIXTURES, 'baseline.jpg'));
    await expect(code(sanitizePdf(jpeg))).resolves.toBe('attachment-type-unsupported');
    await expect(code(sanitizePdf(Buffer.from('%PDF-1.7\nthis is not a pdf at all')))).resolves.toBe('pdf-unreadable');
    await expect(code(sanitizePdf(await labelPdf(3), 0))).resolves.toBe('pdf-unreadable');
  });

  it('accepts the existing fixture photo.pdf', async () => {
    const out = await sanitizePdf(readFileSync(join(FIXTURES, 'photo.pdf')));
    expect(out.pageCount).toBeGreaterThanOrEqual(1);
  });

  it('sanitizeShippingFile: a JPEG goes through 2-5a’s sanitizer (no pages), a PDF through sanitizePdf, a GIF is 415', async () => {
    const jpeg = await sanitizeShippingFile(readFileSync(join(FIXTURES, 'baseline.jpg')));
    expect(jpeg.contentType).toBe('image/jpeg');
    expect(jpeg.pageCount).toBeNull();
    const pdf = await sanitizeShippingFile(await labelPdf(2));
    expect(pdf.pageCount).toBe(2);
    await expect(code(sanitizeShippingFile(readFileSync(join(FIXTURES, 'photo.gif'))))).resolves.toBe('attachment-type-unsupported');
  });
});
