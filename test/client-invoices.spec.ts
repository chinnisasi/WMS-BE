import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { createDatabase, type Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { istMidnightOf } from '../src/shared/primitives/time';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { SignedQuantity } from '../src/shared/primitives/quantity';
import * as gst from '../src/shared/primitives/gst';
import * as arith from '../src/modules/invoicing/arith';
import * as generator from '../src/modules/invoicing/generator';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { getLedgerEventType } from '../src/modules/inventory/ledger-registry';
import { rateCardClock } from '../src/modules/billing/rate-card.command';
import { BillingFacade } from '../src/modules/billing/billing.facade';
import { MeteringService, storageAmountPaise, type MeteredPeriod } from '../src/modules/billing/metering';
import { CHARGE_CODES, RATE_BASES } from '../src/modules/billing/rate-cards';
import {
  CLIENT_INVOICE_STATUSES,
  SUPPLY_TYPES,
  canonicalJson,
  clientInvoiceClock,
  computeClientInvoiceDraft,
  decimalToMilli,
  monthPeriod,
  supplierGroups,
  type ClientInvoiceDraftInput,
} from '../src/modules/billing/client-invoices';
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

jest.setTimeout(240_000);

/** An IST wall-clock instant in ms, e.g. `ist('2026-09-10T10:00')`. */
function ist(local: string): number {
  return Date.parse(local.length === 16 ? `${local}:00+05:30` : `${local}+05:30`);
}
function istIso(local: string): string {
  return new Date(ist(local)).toISOString();
}

function migration0062Statements(): string[] {
  const text = readFileSync(resolve(process.cwd(), 'drizzle/0062_client_invoices.sql'), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const T29 = '29AAACT1234A1Z5';
const W27 = '27AAACT1234A1Z6';

// ── pure helpers for Part A ──────────────────────────────────────────────────

const STATES: ClientInvoiceDraftInput['states'] = {
  nameOf: (code) => ({ '29': 'Karnataka', '27': 'Maharashtra' })[code] ?? null,
  codeOfText: (text) => (text === null ? null : ({ karnataka: '29', maharashtra: '27' } as Record<string, string>)[text.trim().toLowerCase()] ?? null),
};

function warehouse(code: string, gstin: string | null, state = 'Karnataka') {
  return {
    id: uuidv7(),
    code,
    name: `${code} warehouse`,
    gstin,
    origin: { contactName: 'P', phone: '1', line1: '12 Road', line2: null, city: 'Bengaluru', state, pincode: '560066' },
  };
}

function meteredWith(lines: MeteredPeriod['segments'][number]['lines'], extra: Partial<MeteredPeriod> = {}): Pick<MeteredPeriod, 'segments' | 'storageCompleteThrough'> {
  return {
    segments: [{ rateCardId: 'card-a', fromDate: '2026-09-01', toDate: '2026-09-30', storageMeasuredThrough: '2026-09-30', lines }],
    storageCompleteThrough: '2026-09-30',
    ...extra,
  };
}

const FULL_TAX = {
  legalName: 'Acme Foods Private Limited',
  gstin: '29AAACA1111A1Z1',
  billingLine1: '1 MG Road',
  billingLine2: null,
  billingCity: 'Bengaluru',
  billingStateCode: '29',
  billingPincode: '560001',
};

function draftInput(overrides: Partial<ClientInvoiceDraftInput> = {}): ClientInvoiceDraftInput {
  return {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    tenantName: 'Three PL Co',
    group: { supplierGstin: T29, warehouses: [warehouse('A1', null)] },
    client: { code: 'ACME', name: 'Acme', taxDetails: FULL_TAX },
    metered: meteredWith([
      { chargeCode: 'storage', basis: 'per_thousand_units_per_day', uom: 'each', quantity: '1500', ratePaise: 330, amountPaise: 495 },
      { chargeCode: 'inbound_handling', basis: 'per_receipt_line', uom: null, quantity: '3', ratePaise: 333, amountPaise: 999 },
      { chargeCode: 'pick', basis: 'per_pick', uom: null, quantity: '0', ratePaise: 300, amountPaise: 0 },
    ]),
    eInvoiceApplies: false,
    states: STATES,
    ...overrides,
  };
}

describe('story 21-5: client invoices', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Part A — the pure pieces: the moved GST primitive, the services number,
  // the FY rule, the draft computation (tax, totals, gaps, warnings, hash).
  // ──────────────────────────────────────────────────────────────────────────
  describe('the GST primitive and the draft computation', () => {
    it('the helpers moved to shared/primitives/gst.ts and invoicing re-exports the SAME functions and error class', () => {
      expect(arith.computeLineTax).toBe(gst.computeLineTax);
      expect(arith.roundToRupee).toBe(gst.roundToRupee);
      expect(arith.assertInvoiceTotals).toBe(gst.assertInvoiceTotals);
      expect(arith.asGstBps).toBe(gst.asGstBps);
      expect(arith.ArithmeticOverflowError).toBe(gst.ArithmeticOverflowError);
      expect(generator.fyLabelFor).toBe(gst.fyLabelFor);
      expect(generator.formatInvoiceNo).toBe(gst.formatInvoiceNo);
      // The goods number is unchanged.
      expect(gst.formatInvoiceNo(T29, 'FY-2627', 1)).toBe('29/2627/000001');
    });

    it('formatServiceInvoiceNo: its own S series, ≤ 16 characters', () => {
      expect(gst.formatServiceInvoiceNo(T29, 'FY-2627', 1)).toBe('29/S2627/000001');
      expect(gst.formatServiceInvoiceNo(T29, 'FY-2627', 1)).toHaveLength(15);
      expect(gst.formatServiceInvoiceNo(W27, 'FY-2728', 9_999_999)).toBe('27/S2728/9999999');
      expect(() => gst.formatServiceInvoiceNo(T29, 'FY-2627', 10_000_000)).toThrow(gst.ArithmeticOverflowError);
      expect(() => gst.formatServiceInvoiceNo(T29, '2627', 1)).toThrow(/malformed FY label/);
      expect(() => gst.formatServiceInvoiceNo(T29, 'FY-2627', 0)).toThrow(/positive integer/);
    });

    it('the FY is the IST issue instant’s: a March period issued in April takes the next FY', () => {
      expect(gst.fyLabelFor('2027-03-31T18:29:59.999Z')).toBe('FY-2627'); // 23:59:59.999 IST on 31 March
      expect(gst.fyLabelFor('2027-03-31T18:30:00.000Z')).toBe('FY-2728'); // 00:00 IST on 1 April
    });

    it('monthPeriod: the IST calendar month (leap February included); a malformed month is 400', () => {
      expect(monthPeriod('2026-09')).toEqual({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
      expect(monthPeriod('2028-02')).toEqual({ periodStart: '2028-02-01', periodEnd: '2028-02-29' });
      expect(monthPeriod('2026-12')).toEqual({ periodStart: '2026-12-01', periodEnd: '2026-12-31' });
      for (const bad of ['2026-13', '2026-9', '2026-09-01', 'Sept']) {
        expect(() => monthPeriod(bad)).toThrow(ProblemException);
      }
    });

    it('decimalToMilli is exact; canonicalJson sorts keys at every depth', () => {
      expect(decimalToMilli('1234.567')).toBe(1_234_567n);
      expect(decimalToMilli('12')).toBe(12_000n);
      expect(decimalToMilli('1.5')).toBe(1_500n);
      expect(decimalToMilli('1152921504606846.976')).toBe(2n ** 60n);
      expect(canonicalJson({ b: 1, a: { d: [2n, null], c: 'x' }, z: undefined })).toBe('{"a":{"c":"x","d":["2",null]},"b":1}');
    });

    it('intra-state: one line per metered charge with quantity > 0, CGST + SGST with the odd paisa to SGST, totals rounded to the rupee', () => {
      const draft = computeClientInvoiceDraft(draftInput());
      expect(draft.supplyType).toBe('intra');
      expect(draft.placeOfSupply).toBe('29');
      // The zero-quantity pick line is dropped.
      expect(draft.lines.map((line) => line.chargeCode)).toEqual(['storage', 'inbound_handling']);
      const [storage, inbound] = draft.lines;
      expect(storage!.quantity).toBe(1_500_000n); // milli-unit-days
      expect(storage!.sacCode).toBe('996729');
      expect(inbound!.sacCode).toBe('996719');
      // 495 × 18 % = 89.1 → 89: CGST 44, SGST 45 (the odd paisa to SGST).
      expect([storage!.cgstPaise, storage!.sgstPaise, storage!.igstPaise]).toEqual([44, 45, 0]);
      // 999 × 18 % = 179.82 → 180: 90 / 90.
      expect([inbound!.cgstPaise, inbound!.sgstPaise]).toEqual([90, 90]);
      expect(draft.totals).toEqual({
        subtotalPaise: 1494,
        cgstPaise: 134,
        sgstPaise: 135,
        igstPaise: 0,
        taxPaise: 269,
        totalPaise: 1763,
        roundOffPaise: 37,
        payablePaise: 1800,
      });
      expect(draft.gaps).toEqual([]);
      expect(draft.warnings).toEqual([]);
      expect(draft.party.supplier).toMatchObject({ name: 'Three PL Co', gstin: T29, stateCode: '29', stateName: 'Karnataka', warehouseCode: 'A1' });
      expect(draft.party.recipient).toMatchObject({ legalName: 'Acme Foods Private Limited', stateCode: '29', stateName: 'Karnataka' });
    });

    it('inter-state: an unregistered client billed in another state → IGST at 18 %, place of supply = its billing state', () => {
      const draft = computeClientInvoiceDraft(
        draftInput({ client: { code: 'BETA', name: 'Beta', taxDetails: { ...FULL_TAX, gstin: null, billingStateCode: '27' } } }),
      );
      expect(draft.placeOfSupply).toBe('27');
      expect(draft.supplyType).toBe('inter');
      expect(draft.lines.map((line) => [line.cgstPaise, line.sgstPaise, line.igstPaise])).toEqual([
        [0, 0, 89],
        [0, 0, 180],
      ]);
      expect(draft.party.recipient.stateName).toBe('Maharashtra');
    });

    it('every gap code, in order — and an incomplete month raises no line-unpriced for its storage lines', () => {
      const draft = computeClientInvoiceDraft(
        draftInput({
          group: { supplierGstin: null, warehouses: [{ ...warehouse('A1', null), origin: { ...warehouse('A1', null).origin, pincode: null } }] },
          client: { code: 'ACME', name: 'Acme', taxDetails: { ...FULL_TAX, legalName: null, billingCity: null, billingPincode: null } },
          metered: {
            segments: [
              {
                rateCardId: null,
                fromDate: '2026-09-01',
                toDate: '2026-09-30',
                storageMeasuredThrough: '2026-09-20',
                lines: [
                  { chargeCode: 'storage', basis: 'per_thousand_units_per_day', uom: 'each', quantity: '20', ratePaise: null, amountPaise: null },
                  { chargeCode: 'pick', basis: 'per_pick', uom: null, quantity: '2', ratePaise: null, amountPaise: null },
                ],
              },
            ],
            storageCompleteThrough: '2026-09-20',
          },
          eInvoiceApplies: true,
        }),
      );
      expect(draft.gaps.map((gap) => gap.code)).toEqual([
        'supplier-gstin-missing',
        'supplier-address-missing',
        'client-legal-name-missing',
        'client-billing-address-missing',
        'storage-not-complete',
        'line-unpriced',
        'einvoice-required',
      ]);
      const unpriced = draft.gaps.find((gap) => gap.code === 'line-unpriced')!;
      expect(unpriced.segmentFrom).toBe('2026-09-01');
      expect(unpriced.detail).toMatch(/^pick /);
      expect(draft.gaps.find((gap) => gap.code === 'client-billing-address-missing')!.detail).toMatch(/city, pincode/);
      // No supplier GSTIN → no supply type → no tax charged.
      expect(draft.supplyType).toBeNull();
      expect(draft.totals.taxPaise).toBe(0);
    });

    it('the e-invoicing gap needs BOTH the flag and a registered client; a warehouse in another state is a warning, never a gap', () => {
      const unregistered = computeClientInvoiceDraft(
        draftInput({ eInvoiceApplies: true, client: { code: 'B', name: 'B', taxDetails: { ...FULL_TAX, gstin: null } } }),
      );
      expect(unregistered.gaps).toEqual([]);
      const flagged = computeClientInvoiceDraft(draftInput({ eInvoiceApplies: true }));
      expect(flagged.gaps.map((gap) => gap.code)).toEqual(['einvoice-required']);
      const crossState = computeClientInvoiceDraft(
        draftInput({ group: { supplierGstin: T29, warehouses: [warehouse('A1', null), warehouse('B2', null, 'Maharashtra')] } }),
      );
      expect(crossState.gaps).toEqual([]);
      expect(crossState.warnings).toEqual([
        { code: 'supplier-state-differs', detail: expect.stringContaining('B2 is in Maharashtra (27)') as unknown as string },
      ]);
    });

    it('the content hash: stable for the same content whatever the input order; it moves with any figure, the party or the gaps', () => {
      const base = computeClientInvoiceDraft(draftInput());
      const reordered = draftInput();
      const segment = reordered.metered.segments[0]!;
      const shuffled = computeClientInvoiceDraft({
        ...reordered,
        metered: { ...reordered.metered, segments: [{ ...segment, lines: [...segment.lines].reverse() }] },
      });
      expect(shuffled.contentHash).toBe(base.contentHash);
      expect(base.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const moreQty = draftInput();
      const moved = computeClientInvoiceDraft({
        ...moreQty,
        metered: meteredWith([
          { chargeCode: 'storage', basis: 'per_thousand_units_per_day', uom: 'each', quantity: '1500.001', ratePaise: 330, amountPaise: 495 },
          { chargeCode: 'inbound_handling', basis: 'per_receipt_line', uom: null, quantity: '3', ratePaise: 333, amountPaise: 999 },
        ]),
      });
      expect(moved.contentHash).not.toBe(base.contentHash);
      const renamed = computeClientInvoiceDraft(draftInput({ client: { code: 'ACME', name: 'Acme', taxDetails: { ...FULL_TAX, legalName: 'Acme Foods Pvt Ltd' } } }));
      expect(renamed.contentHash).not.toBe(base.contentHash);
      const flagged = computeClientInvoiceDraft(draftInput({ eInvoiceApplies: true }));
      expect(flagged.contentHash).not.toBe(base.contentHash);
    });

    it('supplierGroups: every warehouse in exactly one group, keyed by its GSTIN, else the tenant’s; the null group last', () => {
      const facts = {
        tenantName: 'T',
        tenantGstin: T29,
        warehouses: [warehouse('C3', W27), warehouse('A1', null), warehouse('B2', null)],
      };
      expect(supplierGroups(facts).map((group) => [group.supplierGstin, group.warehouses.map((w) => w.code)])).toEqual([
        [W27, ['C3']],
        [T29, ['A1', 'B2']],
      ]);
      expect(supplierGroups({ ...facts, tenantGstin: null }).map((group) => group.supplierGstin)).toEqual([W27, null]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part B — migration 0062 against a database built from the repo's own
  // journal trimmed to 0061, applied inside ONE transaction like the runner.
  // ──────────────────────────────────────────────────────────────────────────
  describe('migration 0062, applied to a pre-migration database', () => {
    const PRE_DB = 'wms_s_clientinv_premigration';
    let sql: ReturnType<typeof postgres>;
    let folder: string;
    const seeded = { tenant: uuidv7(), client: uuidv7() };

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
      folder = mkdtempSync(join(tmpdir(), 'wms-pre-0062-'));
      cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
      rmSync(join(folder, '0062_client_invoices.sql'));
      const journalPath = join(folder, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 61);
      writeFileSync(journalPath, JSON.stringify(journal));
      const db = createDatabase(preUrl);
      await migrate(db, { migrationsFolder: folder });
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
      sql = postgres(preUrl, { max: 2, onnotice: () => undefined });
      // A pre-existing client brand: the new columns must arrive null on it.
      await sql`insert into clients (id, tenant_id, code, name, status, system_owned)
        values (${seeded.client}, ${seeded.tenant}, 'PRE', 'Pre-existing Brand', 'active', false)`;
    }, 120_000);

    afterAll(async () => {
      await sql?.end();
      rmSync(folder, { recursive: true, force: true });
      await admin(async (db) => {
        await db.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PRE_DB}'`);
        await db.unsafe(`drop database if exists "${PRE_DB}"`);
      });
    });

    it('applies in one transaction: the tables, the clients columns (null on existing rows), the CHECKs, the triggers and the nine policies', async () => {
      const before = await sql<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_name = 'client_invoices'`;
      expect(before[0]!.n).toBe(0);
      await sql.begin(async (tx) => {
        for (const statement of migration0062Statements()) await tx.unsafe(statement);
      });
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name like 'client_invoice%' order by table_name`;
      expect(tables.map((row) => row.table_name)).toEqual(['client_invoice_lines', 'client_invoice_series', 'client_invoices']);
      const pre = await sql<Record<string, unknown>[]>`
        select code, name, legal_name, gstin, billing_line1, billing_line2, billing_city, billing_state_code, billing_pincode
        from clients where id = ${seeded.client}`;
      expect(pre[0]).toEqual({
        code: 'PRE',
        name: 'Pre-existing Brand',
        legal_name: null,
        gstin: null,
        billing_line1: null,
        billing_line2: null,
        billing_city: null,
        billing_state_code: null,
        billing_pincode: null,
      });
      const policies = await sql<{ tablename: string; cmd: string }[]>`
        select tablename, cmd from pg_policies where tablename like 'client_invoice%' order by tablename, cmd`;
      expect(policies.map((row) => `${row.tablename}:${row.cmd}`)).toEqual([
        'client_invoice_lines:DELETE',
        'client_invoice_lines:INSERT',
        'client_invoice_lines:SELECT',
        'client_invoice_lines:UPDATE',
        'client_invoice_series:ALL',
        'client_invoices:DELETE',
        'client_invoices:INSERT',
        'client_invoices:SELECT',
        'client_invoices:UPDATE',
      ]);
      const lineIndex = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes where indexname = 'client_invoice_lines_invoice_segment_charge_uom_unique'`;
      expect(lineIndex[0]?.indexdef).toContain('UNIQUE');
      expect(lineIndex[0]?.indexdef).toContain("(invoice_id, segment_from, charge_code, COALESCE(uom, ''::text))");
      const triggers = await sql<{ tgname: string }[]>`
        select tgname from pg_trigger where not tgisinternal and tgname like 'client_invoice%' order by tgname`;
      expect(triggers.map((row) => row.tgname)).toEqual([
        'client_invoice_lines_frozen',
        'client_invoice_lines_no_truncate',
        'client_invoices_frozen',
        'client_invoices_no_truncate',
      ]);
    });

    it('the clients CHECKs bite: a GSTIN must match the billing state; shapes are enforced', async () => {
      await sql`update clients set gstin = '27AAACA1111A1Z1', billing_state_code = '27' where id = ${seeded.client}`;
      await expect(sql`update clients set billing_state_code = '29' where id = ${seeded.client}`).rejects.toMatchObject({ code: '23514' });
      await expect(sql`update clients set gstin = '27aaaca1111a1z1' where id = ${seeded.client}`).rejects.toMatchObject({ code: '23514' });
      await expect(sql`update clients set billing_pincode = '5600' where id = ${seeded.client}`).rejects.toMatchObject({ code: '23514' });
      await expect(sql`update clients set legal_name = ' padded ' where id = ${seeded.client}`).rejects.toMatchObject({ code: '23514' });
    });

    it('the fail-fast guard refuses a second application', async () => {
      await expect(sql.unsafe(migration0062Statements()[0]!)).rejects.toThrow(/migration 0062 has already been applied/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part C — the triggers, the CHECKs and the vocabulary pins, by direct SQL
  // (superuser: RLS does not apply; the triggers and CHECKs do).
  // ──────────────────────────────────────────────────────────────────────────
  describe('the database guard (direct SQL)', () => {
    let suiteDb: SuiteDatabase;
    let sql: postgres.Sql;
    const tenantId = uuidv7();
    const actor = uuidv7();

    beforeAll(async () => {
      suiteDb = await useSuiteDatabase('clientinvguard');
      sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    });

    afterAll(async () => {
      await sql?.end();
      await suiteDb?.drop();
    });

    /** A draft with one line (priced unless told otherwise; none with `withLine: false`), in its own month. */
    async function draft(month: string, priced = true, withLine = true): Promise<string> {
      const id = uuidv7();
      const { periodStart, periodEnd } = monthPeriod(month);
      const nextMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
      await sql`insert into client_invoices (id, tenant_id, client_id, period_start, period_end, status, supplier_gstin,
          place_of_supply, supply_type, subtotal_paise, cgst_paise, sgst_paise, igst_paise, tax_paise, total_paise,
          round_off_paise, payable_paise, gaps, warnings, party, content_hash, created_by)
        values (${id}, ${tenantId}, ${uuidv7()}, ${periodStart}, ${periodEnd}, 'draft', ${T29}, '29', 'intra',
          3000, 270, 270, 0, 540, 3540, -40, 3500, '[]'::jsonb, '[]'::jsonb, '{"seed": true}'::jsonb, 'h', ${actor})`;
      if (!withLine) return id;
      await sql`insert into client_invoice_lines (id, tenant_id, invoice_id, rate_card_id, segment_from, segment_to, charge_code, basis,
          uom, quantity, unit_amount_paise, amount_paise, sac_code, gst_bps, place_of_supply, supply_type, cgst_paise, sgst_paise, igst_paise)
        values (${uuidv7()}, ${tenantId}, ${id}, ${priced ? uuidv7() : null}, ${istMidnightOf(periodStart)}, ${istMidnightOf(nextMonth)},
          'pick', 'per_pick', null, 10, ${priced ? 300 : null}, ${priced ? 3000 : null}, '996719', 1800, '29', 'intra',
          ${priced ? 270 : 0}, ${priced ? 270 : 0}, 0)`;
      return id;
    }

    async function issue(id: string, seq: number): Promise<void> {
      await sql`update client_invoices set status = 'issued', invoice_no = ${gst.formatServiceInvoiceNo(T29, 'FY-2627', seq)},
          fy_label = 'FY-2627', series_seq = ${seq}, issued_at = now(), issued_by = ${actor} where id = ${id}`;
    }

    async function move(id: string, status: string, note: string | null = 'because'): Promise<unknown> {
      return sql`update client_invoices set status = ${status}, status_note = ${note}, status_changed_at = clock_timestamp(),
          status_changed_by = ${actor} where id = ${id} returning id`;
    }

    it('the vocabularies are pinned against the CHECKs (statuses, supply types, charges, bases)', async () => {
      const defs = await sql<{ conname: string; def: string }[]>`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('client_invoices_status_check', 'client_invoice_lines_charge_code_check',
          'client_invoice_lines_basis_check', 'client_invoices_tax_shape')`;
      const values = (name: string): string[] => [...defs.find((row) => row.conname === name)!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
      expect(values('client_invoices_status_check')).toEqual([...CLIENT_INVOICE_STATUSES]);
      expect(values('client_invoice_lines_charge_code_check')).toEqual([...CHARGE_CODES]);
      expect(values('client_invoice_lines_basis_check')).toEqual([...RATE_BASES]);
      expect(values('client_invoices_tax_shape')).toEqual([...SUPPLY_TYPES]);
      // …and an unknown status is refused.
      const id = await draft('2026-01');
      await expect(sql`update client_invoices set status = 'paid' where id = ${id}`).rejects.toMatchObject({ code: 'P0001' });
    });

    it('every LEGAL transition is admitted: draft → issued → disputed → settled, issued → settled, issued → void, disputed → void', async () => {
      const a = await draft('2026-02');
      await issue(a, 1);
      expect(await move(a, 'disputed')).toHaveLength(1);
      expect(await move(a, 'settled', null)).toHaveLength(1);
      const b = await draft('2026-03');
      await issue(b, 2);
      expect(await move(b, 'settled', null)).toHaveLength(1);
      const c = await draft('2026-04');
      await issue(c, 3);
      expect(await move(c, 'void')).toHaveLength(1);
      const d = await draft('2026-05');
      await issue(d, 4);
      expect(await move(d, 'disputed')).toHaveLength(1);
      expect(await move(d, 'void')).toHaveLength(1);
      // A void stays numbered.
      const rows = await sql<{ invoice_no: string }[]>`select invoice_no from client_invoices where id = ${c}`;
      expect(rows[0]!.invoice_no).toBe('29/S2627/000003');
    });

    it('every ILLEGAL transition is refused at the trigger', async () => {
      const draftId = await draft('2026-06');
      for (const status of ['disputed', 'settled', 'void']) {
        await expect(move(draftId, status)).rejects.toMatchObject({ code: 'P0001' });
      }
      // Issue needs the number, and refuses an unpriced line.
      await expect(sql`update client_invoices set status = 'issued' where id = ${draftId}`).rejects.toMatchObject({ code: 'P0001' });
      const unpriced = await draft('2026-07', false);
      await expect(issue(unpriced, 90)).rejects.toThrow(/unpriced line/);

      const issued = await draft('2026-08');
      await issue(issued, 5);
      await expect(sql`update client_invoices set status = 'draft', invoice_no = null where id = ${issued}`).rejects.toMatchObject({ code: 'P0001' });
      await expect(move(issued, 'issued')).rejects.toMatchObject({ code: 'P0001' });
      // Dispute and void need a note.
      await expect(move(issued, 'disputed', null)).rejects.toMatchObject({ code: 'P0001' });
      await expect(move(issued, 'void', null)).rejects.toMatchObject({ code: 'P0001' });
      // No figure, party or line of an issued invoice changes.
      await expect(sql`update client_invoices set subtotal_paise = 1, total_paise = 541 where id = ${issued}`).rejects.toMatchObject({ code: 'P0001' });
      await expect(sql`update client_invoices set party = '{"x":1}'::jsonb where id = ${issued}`).rejects.toMatchObject({ code: 'P0001' });
      await expect(sql`update client_invoice_lines set quantity = 11 where invoice_id = ${issued}`).rejects.toMatchObject({ code: 'P0001' });
      await expect(sql`delete from client_invoice_lines where invoice_id = ${issued}`).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        sql`insert into client_invoice_lines (id, tenant_id, invoice_id, rate_card_id, segment_from, segment_to, charge_code, basis,
            uom, quantity, unit_amount_paise, amount_paise, sac_code, gst_bps, place_of_supply, supply_type, cgst_paise, sgst_paise, igst_paise)
          values (${uuidv7()}, ${tenantId}, ${issued}, ${uuidv7()}, '2026-07-31T18:30:00Z', '2026-08-31T18:30:00Z', 'pick', 'per_pick',
            null, 1, 1, 1, '996719', 1800, '29', 'intra', 0, 0, 0)`,
      ).rejects.toMatchObject({ code: 'P0001' });
      // An issued row is never deleted.
      await expect(sql`delete from client_invoices where id = ${issued}`).rejects.toMatchObject({ code: 'P0001' });
      // settled and void are terminal.
      await move(issued, 'settled', null);
      for (const status of ['disputed', 'void', 'issued']) {
        await expect(move(issued, status)).rejects.toMatchObject({ code: 'P0001' });
      }
      // Neither table can be truncated.
      await expect(sql`truncate client_invoices`).rejects.toThrow(/never truncated/);
      await expect(sql`truncate client_invoice_lines`).rejects.toThrow(/never truncated/);
    });

    it('issue refuses at the trigger: no line, header totals that are not the lines’ sums, an empty party; one line per (segment, charge, uom)', async () => {
      const lineless = await draft('2025-01', true, false);
      await expect(issue(lineless, 101)).rejects.toThrow(/has no line/);
      // CGST/SGST shifted by a paisa: every CHECK still holds (tax unchanged), the lines disagree.
      const skewed = await draft('2025-02');
      await sql`update client_invoices set cgst_paise = 271, sgst_paise = 269 where id = ${skewed}`;
      await expect(issue(skewed, 102)).rejects.toThrow(/not the sums of its lines/);
      const subtotalOff = await draft('2025-03');
      await sql`update client_invoices set subtotal_paise = 2950, total_paise = 3490, round_off_paise = 10, payable_paise = 3500 where id = ${subtotalOff}`;
      await expect(issue(subtotalOff, 103)).rejects.toThrow(/not the sums of its lines/);
      const partyless = await draft('2025-04');
      await sql`update client_invoices set party = '{}'::jsonb where id = ${partyless}`;
      await expect(issue(partyless, 104)).rejects.toThrow(/no party to print/);
      // The same draft with a party issues — the refusals above were the rule, not the seed.
      await sql`update client_invoices set party = '{"seed": true}'::jsonb where id = ${partyless}`;
      await expect(issue(partyless, 104)).resolves.toBeUndefined();
      // A second line on the same (segment, charge, uom) is refused by the unique index.
      const doubled = await draft('2025-05');
      await expect(
        sql`insert into client_invoice_lines (id, tenant_id, invoice_id, rate_card_id, segment_from, segment_to, charge_code, basis,
            uom, quantity, unit_amount_paise, amount_paise, sac_code, gst_bps, place_of_supply, supply_type, cgst_paise, sgst_paise, igst_paise)
          values (${uuidv7()}, ${tenantId}, ${doubled}, ${uuidv7()}, ${istMidnightOf('2025-05-01')}, ${istMidnightOf('2025-06-01')},
            'pick', 'per_pick', null, 1, 300, 300, '996719', 1800, '29', 'intra', 27, 27, 0)`,
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('the CHECKs: totals reconcile, payable is whole rupees, a storage line names its uom, a line’s segment is IST midnights', async () => {
      const id = uuidv7();
      await expect(
        sql`insert into client_invoices (id, tenant_id, client_id, period_start, period_end, status, subtotal_paise, cgst_paise,
            sgst_paise, igst_paise, tax_paise, total_paise, round_off_paise, payable_paise, gaps, warnings, party, content_hash, created_by)
          values (${id}, ${tenantId}, ${uuidv7()}, '2025-09-01', '2025-09-30', 'draft', 100, 0, 0, 0, 0, 100, 0, 100,
            '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'h', ${actor})`,
      ).resolves.toBeDefined();
      for (const [label, statement] of [
        ['payable not whole rupees', sql`update client_invoices set total_paise = 150, subtotal_paise = 150, round_off_paise = 0, payable_paise = 150 where id = ${id}`],
        ['subtotal + tax ≠ total', sql`update client_invoices set total_paise = 99 where id = ${id}`],
        ['period not a month', sql`update client_invoices set period_end = '2025-09-29' where id = ${id}`],
      ] as const) {
        await expect(statement).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|P0001)$/) as unknown as string });
        void label;
      }
      for (const [uom, basis, charge] of [
        [null, 'per_thousand_units_per_day', 'storage'],
        ['each', 'per_pick', 'pick'],
      ] as const) {
        await expect(
          sql`insert into client_invoice_lines (id, tenant_id, invoice_id, rate_card_id, segment_from, segment_to, charge_code, basis,
              uom, quantity, unit_amount_paise, amount_paise, sac_code, gst_bps, place_of_supply, supply_type, cgst_paise, sgst_paise, igst_paise)
            values (${uuidv7()}, ${tenantId}, ${id}, null, '2025-08-31T18:30:00Z', '2025-09-30T18:30:00Z', ${charge}, ${basis},
              ${uom}, 1, null, null, '996719', 1800, null, null, 0, 0, 0)`,
        ).rejects.toMatchObject({ code: '23514' });
      }
      await expect(
        sql`insert into client_invoice_lines (id, tenant_id, invoice_id, rate_card_id, segment_from, segment_to, charge_code, basis,
            uom, quantity, unit_amount_paise, amount_paise, sac_code, gst_bps, place_of_supply, supply_type, cgst_paise, sgst_paise, igst_paise)
          values (${uuidv7()}, ${tenantId}, ${id}, null, '2025-09-01T00:00:00Z', '2025-09-30T18:30:00Z', 'pick', 'per_pick',
            null, 1, null, null, '996719', 1800, null, null, 0, 0, 0)`,
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part D — the whole flow over a real ledger, the rate cards and the
  // snapshots, through HTTP. One tenant registered under 29 (Karnataka) with
  // WH1, WH2 on the tenant GSTIN and WH3 on its own 27 (Maharashtra) GSTIN.
  // ──────────────────────────────────────────────────────────────────────────
  describe('over the ledger, through HTTP', () => {
    let app: INestApplication;
    let db: Database;
    let sql: postgres.Sql;
    let suiteDb: SuiteDatabase;
    let inventory: InventoryFacade;
    let billing: BillingFacade;
    let metering: MeteringService;
    const realRateCardNow = rateCardClock.now;
    const realInvoiceNow = clientInvoiceClock.now;

    let tenantId: string;
    let ownerToken: string;
    let accountantToken: string;
    let opsToken: string;
    let portalToken: string;
    let actorId: string;
    let selfId: string;
    const wh: Record<'w1' | 'w2' | 'w3', string> = { w1: '', w2: '', w3: '' };
    const bin: Record<'w1' | 'w2' | 'w3', string> = { w1: '', w2: '', w3: '' };
    const clients = new Map<string, string>();
    const skus = new Map<string, string>();
    const cards = new Map<string, string>();

    const http = () => request(app.getHttpServer());
    const client = (code: string): string => clients.get(code)!;
    const sku = (code: string): string => skus.get(code)!;

    async function register(name: string, gstin?: string): Promise<{ tenantId: string; ownerToken: string; userId: string }> {
      const email = `owner-${ulid().toLowerCase()}@example.com`;
      const registered = await http()
        .post(API)
        .set(KEY_HEADER, ulid())
        .send({ name, ownerEmail: email, password: 'correct-horse-battery', ...(gstin === undefined ? {} : { gstin }) })
        .expect(201);
      const signedIn = await http().post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200);
      return { tenantId: registered.body.tenant.id as string, ownerToken: signedIn.body.accessToken as string, userId: registered.body.owner.id as string };
    }

    async function invite(role: string): Promise<{ token: string; email: string }> {
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
      const token = (await http().post(`${API}/sign-in`).send({ email, password: 'correct-horse-battery' }).expect(200)).body.accessToken as string;
      return { token, email };
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
        await http()
          .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code: 'A', name: 'Aisle A' })
          .expect(201)
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

    /** Stock IN to the warehouse's bin (storage starts the day it lands). */
    async function receive(where: 'w1' | 'w2' | 'w3', skuCode: string, milli: number, at: string): Promise<void> {
      await append({ warehouseId: wh[where], type: 'grn.received', skuId: sku(skuCode), quantityDelta: milli, toBinId: bin[where], recordedAt: istIso(at) });
    }

    async function seedGrn(where: 'w1' | 'w2' | 'w3', recordedAt: string, skuIds: readonly string[]): Promise<void> {
      const grnId = uuidv7();
      await sql`insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, blind_reason_code, status, device_id, recorded_by, occurred_at, recorded_at)
        values (${grnId}, ${tenantId}, ${wh[where]}, ${'GRN-' + ulid().slice(14)}, null, 'other', 'recorded', ${uuidv7()}, ${actorId}, ${istIso(recordedAt)}, ${istIso(recordedAt)})`;
      for (const skuId of skuIds) {
        await sql`insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, qty, applied_qty)
          values (${uuidv7()}, ${tenantId}, ${grnId}, ${skuId}, 1000, 1000)`;
      }
    }

    async function seedPick(where: 'w1' | 'w2' | 'w3', skuId: string, createdAt: string): Promise<void> {
      await sql`insert into picks (id, tenant_id, warehouse_id, wave_id, picklist_id, picklist_line_id, order_id, order_line_id,
          sku_id, bin_id, qty, picked_by, picked_at, device_id, created_at, updated_at)
        values (${uuidv7()}, ${tenantId}, ${wh[where]}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()}, ${uuidv7()},
          ${skuId}, ${bin[where]}, 1000, ${actorId}, ${istIso(createdAt)}, ${uuidv7()}, ${istIso(createdAt)}, ${istIso(createdAt)})`;
    }

    /** Tick one scope until the commit guarantee no longer holds it back. */
    async function settle(clientCode: string, where: 'w1' | 'w2' | 'w3', nowMs: number): Promise<void> {
      for (let i = 0; i < 4; i += 1) {
        const tick = await billing.snapshotScope(tenantId, client(clientCode), wh[where], nowMs);
        if (tick.waiting !== 'commit-guarantee') break;
      }
    }

    const ALL_FOUR = (storage: number, inbound: number, pick: number, outbound: number) => [
      { chargeCode: 'storage', basis: 'per_thousand_units_per_day', amountPaise: storage },
      { chargeCode: 'inbound_handling', basis: 'per_receipt_line', amountPaise: inbound },
      { chargeCode: 'pick', basis: 'per_pick', amountPaise: pick },
      { chargeCode: 'outbound_handling', basis: 'per_order', amountPaise: outbound },
    ];

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
      rateCardClock.now = realRateCardNow;
      return id;
    }

    function taxDetails(clientId: string, body: Record<string, unknown>, token = accountantToken, key = ulid()) {
      return http()
        .patch(`${API}/${tenantId}/clients/${clientId}/tax-details`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send(body);
    }

    function prepare(clientId: string, month: string, token = accountantToken, key = ulid()) {
      return http().post(`${API}/${tenantId}/clients/${clientId}/invoices`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({ month });
    }

    function act(invoiceId: string, verb: 'issue' | 'refresh' | 'dispute' | 'settle' | 'void', body: Record<string, unknown> = {}, key = ulid(), token = accountantToken) {
      return http().post(`${API}/${tenantId}/client-invoices/${invoiceId}/${verb}`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
    }

    function getInvoice(invoiceId: string, token = opsToken) {
      return http().get(`${API}/${tenantId}/client-invoices/${invoiceId}`).set('Authorization', `Bearer ${token}`);
    }

    function expectProblem(res: request.Response, status: number, code: string): void {
      expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
    }

    async function seriesSeq(gstin: string, fy: string): Promise<number | null> {
      const rows = await sql<{ last_seq: number }[]>`select last_seq from client_invoice_series where tenant_id = ${tenantId} and supplier_gstin = ${gstin} and fy_label = ${fy}`;
      return rows[0]?.last_seq ?? null;
    }

    async function contentHash(invoiceId: string): Promise<{ content_hash: string; updated_at: string }> {
      const rows = await sql<{ content_hash: string; updated_at: string }[]>`select content_hash, updated_at::text as updated_at from client_invoices where id = ${invoiceId}`;
      return rows[0]!;
    }

    type InvoiceBody = {
      id: string;
      status: string;
      invoiceNo: string | null;
      supplierGstin: string | null;
      supplyType: string | null;
      placeOfSupply: string | null;
      replacesInvoiceId: string | null;
      gaps: { code: string; segmentFrom?: string }[];
      warnings: { code: string }[];
      lines: {
        rateCardId: string | null;
        segmentFrom: string;
        segmentTo: string;
        chargeCode: string;
        uom: string | null;
        quantity: string;
        unitAmountPaise: number | null;
        amountPaise: number | null;
        sac: string;
        gstBps: number;
        cgstPaise: number;
        sgstPaise: number;
        igstPaise: number;
      }[];
      totals: { subtotal: number; cgst: number; sgst: number; igst: number; tax: number; roundOff: number; payable: number };
      party: { supplier: Record<string, unknown>; recipient: Record<string, unknown> };
    };

    const AT_OCT_1 = ist('2026-10-01T00:30');
    const AT_OCT_7 = ist('2026-10-07T10:00');
    const FULL = (overrides: Record<string, unknown> = {}) => ({
      legalName: 'Brand Private Limited',
      billingLine1: '5 Brigade Road',
      billingCity: 'Bengaluru',
      billingStateCode: '29',
      billingPincode: '560025',
      ...overrides,
    });

    beforeAll(async () => {
      suiteDb = await useSuiteDatabase('clientinvoices');
      app = await createApp(false);
      await app.init();
      db = app.get<Database>(DATABASE);
      inventory = app.get(InventoryFacade);
      billing = app.get(BillingFacade);
      metering = app.get(MeteringService, { strict: false });
      sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
      clientInvoiceClock.now = () => AT_OCT_7;

      const owner = await register(`Three PL Co ${ulid()}`, T29);
      tenantId = owner.tenantId;
      ownerToken = owner.ownerToken;
      actorId = owner.userId;
      accountantToken = (await invite('accountant')).token;
      opsToken = (await invite('ops_manager')).token;
      const portal = await invite('accountant');
      portalToken = portal.token;

      const w1 = await createWarehouse(`CI1-${ulid().slice(20)}`);
      const w2 = await createWarehouse(`CI2-${ulid().slice(20)}`);
      const w3 = await createWarehouse(`CI3-${ulid().slice(20)}`, W27, testAddress({ city: 'Mumbai', state: 'Maharashtra', pincode: '400001' }));
      wh.w1 = w1.warehouseId;
      wh.w2 = w2.warehouseId;
      wh.w3 = w3.warehouseId;
      bin.w1 = w1.binId;
      bin.w2 = w2.binId;
      bin.w3 = w3.binId;

      const listed = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      selfId = (listed.body.items as { id: string; systemOwned: boolean }[]).find((row) => row.systemOwned)!.id;
      for (const code of ['ACME', 'BETA', 'GAMMA', 'DELTA', 'EPS', 'ZETA', 'KAPPA', 'FYC', 'OMEGA']) {
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
        await importSkus(client(code), [`${code}-PC,${code} item,each,1800,,,`]);
      }
      const skuList = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      for (const item of skuList.body.items as { code: string; id: string }[]) skus.set(item.code, item.id);

      // A portal user: an accountant whose row carries a client (AD-23) — the
      // reads must refuse it.
      await sql`update users set client_id = ${client('ACME')} where tenant_id = ${tenantId} and email = ${portal.email}`;

      // ── tax details (the accountant holds billing.invoice).
      await taxDetails(client('ACME'), FULL({ legalName: 'Acme Foods Private Limited', gstin: '29AAACA1111A1Z1' })).expect(200);
      await taxDetails(client('BETA'), FULL({ legalName: 'Beta Brands LLP', billingStateCode: '27', billingCity: 'Pune', billingPincode: '411001' })).expect(200);
      for (const code of ['GAMMA', 'DELTA', 'ZETA', 'KAPPA', 'FYC', 'OMEGA']) await taxDetails(client(code), FULL()).expect(200);
      await taxDetails(client('EPS'), FULL({ gstin: '27AAACE2222A1Z2', billingStateCode: '27', billingCity: 'Mumbai', billingPincode: '400002' })).expect(200);

      // ── September's activity.
      // ACME (WH1 only at first): 300 units stored the 10th–17th, a GRN of
      // two lines on the 10th, one pick on the 18th, one order dispatched
      // on the 20th.
      await receive('w1', 'ACME-PC', 300_000, '2026-09-10T10:00');
      await append({ warehouseId: wh.w1, type: 'pick.picked', skuId: sku('ACME-PC'), quantityDelta: -300_000, fromBinId: bin.w1, recordedAt: istIso('2026-09-18T10:00') });
      const orderId = uuidv7();
      await append({ warehouseId: wh.w1, type: 'dispatch.dispatched', skuId: sku('ACME-PC'), quantityDelta: 0, recordedAt: istIso('2026-09-20T10:00'), referenceDoc: { kind: 'dispatch', orderId } });
      await seedGrn('w1', '2026-09-10T10:00', [sku('ACME-PC'), sku('ACME-PC')]);
      await seedPick('w1', sku('ACME-PC'), '2026-09-18T10:00');
      // BETA in WH2 (group 29) and WH3 (group 27).
      await receive('w2', 'BETA-PC', 10_000, '2026-09-05T10:00');
      await seedGrn('w2', '2026-09-05T10:00', [sku('BETA-PC')]);
      await receive('w3', 'BETA-PC', 20_000, '2026-09-08T10:00');
      await seedGrn('w3', '2026-09-08T10:00', [sku('BETA-PC')]);
      await seedPick('w3', sku('BETA-PC'), '2026-09-09T10:00');
      // GAMMA in WH1 and WH2 — both group 29.
      await receive('w1', 'GAMMA-PC', 5_000, '2026-09-02T10:00');
      await receive('w2', 'GAMMA-PC', 7_000, '2026-09-03T10:00');
      await seedGrn('w1', '2026-09-02T10:00', [sku('GAMMA-PC')]);
      await seedGrn('w2', '2026-09-03T10:00', [sku('GAMMA-PC')]);
      // DELTA (WH1) — its storage will be measured only to the 19th.
      await receive('w1', 'DELTA-PC', 1_000, '2026-09-04T10:00');
      await seedGrn('w1', '2026-09-04T10:00', [sku('DELTA-PC')]);
      // EPS (WH3, group 27) — a registered client of an e-invoicing GSTIN.
      await receive('w3', 'EPS-PC', 2_000, '2026-09-06T10:00');
      await seedGrn('w3', '2026-09-06T10:00', [sku('EPS-PC')]);
      // ZETA (WH1) — no rate card at all.
      await receive('w1', 'ZETA-PC', 1_000, '2026-09-07T10:00');
      await seedGrn('w1', '2026-09-07T10:00', [sku('ZETA-PC')]);
      // KAPPA (WH2) and FYC (WH2).
      for (const code of ['KAPPA', 'FYC']) {
        await receive('w2', `${code}-PC`, 3_000, '2026-09-11T10:00');
        await seedGrn('w2', '2026-09-11T10:00', [sku(`${code}-PC`)]);
      }

      // ── the cards: ACME A from 09-01 then B from 09-15 (a mid-month
      // change); every other client one card from 09-01 (ZETA none).
      cards.set('ACME-A', await activeCard(client('ACME'), ALL_FOUR(330, 500, 300, 2000), '2026-09-01', '2026-09-01T09:00'));
      cards.set('ACME-B', await activeCard(client('ACME'), ALL_FOUR(400, 600, 350, 2500), '2026-09-15', '2026-09-05T09:00'));
      for (const code of ['BETA', 'GAMMA', 'DELTA', 'EPS', 'KAPPA', 'FYC', 'OMEGA']) {
        cards.set(code, await activeCard(client(code), ALL_FOUR(1000, 700, 300, 2000), '2026-09-01', '2026-09-01T09:00'));
      }

      // ── the snapshots, through Sept 30 (DELTA only through the 19th).
      for (const [code, where] of [
        ['ACME', 'w1'],
        ['BETA', 'w2'],
        ['BETA', 'w3'],
        ['GAMMA', 'w1'],
        ['GAMMA', 'w2'],
        ['EPS', 'w3'],
        ['ZETA', 'w1'],
        ['KAPPA', 'w2'],
        ['FYC', 'w2'],
      ] as const) {
        await settle(code, where, AT_OCT_1);
      }
      await settle('DELTA', 'w1', ist('2026-09-20T00:30'));
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

    // ── tax details ───────────────────────────────────────────────────────
    describe('client tax details', () => {
      it('the accountant sets them; the client read carries them; audited client.tax-details-updated', async () => {
        const listed = await http().get(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${opsToken}`).expect(200);
        const acme = (listed.body.items as { id: string; taxDetails: Record<string, unknown> }[]).find((row) => row.id === client('ACME'))!;
        expect(acme.taxDetails).toEqual({
          legalName: 'Acme Foods Private Limited',
          gstin: '29AAACA1111A1Z1',
          billingLine1: '5 Brigade Road',
          billingLine2: null,
          billingCity: 'Bengaluru',
          billingStateCode: '29',
          billingPincode: '560025',
        });
        const audits = await sql<{ n: number }[]>`select count(*)::int as n from audit_events
          where tenant_id = ${tenantId} and action = 'client.tax-details-updated' and target_id = ${client('ACME')}`;
        expect(audits[0]!.n).toBe(1);
      });

      it('the matrix’s refusals: malformed GSTIN, state 99, a GSTIN in another state — 400 validation-failed', async () => {
        expectProblem(await taxDetails(client('OMEGA'), { gstin: '29ABC' }), 400, 'validation-failed');
        expectProblem(await taxDetails(client('OMEGA'), { billingStateCode: '99' }), 400, 'validation-failed');
        // The stored state is 29; a 27 GSTIN disagrees with it.
        const mismatch = await taxDetails(client('OMEGA'), { gstin: '27AAACO3333A1Z3' });
        expectProblem(mismatch, 400, 'validation-failed');
        expect(mismatch.body.detail).toMatch(/registered in state 27, but billingStateCode is 29/);
        expectProblem(await taxDetails(client('OMEGA'), { billingPincode: '5600' }), 400, 'validation-failed');
      });

      it('absent leaves a field unchanged, null clears it, a repeat writes nothing; ops 403, self 400, unknown 404', async () => {
        const key = ulid();
        const cleared = await taxDetails(client('OMEGA'), { billingLine2: 'Floor 2' }, accountantToken, key).expect(200);
        expect(cleared.body.client.taxDetails).toMatchObject({ billingLine2: 'Floor 2', legalName: 'Brand Private Limited' });
        // The same key replays.
        await taxDetails(client('OMEGA'), { billingLine2: 'Floor 2' }, accountantToken, key).expect(200);
        const nulled = await taxDetails(client('OMEGA'), { billingLine2: null }).expect(200);
        expect(nulled.body.client.taxDetails.billingLine2).toBeNull();
        const before = await sql<{ n: number }[]>`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and target_id = ${client('OMEGA')} and action = 'client.tax-details-updated'`;
        await taxDetails(client('OMEGA'), { billingLine2: '  ' }).expect(200); // blank = clear = unchanged
        const after = await sql<{ n: number }[]>`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and target_id = ${client('OMEGA')} and action = 'client.tax-details-updated'`;
        expect(after[0]!.n).toBe(before[0]!.n);
        expectProblem(await taxDetails(client('OMEGA'), { legalName: 'X' }, opsToken), 403, 'role-denied');
        expectProblem(await taxDetails(selfId, { legalName: 'X' }), 400, 'validation-failed');
        expectProblem(await taxDetails(uuidv7(), { legalName: 'X' }), 404, 'not-found');
      });
    });

    // ── prepare: the refusals ─────────────────────────────────────────────
    describe('prepare — the refusals', () => {
      it('a month that has not ended is 409 period-not-ended (October, prepared on the 20th)', async () => {
        clientInvoiceClock.now = () => ist('2026-10-20T10:00');
        try {
          expectProblem(await prepare(client('ACME'), '2026-10'), 409, 'period-not-ended');
          expectProblem(await prepare(client('ACME'), '2027-01'), 409, 'period-not-ended');
        } finally {
          clientInvoiceClock.now = () => AT_OCT_7;
        }
      });

      it('the tenant’s own client is 409 client-not-billable; a client with no usage 409 nothing-to-invoice; unknown 404; a bad month 400', async () => {
        expectProblem(await prepare(selfId, '2026-09'), 409, 'client-not-billable');
        expectProblem(await prepare(client('OMEGA'), '2026-09'), 409, 'nothing-to-invoice');
        expectProblem(await prepare(uuidv7(), '2026-09'), 404, 'not-found');
        expectProblem(await prepare(client('ACME'), '2026-9'), 400, 'validation-failed');
      });

      it('the ops manager is refused (billing.invoice is owner + accountant); a portal session cannot read', async () => {
        expectProblem(await prepare(client('ACME'), '2026-09', opsToken), 403, 'role-denied');
        const list = await http().get(`${API}/${tenantId}/client-invoices`).set('Authorization', `Bearer ${portalToken}`);
        expectProblem(list, 403, 'role-denied');
        const one = await http().get(`${API}/${tenantId}/client-invoices/${uuidv7()}`).set('Authorization', `Bearer ${portalToken}`);
        expectProblem(one, 403, 'role-denied');
      });
    });

    // ── the AC: ACME's September, prepared and issued ──────────────────────
    describe('ACME: prepared, issued, frozen', () => {
      let acme29: InvoiceBody;
      let issued: InvoiceBody;

      it('prepare creates ONE draft — only group 29 has usage — with two lines per charge across the card change', async () => {
        const res = await prepare(client('ACME'), '2026-09').expect(201);
        expect(res.body.existing).toEqual([]);
        expect(res.body.created).toHaveLength(1);
        acme29 = res.body.created[0] as InvoiceBody;
        expect(acme29).toMatchObject({ status: 'draft', invoiceNo: null, supplierGstin: T29, placeOfSupply: '29', supplyType: 'intra' });
        expect(acme29.gaps).toEqual([]);
        expect(acme29.warnings).toEqual([]);
        expect(acme29.lines.map((line) => [line.segmentFrom, line.chargeCode, line.quantity, line.rateCardId])).toEqual([
          ['2026-09-01', 'storage', '1500', cards.get('ACME-A')], // the 10th–14th × 300
          ['2026-09-01', 'inbound_handling', '2', cards.get('ACME-A')],
          ['2026-09-15', 'storage', '900', cards.get('ACME-B')], // the 15th–17th × 300
          ['2026-09-15', 'pick', '1', cards.get('ACME-B')],
          ['2026-09-15', 'outbound_handling', '1', cards.get('ACME-B')],
        ]);
      });

      it('it reconciles per line (quantity × rate, 18 % half-up, CGST/SGST with the odd paisa to SGST) and in total (payable a whole rupee)', () => {
        let subtotal = 0;
        let cgst = 0;
        let sgst = 0;
        for (const line of acme29.lines) {
          const expectedAmount =
            line.chargeCode === 'storage'
              ? storageAmountPaise(decimalToMilli(line.quantity), line.unitAmountPaise!)
              : Number(line.quantity) * line.unitAmountPaise!;
          expect(line.amountPaise).toBe(expectedAmount);
          const tax = Number(gst.computeLineTax(1000, expectedAmount as never, 1800 as never, 'intra').gstPaise);
          expect(line.cgstPaise + line.sgstPaise).toBe(tax);
          expect(line.cgstPaise).toBe(Math.floor(tax / 2));
          expect(line.igstPaise).toBe(0);
          expect(line.gstBps).toBe(1800);
          expect(line.sac).toBe(line.chargeCode === 'storage' ? '996729' : '996719');
          subtotal += expectedAmount;
          cgst += line.cgstPaise;
          sgst += line.sgstPaise;
        }
        // 495 + 1000 + 360 + 350 + 2500.
        expect(subtotal).toBe(4705);
        expect(acme29.totals).toEqual({ subtotal: 4705, cgst, sgst, igst: 0, tax: cgst + sgst, roundOff: 5600 - (4705 + cgst + sgst), payable: 5600 });
        expect(acme29.totals.payable % 100).toBe(0);
      });

      it('the hash is stable across reads; a refresh with nothing changed rewrites nothing', async () => {
        const lineIds = async () =>
          (await sql<{ id: string }[]>`select id from client_invoice_lines where invoice_id = ${acme29.id} order by id`).map((row) => row.id);
        const first = await contentHash(acme29.id);
        const idsBefore = await lineIds();
        expect(idsBefore).toHaveLength(5);
        await getInvoice(acme29.id).expect(200);
        const refreshed = await act(acme29.id, 'refresh').expect(200);
        expect(refreshed.body.invoice).toEqual(acme29);
        // Neither the row (content_hash, updated_at) nor its lines were rewritten.
        expect(await contentHash(acme29.id)).toEqual(first);
        expect(await lineIds()).toEqual(idsBefore);
      });

      it('issue: 29/S2627/000001, with the full Rule 46 party frozen', async () => {
        const res = await act(acme29.id, 'issue').expect(200);
        expect(res.body.outcome).toBe('issued');
        issued = res.body.invoice as InvoiceBody;
        expect(issued).toMatchObject({ status: 'issued', invoiceNo: '29/S2627/000001', supplierGstin: T29 });
        expect(issued.lines).toEqual(acme29.lines);
        expect(issued.totals).toEqual(acme29.totals);
        expect(issued.party.supplier).toMatchObject({ gstin: T29, stateCode: '29', stateName: 'Karnataka', address: { city: 'Bengaluru', pincode: '560066' } });
        expect(String(issued.party.supplier.name)).toMatch(/^Three PL Co/);
        expect(issued.party.recipient).toMatchObject({
          legalName: 'Acme Foods Private Limited',
          gstin: '29AAACA1111A1Z1',
          stateCode: '29',
          address: { line1: '5 Brigade Road', city: 'Bengaluru', stateCode: '29', pincode: '560025' },
        });
        expect(await seriesSeq(T29, 'FY-2627')).toBe(1);
        const audit = await sql<{ n: number }[]>`select count(*)::int as n from audit_events where target_id = ${acme29.id} and action = 'client_invoice.issued'`;
        expect(audit[0]!.n).toBe(1);
      });

      it('it reads back identically after a rate change and after new events', async () => {
        await activeCard(client('ACME'), ALL_FOUR(9999, 9999, 9999, 9999), '2026-10-09', '2026-10-08T09:00');
        await seedGrn('w1', '2026-09-25T10:00', [sku('ACME-PC')]);
        await seedPick('w1', sku('ACME-PC'), '2026-09-26T10:00');
        await taxDetails(client('ACME'), { legalName: 'Acme Foods (Renamed) Pvt Ltd' }).expect(200);
        const read = await getInvoice(issued.id).expect(200);
        expect(read.body.invoice).toEqual(issued);
        await taxDetails(client('ACME'), { legalName: 'Acme Foods Private Limited' }).expect(200);
      });

      it('an issued invoice is not refreshed, discarded or issued again (409 invoice-not-draft)', async () => {
        expectProblem(await act(issued.id, 'refresh'), 409, 'invoice-not-draft');
        expectProblem(await act(issued.id, 'issue'), 409, 'invoice-not-draft');
        expectProblem(await http().delete(`${API}/${tenantId}/client-invoices/${issued.id}`).set('Authorization', `Bearer ${accountantToken}`).set(KEY_HEADER, ulid()), 409, 'invoice-not-draft');
      });

      it('partial prepare: group 29 issued, group 27 gains usage → created [27], existing [29]; the sum over groups equals the unfiltered meter', async () => {
        await receive('w3', 'ACME-PC', 4_000, '2026-09-21T10:00');
        await seedGrn('w3', '2026-09-21T10:00', [sku('ACME-PC')]);
        await seedPick('w3', sku('ACME-PC'), '2026-09-22T10:00');
        await settle('ACME', 'w3', AT_OCT_1);
        const res = await prepare(client('ACME'), '2026-09').expect(201);
        expect((res.body.created as InvoiceBody[]).map((row) => row.supplierGstin)).toEqual([W27]);
        expect((res.body.existing as InvoiceBody[]).map((row) => row.id)).toEqual([issued.id]);
        // The existing one is still byte-identical.
        expect(res.body.existing[0]).toEqual(issued);
        const acme27 = res.body.created[0] as InvoiceBody;
        // ACME is registered in 29; supplied from 27 → inter-state IGST.
        expect(acme27).toMatchObject({ placeOfSupply: '29', supplyType: 'inter' });
        expect(acme27.lines.every((line) => line.cgstPaise === 0 && line.sgstPaise === 0)).toBe(true);
        // Supplier address is WH3's (Mumbai) under 27.
        expect(acme27.party.supplier).toMatchObject({ gstin: W27, stateCode: '27', address: { city: 'Mumbai' } });

        // Group-sum equality, every charge of every segment: WH1+WH2 ⊕ WH3 = all.
        const all = await withTenantTransaction(db, tenantId, (tx) => metering.meterPeriodInTx(tx, tenantId, client('ACME'), '2026-09-01', '2026-09-30'));
        const parts = await Promise.all(
          [[wh.w1, wh.w2], [wh.w3]].map((ids) =>
            withTenantTransaction(db, tenantId, (tx) => metering.meterPeriodInTx(tx, tenantId, client('ACME'), '2026-09-01', '2026-09-30', { warehouseIds: ids })),
          ),
        );
        const key = (segment: { fromDate: string }, line: { chargeCode: string; uom: string | null }) => `${segment.fromDate}|${line.chargeCode}|${line.uom ?? ''}`;
        const sum = new Map<string, { milli: bigint; amount: number }>();
        for (const part of parts) {
          for (const segment of part.segments) {
            for (const line of segment.lines) {
              const k = key(segment, line);
              const prev = sum.get(k) ?? { milli: 0n, amount: 0 };
              sum.set(k, { milli: prev.milli + decimalToMilli(line.quantity), amount: prev.amount + (line.amountPaise ?? 0) });
            }
          }
        }
        let compared = 0;
        for (const segment of all.segments) {
          for (const line of segment.lines) {
            const got = sum.get(key(segment, line)) ?? { milli: 0n, amount: 0 };
            expect(got.milli).toBe(decimalToMilli(line.quantity));
            // Rounding is per line, so amounts may differ by at most a paisa per part; they are equal here.
            expect(got.amount).toBe(line.amountPaise ?? 0);
            compared += 1;
          }
        }
        expect(compared).toBeGreaterThanOrEqual(8);
        expect([...sum.values()].some((value) => value.milli > 0n)).toBe(true);

        // Issued in its OWN series: 27/S2627/000001.
        const issued27 = await act(acme27.id, 'issue').expect(200);
        expect(issued27.body.invoice.invoiceNo).toBe('27/S2627/000001');
      });
    });

    // ── the other matrix rows ─────────────────────────────────────────────
    describe('the matrix', () => {
      it('two registrations: BETA in WH2 and WH3 → two drafts; unregistered, billed in 27 → IGST from 29, CGST+SGST from 27', async () => {
        const res = await prepare(client('BETA'), '2026-09').expect(201);
        const created = res.body.created as InvoiceBody[];
        expect(created.map((row) => [row.supplierGstin, row.placeOfSupply, row.supplyType])).toEqual([
          [W27, '27', 'intra'],
          [T29, '27', 'inter'],
        ]);
        expect(created.map((row) => row.warnings)).toEqual([[], []]);
        const [from27, from29] = created;
        expect(from29!.lines.map((line) => [line.chargeCode, line.quantity])).toEqual([
          ['storage', '260'], // 10 units × the 5th–30th
          ['inbound_handling', '1'],
        ]);
        expect(from27!.lines.map((line) => [line.chargeCode, line.quantity])).toEqual([
          ['storage', '460'], // 20 units × the 8th–30th
          ['inbound_handling', '1'],
          ['pick', '1'],
        ]);
        expect(from29!.lines.every((line) => line.cgstPaise === 0 && line.igstPaise > 0)).toBe(true);
        expect(from27!.lines.every((line) => line.igstPaise === 0 && line.cgstPaise + line.sgstPaise > 0)).toBe(true);
        // 260 unit-days × ₹10 per 1,000 units/day = 260 paise; 1 line × 700.
        // At 18 % IGST, per line half-up: 260 → 46.8 → 47, 700 → 126.
        expect(from29!.totals).toMatchObject({ subtotal: 960, cgst: 0, sgst: 0, igst: 173, tax: 173 });
      });

      it('single GSTIN: GAMMA in WH1 and WH2 → ONE draft summing both warehouses', async () => {
        const res = await prepare(client('GAMMA'), '2026-09').expect(201);
        expect(res.body.created).toHaveLength(1);
        const gamma = res.body.created[0] as InvoiceBody;
        expect(gamma.supplierGstin).toBe(T29);
        expect(gamma.warnings).toEqual([]);
        // 5 units × the 2nd–30th (29 days) + 7 × the 3rd–30th (28) = 145 + 196.
        expect(gamma.lines.map((line) => [line.chargeCode, line.quantity])).toEqual([
          ['storage', '341'],
          ['inbound_handling', '2'],
        ]);
      });

      it('stale: a GRN line arrives late → 200 {outcome: stale}, the fresh draft stored, no number used; issuing again numbers it', async () => {
        const gamma = (await http().get(`${API}/${tenantId}/client-invoices?clientId=${client('GAMMA')}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.items[0] as { id: string };
        const seqBefore = await seriesSeq(T29, 'FY-2627');
        await seedGrn('w2', '2026-09-28T10:00', [sku('GAMMA-PC')]);
        const key = ulid();
        const stale = await act(gamma.id, 'issue', {}, key).expect(200);
        expect(stale.body.outcome).toBe('stale');
        expect(stale.body.invoice.status).toBe('draft');
        expect(stale.body.invoice.invoiceNo).toBeNull();
        expect((stale.body.invoice as InvoiceBody).lines.find((line) => line.chargeCode === 'inbound_handling')!.quantity).toBe('3');
        expect(await seriesSeq(T29, 'FY-2627')).toBe(seqBefore);
        // The stale answer is recorded under its key (a replay re-serves it)…
        const replay = await act(gamma.id, 'issue', {}, key).expect(200);
        expect(replay.body).toEqual(stale.body);
        // …and a NEW key issues the fresh draft.
        const issued = await act(gamma.id, 'issue').expect(200);
        expect(issued.body).toMatchObject({ outcome: 'issued', invoice: { invoiceNo: '29/S2627/000002' } });
      });

      it('void and replace: the void keeps its number; the next prepare drafts a replacement naming it', async () => {
        const gamma = (await http().get(`${API}/${tenantId}/client-invoices?clientId=${client('GAMMA')}&status=issued`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.items[0] as { id: string; invoiceNo: string };
        expectProblem(await act(gamma.id, 'void', {}), 400, 'validation-failed');
        const voided = await act(gamma.id, 'void', { note: 'Wrong legal name printed; already in GSTR-1? no' }).expect(200);
        expect(voided.body.invoice).toMatchObject({ status: 'void', invoiceNo: gamma.invoiceNo, statusNote: 'Wrong legal name printed; already in GSTR-1? no' });
        const first = await prepare(client('GAMMA'), '2026-09').expect(201);
        expect(first.body.existing).toEqual([]);
        expect(first.body.created[0]).toMatchObject({ status: 'draft', replacesInvoiceId: gamma.id });
        // A discarded replacement frees the void: the next prepare names it again.
        await http()
          .delete(`${API}/${tenantId}/client-invoices/${first.body.created[0].id as string}`)
          .set('Authorization', `Bearer ${accountantToken}`)
          .set(KEY_HEADER, ulid())
          .expect(204);
        const again = await prepare(client('GAMMA'), '2026-09').expect(201);
        expect(again.body.created[0]).toMatchObject({ status: 'draft', replacesInvoiceId: gamma.id });
        expect(again.body.created[0].id).not.toBe(first.body.created[0].id);
        const replacement = await act(again.body.created[0].id as string, 'issue').expect(200);
        expect(replacement.body.invoice.invoiceNo).toBe('29/S2627/000003');
        // A void is terminal.
        expectProblem(await act(gamma.id, 'settle'), 409, 'invoice-transition-invalid');
      });

      it('transitions: issued → disputed → settled; settled → disputed is 409; a draft cannot be disputed; the audit keeps every note', async () => {
        const replacement = (await http().get(`${API}/${tenantId}/client-invoices?clientId=${client('GAMMA')}&status=issued`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.items[0] as { id: string };
        await act(replacement.id, 'dispute', { note: 'Client contests the storage days' }).expect(200);
        const settled = await act(replacement.id, 'settle', { note: 'Agreed after review' }).expect(200);
        expect(settled.body.invoice).toMatchObject({ status: 'settled', statusNote: 'Agreed after review' });
        expectProblem(await act(replacement.id, 'dispute', { note: 'again' }), 409, 'invoice-transition-invalid');
        const notes = await sql<{ action: string; reference: string }[]>`select action, reference from audit_events
          where target_id = ${replacement.id} and action in ('client_invoice.disputed', 'client_invoice.settled') order by occurred_at`;
        expect(notes.map((row) => [row.action, row.reference.split(' (key')[0]])).toEqual([
          ['client_invoice.disputed', 'note: Client contests the storage days'],
          ['client_invoice.settled', 'note: Agreed after review'],
        ]);
        const draftId = ((await prepare(client('KAPPA'), '2026-09').expect(201)).body.created[0] as InvoiceBody).id;
        expectProblem(await act(draftId, 'dispute', { note: 'x' }), 409, 'invoice-transition-invalid');
        expectProblem(await act(draftId, 'dispute', {}), 400, 'validation-failed');
      });

      it('storage incomplete: DELTA measured only through the 19th → a storage-not-complete gap (no line-unpriced for storage); issue 409 naming it', async () => {
        const res = await prepare(client('DELTA'), '2026-09').expect(201);
        const delta = res.body.created[0] as InvoiceBody;
        expect(delta.gaps.map((gap) => gap.code)).toEqual(['storage-not-complete']);
        const refused = await act(delta.id, 'issue');
        expectProblem(refused, 409, 'invoice-has-gaps');
        expect((refused.body.gaps as { code: string }[]).map((gap) => gap.code)).toEqual(['storage-not-complete']);
        expect(await seriesSeq(T29, 'FY-2627')).toBe(3);
      });

      it('no card: ZETA’s lines are unpriced → line-unpriced gaps naming each segment; issue 409', async () => {
        const zeta = (await prepare(client('ZETA'), '2026-09').expect(201)).body.created[0] as InvoiceBody;
        expect(zeta.gaps.map((gap) => [gap.code, gap.segmentFrom])).toEqual([
          ['line-unpriced', '2026-09-01'],
          ['line-unpriced', '2026-09-01'],
        ]);
        expect(zeta.lines.every((line) => line.rateCardId === null && line.amountPaise === null)).toBe(true);
        expectProblem(await act(zeta.id, 'issue'), 409, 'invoice-has-gaps');
      });

      it('e-invoicing GSTIN: the flag on 27 and a registered client → einvoice-required; issue 409; the flag off clears it on refresh', async () => {
        await http()
          .put(`${API}/${tenantId}/eway/gstin-settings/${W27}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ eInvoiceApplies: true })
          .expect(200);
        const eps = (await prepare(client('EPS'), '2026-09').expect(201)).body.created[0] as InvoiceBody;
        expect(eps.gaps.map((gap) => gap.code)).toEqual(['einvoice-required']);
        expectProblem(await act(eps.id, 'issue'), 409, 'invoice-has-gaps');
        await http()
          .put(`${API}/${tenantId}/eway/gstin-settings/${W27}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ eInvoiceApplies: false })
          .expect(200);
        const refreshed = await act(eps.id, 'refresh').expect(200);
        expect(refreshed.body.invoice.gaps).toEqual([]);
      });

      it('discard: a draft is deleted (204, replay 204, a new key 404); the void’s replacement link is freed with it', async () => {
        const delta = (await http().get(`${API}/${tenantId}/client-invoices?clientId=${client('DELTA')}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.items[0] as { id: string };
        const key = ulid();
        const discard = (k: string) => http().delete(`${API}/${tenantId}/client-invoices/${delta.id}`).set('Authorization', `Bearer ${accountantToken}`).set(KEY_HEADER, k);
        await discard(key).expect(204);
        await discard(key).expect(204);
        expectProblem(await discard(ulid()), 404, 'not-found');
        const rows = await sql<{ n: number }[]>`select count(*)::int as n from client_invoice_lines where invoice_id = ${delta.id}`;
        expect(rows[0]!.n).toBe(0);
      });

      it('a series race: two drafts of one GSTIN issued concurrently take consecutive numbers, no gap', async () => {
        const beta29 = (await http().get(`${API}/${tenantId}/client-invoices?clientId=${client('BETA')}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.items.find(
          (row: { supplierGstin: string }) => row.supplierGstin === T29,
        ) as { id: string };
        const kappa = (await http().get(`${API}/${tenantId}/client-invoices?clientId=${client('KAPPA')}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.items[0] as { id: string };
        const before = (await seriesSeq(T29, 'FY-2627'))!;
        const [a, b] = await Promise.all([act(beta29.id, 'issue'), act(kappa.id, 'issue')]);
        expect([a.status, b.status]).toEqual([200, 200]);
        const numbers = [a.body.invoice.invoiceNo as string, b.body.invoice.invoiceNo as string].sort();
        expect(numbers).toEqual([gst.formatServiceInvoiceNo(T29, 'FY-2627', before + 1), gst.formatServiceInvoiceNo(T29, 'FY-2627', before + 2)]);
        expect(await seriesSeq(T29, 'FY-2627')).toBe(before + 2);
      });

      it('the FY boundary: a September invoice issued in April takes the next FY’s series, from 000001', async () => {
        const fyc = (await prepare(client('FYC'), '2026-09').expect(201)).body.created[0] as InvoiceBody;
        clientInvoiceClock.now = () => ist('2027-04-01T10:00');
        try {
          const res = await act(fyc.id, 'issue').expect(200);
          expect(res.body.invoice).toMatchObject({ invoiceNo: '29/S2728/000001', fyLabel: 'FY-2728' });
        } finally {
          clientInvoiceClock.now = () => AT_OCT_7;
        }
        expect(await seriesSeq(T29, 'FY-2728')).toBe(1);
        // FY-2627 is untouched by it.
        expect(await seriesSeq(T29, 'FY-2627')).toBe(5);
      });

      it('the list: keyset pages newest first, filters by client and status; a malformed cursor is 400', async () => {
        const page1 = await http().get(`${API}/${tenantId}/client-invoices?limit=2`).set('Authorization', `Bearer ${opsToken}`).expect(200);
        expect(page1.body.items).toHaveLength(2);
        expect(page1.body.nextCursor).toEqual(expect.any(String));
        const page2 = await http().get(`${API}/${tenantId}/client-invoices?limit=2&cursor=${page1.body.nextCursor as string}`).set('Authorization', `Bearer ${opsToken}`).expect(200);
        const ids = new Set([...page1.body.items, ...page2.body.items].map((row: { id: string }) => row.id));
        expect(ids.size).toBe(4);
        const issued = await http().get(`${API}/${tenantId}/client-invoices?status=issued&limit=100`).set('Authorization', `Bearer ${opsToken}`).expect(200);
        expect((issued.body.items as { status: string; gapCount: number }[]).every((row) => row.status === 'issued' && row.gapCount === 0)).toBe(true);
        expectProblem(await http().get(`${API}/${tenantId}/client-invoices?cursor=nope`).set('Authorization', `Bearer ${opsToken}`), 400, 'invalid-cursor');
        expectProblem(await http().get(`${API}/${tenantId}/client-invoices?limit=101`).set('Authorization', `Bearer ${opsToken}`), 400, 'validation-failed');
      });
    });

    describe('review fixes (C1 and after)', () => {
      it('C1: a group with counts but NO stock events (no snapshot scope) issues — the gap reads the CLIENT’s storage watermark', async () => {
        const rhoId = (
          await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'RHO', name: 'RHO Brand' }).expect(201)
        ).body.client.id as string;
        clients.set('RHO', rhoId);
        await importSkus(rhoId, ['RHO-PC,RHO item,each,1800,,,']);
        const skuList = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
        for (const item of skuList.body.items as { code: string; id: string }[]) skus.set(item.code, item.id);
        await taxDetails(rhoId, FULL()).expect(200);
        await activeCard(rhoId, ALL_FOUR(1000, 700, 300, 2000), '2026-09-01', '2026-09-01T09:00');
        // Stock in WH1 (group 29, a snapshot scope) …
        await receive('w1', 'RHO-PC', 2_000, '2026-09-03T10:00');
        await settle('RHO', 'w1', AT_OCT_1);
        // … and in WH3 (group 27) only a receipt line, rejected in full: no ledger event, no scope.
        await seedGrn('w3', '2026-09-04T10:00', [sku('RHO-PC')]);
        const res = await prepare(rhoId, '2026-09').expect(201);
        const from27 = (res.body.created as InvoiceBody[]).find((row) => row.supplierGstin === W27)!;
        expect(from27.lines.map((line) => [line.chargeCode, line.quantity])).toEqual([['inbound_handling', '1']]);
        expect(from27.gaps).toEqual([]);
        expect(await act(from27.id, 'issue').expect(200)).toMatchObject({ body: { outcome: 'issued' } });
      });

      it('supplier-state-differs through prepare: a 29-GSTIN warehouse whose origin is in Maharashtra warns (the real state resolver) — and never blocks', async () => {
        const w4 = await createWarehouse(`CI4-${ulid().slice(20)}`, '29AAACT1234A2Z4', testAddress({ city: 'Mumbai', state: 'Maharashtra', pincode: '400003' }));
        const sigmaId = (
          await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: 'SIGMA', name: 'SIGMA Brand' }).expect(201)
        ).body.client.id as string;
        clients.set('SIGMA', sigmaId);
        await importSkus(sigmaId, ['SIGMA-PC,SIGMA item,each,1800,,,']);
        const skuList = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
        for (const item of skuList.body.items as { code: string; id: string }[]) skus.set(item.code, item.id);
        await taxDetails(sigmaId, FULL()).expect(200);
        await activeCard(sigmaId, ALL_FOUR(1000, 700, 300, 2000), '2026-09-01', '2026-09-01T09:00');
        await append({ warehouseId: w4.warehouseId, type: 'grn.received', skuId: sku('SIGMA-PC'), quantityDelta: 1_000, toBinId: w4.binId, recordedAt: istIso('2026-09-05T10:00') });
        for (let i = 0; i < 4; i += 1) {
          const tick = await billing.snapshotScope(tenantId, sigmaId, w4.warehouseId, AT_OCT_1);
          if (tick.waiting !== 'commit-guarantee') break;
        }
        const res = await prepare(sigmaId, '2026-09').expect(201);
        const invoice = (res.body.created as InvoiceBody[])[0]!;
        expect(invoice.supplierGstin).toBe('29AAACT1234A2Z4');
        expect(invoice.warnings).toEqual([{ code: 'supplier-state-differs', detail: expect.stringContaining('is in Maharashtra (27)') as unknown as string }]);
        expect(invoice.gaps).toEqual([]);
      });

      it('settle stores its OWN note (or none) — never the dispute’s; a note is counted in code points (500 astral characters pass, 501 do not)', async () => {
        const beta27 = (await http().get(`${API}/${tenantId}/client-invoices?clientId=${client('BETA')}`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body.items.find(
          (row: { supplierGstin: string }) => row.supplierGstin === W27,
        ) as { id: string };
        await act(beta27.id, 'issue').expect(200);
        expectProblem(await act(beta27.id, 'dispute', { note: '😀'.repeat(501) }), 400, 'validation-failed');
        const disputed = await act(beta27.id, 'dispute', { note: '😀'.repeat(500) }).expect(200);
        expect(disputed.body.invoice.statusNote).toBe('😀'.repeat(500));
        const settled = await act(beta27.id, 'settle', {}).expect(200);
        expect(settled.body.invoice).toMatchObject({ status: 'settled', statusNote: null });
      });
    });

    it('every route is in the OpenAPI document', async () => {
      const doc = await http().get('/api/v1/openapi.json').expect(200);
      const paths = Object.keys(doc.body.paths as Record<string, unknown>);
      for (const path of [
        '/tenants/{tenantId}/clients/{clientId}/tax-details',
        '/tenants/{tenantId}/clients/{clientId}/invoices',
        '/tenants/{tenantId}/client-invoices',
        '/tenants/{tenantId}/client-invoices/{invoiceId}',
        '/tenants/{tenantId}/client-invoices/{invoiceId}/refresh',
        '/tenants/{tenantId}/client-invoices/{invoiceId}/issue',
        '/tenants/{tenantId}/client-invoices/{invoiceId}/dispute',
        '/tenants/{tenantId}/client-invoices/{invoiceId}/settle',
        '/tenants/{tenantId}/client-invoices/{invoiceId}/void',
      ]) {
        expect(paths).toContain(path);
      }
    });
  });
});
