import { createHash } from 'node:crypto';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  catalogImportErrors,
  catalogImports,
  idempotencyKeys,
  kitCompositions,
  products,
  reservations,
  skuBarcodes,
  skus,
  stockOnHand,
  uomConversions,
} from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { MAX_SHEET_UPLOAD_BYTES, importTooLarge, readSheet } from '../../shared/import/sheet-reader';
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
// Story 12-2 — the hazard vocabulary validator (the same shape, skipping
// null — the blank cell IS the null verb on this column).
import { assertHazardClass } from '../../shared/primitives/hazard';
// Story 5-3 — the ABC class vocabulary validator (the same shape, skipping
// null — the blank cell IS the null verb on this column).
import { assertAbcClass } from '../../shared/primitives/abc-class';
import {
  AXIS_NAME_MAX,
  PRODUCT_NAME_MAX,
  VARIANT_VALUE_MAX,
  assertVariantValues,
  variantValuesFingerprint,
} from './product.command';
import { MAX_KIT_COMPONENTS, kitEventPayload } from './kit.command';
import { getKitSkuIdsInTx } from './kit.store';
import { ensureSelfClientInTx } from '../clients/ensure-self-client';
// Story 1-4 — the SKU master's shared typed rules (the CSV cell parser stays here).
import {
  BARCODE_MAX as SHARED_BARCODE_MAX,
  HSN_MAX as SHARED_HSN_MAX,
  MAX_GST_RATE_BPS,
  SKU_BARCODES_UNIQUE,
  SKU_CODE_MAX as SHARED_SKU_CODE_MAX,
  SKU_NAME_MAX,
  barcodeRuleDetail,
  duplicateBarcodeProblem,
  shelfLifeDaysDetail,
  validateExtraBarcodes,
  validateLevels,
  type ExtraBarcode,
  type PackLevel,
} from './sku-master';
import { assertClientInTenantInTx, clientLabel, listClientsInTx, assertClientTakesWorkInTx } from '../clients/clients.facade';

