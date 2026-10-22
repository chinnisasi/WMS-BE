/**
 * Story 6-2a — the guarded deploy migrator (decision 7, amendments A3–A6):
 *
 *   bun run db:migrate:deploy [--dry-run] [--allow-locking=<index-or-migration>[,…]]
 *
 * `db:migrate` (dev and the tests' template build) is unchanged; this is the
 * one a deploy runs, as the migrating owner, before any new task starts.
 *
 * Why it exists. drizzle applies every pending migration in ONE transaction
 * (`pg-core/dialect.js` `migrate`), where `CREATE INDEX CONCURRENTLY` is
 * illegal, so every index build in a migration holds a SHARE lock on its
 * table for the whole build — on `ledger_events` that stalls every append.
 * The repo's runbook (docs/design/DEPLOY.md) is to pre-build such an index
 * CONCURRENTLY by hand under the same name and let the migration's
 * `IF NOT EXISTS` skip it. This runner enforces the runbook instead of
 * trusting a reader of it:
 *
 *   1. take a session `pg_advisory_lock` on one RESERVED connection (the
 *      outbox-relay pattern) and hold it across the whole `migrate()` — one
 *      migrator at a time; a second waits, then finds nothing pending;
 *   2. list the pending migrations with drizzle's own reader
 *      (`readMigrationFiles`) and its own rule (`folderMillis >
 *      max(created_at)`);
 *   3. read each pending statement (split on `--> statement-breakpoint` as
 *      drizzle does, comments stripped) and judge every
 *      `CREATE [UNIQUE] INDEX` on a table that already exists and is LARGE
 *      (estimated rows ≥ `MIGRATE_LARGE_TABLE_ROWS`, default 100 000; or,
 *      never analysed — `reltuples < 0` — a heap of ≥
 *      `MIGRATE_LARGE_TABLE_BYTES`, default 64 MB):
 *        - no `IF NOT EXISTS` → refused: a pre-built index would fail the
 *          migration with 42P07, so the migration itself must be rewritten;
 *        - the index is missing → refused, printing the exact
 *          `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` to run first;
 *        - it exists but is INVALID (an interrupted concurrent build) →
 *          refused, with the drop-and-rebuild advice;
 *        - it exists and is valid → fine (`IF NOT EXISTS` skips it).
 *      A `DO`/`EXECUTE` block that mentions INDEX, an
 *      `ADD CONSTRAINT … UNIQUE | PRIMARY KEY`, or an index statement the
 *      parser cannot read is "unparsed, review" — refused when it can touch a
 *      large existing table (or names no table and the database holds one).
 *      Tables created earlier in the pending set are excluded throughout;
 *   4. `--dry-run` prints that plan and changes nothing;
 *      `--allow-locking=<index-name-or-migration-tag>[,…]` accepts exactly
 *      the refusals it names (code review C15 — a refusal it does not name
 *      stays refused), logged;
 *   5. then run drizzle's own `migrate()`, unchanged.
 *
 * Every connection carries `lock_timeout` (`MIGRATE_LOCK_TIMEOUT_MS`,
 * default 15 s — a DDL statement that cannot get its lock fails the deploy
 * rather than queueing the traffic behind it) and `statement_timeout`
 * (`MIGRATE_STATEMENT_TIMEOUT_MS`, default 10 min). The advisory wait is
 * bounded separately (`MIGRATE_ADVISORY_WAIT_MS`, default 10 min).
 *
 * Exit codes: 0 applied / up to date / a clean dry run; 2 refused (a dry run
 * included); 1 an error.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';

export const DEFAULT_LARGE_TABLE_ROWS = 100_000;
export const DEFAULT_LARGE_TABLE_BYTES = 64 * 1024 * 1024;
// Code review C16: a waiting DDL statement queues every later lock request on
// its table behind it for as long as it waits, so the wait is kept short.
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 600_000;
export const DEFAULT_ADVISORY_WAIT_MS = 600_000;

/** The session advisory lock key every deploy migrator takes. */
export const MIGRATE_LOCK_KEY = 'wms:migrate-deploy';

/** The first migration the IF NOT EXISTS lint covers (A3). */
export const IF_NOT_EXISTS_LINT_FROM = 89;

const BREAKPOINT = '--> statement-breakpoint';
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;

