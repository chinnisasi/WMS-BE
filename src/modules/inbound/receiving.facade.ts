import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  advanceShipmentNotices,
  asnLines,
  goodsReceiptLines,
  goodsReceiptNotes,
  overReceipts,
  purchaseOrderLines,
  purchaseOrders,
  skus as skusTable,
} from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { skuOfClient } from '../../shared/db/client-filter';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { PutawayFacade } from '../putaway/putaway.facade';
import { ReceivingCommand } from './receiving.command';
import type {
  DecideOverReceiptCommand,
  GoodsReceiptSnapshot,
  OverReceiptDecisionSnapshot,
  RefusedReceiptSnapshot,
  SubmitGoodsReceiptCommand,
} from './receiving.command';
import { CatalogFacade } from '../catalog/catalog.facade';
import type { PurchaseOrderLineSnapshot } from './po.command';
import { lineSnapshot } from './po.command';
import type { OverReceiptEntry } from './receiving.command';
import { canonicalInstant, fullPrecisionInstant } from '../../shared/primitives/time';
import { fromMilli } from '../../shared/primitives/quantity';
import { OPEN_ASN_STATUSES, asnLineSnapshot, type AsnLineSnapshot } from './asn.command';
import { partnerNamesInTx, type VendorSnapshotV1 } from '../partners/partners.facade';
import { gateInLabelsInTx, openGateInsInTx, type OpenGateInView } from './gate-in.read';
import { gateInClock } from './gate-in.command';
import { AttachmentsFacade, MAX_IMAGE_BYTES } from '../attachments/attachments.facade';
import {
  ReceiptPhotoCommand,
  type DeviceUploadCommand,
  type DeviceUploadSnapshot,
  type ReceiptPhotoList,
  type ReceiptPhotoSnapshot,
  type RemoveCommand,
  type WebAddCommand,
} from './receipt-photo.command';
import {
  photoCountsByParentInTx,
  RECEIPT_PHOTOS_MAX_PER_LINE,
  RECEIPT_PHOTOS_MAX_PER_RECEIPT,
} from '../attachments/attachment-records';
import { DAMAGE_REASON_CODES, SHORT_REASON_CODES } from './receipt-condition';

/** One GRN header row of the GRN-list read (line counts + unit sums ride along). */
export interface GoodsReceiptEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly poId: string | null;
  /** Story 21-6 — present only on an ASN receipt. */
  readonly asnId?: string;
  readonly asnCode?: string;
  /** Story 1-1 — the receipt's client; absent on an older receipt 0076 could not attribute. */
  readonly clientId?: string;
  readonly blindReasonCode: string | null;
  /** Story 2-3a — the linked gate-in (id, code, and its vehicle when it has one); absent when unlinked. */
  readonly gateInId?: string;
  readonly gateInCode?: string;
  readonly vehicleNo?: string;
  readonly status: string;
  readonly recordedBy: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly createdAt: string;
  readonly lineCount: number;
  readonly totalUnits: number;
  readonly appliedUnits: number;
  /** Story 2-4a — damaged units across the lines (base units; 0 when none). */
  readonly damagedUnits: number;
  /** Story 2-4a — short units across the lines (base units; 0 when none). */
  readonly shortUnits: number;
  /** Story 2-5a — attached damage photos across the lines. */
  readonly photoCount: number;
}

/**
 * Story 2-4a — one line of a GRN as the web's expandable row reads it: the
 * SKU and batch named, the good units and what applied, and the line's
 * condition (each damaged / short key present only when > 0). Base units.
 */
export interface GoodsReceiptLineEntry {
  readonly id: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly batchId: string | null;
  readonly batchCode: string | null;
  readonly qty: number;
  readonly appliedQty: number;
  readonly damagedQty?: number;
  readonly damageReasonCode?: string;
  readonly shortQty?: number;
  readonly shortReasonCode?: string;
  /** Story 2-5a — attached damage photos, and those the receipt named that have not arrived. */
  readonly photoCount: number;
  readonly pendingPhotoCount: number;
}

