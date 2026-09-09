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
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The permission matrix (spec 1.5): Owner = all capabilities including
 * `users.invite` / `users.role_change`; Ops Manager = all operational
 * mutations (warehouses, zones, bins, catalog import, SKU edit) but no user
 * management; Operator and Accountant are read-only. Reads stay open to any
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
  ]),
  operator: new Set<Capability>([]),
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