const CREATE_INDEX = new RegExp(
  String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\s+(?:ONLY\s+)?(${QUALIFIED})`,
  'i',
);
const CREATE_INDEX_PREFIX = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i;
const MENTIONS_CREATE_INDEX = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i;
const CREATE_TABLE = new RegExp(
  String.raw`^CREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\s+|UNLOGGED\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})`,
  'i',
);
const RENAME_TABLE = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s+RENAME\s+TO\s+(${IDENT})\s*;?$`,
  'i',
);
// Code review C10: a name LIST, each name optionally schema-qualified.
const DROP_INDEX = new RegExp(
  String.raw`^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${QUALIFIED}(?:\s*,\s*${QUALIFIED})*)\s*(?:CASCADE|RESTRICT)?\s*;?$`,
  'i',
);
// Code review C8: a key or exclusion constraint builds an index whether it is
// named or not (`ADD UNIQUE (…)`, `ADD PRIMARY KEY`, `ADD EXCLUDE`), and so
// does a column declared `UNIQUE` / `PRIMARY KEY` in `ADD COLUMN`.
const ADD_KEY_CONSTRAINT = /\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:UNIQUE|PRIMARY\s+KEY|EXCLUDE)\b/i;
const ADD_KEY_COLUMN = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT\b)\S+\s+[^,;]*?\b(?:UNIQUE|PRIMARY\s+KEY)\b/i;
// Code review C14: words that follow ON without naming a table.
const NOT_A_TABLE = new Set(['conflict', 'delete', 'update', 'insert', 'truncate', 'commit', 'schema', 'each', 'database', 'function', 'sequence', 'sequences', 'tables', 'all', 'role']);
const DO_BLOCK = /^DO\b/i;
const DYNAMIC_EXECUTE = /\bEXECUTE\s+(?!FUNCTION\b|PROCEDURE\b)/i;
const CANDIDATE_TABLES = new RegExp(
  String.raw`\b(?:ON\s+(?:ONLY\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?)(${QUALIFIED})`,
  'gi',
);

export interface TableName {
  readonly schema: string;
  readonly table: string;
}

/** `pg_class` facts about one table; null when it does not exist. */
export interface TableEstimate {
  /** `pg_class.reltuples` — negative when the table was never analysed. */
  readonly reltuples: number;
  /** `pg_relation_size` of the heap, in bytes. */
  readonly bytes: number;
}

/** What `pg_index` says about one index name in a schema. */
export type IndexState =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly valid: boolean;
      readonly onTable: TableName;
      /** `pg_get_indexdef` (code review C9); absent from a stub that does not compare. */
      readonly definition?: string;
    };

export interface PlanInspector {
  estimate(table: TableName): Promise<TableEstimate | null>;
  index(schema: string, name: string): Promise<IndexState>;
  /** Some table in the database is large (the fallback for an unparsed statement naming none). */
  anyLargeTable(thresholds: Thresholds): Promise<boolean>;
}

export interface Thresholds {
  readonly rows: number;
  readonly bytes: number;
}

export interface PendingMigration {
  readonly tag: string;
  readonly statements: readonly string[];
}

export type FindingKind =
  | 'new-table'
  | 'missing-table'
  | 'small-table'
  | 'prebuilt'
  | 'needs-if-not-exists'
  | 'prebuild-required'
  | 'invalid-index'
  | 'name-collision'
  | 'rebuilt-in-pending'
  | 'unparsed';

export interface Finding {
  readonly migration: string;
  readonly kind: FindingKind;
  readonly refused: boolean;
  readonly table: string | null;
  readonly index: string | null;
  readonly estimate: TableEstimate | null;
  /** What the operator should do (refusals only). */
  readonly advice: string | null;
  /** The statement to run by hand first (prebuild-required, invalid-index). */
  readonly concurrently: string | null;
  readonly statement: string;
}

