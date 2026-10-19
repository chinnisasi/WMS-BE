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
 * outside the rule. A suite that seeds a row registers `(tenant, key)` first.
 */
const seededKeys = new Set<string>();

const exemptionId = (tenantId: string, key: string): string => `${tenantId}:${key}`;

export function seededIdempotencyKey(tenantId: string, key: string): string {
  seededKeys.add(exemptionId(tenantId, key));
  return key;
}

/** One stored snapshot's `{ <entity>: { status } }` shape (the no-op arms' answers). */
function entitySnapshot(snapshot: unknown, entity: string, status?: string): boolean {
  if (!isRecord(snapshot) || !sameKeys(snapshot, [entity])) return false;
  const inner = snapshot[entity];
  return isRecord(inner) && (status === undefined || inner.status === status);
}

/**
 * The named NO-OP arms: a command arm that commits and stores its key but
 * changes no state, so it writes no audit row by design (the audit trail is
 * every STATE-CHANGING action — FR-28). Its stored snapshot is the same shape
 * as a real execution's, so it cannot be recognised from the row alone: the
 * suite that drives one declares `(tenant, key)` naming the arm, and the
 * teardown checks the stored snapshot really has that arm's shape (a
 * declaration over a key some other command wrote fails).
 */
export const AUDIT_NO_OP_ARMS = {
  /** `ClientsCommand.updateStatus` on a client already in that status (21-10: "no write, no audit — the key IS stored"). */
  'clients.updateStatus:same-status': (snapshot: unknown) => entitySnapshot(snapshot, 'client'),
  /** `OrderCommandService.createOrder`'s channel dedup arm: a redelivered payload answers the first order's snapshot. */
  'orders.createOrder:channel-redelivery': (snapshot: unknown) => entitySnapshot(snapshot, 'order'),
  /** `OrderCommandService.resolveDedupLoser`: a concurrent duplicate delivery answers the winner's order. */
  'orders.createOrder:dedup-loser': (snapshot: unknown) => entitySnapshot(snapshot, 'order'),
  /** `OrderCommandService.cancelOrder` on an already-cancelled order — and the racing loser whose flip found it cancelled. */
  'orders.cancelOrder:already-cancelled': (snapshot: unknown) => entitySnapshot(snapshot, 'order', 'cancelled'),
  /** `WaveCommandService.release` of an already-released wave under a new key (and the racing loser). */
  'waves.release:already-released': (snapshot: unknown) => entitySnapshot(snapshot, 'wave', 'released'),
  /** `WaveCommandService.cancel` of an already-cancelled wave under a new key (and the racing loser). */
  'waves.cancel:already-cancelled': (snapshot: unknown) => entitySnapshot(snapshot, 'wave', 'cancelled'),
  /** `EnrollmentCommand.revoke` on an already-revoked device ("no second audit row"). */
  'devices.revoke:already-revoked': (snapshot: unknown) => entitySnapshot(snapshot, 'device', 'revoked'),
  /** Story 6-1a — `UsersCommand.setUserStatus` deactivate on an already-deactivated user ("writes nothing but stores the key"). */
  'users.deactivate:already-deactivated': (snapshot: unknown) => entitySnapshot(snapshot, 'user', 'deactivated'),
  /** Story 6-1a — `UsersCommand.setUserStatus` reactivate on a user who is not deactivated. */
  'users.reactivate:not-deactivated': (snapshot: unknown) => entitySnapshot(snapshot, 'user'),
  /** Story 1-2a — `ClientsCommand.editContact` with nothing changed ("a declared no-op that stores the key"). */
  'clients.contactEdit:unchanged': (snapshot: unknown) => entitySnapshot(snapshot, 'contact'),
  /** Story 1-2a — `ClientsCommand.updateAddresses` with nothing changed (stores the key). */
  'clients.addresses:unchanged': (snapshot: unknown) => entitySnapshot(snapshot, 'client'),
  /** Story 1-2b — `ClientsCommand.updateReceivingPolicy` with nothing changed (stores the key). */
  'clients.receivingPolicy:unchanged': (snapshot: unknown) => entitySnapshot(snapshot, 'client'),
  /** Story 1-3 — `PartnersCommand.update` with nothing changed (stores the key). */
  'partners.update:unchanged': (snapshot: unknown) => entitySnapshot(snapshot, 'partner'),
  /** Story 1-3 — `PartnersCommand.updateStatus` to the status (and reason) already in place (stores the key). */
  'partners.status:unchanged': (snapshot: unknown) => entitySnapshot(snapshot, 'partner'),
  /** Story 1-3 — `PartnersCommand.updateLink` with nothing changed (stores the key). */
  'partners.linkUpdate:unchanged': (snapshot: unknown) => entitySnapshot(snapshot, 'partner'),
  /** Story 6-1b — `SecondFactorCommand.reset` of a user with no two-factor sign-in and no enrolment code. */
  'users.resetSecondFactor:not-enrolled': (snapshot: unknown) =>
    isRecord(snapshot) &&
    sameKeys(snapshot, ['enrolmentCode', 'enrolmentCodeExpiresAt']) &&
    snapshot.enrolmentCode === null &&
    snapshot.enrolmentCodeExpiresAt === null,
} as const satisfies Readonly<Record<string, (snapshot: unknown) => boolean>>;

export type AuditNoOpArm = keyof typeof AUDIT_NO_OP_ARMS;

