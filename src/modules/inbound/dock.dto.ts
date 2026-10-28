import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BooleanFlag } from '../../shared/primitives/instant-range';
import { DOCK_APPOINTMENT_STATUSES, DOCK_LIMITS, DOCK_PUNCTUALITIES, DOCK_SLOT_MINUTES } from './dock.read';

/**
 * Story 2-3b — the dock's HTTP shapes. The DTO checks types and generous
 * outer bounds; every rule — the code and name, the schedule's grid, the
 * slot grid, the bounds, the documents — is the command's, behind its
 * replay lookup, and answers a 400 / 409 naming the field.
 */

const Nullable = () => ValidateIf((_, value) => value !== null && value !== undefined);

// ── doors ─────────────────────────────────────────────────────────────────────

export class CreateDockDoorDto {
  @ApiProperty({ example: 'D3', maxLength: DOCK_LIMITS.doorCode, description: 'Uppercased and trimmed; 1–20 letters, digits or hyphens; unique per warehouse (active or inactive)' })
  @IsString()
  @MaxLength(80)
  code!: string;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: DOCK_LIMITS.doorName, description: 'Trimmed; blank = none' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(400)
  name?: string | null;
}

export class UpdateDockDoorDto extends CreateDockDoorDto {
  @ApiProperty({ description: 'false deactivates (refused while the door has a booked appointment still to come — 409 dock-door-has-appointments); a door is never deleted' })
  @IsBoolean()
  active!: boolean;
}

export class DockDoorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ example: 'D3' })
  code!: string;

  @ApiProperty({ type: String, nullable: true })
  name!: string | null;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ format: 'uuid' })
  createdBy!: string;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class DockDoorResponse {
  @ApiProperty({ type: DockDoorDto })
  dockDoor!: DockDoorDto;
}

export class DockDoorListResponse {
  @ApiProperty({ type: [DockDoorDto], description: 'Every door of the warehouse — active first, then by code' })
  items!: readonly DockDoorDto[];
}

// ── the schedule ──────────────────────────────────────────────────────────────

