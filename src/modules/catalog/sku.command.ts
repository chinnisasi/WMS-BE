import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  bins,
  idempotencyKeys,
  overReceipts,
  products,
  skuBarcodes,
  skus,
  stockAdjustmentPendings,
  stockOnHand,
  SKU_STATUSES,
  type SkuStatus,
} from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { buildPage, decodeCursor, type Page } from '../../shared/primitives/pagination';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
// Constructor param is a type here but must stay a value import: Nest DI needs
// the runtime class token for decorator metadata (eslint rule bends for it).
 
import { TenancyService } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { assertRecordableQuantity, fromMilli } from '../../shared/primitives/quantity';
import { isFractionalUom, resolveUom, serialTrackedFractionalUomDetail, unknownUomDetail, uomPrecision } from './uom';
import { countLiveHandlingUnitsInTx } from './handling-unit.store';
import { assertSkuAttributes } from './sku-attributes';
// Story 12-1 — the vocabulary validator + the class-edit refusal factory,
// shared with tenancy and the putaway/pick gates; `stockOnHand` joins the
// SKU-side class-edit guard, `openQcHoldsForSkuInTx` attributes held stock
// to its origin bins (the same seam tenancy's bin guard uses).
import {
  assertStorageClass,
  storageClassConflict,
  storageClassSatisfies,
} from '../../shared/primitives/storage-class';
// Story 12-2 — the hazard vocabulary validator; the co-location read is
// imported from putaway (the tenancy merge gate's `binBlocked` precedent).
import { assertHazardClass } from '../../shared/primitives/hazard';
// Story 1-6b — the goods-type segregation predicate the edit guard walks
// (`conflictKeys` — refuse only what the edit makes worse) and its refusal.
import {
  conflictFacts,
  goodsStateConflict,
  isEmptyProfile,
  newGoodsConflict,
  profileOf,
  sameProfile,
  type GoodsSegregationRule,
  type SegregationProfile,
} from '../../shared/primitives/segregation';
// Story 5-3 — the ABC class vocabulary validator (the hazard shape).
import { assertAbcClass } from '../../shared/primitives/abc-class';
// Story 1-6a — the goods-type rule set (canonicalisation, the pairing rules,
// the DG → hazard derivation).
import {
  DEFAULT_GOODS_TYPE,
  assertGoodsType,
  canonicalGoodsType,
  mergeGoodsType,
  presentGoodsTypeKeys,
  resolveHazardClass,
  type GoodsTypeFields,
  type GoodsTypeInput,
} from '../../shared/primitives/goods-type';
import { binOccupantHazardPairsInTx } from '../putaway/putaway.command';
import { openQcHoldsForSkuInTx } from '../inbound/qc.command';
import {
  assertVariantValues,
  normalizeVariantValues,
  productNotFound,
} from './product.command';
import {
  assertClientInTenantInTx,
  assertClientTakesWorkInTx,
  listClientsInTx,
} from '../clients/clients.facade';
import { ensureSelfClientInTx } from '../clients/ensure-self-client';
// Story 1-4 — the SKU master's shared rules and barcode writers.
import {
  HSN_MAX,
  SKU_BARCODES_UNIQUE,
  SKU_CODE_MAX,
  SKU_NAME_MAX,
  assertGstRateBps,
  SKUS_BARCODE_UNIQUE,
  assertBarcodeRule,
  assertBarcodesFreeInTx,
  assertShelfLifeDays,
  barcodeIsCode,
  duplicateBarcodeProblem,
  readPackagingInTx,
  replacePackagingInTx,
  sortBarcodes,
  sortLevels,
  validateExtraBarcodes,
  validateLevels,
  writePrimaryBarcodeInTx,
  type SkuBarcodeView,
} from './sku-master';

export const DEFAULT_SKU_PAGE_SIZE = 50;
export const MAX_SKU_PAGE_SIZE = 200;
// Story 1-1 (0076) — a barcode is unique per (tenant, client). Story 1-4:
// `sku_barcodes` is the uniqueness authority; this index stays a backstop and
// every 23505 handler maps both (`isBarcodeViolation`).
export const SKUS_TENANT_BARCODE = SKUS_BARCODE_UNIQUE;
const SKUS_TENANT_CODE = 'skus_tenant_client_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** The API response body for a SKU (idempotency snapshot + list item). */
export interface SkuSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  /**
   * Story 21-2b — the client this SKU belongs to. Optional and nullable on
   * the interface because a stored edit snapshot written before 21-2b (a
   * replay) lacks it; `toSnapshot` always sets it.
   */
  readonly clientId?: string | null;
  readonly uom: string;
  /**
   * Story 10.5: the decimal places `uom` declares, on the web-facing read
   * shape too (the device snapshot has carried it since 10.2). The web
   * renders quantities at declared precision and sizes decimal inputs from
   * it — the same reason the device has it: the server's precision refusal
   * is the authority, but a client that cannot read the precision cannot
   * even render at it.
   *
   * Derived in process from the vocabulary, never an input, never a column:
   * there is no per-SKU precision.
   */
  readonly uomPrecision: number;
  readonly gstRateBps: number;
  readonly hsn: string | null;
  readonly batchTracked: boolean;
  readonly serialTracked: boolean;
  /** Story 10.3 — handled by unit, priced by weight (`handling_units`). */
  readonly catchWeightTracked: boolean;
  /**
   * Story 11.2 — the static physical attributes (FR-36), WYSIWYG in grams
   * and millimetres (`sku-attributes.ts`). Absent attributes read `null`;
   * the static catalog weight is NOT Epic 10's per-unit catch weight.
   */
  readonly weightGrams: number | null;
  readonly lengthMm: number | null;
  readonly widthMm: number | null;
  readonly heightMm: number | null;
  readonly countryOfOrigin: string | null;
  /**
   * Story 11.3 — the product this SKU is a variant of (AD-19), null on an
   * unattached SKU. Read-only here: attach/detach happens through `edit`'s
   * optional `productId` PATCH field — no second write path.
   */
  readonly productId: string | null;
  /** This SKU's values on the product's axes; null when unattached. */
  readonly variantValues: Record<string, string> | null;
  /** Story 12-1 — the controlled-vocabulary storage class (FR-40). */
  readonly storageClass: string;
  /**
   * Story 12-2 — the controlled-vocabulary hazard class (FR-41), REQUIRED on
   * the interface and nullable: toSnapshot always sets it (`row.hazardClass
   * ?? null` — every pre-12.2 row and every import row without the cell read
   * null), and the replay serve point's normalizer pins the required
   * response field for legacy snapshots the same way.
   */
  readonly hazardClass: string | null;
  /**
   * Story 5-3 — the controlled-vocabulary ABC class (FR-cycle-count),
   * REQUIRED on the interface and nullable (the `hazardClass` twin):
   * toSnapshot always sets it (`row.abcClass ?? null` — every pre-5.3 row
   * and every import row without the cell reads null = "not yet
   * classified", OQ-1), and the replay serve point's normalizer pins the
   * required response field for legacy snapshots the same way.
   */
  readonly abcClass: string | null;
  readonly reorderPoint: number;
  readonly reorderQty: number;
  readonly barcode: string;
  /**
   * Story 1-4 — the SKU's pack levels (box, case, pallet …): one unit of
   * `uom` = `factor` base units. Sorted by uom.
   */
  readonly uomConversions: readonly { readonly uom: string; readonly factor: number }[];
  /**
   * Story 1-4 — total shelf life in days from manufacture, null when unset.
   * A replay of a pre-1.4 stored response serves `?? null`.
   */
  readonly shelfLifeDays: number | null;
  /**
   * Story 1-4 — every barcode of the SKU with its level: the primary first,
   * then (uom, barcode). A replay of a pre-1.4 stored response serves `?? []`.
   */
  readonly barcodes: readonly SkuBarcodeView[];
  /**
   * Story 1-4b — `active | inactive`. A replay of a pre-1.4b stored response
   * serves `?? 'active'` (`normalizeStoredSku`).
   */
  readonly status: SkuStatus;
  /** Story 1-4b — the deactivation reason, null unless inactive (and optional then). */
  readonly inactiveReason: string | null;
  /**
   * Story 1-6a — the goods-type attributes (`goods-type.ts`). A replay of a
   * pre-1-6a stored response serves `[]`, `null` and `false`
   * (`normalizeStoredSku`).
   */
  readonly drugSchedules: readonly string[];
  readonly foodCategory: string | null;
  readonly allergens: readonly string[];
  readonly dgUnNumber: string | null;
  readonly dgClass: string | null;
  readonly dgSubsidiaryClasses: readonly string[];
  readonly dgPackingGroup: string | null;
  readonly highValue: boolean;
  readonly fragile: boolean;
  readonly maxStackLayers: number | null;
  readonly createdAt: string;
}

/**
 * Story 1-4 — a pre-1.4 stored SKU response lacks the 1-4 fields (and the
 * 12-1/12-2/5-3 normalizers pin theirs): the edit replay and the client
 * correction's replay both serve through this.
 */
export function normalizeStoredSku(stored: SkuSnapshot): SkuSnapshot {
  const legacy = stored as SkuSnapshot & {
    storageClass?: string;
    hazardClass?: string | null;
    abcClass?: string | null;
    shelfLifeDays?: number | null;
    barcodes?: readonly SkuBarcodeView[];
    status?: SkuStatus;
    inactiveReason?: string | null;
  } & Partial<GoodsTypeFields>;
  return {
    ...legacy,
    storageClass: legacy.storageClass ?? 'ambient',
    hazardClass: legacy.hazardClass ?? null,
    abcClass: legacy.abcClass ?? null,
    shelfLifeDays: legacy.shelfLifeDays ?? null,
    barcodes: legacy.barcodes ?? [],
    // Story 1-4b — every SKU stored before 1-4b was active.
    status: legacy.status ?? 'active',
    inactiveReason: legacy.inactiveReason ?? null,
    // Story 1-6a — every SKU stored before 1-6a carried no goods-type data.
    drugSchedules: legacy.drugSchedules ?? DEFAULT_GOODS_TYPE.drugSchedules,
    foodCategory: legacy.foodCategory ?? null,
    allergens: legacy.allergens ?? DEFAULT_GOODS_TYPE.allergens,
    dgUnNumber: legacy.dgUnNumber ?? null,
    dgClass: legacy.dgClass ?? null,
    dgSubsidiaryClasses: legacy.dgSubsidiaryClasses ?? DEFAULT_GOODS_TYPE.dgSubsidiaryClasses,
    dgPackingGroup: legacy.dgPackingGroup ?? null,
    highValue: legacy.highValue ?? false,
    fragile: legacy.fragile ?? false,
    maxStackLayers: legacy.maxStackLayers ?? null,
  };
}

