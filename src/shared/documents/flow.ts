import { A4_HEIGHT_PT, A4_WIDTH_PT, type DocumentBarcode, type DocumentFill, type DocumentPage, type DocumentRule, type DocumentRun } from './a4-pdf';
import { DOCUMENT_FONTS, documentText, type DocumentFont } from './text';
import { wrapText } from './wrap';
import { istWallClock } from '../primitives/time';

/**
 * Story 4-9a (A25, A26) — the flowing page model the freight documents share:
 * a header repeated on every page, paragraphs and headings that never cross
 * the footer line, and tables whose rows never split and whose column header
 * repeats under "(continued)" after a break (4-5a's packing-slip flow,
 * parameterised by the page's orientation). Every string is folded
 * (`documentText`) before it is measured. Pure.
 */

export const LEADING = 1.25;
const { regular, bold } = DOCUMENT_FONTS;
export const fontOf = (name: 'regular' | 'bold'): DocumentFont => (name === 'bold' ? bold : regular);

export interface FlowGeometry {
  readonly landscape: boolean;
  readonly margin: number;
  /** Content stays above this line; the page footer sits below it. */
  readonly footerTop: number;
}

export interface FlowColumn {
  readonly header: string;
  readonly width: number;
  readonly align: 'left' | 'right';
  readonly maxLines: number;
}

export interface FlowRow {
  readonly cells: readonly string[];
}

interface MutablePage {
  runs: DocumentRun[];
  rules: DocumentRule[];
  barcodes: DocumentBarcode[];
  fills: DocumentFill[];
}

export class DocumentFlow {
  readonly pages: MutablePage[] = [];
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly contentWidth: number;
  readonly left: number;
  readonly top: number;
  y: number;

  constructor(
    readonly geometry: FlowGeometry,
    private readonly header: (flow: DocumentFlow) => void,
  ) {
    this.pageWidth = geometry.landscape ? A4_HEIGHT_PT : A4_WIDTH_PT;
    this.pageHeight = geometry.landscape ? A4_WIDTH_PT : A4_HEIGHT_PT;
    this.contentWidth = this.pageWidth - 2 * geometry.margin;
    this.left = geometry.margin;
    this.top = this.pageHeight - geometry.margin;
    this.y = this.top;
    this.newPage();
  }

  newPage(): void {
    this.pages.push({ runs: [], rules: [], barcodes: [], fills: [] });
    this.y = this.top;
    this.header(this);
  }

  get page(): MutablePage {
    return this.pages[this.pages.length - 1]!;
  }

  ensure(height: number): boolean {
    if (this.y - height < this.geometry.footerTop) {
      this.newPage();
      return true;
    }
    return false;
  }

  run(x: number, baseline: number, size: number, font: 'regular' | 'bold', text: string, white = false): void {
    if (text.length > 0) this.page.runs.push(white ? { x, y: baseline, size, font, text, color: 'white' } : { x, y: baseline, size, font, text });
  }

  rule(x1: number, y1: number, x2: number, y2: number, width = 0.5): void {
    this.page.rules.push({ x1, y1, x2, y2, width });
  }

  /** An open rectangle of four rules. */
  box(x: number, y: number, w: number, h: number, width = 0.5): void {
    this.rule(x, y, x + w, y, width);
    this.rule(x, y + h, x + w, y + h, width);
    this.rule(x, y, x, y + h, width);
    this.rule(x + w, y, x + w, y + h, width);
  }

  gap(height: number): void {
    this.y -= height;
  }

  /** Wraps and draws; returns the lines drawn. */
  paragraph(raw: string, size: number, fontName: 'regular' | 'bold' = 'regular', maxLines = Number.POSITIVE_INFINITY, indent = 0): string[] {
    const font = fontOf(fontName);
    const lines = wrapText(documentText(raw, font), font, size, this.contentWidth - indent, maxLines);
    for (const line of lines) {
      this.ensure(size * LEADING);
      this.run(this.left + indent, this.y - size, size, fontName, line);
      this.y -= size * LEADING;
    }
    return lines;
  }

  heading(text: string, size: number, keepWith: number): void {
    this.ensure(size * LEADING + 4 + keepWith);
    this.gap(4);
    this.run(this.left, this.y - size, size, 'bold', documentText(text, bold));
    this.y -= size * LEADING + 1;
  }

