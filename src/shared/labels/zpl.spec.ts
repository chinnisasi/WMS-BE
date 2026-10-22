import { parseZplLabels } from '../../../test/support/labels';
import { renderBinLabelsZpl } from './zpl';
import type { BinLabel } from './layout';

const label = (code: string, extra: Partial<BinLabel> = {}): BinLabel => ({
  code,
  zoneCode: 'A',
  warehouseCode: 'BLR1',
  storageClass: 'ambient',
  clientCode: null,
  ...extra,
});

describe('bin labels as ZPL (story 2-10a)', () => {
  it('the golden: one 4x2 label, byte for byte', () => {
    const zpl = renderBinLabelsZpl([label('A-01-01', { storageClass: 'chilled', clientCode: 'ACME' })], '4x2');
    expect(zpl).toBe(
      [
        '^XA',
        '^LH0,0',
        '^PON',
        '^PW812',
        '^LL406',
        '^CI0',
        '^FO40,24^A0N,90,90^FH^FDA-01-01^FS',
        '^FO90,126^BY5^BCN,170,N,N,N,N^FH^FD>:A-01-01^FS',
        '^FO40,312^A0N,38,38^FH^FDA - BLR1^FS',
        '^FO40,358^A0N,28,28^FH^FDCHILLED | CLIENT ACME^FS',
        '^XZ',
        '',
      ].join('\n'),
    );
  });

  it('special characters are escaped, and the decoded payload is the code', () => {
    const zpl = renderBinLabelsZpl([label('A^1~_>B', { zoneCode: 'Z^XZ', warehouseCode: 'W~JA' })], '2x1');
    const [parsed] = parseZplLabels(zpl);
    expect(parsed!.payload).toBe('A^1~_>B');
    expect(parsed!.moduleWidth).toBe(2);
    // The only command carets are our own: no field carries a raw ^ or ~.
    for (const field of zpl.match(/\^FD.*?\^FS/g)!) {
      expect(field.slice(3, -3)).not.toMatch(/[\^~]/);
    }
    expect(zpl).toContain('^FDZ_5EXZ - W_7EJA^FS');
    // No printer configuration commands and no tilde commands at all.
    expect(zpl).not.toMatch(/~|\^JU|\^MM|\^MN|\^MD|\^PR/);
  });

  it('one ^XA…^XZ per label, in the order given, and a Devanagari zone folds to ?', () => {
    const zpl = renderBinLabelsZpl([label('A-1'), label('A-2', { zoneCode: 'भंडार' }), label('B-1')], '4x2');
    expect(parseZplLabels(zpl).map((l) => l.payload)).toEqual(['A-1', 'A-2', 'B-1']);
    expect(zpl).toContain('^FD????? - BLR1^FS');
    expect(Buffer.from(zpl, 'utf8').every((byte) => byte < 0x80)).toBe(true);
  });

  it('long zone and warehouse codes are truncated with ... to fit the printable width (4x2 and 2x1)', () => {
    const zone = 'Z'.repeat(32);
    const warehouse = 'W'.repeat(32);
    for (const [size, printable] of [['4x2', 732], ['2x1', 366]] as const) {
      const zpl = renderBinLabelsZpl([label('A-1', { zoneCode: zone, warehouseCode: warehouse })], size);
      const field = new RegExp(`\\^A0N,(\\d+),(\\d+)\\^FH\\^FD(Z+[^^]*)\\^FS`).exec(zpl);
      expect(field).not.toBeNull();
      const [, , width, text] = field!;
      expect(text!.endsWith('...')).toBe(true);
      expect(text!.startsWith('ZZZZ')).toBe(true);
      expect(Number(width) * text!.length).toBeLessThanOrEqual(printable);
    }
  });

  it('a code that cannot fit throws (the service refuses it first)', () => {
    expect(() => renderBinLabelsZpl([label('X'.repeat(12))], '2x1')).toThrow(/does not fit/);
    expect(() => renderBinLabelsZpl([label('X'.repeat(11))], '2x1')).not.toThrow();
  });
});
