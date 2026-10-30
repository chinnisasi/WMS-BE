import { moduleCount, isBarcodable } from '../code128';
import { QUIET_ZONE_MODULES, fitModuleWidth } from '../layout';
import { asciiFold } from '../text';
import { MIN_GLYPH_DOTS, SHIPPING_LABEL } from './geometry';

/**
 * Story 4-5a (A15) — a shipping label as a list of POSITIONED fields on the
 * 4×6 dot grid, already fitted: every text is ASCII-folded and given its glyph
 * width here, so the ZPL and the PDF renderers only draw. Pure.
 *
 * Every field belongs to a band; `assertLabelBands` throws (a programming
 * error, never a user refusal) when a field crosses its band — the A42 budget
 * made mechanical.
 */

/** A vertical band of the label, in dots from the top: [top, bottom). */
export interface LabelBand {
  readonly name: string;
  readonly top: number;
  readonly bottom: number;
}

/** A line of text: `^A0` cell `h` × `w` dots at (x, y), the top-left corner. */
export interface TextField {
  readonly kind: 'text';
  readonly band: string;
  readonly x: number;
  readonly y: number;
  readonly h: number;
  readonly w: number;
  /** The width the text was fitted to (the PDF shrinks to it). */
  readonly maxWidth: number;
  readonly bold: boolean;
  /** ASCII-folded. */
  readonly text: string;
}

/** White text on a filled black box (`^GB` filled + `^FR`). */
export interface ReverseField {
  readonly kind: 'reverse';
  readonly band: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly textH: number;
  readonly textW: number;
  readonly pad: number;
  readonly text: string;
}

/** A horizontal rule across the printable width, `t` dots thick, between bands. */
export interface RuleField {
  readonly kind: 'rule';
  readonly y: number;
  readonly t: number;
}

/** An outlined box. */
export interface BoxField {
  readonly kind: 'box';
  readonly band: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly t: number;
}

/** A Code 128 subset-B symbol; `x` is where the first bar starts (after its quiet zone). */
export interface BarcodeField {
  readonly kind: 'barcode';
  readonly band: string;
  readonly x: number;
  readonly y: number;
  readonly h: number;
  readonly moduleWidth: number;
  /** The raw code — never folded (a refused payload never becomes a barcode). */
  readonly payload: string;
}

export type ShippingField = TextField | ReverseField | RuleField | BoxField | BarcodeField;

export interface ShippingLabel {
  readonly bands: readonly LabelBand[];
  readonly fields: readonly ShippingField[];
}

/** The fitted lines of one text: each line's text and glyph width. */
export interface FittedLine {
  readonly text: string;
  readonly w: number;
}

function minGlyph(h: number): number {
  return Math.min(h, MIN_GLYPH_DOTS);
}

/** The widest glyph cell at which `text` fits `maxWidth` (`^A0` glyphs advance at most their cell width), or null below the minimum. */
function glyphFor(text: string, h: number, maxWidth: number): number | null {
  if (text.length === 0) return h;
  const w = Math.min(h, Math.floor(maxWidth / text.length));
  return w >= minGlyph(h) ? w : null;
}

function cut(text: string, h: number, maxWidth: number): FittedLine {
  const capacity = Math.max(4, Math.floor(maxWidth / minGlyph(h)));
  const keep = Math.max(1, capacity - 3);
  return { text: `${text.slice(0, keep).trimEnd()}...`, w: minGlyph(h) };
}

/**
 * A15 — fit `raw` to `maxWidth`: shrink the glyph to the minimum, then wrap
 * at spaces onto at most `maxLines` lines, then cut the last with `...`.
 * Folded to ASCII first. An empty text is no lines.
 */
export function fitText(raw: string, h: number, maxWidth: number, maxLines = 1): FittedLine[] {
  const text = asciiFold(raw).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return [];
  const whole = glyphFor(text, h, maxWidth);
  if (whole !== null) return [{ text, w: whole }];
  if (maxLines <= 1) return [cut(text, h, maxWidth)];
  const capacity = Math.max(1, Math.floor(maxWidth / minGlyph(h)));
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length <= capacity) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    current = word;
    while (current.length > capacity) {
      lines.push(current.slice(0, capacity));
      current = current.slice(capacity);
    }
  }
  if (current !== '') lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1]!;
    kept[maxLines - 1] = `${last.slice(0, Math.max(1, capacity - 3)).trimEnd()}...`;
    return kept.map((line) => ({ text: line, w: glyphFor(line, h, maxWidth) ?? minGlyph(h) }));
  }
  return lines.map((line) => ({ text: line, w: glyphFor(line, h, maxWidth) ?? minGlyph(h) }));
}

