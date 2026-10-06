import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { ReplenishmentFacade } from '../modules/replenishment/replenishment.facade';
import type {
  ListBatchAlertsQuery,
  ListBreachesQuery,
  ListReorderPoliciesQuery,
  ListSuggestedPosQuery,
} from '../modules/replenishment/replenishment.facade';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  BatchAlertListQuery,
  BatchAlertListResponse,
  BatchAlertResponse,
  BreachListQuery,
  BreachListResponse,
  BreachResponse,
  ExpiryPolicyResponse,
  ReorderPolicyListQuery,
  ReorderPolicyListResponse,
  ReorderPolicyResponse,
  SubmitSuggestedPoDto,
  SubmitSuggestedPoResponse,
  SuggestedPoListQuery,
  SuggestedPoListResponse,
  UpsertExpiryPolicyDto,
  UpsertReorderPolicyDto,
} from '../modules/replenishment/replenishment.dto';
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
 * The replenishment HTTP surface (story 6.1): reorder-policy overrides
 * (upsert + delete), the breach queue (list + dismiss), and the
 * suggested-PO queue (list + submit) — the api shell is the only HTTP
 * surface of the monolith, and every replenishment mutation goes through
 * `ReplenishmentFacade` (the commands re-evaluate the role against the DB
 * at entry; reads are never gated). The submit response carries the FLAT
 * PO snapshot — `body.purchaseOrder` IS the minted PO, not a wrapped
 * carrier.
 */
