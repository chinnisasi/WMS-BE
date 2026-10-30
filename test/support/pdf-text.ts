import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';

/**
 * Story 2-9a (A19) — the text a PDF draws, per page, in drawing order: parse
 * the file with pdf-lib, inflate each page's FlateDecode content stream, and
 * read the hex strings shown by `Tj` (pdf-lib writes standard-font text as
 * `<hex> Tj`). Decodes WinAnsi bytes (ASCII, Latin-1, and the extras the
 * documents use). A test helper — the PDF-only arms are asserted on the file
 * a route actually served.
 */
const WIN_ANSI_EXTRAS: Readonly<Record<number, string>> = { 0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x96: '–', 0x97: '—' };

function decodeHex(hex: string): string {
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    out += WIN_ANSI_EXTRAS[byte] ?? String.fromCharCode(byte);
  }
  return out;
}

export async function pdfPagesText(buffer: Uint8Array): Promise<string[][]> {
  const doc = await PDFDocument.load(buffer);
  return doc.getPages().map((page) => {
    const contents = page.node.get(PDFName.of('Contents'));
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    const texts: string[] = [];
    for (const ref of refs) {
      const stream = doc.context.lookup(ref instanceof PDFRef ? ref : (ref as PDFRef));
      if (!(stream instanceof PDFRawStream)) continue;
      const filter = stream.dict.get(PDFName.of('Filter'));
      const raw = Buffer.from(stream.contents);
      const body = filter !== undefined && String(filter) === '/FlateDecode' ? inflateSync(raw).toString('latin1') : raw.toString('latin1');
      for (const match of body.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) texts.push(decodeHex(match[1]!));
    }
    return texts;
  });
}

/** Every page's text joined (one string per run, newline-separated). */
export async function pdfText(buffer: Uint8Array): Promise<string> {
  return (await pdfPagesText(buffer)).map((page) => page.join('\n')).join('\n');
}
