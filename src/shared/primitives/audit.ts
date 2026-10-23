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
  // The ASN import (2026-10-17) — one file's run (`asn_import.executed`;
  // each ASN it created also writes its own `asn.created` row).
  'asn_import',
  // Story 9-3b — the async audit export (`audit_export.requested`).
  'audit_export',
  // Story 3-3a — a batch (lot) blocked or unblocked (`batch.blocked | batch.unblocked`).
  'batch',
  'batch_alert',
  'bin',
  // Story 3-1 — a bin-to-bin move (`stock.moved`; `targetId` = the moveId on
  // its events' reference doc — there is no move table, the ledger is its record).
  'bin_move',
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
  // Story 2-3a — an inbound vehicle visit (`gate_in.recorded | amended |
  // unload_started | unload_ended | gated_out`).
  'gate_in',
  'goods_receipt',
  'kit',
  // Story 9-3c — a ledger chain break (`ledger_chain_break.acknowledged`).
  'ledger_chain_break',
  // Story 1-6c — a drug or FSSAI licence (`licence.added | edited |
  // withdrawn`, and the expiry sweep's `licence.expiry_upcoming_raised |
  // expired_raised`, system actor).
  'licence',
  // Story 1-6d — the tenant's licence enforcement switch (`licence.enforcement_enabled | disabled`).
  'licence_policy',
  'ledger_event',
  'manifest',
  'order',
  'over_receipt',
  // Story 1-3 — a business partner (`partner.created | updated | deactivated
  // | reactivated`) and one of its client links (`partner.linked |
  // link_updated | link_deactivated | link_reactivated`). The Story 3.1
  // `vendor` target left the write registry with them (no writer stores it
  // now); the audit read still accepts it for historical rows —
  // `AUDIT_READ_TARGET_TYPES`.
  'partner',
  'partner_link',
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
  // Story 13-1 — a return authorization (`return_authorization.created | .cancelled`).
  'return_authorization',
  // Story 13-2 — a return receipt (`return_receipt.recorded`; an all-refused
  // receipt targets its `return_authorization` instead).
  'return_receipt',
  'sku',
  'stock_adjustment_pending',
  'stock_adjustment_policy',
  'suggested_po',
  'temperature_excursion',
  'tenant',
  'transfer_order',
  'user',
  'warehouse',
  'wave',
  'wave_policy',
  'zone',
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * Story 1-3 — target types no writer stores any more but historical rows
 * carry: `vendor` (Story 3.1's `vendor.created`, until the partner master
 * replaced it). Kept on the audit read's filter so an owner can still find
 * those rows; never written.
 */
export const RETIRED_AUDIT_TARGET_TYPES = ['vendor'] as const;

