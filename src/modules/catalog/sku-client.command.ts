import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, notInArray, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  batches,
  channelMappings,
  countTaskLines,
  idempotencyKeys,
  kitCompositions,
  ledgerEvents,
  orderLines,
  products,
  purchaseOrderLines,
  asnLines,
  reservations,
  serials,
  skus,
  stockAdjustmentPendings,
  transferOrderLines,
} from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertClientInTenantInTx, getClientLabelsInTx } from '../clients/clients.facade';
import { skuNotFound, withConversions, type SkuSnapshot } from './sku.command';

export interface CorrectSkuClientCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly skuId: string;
  readonly clientId: string;
}

/** The correction's response: every SKU it moved (the named one first). */
export interface SkuClientCorrectionSnapshot {
  readonly skus: readonly SkuSnapshot[];
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
// Story 1-1 (0076) — code and barcode are unique per (tenant, client).
const SKUS_TENANT_CLIENT_CODE = 'skus_tenant_client_code_unique';
const SKUS_TENANT_CLIENT_BARCODE = 'skus_tenant_client_barcode_unique';

/**
 * Every place a SKU accrues HISTORY — anything that would disagree with a
 * moved client: the ledger, documents (order / PO / transfer lines, pending
 * adjustments, count tasks), stock identity (batches, serials), holds
 * (reservations), and a channel connection's mapping set (moving a mapped
 * SKU would silently make its connection mixed-client).
 */
const HISTORY_SOURCES: readonly {
  readonly label: string;
  readonly table: PgTable;
  readonly tenantId: PgColumn;
  readonly skuId: PgColumn;
}[] = [
  { label: 'ledger events', table: ledgerEvents, tenantId: ledgerEvents.tenantId, skuId: ledgerEvents.skuId },
  { label: 'order lines', table: orderLines, tenantId: orderLines.tenantId, skuId: orderLines.skuId },
  { label: 'purchase order lines', table: purchaseOrderLines, tenantId: purchaseOrderLines.tenantId, skuId: purchaseOrderLines.skuId },
  // Story 21-6 — an ASN line is an inbound document line, like a PO line.
  { label: 'advance shipment notice lines', table: asnLines, tenantId: asnLines.tenantId, skuId: asnLines.skuId },
  { label: 'transfer order lines', table: transferOrderLines, tenantId: transferOrderLines.tenantId, skuId: transferOrderLines.skuId },
  { label: 'pending stock adjustments', table: stockAdjustmentPendings, tenantId: stockAdjustmentPendings.tenantId, skuId: stockAdjustmentPendings.skuId },
  { label: 'count task lines', table: countTaskLines, tenantId: countTaskLines.tenantId, skuId: countTaskLines.skuId },
  { label: 'batches', table: batches, tenantId: batches.tenantId, skuId: batches.skuId },
  { label: 'serials', table: serials, tenantId: serials.tenantId, skuId: serials.skuId },
  { label: 'reservations', table: reservations, tenantId: reservations.tenantId, skuId: reservations.skuId },
  { label: 'channel mappings', table: channelMappings, tenantId: channelMappings.tenantId, skuId: channelMappings.skuId },
];

/**
 * Story 21-2b (decision 3) — the ONE door that moves SKUs to another client:
 * an owner corrects a mis-attributed SKU **only while it has no history**.
 *
 * A kit and its components, and a product's variants, share one client — so
 * moving one member alone would split them. The correction therefore moves
 * the SKU's whole GROUP (the transitive closure over kit partners and
 * product siblings) as one, allowed only when EVERY member is history-free;
 * otherwise 409 `sku-has-history` naming the member and what it carries.
 *
 * `test/architecture.spec.ts` pins this file as the ONLY writer of
 * `skus.client_id` after creation (the import's INSERT sets it once).
 *
 * The skeleton: authority (`clients.manage`, owner-only) → replay → the
 * target client exists (404) → the SKU exists (404) → its product row
 * locked `.for('update')` (the attach PATCH and the import lock it the same
 * way, product before SKU) → the group's SKU rows locked in id order → the
 * group re-derived UNDER the locks (a concurrent attach/compose → 409
 * `conflict`, retry) → a no-op (already on that client) returns without
 * writing → the history check under the locks → (story 1-1) the collision
 * check: no member's code or barcode may already be held by another SKU of
 * the TARGET client (409 `duplicate-sku-code` / `duplicate-barcode`; a 23505
 * on the per-client indexes from a concurrent import maps to the same
 * 409s) → the update → one audit
 * row per SKU (`sku.client-corrected`, reference `from <client> → to
 * <client> (key <key>)`) → the idempotency key LAST.
 *
 * The history reads cross into other modules' tables read-only — existence
 * probes on their `sku_id` columns (the `sku.command.ts` stock-on-hand guard
 * precedent). Residual race (recorded in PENDING): an order or PO create
 * that read a SKU's client before the correction commits writes its first
 * line without locking the SKU row.
 */
@Injectable()
export class SkuClientCommand {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async correct(command: CorrectSkuClientCommand, idempotencyKey: string): Promise<SkuClientCorrectionSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      skuId: command.skuId,
      clientId: command.clientId,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'clients.manage',
      );

      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }

      // Non-HTTP callers skip the controller's uuid checks — the command is
      // the boundary that keeps a raw 22P02 from ever being the answer.
      if (!UUID_RE.test(command.clientId)) {
        throw new ProblemException('validation-failed', 400, 'Invalid client reference', 'clientId must be a uuid.');
      }
      if (!UUID_RE.test(command.skuId)) {
        throw skuNotFound();
      }
      await assertClientInTenantInTx(tx, command.tenantId, command.clientId);

      // Lock order: the product row FIRST (the attach PATCH and the import's
      // product pass take it before touching a SKU), then the SKU rows in id
      // order (the kit command's order).
      const unlocked = await readGroup(tx, command.tenantId, command.skuId);
      if (unlocked === null) {
        throw skuNotFound();
      }
      if (unlocked.productIds.length > 0) {
        await tx
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.tenantId, command.tenantId), inArray(products.id, unlocked.productIds)))
          .orderBy(products.id)
          .for('update');
      }
      const lockedRows = await tx
        .select()
        .from(skus)
        .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.id, unlocked.skuIds)))
        .orderBy(skus.id)
        .for('update');
      // Replay again UNDER the last lock (the same-key race fix, guide §1):
      // a concurrent same-key duplicate parked on the locks re-serves the
      // winner's snapshot — without this it takes the no-op arm below and
      // answers only the target SKU where the winner answered the group.
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }
      const group = await readGroup(tx, command.tenantId, command.skuId);
      if (
        group === null ||
        group.skuIds.length !== unlocked.skuIds.length ||
        group.skuIds.some((id, i) => id !== unlocked.skuIds[i]) ||
        group.productIds.some((id) => !unlocked.productIds.includes(id))
      ) {
        throw new ProblemException(
          'conflict',
          409,
          'The SKU group changed during the correction',
          'A concurrent kit or product change moved this SKU\'s group while it was being corrected — retry.',
        );
      }
      const byId = new Map(lockedRows.map((row) => [row.id, row]));
      const target = byId.get(command.skuId)!;

      // A no-op (already on that client — the group shares one client) writes
      // nothing and audits nothing.
      if (lockedRows.every((row) => row.clientId === command.clientId)) {
        return { skus: [await withConversions(tx, command.tenantId, target)] };
      }

      // The history check, UNDER the locks — every member must be clean.
      for (const row of [target, ...lockedRows.filter((r) => r.id !== target.id)]) {
        const history = await skuHistoryInTx(tx, command.tenantId, row.id);
        if (history.length > 0) {
          throw new ProblemException(
            'sku-has-history',
            409,
            "The SKU's client can no longer change",
            (row.id === target.id
              ? `SKU "${row.code}" already has ${history.join(', ')}`
              : `SKU "${row.code}" (which shares a kit or product with "${target.code}" and must move with it) already has ${history.join(', ')}`) +
              ' — a SKU\'s client is fixed once it has history.',
          );
        }
      }

      const labels = await getClientLabelsInTx(tx, command.tenantId, [
        command.clientId,
        ...lockedRows.map((row) => row.clientId),
      ]);
      const targetLabel = labels.get(command.clientId) ?? command.clientId;
      const ordered = [target, ...lockedRows.filter((r) => r.id !== target.id)];

      // Story 1-1 — the collision check, under the locks: every member of the
      // moved group lands in the target client's catalog, where code and
      // barcode are unique. Named members are checked in the response order
      // (the named SKU first), codes before barcodes.
      await assertNoTargetCollisionsInTx(tx, command.tenantId, command.clientId, targetLabel, ordered);

      const moved: SkuSnapshot[] = [];
      for (const row of ordered) {
        let updated: (typeof skus.$inferSelect)[];
        try {
          updated = await tx
            .update(skus)
            .set({ clientId: command.clientId, updatedAt: nowIso() })
            .where(and(eq(skus.tenantId, command.tenantId), eq(skus.id, row.id)))
            .returning();
        } catch (err) {
          // A concurrent import committed a colliding SKU between the check
          // and the update: the per-client index is the arbiter.
          if (isUniqueViolationOn(err, SKUS_TENANT_CLIENT_CODE)) {
            throw targetCodeCollision(row.code, targetLabel);
          }
          if (isUniqueViolationOn(err, SKUS_TENANT_CLIENT_BARCODE)) {
            throw targetBarcodeCollision(row.barcode, row.code, null, targetLabel);
          }
          throw err;
        }
        moved.push(await withConversions(tx, command.tenantId, updated[0]!));
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'sku.client-corrected',
          targetType: 'sku',
          targetId: row.id,
          // audit_events has no payload column — the before/after rides the
          // reference beside the idempotency key.
          reference: `from ${labels.get(row.clientId) ?? row.clientId} → to ${labels.get(command.clientId) ?? command.clientId} (key ${idempotencyKey})`,
          occurredAt: nowIso(),
        });
      }
      const snapshot: SkuClientCorrectionSnapshot = { skus: moved };

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
      return snapshot;
    });
  }

  /**
   * A key that already committed returns its snapshot (a different payload
   * under it is 422 `idempotency-key-reuse`); `null` when the key is new.
   * Called twice: after authority, and again under the last row lock.
   */
  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<SkuClientCorrectionSnapshot | null> {
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
    return existing[0].responseSnapshot as SkuClientCorrectionSnapshot;
  }
}

