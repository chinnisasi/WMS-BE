import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

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

export interface DocumentPage {
  readonly runs: readonly DocumentRun[];
  readonly rules: readonly DocumentRule[];
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
  }
  return Buffer.from(await doc.save());
}
