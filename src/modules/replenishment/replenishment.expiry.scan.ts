import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  batchAlerts,
  expiryAlertPolicies,
} from '../../shared/db/schema';
import type {
  BatchAlertKind} from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import type { BatchScopeSumEntry } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import type { BatchIntake } from '../catalog/catalog.facade';
import { REPLENISHMENT_SCHEDULER_ACTOR_ID } from './replenishment.command';
import type { ExpiryPolicySnapshot } from './replenishment.command';

/**
 * The expiry scan (story 6.2, FR-23): the scheduler tick's SECOND evaluation
 * against the same one-scheduler decision — the worker calls it beside the
 * breach sweep, per scope. It reads NO stock numbers of its own (the
 * ledger-as-truth spine): on-hand comes from the `batch_on_hand` projection
 * through the inventory facade, batch identity/expiry/intake from the catalog
 * facade — never a cross-module table reach (AD-6).
 *
 * The phase discipline mirrors the sweep, without its fallible outside-tx
 * phase (no Valkey, no reservation store — projection/catalog reads only):
 *
 *   1. an enumeration tx: the tenant's config row (ABSENT ROW = DISABLED —
 *      no default lead/threshold days hide in code; a tenant without one
 *      short-circuits the whole scan) and the warehouse's positive
 *      batch-scope sums;
 *   2. a transitions tx whose EVERY read is re-taken fresh (a config edited
 *      between phases decides THIS scan; a scope consumed between them
 *      resolves, never rides a stale enumeration): the open batch alerts of
 *      the warehouse locked FOR UPDATE in (sku, batch, kind) order — the
 *      lock order — then the open/resolve transitions, all-or-nothing.
 *
 * Any throw skips the whole scope (the worker logs and retries next tick) —
 * a partial scan never half-resolves alerts.
 */

export interface BatchScanReport {
  readonly tenantId: string;
  readonly warehouseId: string;
  /** Batch scopes that carried positive on-hand in the transitions tx. */
  readonly evaluated: number;
  /** Alerts OPENED this scan (each with its event + audit row). */
  readonly raised: number;
  /** Open alerts auto-resolved (on-hand reached 0 — no event, by design). */
  readonly resolved: number;
}

/** The frozen aging arithmetic: floor((now − intake) / 86400s), as whole days. */
export function ageDaysSince(batchesCreatedAt: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(batchesCreatedAt)) / 86_400_000);
}

