import { documentText, type DocumentFont } from './text';

/**
 * Story 2-9a's wrap rule, shared since 4-5a (the packing slip draws with the
 * same metrics). Moved verbatim from `grn-document.layout.ts`, which
 * re-exports it — the GRN bytes are unchanged.
 */
function ellipsisFor(font: DocumentFont): string {
  return documentText('…', font) === '…' ? '…' : '...';
}

/**
 * Wraps already-folded text to `width` at `size`: by words, a word wider
 * than the line broken by characters; past `maxLines` the last kept line
 * ends in `…`. Empty text is no line.
 */
export function wrapText(text: string, font: DocumentFont, size: number, width: number, maxLines: number): string[] {
  if (text.length === 0 || maxLines <= 0) return [];
  const fits = (value: string) => font.widthOfTextAtSize(value, size) <= width;
  const lines: string[] = [];
  // Stops once maxLines + 1 lines exist — the rest is cut by the ellipsis anyway.
  const full = () => lines.length > maxLines;
  /**
   * Breaks a token wider than the line by ACCUMULATING per-character widths
   * (never re-measuring the token from its full length), and always puts at
   * least one character on a line, so a glyph wider than the line terminates.
   * Returns the tail that still fits on a line of its own.
   */
  const breakToken = (token: string): string => {
    const chars = Array.from(token);
    let start = 0;
    while (start < chars.length && !full()) {
      let end = start;
      let used = 0;
      while (end < chars.length) {
        const w = font.widthOfTextAtSize(chars[end]!, size);
        if (end > start && used + w > width) break;
        used += w;
        end += 1;
      }
      if (end === chars.length) return chars.slice(start).join('');
      lines.push(chars.slice(start, end).join(''));
      start = end;
    }
    return '';
  };
  let current = '';
  for (const word of text.split(' ')) {
    if (full()) break;
    const candidate = current === '' ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    current = fits(word) ? word : breakToken(word);
  }
  if (current !== '' && !full()) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const dots = ellipsisFor(font);
  let last = kept[maxLines - 1]!;
  while (last.length > 0 && !fits(`${last}${dots}`)) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}${dots}`;
  return kept;
}

