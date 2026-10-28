import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  advanceShipmentNotices,
  auditEvents,
  dockAppointmentDocuments,
  dockAppointments,
  dockDoors,
  idempotencyKeys,
  purchaseOrders,
  type DockAppointmentRow,
  type DockDoorRow,
} from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { isInstant } from '../../shared/primitives/instant-range';
import { IST_OFFSET_MS, addIsoDays, canonicalInstant, istDateOf, istMinuteOfDay, istWeekdayOf, nowIso } from '../../shared/primitives/time';
import { VEHICLE_NO_RE, normalizeVehicleNo } from '../../shared/primitives/vehicle';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { ASN_OPEN_STATUSES, PO_OPEN_STATUSES } from './client-wind-down';
import { writeDockKeyInTx } from './dock-door.command';
import {
  DOCK_LIMITS,
  currentSlotStartMs,
  dockAppointmentViewInTx,
  dockClock,
  dockScheduleOfInTx,
  isNoShow,
  isOpenDay,
  minuteToHhmm,
  outboxAppointment,
  type DockAppointmentView,
  type DockScheduleRules,
} from './dock.read';
import { documentWarehouseMismatch } from './receiving.command';

const APPOINTMENT_CODE_UNIQUE = 'dock_appointments_tenant_code_unique';
const MINUTE_MS = 60_000;
const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ── command inputs ────────────────────────────────────────────────────────────

export interface DockAppointmentDocumentInput {
  readonly poId?: string | null | undefined;
  readonly asnId?: string | null | undefined;
}

/** What a booking carries, and a reschedule replaces in full (decision 7). */
export interface DockAppointmentFields {
  readonly dockDoorId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly documents?: readonly DockAppointmentDocumentInput[] | null | undefined;
  readonly vehicleNo?: string | null | undefined;
  readonly transporterName?: string | null | undefined;
  readonly note?: string | null | undefined;
}

export interface BookDockAppointmentCommand extends DockAppointmentFields {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
}

export interface RescheduleDockAppointmentCommand extends DockAppointmentFields {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly appointmentId: string;
}

export interface CancelDockAppointmentCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly appointmentId: string;
  readonly reason: string;
}

export interface DockAppointmentSnapshot {
  readonly appointment: DockAppointmentView;
}

// ── problems (shared with the gate-in link) ──────────────────────────────────

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid dock appointment', detail);
}

export function appointmentNotFound(): ProblemException {
  return new ProblemException('not-found', 404, 'Dock appointment not found', 'No dock appointment with this id exists in this tenant.');
}

export function appointmentClosed(row: Pick<DockAppointmentRow, 'code' | 'status'>, detail?: string): ProblemException {
  return new ProblemException(
    'appointment-closed',
    409,
    'Dock appointment is closed',
    detail ?? `Dock appointment "${row.code}" is ${row.status} — it can no longer be rescheduled or cancelled.`,
    { appointmentStatus: row.status },
  );
}

function doorNotFound(): ProblemException {
  return new ProblemException('not-found', 404, 'Dock door not found', 'No dock door with this id exists in this tenant.');
}

/** "10:30–11:30 IST on 2026-10-29" — the window as a desk reads it. */
export function windowLabel(startsAt: string, endsAt: string): string {
  return `${minuteToHhmm(istMinuteOfDay(startsAt))}–${minuteToHhmm(istMinuteOfDay(startsAt) + (Date.parse(endsAt) - Date.parse(startsAt)) / MINUTE_MS)} IST on ${istDateOf(startsAt)}`;
}

// ── the shape (behind the replay lookup) ──────────────────────────────────────

interface NormalizedDocument {
  readonly kind: 'po' | 'asn';
  readonly id: string;
}

