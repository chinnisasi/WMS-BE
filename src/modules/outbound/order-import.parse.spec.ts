import { Workbook } from 'exceljs';
import { readSheet, type SheetRow } from '../../shared/import/sheet-reader';
import { MAX_ORDER_LINES } from './outbound.dto';
import {
  MAX_ORDER_IMPORT_LINES,
  MAX_ORDER_IMPORT_ORDERS,
  MAX_ORDER_IMPORT_ROWS,
  ORDER_IMPORT_COLUMNS,
  ORDER_IMPORT_REQUIRED_COLUMNS,
  ORDER_IMPORT_ROW_ERROR_CODES,
  SHIP_BY_REFUSAL,
  assertOrderImportCount,
  groupOrderImportRows,
  mergeOrderHeader,
  orderImportOrderKey,
  parseRupees,
  parseShipBy,
  readOrderImportRows,
  repeatedOrderSkus,
  tooManyLines,
} from './order-import.parse';

// Story 4-1c — the order import's pure half: the column contract per surface
// through the shared reader, the cells, grouping, the per-order merge and the
// derived key. No database.

const options = (surface: 'staff' | 'portal') => ({
  knownColumns: new Set<string>(ORDER_IMPORT_COLUMNS[surface]),
  requiredColumns: ORDER_IMPORT_REQUIRED_COLUMNS,
  maxRows: MAX_ORDER_IMPORT_ROWS,
  unknownColumns: 'ignore' as const,
  rowNumbers: 'sheet' as const,
  missingColumns: 'all' as const,
  dateCells: 'ist-wall-clock' as const,
  numberCells: 'excel-display' as const,
});

const HEADER = 'order_ref,client,sku,quantity,rate,ship_to_name,ship_to_phone,ship_to_line1,ship_to_line2,ship_to_city,ship_to_state,ship_to_pincode,order_type,priority,ship_by,cod_amount';
const ADDRESS = 'Priya,9845012345,12 MG Road,,Pune,Maharashtra,411001';

async function csv(lines: string[], surface: 'staff' | 'portal' = 'staff'): Promise<SheetRow[]> {
  return readSheet({ name: 'orders.csv', mimetype: 'text/csv', buffer: Buffer.from([HEADER, ...lines].join('\n'), 'utf8'), size: 1 }, options(surface));
}

