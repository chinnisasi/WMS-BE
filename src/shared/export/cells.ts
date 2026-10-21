/**
 * Story 5-3a — the typed cells the file writers share (`csv.ts`, `xlsx.ts`).
 *
 * A column declares its kind, and every cell under it must carry the
 * matching value (`assertCell` refuses anything else loudly — a register
 * that put a quantity string under a number column is a bug, not data):
 *
 *  - `text`    — a string (or null). The ONLY kind the formula guard touches.
 *  - `number`  — a finite number (or null), written RAW: a negative quantity
 *                stays the number −5 in both formats, never the text `'-5`.
 *  - `instant` — a `Date` (or null), printed as its IST wall clock.
 *  - `date`    — a `Date` (or null) holding a CALENDAR date stored as the
 *                instant its IST day begins (an expiry, a mfg date), printed
 *                as that IST date — never the UTC day before.
 */
export type ExportCellKind = 'text' | 'number' | 'instant' | 'date';

export type ExportCell = string | number | Date | null;

export interface ExportColumn {
  readonly header: string;
  readonly kind: ExportCellKind;
}

export function assertCell(column: ExportColumn, value: ExportCell): void {
  if (value === null) return;
  const ok =
    column.kind === 'text'
      ? typeof value === 'string'
      : column.kind === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : value instanceof Date && !Number.isNaN(value.getTime());
  if (!ok) {
    throw new TypeError(`Export column "${column.header}" (${column.kind}) cannot hold ${typeof value} ${String(value)}`);
  }
}
