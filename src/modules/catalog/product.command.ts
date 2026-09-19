import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { idempotencyKeys, products, skus } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { buildPage, decodeCursor, type Page } from '../../shared/primitives/pagination';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { DEFAULT_SKU_PAGE_SIZE, MAX_SKU_PAGE_SIZE } from './sku.command';

/** The product `name` cap — the SKU `name` bound (`NAME_MAX`, import.command). */
export const PRODUCT_NAME_MAX = 200;
/** An axis name is a short word (`size`, `colour`) — one cell of the 11-6 matrix header. */
export const AXIS_NAME_MAX = 32;
/** One variant value is short text (`M`, `Red`), not a sentence. */
export const VARIANT_VALUE_MAX = 64;
/** A product declares at most three axes (the I/O matrix's `1–3` bound). */
export const MAX_PRODUCT_AXES = 3;

const PRODUCTS_TENANT_NAME = 'products_tenant_id_name_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** The API response body for a product (idempotency snapshot + list item). */
export interface ProductSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  /** The declared axes, 1–3 short names. Immutable while variants are attached. */
  readonly axes: readonly string[];
  /** How many SKUs in this tenant are attached to this product (derived, never stored). */
  readonly skuCount: number;
  readonly createdAt: string;
}

export interface CreateProductCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly name: string;
  readonly axes: readonly string[];
}

export interface EditProductCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly productId: string;
  readonly name?: string | undefined;
  readonly axes?: readonly string[] | undefined;
}

/**
 * Product create / edit / list (Story 11.3). Identity only (AD-19): no UoM,
 * no tracking flags, no stock concept. Create and edit run the same replay
 * machinery as the `createOrder` convention — `hashCommandPayload` +
 * replay, snapshot + outbox appended in-transaction, the idempotency key
 * written LAST — so an in-flight key whose payload matches replays its
 * snapshot with no duplicate event. List is a read (open to any tenant
 * member, the repo rule — reads are never gated), keyset-paginated on
 * `(created_at, id)` like every list in the system.
 *
 * Gating rides `sku.edit` deliberately: a product is catalog identity, the
 * same family of edit the SKU PATCH already gates, and the story adds no new
 * capability (`SkuSummary`/the mirror are untouched — the 11-2 precedent).
 *
 * There is no delete command (the append-only philosophy) and no SKU create
 * command — import stays the only creator of SKUs; products are created
 * here, and SKUs attach to them through the existing SKU edit PATCH.
 */
@Injectable()
export class ProductCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async create(command: CreateProductCommand, idempotencyKey: string): Promise<ProductSnapshot> {
    // 0. Cheap SHAPE checks above the transaction — a malformed request must
    //    answer 400 before anything is read.
    const name = assertProductName(command.name);
    const axes = assertAxes(command.axes);

