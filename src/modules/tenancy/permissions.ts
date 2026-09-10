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
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The permission matrix (spec 1.5): Owner = all capabilities including
 * `users.invite` / `users.role_change`; Ops Manager = all operational
 * mutations (warehouses, zones, bins, catalog import, SKU edit) but no user
 * management; Operator holds exactly the floor capabilities a device session
 * needs (`putaway.execute`, Story 3.5 — the first non-empty operator
 * capability, deliberate); Accountant is read-only. Reads stay open to any
 * tenant member.
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
  ]),
  operator: new Set<Capability>(['putaway.execute']),
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