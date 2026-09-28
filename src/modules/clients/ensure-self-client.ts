import { and, eq } from 'drizzle-orm';
import { SELF_CLIENT_CODE, clients } from './clients.schema';
import { uuidv7 } from '../../shared/primitives/ids';
import type { TenantTx } from '../../shared/db/tenant-scope';

/**
 * The system-owned `self` client (story 21-1, AD-23): every tenant owns
 * exactly one — created in the SAME transaction as the tenant by
 * registration, and backfilled for pre-existing tenants by migration 0040.
 * D2C is the one-client case of the 3PL model, so nothing anywhere branches
 * on "3PL mode": every writer of a client-stamped table resolves the tenant's
 * self client through this one helper and stamps the column.
 *
 * Identity is the fixed code `self` + `system_owned` — the
 * `ensureReceivingBinInTx`/`ensureQcHoldBinInTx` precedent
 * (`../tenancy/receiving-bin.ts`): select, then insert-on-conflict, then
 * re-select, inside the CALLER's transaction. A concurrent ensure races on
 * the unique indexes (`clients_tenant_id_code_unique`, and the partial
 * `clients_tenant_system_owned_unique`) and the loser re-selects the
 * winner's row. The system-owned predicate in both selects is the QC-hold
 * lesson: a user-created client coded `self` is not the self client —
 * adopting it would misattribute stock, so the row must be the system's.
 *
 * Idempotent by construction: on an existing tenant the first select returns
 * the row and nothing is written. `selfClientName` is supplied only where the
 * caller has just created the tenant (registration) and only used when the
 * client does not exist yet; a caller without a name that finds NO self
 * client is a broken invariant (a tenant born before its client) and fails
 * loudly rather than fabricating one mid-movement.
 *
 * Migration-time backfilled rows carry a `gen_random_uuid()` id (the 0021
 * precedent — SQL cannot mint uuidv7); every client created here carries the
 * app-stamped uuidv7. Both are plain uuids to the column.
 */
export async function ensureSelfClientInTx(
  tx: TenantTx,
  tenantId: string,
  opts?: { readonly selfClientName?: string },
): Promise<string> {
  const identity = and(
    eq(clients.tenantId, tenantId),
    eq(clients.code, SELF_CLIENT_CODE),
    eq(clients.systemOwned, true),
  );
  const existing = await tx.select({ id: clients.id }).from(clients).where(identity).limit(1);
  if (existing[0] !== undefined) {
    return existing[0].id;
  }

  if (opts?.selfClientName === undefined) {
    // Unreachable while registration and migration 0040 hold: every tenant
    // is born with its self client in the same transaction. Fail loudly
    // rather than fabricate one with a wrong name.
    throw new Error(`self client missing for tenant (no name to create it with): ${tenantId}`);
  }
  await tx
    .insert(clients)
    .values({
      id: uuidv7(),
      tenantId,
      code: SELF_CLIENT_CODE,
      name: opts.selfClientName,
      status: 'active',
      systemOwned: true,
    })
    // The (tenant_id, code) unique index is a sufficient arbiter: the ensure
    // always inserts code `self`, so a concurrent winner collides here — and
    // if a NON-system client were coded `self` first, the loser's re-select
    // below still refuses it (systemOwned must match).
    .onConflictDoNothing({ target: [clients.tenantId, clients.code] });

  const created = await tx.select({ id: clients.id }).from(clients).where(identity).limit(1);
  const client = created[0];
  if (client === undefined) {
    // Unreachable short of an RLS/scope bug — fail loudly rather than guess
    // an id.
    throw new Error(`self client missing after ensure: ${tenantId}`);
  }
  return client.id;
}