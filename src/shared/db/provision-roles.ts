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
 * `ALTER ROLE … PASSWORD` after the script — quoted by the server
 * (`format('%L')`), never interpolated here. Unset, a role keeps the
 * password it has (on first creation, the script's placeholder: set one).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

export const PROVISION_ROLES_SQL = join(__dirname, '..', '..', '..', 'scripts', 'provision-roles.sql');

export const ROLE_PASSWORD_ENV = { wms_app: 'WMS_APP_PASSWORD', wms_auth: 'WMS_AUTH_PASSWORD' } as const;

export async function provisionRoles(url: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  const passwordsSet: string[] = [];
  try {
    await sql.unsafe(readFileSync(PROVISION_ROLES_SQL, 'utf8'));
    for (const [role, variable] of Object.entries(ROLE_PASSWORD_ENV)) {
      const password = env[variable];
      if (password === undefined || password === '') continue;
      const [statement] = await sql<{ statement: string }[]>`
        select format('alter role %I password %L', ${role}::text, ${password}::text) as statement`;
      await sql.unsafe(statement!.statement);
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