/** Story 1-4 — the create's and the packaging PUT's response (and idempotency snapshot). */
export interface SkuWriteSnapshot {
  readonly sku: SkuSnapshot;
}

/** Story 1-4 — one pack level as a command receives it (uom spelled as sent). */
export interface PackLevelInput {
  readonly uom: string;
  readonly factor: number;
}

/** Story 1-4 — one non-primary barcode as a command receives it. */
export interface ExtraBarcodeInput {
  readonly barcode: string;
  readonly uom: string;
}

/**
 * Story 1-4 — `POST …/catalog/skus`: one import row's worth of fields, typed.
 * Story 1-6a — plus the goods-type fields (`GoodsTypeInput`: absent = the
 * default).
 */
export interface CreateSkuCommand extends GoodsTypeInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly code: string;
  readonly name: string;
  readonly uom: string;
  readonly gstRateBps: number;
  readonly hsn?: string | undefined;
  readonly barcode?: string | undefined;
  readonly batchTracked: boolean;
  readonly serialTracked: boolean;
  readonly catchWeightTracked: boolean;
  readonly weightGrams?: number | undefined;
  readonly lengthMm?: number | undefined;
  readonly widthMm?: number | undefined;
  readonly heightMm?: number | undefined;
  readonly countryOfOrigin?: string | undefined;
  readonly storageClass?: string | undefined;
  /**
   * Story 1-6a — `null` is explicit none (DG class 8's third choice);
   * absent lets a mapped DG class derive it. Both hash as `null` (the
   * pre-1-6a key shape): wherever both commit they leave the same class —
   * absent with class 8 is refused, null with a mapped class is refused.
   */
  readonly hazardClass?: string | null | undefined;
  readonly abcClass?: string | undefined;
  readonly reorderPoint?: number | undefined;
  readonly reorderQty?: number | undefined;
  readonly shelfLifeDays?: number | undefined;
  readonly clientId?: string | undefined;
  readonly levels?: readonly PackLevelInput[] | undefined;
  readonly barcodes?: readonly ExtraBarcodeInput[] | undefined;
}

/** Story 1-4b — the deactivation reason's limit, in code points (decision 14). */
export const SKU_INACTIVE_REASON_MAX = 500;

/** Story 1-4b — `PATCH …/catalog/skus/{skuId}/status`. */
export interface UpdateSkuStatusCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly skuId: string;
  readonly status: string;
  /** Optional; trimmed in the command, blank = absent. Only with `inactive`. */
  readonly reason?: string | null | undefined;
}

/** Story 1-4 — `PUT …/catalog/skus/{skuId}/packaging`. */
export interface ReplacePackagingCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly skuId: string;
  readonly levels: readonly PackLevelInput[];
  /** Every NON-primary barcode the SKU should carry afterwards. */
  readonly barcodes: readonly ExtraBarcodeInput[];
}

export interface EditSkuCommand extends GoodsTypeInput {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly skuId: string;
  readonly name?: string | undefined;
  readonly gstRateBps?: number | undefined;
  readonly hsn?: string | null | undefined;
  readonly batchTracked?: boolean | undefined;
  readonly serialTracked?: boolean | undefined;
  /** Story 10.3 — catch weight. Mutually exclusive with `serialTracked`. */
  readonly catchWeightTracked?: boolean | undefined;
  /**
   * Story 11.2 — the static physical attributes, WYSIWYG grams/millimetres.
   * PATCH semantics follow the `hsn` precedent: absent = unchanged, `null` =
   * cleared. Bounds live in `assertSkuAttributes` (`sku-attributes.ts`),
   * enforced HERE behind the replay lookup — not at the DTO, which only
   * mirrors them.
   */
  readonly weightGrams?: number | null | undefined;
  readonly lengthMm?: number | null | undefined;
  readonly widthMm?: number | null | undefined;
  readonly heightMm?: number | null | undefined;
  readonly countryOfOrigin?: string | null | undefined;
  /**
   * Story 10.2: both are in the operator-facing BASE UoM, not milli-units.
   * The controller used to scale them, which put the precision refusal in
   * front of the replay lookup; the conversion now happens inside `edit`,
   * after the SKU row (and therefore its unit) has been read.
   */
  readonly reorderPoint?: number | undefined;
  readonly reorderQty?: number | undefined;
  readonly barcode?: string | undefined;
  /**
   * Story 11.3 — attach to a product, or detach. The `hsn` template again:
   * absent = unchanged, `null` = detach (variantValues cleared with it), a
   * uuid = attach (and `variantValues` must then cover that product's axes
   * EXACTLY). No second write path — the SKU edit PATCH is the only way a
   * SKU becomes a variant.
   */
  readonly productId?: string | null | undefined;
  /**
   * Story 11.3 — the SKU's axis values, required (with the coverage rules of
   * `assertVariantValues`) whenever a product is being attached or the
   * attached product's values change. A bare `variantValues` with no
   * attached product is a 400 — values ride the product.
   */
  readonly variantValues?: Record<string, unknown> | null | undefined;
  /**
   * Story 12-1 — the SKU's storage class (FR-40), PATCH semantics: absent =
   * unchanged; there is NO null/clear verb (the column is NOT NULL — a SKU
   * always carries a class). A class CHANGE runs the stock-conformance guard
   * behind the replay (409 `storage-class-conflict`): the SKU's on-hand
   * stock tenant-wide (in non-system bins — staging is excluded) and its
   * open-QC-hold quantities (attributed to their origin bins) must all
   * satisfy the new class, or the edit strands non-conforming stock. The
   * class-changing arm takes the SKU row `.for('update')` — which serializes
   * against the other SKU-row lockers (the +stock writers, fix-a2) but NOT
   * against placement/pick, which read the SKU unlocked; the residual race is
   * the recorded 12-1 currency (PENDING.md, putaway:57).
   */
  readonly storageClass?: string | undefined;
  /**
   * Story 12-2 — the SKU's hazard class (FR-41), PATCH semantics: absent =
   * unchanged; **null = clear** (the 11.2 attribute template — unlike
   * `storageClass` the column is nullable, so there IS a clear verb and no
   * explicit-null 400). A class CHANGE runs the co-location guard behind the
   * replay (409 `hazard-segregation-conflict`): every non-system bin where
   * the SKU holds stock, tenant-wide, must hold no binmate incompatible with
   * the new class — and the open-QC-hold quantities are attributed to their
   * ORIGIN bins (a later release would return those units there). The
   * hazard-changing arm takes the SKU row `.for('update')` — which
   * serializes against the other SKU-row lockers (the +stock writers,
   * fix-a2) but NOT against placement/pick, which read the SKU unlocked; the
   * residual race is the recorded 12-1/12-2 currency (PENDING.md,
   * putaway:57-58). Clearing the class always succeeds — null carries no
   * rule in either direction.
   */
  readonly hazardClass?: string | null | undefined;
  /**
   * Story 5-3 — the ABC class counts as a field for the empty-patch
   * refusal, exactly as every other PATCH field does. Absent = unchanged,
   * null = clear (the `hazardClass` twin — the column is nullable, the
   * clear verb exists: an un-classified SKU is excluded from scheduled
   * generation, OQ-1). A present value is vocabulary-checked beside the
   * other class validators.
   */
  readonly abcClass?: string | null | undefined;
  /**
   * Story 1-4 — total shelf life in days from manufacture (1–3650). Absent =
   * unchanged, null = clear. Joins the hash only when present (the spread).
   */
  readonly shelfLifeDays?: number | null | undefined;
}

/**
 * SKU list, create, edit and packaging. Story 1-4 adds the single-SKU create
 * (`create` — the import's typed rules through `sku-master.ts`) and the
 * packaging PUT (`replacePackaging` — pack levels and the non-primary
 * barcodes). The list is keyset-paginated on (created_at, id); the edit
 * updates only the PATCH fields (SKU code and uom are immutable).
 * `sku_barcodes` is the barcode-uniqueness authority per (tenant, client):
 * every writer of `skus.barcode` keeps the primary row in step in its
 * transaction. Lock order: product → skus → sku_barcodes. Idempotency de-dupe
 * in the same transaction (AD-5).
 */
