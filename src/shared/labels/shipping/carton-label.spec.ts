import { parseZplLabels, readPdfLabels, zplTexts } from '../../../../test/support/labels';
import { assertLabelBands, type ShippingLabel } from './fields';
import { cartonLabel, cmText, indianRupees, kgText, labelShipperOf, stcText } from './carton-label';
import { B2C, WORST_B2B, cartonInput } from './fixtures';
import { renderShippingLabelsPdf } from './pdf';
import { renderShippingLabelsZpl } from './zpl';

const texts = (label: ShippingLabel) => label.fields.flatMap((field) => (field.kind === 'text' || field.kind === 'reverse' ? [field.text] : []));

describe('story 4-5a — the carton label (A16, A42, decision 6)', () => {
  it('formats rupees with Indian grouping, kilograms and centimetres', () => {
    expect(indianRupees(125000)).toBe('Rs 1,250.00');
    expect(indianRupees(5)).toBe('Rs 0.05');
    expect(indianRupees(1234567890)).toBe('Rs 1,23,45,678.90');
    expect(kgText(4200)).toBe('4.20 kg');
    expect(cmText({ lengthMm: 400, widthMm: 305, heightMm: 200 })).toBe('40x30.5x20 cm');
  });

  it('carton 1 of a COD order carries the amount reversed; every other carton says COD ON CARTON 1; prepaid says PREPAID; a legacy order nothing', () => {
    const one = cartonLabel(cartonInput());
    const reverse = one.fields.find((f) => f.kind === 'reverse');
    expect(reverse && reverse.kind === 'reverse' ? reverse.text : null).toBe('COD Rs 1,250.00');
    const two = cartonLabel(cartonInput({ cartonNo: 2, cartonCode: 'O8FE5145B99902272.1.2' }));
    expect(two.fields.some((f) => f.kind === 'reverse')).toBe(false);
    expect(texts(two)).toContain('COD ON CARTON 1');
    expect(texts(two).some((t) => t.includes('1,250'))).toBe(false);
    expect(texts(cartonLabel(cartonInput({ payment: { kind: 'prepaid' } })))).toContain('PREPAID');
    const legacy = texts(cartonLabel(cartonInput({ payment: null })));
    expect(legacy.some((t) => /COD|PREPAID/.test(t))).toBe(false);
  });

  it('prints FROM the brand c/o the warehouse, CARTON n/N, TO, the order, Ref when it differs, the packed date (IST), weight and size, courier and AWB, and the code', () => {
    const t = texts(cartonLabel(cartonInput()));
    for (const expected of ['FROM Acme Brands', 'c/o Main DC, Bengaluru 562123', 'CARTON', '1/2', 'TO', 'Ravi Kumar', 'PIN 560038', 'Ph 9876543210', 'ORDER SO-1', 'Ref ACME-77', 'Packed 2026-10-30', '3.20 kg | 40x30x20 cm', 'Delhivery | AWB 123456789012', 'O8FE5145B99902272.1.1']) {
      expect(t).toContain(expected);
    }
    expect(texts(cartonLabel(cartonInput({ clientOrderRef: 'SO-1' }))).some((x) => x.startsWith('Ref'))).toBe(false);
    expect(texts(cartonLabel(cartonInput({ awb: null, courierName: null })))).toContain('AWB __________');
    expect(texts(cartonLabel(cartonInput({ repackedAt: '2026-10-31T05:00:00.000Z' })))).toContain('Packed 2026-10-30 | Re-packed 2026-10-31');
  });

  it('a warehouse with no address prints c/o its name with no city line (A45)', () => {
    const shipper = labelShipperOf('Acme', { code: 'WH1', name: 'Main DC', gstin: null, address: null });
    expect(texts(cartonLabel(cartonInput({ shipper })))).toContain('c/o Main DC');
  });

  it('the worst-case B2B label stays inside every band (A42): it drops line 2’s second wrap, then the legal name, then the phone — never the GSTIN', () => {
    const label = cartonLabel(cartonInput({ consignee: WORST_B2B, extraLines: ['EWB 1234 5678 9012'], marks: ['UN1263 Class 3'] }));
    expect(() => assertLabelBands(label)).not.toThrow();
    const t = texts(label);
    expect(t.some((x) => x.startsWith('GSTIN 29ABCDE1234F1Z5'))).toBe(true);
    expect(t).toContain('EWB 1234 5678 9012');
    expect(t).toContain('UN1263 Class 3');
    // Every text field sits inside its band.
    for (const field of label.fields) {
      if (field.kind === 'rule') continue;
      const band = label.bands.find((b) => b.name === field.band)!;
      expect(field.y).toBeGreaterThanOrEqual(band.top);
      expect(field.y + field.h).toBeLessThanOrEqual(band.bottom);
    }
  });

  it('the band check throws on a field that crosses its band (a programming error)', () => {
    const label = cartonLabel(cartonInput());
    const broken: ShippingLabel = { bands: label.bands, fields: [...label.fields, { kind: 'text', band: 'from', x: 30, y: 140, h: 40, w: 20, maxWidth: 500, bold: false, text: 'X' }] };
    expect(() => assertLabelBands(broken)).toThrow(/crosses band "from"/);
  });

  it('ZPL: both barcodes decode to the AWB and the carton code; text is ASCII-folded and escaped', () => {
    const zpl = renderShippingLabelsZpl([
      cartonLabel(cartonInput()),
      cartonLabel(cartonInput({ cartonNo: 2, cartonCode: 'O8FE5145B99902272.1.2', consignee: { ...B2C, contactName: 'रवि ^Kumar~' } })),
    ]);
    const labels = parseZplLabels(zpl);
    expect(labels).toHaveLength(2);
    expect(labels[0]!.barcodes.map((b) => b.payload)).toEqual(['123456789012', 'O8FE5145B99902272.1.1']);
    expect(labels[1]!.barcodes.map((b) => b.payload)).toEqual(['123456789012', 'O8FE5145B99902272.1.2']);
    expect(labels.every((l) => l.barcodes.every((b) => b.moduleWidth >= 2))).toBe(true);
    expect(zpl).toContain('^PW812\n^LL1218\n^CI0');
    expect(labels[1]!.raw).toContain('_5EKumar_7E');
    expect(zplTexts(labels[1]!.raw)).toContain('??? ^Kumar~');
    expect(zplTexts(labels[0]!.raw)).toContain('COD Rs 1,250.00');
    expect(labels[0]!.raw).toMatch(/\^GB\d+,80,80,B\^FS/);
  });

  it('an AWB too long for 2-dot bars prints as text only', () => {
    const awb = 'A'.repeat(50);
    const labels = parseZplLabels(renderShippingLabelsZpl([cartonLabel(cartonInput({ awb }))]));
    expect(labels[0]!.barcodes.map((b) => b.payload)).toEqual(['O8FE5145B99902272.1.1']);
    expect(zplTexts(labels[0]!.raw).some((t) => t.includes(`AWB ${awb.slice(0, 10)}`))).toBe(true);
  });

  it('PDF: one 4×6 page per carton; both barcodes decode, and the reversed COD box is never read as a bar (A49)', async () => {
    const pages = await readPdfLabels(await renderShippingLabelsPdf([cartonLabel(cartonInput()), cartonLabel(cartonInput({ cartonNo: 2, cartonCode: 'O8FE5145B99902272.1.2' }))], { layout: 'label', title: 'Carton labels' }));
    expect(pages).toHaveLength(2);
    expect(pages[0]!.width).toBeCloseTo(288, 1);
    expect(pages[0]!.height).toBeCloseTo(432, 1);
    expect(pages[0]!.payloads).toEqual(['123456789012', 'O8FE5145B99902272.1.1']);
    expect(pages[1]!.payloads).toEqual(['123456789012', 'O8FE5145B99902272.1.2']);
  });

  it('PDF on A4: two labels side by side per landscape page', async () => {
    const labels = [1, 2, 3].map((n) => cartonLabel(cartonInput({ cartonNo: n, cartonCount: 3, cartonCode: `O8FE5145B99902272.1.${n}`, awb: null })));
    const pages = await readPdfLabels(await renderShippingLabelsPdf(labels, { layout: 'a4', title: 'Carton labels' }));
    expect(pages).toHaveLength(2);
    expect(pages[0]!.width).toBeCloseTo(841.89, 1);
    expect(pages[0]!.height).toBeCloseTo(595.28, 1);
    expect(pages[0]!.payloads).toEqual(['O8FE5145B99902272.1.1', 'O8FE5145B99902272.1.2']);
    expect(pages[1]!.payloads).toEqual(['O8FE5145B99902272.1.3']);
  });

  it('story 4-9a (A24): a pallet prints PALLET in the box and STC n CARTONS in the order band; a carton and an absent type are byte-identical', () => {
    const base = cartonLabel(cartonInput());
    expect(cartonLabel(cartonInput({ packageType: 'carton' }))).toEqual(base);
    expect(cartonLabel(cartonInput({ innerCount: null }))).toEqual(base);
    expect(stcText(600)).toBe('STC 600 CARTONS');
    expect(stcText(null)).toBeNull();
    const pallet = cartonLabel(cartonInput({ packageType: 'pallet', innerCount: 600, clientOrderRef: 'SO-1' }));
    expect(() => assertLabelBands(pallet)).not.toThrow();
    const t = texts(pallet);
    expect(t).toContain('PALLET');
    expect(t).not.toContain('CARTON');
    expect(t).toContain('1/2');
    // No Ref line: the STC line sits on its own beside the payment.
    expect(t).toContain('STC 600 CARTONS');
    // Everything else is 4-5a's: only the box word and the one STC field differ.
    const only = (label: typeof base) => label.fields.filter((f) => !(f.kind === 'text' && (f.text === 'PALLET' || f.text === 'CARTON' || f.text.startsWith('STC'))));
    expect(only(pallet)).toEqual(only(cartonLabel(cartonInput({ clientOrderRef: 'SO-1' }))));
  });

  it('story 4-9a (A24): with a Ref line, the STC count joins the measurements line so the order band never overflows (also on the worst-case B2B label)', () => {
    const label = cartonLabel(cartonInput({ packageType: 'pallet', innerCount: 9999 }));
    expect(() => assertLabelBands(label)).not.toThrow();
    expect(texts(label)).toContain('3.20 kg | 40x30x20 cm | STC 9999 CARTONS');
    const worst = cartonLabel(cartonInput({ consignee: WORST_B2B, packageType: 'pallet', innerCount: 600, extraLines: ['EWB 1234 5678 9012'], marks: ['UN1263 Class 3'] }));
    expect(() => assertLabelBands(worst)).not.toThrow();
    expect(texts(worst).some((x) => x.includes('STC 600 CARTONS'))).toBe(true);
    const unmeasured = cartonLabel(cartonInput({ packageType: 'pallet', innerCount: 12, weightGrams: null, dimensionsMm: null }));
    expect(texts(unmeasured)).toContain('STC 12 CARTONS');
  });

  it('a fixed creation date gives identical bytes', async () => {
    const render = () => renderShippingLabelsPdf([cartonLabel(cartonInput())], { layout: 'label', title: 'Carton labels', creationDate: '2026-10-30T05:00:00.000Z' });
    expect(Buffer.compare(await render(), await render())).toBe(0);
  });
});
