/**
 * The NFR-2 load-acceptance harness (story 7.2, row 8, RD-10). Greenfield —
 * verified: no load-test code or dependency existed in any of the three
 * repos, and none is ADDED: the concurrency is raw `fetch` from bun.
 *
 * What it drives (the WHOLE machinery, not a mock — RN-8):
 *
 *   the real app (`createApp`) over real HTTP, a seeded tenant (warehouse,
 *   bin, catalog, channel connection with a sealed credential), real webhook
 *   deliveries at `--amplify` × a configurable median order rate PLUS a
 *   concurrent on-hand adjustment stream (churn is the mechanism oversell
 *   hides in — a steady-state workload cannot produce one) PLUS a
 *   cancellation-echo sub-stream (the writeback path under load).
 *
 * The client is PINNED (RD-10): a bounded in-flight concurrency (a counted
 * semaphore — bun's fetch exposes no pool dial), a per-request timeout ≥ the
 * p95 budget, and WALL-CLOCK pacing (sends are scheduled from the clock,
 * never from responses) — achieved-vs-target rate is REPORTED because
 * client distortion (silent under-delivery, burst amplification) is itself
 * reportable (RN-8).
 *
 * Gates (the numbers RD-10 freezes):
 *   - accept-p95 ≤ 4000 ms AND the > 5 s fraction = 0 (Shopify's ~5 s
 *     webhook timeout — a slower answer is a load-AMPLIFYING redelivery);
 *   - oversells = 0, DEFINED CONCRETELY:
 *       (a) journal/stock parity — stock_on_hand equals the ledger replay
 *           per (warehouse, sku);
 *       (b) reservation/order parity — Σ held reservations per scope equals
 *           Σ live order_lines.reserved_qty (no phantom holds, no unbacked
 *           grants);
 *       (c) the negative-headroom re-derivation — walking each
 *           (warehouse, sku)'s grant timeline (every reservation row: +qty
 *           at `created_at`, −qty at `updated_at` when state='released')
 *           against its on-hand ledger replay: every granted figure was ≤
 *           the dispatchable headroom at grant time. Parity alone cannot
 *           see this — a fully-parity ledger can still contain accepted
 *           orders that never had dispatchable stock.
 *   - no pool deadlock: zero requests left uncompleted past the client
 *     timeout (the count gates).
 *
 * Writeback lag is REPORTED (median/max — soft, not a gate, RD-15): measured
 * on the cancellation-echo path (channel cancel → ingest → `order.cancelled`
 * outbox → relay → the port arm; the harness's own arm records the settle
 * instant, the harness holds the send instant). The echo is the run's ONLY
 * writeback, so the per-ref correlation is exact.
 *
 * Modes: `--mode smoke` (minutes; the CI shape), `--mode full` (rate and
 * duration parameterized). The epic's recorded evidence is the 2-hour 15×
 * full run — executed manually and committed with its environment stated
 * (local compose Postgres + Valkey, default pools, the committed harness
 * invocation). A mid-run crash gets ONE bounded restart, after which the
 * smoke mode + partial report are committed with the failure noted — the
 * evidence must be reproducible from THIS script, not a local anecdote.
 *
 * Usage (from the wms-be directory):
 *   bun scripts/loadtest-acceptance.ts --mode smoke
 *   bun scripts/loadtest-acceptance.ts --mode full --duration-s 7200 \
 *     --median-rate-rph 120 --amplify 15
 *
 * Requires the local compose Postgres (:55432) and Valkey (:56379). The suite
 * database `wms_s_loadtest` is cloned from the jest template (`wms_template`;
 * rebuilt automatically via test/support/global-setup.cjs when absent) and
 * dropped at the end unless `--keep-db`.
 *
 * SECRET DISCIPLINE: the webhook signing secret is generated per run, sealed
 * into the connection, and NEVER logged — the report names no material.
 */

/* eslint-disable no-console */
import postgres from 'postgres';
import { createHmac, randomUUID as uuidv7 } from 'node:crypto';
import { chdir } from 'node:process';
import { pathToFileURL } from 'node:url';

interface Args {
  readonly mode: 'smoke' | 'full';
  readonly durationS: number;
  readonly medianRateRph: number;
  readonly amplify: number;
  readonly adjustIntervalMs: number;
  readonly concurrency: number;
  readonly requestTimeoutMs: number;
  readonly seedQuantity: number;
  readonly maxOrderLines: number;
  readonly port: number;
  readonly keepDb: boolean;
  readonly reportPath: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const mode = get('mode') ?? 'smoke';
  if (mode !== 'smoke' && mode !== 'full') {
    throw new Error(`--mode must be smoke|full, got "${mode}"`);
  }
  const num = (name: string, fallback: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`--${name} must be a positive integer, got "${raw}"`);
    }
    return value;
  };
  return {
    mode: mode as Args['mode'],
    durationS: num('duration-s', mode === 'smoke' ? 120 : 7200),
    medianRateRph: num('median-rate-rph', 120),
    amplify: num('amplify', 15),
    adjustIntervalMs: num('adjust-interval-ms', 1000),
    concurrency: num('concurrency', 12),
    requestTimeoutMs: num('request-timeout-ms', 5000),
    seedQuantity: num('seed-quantity', 60),
    maxOrderLines: num('max-order-lines', 3),
    port: num('port', 25101),
    keepDb: has('keep-db'),
    reportPath: get('report-path') ?? null,
  };
}

