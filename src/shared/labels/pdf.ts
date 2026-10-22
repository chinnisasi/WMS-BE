import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { encodeCode128B, moduleCount } from './code128';
import {
  A4_CELLS_PER_PAGE,
  A4_SHEET,
  LABEL_GEOMETRY,
  POINTS_PER_DOT,
  POINTS_PER_MM,
  QUIET_ZONE_MODULES,
  binLabelText,
  fitModuleWidth,
  printableUnitsOf,
  type BinLabel,
  type LabelSize,
  type LabelTarget,
} from './layout';

/**
 * Story 2-10a — bin labels as a PDF (pdf-lib, Helvetica-Bold). The bars are
 * drawn as filled rectangles straight from `encodeCode128B`, one rectangle
 * per bar, so the symbol is exactly the one the fit check measured and the
 * one a test decodes back.
 *
 * - `label` layout: one label per page, 4x2 in (288 × 144 pt) or 2x1 in
 *   (144 × 72 pt), on the same 203-dpi dot grid as the ZPL label.
 * - `a4` layout: 24 labels per A4 page, 3 × 8 cells of 70 × 36 mm, 4.5 mm
 *   top and bottom margins, 2 mm inner padding (decision 4).
 *
 * Every string is ASCII-folded (`binLabelText`) before it reaches pdf-lib —
 * the standard fonts' WinAnsi encoding throws on anything else.
 */
export interface PdfLabelOptions {
  readonly layout: 'label' | 'a4';
  /** The label size — required for `label`, ignored (and refused upstream) for `a4`. */
  readonly size?: LabelSize;
}

/** A label's drawing frame in PDF points: its top-left corner, unit size and bands (offsets from the top). */
interface Frame {
  readonly left: number;
  readonly top: number;
  readonly printableWidth: number;
  readonly unit: number;
  readonly printableUnits: number;
  readonly code: readonly [number, number];
  readonly barcode: readonly [number, number];
  readonly line1: readonly [number, number];
  readonly line2: readonly [number, number];
}

const BLACK = rgb(0, 0, 0);
const MIN_FONT_PT = 4;

export async function renderBinLabelsPdf(labels: readonly BinLabel[], options: PdfLabelOptions): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle('Bin labels');
  doc.setProducer('WMS bin labels');
  doc.setCreator('WMS');
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  if (options.layout === 'a4') {
    const pageWidth = A4_SHEET.pageWidthMm * POINTS_PER_MM;
    const pageHeight = A4_SHEET.pageHeightMm * POINTS_PER_MM;
    let page: PDFPage | null = null;
    labels.forEach((label, index) => {
      const cell = index % A4_CELLS_PER_PAGE;
      if (cell === 0) page = doc.addPage([pageWidth, pageHeight]);
      drawLabel(page!, font, label, a4Frame(cell, pageHeight), { layout: 'a4' });
    });
  } else {
    const size = options.size ?? '4x2';
    const g = LABEL_GEOMETRY[size];
    for (const label of labels) {
      const page = doc.addPage([g.widthPt, g.heightPt]);
      drawLabel(page, font, label, labelFrame(size), { layout: 'label', size });
    }
  }
  return Buffer.from(await doc.save());
}

function labelFrame(size: LabelSize): Frame {
  const g = LABEL_GEOMETRY[size];
  const k = POINTS_PER_DOT;
  const band = (b: readonly [number, number]): [number, number] => [b[0] * k, b[1] * k];
  return {
    left: g.marginDots * k,
    top: g.heightPt,
    printableWidth: (g.widthDots - 2 * g.marginDots) * k,
    unit: k,
    printableUnits: printableUnitsOf({ layout: 'label', size }),
    code: band(g.code),
    barcode: band(g.barcode),
    line1: band(g.line1),
    line2: band(g.line2),
  };
}

function a4Frame(cell: number, pageHeight: number): Frame {
  const mm = POINTS_PER_MM;
  const column = cell % A4_SHEET.columns;
  const row = Math.floor(cell / A4_SHEET.columns);
  const cellLeftMm = column * A4_SHEET.cellWidthMm;
  const cellTopMm = A4_SHEET.topMarginMm + row * A4_SHEET.cellHeightMm;
  const pad = A4_SHEET.paddingMm;
  const band = (y: number, h: number): [number, number] => [y * mm, h * mm];
  return {
    left: (cellLeftMm + pad) * mm,
    top: pageHeight - (cellTopMm + pad) * mm,
    printableWidth: (A4_SHEET.cellWidthMm - 2 * pad) * mm,
    unit: A4_SHEET.unitMm * mm,
    printableUnits: printableUnitsOf({ layout: 'a4' }),
    // Bands inside the 66 × 32 mm content box, from its top.
    code: band(0, 7),
    barcode: band(8, 14),
    line1: band(23.5, 4),
    line2: band(28, 3.5),
  };
}

function drawLabel(page: PDFPage, font: PDFFont, label: BinLabel, frame: Frame, target: LabelTarget): void {
  const modules = moduleCount(label.code.length);
  const moduleUnits = fitModuleWidth(modules, frame.printableUnits);
  if (moduleUnits === null) {
    const where = target.layout === 'a4' ? 'an A4 cell' : `a ${target.size} label`;
    throw new Error(`bin code "${label.code}" does not fit ${where}`);
  }
  const text = binLabelText(label);
  drawFittedText(page, font, text.code, frame, frame.code);

  // The bars: alternating bar/space widths, bar first, after the quiet zone.
  const moduleWidth = moduleUnits * frame.unit;
  const barTop = frame.top - frame.barcode[0];
  const barHeight = frame.barcode[1];
  let x = frame.left + QUIET_ZONE_MODULES * moduleWidth;
  let bar = true;
  for (const widthModules of encodeCode128B(label.code)) {
    const width = widthModules * moduleWidth;
    if (bar) {
      page.drawRectangle({ x, y: barTop - barHeight, width, height: barHeight, color: BLACK, borderWidth: 0 });
    }
    x += width;
    bar = !bar;
  }

  drawFittedText(page, font, text.line1, frame, frame.line1);
  if (text.line2.length > 0) drawFittedText(page, font, text.line2, frame, frame.line2);
}

/** Draws `text` left-aligned in a band, shrunk to fit the printable width (truncated with `...` below the minimum size). */
function drawFittedText(page: PDFPage, font: PDFFont, raw: string, frame: Frame, band: readonly [number, number]): void {
  if (raw.length === 0) return;
  const [offset, height] = band;
  let size = height;
  let text = raw;
  while (size > MIN_FONT_PT && font.widthOfTextAtSize(text, size) > frame.printableWidth) {
    size -= 0.5;
  }
  if (font.widthOfTextAtSize(text, size) > frame.printableWidth) {
    while (text.length > 1 && font.widthOfTextAtSize(`${text}...`, size) > frame.printableWidth) {
      text = text.slice(0, -1);
    }
    text = `${text}...`;
  }
  // Baseline a descender's depth above the band's bottom edge.
  const baseline = frame.top - offset - height + size * 0.21;
  page.drawText(text, { x: frame.left, y: baseline, size, font, color: BLACK });
}
