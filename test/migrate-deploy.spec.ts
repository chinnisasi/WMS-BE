import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import {
  IF_NOT_EXISTS_LINT_FROM,
  MIGRATE_LOCK_KEY,
  concurrentlyStatement,
  indexesWithoutIfNotExists,
  migrateDeploy,
  parseCreateIndex,
  planMigrations,
  normalizeIndexDefinition,
  parseCliArgs,
  splitStatements,
  stripSqlComments,
  type MigrateDeployOptions,
  type PlanInspector,
} from '../src/shared/db/migrate-deploy';

/**
 * Story 6-2a — the guarded deploy migrator (decision 7, A3–A6).
 *
 * The refusals run against a REAL scratch database whose tables carry a real
 * size: rows inserted and `ANALYZE`d for the row estimate, and a table never
 * analysed (autovacuum off, no index ever built on it — an index build would
 * set `reltuples`) for the size fallback. The thresholds are lowered so the
 * fixtures stay small; the rule under test is the same.
 *
 * The migrations are a synthetic folder (a journal + files) grown one
 * migration at a time, run through the same `migrateDeploy` the CLI runs —
 * drizzle's own reader and runner underneath.
 */
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
const BASE_URL = process.env.DATABASE_URL;
const SCRATCH = 'wms_s_migrate_deploy';
const FRESH = 'wms_s_migrate_deploy_fresh';
const THRESHOLDS = { rows: 1_000, bytes: 256 * 1024 };
// Creating and dropping whole databases outlives jest's 5 s default.
jest.setTimeout(60_000);

type Sql = postgres.Sql<Record<string, unknown>>;

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function recreate(name: string): Promise<void> {
  const admin = postgres(withDatabase(BASE_URL, 'postgres'), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}'`);
    await admin.unsafe(`drop database if exists "${name}"`);
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = postgres(withDatabase(BASE_URL, 'postgres'), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}'`);
    await admin.unsafe(`drop database if exists "${name}"`);
  } finally {
    await admin.end();
  }
}

/** A synthetic migrations folder, grown one file at a time. */
class Folder {
  readonly path = mkdtempSync(join(tmpdir(), 'wms-migrate-deploy-'));
  private readonly entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] = [];

  constructor() {
    mkdirSync(join(this.path, 'meta'));
    this.flush();
  }

  add(name: string, statements: string[]): string {
    const idx = this.entries.length;
    const tag = `${String(idx).padStart(4, '0')}_${name}`;
    writeFileSync(join(this.path, `${tag}.sql`), statements.join('--> statement-breakpoint\n'));
    this.entries.push({ idx, version: '7', when: 1_800_000_000_000 + idx * 1_000, tag, breakpoints: true });
    this.flush();
    return tag;
  }

  get count(): number {
    return this.entries.length;
  }

  private flush(): void {
    writeFileSync(
      join(this.path, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries: this.entries }),
    );
  }

  remove(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}

