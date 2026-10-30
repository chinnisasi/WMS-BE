import { pdfPagesText } from '../../../test/support/pdf-text';
import { readPdfLabels } from '../../../test/support/labels';
import { A4_HEIGHT_PT, A4_WIDTH_PT } from './a4-pdf';
import {
  LOADING_SHEET_COLUMNS,
  LOADING_SHEET_FOOTER_TOP,
  layoutLoadingSheet,
  loadingOrder,
  loadingSheetFileName,
  partBLine,
  renderLoadingSheetPdf,
  type LoadingSheetModel,
  type LoadingSheetRow,
} from './loading-sheet.layout';

/**
 * Story 4-9a (A25) — the loading sheet: landscape A4, rows in loading order
 * (last stop first), the plan band on an open load, "Dispatched" after, the
 * Part B and capacity lines, never a phone, a footer with the signature lines
 * on every page, and 100 consignments paginated with the header repeated.
 */

function row(stopSeq: number, over: Partial<LoadingSheetRow> = {}): LoadingSheetRow {
  return {
    stopSeq,
    clientCode: stopSeq % 2 === 0 ? 'BETA' : 'ACME',
    orderLabel: `SO-${stopSeq}`,
    consigneeName: `Consignee ${stopSeq}`,
    city: 'Pune',
    pincode: '411001',
    lrNumber: `4410${stopSeq}`,
    invoiceNumber: `INV/${stopSeq}`,
    ewayBillNumber: '123456789012',
    ewayValidUntil: '2026-11-01',
    cartons: 2,
    pallets: 15,
    weightGrams: 9_840_000,
    loaded: 17,
    total: 17,
    ...over,
  };
}

function model(over: Partial<LoadingSheetModel> = {}): LoadingSheetModel {
  return {
    loadCode: 'LD-0007',
    mode: 'ltl',
    status: 'dispatched',
    printedAt: '2026-10-30T11:00:00.000Z',
    dispatchedAt: '2026-10-30T10:35:00.000Z',
    warehouse: { code: 'BLR1', name: 'Main DC', gstin: '29ABCDE1234F1Z5', addressLines: ['1 Road, Hoskote, Bengaluru, Karnataka 562114'] },
    transporter: { name: 'VRL Logistics', gstin: '29AABCV1234F1Z5', addressLines: ['Hubballi 580030'] },
    vehicle: { number: 'KA01AB1234', type: 'hcv', containerNumber: null, capacityKg: 20_000 },
    driver: { name: 'Ravi', licenceNumber: 'KA0120190001234' },
    dockDoor: 'D-3',
    seals: ['S-991', 'S-992'],
    partB: { required: true, confirmedByName: 'Asha' },
    capacityExceeded: false,
    capacityAcknowledgedByName: null,
    rows: [row(1), row(2, { weightGrams: null, loaded: 5, total: 6, pallets: 0, cartons: 6, lrNumber: null })],
    totals: { consignments: 2, cartons: 8, pallets: 15, loaded: 22, packages: 23, grossWeightGrams: null },
    ...over,
  };
}

const texts = (pages: ReturnType<typeof layoutLoadingSheet>, page = 0) => pages[page]!.runs.map((run) => run.text);

