import { PassThrough } from 'node:stream';
import { stream as excelStream } from 'exceljs';
import { IST_OFFSET_MS } from '../primitives/time';
import { assertCell, type ExportCell, type ExportColumn } from './cells';

/**
 * Story 5-3a — one worksheet of typed cells as an `.xlsx` file, through
 * exceljs' STREAMING `WorkbookWriter` (`useSharedStrings: false`, so no
 * string table is held for the whole sheet) into an in-memory buffer. The
 * caller holds the whole file before it writes a single response header, so
 * every refusal still precedes the headers (IMPLEMENTATION-GUIDE §6).
 *
 *  - text   → a plain string cell. No formula guard is needed: exceljs writes
 *             a string as an inline string, never a formula (`=SUM(...)`
 *             stays text — pinned in `test/registers.spec.ts`);
 *  - number → a numeric cell, raw (a negative quantity stays a number);
 *  - instant / date → a date cell. exceljs writes a `Date`'s UTC fields as
 *             the sheet's wall clock, so the value is SHIFTED by
 *             `IST_OFFSET_MS` — the cell then reads the IST wall clock (or
 *             the IST calendar date), never UTC. Formats `yyyy-mm-dd hh:mm:ss`
 *             and `yyyy-mm-dd`.
 */
const NUMBER_FORMAT: Readonly<Record<'instant' | 'date', string>> = {
  instant: 'yyyy-mm-dd hh:mm:ss',
  date: 'yyyy-mm-dd',
};

/** Excel's limit on one cell's text. */
export const XLSX_MAX_CELL_CHARS = 32_767;

function xlsxValue(column: ExportColumn, value: ExportCell): string | number | Date | null {
  assertCell(column, value);
  if (value === null) return null;
  if (column.kind === 'instant' || column.kind === 'date') {
    return new Date((value as Date).getTime() + IST_OFFSET_MS);
  }
  // Excel refuses a cell longer than 32,767 characters — truncate visibly.
  if (typeof value === 'string' && value.length > XLSX_MAX_CELL_CHARS) return `${value.slice(0, XLSX_MAX_CELL_CHARS - 1)}…`;
  return value;
}

export async function buildXlsx(
  sheetName: string,
  columns: readonly ExportColumn[],
  rows: readonly (readonly ExportCell[])[],
): Promise<Buffer> {
  return buildXlsxWorkbook([{ name: sheetName, columns, rows }]);
}

/** One worksheet of a workbook: its name, typed columns and rows. */
export interface XlsxSheet {
  readonly name: string;
  readonly columns: readonly ExportColumn[];
  readonly rows: readonly (readonly ExportCell[])[] | AsyncIterable<readonly ExportCell[]>;
}

/**
 * Story 3-7a — several worksheets in ONE `.xlsx` file (the recall report's
 * "Recall" facts sheet beside its trace), each written exactly as `buildXlsx`
 * writes its one sheet — which is now this function with a single sheet, so
 * its bytes are unchanged (pinned by `test/recalls.spec.ts` against the
 * single-sheet path, and by `test/registers.spec.ts`). A sheet's rows may be
 * an ASYNC iterable: each row is committed to the streaming writer as it
 * arrives, so a large trace is never held as cells — only the (compressed)
 * file is, and a refusal the iterable throws mid-way (a row cap) discards the
 * whole workbook.
 */
export async function buildXlsxWorkbook(sheets: readonly XlsxSheet[]): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    sink.once('end', resolve);
    sink.once('error', reject);
  });
  finished.catch(() => undefined);

  const workbook = new excelStream.xlsx.WorkbookWriter({ stream: sink, useSharedStrings: false, useStyles: true });
  for (const { name, columns, rows } of sheets) {
    // Excel caps a sheet name at 31 characters and refuses `[]:*?/\`.
    const sheet = workbook.addWorksheet(name.replace(/[[\]:*?/\\]/g, '-').slice(0, 31));
    sheet.columns = columns.map((column) => ({
      header: column.header,
      key: column.header,
      width: Math.max(10, Math.min(40, column.header.length + 2)),
      ...(column.kind === 'instant' || column.kind === 'date' ? { style: { numFmt: NUMBER_FORMAT[column.kind] } } : {}),
    }));
    for await (const row of rows) {
      if (row.length !== columns.length) {
        throw new TypeError(`XLSX row has ${row.length} cells for ${columns.length} columns`);
      }
      sheet.addRow(row.map((value, index) => xlsxValue(columns[index]!, value))).commit();
    }
    sheet.commit();
  }
  await workbook.commit();
  await finished;
  return Buffer.concat(chunks);
}