/**
 * Story 1-1 — no member of the moved group may take a code or a barcode
 * another SKU of the TARGET client already holds (the group's own rows are
 * excluded: they are the ones moving).
 */
async function assertNoTargetCollisionsInTx(
  tx: TenantTx,
  tenantId: string,
  targetClientId: string,
  targetLabel: string,
  members: readonly (typeof skus.$inferSelect)[],
): Promise<void> {
  const memberIds = members.map((row) => row.id);
  const held = await tx
    .select({ code: skus.code, barcode: skus.barcode })
    .from(skus)
    .where(
      and(
        eq(skus.tenantId, tenantId),
        eq(skus.clientId, targetClientId),
        notInArray(skus.id, memberIds),
        or(
          inArray(skus.code, members.map((row) => row.code)),
          inArray(skus.barcode, members.map((row) => row.barcode)),
        ),
      ),
    );
  const heldCodes = new Set(held.map((row) => row.code));
  const heldBarcodes = new Map(held.map((row) => [row.barcode, row.code] as const));
  for (const row of members) {
    if (heldCodes.has(row.code)) {
      throw targetCodeCollision(row.code, targetLabel);
    }
  }
  for (const row of members) {
    const holder = heldBarcodes.get(row.barcode);
    if (holder !== undefined) {
      throw targetBarcodeCollision(row.barcode, row.code, holder, targetLabel);
    }
  }
}

