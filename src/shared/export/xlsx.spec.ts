import { Workbook } from 'exceljs';
import { XLSX_MAX_CELL_CHARS, buildXlsx } from './xlsx';
import type { ExportColumn } from './cells';

// Story 5-3a — the XLSX writer's typed cells, parsed back with exceljs.
describe('buildXlsx (story 5-3a)', () => {
  const columns: ExportColumn[] = [
    { header: 'text', kind: 'text' },
    { header: 'quantity', kind: 'number' },
    { header: 'recorded_ist', kind: 'instant' },
    { header: 'expiry_date', kind: 'date' },
  ];

  async function readBack(rows: (string | number | Date | null)[][]): Promise<Workbook> {
    const workbook = new Workbook();
    await workbook.xlsx.load((await buildXlsx('smoke', columns, rows)) as unknown as Parameters<Workbook['xlsx']['load']>[0]);
    return workbook;
  }

  it('a formula-looking string stays a string, a negative number a number, instants and dates read the IST wall clock', async () => {
    const workbook = await readBack([['=SUM(A1:A9)', -5, new Date('2026-10-21T18:29:59.000Z'), new Date('2026-10-21T18:30:00.000Z')], [null, null, null, null]]);
    const sheet = workbook.worksheets[0]!;
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(['text', 'quantity', 'recorded_ist', 'expiry_date']);
    const row = sheet.getRow(2);
    expect(row.getCell(1).value).toBe('=SUM(A1:A9)');
    expect(row.getCell(1).formula).toBeUndefined();
    expect(row.getCell(2).value).toBe(-5);
    expect((row.getCell(3).value as Date).toISOString()).toBe('2026-10-21T23:59:59.000Z');
    expect(row.getCell(3).numFmt).toBe('yyyy-mm-dd hh:mm:ss');
    expect((row.getCell(4).value as Date).toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(row.getCell(4).numFmt).toBe('yyyy-mm-dd');
    expect(sheet.getRow(3).getCell(1).value).toBeNull();
  });

  it('a string over 32,767 characters is truncated with an ellipsis; one at the limit is kept', async () => {
    const workbook = await readBack([['x'.repeat(XLSX_MAX_CELL_CHARS + 10), 0, null, null], ['y'.repeat(XLSX_MAX_CELL_CHARS), 0, null, null]]);
    const sheet = workbook.worksheets[0]!;
    const long = sheet.getRow(2).getCell(1).value as string;
    expect(long).toHaveLength(XLSX_MAX_CELL_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(sheet.getRow(3).getCell(1).value).toBe('y'.repeat(XLSX_MAX_CELL_CHARS));
  });

  it('refuses a cell of the wrong kind', async () => {
    await expect(buildXlsx('x', columns, [['a', '5' as unknown as number, null, null]])).rejects.toThrow(TypeError);
  });
});
