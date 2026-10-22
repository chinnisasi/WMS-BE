/**
 * Story 2-10a — label text: ASCII folding and ZPL escaping. Pure.
 *
 * **Every** string a label prints passes through `asciiFold` first, before
 * any ZPL or PDF write: ZPL's `^CI0` is 7-bit, and pdf-lib's standard
 * (WinAnsi) fonts throw on a character they cannot encode. A zone named in
 * Devanagari prints as `?`s rather than failing the whole batch.
 */

/** Every character outside printable ASCII `0x20–0x7E` becomes `?` (one per code point). */
export function asciiFold(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    out += c >= 0x20 && c <= 0x7e ? ch : '?';
  }
  return out;
}

/**
 * ZPL field data under `^FH` (hex indicator `_`): the caret and tilde are
 * command prefixes and the underscore is the indicator itself, so all three
 * are written as hex escapes. Nothing in a bin, zone or client code can then
 * open a ZPL command. The input must already be ASCII-folded.
 */
export function zplEscapeText(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '^') out += '_5E';
    else if (ch === '~') out += '_7E';
    else if (ch === '_') out += '_5F';
    else out += ch;
  }
  return out;
}

/**
 * A `^BC` barcode's field data: `>` is the Code 128 invocation character, so
 * a literal `>` is written `><` (decision 9) — then the `^FH` escapes. `><`
 * is left literal (not hex-escaped): `^FH` decodes hex BEFORE `^BC` reads its
 * invocation codes, so an escaped `>` would come back as an invocation.
 */
export function zplEscapeBarcode(payload: string): string {
  return zplEscapeText(payload.replace(/>/g, '><'));
}

/**
 * The inverse of `zplEscapeBarcode` after a `>:` start-B prefix is stripped —
 * for tests: decodes `_XX` hex escapes, then `><` → `>`.
 */
export function zplUnescapeBarcode(field: string): string {
  const hexDecoded = field.replace(/_([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return hexDecoded.replace(/></g, '>');
}
