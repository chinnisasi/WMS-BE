import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from '../src/shared/db/db';
import { uuidv7 } from '../src/shared/primitives/ids';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { ReceivingFacade } from '../src/modules/inbound/receiving.facade';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import {
  UOMS,
  UOM_ALIASES,
  UOM_PRECISION,
  WHOLE_UNIT_UOMS,
  resolveUom,
} from '../src/modules/catalog/uom';
import { QUANTITY_DECIMALS } from '../src/shared/primitives/quantity';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
// The device routes below seal their offline-store key at enrollment.
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const MIGRATION = resolve(process.cwd(), 'drizzle/0027_uom_vocabulary.sql');

/** Migration 0027, split the way the runner splits it. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** The `INSERT INTO <table> … VALUES …` statement, as text. */
function migrationBlock(table: string): string {
  const statement = migrationStatements().find((candidate) =>
    candidate.includes(`INSERT INTO ${table} `),
  );
  if (statement === undefined) throw new Error(`migration 0027 declares no ${table} rows`);
  return statement;
}

/** `('pcs','each'), ('kgs','kg')` → `[['pcs','each'], ['kgs','kg']]`. */
function parseValues(statement: string): [string, string][] {
  const body = statement.slice(statement.indexOf('VALUES') + 'VALUES'.length);
  return [...body.matchAll(/\(\s*'([^']*)'\s*,\s*'?([^',)]*)'?\s*\)/gu)].map(
    (match) => [match[1]!, match[2]!] as [string, string],
  );
}

/**
 * Part A — migration 0027 itself, against a database that still carries the
 * PRE-vocabulary schema and real rows in every column it touches. This is the
 * only test that can watch it work: every other suite starts from a template
 * that is already migrated, so the ninety lines of data movement below would
 * otherwise be pinned by nothing but a substring check on the file.
 *
 * The 10.1 harness (`test/fractional-quantity.spec.ts`) is the model, down to
 * copying the repo's real migrations folder and trimming the journal rather
 * than hand-writing a replica that can drift.
 */
