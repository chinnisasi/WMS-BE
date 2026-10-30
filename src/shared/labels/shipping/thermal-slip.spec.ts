import { parseZplLabels, zplTexts } from '../../../../test/support/labels';
import { renderShippingLabelsZpl } from './zpl';
import { assertLabelBands, type ShippingLabel } from './fields';
import { THERMAL_SLIP_ROWS_PER_LABEL, thermalSlipLabelCount, thermalSlipLabels, totalsPerUom, type ThermalSlipInput } from './thermal-slip';

const texts = (label: ShippingLabel) => label.fields.flatMap((f) => (f.kind === 'text' || f.kind === 'reverse' ? [f.text] : []));
const input = (rows: number, extra: Partial<ThermalSlipInput> = {}): ThermalSlipInput => ({
  orderLabel: 'SO-1',
  cartonNo: 1,
  cartonCount: 2,
  consigneeName: 'Ravi Kumar',
  city: 'Bengaluru',
  pincode: '560038',
  rows: Array.from({ length: rows }, (_, i) => ({ skuCode: `SKU-${String(rows - i).padStart(3, '0')}`, skuName: `Item ${rows - i}`, qty: 2, uom: 'EA' })),
  ...extra,
});

describe('story 4-5a — the thermal slip (A18, A36)', () => {
  it('one label for up to 12 rows: the head, rows sorted by SKU code, the per-UoM total and "Not a tax invoice"', () => {
    const labels = thermalSlipLabels(input(2, { rows: [{ skuCode: 'B', skuName: 'Bee', qty: 2.5, uom: 'KG' }, { skuCode: 'A', skuName: 'Ay', qty: 12, uom: 'EA' }] }));
    expect(labels).toHaveLength(1);
    const t = texts(labels[0]!);
    expect(t.slice(0, 3)).toEqual(['PACKING SLIP', 'ORDER SO-1', 'CARTON 1/2']);
    expect(t.indexOf('A')).toBeLessThan(t.indexOf('B'));
    expect(t).toContain('12 EA');
    expect(t).toContain('2.5 KG');
    // Rows sort by SKU code (A before B), so the totals follow that order.
    expect(t).toContain('Total 12 EA, 2.5 KG');
    expect(t).toContain('Not a tax invoice');
    expect(totalsPerUom([{ qty: 1, uom: 'EA' }, { qty: 0.1, uom: 'KG' }, { qty: 0.2, uom: 'KG' }])).toBe('1 EA, 0.3 KG');
  });

  it('prints the document’s own quantity and totals text when given (one formatter over milli-units — review)', () => {
    const labels = thermalSlipLabels(
      input(1, { rows: [{ skuCode: 'A', skuName: 'Ay', qty: 2.5, qtyText: '2.500', uom: 'KG' }], totalsText: '2.500 KG' }),
    );
    const t = texts(labels[0]!);
    expect(t).toContain('2.500 KG');
    expect(t).toContain('Total 2.500 KG');
  });

  it('30 rows print three continuation labels 1/3…3/3; only the last carries the total (the matrix row)', () => {
    const labels = thermalSlipLabels(input(30));
    expect(thermalSlipLabelCount(30)).toBe(3);
    expect(labels).toHaveLength(3);
    labels.forEach((label, k) => {
      expect(() => assertLabelBands(label)).not.toThrow();
      expect(texts(label)).toContain(`Slip ${k + 1}/3`);
      expect(texts(label).some((x) => x.startsWith('Total'))).toBe(k === 2);
    });
    expect(texts(labels[0]!).filter((x) => x.startsWith('SKU-'))).toHaveLength(THERMAL_SLIP_ROWS_PER_LABEL);
    expect(texts(labels[2]!).filter((x) => x.startsWith('SKU-'))).toHaveLength(6);
  });

  it('story 4-9a (A24): a pallet prints PALLET n/N; a carton and an absent type are byte-identical', () => {
    expect(texts(thermalSlipLabels(input(1, { packageType: 'pallet' }))[0]!)).toContain('PALLET 1/2');
    expect(thermalSlipLabels(input(1, { packageType: 'carton' }))).toEqual(thermalSlipLabels(input(1)));
  });

  it('renders as ZPL text only (no barcode) — the slip carries no carton code', () => {
    const zpl = renderShippingLabelsZpl(thermalSlipLabels(input(1)));
    expect(zpl).not.toContain('^BC');
    expect(() => parseZplLabels(zpl)).toThrow(/no start-B barcode/);
    expect(zplTexts(zpl)).toContain('PACKING SLIP');
  });
});