const args = parseArgs();

// ── environment (the same defaults the jest suites pin) ─────────────────
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.CHANNEL_ENCRYPTION_KEY ??= 'e2e-only-channel-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// Only these two pollers are silenced (jest does the same); the OUTBOX RELAY
// STAYS alive — the writeback-lag report needs it — at a fast poll named in
// the report.
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
process.env.OUTBOX_RELAY_POLL_MS = '250';
process.env.PORT = String(args.port);

const ingestRatePerS = (args.medianRateRph / 3600) * args.amplify;

/** Run from the repo root so the template rebuild's own execSync resolves. */
chdir(new URL('../', import.meta.url).pathname);

/** The harness's own adapter code (admitted into the provider CHECK below). */
const PROVIDER = 'test-load';
/** Generated PER RUN, sealed into the connection, never logged or reported. */
const WEBHOOK_SECRET = `whsec-loadtest-${uuidv7().replace(/-/g, '')}`;
/** The order-ref range: the parse arm wants a positive int; unique per run. */
const REF_BASE = 9_400_000_000_000n;

/** The per-ref settle instant the port arm records (the lag's second clock). */
const writebackCalledAt = new Map<string, number>();

const { registerChannelAdapter } = await import('../src/modules/channels/channel-registry');
const { ulid } = await import('../src/shared/primitives/ids');
const { sealCredential } = await import('../src/modules/channels/channel-credentials');
const {
  testAvailabilityArm,
  unconfiguredRevokeArm,
} = await import('../src/modules/channels/channel-availability-port');
const shopifyPort = await import('../src/modules/channels/channel-shopify-port');
const { InventoryFacade } = await import('../src/modules/inventory/inventory.facade');
const { useSuiteDatabase } = await import('../test/support/suite-db');
const { createApp } = await import('../src/app.factory');

/** The suite-db handle (dropped at the end unless --keep-db). */
type SuiteDb = Awaited<ReturnType<typeof useSuiteDatabase>>;
let suiteDb: SuiteDb | null = null;

// The registry is a module-scope map read PER DELIVERY, so the harness's
// adapter registers ahead of the first delivery — the same way the suites'
// test adapters register.
registerChannelAdapter({
  code: PROVIDER,
  displayName: 'Load Acceptance',
  credentialFields: [
    { name: 'apiKey', label: 'API key', required: true, description: 'harness key' },
    { name: 'webhookSecret', label: 'Webhook signing secret', required: false, description: 'harness signs its deliveries' },
    { name: 'locationId', label: 'Location', required: false, description: 'unused here' },
  ],
  availabilityArm: testAvailabilityArm(),
  revokeArm: unconfiguredRevokeArm(PROVIDER),
  orderWritebackArm: async (
    _credential: unknown,
    request: { orderRef: string },
  ): Promise<{ settledAt: string; action: 'noop' }> => {
    writebackCalledAt.set(request.orderRef, Date.now());
    return { settledAt: new Date().toISOString(), action: 'noop' };
  },
  webhook: {
    topics: { orders: 'orders/create', cancellations: 'orders/cancelled' },
    verification: {
      header: 'X-Load-Hmac',
      encoding: 'base64',
      scheme: 'hmac-sha256',
      topicHeader: 'X-Load-Topic',
    },
    // The shopify parse arms: the payload shape the parse arms own is the
    // one the ingest command hashes (RD-1's normalized fields only).
    parseOrder: shopifyPort.shopifyParseOrder,
    parseCancellation: shopifyPort.shopifyParseCancellation,
  },
} as unknown as Parameters<typeof registerChannelAdapter>[0]);

/** Un-admitted codes stay out of the frozen vocabulary — THIS db admits one. */
async function admitTestProviderInDb(): Promise<void> {
  const handle = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await handle.unsafe(
      'alter table integrations drop constraint if exists integrations_provider_check',
    );
    // PROVIDER is a module const literal — the interpolation below is only
    // the const's own spelling, never run-supplied material.
    await handle.unsafe(
      `alter table integrations add constraint integrations_provider_check check (provider in ('shopify', 'amazon-in', 'flipkart', '${PROVIDER}'))`,
    );
  } finally {
    await handle.end();
  }
}

/**
 * Build the jest template database when absent, via the SAME globalSetup the
 * suites run (so the clone below always finds it and the roles exist).
 */
