import { pdfPagesText } from '../../../test/support/pdf-text';
import { readPdfLabels } from '../../../test/support/labels';
import { A4_WIDTH_PT } from './a4-pdf';
import {
  FREIGHT_NOTE_DISCLAIMER,
  FREIGHT_NOTE_FOOTER_TOP,
  freightNoteFileName,
  layoutFreightNote,
  packagesLine,
  renderFreightNotePdf,
  type FreightNoteModel,
  type FreightNotePackage,
} from './freight-note.layout';

/**
 * Story 4-9a (A26) — the freight note per consignment: the staff copy prints
 * the ref's barcode and the package codes; the client copy neither; the
 * packages line ("15 pallets (STC 600 cartons), 2 cartons — 9,840 kg"); the
 * receipt block kept whole; "not a tax invoice or a lorry receipt" and
 * "Page n of m" on every page; never a phone.
 */

const TAG = 'O8FE5145B99902272';

function packages(pallets: number, cartons: number, inner: number | null = 40): FreightNotePackage[] {
  return [
    ...Array.from({ length: pallets }, (_, i) => ({ code: `${TAG}.1.${i + 1}`, type: 'pallet' as const, seq: i + 1, innerCount: inner, weightGrams: 620_000 })),
    ...Array.from({ length: cartons }, (_, i) => ({ code: `${TAG}.1.${pallets + i + 1}`, type: 'carton' as const, seq: pallets + i + 1, innerCount: null, weightGrams: 60_000 })),
  ];
}

function model(over: Partial<FreightNoteModel> = {}): FreightNoteModel {
  const pkgs = over.packages ?? packages(15, 2);
  return {
    consignmentRef: 'LD-0007/03',
    dispatchedAt: '2026-10-30T10:35:00.000Z',
    printedAt: '2026-10-30T11:00:00.000Z',
    consignor: { name: 'Acme Brands', legalName: 'Acme Brands Private Limited', gstin: '29ABCDE1234F1Z5', addressLines: [] },
    careOf: { code: 'BLR1', name: 'Main DC', gstin: '29AAACW1234F1Z5', addressLines: ['1 Road, Hoskote, Bengaluru, Karnataka 562114'] },
    consignee: { name: 'Kumar Stores', legalName: 'Kumar Stores LLP', gstin: '27AAACK1234F1Z5', addressLines: ['12 MG Road'], city: 'Pune', state: 'Maharashtra', pincode: '411001' },
    transporter: { name: 'VRL Logistics', gstin: '29AABCV1234F1Z5' },
    vehicle: { number: 'KA01AB1234', type: 'hcv', containerNumber: null },
    driverName: 'Ravi',
    seals: ['S-991'],
    orderLabel: 'SO-1',
    clientOrderRef: 'ACME-77',
    lr: { number: '4410', date: '2026-10-30', terms: 'to-pay' },
    invoice: { type: 'invoice', number: 'INV/26-27/0042', date: '2026-10-30' },
    ewayBill: { number: '123456789012', validUntil: '2026-11-01' },
    packages: pkgs,
    totals: { packages: pkgs.length, cartons: pkgs.filter((p) => p.type === 'carton').length, pallets: pkgs.filter((p) => p.type === 'pallet').length, weightGrams: 9_420_000 },
    ...over,
  };
}

const allTexts = (pages: ReturnType<typeof layoutFreightNote>) => pages.flatMap((page) => page.runs.map((run) => run.text));

