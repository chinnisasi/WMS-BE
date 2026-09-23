import { createHash } from 'node:crypto';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { parse as parseCsv } from 'csv-parse/sync';
import { Workbook, type CellValue } from 'exceljs';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  catalogImportErrors,
  catalogImports,
  idempotencyKeys,
  kitCompositions,
  products,
  reservations,
  skus,
  stockOnHand,
  uomConversions,
} from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
// Constructor param is a type here but must stay a value import: Nest DI needs
// the runtime class token for decorator metadata (eslint rule bends for it).
 
import { TenancyService } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { MAX_QUANTITY_BASE, fromMilli, validateRecordableQuantity } from '../../shared/primitives/quantity';
import {
  isFractionalUom,
  resolveUom,
  serialTrackedFractionalUomDetail,
  unknownUomDetail,
  uomPrecision,
} from './uom';
import { assertSkuAttributes, type SkuAttributeFields } from './sku-attributes';
// Story 12-1 — the one storage-class validator, beside the attributes'.
import { assertStorageClass } from '../../shared/primitives/storage-class';
import {
  AXIS_NAME_MAX,
  PRODUCT_NAME_MAX,
  VARIANT_VALUE_MAX,
  assertVariantValues,
  variantValuesFingerprint,
} from './product.command';
import { MAX_KIT_COMPONENTS, kitEventPayload } from './kit.command';
import { getKitSkuIdsInTx } from './kit.store';

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
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
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
  'catch_weight_tracked',
  'weight_grams',
  'length_mm',
  'width_mm',
  'height_mm',
  'country_of_origin',
  'reorder_point',
  'reorder_qty',
  'barcode',
  // Story 11.3 — the variant columns. The closed-header contract grows
  // again: a CSV carrying these against a pre-11.3 binary would be rejected
  // wholesale, so the header contract and the row parser grow together (the
  // 11.2 precedent). `product` REFERENCES an existing product by NAME —
  // import never creates products (auto-declared axes from the first row's
  // keys would make the product's identity an implicit side effect); a
  // missing name is a per-row error naming it, the uom-vocabulary refusal
  // shape. `variant_values` is the ONE cell (no per-axis CSV columns — the
  // closed-header contract would break): `size=M; colour=Red`, the
  // `uom_conversions` box:12 cell-grammar precedent.
  'product',
  'variant_values',
  // Story 11.6 — the kit column, the last of the optional set. The cell is
  // the `uom_conversions` grammar again (`pad:2;tape:1`), quantities in the
  // COMPONENT's base UoM; the composition resolves AFTER every SKU row has
  // committed, in the same transaction — a component may be an earlier row of
  // this same file — through the kit store's guards (see the post-insert pass
  // in `execute`).
  'kit_components',
  // Story 12-1 — the storage class (FR-40). A blank cell maps to 'ambient'
  // (the DB default — never an explicit null; the NOT NULL column has no
  // clear verb, the attributes' null-clears verb does not apply). The
  // closed-header contract grows again: a CSV carrying this against a
  // pre-12.1 binary is rejected wholesale, so the header contract and the row
  // parser grow together (the 11.3 precedent).
  'storage_class',
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
  readonly catchWeightTracked: boolean;
  /** Story 11.2 — the static physical attributes; a blank cell → null. */
  readonly weightGrams: number | null;
  readonly lengthMm: number | null;
  readonly widthMm: number | null;
  readonly heightMm: number | null;
  readonly countryOfOrigin: string | null;
  readonly reorderPoint: number;
  readonly reorderQty: number;
  /** Null → generated server-side (uuidv7) at insert. */
  readonly barcode: string | null;
  readonly conversions: readonly { readonly uom: string; readonly factor: number }[];
  /** Story 11.3 — the referenced product's NAME, or null (blank cell → no product). */
  readonly productName: string | null;
  /** Story 11.3 — the parsed `variant_values` cell, or null (blank cell → no values). */
  readonly variantValues: Record<string, string> | null;
  /**
   * Story 11.6 — the parsed `kit_components` cell, or null (blank cell → no
   * composition). Shape-only here: each entry's quantity stays a RAW string
   * because the precision it must satisfy is the COMPONENT's unit's — known
   * only once that SKU row is resolved, after every SKU row has committed.
   */
  readonly kitComponents: readonly { readonly code: string; readonly qtyRaw: string }[] | null;
  /** Story 12-1 — the storage class; a blank cell maps to 'ambient', never null. */
  readonly storageClass: string;
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
 *
 * Two resolution passes run after the per-row shape checks, against the
 * tenant: the 11.3 variant pass (products resolved by name BEFORE the SKU
 * insert — a failing row is not committed) and the 11.6 kit pass (compositions
 * resolved by code AFTER the SKU insert — a component may be an earlier row of
 * the same file, so a refused kit cell leaves its SKU row committed and fails
 * as a row error; the SKU row and the failure overlap in the counts. Only the
 * PUT route can retry the composition — fix mode cannot, because the
 * committed SKU is refused `duplicate-sku-code` on resubmit).
 */
