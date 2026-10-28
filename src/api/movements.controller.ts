import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { AnySessionGuard, CurrentAnySession, type AnySession } from '../modules/tenancy/any-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { MovementsFacade } from '../modules/movements/transfer.facade';
import { blindSubmitResponse } from '../modules/movements/count.command';
import type { StockTakeSummary } from '../modules/movements/stock-take.command';
import type { StockTakeSummaryDto } from '../modules/movements/stock-take.dto';
import { ABC_CLASSES } from '../shared/primitives/abc-class';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CancelTransferDto,
  ConfirmInboundDto,
  ConfirmOutboundDto,
  ConfirmOutboundLineDto,
  CreateTransferDto,
  MoveStockDto,
  MoveStockResponse,
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
  CreateCountsBulkResponse,
  SubmitCountResponse,
  CountPoliciesResponse,
  CountTaskDetailResponse,
  CountTaskListQuery,
  CountTaskListResponse,
} from '../modules/movements/count.dto';
// No eslint-disable... EXCEPT one below: CountVarianceListQuery is listed
// with the response bodies for a REASON — a Query DTO's class must stay a
// runtime value (in design:paramtypes) for the ValidationPipe's transform;
// a type-only import erases it and the pipe silently stops shaping the
// query (this file's other blocks carry the same disable for the same
// reason).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CountVarianceListResponse,
  ResolveCountVarianceDto,
  ResolveCountVarianceResponse,
  SetVariancePolicyDto,
  VariancePolicyResponse,
  CountVarianceListQuery,
  CancelCountTaskResponse,
} from '../modules/movements/count.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AbandonStockTakeDto,
  AbandonStockTakeResponse,
  CloseStockTakeDto,
  CloseStockTakeResponse,
  RecountStockTakeBinsDto,
  RecountStockTakeResponse,
  StartStockTakeDto,
  StartStockTakeResponse,
  StockTakeDetailResponse,
  StockTakeListQuery,
  StockTakeListResponse,
  StockTakeReportQuery,
  StockTakeVarianceListResponse,
  StockTakeVariancesQuery,
} from '../modules/movements/stock-take.dto';
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
@ApiExtraModels(ProblemDetailsDto, CreateCountResponse, CreateCountsBulkResponse)
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
  @ApiResponse({ status: 409, ...problemJsonResponse('The order is not in_transit (transfer-wrong-state), the scanned bin\'s state epoch is stale (transfer-bin-changed — the mobile client re-plans), or a destination placement gate refused — retired, blocked, storage-class mismatch (bin-retired, bin-blocked, bin-storage-mismatch), a landing SKU of another client than the bin\'s dedicated client (bin-client-mismatch naming the bin, its client and the SKU — story 1-5b; the receive-time landing-bin override recovers it), co-location with goods that must be kept apart (bin-segregation-conflict naming both SKUs, the facts that fired and the rule — the putaway rules, stories 12-2, 1-6b), bulk-asset occupancy (bin-occupancy-conflict), or the load gates (bin-full, bin-overweight, bin-volume-exceeded, bin-item-oversize) — the order stays in_transit; or a concurrent idempotent request (conflict)') })
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
        // Story 3-5b (A1/K3) — from the session family, never the body.
        surface: session.family === 'device' ? 'device' : 'web',
      },
      key,
    );
    return { transfer: { ...snapshot.transfer }, events: snapshot.events.map((event) => ({ ...event })) };
  }

  // ── the bin-to-bin move (story 3-1) ─────────────────────────────────────

  @Post(':tenantId/warehouses/:warehouseId/inventory/moves')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiBearerAuth('device')
  @ApiOperation({
    summary:
      'Moves stock between two bins of one warehouse (stock.move — either session family): the handheld\'s queued stock.move op or the web Moves page — one stock.moved ledger event per arm (a batch arm, or one per serial), both bins on each event',
    description:
      'Accepts EITHER session family on the one route (the inbound-confirm precedent): a web session, or a device badge-in session (a bare enrollment credential → 401; an op captured by another operator → 409 operator-mismatch). The command re-reads the device, the operator\'s role and the target\'s placement gates in its own transaction. No outbox event; ATP is unchanged.',
  })
  @ApiBody({ type: MoveStockDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: MoveStockResponse, description: 'Moved: the move id and its events (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body — the same bin on both ends, qty not equal to the serial count, a duplicate serial, more than 500 serials, a batchCode beside serials, a reason outside the vocabulary or `other` without a note, a note over 200 characters, occurredAt sent from the web or missing/malformed on the handheld, a batch missing on a batch-tracked SKU or sent for an untracked one, serials missing on a serial-tracked SKU or sent for another, a catch-weight SKU, or a quantity finer than the SKU\'s unit allows (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token of either family, or a device token without a badge-in session (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), an unknown or revoked device (device-revoked), the caller lacks stock.move (role-denied), or the origin or target bin is secure/cage-class and the actor lacks secure.move (role-denied, FR-42)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse, the SKU, either bin (in this warehouse) or the batch does not exist (not-found), or a serial number is unknown for the SKU (serial-unknown)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A system bin on either end (bin-not-movable), a retired origin or target (bin-retired), the target blocked or refused by a placement gate (bin-blocked, bin-storage-mismatch, bin-client-mismatch, bin-segregation-conflict, bin-occupancy-conflict, bin-full, bin-overweight, bin-volume-exceeded, bin-item-oversize), an open reconcile quarantine on the origin or target scope (move-scope-quarantined), a kit SKU (kit-cannot-hold-stock), the origin holding less than the move (move-source-short), a serial located in another bin (serial-elsewhere), the op captured by another operator (operator-mismatch), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async moveStock(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentAnySession() session: AnySession,
    @Body() dto: MoveStockDto,
  ): Promise<MoveStockResponse> {
    assertOwnTenantToken(session.session.tenantId, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    // The device arm is badge-in required (a bare enrollment credential
    // carries no operator); X-Op-Operator was checked by the guard.
    let actorUserId: string;
    let deviceId: string | null;
    if (session.family === 'device') {
      if (session.session.userId === null) {
        throw badgeInRequired();
      }
      actorUserId = session.session.userId;
      deviceId = session.session.deviceId;
    } else {
      actorUserId = session.session.userId;
      deviceId = null;
    }
    const snapshot = await this.movements.moveStock(
      {
        tenantId,
        actorUserId,
        deviceId,
        warehouseId,
        skuId: dto.skuId,
        fromBinId: dto.fromBinId,
        toBinId: dto.toBinId,
        qty: dto.qty,
        batchCode: dto.batchCode ?? null,
        serials: dto.serials ?? null,
        reasonCode: dto.reasonCode,
        note: dto.note ?? null,
        occurredAt: dto.occurredAt ?? null,
      },
      key,
    );
    return { moveId: snapshot.moveId, events: snapshot.events.map((event) => ({ ...event })) };
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
      'Creates on-demand count tasks (counts.manage). With binId: one open task per bin, with the per-SKU expected quantities and the bin\'s state epoch FROZEN at task start (unchanged). With binIds (1–500) or zoneId (story 3-5a): one task per eligible bin, NOT pushed to handhelds; bins with an open task (and listed system or retired bins) are skipped and listed',
  })
  @ApiBody({ type: CreateCountDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      'The idempotency snapshot: CreateCountResponse for binId (count task pending), CreateCountsBulkResponse for binIds/zoneId (created and skipped)',
    schema: { oneOf: [{ $ref: getSchemaPath(CreateCountResponse) }, { $ref: getSchemaPath(CreateCountsBulkResponse) }] },
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body (not exactly one of binId/binIds/zoneId, a repeated bin), or a system bin on the single create (Receiving/QC-hold/In-Transit — counts target storage bins only) (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks counts.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse, the zone or a bin does not exist in this tenant — including a bin deleted between the listing and the create (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The single bin is frozen by a stock take (bin-in-stock-take — checked first), already has a pending count task (count-task-open), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse), or more than 500 bins named or in the zone (too-many-bins)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createCount(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateCountDto,
  ): Promise<CreateCountResponse | CreateCountsBulkResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    // `null` is absent (an explicit null must not reach a lookup or the
    // bulk shape checks as a value).
    const binId = dto.binId ?? undefined;
    const binIds = dto.binIds ?? undefined;
    const zoneId = dto.zoneId ?? undefined;
    const named = [binId, binIds, zoneId].filter((value) => value !== undefined).length;
    if (named !== 1) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Name one bin, a list of bins, or a zone',
        'The body must carry exactly one of binId, binIds or zoneId.',
      );
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    if (binId === undefined) {
      // Story 3-5a — the bulk arm (bins or a zone).
      const bulk = await this.movements.createCountsBulk(
        {
          tenantId,
          actorUserId: session.userId,
          warehouseId: dto.warehouseId,
          binIds,
          zoneId,
          occurredAt: dto.occurredAt,
        },
        key,
      );
      return {
        created: bulk.created.map((entry) => ({
          taskId: entry.taskId,
          binId: entry.binId,
          binCode: entry.binCode,
          lineCount: entry.lineCount,
        })),
        skipped: bulk.skipped.map((entry) => ({ binId: entry.binId, binCode: entry.binCode, reason: entry.reason })),
      };
    }
    const snapshot = await this.movements.createCount(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        binId,
        occurredAt: dto.occurredAt,
      },
      key,
    );
    return {
      countTask: { ...snapshot.countTask },
      lines: snapshot.lines.map((line) => ({ ...line })),
    };
  }

  @Get(':tenantId/movements/counts')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Lists count tasks (story 3-5a — keyset cursor, newest first; warehouse/status/origin/bin filters; any staff role, never capability-gated). Exempt from the client filter (a bin may hold several clients\' goods) and carries no quantity',
  })
  @ApiOkResponse({ type: CountTaskListResponse, description: 'The count-task page (newest first, keyset cursor)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed filter, cursor or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid web session token (a device token is refused)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse filter names a warehouse outside this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listCountTasks(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: CountTaskListQuery,
  ): Promise<CountTaskListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const page = await this.movements.listCountTasks(tenantId, {
      warehouseId: query.warehouseId,
      status: query.status,
      origin: query.origin,
      binId: query.binId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((entry) => ({ ...entry })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/movements/counts/:taskId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'One count task (story 3-5a): its lines with expected beside counted, its variances, the recount task a variance names and the epoch-conflict recount. The ONLY read showing an expected quantity — a GATED read: counts.manage or variances.resolve (an operator is 403); web staff sessions only (a device token is 401, a portal token 403)',
  })
  @ApiOkResponse({ type: CountTaskDetailResponse, description: 'The count task detail' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed taskId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid web session token — a device token is refused (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), a client-portal session, or a role with neither counts.manage nor variances.resolve (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The count task does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'taskId', format: 'uuid' })
  async getCountTask(
    @Param('tenantId') tenantId: string,
    @Param('taskId') taskId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<CountTaskDetailResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(taskId, 'taskId');
    const detail = await this.movements.getCountTask(tenantId, session.userId, taskId);
    return {
      task: { ...detail.task },
      lines: detail.lines.map((line) => ({ ...line })),
      variances: detail.variances.map((variance) => ({ ...variance })),
      recountTaskId: detail.recountTaskId,
      conflictRecountTaskId: detail.conflictRecountTaskId,
    };
  }

  @Post(':tenantId/movements/counts/:taskId/submit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiBearerAuth('device')
  @ApiOperation({
    summary:
      'Submits a count (counts.execute — either session family): every task line is recorded with its counted quantity, and a SKU found in the bin is added with an expected of 0; counted ≠ expected appends an open variance row; the bin\'s epoch is compared for EQUALITY under the locks — a mismatch flags the variances AND auto-creates a fresh recount task (never a stock write). Story 3-5a — the response is BLIND: variances is always empty',
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
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, a task line the body never counted (count-incomplete), or a found line (not on the task) of a kit or of a batch-, serial- or catch-weight-tracked SKU (count-found-sku-not-countable)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token of either family, or a device token without a badge-in session (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks counts.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The count task, a named SKU, or the count task\'s bin does not exist in this tenant — the bin may have been deleted while the count was in progress ("The count task\'s bin no longer exists in this tenant.") (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The task is already completed (count-task-completed) or was cancelled (count-task-cancelled), or a concurrent idempotent request (conflict)') })
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
    // Story 3-5a — the one blind projector, again at the edge: whatever the
    // stored snapshot holds, the wire carries exactly these keys.
    const blind = blindSubmitResponse(snapshot);
    return {
      countTask: { ...blind.countTask },
      variances: [],
      recountTaskId: blind.recountTaskId,
    };
  }

  // ── story 3-5b: cancel a count task ─────────────────────────────────────

  @Post(':tenantId/movements/counts/:taskId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancels a PENDING count task (counts.manage — story 3-5b). A stock take\'s task is refused (abandon the take); a device submit that lands later answers 409 count-task-cancelled; the scheduler may mint the bin again at its next due tick',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: CancelCountTaskResponse, description: 'The task cancelled (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed taskId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid web session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks counts.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The count task does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The task is completed (count-task-completed) or already cancelled (count-task-cancelled), it belongs to a stock take (stock-take-task), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'taskId', format: 'uuid' })
  async cancelCountTask(
    @Param('tenantId') tenantId: string,
    @Param('taskId') taskId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<CancelCountTaskResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(taskId, 'taskId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.cancelCountTask({ tenantId, actorUserId: session.userId, taskId }, key);
    return { countTask: { ...snapshot.countTask } };
  }

  // ── story 3-5b: the stock take ───────────────────────────────────────────
  // Literal segments (`stock-takes`, `…/variances`, `…/report`) never sit
  // beside a sibling `:param` of the same depth here (§6 route order).

  @Post(':tenantId/movements/warehouses/:warehouseId/stock-takes')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Starts a stock take (counts.manage — story 3-5b): freezes every storage bin of the warehouse (or of the named zones) — every stock movement into or out of them is refused (409 bin-frozen) until the take is closed or abandoned, except a handheld op and a quarantine — and creates one count task per bin (adopting a pending one), empty bins included. At most 3,000 frozen bins per warehouse',
  })
  @ApiBody({ type: StartStockTakeDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: StartStockTakeResponse, description: 'The take counting (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body — no zones, more than 50, a repeated zone, a note over 200 characters (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid web session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks counts.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse or a zone does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A bin is already frozen by another take (stock-take-overlap, naming it), a count task was created on a bin while the take started (conflict — retry), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('No storage bin in scope (stock-take-empty), more than 3,000 bins frozen in the warehouse (too-many-bins), or the key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async startStockTake(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: StartStockTakeDto,
  ): Promise<StartStockTakeResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.startStockTake(
      { tenantId, actorUserId: session.userId, warehouseId, zoneIds: dto.zoneIds ?? null, note: dto.note ?? null },
      key,
    );
    return { ...snapshot, stockTake: stockTakeDto(snapshot.stockTake) };
  }

  @Get(':tenantId/movements/stock-takes')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lists stock takes (story 3-5b — newest first, keyset cursor; warehouse and status filters; any staff role, no quantities)' })
  @ApiOkResponse({ type: StockTakeListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed filter, cursor or limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid web session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse filter names a warehouse outside this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listStockTakes(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: StockTakeListQuery,
  ): Promise<StockTakeListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const page = await this.movements.listStockTakes(tenantId, {
      warehouseId: query.warehouseId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map((entry) => ({ stockTake: stockTakeDto(entry.stockTake), progress: { ...entry.progress } })),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':tenantId/movements/stock-takes/:stockTakeId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'One stock take (story 3-5b): the dashboard — totals, per-zone progress, the bins that need a recount, the handheld writes admitted after the freeze, and the openVarianceDigest the close sends back. No quantities; any staff role',
  })
  @ApiOkResponse({ type: StockTakeDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed stockTakeId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid web session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The stock take does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'stockTakeId', format: 'uuid' })
  async getStockTake(
    @Param('tenantId') tenantId: string,
    @Param('stockTakeId') stockTakeId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<StockTakeDetailResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(stockTakeId, 'stockTakeId');
    const detail = await this.movements.getStockTake(tenantId, stockTakeId);
    return {
      stockTake: stockTakeDto(detail.stockTake),
      totals: { ...detail.totals },
      zones: detail.zones.map((zone) => ({ ...zone })),
      recountRequiredBins: detail.recountRequiredBins.map((entry) => ({ ...entry })),
      recountRequiredCount: detail.recountRequiredCount,
      openVarianceDigest: detail.openVarianceDigest,
    };
  }

  @Get(':tenantId/movements/stock-takes/:stockTakeId/variances')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "A stock take's variances (story 3-5b): expected beside counted, the owner-only flag, the unposted refusal once closed — keyset by bin code. A GATED read: counts.manage or variances.resolve (an operator is 403); web staff sessions only",
  })
  @ApiOkResponse({ type: StockTakeVarianceListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed stockTakeId, status, cursor or limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid web session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), a client-portal session, or a role with neither counts.manage nor variances.resolve (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The stock take does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'stockTakeId', format: 'uuid' })
  async listStockTakeVariances(
    @Param('tenantId') tenantId: string,
    @Param('stockTakeId') stockTakeId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: StockTakeVariancesQuery,
  ): Promise<StockTakeVarianceListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(stockTakeId, 'stockTakeId');
    const page = await this.movements.listStockTakeVariances(tenantId, session.userId, stockTakeId, {
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((entry) => ({ ...entry })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/movements/stock-takes/:stockTakeId/report')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "A stock take's client report as CSV or Excel (story 3-5b): one row per (SKU, bin) of each bin's latest count — book, counted, variance and the outcome as of the close (matched | adjusted | unposted:<code> | open). Optionally one client. Counted bins only. Allowed while counting, marked provisional (a first column status). Gated: counts.manage or variances.resolve",
    description: 'The `Content-Disposition` filename is not readable cross-origin — a client names the file itself.',
  })
  @ApiProduces('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({
    status: 200,
    description: 'The report file',
    content: {
      'text/csv': { schema: { type: 'string', format: 'binary' } },
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed stockTakeId or clientId, or a missing/unknown format (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid web session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), a client-portal session, or a role with neither counts.manage nor variances.resolve (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The stock take or the client does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'stockTakeId', format: 'uuid' })
  async downloadStockTakeReport(
    @Param('tenantId') tenantId: string,
    @Param('stockTakeId') stockTakeId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: StockTakeReportQuery,
    @Res() res: Response,
  ): Promise<void> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(stockTakeId, 'stockTakeId');
    const file = await this.movements.stockTakeReport(tenantId, session.userId, stockTakeId, {
      format: query.format,
      clientId: query.clientId ?? null,
    });
    res.status(200);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.body.length));
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(file.body);
  }

  @Post(':tenantId/movements/stock-takes/:stockTakeId/recount')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Recounts selected bins of a counting stock take (variances.resolve — story 3-5b): a take-stamped recount task per bin (never pushed), and the bin's open variances in the take marked recounted",
  })
  @ApiBody({ type: RecountStockTakeBinsDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: RecountStockTakeResponse, description: 'The recounts (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, no bins, more than 500, a repeated bin, or a bin outside the take (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid web session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks variances.resolve (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The stock take does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The take is not counting (stock-take-not-counting), a named bin already has a pending task (count-task-open), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'stockTakeId', format: 'uuid' })
  async recountStockTakeBins(
    @Param('tenantId') tenantId: string,
    @Param('stockTakeId') stockTakeId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RecountStockTakeBinsDto,
  ): Promise<RecountStockTakeResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(stockTakeId, 'stockTakeId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.recountStockTakeBins({ tenantId, actorUserId: session.userId, stockTakeId, binIds: dto.binIds }, key);
    return {
      stockTake: stockTakeDto(snapshot.stockTake),
      recounts: snapshot.recounts.map((entry) => ({ ...entry })),
      recountedVarianceCount: snapshot.recountedVarianceCount,
    };
  }

  @Post(':tenantId/movements/stock-takes/:stockTakeId/close')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Posts and closes a stock take (variances.resolve — story 3-5b): approved once against the openVarianceDigest (owner when any open variance is over its frozen threshold), then each open variance is posted as a stock.adjusted correction in batches of 200, the freeze lifted bin by bin; a variance the adjustment guards refuse stays open and is listed unposted. A retry, or any close on a posting take, resumes the batches",
  })
  @ApiBody({ type: CloseStockTakeDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: CloseStockTakeResponse, description: 'The take closed (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed openVarianceDigest (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid web session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), the caller lacks variances.resolve (role-denied), or an open variance is over its frozen threshold and the caller is not the owner (variance-owner-required, naming them)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The stock take does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The take is closed or abandoned (stock-take-not-counting), bins are still pending (stock-take-incomplete), counted bins moved since their count (stock-take-recount-required, listing up to 20 and the total), the open variances changed since they were reviewed (stock-take-changed), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'stockTakeId', format: 'uuid' })
  async closeStockTake(
    @Param('tenantId') tenantId: string,
    @Param('stockTakeId') stockTakeId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CloseStockTakeDto,
  ): Promise<CloseStockTakeResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(stockTakeId, 'stockTakeId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.closeStockTake(
      { tenantId, actorUserId: session.userId, stockTakeId, openVarianceDigest: dto.openVarianceDigest },
      key,
    );
    return {
      stockTake: stockTakeDto(snapshot.stockTake),
      postedCount: snapshot.postedCount,
      unposted: snapshot.unposted.map((entry) => ({ ...entry })),
    };
  }

  @Post(':tenantId/movements/stock-takes/:stockTakeId/abandon')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Abandons a counting stock take (counts.manage — story 3-5b): its pending tasks are cancelled and the freeze lifted. Nothing is posted; the variances stay open on the variance queue',
  })
  @ApiBody({ type: AbandonStockTakeDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: AbandonStockTakeResponse, description: 'The take abandoned (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a note over 200 characters (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid web session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks counts.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The stock take does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The take is posting, closed or abandoned (stock-take-not-counting), a recount was created meanwhile (conflict — retry), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'stockTakeId', format: 'uuid' })
  async abandonStockTake(
    @Param('tenantId') tenantId: string,
    @Param('stockTakeId') stockTakeId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: AbandonStockTakeDto,
  ): Promise<AbandonStockTakeResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(stockTakeId, 'stockTakeId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.abandonStockTake({ tenantId, actorUserId: session.userId, stockTakeId, note: dto.note ?? null }, key);
    return { stockTake: stockTakeDto(snapshot.stockTake), cancelledTaskCount: snapshot.cancelledTaskCount, releasedTaskCount: snapshot.releasedTaskCount };
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

  @Get(':tenantId/movements/warehouses/:warehouseId/count-policies')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Returns the warehouse\'s cycle-count policies, sorted by ABC class (story 3-5a; any staff role — a class with no row is never scheduled)',
  })
  @ApiOkResponse({ type: CountPoliciesResponse, description: 'The warehouse\'s policy set (possibly empty)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed warehouseId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async getCountPolicies(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<CountPoliciesResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    const snapshot = await this.movements.getCountPolicies(tenantId, warehouseId);
    return { policies: snapshot.policies.map((policy) => ({ ...policy })) };
  }

  @Delete(':tenantId/movements/warehouses/:warehouseId/count-policies/:abcClass')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Unschedules one ABC class in a warehouse (story 3-5a, counts.manage): the policy row is removed, so the scheduler stops minting that class\'s tasks; open tasks stay. Answers the remaining policy set',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: CountPoliciesResponse,
    description: 'The warehouse\'s remaining policy set (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed warehouseId, or an unknown ABC class (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks counts.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouse does not exist, or it has no policy for this class (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different request (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'abcClass', enum: [...ABC_CLASSES] })
  async deleteCountPolicy(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Param('abcClass') abcClass: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<CountPoliciesResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.deleteCountPolicy(
      { tenantId, actorUserId: session.userId, warehouseId, abcClass },
      key,
    );
    return { policies: snapshot.policies.map((policy) => ({ ...policy })) };
  }

  // ── variance resolution (Story 5-4) ───────────────────────────────────────

  @Put(':tenantId/movements/variance-policies')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Upserts the tenant\'s variance-threshold policy (variances.resolve): the |delta| ceiling (base units) above which a variance resolves by owner only — a submit freezes the threshold onto every variance row it writes; null disables the routing',
  })
  @ApiBody({ type: SetVariancePolicyDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: VariancePolicyResponse,
    description: 'The policy row after the upsert (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body — a negative/non-whole threshold or one above the stored column bound (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks variances.resolve (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent first write of the same policy lost the unique-index race (conflict — retry), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async setVariancePolicy(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: SetVariancePolicyDto,
  ): Promise<VariancePolicyResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return await this.movements.setVariancePolicy(
      { tenantId, actorUserId: session.userId, quantityThreshold: dto.quantityThreshold ?? null },
      key,
    );
  }

  @Get(':tenantId/movements/variance-policies')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Returns the tenant\'s variance-threshold policy, or 404 when unset (the routing is disabled; never capability-gated)',
  })
  @ApiOkResponse({
    type: VariancePolicyResponse,
    description: "The tenant's policy row",
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No policy row exists — the threshold routing is disabled (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async getVariancePolicy(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<VariancePolicyResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const snapshot = await this.movements.getVariancePolicy(tenantId);
    if (snapshot === null) {
      throw new ProblemException(
        'not-found',
        404,
        'No variance threshold policy',
        'This tenant has no count_variance_policies row — the threshold routing is disabled (PUT a threshold to enable).',
      );
    }
    return snapshot;
  }

  @Get(':tenantId/movements/variances')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Lists count variances (keyset cursor pagination, newest first, status/warehouse-filterable; never capability-gated — the resolving mutation is variances.resolve)',
  })
  @ApiOkResponse({
    type: CountVarianceListResponse,
    description: "The tenant's variance page (newest first, keyset cursor)",
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed status/warehouseId query, cursor, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listCountVariances(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: CountVarianceListQuery,
  ): Promise<CountVarianceListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const page = await this.movements.listCountVariances(tenantId, {
      status: query.status,
      warehouseId: query.warehouseId,
      clientId: query.clientId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((entry) => ({ ...entry })), nextCursor: page.nextCursor };
  }

  @Post(':tenantId/movements/variances/:varianceId/resolve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Resolves one open count variance (variances.resolve — owner + Ops Manager): approve_adjust applies the counted−expected delta as stock.adjusted ledger events (the task\'s frozen bin epoch must still EQUAL the live one), or recount mints a recount task and re-bases the variance; an over-threshold variance resolves by owner only',
  })
  @ApiBody({ type: ResolveCountVarianceDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: ResolveCountVarianceResponse,
    description: 'The resolution (the idempotency snapshot): the variance in its terminal state, plus the approve arm\'s correction',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, consulted seqs this warehouse\'s ledger never wrote, or an approve-adjust guard refusal (bin retired / kit / catch-weight / batch parity) from the correction\'s re-execution (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), the caller lacks variances.resolve (role-denied), or an over-threshold variance resolved by a role below owner (variance-owner-required)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The variance, its count task, or its bin does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The variance belongs to a counting or posting stock take (variance-in-stock-take — the take\'s own verbs resolve it), is already resolved (variance-resolved), the task\'s frozen bin epoch no longer matches (variance-basis-moved — recount is the remedy), the bin already has an open count task on the RECOUNT arm (count-task-open — approve_adjust under an open sibling task is legal), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'varianceId', format: 'uuid' })
  async resolveCountVariance(
    @Param('tenantId') tenantId: string,
    @Param('varianceId') varianceId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ResolveCountVarianceDto,
  ): Promise<ResolveCountVarianceResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(varianceId, 'varianceId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.movements.resolveCountVariance(
      {
        tenantId,
        actorUserId: session.userId,
        varianceId,
        decision: dto.decision,
        consideredEventSeqs: dto.consideredEventSeqs ?? undefined,
        occurredAt: dto.occurredAt,
      },
      key,
    );
    return {
      // Story 9-3a: a resolve snapshot stored before 9-3a carries no
      // `ledgerLinked` — such a resolution recorded no event, so it is false.
      variance: { ...snapshot.variance, ledgerLinked: snapshot.variance.ledgerLinked ?? false },
      stockCorrection:
        snapshot.stockCorrection === null
          ? null
          : {
              eventId: snapshot.stockCorrection.eventId,
              seq: snapshot.stockCorrection.seq,
              onHand: { ...snapshot.stockCorrection.onHand },
            },
    };
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
      clientId: query.clientId,
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
function assertUuidParam(value: string, name: 'transferId' | 'taskId' | 'warehouseId' | 'varianceId' | 'stockTakeId'): void {
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

/** Story 3-5b — a take summary copied key by key (a mutable DTO). */
function stockTakeDto(summary: StockTakeSummary): StockTakeSummaryDto {
  return { ...summary, zoneIds: summary.zoneIds === null ? null : [...summary.zoneIds] };
}
