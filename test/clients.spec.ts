import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Logger, type INestApplication } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import Redis from 'ioredis';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { nowIso } from '../src/shared/primitives/time';
import { createApp } from '../src/app.factory';
import { createDatabase } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { eventHashOf } from '../src/modules/inventory/ledger.service';
import { registeredLedgerEventTypes, getLedgerEventType } from '../src/modules/inventory/ledger-registry';
import type { SignedQuantity } from '../src/shared/primitives/quantity';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { InvoiceDeliveryHandler } from '../src/modules/invoicing/delivery';
import { ORDER_DISPATCHED_EVENT } from '../src/modules/invoicing/events';
import { ChannelsIngestCommand } from '../src/modules/channels/channels.ingest.command';
import { CLIENT_STATUS_TARGETS, ClientsCommand } from '../src/modules/clients/clients.command';
import { ProblemException } from '../src/shared/problem-details/problem.exception';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { noOpIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(120_000);

/** The migration file this story ships, split into executable statements. */
function migration0059Statements(): string[] {
  const text = readFileSync(resolve(process.cwd(), 'drizzle/0059_client_admin.sql'), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

describe('story 21-2b: client admin and attribution', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Part A — migration 0059 against a database built from the repo's OWN
  // journal trimmed to 0058 (the client-dimension Part-A harness), seeded,
  // then applied inside ONE transaction like the real runner.
  // ──────────────────────────────────────────────────────────────────────────
  describe('migration 0059, applied to pre-migration data', () => {
    const PRE_DB = 'wms_s_clientadmin_premigration';
    let baseUrl: string;
    let sql: ReturnType<typeof postgres>;
    let folder: string;
    const tenantIds: readonly [string, string] = [uuidv7(), uuidv7()];
    const selfIds: readonly [string, string] = [uuidv7(), uuidv7()];
    const acmeId = uuidv7();
    const importIds: readonly [string, string] = [uuidv7(), uuidv7()];

    async function admin<T>(fn: (db: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
      const adminUrl = new URL(baseUrl);
      adminUrl.pathname = '/postgres';
      const db = postgres(adminUrl.toString(), { max: 1 });
      try {
        return await fn(db);
      } finally {
        await db.end();
      }
    }

    beforeAll(async () => {
      baseUrl = process.env.DATABASE_URL!;
      const url = new URL(baseUrl);
      url.pathname = `/${PRE_DB}`;
      const preUrl = url.toString();
      await admin(async (db) => {
        await db.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
        await db.unsafe(`drop database if exists "${PRE_DB}"`);
        await db.unsafe(`create database "${PRE_DB}"`);
      });
      folder = mkdtempSync(join(tmpdir(), 'wms-pre-0059-'));
      cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
      rmSync(join(folder, '0059_client_admin.sql'));
      const journalPath = join(folder, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 58);
      writeFileSync(journalPath, JSON.stringify(journal));
      const db = createDatabase(preUrl);
      await migrate(db, { migrationsFolder: folder });
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
      sql = postgres(preUrl, { max: 2 });

      // Two tenants, each with its self client and one import run; tenant 0
      // also holds a lowercase non-system client (only SQL could make one
      // before this story) the migration must uppercase.
      for (let i = 0; i < 2; i++) {
        await sql`insert into tenants (id, tenant_id, name) values (${tenantIds[i]!}, ${tenantIds[i]!}, ${'Admin Co ' + i})`;
        await sql`insert into clients (id, tenant_id, code, name, status, system_owned)
          values (${selfIds[i]!}, ${tenantIds[i]!}, 'self', ${'Admin Co ' + i}, 'active', true)`;
        await sql`insert into catalog_imports (id, tenant_id, mode, committed_rows, failed_rows, skipped_rows)
          values (${importIds[i]!}, ${tenantIds[i]!}, 'initial', 1, 0, 0)`;
      }
      await sql`insert into clients (id, tenant_id, code, name, status, system_owned)
        values (${acmeId}, ${tenantIds[0]}, 'acme-foods', 'Acme Foods', 'active', false)`;
    }, 120_000);

    afterAll(async () => {
      await sql?.end();
      rmSync(folder, { recursive: true, force: true });
      await admin(async (db) => {
        await db.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
        await db.unsafe(`drop database if exists "${PRE_DB}"`);
      });
    });

    it('the pre-flight RAISEs, listing EVERY offender at once (and changes nothing)', async () => {
      const preflight = migration0059Statements()[1]!;
      const ROLLBACK = new Error('rollback-sentinel');
      let raised: unknown;
      await sql
        .begin(async (tx) => {
          const t = tenantIds[1];
          await tx`insert into clients (id, tenant_id, code, name, status, system_owned) values
            (${uuidv7()}, ${t}, 'SELF', 'Reserved', 'active', false),
            (${uuidv7()}, ${t}, 'a b', 'Spaced', 'active', false),
            (${uuidv7()}, ${t}, 'dup', 'Dup lower', 'active', false),
            (${uuidv7()}, ${t}, 'DUP', 'Dup upper', 'active', false),
            (${uuidv7()}, ${t}, 'BLANKNAME', '   ', 'active', false)`;
          // A tenant with an import run but NO self client — nothing to backfill from.
          const orphan = uuidv7();
          await tx`insert into tenants (id, tenant_id, name) values (${orphan}, ${orphan}, 'Orphan Co')`;
          await tx`insert into catalog_imports (id, tenant_id, mode, committed_rows, failed_rows, skipped_rows)
            values (${uuidv7()}, ${orphan}, 'initial', 0, 0, 0)`;
          try {
            await tx.unsafe(preflight);
          } catch (err) {
            raised = err;
          }
          throw ROLLBACK;
        })
        .catch((err: unknown) => {
          if (err !== ROLLBACK) throw err;
        });
      const message = (raised as Error | undefined)?.message ?? '';
      expect(message).toMatch(/migration 0059 pre-flight failed/);
      expect(message).toMatch(/code "SELF" is reserved/);
      expect(message).toMatch(/code "a b" is not 2-32 characters/);
      expect(message).toMatch(/collide on code "DUP" once uppercased/);
      expect(message).toMatch(/name is 0 characters once trimmed/);
      expect(message).toMatch(/the tenant has no self client to backfill from/);
    });

    describe('applied', () => {
      beforeAll(async () => {
        await sql.begin(async (tx) => {
          for (const statement of migration0059Statements()) {
            await tx.unsafe(statement);
          }
        });
      });

      it('uppercases existing non-system codes and leaves `self` lowercase', async () => {
        const rows = await sql<{ id: string; code: string }[]>`select id, code from clients where tenant_id = ${tenantIds[0]} order by code`;
        expect(rows.find((row) => row.id === acmeId)?.code).toBe('ACME-FOODS');
        expect(rows.find((row) => row.id === selfIds[0])?.code).toBe('self');
      });

      it("backfills every catalog import run with ITS tenant's self client, then locks NOT NULL", async () => {
        const rows = await sql<{ id: string; client_id: string }[]>`select id, client_id from catalog_imports where id in ${sql([...importIds])}`;
        expect(new Map(rows.map((row) => [row.id, row.client_id]))).toEqual(
          new Map([
            [importIds[0], selfIds[0]],
            [importIds[1], selfIds[1]],
          ]),
        );
        const nullable = await sql<{ is_nullable: string }[]>`
          select is_nullable from information_schema.columns
          where table_name = 'catalog_imports' and column_name = 'client_id'`;
        expect(nullable[0]?.is_nullable).toBe('NO');
      });

      it('the CHECKs refuse a bad code, the reserved code and an empty/over-long name (23514) — and admit a good row', async () => {
        const insert = (code: string, name: string, systemOwned = false) =>
          sql`insert into clients (id, tenant_id, code, name, status, system_owned)
            values (${uuidv7()}, ${tenantIds[1]}, ${code}, ${name}, 'active', ${systemOwned})`;
        await expect(insert('acme', 'Lowercase')).rejects.toMatchObject({ code: '23514' });
        await expect(insert('A', 'Too short')).rejects.toMatchObject({ code: '23514' });
        await expect(insert('-ACME', 'Leading dash')).rejects.toMatchObject({ code: '23514' });
        await expect(insert('SELF', 'Reserved')).rejects.toMatchObject({ code: '23514' });
        await expect(insert('NONAME', '  ')).rejects.toMatchObject({ code: '23514' });
        await expect(insert('LONGNAME', 'x'.repeat(201))).rejects.toMatchObject({ code: '23514' });
        await insert('GOOD-1', 'y'.repeat(200));
      });

      it('the fail-fast guard refuses a second application', async () => {
        const guard = migration0059Statements()[0]!;
        await expect(sql.unsafe(guard)).rejects.toThrow(/migration 0059 has already been applied/);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part B — the HTTP matrix.
  // ──────────────────────────────────────────────────────────────────────────
  describe('over HTTP', () => {
    let app: INestApplication;
    let sql: postgres.Sql;
    let valkey: Redis;
    let suiteDb: SuiteDatabase;

    let tenantId: string;
    let tenantName: string;
    let ownerToken: string;
    let opsToken: string;
    let accountantToken: string;
    let operatorWebToken: string;
    let deviceOperatorToken: string;
    let warehouseId: string;
    let zoneId: string;
    let binA: string;
    let binB: string;
    let vendorId: string;
    let selfClientId: string;
    let acmeId: string;
    let otherTenant: { tenantId: string; ownerToken: string; clientId: string };
    let channelIntegrationId: string;
    const skuIds = new Map<string, string>();

    const http = () => request(app.getHttpServer());
    const at = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

    async function register(name: string): Promise<{ tenantId: string; ownerToken: string; email: string }> {
      const email = `owner-${ulid().toLowerCase()}@example.com`;
      const registered = await http()
        .post(API)
        .set(KEY_HEADER, ulid())
        .send({ name, ownerEmail: email, password: 'correct-horse-battery' })
        .expect(201);
      const token = (
        await http().post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200)
      ).body.accessToken as string;
      return { tenantId: registered.body.tenant.id as string, ownerToken: token, email };
    }

    async function invite(role: string): Promise<{ email: string; token: string }> {
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
      const token = (
        await http().post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200)
      ).body.accessToken as string;
      return { email, token };
    }

    function importCsv(
      csvRows: string[],
      opts: { clientId?: string; mode?: 'initial' | 'fix'; token?: string; key?: string } = {},
    ): SupertestTest {
      const csv = ['sku_code,name,uom,gst_rate,product,variant_values,kit_components', ...csvRows].join('\n');
      let req = http()
        .post(`${API}/${tenantId}/catalog/imports`)
        .set('Authorization', `Bearer ${opts.token ?? ownerToken}`)
        .set(KEY_HEADER, opts.key ?? ulid())
        .field('mode', opts.mode ?? 'initial');
      if (opts.clientId !== undefined) req = req.field('clientId', opts.clientId);
      return req.attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' });
    }

    async function refreshSkus(): Promise<void> {
      const list = await http()
        .get(`${API}/${tenantId}/catalog/skus?limit=200`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      for (const item of list.body.items as { code: string; id: string }[]) skuIds.set(item.code, item.id);
    }

    function sku(code: string): string {
      const id = skuIds.get(code);
      if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
      return id;
    }

    async function skuClient(code: string): Promise<string> {
      const rows = await sql<{ client_id: string }[]>`select client_id from skus where id = ${sku(code)}`;
      return rows[0]!.client_id;
    }

    function createClient(body: Record<string, unknown>, token = ownerToken, key = ulid()): SupertestTest {
      return http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send(body);
    }

    function createOrder(lines: { skuId: string; quantity: number; ratePaise?: number }[]): SupertestTest {
      return http()
        .post(`${API}/${tenantId}/outbound/orders`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, lines, destination: testAddress() });
    }

    function createPo(lines: { skuId: string; orderedQty: number }[], code = `PO-${ulid().slice(10, 18)}`): SupertestTest {
      return http()
        .post(`${API}/${tenantId}/inbound/purchase-orders`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, vendorId, code, lines: lines.map((line) => ({ ...line, unitCostPaise: 1000 })) });
    }

    async function seedStock(skuId: string, binId: string, quantity: number): Promise<void> {
      await http()
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId, skuId, binId, quantityDelta: quantity, reasonCode: 'stock-count', note: 'clients-suite seed' })
        .expect(201);
    }

    function expectProblem(res: request.Response, status: number, code: string): void {
      expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
    }

    // ── deterministic races (21-10; parameterised by table in 21-11a) ─────────
    /** A response as 200, or `"<status> <code>"` — so a failed race names the refusal. */
    const outcome = (res: request.Response): number | string =>
      res.status === 200 ? 200 : `${res.status} ${(res.body as { code?: string }).code}`;
    const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

    /**
     * Wait until `min` sessions are parked on a `table` row lock held by
     * `holderPid` — a statement on `table` taking `lockClause`, waiting on a
     * lock, in the chain that leads back to the holder.
     */
    const waitParked = async (
      table: 'clients' | 'products',
      holderPid: number,
      lockClause: 'for share' | 'for update',
      min: number,
    ): Promise<void> => {
      const probe = handle();
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active'
              and a.query ilike ${`%"${table}"%`} and a.query ilike ${`%${lockClause}%`}
          `) as unknown as { pid: number; blockers: number[] }[];
          // A second waiter on one row queues behind the FIRST waiter's
          // tuple lock, so its blocker is that waiter, not the holder:
          // count the chain that leads back to the holder.
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
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`fewer than ${min} request(s) parked on the ${table} row (${lockClause})`);
      } finally {
        await probe.end();
      }
    };

    beforeAll(async () => {
      suiteDb = await useSuiteDatabase('clients');
      app = await createApp(false);
      await app.init();
      sql = postgres(process.env.DATABASE_URL!, { max: 2 });
      valkey = new Redis(process.env.VALKEY_URL!, { lazyConnect: true });

      tenantName = `Client Admin Co ${ulid()}`;
      const owner = await register(tenantName);
      tenantId = owner.tenantId;
      ownerToken = owner.ownerToken;
      opsToken = (await invite('ops_manager')).token;
      accountantToken = (await invite('accountant')).token;
      const operator = await invite('operator');
      operatorWebToken = operator.token;

      const other = await register(`Other Co ${ulid()}`);
      const otherClients = await http()
        .get(`${API}/${other.tenantId}/clients`)
        .set('Authorization', `Bearer ${other.ownerToken}`)
        .expect(200);
      otherTenant = { tenantId: other.tenantId, ownerToken: other.ownerToken, clientId: otherClients.body.items[0].id as string };

      warehouseId = (
        await http()
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin: testAddress(), code: `CA-${ulid().slice(10, 16)}`, name: 'Client Admin WH' })
          .expect(201)
      ).body.id as string;
      zoneId = (
        await http()
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'A', name: 'Aisle A' })
          .expect(201)
      ).body.id as string;
      const bin = async (code: string): Promise<string> =>
        (
          await http()
            .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ capacity: 100000, type: 'shelf', code })
            .expect(201)
        ).body.id as string;
      binA = await bin('A-01-01');
      binB = await bin('A-01-02');
      vendorId = (
        await http()
          .post(`${API}/${tenantId}/vendors`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'VEND-CA', name: 'Client Admin Vendor' })
          .expect(201)
      ).body.vendor.id as string;

      // The floor device + its badge-in operator (receipt, putaway, picks).
      const minted = await http()
        .post(`${API}/${tenantId}/devices/enrollment-codes`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .expect(201);
      const enrolled = await http()
        .post(`${API}/${tenantId}/devices/enroll`)
        .set(KEY_HEADER, ulid())
        .send({ code: minted.body.code, label: 'Client admin scanner', pin: '2468' })
        .expect(201);
      deviceOperatorToken = (
        await http()
          .post(`${API}/${tenantId}/devices/badge-in`)
          .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
          .send({ operatorEmail: operator.email, pin: '2468' })
          .expect(200)
      ).body.accessToken as string;

      await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);

      const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      selfClientId = clients.body.items[0].id as string;

      // The pre-existing D2C catalog: imported while `self` is the ONLY
      // client — no clientId needed, the import fingerprint is the old one.
      await importCsv([
        'SELF-A,Self A,pcs,1800,,,',
        'SELF-B,Self B,pcs,1800,,,',
        'SELF-C,Self C,pcs,1800,,,',
        'SELF-V1,Self variant 1,pcs,1800,,,',
      ]).expect(201);
      await refreshSkus();
    });

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

    // ── registration ─────────────────────────────────────────────────────────
    it('a tenant named with 200 characters is born with a self client of that name', async () => {
      const name = 'N'.repeat(200);
      const { tenantId: id } = await register(name);
      const rows = await sql<{ name: string; code: string; system_owned: boolean }[]>`
        select name, code, system_owned from clients where tenant_id = ${id}`;
      expect(rows).toEqual([{ name, code: 'self', system_owned: true }]);
    });

    // ── create / list / rename ───────────────────────────────────────────────
    describe('client admin', () => {
      it('an owner creates a client: 201, code trimmed and stored uppercase, active, not system-owned, audited', async () => {
        const key = ulid();
        const res = await createClient({ code: '  acme ', name: ' Acme Foods ' }, ownerToken, key).expect(201);
        expect(res.body.client).toMatchObject({ tenantId, code: 'ACME', name: 'Acme Foods', status: 'active', systemOwned: false });
        acmeId = res.body.client.id as string;
        const audit = await sql`select action, target_type, reference from audit_events where tenant_id = ${tenantId} and target_id = ${acmeId}`;
        expect(audit).toEqual([{ action: 'client.created', target_type: 'client', reference: key }]);
        // The same key replays the snapshot; a different payload on it is 422.
        const replay = await createClient({ code: 'acme', name: 'Acme Foods' }, ownerToken, key).expect(201);
        expect(replay.body.client.id).toBe(acmeId);
        expectProblem(await createClient({ code: 'acme', name: 'Other' }, ownerToken, key), 422, 'idempotency-key-reuse');
      });

      it('a duplicate code — sequential or concurrent — is 409 duplicate-client-code', async () => {
        expectProblem(await createClient({ code: 'ACME', name: 'Acme again' }), 409, 'duplicate-client-code');
        const [a, b] = await Promise.all([
          createClient({ code: 'RACE-1', name: 'Race A' }),
          createClient({ code: 'race-1', name: 'Race B' }),
        ]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        expect([a, b].find((res) => res.status === 409)!.body.code).toBe('duplicate-client-code');
      });

      it('the reserved code and a malformed code are 400 validation-failed', async () => {
        expectProblem(await createClient({ code: 'self', name: 'Me' }), 400, 'validation-failed');
        expectProblem(await createClient({ code: 'AC ME', name: 'Spaced' }), 400, 'validation-failed');
        expectProblem(await createClient({ code: 'A', name: 'Short' }), 400, 'validation-failed');
        expectProblem(await createClient({ code: 'OK-NAME', name: '' }), 400, 'validation-failed');
      });

      it('a non-owner cannot create a client (403 role-denied)', async () => {
        expectProblem(await createClient({ code: 'OPS-TRY', name: 'Ops try' }, opsToken), 403, 'role-denied');
      });

      it('rename: owner 200 (audited); self 400; unknown or foreign id 404; non-owner 403', async () => {
        const rename = (clientId: string, name: string, token = ownerToken) =>
          http()
            .patch(`${API}/${tenantId}/clients/${clientId}`)
            .set('Authorization', `Bearer ${token}`)
            .set(KEY_HEADER, ulid())
            .send({ name });
        const created = await createClient({ code: 'RENAME-ME', name: 'Before' }).expect(201);
        const id = created.body.client.id as string;
        const renamed = await rename(id, 'After').expect(200);
        expect(renamed.body.client).toMatchObject({ id, code: 'RENAME-ME', name: 'After' });
        const audit = await sql`select action from audit_events where tenant_id = ${tenantId} and target_id = ${id} order by occurred_at`;
        expect(audit.map((row) => row.action)).toEqual(['client.created', 'client.renamed']);
        expectProblem(await rename(selfClientId, 'Not the tenant'), 400, 'validation-failed');
        expectProblem(await rename(uuidv7(), 'Ghost'), 404, 'not-found');
        expectProblem(await rename(otherTenant.clientId, 'Foreign'), 404, 'not-found');
        expectProblem(await rename(id, 'Ops rename', opsToken), 403, 'role-denied');
        expectProblem(await rename('not-a-uuid', 'Bad'), 400, 'validation-failed');
      });

      it('any member lists every client — system-owned first, then by code, every status', async () => {
        await sql`update clients set status = 'suspended' where id = (select id from clients where tenant_id = ${tenantId} and code = 'RENAME-ME')`;
        const list = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${accountantToken}`).expect(200);
        const items = list.body.items as { code: string; systemOwned: boolean; status: string; name: string }[];
        expect(items[0]).toMatchObject({ code: 'self', systemOwned: true, name: tenantName });
        const rest = items.slice(1).map((item) => item.code);
        expect(rest).toEqual([...rest].sort());
        expect(rest).toEqual(expect.arrayContaining(['ACME', 'RACE-1', 'RENAME-ME']));
        expect(items.find((item) => item.code === 'RENAME-ME')?.status).toBe('suspended');
      });

      it('the routes are in the OpenAPI document', async () => {
        const doc = await http().get('/api/v1/openapi.json').expect(200);
        const paths = Object.keys(doc.body.paths as Record<string, unknown>);
        expect(paths).toEqual(
          expect.arrayContaining([
            '/tenants/{tenantId}/clients',
            '/tenants/{tenantId}/clients/{clientId}',
            '/tenants/{tenantId}/clients/{clientId}/status',
            '/tenants/{tenantId}/catalog/skus/{skuId}/client',
          ]),
        );
      });
    });

    // ── the import names its client ──────────────────────────────────────────
    describe('catalog import', () => {
      it('with more than one client and none named: 400 client-required (nothing committed)', async () => {
        expectProblem(await importCsv(['NOPE-1,Nope,pcs,1800,,,']), 400, 'client-required');
        const rows = await sql`select 1 from skus where tenant_id = ${tenantId} and code = 'NOPE-1'`;
        expect(rows).toHaveLength(0);
      });

      it('a non-uuid clientId is 400; an unknown or foreign one is 404', async () => {
        expectProblem(await importCsv(['NOPE-2,Nope,pcs,1800,,,'], { clientId: 'acme' }), 400, 'validation-failed');
        expectProblem(await importCsv(['NOPE-2,Nope,pcs,1800,,,'], { clientId: uuidv7() }), 404, 'not-found');
        expectProblem(await importCsv(['NOPE-2,Nope,pcs,1800,,,'], { clientId: otherTenant.clientId }), 404, 'not-found');
      });

      it('an import for ACME stamps its SKUs and records ACME on the run; an existing code names its owner client', async () => {
        const res = await importCsv(
          [
            'ACME-A,Acme A,pcs,1800,,,',
            'ACME-B,Acme B,pcs,1800,,,',
            'ACME-C,Acme C,pcs,1800,,,',
            'ACME-D,Acme D,pcs,1800,,,',
            'ACME-E,Acme E,pcs,1800,,,',
            'ACME-F,Acme F,pcs,1800,,,',
            'SELF-A,Clash,pcs,1800,,,',
          ],
          { clientId: acmeId },
        ).expect(201);
        expect(res.body).toMatchObject({ committedRows: 6, failedRows: 1, clientId: acmeId });
        expect(res.body.errors[0]).toMatchObject({ skuCode: 'SELF-A', code: 'duplicate-sku-code' });
        // The tenant's own client is named as the company, never `self`.
        expect(res.body.errors[0].detail).toContain(`(client ${tenantName} (your company))`);
        await refreshSkus();
        for (const code of ['ACME-A', 'ACME-B', 'ACME-C', 'ACME-D', 'ACME-E', 'ACME-F']) {
          expect(await skuClient(code)).toBe(acmeId);
        }
        const run = await sql`select client_id from catalog_imports where id = ${res.body.importId as string}`;
        expect(run[0]?.client_id).toBe(acmeId);
        // The SKU read shape carries the client.
        const list = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${opsToken}`).expect(200);
        const acmeA = (list.body.items as { code: string; clientId: string }[]).find((item) => item.code === 'ACME-A');
        expect(acmeA?.clientId).toBe(acmeId);
        // Pre-existing SKUs stayed `self`.
        expect(await skuClient('SELF-A')).toBe(selfClientId);
      });

      it('the self client may be chosen explicitly', async () => {
        const res = await importCsv(['SELF-D,Self D,pcs,1800,,,'], { clientId: selfClientId }).expect(201);
        expect(res.body).toMatchObject({ committedRows: 1, clientId: selfClientId });
        await refreshSkus();
        expect(await skuClient('SELF-D')).toBe(selfClientId);
      });

      it('fix mode inherits the original run\'s client; naming a different client is 400', async () => {
        // The original ACME run: one row fails (a bad gst rate).
        const first = await importCsv(['ACME-FIX,Acme fix,pcs,999999,,,'], { clientId: acmeId }).expect(201);
        expect(first.body.failedRows).toBe(1);
        expectProblem(
          await importCsv(['ACME-FIX,Acme fix,pcs,1800,,,'], { mode: 'fix', clientId: selfClientId }),
          400,
          'validation-failed',
        );
        const fixed = await importCsv(['ACME-FIX,Acme fix,pcs,1800,,,'], { mode: 'fix' }).expect(201);
        expect(fixed.body).toMatchObject({ committedRows: 1, clientId: acmeId });
        await refreshSkus();
        expect(await skuClient('ACME-FIX')).toBe(acmeId);
        // Naming the SAME client is fine.
        const again = await importCsv(['ACME-FIX2,x,pcs,999999,,,'], { clientId: acmeId }).expect(201);
        expect(again.body.failedRows).toBe(1);
        await importCsv(['ACME-FIX2,x,pcs,1800,,,'], { mode: 'fix', clientId: acmeId }).expect(201);
      });

      it('the fingerprint is unchanged when clientId is absent, and carries it when present (golden)', async () => {
        // A replay of an absent-clientId import must hash exactly as the
        // pre-21-2b build did: {fileSha256, mode} — key by key.
        const csv = Buffer.from('sku_code,name,uom,gst_rate,product,variant_values,kit_components\nGOLD-1,Gold,pcs,1800,,,', 'utf8');
        const digest = createHash('sha256').update(csv).digest('hex');
        const absent = hashCommandPayload({ fileSha256: digest, mode: 'initial' });
        const golden = createHash('sha256').update(`{"fileSha256":"${digest}","mode":"initial"}`, 'utf8').digest('hex');
        expect(absent).toBe(golden);
        const key = ulid();
        await importCsv(['GOLD-1,Gold,pcs,1800,,,'], { clientId: acmeId, key }).expect(201);
        const stored = await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
        expect(stored[0]?.payload_hash).toBe(
          createHash('sha256').update(`{"fileSha256":"${digest}","mode":"initial","clientId":"${acmeId}"}`, 'utf8').digest('hex'),
        );
      });

      it("the product pass refuses a row attaching ACME to a product holding self variants (mixed-client row error)", async () => {
        await http()
          .post(`${API}/${tenantId}/catalog/products`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ name: 'Self Tee', axes: ['size'] })
          .expect(201);
        const products = await http().get(`${API}/${tenantId}/catalog/products`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
        const productId = (products.body.items as { id: string; name: string }[]).find((p) => p.name === 'Self Tee')!.id;
        await http()
          .patch(`${API}/${tenantId}/catalog/skus/${sku('SELF-V1')}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ productId, variantValues: { size: 'S' } })
          .expect(200);
        const res = await importCsv(['ACME-TEE,Acme tee,pcs,1800,Self Tee,size=M,'], { clientId: acmeId }).expect(201);
        expect(res.body.errors).toEqual([
          expect.objectContaining({ skuCode: 'ACME-TEE', code: 'mixed-client' }),
        ]);
        expect(res.body.committedRows).toBe(0);
        // …and the SKU PATCH refuses the same attach (409).
        expectProblem(
          await http()
            .patch(`${API}/${tenantId}/catalog/skus/${sku('ACME-E')}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ productId, variantValues: { size: 'L' } }),
          409,
          'mixed-client',
        );
      });

      it('the kit pass refuses a component of another client per row; the kit API refuses it 409', async () => {
        const res = await importCsv(['ACME-KIT,Acme kit,pcs,1800,,,SELF-C:1'], { clientId: acmeId }).expect(201);
        expect(res.body.errors).toEqual([expect.objectContaining({ skuCode: 'ACME-KIT', code: 'mixed-client' })]);
        await refreshSkus();
        expectProblem(
          await http()
            .post(`${API}/${tenantId}/catalog/skus/${sku('ACME-KIT')}/kit`)
            .set('Authorization', `Bearer ${opsToken}`)
            .set(KEY_HEADER, ulid())
            .send({ components: [{ skuId: sku('SELF-C'), quantity: 1 }] }),
          409,
          'mixed-client',
        );
        // Same-client composition is fine.
        await http()
          .post(`${API}/${tenantId}/catalog/skus/${sku('ACME-KIT')}/kit`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({ components: [{ skuId: sku('ACME-D'), quantity: 1 }] })
          .expect(201);
      });
    });

    // ── the owner's correction ───────────────────────────────────────────────
    it('a kit PUT replace naming another client\'s component is 409 mixed-client', async () => {
      expectProblem(
        await http()
          .put(`${API}/${tenantId}/catalog/skus/${sku('ACME-KIT')}/kit`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({ components: [{ skuId: sku('SELF-C'), quantity: 1 }] }),
        409,
        'mixed-client',
      );
    });

    describe('correcting a SKU\'s client', () => {
      const correct = (skuId: string, clientId: string, token = ownerToken) =>
        http()
          .post(`${API}/${tenantId}/catalog/skus/${skuId}/client`)
          .set('Authorization', `Bearer ${token}`)
          .set(KEY_HEADER, ulid())
          .send({ clientId });
      // The SKU's own audit rows (`target_type = 'sku'`): since 9-3a a kit
      // SKU also carries its `kit.created` row (`target_type = 'kit'`, the
      // same id), which is not a correction.
      const auditOf = (skuId: string) =>
        sql<{ action: string; target_type: string; reference: string }[]>`
          select action, target_type, reference from audit_events where tenant_id = ${tenantId} and target_id = ${skuId} and target_type = 'sku' order by occurred_at`;

      it('a SKU with no history moves (200, audited from → to); a non-owner is 403; unknown client 404; a no-op writes nothing', async () => {
        await importCsv(['MISFILED,Misfiled,pcs,1800,,,'], { clientId: selfClientId }).expect(201);
        await refreshSkus();
        expectProblem(await correct(sku('MISFILED'), acmeId, opsToken), 403, 'role-denied');
        expectProblem(await correct(sku('MISFILED'), uuidv7()), 404, 'not-found');
        const res = await correct(sku('MISFILED'), acmeId).expect(200);
        expect(res.body.skus).toHaveLength(1);
        expect(res.body.skus[0]).toMatchObject({ code: 'MISFILED', clientId: acmeId });
        expect(await skuClient('MISFILED')).toBe(acmeId);
        const audit = await auditOf(sku('MISFILED'));
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ action: 'sku.client-corrected', target_type: 'sku' });
        expect(audit[0]!.reference).toContain(`from ${tenantName} (your company) → to ACME`);
        // Same client again: 200, nothing written, nothing audited.
        const noop = await correct(sku('MISFILED'), acmeId).expect(200);
        expect(noop.body.skus.map((s: { code: string }) => s.code)).toEqual(['MISFILED']);
        expect(await auditOf(sku('MISFILED'))).toHaveLength(1);
      });

      it('a SKU with history is 409 sku-has-history, naming what it carries (ledger, PO line, order line only, channel mapping)', async () => {
        await seedStock(sku('SELF-B'), binA, 5);
        expectProblem(await correct(sku('SELF-B'), acmeId), 409, 'sku-has-history');
        await importCsv(['PO-ONLY,PO only,pcs,1800,,,', 'ORDER-ONLY,Order only,pcs,1800,,,', 'MAP-ONLY,Map only,pcs,1800,,,'], { clientId: selfClientId }).expect(201);
        await refreshSkus();
        await createPo([{ skuId: sku('PO-ONLY'), orderedQty: 1 }]).expect(201);
        expectProblem(await correct(sku('PO-ONLY'), acmeId), 409, 'sku-has-history');
        expect(await skuClient('PO-ONLY')).toBe(selfClientId);
        // An order line alone (backordered: no stock, so no reservation, no ledger event).
        await createOrder([{ skuId: sku('ORDER-ONLY'), quantity: 1 }]).expect(201);
        const ledger = await sql`select 1 from ledger_events where sku_id = ${sku('ORDER-ONLY')}`;
        expect(ledger).toHaveLength(0);
        const orderOnly = await correct(sku('ORDER-ONLY'), acmeId);
        expectProblem(orderOnly, 409, 'sku-has-history');
        expect(orderOnly.body.detail).toContain('order lines');
        // A channel-mapped SKU (moving it would silently make its connection mixed-client).
        await sql`insert into channel_mappings (id, tenant_id, integration_id, external_ref, sku_id)
          values (${uuidv7()}, ${tenantId}, ${uuidv7()}, 'EXT-MAP-ONLY', ${sku('MAP-ONLY')})`;
        const mapped = await correct(sku('MAP-ONLY'), acmeId);
        expectProblem(mapped, 409, 'sku-has-history');
        expect(mapped.body.detail).toContain('channel mappings');
      });

      it('a kit moves with its components as one group (one audit row each)', async () => {
        const res = await correct(sku('ACME-D'), selfClientId).expect(200);
        expect(res.body.skus.map((s: { code: string }) => s.code)).toEqual(['ACME-D', 'ACME-KIT']);
        expect(await skuClient('ACME-D')).toBe(selfClientId);
        expect(await skuClient('ACME-KIT')).toBe(selfClientId);
        expect(await auditOf(sku('ACME-KIT'))).toHaveLength(1);
        // …and back.
        await correct(sku('ACME-KIT'), acmeId).expect(200);
        expect(await skuClient('ACME-D')).toBe(acmeId);
      });

      it('a product variant moves with its history-free siblings; a sibling with history refuses the whole move, naming it', async () => {
        await importCsv(['SELF-V2,Self variant 2,pcs,1800,Self Tee,size=M,'], { clientId: selfClientId }).expect(201);
        await refreshSkus();
        const res = await correct(sku('SELF-V1'), acmeId).expect(200);
        expect(res.body.skus.map((s: { code: string }) => s.code)).toEqual(['SELF-V1', 'SELF-V2']);
        expect(await skuClient('SELF-V2')).toBe(acmeId);
        await seedStock(sku('SELF-V2'), binA, 1);
        const refused = await correct(sku('SELF-V1'), selfClientId);
        expectProblem(refused, 409, 'sku-has-history');
        expect(refused.body.detail).toContain('SKU "SELF-V2"');
        expect(await skuClient('SELF-V1')).toBe(acmeId);
      });

      // Story 21-11a (retro B2) — the replay UNDER the last lock. The product
      // row is locked first (sku-client.command.ts), so a raw holder on it
      // parks both requests. Without the second replay, the duplicate finds
      // the group already moved and takes the no-op arm, answering only the
      // target SKU where the winner answered the whole (≥ 2-SKU) group.
      it('two same-key corrections parked on the product lock: both 200 with the winner\'s whole-group body, one audit row per SKU, one key', async () => {
        await http()
          .post(`${API}/${tenantId}/catalog/products`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ name: 'Race Tee', axes: ['size'] })
          .expect(201);
        const imported = await importCsv(
          ['RACE-V1,Race variant 1,pcs,1800,Race Tee,size=S,', 'RACE-V2,Race variant 2,pcs,1800,Race Tee,size=M,'],
          { clientId: selfClientId },
        ).expect(201);
        expect(imported.body.committedRows).toBe(2);
        await refreshSkus();
        const productId = (await sql<{ product_id: string }[]>`select product_id from skus where id = ${sku('RACE-V1')}`)[0]!.product_id;
        expect(productId).not.toBeNull();
        const key = ulid();
        const send = () =>
          http()
            .post(`${API}/${tenantId}/catalog/skus/${sku('RACE-V1')}/client`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, key)
            .send({ clientId: acmeId });
        const holder = handle();
        let first: Promise<request.Response> | undefined;
        let second: Promise<request.Response> | undefined;
        try {
          await holder.begin(async (tx) => {
            const locked = (await tx`
              select pg_backend_pid() as pid from products where tenant_id = ${tenantId} and id = ${productId} for update
            `) as unknown as { pid: number }[];
            first = (async () => send())();
            second = (async () => send())();
            await waitParked('products', locked[0]!.pid, 'for update', 2);
          });
          const [a, b] = await Promise.all([first!, second!]);
          expect([a, b].map(outcome)).toEqual([200, 200]);
          // Either request may win; the loser must answer the winner's body.
          expect(b.body).toEqual(a.body);
          expect(a.body.skus.map((s: { code: string }) => s.code)).toEqual(['RACE-V1', 'RACE-V2']);
          // One correction: one audit row per SKU of the group, one key.
          const audits = await sql`select target_id from audit_events
            where tenant_id = ${tenantId} and action = 'sku.client-corrected' and reference like ${`%(key ${key})`}`;
          expect(audits.map((row) => row.target_id as string).sort()).toEqual([sku('RACE-V1'), sku('RACE-V2')].sort());
          expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
          expect(await skuClient('RACE-V2')).toBe(acmeId);
        } finally {
          await Promise.allSettled([first, second]);
          await holder.end();
        }
      });
    });

    // ── documents derive their client ────────────────────────────────────────
    describe('orders and purchase orders', () => {
      it('an order or PO mixing ACME and self SKUs is 409 mixed-client and writes nothing', async () => {
        const before = await sql`select count(*)::int as n from orders where tenant_id = ${tenantId}`;
        const order = await createOrder([
          { skuId: sku('ACME-A'), quantity: 1 },
          { skuId: sku('SELF-A'), quantity: 1 },
        ]);
        expectProblem(order, 409, 'mixed-client');
        expect(order.body.detail).toContain(`ACME, ${tenantName} (your company)`);
        expect(order.body.detail).not.toMatch(/\bself\b/);
        const after = await sql`select count(*)::int as n from orders where tenant_id = ${tenantId}`;
        expect(after[0]!.n).toBe(before[0]!.n);
        const reservations = await sql`select count(*)::int as n from reservations where tenant_id = ${tenantId} and sku_id = ${sku('ACME-A')}`;
        expect(reservations[0]!.n).toBe(0);

        const po = await createPo([
          { skuId: sku('ACME-A'), orderedQty: 1 },
          { skuId: sku('SELF-A'), orderedQty: 1 },
        ]);
        expectProblem(po, 409, 'mixed-client');
      });

      it('a kit whose components differ from the order line client is refused (mixed-client)', async () => {
        // Bypass the kit API (which refuses it) to prove the order-side check.
        await sql`insert into kit_compositions (id, tenant_id, kit_sku_id, component_sku_id, qty)
          values (${uuidv7()}, ${tenantId}, ${sku('SELF-C')}, ${sku('ACME-C')}, 1000)`;
        try {
          expectProblem(await createOrder([{ skuId: sku('SELF-C'), quantity: 1 }]), 409, 'mixed-client');
        } finally {
          await sql`delete from kit_compositions where tenant_id = ${tenantId} and kit_sku_id = ${sku('SELF-C')}`;
        }
      });

      it('a PO amend adding another client\'s line is 409 mixed-client', async () => {
        const created = await createPo([{ skuId: sku('ACME-B'), orderedQty: 2 }]).expect(201);
        expect(created.body.purchaseOrder.clientId).toBe(acmeId);
        const lineId = created.body.purchaseOrder.lines[0].id as string;
        const amend = await http()
          .patch(`${API}/${tenantId}/inbound/purchase-orders/${created.body.purchaseOrder.id as string}`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({
            lines: [
              { id: lineId, skuId: sku('ACME-B'), orderedQty: 2, unitCostPaise: 1000 },
              { skuId: sku('SELF-A'), orderedQty: 1, unitCostPaise: 1000 },
            ],
          });
        expectProblem(amend, 409, 'mixed-client');
      });

      it('a channel delivery mapped to two clients is refused at the mapping check (422, metered validation-failed)', async () => {
        const users = await sql<{ id: string }[]>`select id from users where tenant_id = ${tenantId} and role = 'owner' limit 1`;
        const integrationId = uuidv7();
        channelIntegrationId = integrationId;
        await sql`insert into integrations (id, tenant_id, provider, status, connected_by, ingest_warehouse_id)
          values (${integrationId}, ${tenantId}, 'shopify', 'connected', ${users[0]!.id}, ${warehouseId})`;
        await sql`insert into channel_mappings (id, tenant_id, integration_id, external_ref, sku_id) values
          (${uuidv7()}, ${tenantId}, ${integrationId}, 'EXT-ACME', ${sku('ACME-A')}),
          (${uuidv7()}, ${tenantId}, ${integrationId}, 'EXT-SELF', ${sku('SELF-A')})`;
        const ingest = app.get(ChannelsIngestCommand).ingestOrderDelivery({
          tenantId,
          connectionId: integrationId,
          parsed: {
            orderRef: `CH-${ulid()}`,
            destination: testAddress() as never,
            lines: [
              { externalRef: 'EXT-ACME', quantity: 1 },
              { externalRef: 'EXT-SELF', quantity: 1 },
            ],
          },
        });
        await expect(ingest).rejects.toMatchObject({ status: 422 });
        await ingest.catch((err: { getResponse(): { code: string; detail: string } }) => {
          expect(err.getResponse().code).toBe('ingest-config-invalid');
          expect(err.getResponse().detail).toContain(`ACME, ${tenantName} (your company)`);
        });
        const calls = await sql`select status from integration_calls where tenant_id = ${tenantId} and integration_id = ${integrationId}`;
        expect(calls.map((row) => row.status)).toEqual(['validation-failed']);
      });

      it('the mappings PUT refuses a set spanning clients (409 mixed-client naming them)', async () => {
        const res = await http()
          .put(`${API}/${tenantId}/channels/connections/${channelIntegrationId}/mappings`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({
            items: [
              { externalRef: 'PUT-ACME', skuId: sku('ACME-A') },
              { externalRef: 'PUT-SELF', skuId: sku('SELF-A') },
            ],
          });
        expectProblem(res, 409, 'mixed-client');
        expect(res.body.detail).toContain(`ACME, ${tenantName} (your company)`);
      });

      const deliver = (orderRef: string, refs: string[]) =>
        app.get(ChannelsIngestCommand).ingestOrderDelivery({
          tenantId,
          connectionId: channelIntegrationId,
          parsed: { orderRef, destination: testAddress() as never, lines: refs.map((externalRef) => ({ externalRef, quantity: 1 })) },
        });
      const lastCall = async (): Promise<string> =>
        (
          await sql<{ status: string }[]>`select status from integration_calls where tenant_id = ${tenantId}
            and integration_id = ${channelIntegrationId} order by at desc, id desc limit 1`
        )[0]!.status;

      it('a redelivery of an already-accepted order replays even if its SKUs now span clients (no pre-check)', async () => {
        await importCsv(['CH-1,Ch 1,pcs,1800,,,', 'CH-2,Ch 2,pcs,1800,,,'], { clientId: selfClientId }).expect(201);
        await refreshSkus();
        await sql`insert into channel_mappings (id, tenant_id, integration_id, external_ref, sku_id) values
          (${uuidv7()}, ${tenantId}, ${channelIntegrationId}, 'EXT-CH1', ${sku('CH-1')}),
          (${uuidv7()}, ${tenantId}, ${channelIntegrationId}, 'EXT-CH2', ${sku('CH-2')})`;
        const ref = `CH-RE-${ulid()}`;
        const first = await deliver(ref, ['EXT-CH1', 'EXT-CH2']);
        // A SKU's client drifts after acceptance (legacy data; the API would refuse it).
        await sql`update skus set client_id = ${acmeId} where id = ${sku('CH-2')}`;
        try {
          const again = await deliver(ref, ['EXT-CH1', 'EXT-CH2']);
          expect(again).toEqual({ outcome: 'replayed', orderId: first.orderId });
          // The redelivery's key is minted inside the ingest — find it to
          // declare the no-op arm (story 9-3a's audit guard).
          const redelivered = await sql<{ key: string }[]>`select key from idempotency_keys
            where tenant_id = ${tenantId} and response_snapshot -> 'order' ->> 'id' = ${first.orderId}
            order by created_at desc, id desc limit 1`;
          noOpIdempotencyKey(tenantId, redelivered[0]!.key, 'orders.createOrder:channel-redelivery');
        } finally {
          await sql`update skus set client_id = ${selfClientId} where id = ${sku('CH-2')}`;
        }
      });

      it('a kit-component mixed-client refusal from the order command is the typed 422, metered validation-failed', async () => {
        await sql`insert into channel_mappings (id, tenant_id, integration_id, external_ref, sku_id)
          values (${uuidv7()}, ${tenantId}, ${channelIntegrationId}, 'EXT-KITC', ${sku('SELF-C')})`;
        await sql`insert into kit_compositions (id, tenant_id, kit_sku_id, component_sku_id, qty)
          values (${uuidv7()}, ${tenantId}, ${sku('SELF-C')}, ${sku('ACME-C')}, 1000)`;
        try {
          const refused = deliver(`CH-KIT-${ulid()}`, ['EXT-KITC']);
          await expect(refused).rejects.toMatchObject({ status: 422 });
          await refused.catch((err: { getResponse(): { code: string } }) => {
            expect(err.getResponse().code).toBe('ingest-config-invalid');
          });
          expect(await lastCall()).toBe('validation-failed');
        } finally {
          await sql`delete from kit_compositions where tenant_id = ${tenantId} and kit_sku_id = ${sku('SELF-C')}`;
        }
      });
    });

    // ── the acceptance flow: one ACME order, end to end ──────────────────────
    describe('an ACME order and PO, received → put away → picked → packed → dispatched', () => {
      let orderId: string;
      let poId: string;

      it('every document and every ledger event carries ACME; no invoice and no e-way bill; self rows untouched', async () => {
        // The PO derives ACME and the receipt books against it.
        const po = await createPo([{ skuId: sku('ACME-A'), orderedQty: 10 }]).expect(201);
        poId = po.body.purchaseOrder.id as string;
        expect(po.body.purchaseOrder.clientId).toBe(acmeId);
        const poList = await http()
          .get(`${API}/${tenantId}/warehouses/${warehouseId}/inbound/purchase-orders`)
          .set('Authorization', `Bearer ${accountantToken}`)
          .expect(200);
        expect((poList.body.items as { id: string; clientId: string }[]).find((item) => item.id === poId)?.clientId).toBe(acmeId);
        const grn = await http()
          .post(`${API}/${tenantId}/receiving/goods-receipts`)
          .set('Authorization', `Bearer ${deviceOperatorToken}`)
          .set(KEY_HEADER, ulid())
          .send({
            warehouseId,
            poId,
            blindReasonCode: null,
            occurredAt: at(),
            lines: [{ poLineId: po.body.purchaseOrder.lines[0].id, skuId: sku('ACME-A'), batchCode: null, mfgDate: null, qty: 10 }],
          })
          .expect(201);
        const grnLine = grn.body.goodsReceipt.lines[0] as { id: string };
        await http()
          .post(`${API}/${tenantId}/putaway/placements`)
          .set('Authorization', `Bearer ${deviceOperatorToken}`)
          .set(KEY_HEADER, ulid())
          .send({
            warehouseId,
            grnId: grn.body.goodsReceipt.id,
            grnLineId: grnLine.id,
            skuId: sku('ACME-A'),
            batchId: null,
            qty: 10,
            toBinId: binB,
            reasonCode: null,
            occurredAt: at(),
          })
          .expect(201);

        // The order derives ACME.
        const order = await createOrder([{ skuId: sku('ACME-A'), quantity: 2, ratePaise: 10000 }]).expect(201);
        orderId = order.body.order.id as string;
        expect(order.body.order.clientId).toBe(acmeId);
        const listed = await http()
          .get(`${API}/${tenantId}/warehouses/${warehouseId}/outbound/orders`)
          .set('Authorization', `Bearer ${accountantToken}`)
          .expect(200);
        expect((listed.body.items as { id: string; clientId: string }[]).find((item) => item.id === orderId)?.clientId).toBe(acmeId);

        // Wave → release → pick → pack → dispatch.
        const policy = await http()
          .post(`${API}/${tenantId}/outbound/wave-policies`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId, name: `acme-${ulid().slice(10, 18)}`, grouping: 'single' })
          .expect(201);
        const wave = await http()
          .post(`${API}/${tenantId}/outbound/waves`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId, policyId: policy.body.policy.id, orderIds: [orderId] })
          .expect(201);
        await http()
          .post(`${API}/${tenantId}/outbound/waves/${wave.body.wave.id as string}/release`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({})
          .expect(200);
        const released = await http()
          .get(`${API}/${tenantId}/outbound/waves/${wave.body.wave.id as string}`)
          .set('Authorization', `Bearer ${accountantToken}`)
          .expect(200);
        const picklist = released.body.wave.picklists[0] as { id: string; lines: { id: string; skuId: string; binId: string; qty: number }[] };
        for (const line of picklist.lines) {
          await http()
            .post(`${API}/${tenantId}/outbound/picks`)
            .set('Authorization', `Bearer ${deviceOperatorToken}`)
            .set(KEY_HEADER, ulid())
            .send({ warehouseId, picklistId: picklist.id, picklistLineId: line.id, skuId: line.skuId, binId: line.binId, qty: line.qty, occurredAt: at() })
            .expect(201);
        }
        await http()
          .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
          .set('Authorization', `Bearer ${operatorWebToken}`)
          .set(KEY_HEADER, ulid())
          .send({ scanned: [{ skuId: sku('ACME-A'), qty: 2 }] })
          .expect(201);
        await http()
          .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
          .set('Authorization', `Bearer ${operatorWebToken}`)
          .set(KEY_HEADER, ulid())
          .send({})
          .expect(201);

        // An adjustment on the ACME SKU too.
        await seedStock(sku('ACME-A'), binA, 1);

        // Every ledger event of the ACME SKU carries ACME — receive, putaway,
        // pick, pack, dispatch, adjust.
        const events = await sql<{ type: string; client_id: string }[]>`
          select type, client_id from ledger_events where tenant_id = ${tenantId} and sku_id = ${sku('ACME-A')}`;
        expect(new Set(events.map((event) => event.type))).toEqual(
          new Set(['grn.received', 'putaway.placed', 'pick.picked', 'pack.packed', 'dispatch.dispatched', 'stock.adjusted']),
        );
        expect(events.every((event) => event.client_id === acmeId)).toBe(true);
        const orderRow = await sql`select client_id from orders where id = ${orderId}`;
        expect(orderRow[0]?.client_id).toBe(acmeId);
        const poRow = await sql`select client_id from purchase_orders where id = ${poId}`;
        expect(poRow[0]?.client_id).toBe(acmeId);

        // The dispatch event's invoice delivery skips a client order: ack,
        // no invoice, no `invoice.issued` (so no e-way bill).
        await app.get(InvoiceDeliveryHandler).deliver({
          eventId: uuidv7(),
          type: ORDER_DISPATCHED_EVENT,
          tenantId,
          occurredAt: nowIso(),
          payload: { dispatch: { orderId } },
        });
        const invoices = await sql`select 1 from invoices where tenant_id = ${tenantId} and order_id = ${orderId}`;
        expect(invoices).toHaveLength(0);
        const issued = await sql`select 1 from outbox_messages where tenant_id = ${tenantId} and type = 'invoice.issued'`;
        expect(issued).toHaveLength(0);
        const eway = await sql`select 1 from eway_bills where tenant_id = ${tenantId}`;
        expect(eway).toHaveLength(0);
        // The manual generate refuses it too.
        expectProblem(
          await http()
            .post(`${API}/${tenantId}/invoices`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ orderId }),
          409,
          'client-order-not-invoiced',
        );

        // Pre-existing rows still carry `self`.
        const selfEvents = await sql<{ client_id: string }[]>`
          select client_id from ledger_events where tenant_id = ${tenantId} and sku_id = ${sku('SELF-B')}`;
        expect(selfEvents.length).toBeGreaterThan(0);
        expect(selfEvents.every((event) => event.client_id === selfClientId)).toBe(true);
        const selfSkus = await sql`select distinct client_id from skus where tenant_id = ${tenantId} and code in ('SELF-A','SELF-B','SELF-C')`;
        expect(selfSkus.map((row) => row.client_id)).toEqual([selfClientId]);
      });

      // The invoicing of self orders is unchanged — test/invoicing.spec.ts
      // dispatches and invoices self orders end to end; here the derivation.
      it('a self order derives the self client', async () => {
        await seedStock(sku('SELF-A'), binA, 3);
        const order = await createOrder([{ skuId: sku('SELF-A'), quantity: 1, ratePaise: 10000 }]).expect(201);
        expect(order.body.order.clientId).toBe(selfClientId);
      });

      it('a missing client row is a data fault (logged at error, acked, no invoice), not the client skip; the manual generate answers 409 order-client-missing', async () => {
        const errorSpy = jest.spyOn(Logger.prototype, 'error');
        await sql`update orders set client_id = ${uuidv7()} where id = ${orderId}`;
        try {
          await app.get(InvoiceDeliveryHandler).deliver({
            eventId: uuidv7(),
            type: ORDER_DISPATCHED_EVENT,
            tenantId,
            occurredAt: nowIso(),
            payload: { dispatch: { orderId } },
          });
          expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('data fault'))).toBe(true);
          expect(await sql`select 1 from invoices where order_id = ${orderId}`).toHaveLength(0);
          expectProblem(
            await http()
              .post(`${API}/${tenantId}/invoices`)
              .set('Authorization', `Bearer ${ownerToken}`)
              .set(KEY_HEADER, ulid())
              .send({ orderId }),
            409,
            'order-client-missing',
          );
        } finally {
          await sql`update orders set client_id = ${acmeId} where id = ${orderId}`;
          errorSpy.mockRestore();
        }
      });

      it('the event hash excludes client_id: every ACME event recomputes to its stored hash and the chain verifies', async () => {
        const rows = await sql<Record<string, unknown>[]>`
          select * from ledger_events where tenant_id = ${tenantId} and client_id = ${acmeId} order by seq`;
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          const recomputed = eventHashOf({
            id: row.id as string,
            tenantId: row.tenant_id as string,
            warehouseId: row.warehouse_id as string,
            seq: Number(row.seq),
            type: row.type as string,
            schemaVersion: Number(row.schema_version),
            skuId: row.sku_id as string,
            quantityDelta: Number(row.quantity_delta),
            fromBinId: row.from_bin_id as string | null,
            toBinId: row.to_bin_id as string | null,
            batchRef: row.batch_ref as string | null,
            serialRef: row.serial_ref as string | null,
            actorUserId: row.actor_user_id as string,
            occurredAt: new Date(row.occurred_at as string).toISOString(),
            recordedAt: new Date(row.recorded_at as string).toISOString(),
            referenceDoc: row.reference_doc as never,
            prevHash: row.prev_hash as string,
          });
          expect(recomputed).toBe(row.event_hash);
        }
        const report = await app.get(InventoryFacade).verifyChain(tenantId, warehouseId);
        expect(report.ok).toBe(true);
      });
    });

    // ── replays of snapshots stored before 21-2b ─────────────────────────────
    it('an order or import snapshot stored without clientId (pre-21-2b) still replays', async () => {
      const key = ulid();
      const body = { warehouseId, lines: [{ skuId: sku('ACME-B'), quantity: 1 }], destination: testAddress() };
      const first = await http()
        .post(`${API}/${tenantId}/outbound/orders`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, key)
        .send(body)
        .expect(201);
      await sql`update idempotency_keys set response_snapshot = response_snapshot #- '{order,clientId}' where tenant_id = ${tenantId} and key = ${key}`;
      const replay = await http()
        .post(`${API}/${tenantId}/outbound/orders`)
        .set('Authorization', `Bearer ${opsToken}`)
        .set(KEY_HEADER, key)
        .send(body)
        .expect(201);
      expect(replay.body.order.id).toBe(first.body.order.id);
      expect(replay.body.order.clientId).toBeUndefined();

      const importKey = ulid();
      await importCsv(['LEGACY-1,Legacy,pcs,1800,,,'], { clientId: acmeId, key: importKey }).expect(201);
      await sql`update idempotency_keys set response_snapshot = response_snapshot - 'clientId' where tenant_id = ${tenantId} and key = ${importKey}`;
      const importReplay = await importCsv(['LEGACY-1,Legacy,pcs,1800,,,'], { clientId: acmeId, key: importKey }).expect(201);
      expect(importReplay.body.committedRows).toBe(1);
      expect(importReplay.body.clientId).toBeUndefined();
    });

    // ── story 21-11a: a cross-client wave over HTTP ──────────────────────────
    // Story 21-11a (retro S2a) — the epic's pinned "cross-client wave" test
    // over HTTP: isolation is about visibility and ownership, never about
    // partitioning the floor, so ONE batch wave picks two clients' orders on
    // one picklist — and the shared picklist must not mis-attribute a pick.
    describe('a cross-client wave: ACME and BETA on one batch picklist, picked, packed and dispatched', () => {
      const PASSWORD = 'correct-horse-battery';

      // Copied from test/portal.spec.ts (`accept` / `portalUser`) — per-spec helpers are the convention.
      async function portalUser(clientId: string): Promise<{ token: string }> {
        const email = `portal-${ulid().toLowerCase()}@brand.example`;
        const invited = await http()
          .post(`${API}/${tenantId}/users`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ email, role: 'client', clientId })
          .expect(201);
        await http()
          .post(`${API}/${tenantId}/accept-invite`)
          .set(KEY_HEADER, ulid())
          .send({ token: invited.body.inviteToken as string, password: PASSWORD })
          .expect(200);
        const signedIn = await http().post(`${API}/sign-in`).send({ email, password: PASSWORD }).expect(200);
        return { token: signedIn.body.accessToken as string };
      }

      function portalGet(token: string, path: string): SupertestTest {
        return http().get(`${API}/${tenantId}/portal/${path}`).set('Authorization', `Bearer ${token}`);
      }

      it('one picklist holds both orders; both dispatch; every pick event carries its order\'s client; each portal sees only its own order', async () => {
        const betaId = (await createClient({ code: 'BETA', name: 'Beta Brands' }).expect(201)).body.client.id as string;
        await importCsv(['WAVE-ACME,Wave Acme item,pcs,1800,,,'], { clientId: acmeId }).expect(201);
        await importCsv(['WAVE-BETA,Wave Beta item,pcs,1800,,,'], { clientId: betaId }).expect(201);
        await refreshSkus();
        await seedStock(sku('WAVE-ACME'), binA, 6);
        await seedStock(sku('WAVE-BETA'), binB, 6);

        const acmeOrder = await createOrder([{ skuId: sku('WAVE-ACME'), quantity: 2, ratePaise: 10000 }]).expect(201);
        const betaOrder = await createOrder([{ skuId: sku('WAVE-BETA'), quantity: 3, ratePaise: 10000 }]).expect(201);
        const acmeOrderId = acmeOrder.body.order.id as string;
        const betaOrderId = betaOrder.body.order.id as string;
        expect(acmeOrder.body.order.clientId).toBe(acmeId);
        expect(betaOrder.body.order.clientId).toBe(betaId);
        const clientOfOrder = new Map([
          [acmeOrderId, acmeId],
          [betaOrderId, betaId],
        ]);

        // ONE wave over both orders, batch-grouped.
        const policy = await http()
          .post(`${API}/${tenantId}/outbound/wave-policies`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId, name: `cross-${ulid().slice(10, 18)}`, grouping: 'batch' })
          .expect(201);
        const wave = await http()
          .post(`${API}/${tenantId}/outbound/waves`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId, policyId: policy.body.policy.id, orderIds: [acmeOrderId, betaOrderId] })
          .expect(201);
        const waveId = wave.body.wave.id as string;
        await http()
          .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
          .set('Authorization', `Bearer ${opsToken}`)
          .set(KEY_HEADER, ulid())
          .send({})
          .expect(200);
        const released = await http()
          .get(`${API}/${tenantId}/outbound/waves/${waveId}`)
          .set('Authorization', `Bearer ${accountantToken}`)
          .expect(200);
        // The shared picklist: ONE, not per order, holding lines of both.
        const picklists = released.body.wave.picklists as {
          id: string;
          orderId: string | null;
          lines: { id: string; orderId: string; skuId: string; binId: string; qty: number }[];
        }[];
        expect(picklists).toHaveLength(1);
        const picklist = picklists[0]!;
        expect(picklist.orderId).toBeNull();
        expect(new Set(picklist.lines.map((line) => line.orderId))).toEqual(new Set([acmeOrderId, betaOrderId]));

        // Pick every line on the device.
        for (const line of picklist.lines) {
          await http()
            .post(`${API}/${tenantId}/outbound/picks`)
            .set('Authorization', `Bearer ${deviceOperatorToken}`)
            .set(KEY_HEADER, ulid())
            .send({ warehouseId, picklistId: picklist.id, picklistLineId: line.id, skuId: line.skuId, binId: line.binId, qty: line.qty, occurredAt: at() })
            .expect(201);
        }
        // Pack and dispatch each order.
        for (const [orderId, skuCode, qty] of [
          [acmeOrderId, 'WAVE-ACME', 2],
          [betaOrderId, 'WAVE-BETA', 3],
        ] as const) {
          await http()
            .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
            .set('Authorization', `Bearer ${operatorWebToken}`)
            .set(KEY_HEADER, ulid())
            .send({ scanned: [{ skuId: sku(skuCode), qty }] })
            .expect(201);
          await http()
            .post(`${API}/${tenantId}/outbound/orders/${orderId}/dispatch`)
            .set('Authorization', `Bearer ${operatorWebToken}`)
            .set(KEY_HEADER, ulid())
            .send({})
            .expect(201);
        }
        const statuses = await sql<{ id: string; status: string; client_id: string }[]>`
          select id, status, client_id from orders where id in ${sql([acmeOrderId, betaOrderId])}`;
        expect(new Map(statuses.map((row) => [row.id, [row.status, row.client_id]]))).toEqual(
          new Map([
            [acmeOrderId, ['dispatched', acmeId]],
            [betaOrderId, ['dispatched', betaId]],
          ]),
        );

        // The pick events of each order (linked through reference_doc.orderId)
        // carry THAT order's client — the shared picklist is where a pick
        // could be mis-attributed.
        const picks = await sql<{ order_id: string; client_id: string; sku_id: string }[]>`
          select reference_doc->>'orderId' as order_id, client_id, sku_id from ledger_events
          where tenant_id = ${tenantId} and type = 'pick.picked'
            and reference_doc->>'orderId' in ${sql([acmeOrderId, betaOrderId])}`;
        expect(new Set(picks.map((row) => row.order_id))).toEqual(new Set([acmeOrderId, betaOrderId]));
        for (const row of picks) expect(row.client_id).toBe(clientOfOrder.get(row.order_id));
        // Exactly one pick event per picklist line, per order (untracked SKUs:
        // no batch or serial arms) — a dropped or duplicated pick fails here.
        const countBy = (orderIds: readonly string[]) =>
          Object.fromEntries([acmeOrderId, betaOrderId].map((id) => [id, orderIds.filter((orderId) => orderId === id).length]));
        expect(countBy(picks.map((row) => row.order_id))).toEqual(countBy(picklist.lines.map((line) => line.orderId)));

        // Each portal sees exactly its own client's orders, and a 404 for the other's.
        const portalA = await portalUser(acmeId);
        const portalB = await portalUser(betaId);
        const listed = async (token: string): Promise<string[]> => {
          const page = await portalGet(token, 'orders?limit=100').expect(200);
          expect(page.body.nextCursor).toBeNull();
          return (page.body.items as { id: string }[]).map((item) => item.id).sort();
        };
        const ordersOf = async (clientId: string): Promise<string[]> =>
          (await sql<{ id: string }[]>`select id from orders where tenant_id = ${tenantId} and client_id = ${clientId}`)
            .map((row) => row.id)
            .sort();
        expect(await listed(portalB.token)).toEqual([betaOrderId]);
        const acmeListed = await listed(portalA.token);
        expect(acmeListed).toEqual(await ordersOf(acmeId));
        expect(acmeListed).toContain(acmeOrderId);
        expect(acmeListed).not.toContain(betaOrderId);
        const acmeDetail = await portalGet(portalA.token, `orders/${acmeOrderId}`).expect(200);
        expect(acmeDetail.body).toMatchObject({ id: acmeOrderId, status: 'dispatched' });
        await portalGet(portalB.token, `orders/${betaOrderId}`).expect(200);
        expectProblem(await portalGet(portalA.token, `orders/${betaOrderId}`), 404, 'not-found');
        expectProblem(await portalGet(portalB.token, `orders/${acmeOrderId}`), 404, 'not-found');
      });
    });

    // ── story 21-10: suspend and reactivate ──────────────────────────────────
    describe('client suspension (story 21-10)', () => {
      const PASSWORD = 'correct-horse-battery';
      let suspId: string;
      let departedId: string;
      let suspSkuId: string;

      function setStatus(clientId: string, status: unknown, token = ownerToken, key: string | null = ulid()): SupertestTest {
        const req = http().patch(`${API}/${tenantId}/clients/${clientId}/status`).set('Authorization', `Bearer ${token}`);
        return (key === null ? req : req.set(KEY_HEADER, key)).send({ status });
      }

      async function statusOf(clientId: string): Promise<string> {
        return (await sql<{ status: string }[]>`select status from clients where id = ${clientId}`)[0]!.status;
      }

      async function auditActions(clientId: string): Promise<string[]> {
        const rows = await sql<{ action: string }[]>`
          select action from audit_events where tenant_id = ${tenantId} and target_id = ${clientId} order by occurred_at, id`;
        return rows.map((row) => row.action);
      }

      function signIn(email: string): SupertestTest {
        return http().post(`${API}/sign-in`).send({ email, password: PASSWORD });
      }

      // Copied from test/portal.spec.ts (`accept` / `portalUser`).
      async function accept(inviteToken: string): Promise<void> {
        await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: inviteToken, password: PASSWORD }).expect(200);
      }

      function invitePortal(clientId: string, email = `portal-${ulid().toLowerCase()}@brand.example`): SupertestTest {
        return http()
          .post(`${API}/${tenantId}/users`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ email, role: 'client', clientId });
      }

      async function portalUser(clientId: string): Promise<{ email: string; token: string }> {
        const email = `portal-${ulid().toLowerCase()}@brand.example`;
        const invited = await invitePortal(clientId, email).expect(201);
        await accept(invited.body.inviteToken as string);
        return { email, token: (await signIn(email).expect(200)).body.accessToken as string };
      }

      function portalMe(token: string): SupertestTest {
        return http().get(`${API}/${tenantId}/portal/me`).set('Authorization', `Bearer ${token}`);
      }

      function announce(token: string): SupertestTest {
        return http()
          .post(`${API}/${tenantId}/portal/inbound/asns`)
          .set('Authorization', `Bearer ${token}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId, asnCode: `ASN-S-${ulid().slice(16)}`, lines: [{ skuId: suspSkuId, announcedQty: 2 }] });
      }

      function draftRateCard(clientId: string): SupertestTest {
        return http()
          .post(`${API}/${tenantId}/clients/${clientId}/rate-cards`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ lines: [{ chargeCode: 'pick', basis: 'per_pick', amountPaise: 300 }] });
      }

      beforeAll(async () => {
        suspId = (await createClient({ code: 'SUSP-A', name: 'Suspendable Brand' }).expect(201)).body.client.id as string;
        departedId = (await createClient({ code: 'GONE-A', name: 'Departed Brand' }).expect(201)).body.client.id as string;
        // Nothing writes `departed` (the story's Never list) — only SQL can.
        await sql`update clients set status = 'departed' where id = ${departedId}`;
        await importCsv(['SUSP-1,Suspendable SKU,pcs,1800,,,'], { clientId: suspId }).expect(201);
        await refreshSkus();
        suspSkuId = sku('SUSP-1');
      });

      it('suspend → 200 suspended, audited client.suspended; a replay re-serves it with no second audit; another body on the key is 422; reactivate → 200 active, audited client.reactivated', async () => {
        const key = ulid();
        const suspended = await setStatus(suspId, 'suspended', ownerToken, key).expect(200);
        expect(suspended.body.client).toMatchObject({ id: suspId, code: 'SUSP-A', status: 'suspended', systemOwned: false });
        expect(await statusOf(suspId)).toBe('suspended');
        const audit = await sql`select action, target_type, reference from audit_events where tenant_id = ${tenantId} and target_id = ${suspId} and action = 'client.suspended'`;
        expect(audit).toEqual([{ action: 'client.suspended', target_type: 'client', reference: key }]);

        const replay = await setStatus(suspId, 'suspended', ownerToken, key).expect(200);
        expect(replay.body).toEqual(suspended.body);
        expectProblem(await setStatus(suspId, 'active', ownerToken, key), 422, 'idempotency-key-reuse');

        const reactivated = await setStatus(suspId, 'active').expect(200);
        expect(reactivated.body.client).toMatchObject({ id: suspId, status: 'active' });
        expect(await statusOf(suspId)).toBe('active');
        expect(await auditActions(suspId)).toEqual(['client.created', 'client.suspended', 'client.reactivated']);
      });

      it('a same-status request is a no-op: 200 with the current client, no write, no audit — but the key IS stored, under the pinned fingerprint (golden)', async () => {
        const before = await sql<{ updated_at: string }[]>`select updated_at::text from clients where id = ${suspId}`;
        const auditBefore = await auditActions(suspId);
        const key = noOpIdempotencyKey(tenantId, ulid(), 'clients.updateStatus:same-status');
        const res = await setStatus(suspId, 'active', ownerToken, key).expect(200);
        expect(res.body.client).toMatchObject({ id: suspId, status: 'active' });
        expect(await sql`select updated_at::text from clients where id = ${suspId}`).toEqual(before);
        expect(await auditActions(suspId)).toEqual(auditBefore);
        const stored = await sql<{ payload_hash: string; response_snapshot: { client: { status: string } } }[]>`
          select payload_hash, response_snapshot from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
        // The key order is the contract: arm, tenantId, clientId, status.
        const golden = createHash('sha256')
          .update(`{"arm":"status","tenantId":"${tenantId}","clientId":"${suspId}","status":"active"}`, 'utf8')
          .digest('hex');
        expect(stored).toHaveLength(1);
        expect(stored[0]!.payload_hash).toBe(golden);
        expect(stored[0]!.response_snapshot.client.status).toBe('active');
      });

      it('a late retry of a stored no-op replays its snapshot and never re-applies after someone else changed the status', async () => {
        await setStatus(suspId, 'suspended').expect(200);
        const k = noOpIdempotencyKey(tenantId, ulid(), 'clients.updateStatus:same-status');
        const noop = await setStatus(suspId, 'suspended', ownerToken, k).expect(200);
        expect(noop.body.client.status).toBe('suspended');
        await setStatus(suspId, 'active', ownerToken, ulid()).expect(200);
        const auditBefore = await auditActions(suspId);
        const updatedBefore = await sql`select updated_at::text from clients where id = ${suspId}`;

        const late = await setStatus(suspId, 'suspended', ownerToken, k).expect(200);
        expect(late.body).toEqual(noop.body);
        expect(late.body.client.status).toBe('suspended');
        // No write: the client stays active, nothing audited, nothing touched.
        expect(await statusOf(suspId)).toBe('active');
        expect(await auditActions(suspId)).toEqual(auditBefore);
        expect(await sql`select updated_at::text from clients where id = ${suspId}`).toEqual(updatedBefore);
      });

      it('refusals: self 400, departed 409 client-not-active, a bad body 400, a non-owner 403 role-denied, another tenant 403 permission-denied, unknown or foreign 404, malformed id 400, no key 400 idempotency-key-required', async () => {
        const self = await setStatus(selfClientId, 'suspended');
        expectProblem(self, 400, 'validation-failed');
        expect(self.body.detail).toMatch(/self client cannot be suspended or reactivated/);

        const departed = await setStatus(departedId, 'active');
        expectProblem(departed, 409, 'client-not-active');
        expect(departed.body.detail).toBe('Client "GONE-A" has departed — its status cannot change.');
        expectProblem(await setStatus(departedId, 'suspended'), 409, 'client-not-active');
        expect(await statusOf(departedId)).toBe('departed');

        for (const bad of ['departed', 'gone', '', null, 1]) {
          expectProblem(await setStatus(suspId, bad), 400, 'validation-failed');
        }
        expectProblem(
          await http().patch(`${API}/${tenantId}/clients/${suspId}/status`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({}),
          400,
          'validation-failed',
        );

        for (const token of [opsToken, accountantToken, operatorWebToken]) {
          expectProblem(await setStatus(suspId, 'suspended', token), 403, 'role-denied');
        }
        expectProblem(await setStatus(suspId, 'suspended', otherTenant.ownerToken), 403, 'permission-denied');
        expectProblem(await setStatus(uuidv7(), 'suspended'), 404, 'not-found');
        expectProblem(await setStatus(otherTenant.clientId, 'suspended'), 404, 'not-found');
        expectProblem(await setStatus('not-a-uuid', 'suspended'), 400, 'validation-failed');
        expectProblem(await setStatus(suspId, 'suspended', ownerToken, null), 400, 'idempotency-key-required');
        expect(await statusOf(suspId)).toBe('active');
      });

      it('the command is its own boundary: a status outside the targets is 400 before any transaction', async () => {
        const actor = (await sql<{ id: string }[]>`select id from users where tenant_id = ${tenantId} and role = 'owner' limit 1`)[0]!.id;
        const error = (await app
          .get(ClientsCommand)
          .updateStatus({ tenantId, actorUserId: actor, clientId: suspId, status: 'departed' }, ulid())
          .catch((caught: unknown) => caught)) as ProblemException;
        expect(error).toBeInstanceOf(ProblemException);
        expect(error.getStatus()).toBe(400);
        expect(error.getResponse()).toMatchObject({ code: 'validation-failed' });
        expect(await statusOf(suspId)).toBe('active');
        expect([...CLIENT_STATUS_TARGETS]).toEqual(['active', 'suspended']);
      });

      it('suspension makes every gate reachable without SQL — and operator work continues (an order is 201)', async () => {
        const portal = await portalUser(suspId);
        await setStatus(suspId, 'suspended').expect(200);
        try {
          expectProblem(await draftRateCard(suspId), 409, 'client-not-active');
          expectProblem(await invitePortal(suspId), 409, 'client-not-active');
          expectProblem(await announce(portal.token), 403, 'client-suspended');
          // Decision 1: operator work for a suspended client behaves as today.
          await createOrder([{ skuId: suspSkuId, quantity: 1 }]).expect(201);
        } finally {
          await setStatus(suspId, 'active').expect(200);
        }
        await draftRateCard(suspId).expect(201);
        await announce(portal.token).expect(201);
      });

      it('portal end to end: signed in → suspended (me and sign-in 403 client-suspended) → reactivated (the same token works again)', async () => {
        const portal = await portalUser(suspId);
        await portalMe(portal.token).expect(200);

        await setStatus(suspId, 'suspended').expect(200);
        expectProblem(await portalMe(portal.token), 403, 'client-suspended');
        expectProblem(await signIn(portal.email), 403, 'client-suspended');

        await setStatus(suspId, 'active').expect(200);
        const me = await portalMe(portal.token).expect(200);
        expect(me.body.client).toEqual({ id: suspId, code: 'SUSP-A', name: 'Suspendable Brand' });
        await signIn(portal.email).expect(200);
      });

      describe('races (deterministic: parked waiters, pg_blocking_pids)', () => {

        it('a draft, a portal announce and a portal-user invite parked behind a committing suspend are all refused', async () => {
          const portal = await portalUser(suspId);
          const inviteEmail = `portal-${ulid().toLowerCase()}@brand.example`;
          const usersOfClient = async () =>
            (await sql<{ n: number }[]>`select count(*)::int as n from users where client_id = ${suspId}`)[0]!.n;
          const usersBefore = await usersOfClient();
          const documentCounts = async () => ({
            cards: (await sql<{ n: number }[]>`select count(*)::int as n from rate_cards where client_id = ${suspId}`)[0]!.n,
            asns: (await sql<{ n: number }[]>`select count(*)::int as n from advance_shipment_notices where client_id = ${suspId}`)[0]!.n,
          });
          const before = await documentCounts();
          const holder = handle();
          let drafting: Promise<request.Response> | undefined;
          let announcing: Promise<request.Response> | undefined;
          let inviting: Promise<request.Response> | undefined;
          try {
            await holder.begin(async (tx) => {
              const locked = (await tx`
                select pg_backend_pid() as pid from clients where tenant_id = ${tenantId} and id = ${suspId} for update
              `) as unknown as { pid: number }[];
              await tx`update clients set status = 'suspended', updated_at = now() where id = ${suspId}`;
              drafting = (async () => draftRateCard(suspId))();
              announcing = (async () => announce(portal.token))();
              inviting = (async () => invitePortal(suspId, inviteEmail))();
              // All three gates must be ON the lock — an unlocked status read
              // would never park here, and this throws.
              await waitParked('clients', locked[0]!.pid, 'for share', 3);
            });
            const [draft, asn, invited] = await Promise.all([drafting!, announcing!, inviting!]);
            expectProblem(draft, 409, 'client-not-active');
            expectProblem(asn, 403, 'client-suspended');
            expectProblem(invited, 409, 'client-not-active');
            // Nothing committed past the suspension.
            expect(await documentCounts()).toEqual(before);
            expect(await usersOfClient()).toBe(usersBefore);
            expect(await sql`select 1 from users where email = ${inviteEmail}`).toHaveLength(0);
          } finally {
            // Settle every in-flight request BEFORE the cleanup reactivation,
            // so none can land after it.
            await Promise.allSettled([drafting, announcing, inviting]);
            await holder.end();
            await setStatus(suspId, 'active').expect(200);
          }
        });

        it('a suspend parks behind a gate holding the share lock and succeeds once it is released', async () => {
          const holder = handle();
          let suspending: Promise<request.Response> | undefined;
          let settledEarly = false;
          try {
            await holder.begin(async (tx) => {
              const locked = (await tx`
                select pg_backend_pid() as pid, status from clients where tenant_id = ${tenantId} and id = ${suspId} for share
              `) as unknown as { pid: number; status: string }[];
              expect(locked[0]!.status).toBe('active');
              suspending = (async () => setStatus(suspId, 'suspended'))();
              void suspending.then(() => {
                settledEarly = true;
              });
              await waitParked('clients', locked[0]!.pid, 'for update', 1);
              expect(settledEarly).toBe(false);
            });
            const res = await suspending!;
            expect(res.status).toBe(200);
            expect(res.body.client.status).toBe('suspended');
            expect(await statusOf(suspId)).toBe('suspended');
          } finally {
            await Promise.allSettled([suspending]);
            await holder.end();
            await setStatus(suspId, 'active').expect(200);
          }
        });

        it('two same-key suspends parked on the client lock: the second replays under the lock — both 200, identical, one audit row, one key', async () => {
          const key = ulid();
          const auditCount = async () =>
            (await sql<{ n: number }[]>`select count(*)::int as n from audit_events
              where tenant_id = ${tenantId} and target_id = ${suspId} and action = 'client.suspended' and reference = ${key}`)[0]!.n;
          const holder = handle();
          let first: Promise<request.Response> | undefined;
          let second: Promise<request.Response> | undefined;
          try {
            await holder.begin(async (tx) => {
              const locked = (await tx`
                select pg_backend_pid() as pid from clients where tenant_id = ${tenantId} and id = ${suspId} for update
              `) as unknown as { pid: number }[];
              first = (async () => setStatus(suspId, 'suspended', ownerToken, key))();
              second = (async () => setStatus(suspId, 'suspended', ownerToken, key))();
              await waitParked('clients', locked[0]!.pid, 'for update', 2);
            });
            const [a, b] = await Promise.all([first!, second!]);
            expect([a.status, b.status]).toEqual([200, 200]);
            expect(b.body).toEqual(a.body);
            expect(a.body.client.status).toBe('suspended');
            expect(await auditCount()).toBe(1);
            expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
          } finally {
            await Promise.allSettled([first, second]);
            await holder.end();
            await setStatus(suspId, 'active').expect(200);
          }
        });
      });

      it('the route is in the OpenAPI document with every documented arm', async () => {
        const doc = await http().get('/api/v1/openapi.json').expect(200);
        const op = (doc.body.paths as Record<string, Record<string, { responses: Record<string, unknown> }>>)[
          '/tenants/{tenantId}/clients/{clientId}/status'
        ]?.patch;
        expect(op).toBeDefined();
        expect(Object.keys(op!.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409', '422']);
      });
    });

    // ── the ledger sweep ─────────────────────────────────────────────────────
    it('the ledger append stamps EVERY registered event type with its SKU\'s client, and fails loudly on a missing SKU', async () => {
      const inventory = app.get(InventoryFacade);
      const db = app.get(DATABASE) as Parameters<typeof withTenantTransaction>[0];
      const actor = (await sql<{ id: string }[]>`select id from users where tenant_id = ${tenantId} and role = 'owner' limit 1`)[0]!.id;
      const types = registeredLedgerEventTypes();
      expect(types.length).toBeGreaterThanOrEqual(12);
      for (const type of types) {
        const definition = getLedgerEventType(type)!;
        await withTenantTransaction(db, tenantId, (tx) =>
          inventory.appendLedgerEventInTx(tx, {
            tenantId,
            warehouseId,
            type,
            skuId: sku('ACME-F'),
            quantityDelta: 1000 as SignedQuantity,
            fromBinId: null,
            toBinId: binA,
            batchRef: null,
            serialRef: null,
            actorUserId: actor,
            occurredAt: nowIso(),
            recordedAt: nowIso(),
            referenceDoc: { kind: definition.referenceKinds[0] } as never,
          }),
        );
      }
      const stamped = await sql<{ type: string; client_id: string }[]>`
        select type, client_id from ledger_events where tenant_id = ${tenantId} and sku_id = ${sku('ACME-F')}`;
      expect(new Set(stamped.map((row) => row.type))).toEqual(new Set(types));
      expect(stamped.every((row) => row.client_id === acmeId)).toBe(true);

      await expect(
        withTenantTransaction(db, tenantId, (tx) =>
          inventory.appendLedgerEventInTx(tx, {
            tenantId,
            warehouseId,
            type: 'stock.adjusted',
            skuId: uuidv7(),
            quantityDelta: 1000 as SignedQuantity,
            fromBinId: null,
            toBinId: binA,
            batchRef: null,
            serialRef: null,
            actorUserId: actor,
            occurredAt: nowIso(),
            recordedAt: nowIso(),
            referenceDoc: { kind: 'manual-adjustment', reasonCode: 'probe', note: 'missing sku' },
          }),
        ),
      ).rejects.toThrow(/does not exist in tenant .* no client to attribute/);
    });
  });
});
