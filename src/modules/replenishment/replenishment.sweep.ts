import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  reorderBreaches,
  reorderPolicies,
  suggestedPos,
} from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import { InboundFacade } from '../inbound/inbound.facade';
import { REPLENISHMENT_SCHEDULER_ACTOR_ID, recoveryGapMilli } from './replenishment.command';

/**
 * The breach sweep (story 6.1): the worker's per-scope evaluation, in THREE
 * deliberate phases —
 *
 *   1. a candidates transaction: the effective points (policy row ?? SKU
 *      column) for one (tenant, warehouse), composed with the catalog
 *      defaults on ONE transaction;
 *   2. the ATP reads — STRICTLY OUTSIDE any transaction: `InventoryFacade.atp`
 *      is the ONLY allowed ATP read (the module never touches stock tables —
 *      the architecture spine), it is fallible (503 when the reservation
 *      store is down), and an ATP read that opened its own transaction inside
 *      a held one would be the pool-deadlock shape. A failing read THROWS —
 *      the scope is skipped and retried next tick; a store outage is never
 *      read as ATP 0 (which would mint false breaches);
 *   3. a transitions transaction with FRESH point re-reads (a policy edited
 *      since phase 1 is honored, not raced) — the breach open/recover
 *      transitions, the draft-on-open mint, the outbox event and the audit
 *      row, all-or-nothing per scope.
 */

/** One candidate (tenant, warehouse, sku) scope evaluation carries. */
export interface EffectiveCandidate {
  readonly skuId: string;
  readonly code: string;
  readonly name: string;
  /** The effective point in milli-units — strictly positive (else not a candidate). */
  readonly pointMilli: number;
  /** The effective default qty in milli-units — 0 means "derive the recovery gap". */
  readonly qtyMilli: number;
}

export interface SweepReport {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly evaluated: number;
  /** Breaches OPENED this sweep (each with its draft + event + audit row). */
  readonly opened: number;
  /** Open breaches the ATP read recovered this sweep (no event, by design). */
  readonly recovered: number;
}

