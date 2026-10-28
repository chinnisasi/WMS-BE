import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, dockAppointments, dockDoors, idempotencyKeys, type DockDoorRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { DOCK_LIMITS, DOOR_CODE_RE, dockClock, dockDoorView, type DockDoorView } from './dock.read';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const DOOR_CODE_UNIQUE = 'dock_doors_tenant_warehouse_code_unique';

export interface CreateDockDoorCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly name?: string | null | undefined;
}

export interface UpdateDockDoorCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly doorId: string;
  readonly code: string;
  readonly name?: string | null | undefined;
  readonly active: boolean;
}

export interface DockDoorSnapshot {
  readonly dockDoor: DockDoorView;
}

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid dock door', detail);
}

function doorNotFound(): ProblemException {
  return new ProblemException('not-found', 404, 'Dock door not found', 'No dock door with this id exists in this warehouse.');
}

function codeTaken(code: string): ProblemException {
  return new ProblemException(
    'dock-door-code-taken',
    409,
    'Dock door code taken',
    `Dock door "${code}" already exists in this warehouse (active or inactive) — pick another code, or reactivate that door.`,
  );
}

/** Decision 1 — the code uppercased and trimmed; the name trimmed, blank = null. */
export function normalizeDoor(input: { readonly code: unknown; readonly name?: unknown }): { code: string; name: string | null } {
  if (typeof input.code !== 'string') throw invalid('code must be text.');
  const code = input.code.trim().toUpperCase();
  if (!DOOR_CODE_RE.test(code)) {
    throw invalid(`code must be 1–${DOCK_LIMITS.doorCode} letters, digits or hyphens (got "${input.code.slice(0, 40)}").`);
  }
  if (input.name !== undefined && input.name !== null && typeof input.name !== 'string') throw invalid('name must be text.');
  const trimmed = typeof input.name === 'string' ? input.name.trim() : '';
  if ([...trimmed].length > DOCK_LIMITS.doorName) {
    throw invalid(`name is at most ${DOCK_LIMITS.doorName} characters (got ${[...trimmed].length}).`);
  }
  return { code, name: trimmed === '' ? null : trimmed };
}

/**
 * Story 2-3b — the dock-door master (decision 1): create a door, and replace
 * one in full (code, name, active). A door is never deleted. Both on the
 * guide §1 skeleton; hashes take the fields as received, with an `arm:`
 * discriminator.
 *
 * - **Create** serialises per warehouse on the `':dock-setup:'` advisory
 *   (A11) — so the 100-door count and the code check cannot race — and
 *   replays again under it.
 * - **Update** locks the door `FOR UPDATE`, replays under it, refuses a
 *   deactivation while the door has a `booked` appointment ending after now
 *   (409 `dock-door-has-appointments` — a plain read: the lock order is
 *   door → appointment, and nothing locks an appointment and then a door),
 *   and stores an unchanged body as a no-op (key stored, no audit, no
 *   outbox — `AUDIT_NO_OP_ARMS` `dockDoors.update:unchanged`).
 */
