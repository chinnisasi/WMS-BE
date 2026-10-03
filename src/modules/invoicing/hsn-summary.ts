import { and, asc, eq, sql } from 'drizzle-orm';
import { invoiceLines, invoices } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { GSTIN_RE } from '../../shared/primitives/gstin';
import { canonicalInstant } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { ArithmeticOverflowError } from './arith';
import { IST_OFFSET_MS } from './generator';
import { uqcFor, type Uqc } from './uqc';

/**
 * The HSN summary (story 8-2a): GSTR-1 Table 12's per-HSN figures over the
 * ISSUED invoices of ONE supplier GSTIN in ONE accounting period (by IST
 * issue date), split B2B / B2C and grouped by (HSN, UQC, GST rate).
 *
 * Read-only. Every amount is the exact paise sum of frozen invoice lines —
 * nothing is rounded per row and the invoice round-off is never spread
 * (Table 12's values are taxable + tax; round-off is invoice presentation).
 * Lines whose frozen HSN is blank or malformed are KEPT: they surface as
 * flagged rows inside the totals (so the totals reconcile to the invoices),
 * and are listed line by line with the SKU's current catalog HSN as a hint.
 * The web leaves them out of the CSV (the portal accepts only master HSNs).
 */

// ── periods ─────────────────────────────────────────────────────────────────

export const HSN_PERIOD_KINDS = ['month', 'quarter'] as const;
export type HsnPeriodKind = (typeof HSN_PERIOD_KINDS)[number];

/** The two accepted spellings: `2026-09` and `FY-2627-Q2` (shape only — `parsePeriod` rules on the values). */
export const HSN_PERIOD_SHAPE_RE = /^(?:\d{4}-\d{2}|FY-\d{4}-Q\d)$/;

export interface HsnPeriod {
  readonly label: string;
  readonly kind: HsnPeriodKind;
  /** Inclusive lower bound: the UTC instant of the period's first IST midnight. */
  readonly from: string;
  /** EXCLUSIVE upper bound: the UTC instant of the next period's first IST midnight. */
  readonly to: string;
}

function invalidPeriod(raw: string, why: string): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    'Invalid HSN summary period',
    `period must be a month "YYYY-MM" (01–12) or an FY quarter "FY-yyyy-Qn" (consecutive years, Q1–Q4, e.g. "FY-2627-Q2") — ${why} (got "${raw}")`,
  );
}

/** The UTC instant of IST midnight opening the given calendar month (month 0-based, may overflow into the next year). */
function istMonthStart(year: number, month0: number): string {
  return new Date(Date.UTC(year, month0, 1) - IST_OFFSET_MS).toISOString();
}

/**
 * Parses a period label into its `[from, to)` UTC bounds. The bounds are
 * computed HERE, from the generator's own IST offset (the clock the FY label
 * and the printed date use), and bound as timestamptz — never `date_trunc`
 * or a session time zone, which could drift from the issuance clock.
 *
 * A quarter is the FY quarter: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar
 * of the following calendar year (`FY-2627-Q4` = Jan–Mar 2027).
 */
export function parsePeriod(raw: string): HsnPeriod {
  const month = /^(\d{4})-(\d{2})$/.exec(raw);
  if (month !== null) {
    const year = Number(month[1]);
    const m = Number(month[2]);
    if (m < 1 || m > 12) {
      throw invalidPeriod(raw, `month ${month[2]} is not 01–12`);
    }
    return { label: raw, kind: 'month', from: istMonthStart(year, m - 1), to: istMonthStart(year, m) };
  }
  const quarter = /^FY-(\d{2})(\d{2})-Q(\d)$/.exec(raw);
  if (quarter !== null) {
    const startYy = Number(quarter[1]);
    const endYy = Number(quarter[2]);
    if ((startYy + 1) % 100 !== endYy) {
      throw invalidPeriod(raw, `FY-${quarter[1]}${quarter[2]} is not two consecutive years`);
    }
    const q = Number(quarter[3]);
    if (q < 1 || q > 4) {
      throw invalidPeriod(raw, `quarter Q${quarter[3]} is not Q1–Q4`);
    }
    // FY labels carry two-digit years (`FY-2627`, the generator's own label).
    const startYear = 2000 + startYy;
    // Q1 opens in April (month index 3); each quarter is three months on.
    const firstMonth0 = 3 + (q - 1) * 3;
    return {
      label: raw,
      kind: 'quarter',
      from: istMonthStart(startYear, firstMonth0),
      to: istMonthStart(startYear, firstMonth0 + 3),
    };
  }
  throw invalidPeriod(raw, 'unrecognised shape');
}

