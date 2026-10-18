import { ProblemException } from '../problem-details/problem.exception';
import { assertAddress, assertPhone, type AddressInput } from './address';

/**
 * Story 1-2a extracted `assertPhone` from `assertAddress` for the client
 * contacts. The shipment-address callers (order destinations, the warehouse
 * origin) must answer byte-identical problems: these pin the exact bodies
 * the pre-extraction loop produced for a phone.
 */
const ADDRESS: AddressInput = {
  contactName: 'Priya',
  phone: '+91 98450 12345',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560066',
};

function problemOf(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemException);
    return (error as ProblemException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a refusal');
}

describe('assertAddress phone refusals stay byte-identical after the assertPhone extraction (story 1-2a)', () => {
  it('an over-long phone: the label-qualified field, the ceiling and the length', () => {
    const body = problemOf(() => assertAddress({ ...ADDRESS, phone: '0'.repeat(21) }, 'destination'));
    expect(body).toMatchObject({
      code: 'validation-failed',
      status: 400,
      detail: 'destination.phone is at most 20 characters (got 21).',
      message: 'destination.phone is at most 20 characters (got 21).',
    });
    expect(problemOf(() => assertAddress({ ...ADDRESS, phone: '0'.repeat(25) }, 'origin')).detail).toBe(
      'origin.phone is at most 20 characters (got 25).',
    );
  });

  it('a blank phone is still the "incomplete" refusal, never assertPhone’s', () => {
    expect(problemOf(() => assertAddress({ ...ADDRESS, phone: '   ' }, 'destination')).detail).toBe(
      'destination is incomplete — missing destination.phone. An address is entered whole, never partial.',
    );
  });

  it('a phone at the ceiling passes and comes back trimmed', () => {
    expect(assertAddress({ ...ADDRESS, phone: ` ${'9'.repeat(20)} ` }, 'destination').phone).toBe('9'.repeat(20));
  });

  it('assertPhone itself: blank and over-long refused naming the field', () => {
    expect(problemOf(() => assertPhone('', 'phone')).detail).toBe('phone must not be blank.');
    expect(problemOf(() => assertPhone('1'.repeat(21), 'phone')).detail).toBe('phone is at most 20 characters (got 21).');
    expect(assertPhone('12345', 'phone')).toBe('12345');
  });
});
