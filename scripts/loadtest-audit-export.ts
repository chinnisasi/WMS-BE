/**
 * Story 9-3b — the async audit export's load check (FR-28: an export of 100k
 * audit events completes asynchronously and notifies on completion).
 * REPORTED, not a CI gate.
 *
 * What it does:
 *   1. clones the jest template into `wms_s_loadtest_audit_export` (building
 *      the template via test/support/global-setup.cjs when absent);
 *   2. boots the real app and registers a tenant over HTTP (its owner is the
 *      requester);
 *   3. tops the tenant's `audit_events` up to exactly `--events` rows (default
 *      100,000) by bulk insert — the export's read is what is measured: a mix
 *      of the owner, the system actor and a member the tenant no longer has,
 *      ~20 action stems, random target ids, spread over the last 30 days;
 *   4. requests ONE export with no filters (`POST …/reporting/audit/exports`)
 *      and drives `TenancyService.runDueAuditExports` until it finishes (the
 *      §7d grace is waited out, never skipped), timing the run that claimed
 *      and wrote it;
 *   5. downloads the file over HTTP, gunzips it, checks its row count and its
 *      sha256 against the row, relays the outbox and reads the requester's
 *      notification panel;
 *   6. prints the time, `byte_size` (the gzipped size — PENDING records it as
 *      the in-memory size of one export), the uncompressed size and the
 *      process's peak RSS.
 *
 * Usage (from wms-be, local compose Postgres :55432 + Valkey :56379):
 *   bun scripts/loadtest-audit-export.ts [--events 100000] [--page 5000] [--keep-db]
 */

/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import http from 'node:http';
import { chdir } from 'node:process';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import postgres from 'postgres';

interface Args {
  readonly events: number;
  readonly page: number;
  readonly keepDb: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    const parsed = Number(argv[index + 1]);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
    return parsed;
  };
  return { events: value('--events', 100_000), page: value('--page', 5_000), keepDb: argv.includes('--keep-db') };
}

const args = parseArgs(process.argv.slice(2));

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'loadtest-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'loadtest-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// No background worker may compete with the run being measured — the script
// drives the runner and the relay itself.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.AUDIT_EXPORT_POLL_MS;

chdir(new URL('../', import.meta.url).pathname);

const { useSuiteDatabase } = await import('../test/support/suite-db');
const { createApp } = await import('../src/app.factory');
const { DATABASE, AUTH_DATABASE } = await import('../src/shared/shared.module');
const { OUTBOX_RELAY } = await import('../src/shared/events/outbox.seam');
const { TenancyService } = await import('../src/modules/tenancy/tenancy.service');
const { auditExportLimits } = await import('../src/modules/tenancy/audit-export.runner');
const { SYSTEM_ACTOR_ID } = await import('../src/shared/primitives/audit');
const { ulid, uuidv7 } = await import('../src/shared/primitives/ids');

const API = '/api/v1';
const PASSWORD = 'correct-horse-battery';

async function ensureTemplate(): Promise<void> {
  const admin = postgres(process.env.DATABASE_URL!.replace(/\/[^/]*$/, '/postgres'), { max: 1 });
  let present = false;
  try {
    const rows = (await admin`select datname from pg_database where datname = 'wms_template'`) as unknown as unknown[];
    present = rows.length > 0;
  } finally {
    await admin.end();
  }
  if (present) return;
  console.log('template database missing — building via test/support/global-setup.cjs …');
  const setup = (await import(pathToFileURL('test/support/global-setup.cjs').href)) as { default?: unknown };
  await ((setup.default ?? setup) as () => Promise<void>)();
}