    // 1. Hash the payload BEFORE the transaction, fixed key order (the
    //    createOrder convention).
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      name,
      axes: [...axes],
    });

    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // 2. Authority first, inside the tx, re-read from the DB every time.
        assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'sku.edit');

        // 3. Replay lookup — a matching hash re-serves the snapshot and
        //    NOTHING below runs (no duplicate event).
        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(eq(idempotencyKeys.tenantId, command.tenantId), eq(idempotencyKeys.key, idempotencyKey)),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return { snapshot: existing[0].responseSnapshot as ProductSnapshot, replayed: true };
        }

        // 4. Duplicate name per tenant → 409 naming it (the `skus.code`
        //    precedent — import and the UI need an honest handle). The unique
        //    index below is the concurrent-writer backstop.
        const collision = await tx
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.tenantId, command.tenantId), eq(products.name, name)))
          .limit(1);
        if (collision[0]) {
          throw duplicateProductName(name);
        }

        // 5. The write + snapshot + outbox, one transaction (AD-7).
        const productId = uuidv7();
        const inserted = await tx
          .insert(products)
          .values({ id: productId, tenantId: command.tenantId, name, axes: [...axes] })
          .returning();
        const row = inserted[0]!;
        const snapshot: ProductSnapshot = {
          id: row.id,
          tenantId: row.tenantId,
          name: row.name,
          axes: row.axes,
          skuCount: 0,
          createdAt: row.createdAt,
        };
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'catalog.product_created',
          occurredAt: nowIso(),
          payload: { productId: snapshot.id, name: snapshot.name, axes: snapshot.axes },
        });
        try {
          // 6. The idempotency key is the commit marker — written LAST.
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
          // A concurrent writer won the name race between the pre-check and
          // the insert; the transaction aborts and the retry re-runs the
          // checks (the import's unique-violation shape).
          if (isUniqueViolationOn(err, PRODUCTS_TENANT_NAME)) {
            throw duplicateProductName(name);
          }
          throw err;
        }
        return { snapshot, replayed: false };
      },
    );

    return snapshot;
  }

  async edit(command: EditProductCommand, idempotencyKey: string): Promise<ProductSnapshot> {
    // Shape check above the transaction: a malformed (non-uuid) path param
    // must answer the 404 before Postgres answers a raw 22P02 — the exact
    // guard the SKU attach path carries for its productId field.
    if (!UUID_RE.test(command.productId)) {
      throw productNotFound(command.productId);
    }

    // The `hsn` template: absent = unchanged. An empty PATCH is its own error
    // code — `empty-product-edit` (the DTO admits optional-only bodies).
    const fields = {
      name: command.name === undefined ? undefined : assertProductName(command.name),
      axes: command.axes === undefined ? undefined : assertAxes(command.axes),
    };
    if (fields.name === undefined && fields.axes === undefined) {
      throw new ProblemException(
        'empty-product-edit',
        400,
        'Empty product edit',
        'At least one of name, axes is required.',
      );
    }

    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      productId: command.productId,
      name: fields.name,
      axes: fields.axes === undefined ? undefined : [...fields.axes],
    });

    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'sku.edit');

        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(eq(idempotencyKeys.tenantId, command.tenantId), eq(idempotencyKeys.key, idempotencyKey)),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return { snapshot: existing[0].responseSnapshot as ProductSnapshot, replayed: true };
        }

        const rows = await tx
          .select()
          .from(products)
          .where(and(eq(products.id, command.productId), eq(products.tenantId, command.tenantId)))
          .limit(1)
          .for('update');
        const current = rows[0];
        if (!current) {
          throw productNotFound(command.productId);
        }

        // Axes are immutable while the product has variants attached (409
        // `product-has-variants`): renaming an axis would silently orphan
        // every attached SKU's values, and there is no repair path. `name` is
        // always editable. The comparison is element-wise — a reordered or
        // respelled array is a different declaration, not the same one.
        if (fields.axes !== undefined && !sameAxes(fields.axes, current.axes)) {
          const attached = await tx
            .select({ id: skus.id })
            .from(skus)
            .where(and(eq(skus.tenantId, command.tenantId), eq(skus.productId, current.id)))
            .limit(1);
          if (attached[0]) {
            throw new ProblemException(
              'product-has-variants',
              409,
              'Product axes cannot change while variants are attached',
              `Product "${current.name}" has variants attached — renaming or replacing its axes ` +
                `(${current.axes.join(', ')}) would orphan every attached SKU's values. Detach the variants first.`,
            );
          }
        }

        // Duplicate name per tenant (the create pre-check's edit twin).
        if (fields.name !== undefined && fields.name !== current.name) {
          const collision = await tx
            .select({ id: products.id })
            .from(products)
            .where(and(eq(products.tenantId, command.tenantId), eq(products.name, fields.name)))
            .limit(1);
          if (collision[0]) {
            throw duplicateProductName(fields.name);
          }
        }

        const updates: Partial<typeof products.$inferInsert> = { updatedAt: nowIso() };
        if (fields.name !== undefined) updates.name = fields.name;
        if (fields.axes !== undefined) updates.axes = [...fields.axes];
        let updatedRows;
        try {
          updatedRows = await tx
            .update(products)
            .set(updates)
            .where(eq(products.id, command.productId))
            .returning();
        } catch (err) {
          // A concurrent rename won the name race between the pre-check and
          // this update — create's backstop, edit's twin (a raw 23505 is
          // never an answer).
          if (isUniqueViolationOn(err, PRODUCTS_TENANT_NAME)) {
            throw duplicateProductName(fields.name ?? current.name);
          }
          throw err;
        }
        const row = updatedRows[0]!;
        const skuCount = await countAttachedSkus(tx, command.tenantId, row.id);
        const snapshot: ProductSnapshot = {
          id: row.id,
          tenantId: row.tenantId,
          name: row.name,
          axes: row.axes,
          skuCount,
          createdAt: row.createdAt,
        };
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'catalog.product_edited',
          occurredAt: nowIso(),
          payload: { productId: row.id, name: row.name, axes: row.axes },
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

  /**
   * A read, open to any tenant member (reads are never gated). Keyset-paged
   * on `(created_at, id)` — the `sku.list` shape; each item's `skuCount` is
   * stitched from ONE grouped query over the page's product ids, never an
   * N+1.
   */
  async list(
    tenantId: string,
    cursor?: string,
    limit: number = DEFAULT_SKU_PAGE_SIZE,
  ): Promise<Page<ProductSnapshot>> {
    const pageSize = Math.min(
      Math.max(Math.trunc(limit) || DEFAULT_SKU_PAGE_SIZE, 1),
      MAX_SKU_PAGE_SIZE,
    );
    const before = cursor === undefined ? undefined : decodeCursorSafe(cursor);
    const rows = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const scope = eq(products.tenantId, tenantId);
      const productRows = await tx
        .select()
        .from(products)
        .where(
          before
            ? and(
                scope,
                sql`(${products.createdAt}, ${products.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
              )
            : scope,
        )
        .orderBy(desc(products.createdAt), desc(products.id))
        .limit(pageSize + 1);
      const pageRows = productRows.slice(0, pageSize);
      const counts =
        pageRows.length === 0
          ? []
          : await tx
              .select({ productId: skus.productId, n: sql<number>`count(*)::int` })
              .from(skus)
              .where(
                and(
                  eq(skus.tenantId, tenantId),
                  inArray(
                    skus.productId,
                    pageRows.map((row) => row.id),
                  ),
                ),
              )
              .groupBy(skus.productId);
      // The FULL limit+1 batch goes to buildPage — it is the +1 that decides
      // whether a next cursor exists (the sku.list shape; slicing here first
      // would collapse every page to the last one).
      return { productRows, counts };
    });
    const page = buildPage(
      rows.productRows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        axes: row.axes,
        skuCount: 0,
        createdAt: row.createdAt,
      })),
      pageSize,
    );
    const byProduct = new Map(
      rows.counts.filter((c) => c.productId !== null).map((c) => [c.productId as string, c.n]),
    );
    return {
      items: page.items.map((item) => ({ ...item, skuCount: byProduct.get(item.id) ?? 0 })),
      nextCursor: page.nextCursor,
    };
  }
}

// ── shared variant-value rules (the `sku-attributes.ts` pattern: ONE
// validator, called by the SKU edit command AND the import row parser) ───────

/**
 * The ONE validator over an attached SKU's axis values: the object must cover
 * EXACTLY the referenced product's declared axes — a missing key, an unknown
 * key, a non-string value, a blank value or a value over
 * `VARIANT_VALUE_MAX` is a 400 naming `variantValues` and the offending axis.
 * Run behind the replay lookup (the 10.2 rule: a rule that can tighten must
 * not answer 400 to an op that already committed), with the product row
 * already in hand.
 */
export function assertVariantValues(
  axes: readonly string[],
  values: Readonly<Record<string, unknown>> | null | undefined,
): void {
  if (values === null || values === undefined || typeof values !== 'object') {
    throw variantValuesFailed('variantValues must be an object keyed by the product\'s axes.');
  }
  const axisSet = new Set(axes);
  for (const key of Object.keys(values)) {
    if (!axisSet.has(key)) {
      throw variantValuesFailed(
        `variantValues has no axis "${key}" on this product — its declared axes are ${formatAxes(axes)}.`,
      );
    }
  }
  for (const axis of axes) {
    const value = (values as Record<string, unknown>)[axis];
    if (value === undefined) {
      throw variantValuesFailed(
        `variantValues is missing the axis "${axis}" — every declared axis (${formatAxes(axes)}) must carry exactly one value.`,
      );
    }
    if (typeof value !== 'string') {
      throw variantValuesFailed(`variantValues["${axis}"] must be a string.`);
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      throw variantValuesFailed(`variantValues["${axis}"] must not be blank.`);
    }
    if (trimmed.length > VARIANT_VALUE_MAX) {
      throw variantValuesFailed(
        `variantValues["${axis}"] must be at most ${VARIANT_VALUE_MAX} characters (got ${trimmed.length}).`,
      );
    }
  }
}

/**
 * The trimmed values object actually stored — the validator's normalized
 * form, so a `size=M ` cell and a `size=M` cell write one jsonb value (and
 * the duplicate-variant check sees them as the same variant). Call only
 * after `assertVariantValues` accepted the raw object.
 */
export function normalizeVariantValues(
  values: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = (value as string).trim();
  }
  return out;
}

/** Stable string form for duplicate-variant comparison (key-order independent). */
export function variantValuesFingerprint(values: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.keys(values)
      .sort()
      .reduce<Record<string, string>>((acc, key) => {
        acc[key] = values[key]!;
        return acc;
      }, {}),
  );
}

function variantValuesFailed(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Variant values do not match the product', detail);
}

// ── shape checks (above the transaction, needing no DB row) ────────────────

function assertProductName(raw: string): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') {
    throw new ProblemException('validation-failed', 400, 'Product validation failed', 'name is required.');
  }
  if (name.length > PRODUCT_NAME_MAX) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Product validation failed',
      `name must be at most ${PRODUCT_NAME_MAX} characters.`,
    );
  }
  return name;
}

function assertAxes(raw: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Product validation failed',
      `axes must be an array of 1–${MAX_PRODUCT_AXES} axis names.`,
    );
  }
  const axes: string[] = [];
  for (const axis of raw) {
    const trimmed = typeof axis === 'string' ? axis.trim() : '';
    if (trimmed === '') {
      throw new ProblemException(
        'validation-failed',
        400,
        'Product validation failed',
        'Every axis name must be a non-empty string.',
      );
    }
    if (trimmed.length > AXIS_NAME_MAX) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Product validation failed',
        `Every axis name must be at most ${AXIS_NAME_MAX} characters (got "${trimmed}").`,
      );
    }
    if (axes.includes(trimmed)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Product validation failed',
        `axes repeats "${trimmed}" — every axis must be distinct.`,
      );
    }
    axes.push(trimmed);
  }
  if (axes.length < 1 || axes.length > MAX_PRODUCT_AXES) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Product validation failed',
      `axes must carry 1–${MAX_PRODUCT_AXES} axis names (got ${axes.length}).`,
    );
  }
  return axes;
}

function sameAxes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((axis, i) => axis === b[i]);
}

function formatAxes(axes: readonly string[]): string {
  return `[${axes.join(', ')}]`;
}

export function duplicateProductName(name: string): ProblemException {
  return new ProblemException(
    'duplicate-product-name',
    409,
    'Product name already in use',
    `Product name "${name}" already exists in this tenant — duplicates are rejected, never merged.`,
  );
}

export function productNotFound(productId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Product not found',
    `No product with id "${productId}" exists in this tenant.`,
  );
}

async function countAttachedSkus(tx: TenantTx, tenantId: string, productId: string): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(skus)
    .where(and(eq(skus.tenantId, tenantId), eq(skus.productId, productId)));
  return rows[0]?.n ?? 0;
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

