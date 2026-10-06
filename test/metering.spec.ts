import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Logger, type INestApplication } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { createDatabase, type Database } from '../src/shared/db/db';
import { sql as dsql } from 'drizzle-orm';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { addIsoDays, istDateOf, istMidnightOf } from '../src/shared/primitives/time';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { SignedQuantity } from '../src/shared/primitives/quantity';
import { divideRoundHalfUp } from '../src/shared/primitives/money';
import { divideRoundHalfUp as invoicingDivideRoundHalfUp } from '../src/modules/invoicing/arith';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { getLedgerEventType, registeredLedgerEventTypes } from '../src/modules/inventory/ledger-registry';
import { rateCardClock } from '../src/modules/billing/rate-card.command';
import { BillingFacade } from '../src/modules/billing/billing.facade';
import { MAX_METERING_DAYS, milliToDecimal, storageAmountPaise } from '../src/modules/billing/metering';
import { lastClosableDay, type SnapshotTickResult } from '../src/modules/billing/storage-snapshot';
import {
  MAX_STORAGE_SNAPSHOT_SCOPES_PER_TICK,
  StorageSnapshotWorker,
  parseStorageSnapshotPollMs,
} from '../src/jobs/jobs.module';
import { ProblemException } from '../src/shared/problem-details/problem.exception';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.STORAGE_SNAPSHOT_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(180_000);

/** An IST wall-clock instant in ms, e.g. `ist('2026-09-10T10:00')`. */
function ist(local: string): number {
  return Date.parse(local.length === 16 ? `${local}:00+05:30` : `${local}+05:30`);
}

/** The same, as an ISO-8601 UTC instant. */
function istIso(local: string): string {
  return new Date(ist(local)).toISOString();
}

