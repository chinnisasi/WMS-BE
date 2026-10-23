/**
 * Story 5-1a (decision 6) — the escaping every template uses. Every
 * parameter that reaches HTML goes through `html`; every value that reaches
 * a header (the subject, the From display name) goes through `headerText`,
 * which removes CR, LF and every other control character so no parameter
 * can add a header line.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function html(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}

/** One line of header text: control characters (CR and LF included) become spaces, runs collapse, trimmed. */
export function headerText(value: string, maxLength = 200): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

/** Plain-text body lines: control characters other than the newlines the template writes itself are removed. */
export function plainText(value: string): string {
  return headerText(value, 500);
}
