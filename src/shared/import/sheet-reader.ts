import { parse as parseCsv } from 'csv-parse/sync';
import { Workbook, type CellValue } from 'exceljs';
import { ProblemException } from '../problem-details/problem.exception';

/**
 * The one spreadsheet reader (extracted from `catalog/import.command.ts` by
 * the ASN import story, 2026-10-17): CSV through `csv-parse`, XLSX through
 * `exceljs`, a required header row, and the single-worksheet rule. Two
 * importers read files with it — the catalog import (its behaviour is
 * unchanged: its options are the defaults below, and its tests pass
 * unedited) and the ASN import, which opts into three differences:
 *
 * - `unknownColumns: 'ignore'` — an extra column (notes, descriptions) is
 *   dropped instead of refusing the file;
 * - `rowNumbers: 'sheet'` — a row is numbered as the spreadsheet numbers it
 *   (the header is row 1, a blank row still takes its number), instead of the
 *   catalog's gap-free 1-based data-row index;
 * - `missingColumns: 'all'` — every missing required column is named at once,
 *   as 400 `missing-columns`, instead of the first as `file-unreadable`;
 * - `dateCells: 'ist-wall-clock'` — an XLSX date cell is read as the
 *   wall-clock time the sheet shows, in IST, BEFORE any `toISOString()`
 *   (exceljs hands a date cell over as a `Date` whose UTC fields are that wall
 *   clock; the catalog's default renders it as that UTC instant).
 *
 * It decides nothing about the rows' meaning: every value comes back as the
 * cell's TEXT. An XLSX number is its shortest round-tripping decimal string
 * (`String(n)`), so a quantity cell is never re-read through a float twice.
 */

/** The upload cap both importers share (multer's limit and the command's own check). */
export const MAX_SHEET_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface SheetFile {
  readonly name: string;
  readonly mimetype: string;
  readonly buffer: Buffer;
  readonly size: number;
}

export interface SheetRow {
  /** See `SheetReaderOptions.rowNumbers`. */
  readonly rowNumber: number;
  /** Lower-cased header name → the cell's text (absent columns are absent). */
  readonly values: Readonly<Record<string, string>>;
}

export interface SheetReaderOptions {
  /** Every column the importer understands (lower-case). */
  readonly knownColumns: ReadonlySet<string>;
  /** The columns a header must carry (lower-case). */
  readonly requiredColumns: readonly string[];
  /** The data-row cap — more is 422 `import-too-large`. */
  readonly maxRows: number;
  /** `refuse` (default): an unknown header column is 400 `file-unreadable`. `ignore`: it is dropped. */
  readonly unknownColumns?: 'refuse' | 'ignore';
  /**
   * `data-index` (default): the 1-based data-row index, header excluded,
   * renumbered after blank rows are dropped (gap-free, identical across
   * formats). `sheet`: the spreadsheet's own row number — the header is row
   * 1 and a blank row keeps its number, so the report points at the row the
   * person sees.
   */
  readonly rowNumbers?: 'data-index' | 'sheet';
  /** `first` (default): 400 `file-unreadable` naming the first. `all`: 400 `missing-columns` naming every one. */
  readonly missingColumns?: 'first' | 'all';
  /** `utc-iso` (default): a date cell's `toISOString()`. `ist-wall-clock`: its wall clock, as `…+05:30`. */
  readonly dateCells?: 'utc-iso' | 'ist-wall-clock';
}

// ── file-level refusals (shared by both importers) ──────────────────────────

export function importTooLarge(detail: string): ProblemException {
  return new ProblemException('import-too-large', 422, 'Import exceeds the row or size cap', detail);
}

export function unsupportedFileType(name: string): ProblemException {
  return new ProblemException(
    'unsupported-file-type',
    415,
    'Unsupported import file type',
    `Only .csv and .xlsx files can be imported (got "${name}").`,
  );
}

export function fileUnreadable(detail: string): ProblemException {
  return new ProblemException('file-unreadable', 400, 'Import file could not be read', detail);
}

/** 400 `missing-columns` — every required column the header lacks, named. */
export function missingColumns(columns: readonly string[]): ProblemException {
  return new ProblemException(
    'missing-columns',
    400,
    'The header is missing required columns',
    `The header row is missing ${columns.length === 1 ? 'the required column' : 'the required columns'} ${columns
      .map((column) => `"${column}"`)
      .join(', ')}.`,
  );
}

