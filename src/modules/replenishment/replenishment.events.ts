import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { OutboxSink } from '../../shared/events/outbox.seam';

/**
 * Story 9-2 — the replenishment alerts' CLEARING events (the notification
 * panel's resolves for the reorder-breach and batch-alert sources).
 *
 * This REVERSES the 6-1/6-2 rule that a breach recovery and a batch-alert
 * auto-resolve emit no outbox event ("they had no consumer"): the
 * notifications module is now that consumer, and an alert whose clearing
 * nothing hears would stand open in the panel forever. Every transition out
 * of `open` emits exactly one event, in the transaction that makes it:
 *
 *   breach  open → recovered (sweep)        reason 'recovered'
 *           open → dismissed (command)      reason 'dismissed'
 *           open → actioned  (PO submit)    reason 'actioned'
 *           its policy deleted (command)    reason 'policy-removed'
 *   alert   open → resolved  (expiry scan)  reason 'resolved'
 *           open → dismissed (command)      reason 'dismissed'
 */
export const BREACH_CLEARED_EVENT = 'replenishment.breach_cleared';
export const BATCH_ALERT_CLEARED_EVENT = 'replenishment.batch_alert_cleared';

export type BreachClearedReason = 'recovered' | 'dismissed' | 'actioned' | 'policy-removed';
export type BatchAlertClearedReason = 'resolved' | 'dismissed';

export async function appendBreachCleared(
  outbox: OutboxSink,
  tx: TenantTx,
  tenantId: string,
  breach: { readonly id: string; readonly warehouseId: string; readonly skuId: string },
  reason: BreachClearedReason,
  occurredAt: string = nowIso(),
): Promise<void> {
  await outbox.append(tx, {
    messageId: uuidv7(),
    tenantId,
    type: BREACH_CLEARED_EVENT,
    occurredAt,
    payload: { breachId: breach.id, warehouseId: breach.warehouseId, skuId: breach.skuId, reason },
  });
}

export async function appendBatchAlertCleared(
  outbox: OutboxSink,
  tx: TenantTx,
  tenantId: string,
  alert: { readonly id: string; readonly warehouseId: string },
  reason: BatchAlertClearedReason,
  occurredAt: string = nowIso(),
): Promise<void> {
  await outbox.append(tx, {
    messageId: uuidv7(),
    tenantId,
    type: BATCH_ALERT_CLEARED_EVENT,
    occurredAt,
    payload: { alertId: alert.id, warehouseId: alert.warehouseId, reason },
  });
}
