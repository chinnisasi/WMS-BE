import { createHash } from 'node:crypto';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { drawDocumentPdf, type DocumentPage } from '../../shared/documents/a4-pdf';
import { renderShippingLabelsZpl } from '../../shared/labels/shipping/zpl';
import { pdfPagesText } from '../../../test/support/pdf-text';
import { parseZplLabels, readPdfLabels, zplTexts } from '../../../test/support/labels';
import type { PackDocument, PackDocumentLine } from './pack-documents.read';
import { SLIP_FOOTER_TOP, SLIP_PARTIES_LIVE, fittedList, layoutPackingSlip, packDocumentFileStem, shortfallSentence } from './packing-slip.layout';
import { assertThermalSlipPrintFits, cartonLabelsOf, packingSlipPdf, parsePackFileQuery, thermalSlipsOf } from './pack-documents.service';

/**
 * Story 4-5a (A17, A18, A35, A36, A48) — the packing slip's layout, golden per
 * audience, and the label/slip builders over the same model: the staff copy
 * prints the parcel-tag barcode, the carton codes, the cases and the packer;
 * the client copy (portal, email) none of them; kit parents are headings,
 * never short; the shortfall is named only once the follow-on exists; the
 * footer on every page says it is not a tax invoice.
 */

const ORDER_ID = '01a18ba8-4743-79dd-8fe5-145b99902272';
const TAG = 'O8FE5145B99902272';

function line(n: number, over: Partial<PackDocumentLine> = {}): PackDocumentLine {
  return {
    lineNo: n,
    kind: 'line',
    skuId: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    skuCode: `SKU-${n}`,
    skuName: `Item ${n}`,
    uom: 'EA',
    ordered: '10',
    packed: '10',
    short: '0',
    shortMilli: 0,
    batches: [],
    moreBatches: 0,
    serials: [],
    moreSerials: 0,
    ...over,
  };
}

function doc(over: Partial<PackDocument> = {}): PackDocument {
  return {
    orderId: ORDER_ID,
    orderLabel: 'SO-1',
    parcelTag: TAG,
    clientOrderRef: 'SO-1',
    channelRef: null,
    orderType: 'b2b',
    orderStatus: 'ready_to_dispatch',
    orderedAt: '2026-10-29T04:00:00.000Z',
    payment: { kind: 'cod', amountPaise: 125000 },
    packSeq: 1,
    legacy: false,
    packedAt: '2026-10-30T05:00:00.000Z',
    repackedAt: null,
    packerName: 'ravi.kumar',
    printedAt: '2026-10-30T06:00:00.000Z',
    partiesFrozen: true,
    partiesAsAt: null,
    client: {
      v: 1,
      code: 'ACME',
      name: 'Acme Brands',
      legalName: 'Acme Brands Private Limited',
      gstin: '29AAACA1234A1Z5',
      registeredAddress: { line1: '1 MG Road', line2: null, city: 'Bengaluru', stateCode: '29', pincode: '560001' },
    },
    warehouse: {
      code: 'BLR1',
      name: 'Main DC',
      gstin: '29AAACW1234A1Z5',
      address: { line1: 'Plot 7', line2: null, city: 'Bengaluru', state: 'Karnataka', pincode: '562123' },
    },
    consignee: {
      contactName: 'Ravi Kumar',
      legalName: 'Kumar Traders LLP',
      line1: '12, 3rd Cross',
      line2: 'Indiranagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560038',
      phone: '9876543210',
      gstin: '29ABCDE1234F1Z5',
    },
    shipment: { courierName: 'Delhivery', awb: '123456789012' },
    cartonCount: 2,
    grossWeightGrams: 6000,
    cartons: [
      {
        seq: 1,
        code: `${TAG}.1.1`,
        weightGrams: 3200,
        dimensionsMm: { lengthMm: 400, widthMm: 300, heightMm: 200 },
        lines: [{ skuId: 'a', skuCode: 'SKU-1', skuName: 'Item 1', uom: 'EA', qty: 6, qtyText: '6', handlingUnitIds: null }],
        totals: '6 EA',
      },
      {
        seq: 2,
        code: `${TAG}.1.2`,
        weightGrams: 2800,
        dimensionsMm: null,
        lines: [
          { skuId: 'a', skuCode: 'SKU-1', skuName: 'Item 1', uom: 'EA', qty: 4, qtyText: '4', handlingUnitIds: null },
          { skuId: 'b', skuCode: 'SKU-2', skuName: 'Item 2', uom: 'KG', qty: 2.5, qtyText: '2.500', handlingUnitIds: ['0190aaaa-0000-7000-8000-000000000001'] },
        ],
        totals: '4 EA, 2.500 KG',
      },
    ],
    lines: [
      line(1, { batches: [{ code: 'B-001', expiryDate: '2027-03-31' }] }),
      line(2, { uom: 'KG', ordered: '2.500', packed: '2.500', serials: ['S1', 'S2'] }),
    ],
    totals: '10 EA, 2.500 KG',
    shortfall: { kind: 'none' },
    annotations: [],
    ...over,
  };
}

