import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, ledgerChainBreaks } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { LEDGER_CHAIN_BREAK_ACKNOWLEDGED_EVENT } from './ledger.service';
import { toBreakView, type ChainBreakView } from './ledger-integrity';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

export interface AcknowledgeChainBreakCommand {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly breakId: string;
  readonly actorUserId: string;
}

function chainBreakNotFound(): ProblemException {
  return new ProblemException(
    'chain-break-not-found',
    404,
    'Chain break not found',
    'No ledger chain break with this id exists in this warehouse.',
  );
}

/**
 * Story 9-3c — the owner acknowledges a ledger chain break (the panel entry
 * resolves `acknowledged`). The §1 skeleton:
 *
 *  1. hash `{arm: 'ledger-break-ack', tenantId, warehouseId, breakId}`
 *     above the transaction (the `arm` keeps the payload distinct from any
 *     other keyed route's byte-identical shape);
 *  2. `ledger.acknowledge` (owner-only) inside, before anything is read;
 *  3. replay; lock the break row `FOR UPDATE` (404 `chain-break-not-found`
 *     for an unknown id or one in another warehouse — the lock helper only
 *     locks); replay AGAIN under the lock (the same-key race);
 *  4. guard: already acknowledged → 409 `chain-break-acknowledged`;
 *  5. the conditional write, `ledger.chain_break_acknowledged`, the audit
 *     row `ledger_chain_break.acknowledged`, the key LAST.
 *
 * ACKNOWLEDGING REPAIRS NOTHING: `broken_at_seq` stays, and a broken tail
 * still refuses to anchor — the chain is exactly as broken as before; the
 * owner has only said they have seen it.
 */
@Injectable()
export class LedgerBreakCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async acknowledge(command: AcknowledgeChainBreakCommand, idempotencyKey: string): Promise<ChainBreakView> {
    const payloadHash = hashCommandPayload({
      arm: 'ledger-break-ack',
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      breakId: command.breakId,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'ledger.acknowledge');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      const current = await this.lockBreak(tx, command);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) {
        return replayedUnderLock;
      }
      if (current.acknowledgedAt !== null) {
        throw new ProblemException(
          'chain-break-acknowledged',
          409,
          'Chain break already acknowledged',
          `This chain break (seq ${current.firstSeq}) was already acknowledged.`,
        );
      }
      const acknowledgedAt = nowIso();
      const rows = await tx
        .update(ledgerChainBreaks)
        .set({ acknowledgedBy: command.actorUserId, acknowledgedAt })
        .where(
          and(
            eq(ledgerChainBreaks.tenantId, command.tenantId),
            eq(ledgerChainBreaks.id, current.id),
            isNull(ledgerChainBreaks.acknowledgedAt),
          ),
        )
        .returning();
      const snapshot = toBreakView(rows[0]!);
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: LEDGER_CHAIN_BREAK_ACKNOWLEDGED_EVENT,
        occurredAt: acknowledgedAt,
        payload: { breakId: current.id, warehouseId: current.warehouseId },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'ledger_chain_break.acknowledged',
        targetType: 'ledger_chain_break',
        targetId: current.id,
        reference: idempotencyKey,
        // The same instant as the acknowledgement it records.
        occurredAt: acknowledgedAt,
      });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /** Lock the break row, 404 when absent — and nothing else (IMPLEMENTATION-GUIDE §1: a lock helper never checks status). */
  private async lockBreak(tx: TenantTx, command: AcknowledgeChainBreakCommand) {
    const rows = await tx
      .select()
      .from(ledgerChainBreaks)
      .where(
        and(
          eq(ledgerChainBreaks.tenantId, command.tenantId),
          eq(ledgerChainBreaks.warehouseId, command.warehouseId),
          eq(ledgerChainBreaks.id, command.breakId),
        ),
      )
      .limit(1)
      .for('update');
    const row = rows[0];
    if (row === undefined) {
      throw chainBreakNotFound();
    }
    return row;
  }

  private async replay(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<ChainBreakView | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (row === undefined) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return row.responseSnapshot as ChainBreakView;
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: ChainBreakView,
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
