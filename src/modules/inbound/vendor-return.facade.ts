import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { fromMilli } from '../../shared/primitives/quantity';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { findDamagedBinInTx } from '../tenancy/receiving-bin';
import { CatalogFacade } from '../catalog/catalog.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import {
  VendorReturnCommand,
  type CancelVendorReturnCommand,
  type CreateVendorReturnCommand,
  type DispatchVendorReturnCommand,
  type PickVendorReturnCommand,
  type RtvSourceKind,
} from './vendor-return.command';
import { damagedArmKey, openVendorReturnClaimsByArmInTx, sourceClaimsByGrnLineInTx } from './vendor-return-claims';
import { openClientReturnClaimsByArmInTx } from '../returns/client-return-claims';
import { mergeArmClaims } from './vendor-return.command';
import {
  grnLineSourceFactsInTx,
  listVendorReturnsInTx,
  openVendorReturnsInTx,
  vendorReturnViewInTx,
  type OpenVendorReturnView,
  type VendorReturnListQuery,
  type VendorReturnSummary,
  type VendorReturnView,
} from './vendor-return.read';

/** The returnable read's caps (A15). */
export const RETURNABLE_MAX_ARMS = 500;
export const RETURNABLE_MAX_SOURCES_PER_ARM = 20;

export interface ReturnableSource {
  readonly kind: RtvSourceKind;
  readonly grnLineId: string;
  readonly grnId: string;
  readonly grnCode: string;
  readonly poCode: string | null;
  readonly vendorId: string | null;
  readonly vendorName: string | null;
  readonly reason: string | null;
  readonly receiptDamagedQty: number;
  readonly qcFailedQty: number;
  readonly claimedQty: number;
  readonly claimableQty: number;
  readonly receivedAt: string;
}

export interface ReturnableArm {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly uomPrecision: number;
  readonly batchId: string | null;
  readonly batchCode: string | null;
  readonly batchExpiry: string | null;
  readonly onHand: number;
  readonly claimed: number;
  readonly claimedBy: readonly string[];
  readonly available: number;
  readonly sources: readonly ReturnableSource[];
}

export interface ReturnableDamaged {
  readonly warehouseId: string;
  readonly clientId: string;
  readonly truncated: boolean;
  readonly arms: readonly ReturnableArm[];
}

/**
 * Story 2-8b — the return-to-vendor seam: the four commands and the reads.
 * The api shell's controller and the device snapshot composition call it;
 * nothing else in a sibling module does.
 */
