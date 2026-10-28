import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { orderLines, orders, picklistLines, waves } from '../../shared/db/schema';
import { istDateOf } from '../../shared/primitives/time';
import { fromMilli } from '../../shared/primitives/quantity';
import {
  consigneeMinimumDays,
  meetsConsigneeShelfLife,
  type ConsigneeArm,
  type ShortfallCause,
} from '../../shared/primitives/batch-allocation';
import { InventoryFacade } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import { allocationPoliciesInTx, DEFAULT_ALLOCATION_POLICY } from '../clients/clients.facade';
import {
  consigneeNoRuleReasonInTx,
  consigneeRuleKey,
  consigneeShelfLifeRulesInTx,
  normalizeOrderGstin,
  type ConsigneeResolution,
  type ConsigneeShelfLifeRuleOfOrder,
} from '../partners/partners.facade';
import { buildStockPool, openClaimsBySkuInTx, pickableBinsInTx, type StockSlot } from './replan';
import { WAVE_CLOCK } from './wave.clock';
import type { WaveClock } from './wave.clock';

/** One order line of the customer shelf life read (base units). */
export interface OrderShelfLifeLine {
  readonly orderLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly reservedQty: number;
  readonly effectiveMinDays: number | null;
  readonly shelfLifeBaseDays: number | null;
  readonly judgeable: boolean;
  readonly qualifyingOnHand: number;
  readonly qualifyingUnclaimed: number;
  readonly belowConsigneeMinimumOnHand: number;
  readonly plannedQty: number | null;
  readonly shortfallQty: number | null;
  readonly shortfallCause: ShortfallCause | null;
}

/** Story 4-3b (decision 8, A8) — `GET …/outbound/orders/{orderId}/shelf-life`. */
export interface OrderShelfLife {
  readonly orderId: string;
  readonly judgedOn: string;
  readonly clientMinShelfLifeDays: number | null;
  readonly consigneeResolution: ConsigneeResolution;
  /** The order's consignee GSTIN as stored (null when none) — the diagnostic's subject. */
  readonly consigneeGstin: string | null;
  /** The partner holding that GSTIN (any status), when one does — set for no-consignee-link, no-rule and applied. */
  readonly resolvedPartner: { readonly partnerId: string; readonly code: string; readonly name: string } | null;
  readonly consignee: {
    readonly partnerId: string;
    readonly code: string;
    readonly name: string;
    readonly minShelfLifeDays: number | null;
    readonly minShelfLifePercent: number | null;
  } | null;
  readonly lines: readonly OrderShelfLifeLine[];
}

/**
 * Story 4-3b (decision 8, A8) — which shelf-life rules apply to one order and
 * how much on-hand stock qualifies, IF IT WERE WAVED TODAY. A staff read
 * (`TenantSessionGuard`, the `getOrder` precedent); never a portal read.
 *
 * - **The rules:** the order's client minimum (4-3a, `allocationPoliciesInTx`
 *   on `orders.client_id`, A11) and its consignee's rule, resolved from the
 *   order's GSTIN exactly as the planner resolves it, with the reason it did
 *   or did not apply (`consigneeResolution`).
 * - **The judgement:** the server's IST date (`WAVE_CLOCK` — the date a wave
 *   generated now plans on), over the order's warehouse's PICKABLE stock
 *   through the planner's own pool (`buildStockPool` — the client rule's
 *   filters and per-bin budget), and the same consignee predicate
 *   (`meetsConsigneeShelfLife`) — no second definition.
 * - **Per line, after the earlier lines of the same SKU** (in line order — a
 *   wave plans them so): `qualifyingOnHand` ignores every other order's
 *   claims; `qualifyingUnclaimed` is what still qualifies after the units
 *   OTHER open `planned` picklist lines claim (`openClaimsBySkuInTx`, this
 *   order's own lines excluded) are spent against every slot in rank order —
 *   the re-plan's order (A12), not qualifyingOnHand minus claims. Each
 *   line's reserved units are then spent from what qualifies, so a later
 *   line of the same SKU (two kit components) never counts them again. ONE
 *   pool per figure and ONE claims read for the whole order; `belowConsigneeMinimumOnHand` is what the
 *   client rule allows and the consignee's does not. When the line is on an
 *   OPEN wave (not cancelled), its planned and unfulfillable quantities and
 *   the planner's frozen `shortfallCause` ride along.
 * - Quantities leave in base units. A kit parent line (it reserves nothing —
 *   its components do) is not listed; its component lines are.
 */
