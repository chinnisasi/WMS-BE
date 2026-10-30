import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream, type PDFPage } from 'pdf-lib';
import { decodeCode128B } from '../../src/shared/labels/code128';
import { zplUnescapeBarcode } from '../../src/shared/labels/text';

/**
 * Story 2-10a — reading printed labels back, for the unit and e2e specs.
 *
 * - ZPL: split into `^XA…^XZ` labels and recover each barcode's payload from
 *   its `^FD>:…^FS` (the start-B prefix stripped, the `^FH` and `><` escapes
 *   undone — what the printer does).
 * - PDF: rebuild every barcode from the bar rectangles in each page's content
 *   stream (x and width of each `re`-shaped path), turn the bar/space runs
 *   back into module widths and decode them with `decodeCode128B`.
 */

export interface ZplBarcode {
  readonly payload: string;
  readonly moduleWidth: number;
}

export interface ZplLabel {
  readonly raw: string;
  /** The FIRST barcode's payload (2-10a labels carry one). */
  readonly payload: string;
  readonly moduleWidth: number;
  /** Story 4-5a — every `^BC` field of the label, in order (a carton label carries the AWB's and the carton code's). */
  readonly barcodes: readonly ZplBarcode[];
}

export function parseZplLabels(zpl: string): ZplLabel[] {
  const labels = zpl.split('^XZ').filter((chunk) => chunk.includes('^XA'));
  return labels.map((raw) => {
    const barcodes = [...raw.matchAll(/\^BY(\d+)\^BCN,\d+,N,N,N,N\^FH\^FD>:(.*?)\^FS/g)].map((m) => ({
      payload: zplUnescapeBarcode(m[2]!),
      moduleWidth: Number(m[1]),
    }));
    if (barcodes.length === 0) throw new Error(`no start-B barcode field in label: ${raw}`);
    return { raw, payload: barcodes[0]!.payload, moduleWidth: barcodes[0]!.moduleWidth, barcodes };
  });
}

/** Story 4-5a — the text of every `^FD` text field (not barcodes), `^FH` escapes undone, in order. */
export function zplTexts(raw: string): string[] {
  return [...raw.matchAll(/\^A0N,\d+,\d+(?:\^FR)?\^FH\^FD(.*?)\^FS/g)].map((m) =>
    m[1]!.replace(/_([0-9A-Fa-f]{2})/g, (_x, hex: string) => String.fromCharCode(parseInt(hex, 16))),
  );
}

interface Bar {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

async function pageContent(doc: PDFDocument, page: PDFPage): Promise<string> {
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents === undefined ? [] : [contents];
  let text = '';
  for (const ref of refs) {
    const stream = doc.context.lookup(ref);
    if (stream instanceof PDFRawStream) {
      text += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    } else if (stream !== undefined && 'getContentsString' in (stream as object)) {
      text += (stream as unknown as { getContentsString(): string }).getContentsString();
    }
  }
  return text;
}

function barsOf(content: string): Bar[] {
  const bars: Bar[] = [];
  const re = /1 0 0 1 ([\d.]+) ([\d.]+) cm\n(?:1 0 0 1 0 0 cm\n)*0 0 m\n0 [\d.]+ l\n([\d.]+) [\d.]+ l\n[\d.]+ 0 l\nh\nf/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    bars.push({ x: Number(m[1]), y: Number(m[2]), width: Number(m[3]) });
  }
  return bars;
}

/** Bars of one row (same bottom edge) split into symbols wherever the gap is wider than any in-symbol space. */
function symbolsOf(bars: Bar[]): number[][] {
  const byRow = new Map<string, Bar[]>();
  for (const bar of bars) {
    const key = bar.y.toFixed(3);
    byRow.set(key, [...(byRow.get(key) ?? []), bar]);
  }
  const symbols: number[][] = [];
  const rows = [...byRow.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
  for (const [, rowBars] of rows) {
    rowBars.sort((a, b) => a.x - b.x);
    let current: Bar[] = [];
    const flush = (): void => {
      if (current.length === 0) return;
      const module = Math.min(...current.map((b) => b.width));
      const widths: number[] = [];
      current.forEach((bar, i) => {
        widths.push(Math.round(bar.width / module));
        const next = current[i + 1];
        if (next !== undefined) widths.push(Math.round((next.x - (bar.x + bar.width)) / module));
      });
      symbols.push(widths);
      current = [];
    };
    for (const bar of rowBars) {
      const last = current[current.length - 1];
      // A gap of more than 5 modules cannot be inside a symbol (spaces are 1–4).
      if (last !== undefined && bar.x - (last.x + last.width) > 5 * Math.min(...current.map((b) => b.width))) flush();
      current.push(bar);
    }
    flush();
  }
  return symbols;
}

export interface PdfLabelPage {
  readonly width: number;
  readonly height: number;
  /** Decoded payloads on the page, top row first, left to right. */
  readonly payloads: string[];
}

/**
 * Story 4-5a (A49) — the barcode rectangles a page declares (`/WMSBarcodeBands`,
 * x y w h in points, written by the shipping-label and document renderers), or
 * null on a page that declares none (2-10a labels: every bar is read).
 */
function declaredBands(page: PDFPage): { x: number; y: number; w: number; h: number }[] | null {
  const entry = page.node.get(PDFName.of('WMSBarcodeBands'));
  if (!(entry instanceof PDFArray)) return null;
  const numbers = entry.asArray().map((item) => (item instanceof PDFNumber ? item.asNumber() : Number.NaN));
  const bands: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i + 3 < numbers.length; i += 4) bands.push({ x: numbers[i]!, y: numbers[i + 1]!, w: numbers[i + 2]!, h: numbers[i + 3]! });
  return bands;
}

function insideBand(bar: Bar, bands: readonly { x: number; y: number; w: number; h: number }[]): boolean {
  const eps = 0.01;
  return bands.some((band) => bar.x >= band.x - eps && bar.x + bar.width <= band.x + band.w + eps && Math.abs(bar.y - band.y) <= eps);
}

export async function readPdfLabels(pdf: Buffer | Uint8Array): Promise<PdfLabelPage[]> {
  const doc = await PDFDocument.load(pdf);
  const pages: PdfLabelPage[] = [];
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const bands = declaredBands(page);
    const bars = barsOf(await pageContent(doc, page));
    const symbols = symbolsOf(bands === null ? bars : bars.filter((bar) => insideBand(bar, bands)));
    pages.push({ width, height, payloads: symbols.map((widths) => decodeCode128B(widths)) });
  }
  return pages;
}