describe('story 4-9a — the freight note (A26)', () => {
  it('the packages line: pallets with their STC sum, cartons, the weight; STC only when every pallet is counted', () => {
    expect(packagesLine(model())).toBe('15 pallets (STC 600 cartons), 2 cartons — 9,420 kg');
    expect(packagesLine(model({ packages: [...packages(1, 0, null), ...packages(0, 1)], totals: { packages: 2, cartons: 1, pallets: 1, weightGrams: null } }))).toBe('1 pallet, 1 carton');
    expect(packagesLine(model({ packages: packages(0, 1), totals: { packages: 1, cartons: 1, pallets: 0, weightGrams: 60_000 } }))).toBe('1 carton — 60 kg');
  });

  it('golden (staff): the header, the parties, the facts, the package list with codes and the receipt block', () => {
    const pages = layoutFreightNote(model({ packages: packages(1, 1), totals: { packages: 2, cartons: 1, pallets: 1, weightGrams: 680_000 } }), { audience: 'staff' });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.landscape).toBeUndefined();
    expect(pages[0]!.barcodes?.map((b) => b.payload)).toEqual(['LD-0007/03']);
    expect(allTexts(pages)).toEqual([
      'Freight note',
      'LD-0007/03',
      'Dispatched 2026-10-30 16:05 IST · Printed 2026-10-30 16:30 IST',
      'Consignor',
      'Acme Brands',
      'Acme Brands Private Limited',
      'GSTIN 29ABCDE1234F1Z5',
      'c/o Main DC (BLR1)',
      '1 Road, Hoskote, Bengaluru, Karnataka',
      '562114',
      'Consignee',
      'Kumar Stores',
      'Kumar Stores LLP',
      'GSTIN 27AAACK1234F1Z5',
      '12 MG Road',
      'Pune, Maharashtra',
      'PIN 411001',
      'Transporter and vehicle',
      'VRL Logistics',
      'GSTIN 29AABCV1234F1Z5',
      'Vehicle KA01AB1234 (hcv)',
      'Driver Ravi',
      'Seals S-991',
      'Consignment',
      'Order SO-1 · Client order ref ACME-77 · LR 4410 dated 2026-10-30 (To pay)',
      'Invoice INV/26-27/0042 dated 2026-10-30 · E-way bill 123456789012 valid until 2026-11-01',
      'Packages: 1 pallet (STC 40 cartons), 1 carton — 680 kg',
      'Packages',
      'Package',
      'Type',
      'Contents',
      'Weight',
      'Code',
      '1 of 2',
      'Pallet',
      'STC 40 cartons',
      '620 kg',
      `${TAG}.1.1`,
      '2 of 2',
      'Carton',
      '60 kg',
      `${TAG}.1.2`,
      'Receipt (to be completed by the consignee)',
      'Received 2 packages in good order / with the remarks below.',
      'Short (packages)',
      'Damaged (packages)',
      'Remarks',
      'Receiver name',
      'Signature',
      'Stamp',
      'Date and time',
      FREIGHT_NOTE_DISCLAIMER,
      'LD-0007/03 · SO-1 · Printed 2026-10-30 16:30 IST',
      'Page 1 of 1',
    ]);
  });

  it('the client copy prints no barcode and no package code; the staff copy prints both', () => {
    const client = layoutFreightNote(model(), { audience: 'client' });
    expect(client.every((page) => page.barcodes === undefined)).toBe(true);
    expect(allTexts(client).some((text) => text.includes(TAG))).toBe(false);
    expect(allTexts(client)).toContain('Packages: 15 pallets (STC 600 cartons), 2 cartons — 9,420 kg');
    const staff = layoutFreightNote(model(), { audience: 'staff' });
    expect(allTexts(staff).filter((text) => text.startsWith(TAG))).toHaveLength(17);
  });

  it('never prints a phone', () => {
    expect(allTexts(layoutFreightNote(model(), { audience: 'staff' })).join(' ')).not.toMatch(/\+?91\d{10}|Ph(one)? /);
  });

  it('worst case: 200 packages paginate; the receipt block is never split; the footer and "Page n of m" on every page', () => {
    const pkgs = packages(120, 80);
    const pages = layoutFreightNote(model({ packages: pkgs, totals: { packages: 200, cartons: 80, pallets: 120, weightGrams: null } }), { audience: 'staff' });
    expect(pages.length).toBeGreaterThan(2);
    pages.forEach((page, index) => {
      const t = page.runs.map((run) => run.text);
      expect(t[0]).toBe('Freight note');
      expect(t).toContain(FREIGHT_NOTE_DISCLAIMER);
      expect(t).toContain(`Page ${index + 1} of ${pages.length}`);
      for (const run of page.runs) {
        if (run.text === FREIGHT_NOTE_DISCLAIMER || run.text.startsWith('Page ') || run.text.startsWith('LD-0007/03 · SO-1')) continue;
        expect(run.y).toBeGreaterThanOrEqual(FREIGHT_NOTE_FOOTER_TOP);
        expect(run.x).toBeLessThan(A4_WIDTH_PT);
      }
    });
    const receiptPage = pages.findIndex((page) => page.runs.some((run) => run.text.startsWith('Received 200 packages')));
    expect(pages[receiptPage]!.runs.map((run) => run.text)).toEqual(expect.arrayContaining(['Receiver name', 'Signature', 'Stamp', 'Date and time']));
    expect(allTexts(pages).filter((text) => / of 200$/.test(text))).toHaveLength(200);
  });

  it('renders a PDF whose text and staff barcode a reader recovers; the client PDF carries no barcode; same instant → same bytes', async () => {
    const staff = await renderFreightNotePdf(model(), 'staff');
    expect((await readPdfLabels(staff))[0]!.payloads).toEqual(['LD-0007/03']);
    expect((await pdfPagesText(staff))[0]).toContain('Freight note');
    const client = await renderFreightNotePdf(model(), 'client');
    expect((await pdfPagesText(client)).flat().some((text) => text.includes(TAG))).toBe(false);
    expect(Buffer.compare(client, await renderFreightNotePdf(model(), 'client'))).toBe(0);
    expect(freightNoteFileName('LD-0007/03')).toBe('LD-0007-03-freight-note.pdf');
  });
});