interface NormalizedFields {
  readonly dockDoorId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly documents: readonly NormalizedDocument[];
  readonly vehicleNo: string | null;
  readonly transporterName: string | null;
  readonly note: string | null;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalid(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if ([...trimmed].length > max) throw invalid(`${field} is at most ${max} characters (got ${[...trimmed].length}).`);
  return trimmed;
}

function instantField(value: unknown, field: string): string {
  if (!isInstant(value)) {
    throw invalid(`${field} must be an ISO-8601 instant with a zone designator (got "${String(value).slice(0, 64)}").`);
  }
  return canonicalInstant(value);
}

function normalizeFields(input: DockAppointmentFields): NormalizedFields {
  if (typeof input.dockDoorId !== 'string' || !UUID_RE.test(input.dockDoorId)) throw invalid('dockDoorId must be a uuid.');
  const startsAt = instantField(input.startsAt, 'startsAt');
  const endsAt = instantField(input.endsAt, 'endsAt');
  const duration = Date.parse(endsAt) - Date.parse(startsAt);
  if (duration <= 0) throw invalid(`endsAt (${endsAt}) must be after startsAt (${startsAt}).`);
  if (duration > DOCK_LIMITS.slotsPerAppointment * 60 * MINUTE_MS) {
    throw invalid(`An appointment spans at most ${DOCK_LIMITS.slotsPerAppointment} slots (got ${duration / MINUTE_MS} minutes).`);
  }
  const documentsInput = input.documents ?? [];
  if (!Array.isArray(documentsInput)) throw invalid('documents must be a list.');
  if (documentsInput.length > DOCK_LIMITS.documents) {
    throw invalid(`An appointment carries at most ${DOCK_LIMITS.documents} documents (got ${documentsInput.length}).`);
  }
  const seen = new Set<string>();
  const documents = documentsInput.map((doc, index): NormalizedDocument => {
    const row = `Document ${index + 1}`;
    const poId = doc?.poId === null || doc?.poId === undefined || doc.poId === '' ? null : String(doc.poId);
    const asnId = doc?.asnId === null || doc?.asnId === undefined || doc.asnId === '' ? null : String(doc.asnId);
    if ((poId === null) === (asnId === null)) throw invalid(`${row}: name exactly one purchase order (poId) or one ASN (asnId).`);
    const id = (poId ?? asnId)!;
    if (!UUID_RE.test(id)) throw invalid(`${row}: ${poId !== null ? 'poId' : 'asnId'} must be a uuid.`);
    const kind = poId !== null ? 'po' : 'asn';
    const key = `${kind}|${id.toLowerCase()}`;
    if (seen.has(key)) throw invalid(`${row} repeats a ${kind === 'po' ? 'purchase order' : 'ASN'} already on this appointment.`);
    seen.add(key);
    return { kind, id: id.toLowerCase() };
  });
  const vehicleNo = normalizeVehicleNo(typeof input.vehicleNo === 'string' ? input.vehicleNo : null);
  if (input.vehicleNo !== null && input.vehicleNo !== undefined && typeof input.vehicleNo !== 'string') throw invalid('vehicleNo must be text.');
  if (vehicleNo !== null && !VEHICLE_NO_RE.test(vehicleNo)) {
    throw invalid(`vehicleNo must be 4–15 letters and digits; spaces, dots and hyphens are ignored (got "${String(input.vehicleNo).slice(0, 40)}").`);
  }
  return {
    dockDoorId: input.dockDoorId.toLowerCase(),
    startsAt,
    endsAt,
    documents,
    vehicleNo,
    transporterName: optionalText(input.transporterName, 'transporterName', DOCK_LIMITS.transporterName),
    note: optionalText(input.note, 'note', DOCK_LIMITS.note),
  };
}

/** The fields hashed AS RECEIVED (absent and null hash alike), in a fixed order. */
function hashedFields(input: DockAppointmentFields): Record<string, unknown> {
  return {
    dockDoorId: input.dockDoorId,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    documents: (input.documents ?? []).map((doc) => (doc?.poId !== null && doc?.poId !== undefined ? { poId: doc.poId } : { asnId: doc?.asnId ?? undefined })),
    vehicleNo: input.vehicleNo ?? undefined,
    transporterName: input.transporterName ?? undefined,
    note: input.note ?? undefined,
  };
}

/**
 * Decision 4 and A7 — the window against the schedule and the clock:
 * on the IST slot grid (400 `slot-misaligned`), 1–8 whole slots (400
 * `slot-misaligned` / `validation-failed`), not before the current slot (400
 * `slot-in-past`), not past 90 IST days ahead (400 `slot-too-far`), on an
 * open IST day and inside its hours (409 `dock-closed`). So a booking never
 * crosses IST midnight.
 */
export function assertBookableWindow(rules: DockScheduleRules, startsAt: string, endsAt: string, nowMs: number): void {
  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);
  const slotMs = rules.slotMinutes * MINUTE_MS;
  const startMin = istMinuteOfDay(startsAt);
  if ((startMs + IST_OFFSET_MS) % slotMs !== 0) {
    throw new ProblemException(
      'slot-misaligned',
      400,
      'Slot misaligned',
      `${minuteToHhmm(startMin)} IST is not on this warehouse's ${rules.slotMinutes}-minute slot grid — start on a slot boundary.`,
    );
  }
  const duration = endMs - startMs;
  if (duration % slotMs !== 0) {
    throw new ProblemException(
      'slot-misaligned',
      400,
      'Slot misaligned',
      `The appointment lasts ${duration / MINUTE_MS} minutes — book whole ${rules.slotMinutes}-minute slots.`,
    );
  }
  const slots = duration / slotMs;
  if (slots > DOCK_LIMITS.slotsPerAppointment) {
    throw invalid(`An appointment spans 1 to ${DOCK_LIMITS.slotsPerAppointment} slots (got ${slots} of ${rules.slotMinutes} minutes).`);
  }
  if (startMs < currentSlotStartMs(nowMs, rules.slotMinutes)) {
    throw new ProblemException(
      'slot-in-past',
      400,
      'Slot in the past',
      `${windowLabel(startsAt, endsAt)} has already begun or passed — book the current slot or a later one.`,
    );
  }
  const today = istDateOf(new Date(nowMs).toISOString());
  const date = istDateOf(startsAt);
  const latest = addIsoDays(today, DOCK_LIMITS.daysAhead);
  if (date > latest) {
    throw new ProblemException(
      'slot-too-far',
      400,
      'Slot too far ahead',
      `${date} is more than ${DOCK_LIMITS.daysAhead} days ahead — book on or before ${latest}.`,
    );
  }
  if (!isOpenDay(rules, date)) {
    throw new ProblemException('dock-closed', 409, 'Dock closed', `The dock is closed on ${WEEKDAYS[istWeekdayOf(date)]} (${date}).`);
  }
  const endMin = startMin + duration / MINUTE_MS;
  if (startMin < rules.opensMinute || endMin > rules.closesMinute) {
    throw new ProblemException(
      'dock-closed',
      409,
      'Dock closed',
      `${windowLabel(startsAt, endsAt)} is outside the dock's hours (${minuteToHhmm(rules.opensMinute)}–${minuteToHhmm(rules.closesMinute)} IST).`,
    );
  }
}

