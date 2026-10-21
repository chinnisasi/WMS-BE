import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { DeviceSessionGuard, CurrentDeviceSession } from '../modules/tenancy/device-session.guard';
import type { DeviceSession, TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { GateInFacade } from '../modules/inbound/gate-in.facade';
import type { GateInStatus, GateInHeaderInput } from '../modules/inbound/gate-in.command';
import type { GateInDetailView, GateInEntryView, GateInView } from '../modules/inbound/gate-in.read';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AmendGateInDto,
  CreateGateInDto,
  GateInDetailResponse,
  GateInHeaderDto,
  GateInListQuery,
  GateInListResponse,
  GateInResponse,
  GateInUnloadResponse,
  GateOutDto,
  UnloadGateInDto,
} from '../modules/inbound/gate-in.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const WRITE_400 =
  'Missing or malformed Idempotency-Key, or a field the gate-in refuses — named in the detail: the vehicle (4–15 letters and digits; spaces, dots and hyphens are ignored; required unless a hand delivery), the container, both or neither transporter, the phone, the seal pairing, a package count, a document row (kind, number, a date after today in IST, a 12-digit e-way bill, PO and ASN together, a repeated kind + number) (validation-failed); a time more than 5 minutes ahead (time-in-future)';
const WRITE_403 = 'Session belongs to another tenant (permission-denied), or the caller lacks gate.manage (role-denied)';
const WRITE_422 = 'Idempotency key reused with a different payload (idempotency-key-reuse)';

/**
 * Story 2-3a — the gate-in HTTP surface: the gate desk records a vehicle
 * (web), amends it and gates it out; the dock records the unload from the
 * handheld (a device badge-in route, the op `gate-in.unload`) or the web.
 * Every route goes through `GateInFacade`; the commands re-read the role
 * (and, on the device route, the device and operator) at entry.
 */