/** A GSTIN query parameter: the shared shape, matched EXACTLY (no case folding — the stored form is canonical). */
export function assertGstinParam(raw: string): string {
  if (!GSTIN_RE.test(raw)) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Invalid GSTIN',
      `gstin must be a GSTIN — two digits then thirteen letters or digits (got "${raw}")`,
    );
  }
  return raw;
}

// ── HSN validity ────────────────────────────────────────────────────────────

/**
 * A usable HSN: 4, 6 or 8 digits after trimming. The catalog's HSN is free
 * text, so anything else (a blank, `'HSN 0910'`, a 5-digit code) is an HSN
 * ISSUE. ONE pattern, used by both the SQL classifier and the TS check (the
 * POSIX class, not `\d`, so the two engines agree on what a digit is).
 */
export const HSN_PATTERN = '^[0-9]{4}([0-9]{2}){0,2}$';
const HSN_RE = new RegExp(HSN_PATTERN);

/**
 * Validity of an HSN ALREADY normalized by SQL (`nullif(btrim(hsn), '')`,
 * `HSN_TRIMMED_SQL`) — no second trim here: JS `trim()` strips more
 * whitespace than `btrim`, and the two must never disagree on a row. The
 * same rule as the SQL issue-line filter: null or not matching → an issue.
 */
export function isValidHsn(hsn: string | null): boolean {
  return hsn !== null && HSN_RE.test(hsn);
}

// ── shapes ──────────────────────────────────────────────────────────────────

export const HSN_SECTIONS = ['b2b', 'b2c'] as const;
export type HsnSection = (typeof HSN_SECTIONS)[number];

export interface HsnSummaryRow {
  /** The trimmed HSN; null when the line carried none. */
  readonly hsn: string | null;
  /** Blank or malformed HSN — in the totals, never in the CSV. */
  readonly hsnIssue: boolean;
  readonly uqc: Uqc;
  /** The distinct catalog units merged into this row, sorted. */
  readonly sourceUoms: readonly string[];
  /** More than one source unit under one UQC (only `OTH` can merge units). */
  readonly mixedUnits: boolean;
  readonly gstBps: number;
  /** Σ dispatched quantity, milli-units (unrounded — the CSV rounds once per row). */
  readonly qtyMilli: number;
  readonly lineCount: number;
  readonly taxablePaise: number;
  readonly igstPaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  /** taxable + every tax (Table 12's "Total Value"). */
  readonly totalValuePaise: number;
}

export interface HsnSummaryTotals {
  readonly invoiceCount: number;
  readonly taxablePaise: number;
  readonly igstPaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly gstPaise: number;
  readonly totalValuePaise: number;
}

export interface HsnSummarySectionView {
  readonly rows: readonly HsnSummaryRow[];
  readonly totals: HsnSummaryTotals;
}

/** One line behind an HSN-issue row. */
export interface HsnIssueLine {
  readonly section: HsnSection;
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly skuCode: string;
  /** The HSN frozen on the line (null = blank). */
  readonly hsn: string | null;
  readonly taxablePaise: number;
  readonly gstPaise: number;
  readonly valuePaise: number;
  /** The SKU's CURRENT catalog HSN — a hint for the correction, never applied. */
  readonly catalogHsn: string | null;
}

export interface HsnSummaryView {
  readonly gstin: string;
  readonly period: HsnPeriod & { readonly toExclusive: true };
  readonly b2b: HsnSummarySectionView;
  readonly b2c: HsnSummarySectionView;
  readonly totals: HsnSummaryTotals;
  readonly issueLines: readonly HsnIssueLine[];
}

