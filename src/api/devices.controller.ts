import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { DeviceSessionGuard, CurrentDeviceSession } from '../modules/tenancy/device-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import type { DeviceSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { EnrollmentCommand } from '../modules/tenancy/enrollment.command';
import type { DeviceView } from '../modules/tenancy/enrollment.command';
import { SyncReportCommand } from '../modules/tenancy/sync-report.command';
import {
  BadgeInDto,
  BadgeInResponse,
  DeviceListResponse,
  DeviceResponse,
  DeviceSelfTestEchoDto,
  DeviceSelfTestEchoResponse,
  EnrollDeviceDto,
  EnrollDeviceResponse,
  MintEnrollmentCodeDto,
  MintEnrollmentCodeResponse,
} from './devices.dto';
// The Query DTO stays a RUNTIME import (the global ValidationPipe's
// transform reads design:paramtypes — the movements.controller note's
// precedent).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  RecordSyncReportDto,
  RejectedOpListQuery,
  RejectedOpListResponse,
  RejectedOpResolveResponse,
  ResolveRejectedOpDto,
  SyncReportResponse,
} from './rejected-ops.dto';
import type { RejectedOpEntry } from '../modules/tenancy/sync-report.command';
import type { RejectedOpResponse } from './rejected-ops.dto';