describe('migration 0027, applied to pre-vocabulary data', () => {
  const PRE_DB = 'wms_s_uom_prevocab';
  let sql: ReturnType<typeof postgres>;
  let folder: string;

  const tenantId = uuidv7();
  const warehouseId = uuidv7();
  const zoneId = uuidv7();
  const binId = uuidv7();
  const tinyBinId = uuidv7();
  const pcsSkuId = uuidv7();
  const kgSkuId = uuidv7();
  const boxesSkuId = uuidv7();
  const batchId = uuidv7();
  const orderId = uuidv7();
  const orderLineId = uuidv7();
  const keptConversionId = '00000000-0000-7000-8000-000000000001';
  const droppedConversionId = '00000000-0000-7000-8000-000000000002';
  const identityConversionId = '00000000-0000-7000-8000-000000000003';
  const actorId = uuidv7();

  beforeAll(async () => {
    const adminUrl = new URL(process.env.DATABASE_URL!);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1 });
    try {
      await admin.unsafe(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`,
      );
      await admin.unsafe(`drop database if exists "${PRE_DB}"`);
      await admin.unsafe(`create database "${PRE_DB}"`);
    } finally {
      await admin.end();
    }
    const preUrl = new URL(process.env.DATABASE_URL!);
    preUrl.pathname = `/${PRE_DB}`;

    // A migrations folder that STOPS at 0026 — the schema as it stood the
    // moment before this story.
    folder = mkdtempSync(join(tmpdir(), 'wms-pre-0027-'));
    cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
    rmSync(join(folder, '0027_uom_vocabulary.sql'));
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 26);
    writeFileSync(journalPath, JSON.stringify(journal));

    const db = createDatabase(preUrl.toString());
    await migrate(db, { migrationsFolder: folder });
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

    sql = postgres(preUrl.toString(), { max: 2 });
    await seedPreVocabularyRows();

    // The two REFUSALS first, each inside a transaction that rolls back, so
    // the successful apply below still runs against the seeded state. Both
    // exist because a migration that aborts halfway is the worst outcome
    // available, and both of these would otherwise abort late — one at the
    // CHECK, one at the ledger guard.
    await expect(
      sql.begin(async (tx) => {
        await tx`update skus set uom = 'furlong' where id = ${kgSkuId}`;
        await tx`update uom_conversions set uom = 'hogshead' where id = ${keptConversionId}`;
        for (const statement of migrationStatements()) await tx.unsafe(statement);
      }),
    ).rejects.toThrow(/furlong[\s\S]*hogshead|hogshead[\s\S]*furlong/);

    await expect(
      sql.begin(async (tx) => {
        // The seeded ledger event is 18400 milli — legal for kg, fractional
        // for a whole-unit SKU. Declaring that SKU each-counted is exactly the
        // mistake the guard exists to stop, because the fix would be rewriting
        // an append-only, hash-chained event.
        await tx`update skus set uom = 'pcs' where id = ${kgSkuId}`;
        for (const statement of migrationStatements()) await tx.unsafe(statement);
      }),
    ).rejects.toThrow(/append-only and hash-chained/);

    // …then the real thing, in ONE transaction, the way the runner applies it.
    await sql.begin(async (tx) => {
      for (const statement of migrationStatements()) await tx.unsafe(statement);
    });
  }, 90_000);

  afterAll(async () => {
    await sql?.end();
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  });

  async function seedPreVocabularyRows(): Promise<void> {
    await sql`insert into tenants (id, tenant_id, name) values (${tenantId}, ${tenantId}, 'Pre-vocabulary Co')`;
    await sql`insert into warehouses (id, tenant_id, code, name) values (${warehouseId}, ${tenantId}, 'PRE', 'Pre WH')`;
    await sql`insert into zones (id, tenant_id, warehouse_id, code, name) values (${zoneId}, ${tenantId}, ${warehouseId}, 'A', 'Aisle A')`;
    // 120 whole units, and a bin whose capacity is BELOW half a unit — the one
    // that would round to zero and become a bin no putaway can ever enter.
    await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type)
      values (${binId}, ${tenantId}, ${warehouseId}, ${zoneId}, 'A-01-01', 120000, 'shelf')`;
    await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type)
      values (${tinyBinId}, ${tenantId}, ${warehouseId}, ${zoneId}, 'A-01-02', 400, 'shelf')`;

    // Three spellings no vocabulary has ever seen: an alias, an alias wearing
    // spreadsheet punctuation, and a plural.
    await sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, reorder_point, reorder_qty, barcode)
      values (${pcsSkuId}, ${tenantId}, 'PRE-PCS', 'Counted', 'pcs', 1800, 1500, 2400, 'BAR-PCS')`;
    await sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, reorder_point, reorder_qty, barcode)
      values (${kgSkuId}, ${tenantId}, 'PRE-KG', 'Measured', ' Kg. ', 1800, 2500, 10250, 'BAR-KG')`;
    await sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, reorder_point, reorder_qty, barcode)
      values (${boxesSkuId}, ${tenantId}, 'PRE-BOXES', 'Packed', 'boxes', 1800, 0, 0, 'BAR-BOXES')`;

    // The unique-index trap: two spellings of ONE target on one SKU. Both are
    // legal rows today and one row after normalization, so the rewrite would
    // abort on `uom_conversions_sku_id_uom_unique` unless they are deduped
    // first. Ids are ordered so "the oldest survives" is observable.
    await sql`insert into uom_conversions (id, tenant_id, sku_id, uom, factor)
      values (${keptConversionId}, ${tenantId}, ${pcsSkuId}, 'box', 12)`;
    await sql`insert into uom_conversions (id, tenant_id, sku_id, uom, factor)
      values (${droppedConversionId}, ${tenantId}, ${pcsSkuId}, 'boxes', 24)`;
    // …and an identity conversion: a target that resolves to the SKU's OWN
    // base unit, which is not a conversion at all.
    await sql`insert into uom_conversions (id, tenant_id, sku_id, uom, factor)
      values (${identityConversionId}, ${tenantId}, ${boxesSkuId}, 'box', 6)`;

    // A misaligned whole-unit balance, carried in both projections so the
    // "round them together" rule has something to be right about.
    await sql`insert into batches (id, tenant_id, sku_id, code) values (${batchId}, ${tenantId}, ${pcsSkuId}, 'B-1')`;
    await sql`insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${pcsSkuId}, ${binId}, 1500)`;
    await sql`insert into batch_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, batch_id, quantity)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${pcsSkuId}, ${binId}, ${batchId}, 1500)`;

    // The pairing that goes wrong when columns round independently: 1.5 ordered
    // rounds UP to 2, 1.4 reserved rounds DOWN to 1 — but round them the other
    // way and `reserved_qty > qty`, which is a CHECK violation and a negative ATP.
    await sql`insert into orders (id, tenant_id, warehouse_id, status, source)
      values (${orderId}, ${tenantId}, ${warehouseId}, 'accepted', 'manual')`;
    await sql`insert into order_lines (id, tenant_id, order_id, sku_id, qty, reserved_qty, status)
      values (${orderLineId}, ${tenantId}, ${orderId}, ${pcsSkuId}, 1500, 1400, 'open')`;

    // A legal 3-decimal event on the measured SKU. It is what the refusal
    // rehearsal above borrows, and what proves the guard does NOT fire on a
    // unit that may legitimately carry fractions.
    await sql`insert into ledger_events (
        id, tenant_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta,
        to_bin_id, actor_user_id, occurred_at, recorded_at, reference_doc, prev_hash, event_hash
      ) values (
        ${uuidv7()}, ${tenantId}, ${warehouseId}, 1, 'stock.adjusted', 1, ${kgSkuId}, 18400,
        ${binId}, ${actorId}, now(), now(), ${sql.json({ kind: 'manual-adjustment', reasonCode: 'seed', note: 'pre-vocabulary' })}, 'genesis', 'seed-hash'
      )`;
  }

  async function one<T>(query: postgres.PendingQuery<postgres.Row[]>): Promise<T> {
    return (await query)[0] as unknown as T;
  }

  it('normalizes every stored spelling to its canonical unit', async () => {
    const rows = (await sql`select code, uom from skus where tenant_id = ${tenantId} order by code`) as unknown as {
      code: string;
      uom: string;
    }[];
    expect(rows).toEqual([
      { code: 'PRE-BOXES', uom: 'box' },
      { code: 'PRE-KG', uom: 'kg' },
      { code: 'PRE-PCS', uom: 'each' },
    ]);
  });

  it('collapses two spellings of one conversion target onto ONE row, keeping the oldest', async () => {
    const rows = (await sql`
      select id, uom, factor from uom_conversions where sku_id = ${pcsSkuId}
    `) as unknown as { id: string; uom: string; factor: number }[];
    expect(rows).toEqual([{ id: keptConversionId, uom: 'box', factor: 12 }]);
  });

  it('drops a conversion whose target resolved to the SKU\'s own base unit', async () => {
    const rows = await sql`select count(*)::int as n from uom_conversions where id = ${identityConversionId}`;
    expect((rows[0] as unknown as { n: number }).n).toBe(0);
  });

  it('aligns a whole-unit balance in BOTH projections, together', async () => {
    const stock = await one<{ quantity: string }>(
      sql`select quantity from stock_on_hand where sku_id = ${pcsSkuId}`,
    );
    const batch = await one<{ quantity: string }>(
      sql`select quantity from batch_on_hand where sku_id = ${pcsSkuId}`,
    );
    // 1.5 rounds to 2 — and the plain projection follows its batch rows rather
    // than rounding on its own, so the two cannot drift apart and the
    // reconciliation oracle has nothing to quarantine.
    expect(Number(stock.quantity)).toBe(2000);
    expect(Number(batch.quantity)).toBe(2000);
  });

  it('never leaves a line reserving more than it ordered', async () => {
    const line = await one<{ qty: string; reserved_qty: string }>(
      sql`select qty, reserved_qty from order_lines where id = ${orderLineId}`,
    );
    expect(Number(line.qty)).toBe(2000);
    expect(Number(line.reserved_qty)).toBeLessThanOrEqual(Number(line.qty));
    expect(Number(line.reserved_qty)).toBe(1000);
  });

  it('floors a sub-unit bin capacity at ONE whole unit, never at zero', async () => {
    const tiny = await one<{ capacity: string }>(sql`select capacity from bins where id = ${tinyBinId}`);
    // 0.4 units rounds to 0 — and a bin with zero capacity accepts no putaway
    // ever, which is a worse answer than a bin one unit smaller than it was.
    expect(Number(tiny.capacity)).toBe(1000);
    const normal = await one<{ capacity: string }>(sql`select capacity from bins where id = ${binId}`);
    expect(Number(normal.capacity)).toBe(120000);
  });

  it('leaves a MEASURED unit\'s fractional values exactly as they were', async () => {
    const sku = await one<{ reorder_point: string; reorder_qty: string }>(
      sql`select reorder_point, reorder_qty from skus where id = ${kgSkuId}`,
    );
    expect(Number(sku.reorder_point)).toBe(2500);
    expect(Number(sku.reorder_qty)).toBe(10250);
    const event = await one<{ quantity_delta: string }>(
      sql`select quantity_delta from ledger_events where sku_id = ${kgSkuId}`,
    );
    expect(Number(event.quantity_delta)).toBe(18400);
  });

  it('rounds the whole-unit SKU\'s own thresholds', async () => {
    const sku = await one<{ reorder_point: string; reorder_qty: string }>(
      sql`select reorder_point, reorder_qty from skus where id = ${pcsSkuId}`,
    );
    expect(Number(sku.reorder_point)).toBe(2000);
    expect(Number(sku.reorder_qty)).toBe(2000);
  });

  it('leaves the CHECKs in place and the temp scaffolding gone', async () => {
    const checks = (await sql`
      select conname from pg_constraint
      where conname in ('skus_uom_check', 'uom_conversions_uom_check', 'bins_capacity_whole_units')
      order by conname
    `) as unknown as { conname: string }[];
    expect(checks.map((row) => row.conname)).toEqual([
      'bins_capacity_whole_units',
      'skus_uom_check',
      'uom_conversions_uom_check',
    ]);
    const temp = await sql`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname like 'pg_temp%' and c.relname in ('uom_canonical', 'uom_alias', 'batch_alignment')
    `;
    expect((temp[0] as unknown as { n: number }).n).toBe(0);
  });
});

