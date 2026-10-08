import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  bins,
  devices,
  idempotencyKeys,
  rejectedOps,
  users,
  REJECTED_OP_STATUSES,
} from '../../shared/db/schema';
import type {
  RejectedOp,
  RejectedOpClassification,
  RejectedOpStatus,
} from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { assertUtcIso, canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import type { Page } from '../../shared/primitives/pagination';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { hashCommandPayload } from './idempotency-guard';
import { idempotencyKeyReuse } from './registration.command';
import { assertPermission } from './permissions';
import { deviceRevoked } from './enrollment.command';
import { assertWarehouseInTenant, getMemberRoleIn } from './tenancy.service';
// Story 5-6 — the cross-module re-execution seams (the owning commands, never
// their tables): the seven op types' own guarded commands, reached through
// their facades (the movements seam is `transfer.facade` — the aggregate's
// published module file).
import { ReceivingFacade } from '../inbound/receiving.facade';
import { PutawayFacade } from '../putaway/putaway.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import { ExcursionFacade } from '../compliance/excursion.facade';
import { MovementsFacade } from '../movements/transfer.facade';
import { InventoryFacade } from '../inventory/inventory.facade';

/**
 * Rejected sync-report ops (story 5-6). Module ownership is **tenancy
 * deliberately** (the spec's Design Notes): the resource is a report of a
 * device sync outcome, op-type-generic across receive/pick/putaway/pack/
 * count/transfer — no other module owns it, and tenancy owns the device
 * contract the upload rides. Cross-module re-execution goes through the
 * owning command services (the facades below) — the apply arm is NEVER a
 * force-write: it re-executes the stored payload through the op's own
 * command, `binStateEpoch` stripped (the human judgment replaces that
 * observation; it is "a timestamped observation, not a decision") and every
 * other guard live (stock, holds, premises, role, kit rule), under the op's
 * attributed operator, whose current role and device status each command
 * re-reads from the DB at apply time.
 *
 * Three commands:
 * - **recordSyncReport** (device session, badge-in required) — the replay
 *   pass's durable upload. Per-row dedupe on `(tenant_id, op_id)` makes the
 *   at-least-once upload safe: a re-posted row updates nothing, a replay
 *   report is a no-op. `self-test.echo` ops are never reviewable and are
 *   refused here too (the client never puts them in a report).
 * - **listRejectedOps** (any tenant member — a read, never capability-gated)
 *   — the Conflicts & Reviews keyset list, newest first, status-filtered.
 * - **resolveRejectedOp** (`review.decide` — owner + Ops Manager, the
 *   existing capability, no new one) — the three arms, one row per call.
 */
export const MAX_SYNC_REPORT_ROWS = 200;
export const DEFAULT_REJECTED_OPS_PAGE_SIZE = 50;
export const MAX_REJECTED_OPS_PAGE_SIZE = 200;

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * The mobile `OpType` mirror — the reviewable fates only. Deliberately no
 * `self-test.echo`: device diagnostics are not reviewable, and the client
 * never uploads them.
 */
export type RejectedOpType =
  | 'grn.submit'
  | 'putaway.place'
  | 'pick.record'
  | 'pack.execute'
  | 'excursion.record'
  | 'transfer.confirm'
  | 'count.submit';

export const REJECTED_OP_TYPES: readonly RejectedOpType[] = [
  'grn.submit',
  'putaway.place',
  'pick.record',
  'pack.execute',
  'excursion.record',
  'transfer.confirm',
  'count.submit',
];

/**
 * The resolve arms (the spec's human-judgment vocabulary — the DB statuses
 * carry the arm's RESULT: `applied` / `recounted` / `discarded`).
 */
export const REJECTED_OP_DECISIONS = ['apply', 'recount', 'discard'] as const;
export type RejectedOpDecision = (typeof REJECTED_OP_DECISIONS)[number];

/** The client-minted op id's ULID shape (the idempotency-key alphabet). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The upload's per-row body budget — a pack payload is the largest the
 * floor sends; whole-order scans stay well under this. */
const MAX_REPORT_ROW_JSON_CHARS = 32 * 1024;

export interface SyncReportRowInput {
  readonly opId: string;
  readonly opType: RejectedOpType;
  readonly classification: RejectedOpClassification;
  readonly problemCode: string;
  readonly problemDetail?: string | null | undefined;
  readonly payload: Record<string, unknown>;
  /** The op's OWN session as the device sealed it (device label, operator). */
  readonly attribution?: { deviceLabel?: string; operatorEmail?: string } | null | undefined;
  readonly opEnqueuedAt: string;
  readonly opOccurredAt?: string | null | undefined;
}

export interface RecordSyncReportCommand {
  readonly tenantId: string;
  /** The badge-in session's device id (server-verified per command). */
  readonly deviceId: string;
  readonly operatorUserId: string;
  readonly rows: readonly SyncReportRowInput[];
}

/** The API response body's per-row ack (the at-least-once client's map). */
export interface SyncReportRowAck {
  readonly opId: string;
  readonly recorded: boolean;
}

/** The API response body (and the idempotent replay's stored copy), upload. */
export interface SyncReportSnapshot {
  readonly received: number;
  readonly recorded: number;
  readonly duplicates: number;
  readonly rows: readonly SyncReportRowAck[];
}

export interface ListRejectedOpsQuery {
  readonly status?: RejectedOpStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** One row of the review-queue read (and the resolve response's core). */
export interface RejectedOpEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly operatorUserId: string;
  readonly opId: string;
  readonly opType: RejectedOpType;
  readonly classification: RejectedOpClassification;
  readonly problemCode: string;
  readonly problemDetail: string | null;
  readonly payload: Record<string, unknown>;
  /** Device name + operator id/email + the op's own session, as stamped. */
  readonly attribution: Record<string, unknown>;
  readonly opEnqueuedAt: string;
  readonly opOccurredAt: string | null;
  /** The DB CHECK's vocabulary — the mirrored tuple, not a bare string. */
  readonly status: RejectedOpStatus;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  /** The arm's outcome jsonb (the applied snapshot / minted task id / null). */
  readonly resolvedOutcome: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The resolve command (story 5-6, `review.decide`): the per-row decision. */
export interface ResolveRejectedOpCommand {
  readonly tenantId: string;
  /** The resolver's session user — authority is re-read from the DB at entry. */
  readonly actorUserId: string;
  readonly rejectedOpId: string;
  /** The arm: re-execute, re-plan the bin via the count core, or discard. */
  readonly decision: RejectedOpDecision;
  readonly occurredAt?: string | undefined;
}

export interface ResolveRejectedOpSnapshot {
  readonly rejectedOp: RejectedOpEntry;
  /**
   * The arm's outcome: the re-executed command's own snapshot (`applied`),
   * the minted count task id (`recounted`), the audit-only marker
   * (`discard`); `null` on the discard arm when the caller sent none (the
   * row's own `resolvedOutcome` column is the persisted form of this object,
   * always carrying its `kind`).
   */
  readonly outcome: Record<string, unknown> | null;
}

/** The op payload's top-level shape: the fields the re-execution rebuilds. */
const PAYLOAD_FIELDS: Record<RejectedOpType, readonly (readonly [string, string])[]> = {
  'grn.submit': [
    ['warehouseId', 'uuid'],
    ['poId', 'uuid-or-null'],
    // Story 21-6 — absent on every pre-21-6 payload (uuid-or-null admits it).
    ['asnId', 'uuid-or-null'],
    ['blindReasonCode', 'string-or-null'],
    ['lines', 'array'],
  ],
  'putaway.place': [
    ['warehouseId', 'uuid'],
    ['grnId', 'uuid'],
    ['grnLineId', 'uuid'],
    ['skuId', 'uuid'],
    ['batchId', 'uuid-or-null'],
    ['qty', 'number'],
    ['toBinId', 'uuid'],
    ['reasonCode', 'string-or-null'],
  ],
  'pick.record': [
    ['warehouseId', 'uuid'],
    ['picklistId', 'uuid'],
    ['picklistLineId', 'uuid'],
    ['skuId', 'uuid'],
    ['binId', 'uuid'],
    ['qty', 'number'],
  ],
  'pack.execute': [
    ['orderId', 'uuid'],
    ['scanned', 'array'],
  ],
  'excursion.record': [
    ['warehouseId', 'uuid'],
    ['binId', 'uuid'],
    ['readingC', 'number'],
    ['note', 'string-or-null'],
  ],
  'transfer.confirm': [
    ['transferId', 'uuid'],
    ['destBinId', 'uuid'],
  ],
  'count.submit': [
    ['taskId', 'uuid'],
    ['lines', 'array'],
  ],
};

const REJECTED_OP_DECISION_SET: ReadonlySet<string> = new Set<string>(REJECTED_OP_DECISIONS);
const REJECTED_OP_STATUS_SET: ReadonlySet<string> = new Set<string>(REJECTED_OP_STATUSES);

/**
 * A stored instant (the payload's own `occurredAt`, or the row's
 * device-sealed stamp) normalized to the Z-suffixed form the commands'
 * asserts demand, then re-asserted through the repo's strict UTC-ISO
 * contract. An unparseable stored instant is an honest 400 naming the op —
 * never a raw throw inside the apply arm.
 */
function normalizeStoredInstant(value: string, opId: string, naming: string): string {
  let normalized: string | null;
  try {
    normalized = canonicalInstant(value);
  } catch {
    normalized = null;
  }
  if (normalized !== null) {
    try {
      return assertUtcIso(normalized);
    } catch {
      // Fall through to the honest 400 (Date parse vs component round-trip).
    }
  }
  throw new ProblemException(
    'validation-failed',
    400,
    'The stored op time is not a valid instant',
    `The stored op time of op ${opId} (${naming}) does not parse as an ISO-8601 instant (got "${value.slice(0, 64)}").`,
  );
}

function invalidRow(opIndex: number, opId: string, why: string): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    'Malformed sync-report row',
    `Sync-report row ${opIndex} (op ${opId}): ${why}.`,
  );
}

/**
 * One reviewable row of the queue, straight off the DB row — no join: the
 * upload stamped the reporting device label and operator email into the
 * `attribution` jsonb, so the card renders self-contained.
 */
export function rejectedOpEntry(row: RejectedOp): RejectedOpEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    deviceId: row.deviceId,
    operatorUserId: row.operatorUserId,
    opId: row.opId,
    // The DB CHECK's vocabularies — the mirrored tuples.
    opType: row.opType as RejectedOpType,
    classification: row.classification as RejectedOpClassification,
    problemCode: row.problemCode,
    problemDetail: row.problemDetail,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attribution: (row.attribution ?? {}) as Record<string, unknown>,
    opEnqueuedAt: row.opEnqueuedAt,
    opOccurredAt: row.opOccurredAt,
    status: row.status as RejectedOpStatus,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    resolvedOutcome: (row.resolvedOutcome ?? null) as Record<string, unknown> | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The uploaded row's shape, asserted per row BEFORE any read (the matrix's
 * "malformed row → 400 naming the row"): the identity fields, the refusal
 * verbatim, the payload object's top-level shape, and the op's own
 * attribution. `self-test.echo` never passes — it is not a member of
 * `REJECTED_OP_TYPES`.
 */
