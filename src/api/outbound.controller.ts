import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { DeviceSessionGuard, CurrentDeviceSession } from '../modules/tenancy/device-session.guard';
import type { DeviceSession, TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { OutboundFacade } from '../modules/outbound/outbound.facade';
import type { ListOrdersQuery } from '../modules/outbound/outbound.facade';
import type { OrderLineDto } from '../modules/outbound/outbound.dto';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CancelOrderDto,
  CreateOrderDto,
  CreateWavePolicyDto,
  DevicePackDto,
  DispatchOrderDto,
  DispatchResponse,
  GenerateWaveDto,
  OrderListQuery,
  OrderListResponse,
  OrderResponse,
  PackOrderDto,
  PackResponse,
  PickResponse,
  RecordPickDto,
  WaveListResponse,
  WavePolicyListResponse,
  WavePolicyResponse,
  WaveResponse,
} from '../modules/outbound/outbound.dto';

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
 * The outbound HTTP surface (Story 4.1): manual order entry, ingested-order
 * ingestion, cancellation, and the order reads — the api shell is the only
 * HTTP surface of the monolith, and every order mutation goes through
 * `OutboundFacade` (the command services re-evaluate the role against the
 * DB at entry). Backend-only in this story: the FE surface is story 4.2 (the
 * FE re-runs `api:generate` after merge).
 */
