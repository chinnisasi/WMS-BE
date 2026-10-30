import { StandardFontEmbedder, StandardFonts } from 'pdf-lib';

/**
 * Story 2-9a (decision 16, A11) — text for an A4 document drawn with
 * pdf-lib's standard fonts. Pure: no document, no I/O.
 *
 * pdf-lib's Helvetica and Helvetica-Bold encode WinAnsi only, and an
 * unencodable character THROWS at draw time. So every string a document
 * prints is first normalised (`\r\n`, `\n`, `\t` → a space; whitespace runs
 * collapse) and then folded: each CODE POINT (so an emoji is one `?`) that
 * the font cannot encode becomes `?`. Latin-1 and the WinAnsi extras survive
 * ("Café" prints). A name in a non-Latin script prints as `?`s — the CSV
 * keeps it (PENDING, the 2-10a label precedent).
 */

/** What the fold needs of a font: its encodable code points (pdf-lib's `PDFFont.getCharacterSet`). */
export interface FoldableFont {
  getCharacterSet(): number[];
}

/** What the layout needs of a font: the fold, plus its widths. */
export interface DocumentFont extends FoldableFont {
  readonly name: 'Helvetica' | 'Helvetica-Bold';
  widthOfTextAtSize(text: string, size: number): number;
}

const characterSets = new WeakMap<FoldableFont, ReadonlySet<number>>();

function characterSetOf(font: FoldableFont): ReadonlySet<number> {
  let set = characterSets.get(font);
  if (set === undefined) {
    set = new Set(font.getCharacterSet());
    characterSets.set(font, set);
  }
  return set;
}

/** Line breaks and tabs become a space; runs of whitespace collapse; the ends are trimmed. */
export function normaliseDocumentText(text: string): string {
  return text.replace(/\r\n|[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Keeps every code point the font encodes (and that is not a control
 * character); replaces any other with `?`. Iterates by code point, so a
 * surrogate pair is ONE `?`.
 */
export function winAnsiFold(text: string, font: FoldableFont): string {
  const set = characterSetOf(font);
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code >= 0x20 && code !== 0x7f && set.has(code) ? ch : '?';
  }
  return out;
}

/** Normalise, then fold — the one entry every printed string goes through. */
export function documentText(text: string, font: FoldableFont): string {
  return winAnsiFold(normaliseDocumentText(text), font);
}

function standardFont(name: 'Helvetica' | 'Helvetica-Bold'): DocumentFont {
  // `StandardFonts` and the embedder's `FontNames` are the same strings under two enums.
  const embedder = StandardFontEmbedder.for((name === 'Helvetica' ? StandardFonts.Helvetica : StandardFonts.HelveticaBold) as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
  return {
    name,
    getCharacterSet: () => embedder.encoding.supportedCodePoints,
    widthOfTextAtSize: (text, size) => embedder.widthOfTextAtSize(text, size),
  };
}

/** The two fonts a document uses, with the metrics pdf-lib draws them with (no document needed). */
export const DOCUMENT_FONTS: { readonly regular: DocumentFont; readonly bold: DocumentFont } = {
  regular: standardFont('Helvetica'),
  bold: standardFont('Helvetica-Bold'),
};
