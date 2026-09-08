import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { parse as parseCsv } from 'csv-parse/sync';
import { Workbook, type CellValue } from 'exceljs';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  catalogImportErrors,
  catalogImports,
  idempotencyKeys,
  skus,
  uomConversions,
} from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { EVENT_BUS } from '../../shared/events/event-bus';

export const IMPORT_MODES = ['initial', 'fix'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

/** Import caps (spec 1.4): ≤ 10,000 data rows and ≤ 5 MB per file. */
export const MAX_IMPORT_ROWS = 10_000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export const SKU_CODE_MAX = 64;
export const NAME_MAX = 200;
export const UOM_MAX = 32;
export const HSN_MAX = 32;
export const BARCODE_MAX = 64;
/** GST as basis points: 0–10000 bps (0–100%). */
export const GST_RATE_BPS_MAX = 10_000;
/** Postgres `integer` ceiling — a bigger number would 500 on the column. */
export const INT_MAX = 2_147_483_647;

export interface CatalogImportErrorDto {
  /** 1-based data-row index (the header row is not counted). */
  readonly rowNumber: number;
  /** Absent when the row failed shape validation before a code could be read. */
  readonly skuCode: string | null;
  readonly code: string;
  readonly detail: string;
}

/** The import response — also the idempotency snapshot (AD-5). */
export interface CatalogImportResponse {
  readonly importId: string;
  readonly mode: ImportMode;
  readonly committedRows: number;
  readonly failedRows: number;
  readonly skippedRows: number;
  readonly errors: readonly CatalogImportErrorDto[];
}

export interface ImportCatalogCommand {
  readonly tenantId: string;
  readonly file: {
    readonly name: string;
    readonly mimetype: string;
    readonly buffer: Buffer;
    readonly size: number;
  };
  readonly mode: ImportMode;
}

const REQUIRED_COLUMNS = ['sku_code', 'name', 'uom', 'gst_rate'] as const;
const OPTIONAL_COLUMNS = [
  'uom_conversions',
  'hsn',
  'batch_tracked',
  'serial_tracked',
  'reorder_point',
  'reorder_qty',
  'barcode',
] as const;
const KNOWN_COLUMNS: ReadonlySet<string> = new Set([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

const SKUS_TENANT_CODE = 'skus_tenant_id_code_unique';
const SKUS_TENANT_BARCODE = 'skus_tenant_id_barcode_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

interface RawRow {
  readonly rowNumber: number;
  readonly values: Readonly<Record<string, string>>;
}

interface ValidRow {
  readonly rowNumber: number;
  readonly code: string;
  readonly name: string;
  readonly uom: string;
  readonly gstRateBps: number;
  readonly hsn: string | null;
  readonly batchTracked: boolean;
  readonly serialTracked: boolean;
  readonly reorderPoint: number;
  readonly reorderQty: number;
  /** Null → generated server-side (uuidv7) at insert. */
  readonly barcode: string | null;
  readonly conversions: readonly { readonly uom: string; readonly factor: number }[];
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; error: CatalogImportErrorDto };

/** exceljs' legacy Buffer interface (its xlsx.load parameter type). */
type ExcelBuffer = Parameters<Workbook['xlsx']['load']>[0];

/**
 * Catalog import (Story 1.4): a synchronous multipart CSV/XLSX import that
 * **commits valid rows** in one transaction and reports row-level errors —
 * partial commit is honest, never all-or-nothing. Row validation order (per
 * row): shape → gst bps range → uom factor positive int → duplicate-sku-code
 * (file-internal then tenant) → duplicate-barcode; the first failure wins,
 * one error per row. Fix mode processes only rows whose SKU code failed in
 * the tenant's most recent run (set membership, not diffing); everything else
 * is counted as skipped and left untouched. AD-5: one transaction + one
 * idempotency record — the payload fingerprint is sha256(file bytes) + mode,
 * and replay re-serves the exact counts + error list snapshot.
 */
@Injectable()
export class ImportCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
  ) {}

  async execute(command: ImportCatalogCommand, idempotencyKey: string): Promise<CatalogImportResponse> {
    if (command.file.size > MAX_IMPORT_BYTES) {
      throw importTooLarge(`The file is ${command.file.size} bytes — the cap is ${MAX_IMPORT_BYTES} bytes.`);
    }
    const rows = await parseSheetAsync(command.file);

    // Cheap fingerprint first (same discipline as registration): the payload
    // hash covers the file digest + mode — never the parsed row objects.
    const payloadHash = hashCommandPayload({
      fileSha256: createHash('sha256').update(command.file.buffer).digest('hex'),
      mode: command.mode,
    });

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, command.tenantId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as CatalogImportResponse,
            replayed: true,
          };
        }

        // Fix mode is set-membership against the LATEST run (newest
        // created_at, uuidv7 id tiebreaker) — no import picker, and repeated
        // fix rounds compose because each run's failures form the next set.
        let fixSet: ReadonlySet<string> = new Set();
        if (command.mode === 'fix') {
          const latest = await tx
            .select({ id: catalogImports.id })
            .from(catalogImports)
            .where(eq(catalogImports.tenantId, command.tenantId))
            .orderBy(desc(catalogImports.createdAt), desc(catalogImports.id))
            .limit(1);
          if (latest[0]) {
            const failed = await tx
              .select({ skuCode: catalogImportErrors.skuCode })
              .from(catalogImportErrors)
              .where(
                and(
                  eq(catalogImportErrors.tenantId, command.tenantId),
                  eq(catalogImportErrors.importId, latest[0].id),
                ),
              );
            fixSet = new Set(failed.map((e) => e.skuCode).filter((c): c is string => c !== null));
          }
        }

        // Fix mode processes only previously failed SKU codes; other rows are
        // skipped and left untouched.
        const processed =
          command.mode === 'fix'
            ? rows.filter((row) => fixSet.has(row.values['sku_code']?.trim() ?? ''))
            : rows;
        const skippedRows = command.mode === 'fix' ? rows.length - processed.length : 0;

        const valid: ValidRow[] = [];
        const errors: CatalogImportErrorDto[] = [];
        for (const result of processed.map((row) => validateRow(row))) {
          if (result.ok) valid.push(result.row);
          else errors.push(result.error);
        }

        // Duplicate detection: file-internal first (order of appearance), then
        // the tenant's existing SKUs — one error per row, first failure wins.
        const seenCodes = new Map<string, number>();
        const seenBarcodes = new Map<string, string>();
        const conflicts = await findTenantConflicts(tx, command.tenantId, valid);

        const insertable: ValidRow[] = [];
        for (const row of valid) {
          if (seenCodes.has(row.code)) {
            errors.push(rowError(row.rowNumber, row.code, 'duplicate-sku-code', `SKU code "${row.code}" appears twice in this file — row ${seenCodes.get(row.code)} used it first.`));
            continue;
          }
          if (conflicts.codes.has(row.code)) {
            errors.push(rowError(row.rowNumber, row.code, 'duplicate-sku-code', `SKU code "${row.code}" already exists in this tenant's catalog — duplicates are rejected, never merged.`));
            continue;
          }
          if (row.barcode !== null && (seenBarcodes.has(row.barcode) || conflicts.barcodes.has(row.barcode))) {
            const conflictingSku = seenBarcodes.get(row.barcode) ?? conflicts.barcodes.get(row.barcode)!;
            errors.push(rowError(row.rowNumber, row.code, 'duplicate-barcode', `Barcode "${row.barcode}" already belongs to SKU "${conflictingSku}".`));
            continue;
          }
          seenCodes.set(row.code, row.rowNumber);
          if (row.barcode !== null) seenBarcodes.set(row.barcode, row.code);
          insertable.push(row);
        }

        const importId = uuidv7();
        const committedRows = insertable.length;
        const failedRows = errors.length;

        if (committedRows > 0) {
          const skuRows = insertable.map((row) => ({
            id: uuidv7(),
            tenantId: command.tenantId,
            code: row.code,
            name: row.name,
            uom: row.uom,
            gstRateBps: row.gstRateBps,
            hsn: row.hsn,
            batchTracked: row.batchTracked,
            serialTracked: row.serialTracked,
            reorderPoint: row.reorderPoint,
            reorderQty: row.reorderQty,
            // Generated server-side at entry (uuidv7) unless the file carries one.
            barcode: row.barcode ?? uuidv7(),
          }));
          try {
            await tx.insert(skus).values(skuRows);
          } catch (err) {
            // A concurrent writer won the race between the pre-check and the
            // insert; the transaction aborts and the retry re-runs the checks.
            if (isUniqueViolationOn(err, SKUS_TENANT_CODE) || isUniqueViolationOn(err, SKUS_TENANT_BARCODE)) {
              throw duplicateSkuCode(insertable[0]!.code);
            }
            throw err;
          }
          const conversionRows = insertable.flatMap((row, i) =>
            row.conversions.map((conversion) => ({
              id: uuidv7(),
              tenantId: command.tenantId,
              skuId: skuRows[i]!.id,
              uom: conversion.uom,
              factor: conversion.factor,
            })),
          );
          if (conversionRows.length > 0) {
            await tx.insert(uomConversions).values(conversionRows);
          }
        }

        await tx.insert(catalogImports).values({
          id: importId,
          tenantId: command.tenantId,
          mode: command.mode,
          committedRows,
          failedRows,
          skippedRows,
        });
        if (errors.length > 0) {
          await tx.insert(catalogImportErrors).values(
            errors.map((error) => ({
              id: uuidv7(),
              tenantId: command.tenantId,
              importId,
              rowNumber: error.rowNumber,
              skuCode: error.skuCode,
              reasonCode: error.code,
              reasonDetail: error.detail,
            })),
          );
        }

        const snapshot: CatalogImportResponse = {
          importId,
          mode: command.mode,
          committedRows,
          failedRows,
          skippedRows,
          errors,
        };
        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snapshot,
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent idempotent request',
              'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
        return { snapshot, replayed: false };
      },
    );

    if (!replayed) {
      // Publish after the commit; a throwing bus must not 500 already-committed
      // work (the client's retry would replay instead of re-emit).
      try {
        await this.eventBus.publish({
          eventId: uuidv7(),
          type: 'catalog.imported',
          tenantId: command.tenantId,
          occurredAt: nowIso(),
          payload: {
            importId: snapshot.importId,
            mode: snapshot.mode,
            committedRows: snapshot.committedRows,
            failedRows: snapshot.failedRows,
            skippedRows: snapshot.skippedRows,
          },
        } satisfies DomainEvent);
      } catch (error) {
        console.warn(
          `Event publish failed after commit — type=catalog.imported tenant=${command.tenantId}:`,
          error,
        );
      }
    }
    return snapshot;
  }
}