function assertSyncReportRowShape(row: unknown, index: number): void {
  const source = row as SyncReportRowInput;
  const opId = source.opId;
  if (typeof opId !== 'string' || !ULID_RE.test(opId)) {
    throw invalidRow(index, String(opId), "opId must be the op's 26-character ULID.");
  }
  const opType = source.opType;
  if (!REJECTED_OP_TYPES.includes(opType as RejectedOpType)) {
    throw invalidRow(
      index,
      opId,
      `opType "${String(opType)}" is not a reviewable op type (${REJECTED_OP_TYPES.join(', ')}) — self-test.echo ops are device diagnostics, never uploaded.`,
    );
  }
  const classification = source.classification;
  if (classification !== 'rejected' && classification !== 'quarantined') {
    throw invalidRow(
      index,
      opId,
      'classification must be "rejected" or "quarantined" (the replay fate the server refused with).',
    );
  }
  const problemCode = source.problemCode;
  if (typeof problemCode !== 'string' || problemCode.length < 1 || problemCode.length > 200) {
    throw invalidRow(index, opId, 'problemCode must be a 1-200 character string.');
  }
  const problemDetail = source.problemDetail;
  if (
    problemDetail !== null &&
    problemDetail !== undefined &&
    (typeof problemDetail !== 'string' || problemDetail.length > 2000)
  ) {
    throw invalidRow(
      index,
      opId,
      'problemDetail must be null or a string of at most 2000 characters.',
    );
  }
  const payload = source.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw invalidRow(index, opId, "payload must be the op's payload object.");
  }
  if (JSON.stringify(payload).length > MAX_REPORT_ROW_JSON_CHARS) {
    throw invalidRow(
      index,
      opId,
      `payload serializes past ${MAX_REPORT_ROW_JSON_CHARS} characters — split the op or report the command that produced it.`,
    );
  }
  const attribution = source.attribution;
  if (attribution !== null && attribution !== undefined) {
    if (typeof attribution !== 'object' || Array.isArray(attribution)) {
      throw invalidRow(index, opId, 'attribution must be null or an object.');
    }
    for (const [key, kind] of Object.entries(attribution) as [string, unknown][]) {
      if (key !== 'deviceLabel' && key !== 'operatorEmail') {
        throw invalidRow(
          index,
          opId,
          `attribution carries "${key}" — only deviceLabel and operatorEmail are accepted.`,
        );
      }
      if (typeof kind !== 'string' || kind.length > 200) {
        throw invalidRow(
          index,
          opId,
          `attribution.${key} must be a string of at most 200 characters.`,
        );
      }
    }
  }
  // The row's instants ride the repo's ONE strict UTC-ISO contract
  // (`assertUtcIso` — the lax `Date.parse` accepts "January 15, 2026", which
  // then fails the timestamptz cast at insert as a 500 instead of the
  // documented row-naming 400; the repo's contract is the guard).
  const opEnqueuedAt = source.opEnqueuedAt;
  if (typeof opEnqueuedAt !== 'string') {
    throw invalidRow(index, opId, 'opEnqueuedAt must be a Z-suffixed ISO-8601 UTC instant.');
  }
  try {
    assertUtcIso(opEnqueuedAt);
  } catch {
    throw invalidRow(
      index,
      opId,
      `opEnqueuedAt must be a Z-suffixed ISO-8601 UTC instant (got "${String(opEnqueuedAt).slice(0, 64)}").`,
    );
  }
  const opOccurredAt = source.opOccurredAt;
  if (opOccurredAt !== null && opOccurredAt !== undefined) {
    if (typeof opOccurredAt !== 'string') {
      throw invalidRow(index, opId, 'opOccurredAt must be null or a Z-suffixed ISO-8601 UTC instant.');
    }
    try {
      assertUtcIso(opOccurredAt);
    } catch {
      throw invalidRow(
        index,
        opId,
        `opOccurredAt must be null or a Z-suffixed ISO-8601 UTC instant (got "${String(opOccurredAt).slice(0, 64)}").`,
      );
    }
  }
  assertOpPayloadShape(opType as RejectedOpType, payload as Record<string, unknown>, (field, kind) =>
    invalidRow(index, opId, `payload.${field} must be ${kind}.`),
  );
}

