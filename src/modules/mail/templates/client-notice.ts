import { headerText, html, plainText } from './escape';

/**
 * Story 5-2b — the pieces both client notices (`client-receipt`,
 * `client-dispatch`) share: the stored-parameter decoding helpers, the line
 * table, the portal line and the footer. Transactional only: no tracking
 * pixel, no link rewriting, no logo (no asset store; remote images are
 * blocked by most clients). English only. Every parameter is HTML-escaped,
 * and every header value passes through `headerText`.
 */

/** At most this many lines are shown; the rest read "…and N more lines". */
export const CLIENT_EMAIL_MAX_LINES = 100;

type Raw = Record<string, unknown>;

export function asRecord(raw: unknown, what: string): Raw {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${what}: not an object`);
  return raw as Raw;
}

export function textField(value: Raw, key: string, what: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field === '') throw new Error(`${what}: ${key} is not a string`);
  return field;
}

export function nullableText(value: Raw, key: string, what: string): string | null {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== 'string' || field === '') throw new Error(`${what}: ${key} is not a string or null`);
  return field;
}

export function instantField(value: Raw, key: string, what: string): string {
  const field = textField(value, key, what);
  if (Number.isNaN(Date.parse(field))) throw new Error(`${what}: ${key} is not an instant`);
  return field;
}

export function countField(value: Raw, key: string, what: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) throw new Error(`${what}: ${key} is not a count`);
  return field;
}

/** A quantity as stored: a decimal string (never a float). */
const DECIMAL_RE = /^-?\d+(?:\.\d{1,3})?$/;

export function quantityField(value: Raw, key: string, what: string): string {
  const field = textField(value, key, what);
  if (!DECIMAL_RE.test(field)) throw new Error(`${what}: ${key} is not a decimal string`);
  return field;
}

export function linesField<T>(value: Raw, key: string, what: string, decode: (line: Raw) => T): T[] {
  const field = value[key];
  if (!Array.isArray(field) || field.length > CLIENT_EMAIL_MAX_LINES) throw new Error(`${what}: ${key} is not a bounded list`);
  return field.map((line) => decode(asRecord(line, `${what} line`)));
}

/** A table: a header row and body rows, every cell escaped. Right-aligned columns are named by index. */
export function htmlTable(head: readonly string[], rows: readonly (readonly string[])[], rightAligned: ReadonlySet<number>): string {
  const cell = (tag: 'th' | 'td', value: string, index: number) =>
    `<${tag} style="padding: 4px 8px; border-bottom: 1px solid #ddd; text-align: ${rightAligned.has(index) ? 'right' : 'left'};">${html(value)}</${tag}>`;
  return [
    '<table style="border-collapse: collapse; font-size: 14px;">',
    `<thead><tr>${head.map((value, index) => cell('th', value, index)).join('')}</tr></thead>`,
    `<tbody>${rows.map((row) => `<tr>${row.map((value, index) => cell('td', value, index)).join('')}</tr>`).join('')}</tbody>`,
    '</table>',
  ].join('\n');
}

/** "…and N more lines" — the 100-line limit's tail, or null when every line is shown. */
export function moreLinesNote(moreLines: number): string | null {
  return moreLines === 0 ? null : `…and ${moreLines} more ${moreLines === 1 ? 'line' : 'lines'}`;
}

/**
 * A10 — the footer. With a Reply-To (the client's, else the deployment's
 * `EMAIL_REPLY_TO`) a reply reaches someone; without one it would reach
 * nobody, so the footer asks the recipient to ask the warehouse instead.
 */
export function clientFooter(tenant: string, client: string, hasReplyTo: boolean): string {
  const how = hasReplyTo ? `reply to this email or ask ${tenant}` : `ask ${tenant} to remove you`;
  return `You receive this because ${tenant} lists you as a contact for ${client}. To stop these emails, ${how}.`;
}

/** The shared HTML shell. `bodyHtml` is already escaped. */
export function clientHtml(subject: string, bodyHtml: readonly string[], footer: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>' + html(subject) + '</title></head>',
    '<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; font-size: 15px; line-height: 1.5; color: #111;">',
    ...bodyHtml,
    `<p style="color: #555; font-size: 13px;">${html(footer)}</p>`,
    '</body></html>',
  ].join('\n');
}

/** "{tenant} via WMS" — the From display name (header-safe). */
export function clientFromName(tenantName: string): string {
  return headerText(`${plainText(tenantName)} via WMS`, 120);
}
