import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { encodeCode128B } from '../labels/code128';

/**
 * Story 2-9a (guide §6, "a document PDF is a pure layout of runs, then a
 * draw") — draws pages a pure layout already positioned. Nothing here
 * measures, wraps or folds: every run's text was folded by the layout
 * (`documentText`) against the same Helvetica metrics this draws with. A4
 * portrait, 595.28 × 841.89 pt. The creation and modification dates are the
 * document's print instant, so a fixed instant gives identical bytes.
 */
export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;

export interface DocumentRun {
  readonly x: number;
  /** The baseline, from the page's bottom edge. */
  readonly y: number;
  readonly size: number;
  readonly font: 'regular' | 'bold';
  /** Already normalised and WinAnsi-folded. */
  readonly text: string;
}

/** A thin horizontal or vertical rule. */
export interface DocumentRule {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
}

/**
 * Story 4-5a (A17, D2) — a Code 128 subset-B symbol drawn as filled bars:
 * `x` is the first bar's left edge (the layout leaves the quiet zones), `y`
 * the bars' bottom edge, both in points; `moduleWidth` in points.
 */
export interface DocumentBarcode {
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly moduleWidth: number;
  /** The raw code (subset-B printable — the encoder throws otherwise). */
  readonly payload: string;
}

export interface DocumentPage {
  readonly runs: readonly DocumentRun[];
  readonly rules: readonly DocumentRule[];
  /** Story 4-5a — additive: a page without barcodes (the GRN) draws byte-identically. */
  readonly barcodes?: readonly DocumentBarcode[];
}

const BLACK = rgb(0, 0, 0);

export async function drawDocumentPdf(
  pages: readonly DocumentPage[],
  meta: { readonly title: string; readonly creationDate: string },
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const at = new Date(meta.creationDate);
  doc.setTitle(meta.title);
  doc.setCreator('WMS');
  doc.setProducer('WMS documents');
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  for (const layout of pages) {
    const page = doc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
    for (const rule of layout.rules) {
      page.drawLine({ start: { x: rule.x1, y: rule.y1 }, end: { x: rule.x2, y: rule.y2 }, thickness: rule.width, color: BLACK });
    }
    for (const run of layout.runs) {
      if (run.text.length === 0) continue;
      page.drawText(run.text, { x: run.x, y: run.y, size: run.size, font: fonts[run.font], color: BLACK });
    }
    const barcodes = layout.barcodes ?? [];
    if (barcodes.length > 0) {
      // Each symbol's rectangle is declared on the page (`/WMSBarcodeBands`,
      // x y w h) so a reader decodes only bars, never another filled shape.
      const bands: number[] = [];
      for (const barcode of barcodes) {
        let x = barcode.x;
        let bar = true;
        for (const modules of encodeCode128B(barcode.payload)) {
          const width = modules * barcode.moduleWidth;
          if (bar) page.drawRectangle({ x, y: barcode.y, width, height: barcode.height, color: BLACK, borderWidth: 0 });
          x += width;
          bar = !bar;
        }
        bands.push(barcode.x, barcode.y, x - barcode.x, barcode.height);
      }
      page.node.set(PDFName.of('WMSBarcodeBands'), doc.context.obj(bands.map((n) => Number(n.toFixed(3)))));
    }
  }
  return Buffer.from(await doc.save());
}
