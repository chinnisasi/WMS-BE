import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiHeaders,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { CurrentSession, TenantSessionGuard } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { ClientsCommand } from '../modules/clients/clients.command';
import { ClientsFacade, type ClientSnapshot } from '../modules/clients/clients.facade';
import { ClientListResponse, ClientResponse, CreateClientDto, RenameClientDto } from './clients.dto';
import type { ClientDto } from './clients.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

/**
 * Story 21-2b — the client admin surface: list (member-open), create and
 * rename (owner-only, `clients.manage`). Holds no rules — the command owns
 * authority, replay and the shape rules; this maps DTOs.
 */
@ApiTags('clients')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ClientsController {
  constructor(
    @Inject(ClientsCommand) private readonly command: ClientsCommand,
    @Inject(ClientsFacade) private readonly facade: ClientsFacade,
  ) {}

  @Get(':tenantId/clients')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Lists the tenant's clients — every status, the system-owned `self` client first, then by code (unpaginated, bounded at 500)",
  })
  @ApiOkResponse({ type: ClientListResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listClients(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<ClientListResponse> {
    assertOwnTenant(session, tenantId);
    return { items: (await this.facade.listClients(tenantId)).map(toClientDto) };
  }

  @Post(':tenantId/clients')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Registers a client brand (owner-only). The code is stored uppercase; the client starts active' })
  @ApiBody({ type: CreateClientDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ClientResponse, description: 'The created client (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a code/name that breaks the shape rules — including the reserved code SELF (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The code is already used by another client of this tenant, including by a concurrent create (duplicate-client-code), or a concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createClient(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateClientDto,
  ): Promise<ClientResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.create(
      { tenantId, actorUserId: session.userId, code: dto.code, name: dto.name },
      key,
    );
    return { client: toClientDto(snapshot.client) };
  }

  @Patch(':tenantId/clients/:clientId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Renames a client (owner-only). The tenant's own `self` client mirrors the tenant name and cannot be renamed" })
  @ApiBody({ type: RenameClientDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed clientId, a name outside 1-200 characters, or a rename of the self client (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async renameClient(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RenameClientDto,
  ): Promise<ClientResponse> {
    assertOwnTenant(session, tenantId);
    if (!UUID_RE.test(clientId)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Malformed clientId',
        `clientId must be a uuid (got "${clientId}").`,
      );
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.rename(
      { tenantId, actorUserId: session.userId, clientId, name: dto.name },
      key,
    );
    return { client: toClientDto(snapshot.client) };
  }
}

function toClientDto(client: ClientSnapshot): ClientDto {
  return { ...client };
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