@Injectable()
export class ImportCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // forwardRef: tenancy and catalog reference each other (checklist facade
    // ↔ role lookup). The role itself is resolved per request through the
    // TenancyService facade — catalog never reads tenancy tables.
    @Inject(forwardRef(() => TenancyService)) private readonly tenancy: TenancyService,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
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

    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry (Story 1.5): the role is read
        // through the TenancyService facade in this same tenant transaction.
        assertPermission(
          await this.tenancy.getMemberRole(command.tenantId, command.actorUserId, tx),
          'catalog.import',
        );

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

        // ── Story 11.3: resolve the referenced products and run the SAME
        // command-side rules the SKU edit PATCH runs. Per-row errors keep the
        // partial commit honest (the uom-vocabulary refusal shape: the rest
        // of the file still commits and fix mode can re-submit this row).
        // The duplicate-variant rule is enforced across the whole file and
        // the tenant's existing attached SKUs — the same invariants the edit
        // command guards, stated here as row errors.
        const productNames = [
          ...new Set(valid.filter((row) => row.productName !== null).map((row) => row.productName as string)),
        ];
        const productByName = new Map<string, { id: string; name: string; axes: readonly string[] }>();
        if (productNames.length > 0) {
          // `for('update')`: the same serialization the SKU edit command takes
          // — a concurrent ProductCommand.edit must not change a referenced
          // product's axes between this read and the rows' INSERT.
          const referenced = await tx
            .select({ id: products.id, name: products.name, axes: products.axes })
            .from(products)
            .where(and(eq(products.tenantId, command.tenantId), inArray(products.name, productNames)))
            .for('update');
          for (const row of referenced) productByName.set(row.name, row);
        }
        const referencedIds = [...new Set([...productByName.values()].map((product) => product.id))];
        // Existing attached variants per referenced product, keyed by the
        // stable fingerprint (key-order independent) — one query for the
        // whole file.
        const tenantVariants = new Map<string, string>();
        if (referencedIds.length > 0) {
          const attached = await tx
            .select({ productId: skus.productId, variantValues: skus.variantValues, code: skus.code })
            .from(skus)
            .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.productId, referencedIds)));
          for (const row of attached) {
            if (row.productId !== null && row.variantValues !== null) {
              tenantVariants.set(
                `${row.productId}|${variantValuesFingerprint(row.variantValues)}`,
                row.code,
              );
            }
          }
        }
        const insertableRows: (ValidRow & { productId: string | null })[] = [];
        for (const row of valid) {
          if (row.productName === null) {
            insertableRows.push({ ...row, productId: null });
            continue;
          }
          const product = productByName.get(row.productName);
          if (!product) {
            errors.push(
              rowError(
                row.rowNumber,
                row.code,
                'validation-failed',
                `product "${row.productName}" does not exist in this tenant — import references products, it never creates them. Create the product first.`,
              ),
            );
            continue;
          }
          try {
            // The ONE shared validator — a value missing an axis, naming an
            // unknown axis or carrying a blank is refused THERE, naming the
            // axis, exactly as the edit command refuses it.
            assertVariantValues(product.axes, row.variantValues);
          } catch (err) {
            const response = (err as ProblemException).getResponse() as { detail?: string };
            errors.push(rowError(row.rowNumber, row.code, 'validation-failed', response.detail ?? 'Invalid variant values.'));
            continue;
          }
          insertableRows.push({
            ...row,
            productId: product.id,
            variantValues: row.variantValues === null ? null : { ...row.variantValues },
          });
        }

        // Duplicate detection: file-internal first (order of appearance), then
        // the tenant's existing SKUs — one error per row, first failure wins.
        const seenCodes = new Map<string, number>();
        const seenBarcodes = new Map<string, string>();
        const conflicts = await findTenantConflicts(tx, command.tenantId, valid);

        const insertable: (ValidRow & { productId: string | null })[] = [];
        const seenVariants = new Map<string, number>();
        for (const row of insertableRows) {
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
          // Story 11.3 — duplicate variants are refused: a second SKU in one
          // product carrying identical values, within this file (naming the
          // earlier row) or already attached in the tenant (naming that
          // SKU). Same rule the edit command guards with its 409.
          if (row.productId !== null && row.variantValues !== null) {
            const fingerprint = `${row.productId}|${variantValuesFingerprint(row.variantValues)}`;
            const earlier = seenVariants.get(fingerprint);
            if (earlier !== undefined) {
              errors.push(rowError(row.rowNumber, row.code, 'duplicate-variant-values', `Row ${earlier} already claimed these values in product "${row.productName}" — two variants of one product cannot be identical.`));
              continue;
            }
            const existingCode = tenantVariants.get(fingerprint);
            if (existingCode !== undefined) {
              errors.push(rowError(row.rowNumber, row.code, 'duplicate-variant-values', `Product "${row.productName}" already has SKU "${existingCode}" carrying the identical values — two variants of one product cannot be identical.`));
              continue;
            }
            seenVariants.set(fingerprint, row.rowNumber);
          }
          seenCodes.set(row.code, row.rowNumber);
          if (row.barcode !== null) seenBarcodes.set(row.barcode, row.code);
          insertable.push(row);
        }

        // One error per row, reported in document order regardless of which
        // pass produced it (validation failures collect first, duplicates in
        // the loop below). The 11.6 kit pass below collects after this sort
        // and re-sorts before the errors are persisted.
        errors.sort((a, b) => a.rowNumber - b.rowNumber);

        const importId = uuidv7();
        const committedRows = insertable.length;

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
            catchWeightTracked: row.catchWeightTracked,
            weightGrams: row.weightGrams,
            lengthMm: row.lengthMm,
            widthMm: row.widthMm,
            heightMm: row.heightMm,
            countryOfOrigin: row.countryOfOrigin,
            reorderPoint: row.reorderPoint,
            reorderQty: row.reorderQty,
            // Generated server-side at entry (uuidv7) unless the file carries one.
            barcode: row.barcode ?? uuidv7(),
            // Story 11.3 — the variant attachment (null/unset when the row
            // carries no product; the CHECK requires the pairing, which the
            // resolution pass guarantees).
            productId: row.productId,
            variantValues: row.variantValues,
            // Story 12-1 — the class from the cell (blank → 'ambient', the
            // column DEFAULT spelled out; never an explicit null).
            storageClass: row.storageClass,
          }));
          try {
            for (const chunk of chunked(skuRows)) {
              await tx.insert(skus).values(chunk);
            }
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
          for (const chunk of chunked(conversionRows)) {
            await tx.insert(uomConversions).values(chunk);
          }

          // ── Story 11.6: the kit_components resolution pass. It runs AFTER
          // every SKU row above has committed, inside the same transaction —
          // a component may be an earlier row of this same file — through the
          // kit store's guards, the SAME rules the kit create command runs
          // (flat BOM, one level; a kit never holds stock; quantities in the
          // component's base UoM against its declared precision). A refused
          // cell leaves its SKU row committed and fails as a row error; only
          // the PUT route can retry the composition — a fix-mode resubmit of
          // the row is refused `duplicate-sku-code`, the SKU already
          // committing in the earlier run.
          const kitImports = insertable.filter((row) => row.kitComponents !== null);
          if (kitImports.length > 0) {
            // Same index alignment as the conversion rows: insertable's codes
            // are unique (the duplicate checks above), so code → the id this
            // row was inserted under.
            const skuIdByCode = new Map(insertable.map((row, i) => [row.code, skuRows[i]!.id] as const));
            const referencedCodes = [
              ...new Set(kitImports.flatMap((row) => [row.code, ...row.kitComponents!.map((c) => c.code)])),
            ];
            // `for('update')`: the kit command's cycle lock — kit and
            // component rows, ordered by id, so a concurrent KitCommand or
            // GRN on the same SKUs serializes behind this pass.
            const referencedSkuRows = await tx
              .select({ id: skus.id, code: skus.code, uom: skus.uom })
              .from(skus)
              .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.code, referencedCodes)))
              .orderBy(skus.id)
              .for('update');
            const skuRowByCode = new Map(referencedSkuRows.map((r) => [r.code, r]));
            const referencedIds = referencedSkuRows.map((r) => r.id);
            // The one "is a kit" probe, over every referenced id at once: a
            // component that ALREADY carries composition rows is refused, so
            // the flat one-level BOM survives even when the kit rows of this
            // file are inserted afterwards.
            const preexistingKitIds = new Set(await getKitSkuIdsInTx(tx, command.tenantId, referencedIds));
            const inFileKitCodes = new Set(kitImports.map((row) => row.code));
            const kitIds = kitImports.map((row) => skuIdByCode.get(row.code)!);
            // Structurally unreachable for fresh imports (a brand-new SKU has
            // neither stock nor reservations, and the pre-checks above have
            // no gap a concurrent writer could fill under the row locks) —
            // kept as fail-closed bulk checks so the guard set the boundary
            // names is decided here, never assumed.
            const stockKits = new Set(
              (
                await tx
                  .select({ skuId: stockOnHand.skuId })
                  .from(stockOnHand)
                  .where(and(eq(stockOnHand.tenantId, command.tenantId), inArray(stockOnHand.skuId, kitIds), gt(stockOnHand.quantity, 0)))
              ).map((r) => r.skuId),
            );
            const heldKits = new Set(
              (
                await tx
                  .select({ skuId: reservations.skuId })
                  .from(reservations)
                  .where(
                    and(
                      eq(reservations.tenantId, command.tenantId),
                      inArray(reservations.skuId, kitIds),
                      inArray(reservations.state, ['held', 'committed']),
                    ),
                  )
              ).map((r) => r.skuId),
            );

            const compositionRows: { id: string; tenantId: string; kitSkuId: string; componentSkuId: string; qty: number }[] = [];
            // Event parity with KitCommand.create (story 11.4): every kit
            // this pass creates appends `catalog.kit_created` in-transaction,
            // so an outbox consumer sees import-created kits exactly as it
            // sees command-created ones. Refused cells emit nothing.
            const kitEvents: { skuId: string; code: string; components: { skuId: string; code: string; qty: number }[] }[] = [];
            for (const row of kitImports) {
              const kitSkuId = skuIdByCode.get(row.code)!;
              if (stockKits.has(kitSkuId)) {
                errors.push(rowError(row.rowNumber, row.code, 'kit-sku-holds-stock', `SKU "${row.code}" already carries on-hand stock — a kit never holds stock; ship it out and compose afterwards.`));
                continue;
              }
              if (heldKits.has(kitSkuId)) {
                errors.push(rowError(row.rowNumber, row.code, 'kit-sku-holds-stock', `SKU "${row.code}" already carries a live reservation — a kit never holds stock; release it and compose afterwards.`));
                continue;
              }
              if (preexistingKitIds.has(kitSkuId)) {
                errors.push(rowError(row.rowNumber, row.code, 'kit-already-composed', `SKU "${row.code}" already carries a composition — create is the only door into kit-ness; PUT replaces an existing kit's BOM.`));
                continue;
              }
              const composition: { componentSkuId: string; qty: number }[] = [];
              let rowFailed = false;
              for (const component of row.kitComponents!) {
                const componentRow = skuRowByCode.get(component.code);
                if (componentRow === undefined) {
                  errors.push(rowError(row.rowNumber, row.code, 'kit-component-not-found', `kit_components names component "${component.code}" — no SKU with that code exists in this tenant or in this file.`));
                  rowFailed = true;
                  break;
                }
                if (componentRow.id === kitSkuId) {
                  errors.push(rowError(row.rowNumber, row.code, 'kit-self-reference', `kit_components names the row's own SKU "${row.code}" as a component — a kit's BOM cannot name the kit as its own component.`));
                  rowFailed = true;
                  break;
                }
                if (preexistingKitIds.has(componentRow.id) || inFileKitCodes.has(component.code)) {
                  errors.push(rowError(row.rowNumber, row.code, 'kit-component-is-kit', `kit_components names component "${component.code}" which is itself a kit — the BOM is flat, one level; nest nothing.`));
                  rowFailed = true;
                  break;
                }
                // The explosion's rule: the quantity is in the COMPONENT's
                // base UoM and must satisfy that unit's declared precision.
                const checked = validateRecordableQuantity(
                  Number(component.qtyRaw),
                  `kit_components quantity for "${component.code}"`,
                  componentRow.uom,
                  uomPrecision(componentRow.uom),
                  'non-negative',
                );
                if (!checked.ok) {
                  errors.push(
                    checked.arm === 'ceiling'
                      ? rowError(row.rowNumber, row.code, 'validation-failed', `kit_components quantity for "${component.code}" exceeds the quantity ceiling of ${MAX_QUANTITY_BASE}.`)
                      : rowError(row.rowNumber, row.code, 'validation-failed', checked.detail),
                  );
                  rowFailed = true;
                  break;
                }
                composition.push({ componentSkuId: componentRow.id, qty: checked.milli });
              }
              if (!rowFailed) {
                for (const entry of composition) {
                  compositionRows.push({
                    id: uuidv7(),
                    tenantId: command.tenantId,
                    kitSkuId,
                    componentSkuId: entry.componentSkuId,
                    qty: entry.qty,
                  });
                }
                kitEvents.push({
                  skuId: kitSkuId,
                  code: row.code,
                  components: row.kitComponents!.map((component, i) => ({
                    skuId: composition[i]!.componentSkuId,
                    code: component.code,
                    // The event carries base units, the command's convention —
                    // the pass's composition holds milli.
                    qty: fromMilli(composition[i]!.qty),
                  })),
                });
              }
            }
            for (const chunk of chunked(compositionRows)) {
              await tx.insert(kitCompositions).values(chunk);
            }
            for (const kit of kitEvents) {
              await this.outbox.append(tx, {
                messageId: uuidv7(),
                tenantId: command.tenantId,
                type: 'catalog.kit_created',
                occurredAt: nowIso(),
                payload: kitEventPayload({
                  skuId: kit.skuId,
                  code: kit.code,
                  components: kit.components,
                }),
              });
            }
          }
        }

        // The kit pass collected after the earlier sort; one error per row,
        // in document order, is the persisted contract.
        errors.sort((a, b) => a.rowNumber - b.rowNumber);
        const failedRows = errors.length;

        await tx.insert(catalogImports).values({
          id: importId,
          tenantId: command.tenantId,
          mode: command.mode,
          committedRows,
          failedRows,
          skippedRows,
        });
        if (errors.length > 0) {
          for (const chunk of chunked(
            errors.map((error) => ({
              id: uuidv7(),
              tenantId: command.tenantId,
              importId,
              rowNumber: error.rowNumber,
              skuCode: error.skuCode,
              reasonCode: error.code,
              reasonDetail: error.detail,
            })),
          )) {
            await tx.insert(catalogImportErrors).values(chunk);
          }
        }

        const snapshot: CatalogImportResponse = {
          importId,
          mode: command.mode,
          committedRows,
          failedRows,
          skippedRows,
          errors,
        };
        // In-transaction outbox append (AD-7, story outbox-relay) — replaces
        // the old post-commit publish. The `!replayed` gate of the old
        // post-commit publish is structural here: the idempotent replay
        // returned above (and a concurrent duplicate's transaction rolls
        // back whole), so a replayed import appends nothing.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'catalog.imported',
          occurredAt: nowIso(),
          payload: {
            importId: snapshot.importId,
            mode: snapshot.mode,
            committedRows: snapshot.committedRows,
            failedRows: snapshot.failedRows,
            skippedRows: snapshot.skippedRows,
          },
        });
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

