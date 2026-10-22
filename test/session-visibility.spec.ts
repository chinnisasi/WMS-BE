import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { createDatabase, type Database } from '../src/shared/db/db';
import { checkSessionVisibility, openSessionsInTx, sessionVisibilityAdviceInTx } from '../src/shared/db/open-transactions';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { uuidv7 } from '../src/shared/primitives/ids';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

/**
 * Epic 9 retro F1 / action item 1 — the §7d probe (`openSessionsInTx`) under
 * the PRODUCTION two-role setup, never the superuser every other suite runs as.
 *
 * The real `scripts/provision-roles.sql` is executed with its two role names
 * renamed (`wms_app` → `wms_sv_app`, `wms_auth` → `wms_sv_auth`) and its
 * placeholder passwords filled in. Then, with one `wms_sv_auth` session
 * holding a transaction open and another connected and idle:
 *
 *   - positive: the app role SEES the held transaction and nothing is hidden
 *     (the script's `pg_read_all_stats` grant is what makes this hold — the
 *     setup revokes it first, so the grant must come from the script);
 *   - negative control: with the grant revoked, the probe reports the hidden
 *     sessions. This is also the regression pin for the probe's filter: the
 *     old `backend_type = 'client backend'` filter dropped every hidden row
 *     (a hidden row's `backend_type` is NULL) and read `hidden: false` here;
 *   - re-run: the script is idempotent.
 *
 * The roles are cluster-wide and left in place (the `wms_rls_probe`
 * precedent). Every role change runs under the cross-suite role lock 742105
 * (`test/users.spec.ts`), since concurrent CREATE ROLE / GRANT trip "tuple
 * concurrently updated" on the shared catalogs.
 */
const ROLE_LOCK = 742105;
const APP = 'wms_sv_app';
const AUTH = 'wms_sv_auth';
const APP_PASSWORD = 'wms_sv_app_pw';
const AUTH_PASSWORD = 'wms_sv_auth_pw';

type Sql = postgres.Sql<Record<string, unknown>>;

function substitutedScript(): string {
  const original = readFileSync(join(__dirname, '..', 'scripts', 'provision-roles.sql'), 'utf8');
  // The substitution must bite: a renamed role or placeholder would otherwise
  // run the script against the REAL role names, silently.
  expect(original).toMatch(/\bwms_app\b/);
  expect(original).toMatch(/\bwms_auth\b/);
  expect(original).toContain("'change-me-app'");
  expect(original).toContain("'change-me-auth'");
  const script = original
    .replace(/\bwms_app\b/g, APP)
    .replace(/\bwms_auth\b/g, AUTH)
    .replace(/'change-me-app'/g, `'${APP_PASSWORD}'`)
    .replace(/'change-me-auth'/g, `'${AUTH_PASSWORD}'`);
  expect(script).not.toMatch(/\bwms_(app|auth)\b|'change-me-(app|auth)'/);
  return script;
}

function urlAs(base: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
}