@ApiTags('replenishment')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ReplenishmentController {
  constructor(@Inject(ReplenishmentFacade) private readonly replenishment: ReplenishmentFacade) {}

  @Put(':tenantId/replenishment/policies')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upserts one per-warehouse reorder-point override (replenishment.manage) — last-write-wins' })
  @ApiBody({ type: UpsertReorderPolicyDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: ReorderPolicyResponse,
    description: 'The override row (created or overwritten — the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a non-positive / non-integer reorderPoint or reorderQty (validation-failed, naming the field)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks replenishment.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse or SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent upsert of the same (warehouse, sku) (conflict), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async upsertReorderPolicy(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpsertReorderPolicyDto,
  ): Promise<ReorderPolicyResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.replenishment.upsertReorderPolicy(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        skuId: dto.skuId,
        reorderPoint: dto.reorderPoint,
        reorderQty: dto.reorderQty,
      },
      key,
    );
    return { policy: { ...snapshot } };
  }

  @Delete(':tenantId/replenishment/policies/:policyId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Deletes one per-warehouse reorder-point override (replenishment.manage) — the SKU-column default resumes' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: ReorderPolicyResponse,
    description: 'The deleted override row (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed policyId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks replenishment.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No override with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'policyId', format: 'uuid' })
  async deleteReorderPolicy(
    @Param('tenantId') tenantId: string,
    @Param('policyId') policyId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<ReorderPolicyResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(policyId, 'policyId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.replenishment.deleteReorderPolicy(
      {
        tenantId,
        actorUserId: session.userId,
        policyId,
      },
      key,
    );
    return { policy: { ...snapshot } };
  }

  @Get(':tenantId/replenishment/policies')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists the tenant's reorder-point overrides, warehouse/sku-filterable (keyset cursor pagination — open to any member)" })
  @ApiOkResponse({ type: ReorderPolicyListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor, a non-uuid warehouseId/skuId filter, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('A filtered warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listReorderPolicies(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: ReorderPolicyListQuery,
  ): Promise<ReorderPolicyListResponse> {
    assertOwnTenant(session, tenantId);
    const listQuery: ListReorderPoliciesQuery = {
      warehouseId: query.warehouseId,
      skuId: query.skuId,
      cursor: query.cursor,
      limit: query.limit,
    };
    const page = await this.replenishment.listReorderPolicies(tenantId, listQuery);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Get(':tenantId/replenishment/breaches')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists the tenant's reorder breaches (the alert queue), status/warehouse-filterable (keyset cursor pagination — open to any member)" })
  @ApiOkResponse({ type: BreachListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed status, cursor, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('A filtered warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listBreaches(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: BreachListQuery,
  ): Promise<BreachListResponse> {
    assertOwnTenant(session, tenantId);
    const listQuery: ListBreachesQuery = {
      status: query.status,
      warehouseId: query.warehouseId,
      cursor: query.cursor,
      limit: query.limit,
    };
    const page = await this.replenishment.listBreaches(tenantId, listQuery);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Post(':tenantId/replenishment/breaches/:breachId/dismiss')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dismisses an OPEN breach (replenishment.manage) — its suggested-PO draft stays a draft' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: BreachResponse,
    description: 'The dismissed breach row (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed breachId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks replenishment.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No breach with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The breach is not open (breach-not-open, naming the status), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'breachId', format: 'uuid' })
  async dismissBreach(
    @Param('tenantId') tenantId: string,
    @Param('breachId') breachId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<BreachResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(breachId, 'breachId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const entry = await this.replenishment.dismissBreach(
      {
        tenantId,
        actorUserId: session.userId,
        breachId,
      },
      key,
    );
    return { breach: { ...entry } };
  }

  @Get(':tenantId/replenishment/suggested-pos')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists the tenant's suggested POs (the draft queue), status/warehouse-filterable (keyset cursor pagination — open to any member)" })
  @ApiOkResponse({ type: SuggestedPoListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed status, cursor, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('A filtered warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listSuggestedPos(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: SuggestedPoListQuery,
  ): Promise<SuggestedPoListResponse> {
    assertOwnTenant(session, tenantId);
    const listQuery: ListSuggestedPosQuery = {
      status: query.status,
      warehouseId: query.warehouseId,
      cursor: query.cursor,
      limit: query.limit,
    };
    const page = await this.replenishment.listSuggestedPos(tenantId, listQuery);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Post(':tenantId/replenishment/suggested-pos/:draftId/submit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Submits a DRAFT suggested PO as a REAL purchase order (replenishment.manage; the mint re-executes under po.manage) — vendor/quantity edits optional',
  })
  @ApiBody({ type: SubmitSuggestedPoDto, required: false })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: SubmitSuggestedPoResponse,
    description: 'The draft → submitted, and the FLAT PO snapshot — body.purchaseOrder IS the minted PO ({id, code, status, vendorId, warehouseId, lines…})',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed draftId, a non-positive/non-integer quantityMilli (validation-failed), or no vendor on the draft or edits (suggested-po-vendor-required)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks replenishment.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No draft with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The draft is not a draft (suggested-po-submitted), the PO code is already in use (conflict), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'draftId', format: 'uuid' })
  async submitSuggestedPo(
    @Param('tenantId') tenantId: string,
    @Param('draftId') draftId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    // A bare POST (no JSON body) submits the draft as it stands — the body is
    // optional on this route.
    @Body() dto: SubmitSuggestedPoDto | undefined,
  ): Promise<SubmitSuggestedPoResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(draftId, 'draftId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const edits = dto ?? {};
    const result = await this.replenishment.submitSuggestedPo(
      {
        tenantId,
        actorUserId: session.userId,
        draftId,
        ...(edits.vendorId === undefined ? {} : { vendorId: edits.vendorId }),
        ...(edits.quantityMilli === undefined ? {} : { quantityMilli: edits.quantityMilli }),
      },
      key,
    );
    return {
      suggestedPoId: result.suggestedPoId,
      purchaseOrder: { ...result.purchaseOrder },
    };
  }

  @Get(':tenantId/replenishment/expiry-policies')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Reads the tenant's expiry/aging config — 404 when ABSENT (the absent-row = disabled convention; open to any member)",
  })
  @ApiOkResponse({ type: ExpiryPolicyResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The tenant has no expiry/aging config row — the alerts are disabled — (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async getExpiryPolicy(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<ExpiryPolicyResponse> {
    assertOwnTenant(session, tenantId);
    const snapshot = await this.replenishment.getExpiryPolicy(tenantId);
    if (snapshot === null) {
      // The absent-row convention: NO default days hide behind a missing row
      // — the read states the disable, it never invents values.
      throw new ProblemException(
        'not-found',
        404,
        'No expiry/aging policy configured',
        'This tenant has no expiry/aging policy row — expiry and aging alerting is disabled until one is upserted.',
      );
    }
    return { expiryPolicy: { ...snapshot } };
  }

  @Put(':tenantId/replenishment/expiry-policies')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upserts the tenant\'s expiry/aging config (replenishment.manage) — last-write-wins; both day counts ≥ 0' })
  @ApiBody({ type: UpsertExpiryPolicyDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: ExpiryPolicyResponse,
    description: 'The config row (created or overwritten — the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a negative / non-integer expiryLeadDays or agingThresholdDays (validation-failed, naming the field)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks replenishment.manage (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent write of the same tenant\'s config (conflict), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async upsertExpiryPolicy(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpsertExpiryPolicyDto,
  ): Promise<ExpiryPolicyResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.replenishment.upsertExpiryPolicy(
      {
        tenantId,
        actorUserId: session.userId,
        expiryLeadDays: dto.expiryLeadDays,
        agingThresholdDays: dto.agingThresholdDays,
      },
      key,
    );
    return { expiryPolicy: { ...snapshot } };
  }

  @Get(':tenantId/replenishment/batch-alerts')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Lists the tenant's batch alerts (the expiry/aging queue), kind/status/warehouse-filterable (keyset cursor pagination — open to any member); each row's on-hand is re-read live",
  })
  @ApiOkResponse({ type: BatchAlertListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed kind, status, cursor, out-of-range limit, a from/to that is not an ISO-8601 instant, or from not before to (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('A filtered warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listBatchAlerts(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: BatchAlertListQuery,
  ): Promise<BatchAlertListResponse> {
    assertOwnTenant(session, tenantId);
    assertInstantRange(query.from, query.to);
    const listQuery: ListBatchAlertsQuery = {
      kind: query.kind,
      status: query.status,
      warehouseId: query.warehouseId,
      from: query.from,
      to: query.to,
      cursor: query.cursor,
      limit: query.limit,
    };
    const page = await this.replenishment.listBatchAlerts(tenantId, listQuery);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Post(':tenantId/replenishment/batch-alerts/:alertId/dismiss')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dismisses an OPEN batch alert (replenishment.manage) — no stock-side effect; the alert is evidence' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: BatchAlertResponse,
    description: 'The dismissed batch alert row (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed alertId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks replenishment.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No batch alert with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The alert is not open (batch-alert-not-open, naming the status), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'alertId', format: 'uuid' })
  async dismissBatchAlert(
    @Param('tenantId') tenantId: string,
    @Param('alertId') alertId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<BatchAlertResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(alertId, 'alertId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const entry = await this.replenishment.dismissBatchAlert(
      {
        tenantId,
        actorUserId: session.userId,
        alertId,
      },
      key,
    );
    return { batchAlert: { ...entry } };
  }
}

/** Replenishment uuid path params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'policyId' | 'breachId' | 'draftId' | 'alertId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" path parameter must be a uuid (got "${value}").`,
    );
  }
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