function rowError(
  rowNumber: number,
  skuCode: string | null,
  code: string,
  detail: string,
): CatalogImportErrorDto {
  return { rowNumber, skuCode, code, detail };
}

export function duplicateSkuCode(code: string): ProblemException {
  return new ProblemException(
    'duplicate-sku-code',
    409,
    'SKU code already in use',
    `SKU code "${code}" already exists in this tenant's catalog — duplicates are rejected, never merged.`,
  );
}

export function importTooLarge(detail: string): ProblemException {
  return new ProblemException(
    'import-too-large',
    422,
    'Import exceeds the row or size cap',
    detail,
  );
}

export function unsupportedFileType(name: string): ProblemException {
  return new ProblemException(
    'unsupported-file-type',
    415,
    'Unsupported import file type',
    `Only .csv and .xlsx files can be imported (got "${name}").`,
  );
}

export function fileUnreadable(detail: string): ProblemException {
  return new ProblemException(
    'file-unreadable',
    400,
    'Import file could not be read',
    detail,
  );
}

/** Existing SKUs in this tenant colliding with the file's codes/barcodes. */
async function findTenantConflicts(
  tx: TenantTx,
  tenantId: string,
  rows: readonly ValidRow[],
): Promise<{ codes: ReadonlySet<string>; barcodes: ReadonlyMap<string, string> }> {
  const codes = [...new Set(rows.map((row) => row.code))];
  const barcodes = [...new Set(rows.map((row) => row.barcode).filter((b): b is string => b !== null))];
  const codesSet = new Set<string>();
  const barcodesMap = new Map<string, string>();
  if (codes.length > 0) {
    const rowsOut = await tx
      .select({ code: skus.code })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.code, codes)));
    for (const row of rowsOut) codesSet.add(row.code);
  }
  if (barcodes.length > 0) {
    const rowsOut = await tx
      .select({ code: skus.code, barcode: skus.barcode })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.barcode, barcodes)));
    for (const row of rowsOut) barcodesMap.set(row.barcode, row.code);
  }
  return { codes: codesSet, barcodes: barcodesMap };
}