@Injectable()
export class VendorReturnFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(VendorReturnCommand) private readonly command: VendorReturnCommand,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  create(command: CreateVendorReturnCommand, key: string): Promise<VendorReturnView> {
    return this.command.create(command, key);
  }

  pick(command: PickVendorReturnCommand, key: string): Promise<VendorReturnView> {
    return this.command.pick(command, key);
  }

  dispatch(command: DispatchVendorReturnCommand, key: string): Promise<VendorReturnView> {
    return this.command.dispatch(command, key);
  }

  cancel(command: CancelVendorReturnCommand, key: string): Promise<VendorReturnView> {
    return this.command.cancel(command, key);
  }

  get(tenantId: string, id: string): Promise<VendorReturnView> {
    return withTenantTransaction(this.db, tenantId, (tx) => vendorReturnViewInTx(tx, tenantId, id));
  }

  list(tenantId: string, query: VendorReturnListQuery): Promise<{ items: VendorReturnSummary[]; nextCursor: string | null }> {
    return withTenantTransaction(this.db, tenantId, (tx) => listVendorReturnsInTx(tx, tenantId, query));
  }

  /** The device snapshot arm: the warehouse's draft RTVs (decision 11). */
  openVendorReturns(tenantId: string, warehouseId: string): Promise<OpenVendorReturnView[]> {
    return withTenantTransaction(this.db, tenantId, (tx) => openVendorReturnsInTx(tx, tenantId, warehouseId));
  }

  /**
   * The create dialog's read: the client's DAMAGED arms in one warehouse with
   * on-hand, open claims and what is available, and per arm the GRN lines
   * the units came from with what each can still claim — `min(the line's
   * remaining, the arm's available)` (A5). Capped at 500 arms and 20 sources
   * per arm, newest source first, `truncated` when a cap bit (A15).
   */
  async returnable(tenantId: string, warehouseId: string, clientId: string, skuId: string | null): Promise<ReturnableDamaged> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      const bin = await findDamagedBinInTx(tx, tenantId, warehouseId);
      if (bin === null) return { warehouseId, clientId, truncated: false, arms: [] };
      const allArms = await this.inventory.damagedArmsInTx(tx, tenantId, warehouseId, bin.binId, {
        clientId,
        skuIds: skuId === null ? null : [skuId],
      });
      // The arms an RTV can carry: serial-tracked, catch-weight and kit SKUs
      // are refused at create (rtv-sku-unsupported), so they are not offered.
      const allSkuIds = [...new Set(allArms.map((arm) => arm.skuId))];
      const facts = await this.catalog.skuFactsInTx(tx, tenantId, allSkuIds);
      const kits = new Set(await this.catalog.getKitSkuIdsInTx(tx, tenantId, allSkuIds));
      const batches = await this.catalog.batchViewsByIdsInTx(tx, tenantId, allArms.flatMap((arm) => (arm.batchId === null ? [] : [arm.batchId])));
      const supported = allArms.filter((arm) => {
        const sku = facts.get(arm.skuId);
        return sku !== undefined && !sku.serialTracked && !sku.catchWeightTracked && !kits.has(arm.skuId);
      });
      // Sorted BEFORE the cap, so the arms kept are the first by SKU and batch code.
      const text = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
      const codeOf = (arm: (typeof allArms)[number]): string => facts.get(arm.skuId)!.code;
      const batchCodeOf = (arm: (typeof allArms)[number]): string => (arm.batchId === null ? '' : (batches.get(arm.batchId)?.code ?? arm.batchId));
      supported.sort((a, b) => text(codeOf(a), codeOf(b)) || text(batchCodeOf(a), batchCodeOf(b)) || text(a.batchId ?? '', b.batchId ?? ''));
      const truncatedArms = supported.length > RETURNABLE_MAX_ARMS;
      const arms = supported.slice(0, RETURNABLE_MAX_ARMS);
      const skuIds = [...new Set(arms.map((arm) => arm.skuId))];
      // Story 4-7c (D4) — one pool: RTC claims count before `available` and
      // before each source's `claimable` cap (the field names do not change).
      const claims = mergeArmClaims(
        await openVendorReturnClaimsByArmInTx(tx, tenantId, warehouseId, skuIds),
        await openClientReturnClaimsByArmInTx(tx, tenantId, warehouseId, skuIds),
      );
      const intakes = await this.inventory.damagedIntakeGrnLinesInTx(tx, tenantId, warehouseId, bin.binId, skuIds);
      const grnLineIds = intakes.map((row) => row.grnLineId);
      const sources = await grnLineSourceFactsInTx(tx, tenantId, grnLineIds);
      const sourceClaims = await sourceClaimsByGrnLineInTx(tx, tenantId, grnLineIds);
      const intakesByArm = new Map<string, (typeof intakes)[number][]>();
      for (const row of intakes) {
        const key = damagedArmKey(row.skuId, row.batchId);
        const list = intakesByArm.get(key) ?? [];
        list.push(row);
        intakesByArm.set(key, list);
      }
      let truncatedSources = false;
      const out: ReturnableArm[] = arms.map((arm) => {
        const key = damagedArmKey(arm.skuId, arm.batchId);
        const sku = facts.get(arm.skuId);
        const batch = arm.batchId === null ? undefined : batches.get(arm.batchId);
        const claim = claims.get(key);
        const claimedMilli = claim?.claimedMilli ?? 0;
        const availableMilli = Math.max(0, arm.quantity - claimedMilli);
        const seen = new Set<string>();
        const armSources: ReturnableSource[] = [];
        for (const intake of intakesByArm.get(key) ?? []) {
          if (seen.has(intake.grnLineId)) continue;
          seen.add(intake.grnLineId);
          const source = sources.get(intake.grnLineId);
          // A line moved to another warehouse's DAMAGED is never this arm's source.
          if (source === undefined || source.warehouseId !== warehouseId || source.skuId !== arm.skuId || source.batchId !== arm.batchId) continue;
          const total = source.damagedMilli + source.qcFailedMilli;
          const claimed = sourceClaims.get(intake.grnLineId) ?? 0;
          const claimable = Math.min(Math.max(0, total - claimed), availableMilli);
          if (claimable <= 0) continue;
          if (armSources.length >= RETURNABLE_MAX_SOURCES_PER_ARM) {
            truncatedSources = true;
            break;
          }
          armSources.push({
            kind: source.damagedMilli > 0 ? 'receipt-damage' : 'qc-fail',
            grnLineId: source.grnLineId,
            grnId: source.grnId,
            grnCode: source.grnCode,
            poCode: source.poCode,
            vendorId: source.poVendorId,
            vendorName: source.poVendorName,
            reason: source.damageReason ?? source.qcFailReason,
            receiptDamagedQty: fromMilli(source.damagedMilli),
            qcFailedQty: fromMilli(source.qcFailedMilli),
            claimedQty: fromMilli(claimed),
            claimableQty: fromMilli(claimable),
            receivedAt: intake.lastAt,
          });
        }
        return {
          skuId: arm.skuId,
          skuCode: sku?.code ?? arm.skuId,
          skuName: sku?.name ?? '',
          uom: sku?.uom ?? 'pcs',
          uomPrecision: sku?.uomPrecision ?? 0,
          batchId: arm.batchId,
          batchCode: batch?.code ?? null,
          batchExpiry: batch?.expiryDate ?? null,
          onHand: fromMilli(arm.quantity),
          claimed: fromMilli(claimedMilli),
          claimedBy: claim?.codes ?? [],
          available: fromMilli(availableMilli),
          sources: armSources,
        };
      });
      return { warehouseId, clientId, truncated: truncatedArms || truncatedSources, arms: out };
    });
  }
}