export interface ListGoodsReceiptsQuery {
  readonly warehouseId?: string | undefined;
  /**
   * Story 1-5a — only one client's receipts: its own `client_id`, or (a legacy
   * receipt the 1-1 backfill left unattributed) any line of the client's SKUs.
   */
  readonly clientId?: string | undefined;
  /**
   * Story 21-6 — `true`: blind receipts only (`blind_reason_code IS NOT
   * NULL` — no PO and no ASN); `false`: document-backed only. (9-1's
   * `poless` is its alias at the controller.)
   */
  readonly blind?: boolean | undefined;
  /** Story 9-1 — `[from, to)` on `created_at` (server time). */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListOverReceiptsQuery {
  readonly status?: 'pending' | 'approved' | 'rejected' | undefined;
  /** Story 1-5a — only over-receipts of one client's SKUs. */
  readonly clientId?: string | undefined;
  /** Story 9-1 — one warehouse (asserted in-tenant first). */
  readonly warehouseId?: string | undefined;
  /** Story 9-1 — `[from, to)` on `requested_at` (server time — stamped at the GRN's own commit). */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The device catalog snapshot (AD-4): the sealed offline decision surface. */
export interface CatalogSnapshot {
  readonly generatedAt: string;
  readonly warehouseId: string;
  readonly skus: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly barcode: string;
    readonly uom: string;
    /** Story 10.2: the decimal places `uom` declares — the device's offline precision gate. */
    readonly uomPrecision: number;
    readonly batchTracked: boolean;
    readonly serialTracked: boolean;
    /** Story 10.3: handled by unit, priced by weight — the device's offline catch-weight prompt. */
    readonly catchWeightTracked: boolean;
    /**
     * Story 11.7: the SKU's values on its product's declared variant axes —
     * null when the SKU is unattached. Third mirror of the `SkuSummary` arm
     * (10.2/10.3 precedent): keep in lockstep or this mirror ships stale.
     */
    readonly variantValues: Record<string, string> | null;
    /** Story 11.7: the attached product's declared axes, in declaration order. Null when unattached. */
    readonly axes: string[] | null;
    /**
     * Story 12.8 (UX-DR29): the SKU's storage class — the device's offline
     * conformance mirror. Fourth mirror of the `SkuSummary` arm (the
     * 10.2/10.3/11.7 precedent): keep in lockstep or this mirror ships
     * stale. Never null on the wire — the column is NOT NULL DEFAULT
     * `ambient` (0035_storage_class.sql).
     */
    readonly storageClass: string;
    /**
     * Story 1-1: the SKU's client — code and barcode are unique per (tenant,
     * client), so the device resolves within the document's client. Fifth
     * mirror of the `SkuSummary` arm.
     */
    readonly clientId: string;
    /**
     * Story 1-4: the SKU's non-primary barcodes with their level and factor
     * (1 at the base uom). Sixth mirror of the `SkuSummary` arm.
     */
    readonly packBarcodes: readonly { readonly barcode: string; readonly uom: string; readonly factor: number }[];
    /** Story 1-4b: `active | inactive` — the handheld's inactive receive-scan warning. Seventh mirror. */
    readonly status: 'active' | 'inactive';
    /** Story 1-6a: the handling warnings (fragile, high value, stack limit, DG). Eighth mirror. */
    readonly fragile: boolean;
    readonly highValue: boolean;
    readonly maxStackLayers: number | null;
    readonly dg: {
      readonly unNumber: string;
      readonly class: string;
      readonly subsidiaryClasses: readonly string[];
      readonly packingGroup: string | null;
    } | null;
    /** Story 3-1: a kit holds no stock — the handheld refuses a move of it offline (3-5a: and a found kit in a count). Ninth mirror. */
    readonly isKit: boolean;
  }[];
  readonly openPurchaseOrders: readonly {
    readonly id: string;
    readonly code: string;
    /** Story 1-1 — the PO's client. */
    readonly clientId: string;
    readonly warehouseId: string;
    readonly vendorId: string;
    /** Story 1-3 — the vendor's name as the PO froze it (the receive card shows it). */
    readonly vendorName: string;
    readonly lines: readonly PurchaseOrderLineSnapshot[];
  }[];
  /** Story 21-6 (additive): the warehouse's open ASNs (announced or partially received). */
  readonly openAsns: readonly {
    readonly id: string;
    readonly code: string;
    readonly clientId: string;
    readonly warehouseId: string;
    readonly expectedAt: string | null;
    readonly lines: readonly AsnLineSnapshot[];
  }[];
  // ── Story 3.5 (additive): the putaway decision fields ────────────────────
  /** Every bin of the warehouse (blocked/system bins INCLUDED — the device needs them to reject a scan against them pre-queue). */
  readonly bins: readonly {
    readonly id: string;
    readonly code: string;
    readonly zoneId: string;
    readonly zoneCode: string;
    readonly type: string;
    readonly capacity: number;
    readonly blocked: boolean;
    readonly systemOwned: boolean;
    /** Story 12.8 (UX-DR29): the bin's storage class — the device's offline conformance mirror. Never null on the wire (the column defaults to `ambient`). */
    readonly storageClass: string;
    /** Story 1-5b: the bin's dedicated client (null = shared) — the device's offline client-gate mirror. */
    readonly dedicatedClientId: string | null;
  }[];
  /** The derived putaway tasks (suggestions baked in are advisory — the server re-derives and re-gates at placement). */
  readonly putawayTasks: readonly {
    readonly grnId: string;
    readonly grnCode: string;
    readonly grnLineId: string;
    readonly skuId: string;
    readonly skuCode: string;
    readonly batchId: string | null;
    readonly batchCode: string | null;
    /** min(applied, receiving-bin on-hand) — the placeable units. */
    readonly qty: number;
    readonly suggestedBin: { readonly binId: string; readonly binCode: string } | null;
    readonly rationale: string;
  }[];
  /** Story 2-3a (additive): the open gate-ins the dock unloads and receives against (decision 15). */
  readonly openGateIns: readonly OpenGateInView[];
  /** Story 2-4a (additive): the damage and short reason vocabularies — the device's gate on its controls. */
  readonly receiptDamageReasons: readonly string[];
  readonly receiptShortReasons: readonly string[];
  /** Story 2-5a (additive): damage photos — storage on, and the draft's caps. */
  readonly receiptPhotos: {
    readonly enabled: boolean;
    readonly maxPerLine: number;
    readonly maxPerReceipt: number;
    readonly maxBytes: number;
  };
}

export const DEFAULT_RECEIVING_PAGE_SIZE = 50;

/**
 * The cursor is opaque to clients but crafted input is still possible — a
 * base64-valid payload with a non-uuid `id` would otherwise reach the
 * `::uuid` cast in SQL and surface as a 500 instead of a 400 (the shared
 * `decodeCursorSafe` pattern of the other read facades).
 */
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    const malformedCursor =
      !UUID_RE.test(decoded.id) ||
      !CURSOR_INSTANT_RE.test(decoded.createdAt) ||
      Number.isNaN(Date.parse(decoded.createdAt));
    if (malformedCursor) {
      throw new Error('malformed cursor payload');
    }
    return decoded;
  } catch {
    throw new ProblemException(
      'invalid-cursor',
      400,
      'Malformed pagination cursor',
      'The cursor parameter is not a valid opaque page cursor.',
    );
  }
}