@ApiTags('outbound')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class OutboundController {
  constructor(@Inject(OutboundFacade) private readonly outbound: OutboundFacade) {}

  @Post(':tenantId/outbound/orders')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Creates an order (orders.manage) — manual entry or an ingested channel payload; acceptance reserves ATP per line (shortfall lines go backordered)',
  })
  @ApiBody({ type: CreateOrderDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: OrderResponse,
    description:
      'Order accepted with per-line reserved / shortfall quantities (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks orders.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse or a line\'s SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict), or a concurrent first delivery of the same channel payload (conflict — retry to read the settled result)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse), or the channel ref already created a DIFFERENT payload (order-source-conflict)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The atomic-decision store is unreachable — the creation fails closed, nothing written (reservation-store-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createOrder(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateOrderDto,
  ): Promise<OrderResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.createOrder(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        source: dto.source ?? 'manual',
        // Story 10.2: BASE units cross this edge. The command scales them
        // behind its replay lookup, where each line's SKU (and therefore its
        // declared precision) is already read — a precision refusal in front
        // of that lookup would answer 400 to an op that already committed.
        lines: dto.lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity })),
        // The channel arms are forwarded VERBATIM (present or not): the
        // command owns the required-together rule and 400s a manual order
        // that carries them — stripping them here would silently accept it.
        ...(dto.integrationId !== undefined || dto.externalEventId !== undefined
          ? { integrationId: dto.integrationId, externalEventId: dto.externalEventId }
          : {}),
      },
      key,
    );
    return { order: { ...snapshot.order, lines: snapshot.order.lines.map(toLineDto) } };
  }

  @Post(':tenantId/outbound/orders/:orderId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancels an accepted order (orders.manage) — every open per-line reservation is released; idempotent on replay and on an already-cancelled order',
  })
  @ApiBody({ type: CancelOrderDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: OrderResponse,
    description: 'The cancelled order (per-line holds released; the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key or path parameter (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks orders.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Order does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A consuming flow already claimed a hold (conflict), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The reservation store is unreachable (reservation-store-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async cancelOrder(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<OrderResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.cancelOrder(
      { tenantId, actorUserId: session.userId, orderId },
      key,
    );
    return { order: { ...snapshot.order, lines: snapshot.order.lines.map(toLineDto) } };
  }

  @Post(':tenantId/outbound/orders/:orderId/pack')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'pack.execute — verifies a fully-picked order’s parcel at the bench and moves it to Ready-to-Dispatch. The scan is compared against what was actually PICKED (never against what was ordered — after story 4.4 a short-picked order legitimately carries fewer units), and a discrepancy is refused naming the SKU, the picked quantity and the scanned quantity before anything is written. On a match, one zero-quantity pack.packed ledger event per order line, the accepted → ready_to_dispatch flip, the outbox event, the audit row and the idempotency key all commit in ONE transaction, and the packing-slip payload is returned. Weight and dimensions are optional.',
  })
  @ApiBody({ type: PackOrderDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: PackResponse,
    description:
      'The packing slip: per line the ordered / packed / shortfall quantities with the SKU code and name, the parcel’s measurements, and the pack.packed event each line was journalled as (the idempotency snapshot — a replay re-serves it, nothing re-packs)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key or path parameter, a malformed scan line, or a non-positive weight/dimension (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks pack.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Order, or a scanned SKU, does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The order is already packed, is cancelled, was never waved, had its whole plan withdrawn by a wave cancel (re-wave it), or still has a planned pick line (conflict, naming the outstanding line); or a concurrent idempotent request (conflict). Nothing is written') })
  @ApiResponse({ status: 422, ...problemJsonResponse('The scanned contents differ from what was picked — an extra SKU, a missing SKU or a wrong quantity (pack-mismatch, naming every divergent SKU with both quantities; nothing written). Also: idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async packOrder(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: PackOrderDto,
  ): Promise<PackResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.packOrder(
      {
        tenantId,
        actorUserId: session.userId,
        orderId,
        // Story 10.2: BASE units cross this edge (see `createOrder` above).
        scanned: dto.scanned.map((line) => ({
          skuId: line.skuId,
          qty: line.qty,
          // Story 10.3: handling-unit ids cross the edge untouched — they are
          // identities, not quantities. An empty array normalizes to absent
          // so the two spellings of "no units" hash identically.
          handlingUnitIds:
            line.handlingUnitIds !== undefined && line.handlingUnitIds.length > 0
              ? line.handlingUnitIds
              : undefined,
        })),
        // `@IsOptional()` lets an explicit `null` through — normalized to
        // absent so an unmeasured parcel hashes identically either way.
        weightGrams: dto.weightGrams ?? undefined,
        dimensionsMm: dto.dimensionsMm ?? undefined,
      },
      key,
    );
    return { pack: { ...snapshot.pack, lines: snapshot.pack.lines.map((line) => ({ ...line })) } };
  }

  @Post(':tenantId/outbound/orders/:orderId/dispatch')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'dispatch.execute — closes a packed order: the TERMINAL transition of the order state machine. One zero-quantity dispatch.dispatched ledger event per order line records the shipment (the units left stock at pick, so nothing moves), the order flips ready_to_dispatch → dispatched, and every committed reservation the order still owns is retired to released — the transition that finally restores the reserved counter and corrects ATP. The flip, the events, the retirements, the outbox event, the audit row and the idempotency key all commit in ONE transaction; the Valkey counter mirror follows the commit. Carrier and tracking number are optional free text. There is no un-dispatch: the arm is terminal.',
  })
  @ApiBody({ type: DispatchOrderDto, required: false })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: DispatchResponse,
    description:
      'The dispatch record: per line the ordered / dispatched / shortfall quantities with the SKU code and name and the dispatch.dispatched event it was journalled as, the carrier arms, and the reservation holds this dispatch retired (the idempotency snapshot — a replay re-serves it, nothing re-dispatches)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key or path parameter, or an over-long carrier / tracking value (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks dispatch.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Order does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The order is already dispatched under a different key, or is not packed — it reads accepted or cancelled (conflict, naming the status); or a concurrent idempotent request (conflict). Nothing is written') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async dispatchOrder(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: DispatchOrderDto,
  ): Promise<DispatchResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(orderId, 'orderId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.dispatchOrder(
      {
        tenantId,
        actorUserId: session.userId,
        orderId,
        // `@IsOptional()` lets an explicit `null` through — normalized to
        // absent so a dispatch with no carrier hashes identically either way.
        carrierName: dto.carrierName ?? undefined,
        trackingNumber: dto.trackingNumber ?? undefined,
      },
      key,
    );
    return {
      dispatch: {
        ...snapshot.dispatch,
        retiredReservationIds: [...snapshot.dispatch.retiredReservationIds],
        lines: snapshot.dispatch.lines.map((line) => ({ ...line })),
      },
    };
  }

  @Get(':tenantId/outbound/orders/:orderId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "One order's detail — per line the ordered / reserved / shortfall quantities and the hold's live state",
  })
  @ApiOkResponse({
    type: OrderResponse,
    description:
      'The order with its lines (oldest first); a cancelled order keeps its per-line release truth queryable',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed orderId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No order with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async getOrder(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<OrderResponse> {
    assertOwnTenant(session, tenantId);
    // A malformed (non-uuid) path param is a 400 (the inbound uuid-guard
    // rule) — before any facade call.
    assertUuidParam(orderId, 'orderId');
    const order = await this.outbound.getOrder(tenantId, orderId);
    if (order === null) {
      throw orderNotFound(orderId);
    }
    return { order: { ...order, lines: order.lines.map(toLineDto) } };
  }

  @Get(':tenantId/warehouses/:warehouseId/outbound/orders')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists one warehouse's orders, newest first (keyset cursor pagination)" })
  @ApiOkResponse({
    type: OrderListResponse,
    description: "The warehouse's order page (headers only — the detail read carries the lines; keyset cursor)",
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor or out-of-range limit (invalid-cursor / validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listOrders(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: OrderListQuery,
  ): Promise<OrderListResponse> {
    assertOwnTenant(session, tenantId);
    // A malformed (non-uuid) warehouseId is a 400 (the inbound uuid-guard
    // rule) — before any facade call.
    assertUuidParam(warehouseId, 'warehouseId');
    const listQuery: ListOrdersQuery = {
      cursor: query.cursor,
      limit: query.limit,
    };
    const page = await this.outbound.listOrders(tenantId, warehouseId, listQuery);
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  // ── waves and picklists (Story 4.2) ───────────────────────────────────────

  @Post(':tenantId/outbound/wave-policies')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Creates a wave policy (waves.manage) — the grouping rule a wave is generated under; its cutoff gates release, never generation',
  })
  @ApiBody({ type: CreateWavePolicyDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: WavePolicyResponse, description: 'The created policy (the idempotency snapshot)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks waves.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A policy of that name already exists in the warehouse, or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createWavePolicy(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateWavePolicyDto,
  ): Promise<WavePolicyResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.createWavePolicy(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        name: dto.name,
        grouping: dto.grouping,
        priority: dto.priority,
        maxOrders: dto.maxOrders,
        cutoffLocalTime: dto.cutoffLocalTime,
        carrierRef: dto.carrierRef,
      },
      key,
    );
    return { policy: { ...snapshot.policy } };
  }

  @Get(':tenantId/warehouses/:warehouseId/outbound/wave-policies')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists one warehouse's wave policies, newest first (keyset cursor pagination)" })
  @ApiOkResponse({ type: WavePolicyListResponse, description: "The warehouse's wave-policy page" })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor or out-of-range limit (invalid-cursor / validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listWavePolicies(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: OrderListQuery,
  ): Promise<WavePolicyListResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    const page = await this.outbound.listWavePolicies(tenantId, warehouseId, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Post(':tenantId/outbound/waves')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Generates a wave (waves.manage) — gathers accepted orders by policy into picklists (one per order, or one batched across orders) with the pick path in bins.code order',
  })
  @ApiBody({ type: GenerateWaveDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: WaveResponse,
    description: 'The planned wave with its picklists and pick lines in walk order (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks waves.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, policy, or a named order does not exist in this tenant/warehouse (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('An order is already on an open wave — one order belongs to at most one open wave; the problem names the claiming wave (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('No accepted order is free to wave (no-eligible-orders), the selection exceeds the policy cap (wave-cap-exceeded), or the idempotency key was reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async generateWave(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: GenerateWaveDto,
  ): Promise<WaveResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.generateWave(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        policyId: dto.policyId,
        // Forwarded verbatim: absent means "sweep every eligible order",
        // which is a different command than an empty explicit selection.
        ...(dto.orderIds === undefined ? {} : { orderIds: dto.orderIds }),
      },
      key,
    );
    return { wave: snapshot.wave };
  }

  @Post(':tenantId/outbound/waves/:waveId/release')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Releases a wave to the floor (waves.manage) — picklists go ready and a cancelled order's pick lines drop; refused once the policy cutoff has passed in Asia/Kolkata",
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: WaveResponse, description: 'The released wave (an already-released wave replays as an idempotent no-op — no second wave.released event)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key or path parameter (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks waves.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Wave does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse("The policy cutoff has passed for the Kolkata-local day and the wave stays planned (cutoff-passed), the wave is cancelled, or a concurrent idempotent request (conflict)") })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'waveId', format: 'uuid' })
  async releaseWave(
    @Param('tenantId') tenantId: string,
    @Param('waveId') waveId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<WaveResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(waveId, 'waveId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.releaseWave(
      { tenantId, actorUserId: session.userId, waveId },
      key,
    );
    return { wave: snapshot.wave };
  }

  @Post(':tenantId/outbound/waves/:waveId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancels a wave (waves.manage) — its picklists and pick lines go cancelled and its orders become eligible for waving again; no reservation and no stock moves',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: WaveResponse, description: 'The cancelled wave (idempotent on replay and on an already-cancelled wave)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key or path parameter (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks waves.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Wave does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'waveId', format: 'uuid' })
  async cancelWave(
    @Param('tenantId') tenantId: string,
    @Param('waveId') waveId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<WaveResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(waveId, 'waveId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.cancelWave(
      { tenantId, actorUserId: session.userId, waveId },
      key,
    );
    return { wave: snapshot.wave };
  }

  @Post(':tenantId/outbound/picks')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'pick.record — records one scan-verified pick exactly once (badge-in session required): the pick.picked ledger draw empties the scanned bin and the order line’s reservation settles held → committed in the SAME transaction; the line flips to picked. Story 4.3b: the optional binStateEpoch is compared under the bin’s row lock before any write and classifies a conflict by the AD-14 taxonomy — apply/settle answer 201, pick-bin-short is re-plannable, pick-unresolvable is terminal. Story 4.4: a qty BELOW the line’s plan is a short pick and needs a reasonCode — the draw, the whole hold’s release, the re-grant of the remainder, the line’s flip to short and the re-planned slice all commit together; a zero-unit short pick reports an empty bin and writes no ledger event and no picks row',
  })
  @ApiBody({ type: RecordPickDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: PickResponse,
    description:
      'Pick recorded: the pick snapshot with suggestion-vs-actual bin/batch (the idempotency snapshot — a replay re-serves it, nothing re-draws). On a short pick it also carries the shortfall, the reason, whether the hold was released and re-granted, and the slices the remainder was re-planned onto (empty on the partial-order path)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, a quantity ABOVE the line’s planned quantity, a short pick with no reasonCode or one outside the fixed set (the 400 names the whole set), a blocked bin (bin-blocked), a retired bin (bin-retired), a system bin, the wrong item scanned (wrong-item naming the expected SKU), or a serial-arm violation (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), unknown or revoked device (device-revoked), or the operator lacks picks.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, picklist line, order, SKU or bin does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('AD-14 case 3 — the bin’s state_epoch moved and it no longer covers the draw (pick-bin-short, naming the bin and its live on-hand; RE-PLANNABLE, the client keeps the op). AD-14 case 4 — a premise moved terminally: the hold is expired/terminal, or the line, picklist, wave or order was cancelled or already picked (pick-unresolvable; TERMINAL, the client quarantines with session attribution). Also: the wave is not yet released / the picklist is not yet ready (conflict, retryable), a concurrent idempotent request (conflict), or a serial that does not live in the scanned bin (serial-elsewhere). None of these persist anything and none consume the idempotency key') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse), or the bin drained before this (queued) pick replayed with NO bin epoch to prove it moved (insufficient-on-hand, naming the bin’s live on-hand — nothing persists; this is the pre-4.3b behaviour a device that has not refreshed still gets)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async recordPick(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: RecordPickDto,
  ): Promise<PickResponse> {
    assertOwnDeviceTenant(session.tenantId, tenantId);
    if (session.userId === null) {
      // A bare enrollment credential has no operator — badge-in first.
      throw badgeInRequired();
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.recordPick(
      {
        tenantId,
        deviceId: session.deviceId,
        operatorUserId: session.userId,
        warehouseId: dto.warehouseId,
        picklistId: dto.picklistId,
        picklistLineId: dto.picklistLineId,
        skuId: dto.skuId,
        binId: dto.binId,
        // Story 10.2: BASE units cross this edge. The pick command converts
        // and refuses a too-fine value behind its replay lookup — which is
        // what lets a device that queued a scan under looser rules still
        // replay it to its original 201.
        qty: dto.qty,
        occurredAt: dto.occurredAt,
        // `@IsOptional()` lets an explicit `"serials": null` through (the
        // mobile op payload always carries it) — normalize to absent so the
        // command's payload hash spreads an array, never null.
        serials: dto.serials ?? undefined,
        // Story 4.3b: the captured bin epoch rides straight through. It is
        // NOT part of the payload hash (an observation, not an intent), so a
        // replay carrying a different epoch still re-serves rather than
        // failing `idempotency-key-reuse` before the taxonomy can run.
        binStateEpoch: dto.binStateEpoch ?? null,
        // Story 4.4: `@IsOptional()` lets an explicit `"reasonCode": null`
        // through (a full-quantity pick from the device always carries it) —
        // normalized to absent so the payload hash of a whole pick stays
        // byte-identical to a pre-4.4 one.
        reasonCode: dto.reasonCode ?? undefined,
      },
      key,
    );
    return { pick: { ...snapshot.pick } };
  }

  @Post(':tenantId/outbound/packs')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'pack.execute — the DEVICE bench route (badge-in session required): the same packOrder command the tenant route delegates to, with the order id in the body. The scan is compared against what the order actually had PICKED; a discrepancy is refused (422 pack-mismatch) naming the SKU and both quantities before anything is written. On a match, the accepted → ready_to_dispatch flip, the zero-quantity pack.packed events, the outbox, the audit and the idempotency key commit in ONE transaction and the packing slip is returned. Parcel weight is optional; dimensions are NOT part of the device payload (the web surface keeps that arm)',
  })
  @ApiBody({ type: DevicePackDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: PackResponse,
    description:
      'Packed: the packing slip (the idempotency snapshot — a replay under the same key re-serves it, nothing re-packs)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed orderId, a malformed scan line, or a non-positive weight (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), unknown or revoked device (device-revoked), or the operator lacks pack.execute (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Order, or a scanned SKU, does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The order is already packed, is cancelled, was never waved, had its whole plan withdrawn by a wave cancel (re-wave it), still has a planned pick line, or a scanned handling unit is no longer active (conflict); or a concurrent idempotent request (conflict). Nothing is written') })
  @ApiResponse({ status: 422, ...problemJsonResponse('The scanned contents differ from what was picked — a wrong quantity, a missing or extra SKU (pack-mismatch, naming every divergent SKU with both quantities), a catch-weight count that does not equal the picked units, or a handling-unit id for a non-catch-weight SKU (validation-failed); nothing written. Also: idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async packOrderFromDevice(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: DevicePackDto,
  ): Promise<PackResponse> {
    assertOwnDeviceTenant(session.tenantId, tenantId);
    if (session.userId === null) {
      // A bare enrollment credential has no operator — badge-in first.
      throw badgeInRequired();
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.outbound.packOrder(
      {
        tenantId,
        actorUserId: session.userId,
        orderId: dto.orderId,
        // Deliberately parallel to the tenant pack route's normalization
        // (which this story leaves untouched, its route being frozen scope):
        // the empty handlingUnitIds → absent spelling is what keeps a
        // non-catch-weight pack's hash byte-identical to its pre-10.3 shape.
        // A drift between the two spellings would surface as
        // idempotency-key-reuse mysteries, not as a wrong pack — keep the two
        // copies identical.
        scanned: dto.scanned.map((line) => ({
          skuId: line.skuId,
          qty: line.qty,
          handlingUnitIds:
            line.handlingUnitIds != null && line.handlingUnitIds.length > 0
              ? line.handlingUnitIds
              : undefined,
        })),
        // `@IsOptional()` lets an explicit `null` through — normalized to
        // absent so an unmeasured parcel hashes identically either way.
        weightGrams: dto.weightGrams ?? undefined,
        // dimensionsMm deliberately ABSENT: the device never captures parcel
        // dimensions (the web surface keeps the arm), and an unmeasured
        // parcel hashes identically to its absence.
      },
      key,
    );
    return { pack: { ...snapshot.pack, lines: snapshot.pack.lines.map((line) => ({ ...line })) } };
  }

  @Get(':tenantId/outbound/waves/:waveId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "One wave's detail — its picklists and every pick line in walk order (bins.code ascending)" })
  @ApiOkResponse({ type: WaveResponse, description: 'The wave with its picklists and pick lines in walk order' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed waveId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No wave with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'waveId', format: 'uuid' })
  async getWave(
    @Param('tenantId') tenantId: string,
    @Param('waveId') waveId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<WaveResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(waveId, 'waveId');
    const wave = await this.outbound.getWave(tenantId, waveId);
    if (wave === null) {
      throw new ProblemException(
        'not-found',
        404,
        'Wave not found',
        `No wave with id "${waveId}" exists in this tenant.`,
      );
    }
    return { wave };
  }

  @Get(':tenantId/warehouses/:warehouseId/outbound/waves')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists one warehouse's waves, newest first (keyset cursor pagination)" })
  @ApiOkResponse({ type: WaveListResponse, description: "The warehouse's wave page (headers only — the detail read carries the picklists)" })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor or out-of-range limit (invalid-cursor / validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listWaves(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: OrderListQuery,
  ): Promise<WaveListResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    const page = await this.outbound.listWaves(tenantId, warehouseId, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }
}

/** One line serialized for the wire (the facade's snapshot fields, verbatim). */
function toLineDto(line: OrderLineDto): OrderLineDto {
  return { ...line };
}

/** Outbound uuid path params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'orderId' | 'warehouseId' | 'waveId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" path parameter must be a uuid (got "${value}").`,
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

/** The device-token twin of `assertOwnTenant` (the putaway controller shape). */
function assertOwnDeviceTenant(tokenTenantId: string, tenantId: string): void {
  if (tokenTenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The device token tenant does not own this path.',
    );
  }
}

function orderNotFound(orderId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Order not found',
    `No order with id "${orderId}" exists in this tenant.`,
  );
}

function assertOwnTenant(session: TenantSession, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The session token tenant does not own this path.',
    );
  }
}