async function ensureTemplate(): Promise<void> {
  const admin = postgres(process.env.DATABASE_URL!.replace(/\/[^/]*$/, '/postgres'), { max: 1 });
  let present = false;
  try {
    const rows = (await admin`select datname from pg_database where datname = 'wms_template'`) as {
      datname: string;
    }[];
    present = rows.length > 0;
  } finally {
    await admin.end();
  }
  if (present) return;
  console.log('template database missing — building via test/support/global-setup.cjs …');
  const setupUrl = pathToFileURL('test/support/global-setup.cjs').href;
  const setup = (await import(setupUrl)) as { default?: unknown };
  const run = (setup.default ?? setup) as () => Promise<void>;
  await run();
}

/**
 * A full shipment address — warehouse creates REQUIRE an origin. The same
 * shape `test/support/shipment-address.ts` returns.
 */
function address(): Record<string, string> {
  return {
    contactName: 'Priya Sharma',
    phone: '+91 98450 12345',
    line1: '12, Peenya Industrial Area',
    line2: 'Gate 3',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560066',
  };
}

const API = '/api/v1';
const KEY = 'Idempotency-Key';

interface HttpAnswer {
  readonly status: number;
  readonly body: unknown;
}

async function sendJson(
  url: string,
  method: 'GET' | 'POST' | 'PUT',
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpAnswer> {
  const response = await fetch(url, {
    method,
    headers: {
      // Every mutating request carries a client-generated ULID key (the app's
      // global guard); each call here is a fresh request.
      ...(method === 'GET' ? {} : { [KEY]: ulid() }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

interface RunContext {
  readonly tenantId: string;
  readonly token: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly connectionId: string;
  readonly skuRefs: readonly string[];
  readonly skuIds: readonly string[];
  readonly origin: string;
  readonly direct: postgres.Sql;
  readonly app: Awaited<ReturnType<typeof createApp>>;
}

/**
 * Seeded tenant: register over HTTP (the owner account exists via the
 * register response), warehouse + zone + bin, catalog import, the channel
 * connection (direct SQL — the frozen provider vocabulary admits no test
 * code) with a SEALED credential carrying THIS run's webhook secret, the
 * mappings through the REAL route (T6's surface is live), and the seed
 * stock through THE adjustment route (the same journal the churn writes).
 */
async function seedTenant(): Promise<RunContext> {
  await ensureTemplate();
  suiteDb = await useSuiteDatabase('loadtest'); // rewrites DATABASE_URL
  await admitTestProviderInDb();

  const app = await createApp(false);
  await app.init();
  await app.listen(args.port);
  const origin = new URL(await app.getUrl()).origin;
  const direct = postgres(process.env.DATABASE_URL!, { max: 2 });

  const call = (
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpAnswer> => sendJson(`${origin}${API}${path}`, method, body, headers);

  const email = `owner-${uuidv7()}@example.com`;
  const registered = await call('/tenants', 'POST', {
    name: `Load Co ${uuidv7().slice(0, 8)}`,
    ownerEmail: email,
    password: 'correct-horse-battery',
  });
  const tenantId = (registered.body as { tenant?: { id?: string } })?.tenant?.id;
  const connectedBy = (registered.body as { owner?: { id?: string } })?.owner?.id;
  if (typeof tenantId !== 'string' || typeof connectedBy !== 'string') {
    throw new Error(`tenant register failed: ${registered.status} ${JSON.stringify(registered.body) ?? ""}`);
  }
  const session = await call('/tenants/sign-in', 'POST', { email, password: 'correct-horse-battery' });
  const token = (session.body as { accessToken?: string })?.accessToken;
  if (typeof token !== 'string') throw new Error(`sign-in failed: ${session.status}`);
  // Authorization carrier only — NO Idempotency-Key baked in. All three early
  // mutating POSTs below spread this object bare, and a fixed key reused
  // across different payloads trips the app's idempotency-key-reuse guard
  // (sendJson mints a fresh key per request).
  const owner = { Authorization: `Bearer ${token}` };

  const warehouses = await call(
    `/tenants/${tenantId}/warehouses`,
    'POST',
    { origin: address(), code: `LT${uuidv7().slice(0, 6).toUpperCase()}`, name: 'Load WH' },
    owner,
  );
  const warehouseId = (warehouses.body as { id?: string })?.id;
  if (typeof warehouseId !== 'string') throw new Error(`warehouse create failed: ${warehouses.status}`);
  const zone = await call(
    `/tenants/${tenantId}/warehouses/${warehouseId}/zones`,
    'POST',
    { code: 'A', name: 'Zone A' },
    owner,
  );
  const zoneId = (zone.body as { id?: string })?.id;
  if (typeof zoneId !== 'string') {
    throw new Error(`zone create failed: ${zone.status} ${JSON.stringify(zone.body)}`);
  }
  const bins = await call(
    `/tenants/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`,
    'POST',
    { capacity: 100000000, type: 'shelf', code: 'A-01-01' },
    owner,
  );
  if (bins.status !== 201) throw new Error(`bin create failed: ${bins.status}`);

  const skuRefs = ['LOAD-A', 'LOAD-B', 'LOAD-C'] as const;
  const csvHeader =
    'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
  const csv = [csvHeader, ...skuRefs.map((code) => `${code},Load SKU ${code},pcs,,1800,,,,,`)].join('\n');
  const form = new FormData();
  form.set('mode', 'initial');
  form.set('file', new Blob([csv], { type: 'text/csv' }), 'catalog.csv');
  const imported = await fetch(`${origin}${API}/tenants/${tenantId}/catalog/imports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, [KEY]: ulid() },
    body: form,
  });
  if (imported.status !== 201) throw new Error(`catalog import failed: ${imported.status}`);
  const skuList = await call(`/tenants/${tenantId}/catalog/skus`, 'GET', undefined, owner);
  const bySku = new Map<string, string>(
    ((skuList.body as { items?: { code: string; id: string }[] })?.items ?? [])
      .filter((item) => (skuRefs as readonly string[]).includes(item.code))
      .map((item) => [item.code, item.id]),
  );
  const skuIds = skuRefs.map((code) => bySku.get(code)!);
  if (skuIds.some((id) => typeof id !== 'string')) throw new Error('catalog read failed');

  // The connection rides direct SQL (the frozen provider DTO vocabulary
  // admits no test code) — the SEALED blob carries the webhook secret and
  // the writeback location; neither plaintext ever appears in a report.
  const sealed = sealCredential({
    apiKey: 'canary-loadtest-key',
    webhookSecret: WEBHOOK_SECRET,
    locationId: '9001',
  } as never) as unknown as string;
  const inserted = (await direct`
    insert into integrations
      (id, tenant_id, provider, status, credential_sealed, credential_version,
       backorder_policy, ingest_warehouse_id, connected_by, created_at, updated_at)
    values (${uuidv7()}, ${tenantId}, ${PROVIDER}, 'connected', ${sealed}, 1,
            'accept', ${warehouseId}, ${connectedBy}, now(), now())
    returning id
  `) as unknown as { id: string }[];
  const connectionId = inserted[0]!.id;

  const mapped = await call(
    `/tenants/${tenantId}/channels/connections/${connectionId}/mappings`,
    'PUT',
    { items: skuRefs.map((externalRef, index) => ({ externalRef, skuId: skuIds[index]! })) },
    { ...owner, [KEY]: ulid() },
  );
  if (mapped.status !== 200) throw new Error(`mapping PUT failed: ${mapped.status}`);

  const binRow = (await direct`
    select id from bins where warehouse_id = ${warehouseId} order by code asc limit 1
  `) as unknown as { id: string }[];
  const binId = binRow[0]!.id;

  for (const skuId of skuIds) {
    const applied = await call(
      `/tenants/${tenantId}/inventory/adjustments`,
      'POST',
      {
        warehouseId,
        skuId,
        binId,
        quantityDelta: args.seedQuantity,
        reasonCode: 'stock-count',
        note: 'loadtest seed',
      },
      { ...owner, [KEY]: ulid() },
    );
    if (applied.status > 201) throw new Error(`seed adjustment failed: ${applied.status}`);
  }
  // The grant store fails closed until the counters exist (the suites' rule).
  await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

  return { tenantId, token, warehouseId, binId, connectionId, skuRefs, skuIds, origin, direct, app };
}

/* ── the run ────────────────────────────────────────────────────────────── */

interface RequestRecord {
  readonly kind: 'ingest' | 'cancel' | 'adjust';
  readonly at: number;
  /** null = the request died at the client timeout (the deadlock signal). */
  readonly latencyMs: number | null;
  readonly status: number | null;
  readonly outcome: string;
  /** Set on cancels whose window passed before they could be sent. */
  readonly dropped?: boolean;
}

const records: RequestRecord[] = [];

/** The pinned client: a counted semaphore + the per-request timeout. */
let inFlight = 0;
let maxInFlight = 0;
const waiters: (() => void)[] = [];

async function withSlot(fn: () => Promise<void>): Promise<void> {
  while (inFlight >= args.concurrency) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await fn();
  } finally {
    inFlight -= 1;
    waiters.shift()?.();
  }
}

function sign(bodyText: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(bodyText, 'utf8').digest('base64');
}

function orderBody(ref: string, lines: { sku: string; quantity: number }[]): string {
  return JSON.stringify({
    id: Number(ref),
    shipping_address: {
      name: 'Ravi Kumar',
      phone: '9876543210',
      address1: 'Plot 12',
      city: 'Hyderabad',
      province: 'Telangana',
      zip: '500081',
    },
    line_items: lines,
  });
}

function cancelBody(ref: string): string {
  return JSON.stringify({ id: Number(ref) });
}

const cancelSentAt = new Map<string, number>();

async function runLoad(ctx: RunContext): Promise<void> {
  const orderUrl = `${ctx.origin}${API}/tenants/${ctx.tenantId}/webhooks/channels/${PROVIDER}/${ctx.connectionId}/orders`;
  const cancelUrl = `${ctx.origin}${API}/tenants/${ctx.tenantId}/webhooks/channels/${PROVIDER}/${ctx.connectionId}/cancellations`;
  const adjustUrl = `${ctx.origin}${API}/tenants/${ctx.tenantId}/inventory/adjustments`;
  const owner = { Authorization: `Bearer ${ctx.token}` };

  const runEnd = Date.now() + args.durationS * 1000;
  let nextIngest = Date.now();
  let nextAdjust = Date.now();
  let nextRef = 0n;
  const pendingCancels: { ref: string; dueAt: number }[] = [];
  const rng = Math.random;

  const sendOrder = (ref: string): void => {
    // Mostly 1-3-line orders of 1-3 units; ~5% big ones that cross the seed
    // and exercise the backordered acceptance arm under churn.
    const lineCount = 1 + Math.floor(rng() * args.maxOrderLines);
    const big = rng() < 0.05;
    const lines = Array.from({ length: lineCount }, () => ({
      sku: ctx.skuRefs[Math.floor(rng() * ctx.skuRefs.length)]!,
      quantity: big ? 50 + Math.floor(rng() * 150) : 1 + Math.floor(rng() * 3),
    }));
    const bodyText = orderBody(ref, lines);
    void withSlot(async () => {
      const at = Date.now();
      try {
        const response = await fetch(orderUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Load-Hmac': sign(bodyText),
            'X-Load-Topic': 'orders/create',
          },
          body: bodyText,
          signal: AbortSignal.timeout(args.requestTimeoutMs),
        });
        const text = await response.text();
        let outcome = `status-${response.status}`;
        try {
          outcome = (JSON.parse(text) as { outcome?: string }).outcome ?? outcome;
        } catch {
          // keep the status-code fallback (a non-JSON problem body)
        }
        records.push({ kind: 'ingest', at, latencyMs: Date.now() - at, status: response.status, outcome });
        if (response.status === 200 && outcome === 'accepted' && rng() < 0.2) {
          // 20% of accepted orders get a channel-side cancellation — the
          // echo exercises the writeback path at run cadence.
          pendingCancels.push({ ref, dueAt: Date.now() + 1500 + Math.floor(rng() * 4500) });
        }
      } catch {
        records.push({ kind: 'ingest', at, latencyMs: null, status: null, outcome: 'client-timeout' });
      }
    });
  };

  const sendAdjust = (): void => {
    void withSlot(async () => {
      const at = Date.now();
      // Small churn around the seed: draws (bounded so a 422 low-stock is a
      // routine churn outcome, not a client error) and adds.
      const delta = rng() < 0.55 ? -(1 + Math.floor(rng() * 4)) : 1 + Math.floor(rng() * 3);
      const body = {
        warehouseId: ctx.warehouseId,
        skuId: ctx.skuIds[Math.floor(rng() * ctx.skuIds.length)],
        binId: ctx.binId,
        quantityDelta: delta,
        reasonCode: 'stock-count',
        note: 'loadtest churn',
      };
      try {
        const response = await fetch(adjustUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...owner, [KEY]: ulid() },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(args.requestTimeoutMs),
        });
        await response.text();
        records.push({ kind: 'adjust', at, latencyMs: Date.now() - at, status: response.status, outcome: `status-${response.status}` });
      } catch {
        records.push({ kind: 'adjust', at, latencyMs: null, status: null, outcome: 'client-timeout' });
      }
    });
  };

  const sendCancel = (ref: string): void => {
    cancelSentAt.set(ref, Date.now());
    const bodyText = cancelBody(ref);
    void withSlot(async () => {
      const at = Date.now();
      try {
        const response = await fetch(cancelUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Load-Hmac': sign(bodyText),
            'X-Load-Topic': 'orders/cancelled',
          },
          body: bodyText,
          signal: AbortSignal.timeout(args.requestTimeoutMs),
        });
        const text = await response.text();
        let outcome = `status-${response.status}`;
        try {
          outcome = (JSON.parse(text) as { outcome?: string }).outcome ?? outcome;
        } catch {
          // keep the status-code fallback
        }
        records.push({ kind: 'cancel', at, latencyMs: Date.now() - at, status: response.status, outcome });
      } catch {
        records.push({ kind: 'cancel', at, latencyMs: null, status: null, outcome: 'client-timeout' });
      }
    });
  };

  // ── the wall-clock pacing loop ────────────────────────────────────────
  const ingestIntervalMs = 1000 / ingestRatePerS;
  while (Date.now() < runEnd) {
    const now = Date.now();
    if (now >= nextIngest) {
      sendOrder(String(REF_BASE + nextRef));
      nextRef += 1n;
      nextIngest = now + ingestIntervalMs;
    }
    if (now >= nextAdjust) {
      sendAdjust();
      nextAdjust = now + args.adjustIntervalMs;
    }
    const done: number[] = [];
    for (const [index, cancel] of pendingCancels.entries()) {
      if (cancel.dueAt <= now) {
        sendCancel(cancel.ref);
        done.push(index);
      } else if (cancel.dueAt >= runEnd) {
        // Never due within the window — dropped, counted in the report.
        records.push({ kind: 'cancel', at: now, latencyMs: null, status: null, outcome: 'dropped-at-run-end', dropped: true });
        done.push(index);
      }
    }
    for (const index of done.reverse()) pendingCancels.splice(index, 1);
    // Sleep to the next scheduled event (bounded ticks of resolution).
    const gap = Math.max(2, Math.min(nextIngest - Date.now(), 25));
    await new Promise((resolve) => setTimeout(resolve, gap));
  }

  // Drain: everything the window already scheduled finishes (bounded by the
  // client timeout + a grace); the rest are dropped and counted.
  const drainUntil = Date.now() + args.requestTimeoutMs + 2000;
  while (Date.now() < drainUntil) {
    for (const cancel of pendingCancels) {
      if (cancel.dueAt <= Date.now()) {
        sendCancel(cancel.ref);
      } else {
        records.push({ kind: 'cancel', at: Date.now(), latencyMs: null, status: null, outcome: 'dropped-at-run-end', dropped: true });
      }
    }
    pendingCancels.length = 0;
    if (inFlight === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  // The writeback echoes settle through the relay (poll 250ms) — wait for
  // the last release's arm call, bounded, then stop.
  const settleUntil = Date.now() + 15_000;
  const releasedCount = records.filter((r) => r.kind === 'cancel' && r.outcome === 'released').length;
  while (Date.now() < settleUntil && writebackCalledAt.size < releasedCount) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/* ── verification (the RD-10 oversell definition, over direct SQL) ─────── */

interface Violation {
  readonly scope: string;
  readonly detail: string;
}

async function verify(ctx: RunContext): Promise<{
  readonly ledgerStockParityViolations: readonly Violation[];
  readonly reservationOrderParityViolations: readonly Violation[];
  readonly oversellViolations: readonly Violation[];
}> {
  const t = ctx.tenantId;
  const direct = ctx.direct;

  // (a) journal/stock parity: the replayed ledger sum vs stock_on_hand.
  type Row = { warehouse_id: string; sku_id: string; ledger: string | null; stock: string | null };
  const ledgerRows = (await direct`
    with ledger as (
      select warehouse_id, sku_id, sum(quantity_delta)::text as ledger
      from ledger_events where tenant_id = ${t} group by 1, 2
    ),
    stock as (
      select warehouse_id, sku_id, sum(quantity)::text as stock
      from stock_on_hand where tenant_id = ${t} group by 1, 2
    )
    select coalesce(l.warehouse_id, s.warehouse_id) as warehouse_id,
           coalesce(l.sku_id, s.sku_id) as sku_id,
           l.ledger, s.stock
    from ledger l full outer join stock s on l.warehouse_id = s.warehouse_id and l.sku_id = s.sku_id
    where coalesce(l.ledger, '0') is distinct from coalesce(s.stock, '0')
  `) as unknown as Row[];
  const ledgerStockParityViolations: Violation[] = ledgerRows.map((row) => ({
    scope: `${row.warehouse_id}/${row.sku_id}`,
    detail: `ledger sum ${row.ledger ?? 'absent'} vs stock_on_hand ${row.stock ?? 'absent'}`,
  }));

  // (b) reservation/order parity: Σ held vs Σ live order_lines.reserved_qty.
  type HoldRow = { warehouse_id: string; sku_id: string; held: string | null; reserved: string | null };
  const holdRows = (await direct`
    with held as (
      select warehouse_id, sku_id, sum(quantity)::text as held
      from reservations where tenant_id = ${t} and owner_type = 'order' and state = 'held' group by 1, 2
    ),
    reserved as (
      select o.warehouse_id, l.sku_id, sum(l.reserved_qty)::text as reserved
      from order_lines l join orders o on o.id = l.order_id and o.tenant_id = ${t}
      where o.status in ('accepted', 'backordered') group by 1, 2
    )
    select coalesce(h.warehouse_id, r.warehouse_id) as warehouse_id,
           coalesce(h.sku_id, r.sku_id) as sku_id,
           h.held, r.reserved
    from held h full outer join reserved r on h.warehouse_id = r.warehouse_id and h.sku_id = r.sku_id
    where coalesce(h.held, '0') is distinct from coalesce(r.reserved, '0')
  `) as unknown as HoldRow[];
  const reservationOrderParityViolations: Violation[] = holdRows.map((row) => ({
    scope: `${row.warehouse_id}/${row.sku_id}`,
    detail: `held reservations ${row.held ?? 'none'} vs order_lines.reserved_qty ${row.reserved ?? 'none'}`,
  }));

  // (c) the negative-headroom re-derivation: grants vs on-hand at grant time.
  type DeltaRow = { warehouse_id: string; sku_id: string; delta: string; at: string };
  const deltas = (await direct`
    select warehouse_id, sku_id, quantity_delta::text as delta, recorded_at::text as at
    from ledger_events where tenant_id = ${t} order by recorded_at asc, seq asc
  `) as unknown as DeltaRow[];
  type GrantRow = {
    warehouse_id: string;
    sku_id: string;
    quantity: string;
    state: string;
    created_at: string;
    updated_at: string;
  };
  const grants = (await direct`
    select warehouse_id, sku_id, quantity::text as quantity, state,
           created_at::text, updated_at::text
    from reservations where tenant_id = ${t} and owner_type = 'order'
  `) as unknown as GrantRow[];

  const oversellViolations: Violation[] = [];
  const scopes = new Set<string>([
    ...deltas.map((row) => `${row.warehouse_id}/${row.sku_id}`),
    ...grants.map((row) => `${row.warehouse_id}/${row.sku_id}`),
  ]);
  for (const scope of scopes) {
    const [warehouseId, skuId] = scope.split('/');
    const scopeDeltas = deltas
      .filter((row) => row.warehouse_id === warehouseId && row.sku_id === skuId)
      .map((row) => ({ at: Date.parse(row.at), delta: Number(row.delta) }))
      .sort((a, b) => a.at - b.at);
    const scopeGrants = grants
      .filter((row) => row.warehouse_id === warehouseId && row.sku_id === skuId)
      .map((row) => ({
        at: Date.parse(row.created_at),
        releasedAt: row.state === 'released' ? Date.parse(row.updated_at) : Number.POSITIVE_INFINITY,
        qty: Number(row.quantity),
      }));
    // At each grant instant: the still-held grants vs on-hand up to then.
    for (const grant of scopeGrants) {
      let onHand = 0;
      for (const d of scopeDeltas) {
        if (d.at <= grant.at) onHand += d.delta;
        else break;
      }
      let active = 0;
      for (const other of scopeGrants) {
        if (other.at <= grant.at && other.releasedAt > grant.at) active += other.qty;
      }
      if (active > onHand) {
        oversellViolations.push({
          scope,
          detail: `grants totaling ${active} held at ${new Date(grant.at).toISOString()} against on-hand ${onHand}`,
        });
      }
    }
  }
  return { ledgerStockParityViolations, reservationOrderParityViolations, oversellViolations };
}

/* ── the report ─────────────────────────────────────────────────────────── */

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

interface Report {
  readonly environment: string;
  readonly invocation: string;
  readonly harnessFlags: Args & { readonly outboxRelayPollMs: string };
  readonly workload: {
    readonly ingestTargetPerSecond: number;
    readonly achievedIngestPerSecond: number;
    readonly achievedVsTarget: string;
    readonly adjustAttempted: number;
    readonly cancelAttemptedSent: number;
    readonly cancelDroppedAtRunEnd: number;
  };
  readonly acceptance: {
    readonly delivered: number;
    readonly outcomes: Record<string, number>;
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
    readonly p99Ms: number | null;
    readonly maxMs: number | null;
    readonly over5sCount: number;
    readonly over5sFraction: number;
  };
  readonly writeback: {
    readonly echoCount: number;
    readonly medianLagMs: number | null;
    readonly maxLagMs: number | null;
  };
  readonly integrity: {
    readonly ledgerStockParityViolations: readonly Violation[];
    readonly reservationOrderParityViolations: readonly Violation[];
    readonly oversellViolations: readonly Violation[];
    readonly note: string;
  };
  readonly client: {
    readonly timeouts: number;
    readonly maxInFlight: number;
    readonly concurrencyBound: number;
    readonly requestTimeoutMs: number;
  };
  readonly metering: Record<string, Record<string, number>>;
  readonly gates: { readonly pass: boolean; readonly failures: readonly string[] };
}

async function main(): Promise<void> {
  console.log(
    `loadtest-acceptance: mode=${args.mode} duration=${args.durationS}s target ingest=${ingestRatePerS.toFixed(3)}/s ` +
      `(median ${args.medianRateRph}/h × ${args.amplify}) churn every ${args.adjustIntervalMs}ms ` +
      `concurrency=${args.concurrency} request-timeout=${args.requestTimeoutMs}ms`,
  );
  const ctx = await seedTenant();
  await runLoad(ctx);
  const { ledgerStockParityViolations, reservationOrderParityViolations, oversellViolations } =
    await verify(ctx);

  const ingest = records.filter((r) => r.kind === 'ingest');
  const latencies = ingest.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs!);
  const outcomes: Record<string, number> = {};
  for (const record of ingest) {
    outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
  }
  const over5s = latencies.filter((ms) => ms > 5000).length;
  const p95 = percentile(latencies, 95);

  const lags = [...cancelSentAt.entries()]
    .filter(([ref]) => writebackCalledAt.has(ref))
    .map(([ref, sent]) => writebackCalledAt.get(ref)! - sent)
    .sort((a, b) => a - b);

  const meterRows = (await ctx.direct`
    select kind, status, count(*)::int as count
    from integration_calls where tenant_id = ${ctx.tenantId}
    group by kind, status order by kind, status
  `) as unknown as { kind: string; status: string; count: number }[];
  const metering: Record<string, Record<string, number>> = {};
  for (const row of meterRows) {
    metering[row.kind] ??= {};
    metering[row.kind]![row.status] = row.count;
  }

  const timeouts = records.filter((r) => r.latencyMs === null && !r.dropped).length;
  const failures: string[] = [];
  if (p95 === null) failures.push('no delivered ingest answer measured');
  else if (p95 > 4000) failures.push(`accept-p95 ${p95}ms > 4000ms`);
  if (over5s > 0) failures.push(`${over5s} ingest answer(s) over 5s`);
  if (timeouts > 0) failures.push(`${timeouts} request(s) died at the client timeout (pool-deadlock signal)`);
  if (ledgerStockParityViolations.length > 0) failures.push('journal/stock parity broken');
  if (reservationOrderParityViolations.length > 0) failures.push('reservation/order parity broken');
  if (oversellViolations.length > 0) failures.push(`${oversellViolations.length} oversell timeline violation(s)`);

  const report: Report = {
    environment:
      `local compose Postgres (${new URL(process.env.DATABASE_URL!).host}) + Valkey ` +
      `(${new URL(process.env.VALKEY_URL!).host}); wms-be default pools; ` +
      `${typeof Bun !== 'undefined' ? `bun ${Bun.version}` : 'node'}`,
    invocation: `bun scripts/loadtest-acceptance.ts --mode ${args.mode} --duration-s ${args.durationS} --median-rate-rph ${args.medianRateRph} --amplify ${args.amplify}`,
    harnessFlags: { ...args, outboxRelayPollMs: process.env.OUTBOX_RELAY_POLL_MS ?? '(default)' },
    workload: {
      ingestTargetPerSecond: Number(ingestRatePerS.toFixed(4)),
      achievedIngestPerSecond: Number((ingest.length / args.durationS).toFixed(4)),
      achievedVsTarget:
        ingestRatePerS === 0
          ? 'n/a'
          : `${Math.round((ingest.length / args.durationS / ingestRatePerS) * 100)}% of target`,
      adjustAttempted: records.filter((r) => r.kind === 'adjust').length,
      cancelAttemptedSent: cancelSentAt.size,
      cancelDroppedAtRunEnd: records.filter((r) => r.dropped === true).length,
    },
    acceptance: {
      delivered: latencies.length,
      outcomes,
      p50Ms: percentile(latencies, 50),
      p95Ms: p95,
      p99Ms: percentile(latencies, 99),
      maxMs: latencies.length > 0 ? Math.max(...latencies) : null,
      over5sCount: over5s,
      over5sFraction: latencies.length === 0 ? 0 : Number((over5s / latencies.length).toFixed(4)),
    },
    writeback: {
      echoCount: lags.length,
      medianLagMs: lags.length > 0 ? lags[Math.floor(lags.length / 2)]! : null,
      maxLagMs: lags.length > 0 ? lags[lags.length - 1]! : null,
    },
    integrity: {
      ledgerStockParityViolations,
      reservationOrderParityViolations,
      oversellViolations,
      note: 'oversell = per (warehouse, sku), at every grant point: Σ held ≤ on-hand replayed from the ledger at that instant; grant/release times come from the reservations rows themselves. Cross-table timestamp ordering (ledger recorded_at vs reservation created_at) is an approximation the report accepts and names.',
    },
    client: {
      timeouts,
      maxInFlight,
      concurrencyBound: args.concurrency,
      requestTimeoutMs: args.requestTimeoutMs,
    },
    metering,
    gates: { pass: failures.length === 0, failures },
  };

  console.log('\n=== loadtest-acceptance report ===');
  console.log(JSON.stringify(report, null, 2));
  if (args.reportPath !== null) {
    await Bun.write(args.reportPath, JSON.stringify(report, null, 2));
    console.log(`report written to ${args.reportPath}`);
  }

  await ctx.app.close();
  await ctx.direct.end();
  if (!args.keepDb) await suiteDb!.drop();
  process.exit(report.gates.pass ? 0 : 1);
}

try {
  await main();
} catch (err) {
  console.error('loadtest-acceptance failed:', err instanceof Error ? err.message : err);
  process.exit(2);
}