export interface HsnSummaryGstin {
  readonly gstin: string;
  readonly firstIssuedAt: string;
  readonly lastIssuedAt: string;
  readonly invoiceCount: number;
}

// ── the reads ───────────────────────────────────────────────────────────────

/** `sum(...)::bigint` arrives as a string (int8): coerce at the boundary, refusing beyond 2⁵³. */
function safeInt(value: string | number | null, what: string): number {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n)) {
    throw new ArithmeticOverflowError(`HSN summary: ${what} is not a safe integer (${String(value)})`);
  }
  return n;
}

/** The shared row filter: issued, this tenant, this GSTIN (exact), issued_at in [from, to). */
function issuedInPeriod(tenantId: string, gstin: string, period: HsnPeriod) {
  return and(
    eq(invoices.tenantId, tenantId),
    // A LITERAL, not a bound parameter: a generic plan can only use the
    // partial index `WHERE status = 'issued'` when the predicate is literal.
    ISSUED_SQL,
    eq(invoices.originGstin, gstin),
    sql`${invoices.issuedAt} >= ${period.from}::timestamptz`,
    sql`${invoices.issuedAt} < ${period.to}::timestamptz`,
  );
}

const ISSUED_SQL = sql`${invoices.status} = 'issued'`;
const B2B_SQL = sql<boolean>`(${invoices.consigneeGstin} is not null)`;
/** The ONE HSN normalization: trimmed, and a whitespace-only value is null (a blank). */
const HSN_TRIMMED_SQL = sql<string | null>`nullif(btrim(${invoiceLines.hsn}), '')`;

interface Group {
  hsn: string | null;
  hsnIssue: boolean;
  uqc: Uqc;
  gstBps: number;
  sourceUoms: Set<string>;
  qtyMilli: number;
  lineCount: number;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

function addExact(a: number, b: number, what: string): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw new ArithmeticOverflowError(`HSN summary: ${what} overflows 2^53`);
  }
  return sum;
}

/** Deterministic: valid HSNs ascending, issue rows last; then UQC; then rate. */
function compareRows(a: HsnSummaryRow, b: HsnSummaryRow): number {
  if (a.hsnIssue !== b.hsnIssue) return a.hsnIssue ? 1 : -1;
  const ha = a.hsn ?? '';
  const hb = b.hsn ?? '';
  if (ha !== hb) return ha < hb ? -1 : 1;
  if (a.uqc !== b.uqc) return a.uqc < b.uqc ? -1 : 1;
  return a.gstBps - b.gstBps;
}

function emptyTotals(invoiceCount: number): HsnSummaryTotals {
  return { invoiceCount, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, gstPaise: 0, totalValuePaise: 0 };
}

function sumTotals(rows: readonly HsnSummaryRow[], invoiceCount: number): HsnSummaryTotals {
  return rows.reduce<HsnSummaryTotals>((acc, row) => {
    const gst = addExact(addExact(row.igstPaise, row.cgstPaise, 'gst'), row.sgstPaise, 'gst');
    return {
      invoiceCount,
      taxablePaise: addExact(acc.taxablePaise, row.taxablePaise, 'taxable total'),
      igstPaise: addExact(acc.igstPaise, row.igstPaise, 'IGST total'),
      cgstPaise: addExact(acc.cgstPaise, row.cgstPaise, 'CGST total'),
      sgstPaise: addExact(acc.sgstPaise, row.sgstPaise, 'SGST total'),
      gstPaise: addExact(acc.gstPaise, gst, 'GST total'),
      totalValuePaise: addExact(acc.totalValuePaise, row.totalValuePaise, 'total value'),
    };
  }, emptyTotals(invoiceCount));
}

/**
 * The summary's two aggregates and the issue lines, in the caller's tenant
 * transaction. `catalogHsnFor` is the catalog facade's in-tx read (the
 * invoicing module never reads `skus`).
 */