@Injectable()
export class ExpiryScan {
  private readonly logger = new Logger('ExpiryScan');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // The projection's in-tx scope-sum reads (inventory owns the projection).
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    // Batch identity, expiry and intake instants (catalog owns `batches`,
    // AD-6 — the scan never joins batches from an inventory-side table).
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  /**
   * One (tenant, warehouse) scope's expiry/aging evaluation — the worker's
   * per-scope entry beside `sweepScope`. All-or-nothing; a throw propagates
   * so the worker's per-scope catch logs it and the tick moves on.
   */
  async scanScope(tenantId: string, warehouseId: string): Promise<BatchScanReport> {
    const idle = { tenantId, warehouseId, evaluated: 0, raised: 0, resolved: 0 };

    // ── Phase 1: config + enumeration (one tenant transaction) ─────────────
    // The absent config row IS the disable switch — a tenant that never
    // configured expiry/aging alerting scans to no-op here (no invented
    // defaults; and no alert can be open for it, since rows only OPEN under
    // a config row).
    const enumerated = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const config = await this.readConfigInTx(tx, tenantId);
      if (config === null) {
        return null;
      }
      const scopes = await this.inventory.batchScopeSumsInTx(tx, tenantId, warehouseId);
      return { scopes };
    });
    if (enumerated === null) {
      return idle;
    }

    // ── Phase 2: transitions (one tenant transaction, EVERYTHING re-read) ──
    // (the sweep's fallible outside-tx phase has no counterpart here — every
    // read this scan makes is one of these two tenant transactions' own)
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const config = await this.readConfigInTx(tx, tenantId);
      if (config === null) {
        return idle; // a config row could legitimately have changed shape mid-scan; the fresh read decides
      }
      // Fresh scope sums: a batch consumed since phase 1 is ABSENT here — its
      // open alerts resolve below, never ride a stale enumeration.
      const freshScopes = await this.inventory.batchScopeSumsInTx(tx, tenantId, warehouseId);
      const skuIds = [...new Set(freshScopes.map((scope) => scope.skuId))];
      // Batch intake facts on the caller's transaction — the catalog facade's
      // in-tx read; no second connection while this one is held.
      const intakes = await this.catalog.getBatchIntakesForSkusInTx(tx, tenantId, skuIds);
      const intakeById = new Map<string, BatchIntake>(
        intakes.map((batch) => [batch.id, batch]),
      );

      // EVERY open alert of the scope, locked in (skuId, batchId, kind)
      // order — the scan's lock order, so two concurrent scans of one scope
      // never interleave their row locks.
      const openAlerts = await tx
        .select()
        .from(batchAlerts)
        .where(
          and(
            eq(batchAlerts.tenantId, tenantId),
            eq(batchAlerts.warehouseId, warehouseId),
            eq(batchAlerts.status, 'open'),
          ),
        )
        .orderBy(asc(batchAlerts.skuId), asc(batchAlerts.batchId), asc(batchAlerts.kind))
        .for('update');
      const openByScope = new Set(
        openAlerts.map((alert) => `${alert.skuId}|${alert.batchId}|${alert.kind}`),
      );
      const withOnHand = new Set(
        freshScopes.map((scope) => `${scope.skuId}|${scope.batchId}`),
      );

      let raised = 0;
      const raisedAt = nowIso();
      const nowMs = Date.parse(raisedAt);
      // The scope iteration follows the lock order (skuId, batchId) — the
      // same order the open-alert read took its locks in.
      const ordered = [...freshScopes].sort((a, b) =>
        a.skuId < b.skuId
          ? -1
          : a.skuId > b.skuId
            ? 1
            : a.batchId < b.batchId
              ? -1
              : a.batchId > b.batchId
                ? 1
                : 0,
      );
      for (const scope of ordered) {
        const batch = intakeById.get(scope.batchId);
        if (batch === undefined) {
          continue; // an identity race — next tick's fresh rows decide, never this tx's
        }
        if (batch.status !== 'active') {
          // A blocked batch raises NO NEW alert (its open alerts stand until
          // consumption or dismissal — the I/O matrix's blocked arm).
          continue;
        }
        const hits = evaluationHits(config, batch, nowMs);
        for (const kind of hits.kinds) {
          if (openByScope.has(`${scope.skuId}|${scope.batchId}|${kind}`)) {
            continue; // already open — no duplicate row, no repeat event
          }
          const inserted = await this.raiseAlert(
            tx,
            tenantId,
            warehouseId,
            scope,
            kind,
            hits.ageDays,
            batch,
            raisedAt,
          );
          if (inserted) {
            raised += 1;
          }
        }
      }

      // Auto-resolve: every open alert whose scope carries NO positive
      // on-hand anymore → `resolved`, `resolved_by` null (nobody acted) and
      // deliberately NO outbox event — a surface-visible state change only
      // (the breach-recovery rule). A batch that merely stopped TRIGGERING
      // (expiry only matures; age only grows) keeps its alert — it stands
      // until consumption or dismissal.
      let resolved = 0;
      for (const alert of openAlerts) {
        if (withOnHand.has(`${alert.skuId}|${alert.batchId}`)) {
          continue;
        }
        await tx
          .update(batchAlerts)
          .set({ status: 'resolved', resolvedAt: raisedAt, updatedAt: raisedAt })
          .where(eq(batchAlerts.id, alert.id));
        resolved += 1;
      }

      if (raised > 0 || resolved > 0) {
        this.logger.log(
          `Expiry scan tenant=${tenantId} warehouse=${warehouseId} ` +
            `evaluated=${freshScopes.length} raised=${raised} resolved=${resolved}`,
        );
      }
      return { tenantId, warehouseId, evaluated: freshScopes.length, raised, resolved };
    });
  }

  /**
   * The tenant's config row (module-owned — a direct read), as the snapshot
   * the evaluation reads, or null when absent (the disable mechanism).
   */
  async readConfigInTx(tx: TenantTx, tenantId: string): Promise<ExpiryPolicySnapshot | null> {
    const rows = await tx
      .select()
      .from(expiryAlertPolicies)
      .where(eq(expiryAlertPolicies.tenantId, tenantId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      expiryLeadDays: row.expiryLeadDays,
      agingThresholdDays: row.agingThresholdDays,
      createdAt: canonicalInstant(row.createdAt),
      updatedAt: canonicalInstant(row.updatedAt),
    };
  }

  /**
   * The alert OPEN: the row (the aged row freezes `age_days`; the expiry row
   * freezes nothing — the catalog froze the date at intake), the
   * `replenishment.batch_alert_raised` outbox event (the `notifyRole` hint is
   * Epic 9's panel contract, the 6-1 precedent) and the audit row under the
   * module-reserved actor. `ON CONFLICT DO NOTHING` absorbs a racing
   * double-open as the already-open verdict (no aborted tx, no duplicate
   * event); the returned flag says whether THIS scan opened it.
   */
  private async raiseAlert(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    scope: Pick<BatchScopeSumEntry, 'skuId' | 'batchId'>,
    kind: BatchAlertKind,
    ageDays: number,
    batch: Pick<BatchIntake, 'code' | 'expiryDate'>,
    raisedAt: string,
  ): Promise<boolean> {
    const alertId = uuidv7();
    const inserted = await tx
      .insert(batchAlerts)
      .values({
        id: alertId,
        tenantId,
        warehouseId,
        skuId: scope.skuId,
        batchId: scope.batchId,
        kind,
        status: 'open',
        // The ONLY frozen fact: age moves; the alert records what it saw.
        ageDays: kind === 'aged' ? ageDays : null,
      })
      // The partial open-scope unique is the deterministic backstop against
      // two concurrent scans of one scope both opening.
      .onConflictDoNothing()
      .returning({ id: batchAlerts.id });
    if (inserted.length === 0) {
      return false; // absorbed — another scan opened it first
    }

    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type: 'replenishment.batch_alert_raised',
      occurredAt: raisedAt,
      payload: {
        alertId,
        kind,
        warehouseId,
        skuId: scope.skuId,
        batchId: scope.batchId,
        batchCode: batch.code,
        // The expiry arm names the date, the aging arm the frozen age —
        // each payload carries exactly what its kind detected. (The
        // expiry-upcoming arm is only reachable with a non-null expiry — the
        // evaluation guards it — but the payload stays null-safe.)
        ...(kind === 'expiry_upcoming' && batch.expiryDate !== null
          ? { expiryDate: canonicalInstant(batch.expiryDate) }
          : { ageDays }),
        notifyRole: 'ops_manager',
      },
    });

    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      // `audit_events.actor_user_id` is NOT NULL and no system-actor user
      // row exists — the scan signs with the module-reserved actor constant
      // (the sweep's precedent; never sign-in-able).
      actorUserId: REPLENISHMENT_SCHEDULER_ACTOR_ID,
      action: 'replenishment.batch_alert_raised',
      targetType: 'batch_alert',
      targetId: alertId,
      occurredAt: raisedAt,
    });
    return true;
  }
}

/**
 * The one evaluation rule, pure for the tests: `expiry_upcoming` when the
 * batch's expiry falls within the lead days (or is already past — expiry only
 * matures), `aged` when the intake-anchored age has reached the threshold. A
 * batch can hit BOTH (two rows, the queue filters by kind).
 *
 * The kinds come back in the lock read's kind tie-order (kind ASC — `aged`
 * before `expiry_upcoming`), so the raise loop below never inserts in an
 * order opposite to the one the open-alert locks were taken in.
 */
function evaluationHits(
  config: { readonly expiryLeadDays: number; readonly agingThresholdDays: number },
  batch: Pick<BatchIntake, 'expiryDate' | 'createdAt'>,
  nowMs: number,
): { kinds: BatchAlertKind[]; ageDays: number } {
  const ageDays = ageDaysSince(batch.createdAt, nowMs);
  const kinds: BatchAlertKind[] = [];
  if (ageDays >= config.agingThresholdDays) {
    kinds.push('aged');
  }
  if (batch.expiryDate !== null && Date.parse(batch.expiryDate) <= nowMs + config.expiryLeadDays * 86_400_000) {
    kinds.push('expiry_upcoming');
  }
  return { kinds, ageDays };
}