/**
 * Bulk inserts are chunked: Postgres binds at most 65,535 parameters per
 * statement, and a cap-admitting file (10,000 rows × 12 sku columns ≈ 120k
 * params, or 10,000 error rows × 7 columns) would exceed it and 500 the whole
 * import despite passing the row cap. 2,000 rows/chunk keeps every statement
 * far below the ceiling.
 */
const INSERT_CHUNK_ROWS = 2_000;

function chunked<T>(rows: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) {
    chunks.push(rows.slice(i, i + INSERT_CHUNK_ROWS));
  }
  return chunks;
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
  // The columns callback sees the raw header row: validate the shared header
  // contract there (unknown, duplicate, and missing-required columns are all
  // 400 file-unreadable — a duplicate would otherwise let the last
  // occurrence's values silently win). The problem is captured rather than
  // thrown so we never depend on how csv-parse propagates callback errors.
  let headerProblem: string | null = null;
  let records: Record<string, string | string[]>[];
  try {
    records = parseCsv(new Uint8Array(buffer), {
      bom: true,
      columns: (header: string[]) => {
        const seen = new Set<string>();
        for (const raw of header) {
          const name = raw.trim().toLowerCase();
          if (name === '') continue;
          if (!KNOWN_COLUMNS.has(name)) {
            headerProblem = `Unknown column "${raw.trim()}" — the header must use the documented column names.`;
            break;
          }
          if (seen.has(name)) {
            headerProblem = `Duplicate column "${name}" in the header row.`;
            break;
          }
          seen.add(name);
        }
        if (headerProblem === null) {
          for (const required of REQUIRED_COLUMNS) {
            if (!seen.has(required)) {
              headerProblem = `Missing required column "${required}" in the header row.`;
              break;
            }
          }
        }
        return header.map((raw) => raw.trim().toLowerCase());
      },
      skip_empty_lines: true,
      relax_column_count: true,
      trim: false,
    });
  } catch (error) {
    throw fileUnreadable(`The CSV could not be parsed: ${(error as Error).message}`);
  }
  if (headerProblem !== null) {
    throw fileUnreadable(headerProblem);
  }
  const rows = records.map((record, index) => {
    // relax_column_count keeps parsing past a row carrying more fields than
    // the header but parks the excess in __parsed_extra — silent data loss;
    // reject instead.
    if (Array.isArray((record as Record<string, unknown>)['__parsed_extra'])) {
      throw fileUnreadable('A data row has more fields than the header — every row must match the documented column set.');
    }
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
  // Only the first sheet would silently win — make the extra sheets a parse
  // failure instead.
  if (workbook.worksheets.length > 1) {
    throw fileUnreadable('The workbook must contain exactly one worksheet — remove the extra sheets and try again.');
  }
  const columns = new Map<number, string>();
  const seenNames = new Set<string>();
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = cellText(cell.value).trim();
    if (header === '') return;
    const name = header.toLowerCase();
    if (!KNOWN_COLUMNS.has(name)) {
      throw fileUnreadable(`Unknown column "${header}" — the header must use the documented column names.`);
    }
    if (seenNames.has(name)) {
      throw fileUnreadable(`Duplicate column "${header}" in the header row — the last occurrence would silently win.`);
    }
    seenNames.add(name);
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

/**
 * Blank-row filtering + the row cap, shared by both formats. Row numbers are
 * renumbered sequentially here so the documented `rowNumber` (1-based
 * data-row index, header excluded) is gap-free and identical across formats:
 * CSV's skip_empty_lines already compresses blanks, while XLSX rows carry
 * sheet-row gaps that would otherwise leak through.
 */
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
  return nonBlank.map((row, index) => ({ rowNumber: index + 1, values: row.values }));
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

/**
 * A non-negative quantity column (`reorder_point`, `reorder_qty`), parsed from
 * the file's BASE units into the domain's MILLI-units — the importer is an API
 * edge like any other (story 10.1). Named for what it now does: it no longer
 * parses an integer, and what it returns is not the number in the cell.
 *
 * An empty cell still means zero.
 *
 * **Story 10.2: a value finer than the row's own unit is a ROW ERROR, not a
 * rounding.** 10.1 rounded here and said so, because nothing in the system
 * could yet ask how precise a kilogram is; the sub-milli case was the worst of
 * it — a reorder point of `0.0004` kg silently became 0, and a zero reorder
 * point is how the catalog says a SKU has none AT ALL. That is a meaning
 * change wearing a rounding's clothes. The unit now declares its precision, so
 * the row is refused naming the unit, the precision and the value, and `fix`
 * mode can re-submit it with a number the unit can actually hold.
 *
 * **Story 10.4: the RULE itself is no longer stated here.** This function used
 * to hand-roll ceiling → precision → convert, a second statement of the
 * write-edge rule `assertRecordableQuantity` already owned. It now delegates
 * to the one core (`validateRecordableQuantity`) — the precision arm's refusal
 * text is byte-identical to the HTTP path's because it is THE SAME TEXT —
 * while the two call shapes keep their differences deliberately: the malformed
 * and over-ceiling arms keep their import-specific sentences, and the SIGN
 * rule is one parameter of the core (import cells are levels and may not be
 * negative; command deltas are signed — though this path's regex rejects a
 * minus sign first, so the core's sign arm is defense in depth here).
 */
function parseQuantityMilli(
  raw: string,
  column: string,
  rowNumber: number,
  uom: string,
  precision: number,
): FieldResult<number> {
  const value = raw.trim();
  if (value === '') return { ok: true, value: 0 };
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return {
      ok: false,
      error: rowError(rowNumber, null, 'validation-failed', `${column} must be a non-negative quantity (got "${value}").`),
    };
  }
  const result = validateRecordableQuantity(Number(value), column, uom, precision, 'non-negative');
  if (result.ok) {
    return { ok: true, value: result.milli };
  }
  // Over-ceiling keeps its import-specific sentence (the row-error context
  // differs from the command path's ProblemException); the precision and
  // vanish arms speak the shared core's text — byte-identical to the HTTP
  // path's precision arm. The sign arm is unreachable behind the regex.
  if (result.arm === 'ceiling') {
    return {
      ok: false,
      error: rowError(rowNumber, null, 'validation-failed', `${column} exceeds the quantity ceiling of ${MAX_QUANTITY_BASE}.`),
    };
  }
  return { ok: false, error: rowError(rowNumber, null, 'validation-failed', result.detail) };
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
  const uomRaw = get('uom');
  if (uomRaw === '') {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', 'uom is required.') };
  }
  if (uomRaw.length > UOM_MAX) {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', `uom must be at most ${UOM_MAX} characters.`) };
  }
  // Story 10.2: `uom` is a CLOSED vocabulary. The file may spell a unit
  // generously — `pcs`, `Kg.`, `kilogram`, ` KG ` — and the alias map resolves
  // every one of them to the single canonical unit the column stores. A
  // spelling the vocabulary does not know is a ROW-level refusal naming it, so
  // the rest of the file still commits and `fix` mode can re-submit this row.
  const uom = resolveUom(uomRaw);
  if (uom === null) {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', unknownUomDetail('uom', uomRaw)) };
  }
  const uomPrecisionPlaces = uomPrecision(uom);
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
  // Story 10.1: a serialized unit is discrete by definition — one ledger event
  // per serial, and four call sites compare a unit count against
  // `serials.length`. A SKU that is BOTH serial-tracked and measured to three
  // decimals is a contradiction, refused once here rather than converted four
  // times downstream.
  if (serialResult.value && isFractionalUom(uom)) {
    return {
      ok: false,
      error: rowError(row.rowNumber, code, 'validation-failed', serialTrackedFractionalUomDetail(uom)),
    };
  }
  const catchWeightResult = parseTracked(
    v['catch_weight_tracked'] ?? '',
    'catch_weight_tracked',
    row.rowNumber,
  );
  if (!catchWeightResult.ok) return { ok: false, error: { ...catchWeightResult.error, skuCode: code } };
  // Story 10.3: catch weight and serial tracking are two per-unit identity
  // systems over ONE physical unit — a serial identified from the ledger, a
  // handling unit identified from its own row — and nothing decides which one
  // a scan at pack is naming. Refused ONCE here at catalog entry, as a ROW
  // error so the rest of the file still commits and `fix` mode can re-submit
  // this row.
  if (catchWeightResult.value && serialResult.value) {
    return {
      ok: false,
      error: rowError(
        row.rowNumber,
        code,
        'validation-failed',
        'catch_weight_tracked and serial_tracked cannot both be true: both claim to identify the same physical unit — a serial from the ledger, a handling unit from its own row — and nothing decides which one a scan names. Pick one.',
      ),
    };
  }
  const pointResult = parseQuantityMilli(v['reorder_point'] ?? '', 'reorder_point', row.rowNumber, uom, uomPrecisionPlaces);
  if (!pointResult.ok) return { ok: false, error: { ...pointResult.error, skuCode: code } };
  const qtyResult = parseQuantityMilli(v['reorder_qty'] ?? '', 'reorder_qty', row.rowNumber, uom, uomPrecisionPlaces);
  if (!qtyResult.ok) return { ok: false, error: { ...qtyResult.error, skuCode: code } };
  const batchTracked = batchResult.value;
  const serialTracked = serialResult.value;
  const catchWeightTracked = catchWeightResult.value;
  const reorderPoint = pointResult.value;
  const reorderQty = qtyResult.value;
  const barcode = get('barcode');
  if (barcode.length > BARCODE_MAX) {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', `barcode must be at most ${BARCODE_MAX} characters.`) };
  }

  // Story 11.2 — the physical attributes. Cells parse to WYSIWYG grams /
  // millimetres (the `handling_units.weightGrams` precedent, extended to mm):
  // a blank cell → null (unset, the same shape an edit's `null` reads back),
  // and the ONE shared validator (`assertSkuAttributes`) rules on every
  // present value — a zero, negative-shaped, fractional or over-cap number,
  // or a non-alpha-2 origin, is a per-row error naming the field, so the rest
  // of the file still commits and `fix` mode can re-submit this row.
  const countryRaw = get('country_of_origin');
  const weightResult = parseAttributeNumber(v['weight_grams'], 'weight_grams', row.rowNumber);
  if (!weightResult.ok) return { ok: false, error: { ...weightResult.error, skuCode: code } };
  const lengthResult = parseAttributeNumber(v['length_mm'], 'length_mm', row.rowNumber);
  if (!lengthResult.ok) return { ok: false, error: { ...lengthResult.error, skuCode: code } };
  const widthResult = parseAttributeNumber(v['width_mm'], 'width_mm', row.rowNumber);
  if (!widthResult.ok) return { ok: false, error: { ...widthResult.error, skuCode: code } };
  const heightResult = parseAttributeNumber(v['height_mm'], 'height_mm', row.rowNumber);
  if (!heightResult.ok) return { ok: false, error: { ...heightResult.error, skuCode: code } };
  const attributes: SkuAttributeFields = {
    weightGrams: weightResult.value,
    lengthMm: lengthResult.value,
    widthMm: widthResult.value,
    heightMm: heightResult.value,
    countryOfOrigin: countryRaw === '' ? null : countryRaw,
  };
  try {
    assertSkuAttributes(attributes);
  } catch (err) {
    // The validator's detail names the field, the unit and the value it
    // refused — rendered verbatim into the row error.
    const response = (err as ProblemException).getResponse() as { detail?: string };
    return {
      ok: false,
      error: rowError(row.rowNumber, code, 'validation-failed', response.detail ?? 'Invalid physical attribute value.'),
    };
  }

  // Story 12-1 — the storage class (FR-40). A blank cell maps to 'ambient'
  // (the column DEFAULT — never an explicit null; the NOT NULL column has no
  // clear verb, so the attributes' null-clears verb does not apply here).
  // `assertStorageClass` rules on every present value beside the attributes'
  // validator — a cell outside the controlled vocabulary is a per-row error
  // naming the value, so the rest of the file still commits and `fix` mode
  // can re-submit this row.
  const storageClassRaw = v['storage_class']?.trim() ?? '';
  const storageClass = storageClassRaw === '' ? 'ambient' : storageClassRaw;
  try {
    assertStorageClass({ storageClass });
  } catch (err) {
    const response = (err as ProblemException).getResponse() as { detail?: string };
    // The shared validator names the command field (`storageClass`); the CSV
    // caller's column is the snake_case header, so the row error names THAT
    // (the row error is the import user's only view of the refusal).
    return {
      ok: false,
      error: rowError(
        row.rowNumber,
        code,
        'validation-failed',
        response.detail?.replace('storageClass', 'storage_class') ?? 'Invalid storage_class value.',
      ),
    };
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
      const targetRaw = match[1].trim();
      const factor = Number(match[2]);
      if (!Number.isSafeInteger(factor) || factor < 1 || factor > INT_MAX) {
        return {
          ok: false,
          error: rowError(row.rowNumber, code, 'validation-failed', `uom_conversions factor must be a positive integer of at most ${INT_MAX} (got "${match[2]}").`),
        };
      }
      if (targetRaw === '') {
        return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', 'uom_conversions target UoM must not be empty.') };
      }
      // Story 10.2: the conversion target is the same closed vocabulary the
      // base unit comes from — `uom_conversions_uom_check` is the DB backstop,
      // and resolving here is what makes `box:12` and `boxes:12` one row
      // rather than two.
      const target = resolveUom(targetRaw);
      if (target === null) {
        return {
          ok: false,
          error: rowError(row.rowNumber, code, 'validation-failed', unknownUomDetail('uom_conversions target', targetRaw)),
        };
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

  // Story 11.3 — the variant columns, shape-only. `product` is an existing
  // product's NAME (import references, never creates — auto-declaring axes
  // from the first row's keys would make the product's identity an implicit
  // side effect of the first CSV row); the tenant read that resolves it runs
  // later, alongside the duplicate checks. A values cell without a product
  // is refused HERE (values ride the product); a product cell without values
  // fails the shared validator in that later pass — `variantValues must be
  // an object keyed by the product's axes` (it names no axis).
  const productNameRaw = get('product');
  if (productNameRaw.length > PRODUCT_NAME_MAX) {
    return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', `product must be at most ${PRODUCT_NAME_MAX} characters.`) };
  }
  let parsedValues: Record<string, string> | null = null;
  const valuesRaw = v['variant_values']?.trim() ?? '';
  if (valuesRaw !== '') {
    if (productNameRaw === '') {
      return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', 'variant_values cannot be set without the product column — values ride the product.') };
    }
    const parsed = parseVariantValuesCell(valuesRaw, row.rowNumber);
    if (!parsed.ok) return { ok: false, error: { ...parsed.error, skuCode: code } };
    parsedValues = parsed.value;
  }

  // Story 11.6 — the kit column, shape-only. The grammar is the
  // `uom_conversions` precedent; each quantity stays a RAW string here
  // because the precision it must satisfy is the COMPONENT's unit's —
  // known only once every SKU row has committed (the resolution pass in
  // `execute` decides those, as row errors).
  const kitComponentsParsed = parseKitComponentsCell(v['kit_components']?.trim() ?? '', row.rowNumber);
  if (!kitComponentsParsed.ok) return { ok: false, error: { ...kitComponentsParsed.error, skuCode: code } };

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
      catchWeightTracked,
      weightGrams: attributes.weightGrams ?? null,
      lengthMm: attributes.lengthMm ?? null,
      widthMm: attributes.widthMm ?? null,
      heightMm: attributes.heightMm ?? null,
      countryOfOrigin: attributes.countryOfOrigin ?? null,
      reorderPoint,
      reorderQty,
      barcode: barcode === '' ? null : barcode,
      conversions,
      // Story 11.3 — the product reference and the parsed values cell. The
      // coverage rules run later (they need the referenced product's axes,
      // a tenant read); shape-only errors refuse here.
      productName: productNameRaw === '' ? null : productNameRaw,
      variantValues: parsedValues,
      kitComponents: kitComponentsParsed.value,
      // Story 12-1 — the parsed class (blank → 'ambient', never null).
      storageClass,
    },
  };
}

/**
 * One `variant_values` cell, the `uom_conversions` cell-grammar precedent
 * (`box:12` → `size=M; colour=Red`): split on `;`, each entry `axis=value`
 * split on the FIRST `=`, both sides trimmed. Blank entries between `;`s are
 * skipped (trailing separators), but an entry with no `=`, an empty axis or
 * an empty value is a row error naming the cell. A value over
 * `VARIANT_VALUE_MAX` is refused HERE naming the CSV column; the axis
 * coverage against the referenced product's axes is the command-side rule
 * (`assertVariantValues`), run once the product row is in hand.
 */
function parseVariantValuesCell(raw: string, rowNumber: number): FieldResult<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      return {
        ok: false,
        error: rowError(rowNumber, null, 'validation-failed', `variant_values entries must look like size=M (axis=value) — got "${trimmed}".`),
      };
    }
    const axis = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (axis === '') {
      return { ok: false, error: rowError(rowNumber, null, 'validation-failed', `variant_values carries an entry with an empty axis — got "${trimmed}".`) };
    }
    if (axis.length > AXIS_NAME_MAX) {
      return { ok: false, error: rowError(rowNumber, null, 'validation-failed', `variant_values axis "${axis}" exceeds the ${AXIS_NAME_MAX}-character axis-name cap.`) };
    }
    if (value === '') {
      return { ok: false, error: rowError(rowNumber, null, 'validation-failed', `variant_values carries an empty value for axis "${axis}".`) };
    }
    if (value.length > VARIANT_VALUE_MAX) {
      return { ok: false, error: rowError(rowNumber, null, 'validation-failed', `variant_values value for axis "${axis}" exceeds ${VARIANT_VALUE_MAX} characters.`) };
    }
    if (axis in values) {
      return { ok: false, error: rowError(rowNumber, null, 'validation-failed', `variant_values repeats the axis "${axis}" within one cell.`) };
    }
    values[axis] = value;
  }
  return { ok: true, value: values };
}

