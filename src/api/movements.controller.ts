import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { AnySessionGuard, CurrentAnySession, type AnySession } from '../modules/tenancy/any-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { MovementsFacade } from '../modules/movements/transfer.facade';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CancelTransferDto,
  ConfirmInboundDto,
  ConfirmOutboundDto,
  ConfirmOutboundLineDto,
  CreateTransferDto,
  TransferDetailResponse,
  TransferListQuery,
  TransferListResponse,
  TransferLineDto,
  TransferOrderResponse,
  TransferConfirmResponse,
} from '../modules/movements/movements.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CreateCountDto,
  SubmitCountDto,
  SubmitCountLineDto,
  UpsertCountPoliciesDto,
  CreateCountResponse,
  SubmitCountResponse,
  CountPoliciesResponse,
} from '../modules/movements/count.dto';
const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    // ULID: 26 chars, Crockford base32.
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

/**
 * The movements HTTP surface (Story 5-1): the transfer-order lifecycle —
 * create, outbound-confirm (the planner verbs, `transfers.manage` at the
 * command), inbound-confirm (the floor verb — EITHER session family, the
 * compliance controller's precedent: a device badge-in session's operator
 * confirms the leg, the mobile op's ULID rides as the Idempotency-Key) and
 * draft-only cancel, plus the list/detail reads (never capability-gated).
 * Every mutation goes through `MovementsFacade`, whose commands re-evaluate
 * the caller's role against the DB at entry — the token is transport, never
 * authority.
 */
