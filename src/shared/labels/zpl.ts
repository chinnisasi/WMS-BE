import { encodeCode128B, moduleCount } from './code128';
import {
  LABEL_GEOMETRY,
  QUIET_ZONE_MODULES,
  binLabelLines,
  fitModuleWidth,
  labelPrintableDots,
  type BinLabel,
  type LabelLines,
  type LabelSize,
} from './layout';
import { zplEscapeBarcode, zplEscapeText } from './text';

/**
 * Story 2-10a — labels (bin labels; 2-10b LPN labels) as ZPL II for a 203-dpi Zebra thermal printer.
 *
 * One `^XA…^XZ` per label: `^PW`/`^LL` size the label, `^CI0` pins the 7-bit
 * character set, the text fields print through `^FH` with the hex escapes of
 * `zplEscapeText`, and the barcode is `^BCN,<h>,N,N,N,N` (no interpretation
 * line, no UCC check digit, no auto mode) with an explicit start-B (`>:`) —
 * so the symbol, and its width, are exactly what `encodeCode128B` computes
 * (decision 9). Text is left-aligned at the margin: `^FB` is avoided because
 * it reads `\&` in field data as a line break.
 *
 * No printer configuration commands (no `~`-commands, no `^JU`, no media
 * settings) — the label never changes the printer's setup.
 *
 * Every label must already have passed the barcodable and fit checks; a
 * label that does not fit throws (a programming error, never a user refusal).
 */
export function renderBinLabelsZpl(labels: readonly BinLabel[], size: LabelSize): string {
  return renderLabelsZpl(labels.map(binLabelLines), size);
}

/**
 * Story 2-10b — the generalised renderer: any label as ready-made lines (the
 * bin label and the LPN label both come through here). The barcode encodes
 * `payload` byte for byte; the text fields print the folded lines.
 */
export function renderLabelsZpl(labels: readonly LabelLines[], size: LabelSize): string {
  return labels.map((label) => renderOne(label, size)).join('');
}

/** The font width (dots) at which `text` fits the printable width — `^A0` glyphs advance at most their cell width. */
function fittedText(text: string, height: number, printable: number, minWidth: number): { text: string; width: number } {
  if (text.length === 0) return { text, width: height };
  const width = Math.min(height, Math.floor(printable / text.length));
  if (width >= minWidth) return { text, width };
  const keep = Math.max(1, Math.floor(printable / minWidth) - 3);
  return { text: `${text.slice(0, keep)}...`, width: minWidth };
}

function textField(x: number, y: number, height: number, printable: number, minWidth: number, raw: string): string {
  const fitted = fittedText(raw, height, printable, minWidth);
  return `^FO${x},${y}^A0N,${height},${fitted.width}^FH^FD${zplEscapeText(fitted.text)}^FS\n`;
}

function renderOne(text: LabelLines, size: LabelSize): string {
  const g = LABEL_GEOMETRY[size];
  const printable = labelPrintableDots(size);
  const modules = moduleCount(text.payload.length);
  const moduleWidth = fitModuleWidth(modules, printable);
  if (moduleWidth === null) {
    throw new Error(`label code "${text.payload}" does not fit a ${size} label`);
  }
  // Encoding here also asserts the payload is subset-B printable.
  encodeCode128B(text.payload);
  const minWidth = size === '4x2' ? 14 : 8;
  const x = g.marginDots;
  const barcodeX = g.marginDots + QUIET_ZONE_MODULES * moduleWidth;
  // `^LH0,0^PON` pin the label home and orientation for this format, whatever
  // the printer has stored (format-level commands, not configuration).
  let zpl = `^XA\n^LH0,0\n^PON\n^PW${g.widthDots}\n^LL${g.heightDots}\n^CI0\n`;
  zpl += textField(x, g.code[0], g.code[1], printable, minWidth, text.code);
  zpl += `^FO${barcodeX},${g.barcode[0]}^BY${moduleWidth}^BCN,${g.barcode[1]},N,N,N,N^FH^FD>:${zplEscapeBarcode(text.payload)}^FS\n`;
  zpl += textField(x, g.line1[0], g.line1[1], printable, minWidth, text.line1);
  if (text.line2.length > 0) {
    zpl += textField(x, g.line2[0], g.line2[1], printable, minWidth, text.line2);
  }
  zpl += '^XZ\n';
  return zpl;
}
