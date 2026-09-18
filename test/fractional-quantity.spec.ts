import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { createDatabase } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import {
  GENESIS_PREV_HASH,
  eventHashOf,
  replayInTx,
  verifyChainInTx,
} from '../src/modules/inventory/ledger.service';
import type {
  ChainBreakReport,
  ChainVerifyReport,
} from '../src/modules/inventory/ledger.service';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { QUANTITY_SCALE, fromMilli, toMilli } from '../src/shared/primitives/quantity';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/**
 * Every quantity column story 10.1 scales, as `table.column`. The migration
 * test walks THIS list, so a column added to the schema without being added
 * here is a column the migration will silently leave in base units.
 */
const QUANTITY_COLUMNS: readonly (readonly [string, string])[] = [
  ['ledger_events', 'quantity_delta'],
  ['stock_on_hand', 'quantity'],
  ['batch_on_hand', 'quantity'],
  ['reservations', 'quantity'],
  ['purchase_order_lines', 'ordered_qty'],
  ['purchase_order_lines', 'received_qty'],
  ['goods_receipt_lines', 'qty'],
  ['goods_receipt_lines', 'applied_qty'],
  ['over_receipts', 'excess_qty'],
  ['putaway_placements', 'qty'],
  ['order_lines', 'qty'],
  ['order_lines', 'reserved_qty'],
  ['picklist_lines', 'qty'],
  ['picklist_lines', 'shortfall_qty'],
  ['picks', 'qty'],
  ['bins', 'capacity'],
  ['skus', 'reorder_point'],
  ['skus', 'reorder_qty'],
];

/**
 * Two seeded values chosen to be larger than int4 can hold ONCE SCALED
 * (`5_000_000 * 1000` is 5 × 10⁹, well past 2,147,483,647). They are the only
 * reason the migration's `("col"::bigint * 1000)` is observable: written as
 * `("col" * 1000)` the multiplication happens in int4 and raises 22003, and
 * with every seeded value under a thousand it would not. Both live in columns
 * replay does not fold, so they cost the balance assertions nothing.
 */
const BIG_ORDERED_QTY = 5_000_000;
const BIG_CAPACITY = 3_000_000;

