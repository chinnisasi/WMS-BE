import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiHeaders,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { ChannelsFacade } from '../modules/channels/channels.facade';
import type { DisconnectChannelCommand } from '../modules/channels/channels.facade';
import { invalidUuidParam } from '../modules/channels/channels.errors';
import {
  ChannelBuffersSetResponse,
  ChannelConnectionsResponse,
  ChannelConnectionResponse,
  type ChannelConnectionListEntryDto,
  ConnectChannelDto,
  RotateChannelCredentialDto,
  SetChannelBuffersDto,
  UpdateConnectionConfigDto,
  toConnectionResponse,
  toListEntryResponse,
  toVerdictResponses,
} from './channels.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

/**
 * The channels HTTP surface (story 7-1): the sales-channel connections
 * (connect / credentials / config / buffers / disconnect / retry) and the
 * sync-health list. The api shell is the only HTTP surface of the monolith;
 * every mutation goes through `ChannelsCommandService` via `ChannelsFacade`,
 * which re-reads the member role from the DB per command (the token is
 * transport, never authority, AD-4).
 *
 * `connect` is a POST with an Idempotency-Key; `credentials`, `config` and
 * `buffers` are PUTs; `disconnect` is the story's frozen `DELETE` arm
 * (204 — the repo's second Delete route after replenishment's story 6-1
 * route: the spec's I/O matrix names it,
 * so the carriers module's POST-sub-resource convention yields to it — the
 * idempotency key stays required, so a crash can't double-revoke) and
 * `retry` is a POST. **No route on this controller can return credential
 * material** — every response carries the connection's public face.
 */
@ApiTags('channels')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ChannelsController {
  constructor(@Inject(ChannelsFacade) private readonly channels: ChannelsFacade) {}

  @Post(':tenantId/channels/connections')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Connects a sales channel (channel.manage) — the credential is sealed under CHANNEL_ENCRYPTION_KEY and never returned; one connection per provider per tenant',
  })
  @ApiBody({ type: ConnectChannelDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiCreatedResponse({ type: ChannelConnectionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an unknown provider, or credential material missing a required field (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks channel.manage (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('This provider is already connected for the tenant — rotate instead (connection-exists), or the same Idempotency-Key is in flight concurrently (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The deployment has no CHANNEL_ENCRYPTION_KEY (channel-encryption-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async connect(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ConnectChannelDto,
  ): Promise<ChannelConnectionResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const connection = await this.channels.connect(
      {
        tenantId,
        actorUserId: session.userId,
        provider: dto.provider,
        credentials: dto.credentials,
      },
      key,
    );
    return toConnectionResponse(connection);
  }

  @Put(':tenantId/channels/connections/:connectionId/credentials')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Rotates a connection’s credential (channel.manage) — same id, credentialVersion + 1, rotatedAt/rotatedBy stamped; the old material is overwritten',
  })
  @ApiBody({ type: RotateChannelCredentialDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ChannelConnectionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, malformed connectionId, credential material missing a required field, or a provider this build no longer registers (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks channel.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such connection in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The same Idempotency-Key is being processed concurrently (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The deployment has no CHANNEL_ENCRYPTION_KEY (channel-encryption-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  async rotateCredentials(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RotateChannelCredentialDto,
  ): Promise<ChannelConnectionResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(connectionId, 'connectionId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const connection = await this.channels.rotateCredentials(
      { tenantId, actorUserId: session.userId, connectionId, credentials: dto.credentials },
      key,
    );
    return toConnectionResponse(connection);
  }

  @Put(':tenantId/channels/connections/:connectionId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Sets the connection's backorder policy (channel.manage) — consumed by 7-2's ingestion acceptance",
  })
  @ApiBody({ type: UpdateConnectionConfigDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ChannelConnectionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, malformed connectionId, or an unknown backorderPolicy (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks channel.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such connection in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The same Idempotency-Key is being processed concurrently (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  async updateConnectionConfig(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateConnectionConfigDto,
  ): Promise<ChannelConnectionResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(connectionId, 'connectionId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const connection = await this.channels.updateConnectionConfig(
      {
        tenantId,
        actorUserId: session.userId,
        connectionId,
        backorderPolicy: dto.backorderPolicy as 'accept' | 'reject',
      },
      key,
    );
    return toConnectionResponse(connection);
  }

  @Put(':tenantId/channels/connections/:connectionId/buffers')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Places / adjusts / clears the connection’s standing buffers per item (channel.manage) — each item a buffer-over-ceiling refusal when the pool cannot grant it; a refusal leaves the OLD buffer standing',
  })
  @ApiBody({ type: SetChannelBuffersDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ChannelBuffersSetResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, malformed connectionId, an items list out of bounds (1–200), or a bufferMilli out of range (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks channel.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such connection, warehouse or SKU in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The same Idempotency-Key is being processed concurrently (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The reservation store is unreachable (reservation-store-unavailable) — nothing was written') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  async setConnectionBuffers(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: SetChannelBuffersDto,
  ): Promise<ChannelBuffersSetResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(connectionId, 'connectionId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.channels.setConnectionBuffers(
      {
        tenantId,
        actorUserId: session.userId,
        connectionId,
        items: dto.items.map((item) => ({
          warehouseId: item.warehouseId,
          skuId: item.skuId,
          bufferMilli: item.bufferMilli,
        })),
      },
      key,
    );
    return { connectionId: result.connectionId, verdicts: toVerdictResponses(result.verdicts) };
  }

  @Delete(':tenantId/channels/connections/:connectionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Disconnects a channel (channel.manage, DELETE = the story’s frozen arm 3) — a hard delete: the sealed material is gone, its standing buffers release through the reservation core, the revoke attempt is metered and logged but NEVER blocking; a repeat is 404',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiNoContentResponse({ description: 'The connection was deleted (its buffers released, its mappings dropped)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or malformed connectionId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks channel.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such connection in this tenant, or it was already disconnected (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The same Idempotency-Key is being processed concurrently (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  async disconnect(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<void> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(connectionId, 'connectionId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const command: DisconnectChannelCommand = {
      tenantId,
      actorUserId: session.userId,
      connectionId,
    };
    // The DELETE verb has no snapshot to serve; a replay under the same key
    // settles without a second revoke attempt and answers 204 (the command
    // consumes the key row), and a repeat under a NEW key is the 404.
    await this.channels.disconnect(command, key);
  }

  @Get(':tenantId/channels/connections')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Lists the tenant's channel connections with sync health (ok|degraded|error), lag and breaker state, buffer buckets and mapping counts — public faces only, never credential material",
  })
  @ApiOkResponse({ type: ChannelConnectionsResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listConnections(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<ChannelConnectionsResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const entries = await this.channels.listConnections(tenantId);
    return { items: entries.map(toListEntryResponse) };
  }

  @Post(':tenantId/channels/connections/:connectionId/retry')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Retries a stalled connection (channel.manage) — re-appends the availability snapshot through the outbox and half-opens the breaker',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ChannelConnectionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or malformed connectionId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks channel.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such connection in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The same Idempotency-Key is being processed concurrently (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The reservation store is unreachable — the ATP read failed closed (reservation-store-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  async retryConnection(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<ChannelConnectionResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(connectionId, 'connectionId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const connection = await this.channels.retryConnection(
      { tenantId, actorUserId: session.userId, connectionId },
      key,
    );
    return toConnectionResponse(connection);
  }
}

/** Connection uuid path params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw invalidUuidParam(name, value);
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

/** The list-entry DTO re-exported for the openapi surface's component set. */
export type { ChannelConnectionListEntryDto };