const textsOf = (pages: readonly DocumentPage[]) => pages.map((page) => page.runs.map((run) => run.text));
const allText = (pages: readonly DocumentPage[]) => textsOf(pages).flat().join('\n');
const hashOf = (pages: readonly DocumentPage[]) => createHash('sha256').update(JSON.stringify(pages)).digest('hex');

describe('layoutPackingSlip (A17, A35)', () => {
  it('the staff copy prints the parcel tag barcode, the carton codes, the cases and the packer', () => {
    const pages = layoutPackingSlip(doc(), { audience: 'staff' });
    const text = allText(pages);
    expect(text).toContain('Packing slip');
    expect(text).toContain(TAG);
    expect(text).toContain(`${TAG}.1.2`);
    expect(text).toContain('Packed by ravi.kumar');
    expect(text).toContain('Cases (SKU-2): 0190aaaa-0000-7000-8000-000000000001');
    expect(pages[0]!.barcodes?.map((barcode) => barcode.payload)).toEqual([TAG]);
  });

  it('the client copy prints none of them (A35) — the same model, the same parties', () => {
    const pages = layoutPackingSlip(doc(), { audience: 'client' });
    const text = allText(pages);
    expect(text).not.toContain(TAG);
    expect(text).not.toContain('Packed by');
    expect(text).not.toContain('Cases');
    expect(text).not.toContain('0190aaaa');
    expect(pages.every((page) => page.barcodes === undefined)).toBe(true);
    expect(text).toContain('Carton 2 of 2 — 2.80 kg');
    expect(text).toContain('Carton 1 of 2 — 3.20 kg — 40 x 30 x 20 cm');
  });

  it('prints the parties (brand, warehouse, consignee with GSTIN), the batches, the serials, the payment, the courier — and no phone', () => {
    const text = allText(layoutPackingSlip(doc(), { audience: 'client' }));
    for (const expected of ['Shipper (brand)', 'Acme Brands Private Limited', 'GSTIN 29AAACA1234A1Z5', 'Shipped from', 'Main DC (BLR1)', 'Ship to', 'Kumar Traders LLP', 'GSTIN 29ABCDE1234F1Z5', 'PIN 560038']) {
      expect(text).toContain(expected);
    }
    expect(text).toContain('Batch B-001 exp 2027-03-31');
    expect(text).toContain('Serials: S1, S2');
    expect(text).toContain('Payment COD Rs 1,250.00');
    expect(text).toContain('Courier Delhivery · AWB 123456789012');
    expect(text).toContain('Packed 10 EA, 2.500 KG');
    expect(text).not.toContain('9876543210');
  });

  it('every page carries the header, the not-a-tax-invoice notice naming the brand, and "Page n of m"; no body run crosses the footer; a broken table says (continued)', () => {
    const many = Array.from({ length: 120 }, (_, i) => line(i + 1, { skuName: `A rather long item description number ${i + 1} that wraps`, batches: [{ code: `B-${i}`, expiryDate: null }] }));
    const pages = layoutPackingSlip(doc({ lines: many }), { audience: 'staff' });
    expect(pages.length).toBeGreaterThan(2);
    pages.forEach((page, index) => {
      const texts = page.runs.map((run) => run.text);
      expect(texts[0]).toBe('Packing slip');
      expect(texts).toContain('This is not a tax invoice. Tax documents are issued by Acme Brands Private Limited.');
      expect(texts).toContain(`Page ${index + 1} of ${pages.length}`);
      const footerTexts = new Set(['This is not a tax invoice. Tax documents are issued by Acme Brands Private Limited.', `Page ${index + 1} of ${pages.length}`]);
      for (const run of page.runs) {
        if (footerTexts.has(run.text) || run.text.startsWith('SO-1 · Printed')) continue;
        expect(run.y).toBeGreaterThanOrEqual(SLIP_FOOTER_TOP);
      }
    });
    expect(allText(pages)).toContain('Items (continued)');
  });

  it('the issuer falls back to the brand name when it has no legal name', () => {
    const base = doc();
    const text = allText(layoutPackingSlip(doc({ client: { ...base.client, legalName: null } }), { audience: 'client' }));
    expect(text).toContain('This is not a tax invoice. Tax documents are issued by Acme Brands.');
  });

  it('a kit parent is a heading with no packed or short figure; its components follow (A36)', () => {
    const pages = layoutPackingSlip(
      doc({
        lines: [
          line(1, { kind: 'kit', skuCode: 'KIT-1', skuName: 'Gift box', ordered: '2', packed: null, short: null }),
          line(2, { kind: 'component', skuCode: 'C-1', skuName: 'Mug' }),
          line(3, { kind: 'component', skuCode: 'C-2', skuName: 'Spoon' }),
        ],
      }),
      { audience: 'client' },
    );
    const runs = pages[0]!.runs;
    const kitRow = runs.find((run) => run.text === 'Kit: Gift box')!;
    const sameRow = runs.filter((run) => Math.abs(run.y - kitRow.y) < 0.01).map((run) => run.text);
    expect(sameRow).toEqual(['1', 'KIT-1', 'Kit: Gift box', 'EA', '2']);
    expect(allText(pages)).toContain('> C-1');
    expect(allText(pages)).not.toMatch(/short:/);
  });

  it('a short order before dispatch says items follow separately; after dispatch it names the follow-on (A36)', () => {
    const shortLines = [line(1, { packed: '6', short: '4', shortMilli: 4000 })];
    const before = doc({ lines: shortLines, shortfall: { kind: 'pending', totals: '4 EA' } });
    const after = doc({ lines: shortLines, orderStatus: 'dispatched', shortfall: { kind: 'follow-on', totals: '4 EA', followOnLabel: 'SO-1-BO1' } });
    expect(shortfallSentence(before)).toBe('Items not in this shipment will follow separately (short: 4 EA).');
    expect(shortfallSentence(after)).toBe('4 EA on backorder will follow as order SO-1-BO1.');
    expect(allText(layoutPackingSlip(before, { audience: 'staff' }))).toContain('Items not in this shipment will follow separately');
    expect(allText(layoutPackingSlip(after, { audience: 'client' }))).toContain('will follow as order SO-1-BO1');
    // Review: dispatched short with no live follow-on (below the minimum, a partial kit, or cancelled) — never promised.
    const none = doc({ lines: shortLines, orderStatus: 'dispatched', shortfall: { kind: 'not-shipped', totals: '4 EA' } });
    expect(shortfallSentence(none)).toBe('4 EA were not shipped.');
    const noneText = allText(layoutPackingSlip(none, { audience: 'client' }));
    expect(noneText).toContain('4 EA were not shipped.');
    expect(noneText).not.toContain('will follow');
    expect(allText(layoutPackingSlip(before, { audience: 'staff' }))).not.toContain('SO-1-BO1');
  });

  it('a legacy pack prints the live-parties note; a re-carton prints Re-packed and, when frozen later, the as-at date', () => {
    expect(allText(layoutPackingSlip(doc({ partiesFrozen: false, legacy: true }), { audience: 'staff' }))).toContain(SLIP_PARTIES_LIVE);
    const text = allText(layoutPackingSlip(doc({ packSeq: 2, repackedAt: '2026-10-30T07:30:00.000Z', partiesAsAt: '2026-10-30T07:30:00.000Z' }), { audience: 'staff' }));
    expect(text).toContain('Re-packed 2026-10-30 13:00 IST');
    expect(text).toContain('Party details as at 2026-10-30.');
    expect(allText(layoutPackingSlip(doc(), { audience: 'staff' }))).not.toContain(SLIP_PARTIES_LIVE);
  });

  it('a warehouse with no address prints "—" (A45)', () => {
    const base = doc();
    const text = allText(layoutPackingSlip(doc({ warehouse: { ...base.warehouse, address: null } }), { audience: 'client' }));
    expect(textsOf(layoutPackingSlip(doc({ warehouse: { ...base.warehouse, address: null } }), { audience: 'client' }))[0]).toContain('—');
    expect(text).toContain('Main DC (BLR1)');
  });

  it('goldens: the layout per audience is pinned (a change here is a visible document change)', () => {
    expect(hashOf(layoutPackingSlip(doc(), { audience: 'staff' }))).toBe(STAFF_GOLDEN);
    expect(hashOf(layoutPackingSlip(doc(), { audience: 'client' }))).toBe(CLIENT_GOLDEN);
    const kit = doc({
      lines: [line(1, { kind: 'kit', skuCode: 'KIT-1', skuName: 'Gift box', ordered: '2', packed: null, short: null }), line(2, { kind: 'component', skuCode: 'C-1', skuName: 'Mug', packed: '1', short: '1', shortMilli: 1000 })],
      shortfall: { kind: 'pending', totals: '1 EA' },
    });
    expect(hashOf(layoutPackingSlip(kit, { audience: 'staff' }))).toBe(KIT_SHORT_BEFORE_GOLDEN);
    expect(hashOf(layoutPackingSlip({ ...kit, orderStatus: 'dispatched', shortfall: { kind: 'follow-on', totals: '1 EA', followOnLabel: 'SO-1-BO1' } }, { audience: 'client' }))).toBe(
      KIT_SHORT_AFTER_GOLDEN,
    );
  });
});

