import { parseZplLabels, readPdfLabels } from '../../../test/support/labels';
import { parcelTagCode } from '../primitives/parcel-tag';
import { parcelTagFits, parcelTagLines, renderParcelTagPdf, renderParcelTagZpl, rupeesText, type ParcelTagLabel } from './parcel-tag';

const ORDER_ID = '01a18ba8-4743-79dd-8fe5-145b99902272';
const tag = (extra: Partial<ParcelTagLabel> = {}): ParcelTagLabel => ({
  orderId: ORDER_ID,
  orderLabel: 'SO-1',
  clientCode: 'ACME',
  destinationCity: 'Bengaluru',
  destinationPincode: '560001',
  codAmountPaise: 49950,
  packageCount: 1,
  ...extra,
});

describe('the parcel tag (story 4-4a, A16)', () => {
  it('the lines: `{client} {order}`, the city and pincode, COD or Prepaid with the parcel count; the payload is the tag code', () => {
    expect(parcelTagLines(tag())).toEqual({
      code: 'ACME SO-1',
      payload: 'O8FE5145B99902272',
      line1: 'Bengaluru 560001',
      line2: 'COD Rs 499.50 | 1 parcel',
    });
    expect(parcelTagLines(tag({ codAmountPaise: null, packageCount: 2, cartonNo: 1, cartonCount: 2 })).line2).toBe('Prepaid | 2 parcels | Carton 1/2');
    expect(parcelTagLines(tag({ destinationCity: 'मुंबई', destinationPincode: null })).line1).toBe('?????');
    expect(rupeesText(5)).toBe('Rs 0.05');
  });

  it('fits 4×2 and NOT 2×1 (D32)', () => {
    expect(parcelTagFits('4x2')).toBe(true);
    expect(parcelTagFits('2x1')).toBe(false);
  });

  it('ZPL and PDF both encode the tag code byte for byte', async () => {
    const zpl = parseZplLabels(renderParcelTagZpl(tag()));
    expect(zpl).toHaveLength(1);
    expect(zpl[0]!.payload).toBe(parcelTagCode(ORDER_ID));
    expect(zpl[0]!.moduleWidth).toBeGreaterThanOrEqual(2);
    const pages = await readPdfLabels(await renderParcelTagPdf(tag()));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.payloads).toEqual([parcelTagCode(ORDER_ID)]);
    expect([pages[0]!.width, pages[0]!.height]).toEqual([288, 144]);
  });
});
