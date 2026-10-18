/**
 * Story 6-1b — the CLI reset, for the sole owner who lost their
 * authenticator and their backup codes (or every owner, after losing
 * `MFA_ENCRYPTION_KEY`):
 *   bun run auth:reset-2fa <email>
 * Clears the user's two-factor sign-in exactly as an owner's web reset does
 * (`resetSecondFactorInTx`: the factor, the backup codes, the lock, any sign-in
 * in progress; their web sessions end) and prints the one-time enrolment code
 * (72 h) their next sign-in needs. Audited `user.second_factor_reset` against
 * the account with the system as the actor and `cli` as the reference. The
 * account is looked up on the BYPASSRLS auth connection (`DATABASE_AUTH_URL`,
 * falling back to `DATABASE_URL`); every write runs in the account's tenant
 * transaction on `DATABASE_URL`.
 */
import { eq, sql } from 'drizzle-orm';
import { createDatabase, requiredDbUrl } from '../src/shared/db/db';
import { users } from '../src/shared/db/schema';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { auditSecurityEventInTx } from '../src/modules/tenancy/sessions';
import { resetSecondFactorInTx } from '../src/modules/tenancy/second-factor.command';

const email = process.argv[2]?.trim().toLowerCase();
if (email === undefined || !email.includes('@')) {
  console.error('usage: bun run auth:reset-2fa <email>');
  process.exit(2);
}
const db = createDatabase();
const authDb = createDatabase(process.env.DATABASE_AUTH_URL || requiredDbUrl());
const account = (
  await authDb
    .select({ id: users.id, tenantId: users.tenantId, clientId: users.clientId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
)[0];
if (account === undefined) {
  console.error(`${email}: no such account`);
  process.exit(1);
}
// The portal has no second factor (decision 4): there is nothing to reset.
if (account.clientId !== null) {
  console.error(`${email}: a client-portal user — two-factor sign-in does not apply`);
  process.exit(1);
}
// Mirrors the web reset: lock the row; nothing to reset → no write, no audit row.
const reset = await withTenantTransaction(db, account.tenantId, async (tx) => {
  const rows = (await tx.execute(sql`
    select (mfa_enabled_at is null and mfa_enrol_code_hash is null) as nothing
      from users where tenant_id = ${account.tenantId} and id = ${account.id} for update
  `)) as unknown as Array<{ nothing: boolean }>;
  if (rows[0]?.nothing === true) return null;
  const issued = await resetSecondFactorInTx(tx, account.tenantId, account.id);
  await auditSecurityEventInTx(tx, {
    tenantId: account.tenantId,
    action: 'user.second_factor_reset',
    targetType: 'user',
    targetId: account.id,
    actorUserId: null,
    reference: 'cli',
  });
  return issued;
});
if (reset === null) {
  process.stdout.write(`${email}: nothing to reset — two-factor sign-in is not set up and no enrolment code is outstanding.\n`);
  process.exit(0);
}
process.stdout.write(
  `${email}: two-factor sign-in reset. Enrolment code: ${reset.enrolmentCode} (valid until ${reset.enrolmentCodeExpiresAt}).\n` +
    'Hand it over in person; the next sign-in sets up a new authenticator with it.\n',
);
process.exit(0);
