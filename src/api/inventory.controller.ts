import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { AnySessionGuard, CurrentAnySession, type AnySession } from '../modules/tenancy/any-session.guard';
import { AdjustmentSubmission } from '../modules/tenancy/adjustment-submission';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { CatalogFacade } from '../modules/catalog/catalog.facade';
import { InventoryFacade } from '../modules/inventory/inventory.facade';
import { BatchBlockResponse, BlockBatchDto, UnblockBatchDto } from '../modules/catalog/catalog.dto';
import type { LedgerTimelineQuery } from '../modules/inventory/inventory.facade';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AdjustmentDecisionResponse,
  AdjustmentPendingListResponse,
  AdjustmentPendingsQuery,
  AdjustmentPolicyDto,
  AdjustmentPolicyResponse,
  BatchDetailResponse,
  BatchListQuery,
  BatchListItemDto,
  BatchListResponse,
  ChainBreakDto,
  LedgerAnchorListResponse,
  LedgerAnchorsQuery,
  LedgerEventListResponse,
  LedgerIntegrityResponse,
  LedgerProofResponse,
  LedgerEventsQuery,
  SerialDetailResponse,
  StockAdjustmentDto,
  StockAdjustmentPendingResponse,
  StockAdjustmentResponse,
  StockListQuery,
  StockListResponse,
} from '../modules/inventory/inventory.dto';
import { assertInstantRange } from '../shared/primitives/instant-range';

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
 * The inventory HTTP surface (Story 2.1): the manual `stock.adjustment`
 * command and the event-timeline read — the api shell is the only HTTP
 * surface of the monolith. Every stock mutation goes through
 * `InventoryFacade`; the ledger core is not HTTP-exposed beyond these two
 * routes (replay/verify/anchor are consumed by Story 2.2, not HTTP).
 *
 * Story 2.5 adds the projection/traceability READS (additive, no new
 * writes, no capability gating): the stock list (on-hand per warehouse),
 * the FEFO-ordered batch list and the batch/serial detail routes (the api
 * layer composing catalog identity × inventory state, the 2.4 precedent),
 * plus the timeline's additive `batchRef`/`serialRef`/`referenceDoc`
 * passthroughs. Reservation/ATP routes stay facade-only until Epic 4.
 */
