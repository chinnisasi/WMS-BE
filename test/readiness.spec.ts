import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { OpenApiDocumentHolder } from '../src/api/openapi-document.holder';
import { READINESS_CHECK_TIMEOUT_MS, ReadinessService, migrationVerdict, readJournal } from '../src/api/readiness.service';
import { ValkeyClient } from '../src/shared/valkey/valkey.client';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;

/**
 * Story 6-2a — `GET /api/v1/health/ready` (decision 6, A2). The suite database
 * is the template the repo's own migrator built, so its newest
 * `__drizzle_migrations.created_at` is the journal's last `when` — "current".
 * Behind and ahead are made by editing that table directly, the one state
 * the check reads.
 */
jest.setTimeout(30_000);

describe('readiness (story 6-2a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let admin: postgres.Sql<Record<string, unknown>>;
  const journal = readJournal(join(__dirname, '..', 'drizzle', 'meta', '_journal.json'));
  const last = journal[journal.length - 1]!;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('readiness');
    admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    app = await createApp(false);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await admin?.end();
    await suiteDb?.drop();
  });

  const ready = () => request(app.getHttpServer()).get('/api/v1/health/ready');

  it('ready: both pools, Valkey and the migrations current → 200 naming the applied tag', async () => {
    const res = await ready().expect(200);
    expect(res.body).toEqual({ status: 'ready', migration: last.tag });
  });

  it('behind: the image bundles a migration the database has not applied → 503 naming migrations-behind, and nothing else', async () => {
    const [newest] = await admin<{ id: number; hash: string; created_at: string }[]>`
      select id, hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
    expect(Number(newest!.created_at)).toBe(last.when);
    await admin`delete from drizzle.__drizzle_migrations where id = ${newest!.id}`;
    try {
      const res = await ready().expect(503);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 503, code: 'not-ready', detail: 'Not ready: migrations-behind' });
      expect(res.body).toMatchObject({ failing: ['migrations-behind'] });
      // Check names only: no timestamps, no tags, no SQL.
      expect(JSON.stringify(res.body)).not.toContain(String(last.when));
      expect(JSON.stringify(res.body)).not.toContain(last.tag);
    } finally {
      await admin`insert into drizzle.__drizzle_migrations (id, hash, created_at) values (${newest!.id}, ${newest!.hash}, ${newest!.created_at}::bigint)`;
    }
    await ready().expect(200);
  });

  it('ahead: the database has applied a migration this image does not bundle (old tasks during a roll) → still ready', async () => {
    const [row] = await admin<{ id: number }[]>`
      insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-a-newer-image', ${last.when + 60_000})
      returning id`;
    try {
      const res = await ready().expect(200);
      expect(res.body).toEqual({ status: 'ready', migration: last.tag });
    } finally {
      await admin`delete from drizzle.__drizzle_migrations where id = ${row!.id}`;
    }
  });

  it('Valkey down → 503 naming valkey, the reason kept out of the response', async () => {
    const valkey = app.get(ValkeyClient);
    jest.spyOn(valkey, 'ping').mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.9:6379 secret-internal'));
    const res = await ready().expect(503);
    expect(res.body).toMatchObject({ code: 'not-ready', detail: 'Not ready: valkey' });
    expect(res.body).toMatchObject({ failing: ['valkey'] });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|secret-internal|10\.0\.0\.9/);
  });

  it('auth pool down (C21) → 503 naming auth-database only', async () => {
    const service = app.get(ReadinessService) as unknown as { authDb: unknown };
    const real = service.authDb;
    service.authDb = { transaction: () => Promise.reject(new Error('password authentication failed for user "wms_auth"')) };
    try {
      const res = await ready().expect(503);
      expect(res.body).toMatchObject({ code: 'not-ready', failing: ['auth-database'] });
      expect(JSON.stringify(res.body)).not.toContain('wms_auth');
    } finally {
      service.authDb = real;
    }
  });

  it('the migrations table unreadable while the database answers (C21) → 503 naming migrations-unreadable', async () => {
    await admin`alter table drizzle.__drizzle_migrations rename to __drizzle_migrations_hidden`;
    try {
      const res = await ready().expect(503);
      expect(res.body).toMatchObject({ code: 'not-ready', failing: ['migrations-unreadable'] });
    } finally {
      await admin`alter table drizzle.__drizzle_migrations_hidden rename to __drizzle_migrations`;
    }
    await ready().expect(200);
  });

  it('a hung probe (C21, C3): the check answers within its bound, and the SERVER cancels the query — nothing is left running', async () => {
    // Its own connection: `admin` (max 1) must stay free for the checks below.
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      await holder`begin`;
      await holder`lock table drizzle.__drizzle_migrations in access exclusive mode`;
      const t0 = Date.now();
      const res = await ready().expect(503);
      expect(Date.now() - t0).toBeLessThan(READINESS_CHECK_TIMEOUT_MS + 1_500);
      expect(res.body).toMatchObject({ failing: ['migrations-unreadable'] });
      // statement_timeout cancelled the probe server-side: no backend is still waiting on the lock.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const [waiting] = await admin<{ n: string }[]>`
        select count(*)::text as n from pg_stat_activity
        where query like '%__drizzle_migrations%' and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
      expect(Number(waiting!.n)).toBe(0);
    } finally {
      await holder`rollback`.catch(() => undefined);
      await holder.end();
    }
    await ready().expect(200);
  });

  it('a hung Valkey (C21) → 503 naming valkey within the bound', async () => {
    jest.spyOn(app.get(ValkeyClient), 'ping').mockImplementation(() => new Promise(() => undefined));
    const t0 = Date.now();
    const res = await ready().expect(503);
    expect(Date.now() - t0).toBeLessThan(READINESS_CHECK_TIMEOUT_MS + 1_500);
    expect(res.body).toMatchObject({ failing: ['valkey'] });
  });

  it('the liveness route is unchanged and needs nothing (no session, no tenant)', async () => {
    const valkey = app.get(ValkeyClient);
    jest.spyOn(valkey, 'ping').mockRejectedValue(new Error('down'));
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'wms-be' });
  });

  it('the verdict is "at or after", never "equal" (A2)', () => {
    const entries = [
      { when: 100, tag: '0000_a' },
      { when: 200, tag: '0001_b' },
    ];
    expect(migrationVerdict(entries, null)).toEqual({ ready: false });
    expect(migrationVerdict(entries, 100)).toEqual({ ready: false });
    expect(migrationVerdict(entries, 200)).toEqual({ ready: true, migration: '0001_b' });
    expect(migrationVerdict(entries, 300)).toEqual({ ready: true, migration: '0001_b' });
  });

  it('the route is in the OpenAPI document (and the committed one)', () => {
    const served = app.get(OpenApiDocumentHolder).get() as { paths: Record<string, unknown> };
    expect(Object.keys(served.paths)).toContain('/health/ready');
    const committed = JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8')) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(committed.paths)).toContain('/health/ready');
  });
});
