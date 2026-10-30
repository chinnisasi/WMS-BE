import { encodeCode128B } from '../code128';
import { zplEscapeBarcode, zplEscapeText } from '../text';
import { assertLabelBands, type ShippingField, type ShippingLabel } from './fields';
import { SHIPPING_LABEL, SHIPPING_PRINTABLE_DOTS } from './geometry';

/**
 * Story 4-5a (A15, D7) — shipping labels (carton labels, carton slips,
 * package labels) as ZPL II for a 203-dpi Zebra, 4×6 in. One `^XA…^XZ` per
 * label, `^CI0` (7-bit), text through `^FH` with the 2-10a escapes, barcodes
 * `^BCN,<h>,N,N,N,N` with an explicit start-B (`>:`) — exactly the symbol
 * `encodeCode128B` computes. A reversed field is a filled `^GB` box with its
 * text `^FR` (field reverse). Bold text is struck twice, 2 dots apart (font 0
 * has no bold). No printer configuration commands.
 */
export function renderShippingLabelsZpl(labels: readonly ShippingLabel[]): string {
  return labels.map(renderOne).join('');
}

function renderOne(label: ShippingLabel): string {
  assertLabelBands(label);
  let zpl = `^XA\n^LH0,0\n^PON\n^PW${SHIPPING_LABEL.widthDots}\n^LL${SHIPPING_LABEL.heightDots}\n^CI0\n`;
  for (const field of label.fields) zpl += fieldZpl(field);
  return `${zpl}^XZ\n`;
}

function fieldZpl(field: ShippingField): string {
  switch (field.kind) {
    case 'text': {
      if (field.text.length === 0) return '';
      const one = (x: number) => `^FO${x},${field.y}^A0N,${field.h},${field.w}^FH^FD${zplEscapeText(field.text)}^FS\n`;
      return field.bold ? one(field.x) + one(field.x + 2) : one(field.x);
    }
    case 'reverse':
      return (
        `^FO${field.x},${field.y}^GB${field.w},${field.h},${field.h},B^FS\n` +
        (field.text.length === 0
          ? ''
          : `^FO${field.x + field.pad},${field.y + Math.floor((field.h - field.textH) / 2)}^A0N,${field.textH},${field.textW}^FR^FH^FD${zplEscapeText(field.text)}^FS\n`)
      );
    case 'rule':
      return `^FO${SHIPPING_LABEL.marginDots},${field.y}^GB${SHIPPING_PRINTABLE_DOTS},${field.t},${field.t}^FS\n`;
    case 'box':
      return `^FO${field.x},${field.y}^GB${field.w},${field.h},${field.t}^FS\n`;
    case 'barcode':
      // Encoding asserts the payload is subset-B printable.
      encodeCode128B(field.payload);
      return `^FO${field.x},${field.y}^BY${field.moduleWidth}^BCN,${field.h},N,N,N,N^FH^FD>:${zplEscapeBarcode(field.payload)}^FS\n`;
  }
}
