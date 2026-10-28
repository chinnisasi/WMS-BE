import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { uuidv7 } from '../src/shared/primitives/ids';
import { createDatabase } from '../src/shared/db/db';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';

jest.setTimeout(120_000);

const MIGRATION = '0106_blocked_locations.sql';

function migrationStatements(): string[] {
  return readFileSync(resolve(process.cwd(), 'drizzle', MIGRATION), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Story 3-3b (A5, guide §5) — migration 0106's DATA statements against a
 * database standing at 0105 that already holds blocked bins (the pre-3-3b
 * PATCH toggle): one whose block wrote a `bin.blocked` audit row (twice — the
 * PATCH wrote one action for block AND unblock, so the newest is the block),
 * one blocked before the audit trail (no row), and an active bin. Applied whole
 * in one transaction, as the real runner applies it: every blocked bin gets
 * reason `other` with the backfill note, `blocked_at` from its newest audit
 * row (else `updated_at`) and a null blocker; the active bin stays clean; the
 * pre-flight NOTICE counts the blocked bins; a re-run is refused by the
 * fail-fast guard.
 */
describe('migration 0106: pre-3-3b blocked bins are backfilled', () => {
  const PRE_DB = 'wms_s_blocked_locations_premigration';
  let sql: ReturnType<typeof postgres>;
  let preUrl: string;
  let folder: string;
  const notices: string[] = [];

  const tenantId = uuidv7();
  const warehouseId = uuidv7();
  const zoneId = uuidv7();
  const audited = uuidv7(); // blocked, with two `bin.blocked` audit rows
  const unaudited = uuidv7(); // blocked before the audit trail
  const active = uuidv7(); // never blocked
  const actor = uuidv7();
  const unauditedUpdatedAt = '2026-01-02T03:04:05.678Z';
  const olderAuditAt = '2026-03-01T00:00:00.000Z';
  const newestAuditAt = '2026-04-15T09:30:00.250Z';

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL!;
    const url = new URL(baseUrl);
    url.pathname = `/${PRE_DB}`;
    preUrl = url.toString();
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
      await admin.unsafe(`drop database if exists "${PRE_DB}"`);
      await admin.unsafe(`create database "${PRE_DB}"`);
    } finally {
      await admin.end();
    }

    // The "before" state from the repo's own history: every migration up to
    // and including 0105, then rows written through that schema.
    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0106-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, MIGRATION));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 105);
    writeFileSync(journalPath, JSON.stringify(journal));
    const db = createDatabase(preUrl);
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl, { max: 2, onnotice: (notice) => void notices.push(String(notice.message)) });
    await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, blocked, updated_at) values
      (${audited}, ${tenantId}, ${warehouseId}, ${zoneId}, 'A-01', 10000, 'shelf', true, now()),
      (${unaudited}, ${tenantId}, ${warehouseId}, ${zoneId}, 'A-02', 10000, 'shelf', true, ${unauditedUpdatedAt}),
      (${active}, ${tenantId}, ${warehouseId}, ${zoneId}, 'A-03', 10000, 'shelf', false, now())`;
    // The PATCH wrote `bin.blocked` for both directions: an older toggle and
    // the newest (the block standing now). `created_at` is the commit stamp
    // the backfill orders on; another bin's row must not leak in.
    await sql`insert into audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, reference, occurred_at, created_at) values
      (${uuidv7()}, ${tenantId}, ${actor}, 'bin.blocked', 'bin', ${audited}, 'k1', ${olderAuditAt}, ${olderAuditAt}),
      (${uuidv7()}, ${tenantId}, ${actor}, 'bin.blocked', 'bin', ${audited}, 'k2', ${newestAuditAt}, ${newestAuditAt}),
      (${uuidv7()}, ${tenantId}, ${actor}, 'bin.created', 'bin', ${audited}, 'k0', now(), now()),
      (${uuidv7()}, ${tenantId}, ${actor}, 'bin.blocked', 'bin', ${active}, 'k3', now(), now())`;
  });

  afterAll(async () => {
    await sql?.end();
    rmSync(folder, { recursive: true, force: true });
    const adminUrl = new URL(process.env.DATABASE_URL!);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
      await admin.unsafe(`drop database if exists "${PRE_DB}"`);
    } finally {
      await admin.end();
    }
  });

  it('backfills every blocked bin (reason other, the backfill note, blocked_at from its newest bin.blocked audit row else updated_at, no blocker), leaves the active bin clean, counts them, and refuses a re-run', async () => {
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) await tx.unsafe(statement);
    });
    const rows = (await sql`
      select id, blocked, blocked_reason, blocked_note, blocked_at, blocked_by
        from bins where tenant_id = ${tenantId} order by code`) as unknown as {
      id: string;
      blocked: boolean;
      blocked_reason: string | null;
      blocked_note: string | null;
      blocked_at: Date | null;
      blocked_by: string | null;
    }[];
    const note = 'Blocked before story 3-3b recorded reasons';
    expect(rows.map((row) => ({ ...row, blocked_at: row.blocked_at === null ? null : row.blocked_at.toISOString() }))).toEqual([
      { id: audited, blocked: true, blocked_reason: 'other', blocked_note: note, blocked_at: newestAuditAt, blocked_by: null },
      { id: unaudited, blocked: true, blocked_reason: 'other', blocked_note: note, blocked_at: unauditedUpdatedAt, blocked_by: null },
      { id: active, blocked: false, blocked_reason: null, blocked_note: null, blocked_at: null, blocked_by: null },
    ]);
    // The pre-flight count (the release note's figure).
    expect(notices.some((notice) => /migration 0106: 2 bin\(s\) are blocked/.test(notice))).toBe(true);

    // Both CHECKs are present and NOT VALID (A4 — the VALIDATEs are a later deploy's).
    const checks = (await sql`
      select conname, convalidated from pg_constraint
       where conname in ('bins_blocked_pairing', 'picklist_lines_reason_code_check') order by conname`) as unknown as {
      conname: string;
      convalidated: boolean;
    }[];
    expect(checks).toEqual([
      { conname: 'bins_blocked_pairing', convalidated: false },
      { conname: 'picklist_lines_reason_code_check', convalidated: false },
    ]);

    // The fail-fast guard: a second run raises before it touches anything.
    await expect(
      sql.begin(async (tx) => {
        for (const statement of migrationStatements()) await tx.unsafe(statement);
      }),
    ).rejects.toThrow(/migration 0106: bins\.blocked_reason already exists/);
  });
});
