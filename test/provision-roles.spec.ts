import postgres from 'postgres';
import { missingProductionPasswords, scramSha256Verifier, setRolePassword } from '../src/shared/db/provision-roles';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

/**
 * Story 6-2a, code review C1/C2 — role passwords reach the server only as a
 * SCRAM-SHA-256 verifier computed in Node, and production refuses to run
 * without both. The login proof is real: the role connects with the
 * password after `setRolePassword` stored only the verifier.
 *
 * The probe role is cluster-wide; role changes run under the cross-suite
 * role lock (742105, `test/users.spec.ts`).
 */
jest.setTimeout(30_000);
const ROLE_LOCK = 742105;
const ROLE = 'wms_scram_probe';

describe('role passwords (story 6-2a, C1/C2)', () => {
  let suiteDb: SuiteDatabase;
  let admin: postgres.Sql<Record<string, unknown>>;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('provision_roles');
    admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
  });

  afterAll(async () => {
    await admin?.end();
    await suiteDb?.drop();
  });

  it('the verifier has the server\'s shape, a fresh 16-byte salt each time, and matches a known vector', () => {
    const verifier = scramSha256Verifier('pencil');
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
    expect(scramSha256Verifier('pencil')).not.toBe(verifier);
    // RFC 7677's example user "user" / "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, 4096 iterations.
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    expect(scramSha256Verifier('pencil', salt)).toBe(
      'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=',
    );
  });

  it('a role whose password was set from the verifier logs in with that password, and only the verifier is stored', async () => {
    const password = `probe-${Date.now()}`;
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${ROLE_LOCK})`;
      await tx.unsafe(`
        do $$ begin
          if not exists (select from pg_roles where rolname = '${ROLE}') then
            create role ${ROLE} login nosuperuser;
          end if;
        end $$;`);
      await setRolePassword(tx as unknown as postgres.Sql<Record<string, unknown>>, ROLE, password);
    });
    const [stored] = await admin<{ rolpassword: string }[]>`select rolpassword from pg_authid where rolname = ${ROLE}`;
    expect(stored!.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(stored!.rolpassword).not.toContain(password);

    const url = new URL(process.env.DATABASE_URL!);
    url.username = ROLE;
    url.password = password;
    const asRole = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      const [who] = await asRole<{ who: string }[]>`select current_user as who`;
      expect(who!.who).toBe(ROLE);
    } finally {
      await asRole.end();
    }
    // And a wrong password is refused (the verifier is not a pass-anything).
    url.password = `${password}-wrong`;
    const wrong = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      await expect(wrong`select 1`).rejects.toMatchObject({ code: '28P01' });
    } finally {
      await wrong.end();
    }
  });

  it('a role name that is not a plain identifier is refused before anything is sent', async () => {
    await expect(setRolePassword(admin, 'x"; drop role y; --', 'p')).rejects.toThrow('not a plain identifier');
  });

  it('production requires both passwords (C2)', () => {
    expect(missingProductionPasswords({ NODE_ENV: 'production' })).toEqual(['WMS_APP_PASSWORD', 'WMS_AUTH_PASSWORD']);
    expect(missingProductionPasswords({ NODE_ENV: 'production', WMS_APP_PASSWORD: 'a', WMS_AUTH_PASSWORD: '' })).toEqual([
      'WMS_AUTH_PASSWORD',
    ]);
    expect(missingProductionPasswords({ NODE_ENV: 'production', WMS_APP_PASSWORD: 'a', WMS_AUTH_PASSWORD: 'b' })).toEqual([]);
    expect(missingProductionPasswords({})).toEqual([]);
  });
});
