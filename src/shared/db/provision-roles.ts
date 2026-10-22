/**
 * Story 6-2a — runs `scripts/provision-roles.sql` (A10): on EVERY deploy,
 * after `db:migrate:deploy`, as the migrating owner (`DATABASE_URL` is the
 * owner's here — a superuser or a managed Postgres's master user — never
 * `wms_app`). The script is idempotent: existing roles keep their passwords
 * and every grant re-applies.
 *
 *   bun run db:provision-roles
 *
 * Passwords are set out of band, never in the script or the image: when
 * `WMS_APP_PASSWORD` / `WMS_AUTH_PASSWORD` are present in the migrate task's
 * environment (from the secrets manager), each is applied with
 * `ALTER ROLE … PASSWORD` after the script — as a SCRAM-SHA-256 verifier
 * computed here (code review C1), so the plaintext never reaches the server
 * or its logs. Unset, a role keeps the password it has; with
 * `NODE_ENV=production` both are required (C2 — exit 1).
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

export const PROVISION_ROLES_SQL = join(__dirname, '..', '..', '..', 'scripts', 'provision-roles.sql');

export const ROLE_PASSWORD_ENV = { wms_app: 'WMS_APP_PASSWORD', wms_auth: 'WMS_AUTH_PASSWORD' } as const;

/**
 * Code review C1 — the SCRAM-SHA-256 verifier Postgres stores for a password
 * (`pg_authid.rolpassword`), computed HERE, so only the verifier reaches the
 * server: never the plaintext, not as a bind parameter, not inside a
 * statement the server could log.
 *
 *   SCRAM-SHA-256$<iterations>:<b64 salt>$<b64 StoredKey>:<b64 ServerKey>
 *
 * SaltedPassword = PBKDF2-HMAC-SHA-256(password, salt, iterations, 32);
 * ClientKey = HMAC(SaltedPassword, "Client Key"); StoredKey = SHA-256(ClientKey);
 * ServerKey = HMAC(SaltedPassword, "Server Key") — RFC 5802 / 7677, the
 * server's own `scram_build_secret`. (No SASLprep: the deploy's passwords are
 * generated ASCII, where SASLprep is the identity.)
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

type Sql = postgres.Sql<Record<string, unknown>>;

/** Sets a role's password from its verifier (the plaintext never leaves this process). */
export async function setRolePassword(sql: Sql, role: string, password: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`role name "${role}" is not a plain identifier`);
  const verifier = scramSha256Verifier(password);
  // The verifier is base64 plus `$` and `:` — no quote can occur in it.
  if (!/^[A-Za-z0-9+/=$:-]+$/.test(verifier)) throw new Error('unexpected verifier shape');
  await sql.unsafe(`alter role "${role}" password '${verifier}'`);
}

/**
 * Code review C2 — in production both passwords are REQUIRED: skipping an
 * unset one would leave a role created on first deploy at the script's
 * `change-me-*` placeholder. Returns the variables that are missing.
 */
export function missingProductionPasswords(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  return Object.values(ROLE_PASSWORD_ENV).filter((variable) => (env[variable] ?? '') === '');
}

export async function provisionRoles(url: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  const passwordsSet: string[] = [];
  try {
    await sql.unsafe(readFileSync(PROVISION_ROLES_SQL, 'utf8'));
    for (const [role, variable] of Object.entries(ROLE_PASSWORD_ENV)) {
      const password = env[variable];
      if (password === undefined || password === '') continue;
      await setRolePassword(sql, role, password);
      passwordsSet.push(role);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return passwordsSet;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required (the migrating owner, not wms_app)');
    process.exit(1);
  }
  const missing = missingProductionPasswords();
  if (missing.length > 0) {
    console.error(`NODE_ENV=production: ${missing.join(' and ')} must be set (a role would keep its change-me placeholder)`);
    process.exit(1);
  }
  try {
    const passwordsSet = await provisionRoles(url);
    // eslint-disable-next-line no-console
    console.log(
      `Roles provisioned${passwordsSet.length > 0 ? ` (passwords set for ${passwordsSet.join(', ')})` : ''}.`,
    );
    process.exit(0);
  } catch (err) {
    console.error('Role provisioning failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (require.main === module) void main();