const sameDocuments = (a: readonly NormalizedDocument[], b: readonly NormalizedDocument[]): boolean =>
  JSON.stringify([...a].map((d) => `${d.kind}|${d.id}`).sort()) === JSON.stringify([...b].map((d) => `${d.kind}|${d.id}`).sort());

/**
 * Story 2-3b — the dock appointment's three verbs, each on the guide §1
 * skeleton (hash discriminators `arm: dock-appointment-book | -reschedule |
 * -cancel`; fields as received):
 *
 * - **book** — `dock.schedule` → replay → shape → warehouse → the schedule
 *   (row or defaults) → the bounds (decision 4) → lock the door `FOR UPDATE`
 *   (404) → replay under the lock → the door's guards (another warehouse,
 *   inactive) → the bounded overlap read (A16, 409 `dock-slot-taken`) → each
 *   document (404, `document-warehouse-mismatch`, `po-not-open` /
 *   `asn-not-open` — A17) → the client stamp → `DA-<n>` → insert.
 * - **reschedule** — a full replacement while `booked`: read the appointment
 *   unlocked → lock {its door, the new door} by id → lock the appointment →
 *   replay → the locked set re-checked (A4, 409 `conflict`) → closed / no-show
 *   → only what changed is re-checked (A5): the door and window (A3's door
 *   guards, the bounds, the overlap, the grace re-frozen), the documents and
 *   the client re-stamp (A10). An unchanged body is the no-op arm.
 * - **cancel** — lock the appointment alone → replay → closed / no-show →
 *   `cancelled` (the slot frees).
 *
 * Lock order: door(s) by id → appointment. The gate-in takes gate-in →
 * appointment(s); nothing locks an appointment and then a door or a gate-in.
 * The note never rides an outbox payload (A15 — `outboxAppointment`).
 */