describe('the guarded deploy migrator (story 6-2a)', () => {
  describe('the parser (A5)', () => {
    it('reads every CREATE INDEX shape the migrations use', () => {
      expect(parseCreateIndex('CREATE INDEX "a_idx" ON "t" USING btree ("x")')).toEqual({
        unique: false,
        concurrently: false,
        ifNotExists: false,
        name: 'a_idx',
        table: { schema: 'public', table: 't' },
      });
      expect(parseCreateIndex('create unique index if not exists "b" on "s"."t" ("x") where y is not null')).toMatchObject({
        unique: true,
        ifNotExists: true,
        name: 'b',
        table: { schema: 's', table: 't' },
      });
      expect(parseCreateIndex('CREATE INDEX plain_name ON ONLY Ledger (x)')).toMatchObject({
        name: 'plain_name',
        table: { schema: 'public', table: 'ledger' },
      });
      expect(parseCreateIndex('ALTER TABLE "t" ADD COLUMN "x" int')).toBeNull();
    });

    it('the CONCURRENTLY statement is the same index, CONCURRENTLY and IF NOT EXISTS', () => {
      expect(concurrentlyStatement('CREATE INDEX "a" ON "t" USING btree ("x");')).toBe(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "a" ON "t" USING btree ("x");',
      );
      expect(
        concurrentlyStatement(`CREATE UNIQUE INDEX IF NOT EXISTS "u" ON "t" ("x") WHERE "reference_doc" ? 'k'`),
      ).toBe(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "u" ON "t" ("x") WHERE "reference_doc" ? 'k';`);
    });

    it("splits on drizzle's breakpoint and strips comments, never inside quotes or a dollar body", () => {
      const statements = splitStatements(
        [
          "-- a header\nCREATE INDEX \"a\" ON \"t\" (\"x\"); -- trailing",
          "/* block */ INSERT INTO t VALUES ('-- not a comment')",
          'DO $$ BEGIN -- kept: the body is judged whole\n PERFORM 1; END $$',
          '-- only a comment',
        ].join('--> statement-breakpoint\n'),
      );
      expect(statements).toEqual([
        'CREATE INDEX "a" ON "t" ("x");',
        "INSERT INTO t VALUES ('-- not a comment')",
        'DO $$ BEGIN -- kept: the body is judged whole\n PERFORM 1; END $$',
      ]);
      expect(stripSqlComments('select 1 -- x\n')).toBe('select 1 \n');
    });
  });

  describe('the plan, over a stubbed estimate (the seam)', () => {
    const big = { reltuples: 5_000, bytes: 1 };
    const stub = (over: Partial<PlanInspector> = {}): PlanInspector => ({
      estimate: async () => big,
      index: async () => ({ exists: false }),
      anyLargeTable: async () => true,
      ...over,
    });

    it('unparsed statements — a DO/EXECUTE block naming INDEX, a UNIQUE/PRIMARY KEY constraint — are refused on a large table, and not on one the pending set creates', async () => {
      const findings = await planMigrations(
        [
          {
            tag: '0001_x',
            statements: [
              `DO $$ BEGIN EXECUTE format('CREATE INDEX %I ON big (x)', 'n'); END $$`,
              'ALTER TABLE "big" ADD CONSTRAINT "big_pk" PRIMARY KEY ("id")',
              'CREATE TABLE "fresh" ("id" int)',
              'ALTER TABLE "fresh" ADD CONSTRAINT "fresh_x_unique" UNIQUE ("id")',
              // A trigger is not a dynamic EXECUTE.
              'CREATE TRIGGER g BEFORE UPDATE ON "big" FOR EACH ROW EXECUTE FUNCTION f()',
            ],
          },
        ],
        stub(),
        THRESHOLDS,
      );
      expect(findings.map((f) => [f.kind, f.refused, f.table])).toEqual([
        ['unparsed', true, 'public.big'],
        ['unparsed', true, 'public.big'],
        ['unparsed', false, null],
      ]);
      expect(findings[0]!.advice).toContain('unparsed, review');
    });

    it('a DO block naming no table is refused only while the database holds a large table', async () => {
      const block = { tag: '0001_x', statements: [`DO $$ BEGIN EXECUTE 'CREATE INDEX n ON ' || 'x(y)'; END $$`] };
      expect((await planMigrations([block], stub({ anyLargeTable: async () => true }), THRESHOLDS))[0]!.refused).toBe(true);
      expect((await planMigrations([block], stub({ anyLargeTable: async () => false }), THRESHOLDS))[0]!.refused).toBe(false);
    });

    it('an index name already used on ANOTHER table is refused (IF NOT EXISTS would silently skip it)', async () => {
      const [finding] = await planMigrations(
        [{ tag: '0001_x', statements: ['CREATE INDEX IF NOT EXISTS "n" ON "big" ("x")'] }],
        stub({ index: async () => ({ exists: true, valid: true, onTable: { schema: 'public', table: 'other' } }) }),
        THRESHOLDS,
      );
      expect(finding).toMatchObject({ kind: 'name-collision', refused: true });
    });

    it('an index DROPPED earlier in the pending set and re-created cannot be pre-built: refused (0078\'s qc_holds_open_scope_unique)', async () => {
      const [finding] = await planMigrations(
        [
          {
            tag: '0001_x',
            statements: ['DROP INDEX "n";', 'CREATE UNIQUE INDEX IF NOT EXISTS "n" ON "big" ("x")'],
          },
        ],
        stub({ index: async () => ({ exists: true, valid: true, onTable: { schema: 'public', table: 'big' } }) }),
        THRESHOLDS,
      );
      expect(finding).toMatchObject({ kind: 'rebuilt-in-pending', refused: true, concurrently: null });
    });

    it('C8: unnamed ADD UNIQUE / PRIMARY KEY / EXCLUDE and an ADD COLUMN … UNIQUE are unparsed and refused on a large table', async () => {
      const findings = await planMigrations(
        [
          {
            tag: '0001_x',
            statements: [
              'ALTER TABLE "big" ADD UNIQUE ("x")',
              'ALTER TABLE "big" ADD PRIMARY KEY ("id")',
              'ALTER TABLE "big" ADD EXCLUDE USING gist ("r" WITH &&)',
              'ALTER TABLE "big" ADD COLUMN "code" text UNIQUE',
              'ALTER TABLE "big" ADD COLUMN IF NOT EXISTS "k" uuid PRIMARY KEY',
              // Not a key: no finding.
              'ALTER TABLE "big" ADD COLUMN "note" text',
              'ALTER TABLE "big" ADD CONSTRAINT "big_x_check" CHECK ("x" > 0)',
            ],
          },
        ],
        stub(),
        THRESHOLDS,
      );
      expect(findings.map((f) => [f.kind, f.refused])).toEqual([
        ['unparsed', true],
        ['unparsed', true],
        ['unparsed', true],
        ['unparsed', true],
        ['unparsed', true],
      ]);
    });

    it('C9: the same name on the same table with ANOTHER definition is a name collision; the same definition is prebuilt', async () => {
      const onBig = (definition: string): PlanInspector =>
        stub({ index: async () => ({ exists: true, valid: true, onTable: { schema: 'public', table: 'big' }, definition }) });
      const pending = [{ tag: '0001_x', statements: ['CREATE INDEX IF NOT EXISTS "n" ON "big" USING btree ("x","y")'] }];
      const [same] = await planMigrations(pending, onBig('CREATE INDEX n ON public.big USING btree (x, y)'), THRESHOLDS);
      expect(same).toMatchObject({ kind: 'prebuilt', refused: false });
      const [other] = await planMigrations(pending, onBig('CREATE INDEX n ON public.big USING btree (y, x)'), THRESHOLDS);
      expect(other).toMatchObject({ kind: 'name-collision', refused: true });
      expect(other!.advice).toContain('different definition');
    });

    it('C10: a multi-name or schema-qualified DROP INDEX is tracked — each re-create is refused', async () => {
      const findings = await planMigrations(
        [
          {
            tag: '0001_x',
            statements: [
              'DROP INDEX IF EXISTS "a", "public"."b" CASCADE;',
              'CREATE INDEX IF NOT EXISTS "a" ON "big" ("x")',
              'CREATE INDEX IF NOT EXISTS "b" ON "big" ("y")',
            ],
          },
        ],
        stub({ index: async () => ({ exists: true, valid: true, onTable: { schema: 'public', table: 'big' } }) }),
        THRESHOLDS,
      );
      expect(findings.map((f) => [f.index, f.kind])).toEqual([
        ['a', 'rebuilt-in-pending'],
        ['b', 'rebuilt-in-pending'],
      ]);
    });

    it('C11: an index on a table renamed in the pending set is pre-built against the CURRENT name, and its ownership checked there', async () => {
      const pending = [
        {
          tag: '0001_x',
          statements: ['ALTER TABLE "vendors" RENAME TO "business_partners";', 'CREATE INDEX IF NOT EXISTS "bp_x" ON "business_partners" ("x")'],
        },
      ];
      const estimate = async (name: { table: string }) => (name.table === 'vendors' ? big : null);
      const [missing] = await planMigrations(pending, stub({ estimate }), THRESHOLDS);
      expect(missing!.concurrently).toBe('CREATE INDEX CONCURRENTLY IF NOT EXISTS "bp_x" ON "vendors" ("x");');
      const [prebuilt] = await planMigrations(
        pending,
        stub({
          estimate,
          index: async (schema, name) => {
            expect([schema, name]).toEqual(['public', 'bp_x']);
            return { exists: true, valid: true, onTable: { schema: 'public', table: 'vendors' }, definition: 'CREATE INDEX bp_x ON public.vendors USING btree (x)' };
          },
        }),
        THRESHOLDS,
      );
      expect(prebuilt).toMatchObject({ kind: 'prebuilt', refused: false });
    });

    it('C12: CREATE TABLE IF NOT EXISTS over an existing large table creates nothing — its indexes are still judged', async () => {
      const [finding] = await planMigrations(
        [{ tag: '0001_x', statements: ['CREATE TABLE IF NOT EXISTS "big" ("id" int)', 'CREATE INDEX IF NOT EXISTS "n" ON "big" ("id")'] }],
        stub(),
        THRESHOLDS,
      );
      expect(finding).toMatchObject({ kind: 'prebuild-required', refused: true });
      // A table that does not exist yet IS created by the same statement.
      const [fresh] = await planMigrations(
        [{ tag: '0001_x', statements: ['CREATE TABLE IF NOT EXISTS "new_t" ("id" int)', 'CREATE INDEX IF NOT EXISTS "n" ON "new_t" ("id")'] }],
        stub({ estimate: async () => null }),
        THRESHOLDS,
      );
      expect(fresh).toMatchObject({ kind: 'new-table', refused: false });
    });

    it('C14: keywords after ON (ON CONFLICT, ON DELETE) are not tables; a DO block naming nothing that resolves falls back to "any large table"', async () => {
      const block = {
        tag: '0001_x',
        statements: [
          `DO $$ BEGIN INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING; EXECUTE 'CREATE INDEX n ON ' || 'big (x)'; END $$`,
        ],
      };
      const seen: string[] = [];
      const [finding] = await planMigrations(
        [block],
        stub({
          estimate: async (name) => {
            seen.push(name.table);
            return null;
          },
          anyLargeTable: async () => true,
        }),
        THRESHOLDS,
      );
      expect(seen).not.toContain('conflict');
      expect(finding).toMatchObject({ kind: 'unparsed', refused: true });
    });

    it('C15: the CLI takes named acceptances only — a bare --allow-locking is an error', () => {
      expect(parseCliArgs(['--dry-run', '--allow-locking=a_idx,0078'])).toEqual({ dryRun: true, allowLocking: ['a_idx', '0078'] });
      expect(() => parseCliArgs(['--allow-locking'])).toThrow('Unknown argument');
      expect(() => parseCliArgs(['--allow-locking='])).toThrow('at least one');
    });

    it('a table renamed earlier in the pending set is judged by the original table\'s size (0079\'s vendors → business_partners)', async () => {
      const seen: string[] = [];
      const [finding] = await planMigrations(
        [
          {
            tag: '0001_x',
            statements: ['ALTER TABLE "vendors" RENAME TO "business_partners";', 'CREATE INDEX IF NOT EXISTS "bp_x" ON "business_partners" ("x")'],
          },
        ],
        stub({
          estimate: async (name) => {
            seen.push(name.table);
            return name.table === 'vendors' ? big : null;
          },
        }),
        THRESHOLDS,
      );
      expect(seen).toEqual(['vendors']);
      expect(finding).toMatchObject({ kind: 'prebuild-required', refused: true });
    });
  });

  it(`the lint (A3): every CREATE INDEX in migrations ≥ ${String(IF_NOT_EXISTS_LINT_FROM).padStart(4, '0')} says IF NOT EXISTS`, () => {
    const folder = join(__dirname, '..', 'drizzle');
    const offenders: string[] = [];
    for (const file of readdirSync(folder).filter((name) => /^\d{4}_.*\.sql$/.test(name))) {
      if (Number(file.slice(0, 4)) < IF_NOT_EXISTS_LINT_FROM) continue;
      for (const statement of indexesWithoutIfNotExists(readFileSync(join(folder, file), 'utf8'))) {
        offenders.push(`${file}: ${statement.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
    // The lint bites: the same check over a plain build names it, and over
    // the guarded form names nothing.
    expect(indexesWithoutIfNotExists('CREATE INDEX "a" ON "t" ("x");--> statement-breakpoint\nSELECT 1')).toEqual([
      'CREATE INDEX "a" ON "t" ("x");',
    ]);
    expect(indexesWithoutIfNotExists('CREATE INDEX IF NOT EXISTS "a" ON "t" ("x");')).toEqual([]);
  });

  describe('a first deploy of the real migrations onto an empty database', () => {
    beforeAll(async () => {
      await recreate(FRESH);
    });
    afterAll(async () => {
      await dropDatabase(FRESH);
    });

    it('plans every repo migration with zero refusals even at a zero threshold — every table is created in the pending set — and changes nothing', async () => {
      const lines: string[] = [];
      const result = await migrateDeploy({
        url: withDatabase(BASE_URL, FRESH),
        migrationsFolder: join(__dirname, '..', 'drizzle'),
        dryRun: true,
        thresholds: { rows: 0, bytes: 0 },
        log: (line) => lines.push(line),
      });
      const journal = JSON.parse(readFileSync(join(__dirname, '..', 'drizzle', 'meta', '_journal.json'), 'utf8')) as {
        entries: unknown[];
      };
      expect(result.outcome).toBe('dry-run');
      expect(result.pending).toHaveLength(journal.entries.length);
      expect(result.findings.filter((f) => f.refused)).toEqual([]);
      const sql = postgres(withDatabase(BASE_URL, FRESH), { max: 1, onnotice: () => undefined });
      try {
        const [row] = await sql<{ present: boolean }[]>`select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
        expect(row!.present).toBe(false);
      } finally {
        await sql.end();
      }
    });

    it('C9 has no false positive on the repo: applied, every index each migration last defines normalizes equal to the server\'s pg_get_indexdef', async () => {
      const url = withDatabase(BASE_URL, FRESH);
      expect((await migrateDeploy({ url, migrationsFolder: join(__dirname, '..', 'drizzle'), log: () => undefined })).outcome).toBe('applied');
      const folder = join(__dirname, '..', 'drizzle');
      const lastDefinition = new Map<string, string>();
      for (const file of readdirSync(folder).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()) {
        for (const statement of splitStatements(readFileSync(join(folder, file), 'utf8'))) {
          const parsed = parseCreateIndex(statement);
          if (parsed !== null) lastDefinition.set(parsed.name, statement);
        }
      }
      const sql = postgres(url, { max: 1, onnotice: () => undefined });
      try {
        const rows = await sql<{ name: string; def: string }[]>`
          select c.relname as name, pg_get_indexdef(c.oid) as def
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'i' and n.nspname = 'public'`;
        const server = new Map(rows.map((row) => [row.name, row.def]));
        const compared: string[] = [];
        const mismatched: string[] = [];
        for (const [name, statement] of lastDefinition) {
          const def = server.get(name);
          if (def === undefined) continue; // dropped or renamed later
          const parsed = parseCreateIndex(statement)!;
          if (!def.includes(` ON public.${parsed.table.table} `) && !def.includes(` ON ONLY public.${parsed.table.table} `)) continue; // its table was renamed since
          compared.push(name);
          if (normalizeIndexDefinition(def) !== normalizeIndexDefinition(statement)) {
            mismatched.push(`${name}\n  migration: ${normalizeIndexDefinition(statement)}\n  server:    ${normalizeIndexDefinition(def)}`);
          }
        }
        expect(compared.length).toBeGreaterThan(200);
        expect(mismatched).toEqual([]);
      } finally {
        await sql.end();
      }
    });
  });

  describe('against a scratch database with large tables', () => {
    let folder: Folder;
    let sql: Sql;
    const lines: string[] = [];
    const url = withDatabase(BASE_URL, SCRATCH);
    const run = (over: Partial<MigrateDeployOptions> = {}) =>
      migrateDeploy({ url, migrationsFolder: folder.path, thresholds: THRESHOLDS, log: (line) => lines.push(line), ...over });
    const appliedCount = async () =>
      Number((await sql<{ n: string }[]>`select count(*)::text as n from drizzle.__drizzle_migrations`)[0]!.n);
    const indexValid = async (name: string) =>
      (await sql<{ valid: boolean }[]>`select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = ${name}`)[0]
        ?.valid ?? null;

    beforeAll(async () => {
      await recreate(SCRATCH);
      folder = new Folder();
      sql = postgres(url, { max: 2, onnotice: () => undefined });
      folder.add('tables', [
        'CREATE TABLE "big" ("id" int NOT NULL, "x" int, "y" int)',
        'CREATE TABLE "small" ("id" int NOT NULL, "x" int)',
        // Never analysed and never indexed: its reltuples stays -1.
        'CREATE TABLE "unanalysed" ("id" int NOT NULL, "pad" text) WITH (autovacuum_enabled = false)',
      ]);
      expect((await run()).outcome).toBe('applied');
      await sql`insert into big select g, g % 97, g % 50 from generate_series(1, 5000) g`;
      await sql`insert into small select g, g from generate_series(1, 10) g`;
      await sql`insert into unanalysed select g, repeat('x', 200) from generate_series(1, 4000) g`;
      await sql`analyze big`;
      await sql`analyze small`;
    });

    afterAll(async () => {
      await sql?.end();
      folder?.remove();
      await dropDatabase(SCRATCH);
    });

    it('the fixtures are what they claim: big over the row threshold, small under it, unanalysed never analysed and over the size one', async () => {
      const rows = await sql<{ relname: string; reltuples: number; bytes: string }[]>`
        select relname, reltuples::float8 as reltuples, pg_relation_size(oid)::text as bytes
        from pg_class where relname in ('big', 'small', 'unanalysed') order by relname`;
      const by = Object.fromEntries(rows.map((r) => [r.relname, { reltuples: Number(r.reltuples), bytes: Number(r.bytes) }]));
      expect(by.big!.reltuples).toBeGreaterThanOrEqual(THRESHOLDS.rows);
      expect(by.small!.reltuples).toBeLessThan(THRESHOLDS.rows);
      expect(by.unanalysed!.reltuples).toBeLessThan(0);
      expect(by.unanalysed!.bytes).toBeGreaterThanOrEqual(THRESHOLDS.bytes);
    });

    it('a small table: the index is applied', async () => {
      folder.add('small_index', ['CREATE INDEX IF NOT EXISTS "small_x_idx" ON "small" USING btree ("x")']);
      const result = await run();
      expect(result.outcome).toBe('applied');
      expect(result.findings).toMatchObject([{ kind: 'small-table', refused: false }]);
      expect(await indexValid('small_x_idx')).toBe(true);
    });

    it('a large table, not pre-built: refused with the CONCURRENTLY statement and nothing applied; dry run changes nothing; applied once the index is pre-built', async () => {
      const before = await appliedCount();
      const tag = folder.add('big_index', ['CREATE INDEX IF NOT EXISTS "big_x_idx" ON "big" USING btree ("x")']);
      lines.length = 0;
      const refused = await run();
      expect(refused.outcome).toBe('refused');
      expect(refused.pending).toEqual([tag]);
      expect(refused.findings).toMatchObject([
        {
          kind: 'prebuild-required',
          refused: true,
          concurrently: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "big_x_idx" ON "big" USING btree ("x");',
        },
      ]);
      expect(lines.join('\n')).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS "big_x_idx" ON "big" USING btree ("x");');
      expect(await appliedCount()).toBe(before);
      expect(await indexValid('big_x_idx')).toBeNull();

      const dry = await run({ dryRun: true });
      expect(dry.outcome).toBe('dry-run');
      expect(await appliedCount()).toBe(before);

      // The runbook: run the printed statement by hand, then deploy.
      await sql.unsafe(refused.findings[0]!.concurrently!);
      const applied = await run();
      expect(applied.outcome).toBe('applied');
      expect(applied.findings).toMatchObject([{ kind: 'prebuilt', refused: false }]);
      expect(await appliedCount()).toBe(before + 1);
      expect(await indexValid('big_x_idx')).toBe(true);
    });

    it('a large table, pre-built but INVALID: refused with drop-and-rebuild advice; applied after the rebuild', async () => {
      await sql`update big set y = 1 where id <= 2`; // duplicates: the unique build below fails…
      await expect(sql.unsafe('CREATE UNIQUE INDEX CONCURRENTLY "big_y_unique" ON "big" ("y")')).rejects.toMatchObject({
        code: '23505',
      });
      expect(await indexValid('big_y_unique')).toBe(false); // …and leaves an INVALID index behind
      folder.add('big_unique', ['CREATE UNIQUE INDEX IF NOT EXISTS "big_y_unique" ON "big" ("y")']);
      const refused = await run();
      expect(refused.outcome).toBe('refused');
      expect(refused.findings[0]).toMatchObject({ kind: 'invalid-index', refused: true });
      expect(refused.findings[0]!.advice).toContain('DROP INDEX CONCURRENTLY "big_y_unique"');

      await sql`update big set y = id`;
      await sql.unsafe('DROP INDEX CONCURRENTLY "big_y_unique"');
      await sql.unsafe(refused.findings[0]!.concurrently!);
      expect((await run()).outcome).toBe('applied');
      expect(await indexValid('big_y_unique')).toBe(true);
    });

    it('a plain CREATE INDEX (no IF NOT EXISTS) on a large table: refused — rewrite the migration; --allow-locking=<that index> proceeds, logged; naming another does not (C15)', async () => {
      const before = await appliedCount();
      folder.add('big_plain', ['CREATE INDEX "big_xy_idx" ON "big" ("x","y")']);
      const refused = await run();
      expect(refused.outcome).toBe('refused');
      expect(refused.findings[0]).toMatchObject({ kind: 'needs-if-not-exists', refused: true });
      expect(refused.findings[0]!.advice).toContain('Rewrite the migration');
      expect(await appliedCount()).toBe(before);

      // C15: an allowlist that does not name the refusal leaves it refused.
      const unnamed = await run({ allowLocking: ['some_other_idx', '0001_other'] });
      expect(unnamed.outcome).toBe('refused');
      expect(await appliedCount()).toBe(before);

      lines.length = 0;
      const forced = await run({ allowLocking: ['big_xy_idx'] });
      expect(forced.outcome).toBe('applied');
      expect(lines.join('\n')).toContain('--allow-locking: accepting big_xy_idx');
      expect(await indexValid('big_xy_idx')).toBe(true);
    });

    it('a never-analysed table (reltuples = -1) is judged by its size: refused as large', async () => {
      folder.add('unanalysed_index', ['CREATE INDEX IF NOT EXISTS "unanalysed_id_idx" ON "unanalysed" ("id")']);
      const refused = await run();
      expect(refused.outcome).toBe('refused');
      expect(refused.findings[0]).toMatchObject({ kind: 'prebuild-required', refused: true });
      expect(refused.findings[0]!.estimate!.reltuples).toBeLessThan(0);
      // The same table under a size threshold above its heap reads small.
      const small = await run({ dryRun: true, thresholds: { rows: THRESHOLDS.rows, bytes: 1024 * 1024 * 1024 } });
      expect(small.findings[0]).toMatchObject({ kind: 'small-table', refused: false });
      await sql.unsafe(refused.findings[0]!.concurrently!);
      expect((await run()).outcome).toBe('applied');
    });

    it('C13: a partitioned parent is judged by the sum of its partitions, not its own empty heap', async () => {
      await sql.unsafe(`create table "parted" ("id" int, "x" int) partition by range ("id")`);
      await sql.unsafe(`create table "parted_a" partition of "parted" for values from (0) to (3000)`);
      await sql.unsafe(`create table "parted_b" partition of "parted" for values from (3000) to (10000)`);
      await sql`insert into parted select g, g from generate_series(1, 5000) g`;
      await sql`analyze parted_a`;
      await sql`analyze parted_b`;
      folder.add('parted_index', ['CREATE INDEX IF NOT EXISTS "parted_x_idx" ON "parted" ("x")']);
      const result = await run({ dryRun: true });
      expect(result.findings).toMatchObject([{ kind: 'prebuild-required', refused: true }]);
      expect(result.findings[0]!.estimate!.reltuples).toBeGreaterThanOrEqual(THRESHOLDS.rows);
      // Accept it by name so the later cases start from nothing pending.
      expect((await run({ allowLocking: ['parted_x_idx'] })).outcome).toBe('applied');
    });

    it('C24: the CLI exits 2 on a refusal (and on a dry run that would refuse), 1 on a bare --allow-locking, 0 once accepted', () => {
      folder.add('cli_index', ['CREATE INDEX IF NOT EXISTS "big_cli_idx" ON "big" ("y","x")']);
      const cli = (...args: string[]) =>
        spawnSync('bun', ['src/shared/db/migrate-deploy.ts', `--migrations-folder=${folder.path}`, ...args], {
          cwd: join(__dirname, '..'),
          env: { ...process.env, DATABASE_URL: url, MIGRATE_LARGE_TABLE_ROWS: String(THRESHOLDS.rows), MIGRATE_LARGE_TABLE_BYTES: String(THRESHOLDS.bytes) },
          encoding: 'utf8',
        });
      const refused = cli();
      expect(refused.status).toBe(2);
      expect(refused.stdout).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS "big_cli_idx" ON "big" ("y","x");');
      expect(refused.stdout).toContain('--allow-locking=big_cli_idx');
      expect(cli('--dry-run').status).toBe(2);
      expect(cli('--allow-locking').status).toBe(1);
      expect(cli('--dry-run', '--allow-locking=big_cli_idx').status).toBe(0);
      expect(cli('--allow-locking=big_cli_idx').status).toBe(0);
      expect(cli().status).toBe(0); // up to date
    });

    it('C2/C24: the provisioning CLI refuses to run in production without both role passwords (exit 1, before connecting)', () => {
      const result = spawnSync('bun', ['src/shared/db/provision-roles.ts'], {
        cwd: join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', NODE_ENV: 'production', WMS_APP_PASSWORD: 'x', WMS_AUTH_PASSWORD: '' },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('WMS_AUTH_PASSWORD must be set');
    });

    it('two migrators: the second waits on the lock, and nothing is applied twice', async () => {
      // A held lock parks a migrator before it reads anything.
      const holder = await sql.reserve();
      try {
        await holder`select pg_advisory_lock(hashtextextended(${MIGRATE_LOCK_KEY}, 0))`;
        folder.add('t7', ['CREATE TABLE "t7" ("id" int)']);
        const parked = run();
        const deadline = Date.now() + 10_000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const [row] = await sql<{ n: string }[]>`
            select count(*)::text as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
            where l.locktype = 'advisory' and not l.granted and a.application_name = 'wms-migrate-deploy'`;
          waiting = Number(row!.n) > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(waiting).toBe(true);
        const [t7] = await sql<{ present: boolean }[]>`select to_regclass('t7') is not null as present`;
        expect(t7!.present).toBe(false);
        await holder`select pg_advisory_unlock(hashtextextended(${MIGRATE_LOCK_KEY}, 0))`;
        expect((await parked).outcome).toBe('applied');
      } finally {
        holder.release();
      }

      // Two at once: one applies, the other then finds nothing pending.
      folder.add('t8', ['CREATE TABLE "t8" ("id" int)', 'SELECT pg_sleep(0.3)']);
      const outcomes = (await Promise.all([run(), run()])).map((r) => r.outcome).sort();
      expect(outcomes).toEqual(['applied', 'up-to-date']);
      expect(await appliedCount()).toBe(folder.count);
      const [dupes] = await sql<{ n: string }[]>`
        select count(*)::text as n from (select created_at from drizzle.__drizzle_migrations group by created_at having count(*) > 1) d`;
      expect(Number(dupes!.n)).toBe(0);
    });
  });
});
