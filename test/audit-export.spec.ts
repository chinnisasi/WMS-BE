import { createHash } from 'node:crypto';
import { sql as dsql } from 'drizzle-orm';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync, type Gzip } from 'node:zlib';
import type { INestApplication } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import postgres from 'postgres';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { nowIso } from '../src/shared/primitives/time';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import { SYSTEM_ACTOR_ID } from '../src/shared/primitives/audit';
import { TenancyService } from '../src/modules/tenancy/tenancy.service';
import {
  AUDIT_EXPORT_EXPIRED_EVENT,
  AUDIT_EXPORT_FAILED_EVENT,
  AUDIT_EXPORT_FAILURE_REASONS,
  AUDIT_EXPORT_READY_EVENT,
  AUDIT_EXPORT_STATUSES,
} from '../src/modules/tenancy/audit-export.command';
import { AuditExportRunner, auditExportLimits } from '../src/modules/tenancy/audit-export.runner';
import { AuditCsvGzipWriter, csvCell, istInstant } from '../src/modules/tenancy/audit-export.csv';
import { NotificationsDeliveryHandler } from '../src/modules/notifications/notifications.delivery';
import {
  AUDIT_EXPORT_FAILURE_REASONS as NOTIFICATION_EXPORT_REASONS,
  NOTIFICATION_SOURCES,
  SOURCE_AUDIENCE,
} from '../src/modules/notifications/notification-sources';
import { APPROVAL_PUSH_SOURCES } from '../src/modules/notifications/push-rules';
import { AuditExportWorker, parseAuditExportPollMs } from '../src/jobs/jobs.module';
import { signTenantSession } from '../src/modules/tenancy/jwt-session';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow } from './support/audit-guard';
import { mintSignIn } from './support/sign-in';

// Story 9-3b — the async audit export: `POST/GET …/reporting/audit/exports`,
// `GET …/exports/{id}/file`, the runner behind `runDueAuditExports` (driven
// directly — never by timers), and the requester-only notification. Rows the
// clock matters to are backdated in SQL against now() (the push.spec model).
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.STORAGE_SNAPSHOT_POLL_MS;
delete process.env.AUDIT_EXPORT_POLL_MS;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

interface Member {
  readonly userId: string;
  readonly email: string;
  readonly token: string;
}

interface ExportDto {
  id: string;
  status: string;
  filters: Record<string, string>;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  rowCount: number | null;
  byteSize: number | null;
  sha256: string | null;
  failureReason: string | null;
}