const noOpKeys = new Map<string, AuditNoOpArm>();

export function noOpIdempotencyKey(tenantId: string, key: string, arm: AuditNoOpArm): string {
  noOpKeys.set(exemptionId(tenantId, key), arm);
  return key;
}

/**
 * A channel ingest mints its idempotency key INSIDE the command (RD-9), so a
 * webhook test cannot pass one in. After a delivery the test KNOWS answered
 * from an existing order (a redelivery, or a dedup loser), it declares the
 * order's unaudited keys as that arm — the shape check still applies.
 * Returns how many NEW keys it declared (a test asserts the count it expects).
 */
export async function declareChannelNoOps(tenantId: string, orderId: string, arm: AuditNoOpArm): Promise<number> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql<{ key: string }[]>`
      select k.key from idempotency_keys k
      where k.tenant_id = ${tenantId} and k.response_snapshot -> 'order' ->> 'id' = ${orderId}
        and not exists (
          select 1 from audit_events a
          where a.tenant_id = k.tenant_id
            and (a.reference = k.key or (a.action = any(${[...COMPOSITE_REFERENCE_ACTIONS]}) and strpos(a.reference, k.key) > 0))
        )`;
    const fresh = rows.filter((row) => !noOpKeys.has(exemptionId(tenantId, row.key)));
    for (const row of fresh) noOpIdempotencyKey(tenantId, row.key, arm);
    return fresh.length;
  } finally {
    await sql.end();
  }
}

/**
 * The actions whose `reference` predates 9-3a as a COMPOSITE that carries the
 * key inside (the only rows matched by containment; every other row's
 * reference must EQUAL the key):
 *  - `sku.client-corrected` — `from <a> → to <b> (key K)` (21-2b);
 *  - `order.created` — an ingested order's `{"channel":{…},"key":"K"}` (RD-2);
 *  - the client-invoice transitions with a note — `note: … (key K)` (21-5,
 *    `ClientInvoiceCommand.transition`: dispute and void always, settle when noted).
 */
export const COMPOSITE_REFERENCE_ACTIONS = [
  'sku.client-corrected',
  'order.created',
  'client_invoice.disputed',
  'client_invoice.settled',
  'client_invoice.voided',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The snapshot's top-level keys — plus the entity's status when it carries one (`order status=cancelled`), to name the arm. */
function describeSnapshot(snapshot: unknown): string {
  if (!isRecord(snapshot)) return typeof snapshot;
  const keys = Object.keys(snapshot).sort();
  const only = keys.length === 1 ? snapshot[keys[0]!] : undefined;
  return isRecord(only) && typeof only.status === 'string' ? `${keys[0]} status=${only.status}` : keys.join(',');
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
          -- The row names the key: its reference EQUALS the key — or, for the
          -- named composite references only, carries it inside.
          and (
            a.reference = k.key
            or (a.action = any(${[...COMPOSITE_REFERENCE_ACTIONS]}) and strpos(a.reference, k.key) > 0)
          )
      )
      order by k.created_at, k.id`;
    const missing: UnauditedKey[] = [];
    for (const row of rows) {
      const id = exemptionId(row.tenant_id, row.key);
      if (seededKeys.has(id)) continue;
      if (Object.values(AUDIT_EXEMPT_ENDPOINTS).some((isExempt) => isExempt(row.response_snapshot))) continue;
      const arm = noOpKeys.get(id);
      const shape = describeSnapshot(row.response_snapshot);
      if (arm !== undefined) {
        if (AUDIT_NO_OP_ARMS[arm](row.response_snapshot)) continue;
        missing.push({ tenantId: row.tenant_id, key: row.key, snapshotKeys: `${shape} — declared ${arm}, which does not store this shape` });
        continue;
      }
      missing.push({ tenantId: row.tenant_id, key: row.key, snapshotKeys: shape });
    }
    return missing;
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
  /**
   * Story 1-2b — the OTHER rows the same command writes under the key (a
   * receipt placed on QC holds writes `goods_receipt.submitted` AND
   * `qc_hold.receipt_placed`): the key's rows must be exactly the expected
   * row plus these, each once. Absent = the expected row alone (9-3a).
   */
  readonly alongside?: readonly {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly actorUserId: string;
  }[];
}

/**
 * Story 9-3a — the per-command pin of `AUDIT_NEW_ACTIONS`: exactly ONE audit
 * row under the key, with the action, the target and the actor, and an
 * `occurred_at` that is server time (within a minute of `created_at`). Call it
 * after the command, and again after replaying the same key: a replay writes
 * nothing, so the count stays one. Story 1-2b: `alongside` names the other
 * rows one command writes under the same key.
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
    const byAction = (a: { action: string }, b: { action: string }): number => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0);
    expect(
      rows
        .map((row) => ({
          action: row.action,
          target_type: row.target_type,
          target_id: row.target_id,
          actor_user_id: row.actor_user_id,
        }))
        .sort(byAction),
    ).toEqual(
      [expected, ...(expected.alongside ?? [])]
        .map((row) => ({
          action: row.action,
          target_type: row.targetType,
          target_id: row.targetId,
          actor_user_id: row.actorUserId,
        }))
        .sort(byAction),
    );
    for (const row of rows) {
      expect(row.drift_ms).toBeLessThan(60_000);
    }
  } finally {
    await sql.end();
  }
}
