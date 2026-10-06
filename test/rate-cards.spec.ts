import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { createDatabase, type Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { istDateOf, istMidnightOf, isIsoDate } from '../src/shared/primitives/time';
import { istDateOf as ewayIstDateOf } from '../src/modules/invoicing/eway-threshold';
import { isIsoDate as ewayIsIsoDate } from '../src/modules/invoicing/eway-json';
import { ArithmeticOverflowError } from '../src/modules/invoicing/arith';
import { rateCardClock } from '../src/modules/billing/rate-card.command';
import { rateCardInForceInTx, rateCardSegmentsInTx } from '../src/modules/billing/billing.facade';
import {
  BASIS_COUNTING_UNIT,
  CHARGE_BASIS,
  CHARGE_CODES,
  RATE_BASES,
  RATE_CARD_STATUSES,
} from '../src/modules/billing/rate-cards';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';

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
function migration0060Statements(): string[] {
  const text = readFileSync(resolve(process.cwd(), 'drizzle/0060_rate_cards.sql'), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** An IST wall-clock instant, e.g. `ist('2026-10-20T10:00')`. */
function ist(local: string): number {
  return Date.parse(`${local}:00+05:30`);
}

type Line = { chargeCode: string; basis: string; amountPaise: number };
const storage = (amountPaise: number): Line => ({ chargeCode: 'storage', basis: 'per_thousand_units_per_day', amountPaise });
const pick = (amountPaise: number): Line => ({ chargeCode: 'pick', basis: 'per_pick', amountPaise });
const inbound = (amountPaise: number): Line => ({ chargeCode: 'inbound_handling', basis: 'per_receipt_line', amountPaise });
const outbound = (amountPaise: number): Line => ({ chargeCode: 'outbound_handling', basis: 'per_order', amountPaise });

describe('story 21-3: rate cards', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Part A — migration 0060 against a database built from the repo's OWN
  // journal trimmed to 0059, applied inside ONE transaction like the runner.
  // ──────────────────────────────────────────────────────────────────────────
  describe('migration 0060, applied to a pre-migration database', () => {
    const PRE_DB = 'wms_s_ratecards_premigration';
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
      folder = mkdtempSync(join(tmpdir(), 'wms-pre-0060-'));
      cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
      rmSync(join(folder, '0060_rate_cards.sql'));
      const journalPath = join(folder, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 59);
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

    it('applies in one transaction: both tables, their triggers and their policies (client-scoped reads, operator-only writes) exist', async () => {
      await sql.begin(async (tx) => {
        for (const statement of migration0060Statements()) {
          await tx.unsafe(statement);
        }
      });
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('rate_cards', 'rate_card_lines') order by table_name`;
      expect(tables.map((row) => row.table_name)).toEqual(['rate_card_lines', 'rate_cards']);
      const triggers = await sql<{ tgname: string }[]>`
        select tgname from pg_trigger where not tgisinternal
          and tgrelid in ('rate_cards'::regclass, 'rate_card_lines'::regclass) order by tgname`;
      expect(triggers.map((row) => row.tgname)).toEqual([
        'rate_card_lines_frozen',
        'rate_card_lines_no_truncate',
        'rate_cards_frozen',
        'rate_cards_no_truncate',
      ]);
      const policies = await sql<{ tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`
        select tablename, policyname, cmd, qual, with_check from pg_policies
        where tablename in ('rate_cards', 'rate_card_lines') order by tablename, cmd`;
      // Per table: a client-scoped SELECT and operator-only INSERT/UPDATE/DELETE.
      expect(policies.map((row) => `${row.tablename}:${row.cmd}`)).toEqual([
        'rate_card_lines:DELETE',
        'rate_card_lines:INSERT',
        'rate_card_lines:SELECT',
        'rate_card_lines:UPDATE',
        'rate_cards:DELETE',
        'rate_cards:INSERT',
        'rate_cards:SELECT',
        'rate_cards:UPDATE',
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
        select relname, relrowsecurity from pg_class where relname in ('rate_cards', 'rate_card_lines') order by relname`;
      expect(rls.every((row) => row.relrowsecurity)).toBe(true);
    });

    it('the fail-fast guard refuses a second application', async () => {
      const guard = migration0060Statements()[0]!;
      await expect(sql.unsafe(guard)).rejects.toThrow(/migration 0060 has already been applied/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part B — the HTTP matrix, the facade reads, and the database guards.
  // ──────────────────────────────────────────────────────────────────────────
  describe('over HTTP and at the database', () => {
    let app: INestApplication;
    let db: Database;
    let sql: postgres.Sql;
    let suiteDb: SuiteDatabase;
    const realNow = rateCardClock.now;

    let tenantId: string;
    let ownerToken: string;
    let accountantToken: string;
    let opsToken: string;
    let selfClientId: string;
    let acmeId: string;
    let suspendedId: string;
    let other: { tenantId: string; ownerToken: string; clientId: string };
    /** The card ids the matrix walks, by name. */
    const cards = new Map<string, string>();

    const http = () => request(app.getHttpServer());

    /** Move the command clock (restoreMocks would undo a spy between tests, so assign). */
    function setClock(ms: number): void {
      rateCardClock.now = () => ms;
    }

    async function register(name: string): Promise<{ tenantId: string; ownerToken: string }> {
      const email = `owner-${ulid().toLowerCase()}@example.com`;
      const registered = await http()
        .post(API)
        .set(KEY_HEADER, ulid())
        .send({ name, ownerEmail: email, password: 'correct-horse-battery' })
        .expect(201);
      const token = (
        await http().post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200)
      ).body.accessToken as string;
      return { tenantId: registered.body.tenant.id as string, ownerToken: token };
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

    async function createClient(code: string): Promise<string> {
      return (
        await http()
          .post(`${API}/${tenantId}/clients`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, name: `${code} Brand` })
          .expect(201)
      ).body.client.id as string;
    }

    function draft(clientId: string, lines: Line[], token = accountantToken, key = ulid()): SupertestTest {
      return http()
        .post(`${API}/${tenantId}/clients/${clientId}/rate-cards`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send({ lines });
    }

    function replaceLines(cardId: string, lines: Line[], token = accountantToken, key = ulid()): SupertestTest {
      return http()
        .put(`${API}/${tenantId}/rate-cards/${cardId}/lines`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send({ lines });
    }

    function activate(cardId: string, effectiveFrom: string, token = accountantToken, key = ulid()): SupertestTest {
      return http()
        .post(`${API}/${tenantId}/rate-cards/${cardId}/activate`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send({ effectiveFrom });
    }

    function cancel(cardId: string, token = accountantToken, key = ulid()): SupertestTest {
      return http()
        .post(`${API}/${tenantId}/rate-cards/${cardId}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key);
    }

    function discard(cardId: string, token = accountantToken, key = ulid()): SupertestTest {
      return http()
        .delete(`${API}/${tenantId}/rate-cards/${cardId}`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key);
    }

    function getCard(cardId: string, token = ownerToken): SupertestTest {
      return http().get(`${API}/${tenantId}/rate-cards/${cardId}`).set('Authorization', `Bearer ${token}`);
    }

    function inForce(clientId: string, at?: string, token = ownerToken): SupertestTest {
      const query = at === undefined ? '' : `?at=${encodeURIComponent(at)}`;
      return http().get(`${API}/${tenantId}/clients/${clientId}/rate-cards/in-force${query}`).set('Authorization', `Bearer ${token}`);
    }

    function list(clientId: string, token = ownerToken): SupertestTest {
      return http().get(`${API}/${tenantId}/clients/${clientId}/rate-cards`).set('Authorization', `Bearer ${token}`);
    }

    function expectProblem(res: request.Response, status: number, code: string): void {
      expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
    }

    async function cardRow(id: string): Promise<{ status: string; effective_from: Date | null; effective_to: Date | null }> {
      const rows = await sql<{ status: string; effective_from: Date | null; effective_to: Date | null }[]>`
        select status, effective_from, effective_to from rate_cards where id = ${id}`;
      return rows[0]!;
    }

    beforeAll(async () => {
      suiteDb = await useSuiteDatabase('ratecards');
      app = await createApp(false);
      await app.init();
      db = app.get<Database>(DATABASE);
      sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });

      const owner = await register(`Rate Card Co ${ulid()}`);
      tenantId = owner.tenantId;
      ownerToken = owner.ownerToken;
      accountantToken = await invite('accountant');
      opsToken = await invite('ops_manager');

      const clients = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      selfClientId = clients.body.items[0].id as string;
      acmeId = await createClient('ACME');
      suspendedId = await createClient('SLEEPY');
      // Nothing can suspend a client yet but SQL (clients.md) — the fixture says so.
      await sql`update clients set status = 'suspended' where id = ${suspendedId}`;

      const foreign = await register(`Foreign Co ${ulid()}`);
      const foreignClient = (
        await http()
          .post(`${API}/${foreign.tenantId}/clients`)
          .set('Authorization', `Bearer ${foreign.ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'FOREIGN', name: 'Foreign Brand' })
          .expect(201)
      ).body.client.id as string;
      other = { tenantId: foreign.tenantId, ownerToken: foreign.ownerToken, clientId: foreignClient };
    }, 120_000);

    afterAll(async () => {
      rateCardClock.now = realNow;
      // Teardown: a non-draft card is never deleted (the trigger), so the
      // rows go under session_replication_role = replica — the eway.spec
      // idiom — never TRUNCATE (refused outright).
      if (sql !== undefined) {
        const cleaner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
        try {
          await cleaner.unsafe('set session_replication_role = replica');
          await cleaner.unsafe('DELETE FROM rate_card_lines WHERE tenant_id = ANY($1::uuid[])', [[tenantId, other.tenantId]]);
          await cleaner.unsafe('DELETE FROM rate_cards WHERE tenant_id = ANY($1::uuid[])', [[tenantId, other.tenantId]]);
          await cleaner.unsafe('set session_replication_role = DEFAULT');
        } finally {
          await cleaner.end();
        }
        await sql.end();
      }
      const rawDb = app?.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
      await rawDb?.$client?.end();
      const authDb = app?.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
      await authDb?.$client?.end();
      await app?.close();
      await suiteDb?.drop();
    });

    // ── the shared time primitives (moved from invoicing) ──────────────────
    describe('the IST primitives', () => {
      it('istDateOf / isIsoDate / istMidnightOf live in shared/primitives and invoicing re-exports them', () => {
        expect(istDateOf('2026-10-31T18:29:59.999Z')).toBe('2026-10-31');
        expect(istDateOf('2026-10-31T18:30:00.000Z')).toBe('2026-11-01');
        expect(istMidnightOf('2026-11-01')).toBe('2026-10-31T18:30:00.000Z');
        expect(isIsoDate('2026-02-28')).toBe(true);
        expect(isIsoDate('2026-02-31')).toBe(false);
        expect(isIsoDate('2026-2-01')).toBe(false);
        // The invoicing re-exports answer identically and keep their typed failure.
        expect(ewayIstDateOf('2026-10-31T18:30:00.000Z')).toBe('2026-11-01');
        expect(ewayIsIsoDate).toBe(isIsoDate);
        expect(() => ewayIstDateOf('nope')).toThrow(ArithmeticOverflowError);
        expect(() => istDateOf('nope')).toThrow(RangeError);
      });
    });

    // ── the vocabularies, pinned against the CHECKs ────────────────────────
    describe('the closed vocabularies', () => {
      it('the TS tuples equal the CHECK arms (status, charge_code, basis)', async () => {
        const defs = await sql<{ conname: string; def: string }[]>`
          select conname, pg_get_constraintdef(oid) as def from pg_constraint
          where conname in ('rate_cards_status_check', 'rate_card_lines_charge_code_check', 'rate_card_lines_basis_check')`;
        const armsOf = (conname: string): string[] => {
          const row = defs.find((item) => item.conname === conname);
          expect(row).toBeDefined();
          const arms = [...row!.def.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
          expect(arms.length).toBeGreaterThan(0);
          return arms.sort();
        };
        expect(armsOf('rate_cards_status_check')).toEqual([...RATE_CARD_STATUSES].sort());
        expect(armsOf('rate_card_lines_charge_code_check')).toEqual([...CHARGE_CODES].sort());
        expect(armsOf('rate_card_lines_basis_check')).toEqual([...RATE_BASES].sort());
        // Every basis has its counting unit stated for 21-4.
        expect(Object.keys(BASIS_COUNTING_UNIT).sort()).toEqual([...RATE_BASES].sort());
      });

      it('every charge × basis combination: exactly the four pairs insert, the other twelve are refused (23514)', async () => {
        const cardId = uuidv7();
        await sql`insert into rate_cards (id, tenant_id, client_id, status, created_by)
          values (${cardId}, ${tenantId}, ${acmeId}, 'draft', ${uuidv7()})`;
        const accepted: string[] = [];
        for (const chargeCode of CHARGE_CODES) {
          for (const basis of RATE_BASES) {
            const attempt = sql`insert into rate_card_lines (id, tenant_id, client_id, rate_card_id, charge_code, basis, amount_paise)
              values (${uuidv7()}, ${tenantId}, ${acmeId}, ${cardId}, ${chargeCode}, ${basis}, 100)`;
            if (CHARGE_BASIS[chargeCode] === basis) {
              await attempt;
              accepted.push(`${chargeCode}:${basis}`);
            } else {
              await expect(attempt).rejects.toMatchObject({ code: '23514' });
            }
          }
        }
        expect(accepted).toEqual([
          'storage:per_thousand_units_per_day',
          'inbound_handling:per_receipt_line',
          'pick:per_pick',
          'outbound_handling:per_order',
        ]);
        // A second line for the same charge on one card → the unique index.
        await expect(sql`insert into rate_card_lines (id, tenant_id, client_id, rate_card_id, charge_code, basis, amount_paise)
          values (${uuidv7()}, ${tenantId}, ${acmeId}, ${cardId}, 'pick', 'per_pick', 200)`).rejects.toMatchObject({ code: '23505' });
        // The amount range: 0 and 10,000,000 admitted, -1 and 10,000,001 refused.
        await sql`update rate_card_lines set amount_paise = 0 where rate_card_id = ${cardId} and charge_code = 'pick'`;
        await sql`update rate_card_lines set amount_paise = 10000000 where rate_card_id = ${cardId} and charge_code = 'pick'`;
        for (const bad of [-1, 10_000_001]) {
          await expect(sql`update rate_card_lines set amount_paise = ${bad} where rate_card_id = ${cardId} and charge_code = 'pick'`).rejects.toMatchObject({ code: '23514' });
        }
        // The draft and its lines are deletable (a draft is the one deletable card).
        await sql`delete from rate_card_lines where rate_card_id = ${cardId}`;
        await sql`delete from rate_cards where id = ${cardId}`;
      });

      it('the card CHECKs: IST midnight, draft ⇔ undated, superseded ⇔ closed, cancelled ⇔ stamped', async () => {
        const insert = (fields: { status: string; from?: string | null; to?: string | null; activated?: boolean; cancelled?: boolean }) =>
          sql`insert into rate_cards (id, tenant_id, client_id, status, effective_from, effective_to, created_by,
                activated_by, activated_at, cancelled_by, cancelled_at)
              values (${uuidv7()}, ${tenantId}, ${acmeId}, ${fields.status}, ${fields.from ?? null}, ${fields.to ?? null}, ${uuidv7()},
                ${fields.activated ? uuidv7() : null}, ${fields.activated ? new Date().toISOString() : null},
                ${fields.cancelled ? uuidv7() : null}, ${fields.cancelled ? new Date().toISOString() : null})`;
        const midnight = istMidnightOf('2030-01-01');
        // Not an IST midnight (UTC midnight; one second past IST midnight).
        await expect(insert({ status: 'active', from: '2030-01-01T00:00:00Z', activated: true })).rejects.toMatchObject({ code: '23514' });
        await expect(insert({ status: 'active', from: '2029-12-31T18:30:01Z', activated: true })).rejects.toMatchObject({ code: '23514' });
        // A draft with a date; an active card without one; an active card without activation stamps.
        await expect(insert({ status: 'draft', from: midnight })).rejects.toMatchObject({ code: '23514' });
        await expect(insert({ status: 'active', activated: true })).rejects.toMatchObject({ code: '23514' });
        await expect(insert({ status: 'active', from: midnight })).rejects.toMatchObject({ code: '23514' });
        // superseded without effective_to; active with one; to ≤ from.
        await expect(insert({ status: 'superseded', from: midnight, activated: true })).rejects.toMatchObject({ code: '23514' });
        await expect(insert({ status: 'active', from: midnight, to: istMidnightOf('2030-02-01'), activated: true })).rejects.toMatchObject({ code: '23514' });
        await expect(insert({ status: 'superseded', from: midnight, to: midnight, activated: true })).rejects.toMatchObject({ code: '23514' });
        // cancelled without stamps; a stamp on an active card.
        await expect(insert({ status: 'cancelled', from: midnight, activated: true })).rejects.toMatchObject({ code: '23514' });
        await expect(insert({ status: 'active', from: midnight, activated: true, cancelled: true })).rejects.toMatchObject({ code: '23514' });
        // An unknown status.
        await expect(insert({ status: 'archived' })).rejects.toMatchObject({ code: '23514' });
      });
    });

    // ── drafts ──────────────────────────────────────────────────────────────
    describe('drafts', () => {
      beforeAll(() => setClock(ist('2026-10-10T09:00')));

      it('an accountant drafts ACME storage ₹3.30 + pick ₹3.00: 201 draft, no date, lines in charge order, audited', async () => {
        const key = ulid();
        const res = await draft(acmeId, [pick(300), storage(330)], accountantToken, key).expect(201);
        expect(res.body.rateCard).toMatchObject({
          tenantId,
          clientId: acmeId,
          status: 'draft',
          effectiveFrom: null,
          effectiveTo: null,
          activatedAt: null,
          lines: [storage(330), pick(300)],
        });
        expect(res.body.rateCard).not.toHaveProperty('effectiveFromAt');
        cards.set('A', res.body.rateCard.id as string);
        // A replay of the same key serves the same draft; the lines in another order hash the same.
        const replay = await draft(acmeId, [storage(330), pick(300)], accountantToken, key).expect(201);
        expect(replay.body).toEqual(res.body);
        const audits = await sql<{ action: string }[]>`
          select action from audit_events where target_type = 'rate_card' and target_id = ${res.body.rateCard.id as string}`;
        expect(audits.map((row) => row.action)).toEqual(['rate_card.drafted']);
      });

      it('the owner drafts too; the same key with a different body is 422', async () => {
        const key = ulid();
        await draft(acmeId, [storage(100)], ownerToken, key).expect(201);
        expectProblem(await draft(acmeId, [storage(101)], ownerToken, key), 422, 'idempotency-key-reuse');
      });

      it('a bad pair, a duplicate charge, an out-of-range or fractional amount, an unknown code: 400 validation-failed', async () => {
        const bad: Line[][] = [
          [{ chargeCode: 'storage', basis: 'per_pick', amountPaise: 100 }],
          [storage(100), storage(200)],
          [storage(10_000_001)],
          [storage(-1)],
          [storage(1.5)],
          [{ chargeCode: 'pallet', basis: 'per_order', amountPaise: 1 }],
          [storage(1), pick(1), inbound(1), outbound(1), storage(2)],
        ];
        for (const lines of bad) {
          expectProblem(await draft(acmeId, lines), 400, 'validation-failed');
        }
        // The cap itself and ₹0 are admitted (₹0 = billed at zero).
        const edge = await draft(acmeId, [storage(10_000_000), pick(0)]).expect(201);
        expect(edge.body.rateCard.lines).toEqual([storage(10_000_000), pick(0)]);
      });

      it("the tenant's own client → 400; a suspended client → 409 client-not-active; unknown/foreign → 404; malformed → 400", async () => {
        expectProblem(await draft(selfClientId, [storage(1)]), 400, 'validation-failed');
        expectProblem(await draft(suspendedId, [storage(1)]), 409, 'client-not-active');
        expectProblem(await draft(uuidv7(), [storage(1)]), 404, 'not-found');
        expectProblem(await draft(other.clientId, [storage(1)]), 404, 'not-found');
        expectProblem(await draft('not-a-uuid', [storage(1)]), 400, 'validation-failed');
        expectProblem(await list(other.clientId), 404, 'not-found');
        // Another tenant's path: permission-denied.
        const res = await http()
          .get(`${API}/${other.tenantId}/clients/${other.clientId}/rate-cards`)
          .set('Authorization', `Bearer ${ownerToken}`);
        expectProblem(res, 403, 'permission-denied');
      });

      it('an ops manager reads every card but edits none: 403 role-denied on each mutation', async () => {
        const id = cards.get('A')!;
        expectProblem(await draft(acmeId, [storage(1)], opsToken), 403, 'role-denied');
        expectProblem(await replaceLines(id, [storage(1)], opsToken), 403, 'role-denied');
        expectProblem(await activate(id, '2026-10-10', opsToken), 403, 'role-denied');
        expectProblem(await cancel(id, opsToken), 403, 'role-denied');
        expectProblem(await discard(id, opsToken), 403, 'role-denied');
        expect((await list(acmeId, opsToken).expect(200)).body.items.length).toBeGreaterThan(0);
        expect((await getCard(id, opsToken).expect(200)).body.rateCard.id).toBe(id);
        await inForce(acmeId, undefined, opsToken).expect(200);
      });

      it('replace a draft’s lines (200, replayable) and discard a draft (204; a replay 204; a repeat 404)', async () => {
        const id = (await draft(acmeId, [storage(1)]).expect(201)).body.rateCard.id as string;
        const key = ulid();
        const replaced = await replaceLines(id, [outbound(1500), inbound(250)], accountantToken, key).expect(200);
        expect(replaced.body.rateCard.lines).toEqual([inbound(250), outbound(1500)]);
        expect((await replaceLines(id, [inbound(250), outbound(1500)], accountantToken, key).expect(200)).body).toEqual(replaced.body);
        expect((await getCard(id).expect(200)).body.rateCard.lines).toEqual([inbound(250), outbound(1500)]);
        // To zero lines — a draft may be empty.
        expect((await replaceLines(id, []).expect(200)).body.rateCard.lines).toEqual([]);

        const discardKey = ulid();
        await discard(id, accountantToken, discardKey).expect(204);
        await discard(id, accountantToken, discardKey).expect(204);
        expectProblem(await discard(id), 404, 'not-found');
        expectProblem(await getCard(id), 404, 'not-found');
        const lines = await sql`select 1 from rate_card_lines where rate_card_id = ${id}`;
        expect(lines).toHaveLength(0);
        // The discard key cannot settle a cancel (the arm is in the hash).
        expectProblem(await cancel(id, accountantToken, discardKey), 422, 'idempotency-key-reuse');
        const audits = await sql<{ action: string }[]>`
          select action from audit_events where target_type = 'rate_card' and target_id = ${id} order by occurred_at, id`;
        expect(audits.map((row) => row.action)).toEqual([
          'rate_card.drafted',
          'rate_card.lines-replaced',
          'rate_card.lines-replaced',
          'rate_card.discarded',
        ]);
      });

      it('a foreign or unknown card id → 404 on every route', async () => {
        const foreignCard = (
          await http()
            .post(`${API}/${other.tenantId}/clients/${other.clientId}/rate-cards`)
            .set('Authorization', `Bearer ${other.ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ lines: [storage(1)] })
            .expect(201)
        ).body.rateCard.id as string;
        for (const id of [foreignCard, uuidv7()]) {
          expectProblem(await getCard(id), 404, 'not-found');
          expectProblem(await replaceLines(id, [storage(1)]), 404, 'not-found');
          expectProblem(await activate(id, '2026-10-20'), 404, 'not-found');
          expectProblem(await cancel(id), 404, 'not-found');
          expectProblem(await discard(id), 404, 'not-found');
        }
        expectProblem(await getCard('nope'), 400, 'validation-failed');
      });
    });

    // ── activation, supersede, in force, segments, cancel ──────────────────
    describe('the dated lifecycle', () => {
      it('a first card: a past date → 400 rate-card-effective-date; today (IST) → active and in force now', async () => {
        setClock(ist('2026-10-10T09:00'));
        const a = cards.get('A')!;
        expectProblem(await activate(a, '2026-10-09'), 400, 'rate-card-effective-date');
        expectProblem(await activate(a, '2026-02-31'), 400, 'validation-failed');
        expectProblem(await activate(a, '10/10/2026'), 400, 'validation-failed');
        const res = await activate(a, '2026-10-10').expect(200);
        expect(res.body.rateCard).toMatchObject({ status: 'active', effectiveFrom: '2026-10-10', effectiveTo: null });
        expect(res.body.rateCard.activatedAt).not.toBeNull();
        const now = await inForce(acmeId).expect(200);
        expect(now.body.rateCard.id).toBe(a);
        expect(now.body.asOf).toBe(new Date(ist('2026-10-10T09:00')).toISOString());
        // The stored boundary is the IST-midnight instant.
        expect((await cardRow(a)).effective_from!.toISOString()).toBe('2026-10-09T18:30:00.000Z');
      });

      it('a replacement effective today → 400 rate-card-effective-date (tomorrow at the earliest)', async () => {
        setClock(ist('2026-10-20T10:00'));
        const b = (await draft(acmeId, [storage(400), pick(300), outbound(1500)]).expect(201)).body.rateCard.id as string;
        cards.set('B', b);
        const res = await activate(b, '2026-10-20');
        expectProblem(res, 400, 'rate-card-effective-date');
        expect(res.body.detail).toContain('2026-10-21');
      });

      it('B effective 2026-11-01: A superseded with effective_to 11-01 IST; B active; both audited', async () => {
        const res = await activate(cards.get('B')!, '2026-11-01').expect(200);
        expect(res.body.rateCard).toMatchObject({ status: 'active', effectiveFrom: '2026-11-01', effectiveTo: null });
        const a = (await getCard(cards.get('A')!).expect(200)).body.rateCard;
        expect(a).toMatchObject({ status: 'superseded', effectiveFrom: '2026-10-10', effectiveTo: '2026-11-01' });
        expect((await cardRow(cards.get('A')!)).effective_to!.toISOString()).toBe('2026-10-31T18:30:00.000Z');
        const audits = await sql<{ action: string; target_id: string }[]>`
          select action, target_id from audit_events where target_type = 'rate_card'
            and action in ('rate_card.superseded', 'rate_card.activated') and target_id in (${cards.get('A')!}, ${cards.get('B')!})
          order by action, target_id`;
        expect(audits).toEqual([
          { action: 'rate_card.activated', target_id: cards.get('A')! },
          { action: 'rate_card.activated', target_id: cards.get('B')! },
          { action: 'rate_card.superseded', target_id: cards.get('A')! },
        ]);
        // The list: drafts first, then effective_from descending.
        const items = (await list(acmeId).expect(200)).body.items as { status: string; effectiveFrom: string | null; id: string }[];
        const firstDated = items.findIndex((item) => item.effectiveFrom !== null);
        expect(items.slice(0, firstDated).every((item) => item.status === 'draft')).toBe(true);
        expect(items.slice(firstDated).map((item) => item.id)).toEqual([cards.get('B'), cards.get('A')]);
      });

      it('out of order: a card dated on or before the latest card → 409 rate-card-effective-overlap', async () => {
        const x = (await draft(acmeId, [storage(500)]).expect(201)).body.rateCard.id as string;
        cards.set('X', x);
        expectProblem(await activate(x, '2026-10-25'), 409, 'rate-card-effective-overlap');
        expectProblem(await activate(x, '2026-11-01'), 409, 'rate-card-effective-overlap');
      });

      it('a card with no lines → 409 rate-card-no-lines', async () => {
        const empty = (await draft(acmeId, []).expect(201)).body.rateCard.id as string;
        expectProblem(await activate(empty, '2026-12-01'), 409, 'rate-card-no-lines');
      });

      it('an activated card never changes through the API: edit, discard, re-activate → 409 rate-card-not-draft', async () => {
        const b = cards.get('B')!;
        expectProblem(await replaceLines(b, [storage(1)]), 409, 'rate-card-not-draft');
        expectProblem(await discard(b), 409, 'rate-card-not-draft');
        expectProblem(await activate(b, '2026-12-01'), 409, 'rate-card-not-draft');
      });

      it('in force at 10-31 23:00 IST is A; at 11-01 00:00 IST it is B; a bad `at` is 400', async () => {
        expect((await inForce(acmeId, '2026-10-31T17:30:00Z').expect(200)).body).toMatchObject({
          rateCard: { id: cards.get('A') },
          asOf: '2026-10-31T17:30:00.000Z',
        });
        expect((await inForce(acmeId, '2026-10-31T18:29:59.999Z').expect(200)).body.rateCard.id).toBe(cards.get('A'));
        expect((await inForce(acmeId, '2026-10-31T18:30:00Z').expect(200)).body.rateCard).toMatchObject({
          id: cards.get('B'),
          lines: [storage(400), pick(300), outbound(1500)],
        });
        // Before A began: nothing is in force — null, not 404.
        expect((await inForce(acmeId, '2026-10-09T18:29:59Z').expect(200)).body.rateCard).toBeNull();
        expect((await inForce(acmeId, '2026-10-09T18:30:00Z').expect(200)).body.rateCard.id).toBe(cards.get('A'));
        for (const bad of ['2026-10-31T23:00:00+05:30', 'nope', '2026-10-31', '2026-02-31T00:00:00Z']) {
          expectProblem(await inForce(acmeId, bad), 400, 'validation-failed');
        }
        expectProblem(await inForce(uuidv7()), 404, 'not-found');
        // A client with no card at all: null.
        expect((await inForce(suspendedId).expect(200)).body.rateCard).toBeNull();
      });

      it('segments over 10-15 → 11-15 (IST): [A 10-15→11-01), [B 11-01→11-15), each with its lines', async () => {
        const segments = await withTenantTransaction(db, tenantId, (tx) =>
          rateCardSegmentsInTx(tx, tenantId, acmeId, istMidnightOf('2026-10-15'), istMidnightOf('2026-11-15')),
        );
        expect(
          segments.map((segment) => ({ card: segment.card.id, from: segment.from, to: segment.to, lines: segment.lines })),
        ).toEqual([
          { card: cards.get('A'), from: '2026-10-14T18:30:00.000Z', to: '2026-10-31T18:30:00.000Z', lines: [storage(330), pick(300)] },
          { card: cards.get('B'), from: '2026-10-31T18:30:00.000Z', to: '2026-11-14T18:30:00.000Z', lines: [storage(400), pick(300), outbound(1500)] },
        ]);
        // A period inside one card is one segment; a period before every card is none.
        const inside = await withTenantTransaction(db, tenantId, (tx) =>
          rateCardSegmentsInTx(tx, tenantId, acmeId, istMidnightOf('2026-10-16'), istMidnightOf('2026-10-17')),
        );
        expect(inside.map((segment) => segment.card.id)).toEqual([cards.get('A')]);
        const before = await withTenantTransaction(db, tenantId, (tx) =>
          rateCardSegmentsInTx(tx, tenantId, acmeId, istMidnightOf('2026-01-01'), istMidnightOf('2026-02-01')),
        );
        expect(before).toEqual([]);
        // The instant read on the same seam.
        const atB = await withTenantTransaction(db, tenantId, (tx) =>
          rateCardInForceInTx(tx, tenantId, acmeId, '2026-11-20T00:00:00.000Z'),
        );
        expect(atB?.id).toBe(cards.get('B'));
      });

      it('cancel B (effective 11-01, today 10-20): B cancelled and never in force; A active and open-ended again', async () => {
        const key = ulid();
        const res = await cancel(cards.get('B')!, accountantToken, key).expect(200);
        expect(res.body.rateCard).toMatchObject({ status: 'cancelled', effectiveFrom: '2026-11-01', effectiveTo: null });
        expect(res.body.rateCard.cancelledAt).not.toBeNull();
        expect((await cancel(cards.get('B')!, accountantToken, key).expect(200)).body).toEqual(res.body);
        expect((await getCard(cards.get('A')!).expect(200)).body.rateCard).toMatchObject({ status: 'active', effectiveTo: null });
        expect((await inForce(acmeId, '2026-11-20T00:00:00Z').expect(200)).body.rateCard.id).toBe(cards.get('A'));
        // The cancelled card never appears in a segment: A covers the whole period.
        const segments = await withTenantTransaction(db, tenantId, (tx) =>
          rateCardSegmentsInTx(tx, tenantId, acmeId, istMidnightOf('2026-10-15'), istMidnightOf('2026-11-15')),
        );
        expect(segments.map((segment) => [segment.card.id, segment.from, segment.to])).toEqual([
          [cards.get('A'), '2026-10-14T18:30:00.000Z', '2026-11-14T18:30:00.000Z'],
        ]);
        const audits = await sql<{ action: string }[]>`
          select action from audit_events where target_type = 'rate_card' and target_id = ${cards.get('A')!} order by occurred_at, id`;
        expect(audits.map((row) => row.action)).toEqual([
          'rate_card.drafted',
          'rate_card.activated',
          'rate_card.superseded',
          'rate_card.reopened',
        ]);
      });

      it('not cancellable: a cancelled card, a card already in force, a draft → 409 rate-card-not-cancellable', async () => {
        expectProblem(await cancel(cards.get('B')!), 409, 'rate-card-not-cancellable');
        expectProblem(await cancel(cards.get('A')!), 409, 'rate-card-not-cancellable');
        expectProblem(await cancel(cards.get('X')!), 409, 'rate-card-not-cancellable');
        // A cancelled card no longer blocks its date: X takes 11-01 now.
        await activate(cards.get('X')!, '2026-11-01').expect(200);
        expect((await getCard(cards.get('A')!).expect(200)).body.rateCard.effectiveTo).toBe('2026-11-01');
        // Once X's date arrives it is in force and can no longer be cancelled.
        setClock(ist('2026-11-01T00:00'));
        const res = await cancel(cards.get('X')!);
        expectProblem(res, 409, 'rate-card-not-cancellable');
        expect(res.body.detail).toContain('2026-11-01');
        setClock(ist('2026-10-20T10:00'));
      });
    });

    // ── direct SQL tampering ────────────────────────────────────────────────
    describe('the freeze triggers (direct SQL)', () => {
      it('a line of an activated card: INSERT, UPDATE of its amount, re-pointing either way, DELETE — all refused', async () => {
        const a = cards.get('A')!;
        const draftId = (await draft(acmeId, [storage(1)]).expect(201)).body.rateCard.id as string;
        const frozen = /is not a draft .* its lines are frozen/;
        await expect(sql`insert into rate_card_lines (id, tenant_id, client_id, rate_card_id, charge_code, basis, amount_paise)
          values (${uuidv7()}, ${tenantId}, ${acmeId}, ${a}, 'outbound_handling', 'per_order', 1)`).rejects.toThrow(frozen);
        await expect(sql`update rate_card_lines set amount_paise = 1 where rate_card_id = ${a}`).rejects.toThrow(frozen);
        // Re-pointing a frozen line at a draft (the OLD parent is frozen)…
        await expect(sql`update rate_card_lines set rate_card_id = ${draftId} where rate_card_id = ${a} and charge_code = 'pick'`).rejects.toThrow(frozen);
        // …and a draft line at the frozen card (the NEW parent is frozen).
        await expect(sql`update rate_card_lines set rate_card_id = ${a}, charge_code = 'inbound_handling', basis = 'per_receipt_line'
          where rate_card_id = ${draftId}`).rejects.toThrow(frozen);
        await expect(sql`delete from rate_card_lines where rate_card_id = ${a}`).rejects.toThrow(frozen);
        // A line must carry its card's client.
        await expect(sql`insert into rate_card_lines (id, tenant_id, client_id, rate_card_id, charge_code, basis, amount_paise)
          values (${uuidv7()}, ${tenantId}, ${suspendedId}, ${draftId}, 'pick', 'per_pick', 1)`).rejects.toThrow(/carries its card's tenant and client/);
        // A line under a card that does not exist.
        await expect(sql`insert into rate_card_lines (id, tenant_id, client_id, rate_card_id, charge_code, basis, amount_paise)
          values (${uuidv7()}, ${tenantId}, ${acmeId}, ${uuidv7()}, 'pick', 'per_pick', 1)`).rejects.toThrow(/\(missing\)/);
        // Nothing moved.
        expect((await getCard(a).expect(200)).body.rateCard.lines).toEqual([storage(330), pick(300)]);
        // The draft's own line is still editable.
        await sql`update rate_card_lines set amount_paise = 2 where rate_card_id = ${draftId}`;
      });

      it('a card: every non-transition UPDATE, a non-draft DELETE, an identity change — refused; the three transitions admitted', async () => {
        const a = cards.get('A')!; // superseded (by X)
        const x = cards.get('X')!; // active, open
        const b = cards.get('B')!; // cancelled
        const frozenCard = /rate_cards: /;
        await expect(sql`update rate_cards set effective_from = ${istMidnightOf('2026-10-11')} where id = ${a}`).rejects.toThrow(frozenCard);
        await expect(sql`update rate_cards set updated_at = now() where id = ${x}`).rejects.toThrow(frozenCard);
        await expect(sql`update rate_cards set status = 'draft', effective_from = null, activated_at = null, activated_by = null where id = ${x}`).rejects.toThrow(frozenCard);
        await expect(sql`update rate_cards set client_id = ${suspendedId} where id = ${x}`).rejects.toThrow(/identity/);
        await expect(sql`update rate_cards set status = 'active', cancelled_at = null, cancelled_by = null where id = ${b}`).rejects.toThrow(frozenCard);
        await expect(sql`update rate_cards set status = 'cancelled', cancelled_at = now(), cancelled_by = ${uuidv7()} where id = ${a}`).rejects.toThrow(frozenCard);
        // A superseded card's end only ever moves LATER (a cancelled successor's end).
        await expect(sql`update rate_cards set effective_to = ${istMidnightOf('2026-10-25')} where id = ${a}`).rejects.toThrow(frozenCard);
        // Moving it later still keeps every other column frozen.
        await expect(sql`update rate_cards set effective_to = ${istMidnightOf('2026-12-01')}, activated_at = now() where id = ${a}`).rejects.toThrow(frozenCard);
        // A cancel must clear the window (a cancelled card has none).
        await expect(sql`update rate_cards set status = 'cancelled', cancelled_at = now(), cancelled_by = ${uuidv7()} where id = ${a}`).rejects.toThrow(frozenCard);
        for (const id of [a, x, b]) {
          await expect(sql`delete from rate_cards where id = ${id}`).rejects.toThrow(/is never deleted/);
        }
        // A draft still holding lines is not deleted (no orphan lines).
        const withLines = (await draft(acmeId, [storage(7)]).expect(201)).body.rateCard.id as string;
        await expect(sql`delete from rate_cards where id = ${withLines}`).rejects.toThrow(/still has lines/);
        await sql`delete from rate_card_lines where rate_card_id = ${withLines}`;
        await sql`delete from rate_cards where id = ${withLines}`;
        // The transitions themselves go through, in a transaction rolled back
        // after: supersede X, extend it, reopen it, cancel it.
        const ROLLBACK = new Error('rollback');
        await sql
          .begin(async (tx) => {
            await tx`update rate_cards set status = 'superseded', effective_to = ${istMidnightOf('2027-01-01')}, updated_at = now() where id = ${x}`;
            await tx`update rate_cards set effective_to = ${istMidnightOf('2027-02-01')}, updated_at = now() where id = ${x}`;
            await tx`update rate_cards set status = 'active', effective_to = null, updated_at = now() where id = ${x}`;
            await tx`update rate_cards set status = 'superseded', effective_to = ${istMidnightOf('2027-01-01')}, updated_at = now() where id = ${x}`;
            // A superseded (scheduled) card can be cancelled too — its window clears.
            await tx`update rate_cards set status = 'cancelled', effective_to = null, cancelled_at = now(), cancelled_by = ${uuidv7()}, updated_at = now() where id = ${x}`;
            throw ROLLBACK;
          })
          .catch((err: unknown) => {
            if (err !== ROLLBACK) throw err;
          });
        expect((await cardRow(x)).status).toBe('active');
      });

      it('TRUNCATE is refused on both tables', async () => {
        await expect(sql`truncate rate_card_lines`).rejects.toThrow(/never truncated/);
        await expect(sql`truncate rate_cards cascade`).rejects.toThrow(/never truncated/);
      });

      it('RLS: no tenant scope sees zero rows; another tenant’s scope sees zero of ours', async () => {
        const url = new URL(process.env.DATABASE_URL!);
        url.username = 'wms_rls_probe';
        url.password = 'wms_rls_probe';
        const probe = postgres(url.toString(), { max: 1, onnotice: () => undefined });
        try {
          for (const table of ['rate_cards', 'rate_card_lines']) {
            const unscoped = await probe.unsafe(`select count(*)::int as n from ${table}`);
            expect(Number((unscoped[0] as unknown as { n: number }).n)).toBe(0);
            const foreign = await probe.begin(async (tx) => {
              await tx`select set_config('app.tenant_id', ${other.tenantId}, true)`;
              return tx.unsafe(`select count(*)::int as n from ${table} where tenant_id = '${tenantId}'::uuid`);
            });
            expect(Number((foreign[0] as unknown as { n: number }).n)).toBe(0);
            const own = await probe.begin(async (tx) => {
              await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
              return tx.unsafe(`select count(*)::int as n from ${table}`);
            });
            expect(Number((own[0] as unknown as { n: number }).n)).toBeGreaterThan(0);
          }
        } finally {
          await probe.end();
        }
      });
    });

    // ── concurrency and the clock ──────────────────────────────────────────
    describe('serialisation and replay', () => {
      it('two drafts of one client activated at once for the same date: one wins, the loser is checked against it', async () => {
        setClock(ist('2026-10-20T10:00'));
        const conc = await createClient('CONC');
        const first = (await draft(conc, [storage(1)]).expect(201)).body.rateCard.id as string;
        const second = (await draft(conc, [storage(2)]).expect(201)).body.rateCard.id as string;
        const results = await Promise.all([activate(first, '2026-12-01'), activate(second, '2026-12-01')]);
        const statuses = results.map((res) => res.status).sort();
        expect(statuses).toEqual([200, 409]);
        const loser = results.find((res) => res.status === 409)!;
        expect(loser.body.code).toBe('rate-card-effective-overlap');

        // Distinct dates at once: whichever order the lock picks, the cards
        // never overlap and exactly one is open.
        const third = (await draft(conc, [storage(3)]).expect(201)).body.rateCard.id as string;
        const fourth = (await draft(conc, [storage(4)]).expect(201)).body.rateCard.id as string;
        const more = await Promise.all([activate(third, '2026-12-10'), activate(fourth, '2026-12-20')]);
        for (const res of more) expect([200, 409]).toContain(res.status);
        const rows = await sql<{ status: string; effective_from: Date; effective_to: Date | null }[]>`
          select status, effective_from, effective_to from rate_cards
          where client_id = ${conc} and status in ('active', 'superseded') order by effective_from`;
        expect(rows.filter((row) => row.status === 'active' && row.effective_to === null)).toHaveLength(1);
        for (let i = 1; i < rows.length; i++) {
          expect(rows[i - 1]!.effective_to?.getTime()).toBe(rows[i]!.effective_from.getTime());
        }
      });

      it('a retry after IST midnight replays the committed activation (the date rule sits behind the replay)', async () => {
        const night = await createClient('NIGHT');
        setClock(ist('2026-10-20T23:50'));
        const id = (await draft(night, [pick(100)]).expect(201)).body.rateCard.id as string;
        const key = ulid();
        const first = await activate(id, '2026-10-20', accountantToken, key).expect(200);
        setClock(ist('2026-10-21T00:10'));
        const retry = await activate(id, '2026-10-20', accountantToken, key).expect(200);
        expect(retry.body).toEqual(first.body);
        // The rule really would refuse that date now — proven on a fresh card and key.
        const late = (await draft(night, [pick(100)]).expect(201)).body.rateCard.id as string;
        expectProblem(await activate(late, '2026-10-20'), 400, 'rate-card-effective-date');
        setClock(ist('2026-10-20T10:00'));
      });
    });

    describe('cancel beyond the open card, the strict facade, the list bound', () => {
      beforeAll(() => setClock(ist('2026-10-20T10:00')));

      it('cancel B in an A → B → C chain (B superseded but not started): A now runs to C’s date, C from it', async () => {
        const chain = await createClient('CHAIN');
        const a = (await draft(chain, [storage(100)]).expect(201)).body.rateCard.id as string;
        await activate(a, '2026-10-20').expect(200);
        const b = (await draft(chain, [storage(200)]).expect(201)).body.rateCard.id as string;
        await activate(b, '2026-12-01').expect(200);
        const c = (await draft(chain, [storage(300)]).expect(201)).body.rateCard.id as string;
        await activate(c, '2027-01-01').expect(200);
        expect((await getCard(b).expect(200)).body.rateCard).toMatchObject({ status: 'superseded', effectiveTo: '2027-01-01' });

        const res = await cancel(b).expect(200);
        expect(res.body.rateCard).toMatchObject({ status: 'cancelled', effectiveFrom: '2026-12-01', effectiveTo: null });
        expect((await getCard(a).expect(200)).body.rateCard).toMatchObject({ status: 'superseded', effectiveTo: '2027-01-01' });
        expect((await getCard(c).expect(200)).body.rateCard).toMatchObject({ status: 'active', effectiveTo: null });
        const segments = await withTenantTransaction(db, tenantId, (tx) =>
          rateCardSegmentsInTx(tx, tenantId, chain, istMidnightOf('2026-11-15'), istMidnightOf('2027-01-15')),
        );
        expect(segments.map((segment) => [segment.card.id, segment.from, segment.to])).toEqual([
          [a, '2026-11-14T18:30:00.000Z', '2026-12-31T18:30:00.000Z'],
          [c, '2026-12-31T18:30:00.000Z', '2027-01-14T18:30:00.000Z'],
        ]);
        const audits = await sql<{ action: string }[]>`
          select action from audit_events where target_type = 'rate_card' and target_id = ${a} and action = 'rate_card.reopened'`;
        expect(audits).toHaveLength(1);
      });

      it("cancel a client's FIRST scheduled card (no predecessor): nothing is in force", async () => {
        const first = await createClient('FIRST');
        const id = (await draft(first, [pick(100)]).expect(201)).body.rateCard.id as string;
        await activate(id, '2026-11-01').expect(200);
        await cancel(id).expect(200);
        expect((await inForce(first, '2026-11-05T00:00:00Z').expect(200)).body.rateCard).toBeNull();
        // Nothing dated remains: a new first card may again start today.
        const again = (await draft(first, [pick(100)]).expect(201)).body.rateCard.id as string;
        await activate(again, '2026-10-20').expect(200);
      });

      it('activating a draft after its client is suspended → 409 client-not-active; the card stays a draft', async () => {
        const later = await createClient('LATER');
        const id = (await draft(later, [pick(100)]).expect(201)).body.rateCard.id as string;
        await sql`update clients set status = 'suspended' where id = ${later}`;
        expectProblem(await activate(id, '2026-10-20'), 409, 'client-not-active');
        expect((await cardRow(id)).status).toBe('draft');
      });

      it('a cancel replayed with the same key after IST midnight (the card’s date has now arrived) replays', async () => {
        const night = await createClient('CNIGHT');
        setClock(ist('2026-10-20T23:50'));
        const id = (await draft(night, [pick(100)]).expect(201)).body.rateCard.id as string;
        await activate(id, '2026-10-21').expect(200);
        const key = ulid();
        const first = await cancel(id, accountantToken, key).expect(200);
        setClock(ist('2026-10-21T00:10'));
        expect((await cancel(id, accountantToken, key).expect(200)).body).toEqual(first.body);
        // The rule really would refuse now: a card dated today is already in force.
        const today = (await draft(night, [pick(100)]).expect(201)).body.rateCard.id as string;
        await activate(today, '2026-10-21').expect(200);
        expectProblem(await cancel(today), 409, 'rate-card-not-cancellable');
        setClock(ist('2026-10-20T10:00'));
      });

      it('activate racing cancel on one client: serialised, and the dated chain ends consistent', async () => {
        const race = await createClient('RACE');
        const a = (await draft(race, [storage(1)]).expect(201)).body.rateCard.id as string;
        await activate(a, '2026-10-20').expect(200);
        const b = (await draft(race, [storage(2)]).expect(201)).body.rateCard.id as string;
        await activate(b, '2026-11-01').expect(200);
        const c = (await draft(race, [storage(3)]).expect(201)).body.rateCard.id as string;
        const [cancelled, activated] = await Promise.all([cancel(b), activate(c, '2026-11-01')]);
        expect(cancelled.status).toBe(200);
        expect([200, 409]).toContain(activated.status);
        if (activated.status === 409) expect(activated.body.code).toBe('rate-card-effective-overlap');
        const rows = await sql<{ id: string; status: string; effective_from: Date; effective_to: Date | null }[]>`
          select id, status, effective_from, effective_to from rate_cards
          where client_id = ${race} and status in ('active', 'superseded') order by effective_from`;
        expect(rows.filter((row) => row.status === 'active' && row.effective_to === null)).toHaveLength(1);
        for (let i = 1; i < rows.length; i++) {
          expect(rows[i - 1]!.effective_to?.getTime()).toBe(rows[i]!.effective_from.getTime());
        }
        expect(rows.at(-1)!.effective_to).toBeNull();
        expect(rows.map((row) => row.id)).toEqual(activated.status === 200 ? [a, c] : [a]);
      });

      it('activate racing replaceDraftLines on the target: no line ever lands on an active card', async () => {
        const rl = await createClient('RL');
        const id = (await draft(rl, [storage(1)]).expect(201)).body.rateCard.id as string;
        const [activated, replaced] = await Promise.all([
          activate(id, '2026-10-20'),
          replaceLines(id, [storage(2), pick(3)]),
        ]);
        expect(activated.status).toBe(200);
        expect([200, 409]).toContain(replaced.status);
        const stored = (await getCard(id).expect(200)).body.rateCard;
        expect(stored.status).toBe('active');
        // Whatever won, the active card's lines are exactly what activation served.
        expect(stored.lines).toEqual(activated.body.rateCard.lines);
        expect(stored.lines).toEqual(replaced.status === 200 ? [storage(2), pick(3)] : [storage(1)]);
      });

      it('the facade reads refuse an unknown or foreign client (404) and a non-UTC instant, and normalise the instant', async () => {
        for (const client of [uuidv7(), other.clientId]) {
          await expect(
            withTenantTransaction(db, tenantId, (tx) => rateCardInForceInTx(tx, tenantId, client, '2026-11-20T00:00:00Z')),
          ).rejects.toMatchObject({ status: 404, response: { code: 'not-found' } });
          await expect(
            withTenantTransaction(db, tenantId, (tx) =>
              rateCardSegmentsInTx(tx, tenantId, client, istMidnightOf('2026-10-15'), istMidnightOf('2026-11-15')),
            ),
          ).rejects.toMatchObject({ status: 404, response: { code: 'not-found' } });
        }
        for (const bad of ['2026-10-31T23:00:00+05:30', '2026-10-31', 'nope']) {
          await expect(
            withTenantTransaction(db, tenantId, (tx) => rateCardInForceInTx(tx, tenantId, acmeId, bad)),
          ).rejects.toThrow(/valid ISO-8601 UTC instant/);
          await expect(
            withTenantTransaction(db, tenantId, (tx) => rateCardSegmentsInTx(tx, tenantId, acmeId, bad, '2027-01-01T00:00:00Z')),
          ).rejects.toThrow(/valid ISO-8601 UTC instant/);
        }
        // Second-precision and millisecond spellings of one instant answer the same.
        const plain = await withTenantTransaction(db, tenantId, (tx) => rateCardInForceInTx(tx, tenantId, acmeId, '2026-10-31T18:30:00Z'));
        const millis = await withTenantTransaction(db, tenantId, (tx) => rateCardInForceInTx(tx, tenantId, acmeId, '2026-10-31T18:30:00.000Z'));
        expect(plain?.id).toBe(millis?.id);
        expect(plain).not.toBeNull();
      });

      it('the list returns every dated card and caps drafts at the newest 100', async () => {
        const many = await createClient('MANY');
        const dated = (await draft(many, [pick(1)]).expect(201)).body.rateCard.id as string;
        await activate(dated, '2026-10-20').expect(200);
        for (let i = 0; i < 101; i++) {
          await sql`insert into rate_cards (id, tenant_id, client_id, status, created_by, created_at)
            values (${uuidv7()}, ${tenantId}, ${many}, 'draft', ${uuidv7()}, ${new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()})`;
        }
        const items = (await list(many).expect(200)).body.items as { id: string; status: string }[];
        expect(items.filter((item) => item.status === 'draft')).toHaveLength(100);
        expect(items.at(-1)!.id).toBe(dated);
      });
    });

    it('the routes are in the OpenAPI document', async () => {
      const doc = await http().get('/api/v1/openapi.json').expect(200);
      const paths = Object.keys(doc.body.paths as Record<string, unknown>);
      expect(paths).toEqual(
        expect.arrayContaining([
          '/tenants/{tenantId}/clients/{clientId}/rate-cards',
          '/tenants/{tenantId}/clients/{clientId}/rate-cards/in-force',
          '/tenants/{tenantId}/rate-cards/{rateCardId}',
          '/tenants/{tenantId}/rate-cards/{rateCardId}/lines',
          '/tenants/{tenantId}/rate-cards/{rateCardId}/activate',
          '/tenants/{tenantId}/rate-cards/{rateCardId}/cancel',
        ]),
      );
      const inForcePath = (doc.body.paths as Record<string, { get?: { parameters?: { name: string; required?: boolean }[] } }>)[
        '/tenants/{tenantId}/clients/{clientId}/rate-cards/in-force'
      ];
      expect(inForcePath?.get?.parameters?.find((param) => param.name === 'at')?.required).toBe(false);
    });
  });
});