/** The migration file this story ships, split into executable statements. */
function migrationStatements(): string[] {
  const sql = readFileSync(
    resolve(process.cwd(), 'drizzle/0026_fractional_quantity_milli_units.sql'),
    'utf8',
  );
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

describe('story 10.1: fractional quantities are scaled integers in milli-units', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Part A — the migration itself, against a database that still carries the
  // PRE-migration schema and real data in every quantity column. This is the
  // only test in the repo that can see migration 0026 do its work: every other
  // suite starts from a template that is already migrated.
  // ──────────────────────────────────────────────────────────────────────────
  describe('migration 0026, applied to pre-migration data', () => {
    const PRE_DB = 'wms_s_qty_premigration';
    let baseUrl: string;
    let preUrl: string;
    let sql: ReturnType<typeof postgres>;
    let folder: string;

    const tenantId = uuidv7();
    const warehouseId = uuidv7();
    const skuId = uuidv7();
    const binId = uuidv7();
    const batchId = uuidv7();
    const actorId = uuidv7();

    beforeAll(async () => {
      baseUrl = process.env.DATABASE_URL!;
      const url = new URL(baseUrl);
      url.pathname = `/${PRE_DB}`;
      preUrl = url.toString();
      const adminUrl = new URL(baseUrl);
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

      // A migrations folder that STOPS at 0025 — the schema as it stood the
      // moment before this story. Copying the real folder and trimming the
      // journal keeps the fixture honest: it is the repo's own migrations, in
      // the repo's own order, not a hand-written replica that can drift.
      folder = mkdtempSync(join(tmpdir(), 'wms-pre-0026-'));
      cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
      rmSync(join(folder, '0026_fractional_quantity_milli_units.sql'));
      const journalPath = join(folder, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { idx: number }[];
      };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 25);
      writeFileSync(journalPath, JSON.stringify(journal));

      const db = createDatabase(preUrl);
      await migrate(db, { migrationsFolder: folder });
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

      sql = postgres(preUrl, { max: 2 });

      // Seeding and applying belong HERE, not inside test #1: a migration
      // applied as a side effect of one test makes every later test depend on
      // that test having run, so a focused `-t` run asserts against an
      // unmigrated database and passes for the wrong reason.
      //
      // The apply runs inside ONE transaction because that is how the real
      // runner applies a migration file — drizzle wraps each one. Applying the
      // statements in a bare loop would exercise a weaker atomicity model than
      // production and hide a failure that leaves the schema half-migrated.
      beforeState = await captureSchema();
      await seedPreMigrationRows();
      seededEventHashes = (
        (await sql`select seq, event_hash from ledger_events order by seq`) as unknown as {
          seq: number;
          event_hash: string;
        }[]
      ).map((row) => row.event_hash);
      // The chain is genuinely valid BEFORE the migration — the fixture hashes
      // are minted with the production composer, not fabricated — so the break
      // the test below pins is caused by the migration and by nothing else.
      chainBefore = await verifyPreMigrationChain();

      await sql.begin(async (tx) => {
        for (const statement of migrationStatements()) {
          await tx.unsafe(statement);
        }
      });

      afterState = await captureSchema();
      chainAfter = await verifyPreMigrationChain();
    }, 60_000);

    interface SchemaState {
      /** Every column's type, unfiltered: a move to ANY type is visible. */
      readonly types: Map<string, string>;
      /** Every CHECK constraint's rendered predicate, by `table.name`. */
      readonly checks: Map<string, string>;
    }
    let beforeState: SchemaState;
    let afterState: SchemaState;
    let seededEventHashes: string[];
    let chainBefore: ChainVerifyReport | ChainBreakReport;
    let chainAfter: ChainVerifyReport | ChainBreakReport;

    async function captureSchema(): Promise<SchemaState> {
      // No `data_type in (...)` filter: filtering to the two types the
      // migration is expected to touch would make a column that moved to
      // anything else invisible to both guards below.
      const columns = (await sql`
        select table_name, column_name, data_type from information_schema.columns
        where table_schema = 'public'
      `) as unknown as { table_name: string; column_name: string; data_type: string }[];
      const checks = (await sql`
        select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
        from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace
      `) as unknown as { tbl: string; conname: string; def: string }[];
      return {
        types: new Map(columns.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type])),
        checks: new Map(checks.map((row) => [`${row.tbl}.${row.conname}`, row.def])),
      };
    }

    async function verifyPreMigrationChain(): Promise<ChainVerifyReport | ChainBreakReport> {
      const db = createDatabase(preUrl);
      try {
        return await withTenantTransaction(db, tenantId, (tx) =>
          verifyChainInTx(tx, tenantId, warehouseId, 1),
        );
      } finally {
        await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
      }
    }

    afterAll(async () => {
      await sql?.end();
      rmSync(folder, { recursive: true, force: true });
      const adminUrl = new URL(baseUrl);
      adminUrl.pathname = '/postgres';
      const admin = postgres(adminUrl.toString(), { max: 1 });
      try {
        await admin.unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`,
        );
        await admin.unsafe(`drop database if exists "${PRE_DB}"`);
      } finally {
        await admin.end();
      }
    });

    it('widens exactly the in-scope columns from integer to bigint, and nothing else moves at all', () => {
      for (const [table, column] of QUANTITY_COLUMNS) {
        const key = `${table}.${column}`;
        expect(`${key}: ${beforeState.types.get(key)} -> ${afterState.types.get(key)}`).toBe(
          `${key}: integer -> bigint`,
        );
      }
      // Money, GST, sequences, epochs, attempt counters and
      // `uom_conversions.factor` are not quantities, and a migration that swept
      // them up (or quietly moved any column to `numeric`, or dropped one)
      // would be a different change. The comparison is over EVERY column, so
      // it sees a move to any type, not only to bigint.
      const inScope = new Set(QUANTITY_COLUMNS.map(([t, c]) => `${t}.${c}`));
      const unexpected = [...afterState.types.entries()]
        .filter(([key, type]) => !inScope.has(key) && beforeState.types.get(key) !== type)
        .map(([key, type]) => `${key}: ${beforeState.types.get(key)} -> ${type}`);
      expect(unexpected).toEqual([]);
      expect(afterState.types.size).toBe(beforeState.types.size);
    });

    it('multiplies every seeded quantity by exactly 1000, and leaves money, rates and sequences alone', async () => {
      const [soh] = (await sql`select quantity from stock_on_hand`) as unknown as { quantity: string }[];
      expect(Number(soh!.quantity)).toBe(10 * QUANTITY_SCALE);
      const [boh] = (await sql`select quantity from batch_on_hand`) as unknown as { quantity: string }[];
      expect(Number(boh!.quantity)).toBe(5 * QUANTITY_SCALE);
      const events = (await sql`
        select seq, quantity_delta from ledger_events order by seq
      `) as unknown as { seq: number; quantity_delta: string }[];
      expect(events.map((event) => Number(event.quantity_delta))).toEqual([
        7 * QUANTITY_SCALE,
        5 * QUANTITY_SCALE,
        -2 * QUANTITY_SCALE,
      ]);

      const [line] = (await sql`
        select ordered_qty, received_qty, unit_cost_paise from purchase_order_lines
      `) as unknown as { ordered_qty: string; received_qty: string; unit_cost_paise: number }[];
      // BIG_ORDERED_QTY is the point of this row. `ordered_qty * 1000` in int4
      // arithmetic overflows here, so the migration's `col::bigint * 1000` is
      // the only reason this value survives: rewrite the cast as `(col * 1000)`
      // and this assertion fails with a 22003 instead of passing quietly.
      expect(Number(line!.ordered_qty)).toBe(BIG_ORDERED_QTY * QUANTITY_SCALE);
      expect(Number(line!.received_qty)).toBe(40 * QUANTITY_SCALE);
      // Money is integer paise and is NOT a quantity — it must not have moved.
      expect(line!.unit_cost_paise).toBe(12_345);

      const [grnLine] = (await sql`select qty, applied_qty from goods_receipt_lines`) as unknown as {
        qty: string;
        applied_qty: string;
      }[];
      expect(Number(grnLine!.qty)).toBe(40 * QUANTITY_SCALE);
      expect(Number(grnLine!.applied_qty)).toBe(35 * QUANTITY_SCALE);

      const [over] = (await sql`select excess_qty from over_receipts`) as unknown as { excess_qty: string }[];
      expect(Number(over!.excess_qty)).toBe(5 * QUANTITY_SCALE);

      const [placement] = (await sql`select qty from putaway_placements`) as unknown as { qty: string }[];
      expect(Number(placement!.qty)).toBe(35 * QUANTITY_SCALE);

      const [orderLine] = (await sql`select qty, reserved_qty from order_lines`) as unknown as {
        qty: string;
        reserved_qty: string;
      }[];
      expect(Number(orderLine!.qty)).toBe(9 * QUANTITY_SCALE);
      expect(Number(orderLine!.reserved_qty)).toBe(4 * QUANTITY_SCALE);

      const [pickLine] = (await sql`
        select qty, shortfall_qty, slice_seq, walk_seq from picklist_lines
      `) as unknown as { qty: string; shortfall_qty: string; slice_seq: number; walk_seq: number }[];
      expect(Number(pickLine!.qty)).toBe(4 * QUANTITY_SCALE);
      expect(Number(pickLine!.shortfall_qty)).toBe(0);
      // Sequence numbers are counters, not quantities.
      expect(pickLine!.slice_seq).toBe(0);
      expect(pickLine!.walk_seq).toBe(1);

      const [pick] = (await sql`select qty from picks`) as unknown as { qty: string }[];
      expect(Number(pick!.qty)).toBe(3 * QUANTITY_SCALE);

      const [reservation] = (await sql`select quantity from reservations`) as unknown as { quantity: string }[];
      expect(Number(reservation!.quantity)).toBe(4 * QUANTITY_SCALE);

      // The three UoM-denominated siblings scale WITH the quantities they are
      // compared against — a capacity left in base units would make every bin
      // read as 1000× full. `BIG_CAPACITY` is the second int4-overflow probe.
      const [bin] = (await sql`select capacity from bins`) as unknown as { capacity: string }[];
      expect(Number(bin!.capacity)).toBe(BIG_CAPACITY * QUANTITY_SCALE);
      const [sku] = (await sql`
        select reorder_point, reorder_qty, gst_rate_bps from skus
      `) as unknown as { reorder_point: string; reorder_qty: string; gst_rate_bps: number }[];
      expect(Number(sku!.reorder_point)).toBe(25 * QUANTITY_SCALE);
      expect(Number(sku!.reorder_qty)).toBe(60 * QUANTITY_SCALE);
      expect(sku!.gst_rate_bps).toBe(1800); // basis points, not a quantity
    });

    it('re-creates every CHECK with the same predicate it had, and they still bite', async () => {
      // Names are not predicates. A constraint dropped and re-added with a
      // subtly different body — `>=` for `>`, a missing arm of the compound
      // shape — would satisfy a name check and quietly stop refusing what it
      // was written to refuse. Postgres renders the predicate back through
      // `pg_get_constraintdef`, so the whole map is compared, both directions.
      expect([...afterState.checks.keys()].sort()).toEqual([...beforeState.checks.keys()].sort());
      const changed = [...afterState.checks.entries()]
        .filter(([key, def]) => beforeState.checks.get(key) !== def)
        .map(([key, def]) => `${key}: ${beforeState.checks.get(key)} -> ${def}`);
      expect(changed).toEqual([]);

      // …and the behaviour behind the text, including all three COMPOUND
      // predicates, which a rendered-definition compare cannot fully speak for.
      await expect(sql`update stock_on_hand set quantity = -1`).rejects.toMatchObject({
        code: '23514',
      });
      await expect(sql`update order_lines set reserved_qty = qty + 1`).rejects.toMatchObject({
        code: '23514',
      });
      // goods_receipt_lines_applied_le_physical: applied never exceeds physical.
      await expect(sql`update goods_receipt_lines set applied_qty = qty + 1`).rejects.toMatchObject({
        code: '23514',
      });
      // picklist_lines_slice_shape: a `planned` slice carries units and no
      // shortfall — a shortfall on it is a claim about a bin nobody opened.
      await expect(
        sql`update picklist_lines set shortfall_qty = 1 where status = 'planned'`,
      ).rejects.toMatchObject({ code: '23514' });
      // picklist_lines_short_pairing: a short line names BOTH how many units
      // never moved and why.
      await expect(
        sql`update picklist_lines set status = 'short'`,
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('carries every event hash across byte-for-byte — and so the chain now reads as broken, by design', async () => {
      const after = (
        (await sql`select seq, event_hash from ledger_events order by seq`) as unknown as {
          seq: number;
          event_hash: string;
        }[]
      ).map((row) => row.event_hash);
      // Byte-for-byte, not merely "still 64 characters": the migration does not
      // touch `event_hash`, and an assertion about its LENGTH would restate the
      // fixture rather than check anything.
      expect(after).toEqual(seededEventHashes);

      // Which is exactly why the chain breaks. `event_hash` covers
      // `quantity_delta`, and the migration rewrote that column — so a
      // recomputation no longer matches the stored hash. The migration file
      // documents this at length; pinning it here means the next person who
      // runs `verifyChain` after a migration finds a test that says "expected",
      // instead of investigating a severity-1 alert as a tamper.
      expect(chainBefore.ok).toBe(true);
      expect(chainAfter.ok).toBe(false);
      expect((chainAfter as ChainBreakReport).reason).toContain('hash mismatch at seq 1');
    });

    it('replay reproduces every balance exactly after the migration — zero divergences', async () => {
      // THE acceptance gate. The ledger and the projections were written in
      // base units and multiplied by 1000 together; replay folds the migrated
      // events and compares them to the migrated projections with `!==`. A
      // single divergence here means the migration changed meaning, not just
      // representation.
      const db = createDatabase(preUrl);
      try {
        const report = await withTenantTransaction(db, tenantId, (tx) =>
          replayInTx(tx, tenantId, warehouseId),
        );
        expect(report.divergences).toEqual([]);
        expect(report.matches).toBe(true);
        expect(report.eventCount).toBe(3);
      } finally {
        await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
      }
    });

    /**
     * Representative rows in EVERY quantity column, written in base units —
     * a pre-migration database as the app would have left it. No foreign keys
     * exist in this schema (the repo convention: uuid columns, app-enforced
     * integrity), so each row stands on its own.
     *
     * The ledger and the projections AGREE before the migration: +7 and +5 in,
     * −2 out, leaving 10 on hand, of which the batch arm carries 5. That
     * agreement is what the replay assertion above re-checks afterwards.
     */
    async function seedPreMigrationRows(): Promise<void> {
      const grnId = uuidv7();
      const grnLineId = uuidv7();
      const poId = uuidv7();
      const orderId = uuidv7();
      const orderLineId = uuidv7();
      const waveId = uuidv7();
      const picklistId = uuidv7();
      const at = new Date().toISOString();

      await sql`insert into tenants (id, tenant_id, name) values (${tenantId}, ${tenantId}, 'Pre-migration Co')`;
      await sql`
        insert into warehouses (id, tenant_id, code, name)
        values (${warehouseId}, ${tenantId}, 'PRE', 'Pre-migration WH')
      `;
      const zoneId = uuidv7();
      await sql`
        insert into zones (id, tenant_id, warehouse_id, code, name)
        values (${zoneId}, ${tenantId}, ${warehouseId}, 'A', 'Aisle A')
      `;
      await sql`
        insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type)
        values (${binId}, ${tenantId}, ${warehouseId}, ${zoneId}, 'A-01-01', ${BIG_CAPACITY}, 'shelf')
      `;
      await sql`
        insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, reorder_point, reorder_qty, barcode)
        values (${skuId}, ${tenantId}, 'PRE-SKU', 'Pre SKU', 'kg', 1800, 25, 60, 'PRE-BAR')
      `;
      await sql`
        insert into batches (id, tenant_id, sku_id, code) values (${batchId}, ${tenantId}, ${skuId}, 'B-1')
      `;

      let prevHash = GENESIS_PREV_HASH;
      const deltas = [
        { seq: 1, delta: 7, batchRef: batchId },
        { seq: 2, delta: 5, batchRef: null },
        { seq: 3, delta: -2, batchRef: batchId },
      ];
      for (const event of deltas) {
        const eventId = uuidv7();
        const referenceDoc = {
          kind: 'manual-adjustment' as const,
          reasonCode: 'seed',
          note: 'pre-migration',
        };
        // Minted with the PRODUCTION composer, so the seeded chain is a real
        // chain: `verifyChain` passes on it before the migration, which is the
        // only way the break it reports afterwards can be attributed to the
        // migration rather than to a fabricated fixture.
        const eventHash = eventHashOf({
          id: eventId,
          tenantId,
          warehouseId,
          seq: event.seq,
          type: 'stock.adjusted',
          schemaVersion: 1,
          skuId,
          quantityDelta: event.delta,
          fromBinId: event.delta < 0 ? binId : null,
          toBinId: event.delta > 0 ? binId : null,
          batchRef: event.batchRef,
          serialRef: null,
          actorUserId: actorId,
          occurredAt: at,
          recordedAt: at,
          referenceDoc,
          prevHash,
        });
        await sql`
          insert into ledger_events (
            id, tenant_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta,
            from_bin_id, to_bin_id, batch_ref, actor_user_id, occurred_at, recorded_at,
            reference_doc, prev_hash, event_hash
          ) values (
            ${eventId}, ${tenantId}, ${warehouseId}, ${event.seq}, 'stock.adjusted', 1, ${skuId},
            ${event.delta},
            ${event.delta < 0 ? binId : null}, ${event.delta > 0 ? binId : null}, ${event.batchRef},
            ${actorId}, ${at}, ${at},
            ${sql.json(referenceDoc)},
            ${prevHash}, ${eventHash}
          )
        `;
        prevHash = eventHash;
      }
      // The ledger and the projections AGREE before the migration: 7 + 5 − 2
      // = 10 on hand, and the two batch-armed events fold to 7 − 2 = 5.
      await sql`
        insert into stock_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, quantity)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuId}, ${binId}, 10)
      `;
      await sql`
        insert into batch_on_hand (id, tenant_id, warehouse_id, sku_id, bin_id, batch_id, quantity)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuId}, ${binId}, ${batchId}, 5)
      `;

      await sql`
        insert into reservations (id, tenant_id, warehouse_id, sku_id, owner_type, owner_id, quantity, expires_at)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${skuId}, 'order', ${orderLineId}, 4, ${at})
      `;
      await sql`
        insert into purchase_order_lines (id, tenant_id, po_id, sku_id, ordered_qty, received_qty, unit_cost_paise)
        values (${uuidv7()}, ${tenantId}, ${poId}, ${skuId}, ${BIG_ORDERED_QTY}, 40, 12345)
      `;
      await sql`
        insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty)
        values (${grnLineId}, ${tenantId}, ${grnId}, ${skuId}, 40, 35)
      `;
      await sql`
        insert into over_receipts (
          id, tenant_id, warehouse_id, grn_id, grn_line_id, sku_id, excess_qty, requested_by, requested_at
        ) values (
          ${uuidv7()}, ${tenantId}, ${warehouseId}, ${grnId}, ${grnLineId}, ${skuId}, 5, ${actorId}, ${at}
        )
      `;
      await sql`
        insert into putaway_placements (
          id, tenant_id, warehouse_id, grn_id, grn_line_id, sku_id, qty, from_bin_id, to_bin_id,
          placed_by, placed_at, device_id
        ) values (
          ${uuidv7()}, ${tenantId}, ${warehouseId}, ${grnId}, ${grnLineId}, ${skuId}, 35, ${binId}, ${binId},
          ${actorId}, ${at}, ${uuidv7()}
        )
      `;
      await sql`
        insert into order_lines (id, tenant_id, order_id, sku_id, qty, reserved_qty)
        values (${orderLineId}, ${tenantId}, ${orderId}, ${skuId}, 9, 4)
      `;
      await sql`
        insert into picklist_lines (
          id, tenant_id, picklist_id, wave_id, order_id, order_line_id, sku_id, bin_id, qty,
          shortfall_qty, slice_seq, walk_seq
        ) values (
          ${uuidv7()}, ${tenantId}, ${picklistId}, ${waveId}, ${orderId}, ${orderLineId}, ${skuId},
          ${binId}, 4, 0, 0, 1
        )
      `;
      await sql`
        insert into picks (
          id, tenant_id, warehouse_id, wave_id, picklist_id, picklist_line_id, order_id, order_line_id,
          sku_id, bin_id, qty, picked_by, picked_at, device_id
        ) values (
          ${uuidv7()}, ${tenantId}, ${warehouseId}, ${waveId}, ${picklistId}, ${uuidv7()}, ${orderId},
          ${orderLineId}, ${skuId}, ${binId}, 3, ${actorId}, ${at}, ${uuidv7()}
        )
      `;
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part B — the I/O matrix, over HTTP, on the migrated schema. Every row of
  // the story's matrix that a caller can observe.
  // ──────────────────────────────────────────────────────────────────────────
  describe('the quantity matrix (e2e)', () => {
    let app: INestApplication;
    let suiteDb: SuiteDatabase;
    let sql: ReturnType<typeof postgres>;
    let valkey: Redis;
    let tenantId: string;
    let warehouseId: string;
    let zoneId: string;
    let ownerToken: string;
    let opsToken: string;
    let binId: string;
    const skuIds = new Map<string, string>();

    const EACH_SKU = 'FRQ-EACH';
    const KG_SKU = 'FRQ-KG';
    const SERIAL_SKU = 'FRQ-SERIAL';

    beforeAll(async () => {
      suiteDb = await useSuiteDatabase('fracqty');
      Logger.overrideLogger(false);
      app = await createApp();
      await app.init();
      sql = postgres(process.env.DATABASE_URL!, { max: 4 });
      valkey = new Redis(process.env.VALKEY_URL!);

      const email = `owner-${ulid().toLowerCase()}@example.com`;
      const registered = await request(app.getHttpServer())
        .post(API)
        .set(KEY_HEADER, ulid())
        .send({ name: `Fractional Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
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
          .send({ code: `FRQ-${ulid().slice(10, 16).toUpperCase()}`, name: 'Fractional WH' })
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
      binId = await createBin('A-01-01', 1000);

      // `FRQ-SERIAL` is each-counted on purpose: the catalog refuses a
      // serial-tracked SKU on a measured UoM, which is its own test below.
      const csv = [
        'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
        `${EACH_SKU},Each SKU,each,,1800,,false,false,50,100,`,
        `${KG_SKU},Measured SKU,kg,,1800,,false,false,2.5,10.25,`,
        `${SERIAL_SKU},Serial SKU,each,,1800,,false,true,,,`,
      ].join('\n');
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/catalog/imports`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .field('mode', 'initial')
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
        .expect(201);
      const catalog = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      for (const item of catalog.body.items as { code: string; id: string }[]) {
        skuIds.set(item.code, item.id);
      }
      expect(skuIds.size).toBe(3);
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

    async function createBin(code: string, capacity: number): Promise<string> {
      return (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, capacity, type: 'shelf' })
          .expect(201)
      ).body.id as string;
    }

    function adjust(skuId: string, quantityDelta: number, bin = binId) {
      return request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId,
          binId: bin,
          quantityDelta,
          reasonCode: 'cycle-count',
          note: 'matrix',
        });
    }

    /** The stored column, in milli-units — what the domain actually holds. */
    async function storedMilli(skuId: string, bin = binId): Promise<number> {
      const rows = await sql`
        select coalesce(sum(quantity), 0)::bigint as q from stock_on_hand
        where tenant_id = ${tenantId} and sku_id = ${skuId} and bin_id = ${bin}
      `;
      return Number((rows[0] as unknown as { q: string }).q);
    }

    it('an each-counted quantity reads back byte-identically — 500 in, 500 out, 500000 stored', async () => {
      const skuId = skuIds.get(EACH_SKU)!;
      const created = await adjust(skuId, 500).expect(201);
      // The response a pre-migration tenant would have seen, unchanged.
      expect(created.body.event.quantityDelta).toBe(500);
      expect(created.body.onHand.quantity).toBe(500);
      expect(await storedMilli(skuId)).toBe(500_000);

      const stock = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/warehouses/${warehouseId}/inventory/stock?skuId=${skuId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200);
      expect(stock.body.items[0].quantity).toBe(500);

      const events = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/warehouses/${warehouseId}/inventory/events?skuId=${skuId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200);
      expect(events.body.items[0].quantityDelta).toBe(500);
    });

    it('18.4 kg is received, stored as 18400 and read back as 18.4', async () => {
      const skuId = skuIds.get(KG_SKU)!;
      const created = await adjust(skuId, 18.4).expect(201);
      expect(created.body.event.quantityDelta).toBe(18.4);
      expect(created.body.onHand.quantity).toBe(18.4);
      expect(await storedMilli(skuId)).toBe(18_400);
    });

    it('a value finer than its unit is REFUSED, not rounded — 18.4567 on a 3-dp kg (story 10.2)', async () => {
      const skuId = skuIds.get(KG_SKU)!;
      // This is the matrix row that changed meaning. Story 10.1 stored 18457
      // here and said so; the unit now declares its own precision, so the
      // same request is a typed refusal naming the unit, the precision and
      // the value — and nothing is written.
      const before = await storedMilli(skuId);
      const refused = await adjust(skuId, 18.4567).expect(400);
      expect(refused.body.code).toBe('validation-failed');
      expect(refused.body.detail).toContain('"kg"');
      expect(refused.body.detail).toContain('3');
      expect(refused.body.detail).toContain('18.4567');
      expect(await storedMilli(skuId)).toBe(before);
    });

    it('a fractional draw nets exactly — no float dust across a sequence of decimals', async () => {
      const skuId = skuIds.get(KG_SKU)!;
      const bin = await createBin('A-01-09', 1000);
      await adjust(skuId, 0.1, bin).expect(201);
      await adjust(skuId, 0.2, bin).expect(201);
      const drawn = await adjust(skuId, -0.3, bin).expect(201);
      // 0.1 + 0.2 − 0.3 is exactly zero in milli-units, and only in milli-units.
      expect(drawn.body.onHand.quantity).toBe(0);
      expect(await storedMilli(skuId, bin)).toBe(0);
    });

    it('a large measured balance stays exact — 9 × 10¹¹ base units, no overflow and no rounding', async () => {
      const skuId = skuIds.get(KG_SKU)!;
      const bin = await createBin('A-01-08', 9_000_000_000_000);
      const created = await adjust(skuId, 900_000_000_000, bin).expect(201);
      expect(created.body.onHand.quantity).toBe(900_000_000_000);
      expect(await storedMilli(skuId, bin)).toBe(900_000_000_000_000);
      // …and one milli-unit more is still exact on top of it.
      const more = await adjust(skuId, 0.001, bin).expect(201);
      expect(more.body.onHand.quantity).toBe(900_000_000_000.001);
    });

    it('a quantity beyond the exact-integer ceiling is a typed 400 at the route bound, never a silent wrap', async () => {
      const skuId = skuIds.get(KG_SKU)!;
      await adjust(skuId, 9_007_199_254_741).expect(400);
    });

    it('a serial-tracked SKU on a measured UoM is refused at catalog entry, naming the UoM and the rule', async () => {
      const csv = [
        'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
        'FRQ-BAD-SERIAL,Serialised grain,kg,,1800,,false,true,,,',
      ].join('\n');
      const res = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/catalog/imports`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .field('mode', 'initial')
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 'bad.csv', contentType: 'text/csv' })
        .expect(201);
      expect(res.body.committedRows).toBe(0);
      const error = res.body.errors[0];
      expect(error.code).toBe('validation-failed');
      expect(error.detail).toContain('"kg"');
      expect(error.detail).toContain('three decimal places');
      expect(error.detail).toContain('one whole unit per serial');
      const rows = await sql`select count(*)::int as n from skus where tenant_id = ${tenantId} and code = 'FRQ-BAD-SERIAL'`;
      expect(Number((rows[0] as unknown as { n: number }).n)).toBe(0);
    });

    it('turning serial tracking ON is refused the same way when the SKU already measures in kg', async () => {
      const res = await request(app.getHttpServer())
        .patch(`${API}/${tenantId}/catalog/skus/${skuIds.get(KG_SKU)!}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ serialTracked: true })
        .expect(400);
      expect(res.body.code).toBe('validation-failed');
      expect(res.body.detail).toContain('"kg"');
    });

    it('a serial movement compares serials against UNSCALED units', async () => {
      const skuId = skuIds.get(SERIAL_SKU)!;
      const serials = ['S-1', 'S-2', 'S-3', 'S-4', 'S-5'];
      // 5 serials, 5 units — the array length is a UNIT count, never a
      // milli-unit count, and the comparison is made in units.
      const created = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId,
          binId,
          quantityDelta: 5,
          reasonCode: 'cycle-count',
          note: 'serial matrix',
          serials,
        })
        .expect(201);
      expect(created.body.onHand.quantity).toBe(5);
      expect(await storedMilli(skuId)).toBe(5_000);
      // One ledger event per serial, each carrying exactly one whole unit.
      const events = await sql`
        select quantity_delta from ledger_events
        where tenant_id = ${tenantId} and sku_id = ${skuId} and serial_ref is not null
      `;
      expect((events as unknown as { quantity_delta: string }[]).map((row) => Number(row.quantity_delta))).toEqual(
        [1000, 1000, 1000, 1000, 1000],
      );

      // A count that does not match the units is still the same refusal.
      const mismatch = await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId,
          binId,
          quantityDelta: 4,
          reasonCode: 'cycle-count',
          note: 'serial mismatch',
          serials: ['S-6', 'S-7', 'S-8', 'S-9', 'S-10'],
        })
        .expect(400);
      expect(mismatch.body.code).toBe('validation-failed');
      expect(mismatch.body.detail).toContain('5 serials cannot move 4 units');
    });

    it('the capacity gate keeps its meaning — both sides scaled, the comparison unchanged', async () => {
      const bin = await createBin('A-02-01', 1000);
      const listed = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const shown = (listed.body.items as { id: string; capacity: number }[]).find((b) => b.id === bin);
      expect(shown!.capacity).toBe(1000); // read back in base units
      const stored = await sql`select capacity from bins where id = ${bin}`;
      expect(Number((stored[0] as unknown as { capacity: string }).capacity)).toBe(1_000_000);
    });

    it('the reorder fields scale with the quantities they are compared against, decimals included', async () => {
      const listed = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const each = (listed.body.items as { code: string; reorderPoint: number; reorderQty: number }[]).find(
        (item) => item.code === EACH_SKU,
      );
      expect(each).toMatchObject({ reorderPoint: 50, reorderQty: 100 });
      const measured = (listed.body.items as { code: string; reorderPoint: number; reorderQty: number }[]).find(
        (item) => item.code === KG_SKU,
      );
      // Imported as `2.5` / `10.25` from the CSV — the importer is an edge too.
      expect(measured).toMatchObject({ reorderPoint: 2.5, reorderQty: 10.25 });
      const rows = await sql`
        select reorder_point, reorder_qty from skus where tenant_id = ${tenantId} and code = ${KG_SKU}
      `;
      expect(Number((rows[0] as unknown as { reorder_point: string }).reorder_point)).toBe(2_500);
      expect(Number((rows[0] as unknown as { reorder_qty: string }).reorder_qty)).toBe(10_250);
    });

    it('the Valkey reserved counter holds milli-units as an INCRBY-parsable decimal integer string', async () => {
      const skuId = skuIds.get(KG_SKU)!;
      const bin = await createBin('A-03-01', 100_000);
      await adjust(skuId, 12.5, bin).expect(201);
      const facade = app.get(InventoryFacade);
      const granted = await facade.grantReservation({
        tenantId,
        warehouseId,
        skuId,
        ownerType: 'order',
        ownerId: `frq-${ulid().toLowerCase()}`,
        quantity: toMilli(2.25),
      });
      expect(granted.quantity).toBe(2_250);
      const raw = await valkey.get(`wms:{${tenantId}}:wh:${warehouseId}:res:${skuId}`);
      // A plain decimal integer — no float, no exponential notation, which is
      // the whole reason the domain refuses decimals below the API edge.
      expect(raw).toMatch(/^\d+$/);
      expect(Number(raw)).toBe(2_250);
      const atp = await facade.atp(tenantId, warehouseId, skuId);
      expect(fromMilli(atp.reserved)).toBe(2.25);
    });

    /**
     * The story's acceptance gate, on the other side of the migration: the
     * scenarios above wrote through the real command paths — each-counted,
     * measured, sub-milli, serial-armed and very large — and every one of them
     * folded into the projections at milli scale. Replay re-derives those
     * balances from the ledger and compares them exactly; the reconcile cycle
     * is the job that would quarantine a scope if it disagreed. (Part A is the
     * complementary half: the same assertion made across the migration itself,
     * on a database that still carried the pre-migration schema.)
     */
    it('replay reproduces every balance on the migrated schema, and the reconcile cycle quarantines nothing', async () => {
      const facade = app.get(InventoryFacade);
      const report = await facade.replay(tenantId, warehouseId);
      expect(report.divergences).toEqual([]);
      expect(report.matches).toBe(true);

      await facade.reconcile(tenantId, warehouseId);
      const quarantines = await sql`
        select count(*)::int as n from inventory_quarantines where tenant_id = ${tenantId}
      `;
      expect(Number((quarantines[0] as unknown as { n: number }).n)).toBe(0);
    });
  });
});