/**
 * Story 10.2 — the UoM vocabulary and its declared precision, end to end.
 *
 * The story's whole shape comes from one constraint: **a precision refusal
 * must never break a replay.** Conversion moved off the controller edge and
 * into each command, behind the idempotency lookup, so an op that committed
 * once re-serves its stored snapshot forever — whatever the rules say now.
 * That is the case the `replay` block below exists for; everything else is
 * the I/O matrix around it.
 */
describe('story 10.2: UoM is a closed vocabulary with a declared precision (e2e)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: ReturnType<typeof postgres>;
  let valkey: Redis;
  let tenantId: string;
  let warehouseId: string;
  let zoneId: string;
  let binId: string;
  let ownerToken: string;
  let opsToken: string;
  let deviceToken: string;
  let operatorToken: string;
  const skuIds = new Map<string, string>();

  const EACH_SKU = 'UOM-EACH';
  const KG_SKU = 'UOM-KG';
  const ALIAS_SKU = 'UOM-ALIAS';

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('uomprec');
    Logger.overrideLogger(false);
    app = await createApp();
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4 });
    valkey = new Redis(process.env.VALKEY_URL!);

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Vocabulary Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email, password: 'correct-horse-battery' })
        .expect(200)
    ).body.accessToken as string;
    opsToken = await inviteAndSignIn('ops_manager', 'ops-password-123');

    warehouseId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: `UOM-${ulid().slice(10, 16).toUpperCase()}`, name: 'Vocabulary WH' })
        .expect(201)
    ).body.id as string;
    zoneId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binId = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A-01-01', capacity: 1_000_000, type: 'shelf' })
        .expect(201)
    ).body.id as string;

    // `UOM-ALIAS` is spelled the way a spreadsheet actually spells it — the
    // alias map is what keeps that from becoming a second unit.
    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
      `${EACH_SKU},Counted item,pcs,box:12,1800,,false,false,50,100,`,
      `${KG_SKU},Measured item,kg,,1800,,false,false,2.5,10.25,`,
      `${ALIAS_SKU},Spreadsheet item, Kg. ,,1800,,false,false,,,`,
    ].join('\n');
    await importCsv(csv).expect(201);
    await refreshSkuIds();

    // The two DEVICE write paths this story is built around: the operator
    // types a quantity on a scanner, and the precision refusal has to be a
    // server rule as well as an on-device one.
    const minted = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    deviceToken = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/devices/enroll`)
        .set(KEY_HEADER, ulid())
        .send({ code: minted.body.code, label: 'Vocabulary scanner', pin: '1357' })
        .expect(201)
    ).body.deviceToken as string;
    const operatorEmail = `operator-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: operatorEmail, role: 'operator' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    operatorToken = (
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${deviceToken}`)
        .send({ operatorEmail, pin: '1357' })
        .expect(200)
    ).body.accessToken as string;

    // Order acceptance reserves ATP through Valkey; without the rebuild the
    // counters are cold and every create fails closed with a 503.
    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
  }, 60_000);

  afterAll(async () => {
    await valkey.quit().catch(() => valkey.disconnect());
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  async function inviteAndSignIn(role: string, password: string): Promise<string> {
    const address = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: address, role })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password })
      .expect(200);
    return (
      await request(app.getHttpServer())
        .post(`${API}/sign-in`)
        .send({ email: address, password })
        .expect(200)
    ).body.accessToken as string;
  }

  function importCsv(csv: string, mode: 'initial' | 'fix' = 'initial') {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', mode)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' });
  }

  async function refreshSkuIds(): Promise<void> {
    const catalog = await request(app.getHttpServer())
      .get(`${API}/${tenantId}/catalog/skus?limit=200`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    for (const item of catalog.body.items as { code: string; id: string }[]) {
      skuIds.set(item.code, item.id);
    }
  }

  function adjust(skuId: string, quantityDelta: number, key = ulid()) {
    return request(app.getHttpServer())
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId, skuId, binId, quantityDelta, reasonCode: 'cycle-count', note: 'vocab' });
  }

  async function storedUom(code: string): Promise<string> {
    const rows = await sql`select uom from skus where tenant_id = ${tenantId} and code = ${code}`;
    return (rows[0] as unknown as { uom: string }).uom;
  }

  // ── the vocabulary itself ─────────────────────────────────────────────────

  describe('the vocabulary', () => {
    it('the TS tuple and the DB CHECK are ONE list — drift fails here', async () => {
      // The pin `orders.spec.ts` sets for `ORDER_STATUSES` against
      // `orders_status_check`. Adding a unit to the tuple without the
      // migration (or the reverse) is caught at build time, not at the first
      // import that uses it.
      for (const constraint of ['skus_uom_check', 'uom_conversions_uom_check']) {
        const rows = await sql`
          select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${constraint}
        `;
        expect(rows).toHaveLength(1);
        const def = (rows[0] as unknown as { def: string }).def;
        const declared = [...def.matchAll(/'([^']+)'/gu)].map((match) => match[1]!);
        expect([...declared].sort()).toEqual([...UOMS].sort());
      }
    });

    it('every canonical unit declares a precision the milli-unit representation can hold', () => {
      for (const uom of UOMS) {
        const precision = UOM_PRECISION[uom];
        expect(Number.isInteger(precision)).toBe(true);
        expect(precision).toBeGreaterThanOrEqual(0);
        expect(precision).toBeLessThanOrEqual(QUANTITY_DECIMALS);
      }
      // The two families the story names explicitly.
      expect(UOM_PRECISION.each).toBe(0);
      expect(UOM_PRECISION.kg).toBe(3);
    });

    it('the alias map in TypeScript and the one in migration 0027 agree, BOTH ways', () => {
      // The migration normalizes the rows that predate the vocabulary; if its
      // map and `resolveUom`'s disagree, a spelling the importer accepts is a
      // spelling the migration leaves behind for the CHECK to reject — or
      // worse, one the migration rewrites that the importer would refuse.
      // A `includes()` probe per TS entry only catches the first direction, so
      // the pairs are PARSED out of the SQL and compared as sets.
      const pairs = new Map(parseValues(migrationBlock('uom_alias')));
      expect(Object.fromEntries([...pairs].sort())).toEqual(
        Object.fromEntries(Object.entries(UOM_ALIASES).sort()),
      );
    });

    it('the migration declares the canonical set and its precisions once, and they match TypeScript', () => {
      // `uom_canonical` is the migration's SINGLE declaration: the pre-flight
      // refusal, the alias rewrite, the dedup and all thirteen whole-unit
      // alignment statements read the set from it (`places = 0`). Adding a
      // 0-dp unit to the tuple without adding it here is caught HERE rather
      // than by a quantity that quietly failed to align.
      const declared = Object.fromEntries(
        parseValues(migrationBlock('uom_canonical')).map(([uom, places]) => [uom, Number(places)]),
      );
      expect(declared).toEqual({ ...UOM_PRECISION });
      const wholeUnit = Object.entries(declared)
        .filter(([, places]) => places === 0)
        .map(([uom]) => uom);
      expect(wholeUnit.sort()).toEqual([...WHOLE_UNIT_UOMS].sort());
    });

    it('the DB refuses a unit outside the vocabulary (23514 — the backstop)', async () => {
      await expect(
        sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode)
            values (gen_random_uuid(), ${tenantId}, ${`CHK-${ulid().slice(0, 8)}`}, 'probe', 'furlong', 500, ${ulid()})`,
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  // ── the I/O matrix ────────────────────────────────────────────────────────

  describe('the precision matrix', () => {
    it('a quantity within its unit is accepted — 18.4 on a 3-dp kg', async () => {
      const created = await adjust(skuIds.get(KG_SKU)!, 18.4).expect(201);
      expect(created.body.event.quantityDelta).toBe(18.4);
    });

    it('a quantity FINER than its unit is refused, naming the unit, the precision and the value', async () => {
      const refused = await adjust(skuIds.get(KG_SKU)!, 18.4567).expect(400);
      expect(refused.body.code).toBe('validation-failed');
      expect(refused.body.detail).toContain('"kg"');
      expect(refused.body.detail).toContain('3');
      expect(refused.body.detail).toContain('18.4567');
    });

    it('a fraction on a whole-unit SKU is refused — `each` declares 0 places', async () => {
      const refused = await adjust(skuIds.get(EACH_SKU)!, 2.5).expect(400);
      expect(refused.body.code).toBe('validation-failed');
      expect(refused.body.detail).toContain('"each"');
      expect(refused.body.detail).toContain('0 decimal places');
      expect(refused.body.detail).toContain('2.5');
    });

    it('nothing is written when a quantity is refused', async () => {
      const before = await sql`
        select coalesce(sum(quantity), 0)::bigint as q from stock_on_hand
        where tenant_id = ${tenantId} and sku_id = ${skuIds.get(EACH_SKU)!}
      `;
      await adjust(skuIds.get(EACH_SKU)!, 0.25).expect(400);
      const after = await sql`
        select coalesce(sum(quantity), 0)::bigint as q from stock_on_hand
        where tenant_id = ${tenantId} and sku_id = ${skuIds.get(EACH_SKU)!}
      `;
      expect(after[0]).toEqual(before[0]);
    });

    it('bin capacity is whole units — it is the one quantity with no unit at all', async () => {
      // A bin holds many SKUs measured many ways; `suggestBin` calls its
      // capacity "shared base-UoM space". 2.5 of WHAT? The DTO refuses it at
      // the wire…
      const refused = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A-01-99', capacity: 2.5, type: 'shelf' })
        .expect(400);
      expect(refused.body.code).toBe('validation-failed');
      expect(refused.body.detail).toContain('capacity');

      // …and the CHECK refuses it beneath every caller, HTTP or not.
      await expect(
        sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type)
            values (gen_random_uuid(), ${tenantId}, ${warehouseId}, ${zoneId}, ${`CAP-${ulid().slice(0, 8)}`}, 2500, 'shelf')`,
      ).rejects.toMatchObject({ code: '23514' });

      // A whole capacity still lands, so the guard is a rule and not a wall.
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A-01-98', capacity: 3, type: 'shelf' })
        .expect(201);
    });
  });

  // ── the write paths, not just the one that is easiest to reach ───────────

  describe('every write path refuses, not only the adjustment route', () => {
    /**
     * The adjustment route is the cheapest path to test and the least
     * representative: the design is built around the DEVICE routes, where the
     * operator types the value and a queued op has to survive a replay. Each
     * of these would stay green if its command's `assertRecordableQuantity`
     * were quietly swapped back for a bare `toMilli`, which is exactly the
     * regression this block exists to catch.
     */

    it('a goods receipt refuses a fractional line on a whole-unit SKU, and writes nothing', async () => {
      const skuId = skuIds.get(EACH_SKU)!;
      const body = {
        warehouseId,
        poId: null,
        blindReasonCode: 'po-not-found',
        occurredAt: new Date().toISOString(),
        lines: [{ poLineId: null, skuId, batchCode: null, mfgDate: null, qty: 2.5 }],
      };
      const refused = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send(body)
        .expect(400);
      expect(refused.body.code).toBe('validation-failed');
      expect(refused.body.detail).toContain('"each"');
      expect(refused.body.detail).toContain('2.5');
      const grns = await sql`
        select count(*)::int as n from goods_receipt_lines where tenant_id = ${tenantId} and sku_id = ${skuId}
      `;
      expect((grns[0] as unknown as { n: number }).n).toBe(0);

      // …and the same receipt in whole units lands, so the refusal is the
      // precision rule and not a broken route.
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/receiving/goods-receipts`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({ ...body, lines: [{ ...body.lines[0]!, qty: 3 }] })
        .expect(201);
    });

    it('a pick refuses a fractional draw on a whole-unit SKU, and draws nothing', async () => {
      const skuId = skuIds.get(EACH_SKU)!;
      await adjust(skuId, 10).expect(201);
      const orderId = (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/outbound/orders`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId, lines: [{ skuId, quantity: 4 }] })
          .expect(201)
      ).body.order.id as string;
      const policyId = (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/outbound/wave-policies`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId, name: `uom-${ulid().slice(10, 18)}`, grouping: 'single' })
          .expect(201)
      ).body.policy.id as string;
      const waveId = (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/outbound/waves`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId, policyId, orderIds: [orderId] })
          .expect(201)
      ).body.wave.id as string;
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({})
        .expect(200);
      const wave = (
        await request(app.getHttpServer())
          .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
          .set('Authorization', `Bearer ${opsToken}`)
          .expect(200)
      ).body.wave as { picklists: { id: string; lines: { id: string; binId: string | null }[] }[] };
      const picklist = wave.picklists[0]!;
      const line = picklist.lines.find((candidate) => candidate.binId !== null)!;

      const refused = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/picks`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          picklistId: picklist.id,
          picklistLineId: line.id,
          skuId,
          binId: line.binId,
          qty: 2.5,
          occurredAt: new Date().toISOString(),
          reasonCode: 'fewer-units-than-planned',
        })
        .expect(400);
      expect(refused.body.code).toBe('validation-failed');
      expect(refused.body.detail).toContain('"each"');
      expect(refused.body.detail).toContain('2.5');
      // Nothing drew: no pick row, and the line is still planned.
      const picks = await sql`
        select count(*)::int as n from picks where tenant_id = ${tenantId} and picklist_line_id = ${line.id}
      `;
      expect((picks[0] as unknown as { n: number }).n).toBe(0);
      const rows = await sql`select status from picklist_lines where id = ${line.id}`;
      expect((rows[0] as unknown as { status: string }).status).toBe('planned');
    });
  });

  // ── the constraint that shapes the story ──────────────────────────────────

  describe('replay beats a tightened rule', () => {
    it('an op that already committed re-serves its snapshot after its unit narrows — never a 400', async () => {
      const skuId = skuIds.get(KG_SKU)!;
      const key = ulid();
      const committed = await adjust(skuId, 4.25, key).expect(201);
      expect(committed.body.event.quantityDelta).toBe(4.25);

      // The rules tighten under the queued op: the SKU's unit is narrowed to
      // a whole-unit one, so 4.25 is no longer a quantity it can express.
      // (A vocabulary change is the real-world version of this; rewriting the
      // row is the same event with less ceremony.)
      await sql`update skus set uom = 'each' where id = ${skuId}`;
      try {
        // A FRESH key is refused — the new rule is live.
        const refused = await adjust(skuId, 4.25).expect(400);
        expect(refused.body.detail).toContain('"each"');

        // The SAME key replays to the ORIGINAL 201 and the original snapshot.
        // This is the whole reason conversion sits behind the replay lookup
        // rather than at the controller edge.
        const replayed = await adjust(skuId, 4.25, key).expect(201);
        expect(replayed.body).toEqual(committed.body);
      } finally {
        await sql`update skus set uom = 'kg' where id = ${skuId}`;
      }
    });
  });

  // ── catalog import ────────────────────────────────────────────────────────

  describe('catalog import', () => {
    it('normalizes a generous spelling to the canonical unit', async () => {
      // `pcs` and `" Kg. "` went in; `each` and `kg` are what the catalog holds.
      expect(await storedUom(EACH_SKU)).toBe('each');
      expect(await storedUom(ALIAS_SKU)).toBe('kg');
      // …and the same resolution answers in process, which is what the
      // migration's alias map mirrors.
      expect(resolveUom(' KG ')).toBe('kg');
      expect(resolveUom('Kg.')).toBe('kg');
      expect(resolveUom('PCS')).toBe('each');
      expect(resolveUom('pieces')).toBe('each');
    });

    it('a conversion target resolves through the same vocabulary', async () => {
      const list = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/catalog/skus?limit=200`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const sku = (list.body.items as { code: string; uomConversions: { uom: string; factor: number }[] }[])
        .find((item) => item.code === EACH_SKU)!;
      expect(sku.uomConversions).toEqual([{ uom: 'box', factor: 12 }]);
    });

    it('an unknown unit fails ONE row; the rest of the file commits and `fix` mode re-submits it', async () => {
      const csv = [
        'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
        'UOM-GOOD-1,Fine,each,,1800,,false,false,,,',
        'UOM-BAD-1,Measured in nothing,furlong,,1800,,false,false,,,',
      ].join('\n');
      const run = await importCsv(csv).expect(201);
      expect(run.body.committedRows).toBe(1);
      expect(run.body.failedRows).toBe(1);
      const error = run.body.errors[0];
      expect(error.code).toBe('validation-failed');
      expect(error.skuCode).toBe('UOM-BAD-1');
      expect(error.detail).toContain('"furlong"');
      expect(error.detail).toContain('closed vocabulary');

      // The row is re-submittable: `fix` mode commits it once the unit is one
      // the vocabulary knows.
      const fixed = await importCsv(
        [
          'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
          'UOM-BAD-1,Measured in metres,metres,,1800,,false,false,,,',
        ].join('\n'),
        'fix',
      ).expect(201);
      expect(fixed.body.committedRows).toBe(1);
      expect(fixed.body.failedRows).toBe(0);
      expect(await storedUom('UOM-BAD-1')).toBe('m');
    });

    it('a reorder threshold finer than its unit is a row error, not a rounding', async () => {
      const csv = [
        'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
        'UOM-REORDER,Counted item,each,,1800,,false,false,2.5,10,',
      ].join('\n');
      const run = await importCsv(csv).expect(201);
      expect(run.body.committedRows).toBe(0);
      const error = run.body.errors[0];
      expect(error.code).toBe('validation-failed');
      expect(error.detail).toContain('reorder_point');
      expect(error.detail).toContain('"each"');
    });

    it('the serial rule is a PRECISION LOOKUP now — any measured unit refuses it, not a hand-listed one', async () => {
      // `tonne` was never in story 10.1's discrete allowlist and never needed
      // to be: the rule reads the unit's declared precision instead of a list
      // of spellings somebody had to remember.
      const csv = [
        'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
        'UOM-SERIAL-BAD,Serialised grain,tonne,,1800,,false,true,,,',
      ].join('\n');
      const run = await importCsv(csv).expect(201);
      expect(run.body.committedRows).toBe(0);
      const error = run.body.errors[0];
      expect(error.detail).toContain('"tonne"');
      expect(error.detail).toContain('three decimal places');
      expect(error.detail).toContain('one whole unit per serial');
    });

    it('turning serial tracking ON is refused the same way, by the same lookup', async () => {
      const refused = await request(app.getHttpServer())
        .patch(`${API}/${tenantId}/catalog/skus/${skuIds.get(KG_SKU)!}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ serialTracked: true })
        .expect(400);
      expect(refused.body.detail).toContain('"kg"');
    });

    it('a PATCHed reorder threshold obeys the SKU\'s unit', async () => {
      await request(app.getHttpServer())
        .patch(`${API}/${tenantId}/catalog/skus/${skuIds.get(EACH_SKU)!}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ reorderPoint: 2.5 })
        .expect(400);
      const accepted = await request(app.getHttpServer())
        .patch(`${API}/${tenantId}/catalog/skus/${skuIds.get(KG_SKU)!}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ reorderPoint: 2.125 })
        .expect(200);
      expect(accepted.body.reorderPoint).toBe(2.125);
    });

    it('the precision refusal is stated ONCE — the HTTP PATCH and CSV import answers are byte-identical (story 10.4)', async () => {
      // The two call shapes (the command write-edge gate and the CSV import's
      // `parseQuantityMilli`) now delegate to ONE core
      // (`validateRecordableQuantity`), so the same too-fine value must draw
      // the same sentence from both — differing only in the field's LABEL,
      // which is each edge's own vocabulary (`reorderPoint` on the HTTP
      // contract, `reorder_point` in the CSV header).
      const patched = await request(app.getHttpServer())
        .patch(`${API}/${tenantId}/catalog/skus/${skuIds.get(EACH_SKU)!}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ reorderPoint: 2.5 })
        .expect(400);
      const run = await importCsv(
        [
          'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
          'UOM-ONCE,Counted item,each,,1800,,false,false,2.5,10,',
          // `parseQuantityMilli`'s second consumer, in its own row: one row
          // surfaces only its FIRST invalid cell (reorder_point is checked
          // before reorder_qty), so the qty leg needs its own SKU.
          'UOM-ONCE-QTY,Counted item too,each,,1800,,false,false,10,2.5,',
        ].join('\n'),
      ).expect(201);
      expect(run.body.committedRows).toBe(0);
      const rowErrors = run.body.errors as { skuCode: string; detail: string }[];
      expect(rowErrors).toHaveLength(2);
      const imported = rowErrors.find((error) => error.skuCode === 'UOM-ONCE')!.detail;
      const importedQty = rowErrors.find((error) => error.skuCode === 'UOM-ONCE-QTY')!.detail;
      const patchedQty = await request(app.getHttpServer())
        .patch(`${API}/${tenantId}/catalog/skus/${skuIds.get(EACH_SKU)!}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ reorderQty: 2.5 })
        .expect(400);

      // Byte-identity modulo the label (pinned through normalization so a
      // future label rename cannot silently loosen the comparison). Both
      // quantity cells are pinned: `reorder_point` AND `reorder_qty` are the
      // two consumers of the shared core on the import edge.
      const normalizedPatch = (patched.body.detail as string).replace(/reorderPoint/g, 'F');
      const normalizedImport = imported.replace(/reorder_point/g, 'F');
      expect(normalizedPatch).toBe(normalizedImport);
      const normalizedPatchQty = (patchedQty.body.detail as string).replace(/reorderQty/g, 'F');
      const normalizedImportQty = importedQty.replace(/reorder_qty/g, 'F');
      expect(normalizedPatchQty).toBe(normalizedImportQty);

      // …and pinned literally against the shared core's own text, so neither
      // edge can soften or reword the sentence alone.
      expect(patched.body.detail).toBe(
        'reorderPoint must be a whole number: base UoM "each" declares 0 decimal places, ' +
          'so 2.5 is not a quantity it can express. Record whole units, or measure this ' +
          'SKU in a unit that allows fractions.',
      );
      expect(imported).toBe(
        'reorder_point must be a whole number: base UoM "each" declares 0 decimal places, ' +
          'so 2.5 is not a quantity it can express. Record whole units, or measure this ' +
          'SKU in a unit that allows fractions.',
      );
      expect(patchedQty.body.detail).toBe(
        'reorderQty must be a whole number: base UoM "each" declares 0 decimal places, ' +
          'so 2.5 is not a quantity it can express. Record whole units, or measure this ' +
          'SKU in a unit that allows fractions.',
      );
      expect(importedQty).toBe(
        'reorder_qty must be a whole number: base UoM "each" declares 0 decimal places, ' +
          'so 2.5 is not a quantity it can express. Record whole units, or measure this ' +
          'SKU in a unit that allows fractions.',
      );
    });
  });

  // ── the device's offline gate ─────────────────────────────────────────────

  describe('the catalog snapshot', () => {
    it('carries each SKU\'s declared precision, so the device can refuse a scan offline', async () => {
      // Read through the facade rather than the device route: the value under
      // test is the SNAPSHOT FIELD and the transaction it is composed on (a
      // nested pool-opening read here deadlocked this endpoint once), and the
      // HTTP shape is pinned by the OpenAPI document instead.
      const snapshot = await app.get(ReceivingFacade).getCatalogSnapshot(tenantId, warehouseId);
      const each = snapshot.skus.find((sku) => sku.code === EACH_SKU)!;
      const kg = snapshot.skus.find((sku) => sku.code === KG_SKU)!;
      expect(each).toMatchObject({ uom: 'each', uomPrecision: 0 });
      expect(kg).toMatchObject({ uom: 'kg', uomPrecision: 3 });
      for (const sku of snapshot.skus) {
        expect(sku.uomPrecision).toBe(UOM_PRECISION[sku.uom as keyof typeof UOM_PRECISION]);
      }
    });

    it('the published contract declares the field and the closed unit enum', () => {
      const document = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8')) as {
        components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> };
      };
      const dto = document.components.schemas['CatalogSnapshotSkuDto']!;
      expect(dto.properties['uomPrecision']).toBeDefined();
      expect(dto.properties['uom']!.enum).toEqual([...UOMS]);
    });
  });
});
