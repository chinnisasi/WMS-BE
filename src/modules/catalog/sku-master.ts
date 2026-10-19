import { and, eq, inArray, ne } from 'drizzle-orm';
import { skuBarcodes, skus, uomConversions } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { resolveUom, unknownUomDetail, type Uom } from './uom';

/**
 * Story 1-4 — the SKU master's typed rules, ONE copy shared by the single-SKU
 * create, the packaging PUT, the SKU edit and the catalog import (the
 * `sku-attributes.ts` pattern: the CSV cell parser stays import-only; every
 * rule a parsed value must satisfy lives here). The DB backstops are the
 * CHECKs and unique indexes of `drizzle/0080_sku_master.sql`.
 */

/** Decision 12 — a barcode is at most 64 characters (today's DTO and import limit). */
export const BARCODE_MAX = 64;
/**
 * Decision 12 — printable ASCII, no leading or trailing space (the value is
 * trimmed first). The `sku_barcodes_barcode_check` CHECK carries the same
 * pattern; a `;` is refused separately (the import's barcodes-cell separator).
 */
export const BARCODE_RE = /^[!-~]([ -~]*[!-~])?$/;
/** Decision 8 — a pack level holds 2 to 1,000,000 base units (`uom_conversions_factor_check`). */
export const MIN_PACK_FACTOR = 2;
export const MAX_PACK_FACTOR = 1_000_000;
/** Decision 5 — total shelf life from manufacture, 1–3650 days (`skus_shelf_life_days_check`). */
export const MIN_SHELF_LIFE_DAYS = 1;
export const MAX_SHELF_LIFE_DAYS = 3650;
/** The SKU's identity bounds — the import's cell caps and the create DTO share them. */
export const SKU_CODE_MAX = 64;
export const SKU_NAME_MAX = 200;
export const HSN_MAX = 32;
/** GST as basis points: 0–10000 bps (0–100%). */
export const MAX_GST_RATE_BPS = 10_000;

export function assertGstRateBps(value: number, field = 'gstRate'): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_GST_RATE_BPS) {
    throw validationFailed(
      'Invalid GST rate',
      `${field} must be an integer between 0 and ${MAX_GST_RATE_BPS} basis points (got ${String(value)}).`,
    );
  }
}

/** Request-shape caps on the packaging arrays (a SKU has a handful of levels and barcodes). */
export const MAX_PACK_LEVELS = 20;
export const MAX_EXTRA_BARCODES = 100;

/** The constraint names every 23505 handler maps to `duplicate-barcode` (decision D6). */
export const SKU_BARCODES_UNIQUE = 'sku_barcodes_tenant_client_barcode_unique';
export const SKUS_BARCODE_UNIQUE = 'skus_tenant_client_barcode_unique';

export interface PackLevel {
  readonly uom: Uom;
  readonly factor: number;
}

export interface ExtraBarcode {
  readonly barcode: string;
  readonly uom: Uom;
}

/** One barcode as `SkuResponse.barcodes` carries it. */
export interface SkuBarcodeView {
  readonly barcode: string;
  readonly uom: string;
  readonly isPrimary: boolean;
}

function validationFailed(title: string, detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, title, detail);
}

/**
 * The barcode rule's refusal sentence for a (trimmed) value, or `null` when
 * it passes. The import turns it into a row error; the commands throw it.
 */
export function barcodeRuleDetail(value: string, field: string): string | null {
  if (value.length === 0 || value.length > BARCODE_MAX) {
    return `${field} must be 1–${BARCODE_MAX} characters (got ${value.length}).`;
  }
  if (value.includes(';')) {
    return `${field} "${value}" contains ";" — a barcode may not contain a semicolon.`;
  }
  if (!BARCODE_RE.test(value)) {
    return `${field} "${value}" must be printable ASCII with no leading or trailing space.`;
  }
  return null;
}

export function assertBarcodeRule(value: string, field: string): void {
  const detail = barcodeRuleDetail(value, field);
  if (detail !== null) throw validationFailed('Invalid barcode', detail);
}