async function call<T>(origin: string, label: string, expected: number, path: string, method: 'GET' | 'POST', body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`${origin}${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(method === 'POST' ? { 'Idempotency-Key': ulid() } : {}),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== expected) throw new Error(`${label}: expected ${expected}, got ${response.status} ${text}`);
  return (text.length === 0 ? null : JSON.parse(text)) as T;
}

/** The raw (still gzipped) download — fetch would inflate it. */
async function rawDownload(origin: string, path: string, token: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const url = new URL(`${origin}${API}${path}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' } },
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

async function main(): Promise<void> {
  await ensureTemplate();
  const suiteDb = await useSuiteDatabase('loadtest_audit_export');
  const app = await createApp(false);
  await app.init();
  await app.listen(0);
  const origin = new URL(await app.getUrl()).origin.replace('[::1]', 'localhost');
  const direct = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
  auditExportLimits.pageSize = args.page;
  try {
    const email = `owner-${uuidv7()}@example.com`;
    const registered = await call<{ tenant: { id: string }; owner: { id: string } }>(origin, 'register', 201, '/tenants', 'POST', {
      name: `Audit Export Load ${uuidv7().slice(0, 8)}`,
      ownerEmail: email,
      password: PASSWORD,
    });
    const tenantId = registered.tenant.id;
    const ownerId = registered.owner.id;
    const token = (await call<{ accessToken: string }>(origin, 'sign-in', 200, '/tenants/sign-in', 'POST', { email, password: PASSWORD })).accessToken;

    // ── seed to exactly --events audit rows ───────────────────────────────
    const existing = Number(((await direct`select count(*)::int as n from audit_events where tenant_id = ${tenantId}`)[0] as { n: number }).n);
    const toSeed = args.events - existing;
    const seedStarted = performance.now();
    await direct`
      insert into audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, reference, occurred_at, created_at, updated_at)
      select gen_random_uuid(), ${tenantId}::uuid,
             (array[${ownerId}::uuid, ${SYSTEM_ACTOR_ID}::uuid, ${uuidv7()}::uuid])[1 + (g % 3)],
             (array['transfer.created','transfer.cancelled','purchase_order.created','purchase_order.amended','goods_receipt.submitted',
                    'count.created','count.submitted','sku.edited','product.created','warehouse.created','zone.created','bin.created',
                    'order.created','order.cancelled','wave.released','pick.recorded','client.created','user.invited','device.enrolled',
                    'replenishment.breach_detected'])[1 + (g % 20)],
             'order', gen_random_uuid(), null,
             now() - make_interval(secs => (g::double precision * 30 * 86400 / ${toSeed}::double precision)),
             now() - make_interval(secs => (g::double precision * 30 * 86400 / ${toSeed}::double precision)),
             now()
      from generate_series(1, ${toSeed}::int) as g`;
    const seedMs = Math.round(performance.now() - seedStarted);

    // ── request, then drive the runner until it finishes ──────────────────
    const queued = await call<{ id: string; requestedAt: string }>(origin, 'request', 202, `/tenants/${tenantId}/reporting/audit/exports`, 'POST', {}, token);
    const tenancy = app.get(TenancyService);
    let runMs = 0;
    let outcome: string | null = null;
    let waited = 0;
    const deadline = Date.now() + 10 * 60_000;
    while (outcome === null && Date.now() < deadline) {
      const started = performance.now();
      const summary = await tenancy.runDueAuditExports(tenantId);
      if (summary.claimed !== null) {
        runMs = Math.round(performance.now() - started);
        outcome = summary.outcome;
      } else {
        waited += 1;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (outcome !== 'ready') throw new Error(`the export did not become ready (outcome ${String(outcome)})`);
    const row = (await direct`select row_count, byte_size, sha256, started_at, finished_at from audit_exports where id = ${queued.id}`)[0] as {
      row_count: number;
      byte_size: number;
      sha256: string;
      started_at: Date;
      finished_at: Date;
    };

    // ── the file, over HTTP ───────────────────────────────────────────────
    const file = await rawDownload(origin, `/tenants/${tenantId}/reporting/audit/exports/${queued.id}/file`, token);
    if (file.status !== 200) throw new Error(`download: ${file.status} ${file.body.toString('utf8').slice(0, 200)}`);
    const csv = gunzipSync(file.body);
    const lines = csv.toString('utf8').split('\r\n').filter((line) => line.length > 0);
    const sha256 = createHash('sha256').update(csv).digest('hex');

    // ── the notification ──────────────────────────────────────────────────
    const relay = app.get<unknown>(OUTBOX_RELAY) as { drain(limit: number): Promise<readonly unknown[]> };
    for (let i = 0; i < 20; i += 1) {
      await direct`update outbox_messages set next_attempt_at = now() where status = 'pending'`;
      if ((await relay.drain(100)).length === 0) break;
    }
    const panel = await call<{ items: { sourceType: string; sourceId: string; summary: unknown }[] }>(
      origin,
      'panel',
      200,
      `/tenants/${tenantId}/notifications?limit=100`,
      'GET',
      undefined,
      token,
    );
    const entry = panel.items.find((item) => item.sourceType === 'audit-export' && item.sourceId === queued.id);

    console.log(
      JSON.stringify(
        {
          events: args.events,
          seeded: toSeed,
          seedMs,
          pageSize: args.page,
          ticksWaitingForTheSnapshot: waited,
          runMs,
          serverRunMs: row.finished_at.getTime() - row.started_at.getTime(),
          rowCount: row.row_count,
          csvDataLines: lines.length - 1,
          byteSize: row.byte_size,
          downloadedBytes: file.body.length,
          contentLength: Number(file.headers['content-length']),
          uncompressedBytes: csv.length,
          sha256Matches: sha256 === row.sha256,
          panelEntry: entry ?? null,
          peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
        },
        null,
        2,
      ),
    );
    if (lines.length - 1 !== args.events || row.row_count !== args.events) throw new Error('the file does not hold every event');
    if (entry === undefined) throw new Error('the requester’s panel does not show the export');
  } finally {
    await direct.end();
    for (const token of [DATABASE, AUTH_DATABASE]) {
      const raw = app.get<unknown>(token) as { $client?: { end(): Promise<void> } };
      await raw.$client?.end();
    }
    await app.close();
    if (!args.keepDb) await suiteDb.drop();
  }
}

await main();
process.exit(0);