export const IMPORT_MODES = ['initial', 'fix'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

/** Import caps (spec 1.4): ≤ 10,000 data rows and ≤ 5 MB per file. */
export const MAX_IMPORT_ROWS = 10_000;
export const MAX_IMPORT_BYTES = MAX_SHEET_UPLOAD_BYTES;

// Story 1-4 — the bounds live in `sku-master.ts` (shared with the create); re-exported here.
export const SKU_CODE_MAX = SHARED_SKU_CODE_MAX;
export const NAME_MAX = SKU_NAME_MAX;
export const UOM_MAX = 32;
export const HSN_MAX = SHARED_HSN_MAX;
export const BARCODE_MAX = SHARED_BARCODE_MAX;
/** GST as basis points: 0–10000 bps (0–100%). */
export const GST_RATE_BPS_MAX = MAX_GST_RATE_BPS;
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
  /**
   * Story 21-2b — the client this run imported for (every SKU it created
   * carries it; a fix-mode re-run inherits it). Optional on the interface
   * because a stored snapshot written before 21-2b (a replay) lacks it.
   */
  readonly clientId?: string | null;
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
  /**
   * Story 21-2b (decision 4) — the ONE client this run's new SKUs belong to.
   * Optional: absent means "the tenant's only client" (its `self` client),
   * which is refused 400 `client-required` once more than one client exists
   * (no default to mis-attribute to), and means "inherit" in fix mode. The
   * controller refuses a non-uuid 400; an unknown id is a 404 behind the
   * replay lookup. The CSV format is unchanged.
   */
  readonly clientId?: string | undefined;
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
  // Story 12-2 — the hazard class (FR-41). A blank cell maps to NULL (the
  // column is nullable — the 12-1 blank→ambient choice was NOT NULL-specific;
  // null = "not hazardous" and carries no rule). The closed-header contract
  // grows again (the 11.3 precedent).
  'hazard_class',
  // Story 5-3 (FR-cycle-count) — the ABC class the count scheduler schedules
  // from (OQ-1). A blank cell maps to NULL (the hazard_class precedent — the
  // column is nullable; null = "not yet classified" and EXCLUDES the SKU
  // from scheduled generation; on-demand still covers its bin). The
  // closed-header contract grows again (the 11.3 precedent).
  'abc_class',
  // Story 1-4 — total shelf life in days from manufacture (blank → null,
  // `^\d+$`, 1–3650), and the SKU's extra barcodes, each naming its level:
  // `case:8901234567890;pallet:8901234567891;each:8900000000001` (split on
  // `;`, then on the FIRST `:`; the level resolves through `resolveUom`; the
  // base uom is an extra base-level barcode, any other level must be in the
  // row's `uom_conversions` cell). The closed-header contract grows again.
  'shelf_life_days',
  'barcodes',
] as const;
const KNOWN_COLUMNS: ReadonlySet<string> = new Set([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

// Story 1-1 (0076) — code and barcode are unique per (tenant, client).
const SKUS_TENANT_CODE = 'skus_tenant_client_code_unique';
const SKUS_TENANT_BARCODE = 'skus_tenant_client_barcode_unique';
// Story 1-4 — `sku_barcodes` is the barcode authority; both indexes are mapped.
const SKU_BARCODES_TENANT_BARCODE = SKU_BARCODES_UNIQUE;
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
  /** Story 12-2 — the hazard class; a blank cell maps to null (the clear verb — the column is nullable). */
  readonly hazardClass: string | null;
  /** Story 5-3 — the ABC class; a blank cell maps to null (null = not yet classified, OQ-1). */
  readonly abcClass: string | null;
  /** Story 1-4 — total shelf life in days; a blank cell → null. */
  readonly shelfLifeDays: number | null;
  /** Story 1-4 — the `barcodes` cell: every non-primary barcode with its level. */
  readonly extraBarcodes: readonly ExtraBarcode[];
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; error: CatalogImportErrorDto };

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
    //
    // Story 21-2b: `clientId` joins the fingerprint ONLY WHEN PRESENT (the
    // 8-1d conditional-key exception, IMPLEMENTATION-GUIDE §4), spread in at
    // a fixed position after `mode`: an import without it hashes
    // byte-for-byte as before, so no in-flight key breaks. Pinned by a
    // golden test in `test/clients.spec.ts`.
    const payloadHash = hashCommandPayload({
      fileSha256: createHash('sha256').update(command.file.buffer).digest('hex'),
      mode: command.mode,
      ...(command.clientId === undefined ? {} : { clientId: command.clientId }),
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
        // Story 1-1: codes are per client, so the latest run is the latest
        // run OF THE SAME CLIENT — the named client's when one is named
        // (another client's later run never hides this client's fix set);
        // the tenant's latest when none is named (it is inherited below).
        let fixSet: ReadonlySet<string> = new Set();
        const latest =
          command.mode === 'fix'
            ? await tx
                .select({ id: catalogImports.id, clientId: catalogImports.clientId })
                .from(catalogImports)
                .where(
                  command.clientId === undefined
                    ? eq(catalogImports.tenantId, command.tenantId)
                    : and(
                        eq(catalogImports.tenantId, command.tenantId),
                        eq(catalogImports.clientId, command.clientId),
                      ),
                )
                .orderBy(desc(catalogImports.createdAt), desc(catalogImports.id))
                .limit(1)
            : [];

        // ── Story 21-2b: the run's client, behind the replay lookup ─────────
        // Decision 3's up-front guards against a mis-attributed SKU (whose
        // client is fixed once it has history): a named client must exist
        // in this tenant (404); a fix-mode re-run INHERITS its original
        // run's client (story 1-1: naming a client selects THAT client's
        // latest run above, so the run and the client always agree); with more
        // than one client and none named, there is no default to fall back
        // to — 400 `client-required`. The `self` client is the default only
        // while it is the tenant's only client.
        if (command.clientId !== undefined) {
          await assertClientInTenantInTx(tx, command.tenantId, command.clientId);
        }
        // The tenant's clients, read ONCE per run: the count rule below and
        // every refusal label (the tenant's own client prints as "<tenant
        // name> (your company)", never `self`) — no per-row query.
        const tenantClients = await listClientsInTx(tx, command.tenantId);
        const labels = new Map(tenantClients.map((client) => [client.id, clientLabel(client)]));
        const label = (id: string): string => labels.get(id) ?? id;
        let clientId: string;
        if (latest[0] !== undefined) {
          clientId = latest[0].clientId;
        } else if (command.clientId !== undefined) {
          clientId = command.clientId;
        } else if (tenantClients.length > 1) {
          throw new ProblemException(
            'client-required',
            400,
            'Choose the client this import is for',
            'This tenant holds more than one client, so a catalog import must name the client its new SKUs belong to (clientId) — there is no default.',
          );
        } else {
          clientId = await ensureSelfClientInTx(tx, command.tenantId);
        }
        // Story 1-2a — the run's client, however it was settled (named, a
        // fix-mode inheritance, or the `self` default), takes no new SKUs
        // once departed: 409 `client-departed`, under FOR KEY SHARE.
        await assertClientTakesWorkInTx(tx, command.tenantId, clientId);

        if (command.mode === 'fix') {
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
          // Story 1-4 (decision 3) — product names are unique PER CLIENT: a
          // row resolves its product within this run's client only.
          const referenced = await tx
            .select({ id: products.id, name: products.name, axes: products.axes })
            .from(products)
            .where(
              and(
                eq(products.tenantId, command.tenantId),
                eq(products.clientId, clientId),
                inArray(products.name, productNames),
              ),
            )
            .for('update');
          for (const row of referenced) productByName.set(row.name, row);
        }
        const referencedIds = [...new Set([...productByName.values()].map((product) => product.id))];
        // Existing attached variants per referenced product, keyed by the
        // stable fingerprint (key-order independent) — one query for the
        // whole file. (Story 1-4: the product is this client's, so its
        // variants are too — the 21-2b `mixed-client` product arm is gone.)
        const tenantVariants = new Map<string, string>();
        if (referencedIds.length > 0) {
          const attached = await tx
            .select({
              productId: skus.productId,
              variantValues: skus.variantValues,
              code: skus.code,
            })
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
                `product "${row.productName}" does not exist for client ${label(clientId)} — import references products, it never creates them. Create the product for this client first.`,
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
        const conflicts = await findClientConflicts(tx, command.tenantId, clientId, valid);
        // Story 1-4 — every code and barcode the file carries (decision 13
        // compares them across rows; a refused row's are included, which can
        // only refuse more, never admit a clash).
        const fileCodes = new Set(valid.map((row) => row.code));
        const fileBarcodes = new Set(
          valid.flatMap((row) => [...(row.barcode === null ? [] : [row.barcode]), ...row.extraBarcodes.map((entry) => entry.barcode)]),
        );

        const insertable: (ValidRow & { productId: string | null })[] = [];
        const seenVariants = new Map<string, number>();
        for (const row of insertableRows) {
          if (seenCodes.has(row.code)) {
            errors.push(rowError(row.rowNumber, row.code, 'duplicate-sku-code', `SKU code "${row.code}" appears twice in this file — row ${seenCodes.get(row.code)} used it first.`));
            continue;
          }
          if (conflicts.codes.has(row.code)) {
            // Story 1-1: codes are unique per (tenant, client) — only THIS
            // run's client's existing SKU is a duplicate; another client may
            // own the same code.
            errors.push(rowError(row.rowNumber, row.code, 'duplicate-sku-code', `SKU code "${row.code}" already exists in this client's catalog (client ${label(clientId)}) — duplicates are rejected, never merged.`));
            continue;
          }
          // Story 1-4 — every barcode of the row (the primary and the
          // `barcodes` cell) against the file's earlier rows and the client's
          // `sku_barcodes` (the one authority), and decision 13: no barcode
          // equals a SKU code of the client or of this file, and no code
          // equals a barcode of either.
          const rowBarcodes = [...(row.barcode === null ? [] : [row.barcode]), ...row.extraBarcodes.map((entry) => entry.barcode)];
          const takenBarcode = rowBarcodes.find((barcode) => seenBarcodes.has(barcode) || conflicts.barcodes.has(barcode));
          if (takenBarcode !== undefined) {
            const conflictingSku = seenBarcodes.get(takenBarcode) ?? conflicts.barcodes.get(takenBarcode)!;
            errors.push(rowError(row.rowNumber, row.code, 'duplicate-barcode', `Barcode "${takenBarcode}" already belongs to SKU "${conflictingSku}".`));
            continue;
          }
          const barcodeAsCode = rowBarcodes.find((barcode) => barcode === row.code || fileCodes.has(barcode) || conflicts.barcodeCodes.has(barcode));
          if (barcodeAsCode !== undefined) {
            errors.push(rowError(row.rowNumber, row.code, 'barcode-is-code', `Barcode "${barcodeAsCode}" equals a SKU code in this client — a barcode may not equal any SKU code.`));
            continue;
          }
          if (fileBarcodes.has(row.code) || conflicts.codeBarcodes.has(row.code)) {
            errors.push(rowError(row.rowNumber, row.code, 'barcode-is-code', `SKU code "${row.code}" equals a barcode in this client — a barcode may not equal any SKU code.`));
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
          for (const barcode of rowBarcodes) seenBarcodes.set(barcode, row.code);
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
          // Story 21-1 (AD-23): every SKU belongs to a client — the source
          // of truth every SKU-referencing row inherits. Story 21-2b: the
          // run's client resolved above (the tenant's `self` client while it
          // is the only one; no mode branch).
          const skuRows = insertable.map((row) => ({
            id: uuidv7(),
            tenantId: command.tenantId,
            clientId,
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
            // Story 12-2 — the hazard class from the cell (blank → null —
            // the column is nullable; the 12-1 NOT NULL verb does not apply).
            hazardClass: row.hazardClass,
            // Story 5-3 — the ABC class from the cell (blank → null; null =
            // not yet classified, excluded from scheduled generation, OQ-1).
            abcClass: row.abcClass,
            // Story 1-4 — total shelf life (blank cell → null).
            shelfLifeDays: row.shelfLifeDays,
          }));
          // Story 1-4 — every SKU's primary `sku_barcodes` row (the generated
          // default included) and the `barcodes` cell's extra rows, in the
          // SKU insert's transaction.
          const barcodeRows = insertable.flatMap((row, i) => [
            {
              id: uuidv7(),
              tenantId: command.tenantId,
              clientId,
              skuId: skuRows[i]!.id,
              barcode: skuRows[i]!.barcode,
              uom: row.uom,
              isPrimary: true,
            },
            ...row.extraBarcodes.map((entry) => ({
              id: uuidv7(),
              tenantId: command.tenantId,
              clientId,
              skuId: skuRows[i]!.id,
              barcode: entry.barcode,
              uom: entry.uom,
              isPrimary: false,
            })),
          ]);
          try {
            for (const chunk of chunked(skuRows)) {
              await tx.insert(skus).values(chunk);
            }
            for (const chunk of chunked(barcodeRows)) {
              await tx.insert(skuBarcodes).values(chunk);
            }
          } catch (err) {
            // A concurrent writer won the race between the pre-check and the
            // insert; the transaction aborts and the retry re-runs the checks.
            if (isUniqueViolationOn(err, SKUS_TENANT_CODE)) {
              throw duplicateSkuCode(insertable[0]!.code);
            }
            if (isUniqueViolationOn(err, SKUS_TENANT_BARCODE) || isUniqueViolationOn(err, SKU_BARCODES_TENANT_BARCODE)) {
              throw duplicateBarcodeProblem(
                'A barcode in this file was taken in this client by a concurrent write — retry the import to see which row.',
              );
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
            // GRN on the same SKUs serializes behind this pass. Story 1-1: a
            // code may be held by several clients, and a kit cell names THIS
            // run's client's SKUs — only those rows are locked.
            const referencedSkuRows = await tx
              .select({ id: skus.id, code: skus.code, uom: skus.uom, clientId: skus.clientId })
              .from(skus)
              .where(
                and(
                  eq(skus.tenantId, command.tenantId),
                  eq(skus.clientId, clientId),
                  inArray(skus.code, referencedCodes),
                ),
              )
              .orderBy(skus.id)
              .for('update');
            const skuRowByCode = new Map<string, (typeof referencedSkuRows)[number]>(
              referencedSkuRows.map((r) => [r.code, r]),
            );
            // An unlocked probe for codes this client does not hold but
            // another does: they keep `mixed-client` (below), never
            // `kit-component-not-found`. Nothing is written to those rows.
            const missingCodes = referencedCodes.filter((code) => !skuRowByCode.has(code));
            if (missingCodes.length > 0) {
              const elsewhere = await tx
                .select({ id: skus.id, code: skus.code, uom: skus.uom, clientId: skus.clientId })
                .from(skus)
                .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.code, missingCodes)))
                .orderBy(skus.clientId);
              for (const r of elsewhere) {
                if (!skuRowByCode.has(r.code)) skuRowByCode.set(r.code, r);
              }
            }
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
                // Story 21-2b — a kit and its components share one client
                // (the kit's is this run's): an existing component of
                // another client is refused per row.
                if (componentRow.clientId !== clientId) {
                  errors.push(rowError(row.rowNumber, row.code, 'mixed-client', `kit_components names component "${component.code}" of client ${label(componentRow.clientId)} — this kit is for client ${label(clientId)}, and a kit's components share its client.`));
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
          // Story 21-2b — the run records its client, so a fix-mode re-run
          // inherits it.
          clientId,
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
          clientId,
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
        // Story 9-3a — the audit row (skeleton step 10).
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'catalog_import.executed',
          targetType: 'catalog_import',
          targetId: importId,
          reference: idempotencyKey,
          occurredAt: nowIso(),
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
    `SKU code "${code}" already exists in this client's catalog — duplicates are rejected, never merged.`,
  );
}

// The file-level refusals (`import-too-large`, `unsupported-file-type`,
// `file-unreadable`) moved to `shared/import/sheet-reader.ts` with the reader
// (the ASN import story) — both spreadsheet imports share one copy.

/**
 * Existing SKUs of THIS run's client colliding with the file's codes and
 * barcodes. Story 1-1: code and barcode are unique per (tenant, client)
 * (`skus_tenant_client_code_unique`, `skus_tenant_client_barcode_unique`), so
 * another client's SKU with the same code or barcode is not a duplicate.
 */
async function findClientConflicts(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  rows: readonly ValidRow[],
): Promise<{
  codes: ReadonlySet<string>;
  barcodes: ReadonlyMap<string, string>;
  /** Story 1-4 — the file's barcodes that equal a SKU code of the client (decision 13). */
  barcodeCodes: ReadonlySet<string>;
  /** Story 1-4 — the file's codes that equal a barcode of the client (decision 13). */
  codeBarcodes: ReadonlySet<string>;
}> {
  const codes = [...new Set(rows.map((row) => row.code))];
  const barcodes = [
    ...new Set(
      rows.flatMap((row) => [...(row.barcode === null ? [] : [row.barcode]), ...row.extraBarcodes.map((entry) => entry.barcode)]),
    ),
  ];
  const codesSet = new Set<string>();
  const barcodesMap = new Map<string, string>();
  const barcodeCodes = new Set<string>();
  const codeBarcodes = new Set<string>();
  if (codes.length > 0) {
    const rowsOut = await tx
      .select({ code: skus.code })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), eq(skus.clientId, clientId), inArray(skus.code, codes)));
    for (const row of rowsOut) codesSet.add(row.code);
    // A code equal to a barcode the client already holds (any level).
    const asBarcodes = await tx
      .select({ barcode: skuBarcodes.barcode })
      .from(skuBarcodes)
      .where(and(eq(skuBarcodes.tenantId, tenantId), eq(skuBarcodes.clientId, clientId), inArray(skuBarcodes.barcode, codes)));
    for (const row of asBarcodes) codeBarcodes.add(row.barcode);
  }
  if (barcodes.length > 0) {
    // Story 1-4 — `sku_barcodes` is the authority (every level, every SKU).
    const rowsOut = await tx
      .select({ code: skus.code, barcode: skuBarcodes.barcode })
      .from(skuBarcodes)
      .innerJoin(skus, eq(skus.id, skuBarcodes.skuId))
      .where(and(eq(skuBarcodes.tenantId, tenantId), eq(skuBarcodes.clientId, clientId), inArray(skuBarcodes.barcode, barcodes)));
    for (const row of rowsOut) barcodesMap.set(row.barcode, row.code);
    const asCodes = await tx
      .select({ code: skus.code })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), eq(skus.clientId, clientId), inArray(skus.code, barcodes)));
    for (const row of asCodes) barcodeCodes.add(row.code);
  }
  return { codes: codesSet, barcodes: barcodesMap, barcodeCodes, codeBarcodes };
}

