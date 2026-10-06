/**
 * Story 9-1 — the Overview's load check (NFR-6: the dashboard renders under
 * 2 s p95 for a tenant with 100k ledger events/month — ~25k in the 7-day
 * window the tiles read). REPORTED, not a CI gate.
 *
 * What it does:
 *   1. clones the jest template into `wms_s_loadtest_overview` (rebuilding the
 *      template via test/support/global-setup.cjs when absent);
 *   2. boots the real app and seeds a tenant + warehouse + bin + SKUs over
 *      HTTP;
 *   3. seeds ~`--events` ledger events for that ONE warehouse, spread evenly
 *      over the last 7 days by `recorded_at`, THROUGH THE INVENTORY FACADE
 *      (`appendLedgerEventInTx` under `lockWarehouseInTx`, in batches of
 *      `--batch` per transaction — the real hash chain and projections):
 *      a mix of `stock.adjusted` receipts, `pick.picked` draws and
 *      zero-quantity `dispatch.dispatched` events;
 *   4. seeds, at volume and with the same 7-day spread, every relational
 *      source a tile reads — by bulk insert (the read model is what is
 *      measured): one `picks` row per pick event; GRNs (a quarter blind) with
 *      lines, putaway placements and over-receipts; orders + order lines
 *      (a third ingested, a slice backordered, a status mix); waves,
 *      picklists and picklist lines (a slice short); batch alerts; issued
 *      invoices + lines + e-way bills; both 9-1 fact tables;
 *   5. reads `GET …/reporting/overview` `--reads` times (after a warm-up) and
 *      reports min / median / p95 / max overall AND per tile (each tile run
 *      timed in-process), plus how many reads came back `stale`.
 *
 * Usage (from wms-be, local compose Postgres :55432 + Valkey :56379):
 *   bun scripts/loadtest-overview.ts [--events 25000] [--batch 500] [--reads 40] [--keep-db]
 */

/* eslint-disable no-console */
import postgres from 'postgres';
import { chdir } from 'node:process';
import { pathToFileURL } from 'node:url';

interface Args {
  readonly events: number;
  readonly batch: number;
  readonly reads: number;
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
  return {
    events: value('--events', 25_000),
    batch: value('--batch', 500),
    reads: value('--reads', 40),
    keepDb: argv.includes('--keep-db'),
  };
}

const args = parseArgs(process.argv.slice(2));

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'loadtest-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'loadtest-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// No background worker may compete with the reads being measured.
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

chdir(new URL('../', import.meta.url).pathname);

const { useSuiteDatabase } = await import('../test/support/suite-db');
const { createApp } = await import('../src/app.factory');
const { InventoryFacade } = await import('../src/modules/inventory/inventory.facade');
const { DATABASE } = await import('../src/shared/shared.module');
const { withTenantTransaction } = await import('../src/shared/db/tenant-scope');
const { uuidv7, ulid } = await import('../src/shared/primitives/ids');
const { reportingWindow } = await import('../src/modules/reporting/window');
const { ReportingFacade } = await import('../src/modules/reporting/reporting.facade');
const { signedQuantity } = await import('../src/shared/primitives/quantity');

const API = '/api/v1';

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

async function call(origin: string, path: string, method: 'GET' | 'POST', body?: unknown, token?: string): Promise<{ status: number; body: unknown }> {
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
  return { status: response.status, body: text.length === 0 ? null : (JSON.parse(text) as unknown) };
}

