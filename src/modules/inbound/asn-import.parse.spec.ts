import { Workbook } from 'exceljs';
import { readSheet, type SheetRow } from '../../shared/import/sheet-reader';
import {
  ASN_IMPORT_COLUMNS,
  ASN_IMPORT_REQUIRED_COLUMNS,
  MAX_ASN_IMPORT_ASNS,
  MAX_ASN_IMPORT_ROWS,
  assertAsnImportCount,
  groupAsnImportRows,
  parseExpectedAt,
  quantityToMilli,
  readAsnImportRows,
  repeatedSkus,
  resolveAsnGroups,
  rowDisagreements,
} from './asn-import.parse';

// The ASN import's pure half (2026-10-17) — no database: the file contract
// through the shared reader's ASN options, the IST date grammar, the quantity
// text rule, grouping and the file-only consistency checks.

const ASN_OPTIONS = {
  knownColumns: new Set<string>(ASN_IMPORT_COLUMNS),
  requiredColumns: ASN_IMPORT_REQUIRED_COLUMNS,
  maxRows: MAX_ASN_IMPORT_ROWS,
  unknownColumns: 'ignore' as const,
  rowNumbers: 'sheet' as const,
  missingColumns: 'all' as const,
  dateCells: 'ist-wall-clock' as const,
};

function csv(text: string): { name: string; mimetype: string; buffer: Buffer; size: number } {
  const buffer = Buffer.from(text, 'utf8');
  return { name: 'asns.csv', mimetype: 'text/csv', buffer, size: buffer.length };
}

async function xlsx(rows: unknown[][]): Promise<{ name: string; mimetype: string; buffer: Buffer; size: number }> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('ASNs');
  for (const row of rows) sheet.addRow(row);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { name: 'asns.xlsx', mimetype: 'application/octet-stream', buffer, size: buffer.length };
}

function sheetRow(rowNumber: number, values: Record<string, string>): SheetRow {
  return { rowNumber, values };
}

