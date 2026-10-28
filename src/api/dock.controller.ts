import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { DockFacade } from '../modules/inbound/dock.facade';
import type { DockAppointmentView, DockWindowView } from '../modules/inbound/dock.read';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  BookDockAppointmentDto,
  CancelDockAppointmentDto,
  CreateDockDoorDto,
  DockAppointmentResponse,
  DockDoorListResponse,
  DockDoorResponse,
  DockScheduleResponse,
  DockWindowQueryDto,
  DockWindowResponse,
  PutDockScheduleDto,
  RescheduleDockAppointmentDto,
  UpdateDockDoorDto,
} from '../modules/inbound/dock.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const READ_403 = 'Session belongs to another tenant (permission-denied), or a client-portal session (role-denied — an operator surface)';
const MANAGE_403 = `${READ_403}, or the caller lacks dock.manage (role-denied)`;
const SCHEDULE_403 = `${READ_403}, or the caller lacks dock.schedule (role-denied)`;
const WRITE_422 = 'Idempotency key reused with a different payload (idempotency-key-reuse)';
const APPOINTMENT_400 =
  'Missing or malformed Idempotency-Key; a malformed field — the instants, more than 8 slots, more than 10 documents or a repeated one, a document naming both or neither of poId / asnId, the vehicle, a length (validation-failed); a start off the slot grid or a duration that is not whole slots (slot-misaligned); before the current slot (slot-in-past); more than 90 IST days ahead (slot-too-far)';
const APPOINTMENT_409 =
  "A closed day or outside the opening hours (dock-closed); the door is another warehouse's (dock-door-warehouse-mismatch) or inactive (dock-door-inactive); the door is taken — `clash` names the appointment and its window (dock-slot-taken); a document of another warehouse (document-warehouse-mismatch), a PO not open (po-not-open), an ASN not announced or partially received (asn-not-open); or a concurrent idempotent request (conflict)";

/**
 * Story 2-3b — the dock HTTP surface: the dock-door master and the schedule
 * (Settings → Warehouses, `dock.manage`), the appointments (book, reschedule,
 * cancel — `dock.schedule`) and the calendar's window read (any staff
 * session). Every route goes through `DockFacade`; a client-portal token is
 * refused by `TenantSessionGuard` (A23).
 */