/** A setup call that must succeed: anything but the expected status aborts the run, naming it. */
async function expectCall<T>(
  origin: string,
  label: string,
  expected: number,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  token?: string,
): Promise<T> {
  const answer = await call(origin, path, method, body, token);
  if (answer.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  return answer.body as T;
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

async function main(): Promise<void> {
  await ensureTemplate();
  const suiteDb = await useSuiteDatabase('loadtest_overview');
  const app = await createApp(false);
  await app.init();
  await app.listen(0);
  const origin = new URL(await app.getUrl()).origin.replace('[::1]', 'localhost');
  const direct = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
  try {
    // ── tenant, warehouse, bin, SKUs (real HTTP) ──────────────────────────
    const email = `owner-${uuidv7()}@example.com`;
    const registered = await expectCall<{ tenant: { id: string }; owner: { id: string } }>(origin, 'register', 201, '/tenants', 'POST', {
      name: `Overview Load ${uuidv7().slice(0, 8)}`,
      ownerEmail: email,
      password: 'correct-horse-battery',
    });
    const tenantId = registered.tenant.id;
    const ownerId = registered.owner.id;
    const token = (
      await expectCall<{ accessToken: string }>(origin, 'sign-in', 200, '/tenants/sign-in', 'POST', {
        email,
        password: 'correct-horse-battery',
      })
    ).accessToken;
    const warehouseId = (await expectCall<{ id: string }>(origin, 'warehouse', 201, `/tenants/${tenantId}/warehouses`, 'POST', {
      origin: {
        contactName: 'Priya Sharma',
        phone: '+91 98450 12345',
        line1: '12, Peenya Industrial Area',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560066',
      },
      code: `OV${uuidv7().slice(0, 6).toUpperCase()}`,
      name: 'Overview Load WH',
    }, token)).id;
    const zoneId = (
      await expectCall<{ id: string }>(origin, 'zone', 201, `/tenants/${tenantId}/warehouses/${warehouseId}/zones`, 'POST', { code: 'A', name: 'A' }, token)
    ).id;
    const binId = (
      await expectCall<{ id: string }>(origin, 'bin', 201, `/tenants/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`, 'POST', {
        capacity: 1_000_000_000,
        type: 'shelf',
        code: 'A-01-01',
      }, token)
    ).id;
    const skuCount = 20;
    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
      ...Array.from({ length: skuCount }, (_, index) => `OVL-${index},Overview SKU ${index},pcs,,1800,,false,false,,,`),
    ].join('\n');
    const form = new FormData();
    form.set('mode', 'initial');
    form.set('file', new Blob([csv], { type: 'text/csv' }), 'catalog.csv');
    const imported = await fetch(`${origin}${API}/tenants/${tenantId}/catalog/imports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': ulid() },
      body: form,
    });
    if (imported.status !== 201) throw new Error(`catalog import answered ${imported.status}: ${await imported.text()}`);
    const skuIds = (
      (await direct`select id from skus where tenant_id = ${tenantId} order by code`) as unknown as { id: string }[]
    ).map((row) => row.id);
    if (skuIds.length !== skuCount) throw new Error(`expected ${skuCount} SKUs, found ${skuIds.length}`);

    // ── ledger events through the inventory facade, spread over 7 days ────
    const inventory = app.get(InventoryFacade);
    const db = app.get(DATABASE);
    const now = Date.now();
    const windowStart = reportingWindow(new Date(now)).d7From;
    const spanMs = now - Date.parse(windowStart) - 60_000;
    const seededStarted = Date.now();
    const pickRows: { at: string; skuId: string }[] = [];
    let appended = 0;
    while (appended < args.events) {
      const size = Math.min(args.batch, args.events - appended);
      const offset = appended;
      await withTenantTransaction(db, tenantId, async (tx) => {
        await inventory.lockWarehouseInTx(tx, tenantId, warehouseId);
        for (let i = 0; i < size; i += 1) {
          const n = offset + i;
          // Oldest first so recorded_at rises with seq (the real shape).
          const at = new Date(Date.parse(windowStart) + Math.floor((n / args.events) * spanMs)).toISOString();
          // Each SKU takes a whole 5-event block (receive, receive, pick,
          // pick, dispatch), so no draw ever outruns its receipts.
          const skuId = skuIds[Math.floor(n / 5) % skuCount]!;
          const kind = n % 5; // 0,1 receipt · 2,3 pick · 4 dispatch
          const orderId = uuidv7();
          const orderLineId = uuidv7();
          if (kind <= 1) {
            await inventory.appendLedgerEventInTx(tx, {
              tenantId, warehouseId, type: 'stock.adjusted', skuId, quantityDelta: signedQuantity(2000),
              fromBinId: null, toBinId: binId, batchRef: null, serialRef: null, actorUserId: ownerId,
              occurredAt: at, recordedAt: at,
              referenceDoc: { kind: 'manual-adjustment', reasonCode: 'stock-count', note: 'overview load' },
            });
          } else if (kind <= 3) {
            await inventory.appendLedgerEventInTx(tx, {
              tenantId, warehouseId, type: 'pick.picked', skuId, quantityDelta: signedQuantity(-1000),
              fromBinId: binId, toBinId: null, batchRef: null, serialRef: null, actorUserId: ownerId,
              occurredAt: at, recordedAt: at,
              referenceDoc: {
                kind: 'pick', picklistId: uuidv7(), picklistLineId: uuidv7(), waveId: uuidv7(), orderId, orderLineId,
              },
            });
            pickRows.push({ at, skuId });
          } else {
            await inventory.appendLedgerEventInTx(tx, {
              tenantId, warehouseId, type: 'dispatch.dispatched', skuId, quantityDelta: signedQuantity(0),
              fromBinId: null, toBinId: null, batchRef: null, serialRef: null, actorUserId: ownerId,
              occurredAt: at, recordedAt: at,
              referenceDoc: { kind: 'dispatch', orderId, orderLineId, dispatchedQty: 1 },
            });
          }
        }
      });
      appended += size;
      if (appended % (args.batch * 10) === 0 || appended === args.events) {
        console.log(`  ledger: ${appended}/${args.events} events`);
      }
    }
    const ledgerSeconds = (Date.now() - seededStarted) / 1000;

    // ── the relational sources the tiles read, same 7-day spread ──────────
    const deviceId = uuidv7();
    for (let start = 0; start < pickRows.length; start += 1000) {
      const chunk = pickRows.slice(start, start + 1000).map((row) => ({
        id: uuidv7(), tenant_id: tenantId, warehouse_id: warehouseId, wave_id: uuidv7(), picklist_id: uuidv7(),
        picklist_line_id: uuidv7(), order_id: uuidv7(), order_line_id: uuidv7(), sku_id: row.skuId, bin_id: binId,
        qty: 1000, picked_by: ownerId, picked_at: row.at, device_id: deviceId, created_at: row.at, updated_at: row.at,
      }));
      await direct`insert into picks ${direct(chunk)}`;
    }
    const grnCount = Math.max(1, Math.floor(args.events / 50));
    for (let index = 0; index < grnCount; index += 1) {
      const at = new Date(Date.parse(windowStart) + Math.floor((index / grnCount) * spanMs)).toISOString();
      const placedAt = new Date(Date.parse(at) + 45 * 60_000).toISOString();
      const grnId = uuidv7();
      const lineId = uuidv7();
      await direct`
        insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, blind_reason_code, device_id, recorded_by, occurred_at, recorded_at, created_at, updated_at)
        values (${grnId}, ${tenantId}, ${warehouseId}, ${`GRN-OVL-${index}`}, null, ${index % 4 === 0 ? 'unannounced-delivery' : null},
          ${deviceId}, ${ownerId}, ${at}, ${at}, ${at}, ${at})`;
      await direct`
        insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty, created_at, updated_at)
        values (${lineId}, ${tenantId}, ${grnId}, ${skuIds[index % skuCount]!}, 5000, 5000, ${at}, ${at})`;
      if (Date.parse(placedAt) < now) {
        await direct`
          insert into putaway_placements (id, tenant_id, warehouse_id, grn_id, grn_line_id, sku_id, qty, from_bin_id, to_bin_id, placed_by, placed_at, device_id, created_at, updated_at)
          values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${grnId}, ${lineId}, ${skuIds[index % skuCount]!}, 5000, ${binId}, ${binId},
            ${ownerId}, ${placedAt}, ${deviceId}, ${placedAt}, ${placedAt})`;
      }
    }
    // ── the outbound / inbound / compliance sources, same spread ─────────
    const spreadAt = (index: number, count: number): string =>
      new Date(Date.parse(windowStart) + Math.floor((index / count) * spanMs)).toISOString();
    const clientId = ((await direct`select id from clients where tenant_id = ${tenantId} limit 1`) as unknown as { id: string }[])[0]!.id;
    const integrationId = uuidv7();
    await direct`
      insert into integrations (id, tenant_id, provider, status, credential_sealed, backorder_policy, ingest_warehouse_id, connected_by, last_synced_at)
      values (${integrationId}, ${tenantId}, 'shopify', 'connected', 'v1:aa:bb:cc', 'reject', ${warehouseId}, ${ownerId}, now())`;
    const orderCount = Math.max(10, Math.floor(args.events / 25));
    const orderRows: Record<string, unknown>[] = [];
    const lineRows: Record<string, unknown>[] = [];
    const waveRows: Record<string, unknown>[] = [];
    const picklistRows: Record<string, unknown>[] = [];
    const picklistLineRows: Record<string, unknown>[] = [];
    const statuses = ['accepted', 'ready_to_dispatch', 'dispatched'] as const;
    for (let index = 0; index < orderCount; index += 1) {
      const at = spreadAt(index, orderCount);
      const orderId = uuidv7();
      const ingested = index % 3 === 0;
      orderRows.push({
        id: orderId, tenant_id: tenantId, client_id: clientId, warehouse_id: warehouseId,
        status: statuses[index % 3]!, source: ingested ? 'ingested' : 'manual',
        integration_id: ingested ? integrationId : null, external_event_id: ingested ? `EVT-${index}` : null,
        created_at: at, updated_at: at,
      });
      const waveId = uuidv7();
      const picklistId = uuidv7();
      waveRows.push({ id: waveId, tenant_id: tenantId, warehouse_id: warehouseId, policy_id: uuidv7(), status: 'released', released_at: at, created_at: at, updated_at: at });
      picklistRows.push({ id: picklistId, tenant_id: tenantId, warehouse_id: warehouseId, wave_id: waveId, order_id: orderId, status: 'ready', created_at: at, updated_at: at });
      for (let line = 0; line < 3; line += 1) {
        const lineId = uuidv7();
        const backordered = ingested && line === 0 && index % 2 === 0;
        lineRows.push({
          id: lineId, tenant_id: tenantId, order_id: orderId, sku_id: skuIds[(index + line) % skuCount]!,
          qty: 2000, reserved_qty: backordered ? 0 : 2000, status: backordered ? 'backordered' : 'open', created_at: at, updated_at: at,
        });
        const short = line === 1 && index % 10 === 0;
        picklistLineRows.push({
          id: uuidv7(), tenant_id: tenantId, picklist_id: picklistId, wave_id: waveId, order_id: orderId, order_line_id: lineId,
          sku_id: skuIds[(index + line) % skuCount]!, bin_id: binId, bin_code: 'A-01-01', qty: 2000,
          shortfall_qty: short ? 2000 : 0, reason_code: short ? 'bin-empty' : null,
          slice_seq: 0, walk_seq: line, status: short ? 'short' : 'picked', created_at: at, updated_at: at,
        });
      }
    }
    for (const [table, rows] of [
      ['orders', orderRows], ['order_lines', lineRows], ['waves', waveRows], ['picklists', picklistRows], ['picklist_lines', picklistLineRows],
    ] as const) {
      for (let start = 0; start < rows.length; start += 1000) {
        await direct`insert into ${direct(table)} ${direct(rows.slice(start, start + 1000))}`;
      }
    }
    const grnRows = (await direct`
      select g.id as grn_id, l.id as line_id, l.sku_id, g.created_at::text as at from goods_receipt_notes g
      join goods_receipt_lines l on l.grn_id = g.id where g.tenant_id = ${tenantId}`) as unknown as {
      grn_id: string; line_id: string; sku_id: string; at: string;
    }[];
    const overRows = grnRows.filter((_, index) => index % 5 === 0).map((row, index) => ({
      id: uuidv7(), tenant_id: tenantId, warehouse_id: warehouseId, grn_id: row.grn_id, grn_line_id: row.line_id, sku_id: row.sku_id,
      excess_qty: 1000, status: index % 2 === 0 ? 'pending' : 'approved', requested_by: ownerId, requested_at: row.at, created_at: row.at, updated_at: row.at,
    }));
    if (overRows.length > 0) await direct`insert into over_receipts ${direct(overRows)}`;
    const alertCount = Math.max(10, Math.floor(args.events / 100));
    const alertRows = Array.from({ length: alertCount }, (_, index) => {
      const at = spreadAt(index, alertCount);
      return {
        id: uuidv7(), tenant_id: tenantId, warehouse_id: warehouseId, sku_id: skuIds[index % skuCount]!, batch_id: uuidv7(),
        kind: index % 2 === 0 ? 'expiry_upcoming' : 'aged', status: index % 3 === 0 ? 'open' : 'resolved', created_at: at, updated_at: at,
      };
    });
    await direct`insert into batch_alerts ${direct(alertRows)}`;
    const dispatched = orderRows.filter((row) => row.status === 'dispatched');
    const document = { header: { originAddress: null, consigneeAddress: null }, seller: { name: 'S' }, buyer: { name: 'B' }, lines: [], gaps: [] };
    const invoiceRows: Record<string, unknown>[] = [];
    const invoiceLineRows: Record<string, unknown>[] = [];
    const billRows: Record<string, unknown>[] = [];
    for (const [index, order] of dispatched.entries()) {
      const id = uuidv7();
      const at = order.created_at as string;
      invoiceRows.push({
        id, tenant_id: tenantId, order_id: order.id, warehouse_id: warehouseId, invoice_no: `OVL-${index}`, fy_label: 'FY-2627', series_seq: index + 1,
        status: 'issued', origin_gstin: '27AAAPZ1234C1ZV', subtotal_paise: 10_000_000, gst_paise: 0, total_paise: 10_000_000,
        payable_paise: 10_000_000, round_off_paise: 0, document: direct.json(document), issued_at: at, created_at: at, updated_at: at,
      });
      invoiceLineRows.push({
        id: uuidv7(), tenant_id: tenantId, invoice_id: id, order_line_id: uuidv7(), sku_code: 'OVL', sku_name: 'OVL', qty_milli: 1000,
        rate_paise: 10_000_000, rate_source: index % 4 === 0 ? 'manual' : 'order_line', taxable_paise: 10_000_000, gst_bps: 0, uom: 'pcs',
      });
      billRows.push({
        id: uuidv7(), tenant_id: tenantId, invoice_id: id, origin_gstin: '27AAAPZ1234C1ZV', status: index % 3 === 0 ? 'generated' : 'pending',
        consignment_value_paise: 10_000_000, threshold_paise: 5_000_000, threshold_rule: 'national',
        ewb_no: index % 3 === 0 ? String(100_000_000_000 + index) : null, ewb_generated_at: index % 3 === 0 ? at : null,
        source: index % 3 === 0 ? 'manual' : null, created_at: at, updated_at: at,
      });
    }
    for (const [table, rows] of [['invoices', invoiceRows], ['invoice_lines', invoiceLineRows], ['eway_bills', billRows]] as const) {
      for (let start = 0; start < rows.length; start += 1000) {
        if (rows.length > 0) await direct`insert into ${direct(table)} ${direct(rows.slice(start, start + 1000))}`;
      }
    }
    const factCount = Math.max(10, Math.floor(args.events / 100));
    await direct`insert into pack_verification_failures ${direct(Array.from({ length: factCount }, (_, index) => {
      const at = spreadAt(index, factCount);
      return {
        id: uuidv7(), tenant_id: tenantId, warehouse_id: warehouseId, order_id: orderRows[index % orderCount]!.id as string,
        entry: (['tenant', 'device', 'sync'] as const)[index % 3]!, actor_user_id: ownerId, mismatch: direct.json([]),
        idempotency_key: ulid(), created_at: at,
      };
    }))}`;
    await direct`insert into ingest_backorder_refusals ${direct(Array.from({ length: factCount }, (_, index) => {
      const at = spreadAt(index, factCount);
      return {
        id: uuidv7(), tenant_id: tenantId, warehouse_id: warehouseId, integration_id: integrationId,
        external_event_id: `EVT-REFUSED-${index}`, lines: direct.json([]), created_at: at,
      };
    }))}`;
    await direct`analyze`;
    const counted = (await direct`
      select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and warehouse_id = ${warehouseId}
        and recorded_at >= ${windowStart}`) as unknown as { n: number }[];

    // ── the reads ─────────────────────────────────────────────────────────
    // Each tile run is timed in-process (the facade's tile field is the
    // suites' own seam), so the report names which tile carries the cost.
    const facade = app.get(ReportingFacade);
    const tileMs = new Map<string, number[]>();
    let timing = false;
    facade.tiles = facade.tiles.map((tile) => ({
      ...tile,
      run: async (tx, ctx) => {
        const started = performance.now();
        try {
          return await tile.run(tx, ctx);
        } finally {
          if (timing) tileMs.set(tile.name, [...(tileMs.get(tile.name) ?? []), performance.now() - started]);
        }
      },
    }));
    const path = `/tenants/${tenantId}/warehouses/${warehouseId}/reporting/overview`;
    for (let warm = 0; warm < 3; warm += 1) await call(origin, path, 'GET', undefined, token);
    const durations: number[] = [];
    let stale = 0;
    timing = true;
    for (let read = 0; read < args.reads; read += 1) {
      const started = performance.now();
      const answer = await call(origin, path, 'GET', undefined, token);
      durations.push(performance.now() - started);
      if (answer.status !== 200) throw new Error(`overview answered ${answer.status}: ${JSON.stringify(answer.body)}`);
      if ((answer.body as { stale: boolean }).stale) stale += 1;
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const report = {
      ledgerEventsIn7d: counted[0]!.n,
      picksRows: pickRows.length,
      grns: grnCount,
      ledgerSeedSeconds: Number(ledgerSeconds.toFixed(1)),
      reads: args.reads,
      staleReads: stale,
      sources: {
        orders: orderCount,
        picklistLines: picklistLineRows.length,
        overReceipts: overRows.length,
        batchAlerts: alertCount,
        invoices: invoiceRows.length,
        ewayBills: billRows.length,
        packFailures: factCount,
        refusals: factCount,
      },
      ms: {
        min: Math.round(sorted[0]!),
        median: Math.round(percentile(sorted, 50)),
        p95: Math.round(percentile(sorted, 95)),
        max: Math.round(sorted.at(-1)!),
      },
      perTileMs: Object.fromEntries(
        [...tileMs.entries()].map(([name, values]) => {
          const ordered = [...values].sort((a, b) => a - b);
          return [name, { median: Math.round(percentile(ordered, 50)), p95: Math.round(percentile(ordered, 95)) }];
        }),
      ),
      budgetP95Ms: 2000,
      withinBudget: percentile(sorted, 95) < 2000,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await direct.end();
    for (const token of [DATABASE]) {
      const raw = app.get<unknown>(token) as { $client?: { end(): Promise<void> } };
      await raw.$client?.end();
    }
    await app.close();
    if (!args.keepDb) await suiteDb.drop();
  }
}

await main();
process.exit(0);
