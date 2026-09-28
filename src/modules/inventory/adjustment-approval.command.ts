import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, stockAdjustmentPendings, stockAdjustmentPolicies } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import { UUID_RE } from '../../shared/primitives/ids';
import { uuidv7 } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
import type { SignedQuantity } from '../../shared/primitives/quantity';
import { canonicalInstant, fullPrecisionInstant, nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { StockAdjustmentCommand } from './inventory.command';
import type {
  AdjustStockCommand,
  StockAdjustmentSnapshot,
} from './inventory.command';

/**
 * Story 5-2 — the adjustment approval-threshold commands (FR-19): the
 * pending→decide flow for stock adjustments that pended because
 * |quantityDelta| exceeded the tenant's policy threshold, plus the policy
 * surface itself. THE pending→decide shape is `decideOverReceipt`
 * (receiving.command.ts) copied order-for-order:
 *
 *   capability assert → replay lookup → row lock (`.for('update')`) →
 *   terminal-409 guard → [approve: re-execute the stored arms] → conditional
 *   terminal UPDATE `.where(status = 'pending')` → audit row → outbox event →
 *   idempotency key LAST.
 *
 * The deliberate carve-out and the rollback contract ride with it: the
 * capability assert runs BEFORE the replay lookup (fail-closed), and if the
 * approval's re-execution fails any guard the whole transaction rolls back —
 * the pending row STAYS pending and the caller gets the guard's 4xx verbatim
 * (the Owner may then reject). Decisions are terminal: a second decision is a
 * deterministic 409 `adjustment-pending-decided`.
 */

export interface DecideAdjustmentCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly pendingAdjustmentId: string;
  readonly decision: 'approve' | 'reject';
}

/** The idempotent PUT body of the tenant's threshold policy. */
export interface SetAdjustmentPolicyCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  /** The |quantityDelta| ceiling in BASE units; the column is non-null. */
  readonly quantityThreshold: number;
}

/** GET …/inventory/adjustment-policies response — null when no policy row exists (flow disabled). */
export interface AdjustmentPolicySnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly quantityThreshold: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One row of the pending-queue read (and the decision response's core). */
export interface AdjustmentPendingEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly skuId: string;
  /** Signed delta in BASE units (read model — base units at the edge, 10.1). */
  readonly quantityDelta: number;
  readonly reasonCode: string;
  readonly note: string;
  readonly batchOverrideReason: string | null;
  readonly batchId: string | null;
  readonly serialIds: readonly string[] | null;
  readonly handlingUnitIds: readonly string[] | null;
  readonly occurredAt: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly status: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly thresholdQuantityAtRequest: number;
  readonly createdAt: string;
}

export interface ListAdjustmentPendingsQuery {
  readonly status?: 'pending' | 'approved' | 'rejected' | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * The decision response: the terminal state plus, on the approve arm, the
 * applied event snapshot(s) (the aggregate multi-serial pairing rides the
 * same shape as the immediate path — retro A4) and the settled on-hand.
 */
export interface AdjustmentDecisionSnapshot {
  readonly pendingAdjustment: AdjustmentPendingEntry;
  readonly events: readonly StockAdjustmentSnapshot['event'][];
  readonly onHand: StockAdjustmentSnapshot['onHand'] | null;
}

export const DEFAULT_ADJUSTMENT_PAGE_SIZE = 50;

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const POLICY_TENANT_KEY = 'stock_adjustment_policies_tenant_id_unique';

/**
 * The cursor is opaque to clients but crafted input is still possible — a
 * base64-valid payload with a non-uuid `id` would otherwise reach the
 * `::uuid` cast in SQL and surface as a 500 instead of a 400 (the shared
 * `decodeCursorSafe` pattern of the other read facades; per-file by
 * convention).
 */
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = decodeCursor(cursor);
    const malformedCursor =
      !UUID_RE.test(decoded.id) ||
      !CURSOR_INSTANT_RE.test(decoded.createdAt) ||
      Number.isNaN(Date.parse(decoded.createdAt));
    if (malformedCursor) {
      throw new Error('malformed cursor payload');
    }
    return decoded;
  } catch {
    throw new ProblemException(
      'invalid-cursor',
      400,
      'Malformed pagination cursor',
      'The cursor parameter is not a valid opaque page cursor.',
    );
  }
}

