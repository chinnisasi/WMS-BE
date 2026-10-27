import { and, eq, ne } from 'drizzle-orm';
import { webhookEndpoints } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { resealSigningSecret } from './webhook-secrets';

/**
 * Story 5-2a (A17) — the `bun run webhooks:reseal` body for one tenant:
 * every live endpoint's current (and previous) secret is re-sealed under the
 * CURRENT `WEBHOOK_SEAL_KEY`, opening it with the current or the previous
 * key, so `WEBHOOK_SEAL_KEY_PREVIOUS` can be retired. A blob already under
 * the current key is left alone; one that opens under neither key is
 * reported (that endpoint must be rotated). Idempotent.
 */
export async function resealTenantSecretsInTx(
  tx: TenantTx,
  tenantId: string,
): Promise<{ resealed: number; unchanged: number; unopenable: string[] }> {
  const rows = await tx
    .select({
      id: webhookEndpoints.id,
      secretSealed: webhookEndpoints.secretSealed,
      previousSecretSealed: webhookEndpoints.previousSecretSealed,
    })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.tenantId, tenantId), ne(webhookEndpoints.status, 'deleted')))
    .for('update');
  let resealed = 0;
  let unchanged = 0;
  const unopenable: string[] = [];
  for (const row of rows) {
    // Code review C15 — the current and the previous secret independently: a
    // previous blob that opens under neither key is DROPPED (it only ever
    // signed beside the current one for an overlap), never a reason to leave
    // the current secret under the old key.
    let current: string | null;
    try {
      current = resealSigningSecret(row.secretSealed, tenantId, row.id);
    } catch {
      unopenable.push(row.id);
      continue;
    }
    let previous: string | null | 'drop' = null;
    if (row.previousSecretSealed !== null) {
      try {
        previous = resealSigningSecret(row.previousSecretSealed, tenantId, row.id);
      } catch {
        previous = 'drop';
      }
    }
    if (current === null && previous === null) {
      unchanged += 1;
      continue;
    }
    await tx
      .update(webhookEndpoints)
      .set({
        ...(current === null ? {} : { secretSealed: current }),
        ...(previous === 'drop' ? { previousSecretSealed: null, previousSecretExpiresAt: null } : previous === null ? {} : { previousSecretSealed: previous }),
      })
      .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.id, row.id)));
    resealed += 1;
  }
  return { resealed, unchanged, unopenable };
}
