import { PDFDocument, PDFName, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { encodeCode128B } from '../code128';
import { POINTS_PER_DOT } from '../layout';
import { assertLabelBands, type ShippingField, type ShippingLabel } from './fields';
import { A4_LANDSCAPE, SHIPPING_LABEL, SHIPPING_PRINTABLE_DOTS, a4SlotOrigin } from './geometry';

/**
 * Story 4-5a (A14, A15) — shipping labels as a PDF: the same positioned
 * fields as the ZPL, on the same dot grid scaled by `POINTS_PER_DOT`
 * (Helvetica, Helvetica-Bold). `label` is one 4×6 in page per label; `a4` is
 * two labels side by side per landscape A4 page at 100 %, each with a dashed
 * cut line round it.
 *
 * Bars are filled rectangles straight from `encodeCode128B`. Each page names
 * its barcode rectangles in a `/WMSBarcodeBands` entry (x y w h …, points), so
 * a reader keeps only bars inside a declared band — a reversed COD box is a
 * filled rectangle too, and must never read as a bar (A49).
 *
 * Every string was ASCII-folded by the layout, so the WinAnsi standard fonts
 * never throw. A fixed `creationDate` gives identical bytes.
 */
export interface ShippingPdfOptions {
  readonly layout: 'label' | 'a4';
  readonly title: string;
  readonly creationDate?: string;
}

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const GREY = rgb(0.6, 0.6, 0.6);
const K = POINTS_PER_DOT;

export async function renderShippingLabelsPdf(labels: readonly ShippingLabel[], options: ShippingPdfOptions): Promise<Buffer> {
  for (const label of labels) assertLabelBands(label);
  const doc = await PDFDocument.create();
  doc.setTitle(options.title);
  doc.setCreator('WMS');
  doc.setProducer(`WMS ${options.title.toLowerCase()}`);
  if (options.creationDate !== undefined) {
    const at = new Date(options.creationDate);
    doc.setCreationDate(at);
    doc.setModificationDate(at);
  }
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  if (options.layout === 'a4') {
    let page: PDFPage | null = null;
    let bands: number[] = [];
    labels.forEach((label, index) => {
      const slot = index % A4_LANDSCAPE.labelsPerPage;
      if (slot === 0) {
        if (page !== null) setBands(doc, page, bands);
        page = doc.addPage([A4_LANDSCAPE.widthPt, A4_LANDSCAPE.heightPt]);
        bands = [];
      }
      const origin = a4SlotOrigin(slot);
      page!.drawRectangle({
        x: origin.left,
        y: origin.top - SHIPPING_LABEL.heightPt,
        width: SHIPPING_LABEL.widthPt,
        height: SHIPPING_LABEL.heightPt,
        borderColor: GREY,
        borderWidth: 0.5,
        borderDashArray: [4, 3],
      });
      bands.push(...drawLabel(page!, fonts, label, origin.left, origin.top));
    });
    if (page !== null) setBands(doc, page, bands);
  } else {
    for (const label of labels) {
      const page = doc.addPage([SHIPPING_LABEL.widthPt, SHIPPING_LABEL.heightPt]);
      setBands(doc, page, drawLabel(page, fonts, label, 0, SHIPPING_LABEL.heightPt));
    }
  }
  return Buffer.from(await doc.save());
}

function setBands(doc: PDFDocument, page: PDFPage, bands: readonly number[]): void {
  page.node.set(PDFName.of('WMSBarcodeBands'), doc.context.obj(bands.map((n) => Number(n.toFixed(3)))));
}

/** Draws one label with its top-left at (left, top) points; returns its barcode bands (x y w h, points). */
function drawLabel(page: PDFPage, fonts: { regular: PDFFont; bold: PDFFont }, label: ShippingLabel, left: number, top: number): number[] {
  const bands: number[] = [];
  for (const field of label.fields) drawField(page, fonts, field, left, top, bands);
  return bands;
}

function fittedSize(font: PDFFont, text: string, size: number, maxWidthPt: number): number {
  let s = size;
  while (s > 4 && font.widthOfTextAtSize(text, s) > maxWidthPt) s -= 0.25;
  return s;
}

function drawText(page: PDFPage, font: PDFFont, text: string, x: number, yTop: number, hDots: number, maxWidthDots: number, left: number, top: number, color = BLACK): void {
  if (text.length === 0) return;
  const size = fittedSize(font, text, hDots * K, maxWidthDots * K);
  // The baseline a descender's depth above the cell's bottom edge (the 2-10a rule).
  const baseline = top - (yTop + hDots) * K + size * 0.21;
  page.drawText(text, { x: left + x * K, y: baseline, size, font, color });
}

function drawField(page: PDFPage, fonts: { regular: PDFFont; bold: PDFFont }, field: ShippingField, left: number, top: number, bands: number[]): void {
  switch (field.kind) {
    case 'text':
      drawText(page, field.bold ? fonts.bold : fonts.regular, field.text, field.x, field.y, field.h, field.maxWidth, left, top);
      return;
    case 'reverse': {
      page.drawRectangle({ x: left + field.x * K, y: top - (field.y + field.h) * K, width: field.w * K, height: field.h * K, color: BLACK, borderWidth: 0 });
      const textY = field.y + Math.floor((field.h - field.textH) / 2);
      drawText(page, fonts.bold, field.text, field.x + field.pad, textY, field.textH, field.w - 2 * field.pad, left, top, WHITE);
      return;
    }
    case 'rule': {
      const y = top - (field.y + field.t / 2) * K;
      page.drawLine({
        start: { x: left + SHIPPING_LABEL.marginDots * K, y },
        end: { x: left + (SHIPPING_LABEL.marginDots + SHIPPING_PRINTABLE_DOTS) * K, y },
        thickness: field.t * K,
        color: BLACK,
      });
      return;
    }
    case 'box':
      page.drawRectangle({
        x: left + (field.x + field.t / 2) * K,
        y: top - (field.y + field.h - field.t / 2) * K,
        width: (field.w - field.t) * K,
        height: (field.h - field.t) * K,
        borderColor: BLACK,
        borderWidth: field.t * K,
      });
      return;
    case 'barcode': {
      const module = field.moduleWidth * K;
      const barTop = top - field.y * K;
      const height = field.h * K;
      let x = left + field.x * K;
      const start = x;
      let bar = true;
      for (const widthModules of encodeCode128B(field.payload)) {
        const width = widthModules * module;
        if (bar) page.drawRectangle({ x, y: barTop - height, width, height, color: BLACK, borderWidth: 0 });
        x += width;
        bar = !bar;
      }
      bands.push(start, barTop - height, x - start, height);
      return;
    }
  }
}