export class PutDockScheduleDto {
  @ApiProperty({ enum: [...DOCK_SLOT_MINUTES], description: 'The slot length in minutes' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  slotMinutes!: number;

  @ApiProperty({ example: '09:00', description: 'IST wall clock HH:MM, on the slot grid' })
  @IsString()
  @MaxLength(8)
  opensAt!: string;

  @ApiProperty({ example: '18:00', description: 'IST wall clock HH:MM, on the slot grid, after opensAt; 24:00 closes at midnight' })
  @IsString()
  @MaxLength(8)
  closesAt!: string;

  @ApiProperty({ type: [Number], example: [1, 2, 3, 4, 5, 6], description: 'ISO weekdays the dock is open (1 = Monday … 7 = Sunday), at least one, no repeats' })
  @IsArray()
  @ArrayMaxSize(7)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  openDays!: number[];

  @ApiProperty({ minimum: 0, maximum: DOCK_LIMITS.graceMinutes, description: 'Minutes either side of the slot start an arrival still reads on time (frozen on each appointment at booking)' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  graceMinutes!: number;
}

export class DockScheduleDto {
  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ enum: [...DOCK_SLOT_MINUTES] })
  slotMinutes!: number;

  @ApiProperty({ example: '09:00' })
  opensAt!: string;

  @ApiProperty({ example: '18:00', description: '24:00 = midnight' })
  closesAt!: string;

  @ApiProperty({ type: [Number], example: [1, 2, 3, 4, 5, 6] })
  openDays!: number[];

  @ApiProperty()
  graceMinutes!: number;

  @ApiProperty({ description: 'false while the warehouse has no stored schedule — the defaults (30 min, 09:00–18:00, Mon–Sat, grace 15) are shown' })
  configured!: boolean;

  @ApiProperty({ type: String, nullable: true })
  updatedAt!: string | null;
}

export class DockScheduleResponse {
  @ApiProperty({ type: DockScheduleDto })
  schedule!: DockScheduleDto;
}

// ── appointments ──────────────────────────────────────────────────────────────

export class DockAppointmentDocumentInputDto {
  @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid', description: 'An OPEN purchase order of this warehouse (any client) — exactly one of poId / asnId' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(64)
  poId?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid', description: 'An announced or partially received ASN of this warehouse (any client)' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(64)
  asnId?: string | null;
}

/** What a booking carries; a reschedule replaces it in full. */
export class DockAppointmentFieldsDto {
  @ApiProperty({ format: 'uuid', description: 'An active dock door of the warehouse' })
  @IsString()
  @MaxLength(64)
  dockDoorId!: string;

  @ApiProperty({ format: 'date-time', description: "On the warehouse's IST slot grid, not before the current slot, at most 90 IST days ahead, inside an open day's hours" })
  @IsString()
  @MaxLength(40)
  startsAt!: string;

  @ApiProperty({ format: 'date-time', description: '1 to 8 whole slots after startsAt, not past the closing time' })
  @IsString()
  @MaxLength(40)
  endsAt!: string;

  @ApiProperty({ required: false, type: [DockAppointmentDocumentInputDto], maxItems: DOCK_LIMITS.documents, description: 'The POs and ASNs the truck carries (0–10, no repeats); the full set (reschedule replaces it)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DOCK_LIMITS.documents)
  @ValidateNested({ each: true })
  @Type(() => DockAppointmentDocumentInputDto)
  documents?: DockAppointmentDocumentInputDto[];

  @ApiProperty({ required: false, nullable: true, type: String, description: 'The expected vehicle — normalised like the gate-in (4–15 letters and digits)' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(60)
  vehicleNo?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: DOCK_LIMITS.transporterName })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(400)
  transporterName?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: DOCK_LIMITS.note, description: 'Free text — never copied into an event' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}

export class BookDockAppointmentDto extends DockAppointmentFieldsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  warehouseId!: string;
}

export class RescheduleDockAppointmentDto extends DockAppointmentFieldsDto {}

export class CancelDockAppointmentDto {
  @ApiProperty({ maxLength: DOCK_LIMITS.cancelReason, example: 'Vendor postponed', description: 'Why (1–200 characters, trimmed)' })
  @IsString()
  @MaxLength(800)
  reason!: string;
}

export class DockAppointmentDocumentDto {
  @ApiProperty({ enum: ['po', 'asn'] })
  kind!: 'po' | 'asn';

  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: 'PO-1001' })
  code!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  clientId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The PO's frozen vendor name; null on an ASN" })
  vendorName!: string | null;
}

export class DockAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ example: 'DA-0001' })
  code!: string;

  @ApiProperty({ enum: [...DOCK_APPOINTMENT_STATUSES], description: 'Stored status; a no-show is derived (noShow), never stored' })
  status!: string;

  @ApiProperty({ format: 'uuid' })
  dockDoorId!: string;

  @ApiProperty({ example: 'D3' })
  doorCode!: string;

  @ApiProperty({ format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ format: 'date-time' })
  endsAt!: string;

  @ApiProperty({ description: 'The on-time grace frozen at booking (re-frozen when rescheduled to another door or window)' })
  graceMinutes!: number;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Set when every document names one client; null when mixed or none' })
  clientId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  vehicleNo!: string | null;

  @ApiProperty({ type: String, nullable: true })
  transporterName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: [DockAppointmentDocumentDto] })
  documents!: readonly DockAppointmentDocumentDto[];

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  gateInId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'GI-0001' })
  gateInCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The linked gate-in's gated-in time — the arrival" })
  gatedInAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  linkedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  linkedBy!: string | null;

  @ApiProperty({ format: 'uuid' })
  bookedBy!: string;

  @ApiProperty({ type: String, nullable: true })
  cancelledAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  cancelledBy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancelReason!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: [...DOCK_PUNCTUALITIES, null], description: 'Derived from the arrival: early below −grace, late above +grace, else on_time; null until arrived' })
  punctuality!: (typeof DOCK_PUNCTUALITIES)[number] | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Arrival − start in whole minutes (the raw delta, truncated toward zero; negative = early)' })
  punctualityMinutes!: number | null;

  @ApiProperty({ description: 'Derived: still booked at or after endsAt + grace' })
  noShow!: boolean;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class DockAppointmentResponse {
  @ApiProperty({ type: DockAppointmentDto })
  appointment!: DockAppointmentDto;
}

// ── the window read ───────────────────────────────────────────────────────────

export class DockWindowQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ example: '2026-10-29', description: 'First IST date (inclusive)' })
  @IsString()
  @MaxLength(10)
  from!: string;

  @ApiProperty({ example: '2026-10-29', description: 'Last IST date (inclusive); at most 7 days from `from`' })
  @IsString()
  @MaxLength(10)
  to!: string;

  @ApiProperty({ required: false, type: Boolean, description: 'List cancelled appointments too (the summary counts them either way)' })
  @IsOptional()
  @BooleanFlag()
  @IsBoolean()
  includeCancelled?: boolean;
}

export class DockDoorMinutesDto {
  @ApiProperty({ format: 'uuid' })
  doorId!: string;

  @ApiProperty()
  bookedMinutes!: number;