// ── the reader ───────────────────────────────────────────────────────────────

/** exceljs' legacy Buffer interface (its xlsx.load parameter type). */
type ExcelBuffer = Parameters<Workbook['xlsx']['load']>[0];

/**
 * Reads the file's rows. The format is sniffed by extension, then mimetype;
 * anything else is 415. Both formats share the header contract: a required
 * header row of known columns (unknown → refused or dropped), no duplicate
 * known column (the last occurrence would silently win), every required
 * column present, and at least one data row (else 400 `file-unreadable`).
 */
export async function readSheet(file: SheetFile, options: SheetReaderOptions): Promise<SheetRow[]> {
  const name = file.name.toLowerCase();
  const mime = file.mimetype.toLowerCase();
  if (name.endsWith('.csv') || mime.includes('csv')) {
    return readCsvSheet(file.buffer, options);
  }
  if (name.endsWith('.xlsx') || mime.includes('spreadsheetml')) {
    return readXlsxSheet(file.buffer, options);
  }
  throw unsupportedFileType(file.name || 'unnamed file');
}

function missingRequired(seen: ReadonlySet<string>, options: SheetReaderOptions): ProblemException | null {
  const missing = options.requiredColumns.filter((required) => !seen.has(required));
  if (missing.length === 0) {
    return null;
  }
  return options.missingColumns === 'all'
    ? missingColumns(missing)
    : fileUnreadable(`Missing required column "${missing[0]}" in the header row.`);
}

function readCsvSheet(buffer: Buffer, options: SheetReaderOptions): SheetRow[] {
  const ignoreUnknown = options.unknownColumns === 'ignore';
  const sheetNumbers = options.rowNumbers === 'sheet';
  // The columns callback sees the raw header row: validate the shared header
  // contract there (unknown, duplicate, and missing-required columns are all
  // 400 — a duplicate would otherwise let the last occurrence's values
  // silently win). The problem is captured rather than thrown so we never
  // depend on how csv-parse propagates callback errors.
  let headerProblem: ProblemException | null = null;
  let records: Record<string, string | string[]>[];
  try {
    records = parseCsv(new Uint8Array(buffer), {
      bom: true,
      columns: (header: string[]) => {
        const seen = new Set<string>();
        for (const raw of header) {
          const name = raw.trim().toLowerCase();
          if (name === '') continue;
          if (!options.knownColumns.has(name)) {
            if (ignoreUnknown) continue;
            headerProblem = fileUnreadable(`Unknown column "${raw.trim()}" — the header must use the documented column names.`);
            break;
          }
          if (seen.has(name)) {
            headerProblem = fileUnreadable(`Duplicate column "${name}" in the header row.`);
            break;
          }
          seen.add(name);
        }
        if (headerProblem === null) {
          headerProblem = missingRequired(seen, options);
        }
        return header.map((raw) => raw.trim().toLowerCase());
      },
      // `sheet` numbering keeps the blank lines as (blank) records, so a
      // record's index is its spreadsheet row minus the header; they are
      // dropped as blank rows below.
      skip_empty_lines: !sheetNumbers,
      relax_column_count: true,
      trim: false,
    });
  } catch (error) {
    throw fileUnreadable(`The CSV could not be parsed: ${(error as Error).message}`);
  }
  if (headerProblem !== null) {
    throw headerProblem;
  }
  const rows = records.map((record, index) => {
    // relax_column_count keeps parsing past a row carrying more fields than
    // the header but parks the excess in __parsed_extra — silent data loss;
    // reject instead.
    if (Array.isArray((record as Record<string, unknown>)['__parsed_extra'])) {
      throw fileUnreadable('A data row has more fields than the header — every row must match the documented column set.');
    }
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      const name = key.trim().toLowerCase();
      if (!options.knownColumns.has(name)) continue;
      values[name] = Array.isArray(value) ? value.join(',') : (value ?? '');
    }
    // The header is spreadsheet row 1, so data record `index` sits on row index + 2.
    return { rowNumber: sheetNumbers ? index + 2 : index + 1, values };
  });
  return finalizeRows(rows, options);
}

