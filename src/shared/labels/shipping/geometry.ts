import { POINTS_PER_DOT, POINTS_PER_MM, PRINTER_DPI } from '../layout';

/**
 * Story 4-5a (A15) — the 4×6 in shipping label on the 203-dpi dot grid
 * (`PRINTER_DPI`): 812 × 1218 dots, 30-dot margins. The ZPL and the PDF draw
 * the same positioned fields on this grid, the PDF scaled by `POINTS_PER_DOT`
 * — so the two are the same label.
 */
export const SHIPPING_LABEL = {
  dpi: PRINTER_DPI,
  widthDots: 812,
  heightDots: 1218,
  marginDots: 30,
  /** 4 in × 6 in. */
  widthPt: 812 * POINTS_PER_DOT,
  heightPt: 1218 * POINTS_PER_DOT,
} as const;

/** The printable width between the margins, in dots. */
export const SHIPPING_PRINTABLE_DOTS = SHIPPING_LABEL.widthDots - 2 * SHIPPING_LABEL.marginDots;

/** The default gap between stacked fields in a band (A42). */
export const FIELD_GAP_DOTS = 6;

/** The narrowest glyph cell (dots) a text field shrinks to before it wraps or cuts — the 2-10a 4×2 minimum. */
export const MIN_GLYPH_DOTS = 14;

/**
 * Two 4×6 labels side by side on one landscape A4 page at 100 % (A14), with a
 * cut line round each. The labels are centred on the page.
 */
export const A4_LANDSCAPE = {
  widthPt: 297 * POINTS_PER_MM,
  heightPt: 210 * POINTS_PER_MM,
  labelsPerPage: 2,
} as const;

/** The top-left corner (PDF points, from the page's bottom-left) of label slot 0 or 1 on the A4 sheet. */
export function a4SlotOrigin(slot: number): { readonly left: number; readonly top: number } {
  const totalWidth = 2 * SHIPPING_LABEL.widthPt;
  const left = (A4_LANDSCAPE.widthPt - totalWidth) / 2 + slot * SHIPPING_LABEL.widthPt;
  const top = A4_LANDSCAPE.heightPt - (A4_LANDSCAPE.heightPt - SHIPPING_LABEL.heightPt) / 2;
  return { left, top };
}