/**
 * Sheet parsing. Both formats share the header contract: a required header
 * row whose columns come from the documented fixed set; unknown columns and
 * missing required columns make the file unreadable (400), as does a file
 * with no data rows.
 */
async function parseSheetAsync(file: ImportCatalogCommand['file']): Promise<RawRow[]> {
  const name = file.name.toLowerCase();
  const mime = file.mimetype.toLowerCase();
  if (name.endsWith('.csv') || mime.includes('csv')) {
    return parseCsvSheet(file.buffer);
  }
  if (name.endsWith('.xlsx') || mime.includes('spreadsheetml')) {
    return parseXlsxSheet(file.buffer);
  }
  throw unsupportedFileType(file.name || 'unnamed file');
}

function parseCsvSheet(buffer: Buffer): RawRow[] {
  let records: Record<string, string | string[]>[];
  try {
    records = parseCsv(new Uint8Array(buffer), {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: false,
    });
  } catch (error) {
    throw fileUnreadable(`The CSV could not be parsed: ${(error as Error).message}`);
  }
  // Header contract (shared with the xlsx path): unknown columns and missing
  // required columns make the file unreadable (400), not per-row errors.
  const headerNames = new Set<string>();
  for (const key of Object.keys(records[0] ?? {})) {
    const name = key.trim().toLowerCase();
    if (name === '') continue;
    if (!KNOWN_COLUMNS.has(name)) {
      throw fileUnreadable(`Unknown column "${key.trim()}" — the header must use the documented column names.`);
    }
    headerNames.add(name);
  }
  for (const required of REQUIRED_COLUMNS) {
    if (!headerNames.has(required)) {
      throw fileUnreadable(`Missing required column "${required}" in the header row.`);
    }
  }
  const rows = records.map((record, index) => {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      const name = key.trim().toLowerCase();
      if (!KNOWN_COLUMNS.has(name)) continue;
      values[name] = Array.isArray(value) ? value.join(',') : (value ?? '');
    }
    return { rowNumber: index + 1, values };
  });
  return finalizeRows(rows);
}

