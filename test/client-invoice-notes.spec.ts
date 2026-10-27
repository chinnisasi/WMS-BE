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
import { createDatabase } from '../src/shared/db/db';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import * as gst from '../src/shared/primitives/gst';
import { CHARGE_CODES } from '../src/modules/billing/rate-cards';
import { clientInvoiceClock } from '../src/modules/billing/client-invoices';
import {
  NOTE_KINDS,
  NOTE_REASONS_BY_KIND,
  NOTE_STATUSES,
  computeNoteFigures,
  creditNoteDeadline,
  creditNoteLastDay,
  gstr1VoidCutoff,
  netDocumentOf,
  normalizeCreate,
  supplyFyLabel,
  type NoteFiguresInput,
  type NoteHeads,
} from '../src/modules/billing/client-invoice-notes';
import { ProblemException } from '../src/shared/problem-details/problem.exception';
import { expectAuditRow } from './support/audit-guard';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
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
 * Story 5-6a — credit and debit notes against a client services invoice.
 *
 *   Part A — the pure pieces: the note number, the figures (every literal-
 *            paise matrix row), the four time rules on their boundary pairs.
 *   Part B — migration 0098 on a database built from the journal trimmed
 *            before it, applied inside one transaction.
 *   Part C — over HTTP: every frozen and amended matrix row, the races (the
 *            same-key parked race, the two-key race, the deadlock case), the
 *            gap-free series, the direct-SQL trigger arms, the portal, the
 *            register, the audit rows and the outbox.
 *
 * Invoices are seeded by direct SQL (the 0062 trigger path: a draft with its
 * lines, then issued) — the matrix needs literal paise a metered month
 * cannot produce; the NOTES are driven only through the API.
 */

/** An IST wall-clock instant in ms: `ist('2027-11-30T23:59:59.999')`. */
function ist(local: string): number {
  return Date.parse(`${local}${local.length === 16 ? ':00' : ''}+05:30`);
}

// ── Part A ──────────────────────────────────────────────────────────────────

function line(id: string, amount: number, supply: gst.SupplyType = 'intra', bps = 1800) {
  const tax = gst.computeLineTax(1000, gst.asPaise(amount), gst.asGstBps(bps), supply);
  return { id, amountPaise: amount, cgstPaise: tax.cgstPaise, sgstPaise: tax.sgstPaise, igstPaise: tax.igstPaise, gstBps: bps, supplyType: supply };
}

function figures(input: Partial<NoteFiguresInput> & Pick<NoteFiguresInput, 'invoiceLines' | 'lines'>) {
  return computeNoteFigures({
    kind: 'credit',
    invoicePayablePaise: input.invoicePayablePaise ?? 0,
    issuedCredits: new Map<string, NoteHeads>(),
    priorCreditPayablePaise: 0,
    ...input,
  });
}

function problemOf(fn: () => unknown): { code: string; extensions?: Record<string, unknown> } {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProblemException) {
      const body = err.getResponse() as { code: string; extensions?: Record<string, unknown> };
      return body;
    }
    throw err;
  }
  throw new Error('expected a ProblemException');
}