/** One fitted text line as a field. */
export function textField(band: string, x: number, y: number, h: number, maxWidth: number, line: FittedLine, bold = false): TextField {
  return { kind: 'text', band, x, y, h, w: line.w, maxWidth, bold, text: line.text };
}

/** A single-line text, fitted (cut, never wrapped) — or null when empty. */
export function singleText(band: string, x: number, y: number, h: number, maxWidth: number, raw: string, bold = false): TextField | null {
  const [line] = fitText(raw, h, maxWidth, 1);
  return line === undefined ? null : textField(band, x, y, h, maxWidth, line, bold);
}

/** A reversed box with its text centred vertically, fitted to the box. */
export function reverseField(band: string, x: number, y: number, w: number, h: number, textH: number, raw: string): ReverseField {
  const pad = Math.max(4, Math.floor((h - textH) / 2));
  const [line] = fitText(raw, textH, w - 2 * pad, 1);
  return { kind: 'reverse', band, x, y, w, h, textH, textW: line?.w ?? textH, pad, text: line?.text ?? '' };
}

/**
 * A Code 128 B barcode at the widest bar (2-10a `fitModuleWidth`, 10-module
 * quiet zones) that fits `maxWidth` — or null when the payload is not
 * subset-B printable or does not fit at 2 dots (the caller prints it as text
 * only, A15).
 */
export function barcodeField(band: string, x: number, y: number, h: number, maxWidth: number, payload: string): BarcodeField | null {
  if (!isBarcodable(payload)) return null;
  const moduleWidth = fitModuleWidth(moduleCount(payload.length), maxWidth);
  if (moduleWidth === null) return null;
  return { kind: 'barcode', band, x: x + QUIET_ZONE_MODULES * moduleWidth, y, h, moduleWidth, payload };
}

/** The barcode's drawn width in dots (quiet zones excluded). */
export function barcodeWidth(field: BarcodeField): number {
  return moduleCount(field.payload.length) * field.moduleWidth;
}

export function ruleField(y: number, t = 3): RuleField {
  return { kind: 'rule', y, t };
}

/** The vertical extent [top, bottom) of a banded field. */
function extentOf(field: Exclude<ShippingField, RuleField>): [number, number] {
  return [field.y, field.y + field.h];
}

/**
 * A42 — no field crosses its band, and no field leaves the label: throws
 * (a programming error) naming the field.
 */
export function assertLabelBands(label: ShippingLabel): void {
  const bands = new Map(label.bands.map((band) => [band.name, band]));
  for (const field of label.fields) {
    if (field.kind === 'rule') {
      if (field.y < 0 || field.y + field.t > SHIPPING_LABEL.heightDots) throw new Error(`a rule at ${field.y} leaves the label`);
      continue;
    }
    const band = bands.get(field.band);
    if (band === undefined) throw new Error(`field in unknown band "${field.band}"`);
    const [top, bottom] = extentOf(field);
    const what = field.kind === 'barcode' ? `barcode "${field.payload}"` : field.kind === 'box' ? 'box' : `"${field.text}"`;
    if (top < band.top || bottom > band.bottom) {
      throw new Error(`${what} (${top}–${bottom}) crosses band "${band.name}" (${band.top}–${band.bottom})`);
    }
    const right = field.kind === 'text' ? field.x + field.w * field.text.length : field.kind === 'barcode' ? field.x + barcodeWidth(field) : field.x + field.w;
    if (field.x < 0 || right > SHIPPING_LABEL.widthDots) {
      throw new Error(`${what} (${field.x}–${right}) leaves the label's width`);
    }
  }
}

/**
 * Stack fields top-down from `top` with `gap` between them; each entry is a
 * list of fitted lines at one height. Returns the fields and the next free y.
 */
export function stack(
  band: string,
  x: number,
  top: number,
  maxWidth: number,
  entries: readonly { readonly h: number; readonly lines: readonly FittedLine[]; readonly bold?: boolean }[],
  gap: number,
): { fields: TextField[]; bottom: number } {
  const fields: TextField[] = [];
  let y = top;
  for (const entry of entries) {
    for (const line of entry.lines) {
      fields.push(textField(band, x, y, entry.h, maxWidth, line, entry.bold ?? false));
      y += entry.h + gap;
    }
  }
  return { fields, bottom: fields.length === 0 ? top : y - gap };
}
