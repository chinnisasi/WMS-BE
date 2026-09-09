import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  idempotencyKeys,
  purchaseOrderLines,
  purchaseOrders,
  skus,
  vendors,
} from '../../shared/db/schema';
import type { PurchaseOrderLine } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { assertUtcIso, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';

export interface PoLineInput {
  readonly skuId: string;
  /** Ordered quantity in base UoM — a positive integer. */
  readonly orderedQty: number;
  /** Unit cost as integer paise (AD-9) — never a float. */
  readonly unitCostPaise: number;
  readonly expectedDate?: string | undefined;
}

export interface CreatePoCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly vendorId: string;
  readonly code: string;
  readonly lines: readonly PoLineInput[];
}

export interface AmendPoCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly poId: string;
  /**
   * The complete new line set: entries with an `id` update that existing line
   * (unknown id → 404), entries without one are added, and existing lines
   * absent from the request are removed. `receivedQty` is never touched.
   */
  readonly lines: readonly (PoLineInput & { readonly id?: string })[];
}

export interface ClosePoDisposition {
  readonly lineId: string;
  readonly disposition: 'cancelled' | 'carried';
}

export interface ClosePoCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly poId: string;
  /** One disposition per PO line — close is total. */
  readonly lines: readonly ClosePoDisposition[];
}

/** One PO line as every surface returns it — ordered / received / open always present. */
export interface PurchaseOrderLineSnapshot {
  readonly id: string;
  readonly poId: string;
  readonly skuId: string;
  readonly orderedQty: number;
  readonly receivedQty: number;
  /** Derived: orderedQty − receivedQty — never stored, computed at every read. */
  readonly openQty: number;
  readonly unitCostPaise: number;
  readonly expectedDate: string | null;
  readonly status: string;
  readonly createdAt: string;
}

/** The API response body for a PO (the idempotency snapshot). */
export interface PurchaseOrderSnapshot {
  readonly purchaseOrder: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly vendorId: string;
    readonly code: string;
    readonly status: 'open' | 'closed';
    readonly carriedFromPoId: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lines: readonly PurchaseOrderLineSnapshot[];
  };
}

/** The close response: the closed PO plus the auto-created carried successor. */
export interface ClosePoSnapshot {
  readonly purchaseOrder: PurchaseOrderSnapshot['purchaseOrder'];
  readonly successor: PurchaseOrderSnapshot['purchaseOrder'] | null;
}