function targetCodeCollision(code: string, targetLabel: string): ProblemException {
  return new ProblemException(
    'duplicate-sku-code',
    409,
    'SKU code already in use',
    `SKU code "${code}" already exists in client ${targetLabel}'s catalog — the SKU cannot move there while that client holds the code.`,
  );
}

function targetBarcodeCollision(
  barcode: string,
  code: string,
  holder: string | null,
  targetLabel: string,
): ProblemException {
  return new ProblemException(
    'duplicate-barcode',
    409,
    'Barcode already in use',
    `Barcode "${barcode}" of SKU "${code}" already belongs to ` +
      (holder === null ? `another SKU of client ${targetLabel}` : `SKU "${holder}" of client ${targetLabel}`) +
      ' — the SKU cannot move there while that client holds the barcode.',
  );
}

/** Which kinds of history the SKU carries (empty = none — movable). */
async function skuHistoryInTx(tx: TenantTx, tenantId: string, skuId: string): Promise<string[]> {
  const found: string[] = [];
  for (const source of HISTORY_SOURCES) {
    const where: SQL | undefined = and(eq(source.tenantId, tenantId), eq(source.skuId, skuId));
    const rows = await tx.select({ one: source.skuId }).from(source.table).where(where).limit(1);
    if (rows.length > 0) found.push(source.label);
  }
  return found;
}

