/**
 * Story 6-1a (A3) — the CLI unlock, for when every owner is locked out:
 *   bun run auth:unlock <email>
 * Clears the sign-in lock on that email from every address. Uses the app's
 * `DATABASE_URL` (the table holds no tenant data and has no RLS).
 */
import { createDatabase } from '../src/shared/db/db';
import { unlockSignIn } from '../src/modules/tenancy/auth-attempts';

const email = process.argv[2];
if (email === undefined || !email.includes('@')) {
  console.error('usage: bun run auth:unlock <email>');
  process.exit(2);
}
const db = createDatabase();
const cleared = await unlockSignIn(db, email);
process.stdout.write(`${cleared === 0 ? `${email}: no lock to clear` : `${email}: cleared ${cleared} lock record(s)`}\n`);
process.exit(0);
