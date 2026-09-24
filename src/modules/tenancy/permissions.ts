import type { UserRole } from '../../shared/db/schema';
import { ProblemException } from '../../shared/problem-details/problem.exception';

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
  // secure/cage-class bins, and every ledger movement that touches one
  // (placement target, merge source AND target, pick draw, QC-hold origin —
  // held units leave it — and QC-release origin-return) asserts this
  // capability beside that command's existing class gate, via
  // `assertSecureBinAuthority` below. Owner + Ops Manager only (decided,
  // human, 2026-09-24): the cage is off-limits to floor staff — badge-in
  // sessions carry the actor's own role, so an operator's placement or pick
  // into/out of a secure bin 403s even though the floor verbs themselves are
  // theirs. Mirrored into wms-fe `src/lib/users.ts`.
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
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The permission matrix (spec 1.5): Owner = all capabilities including
 * `users.invite` / `users.role_change`; Ops Manager = all operational
 * mutations (warehouses, zones, bins, catalog import, SKU edit) but no user
 * management; Operator holds exactly the floor capabilities a device session
 * needs (`putaway.execute`, Story 3.5 — the first non-empty operator
 * capability, deliberate; `picks.execute`, Story 4.3; `pack.execute`, Story 4.5; `dispatch.execute`, Story 4.6) and NOT `secure.move` (Story 12-3 — the
 * cage is off-limits to floor staff); Accountant is read-only. Reads stay
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
    // Story 12-3 — FR-42: the cage is a manager verb (owner holds everything).
    'secure.move',
  ]),
  operator: new Set<Capability>([
    'putaway.execute',
    'picks.execute',
    'pack.execute',
    'dispatch.execute',
  ]),
  accountant: new Set<Capability>([]),
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
 * target, pick draw, QC-hold origin, QC-release origin-return) run this
 * beside their existing storage-class gate, with the role already re-read
 * per AD-10. Today the gate can only fire on placement and pick —
 * `bin.retire` and `qc.manage` are held by exactly the roles that hold
 * `secure.move` — and the matrix-invariant test in `test/users.spec.ts`
 * keeps that subset enforced, so a future grant must answer the cage
 * question in the open.
 */
export function assertSecureBinAuthority(
  role: UserRole,
  bins: readonly { storageClass: string | null }[],
): void {
  if (!bins.some((bin) => bin.storageClass === 'secure')) {
    return;
  }
  assertPermission(role, 'secure.move');
}