@ApiTags('dock')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class DockController {
  constructor(@Inject(DockFacade) private readonly dock: DockFacade) {}

  // ── doors ───────────────────────────────────────────────────────────────

  @Get(':tenantId/warehouses/:warehouseId/dock-doors')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "A warehouse's dock doors, active first then by code (any staff member)" })
  @ApiOkResponse({ type: DockDoorListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed warehouseId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listDoors(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<DockDoorListResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam('warehouseId', warehouseId);
    const items = await this.dock.listDoors(tenantId, warehouseId);
    return { items: items.map((door) => ({ ...door })) };
  }

  @Post(':tenantId/warehouses/:warehouseId/dock-doors')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Adds a dock door (dock.manage) — a code unique in the warehouse, an optional name; at most 100 doors' })
  @ApiBody({ type: CreateDockDoorDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: DockDoorResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, the code (1–20 letters, digits or hyphens) or the name (≤ 60) (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MANAGE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The code exists in this warehouse (dock-door-code-taken); 100 doors already (dock-door-limit); a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse(WRITE_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async createDoor(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateDockDoorDto,
  ): Promise<DockDoorResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam('warehouseId', warehouseId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.dock.createDoor({ tenantId, actorUserId: session.userId, warehouseId, code: dto.code, name: dto.name }, key);
    return { dockDoor: { ...snapshot.dockDoor } };
  }

  @Patch(':tenantId/warehouses/:warehouseId/dock-doors/:doorId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Replaces a dock door (dock.manage) — code, name and active in full; a deactivation is refused while a booked appointment is still to come' })
  @ApiBody({ type: UpdateDockDoorDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: DockDoorResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed id, the code, the name or active (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MANAGE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such door in this warehouse (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The code exists in this warehouse (dock-door-code-taken); booked appointments still to come — appointmentCount and firstAppointmentCode name them (dock-door-has-appointments); a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse(WRITE_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'doorId', format: 'uuid' })
  async updateDoor(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Param('doorId') doorId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateDockDoorDto,
  ): Promise<DockDoorResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam('warehouseId', warehouseId);
    assertUuidParam('doorId', doorId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.dock.updateDoor(
      { tenantId, actorUserId: session.userId, warehouseId, doorId, code: dto.code, name: dto.name, active: dto.active },
      key,
    );
    return { dockDoor: { ...snapshot.dockDoor } };
  }

  // ── the schedule ────────────────────────────────────────────────────────

  @Get(':tenantId/warehouses/:warehouseId/dock-schedule')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "A warehouse's dock schedule (any staff member) — the defaults with configured: false until one is saved" })
  @ApiOkResponse({ type: DockScheduleResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed warehouseId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async getSchedule(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<DockScheduleResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam('warehouseId', warehouseId);
    const schedule = await this.dock.schedule(tenantId, warehouseId);
    return { schedule: { ...schedule, openDays: [...schedule.openDays] } };
  }

  @Put(':tenantId/warehouses/:warehouseId/dock-schedule')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Sets a warehouse's dock schedule (dock.manage) — a full replacement; never moves or refuses an existing appointment" })
  @ApiBody({ type: PutDockScheduleDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: DockScheduleResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key; a slot length not 15/30/60, a time not HH:MM or off the slot grid, closesAt not after opensAt, no open day or a repeated one, a grace outside 0–120 — the field named (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MANAGE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse(WRITE_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async putSchedule(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: PutDockScheduleDto,
  ): Promise<DockScheduleResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam('warehouseId', warehouseId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.dock.putSchedule(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId,
        slotMinutes: dto.slotMinutes,
        opensAt: dto.opensAt,
        closesAt: dto.closesAt,
        openDays: dto.openDays,
        graceMinutes: dto.graceMinutes,
      },
      key,
    );
    return { schedule: { ...snapshot.schedule, openDays: [...snapshot.schedule.openDays] } };
  }

  // ── the calendar and the appointments ───────────────────────────────────

  @Get(':tenantId/receiving/dock-schedule')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "The dock calendar's window (any staff member): one warehouse's appointments starting on the IST dates from–to (≤ 7 days, ≤ 1000 listed), its schedule, the doors and the summary — every client's",
  })
  @ApiOkResponse({ type: DockWindowResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed warehouseId, from or to, to before from, or more than 7 days (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  async window(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: DockWindowQueryDto,
  ): Promise<DockWindowResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const view = await this.dock.window(tenantId, {
      warehouseId: query.warehouseId,
      from: query.from,
      to: query.to,
      includeCancelled: query.includeCancelled === true,
    });
    return windowBody(view);
  }

  @Post(':tenantId/receiving/dock-appointments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Books a dock appointment (dock.schedule) — one door for 1–8 whole slots of an open day, optionally against open POs and ASNs of the warehouse (any client); DA-<n>, status booked; no overbooking',
  })
  @ApiBody({ type: BookDockAppointmentDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: DockAppointmentResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(APPOINTMENT_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(SCHEDULE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse, the door, or a document does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse(APPOINTMENT_409) })
  @ApiResponse({ status: 422, ...problemJsonResponse(WRITE_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  async book(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: BookDockAppointmentDto,
  ): Promise<DockAppointmentResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.dock.book({ tenantId, actorUserId: session.userId, warehouseId: dto.warehouseId, ...fieldsOf(dto) }, key);
    return { appointment: appointmentBody(snapshot.appointment) };
  }

  @Get(':tenantId/receiving/dock-appointments/:appointmentId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One dock appointment (any staff member) — the calendar drawer' })
  @ApiOkResponse({ type: DockAppointmentResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed appointmentId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such appointment in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({ name: 'appointmentId', format: 'uuid' })
  async get(
    @Param('tenantId') tenantId: string,
    @Param('appointmentId') appointmentId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<DockAppointmentResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam('appointmentId', appointmentId);
    return { appointment: appointmentBody(await this.dock.appointment(tenantId, appointmentId)) };
  }

  @Patch(':tenantId/receiving/dock-appointments/:appointmentId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Reschedules a booked dock appointment (dock.schedule) — a full replacement of the door, window, documents, vehicle, transporter and note; only what changed is re-checked (a vehicle, transporter or note edit is always accepted while booked)',
  })
  @ApiBody({ type: RescheduleDockAppointmentDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: DockAppointmentResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(`${APPOINTMENT_400}; a malformed appointmentId (validation-failed)`) })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(SCHEDULE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('The appointment, the new door or a document does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse(`Arrived or cancelled (appointment-closed); past its window and grace (appointment-no-show); moved concurrently — reload (conflict); ${APPOINTMENT_409}`) })
  @ApiResponse({ status: 422, ...problemJsonResponse(WRITE_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({ name: 'appointmentId', format: 'uuid' })
  async reschedule(
    @Param('tenantId') tenantId: string,
    @Param('appointmentId') appointmentId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RescheduleDockAppointmentDto,
  ): Promise<DockAppointmentResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam('appointmentId', appointmentId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.dock.reschedule({ tenantId, actorUserId: session.userId, appointmentId, ...fieldsOf(dto) }, key);
    return { appointment: appointmentBody(snapshot.appointment) };
  }

  @Post(':tenantId/receiving/dock-appointments/:appointmentId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancels a booked dock appointment with a reason (dock.schedule) — the slot frees' })
  @ApiBody({ type: CancelDockAppointmentDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: DockAppointmentResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed appointmentId, a blank or over-200 reason (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(SCHEDULE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such appointment in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Arrived or cancelled (appointment-closed); past its window and grace (appointment-no-show); a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse(WRITE_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({ name: 'appointmentId', format: 'uuid' })
  async cancel(
    @Param('tenantId') tenantId: string,
    @Param('appointmentId') appointmentId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CancelDockAppointmentDto,
  ): Promise<DockAppointmentResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam('appointmentId', appointmentId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.dock.cancel({ tenantId, actorUserId: session.userId, appointmentId, reason: dto.reason }, key);
    return { appointment: appointmentBody(snapshot.appointment) };
  }
}

/** The DTO's fields as the command takes them (the documents copied key by key). */
function fieldsOf(dto: RescheduleDockAppointmentDto) {
  return {
    dockDoorId: dto.dockDoorId,
    startsAt: dto.startsAt,
    endsAt: dto.endsAt,
    documents: dto.documents?.map((doc) => ({ poId: doc.poId, asnId: doc.asnId })),
    vehicleNo: dto.vehicleNo,
    transporterName: dto.transporterName,
    note: dto.note,
  };
}

function appointmentBody(view: DockAppointmentView): DockAppointmentResponse['appointment'] {
  return { ...view, documents: view.documents.map((doc) => ({ ...doc })) };
}

function windowBody(view: DockWindowView): DockWindowResponse {
  return {
    ...view,
    schedule: { ...view.schedule, openDays: [...view.schedule.openDays] },
    doors: view.doors.map((door) => ({ ...door })),
    appointments: view.appointments.map(appointmentBody),
    summary: { ...view.summary, byDoor: view.summary.byDoor.map((door) => ({ ...door })) },
  };
}

function assertUuidParam(name: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, `${name} must be a uuid`, `The "${name}" parameter must be a uuid (got "${value}").`);
  }
}

function assertOwnTenant(tokenTenantId: string, tenantId: string): void {
  if (tokenTenantId !== tenantId) {
    throw new ProblemException('permission-denied', 403, 'Session belongs to another tenant', 'The session token tenant does not own this path.');
  }
}