/**
 * One `kit_components` cell (Story 11.6), the `uom_conversions` cell-grammar
 * precedent again (`pad:2;tape:1`): split on `;`, each entry split on the
 * FIRST `:`, both sides trimmed. Blank entries between `;`s are skipped
 * (trailing separators); a cell of nothing but separators is the empty-kit
 * arm, not a silent pass. Shape-only, exactly like the variant cell: the
 * component CODE is checked for existence (and kit-ness, self-reference,
 * stock) against the tenant and this file in the resolution pass after every
 * SKU row has committed, and each quantity — kept here as a RAW string — is
 * parsed to milli against the COMPONENT's declared precision there too. What
 * IS refused here: an entry without a colon, an empty code, an over-long
 * code, a non-positive or non-numeric quantity, a repeated component (the
 * BOM is a set), and more components than a kit may carry.
 */
function parseKitComponentsCell(
  raw: string,
  rowNumber: number,
): FieldResult<readonly { readonly code: string; readonly qtyRaw: string }[] | null> {
  if (raw === '') return { ok: true, value: null };
  const components: { code: string; qtyRaw: string }[] = [];
  const seenCodes = new Set<string>();
  let empty = true;
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    empty = false;
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      return {
        ok: false,
        error: rowError(
          rowNumber,
          null,
          'validation-failed',
          `kit_components entries must look like code:qty (component code and a positive quantity) — got "${trimmed}".`,
        ),
      };
    }
    const code = trimmed.slice(0, colon).trim();
    const qtyRaw = trimmed.slice(colon + 1).trim();
    if (code === '') {
      return { ok: false, error: rowError(rowNumber, null, 'validation-failed', 'kit_components carries an entry with an empty component code.') };
    }
    if (code.length > SKU_CODE_MAX) {
      return { ok: false, error: rowError(rowNumber, null, 'validation-failed', `kit_components component code exceeds the ${SKU_CODE_MAX}-character SKU-code cap.`) };
    }
    if (!/^\d+(\.\d+)?$/.test(qtyRaw) || Number(qtyRaw) <= 0) {
      return { ok: false, error: rowError(rowNumber, null, 'validation-failed', `kit_components quantity for "${code}" must be a positive quantity (got "${qtyRaw}").`) };
    }
    if (seenCodes.has(code)) {
      return { ok: false, error: rowError(rowNumber, null, 'duplicate-kit-component', `kit_components names component "${code}" twice in one cell — the BOM is a set.`) };
    }
    seenCodes.add(code);
    components.push({ code, qtyRaw });
  }
  if (empty) {
    return { ok: false, error: rowError(rowNumber, null, 'empty-kit-composition', 'kit_components names no component — a kit carries at least one.') };
  }
  if (components.length > MAX_KIT_COMPONENTS) {
    return { ok: false, error: rowError(rowNumber, null, 'validation-failed', `kit_components carries ${components.length} components — a kit carries at most ${MAX_KIT_COMPONENTS}.`) };
  }
  return { ok: true, value: components };
}

/**
 * One physical-attribute cell (`weight_grams`, `length_mm`, `width_mm`,
 * `height_mm`): a blank cell is `null` (unset); anything present must be a
 * positive decimal-literal shape — the same grammar `parseQuantityMilli`
 * admits — and the value/range rules are the shared validator's, downstream.
 * A minus sign or a non-numeric spelling is refused here naming the CSV
 * column; a fraction or an over-cap value reaches `assertSkuAttributes` and
 * is refused there naming the API field.
 */
function parseAttributeNumber(raw: string | undefined, column: string, rowNumber: number): FieldResult<number | null> {
  const value = (raw ?? '').trim();
  if (value === '') return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return {
      ok: false,
      error: rowError(rowNumber, null, 'validation-failed', `${column} must be a positive whole number (got "${value}").`),
    };
  }
  return { ok: true, value: Number(value) };
}
