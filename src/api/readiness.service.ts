import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '../shared/db/db';
import { AUTH_DATABASE, DATABASE } from '../shared/db/tokens';
import { settleBefore } from '../shared/lifecycle/shutdown';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- a DI token: the class must exist at run time
import { ValkeyClient } from '../shared/valkey/valkey.client';

/**
 * Story 6-2a — the readiness check behind `GET /health/ready` (decision 6 as
 * amended by A2). It answers "may this task take traffic": both Postgres
 * pools answer `select 1`, Valkey answers `PING`, and the database's schema
 * is AT OR AFTER the migrations this image bundles.
 *
 * "At or after", never "equal" (A2, design review D3): during a rolling
 * deploy the migrator moves the database ahead of the OLD tasks still
 * serving, and an "equal" rule would take every one of them out of the load
 * balancer at once. Migrations are additive (the stated assumption that makes
 * "ahead" safe), so an old image over a newer schema stays ready.
 *
 * drizzle stores no tag, only each migration's journal `when` as
 * `created_at` (design review D4), so the comparison is
 * `max(created_at) ≥ the bundled journal's last when`. The app role reads
 * `drizzle.__drizzle_migrations` through the grants in
 * `scripts/provision-roles.sql`.
 */

/** Every readiness check, by the name a failure reports. */
export const READINESS_CHECKS = [
  'database',
  'auth-database',
  'valkey',
  'migrations-unreadable',
  'migrations-behind',
] as const;
export type ReadinessCheck = (typeof READINESS_CHECKS)[number];

/** Each check's own bound — a hung dependency must not hang the probe. */
export const READINESS_CHECK_TIMEOUT_MS = 2_000;

export interface JournalEntry {
  readonly when: number;
  readonly tag: string;
}

export type ReadinessResult =
  | { readonly ready: true; readonly migration: string }
  | { readonly ready: false; readonly failing: readonly ReadinessCheck[] };

/** The image's bundled migration journal (`drizzle/meta/_journal.json`). */
export const BUNDLED_JOURNAL_PATH = join(__dirname, '..', '..', 'drizzle', 'meta', '_journal.json');

export function readJournal(path: string = BUNDLED_JOURNAL_PATH): JournalEntry[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown };
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error(`${path} has no journal entries`);
  }
  return parsed.entries.map((entry: { when?: unknown; tag?: unknown }) => {
    if (typeof entry.when !== 'number' || typeof entry.tag !== 'string') {
      throw new Error(`${path} has a malformed journal entry`);
    }
    return { when: entry.when, tag: entry.tag };
  });
}

/**
 * The migration verdict, pure: `appliedWhen` is the database's
 * `max(created_at)` (null when nothing is applied). Behind → not ready.
 * At → the tag whose `when` matches. Ahead → ready, reporting the image's
 * newest tag (the database's newer tag is not in this image's journal).
 */
export function migrationVerdict(
  journal: readonly JournalEntry[],
  appliedWhen: number | null,
): { readonly ready: true; readonly migration: string } | { readonly ready: false } {
  const last = journal[journal.length - 1];
  if (last === undefined) return { ready: false };
  if (appliedWhen === null || appliedWhen < last.when) return { ready: false };
  const matched = journal.find((entry) => entry.when === appliedWhen);
  return { ready: true, migration: (matched ?? last).tag };
}

class CheckTimeout extends Error {}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let value: T | undefined;
  let failure: unknown;
  let failed = false;
  const settled = await settleBefore(
    work.then(
      (v) => {
        value = v;
      },
      (err: unknown) => {
        failed = true;
        failure = err;
      },
    ),
    Date.now() + READINESS_CHECK_TIMEOUT_MS,
  );
  if (!settled) throw new CheckTimeout('timed out');
  if (failed) throw failure;
  return value as T;
}

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger('Readiness');
  private journal: JournalEntry[] | undefined;
  /** Test seam: the journal this image bundles (read once, lazily). */
  journalPath: string = BUNDLED_JOURNAL_PATH;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    private readonly valkey: ValkeyClient,
  ) {}

  private bundledJournal(): JournalEntry[] {
    this.journal ??= readJournal(this.journalPath);
    return this.journal;
  }

  async check(): Promise<ReadinessResult> {
    const failing: ReadinessCheck[] = [];
    const note = (check: ReadinessCheck, err: unknown): void => {
      failing.push(check);
      // The reason stays in the log; the response names the check only.
      this.logger.warn(`Readiness check "${check}" failed: ${err instanceof Error ? err.message : String(err)}`);
    };

    const [database, authDatabase, valkey, applied] = await Promise.allSettled([
      bounded(this.db.execute(sql`select 1`)),
      bounded(this.authDb.execute(sql`select 1`)),
      bounded(this.valkey.ping()),
      bounded(
        this.db.execute(sql`select max(created_at)::text as applied from drizzle.__drizzle_migrations`) as Promise<
          unknown
        >,
      ),
    ]);
    if (database.status === 'rejected') note('database', database.reason);
    if (authDatabase.status === 'rejected') note('auth-database', authDatabase.reason);
    if (valkey.status === 'rejected') note('valkey', valkey.reason);

    let migration: string | undefined;
    if (applied.status === 'rejected') {
      // An unreachable database already reads `database`; this names the
      // case where the database answers but the migrations table does not
      // (no grant, never migrated).
      if (database.status === 'fulfilled') note('migrations-unreadable', applied.reason);
    } else {
      try {
        const rows = applied.value as { applied: string | null }[];
        // bigint → string at the postgres.js boundary (guide §2).
        const raw = rows[0]?.applied ?? null;
        const verdict = migrationVerdict(this.bundledJournal(), raw === null ? null : Number(raw));
        if (verdict.ready) migration = verdict.migration;
        else note('migrations-behind', new Error(`database at ${raw ?? 'nothing'}`));
      } catch (err) {
        note('migrations-unreadable', err);
      }
    }

    if (failing.length > 0 || migration === undefined) {
      return { ready: false, failing };
    }
    return { ready: true, migration };
  }
}
