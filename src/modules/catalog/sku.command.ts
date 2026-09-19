import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { idempotencyKeys, products, skus, uomConversions } from '../../shared/db/schema';
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
import { isFractionalUom, serialTrackedFractionalUomDetail, uomPrecision } from './uom';
import { countLiveHandlingUnitsInTx } from './handling-unit.store';
import { assertSkuAttributes } from './sku-attributes';
import {
  assertVariantValues,
  normalizeVariantValues,
  productNotFound,
} from './product.command';

export const DEFAULT_SKU_PAGE_SIZE = 50;
export const MAX_SKU_PAGE_SIZE = 200;
const SKUS_TENANT_BARCODE = 'skus_tenant_id_barcode_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** The API response body for a SKU (idempotency snapshot + list item). */
export interface SkuSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
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
  readonly reorderPoint: number;
  readonly reorderQty: number;
  readonly barcode: string;
  readonly uomConversions: readonly { readonly uom: string; readonly factor: number }[];
  readonly createdAt: string;
}

export interface EditSkuCommand {
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
}

/**
 * SKU list + edit (Story 1.4). Manual creation is out of scope per planning —
 * catalog entries enter through the import only, then are edited via PATCH.
 * The list is keyset-paginated on (created_at, id); the edit updates only the
 * PATCH fields (SKU code is immutable) and re-checks barcode uniqueness per
 * tenant (409 `duplicate-barcode` naming the conflicting SKU). Idempotency
 * de-dupe in the same transaction (AD-5).
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
  ): Promise<Page<SkuSnapshot>> {
    const pageSize = Math.min(Math.max(Math.trunc(limit) || DEFAULT_SKU_PAGE_SIZE, 1), MAX_SKU_PAGE_SIZE);
    const before = cursor === undefined ? undefined : decodeCursorSafe(cursor);
    // Page + conversions in one tenant-scoped transaction (RLS session state
    // set once; both queries app-filter on tenant_id as the authority).
    const { rows, conversions } = await withTenantTransaction(this.db, tenantId, async (tx) => {
      // Story 11.3: the optional product filter — the variants of ONE product
      // (the 11-6 matrix's data source), still keyset-paginated on the same
      // (created_at, id) sort.
      const scope =
        productId === undefined
          ? eq(skus.tenantId, tenantId)
          : and(eq(skus.tenantId, tenantId), eq(skus.productId, productId));
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
      const conversionRows =
        pageRows.length === 0
          ? []
          : await tx
              .select({ skuId: uomConversions.skuId, uom: uomConversions.uom, factor: uomConversions.factor })
              .from(uomConversions)
              .where(
                and(
                  eq(uomConversions.tenantId, tenantId),
                  inArray(uomConversions.skuId, pageRows.map((row) => row.id)),
                ),
              );
      return { rows: skuRows, conversions: conversionRows };
    });
    const page = buildPage(rows.map(toSnapshot), pageSize);
    if (page.items.length === 0) {
      return { items: [], nextCursor: page.nextCursor };
    }
    const bySku = new Map<string, { uom: string; factor: number }[]>();
    for (const row of conversions) {
      const list = bySku.get(row.skuId) ?? [];
      list.push({ uom: row.uom, factor: row.factor });
      bySku.set(row.skuId, list);
    }
    return {
      items: page.items.map((item) => ({ ...item, uomConversions: bySku.get(item.id) ?? [] })),
      nextCursor: page.nextCursor,
    };
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
    };
    if (Object.values(fields).every((value) => value === undefined)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Empty SKU edit',
        'At least one of name, gstRate, hsn, batchTracked, serialTracked, catchWeightTracked, weightGrams, lengthMm, widthMm, heightMm, countryOfOrigin, reorderPoint, reorderQty, barcode, productId, variantValues is required.',
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
            snapshot: existing[0].responseSnapshot as SkuSnapshot,
            replayed: true,
          };
        }

        const currentRows = await tx
          .select()
          .from(skus)
          .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
          .limit(1);
        const current = currentRows[0];
        if (!current) {
          throw skuNotFound();
        }

        // Story 11.2: the physical attributes are validated HERE — behind the
        // replay lookup (the 10.2 rule: a rule that can tighten must not
        // answer 400 to an op that already committed), with the SKU's
        // existence already settled so an unknown SKU answers 404, not 400.
        // The same validator the import row parser calls; the DTO mirrors the
        // bounds but is not the boundary.
        assertSkuAttributes({
          weightGrams: fields.weightGrams,
          lengthMm: fields.lengthMm,
          widthMm: fields.widthMm,
          heightMm: fields.heightMm,
          countryOfOrigin: fields.countryOfOrigin,
        });

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
            const productRows = await tx
              .select()
              .from(products)
              .where(and(eq(products.id, fields.productId), eq(products.tenantId, command.tenantId)))
              .limit(1);
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
          const productRows = await tx
            .select()
            .from(products)
            .where(and(eq(products.id, current.productId), eq(products.tenantId, command.tenantId)))
            .limit(1);
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

        // Barcode uniqueness per tenant: another SKU already holding the new
        // barcode is a 409 naming it (the same conflict code the import
        // reports row-level).
        if (fields.barcode !== undefined && fields.barcode !== current.barcode) {
          const collision = await tx
            .select({ code: skus.code })
            .from(skus)
            .where(and(eq(skus.tenantId, command.tenantId), eq(skus.barcode, fields.barcode)))
            .limit(1);
          if (collision[0]) {
            throw duplicateBarcode(fields.barcode, collision[0].code);
          }
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
          const snapshot = await withConversions(tx, command.tenantId, updated);
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
          if (
            isUniqueViolationOn(err, SKUS_TENANT_BARCODE) &&
            !(err instanceof ProblemException)
          ) {
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
    // Story 10.1: `toSnapshot` is the module's only SKU read shape — base
    // units leave here, milli-units stay in the column.
    reorderPoint: fromMilli(row.reorderPoint),
    reorderQty: fromMilli(row.reorderQty),
    barcode: row.barcode,
    uomConversions: [],
    createdAt: row.createdAt,
  };
}

async function withConversions(
  tx: TenantTx,
  tenantId: string,
  row: typeof skus.$inferSelect,
): Promise<SkuSnapshot> {
  const conversions = await tx
    .select({ uom: uomConversions.uom, factor: uomConversions.factor })
    .from(uomConversions)
    .where(and(eq(uomConversions.tenantId, tenantId), eq(uomConversions.skuId, row.id)));
  return { ...toSnapshot(row), uomConversions: conversions };
}

export function duplicateBarcode(barcode: string, conflictingCode: string): ProblemException {
  return new ProblemException(
    'duplicate-barcode',
    409,
    'Barcode already in use',
    conflictingCode === ''
      ? `Barcode "${barcode}" already belongs to another SKU in this tenant.`
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

function skuNotFound(): ProblemException {
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