@Injectable()
export class SkuCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // forwardRef: tenancy and catalog reference each other (checklist facade
    // ↔ role lookup). The role is resolved per request through the
    // TenancyService facade — catalog never reads tenancy tables.
    @Inject(forwardRef(() => TenancyService)) private readonly tenancy: TenancyService,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async list(
    tenantId: string,
    cursor?: string,
    limit: number = DEFAULT_SKU_PAGE_SIZE,
    productId?: string,
    // Story 1-5a — the staff client filter, a named option (never a further
    // positional argument).
    options: { readonly clientId?: string | undefined; readonly status?: SkuStatus | undefined } = {},
  ): Promise<Page<SkuSnapshot>> {
    const pageSize = Math.min(Math.max(Math.trunc(limit) || DEFAULT_SKU_PAGE_SIZE, 1), MAX_SKU_PAGE_SIZE);
    const before = cursor === undefined ? undefined : decodeCursorSafe(cursor);
    // Page + conversions in one tenant-scoped transaction (RLS session state
    // set once; both queries app-filter on tenant_id as the authority).
    const { rows, packaging } = await withTenantTransaction(this.db, tenantId, async (tx) => {
      // Story 11.3: the optional product filter — the variants of ONE product
      // (the 11-6 matrix's data source), still keyset-paginated on the same
      // (created_at, id) sort.
      const scope = and(
        eq(skus.tenantId, tenantId),
        productId === undefined ? undefined : eq(skus.productId, productId),
        options.clientId === undefined ? undefined : eq(skus.clientId, options.clientId),
        // Story 1-4b — the optional status filter; absent lists every SKU.
        options.status === undefined ? undefined : eq(skus.status, options.status),
      );
      const skuRows = await tx
        .select()
        .from(skus)
        .where(
          before
            ? and(
                scope,
                sql`(${skus.createdAt}, ${skus.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
              )
            : scope,
        )
        .orderBy(desc(skus.createdAt), desc(skus.id))
        .limit(pageSize + 1);
      const pageRows = skuRows.slice(0, pageSize);
      // Story 1-4 — the page's pack levels and barcodes, two batched reads.
      const packagingBySku = await readPackagingInTx(tx, tenantId, pageRows.map((row) => row.id));
      return { rows: skuRows, packaging: packagingBySku };
    });
    const page = buildPage(rows.map(toSnapshot), pageSize);
    if (page.items.length === 0) {
      return { items: [], nextCursor: page.nextCursor };
    }
    return {
      items: page.items.map((item) => ({
        ...item,
        uomConversions: packaging.get(item.id)?.levels ?? [],
        barcodes: packaging.get(item.id)?.barcodes ?? [],
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Story 1-4 — `POST …/catalog/skus`: one SKU, created with one import
   * row's worth of typed fields (pack levels and barcodes included) in one
   * keyed transaction. The import's rules through the shared seam
   * (`sku-master.ts`, `sku-attributes.ts`, the class validators, `resolveUom`
   * with its aliases); the client is the import's rule exactly — omitted only
   * while the tenant has one client (then its `self`), else 400
   * `client-required`. Same-key concurrent creates: the loser hits the code
   * index and answers 409 `duplicate-sku-code` rather than replaying
   * (accepted — PENDING, cross-cutting).
   */
  async create(command: CreateSkuCommand, idempotencyKey: string): Promise<SkuWriteSnapshot> {
    // 0. Request-SHAPE checks above the transaction (the DTO mirrors them).
    const code = typeof command.code === 'string' ? command.code.trim() : '';
    if (code === '' || code.length > SKU_CODE_MAX) {
      throw new ProblemException('validation-failed', 400, 'Invalid SKU code', `code must be 1–${SKU_CODE_MAX} characters.`);
    }
    const name = typeof command.name === 'string' ? command.name.trim() : '';
    if (name === '' || name.length > SKU_NAME_MAX) {
      throw new ProblemException('validation-failed', 400, 'Invalid SKU name', `name must be 1–${SKU_NAME_MAX} characters.`);
    }
    const blankToUndefined = (value: string | undefined): string | undefined => {
      const trimmed = value?.trim();
      return trimmed === undefined || trimmed === '' ? undefined : trimmed;
    };
    const hsn = blankToUndefined(command.hsn);
    const barcode = blankToUndefined(command.barcode);
    const countryOfOrigin = blankToUndefined(command.countryOfOrigin);
    const packaging = canonicalPackaging(command.levels, command.barcodes);
    // Story 1-6a (decision 10) — canonical before hashing: the UN prefix
    // stripped, the arrays sorted and de-duplicated.
    const goods = canonicalGoodsType(pickGoodsType(command));

    // 1. The hash — fixed key order, collections canonicalised (levels by
    //    uom, barcodes by (uom, barcode)); `clientId` only when present (the
    //    21-2b conditional-key precedent). Story 1-6a: each goods-type key
    //    joins only when present, after `barcodes` — a pre-1-6a body hashes
    //    byte for byte as before (pinned by a golden in the suite).
    const payloadHash = hashCommandPayload({
      command: 'sku.create',
      tenantId: command.tenantId,
      code,
      name,
      uom: String(command.uom).trim(),
      gstRateBps: command.gstRateBps,
      hsn: hsn ?? null,
      barcode: barcode ?? null,
      batchTracked: command.batchTracked,
      serialTracked: command.serialTracked,
      catchWeightTracked: command.catchWeightTracked,
      weightGrams: command.weightGrams ?? null,
      lengthMm: command.lengthMm ?? null,
      widthMm: command.widthMm ?? null,
      heightMm: command.heightMm ?? null,
      countryOfOrigin: countryOfOrigin ?? null,
      storageClass: command.storageClass ?? null,
      hazardClass: command.hazardClass ?? null,
      abcClass: command.abcClass ?? null,
      reorderPoint: command.reorderPoint ?? null,
      reorderQty: command.reorderQty ?? null,
      shelfLifeDays: command.shelfLifeDays ?? null,
      levels: packaging.levels,
      barcodes: packaging.barcodes,
      ...presentGoodsTypeKeys(goods),
      ...(command.clientId === undefined ? {} : { clientId: command.clientId }),
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // 2. Authority first.
      assertPermission(await this.tenancy.getMemberRole(command.tenantId, command.actorUserId, tx), 'sku.edit');
      // 3. Replay.
      const replayed = await replaySkuWrite(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      // 4. The client — the import's rule exactly (decision 6).
      let clientId: string;
      if (command.clientId !== undefined) {
        if (!UUID_RE.test(command.clientId)) {
          throw new ProblemException('validation-failed', 400, 'Invalid client reference', 'clientId must be a uuid.');
        }
        await assertClientInTenantInTx(tx, command.tenantId, command.clientId);
        clientId = command.clientId;
      } else if ((await listClientsInTx(tx, command.tenantId)).length > 1) {
        throw clientRequired('SKU');
      } else {
        clientId = await ensureSelfClientInTx(tx, command.tenantId);
      }
      await assertClientTakesWorkInTx(tx, command.tenantId, clientId);

      // 5. The typed rules, behind the replay lookup (the 10.2 rule).
      const uom = resolveUom(String(command.uom));
      if (uom === null) {
        throw new ProblemException('validation-failed', 400, 'Unknown unit of measure', unknownUomDetail('uom', String(command.uom)));
      }
      assertGstRateBps(command.gstRateBps);
      if (hsn !== undefined && hsn.length > HSN_MAX) {
        throw new ProblemException('validation-failed', 400, 'Invalid HSN', `hsnCode must be at most ${HSN_MAX} characters.`);
      }
      if (command.serialTracked && isFractionalUom(uom)) {
        throw new ProblemException('validation-failed', 400, 'Serial tracking needs a whole-unit UoM', serialTrackedFractionalUomDetail(uom));
      }
      if (command.serialTracked && command.catchWeightTracked) {
        throw new ProblemException(
          'validation-failed',
          400,
          'A SKU cannot be both catch-weight and serial tracked',
          `SKU "${code}" would be both serial-tracked and catch-weight tracked. Both systems claim to identify the same physical unit — a serial from the ledger, a handling unit from its own row — and nothing decides which one a scan names. Pick one.`,
        );
      }
      assertSkuAttributes({
        weightGrams: command.weightGrams,
        lengthMm: command.lengthMm,
        widthMm: command.widthMm,
        heightMm: command.heightMm,
        countryOfOrigin,
      });
      assertStorageClass({ storageClass: command.storageClass });
      assertHazardClass({ hazardClass: command.hazardClass });
      assertAbcClass({ abcClass: command.abcClass });
      assertShelfLifeDays(command.shelfLifeDays);
      // Story 1-6a — the goods-type rules over the request (absent = the
      // default), then the DG → hazard derivation with no stored state
      // (decision 7: an absent hazard derives; class 8 must name its choice).
      assertGoodsType(goods);
      const hazardClass = resolveHazardClass(goods.dgClass ?? null, null, command.hazardClass);
      const precision = uomPrecision(uom);
      const reorderPointMilli =
        command.reorderPoint === undefined ? 0 : assertRecordableQuantity(command.reorderPoint, 'reorderPoint', uom, precision);
      const reorderQtyMilli =
        command.reorderQty === undefined ? 0 : assertRecordableQuantity(command.reorderQty, 'reorderQty', uom, precision);
      // A blank barcode gets the import's generated value.
      const primary = barcode ?? uuidv7();
      assertBarcodeRule(primary, 'barcode');
      const levels = validateLevels(uom, command.levels ?? []);
      const extras = validateExtraBarcodes(uom, levels, primary, command.barcodes ?? []);

      // 6. Uniqueness in the client: the code, the code against the client's
      //    barcodes (decision 13), every barcode against `sku_barcodes` and
      //    the client's codes (this SKU's own code included).
      const takenCode = await tx
        .select({ id: skus.id })
        .from(skus)
        .where(and(eq(skus.tenantId, command.tenantId), eq(skus.clientId, clientId), eq(skus.code, code)))
        .limit(1);
      if (takenCode[0] !== undefined) {
        throw duplicateSkuCodeProblem(code);
      }
      const codeAsBarcode = await tx
        .select({ holder: skus.code })
        .from(skuBarcodes)
        .innerJoin(skus, eq(skus.id, skuBarcodes.skuId))
        .where(and(eq(skuBarcodes.tenantId, command.tenantId), eq(skuBarcodes.clientId, clientId), eq(skuBarcodes.barcode, code)))
        .limit(1);
      if (codeAsBarcode[0] !== undefined) {
        throw barcodeIsCode(code, code);
      }
      await assertBarcodesFreeInTx(tx, command.tenantId, clientId, [primary, ...extras.map((entry) => entry.barcode)], {
        ownCode: code,
      });

      // 7. The writes: the SKU, its primary barcode row, its levels and extras.
      let row: typeof skus.$inferSelect;
      try {
        const inserted = await tx
          .insert(skus)
          .values({
            id: uuidv7(),
            tenantId: command.tenantId,
            clientId,
            code,
            name,
            uom,
            gstRateBps: command.gstRateBps,
            hsn: hsn ?? null,
            batchTracked: command.batchTracked,
            serialTracked: command.serialTracked,
            catchWeightTracked: command.catchWeightTracked,
            weightGrams: command.weightGrams ?? null,
            lengthMm: command.lengthMm ?? null,
            widthMm: command.widthMm ?? null,
            heightMm: command.heightMm ?? null,
            countryOfOrigin: countryOfOrigin ?? null,
            reorderPoint: reorderPointMilli,
            reorderQty: reorderQtyMilli,
            barcode: primary,
            storageClass: command.storageClass ?? 'ambient',
            hazardClass,
            abcClass: command.abcClass ?? null,
            shelfLifeDays: command.shelfLifeDays ?? null,
            ...goodsTypeColumns(goods),
          })
          .returning();
        row = inserted[0]!;
        await writePrimaryBarcodeInTx(tx, row);
        await replacePackagingInTx(tx, row, levels, extras);
      } catch (err) {
        if (isUniqueViolationOn(err, SKUS_TENANT_CODE)) throw duplicateSkuCodeProblem(code);
        if (isBarcodeViolation(err)) {
          throw duplicateBarcodeProblem('A barcode of this SKU was taken by a concurrent write in this client — retry to see which.');
        }
        throw err;
      }
      const snapshot: SkuWriteSnapshot = { sku: await withPackaging(tx, command.tenantId, row) };
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'catalog.sku_created',
        occurredAt: nowIso(),
        payload: { skuId: row.id, code: row.code, clientId },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'sku.created',
        targetType: 'sku',
        targetId: row.id,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });
      await storeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 1-4 — `PUT …/catalog/skus/{skuId}/packaging`: replaces the SKU's
   * pack levels (`uom_conversions`) and its NON-primary barcodes. Skeleton:
   * the SKU row `FOR UPDATE` → the replay again under the lock → the guards
   * → delete-and-insert. Equal sets (in any order) are the no-op arm
   * `skus.packaging:unchanged`: the key is stored with `{ sku }`, nothing
   * else is written or audited. Kit SKUs take packaging like any SKU.
   */
  async replacePackaging(command: ReplacePackagingCommand, idempotencyKey: string): Promise<SkuWriteSnapshot> {
    const packaging = canonicalPackaging(command.levels, command.barcodes);
    const payloadHash = hashCommandPayload({
      command: 'sku.packaging',
      tenantId: command.tenantId,
      skuId: command.skuId,
      levels: packaging.levels,
      barcodes: packaging.barcodes,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await this.tenancy.getMemberRole(command.tenantId, command.actorUserId, tx), 'sku.edit');
      const replayed = await replaySkuWrite(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      if (!UUID_RE.test(command.skuId)) throw skuNotFound();
      // Lock, 404 when absent — and nothing else (guide §1: a lock helper
      // never checks state, or the second replay is unreachable).
      const locked = await tx
        .select()
        .from(skus)
        .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
        .limit(1)
        .for('update');
      const replayedUnderLock = await replaySkuWrite(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      const sku = locked[0];
      if (sku === undefined) throw skuNotFound();

      // The guards, against the locked row.
      const levels = validateLevels(sku.uom, command.levels);
      const extras = validateExtraBarcodes(sku.uom, levels, sku.barcode, command.barcodes);
      await assertClientTakesWorkInTx(tx, command.tenantId, sku.clientId);

      // The no-op arm: both sets equal to the stored ones.
      const stored = (await readPackagingInTx(tx, command.tenantId, [sku.id])).get(sku.id)!;
      const sameLevels =
        JSON.stringify(sortLevels(stored.levels).map((l) => [l.uom, l.factor])) ===
        JSON.stringify(sortLevels(levels).map((l) => [l.uom, l.factor]));
      const sameBarcodes =
        JSON.stringify(sortBarcodes(stored.barcodes.filter((b) => !b.isPrimary)).map((b) => [b.uom, b.barcode])) ===
        JSON.stringify(sortBarcodes(extras).map((b) => [b.uom, b.barcode]));
      if (sameLevels && sameBarcodes) {
        const unchanged: SkuWriteSnapshot = { sku: await withPackaging(tx, command.tenantId, sku) };
        await storeKey(tx, command.tenantId, idempotencyKey, payloadHash, unchanged);
        return unchanged;
      }

      await assertBarcodesFreeInTx(tx, command.tenantId, sku.clientId, extras.map((entry) => entry.barcode), {
        exceptSkuId: sku.id,
        ownCode: sku.code,
      });
      try {
        await replacePackagingInTx(tx, sku, levels, extras);
      } catch (err) {
        if (isBarcodeViolation(err)) {
          throw duplicateBarcodeProblem('A barcode in this request was taken by a concurrent write in this client — retry to see which.');
        }
        throw err;
      }
      await tx.update(skus).set({ updatedAt: nowIso() }).where(eq(skus.id, sku.id));
      const snapshot: SkuWriteSnapshot = { sku: await withPackaging(tx, command.tenantId, sku) };
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'catalog.sku_edited',
        occurredAt: nowIso(),
        payload: { skuId: sku.id, code: sku.code },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'sku.packaging_replaced',
        targetType: 'sku',
        targetId: sku.id,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });
      await storeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Story 1-4b — `PATCH …/catalog/skus/{skuId}/status`: deactivate (with an
   * optional reason) or reactivate — the partners `updateStatus` order: hash
   * (discriminator `command: 'sku.status'`) → `sku.edit` → replay → the shape
   * checks (they read no row) → the SKU `FOR UPDATE` (a plain `UPDATE` takes
   * only `NO KEY UPDATE`, which does not conflict with the takes-work guard's
   * `FOR KEY SHARE` — so the lock is explicit, and a deactivation and a PO
   * create serialise) → replay again under the lock → apply. Allowed whatever
   * stock or open work the SKU has (decision 1). Reactivating clears the
   * reason; a new reason on an inactive SKU replaces the old one (an audited
   * `sku.edited`). The same status with the same reason, or with no reason
   * (the stored one is kept), stores the key and writes nothing else
   * (`skus.status:unchanged`).
   */
  async updateStatus(command: UpdateSkuStatusCommand, idempotencyKey: string): Promise<SkuWriteSnapshot> {
    // Decision 14 — trimmed in the command; blank after trimming is absent.
    const trimmed = typeof command.reason === 'string' ? command.reason.trim() : command.reason;
    const reason = trimmed === undefined || trimmed === null || trimmed === '' ? null : trimmed;
    const payloadHash = hashCommandPayload({
      command: 'sku.status',
      tenantId: command.tenantId,
      skuId: command.skuId,
      status: command.status,
      reason,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await this.tenancy.getMemberRole(command.tenantId, command.actorUserId, tx), 'sku.edit');
      const replayed = await replaySkuWrite(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      // The pure shape checks, before the lock.
      if (!(SKU_STATUSES as readonly string[]).includes(command.status)) {
        throw new ProblemException(
          'validation-failed',
          400,
          'Invalid SKU status',
          `status must be one of ${JSON.stringify(SKU_STATUSES)} (got ${JSON.stringify(command.status)}).`,
        );
      }
      const status = command.status as SkuStatus;
      if (reason !== null && (typeof reason !== 'string' || status === 'active')) {
        throw new ProblemException(
          'validation-failed',
          400,
          'Invalid SKU status',
          'reason is given only when deactivating — reactivating clears it.',
        );
      }
      if (reason !== null && [...reason].length > SKU_INACTIVE_REASON_MAX) {
        throw new ProblemException(
          'validation-failed',
          400,
          'Invalid SKU status',
          `reason is at most ${SKU_INACTIVE_REASON_MAX} characters.`,
        );
      }
      if (!UUID_RE.test(command.skuId)) throw skuNotFound();
      // Lock, 404 when absent — nothing else (guide §1).
      const locked = await tx
        .select()
        .from(skus)
        .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
        .limit(1)
        .for('update');
      const replayedUnderLock = await replaySkuWrite(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      const current = locked[0];
      if (current === undefined) throw skuNotFound();

      // The same status with no reason keeps the stored reason (a no-op); a
      // different reason on an inactive SKU replaces it.
      const nextReason =
        status === 'active' ? null : reason ?? (current.status === status ? current.inactiveReason : null);
      if (current.status === status && (current.inactiveReason ?? null) === nextReason) {
        const unchanged: SkuWriteSnapshot = { sku: await withPackaging(tx, command.tenantId, current) };
        await storeKey(tx, command.tenantId, idempotencyKey, payloadHash, unchanged);
        return unchanged;
      }
      const rows = await tx
        .update(skus)
        .set({ status, inactiveReason: nextReason, updatedAt: nowIso() })
        .where(and(eq(skus.tenantId, command.tenantId), eq(skus.id, current.id)))
        .returning();
      const snapshot: SkuWriteSnapshot = { sku: await withPackaging(tx, command.tenantId, rows[0]!) };
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'catalog.sku_edited',
        occurredAt: nowIso(),
        payload: { skuId: current.id, code: current.code },
      });
      const action =
        current.status === status ? 'sku.edited' : status === 'inactive' ? 'sku.deactivated' : 'sku.reactivated';
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action,
        targetType: 'sku',
        targetId: current.id,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });
      await storeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  async edit(command: EditSkuCommand, idempotencyKey: string): Promise<SkuSnapshot> {
    const fields = {
      name: command.name,
      gstRateBps: command.gstRateBps,
      hsn: command.hsn,
      batchTracked: command.batchTracked,
      serialTracked: command.serialTracked,
      catchWeightTracked: command.catchWeightTracked,
      // Story 11.2 — the physical attributes count as fields for the
      // empty-patch refusal, exactly as every other PATCH field does.
      weightGrams: command.weightGrams,
      lengthMm: command.lengthMm,
      widthMm: command.widthMm,
      heightMm: command.heightMm,
      countryOfOrigin: command.countryOfOrigin,
      reorderPoint: command.reorderPoint,
      reorderQty: command.reorderQty,
      barcode: command.barcode,
      // Story 11.3 — the variant fields count as fields for the empty-patch
      // refusal, exactly as every other PATCH field does. `productId: null`
      // (detach) is a field; `undefined` drops out of the spread hash below,
      // so a pre-11.3 body reproduces its old hash and in-flight keys still
      // replay 200 (the 11.2 no-break reasoning, pinned by test).
      productId: command.productId,
      variantValues: command.variantValues,
      // Story 12-1 — the storage class counts as a field for the empty-patch
      // refusal, exactly as every other PATCH field does.
      storageClass: command.storageClass,
      // Story 12-2 — the hazard class counts too (null = clear, a real
      // value).
      hazardClass: command.hazardClass,
      // Story 5-3 — the ABC class counts too (null = clear, a real value).
      abcClass: command.abcClass,
      // Story 1-4 — shelf life counts too (null = clear); `undefined` drops
      // out of the spread hash, so a pre-1.4 body hashes as before.
      shelfLifeDays: command.shelfLifeDays,
      // Story 1-6a — the goods-type fields, canonical (decision 10) and LAST,
      // so a pre-1-6a body's hash is unchanged (absent keys drop out). The
      // derived hazard class is NOT here: `fields` is hashed, and a value
      // derived from stored state would make one request hash differently
      // depending on the row (Design Notes).
      ...canonicalGoodsType(pickGoodsType(command)),
    };
    if (Object.values(fields).every((value) => value === undefined)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Empty SKU edit',
        'At least one of name, gstRate, hsn, batchTracked, serialTracked, catchWeightTracked, weightGrams, lengthMm, widthMm, heightMm, countryOfOrigin, reorderPoint, reorderQty, barcode, productId, variantValues, storageClass, hazardClass, abcClass, shelfLifeDays, drugSchedules, foodCategory, allergens, dgUnNumber, dgClass, dgSubsidiaryClasses, dgPackingGroup, highValue, fragile, maxStackLayers is required.',
      );
    }
    // ── story 11.2: this hash did NOT break ──────────────────────────────────
    // Every attribute field is optional, so a pre-11.2 body leaves them
    // `undefined`, and `JSON.stringify` drops `undefined` keys — old hashes
    // are reproduced exactly and in-flight keys replay 200. Contrast 10.2,
    // where the hashed *representation* changed (milli→base) and the break was
    // accepted and pinned. Nothing is converted here, so there is nothing to
    // break. Pinned by the no-break replay test in `test/sku-attributes.spec.ts`.
    //
    // ── story 10.2: this fingerprint is over BASE units ────────────────────
    // Conversion moved out of the controller and into the command, behind the
    // replay lookup, so the hashed value changed with it: a key written by a
    // pre-10.2 build hashed MILLI-units and now answers 422
    // `idempotency-key-reuse` rather than replaying. Accepted deliberately
    // under the pre-launch premise — the same call story 10.1 made about the
    // ledger hash chain — and pinned as EXPECTED by the cross-version replay
    // guard in `test/picking.spec.ts`, so it is a recorded break and not a
    // surprise. No compatibility branch exists; there is nothing to be
    // compatible with.
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      skuId: command.skuId,
      ...fields,
    });

    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry (Story 1.5): the role is read
        // through the TenancyService facade in this same tenant transaction.
        assertPermission(
          await this.tenancy.getMemberRole(command.tenantId, command.actorUserId, tx),
          'sku.edit',
        );

        // Story 12-1 (code review): a snapshot stored by a pre-12.1 build
        // has no `storageClass` — the column did not exist. Serve the
        // migration DEFAULT the way `normalizeBin` serves the bins'
        // (`?? 'ambient'`); 12-2 / 5-3 pin `hazardClass` / `abcClass` the
        // same way, and 1-4 `shelfLifeDays ?? null` / `barcodes ?? []`
        // (`normalizeStoredSku`).
        const replayed = await replaySku(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replayed !== null) {
          return { snapshot: replayed, replayed: true };
        }

        const unlockedRows = await tx
          .select()
          .from(skus)
          .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
          .limit(1);
        const unlocked = unlockedRows[0];
        if (!unlocked) {
          throw skuNotFound();
        }
        // ── Story 1-4: lock order product → skus → sku_barcodes. The attach
        // (and the re-value) lock the product row BEFORE the SKU row, the
        // client correction's order — the arms below re-read it under the
        // lock they already hold. Then the SKU row `FOR UPDATE` (the flag
        // guard, the barcode writer and the class arms all decide against
        // it), then the replay again UNDER the lock (the same-key race fix,
        // guide §1): a parked same-key duplicate re-serves the winner.
        const productToLock =
          fields.productId !== undefined
            ? fields.productId !== null && UUID_RE.test(fields.productId)
              ? fields.productId
              : null
            : fields.variantValues !== undefined && fields.variantValues !== null
              ? unlocked.productId
              : null;
        if (productToLock !== null) {
          await tx
            .select({ id: products.id })
            .from(products)
            .where(and(eq(products.id, productToLock), eq(products.tenantId, command.tenantId)))
            .limit(1)
            .for('update');
        }
        const lockedSkuRows = await tx
          .select()
          .from(skus)
          .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
          .limit(1)
          .for('update');
        const replayedUnderLock = await replaySku(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replayedUnderLock !== null) {
          return { snapshot: replayedUnderLock, replayed: true };
        }
        const current = lockedSkuRows[0];
        if (!current) {
          throw skuNotFound();
        }
        // The re-value arm locked the product the SKU carried BEFORE its lock;
        // a concurrent attach/detach in between leaves us holding the wrong
        // product — refuse rather than decide against it.
        if (fields.productId === undefined && productToLock !== null && current.productId !== productToLock) {
          throw new ProblemException(
            'conflict',
            409,
            'The SKU\'s product changed during the edit',
            'A concurrent edit attached or detached this SKU while it was being re-valued — retry.',
          );
        }

        // Story 11.2: the physical attributes are validated HERE — behind the
        // replay lookup (the 10.2 rule: a rule that can tighten must not
        // answer 400 to an op that already committed), with the SKU's
        // existence already settled so an unknown SKU answers 404, not 400.
        // The same validator the import row parser calls; the DTO mirrors the
        // bounds but is not the boundary. Story 12-1: the storage class joins
        // the position — same validator shape (`assertStorageClass`), same
        // behind-the-replay rule. Story 12-2: the hazard class joins too
        // (`assertHazardClass` — it skips null, the legitimate clear verb).
        assertSkuAttributes({
          weightGrams: fields.weightGrams,
          lengthMm: fields.lengthMm,
          widthMm: fields.widthMm,
          heightMm: fields.heightMm,
          countryOfOrigin: fields.countryOfOrigin,
        });
        assertStorageClass({ storageClass: fields.storageClass });
        assertHazardClass({ hazardClass: fields.hazardClass });
        // Story 5-3 — the ABC class rides the same validator slot (the
        // `hazardClass` shape; absent/null skip, a present value must be in
        // the vocabulary).
        assertAbcClass({ abcClass: fields.abcClass });
        // Story 1-4 — shelf life 1–3650 (null clears), and the barcode rule
        // (decision 12) — both behind the replay lookup.
        assertShelfLifeDays(fields.shelfLifeDays);
        if (fields.barcode !== undefined) {
          assertBarcodeRule(fields.barcode, 'barcode');
        }
        // ── Story 1-6a: the goods-type pipeline (decision 7), behind the
        // replay and the SKU `FOR UPDATE`: merge each field onto the locked
        // row with `!== undefined` (never `??` — a clear is not absent), rule
        // on the RESULTING state, then derive the hazard class the edit
        // leaves behind. `effectiveHazard` is held apart from `fields` (and
        // the hash); when it differs from the stored class it drives both the
        // co-location guard and the write below — a DG-only PATCH that
        // derives `explosive` is guarded exactly as a hazard PATCH is.
        const mergedGoods = mergeGoodsType(goodsTypeOf(current), fields);
        assertGoodsType(mergedGoods);
        const effectiveHazard = resolveHazardClass(
          mergedGoods.dgClass ?? null,
          { dgClass: current.dgClass, hazardClass: current.hazardClass },
          fields.hazardClass,
        );
        const hazardChanges = effectiveHazard !== current.hazardClass;

        // ── Story 12-1: the class-change arm. The SKU row takes `.for('update')`
        // whenever the storage-class FIELD is present — a change, a no-op
        // edit and (were it possible) a clear all lock (the guard serializes
        // against the other SKU-row lockers — the +stock writers per fix-a2 —
        // but NOT against placement/pick, which read the SKU unlocked; that
        // residual race is the recorded 12-1 currency, PENDING.md
        // putaway:57); the guard BODY still runs only on a change. (Since 1-4 every edit
        // holds the SKU row lock taken above; this re-lock is a no-op.)
        if (fields.storageClass !== undefined) {
          const newClass = fields.storageClass;
          const lockedRows = await tx
            .select()
            .from(skus)
            .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
            .limit(1)
            .for('update');
          const locked = lockedRows[0]!;
          // The class-edit guard (409 `storage-class-conflict`): the SKU's
          // stock, tenant-wide, must all satisfy the NEW class. `stock_on_hand`
          // joined to `bins` EXCLUDES the system bins (Receiving staging, the
          // QC-HOLD bin — otherwise every intake SKU would refuse its first
          // class edit); open-QC-hold quantities are attributed to their ORIGIN
          // bins, which is what pins `qc.released` (release itself stays
          // class-free): a held unit returns to a bin that must satisfy the
          // new class too. The hierarchy runs in TS (`storageClassSatisfies`)
          // — no SQL copy exists.
          if (locked.storageClass !== newClass) {
            const stockRows = await tx
              .select({
                quantity: stockOnHand.quantity,
                binCode: bins.code,
                warehouseId: bins.warehouseId,
                binClass: bins.storageClass,
              })
              .from(stockOnHand)
              .innerJoin(bins, eq(bins.id, stockOnHand.binId))
              .where(
                and(
                  eq(stockOnHand.tenantId, command.tenantId),
                  eq(stockOnHand.skuId, command.skuId),
                  gt(stockOnHand.quantity, 0),
                  eq(bins.systemOwned, false),
                ),
              );
            const nonConforming = stockRows.filter(
              (row) => !storageClassSatisfies(newClass, row.binClass),
            );
            const holds = await openQcHoldsForSkuInTx(tx, command.tenantId, command.skuId);
            const originBinIds = [...new Set(holds.map((hold) => hold.binId))];
            const originRows =
              originBinIds.length === 0
                ? []
                : await tx
                    .select({
                      id: bins.id,
                      code: bins.code,
                      warehouseId: bins.warehouseId,
                      binClass: bins.storageClass,
                      systemOwned: bins.systemOwned,
                    })
                    .from(bins)
                    .where(and(eq(bins.tenantId, command.tenantId), inArray(bins.id, originBinIds)));
            const originById = new Map(originRows.map((row) => [row.id, row]));
            const holdParties = holds.flatMap((hold) => {
              const origin = originById.get(hold.binId);
              if (origin === undefined || origin.systemOwned) {
                return []; // the origin bin is gone or is staging — nothing to attribute
              }
              if (storageClassSatisfies(newClass, origin.binClass)) {
                return [];
              }
              return [
                `origin bin "${origin.code}" (warehouse ${origin.warehouseId}, hold "${hold.holdId}")`,
              ];
            });
            if (nonConforming.length > 0 || holdParties.length > 0) {
              const stockParties = nonConforming.map(
                (row) => `bin "${row.binCode}" (warehouse ${row.warehouseId}, bin is ${row.binClass})`,
              );
              throw storageClassConflict(
                `SKU "${current.code}" would require ${newClass} storage, but its stock sits in ` +
                  [...stockParties, ...holdParties].join('; ') +
                  ' — relocate the stock first.',
              );
            }
          }
        }

        // ── Story 12-2 / 1-6b: the segregation-edit arm. Every edit already
        // holds the SKU row `FOR UPDATE` (since 1-4, above), so the guard
        // decides against the locked row. The guard BODY runs when the
        // edit changes the SKU's segregation PROFILE (decision 3 — arrays
        // compared as sorted sets, the hazard class being `effectiveHazard`,
        // so a DG-only PATCH that derives one is guarded like a hazard PATCH)
        // to a non-empty one: an empty profile carries no rule in either
        // direction, so a clear always succeeds.
        //
        // The guard (409 `hazard-segregation-conflict`): for every non-system
        // bin where the SKU holds stock tenant-wide, and every non-system
        // origin of its open QC holds (a later `qc.released` would return
        // those units there; release itself stays ungated — pinned
        // indirectly, the 12-1 pattern), each OTHER occupant (the binmate)
        // is judged by `conflictKeys`: the edit is refused when the new
        // profile's keys against the binmate are not a subset of the stored
        // profile's — refuse only what the edit makes worse. So 12-2's
        // explosive → flammable beside an oxidizer is still refused, and a
        // rename (or any profile change) in a bin that was already mixed
        // passes. The detail lists every newly conflicting bin, binmate and
        // hold, naming the rule the edit newly fires.
        const storedProfile = profileOf(current);
        const nextProfile: SegregationProfile = {
          hazardClass: effectiveHazard,
          dgClass: mergedGoods.dgClass ?? null,
          dgSubsidiaryClasses: mergedGoods.dgSubsidiaryClasses ?? [],
          drugSchedules: mergedGoods.drugSchedules ?? [],
          foodCategory: mergedGoods.foodCategory ?? null,
          allergens: mergedGoods.allergens ?? [],
        };
        if (!sameProfile(nextProfile, storedProfile) && !isEmptyProfile(nextProfile)) {
          const stockBins = await tx
            .select({
              binId: bins.id,
              binCode: bins.code,
              warehouseId: bins.warehouseId,
            })
            .from(stockOnHand)
            .innerJoin(bins, eq(bins.id, stockOnHand.binId))
            .where(
              and(
                eq(stockOnHand.tenantId, command.tenantId),
                eq(stockOnHand.skuId, command.skuId),
                gt(stockOnHand.quantity, 0),
                eq(bins.systemOwned, false),
              ),
            );
          // The SKU could hold several stock rows in one bin (the batch
          // arms fold into separate projection rows) — one candidate bin.
          const binById = new Map(stockBins.map((row) => [row.binId, row]));
          const holds = await openQcHoldsForSkuInTx(tx, command.tenantId, command.skuId);
          const originBinIds = [...new Set(holds.map((hold) => hold.binId))];
          const originRows =
            originBinIds.length === 0
              ? []
              : await tx
                  .select({
                    id: bins.id,
                    code: bins.code,
                    warehouseId: bins.warehouseId,
                    systemOwned: bins.systemOwned,
                  })
                  .from(bins)
                  .where(and(eq(bins.tenantId, command.tenantId), inArray(bins.id, originBinIds)));
          // Non-system origins only (staging attributes nothing — as
          // before), decided BEFORE the ONE grouped occupant read.
          const originById = new Map(
            originRows.filter((row) => !row.systemOwned).map((row) => [row.id, row]),
          );
          // ONE grouped occupant read over EVERY candidate bin — the
          // stocked bins and the hold origins together, no per-bin queries
          // inside the row lock. One row per (bin, binmate): a bin that is
          // both a stock bin and a hold origin yields ONE party row, and
          // the dedupe falls out of the read — the hold-origin copy carries
          // the richer hold-naming message whenever the bin is a hold
          // origin.
          const occupants = await binOccupantHazardPairsInTx(tx, command.tenantId, [
            ...binById.keys(),
            ...originById.keys(),
          ]);
          const holdIdByBin = new Map(holds.map((hold) => [hold.binId, hold.holdId]));
          const parties: string[] = [];
          let firstRule: GoodsSegregationRule | null = null;
          for (const occupant of occupants) {
            // The SKU's own units are not binmates — they move with the
            // edit (the same-SKU-consolidation rule).
            if (occupant.skuId === command.skuId) {
              continue;
            }
            const conflict = newGoodsConflict(nextProfile, storedProfile, occupant.profile);
            if (conflict === null) {
              continue;
            }
            firstRule ??= conflict.rule;
            const facts = conflictFacts(conflict, nextProfile, occupant.profile);
            const why = `"${occupant.skuCode}" (${facts.b}) — "${current.code}" (${facts.a}) ${facts.verdict}`;
            const origin = originById.get(occupant.binId);
            if (origin !== undefined) {
              parties.push(
                `origin bin "${origin.code}" (warehouse ${origin.warehouseId}, hold "${holdIdByBin.get(occupant.binId)}") ` +
                  `co-locates with ${why}`,
              );
            } else {
              const bin = binById.get(occupant.binId)!;
              parties.push(`bin "${bin.binCode}" (warehouse ${bin.warehouseId}) co-locates with ${why}`);
            }
          }
          if (firstRule !== null) {
            throw goodsStateConflict(
              firstRule,
              `SKU "${current.code}" would conflict with stock it shares bins with: ${parties.join('; ')} — ` +
                'relocate the stock or release the holds first.',
            );
          }
        }

        // ── Story 11.3: attach / detach / re-value — behind the replay
        // lookup, with the SKU's existence already settled. `setProductId` /
        // `setVariantValues` stay `undefined` when the patch moves neither —
        // an ordinary edit of an attached SKU re-validates nothing.
        let setProductId: string | null | undefined;
        let setVariantValues: Record<string, string> | null | undefined;
        if (fields.productId !== undefined) {
          // Non-HTTP callers (and a hand-built command) skip the DTO's
          // @IsUUID — the command is the boundary that keeps a bad ref out
          // of the uuid column (a raw 22P02 is never an answer).
          if (fields.productId !== null && !UUID_RE.test(fields.productId)) {
            throw new ProblemException(
              'validation-failed',
              400,
              'Invalid product reference',
              'productId must be a uuid or null (null detaches the SKU from its product).',
            );
          }
          if (fields.productId === null) {
            // Detach clears the values with it — the row-local CHECK requires
            // the pairing, and a product-less value is an orphan by
            // definition. A variantValues key alongside productId: null is a
            // mistake, refused rather than silently dropped.
            if (fields.variantValues !== undefined) {
              throw new ProblemException(
                'validation-failed',
                400,
                'Variant values need a product',
                'variantValues cannot ride a detach — productId: null clears them with it.',
              );
            }
            setProductId = null;
            setVariantValues = null;
          } else {
            // `for('update')`: every product-row writer serializes here —
            // a concurrent ProductCommand.edit cannot slip an axes change in
            // between this read and the SKU UPDATE below.
            const productRows = await tx
              .select()
              .from(products)
              .where(and(eq(products.id, fields.productId), eq(products.tenantId, command.tenantId)))
              .limit(1)
              .for('update');
            const product = productRows[0];
            if (!product) {
              throw productNotFound(fields.productId);
            }
            if (fields.variantValues === undefined || fields.variantValues === null) {
              throw new ProblemException(
                'validation-failed',
                400,
                'Variant values do not match the product',
                `variantValues is required when attaching product "${product.name}" — every declared axis ` +
                  `(${product.axes.join(', ')}) must carry exactly one value.`,
              );
            }
            // The ONE shared validator: every axis covered exactly, one
            // non-empty ≤64-char value per axis — the missing key, unknown
            // key or blank value refuses HERE, naming variantValues and the
            // axis (the I/O matrix's `Variant values mismatch` arm).
            assertVariantValues(product.axes, fields.variantValues);
            const values = normalizeVariantValues(fields.variantValues as Record<string, string>);
            // Story 1-4 (decision 3) — a product belongs to one client and
            // its variants share it: a SKU of another client is refused 409
            // `product-client-mismatch` (it replaced 21-2b's sibling-based
            // `mixed-client` for products).
            // Story 1-2a — a departed client's SKU joins no product (409
            // `client-departed`) — decided first: departure outranks the
            // product's client.
            await assertClientTakesWorkInTx(tx, command.tenantId, current.clientId);
            if (product.clientId !== current.clientId) {
              throw productClientMismatch(product.name, current.code);
            }
            // Duplicate variants are refused: two SKUs in one product
            // carrying identical values is the 409 the I/O matrix names,
            // checked in-transaction (the repo's no-FK convention — a
            // partial unique index over a jsonb expression would work, but
            // the product row is already resolved here, so the check costs
            // one indexed query).
            const duplicate = await tx
              .select({ code: skus.code })
              .from(skus)
              .where(
                and(
                  eq(skus.tenantId, command.tenantId),
                  eq(skus.productId, product.id),
                  ne(skus.id, command.skuId),
                  eq(skus.variantValues, values),
                ),
              )
              .limit(1);
            if (duplicate[0]) {
              throw duplicateVariantValues(product.name, values, duplicate[0].code);
            }
            setProductId = product.id;
            setVariantValues = values;
          }
        } else if (fields.variantValues !== undefined) {
          // Values without a product move: re-value against the SKU's
          // CURRENT attachment (an edit touching only the values). A SKU
          // with no product has no axes to cover — refused.
          if (current.productId === null || fields.variantValues === null) {
            throw new ProblemException(
              'validation-failed',
              400,
              'Variant values need a product',
              'variantValues cannot be set without the SKU belonging to a product — attach it with productId first.',
            );
          }
          // Same lock as the attach arm — the re-value guards against the
          // product's CURRENT axes, so a concurrent axes edit must not land
          // between this read and the SKU UPDATE.
          const productRows = await tx
            .select()
            .from(products)
            .where(and(eq(products.id, current.productId), eq(products.tenantId, command.tenantId)))
            .limit(1)
            .for('update');
          const product = productRows[0];
          if (!product) {
            throw productNotFound(current.productId);
          }
          assertVariantValues(product.axes, fields.variantValues);
          const values = normalizeVariantValues(fields.variantValues as Record<string, string>);
          const duplicate = await tx
            .select({ code: skus.code })
            .from(skus)
            .where(
              and(
                eq(skus.tenantId, command.tenantId),
                eq(skus.productId, product.id),
                ne(skus.id, command.skuId),
                eq(skus.variantValues, values),
              ),
            )
            .limit(1);
          if (duplicate[0]) {
            throw duplicateVariantValues(product.name, values, duplicate[0].code);
          }
          setVariantValues = values;
        }

        // Story 10.1: turning serial tracking ON is catalog entry for the
        // rule's purposes — a serialized unit is discrete by definition, so a
        // SKU measured to three decimals can never carry serials. Refused
        // here, naming the UoM and the rule, rather than converted at the four
        // sites that compare a unit count to `serials.length`.
        //
        // Story 10.2: the rule is now a LOOKUP against the vocabulary's
        // declared precision rather than a hand-maintained list of discrete
        // spellings — same refusal, same text, no false refusal for a
        // legitimate whole-unit unit nobody remembered to enumerate.
        if (fields.serialTracked === true && isFractionalUom(current.uom)) {
          throw new ProblemException(
            'validation-failed',
            400,
            'Serial tracking needs a whole-unit UoM',
            serialTrackedFractionalUomDetail(current.uom),
          );
        }

        // Story 10.3: catch weight and serial tracking are two per-unit
        // identity systems over ONE physical unit, and the combination is
        // unsolved — a serial identifies the unit from the ledger, a handling
        // unit identifies it from its own row, and nothing decides which one a
        // scan at pack is naming. Refused ONCE, here at catalog entry, rather
        // than at the four downstream sites that would each have to guess.
        //
        // The check is over the RESULTING state, not the patch: turning either
        // flag on against a SKU that already carries the other is the same
        // contradiction as setting both in one request, and a patch-only check
        // would wave the first case straight through.
        const resultingSerialTracked = fields.serialTracked ?? current.serialTracked;
        const resultingCatchWeightTracked =
          fields.catchWeightTracked ?? current.catchWeightTracked;
        if (resultingSerialTracked && resultingCatchWeightTracked) {
          throw new ProblemException(
            'validation-failed',
            400,
            'A SKU cannot be both catch-weight and serial tracked',
            `SKU "${current.code}" would be both serial-tracked and catch-weight tracked. Both systems claim to identify the same physical unit — a serial from the ledger, a handling unit from its own row — and nothing decides which one a scan names. Pick one.`,
          );
        }

        // Story 10.3: the flag may not move while the SKU still has LIVE
        // handling units (`active` or `pending_approval`). Turning it OFF
        // strands them — their stock stays on hand and ships accounted for by
        // no case at all; turning it ON leaves existing on-hand backed by no
        // unit, so pack can never satisfy its one-id-per-picked-unit rule and
        // the SKU is wedged forever. Neither direction has a repair path, so
        // the flip is refused rather than cascaded.
        if (
          fields.catchWeightTracked !== undefined &&
          fields.catchWeightTracked !== current.catchWeightTracked
        ) {
          const live = await countLiveHandlingUnitsInTx(tx, command.tenantId, command.skuId);
          if (live > 0) {
            throw new ProblemException(
              'conflict',
              409,
              'Catch-weight tracking cannot change while units are live',
              `SKU "${current.code}" has ${live} live handling unit(s). Turning catch-weight tracking ` +
                `${fields.catchWeightTracked ? 'on' : 'off'} would leave its stock and its cases disagreeing with no way back — ` +
                'pack, write off or reject every live unit first.',
            );
          }
        }

        // ── Story 1-4 (decision 7): the tracking flags lock once stock
        // exists. CHANGING (value differs from the locked row) batch, serial
        // or catch-weight tracking while the SKU has stock in any bin
        // (system bins included), a pending over-receipt or a pending
        // positive adjustment is 409 `sku-has-stock` — each of those becomes
        // stock without reading the flags again. Runs under the SKU lock
        // taken above, after the catch-weight live-unit guard; a patch that
        // sends the flags unchanged never reaches it.
        const flagChanges = (
          [
            ['batch', fields.batchTracked, current.batchTracked],
            ['serial', fields.serialTracked, current.serialTracked],
            ['catch-weight', fields.catchWeightTracked, current.catchWeightTracked],
          ] as const
        ).filter(([, next, now]) => next !== undefined && next !== now);
        if (flagChanges.length > 0) {
          const holdings = await skuStockHoldingsInTx(tx, command.tenantId, command.skuId);
          if (holdings.length > 0) {
            throw new ProblemException(
              'sku-has-stock',
              409,
              'Tracking cannot change while the SKU has stock',
              `SKU "${current.code}" has ${holdings.join(', ')} — ${flagChanges.map(([flag]) => flag).join(' and ')} tracking ` +
                'cannot change until that stock is gone; existing units were recorded under the current tracking.',
            );
          }
        }

        // Story 10.2: the reorder thresholds are UoM-denominated, so they are
        // converted HERE — behind the replay lookup, with the SKU's unit in
        // hand — and a value finer than that unit declares is refused rather
        // than rounded. A reorder point of 2.5 on an each-counted SKU is not a
        // rounding question.
        const precision = uomPrecision(current.uom);
        const reorderPointMilli =
          fields.reorderPoint === undefined
            ? undefined
            : assertRecordableQuantity(fields.reorderPoint, 'reorderPoint', current.uom, precision);
        const reorderQtyMilli =
          fields.reorderQty === undefined
            ? undefined
            : assertRecordableQuantity(fields.reorderQty, 'reorderQty', current.uom, precision);

        // Barcode uniqueness per (tenant, client) — story 1-1, read from
        // `sku_barcodes` since 1-4 (the one authority): another SKU of this
        // client holding the new barcode at any level is a 409 naming it and
        // its level; a barcode equal to a SKU code of the client (this SKU's
        // own included) is 409 `barcode-is-code`. This SKU's own rows are
        // excluded — an extra barcode of its own is PROMOTED below.
        const barcodeChanges = fields.barcode !== undefined && fields.barcode !== current.barcode;
        if (barcodeChanges) {
          // Promotion only re-uses an extra BASE-level barcode: a case or
          // pallet barcode promoted to primary would silently become one unit.
          const ownExtra = await tx
            .select({ uom: skuBarcodes.uom })
            .from(skuBarcodes)
            .where(
              and(
                eq(skuBarcodes.tenantId, command.tenantId),
                eq(skuBarcodes.skuId, command.skuId),
                eq(skuBarcodes.isPrimary, false),
                eq(skuBarcodes.barcode, fields.barcode!),
              ),
            )
            .limit(1);
          if (ownExtra[0] !== undefined && ownExtra[0].uom !== current.uom) {
            throw new ProblemException(
              'validation-failed',
              400,
              'A pack-level barcode cannot become the primary',
              `Barcode "${fields.barcode}" is this SKU's ${ownExtra[0].uom} barcode — only an extra ${current.uom} (base-level) barcode can be promoted to primary. Remove it from the packaging first.`,
            );
          }
          await assertBarcodesFreeInTx(tx, command.tenantId, current.clientId, [fields.barcode!], {
            exceptSkuId: command.skuId,
            ownCode: current.code,
          });
        }

        const updates: Partial<typeof skus.$inferInsert> = { updatedAt: nowIso() };
        if (fields.name !== undefined) updates.name = fields.name;
        if (fields.gstRateBps !== undefined) updates.gstRateBps = fields.gstRateBps;
        if (fields.hsn !== undefined) updates.hsn = fields.hsn;
        if (fields.batchTracked !== undefined) updates.batchTracked = fields.batchTracked;
        if (fields.serialTracked !== undefined) updates.serialTracked = fields.serialTracked;
        if (fields.catchWeightTracked !== undefined)
          updates.catchWeightTracked = fields.catchWeightTracked;
        // Story 11.2 — absent = unchanged, null = cleared (the `hsn`
        // precedent); a cleared attribute reads back `null`.
        if (fields.weightGrams !== undefined) updates.weightGrams = fields.weightGrams;
        if (fields.lengthMm !== undefined) updates.lengthMm = fields.lengthMm;
        if (fields.widthMm !== undefined) updates.widthMm = fields.widthMm;
        if (fields.heightMm !== undefined) updates.heightMm = fields.heightMm;
        if (fields.countryOfOrigin !== undefined) updates.countryOfOrigin = fields.countryOfOrigin;
        if (reorderPointMilli !== undefined) updates.reorderPoint = reorderPointMilli;
        if (reorderQtyMilli !== undefined) updates.reorderQty = reorderQtyMilli;
        if (fields.barcode !== undefined) updates.barcode = fields.barcode;
        // Story 12-1 — absent = unchanged (no clear verb; the column is
        // NOT NULL, a SKU always carries a class).
        if (fields.storageClass !== undefined) updates.storageClass = fields.storageClass;
        // Story 12-2 — absent = unchanged, null = clear (the 11.2 attribute
        // template; the column is nullable, the clear verb exists). Story
        // 1-6a: the RESOLVED class (decision 7) — derived from the DG class
        // when one is mapped — written only when it changes.
        if (hazardChanges) updates.hazardClass = effectiveHazard;
        // Story 1-6a — the goods-type fields, absent = unchanged.
        Object.assign(updates, goodsTypeColumns(fields));
        // Story 5-3 — absent = unchanged, null = clear (the hazardClass
        // twin; null = not yet classified, OQ-1).
        if (fields.abcClass !== undefined) updates.abcClass = fields.abcClass;
        // Story 1-4 — absent = unchanged, null = clear.
        if (fields.shelfLifeDays !== undefined) updates.shelfLifeDays = fields.shelfLifeDays;
        // Story 11.3 — the variant columns move only when the patch moved
        // them (`undefined` = untouched; `null` = cleared with the detach).
        if (setProductId !== undefined) updates.productId = setProductId;
        if (setVariantValues !== undefined) updates.variantValues = setVariantValues;
        try {
          const updatedRows = await tx
            .update(skus)
            .set(updates)
            .where(eq(skus.id, command.skuId))
            .returning();
          const updated = updatedRows[0]!;
          if (barcodeChanges) {
            // Story 1-4 — the primary row follows `skus.barcode` in this
            // transaction. A value that was this SKU's extra barcode is
            // promoted: its extra row goes, the primary row takes it.
            await tx
              .delete(skuBarcodes)
              .where(
                and(
                  eq(skuBarcodes.tenantId, command.tenantId),
                  eq(skuBarcodes.skuId, command.skuId),
                  eq(skuBarcodes.isPrimary, false),
                  eq(skuBarcodes.barcode, updated.barcode),
                ),
              );
            await writePrimaryBarcodeInTx(tx, updated);
          }
          const snapshot = await withPackaging(tx, command.tenantId, updated);
          // In-transaction outbox append (AD-7, story outbox-relay) — replaces
          // the old post-commit publish. The `!replayed` gate of the old
          // post-commit publish is structural here: the idempotent replay
          // returned above (and a concurrent duplicate's transaction rolls
          // back whole), so a replayed edit appends nothing.
          await this.outbox.append(tx, {
            messageId: uuidv7(),
            tenantId: command.tenantId,
            type: 'catalog.sku_edited',
            occurredAt: nowIso(),
            payload: { skuId: command.skuId, code: updated.code },
          });
          // Story 9-3a — the audit row (skeleton step 10).
          await tx.insert(auditEvents).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            actorUserId: command.actorUserId,
            action: 'sku.edited',
            targetType: 'sku',
            targetId: command.skuId,
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
        } catch (err) {
          if (isBarcodeViolation(err) && !(err instanceof ProblemException)) {
            // Concurrent writer won the barcode race between the pre-check and
            // the update; the transaction is aborted — retry replays cleanly.
            throw duplicateBarcode(fields.barcode ?? '', '');
          }
          throw err;
        }
      },
    );

    return snapshot;
  }
}