async function parseXlsxSheet(buffer: Buffer): Promise<RawRow[]> {
  const workbook = new Workbook();
  try {
    // exceljs types the argument as its own legacy Buffer interface.
    await workbook.xlsx.load(buffer as unknown as ExcelBuffer);
  } catch (error) {
    throw fileUnreadable(`The XLSX could not be parsed: ${(error as Error).message}`);
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw fileUnreadable('The workbook has no worksheets.');
  }
  const columns = new Map<number, string>();
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = cellText(cell.value).trim();
    if (header === '') return;
    const name = header.toLowerCase();
    if (!KNOWN_COLUMNS.has(name)) {
      throw fileUnreadable(`Unknown column "${header}" — the header must use the documented column names.`);
    }
    columns.set(colNumber, name);
  });
  for (const required of REQUIRED_COLUMNS) {
    if (![...columns.values()].includes(required)) {
      throw fileUnreadable(`Missing required column "${required}" in the header row.`);
    }
  }
  const rows: { rowNumber: number; values: Record<string, string> }[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, string> = {};
    for (const [colNumber, name] of columns) {
      values[name] = cellText(row.getCell(colNumber).value);
    }
    // Styled-but-blank trailing rows are not data rows.
    if (Object.values(values).some((value) => value.trim() !== '')) {
      rows.push({ rowNumber: rowNumber - 1, values });
    }
  });
  return finalizeRows(rows);
}

