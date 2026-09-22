import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  idempotencyKeys,
  kitCompositions,
  reservations,
  skus,
  stockOnHand,
} from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import {
  ProblemException,
  isUniqueViolationOn,
} from '../../shared/problem-details/problem.exception';
import { MAX_QUANTITY_MILLI, assertRecordableQuantity, fromMilli } from '../../shared/primitives/quantity';
import { buildPage, decodeCursor, type Page } from '../../shared/primitives/pagination';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { DEFAULT_SKU_PAGE_SIZE, MAX_SKU_PAGE_SIZE } from './sku.command';
import { getKitSkuIdsInTx } from './kit.store';
import { uomPrecision } from './uom';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** The API response body for one kit component. */
export interface KitComponentSnapshot {
  readonly skuId: string;
  readonly code: string;
  /** Per ONE kit, in the component's base UoM (milli-units below, base here). */
  readonly qty: number;
}

/** The API response body for a kit (idempotency snapshot + list item). */
export interface KitSnapshot {
  readonly skuId: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  /** The flat BOM — one entry per component, in composition order. */
  readonly components: readonly KitComponentSnapshot[];
  readonly createdAt: string;
}

/** One component as the caller supplies it — base-UoM quantity on the way in. */
export interface KitComponentInput {
  readonly skuId: string;
  readonly quantity: number;
}

export interface CreateKitCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  /** The SKU that becomes a kit. SKUs enter through import; kits attach here. */
  readonly skuId: string;
  readonly components: readonly KitComponentInput[];
}

export interface PutKitCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly skuId: string;
  readonly components: readonly KitComponentInput[];
}

/** The most components one kit may carry. */
export const MAX_KIT_COMPONENTS = 50;

/**
 * Kit create / replace / list (Story 11.4, FR-38 + AD-19). A kit IS a SKU:
 * kit-ness is the PRESENCE of its `kit_compositions` rows, never a flag, and
 * the kit SKU itself never holds stock — the components do (FR-38), which the
 * `kit-cannot-hold-stock` refusals in receiving and stock adjustment make
 * real.
 *
 * Create attaches a composition to an EXISTING (import-created) SKU; replace
 * swaps the whole BOM (PUT — the composition is a set, not a partial body;
 * a kit keeps at least one component; there is no delete command, the
 * append-only philosophy). Both run the `createOrder` replay convention —
 * `hashCommandPayload` + replay, snapshot + outbox appended in-transaction,
 * the idempotency key written LAST.
 *
 * THE CYCLE LOCK: both commands take `.for('update')` on the kit SKU row and
 * every component SKU row, ordered by id. Two concurrent creates (A∋B, B∋A)
 * both see the other component as not-yet-a-kit under read committed; the
 * id-ordered locks serialize them, and the loser re-reads committed state and
 * refuses 409 `kit-component-is-kit`. Detection cannot close this race — the
 * other kit's composition rows do not exist yet — only serialization can.
 *
 * Gating rides `sku.edit` (the 11-3 attach precedent): a composition is a
 * SKU-level catalog edit, no new capability. List is a read (never gated),
 * keyset-paginated on the kit SKU's `(created_at, id)`.
 */