function toSnapshot(row: typeof skus.$inferSelect): SkuSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    clientId: row.clientId,
    uom: row.uom,
    uomPrecision: uomPrecision(row.uom),
    gstRateBps: row.gstRateBps,
    hsn: row.hsn,
    batchTracked: row.batchTracked,
    serialTracked: row.serialTracked,
    catchWeightTracked: row.catchWeightTracked,
    // Story 11.2 — absent attributes read `null` (no backfill; a pre-11.2 row
    // and an import that left the columns blank both read the same).
    weightGrams: row.weightGrams,
    lengthMm: row.lengthMm,
    widthMm: row.widthMm,
    heightMm: row.heightMm,
    countryOfOrigin: row.countryOfOrigin,
    // Story 11.3 — an unattached SKU (every pre-11.3 row, every import row
    // without the `product` column) reads `productId: null`,
    // `variantValues: null`, exactly like the 11.2 attributes.
    productId: row.productId,
    variantValues: row.variantValues ?? null,
    // Story 12-1 — the controlled-vocabulary class (required; every SKU
    // carries one, default 'ambient').
    storageClass: row.storageClass,
    // Story 12-2 — toSnapshot is the module's only SKU read shape and it always
    // sets the class (`null` on every pre-12.2 row and import row without the
    // cell); the replay serve point's `?? null` normalizer pins the required
    // response field for legacy snapshots.
    hazardClass: row.hazardClass ?? null,
    // Story 5-3 — the ABC class rides the same always-set shape (`null` on
    // every pre-5.3 row and import row without the cell, OQ-1).
    abcClass: row.abcClass ?? null,
    // Story 10.1: `toSnapshot` is the module's only SKU read shape — base
    // units leave here, milli-units stay in the column.
    reorderPoint: fromMilli(row.reorderPoint),
    reorderQty: fromMilli(row.reorderQty),
    barcode: row.barcode,
    uomConversions: [],
    // Story 1-4 — set from the row; the barcodes are stitched by the caller
    // (`withPackaging`, the list's batched read).
    shelfLifeDays: row.shelfLifeDays ?? null,
    barcodes: [],
    // Story 1-4b — the status and its reason (null unless inactive).
    status: row.status as SkuStatus,
    inactiveReason: row.inactiveReason ?? null,
    // Story 1-6a — the goods-type attributes (every pre-1-6a row reads the
    // column defaults).
    ...goodsTypeOf(row),
    createdAt: row.createdAt,
  };
}

