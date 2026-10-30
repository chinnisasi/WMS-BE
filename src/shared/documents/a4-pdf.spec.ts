import { PDFDocument, PDFName } from 'pdf-lib';
import { readPdfLabels } from '../../../test/support/labels';
import { drawDocumentPdf } from './a4-pdf';
import { documentWarehousePartyOf } from './parties';

describe('story 4-5a — the A4 document barcodes (A17, D2)', () => {
  it('draws a barcode a reader decodes, and declares its band', async () => {
    const pdf = await drawDocumentPdf(
      [
        {
          runs: [{ x: 40, y: 800, size: 12, font: 'bold', text: 'Packing slip' }],
          rules: [{ x1: 40, y1: 780, x2: 555, y2: 780, width: 0.5 }],
          barcodes: [{ x: 380, y: 760, height: 36, moduleWidth: 0.75, payload: 'O8FE5145B99902272' }],
        },
      ],
      { title: 'Packing slip', creationDate: '2026-10-30T05:00:00.000Z' },
    );
    const pages = await readPdfLabels(pdf);
    expect(pages[0]!.payloads).toEqual(['O8FE5145B99902272']);
  });

  it('a page without barcodes declares no band (the GRN draws as before)', async () => {
    const pdf = await drawDocumentPdf([{ runs: [{ x: 40, y: 800, size: 12, font: 'regular', text: 'GRN' }], rules: [] }], {
      title: 'GRN',
      creationDate: '2026-10-30T05:00:00.000Z',
    });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPage(0).node.get(PDFName.of('WMSBarcodeBands'))).toBeUndefined();
  });
});

describe('story 4-5a — documentWarehousePartyOf (A45, D13)', () => {
  it('maps key by key: no contact name, no phone', () => {
    const party = documentWarehousePartyOf({
      code: 'WH1',
      name: 'Main DC',
      gstin: '29ABCDE1234F1Z5',
      originAddress: { line1: '1 Road', line2: undefined, city: 'Bengaluru', state: 'KA', pincode: '560001', contactName: 'Asha', phone: '9876543210' } as never,
    });
    expect(party).toEqual({ code: 'WH1', name: 'Main DC', gstin: '29ABCDE1234F1Z5', address: { line1: '1 Road', line2: null, city: 'Bengaluru', state: 'KA', pincode: '560001' } });
    expect(JSON.stringify(party)).not.toMatch(/Asha|9876543210/);
  });

  it('a null address stays null', () => {
    expect(documentWarehousePartyOf({ code: 'WH1', name: 'Main DC', gstin: null, originAddress: null }).address).toBeNull();
  });
});