@Injectable()
export class DockDoorCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async create(command: CreateDockDoorCommand, idempotencyKey: string): Promise<DockDoorSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'dock-door-create',
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      warehouseId: command.warehouseId,
      code: command.code,
      name: command.name ?? undefined,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'dock.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const door = normalizeDoor(command);
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      // A11 — one door create or schedule put per warehouse at a time.
      await lockDockSetupInTx(tx, command.tenantId, command.warehouseId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      const existing = await tx
        .select({ code: dockDoors.code })
        .from(dockDoors)
        .where(and(eq(dockDoors.tenantId, command.tenantId), eq(dockDoors.warehouseId, command.warehouseId)));
      if (existing.length >= DOCK_LIMITS.doorsPerWarehouse) {
        throw new ProblemException(
          'dock-door-limit',
          409,
          'Dock door limit reached',
          `This warehouse already has ${existing.length} dock doors — at most ${DOCK_LIMITS.doorsPerWarehouse}. Reuse an inactive door instead.`,
        );
      }
      if (existing.some((row) => row.code === door.code)) throw codeTaken(door.code);
      const id = uuidv7();
      try {
        await tx.insert(dockDoors).values({
          id,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          code: door.code,
          name: door.name,
          active: true,
          createdBy: command.actorUserId,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, DOOR_CODE_UNIQUE)) throw codeTaken(door.code);
        throw err;
      }
      const snapshot: DockDoorSnapshot = { dockDoor: dockDoorView(await this.doorRow(tx, command.tenantId, id)) };
      await this.finish(tx, command, idempotencyKey, payloadHash, snapshot, 'dock_door.created');
      return snapshot;
    });
  }

  async update(command: UpdateDockDoorCommand, idempotencyKey: string): Promise<DockDoorSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'dock-door-update',
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      warehouseId: command.warehouseId,
      doorId: command.doorId,
      code: command.code,
      name: command.name ?? undefined,
      active: command.active,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'dock.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const door = normalizeDoor(command);
      if (typeof command.active !== 'boolean') throw invalid('active must be true or false.');
      const current = await this.lockDoor(tx, command.tenantId, command.warehouseId, command.doorId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (current.code === door.code && current.name === door.name && current.active === command.active) {
        // The no-op arm: nothing changes — the key stored, no audit, no outbox.
        const snapshot: DockDoorSnapshot = { dockDoor: dockDoorView(current) };
        await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }
      if (current.active && !command.active) {
        // A plain read (door → appointment is the lock order; the door lock
        // already serialises every booking on this door).
        const busy = await tx
          .select({ code: dockAppointments.code, n: sql<number>`count(*) over ()::int` })
          .from(dockAppointments)
          .where(
            and(
              eq(dockAppointments.tenantId, command.tenantId),
              eq(dockAppointments.dockDoorId, current.id),
              eq(dockAppointments.status, 'booked'),
              gt(dockAppointments.endsAt, new Date(dockClock.now()).toISOString()),
            ),
          )
          .orderBy(asc(dockAppointments.startsAt), asc(dockAppointments.id))
          .limit(1);
        const first = busy[0];
        if (first !== undefined) {
          throw new ProblemException(
            'dock-door-has-appointments',
            409,
            'Dock door has appointments',
            `Dock door "${current.code}" has ${first.n} booked appointment${first.n === 1 ? '' : 's'} still to come (first ${first.code}) — reschedule or cancel ${first.n === 1 ? 'it' : 'them'} before deactivating the door.`,
            { appointmentCount: first.n, firstAppointmentCode: first.code },
          );
        }
      }
      if (door.code !== current.code) {
        const taken = await tx
          .select({ id: dockDoors.id })
          .from(dockDoors)
          .where(and(eq(dockDoors.tenantId, command.tenantId), eq(dockDoors.warehouseId, current.warehouseId), eq(dockDoors.code, door.code)))
          .limit(1);
        if (taken.length > 0) throw codeTaken(door.code);
      }
      try {
        await tx
          .update(dockDoors)
          .set({ code: door.code, name: door.name, active: command.active, updatedAt: nowIso() })
          .where(eq(dockDoors.id, current.id));
      } catch (err) {
        if (isUniqueViolationOn(err, DOOR_CODE_UNIQUE)) throw codeTaken(door.code);
        throw err;
      }
      const after = await this.doorRow(tx, command.tenantId, current.id);
      const snapshot: DockDoorSnapshot = { dockDoor: dockDoorView(after) };
      const changes: Record<string, unknown> = {};
      if (current.code !== after.code) changes.code = { before: current.code, after: after.code };
      if (current.name !== after.name) changes.name = { before: current.name, after: after.name };
      if (current.active !== after.active) changes.active = { before: current.active, after: after.active };
      await this.finish(tx, command, idempotencyKey, payloadHash, snapshot, 'dock_door.updated', changes);
      return snapshot;
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /** Lock the door `FOR UPDATE` — lock, 404 when absent or another warehouse's; nothing else (guide §1). */
  private async lockDoor(tx: TenantTx, tenantId: string, warehouseId: string, doorId: string): Promise<DockDoorRow> {
    if (!UUID_RE.test(doorId)) throw doorNotFound();
    const rows = await tx
      .select()
      .from(dockDoors)
      .where(and(eq(dockDoors.tenantId, tenantId), eq(dockDoors.id, doorId)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (row === undefined || row.warehouseId !== warehouseId) throw doorNotFound();
    return row;
  }

  private async doorRow(tx: TenantTx, tenantId: string, doorId: string): Promise<DockDoorRow> {
    const rows = await tx
      .select()
      .from(dockDoors)
      .where(and(eq(dockDoors.tenantId, tenantId), eq(dockDoors.id, doorId)))
      .limit(1);
    return rows[0]!;
  }

  private async replay(tx: TenantTx, tenantId: string, key: string, payloadHash: string): Promise<DockDoorSnapshot | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
      .limit(1);
    const existing = rows[0];
    if (existing === undefined) return null;
    if (existing.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return existing.responseSnapshot as DockDoorSnapshot;
  }

  /** Steps 9–11: the outbox event, the audit row, the key LAST. */
  private async finish(
    tx: TenantTx,
    command: { readonly tenantId: string; readonly actorUserId: string },
    idempotencyKey: string,
    payloadHash: string,
    snapshot: DockDoorSnapshot,
    action: 'dock_door.created' | 'dock_door.updated',
    changes?: Record<string, unknown>,
  ): Promise<void> {
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId: command.tenantId,
      type: action,
      occurredAt: nowIso(),
      payload: { dockDoor: snapshot.dockDoor },
    });
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      action,
      targetType: 'dock_door',
      targetId: snapshot.dockDoor.id,
      reference: idempotencyKey,
      ...(changes === undefined ? {} : { changes }),
      occurredAt: nowIso(),
    });
    await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
  }

  private async writeKey(tx: TenantTx, tenantId: string, key: string, payloadHash: string, snapshot: unknown): Promise<void> {
    await writeDockKeyInTx(tx, tenantId, key, payloadHash, snapshot);
  }
}

/** A11 — the per-warehouse dock setup advisory (door create, schedule put). */
export async function lockDockSetupInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':dock-setup:' || ${warehouseId}, 0))`);
}

/** The idempotency key LAST — a unique violation is a concurrent same-key request. */
export async function writeDockKeyInTx(tx: TenantTx, tenantId: string, key: string, payloadHash: string, snapshot: unknown): Promise<void> {
  try {
    await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key, payloadHash, responseSnapshot: snapshot });
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