/** Story 1-6a — a SKU row's goods-type fields, in the fixed field order. */
export function goodsTypeOf(row: typeof skus.$inferSelect): GoodsTypeFields {
  return {
    drugSchedules: row.drugSchedules ?? [],
    foodCategory: row.foodCategory ?? null,
    allergens: row.allergens ?? [],
    dgUnNumber: row.dgUnNumber ?? null,
    dgClass: row.dgClass ?? null,
    dgSubsidiaryClasses: row.dgSubsidiaryClasses ?? [],
    dgPackingGroup: row.dgPackingGroup ?? null,
    highValue: row.highValue ?? false,
    fragile: row.fragile ?? false,
    maxStackLayers: row.maxStackLayers ?? null,
  };
}

/** Story 1-6a — the goods-type keys of a command, nothing else (absent stays absent). */
function pickGoodsType(command: GoodsTypeInput): GoodsTypeInput {
  return {
    drugSchedules: command.drugSchedules,
    foodCategory: command.foodCategory,
    allergens: command.allergens,
    dgUnNumber: command.dgUnNumber,
    dgClass: command.dgClass,
    dgSubsidiaryClasses: command.dgSubsidiaryClasses,
    dgPackingGroup: command.dgPackingGroup,
    highValue: command.highValue,
    fragile: command.fragile,
    maxStackLayers: command.maxStackLayers,
  };
}

