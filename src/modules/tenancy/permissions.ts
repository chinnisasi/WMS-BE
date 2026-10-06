import type { UserRole } from '../../shared/db/schema';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { SECURE_STORAGE_CLASS } from '../../shared/primitives/storage-class';

/**
 * Capabilities (Story 1.5) — the machine names mutations are gated on. Reads
 * are never gated (any tenant member may list warehouses, SKUs, the checklist
 * …); only command services consult this map, at entry.
 */
export const CAPABILITIES = [
  'warehouse.create',
  'zone.create',
  'bin.create',
  'bin.block',
  'catalog.import',
  'sku.edit',
  'users.invite',
  'users.role_change',
  // Story 2.1 — the manual stock adjustment (the first ledger movement
  // producer). Mirrored into wms-fe `src/lib/users.ts` by the frontend (the
  // cross-repo drift guard for that mirror is a deferred item).
  'stock.adjust',
  // Story 3.1 — the inbound module's mutations (vendor master data + the PO
  // lifecycle). Owner and Ops Manager only; Operator and Accountant are
  // read-only.
  'vendor.manage',
  'po.manage',
  // Story 3.2 — floor-device lifecycle (mint one-time enrollment codes,
  // revoke devices). Owner and Ops Manager; enrollment-code redemption and
  // badge-in authenticate the operator, never a capability.
  'device.manage',
  // Story 3.3 — the human-review decisions (over-receipt approve/reject; the
  // Conflicts & Reviews queue). Owner and Ops Manager decide every
  // over-receipt in v1; threshold-based Owner routing lands with FR-19.
  'review.decide',
  // Story 3.4 — the QC hold/release decisions (place a hold on a (sku, bin)
  // scope, release it). Owner and Ops Manager; operators record receipts, they
  // do not quarantine stock. Mirrored into wms-fe `src/lib/users.ts`.
  'qc.manage',
  // Story 3.5 — the directed-putaway placement command. Owner + Ops Manager +
  // Operator (the first non-empty operator capability, deliberate: operators
  // place the stock they received); Accountant stays read-only. Mirrored into
  // wms-fe `src/lib/users.ts`.
  'putaway.execute',
  // Story 3.6 — bin administration's stock-touching mutations (merge a
  // source bin into a target, retire an empty bin). Owner + Ops Manager only
  // (Accountant/Operator none) — a merge moves stock, a retire is terminal.
  // Mirrored into wms-fe `src/lib/users.ts`.
  'bin.retire',
  // Story 4.1 — the outbound module's mutations (manual order entry +
  // ingested-order ingestion, both accepted with per-line ATP reservation;
  // cancellation). Owner and Ops Manager only; Operator and Accountant are
  // read-only. Mirrored into wms-fe `src/lib/users.ts` by the FE story.
  'orders.manage',
  // Story 4.2 — the outbound module's wave surface (generate a wave from
  // accepted orders, release it to the floor, cancel it) AND the wave-policy
  // writes that surface references: a policy IS the wave rule, so gating it
  // separately would let a role that cannot wave rewrite what waving means.
  // Owner and Ops Manager only; Operator picks (4.3), it does not plan.
  // Mirrored into wms-fe `src/lib/users.ts` by the FE story.
  'waves.manage',
  // Story 4.3 — the scan-verified pick command. Owner + Ops Manager +
  // Operator (the floor executes the walk the planner released); Accountant
  // stays read-only. Mirrored into wms-fe `src/lib/users.ts` by the FE story.
  'picks.execute',
  // Story 4.5 — the pack-station verification command. Owner + Ops Manager +
  // Operator, mirroring `picks.execute`: a Pack Station is a place in the
  // building, not an entity, and the person standing at it is an Operator.
  // Accountant stays read-only. Mirrored into wms-fe `src/lib/users.ts` by
  // the 4.2b FE story with the other outbound capabilities.
  'pack.execute',
  // Story 4.6 — the dispatch command, the order's terminal transition. Owner
  // + Ops Manager + Operator, mirroring `pack.execute` exactly: the person
  // who hands the parcel to the courier is the same person who packed it.
  // Accountant stays read-only. Mirrored into wms-fe `src/lib/users.ts` by
  // the 4.2b FE story with the other outbound capabilities.
  'dispatch.execute',
  // Story 12-3 — FR-42's authority gate: high-value/controlled stock lives in
  // secure/cage-class bins, and every ledger movement that touches one except
  // the named `stock.adjust` bypass (placement target, merge source AND
  // target, pick draw, QC-hold origin — held units leave it — and
  // QC-release origin-return) asserts this capability beside that command's
  // existing class gate, via `assertSecureBinAuthority` below. Owner + Ops
  // Manager only (decided, human, 2026-09-24): the cage is off-limits to
  // floor staff — badge-in sessions carry the actor's own role, so an
  // operator's placement or pick into/out of a secure bin 403s even though
  // the floor verbs themselves are theirs. Mirrored into wms-fe
  // `src/lib/users.ts`.
  'secure.move',
  // Story 4.6b — the carrier credential vault (connect a carrier account,
  // rotate its material, disconnect it). A SETTINGS capability, mirroring
  // `device.manage` / `vendor.manage`: Owner and Ops Manager only, absent
  // from `operator` and `accountant` — an API key is not a floor verb.
  // Deliberately NOT on the carrier reads: the registry catalogue and the
  // connection list are open to any tenant member, because reads are never
  // gated here (the rule at the top of this file) — and those rows carry the
  // connection's public face only, never credential material, so there is
  // nothing for a gate to protect. Mirrored into wms-fe `src/lib/users.ts`.
  'carrier.manage',
  // Story 7-1 — the channels surface's mutations (connect a sales channel,
  // rotate its credential, set its backorder policy + standing buffers,
  // disconnect, retry a stalled sync). A SETTINGS capability mirroring
  // `carrier.manage`: Owner and Ops Manager only (the spec's frozen holder
  // set — channels are not a floor verb and not an accounting verb);
  // Operator and Accountant absent (the FE story: no Operator-visible entry).
  // Deliberately NOT on the connection-list read (arm 4): reads are never
  // gated (the rule at the top of this file), and the rows carry the public
  // face only. Mirrored into wms-fe `src/lib/users.ts`.
  'channel.manage',
  // Story 12-5 — FR-44's recording verb: an operator on the floor records a
  // temperature excursion against a bin (owner + Ops Manager + Operator,
  // mirroring `putaway.execute`'s rationale — the floor records what it
  // observes); Accountant stays read-only. The excursion's QUARANTINE rides
  // the existing `qc.manage` semantics (the extracted hold helper) and its
  // RESOLUTION is `review.decide`'s — this capability answers only "record
  // what you observed", so it deliberately does NOT gate a resolve.
  // Mirrored into wms-fe `src/lib/users.ts`.
  'excursion.record',
  // Story 4.6c — the label + manifest commands. Owner + Ops Manager +
  // Operator, mirroring `pack.execute` exactly: the label is a station verb
  // — the person who packed the parcel prints its label and closes its
  // manifest. Accountant stays read-only. Mirrored into wms-fe
  // `src/lib/users.ts` by the 4.6c FE task.
  'labels.execute',
  // Story 5-1 — the transfer-order commands (FR-18/FR-29). `transfers.manage`
  // plans and confirms the outbound leg (create + cancel + outbound confirm —
  // the planner verbs); `transfers.execute` confirms the inbound leg, the
  // floor verb, mirroring `picks.execute`/`putaway.execute`'s rationale: the
  // operator puts the units that arrived away. Accountant stays read-only.
  // Mirrored into wms-fe `src/lib/users.ts` by the FE story.
  'transfers.manage',
  // The inbound confirm is an operator task (the Transfer inbox tab's op);
  // Owner + Ops Manager + Operator, mirroring `putaway.execute`.
  'transfers.execute',
  // Story 5-2 — FR-19's approval-threshold decisions: approve or reject a
  // stock adjustment that pended because |quantityDelta| exceeded the
  // tenant's policy threshold. OWNER-ONLY (decided, human, 2026-09-28 — the
  // review-loop-1 intent: the person who set the bar is the person who
  // watches it crossed; an Ops Manager can still LOWER an adjustment below
  // the threshold with `stock.adjust` and apply it immediately, so the
  // owner-only gate is a review control, not a lockout). The capability also
  // gates the POLICY write (`setAdjustmentPolicy`) — a policy IS the approval
  // rule, so gating it separately would let a role that cannot approve
  // redefine what approval means (the `waves.manage` rationale). This is the
  // FR-19 Owner routing the Story 3.3 `review.decide` comment deferred.
  // Deliberately NOT mirrored onto any other role: ops_manager, operator and
  // accountant all stay as they were. Mirrored into wms-fe
  // `src/lib/users.ts` (FE commit 8c1bfc7 — do not re-create).
  'adjustments.approve',
  // Story 5-3 — FR-cycle-count's verbs. `counts.manage` plans: the on-demand
  // count create (a planner pointing a bin at a count) AND the per-warehouse
  // policy write (a policy IS the schedule — gating it separately would let
  // a role that cannot manage counts redefine when counts happen, the
  // `waves.manage` rationale). `counts.execute` is the floor verb —
  // submitting the counted quantities through the inbox Count tab, mirroring
  // `transfers.execute`/`picks.execute`: the operator counts what it walks.
  // Accountant stays read-only. Mirrored into wms-fe `src/lib/users.ts`.
  'counts.manage',
  // The count submit is an operator task (the Count inbox tab's op; the
  // floor-verb pattern — `putaway.execute`'s rationale).
  'counts.execute',
  // Story 5-4 — FR-cycle-count's resolution verb: resolving an open count
  // variance by approve-adjust (the explicit stock correction, one
  // `variances.resolve` step — no second requester) or recount (the fresh
  // recount task as the new basis). Owner + Ops Manager (CHECKPOINT 1,
  // ratified 2026-09-29 — the counts.execute reviewer floor, one step above
  // the floor that counts); Accountant stays read-only; Operator counts but
  // never resolves. Over-threshold variances stay owner-only not by the
  // capability but by the resolve command's frozen-threshold guard (the
  // variance row carries the submit-time threshold) — the `adjustments.approve`
  // rationale at the command instead of the capability, because the
  // threshold here is per-SKU delta, not the movement itself. The capability
  // also gates the variance-threshold POLICY write (a policy IS the
  // resolution rule — the `waves.manage` rationale). Mirrored into wms-fe
  // `src/lib/users.ts`.
  'variances.resolve',
  // Story 6.1 — FR-22's replenishment verbs: the per-warehouse reorder-policy
  // writes (upsert + delete), the breach dismissal, and the suggested-PO
  // submit. Owner + Ops Manager (the planning set; the floor never acts on
  // replenishment drafts). The submit arm re-executes PO creation under
  // `po.manage` on the same transaction, so the inbound gate stays live
  // there — a holder of `replenishment.manage` without `po.manage` could not
  // exist by construction, and the inner assert is the proof. Deliberately
  // NOT gating the list reads (policies / breaches / drafts): reads are
  // never gated (the rule at the top of this file). Mirrored into wms-fe
  // `src/lib/users.ts`.
  'replenishment.manage',
  // Story 8-1 — the invoicing module's manual generate/regenerate command
  // (price an unpriced line, refresh an invoice from the dispatch facts).
  // Owner + Ops Manager only, mirroring `replenishment.manage`'s planner
  // set: invoicing is a FINANCE-side act (a tax document with a legal
  // number), not a floor verb and not a counting verb — the Accountant's
  // surface reads invoices but the RATE OVERRIDE that decides what a buyer
  // is charged stays with the owner/manager pair. Operator absent (floor
  // staff record dispatches; dispatch auto-generates nothing they can
  // change). Mirrored into wms-fe `src/lib/users.ts` by the 8-1 FE story.
  'invoice.generate',
  // Story 8-2b — the e-way bill verbs: enter Part B (transport), export the
  // NIC bulk JSON, record a returned EWB number, dismiss, and generate
  // through the gateway. Owner + Ops Manager + ACCOUNTANT — the accountant's
  // FIRST write capability, a deliberate exception (decided, human,
  // 2026-10-04): e-way paperwork is finance work. Operator absent.
  'eway.manage',
  // Story 8-2b — the e-way configuration: the per-state threshold overrides
  // and the per-GSTIN "e-invoicing applies" flag. OWNER-ONLY (a threshold
  // decides which consignments need a bill — the `adjustments.approve`
  // rationale: the person who sets the bar).
  'eway.configure',
  // Story 21-2b — client admin: register a client brand, rename it, and
  // correct a SKU's client while the SKU has no history. OWNER-ONLY: a client
  // is a commercial relationship (who the 3PL holds goods for and, from 21-5,
  // whom it bills), the `adjustments.approve` / `eway.configure` rationale —
  // the person who signs the contract. The client LIST read stays open to
  // any member (reads are never gated). Mirrored into wms-fe
  // `src/lib/users.ts` (CAPABILITIES + OWNER_ONLY_CAPABILITIES).
  'clients.manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The permission matrix (spec 1.5): Owner = all capabilities including
 * `users.invite` / `users.role_change`; Ops Manager = all operational
 * mutations (warehouses, zones, bins, catalog import, SKU edit) but no user
 * management; Operator holds exactly the floor capabilities a device session
 * needs (`putaway.execute`, Story 3.5 — the first non-empty operator
 * capability, deliberate; `picks.execute`, Story 4.3; `pack.execute`, Story 4.5; `dispatch.execute`, Story 4.6; `labels.execute`, Story 4.6c; `excursion.record`, Story 12-5; `transfers.execute`, Story 5-1; `counts.execute`, Story 5-3 — the floor
 * records what it observes) and NOT `secure.move` (Story 12-3 — the
 * cage is off-limits to floor staff); Accountant is read-only except
 * `eway.manage` (Story 8-2b — e-way paperwork is finance work). Reads stay
 * open to any tenant member.
 */
export const ROLE_CAPABILITIES: Readonly<Record<UserRole, ReadonlySet<Capability>>> = {
  owner: new Set<Capability>(CAPABILITIES),
  ops_manager: new Set<Capability>([
    'warehouse.create',
    'zone.create',
    'bin.create',
    'bin.block',
    'catalog.import',
    'sku.edit',
    'stock.adjust',
    'vendor.manage',
    'po.manage',
    'device.manage',
    'review.decide',
    'qc.manage',
    'putaway.execute',
    'bin.retire',
    'orders.manage',
    'waves.manage',
    'picks.execute',
    'pack.execute',
    'dispatch.execute',
    'carrier.manage',
    // Story 7-1 — the channels verbs (owner holds everything): connect,
    // rotate, config, buffers, disconnect, retry — the settings operator.
    'channel.manage',
    // Story 12-5 — FR-44: the manager records excursions too (owner holds
    // everything).
    'excursion.record',
    // Story 4.6c — the label + manifest station verbs, mirroring
    // `pack.execute` (owner holds everything).
    'labels.execute',
    // Story 12-3 — FR-42: the cage is a manager verb (owner holds everything).
    'secure.move',
    // Story 5-1 — the transfer planner verbs (owner holds everything).
    'transfers.manage',
    // Story 5-1 — the manager may confirm an inbound leg too (the floor
    // verb's holder set mirrors `putaway.execute`).
    'transfers.execute',
    // Story 5-3 — the count planner verbs + the floor verb (owner holds
    // everything; the execute holder set mirrors `putaway.execute`).
    'counts.manage',
    'counts.execute',
    // Story 5-4 — the variance resolution verb (CHECKPOINT 1: owner +
    // ops_manager; over-threshold stays owner-only at the command's
    // frozen-threshold guard, not here).
    'variances.resolve',
    // Story 6.1 — the replenishment verbs (owner holds everything): the
    // reorder-policy writes, breach dismissal, and suggested-PO submit — the
    // planning set, the stock-intelligence surface's operator.
    'replenishment.manage',
    // Story 8-1 — the invoicing verbs (owner holds everything): the manual
    // generate/regenerate with per-line rate overrides. Mirror of
    // `replenishment.manage`'s planner-set rationale in CAPABILITIES above.
    'invoice.generate',
    // Story 8-2b — the e-way paperwork (not its configuration, owner-only).
    'eway.manage',
  ]),
  operator: new Set<Capability>([
    'putaway.execute',
    'picks.execute',
    'pack.execute',
    'dispatch.execute',
    // Story 4.6c — the label + manifest station verbs, mirroring
    // `pack.execute` / `dispatch.execute`.
    'labels.execute',
    // Story 12-5 — the floor records what it observes (`putaway.execute`'s
    // rationale); a secure-bin excursion still answers the 12-3 cage gate at
    // the hold movements it triggers, which the operator deliberately does
    // not hold.
    'excursion.record',
    // Story 5-1 — the floor confirms the inbound leg (the Transfer inbox
    // task's op; `putaway.execute`'s rationale — the operator puts away what
    // arrived). A secure/cage dest bin still answers the 12-3 gate at the
    // intake movement, which the operator deliberately does not hold.
    'transfers.execute',
    // Story 5-3 — the floor counts the bin (the Count inbox tab's op,
    // mirroring `transfers.execute`).
    'counts.execute',
  ]),
  // Story 8-2b: the accountant's first (and only) write — the e-way
  // paperwork (finance work). Everything else stays read-only.
  accountant: new Set<Capability>(['eway.manage']),
};

/**
 * The single authorization primitive (Story 1.5). Called at **command-service
 * entry** with the role freshly read from the DB inside the command's tenant
 * transaction — never from the session guard, never from a JWT claim. A role
 * change applies to the user's next command because every command re-reads
 * the row ("next action, not next login").
 *
 * Denied mutations throw 403 `role-denied` naming the role and the capability;
 * no partial writes exist because the assert runs before any write.
 */
export function assertPermission(role: UserRole, capability: Capability): void {
  if (!ROLE_CAPABILITIES[role].has(capability)) {
    throw new ProblemException(
      'role-denied',
      403,
      'Role lacks the required capability',
      `Role "${role}" does not include the "${capability}" capability.`,
    );
  }
}

/**
 * FR-42's secure-bin authority gate (Story 12-3): a ledger movement whose
 * bin row carries `storageClass: 'secure'` additionally requires the
 * `secure.move` capability — the (role, bin) authority question, decided on
 * the SAME bin row the class gates already hold, so the assert rides the
 * existing gate slot with no new query and no lock change.
 *
 * One assert over the involved bins, not one per pair — the capability is
 * about touching the cage at all, not about which direction the stock moves.
 * The refusal is exactly `assertPermission`'s 403 `role-denied` shape,
 * naming `secure.move`. A bin whose class is anything else (or null) never
 * triggers it — non-secure movements are byte-identical to the pre-12.3
 * build.
 *
 * Callers (the five movement writers — placement target, merge source AND
 * target, pick draw, QC-hold origin, QC-release origin-return; `stock.adjust`
 * is the named bypass beside all five) run this beside their existing
 * storage-class gate, with the role already re-read per AD-10. The merge,
 * hold and release asserts are non-denying today (the matrix invariant keeps
 * the subset enforced) — every `bin.retire`/`qc.manage` holder also holds
 * `secure.move` — while the placement and pick asserts are live code the
 * operator can hit. Either way the assert runs and is the future 403; the
 * matrix-invariant test in `test/users.spec.ts` keeps the subset enforced,
 * so a future grant must answer the cage question in the open.
 */
export function assertSecureBinAuthority(
  role: UserRole,
  bins: readonly { storageClass: string | null }[],
): void {
  if (!bins.some((bin) => bin.storageClass === SECURE_STORAGE_CLASS)) {
    return;
  }
  assertPermission(role, 'secure.move');
}