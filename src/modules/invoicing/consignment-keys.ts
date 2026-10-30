import { and, eq } from 'drizzle-orm';
import { idempotencyKeys } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { idempotencyKeyReuse } from '../tenancy/registration.command';

/** Story 4-6a — the consignment commands' replay and key writes (the 4.1 shape). */

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

export async function replayKeyInTx(tx: TenantTx, tenantId: string, key: string, payloadHash: string): Promise<unknown> {
  const rows = await tx
    .select({ payloadHash: idempotencyKeys.payloadHash, responseSnapshot: idempotencyKeys.responseSnapshot })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
  return row.responseSnapshot;
}

export async function writeKeyInTx(tx: TenantTx, tenantId: string, key: string, payloadHash: string, snapshot: unknown): Promise<void> {
  try {
    await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key, payloadHash, responseSnapshot: snapshot });
  } catch (err) {
    if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
      throw new ProblemException(
        'conflict',
        409,
        'Concurrent idempotent request',
        'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
      );
    }
    throw err;
  }
}
