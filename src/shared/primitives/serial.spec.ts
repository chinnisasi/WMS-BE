import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERIAL_FORMATS, isSerialFormat, isSerialNumberShape, isValidImei } from './serial';

/**
 * Story 2-6a (A10) — the shared vector file. wms-mobile carries the same
 * bytes at `src/lib/serial-vectors.json` and pins the SAME sha256, so the
 * device's offline gate and this server's rules cannot drift apart: editing
 * the vectors in one repo fails that repo's pin until the other matches.
 */
const VECTORS_PATH = join(__dirname, '..', '..', '..', 'test', 'fixtures', 'serial-vectors.json');
const VECTORS_SHA256 = '4be284df73de018e494ee18f64746390705b848212ce8eef8be2dc5f0ecdcf9a';

interface Vectors {
  readonly imei: readonly { readonly value: string; readonly valid: boolean }[];
  readonly shape: readonly { readonly value: string; readonly valid: boolean }[];
  readonly parse: readonly { readonly format: string; readonly input: string; readonly ok: boolean }[];
}

describe('serial primitives (story 2-6a)', () => {
  const bytes = readFileSync(VECTORS_PATH);
  const vectors = JSON.parse(bytes.toString('utf8')) as Vectors;

  it('the shared vector file is the pinned one (wms-mobile pins the same sha256)', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(VECTORS_SHA256);
  });

  it('isValidImei agrees with every imei vector', () => {
    expect(vectors.imei.length).toBeGreaterThanOrEqual(10);
    for (const vector of vectors.imei) {
      expect([vector.value, isValidImei(vector.value)]).toEqual([vector.value, vector.valid]);
    }
  });

  it('the serial shape agrees with every shape vector (64 accepted, 65 refused)', () => {
    for (const vector of vectors.shape) {
      expect([vector.value, isSerialNumberShape(vector.value)]).toEqual([vector.value, vector.valid]);
    }
    expect(isSerialNumberShape('x'.repeat(64))).toBe(true);
    expect(isSerialNumberShape('x'.repeat(65))).toBe(false);
  });

  it('every serial a device parse accepts is one the server accepts (shape, and imei on an imei SKU)', () => {
    for (const vector of vectors.parse.filter((entry) => entry.ok)) {
      const serial = (vector as unknown as { serial: string }).serial;
      expect([vector.input, isSerialNumberShape(serial)]).toEqual([vector.input, true]);
      if (vector.format === 'imei') {
        expect([vector.input, isValidImei(serial)]).toEqual([vector.input, true]);
      }
    }
  });

  it('the format vocabulary is free | imei', () => {
    expect([...SERIAL_FORMATS]).toEqual(['free', 'imei']);
    expect(isSerialFormat('imei')).toBe(true);
    expect(isSerialFormat('IMEI')).toBe(false);
    expect(isSerialFormat(null)).toBe(false);
  });
});
