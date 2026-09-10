import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, bins, idempotencyKeys } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import type { BinSnapshot } from '../tenancy/bin.command';
import { IDEMPOTENCY_TENANT_KEY, binNotFound, binRetired409 } from '../tenancy/bin.errors';

/**
 * The bin's blocking state, re-homed from the tenancy module (Story 3.6):
 * the architecture's ownership split is about who owns the *command logic*
 * — tenancy owns bin master data (create/merge/retire), putaway owns bin
 * OPERATIONAL state (`bins.blocked`), because a blocked bin drops out of
 * putaway suggestions and rejects placements the moment it flips. The
 * controller URL (`PATCH .../bins/{binId}`) and the FE contract stay where
 * they were — only the logic re-homes.
 *
 * Story 3.6 additions to the 1.3 command: a system-bin guard (the
 * Receiving/QC-hold bins can never be blocked — closing the gap where the
 * toggle could quarantine them) and the audit row (the 3.4/3.5 convention).
 * The outbox `bin.blocked` event, the idempotency replay, and the
 * capability gate (`bin.block`) are unchanged.
 */

/** Re-homed from tenancy's `SetBinBlockedCommand` — same shape, same URL. */
export interface SetBinBlockedCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly blocked: boolean;
}

@Injectable()
export class BinStateCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async setBlocked(command: SetBinBlockedCommand, idempotencyKey: string): Promise<BinSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      binId: command.binId,
      blocked: command.blocked,
    });

    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry (Story 1.5) — DB read, same tx.
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'bin.block',
        );

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
            snapshot: existing[0].responseSnapshot as BinSnapshot,
            replayed: true,
          };
        }

        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

        // The bin row first, locked `.for('update')` (the mergeBin shape):
        // the guards run against the locked row BEFORE any write, so a
        // rejection can never depend on the UPDATE rolling back.
        const lockedRows = await tx
          .select()
          .from(bins)
          .where(and(eq(bins.id, command.binId), eq(bins.warehouseId, command.warehouseId)))
          .limit(1)
          .for('update');
        const row = lockedRows[0];
        if (!row) {
          throw binNotFound();
        }
        // Story 3.6: the system bins (Receiving/QC-hold) are operational
        // infrastructure the commands own — blocking one would drop the
        // warehouse's intake/quarantine out of the flow with no unblock path
        // on the device. Never blockable.
        if (row.systemOwned) {
          throw new ProblemException(
            'validation-failed',
            400,
            'System bins can never be blocked',
            `Bin "${row.code}" is a system bin (Receiving/QC-hold) — blocking it is refused.`,
          );
        }
        // A retired bin is operationally gone — nothing left to block or
        // unblock (the re-retire rejection's sibling, 409 `bin-retired`).
        if (row.retiredAt !== null) {
          throw binRetired409(row.code);
        }

        const updatedRows = await tx
          .update(bins)
          .set({ blocked: command.blocked, updatedAt: nowIso() })
          .where(eq(bins.id, row.id))
          .returning();
        const updated = updatedRows[0]!;
        const bin: BinSnapshot['bin'] = {
          id: updated.id,
          tenantId: updated.tenantId,
          warehouseId: updated.warehouseId,
          zoneId: updated.zoneId,
          code: updated.code,
          capacity: updated.capacity,
          type: updated.type,
          blocked: updated.blocked,
          systemOwned: updated.systemOwned,
          retiredAt: updated.retiredAt,
          retiredBy: updated.retiredBy,
          createdAt: updated.createdAt,
        };

        // In-transaction outbox append (AD-7) — the 1.3 shape unchanged; the
        // idempotent replay returned above appends nothing.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'bin.blocked',
          occurredAt: nowIso(),
          payload: {
            binId: bin.id,
            warehouseId: bin.warehouseId,
            blocked: bin.blocked,
          },
        });

        // The audit row (the 3.4/3.5 convention) — same transaction, after
        // the outbox append, before the idempotency key.
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'bin.blocked',
          targetType: 'bin',
          targetId: bin.id,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: { bin },
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
        return { snapshot: { bin }, replayed: false };
      },
    );

    return snapshot;
  }
}