describe('the ASN import file contract (shared reader, ASN options)', () => {
  it('reads columns case-insensitively in any order, ignores extra columns, and numbers rows as the spreadsheet does (header = 1, blank rows keep their number)', async () => {
    const rows = await readSheet(
      csv('Quantity,SKU,Notes,ASN_CODE\n5,GLOW-1,first,A-1\n\n3,"GLOW-2",second,A-1\n'),
      ASN_OPTIONS,
    );
    expect(rows).toEqual([
      { rowNumber: 2, values: { quantity: '5', sku: 'GLOW-1', asn_code: 'A-1' } },
      { rowNumber: 4, values: { quantity: '3', sku: 'GLOW-2', asn_code: 'A-1' } },
    ]);
  });

  it('names EVERY missing required column (400 missing-columns)', async () => {
    await expect(readSheet(csv('client,notes\nGLOWCO,x\n'), ASN_OPTIONS)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'missing-columns',
        status: 400,
        detail: 'The header row is missing the required columns "asn_code", "sku", "quantity".',
      }),
    });
    await expect(readSheet(csv('asn_code,sku\nA,B\n'), ASN_OPTIONS)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'missing-columns', detail: 'The header row is missing the required column "quantity".' }),
    });
  });

  it('caps the data rows (422 import-too-large) and refuses an empty file and a wrong type', async () => {
    const lines = ['asn_code,sku,quantity', ...Array.from({ length: MAX_ASN_IMPORT_ROWS + 1 }, (_, i) => `A-${i},S,1`)];
    await expect(readSheet(csv(lines.join('\n')), ASN_OPTIONS)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'import-too-large', status: 422 }),
    });
    await expect(readSheet(csv('asn_code,sku,quantity\n'), ASN_OPTIONS)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'file-unreadable', status: 400 }),
    });
    await expect(
      readSheet({ name: 'asns.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF'), size: 4 }, ASN_OPTIONS),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'unsupported-file-type', status: 415 }) });
  });

  it('an XLSX date cell is its wall clock read as IST (before any toISOString); a number is its decimal text; rows keep sheet numbers', async () => {
    const file = await xlsx([
      ['asn_code', 'sku', 'quantity', 'expected_at', 'comment'],
      ['A-1', 'KG-1', 2.5, new Date(Date.UTC(2026, 9, 20, 14, 30)), 'ignored'],
      [],
      ['A-1', 'KG-2', 0.1, new Date(Date.UTC(2026, 9, 20)), ''],
    ]);
    const rows = await readSheet(file, ASN_OPTIONS);
    expect(rows).toEqual([
      { rowNumber: 2, values: { asn_code: 'A-1', sku: 'KG-1', quantity: '2.5', expected_at: '2026-10-20T14:30:00.000+05:30' } },
      { rowNumber: 4, values: { asn_code: 'A-1', sku: 'KG-2', quantity: '0.1', expected_at: '2026-10-20T00:00:00.000+05:30' } },
    ]);
    expect(parseExpectedAt(rows[0]!.values['expected_at']!)).toEqual({ ok: true, instant: '2026-10-20T09:00:00.000Z' });
    expect(parseExpectedAt(rows[1]!.values['expected_at']!)).toEqual({ ok: true, instant: '2026-10-19T18:30:00.000Z' });
  });

  it('a quoted cell holding a newline is still ONE spreadsheet row; cells past the header are dropped when columns are ignored', async () => {
    const rows = await readSheet(
      csv('asn_code,sku,quantity,notes\nA-1,S-1,1,"line one\nline two"\nA-1,S-2,2,plain,extra,cells\n'),
      ASN_OPTIONS,
    );
    expect(rows).toEqual([
      { rowNumber: 2, values: { asn_code: 'A-1', sku: 'S-1', quantity: '1' } },
      { rowNumber: 3, values: { asn_code: 'A-1', sku: 'S-2', quantity: '2' } },
    ]);
  });

  it('an XLSX time-only cell reads as its clock text (refused, never 1899); a float formula result reads as Excel shows it', async () => {
    const file = await xlsx([
      ['asn_code', 'sku', 'quantity', 'expected_at'],
      ['A-1', 'KG-1', 0.1 + 0.2, new Date(Date.UTC(1899, 11, 30, 14, 30))],
    ]);
    const rows = await readSheet(file, { ...ASN_OPTIONS, numberCells: 'excel-display' as const });
    expect(rows[0]!.values).toEqual({ asn_code: 'A-1', sku: 'KG-1', quantity: '0.3', expected_at: '14:30' });
    expect(parseExpectedAt('14:30').ok).toBe(false);
    expect(quantityToMilli(rows[0]!.values['quantity']!, 'kg', 3)).toEqual({ ok: true, milli: 300 });
  });

  it('the catalog defaults are untouched: an unknown column still refuses the file, rows are data-indexed', async () => {
    const options = { knownColumns: new Set(['a', 'b']), requiredColumns: ['a'], maxRows: 10 };
    await expect(readSheet(csv('a,b,c\n1,2,3\n'), options)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'file-unreadable', detail: 'Unknown column "c" — the header must use the documented column names.' }),
    });
    await expect(readSheet(csv('b\n1\n'), options)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'file-unreadable', detail: 'Missing required column "a" in the header row.' }),
    });
    expect(await readSheet(csv('a,b\n1,2\n\n3,4\n'), options)).toEqual([
      { rowNumber: 1, values: { a: '1', b: '2' } },
      { rowNumber: 2, values: { a: '3', b: '4' } },
    ]);
  });
});

describe('expected_at (IST)', () => {
  it.each([
    ['', null],
    ['2026-10-20', '2026-10-19T18:30:00.000Z'],
    ['2026-10-20 14:30', '2026-10-20T09:00:00.000Z'],
    ['2026-10-20 00:00', '2026-10-19T18:30:00.000Z'],
    ['2026-10-20T14:30+05:30', '2026-10-20T09:00:00.000Z'],
    ['2026-10-20T09:00:00Z', '2026-10-20T09:00:00.000Z'],
    ['2026-10-20T09:00:00.5Z', '2026-10-20T09:00:00.500Z'],
    ['2026-10-20T04:00:00-05:00', '2026-10-20T09:00:00.000Z'],
  ])('%s → %s', (text, instant) => {
    expect(parseExpectedAt(text)).toEqual({ ok: true, instant });
  });

  it.each(['46315', '20/10/2026', '10/20/2026', '2026-02-30', '2026-10-20 24:00', '2026-10-20 14:60', '2026-10-20T14:30', '2026-10-20T14:30+15:00', 'tomorrow'])(
    'refuses %s',
    (text) => {
      const result = parseExpectedAt(text);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.detail).toContain(`got "${text}"`);
    },
  );
});

