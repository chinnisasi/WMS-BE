/**
 * A full shipment address (story 11-1) for the e2e suites — the destination
 * on order creates and the origin on warehouse creates are both REQUIRED at
 * create, so every suite that seeds through those commands needs one.
 *
 * Fresh object per call: suites mutate request bodies freely and a shared
 * literal would leak mutations between scenarios. `overrides` patches single
 * fields (or drops them with `undefined`) without re-typing the rest.
 */
export function testAddress(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contactName: 'Priya Sharma',
    phone: '+91 98450 12345',
    line1: '12, Peenya Industrial Area',
    line2: 'Gate 3',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560066',
    ...overrides,
  };
}