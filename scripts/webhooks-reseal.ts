/**
 * Story 5-2a (A17) — re-seal every webhook signing secret under the current
 * WEBHOOK_SEAL_KEY, so WEBHOOK_SEAL_KEY_PREVIOUS can be retired:
 *   WEBHOOK_SEAL_KEY=<new> WEBHOOK_SEAL_KEY_PREVIOUS=<old> bun run webhooks:reseal
 * Tenants are discovered on the BYPASSRLS auth connection (`DATABASE_AUTH_URL`,
 * falling back to `DATABASE_URL`); every write runs in the tenant's own
 * transaction on `DATABASE_URL`. Idempotent: re-running changes nothing. An
 * endpoint whose secret opens under neither key is listed — rotate it in
 * Settings → Clients → Webhooks. Exits 1 when any is listed. Runbook:
 * docs/design/DEPLOY.md.
 */
import { sql } from 'drizzle-orm';
import { createDatabase, requiredDbUrl } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { assertWebhookSealKeyConfigured } from '../src/modules/client-webhooks/webhook-secrets';
import { resealTenantSecretsInTx } from '../src/modules/client-webhooks/webhook-reseal';

assertWebhookSealKeyConfigured();
const db = createDatabase();
const authDb = createDatabase(process.env.DATABASE_AUTH_URL || requiredDbUrl(), 'auth');
const tenants = (await authDb.execute(sql`select distinct tenant_id as "tenantId" from webhook_endpoints order by 1`)) as unknown as { tenantId: string }[];
let resealed = 0;
let unchanged = 0;
const unopenable: string[] = [];
for (const { tenantId } of tenants) {
  const result = await withTenantTransaction(db, tenantId, (tx) => resealTenantSecretsInTx(tx, tenantId));
  resealed += result.resealed;
  unchanged += result.unchanged;
  unopenable.push(...result.unopenable.map((id) => `${tenantId}/${id}`));
}
process.stdout.write(`webhooks:reseal — ${tenants.length} tenant(s): ${resealed} endpoint(s) re-sealed, ${unchanged} already current\n`);
if (unopenable.length > 0) {
  process.stderr.write(`webhooks:reseal — ${unopenable.length} endpoint(s) open under neither key; rotate them: ${unopenable.join(', ')}\n`);
  process.exit(1);
}
process.exit(0);