function pendingEntry(row: typeof stockAdjustmentPendings.$inferSelect): AdjustmentPendingEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    warehouseId: row.warehouseId,
    binId: row.binId,
    skuId: row.skuId,
    // Read model — base units at the edge (story 10.1); `fromMilli` of the
    // signed stored delta round-trips exactly (AD-9).
    quantityDelta: fromMilli(row.quantityMilli),
    reasonCode: row.reasonCode,
    note: row.note,
    batchOverrideReason: row.batchOverrideReason,
    batchId: row.batchId,
    serialIds: row.serialIds,
    handlingUnitIds: row.handlingUnitIds,
    occurredAt: canonicalInstant(row.occurredAt),
    requestedBy: row.requestedBy,
    requestedAt: canonicalInstant(row.requestedAt),
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt === null ? null : canonicalInstant(row.decidedAt),
    thresholdQuantityAtRequest: row.thresholdQuantityAtRequest,
    createdAt: canonicalInstant(row.createdAt),
  };
}

@Injectable()
export class AdjustmentApprovalCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // The approval re-executes the stored arms through the SAME internals the
    // immediate path runs — the guard set and the apply live on the stock
    // adjustment command (story 5-2 extraction), one module, no facade hop.
    @Inject(StockAdjustmentCommand)
    private readonly stockAdjustment: StockAdjustmentCommand,
  ) {}

  /**
   * PUT …/inventory/adjustment-policies — the tenant's threshold row,
   * idempotent under the Idempotency-Key (a replay re-serves the stored
   * snapshot; a key reuse with a different threshold is the 422). The write
   * rides the `adjustments.approve` capability (a policy IS the approval
   * rule — the `waves.manage` rationale). Audit row:
   * `stock_adjustment.policy_updated`.
   */
  async setAdjustmentPolicy(
    command: SetAdjustmentPolicyCommand,
    idempotencyKey: string,
  ): Promise<AdjustmentPolicySnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      quantityThreshold: command.quantityThreshold,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority at command-service entry — DB role read, same tx, BEFORE
      // the replay lookup (the deliberate fail-closed carve-out).
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'adjustments.approve',
      );

      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.tenantId, command.tenantId), eq(idempotencyKeys.key, idempotencyKey)),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].payloadHash !== payloadHash) {
          throw idempotencyKeyReuse();
        }
        return existing[0].responseSnapshot as AdjustmentPolicySnapshot;
      }

      const updatedAt = nowIso();
      const current = await tx
        .select()
        .from(stockAdjustmentPolicies)
        .where(eq(stockAdjustmentPolicies.tenantId, command.tenantId))
        .limit(1)
        .for('update');
      let written: readonly (typeof stockAdjustmentPolicies.$inferSelect)[];
      if (current[0] === undefined) {
        try {
          written = await tx
            .insert(stockAdjustmentPolicies)
            .values({
              id: uuidv7(),
              tenantId: command.tenantId,
              quantityThreshold: command.quantityThreshold,
            })
            .returning();
        } catch (err) {
          // Two concurrent first-time PUTs race the unique index — the
          // winner's row is authoritative; retry to read the settled result.
          if (isUniqueViolationOn(err, POLICY_TENANT_KEY)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent policy write',
              'The adjustment policy is being written concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
      } else {
        written = await tx
          .update(stockAdjustmentPolicies)
          .set({ quantityThreshold: command.quantityThreshold, updatedAt })
          .where(eq(stockAdjustmentPolicies.id, current[0]!.id))
          .returning();
      }
      const policy = written[0]!;

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'stock_adjustment.policy_updated',
        targetType: 'stock_adjustment_policy',
        targetId: policy.id,
        reference: idempotencyKey,
        occurredAt: updatedAt,
      });

      const snapshot: AdjustmentPolicySnapshot = {
        id: policy.id,
        tenantId: policy.tenantId,
        quantityThreshold: policy.quantityThreshold!,
        createdAt: canonicalInstant(policy.createdAt),
        updatedAt: canonicalInstant(policy.updatedAt),
      };
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * GET …/inventory/adjustment-policies — the tenant's policy row, or null
   * when none exists (the flow is disabled; the controller answers 404). A
   * read — never capability-gated.
   */
  async getAdjustmentPolicy(tenantId: string): Promise<AdjustmentPolicySnapshot | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(stockAdjustmentPolicies)
        .where(eq(stockAdjustmentPolicies.tenantId, tenantId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        id: row.id,
        tenantId: row.tenantId,
        quantityThreshold: row.quantityThreshold!,
        createdAt: canonicalInstant(row.createdAt),
        updatedAt: canonicalInstant(row.updatedAt),
      };
    });
  }

  /**
   * GET …/inventory/adjustment-pendings — the pending queue (the approval
   * cards' rows: reason, delta, threshold context, requester, and — after a
   * decision — who decided). Newest first, keyset cursor pagination
   * (offset pagination is banned — UX-DR25), status-filterable. A read —
   * never capability-gated (the deciding mutations are).
   */
  async listAdjustmentPendings(
    tenantId: string,
    query: { status?: 'pending' | 'approved' | 'rejected' | undefined; cursor?: string | undefined; limit?: number | undefined } = {},
  ): Promise<Page<AdjustmentPendingEntry>> {
    const pageSize = query.limit ?? DEFAULT_ADJUSTMENT_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          row: stockAdjustmentPendings,
          // Story 5-2: the CURSOR needs the raw `::text` instant — the
          // driver's parse (and `canonicalInstant`) truncates to
          // milliseconds, and a truncated cursor's strict `<` would skip the
          // tail of a tie group (rows sharing one transactional `now()`).
          // See `fullPrecisionInstant`.
          createdAtText: sql<string>`${stockAdjustmentPendings.createdAt}::text`,
        })
        .from(stockAdjustmentPendings)
        .where(
          and(
            eq(stockAdjustmentPendings.tenantId, tenantId),
            query.status === undefined ? undefined : eq(stockAdjustmentPendings.status, query.status),
            before === undefined
              ? undefined
              : sql`(${stockAdjustmentPendings.createdAt}, ${stockAdjustmentPendings.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(stockAdjustmentPendings.createdAt), desc(stockAdjustmentPendings.id))
        .limit(pageSize + 1);
      // buildPage encodes the cursor from the FULL-precision instants; the
      // surfaced entries keep the canonical (ms) body shape.
      const page = buildPage(
        rows.map((wrapped) => ({
          createdAt: fullPrecisionInstant(wrapped.createdAtText),
          id: wrapped.row.id,
          entry: pendingEntry(wrapped.row),
        })),
        pageSize,
      );
      return {
        items: page.items.map((wrapped) => wrapped.entry),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * POST …/adjustment-pendings/:pendingId/approve | /reject — the decision.
   * The approve arm re-executes the pend's stored arms through the stock
   * adjustment's own internals (`assertAdjustableInTx` + `applyAdjustmentInTx`,
   * the threshold gate lives OUTSIDE both, so it is skipped by construction):
   * the SKU row `.for('update')`, the kit refusal, the catch-weight refusals,
   * the arm-required parity checks, the serial locks, the handling-unit
   * write-off and `appendMovement` — the approved events carry the DECISION
   * time as their business time and the approver as their actor, with the
   * referenceDoc byte-identical to what the same request would have produced
   * immediately (the stored `batch_override_reason` rides
   * `approvedOverrideReason`).
   *
   * If the re-execution fails any guard (bin retired since, on-hand starved
   * since, a handling unit no longer active, the SKU became a kit) the whole
   * transaction rolls back — the pending row STAYS pending, the caller gets
   * the guard's 4xx verbatim, and the Owner may reject instead. Both arms
   * write the audit row + outbox event; a second decision is a deterministic
   * 409 `adjustment-pending-decided` (the conditional terminal UPDATE).
   */
  async decideAdjustment(
    command: DecideAdjustmentCommand,
    idempotencyKey: string,
  ): Promise<AdjustmentDecisionSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      pendingAdjustmentId: command.pendingAdjustmentId,
      decision: command.decision,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority at command-service entry — DB role read, same tx, BEFORE
      // the replay lookup (the deliberate fail-closed carve-out).
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'adjustments.approve',
      );

      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.tenantId, command.tenantId), eq(idempotencyKeys.key, idempotencyKey)),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].payloadHash !== payloadHash) {
          throw idempotencyKeyReuse();
        }
        return existing[0].responseSnapshot as AdjustmentDecisionSnapshot;
      }

      const rows = await tx
        .select()
        .from(stockAdjustmentPendings)
        .where(
          and(
            eq(stockAdjustmentPendings.id, command.pendingAdjustmentId),
            eq(stockAdjustmentPendings.tenantId, command.tenantId),
          ),
        )
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Pending adjustment not found',
          `No pending adjustment with id "${command.pendingAdjustmentId}" exists in this tenant.`,
        );
      }
      if (row.status !== 'pending') {
        throw new ProblemException(
          'adjustment-pending-decided',
          409,
          'Pending adjustment already decided',
          `Pending adjustment "${row.id}" is already ${row.status} — decisions are terminal.`,
        );
      }

      const decidedAt = nowIso();
      const status = command.decision === 'approve' ? 'approved' : 'rejected';
      const decisionEvent = `stock_adjustment.${status}`;

      let events: AdjustmentDecisionSnapshot['events'] = [];
      let onHand: AdjustmentDecisionSnapshot['onHand'] = null;
      if (command.decision === 'approve') {
        // The stored arms re-execute through the SAME internals the immediate
        // path runs — assertAdjustableInTx first (the full guard set, so a
        // moved world refuses BEFORE any write), then the apply. The
        // threshold gate is NOT part of those internals: it ran once, at
        // request time, and this re-execution must not re-ask it (a policy
        // PUT between raise and decision cannot un-pend the row or re-202
        // the approval).
        const delta = row.quantityMilli as SignedQuantity;
        const rebuilt: AdjustStockCommand = {
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          warehouseId: row.warehouseId,
          skuId: row.skuId,
          binId: row.binId,
          // `fromMilli` of the stored milli delta round-trips exactly (AD-9).
          quantityDelta: fromMilli(row.quantityMilli),
          reasonCode: row.reasonCode,
          note: row.note,
          // The approved events' business time is the DECISION time (the
          // pending row preserves the request's).
          occurredAt: decidedAt,
          batchRef: row.batchId,
          serialRefs: row.serialIds ?? undefined,
          handlingUnitIds: row.handlingUnitIds ?? undefined,
          // The override draw's restored referenceDoc field — byte-identical
          // to what the same request would have produced immediately.
          approvedOverrideReason: row.batchOverrideReason ?? undefined,
        };
        await this.stockAdjustment.assertAdjustableInTx(tx, rebuilt);
        const applied = await this.stockAdjustment.applyAdjustmentInTx(
          tx,
          rebuilt,
          delta,
          row.handlingUnitIds ?? [],
          decidedAt,
        );
        events = [applied.snapshot.event];
        onHand = applied.snapshot.onHand;
      }

      // The terminal transition is CONDITIONAL — a concurrent duplicate (or a
      // second decision after this tx committed) finds the row already
      // decided and answers the deterministic 409. The conditional's rowcount
      // is the race backstop: it can only fall to zero if another decision
      // committed between our locked read and this UPDATE, which the row
      // lock makes unreachable — but the predicate stays as the belt to the
      // `.for('update')` braces.
      const decided = await tx
        .update(stockAdjustmentPendings)
        .set({ status, decidedBy: command.actorUserId, decidedAt, updatedAt: decidedAt })
        .where(and(eq(stockAdjustmentPendings.id, row.id), eq(stockAdjustmentPendings.status, 'pending')))
        .returning({ id: stockAdjustmentPendings.id });
      if (decided.length === 0) {
        throw new ProblemException(
          'adjustment-pending-decided',
          409,
          'Pending adjustment already decided',
          `Pending adjustment "${row.id}" is already decided — decisions are terminal.`,
        );
      }

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: decisionEvent,
        targetType: 'stock_adjustment_pending',
        targetId: row.id,
        reference: idempotencyKey,
        occurredAt: decidedAt,
      });

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: decisionEvent,
        occurredAt: decidedAt,
        payload: {
          pendingAdjustmentId: row.id,
          warehouseId: row.warehouseId,
          skuId: row.skuId,
          binId: row.binId,
          quantityDelta: fromMilli(row.quantityMilli),
          reasonCode: row.reasonCode,
          requestedBy: row.requestedBy,
          thresholdQuantityAtRequest: row.thresholdQuantityAtRequest,
          decidedBy: command.actorUserId,
          decidedAt,
          // The approve arm's ledger pairing mirrors the response snapshot
          // (retro A4): null/null with the aggregate delta on a multi-serial
          // apply, the exact event id/seq otherwise.
          eventId: events[0]?.id ?? null,
          seq: events[0]?.seq ?? null,
        },
      });

      const snapshot: AdjustmentDecisionSnapshot = {
        pendingAdjustment: pendingEntry({ ...row, status, decidedBy: command.actorUserId, decidedAt }),
        events,
        onHand,
      };
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: unknown,
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