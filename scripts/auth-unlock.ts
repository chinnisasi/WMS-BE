/**
 * Story 6-1a (A3) — the CLI unlock, for when every owner is locked out:
 *   bun run auth:unlock <email>
 * Clears the sign-in lock on that email from every address, and (code review
 * C11) writes a `user.unlocked` audit row against the account with the system
 * as the actor and `cli` as the reference. The account is looked up on the
 * BYPASSRLS auth connection (`DATABASE_AUTH_URL`, falling back to
 * `DATABASE_URL`); every write goes through `DATABASE_URL`.
 */
import { eq } from 'drizzle-orm';
import { createDatabase, requiredDbUrl } from '../src/shared/db/db';
import { users } from '../src/shared/db/schema';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { unlockSignIn } from '../src/modules/tenancy/auth-attempts';
import { auditSecurityEventInTx } from '../src/modules/tenancy/sessions';

const email = process.argv[2]?.trim().toLowerCase();
if (email === undefined || !email.includes('@')) {
  console.error('usage: bun run auth:unlock <email>');
  process.exit(2);
}
const db = createDatabase();
const authDb = createDatabase(process.env.DATABASE_AUTH_URL || requiredDbUrl());
const cleared = await unlockSignIn(db, email);
const account = (await authDb.select({ id: users.id, tenantId: users.tenantId }).from(users).where(eq(users.email, email)).limit(1))[0];
if (account !== undefined) {
  await withTenantTransaction(db, account.tenantId, (tx) =>
    auditSecurityEventInTx(tx, {
      tenantId: account.tenantId,
      action: 'user.unlocked',
      targetType: 'user',
      targetId: account.id,
      actorUserId: null,
      reference: 'cli',
    }),
  );
}
process.stdout.write(`${cleared === 0 ? `${email}: no lock to clear` : `${email}: cleared ${cleared} lock record(s)`}\n`);
process.exit(0);