@Injectable()
export class KitCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async create(command: CreateKitCommand, idempotencyKey: string): Promise<KitSnapshot> {
    // 0. Shape above the transaction: a malformed request answers 400 before
    //    anything is read. Duplicate components are a shape fact (no DB row
    //    needed) — 409, the set cannot carry the same component twice.
    if (!UUID_RE.test(command.skuId)) {
      throw kitNotFound(command.skuId);
    }
    const componentIds = assertComponents(command.components).map((component) => component.skuId);
    if (new Set(componentIds).size !== componentIds.length) {
      throw new ProblemException(
        'duplicate-kit-component',
        409,
        'The same component SKU appears twice',
        `SKU "${command.skuId}" cannot carry the same component more than once — the BOM is a set.`,
      );
    }

    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      skuId: command.skuId,
      components: command.components.map((component) => ({
        skuId: component.skuId,
        quantity: component.quantity,
      })),
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'sku.edit');

      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return replay;
      }

      // 1. Lock every SKU the command touches — kit + components — in id
      //    order, so concurrent kit commands on overlapping SKUs serialize
      //    instead of deadlocking, and the guards below decide against state
      //    that cannot change under them.
      const { kit, componentById } = await this.lockSkus(
        tx,
        command.tenantId,
        command.skuId,
        componentIds,
      );

      // 2. The guards, against locked rows.
      await assertNotKitInTx(tx, command.tenantId, command.skuId);
      await assertKitSkuHoldsNoStock(tx, command.tenantId, kit);
      assertSelfReference(command.skuId, componentIds);
      await assertComponentsAreNotKits(tx, command.tenantId, componentIds, componentById);
      const qtyBySku = await assertComponentQuantities(command.components, componentById);

      // 3. The write + snapshot + outbox, one transaction (AD-7).
      const snapshot = await this.replaceComposition(tx, command.tenantId, kit, qtyBySku);
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'catalog.kit_created',
        occurredAt: nowIso(),
        payload: kitEventPayload(snapshot),
      });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  async put(command: PutKitCommand, idempotencyKey: string): Promise<KitSnapshot> {
    if (!UUID_RE.test(command.skuId)) {
      throw kitNotFound(command.skuId);
    }
    const componentIds = assertComponents(command.components).map((component) => component.skuId);
    if (new Set(componentIds).size !== componentIds.length) {
      throw new ProblemException(
        'duplicate-kit-component',
        409,
        'The same component SKU appears twice',
        `Kit "${command.skuId}" cannot carry the same component more than once — the BOM is a set.`,
      );
    }

    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      skuId: command.skuId,
      components: command.components.map((component) => ({
        skuId: component.skuId,
        quantity: component.quantity,
      })),
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'sku.edit');

      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return replay;
      }

      const { kit, componentById } = await this.lockSkus(
        tx,
        command.tenantId,
        command.skuId,
        componentIds,
      );

      // Replace is an EDIT of an existing kit, never an entry into kit-ness:
      // a non-kit SKU answers 404 rather than silently becoming one (create
      // is the only door into kit-ness).
      const existing = await tx
        .select({ id: kitCompositions.id })
        .from(kitCompositions)
        .where(and(eq(kitCompositions.tenantId, command.tenantId), eq(kitCompositions.kitSkuId, kit.id)))
        .limit(1);
      if (existing[0] === undefined) {
        throw kitNotFound(command.skuId);
      }

      assertSelfReference(command.skuId, componentIds);
      await assertComponentsAreNotKits(tx, command.tenantId, componentIds, componentById);
      const qtyBySku = await assertComponentQuantities(command.components, componentById);

      const snapshot = await this.replaceComposition(tx, command.tenantId, kit, qtyBySku);
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'catalog.kit_edited',
        occurredAt: nowIso(),
        payload: kitEventPayload(snapshot),
      });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * A read, open to any tenant member (reads are never gated). Keyset-paged
   * on the kit SKU's `(created_at, id)` — the `sku.list` shape; each kit's
   * components are stitched from ONE joined query over the page's kit ids,
   * never an N+1.
   */
  async list(tenantId: string, cursor?: string, limit: number = DEFAULT_SKU_PAGE_SIZE): Promise<Page<KitSnapshot>> {
    const pageSize = Math.min(Math.max(Math.trunc(limit) || DEFAULT_SKU_PAGE_SIZE, 1), MAX_SKU_PAGE_SIZE);
    const before = cursor === undefined ? undefined : decodeCursorSafe(cursor);
    const rows = await withTenantTransaction(this.db, tenantId, async (tx) => {
      // A kit is a SKU WITH composition rows — one semi-join, not a flag read.
      const kitSkuIds = tx
        .select({ id: kitCompositions.kitSkuId })
        .from(kitCompositions)
        .where(eq(kitCompositions.tenantId, tenantId));
      const scope = and(eq(skus.tenantId, tenantId), inArray(skus.id, kitSkuIds));
      const kitRows = await tx
        .select({ id: skus.id, tenantId: skus.tenantId, code: skus.code, name: skus.name, createdAt: skus.createdAt })
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
      const pageRows = kitRows.slice(0, pageSize);
      const components =
        pageRows.length === 0
          ? []
          : await tx
              .select({
                kitSkuId: kitCompositions.kitSkuId,
                skuId: skus.id,
                code: skus.code,
                qty: kitCompositions.qty,
              })
              .from(kitCompositions)
              .innerJoin(skus, eq(skus.id, kitCompositions.componentSkuId))
              .where(
                and(
                  eq(kitCompositions.tenantId, tenantId),
                  inArray(
                    kitCompositions.kitSkuId,
                    pageRows.map((row) => row.id),
                  ),
                ),
              )
              .orderBy(kitCompositions.id);
      return { kitRows, components };
    });
    // The FULL limit+1 batch decides the cursor (the 11-3 lesson: slicing
    // first collapses every list to one page).
    const page = buildPage(
      rows.kitRows.map((row) => ({ id: row.id, createdAt: row.createdAt })),
      pageSize,
    );
    const byKit = new Map<string, KitComponentSnapshot[]>();
    for (const component of rows.components) {
      const list = byKit.get(component.kitSkuId) ?? [];
      list.push({ skuId: component.skuId, code: component.code, qty: fromMilli(component.qty) });
      byKit.set(component.kitSkuId, list);
    }
    return {
      items: rows.kitRows.slice(0, pageSize).map((row) => ({
        skuId: row.id,
        tenantId: row.tenantId,
        code: row.code,
        name: row.name,
        components: byKit.get(row.id) ?? [],
        createdAt: row.createdAt,
      })),
      nextCursor: page.nextCursor,
    };
  }

  // ── shared pieces ─────────────────────────────────────────────────────────

  /**
   * The kit SKU + every component SKU, locked `.for('update')` in id order —
   * the cycle lock (see the class comment) and the 404s for anything missing.
   */
  private async lockSkus(
    tx: TenantTx,
    tenantId: string,
    kitSkuId: string,
    componentIds: readonly string[],
  ): Promise<{ kit: typeof skus.$inferSelect; componentById: Map<string, typeof skus.$inferSelect> }> {
    const all = [...new Set([kitSkuId, ...componentIds])].sort();
    const rows = await tx
      .select()
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, all)))
      .orderBy(skus.id)
      .for('update');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const kit = byId.get(kitSkuId);
    if (kit === undefined) {
      throw kitNotFound(kitSkuId);
    }
    for (const componentId of componentIds) {
      if (!byId.has(componentId)) {
        throw new ProblemException(
          'kit-component-not-found',
          404,
          'Component SKU not found',
          `No component SKU with id "${componentId}" exists in this tenant.`,
        );
      }
    }
    return { kit: byId.get(kitSkuId)!, componentById: byId };
  }

  /** Delete + insert the BOM rows, then the read snapshot (base units out). */
  private async replaceComposition(
    tx: TenantTx,
    tenantId: string,
    kit: typeof skus.$inferSelect,
    qtyBySku: Map<string, number>,
  ): Promise<KitSnapshot> {
    await tx
      .delete(kitCompositions)
      .where(
        and(eq(kitCompositions.tenantId, tenantId), eq(kitCompositions.kitSkuId, kit.id)),
      );
    // Insert in the caller's component order — the snapshot and the event
    // carry the BOM the operator named, and (kit, component) uniqueness
    // backstops the set property.
    if (qtyBySku.size > 0) {
      await tx.insert(kitCompositions).values(
        [...qtyBySku.entries()].map(([componentSkuId, qty]) => ({
          id: uuidv7(),
          tenantId,
          kitSkuId: kit.id,
          componentSkuId,
          qty,
        })),
      );
    }
    const componentRows = await tx
      .select({ skuId: kitCompositions.componentSkuId, code: skus.code, qty: kitCompositions.qty })
      .from(kitCompositions)
      .innerJoin(skus, eq(skus.id, kitCompositions.componentSkuId))
      .where(and(eq(kitCompositions.tenantId, tenantId), eq(kitCompositions.kitSkuId, kit.id)))
      .orderBy(kitCompositions.id);
    return {
      skuId: kit.id,
      tenantId: kit.tenantId,
      code: kit.code,
      name: kit.name,
      components: componentRows.map((row) => ({
        skuId: row.skuId,
        code: row.code,
        qty: fromMilli(row.qty),
      })),
      createdAt: kit.createdAt,
    };
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<KitSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    if (existing[0] === undefined) {
      return null;
    }
    if (existing[0].payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return existing[0].responseSnapshot as KitSnapshot;
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: KitSnapshot,
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
}

// ── shared guards (the `assertVariantValues` pattern: ONE validator per rule) ─

/**
 * Component quantities: positive (the shape check), at the component's own
 * precision, inside the quantity bound — the order-line conversion, per
 * component, read from the LOCKED rows (`componentById`; `lockSkus` has
 * already 404'd anything missing). Returns the milli-unit quantities keyed
 * by component sku id, in caller order.
 */
function assertComponentQuantities(
  components: readonly KitComponentInput[],
  componentById: ReadonlyMap<string, typeof skus.$inferSelect>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const component of components) {
    const sku = componentById.get(component.skuId)!;
    const milli = assertRecordableQuantity(
      component.quantity,
      'quantity',
      sku.uom,
      uomPrecision(sku.uom),
    );
    if (milli > MAX_QUANTITY_MILLI) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Kit validation failed',
        `Component quantity must be at most ${fromMilli(MAX_QUANTITY_MILLI)} (got ${String(component.quantity)}).`,
      );
    }
    out.set(component.skuId, milli);
  }
  return out;
}