describe('the drawn files', () => {
  it('the staff PDF decodes its parcel-tag barcode, the client PDF draws no code; a fixed print instant gives identical bytes', async () => {
    const staff = await packingSlipPdf(doc(), 'staff');
    const client = await packingSlipPdf(doc(), 'client');
    expect(staff.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await readPdfLabels(staff))[0]!.payloads).toEqual([TAG]);
    expect((await readPdfLabels(client))[0]!.payloads).toEqual([]);
    const clientText = (await pdfPagesText(client)).flat().join('\n');
    expect(clientText).not.toContain(TAG);
    expect(clientText).toContain('This is not a tax invoice.');
    expect(Buffer.compare(client, await packingSlipPdf(doc(), 'client'))).toBe(0);
    const pages = layoutPackingSlip(doc(), { audience: 'client' });
    expect(Buffer.compare(client, await drawDocumentPdf(pages, { title: 'Packing slip SO-1', creationDate: doc().printedAt }))).toBe(0);
  });

  it('carton labels: COD on carton 1 only, both barcodes decode (decision 6, A16)', () => {
    const d = doc();
    const labels = parseZplLabels(renderShippingLabelsZpl(cartonLabelsOf(d, d.cartons)));
    expect(labels).toHaveLength(2);
    expect(labels.map((label) => label.barcodes.map((barcode) => barcode.payload))).toEqual([
      ['123456789012', `${TAG}.1.1`],
      ['123456789012', `${TAG}.1.2`],
    ]);
    expect(zplTexts(labels[0]!.raw).join('|')).toContain('COD Rs 1,250.00');
    expect(zplTexts(labels[1]!.raw).join('|')).toContain('COD ON CARTON 1');
    expect(zplTexts(labels[1]!.raw).join('|')).not.toContain('COD Rs');
    const prepaid = parseZplLabels(renderShippingLabelsZpl(cartonLabelsOf(doc({ payment: { kind: 'prepaid' } }), d.cartons)));
    expect(prepaid.every((label) => zplTexts(label.raw).includes('PREPAID'))).toBe(true);
  });

  it('a carton of 30 SKUs prints three thermal slips 1/3…3/3; rows per carton only', () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ skuId: `s${i}`, skuCode: `SKU-${String(i).padStart(2, '0')}`, skuName: `Item ${i}`, uom: 'EA', qty: 1, qtyText: '1', handlingUnitIds: null }));
    const d = doc({ cartonCount: 1, cartons: [{ seq: 1, code: `${TAG}.1.1`, weightGrams: null, dimensionsMm: null, lines, totals: '30 EA' }] });
    const slips = thermalSlipsOf(d, d.cartons);
    expect(slips).toHaveLength(3);
    const texts = renderShippingLabelsZpl(slips)
      .split('^XZ')
      .filter((chunk) => chunk.includes('^XA'))
      .map((raw) => zplTexts(raw).join('|'));
    expect(texts[0]).toContain('1/3');
    expect(texts[2]).toContain('3/3');
    expect(texts[2]).toContain('Not a tax invoice');
  });
});

