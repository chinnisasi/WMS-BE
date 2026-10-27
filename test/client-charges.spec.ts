import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import type { Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { createDatabase, type Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { SignedQuantity } from '../src/shared/primitives/quantity';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { getLedgerEventType } from '../src/modules/inventory/ledger-registry';
import { rateCardClock } from '../src/modules/billing/rate-card.command';
import { BillingFacade } from '../src/modules/billing/billing.facade';
import { clientInvoiceClock } from '../src/modules/billing/client-invoices';
import { UQCS } from '../src/modules/invoicing/uqc';
import {
  CHARGE_UNIT_UQC,
  CLIENT_CHARGE_CATEGORIES,
  CLIENT_CHARGE_STATUSES,
  CLIENT_CHARGE_UNITS,
  OTHER_SACS,
  SAC_BY_CATEGORY,
  formatPaiseEnIn,
} from '../src/modules/billing/client-charges';
import { earliestChargeDate, normalizeChargeRecord } from '../src/modules/billing/client-charge.service';
import { ProblemException } from '../src/shared/problem-details/problem.exception';
import { expectAuditRow } from './support/audit-guard';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

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

jest.setTimeout(240_000);

/**
 * Story 5-5a — contract billing: ad-hoc charges (recorded, approved, billed
 * as their own invoice lines) and the minimum monthly charge.
 *
 *   Part A — the pure pieces: the record shape, the date window's floor.
 *   Part B — migration 0099 on a database built from the journal trimmed
 *            before it, applied in one transaction; the issue guard diffed
 *            against its live pre-migration body (A17).
 *   Part C — over HTTP, against real metering: every matrix row (frozen and
 *            amended), the races, the audit rows, the outbox, the policy,
 *            the drill, the portal, the wind-down blocker.
 *
 * The pure compute (the minimum's arithmetic and descriptions, the line
 * order, the gaps) is pinned in `test/client-invoices.spec.ts`.
 */

/** An IST wall-clock instant in ms, e.g. `ist('2026-10-10T10:00')`. */
function ist(local: string): number {
  return Date.parse(`${local}${local.length === 16 ? ':00' : ''}+05:30`);
}
const istIso = (local: string): string => new Date(ist(local)).toISOString();

function problemOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProblemException) return (err.getResponse() as { code: string }).code;
    throw err;
  }
  throw new Error('expected a ProblemException');
}

const T29 = '29AAACT1234A1Z5';
const W27 = '27AAACT1234A1Z6';