/**
 * The SKU's group: the transitive closure over kit partners (its kit, its
 * components, their kits' other components) and product siblings. Sorted
 * SKU ids (the lock order) and the product ids involved. Null when the SKU
 * does not exist in the tenant.
 */
async function readGroup(
  tx: TenantTx,
  tenantId: string,
  skuId: string,
): Promise<{ skuIds: string[]; productIds: string[] } | null> {
  const start = await tx
    .select({ id: skus.id })
    .from(skus)
    .where(and(eq(skus.tenantId, tenantId), eq(skus.id, skuId)))
    .limit(1);
  if (start.length === 0) {
    return null;
  }
  const members = new Set<string>([skuId]);
  const productIds = new Set<string>();
  let frontier = [skuId];
  while (frontier.length > 0) {
    const next = new Set<string>();
    const kitRows = await tx
      .select({ kitSkuId: kitCompositions.kitSkuId, componentSkuId: kitCompositions.componentSkuId })
      .from(kitCompositions)
      .where(
        and(
          eq(kitCompositions.tenantId, tenantId),
          or(inArray(kitCompositions.kitSkuId, frontier), inArray(kitCompositions.componentSkuId, frontier)),
        ),
      );
    for (const row of kitRows) {
      next.add(row.kitSkuId);
      next.add(row.componentSkuId);
    }
    const kitIds = [...new Set(kitRows.map((row) => row.kitSkuId))];
    if (kitIds.length > 0) {
      const siblings = await tx
        .select({ componentSkuId: kitCompositions.componentSkuId })
        .from(kitCompositions)
        .where(and(eq(kitCompositions.tenantId, tenantId), inArray(kitCompositions.kitSkuId, kitIds)));
      for (const row of siblings) next.add(row.componentSkuId);
    }
    const productRows = await tx
      .select({ productId: skus.productId })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, frontier)));
    const newProducts = productRows
      .map((row) => row.productId)
      .filter((id): id is string => id !== null && !productIds.has(id));
    for (const id of newProducts) productIds.add(id);
    if (newProducts.length > 0) {
      const variants = await tx
        .select({ id: skus.id })
        .from(skus)
        .where(and(eq(skus.tenantId, tenantId), inArray(skus.productId, newProducts)));
      for (const row of variants) next.add(row.id);
    }
    frontier = [...next].filter((id) => !members.has(id));
    for (const id of frontier) members.add(id);
  }
  return { skuIds: [...members].sort(), productIds: [...productIds].sort() };
}