  /** Side-by-side blocks of a heading and lines, each `width` wide. */
  blocks(entries: readonly { readonly heading: string; readonly fields: readonly string[] }[], headingSize: number, size: number, maxLinesPerField = 3): void {
    const gapBetween = 12;
    const width = (this.contentWidth - gapBetween * (entries.length - 1)) / entries.length;
    const wrapped = entries.map((entry) => ({
      heading: documentText(entry.heading, bold),
      lines: entry.fields.flatMap((field) => wrapText(documentText(field, regular), regular, size, width, maxLinesPerField)),
    }));
    const height = headingSize * LEADING + Math.max(0, ...wrapped.map((entry) => entry.lines.length)) * size * LEADING;
    this.ensure(height + 4);
    const top = this.y;
    wrapped.forEach((entry, index) => {
      const x = this.left + index * (width + gapBetween);
      this.run(x, top - headingSize, headingSize, 'bold', entry.heading);
      entry.lines.forEach((line, lineIndex) => this.run(x, top - headingSize * LEADING - size - lineIndex * size * LEADING, size, 'regular', line));
    });
    this.y = top - height - 4;
  }

  table(title: string | null, columns: readonly FlowColumn[], rows: readonly FlowRow[], size: number, headingSize: number): void {
    const wrapRow = (cells: readonly string[], fontName: 'regular' | 'bold') =>
      cells.map((cell, index) => {
        const column = columns[index]!;
        const font = fontOf(fontName);
        return wrapText(documentText(cell, font), font, size, column.width - 4, column.maxLines);
      });
    const headerCells = wrapRow(
      columns.map((column) => column.header),
      'bold',
    );
    const heightOf = (cells: string[][]) => Math.max(1, ...cells.map((lines) => lines.length)) * size * LEADING + 3;
    const drawRow = (cells: string[][], fontName: 'regular' | 'bold', ruleBelow: number) => {
      const height = heightOf(cells);
      let x = this.left;
      cells.forEach((lines, index) => {
        const column = columns[index]!;
        lines.forEach((line, lineIndex) => {
          const baseline = this.y - 1.5 - size - lineIndex * size * LEADING;
          const width = fontOf(fontName).widthOfTextAtSize(line, size);
          this.run(column.align === 'right' ? x + column.width - 2 - width : x + 2, baseline, size, fontName, line);
        });
        x += column.width;
      });
      this.y -= height;
      this.rule(this.left, this.y, this.left + this.contentWidth, this.y, ruleBelow);
    };
    const drawHeader = () => {
      this.rule(this.left, this.y, this.left + this.contentWidth, this.y, 0.75);
      drawRow(headerCells, 'bold', 0.75);
    };
    const wrapped = rows.map((row) => wrapRow(row.cells, 'regular'));
    const headerHeight = heightOf(headerCells);
    const first = wrapped[0];
    const firstHeight = first === undefined ? 0 : heightOf(first);
    if (title !== null) this.heading(title, headingSize, headerHeight + firstHeight);
    else this.ensure(headerHeight + firstHeight);
    drawHeader();
    for (const cells of wrapped) {
      const height = heightOf(cells);
      if (this.y - height < this.geometry.footerTop) {
        this.newPage();
        this.heading(`${title ?? 'Table'} (continued)`, headingSize, headerHeight + height);
        drawHeader();
      }
      drawRow(cells, 'regular', 0.25);
    }
  }

  /** The finished pages (empty barcode and fill lists omitted, so a page without them keeps 2-9a's shape). */
  finish(): DocumentPage[] {
    return this.pages.map((page) => ({
      runs: page.runs,
      rules: page.rules,
      ...(page.barcodes.length === 0 ? {} : { barcodes: page.barcodes }),
      ...(page.fills.length === 0 ? {} : { fills: page.fills }),
      ...(this.geometry.landscape ? { landscape: true } : {}),
    }));
  }
}

/** `2026-10-30 16:05 IST`. */
export function istLabel(instant: string): string {
  return `${istWallClock(instant).slice(0, 16)} IST`;
}

/** Indian digit grouping of a non-negative integer string (`1234567` → `12,34,567`). */
function indianGroup(whole: string): string {
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/** Grams → `9,840 kg` / `12.5 kg` (one decimal at most, Indian grouping). */
export function kgGrouped(grams: number): string {
  const tenths = Math.round(grams / 100);
  const whole = indianGroup(String(Math.trunc(tenths / 10)));
  const fraction = tenths % 10;
  return `${whole}${fraction === 0 ? '' : `.${fraction}`} kg`;
}

/** A plain count with Indian grouping. */
export function countGrouped(n: number): string {
  return indianGroup(String(Math.trunc(n)));
}
