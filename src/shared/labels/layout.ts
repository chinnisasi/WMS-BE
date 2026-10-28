/**
 * Story 2-10a — label geometry, and the barcode fit check. Pure.
 *
 * Two layouts:
 * - `label` — one label per page (PDF) or per `^XA…^XZ` (ZPL), 4x2 in
 *   (default) or 2x1 in, laid out in printer DOTS at 203 dpi. The PDF draws
 *   the same dot grid scaled to points, so a PDF label and a ZPL label are
 *   the same symbol.
 * - `a4` — PDF only: a fixed sheet of 3 × 8 cells, each 70 × 36 mm, with
 *   4.5 mm top and bottom margins and 2 mm inner padding (decision 4).
 *
 * **Bars are at least 2 units wide** (decision 9): 2 dots at 203 dpi, or
 * 2 × 0.127 mm on A4 — both ~10 mil, because phone cameras decode 5 mil
 * poorly. Every symbol carries a 10-module quiet zone each side.
 */

import { moduleCount } from './code128';
import { asciiFold } from './text';

export const LABEL_SIZES = ['4x2', '2x1'] as const;
export type LabelSize = (typeof LABEL_SIZES)[number];

export const LABEL_LAYOUTS = ['label', 'a4'] as const;
export type LabelLayout = (typeof LABEL_LAYOUTS)[number];

export const LABEL_FORMATS = ['zpl', 'pdf'] as const;
export type LabelFormat = (typeof LABEL_FORMATS)[number];

export const DEFAULT_LABEL_SIZE: LabelSize = '4x2';

/** Story 2-10a decision 11 — one print renders at most this many labels (a list of ids, or a zone). */
export const MAX_LABELS_PER_PRINT = 1000;

export const PRINTER_DPI = 203;
/** One printer dot in PDF points. */
export const POINTS_PER_DOT = 72 / PRINTER_DPI;
export const POINTS_PER_MM = 72 / 25.4;

export const QUIET_ZONE_MODULES = 10;
/** The narrowest bar, in layout units (dots, or A4 units of 0.127 mm). */
export const MIN_MODULE_UNITS = 2;
/** `^BY` accepts 1–10 dots; the same ceiling bounds the PDF. */
export const MAX_MODULE_UNITS = 10;

/** A thermal label's geometry in dots (203 dpi) and its page size in points. */
export interface LabelGeometry {
  readonly size: LabelSize;
  readonly widthDots: number;
  readonly heightDots: number;
  /** Left and right margin, each. */
  readonly marginDots: number;
  readonly widthPt: number;
  readonly heightPt: number;
  /** Vertical bands, in dots from the top: [y, height]. */
  readonly code: readonly [number, number];
  readonly barcode: readonly [number, number];
  readonly line1: readonly [number, number];
  readonly line2: readonly [number, number];
}

export const LABEL_GEOMETRY: Readonly<Record<LabelSize, LabelGeometry>> = {
  '4x2': {
    size: '4x2',
    widthDots: 812,
    heightDots: 406,
    marginDots: 40,
    widthPt: 288,
    heightPt: 144,
    code: [24, 90],
    barcode: [126, 170],
    line1: [312, 38],
    line2: [358, 28],
  },
  '2x1': {
    size: '2x1',
    widthDots: 406,
    heightDots: 203,
    marginDots: 20,
    widthPt: 144,
    heightPt: 72,
    code: [10, 44],
    barcode: [58, 84],
    line1: [148, 22],
    line2: [174, 18],
  },
};

/** The printable width of a label, in dots. */
export function labelPrintableDots(size: LabelSize): number {
  const g = LABEL_GEOMETRY[size];
  return g.widthDots - 2 * g.marginDots;
}

/** The A4 sheet (decision 4), in millimetres. */
export const A4_SHEET = {
  pageWidthMm: 210,
  pageHeightMm: 297,
  columns: 3,
  rows: 8,
  cellWidthMm: 70,
  cellHeightMm: 36,
  topMarginMm: 4.5,
  paddingMm: 2,
  /** The A4 barcode unit: 0.127 mm (5 mil), so the 2-unit minimum is 10 mil. */
  unitMm: 0.127,
} as const;

export const A4_CELLS_PER_PAGE = A4_SHEET.columns * A4_SHEET.rows;

/** The printable width of an A4 cell in A4 units (0.127 mm), floored. */
export function a4PrintableUnits(): number {
  const printableMm = A4_SHEET.cellWidthMm - 2 * A4_SHEET.paddingMm;
  // Floor with a hair of tolerance so 66 / 0.127 = 519.68… floors to 519.
  return Math.floor(printableMm / A4_SHEET.unitMm + 1e-9);
}

/**
 * The widest module (in layout units) at which a `modules`-wide symbol plus
 * its two quiet zones fits `printableUnits`, capped at `MAX_MODULE_UNITS` —
 * or `null` when even `MIN_MODULE_UNITS` does not fit.
 */
export function fitModuleWidth(modules: number, printableUnits: number): number | null {
  const total = modules + 2 * QUIET_ZONE_MODULES;
  const width = Math.min(MAX_MODULE_UNITS, Math.floor(printableUnits / total));
  return width >= MIN_MODULE_UNITS ? width : null;
}

