/**
 * Story 5-3a — a Bun smoke run of the register writers, plus a heap
 * measurement at the 50,000-row cap (design review B12: exceljs under Bun,
 * and the memory one synchronous download holds).
 *
 *   bun scripts/smoke-register-xlsx.ts            # the smoke checks only
 *   bun scripts/smoke-register-xlsx.ts --rows 50000
 *
 * The smoke writes a workbook with every cell kind, parses it back with
 * exceljs and checks the typed cells (a formula-looking string stays text,
 * a negative number stays a number, an instant shows the IST wall clock, a
 * calendar date its IST date). The measurement builds a ledger-register
 * shaped sheet (14 columns) of N rows as XLSX and as CSV and prints the
 * bytes, the time and the RSS / heap growth. Reported, not a CI gate.
 */
/* eslint-disable no-console */
import { Workbook } from 'exceljs';
import { buildCsv } from '../src/shared/export/csv';
import { buildXlsx } from '../src/shared/export/xlsx';
import type { ExportCell, ExportColumn } from '../src/shared/export/cells';

function fail(message: string): never {
  console.error(`SMOKE FAILED: ${message}`);
  process.exit(1);
}

async function smoke(): Promise<void> {
  const columns: ExportColumn[] = [
    { header: 'text', kind: 'text' },
    { header: 'quantity', kind: 'number' },
    { header: 'recorded_ist', kind: 'instant' },
    { header: 'expiry_date', kind: 'date' },
  ];
  const buffer = await buildXlsx('smoke', columns, [
    ['=SUM(A1:A9)', -5, new Date('2026-10-21T18:29:59.000Z'), new Date('2026-10-21T18:30:00.000Z')],
    [null, null, null, null],
  ]);
  const workbook = new Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<Workbook['xlsx']['load']>[0]);
  const sheet = workbook.worksheets[0];
  if (sheet === undefined) fail('no worksheet');
  const row = sheet.getRow(2);
  if (row.getCell(1).value !== '=SUM(A1:A9)') fail(`text cell read back as ${JSON.stringify(row.getCell(1).value)}`);
  if (row.getCell(2).value !== -5) fail(`number cell read back as ${JSON.stringify(row.getCell(2).value)}`);
  const at = row.getCell(3).value;
  if (!(at instanceof Date) || at.toISOString() !== '2026-10-21T23:59:59.000Z') fail(`instant cell read back as ${String(at)}`);
  const expiry = row.getCell(4).value;
  if (!(expiry instanceof Date) || expiry.toISOString() !== '2026-10-22T00:00:00.000Z') fail(`date cell read back as ${String(expiry)}`);
  if (row.getCell(3).numFmt !== 'yyyy-mm-dd hh:mm:ss' || row.getCell(4).numFmt !== 'yyyy-mm-dd') fail('date formats lost');
  const csv = buildCsv(columns, [['=SUM(A1:A9)', -5, new Date('2026-10-21T18:29:59.000Z'), new Date('2026-10-21T18:30:00.000Z')]]).toString('utf8');
  if (csv !== '﻿text,quantity,recorded_ist,expiry_date\r\n\'=SUM(A1:A9),-5,2026-10-21 23:59:59,2026-10-22\r\n') fail(`csv ${JSON.stringify(csv)}`);
  console.log(`smoke ok (runtime: ${typeof Bun === 'undefined' ? 'node' : `bun ${Bun.version}`}, xlsx ${buffer.length} bytes)`);
}

async function measure(rows: number): Promise<void> {
  const kinds: ExportColumn['kind'][] = ['instant', 'instant', 'text', 'text', 'text', 'text', 'text', 'number', 'text', 'text', 'text', 'text', 'text', 'text'];
  const columns: ExportColumn[] = kinds.map((kind, index) => ({ header: `column_${index}`, kind }));
  const now = new Date();
  const data: ExportCell[][] = Array.from({ length: rows }, (_, i) => [
    now,
    now,
    'pick.picked',
    `SKU-${String(i % 5000).padStart(5, '0')}`,
    'A-01-02',
    'RECEIVING',
    `BATCH-${i % 300}`,
    -1.5,
    `order 0192f1a2-${String(i).padStart(4, '0')}-7000-8000-000000000000`,
    'ravi.kumar',
    'ACME',
    'Plain cotton t-shirt, navy, M',
    'HSN 6109',
    'pcs',
  ]);
  for (const format of ['xlsx', 'csv'] as const) {
    if (typeof Bun !== 'undefined') Bun.gc(true);
    const before = process.memoryUsage();
    const started = Date.now();
    const file = format === 'xlsx' ? await buildXlsx('ledger', columns, data) : buildCsv(columns, data);
    const after = process.memoryUsage();
    console.log(
      `${format}: ${rows} rows → ${file.length.toLocaleString()} bytes in ${Date.now() - started} ms; ` +
        `rss ${Math.round(before.rss / 1e6)} → ${Math.round(after.rss / 1e6)} MB, heapUsed ${Math.round(before.heapUsed / 1e6)} → ${Math.round(after.heapUsed / 1e6)} MB`,
    );
  }
}

await smoke();
const rowsArg = process.argv.indexOf('--rows');
if (rowsArg !== -1) await measure(Number(process.argv[rowsArg + 1] ?? 50_000));