interface RawDownload {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

describe('the async audit export (e2e, story 9-3b)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let tenancy: TenancyService;
  let runner: AuditExportRunner;
  let relay: OutboxRelay;
  let delivery: NotificationsDeliveryHandler;

  let tenantId: string;
  let owner: Member;
  let ops: Member;

  const savedLimits = { ...auditExportLimits };
  const httpReq = () => request(app.getHttpServer());

  async function signIn(email: string): Promise<string> {
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
  }

  async function invite(role: 'owner' | 'ops_manager', inTenant = tenantId, byToken = owner.token): Promise<Member> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await httpReq()
      .post(`${API}/${inTenant}/users`)
      .set('Authorization', `Bearer ${byToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    await httpReq()
      .post(`${API}/${inTenant}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    return { userId: invited.body.user.id as string, email, token: await signIn(email) };
  }

  async function registerTenant(label: string): Promise<{ tenantId: string; owner: Member }> {
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await httpReq()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Export ${label} ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    return {
      tenantId: registered.body.tenant.id as string,
      owner: { userId: registered.body.owner.id as string, email, token: await signIn(email) },
    };
  }

  function postExport(body: Record<string, unknown>, member: Member, key = ulid(), inTenant = tenantId): request.Test {
    return httpReq()
      .post(`${API}/${inTenant}/reporting/audit/exports`)
      .set('Authorization', `Bearer ${member.token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function listExports(member: Member, inTenant = tenantId): request.Test {
    return httpReq().get(`${API}/${inTenant}/reporting/audit/exports`).set('Authorization', `Bearer ${member.token}`);
  }

  async function exportRow(id: string): Promise<Record<string, unknown>> {
    const rows = await sql`select *, snapshot_at::text as snapshot_text, created_at::text as created_text from audit_exports where id = ${id}`;
    return rows[0] as Record<string, unknown>;
  }

  async function count(query: postgres.PendingQuery<postgres.Row[]>): Promise<number> {
    return Number(((await query)[0] as { n: number | string }).n);
  }

  /**
   * Raw audit rows with chosen stamps. The `::text` casts keep microseconds:
   * postgres.js serialises a parameter the server describes as timestamptz
   * through a JS Date, which truncates to milliseconds.
   */
  async function seed(rows: { action: string; targetType?: string; targetId?: string; actor?: string; createdAt: string; occurredAt?: string }[], inTenant = tenantId): Promise<void> {
    for (const row of rows) {
      await sql`insert into audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, reference, occurred_at, created_at, updated_at)
        values (${uuidv7()}, ${inTenant}, ${row.actor ?? owner.userId}, ${row.action}, ${row.targetType ?? 'order'}, ${row.targetId ?? uuidv7()},
                null, ${row.occurredAt ?? row.createdAt}::text::timestamptz, ${row.createdAt}::text::timestamptz, ${row.createdAt}::text::timestamptz)`;
    }
  }

  async function drainAll(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await sql`update outbox_messages set next_attempt_at = now() where status = 'pending'`;
      const drained = await relay.drain(100);
      if (drained.length === 0) return;
    }
  }

  /** The raw response bytes — supertest/superagent always inflate gzip, so this goes under them. */
  async function download(id: string, member: Member, inTenant = tenantId): Promise<RawDownload> {
    const server = app.getHttpServer() as http.Server;
    if (server.address() === null) {
      await new Promise<void>((resolve) => server.listen(0, resolve));
    }
    const { port } = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: `${API}/${inTenant}/reporting/audit/exports/${id}/file`,
          headers: { Authorization: `Bearer ${member.token}`, 'Accept-Encoding': 'gzip' },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  function problemOf(raw: RawDownload): { code?: string; detail?: string } {
    return JSON.parse(raw.body.toString('utf8')) as { code?: string; detail?: string };
  }

  /** The file's rows (header dropped), from the gunzipped CSV. */
  function csvRows(gzipped: Buffer): string[][] {
    const text = gunzipSync(gzipped).toString('utf8');
    expect(text.startsWith('﻿')).toBe(true);
    const records = parse(text.slice(1), { relax_column_count: false }) as string[][];
    expect(records[0]).toEqual(['recorded_at', 'occurred_at', 'actor_kind', 'actor_user_id', 'actor_email', 'action', 'target_type', 'target_id']);
    return records.slice(1);
  }

  async function storedFile(id: string): Promise<Buffer | null> {
    const rows = await sql`select content from audit_export_files where export_id = ${id}`;
    return rows.length === 0 ? null : Buffer.from((rows[0] as { content: Uint8Array }).content);
  }

  async function entry(sourceId: string, inTenant = tenantId): Promise<Record<string, unknown> | undefined> {
    const rows = await sql`
      select source_type, recipient_user_id, summary, resolved_at::text as resolved_at, resolution
      from notifications where tenant_id = ${inTenant} and source_id = ${sourceId}`;
    return rows[0] as Record<string, unknown> | undefined;
  }

  async function panel(member: Member, inTenant = tenantId): Promise<Record<string, unknown>[]> {
    const res = await httpReq().get(`${API}/${inTenant}/notifications`).query({ limit: 100 }).set('Authorization', `Bearer ${member.token}`).expect(200);
    return res.body.items as Record<string, unknown>[];
  }

  async function hasNew(member: Member, inTenant = tenantId): Promise<boolean> {
    const res = await httpReq().get(`${API}/${inTenant}/notifications/status`).set('Authorization', `Bearer ${member.token}`).expect(200);
    return res.body.hasNew as boolean;
  }

  /** Finishes `member`'s active export (so it can request another). */
  async function settle(inTenant = tenantId): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      const summary = await tenancy.runDueAuditExports(inTenant);
      if (summary.claimed === null && summary.waiting === null) return;
    }
  }

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('audit_export');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    tenancy = app.get(TenancyService);
    runner = app.get(AuditExportRunner);
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    delivery = app.get(NotificationsDeliveryHandler);
    // The §7d clock-skew margin is exercised by its own test; elsewhere a
    // request is claimable at once.
    auditExportLimits.snapshotGraceMs = 0;

    const registered = await registerTenant('Main');
    tenantId = registered.tenantId;
    owner = registered.owner;
    ops = await invite('ops_manager');
  });

  afterEach(() => {
    auditExportLimits.pageSize = savedLimits.pageSize;
    auditExportLimits.maxRows = savedLimits.maxRows;
    auditExportLimits.snapshotGraceMs = 0;
  });

  afterAll(async () => {
    Object.assign(auditExportLimits, savedLimits);
    const server = app.getHttpServer() as http.Server;
    if (server.address() !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── vocabulary and surface ────────────────────────────────────────────────

  describe('the vocabulary and the surface', () => {
    it('the status and reason tuples equal the 0070 CHECKs; the panel’s reason literal equals tenancy’s', async () => {
      const def = async (name: string): Promise<string> =>
        ((await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`)[0] as { def: string }).def;
      const inList = (text: string) => [...text.matchAll(/'([a-z-]+)'::text/g)].map((match) => match[1]).sort();
      expect(inList(await def('audit_exports_status_check'))).toEqual([...AUDIT_EXPORT_STATUSES].sort());
      expect(inList(await def('audit_exports_failure_reason_check'))).toEqual([...AUDIT_EXPORT_FAILURE_REASONS].sort());
      expect([...NOTIFICATION_EXPORT_REASONS]).toEqual([...AUDIT_EXPORT_FAILURE_REASONS]);
    });

    it('the panel listens for exactly the runner’s three events, addressed per user; the source is never pushed', () => {
      const spec = NOTIFICATION_SOURCES['audit-export'];
      expect(spec.raise.type).toBe(AUDIT_EXPORT_READY_EVENT);
      expect((spec.moreRaises ?? []).map((raise) => raise.type)).toEqual([AUDIT_EXPORT_FAILED_EVENT]);
      expect(spec.resolves.map((resolve) => resolve.type)).toEqual([AUDIT_EXPORT_EXPIRED_EVENT]);
      expect(SOURCE_AUDIENCE['audit-export']).toEqual({ capability: 'audit.view', recipient: true });
      expect((APPROVAL_PUSH_SOURCES as readonly string[]).includes('audit-export')).toBe(false);
      const enqueue = readFileSync(join(__dirname, '..', 'src', 'modules', 'notifications', 'push.enqueue.ts'), 'utf8');
      expect(enqueue).not.toMatch(/audit[_-]export/);
    });

    it('the three routes are in the OpenAPI document — the file as text/csv binary, the request a 202', async () => {
      const doc = (await httpReq().get('/api/v1/openapi.json').expect(200)).body as {
        paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>;
      };
      const exportsPath = doc.paths['/tenants/{tenantId}/reporting/audit/exports'];
      expect(Object.keys(exportsPath ?? {}).sort()).toEqual(['get', 'post']);
      expect(exportsPath!.post!.responses['202']).toBeDefined();
      const file = doc.paths['/tenants/{tenantId}/reporting/audit/exports/{exportId}/file'];
      expect(file?.get?.responses['200']?.content?.['text/csv']?.schema).toEqual({ type: 'string', format: 'binary' });
      expect(file?.get?.responses['409']?.content?.['application/problem+json']).toBeDefined();
    });

    it('the CSV cell rules: the six formula leads get an apostrophe; , " CR LF are quoted; IST instants with milliseconds', () => {
      for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
        expect(csvCell(`${lead}x`).replace(/^"|"$/g, '').startsWith(`'${lead}`)).toBe(true);
      }
      expect(csvCell('plain')).toBe('plain');
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell('two\nlines')).toBe('"two\nlines"');
      expect(istInstant('2026-10-13T08:33:07.412Z')).toBe('2026-10-13T14:03:07.412+05:30');
    });

    it('the CSV writer: a gzip error while a write awaits drain rejects the write (never hangs), and an unawaited error is no unhandled rejection', async () => {
      const writer = new AuditCsvGzipWriter();
      const gzip = (writer as unknown as { gzip: Gzip }).gzip;
      jest.spyOn(gzip, 'write').mockImplementation(() => false);
      const row = { createdAt: '2026-10-01T00:00:00Z', occurredAt: '2026-10-01T00:00:00Z', actorUserId: uuidv7(), actorEmail: null, action: 'x.y', targetType: 'order', targetId: uuidv7() };
      const pending = writer.write([row]);
      gzip.destroy(new Error('gzip broke'));
      await expect(pending).rejects.toThrow('gzip broke');
      // The `done` promise rejected too, with nobody awaiting it: no unhandled rejection.
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        const orphan = new AuditCsvGzipWriter();
        (orphan as unknown as { gzip: Gzip }).gzip.destroy(new Error('early'));
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(unhandled).toEqual([]);
    });

    it('both tables are tenant-isolated under RLS (wms_rls_probe sees only its stamped tenant)', async () => {
      const exportId = uuidv7();
      await sql`insert into audit_exports (id, tenant_id, requested_by, filters, snapshot_at, status, finished_at, expires_at, failure_reason)
                values (${exportId}, ${tenantId}, ${uuidv7()}, '{}'::jsonb, now(), 'failed', now(), now() + interval '7 days', 'export-error')`;
      await sql`insert into audit_export_files (export_id, tenant_id, content) values (${exportId}, ${tenantId}, ${Buffer.from([1, 2, 3])})`;
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        for (const table of ['audit_exports', 'audit_export_files']) {
          expect(await rls.unsafe(`select 1 from ${table} where tenant_id = $1`, [tenantId])).toHaveLength(0);
          const foreign = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
            return tx.unsafe(`select 1 from ${table} where tenant_id = $1`, [tenantId]);
          });
          expect(foreign).toHaveLength(0);
          const own = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            return tx.unsafe(`select 1 from ${table} where tenant_id = $1`, [tenantId]);
          });
          expect(own.length).toBeGreaterThan(0);
        }
      } finally {
        await rls.end();
      }
      await sql`delete from audit_export_files where export_id = ${exportId}`;
      await sql`delete from audit_exports where id = ${exportId}`;
    });
  });

  // ── the request ────────────────────────────────────────────────────────────

  describe('the request', () => {
    it('happy path: 202 queued (audited), the worker makes it ready, and the requester’s panel shows it with the dot', async () => {
      const requester = await invite('owner');
      const base = Date.now() - 3_600_000;
      await seed([
        { action: 'transfer.created', actor: requester.userId, createdAt: new Date(base).toISOString() },
        { action: 'transfer.cancelled', actor: requester.userId, createdAt: new Date(base + 1000).toISOString() },
        { action: 'warehouse.created', actor: requester.userId, createdAt: new Date(base + 2000).toISOString() },
      ]);
      const key = ulid();
      const res = await postExport({ actionPrefix: 'transfer.' }, requester, key).expect(202);
      const queued = res.body as ExportDto;
      expect(queued).toEqual({
        id: expect.any(String),
        status: 'queued',
        filters: { actionPrefix: 'transfer.' },
        requestedAt: expect.any(String),
        startedAt: null,
        finishedAt: null,
        expiresAt: null,
        rowCount: null,
        byteSize: null,
        sha256: null,
        failureReason: null,
      });
      await expectAuditRow({ tenantId, key, action: 'audit_export.requested', targetType: 'audit_export', targetId: queued.id, actorUserId: requester.userId });
      const row = await exportRow(queued.id);
      expect(row.snapshot_text).toBe(row.created_text);

      // The list reads it as queued ("Preparing…" on the web) until the worker runs.
      expect(((await listExports(requester).expect(200)).body.items as ExportDto[])[0]).toMatchObject({ id: queued.id, status: 'queued' });

      const summary = await tenancy.runDueAuditExports(tenantId);
      expect(summary).toMatchObject({ claimed: queued.id, outcome: 'ready', waiting: null });
      const ready = ((await listExports(requester).expect(200)).body.items as ExportDto[])[0]!;
      expect(ready).toMatchObject({ id: queued.id, status: 'ready', rowCount: 2, failureReason: null });
      expect(Date.parse(ready.expiresAt!) - Date.parse(ready.finishedAt!)).toBe(7 * 86_400_000);
      expect(csvRows((await storedFile(queued.id))!).map((cells) => cells[5])).toEqual(['transfer.cancelled', 'transfer.created']);

      await drainAll();
      expect(await entry(queued.id)).toMatchObject({
        source_type: 'audit-export',
        recipient_user_id: requester.userId,
        summary: { status: 'ready', rowCount: 2 },
        resolution: null,
      });
      const items = await panel(requester);
      expect(items.find((item) => item.sourceId === queued.id)).toMatchObject({
        sourceType: 'audit-export',
        warehouseId: null,
        summary: { status: 'ready', rowCount: 2 },
        resolvedAt: null,
      });
      expect(await hasNew(requester)).toBe(true);
      // Never pushed: the event queued no push row.
      expect(await count(sql`select count(*)::int as n from push_deliveries where tenant_id = ${tenantId}`)).toBe(0);
    });

    it('replay: the same key and body re-serve the original 202 queued snapshot (even once ready) — one export, one audit row; a different body is 422', async () => {
      const requester = await invite('owner');
      const key = ulid();
      const body = { actionPrefix: 'replay.', from: '2026-01-01T05:30:00+05:30' };
      const first = (await postExport(body, requester, key).expect(202)).body as ExportDto;
      expect(first.filters).toEqual({ actionPrefix: 'replay.', from: '2026-01-01T00:00:00.000Z' });
      // Key order and the instant's zone spelling do not change the fingerprint.
      const again = await postExport({ from: '2026-01-01T00:00:00Z', actionPrefix: 'replay.' }, requester, key).expect(202);
      expect(again.body).toEqual(first);
      await settle();
      expect((await exportRow(first.id)).status).toBe('ready');
      const afterReady = await postExport(body, requester, key).expect(202);
      expect(afterReady.body).toEqual(first);
      expect(afterReady.body.status).toBe('queued');
      expect(await count(sql`select count(*)::int as n from audit_exports where tenant_id = ${tenantId} and requested_by = ${requester.userId}`)).toBe(1);
      await expectAuditRow({ tenantId, key, action: 'audit_export.requested', targetType: 'audit_export', targetId: first.id, actorUserId: requester.userId });
      const reuse = await postExport({ actionPrefix: 'other.' }, requester, key).expect(422);
      expect(reuse.body.code).toBe('idempotency-key-reuse');
    });

    it('same-key race: two requests parked on the requester’s lock — one export, the loser replays the winner’s 202', async () => {
      const requester = await invite('owner');
      const key = ulid();
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const [held] = (await tx`
            select pg_backend_pid() as pid, pg_advisory_xact_lock(hashtext(${`audit-export:${tenantId}:${requester.userId}`})) as locked
          `) as unknown as { pid: number }[];
          first = (async () => postExport({ actionPrefix: 'race.' }, requester, key))();
          second = (async () => postExport({ actionPrefix: 'race.' }, requester, key))();
          await waitParked(held!.pid, 2);
        });
        const [a, b] = await Promise.all([first!, second!]);
        expect([a.status, b.status]).toEqual([202, 202]);
        expect(b.body).toEqual(a.body);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
      expect(await count(sql`select count(*)::int as n from audit_exports where tenant_id = ${tenantId} and requested_by = ${requester.userId}`)).toBe(1);
      expect(await count(sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)).toBe(1);
      await settle();
    });

    /** Wait until `min` sessions are parked on an advisory lock chain held by `holderPid`. */
    async function waitParked(holderPid: number, min: number): Promise<void> {
      const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.wait_event = 'advisory' and a.state = 'active'
          `) as unknown as { pid: number; blockers: number[] }[];
          const chain = new Set<number>([holderPid]);
          for (let grew = true; grew; ) {
            grew = false;
            for (const row of waiting) {
              if (!chain.has(row.pid) && row.blockers.some((pid) => chain.has(pid))) {
                chain.add(row.pid);
                grew = true;
              }
            }
          }
          if (chain.size - 1 >= min) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`fewer than ${min} request(s) parked on the advisory lock`);
      } finally {
        await probe.end();
      }
    }

    it('a second active export is 409 export-in-progress; the partial unique index backs it', async () => {
      const requester = await invite('owner');
      const queued = (await postExport({}, requester).expect(202)).body as ExportDto;
      const second = await postExport({ actionPrefix: 'other.' }, requester).expect(409);
      expect(second.body).toMatchObject({ code: 'export-in-progress' });
      await expect(
        sql`insert into audit_exports (id, tenant_id, requested_by, filters, snapshot_at, status) values (${uuidv7()}, ${tenantId}, ${requester.userId}, '{}'::jsonb, now(), 'queued')`,
      ).rejects.toMatchObject({ code: '23505', constraint_name: 'audit_exports_active_unique' });
      await settle();
      expect((await exportRow(queued.id)).status).toBe('ready');
      // Finished: a new one is admitted.
      await postExport({ actionPrefix: 'other.' }, requester).expect(202);
      await settle();
    });

    it('not the owner: ops_manager posting, listing or downloading is 403 role-denied, and nothing is written', async () => {
      const posted = await postExport({}, ops).expect(403);
      expect(posted.body.code).toBe('role-denied');
      expect(await count(sql`select count(*)::int as n from audit_exports where tenant_id = ${tenantId} and requested_by = ${ops.userId}`)).toBe(0);
      expect((await listExports(ops).expect(403)).body.code).toBe('role-denied');
      const raw = await download(uuidv7(), ops);
      expect(raw.status).toBe(403);
      expect(problemOf(raw).code).toBe('role-denied');
    });

    it('shape refusals: a missing key, from not before to, a malformed filter — 400; a portal token is fenced', async () => {
      await httpReq()
        .post(`${API}/${tenantId}/reporting/audit/exports`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({})
        .expect(400);
      const inverted = await postExport({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }, owner).expect(400);
      expect(inverted.body.code).toBe('validation-failed');
      expect((await postExport({ actionPrefix: 'a%' }, owner).expect(400)).body.code).toBe('validation-failed');
      expect((await postExport({ targetType: 'spaceship' }, owner).expect(400)).body.code).toBe('validation-failed');
      expect((await postExport({ reference: 'x' }, owner).expect(400)).body.code).toBe('validation-failed');
      const portalToken = signTenantSession(
        { tenantId, userId: owner.userId, sessionId: uuidv7(), kind: 'portal', clientId: uuidv7() },
        process.env.JWT_SECRET!,
      );
      const fenced = await httpReq()
        .post(`${API}/${tenantId}/reporting/audit/exports`)
        .set('Authorization', `Bearer ${portalToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(403);
      expect(fenced.body).toMatchObject({ code: 'role-denied', detail: 'This is an operator surface.' });
      expect(await count(sql`select count(*)::int as n from audit_exports where tenant_id = ${tenantId} and requested_by = ${owner.userId}`)).toBe(0);
    });
  });

  // ── the runner ─────────────────────────────────────────────────────────────

  describe('the runner', () => {
    it('story 1-3 — the retired `vendor` target still filters an export: a historical vendor.created row is in the file', async () => {
      const requester = await invite('owner');
      const targetId = uuidv7();
      await seed([{ action: 'vendor.created', targetType: 'vendor', targetId, createdAt: '2026-09-01T00:00:00Z' }]);
      const queued = (await postExport({ targetType: 'vendor' }, requester).expect(202)).body as ExportDto;
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: queued.id, outcome: 'ready' });
      const file = csvRows((await storedFile(queued.id))!);
      expect(file.length).toBeGreaterThanOrEqual(1);
      expect(file.every((cells) => cells[6] === 'vendor')).toBe(true);
      expect(file.some((cells) => cells[5]!.replace(/^'/, '') === 'vendor.created' && cells[7] === targetId)).toBe(true);
    });

    it('the file equals the paged read for the same filters with to = the snapshot — across a tie group straddling a page boundary, rows after the request excluded', async () => {
      const requester = await invite('owner');
      const tie = '2026-10-10T10:00:00.123456Z';
      // One transaction's rows share its now() to the microsecond.
      await seed([
        { action: 'eqread.alpha', actor: owner.userId, createdAt: '2026-10-10T09:00:00.000001Z', occurredAt: '2026-10-10T07:00:00Z' },
        { action: 'eqread.beta', actor: ops.userId, createdAt: tie },
        { action: 'eqread.gamma', actor: SYSTEM_ACTOR_ID, createdAt: tie },
        { action: 'eqread.delta', actor: owner.userId, createdAt: tie },
        { action: 'eqread.epsilon', actor: uuidv7(), createdAt: '2026-10-10T11:00:00Z' },
        { action: 'eqread.zeta', actor: owner.userId, createdAt: '2026-10-10T12:00:00.5Z' },
        { action: 'eqread.eta', actor: owner.userId, createdAt: '2026-10-10T13:00:00Z' },
      ]);
      auditExportLimits.pageSize = 2;
      const queued = (await postExport({ actionPrefix: 'eqread.' }, requester).expect(202)).body as ExportDto;
      // Committed after the request: never in the file.
      await sql`insert into audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, created_at, updated_at, occurred_at)
                values (${uuidv7()}, ${tenantId}, ${owner.userId}, 'eqread.late', 'order', ${uuidv7()}, now() + interval '1 second', now(), now())`;
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: queued.id, outcome: 'ready' });
      const row = await exportRow(queued.id);
      const file = csvRows((await storedFile(queued.id))!);
      expect(file).toHaveLength(7);
      expect(row.row_count).toBe(7);

      // The 9-3a read, to = the snapshot instant.
      const paged = (
        await httpReq()
          .get(`${API}/${tenantId}/reporting/audit`)
          .query({ actionPrefix: 'eqread.', to: new Date(String(row.snapshot_at)).toISOString(), limit: 200 })
          .set('Authorization', `Bearer ${owner.token}`)
          .expect(200)
      ).body.items as { recordedAt: string; occurredAt: string; actorKind: string; actorUserId: string; action: string; targetType: string; targetId: string }[];
      const emails = new Map(
        ((await sql`select id, email from users where tenant_id = ${tenantId}`) as unknown as { id: string; email: string }[]).map((u) => [u.id, u.email]),
      );
      const normalised = file.map((cells) => ({
        recordedAt: new Date(cells[0]!).toISOString(),
        occurredAt: new Date(cells[1]!).toISOString(),
        actorKind: cells[2],
        actorUserId: cells[3],
        email: cells[4]!.replace(/^'/, ''),
        action: cells[5]!.replace(/^'/, ''),
        targetType: cells[6],
        targetId: cells[7],
      }));
      expect(normalised).toEqual(
        paged.map((item) => ({
          recordedAt: item.recordedAt,
          occurredAt: item.occurredAt,
          actorKind: item.actorKind,
          actorUserId: item.actorUserId,
          email: item.actorKind === 'system' ? '' : (emails.get(item.actorUserId) ?? ''),
          action: item.action,
          targetType: item.targetType,
          targetId: item.targetId,
        })),
      );
      expect(normalised.map((r) => r.action)).not.toContain('eqread.late');
      expect(normalised.find((r) => r.action === 'eqread.gamma')).toMatchObject({ actorKind: 'system', email: '' });
      expect(normalised.find((r) => r.action === 'eqread.epsilon')!.email).toBe(''); // an unknown user
      expect(file[0]![0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+05:30$/);
    });

    it('every filter reaches the file: actor + target type + target + from + to + prefix — exactly the matching rows; the 202 and the list echo every key canonically', async () => {
      const requester = await invite('owner');
      const target = uuidv7();
      const from = '2026-10-01T00:00:00+05:30'; // = 2026-09-30T18:30:00.000Z
      const to = '2026-10-02T00:00:00+05:30'; //  = 2026-10-01T18:30:00.000Z
      const match = { action: 'fltr.hit', actor: ops.userId, targetType: 'transfer_order', targetId: target };
      await seed([
        { ...match, action: 'fltr.at-from', createdAt: '2026-09-30T18:30:00.000Z' },
        { ...match, action: 'fltr.inside', createdAt: '2026-10-01T06:00:00.000Z' },
        { ...match, action: 'fltr.at-to', createdAt: '2026-10-01T18:30:00.000Z' },
        { ...match, action: 'fltr.before-from', createdAt: '2026-09-30T18:29:59.999Z' },
        { ...match, action: 'fltr.other-actor', actor: owner.userId, createdAt: '2026-10-01T07:00:00.000Z' },
        { ...match, action: 'fltr.other-type', targetType: 'order', createdAt: '2026-10-01T08:00:00.000Z' },
        { ...match, action: 'fltr.other-target', targetId: uuidv7(), createdAt: '2026-10-01T09:00:00.000Z' },
        { ...match, action: 'other.prefix', createdAt: '2026-10-01T10:00:00.000Z' },
      ]);
      const posted = (
        await postExport(
          { actionPrefix: 'fltr.', actorUserId: ops.userId.toUpperCase(), targetType: 'transfer_order', targetId: target.toUpperCase(), from, to },
          requester,
        ).expect(202)
      ).body as ExportDto;
      const canonical = {
        actorUserId: ops.userId,
        actionPrefix: 'fltr.',
        targetType: 'transfer_order',
        targetId: target,
        from: '2026-09-30T18:30:00.000Z',
        to: '2026-10-01T18:30:00.000Z',
      };
      expect(posted.filters).toEqual(canonical);
      expect((await exportRow(posted.id)).filters).toEqual(canonical);
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: posted.id, outcome: 'ready' });
      const file = csvRows((await storedFile(posted.id))!);
      expect(file.map((cells) => cells[5])).toEqual(['fltr.inside', 'fltr.at-from']);
      expect(file.every((cells) => cells[3] === ops.userId && cells[4] === ops.email && cells[6] === 'transfer_order' && cells[7] === target)).toBe(true);
      const listed = ((await listExports(requester).expect(200)).body.items as ExportDto[]).find((item) => item.id === posted.id)!;
      expect(listed.filters).toEqual(canonical);
      expect(listed.rowCount).toBe(2);
    });

    it('each page runs under the 30 s statement budget, in its own transaction', async () => {
      const requester = await invite('owner');
      await seed([0, 1, 2].map((i) => ({ action: 'budget.row', createdAt: new Date(Date.parse('2026-10-04T00:00:00Z') + i * 1000).toISOString() })));
      auditExportLimits.pageSize = 2;
      const queued = (await postExport({ actionPrefix: 'budget.' }, requester).expect(202)).body as ExportDto;
      // Observe every runner transaction's statement_timeout at its end, before it commits.
      const db = (runner as unknown as { db: { transaction: (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown> } }).db;
      const original = db.transaction.bind(db);
      const seen: string[] = [];
      jest.spyOn(db, 'transaction').mockImplementation(async (fn, opts) =>
        original(async (tx) => {
          const result = await fn(tx);
          const [row] = (await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
            dsql`select current_setting('statement_timeout') as t`,
          )) as { t: string }[];
          seen.push(row!.t);
          return result;
        }, opts),
      );
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: queued.id, outcome: 'ready' });
      // Two pages (3 rows at 2 a page) armed 30 s; the other transactions (reclaim, claim, finish) did not.
      expect(seen.filter((t) => t === '30s')).toHaveLength(2);
      expect(seen.length).toBeGreaterThan(2);
    });

    it('an open transaction older than the snapshot keeps the row queued; once it ends the row is claimed and its row is in the file', async () => {
      const requester = await invite('owner');
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let markInserted!: () => void;
      const inserted = new Promise<void>((resolve) => (markInserted = resolve));
      const heldId = uuidv7();
      const holding = holder.begin(async (tx) => {
        await tx`insert into audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at)
                 values (${heldId}, ${tenantId}, ${owner.userId}, 'held.row', 'order', ${uuidv7()}, now())`;
        markInserted();
        await released;
      });
      try {
        await inserted;
        const queued = (await postExport({ actionPrefix: 'held.' }, requester).expect(202)).body as ExportDto;
        const waiting = await tenancy.runDueAuditExports(tenantId);
        expect(waiting).toMatchObject({ claimed: null, waiting: 'open-transaction' });
        expect((await exportRow(queued.id)).status).toBe('queued');
        release();
        await holding;
        expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: queued.id, outcome: 'ready' });
        const file = csvRows((await storedFile(queued.id))!);
        expect(file.map((cells) => cells[5])).toEqual(['held.row']);
      } finally {
        release();
        await holding.catch(() => undefined);
        await holder.end();
      }
    });

    it('the snapshot is not claimed inside its clock-skew margin, nor while a session is hidden from the role', async () => {
      const requester = await invite('owner');
      const queued = (await postExport({ actionPrefix: 'grace.' }, requester).expect(202)).body as ExportDto;
      auditExportLimits.snapshotGraceMs = 60_000;
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: null, waiting: 'grace' });
      auditExportLimits.snapshotGraceMs = 0;
      const original = runner.openSessions;
      runner.openSessions = async () => ({ oldestXactStart: null, hidden: true, hiddenCount: 2 });
      try {
        expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: null, waiting: 'session-visibility' });
      } finally {
        runner.openSessions = original;
      }
      expect((await exportRow(queued.id)).status).toBe('queued');
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: queued.id, outcome: 'ready' });
    });

    it('over the cap: maxRows 3 with 4 matches fails too-many-events, stores no file, and tells the requester', async () => {
      const requester = await invite('owner');
      const base = Date.parse('2026-10-09T00:00:00Z');
      await seed([0, 1, 2, 3].map((i) => ({ action: 'capped.row', createdAt: new Date(base + i * 1000).toISOString() })));
      auditExportLimits.maxRows = 3;
      auditExportLimits.pageSize = 2;
      const queued = (await postExport({ actionPrefix: 'capped.' }, requester).expect(202)).body as ExportDto;
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: queued.id, outcome: 'too-many-events' });
      expect(await exportRow(queued.id)).toMatchObject({ status: 'failed', failure_reason: 'too-many-events', row_count: null, sha256: null });
      expect(await storedFile(queued.id)).toBeNull();
      await drainAll();
      expect(await entry(queued.id)).toMatchObject({ recipient_user_id: requester.userId, summary: { status: 'failed', reason: 'too-many-events' } });
      // Exactly at the cap is fine.
      auditExportLimits.maxRows = 4;
      const again = (await postExport({ actionPrefix: 'capped.' }, requester).expect(202)).body as ExportDto;
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: again.id, outcome: 'ready' });
    });

    it('an unexpected error fails export-error (logged), never out of the tick', async () => {
      const requester = await invite('owner');
      const queued = (await postExport({ actionPrefix: 'boom.' }, requester).expect(202)).body as ExportDto;
      const store = (runner as unknown as { store: { put: (...args: unknown[]) => Promise<void> } }).store;
      jest.spyOn(store, 'put').mockRejectedValueOnce(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: queued.id, outcome: 'export-error' });
      expect(await exportRow(queued.id)).toMatchObject({ status: 'failed', failure_reason: 'export-error' });
      expect(await storedFile(queued.id)).toBeNull();
    });

    it('reclaim races a live run: A’s heartbeat goes stale, B reclaims and finishes — A’s finish changes nothing, one ready event', async () => {
      const requester = await invite('owner');
      await seed([{ action: 'racerun.row', createdAt: '2026-10-08T00:00:00Z' }]);
      const queued = (await postExport({ actionPrefix: 'racerun.' }, requester).expect(202)).body as ExportDto;
      const internals = runner as unknown as { finishReady: (...args: unknown[]) => Promise<boolean> };
      const original = internals.finishReady.bind(runner);
      let bSummary: unknown;
      let aFinished: boolean | undefined;
      const spy = jest.spyOn(internals, 'finishReady');
      spy.mockImplementationOnce(async (...aArgs: unknown[]) => {
        // A has written its file and is about to finish: its heartbeat is
        // backdated past the stale bound, and B runs a whole pass…
        await sql`update audit_exports set heartbeat_at = now() - interval '20 minutes' where id = ${queued.id}`;
        spy.mockImplementationOnce(async (...bArgs: unknown[]) => {
          // …and A's finish lands while B is still RUNNING (B re-claimed it
          // under attempts 2): only the claimed-attempts condition refuses it.
          aFinished = await original(...aArgs);
          return original(...bArgs);
        });
        bSummary = await tenancy.runDueAuditExports(tenantId);
        return aFinished!;
      });
      const aSummary = await tenancy.runDueAuditExports(tenantId);
      expect(bSummary).toMatchObject({ requeued: 1, claimed: queued.id, outcome: 'ready' });
      expect(aSummary).toMatchObject({ claimed: queued.id, outcome: 'lost' });
      expect(await exportRow(queued.id)).toMatchObject({ status: 'ready', attempts: 2, row_count: 1 });
      expect(await count(sql`select count(*)::int as n from audit_export_files where export_id = ${queued.id}`)).toBe(1);
      expect(
        await count(sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'audit_export.ready' and payload->>'exportId' = ${queued.id}`),
      ).toBe(1);
    });

    it('a stale run is re-queued while attempts < 3; at the third it fails interrupted, and the requester is notified', async () => {
      const requester = await invite('owner');
      const queued = (await postExport({ actionPrefix: 'crash.' }, requester).expect(202)).body as ExportDto;
      await sql`update audit_exports set status = 'running', attempts = 3, started_at = now() - interval '1 hour',
                heartbeat_at = now() - interval '16 minutes' where id = ${queued.id}`;
      const summary = await tenancy.runDueAuditExports(tenantId);
      expect(summary).toMatchObject({ requeued: 0, interrupted: 1, claimed: null });
      const row = await exportRow(queued.id);
      expect(row).toMatchObject({ status: 'failed', failure_reason: 'interrupted' });
      expect(row.finished_at).not.toBeNull();
      expect(row.expires_at).not.toBeNull();
      await drainAll();
      expect(await entry(queued.id)).toMatchObject({ recipient_user_id: requester.userId, summary: { status: 'failed', reason: 'interrupted' } });
      // A heartbeat inside the 15 minutes is a live run: left alone.
      const live = (await postExport({ actionPrefix: 'crash.' }, requester).expect(202)).body as ExportDto;
      await sql`update audit_exports set status = 'running', attempts = 1, started_at = now(), heartbeat_at = now() - interval '14 minutes' where id = ${live.id}`;
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ requeued: 0, interrupted: 0 });
      expect((await exportRow(live.id)).status).toBe('running');
      await sql`update audit_exports set heartbeat_at = now() - interval '16 minutes' where id = ${live.id}`;
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ requeued: 1, claimed: live.id, outcome: 'ready' });
    });

    it('formula cells are exported with a leading apostrophe (email and action); the system actor has kind system and no email', async () => {
      const requester = await invite('owner');
      const target = uuidv7();
      const evilId = uuidv7();
      await sql`insert into users (id, tenant_id, email, password_hash, role, status)
                values (${evilId}, ${tenantId}, ${`=cmd|' /C calc'!A0-${ulid().toLowerCase()}@example.com`}, 'x', 'operator', 'active')`;
      const base = Date.parse('2026-10-07T00:00:00Z');
      const actions = ['=SUM(A1)', '+add', '-neg', '@at', '\ttab', '\rcr', 'plain,comma'];
      await seed(actions.map((action, i) => ({ action, targetId: target, actor: i === 0 ? evilId : SYSTEM_ACTOR_ID, createdAt: new Date(base + i * 1000).toISOString() })));
      const queued = (await postExport({ targetId: target }, requester).expect(202)).body as ExportDto;
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: queued.id, outcome: 'ready' });
      const file = csvRows((await storedFile(queued.id))!);
      const byAction = [...file].reverse().map((cells) => cells[5]);
      expect(byAction).toEqual(["'=SUM(A1)", "'+add", "'-neg", "'@at", "'\ttab", "'\rcr", 'plain,comma']);
      const evil = file.find((cells) => cells[3] === evilId)!;
      expect(evil[2]).toBe('user');
      expect(evil[4]!.startsWith("'=cmd")).toBe(true);
      for (const cells of file.filter((c) => c[3] === SYSTEM_ACTOR_ID)) {
        expect(cells[2]).toBe('system');
        expect(cells[4]).toBe('');
      }
      // `reference` is never exported.
      expect(file.every((cells) => cells.length === 8)).toBe(true);
    });
  });

  // ── the download and the list ──────────────────────────────────────────────

  describe('the download and the list', () => {
    it('ready → 200 with the stored gzip bytes (Content-Length and sha256 match the row); queued → 409; expired → 409; another’s or unknown → 404', async () => {
      const requester = await invite('owner');
      const other = await invite('owner');
      await seed([{ action: 'dl.row', createdAt: '2026-10-06T00:00:00Z' }]);
      const queued = (await postExport({ actionPrefix: 'dl.' }, requester).expect(202)).body as ExportDto;
      const notReady = await download(queued.id, requester);
      expect(notReady.status).toBe(409);
      expect(problemOf(notReady).code).toBe('export-not-ready');

      await tenancy.runDueAuditExports(tenantId);
      const row = await exportRow(queued.id);
      const raw = await download(queued.id, requester);
      expect(raw.status).toBe(200);
      expect(raw.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(raw.headers['content-encoding']).toBe('gzip');
      expect(raw.headers['cache-control']).toBe('no-store');
      expect(raw.headers.etag).toBeUndefined();
      expect(Number(raw.headers['content-length'])).toBe(row.byte_size);
      expect(raw.body.length).toBe(row.byte_size);
      expect(raw.body.equals((await storedFile(queued.id))!)).toBe(true);
      expect(createHash('sha256').update(gunzipSync(raw.body)).digest('hex')).toBe(row.sha256);
      // The exact name: the row's created_at on the IST clock (UTC+05:30).
      const ist = new Date(new Date(String(row.created_at)).getTime() + 330 * 60_000);
      const pad = (n: number) => String(n).padStart(2, '0');
      const expectedName = `audit-export-${ist.getUTCFullYear()}${pad(ist.getUTCMonth() + 1)}${pad(ist.getUTCDate())}-${pad(ist.getUTCHours())}${pad(ist.getUTCMinutes())}.csv`;
      expect(raw.headers['content-disposition']).toBe(`attachment; filename="${expectedName}"`);

      const foreign = await download(queued.id, other);
      expect(foreign.status).toBe(404);
      expect(problemOf(foreign).code).toBe('export-not-found');
      expect(problemOf(await download(uuidv7(), requester)).code).toBe('export-not-found');
      expect((await download('not-a-uuid', requester)).status).toBe(400);
      // Another owner's list never shows it.
      expect(((await listExports(other).expect(200)).body.items as ExportDto[]).map((item) => item.id)).not.toContain(queued.id);

      await sql`update audit_exports set expires_at = now() - interval '1 minute' where id = ${queued.id}`;
      await tenancy.runDueAuditExports(tenantId);
      const expired = await download(queued.id, requester);
      expect(expired.status).toBe(409);
      expect(problemOf(expired).code).toBe('export-expired');
    });

    it('expiry: a ready export past expires_at loses its file, reads expired (history kept), and its panel entry resolves', async () => {
      const requester = await invite('owner');
      await seed([{ action: 'expiry.row', createdAt: '2026-10-05T00:00:00Z' }]);
      const queued = (await postExport({ actionPrefix: 'expiry.' }, requester).expect(202)).body as ExportDto;
      await tenancy.runDueAuditExports(tenantId);
      await drainAll();
      expect(await entry(queued.id)).toMatchObject({ resolution: null });
      await sql`update audit_exports set expires_at = now() - interval '1 minute' where id = ${queued.id}`;
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ expired: 1 });
      expect(await storedFile(queued.id)).toBeNull();
      const listed = ((await listExports(requester).expect(200)).body.items as ExportDto[]).find((item) => item.id === queued.id)!;
      expect(listed).toMatchObject({ status: 'expired', rowCount: 1 });
      expect(listed.sha256).toMatch(/^[0-9a-f]{64}$/);
      await drainAll();
      expect(await entry(queued.id)).toMatchObject({ resolution: 'expired', recipient_user_id: requester.userId });
      expect((await panel(requester)).find((item) => item.sourceId === queued.id)).toMatchObject({ resolution: 'expired' });
      // Expired once: a second pass expires nothing.
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ expired: 0 });
    });

    it('a failed export: its download is 409 export-not-ready; past expires_at it reads expired (no file) and its panel entry resolves', async () => {
      const requester = await invite('owner');
      await seed([0, 1].map((i) => ({ action: 'failexp.row', createdAt: new Date(Date.parse('2026-10-03T00:00:00Z') + i * 1000).toISOString() })));
      auditExportLimits.maxRows = 1;
      const queued = (await postExport({ actionPrefix: 'failexp.' }, requester).expect(202)).body as ExportDto;
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ claimed: queued.id, outcome: 'too-many-events' });
      const refused = await download(queued.id, requester);
      expect(refused.status).toBe(409);
      expect(problemOf(refused).code).toBe('export-not-ready');
      await drainAll();
      expect(await entry(queued.id)).toMatchObject({ summary: { status: 'failed', reason: 'too-many-events' }, resolution: null });
      await sql`update audit_exports set expires_at = now() - interval '1 minute' where id = ${queued.id}`;
      expect(await tenancy.runDueAuditExports(tenantId)).toMatchObject({ expired: 1 });
      expect(await exportRow(queued.id)).toMatchObject({ status: 'expired', failure_reason: 'too-many-events' });
      expect(await storedFile(queued.id)).toBeNull();
      expect(problemOf(await download(queued.id, requester)).code).toBe('export-expired');
      await drainAll();
      expect(await entry(queued.id)).toMatchObject({ resolution: 'expired', recipient_user_id: requester.userId });
    });

    it('the list is the caller’s own last 20, newest first', async () => {
      const requester = await invite('owner');
      for (let i = 0; i < 22; i += 1) {
        await postExport({ actionPrefix: 'many.' }, requester).expect(202);
        await settle();
      }
      const items = (await listExports(requester).expect(200)).body.items as ExportDto[];
      expect(items).toHaveLength(20);
      for (let i = 1; i < items.length; i += 1) {
        expect(items[i - 1]!.requestedAt >= items[i]!.requestedAt).toBe(true);
      }
      expect(items.every((item) => item.status === 'ready')).toBe(true);
    });
  });

  // ── the per-user panel ─────────────────────────────────────────────────────

  describe('the per-user audience', () => {
    let panels: { tenantId: string; owner: Member };
    let second: Member;

    beforeAll(async () => {
      panels = await registerTenant('Panels');
      second = await invite('owner', panels.tenantId, panels.owner.token);
    });

    it('another owner never sees the requester’s entry — in the list or the dot; a 9-2 source is still seen by both', async () => {
      const queued = (await postExport({}, panels.owner, ulid(), panels.tenantId).expect(202)).body as ExportDto;
      await settle(panels.tenantId);
      await drainAll();
      expect((await panel(panels.owner, panels.tenantId)).map((item) => item.sourceId)).toContain(queued.id);
      expect(await hasNew(panels.owner, panels.tenantId)).toBe(true);
      expect((await panel(second, panels.tenantId)).filter((item) => item.sourceType === 'audit-export')).toEqual([]);
      expect(await hasNew(second, panels.tenantId)).toBe(false);

      // A capability-routed source (recipient null) is unchanged: both owners see it.
      const holdId = uuidv7();
      await sql`insert into outbox_messages (id, tenant_id, type, payload, occurred_at, status, attempts, next_attempt_at)
                values (${uuidv7()}, ${panels.tenantId}, 'qc_hold.placed',
                        ${sql.json({ holdId, warehouseId: null, skuId: uuidv7(), reason: 'Seal broken' })}, ${nowIso()}, 'pending', 0, now())`;
      await drainAll();
      expect(await entry(holdId, panels.tenantId)).toMatchObject({ source_type: 'qc-hold', recipient_user_id: null });
      for (const member of [panels.owner, second]) {
        expect((await panel(member, panels.tenantId)).map((item) => item.sourceId)).toContain(holdId);
      }
      expect(await hasNew(second, panels.tenantId)).toBe(true);
    });

    it('expired delivered before ready: the tombstone carries the recipient, the late raise fills it resolved — and no other owner sees it', async () => {
      const exportId = uuidv7();
      const recipient = panels.owner.userId;
      const event = (type: string, payload: Record<string, unknown>, occurredAt: string) => ({
        eventId: uuidv7(),
        type,
        tenantId: panels.tenantId,
        occurredAt,
        payload,
      });
      await delivery.deliver(event(AUDIT_EXPORT_EXPIRED_EVENT, { exportId, requestedBy: recipient }, '2026-10-12T10:00:00.000Z'));
      expect(await entry(exportId, panels.tenantId)).toMatchObject({ recipient_user_id: recipient, summary: null, resolution: 'expired' });
      await delivery.deliver(event(AUDIT_EXPORT_READY_EVENT, { exportId, requestedBy: recipient, rowCount: 5 }, '2026-10-05T10:00:00.000Z'));
      expect(await entry(exportId, panels.tenantId)).toMatchObject({
        recipient_user_id: recipient,
        summary: { status: 'ready', rowCount: 5 },
        resolution: 'expired',
      });
      expect((await panel(panels.owner, panels.tenantId)).find((item) => item.sourceId === exportId)).toMatchObject({ resolution: 'expired' });
      expect((await panel(second, panels.tenantId)).find((item) => item.sourceId === exportId)).toBeUndefined();
      // A raise without a recipient is malformed: acked, nothing written.
      const orphan = uuidv7();
      await delivery.deliver(event(AUDIT_EXPORT_READY_EVENT, { exportId: orphan, rowCount: 1 }, nowIso()));
      expect(await entry(orphan, panels.tenantId)).toBeUndefined();
    });
  });

  // ── the worker ─────────────────────────────────────────────────────────────

  describe('the worker', () => {
    it('is env-gated: AUDIT_EXPORT_POLL_MS unset is OFF (rows stay queued); a tick drives the tenants with work', async () => {
      expect(parseAuditExportPollMs(undefined)).toBe(0);
      expect(parseAuditExportPollMs('0')).toBe(0);
      expect(parseAuditExportPollMs('10000')).toBe(10_000);
      expect(() => parseAuditExportPollMs('soon')).toThrow('AUDIT_EXPORT_POLL_MS');
      expect(readFileSync(join(__dirname, '..', '.env.example'), 'utf8')).toMatch(/^AUDIT_EXPORT_POLL_MS=/m);

      const requester = await invite('owner');
      const queued = (await postExport({ actionPrefix: 'worker.' }, requester).expect(202)).body as ExportDto;
      // Nothing runs on its own (the worker is off in this suite).
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await exportRow(queued.id)).status).toBe('queued');
      const worker = app.get(AuditExportWorker);
      expect(await worker.tick()).toContain(tenantId);
      expect((await exportRow(queued.id)).status).toBe('ready');
    });

    it('a tick finds a tenant whose only work is an expired ready export, and expires it', async () => {
      const lone = await registerTenant('WorkerExpiry');
      const queued = (await postExport({}, lone.owner, ulid(), lone.tenantId).expect(202)).body as ExportDto;
      await settle(lone.tenantId);
      expect((await exportRow(queued.id)).status).toBe('ready');
      await sql`update audit_exports set expires_at = now() - interval '1 minute' where id = ${queued.id}`;
      const worker = app.get(AuditExportWorker);
      expect(await worker.tick()).toContain(lone.tenantId);
      expect((await exportRow(queued.id)).status).toBe('expired');
      expect(await storedFile(queued.id)).toBeNull();
    });

    it('a tick finds a tenant whose only work is a stale running export, and re-queues it', async () => {
      const lone = await registerTenant('WorkerReclaim');
      const queued = (await postExport({}, lone.owner, ulid(), lone.tenantId).expect(202)).body as ExportDto;
      await sql`update audit_exports set status = 'running', attempts = 1, started_at = now() - interval '1 hour',
                heartbeat_at = now() - interval '16 minutes' where id = ${queued.id}`;
      // Keep the re-queued row from being claimed again in the same pass, so the re-queue itself is observed.
      auditExportLimits.snapshotGraceMs = 3_600_000;
      const worker = app.get(AuditExportWorker);
      expect(await worker.tick()).toContain(lone.tenantId);
      expect(await exportRow(queued.id)).toMatchObject({ status: 'queued', attempts: 1, started_at: null, heartbeat_at: null });
      auditExportLimits.snapshotGraceMs = 0;
      await settle(lone.tenantId);
    });
  });
});