/** Where a label is going: a thermal label of a size, or an A4 cell. */
export type LabelTarget = { readonly layout: 'label'; readonly size: LabelSize } | { readonly layout: 'a4' };

/** The printable width, in the target's layout units, that a barcode must fit. */
export function printableUnitsOf(target: LabelTarget): number {
  return target.layout === 'a4' ? a4PrintableUnits() : labelPrintableDots(target.size);
}

/** The longest code (characters) that fits a target at the 2-unit minimum bar: 4x2 → 28, 2x1 → 11, A4 → 18. */
export function maxCodeLengthFor(target: LabelTarget): number {
  let n = 0;
  while (fitModuleWidth(moduleCount(n + 1), printableUnitsOf(target)) !== null) n += 1;
  return n;
}

/** One bin label's facts, as the renderers take them (codes, never names). */
export interface BinLabel {
  /** The bin code — the barcode payload byte for byte, and the large text. */
  readonly code: string;
  readonly zoneCode: string;
  readonly warehouseCode: string;
  /** The bin's storage class; printed only when it is not `ambient`. */
  readonly storageClass: string;
  /** The dedicated client's code, or null for a shared bin. */
  readonly clientCode: string | null;
}

/**
 * Story 2-10b — what the shared renderers draw, whatever the label is for:
 * the large `code` text, the barcode `payload` (the RAW code, byte for byte —
 * `isBarcodable` and the encoder check it; never the folded text), and two
 * small lines. Every text field is already ASCII-folded; `line2` may be empty.
 */
export interface LabelLines {
  readonly code: string;
  readonly payload: string;
  readonly line1: string;
  readonly line2: string;
}

/**
 * The three text lines a bin label prints, ASCII-folded: the code, then
 * `<ZONE> - <WAREHOUSE>`, then the small line — the storage class when it is
 * not `ambient` and `CLIENT <code>` when the bin is dedicated (empty when
 * neither applies).
 */
export function binLabelText(label: BinLabel): { code: string; line1: string; line2: string } {
  const extras: string[] = [];
  if (label.storageClass !== 'ambient') extras.push(label.storageClass.toUpperCase());
  if (label.clientCode !== null) extras.push(`CLIENT ${label.clientCode}`);
  return {
    code: asciiFold(label.code),
    line1: asciiFold(`${label.zoneCode} - ${label.warehouseCode}`),
    line2: asciiFold(extras.join(' | ')),
  };
}

/** A bin label as the shared renderers take it: `binLabelText` plus the raw code as the payload. */
export function binLabelLines(label: BinLabel): LabelLines {
  return { ...binLabelText(label), payload: label.code };
}

/** Story 2-10b — one LPN label's facts, as the renderer takes them (codes, never names). */
export interface LpnLabel {
  /** The LPN code (`LPN-000042`) — the barcode payload byte for byte, and the large text. */
  readonly code: string;
  readonly skuCode: string;
  /** The declared quantity in BASE units (printed without trailing zeros: `12.5`, `40`). */
  readonly qty: number;
  /** The SKU's UoM code. */
  readonly uom: string;
  readonly grnCode: string;
  /** The batch code, or null for an untracked SKU. */
  readonly batchCode: string | null;
  /** The batch expiry as an IST calendar date (`YYYY-MM-DD`), or null when unset. */
  readonly expiryDate: string | null;
  /** The SKU's client's code, or null when it is the tenant's own goods. */
  readonly clientCode: string | null;
}

/**
 * Story 2-10b (decision 5, A9) — an LPN label's lines, ASCII-folded:
 * - the code;
 * - line 1: `<SKU> x <qty> <uom>`;
 * - line 2: `<GRN>`, then ` | B <batch>` (with ` EXP <YYYY-MM-DD>` when the
 *   batch has an expiry) when batched, then ` | CLIENT <code>` when the SKU's
 *   client is not the tenant's own.
 * Overflow is the renderers' (`...` truncation in ZPL, the measured shrink
 * then `...` in PDF).
 */
export function lpnLabelText(label: LpnLabel): LabelLines {
  let line2 = label.grnCode;
  if (label.batchCode !== null) {
    line2 += ` | B ${label.batchCode}`;
    if (label.expiryDate !== null) line2 += ` EXP ${label.expiryDate}`;
  }
  if (label.clientCode !== null) line2 += ` | CLIENT ${label.clientCode}`;
  return {
    code: asciiFold(label.code),
    payload: label.code,
    line1: asciiFold(`${label.skuCode} x ${formatLabelQuantity(label.qty)} ${label.uom}`),
    line2: asciiFold(line2),
  };
}

/** A base-unit quantity as a label prints it: plain decimal, no trailing zeros, never exponent notation. */
export function formatLabelQuantity(qty: number): string {
  // Quantities are exact to the milli-unit (3 dp) and bounded at ~9e12, so a
  // fixed 3-dp rendering with the zeros trimmed is exact and never exponential.
  return qty.toFixed(3).replace(/\.?0+$/, '');
}
