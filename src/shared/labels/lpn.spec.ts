import { parseZplLabels, readPdfLabels } from '../../../test/support/labels';
import { formatLabelQuantity, lpnLabelText, type LpnLabel } from './layout';
import { renderLabelsPdf } from './pdf';
import { renderBinLabelsZpl, renderLabelsZpl } from './zpl';

const lpn = (extra: Partial<LpnLabel> = {}): LpnLabel => ({
  code: 'LPN-000042',
  skuCode: 'SKU-RICE-5KG',
  qty: 12.5,
  uom: 'kg',
  grnCode: 'GRN-0007',
  batchCode: 'B2026-10',
  expiryDate: '2027-04-30',
  clientCode: 'ACME',
  ...extra,
});

describe('LPN labels (story 2-10b)', () => {
  it('the text: code, `<SKU> x <qty> <uom>`, `<GRN> | B <batch> EXP <date> | CLIENT <code>`; the payload is the raw code', () => {
    expect(lpnLabelText(lpn())).toEqual({
      code: 'LPN-000042',
      payload: 'LPN-000042',
      line1: 'SKU-RICE-5KG x 12.5 kg',
      line2: 'GRN-0007 | B B2026-10 EXP 2027-04-30 | CLIENT ACME',
    });
    // Untracked, the tenant's own goods: line 2 is the GRN alone.
    expect(lpnLabelText(lpn({ batchCode: null, expiryDate: null, clientCode: null, qty: 40, uom: 'pcs' }))).toEqual({
      code: 'LPN-000042',
      payload: 'LPN-000042',
      line1: 'SKU-RICE-5KG x 40 pcs',
      line2: 'GRN-0007',
    });
    // A batch without an expiry prints no EXP; a client without a batch prints no B.
    expect(lpnLabelText(lpn({ expiryDate: null })).line2).toBe('GRN-0007 | B B2026-10 | CLIENT ACME');
    expect(lpnLabelText(lpn({ batchCode: null, expiryDate: null })).line2).toBe('GRN-0007 | CLIENT ACME');
  });

  it('the text folds non-ASCII to ? (the payload is never folded)', () => {
    const text = lpnLabelText(lpn({ skuCode: 'चावल', clientCode: 'ÄCME' }));
    expect(text.line1).toBe('???? x 12.5 kg');
    expect(text.line2.endsWith('| CLIENT ?CME')).toBe(true);
    expect(text.payload).toBe('LPN-000042');
  });

  it('quantities print without trailing zeros and never in exponent notation', () => {
    expect(formatLabelQuantity(40)).toBe('40');
    expect(formatLabelQuantity(400)).toBe('400');
    expect(formatLabelQuantity(12.5)).toBe('12.5');
    expect(formatLabelQuantity(0.001)).toBe('0.001');
    expect(formatLabelQuantity(10.25)).toBe('10.25');
    expect(formatLabelQuantity(9_007_199_254_740)).toBe('9007199254740');
  });

  it('the golden: one 4x2 LPN label, byte for byte', () => {
    expect(renderLabelsZpl([lpnLabelText(lpn())], '4x2')).toBe(
      [
        '^XA',
        '^LH0,0',
        '^PON',
        '^PW812',
        '^LL406',
        '^CI0',
        '^FO40,24^A0N,90,73^FH^FDLPN-000042^FS',
        '^FO80,126^BY4^BCN,170,N,N,N,N^FH^FD>:LPN-000042^FS',
        '^FO40,312^A0N,38,33^FH^FDSKU-RICE-5KG x 12.5 kg^FS',
        '^FO40,358^A0N,28,14^FH^FDGRN-0007 | B B2026-10 EXP 2027-04-30 | CLIENT ACME^FS',
        '^XZ',
        '',
      ].join('\n'),
    );
  });

  it('the golden: a truncated 2x1 LPN label (line 2 overflows to ...)', () => {
    expect(renderLabelsZpl([lpnLabelText(lpn())], '2x1')).toBe(
      [
        '^XA',
        '^LH0,0',
        '^PON',
        '^PW406',
        '^LL203',
        '^CI0',
        '^FO20,10^A0N,44,36^FH^FDLPN-000042^FS',
        '^FO40,58^BY2^BCN,84,N,N,N,N^FH^FD>:LPN-000042^FS',
        '^FO20,148^A0N,22,16^FH^FDSKU-RICE-5KG x 12.5 kg^FS',
        '^FO20,174^A0N,18,8^FH^FDGRN-0007 | B B2026-10 EXP 2027-04-30 | CLI...^FS',
        '^XZ',
        '',
      ].join('\n'),
    );
  });

  it('the decoded barcode is the code, in ZPL and PDF, in the order given; a code longer than the label throws', async () => {
    const labels = ['LPN-000001', 'LPN-000002', 'LPN-1234567'].map((code) => lpnLabelText(lpn({ code })));
    expect(parseZplLabels(renderLabelsZpl(labels, '4x2')).map((l) => l.payload)).toEqual(['LPN-000001', 'LPN-000002', 'LPN-1234567']);
    const pages = await readPdfLabels(await renderLabelsPdf(labels, { layout: 'label', size: '2x1', title: 'LPN labels' }));
    expect(pages.map((p) => p.payloads)).toEqual([['LPN-000001'], ['LPN-000002'], ['LPN-1234567']]);
    const sheet = await readPdfLabels(await renderLabelsPdf(labels, { layout: 'a4', title: 'LPN labels' }));
    expect(sheet).toHaveLength(1);
    expect(sheet[0]!.payloads).toEqual(['LPN-000001', 'LPN-000002', 'LPN-1234567']);
    // 2x1 carries 11 characters: LPN-10000000 (12) does not fit.
    expect(() => renderLabelsZpl([lpnLabelText(lpn({ code: 'LPN-10000000' }))], '2x1')).toThrow(/does not fit/);
  });

  it('the bin wrapper still renders through the shared renderer (the bin golden lives in zpl.spec.ts)', () => {
    const zpl = renderBinLabelsZpl([{ code: 'A-1', zoneCode: 'A', warehouseCode: 'W', storageClass: 'ambient', clientCode: null }], '2x1');
    expect(parseZplLabels(zpl).map((l) => l.payload)).toEqual(['A-1']);
  });
});