@ApiTags('inventory')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class InventoryController {
  constructor(
    @Inject(InventoryFacade) private readonly inventoryFacade: InventoryFacade,
    // The batch/serial detail reads (Story 2.5). Story 3-2b moved the 2.4
    // adjustment composition (identity ensure, FEFO, the capability assert
    // before it) into the tenancy `AdjustmentSubmission` below.
    @Inject(CatalogFacade) private readonly catalogFacade: CatalogFacade,
    // Story 3-2b — the one adjustment submission path (tenancy), shared with
    // the review queue's Apply of a rejected `stock.adjust` device op.
    @Inject(AdjustmentSubmission) private readonly adjustments: AdjustmentSubmission,
  ) {}

  @Post(':tenantId/inventory/adjustments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AnySessionGuard)
  @ApiBearerAuth()
  @ApiBearerAuth('device')
  @ApiOperation({
    summary: 'Records a manual stock adjustment (one ledger event + on-hand projection in one commit; over a tenant approval threshold — or, story 3-2b, from a request-only holder — it PENDS instead: 202)',
    description:
      "Accepts EITHER session family on the one route (story 3-2b, the move's precedent): a web session, or a device badge-in session — the handheld's queued `stock.adjust` op (a bare enrollment credential → 401; an op captured by another operator → 409 operator-mismatch; `occurredAt` is required there). A holder of stock.adjust applies under the threshold and pends over it; a holder of only stock.adjust.request (the operator) always pends for the owner (pendReason 'approval-required').",
  })
  @ApiBody({ type: StockAdjustmentDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: StockAdjustmentResponse,
    description: 'Adjustment committed: the ledger event snapshot plus the resulting on-hand quantity',
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    type: StockAdjustmentPendingResponse,
    description: "Story 5-2: |quantityDelta| exceeds the tenant's policy threshold (pendReason 'threshold'), or — story 3-2b — the requester holds only stock.adjust.request (pendReason 'approval-required'): the adjustment PENDS (no ledger event, no on-hand change) until an Owner approves or rejects; the body is the pend snapshot with its threshold context",
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, invalid body, or a Story 2.4 batch/serial arm violation (validation-failed): batch/serials on an untracked SKU, a tracked movement missing its arm, malformed batch dates (or expiry preceding mfg), overrideReason on an intake or missing on an override draw, duplicate serials, a quantityDelta that does not equal the serial count, a reasonCode outside the closed adjustment vocabulary, or — story 3-2b — occurredAt missing on a handheld adjustment; a retired bin (bin-retired), the system QC-hold or IN-TRANSIT bin (qc-bin-not-adjustable), the system RETURNS bin (returns-bin-not-adjustable), or — story 2-4a — anything but a negative write-off on the system DAMAGED bin (damaged-bin-write-off-only, also at a pend\'s approval)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token of either family, or a device token without a badge-in session (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), an unknown or revoked device (device-revoked), or the caller holds neither stock.adjust nor stock.adjust.request — or replays an applied adjustment without stock.adjust (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, bin, or SKU does not exist in this tenant (not-found), or an explicit batch code does not exist for the SKU (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Concurrent request on the same Idempotency-Key (conflict); a kit SKU can never hold stock (kit-cannot-hold-stock, naming it); a serial-tracked movement scans a serial that already lives in a bin (duplicate-serial, naming it) or draws a serial the ledger last saw in another bin (serial-elsewhere, naming the last-known bin); a positive adjustment for a departed client (client-departed); or — story 3-2b — the handheld op was captured by another operator (operator-mismatch)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse), or the movement would drive on-hand, or the resolved/overridden batch\'s on-hand, below zero (insufficient-on-hand names the bin, and the batchRef on a batch-tracked draw)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async adjustStock(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentAnySession() session: AnySession,
    @Body() dto: StockAdjustmentDto,
    // Story 5-2 — the response's STATUS is dynamic: 201 when the adjustment
    // applied, 202 when it pended. The passthrough `res` (the openapi
    // controller's precedent) flips the status per request; the @HttpCode(201)
    // decorator stays the non-pend default.
    @Res({ passthrough: true }) res: Response,
  ): Promise<StockAdjustmentResponse | StockAdjustmentPendingResponse> {
    assertOwnTenant(session.session, tenantId);
    // Story 3-2b — the device arm is badge-in required (a bare enrollment
    // credential carries no operator); X-Op-Operator was checked by the
    // guard. The actor is the badge-in operator; the device rides the command.
    // The badge-in check precedes the header parse (code review): a bare
    // credential is 401 whatever else the request lacks.
    if (session.family === 'device' && session.session.userId === null) {
      throw badgeInRequired();
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
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
    // Story 3-2b (A2) — the whole body (normalization, the capability and
    // replay pre-check, the batch/serial composition, the command call) is
    // the tenancy `AdjustmentSubmission`, shared with the review queue's
    // Apply of a rejected `stock.adjust` op. Quantities cross in BASE units
    // (story 10.2: the command converts behind its replay lookup).
    const result = await this.adjustments.submit(
      {
        tenantId,
        actorUserId,
        deviceId,
        warehouseId: dto.warehouseId,
        skuId: dto.skuId,
        binId: dto.binId,
        quantityDelta: dto.quantityDelta,
        reasonCode: dto.reasonCode,
        note: dto.note,
        occurredAt: dto.occurredAt ?? undefined,
        batch: dto.batch,
        serials: dto.serials,
        handlingUnitIds: dto.handlingUnitIds,
      },
      key,
    );
    if (result.kind === 'pending') {
      res.status(HttpStatus.ACCEPTED);
      return result.pending as StockAdjustmentPendingResponse;
    }
    return result.snapshot;
  }

  // ── Story 5-2: the adjustment approval-threshold surface (FR-19) ─────────

  @Put(':tenantId/inventory/adjustment-policies')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Sets the tenant's stock adjustment approval threshold (FR-19) — an adjustment whose |quantityDelta| strictly exceeds it pends for Owner approval instead of applying",
  })
  @ApiBody({ type: AdjustmentPolicyDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({
    type: AdjustmentPolicyResponse,
    description: "The tenant's adjustment policy row (created or updated; the write is idempotent under the Idempotency-Key)",
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid quantityThreshold (validation-failed): negative, non-integer, or over the int4 max of 2147483647 (the column is an integer — an oversized threshold is this 400, never a range 500)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks adjustments.approve (role-denied) — the policy write rides the same owner-only capability the decisions carry') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Concurrent request on the same Idempotency-Key, or two concurrent first-time policy writes (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async setAdjustmentPolicy(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: AdjustmentPolicyDto,
  ): Promise<AdjustmentPolicyResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.inventoryFacade.setAdjustmentPolicy(
      {
        tenantId,
        actorUserId: session.userId,
        // Required and non-null by the DTO (a null threshold means flow
        // disabled — deleting the row is how a tenant disables the flow).
        quantityThreshold: dto.quantityThreshold,
      },
      key,
    );
  }

  @Get(':tenantId/inventory/adjustment-policies')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Reads the tenant's stock adjustment approval threshold (404 when no policy row exists — the approval flow is disabled)",
  })
  @ApiOkResponse({ type: AdjustmentPolicyResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No policy row exists for this tenant (not-found) — with no row the approval flow is disabled and every adjustment applies immediately') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async getAdjustmentPolicy(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<AdjustmentPolicyResponse> {
    assertOwnTenant(session, tenantId);
    const policy = await this.inventoryFacade.getAdjustmentPolicy(tenantId);
    if (policy === null) {
      throw new ProblemException(
        'not-found',
        404,
        'No adjustment policy configured',
        'No adjustment policy exists for this tenant — the approval flow is disabled (every adjustment applies immediately).',
      );
    }
    return policy;
  }

  @Get(':tenantId/inventory/adjustment-pendings')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Lists the tenant\'s pending stock adjustments (keyset cursor pagination, status-filterable — the approval queue read; a read, never capability-gated)',
  })
  @ApiOkResponse({
    type: AdjustmentPendingListResponse,
    description: 'The pending queue page (newest first): each row carries the resolved arms, the threshold context, and — after a decision — who decided',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed status, cursor, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listAdjustmentPendings(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: AdjustmentPendingsQuery,
  ): Promise<AdjustmentPendingListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.inventoryFacade.listAdjustmentPendings(tenantId, {
      status: query.status as 'pending' | 'approved' | 'rejected' | undefined,
      clientId: query.clientId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Post(':tenantId/inventory/adjustment-pendings/:pendingId/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Approves a pending stock adjustment (adjustments.approve) — the stored arms re-execute as ledger events at decision time (actor = approver); audited',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: AdjustmentDecisionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed pendingId (validation-failed); the stored adjustment fails a guard re-run at approval — e.g. (story 2-4a) anything but a negative write-off on the system DAMAGED bin (damaged-bin-write-off-only)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks adjustments.approve (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No pending adjustment with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Already approved/rejected (adjustment-pending-decided), a kit SKU since the pend (kit-cannot-hold-stock), a concurrent idempotent request (conflict), the FEFO-default batch the pend resolved has since been blocked or has expired (batch-blocked / batch-expired — story 3-3a), or the world moved since the pend and the re-execution hit a guard whose 409 applies (e.g. a handling unit no longer active)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse), or the re-execution failed a guard whose 422 applies (insufficient-on-hand — the pending row STAYS pending; the whole decide transaction rolls back)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'pendingId', format: 'uuid' })
  async approveAdjustment(
    @Param('tenantId') tenantId: string,
    @Param('pendingId') pendingId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<AdjustmentDecisionResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(pendingId, 'pendingId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.inventoryFacade.decideAdjustment(
      { tenantId, actorUserId: session.userId, pendingAdjustmentId: pendingId, decision: 'approve' },
      key,
    );
    return {
      id: snapshot.pendingAdjustment.id,
      status: snapshot.pendingAdjustment.status,
      decidedBy: snapshot.pendingAdjustment.decidedBy!,
      decidedAt: snapshot.pendingAdjustment.decidedAt!,
      events: snapshot.events,
      onHand: snapshot.onHand,
    };
  }

  @Post(':tenantId/inventory/adjustment-pendings/:pendingId/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Rejects a pending stock adjustment (adjustments.approve) — no stock write, the adjustment never applies; audited',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: AdjustmentDecisionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed pendingId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks adjustments.approve (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No pending adjustment with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Already approved/rejected (adjustment-pending-decided), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'pendingId', format: 'uuid' })
  async rejectAdjustment(
    @Param('tenantId') tenantId: string,
    @Param('pendingId') pendingId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<AdjustmentDecisionResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(pendingId, 'pendingId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.inventoryFacade.decideAdjustment(
      { tenantId, actorUserId: session.userId, pendingAdjustmentId: pendingId, decision: 'reject' },
      key,
    );
    return {
      id: snapshot.pendingAdjustment.id,
      status: snapshot.pendingAdjustment.status,
      decidedBy: snapshot.pendingAdjustment.decidedBy!,
      decidedAt: snapshot.pendingAdjustment.decidedAt!,
      events: snapshot.events,
      onHand: snapshot.onHand,
    };
  }

  @Get(':tenantId/warehouses/:warehouseId/inventory/events')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Lists one warehouse's ledger event timeline (keyset cursor pagination, newest first)",
  })
  @ApiOkResponse({
    type: LedgerEventListResponse,
    description: "The warehouse's ledger event-timeline page (newest first, keyset cursor)",
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed skuId/binId/orderId/grnId/poId/transferId/adjustmentPendingId/countVarianceId query, an unregistered type, a from/to that is not an ISO-8601 instant, from not before to, a shortPick other than true/false, a malformed cursor, or an out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listEvents(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: LedgerEventsQuery,
  ): Promise<LedgerEventListResponse> {
    assertOwnTenant(session, tenantId);
    assertInstantRange(query.from, query.to);
    const timelineQuery: LedgerTimelineQuery = {
      skuId: query.skuId,
      clientId: query.clientId,
      binId: query.binId,
      types: query.type,
      from: query.from,
      to: query.to,
      orderId: query.orderId,
      shortPick: query.shortPick,
      grnId: query.grnId,
      poId: query.poId,
      transferId: query.transferId,
      adjustmentPendingId: query.adjustmentPendingId,
      countVarianceId: query.countVarianceId,
      cursor: query.cursor,
      limit: query.limit,
    };
    const page = await this.inventoryFacade.listEvents(tenantId, warehouseId, timelineQuery);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  // ── Story 9-3c — ledger integrity (AD-16) ──────────────────────────────────
  // Three `audit.view`-gated reads (owner-only — the facade asserts the
  // capability in its OWN transaction before anything is read, the 9-3a
  // gated-read shape) and one keyed owner-only command. The routes sit under
  // the inventory prefix: the ledger is inventory's.

  @Get(':tenantId/inventory/ledger/integrity')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "The tenant's ledger integrity status, one row per warehouse (audit.view — owner-only): the verified position, the pre-0026 count, the last anchor and its WORM copy, the anchors waiting for WORM, and the breaks (open and acknowledged, newest first, at most 10). UNPAGED — bounded by the warehouse count",
  })
  @ApiOkResponse({ type: LedgerIntegrityResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks audit.view (role-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async ledgerIntegrity(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<LedgerIntegrityResponse> {
    assertOwnTenant(session, tenantId);
    const view = await this.inventoryFacade.ledgerIntegrity(tenantId, session.userId);
    return { wormStore: view.wormStore, warehouses: view.warehouses.map((row) => ({ ...row, breaks: [...row.breaks] })) };
  }

  @Get(':tenantId/warehouses/:warehouseId/inventory/ledger/anchors')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Lists one warehouse's ledger anchors, newest range first (audit.view — owner-only; keyset cursor on to_seq)",
  })
  @ApiOkResponse({ type: LedgerAnchorListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed warehouseId (validation-failed), a malformed cursor (invalid-cursor), or an out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks audit.view (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async ledgerAnchors(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: LedgerAnchorsQuery,
  ): Promise<LedgerAnchorListResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    const page = await this.inventoryFacade.ledgerAnchors(tenantId, session.userId, warehouseId, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':tenantId/warehouses/:warehouseId/inventory/ledger/anchors/:anchorId/proof')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "The verifiable proof of one anchored range (audit.view — owner-only): its 'seq:eventHash' lines, the digest recomputed from them, the anchor with its WORM reference, and how to recompute it. Bounded by LEDGER_ANCHOR_MAX_RANGE",
  })
  @ApiOkResponse({ type: LedgerProofResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed warehouseId or anchorId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks audit.view (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No anchor with this id in this warehouse (anchor-not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'anchorId', format: 'uuid' })
  async ledgerProof(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Param('anchorId') anchorId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<LedgerProofResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    assertUuidParam(anchorId, 'anchorId');
    const proof = await this.inventoryFacade.ledgerProof(tenantId, session.userId, warehouseId, anchorId);
    return { ...proof, lines: [...proof.lines] };
  }

  @Post(':tenantId/warehouses/:warehouseId/inventory/ledger/breaks/:breakId/acknowledge')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Acknowledges a ledger chain break (ledger.acknowledge — owner-only): resolves its panel entry; audited. Acknowledging repairs nothing — the break stays recorded and a broken tail still refuses to anchor',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: ChainBreakDto })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed warehouseId/breakId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks ledger.acknowledge (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No chain break with this id in this warehouse (chain-break-not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Already acknowledged (chain-break-acknowledged), or a concurrent request on the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'breakId', format: 'uuid' })
  async acknowledgeChainBreak(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Param('breakId') breakId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<ChainBreakDto> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    assertUuidParam(breakId, 'breakId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.inventoryFacade.acknowledgeChainBreak(
      { tenantId, warehouseId, breakId, actorUserId: session.userId },
      key,
    );
  }

  @Get(':tenantId/warehouses/:warehouseId/inventory/stock')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Lists one warehouse's on-hand projection, SKU/bin filterable (keyset cursor pagination)",
  })
  @ApiOkResponse({
    type: StockListResponse,
    description:
      "The warehouse's on-hand page (keyset cursor) — plain stock truth for tracked and untracked SKUs alike, no batch fields",
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed skuId/binId query, unknown order, non-boolean nonZero or out-of-range limit (validation-failed); a malformed cursor, or one minted under the other order (invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listStock(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: StockListQuery,
  ): Promise<StockListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.inventoryFacade.listStock(tenantId, warehouseId, {
      skuId: query.skuId,
      clientId: query.clientId,
      binId: query.binId,
      cursor: query.cursor,
      limit: query.limit,
      order: query.order,
      nonZero: query.nonZero,
    });
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Get(':tenantId/warehouses/:warehouseId/inventory/batches')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Lists a SKU's batches of one warehouse joined with on-hand (FEFO order — expiry ASC nulls last; expired batches are still listed)",
  })
  @ApiOkResponse({
    type: BatchListResponse,
    description:
      "The SKU's batches with their on-hand quantity (0 when none) — the FEFO read order is data, not policy; excluding expired stock is the draw policy, not a read filter",
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed skuId/binId query (validation-failed — skuId is required)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listBatches(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: BatchListQuery,
  ): Promise<BatchListResponse> {
    assertOwnTenant(session, tenantId);
    if (query.skuId === undefined) {
      throw new ProblemException(
        'validation-failed',
        400,
        'skuId is required',
        'The batch list is a per-SKU read — supply a skuId query parameter.',
      );
    }
    // The api-layer join (2.4 precedent): catalog owns identity (code,
    // mfg/expiry), inventory owns on-hand — neither facade imports the other.
    const [batches, onHand] = await Promise.all([
      // Story 3-3a (A9) — the lifecycle view: who blocked, why, when, and the
      // server's `expired` judgement (no client-side expiry copy).
      this.catalogFacade.batchViews(tenantId, query.skuId),
      this.inventoryFacade.batchOnHand(tenantId, warehouseId, {
        skuId: query.skuId,
        binId: query.binId,
      }),
    ]);
    const quantityByBatch = new Map<string, number>();
    for (const row of onHand) {
      quantityByBatch.set(row.batchId, (quantityByBatch.get(row.batchId) ?? 0) + row.quantity);
    }
    const items: BatchListItemDto[] = batches
      .map((batch) => ({
        id: batch.id,
        code: batch.code,
        mfgDate: batch.mfgDate,
        expiryDate: batch.expiryDate,
        status: batch.status,
        blockedReason: batch.blockedReason,
        blockedNote: batch.blockedNote,
        blockedAt: batch.blockedAt,
        blockedBy: batch.blockedBy,
        blockedByName: batch.blockedByName,
        expired: batch.expired,
        quantity: quantityByBatch.get(batch.id) ?? 0,
      }))
      // FEFO order is data, not policy (Design Notes): expiry ASC, nulls
      // LAST — expired batches stay listed; the code breaks ties (the join
      // is otherwise order-free).
      .sort((a, b) => {
        if (a.expiryDate === null && b.expiryDate !== null) return 1;
        if (b.expiryDate === null && a.expiryDate !== null) return -1;
        if (a.expiryDate !== null && b.expiryDate !== null) {
          const delta = Date.parse(a.expiryDate) - Date.parse(b.expiryDate);
          if (delta !== 0) return delta;
        }
        return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
      });
    return { items };
  }

  @Get(':tenantId/inventory/batches/:batchId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "One batch's detail — catalog identity, per-bin on-hand across the tenant, and its full movement history (one query)",
  })
  @ApiOkResponse({
    type: BatchDetailResponse,
    description: 'The batch identity plus the bins (any warehouse of the tenant) where its stock lives and its ledger history (oldest first)',
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No batch with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'batchId', format: 'uuid' })
  async getBatch(
    @Param('tenantId') tenantId: string,
    @Param('batchId') batchId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<BatchDetailResponse> {
    assertOwnTenant(session, tenantId);
    // A malformed (non-uuid) id is an unknown identity — the documented 404,
    // before any facade call (a raw non-uuid id would reach the Drizzle uuid
    // comparison and surface as a 500 from Postgres).
    if (!UUID_RE.test(batchId)) {
      throw batchNotFound(batchId);
    }
    // The CHECKPOINT 1 semantics: unknown (or foreign) batch identity is a
    // 404 via the tiny catalog existence read — before any detail query.
    const identity = await this.catalogFacade.findBatchView(tenantId, batchId);
    if (identity === null) {
      throw batchNotFound(batchId);
    }
    const [bins, history] = await Promise.all([
      this.inventoryFacade.batchBinsOnHand(tenantId, batchId),
      this.inventoryFacade.batchHistory(tenantId, batchId),
    ]);
    return {
      id: identity.id,
      skuId: identity.skuId,
      code: identity.code,
      mfgDate: identity.mfgDate,
      expiryDate: identity.expiryDate,
      status: identity.status,
      blockedReason: identity.blockedReason,
      blockedNote: identity.blockedNote,
      blockedAt: identity.blockedAt,
      blockedBy: identity.blockedBy,
      blockedByName: identity.blockedByName,
      expired: identity.expired,
      bins: bins.map((bin) => ({ warehouseId: bin.warehouseId, binId: bin.binId, quantity: bin.quantity })),
      history,
    };
  }

  @Post(':tenantId/inventory/batches/:batchId/block')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Blocks a batch (a lot) in every warehouse, with a reason (qc.manage — owner, ops manager): its units stay on hand but are never promised (ATP, the grant ceiling, channel quantities, replenishment) and never default-drawn. Reservations already granted stand; those lines short at the wave. Story 3-3a',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiBody({ type: BlockBatchDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: BatchBlockResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a reason outside the vocabulary, reason `other` without a note, or a note over 500 characters (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks qc.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No batch with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The batch is already blocked (batch-already-blocked), or a concurrent request on the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'batchId', format: 'uuid' })
  async blockBatch(
    @Param('tenantId') tenantId: string,
    @Param('batchId') batchId: string,
    @Body() body: BlockBatchDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<BatchBlockResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.catalogFacade.blockBatch(
      { tenantId, actorUserId: session.userId, batchId, reason: body.reason, note: body.note },
      key,
    );
  }

  @Post(':tenantId/inventory/batches/:batchId/unblock')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Unblocks a batch (qc.manage), with a required note: its unexpired units are promisable again. An unblocked batch past its expiry stays unpromisable (the response says `expired: true`). Story 3-3a',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiBody({ type: UnblockBatchDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: BatchBlockResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a missing, blank or over-500-character note (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks qc.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No batch with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The batch is not blocked (batch-not-blocked), or a concurrent request on the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'batchId', format: 'uuid' })
  async unblockBatch(
    @Param('tenantId') tenantId: string,
    @Param('batchId') batchId: string,
    @Body() body: UnblockBatchDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<BatchBlockResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.catalogFacade.unblockBatch(
      { tenantId, actorUserId: session.userId, batchId, note: body.note },
      key,
    );
  }

  @Get(':tenantId/inventory/serials/:serialId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "One serial's detail — catalog identity, its derived tenant-wide location, and its full movement history (one query)",
  })
  @ApiOkResponse({
    type: SerialDetailResponse,
    description:
      'The serial identity, its ledger-derived location (the latest event\'s bin; null when never moved) and its full movement history (oldest first)',
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No serial with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'serialId', format: 'uuid' })
  async getSerial(
    @Param('tenantId') tenantId: string,
    @Param('serialId') serialId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<SerialDetailResponse> {
    assertOwnTenant(session, tenantId);
    // A malformed (non-uuid) id is an unknown identity — the documented 404,
    // before any facade call (a raw non-uuid id would reach the Drizzle uuid
    // comparison and surface as a 500 from Postgres).
    if (!UUID_RE.test(serialId)) {
      throw serialNotFound(serialId);
    }
    // The CHECKPOINT 1 semantics: unknown (or foreign) serial identity is a
    // 404 via the tiny catalog existence read — before any detail query.
    const identity = await this.catalogFacade.findSerial(tenantId, serialId);
    if (identity === null) {
      throw serialNotFound(serialId);
    }
    const [location, history] = await Promise.all([
      this.inventoryFacade.serialLocation(tenantId, serialId),
      this.inventoryFacade.serialHistory(tenantId, serialId),
    ]);
    return {
      id: identity.id,
      skuId: identity.skuId,
      serialNumber: identity.serialNumber,
      status: identity.status,
      location,
      history,
    };
  }
}

function batchNotFound(batchId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Batch not found',
    `No batch with id "${batchId}" exists in this tenant.`,
  );
}

function serialNotFound(serialId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Serial not found',
    `No serial with id "${serialId}" exists in this tenant.`,
  );
}

function assertOwnTenant(session: { readonly tenantId: string }, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The session token tenant does not own this path.',
    );
  }
}

/** Story 5-2 — the decision routes' path-param guard (the receiving controller's shape, per-file). */
function assertUuidParam(value: string, name: 'pendingId' | 'warehouseId' | 'anchorId' | 'breakId'): void {
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
