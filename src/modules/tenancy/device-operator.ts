import { and, eq } from 'drizzle-orm';
import { devices, users } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { deviceRevoked } from './enrollment.command';
import { isFloorRole } from './permissions';

/**
 * The floor op's device and role guard (story 3.3's `grn.submit` guard,
 * exported by story 13-2 so a module that owns no device or user table — the
 * returns module's `return.receive` — runs the SAME re-authorization without
 * reading either table itself). Tenancy owns `devices` and `users`; callers
 * reach them only through here.
 *
 * Fail-closed, in the caller's transaction, BEFORE the replay lookup (the
 * token is transport, never authority — AD-10):
 * - the device row is LOCKED and must be `active` and badge-bound (a PIN set)
 *   → else 403 `device-revoked`;
 * - the operator's CURRENT role is re-read and must be a floor role (an
 *   allow-list — `isFloorRole`) → else 403 `role-denied`.
 */
export async function assertDeviceOperatorInTx(
  tx: TenantTx,
  tenantId: string,
  deviceId: string,
  operatorUserId: string,
): Promise<void> {
  const deviceRows = await tx
    .select({ status: devices.status, pinHash: devices.pinHash })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.tenantId, tenantId)))
    .for('update')
    .limit(1);
  const device = deviceRows[0];
  if (!device || device.status !== 'active' || device.pinHash === null) {
    throw deviceRevoked();
  }

  // Role re-read from the DB per command — floor devices are operator
  // surfaces; a demoted-to-accountant operator is denied per command.
  const roleRows = await tx
    .select({ role: users.role })
    .from(users)
    .where(and(eq(users.id, operatorUserId), eq(users.tenantId, tenantId)))
    .limit(1);
  const role = roleRows[0]?.role;
  if (!isFloorRole(role)) {
    throw new ProblemException(
      'role-denied',
      403,
      'Role lacks the required capability',
      `Role "${role ?? 'none'}" cannot operate a floor device.`,
    );
  }
}

/** The device heartbeat a committed floor op stamps (the `grn.submit` tail). */
export async function touchDeviceInTx(tx: TenantTx, deviceId: string): Promise<void> {
  await tx.update(devices).set({ lastSeenAt: nowIso(), updatedAt: nowIso() }).where(eq(devices.id, deviceId));
}
