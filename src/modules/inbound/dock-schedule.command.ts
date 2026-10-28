import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, dockSchedules, idempotencyKeys } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { lockDockSetupInTx, writeDockKeyInTx } from './dock-door.command';
import {
  DOCK_LIMITS,
  DOCK_SLOT_MINUTES,
  dockScheduleOfInTx,
  dockScheduleView,
  hhmmToMinute,
  maskOfOpenDays,
  type DockScheduleView,
} from './dock.read';

export interface PutDockScheduleCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly slotMinutes: number;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly openDays: readonly number[];
  readonly graceMinutes: number;
}

export interface DockScheduleSnapshot {
  readonly schedule: DockScheduleView;
}

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid dock schedule', detail);
}

/** Decision 3's rules, each a 400 naming the field. */
function normalizeSchedule(command: PutDockScheduleCommand): {
  slotMinutes: number;
  opensMinute: number;
  closesMinute: number;
  openDays: number;
  graceMinutes: number;
} {
  if (!(DOCK_SLOT_MINUTES as readonly unknown[]).includes(command.slotMinutes)) {
    throw invalid(`slotMinutes must be one of ${JSON.stringify(DOCK_SLOT_MINUTES)} (got ${String(command.slotMinutes)}).`);
  }
  const slot = command.slotMinutes;
  const opens = hhmmToMinute(command.opensAt, false);
  if (opens === null) throw invalid(`opensAt must be an IST time HH:MM from 00:00 to 23:59 (got "${String(command.opensAt).slice(0, 16)}").`);
  const closes = hhmmToMinute(command.closesAt, true);
  if (closes === null) throw invalid(`closesAt must be an IST time HH:MM from 00:01 to 24:00 (got "${String(command.closesAt).slice(0, 16)}").`);
  if (opens % slot !== 0) throw invalid(`opensAt (${command.opensAt}) is not on the ${slot}-minute slot grid.`);
  if (closes % slot !== 0) throw invalid(`closesAt (${command.closesAt}) is not on the ${slot}-minute slot grid.`);
  if (closes <= opens) throw invalid(`closesAt (${command.closesAt}) must be after opensAt (${command.opensAt}).`);
  if (!Array.isArray(command.openDays) || command.openDays.length === 0) {
    throw invalid('openDays must name at least one ISO weekday (1 = Monday … 7 = Sunday).');
  }
  const seen = new Set<number>();
  for (const day of command.openDays) {
    if (!Number.isInteger(day) || day < 1 || day > 7) throw invalid(`openDays holds ISO weekdays 1–7 (got ${JSON.stringify(day)}).`);
    if (seen.has(day)) throw invalid(`openDays names weekday ${day} twice.`);
    seen.add(day);
  }
  if (!Number.isInteger(command.graceMinutes) || command.graceMinutes < 0 || command.graceMinutes > DOCK_LIMITS.graceMinutes) {
    throw invalid(`graceMinutes must be a whole number from 0 to ${DOCK_LIMITS.graceMinutes} (got ${String(command.graceMinutes)}).`);
  }
  return { slotMinutes: slot, opensMinute: opens, closesMinute: closes, openDays: maskOfOpenDays([...seen]), graceMinutes: command.graceMinutes };
}

/**
 * Story 2-3b — the warehouse's dock schedule (decision 3), a full
 * replacement on the guide §1 skeleton: `dock.manage` → replay → shape →
 * the warehouse → the `':dock-setup:'` advisory (A11) → replay under it →
 * the upsert. On an unconfigured warehouse it ALWAYS writes the row (even a
 * body equal to the defaults — `configured` becomes true, audited); on a
 * configured one a body equal to the stored row is the no-op arm (key
 * stored, no audit, no outbox — `AUDIT_NO_OP_ARMS`
 * `dockSchedule.put:unchanged`). Changing the schedule never moves or
 * refuses an existing appointment (decision 3). Audit target: the warehouse.
 */
@Injectable()
export class DockScheduleCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async put(command: PutDockScheduleCommand, idempotencyKey: string): Promise<DockScheduleSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'dock-schedule-put',
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      warehouseId: command.warehouseId,
      slotMinutes: command.slotMinutes,
      opensAt: command.opensAt,
      closesAt: command.closesAt,
      openDays: command.openDays,
      graceMinutes: command.graceMinutes,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'dock.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const next = normalizeSchedule(command);
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      await lockDockSetupInTx(tx, command.tenantId, command.warehouseId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      const current = await dockScheduleOfInTx(tx, command.tenantId, command.warehouseId);
      const same =
        current.slotMinutes === next.slotMinutes &&
        current.opensMinute === next.opensMinute &&
        current.closesMinute === next.closesMinute &&
        current.openDays === next.openDays &&
        current.graceMinutes === next.graceMinutes;
      if (current.configured && same) {
        const snapshot: DockScheduleSnapshot = { schedule: dockScheduleView(command.warehouseId, current) };
        await writeDockKeyInTx(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }
      const now = nowIso();
      await tx
        .insert(dockSchedules)
        .values({ id: uuidv7(), tenantId: command.tenantId, warehouseId: command.warehouseId, ...next, updatedBy: command.actorUserId })
        .onConflictDoUpdate({
          target: [dockSchedules.tenantId, dockSchedules.warehouseId],
          set: { ...next, updatedBy: command.actorUserId, updatedAt: now },
        });
      const stored = await dockScheduleOfInTx(tx, command.tenantId, command.warehouseId);
      const snapshot: DockScheduleSnapshot = { schedule: dockScheduleView(command.warehouseId, stored) };
      const before = dockScheduleView(command.warehouseId, current);
      const changes: Record<string, unknown> = {};
      for (const field of ['configured', 'slotMinutes', 'opensAt', 'closesAt', 'openDays', 'graceMinutes'] as const) {
        if (JSON.stringify(before[field]) !== JSON.stringify(snapshot.schedule[field])) {
          changes[field] = { before: before[field], after: snapshot.schedule[field] };
        }
      }
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'dock_schedule.updated',
        occurredAt: now,
        payload: { schedule: snapshot.schedule },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'dock_schedule.updated',
        targetType: 'warehouse',
        targetId: command.warehouseId,
        reference: idempotencyKey,
        changes,
        occurredAt: nowIso(),
      });
      await writeDockKeyInTx(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  private async replay(tx: TenantTx, tenantId: string, key: string, payloadHash: string): Promise<DockScheduleSnapshot | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
      .limit(1);
    const existing = rows[0];
    if (existing === undefined) return null;
    if (existing.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return existing.responseSnapshot as DockScheduleSnapshot;
  }
}