describe('parsePackFileQuery (A48)', () => {
  const slip = { format: 'pdf', layout: 'a4' } as const;
  it('applies the defaults and parses a carton list into unique sorted numbers', () => {
    expect(parsePackFileQuery({}, slip)).toEqual({ format: 'pdf', layout: 'a4', cartons: null });
    expect(parsePackFileQuery({ format: 'zpl', layout: 'label', cartons: '3,1' }, slip)).toEqual({ format: 'zpl', layout: 'label', cartons: [1, 3] });
  });
  it.each([
    [{ format: 'zpl', layout: 'a4' }],
    [{ format: 'png' }],
    [{ layout: 'sheet' }],
    [{ layout: 'label', cartons: '0' }],
    [{ layout: 'label', cartons: '1,1' }],
    [{ layout: 'label', cartons: '01' }],
    [{ layout: 'label', cartons: '201' }],
    [{ layout: 'label', cartons: 'a' }],
  ])('refuses %j with 400 validation-failed', (raw) => {
    let thrown: unknown = null;
    try {
      parsePackFileQuery(raw, slip);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProblemException);
    expect((thrown as ProblemException).getStatus()).toBe(400);
    expect(((thrown as ProblemException).getResponse() as { code: string }).code).toBe('validation-failed');
  });
  it('folds the file stem to [A-Za-z0-9._-]', () => {
    expect(packDocumentFileStem('PO/77 #2')).toBe('PO_77__2');
  });
});

