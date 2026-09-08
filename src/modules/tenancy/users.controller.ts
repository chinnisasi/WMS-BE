import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiHeaders,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ProblemDetailsDto } from '../../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { CurrentSession } from './tenant-session.guard';
import { TenantSessionGuard } from './tenant-session.guard';
import type { TenantSession } from './jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from './idempotency-guard';
// Constructor params are types here but must stay value imports: Nest DI needs
// the runtime class tokens for decorator metadata (eslint rule bends for them).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersCommand } from './users.command';
// InviteUserDto/SetUserRoleDto are bound to @Body() *and* read by the Swagger
// explorer through emitDecoratorMetadata — a type-only import erases the
// runtime reference and the OpenAPI document loses the request body.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { InviteUserDto, SetUserRoleDto } from './tenancy.dto';
import {
  AcceptInviteDto,
  AcceptInviteResponse,
  InviteUserResponse,
  MeResponse,
  UserListResponse,
  UserResponse,
} from './tenancy.dto';
import type { UserRole } from '../../shared/db/schema';

export class UsersListQuery {
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
    // ULID: 26 chars, Crockford base32.
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

/**
 * Users HTTP surface (Story 1.5): invite (Owner capability `users.invite`),
 * cursor list (open to any tenant member — reads are never gated), role
 * change (Owner capability `users.role_change`), the unauthenticated
 * accept-invite, and `me`. Mutations carry the ULID Idempotency-Key contract
 * (AD-5); denials are RFC 9457 problem-details with machine-readable codes
 * (`role-denied`, `email-exists`, `last-owner`, `invite-invalid`).
 */
@ApiTags('tenancy')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class UsersController {
  constructor(private readonly usersCommand: UsersCommand) {}

  @Post(':tenantId/users')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Invites a user (Owner only) — returns the one-time invite token' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: InviteUserResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks users.invite (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Email already has an account in any tenant (email-exists), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async inviteUser(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: InviteUserDto,
  ): Promise<InviteUserResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.usersCommand.invite(
      { tenantId, actorUserId: session.userId, email: dto.email, role: dto.role },
      key,
    );
    return { ...snapshot, user: { ...snapshot.user } };
  }

  @Get(':tenantId/users')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lists the tenant’s users (keyset cursor pagination — open to any member)' })
  @ApiOkResponse({ type: UserListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor) or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listUsers(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: UsersListQuery,
  ): Promise<UserListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.usersCommand.list(
      tenantId,
      query.cursor,
      query.limit === undefined ? undefined : query.limit,
    );
    return { items: page.items.map((user) => ({ ...user })), nextCursor: page.nextCursor };
  }

  @Patch(':tenantId/users/:userId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Changes a user’s role (Owner capability users.role_change; effective on the user’s next command)' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: UserResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks users.role_change (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('User does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The target is the tenant’s last Owner (last-owner), or a concurrent idempotent request (conflict)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  async setUserRole(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: SetUserRoleDto,
  ): Promise<UserResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const user = await this.usersCommand.setUserRole(
      { tenantId, actorUserId: session.userId, targetUserId: userId, role: dto.role as UserRole },
      key,
    );
    return { ...user };
  }

  @Post(':tenantId/accept-invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accepts a one-time invite (unauthenticated): sets the account password and activates the user' })
  @ApiBody({ type: AcceptInviteDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: AcceptInviteResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, invalid body, or an unknown/used/expired token (invite-invalid)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'The inviting tenant (embedded in the invite link)' })
  async acceptInvite(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Body() dto: AcceptInviteDto,
  ): Promise<AcceptInviteResponse> {
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.usersCommand.acceptInvite(
      { tenantId, token: dto.token, password: dto.password },
      key,
    );
    return { ...snapshot };
  }

  @Get(':tenantId/me')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in user’s own row (id, email, role, status)' })
  @ApiOkResponse({ type: MeResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async me(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<MeResponse> {
    assertOwnTenant(session, tenantId);
    const user = await this.usersCommand.me(tenantId, session.userId);
    return { user: { ...user } };
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