@Injectable()
export class OrderShelfLifeReader {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(WAVE_CLOCK) private readonly clock: WaveClock,
  ) {}

  /**
   * The order's consignee resolution: the `applied` arm is the PLANNER'S own
   * match (`consigneeShelfLifeRulesInTx`, the same normalised GSTIN), so the
   * read and a wave cannot disagree; `consigneeNoRuleReasonInTx` only
   * explains a rule that did not apply.
   */
  private async resolveInTx(
    tx: Parameters<typeof consigneeShelfLifeRulesInTx>[0],
    tenantId: string,
    clientId: string,
    gstin: string | null,
  ): Promise<{
    resolution: ConsigneeResolution;
    partner: { id: string; code: string; name: string } | null;
    rule: ConsigneeShelfLifeRuleOfOrder | null;
  }> {
    const normalized = gstin === null ? '' : normalizeOrderGstin(gstin);
    if (normalized === '') return { resolution: 'no-gstin', partner: null, rule: null };
    const rule = (await consigneeShelfLifeRulesInTx(tx, tenantId, [{ clientId, gstin: normalized }])).get(consigneeRuleKey(clientId, normalized));
    if (rule !== undefined) {
      return { resolution: 'applied', partner: { id: rule.partnerId, code: rule.partnerCode, name: rule.partnerName }, rule };
    }
    const why = await consigneeNoRuleReasonInTx(tx, tenantId, clientId, normalized);
    return { resolution: why.resolution, partner: why.partner, rule: null };
  }

  async read(tenantId: string, orderId: string): Promise<OrderShelfLife | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const orderRows = await tx
        .select({ id: orders.id, clientId: orders.clientId, warehouseId: orders.warehouseId, consigneeGstin: orders.consigneeGstin })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
        .limit(1);
      const order = orderRows[0];
      if (order === undefined) return null;

      const allLines = await tx
        .select({ id: orderLines.id, skuId: orderLines.skuId, reservedQty: orderLines.reservedQty, parentLineId: orderLines.parentLineId })
        .from(orderLines)
        .where(and(eq(orderLines.tenantId, tenantId), eq(orderLines.orderId, orderId)))
        .orderBy(asc(orderLines.createdAt), asc(orderLines.id));
      const parentIds = new Set(allLines.flatMap((line) => (line.parentLineId === null ? [] : [line.parentLineId])));
      const lines = allLines.filter((line) => !parentIds.has(line.id));
      const skuIds = [...new Set(lines.map((line) => line.skuId))];

      const at = this.clock.now().getTime();
      const judgedOn = istDateOf(new Date(at).toISOString());
      const [policies, resolved, skuFacts, labels, binOrder] = await Promise.all([
        allocationPoliciesInTx(tx, tenantId, [order.clientId]),
        this.resolveInTx(tx, tenantId, order.clientId, order.consigneeGstin),
        this.catalog.skuShelfLifeFactsInTx(tx, tenantId, skuIds),
        this.catalog.skuLabelsInTx(tx, tenantId, skuIds),
        pickableBinsInTx(tx, tenantId, order.warehouseId),
      ]);
      const policy = policies.get(order.clientId) ?? DEFAULT_ALLOCATION_POLICY;
      const [stock, batchStock, batchIdentities, skuClasses] = await Promise.all([
        this.inventory.stockByBinsInTx(tx, tenantId, order.warehouseId, skuIds),
        this.inventory.batchOnHandByBinsInTx(tx, tenantId, order.warehouseId, skuIds),
        this.catalog.getBatchIntakesForSkusInTx(tx, tenantId, skuIds),
        this.catalog.getSkuStorageClassesInTx(tx, tenantId, skuIds),
      ]);
      const batchById = new Map(batchIdentities.map((batch) => [batch.id, batch]));
      const poolInput = {
        skuIds,
        binOrder,
        skuClassById: skuClasses,
        stock,
        batchStock,
        batchIdentities,
        at,
        policyOf: () => ({ allocationRule: policy.allocationRule, minDays: policy.minOutboundShelfLifeDays }),
      };

      // The line's open-wave plan (a wave that is not cancelled).
      const planRows =
        lines.length === 0
          ? []
          : await tx
              .select({
                orderLineId: picklistLines.orderLineId,
                status: picklistLines.status,
                qty: picklistLines.qty,
                shortfallQty: picklistLines.shortfallQty,
                shortfallCause: picklistLines.shortfallCause,
              })
              .from(picklistLines)
              .innerJoin(waves, and(eq(waves.id, picklistLines.waveId), eq(waves.tenantId, picklistLines.tenantId)))
              .where(
                and(
                  eq(picklistLines.tenantId, tenantId),
                  inArray(picklistLines.orderLineId, lines.map((line) => line.id)),
                  ne(picklistLines.status, 'cancelled'),
                  ne(waves.status, 'cancelled'),
                ),
              );

      // ONE pool per figure and ONE claims read for the order's SKU set.
      const onHandPool = buildStockPool(poolInput);
      const unclaimedPool = buildStockPool(poolInput);
      const claims = await openClaimsBySkuInTx(tx, tenantId, skuIds, binOrder.map((bin) => bin.id), orderId);
      for (const [skuId, byBin] of claims) {
        const slots = unclaimedPool.get(skuId) ?? [];
        for (const [binId, units] of byBin) {
          let outstanding = units;
          for (const slot of slots) {
            if (outstanding === 0) break;
            if (slot.binId !== binId) continue;
            const spent = Math.min(outstanding, slot.remaining);
            slot.remaining -= spent;
            outstanding -= spent;
          }
        }
      }

      const result: OrderShelfLifeLine[] = [];
      for (const line of lines) {
        const facts = skuFacts.get(line.skuId);
        const batchTracked = facts?.batchTracked ?? false;
        const shelfLifeBaseDays = facts?.shelfLifeDays ?? null;
        const consignee: ConsigneeArm | null =
          resolved.rule === null || !batchTracked ? null : consigneeMinimumDays(resolved.rule, shelfLifeBaseDays);
        const judgeable = consignee === null || consignee.judgeable;
        const clientMin = policy.minOutboundShelfLifeDays;
        const effectiveMinDays = !judgeable
          ? null
          : consignee === null || consignee.days === null
            ? clientMin
            : Math.max(clientMin ?? 0, consignee.days);

        const meets = (slot: StockSlot) =>
          meetsConsigneeShelfLife(
            { batchId: slot.batchId, expiryDate: slot.batchId === null ? null : (batchById.get(slot.batchId)?.expiryDate ?? null) },
            batchTracked,
            at,
            consignee,
          );
        const onHandSlots = onHandPool.get(line.skuId) ?? [];
        const unclaimedSlots = unclaimedPool.get(line.skuId) ?? [];
        let qualifyingOnHand = 0;
        let below = 0;
        for (const slot of onHandSlots) {
          if (meets(slot)) qualifyingOnHand += slot.remaining;
          else below += slot.remaining;
        }
        const qualifyingUnclaimed = unclaimedSlots.reduce((sum, slot) => (meets(slot) ? sum + slot.remaining : sum), 0);
        // This line's reservation is spent from what qualifies, in rank order,
        // before a later line of the same SKU is judged.
        const spend = (slots: readonly StockSlot[]) => {
          let need = line.reservedQty;
          for (const slot of slots) {
            if (need === 0) break;
            if (slot.remaining <= 0 || !meets(slot)) continue;
            const take = Math.min(need, slot.remaining);
            slot.remaining -= take;
            need -= take;
          }
        };
        spend(onHandSlots);
        spend(unclaimedSlots);

        const plan = planRows.filter((row) => row.orderLineId === line.id);
        const onWave = plan.length > 0;
        result.push({
          orderLineId: line.id,
          skuId: line.skuId,
          skuCode: labels.get(line.skuId)?.code ?? line.skuId,
          reservedQty: fromMilli(line.reservedQty),
          effectiveMinDays,
          shelfLifeBaseDays,
          judgeable,
          qualifyingOnHand: fromMilli(qualifyingOnHand),
          qualifyingUnclaimed: fromMilli(qualifyingUnclaimed),
          belowConsigneeMinimumOnHand: fromMilli(below),
          plannedQty: onWave ? fromMilli(plan.filter((row) => row.status !== 'unfulfillable').reduce((sum, row) => sum + row.qty, 0)) : null,
          shortfallQty: onWave
            ? fromMilli(plan.filter((row) => row.status === 'unfulfillable').reduce((sum, row) => sum + row.shortfallQty, 0))
            : null,
          shortfallCause: (plan.find((row) => row.shortfallCause !== null)?.shortfallCause as ShortfallCause | undefined) ?? null,
        });
      }

      return {
        orderId: order.id,
        judgedOn,
        clientMinShelfLifeDays: policy.minOutboundShelfLifeDays,
        consigneeResolution: resolved.resolution,
        consigneeGstin: order.consigneeGstin,
        resolvedPartner: resolved.partner === null ? null : { partnerId: resolved.partner.id, code: resolved.partner.code, name: resolved.partner.name },
        consignee:
          resolved.rule === null
            ? null
            : {
                partnerId: resolved.rule.partnerId,
                code: resolved.rule.partnerCode,
                name: resolved.rule.partnerName,
                minShelfLifeDays: resolved.rule.minShelfLifeDays,
                minShelfLifePercent: resolved.rule.minShelfLifePercent,
              },
        lines: result,
      };
    });
  }
}