describe('story 4-9a — the loading sheet (A25)', () => {
  it('golden: a dispatched two-stop LTL sheet, its runs folded and in drawing order', () => {
    const pages = layoutLoadingSheet(model());
    expect(pages).toHaveLength(1);
    expect(pages[0]!.landscape).toBe(true);
    expect(texts(pages)).toEqual([
      'Loading sheet',
      'LD-0007',
      'LTL (part load) · Printed 2026-10-30 16:30 IST',
      'Dispatched 2026-10-30 16:05 IST',
      'From',
      'Main DC (BLR1)',
      'GSTIN 29ABCDE1234F1Z5',
      '1 Road, Hoskote, Bengaluru, Karnataka 562114',
      'Transporter',
      'VRL Logistics',
      'GSTIN 29AABCV1234F1Z5',
      'Hubballi 580030',
      'Vehicle',
      'KA01AB1234',
      'Type hcv',
      'Capacity 20,000 kg',
      'Driver and dock',
      'Ravi',
      'Licence KA0120190001234',
      'Dock D-3',
      'Seals S-991, S-992',
      'E-way bills updated with vehicle KA01AB1234 (Part B): confirmed by Asha',
      'Load from the bottom up: last stop first.',
      'Consignments',
      'Stop',
      'Client',
      'Order',
      'Consignee',
      'City / PIN',
      'LR',
      'Invoice',
      'E-way bill / valid until',
      'Cartons',
      'Pallets',
      'Weight',
      'Loaded',
      'Check',
      '2',
      'BETA',
      'SO-2',
      'Consignee 2',
      'Pune 411001',
      'INV/2',
      '123456789012 /',
      '2026-11-01',
      '6',
      '0',
      '5/6',
      '[ ]',
      '1',
      'ACME',
      'SO-1',
      'Consignee 1',
      'Pune 411001',
      '44101',
      'INV/1',
      '123456789012 /',
      '2026-11-01',
      '2',
      '15',
      '9,840 kg',
      '17/17',
      '[ ]',
      'Consignments 2 · Packages 23 (8 cartons, 15 pallets) · Loaded 22 of 23 · Gross weight not known (a consignment is unweighed) · Capacity 20,000 kg',
      'Received the above packages in good order, sealed as stated.',
      'Loading supervisor — signature, name, date',
      'Driver — signature, name, date',
      'LD-0007 · Printed 2026-10-30 16:30 IST',
      'Page 1 of 1',
    ]);
    // The header barcode; no fill on a dispatched sheet.
    expect(pages[0]!.barcodes).toHaveLength(1);
    expect(pages[0]!.barcodes![0]!.payload).toBe('LD-0007');
    expect(pages[0]!.fills).toBeUndefined();
  });

  it('an open load prints the reversed PLAN band (white text on a fill), not "Dispatched"', () => {
    const pages = layoutLoadingSheet(model({ status: 'open', dispatchedAt: null, partB: { required: true, confirmedByName: null } }));
    const band = pages[0]!.runs.find((run) => run.text.startsWith('PLAN'));
    expect(band).toMatchObject({ text: 'PLAN — not dispatched, printed 2026-10-30 16:30 IST', color: 'white', font: 'bold' });
    expect(pages[0]!.fills).toHaveLength(1);
    const fill = pages[0]!.fills![0]!;
    expect(band!.y).toBeGreaterThan(fill.y);
    expect(band!.y).toBeLessThan(fill.y + fill.h);
    expect(texts(pages).some((text) => text.startsWith('Dispatched'))).toBe(false);
    expect(texts(pages)).toContain('E-way bills updated with vehicle KA01AB1234 (Part B): not confirmed');
  });

  it('Part B prints only when an order carries an e-way bill; over capacity prints its acknowledgement and the warning', () => {
    expect(partBLine({ vehicle: model().vehicle, partB: { required: false, confirmedByName: null } })).toBeNull();
    const t = texts(
      layoutLoadingSheet(
        model({ capacityExceeded: true, capacityAcknowledgedByName: 'Asha', totals: { consignments: 2, cartons: 8, pallets: 15, loaded: 22, packages: 23, grossWeightGrams: 21_000_000 } }),
      ),
    );
    expect(t).toContain('Over the stated capacity — acknowledged by Asha');
    expect(t).toContain('Over capacity: the gross weight is above the vehicle’s stated capacity.');
  });

  it('never prints a phone: the model carries none, and no run reads like one', () => {
    const t = texts(layoutLoadingSheet(model())).join(' ');
    expect(t).not.toMatch(/\+?91\d{10}|Ph(one)? /);
    expect(Object.keys(model().driver).sort()).toEqual(['licenceNumber', 'name']);
  });

  it('loadingOrder is the reverse of the stop order (gaps allowed)', () => {
    expect(loadingOrder([row(1), row(4), row(2)]).map((r) => r.stopSeq)).toEqual([4, 2, 1]);
  });

  it('the columns fill the landscape content width exactly', () => {
    const width = LOADING_SHEET_COLUMNS.reduce((sum, column) => sum + column.width, 0);
    expect(width).toBeCloseTo(A4_HEIGHT_PT - 60, 2);
  });

  it('worst case: 100 consignments paginate — the header and column header repeat, no row crosses the footer, "Page n of m" on each', () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row(i + 1, { consigneeName: `A very long consignee legal name number ${i + 1} Private Limited, Unit 4`, orderLabel: `SO-2026-${String(i + 1).padStart(5, '0')}-BO2` }),
    );
    const pages = layoutLoadingSheet(model({ rows, totals: { consignments: 100, cartons: 200, pallets: 1500, loaded: 1700, packages: 1700, grossWeightGrams: 984_000_000 } }));
    expect(pages.length).toBeGreaterThan(2);
    pages.forEach((page, index) => {
      const t = page.runs.map((run) => run.text);
      expect(t[0]).toBe('Loading sheet');
      expect(t).toContain(`Page ${index + 1} of ${pages.length}`);
      expect(t).toContain('Driver — signature, name, date');
      expect(page.barcodes?.[0]?.payload).toBe('LD-0007');
      if (index > 0) expect(t).toContain('Consignments (continued)');
      // Content above the footer line (the footer runs sit below it).
      const footerTexts = new Set(['Received the above packages in good order, sealed as stated.', 'Loading supervisor — signature, name, date', 'Driver — signature, name, date', `Page ${index + 1} of ${pages.length}`, 'LD-0007 · Printed 2026-10-30 16:30 IST']);
      for (const run of page.runs) if (!footerTexts.has(run.text)) expect(run.y).toBeGreaterThanOrEqual(LOADING_SHEET_FOOTER_TOP);
      for (const run of page.runs) expect(run.x + 1).toBeLessThan(A4_HEIGHT_PT);
    });
    // Every order printed once, last stop first.
    const orders = pages.flatMap((page) => page.runs.map((run) => run.text)).filter((text) => /^SO-2026-\d{5}-BO2$/.test(text));
    expect(orders).toHaveLength(100);
    expect(orders[0]).toBe('SO-2026-00100-BO2');
    expect(orders[99]).toBe('SO-2026-00001-BO2');
  });

  it('renders a landscape PDF whose text and barcode a reader recovers; same instant → same bytes', async () => {
    const pdf = await renderLoadingSheetPdf(model({ status: 'open', dispatchedAt: null }));
    const labels = await readPdfLabels(pdf);
    expect(labels[0]!.width).toBeCloseTo(A4_HEIGHT_PT, 1);
    expect(labels[0]!.height).toBeCloseTo(A4_WIDTH_PT, 1);
    expect(labels[0]!.payloads).toEqual(['LD-0007']);
    const pageTexts = await pdfPagesText(pdf);
    expect(pageTexts[0]).toContain('PLAN — not dispatched, printed 2026-10-30 16:30 IST');
    expect(Buffer.compare(pdf, await renderLoadingSheetPdf(model({ status: 'open', dispatchedAt: null })))).toBe(0);
    expect(loadingSheetFileName('LD-0007')).toBe('LD-0007-loading-sheet.pdf');
  });
});