@Injectable()
export class ReplenishmentSweep {
  private readonly logger = new Logger('ReplenishmentSweep');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // The ONLY ATP read (the architecture spine). Failible 503s propagate —
    // the worker skips the scope; nothing reads a missing counter as 0.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    // The tenant-wide SKU defaults, in-tx (catalog tables stay module-exclusive).
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    // The deterministic default-vendor pick (inbound owns `vendors`).
    @Inject(InboundFacade) private readonly inbound: InboundFacade,
  ) {}

  /**
   * One (tenant, warehouse) scope's evaluation — the worker's per-scope
   * entry. All-or-nothing per phase; the ATP-failure skip is a THROW so the
   * worker's per-scope catch logs it and the rest of the tick moves on.
   */
  async sweepScope(tenantId: string, warehouseId: string): Promise<SweepReport> {
    // ── Phase 1: candidates (one tenant transaction; no stock reads) ────────
    const candidates = await withTenantTransaction(this.db, tenantId, (tx) =>
      this.effectiveCandidatesInTx(tx, tenantId, warehouseId),
    );
    if (candidates.length === 0) {
      return { tenantId, warehouseId, evaluated: 0, opened: 0, recovered: 0 };
    }

    // ── Phase 2: ATP reads, on NO transaction (the phase rule) ──────────────
    // Any failure throws — the scope is skipped whole (a half-swept scope
    // would open breaches against a stale snapshot), never read as ATP 0.
    const atpBySku = new Map<string, number>();
    for (const candidate of candidates) {
      const snapshot = await this.inventory.atp(tenantId, warehouseId, candidate.skuId);
      atpBySku.set(candidate.skuId, snapshot.atp);
    }

    // ── Phase 3: transitions (one tenant transaction, fresh point re-reads) ─
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // Fresh re-read: a policy edited after phase 1 decides THIS sweep.
      const fresh = await this.effectiveCandidatesInTx(tx, tenantId, warehouseId);

      let opened = 0;
      let recovered = 0;
      // The default vendor is picked at most once per scope — lazily, only
      // when a breach actually opens (deterministic min (created_at, id),
      // null when the tenant carries none).
      let vendor: { id: string; code: string; name: string } | null | undefined;
      const defaultVendor = async (): Promise<{ id: string; code: string; name: string } | null> => {
        if (vendor === undefined) {
          vendor = await this.inbound.findDefaultVendorInTx(tx, tenantId);
        }
        return vendor;
      };

      for (const candidate of fresh) {
        // A candidate that appeared AFTER the ATP reads (a policy added
        // mid-sweep) carries no reading — skipped this sweep, swept next
        // tick. It is NEVER read as ATP 0: a missing reading would mint a
        // false breach against stock the store was never asked about.
        const atpMilli = atpBySku.get(candidate.skuId);
        if (atpMilli === undefined) {
          continue;
        }
        const breach = await this.loadOpenBreach(tx, tenantId, warehouseId, candidate.skuId);
        if (atpMilli < candidate.pointMilli) {
          if (breach !== null) {
            continue; // already active — the partial unique absorbed it; no second draft, no repeat event
          }
          await this.openBreach(tx, tenantId, warehouseId, candidate, atpMilli, await defaultVendor());
          opened += 1;
        } else if (breach !== null) {
          await this.recoverBreach(tx, breach.id);
          recovered += 1;
        }
      }
      if (opened > 0 || recovered > 0) {
        this.logger.log(
          `Replenishment sweep tenant=${tenantId} warehouse=${warehouseId} ` +
            `evaluated=${fresh.length} opened=${opened} recovered=${recovered}`,
        );
      }
      return { tenantId, warehouseId, evaluated: fresh.length, opened, recovered };
    });
  }

  /**
   * The effective points for one (tenant, warehouse): the per-warehouse
   * policy row overrides the SKU columns row-by-row; a SKU whose effective
   * point is 0 is NOT a candidate (no breach evaluation, whatever its qty
   * says). Ordered by skuId — the transitions phase's lock order, so two
   * concurrent sweeps of one scope never interleave their row locks.
   */
  async effectiveCandidatesInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
  ): Promise<EffectiveCandidate[]> {
    const policyRows = await tx
      .select()
      .from(reorderPolicies)
      .where(
        and(
          eq(reorderPolicies.tenantId, tenantId),
          eq(reorderPolicies.warehouseId, warehouseId),
        ),
      );
    const policyBySku = new Map(policyRows.map((row) => [row.skuId, row]));
    // The tenant-wide defaults (catalog facade, in-tx): ALL tenant SKUs —
    // also the ones carrying no defaults, because a policy row may target
    // any of them and the defaults map doubles as the identity source.
    const skuDefaults = await this.catalog.getSkuReorderDefaultsInTx(tx, tenantId);

    const candidates: EffectiveCandidate[] = [];
    for (const sku of skuDefaults) {
      const override = policyBySku.get(sku.id);
      const pointMilli = override !== undefined ? override.reorderPointMilli : sku.reorderPoint;
      const qtyMilli = override !== undefined ? override.reorderQtyMilli : sku.reorderQty;
      if (pointMilli > 0) {
        candidates.push({
          skuId: sku.id,
          code: sku.code,
          name: sku.name,
          pointMilli,
          qtyMilli,
        });
      }
    }
    return candidates.sort((a, b) => (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0));
  }

  /** The open breach for the scope, locked (none → null; the re-point/absorb decisions read it). */
  private async loadOpenBreach(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    skuId: string,
  ): Promise<ReorderBreachRow | null> {
    const rows = await tx
      .select()
      .from(reorderBreaches)
      .where(
        and(
          eq(reorderBreaches.tenantId, tenantId),
          eq(reorderBreaches.warehouseId, warehouseId),
          eq(reorderBreaches.skuId, skuId),
          eq(reorderBreaches.status, 'open'),
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /**
   * The breach OPEN: the alert row (point + ATP frozen at detection), the
   * suggested-PO draft minted exactly here (one artifact per breach EVENT),
   * the `replenishment.breach_detected` outbox event (the `notifyRole` hint
   * is the entry contract Epic 9's panel reads) and the audit row under the
   * module-reserved actor.
   *
   * A standing draft for the same scope is REPOINTED, not duplicated: the
   * fresh breach's vendor/quantity REPLACE whatever a planner had left on
   * it — a draft is always a system-fresh suggestion (the Design Notes'
   * stated re-breach semantics; the partial unique admits one draft row).
   */
  private async openBreach(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    candidate: EffectiveCandidate,
    atpMilli: number,
    vendor: { id: string; code: string; name: string } | null,
  ): Promise<void> {
    const breachId = uuidv7();
    const breachAt = nowIso();
    await tx.insert(reorderBreaches).values({
      id: breachId,
      tenantId,
      warehouseId,
      skuId: candidate.skuId,
      status: 'open',
      pointMilli: candidate.pointMilli,
      atpMilli,
    });

    // The draft's quantity: the effective reorder_qty when the policy/default
    // names one (> 0); otherwise the recovery gap — the shortfall below the
    // point, which `recoveryGapMilli` converts to whole base units rounded
    // UP so the minted PO's line passes the PO command's precision guard for
    // every unit vocabulary. On an open path the gap is strictly positive
    // (point > atp ≥ 0), so no zero/absent-quantity arm exists here.
    const quantityMilli =
      candidate.qtyMilli > 0 ? candidate.qtyMilli : recoveryGapMilli(candidate.pointMilli, atpMilli);

    const existingDrafts = await tx
      .select()
      .from(suggestedPos)
      .where(
        and(
          eq(suggestedPos.tenantId, tenantId),
          eq(suggestedPos.warehouseId, warehouseId),
          eq(suggestedPos.skuId, candidate.skuId),
          eq(suggestedPos.status, 'draft'),
        ),
      )
      .limit(1)
      .for('update');
    const standing = existingDrafts[0];
    if (standing !== undefined) {
      // The re-breach repoint.
      await tx
        .update(suggestedPos)
        .set({
          breachId,
          vendorId: vendor === null ? null : vendor.id,
          quantityMilli,
          updatedAt: breachAt,
        })
        .where(eq(suggestedPos.id, standing.id));
    } else {
      await tx.insert(suggestedPos).values({
        id: uuidv7(),
        tenantId,
        warehouseId,
        skuId: candidate.skuId,
        breachId,
        // No default vendor → the draft carries null and the human submit
        // names one (the I/O matrix's vendor-null arm).
        vendorId: vendor === null ? null : vendor.id,
        quantityMilli,
        status: 'draft',
      });
    }

    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type: 'replenishment.breach_detected',
      occurredAt: breachAt,
      payload: {
        breachId,
        warehouseId,
        skuId: candidate.skuId,
        atpMilli,
        pointMilli: candidate.pointMilli,
        breachAt,
        notifyRole: 'ops_manager',
      },
    });

    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      // `audit_events.actor_user_id` is NOT NULL and no system-actor user
      // row exists — the sweep signs with the module-reserved actor constant
      // (documented at its definition; never sign-in-able).
      actorUserId: REPLENISHMENT_SCHEDULER_ACTOR_ID,
      action: 'replenishment.breach_detected',
      targetType: 'reorder_breach',
      targetId: breachId,
      occurredAt: breachAt,
    });
  }

  /**
   * The breach RECOVER: ATP ≥ point — the row goes `recovered`
   * (`resolved_by` stays null: nobody acted), its draft KEPT as a draft, and
   * deliberately NO outbox event (a surface-visible state change only, the
   * Design Notes' rule).
   */
  private async recoverBreach(tx: TenantTx, breachId: string): Promise<void> {
    await tx
      .update(reorderBreaches)
      .set({ status: 'recovered', resolvedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(reorderBreaches.id, breachId));
  }
}

type ReorderBreachRow = typeof reorderBreaches.$inferSelect;