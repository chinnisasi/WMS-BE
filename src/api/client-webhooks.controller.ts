import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { CurrentSession, TenantSessionGuard } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { ClientWebhooksCommand, type WebhookEndpointMutationSnapshot } from '../modules/client-webhooks/client-webhooks.command';
import { ClientWebhooksFacade, webhookWarnings } from '../modules/client-webhooks/client-webhooks.facade';
// Bound to @Body() / @Query() — value imports (the ValidationPipe reads the classes).
import {
  BulkRedeliverWebhooksDto,
  CreateWebhookEndpointDto,
  RotateWebhookSecretDto,
  UpdateWebhookEndpointDto,
  WebhookBulkRedeliverResponse,
  WebhookDeliveryDetailResponse,
  WebhookDeliveryListResponse,
  WebhookEndpointListResponse,
  WebhookEndpointResponse,
  WebhookRedeliverResponse,
  WebhookTestResponse,
} from './client-webhooks.dto';
// Bound to @Query() — a value import (the ValidationPipe reads the class).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { WebhookDeliveryListQuery } from './client-webhooks.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const BASE = ':tenantId/clients/:clientId/webhook-endpoints';
const R401 = { status: 401, ...problemJsonResponse('Missing or invalid session token') };
const R403 = {
  status: 403,
  ...problemJsonResponse('Session belongs to another tenant (permission-denied), a client-portal session, or the caller lacks clients.manage — owner only (role-denied)'),
};
const R404_ENDPOINT = { status: 404, ...problemJsonResponse('No client with this id, or no live webhook endpoint with this id for this client (not-found — another client’s endpoint is the same 404)') };
const R409_KEY = 'a concurrent request with the same Idempotency-Key (conflict)';
const R422 = { status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') };
const TENANT_PARAM = { name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' } as const;
const CLIENT_PARAM = { name: 'clientId', format: 'uuid' } as const;
const ENDPOINT_PARAM = { name: 'endpointId', format: 'uuid' } as const;

/**
 * Story 5-2a — a client's outbound webhooks, configured by staff on the
 * client's behalf (owner-only, `clients.manage` — reads too: URLs and
 * payloads are integration detail). Holds no rules: the command owns
 * authority, replay and the shape rules; this maps DTOs. Never a portal
 * route. The channels' INBOUND `webhooks.controller.ts` is unrelated.
 */
@ApiTags('client-webhooks')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ClientWebhooksController {
  constructor(
    @Inject(ClientWebhooksCommand) private readonly command: ClientWebhooksCommand,
    @Inject(ClientWebhooksFacade) private readonly facade: ClientWebhooksFacade,
  ) {}

  @Get(BASE)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists a client's webhook endpoints, oldest first (owner-only, clients.manage). Never shows a signing secret — only its last four characters" })
  @ApiOkResponse({ type: WebhookEndpointListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed clientId (validation-failed)') })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(CLIENT_PARAM)
  async list(@Param('tenantId') tenantId: string, @Param('clientId') clientId: string, @CurrentSession() session: TenantSession): Promise<WebhookEndpointListResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    return { items: await this.facade.listEndpoints(tenantId, session.userId, clientId) as WebhookEndpointListResponse['items'], warnings: webhookWarnings() };
  }

  @Post(BASE)
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Adds a webhook endpoint for a client (owner-only, clients.manage). The answer carries the signing secret ONCE (`signingSecret`); a replay answers null — rotate to get a new one. At most 5 endpoints per client',
  })
  @ApiBody({ type: CreateWebhookEndpointDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: WebhookEndpointResponse, description: 'The endpoint and its one-time signing secret' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed clientId, a URL that breaks a rule (scheme, userinfo, fragment, host, port, length — named), an unknown or repeated event type, a description over 200 characters, or the warehouse’s own client (validation-failed)'),
  })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(`The client already has 5 endpoints (webhook-endpoint-limit), another of its endpoints has this URL (duplicate-webhook-url), the client has departed (client-departed), WEBHOOK_SEAL_KEY is not configured (webhooks-unavailable), or ${R409_KEY}`),
  })
  @ApiResponse(R422)
  @ApiParam(TENANT_PARAM)
  @ApiParam(CLIENT_PARAM)
  async create(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpointResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.create(
      { tenantId, actorUserId: session.userId, clientId, url: dto.url, description: dto.description ?? null, eventTypes: dto.eventTypes },
      key,
    );
    return endpointResponse(snapshot);
  }

  @Patch(`${BASE}/:endpointId`)
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Edits a webhook endpoint (owner-only, clients.manage): an absent field is unchanged. `status: disabled` disables it by hand (its pending and held deliveries fail); `status: active` re-enables it — with `held: release | discard` when it holds deliveries. A new URL resets the failure counters. An unchanged edit is a no-op (nothing written or audited; the key is stored)',
  })
  @ApiBody({ type: UpdateWebhookEndpointDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: WebhookEndpointResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed id, a URL or event type that breaks its rule, or `held` without `status: active` (validation-failed)') })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404_ENDPOINT)
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(`Another endpoint of the client has this URL (duplicate-webhook-url), re-enabling with held deliveries and no \`held\` decision (held-decision-required, \`heldCount\`), re-enabling for a departed client (client-departed), or ${R409_KEY}`),
  })
  @ApiResponse(R422)
  @ApiParam(TENANT_PARAM)
  @ApiParam(CLIENT_PARAM)
  @ApiParam(ENDPOINT_PARAM)
  async update(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @Param('endpointId') endpointId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateWebhookEndpointDto,
  ): Promise<WebhookEndpointResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    assertUuidParam('endpointId', endpointId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.update(
      {
        tenantId,
        actorUserId: session.userId,
        clientId,
        endpointId,
        ...(dto.url === undefined ? {} : { url: dto.url }),
        ...(dto.description === undefined ? {} : { description: dto.description }),
        ...(dto.eventTypes === undefined ? {} : { eventTypes: dto.eventTypes }),
        ...(dto.status === undefined ? {} : { status: dto.status }),
        ...(dto.held === undefined ? {} : { held: dto.held }),
      },
      key,
    );
    return endpointResponse(snapshot);
  }

  @Delete(`${BASE}/:endpointId`)
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Deletes a webhook endpoint (owner-only, clients.manage). Soft: it stops sending at once, its pending and held deliveries fail, and its delivery log stays readable for 30 days',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: WebhookEndpointResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed id (validation-failed)') })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404_ENDPOINT)
  @ApiResponse({ status: 409, ...problemJsonResponse(`A ${R409_KEY}`) })
  @ApiResponse(R422)
  @ApiParam(TENANT_PARAM)
  @ApiParam(CLIENT_PARAM)
  @ApiParam(ENDPOINT_PARAM)
  async remove(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @Param('endpointId') endpointId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<WebhookEndpointResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    assertUuidParam('endpointId', endpointId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return endpointResponse(await this.command.remove({ tenantId, actorUserId: session.userId, clientId, endpointId }, key));
  }

  @Post(`${BASE}/:endpointId/rotate-secret`)
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Rotates the signing secret (owner-only, clients.manage). The answer carries the new secret ONCE. The old secret keeps signing beside it for 24 hours (`revokePrevious: true` ends it now); a second rotation inside that window drops the oldest',
  })
  @ApiBody({ type: RotateWebhookSecretDto, required: false })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: WebhookEndpointResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed id (validation-failed)') })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404_ENDPOINT)
  @ApiResponse({ status: 409, ...problemJsonResponse(`WEBHOOK_SEAL_KEY is not configured (webhooks-unavailable), or ${R409_KEY}`) })
  @ApiResponse(R422)
  @ApiParam(TENANT_PARAM)
  @ApiParam(CLIENT_PARAM)
  @ApiParam(ENDPOINT_PARAM)
  async rotateSecret(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @Param('endpointId') endpointId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RotateWebhookSecretDto,
  ): Promise<WebhookEndpointResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    assertUuidParam('endpointId', endpointId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return endpointResponse(
      await this.command.rotateSecret(
        { tenantId, actorUserId: session.userId, clientId, endpointId, ...(dto?.revokePrevious === undefined ? {} : { revokePrevious: dto.revokePrevious }) },
        key,
      ),
    );
  }

  @Post(`${BASE}/:endpointId/test`)
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Sends one signed `webhook.test` event to the endpoint now and answers the outcome (owner-only, clients.manage). Allowed while the endpoint is disabled; stores no delivery and never moves the failure counters. At most 10 test sends and redeliveries a minute per endpoint',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: WebhookTestResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed id (validation-failed)') })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404_ENDPOINT)
  @ApiResponse({ status: 409, ...problemJsonResponse(`Sending is off on this server — WEBHOOK_GATEWAY=off (webhooks-unavailable), or ${R409_KEY}`) })
  @ApiResponse(R422)
  @ApiResponse({ status: 429, ...problemJsonResponse('More than 10 test sends and redeliveries this minute on this endpoint (rate-limited; `retryAfterSeconds`)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(CLIENT_PARAM)
  @ApiParam(ENDPOINT_PARAM)
  async test(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @Param('endpointId') endpointId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<WebhookTestResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    assertUuidParam('endpointId', endpointId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.test({ tenantId, actorUserId: session.userId, clientId, endpointId }, key);
    return { test: { ...snapshot.test }, warnings: webhookWarnings() };
  }

  @Get(`${BASE}/:endpointId/deliveries`)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Lists an endpoint's deliveries, newest first (owner-only, clients.manage). A deleted endpoint's log stays readable for 30 days" })
  @ApiOkResponse({ type: WebhookDeliveryListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed id, cursor, limit or status (validation-failed)') })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, ...problemJsonResponse('No client, or no endpoint with this id for this client (not-found)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(CLIENT_PARAM)
  @ApiParam(ENDPOINT_PARAM)
  async deliveries(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @Param('endpointId') endpointId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: WebhookDeliveryListQuery,
  ): Promise<WebhookDeliveryListResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    assertUuidParam('endpointId', endpointId);
    const page = await this.facade.listDeliveries(tenantId, session.userId, clientId, endpointId, {
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    return { items: [...page.items] as WebhookDeliveryListResponse['items'], nextCursor: page.nextCursor };
  }

  // A literal segment, declared BEFORE the `:deliveryId` routes (§6 route order).
  @Post(`${BASE}/:endpointId/deliveries/redeliver`)
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Redelivers every failed delivery (or only the expired ones) created since `since` — at most 1000 a call, oldest first; call again while `remaining` > 0 (owner-only, clients.manage). Refused on an endpoint that is not active',
  })
  @ApiBody({ type: BulkRedeliverWebhooksDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: WebhookBulkRedeliverResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed id, `since` not an instant with a zone, or an unknown status (validation-failed)') })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404_ENDPOINT)
  @ApiResponse({ status: 409, ...problemJsonResponse(`The endpoint is not active (webhook-endpoint-disabled), or ${R409_KEY}`) })
  @ApiResponse(R422)
  @ApiResponse({ status: 429, ...problemJsonResponse('More than 10 test sends and redeliveries this minute on this endpoint (rate-limited; `retryAfterSeconds`)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(CLIENT_PARAM)
  @ApiParam(ENDPOINT_PARAM)
  async bulkRedeliver(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @Param('endpointId') endpointId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: BulkRedeliverWebhooksDto,
  ): Promise<WebhookBulkRedeliverResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    assertUuidParam('endpointId', endpointId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.command.bulkRedeliver(
      { tenantId, actorUserId: session.userId, clientId, endpointId, since: dto.since, ...(dto.statuses === undefined ? {} : { statuses: dto.statuses }) },
      key,
    );
  }

  @Get(`${BASE}/:endpointId/deliveries/:deliveryId`)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One delivery with the exact body every attempt sends (owner-only, clients.manage)' })
  @ApiOkResponse({ type: WebhookDeliveryDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed id (validation-failed)') })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, ...problemJsonResponse('No client, endpoint or delivery with this id (not-found)') })
  @ApiResponse({ status: 410, ...problemJsonResponse('The delivery is older than 30 days and was purged (delivery-purged)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(CLIENT_PARAM)
  @ApiParam(ENDPOINT_PARAM)
  @ApiParam({ name: 'deliveryId', format: 'uuid' })
  async delivery(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @Param('endpointId') endpointId: string,
    @Param('deliveryId') deliveryId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<WebhookDeliveryDetailResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    assertUuidParam('endpointId', endpointId);
    assertUuidParam('deliveryId', deliveryId);
    return { delivery: (await this.facade.getDelivery(tenantId, session.userId, clientId, endpointId, deliveryId)) as WebhookDeliveryDetailResponse['delivery'] };
  }

  @Post(`${BASE}/:endpointId/deliveries/:deliveryId/redeliver`)
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Redelivers one failed or succeeded delivery: the same bytes and `webhook-id`, a fresh timestamp and signature, a fresh retry schedule (owner-only, clients.manage). Refused on an endpoint that is not active',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: WebhookRedeliverResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed id (validation-failed)') })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, ...problemJsonResponse('No client, live endpoint or delivery with this id (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(`The delivery is still pending, sending or held (delivery-in-progress), the endpoint is not active (webhook-endpoint-disabled), or ${R409_KEY}`),
  })
  @ApiResponse({ status: 410, ...problemJsonResponse('The delivery is older than 30 days and was purged (delivery-purged)') })
  @ApiResponse(R422)
  @ApiResponse({ status: 429, ...problemJsonResponse('More than 10 test sends and redeliveries this minute on this endpoint (rate-limited; `retryAfterSeconds`)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(CLIENT_PARAM)
  @ApiParam(ENDPOINT_PARAM)
  @ApiParam({ name: 'deliveryId', format: 'uuid' })
  async redeliver(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @Param('endpointId') endpointId: string,
    @Param('deliveryId') deliveryId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<WebhookRedeliverResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    assertUuidParam('endpointId', endpointId);
    assertUuidParam('deliveryId', deliveryId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.redeliver({ tenantId, actorUserId: session.userId, clientId, endpointId, deliveryId }, key);
    return { delivery: snapshot.delivery as WebhookRedeliverResponse['delivery'] };
  }
}

function endpointResponse(snapshot: WebhookEndpointMutationSnapshot): WebhookEndpointResponse {
  return {
    endpoint: snapshot.endpoint as WebhookEndpointResponse['endpoint'],
    signingSecret: snapshot.signingSecret,
    ...(snapshot.heldReleased === undefined ? {} : { heldReleased: snapshot.heldReleased }),
    ...(snapshot.heldDiscarded === undefined ? {} : { heldDiscarded: snapshot.heldDiscarded }),
    warnings: webhookWarnings(),
  };
}

function assertUuidParam(name: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, `Malformed ${name}`, `${name} must be a uuid (got "${value}").`);
  }
}

function assertOwnTenant(session: TenantSession, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new ProblemException('permission-denied', 403, 'Session belongs to another tenant', 'The session token tenant does not own this path.');
  }
}