/**
 * Create's entry guard: the SKU the caller names must not already be a kit —
 * create is the only door into kit-ness, PUT replaces an existing kit's BOM.
 * Runs against the locked rows.
 */
async function assertNotKitInTx(tx: TenantTx, tenantId: string, skuId: string): Promise<void> {
  const rows = await tx
    .select({ id: kitCompositions.id })
    .from(kitCompositions)
    .where(and(eq(kitCompositions.tenantId, tenantId), eq(kitCompositions.kitSkuId, skuId)))
    .limit(1);
  if (rows[0] !== undefined) {
    throw new ProblemException(
      'kit-already-composed',
      409,
      'This SKU is already a kit',
      `SKU "${skuId}" already carries a composition — create is the only door into kit-ness; PUT replaces an existing kit's BOM.`,
    );
  }
}

/**
 * A SKU that already holds stock or a live reservation cannot become a kit.
 * Every stock writer refuses a kit (the `kit-cannot-hold-stock` guards in
 * receiving and stock adjustment) and no order line can ever reserve one —
 * orders explode to components — so a kit created ON stock would strand that
 * stock and its ATP forever, with no write-off path. Runs against the locked
 * kit row, in the same transaction as the composition write, so a GRN that
 * commits stock concurrently serializes on the same `.for('update')` sku row
 * (the GRN's `loadSkus` locks it too) and is already visible here.
 */