export class DeviceListQuery {
  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

/**
 * The devices HTTP surface (Story 3.2): web-Side enrollment-code minting and
 * revocation (`device.manage`, tenant session) + device-side enroll
 * (unauthenticated one-time code redemption), badge-in, and the self-test
 * echo (device session). The api shell is the only HTTP surface of the
 * monolith; every mutation goes through `EnrollmentCommand`, which re-reads
 * device status and operator role from the DB per command — the token is
 * transport, never authority.
 */
@ApiTags('devices')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class DevicesController {
  constructor(
    @Inject(EnrollmentCommand) private readonly enrollment: EnrollmentCommand,
    // Story 5-6 — the AD-14 sync-report surface (upload + review queue +
    // resolve) rides the same controller: the upload is the device contract's
    // newest member, the review routes gate on the session family only (the
    // command asserts `review.decide`).
    @Inject(SyncReportCommand) private readonly syncReports: SyncReportCommand,
  ) {}

  @Post(':tenantId/devices/enrollment-codes')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mints a one-time device enrollment code (device.manage) — 15-minute TTL, single redemption' })
  @ApiBody({ type: MintEnrollmentCodeDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: MintEnrollmentCodeResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks device.manage (role-denied)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async mintEnrollmentCode(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<MintEnrollmentCodeResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.enrollment.mintEnrollmentCode(
      { tenantId, actorUserId: session.userId },
      key,
    );
    return { ...snapshot };
  }

  @Post(':tenantId/devices/enroll')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Enrolls a device (unauthenticated): redeems the one-time code for a device credential + sealed offline-store key',
  })
  @ApiBody({ type: EnrollDeviceDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: EnrollDeviceResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, invalid body, or an unknown/used/expired code (enrollment-code-invalid)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'The minting tenant (embedded in the enrollment handoff)' })
  async enroll(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Body() dto: EnrollDeviceDto,
  ): Promise<EnrollDeviceResponse> {
    // The path pins the tenant the code was minted in — a code offered on any
    // other tenant's path is one indistinguishable 400 (the accept-invite
    // rule); the command checks this BEFORE burning the code.
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.enrollment.enroll(
      { tenantId, code: dto.code, label: dto.label, pin: dto.pin },
      key,
    );
    return { ...snapshot };
  }

  @Post(':tenantId/devices/badge-in')
  @HttpCode(HttpStatus.OK)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Badge-in: the device credential + operator PIN mint the revocable operator-bound device session',
  })
  @ApiBody({ type: BadgeInDto })
  @ApiOkResponse({ type: BadgeInResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token (unauthenticated), or wrong operator/PIN (badge-invalid)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async badgeIn(
    @Param('tenantId') tenantId: string,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: BadgeInDto,
  ): Promise<BadgeInResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    return this.enrollment.badgeIn({
      tenantId,
      deviceId: session.deviceId,
      operatorEmail: dto.operatorEmail,
      pin: dto.pin,
    });
  }

  @Get(':tenantId/devices')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists the tenant's enrolled devices (keyset cursor pagination — open to any member)" })
  @ApiOkResponse({ type: DeviceListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor) or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listDevices(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: DeviceListQuery,
  ): Promise<DeviceListResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const page = await this.enrollment.list(
      tenantId,
      query.cursor,
      query.limit === undefined ? undefined : query.limit,
    );
    return { items: page.items.map(toDeviceResponse), nextCursor: page.nextCursor };
  }

  @Post(':tenantId/devices/:deviceId/revoke')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Revokes a device (device.manage) — wipe-flagged, audited, effective on the device’s next request; re-revoke idempotent',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: DeviceResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or malformed deviceId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks device.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Device does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'deviceId', format: 'uuid' })
  async revokeDevice(
    @Param('tenantId') tenantId: string,
    @Param('deviceId') deviceId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<DeviceResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(deviceId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const device = await this.enrollment.revokeDevice(
      { tenantId, actorUserId: session.userId, deviceId },
      key,
    );
    return toDeviceResponse(device);
  }

  @Post(':tenantId/devices/self-test/echo')
  @HttpCode(HttpStatus.OK)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Device self-test echo (badge-in session required): the substrate replay target — re-authorizes device status + operator role per call',
  })
  @ApiBody({ type: DeviceSelfTestEchoDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: DeviceSelfTestEchoResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked), or the operator was demoted (role-denied)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async selfTestEcho(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: DeviceSelfTestEchoDto,
  ): Promise<DeviceSelfTestEchoResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    if (session.userId === null) {
      // A bare enrollment credential has no operator — badge-in first.
      throw new ProblemException(
        'unauthenticated',
        401,
        'Badge-in required',
        'This endpoint requires an operator badge-in session.',
      );
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.enrollment.selfTestEcho(
      {
        tenantId,
        deviceId: session.deviceId,
        operatorUserId: session.userId,
        payload: dto.payload,
      },
      key,
    );
  }

  // ── story 5-6: the AD-14 sync report + the rejected-op review queue ─────

  /**
   * The replay pass's durable upload (device session; badge-in required —
   * the self-test echo's family). The command re-resolves the device row and
   * the operator's role per call (fail-closed); rows dedupe per
   * (tenant, op_id), so the at-least-once re-post is a no-op.
   */
  @Post(':tenantId/devices/sync-reports')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Records a device sync report of dropped terminal ops (rejected + quarantined fates) — badge-in session, per-row dedupe',
  })
  @ApiBody({ type: RecordSyncReportDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: SyncReportResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed report row (validation-failed, naming the row)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked), or a demoted/removed operator (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Concurrent idempotent request for the same key') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async recordSyncReport(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: RecordSyncReportDto,
  ): Promise<SyncReportResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    if (session.userId === null) {
      // A bare enrollment credential has no operator — badge-in first.
      throw new ProblemException(
        'unauthenticated',
        401,
        'Badge-in required',
        'This endpoint requires an operator badge-in session.',
      );
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const { snapshot } = await this.syncReports.recordSyncReport(
      {
        tenantId,
        deviceId: session.deviceId,
        operatorUserId: session.userId,
        rows: dto.rows,
      },
      key,
    );
    return { ...snapshot, rows: snapshot.rows.map((ack) => ({ ...ack })) };
  }

  /**
   * The Conflicts & Reviews queue's read (story 5-6): the rejected ops,
   * newest first, status-filtered, keyset-paged. A read — open to any
   * tenant member (never capability-gated; the tab itself hides on the
   * capability, never blocks).
   */
  @Get(':tenantId/rejected-ops')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists the tenant's rejected sync-report ops (keyset cursor pagination — open to any member)" })
  @ApiOkResponse({ type: RejectedOpListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor), out-of-range limit, or unknown status filter (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listRejectedOps(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: RejectedOpListQuery,
  ): Promise<RejectedOpListResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const page = await this.syncReports.listRejectedOps(tenantId, {
      status: query.status,
      cursor: query.cursor,
      limit: query.limit === undefined ? undefined : query.limit,
    });
    return { items: page.items.map(toRejectedOpResponse), nextCursor: page.nextCursor };
  }

  /**
   * The resolve route (story 5-6, `review.decide` — the command executes
   * the arm; owner + ops_manager): apply / recount / discard, one row per
   * call. An apply arm's guard refusal surfaces verbatim (400/403/409/422
   * — the row stays open); the already-resolved and foreign arms are 409 /
   * 404.
   */
  @Post(':tenantId/rejected-ops/:rejectedOpId/resolve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Resolves one open rejected op (review.decide): apply re-executes the payload through its own guarded command (binStateEpoch stripped), recount mints a count task on the payload bin, discard trails to audit',
  })
  @ApiBody({ type: ResolveRejectedOpDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: RejectedOpResolveResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, unknown decision, or the payload refusing an arm (validation-failed — including a payload recount cannot re-plan)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks review.decide (role-denied), or the apply re-execution\'s own guards refused (device-revoked, verbatim)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Rejected op does not exist in this tenant (not-found), or a recounted bin does not') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Row already resolved (rejected-op-resolved), a pending count task on the bin (count-task-open), or the re-executed command\'s own conflict (verbatim)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'rejectedOpId', format: 'uuid' })
  async resolveRejectedOp(
    @Param('tenantId') tenantId: string,
    @Param('rejectedOpId') rejectedOpId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ResolveRejectedOpDto,
  ): Promise<RejectedOpResolveResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(rejectedOpId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const { snapshot } = await this.syncReports.resolveRejectedOp(
      {
        tenantId,
        actorUserId: session.userId,
        rejectedOpId,
        decision: dto.decision,
        occurredAt: dto.occurredAt,
      },
      key,
    );
    return {
      rejectedOp: toRejectedOpResponse(snapshot.rejectedOp),
      outcome: snapshot.outcome,
    };
  }
}

function toDeviceResponse(device: DeviceView): DeviceResponse {
  return { ...device };
}

function toRejectedOpResponse(entry: RejectedOpEntry): RejectedOpResponse {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    deviceId: entry.deviceId,
    operatorUserId: entry.operatorUserId,
    opId: entry.opId,
    opType: entry.opType,
    classification: entry.classification,
    problemCode: entry.problemCode,
    problemDetail: entry.problemDetail,
    payload: entry.payload,
    attribution: entry.attribution,
    opEnqueuedAt: entry.opEnqueuedAt,
    opOccurredAt: entry.opOccurredAt,
    status: entry.status,
    resolvedBy: entry.resolvedBy,
    resolvedAt: entry.resolvedAt,
    resolvedOutcome: entry.resolvedOutcome,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** Device uuid path params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      'deviceId must be a uuid',
      `The "deviceId" path parameter must be a uuid (got "${value}").`,
    );
  }
}

function assertOwnTenant(tokenTenantId: string, tenantId: string): void {
  if (tokenTenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The token tenant does not own this path.',
    );
  }
}