/** Removes `--` line comments and `/* *\/` block comments outside quotes and dollar-quoted bodies. */
export function stripSqlComments(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (ch === '-' && next === '-') {
      const end = input.indexOf('\n', i);
      i = end === -1 ? input.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = input.indexOf('*/', i + 2);
      i = end === -1 ? input.length : end + 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = closingQuote(input, i, ch);
      out += input.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(input.slice(i))?.[0];
      if (tag !== undefined) {
        const close = input.indexOf(tag, i + tag.length);
        const end = close === -1 ? input.length : close + tag.length;
        // A dollar-quoted body keeps its text, comments included: it is a
        // function or DO body, judged as a whole below.
        out += input.slice(i, end);
        i = end;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function closingQuote(input: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < input.length) {
    if (input[i] === quote) {
      if (input[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return input.length;
}

/** drizzle's statement split, comments stripped, blanks dropped. */
export function splitStatements(fileSql: string): string[] {
  return fileSql.split(BREAKPOINT).flatMap(chunkStatements);
}

/**
 * One breakpoint chunk → its statements. drizzle sends a chunk whole, and a
 * hand-written chunk can hold several statements (`…; ALTER TABLE …`), so the
 * guard splits on every top-level `;` — never inside quotes or a
 * dollar-quoted body — or a second index build in a chunk would go unjudged
 * (found by the C9 repo check).
 */
export function chunkStatements(chunk: string): string[] {
  const text = stripSqlComments(chunk);
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      i = closingQuote(text, i, ch);
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i))?.[0];
      if (tag !== undefined) {
        const close = text.indexOf(tag, i + tag.length);
        i = close === -1 ? text.length : close + tag.length;
        continue;
      }
    }
    if (ch === ';') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
    i += 1;
  }
  out.push(text.slice(start));
  return out.map((statement) => statement.trim()).filter((statement) => statement !== '' && statement !== ';');
}

function unquote(ident: string): string {
  const trimmed = ident.trim();
  if (trimmed.startsWith('"')) return trimmed.slice(1, -1).replace(/""/g, '"');
  return trimmed.toLowerCase();
}

function splitQualified(raw: string): TableName {
  const parts = raw.match(new RegExp(IDENT, 'g')) ?? [];
  if (parts.length >= 2) return { schema: unquote(parts[0]!), table: unquote(parts[1]!) };
  return { schema: 'public', table: unquote(parts[0] ?? raw) };
}

function tableKey(name: TableName): string {
  return `${name.schema}.${name.table}`;
}

function quoted(name: TableName): string {
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  return name.schema === 'public' ? q(name.table) : `${q(name.schema)}.${q(name.table)}`;
}

export interface ParsedIndex {
  readonly unique: boolean;
  readonly concurrently: boolean;
  readonly ifNotExists: boolean;
  readonly name: string;
  readonly table: TableName;
}

/** Parses `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] "n" ON [ONLY] ["s".]"t" …`; null otherwise. */
export function parseCreateIndex(statement: string): ParsedIndex | null {
  const match = CREATE_INDEX.exec(statement.trim());
  if (match === null) return null;
  return {
    unique: match[1] !== undefined,
    concurrently: match[2] !== undefined,
    ifNotExists: match[3] !== undefined,
    name: unquote(match[4]!),
    table: splitQualified(match[5]!),
  };
}

/** The statement to run by hand first: the same index, CONCURRENTLY, IF NOT EXISTS. */
export function concurrentlyStatement(statement: string): string {
  const body = statement.trim().replace(/;\s*$/, '');
  return `${body.replace(CREATE_INDEX_PREFIX, (_all, unique: string | undefined) => `CREATE ${unique ?? ''}INDEX CONCURRENTLY IF NOT EXISTS `)};`;
}

/** The A3 lint: every CREATE INDEX statement that lacks IF NOT EXISTS. */
export function indexesWithoutIfNotExists(fileSql: string): string[] {
  return splitStatements(fileSql).filter((statement) => {
    const parsed = parseCreateIndex(statement);
    return parsed !== null ? !parsed.ifNotExists : false;
  });
}

function isUnparsed(statement: string): boolean {
  if (parseCreateIndex(statement) !== null) return false;
  if (MENTIONS_CREATE_INDEX.test(statement) && /^CREATE\b/i.test(statement)) return true; // an index statement the parser cannot read
  if ((DO_BLOCK.test(statement) || DYNAMIC_EXECUTE.test(statement)) && /\bINDEX\b/i.test(statement)) return true;
  return ADD_KEY_CONSTRAINT.test(statement) || ADD_KEY_COLUMN.test(statement);
}

/**
 * Code review C9 — a definition, normalised so a pending statement and the
 * server's `pg_get_indexdef` of the same index compare equal: lower-cased,
 * quotes, `public.`, `IF NOT EXISTS`, `CONCURRENTLY`, `ONLY`, the default
 * `USING btree`, `::type` casts, parentheses and whitespace dropped.
 */
export function normalizeIndexDefinition(definition: string): string {
  return definition
    .toLowerCase()
    .replace(/;\s*$/, '')
    .replace(/"/g, '')
    .replace(/\bpublic\./g, '')
    .replace(/\bif\s+not\s+exists\b/g, ' ')
    .replace(/\bconcurrently\b/g, ' ')
    .replace(/\bon\s+only\b/g, 'on')
    .replace(/\busing\s+btree\b/g, ' ')
    .replace(/::[a-z_][a-z0-9_ ]*?(?=[\s,)\]]|$)/g, '')
    // A column qualified by its own table (`t.col`) prints bare — stripped
    // while the words are still apart.
    .replace(/(^|[^a-z0-9_])[a-z_][a-z0-9_]*\.(?=[a-z_])/g, '$1')
    .replace(/[()]/g, '')
    .replace(/\s+/g, '')
    // The server's spelling of what a migration may write another way.
    .replace(/=anyarray\[/g, 'in')
    .replace(/[[\]]/g, '')
    .replace(/~~\*/g, 'ilike')
    .replace(/~~/g, 'like');
}

/** Rewrites the statement's `ON <table>` target (code review C11: a table renamed in the pending set). */
function retarget(statement: string, table: TableName): string {
  return statement.replace(new RegExp(String.raw`\bON\s+(ONLY\s+)?${QUALIFIED}`, 'i'), (_m, only: string | undefined) => `ON ${only ?? ''}${quoted(table)}`);
}

function isLarge(estimate: TableEstimate, thresholds: Thresholds): boolean {
  if (estimate.reltuples >= 0) return estimate.reltuples >= thresholds.rows;
  // Never analysed: the row estimate is unknown, so judge the heap's size (A4).
  return estimate.bytes >= thresholds.bytes;
}

function describeEstimate(estimate: TableEstimate | null): string {
  if (estimate === null) return 'no such table yet';
  const mb = (estimate.bytes / (1024 * 1024)).toFixed(1);
  return estimate.reltuples < 0 ? `never analysed, ${mb} MB` : `~${Math.round(estimate.reltuples)} rows, ${mb} MB`;
}

/**
 * Judges every pending statement (decision 7 step 3, A3–A5). Pure over the
 * inspector — the seam the tests stub, and the one the CLI binds to
 * `pg_class` / `pg_index`.
 */
export async function planMigrations(
  pending: readonly PendingMigration[],
  inspector: PlanInspector,
  thresholds: Thresholds,
): Promise<Finding[]> {
  const created = new Set<string>();
  // `ALTER TABLE a RENAME TO b` earlier in the pending set: b IS a (0079's
  // vendors → business_partners), so b is judged by a's size.
  const renamed = new Map<string, TableName>();
  const resolve = (name: TableName): TableName => renamed.get(tableKey(name)) ?? name;
  const view: PlanInspector = {
    estimate: (name) => inspector.estimate(resolve(name)),
    index: (schema, name) => inspector.index(schema, name),
    anyLargeTable: (t) => inspector.anyLargeTable(t),
  };
  // Index names a pending statement drops, keyed schema.name (C10): a
  // re-create under the same name cannot be pre-built (0078's
  // qc_holds_open_scope_unique).
  const dropped = new Set<string>();
  const findings: Finding[] = [];
  let anyLarge: boolean | undefined;

  for (const migration of pending) {
    for (const statement of migration.statements) {
      const table = CREATE_TABLE.exec(statement);
      if (table !== null) {
        const name = splitQualified(table[2]!);
        // C12: `IF NOT EXISTS` over a table that already exists creates
        // nothing — its later indexes are judged against its real size.
        const exists = table[1] !== undefined && (await view.estimate(name)) !== null;
        if (!exists) created.add(tableKey(name));
        continue;
      }

      const rename = RENAME_TABLE.exec(statement);
      if (rename !== null) {
        const from = splitQualified(rename[1]!);
        const to: TableName = { schema: from.schema, table: unquote(rename[2]!) };
        if (created.has(tableKey(from))) created.add(tableKey(to));
        else renamed.set(tableKey(to), resolve(from));
        continue;
      }

      const drop = DROP_INDEX.exec(statement);
      if (drop !== null) {
        for (const raw of drop[1]!.match(new RegExp(QUALIFIED, 'g')) ?? []) dropped.add(tableKey(splitQualified(raw)));
        continue;
      }

      const index = parseCreateIndex(statement);
      if (index !== null) {
        findings.push(await judgeIndex(migration.tag, statement, index, created, view, thresholds, dropped, resolve));
        continue;
      }

      if (!isUnparsed(statement)) continue;
      const candidates = [...statement.matchAll(CANDIDATE_TABLES)]
        .map((m) => splitQualified(m[1]!))
        .filter((name) => !NOT_A_TABLE.has(name.table))
        .filter((name, i, all) => all.findIndex((other) => tableKey(other) === tableKey(name)) === i);
      const existing = candidates.filter((name) => !created.has(tableKey(name)));
      let largeTable: { name: TableName; estimate: TableEstimate } | null = null;
      let resolved = 0;
      for (const name of existing) {
        const estimate = await view.estimate(name);
        if (estimate !== null) resolved += 1;
        if (estimate !== null && isLarge(estimate, thresholds)) {
          largeTable = { name, estimate };
          break;
        }
      }
      let refused = largeTable !== null;
      // C14: nothing named — or nothing named resolves to a table — so the
      // statement's real target is unknown: fall back to "does the database
      // hold any large table". A statement on tables the pending set creates
      // only is not refused.
      if (candidates.length === 0 || (existing.length > 0 && resolved === 0)) {
        anyLarge ??= await inspector.anyLargeTable(thresholds);
        refused = anyLarge;
      }
      findings.push({
        migration: migration.tag,
        kind: 'unparsed',
        refused,
        table: largeTable === null ? null : tableKey(largeTable.name),
        index: null,
        estimate: largeTable?.estimate ?? null,
        advice: refused
          ? 'unparsed, review: this statement can build an index or a key on a large table under the ' +
            'migration transaction. Check what it locks; run it by hand first if it can, else pass ' +
            `--allow-locking=${migration.tag} to accept the lock.`
          : null,
        concurrently: null,
        statement,
      });
    }
  }
  return findings;
}

async function judgeIndex(
  tag: string,
  statement: string,
  index: ParsedIndex,
  created: ReadonlySet<string>,
  inspector: PlanInspector,
  thresholds: Thresholds,
  dropped: ReadonlySet<string>,
  resolve: (name: TableName) => TableName = (name) => name,
): Promise<Finding> {
  const base = { migration: tag, table: tableKey(index.table), index: index.name, statement };
  // C11: the table as it exists NOW — before a rename earlier in the pending set.
  const physical = resolve(index.table);
  const ok = (kind: FindingKind, estimate: TableEstimate | null): Finding => ({
    ...base,
    kind,
    refused: false,
    estimate,
    advice: null,
    concurrently: null,
  });
  if (created.has(tableKey(index.table))) return ok('new-table', null);
  const estimate = await inspector.estimate(index.table);
  if (estimate === null) return ok('missing-table', null);
  if (!isLarge(estimate, thresholds)) return ok('small-table', estimate);

  const prebuild = concurrentlyStatement(tableKey(physical) === tableKey(index.table) ? statement : retarget(statement, physical));
  if (dropped.has(`${index.table.schema}.${index.name}`)) {
    return {
      ...base,
      kind: 'rebuilt-in-pending',
      refused: true,
      estimate,
      advice:
        `"${index.name}" is DROPPED earlier in the pending set and re-created here, so it cannot be pre-built under ` +
        `its name, and ${quoted(index.table)} is large (${describeEstimate(estimate)}). Schedule a window and pass ` +
        `--allow-locking=${index.name}, or split the change into a migration that builds the new index under another name first.`,
      concurrently: null,
    };
  }
  if (!index.ifNotExists) {
    return {
      ...base,
      kind: 'needs-if-not-exists',
      refused: true,
      estimate,
      advice:
        `${quoted(index.table)} is large (${describeEstimate(estimate)}) and this statement has no IF NOT EXISTS, ` +
        'so a pre-built index would fail the migration with 42P07. Rewrite the migration as ' +
        `\`CREATE INDEX IF NOT EXISTS …\`, then pre-build it CONCURRENTLY (or pass --allow-locking=${index.name} to take the lock).`,
      concurrently: prebuild,
    };
  }
  const state = await inspector.index(physical.schema, index.name);
  if (!state.exists) {
    return {
      ...base,
      kind: 'prebuild-required',
      refused: true,
      estimate,
      advice: `${quoted(index.table)} is large (${describeEstimate(estimate)}). Run this first, outside any transaction, then check pg_index.indisvalid and re-run the deploy:`,
      concurrently: prebuild,
    };
  }
  if (tableKey(state.onTable) !== tableKey(physical)) {
    return {
      ...base,
      kind: 'name-collision',
      refused: true,
      estimate,
      advice: `An index named "${index.name}" already exists on ${quoted(state.onTable)}, so IF NOT EXISTS would skip building it on ${quoted(physical)}.`,
      concurrently: null,
    };
  }
  // C9: the same name on the same table with ANOTHER definition — IF NOT
  // EXISTS would keep the old one and the new definition would never exist.
  if (
    state.definition !== undefined &&
    normalizeIndexDefinition(state.definition) !== normalizeIndexDefinition(tableKey(physical) === tableKey(index.table) ? statement : retarget(statement, physical))
  ) {
    return {
      ...base,
      kind: 'name-collision',
      refused: true,
      estimate,
      advice:
        `"${index.name}" exists on ${quoted(physical)} with a different definition (${state.definition}); IF NOT EXISTS ` +
        'would keep it and never build this one. Drop it CONCURRENTLY and pre-build this definition, or rename one of them.',
      concurrently: null,
    };
  }
  if (!state.valid) {
    return {
      ...base,
      kind: 'invalid-index',
      refused: true,
      estimate,
      advice: `"${index.name}" exists but is INVALID (an interrupted concurrent build), and IF NOT EXISTS would skip it. Drop it with DROP INDEX CONCURRENTLY ${quoted({ schema: physical.schema, table: index.name })}; then run this, check indisvalid, and re-run the deploy:`,
      concurrently: prebuild,
    };
  }
  return ok('prebuilt', estimate);
}

type Sql = postgres.Sql<Record<string, unknown>>;

/** The CLI's inspector over `pg_class` / `pg_index`. */
export function catalogInspector(sql: Sql): PlanInspector {
  return {
    async estimate({ schema, table }) {
      // C13: a partitioned parent ('p') holds no rows itself — sum its leaf
      // partitions (a leaf never analysed counts as unknown, so the parent
      // is unknown only when every leaf is).
      const rows = await sql<{ reltuples: number; bytes: string }[]>`
        with target as (
          select c.oid, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = ${schema} and c.relname = ${table} and c.relkind in ('r', 'p')
        ), parts as (
          select l.oid from target t join pg_partition_tree(t.oid) pt on pt.isleaf join pg_class l on l.oid = pt.relid
          where t.relkind = 'p'
          union all
          select t.oid from target t where t.relkind = 'r'
        )
        select case when count(*) = 0 then -1
                    when bool_and(c.reltuples < 0) then -1
                    else sum(greatest(c.reltuples, 0)) end::float8 as reltuples,
               coalesce(sum(pg_relation_size(c.oid)), 0)::text as bytes
        from parts p join pg_class c on c.oid = p.oid
        having exists (select 1 from target)`;
      const row = rows[0];
      return row === undefined ? null : { reltuples: Number(row.reltuples), bytes: Number(row.bytes) };
    },
    async index(schema, name) {
      const rows = await sql<{ valid: boolean; table_schema: string; table_name: string; definition: string }[]>`
        select i.indisvalid as valid, tn.nspname as table_schema, t.relname as table_name,
               pg_get_indexdef(c.oid) as definition
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_index i on i.indexrelid = c.oid
        join pg_class t on t.oid = i.indrelid
        join pg_namespace tn on tn.oid = t.relnamespace
        where n.nspname = ${schema} and c.relname = ${name}`;
      const row = rows[0];
      return row === undefined
        ? { exists: false }
        : {
            exists: true,
            valid: row.valid,
            onTable: { schema: row.table_schema, table: row.table_name },
            definition: row.definition,
          };
    },
    async anyLargeTable({ rows, bytes }) {
      const found = await sql<{ large: boolean }[]>`
        select exists (
          select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema', 'drizzle')
            and (c.reltuples >= ${rows} or (c.reltuples < 0 and pg_relation_size(c.oid) >= ${bytes}))
        ) as large`;
      return found[0]?.large === true;
    },
  };
}

export interface MigrateDeployOptions {
  readonly url: string;
  readonly migrationsFolder?: string;
  readonly dryRun?: boolean;
  /**
   * Code review C15: the refusals to accept, each named by its index or its
   * migration (the full tag or its four-digit number). Nothing else passes.
   */
  readonly allowLocking?: readonly string[];
  readonly thresholds?: Partial<Thresholds>;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly advisoryWaitMs?: number;
  readonly log?: (line: string) => void;
  /** Test seam: replace the catalog inspector (the row estimate). */
  readonly inspector?: (sql: Sql) => PlanInspector;
}

export interface MigrateDeployResult {
  readonly outcome: 'applied' | 'up-to-date' | 'refused' | 'dry-run';
  readonly pending: readonly string[];
  readonly findings: readonly Finding[];
  readonly applied: readonly string[];
}

interface JournalEntry {
  readonly tag: string;
  readonly when: number;
}

function readJournalEntries(folder: string): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

async function lastAppliedMillis(sql: Sql): Promise<number | null> {
  const [exists] = await sql<{ present: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
  if (exists?.present !== true) return null;
  // drizzle's own read: the newest row by created_at (bigint → string, guide §2).
  const rows = await sql<{ created_at: string | null }[]>`
    select created_at::text as created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
  const raw = rows[0]?.created_at;
  return raw === undefined || raw === null ? null : Number(raw);
}

/** The pending set, by drizzle's reader and drizzle's rule. */
async function pendingMigrations(sql: Sql, folder: string): Promise<PendingMigration[]> {
  const files = readMigrationFiles({ migrationsFolder: folder });
  const entries = readJournalEntries(folder);
  const last = await lastAppliedMillis(sql);
  const pending: PendingMigration[] = [];
  files.forEach((file, i) => {
    if (last !== null && !(last < file.folderMillis)) return;
    const tag = entries[i]?.tag ?? String(file.folderMillis);
    pending.push({ tag, statements: file.sql.flatMap(chunkStatements) });
  });
  return pending;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return parsed;
}

function printPlan(log: (line: string) => void, pending: readonly PendingMigration[], findings: readonly Finding[]): void {
  log(`Pending migrations: ${pending.length === 0 ? 'none' : pending.map((m) => m.tag).join(', ')}`);
  const onNewTables = findings.filter((finding) => finding.kind === 'new-table').length;
  if (onNewTables > 0) log(`  ${onNewTables} index statement(s) on tables the pending set creates — no lock on existing data`);
  for (const finding of findings) {
    if (finding.kind === 'new-table') continue;
    const where = finding.index === null ? (finding.table ?? 'unknown table') : `${finding.index} on ${finding.table}`;
    const verdict = finding.refused ? 'REFUSED' : 'ok';
    log(`  [${verdict}] ${finding.migration}: ${finding.kind} — ${where} (${describeEstimate(finding.estimate)})`);
    if (finding.refused) {
      if (finding.advice !== null) log(`      ${finding.advice}`);
      if (finding.concurrently !== null) log(`      ${finding.concurrently}`);
      if (finding.kind === 'unparsed') log(`      statement: ${finding.statement.slice(0, 300).replace(/\s+/g, ' ')}`);
    }
  }
}

/** The guarded deploy migration (decision 7). */
export async function migrateDeploy(options: MigrateDeployOptions): Promise<MigrateDeployResult> {
  // eslint-disable-next-line no-console -- the CLI's plan is its output
  const log = options.log ?? ((line: string) => console.log(line));
  const folder = options.migrationsFolder ?? './drizzle';
  const thresholds: Thresholds = {
    rows: options.thresholds?.rows ?? envInt('MIGRATE_LARGE_TABLE_ROWS', DEFAULT_LARGE_TABLE_ROWS),
    bytes: options.thresholds?.bytes ?? envInt('MIGRATE_LARGE_TABLE_BYTES', DEFAULT_LARGE_TABLE_BYTES),
  };
  const lockTimeoutMs = options.lockTimeoutMs ?? envInt('MIGRATE_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS);
  const statementTimeoutMs =
    options.statementTimeoutMs ?? envInt('MIGRATE_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS);
  const advisoryWaitMs = options.advisoryWaitMs ?? envInt('MIGRATE_ADVISORY_WAIT_MS', DEFAULT_ADVISORY_WAIT_MS);

  const sql = postgres(options.url, {
    max: 3,
    onnotice: () => undefined,
    connection: {
      application_name: 'wms-migrate-deploy',
      lock_timeout: lockTimeoutMs,
      statement_timeout: statementTimeoutMs,
    },
  });
  const session = await sql.reserve();
  try {
    // The advisory wait has its own bound; the statements' bounds stay on
    // every other connection.
    await session`select set_config('lock_timeout', ${String(advisoryWaitMs)}, false)`;
    await session`select set_config('statement_timeout', '0', false)`;
    log(`Waiting for the migration lock (${MIGRATE_LOCK_KEY})…`);
    await session`select pg_advisory_lock(hashtextextended(${MIGRATE_LOCK_KEY}, 0))`;
    try {
      const pending = await pendingMigrations(sql, folder);
      const inspector = (options.inspector ?? catalogInspector)(sql);
      const findings = await planMigrations(pending, inspector, thresholds);
      printPlan(log, pending, findings);
      const allowed = new Set(options.allowLocking ?? []);
      const refusals = findings.filter((finding) => finding.refused);
      const accepted = refusals.filter((finding) => isAccepted(finding, allowed));
      const blocking = refusals.filter((finding) => !isAccepted(finding, allowed));

      if (options.dryRun === true) {
        log(`Dry run: nothing changed${blocking.length > 0 ? ` (${blocking.length} refusal(s) — a real run would stop)` : ''}.`);
        return { outcome: 'dry-run', pending: pending.map((m) => m.tag), findings, applied: [] };
      }
      if (blocking.length > 0) {
        const names = blocking.map((finding) => finding.index ?? finding.migration).join(',');
        log(
          `Refused: ${blocking.length} statement(s) would lock a large table. Nothing was applied. ` +
            `Follow the advice above (docs/design/DEPLOY.md), or accept named locks with --allow-locking=${names}.`,
        );
        return { outcome: 'refused', pending: pending.map((m) => m.tag), findings, applied: [] };
      }
      for (const finding of accepted) {
        log(`--allow-locking: accepting ${finding.index ?? finding.migration} (${finding.migration}) — ${finding.table ?? 'its table'} is locked for the build.`);
      }
      if (pending.length === 0) {
        log('Migrations are up to date.');
        return { outcome: 'up-to-date', pending: [], findings, applied: [] };
      }

      // drizzle's own runner, unchanged — under the lock still held above.
      await migrate(drizzle(sql), { migrationsFolder: folder });
      log(`Applied: ${pending.map((m) => m.tag).join(', ')}`);
      return { outcome: 'applied', pending: pending.map((m) => m.tag), findings, applied: pending.map((m) => m.tag) };
    } finally {
      await session`select pg_advisory_unlock(hashtextextended(${MIGRATE_LOCK_KEY}, 0))`.catch(() => undefined);
    }
  } finally {
    session.release();
    await sql.end({ timeout: 5 });
  }
}

/** A refusal the operator named in `--allow-locking` (C15). */
function isAccepted(finding: Finding, allowed: ReadonlySet<string>): boolean {
  return (
    (finding.index !== null && allowed.has(finding.index)) ||
    allowed.has(finding.migration) ||
    allowed.has(finding.migration.slice(0, 4))
  );
}

export interface CliArgs {
  readonly dryRun: boolean;
  readonly allowLocking: readonly string[];
  readonly migrationsFolder?: string;
}

/** Parses the CLI's arguments; throws on anything unknown (a bare `--allow-locking` included). */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  let dryRun = false;
  const allowLocking: string[] = [];
  let migrationsFolder: string | undefined;
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--allow-locking=')) {
      const names = arg.slice('--allow-locking='.length).split(',').map((name) => name.trim()).filter((name) => name !== '');
      if (names.length === 0) throw new Error('--allow-locking= needs at least one index name or migration tag');
      allowLocking.push(...names);
    } else if (arg.startsWith('--migrations-folder=')) {
      migrationsFolder = arg.slice('--migrations-folder='.length);
    } else {
      throw new Error(
        `Unknown argument "${arg}" (expected --dry-run, --allow-locking=<index-or-migration>[,…], --migrations-folder=<path>)`,
      );
    }
  }
  return { dryRun, allowLocking, ...(migrationsFolder === undefined ? {} : { migrationsFolder }) };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required (the migrating owner)');
    process.exit(1);
  }
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  try {
    const result = await migrateDeploy({
      url,
      dryRun: args.dryRun,
      allowLocking: args.allowLocking,
      ...(args.migrationsFolder === undefined ? {} : { migrationsFolder: args.migrationsFolder }),
    });
    const allowed = new Set(args.allowLocking);
    const blocking = result.findings.some((finding) => finding.refused && !isAccepted(finding, allowed));
    process.exit(result.outcome === 'refused' || (result.outcome === 'dry-run' && blocking) ? 2 : 0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

if (require.main === module) void main();
