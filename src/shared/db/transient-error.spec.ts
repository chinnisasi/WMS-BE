import { DrizzleQueryError } from 'drizzle-orm/errors';
import { isTransientDbError } from './transient-error';

/** Story 5-2a (A11) — what a subscriber may rethrow: connection and serialization faults only, wrapped or not. */
describe('isTransientDbError', () => {
  const pg = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

  it.each(['08006', '08000', '08P01', '40001', '40P01', '57P01', 'ECONNRESET', 'ECONNREFUSED', 'CONNECTION_CLOSED', 'CONNECT_TIMEOUT'])('%s is transient', (code) => {
    expect(isTransientDbError(pg(code))).toBe(true);
  });

  it.each(['23505', '23514', '22003', '42P01', 'P0001'])('%s is a data or code fault (acked)', (code) => {
    expect(isTransientDbError(pg(code))).toBe(false);
  });

  it('walks the cause chain: drizzle wraps the driver error (VG4)', () => {
    expect(isTransientDbError(new DrizzleQueryError('select 1', [], pg('40001')))).toBe(true);
    expect(isTransientDbError(new DrizzleQueryError('select 1', [], pg('23514')))).toBe(false);
    expect(isTransientDbError(new Error('no code'))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});