/** The audit read's `targetType` filter vocabulary: every written type plus the retired ones. */
export const AUDIT_READ_TARGET_TYPES = [...AUDIT_TARGET_TYPES, ...RETIRED_AUDIT_TARGET_TYPES] as const;
export type AuditReadTargetType = (typeof AUDIT_READ_TARGET_TYPES)[number];

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
  { action: 'sku.edited', targetType: 'sku' },
  // Story 1-4 — the single-SKU create and the packaging PUT (`SkuCommand`).
  { action: 'sku.created', targetType: 'sku' },
  { action: 'sku.packaging_replaced', targetType: 'sku' },
  // Story 1-4b — the SKU status route (`SkuCommand.updateStatus`); a new
  // reason on an inactive SKU writes the existing `sku.edited`.
  { action: 'sku.deactivated', targetType: 'sku' },
  { action: 'sku.reactivated', targetType: 'sku' },
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
  // Story 3-5a — a class unscheduled (`CountService.deleteCountPolicy`). The
  // bulk create writes one `count.created` per created task under one key;
  // an all-skipped bulk create is a declared no-op (`counts.createBulk:all-skipped`).
  { action: 'count_policy.removed', targetType: 'warehouse' },
  { action: 'device.enrolled', targetType: 'device' },
  // Story 9-3b — the export request (tenancy's `AuditExportCommand`).
  { action: 'audit_export.requested', targetType: 'audit_export' },
  // Story 9-3c — the owner acknowledges a chain break (inventory's `LedgerBreakCommand`).
  { action: 'ledger_chain_break.acknowledged', targetType: 'ledger_chain_break' },
  // Story 13-1 — the returns module's two commands (`ReturnAuthorizationCommand`).
  { action: 'return_authorization.created', targetType: 'return_authorization' },
  { action: 'return_authorization.cancelled', targetType: 'return_authorization' },
  // Story 13-2 — the handheld's return receipt (`ReturnReceiptCommand`); its
  // all-refused arm targets the authorization (pinned in the same suite).
  { action: 'return_receipt.recorded', targetType: 'return_receipt' },
  // The ASN import (2026-10-17) — one row per import run, beside each created
  // ASN's own `asn.created` (all under the import's one key).
  { action: 'asn_import.executed', targetType: 'asn_import' },
  // Story 3-1 — the bin-to-bin move (`MoveCommand.moveStock`); the actor is
  // the operator, also on a review Apply.
  { action: 'stock.moved', targetType: 'bin_move' },
  // Story 6-1a — staff offboarding and the lockout unlocks.
  { action: 'user.deactivated', targetType: 'user' },
  { action: 'user.reactivated', targetType: 'user' },
  { action: 'user.unlocked', targetType: 'user' },
  // Story 5-1a — an invitation resent with a fresh token (`UsersCommand.resendInvite`).
  { action: 'user.invite_resent', targetType: 'user' },
  { action: 'device.released', targetType: 'device' },
  { action: 'device.unlocked', targetType: 'device' },
  // Code review (C11) — the security events of a session's life.
  { action: 'session.reuse_detected', targetType: 'user' },
  { action: 'session.signed_out', targetType: 'user' },
  { action: 'user.sign_in_locked', targetType: 'user' },
  { action: 'device.badge_locked', targetType: 'device' },
  { action: 'device.badged_out', targetType: 'device' },
  // Story 6-1b — the second factor's life (`second-factor.command.ts`, `second-factor.ts`).
  { action: 'user.second_factor_enabled', targetType: 'user' },
  { action: 'user.second_factor_disabled', targetType: 'user' },
  { action: 'user.backup_codes_regenerated', targetType: 'user' },
  { action: 'user.backup_code_used', targetType: 'user' },
  { action: 'user.second_factor_locked', targetType: 'user' },
  { action: 'user.second_factor_reset', targetType: 'user' },
  // Story 1-2a — the client master record (`ClientsCommand`): departure, the
  // address patch, the contact list. Every one targets the client.
  { action: 'client.departed', targetType: 'client' },
  { action: 'client.addresses_updated', targetType: 'client' },
  { action: 'client.contact_added', targetType: 'client' },
  { action: 'client.contact_edited', targetType: 'client' },
  { action: 'client.contact_removed', targetType: 'client' },
  // Story 1-2b — the receiving policy (`ClientsCommand.updateReceivingPolicy`),
  // a shelf-life refusal accepted from review (the re-run receipt, actor the
  // reviewer), and QC on receipt: ONE row per receipt (or approved excess)
  // placed on holds and ONE per receipt released — each targeting the GRN.
  { action: 'client.receiving_policy_updated', targetType: 'client' },
  { action: 'goods_receipt.shelf_life_waived', targetType: 'goods_receipt' },
  { action: 'qc_hold.receipt_placed', targetType: 'goods_receipt' },
  { action: 'qc_hold.receipt_released', targetType: 'goods_receipt' },
  // Story 2-8a — the QC inspection outcome closes one hold (`QcCommand.inspectHold`).
  { action: 'qc_hold.inspected', targetType: 'qc_hold' },
  // Story 3-3a — the batch block verb (catalog's `BatchBlockCommand`); each
  // row's `changes` carries the before/after status, reason and note, so the
  // history survives the unblock clearing the row.
  { action: 'batch.blocked', targetType: 'batch' },
  { action: 'batch.unblocked', targetType: 'batch' },
  // Story 1-3 — the business partner master (`PartnersCommand`). The Story
  // 3.1 `vendor.created` audit action left the registry with it (the outbox
  // event of that name stays).
  { action: 'partner.created', targetType: 'partner' },
  { action: 'partner.updated', targetType: 'partner' },
  { action: 'partner.deactivated', targetType: 'partner' },
  { action: 'partner.reactivated', targetType: 'partner' },
  { action: 'partner.linked', targetType: 'partner_link' },
  { action: 'partner.link_updated', targetType: 'partner_link' },
  { action: 'partner.link_deactivated', targetType: 'partner_link' },
  { action: 'partner.link_reactivated', targetType: 'partner_link' },
  // Story 1-6c — the licence master (`LicenceCommand`); an unchanged edit is
  // a declared no-op (`licences.edit:unchanged`). The expiry sweep's raises
  // are unkeyed system rows (`SYSTEM_ACTOR_ID`), outside this list.
  { action: 'licence.added', targetType: 'licence' },
  { action: 'licence.edited', targetType: 'licence' },
  { action: 'licence.withdrawn', targetType: 'licence' },
  // Story 1-6d — the enforcement switch flipped (an unchanged PUT is a
  // declared no-op, `licencePolicy.put:unchanged`), and a licence refusal
  // accepted from review (the re-run receipt, actor the owner who applied).
  { action: 'licence.enforcement_enabled', targetType: 'licence_policy' },
  { action: 'licence.enforcement_disabled', targetType: 'licence_policy' },
  { action: 'goods_receipt.licence_waived', targetType: 'goods_receipt' },
  // Story 2-3a — the gate-in (`GateInCommand`). An unload that fills nothing
  // is a declared no-op (`gateIns.unload:already-recorded` — the key is
  // stored, nothing audited); an end with no start audits only
  // `gate_in.unload_ended` (it stamps the start too).
  { action: 'gate_in.recorded', targetType: 'gate_in' },
  { action: 'gate_in.amended', targetType: 'gate_in' },
  { action: 'gate_in.unload_started', targetType: 'gate_in' },
  { action: 'gate_in.unload_ended', targetType: 'gate_in' },
  { action: 'gate_in.gated_out', targetType: 'gate_in' },
] as const satisfies readonly { action: string; targetType: AuditTargetType }[];
