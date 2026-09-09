import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { idempotencyKeys, skus, uomConversions } from '../../shared/db/schema';
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
  readonly gstRateBps: number;
  readonly hsn: string | null;
  readonly batchTracked: boolean;
  readonly serialTracked: boolean;
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
  readonly reorderPoint?: number | undefined;
  readonly reorderQty?: number | undefined;
  readonly barcode?: string | undefined;
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
  ): Promise<Page<SkuSnapshot>> {
    const pageSize = Math.min(Math.max(Math.trunc(limit) || DEFAULT_SKU_PAGE_SIZE, 1), MAX_SKU_PAGE_SIZE);
    const before = cursor === undefined ? undefined : decodeCursorSafe(cursor);
    // Page + conversions in one tenant-scoped transaction (RLS session state
    // set once; both queries app-filter on tenant_id as the authority).
    const { rows, conversions } = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const scope = eq(skus.tenantId, tenantId);
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
      reorderPoint: command.reorderPoint,
      reorderQty: command.reorderQty,
      barcode: command.barcode,
    };
    if (Object.values(fields).every((value) => value === undefined)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Empty SKU edit',
        'At least one of name, gstRate, hsn, batchTracked, serialTracked, reorderPoint, reorderQty, barcode is required.',
      );
    }
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
        if (fields.reorderPoint !== undefined) updates.reorderPoint = fields.reorderPoint;
        if (fields.reorderQty !== undefined) updates.reorderQty = fields.reorderQty;
        if (fields.barcode !== undefined) updates.barcode = fields.barcode;
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
    gstRateBps: row.gstRateBps,
    hsn: row.hsn,
    batchTracked: row.batchTracked,
    serialTracked: row.serialTracked,
    reorderPoint: row.reorderPoint,
    reorderQty: row.reorderQty,
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