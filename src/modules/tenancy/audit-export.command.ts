import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, auditExports, idempotencyKeys, type AuditExportRow } from '../../shared/db/schema';
import type { AuditFilters } from '../../shared/db/audit-filter';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import type { AuditReadTargetType } from '../../shared/primitives/audit';
import { uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { IDEMPOTENCY_TENANT_KEY } from './bin.errors';
import { hashCommandPayload } from './idempotency-guard';
import { assertPermission } from './permissions';
import { idempotencyKeyReuse } from './registration.command';
import { getMemberRoleIn } from './tenancy.service';

/**
 * Story 9-3b — the async audit export's vocabularies (IMPLEMENTATION-GUIDE
 * §4's three layers: these tuples, the 0070 CHECKs, the API enums), pinned
 * against the CHECKs by `test/audit-export.spec.ts`.
 */
export const AUDIT_EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type AuditExportStatus = (typeof AUDIT_EXPORT_STATUSES)[number];

/**
 * Why an export failed: `too-many-events` — the filters matched more than
 * the cap (narrow them); `interrupted` — the worker stopped heart-beating
 * three times; `export-error` — anything else (a statement timeout
 * included), logged.
 */
export const AUDIT_EXPORT_FAILURE_REASONS = ['too-many-events', 'interrupted', 'export-error'] as const;
export type AuditExportFailureReason = (typeof AUDIT_EXPORT_FAILURE_REASONS)[number];

/** A finished export (ready or failed) keeps its file and its panel entry this long, then expires. */
export const AUDIT_EXPORT_LIFETIME_DAYS = 7;

/**
 * The outbox events the worker appends (outbox only — never `audit_events`
 * rows: the worker is unkeyed, outside the audit rule). The notifications
 * module repeats these as literals and `test/audit-export.spec.ts` pins them
 * equal.
 */
export const AUDIT_EXPORT_READY_EVENT = 'audit_export.ready';
export const AUDIT_EXPORT_FAILED_EVENT = 'audit_export.failed';
export const AUDIT_EXPORT_EXPIRED_EVENT = 'audit_export.expired';

/** The partial unique index: one active (queued or running) export per requester. */
export const AUDIT_EXPORTS_ACTIVE_UNIQUE = 'audit_exports_active_unique';

/** The stored filters: the validated body, absent keys omitted, instants canonical UTC. */
export type StoredAuditFilters = { -readonly [K in keyof AuditFilters]?: string };

/** One export as the API serves it — also the request's stored 202 snapshot. */
export interface AuditExportSnapshot {
  readonly id: string;
  readonly status: AuditExportStatus;
  readonly filters: StoredAuditFilters;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly expiresAt: string | null;
  readonly rowCount: number | null;
  readonly byteSize: number | null;
  readonly sha256: string | null;
  readonly failureReason: AuditExportFailureReason | null;
}

export interface RequestAuditExportCommand {
  readonly tenantId: string;
  /** The session user — the requester; authority is re-read from the DB. */
  readonly actorUserId: string;
  readonly filters: AuditFilters;
}

/**
 * The filters in their FIXED key order, absent keys omitted, instants
 * canonical UTC — both the stored `filters` and the hash's tail, so a
 * replay's fingerprint never depends on the body's key order or on the
 * instant's zone spelling.
 */
export function canonicalAuditFilters(filters: AuditFilters): StoredAuditFilters {
  const out: StoredAuditFilters = {};
  if (filters.actorUserId !== undefined) out.actorUserId = filters.actorUserId.toLowerCase();
  if (filters.actionPrefix !== undefined) out.actionPrefix = filters.actionPrefix;
  if (filters.targetType !== undefined) out.targetType = filters.targetType;
  if (filters.targetId !== undefined) out.targetId = filters.targetId.toLowerCase();
  if (filters.from !== undefined) out.from = canonicalInstant(filters.from);
  if (filters.to !== undefined) out.to = canonicalInstant(filters.to);
  return out;
}

/** The stored filters back into the shared filter's shape. */
export function auditFiltersOf(stored: StoredAuditFilters): AuditFilters {
  return { ...stored, targetType: stored.targetType as AuditReadTargetType | undefined };
}

export function toAuditExportSnapshot(row: AuditExportRow): AuditExportSnapshot {
  const instant = (value: string | null): string | null => (value === null ? null : canonicalInstant(value));
  return {
    id: row.id,
    status: row.status as AuditExportStatus,
    filters: { ...(row.filters as StoredAuditFilters) },
    requestedAt: canonicalInstant(row.createdAt),
    startedAt: instant(row.startedAt),
    finishedAt: instant(row.finishedAt),
    expiresAt: instant(row.expiresAt),
    rowCount: row.rowCount,
    byteSize: row.byteSize,
    sha256: row.sha256,
    failureReason: row.failureReason as AuditExportFailureReason | null,
  };
}

function exportInProgress(): ProblemException {
  return new ProblemException(
    'export-in-progress',
    409,
    'An export is already running',
    'You already have an audit export queued or running — wait for it to finish, then export again.',
  );
}

/**
 * Story 9-3b — `POST /tenants/{t}/reporting/audit/exports`: the owner queues
 * an export of the audit trail under the given filters. Keyed and audited
 * (`audit_export.requested`); always answers 202 with the export.
 *
 * In ONE transaction, in this order (the spec's, each step load-bearing):
 *  1. `pg_advisory_xact_lock` on (tenant, requester) — a same-key duplicate,
 *     or a second export by the same member, waits here;
 *  2. the replay lookup UNDER the lock — a same-key duplicate parked on the
 *     lock re-serves the winner's 202 snapshot instead of answering 409
 *     `export-in-progress` (the stored snapshot, `queued` included, whatever
 *     the export's status is now); a different body is 422;
 *  3. `audit.view` (owner-only) — 403 `role-denied`, nothing written;
 *  4. one active export per requester — 409 `export-in-progress`;
 *  5. the row (`queued`, `snapshot_at = now()` — equal to `created_at`), the
 *     audit row, the key LAST.
 * The partial unique `audit_exports_active_unique` is the backstop: its
 * 23505 maps to the same 409.
 */
@Injectable()
export class AuditExportCommand {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async request(command: RequestAuditExportCommand, idempotencyKey: string): Promise<AuditExportSnapshot> {
    const filters = canonicalAuditFilters(command.filters);
    // The `arm` discriminator: `idempotency_keys` is unique on (tenant, key)
    // across every route (IMPLEMENTATION-GUIDE §9).
    const payloadHash = hashCommandPayload({
      arm: 'audit-export',
      tenantId: command.tenantId,
      requestedBy: command.actorUserId,
      ...filters,
    });
    try {
      return await withTenantTransaction(this.db, command.tenantId, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`audit-export:${command.tenantId}:${command.actorUserId}`}))`,
        );
        const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replayed !== null) return replayed;

        assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'audit.view');

        const active = await tx
          .select({ id: auditExports.id })
          .from(auditExports)
          .where(
            and(
              eq(auditExports.tenantId, command.tenantId),
              eq(auditExports.requestedBy, command.actorUserId),
              inArray(auditExports.status, ['queued', 'running']),
            ),
          )
          .limit(1);
        if (active.length > 0) throw exportInProgress();

        const [row] = await tx
          .insert(auditExports)
          .values({
            id: uuidv7(),
            tenantId: command.tenantId,
            requestedBy: command.actorUserId,
            filters,
            // The request transaction's now() — the same instant `created_at`
            // defaults to, so the snapshot equals the row's creation.
            snapshotAt: sql`now()`,
            status: 'queued',
          })
          .returning();
        const snapshot = toAuditExportSnapshot(row!);

        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'audit_export.requested',
          targetType: 'audit_export',
          targetId: snapshot.id,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      });
    } catch (err) {
      if (isUniqueViolationOn(err, AUDIT_EXPORTS_ACTIVE_UNIQUE)) throw exportInProgress();
      throw err;
    }
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<AuditExportSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot as AuditExportSnapshot;
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: AuditExportSnapshot,
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({
        id: uuidv7(),
        tenantId,
        key: idempotencyKey,
        payloadHash,
        responseSnapshot: snapshot,
      });
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
}