describe('order import parse (story 4-1c)', () => {
  it('the caps and the line cap equal the create’s', () => {
    expect([MAX_ORDER_IMPORT_ROWS, MAX_ORDER_IMPORT_ORDERS, MAX_ORDER_IMPORT_LINES]).toEqual([300, 100, 200]);
    expect(MAX_ORDER_IMPORT_LINES).toBe(MAX_ORDER_LINES);
    expect(() => assertOrderImportCount(100)).not.toThrow();
    expect(() => assertOrderImportCount(101)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'import-too-large' }) }));
  });

  it('the portal surface reads no client and no rate column; both surfaces require the address columns', async () => {
    expect(ORDER_IMPORT_COLUMNS.portal).not.toContain('client');
    expect(ORDER_IMPORT_COLUMNS.portal).not.toContain('rate');
    expect(ORDER_IMPORT_COLUMNS.staff).toEqual(expect.arrayContaining(['client', 'rate']));
    expect(ORDER_IMPORT_REQUIRED_COLUMNS).toEqual([
      'sku',
      'quantity',
      'order_ref',
      'ship_to_name',
      'ship_to_phone',
      'ship_to_line1',
      'ship_to_city',
      'ship_to_state',
      'ship_to_pincode',
    ]);
    const portal = await csv([`SO-1,ACME,A-1,2,99,${ADDRESS},,,,`], 'portal');
    expect(Object.keys(portal[0]!.values)).not.toContain('client');
    const read = readOrderImportRows(portal, 'portal');
    expect(read.rows[0]!.client).toBe('');
    expect(read.rows[0]!.ratePaise).toBeNull();
    await expect(
      readSheet({ name: 'o.csv', mimetype: 'text/csv', buffer: Buffer.from('order_ref,sku,quantity\nSO-1,A,1', 'utf8'), size: 1 }, options('staff')),
    ).rejects.toMatchObject({ response: { code: 'missing-columns' } });
  });

  it('the vocabulary is closed and duplicate-free', () => {
    expect(new Set(ORDER_IMPORT_ROW_ERROR_CODES).size).toBe(ORDER_IMPORT_ROW_ERROR_CODES.length);
    expect(ORDER_IMPORT_ROW_ERROR_CODES).toEqual(expect.arrayContaining(['order-changed-since-first-run', 'order-refused', 'too-many-lines', 'duplicate-order-in-file']));
  });

  it('cells: ship_by grammar (A7), rupees, the first refusal per row wins', async () => {
    expect(parseShipBy('2026-10-30')).toEqual({ ok: true, date: '2026-10-30' });
    expect(parseShipBy('2026-10-30T00:00:00.000+05:30')).toEqual({ ok: true, date: '2026-10-30' });
    expect(parseShipBy('')).toEqual({ ok: true, date: null });
    for (const bad of ['30/10/2026', '10/30/2026', '2026-02-30', '2026-10-30T09:00:00.000+05:30', '46315']) {
      const parsed = parseShipBy(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.detail).toContain(SHIP_BY_REFUSAL);
    }
    expect([parseRupees('499'), parseRupees('499.5'), parseRupees('499.05'), parseRupees('0')]).toEqual([49_900, 49_950, 49_905, 0]);
    expect([parseRupees('-1'), parseRupees('1.234'), parseRupees('1e3'), parseRupees('1,000')]).toEqual([null, null, null, null]);

    const rows = await csv([
      ` SO-1 ,,A-1,2,99.50,${ADDRESS},B2B,Urgent,2026-10-30,1499`,
      `SO-2,,,2,,${ADDRESS},,,,`,
      `SO-3,,A-1,,,${ADDRESS},,,,`,
      `SO-4,,A-1,two,,${ADDRESS},,,,`,
      `SO-5,,A-1,2,9.999,${ADDRESS},,,,`,
      `SO-6,,A-1,2,,${ADDRESS},,,,12.345`,
      `SO-7,,A-1,2,,${ADDRESS},,,30/10/2026,`,
      `   ,,A-1,2,,${ADDRESS},,,,`,
      `SO-8,,A-1,two,bad,${ADDRESS},,,30/10/2026,x`,
    ]);
    const read = readOrderImportRows(rows, 'staff');
    expect(read.errors.map((error) => [error.rowNumber, error.orderRef, error.code])).toEqual([
      [3, 'SO-2', 'missing-value'],
      [4, 'SO-3', 'missing-value'],
      [5, 'SO-4', 'invalid-quantity'],
      [6, 'SO-5', 'invalid-rate'],
      [7, 'SO-6', 'invalid-cod-amount'],
      [8, 'SO-7', 'invalid-ship-by'],
      [9, null, 'missing-value'],
      [10, 'SO-8', 'invalid-quantity'],
    ]);
    // A4 — the ref is trimmed before grouping; the row with a blank ref joins no order.
    expect(read.rows.map((row) => row.orderRef)).toEqual(['SO-1', 'SO-2', 'SO-3', 'SO-4', 'SO-5', 'SO-6', 'SO-7', 'SO-8']);
    expect(read.rows[0]!.ratePaise).toBe(9_950);
    expect(read.rows.find((row) => row.orderRef === 'SO-5')!.ratePaise).toBeUndefined();
  });

  it('XLSX cells: a date cell is the IST day, a numeric pincode its digits (A8)', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('orders');
    sheet.addRow(HEADER.split(','));
    sheet.addRow(['SO-1', '', 'A-1', 2, '', 'Priya', '9845012345', '12 MG Road', '', 'Pune', 'Maharashtra', 411001, '', '', new Date(Date.UTC(2026, 9, 30)), 1499.5]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const rows = await readSheet({ name: 'o.xlsx', mimetype: 'application/octet-stream', buffer, size: buffer.length }, options('staff'));
    const read = readOrderImportRows(rows, 'staff');
    expect(read.errors).toEqual([]);
    const merged = mergeOrderHeader(groupOrderImportRows(read.rows)[0]!);
    expect(merged.errors).toEqual([]);
    expect(merged.header).toMatchObject({ shipToPincode: '411001', shipBy: '2026-10-30', codAmountPaise: 149_950 });
  });

  it('grouping: (client cell case-insensitive, ref exact) in first-row order; a blank client is its own group (decision 9)', async () => {
    const rows = readOrderImportRows(
      await csv([
        `SO-2,acme,A-1,1,,${ADDRESS},,,,`,
        `SO-1,,A-1,1,,${ADDRESS},,,,`,
        `SO-2,ACME,A-2,1,,${ADDRESS},,,,`,
        `SO-1,ACME,A-3,1,,${ADDRESS},,,,`,
        `so-1,,A-4,1,,${ADDRESS},,,,`,
        `SO-1 ,,A-5,1,,${ADDRESS},,,,`,
      ]),
      'staff',
    ).rows;
    const groups = groupOrderImportRows(rows);
    expect(groups.map((group) => [group.client, group.orderRef, group.rows.map((row) => row.rowNumber)])).toEqual([
      ['acme', 'SO-2', [2, 4]],
      ['', 'SO-1', [3, 7]],
      ['ACME', 'SO-1', [5]],
      ['', 'so-1', [6]],
    ]);
  });

  it('per-order cells: blank after the first takes the first; a second value disagrees on the later row; a required one blank everywhere is missing (decision 8, A5)', async () => {
    const groups = groupOrderImportRows(
      readOrderImportRows(
        await csv([
          `SO-1,,A-1,1,,Priya,9845012345,12 MG Road,,Pune,Maharashtra,411001,B2B,Urgent,2026-10-30,1499`,
          `SO-1,,A-2,1,,,,,,,,,b2b,URGENT,2026-10-30,1499.00`,
          `SO-2,,A-1,1,,Ravi,1,Line,,Pune,MH,411001,,,,`,
          `SO-2,,A-2,1,,Ravi,1,Line,,Mumbai,MH,411001,,,,`,
          `SO-3,,A-1,1,,Ravi,1,Line,,Pune,MH,,,,,`,
        ]),
        'staff',
      ).rows,
    );
    const [one, two, three] = groups.map(mergeOrderHeader);
    expect(one!.errors).toEqual([]);
    expect(one!.header).toEqual({
      shipToName: 'Priya',
      shipToPhone: '9845012345',
      shipToLine1: '12 MG Road',
      shipToLine2: null,
      shipToCity: 'Pune',
      shipToState: 'Maharashtra',
      shipToPincode: '411001',
      consigneeGstin: null,
      consigneeLegalName: null,
      orderType: 'b2b',
      priority: 'urgent',
      shipBy: '2026-10-30',
      codAmountPaise: 149_900,
    });
    expect(two!.errors.map((error) => [error.rowNumber, error.code])).toEqual([[5, 'order-rows-disagree']]);
    expect(two!.errors[0]!.detail).toContain('ship_to_city is "Mumbai" but row 4');
    expect(three!.errors.map((error) => [error.rowNumber, error.code, error.detail.split(' ')[0]])).toEqual([[6, 'missing-value', 'ship_to_pincode']]);
  });

  it('a repeated SKU is refused on its repeat; an order over 200 lines is too-many-lines on its first row', async () => {
    const [group] = groupOrderImportRows(readOrderImportRows(await csv([`SO-1,,A-1,1,,${ADDRESS},,,,`, `SO-1,,A-1,2,,,,,,,,,,,,`]), 'staff').rows);
    expect(repeatedOrderSkus(group!).map((error) => [error.rowNumber, error.code])).toEqual([[3, 'duplicate-sku-in-order']]);
    const many = groupOrderImportRows(
      readOrderImportRows(await csv(Array.from({ length: 201 }, (_, i) => `SO-9,,S-${i},1,,${ADDRESS},,,,`)), 'staff').rows,
    )[0]!;
    expect(tooManyLines(many)).toMatchObject({ rowNumber: 2, code: 'too-many-lines' });
    expect(tooManyLines({ ...many, rows: many.rows.slice(0, 200) })).toBeNull();
  });

  it('the derived key: deterministic, ULID-shaped, never the import key, different per surface, file, warehouse, client and ref (decision 3, A2) — golden', () => {
    const importKey = '01JBCDEFGHJKMNPQRSTVWXYZ01';
    const parts = { surface: 'staff' as const, fileSha256: 'a'.repeat(64), warehouseId: '0190aaaa-0000-7000-8000-000000000001', client: 'ACME', orderRef: 'SO-1' };
    const key = orderImportOrderKey(importKey, parts);
    expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(key.slice(0, 10)).toBe(importKey.slice(0, 10));
    expect(key).not.toBe(importKey);
    expect(orderImportOrderKey(importKey, parts)).toBe(key);
    // The client cell is upper-cased (the grouping's own case rule).
    expect(orderImportOrderKey(importKey, { ...parts, client: 'acme' })).toBe(key);
    const variants = [
      { ...parts, surface: 'portal' as const },
      { ...parts, fileSha256: 'b'.repeat(64) },
      { ...parts, warehouseId: '0190aaaa-0000-7000-8000-000000000002' },
      { ...parts, client: '' },
      { ...parts, orderRef: 'SO-2' },
    ].map((variant) => orderImportOrderKey(importKey, variant));
    expect(new Set([key, ...variants]).size).toBe(6);
    expect(orderImportOrderKey('01JBCDEFGHJKMNPQRSTVWXYZ02', parts)).not.toBe(key);
    // The golden: the exact derivation, so a change to it is a decision, never a side effect.
    expect(key).toBe(GOLDEN_KEY);
  });
});

/** `orderImportOrderKey('01JBCDEFGHJKMNPQRSTVWXYZ01', {staff, 'a'×64, …0001, ACME, SO-1})`. */
const GOLDEN_KEY = '01JBCDEFGH1YBS2P58PGQSJ3Q5';