/** Decision 5 — `null`/absent pass (no shelf life); anything else must be a whole 1–3650. */
export function shelfLifeDaysDetail(value: number | null | undefined, field = 'shelfLifeDays'): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_SHELF_LIFE_DAYS || value > MAX_SHELF_LIFE_DAYS) {
    return `${field} must be a whole number of days from ${MIN_SHELF_LIFE_DAYS} to ${MAX_SHELF_LIFE_DAYS} (total shelf life from manufacture) — got ${String(value)}.`;
  }
  return null;
}

export function assertShelfLifeDays(value: number | null | undefined): void {
  const detail = shelfLifeDaysDetail(value);
  if (detail !== null) throw validationFailed('Invalid shelf life', detail);
}

/**
 * Decision 8 — the pack levels: each `uom` resolves through the vocabulary
 * (aliases admitted), differs from the base uom and from every other level;
 * each factor is a whole 2–1,000,000. `field` names the levels in the
 * refusal (`levels` on the API, `uom_conversions` on the import).
 */
export function validateLevels(
  baseUom: string,
  raw: readonly { readonly uom: string; readonly factor: number }[],
  field = 'levels',
): PackLevel[] {
  const out: PackLevel[] = [];
  const seen = new Set<string>();
  for (const level of raw) {
    const uom = resolveUom(String(level.uom));
    if (uom === null) {
      throw validationFailed('Unknown pack level', unknownUomDetail(`${field} uom`, String(level.uom)));
    }
    if (uom === baseUom) {
      throw validationFailed(
        'A pack level cannot be the base unit',
        `${field} names "${uom}", the SKU's base uom — a pack level is a multiple of the base unit, never the unit itself.`,
      );
    }
    if (seen.has(uom)) {
      throw validationFailed('Duplicate pack level', `${field} names "${uom}" twice — one factor per level.`);
    }
    const factor = level.factor;
    if (typeof factor !== 'number' || !Number.isInteger(factor) || factor < MIN_PACK_FACTOR || factor > MAX_PACK_FACTOR) {
      throw validationFailed(
        'Invalid pack factor',
        `${field} factor for "${uom}" must be a whole number of base units from ${MIN_PACK_FACTOR} to ${MAX_PACK_FACTOR.toLocaleString('en-US')} (got ${String(factor)}).`,
      );
    }
    seen.add(uom);
    out.push({ uom, factor });
  }
  return out;
}

/**
 * The extra (non-primary) barcodes, against the SKU's base uom, its levels
 * and its primary barcode. Order of refusal: the barcode rule (400) → equal
 * to the primary (400) → a level that is neither the base uom nor a declared
 * level (400 `barcode-level-unknown`) → a repeat within the request (409
 * `duplicate-barcode`). Uniqueness against OTHER SKUs is a database read
 * (`assertBarcodesFreeInTx`).
 */
export function validateExtraBarcodes(
  baseUom: string,
  levels: readonly PackLevel[],
  primaryBarcode: string,
  raw: readonly { readonly barcode: string; readonly uom: string }[],
  field = 'barcodes',
): ExtraBarcode[] {
  const levelUoms = new Set<string>(levels.map((level) => level.uom));
  const out: ExtraBarcode[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const barcode = String(entry.barcode).trim();
    assertBarcodeRule(barcode, `${field} barcode`);
    if (barcode === primaryBarcode) {
      throw validationFailed(
        'Barcode equals the primary barcode',
        `${field} lists "${barcode}", which is already this SKU's primary barcode.`,
      );
    }
    const uom = resolveUom(String(entry.uom));
    if (uom === null || (uom !== baseUom && !levelUoms.has(uom))) {
      throw new ProblemException(
        'barcode-level-unknown',
        400,
        'Barcode level is not a pack level of this SKU',
        `${field} puts "${barcode}" on level "${String(entry.uom)}", which is neither the base uom "${baseUom}" nor a declared pack level` +
          (levelUoms.size === 0 ? '.' : ` (${[...levelUoms].join(', ')}).`),
      );
    }
    if (seen.has(barcode)) {
      throw duplicateBarcodeProblem(`Barcode "${barcode}" is listed twice in this request.`);
    }
    seen.add(barcode);
    out.push({ barcode, uom });
  }
  return out;
}