describe('story 5-6a: credit and debit notes', () => {
  describe('the pure pieces', () => {
    it('formatServiceNoteNo: its own C and D series, 15 characters, six digits; 1,000,000 is the series exhausted', () => {
      expect(gst.formatServiceNoteNo('29AAACT1234A1Z5', 'credit', 'FY-2627', 1)).toBe('29/C2627/000001');
      expect(gst.formatServiceNoteNo('29AAACT1234A1Z5', 'debit', 'FY-2627', 1)).toBe('29/D2627/000001');
      expect(gst.formatServiceNoteNo('27AAACT1234A1Z6', 'credit', 'FY-2728', 999_999)).toBe('27/C2728/999999');
      expect(gst.formatServiceNoteNo('29AAACT1234A1Z5', 'credit', 'FY-2627', 1)).toHaveLength(15);
      expect(() => gst.formatServiceNoteNo('29AAACT1234A1Z5', 'credit', 'FY-2627', 1_000_000)).toThrow(/note series exhausted/);
      expect(() => gst.formatServiceNoteNo('29AAACT1234A1Z5', 'credit', 'FY-2627', 1_000_000)).toThrow(gst.ArithmeticOverflowError);
      expect(() => gst.formatServiceNoteNo('29AAACT1234A1Z5', 'credit', '2627', 1)).toThrow(/malformed FY label/);
    });

    it('A12: every series of one GSTIN — goods invoice, S, C, D — is prefix-disjoint up to the FY digits', () => {
      const gstin = '29AAACT1234A1Z5';
      const numbers = [
        gst.formatInvoiceNo(gstin, 'FY-2627', 1),
        gst.formatServiceInvoiceNo(gstin, 'FY-2627', 1),
        gst.formatServiceNoteNo(gstin, 'credit', 'FY-2627', 1),
        gst.formatServiceNoteNo(gstin, 'debit', 'FY-2627', 1),
      ];
      expect(numbers).toEqual(['29/2627/000001', '29/S2627/000001', '29/C2627/000001', '29/D2627/000001']);
      // The prefix up to (and including) the FY digits differs for every pair.
      const prefixes = numbers.map((n) => n.slice(0, n.lastIndexOf('/')));
      expect(new Set(prefixes).size).toBe(4);
      for (const a of prefixes) for (const b of prefixes) if (a !== b) expect(a.startsWith(b) || b.startsWith(a)).toBe(false);
    });

    it('credit draft (matrix row 1): line 100000 intra at 18 %, credit 20000 → CGST 1800, SGST 1800, total 23600, payable 23600, round-off 0', () => {
      const result = figures({ invoicePayablePaise: 118_000, invoiceLines: [line('L', 100_000)], lines: [{ invoiceLineId: 'L', amountPaise: 20_000 }] });
      expect(result.lines).toEqual([{ invoiceLineId: 'L', amountPaise: 20_000, cgstPaise: 1800, sgstPaise: 1800, igstPaise: 0 }]);
      expect(result.totals).toEqual({ subtotalPaise: 20_000, cgstPaise: 1800, sgstPaise: 1800, igstPaise: 0, taxPaise: 3600, totalPaise: 23_600, roundOffPaise: 0, payablePaise: 23_600 });
    });

    it('the three-part line: 33333, 33333, then the exhausting 33334 takes exactly the remaining 3000 / 3000 (computed would be 3000.06); payables 39333, 39333, 39334', () => {
      const L = line('L', 100_000);
      expect([L.cgstPaise, L.sgstPaise]).toEqual([9000, 9000]);
      const credited = new Map<string, NoteHeads>();
      let prior = 0;
      const out: { cgst: number; sgst: number; payable: number }[] = [];
      for (const amount of [33_333, 33_333, 33_334]) {
        const result = figures({ invoicePayablePaise: 118_000, invoiceLines: [L], issuedCredits: credited, priorCreditPayablePaise: prior, lines: [{ invoiceLineId: 'L', amountPaise: amount }] });
        const head = result.lines[0]!;
        out.push({ cgst: head.cgstPaise, sgst: head.sgstPaise, payable: result.totals.payablePaise });
        const was = credited.get('L') ?? { amountPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
        credited.set('L', { amountPaise: was.amountPaise + amount, cgstPaise: was.cgstPaise + head.cgstPaise, sgstPaise: was.sgstPaise + head.sgstPaise, igstPaise: 0 });
        prior += result.totals.payablePaise;
      }
      expect(out).toEqual([
        { cgst: 3000, sgst: 3000, payable: 39_333 },
        { cgst: 3000, sgst: 3000, payable: 39_333 },
        { cgst: 3000, sgst: 3000, payable: 39_334 },
      ]);
      // The computed tax of 33334 at 18 % is 6000.12 → 6000 here too; the exhaust rule is what makes Σ heads = 18000 exact.
      expect(credited.get('L')).toEqual({ amountPaise: 100_000, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0 });
      expect(prior).toBe(118_000);
    });

    it('the ₹1.50 invoice, three ₹0.50 credits: 59, 59, then the exhausting 82 (round-off +23) — Σ payable 200, never 300', () => {
      const L = line('L', 150);
      expect([L.cgstPaise, L.sgstPaise]).toEqual([13, 14]);
      expect(gst.roundToRupee(gst.asPaise(177))).toEqual({ payable: 200, roundOff: 23 });
      const credited = new Map<string, NoteHeads>();
      let prior = 0;
      const rows: unknown[] = [];
      for (let i = 0; i < 3; i += 1) {
        const result = figures({ invoicePayablePaise: 200, invoiceLines: [L], issuedCredits: credited, priorCreditPayablePaise: prior, lines: [{ invoiceLineId: 'L', amountPaise: 50 }] });
        const head = result.lines[0]!;
        rows.push({ cgst: head.cgstPaise, sgst: head.sgstPaise, total: result.totals.totalPaise, payable: result.totals.payablePaise, roundOff: result.totals.roundOffPaise });
        const was = credited.get('L') ?? { amountPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
        credited.set('L', { amountPaise: was.amountPaise + 50, cgstPaise: was.cgstPaise + head.cgstPaise, sgstPaise: was.sgstPaise + head.sgstPaise, igstPaise: 0 });
        prior += result.totals.payablePaise;
      }
      expect(rows).toEqual([
        { cgst: 4, sgst: 5, total: 59, payable: 59, roundOff: 0 },
        { cgst: 4, sgst: 5, total: 59, payable: 59, roundOff: 0 },
        { cgst: 5, sgst: 4, total: 59, payable: 82, roundOff: 23 },
      ]);
      expect(prior).toBe(200);
    });

    it('a negative invoice round-off: the credit that would pass the remaining payable is clamped to it (round-off ≥ −49), the exhaust takes what is left', () => {
      // 120 at 18 %: tax 22 → total 142 → payable 100 (round-off −42).
      const L = line('L', 120);
      expect(L.cgstPaise + L.sgstPaise).toBe(22);
      expect(gst.roundToRupee(gst.asPaise(142))).toEqual({ payable: 100, roundOff: -42 });
      const first = figures({ invoicePayablePaise: 100, invoiceLines: [L], lines: [{ invoiceLineId: 'L', amountPaise: 100 }] });
      expect(first.totals).toMatchObject({ totalPaise: 118, payablePaise: 100, roundOffPaise: -18 });
      const credited = new Map<string, NoteHeads>([['L', { amountPaise: 100, cgstPaise: first.lines[0]!.cgstPaise, sgstPaise: first.lines[0]!.sgstPaise, igstPaise: 0 }]]);
      const rest = figures({ invoicePayablePaise: 100, invoiceLines: [L], issuedCredits: credited, priorCreditPayablePaise: 100, lines: [{ invoiceLineId: 'L', amountPaise: 20 }] });
      expect(rest.totals).toMatchObject({ totalPaise: 24, payablePaise: 0, roundOffPaise: -24 });
    });

    it('head overflow: a non-exhausting credit whose computed head passes what remains is REFUSED, never clamped (remainingSgstPaise 0)', () => {
      // Spec matrix row "line 6, credit 3 then credit 2" cannot overflow under computeLineTax (2 × 18 % = 0.36 → 0):
      // recorded in the spec's Implementation Notes; the arm is proved on a line of 9 (CGST 1, SGST 1).
      const six = line('L', 6);
      expect([six.cgstPaise, six.sgstPaise]).toEqual([0, 1]);
      const afterThree = new Map<string, NoteHeads>([['L', { amountPaise: 3, cgstPaise: 0, sgstPaise: 1, igstPaise: 0 }]]);
      expect(figures({ invoicePayablePaise: 100, invoiceLines: [six], issuedCredits: afterThree, priorCreditPayablePaise: 4, lines: [{ invoiceLineId: 'L', amountPaise: 2 }] }).lines[0]).toMatchObject({ cgstPaise: 0, sgstPaise: 0 });

      const nine = line('L', 9);
      expect([nine.cgstPaise, nine.sgstPaise]).toEqual([1, 1]);
      const first = figures({ invoicePayablePaise: 100, invoiceLines: [nine], lines: [{ invoiceLineId: 'L', amountPaise: 3 }] });
      expect(first.lines[0]).toMatchObject({ cgstPaise: 0, sgstPaise: 1 });
      const credited = new Map<string, NoteHeads>([['L', { amountPaise: 3, cgstPaise: 0, sgstPaise: 1, igstPaise: 0 }]]);
      const refusal = problemOf(() =>
        figures({ invoicePayablePaise: 100, invoiceLines: [nine], issuedCredits: credited, priorCreditPayablePaise: 4, lines: [{ invoiceLineId: 'L', amountPaise: 3 }] }),
      );
      expect(refusal.code).toBe('credit-exceeds-invoice');
      expect(refusal.extensions).toEqual({ lines: [{ invoiceLineId: 'L', remainingPaise: 6, remainingCgstPaise: 1, remainingSgstPaise: 0, remainingIgstPaise: 0 }] });
    });

    it('over the cap: issued credits of 90000 on a 100000 line, a new credit of 20000 → credit-exceeds-invoice, remainingPaise 10000', () => {
      const L = line('L', 100_000);
      const credited = new Map<string, NoteHeads>([['L', { amountPaise: 90_000, cgstPaise: 8100, sgstPaise: 8100, igstPaise: 0 }]]);
      const refusal = problemOf(() =>
        figures({ invoicePayablePaise: 118_000, invoiceLines: [L], issuedCredits: credited, priorCreditPayablePaise: 106_200, lines: [{ invoiceLineId: 'L', amountPaise: 20_000 }] }),
      );
      expect(refusal.code).toBe('credit-exceeds-invoice');
      expect((refusal.extensions!.lines as { remainingPaise: number }[])[0]!.remainingPaise).toBe(10_000);
    });

    it('a debit takes the original line’s rule with no cap and pays its total; inter-state is IGST', () => {
      const result = computeNoteFigures({
        kind: 'debit',
        invoicePayablePaise: 118_000,
        invoiceLines: [line('L', 100_000, 'inter')],
        issuedCredits: new Map(),
        priorCreditPayablePaise: 0,
        lines: [{ invoiceLineId: 'L', amountPaise: 120_000 }],
      });
      expect(result.totals).toEqual({ subtotalPaise: 120_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 21_600, taxPaise: 21_600, totalPaise: 141_600, roundOffPaise: 0, payablePaise: 141_600 });
    });

    it('netDocumentOf: invoice − issued credits + issued debits; drafts and voids add nothing', () => {
      const invoice = { subtotal: 100_000, cgst: 9000, sgst: 9000, igst: 0, tax: 18_000, roundOff: 0, payable: 118_000 };
      const credit = { subtotal: 20_000, cgst: 1800, sgst: 1800, igst: 0, tax: 3600, roundOff: 0, payable: 23_600 };
      const debit = { subtotal: 1000, cgst: 90, sgst: 90, igst: 0, tax: 180, roundOff: 0, payable: 1180 };
      expect(
        netDocumentOf(invoice, [
          { kind: 'credit', status: 'issued', totals: credit },
          { kind: 'debit', status: 'issued', totals: debit },
          { kind: 'credit', status: 'draft', totals: credit },
          { kind: 'credit', status: 'void', totals: credit },
        ]),
      ).toEqual({ subtotal: 81_000, cgst: 7290, sgst: 7290, igst: 0, tax: 14_580, roundOff: 0, payable: 95_580 });
    });

    it('the time rules on their boundaries: the s.34(2) deadline, the supply FY, the note FY and the GSTR-1 void cutoff', () => {
      // FY-2627 → the first refused instant is 1 Dec 2027 00:00 IST; the last day is 30 Nov 2027.
      expect(creditNoteDeadline('FY-2627')).toBe(new Date(ist('2027-12-01T00:00')).toISOString());
      expect(creditNoteLastDay('FY-2627')).toBe('2027-11-30');
      // The supply FY is the EARLIER of the period's and the invoice's.
      expect(supplyFyLabel('2027-03-31', 'FY-2728')).toBe('FY-2627');
      expect(supplyFyLabel('2026-09-30', 'FY-2627')).toBe('FY-2627');
      // The note's own FY is its issue instant's in IST: 2027-03-31T20:00Z is 01:30 IST on 1 April.
      expect(gst.fyLabelFor('2027-03-31T20:00:00.000Z')).toBe('FY-2728');
      expect(gst.fyLabelFor('2027-03-31T18:29:59.999Z')).toBe('FY-2627');
      // Issued 20 May 2027 (IST) → voids close at 12 June 00:00 IST; December rolls into January.
      expect(gstr1VoidCutoff(new Date(ist('2027-05-20T10:00')).toISOString())).toBe(new Date(ist('2027-06-12T00:00')).toISOString());
      expect(gstr1VoidCutoff(new Date(ist('2027-12-31T23:59')).toISOString())).toBe(new Date(ist('2028-01-12T00:00')).toISOString());
      // An instant at 23:59 IST on the 31st of May is still a May note.
      expect(gstr1VoidCutoff(new Date(ist('2027-05-31T23:59:59.999')).toISOString())).toBe(new Date(ist('2027-06-12T00:00')).toISOString());
    });

    it('the shape (400, above the transaction): kind, reason paired with the kind, the reason note, settles, lines', () => {
      const ok = { tenantId: 't', actorUserId: 'a', invoiceId: uuidv7(), kind: 'credit', reason: 'excess-billed', reasonNote: '  Rate typo  ', lines: [{ invoiceLineId: uuidv7(), amountPaise: 100 }] };
      expect(normalizeCreate(ok).reasonNote).toBe('Rate typo');
      const id = uuidv7();
      for (const bad of [
        { ...ok, kind: 'refund' },
        { ...ok, kind: 'debit' }, // excess-billed is a credit reason
        { ...ok, kind: 'debit', reason: 'short-billed', settlesDispute: true },
        { ...ok, reason: 'dispute-settlement' }, // A2 dropped it
        { ...ok, reasonNote: '   ' },
        { ...ok, reasonNote: 'x'.repeat(501) },
        { ...ok, lines: [] },
        { ...ok, lines: [{ invoiceLineId: id, amountPaise: 1 }, { invoiceLineId: id, amountPaise: 2 }] },
        { ...ok, lines: [{ invoiceLineId: uuidv7(), amountPaise: 0 }] },
        { ...ok, lines: [{ invoiceLineId: uuidv7(), amountPaise: 1.5 }] },
        { ...ok, lines: [{ invoiceLineId: 'nope', amountPaise: 1 }] },
        { ...ok, lines: [{ invoiceLineId: uuidv7(), amountPaise: 1, overrideReason: 'a credit has no override' }] },
        { ...ok, lines: Array.from({ length: 101 }, () => ({ invoiceLineId: uuidv7(), amountPaise: 1 })) },
      ]) {
        expect(problemOf(() => normalizeCreate(bad)).code).toBe('validation-failed');
      }
      // 500 astral code points pass; the count is in code points.
      expect(normalizeCreate({ ...ok, reasonNote: '𝟘'.repeat(500) }).reasonNote).toHaveLength(1000);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part B — migration 0098 on a database built from the journal trimmed
  // before it, applied inside ONE transaction like the runner.
  // ──────────────────────────────────────────────────────────────────────────
  describe('migration 0098, applied to a pre-migration database', () => {
    const PRE_DB = 'wms_s_notes_premigration';
    let sql: ReturnType<typeof postgres>;
    let folder: string;

    function statements(): string[] {
      return readFileSync(resolve(process.cwd(), 'drizzle/0098_client_invoice_notes.sql'), 'utf8')
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
      folder = mkdtempSync(join(tmpdir(), 'wms-pre-0098-'));
      cpSync(resolve(process.cwd(), 'drizzle'), folder, { recursive: true });
      rmSync(join(folder, '0098_client_invoice_notes.sql'));
      const journalPath = join(folder, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 97);
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

    it('applies in one transaction: four tables, ten policies, five triggers, the probes (which roll back) and no stray row', async () => {
      const before = await sql<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_name = 'client_invoice_notes'`;
      expect(before[0]!.n).toBe(0);
      await sql.begin(async (tx) => {
        for (const statement of statements()) await tx.unsafe(statement);
      });
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'public' and table_name like 'client_invoice_note%' order by table_name`;
      expect(tables.map((row) => row.table_name)).toEqual(['client_invoice_note_lines', 'client_invoice_note_policies', 'client_invoice_note_series', 'client_invoice_notes']);
      const policies = await sql<{ tablename: string; cmd: string }[]>`
        select tablename, cmd from pg_policies where tablename like 'client_invoice_note%' order by tablename, cmd`;
      expect(policies.map((row) => `${row.tablename}:${row.cmd}`)).toEqual([
        'client_invoice_note_lines:DELETE',
        'client_invoice_note_lines:INSERT',
        'client_invoice_note_lines:SELECT',
        'client_invoice_note_lines:UPDATE',
        'client_invoice_note_policies:ALL',
        'client_invoice_note_series:ALL',
        'client_invoice_notes:DELETE',
        'client_invoice_notes:INSERT',
        'client_invoice_notes:SELECT',
        'client_invoice_notes:UPDATE',
      ]);
      const triggers = await sql<{ tgname: string; tgenabled: string }[]>`
        select tgname, tgenabled from pg_trigger where not tgisinternal
          and tgname in ('client_invoice_notes_frozen', 'client_invoice_note_lines_frozen', 'client_invoice_notes_no_truncate',
            'client_invoice_note_lines_no_truncate', 'client_invoices_void_needs_no_notes')
        order by tgname`;
      expect(triggers).toEqual([
        { tgname: 'client_invoice_note_lines_frozen', tgenabled: 'O' },
        { tgname: 'client_invoice_note_lines_no_truncate', tgenabled: 'O' },
        { tgname: 'client_invoice_notes_frozen', tgenabled: 'O' },
        { tgname: 'client_invoice_notes_no_truncate', tgenabled: 'O' },
        { tgname: 'client_invoices_void_needs_no_notes', tgenabled: 'O' },
      ]);
      // 0062's guard keeps its bytes (A4: a separate trigger).
      const guard = await sql<{ prosrc: string }[]>`select prosrc from pg_proc where proname = 'client_invoices_guard'`;
      const text0062 = readFileSync(resolve(process.cwd(), 'drizzle/0062_client_invoices.sql'), 'utf8');
      expect(text0062).toContain(guard[0]!.prosrc.trim());
      for (const table of ['client_invoices', 'client_invoice_lines', 'client_invoice_notes', 'client_invoice_note_lines', 'client_invoice_note_series', 'client_invoice_note_policies']) {
        expect((await sql.unsafe(`select count(*)::int as n from ${table}`))[0]!.n).toBe(0);
      }
      // The functions that sum after the lock are VOLATILE (A20).
      const volatility = await sql<{ proname: string; provolatile: string }[]>`
        select proname, provolatile from pg_proc where proname in ('client_invoice_notes_guard', 'client_invoice_note_lines_guard', 'client_invoices_void_guard') order by proname`;
      expect(volatility.map((row) => row.provolatile)).toEqual(['v', 'v', 'v']);
    });

    it('the fail-fast guard refuses a second application', async () => {
      await expect(sql.unsafe(statements()[0]!)).rejects.toThrow(/migration 0098: client_invoice_notes already exists/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Part C — over HTTP.
  // ──────────────────────────────────────────────────────────────────────────
  describe('over HTTP', () => {
    let app: INestApplication;
    let sql: postgres.Sql;
    let suiteDb: SuiteDatabase;
    const realNow = clientInvoiceClock.now;

    let tenantId: string;
    let ownerToken: string;
    let ownerId: string;
    let makerToken: string;
    let makerId: string;
    let checkerToken: string;
    let checkerId: string;
    let opsToken: string;
    let acme: string;
    let beta: string;
    let portalAcme: string;
    let portalBeta: string;
    let gstinSeq = 0;
    let invoiceSeq = 0;

    const http = () => request(app.getHttpServer());
    /** A fresh supplying GSTIN per scenario, so every series starts at 000001 and the numbers are literals. */
    const freshGstin = (): string => `29AAACT${String(++gstinSeq).padStart(4, '0')}A1Z5`;

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

    function party(gstin: string, recipientGstin: string | null = '29AAACA1111A1Z1') {
      return {
        supplier: {
          name: 'Three PL Co',
          gstin,
          stateCode: '29',
          stateName: 'Karnataka',
          address: { line1: '12 Peenya Industrial Area', line2: null, city: 'Bengaluru', state: 'Karnataka', pincode: '560058' },
          warehouseCode: 'BLR1',
        },
        recipient: {
          name: 'Acme',
          code: 'ACME',
          legalName: 'Acme Foods Private Limited',
          gstin: recipientGstin,
          stateCode: '29',
          stateName: 'Karnataka',
          address: { line1: '1 MG Road', line2: null, city: 'Bengaluru', stateCode: '29', pincode: '560001' },
        },
      };
    }

    const CHARGES = [
      ['pick', 'per_pick', null],
      ['inbound_handling', 'per_receipt_line', null],
      ['outbound_handling', 'per_order', null],
      ['storage', 'per_thousand_units_per_day', 'each'],
    ] as const;

    interface Seeded {
      id: string;
      lineIds: string[];
      gstin: string;
      payable: number;
    }

    /**
     * An issued (then optionally disputed / settled / void) client invoice by
     * direct SQL through the 0062 trigger path: a draft with its lines, then
     * the issue update. Every line at 18 % on the given supply type.
     */
    async function seedInvoice(opts: {
      amounts: number[];
      status?: 'issued' | 'disputed' | 'settled' | 'void' | 'draft';
      clientId?: string;
      gstin?: string;
      supply?: gst.SupplyType;
      periodStart?: string;
      issuedAt?: string;
      recipientGstin?: string | null;
    }): Promise<Seeded> {
      const gstin = opts.gstin ?? freshGstin();
      const supply = opts.supply ?? 'intra';
      const periodStart = opts.periodStart ?? '2026-09-01';
      const [y, m] = periodStart.split('-').map(Number) as [number, number];
      const periodEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const segFrom = new Date(Date.parse(`${periodStart}T00:00:00Z`) - 19_800_000).toISOString();
      const segTo = new Date(Date.parse(`${periodEnd}T00:00:00Z`) + 86_400_000 - 19_800_000).toISOString();
      const issuedAt = opts.issuedAt ?? new Date(ist('2026-10-05T10:00')).toISOString();
      const lines = opts.amounts.map((amount) => ({ id: uuidv7(), amount, tax: gst.computeLineTax(1000, gst.asPaise(amount), gst.asGstBps(1800), supply) }));
      const sum = (pick: (l: (typeof lines)[number]) => number) => lines.reduce((acc, l) => acc + pick(l), 0);
      const subtotal = sum((l) => l.amount);
      const cgst = sum((l) => l.tax.cgstPaise);
      const sgst = sum((l) => l.tax.sgstPaise);
      const igst = sum((l) => l.tax.igstPaise);
      const total = subtotal + cgst + sgst + igst;
      const rounded = gst.roundToRupee(gst.asPaise(total));
      const id = uuidv7();
      const clientId = opts.clientId ?? acme;
      await sql`insert into client_invoices (id, tenant_id, client_id, period_start, period_end, status, supplier_gstin,
          place_of_supply, supply_type, subtotal_paise, cgst_paise, sgst_paise, igst_paise, tax_paise, total_paise,
          round_off_paise, payable_paise, gaps, warnings, party, content_hash, created_by)
        values (${id}, ${tenantId}, ${clientId}, ${periodStart}, ${periodEnd}, 'draft', ${gstin}, ${supply === 'intra' ? '29' : '27'}, ${supply},
          ${subtotal}, ${cgst}, ${sgst}, ${igst}, ${cgst + sgst + igst}, ${total}, ${rounded.roundOff}, ${rounded.payable},
          '[]'::jsonb, '[]'::jsonb, ${sql.json(party(gstin, opts.recipientGstin === undefined ? '29AAACA1111A1Z1' : opts.recipientGstin))}, 'seed', ${ownerId})`;
      for (const [index, l] of lines.entries()) {
        const [charge, basis, uom] = CHARGES[index]!;
        await sql`insert into client_invoice_lines (id, tenant_id, invoice_id, rate_card_id, segment_from, segment_to, charge_code, basis,
            uom, quantity, unit_amount_paise, amount_paise, sac_code, gst_bps, place_of_supply, supply_type, cgst_paise, sgst_paise, igst_paise)
          values (${l.id}, ${tenantId}, ${id}, ${uuidv7()}, ${segFrom}, ${segTo}, ${charge}, ${basis}, ${uom}, 1000, ${l.amount}, ${l.amount},
            ${charge === 'storage' ? '996729' : '996719'}, 1800, ${supply === 'intra' ? '29' : '27'}, ${supply}, ${l.tax.cgstPaise}, ${l.tax.sgstPaise}, ${l.tax.igstPaise})`;
      }
      if (opts.status !== 'draft') {
        invoiceSeq += 1;
        await sql`update client_invoices set status = 'issued', invoice_no = ${gst.formatServiceInvoiceNo(gstin, gst.fyLabelFor(issuedAt), invoiceSeq)},
            fy_label = ${gst.fyLabelFor(issuedAt)}, series_seq = ${invoiceSeq}, issued_at = ${issuedAt}, issued_by = ${ownerId}
          where id = ${id}`;
        if (opts.status === 'disputed' || opts.status === 'settled' || opts.status === 'void') {
          await sql`update client_invoices set status = ${opts.status}, status_note = 'seeded', status_changed_at = now(), status_changed_by = ${ownerId} where id = ${id}`;
        }
      }
      return { id, lineIds: lines.map((l) => l.id), gstin, payable: rounded.payable };
    }

    type LineBody = { invoiceLineId: string; amountPaise: number; overrideReason?: string };
    function createNote(invoiceId: string, body: { kind: string; reason?: string; reasonNote?: string; settlesDispute?: boolean; lines: LineBody[] }, token = makerToken, key = ulid()) {
      return http()
        .post(`${API}/${tenantId}/client-invoices/${invoiceId}/notes`)
        .set('Authorization', `Bearer ${token}`)
        .set(KEY_HEADER, key)
        .send({ reason: body.kind === 'debit' ? 'short-billed' : 'excess-billed', reasonNote: 'Rate keyed wrongly', ...body });
    }
    const credit = (invoiceId: string, lineId: string, amountPaise: number, extra: Record<string, unknown> = {}) =>
      createNote(invoiceId, { kind: 'credit', lines: [{ invoiceLineId: lineId, amountPaise }], ...extra });
    function issueNote(noteId: string, token = checkerToken, key = ulid()) {
      return http().post(`${API}/${tenantId}/client-invoice-notes/${noteId}/issue`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({});
    }
    function voidNote(noteId: string, voidNote = 'Raised against the wrong line', token = makerToken, key = ulid()) {
      return http().post(`${API}/${tenantId}/client-invoice-notes/${noteId}/void`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send({ voidNote });
    }
    function discardNote(noteId: string, token = makerToken, key = ulid()) {
      return http().delete(`${API}/${tenantId}/client-invoice-notes/${noteId}`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key);
    }
    const getNote = (noteId: string, token = opsToken) => http().get(`${API}/${tenantId}/client-invoice-notes/${noteId}`).set('Authorization', `Bearer ${token}`);
    const notesOf = (invoiceId: string, token = opsToken) => http().get(`${API}/${tenantId}/client-invoices/${invoiceId}/notes`).set('Authorization', `Bearer ${token}`);
    function transition(invoiceId: string, verb: 'dispute' | 'settle' | 'void', note: string | null = 'because', key = ulid()) {
      return http()
        .post(`${API}/${tenantId}/client-invoices/${invoiceId}/${verb}`)
        .set('Authorization', `Bearer ${makerToken}`)
        .set(KEY_HEADER, key)
        .send(note === null ? {} : { note });
    }
    function expectProblem(res: request.Response, status: number, code: string): void {
      expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
    }
    /** Draft a credit by the maker and issue it by the checker. */
    async function issuedCredit(invoiceId: string, lineId: string, amountPaise: number): Promise<{ id: string; noteNo: string }> {
      const drafted = await credit(invoiceId, lineId, amountPaise).expect(201);
      const issued = await issueNote(drafted.body.note.id as string).expect(200);
      return { id: issued.body.note.id as string, noteNo: issued.body.note.noteNo as string };
    }

    beforeAll(async () => {
      suiteDb = await useSuiteDatabase('clientinvoicenotes');
      app = await createApp(false);
      await app.init();
      sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
      clientInvoiceClock.now = () => ist('2026-10-10T10:00');

      const email = `owner-${ulid().toLowerCase()}@example.com`;
      const registered = await http()
        .post(API)
        .set(KEY_HEADER, ulid())
        .send({ name: `Notes Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery', gstin: '29AAACT1234A1Z5' })
        .expect(201);
      tenantId = registered.body.tenant.id as string;
      ownerId = registered.body.owner.id as string;
      ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
      ({ token: makerToken, userId: makerId } = await invite('accountant'));
      ({ token: checkerToken, userId: checkerId } = await invite('accountant'));
      ({ token: opsToken } = await invite('ops_manager'));
      for (const [code, set] of [
        ['ACME', (id: string) => (acme = id)],
        ['BETA', (id: string) => (beta = id)],
      ] as const) {
        const created = await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code, name: `${code} Brand` }).expect(201);
        set(created.body.client.id as string);
      }
      portalAcme = (await invite('client', acme)).token;
      portalBeta = (await invite('client', beta)).token;
    }, 240_000);

    afterAll(async () => {
      clientInvoiceClock.now = realNow;
      await sql?.end();
      const rawDb = app?.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
      await rawDb?.$client?.end();
      const authDb = app?.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } } | undefined;
      await authDb?.$client?.end();
      await app?.close();
      await suiteDb?.drop();
    });

    afterEach(() => {
      clientInvoiceClock.now = () => ist('2026-10-10T10:00');
    });

    it('the vocabularies are pinned against the 0098 CHECKs', async () => {
      const defs = await sql<{ conname: string; def: string }[]>`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('client_invoice_notes_kind', 'client_invoice_notes_status', 'client_invoice_notes_reason', 'client_invoice_note_lines_charge_basis')`;
      const byName = new Map(defs.map((row) => [row.conname, row.def]));
      for (const kind of NOTE_KINDS) expect(byName.get('client_invoice_notes_kind')).toContain(`'${kind}'`);
      for (const status of NOTE_STATUSES) expect(byName.get('client_invoice_notes_status')).toContain(`'${status}'`);
      for (const reason of [...NOTE_REASONS_BY_KIND.credit, ...NOTE_REASONS_BY_KIND.debit]) expect(byName.get('client_invoice_notes_reason')).toContain(`'${reason}'`);
      for (const code of CHARGE_CODES) expect(byName.get('client_invoice_note_lines_charge_basis')).toContain(`'${code}'`);
      expect((byName.get('client_invoice_notes_kind')!.match(/'/g) ?? []).length / 2).toBe(NOTE_KINDS.length);
      expect((byName.get('client_invoice_notes_status')!.match(/'/g) ?? []).length / 2).toBe(NOTE_STATUSES.length);
    });

    it('credit draft and issue (matrix rows 1–2): 201 draft 1800/1800; the checker issues 29/C2627/000001, frozen; net payable −₹236; audited, an outbox event; replays re-serve', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      expect(invoice.payable).toBe(118_000);
      const key = ulid();
      const drafted = await credit(invoice.id, invoice.lineIds[0]!, 20_000, { reason: 'excess-billed' }).set(KEY_HEADER, key).expect(201);
      const note = drafted.body.note;
      expect(note).toMatchObject({
        kind: 'credit',
        status: 'draft',
        reason: 'excess-billed',
        noteNo: null,
        supplierGstin: invoice.gstin,
        placeOfSupply: '29',
        supplyType: 'intra',
        totals: { subtotal: 20_000, cgst: 1800, sgst: 1800, igst: 0, tax: 3600, roundOff: 0, payable: 23_600 },
        creditDeadline: '2027-11-30',
        invoiceNo: expect.stringMatching(/\/S2627\//),
      });
      expect(note.lines).toEqual([
        expect.objectContaining({ invoiceLineId: invoice.lineIds[0], chargeCode: 'pick', basis: 'per_pick', sac: '996719', gstBps: 1800, amountPaise: 20_000, cgstPaise: 1800, sgstPaise: 1800, igstPaise: 0, segmentFrom: '2026-09-01', segmentTo: '2026-09-30', overrideReason: null }),
      ]);
      // The party is the invoice's, verbatim.
      expect(note.party).toEqual(party(invoice.gstin));
      await expectAuditRow({ tenantId, key, action: 'client_invoice_note.drafted', targetType: 'client_invoice_note', targetId: note.id, actorUserId: makerId });
      const replay = await credit(invoice.id, invoice.lineIds[0]!, 20_000, { reason: 'excess-billed' }).set(KEY_HEADER, key).expect(201);
      expect(replay.body).toEqual(drafted.body);
      await expectAuditRow({ tenantId, key, action: 'client_invoice_note.drafted', targetType: 'client_invoice_note', targetId: note.id, actorUserId: makerId });
      const changes = await sql<{ changes: unknown }[]>`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`;
      expect(changes[0]!.changes).toEqual({ kind: 'credit', reason: 'excess-billed', settlesDispute: false, lines: [{ invoiceLineId: invoice.lineIds[0], amountPaise: 20_000 }] });

      const issueKey = ulid();
      const issued = await issueNote(note.id as string, checkerToken, issueKey).expect(200);
      expect(issued.body.note).toMatchObject({ status: 'issued', noteNo: `29/C2627/000001`, fyLabel: 'FY-2627', issuedBy: checkerId });
      expect(issued.body.invoice).toBeUndefined();
      expect((await issueNote(note.id as string, checkerToken, issueKey).expect(200)).body).toEqual(issued.body);
      await expectAuditRow({ tenantId, key: issueKey, action: 'client_invoice_note.issued', targetType: 'client_invoice_note', targetId: note.id, actorUserId: checkerId });
      const issuedChanges = await sql<{ changes: unknown }[]>`select changes from audit_events where tenant_id = ${tenantId} and reference = ${issueKey}`;
      expect(issuedChanges[0]!.changes).toEqual({ noteNo: '29/C2627/000001', fyLabel: 'FY-2627', payablePaise: 23_600 });
      const events = await sql<{ type: string; payload: unknown }[]>`select type, payload from outbox_messages where tenant_id = ${tenantId} and payload ->> 'noteId' = ${note.id as string}`;
      expect(events).toEqual([{ type: 'client_invoice_note.issued', payload: { noteId: note.id, invoiceId: invoice.id, clientId: acme, kind: 'credit', noteNo: '29/C2627/000001' } }]);

      const list = await notesOf(invoice.id).expect(200);
      expect(list.body.netDocument).toEqual({ subtotal: 80_000, cgst: 7200, sgst: 7200, igst: 0, tax: 14_400, roundOff: 0, payable: 94_400 });
      expect(list.body.netDocumentPayable).toBe(94_400);
      expect(list.body.notes.map((n: { noteNo: string }) => n.noteNo)).toEqual(['29/C2627/000001']);

      // Frozen: a direct-SQL edit of the issued note or its line is refused.
      await expect(sql`update client_invoice_notes set reason_note = 'edited' where id = ${note.id as string}`).rejects.toMatchObject({ code: 'P0001' });
      await expect(sql`update client_invoice_note_lines set amount_paise = 1 where note_id = ${note.id as string}`).rejects.toMatchObject({ code: 'P0001' });
      await expect(sql`delete from client_invoice_notes where id = ${note.id as string}`).rejects.toMatchObject({ code: 'P0001' });
      await expect(sql`truncate client_invoice_notes`).rejects.toMatchObject({ code: 'P0001' });
    });

    it('over the cap: issued credits of ₹900 on a ₹1,000 line, a new ₹200 credit → 409 credit-exceeds-invoice naming remainingPaise 10000', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      await issuedCredit(invoice.id, invoice.lineIds[0]!, 90_000);
      const refused = await credit(invoice.id, invoice.lineIds[0]!, 20_000);
      expectProblem(refused, 409, 'credit-exceeds-invoice');
      expect(refused.body.lines).toEqual([{ invoiceLineId: invoice.lineIds[0], remainingPaise: 10_000, remainingCgstPaise: 900, remainingSgstPaise: 900, remainingIgstPaise: 0 }]);
    });

    it('exhaust: ₹1,000 credited 333.33 + 333.33, then 333.34 takes exactly the remaining heads — Σ heads = the line’s; payables 39333, 39333, 39334', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const a = await issuedCredit(invoice.id, invoice.lineIds[0]!, 33_333);
      const b = await issuedCredit(invoice.id, invoice.lineIds[0]!, 33_333);
      const c = await issuedCredit(invoice.id, invoice.lineIds[0]!, 33_334);
      const bodies = await Promise.all([a, b, c].map(async (n) => (await getNote(n.id).expect(200)).body.note));
      expect(bodies.map((n) => [n.totals.cgst, n.totals.sgst, n.totals.payable, n.totals.roundOff])).toEqual([
        [3000, 3000, 39_333, 0],
        [3000, 3000, 39_333, 0],
        [3000, 3000, 39_334, 0],
      ]);
      const sums = await sql<{ a: string; c: string; s: string }[]>`
        select sum(l.amount_paise)::text as a, sum(l.cgst_paise)::text as c, sum(l.sgst_paise)::text as s
        from client_invoice_note_lines l join client_invoice_notes n on n.id = l.note_id where n.invoice_id = ${invoice.id} and n.status = 'issued'`;
      expect(sums[0]).toEqual({ a: '100000', c: '9000', s: '9000' });
      // Nothing is left: a ₹0.01 more is refused.
      expectProblem(await credit(invoice.id, invoice.lineIds[0]!, 1), 409, 'credit-exceeds-invoice');
      expect((await notesOf(invoice.id).expect(200)).body.netDocument).toEqual({ subtotal: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, roundOff: 0, payable: 0 });
    });

    it('the ₹1.50 invoice: three ₹0.50 credits pay 59, 59 and 82 (round-off +23) — Σ 200, the invoice payable', async () => {
      const invoice = await seedInvoice({ amounts: [150] });
      expect(invoice.payable).toBe(200);
      const ids = [];
      for (let i = 0; i < 3; i += 1) ids.push((await issuedCredit(invoice.id, invoice.lineIds[0]!, 50)).id);
      const bodies = await Promise.all(ids.map(async (id) => (await getNote(id).expect(200)).body.note.totals));
      expect(bodies).toEqual([
        { subtotal: 50, cgst: 4, sgst: 5, igst: 0, tax: 9, roundOff: 0, payable: 59 },
        { subtotal: 50, cgst: 4, sgst: 5, igst: 0, tax: 9, roundOff: 0, payable: 59 },
        { subtotal: 50, cgst: 5, sgst: 4, igst: 0, tax: 9, roundOff: 23, payable: 82 },
      ]);
    });

    it('head overflow over HTTP: a line of 9 (CGST 1, SGST 1), a credit of 3 issued (SGST 1), then a non-exhausting 3 → 409 credit-exceeds-invoice, remainingSgstPaise 0', async () => {
      const invoice = await seedInvoice({ amounts: [9] });
      await issuedCredit(invoice.id, invoice.lineIds[0]!, 3);
      const refused = await credit(invoice.id, invoice.lineIds[0]!, 3);
      expectProblem(refused, 409, 'credit-exceeds-invoice');
      expect(refused.body.lines[0]).toMatchObject({ remainingPaise: 6, remainingCgstPaise: 1, remainingSgstPaise: 0 });
    });

    it('figures changed: two drafts on one line; A issues; B (which exhausted under the old state) now differs → 409 note-figures-changed', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      // B is drafted when it would exhaust the line exactly (heads = the whole line's).
      const b = await credit(invoice.id, invoice.lineIds[0]!, 100_000).expect(201);
      // A is drafted too and issued first: B now asks for more than remains → a cap refusal at its issue.
      const a = await credit(invoice.id, invoice.lineIds[0]!, 1).expect(201);
      await issueNote(a.body.note.id as string).expect(200);
      expectProblem(await issueNote(b.body.note.id as string), 409, 'credit-exceeds-invoice');
      // The figures-changed arm: C drafted as a non-exhausting 33334 of a 100000 line (heads 3000/3000 computed), then
      // credits of 33333 + 33333 issue — C now EXHAUSTS the line and its heads would be the remainders (3000/3000 here, but its
      // payable becomes the invoice's remaining payable) — any moved figure refuses.
      const second = await seedInvoice({ amounts: [150] });
      const late = await credit(second.id, second.lineIds[0]!, 50).expect(201); // drafted non-exhausting: 4 / 5, payable 59
      await issuedCredit(second.id, second.lineIds[0]!, 50);
      await issuedCredit(second.id, second.lineIds[0]!, 50);
      // Two credits of 50 issued (4 / 5 each): `late` now EXHAUSTS the line, so its heads must be the remainders
      // (13 − 8 = 5, 14 − 10 = 4) — not the 4 / 5 it was drafted with (the matrix row "B's exhaust heads now differ").
      expectProblem(await issueNote(late.body.note.id as string), 409, 'note-figures-changed');
      const third = await seedInvoice({ amounts: [150] });
      const lateExhaust = await credit(third.id, third.lineIds[0]!, 50).expect(201); // 4 / 5, payable 59
      await issuedCredit(third.id, third.lineIds[0]!, 100); // computed 18 → 9/9, payable 118
      // `lateExhaust` now EXHAUSTS the line: its heads must be the remainders (13−9=4, 14−9=5) and its payable the
      // remaining payable 200−118 = 82 ≠ 59 → figures changed.
      expectProblem(await issueNote(lateExhaust.body.note.id as string), 409, 'note-figures-changed');
    });

    it('the two-key race: a raw holder locks the invoice; issue A then issue B parked behind it; release → A 200, B exactly 409 credit-exceeds-invoice', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const a = (await credit(invoice.id, invoice.lineIds[0]!, 60_000).expect(201)).body.note.id as string;
      const b = (await credit(invoice.id, invoice.lineIds[0]!, 60_000).expect(201)).body.note.id as string;
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from client_invoices where id = ${invoice.id} for update`) as unknown as { pid: number }[];
          first = (async () => issueNote(a))();
          await waitParked('client_invoices', locked[0]!.pid, 1);
          second = (async () => issueNote(b))();
          await waitParked('client_invoices', locked[0]!.pid, 2);
        });
        const [ra, rb] = await Promise.all([first!, second!]);
        expect(ra.status).toBe(200);
        expectProblem(rb, 409, 'credit-exceeds-invoice');
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
    });

    it('the same-key race: two issues with one key parked on the invoice lock → identical 200 bodies, one number used', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const note = (await credit(invoice.id, invoice.lineIds[0]!, 10_000).expect(201)).body.note.id as string;
      const key = ulid();
      const [x, y] = await raceTwice(invoice.id, () => issueNote(note, checkerToken, key));
      expect([x.status, y.status]).toEqual([200, 200]);
      expect(x.body).toEqual(y.body);
      expect(x.body.note.noteNo).toBe('29/C2627/000001');
      const series = await sql<{ last_seq: number }[]>`select last_seq from client_invoice_note_series where tenant_id = ${tenantId} and supplier_gstin = ${invoice.gstin}`;
      expect(series).toEqual([{ last_seq: 1 }]);
      const keys = await sql<{ n: number }[]>`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`;
      expect(keys[0]!.n).toBe(1);
    });

    it('the time bar: an FY-2627 invoice issues a credit at 30 Nov 2027 23:59:59.999 IST, and refuses at 1 Dec 00:00 IST (409 credit-note-time-barred, naming 30 Nov 2027); a debit after the bar issues 29/D2728/000001', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const early = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      const late = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      clientInvoiceClock.now = () => ist('2027-11-30T23:59:59.999');
      const ok = await issueNote(early).expect(200);
      expect(ok.body.note.noteNo).toBe('29/C2728/000001');
      clientInvoiceClock.now = () => ist('2027-12-01T00:00');
      const barred = await issueNote(late);
      expectProblem(barred, 409, 'credit-note-time-barred');
      expect(barred.body.detail).toContain('last day 30 Nov 2027');
      expectProblem(await credit(invoice.id, invoice.lineIds[0]!, 1000), 409, 'credit-note-time-barred');
      const debit = await createNote(invoice.id, { kind: 'debit', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 1000 }] }).expect(201);
      expect(debit.body.note.creditDeadline).toBeNull();
      // A debit has no maker/checker either: its creator issues it.
      const issued = await issueNote(debit.body.note.id as string, makerToken).expect(200);
      expect(issued.body.note.noteNo).toBe('29/D2728/000001');
    });

    it('a committed credit replays after the bar (the time rule sits behind the replay lookup)', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const key = ulid();
      const drafted = await credit(invoice.id, invoice.lineIds[0]!, 500).set(KEY_HEADER, key).expect(201);
      clientInvoiceClock.now = () => ist('2027-12-02T10:00');
      expect((await credit(invoice.id, invoice.lineIds[0]!, 500).set(KEY_HEADER, key).expect(201)).body).toEqual(drafted.body);
    });

    it('the supply FY: a March 2027 period invoiced on 5 April 2027 (FY-2728) is a FY-2627 supply — the deadline is 30 Nov 2027', async () => {
      const invoice = await seedInvoice({ amounts: [100_000], periodStart: '2027-03-01', issuedAt: new Date(ist('2027-04-05T10:00')).toISOString() });
      clientInvoiceClock.now = () => ist('2027-11-30T23:59');
      const drafted = await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201);
      expect(drafted.body.note.creditDeadline).toBe('2027-11-30');
      const pending = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      clientInvoiceClock.now = () => ist('2027-12-01T00:00');
      expectProblem(await issueNote(pending), 409, 'credit-note-time-barred');
    });

    it('the note FY: a credit issued at 2027-03-31T20:00Z (01:30 IST on 1 April) numbers 29/C2728/000001', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const note = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      clientInvoiceClock.now = () => Date.parse('2027-03-31T20:00:00.000Z');
      expect((await issueNote(note).expect(200)).body.note).toMatchObject({ noteNo: '29/C2728/000001', fyLabel: 'FY-2728' });
    });

    it('eligibility: a draft or void invoice is 409 invoice-not-noteable; a debit on a disputed (or settled) invoice 409 invoice-not-debitable; a credit on a settled one drafts', async () => {
      const draft = await seedInvoice({ amounts: [1000], status: 'draft' });
      expectProblem(await credit(draft.id, draft.lineIds[0]!, 100), 409, 'invoice-not-noteable');
      const voided = await seedInvoice({ amounts: [1000], status: 'void' });
      expectProblem(await credit(voided.id, voided.lineIds[0]!, 100), 409, 'invoice-not-noteable');
      const disputed = await seedInvoice({ amounts: [100_000], status: 'disputed' });
      expectProblem(await createNote(disputed.id, { kind: 'debit', lines: [{ invoiceLineId: disputed.lineIds[0]!, amountPaise: 100 }] }), 409, 'invoice-not-debitable');
      const settled = await seedInvoice({ amounts: [100_000], status: 'settled' });
      expectProblem(await createNote(settled.id, { kind: 'debit', lines: [{ invoiceLineId: settled.lineIds[0]!, amountPaise: 100 }] }), 409, 'invoice-not-debitable');
      await credit(settled.id, settled.lineIds[0]!, 100).expect(201);
      await credit(disputed.id, disputed.lineIds[0]!, 100).expect(201);
      // The trigger is the backstop: a direct-SQL debit draft on the disputed invoice is refused.
      await expect(
        sql`insert into client_invoice_notes (id, tenant_id, client_id, invoice_id, kind, supplier_gstin, place_of_supply, supply_type, reason, reason_note,
            subtotal_paise, cgst_paise, sgst_paise, igst_paise, tax_paise, total_paise, round_off_paise, payable_paise, party, created_by)
          select ${uuidv7()}, tenant_id, client_id, id, 'debit', supplier_gstin, place_of_supply, supply_type, 'short-billed', 'x', 1, 0, 0, 0, 0, 1, 0, 1, party, ${makerId}
          from client_invoices where id = ${disputed.id}`,
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('a foreign line is 404; an unknown invoice 404; the bad shapes are 400 above the transaction', async () => {
      const invoice = await seedInvoice({ amounts: [1000] });
      const other = await seedInvoice({ amounts: [1000] });
      expectProblem(await credit(invoice.id, other.lineIds[0]!, 100), 404, 'not-found');
      expectProblem(await credit(uuidv7(), invoice.lineIds[0]!, 100), 404, 'not-found');
      for (const body of [
        { kind: 'debit', reason: 'excess-billed', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 1 }] },
        { kind: 'debit', reason: 'short-billed', settlesDispute: true, lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 1 }] },
        { kind: 'credit', reason: 'dispute-settlement', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 1 }] },
        { kind: 'credit', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 1 }, { invoiceLineId: invoice.lineIds[0]!, amountPaise: 2 }] },
        { kind: 'credit', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 0 }] },
        { kind: 'credit', reasonNote: '   ', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 1 }] },
      ]) {
        expectProblem(await createNote(invoice.id, body), 400, 'validation-failed');
      }
      // C1: an upper-case line id is the same line (uuids compare lower-case) — and a case variant is a duplicate.
      await credit(invoice.id, invoice.lineIds[0]!.toUpperCase(), 100).expect(201);
      expectProblem(
        await createNote(invoice.id, { kind: 'credit', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 1 }, { invoiceLineId: invoice.lineIds[0]!.toUpperCase(), amountPaise: 2 }] }),
        400,
        'validation-failed',
      );
      // C2: a debit whose tax leaves the exact paise range is a 400, never a 500.
      expectProblem(
        await createNote(invoice.id, { kind: 'debit', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: Number.MAX_SAFE_INTEGER, overrideReason: 'huge' }] }),
        400,
        'validation-failed',
      );
      // 400 beats a used key's replay (shape is above the transaction).
      expectProblem(await http().post(`${API}/${tenantId}/client-invoices/not-a-uuid/notes`).set('Authorization', `Bearer ${makerToken}`).set(KEY_HEADER, ulid()).send({}), 400, 'validation-failed');
    });

    it('authority: the ops manager is 403 role-denied on every mutation; a portal session is 403 on the operator reads', async () => {
      const invoice = await seedInvoice({ amounts: [1000] });
      expectProblem(await credit(invoice.id, invoice.lineIds[0]!, 100).set('Authorization', `Bearer ${opsToken}`), 403, 'role-denied');
      const note = (await credit(invoice.id, invoice.lineIds[0]!, 100).expect(201)).body.note.id as string;
      expectProblem(await issueNote(note, opsToken), 403, 'role-denied');
      expectProblem(await discardNote(note, opsToken), 403, 'role-denied');
      for (const path of [`client-invoices/${invoice.id}/notes`, `client-invoice-notes/${note}`, 'billing/note-policy', `client-invoice-notes?gstin=${invoice.gstin}&from=2026-10-01&to=2026-10-31`]) {
        expect((await http().get(`${API}/${tenantId}/${path}`).set('Authorization', `Bearer ${portalAcme}`)).status).toBe(403);
      }
    });

    it('settle the dispute: a credit with settlesDispute on a disputed invoice issues and settles it in one transaction ("Settled by credit note …"), audited client_invoice.settled; not disputed → 409 invoice-not-disputed', async () => {
      const invoice = await seedInvoice({ amounts: [100_000], status: 'disputed' });
      const drafted = await createNote(invoice.id, { kind: 'credit', reason: 'deficiency-in-service', settlesDispute: true, lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 10_000 }] }).expect(201);
      expect(drafted.body.note.settlesDispute).toBe(true);
      const key = ulid();
      const issued = await issueNote(drafted.body.note.id as string, checkerToken, key).expect(200);
      expect(issued.body.invoice).toMatchObject({ id: invoice.id, status: 'settled', statusNote: `Settled by credit note ${issued.body.note.noteNo}` });
      await expectAuditRow({
        tenantId,
        key,
        action: 'client_invoice_note.issued',
        targetType: 'client_invoice_note',
        targetId: drafted.body.note.id,
        actorUserId: checkerId,
      });
      const rows = await sql<{ action: string; reference: string }[]>`select action, reference from audit_events where tenant_id = ${tenantId} and strpos(reference, ${key}) > 0 order by action`;
      expect(rows).toEqual([
        { action: 'client_invoice.settled', reference: `note: Settled by credit note ${issued.body.note.noteNo} (key ${key})` },
        { action: 'client_invoice_note.issued', reference: key },
      ]);
      // A settling credit is never voided (A5) — by the command, and (C3) by the trigger under direct SQL.
      expectProblem(await voidNote(drafted.body.note.id as string), 409, 'note-settles-dispute');
      await expect(
        sql`update client_invoice_notes set status = 'void', void_note = 'x', voided_at = now(), voided_by = ${makerId} where id = ${drafted.body.note.id as string}`,
      ).rejects.toMatchObject({ code: 'P0001' });
      // The invoice is settled now: another settling credit is 409 invoice-not-disputed (at create, and at issue).
      expectProblem(await createNote(invoice.id, { kind: 'credit', settlesDispute: true, lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 1 }] }), 409, 'invoice-not-disputed');
      const other = await seedInvoice({ amounts: [100_000], status: 'disputed' });
      const pending = await createNote(other.id, { kind: 'credit', settlesDispute: true, lines: [{ invoiceLineId: other.lineIds[0]!, amountPaise: 1 }] }).expect(201);
      await transition(other.id, 'settle', null).expect(200);
      expectProblem(await issueNote(pending.body.note.id as string), 409, 'invoice-not-disputed');
    });

    it('e-invoicing: the GSTIN flag on and a registered recipient → 409 einvoice-required at issue; an unregistered recipient issues', async () => {
      const gstin = freshGstin();
      await sql`insert into eway_gstin_settings (id, tenant_id, gstin, e_invoice_applies, updated_by) values (${uuidv7()}, ${tenantId}, ${gstin}, true, ${ownerId})`;
      const registered = await seedInvoice({ amounts: [100_000], gstin });
      const note = (await credit(registered.id, registered.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      expectProblem(await issueNote(note), 409, 'einvoice-required');
      const unregistered = await seedInvoice({ amounts: [100_000], gstin, recipientGstin: null, periodStart: '2026-08-01' });
      const ok = (await credit(unregistered.id, unregistered.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      await issueNote(ok).expect(200);
    });

    it('void an invoice with an issued note → 409 invoice-has-notes (and the trigger refuses direct SQL); with drafts only → voided, the drafts discarded and audited', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const issued = await issuedCredit(invoice.id, invoice.lineIds[0]!, 1000);
      expectProblem(await transition(invoice.id, 'void', 'wrong client'), 409, 'invoice-has-notes');
      await expect(
        sql`update client_invoices set status = 'void', status_note = 'x', status_changed_at = now(), status_changed_by = ${ownerId} where id = ${invoice.id}`,
      ).rejects.toMatchObject({ code: 'P0001' });
      // A transition the invoice cannot make answers invoice-transition-invalid first (K14).
      const settled = await seedInvoice({ amounts: [100_000], status: 'settled' });
      await issuedCredit(settled.id, settled.lineIds[0]!, 1000);
      expectProblem(await transition(settled.id, 'void', 'x'), 409, 'invoice-transition-invalid');
      // Void the note, then the invoice voids.
      await voidNote(issued.id).expect(200);
      await transition(invoice.id, 'void', 'wrong client').expect(200);

      const withDrafts = await seedInvoice({ amounts: [100_000, 50_000] });
      const d1 = (await credit(withDrafts.id, withDrafts.lineIds[0]!, 100).expect(201)).body.note.id as string;
      const d2 = (await credit(withDrafts.id, withDrafts.lineIds[1]!, 100).expect(201)).body.note.id as string;
      const key = ulid();
      await transition(withDrafts.id, 'void', 'raised twice', key).expect(200);
      const left = await sql<{ n: number }[]>`select count(*)::int as n from client_invoice_notes where invoice_id = ${withDrafts.id}`;
      expect(left[0]!.n).toBe(0);
      const audit = await sql<{ action: string; target_id: string }[]>`
        select action, target_id from audit_events where tenant_id = ${tenantId} and (reference = ${key} or strpos(reference, ${key}) > 0) order by action, target_id`;
      expect(audit).toEqual(
        [
          { action: 'client_invoice.voided', target_id: withDrafts.id },
          ...[d1, d2].sort().map((id) => ({ action: 'client_invoice_note.discarded', target_id: id })),
        ],
      );
      expectProblem(await getNote(d1), 404, 'not-found');
    });

    it('void a note: 200, the number kept, the cap freed; not issued → note-not-issued; a replay re-serves; audited and an outbox event', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const issued = await issuedCredit(invoice.id, invoice.lineIds[0]!, 100_000);
      expectProblem(await credit(invoice.id, invoice.lineIds[0]!, 1), 409, 'credit-exceeds-invoice');
      const key = ulid();
      const voided = await voidNote(issued.id, 'Raised against the wrong line', makerToken, key).expect(200);
      expect(voided.body.note).toMatchObject({ status: 'void', noteNo: issued.noteNo, voidNote: 'Raised against the wrong line', voidedBy: makerId });
      expect((await voidNote(issued.id, 'Raised against the wrong line', makerToken, key).expect(200)).body).toEqual(voided.body);
      await expectAuditRow({ tenantId, key, action: 'client_invoice_note.voided', targetType: 'client_invoice_note', targetId: issued.id, actorUserId: makerId });
      const events = await sql<{ type: string }[]>`select type from outbox_messages where tenant_id = ${tenantId} and payload ->> 'noteId' = ${issued.id} order by type`;
      expect(events.map((e) => e.type)).toEqual(['client_invoice_note.issued', 'client_invoice_note.voided']);
      // The cap is free again.
      await credit(invoice.id, invoice.lineIds[0]!, 100_000).expect(201);
      expectProblem(await voidNote(issued.id), 409, 'note-not-issued');
      const draft = (await credit(invoice.id, invoice.lineIds[0]!, 1).expect(201)).body.note.id as string;
      expectProblem(await voidNote(draft), 409, 'note-not-issued');
      expectProblem(await voidNote(issued.id, '   '), 400, 'validation-failed');
      // A void never moves again (direct SQL).
      await expect(sql`update client_invoice_notes set status = 'issued', void_note = null, voided_at = null, voided_by = null where id = ${issued.id}`).rejects.toMatchObject({ code: 'P0001' });
      await expect(sql`update client_invoice_notes set status = 'draft' where id = ${issued.id}`).rejects.toMatchObject({ code: 'P0001' });
    });

    it('void after the GSTR-1 date: issued 20 May 2027 IST — voided at 11 June 23:59:59.999 IST, refused at 12 June 00:00 IST (409 note-period-closed)', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const a = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      const b = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      clientInvoiceClock.now = () => ist('2027-05-20T10:00');
      await issueNote(a).expect(200);
      await issueNote(b).expect(200);
      clientInvoiceClock.now = () => ist('2027-06-11T23:59:59.999');
      await voidNote(a).expect(200);
      clientInvoiceClock.now = () => ist('2027-06-12T00:00');
      expectProblem(await voidNote(b), 409, 'note-period-closed');
    });

    it('maker = checker: the creator issuing a credit, policy absent → 409 note-needs-second-approver (and the issuer voiding it); the trigger refuses it too', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const note = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      expectProblem(await issueNote(note, makerToken), 409, 'note-needs-second-approver');
      await issueNote(note, checkerToken).expect(200);
      expectProblem(await voidNote(note, 'x', checkerToken), 409, 'note-needs-second-approver');
      // Direct SQL: a credit issued by its creator is refused by the trigger.
      const other = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      await expect(
        sql`update client_invoice_notes set status = 'issued', note_no = '29/C2627/000099', fy_label = 'FY-2627', series_seq = 99, issued_at = now(), issued_by = ${makerId} where id = ${other}`,
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('the series exhausted: a credit series at 999,999 refuses the next issue (409 note-series-exhausted) and spends nothing', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      await sql`insert into client_invoice_note_series (id, tenant_id, supplier_gstin, kind, fy_label, last_seq)
        values (${uuidv7()}, ${tenantId}, ${invoice.gstin}, 'credit', 'FY-2627', 999999)`;
      const note = (await credit(invoice.id, invoice.lineIds[0]!, 100).expect(201)).body.note.id as string;
      expectProblem(await issueNote(note), 409, 'note-series-exhausted');
      const series = await sql<{ last_seq: number }[]>`select last_seq from client_invoice_note_series where tenant_id = ${tenantId} and supplier_gstin = ${invoice.gstin} and kind = 'credit'`;
      expect(series).toEqual([{ last_seq: 999_999 }]);
      // The debit series is its own: a debit still issues 000001.
      const debit = (await createNote(invoice.id, { kind: 'debit', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 100 }] }).expect(201)).body.note.id as string;
      expect((await issueNote(debit).expect(200)).body.note.noteNo).toBe('29/D2627/000001');
    });

    it('a single-person tenant: the owner PUTs requireSecondApprover:false (audited); then a creator issues; a non-owner PUT is 403 role-denied', async () => {
      expect((await http().get(`${API}/${tenantId}/billing/note-policy`).set('Authorization', `Bearer ${opsToken}`).expect(200)).body).toEqual({ requireSecondApprover: true });
      expectProblem(
        await http().put(`${API}/${tenantId}/billing/note-policy`).set('Authorization', `Bearer ${makerToken}`).set(KEY_HEADER, ulid()).send({ requireSecondApprover: false }),
        403,
        'role-denied',
      );
      const key = ulid();
      const put = await http().put(`${API}/${tenantId}/billing/note-policy`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key).send({ requireSecondApprover: false }).expect(200);
      expect(put.body).toEqual({ requireSecondApprover: false });
      const policyId = (await sql<{ id: string }[]>`select id from client_invoice_note_policies where tenant_id = ${tenantId}`)[0]!.id;
      await expectAuditRow({ tenantId, key, action: 'client_invoice_note_policy.updated', targetType: 'client_invoice_note_policy', targetId: policyId, actorUserId: ownerId });
      const changes = await sql<{ changes: unknown }[]>`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`;
      expect(changes[0]!.changes).toEqual({ from: true, to: false });
      try {
        const invoice = await seedInvoice({ amounts: [100_000] });
        const note = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
        await issueNote(note, makerToken).expect(200);
        await voidNote(note, 'own mistake', makerToken).expect(200);
      } finally {
        await http().put(`${API}/${tenantId}/billing/note-policy`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ requireSecondApprover: true }).expect(200);
      }
    });

    it('discard: a draft is deleted (204; a same-key replay 204; a new key 404); an issued note → 409 note-not-draft', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const note = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      const key = ulid();
      await discardNote(note, makerToken, key).expect(204);
      await expectAuditRow({ tenantId, key, action: 'client_invoice_note.discarded', targetType: 'client_invoice_note', targetId: note, actorUserId: makerId });
      await discardNote(note, makerToken, key).expect(204);
      expectProblem(await discardNote(note), 404, 'not-found');
      const issued = await issuedCredit(invoice.id, invoice.lineIds[0]!, 1000);
      expectProblem(await discardNote(issued.id), 409, 'note-not-draft');
      expectProblem(await issueNote(issued.id), 409, 'note-not-draft');
    });

    it('a debit over its line: 120000 on a 100000 line → 409 debit-needs-override; with overrideReason it issues and the audit lists the reason', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      expectProblem(await createNote(invoice.id, { kind: 'debit', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 120_000 }] }), 409, 'debit-needs-override');
      const key = ulid();
      const drafted = await createNote(invoice.id, { kind: 'debit', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 120_000, overrideReason: ' Rate revised after the month ' }] }, makerToken, key).expect(201);
      expect(drafted.body.note.lines[0]).toMatchObject({ amountPaise: 120_000, cgstPaise: 10_800, sgstPaise: 10_800, overrideReason: 'Rate revised after the month' });
      expect(drafted.body.note.totals).toEqual({ subtotal: 120_000, cgst: 10_800, sgst: 10_800, igst: 0, tax: 21_600, roundOff: 0, payable: 141_600 });
      const changes = await sql<{ changes: { lines: unknown[] } }[]>`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`;
      expect(changes[0]!.changes.lines).toEqual([{ invoiceLineId: invoice.lineIds[0], amountPaise: 120_000, overrideReason: 'Rate revised after the month' }]);
      const issued = await issueNote(drafted.body.note.id as string).expect(200);
      expect(issued.body.note.noteNo).toBe('29/D2627/000001');
      // Debits add no credit headroom (B11): the line still caps credits at 100000.
      expectProblem(await credit(invoice.id, invoice.lineIds[0]!, 100_001), 409, 'credit-exceeds-invoice');
      const net = (await notesOf(invoice.id).expect(200)).body;
      expect(net.netDocumentPayable).toBe(118_000 + 141_600);
    });

    it('gap-free series: N issues with interleaved voids and one issue rolled back AFTER allocation (a trigger refusal) → seqs exactly 1..N', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      await sql.unsafe(`
        create function zz_force_note_rollback() returns trigger language plpgsql as $$
        begin
          if new.status = 'issued' and new.reason_note = 'force-rollback' then raise exception 'forced rollback after allocation'; end if;
          return new;
        end $$;
        create trigger zz_force_note_rollback before update on client_invoice_notes for each row execute function zz_force_note_rollback();`);
      try {
        const numbers: string[] = [];
        for (const step of ['issue', 'issue', 'void', 'rollback', 'issue', 'void', 'issue'] as const) {
          if (step === 'void') {
            await voidNote((await sql<{ id: string }[]>`select id from client_invoice_notes where invoice_id = ${invoice.id} and status = 'issued' order by series_seq desc limit 1`)[0]!.id).expect(200);
            continue;
          }
          const note = await createNote(invoice.id, { kind: 'credit', reasonNote: step === 'rollback' ? 'force-rollback' : 'Rate keyed wrongly', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 100 }] }).expect(201);
          const res = await issueNote(note.body.note.id as string);
          if (step === 'rollback') {
            expect(res.status).toBe(500);
            continue;
          }
          expect(res.status).toBe(200);
          numbers.push(res.body.note.noteNo as string);
        }
        expect(numbers).toEqual(['29/C2627/000001', '29/C2627/000002', '29/C2627/000003', '29/C2627/000004']);
        const series = await sql<{ last_seq: number }[]>`select last_seq from client_invoice_note_series where tenant_id = ${tenantId} and supplier_gstin = ${invoice.gstin} and kind = 'credit'`;
        expect(series).toEqual([{ last_seq: 4 }]);
        const seqs = await sql<{ series_seq: number }[]>`select series_seq from client_invoice_notes where invoice_id = ${invoice.id} and series_seq is not null order by series_seq`;
        expect(seqs.map((row) => row.series_seq)).toEqual([1, 2, 3, 4]);
        // Independent of the invoice series: the services invoice series did not move.
        const invoiceSeries = await sql<{ n: number }[]>`select count(*)::int as n from client_invoice_series where tenant_id = ${tenantId} and supplier_gstin = ${invoice.gstin}`;
        expect(invoiceSeries[0]!.n).toBe(0);
      } finally {
        await sql.unsafe('drop trigger zz_force_note_rollback on client_invoice_notes; drop function zz_force_note_rollback();');
      }
    });

    it('the deadlock case (A20): a direct-SQL note update that locks the note before the invoice, against a command issue → one side aborts 40P01 (accepted)', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const note = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      const writer = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let issued: Promise<request.Response> | undefined;
      let writerError: unknown = null;
      try {
        await writer
          .begin(async (tx) => {
            const locked = (await tx`select pg_backend_pid() as pid from client_invoice_notes where id = ${note} for update`) as unknown as { pid: number }[];
            // The command takes the invoice, then parks on the note.
            issued = (async () => issueNote(note))();
            await waitParked('client_invoice_notes', locked[0]!.pid, 1);
            // The writer now needs the invoice (the trigger's FOR UPDATE) — held by the command.
            await tx`update client_invoice_notes set status = 'issued', note_no = '29/C2627/000777', fy_label = 'FY-2627', series_seq = 777,
                issued_at = now(), issued_by = ${checkerId} where id = ${note}`;
          })
          .catch((err: unknown) => {
            writerError = err;
          });
        const res = await issued!;
        // Exactly one side aborted with the deadlock: the writer (the command then issues), or the command (an error answer).
        if ((writerError as { code?: string } | null)?.code === '40P01') {
          expect(res.status).toBe(200);
        } else {
          expect(writerError).toBeNull();
          expect([409, 500]).toContain(res.status);
        }
      } finally {
        await Promise.allSettled([issued]);
        await writer.end();
      }
    });

    it('direct-SQL arms: an insert for another client, an issued insert, a line that does not copy its invoice line, a line of another invoice — each refused', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const other = await seedInvoice({ amounts: [100_000] });
      const insertNote = (over: { clientId?: string; status?: string }) => sql`
        insert into client_invoice_notes (id, tenant_id, client_id, invoice_id, kind, status, supplier_gstin, place_of_supply, supply_type, reason, reason_note,
            subtotal_paise, cgst_paise, sgst_paise, igst_paise, tax_paise, total_paise, round_off_paise, payable_paise, party, created_by)
        select ${uuidv7()}, tenant_id, ${over.clientId ?? acme}, id, 'credit', ${over.status ?? 'draft'}, supplier_gstin, place_of_supply, supply_type, 'excess-billed', 'x',
          1, 0, 0, 0, 0, 1, 0, 1, party, ${makerId}
        from client_invoices where id = ${invoice.id}`;
      await expect(insertNote({ clientId: beta })).rejects.toMatchObject({ code: 'P0001' });
      await expect(insertNote({ status: 'issued' })).rejects.toMatchObject({ code: 'P0001' });
      const note = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      await expect(sql`update client_invoice_note_lines set sac_code = '996729' where note_id = ${note}`).rejects.toMatchObject({ code: 'P0001' });
      await expect(sql`update client_invoice_note_lines set invoice_line_id = ${other.lineIds[0]!} where note_id = ${note}`).rejects.toMatchObject({ code: 'P0001' });
      // Over the cap at the trigger: a credit's lines inflated past the invoice line by direct SQL (draft lines may change), then issued.
      await sql`update client_invoice_note_lines set amount_paise = 200000, cgst_paise = 18000, sgst_paise = 18000 where note_id = ${note}`;
      await sql`update client_invoice_notes set subtotal_paise = 200000, cgst_paise = 18000, sgst_paise = 18000, tax_paise = 36000, total_paise = 236000, payable_paise = 236000 where id = ${note}`;
      await expect(
        sql`update client_invoice_notes set status = 'issued', note_no = '29/C2627/000555', fy_label = 'FY-2627', series_seq = 555, issued_at = now(), issued_by = ${checkerId} where id = ${note}`,
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('the portal: ACME lists its invoice’s issued and void notes with the document value (never a draft); BETA and a draft invoice are 404; the note detail is the exact allowlist', async () => {
      const invoice = await seedInvoice({ amounts: [100_000] });
      const issued = await issuedCredit(invoice.id, invoice.lineIds[0]!, 20_000);
      const voided = await issuedCredit(invoice.id, invoice.lineIds[0]!, 1000);
      await voidNote(voided.id).expect(200);
      const draft = (await credit(invoice.id, invoice.lineIds[0]!, 500).expect(201)).body.note.id as string;
      const portal = (path: string, token = portalAcme) => http().get(`${API}/${tenantId}/portal/${path}`).set('Authorization', `Bearer ${token}`);
      const listed = await portal(`invoices/${invoice.id}/notes`).expect(200);
      expect(listed.body.notes.map((n: { noteNo: string; status: string }) => [n.noteNo, n.status])).toEqual([
        [issued.noteNo, 'issued'],
        [voided.noteNo, 'void'],
      ]);
      expect(listed.body.netDocumentPayable).toBe(118_000 - 23_600);
      expect(Object.keys(listed.body.notes[0]).sort()).toEqual(['fyLabel', 'id', 'issuedAt', 'kind', 'noteNo', 'reason', 'reasonNote', 'status', 'totals']);
      expectProblem(await portal(`invoices/${invoice.id}/notes`, portalBeta), 404, 'not-found');
      const draftInvoice = await seedInvoice({ amounts: [100], status: 'draft' });
      expectProblem(await portal(`invoices/${draftInvoice.id}/notes`), 404, 'not-found');
      expectProblem(await portal(`invoices/${uuidv7()}/notes`), 404, 'not-found');
      const detail = await portal(`invoice-notes/${issued.id}`).expect(200);
      expect(Object.keys(detail.body).sort()).toEqual(
        ['fyLabel', 'id', 'invoiceIssuedAt', 'invoiceNo', 'issuedAt', 'kind', 'lines', 'noteNo', 'party', 'placeOfSupply', 'reason', 'reasonNote', 'status', 'supplyType', 'totals'].sort(),
      );
      expect(Object.keys(detail.body.lines[0]).sort()).toEqual(['amountPaise', 'basis', 'cgstPaise', 'chargeCode', 'gstBps', 'igstPaise', 'sac', 'segmentFrom', 'segmentTo', 'sgstPaise', 'uom']);
      expect(Object.keys(detail.body.party.supplier).sort()).toEqual(['address', 'gstin', 'name', 'stateCode', 'stateName']);
      expect(Object.keys(detail.body.party.recipient).sort()).toEqual(['address', 'gstin', 'legalName', 'name', 'stateCode', 'stateName']);
      expect(detail.body).toMatchObject({ noteNo: issued.noteNo, reasonNote: 'Rate keyed wrongly', invoiceNo: expect.stringMatching(/\/S2627\//) });
      expectProblem(await portal(`invoice-notes/${draft}`), 404, 'not-found');
      expectProblem(await portal(`invoice-notes/${issued.id}`, portalBeta), 404, 'not-found');
      expectProblem(await portal('invoice-notes/not-a-uuid'), 404, 'not-found');
    });

    it('the register: one GSTIN’s issued and void notes in May 2027 with the CDNR fields; a June note excluded; paged; missing gstin 400', async () => {
      const invoice = await seedInvoice({ amounts: [100_000, 50_000] });
      const a = (await createNote(invoice.id, { kind: 'credit', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 20_000 }, { invoiceLineId: invoice.lineIds[1]!, amountPaise: 10_000 }] }).expect(201)).body.note.id as string;
      const b = (await createNote(invoice.id, { kind: 'debit', lines: [{ invoiceLineId: invoice.lineIds[0]!, amountPaise: 5000 }] }).expect(201)).body.note.id as string;
      const c = (await credit(invoice.id, invoice.lineIds[0]!, 1000).expect(201)).body.note.id as string;
      clientInvoiceClock.now = () => ist('2027-05-03T10:00');
      await issueNote(a).expect(200);
      clientInvoiceClock.now = () => ist('2027-05-31T23:59');
      await issueNote(b).expect(200);
      await voidNote(b).expect(200);
      clientInvoiceClock.now = () => ist('2027-06-01T00:00');
      await issueNote(c).expect(200);
      const register = (query: string) => http().get(`${API}/${tenantId}/client-invoice-notes?${query}`).set('Authorization', `Bearer ${opsToken}`);
      const page = await register(`gstin=${invoice.gstin}&from=2027-05-01&to=2027-05-31`).expect(200);
      expect(page.body.nextCursor).toBeNull();
      expect(page.body.rows).toEqual([
        expect.objectContaining({ noteId: a, noteNo: '29/C2728/000001', noteDate: '2027-05-03', kind: 'credit', status: 'issued', voided: false, recipientGstin: '29AAACA1111A1Z1', recipientName: 'Acme Foods Private Limited', placeOfSupply: '29', supplyType: 'intra', invoiceDate: '2026-10-05', gstBps: 1800, taxablePaise: 30_000, cgstPaise: 2700, sgstPaise: 2700, igstPaise: 0, noteValuePaise: 35_400 }),
        expect.objectContaining({ noteId: b, noteNo: '29/D2728/000001', noteDate: '2027-05-31', kind: 'debit', status: 'void', voided: true, taxablePaise: 5000 }),
      ]);
      const first = await register(`gstin=${invoice.gstin}&from=2027-05-01&to=2027-06-30&limit=1`).expect(200);
      expect(first.body.rows.map((r: { noteId: string }) => r.noteId)).toEqual([a]);
      const second = await register(`gstin=${invoice.gstin}&from=2027-05-01&to=2027-06-30&limit=1&cursor=${encodeURIComponent(first.body.nextCursor as string)}`).expect(200);
      expect(second.body.rows.map((r: { noteId: string }) => r.noteId)).toEqual([b]);
      const voidOnly = await register(`gstin=${invoice.gstin}&from=2027-05-01&to=2027-06-30&status=void`).expect(200);
      expect(voidOnly.body.rows.map((r: { noteId: string }) => r.noteId)).toEqual([b]);
      // The kind filter (C14).
      const creditsOnly = await register(`gstin=${invoice.gstin}&from=2027-05-01&to=2027-06-30&kind=credit`).expect(200);
      expect([...new Set(creditsOnly.body.rows.map((r: { noteId: string }) => r.noteId))]).toEqual([a, c]);
      const debitsOnly = await register(`gstin=${invoice.gstin}&from=2027-05-01&to=2027-06-30&kind=debit`).expect(200);
      expect(debitsOnly.body.rows.map((r: { noteId: string }) => r.noteId)).toEqual([b]);
      expectProblem(await register('from=2027-05-01&to=2027-05-31'), 400, 'validation-failed');
      expectProblem(await register(`gstin=${invoice.gstin}&from=2027-05-31&to=2027-05-01`), 400, 'validation-failed');
      expectProblem(await register(`gstin=${invoice.gstin}&from=2027-05-01&to=2027-05-31&cursor=junk`), 400, 'invalid-cursor');
    });

    it('every route is in the OpenAPI document', async () => {
      const doc = (await http().get('/api/v1/openapi.json').expect(200)).body as { paths: Record<string, Record<string, unknown>> };
      const has = (path: string, method: string) => Object.keys(doc.paths[path] ?? {}).includes(method);
      expect(has('/tenants/{tenantId}/client-invoices/{invoiceId}/notes', 'post')).toBe(true);
      expect(has('/tenants/{tenantId}/client-invoices/{invoiceId}/notes', 'get')).toBe(true);
      expect(has('/tenants/{tenantId}/client-invoice-notes', 'get')).toBe(true);
      expect(has('/tenants/{tenantId}/client-invoice-notes/{noteId}', 'get')).toBe(true);
      expect(has('/tenants/{tenantId}/client-invoice-notes/{noteId}', 'delete')).toBe(true);
      expect(has('/tenants/{tenantId}/client-invoice-notes/{noteId}/issue', 'post')).toBe(true);
      expect(has('/tenants/{tenantId}/client-invoice-notes/{noteId}/void', 'post')).toBe(true);
      expect(has('/tenants/{tenantId}/billing/note-policy', 'get')).toBe(true);
      expect(has('/tenants/{tenantId}/billing/note-policy', 'put')).toBe(true);
      expect(has('/tenants/{tenantId}/portal/invoices/{invoiceId}/notes', 'get')).toBe(true);
      expect(has('/tenants/{tenantId}/portal/invoice-notes/{noteId}', 'get')).toBe(true);
    });

    // ── the parked-waiter helpers (test/inbound.spec.ts `raceTwice` / `waitParked`) ──

    async function waitParked(table: 'client_invoices' | 'client_invoice_notes', holderPid: number, min: number): Promise<void> {
      const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = (await probe`
            select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
            where a.wait_event_type = 'Lock' and a.state = 'active'
              and a.query ilike ${`%"${table}"%`} and a.query ilike '%for update%'
          `) as unknown as { pid: number; blockers: number[] }[];
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
        throw new Error(`fewer than ${min} request(s) parked on the ${table} row`);
      } finally {
        await probe.end();
      }
    }

    async function raceTwice(invoiceId: string, send: () => SupertestTest): Promise<[request.Response, request.Response]> {
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from client_invoices where id = ${invoiceId} for update`) as unknown as { pid: number }[];
          first = (async () => send())();
          second = (async () => send())();
          await waitParked('client_invoices', locked[0]!.pid, 2);
        });
        return await Promise.all([first!, second!]);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
    }
  });
});
