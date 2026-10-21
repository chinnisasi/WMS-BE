import { istDateOf, istWallClock } from '../primitives/time';
import { assertCell, type ExportCell, type ExportColumn } from './cells';

/**
 * The CSV primitives every server-side export shares (RFC 4180: `\r\n` line
 * ends, UTF-8 with a byte-order mark so Excel reads it as UTF-8, one header
 * row). Moved here from `tenancy/audit-export.csv.ts` by story 5-3a, which
 * re-exports `UTF8_BOM` and `csvCell` unchanged — the audit export's bytes
 * are identical (`test/audit-export.spec.ts`).
 */

/** The UTF-8 byte-order mark a file starts with. */
export const UTF8_BOM = '﻿';

/**
 * One TEXT cell. The formula guard first (story 21-5b's rule, the web's
 * `csvField`): a cell starting with `=`, `+`, `-`, `@`, TAB or CR gets a
 * leading `'`, so a spreadsheet never executes it. Then RFC 4180 quoting: a
 * cell holding `,`, `"`, CR or LF is quoted, with its quotes doubled.
 *
 * Text only — a number never passes through here (story 5-3a, design review
 * B1: the guard turned a negative quantity into the text `'-5`).
 */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/**
 * Story 5-3a — one typed cell: text through the guard, a number raw
 * (`String(n)`), an instant as its IST wall clock, a calendar date as its
 * IST date, null empty.
 */
export function csvTypedCell(column: ExportColumn, value: ExportCell): string {
  assertCell(column, value);
  if (value === null) return '';
  switch (column.kind) {
    case 'text':
      return csvCell(value as string);
    case 'number':
      return String(value as number);
    case 'instant':
      return istWallClock(value as Date);
    case 'date':
      return istDateOf((value as Date).toISOString());
  }
}

/** The whole file: BOM, the header row, one line per row, `\r\n` after each. */
export function buildCsv(columns: readonly ExportColumn[], rows: readonly (readonly ExportCell[])[]): Buffer {
  const lines: string[] = [`${UTF8_BOM}${columns.map((column) => csvCell(column.header)).join(',')}\r\n`];
  for (const row of rows) {
    if (row.length !== columns.length) {
      throw new TypeError(`CSV row has ${row.length} cells for ${columns.length} columns`);
    }
    lines.push(`${row.map((value, index) => csvTypedCell(columns[index]!, value)).join(',')}\r\n`);
  }
  return Buffer.from(lines.join(''), 'utf8');
}
