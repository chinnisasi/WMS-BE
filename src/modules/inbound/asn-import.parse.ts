import { isIsoDate, istMidnightOf } from '../../shared/primitives/time';
import { importTooLarge, type SheetRow } from '../../shared/import/sheet-reader';
import { decimalPlaces, precisionRefusalDetail, validateRecordableQuantity } from '../../shared/primitives/quantity';

/**
 * The ASN import's pure half (2026-10-17): the file's column contract, the
 * IST date grammar, the quantity text rule, grouping rows into ASNs and the
 * file-only consistency checks. No database — `asn-import.command.ts` does
 * the lookups and runs the operator create's rules per group.
 */

// ── the file contract ────────────────────────────────────────────────────────

/** Every column the import reads (case-insensitive, any order; others are ignored). */
export const ASN_IMPORT_COLUMNS = ['asn_code', 'client', 'warehouse', 'expected_at', 'sku', 'quantity'] as const;
export type AsnImportColumn = (typeof ASN_IMPORT_COLUMNS)[number];

/** The header must carry these (400 `missing-columns` naming each one absent). */
export const ASN_IMPORT_REQUIRED_COLUMNS: readonly AsnImportColumn[] = ['asn_code', 'sku', 'quantity'];

/**
 * The caps bound ONE request's transaction (about six statements per ASN)
 * and its response. They do not bound the device snapshot, which lists every
 * open ASN: repeated imports can still grow it (PENDING, beside the portal
 * write cap).
 */
export const MAX_ASN_IMPORT_ROWS = 5_000;
export const MAX_ASN_IMPORT_ASNS = 500;

/**
 * The closed vocabulary of a refused row's reason — published as the
 * response DTO's enum so the web's copy map is a `Record` over it.
 *
 * - lookups: `unknown-client`, `unknown-warehouse`, `wrong-warehouse`, `unknown-sku`;
 * - client attribution: `sku-client-mismatch`, `mixed-client`;
 * - the ASN's own rules: `kit-cannot-hold-stock`, `duplicate-asn-code`,
 *   `invalid-asn-code`, `too-many-lines`;
 * - file consistency: `asn-rows-disagree`, `duplicate-sku-in-asn`;
 * - cell values: `invalid-quantity`, `quantity-precision`,
 *   `invalid-expected-at`, `missing-value`.
 *
 * `quantity-precision` is the spec's I/O matrix arm ("1.5 on a whole-unit
 * SKU"); the Always list folded it into the cell values, so it is listed
 * here as its own code rather than reported as `invalid-quantity`.
 */
export const ASN_IMPORT_ROW_ERROR_CODES = [
  'unknown-client',
  'unknown-warehouse',
  'wrong-warehouse',
  'unknown-sku',
  'sku-client-mismatch',
  'mixed-client',
  'kit-cannot-hold-stock',
  'duplicate-asn-code',
  'invalid-asn-code',
  'too-many-lines',
  'asn-rows-disagree',
  'duplicate-sku-in-asn',
  'invalid-quantity',
  'quantity-precision',
  'invalid-expected-at',
  'missing-value',
] as const;
export type AsnImportRowErrorCode = (typeof ASN_IMPORT_ROW_ERROR_CODES)[number];

/** One refused row: the spreadsheet row (header = row 1), its ASN code (null when blank), why. */
export interface AsnImportRowError {
  readonly rowNumber: number;
  readonly asnCode: string | null;
  readonly code: AsnImportRowErrorCode;
  readonly detail: string;
}

export function rowError(
  rowNumber: number,
  asnCode: string | null,
  code: AsnImportRowErrorCode,
  detail: string,
): AsnImportRowError {
  return { rowNumber, asnCode, code, detail };
}

// ── dates (IST) ──────────────────────────────────────────────────────────────

const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/;
const DATE_TIME_IST = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/;
const ISO_WITH_OFFSET = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

const IST_OFFSET_MINUTES = 330;