  @ApiProperty()
  openMinutes!: number;
}

export class DockSummaryDto {
  @ApiProperty({ description: 'Non-cancelled appointments starting in the window' })
  scheduled!: number;

  @ApiProperty({ description: 'Booked and not yet a no-show' })
  pending!: number;

  @ApiProperty()
  arrived!: number;

  @ApiProperty()
  early!: number;

  @ApiProperty()
  onTime!: number;

  @ApiProperty()
  late!: number;

  @ApiProperty()
  noShow!: number;

  @ApiProperty({ description: 'Counted even when includeCancelled is false' })
  cancelled!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'onTime ÷ (arrived + noShow) as a percentage (0–100, one decimal); null when the denominator is 0' })
  onTimeRate!: number | null;

  @ApiProperty({ description: "Minutes of scheduled appointments, each clipped to its day's opening hours" })
  bookedMinutes!: number;

  @ApiProperty({ description: 'The door set (active now, plus any door with an appointment in the window) × the open minutes of each open day' })
  openMinutes!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'bookedMinutes ÷ openMinutes as a percentage (0–100, one decimal, clamped); null when openMinutes is 0' })
  utilisationRate!: number | null;

  @ApiProperty({ type: [DockDoorMinutesDto] })
  byDoor!: readonly DockDoorMinutesDto[];
}

export class DockWindowResponse {
  @ApiProperty({ description: 'The server instant the derived fields (noShow, pending) were read at' })
  asOf!: string;

  @ApiProperty({ example: '2026-10-29' })
  from!: string;

  @ApiProperty({ example: '2026-10-29' })
  to!: string;

  @ApiProperty({ type: DockScheduleDto })
  schedule!: DockScheduleDto;

  @ApiProperty({ type: [DockDoorDto], description: 'Active doors, plus any inactive door with an appointment in the window' })
  doors!: readonly DockDoorDto[];

  @ApiProperty({ type: [DockAppointmentDto], description: 'By (startsAt, id), at most 1000' })
  appointments!: readonly DockAppointmentDto[];

  @ApiProperty({ type: DockSummaryDto, description: 'Over the whole window, independent of the 1000-row cap' })
  summary!: DockSummaryDto;

  @ApiProperty({ description: 'true when the window holds more than 1000 listed appointments' })
  truncated!: boolean;
}

// ── the gate-in and the device snapshot ──────────────────────────────────────

/** Story 2-3b — a gate-in's appointment (the list and the detail). */
export class GateInAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'DA-0012' })
  code!: string;

  @ApiProperty({ format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ format: 'date-time' })
  endsAt!: string;

  @ApiProperty({ example: 'D3' })
  doorCode!: string;

  @ApiProperty({ enum: [...DOCK_PUNCTUALITIES] })
  punctuality!: (typeof DOCK_PUNCTUALITIES)[number];

  @ApiProperty({ description: "The gate-in time − the slot start in whole minutes (negative = early)" })
  punctualityMinutes!: number;
}

/** The device's copy (no id — the handheld shows it, never acts on it). */
export class CatalogGateInAppointmentDto {
  @ApiProperty({ example: 'DA-0012' })
  code!: string;

  @ApiProperty({ format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ format: 'date-time' })
  endsAt!: string;

  @ApiProperty({ example: 'D3' })
  doorCode!: string;

  @ApiProperty({ enum: [...DOCK_PUNCTUALITIES] })
  punctuality!: (typeof DOCK_PUNCTUALITIES)[number];

  @ApiProperty()
  punctualityMinutes!: number;
}

export class CatalogDockAppointmentDocumentDto {
  @ApiProperty({ enum: ['po', 'asn'] })
  kind!: 'po' | 'asn';

  @ApiProperty({ type: String, nullable: true, example: 'PO-1002' })
  code!: string | null;
}

/** Story 2-3b (decision 12, A13) — one booked appointment of today on the device. */
export class CatalogDockAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'DA-0002' })
  code!: string;

  @ApiProperty({ format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ format: 'date-time' })
  endsAt!: string;

  @ApiProperty({ description: 'The frozen grace — the device reads "Not arrived" once its clock passes endsAt + grace' })
  graceMinutes!: number;

  @ApiProperty({ example: 'D2' })
  doorCode!: string;

  @ApiProperty({ type: String, nullable: true })
  vehicleNo!: string | null;

  @ApiProperty({ type: String, nullable: true })
  transporterName!: string | null;

  @ApiProperty({ type: [CatalogDockAppointmentDocumentDto] })
  documents!: readonly CatalogDockAppointmentDocumentDto[];
}