async function readXlsxSheet(buffer: Buffer, options: SheetReaderOptions): Promise<SheetRow[]> {
  const ignoreUnknown = options.unknownColumns === 'ignore';
  const workbook = new Workbook();
  try {
    // exceljs types the argument as its own legacy Buffer interface.
    await workbook.xlsx.load(buffer as unknown as ExcelBuffer);
  } catch (error) {
    throw fileUnreadable(`The XLSX could not be parsed: ${(error as Error).message}`);
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw fileUnreadable('The workbook has no worksheets.');
  }
  // Only the first sheet would silently win — make the extra sheets a parse
  // failure instead.
  if (workbook.worksheets.length > 1) {
    throw fileUnreadable('The workbook must contain exactly one worksheet — remove the extra sheets and try again.');
  }
  const text = (value: CellValue): string => cellText(value, options.dateCells ?? 'utc-iso');
  const columns = new Map<number, string>();
  const seenNames = new Set<string>();
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = text(cell.value).trim();
    if (header === '') return;
    const name = header.toLowerCase();
    if (!options.knownColumns.has(name)) {
      if (ignoreUnknown) return;
      throw fileUnreadable(`Unknown column "${header}" — the header must use the documented column names.`);
    }
    if (seenNames.has(name)) {
      throw fileUnreadable(`Duplicate column "${header}" in the header row — the last occurrence would silently win.`);
    }
    seenNames.add(name);
    columns.set(colNumber, name);
  });
  const missing = missingRequired(new Set(columns.values()), options);
  if (missing !== null) {
    throw missing;
  }
  const rows: { rowNumber: number; values: Record<string, string> }[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, string> = {};
    for (const [colNumber, name] of columns) {
      values[name] = text(row.getCell(colNumber).value);
    }
    // Styled-but-blank trailing rows are not data rows.
    if (Object.values(values).some((value) => value.trim() !== '')) {
      rows.push({ rowNumber: options.rowNumbers === 'sheet' ? rowNumber : rowNumber - 1, values });
    }
  });
  return finalizeRows(rows, options);
}

/**
 * Blank-row filtering + the row cap, shared by both formats. With the
 * default `data-index` numbering the rows are renumbered sequentially so the
 * documented `rowNumber` (1-based data-row index, header excluded) is
 * gap-free and identical across formats: CSV's skip_empty_lines already
 * compresses blanks, while XLSX rows carry sheet-row gaps that would
 * otherwise leak through. `sheet` numbering keeps each row's own number.
 */
function finalizeRows(
  rows: readonly { rowNumber: number; values: Record<string, string> }[],
  options: SheetReaderOptions,
): SheetRow[] {
  const nonBlank = rows.filter((row) => Object.values(row.values).some((value) => (value ?? '').trim() !== ''));
  if (nonBlank.length === 0) {
    throw fileUnreadable('The file has a header row but no data rows.');
  }
  if (nonBlank.length > options.maxRows) {
    throw importTooLarge(`The file has ${nonBlank.length} data rows — the cap is ${options.maxRows}.`);
  }
  if (options.rowNumbers === 'sheet') {
    return nonBlank.map((row) => ({ rowNumber: row.rowNumber, values: row.values }));
  }
  return nonBlank.map((row, index) => ({ rowNumber: index + 1, values: row.values }));
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** ExcelJS cell values: formulas ({result}), rich text, dates, booleans. */
function cellText(value: CellValue, dates: 'utc-iso' | 'ist-wall-clock'): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (dates === 'utc-iso') return value.toISOString();
    if (Number.isNaN(value.getTime())) return '';
    // exceljs builds a date cell's Date from the sheet's zone-less serial, so
    // its UTC fields ARE the wall clock the sheet shows. Read them as IST.
    return (
      `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}` +
      `T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}` +
      `.${pad(value.getUTCMilliseconds(), 3)}+05:30`
    );
  }
  if (typeof value === 'object') {
    if ('result' in value) return cellText((value as { result: CellValue }).result, dates);
    if ('text' in value) return cellText((value as { text: CellValue }).text, dates);
    if ('richText' in value) {
      return (value as { richText: { text: string }[] }).richText.map((part) => part.text).join('');
    }
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}
