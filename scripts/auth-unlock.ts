/**
 * Story 6-1a (A3) — the CLI unlock, for when every owner is locked out:
 *   bun run auth:unlock <email>
 * Clears the sign-in lock on that email from every address — and (story 6-1b)
 * the two-factor lock, in the account's tenant transaction — and (code review
 * C11) writes a `user.unlocked` audit row against the account with the system
 * as the actor and `cli` as the reference. The account is looked up on the
 * BYPASSRLS auth connection (`DATABASE_AUTH_URL`, falling back to
 * `DATABASE_URL`); every write goes through `DATABASE_URL`.
 */
import { eq, sql } from 'drizzle-orm';
import { createDatabase, requiredDbUrl } from '../src/shared/db/db';
import { users } from '../src/shared/db/schema';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { unlockSignIn } from '../src/modules/tenancy/auth-attempts';
import { auditSecurityEventInTx } from '../src/modules/tenancy/sessions';
import { clearSecondFactorLockInTx } from '../src/modules/tenancy/second-factor';

const email = process.argv[2]?.trim().toLowerCase();
if (email === undefined || !email.includes('@')) {
  console.error('usage: bun run auth:unlock <email>');
  process.exit(2);
}
const db = createDatabase();
const authDb = createDatabase(process.env.DATABASE_AUTH_URL || requiredDbUrl());
const cleared = await unlockSignIn(db, email);
const account = (await authDb.select({ id: users.id, tenantId: users.tenantId }).from(users).where(eq(users.email, email)).limit(1))[0];
let secondFactorCleared = 0;
if (account !== undefined) {
  secondFactorCleared = await withTenantTransaction(db, account.tenantId, async (tx) => {
    // Was there a two-factor lock (or a count toward one) to clear?
    const before = (await tx.execute(sql`
      select (mfa_locked_until is not null or mfa_failures > 0 or mfa_lock_cycles > 0) as held
        from users where tenant_id = ${account.tenantId} and id = ${account.id} for update
    `)) as unknown as Array<{ held: boolean }>;
    // Never on a bare connection: RLS would match nothing.
    await clearSecondFactorLockInTx(tx, account.tenantId, account.id);
    await auditSecurityEventInTx(tx, {
      tenantId: account.tenantId,
      action: 'user.unlocked',
      targetType: 'user',
      targetId: account.id,
      actorUserId: null,
      reference: 'cli',
    });
    return before[0]?.held === true ? 1 : 0;
  });
}
process.stdout.write(
  `${email}: password lock — ${cleared === 0 ? 'none to clear' : `cleared ${cleared} lock record(s)`}; ` +
    `two-factor lock — ${secondFactorCleared === 0 ? 'none to clear' : 'cleared'}\n`,
);
process.exit(0);