/** The deliberately two-valued PO lifecycle (text + hand-appended CHECK; no pgEnum). */
export const PO_STATUSES = ['open', 'closed'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

const PURCHASE_ORDERS_TENANT_CODE = 'purchase_orders_tenant_id_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** A line's client-facing fields with a fixed key order (the idempotency hash is key-order dependent). */
function lineFingerprint(line: PoLineInput & { id?: string }): Record<string, unknown> {
  return {
    id: line.id,
    skuId: line.skuId,
    orderedQty: line.orderedQty,
    unitCostPaise: line.unitCostPaise,
    expectedDate: line.expectedDate,
  };
}

/**
 * `expectedDate` is optional but must be a well-formed UTC instant — 400
 * otherwise (it reaches a `::timestamptz` cast through Drizzle).
 */
function normalizedExpectedDate(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  try {
    return assertUtcIso(value);
  } catch {
    throw new ProblemException(
      'validation-failed',
      400,
      'expectedDate must be a valid ISO-8601 UTC instant',
      `expectedDate must be a Z-suffixed ISO-8601 UTC timestamp (got "${value}").`,
    );
  }
}

/**
 * The PO lifecycle (Story 3.1): create / amend / close, following the
 * established command invariant order inside `withTenantTransaction` —
 * `assertPermission` (fresh DB role read) → idempotency replay lookup →
 * master-data asserts → write → in-tx outbox append → idempotency-key insert
 * with payload hash + response snapshot (replay returns the stored snapshot;
 * hash mismatch → 422 `idempotency-key-reuse`; concurrent insert → 409
 * `conflict`).
 *
 * Status lifecycle is deliberately two-valued (`open` → `closed`): amend is
 * permitted only while `open`, close takes a per-line disposition
 * (`cancelled` or `carried`), and `carried` open quantities auto-create ONE
 * successor open PO (same vendor/warehouse, a unique code derived from the
 * original, `carriedFromPoId` set) — the human decision 2026-09-09. Received
 * quantities are never touched here (3.3's GRN commands own the receipt
 * path); `openQty` is always derived (`ordered − received`), never stored.
 * No ledger writes — a PO is not stock.
 */
@Injectable()
export class PurchaseOrderCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async create(command: CreatePoCommand, idempotencyKey: string): Promise<PurchaseOrderSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      vendorId: command.vendorId,
      code: command.code,
      lines: command.lines.map(lineFingerprint),
    });

    const { snapshot } = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority at command-service entry — DB role read, same tx, BEFORE
      // the replay lookup (the deliberate fail-closed carve-out).
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'po.manage',
      );

      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return { snapshot: replay as PurchaseOrderSnapshot, replayed: true };
      }

      // Master-data integrity in the write transaction (no FK repo
      // convention): warehouse in tenant, vendor in tenant, every line's SKU
      // in tenant — a foreign or nonexistent scope is 404 before any write.
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      await this.assertVendorInTenant(tx, command.tenantId, command.vendorId);
      await this.assertSkuIdsInTenant(
        tx,
        command.tenantId,
        command.lines.map((line) => line.skuId),
      );
      const lineRows = command.lines.map((line) => this.lineInsert(command.tenantId, null, line));

      let po: { id: string };
      try {
        const rows = await tx
          .insert(purchaseOrders)
          .values({
            id: uuidv7(),
            tenantId: command.tenantId,
            warehouseId: command.warehouseId,
            vendorId: command.vendorId,
            code: command.code,
            status: 'open',
          })
          .returning({ id: purchaseOrders.id });
        po = rows[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, PURCHASE_ORDERS_TENANT_CODE)) {
          throw duplicatePoCode(command.code);
        }
        throw err;
      }
      await tx
        .insert(purchaseOrderLines)
        .values(lineRows.map((row) => ({ ...row, poId: po.id })));

      const snapshot = await this.snapshotOf(tx, po.id);

      // In-transaction outbox append (AD-7) — the idempotent replay returned
      // above and a concurrent duplicate's transaction rolls back whole, so
      // a replayed create appends nothing. The payload carries the full
      // post-mutation PO + line snapshot (no read-after-write downstream).
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'po.created',
        occurredAt: nowIso(),
        payload: { purchaseOrder: snapshot.purchaseOrder },
      });

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return { snapshot, replayed: false };
    });

    return snapshot;
  }

  async amend(command: AmendPoCommand, idempotencyKey: string): Promise<PurchaseOrderSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      poId: command.poId,
      lines: command.lines.map(lineFingerprint),
    });

    const { snapshot } = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'po.manage',
      );

      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return { snapshot: replay as PurchaseOrderSnapshot, replayed: true };
      }

      // The PO must exist in this tenant and still be open (409
      // `po-not-open` naming the status otherwise — the I/O matrix).
      const po = await this.loadOpenPo(tx, command.tenantId, command.poId);

      // Every referenced existing line must belong to this PO (404 naming
      // the unknown id); entries without an id are new lines. A repeated id
      // is ambiguous under full-line-set semantics — 400 (mirrors close's
      // duplicate-disposition rule).
      const existingLines = await this.linesOf(tx, po.id);
      const existingById = new Set(existingLines.map((line) => line.id));
      const seenLineIds = new Set<string>();
      for (const line of command.lines) {
        if (line.id === undefined) {
          continue;
        }
        if (seenLineIds.has(line.id)) {
          throw new ProblemException(
            'validation-failed',
            400,
            'Duplicate line update',
            `Line "${line.id}" appears more than once in the amend's line set.`,
          );
        }
        seenLineIds.add(line.id);
        if (!existingById.has(line.id)) {
          throw new ProblemException(
            'not-found',
            404,
            'PO line not found',
            `No line with id "${line.id}" exists on purchase order "${po.code}".`,
          );
        }
      }
      await this.assertSkuIdsInTenant(
        tx,
        command.tenantId,
        command.lines.map((line) => line.skuId),
      );

      // Removals first (lines absent from the request are removed), then
      // updates in place — `received_qty` is never touched by an amend.
      const requestedIds = new Set(
        command.lines.filter((line) => line.id !== undefined).map((line) => line.id!),
      );
      const removedIds = existingLines
        .map((line) => line.id)
        .filter((lineId) => !requestedIds.has(lineId));
      if (removedIds.length > 0) {
        await tx.delete(purchaseOrderLines).where(inArray(purchaseOrderLines.id, removedIds));
      }
      for (const line of command.lines) {
        if (line.id === undefined) {
          continue;
        }
        await tx
          .update(purchaseOrderLines)
          .set({
            skuId: line.skuId,
            orderedQty: line.orderedQty,
            unitCostPaise: line.unitCostPaise,
            expectedDate: normalizedExpectedDate(line.expectedDate),
            updatedAt: nowIso(),
          })
          .where(eq(purchaseOrderLines.id, line.id));
      }
      const added = command.lines
        .filter((line) => line.id === undefined)
        .map((line) => this.lineInsert(command.tenantId, po.id, line));
      if (added.length > 0) {
        await tx.insert(purchaseOrderLines).values(added);
      }
      // The mutation touches the PO (its `updatedAt` rides the list/detail
      // reads) even though only lines changed.
      await tx
        .update(purchaseOrders)
        .set({ updatedAt: nowIso() })
        .where(eq(purchaseOrders.id, po.id));

      const snapshot = await this.snapshotOf(tx, po.id);

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'po.amended',
        occurredAt: nowIso(),
        payload: { purchaseOrder: snapshot.purchaseOrder },
      });

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return { snapshot, replayed: false };
    });

    return snapshot;
  }

  async close(command: ClosePoCommand, idempotencyKey: string): Promise<ClosePoSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      poId: command.poId,
      lines: command.lines.map((line) => ({ lineId: line.lineId, disposition: line.disposition })),
    });

    const { snapshot } = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'po.manage',
      );

      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return { snapshot: replay as ClosePoSnapshot, replayed: true };
      }

      // Already closed → 409 `po-not-open` naming the status (the stored
      // replay above re-serves the original close's snapshot first).
      const po = await this.loadOpenPo(tx, command.tenantId, command.poId);
      const existingLines = await this.linesOf(tx, po.id);

      // Close is total: one disposition per line, no duplicates, no unknown
      // ids, no missing lines.
      const dispositionByLineId = new Map<string, ClosePoDisposition>();
      for (const line of command.lines) {
        if (dispositionByLineId.has(line.lineId)) {
          throw new ProblemException(
            'validation-failed',
            400,
            'Duplicate line disposition',
            `Line "${line.lineId}" carries more than one disposition.`,
          );
        }
        dispositionByLineId.set(line.lineId, line);
      }
      const existingById = new Map(existingLines.map((line) => [line.id, line]));
      for (const lineId of dispositionByLineId.keys()) {
        if (!existingById.has(lineId)) {
          throw new ProblemException(
            'not-found',
            404,
            'PO line not found',
            `No line with id "${lineId}" exists on purchase order "${po.code}".`,
          );
        }
      }
      for (const line of existingLines) {
        if (!dispositionByLineId.has(line.id)) {
          throw new ProblemException(
            'validation-failed',
            400,
            'Missing line disposition',
            `Close is total — line "${line.id}" of purchase order "${po.code}" has no disposition.`,
          );
        }
      }

      // Carried lines move their open quantity (ordered − received) to the
      // successor; a carried line with nothing left to carry is a client
      // error — cancel it instead (ordered_qty must stay a positive integer).
      const carried = existingLines.filter(
        (line) => dispositionByLineId.get(line.id)!.disposition === 'carried',
      );
      for (const line of carried) {
        if (line.orderedQty - line.receivedQty <= 0) {
          throw new ProblemException(
            'validation-failed',
            400,
            'Nothing left to carry',
            `Line "${line.id}" has no open quantity to carry — cancel it instead.`,
          );
        }
      }

      let successor: ClosePoSnapshot['successor'] = null;
      if (carried.length > 0) {
        // Carried = successor (human decision 2026-09-09): ONE successor open
        // PO, same vendor/warehouse, a unique code derived from the original,
        // `carriedFromPoId` referencing the closed original.
        const successorId = uuidv7();
        const successorCode = await this.deriveSuccessorCode(tx, command.tenantId, po.code);
        await tx.insert(purchaseOrders).values({
          id: successorId,
          tenantId: command.tenantId,
          warehouseId: po.warehouseId,
          vendorId: po.vendorId,
          code: successorCode,
          status: 'open',
          carriedFromPoId: po.id,
        });
        await tx.insert(purchaseOrderLines).values(
          carried.map((line) => ({
            id: uuidv7(),
            tenantId: command.tenantId,
            poId: successorId,
            skuId: line.skuId,
            // The carried OPEN quantity; received starts over on the successor.
            orderedQty: line.orderedQty - line.receivedQty,
            receivedQty: 0,
            unitCostPaise: line.unitCostPaise,
            expectedDate: line.expectedDate,
            status: 'open',
          })),
        );
        successor = (await this.snapshotOf(tx, successorId)).purchaseOrder;
      }

      // The original: status → closed, lines carry their dispositions.
      // Received quantities are never touched by close.
      await tx
        .update(purchaseOrders)
        .set({ status: 'closed', updatedAt: nowIso() })
        .where(eq(purchaseOrders.id, po.id));
      for (const line of existingLines) {
        await tx
          .update(purchaseOrderLines)
          .set({ status: dispositionByLineId.get(line.id)!.disposition })
          .where(eq(purchaseOrderLines.id, line.id));
      }

      const closed = await this.snapshotOf(tx, po.id);

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'po.closed',
        occurredAt: nowIso(),
        payload: {
          purchaseOrder: closed.purchaseOrder,
          successor: successor ?? null,
        },
      });

      const closeSnapshot: ClosePoSnapshot = { purchaseOrder: closed.purchaseOrder, successor };
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, closeSnapshot);
      return { snapshot: closeSnapshot, replayed: false };
    });

    return snapshot;
  }

  // ── shared pieces ─────────────────────────────────────────────────────────

  /** The stored snapshot for (tenant, key) — null when the key is fresh. */
  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<unknown | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)),
      )
      .limit(1);
    const row = existing[0];
    if (row === undefined) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return row.responseSnapshot;
  }

  private async writeIdempotencyKey(
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
        // Concurrent duplicate of the same idempotent request — the winner's
        // response is authoritative; this request carries no new state.
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

  /** The PO row of the mutation, locked against concurrent lifecycle changes. */
  private async loadOpenPo(tx: TenantTx, tenantId: string, poId: string): Promise<PurchaseOrderRow> {
    const rows = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.tenantId, tenantId)))
      .limit(1)
      .for('update');
    const po = rows[0];
    if (po === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'Purchase order not found',
        `No purchase order with id "${poId}" exists in this tenant.`,
      );
    }
    if (po.status !== 'open') {
      throw poNotOpen(po.code, po.status as PoStatus);
    }
    return po;
  }

  private async assertVendorInTenant(tx: TenantTx, tenantId: string, vendorId: string): Promise<void> {
    const rows = await tx
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.tenantId, tenantId)))
      .limit(1);
    if (rows[0] === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'Vendor not found',
        'No vendor with this id exists in this tenant.',
      );
    }
  }

  /** Every line's SKU must exist in the tenant (integrity-only read, 404 naming the unknown id). */
  private async assertSkuIdsInTenant(
    tx: TenantTx,
    tenantId: string,
    skuIds: readonly string[],
  ): Promise<void> {
    const distinct = [...new Set(skuIds)];
    if (distinct.length === 0) {
      return;
    }
    const rows = await tx
      .select({ id: skus.id })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, distinct)));
    const found = new Set(rows.map((row) => row.id));
    for (const skuId of distinct) {
      if (!found.has(skuId)) {
        throw new ProblemException(
          'not-found',
          404,
          'SKU not found',
          `No SKU with id "${skuId}" exists in this tenant.`,
        );
      }
    }
  }

  /**
   * The unique successor code (the original code + `-C{n}`, first free n —
   * the unique `(tenant, code)` index is the race backstop, and the locked
   * original means two concurrent closes of the same PO cannot both get
   * here anyway).
   */
  private async deriveSuccessorCode(tx: TenantTx, tenantId: string, originalCode: string): Promise<string> {
    // Keep the derived code inside the DTO's 64-char bound: `-C99` needs 4.
    const base = originalCode.slice(0, 60);
    for (let n = 1; n < 100; n += 1) {
      const candidate = `${base}-C${n}`;
      const taken = await tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.code, candidate)))
        .limit(1);
      if (taken.length === 0) {
        return candidate;
      }
    }
    throw new ProblemException(
      'conflict',
      409,
      'No free successor code',
      `Every derived successor code of "${originalCode}" is taken — free one up or close with only cancellations.`,
    );
  }

  /** The post-mutation PO + lines as one snapshot (openQty derived, instants canonical). */
  private async snapshotOf(tx: TenantTx, poId: string): Promise<PurchaseOrderSnapshot> {
    const poRows = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, poId))
      .limit(1);
    const po = poRows[0]!;
    const lines = await this.linesOf(tx, poId);
    return {
      purchaseOrder: {
        id: po.id,
        tenantId: po.tenantId,
        warehouseId: po.warehouseId,
        vendorId: po.vendorId,
        code: po.code,
        status: po.status as PoStatus,
        carriedFromPoId: po.carriedFromPoId,
        createdAt: canonicalInstant(po.createdAt),
        updatedAt: canonicalInstant(po.updatedAt),
        lines,
      },
    };
  }

  /** The PO's lines, oldest first (the detail read's order — the (po_id, created_at, id) index). */
  private async linesOf(tx: TenantTx, poId: string): Promise<PurchaseOrderLineSnapshot[]> {
    const rows = await tx
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.poId, poId))
      .orderBy(purchaseOrderLines.createdAt, purchaseOrderLines.id);
    return rows.map(lineSnapshot);
  }

  /** One line insert row (received ships at 0; expected date UTC-normalized). */
  private lineInsert(
    tenantId: string,
    poId: string | null,
    line: PoLineInput & { id?: string },
  ): PurchaseOrderLineInsert {
    return {
      id: uuidv7(),
      tenantId,
      poId: poId!,
      skuId: line.skuId,
      orderedQty: line.orderedQty,
      receivedQty: 0,
      unitCostPaise: line.unitCostPaise,
      expectedDate: normalizedExpectedDate(line.expectedDate),
      status: 'open',
    };
  }
}