/**
 * Story 1-6a — the present goods-type fields as column values. `assertGoodsType`
 * has already refused null on the NOT NULL ones, so a present value is the
 * column's type; an absent key is not written (the create's column defaults,
 * the edit's "unchanged").
 */
export function goodsTypeColumns(input: GoodsTypeInput): Partial<typeof skus.$inferInsert> {
  const out: Partial<typeof skus.$inferInsert> = {};
  if (input.drugSchedules !== undefined && input.drugSchedules !== null) out.drugSchedules = [...input.drugSchedules];
  if (input.foodCategory !== undefined) out.foodCategory = input.foodCategory;
  if (input.allergens !== undefined && input.allergens !== null) out.allergens = [...input.allergens];
  if (input.dgUnNumber !== undefined) out.dgUnNumber = input.dgUnNumber;
  if (input.dgClass !== undefined) out.dgClass = input.dgClass;
  if (input.dgSubsidiaryClasses !== undefined && input.dgSubsidiaryClasses !== null) {
    out.dgSubsidiaryClasses = [...input.dgSubsidiaryClasses];
  }
  if (input.dgPackingGroup !== undefined) out.dgPackingGroup = input.dgPackingGroup;
  if (input.highValue !== undefined && input.highValue !== null) out.highValue = input.highValue;
  if (input.fragile !== undefined && input.fragile !== null) out.fragile = input.fragile;
  if (input.maxStackLayers !== undefined) out.maxStackLayers = input.maxStackLayers;
  return out;
}