@ApiTags('movements')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class MovementsController {
  constructor(
    @Inject(MovementsFacade) private readonly movements: MovementsFacade,
  ) {}

  @Post(':tenantId/movements/transfers')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Creates a transfer order (transfers.manage): a draft two-leg plan — per line, draw from a source bin and land in a planned destination bin',
  })
  @ApiBody({ type: CreateTransferDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: TransferOrderResponse,
    description: 'Transfer created in draft (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body — a catch-weight SKU, a batch- and serial-tracked SKU, a missing/forbidden batch arm, a system bin on either end, or a quantity finer than the SKU\'s unit allows (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks transfers.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('A warehouse, bin, SKU, or batch does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A line names a kit SKU — a kit never holds stock (kit-cannot-hold-stock), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createTransfer(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateTransferDto,
  ): Promise<TransferOrderResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.createTransfer(
      {
        tenantId,
        actorUserId: session.userId,
        sourceWarehouseId: dto.sourceWarehouseId,
        destWarehouseId: dto.destWarehouseId,
        note: dto.note ?? undefined,
        occurredAt: dto.occurredAt,
        lines: dto.lines.map((line: TransferLineDto) => ({
          skuId: line.skuId,
          quantity: line.quantity,
          fromBinId: line.fromBinId,
          toBinId: line.toBinId,
          batchRef: line.batchId ?? undefined,
          note: line.note ?? undefined,
        })),
      },
      key,
    );
    return { transfer: { ...snapshot.transfer }, lines: snapshot.lines.map((line) => ({ ...line })) };
  }

  @Post(':tenantId/movements/transfers/:transferId/outbound-confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Confirms the outbound leg (transfers.manage): draws each line from its source bin into the source warehouse\'s system IN-TRANSIT bin — one ledger event per arm, the order flips to in_transit',
  })
  @ApiBody({ type: ConfirmOutboundDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: TransferConfirmResponse,
    description: 'Outbound confirmed: the leg events (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, or a serial-tracked line whose serial scans do not match its quantity (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks transfers.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The transfer, a line, or a scanned serial does not exist in this tenant (not-found, serial-unknown)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The order is not draft (transfer-wrong-state), a source bin is short of the planned draw (transfer-source-short), a serial is already located elsewhere or scanned twice (serial-elsewhere, duplicate-serial), the source on-hand cannot cover the draw (insufficient-on-hand), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'transferId', format: 'uuid' })
  async confirmOutbound(
    @Param('tenantId') tenantId: string,
    @Param('transferId') transferId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ConfirmOutboundDto,
  ): Promise<TransferConfirmResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(transferId, 'transferId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.confirmOutbound(
      {
        tenantId,
        actorUserId: session.userId,
        transferId,
        occurredAt: dto.occurredAt,
        // An explicit `"lines": null` behaves as absent (the mobile op always
        // carries the field it did not scan); lines not named carry no scans.
        lines: dto.lines?.map((line: ConfirmOutboundLineDto) => ({
          lineId: line.lineId,
          serials: line.serials ?? undefined,
        })),
      },
      key,
    );
    return { transfer: { ...snapshot.transfer }, events: snapshot.events.map((event) => ({ ...event })) };
  }

  @Post(':tenantId/movements/transfers/:transferId/inbound-confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiBearerAuth('device')
  @ApiOperation({
    summary:
      'Confirms the inbound leg (transfers.execute — either session family): lands each line in its scanned or planned destination bin and completes the order — one ledger event per arm (cross-warehouse: a drain on the source chain AND an intake on the destination chain, ONE transaction)',
    description:
      'Accepts EITHER session family on the one route (the compliance controller\'s precedent): a web session or a device badge-in session — the Transfer inbox task\'s confirm. The command re-evaluates the actor\'s role and the destination placement gates against the DB at entry.',
  })
  @ApiBody({ type: ConfirmInboundDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: TransferConfirmResponse,
    description: 'Inbound confirmed: both legs\' events on a cross-warehouse transfer (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token of either family, or a device token without a badge-in session (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), the caller lacks transfers.execute (role-denied), or the destination bin is secure/cage-class and the actor lacks secure.move (role-denied — the cage is off-limits to floor staff, FR-42)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The transfer or the scanned destination bin does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The order is not in_transit (transfer-wrong-state), the scanned bin\'s state epoch is stale (transfer-bin-changed — the mobile client re-plans), or a destination placement gate refused — retired, blocked, storage-class mismatch (bin-retired, bin-blocked, bin-storage-mismatch), hazard co-location (bin-segregation-conflict), bulk-asset occupancy (bin-occupancy-conflict), or the load gates (bin-full, bin-overweight, bin-volume-exceeded, bin-item-oversize) — the order stays in_transit; or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'transferId', format: 'uuid' })
  async confirmInbound(
    @Param('tenantId') tenantId: string,
    @Param('transferId') transferId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentAnySession() session: AnySession,
    @Body() dto: ConfirmInboundDto,
  ): Promise<TransferConfirmResponse> {
    assertOwnTenantToken(session.session.tenantId, tenantId);
    assertUuidParam(transferId, 'transferId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    // The device arm is badge-in required (a bare enrollment credential
    // carries no operator — the badgeInRequired pattern).
    let actorUserId: string;
    if (session.family === 'device') {
      if (session.session.userId === null) {
        throw badgeInRequired();
      }
      actorUserId = session.session.userId;
    } else {
      actorUserId = session.session.userId;
    }
    const snapshot = await this.movements.confirmInbound(
      {
        tenantId,
        actorUserId,
        transferId,
        destBinId: dto.destBinId ?? undefined,
        binStateEpoch: dto.binStateEpoch ?? undefined,
        occurredAt: dto.occurredAt,
      },
      key,
    );
    return { transfer: { ...snapshot.transfer }, events: snapshot.events.map((event) => ({ ...event })) };
  }

  @Post(':tenantId/movements/transfers/:transferId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancels a DRAFT transfer order (transfers.manage) — no stock has moved, so the cancel is pure state; an in-transit or completed order refuses (409 transfer-wrong-state)',
  })
  @ApiBody({ type: CancelTransferDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: TransferOrderResponse,
    description: 'Transfer cancelled (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks transfers.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The transfer does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The order is not draft (transfer-wrong-state), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'transferId', format: 'uuid' })
  async cancelTransfer(
    @Param('tenantId') tenantId: string,
    @Param('transferId') transferId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CancelTransferDto,
  ): Promise<TransferOrderResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(transferId, 'transferId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.cancelTransfer(
      {
        tenantId,
        actorUserId: session.userId,
        transferId,
        note: dto.note ?? undefined,
      },
      key,
    );
    return { transfer: { ...snapshot.transfer }, lines: snapshot.lines.map((line) => ({ ...line })) };
  }

  // ── cycle counts (Story 5-3) ─────────────────────────────────────────────

  @Post(':tenantId/movements/counts')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Creates an on-demand count task (counts.manage): one open task per bin, with the per-SKU expected quantities and the bin\'s state epoch FROZEN at task start — an epoch-mismatch recount or the scheduler creates the other tasks',
  })
  @ApiBody({ type: CreateCountDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: CreateCountResponse,
    description: 'Count task pending (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks counts.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse or the bin does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The bin already has a pending count task (count-task-open), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createCount(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateCountDto,
  ): Promise<CreateCountResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.createCount(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        binId: dto.binId,
        occurredAt: dto.occurredAt,
      },
      key,
    );
    return {
      countTask: { ...snapshot.countTask },
      lines: snapshot.lines.map((line) => ({ ...line })),
    };
  }

  @Post(':tenantId/movements/counts/:taskId/submit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiBearerAuth('device')
  @ApiOperation({
    summary:
      'Submits a count (counts.execute — either session family): every task line is recorded with its counted quantity; counted ≠ expected appends an open variance row; the bin\'s epoch is compared for EQUALITY under the locks — a mismatch flags the variances AND auto-creates a fresh recount task (never a stock write)',
    description:
      'Accepts EITHER session family on the one route (the compliance controller\'s precedent): a web session or a device badge-in session — the Count inbox task\'s submit. Every task line must be counted; a line the body does not name is 400 count-incomplete (a 0 count must be EXPLICITLY entered).',
  })
  @ApiBody({ type: SubmitCountDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: SubmitCountResponse,
    description: 'Count completed: the variances and, on an epoch conflict, the recount task (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, or a task line the body never counted (count-incomplete)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token of either family, or a device token without a badge-in session (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks counts.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The count task or a named SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The task is already completed (count-task-completed), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'taskId', format: 'uuid' })
  async submitCount(
    @Param('tenantId') tenantId: string,
    @Param('taskId') taskId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentAnySession() session: AnySession,
    @Body() dto: SubmitCountDto,
  ): Promise<SubmitCountResponse> {
    assertOwnTenantToken(session.session.tenantId, tenantId);
    assertUuidParam(taskId, 'taskId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    // The device arm is badge-in required (a bare enrollment credential
    // carries no operator — the badgeInRequired pattern).
    let actorUserId: string;
    if (session.family === 'device') {
      if (session.session.userId === null) {
        throw badgeInRequired();
      }
      actorUserId = session.session.userId;
    } else {
      actorUserId = session.session.userId;
    }
    const snapshot = await this.movements.submitCount(
      {
        tenantId,
        actorUserId,
        taskId,
        occurredAt: dto.occurredAt,
        lines: dto.lines.map((line: SubmitCountLineDto) => ({
          skuId: line.skuId,
          countedQuantity: line.countedQuantity,
        })),
      },
      key,
    );
    return {
      countTask: { ...snapshot.countTask },
      variances: snapshot.variances.map((variance) => ({ ...variance })),
      recountTaskId: snapshot.recountTaskId,
    };
  }

  @Put(':tenantId/movements/warehouses/:warehouseId/count-policies')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Upserts the warehouse\'s cycle-count policies (counts.manage): one row per (tenant, warehouse, ABC class) naming the scheduled count interval in days — a class with no row is never scheduled',
  })
  @ApiBody({ type: UpsertCountPoliciesDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: CountPoliciesResponse,
    description: 'The warehouse\'s policy set after the upsert (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body — an unknown abc_class or a non-positive interval (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks counts.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent first write of the same policy lost the unique-index race (conflict — retry), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async upsertCountPolicies(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpsertCountPoliciesDto,
  ): Promise<CountPoliciesResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.upsertCountPolicies(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId,
        occurredAt: dto.occurredAt,
        policies: dto.policies.map((policy) => ({
          abcClass: policy.abcClass,
          intervalDays: policy.intervalDays,
        })),
      },
      key,
    );
    return { policies: snapshot.policies.map((policy) => ({ ...policy })) };
  }

  @Get(':tenantId/movements/transfers')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Lists transfer orders (keyset cursor pagination — the read-only web surface, open to any member)',
  })
  @ApiOkResponse({
    type: TransferListResponse,
    description: 'The transfer page (newest first, per-transfer line/unit sums)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor), malformed warehouse filter, or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('A warehouse filter names a warehouse outside this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listTransfers(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: TransferListQuery,
  ): Promise<TransferListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const page = await this.movements.listTransfers(tenantId, {
      status: query.status,
      sourceWarehouseId: query.sourceWarehouseId,
      destWarehouseId: query.destWarehouseId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/movements/transfers/:transferId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'The transfer detail: the order, its lines, and BOTH legs\' ledger events in order, each carrying referenceDoc {kind:"transfer", transferId}',
  })
  @ApiOkResponse({
    type: TransferDetailResponse,
    description: 'The transfer detail (the two-leg audit read)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed transferId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The transfer does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'transferId', format: 'uuid' })
  async getTransfer(
    @Param('tenantId') tenantId: string,
    @Param('transferId') transferId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<TransferDetailResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(transferId, 'transferId');
    const detail = await this.movements.getTransfer(tenantId, transferId);
    return {
      transfer: { ...detail.transfer },
      lines: detail.lines.map((line) => ({ ...line })),
      events: detail.events.map((event) => ({ ...event })),
    };
  }
}

/** Movements uuid path params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'transferId' | 'taskId' | 'warehouseId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" parameter must be a uuid (got "${value}").`,
    );
  }
}

function badgeInRequired(): ProblemException {
  return new ProblemException(
    'unauthenticated',
    401,
    'Badge-in required',
    'This endpoint requires an operator badge-in session.',
  );
}

function assertOwnTenantToken(tokenTenantId: string, tenantId: string): void {
  if (tokenTenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The session token tenant does not own this path.',
    );
  }
}