/**
 * Sheet parsing — the shared reader (`shared/import/sheet-reader.ts`,
 * extracted from this file by the ASN import story) with the catalog's
 * options, which are the reader's defaults: an unknown column refuses the
 * file, the first missing required column is named, rows carry the gap-free
 * 1-based data-row index, and a date cell reads as its UTC ISO instant.
 */
function parseSheetAsync(file: ImportCatalogCommand['file']): Promise<RawRow[]> {
  return readSheet(file, {
    knownColumns: KNOWN_COLUMNS,
    requiredColumns: REQUIRED_COLUMNS,
    maxRows: MAX_IMPORT_ROWS,
  });
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
  // Story 1-4 (decision 12) — the one barcode rule (a blank cell is the
  // generated default, so only a present value is checked).
  if (barcode !== '') {
    const barcodeDetail = barcodeRuleDetail(barcode, 'barcode');
    if (barcodeDetail !== null) {
      return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', barcodeDetail) };
    }
  }
  // Story 1-4 — shelf life: blank → null, digits only, then the shared range.
  const shelfLifeRaw = get('shelf_life_days');
  let shelfLifeDays: number | null = null;
  if (shelfLifeRaw !== '') {
    if (!/^\d+$/.test(shelfLifeRaw)) {
      return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', `shelf_life_days must be a whole number of days (got "${shelfLifeRaw}").`) };
    }
    const shelfDetail = shelfLifeDaysDetail(Number(shelfLifeRaw), 'shelf_life_days');
    if (shelfDetail !== null) {
      return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', shelfDetail) };
    }
    shelfLifeDays = Number(shelfLifeRaw);
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

  // Story 12-2 — the hazard class (FR-41). A blank cell maps to NULL — the
  // column is nullable and null means "not hazardous", the clear verb (the
  // 12-1 blank→ambient choice was NOT NULL-specific). `assertHazardClass`
  // rules on every present value beside the 12-1 validator — a cell outside
  // the controlled vocabulary is a per-row error naming the value, so the
  // rest of the file still commits and `fix` mode can re-submit this row.
  const hazardClassRaw = v['hazard_class']?.trim() ?? '';
  const hazardClass = hazardClassRaw === '' ? null : hazardClassRaw;
  try {
    assertHazardClass({ hazardClass });
  } catch (err) {
    const response = (err as ProblemException).getResponse() as { detail?: string };
    // The shared validator names the command field (`hazardClass`); the CSV
    // caller's column is the snake_case header, so the row error names THAT
    // (the row error is the import user's only view of the refusal).
    return {
      ok: false,
      error: rowError(
        row.rowNumber,
        code,
        'validation-failed',
        response.detail?.replace('hazardClass', 'hazard_class') ?? 'Invalid hazard_class value.',
      ),
    };
  }

  // Story 5-3 (FR-cycle-count) — the ABC class (OQ-1). A blank cell maps to
  // NULL — the column is nullable and null means "not yet classified" (the
  // hazard_class precedent; the 12-1 blank→ambient choice was NOT
  // NULL-specific). `assertAbcClass` rules on every present value beside the
  // validator — a cell outside the controlled vocabulary is a per-row error
  // naming the value, so the rest of the file still commits and `fix` mode
  // can re-submit this row.
  const abcClassRaw = v['abc_class']?.trim() ?? '';
  const abcClass = abcClassRaw === '' ? null : abcClassRaw;
  try {
    assertAbcClass({ abcClass });
  } catch (err) {
    const response = (err as ProblemException).getResponse() as { detail?: string };
    // The shared validator names the command field (`abcClass`); the CSV
    // caller's column is the snake_case header, so the row error names THAT.
    return {
      ok: false,
      error: rowError(
        row.rowNumber,
        code,
        'validation-failed',
        response.detail?.replace('abcClass', 'abc_class') ?? 'Invalid abc_class value.',
      ),
    };
  }

  const conversions: { uom: string; factor: number }[] = [];
  let levels: PackLevel[] = [];
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
      if (!Number.isSafeInteger(factor) || factor > INT_MAX) {
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
    // Story 1-4 (decision 8) — the typed rules (factor 2–1,000,000, the
    // level ≠ base, no repeats) are the shared ones the packaging PUT runs.
    try {
      levels = validateLevels(uom, conversions, 'uom_conversions');
    } catch (err) {
      const response = (err as ProblemException).getResponse() as { detail?: string };
      return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', response.detail ?? 'Invalid uom_conversions.') };
    }
  }

  // Story 1-4 — the `barcodes` cell: split on `;`, each entry on its FIRST
  // `:` (`level:barcode`); blank entries between separators are skipped. The
  // typed rules — the barcode rule, not the row's primary, the level being the
  // base uom or one of this row's `uom_conversions` levels, no repeats — are
  // the shared ones (`validateExtraBarcodes`), their refusal code kept.
  let extraBarcodes: ExtraBarcode[] = [];
  const barcodesRaw = v['barcodes']?.trim() ?? '';
  if (barcodesRaw !== '') {
    const entries: { barcode: string; uom: string }[] = [];
    for (const entry of barcodesRaw.split(';')) {
      const trimmed = entry.trim();
      if (trimmed === '') continue;
      const colon = trimmed.indexOf(':');
      if (colon === -1) {
        return {
          ok: false,
          error: rowError(row.rowNumber, code, 'validation-failed', `barcodes entries must look like case:8901234567890 (level:barcode) — got "${trimmed}".`),
        };
      }
      const level = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      if (resolveUom(level) === null) {
        return { ok: false, error: rowError(row.rowNumber, code, 'validation-failed', unknownUomDetail('barcodes level', level)) };
      }
      entries.push({ barcode: value, uom: level });
    }
    try {
      extraBarcodes = validateExtraBarcodes(uom, levels, barcode, entries, 'barcodes');
    } catch (err) {
      const problem = err as ProblemException;
      const response = problem.getResponse() as { code?: string; detail?: string };
      return { ok: false, error: rowError(row.rowNumber, code, response.code ?? 'validation-failed', response.detail ?? 'Invalid barcodes cell.') };
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
      // Story 12-2 — the parsed hazard class (blank → null — the column is
      // nullable; null is the row's "not hazardous" state).
      hazardClass,
      // Story 5-3 — the parsed ABC class (blank → null; null = excluded
      // from scheduled generation, OQ-1).
      abcClass,
      shelfLifeDays,
      extraBarcodes,
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