async function assertKitSkuHoldsNoStock(
  tx: TenantTx,
  tenantId: string,
  kit: typeof skus.$inferSelect,
): Promise<void> {
  const stockRows = await tx
    .select({ quantity: stockOnHand.quantity })
    .from(stockOnHand)
    .where(
      and(eq(stockOnHand.tenantId, kit.tenantId), eq(stockOnHand.skuId, kit.id), gt(stockOnHand.quantity, 0)),
    )
    .limit(1);
  if (stockRows[0] !== undefined) {
    throw kitSkuHoldsStock(kit, `${fromMilli(stockRows[0].quantity)} on hand`);
  }
  const holdRows = await tx
    .select({ id: reservations.id })
    .from(reservations)
    .where(
      and(
        eq(reservations.tenantId, kit.tenantId),
        eq(reservations.skuId, kit.id),
        inArray(reservations.state, ['held', 'committed']),
      ),
    )
    .limit(1);
  if (holdRows[0] !== undefined) {
    throw kitSkuHoldsStock(kit, 'a live reservation');
  }
}

/** The create refusal for a SKU that already carries stock or a live hold. */
function kitSkuHoldsStock(kit: typeof skus.$inferSelect, because: string): ProblemException {
  return new ProblemException(
    'kit-sku-holds-stock',
    409,
    'This SKU already holds stock',
    `SKU "${kit.code}" already carries ${because} — making it a kit would strand that stock forever (a kit never reserves, receives or adjusts stock; orders explode to its components). Move or consume the stock first.`,
  );
}