/** Insert-shape alias (the create path fills `poId` after the PO row exists). */
type PurchaseOrderLineInsert = Omit<PurchaseOrderLine, 'createdAt' | 'updatedAt'>;

/** The raw PO row as Drizzle selects it (raw instants). */
type PurchaseOrderRow = typeof purchaseOrders.$inferSelect;

/** One stored line as every read of this module returns it — open derived, instants canonical. */
export function lineSnapshot(row: PurchaseOrderLine): PurchaseOrderLineSnapshot {
  return {
    id: row.id,
    poId: row.poId,
    skuId: row.skuId,
    orderedQty: row.orderedQty,
    receivedQty: row.receivedQty,
    openQty: row.orderedQty - row.receivedQty,
    unitCostPaise: row.unitCostPaise,
    expectedDate: row.expectedDate === null ? null : canonicalInstant(row.expectedDate),
    status: row.status,
    createdAt: canonicalInstant(row.createdAt),
  };
}

export function poNotOpen(code: string, status: PoStatus): ProblemException {
  return new ProblemException(
    'po-not-open',
    409,
    'Purchase order is not open',
    `Purchase order "${code}" is ${status} — only an open PO can be amended or closed.`,
  );
}

function duplicatePoCode(code: string): ProblemException {
  return new ProblemException(
    'conflict',
    409,
    'Purchase order code already in use',
    `Purchase order code "${code}" already exists for this tenant.`,
  );
}

/**
 * Postgres returns `timestamptz` in its own text shape; the read contract is
 * ISO-8601 UTC (the repo-wide instant normalization).
 */
function canonicalInstant(value: string): string {
  return new Date(value).toISOString();
}