export async function hsnSummaryInTx(
  tx: TenantTx,
  tenantId: string,
  gstin: string,
  period: HsnPeriod,
  catalogHsnFor: (codes: readonly string[]) => Promise<ReadonlyMap<string, string | null>>,
): Promise<HsnSummaryView> {
  const where = issuedInPeriod(tenantId, gstin, period);

  // 1. Per (section, trimmed HSN, unit, rate), in SQL. `::bigint` sums come
  // back as strings (Postgres `sum(bigint)` is numeric) — coerced below.
  const grouped = await tx
    .select({
      b2b: B2B_SQL,
      hsn: HSN_TRIMMED_SQL,
      uom: invoiceLines.uom,
      gstBps: invoiceLines.gstBps,
      qtyMilli: sql<string>`sum(${invoiceLines.qtyMilli})::bigint`,
      lineCount: sql<string>`count(*)::bigint`,
      taxablePaise: sql<string>`sum(${invoiceLines.taxablePaise})::bigint`,
      igstPaise: sql<string>`sum(${invoiceLines.igstPaise})::bigint`,
      cgstPaise: sql<string>`sum(${invoiceLines.cgstPaise})::bigint`,
      sgstPaise: sql<string>`sum(${invoiceLines.sgstPaise})::bigint`,
    })
    .from(invoices)
    .innerJoin(invoiceLines, and(eq(invoiceLines.invoiceId, invoices.id), eq(invoiceLines.tenantId, invoices.tenantId)))
    .where(where)
    .groupBy(B2B_SQL, HSN_TRIMMED_SQL, invoiceLines.uom, invoiceLines.gstBps);

  // 2. Invoice counts per section, from `invoices` itself — an issued
  // invoice can carry zero lines and still counts.
  const counts = await tx
    .select({ b2b: B2B_SQL, n: sql<string>`count(*)::bigint` })
    .from(invoices)
    .where(where)
    .groupBy(B2B_SQL);
  const countFor = (b2b: boolean): number => safeInt(counts.find((row) => Boolean(row.b2b) === b2b)?.n ?? 0, 'invoice count');

  // 3. Unit → UQC, then MERGE rows sharing (section, HSN, UQC, rate) — in
  // integers. Only `OTH` can gather several units.
  const groups = new Map<string, Group & { section: HsnSection }>();
  for (const row of grouped) {
    const section: HsnSection = row.b2b ? 'b2b' : 'b2c';
    const { uqc } = uqcFor(row.uom);
    const hsnIssue = !isValidHsn(row.hsn);
    const key = JSON.stringify([section, row.hsn, uqc, row.gstBps]);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        section,
        hsn: row.hsn,
        hsnIssue,
        uqc,
        gstBps: row.gstBps,
        sourceUoms: new Set(),
        qtyMilli: 0,
        lineCount: 0,
        taxablePaise: 0,
        igstPaise: 0,
        cgstPaise: 0,
        sgstPaise: 0,
      };
      groups.set(key, group);
    }
    group.sourceUoms.add(row.uom);
    group.qtyMilli = addExact(group.qtyMilli, safeInt(row.qtyMilli, 'quantity'), 'quantity');
    group.lineCount = addExact(group.lineCount, safeInt(row.lineCount, 'line count'), 'line count');
    group.taxablePaise = addExact(group.taxablePaise, safeInt(row.taxablePaise, 'taxable'), 'taxable');
    group.igstPaise = addExact(group.igstPaise, safeInt(row.igstPaise, 'IGST'), 'IGST');
    group.cgstPaise = addExact(group.cgstPaise, safeInt(row.cgstPaise, 'CGST'), 'CGST');
    group.sgstPaise = addExact(group.sgstPaise, safeInt(row.sgstPaise, 'SGST'), 'SGST');
  }

  const rowsBySection: Record<HsnSection, HsnSummaryRow[]> = { b2b: [], b2c: [] };
  for (const group of groups.values()) {
    const sourceUoms = [...group.sourceUoms].sort();
    const tax = addExact(addExact(group.igstPaise, group.cgstPaise, 'tax'), group.sgstPaise, 'tax');
    rowsBySection[group.section].push({
      hsn: group.hsn,
      hsnIssue: group.hsnIssue,
      uqc: group.uqc,
      sourceUoms,
      mixedUnits: sourceUoms.length > 1,
      gstBps: group.gstBps,
      qtyMilli: group.qtyMilli,
      lineCount: group.lineCount,
      taxablePaise: group.taxablePaise,
      igstPaise: group.igstPaise,
      cgstPaise: group.cgstPaise,
      sgstPaise: group.sgstPaise,
      totalValuePaise: addExact(group.taxablePaise, tax, 'total value'),
    });
  }
  rowsBySection.b2b.sort(compareRows);
  rowsBySection.b2c.sort(compareRows);

  const b2b: HsnSummarySectionView = { rows: rowsBySection.b2b, totals: sumTotals(rowsBySection.b2b, countFor(true)) };
  const b2c: HsnSummarySectionView = { rows: rowsBySection.b2c, totals: sumTotals(rowsBySection.b2c, countFor(false)) };

  // 4. The lines behind the issue rows, with the SKU's current catalog HSN.
  const issueRows = await tx
    .select({
      b2b: B2B_SQL,
      invoiceId: invoices.id,
      invoiceNo: invoices.invoiceNo,
      skuCode: invoiceLines.skuCode,
      hsn: HSN_TRIMMED_SQL,
      taxablePaise: invoiceLines.taxablePaise,
      igstPaise: invoiceLines.igstPaise,
      cgstPaise: invoiceLines.cgstPaise,
      sgstPaise: invoiceLines.sgstPaise,
    })
    .from(invoices)
    .innerJoin(invoiceLines, and(eq(invoiceLines.invoiceId, invoices.id), eq(invoiceLines.tenantId, invoices.tenantId)))
    .where(
      and(
        where,
        sql`(${HSN_TRIMMED_SQL} is null or ${HSN_TRIMMED_SQL} !~ ${HSN_PATTERN}::text)`,
      ),
    )
    .orderBy(asc(invoices.issuedAt), asc(invoices.invoiceNo), asc(invoiceLines.skuCode), asc(invoiceLines.id));
  const hints = await catalogHsnFor(issueRows.map((row) => row.skuCode));
  const issueLines: HsnIssueLine[] = issueRows.map((row) => {
    const gst = addExact(addExact(row.igstPaise, row.cgstPaise, 'issue-line GST'), row.sgstPaise, 'issue-line GST');
    return {
      section: row.b2b ? 'b2b' : 'b2c',
      invoiceId: row.invoiceId,
      // Every issued row carries a number (invoices_issued_stamped_check).
      invoiceNo: row.invoiceNo ?? '',
      skuCode: row.skuCode,
      hsn: row.hsn,
      taxablePaise: row.taxablePaise,
      gstPaise: gst,
      valuePaise: addExact(row.taxablePaise, gst, 'issue-line value'),
      catalogHsn: hints.get(row.skuCode) ?? null,
    };
  });

  const totals: HsnSummaryTotals = sumTotals([...b2b.rows, ...b2c.rows], b2b.totals.invoiceCount + b2c.totals.invoiceCount);

  return {
    gstin,
    period: { ...period, toExclusive: true },
    b2b,
    b2c,
    totals,
    issueLines,
  };
}

/** Each supplier GSTIN with issued invoices, and its first/last issue instant — the web's picker source. */
export async function hsnSummaryGstinsInTx(tx: TenantTx, tenantId: string): Promise<HsnSummaryGstin[]> {
  const rows = await tx
    .select({
      gstin: invoices.originGstin,
      first: sql<string>`min(${invoices.issuedAt})::text`,
      last: sql<string>`max(${invoices.issuedAt})::text`,
      n: sql<string>`count(*)::bigint`,
    })
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), ISSUED_SQL))
    .groupBy(invoices.originGstin)
    .orderBy(asc(invoices.originGstin));
  return rows
    .filter((row): row is typeof row & { gstin: string } => row.gstin !== null)
    .map((row) => ({
      gstin: row.gstin,
      firstIssuedAt: canonicalInstant(row.first),
      lastIssuedAt: canonicalInstant(row.last),
      invoiceCount: safeInt(row.n, 'invoice count'),
    }));
}