@ApiTags('gate-ins')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class GateInController {
  constructor(@Inject(GateInFacade) private readonly gateIns: GateInFacade) {}

  @Post(':tenantId/receiving/gate-ins')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Records a gate-in (gate.manage) — one inbound vehicle visit: vehicle (or a hand delivery), transporter (a partner or a typed name), LR, driver, seal, packages declared, dock door and the supplier documents; GI-<n>, status gated_in',
  })
  @ApiBody({ type: CreateGateInDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: GateInResponse, description: 'The gate-in (the idempotency snapshot; the driver phone masked)' })
  @ApiResponse({ status: 400, ...problemJsonResponse(WRITE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("The warehouse, the transporter partner, or a document's purchase order or ASN does not exist in this tenant (not-found)") })
  @ApiResponse({ status: 409, ...problemJsonResponse("The partner lacks the transporter role (partner-not-transporter) or is inactive (transporter-inactive); a document's PO or ASN is another warehouse's (document-warehouse-mismatch); or a concurrent idempotent request (conflict)") })
  @ApiResponse({ status: 422, ...problemJsonResponse(WRITE_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async create(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateGateInDto,
  ): Promise<GateInResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.gateIns.create(
      { tenantId, actorUserId: session.userId, warehouseId: dto.warehouseId, ...headerOf(dto) },
      key,
    );
    return { gateIn: gateInBody(snapshot.gateIn) };
  }

  @Get(':tenantId/receiving/gate-ins')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Lists one warehouse's gate-ins, newest gated-in first (any staff member) — every client's; status repeatable; the driver phone masked; keyset cursor",
  })
  @ApiOkResponse({ type: GateInListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed warehouseId, status, cursor or limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async list(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: GateInListQuery,
  ): Promise<GateInListResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const page = await this.gateIns.list(tenantId, {
      warehouseId: query.warehouseId,
      statuses: query.status as GateInStatus[] | undefined,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(entryBody), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/receiving/gate-ins/:gateInId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "One gate-in's detail (any staff member): the documents with the PO / ASN codes they cover and the linked goods receipts with their client; the driver's full phone only for a gate.manage holder (masked otherwise)",
  })
  @ApiOkResponse({ type: GateInDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed gateInId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No gate-in with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'gateInId', format: 'uuid' })
  async get(
    @Param('tenantId') tenantId: string,
    @Param('gateInId') gateInId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<GateInDetailResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(gateInId);
    const detail = await this.gateIns.get(tenantId, session.userId, gateInId);
    return { gateIn: detailBody(detail) };
  }

  @Patch(':tenantId/receiving/gate-ins/:gateInId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Amends a gate-in (gate.manage) — a FULL replacement of the header (an absent or blank optional becomes null) and of the document set; the gated-in time only while gated_in; last write wins',
  })
  @ApiBody({ type: AmendGateInDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: GateInResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(`${WRITE_400}; a malformed gateInId (validation-failed)`) })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("The gate-in, the (new) transporter partner, or a document's PO or ASN does not exist in this tenant (not-found)") })
  @ApiResponse({ status: 409, ...problemJsonResponse('The gate-in is gated out (gate-in-closed); a different gated-in time once the unload started (gate-in-time-locked); a changed seal status, seal number or packages declared once the unload ended (gate-in-field-locked); a new transporter partner without the role (partner-not-transporter) or inactive (transporter-inactive); a document of another warehouse (document-warehouse-mismatch); or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse(WRITE_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'gateInId', format: 'uuid' })
  async amend(
    @Param('tenantId') tenantId: string,
    @Param('gateInId') gateInId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: AmendGateInDto,
  ): Promise<GateInResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(gateInId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.gateIns.amend({ tenantId, actorUserId: session.userId, gateInId, ...headerOf(dto) }, key);
    return { gateIn: gateInBody(snapshot.gateIn) };
  }

  @Post(':tenantId/receiving/gate-ins/:gateInId/unload')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Records the unload start, or its end with the packages counted, from the web (gate.manage) — each column fills only when still empty, in any status; nothing to fill answers applied: false',
  })
  @ApiBody({ type: UnloadGateInDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: GateInUnloadResponse, description: '`applied: false` when the phase was already recorded (the first record stands; nothing changed)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an unknown phase, packagesCounted missing on end / present on start / out of range, a malformed occurredAt or gateInId (validation-failed); a time more than 5 minutes ahead (time-in-future); a time before the gated-in time or, for an end, the start, or after a recorded gate-out (time-out-of-order)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No gate-in with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict) — never gate-in-closed: a gated-out visit still takes its unload') })
  @ApiResponse({ status: 422, ...problemJsonResponse(WRITE_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'gateInId', format: 'uuid' })
  async unloadWeb(
    @Param('tenantId') tenantId: string,
    @Param('gateInId') gateInId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UnloadGateInDto,
  ): Promise<GateInUnloadResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(gateInId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.gateIns.unload(
      {
        tenantId,
        actorUserId: session.userId,
        deviceId: null,
        gateInId,
        phase: dto.phase,
        ...(dto.occurredAt === undefined ? {} : { occurredAt: dto.occurredAt }),
        ...(dto.packagesCounted === undefined ? {} : { packagesCounted: dto.packagesCounted }),
      },
      key,
    );
    return { applied: snapshot.applied, gateIn: gateInBody(snapshot.gateIn) };
  }

  @Post(':tenantId/devices/gate-ins/:gateInId/unload')
  @HttpCode(HttpStatus.OK)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "gate-in.unload — the dock handheld's unload start or end (badge-in session required; gate.manage): the device and its operator are re-read first; the time is taken as sent; each column fills only when still empty, in any status",
  })
  @ApiBody({ type: UnloadGateInDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: GateInUnloadResponse, description: '`applied: false` when the phase was already recorded (the device settles it with a note)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an unknown phase, occurredAt missing or malformed, packagesCounted missing on end / present on start / out of range, a malformed gateInId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked); the operator is not a floor role or lacks gate.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No gate-in with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse("The op's creator is not the badged operator (operator-mismatch), or a concurrent idempotent request (conflict)") })
  @ApiResponse({ status: 422, ...problemJsonResponse(WRITE_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  @ApiParam({ name: 'gateInId', format: 'uuid' })
  async unloadDevice(
    @Param('tenantId') tenantId: string,
    @Param('gateInId') gateInId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: UnloadGateInDto,
  ): Promise<GateInUnloadResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    if (session.userId === null) {
      throw new ProblemException('unauthenticated', 401, 'Badge-in required', 'This endpoint requires an operator badge-in session.');
    }
    assertUuidParam(gateInId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.gateIns.unload(
      {
        tenantId,
        actorUserId: session.userId,
        deviceId: session.deviceId,
        gateInId,
        phase: dto.phase,
        ...(dto.occurredAt === undefined ? {} : { occurredAt: dto.occurredAt }),
        ...(dto.packagesCounted === undefined ? {} : { packagesCounted: dto.packagesCounted }),
      },
      key,
    );
    return { applied: snapshot.applied, gateIn: gateInBody(snapshot.gateIn) };
  }

  @Post(':tenantId/receiving/gate-ins/:gateInId/gate-out')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Gates the vehicle out (gate.manage) — from any state but gated_out; closes the visit (no further edits; a late unload still records)',
  })
  @ApiBody({ type: GateOutDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: GateInResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed gatedOutAt or gateInId (validation-failed); a time more than 5 minutes ahead (time-in-future); before the gated-in time, the unload start or the unload end (time-out-of-order)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No gate-in with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Already gated out (gate-in-closed), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse(WRITE_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'gateInId', format: 'uuid' })
  async gateOut(
    @Param('tenantId') tenantId: string,
    @Param('gateInId') gateInId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: GateOutDto,
  ): Promise<GateInResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(gateInId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.gateIns.gateOut(
      { tenantId, actorUserId: session.userId, gateInId, ...(dto.gatedOutAt === undefined ? {} : { gatedOutAt: dto.gatedOutAt }) },
      key,
    );
    return { gateIn: gateInBody(snapshot.gateIn) };
  }
}

/** The DTO's header as the command takes it (the documents copied key by key). */
function headerOf(dto: GateInHeaderDto): GateInHeaderInput {
  return {
    handDelivery: dto.handDelivery,
    vehicleNo: dto.vehicleNo,
    containerNo: dto.containerNo,
    transporterPartnerId: dto.transporterPartnerId,
    transporterName: dto.transporterName,
    lrNumber: dto.lrNumber,
    driverName: dto.driverName,
    driverPhone: dto.driverPhone,
    sealStatus: dto.sealStatus,
    sealNumber: dto.sealNumber,
    packagesDeclared: dto.packagesDeclared,
    dockDoor: dto.dockDoor,
    gatedInAt: dto.gatedInAt,
    documents: dto.documents?.map((doc) => ({
      kind: doc.kind,
      number: doc.number,
      documentDate: doc.documentDate,
      ewayBillNo: doc.ewayBillNo,
      poId: doc.poId,
      asnId: doc.asnId,
    })),
  };
}

function gateInBody(view: GateInView): GateInResponse['gateIn'] {
  return {
    ...view,
    transporterSnapshot: view.transporterSnapshot === null ? null : { ...view.transporterSnapshot },
    documents: view.documents.map((doc) => ({ ...doc })),
  };
}

function entryBody(view: GateInEntryView): GateInListResponse['items'][number] {
  return { ...view, transporterSnapshot: view.transporterSnapshot === null ? null : { ...view.transporterSnapshot } };
}

function detailBody(view: GateInDetailView): GateInDetailResponse['gateIn'] {
  return {
    ...view,
    transporterSnapshot: view.transporterSnapshot === null ? null : { ...view.transporterSnapshot },
    documents: view.documents.map((doc) => ({ ...doc })),
    receipts: view.receipts.map((receipt) => ({ ...receipt, document: { ...receipt.document } })),
  };
}

function assertUuidParam(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, 'gateInId must be a uuid', `The "gateInId" parameter must be a uuid (got "${value}").`);
  }
}

function assertOwnTenant(tokenTenantId: string, tenantId: string): void {
  if (tokenTenantId !== tenantId) {
    throw new ProblemException('permission-denied', 403, 'Session belongs to another tenant', 'The session token tenant does not own this path.');
  }
}
