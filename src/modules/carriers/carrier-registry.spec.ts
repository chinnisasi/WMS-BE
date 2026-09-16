import {
  getCarrierAdapter,
  isKnownCarrierCode,
  knownCarrierCodes,
  listCarrierAdapters,
  registerCarrierAdapter,
} from './carrier-registry';

/**
 * The registry's guards (Story 4.6b). They run at IMPORT time, so a violation
 * takes the process down rather than producing a quietly wrong registry — and
 * that is exactly why they need a unit test: nothing in the e2e path can
 * reach a duplicate registration or a malformed adapter, because the module
 * would never have loaded.
 */
describe('registerCarrierAdapter (the import-time guards)', () => {
  const field = { name: 'apiToken', label: 'API token', required: true, description: 'Token.' };

  it('refuses a duplicate carrier code — an adapter is declared once', () => {
    expect(() =>
      registerCarrierAdapter({
        code: 'delhivery',
        displayName: 'Delhivery (again)',
        credentialFields: [field],
      }),
    ).toThrow('Carrier adapter already registered: delhivery');
    // The registry is unchanged by the rejected call.
    expect(getCarrierAdapter('delhivery')!.displayName).toBe('Delhivery');
  });

  it('refuses an adapter with no credential fields — there would be nothing to seal', () => {
    expect(() =>
      registerCarrierAdapter({ code: 'spec-empty', displayName: 'Empty', credentialFields: [] }),
    ).toThrow('declares no credential fields');
    expect(isKnownCarrierCode('spec-empty')).toBe(false);
  });

  it('refuses a duplicate field name within one adapter', () => {
    expect(() =>
      registerCarrierAdapter({
        code: 'spec-dupe-field',
        displayName: 'Dupe',
        credentialFields: [field, { ...field, label: 'Other' }],
      }),
    ).toThrow('duplicate field: apiToken');
    expect(isKnownCarrierCode('spec-dupe-field')).toBe(false);
  });

  it('registers the three direct carriers, code-sorted, and knows nothing else', () => {
    expect(knownCarrierCodes()).toEqual(['blue_dart', 'delhivery', 'ecom_express']);
    expect(listCarrierAdapters().map((adapter) => adapter.code)).toEqual(knownCarrierCodes());
    // Shiprocket is an aggregator and is deliberately out (the OQ1 decision).
    expect(getCarrierAdapter('shiprocket')).toBeUndefined();
    expect(isKnownCarrierCode('shiprocket')).toBe(false);
  });
});
