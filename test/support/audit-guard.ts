import postgres from 'postgres';

/**
 * Story 9-3a — the DYNAMIC half of the audit rule's guard.
 *
 * The rule (`src/shared/primitives/audit.ts`): every committed, non-replay
 * execution of a command that writes `idempotency_keys` also writes at least
 * one `audit_events` row in the same transaction, carrying `reference` = the
 * idempotency key. So after a suite has driven its commands, every
 * `idempotency_keys` row must have an `audit_events` row with the same
 * `(tenant_id, reference)`.
 *
 * `assertEveryKeyAudited` runs from the shared teardown — `SuiteDatabase.drop()`
 * (`suite-db.ts`) — so every e2e suite checks every key its commands wrote.
 * The static half (a file that writes `idempotencyKeys` must reference
 * `auditEvents`) lives in `test/architecture.spec.ts`.
 */

/**
 * The named endpoints exempt from the rule, each recognised by its stored
 * response snapshot (an `idempotency_keys` row carries no endpoint column).
 * `selfTestEcho` (`enrollment.command.ts`) is the device substrate's replay
 * target: it echoes a payload and changes no state an Owner audits.
 */
export const AUDIT_EXEMPT_ENDPOINTS: Readonly<Record<string, (snapshot: unknown) => boolean>> = {
  selfTestEcho: (snapshot) =>
    isRecord(snapshot) &&
    sameKeys(snapshot, ['deviceId', 'echoed', 'operatorUserId', 'receivedAt']),
};

/**
 * Keys a suite inserted into `idempotency_keys` BY HAND (a legacy fingerprint,
 * a foreign tenant's row, a held race probe) — not a command execution, so
 * outside the rule. A suite that seeds a row registers its key here first.
 */
const seededKeys = new Set<string>();

export function seededIdempotencyKey(key: string): string {
  seededKeys.add(key);
  return key;
}

/**
 * The named NO-OP arms: a command arm that commits and stores its key but
 * changes no state, so it writes no audit row by design (the audit trail is
 * every STATE-CHANGING action — FR-28). Its stored snapshot is the same shape
 * as a real execution's, so it cannot be recognised from the row: the suite
 * that drives one declares its key here, naming the arm.
 */
export const AUDIT_NO_OP_ARMS = {
  /** `ClientsCommand.updateStatus` on a client already in that status (21-10: "no write, no audit — the key IS stored"). */
  'clients.updateStatus:same-status': true,
  /** `OrderCommandService.createOrder`'s channel dedup arm: a redelivered payload answers the first order's snapshot. */
  'orders.createOrder:channel-redelivery': true,
} as const;

export type AuditNoOpArm = keyof typeof AUDIT_NO_OP_ARMS;

const noOpKeys = new Set<string>();

export function noOpIdempotencyKey(key: string, arm: AuditNoOpArm): string {
  void arm; // the arm names the exemption at the call site; the closed list is the vocabulary
  noOpKeys.add(key);
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, i) => key === keys[i]);
}

export interface UnauditedKey {
  readonly tenantId: string;
  readonly key: string;
  readonly snapshotKeys: string;
}

/** The `idempotency_keys` rows with no audit row under the same `(tenant_id, reference)`, exemptions removed. */
export async function unauditedKeys(databaseUrl: string): Promise<UnauditedKey[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql<{ tenant_id: string; key: string; response_snapshot: unknown }[]>`
      select k.tenant_id, k.key, k.response_snapshot
      from idempotency_keys k
      where not exists (
        select 1 from audit_events a
        where a.tenant_id = k.tenant_id
          -- The row names the key: its reference IS the key, or — for the
          -- composite references that predate 9-3a (a client-invoice note,
          -- a SKU client correction's before/after, an ingested order's
          -- channel source) — carries it inside (a 26-char ULID; no false
          -- match is plausible).
          and (a.reference = k.key or strpos(a.reference, k.key) > 0)
      )
      order by k.created_at, k.id`;
    return rows
      .filter((row) => !seededKeys.has(row.key) && !noOpKeys.has(row.key))
      .filter((row) => !Object.values(AUDIT_EXEMPT_ENDPOINTS).some((isExempt) => isExempt(row.response_snapshot)))
      .map((row) => ({
        tenantId: row.tenant_id,
        key: row.key,
        snapshotKeys: isRecord(row.response_snapshot) ? Object.keys(row.response_snapshot).sort().join(',') : typeof row.response_snapshot,
      }));
  } finally {
    await sql.end();
  }
}

/** Fails naming every idempotency key that committed without its audit row. */
export async function assertEveryKeyAudited(databaseUrl: string): Promise<void> {
  const missing = await unauditedKeys(databaseUrl);
  if (missing.length > 0) {
    throw new Error(
      `assertEveryKeyAudited: ${missing.length} idempotency key(s) committed with no audit_events row ` +
        `(tenant_id, reference) — every keyed command writes its audit row at skeleton step 10 ` +
        `(story 9-3a):\n` +
        missing.map((row) => `  key ${row.key} (tenant ${row.tenantId}; snapshot {${row.snapshotKeys}})`).join('\n'),
    );
  }
}

export interface ExpectedAuditRow {
  readonly tenantId: string;
  /** The idempotency key the command ran under — the row's `reference`. */
  readonly key: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly actorUserId: string;
}

/**
 * Story 9-3a — the per-command pin of `AUDIT_NEW_ACTIONS`: exactly ONE audit
 * row under the key, with the action, the target and the actor, and an
 * `occurred_at` that is server time (within a minute of `created_at`). Call it
 * after the command, and again after replaying the same key: a replay writes
 * nothing, so the count stays one.
 */
export async function expectAuditRow(expected: ExpectedAuditRow): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql<
      { action: string; target_type: string; target_id: string; actor_user_id: string; drift_ms: number }[]
    >`
      select action, target_type, target_id, actor_user_id,
             abs(extract(epoch from (occurred_at - created_at)) * 1000)::float8 as drift_ms
      from audit_events
      where tenant_id = ${expected.tenantId} and reference = ${expected.key}`;
    expect(
      rows.map((row) => ({
        action: row.action,
        target_type: row.target_type,
        target_id: row.target_id,
        actor_user_id: row.actor_user_id,
      })),
    ).toEqual([
      {
        action: expected.action,
        target_type: expected.targetType,
        target_id: expected.targetId,
        actor_user_id: expected.actorUserId,
      },
    ]);
    expect(rows[0]!.drift_ms).toBeLessThan(60_000);
  } finally {
    await sql.end();
  }
}