/** One SKU's response shape with its pack levels and barcodes (two reads). */
export async function withPackaging(
  tx: TenantTx,
  tenantId: string,
  row: typeof skus.$inferSelect,
): Promise<SkuSnapshot> {
  const packaging = (await readPackagingInTx(tx, tenantId, [row.id])).get(row.id);
  return {
    ...toSnapshot(row),
    uomConversions: packaging?.levels ?? [],
    barcodes: packaging?.barcodes ?? [],
  };
}

/** A 23505 on either barcode index (story 1-4 D6: both are mapped everywhere). */
export function isBarcodeViolation(err: unknown): boolean {
  return isUniqueViolationOn(err, SKU_BARCODES_UNIQUE) || isUniqueViolationOn(err, SKUS_BARCODE_UNIQUE);
}

/** The stored response under a key, normalized; null when the key is new; 422 on a different payload. */
async function replaySku(
  tx: TenantTx,
  tenantId: string,
  idempotencyKey: string,
  payloadHash: string,
): Promise<SkuSnapshot | null> {
  const existing = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
    .limit(1);
  if (existing[0] === undefined) return null;
  if (existing[0].payloadHash !== payloadHash) throw idempotencyKeyReuse();
  return normalizeStoredSku(existing[0].responseSnapshot as SkuSnapshot);
}