/** Blank-row filtering + the row cap, shared by both formats. */
function finalizeRows(
  rows: readonly { rowNumber: number; values: Record<string, string> }[],
): RawRow[] {
  const nonBlank = rows.filter((row) =>
    Object.values(row.values).some((value) => (value ?? '').trim() !== ''),
  );
  if (nonBlank.length === 0) {
    throw fileUnreadable('The file has a header row but no data rows.');
  }
  if (nonBlank.length > MAX_IMPORT_ROWS) {
    throw importTooLarge(`The file has ${nonBlank.length} data rows — the cap is ${MAX_IMPORT_ROWS}.`);
  }
  return nonBlank.map((row) => ({ rowNumber: row.rowNumber, values: row.values }));
}

/** ExcelJS cell values: formulas ({result}), rich text, dates, booleans. */
function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('result' in value) return cellText((value as { result: CellValue }).result);
    if ('text' in value) return cellText((value as { text: CellValue }).text);
    if ('richText' in value) {
      return (value as { richText: { text: string }[] }).richText.map((part) => part.text).join('');
    }
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function parseTracked(raw: string, column: string, rowNumber: number): FieldResult<boolean> {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'false' || value === '0') return { ok: true, value: false };
  if (value === 'true' || value === '1') return { ok: true, value: true };
  return {
    ok: false,
    error: rowError(rowNumber, null, 'validation-failed', `${column} must be true or false (got "${raw.trim()}").`),
  };
}

function parseInt0(raw: string, column: string, rowNumber: number): FieldResult<number> {
  const value = raw.trim();
  if (value === '') return { ok: true, value: 0 };
  if (!/^\d+$/.test(value)) {
    return {
      ok: false,
      error: rowError(rowNumber, null, 'validation-failed', `${column} must be a non-negative integer (got "${value}").`),
    };
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > INT_MAX) {
    return {
      ok: false,
      error: rowError(rowNumber, null, 'validation-failed', `${column} exceeds the integer ceiling of ${INT_MAX}.`),
    };
  }
  return { ok: true, value: n };
}

/**
 * Row validation order (spec 1.4 Design Notes): shape → gst bps range → uom
 * factor positive int → duplicate-sku-code → duplicate-barcode. The duplicate
 * checks run later (they need the whole file + the tenant); this step is
 * shape-only and returns the first shape failure as the row's error.
 */
