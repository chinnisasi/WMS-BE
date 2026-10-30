import type { DocumentPage } from '../../shared/documents/a4-pdf';
import { pdfPagesText, pdfText } from '../../../test/support/pdf-text';
import { grnDocumentCsv } from './grn-document.csv';
import { DOCUMENT_FONTS } from '../../shared/documents/text';
import {
  FOOTER_TOP,
  GRN_DOCUMENTS_OMITTED,
  GRN_ITEMS_CURRENT,
  GRN_NOT_AN_INVOICE,
  GRN_NOT_FROZEN,
  GRN_RECEIPT_NOTE,
  layoutGrnDocument,
  wrapText,
} from './grn-document.layout';
import { grnWarehousePartyOf, type GrnDocument, type GrnDocumentLine } from './grn-document.types';
import { grnDocumentFile } from './grn-document.view';

/**
 * Story 2-9a (A11, A19) — the GRN document's layout, golden-tested on its
 * runs: every arm whose effect exists ONLY in the PDF (frozen / legacy, ASN,
 * blind, mixed-client, a PO without a vendor, serials, a fractional UoM, the
 * filtered arrival documents, non-Latin text, no warehouse person), the
 * pagination invariants (a repeated column header, "Page n of m", no row
 * across the footer, the signatures kept together) and the file (`%PDF-`,
 * identical bytes for a fixed print instant, the text it really draws).
 */

const PRINTED = '2026-10-30T09:00:00.000Z';

function line(n: number, over: Partial<GrnDocumentLine> = {}): GrnDocumentLine {
  return {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    lineNo: n,
    skuCode: `SKU-${n}`,
    skuName: `Item ${n}`,
    clientCode: 'ACME',
    uom: 'pcs',
    uomPrecision: 0,
    batchCode: null,
    mfgDate: null,
    expiryDate: null,
    expirySource: null,
    expectedMilli: 10_000,
    goodMilli: 10_000,
    damagedMilli: 0,
    damageReasonCode: null,
    shortMilli: 0,
    shortReasonCode: null,
    toleranceMilli: 0,
    excess: { pendingMilli: 0, approvedMilli: 0, rejectedMilli: 0 },
    qc: { status: null, heldMilli: 0, onHoldMilli: 0, releasedMilli: 0, passedMilli: 0, failedMilli: 0 },
    serialCount: 0,
    unreadableSerialCount: 0,
    rejectedSerialCount: 0,
    photoCount: 0,
    ...over,
  };
}

const WAREHOUSE = grnWarehousePartyOf({
  v: 1,
  code: 'W1',
  name: 'Bhiwandi DC',
  gstin: '27AAAAA0000A1Z5',
  // A3 — the origin address carries a person; the GRN party must not.
  originAddress: { contactName: 'Ramesh Kumar', phone: '+919812345678', line1: 'Plot 4, MIDC', line2: null, city: 'Bhiwandi', state: 'Maharashtra', pincode: '421302' },
  operatorName: 'Acme 3PL',
});

const CLIENT = {
  v: 1 as const,
  code: 'ACME',
  name: 'ACME Brands',
  legalName: 'ACME Brands Pvt Ltd',
  gstin: '29BBBBB1111B1Z6',
  registeredAddress: { line1: '1 MG Road', line2: null, city: 'Bengaluru', stateCode: '29', pincode: '560001' },
};

const VENDOR = {
  v: 1 as const,
  code: 'V-01',
  name: 'Fabrics Co',
  legalName: null,
  gstin: '24CCCCC2222C1Z7',
  stateCode: '24',
  registeredAddress: { line1: 'Ring Road', line2: null, city: 'Surat', stateCode: '24', pincode: '395002' },
  dispatchAddress: null,
};

function doc(over: Partial<GrnDocument> = {}): GrnDocument {
  return {
    id: '00000000-0000-7000-8000-00000000aaaa',
    code: 'GRN-0042',
    receivedAt: '2026-10-30T05:30:00.000Z',
    recordedAt: '2026-10-30T05:31:00.000Z',
    printedAt: PRINTED,
    clientId: '00000000-0000-7000-8000-00000000cccc',
    parties: { frozen: true, warehouse: WAREHOUSE, client: CLIENT, vendor: VENDOR },
    document: { kind: 'po', code: 'PO-0007', blindReasonCode: null },
    arrival: null,
    lines: [line(1)],
    ...over,
  };
}