export function duplicateBarcodeProblem(detail: string): ProblemException {
  return new ProblemException('duplicate-barcode', 409, 'Barcode already in use', detail);
}

/** Decision 13 — a barcode may not equal any SKU code of the client. */
export function barcodeIsCode(barcode: string, code: string): ProblemException {
  return new ProblemException(
    'barcode-is-code',
    409,
    'Barcode equals a SKU code',
    `Barcode "${barcode}" equals the code of SKU "${code}" in this client — a barcode may not equal any SKU code, so a scan never has to choose between the two.`,
  );
}

/** Sorted the way the response and the hash read them: levels by uom. */
export function sortLevels<T extends { readonly uom: string }>(levels: readonly T[]): T[] {
  return [...levels].sort((a, b) => (a.uom < b.uom ? -1 : a.uom > b.uom ? 1 : 0));
}

/** Barcodes by (uom, barcode). */
export function sortBarcodes<T extends { readonly uom: string; readonly barcode: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    a.uom < b.uom ? -1 : a.uom > b.uom ? 1 : a.barcode < b.barcode ? -1 : a.barcode > b.barcode ? 1 : 0,
  );
}

/** `SkuResponse.barcodes`: the primary first, then (uom, barcode). */
export function orderBarcodeViews(rows: readonly SkuBarcodeView[]): SkuBarcodeView[] {
  const primary = rows.filter((row) => row.isPrimary);
  return [...primary, ...sortBarcodes(rows.filter((row) => !row.isPrimary))];
}

/**
 * The one barcode-uniqueness read (decisions 12–13): every candidate barcode
 * must be free in the client's `sku_barcodes` (rows of `exceptSkuId` — the
 * SKU being edited — excluded), and must equal no SKU code of the client
 * (the SKU's own code included: `ownCode`). 409 `duplicate-barcode` naming
 * the holder's code and level, or 409 `barcode-is-code`.
 */
export async function assertBarcodesFreeInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  candidates: readonly string[],
  opts: { readonly exceptSkuId?: string | undefined; readonly ownCode?: string | undefined } = {},
): Promise<void> {
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return;
  const held = await tx
    .select({ barcode: skuBarcodes.barcode, uom: skuBarcodes.uom, code: skus.code })
    .from(skuBarcodes)
    .innerJoin(skus, and(eq(skus.id, skuBarcodes.skuId), eq(skus.tenantId, skuBarcodes.tenantId)))
    .where(
      and(
        eq(skuBarcodes.tenantId, tenantId),
        eq(skuBarcodes.clientId, clientId),
        inArray(skuBarcodes.barcode, unique),
        ...(opts.exceptSkuId === undefined ? [] : [ne(skuBarcodes.skuId, opts.exceptSkuId)]),
      ),
    );
  const heldBy = new Map(held.map((row) => [row.barcode, row] as const));
  for (const barcode of candidates) {
    const holder = heldBy.get(barcode);
    if (holder !== undefined) {
      throw duplicateBarcodeProblem(`Barcode "${barcode}" already belongs to SKU "${holder.code}" (its ${holder.uom} barcode).`);
    }
  }
  if (opts.ownCode !== undefined && unique.includes(opts.ownCode)) {
    throw barcodeIsCode(opts.ownCode, opts.ownCode);
  }
  const codes = await tx
    .select({ code: skus.code })
    .from(skus)
    .where(and(eq(skus.tenantId, tenantId), eq(skus.clientId, clientId), inArray(skus.code, unique)));
  const codeSet = new Set(codes.map((row) => row.code));
  for (const barcode of candidates) {
    if (codeSet.has(barcode)) throw barcodeIsCode(barcode, barcode);
  }
}

/**
 * Keeps the SKU's primary `sku_barcodes` row equal to `skus.barcode` (and its
 * base uom) — called by every writer of `skus.barcode`, in its transaction,
 * after the SKU row is locked. An update, or an insert when the row is
 * missing (a SKU seeded below the API before 0080's backfill invariant).
 */
