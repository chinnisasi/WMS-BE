import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiHeaders,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { IsInstant } from '../shared/primitives/instant-range';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { CurrentSession, TenantSessionGuard } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { BillingFacade, type RateCardSnapshot } from '../modules/billing/billing.facade';
import { RateCardCommand, rateCardClock } from '../modules/billing/rate-card.command';
import {
  ActivateRateCardDto,
  CreateRateCardDto,
  RateCardInForceResponse,
  RateCardLinesDto,
  RateCardListResponse,
  RateCardResponse,
  type RateCardDto,
} from './rate-cards.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

/**
 * The in-force query, declared here beside the route (the
 * `CarrierConnectionListQuery` precedent): `@Query()` needs the class as a
 * VALUE for the validation pipe's `design:paramtypes` metadata.
 *
 * `?at=` — an optional UTC (`Z`) instant; default now. */
export class RateCardInForceQuery {
  @ApiProperty({
    required: false,
    example: '2026-10-31T17:30:00Z',
    description: 'The instant to resolve, ISO-8601 UTC with a Z designator. Default: now',
  })
  @IsOptional()
  @IsInstant()
  @Matches(/Z$/, { message: 'at must be a UTC instant ending in Z' })
  at?: string;
}

const MUTATION_403 = 'Session belongs to another tenant (permission-denied), or the caller lacks rates.manage — owner and accountant only (role-denied)';

/**
 * Story 21-3 — rate cards (FR-77, CAP-4): a client's versioned prices. Reads
 * are member-open; every mutation needs `rates.manage` (owner + accountant).
 * Holds no rules — the command owns authority, replay, the locks and every
 * date rule; the DTOs check shape (a real `YYYY-MM-DD`, the vocabularies).
 */