/** The `{ sku }` envelope (create, packaging) under a key, normalized. */
async function replaySkuWrite(
  tx: TenantTx,
  tenantId: string,
  idempotencyKey: string,
  payloadHash: string,
): Promise<SkuWriteSnapshot | null> {
  const existing = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
    .limit(1);
  if (existing[0] === undefined) return null;
  if (existing[0].payloadHash !== payloadHash) throw idempotencyKeyReuse();
  const stored = existing[0].responseSnapshot as SkuWriteSnapshot;
  return { sku: normalizeStoredSku(stored.sku) };
}

async function storeKey(
  tx: TenantTx,
  tenantId: string,
  idempotencyKey: string,
  payloadHash: string,
  snapshot: unknown,
): Promise<void> {
  try {
    await tx.insert(idempotencyKeys).values({
      id: uuidv7(),
      tenantId,
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
}

/**
 * Story 1-4 (decision 7) — what makes a SKU "have stock" for the tracking
 * flags: on-hand ≠ 0 in ANY bin (the system bins — Receiving, QC-HOLD,
 * IN-TRANSIT — included), a pending over-receipt, a pending positive stock
 * adjustment. Each becomes stock later without re-reading the flags. Empty
 * when the SKU holds none of them; otherwise one phrase per kind.
 */
export async function skuStockHoldingsInTx(tx: TenantTx, tenantId: string, skuId: string): Promise<string[]> {
  const found: string[] = [];
  const onHand = await tx
    .select({ one: stockOnHand.skuId })
    .from(stockOnHand)
    .where(and(eq(stockOnHand.tenantId, tenantId), eq(stockOnHand.skuId, skuId), ne(stockOnHand.quantity, 0)))
    .limit(1);
  if (onHand.length > 0) found.push('stock on hand');
  const pendingExcess = await tx
    .select({ one: overReceipts.skuId })
    .from(overReceipts)
    .where(and(eq(overReceipts.tenantId, tenantId), eq(overReceipts.skuId, skuId), eq(overReceipts.status, 'pending')))
    .limit(1);
  if (pendingExcess.length > 0) found.push('a pending over-receipt');
  const pendingAdjustment = await tx
    .select({ one: stockAdjustmentPendings.skuId })
    .from(stockAdjustmentPendings)
    .where(
      and(
        eq(stockAdjustmentPendings.tenantId, tenantId),
        eq(stockAdjustmentPendings.skuId, skuId),
        eq(stockAdjustmentPendings.status, 'pending'),
        gt(stockAdjustmentPendings.quantityMilli, 0),
      ),
    )
    .limit(1);
  if (pendingAdjustment.length > 0) found.push('a pending stock adjustment');
  return found;
}

export function duplicateSkuCodeProblem(code: string): ProblemException {
  return new ProblemException(
    'duplicate-sku-code',
    409,
    'SKU code already in use',
    `SKU code "${code}" already exists in this client's catalog — duplicates are rejected, never merged.`,
  );
}

/** The import's rule (21-2b), shared by the SKU and product creates (story 1-4 decision 6). */
export function clientRequired(subject: 'SKU' | 'product'): ProblemException {
  return new ProblemException(
    'client-required',
    400,
    'Choose the client',
    `This tenant holds more than one client, so a ${subject} create must name the client it belongs to (clientId) — there is no default.`,
  );
}

export function productClientMismatch(productName: string, skuCode: string): ProblemException {
  return new ProblemException(
    'product-client-mismatch',
    409,
    'The product belongs to another client',
    `Product "${productName}" belongs to another client than SKU "${skuCode}" — a product's variants share its client.`,
  );
}

/** Story 1-4 — the packaging hash's canonical order: levels by uom, barcodes by (uom, barcode). */
function canonicalPackaging(
  levels: readonly PackLevelInput[] | undefined,
  barcodes: readonly ExtraBarcodeInput[] | undefined,
): { levels: { uom: string; factor: number }[]; barcodes: { barcode: string; uom: string }[] } {
  return {
    levels: sortLevels((levels ?? []).map((level) => ({ uom: String(level.uom).trim(), factor: level.factor }))),
    barcodes: sortBarcodes(
      (barcodes ?? []).map((entry) => ({ barcode: String(entry.barcode).trim(), uom: String(entry.uom).trim() })),
    ).map((entry) => ({ barcode: entry.barcode, uom: entry.uom })),
  };
}

export function duplicateBarcode(barcode: string, conflictingCode: string): ProblemException {
  return new ProblemException(
    'duplicate-barcode',
    409,
    'Barcode already in use',
    conflictingCode === ''
      ? `Barcode "${barcode}" already belongs to another SKU of this client.`
      : `Barcode "${barcode}" already belongs to SKU "${conflictingCode}".`,
  );
}

export function duplicateVariantValues(
  productName: string,
  values: Readonly<Record<string, string>>,
  conflictingCode: string,
): ProblemException {
  return new ProblemException(
    'duplicate-variant-values',
    409,
    'Variant values already used in this product',
    `Product "${productName}" already has SKU "${conflictingCode}" carrying ${JSON.stringify(values)} — ` +
      'two variants of one product cannot be identical.',
  );
}

export function skuNotFound(): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'SKU not found',
    'No SKU with this id exists in this tenant.',
  );
}

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  let decoded: { createdAt: string; id: string };
  try {
    decoded = decodeCursor(cursor);
  } catch {
    throw invalidCursor();
  }
  if (!UUID_RE.test(decoded.id) || Number.isNaN(Date.parse(decoded.createdAt))) {
    throw invalidCursor();
  }
  return decoded;
}

function invalidCursor(): ProblemException {
  return new ProblemException(
    'invalid-cursor',
    400,
    'Malformed pagination cursor',
    'The cursor parameter is not a valid opaque page cursor.',
  );
}