@Injectable()
export class DockAppointmentCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async book(command: BookDockAppointmentCommand, idempotencyKey: string): Promise<DockAppointmentSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'dock-appointment-book',
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      warehouseId: command.warehouseId,
      ...hashedFields(command),
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'dock.schedule');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const fields = normalizeFields(command);
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      const rules = await dockScheduleOfInTx(tx, command.tenantId, command.warehouseId);
      const nowMs = dockClock.now();
      assertBookableWindow(rules, fields.startsAt, fields.endsAt, nowMs);
      const [door] = await this.lockDoors(tx, command.tenantId, [fields.dockDoorId]);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      this.assertDoorBookable(door, command.warehouseId);
      await this.assertNoOverlap(tx, command.tenantId, door!, fields.startsAt, fields.endsAt, null);
      const clientId = await this.assertDocumentsInTx(tx, command.tenantId, command.warehouseId, fields.documents);
      const id = uuidv7();
      const code = await this.allocateCode(tx, command.tenantId);
      try {
        await tx.insert(dockAppointments).values({
          id,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          code,
          status: 'booked',
          dockDoorId: door!.id,
          startsAt: fields.startsAt,
          endsAt: fields.endsAt,
          graceMinutes: rules.graceMinutes,
          clientId,
          vehicleNo: fields.vehicleNo,
          transporterName: fields.transporterName,
          note: fields.note,
          bookedBy: command.actorUserId,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, APPOINTMENT_CODE_UNIQUE)) {
          throw new ProblemException('conflict', 409, 'Appointment code taken', `Dock appointment code "${code}" was taken concurrently — retry.`);
        }
        throw err;
      }
      await this.insertDocumentsInTx(tx, command.tenantId, id, fields.documents);
      const snapshot: DockAppointmentSnapshot = { appointment: await this.viewOf(tx, command.tenantId, id, nowMs) };
      await this.finish(tx, command, idempotencyKey, payloadHash, snapshot, 'dock_appointment.booked');
      return snapshot;
    });
  }

  async reschedule(command: RescheduleDockAppointmentCommand, idempotencyKey: string): Promise<DockAppointmentSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'dock-appointment-reschedule',
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      appointmentId: command.appointmentId,
      ...hashedFields(command),
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'dock.schedule');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const fields = normalizeFields(command);
      // A4 — read unlocked, lock {its door, the new door} by id, then the appointment.
      const unlocked = await this.appointmentRow(tx, command.tenantId, command.appointmentId, false);
      const lockedDoors = await this.lockDoors(tx, command.tenantId, [unlocked.dockDoorId, fields.dockDoorId]);
      const current = await this.appointmentRow(tx, command.tenantId, command.appointmentId, true);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (!lockedDoors.some((door) => door?.id === current.dockDoorId)) {
        throw new ProblemException(
          'conflict',
          409,
          'Appointment moved concurrently',
          `${current.code} was moved concurrently — reload and retry.`,
        );
      }
      const nowMs = dockClock.now();
      this.assertOpen(current, nowMs);
      const currentDocuments = await this.documentsOf(tx, command.tenantId, current.id);
      const startsAt = canonicalInstant(current.startsAt);
      const endsAt = canonicalInstant(current.endsAt);
      const moved = fields.dockDoorId !== current.dockDoorId || fields.startsAt !== startsAt || fields.endsAt !== endsAt;
      const documentsChanged = !sameDocuments(currentDocuments, fields.documents);
      const detailsChanged =
        fields.vehicleNo !== current.vehicleNo || fields.transporterName !== current.transporterName || fields.note !== current.note;
      if (!moved && !documentsChanged && !detailsChanged) {
        // The no-op arm: nothing changes — the key stored, no audit, no outbox.
        const snapshot: DockAppointmentSnapshot = { appointment: await this.viewOf(tx, command.tenantId, current.id, nowMs) };
        await writeDockKeyInTx(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }
      let graceMinutes = current.graceMinutes;
      let newDoor: DockDoorRow | undefined;
      if (moved) {
        // A3 — the new door gets book's checks (a move within the same door skips nothing).
        newDoor = lockedDoors.find((door) => door?.id === fields.dockDoorId);
        this.assertDoorBookable(newDoor, current.warehouseId);
        const rules = await dockScheduleOfInTx(tx, command.tenantId, current.warehouseId);
        assertBookableWindow(rules, fields.startsAt, fields.endsAt, nowMs);
        await this.assertNoOverlap(tx, command.tenantId, newDoor!, fields.startsAt, fields.endsAt, current.id);
        graceMinutes = rules.graceMinutes;
      }
      let clientId = current.clientId;
      if (documentsChanged) {
        clientId = await this.assertDocumentsInTx(tx, command.tenantId, current.warehouseId, fields.documents);
      }
      const before = await this.viewOf(tx, command.tenantId, current.id, nowMs);
      await tx
        .update(dockAppointments)
        .set({
          dockDoorId: fields.dockDoorId,
          startsAt: fields.startsAt,
          endsAt: fields.endsAt,
          graceMinutes,
          clientId,
          vehicleNo: fields.vehicleNo,
          transporterName: fields.transporterName,
          note: fields.note,
          updatedAt: nowIso(),
        })
        .where(eq(dockAppointments.id, current.id));
      if (documentsChanged) {
        await tx
          .delete(dockAppointmentDocuments)
          .where(and(eq(dockAppointmentDocuments.tenantId, command.tenantId), eq(dockAppointmentDocuments.appointmentId, current.id)));
        await this.insertDocumentsInTx(tx, command.tenantId, current.id, fields.documents);
      }
      const snapshot: DockAppointmentSnapshot = { appointment: await this.viewOf(tx, command.tenantId, current.id, nowMs) };
      const after = snapshot.appointment;
      const changes: Record<string, unknown> = {};
      const compare = (field: string, a: unknown, b: unknown): void => {
        if (JSON.stringify(a) !== JSON.stringify(b)) changes[field] = { before: a, after: b };
      };
      compare('door', before.doorCode, after.doorCode);
      compare('startsAt', before.startsAt, after.startsAt);
      compare('endsAt', before.endsAt, after.endsAt);
      compare('graceMinutes', before.graceMinutes, after.graceMinutes);
      compare(
        'documents',
        before.documents.map((doc) => `${doc.kind} ${doc.code ?? doc.id}`),
        after.documents.map((doc) => `${doc.kind} ${doc.code ?? doc.id}`),
      );
      // A10 — the client stamp re-derived with the documents.
      compare('client', before.clientId, after.clientId);
      compare('vehicleNo', before.vehicleNo, after.vehicleNo);
      compare('transporterName', before.transporterName, after.transporterName);
      // The note may carry personal data (A15): its change is recorded, not its text.
      if (before.note !== after.note) changes.note = { changed: true };
      await this.finish(tx, command, idempotencyKey, payloadHash, snapshot, 'dock_appointment.rescheduled', changes);
      return snapshot;
    });
  }

  async cancel(command: CancelDockAppointmentCommand, idempotencyKey: string): Promise<DockAppointmentSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'dock-appointment-cancel',
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      appointmentId: command.appointmentId,
      reason: command.reason,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'dock.schedule');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const reason = optionalText(command.reason, 'reason', DOCK_LIMITS.cancelReason);
      if (reason === null) throw invalid('reason is required — say why the appointment is cancelled (1–200 characters).');
      const current = await this.appointmentRow(tx, command.tenantId, command.appointmentId, true);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      const nowMs = dockClock.now();
      this.assertOpen(current, nowMs);
      const cancelledAt = new Date(nowMs).toISOString();
      await tx
        .update(dockAppointments)
        .set({ status: 'cancelled', cancelledAt, cancelledBy: command.actorUserId, cancelReason: reason, updatedAt: nowIso() })
        .where(and(eq(dockAppointments.id, current.id), eq(dockAppointments.status, 'booked')));
      const snapshot: DockAppointmentSnapshot = { appointment: await this.viewOf(tx, command.tenantId, current.id, nowMs) };
      await this.finish(tx, command, idempotencyKey, payloadHash, snapshot, 'dock_appointment.cancelled');
      return snapshot;
    });
  }

  // ── guards ──────────────────────────────────────────────────────────────

  /** Decision 7 — arrived and cancelled are closed; a no-show is final for the schedule. */
  private assertOpen(row: DockAppointmentRow, nowMs: number): void {
    if (row.status !== 'booked') throw appointmentClosed(row);
    if (isNoShow(row.status, canonicalInstant(row.endsAt), row.graceMinutes, nowMs)) {
      throw new ProblemException(
        'appointment-no-show',
        409,
        'Dock appointment is a no-show',
        `Dock appointment "${row.code}" (${windowLabel(canonicalInstant(row.startsAt), canonicalInstant(row.endsAt))}) passed its window and grace without an arrival — it is a no-show and stays on the record. Book a new appointment instead.`,
      );
    }
  }

  private assertDoorBookable(door: DockDoorRow | undefined, warehouseId: string): void {
    if (door === undefined) throw doorNotFound();
    if (door.warehouseId !== warehouseId) {
      throw new ProblemException(
        'dock-door-warehouse-mismatch',
        409,
        'Dock door is another warehouse’s',
        `Dock door "${door.code}" belongs to another warehouse — book a door of this warehouse.`,
      );
    }
    if (!door.active) {
      throw new ProblemException('dock-door-inactive', 409, 'Dock door is inactive', `Dock door "${door.code}" is inactive — reactivate it in Settings → Warehouses, or book another door.`);
    }
  }

  /**
   * A16 — the bounded overlap read on `(tenant_id, dock_door_id, starts_at)`:
   * a non-cancelled appointment of the door starting within the 8-hour CHECK
   * ceiling before `start` and before `end`, ending after `start` (an arrived
   * one keeps its slot). Run under the door lock, so two books of one door
   * serialise here.
   */
  private async assertNoOverlap(
    tx: TenantTx,
    tenantId: string,
    door: DockDoorRow,
    startsAt: string,
    endsAt: string,
    excludeId: string | null,
  ): Promise<void> {
    const rows = await tx
      .select({ id: dockAppointments.id, code: dockAppointments.code, startsAt: dockAppointments.startsAt, endsAt: dockAppointments.endsAt })
      .from(dockAppointments)
      .where(
        and(
          eq(dockAppointments.tenantId, tenantId),
          eq(dockAppointments.dockDoorId, door.id),
          ne(dockAppointments.status, 'cancelled'),
          sql`${dockAppointments.startsAt} > ${startsAt}::timestamptz - interval '8 hours'`,
          sql`${dockAppointments.startsAt} < ${endsAt}::timestamptz`,
          sql`${dockAppointments.endsAt} > ${startsAt}::timestamptz`,
          excludeId === null ? undefined : ne(dockAppointments.id, excludeId),
        ),
      )
      .orderBy(asc(dockAppointments.startsAt), asc(dockAppointments.id))
      .limit(1);
    const clash = rows[0];
    if (clash !== undefined) {
      const clashStarts = canonicalInstant(clash.startsAt);
      const clashEnds = canonicalInstant(clash.endsAt);
      throw new ProblemException(
        'dock-slot-taken',
        409,
        'Dock slot taken',
        `Dock door "${door.code}" is booked ${windowLabel(clashStarts, clashEnds)} by ${clash.code} — pick another door or time.`,
        { clash: { id: clash.id, code: clash.code, startsAt: clashStarts, endsAt: clashEnds } },
      );
    }
  }

  /**
   * Each document, in request order: exists in the tenant (404), is this
   * warehouse's (409 `document-warehouse-mismatch`), and is open — a PO
   * `open`, an ASN `announced` or `partially_received` (409 `po-not-open` /
   * `asn-not-open`, A17). Plain reads. Returns the client stamp: the one
   * client every document names, else null (decision 6).
   */
  private async assertDocumentsInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    documents: readonly NormalizedDocument[],
  ): Promise<string | null> {
    if (documents.length === 0) return null;
    const poIds = documents.filter((doc) => doc.kind === 'po').map((doc) => doc.id);
    const asnIds = documents.filter((doc) => doc.kind === 'asn').map((doc) => doc.id);
    const pos =
      poIds.length === 0
        ? []
        : await tx
            .select({ id: purchaseOrders.id, code: purchaseOrders.code, warehouseId: purchaseOrders.warehouseId, status: purchaseOrders.status, clientId: purchaseOrders.clientId })
            .from(purchaseOrders)
            .where(and(eq(purchaseOrders.tenantId, tenantId), inArray(purchaseOrders.id, poIds)));
    const asns =
      asnIds.length === 0
        ? []
        : await tx
            .select({
              id: advanceShipmentNotices.id,
              code: advanceShipmentNotices.asnCode,
              warehouseId: advanceShipmentNotices.warehouseId,
              status: advanceShipmentNotices.status,
              clientId: advanceShipmentNotices.clientId,
            })
            .from(advanceShipmentNotices)
            .where(and(eq(advanceShipmentNotices.tenantId, tenantId), inArray(advanceShipmentNotices.id, asnIds)));
    const poOf = new Map(pos.map((row) => [row.id, row]));
    const asnOf = new Map(asns.map((row) => [row.id, row]));
    const clients = new Set<string>();
    for (const doc of documents) {
      if (doc.kind === 'po') {
        const po = poOf.get(doc.id);
        if (po === undefined) {
          throw new ProblemException('not-found', 404, 'Purchase order not found', `No purchase order with id "${doc.id}" exists in this tenant.`);
        }
        if (po.warehouseId !== warehouseId) throw documentWarehouseMismatch(`Purchase order "${po.code}"`);
        if (!(PO_OPEN_STATUSES as readonly string[]).includes(po.status)) {
          throw new ProblemException(
            'po-not-open',
            409,
            'Purchase order is not open',
            `Purchase order "${po.code}" is ${po.status} — only an open PO can be booked onto a dock appointment.`,
          );
        }
        clients.add(po.clientId);
      } else {
        const asn = asnOf.get(doc.id);
        if (asn === undefined) {
          throw new ProblemException('not-found', 404, 'Advance shipment notice not found', `No advance shipment notice with id "${doc.id}" exists in this tenant.`);
        }
        if (asn.warehouseId !== warehouseId) throw documentWarehouseMismatch(`Advance shipment notice "${asn.code}"`);
        if (!(ASN_OPEN_STATUSES as readonly string[]).includes(asn.status)) {
          throw new ProblemException(
            'asn-not-open',
            409,
            'Advance shipment notice is not open',
            `Advance shipment notice "${asn.code}" is ${asn.status} — only an announced or partially received ASN can be booked onto a dock appointment.`,
          );
        }
        clients.add(asn.clientId);
      }
    }
    return clients.size === 1 ? [...clients][0]! : null;
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /** Lock the named doors `FOR UPDATE` in id order (the lock order) — absent ones are simply missing. */
  private async lockDoors(tx: TenantTx, tenantId: string, doorIds: readonly string[]): Promise<(DockDoorRow | undefined)[]> {
    const ids = [...new Set(doorIds.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase()))].sort();
    const rows =
      ids.length === 0
        ? []
        : await tx
            .select()
            .from(dockDoors)
            .where(and(eq(dockDoors.tenantId, tenantId), inArray(dockDoors.id, ids)))
            .orderBy(asc(dockDoors.id))
            .for('update');
    const byId = new Map(rows.map((row) => [row.id, row]));
    return doorIds.map((id) => byId.get(id.toLowerCase()));
  }

  /** The appointment row — `FOR UPDATE` when `lock` — 404 when absent; nothing else (guide §1). */
  private async appointmentRow(tx: TenantTx, tenantId: string, appointmentId: string, lock: boolean): Promise<DockAppointmentRow> {
    if (!UUID_RE.test(appointmentId)) throw appointmentNotFound();
    const query = tx
      .select()
      .from(dockAppointments)
      .where(and(eq(dockAppointments.tenantId, tenantId), eq(dockAppointments.id, appointmentId)))
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    const row = rows[0];
    if (row === undefined) throw appointmentNotFound();
    return row;
  }

  private async documentsOf(tx: TenantTx, tenantId: string, appointmentId: string): Promise<NormalizedDocument[]> {
    const rows = await tx
      .select({ poId: dockAppointmentDocuments.poId, asnId: dockAppointmentDocuments.asnId })
      .from(dockAppointmentDocuments)
      .where(and(eq(dockAppointmentDocuments.tenantId, tenantId), eq(dockAppointmentDocuments.appointmentId, appointmentId)))
      .orderBy(asc(dockAppointmentDocuments.position));
    return rows.map((row) => (row.poId !== null ? { kind: 'po' as const, id: row.poId } : { kind: 'asn' as const, id: row.asnId! }));
  }

  private async insertDocumentsInTx(tx: TenantTx, tenantId: string, appointmentId: string, documents: readonly NormalizedDocument[]): Promise<void> {
    if (documents.length === 0) return;
    await tx.insert(dockAppointmentDocuments).values(
      documents.map((doc, position) => ({
        id: uuidv7(),
        tenantId,
        appointmentId,
        position,
        poId: doc.kind === 'po' ? doc.id : null,
        asnId: doc.kind === 'asn' ? doc.id : null,
      })),
    );
  }

  private async viewOf(tx: TenantTx, tenantId: string, appointmentId: string, nowMs: number): Promise<DockAppointmentView> {
    const row = await this.appointmentRow(tx, tenantId, appointmentId, false);
    return dockAppointmentViewInTx(tx, row, nowMs);
  }

  /**
   * Decision 14 — the next `DA-<n>` under the tenant's `':dock-appointment-seq'`
   * advisory (the `allocateGateInCode` copy): only `DA-<digits>` codes take
   * the max, the digits bounded at 9; the unique `(tenant, code)` index is
   * the race backstop.
   */
  private async allocateCode(tx: TenantTx, tenantId: string): Promise<string> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':dock-appointment-seq', 0))`);
    const headRows = await tx
      .select({ n: sql<number>`coalesce(max(substring(code from '^DA-([0-9]{1,9})$')::int), 0)` })
      .from(dockAppointments)
      .where(eq(dockAppointments.tenantId, tenantId));
    const next = (headRows[0]?.n ?? 0) + 1;
    return `DA-${String(next).padStart(4, '0')}`;
  }

  private async replay(tx: TenantTx, tenantId: string, key: string, payloadHash: string): Promise<DockAppointmentSnapshot | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
      .limit(1);
    const existing = rows[0];
    if (existing === undefined) return null;
    if (existing.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return existing.responseSnapshot as DockAppointmentSnapshot;
  }

  /** Steps 9–11: the outbox event (no note — A15), the audit row, the key LAST. */
  private async finish(
    tx: TenantTx,
    command: { readonly tenantId: string; readonly actorUserId: string },
    idempotencyKey: string,
    payloadHash: string,
    snapshot: DockAppointmentSnapshot,
    action: 'dock_appointment.booked' | 'dock_appointment.rescheduled' | 'dock_appointment.cancelled',
    changes?: Record<string, unknown>,
  ): Promise<void> {
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId: command.tenantId,
      type: action,
      occurredAt: nowIso(),
      payload: { appointment: outboxAppointment(snapshot.appointment) },
    });
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      action,
      targetType: 'dock_appointment',
      targetId: snapshot.appointment.id,
      reference: idempotencyKey,
      ...(changes === undefined ? {} : { changes }),
      occurredAt: nowIso(),
    });
    await writeDockKeyInTx(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
  }
}
