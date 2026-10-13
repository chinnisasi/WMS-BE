/**
 * The audit trail's shared vocabulary (story 9-3a, FR-28).
 *
 * **The audit rule.** Every committed, non-replay execution of a command that
 * writes `idempotency_keys` also writes at least one `audit_events` row in the
 * same transaction (skeleton step 10, IMPLEMENTATION-GUIDE §1), carrying
 * `reference` = the idempotency key (a few pre-9-3a actions keep a composite
 * reference that carries it — `COMPOSITE_REFERENCE_ACTIONS` in the guard) and
 * `occurred_at` = `nowIso()` for the rows 9-3a adds. Two guards hold it:
 * `assertEveryKeyAudited` (`test/support/audit-guard.ts`), which runs inside
 * `SuiteDatabase.drop()` — the last step of every e2e suite's `afterAll`,
 * after its cleanup, which may not delete keys or audit rows (pinned in
 * `test/architecture.spec.ts`) — and the all-files static scan in
 * `test/architecture.spec.ts`. Deliberate no-op arms (a key stored, nothing
 * changed) write no row and are declared by name in the guard. Unkeyed
 * system writers — sweeps, schedulers, sign-in, badge-in, push registration —
 * are outside the rule.
 */

/**
 * The reserved audit actor for system-originated rows: `audit_events.
 * actor_user_id` is NOT NULL and no system-actor user row exists, so the
 * replenishment sweep's and expiry scan's detection rows ride this constant.
 * It is NOT sign-in-able — no user row, no session — merely a reserved uuid
 * the audit trail can name (`01900000-…`, a UUIDv7 shape minted for the epoch
 * the replenishment module was carved out in). Moved here from
 * `replenishment.command.ts` (story 9-3a) so the audit read can answer
 * `actorKind: 'system'` without importing a sibling module; the old name is
 * re-exported there.
 */
export const SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-000000000000';

/**
 * Every literal `audit_events.target_type` written anywhere under `src` — the
 * audit read's `targetType` filter vocabulary, published as the query enum in
 * `openapi.json` (the web's select is generated from it). Pinned against the
 * source by `test/architecture.spec.ts` ("AUDIT_TARGET_TYPES is the
 * vocabulary"): a writer with a literal missing here, or an entry no writer
 * uses, fails the build. The two dynamic writers are covered by listing their
 * possible values: `pick.command.ts` (`'picklist_line' | 'pick'`) and the
 * e-way `audit()` helper (`'eway_bill' | 'eway_state_threshold' |
 * 'eway_gstin_setting'`).
 */
export const AUDIT_TARGET_TYPES = [
  'advance_shipment_notice',
  // Story 9-3b — the async audit export (`audit_export.requested`).
  'audit_export',
  'batch_alert',
  'bin',
  'carrier_connection',
  'catalog_import',
  'channel_connection',
  'client',
  'client_invoice',
  'count_task',
  'count_variance',
  'count_variance_policy',
  'device',
  'eway_bill',
  'eway_gstin_setting',
  'eway_state_threshold',
  'expiry_alert_policy',
  'goods_receipt',
  'kit',
  'ledger_event',
  'manifest',
  'order',
  'over_receipt',
  'pick',
  'picklist_line',
  'product',
  'purchase_order',
  'putaway_placement',
  'qc_hold',
  'rate_card',
  'rejected_op',
  'reorder_breach',
  'reorder_policy',
  'sku',
  'stock_adjustment_pending',
  'stock_adjustment_policy',
  'suggested_po',
  'temperature_excursion',
  'tenant',
  'transfer_order',
  'user',
  'vendor',
  'warehouse',
  'wave',
  'wave_policy',
  'zone',
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * The audit rows story 9-3a added (going forward only — no backfill). One
 * entry per action string; each is pinned by an assertion in its existing
 * suite (one row with this action, target and actor; none on replay).
 */
export const AUDIT_NEW_ACTIONS = [
  { action: 'transfer.created', targetType: 'transfer_order' },
  { action: 'transfer.outbound_confirmed', targetType: 'transfer_order' },
  { action: 'transfer.inbound_confirmed', targetType: 'transfer_order' },
  { action: 'transfer.cancelled', targetType: 'transfer_order' },
  { action: 'purchase_order.created', targetType: 'purchase_order' },
  { action: 'purchase_order.amended', targetType: 'purchase_order' },
  { action: 'purchase_order.closed', targetType: 'purchase_order' },
  { action: 'vendor.created', targetType: 'vendor' },
  { action: 'sku.edited', targetType: 'sku' },
  { action: 'product.created', targetType: 'product' },
  { action: 'product.edited', targetType: 'product' },
  { action: 'kit.created', targetType: 'kit' },
  { action: 'kit.components_replaced', targetType: 'kit' },
  { action: 'catalog_import.executed', targetType: 'catalog_import' },
  { action: 'warehouse.created', targetType: 'warehouse' },
  { action: 'zone.created', targetType: 'zone' },
  { action: 'bin.created', targetType: 'bin' },
  { action: 'bin.grid_generated', targetType: 'zone' },
  { action: 'tenant.registered', targetType: 'tenant' },
  { action: 'goods_receipt.submitted', targetType: 'goods_receipt' },
  { action: 'count.created', targetType: 'count_task' },
  { action: 'count.submitted', targetType: 'count_task' },
  { action: 'count_policy.updated', targetType: 'warehouse' },
  { action: 'device.enrolled', targetType: 'device' },
  // Story 9-3b — the export request (tenancy's `AuditExportCommand`).
  { action: 'audit_export.requested', targetType: 'audit_export' },
] as const satisfies readonly { action: string; targetType: AuditTargetType }[];