describe('review — what fits is printed, the remainder is counted', () => {
  it('serials: as many as fit in two lines, then the TRUE remainder (never cut by an ellipsis)', () => {
    const serials = Array.from({ length: 20 }, (_, i) => `SERIAL-NUMBER-${String(i).padStart(4, '0')}`);
    const pages = layoutPackingSlip(doc({ lines: [line(1, { serials, moreSerials: 5 })] }), { audience: 'staff' });
    const row = allText(pages)
      .split('\n')
      .filter((text) => text.startsWith('Serials:') || /^SERIAL-NUMBER|\(\+\d+ more\)$/.test(text))
      .join(' ');
    const shown = (row.match(/SERIAL-NUMBER-\d{4}/g) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(20);
    expect(row).toContain(`(+${20 - shown + 5} more)`);
    expect(row).not.toContain('…');
  });

  it('fittedList keeps everything when it fits and names cases', () => {
    expect(fittedList('Cases (A): ', ['c1', 'c2'], 0, (n) => `+${n} more cases`, 7, 275, 2)).toBe('Cases (A): c1, c2');
    const ids = Array.from({ length: 40 }, (_, i) => `0190aaaa-0000-7000-8000-${String(i).padStart(12, '0')}`);
    const text = fittedList('Cases (A): ', ids, 0, (n) => `+${n} more cases`, 7, 275, 2);
    const shown = text.split(', ').length;
    expect(text).toMatch(new RegExp(`\\+${40 - shown} more cases$`));
  });

  it('a long order label never overruns the title; multi-UoM carton totals wrap rather than cut', () => {
    const longLabel = `${'R'.repeat(64)}-BO2`;
    const pages = layoutPackingSlip(
      doc({ orderLabel: longLabel, cartons: [{ ...doc().cartons[1]!, totals: '4 EA, 2.500 KG, 12.000 LTR, 7 BOX, 3 PAIR' }] , cartonCount: 1 }),
      { audience: 'staff' },
    );
    const first = pages[0]!.runs;
    const title = first.find((run) => run.text === 'Packing slip')!;
    const labelRuns = first.filter((run) => run.size === 12 && run.y > title.y - 30);
    expect(labelRuns.length).toBeGreaterThan(0);
    for (const run of labelRuns) expect(run.x).toBeGreaterThan(title.x + 90);
    const text = allText(pages);
    for (const part of ['4 EA', '2.500 KG', '12.000 LTR', '7 BOX', '3 PAIR']) expect(text).toContain(part);
  });
});

describe('assertThermalSlipPrintFits (A48)', () => {
  const carton = (seq: number, rows: number) => ({ seq, lines: Array.from({ length: rows }) });
  it('passes within the cap and refuses past it naming the leading cartons that fit', () => {
    expect(() => assertThermalSlipPrintFits([carton(1, 12), carton(2, 24)])).not.toThrow();
    // 200 cartons × 72 rows = 6 labels each = 1,200 labels; 166 cartons fit (996 labels).
    const many = Array.from({ length: 200 }, (_, i) => carton(i + 1, 72));
    let thrown: ProblemException | null = null;
    try {
      assertThermalSlipPrintFits(many);
    } catch (err) {
      thrown = err as ProblemException;
    }
    expect(thrown?.getStatus()).toBe(422);
    const body = thrown!.getResponse() as { code: string; detail: string; extensions: { count: number } };
    expect(body.code).toBe('too-many-labels');
    expect(body.extensions.count).toBe(1200);
    expect(body.detail).toContain(`cartons=${Array.from({ length: 166 }, (_, i) => i + 1).join(',')}`);
  });
  it('a single carton over the cap names that carton alone', () => {
    let thrown: ProblemException | null = null;
    try {
      assertThermalSlipPrintFits([carton(7, 12_100)]);
    } catch (err) {
      thrown = err as ProblemException;
    }
    expect((thrown!.getResponse() as { detail: string }).detail).toContain('cartons=7.');
  });
});

const STAFF_GOLDEN = 'b84081501a4fcc63f8eb53fd009df4d2ab651d3dbf403b473f597e53719e9cab';
const CLIENT_GOLDEN = '7b56fbb499a915821862ebf928a175670b205aa5c36815171053dcc71dc3cec1';
const KIT_SHORT_BEFORE_GOLDEN = '96ab92da025f57599119f80d03198b67765f0c0ff81946504cdcaf0c025e39c5';
const KIT_SHORT_AFTER_GOLDEN = '9def05eb3115047cec2234553672915092cfedfcb639f9929930f02f162fb3d5';