function validateRow(row: RawRow): { ok: true; row: ValidRow } | { ok: false; error: CatalogImportErrorDto } {
  const v = row.values;
  const get = (name: string): string => v[name]?.trim() ?? '';
  const code = get('sku_code');
  if (code === '') {
    return { ok: false, error: rowError(row.rowNumber, null, 'validation-failed', 'sku_code is required.') };
  }
  if (code.length > SKU_CODE_MAX) {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', `sku_code must be at most ${SKU_CODE_MAX} characters.`) };
  }
  const name = get('name');
  if (name === '') {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', 'name is required.') };
  }
  if (name.length > NAME_MAX) {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', `name must be at most ${NAME_MAX} characters.`) };
  }
  const uom = get('uom');
  if (uom === '') {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', 'uom is required.') };
  }
  if (uom.length > UOM_MAX) {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', `uom must be at most ${UOM_MAX} characters.`) };
  }
  const gstRaw = get('gst_rate');
  if (gstRaw === '') {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', 'gst_rate is required (basis points, 18% = 1800).') };
  }
  if (!/^\d+$/.test(gstRaw) || Number(gstRaw) > GST_RATE_BPS_MAX) {
    return {
      ok: false,
      error: rowError(row.rowNumber, code, 'validation-failed', `gst_rate must be an integer between 0 and ${GST_RATE_BPS_MAX} basis points (got "${gstRaw}").`),
    };
  }
  const hsn = get('hsn');
  if (hsn.length > HSN_MAX) {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', `hsn must be at most ${HSN_MAX} characters.`) };
  }
  const batchResult = parseTracked(v['batch_tracked'] ?? '', 'batch_tracked', row.rowNumber);
  if (!batchResult.ok) return { ok: false, error: { ...batchResult.error, skuCode: code } };
  const serialResult = parseTracked(v['serial_tracked'] ?? '', 'serial_tracked', row.rowNumber);
  if (!serialResult.ok) return { ok: false, error: { ...serialResult.error, skuCode: code } };
  const pointResult = parseInt0(v['reorder_point'] ?? '', 'reorder_point', row.rowNumber);
  if (!pointResult.ok) return { ok: false, error: { ...pointResult.error, skuCode: code } };
  const qtyResult = parseInt0(v['reorder_qty'] ?? '', 'reorder_qty', row.rowNumber);
  if (!qtyResult.ok) return { ok: false, error: { ...qtyResult.error, skuCode: code } };
  const batchTracked = batchResult.value;
  const serialTracked = serialResult.value;
  const reorderPoint = pointResult.value;
  const reorderQty = qtyResult.value;
  const barcode = get('barcode');
  if (barcode.length > BARCODE_MAX) {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', `barcode must be at most ${BARCODE_MAX} characters.`) };
  }

  const conversions: { uom: string; factor: number }[] = [];
  const conversionsRaw = v['uom_conversions']?.trim() ?? '';
  if (conversionsRaw !== '') {
    const seenUoms = new Set<string>();
    for (const entry of conversionsRaw.split(';')) {
      const match = /^([^:]{1,32}):(\d+)$/.exec(entry.trim());
      if (match === null || match[1] === undefined || match[2] === undefined) {
        return {
          ok: false,
          error: rowError(row.rowNumber, code, 'validation-failed', `uom_conversions entries must look like box:12 (positive integer factor) — got "${entry.trim()}".`),
        };
      }
      const target = match[1].trim();
      const factor = Number(match[2]);
      if (!Number.isSafeInteger(factor) || factor < 1 || factor > INT_MAX) {
        return {
          ok: false,
          error: rowError(row.rowNumber, code, 'validation-failed', `uom_conversions factor must be a positive integer of at most ${INT_MAX} (got "${match[2]}").`),
        };
      }
      if (target === '') {
        return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', 'uom_conversions target UoM must not be empty.') };
      }
      if (target === uom) {
        return {
          ok: false,
          error: rowError(row.rowNumber, code, 'validation-failed', `uom_conversions target "${target}" equals the base uom — conversions are relative to it.`),
        };
      }
      if (seenUoms.has(target)) {
        return {
          ok: false,
          error: rowError(row.rowNumber, code, 'validation-failed', `uom_conversions repeats "${target}" within one row.`),
        };
      }
      seenUoms.add(target);
      conversions.push({ uom: target, factor });
    }
  }

  return {
    ok: true,
    row: {
      rowNumber: row.rowNumber,
      code,
      name,
      uom,
      gstRateBps: Number(gstRaw),
      hsn: hsn === '' ? null : hsn,
      batchTracked,
      serialTracked,
      reorderPoint,
      reorderQty,
      barcode: barcode === '' ? null : barcode,
      conversions,
    },
  };
}