function offsetMinutes(designator: string): number | null {
  if (designator === 'Z') return 0;
  const sign = designator[0] === '-' ? -1 : 1;
  const hours = Number(designator.slice(1, 3));
  const minutes = Number(designator.slice(4, 6));
  if (hours > 14 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

/** The instant a wall-clock time at `offset` minutes east of UTC names — null when the clock is not real. */
function instantOf(date: string, hh: number, mm: number, ss: number, ms: number, offset: number): string | null {
  if (!isIsoDate(date) || hh > 23 || mm > 59 || ss > 59) return null;
  const wall = Date.parse(`${date}T00:00:00Z`) + ((hh * 60 + mm) * 60 + ss) * 1000 + ms;
  return new Date(wall - offset * 60_000).toISOString();
}

/**
 * The `expected_at` cell → the UTC instant the ASN stores (Z-suffixed — the
 * operator create's own rule), `null` for a blank cell, or a refusal.
 *
 * Accepted (§9 periods/IST: a naive date or time is IST — the warehouses are
 * in India, and someone typing "2026-10-20" means that IST day):
 * - `YYYY-MM-DD` → IST midnight (`istMidnightOf`, the shared helper);
 * - `YYYY-MM-DD HH:mm` → that IST wall-clock minute;
 * - ISO-8601 with an offset (`…T14:30+05:30`, `…T09:00:00Z`) → honoured as written.
 *   An XLSX date cell arrives here already in this form: the shared reader
 *   renders its wall clock as `…+05:30` before any `toISOString()`.
 *
 * Refused: anything else — a bare Excel serial (`46315`), `20/10/2026`,
 * `10/20/2026`, an unreal date or clock.
 */
export function parseExpectedAt(text: string): { ok: true; instant: string | null } | { ok: false; detail: string } {
  const value = text.trim();
  if (value === '') {
    return { ok: true, instant: null };
  }
  const refused = {
    ok: false as const,
    detail:
      `expected_at must be YYYY-MM-DD, YYYY-MM-DD HH:mm (read as IST) or an ISO-8601 time with an offset — ` +
      `got "${value}".`,
  };
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly !== null) {
    return isIsoDate(dateOnly[1]!) ? { ok: true, instant: istMidnightOf(dateOnly[1]!) } : refused;
  }
  const local = DATE_TIME_IST.exec(value);
  if (local !== null) {
    const instant = instantOf(local[1]!, Number(local[2]), Number(local[3]), 0, 0, IST_OFFSET_MINUTES);
    return instant === null ? refused : { ok: true, instant };
  }
  const iso = ISO_WITH_OFFSET.exec(value);
  if (iso !== null) {
    const offset = offsetMinutes(iso[6]!);
    const fraction = (iso[5] ?? '').padEnd(3, '0').slice(0, 3);
    const instant =
      offset === null
        ? null
        : instantOf(iso[1]!, Number(iso[2]), Number(iso[3]), Number(iso[4] ?? '0'), Number(fraction), offset);
    return instant === null ? refused : { ok: true, instant };
  }
  return refused;
}

// ── quantities ───────────────────────────────────────────────────────────────

const QUANTITY_TEXT = /^\d+(\.\d+)?$/;

/** The quantity cell's SHAPE: digits with an optional fraction — no sign, no exponent, no separators. */
export function isQuantityText(text: string): boolean {
  return QUANTITY_TEXT.test(text.trim());
}

/**
 * The quantity cell → milli-units, at the SKU's declared precision, through
 * the catalog's import-edge core (`validateRecordableQuantity`, sign
 * `positive` — the HTTP field's `@Min(0.001)`). The precision is read from
 * the cell's TEXT (trailing zeros of the fraction dropped), never from a
 * float: `1.0000000000000000001` is refused, not rounded to 1. An XLSX
 * number cell arrives as its shortest round-tripping decimal string.
 */
export function quantityToMilli(
  text: string,
  uom: string,
  precision: number,
):
  | { ok: true; milli: number }
  | { ok: false; code: 'invalid-quantity' | 'quantity-precision'; detail: string } {
  const value = text.trim();
  if (!QUANTITY_TEXT.test(value)) {
    return {
      ok: false,
      code: 'invalid-quantity',
      detail: `quantity must be a positive number in the SKU's base unit — digits with an optional decimal point (got "${value}").`,
    };
  }
  const fraction = value.includes('.') ? value.slice(value.indexOf('.') + 1).replace(/0+$/, '') : '';
  const number = Number(value);
  if (fraction.length > precision) {
    return {
      ok: false,
      code: 'quantity-precision',
      detail:
        decimalPlaces(number) === fraction.length
          ? precisionRefusalDetail('quantity', number, uom, precision)
          : `quantity "${value}" carries ${fraction.length} decimal places; base UoM "${uom}" declares ${precision}. It is refused rather than rounded.`,
    };
  }
  const result = validateRecordableQuantity(number, 'quantity', uom, precision, 'positive');
  if (result.ok) {
    return { ok: true, milli: result.milli };
  }
  return {
    ok: false,
    code: result.arm === 'precision' ? 'quantity-precision' : 'invalid-quantity',
    detail: result.detail,
  };
}

// ── rows ─────────────────────────────────────────────────────────────────────

/** One data row, its cells trimmed, with its first cell-level refusal (if any). */
export interface AsnImportRow {
  readonly rowNumber: number;
  readonly asnCode: string;
  /** The `client` cell as written (blank = the SKUs' client). */
  readonly client: string;
  readonly warehouse: string;
  /** The `expected_at` cell as written. */
  readonly expectedAtText: string;
  /** The normalised instant; `null` when blank; `undefined` when the cell was refused. */
  readonly expectedAt: string | null | undefined;
  readonly sku: string;
  readonly quantity: string;
}

/**
 * Reads the rows: a row with no `asn_code` belongs to no ASN and is refused
 * on its own (`missing-value`). Every other row joins its ASN even when one
 * of its cells is refused — the cell refusal then refuses that ASN whole.
 * Cell refusals, first failure wins per row: a blank `sku` or `quantity`
 * (`missing-value`), a quantity that is not a number (`invalid-quantity`), an
 * `expected_at` outside the grammar (`invalid-expected-at`).
 */
export function readAsnImportRows(sheet: readonly SheetRow[]): {
  readonly rows: AsnImportRow[];
  readonly errors: AsnImportRowError[];
} {
  const rows: AsnImportRow[] = [];
  const errors: AsnImportRowError[] = [];
  for (const raw of sheet) {
    const cell = (column: AsnImportColumn): string => (raw.values[column] ?? '').trim();
    const asnCode = cell('asn_code');
    if (asnCode === '') {
      errors.push(rowError(raw.rowNumber, null, 'missing-value', 'asn_code is blank — every row names the ASN it belongs to.'));
      continue;
    }
    const expected = parseExpectedAt(cell('expected_at'));
    const row: AsnImportRow = {
      rowNumber: raw.rowNumber,
      asnCode,
      client: cell('client'),
      warehouse: cell('warehouse'),
      expectedAtText: cell('expected_at'),
      expectedAt: expected.ok ? expected.instant : undefined,
      sku: cell('sku'),
      quantity: cell('quantity'),
    };
    rows.push(row);
    if (row.sku === '') {
      errors.push(rowError(row.rowNumber, asnCode, 'missing-value', 'sku is blank — every row names one SKU code.'));
    } else if (row.quantity === '') {
      errors.push(rowError(row.rowNumber, asnCode, 'missing-value', 'quantity is blank — every row announces a quantity.'));
    } else if (!isQuantityText(row.quantity)) {
      errors.push(
        rowError(
          row.rowNumber,
          asnCode,
          'invalid-quantity',
          `quantity must be a positive number in the SKU's base unit — digits with an optional decimal point (got "${row.quantity}").`,
        ),
      );
    } else if (!expected.ok) {
      errors.push(rowError(row.rowNumber, asnCode, 'invalid-expected-at', expected.detail));
    }
  }
  return { rows, errors };
}

// ── grouping ─────────────────────────────────────────────────────────────────

/** One ASN of the file: its rows in file order. */
export interface AsnImportGroup {
  readonly asnCode: string;
  readonly rows: readonly AsnImportRow[];
}

/**
 * Groups rows into ASNs by (`asn_code`, the `client` cell, case-insensitive)
 * in first-appearance order — `ASN-1` for GLOWCO and `ASN-1` for ACME are two
 * ASNs. A blank client is its own key here; the command derives its client
 * from the SKUs and then merges it with an explicit group of the same code
 * and client (`mergeGroups`), so one ASN is never split by how its rows
 * spelled the client — and the merged rows then disagree on `client`.
 */
export function groupAsnImportRows(rows: readonly AsnImportRow[]): AsnImportGroup[] {
  const groups = new Map<string, { asnCode: string; rows: AsnImportRow[] }>();
  for (const row of rows) {
    const key = `${row.asnCode}\u0000${row.client.toUpperCase()}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { asnCode: row.asnCode, rows: [row] });
    } else {
      group.rows.push(row);
    }
  }
  return [...groups.values()];
}

/**
 * Merges groups that turned out to be the same ASN — the same code for the
 * same resolved client. `clientOf` answers a group's client id (null when it
 * cannot be resolved; such a group is never merged). Rows stay in file order;
 * the merged group takes the first group's position.
 */
export function mergeGroups(
  groups: readonly AsnImportGroup[],
  clientOf: (group: AsnImportGroup) => string | null,
): { readonly group: AsnImportGroup; readonly clientId: string | null }[] {
  const merged: { group: { asnCode: string; rows: AsnImportRow[] }; clientId: string | null }[] = [];
  const byKey = new Map<string, { group: { asnCode: string; rows: AsnImportRow[] }; clientId: string | null }>();
  for (const group of groups) {
    const clientId = clientOf(group);
    const key = clientId === null ? null : `${group.asnCode}\u0000${clientId}`;
    const existing = key === null ? undefined : byKey.get(key);
    if (existing !== undefined) {
      existing.group.rows.push(...group.rows);
      existing.group.rows.sort((a, b) => a.rowNumber - b.rowNumber);
      continue;
    }
    const entry = { group: { asnCode: group.asnCode, rows: [...group.rows] }, clientId };
    merged.push(entry);
    if (key !== null) byKey.set(key, entry);
  }
  return merged;
}

/** 422 `import-too-large` past `MAX_ASN_IMPORT_ASNS` ASNs. */
export function assertAsnImportCount(asnCount: number): void {
  if (asnCount > MAX_ASN_IMPORT_ASNS) {
    throw importTooLarge(`The file announces ${asnCount} ASNs — the cap is ${MAX_ASN_IMPORT_ASNS} per import.`);
  }
}

// ── the file-only checks ─────────────────────────────────────────────────────

const CONSISTENT_COLUMNS = ['client', 'warehouse', 'expected_at'] as const;

/**
 * Every row of one ASN must agree on `client`, `warehouse` and
 * `expected_at` — compared after normalising (client and warehouse
 * case-insensitively, `expected_at` as the instant it names, so
 * `2026-10-20` and `2026-10-20 00:00` agree). A blank cell and a filled one
 * DISAGREE. A row whose `expected_at` was refused is left out of the date
 * comparison (it carries its own refusal). The first disagreeing row per
 * column is refused `asn-rows-disagree`, naming the column and the row it
 * differs from.
 */
export function rowDisagreements(group: AsnImportGroup): AsnImportRowError[] {
  const errors: AsnImportRowError[] = [];
  const normal = (row: AsnImportRow, column: (typeof CONSISTENT_COLUMNS)[number]): string | null | undefined => {
    if (column === 'client') return row.client.toUpperCase();
    if (column === 'warehouse') return row.warehouse.toUpperCase();
    return row.expectedAt;
  };
  const shown = (row: AsnImportRow, column: (typeof CONSISTENT_COLUMNS)[number]): string => {
    const text = column === 'client' ? row.client : column === 'warehouse' ? row.warehouse : row.expectedAtText;
    return text === '' ? 'blank' : `"${text}"`;
  };
  for (const column of CONSISTENT_COLUMNS) {
    const comparable = group.rows.filter((row) => normal(row, column) !== undefined);
    const first = comparable[0];
    if (first === undefined) continue;
    const other = comparable.find((row) => normal(row, column) !== normal(first, column));
    if (other !== undefined) {
      errors.push(
        rowError(
          other.rowNumber,
          group.asnCode,
          'asn-rows-disagree',
          `Row ${other.rowNumber}'s ${column} is ${shown(other, column)} but row ${first.rowNumber}'s is ${shown(first, column)} — ` +
            `every row of ASN "${group.asnCode}" must give the same ${column}.`,
        ),
      );
    }
  }
  return errors;
}

/** A SKU listed twice in one ASN is refused (on its repeat), never summed. */
export function repeatedSkus(group: AsnImportGroup): AsnImportRowError[] {
  const errors: AsnImportRowError[] = [];
  const firstRow = new Map<string, number>();
  for (const row of group.rows) {
    if (row.sku === '') continue;
    const earlier = firstRow.get(row.sku);
    if (earlier === undefined) {
      firstRow.set(row.sku, row.rowNumber);
    } else {
      errors.push(
        rowError(
          row.rowNumber,
          group.asnCode,
          'duplicate-sku-in-asn',
          `SKU "${row.sku}" is already on row ${earlier} of ASN "${group.asnCode}" — list each SKU once per ASN (quantities are not summed).`,
        ),
      );
    }
  }
  return errors;
}