/**
 * The receiving module's public surface (Story 3.3): the api shell's only
 * seam to the receipt commands and reads — `goods_receipt_notes`,
 * `goods_receipt_lines`, and `over_receipts` are module-exclusive tables.
 */
@Injectable()
export class ReceivingFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ReceivingCommand) private readonly receiving: ReceivingCommand,
    // The device snapshot composes catalog identity + inbound open POs +
    // (Story 3.5, additive) the putaway decision fields — catalog through its
    // facade (its tables stay module-exclusive), the PO lines through this
    // module's own tables, bins + putaway tasks through the putaway facade.
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(PutawayFacade) private readonly putaway: PutawayFacade,
    // Story 2-5a — the snapshot's `receiptPhotos.enabled` (the store's mode).
    @Inject(AttachmentsFacade) private readonly attachments: AttachmentsFacade,
    // Story 2-5a — damage photos (this module's own command).
    @Inject(ReceiptPhotoCommand) private readonly photos: ReceiptPhotoCommand,
  ) {}

  // ── story 2-5a: damage photos on a receipt line ───────────────────────────

  /** The handheld's photo upload (`receipt-photo.stage`; device credential + `x-op-operator`). */
  async uploadReceiptPhoto(command: DeviceUploadCommand, ref: string): Promise<DeviceUploadSnapshot> {
    return this.photos.uploadFromDevice(command, ref);
  }

  /** The web's add (`receipt.attach`). */
  async addReceiptPhoto(command: WebAddCommand, idempotencyKey: string): Promise<ReceiptPhotoSnapshot> {
    return this.photos.addOnWeb(command, idempotencyKey);
  }

  /** Remove, or cancel a placeholder (`receipt.photo-remove`). */
  async removeReceiptPhoto(command: RemoveCommand, idempotencyKey: string): Promise<ReceiptPhotoSnapshot> {
    return this.photos.remove(command, idempotencyKey);
  }

  /** One receipt's photos with presigned URLs (any staff role). */
  async listReceiptPhotos(tenantId: string, grnId: string): Promise<ReceiptPhotoList> {
    return this.photos.listForGrn(tenantId, grnId);
  }

  /** `grn.submit` — the device-authenticated whole-GRN command. */
  async submitGoodsReceipt(
    command: SubmitGoodsReceiptCommand,
    idempotencyKey: string,
  ): Promise<GoodsReceiptSnapshot | RefusedReceiptSnapshot> {
    return this.receiving.submitGoodsReceipt(command, idempotencyKey);
  }

  /** The over-receipt decision (review.decide — approve applies, reject trails). */
  async decideOverReceipt(
    command: DecideOverReceiptCommand,
    idempotencyKey: string,
  ): Promise<OverReceiptDecisionSnapshot> {
    return this.receiving.decideOverReceipt(command, idempotencyKey);
  }

  /**
   * GRN-list read (the Inbound surface): one warehouse's (or the tenant's)
   * goods receipt notes, newest first, keyset cursor pagination, with the
   * per-GRN line count and unit sums folded in a second query (the page's
   * rows only — no full-table aggregate). A read — never capability-gated.
   */
  async listGoodsReceipts(
    tenantId: string,
    query: ListGoodsReceiptsQuery = {},
  ): Promise<Page<GoodsReceiptEntry>> {
    const pageSize = query.limit ?? DEFAULT_RECEIVING_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if (query.warehouseId !== undefined) {
        await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      }
      // The list's own filters + keyset, shared by the outer query and (with
      // a client) by each client branch below.
      const filters = and(
        eq(goodsReceiptNotes.tenantId, tenantId),
        query.warehouseId === undefined
          ? undefined
          : eq(goodsReceiptNotes.warehouseId, query.warehouseId),
        // Story 21-6: blind is the REASON, not the absent PO — an ASN
        // receipt has no PO and is not blind.
        query.blind === undefined
          ? undefined
          : query.blind
            ? sql`${goodsReceiptNotes.blindReasonCode} is not null`
            : sql`${goodsReceiptNotes.blindReasonCode} is null`,
        query.from === undefined ? undefined : sql`${goodsReceiptNotes.createdAt} >= ${query.from}::timestamptz`,
        query.to === undefined ? undefined : sql`${goodsReceiptNotes.createdAt} < ${query.to}::timestamptz`,
        before === undefined
          ? undefined
          : sql`(${goodsReceiptNotes.createdAt}, ${goodsReceiptNotes.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
      );
      // Story 1-5a (decision 9): a GRN is the client's when its own
      // `client_id` is, OR (a legacy receipt the 1-1 backfill left with no
      // client) any line's SKU is. One `OR … EXISTS` predicate cannot walk a
      // client-led index, so each arm is its own keyset-ordered branch,
      // limited to a page — the own-client arm walks 0081's
      // `goods_receipt_notes_tenant_client_[warehouse_]created_at_id_idx` —
      // and the outer page is taken over their union (at most 2 × (page + 1)
      // ids, evaluated ONCE as an array — `= any(array(…))` is an InitPlan
      // the outer probes as an index condition, never a per-row re-scan of
      // the branches). The branches name the table unaliased, so `filters`
      // resolves to the INNER row there.
      const clientIds =
        query.clientId === undefined
          ? undefined
          : sql`${goodsReceiptNotes.id} = any(array((${tx
              .select({ id: goodsReceiptNotes.id })
              .from(goodsReceiptNotes)
              .where(and(filters, eq(goodsReceiptNotes.clientId, query.clientId)))
              .orderBy(desc(goodsReceiptNotes.createdAt), desc(goodsReceiptNotes.id))
              .limit(pageSize + 1)}) union all (${tx
              .select({ id: goodsReceiptNotes.id })
              .from(goodsReceiptNotes)
              .where(
                and(
                  filters,
                  isNull(goodsReceiptNotes.clientId),
                  sql`exists (
                    select 1 from goods_receipt_lines gl
                    where gl.grn_id = ${goodsReceiptNotes.id}
                      and ${skuOfClient(sql`gl.sku_id`, tenantId, query.clientId)}
                  )`,
                ),
              )
              .orderBy(desc(goodsReceiptNotes.createdAt), desc(goodsReceiptNotes.id))
              .limit(pageSize + 1)})))`;
      const rows = await tx
        .select({
          id: goodsReceiptNotes.id,
          tenantId: goodsReceiptNotes.tenantId,
          warehouseId: goodsReceiptNotes.warehouseId,
          code: goodsReceiptNotes.code,
          poId: goodsReceiptNotes.poId,
          asnId: goodsReceiptNotes.asnId,
          asnCode: advanceShipmentNotices.asnCode,
          clientId: goodsReceiptNotes.clientId,
          blindReasonCode: goodsReceiptNotes.blindReasonCode,
          gateInId: goodsReceiptNotes.gateInId,
          status: goodsReceiptNotes.status,
          recordedBy: goodsReceiptNotes.recordedBy,
          occurredAt: goodsReceiptNotes.occurredAt,
          recordedAt: goodsReceiptNotes.recordedAt,
          createdAt: goodsReceiptNotes.createdAt,
          // Story 9-1: the cursor's FULL-precision instant (see listEvents).
          createdAtText: sql<string>`${goodsReceiptNotes.createdAt}::text`,
        })
        .from(goodsReceiptNotes)
        .leftJoin(
          advanceShipmentNotices,
          and(
            eq(advanceShipmentNotices.tenantId, goodsReceiptNotes.tenantId),
            eq(advanceShipmentNotices.id, goodsReceiptNotes.asnId),
          ),
        )
        .where(and(filters, clientIds))
        .orderBy(desc(goodsReceiptNotes.createdAt), desc(goodsReceiptNotes.id))
        .limit(pageSize + 1);
      const ids = rows.map((row) => row.id);
      const aggregates =
        ids.length === 0
          ? new Map<string, { lineCount: number; totalUnits: string; appliedUnits: string; damagedUnits: string; shortUnits: string }>()
          : new Map(
              (
                await tx
                  .select({
                    grnId: goodsReceiptLines.grnId,
                    lineCount: sql<number>`count(*)::int`,
                    // bigint, not int4: a per-GRN sum of max-qty lines
                    // overflows int4, and that must not brick the list read.
                    totalUnits: sql<string>`coalesce(sum(${goodsReceiptLines.qty}), 0)::bigint`,
                    appliedUnits: sql<string>`coalesce(sum(${goodsReceiptLines.appliedQty}), 0)::bigint`,
                    // Story 2-4a — the condition sums, in this same second query.
                    damagedUnits: sql<string>`coalesce(sum(${goodsReceiptLines.damagedQty}), 0)::bigint`,
                    shortUnits: sql<string>`coalesce(sum(${goodsReceiptLines.shortQty}), 0)::bigint`,
                  })
                  .from(goodsReceiptLines)
                  .where(inArray(goodsReceiptLines.grnId, ids))
                  .groupBy(goodsReceiptLines.grnId)
              ).map((row) => [
                row.grnId,
                {
                  lineCount: row.lineCount,
                  totalUnits: row.totalUnits,
                  appliedUnits: row.appliedUnits,
                  damagedUnits: row.damagedUnits,
                  shortUnits: row.shortUnits,
                },
              ]),
            );
      // Story 2-3a — the linked gate-ins' code and vehicle, one read over the page.
      const gateInLabels = await gateInLabelsInTx(
        tx,
        tenantId,
        rows.map((row) => row.gateInId).filter((id): id is string => id !== null),
      );
      // Story 2-5a — the page's attached photo counts, one read.
      const photoCounts = await photoCountsByParentInTx(tx, tenantId, ids);
      const items = rows.map((full) => {
        // `createdAtText` is the cursor-only projection — never in the body.
        const { createdAtText, asnId, asnCode, clientId, gateInId, ...row } = full;
        void createdAtText;
        const gateIn = gateInId === null ? undefined : gateInLabels.get(gateInId);
        return {
        ...row,
        // Story 2-3a: present only on a linked receipt.
        ...(gateInId === null || gateIn === undefined
          ? {}
          : { gateInId, gateInCode: gateIn.code, ...(gateIn.vehicleNo === null ? {} : { vehicleNo: gateIn.vehicleNo }) }),
        // Story 21-6: present only on an ASN receipt.
        ...(asnId === null ? {} : { asnId, ...(asnCode === null ? {} : { asnCode }) }),
        // Story 1-1: absent on an older receipt the backfill left unattributed.
        ...(clientId === null ? {} : { clientId }),
        lineCount: aggregates.get(row.id)?.lineCount ?? 0,
        // int8 arrives as text through postgres.js; the contract is a number.
        // Story 10.1: and a read-model number is in BASE units, not the
        // domain's milli-units.
        totalUnits: fromMilli(Number(aggregates.get(row.id)?.totalUnits ?? 0)),
        appliedUnits: fromMilli(Number(aggregates.get(row.id)?.appliedUnits ?? 0)),
        damagedUnits: fromMilli(Number(aggregates.get(row.id)?.damagedUnits ?? 0)),
        shortUnits: fromMilli(Number(aggregates.get(row.id)?.shortUnits ?? 0)),
        photoCount: photoCounts.get(row.id)?.photoCount ?? 0,
        occurredAt: canonicalInstant(row.occurredAt),
        recordedAt: canonicalInstant(row.recordedAt),
        createdAt: canonicalInstant(row.createdAt),
        };
      });
      return fullPrecisionPage(rows, items, pageSize);
    });
  }

  /**
   * Story 2-4a — one GRN's lines (the web's expandable GRN row), in receipt
   * order: SKU code and name, batch code, good and applied units, and the
   * damaged and short fields (each present only when > 0). Any staff role —
   * a read, never capability-gated. An unknown or another tenant's GRN is a
   * 404.
   */
  async listGoodsReceiptLines(tenantId: string, grnId: string): Promise<GoodsReceiptLineEntry[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const header = await tx
        .select({ id: goodsReceiptNotes.id })
        .from(goodsReceiptNotes)
        .where(and(eq(goodsReceiptNotes.tenantId, tenantId), eq(goodsReceiptNotes.id, grnId)))
        .limit(1);
      if (header[0] === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Goods receipt not found',
          `No goods receipt with id "${grnId}" exists in this tenant.`,
        );
      }
      const rows = await tx
        .select({
          id: goodsReceiptLines.id,
          skuId: goodsReceiptLines.skuId,
          skuCode: skusTable.code,
          skuName: skusTable.name,
          batchId: goodsReceiptLines.batchId,
          qty: goodsReceiptLines.qty,
          appliedQty: goodsReceiptLines.appliedQty,
          damagedQty: goodsReceiptLines.damagedQty,
          damageReasonCode: goodsReceiptLines.damageReasonCode,
          shortQty: goodsReceiptLines.shortQty,
          shortReasonCode: goodsReceiptLines.shortReasonCode,
        })
        .from(goodsReceiptLines)
        .innerJoin(skusTable, and(eq(skusTable.tenantId, goodsReceiptLines.tenantId), eq(skusTable.id, goodsReceiptLines.skuId)))
        .where(and(eq(goodsReceiptLines.tenantId, tenantId), eq(goodsReceiptLines.grnId, grnId)))
        .orderBy(goodsReceiptLines.createdAt, goodsReceiptLines.id);
      const batchCodes = await this.catalog.batchCodesByIdsInTx(
        tx,
        tenantId,
        [...new Set(rows.map((row) => row.batchId).filter((id): id is string => id !== null))],
      );
      const photos = (await photoCountsByParentInTx(tx, tenantId, [grnId])).get(grnId)?.byLine;
      return rows.map((row) => ({
        id: row.id,
        skuId: row.skuId,
        skuCode: row.skuCode,
        skuName: row.skuName,
        batchId: row.batchId,
        batchCode: row.batchId === null ? null : (batchCodes.get(row.batchId) ?? null),
        // Read model — base units at the edge (story 10.1).
        qty: fromMilli(row.qty),
        appliedQty: fromMilli(row.appliedQty),
        ...(row.damagedQty > 0 ? { damagedQty: fromMilli(row.damagedQty) } : {}),
        ...(row.damagedQty > 0 && row.damageReasonCode !== null ? { damageReasonCode: row.damageReasonCode } : {}),
        ...(row.shortQty > 0 ? { shortQty: fromMilli(row.shortQty) } : {}),
        ...(row.shortQty > 0 && row.shortReasonCode !== null ? { shortReasonCode: row.shortReasonCode } : {}),
        photoCount: photos?.get(row.id)?.photoCount ?? 0,
        pendingPhotoCount: photos?.get(row.id)?.pendingPhotoCount ?? 0,
      }));
    });
  }

  /**
   * Over-receipt-list read (the Conflicts & Reviews queue): the tenant's
   * over-receipts, newest first, status-filterable, with the GRN code joined
   * for the approval cards. A read — never capability-gated (the deciding
   * mutations are; the surface hides behind `review.decide`).
   */
  async listOverReceipts(
    tenantId: string,
    query: ListOverReceiptsQuery = {},
  ): Promise<Page<OverReceiptEntry>> {
    const pageSize = query.limit ?? DEFAULT_RECEIVING_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      if (query.warehouseId !== undefined) {
        await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      }
      const rows = await tx
        .select({
          overReceipt: overReceipts,
          grnCode: goodsReceiptNotes.code,
          asnCode: advanceShipmentNotices.asnCode,
          // Story 9-1: one GRN commits all its over-receipts in ONE
          // transaction (one shared `now()`), so the cursor must carry the
          // full-precision instant or the next page skips the tie group.
          createdAtText: sql<string>`${overReceipts.createdAt}::text`,
        })
        .from(overReceipts)
        .innerJoin(goodsReceiptNotes, eq(goodsReceiptNotes.id, overReceipts.grnId))
        .leftJoin(
          advanceShipmentNotices,
          and(
            eq(advanceShipmentNotices.tenantId, overReceipts.tenantId),
            eq(advanceShipmentNotices.id, overReceipts.asnId),
          ),
        )
        .where(
          and(
            eq(overReceipts.tenantId, tenantId),
            query.status === undefined ? undefined : eq(overReceipts.status, query.status),
            query.warehouseId === undefined ? undefined : eq(overReceipts.warehouseId, query.warehouseId),
            // Story 1-5a: through the SKU (never the GRN — a legacy receipt has no client).
            query.clientId === undefined ? undefined : skuOfClient(overReceipts.skuId, tenantId, query.clientId),
            query.from === undefined ? undefined : sql`${overReceipts.requestedAt} >= ${query.from}::timestamptz`,
            query.to === undefined ? undefined : sql`${overReceipts.requestedAt} < ${query.to}::timestamptz`,
            before === undefined
              ? undefined
              : sql`(${overReceipts.createdAt}, ${overReceipts.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(overReceipts.createdAt), desc(overReceipts.id))
        .limit(pageSize + 1);
      const items = rows.map(({ overReceipt: row, grnCode, asnCode }) => ({
        id: row.id,
        tenantId: row.tenantId,
        warehouseId: row.warehouseId,
        grnId: row.grnId,
        grnCode,
        grnLineId: row.grnLineId,
        poId: row.poId,
        poLineId: row.poLineId,
        // Story 21-6: present only on an ASN receipt's over-receipt.
        ...(row.asnId === null ? {} : { asnId: row.asnId }),
        ...(row.asnLineId === null ? {} : { asnLineId: row.asnLineId }),
        ...(asnCode === null ? {} : { asnCode }),
        skuId: row.skuId,
        // Read model — base units at the edge (story 10.1).
        excessQty: fromMilli(row.excessQty),
        status: row.status as OverReceiptEntry['status'],
        requestedBy: row.requestedBy,
        requestedAt: canonicalInstant(row.requestedAt),
        decidedBy: row.decidedBy,
        decidedAt: row.decidedAt === null ? null : canonicalInstant(row.decidedAt),
        createdAt: canonicalInstant(row.createdAt),
      }));
      return fullPrecisionPage(rows, items, pageSize);
    });
  }

  /**
   * The device catalog snapshot (AD-4): the sealed offline decision surface —
   * every SKU's scan identity plus the warehouse's open POs with per-line
   * ordered / received / open quantities. Composed for a badge-in device
   * while online; the server gate at replay stays the authority (a stale
   * cache mirrors, never overrides).
   */
  async getCatalogSnapshot(tenantId: string, warehouseId: string): Promise<CatalogSnapshot> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      // Catalog identity through the catalog facade (module-exclusive
      // tables), on THIS transaction — the last of the four snapshot reads to
      // stop opening its own. The whole endpoint now runs on one connection,
      // so it cannot queue behind itself, and the snapshot is one consistent
      // read rather than several MVCC snapshots stitched together.
      const skus = await this.catalog.getSkuSummariesInTx(tx, tenantId);
      const poRows = await tx
        .select({
          id: purchaseOrders.id,
          code: purchaseOrders.code,
          // Story 1-1 — the device resolves an unmatched scan within it.
          clientId: purchaseOrders.clientId,
          warehouseId: purchaseOrders.warehouseId,
          vendorId: purchaseOrders.vendorId,
          vendorSnapshot: purchaseOrders.vendorSnapshot,
        })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, tenantId),
            eq(purchaseOrders.warehouseId, warehouseId),
            eq(purchaseOrders.status, 'open'),
          ),
        )
        .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id));
      const lineRows =
        poRows.length === 0
          ? []
          : await tx
              .select()
              .from(purchaseOrderLines)
              .where(inArray(purchaseOrderLines.poId, poRows.map((po) => po.id)))
              .orderBy(purchaseOrderLines.createdAt, purchaseOrderLines.id);
      // Story 1-3 — the vendor's name: the PO's frozen snapshot (every PO
      // carries one since 0079); the live partner name only as a fallback.
      const liveNames = await partnerNamesInTx(
        tx,
        tenantId,
        poRows.filter((po) => po.vendorSnapshot === null).map((po) => po.vendorId),
      );
      const linesByPo = new Map<string, PurchaseOrderLineSnapshot[]>();
      for (const line of lineRows) {
        const list = linesByPo.get(line.poId) ?? [];
        list.push(lineSnapshot(line));
        linesByPo.set(line.poId, list);
      }
      // Story 21-6: the warehouse's open ASNs — a direct read on THIS
      // transaction (the module's own tables; no nested connection).
      const asnRows = await tx
        .select({
          id: advanceShipmentNotices.id,
          code: advanceShipmentNotices.asnCode,
          clientId: advanceShipmentNotices.clientId,
          warehouseId: advanceShipmentNotices.warehouseId,
          expectedAt: advanceShipmentNotices.expectedAt,
        })
        .from(advanceShipmentNotices)
        .where(
          and(
            eq(advanceShipmentNotices.tenantId, tenantId),
            eq(advanceShipmentNotices.warehouseId, warehouseId),
            inArray(advanceShipmentNotices.status, [...OPEN_ASN_STATUSES]),
          ),
        )
        .orderBy(desc(advanceShipmentNotices.createdAt), desc(advanceShipmentNotices.id));
      const asnLineRows =
        asnRows.length === 0
          ? []
          : await tx
              .select()
              .from(asnLines)
              .where(inArray(asnLines.asnId, asnRows.map((row) => row.id)))
              .orderBy(asnLines.createdAt, asnLines.id);
      const linesByAsn = new Map<string, AsnLineSnapshot[]>();
      for (const line of asnLineRows) {
        const list = linesByAsn.get(line.asnId) ?? [];
        list.push(asnLineSnapshot(line));
        linesByAsn.set(line.asnId, list);
      }
      // Story 3.5 (additive): the putaway decision fields ride the same
      // snapshot — the bins (for the wrong-bin/blocked pre-queue checks) and
      // the derived tasks (suggestions advisory; the server re-gates).
      //
      // All three ride the IN-TX passthroughs and run on THIS transaction's
      // connection. The earlier shape called the pool-opening facade methods
      // inside `Promise.all`, so one snapshot request held four pooled
      // connections at once (the outer transaction plus one per nested
      // read). postgres.js queues connection requests with no timeout, so
      // past `max / 4` concurrent snapshots every outer transaction waited
      // forever for a nested one that could never be granted — a permanent
      // deadlock that also stranded the connection at the server, well
      // beyond the request that caused it. Composing in one transaction is
      // also what makes the "sealed snapshot" a single consistent read
      // rather than four MVCC snapshots stitched together.
      const binSummaries = await this.putaway.getBinSummariesInTx(tx, tenantId, warehouseId);
      const putawayTasks = await this.putaway.getPutawayTasksInTx(tx, tenantId, warehouseId);
      // Story 2-3a: the open gate-ins — an …InTx read on THIS transaction (Gotcha 2).
      const openGateIns = await openGateInsInTx(tx, tenantId, warehouseId, gateInClock.now());
      return {
        generatedAt: new Date().toISOString(),
        warehouseId,
        skus,
        openPurchaseOrders: poRows.map((po) => ({
          id: po.id,
          code: po.code,
          clientId: po.clientId,
          warehouseId: po.warehouseId,
          vendorId: po.vendorId,
          vendorName: (po.vendorSnapshot as VendorSnapshotV1 | null)?.name ?? liveNames.get(po.vendorId) ?? '',
          lines: linesByPo.get(po.id) ?? [],
        })),
        openAsns: asnRows.map((row) => ({
          id: row.id,
          code: row.code,
          clientId: row.clientId,
          warehouseId: row.warehouseId,
          expectedAt: row.expectedAt === null ? null : canonicalInstant(row.expectedAt),
          lines: linesByAsn.get(row.id) ?? [],
        })),
        bins: binSummaries,
        putawayTasks: putawayTasks.map((task) => ({ ...task })),
        openGateIns,
        // Story 2-4a — the vocabularies; their presence is the device's gate.
        receiptDamageReasons: [...DAMAGE_REASON_CODES],
        receiptShortReasons: [...SHORT_REASON_CODES],
        // Story 2-5a — damage photos: on only when a file store is configured.
        receiptPhotos: {
          enabled: this.attachments.storageEnabled,
          maxPerLine: RECEIPT_PHOTOS_MAX_PER_LINE,
          maxPerReceipt: RECEIPT_PHOTOS_MAX_PER_RECEIPT,
          maxBytes: MAX_IMAGE_BYTES,
        },
      };
    });
  }
}
/**
 * Story 9-1 — a page whose cursor carries each row's FULL-precision instant
 * (`createdAtText`, the `::text` projection) while the items keep their
 * canonical millisecond shape. The dashboard's drills page these lists to
 * exhaustion; a millisecond-truncated cursor skips the rest of a tie group.
 */
function fullPrecisionPage<T extends { readonly id: string }>(
  rows: readonly { readonly createdAtText: string }[],
  items: readonly T[],
  pageSize: number,
): Page<T> {
  const page = buildPage(
    items.map((item, index) => ({ createdAt: fullPrecisionInstant(rows[index]!.createdAtText), id: item.id, entry: item })),
    pageSize,
  );
  return { items: page.items.map((wrapped) => wrapped.entry), nextCursor: page.nextCursor };
}
