import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { isIsoDate, istDaysBetween } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import {
  DockAppointmentCommand,
  appointmentNotFound,
  type BookDockAppointmentCommand,
  type CancelDockAppointmentCommand,
  type DockAppointmentSnapshot,
  type RescheduleDockAppointmentCommand,
} from './dock-appointment.command';
import { DockDoorCommand, type CreateDockDoorCommand, type DockDoorSnapshot, type UpdateDockDoorCommand } from './dock-door.command';
import { DockScheduleCommand, type DockScheduleSnapshot, type PutDockScheduleCommand } from './dock-schedule.command';
import {
  DOCK_LIMITS,
  dockAppointmentRowInTx,
  dockAppointmentViewInTx,
  dockClock,
  dockScheduleOfInTx,
  dockScheduleView,
  dockWindowInTx,
  listDockDoorsInTx,
  type DockAppointmentView,
  type DockDoorView,
  type DockScheduleView,
  type DockWindowQuery,
  type DockWindowView,
} from './dock.read';

/**
 * Story 2-3b — the dock's public seam (AD-6): the api shell's only way to the
 * door, schedule and appointment commands and reads. The four dock tables
 * are inbound-exclusive. Reads are open to every staff session (never
 * gated); a client-portal token is refused at `TenantSessionGuard`.
 */
@Injectable()
export class DockFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(DockDoorCommand) private readonly doors: DockDoorCommand,
    @Inject(DockScheduleCommand) private readonly schedules: DockScheduleCommand,
    @Inject(DockAppointmentCommand) private readonly appointments: DockAppointmentCommand,
  ) {}

  createDoor(command: CreateDockDoorCommand, idempotencyKey: string): Promise<DockDoorSnapshot> {
    return this.doors.create(command, idempotencyKey);
  }

  updateDoor(command: UpdateDockDoorCommand, idempotencyKey: string): Promise<DockDoorSnapshot> {
    return this.doors.update(command, idempotencyKey);
  }

  putSchedule(command: PutDockScheduleCommand, idempotencyKey: string): Promise<DockScheduleSnapshot> {
    return this.schedules.put(command, idempotencyKey);
  }

  book(command: BookDockAppointmentCommand, idempotencyKey: string): Promise<DockAppointmentSnapshot> {
    return this.appointments.book(command, idempotencyKey);
  }

  reschedule(command: RescheduleDockAppointmentCommand, idempotencyKey: string): Promise<DockAppointmentSnapshot> {
    return this.appointments.reschedule(command, idempotencyKey);
  }

  cancel(command: CancelDockAppointmentCommand, idempotencyKey: string): Promise<DockAppointmentSnapshot> {
    return this.appointments.cancel(command, idempotencyKey);
  }

  listDoors(tenantId: string, warehouseId: string): Promise<DockDoorView[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      return listDockDoorsInTx(tx, tenantId, warehouseId);
    });
  }

  schedule(tenantId: string, warehouseId: string): Promise<DockScheduleView> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, warehouseId);
      return dockScheduleView(warehouseId, await dockScheduleOfInTx(tx, tenantId, warehouseId));
    });
  }

  /** The calendar window — `from`/`to` inclusive IST dates, at most 7 days (400 otherwise). */
  window(tenantId: string, query: DockWindowQuery): Promise<DockWindowView> {
    for (const [field, value] of [['from', query.from], ['to', query.to]] as const) {
      if (!isIsoDate(value)) {
        throw new ProblemException('validation-failed', 400, 'Invalid window', `${field} must be a calendar date YYYY-MM-DD (got "${value.slice(0, 16)}").`);
      }
    }
    const span = istDaysBetween(query.from, query.to) + 1;
    if (span < 1) throw new ProblemException('validation-failed', 400, 'Invalid window', `to (${query.to}) is before from (${query.from}).`);
    if (span > DOCK_LIMITS.windowDays) {
      throw new ProblemException('validation-failed', 400, 'Invalid window', `The window spans ${span} days — at most ${DOCK_LIMITS.windowDays}.`);
    }
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      return dockWindowInTx(tx, tenantId, query, dockClock.now());
    });
  }

  appointment(tenantId: string, appointmentId: string): Promise<DockAppointmentView> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const row = await dockAppointmentRowInTx(tx, tenantId, appointmentId);
      if (row === null) throw appointmentNotFound();
      return dockAppointmentViewInTx(tx, row, dockClock.now());
    });
  }
}