/** The 3-line fixture: PO, damage, QC inspected, over-receipt pending. */
const THREE = doc({
  lines: [
    line(1, { skuName: 'Cotton tee, medium', batchCode: 'B-1', mfgDate: '2026-09-01', expiryDate: '2027-09-01', expirySource: 'derived', damagedMilli: 3_000, damageReasonCode: 'crushed', shortMilli: 2_000, shortReasonCode: 'not-shipped', goodMilli: 40_000, expectedMilli: 45_000, photoCount: 2 }),
    line(2, { qc: { status: 'inspected', heldMilli: 20_000, onHoldMilli: 0, releasedMilli: 0, passedMilli: 18_000, failedMilli: 2_000 } }),
    line(3, { goodMilli: 120_000, expectedMilli: 100_000, excess: { pendingMilli: 20_000, approvedMilli: 0, rejectedMilli: 0 } }),
  ],
});

const texts = (pages: readonly DocumentPage[]) => pages.map((page) => page.runs.map((run) => run.text));
/** Runs joined by a space: a wrapped cell's lines are consecutive runs, so they read as one phrase. */
const allText = (pages: readonly DocumentPage[]) => texts(pages).flat().join(' ');

describe('the GRN document layout (story 2-9a)', () => {
  it('golden: the 3-line document (PO, damage, QC inspected, over-receipt pending) — every run, positioned', () => {
    expect(layoutGrnDocument(THREE)).toMatchSnapshot();
  });

  it('the 3-line document prints the header, three parties, the lines, the details, the totals, the notes and the signatures', () => {
    const text = allText(layoutGrnDocument(THREE));
    for (const expected of [
      'Goods Receipt Note',
      'GRN-0042',
      'Received 2026-10-30 11:00 IST · Recorded 2026-10-30 11:01 IST',
      'Document: PO PO-0007',
      'Received at',
      'Bhiwandi DC (W1)',
      'Operated by Acme 3PL',
      'ACME — ACME Brands',
      'GSTIN 29BBBBB1111B1Z6',
      'V-01 — Fabrics Co',
      '2027-09-01 (derived)',
      '20 awaiting approval',
      'Passed 18 · Failed 2',
      'Crushed',
      'Not shipped',
      '2 photo(s) — view in the client portal',
      'Good: 170 pcs',
      'Damaged: 3 pcs',
      'Short: 2 pcs',
      GRN_RECEIPT_NOTE,
      GRN_NOT_AN_INVOICE,
      GRN_ITEMS_CURRENT,
      'For the warehouse',
      'Delivered by (driver / transporter)',
      'Page 1 of 1',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain(GRN_NOT_FROZEN);
  });

  it('A3: the warehouse party carries no person — neither the contact name nor the phone reaches the model or a run', () => {
    expect(Object.keys(WAREHOUSE).sort()).toEqual(['address', 'code', 'gstin', 'name', 'operatorName']);
    expect(Object.keys(WAREHOUSE.address!).sort()).toEqual(['city', 'line1', 'line2', 'pincode', 'state']);
    const text = allText(layoutGrnDocument(THREE));
    expect(text).not.toContain('Ramesh');
    expect(text).not.toContain('9812345678');
  });

  it('legacy (unfrozen): the not-frozen note prints', () => {
    const text = allText(layoutGrnDocument(doc({ parties: { frozen: false, warehouse: WAREHOUSE, client: CLIENT, vendor: VENDOR } })));
    expect(text).toContain(GRN_NOT_FROZEN);
  });

  it('ASN and blind receipts: the supplier block and the document line in words', () => {
    const asn = allText(layoutGrnDocument(doc({ document: { kind: 'asn', code: 'A-77', blindReasonCode: null }, parties: { frozen: true, warehouse: WAREHOUSE, client: CLIENT, vendor: null } })));
    expect(asn).toContain('As announced by the client — ASN A-77');
    expect(asn).toContain('Document: ASN A-77');
    const blind = allText(layoutGrnDocument(doc({ document: { kind: 'blind', code: null, blindReasonCode: 'unannounced-delivery' }, parties: { frozen: true, warehouse: WAREHOUSE, client: CLIENT, vendor: null } })));
    expect(blind).toContain('Unannounced — Unannounced delivery');
    expect(blind).toContain('Document: Blind receipt (Unannounced delivery)');
  });

  it('A5: a PO receipt with no frozen vendor (pre-1-3) prints "Supplier not recorded on PO {code}"', () => {
    const text = allText(layoutGrnDocument(doc({ parties: { frozen: true, warehouse: WAREHOUSE, client: CLIENT, vendor: null } })));
    expect(text).toContain('Supplier not recorded on PO PO-0007');
  });

  it('mixed-client (an older build): "Client: several (older receipt)" and a Client column', () => {
    const pages = layoutGrnDocument(
      doc({ clientId: null, parties: { frozen: false, warehouse: WAREHOUSE, client: null, vendor: null }, document: { kind: 'blind', code: null, blindReasonCode: 'other' }, lines: [line(1, { clientCode: 'ACME' }), line(2, { clientCode: 'BETA' })] }),
    );
    const text = allText(pages);
    expect(text).toContain('Client: several (older receipt)');
    expect(texts(pages)[0]).toEqual(expect.arrayContaining(['Client', 'ACME', 'BETA']));
  });

  it('serials: the count, never the list — "Serials captured: 50 (2 unreadable, 1 rejected excess)", a zero part omitted', () => {
    const text = allText(layoutGrnDocument(doc({ lines: [line(1, { serialCount: 50, unreadableSerialCount: 2, rejectedSerialCount: 1 }), line(2, { serialCount: 3 })] })));
    expect(text).toContain('Line 1 SKU-1: Serials captured: 50 (2 unreadable, 1 rejected excess)');
    expect(text).toContain('Line 2 SKU-2: Serials captured: 3');
    expect(text).not.toContain('Line 2 SKU-2: Serials captured: 3 (');
  });

  it('a fractional UoM: 12.5 kg at precision 3 prints "12.500" (integer maths); totals per UoM', () => {
    const text = allText(layoutGrnDocument(doc({ lines: [line(1, { uom: 'kg', uomPrecision: 3, goodMilli: 12_500, expectedMilli: 12_500 }), line(2)] })));
    expect(text).toContain('12.500');
    expect(text).toContain('Good: 12.500 kg, 10 pcs');
  });

  it('QC: every non-zero part in a fixed order; a tolerance excess', () => {
    const text = allText(
      layoutGrnDocument(
        doc({
          lines: [
            line(1, { qc: { status: 'inspected', heldMilli: 20_000, onHoldMilli: 0, releasedMilli: 10_000, passedMilli: 8_000, failedMilli: 2_000 } }),
            line(2, { toleranceMilli: 5_000 }),
          ],
        }),
      ),
    );
    expect(text).toContain('Released 10 · Passed 8 ·');
    expect(text).toContain('5 within tolerance');
  });

  it('the arrival: labelled as the gate-in record, only the admitted documents, the omitted note, no package count and no driver', () => {
    const text = allText(
      layoutGrnDocument(
        doc({
          arrival: {
            gateInCode: 'GI-0009',
            vehicleNo: 'MH04AB1234',
            containerNo: null,
            transporterName: 'Swift Logistics',
            lrNumber: 'LR-55',
            sealStatus: 'intact',
            sealNumber: 'S-1',
            dockDoor: 'D1',
            gatedInAt: '2026-10-30T04:00:00.000Z',
            unloadStartedAt: '2026-10-30T04:30:00.000Z',
            unloadEndedAt: null,
            documents: [{ kind: 'invoice', number: 'INV-1', date: '2026-10-29', ewayBillNo: '123456789012' }],
            documentsOmitted: true,
          },
        }),
      ),
    );
    expect(text).toContain('Arrival — as recorded on gate-in GI-0009');
    expect(text).toContain('Vehicle MH04AB1234');
    expect(text).toContain('Invoice INV-1 dated 2026-10-29 · e-way bill 123456789012');
    expect(text).toContain(GRN_DOCUMENTS_OMITTED);
    expect(text).toContain('Arrival details are as on the gate-in record.');
    expect(text).not.toMatch(/package/i);
  });

  it('non-Latin text prints as ?s (the PDF folds; the CSV keeps the name); an emoji is one ?; an embedded newline is a space', () => {
    const fixture = doc({
      parties: { frozen: true, warehouse: WAREHOUSE, client: { ...CLIENT, name: 'नमस्ते' }, vendor: VENDOR },
      lines: [line(1, { skuName: 'Gift 📦\nbox' })],
    });
    const text = allText(layoutGrnDocument(fixture));
    expect(text).toContain('ACME — ??????');
    expect(text).toContain('Gift ? box');
    expect(grnDocumentCsv(fixture).toString('utf8')).toContain('Gift 📦\nbox');
  });

  it('A11: a 30-line address wraps to at most 4 lines per field, ending in …', () => {
    const longLine = Array.from({ length: 30 }, (_, i) => `Building ${i + 1} Industrial Estate Road`).join(' ');
    const pages = layoutGrnDocument(doc({ parties: { frozen: true, warehouse: WAREHOUSE, client: { ...CLIENT, registeredAddress: { ...CLIENT.registeredAddress, line1: longLine } }, vendor: VENDOR } }));
    const clientRuns = pages[0]!.runs.filter((run) => run.text.includes('Building'));
    expect(clientRuns).toHaveLength(4);
    expect(clientRuns[3]!.text.endsWith('…')).toBe(true);
  });

  it('wrapText: a 10,000-character unbroken token wraps fast and ends in …; a width narrower than one glyph terminates', () => {
    const started = Date.now();
    const lines = wrapText('W'.repeat(10_000), DOCUMENT_FONTS.regular, 8, 100, 4);
    expect(Date.now() - started).toBeLessThan(500);
    expect(lines).toHaveLength(4);
    expect(lines[3]!.endsWith('…')).toBe(true);
    const narrow = wrapText('WWW MMM', DOCUMENT_FONTS.bold, 8, 1, 10);
    expect(narrow).toEqual(['W', 'W', 'W', 'M', 'M', 'M']);
    expect(layoutGrnDocument(doc({ lines: [line(1, { skuName: 'X'.repeat(10_000) })] })).length).toBeGreaterThan(0);
  });

  describe('pagination', () => {
    function assertPaginated(pages: readonly DocumentPage[]): void {
      const total = pages.length;
      pages.forEach((page, index) => {
        const runTexts = page.runs.map((run) => run.text);
        expect(runTexts).toContain(`Page ${index + 1} of ${total}`);
        // No run except the footer's two sits at or below the footer line.
        const body = page.runs.filter((run) => run.y > 40);
        expect(body.every((run) => run.y >= FOOTER_TOP)).toBe(true);
      });
    }

    it('a 200-line GRN: every page repeats the column header and carries "Page n of m"; no row crosses the footer', () => {
      const pages = layoutGrnDocument(doc({ lines: Array.from({ length: 200 }, (_, i) => line(i + 1, { skuName: `A rather long item description number ${i + 1} that wraps` })) }));
      expect(pages.length).toBeGreaterThan(3);
      assertPaginated(pages);
      // Every page that holds line rows starts its table with the header row.
      for (const page of pages.slice(1, -1)) expect(page.runs.map((run) => run.text)).toContain('Over-receipt');
      expect(texts(pages).flat()).toContain('200');
    });

    it('200 damage rows paginate with their own repeated header', () => {
      const pages = layoutGrnDocument(doc({ lines: Array.from({ length: 200 }, (_, i) => line(i + 1, { damagedMilli: 1_000, damageReasonCode: 'wet' })) }));
      assertPaginated(pages);
      const withDetails = pages.filter((page) => page.runs.some((run) => run.text === 'Wet'));
      expect(withDetails.length).toBeGreaterThan(1);
      for (const page of withDetails) expect(page.runs.map((run) => run.text)).toContain('Damage reason');
    });

    it('the signatures stay together whatever the line count (they move to a new page rather than split)', () => {
      for (let n = 1; n <= 60; n += 1) {
        const pages = layoutGrnDocument(doc({ lines: Array.from({ length: n }, (_, i) => line(i + 1)) }));
        const withSignatures = pages.filter((page) => page.runs.some((run) => run.text === 'For the warehouse' || run.text === 'Delivered by (driver / transporter)'));
        expect(withSignatures).toHaveLength(1);
        const labels = withSignatures[0]!.runs.filter((run) => run.text === 'For the warehouse' || run.text === 'Delivered by (driver / transporter)');
        expect(labels).toHaveLength(2);
        expect(labels.every((run) => run.y >= FOOTER_TOP)).toBe(true);
      }
    });
  });

  describe('the file', () => {
    it('the PDF starts %PDF-, is byte-identical for a fixed print instant, and draws the text the layout laid out', async () => {
      const a = await grnDocumentFile(THREE, 'pdf');
      const b = await grnDocumentFile(THREE, 'pdf');
      expect(a.filename).toBe('GRN-0042.pdf');
      expect(a.contentType).toBe('application/pdf');
      expect(a.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(a.body.equals(b.body)).toBe(true);
      const text = (await pdfText(a.body)).split('\n').join(' ');
      expect(text).toContain('ACME — ACME Brands');
      expect(text).toContain('Passed 18 · Failed 2');
      expect((await pdfPagesText(a.body))[0]).toEqual(texts(layoutGrnDocument(THREE))[0]);
    });

    it('the CSV: BOM, the header row, codes in reason cells (empty at 0), numbers raw, a formula-looking text guarded', async () => {
      const file = await grnDocumentFile(doc({ lines: [line(1, { skuName: '=SUM(A1)', damagedMilli: 3_000, damageReasonCode: 'crushed', shortReasonCode: 'other' })] }), 'csv');
      expect(file.filename).toBe('GRN-0042-lines.csv');
      const csv = file.body.toString('utf8');
      expect(csv.startsWith('﻿grnCode,receivedAt,recordedAt,warehouseCode,clientCode,documentKind,documentCode,lineNo,skuCode,skuName,uom,')).toBe(true);
      const row = csv.split('\r\n')[1]!.split(',');
      expect(row).toContain("'=SUM(A1)");
      expect(row).toContain('crushed');
      expect(row).not.toContain('other'); // short 0 → no short reason
      expect(row[16]).toBe('10'); // goodQty, raw
    });
  });
});