/** The migration file this story ships, split into executable statements. */
function migration0061Statements(): string[] {
  const text = readFileSync(resolve(process.cwd(), 'drizzle/0061_storage_snapshots.sql'), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

describe('story 21-4: metering and storage snapshots', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Part A — pure arithmetic: the BigInt rounding, the decimal quantity, the
  // grace boundary, the env gate.
  // ──────────────────────────────────────────────────────────────────────────
  describe('arithmetic and parsing', () => {
    it('storage is Σ milli-unit-days × rate ÷ 1,000,000, in BigInt, rounded once half-up (the matrix row: 1,234,567 × 330 → 407)', () => {
      expect(storageAmountPaise(1_234_567n, 330)).toBe(407);
      expect(storageAmountPaise(1_500_000n, 1)).toBe(2); // exactly half → up
      expect(storageAmountPaise(1_499_999n, 1)).toBe(1);
      expect(storageAmountPaise(0n, 330)).toBe(0);
      // Past 2⁵³ in the product — exact in BigInt, where a double would round:
      // (2⁵³ + 1) × 330 = 2,972,375,754,064,527,690 → ÷ 10⁶ = …064.52769 → …065.
      expect(storageAmountPaise(2n ** 53n + 1n, 330)).toBe(2_972_375_754_065);
      // An amount past the exact paise range is refused loudly, never rounded.
      // …as a TYPED problem (a 422 on the wire), not an untyped Error.
      expect(() => storageAmountPaise(2n ** 60n, 10_000_000)).toThrow(ProblemException);
      expect(() => storageAmountPaise(2n ** 60n, 10_000_000)).toThrow(/exact paise range/);
    });

    it('divideRoundHalfUp moved to shared/primitives/money and invoicing re-exports the same function', () => {
      expect(invoicingDivideRoundHalfUp).toBe(divideRoundHalfUp);
      expect(divideRoundHalfUp(5n, 2n)).toBe(3n);
      expect(divideRoundHalfUp(4n, 3n)).toBe(1n);
      expect(divideRoundHalfUp(0n, 7n)).toBe(0n);
    });

    it('a storage quantity travels as an exact base-unit-day decimal string', () => {
      expect(milliToDecimal(1_234_567n)).toBe('1234.567');
      expect(milliToDecimal(2_000n)).toBe('2');
      expect(milliToDecimal(1_500n)).toBe('1.5');
      expect(milliToDecimal(0n)).toBe('0');
      expect(milliToDecimal(2n ** 60n)).toBe('1152921504606846.976');
    });

    it('the grace: day D is closable only 15 minutes after the IST midnight that ends it', () => {
      expect(lastClosableDay(ist('2026-09-11T00:05'))).toBe('2026-09-09');
      expect(lastClosableDay(ist('2026-09-11T00:14:59'))).toBe('2026-09-09');
      expect(lastClosableDay(ist('2026-09-11T00:15'))).toBe('2026-09-10');
    });

    it('STORAGE_SNAPSHOT_POLL_MS: unset or 0 is off; anything but a non-negative integer fails the boot', () => {
      expect(parseStorageSnapshotPollMs(undefined)).toBe(0);
      expect(parseStorageSnapshotPollMs('')).toBe(0);
      expect(parseStorageSnapshotPollMs('0')).toBe(0);
      expect(parseStorageSnapshotPollMs('300000')).toBe(300000);
      expect(() => parseStorageSnapshotPollMs('5m')).toThrow(/STORAGE_SNAPSHOT_POLL_MS/);
      expect(() => parseStorageSnapshotPollMs('-1')).toThrow(/STORAGE_SNAPSHOT_POLL_MS/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part B — migration 0061 against a database built from the repo's OWN
  // journal trimmed to 0060, applied inside ONE transaction like the runner.
  // ──────────────────────────────────────────────────────────────────────────
  describe('migration 0061, applied to a pre-migration database', () => {
    const PRE_DB = 'wms_s_metering_premigration';
    let sql: ReturnType<typeof postgres>;
    let folder: string;

    async function admin<T>(fn: (db: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
      const adminUrl = new URL(process.env.DATABASE_URL!);
      adminUrl.pathname = '/postgres';
      const db = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
      try {
        return await fn(db);
      } finally {
        await db.end();
      }
    }

    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${PRE_DB}`;
      const preUrl = url.toString();
      await admin(async (db) => {
        await db.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
        await db.unsafe(`drop database if exists "${PRE_DB}"`);
        await db.unsafe(`create database "${PRE_DB}"`);
      });
      folder = mkdtempSync(join(tmpdir(), 'wms-pre-0061-'));
      cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
      rmSync(join(folder, '0061_storage_snapshots.sql'));
      const journalPath = join(folder, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 60);
      writeFileSync(journalPath, JSON.stringify(journal));
      const db = createDatabase(preUrl);
      await migrate(db, { migrationsFolder: folder });
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
      sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
    }, 120_000);

    afterAll(async () => {
      await sql?.end();
      rmSync(folder, { recursive: true, force: true });
      await admin(async (db) => {
        await db.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
        await db.unsafe(`drop database if exists "${PRE_DB}"`);
      });
    });

    it('applies in one transaction: both tables, the ledger index, the CHECKs and the policies (client-scoped reads, operator-only writes)', async () => {
      const before = await sql<{ indexname: string }[]>`
        select indexname from pg_indexes where indexname = 'ledger_events_tenant_client_warehouse_recorded_at_idx'`;
      expect(before).toHaveLength(0);
      await sql.begin(async (tx) => {
        for (const statement of migration0061Statements()) {
          await tx.unsafe(statement);
        }
      });
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('storage_snapshots', 'storage_snapshot_progress') order by table_name`;
      expect(tables.map((row) => row.table_name)).toEqual(['storage_snapshot_progress', 'storage_snapshots']);
      const index = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes where indexname = 'ledger_events_tenant_client_warehouse_recorded_at_idx'`;
      expect(index[0]?.indexdef).toContain('(tenant_id, client_id, warehouse_id, recorded_at)');
      // The metering read's two indexes: the dispatched-order count and the
      // per-client snapshot sums.
      const typeIndex = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes where indexname = 'ledger_events_tenant_client_type_recorded_at_idx'`;
      expect(typeIndex[0]?.indexdef).toContain('(tenant_id, client_id, type, recorded_at)');
      const sumIndex = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes where indexname = 'storage_snapshots_tenant_client_date_idx'`;
      expect(sumIndex[0]?.indexdef).toContain('(tenant_id, client_id, snapshot_date)');
      const columns = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = 'storage_snapshot_progress' order by ordinal_position`;
      expect(columns.map((row) => row.column_name)).toEqual(['tenant_id', 'client_id', 'warehouse_id', 'last_day', 'running', 'drift_checked_on', 'updated_at']);
      const unique = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes where indexname = 'storage_snapshots_scope_day_uom_unique'`;
      expect(unique[0]?.indexdef).toContain('UNIQUE');
      expect(unique[0]?.indexdef).toContain('(tenant_id, client_id, warehouse_id, snapshot_date, uom)');
      const policies = await sql<{ tablename: string; cmd: string; qual: string | null; with_check: string | null }[]>`
        select tablename, cmd, qual, with_check from pg_policies
        where tablename in ('storage_snapshots', 'storage_snapshot_progress') order by tablename, cmd`;
      expect(policies.map((row) => `${row.tablename}:${row.cmd}`)).toEqual([
        'storage_snapshot_progress:DELETE',
        'storage_snapshot_progress:INSERT',
        'storage_snapshot_progress:SELECT',
        'storage_snapshot_progress:UPDATE',
        'storage_snapshots:DELETE',
        'storage_snapshots:INSERT',
        'storage_snapshots:SELECT',
        'storage_snapshots:UPDATE',
      ]);
      for (const policy of policies) {
        const arms = `${policy.qual ?? ''} ${policy.with_check ?? ''}`;
        expect(arms).toContain('app.tenant_id');
        if (policy.cmd === 'SELECT') {
          expect(arms).toContain("(client_id = (NULLIF(current_setting('app.client_id'");
        } else {
          expect(arms).toContain("(NULLIF(current_setting('app.client_id'::text, true), ''::text) IS NULL)");
          expect(arms).not.toContain('(client_id =');
        }
      }
      const rls = await sql<{ relname: string; relrowsecurity: boolean }[]>`
        select relname, relrowsecurity from pg_class where relname in ('storage_snapshots', 'storage_snapshot_progress')`;
      expect(rls).toHaveLength(2);
      expect(rls.every((row) => row.relrowsecurity)).toBe(true);
    });

    it('the CHECK bites: no zero or negative snapshot; the key is per (scope, day, uom)', async () => {
      const ids = { t: uuidv7(), c: uuidv7(), w: uuidv7() };
      await expect(
        sql`insert into storage_snapshots (id, tenant_id, client_id, warehouse_id, snapshot_date, uom, on_hand_milli)
          values (${uuidv7()}, ${ids.t}, ${ids.c}, ${ids.w}, '2026-09-01', 'pcs', 0)`,
      ).rejects.toMatchObject({ code: '23514' });
      await sql`insert into storage_snapshots (id, tenant_id, client_id, warehouse_id, snapshot_date, uom, on_hand_milli)
        values (${uuidv7()}, ${ids.t}, ${ids.c}, ${ids.w}, '2026-09-01', 'pcs', 1)`;
      // The key is per base UoM: a second uom on the same day is a second row…
      await sql`insert into storage_snapshots (id, tenant_id, client_id, warehouse_id, snapshot_date, uom, on_hand_milli)
        values (${uuidv7()}, ${ids.t}, ${ids.c}, ${ids.w}, '2026-09-01', 'kg', 1)`;
      // …and the same (scope, day, uom) twice is refused.
      await expect(
        sql`insert into storage_snapshots (id, tenant_id, client_id, warehouse_id, snapshot_date, uom, on_hand_milli)
          values (${uuidv7()}, ${ids.t}, ${ids.c}, ${ids.w}, '2026-09-01', 'pcs', 2)`,
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('the fail-fast guard refuses a second application', async () => {
      const guard = migration0061Statements()[0]!;
      await expect(sql.unsafe(guard)).rejects.toThrow(/migration 0061 has already been applied/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part C — the snapshots, the metering read and the route, over a real
  // ledger. Ledger events are appended THROUGH THE INVENTORY FACADE (the
  // real hash chain and projections) with chosen `recorded_at` instants —
  // the snapshots bucket by that server stamp, which an HTTP flow would set
  // to "now". GRN lines and picks rows (the two handling counts) are seeded
  // by SQL for the same reason: their counting instants are server stamps.
  // ──────────────────────────────────────────────────────────────────────────
  describe('over the ledger', () => {
    let app: INestApplication;
    let db: Database;
    let sql: postgres.Sql;
    let suiteDb: SuiteDatabase;
    let inventory: InventoryFacade;
    let billing: BillingFacade;
    const realRateCardNow = rateCardClock.now;

    let tenantId: string;
    let ownerToken: string;
    let accountantToken: string;
    let opsToken: string;
    let actorId: string;
    let wh1: string;
    let wh2: string;
    let binA: string;
    let binB: string;
    let binC: string;
    let selfId: string;
    const clients = new Map<string, string>();
    const skus = new Map<string, string>();
    let cardA: string;
    let cardB: string;
    let other: { tenantId: string; ownerToken: string; clientId: string };

    const http = () => request(app.getHttpServer());
    const client = (code: string): string => clients.get(code)!;
    const sku = (code: string): string => skus.get(code)!;

    async function register(name: string): Promise<{ tenantId: string; ownerToken: string; userId: string }> {
      const email = `owner-${ulid().toLowerCase()}@example.com`;
      const registered = await http()
        .post(API)
        .set(KEY_HEADER, ulid())
        .send({ name, ownerEmail: email, password: 'correct-horse-battery' })
        .expect(201);
      const signedIn = await http().post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200);
      return {
        tenantId: registered.body.tenant.id as string,
        ownerToken: signedIn.body.accessToken as string,
        userId: registered.body.owner.id as string,
      };
    }

    async function invite(role: string): Promise<string> {
      const email = `${role}-${ulid().toLowerCase()}@example.com`;
      const invited = await http()
        .post(`${API}/${tenantId}/users`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email, role })
        .expect(201);
      await http()
        .post(`${API}/${tenantId}/accept-invite`)
        .set(KEY_HEADER, ulid())
        .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
        .expect(200);
      return (await http().post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200)).body
        .accessToken as string;
    }

    async function createWarehouse(code: string): Promise<{ warehouseId: string; zoneId: string }> {
      const warehouseId = (
        await http()
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code, name: `${code} warehouse` })
          .expect(201)
      ).body.id as string;
      const zoneId = (
        await http()
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'A', name: 'Aisle A' })
          .expect(201)
      ).body.id as string;
      return { warehouseId, zoneId };
    }

    async function createBin(warehouseId: string, zoneId: string, code: string): Promise<string> {
      return (
        await http()
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 100000000, type: 'shelf', code })
          .expect(201)
      ).body.id as string;
    }

    async function importSkus(clientId: string, rows: string[]): Promise<void> {
      const csv = ['sku_code,name,uom,gst_rate,product,variant_values,kit_components', ...rows].join('\n');
      await http()
        .post(`${API}/${tenantId}/catalog/imports`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .field('mode', 'initial')
        .field('clientId', clientId)
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
        .expect(201);
    }

    /** One ledger event through the facade, stamped `recordedAt`. */
    async function append(event: {
      warehouseId: string;
      type: string;
      skuId: string;
      quantityDelta: number;
      fromBinId?: string | null;
      toBinId?: string | null;
      recordedAt: string;
      referenceDoc?: Record<string, unknown>;
    }): Promise<void> {
      const definition = getLedgerEventType(event.type)!;
      await withTenantTransaction(db, tenantId, (tx) =>
        inventory.appendLedgerEventInTx(tx, {
          tenantId,
          warehouseId: event.warehouseId,
          type: event.type,
          skuId: event.skuId,
          quantityDelta: event.quantityDelta as SignedQuantity,
          fromBinId: event.fromBinId ?? null,
          toBinId: event.toBinId ?? null,
          batchRef: null,
          serialRef: null,
          actorUserId: actorId,
          occurredAt: event.recordedAt,
          recordedAt: event.recordedAt,
          referenceDoc: (event.referenceDoc ?? { kind: definition.referenceKinds[0] }) as never,
        }),
      );
    }

    /** One GRN with `lines` lines (SKU ids), recorded at `recordedAt`. */
    async function seedGrn(warehouseId: string, recordedAt: string, skuIds: readonly string[]): Promise<void> {
      const grnId = uuidv7();
      await sql`insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, blind_reason_code, status, device_id, recorded_by, occurred_at, recorded_at)
        values (${grnId}, ${tenantId}, ${warehouseId}, ${'GRN-' + ulid().slice(14)}, null, 'other', 'recorded', ${uuidv7()}, ${actorId}, ${recordedAt}, ${recordedAt})`;
      for (const skuId of skuIds) {
        await sql`insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty)
          values (${uuidv7()}, ${tenantId}, ${grnId}, ${skuId}, 1000, 1000)`;
      }
    }

    /** One picks row (one picklist line) created at `createdAt`. */
    async function seedPick(warehouseId: string, skuId: string, binId: string, createdAt: string): Promise<void> {
      await sql`insert into picks (id, tenant_id, warehouse_id, wave_id, picklist_id, picklist_line_id, order_id, order_line_id,
          sku_id, bin_id, qty, picked_by, picked_at, device_id, created_at, updated_at)
        values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()},
          ${skuId}, ${binId}, 1000, ${actorId}, ${createdAt}, ${uuidv7()}, ${createdAt}, ${createdAt})`;
    }

    async function storedRows(clientId: string, warehouseId?: string): Promise<{ day: string; uom: string; milli: string; warehouse: string }[]> {
      const rows = await sql<{ day: string; uom: string; milli: string; warehouse: string }[]>`
        select snapshot_date::text as day, uom, on_hand_milli::text as milli, warehouse_id::text as warehouse
        from storage_snapshots where tenant_id = ${tenantId} and client_id = ${clientId}
        order by warehouse_id, snapshot_date, uom`;
      return warehouseId === undefined ? [...rows] : rows.filter((row) => row.warehouse === warehouseId);
    }

    async function progress(clientId: string, warehouseId: string): Promise<{ last_day: string; drift_checked_on: string | null } | undefined> {
      const rows = await sql<{ last_day: string; drift_checked_on: string | null }[]>`
        select last_day::text as last_day, drift_checked_on::text as drift_checked_on from storage_snapshot_progress
        where tenant_id = ${tenantId} and client_id = ${clientId} and warehouse_id = ${warehouseId}`;
      return rows[0];
    }

    /**
     * Tick one scope until it is no longer held back by the commit guarantee
     * (an open transaction that began before a day's end) — a quiet scope
     * settles in one call; the loop tolerates a stray transaction.
     */
    async function settle(clientId: string, warehouseId: string, nowMs: number): Promise<SnapshotTickResult> {
      let rowsWritten = 0;
      let daysWritten = 0;
      let last!: SnapshotTickResult;
      for (let i = 0; i < 4; i += 1) {
        last = await billing.snapshotScope(tenantId, clientId, warehouseId, nowMs);
        rowsWritten += last.rowsWritten;
        daysWritten += last.daysWritten;
        if (last.waiting !== 'commit-guarantee') break;
      }
      return { ...last, rowsWritten, daysWritten };
    }

    function usage(clientId: string, from: string, to: string, token = opsToken): SupertestTest {
      return http()
        .get(`${API}/${tenantId}/clients/${clientId}/usage?from=${from}&to=${to}`)
        .set('Authorization', `Bearer ${token}`);
    }

    function expectProblem(res: request.Response, status: number, code: string): void {
      expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
    }

    /** A card drafted and activated on the moved rate-card clock. */
    async function activeCard(clientId: string, lines: { chargeCode: string; basis: string; amountPaise: number }[], effectiveFrom: string, clockAt: string): Promise<string> {
      rateCardClock.now = () => ist(clockAt);
      const drafted = await http()
        .post(`${API}/${tenantId}/clients/${clientId}/rate-cards`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .set(KEY_HEADER, ulid())
        .send({ lines })
        .expect(201);
      const id = drafted.body.rateCard.id as string;
      await http()
        .post(`${API}/${tenantId}/rate-cards/${id}/activate`)
        .set('Authorization', `Bearer ${accountantToken}`)
        .set(KEY_HEADER, ulid())
        .send({ effectiveFrom })
        .expect(200);
      return id;
    }

    const OCT_1 = ist('2026-10-01T00:30');

    beforeAll(async () => {
      suiteDb = await useSuiteDatabase('metering');
      app = await createApp(false);
      await app.init();
      db = app.get<Database>(DATABASE);
      inventory = app.get(InventoryFacade);
      billing = app.get(BillingFacade);
      sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });

      const owner = await register(`Metering Co ${ulid()}`);
      tenantId = owner.tenantId;
      ownerToken = owner.ownerToken;
      actorId = owner.userId;
      accountantToken = await invite('accountant');
      opsToken = await invite('ops_manager');

      const w1 = await createWarehouse(`M1-${ulid().slice(20)}`);
      const w2 = await createWarehouse(`M2-${ulid().slice(20)}`);
      wh1 = w1.warehouseId;
      wh2 = w2.warehouseId;
      binA = await createBin(wh1, w1.zoneId, 'A-01-01');
      binB = await createBin(wh1, w1.zoneId, 'A-01-02');
      binC = await createBin(wh2, w2.zoneId, 'B-01-01');

      const listed = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      selfId = (listed.body.items as { id: string; systemOwned: boolean }[]).find((row) => row.systemOwned)!.id;
      for (const code of ['ACME', 'BETA', 'GAMMA', 'DELTA', 'EPS', 'ZETA']) {
        clients.set(
          code,
          (
            await http()
              .post(`${API}/${tenantId}/clients`)
              .set('Authorization', `Bearer ${ownerToken}`)
              .set(KEY_HEADER, ulid())
              .send({ code, name: `${code} Brand` })
              .expect(201)
          ).body.client.id as string,
        );
      }
      await importSkus(client('ACME'), ['ACME-KG,Acme rice,kg,1800,,,', 'ACME-PC,Acme box,each,1800,,,']);
      for (const code of ['BETA', 'GAMMA', 'DELTA', 'EPS', 'ZETA']) await importSkus(client(code), [`${code}-PC,${code} item,each,1800,,,`]);
      await importSkus(selfId, ['SELF-PC,Own item,each,1800,,,']);
      const skuList = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      for (const item of skuList.body.items as { code: string; id: string }[]) skus.set(item.code, item.id);

      // ── ACME: received on the 10th, picked on the 18th, dispatched on the
      // 20th (the AC), with a relocation, a QC hold and release, and a bin
      // merge in between — none of which moves on-hand.
      await append({ warehouseId: wh1, type: 'grn.received', skuId: sku('ACME-KG'), quantityDelta: 120_000, toBinId: binA, recordedAt: istIso('2026-09-10T10:00') });
      await append({ warehouseId: wh1, type: 'grn.received', skuId: sku('ACME-PC'), quantityDelta: 300_000, toBinId: binA, recordedAt: istIso('2026-09-10T10:00') });
      await append({ warehouseId: wh1, type: 'putaway.placed', skuId: sku('ACME-KG'), quantityDelta: 120_000, fromBinId: binA, toBinId: binB, recordedAt: istIso('2026-09-12T11:00') });
      await append({ warehouseId: wh1, type: 'qc.held', skuId: sku('ACME-PC'), quantityDelta: 300_000, fromBinId: binA, toBinId: binB, recordedAt: istIso('2026-09-13T11:00') });
      await append({ warehouseId: wh1, type: 'qc.released', skuId: sku('ACME-PC'), quantityDelta: 300_000, fromBinId: binB, toBinId: binA, recordedAt: istIso('2026-09-14T11:00') });
      await append({ warehouseId: wh1, type: 'bin.merged', skuId: sku('ACME-KG'), quantityDelta: 120_000, fromBinId: binB, toBinId: binA, recordedAt: istIso('2026-09-16T11:00') });
      await append({ warehouseId: wh1, type: 'pick.picked', skuId: sku('ACME-KG'), quantityDelta: -120_000, fromBinId: binA, recordedAt: istIso('2026-09-18T10:00') });
      await append({ warehouseId: wh1, type: 'pick.picked', skuId: sku('ACME-PC'), quantityDelta: -300_000, fromBinId: binA, recordedAt: istIso('2026-09-18T10:00') });
      const orderId = uuidv7();
      await append({ warehouseId: wh1, type: 'pack.packed', skuId: sku('ACME-KG'), quantityDelta: 0, recordedAt: istIso('2026-09-19T10:00'), referenceDoc: { kind: 'pack', orderId } });
      // One dispatch event per order LINE — one order.
      await append({ warehouseId: wh1, type: 'dispatch.dispatched', skuId: sku('ACME-KG'), quantityDelta: 0, recordedAt: istIso('2026-09-20T10:00'), referenceDoc: { kind: 'dispatch', orderId } });
      await append({ warehouseId: wh1, type: 'dispatch.dispatched', skuId: sku('ACME-PC'), quantityDelta: 0, recordedAt: istIso('2026-09-20T10:00'), referenceDoc: { kind: 'dispatch', orderId } });
      // The handling facts: the GRN of the 10th (two lines), the picks of the
      // 18th, and — straddling the card boundary at 09-15 — a GRN a
      // millisecond before IST midnight and one exactly at it; plus one in
      // August, before any card.
      await seedGrn(wh1, istIso('2026-09-10T10:00'), [sku('ACME-KG'), sku('ACME-PC')]);
      await seedGrn(wh1, istIso('2026-09-14T23:59:59.999'), [sku('ACME-PC')]);
      await seedGrn(wh1, istIso('2026-09-15T00:00'), [sku('ACME-PC')]);
      await seedGrn(wh1, istIso('2026-08-28T12:00'), [sku('ACME-PC')]);
      await seedPick(wh1, sku('ACME-KG'), binA, istIso('2026-09-18T10:00'));
      await seedPick(wh1, sku('ACME-PC'), binA, istIso('2026-09-18T10:00'));
      // An ACME order whose lines dispatch either side of the card boundary
      // (23:00 on the 14th, 01:00 on the 15th) — counted ONCE, by its first
      // dispatch, under card A. And an ACME order only PACKED — never counted.
      const straddleId = uuidv7();
      await append({ warehouseId: wh1, type: 'dispatch.dispatched', skuId: sku('ACME-KG'), quantityDelta: 0, recordedAt: istIso('2026-09-14T23:00'), referenceDoc: { kind: 'dispatch', orderId: straddleId } });
      await append({ warehouseId: wh1, type: 'dispatch.dispatched', skuId: sku('ACME-PC'), quantityDelta: 0, recordedAt: istIso('2026-09-15T01:00'), referenceDoc: { kind: 'dispatch', orderId: straddleId } });
      await append({ warehouseId: wh1, type: 'pack.packed', skuId: sku('ACME-PC'), quantityDelta: 0, recordedAt: istIso('2026-09-21T10:00'), referenceDoc: { kind: 'pack', orderId: uuidv7() } });
      // Other clients' handling in the same window: a BETA dispatched order
      // (its own orderId) and a BETA pick; the tenant's own pick. None is ACME's.
      await append({ warehouseId: wh1, type: 'dispatch.dispatched', skuId: sku('BETA-PC'), quantityDelta: 0, recordedAt: istIso('2026-09-20T10:00'), referenceDoc: { kind: 'dispatch', orderId: uuidv7() } });
      await seedPick(wh1, sku('BETA-PC'), binA, istIso('2026-09-18T10:00'));
      await seedPick(wh1, sku('SELF-PC'), binA, istIso('2026-09-18T10:00'));

      // ── EPS: a cross-warehouse transfer across midnight — the outbound leg
      // (a relocation into the in-transit bin) on the 6th, the inbound leg
      // (a draw on the source chain + an intake on the destination chain,
      // ONE stamp) just after midnight on the 7th.
      await append({ warehouseId: wh1, type: 'stock.adjusted', skuId: sku('EPS-PC'), quantityDelta: 9_000, toBinId: binA, recordedAt: istIso('2026-09-05T10:00') });
      await append({ warehouseId: wh1, type: 'transfer.outbound', skuId: sku('EPS-PC'), quantityDelta: 9_000, fromBinId: binA, toBinId: binB, recordedAt: istIso('2026-09-06T23:00') });
      const crossStamp = istIso('2026-09-07T00:30');
      await append({ warehouseId: wh1, type: 'transfer.inbound', skuId: sku('EPS-PC'), quantityDelta: -9_000, fromBinId: binB, recordedAt: crossStamp });
      await append({ warehouseId: wh2, type: 'transfer.inbound', skuId: sku('EPS-PC'), quantityDelta: 9_000, toBinId: binC, recordedAt: crossStamp });

      // ── self: the tenant's own goods move too — never snapshotted.
      await append({ warehouseId: wh1, type: 'stock.adjusted', skuId: sku('SELF-PC'), quantityDelta: 50_000, toBinId: binA, recordedAt: istIso('2026-09-10T10:00') });
      await seedGrn(wh1, istIso('2026-09-10T10:00'), [sku('SELF-PC')]);

      // ── ACME's cards: A from 09-01 (activated that day — a first card may
      // start today), B from 09-15 (activated on the 5th — a replacement
      // starts tomorrow at the earliest). B prices no outbound_handling.
      cardA = await activeCard(
        client('ACME'),
        [
          { chargeCode: 'storage', basis: 'per_thousand_units_per_day', amountPaise: 330 },
          { chargeCode: 'inbound_handling', basis: 'per_receipt_line', amountPaise: 500 },
          { chargeCode: 'pick', basis: 'per_pick', amountPaise: 300 },
          { chargeCode: 'outbound_handling', basis: 'per_order', amountPaise: 2000 },
        ],
        '2026-09-01',
        '2026-09-01T09:00',
      );
      cardB = await activeCard(
        client('ACME'),
        [
          { chargeCode: 'storage', basis: 'per_thousand_units_per_day', amountPaise: 400 },
          { chargeCode: 'inbound_handling', basis: 'per_receipt_line', amountPaise: 600 },
          { chargeCode: 'pick', basis: 'per_pick', amountPaise: 350 },
        ],
        '2026-09-15',
        '2026-09-05T09:00',
      );
      rateCardClock.now = realRateCardNow;

      const foreign = await register(`Foreign Co ${ulid()}`);
      const foreignClients = await http().get(`${API}/${foreign.tenantId}/clients`).set('Authorization', `Bearer ${foreign.ownerToken}`).expect(200);
      other = { tenantId: foreign.tenantId, ownerToken: foreign.ownerToken, clientId: foreignClients.body.items[0].id as string };
    }, 180_000);

    afterAll(async () => {
      rateCardClock.now = realRateCardNow;
      await sql?.end();
      const rawDb = app?.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
      await rawDb?.$client?.end();
      const authDb = app?.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
      await authDb?.$client?.end();
      await app?.close();
      await suiteDb?.drop();
    });

    // ── the fold ──────────────────────────────────────────────────────────
    describe('the fold rule — every registered event type', () => {
      /**
       * The arm shapes each registered type is actually written with (the
       * registry's docs and the commands), and what the fold must count for
       * each: destination-only +|δ|, source-only −|δ|, anything else 0. A
       * type registered later without a row here fails the first assertion
       * — its arm shape must be classified before metering can be trusted.
       */
      const SHAPES: Record<string, readonly ('to' | 'from' | 'both' | 'none')[]> = {
        'stock.adjusted': ['to', 'from'],
        'grn.received': ['to'],
        'qc.held': ['both'],
        'qc.released': ['both'],
        'putaway.placed': ['both'],
        'bin.merged': ['both'],
        'pick.picked': ['from'],
        'pack.packed': ['none'],
        'dispatch.dispatched': ['none'],
        'excursion.recorded': ['none'],
        'transfer.outbound': ['both'],
        // same-warehouse relocation; cross-warehouse source draw; destination intake
        'transfer.inbound': ['both', 'from', 'to'],
      };

      it('every registered type is classified, and each arm folds as the replay rule says', async () => {
        expect(Object.keys(SHAPES).sort()).toEqual([...registeredLedgerEventTypes()].sort());
        const beta = sku('BETA-PC');
        // A seed so every draw has stock behind it.
        await append({ warehouseId: wh1, type: 'stock.adjusted', skuId: beta, quantityDelta: 100_000, toBinId: binA, recordedAt: istIso('2026-08-01T10:00') });
        const expected = new Map<string, bigint>([['2026-08-01', 100_000n]]);
        let day = 2;
        for (const [type, shapes] of Object.entries(SHAPES)) {
          for (const shape of shapes) {
            const date = `2026-08-${String(day).padStart(2, '0')}`;
            day += 1;
            const moves = shape !== 'none';
            await append({
              warehouseId: wh1,
              type,
              skuId: beta,
              quantityDelta: !moves ? 0 : shape === 'from' ? -1_000 : 1_000,
              fromBinId: shape === 'from' || shape === 'both' ? binA : null,
              toBinId: shape === 'to' ? binA : shape === 'both' ? binB : null,
              recordedAt: istIso(`${date}T10:00`),
            });
            expected.set(date, shape === 'to' ? 1_000n : shape === 'from' ? -1_000n : 0n);
          }
        }
        const deltas = await withTenantTransaction(db, tenantId, (tx) =>
          inventory.clientOnHandFoldByDayInTx(tx, { tenantId, clientId: client('BETA'), warehouseId: wh1 }, null, istIso('2026-09-01T00:00')),
        );
        const byDay = new Map(deltas.map((delta) => [delta.day, delta.deltaMilli]));
        for (const [date, want] of expected) {
          expect(`${date}: ${String(byDay.get(date) ?? 0n)}`).toBe(`${date}: ${String(want)}`);
        }
        expect(deltas.every((delta) => delta.uom === 'each')).toBe(true);
        // The fold over the whole history equals the live projection (the
        // replay rule IS the projection's rule).
        const total = deltas.reduce((sum, delta) => sum + delta.deltaMilli, 0n);
        const projected = await sql<{ n: string }[]>`
          select coalesce(sum(quantity), 0)::text as n from stock_on_hand
          where tenant_id = ${tenantId} and warehouse_id = ${wh1} and sku_id = ${beta}`;
        expect(total.toString()).toBe(projected[0]!.n);
      });

      it('the fold is bounded by the instant: [from, to) on recorded_at, bucketed by IST day', async () => {
        const deltas = await withTenantTransaction(db, tenantId, (tx) =>
          inventory.clientOnHandFoldByDayInTx(
            tx,
            { tenantId, clientId: client('ACME'), warehouseId: wh1 },
            istIso('2026-09-10T00:00'),
            istIso('2026-09-11T00:00'),
          ),
        );
        expect(deltas.map((delta) => [delta.day, delta.uom, delta.deltaMilli.toString()])).toEqual([
          ['2026-09-10', 'each', '300000'],
          ['2026-09-10', 'kg', '120000'],
        ]);
      });
    });

    // ── the snapshots ─────────────────────────────────────────────────────
    describe('daily storage snapshots', () => {
      it('grace: a tick at 00:05 IST does not write the day that just ended (and creates nothing)', async () => {
        const result = await billing.snapshotScope(tenantId, client('ACME'), wh1, ist('2026-09-11T00:05'));
        expect(result).toMatchObject({ daysWritten: 0, rowsWritten: 0, waiting: 'grace' });
        expect(await storedRows(client('ACME'))).toEqual([]);
        expect(await progress(client('ACME'), wh1)).toBeUndefined();
      });

      it('daily snapshot: past the grace, the 10th is written per base UoM — (ACME, WH1, D, kg, 120000) and (…, each, 300000)', async () => {
        // Nothing that began before the 10th ended is open: one call writes it.
        const result = await billing.snapshotScope(tenantId, client('ACME'), wh1, ist('2026-09-11T00:20'));
        expect(result).toMatchObject({ lastDay: '2026-09-10', daysWritten: 1, rowsWritten: 2, drift: [], waiting: null, driftChecked: true });
        expect((await storedRows(client('ACME'))).map(({ day, uom, milli }) => [day, uom, milli])).toEqual([
          ['2026-09-10', 'each', '300000'],
          ['2026-09-10', 'kg', '120000'],
        ]);
      });

      it('received 10th, picked 18th, dispatched 20th: stored the 10th through the 17th; zero days have no row and the watermark still advances', async () => {
        const result = await settle(client('ACME'), wh1, OCT_1);
        expect(result).toMatchObject({ lastDay: '2026-09-30', daysWritten: 20, drift: [], waiting: null });
        const rows = await storedRows(client('ACME'));
        const days = [...new Set(rows.map((row) => row.day))];
        expect(days).toEqual(['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']);
        // The relocation (12th), the QC hold and release (13th, 14th) and the
        // bin merge (16th) leave on-hand exactly where it was.
        expect(rows.every((row) => (row.uom === 'kg' ? row.milli === '120000' : row.uom === 'each' && row.milli === '300000'))).toBe(true);
        expect(rows).toHaveLength(16);
        expect(await progress(client('ACME'), wh1)).toMatchObject({ last_day: '2026-09-30', drift_checked_on: '2026-10-01' });
      });

      it('re-run: the same rows, nothing written twice, the watermark unmoved', async () => {
        const before = await storedRows(client('ACME'));
        const again = await billing.snapshotScope(tenantId, client('ACME'), wh1, OCT_1);
        expect(again).toMatchObject({ lastDay: '2026-09-30', daysWritten: 0, rowsWritten: 0, drift: [] });
        expect(await storedRows(client('ACME'))).toEqual(before);
      });

      it('a crash mid-tick rolls back whole: nothing persists, and the next tick writes exactly the same rows', async () => {
        const scope = { clientId: client('EPS'), warehouseId: wh1 };
        const service = (billing as unknown as { snapshots: { snapshotScopeInTx: (...args: unknown[]) => Promise<unknown> } }).snapshots;
        await expect(
          withTenantTransaction(db, tenantId, async (tx) => {
            await service.snapshotScopeInTx(tx, tenantId, scope.clientId, scope.warehouseId, OCT_1);
            throw new Error('simulated crash after the writes');
          }),
        ).rejects.toThrow(/simulated crash/);
        expect(await storedRows(scope.clientId, scope.warehouseId)).toEqual([]);
        expect(await progress(scope.clientId, scope.warehouseId)).toBeUndefined();
      });

      it('cross-warehouse transfer across midnight: the source holds it at the end of the 6th, the destination from the 7th', async () => {
        await settle(client('EPS'), wh1, OCT_1);
        await settle(client('EPS'), wh2, OCT_1);
        expect((await storedRows(client('EPS'), wh1)).map(({ day, milli }) => [day, milli])).toEqual([
          ['2026-09-05', '9000'],
          ['2026-09-06', '9000'],
        ]);
        const dest = await storedRows(client('EPS'), wh2);
        expect(dest[0]).toMatchObject({ day: '2026-09-07', milli: '9000' });
        expect(dest.at(-1)).toMatchObject({ day: '2026-09-30', milli: '9000' });
        expect(dest).toHaveLength(24);
      });

      it('two instances at once: the scope lock serialises them — one set of rows, one watermark', async () => {
        await append({ warehouseId: wh1, type: 'stock.adjusted', skuId: sku('DELTA-PC'), quantityDelta: 4_000, toBinId: binA, recordedAt: istIso('2026-09-20T10:00') });
        // Twice, two instances at once: one of the first pair writes, every
        // other call finds the watermark already there.
        let written = 0;
        for (let round = 0; round < 2; round += 1) {
          const [first, second] = await Promise.all([
            billing.snapshotScope(tenantId, client('DELTA'), wh1, OCT_1),
            billing.snapshotScope(tenantId, client('DELTA'), wh1, OCT_1),
          ]);
          written += first!.rowsWritten + second!.rowsWritten;
        }
        expect(written).toBe(11); // 09-20 … 09-30, once
        const rows = await storedRows(client('DELTA'), wh1);
        expect(rows).toHaveLength(11);
        expect(rows.every((row) => row.milli === '4000')).toBe(true);
        expect(await progress(client('DELTA'), wh1)).toMatchObject({ last_day: '2026-09-30' });
      });

      it('the watermark never moves back (GREATEST): a tick behind a later watermark changes nothing', async () => {
        // (The drift check then finds no rows behind the forged watermark —
        // its error log is expected here.)
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        await sql`update storage_snapshot_progress set last_day = '2026-12-31'
          where tenant_id = ${tenantId} and client_id = ${client('EPS')} and warehouse_id = ${wh2}`;
        const before = await storedRows(client('EPS'), wh2);
        const result = await billing.snapshotScope(tenantId, client('EPS'), wh2, OCT_1);
        expect(result).toMatchObject({ daysWritten: 0, rowsWritten: 0 });
        expect(await progress(client('EPS'), wh2)).toMatchObject({ last_day: '2026-12-31' });
        expect(await storedRows(client('EPS'), wh2)).toEqual(before);
        await sql`update storage_snapshot_progress set last_day = '2026-09-30'
          where tenant_id = ${tenantId} and client_id = ${client('EPS')} and warehouse_id = ${wh2}`;
      });

      /**
       * The guarantee reads REAL session start times (`pg_stat_activity`), so
       * these tests run on today's IST date: the "midnight" `T` is the one
       * that ends today, and the job's clock is `T + 20 min` — while the held
       * transaction really did begin before `T`.
       */
      function realDays(): { today: string; yesterday: string; dayBefore: string; afterTonight: number } {
        const today = istDateOf(new Date().toISOString());
        return {
          today,
          yesterday: addIsoDays(today, -1),
          dayBefore: addIsoDays(today, -2),
          afterTonight: Date.parse(istMidnightOf(addIsoDays(today, 1))) + 20 * 60_000,
        };
      }

      type HeldTx = Parameters<Parameters<typeof withTenantTransaction>[2]>[0];

      /** A transaction on the app's pool, held open in steps the test releases one by one. */
      function holdOpen(steps: ((tx: HeldTx) => Promise<void>)[]) {
        const releases: (() => void)[] = [];
        const gates = steps.map(() => new Promise<void>((resolveGate) => releases.push(resolveGate)));
        const signals: (() => void)[] = [];
        const reached = steps.map(() => new Promise<void>((resolveReached) => signals.push(resolveReached)));
        const done = withTenantTransaction(db, tenantId, async (tx) => {
          for (let i = 0; i < steps.length; i += 1) {
            await steps[i]!(tx);
            signals[i]!();
            await gates[i];
          }
        });
        return { reached, releases, done };
      }

      it('the commit guarantee (pg_stat_activity): an open transaction that began before T holds the day back — before it has an xid AND after — and once it commits the day includes its event', async () => {
        const { today, yesterday, dayBefore, afterTonight } = realDays();
        const gamma = sku('GAMMA-PC');
        await append({ warehouseId: wh2, type: 'stock.adjusted', skuId: gamma, quantityDelta: 5_000, toBinId: binC, recordedAt: istIso(`${dayBefore}T10:00`) });
        const held = holdOpen([
          // 1. begun, nothing written — no xid yet (the xid proof's blind spot)
          async (tx) => {
            await tx.execute(dsql`select 1`);
          },
          // 2. it stamps and appends an event today (now it holds an xid)
          async (tx) => {
            await inventory.appendLedgerEventInTx(tx, {
              tenantId,
              warehouseId: wh2,
              type: 'stock.adjusted',
              skuId: gamma,
              quantityDelta: 7_000 as SignedQuantity,
              fromBinId: null,
              toBinId: binC,
              batchRef: null,
              serialRef: null,
              actorUserId: actorId,
              occurredAt: new Date().toISOString(),
              recordedAt: new Date().toISOString(),
              referenceDoc: { kind: 'manual-adjustment', reasonCode: 'stock-count', note: 'held open' } as never,
            });
          },
        ]);
        try {
          await held.reached[0];
          // The days that ended before it began are written; today is held back.
          const noXid = await billing.snapshotScope(tenantId, client('GAMMA'), wh2, afterTonight);
          expect(noXid).toMatchObject({ lastDay: yesterday, daysWritten: 2, waiting: 'commit-guarantee' });
          expect((await storedRows(client('GAMMA'))).map(({ day, milli }) => [day, milli])).toEqual([
            [dayBefore, '5000'],
            [yesterday, '5000'],
          ]);
          held.releases[0]!();
          await held.reached[1];
          const withXid = await billing.snapshotScope(tenantId, client('GAMMA'), wh2, afterTonight);
          expect(withXid).toMatchObject({ lastDay: yesterday, daysWritten: 0, waiting: 'commit-guarantee' });
        } finally {
          held.releases.forEach((release) => release());
          await held.done;
        }
        const written = await billing.snapshotScope(tenantId, client('GAMMA'), wh2, afterTonight);
        expect(written).toMatchObject({ lastDay: today, daysWritten: 1, waiting: null });
        expect((await storedRows(client('GAMMA'))).at(-1)).toMatchObject({ day: today, milli: '12000' });
      });

      it('the first watermark is born only under the guarantee: an event stamped before the scope’s first visible event, committing later, still gets its days', async () => {
        const { today, yesterday, afterTonight } = realDays();
        const zeta = sku('ZETA-PC');
        const held = holdOpen([
          async (tx) => {
            await tx.execute(dsql`select 1`);
          },
          async (tx) => {
            // Stamped YESTERDAY — earlier than the event the job sees first.
            // (A real stamp is never earlier than its transaction's start; this
            // one stands in for a transaction that spanned midnight.)
            await inventory.appendLedgerEventInTx(tx, {
              tenantId,
              warehouseId: wh1,
              type: 'stock.adjusted',
              skuId: zeta,
              quantityDelta: 2_000 as SignedQuantity,
              fromBinId: null,
              toBinId: binA,
              batchRef: null,
              serialRef: null,
              actorUserId: actorId,
              occurredAt: istIso(`${yesterday}T10:00`),
              recordedAt: istIso(`${yesterday}T10:00`),
              referenceDoc: { kind: 'manual-adjustment', reasonCode: 'stock-count', note: 'late, earlier stamp' } as never,
            });
          },
        ]);
        try {
          await held.reached[0];
          // The first VISIBLE event: today.
          await append({ warehouseId: wh1, type: 'stock.adjusted', skuId: zeta, quantityDelta: 3_000, toBinId: binA, recordedAt: new Date().toISOString() });
          const blocked = await billing.snapshotScope(tenantId, client('ZETA'), wh1, afterTonight);
          expect(blocked).toMatchObject({ lastDay: null, daysWritten: 0, waiting: 'commit-guarantee' });
          // Nothing persisted — no watermark born from the event visible now.
          expect(await progress(client('ZETA'), wh1)).toBeUndefined();
          held.releases[0]!();
          await held.reached[1];
        } finally {
          held.releases.forEach((release) => release());
          await held.done;
        }
        const written = await billing.snapshotScope(tenantId, client('ZETA'), wh1, afterTonight);
        expect(written).toMatchObject({ lastDay: today, daysWritten: 2, waiting: null, drift: [] });
        expect((await storedRows(client('ZETA'))).map(({ day, milli }) => [day, milli])).toEqual([
          [yesterday, '2000'],
          [today, '5000'],
        ]);
      });

      it('a role that cannot see other sessions refuses to write (and logs) — it never guesses', async () => {
        const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const service = (billing as unknown as { snapshots: { openSessionsInTx: unknown } }).snapshots;
        const original = service.openSessionsInTx;
        service.openSessionsInTx = async () => ({ oldestXactStart: null, hidden: true, hiddenCount: 3 });
        try {
          const before = await storedRows(client('ACME'));
          // ACME is through 09-30; the 1st of October is closable at 00:30 on the 2nd.
          const refused = await billing.snapshotScope(tenantId, client('ACME'), wh1, ist('2026-10-02T00:30'));
          expect(refused).toMatchObject({ lastDay: '2026-09-30', daysWritten: 0, rowsWritten: 0, waiting: 'session-visibility' });
          expect(await storedRows(client('ACME'))).toEqual(before);
          expect(await progress(client('ACME'), wh1)).toMatchObject({ last_day: '2026-09-30' });
          expect(errors.mock.calls.some(([message]) => String(message).includes('STORAGE SNAPSHOT REFUSED'))).toBe(true);
        } finally {
          service.openSessionsInTx = original;
        }
      });

      it('the probe itself: this (superuser) role sees every session, and an idle pool holds no transaction', async () => {
        const service = (billing as unknown as { snapshots: { openSessionsInTx: (tx: HeldTx) => Promise<{ hidden: boolean; oldestXactStart: string | null }> } }).snapshots;
        const probe = await withTenantTransaction(db, tenantId, (tx) => service.openSessionsInTx(tx));
        expect(probe.hidden).toBe(false);
        expect(probe.oldestXactStart).toBeNull();
      });

      it('the drift check: an event committed after its day was written is reported (logged as an error), verify finds it, and a rebuild repairs it', async () => {
        const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        // Late: stamped the 27th, committed after the 27th was written —
        // exactly what the guarantee forbids, forced here by direct append.
        await append({ warehouseId: wh1, type: 'stock.adjusted', skuId: sku('DELTA-PC'), quantityDelta: 1_000, toBinId: binA, recordedAt: istIso('2026-09-27T10:00') });
        // The cadence: the check already ran on the 1st (the watermark
        // advanced then) — another tick the same IST day does not re-run it.
        const sameDay = await billing.snapshotScope(tenantId, client('DELTA'), wh1, OCT_1);
        expect(sameDay).toMatchObject({ driftChecked: false, drift: [] });
        // The next IST day it runs (00:05 on the 2nd — still inside the grace).
        const result = await billing.snapshotScope(tenantId, client('DELTA'), wh1, ist('2026-10-02T00:05'));
        expect(result).toMatchObject({ driftChecked: true, waiting: 'grace' });
        expect(result.drift.map((entry) => [entry.kind, entry.day, entry.stored, entry.refolded])).toEqual([
          ['row', '2026-09-27', '4000', '5000'],
          ['row', '2026-09-28', '4000', '5000'],
          ['row', '2026-09-29', '4000', '5000'],
          ['row', '2026-09-30', '4000', '5000'],
          // …and the genesis-sum check: the running total the next day would
          // be folded from is wrong too.
          ['running', '2026-09-30', '4000', '5000'],
        ]);
        expect(errors.mock.calls.some(([message]) => String(message).includes('STORAGE SNAPSHOT DRIFT'))).toBe(true);
        // The job never rewrites: the rows still hold the old value.
        expect((await storedRows(client('DELTA'), wh1)).find((row) => row.day === '2026-09-28')?.milli).toBe('4000');

        const verify = await billing.verifySnapshots(tenantId, client('DELTA'), wh1);
        expect(verify).toMatchObject({ lastDay: '2026-09-30', expectedRows: 11, storedRows: 11 });
        expect(verify.drift).toHaveLength(5);
        const rebuilt = await billing.rebuildSnapshots(tenantId, client('DELTA'), wh1);
        expect(rebuilt.drift).toHaveLength(5); // the rebuild reports what it found
        expect((await billing.verifySnapshots(tenantId, client('DELTA'), wh1)).drift).toEqual([]);
        expect((await storedRows(client('DELTA'), wh1)).find((row) => row.day === '2026-09-28')?.milli).toBe('5000');
        expect(await progress(client('DELTA'), wh1)).toMatchObject({ last_day: '2026-09-30' });
        // The running total was reset too: the next tick closes the 1st of
        // October from the REBUILT total.
        const next = await billing.snapshotScope(tenantId, client('DELTA'), wh1, ist('2026-10-02T00:30'));
        expect(next).toMatchObject({ lastDay: '2026-10-01', daysWritten: 1, drift: [] });
        expect((await storedRows(client('DELTA'), wh1)).at(-1)).toMatchObject({ day: '2026-10-01', milli: '5000' });
      });

      it('rebuild (dry run, then write): the re-fold from genesis reproduces the same (scope, day, uom, on_hand_milli) set', async () => {
        const before = await storedRows(client('ACME'));
        const verify = await billing.verifySnapshots(tenantId, client('ACME'), wh1);
        expect(verify).toMatchObject({ lastDay: '2026-09-30', expectedRows: 16, storedRows: 16, drift: [] });
        expect(await storedRows(client('ACME'))).toEqual(before); // the dry run wrote nothing
        await billing.rebuildSnapshots(tenantId, client('ACME'), wh1);
        expect(await storedRows(client('ACME'))).toEqual(before); // set equality on key + value
      });

      it('self is never snapshotted: every entry point refuses the tenant’s own client', async () => {
        await expect(billing.snapshotScope(tenantId, selfId, wh1, OCT_1)).rejects.toThrow(/self client .* is never snapshotted/);
        await expect(billing.verifySnapshots(tenantId, selfId, wh1)).rejects.toThrow(/never snapshotted/);
        await expect(billing.rebuildSnapshots(tenantId, selfId, wh1)).rejects.toThrow(/never snapshotted/);
        expect(await storedRows(selfId)).toEqual([]);
      });
    });

    // ── the worker ────────────────────────────────────────────────────────
    describe('the worker', () => {
      it('tick(): every client brand with events × warehouse, never self; idempotent across ticks', async () => {
        const worker = new StorageSnapshotWorker(app.get(AUTH_DATABASE) as never, billing);
        const first = await worker.tick(OCT_1);
        // ACME/WH1, BETA/WH1, DELTA/WH1, EPS/WH1, EPS/WH2, GAMMA/WH2, ZETA/WH1 — self has events but no scope.
        expect(first).toEqual({ carried: 7, total: 7 });
        expect((await billing.snapshotScopesOf(tenantId)).map((scope) => scope.clientId)).not.toContain(selfId);
        expect(await progress(selfId, wh1)).toBeUndefined();
        // The backfill pace: BETA's history starts 08-01 — 31 days per call,
        // so one tick reaches 08-31 and the next 09-30.
        expect(await progress(client('BETA'), wh1)).toMatchObject({ last_day: '2026-08-31' });
        await worker.tick(OCT_1);
        expect(await progress(client('BETA'), wh1)).toMatchObject({ last_day: '2026-09-30' });
        expect((await billing.verifySnapshots(tenantId, client('BETA'), wh1)).drift).toEqual([]);
        const counted = await sql<{ n: number }[]>`select count(*)::int as n from storage_snapshots where tenant_id = ${tenantId}`;
        await worker.tick(OCT_1);
        const recounted = await sql<{ n: number }[]>`select count(*)::int as n from storage_snapshots where tenant_id = ${tenantId}`;
        expect(recounted[0]!.n).toBe(counted[0]!.n);
        // A tenant with no client brand runs no snapshot work.
        expect(await billing.snapshotScopesOf(other.tenantId)).toEqual([]);
      });

      it('two worker instances ticking at once: same rows, no error', async () => {
        const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const counted = await sql<{ n: number }[]>`select count(*)::int as n from storage_snapshots where tenant_id = ${tenantId}`;
        const one = new StorageSnapshotWorker(app.get(AUTH_DATABASE) as never, billing);
        const two = new StorageSnapshotWorker(app.get(AUTH_DATABASE) as never, billing);
        await Promise.all([one.tick(OCT_1), two.tick(OCT_1)]);
        const recounted = await sql<{ n: number }[]>`select count(*)::int as n from storage_snapshots where tenant_id = ${tenantId}`;
        expect(recounted[0]!.n).toBe(counted[0]!.n);
        expect(errors).not.toHaveBeenCalled();
      });

      it('the rotating window: past the per-tick cap each tick starts where the last stopped, and a failing scope never stops the rest', async () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const total = MAX_STORAGE_SNAPSHOT_SCOPES_PER_TICK + 50;
        const fakeScopes = Array.from({ length: total }, (_, i) => ({ tenantId, clientId: `client-${i}`, warehouseId: wh1 }));
        const calls: string[] = [];
        const fake = {
          snapshotScopesOf: async (t: string) => {
            if (t === other.tenantId) throw new Error('a poison tenant');
            return t === tenantId ? fakeScopes : [];
          },
          snapshotScope: async (_t: string, clientId: string) => {
            calls.push(clientId);
            if (clientId === 'client-0') throw new Error('a poison scope');
            return undefined;
          },
        };
        const worker = new StorageSnapshotWorker(app.get(AUTH_DATABASE) as never, fake as never);
        expect(await worker.tick(OCT_1)).toEqual({ carried: MAX_STORAGE_SNAPSHOT_SCOPES_PER_TICK, total });
        expect(calls).toHaveLength(MAX_STORAGE_SNAPSHOT_SCOPES_PER_TICK);
        expect(calls[0]).toBe('client-0');
        expect(calls.at(-1)).toBe(`client-${MAX_STORAGE_SNAPSHOT_SCOPES_PER_TICK - 1}`);
        calls.length = 0;
        await worker.tick(OCT_1);
        // The next tick starts where this one stopped (an advance by the
        // number carried, not by one) and wraps: every scope within two ticks.
        expect(calls[0]).toBe(`client-${MAX_STORAGE_SNAPSHOT_SCOPES_PER_TICK}`);
        expect(calls.at(-1)).toBe(`client-${2 * MAX_STORAGE_SNAPSHOT_SCOPES_PER_TICK - total - 1}`);
        expect(new Set(calls).has('client-249')).toBe(true);
      });
    });

    // ── metering ──────────────────────────────────────────────────────────
    describe('the metering read', () => {
      it('AC: September for ACME — storage per base UoM 10th–17th, priced by the card in force at the start of each day; counts split at the same IST midnight; BigInt amounts', async () => {
        const res = await usage(client('ACME'), '2026-09-01', '2026-09-30').expect(200);
        expect(res.body).toMatchObject({ clientId: client('ACME'), from: '2026-09-01', to: '2026-09-30', storageCompleteThrough: '2026-09-30' });
        expect(res.body.segments).toEqual([
          {
            rateCardId: cardA,
            fromDate: '2026-09-01',
            toDate: '2026-09-14',
            storageMeasuredThrough: '2026-09-14',
            lines: [
              // 10th–14th: 5 days × 300 each = 1,500 each-days → 1,500,000 × 330 ÷ 10⁶ = 495
              { chargeCode: 'storage', basis: 'per_thousand_units_per_day', uom: 'each', quantity: '1500', ratePaise: 330, amountPaise: 495 },
              // 5 days × 120 kg = 600 kg-days → 600,000 × 330 ÷ 10⁶ = 198
              { chargeCode: 'storage', basis: 'per_thousand_units_per_day', uom: 'kg', quantity: '600', ratePaise: 330, amountPaise: 198 },
              // the 10th's GRN (two lines) + the one a millisecond before midnight
              { chargeCode: 'inbound_handling', basis: 'per_receipt_line', uom: null, quantity: '3', ratePaise: 500, amountPaise: 1500 },
              { chargeCode: 'pick', basis: 'per_pick', uom: null, quantity: '0', ratePaise: 300, amountPaise: 0 },
              // the straddling order: first dispatched at 23:00 on the 14th — card A, once
              { chargeCode: 'outbound_handling', basis: 'per_order', uom: null, quantity: '1', ratePaise: 2000, amountPaise: 2000 },
            ],
          },
          {
            rateCardId: cardB,
            fromDate: '2026-09-15',
            toDate: '2026-09-30',
            storageMeasuredThrough: '2026-09-30',
            lines: [
              // 15th–17th: 3 days; picked on the 18th — storage ends at the pick
              { chargeCode: 'storage', basis: 'per_thousand_units_per_day', uom: 'each', quantity: '900', ratePaise: 400, amountPaise: 360 },
              { chargeCode: 'storage', basis: 'per_thousand_units_per_day', uom: 'kg', quantity: '360', ratePaise: 400, amountPaise: 144 },
              // the GRN exactly at IST midnight belongs to card B
              { chargeCode: 'inbound_handling', basis: 'per_receipt_line', uom: null, quantity: '1', ratePaise: 600, amountPaise: 600 },
              { chargeCode: 'pick', basis: 'per_pick', uom: null, quantity: '2', ratePaise: 350, amountPaise: 700 },
              // two dispatch events (one per line), ONE order — the straddling order is
              // NOT counted again, the packed-only order and BETA's never — and B
              // prices no outbound handling. (BETA's and the tenant's picks: not ACME's.)
              { chargeCode: 'outbound_handling', basis: 'per_order', uom: null, quantity: '1', ratePaise: null, amountPaise: null },
            ],
          },
        ]);
        expect(res.body.totals).toEqual({ billedPaise: 198 + 495 + 1500 + 2000 + 144 + 360 + 600 + 700, unbilledLines: 1 });
        // Recompute equality (CAP-5): the same read twice is the same answer.
        expect((await usage(client('ACME'), '2026-09-01', '2026-09-30').expect(200)).body.segments).toEqual(res.body.segments);
        // …and a verify re-fold reports no drift behind it.
        expect((await billing.verifySnapshots(tenantId, client('ACME'), wh1)).drift).toEqual([]);
      });

      it('no card for a stretch: the quantity shows, the rate and amount are null', async () => {
        const res = await usage(client('ACME'), '2026-08-25', '2026-09-05').expect(200);
        const [none, a] = res.body.segments as { rateCardId: string | null; fromDate: string; toDate: string; lines: { chargeCode: string; uom: string | null; quantity: string; ratePaise: number | null; amountPaise: number | null }[] }[];
        expect(none).toMatchObject({ rateCardId: null, fromDate: '2026-08-25', toDate: '2026-08-31' });
        expect(none!.lines.find((line) => line.chargeCode === 'inbound_handling')).toEqual(
          expect.objectContaining({ quantity: '1', ratePaise: null, amountPaise: null }),
        );
        expect(none!.lines.every((line) => line.ratePaise === null && line.amountPaise === null)).toBe(true);
        // No stock yet: one empty storage line, priced at zero under card A.
        expect(a!.lines[0]).toEqual({ chargeCode: 'storage', basis: 'per_thousand_units_per_day', uom: null, quantity: '0', ratePaise: 330, amountPaise: 0 });
        expect(res.body.totals.unbilledLines).toBe(4);
      });

      it('a period past the storage watermark: storage through storageCompleteThrough, counts to now', async () => {
        const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
        const res = await usage(client('ACME'), '2026-09-01', today).expect(200);
        expect(res.body.storageCompleteThrough).toBe('2026-09-30');
        expect(res.body.to).toBe(today);
        const last = res.body.segments.at(-1) as { toDate: string; lines: { chargeCode: string; uom: string | null; quantity: string }[] };
        expect(last.toDate).toBe(today);
        expect(last.lines.filter((line) => line.chargeCode === 'storage').map((line) => [line.uom, line.quantity])).toEqual([
          ['each', '900'],
          ['kg', '360'],
        ]);
        // The stretch has unmeasured days: the measured days' quantity, but
        // NO amount (never a ₹0 that reads as billed) — out of the billed total.
        expect((last as unknown as { storageMeasuredThrough: string }).storageMeasuredThrough).toBe('2026-09-30');
        const storageLines = (last.lines as unknown as { chargeCode: string; amountPaise: number | null }[]).filter((line) => line.chargeCode === 'storage');
        expect(storageLines.every((line) => line.amountPaise === null)).toBe(true);
        expect(res.body.totals.billedPaise).toBe(198 + 495 + 1500 + 2000 + 600 + 700);
        expect(Date.parse(res.body.asOf)).toBeGreaterThan(Date.now() - 60_000);
      });

      it('self: handling counts metered, storage not measured (storageCompleteThrough null)', async () => {
        const res = await usage(selfId, '2026-09-01', '2026-09-30').expect(200);
        expect(res.body.storageCompleteThrough).toBeNull();
        const [segment] = res.body.segments as { rateCardId: string | null; lines: { chargeCode: string; uom: string | null; quantity: string; ratePaise: number | null }[] }[];
        expect(segment!.rateCardId).toBeNull();
        expect(segment!.lines.find((line) => line.chargeCode === 'storage')).toMatchObject({ uom: null, quantity: '0', ratePaise: null });
        expect(segment!.lines.find((line) => line.chargeCode === 'inbound_handling')).toMatchObject({ quantity: '1' });
        // The tenant's own pick — and only it (ACME's and BETA's are theirs).
        expect(segment!.lines.find((line) => line.chargeCode === 'pick')).toMatchObject({ quantity: '1' });
        expect((segment as unknown as { storageMeasuredThrough: string | null }).storageMeasuredThrough).toBeNull();
      });

      it('storage completeness is the MINIMUM watermark across the client’s warehouses (a scope with no progress counts as the day before its first event)', async () => {
        // EPS: WH1 and WH2 are both through 09-30 now — then a third scope
        // appears (an event in a warehouse never snapshotted).
        const w3 = await createWarehouse(`M3-${ulid().slice(20)}`);
        const binD = await createBin(w3.warehouseId, w3.zoneId, 'C-01-01');
        await append({ warehouseId: w3.warehouseId, type: 'stock.adjusted', skuId: sku('EPS-PC'), quantityDelta: 1_000, toBinId: binD, recordedAt: istIso('2026-09-20T10:00') });
        const res = await usage(client('EPS'), '2026-09-01', '2026-09-30').expect(200);
        expect(res.body.storageCompleteThrough).toBe('2026-09-19');
        const storage = (res.body.segments[0].lines as { chargeCode: string; uom: string | null; quantity: string }[]).filter((line) => line.chargeCode === 'storage');
        // EPS has no card: one stretch. 05–06 in WH1 (2 × 9) + 07–19 in WH2 (13 × 9) = 135 each-days.
        expect(storage).toEqual([expect.objectContaining({ uom: 'each', quantity: '135' })]);
      });

      it('bad requests: from > to, more than 366 days, a malformed date or client uuid → 400; an unknown or foreign client → 404; another tenant → 403', async () => {
        expectProblem(await usage(client('ACME'), '2026-09-30', '2026-09-01'), 400, 'validation-failed');
        expectProblem(await usage(client('ACME'), '2025-09-01', '2026-09-02'), 400, 'validation-failed');
        expect((await usage(client('ACME'), '2025-09-01', '2026-09-01')).status).toBe(200); // exactly 366 days
        expect(MAX_METERING_DAYS).toBe(366);
        expectProblem(await usage(client('ACME'), '2026-02-30', '2026-03-01'), 400, 'validation-failed');
        expectProblem(await usage(client('ACME'), '2026-9-1', '2026-09-30'), 400, 'validation-failed');
        expectProblem(await http().get(`${API}/${tenantId}/clients/${client('ACME')}/usage?from=2026-09-01`).set('Authorization', `Bearer ${opsToken}`), 400, 'validation-failed');
        expectProblem(await usage('acme', '2026-09-01', '2026-09-30'), 400, 'validation-failed');
        expectProblem(await usage(uuidv7(), '2026-09-01', '2026-09-30'), 404, 'not-found');
        expectProblem(await usage(other.clientId, '2026-09-01', '2026-09-30'), 404, 'not-found');
        expectProblem(
          await http().get(`${API}/${other.tenantId}/clients/${other.clientId}/usage?from=2026-09-01&to=2026-09-30`).set('Authorization', `Bearer ${opsToken}`),
          403,
          'permission-denied',
        );
      });

      it('a client-portal session (a user carrying a client) is refused 403 — an operator read', async () => {
        const portalToken = await invite('ops_manager');
        const me = await http().get(`${API}/${tenantId}/me`).set('Authorization', `Bearer ${portalToken}`);
        const userId = (me.body.user?.id ?? me.body.id) as string | undefined;
        expect(userId).toBeDefined();
        await sql`update users set client_id = ${client('ACME')} where id = ${userId!}`;
        expectProblem(await usage(client('ACME'), '2026-09-01', '2026-09-30', portalToken), 403, 'role-denied');
        expectProblem(await usage(client('BETA'), '2026-09-01', '2026-09-30', portalToken), 403, 'role-denied');
      });

      it('member-open: the owner, the accountant and the ops manager all read it', async () => {
        for (const token of [ownerToken, accountantToken, opsToken]) {
          await usage(client('ACME'), '2026-09-01', '2026-09-30', token).expect(200);
        }
      });

      it('the route is in the OpenAPI document', async () => {
        const doc = await http().get('/api/v1/openapi.json').expect(200);
        const path = (doc.body.paths as Record<string, { get?: { parameters?: { name: string; required?: boolean }[] } }>)[
          '/tenants/{tenantId}/clients/{clientId}/usage'
        ];
        expect(path?.get).toBeDefined();
        expect(path!.get!.parameters!.find((param) => param.name === 'from')?.required).toBe(true);
        expect(path!.get!.parameters!.find((param) => param.name === 'to')?.required).toBe(true);
      });
    });
  });
});