/**
 * The apply arm's payload probe: the top-level fields the re-execution
 * rebuilds exist with the right primitive shapes. The underlying commands
 * re-assert every invariant they own in their own transactions — this probe
 * only keeps a malformed stored payload from 500ing inside a facade call.
 */
function assertOpPayloadShape(
  opType: RejectedOpType,
  payload: Record<string, unknown>,
  refuse: (field: string, kind: string) => ProblemException,
): void {
  for (const [field, kind] of PAYLOAD_FIELDS[opType]) {
    const value = payload[field];
    const ok =
      kind === 'uuid'
        ? typeof value === 'string' && UUID_RE.test(value)
        : kind === 'uuid-or-null'
          ? value === null ||
            value === undefined ||
            (typeof value === 'string' && UUID_RE.test(value))
          : kind === 'string-or-null'
            ? value === null || value === undefined || typeof value === 'string'
            : kind === 'number'
              ? typeof value === 'number' && Number.isFinite(value)
              : kind === 'array'
                ? Array.isArray(value) &&
                  value.length > 0 &&
                  value.every((entry) => typeof entry === 'object' && entry !== null)
                : typeof value === 'string';
    if (!ok) {
      throw refuse(field, kind);
    }
  }
}

@Injectable()
export class SyncReportCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // The seven op types' owning facades — the apply arm's re-execution seams.
    @Inject(ReceivingFacade) private readonly receiving: ReceivingFacade,
    @Inject(PutawayFacade) private readonly putaway: PutawayFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(ExcursionFacade) private readonly excursions: ExcursionFacade,
    @Inject(MovementsFacade) private readonly movements: MovementsFacade,
    // The recount arm's advisory lock (the warehouse scope, taken LAST).
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  // ── recordSyncReport (device session, badge-in required) ────────────────

  /**
   * The upload fingerprint (fixed key order — the command serializes the
   * rows in upload order, deterministically from the mobile store).
   */
  recordSyncReportFingerprint(command: RecordSyncReportCommand): string {
    return hashCommandPayload({
      tenantId: command.tenantId,
      deviceId: command.deviceId,
      operatorUserId: command.operatorUserId,
      rows: command.rows,
    });
  }

  /**
   * A replay pass's durable upload (device session; the report carries the
   * `rejected`/case-4 `quarantined` residents the walk dropped). Device
   * status and the operator's role re-read from the DB per command
   * (fail-closed — the `self-test.echo` shape: the token is transport, never
   * authority). Each row persists `open`; the `(tenant_id, op_id)` unique
   * pair absorbs the re-posted row, so the identical report with a FRESH key
   * is the dedupe's no-op (per the matrix), while the SAME key replays the
   * stored snapshot. Audit: `device.sync_report.recorded`.
   */
  async recordSyncReport(
    command: RecordSyncReportCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: SyncReportSnapshot; replayed: boolean }> {
    const rows = command.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Empty sync report',
        'A sync report carries the dropped terminal ops — at least one row (the device uploads nothing when it retained nothing).',
      );
    }
    if (rows.length > MAX_SYNC_REPORT_ROWS) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Too many sync-report rows',
        `A sync report carries at most ${MAX_SYNC_REPORT_ROWS} rows (got ${rows.length}).`,
      );
    }
    rows.forEach((row, index) => assertSyncReportRowShape(row, index));
    const payloadHash = this.recordSyncReportFingerprint(command);

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // The device row, LOCKED, re-resolved per command (fail-closed 403
        // `device-revoked` — the self-test echo's re-resolution).
        const deviceRows = await tx
          .select()
          .from(devices)
          .where(and(eq(devices.id, command.deviceId), eq(devices.tenantId, command.tenantId)))
          .for('update')
          .limit(1);
        const device = deviceRows[0];
        if (!device || device.status !== 'active' || device.pinHash === null) {
          throw deviceRevoked();
        }

        // The operator's current role from the DB (a demoted or removed
        // operator is 403 `role-denied`) — and the email the attribution stamps.
        const operatorRows = await tx
          .select({ role: users.role, email: users.email, status: users.status })
          .from(users)
          .where(and(eq(users.id, command.operatorUserId), eq(users.tenantId, command.tenantId)))
          .limit(1);
        const operator = operatorRows[0];
        if (operator === undefined || operator.status !== 'active' || operator.role === 'accountant') {
          throw new ProblemException(
            'role-denied',
            403,
            'Role lacks the required capability',
            `Role "${operator?.role ?? 'none'}" cannot operate a floor device.`,
          );
        }

        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, command.tenantId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as SyncReportSnapshot,
            replayed: true,
          };
        }

        const acks: SyncReportRowAck[] = [];
        for (const row of rows) {
          // The attribution stamp is PER ROW (the ratified per-card decision):
          // the SERVER-verified badge-in identity (ids and current label/email
          // — the columns' authority) beside THE ROW'S OWN sealed session as
          // the device reported it (the queue card's display attribution —
          // after a badge change the op's operator and the reporting session
          // may read differently; the columns decide the apply, the op
          // attribution is context). A batch may mix the op sessions that
          // produced its drops, so one stamp computed from `rows[0]` would
          // misstamp rows 2..n — each row carries its own.
          const attribution = {
            deviceId: command.deviceId,
            deviceLabel: device.label ?? null,
            operatorId: command.operatorUserId,
            operatorEmail: operator.email,
            opDeviceLabel: row.attribution?.deviceLabel ?? null,
            opOperatorEmail: row.attribution?.operatorEmail ?? null,
          };
          // The per-row dedupe: a re-posted (tenant, op_id) updates nothing —
          // the unique pair absorbs the retry, the exact at-least-once shape.
          const inserted = await tx
            .insert(rejectedOps)
            .values({
              id: uuidv7(),
              tenantId: command.tenantId,
              deviceId: command.deviceId,
              operatorUserId: command.operatorUserId,
              opId: row.opId,
              opType: row.opType,
              classification: row.classification,
              problemCode: row.problemCode,
              problemDetail: row.problemDetail ?? null,
              payload: row.payload,
              attribution,
              opEnqueuedAt: row.opEnqueuedAt,
              opOccurredAt: row.opOccurredAt ?? null,
            })
            .onConflictDoNothing({ target: [rejectedOps.tenantId, rejectedOps.opId] })
            .returning({ id: rejectedOps.id });
          acks.push({ opId: row.opId, recorded: inserted.length > 0 });
        }
        const recorded = acks.filter((ack) => ack.recorded).length;

        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.operatorUserId,
          action: 'device.sync_report.recorded',
          targetType: 'device',
          targetId: command.deviceId,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });

        await tx
          .update(devices)
          .set({ lastSeenAt: nowIso(), updatedAt: nowIso() })
          .where(eq(devices.id, command.deviceId));

        const body: SyncReportSnapshot = {
          received: acks.length,
          recorded,
          duplicates: acks.length - recorded,
          rows: acks,
        };
        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: body,
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
        return { snapshot: body, replayed: false };
      },
    );

    return { snapshot, replayed };
  }

  // ── listRejectedOps (the review queue's read) ────────────────────────────

  /**
   * The Conflicts & Reviews queue's read: one keyset page (`(created_at, id)`
   * desc — the pendings-queue shape), status-filtered, open to any tenant
   * member (a read, never capability-gated).
   */
  async listRejectedOps(
    tenantId: string,
    query: ListRejectedOpsQuery = {},
  ): Promise<Page<RejectedOpEntry>> {
    const pageSize = Math.min(
      Math.max(Math.trunc(query.limit ?? DEFAULT_REJECTED_OPS_PAGE_SIZE), 1),
      MAX_REJECTED_OPS_PAGE_SIZE,
    );
    if (query.status !== undefined && !REJECTED_OP_STATUS_SET.has(query.status)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Unknown rejected-op status',
        `status must be one of ${REJECTED_OP_STATUSES.join(', ')} (got "${query.status}").`,
      );
    }
    let before: { createdAt: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      let decoded: { createdAt: string; id: string };
      try {
        decoded = decodeCursor(query.cursor);
      } catch {
        throw new ProblemException(
          'invalid-cursor',
          400,
          'Malformed pagination cursor',
          'The cursor parameter is not a valid opaque page cursor.',
        );
      }
      if (!UUID_RE.test(decoded.id) || Number.isNaN(Date.parse(decoded.createdAt))) {
        throw new ProblemException(
          'invalid-cursor',
          400,
          'Malformed pagination cursor',
          'The cursor parameter is not a valid opaque page cursor.',
        );
      }
      before = decoded;
    }
    const rows = await withTenantTransaction(this.db, tenantId, (tx) => {
      const scope = and(
        eq(rejectedOps.tenantId, tenantId),
        query.status === undefined ? undefined : eq(rejectedOps.status, query.status),
        before
          ? sql`(${rejectedOps.createdAt}, ${rejectedOps.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`
          : undefined,
      );
      return tx
        .select()
        .from(rejectedOps)
        .where(scope)
        .orderBy(desc(rejectedOps.createdAt), desc(rejectedOps.id))
        .limit(pageSize + 1);
    });
    return buildPage(rows.map(rejectedOpEntry), pageSize);
  }

  // ── resolveRejectedOp (review.decide — owner + ops_manager) ─────────────

  resolveRejectedOpFingerprint(command: ResolveRejectedOpCommand): string {
    return hashCommandPayload({
      rejectedOpId: command.rejectedOpId,
      decision: command.decision,
      occurredAt: command.occurredAt,
    });
  }

  /**
   * Resolve one open rejected op (story 5-6, `review.decide` — owner +
   * Ops Manager; the excursion-queue's capability, already the review set's
   * — the mirror stays at 31). Three arms, one row per call:
   *
   * - **apply** — the stored payload re-executed through the op's OWN
   *   guarded command (the re-execution's idempotency key is the op's own
   *   ULID, so an apply-retry against a half-committed arm replays
   *   exactly-once rather than re-writing), `binStateEpoch` stripped, every
   *   other guard live (stock, holds, premises, role, kit rule), under the
   *   op's attributed operator. A guard refusal rolls the whole resolution
   *   back — the row STAYS open, the refusal surfaces verbatim, and the
   *   queue keeps showing the row's ORIGINAL replay refusal (a
   *   permanently-refused op closes only via discard — honest queue
   *   behavior, not a defect).
   * - **recount** — a count task minted on the payload's bin through the
   *   movement recount core (no ledger-write shortcut). Requires the payload
   *   to carry `binId` (the arm is hidden client-side for `binId`-less
   *   payloads; this 400 arm is the direct-request backstop, never a served
   *   409).
   * - **discard** — the row carried to the audit trail; no stock write.
   *
   * Command order (the resolveCountVariance shape, order-for-order):
   * capability → fingerprint → row lock `.for('update')` → 404 → 409
   * `rejected-op-resolved` → the arm → conditional terminal UPDATE
   * `.where(status = 'open')` → audit + outbox `device.rejected_op.resolved`
   * → idempotency LAST. The apply arm's commands open their OWN
   * transactions (command-skeleton shape) inside this one — the refusals
   * propagate and roll both back; the at-least-once net is the inner key.
   */
  async resolveRejectedOp(
    command: ResolveRejectedOpCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: ResolveRejectedOpSnapshot; replayed: boolean }> {
    let occurredAt: string;
    if (command.occurredAt === undefined) {
      occurredAt = nowIso();
    } else {
      try {
        occurredAt = assertUtcIso(command.occurredAt);
      } catch {
        throw new ProblemException(
          'validation-failed',
          400,
          'occurredAt must be a valid ISO-8601 UTC instant',
          `occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${command.occurredAt}").`,
        );
      }
    }
    if (!REJECTED_OP_DECISION_SET.has(command.decision)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Unknown resolution decision',
        `decision must be ${REJECTED_OP_DECISIONS.map((d) => `"${d}"`).join(' | ')} (got "${String(command.decision)}").`,
      );
    }
    const payloadHash = this.resolveRejectedOpFingerprint(command);

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry — DB role read, same tx, BEFORE
        // the replay lookup (the deliberate fail-closed carve-out).
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'review.decide',
        );

        const existing = await this.lookupIdempotencyKey(tx, command.tenantId, idempotencyKey);
        if (existing !== undefined) {
          if (existing.payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing.responseSnapshot as ResolveRejectedOpSnapshot,
            replayed: true,
          };
        }

        // The row, LOCKED — the state machine's mutex (404 when foreign).
        const rowRows = await tx
          .select()
          .from(rejectedOps)
          .where(
            and(
              eq(rejectedOps.tenantId, command.tenantId),
              eq(rejectedOps.id, command.rejectedOpId),
            ),
          )
          .limit(1)
          .for('update');
        const row = rowRows[0];
        if (row === undefined) {
          throw new ProblemException(
            'not-found',
            404,
            'Rejected op not found',
            `No rejected op with id "${command.rejectedOpId}" exists in this tenant.`,
          );
        }
        if (row.status !== 'open') {
          throw new ProblemException(
            'rejected-op-resolved',
            409,
            'Rejected op already resolved',
            `The rejected op "${row.opId}" already carries status "${row.status}" — reload the queue and decide the row's current state fresh.`,
          );
        }

        const resolvedAt = occurredAt;
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        this.assertPayloadShape(row.opType as RejectedOpType, payload, row.opId);

        let status: RejectedOpStatus;
        let resolvedOutcome: Record<string, unknown>;

        if (command.decision === 'discard') {
          // The discard arm: no stock write — the row carries its refusal +
          // reporter attribution to the audit trail (the audit row + outbox
          // event below).
          status = 'discarded';
          resolvedOutcome = { kind: 'discard' };
        } else if (command.decision === 'recount') {
          // The movement recount core: the bin the payload names (a pick's
          // `binId`, or a placement's `toBinId` — payload-carried, the server
          // does not guess).
          const binId = payload.binId ?? payload.toBinId;
          const warehouseId = payload.warehouseId;
          if (
            typeof binId !== 'string' ||
            !UUID_RE.test(binId) ||
            typeof warehouseId !== 'string' ||
            !UUID_RE.test(warehouseId)
          ) {
            throw new ProblemException(
              'validation-failed',
              400,
              'The payload carries no bin — the recount arm is not available',
              `The payload of op ${row.opId} does not name a bin, so no count task can be minted for it (the arm is hidden client-side for binId-less payloads; this row reaches the server only through a direct request).`,
            );
          }
          // Canonical order: assert the warehouse, lock the bin row, then the
          // warehouse advisory LAST — the count core's capture reads under
          // them exactly as every other onHandInBinInTx call does.
          await assertWarehouseInTenant(tx, command.tenantId, warehouseId);
          const binRows = await tx
            .select({ id: bins.id, code: bins.code })
            .from(bins)
            .where(
              and(
                eq(bins.tenantId, command.tenantId),
                eq(bins.warehouseId, warehouseId),
                eq(bins.id, binId),
              ),
            )
            .limit(1)
            .for('update');
          const bin = binRows[0];
          if (bin === undefined) {
            throw new ProblemException(
              'not-found',
              404,
              'Bin not found',
              `No bin with id "${binId}" exists in this warehouse.`,
            );
          }
          await this.inventory.lockWarehouseInTx(tx, command.tenantId, warehouseId);
          // The count core (open-task-per-bin rule + the capture) — inside.
          const countTaskId = await this.movements.mintRecountTaskInTx(
            tx,
            command.tenantId,
            warehouseId,
            binId,
            bin.code,
            resolvedAt,
          );
          status = 'recounted';
          resolvedOutcome = { kind: 'recounted', countTaskId };
        } else {
          // The apply arm: the op's own guarded command, re-executed. The
          // commands open their OWN transactions (the command skeletons');
          // a refusal propagates and rolls this whole transaction back —
          // the row stays open and the refusal surfaces verbatim.
          status = 'applied';
          const applied = await this.applyArm(
            command.tenantId,
            row,
            // The op's own ULID is the re-execution's idempotency key — the
            // exactly-once net that also makes an apply after a crash
            // mid-arm replay the settled apply rather than re-write it.
            row.opId,
            payload,
          );
          resolvedOutcome = { kind: 'applied', command: row.opType, snapshot: applied };
        }

        // The terminal transition is CONDITIONAL (the resolveCountVariance
        // shape's belt to the locked read's braces).
        const resolved = await tx
          .update(rejectedOps)
          .set({
            status,
            resolvedBy: command.actorUserId,
            resolvedAt,
            resolvedOutcome,
            updatedAt: resolvedAt,
          })
          .where(
            and(
              eq(rejectedOps.tenantId, command.tenantId),
              eq(rejectedOps.id, row.id),
              eq(rejectedOps.status, 'open'),
            ),
          )
          .returning();
        if (resolved[0] === undefined) {
          throw new ProblemException(
            'rejected-op-resolved',
            409,
            'Rejected op already resolved',
            `The terminal transition found the row no longer open — the row settled under a concurrent resolution.`,
          );
        }

        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'device.rejected_op.resolved',
          targetType: 'rejected_op',
          targetId: row.id,
          reference: idempotencyKey,
          occurredAt: resolvedAt,
        });

        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'device.rejected_op.resolved',
          occurredAt: resolvedAt,
          payload: {
            rejectedOpId: row.id,
            opId: row.opId,
            opType: row.opType,
            classification: row.classification,
            problemCode: row.problemCode,
            decision: command.decision,
            status,
            // The resolved row's contract, echoed: both attributions (the
            // original reporter's device + operator, the resolver's id).
            deviceId: row.deviceId,
            deviceLabel:
              (row.attribution as { deviceLabel?: string } | null)?.deviceLabel ?? null,
            operatorId: row.operatorUserId,
            operatorEmail:
              (row.attribution as { operatorEmail?: string } | null)?.operatorEmail ?? null,
            resolvedBy: command.actorUserId,
            resolvedAt,
            ...resolvedOutcome,
          },
        });

        const snap: ResolveRejectedOpSnapshot = {
          rejectedOp: rejectedOpEntry(resolved[0]),
          outcome: resolvedOutcome,
        };

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snap,
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
        return { snapshot: snap, replayed: false };
      },
    );

    return { snapshot, replayed };
  }

  private async lookupIdempotencyKey(tx: TenantTx, tenantId: string, key: string) {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
      .limit(1);
    return rows[0];
  }

  /**
   * The stored payload's top-level probe before an arm touches it (the
   * apply arm rebuilds the fields; an honest 400 beats a 500 inside a
   * facade call).
   */
  private assertPayloadShape(
    opType: RejectedOpType,
    payload: Record<string, unknown>,
    opId: string,
  ): void {
    assertOpPayloadShape(opType, payload, (field, kind) =>
      new ProblemException(
        'validation-failed',
        400,
        'The stored payload does not match its op type',
        `The payload of op ${opId} carries an invalid ${field} — expected ${kind}. The reported payload is stored verbatim and was refused before any write.`,
      ),
    );
  }

  /**
   * The op-type's own guarded command, re-executed (the apply arm) — one
   * dispatch arm per op type, `binStateEpoch` stripped (the human judgment
   * replaces the observation — it stays OUT of the payloads the commands
   * hash, so replay-with-apply never 422s on a stale token), `deviceId`
   * bound to the op's reported device, the attributed operator named as the
   * command's actor. `self-test.echo` never reaches here (not a member of
   * `REJECTED_OP_TYPES`; the upload refuses it).
   */
  private async applyArm(
    tenantId: string,
    row: RejectedOp,
    idempotencyKey: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const opType = row.opType as RejectedOpType;
    const deviceId = row.deviceId;
    const operatorUserId = row.operatorUserId;
    // The op's business time, normalized once: the payload's own instant when
    // it carries one, else the row's device-sealed `opOccurredAt` (read back
    // from the timestamptz column in pg's `+00` text form), else the resolve
    // instant. BOTH branches normalize-then-assert through the repo's strict
    // UTC-ISO contract — a non-Z instant in a stored payload must not 400
    // every apply forever (B3), and a lax `Date.parse` would accept
    // "January 15, 2026" here. The commands' `occurredAt` contracts (required
    // string, optional, or null-accepting) are all met from one source.
    let opTime: string;
    if (typeof payload.occurredAt === 'string' && payload.occurredAt !== '') {
      opTime = normalizeStoredInstant(payload.occurredAt, row.opId, 'payload.occurredAt');
    } else if (row.opOccurredAt !== null) {
      opTime = normalizeStoredInstant(row.opOccurredAt as string, row.opId, 'opOccurredAt');
    } else {
      opTime = nowIso();
    }
    try {
      opTime = assertUtcIso(opTime);
    } catch {
      throw new ProblemException(
        'validation-failed',
        400,
        'The stored op time is not a valid instant',
        `The stored op time of op ${row.opId} does not parse as an ISO-8601 UTC instant.`,
      );
    }
    switch (opType) {
      case 'grn.submit': {
        return (await this.receiving.submitGoodsReceipt(
          {
            tenantId,
            deviceId,
            operatorUserId,
            warehouseId: payload.warehouseId as string,
            poId: (payload.poId ?? null) as string | null,
            // Story 21-6: a stored pre-21-6 payload has none; the command
            // hashes it only when present and normalises each line's
            // `asnLineId` before validation, so an old op re-applies as before.
            asnId: (payload.asnId ?? null) as string | null,
            blindReasonCode: (payload.blindReasonCode ?? null) as string | null,
            // The op's business time: the payload's own, else the row's
            // opOccurredAt stamp (the device-sealed instant).
            occurredAt: opTime,
            lines: payload.lines as unknown as GrnCommand['lines'],
          },
          idempotencyKey,
        )) as unknown as Record<string, unknown>;
      }
      case 'putaway.place':
        return (await this.putaway.placePutaway(
          {
            tenantId,
            deviceId,
            operatorUserId,
            warehouseId: payload.warehouseId as string,
            grnId: payload.grnId as string,
            grnLineId: payload.grnLineId as string,
            skuId: payload.skuId as string,
            batchId: (payload.batchId ?? null) as string | null,
            qty: payload.qty as number,
            toBinId: payload.toBinId as string,
            reasonCode: (payload.reasonCode ?? null) as string | null,
            occurredAt: opTime,
            serials: payload.serials as string[] | undefined,
          },
          idempotencyKey,
        )) as unknown as Record<string, unknown>;
      case 'pick.record':
        // binStateEpoch STRIPPED: the human judgment replaces the observation
        // — nothing else (stock, holds, premises, role, kit rule) is
        // overridden.
        return (await this.outbound.recordPick(
          {
            tenantId,
            deviceId,
            operatorUserId,
            warehouseId: payload.warehouseId as string,
            picklistId: payload.picklistId as string,
            picklistLineId: payload.picklistLineId as string,
            skuId: payload.skuId as string,
            binId: payload.binId as string,
            qty: payload.qty as number,
            occurredAt: opTime,
            serials: payload.serials as string[] | undefined,
            reasonCode: (payload.reasonCode ?? null) as string | null | undefined,
          },
          idempotencyKey,
        )) as unknown as Record<string, unknown>;
      case 'pack.execute':
        return (await this.outbound.packOrder(
          {
            tenantId,
            actorUserId: operatorUserId,
            // The op's reported device (the DEVICE route's shape) — a device
            // revoked after the op queued (or after the report's upload) is
            // refused `device-revoked` by the command's own re-authorization.
            deviceId,
            // Story 9-1: a failed verification's fact row names this path.
            entry: 'sync',
            orderId: payload.orderId as string,
            scanned: payload.scanned as unknown as PackCommand['scanned'],
            weightGrams: (payload.weightGrams ?? null) as number | null | undefined,
          },
          idempotencyKey,
        )) as unknown as Record<string, unknown>;
      case 'excursion.record':
        return (await this.excursions.recordExcursion(
          {
            tenantId,
            actorUserId: operatorUserId,
            deviceId,
            warehouseId: payload.warehouseId as string,
            binId: payload.binId as string,
            readingC: payload.readingC as number,
            note: (payload.note ?? null) as string | null,
            occurredAt: opTime,
          },
          idempotencyKey,
        )) as unknown as Record<string, unknown>;
      case 'transfer.confirm':
        // The transfer id rides URL on the device path but is NOT part of the
        // resolve route — the payload carries it (the mobile op payload
        // includes transferId exactly as `sendOp` reads it).
        return (await this.movements.confirmInbound(
          {
            tenantId,
            actorUserId: operatorUserId,
            transferId: payload.transferId as string,
            destBinId: payload.destBinId as string | undefined,
            // The staleness token, dropped at APPLY (the spec's single
            // override) — a moved bin lands honestly here, the command's own
            // epoch compare runs under its locks.
            binStateEpoch: undefined,
            occurredAt: opTime,
          },
          idempotencyKey,
        )) as unknown as Record<string, unknown>;
      case 'count.submit':
        return (await this.movements.submitCount(
          {
            tenantId,
            actorUserId: operatorUserId,
            taskId: payload.taskId as string,
            lines: payload.lines as unknown as CountSubmitCommand['lines'],
            // The business time is the op's own — the payload's instant, else
            // the row's opOccurredAt, else the command defaults (its own
            // shape, never a re-guess here).
            occurredAt: opTime,
          },
          idempotencyKey,
        )) as unknown as Record<string, unknown>;
      default: {
        // Exhaustiveness — a new REJECTED_OP_TYPES member must pick its
        // command here before it is reviewable.
        const exhaustive: never = opType;
        throw new ProblemException(
          'validation-failed',
          400,
          'No re-execution command for this op type',
          `Op type "${String(exhaustive)}" has no apply-dispatch arm.`,
        );
      }
    }
  }
}

/** The stored payloads' array fields cast through `unknown` onto the owning
 * commands' line shapes — the payloads were DTO-shaped at enqueue (the mobile
 * senders), the commands re-assert every deeper invariant in-tx. */
type GrnCommand = Parameters<ReceivingFacade['submitGoodsReceipt']>[0];
type PackCommand = Parameters<OutboundFacade['packOrder']>[0];
type CountSubmitCommand = Parameters<MovementsFacade['submitCount']>[0];
