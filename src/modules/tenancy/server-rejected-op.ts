import { and, eq } from 'drizzle-orm';
import { devices, rejectedOps, users } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';

/**
 * Story 9-2's panel raise event for a row entering the review queue —
 * declared here (the lighter file) and re-exported by `sync-report.command`.
 */
export const REJECTED_OP_RAISED_EVENT = 'device.rejected_op.raised';

/** One server-raised review row (story 13-2). */
export interface ServerRejectedOpInput {
  readonly tenantId: string;
  /** The reporting device (the op's badge-in session). */
  readonly deviceId: string;
  /** The op's operator (the badge-in session's user). */
  readonly operatorUserId: string;
  /** A ULID derived from the op's key — never the key itself (the caller derives it). */
  readonly opId: string;
  /** A reviewable op type (`REJECTED_OP_TYPES`). */
  readonly opType: string;
  readonly problemCode: string;
  readonly problemDetail: string | null;
  readonly payload: Record<string, unknown>;
  /** The op's own business time — both the enqueued and occurred stamps. */
  readonly occurredAt: string;
}

/**
 * Story 13-2 — the server-raised rejected op: a command that settled part of
 * a floor op and REFUSED the rest records the refused part in the existing
 * Conflicts & Reviews queue itself, in its own transaction, so nothing is
 * silently dropped and nothing silently accepted (human decision 3). The
 * device never uploads it: the op settled `201`, so the replay walk has no
 * terminal drop to report.
 *
 * Tenancy owns `rejected_ops`, `devices` and `users`; the caller (the returns
 * module) reaches all three only through here. The row is exactly an
 * uploaded one's shape — `classification: 'rejected'`, every NOT NULL column
 * set (the attribution built from the device and user rows the caller's
 * guard already re-read; the op's own session IS the reporting session), and
 * `opEnqueuedAt` / `opOccurredAt` = the op's business time.
 *
 * Idempotent on `(tenant_id, op_id)` like an upload: a re-insert does
 * nothing and raises nothing. Returns the new row's id, or null when the pair
 * already existed. Raises `device.rejected_op.raised` on a fresh insert, so
 * the 9-2 `rejected-op` panel entry fires.
 */
export async function recordServerRejectedOpInTx(
  tx: TenantTx,
  outbox: OutboxSink,
  input: ServerRejectedOpInput,
): Promise<string | null> {
  const deviceRows = await tx
    .select({ label: devices.label })
    .from(devices)
    .where(and(eq(devices.id, input.deviceId), eq(devices.tenantId, input.tenantId)))
    .limit(1);
  const operatorRows = await tx
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.id, input.operatorUserId), eq(users.tenantId, input.tenantId)))
    .limit(1);
  const deviceLabel = deviceRows[0]?.label ?? null;
  const operatorEmail = operatorRows[0]?.email ?? null;
  const attribution = {
    deviceId: input.deviceId,
    deviceLabel,
    operatorId: input.operatorUserId,
    operatorEmail,
    // The op's own session is the session that sent it — the server raised
    // the row while executing it.
    opDeviceLabel: deviceLabel,
    opOperatorEmail: operatorEmail,
  };
  const inserted = await tx
    .insert(rejectedOps)
    .values({
      id: uuidv7(),
      tenantId: input.tenantId,
      deviceId: input.deviceId,
      operatorUserId: input.operatorUserId,
      opId: input.opId,
      opType: input.opType,
      classification: 'rejected',
      problemCode: input.problemCode,
      problemDetail: input.problemDetail,
      payload: input.payload,
      attribution,
      opEnqueuedAt: input.occurredAt,
      opOccurredAt: input.occurredAt,
    })
    .onConflictDoNothing({ target: [rejectedOps.tenantId, rejectedOps.opId] })
    .returning({ id: rejectedOps.id });
  const rejectedOpId = inserted[0]?.id ?? null;
  if (rejectedOpId !== null) {
    await outbox.append(tx, {
      messageId: uuidv7(),
      tenantId: input.tenantId,
      type: REJECTED_OP_RAISED_EVENT,
      occurredAt: nowIso(),
      payload: {
        rejectedOpId,
        opId: input.opId,
        opType: input.opType,
        problemCode: input.problemCode,
        deviceId: input.deviceId,
        operatorUserId: input.operatorUserId,
      },
    });
  }
  return rejectedOpId;
}