describe('story 5-5a: contract billing', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Part A — the pure pieces.
  // ──────────────────────────────────────────────────────────────────────────
  describe('the pure pieces', () => {
    const base = { chargeDate: '2026-10-05', category: 'extra_labour', description: 'Unloading', unit: 'hour', quantity: '2.5', unitRatePaise: 35000 };

    it('the record shape (400, above the transaction): vocabularies, SAC rule, quantity, rate, the amount 1..₹1 crore; "2.5" and "2.50" normalise alike (A18)', () => {
      expect(normalizeChargeRecord(base)).toMatchObject({ quantityMilli: 2500n, amountPaise: 87500, sacCode: null });
      expect(normalizeChargeRecord({ ...base, quantity: '2.50' }).quantityMilli).toBe(2500n);
      for (const bad of [
        { ...base, chargeDate: '2026-02-30' },
        { ...base, category: 'packaging_material' },
        { ...base, description: '   ' },
        { ...base, description: 'x'.repeat(201) },
        { ...base, category: 'other' },
        { ...base, category: 'other', sacCode: '392310' },
        { ...base, sacCode: '996719' },
        { ...base, unit: 'litre' },
        { ...base, quantity: '1.2345' },
        { ...base, quantity: '0' },
        { ...base, quantity: '10000.001' },
        { ...base, quantity: 2.5 },
        { ...base, unitRatePaise: 0 },
        { ...base, unitRatePaise: 10_000_001 },
        { ...base, unitRatePaise: 1.5 },
        { ...base, quantity: '0.001', unitRatePaise: 1 },
        { ...base, quantity: '10000', unitRatePaise: 100_001 },
        { ...base, reference: 'x'.repeat(101) },
        { ...base, clientAuthorizationRef: 'x'.repeat(101) },
        { ...base, evidenceNote: 'x'.repeat(501) },
      ]) {
        expect(problemOf(() => normalizeChargeRecord(bad))).toBe('validation-failed');
      }
      // The cap exactly, and `other` with a services SAC.
      expect(normalizeChargeRecord({ ...base, quantity: '10000', unitRatePaise: 100_000 }).amountPaise).toBe(1_000_000_000);
      expect(normalizeChargeRecord({ ...base, category: 'other', sacCode: '998599' }).sacCode).toBe('998599');
      // Blank optional texts are absent; code points, not UTF-16 units.
      expect(normalizeChargeRecord({ ...base, reference: '  ', evidenceNote: '😀'.repeat(500) })).toMatchObject({ reference: null, evidenceNote: '😀'.repeat(500) });
    });

    it('A10 — the earliest charge date is 1 April of the previous financial year; every unit maps to a real GST UQC', () => {
      expect(earliestChargeDate('2026-11-07')).toBe('2025-04-01');
      expect(earliestChargeDate('2026-04-01')).toBe('2025-04-01');
      expect(earliestChargeDate('2026-03-31')).toBe('2024-04-01');
      for (const unit of CLIENT_CHARGE_UNITS) expect(UQCS as readonly string[]).toContain(CHARGE_UNIT_UQC[unit]);
      expect(CHARGE_UNIT_UQC).toMatchObject({ each: 'NOS', carton: 'CTN', kg: 'KGS', hour: 'OTH' });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part B — migration 0099 on a pre-migration database.
  // ──────────────────────────────────────────────────────────────────────────
  describe('migration 0099, applied to a pre-migration database', () => {
    const PRE_DB = 'wms_s_charges_premigration';
    let sql: ReturnType<typeof postgres>;
    let folder: string;

    function statements(): string[] {
      return readFileSync(resolve(process.cwd(), 'drizzle/0099_contract_billing.sql'), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
    }

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
      await admin(async (db) => {
        await db.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
        await db.unsafe(`drop database if exists "${PRE_DB}"`);
        await db.unsafe(`create database "${PRE_DB}"`);
      });
      folder = mkdtempSync(join(tmpdir(), 'wms-pre-0099-'));
      cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
      rmSync(join(folder, '0099_contract_billing.sql'));
      const journalPath = join(folder, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 98);
      writeFileSync(journalPath, JSON.stringify(journal));
      const db = createDatabase(url.toString());
      await migrate(db, { migrationsFolder: folder });
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
      sql = postgres(url.toString(), { max: 2, onnotice: () => undefined });
    }, 180_000);

    afterAll(async () => {
      await sql?.end();
      rmSync(folder, { recursive: true, force: true });
      await admin(async (db) => {
        await db.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
        await db.unsafe(`drop database if exists "${PRE_DB}"`);
      });
    });

    it('applies in one transaction (its probes roll back): two tables, two policies, three triggers, the new line key — and the issue guard differs from its LIVE body only by the A8/A9 arms (A17)', async () => {
      const guardOf = async () => (await sql<{ prosrc: string }[]>`select prosrc from pg_proc where proname = 'client_invoices_guard'`)[0]!.prosrc;
      const before = await guardOf();
      await sql.begin(async (tx) => {
        for (const statement of statements()) await tx.unsafe(statement);
      });
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'public' and table_name like 'client_charge%' order by table_name`;
      expect(tables.map((row) => row.table_name)).toEqual(['client_charge_policies', 'client_charges']);
      const policies = await sql<{ tablename: string; cmd: string }[]>`select tablename, cmd from pg_policies where tablename like 'client_charge%' order by tablename`;
      expect(policies.map((row) => `${row.tablename}:${row.cmd}`)).toEqual(['client_charge_policies:ALL', 'client_charges:ALL']);
      const triggers = await sql<{ tgname: string }[]>`
        select tgname from pg_trigger where not tgisinternal and tgname like 'client_charge%' order by tgname`;
      expect(triggers.map((row) => row.tgname)).toEqual(['client_charge_policies_no_truncate', 'client_charges_frozen', 'client_charges_no_truncate']);
      const keys = await sql<{ n: string | null; o: string | null }[]>`
        select to_regclass('public.client_invoice_lines_line_key_unique')::text as n, to_regclass('public.client_invoice_lines_invoice_segment_charge_uom_unique')::text as o`;
      expect(keys[0]).toEqual({ n: 'client_invoice_lines_line_key_unique', o: null });

      // A17 — every line of the live pre-migration body survives, in order,
      // except the one unpriced conjunct the metered-codes arm replaces; and
      // every added line belongs to the A8 / A9 arms.
      const after = await guardOf();
      const norm = (text: string) => text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
      const oldLines = norm(before);
      const newLines = norm(after);
      const replaced = 'AND (l."rate_card_id" IS NULL OR l."unit_amount_paise" IS NULL OR l."amount_paise" IS NULL';
      expect(oldLines).toContain(replaced);
      // Multiset difference both ways: what the new body dropped, and what it added.
      const minus = (from: string[], take: string[]): string[] => {
        const rest = [...take];
        return from.filter((line) => {
          const index = rest.indexOf(line);
          if (index === -1) return true;
          rest.splice(index, 1);
          return false;
        });
      };
      expect(minus(oldLines, newLines)).toEqual([replaced]);
      const added = minus(newLines, oldLines);
      expect(added.join('\n')).toContain(`l."charge_code" IN ('storage', 'inbound_handling', 'pick', 'outbound_handling') AND l."rate_card_id" IS NULL`);
      expect(added.join('\n')).toContain('c."bill_month" = NEW."period_start"');
      // Every added RAISE is one of the two new arms or the narrowed unpriced one.
      expect(added.filter((line) => line.startsWith('RAISE')).sort()).toEqual([
        "RAISE EXCEPTION 'client_invoices: invoice % bills an ad-hoc charge another live invoice already bills — it cannot issue', OLD.\"id\";",
        "RAISE EXCEPTION 'client_invoices: invoice % has a pending ad-hoc charge for its month — approve or reject it first', OLD.\"id\";",
        "RAISE EXCEPTION 'client_invoices: invoice % has an ad-hoc line whose charge is not approved for this client, month and GSTIN — it cannot issue', OLD.\"id\";",
      ]);
      for (const table of ['client_charges', 'client_charge_policies', 'client_invoices', 'client_invoice_lines', 'rate_cards']) {
        expect((await sql.unsafe(`select count(*)::int as n from ${table}`))[0]!.n).toBe(0);
      }
    });

    it('the fail-fast guard refuses a second application', async () => {
      await expect(sql.unsafe(statements()[0]!)).rejects.toThrow(/migration 0099: client_charges already exists/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part C — over HTTP.
  // ──────────────────────────────────────────────────────────────────────────
  describe('over HTTP', () => {
    let app: INestApplication;
    let db: Database;
    let sql: postgres.Sql;
    let suiteDb: SuiteDatabase;
    let inventory: InventoryFacade;
    let billing: BillingFacade;
    const realRateCardNow = rateCardClock.now;
    const realInvoiceNow = clientInvoiceClock.now;
    const NOW = ist('2026-11-03T10:00');

    let tenantId: string;
    let ownerToken: string;
    let ownerId: string;
    let acctToken: string;
    let acctId: string;
    let acct2Token: string;
    let acct2Id: string;
    let opsToken: string;
    let opsId: string;
    let portalAcme: string;
    let selfId: string;
    const wh: Record<'w1' | 'w3', string> = { w1: '', w3: '' };
    const bin: Record<'w1' | 'w3', string> = { w1: '', w3: '' };
    const clients = new Map<string, string>();
    const skus = new Map<string, string>();

    const http = () => request(app.getHttpServer());
    const client = (code: string): string => clients.get(code)!;
    const sku = (code: string): string => skus.get(code)!;

    async function invite(role: string, clientId?: string): Promise<{ token: string; userId: string }> {
      const email = `${role}-${ulid().toLowerCase()}@example.com`;
      const invited = await http()
        .post(`${API}/${tenantId}/users`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ email, role, ...(clientId === undefined ? {} : { clientId }) })
        .expect(201);
      await http().post(`${API}/${tenantId}/accept-invite`).set(KEY_HEADER, ulid()).send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' }).expect(200);
      const token = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
      return { token, userId: invited.body.user.id as string };
    }

    async function createWarehouse(code: string, gstin?: string, origin: Record<string, unknown> = testAddress()): Promise<{ warehouseId: string; binId: string }> {
      const warehouseId = (
        await http()
          .post(`${API}/${tenantId}/warehouses`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ origin, code, name: `${code} warehouse`, ...(gstin === undefined ? {} : { gstin }) })
          .expect(201)
      ).body.id as string;
      const zoneId = (
        await http().post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'A', name: 'Aisle A' }).expect(201)
      ).body.id as string;
      const binId = (
        await http()
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ capacity: 100000000, type: 'shelf', code: 'A-01-01' })
          .expect(201)
      ).body.id as string;
      return { warehouseId, binId };
    }

    async function newClient(code: string): Promise<string> {
      const id = (
        await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name: `${code} Brand` }).expect(201)
      ).body.client.id as string;
      clients.set(code, id);
      await http()
        .patch(`${API}/${tenantId}/clients/${id}/tax-details`)
        .set('Authorization', `Bearer ${acctToken}`)
        .set(KEY_HEADER, ulid())
        .send({ legalName: `${code} Private Limited`, billingLine1: '5 Brigade Road', billingCity: 'Bengaluru', billingStateCode: '29', billingPincode: '560025' })
        .expect(200);
      const csv = ['sku_code,name,uom,gst_rate,product,variant_values,kit_components', `${code}-PC,${code} item,each,1800,,,`].join('\n');
      await http()
        .post(`${API}/${tenantId}/catalog/imports`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .field('mode', 'initial')
        .field('clientId', id)
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
        .expect(201);
      const list = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      for (const item of list.body.items as { code: string; id: string }[]) skus.set(item.code, item.id);
      return id;
    }

    async function receive(where: 'w1' | 'w3', skuCode: string, milli: number, at: string): Promise<void> {
      const definition = getLedgerEventType('grn.received')!;
      await withTenantTransaction(db, tenantId, (tx) =>
        inventory.appendLedgerEventInTx(tx, {
          tenantId,
          warehouseId: wh[where],
          type: 'grn.received',
          skuId: sku(skuCode),
          quantityDelta: milli as SignedQuantity,
          fromBinId: null,
          toBinId: bin[where],
          batchRef: null,
          serialRef: null,
          actorUserId: ownerId,
          occurredAt: istIso(at),
          recordedAt: istIso(at),
          referenceDoc: { kind: definition.referenceKinds[0] } as never,
        }),
      );
      const grnId = uuidv7();
      await sql`insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, blind_reason_code, status, device_id, recorded_by, occurred_at, recorded_at)
        values (${grnId}, ${tenantId}, ${wh[where]}, ${'GRN-' + ulid().slice(14)}, null, 'other', 'recorded', ${uuidv7()}, ${ownerId}, ${istIso(at)}, ${istIso(at)})`;
      await sql`insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty) values (${uuidv7()}, ${tenantId}, ${grnId}, ${sku(skuCode)}, 1000, 1000)`;
    }

    async function settle(code: string, where: 'w1' | 'w3'): Promise<void> {
      for (let i = 0; i < 4; i += 1) {
        const tick = await billing.snapshotScope(tenantId, client(code), wh[where], ist('2026-11-01T00:30'));
        if (tick.waiting !== 'commit-guarantee') break;
      }
    }

    const ALL_FOUR = [
      { chargeCode: 'storage', basis: 'per_thousand_units_per_day', amountPaise: 330 },
      { chargeCode: 'inbound_handling', basis: 'per_receipt_line', amountPaise: 500 },
      { chargeCode: 'pick', basis: 'per_pick', amountPaise: 300 },
      { chargeCode: 'outbound_handling', basis: 'per_order', amountPaise: 2000 },
    ];

    function draftCard(clientId: string, lines: Record<string, unknown>[]): SupertestTest {
      return http().post(`${API}/${tenantId}/clients/${clientId}/rate-cards`).set('Authorization', `Bearer ${acctToken}`).set(KEY_HEADER, ulid()).send({ lines });
    }
    async function activate(cardId: string, effectiveFrom = '2026-10-01') {
      rateCardClock.now = () => ist('2026-10-01T09:00');
      try {
        return await http().post(`${API}/${tenantId}/rate-cards/${cardId}/activate`).set('Authorization', `Bearer ${acctToken}`).set(KEY_HEADER, ulid()).send({ effectiveFrom });
      } finally {
        rateCardClock.now = realRateCardNow;
      }
    }

    function record(body: Record<string, unknown>, token = acctToken, key = ulid()): SupertestTest {
      return http()
        .post(`${API}/${tenantId}/client-charges`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send({
          warehouseId: wh.w1,
          chargeDate: '2026-10-05',
          category: 'extra_labour',
          description: 'Unloading a 40-ft container',
          unit: 'hour',
          quantity: '2.5',
          unitRatePaise: 35000,
          ...body,
        });
    }
    function decide(chargeId: string, verb: 'approve' | 'reject' | 'cancel', token = acct2Token, note?: string, key = ulid()): SupertestTest {
      return http()
        .post(`${API}/${tenantId}/client-charges/${chargeId}/${verb}`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send(note === undefined ? {} : { note });
    }
    function prepare(clientId: string, month = '2026-10', key = ulid()) {
      return http().post(`${API}/${tenantId}/clients/${clientId}/invoices`).set('Authorization', `Bearer ${acctToken}`).set(KEY_HEADER, key).send({ month });
    }
    function act(invoiceId: string, verb: 'issue' | 'refresh' | 'void', body: Record<string, unknown> = {}) {
      return http().post(`${API}/${tenantId}/client-invoices/${invoiceId}/${verb}`).set('Authorization', `Bearer ${acctToken}`).set(KEY_HEADER, ulid()).send(body);
    }
    const getInvoice = (invoiceId: string) => http().get(`${API}/${tenantId}/client-invoices/${invoiceId}`).set('Authorization', `Bearer ${opsToken}`);
    function expectProblem(res: request.Response, status: number, code: string): void {
      expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
    }
    const outboxOf = async (chargeId: string) =>
      (await sql<{ type: string; payload: Record<string, unknown> }[]>`select type, payload from outbox_messages where tenant_id = ${tenantId} and payload ->> 'chargeId' = ${chargeId} order by type`).map(
        (row) => ({ type: row.type, payload: row.payload }),
      );

    type Line = { id: string; chargeCode: string; uom: string | null; quantity: string; amountPaise: number | null; description?: string; adhocChargeId?: string; segmentFrom: string; rateCardId: string | null };
    type Invoice = { id: string; status: string; supplierGstin: string | null; invoiceNo: string | null; gaps: { code: string; count?: number }[]; warnings: { code: string }[]; lines: Line[]; replacesInvoiceId: string | null };

    /** The client row held FOR NO KEY UPDATE by a raw transaction (the lock every charge and invoice command takes). */
    async function waitParked(holderPid: number, min: number): Promise<void> {
      const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active' and a.query ilike '%"clients"%'`) as unknown as { pid: number; blockers: number[] }[];
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
        throw new Error(`fewer than ${min} request(s) parked on the client row`);
      } finally {
        await probe.end();
      }
    }

    beforeAll(async () => {
      suiteDb = await useSuiteDatabase('clientcharges');
      app = await createApp(false);
      await app.init();
      db = app.get<Database>(DATABASE);
      inventory = app.get(InventoryFacade);
      billing = app.get(BillingFacade);
      sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
      clientInvoiceClock.now = () => NOW;

      const email = `owner-${ulid().toLowerCase()}@example.com`;
      const registered = await http()
        .post(API)
        .set(KEY_HEADER, ulid())
        .send({ name: `Charges Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery', gstin: T29 })
        .expect(201);
      tenantId = registered.body.tenant.id as string;
      ownerId = registered.body.owner.id as string;
      ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
      ({ token: acctToken, userId: acctId } = await invite('accountant'));
      ({ token: acct2Token, userId: acct2Id } = await invite('accountant'));
      ({ token: opsToken, userId: opsId } = await invite('ops_manager'));

      const w1 = await createWarehouse(`CC1-${ulid().slice(20)}`);
      const w3 = await createWarehouse(`CC3-${ulid().slice(20)}`, W27, testAddress({ city: 'Mumbai', state: 'Maharashtra', pincode: '400001' }));
      wh.w1 = w1.warehouseId;
      wh.w3 = w3.warehouseId;
      bin.w1 = w1.binId;
      bin.w3 = w3.binId;
      const listed = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      selfId = (listed.body.items as { id: string; systemOwned: boolean }[]).find((row) => row.systemOwned)!.id;

      for (const code of ['ACME', 'BETA', 'GAMMA', 'DELTA', 'EPS', 'KAPPA', 'RHO', 'SUSP', 'TAU']) await newClient(code);
      portalAcme = (await invite('client', client('ACME'))).token;

      // October's metered usage: ACME and BETA in W1 (group T29); EPS in W1 AND W3.
      await receive('w1', 'ACME-PC', 1_000_000, '2026-10-03T10:00');
      await receive('w1', 'BETA-PC', 1_000_000, '2026-10-02T10:00');
      await receive('w1', 'EPS-PC', 1_000, '2026-10-02T10:00');
      await receive('w3', 'EPS-PC', 1_000, '2026-10-02T10:00');
      await receive('w1', 'TAU-PC', 1_000_000, '2026-10-02T10:00');
      for (const code of ['ACME', 'BETA', 'TAU']) await settle(code, 'w1');

      // The cards: ACME the four metered rates; BETA the same plus a ₹50,000 minimum.
      await activate((await draftCard(client('ACME'), ALL_FOUR).expect(201)).body.rateCard.id as string).then((res) => expect(res.status).toBe(200));
      const betaCard = await draftCard(client('BETA'), [...ALL_FOUR, { chargeCode: 'minimum_monthly', basis: 'per_month', amountPaise: 5_000_000 }]).expect(201);
      expect(betaCard.body.rateCard.lines.at(-1)).toEqual({ chargeCode: 'minimum_monthly', basis: 'per_month', amountPaise: 5_000_000, minimumCounts: 'all' });
      expect((await activate(betaCard.body.rateCard.id as string)).status).toBe(200);
      const tauCard = await draftCard(client('TAU'), [...ALL_FOUR, { chargeCode: 'minimum_monthly', basis: 'per_month', amountPaise: 5_000_000 }]).expect(201);
      expect((await activate(tauCard.body.rateCard.id as string)).status).toBe(200);

      await http().patch(`${API}/${tenantId}/clients/${client('SUSP')}/status`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ status: 'suspended' }).expect(200);
    }, 240_000);

    afterAll(async () => {
      rateCardClock.now = realRateCardNow;
      clientInvoiceClock.now = realInvoiceNow;
      await sql?.end();
      const rawDb = app?.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
      await rawDb?.$client?.end();
      const authDb = app?.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
      await authDb?.$client?.end();
      await app?.close();
      await suiteDb?.drop();
    });

    afterEach(() => {
      clientInvoiceClock.now = () => NOW;
    });

    it('the vocabularies are pinned against the 0099 CHECKs', async () => {
      const defs = await sql<{ conname: string; def: string }[]>`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('client_charges_category', 'client_charges_unit', 'client_charges_status', 'client_charges_sac_pair')`;
      const values = (name: string): string[] => [...defs.find((row) => row.conname === name)!.def.matchAll(/'([a-z_0-9]+)'::text/g)].map((m) => m[1]!);
      expect(values('client_charges_category')).toEqual([...CLIENT_CHARGE_CATEGORIES]);
      expect(values('client_charges_unit')).toEqual([...CLIENT_CHARGE_UNITS]);
      expect(values('client_charges_status')).toEqual([...CLIENT_CHARGE_STATUSES]);
      const pair = defs.find((row) => row.conname === 'client_charges_sac_pair')!.def;
      for (const [category, sac] of Object.entries(SAC_BY_CATEGORY)) expect(pair).toMatch(new RegExp(`'${category}'::text[^)]*\\)\\)?[^']*'${sac}'`));
      for (const sac of OTHER_SACS) expect(pair).toContain(`'${sac}'::text`);
    });

    it('accountant records (matrix row 1): 201 approved at record, 87,500 paise, billing October under T29; ONE `client_charge.recorded` row (autoApproved), no outbox event; "2.50" replays "2.5" (A18)', async () => {
      const key = ulid();
      const res = await record({ clientId: client('ACME') }, acctToken, key).expect(201);
      expect(res.body.warnings).toEqual([]);
      expect(res.body.charge).toMatchObject({
        status: 'approved',
        amountPaise: 87500,
        quantity: '2.5',
        sacCode: '996719',
        billMonth: '2026-10-01',
        supplierGstin: T29,
        recordedBy: acctId,
        decidedBy: acctId,
        billing: null,
      });
      await expectAuditRow({ tenantId, key, action: 'client_charge.recorded', targetType: 'client_charge', targetId: res.body.charge.id as string, actorUserId: acctId });
      const audit = await sql<{ changes: unknown }[]>`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`;
      expect(audit.map((row) => row.changes)).toEqual([{ status: 'approved', autoApproved: true }]);
      expect(await outboxOf(res.body.charge.id as string)).toEqual([]);
      const replay = await record({ clientId: client('ACME'), quantity: '2.50' }, acctToken, key).expect(201);
      expect(replay.body).toEqual(res.body);
      await expectAuditRow({ tenantId, key, action: 'client_charge.recorded', targetType: 'client_charge', targetId: res.body.charge.id as string, actorUserId: acctId });
      expect((await sql`select id from client_charges where tenant_id = ${tenantId} and client_id = ${client('ACME')}`).length).toBe(1);
    });

    it('the ACME month (rows 2–3, A13): prepare bills the approved charge; ops records → pending + outbox; issue → stale (the gap appears) → 409 invoice-has-gaps; a second accountant approves → stale (the line appears) → issued; frozen afterwards', async () => {
      const prepared = await prepare(client('ACME')).expect(201);
      const draft = (prepared.body.created as Invoice[]).find((row) => row.supplierGstin === T29)!;
      expect(draft.gaps).toEqual([]);
      const adhoc = draft.lines.filter((line) => line.chargeCode === 'adhoc');
      expect(adhoc).toHaveLength(1);
      expect(adhoc[0]).toMatchObject({ uom: 'hour', quantity: '2.5', amountPaise: 87500, rateCardId: null, description: 'Extra labour — Unloading a 40-ft container' });
      // Metered lines first, then the ad-hoc line; metered lines carry no new key.
      expect(draft.lines.at(-1)!.chargeCode).toBe('adhoc');
      for (const line of draft.lines.filter((row) => row.chargeCode !== 'adhoc')) {
        expect(Object.keys(line)).not.toContain('description');
        expect(Object.keys(line)).not.toContain('adhocChargeId');
      }

      const opsKey = ulid();
      const pending = await record({ clientId: client('ACME'), description: 'Relabel the inbound', category: 'relabelling', unit: 'carton', quantity: '120', unitRatePaise: 1500 }, opsToken, opsKey).expect(201);
      expect(pending.body.charge).toMatchObject({ status: 'pending', decidedBy: null, amountPaise: 180000, sacCode: '998540' });
      const pendingId = pending.body.charge.id as string;
      await expectAuditRow({ tenantId, key: opsKey, action: 'client_charge.recorded', targetType: 'client_charge', targetId: pendingId, actorUserId: opsId });
      expect(await outboxOf(pendingId)).toEqual([
        { type: 'client_charge.pending', payload: { chargeId: pendingId, clientId: client('ACME'), warehouseId: wh.w1, amountPaise: 180000 } },
      ]);

      const stale = await act(draft.id, 'issue').expect(200);
      expect(stale.body.outcome).toBe('stale');
      expect(stale.body.invoice.gaps).toEqual([expect.objectContaining({ code: 'adhoc-charge-pending', count: 1 })]);
      const gapped = await act(draft.id, 'issue');
      expectProblem(gapped, 409, 'invoice-has-gaps');

      expectProblem(await decide(pendingId, 'approve', opsToken), 403, 'role-denied');
      const approveKey = ulid();
      const approved = await decide(pendingId, 'approve', acctToken, undefined, approveKey).expect(200);
      expect(approved.body.charge).toMatchObject({ status: 'approved', decidedBy: acctId });
      await expectAuditRow({ tenantId, key: approveKey, action: 'client_charge.approved', targetType: 'client_charge', targetId: pendingId, actorUserId: acctId });
      expect((await outboxOf(pendingId)).map((row) => row.type)).toEqual(['client_charge.approved', 'client_charge.pending']);

      expect((await act(draft.id, 'issue').expect(200)).body.outcome).toBe('stale');
      const issued = await act(draft.id, 'issue').expect(200);
      expect(issued.body.outcome).toBe('issued');
      const lines = issued.body.invoice.lines as Line[];
      expect(lines.filter((line) => line.chargeCode === 'adhoc').map((line) => line.adhocChargeId)).toEqual(
        [adhoc[0]!.adhocChargeId!, pendingId].sort(),
      );
      // A31 — the issue audit names the charges it bills.
      const issueAudit = await sql<{ changes: { adhocChargeIds: string[] } }[]>`
        select changes from audit_events where tenant_id = ${tenantId} and action = 'client_invoice.issued' and target_id = ${draft.id}`;
      expect(issueAudit[0]!.changes.adhocChargeIds.sort()).toEqual([adhoc[0]!.adhocChargeId!, pendingId].sort());
      // The charge's billing link.
      const got = await http().get(`${API}/${tenantId}/client-charges/${pendingId}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect(got.body.charge.billing).toEqual({ invoiceId: draft.id, invoiceNo: issued.body.invoice.invoiceNo, status: 'issued' });

      // AC2 — an approved charge on an issued invoice cannot be cancelled: the command (409) and direct SQL (the guard).
      const before = await sql`select id, amount_paise from client_invoice_lines where invoice_id = ${draft.id} order by id`;
      expectProblem(await decide(pendingId, 'cancel', acctToken, 'wrong client'), 409, 'charge-period-invoiced');
      await expect(
        sql`update client_charges set status = 'cancelled', cancelled_by = ${acctId}, cancelled_at = now(), cancel_note = 'x' where id = ${pendingId}`,
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(sql`delete from client_charges where id = ${pendingId}`).rejects.toMatchObject({ code: 'P0001' });
      expect(await sql`select id, amount_paise from client_invoice_lines where invoice_id = ${draft.id} order by id`).toEqual(before);
    });

    it('A4 — a charge dated in an invoiced month bills on the NEXT open month (true date kept), with `charge-billed-later`; record never answers charge-period-invoiced', async () => {
      const res = await record({ clientId: client('ACME'), chargeDate: '2026-10-20' }).expect(201);
      expect(res.body.charge.billMonth).toBe('2026-11-01');
      expect(res.body.charge.chargeDate).toBe('2026-10-20');
      expect(res.body.warnings.map((warning: { code: string }) => warning.code)).toEqual(['charge-billed-later']);
      // The database refuses a charge born into the invoiced October (code review C8)…
      const late = uuidv7();
      const insertLate = () => sql`insert into client_charges (id, tenant_id, client_id, warehouse_id, supplier_gstin, charge_date, bill_month, category, description,
          sac_code, unit, quantity_milli, unit_rate_paise, amount_paise, status, recorded_by, recorded_at)
        values (${late}, ${tenantId}, ${client('ACME')}, ${wh.w1}, ${T29}, '2026-10-21', '2026-10-01', 'repacking', 'Repack', '998540', 'each', 1000, 100, 100, 'pending', ${opsId}, now())`;
      await expect(insertLate()).rejects.toMatchObject({ code: 'P0001' });
      // …and one that got there anyway (the trigger bypassed, as a restore might) can no longer be approved or rejected (A14).
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`insert into client_charges (id, tenant_id, client_id, warehouse_id, supplier_gstin, charge_date, bill_month, category, description,
            sac_code, unit, quantity_milli, unit_rate_paise, amount_paise, status, recorded_by, recorded_at)
          values (${late}, ${tenantId}, ${client('ACME')}, ${wh.w1}, ${T29}, '2026-10-21', '2026-10-01', 'repacking', 'Repack', '998540', 'each', 1000, 100, 100, 'pending', ${opsId}, now())`;
      });
      expectProblem(await decide(late, 'approve', acctToken), 409, 'charge-period-invoiced');
      expectProblem(await decide(late, 'reject', acctToken, 'no'), 409, 'charge-period-invoiced');
      await expect(sql`update client_charges set status = 'rejected', decided_by = ${acctId}, decided_at = now(), decision_note = 'x' where id = ${late}`).rejects.toMatchObject({ code: 'P0001' });
      // Tidy (under replica — a charge is never deleted otherwise), so the wind-down and list tests do not see it.
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`delete from client_charges where id = ${late}`;
      });
    });

    it('the drill: an ad-hoc line drills to its one charge (reconciles); the portal sees the line’s description and never its charge id; a portal session is refused every charge route', async () => {
      const invoiceId = (
        await sql<{ id: string }[]>`select id from client_invoices where tenant_id = ${tenantId} and client_id = ${client('ACME')} and status = 'issued'`
      )[0]!.id;
      const lines = (await getInvoice(invoiceId).expect(200)).body.invoice.lines as Line[];
      const adhocLine = lines.find((line) => line.chargeCode === 'adhoc')!;
      const drill = await http().get(`${API}/${tenantId}/client-invoices/${invoiceId}/lines/${adhocLine.id}/records`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect(drill.body).toMatchObject({ kind: 'adhoc-charge', invoiceStatus: 'issued', summary: { lineQuantity: adhocLine.quantity, recordsQuantity: adhocLine.quantity, reconciles: true }, nextCursor: null });
      expect(drill.body.records).toHaveLength(1);
      expect(drill.body.records[0]).toMatchObject({ kind: 'adhoc-charge', chargeId: adhocLine.adhocChargeId, category: expect.any(String), status: 'approved', warehouseId: wh.w1 });
      expect(drill.body.records[0]).not.toHaveProperty('evidenceNote');

      const portal = await http().get(`${API}/${tenantId}/portal/invoices/${invoiceId}`).set('Authorization', `Bearer ${portalAcme}`).expect(200);
      const portalLines = portal.body.lines as Record<string, unknown>[];
      const metered = ['amountPaise', 'basis', 'cgstPaise', 'chargeCode', 'gstBps', 'igstPaise', 'quantity', 'sac', 'segmentFrom', 'segmentTo', 'sgstPaise', 'unitAmountPaise', 'uom'];
      for (const line of portalLines) {
        expect(Object.keys(line).sort()).toEqual(line.chargeCode === 'adhoc' ? [...metered, 'description'].sort() : metered);
      }
      expect(portal.text).not.toContain('adhocChargeId');
      // Code review V1 — the portal reads the ad-hoc quantity in units (never milli) and its frozen description.
      const portalAdhoc = portalLines.find((line) => line.chargeCode === 'adhoc')!;
      expect(portalAdhoc).toMatchObject({ quantity: adhocLine.quantity, description: adhocLine.description, uom: adhocLine.uom });
      for (const path of ['client-charges', `client-charges/${adhocLine.adhocChargeId}`, 'client-charge-policy']) {
        expectProblem(await http().get(`${API}/${tenantId}/${path}`).set('Authorization', `Bearer ${portalAcme}`), 403, 'role-denied');
      }
      expectProblem(await record({ clientId: client('ACME') }, portalAcme), 403, 'role-denied');
    });

    it('code review V5 — a credit note on an ad-hoc line carries the line’s description on the operator and the portal note reads', async () => {
      const invoiceId = (
        await sql<{ id: string }[]>`select id from client_invoices where tenant_id = ${tenantId} and client_id = ${client('ACME')} and status = 'issued'`
      )[0]!.id;
      const adhocLine = ((await getInvoice(invoiceId).expect(200)).body.invoice.lines as Line[]).find((line) => line.chargeCode === 'adhoc')!;
      const drafted = await http()
        .post(`${API}/${tenantId}/client-invoices/${invoiceId}/notes`)
        .set('Authorization', `Bearer ${acctToken}`)
        .set(KEY_HEADER, ulid())
        .send({ kind: 'credit', reason: 'excess-billed', reasonNote: 'Half the unloading was ours', lines: [{ invoiceLineId: adhocLine.id, amountPaise: 1000 }] })
        .expect(201);
      expect(drafted.body.note.lines[0]).toMatchObject({ chargeCode: 'adhoc', basis: 'per_unit', description: adhocLine.description });
      const issued = await http().post(`${API}/${tenantId}/client-invoice-notes/${drafted.body.note.id as string}/issue`).set('Authorization', `Bearer ${acct2Token}`).set(KEY_HEADER, ulid()).send({}).expect(200);
      expect(issued.body.note.lines[0].description).toBe(adhocLine.description);
      const portalNote = await http().get(`${API}/${tenantId}/portal/invoice-notes/${drafted.body.note.id as string}`).set('Authorization', `Bearer ${portalAcme}`).expect(200);
      expect(portalNote.body.lines[0]).toMatchObject({ chargeCode: 'adhoc', description: adhocLine.description });
    });

    it('A22 / AC4 — over the ₹10,000 default limit a billing.invoice holder’s own charge pends; their own approve is 409 charge-needs-second-approver; another holder’s approve is 200', async () => {
      const res = await record({ clientId: client('ACME'), chargeDate: '2026-11-02', quantity: '1', unitRatePaise: 2_500_000 }).expect(201);
      expect(res.body.charge).toMatchObject({ status: 'pending', amountPaise: 2_500_000 });
      expectProblem(await decide(res.body.charge.id as string, 'approve', acctToken), 409, 'charge-needs-second-approver');
      await expect(
        sql`update client_charges set status = 'approved', decided_by = ${acctId}, decided_at = now() where id = ${res.body.charge.id as string}`,
      ).rejects.toMatchObject({ code: 'P0001' });
      expect((await decide(res.body.charge.id as string, 'approve', acct2Token).expect(200)).body.charge.decidedBy).toBe(acct2Id);
      // Exactly at the limit is approved at record.
      expect((await record({ clientId: client('ACME'), chargeDate: '2026-11-02', quantity: '1', unitRatePaise: 1_000_000 }).expect(201)).body.charge.status).toBe('approved');
    });

    it('the policy: GET reads the default; a billing.invoice holder PUTs it (audited, replayed); ops is 403; a higher limit approves at record', async () => {
      const read = () => http().get(`${API}/${tenantId}/client-charge-policy`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect((await read()).body).toEqual({ selfApproveLimitPaise: 1_000_000, isDefault: true });
      const put = (limit: unknown, token = acctToken, key = ulid()) =>
        http().put(`${API}/${tenantId}/client-charge-policy`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({ selfApproveLimitPaise: limit });
      expectProblem(await put(5_000_000, opsToken), 403, 'role-denied');
      expectProblem(await put(1_000_000_001), 400, 'validation-failed');
      const key = ulid();
      expect((await put(5_000_000, acctToken, key).expect(200)).body).toEqual({ selfApproveLimitPaise: 5_000_000, isDefault: false });
      expect((await put(5_000_000, acctToken, key).expect(200)).body).toEqual({ selfApproveLimitPaise: 5_000_000, isDefault: false });
      const policyId = (await sql<{ id: string }[]>`select id from client_charge_policies where tenant_id = ${tenantId}`)[0]!.id;
      await expectAuditRow({ tenantId, key, action: 'client_charge_policy.updated', targetType: 'client_charge_policy', targetId: policyId, actorUserId: acctId });
      expect((await read()).body).toEqual({ selfApproveLimitPaise: 5_000_000, isDefault: false });
      expect((await record({ clientId: client('ACME'), chargeDate: '2026-11-03', quantity: '1', unitRatePaise: 2_500_000 }).expect(201)).body.charge.status).toBe('approved');
      await put(1_000_000).expect(200);
    });

    it('the refusals: rounds to zero, `other` without / with a goods SAC, a SAC on a fixed category (400); the date window behind the replay lookup (A10); self 409; suspended 409; unknown warehouse / client 404', async () => {
      const acme = client('ACME');
      for (const body of [
        { quantity: '0.001', unitRatePaise: 1 },
        { category: 'other' },
        { category: 'other', sacCode: '392310' },
        { sacCode: '996719' },
        { chargeDate: '2026-11-04' },
        { chargeDate: '2025-03-31' },
        { warehouseId: 'not-a-uuid' },
      ]) {
        expectProblem(await record({ clientId: acme, ...body }), 400, 'validation-failed');
      }
      const late = await record({ clientId: acme, chargeDate: '2025-04-01' }).expect(201);
      expect(late.body.warnings.map((warning: { code: string }) => warning.code)).toContain('charge-late');
      // Today is accepted; a committed record replays after the clock has moved back past it.
      const key = ulid();
      const today = await record({ clientId: acme, chargeDate: '2026-11-03' }, acctToken, key).expect(201);
      clientInvoiceClock.now = () => ist('2026-11-02T10:00');
      expect((await record({ clientId: acme, chargeDate: '2026-11-03' }, acctToken, key).expect(201)).body).toEqual(today.body);
      expectProblem(await record({ clientId: acme, chargeDate: '2026-11-03' }), 400, 'validation-failed');
      clientInvoiceClock.now = () => NOW;

      expectProblem(await record({ clientId: selfId }), 409, 'client-not-billable');
      expectProblem(await record({ clientId: client('SUSP') }), 409, 'client-not-active');
      expectProblem(await record({ clientId: acme, warehouseId: uuidv7() }), 404, 'not-found');
      expectProblem(await record({ clientId: uuidv7() }), 404, 'not-found');
      expectProblem(await decide(uuidv7(), 'approve', acctToken), 404, 'charge-not-found');
    });

    it('A5 + void (rows "only a charge", "cancel after void"): a client with no events and two approved charges → prepare drafts two ad-hoc lines and issues; void; cancel one → 200; the replacement bills only the other', async () => {
      const gamma = client('GAMMA');
      const first = await record({ clientId: gamma, chargeDate: '2026-10-08' }).expect(201);
      const second = await record({ clientId: gamma, chargeDate: '2026-10-09', category: 'extra_storage', unit: 'day', quantity: '3', unitRatePaise: 2500, description: 'Overflow space' }).expect(201);
      const prepared = await prepare(gamma).expect(201);
      expect(prepared.body.created).toHaveLength(1);
      const draft = prepared.body.created[0] as Invoice;
      expect(draft.gaps).toEqual([]);
      expect(draft.lines.map((line) => [line.chargeCode, line.adhocChargeId])).toEqual([
        ['adhoc', first.body.charge.id],
        ['adhoc', second.body.charge.id],
      ]);
      const issued = await act(draft.id, 'issue').expect(200);
      expect(issued.body.outcome).toBe('issued');
      expectProblem(await decide(first.body.charge.id as string, 'cancel', acctToken, 'entered twice'), 409, 'charge-period-invoiced');
      await act(draft.id, 'void', { note: 'wrong figures' }).expect(200);
      const cancelKey = ulid();
      const cancelled = await decide(first.body.charge.id as string, 'cancel', acctToken, 'entered twice', cancelKey).expect(200);
      expect(cancelled.body.charge).toMatchObject({ status: 'cancelled', cancelNote: 'entered twice', decidedBy: acctId });
      await expectAuditRow({ tenantId, key: cancelKey, action: 'client_charge.cancelled', targetType: 'client_charge', targetId: first.body.charge.id as string, actorUserId: acctId });
      // An approved charge's cancel raises no outbox event (only a pending one's does).
      expect(await outboxOf(first.body.charge.id as string)).toEqual([]);
      const replacement = (await prepare(gamma).expect(201)).body.created[0] as Invoice;
      expect(replacement.replacesInvoiceId).toBe(draft.id);
      expect(replacement.lines.map((line) => line.adhocChargeId)).toEqual([second.body.charge.id]);
      expect((await act(replacement.id, 'issue').expect(200)).body.outcome).toBe('issued');
      // Code review V2 — every remaining charge is billed on an issued invoice: no `unbilled-charges` blocker.
      const departing = await http().patch(`${API}/${tenantId}/clients/${gamma}/status`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ status: 'departed' });
      expectProblem(departing, 409, 'client-not-wound-down');
      expect((departing.body.blockers as { kind: string }[]).map((blocker) => blocker.kind)).not.toContain('unbilled-charges');
    });

    it('A6 — a pending-only month: prepare drafts ZERO lines with the gap; reject (audited) → refresh → empty → 409 nothing-to-invoice; a recorder cancels their own pending charge (no decision); ops cannot cancel an approved one', async () => {
      const delta = client('DELTA');
      const pending = await record({ clientId: delta }, opsToken).expect(201);
      const draft = (await prepare(delta).expect(201)).body.created[0] as Invoice;
      expect(draft.lines).toEqual([]);
      expect(draft.gaps).toEqual([expect.objectContaining({ code: 'adhoc-charge-pending', count: 1 })]);
      expectProblem(await decide(pending.body.charge.id as string, 'reject', acctToken), 400, 'validation-failed');
      const rejectKey = ulid();
      const rejected = await decide(pending.body.charge.id as string, 'reject', acctToken, 'not agreed with the client', rejectKey).expect(200);
      expect(rejected.body.charge).toMatchObject({ status: 'rejected', decisionNote: 'not agreed with the client', decidedBy: acctId });
      await expectAuditRow({ tenantId, key: rejectKey, action: 'client_charge.rejected', targetType: 'client_charge', targetId: pending.body.charge.id as string, actorUserId: acctId });
      expect((await outboxOf(pending.body.charge.id as string)).map((row) => row.type)).toEqual(['client_charge.pending', 'client_charge.rejected']);
      expectProblem(await decide(pending.body.charge.id as string, 'approve', acctToken), 409, 'charge-not-pending');
      const refreshed = await act(draft.id, 'refresh').expect(200);
      expect(refreshed.body.invoice).toMatchObject({ lines: [], gaps: [] });
      expectProblem(await act(draft.id, 'issue'), 409, 'nothing-to-invoice');

      const own = await record({ clientId: delta, chargeDate: '2026-10-09' }, opsToken).expect(201);
      expectProblem(await decide(own.body.charge.id as string, 'cancel', acct2Token), 400, 'validation-failed');
      const withdrawn = await decide(own.body.charge.id as string, 'cancel', opsToken, 'recorded by mistake').expect(200);
      expect(withdrawn.body.charge).toMatchObject({ status: 'cancelled', decidedBy: null, decidedAt: null, cancelledBy: opsId });
      expect((await outboxOf(own.body.charge.id as string)).map((row) => row.type)).toEqual(['client_charge.cancelled', 'client_charge.pending']);
      expectProblem(await decide(own.body.charge.id as string, 'cancel', opsToken, 'again'), 409, 'charge-not-cancellable');
      const approved = await record({ clientId: delta, chargeDate: '2026-10-09' }).expect(201);
      expectProblem(await decide(approved.body.charge.id as string, 'cancel', opsToken, 'mine now'), 403, 'permission-denied');
      const others = await record({ clientId: delta, chargeDate: '2026-10-09' }, acctToken).expect(201);
      expect(others.body.charge.status).toBe('approved');
    });

    it('the minimum (BETA): the draft carries a minimum_adjustment of exactly floor − charges, issues past the guard with no card, and its drill is 409 line-not-drillable; the usage read is untouched', async () => {
      // Code review V4 — A26: a charge into a month with a minimum and no invoice yet warns; once a draft exists it does not.
      const before = await record({ clientId: client('BETA'), chargeDate: '2026-10-06' }).expect(201);
      expect(before.body.warnings.map((warning: { code: string }) => warning.code)).toEqual(['charge-may-bring-minimum']);
      const prepared = await prepare(client('BETA')).expect(201);
      const after = await record({ clientId: client('BETA'), chargeDate: '2026-10-07' }).expect(201);
      expect(after.body.warnings).toEqual([]);
      const draft = (await act(((prepared.body.created as Invoice[]).find((row) => row.supplierGstin === T29)!).id, 'refresh').expect(200)).body.invoice as Invoice;
      expect(draft.lines.filter((line) => line.chargeCode === 'adhoc')).toHaveLength(2);
      const adjustment = draft.lines.at(-1)!;
      const others = draft.lines.slice(0, -1).reduce((sum, line) => sum + (line.amountPaise ?? 0), 0);
      expect(adjustment).toMatchObject({ chargeCode: 'minimum_adjustment', quantity: '1', rateCardId: null, amountPaise: 5_000_000 - others });
      expect(adjustment.description).toBe(
        `Minimum monthly charge ₹50,000.00 less all charges ₹${formatPaiseEnIn(others)}`,
      );
      expect((await act(draft.id, 'issue').expect(200)).body.outcome).toBe('issued');
      expectProblem(
        await http().get(`${API}/${tenantId}/client-invoices/${draft.id}/lines/${adjustment.id}/records`).set('Authorization', `Bearer ${opsToken}`),
        409,
        'line-not-drillable',
      );
      // Metering never reads the minimum: the usage lines are the four metered codes.
      const usage = await http().get(`${API}/${tenantId}/clients/${client('BETA')}/usage?from=2026-10-01&to=2026-10-31`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      for (const segment of usage.body.segments as { lines: { chargeCode: string }[] }[]) {
        expect(segment.lines.map((line) => line.chargeCode).every((code) => ['storage', 'inbound_handling', 'pick', 'outbound_handling'].includes(code))).toBe(true);
      }
    });

    it('A21 — activating a minimum for a client with events under two GSTINs is 409 minimum-needs-single-gstin; without the minimum it activates', async () => {
      const eps = client('EPS');
      const withMinimum = await draftCard(eps, [{ chargeCode: 'minimum_monthly', basis: 'per_month', amountPaise: 1_000_000 }]).expect(201);
      const refused = await activate(withMinimum.body.rateCard.id as string, '2026-11-08');
      expectProblem(refused, 409, 'minimum-needs-single-gstin');
      expect(refused.body.gstins).toEqual([W27, T29].sort());
      const plain = await draftCard(eps, ALL_FOUR).expect(201);
      rateCardClock.now = () => ist('2026-11-07T09:00');
      try {
        await http().post(`${API}/${tenantId}/rate-cards/${plain.body.rateCard.id as string}/activate`).set('Authorization', `Bearer ${acctToken}`).set(KEY_HEADER, ulid()).send({ effectiveFrom: '2026-11-08' }).expect(200);
      } finally {
        rateCardClock.now = realRateCardNow;
      }
    });

    it('code review V3 — a charge under a SECOND GSTIN for a client with a minimum: record warns charge-disables-minimum, and neither month’s draft applies the minimum (A21)', async () => {
      const tau = client('TAU');
      const res = await record({ clientId: tau, warehouseId: wh.w3, chargeDate: '2026-10-09' }).expect(201);
      expect(res.body.charge.supplierGstin).toBe(W27);
      expect(res.body.warnings.map((warning: { code: string }) => warning.code)).toContain('charge-disables-minimum');
      const created = (await prepare(tau).expect(201)).body.created as Invoice[];
      expect(created.map((row) => row.supplierGstin).sort()).toEqual([W27, T29].sort());
      for (const invoice of created) {
        expect(invoice.lines.map((line) => line.chargeCode)).not.toContain('minimum_adjustment');
        expect(invoice.warnings.map((warning) => warning.code)).toContain('minimum-not-applied-multi-gstin');
        expect(invoice.gaps).toEqual([]);
      }
    });

    it('A15 — the wind-down blocker: an approved but unbilled charge blocks a departure (`unbilled-charges`, named by date and category)', async () => {
      const kappa = client('KAPPA');
      await record({ clientId: kappa, chargeDate: '2026-10-06' }).expect(201);
      const res = await http().patch(`${API}/${tenantId}/clients/${kappa}/status`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ status: 'departed' });
      expectProblem(res, 409, 'client-not-wound-down');
      expect(res.body.blockers).toContainEqual({ kind: 'unbilled-charges', count: 1, codes: ['2026-10-06 extra_labour'] });
    });

    it('the same-key race: two records with one key parked on the client row → identical 201 bodies, one charge', async () => {
      const rho = client('RHO');
      const key = ulid();
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from clients where tenant_id = ${tenantId} and id = ${rho} for update`) as unknown as { pid: number }[];
          first = (async () => record({ clientId: rho, chargeDate: '2026-10-07' }, acctToken, key))();
          second = (async () => record({ clientId: rho, chargeDate: '2026-10-07' }, acctToken, key))();
          await waitParked(locked[0]!.pid, 2);
        });
        const [a, b] = await Promise.all([first!, second!]);
        expect([a.status, b.status]).toEqual([201, 201]);
        expect(a.body).toEqual(b.body);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
      expect((await sql`select id from client_charges where tenant_id = ${tenantId} and client_id = ${rho}`).length).toBe(1);
    });

    it('A30 — the race harness: a charge committed under the client lock while an issue is parked on it → the issue answers stale and the stored draft carries the charge', async () => {
      const rho = client('RHO');
      const draft = (await prepare(rho).expect(201)).body.created[0] as Invoice;
      expect(draft.lines).toHaveLength(1);
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let issue: Promise<request.Response> | undefined;
      const sneaked = uuidv7();
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from clients where tenant_id = ${tenantId} and id = ${rho} for no key update`) as unknown as { pid: number }[];
          issue = (async () => act(draft.id, 'issue'))();
          await waitParked(locked[0]!.pid, 1);
          await tx`insert into client_charges (id, tenant_id, client_id, warehouse_id, supplier_gstin, charge_date, bill_month, category, description,
              sac_code, unit, quantity_milli, unit_rate_paise, amount_paise, status, recorded_by, recorded_at, decided_by, decided_at)
            values (${sneaked}, ${tenantId}, ${rho}, ${wh.w1}, ${T29}, '2026-10-12', '2026-10-01', 'repacking', 'Repack', '998540', 'each', 1000, 100, 100,
              'approved', ${acctId}, now(), ${acctId}, now())`;
        });
        const res = await issue!;
        expect(res.status).toBe(200);
        expect(res.body.outcome).toBe('stale');
        expect((res.body.invoice as Invoice).lines.map((line) => line.adhocChargeId)).toContain(sneaked);
      } finally {
        await Promise.allSettled([issue]);
        await holder.end();
      }
      const stored = await sql<{ n: number }[]>`select count(*)::int as n from client_invoice_lines where invoice_id = ${draft.id} and adhoc_charge_id = ${sneaked}`;
      expect(stored[0]!.n).toBe(1);
    });

    it('the list: filters by client, warehouse, status and billing month; keyset pages; a bad filter is 400', async () => {
      const page = await http().get(`${API}/${tenantId}/client-charges?clientId=${client('ACME')}&month=2026-10&status=approved&limit=1`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect(page.body.items).toHaveLength(1);
      expect(page.body.nextCursor).not.toBeNull();
      const next = await http().get(`${API}/${tenantId}/client-charges?clientId=${client('ACME')}&month=2026-10&status=approved&limit=1&cursor=${encodeURIComponent(page.body.nextCursor as string)}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
      for (const item of [...page.body.items, ...next.body.items] as { billMonth: string; status: string; clientId: string }[]) {
        expect(item).toMatchObject({ billMonth: '2026-10-01', status: 'approved', clientId: client('ACME') });
      }
      const w3 = await http().get(`${API}/${tenantId}/client-charges?warehouseId=${wh.w3}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
      expect((w3.body.items as { clientId: string; warehouseId: string }[]).map((item) => [item.clientId, item.warehouseId])).toEqual([[client('TAU'), wh.w3]]);
      expectProblem(await http().get(`${API}/${tenantId}/client-charges?month=2026-13`).set('Authorization', `Bearer ${opsToken}`), 400, 'validation-failed');
      expectProblem(await http().get(`${API}/${tenantId}/client-charges?cursor=bogus`).set('Authorization', `Bearer ${opsToken}`), 400, 'invalid-cursor');
    });

    it('every route is in the OpenAPI document', async () => {
      const doc = await http().get('/api/v1/openapi.json').expect(200);
      const paths = Object.keys(doc.body.paths as Record<string, unknown>);
      for (const path of [
        '/tenants/{tenantId}/client-charges',
        '/tenants/{tenantId}/client-charges/{chargeId}',
        '/tenants/{tenantId}/client-charges/{chargeId}/approve',
        '/tenants/{tenantId}/client-charges/{chargeId}/reject',
        '/tenants/{tenantId}/client-charges/{chargeId}/cancel',
        '/tenants/{tenantId}/client-charge-policy',
      ]) {
        expect(paths).toContain(path);
      }
    });
  });
});
