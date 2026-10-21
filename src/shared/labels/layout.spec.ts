import { moduleCount } from './code128';
import { A4_SHEET, LABEL_GEOMETRY, binLabelText, fitModuleWidth, maxCodeLengthFor, printableUnitsOf, type LabelTarget } from './layout';

describe('label layout and the barcode fit (story 2-10a)', () => {
  it('pins the three limits from the design: 4x2 → 28, 2x1 → 11, an A4 cell → 18 characters', () => {
    expect(maxCodeLengthFor({ layout: 'label', size: '4x2' })).toBe(28);
    expect(maxCodeLengthFor({ layout: 'label', size: '2x1' })).toBe(11);
    expect(maxCodeLengthFor({ layout: 'a4' })).toBe(18);
    // The limit is exact: one more character does not fit at 2 units, the limit itself does.
    for (const target of [{ layout: 'label', size: '4x2' }, { layout: 'label', size: '2x1' }, { layout: 'a4' }] as LabelTarget[]) {
      const n = maxCodeLengthFor(target);
      expect(fitModuleWidth(moduleCount(n), printableUnitsOf(target))).not.toBeNull();
      expect(fitModuleWidth(moduleCount(n + 1), printableUnitsOf(target))).toBeNull();
    }
  });

  it('fitModuleWidth: the widest width ≥ 2 that fits with 10-module quiet zones, capped at 10, else null', () => {
    // 4x2: 732 printable dots; A-01-01 = 112 modules + 20 → 732 / 132 = 5.
    expect(fitModuleWidth(moduleCount(7), 732)).toBe(5);
    // 2x1: 366 dots → 2.
    expect(fitModuleWidth(moduleCount(7), 366)).toBe(2);
    expect(fitModuleWidth(10, 10_000)).toBe(10);
    // Exactly at the edge: (modules + 20) · 2 = printable fits; one unit less does not.
    expect(fitModuleWidth(100, 240)).toBe(2);
    expect(fitModuleWidth(100, 239)).toBeNull();
  });

  it('A-01-01 (7 characters) fits every size and layout', () => {
    for (const target of [{ layout: 'label', size: '4x2' }, { layout: 'label', size: '2x1' }, { layout: 'a4' }] as LabelTarget[]) {
      expect(fitModuleWidth(moduleCount(7), printableUnitsOf(target))).not.toBeNull();
    }
  });

  it('the label geometry: page sizes in points, bands inside the label', () => {
    expect([LABEL_GEOMETRY['4x2'].widthPt, LABEL_GEOMETRY['4x2'].heightPt]).toEqual([288, 144]);
    expect([LABEL_GEOMETRY['2x1'].widthPt, LABEL_GEOMETRY['2x1'].heightPt]).toEqual([144, 72]);
    for (const g of Object.values(LABEL_GEOMETRY)) {
      const bands = [g.code, g.barcode, g.line1, g.line2];
      for (let i = 0; i < bands.length; i += 1) {
        const [y, h] = bands[i]!;
        expect(y + h).toBeLessThanOrEqual(i + 1 < bands.length ? bands[i + 1]![0] : g.heightDots);
      }
    }
    // The A4 grid fills the page: 3 × 70 = 210 wide, 4.5 + 8 × 36 + 4.5 = 297 tall.
    expect(A4_SHEET.columns * A4_SHEET.cellWidthMm).toBe(A4_SHEET.pageWidthMm);
    expect(2 * A4_SHEET.topMarginMm + A4_SHEET.rows * A4_SHEET.cellHeightMm).toBe(A4_SHEET.pageHeightMm);
  });

  it('binLabelText: <ZONE> - <WAREHOUSE>, the class only when not ambient, the client when dedicated, all folded', () => {
    const base = { code: 'A-01', zoneCode: 'A', warehouseCode: 'BLR1', storageClass: 'ambient', clientCode: null };
    expect(binLabelText(base)).toEqual({ code: 'A-01', line1: 'A - BLR1', line2: '' });
    expect(binLabelText({ ...base, storageClass: 'chilled' }).line2).toBe('CHILLED');
    expect(binLabelText({ ...base, clientCode: 'ACME' }).line2).toBe('CLIENT ACME');
    expect(binLabelText({ ...base, storageClass: 'frozen', clientCode: 'ACME' }).line2).toBe('FROZEN | CLIENT ACME');
    expect(binLabelText({ ...base, zoneCode: 'भंडार' }).line1).toBe('????? - BLR1');
  });
});