describe('quantity text', () => {
  it('converts at the unit precision from the TEXT, never a float', () => {
    expect(quantityToMilli('5', 'each', 0)).toEqual({ ok: true, milli: 5000 });
    expect(quantityToMilli('5.000', 'each', 0)).toEqual({ ok: true, milli: 5000 });
    expect(quantityToMilli('2.5', 'kg', 3)).toEqual({ ok: true, milli: 2500 });
    expect(quantityToMilli('1.005', 'kg', 3)).toEqual({ ok: true, milli: 1005 });
  });

  it('refuses a fraction finer than the unit (quantity-precision) — including one a float would round away', () => {
    expect(quantityToMilli('1.5', 'each', 0)).toMatchObject({ ok: false, code: 'quantity-precision' });
    expect(quantityToMilli('0.0001', 'kg', 3)).toMatchObject({ ok: false, code: 'quantity-precision' });
    expect(quantityToMilli('1.0000000000000000001', 'kg', 3)).toMatchObject({ ok: false, code: 'quantity-precision' });
    // Typed as TEXT it is what the person wrote; an XLSX formula result
    // arrives at Excel's display precision instead (the reader test above).
    expect(quantityToMilli('0.30000000000000004', 'kg', 3)).toMatchObject({ ok: false, code: 'quantity-precision' });
  });

  it('refuses zero, a sign, an exponent, separators and anything past the ceiling (invalid-quantity)', () => {
    for (const text of ['0', '0.000', '-1', '+1', '1e3', '1,000', ' ', 'ten', '99999999999999999999']) {
      expect(quantityToMilli(text, 'each', 0)).toMatchObject({ ok: false, code: 'invalid-quantity' });
    }
  });
});

