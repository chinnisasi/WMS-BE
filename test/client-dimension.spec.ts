import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { createDatabase } from '../src/shared/db/db';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

/**
 * Story 21-1 — the client dimension (AD-23). The four tables migration 0040
 * stamps `client_id` NOT NULL on; the migration test walks THIS list, so a
 * table added to the backfill in the schema without being added here is a
 * table the migration could silently leave without a client.
 */
const CLIENT_STAMPED_TABLES: readonly string[] = [
  'skus',
  'orders',
  'purchase_orders',
  'ledger_events',
];

/** The migration file this story ships, split into executable statements. */
function migrationStatements(): string[] {
  const sql = readFileSync(
    resolve(process.cwd(), 'drizzle/0040_client_dimension.sql'),
    'utf8',
  );
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

describe('story 21-1: the client dimension — one system-owned self client per tenant', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Part A — migration 0040 itself, against a database that still carries the
  // PRE-migration schema and real rows in every table it stamps. Built from
  // the repo's OWN migration journal trimmed to 0039 — the
  // fractional-quantity Part-A harness — never a hand-written replica.
  // ──────────────────────────────────────────────────────────────────────────
  describe('migration 0040, applied to pre-migration data', () => {
    const PRE_DB = 'wms_s_clientdim_premigration';
    let baseUrl: string;
    let preUrl: string;
    let sql: ReturnType<typeof postgres>;
    let folder: string;

    // TWO tenants — the mapping is per tenant, and a single-tenant fixture
    // could pass with a migration that pointed every row at ONE client.
    // 2-tuples (not arrays): indexing yields `string` even under
    // noUncheckedIndexedAccess, keeping the raw-SQL probes readable.
    const tenantIds: readonly [string, string] = [uuidv7(), uuidv7()];
    const warehouseIds: readonly [string, string] = [uuidv7(), uuidv7()];
    const skuIds: readonly [string, string] = [uuidv7(), uuidv7()];

    let seededRows: Record<string, unknown[]>;

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

      // A migrations folder that STOPS at 0039 — the schema as it stood the
      // moment before this story.
      folder = mkdtempSync(join(tmpdir(), 'wms-pre-0040-'));
      cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
      rmSync(join(folder, '0040_client_dimension.sql'));
      const journalPath = join(folder, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { idx: number }[];
      };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 39);
      writeFileSync(journalPath, JSON.stringify(journal));

      const db = createDatabase(preUrl);
      await migrate(db, { migrationsFolder: folder });
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

      sql = postgres(preUrl, { max: 2 });

      // Seeding and applying belong HERE, not inside test #1 — a focused `-t`
      // run must still assert against a migrated database (the 10-1 lesson).
      await seedPreMigrationRows();
      // Capture every seeded row (ALL pre-existing columns, the new
      // `client_id` excluded) BEFORE the migration applies — the byte-identity
      // assertion below compares against this full-width snapshot, so the
      // header's "all pre-existing columns are byte-identical" claim is proven
      // at its full width, not just on two named columns.
      seededRows = await captureStampedRows();

      // The apply runs inside ONE transaction — the atomicity model the real
      // runner uses, and the model the fail-fast guard + post-assertion are
      // written for.
      await sql.begin(async (tx) => {
        for (const statement of migrationStatements()) {
          await tx.unsafe(statement);
        }
      });
    }, 60_000);

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

    async function seedPreMigrationRows(): Promise<void> {
      const at = new Date().toISOString();
      for (let i = 0; i < tenantIds.length; i++) {
        const tenantId = tenantIds[i]!;
        const warehouseId = warehouseIds[i]!;
        const skuId = skuIds[i]!;
        const zoneId = uuidv7();
        const binId = uuidv7();
        const batchId = uuidv7();
        const vendorId = uuidv7();
        const poId = uuidv7();
        const actorId = uuidv7();
        await sql`insert into tenants (id, tenant_id, name) values (${tenantId}, ${tenantId}, ${'Client-dim Co ' + i})`;
        await sql`insert into warehouses (id, tenant_id, code, name) values (${warehouseId}, ${tenantId}, ${'CD' + i}, 'Client-dim WH')`;
        await sql`insert into zones (id, tenant_id, warehouse_id, code, name) values (${zoneId}, ${tenantId}, ${warehouseId}, 'A', 'Aisle A')`;
        await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type) values (${binId}, ${tenantId}, ${warehouseId}, ${zoneId}, 'A-01-01', 1000000, 'shelf')`;
        await sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode) values (${skuId}, ${tenantId}, 'CD-SKU', 'Client-dim SKU', 'each', 1800, ${'CD-BAR-' + i})`;
        await sql`insert into batches (id, tenant_id, sku_id, code) values (${batchId}, ${tenantId}, ${skuId}, 'B-1')`;
        await sql`insert into users (id, tenant_id, email, password_hash, role, status) values (${uuidv7()}, ${tenantId}, ${'cd-' + i + '-' + ulid().toLowerCase() + '@example.com'}, 'scrypt:x:y', 'owner', 'active')`;
        await sql`insert into vendors (id, tenant_id, code, name) values (${vendorId}, ${tenantId}, 'CD-V', 'Client-dim Vendor')`;
        await sql`insert into purchase_orders (id, tenant_id, warehouse_id, vendor_id, code, status) values (${poId}, ${tenantId}, ${warehouseId}, ${vendorId}, 'CD-PO', 'open')`;
        await sql`insert into purchase_order_lines (id, tenant_id, po_id, sku_id, ordered_qty, received_qty, unit_cost_paise) values (${uuidv7()}, ${tenantId}, ${poId}, ${skuId}, 1000, 0, 5000)`;
        await sql`insert into orders (id, tenant_id, warehouse_id, status, source) values (${uuidv7()}, ${tenantId}, ${warehouseId}, 'accepted', 'manual')`;
        // Two ledger events, hashed with dummy-but-fixed hashes: the
        // assertion about them is byte-identity across the migration, not
        // chain validity (0040 touches no hashed field — that is the point).
        for (const seq of [1, 2]) {
          await sql`
            insert into ledger_events (
              id, tenant_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta,
              to_bin_id, actor_user_id, occurred_at, recorded_at, reference_doc, prev_hash, event_hash
            ) values (
              ${uuidv7()}, ${tenantId}, ${warehouseId}, ${seq}, 'stock.adjusted', 1, ${skuId}, 1000,
              ${binId}, ${actorId}, ${at}, ${at}, ${sql.json({ kind: 'manual-adjustment', reasonCode: 'seed', note: 'pre-21-1' })}, 'genesis', ${'seed-hash-' + tenantId + '-' + seq}
            )
          `;
        }
      }
    }

    function selfClientId(tenantId: string): Promise<string | undefined> {
      return (async () => {
        const rows = await sql`
          select id from clients where tenant_id = ${tenantId} and code = 'self' and system_owned limit 1
        `;
        return (rows[0] as unknown as { id: string } | undefined)?.id;
      })();
    }

    /**
     * Every row of the four stamped tables as a JSON object, keyed by table.
     * `to_jsonb(t) - 'client_id'` carries ALL columns the row had — pre-0040
     * (where the key doesn't exist yet, and subtracting a missing key is a
     * no-op) and post-0040 alike — so a byte-for-byte comparison across the
     * migration sees any touched value on any column, including ones this
     * test never named. The order (by the row's text form, which includes the
     * unique id) is deterministic.
     */
    async function captureStampedRows(): Promise<Record<string, unknown[]>> {
      const snapshot: Record<string, unknown[]> = {};
      for (const table of CLIENT_STAMPED_TABLES) {
        const rows = (await sql`
          select to_jsonb(t) - 'client_id' as row from ${sql(table)} t order by 1
        `) as unknown as { row: unknown }[];
        snapshot[table] = rows.map((entry) => entry.row);
      }
      return snapshot;
    }

    it('creates exactly one system-owned self client per existing tenant, and none anywhere else', async () => {
      const clients = (await sql`
        select tenant_id, code, name, status, system_owned from clients order by tenant_id
      `) as unknown as {
        tenant_id: string;
        code: string;
        name: string;
        status: string;
        system_owned: boolean;
      }[];
      expect(clients.map((row) => row.tenant_id)).toEqual([...tenantIds].sort());
      for (const row of clients) {
        expect(row.code).toBe('self');
        expect(row.system_owned).toBe(true);
        expect(row.status).toBe('active');
        // Named after the tenant — the same value the ensure helper gives
        // freshly registered tenants, so migrated and new tenants are
        // indistinguishable.
        const tenantName = (
          (await sql`select name from tenants where id = ${row.tenant_id}`) as unknown as {
            name: string;
          }[]
        )[0]!.name;
        expect(row.name).toBe(tenantName);
      }
    });

    it('carries every row of the four stamped tables to its OWN tenant self client', async () => {
      for (const tenantId of tenantIds) {
        const clientId = (await selfClientId(tenantId))!;
        expect(clientId).toBeDefined();
        for (const table of CLIENT_STAMPED_TABLES) {
          const rows = (await sql`
            select count(*)::int as n from ${sql(table)} where tenant_id = ${tenantId}
          `) as unknown as { n: number }[];
          expect(Number(rows[0]!.n)).toBeGreaterThan(0);
          const unmapped = (await sql`
            select count(*)::int as n from ${sql(table)}
            where tenant_id = ${tenantId} and (client_id is null or client_id <> ${clientId})
          `) as unknown as { n: number }[];
          expect(Number(unmapped[0]!.n)).toBe(0);
        }
        // The two designed-nullable columns exist and stay NULL (no backfill
        // was specified for them — pre-21.1 bins are commingled, users are
        // staff).
        const dedicated = (await sql`
          select count(*)::int as n from bins where dedicated_client_id is not null and tenant_id = ${tenantId}
        `) as unknown as { n: number }[];
        expect(Number(dedicated[0]!.n)).toBe(0);
        const portalUsers = (await sql`
          select count(*)::int as n from users where client_id is not null and tenant_id = ${tenantId}
        `) as unknown as { n: number }[];
        expect(Number(portalUsers[0]!.n)).toBe(0);
      }
    });

    it('changes no representation: every pre-existing column of every seeded row is byte-identical', async () => {
      // The FULL-width comparison the migration header claims: all four
      // stamped tables, all pre-existing columns (`client_id` is the only
      // value the migration is allowed to introduce), all seeded rows. A
      // stray rewrite of any column — a second quantity scale, a re-derived
      // timestamp, a touched hash — shows up here as a diff on that row.
      expect(await captureStampedRows()).toEqual(seededRows);
      // Quantities are milli-units, NOT re-scaled a second time by a stray
      // backfill expression — named separately so a failure says why.
      const deltas = (await sql`
        select quantity_delta from ledger_events order by tenant_id, warehouse_id, seq
      `) as unknown as { quantity_delta: string }[];
      expect(deltas.map((row) => Number(row.quantity_delta))).toEqual([1000, 1000, 1000, 1000]);
    });

    it('the NOT NULL locks hold: a write without a client is refused (23502)', async () => {
      for (const table of CLIENT_STAMPED_TABLES) {
        if (table === 'orders') {
          await expect(
            sql`insert into orders (id, tenant_id, warehouse_id, status, source)
                values (${uuidv7()}, ${tenantIds[0]}, ${warehouseIds[0]}, 'accepted', 'manual')`,
          ).rejects.toMatchObject({ code: '23502' });
        } else if (table === 'purchase_orders') {
          await expect(
            sql`insert into purchase_orders (id, tenant_id, warehouse_id, vendor_id, code, status)
                values (${uuidv7()}, ${tenantIds[0]}, ${warehouseIds[0]}, ${uuidv7()}, 'NO-CLIENT', 'open')`,
          ).rejects.toMatchObject({ code: '23502' });
        } else if (table === 'skus') {
          await expect(
            sql`insert into skus (id, tenant_id, code, name, uom, gst_rate_bps, barcode)
                values (${uuidv7()}, ${tenantIds[0]}, 'NO-CLIENT-SKU', 'probe', 'each', 1800, ${ulid()})`,
          ).rejects.toMatchObject({ code: '23502' });
        } else {
          await expect(
            sql`insert into ledger_events (
                id, tenant_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta,
                actor_user_id, occurred_at, recorded_at, reference_doc, prev_hash, event_hash
              ) values (
                ${uuidv7()}, ${tenantIds[0]}, ${warehouseIds[0]}, 99, 'stock.adjusted', 1, ${skuIds[0]}, 1,
                ${uuidv7()}, now(), now(), ${sql.json({ kind: 'manual-adjustment', reasonCode: 'seed' })}, 'genesis', 'x'
              )`,
          ).rejects.toMatchObject({ code: '23502' });
        }
      }
    });

    it('the fail-fast guard refuses a re-application (the test bites)', async () => {
      // The guard is the migration's FIRST statement — re-running it against
      // the already-migrated database must raise, which is what stops a
      // hand-applied second run from silently re-backfilling.
      const guard = migrationStatements()[0]!;
      await expect(sql.unsafe(guard)).rejects.toThrow(/migration 0040 has already been applied/);
    });

    it('the partial unique index refuses a second system-owned client per tenant (23505)', async () => {
      await expect(
        sql`insert into clients (id, tenant_id, code, name, status, system_owned)
            values (${uuidv7()}, ${tenantIds[0]}, 'other', 'Second self', 'active', true)`,
      ).rejects.toMatchObject({ code: '23505' });
      // A second NON-system client for the same tenant is fine (the partial
      // index is system-owned-only), and the (tenant, code) unique holds.
      await sql`insert into clients (id, tenant_id, code, name, status, system_owned)
        values (${uuidv7()}, ${tenantIds[0]}, 'brand-a', 'Brand A', 'active', false)`;
    });

    it('the CHECKs pin the status vocabulary and the system-owned pairing (23514)', async () => {
      await expect(
        sql`insert into clients (id, tenant_id, code, name, status, system_owned)
            values (${uuidv7()}, ${tenantIds[0]}, 'bogus-status', 'probe', 'departed-ish', false)`,
      ).rejects.toMatchObject({ code: '23514' });
      // A system-owned client cannot be departed (AD-23: the tenant's own
      // goods never offboard).
      await expect(
        sql`insert into clients (id, tenant_id, code, name, status, system_owned)
            values (${uuidv7()}, ${tenantIds[0]}, 'departed-self', 'probe', 'departed', true)`,
      ).rejects.toMatchObject({ code: '23514' });
      // A third-party client MAY be suspended and departed — the full
      // designed vocabulary is live.
      await sql`insert into clients (id, tenant_id, code, name, status, system_owned)
        values (${uuidv7()}, ${tenantIds[1]}, 'departed-brand', 'Gone Brand', 'departed', false)`;
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part B — the registration seam + the writer paths, over HTTP, on the
  // migrated schema. Proves the migration AND the seam together: a fresh
  // tenant is born with its self client in the registration transaction, and
  // every one of the four stamped tables' writes carries it.
  // ──────────────────────────────────────────────────────────────────────────
  describe('registration and the writer paths (e2e)', () => {
    let app: INestApplication;
    let suiteDb: SuiteDatabase;
    let sql: ReturnType<typeof postgres>;
    let tenantId: string;
    let warehouseId: string;
    let zoneId: string;
    let binId: string;
    let ownerToken: string;
    let skuId: string;

    beforeAll(async () => {
      suiteDb = await useSuiteDatabase('clientdim');
      Logger.overrideLogger(false);
      app = await createApp();
      await app.init();
      sql = postgres(process.env.DATABASE_URL!, { max: 4 });

      const email = `owner-${ulid().toLowerCase()}@example.com`;
      const registered = await request(app.getHttpServer())
        .post(API)
        .set(KEY_HEADER, ulid())
        .send({ name: `Client-dim Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
        .expect(201);
      tenantId = registered.body.tenant.id as string;
      ownerToken = (
        await request(app.getHttpServer())
          .post(`${API}/sign-in`)
          .send({ email, password: 'correct-horse-battery' })
          .expect(200)
      ).body.accessToken as string;

      warehouseId = (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code: `CD-${ulid().slice(10, 16).toUpperCase()}`, name: 'Client-dim WH' })
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
          .send({ code: 'A-01-01', capacity: 100000, type: 'shelf' })
          .expect(201)
      ).body.id as string;

      const csv = [
        'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
        `CD-SKU,Client-dim SKU,each,,1800,,false,false,10,20,`,
      ].join('\n');
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/catalog/imports`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .field('mode', 'initial')
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
        .expect(201);
      const skus = await request(app.getHttpServer())
        .get(`${API}/${tenantId}/catalog/skus`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      skuId = (skus.body.items as { code: string; id: string }[])[0]!.id;

      // Cold-start bootstrap (the orders-suite precedent): seed the tenant's
      // reservation counters + ready marker from the (still empty) journal —
      // without it the first order create answers 503 not-ready, not 201.
      await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
    }, 60_000);

    afterAll(async () => {
      const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
      await rawDb.$client?.end();
      const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
      await authDb.$client?.end();
      await sql.end();
      await app.close();
      await suiteDb.drop();
    });

    async function selfClientId(): Promise<string> {
      const rows = await sql`
        select id from clients where tenant_id = ${tenantId} and code = 'self' and system_owned limit 1
      `;
      return (rows[0] as unknown as { id: string }).id;
    }

    async function assertStamped(table: string): Promise<void> {
      const clientId = await selfClientId();
      const rows = (await sql`
        select count(*)::int as total,
               count(*) filter (where client_id is null)::int as null_rows,
               count(*) filter (where client_id <> ${clientId})::int as foreign_rows
        from ${sql(table)} where tenant_id = ${tenantId}
      `) as unknown as { total: number; null_rows: number; foreign_rows: number }[];
      const row = rows[0]!;
      expect(Number(row.total)).toBeGreaterThan(0);
      // Null and foreign rows are asserted separately so a failure NAMES the
      // arm (a single combined count would not say which kind of leak).
      expect(Number(row.null_rows)).toBe(0);
      expect(Number(row.foreign_rows)).toBe(0);
    }

    it('registration creates exactly one system-owned self client, in the same transaction as the tenant', async () => {
      const clients = (await sql`
        select code, name, status, system_owned from clients where tenant_id = ${tenantId}
      `) as unknown as { code: string; name: string; status: string; system_owned: boolean }[];
      expect(clients).toHaveLength(1);
      expect(clients[0]).toMatchObject({ code: 'self', status: 'active', system_owned: true });
      // Named after the tenant.
      const tenantName = (
        (await sql`select name from tenants where id = ${tenantId}`) as unknown as { name: string }[]
      )[0]!.name;
      expect(clients[0]!.name).toBe(tenantName);
      // The registration snapshot itself is unchanged — no FE change.
      // (Asserted implicitly: the registration above answered 201 with the
      // tenant + owner body the FE has always consumed.)
    });

    it('a failed registration leaves no client (the whole transaction rolls back)', async () => {
      const before = (await sql`select count(*)::int as n from clients`) as unknown as { n: number }[];
      const email = `dup-${ulid().toLowerCase()}@example.com`;
      // A first, successful registration so the second one can fail.
      await request(app.getHttpServer())
        .post(API)
        .set(KEY_HEADER, ulid())
        .send({ name: `Dup Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
        .expect(201);
      const failedName = `Rolled-back Co ${ulid()}`;
      await request(app.getHttpServer())
        .post(API)
        .set(KEY_HEADER, ulid())
        .send({ name: failedName, ownerEmail: email, password: 'correct-horse-battery' })
        .expect(409);
      const after = (await sql`select count(*)::int as n from clients`) as unknown as { n: number }[];
      // Exactly ONE client was born — for the successful registration, never
      // the failed one.
      expect(Number(after[0]!.n)).toBe(Number(before[0]!.n) + 1);
      const rolledBack = (await sql`
        select count(*)::int as n from tenants where name = ${failedName}
      `) as unknown as { n: number }[];
      expect(Number(rolledBack[0]!.n)).toBe(0);
    });

    it('every stamped writer path carries the self client: skus, ledger_events, purchase_orders, orders', async () => {
      // ledger_events: the stock adjustment through the real command path.
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          skuId,
          binId,
          quantityDelta: 500,
          reasonCode: 'cycle-count',
          note: 'client-dim',
        })
        .expect(201);

      // purchase_orders: a vendor + a PO through the real create command.
      const vendorId = (
        await request(app.getHttpServer())
          .post(`${API}/${tenantId}/vendors`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'CD-VEND', name: 'Client-dim Vendor' })
          .expect(201)
      ).body.vendor.id as string;
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/inbound/purchase-orders`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          vendorId,
          code: 'CD-PO-1',
          lines: [{ skuId, orderedQty: 10, unitCostPaise: 1200 }],
        })
        .expect(201);

      // orders: accepted against the on-hand stock — the grant needs ATP.
      await request(app.getHttpServer())
        .post(`${API}/${tenantId}/outbound/orders`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({
          warehouseId,
          lines: [{ skuId, quantity: 3 }],
          destination: testAddress(),
        })
        .expect(201);

      await assertStamped('skus');
      await assertStamped('ledger_events');
      await assertStamped('purchase_orders');
      await assertStamped('orders');
    });
  });
});