describe('session visibility — the §7d probe under the provisioned two-role setup (Epic 9 retro F1)', () => {
  let suiteDb: SuiteDatabase;
  let admin: Sql;
  let authHeld: Sql;
  let authIdle: Sql;
  let appDb: Database;
  let script: string;
  let heldStart: Date;
  let releaseHeld: () => void = () => undefined;
  let heldDone: Promise<unknown> = Promise.resolve();

  async function underRoleLock(fn: (tx: postgres.TransactionSql<Record<string, unknown>>) => Promise<unknown>): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${ROLE_LOCK})`;
      await fn(tx);
    });
  }

  const probe = () => withTenantTransaction(appDb, uuidv7(), (tx) => openSessionsInTx(tx));

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('session_visibility');
    const suiteUrl = process.env.DATABASE_URL!;
    admin = postgres(suiteUrl, { max: 1, onnotice: () => undefined });
    script = substitutedScript();

    await underRoleLock(async (tx) => {
      // Start from "no grant", so the positive case proves the SCRIPT grants
      // it — a grant left behind by an earlier run must not stand in for it.
      await tx.unsafe(`
        do $$ begin
          if exists (select from pg_roles where rolname = '${APP}') then
            revoke pg_read_all_stats from ${APP};
          end if;
        end $$;
      `);
      // A role left by an earlier run with another password could not log in:
      // the script never changes an existing role's password.
      await tx.unsafe(`
        do $$ begin
          if exists (select from pg_roles where rolname = '${APP}') then
            alter role ${APP} password '${APP_PASSWORD}';
          end if;
          if exists (select from pg_roles where rolname = '${AUTH}') then
            alter role ${AUTH} password '${AUTH_PASSWORD}';
          end if;
        end $$;
      `);
      await tx.unsafe(script);
    });

    authHeld = postgres(urlAs(suiteUrl, AUTH, AUTH_PASSWORD), { max: 1, onnotice: () => undefined });
    authIdle = postgres(urlAs(suiteUrl, AUTH, AUTH_PASSWORD), { max: 1, onnotice: () => undefined });
    // The rewritten URLs must actually log in as the intended role (a
    // unix-socket URL, for one, can ignore the username).
    expect((await authIdle<{ who: string }[]>`select current_user as who`)[0]!.who).toBe(AUTH); // connected, then idle
    let started!: (start: Date) => void;
    const startedAt = new Promise<Date>((resolve) => (started = resolve));
    const released = new Promise<void>((resolve) => (releaseHeld = resolve));
    heldDone = authHeld.begin(async (tx) => {
      const [row] = await tx<{ start: Date; who: string }[]>`select now() as start, current_user as who`;
      expect(row!.who).toBe(AUTH);
      started(row!.start);
      await released;
    });
    // Never hang to the jest timeout: a transaction that settles (or rejects)
    // before reporting its start fails the setup at once.
    heldStart = await Promise.race([
      startedAt,
      heldDone.then(() => {
        throw new Error('the held auth transaction settled before reporting its start');
      }),
    ]);

    appDb = createDatabase(urlAs(suiteUrl, APP, APP_PASSWORD));
    const [who] = (await appDb.execute(dsql`select current_user as who`)) as unknown as { who: string }[];
    expect(who!.who).toBe(APP);
  });

  afterAll(async () => {
    releaseHeld();
    await heldDone.catch(() => undefined);
    await authHeld?.end();
    await authIdle?.end();
    await (appDb as unknown as { $client?: { end(): Promise<void> } } | undefined)?.$client?.end();
    await admin?.end();
    await suiteDb?.drop();
  });

  it('the roles are what the script says: the app role is plain, the auth role BYPASSRLS, only the app role reads all stats', async () => {
    const roles = await admin<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; stats: boolean }[]>`
      select rolname, rolsuper, rolbypassrls, pg_has_role(rolname, 'pg_read_all_stats', 'USAGE') as stats
      from pg_roles where rolname in (${APP}, ${AUTH}) order by rolname`;
    expect(roles).toEqual([
      { rolname: APP, rolsuper: false, rolbypassrls: false, stats: true },
      { rolname: AUTH, rolsuper: false, rolbypassrls: true, stats: false },
    ]);
  });

  it('story 6-2a (A2): the provisioned app role READS drizzle\'s migrations table (the readiness check) and cannot write it', async () => {
    const [applied] = (await appDb.execute(
      dsql`select count(*)::int as n, max(created_at)::text as at from drizzle.__drizzle_migrations`,
    )) as unknown as { n: number; at: string | null }[];
    expect(applied!.n).toBeGreaterThan(0);
    expect(applied!.at).not.toBeNull();
    // The grant is select only: a write is refused 42501.
    await expect(
      appDb.execute(dsql`delete from drizzle.__drizzle_migrations where id = -1`),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('positive: the provisioned app role SEES the auth role\'s open transaction and reports nothing hidden', async () => {
    const result = await probe();
    expect(result).toMatchObject({ hidden: false, hiddenCount: 0 });
    // Seen, not merely tolerated: an oldest start exists and is no later than
    // the held transaction's (both millisecond-truncated).
    expect(result.oldestXactStart).not.toBeNull();
    expect(Date.parse(result.oldestXactStart!)).toBe(heldStart.getTime());
  });

  it('the boot check: the provisioned app role reads as visible and logs nothing', async () => {
    const warnings: string[] = [];
    expect(await checkSessionVisibility(appDb, { warn: (m) => warnings.push(m) }, 'test worker')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('negative control (and the filter\'s regression pin): without the grant the probe reports the hidden sessions', async () => {
    await underRoleLock((tx) => tx.unsafe(`revoke pg_read_all_stats from ${APP}`));
    try {
      const [member] = await admin<{ member: boolean }[]>`select pg_has_role(${APP}, 'pg_read_all_stats', 'MEMBER') as member`;
      expect(member!.member).toBe(false);
      // Revocation binds in sessions already open — no reconnect.
      const result = await probe();
      expect(result.hidden).toBe(true);
      expect(result.hiddenCount).toBeGreaterThanOrEqual(2); // the held and the idle auth sessions
      // The refusal advice names the role and prints the exact GRANT.
      const advice = await withTenantTransaction(appDb, uuidv7(), (tx) => sessionVisibilityAdviceInTx(tx));
      expect(advice).toContain(`GRANT pg_read_all_stats TO ${APP};`);
      // The boot check warns exactly once, with the same GRANT, and never throws.
      const warnings: string[] = [];
      expect(await checkSessionVisibility(appDb, { warn: (m) => warnings.push(m) }, 'test worker')).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`GRANT pg_read_all_stats TO ${APP};`);
    } finally {
      await underRoleLock((tx) => tx.unsafe(`grant pg_read_all_stats to ${APP}`));
    }
    // And the grant restores visibility.
    expect(await probe()).toMatchObject({ hidden: false, hiddenCount: 0 });
  });

  it('the boot check never throws: a failed check is one warning, and reads as not visible', async () => {
    const warnings: string[] = [];
    const broken = { execute: () => Promise.reject(new Error('connection refused')) } as unknown as Parameters<typeof checkSessionVisibility>[0];
    expect(await checkSessionVisibility(broken, { warn: (m) => warnings.push(m) }, 'test worker')).toBe(false);
    expect(warnings).toEqual([expect.stringContaining('connection refused')]);
  });

  it('the script is idempotent: a second run succeeds and changes nothing', async () => {
    const state = () => admin<{ grantee: string; grants: string }[]>`
      select r.rolname as grantee,
             concat_ws('|', r.rolsuper, r.rolbypassrls, r.rolcanlogin,
               pg_has_role(r.rolname, 'pg_read_all_stats', 'MEMBER'),
               (select count(*) from information_schema.role_table_grants g where g.grantee = r.rolname),
               has_schema_privilege(r.rolname, 'public', 'USAGE')) as grants
      from pg_roles r where r.rolname in (${APP}, ${AUTH}) order by r.rolname`;
    const before = await state();
    await underRoleLock((tx) => tx.unsafe(script));
    expect(await state()).toEqual(before);
    expect(await probe()).toMatchObject({ hidden: false, hiddenCount: 0 });
  });
});