export async function writePrimaryBarcodeInTx(
  tx: TenantTx,
  sku: { readonly id: string; readonly tenantId: string; readonly clientId: string; readonly barcode: string; readonly uom: string },
): Promise<void> {
  const updated = await tx
    .update(skuBarcodes)
    .set({ barcode: sku.barcode, uom: sku.uom, updatedAt: nowIso() })
    .where(and(eq(skuBarcodes.tenantId, sku.tenantId), eq(skuBarcodes.skuId, sku.id), eq(skuBarcodes.isPrimary, true)))
    .returning({ id: skuBarcodes.id });
  if (updated.length === 0) {
    await tx.insert(skuBarcodes).values({
      id: uuidv7(),
      tenantId: sku.tenantId,
      clientId: sku.clientId,
      skuId: sku.id,
      barcode: sku.barcode,
      uom: sku.uom,
      isPrimary: true,
    });
  }
}

/** Delete-and-insert the SKU's pack levels and non-primary barcodes (the PUT and the create). */
export async function replacePackagingInTx(
  tx: TenantTx,
  sku: { readonly id: string; readonly tenantId: string; readonly clientId: string },
  levels: readonly PackLevel[],
  barcodes: readonly ExtraBarcode[],
): Promise<void> {
  await tx
    .delete(skuBarcodes)
    .where(and(eq(skuBarcodes.tenantId, sku.tenantId), eq(skuBarcodes.skuId, sku.id), eq(skuBarcodes.isPrimary, false)));
  await tx.delete(uomConversions).where(and(eq(uomConversions.tenantId, sku.tenantId), eq(uomConversions.skuId, sku.id)));
  if (levels.length > 0) {
    await tx.insert(uomConversions).values(
      levels.map((level) => ({ id: uuidv7(), tenantId: sku.tenantId, skuId: sku.id, uom: level.uom, factor: level.factor })),
    );
  }
  if (barcodes.length > 0) {
    await tx.insert(skuBarcodes).values(
      barcodes.map((entry) => ({
        id: uuidv7(),
        tenantId: sku.tenantId,
        clientId: sku.clientId,
        skuId: sku.id,
        barcode: entry.barcode,
        uom: entry.uom,
        isPrimary: false,
      })),
    );
  }
}

/** Every SKU's pack levels and barcodes, for a page of SKUs — two queries, never N+1. */
export async function readPackagingInTx(
  tx: TenantTx,
  tenantId: string,
  skuIds: readonly string[],
): Promise<Map<string, { levels: { uom: string; factor: number }[]; barcodes: SkuBarcodeView[] }>> {
  const out = new Map<string, { levels: { uom: string; factor: number }[]; barcodes: SkuBarcodeView[] }>();
  if (skuIds.length === 0) return out;
  for (const id of skuIds) out.set(id, { levels: [], barcodes: [] });
  const ids = [...new Set(skuIds)];
  const levelRows = await tx
    .select({ skuId: uomConversions.skuId, uom: uomConversions.uom, factor: uomConversions.factor })
    .from(uomConversions)
    .where(and(eq(uomConversions.tenantId, tenantId), inArray(uomConversions.skuId, ids)));
  const barcodeRows = await tx
    .select({ skuId: skuBarcodes.skuId, barcode: skuBarcodes.barcode, uom: skuBarcodes.uom, isPrimary: skuBarcodes.isPrimary })
    .from(skuBarcodes)
    .where(and(eq(skuBarcodes.tenantId, tenantId), inArray(skuBarcodes.skuId, ids)));
  for (const row of levelRows) out.get(row.skuId)?.levels.push({ uom: row.uom, factor: row.factor });
  for (const row of barcodeRows) out.get(row.skuId)?.barcodes.push({ barcode: row.barcode, uom: row.uom, isPrimary: row.isPrimary });
  for (const value of out.values()) {
    value.levels = sortLevels(value.levels);
    value.barcodes = orderBarcodeViews(value.barcodes);
  }
  return out;
}