/** The row-local guard's command-side twin: a kit cannot compose itself. */
function assertSelfReference(kitSkuId: string, componentIds: readonly string[]): void {
  if (componentIds.includes(kitSkuId)) {
    throw new ProblemException(
      'kit-self-reference',
      400,
      'A kit cannot compose itself',
      `Component ${kitSkuId} is the kit SKU itself — a kit's BOM cannot name the kit as its own component.`,
    );
  }
}

/**
 * Every component must be an ordinary stock SKU, not another kit. Runs
 * against the LOCKED rows (the cycle lock) — a concurrent mutual composition
 * (A∋B, B∋A) is serialized by the id-ordered `.for('update')` locks, so the
 * loser re-reads committed state and refuses here. Only the COMPONENTS are
 * probed, never the kit SKU itself (which `componentById` also carries for
 * quantity lookups): on PUT the kit is by definition already a kit, and
 * probing it would refuse every edit.
 */
async function assertComponentsAreNotKits(
  tx: TenantTx,
  tenantId: string,
  componentIds: readonly string[],
  componentById: ReadonlyMap<string, typeof skus.$inferSelect>,
): Promise<void> {
  const kitIds = await getKitSkuIdsInTx(tx, tenantId, componentIds);
  if (kitIds.length > 0) {
    const named = kitIds
      .map((kitId) => componentById.get(kitId)?.code ?? kitId)
      .join(', ');
    throw new ProblemException(
      'kit-component-is-kit',
      409,
      'A component SKU cannot itself be a kit',
      `Component SKU(s) ${named} are themselves kits — the BOM is flat, one level; nest nothing.`,
    );
  }
}

// ── shape checks (above the transaction, needing no DB row) ────────────────

function assertComponents(
  raw: readonly KitComponentInput[] | undefined,
): readonly { skuId: string; quantity: number }[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ProblemException(
      'empty-kit-composition',
      400,
      'Kit validation failed',
      'A kit carries at least one component.',
    );
  }
  if (raw.length > MAX_KIT_COMPONENTS) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Kit validation failed',
      `A kit carries at most ${MAX_KIT_COMPONENTS} components (got ${String(raw.length)}).`,
    );
  }
  for (const component of raw) {
    if (typeof component?.skuId !== 'string' || !UUID_RE.test(component.skuId)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Kit validation failed',
        'Every component names a well-formed component skuId.',
      );
    }
    if (typeof component?.quantity !== 'number' || !Number.isFinite(component.quantity) || component.quantity <= 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Kit validation failed',
        'Every component carries a positive quantity in its own base UoM.',
      );
    }
  }
  return raw as readonly { skuId: string; quantity: number }[];
}

/** The `catalog.kit_created`/`kit_edited` body. The import's kit pass (11.6)
 * emits `kit_created` through this same builder — event parity with the
 * command path (an import-created kit is invisible to any outbox consumer
 * otherwise). */
export function kitEventPayload(
  snapshot: Pick<KitSnapshot, 'skuId' | 'code' | 'components'>,
): Record<string, unknown> {
  return {
    skuId: snapshot.skuId,
    code: snapshot.code,
    components: snapshot.components.map((component) => ({
      skuId: component.skuId,
      code: component.code,
      qty: component.qty,
    })),
  };
}

function kitNotFound(skuId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Kit not found',
    `No kit with sku id "${skuId}" exists in this tenant (a kit is a SKU carrying composition rows).`,
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