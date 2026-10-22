import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream, type PDFPage } from 'pdf-lib';
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

export interface ZplLabel {
  readonly raw: string;
  readonly payload: string;
  readonly moduleWidth: number;
}

export function parseZplLabels(zpl: string): ZplLabel[] {
  const labels = zpl.split('^XZ').filter((chunk) => chunk.includes('^XA'));
  return labels.map((raw) => {
    const barcode = /\^BY(\d+)\^BCN,\d+,N,N,N,N\^FH\^FD>:(.*?)\^FS/.exec(raw);
    if (barcode === null) throw new Error(`no start-B barcode field in label: ${raw}`);
    return { raw, payload: zplUnescapeBarcode(barcode[2]!), moduleWidth: Number(barcode[1]) };
  });
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

export async function readPdfLabels(pdf: Buffer | Uint8Array): Promise<PdfLabelPage[]> {
  const doc = await PDFDocument.load(pdf);
  const pages: PdfLabelPage[] = [];
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const symbols = symbolsOf(barsOf(await pageContent(doc, page)));
    pages.push({ width, height, payloads: symbols.map((widths) => decodeCode128B(widths)) });
  }
  return pages;
}
