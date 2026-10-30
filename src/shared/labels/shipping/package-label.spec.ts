import { parseZplLabels, readPdfLabels, zplTexts } from '../../../../test/support/labels';
import { assertLabelBands, type ShippingLabel } from './fields';
import { packageCode, packageLabel, type PackageLabelInput } from './package-label';
import { SHIPPER, WORST_B2B } from './fixtures';
import { renderShippingLabelsPdf } from './pdf';
import { renderShippingLabelsZpl } from './zpl';

const texts = (label: ShippingLabel) => label.fields.flatMap((f) => (f.kind === 'text' || f.kind === 'reverse' ? [f.text] : []));
const input = (extra: Partial<PackageLabelInput> = {}): PackageLabelInput => ({
  kind: 'rtv',
  documentCode: 'RTV-0007',
  shipper: SHIPPER,
  consignee: { ...WORST_B2B, phone: null },
  packageNo: 2,
  packageCount: 4,
  carrierName: null,
  trackingRef: null,
  ...extra,
});

describe('story 4-5a — the RTV / RTC package label (A22)', () => {
  it('prints RETURN TO VENDOR / CLIENT {code}, PACKAGE n/N, and the barcode {code}.{n}', () => {
    expect(packageCode('RTV-0007', 2)).toBe('RTV-0007.2');
    const rtv = packageLabel(input());
    expect(() => assertLabelBands(rtv)).not.toThrow();
    expect(texts(rtv)).toEqual(expect.arrayContaining(['RETURN TO VENDOR RTV-0007', 'PACKAGE', '2/4', 'FROM Acme Brands']));
    expect(texts(packageLabel(input({ kind: 'rtc', documentCode: 'RTC-0003' })))).toContain('RETURN TO CLIENT RTC-0003');
  });

  it('the carrier and tracking ref once dispatched (both barcodes decode); blanks before', async () => {
    const dispatched = input({ carrierName: 'VRL Logistics', trackingRef: 'LR123456' });
    const [zpl] = parseZplLabels(renderShippingLabelsZpl([packageLabel(dispatched)]));
    expect(zpl!.barcodes.map((b) => b.payload)).toEqual(['LR123456', 'RTV-0007.2']);
    expect(zplTexts(zpl!.raw)).toContain('VRL Logistics | Ref LR123456');
    const [before] = parseZplLabels(renderShippingLabelsZpl([packageLabel(input())]));
    expect(before!.barcodes.map((b) => b.payload)).toEqual(['RTV-0007.2']);
    const pages = await readPdfLabels(await renderShippingLabelsPdf([packageLabel(dispatched)], { layout: 'label', title: 'Package labels' }));
    expect(pages[0]!.payloads).toEqual(['LR123456', 'RTV-0007.2']);
  });
});