describe('rows and groups', () => {
  const base = { client: '', warehouse: '', expected_at: '' };

  it('a row without asn_code is refused on its own; blank sku / quantity and a bad date refuse the row (first failure wins)', () => {
    const { rows, errors } = readAsnImportRows([
      sheetRow(2, { ...base, asn_code: '', sku: 'S', quantity: '1' }),
      sheetRow(3, { ...base, asn_code: 'A', sku: '', quantity: '' }),
      sheetRow(4, { ...base, asn_code: 'A', sku: 'S', quantity: '' }),
      sheetRow(5, { ...base, asn_code: 'A', sku: 'S', quantity: 'x', expected_at: 'bad' }),
      sheetRow(6, { ...base, asn_code: 'A', sku: 'S', quantity: '1', expected_at: '20/10/2026' }),
      sheetRow(7, { ...base, asn_code: ' A ', sku: ' S ', quantity: ' 1 ' }),
    ]);
    expect(errors.map((e) => [e.rowNumber, e.asnCode, e.code])).toEqual([
      [2, null, 'missing-value'],
      [3, 'A', 'missing-value'],
      [4, 'A', 'missing-value'],
      [5, 'A', 'invalid-quantity'],
      [6, 'A', 'invalid-expected-at'],
    ]);
    expect(rows.map((row) => row.rowNumber)).toEqual([3, 4, 5, 6, 7]);
    expect(rows[4]).toMatchObject({ asnCode: 'A', sku: 'S', quantity: '1', expectedAt: null });
  });

  it('groups by (asn_code, client) — the same code for two clients is two ASNs; client spelling is case-insensitive', () => {
    const { rows } = readAsnImportRows([
      sheetRow(2, { ...base, asn_code: 'ASN-1', client: 'GLOWCO', sku: 'G1', quantity: '1' }),
      sheetRow(3, { ...base, asn_code: 'ASN-1', client: 'ACME', sku: 'A1', quantity: '1' }),
      sheetRow(4, { ...base, asn_code: 'ASN-1', client: 'glowco', sku: 'G2', quantity: '1' }),
      sheetRow(5, { ...base, asn_code: 'ASN-2', client: '', sku: 'G3', quantity: '1' }),
    ]);
    const groups = groupAsnImportRows(rows);
    expect(groups.map((g) => [g.asnCode, g.rows.map((r) => r.rowNumber)])).toEqual([
      ['ASN-1', [2, 4]],
      ['ASN-1', [3]],
      ['ASN-2', [5]],
    ]);
  });

  it('a blank client is the SKUs\' client: it joins the ASN naming that client and agrees; another client\'s SKU disagrees', () => {
    const { rows } = readAsnImportRows([
      sheetRow(2, { ...base, asn_code: 'MIX', client: 'GLOWCO', sku: 'G1', quantity: '1' }),
      sheetRow(3, { ...base, asn_code: 'MIX', client: '', sku: 'G2', quantity: '1' }),
      sheetRow(4, { ...base, asn_code: 'BAD', client: 'GLOWCO', sku: 'G1', quantity: '1' }),
      sheetRow(5, { ...base, asn_code: 'BAD', client: '', sku: 'A1', quantity: '1' }),
      sheetRow(6, { ...base, asn_code: 'SOLO', client: '', sku: 'G1', quantity: '1' }),
      sheetRow(7, { ...base, asn_code: 'SPAN', client: '', sku: 'G1', quantity: '1' }),
      sheetRow(8, { ...base, asn_code: 'SPAN', client: '', sku: 'A1', quantity: '1' }),
    ]);
    const skuClient: Record<string, string> = { G1: 'glowco-id', G2: 'glowco-id', A1: 'acme-id' };
    const { groups, errors } = resolveAsnGroups(
      groupAsnImportRows(rows),
      (cell) => (cell.toUpperCase() === 'GLOWCO' ? 'glowco-id' : null),
      (row) => (skuClient[row.sku] === undefined ? [] : [skuClient[row.sku]!]),
    );
    // One ASN per (client, code): MIX is ONE ASN, never two.
    expect(groups.map((g) => [g.group.asnCode, g.clientId, g.group.rows.map((r) => r.rowNumber)])).toEqual([
      ['MIX', 'glowco-id', [2, 3]],
      ['BAD', 'glowco-id', [4, 5]],
      ['SOLO', 'glowco-id', [6]],
      ['SPAN', null, [7, 8]],
    ]);
    expect(errors.map((e) => [e.rowNumber, e.asnCode, e.code])).toEqual([[5, 'BAD', 'asn-rows-disagree']]);
    expect(errors[0]!.detail).toContain('row 4\'s "GLOWCO"');
    expect(rowDisagreements(groups[0]!.group)).toEqual([]);
  });

  it('story 1-1: a code held by several clients resolves within the ASN\'s client; a blank-only ASN held by several clients is client-required', () => {
    const { rows } = readAsnImportRows([
      // SHARED is held by GLOWCO and ACME; G1 only by GLOWCO.
      sheetRow(2, { ...base, asn_code: 'NAMED', client: 'GLOWCO', sku: 'G1', quantity: '1' }),
      sheetRow(3, { ...base, asn_code: 'NAMED', client: '', sku: 'SHARED', quantity: '1' }),
      sheetRow(4, { ...base, asn_code: 'NARROW', client: '', sku: 'SHARED', quantity: '1' }),
      sheetRow(5, { ...base, asn_code: 'NARROW', client: '', sku: 'G1', quantity: '1' }),
      sheetRow(6, { ...base, asn_code: 'OPEN', client: '', sku: 'SHARED', quantity: '1' }),
    ]);
    const holders: Record<string, string[]> = { G1: ['glowco-id'], SHARED: ['acme-id', 'glowco-id'] };
    const { groups, errors } = resolveAsnGroups(
      groupAsnImportRows(rows),
      (cell) => (cell.toUpperCase() === 'GLOWCO' ? 'glowco-id' : null),
      (row) => holders[row.sku] ?? [],
    );
    expect(groups.map((g) => [g.group.asnCode, g.clientId, g.clientRequired, g.group.rows.map((r) => r.rowNumber)])).toEqual([
      // A blank row whose code the named client holds agrees — no disagreement.
      ['NAMED', 'glowco-id', false, [2, 3]],
      // Only GLOWCO holds every code: settled.
      ['NARROW', 'glowco-id', false, [4, 5]],
      // Both clients hold every code: unsettled.
      ['OPEN', null, true, [6]],
    ]);
    expect(errors).toEqual([]);
  });

  it('rows of one ASN must agree on client, warehouse and expected_at after normalising; a blank and a filled cell disagree', () => {
    const { rows } = readAsnImportRows([
      sheetRow(2, { asn_code: 'A', client: 'glowco', warehouse: 'blr-dc', expected_at: '2026-10-20', sku: 'S1', quantity: '1' }),
      sheetRow(3, { asn_code: 'A', client: 'GLOWCO', warehouse: 'BLR-DC', expected_at: '2026-10-20 00:00', sku: 'S2', quantity: '1' }),
    ]);
    expect(rowDisagreements(groupAsnImportRows(rows)[0]!)).toEqual([]);

    const split = readAsnImportRows([
      sheetRow(2, { asn_code: 'A', client: '', warehouse: 'BLR-DC', expected_at: '2026-10-20', sku: 'S1', quantity: '1' }),
      sheetRow(3, { asn_code: 'A', client: '', warehouse: '', expected_at: '', sku: 'S2', quantity: '1' }),
    ]);
    const errors = rowDisagreements(groupAsnImportRows(split.rows)[0]!);
    expect(errors.map((e) => [e.rowNumber, e.code])).toEqual([
      [3, 'asn-rows-disagree'],
      [3, 'asn-rows-disagree'],
    ]);
    expect(errors[0]!.detail).toContain('warehouse');
    expect(errors[1]!.detail).toContain('expected_at');
  });

  it('a blank warehouse is the import\'s warehouse: it agrees with a row naming that code (any case), not with another code', () => {
    const { rows } = readAsnImportRows([
      sheetRow(2, { ...base, asn_code: 'X', client: 'GLOWCO', warehouse: 'BLR-DC', sku: 'S1', quantity: '1' }),
      sheetRow(3, { ...base, asn_code: 'X', client: 'GLOWCO', warehouse: '', sku: 'S2', quantity: '1' }),
    ]);
    const group = groupAsnImportRows(rows)[0]!;
    expect(rowDisagreements(group, 'blr-dc')).toEqual([]);
    // Without the import's warehouse the cells are compared as written.
    expect(rowDisagreements(group).map((e) => [e.rowNumber, e.code])).toEqual([[3, 'asn-rows-disagree']]);
    expect(rowDisagreements(group, 'MUM-DC').map((e) => [e.rowNumber, e.code])).toEqual([[3, 'asn-rows-disagree']]);
  });

  it('a SKU repeated inside one ASN is refused on its repeat, never summed', () => {
    const { rows } = readAsnImportRows([
      sheetRow(2, { ...base, asn_code: 'A', sku: 'S1', quantity: '1' }),
      sheetRow(3, { ...base, asn_code: 'A', sku: 'S2', quantity: '1' }),
      sheetRow(4, { ...base, asn_code: 'A', sku: 'S1', quantity: '4' }),
    ]);
    const errors = repeatedSkus(groupAsnImportRows(rows)[0]!);
    expect(errors.map((e) => [e.rowNumber, e.code])).toEqual([[4, 'duplicate-sku-in-asn']]);
    expect(errors[0]!.detail).toContain('row 2');
  });

  it('caps the ASNs per import (422 import-too-large)', () => {
    expect(() => assertAsnImportCount(MAX_ASN_IMPORT_ASNS)).not.toThrow();
    expect(() => assertAsnImportCount(MAX_ASN_IMPORT_ASNS + 1)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'import-too-large' }) }));
  });
});