@ApiTags('billing')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class RateCardsController {
  constructor(
    @Inject(RateCardCommand) private readonly command: RateCardCommand,
    @Inject(BillingFacade) private readonly facade: BillingFacade,
  ) {}

  // The literal `in-force` segment is declared BEFORE every sibling route
  // (the route-declaration-order rule, IMPLEMENTATION-GUIDE): nothing here
  // captures it today, but a later `clients/:clientId/rate-cards/:x` would.
  @Get(':tenantId/clients/:clientId/rate-cards/in-force')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "The client's rate card in force at an instant (default now): the active or superseded card with effectiveFrom ≤ at < effectiveTo — or null, when the client is not billed then",
  })
  @ApiOkResponse({ type: RateCardInForceResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed clientId, or `at` is not a UTC instant ending in Z (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async inForce(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: RateCardInForceQuery,
  ): Promise<RateCardInForceResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(clientId, 'clientId');
    const asOf = new Date(query.at === undefined ? rateCardClock.now() : Date.parse(query.at)).toISOString();
    const card = await this.facade.rateCardInForce(tenantId, clientId, asOf);
    return { rateCard: card === null ? null : toRateCardDto(card), asOf };
  }

  @Get(':tenantId/clients/:clientId/rate-cards')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Lists a client's rate cards — the newest 100 drafts first, then every dated card by effectiveFrom descending (unpaginated; dated cards are never dropped)",
  })
  @ApiOkResponse({ type: RateCardListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed clientId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async list(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<RateCardListResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(clientId, 'clientId');
    return { items: (await this.facade.listRateCards(tenantId, clientId)).map(toRateCardDto) };
  }

  @Post(':tenantId/clients/:clientId/rate-cards')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Drafts a rate card for a client (rates.manage). A draft has no date and stays editable until activated' })
  @ApiBody({ type: CreateRateCardDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: RateCardResponse, description: 'The draft (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse("Missing or malformed Idempotency-Key, a malformed clientId, a line outside the vocabularies or the amount range, a charge on the wrong basis or priced twice, or the tenant's own client (validation-failed)") })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The client is suspended or departed (client-not-active), or a concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async create(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateRateCardDto,
  ): Promise<RateCardResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(clientId, 'clientId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.createDraft(
      { tenantId, actorUserId: session.userId, clientId, lines: dto.lines },
      key,
    );
    return { rateCard: toRateCardDto(snapshot.rateCard) };
  }

  @Get(':tenantId/rate-cards/:rateCardId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One rate card with its lines' })
  @ApiOkResponse({ type: RateCardResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed rateCardId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No rate card with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'rateCardId', format: 'uuid' })
  async get(
    @Param('tenantId') tenantId: string,
    @Param('rateCardId') rateCardId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<RateCardResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(rateCardId, 'rateCardId');
    return { rateCard: toRateCardDto(await this.facade.getRateCard(tenantId, rateCardId)) };
  }

  @Put(':tenantId/rate-cards/:rateCardId/lines')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Replaces a draft's lines (rates.manage). An activated card never changes" })
  @ApiBody({ type: RateCardLinesDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: RateCardResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed rateCardId, or invalid lines (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No rate card with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The card is not a draft (rate-card-not-draft), or a concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'rateCardId', format: 'uuid' })
  async replaceLines(
    @Param('tenantId') tenantId: string,
    @Param('rateCardId') rateCardId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RateCardLinesDto,
  ): Promise<RateCardResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(rateCardId, 'rateCardId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.replaceDraftLines(
      { tenantId, actorUserId: session.userId, rateCardId, lines: dto.lines },
      key,
    );
    return { rateCard: toRateCardDto(snapshot.rateCard) };
  }

  @Post(':tenantId/rate-cards/:rateCardId/activate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Activates a draft from an IST date (rates.manage). The previous open card is superseded from that date; the card is frozen from now on',
  })
  @ApiBody({ type: ActivateRateCardDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: RateCardResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse("Missing or malformed Idempotency-Key, a malformed rateCardId or effectiveFrom (validation-failed); the tenant's own client (validation-failed); a date before today (IST) for a first card or before tomorrow (IST) for a replacement (rate-card-effective-date)") })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No rate card with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The card is not a draft (rate-card-not-draft), the date is not after every existing card (rate-card-effective-overlap), the card has no lines (rate-card-no-lines), the client is not active (client-not-active), or a concurrent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'rateCardId', format: 'uuid' })
  async activate(
    @Param('tenantId') tenantId: string,
    @Param('rateCardId') rateCardId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ActivateRateCardDto,
  ): Promise<RateCardResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(rateCardId, 'rateCardId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.activate(
      { tenantId, actorUserId: session.userId, rateCardId, effectiveFrom: dto.effectiveFrom },
      key,
    );
    return { rateCard: toRateCardDto(snapshot.rateCard) };
  }

  @Post(':tenantId/rate-cards/:rateCardId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Cancels a scheduled card — any dated card (active, or superseded by a later one) whose date has not arrived (rates.manage). It is never in force; its predecessor inherits its end (reopens open-ended, or runs to the next card’s date)',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: RateCardResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed rateCardId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No rate card with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The card is a draft or cancelled, or its date has already arrived (rate-card-not-cancellable), or a concurrent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'rateCardId', format: 'uuid' })
  async cancel(
    @Param('tenantId') tenantId: string,
    @Param('rateCardId') rateCardId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<RateCardResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(rateCardId, 'rateCardId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.cancel({ tenantId, actorUserId: session.userId, rateCardId }, key);
    return { rateCard: toRateCardDto(snapshot.rateCard) };
  }

  @Delete(':tenantId/rate-cards/:rateCardId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Discards a draft (rates.manage) — only a draft is ever deleted; a repeat under a new key is 404, a replay under the same key 204',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiNoContentResponse({ description: 'The draft and its lines were deleted' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed rateCardId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No rate card with this id exists in this tenant, or it was already discarded (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The card is not a draft (rate-card-not-draft), or a concurrent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'rateCardId', format: 'uuid' })
  async discard(
    @Param('tenantId') tenantId: string,
    @Param('rateCardId') rateCardId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<void> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(rateCardId, 'rateCardId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    await this.command.discardDraft({ tenantId, actorUserId: session.userId, rateCardId }, key);
  }
}

/** The wire shape: the instants (`effectiveFromAt`/`effectiveToAt`) are facade-only. */
function toRateCardDto(card: RateCardSnapshot): RateCardDto {
  return {
    id: card.id,
    tenantId: card.tenantId,
    clientId: card.clientId,
    status: card.status,
    effectiveFrom: card.effectiveFrom,
    effectiveTo: card.effectiveTo,
    lines: card.lines.map((line) => ({ ...line })),
    createdBy: card.createdBy,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    activatedBy: card.activatedBy,
    activatedAt: card.activatedAt,
    cancelledBy: card.cancelledBy,
    cancelledAt: card.cancelledAt,
  };
}

function assertUuidParam(value: string, name: 'clientId' | 'rateCardId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, `Malformed ${name}`, `${name} must be a uuid (got "${value}").`);
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
