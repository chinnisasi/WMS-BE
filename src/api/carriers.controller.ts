import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { CarriersFacade } from '../modules/carriers/carriers.facade';
import { invalidUuidParam } from '../modules/carriers/carriers.errors';
import type { CarrierConnectionView } from '../modules/carriers/carriers.facade';
import {
  CarrierCatalogueResponse,
  CarrierConnectionListResponse,
  CarrierConnectionResponse,
  ConnectCarrierDto,
  RotateCarrierCredentialDto,
} from './carriers.dto';

/**
 * The list query, declared here beside the route (the `DeviceListQuery`
 * precedent): `@Query()` needs the class as a VALUE for the validation pipe's
 * `design:paramtypes` metadata, so it cannot be a type-only import.
 */
export class CarrierConnectionListQuery {
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
 * The carriers HTTP surface (Story 4.6b): the adapter-registry catalogue and
 * the tenant credential vault — connect, list, rotate, disconnect. The api
 * shell is the only HTTP surface of the monolith; every mutation goes through
 * `CarriersFacade` onto the command service, which re-reads the member role
 * from the DB per command (the token is transport, never authority, AD-4).
 *
 * `rotate` and `disconnect` are POST sub-resources, not PUT/DELETE: the repo
 * has no `@Delete` route anywhere — every destructive verb is a POST carrying
 * an `Idempotency-Key` (the `devices/{id}/revoke` shape).
 *
 * **No route on this controller can return credential material.** The
 * connect/rotate bodies are write-only, and every response DTO carries the
 * connection's public face alone.
 */
@ApiTags('carriers')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class CarriersController {
  constructor(@Inject(CarriersFacade) private readonly carriers: CarriersFacade) {}

  @Get(':tenantId/carriers')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'The carrier adapter catalogue: supported carrier codes, display names and the credential fields each one requires (open to any member)',
  })
  @ApiOkResponse({ type: CarrierCatalogueResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  catalogue(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): CarrierCatalogueResponse {
    assertOwnTenant(session.tenantId, tenantId);
    return {
      items: this.carriers.catalogue().map((adapter) => ({
        code: adapter.code,
        displayName: adapter.displayName,
        credentialFields: adapter.credentialFields.map((field) => ({ ...field })),
      })),
    };
  }

  @Get(':tenantId/carriers/connections')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Lists the tenant's configured carrier accounts (keyset cursor pagination — public faces only, never credential material)",
  })
  @ApiOkResponse({ type: CarrierConnectionListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor) or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listConnections(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: CarrierConnectionListQuery,
  ): Promise<CarrierConnectionListResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const page = await this.carriers.listConnections(tenantId, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(toConnectionResponse), nextCursor: page.nextCursor };
  }

  @Post(':tenantId/carriers/connections')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Connects a carrier account (carrier.manage) — the credential is sealed under CARRIER_ENCRYPTION_KEY and never returned; one connection per carrier per tenant',
  })
  @ApiBody({ type: ConnectCarrierDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: CarrierConnectionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an unknown carrierCode, or credential material missing a required field (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks carrier.manage (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('This carrier is already connected for the tenant — rotate instead (carrier-already-connected), or the same Idempotency-Key is in flight concurrently (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The deployment has no CARRIER_ENCRYPTION_KEY (carrier-encryption-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async connect(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ConnectCarrierDto,
  ): Promise<CarrierConnectionResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const connection = await this.carriers.connect(
      {
        tenantId,
        actorUserId: session.userId,
        carrierCode: dto.carrierCode,
        accountLabel: dto.accountLabel,
        credential: dto.credential,
      },
      key,
    );
    return toConnectionResponse(connection);
  }

  @Post(':tenantId/carriers/connections/:connectionId/rotate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Rotates a connection’s credential (carrier.manage) — same id, credentialVersion + 1, rotatedAt/rotatedBy stamped; the old material is overwritten',
  })
  @ApiBody({ type: RotateCarrierCredentialDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: CarrierConnectionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, malformed connectionId, credential material missing a required field, or a connection whose carrier this build no longer registers (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks carrier.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such connection in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The same Idempotency-Key is being processed concurrently (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The deployment has no CARRIER_ENCRYPTION_KEY (carrier-encryption-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  async rotate(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RotateCarrierCredentialDto,
  ): Promise<CarrierConnectionResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(connectionId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const connection = await this.carriers.rotate(
      { tenantId, actorUserId: session.userId, connectionId, credential: dto.credential },
      key,
    );
    return toConnectionResponse(connection);
  }

  @Post(':tenantId/carriers/connections/:connectionId/disconnect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Disconnects a carrier account (carrier.manage) — a hard delete (AD-15): the row and its sealed material are gone, the audit row records it; a repeat is 404',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: CarrierConnectionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or malformed connectionId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks carrier.manage (role-denied)') })
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
  ): Promise<CarrierConnectionResponse> {
    assertOwnTenant(session.tenantId, tenantId);
    assertUuidParam(connectionId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const connection = await this.carriers.disconnect(
      { tenantId, actorUserId: session.userId, connectionId },
      key,
    );
    return toConnectionResponse(connection);
  }
}

/**
 * The view IS the response — spread, not hand-copied, so a field added to the
 * view cannot silently go missing here. Safe precisely because
 * `CarrierConnectionView` has no secret-bearing field to leak (the sealed
 * blob is never even selected out of the table).
 */
function toConnectionResponse(connection: CarrierConnectionView): CarrierConnectionResponse {
  return { ...connection };
}

/** Connection uuid path params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string): void {
  if (!UUID_RE.test(value)) {
    throw invalidUuidParam('connectionId', value);
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
