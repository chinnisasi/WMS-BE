import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
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
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SecondFactorCommand } from './second-factor.command';
import type { SelfServiceCaller } from './second-factor.command';
import { clientIpOf } from './auth-attempts';
// InviteUserDto/SetUserRoleDto are bound to @Body() *and* read by the Swagger
// explorer through emitDecoratorMetadata — a type-only import erases the
// runtime reference and the OpenAPI document loses the request body.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  InviteUserDto,
  SecondFactorCodeDto,
  SecondFactorSetupDto,
  SetUserRoleDto,
  UserStatusResponse,
} from './tenancy.dto';
import {
  AcceptInviteDto,
  AcceptInviteResponse,
  InviteUserResponse,
  MeResponse,
  BackupCodesResponse,
  SecondFactorResetResponse,
  SecondFactorSetupResponse,
  SecondFactorStatusResponse,
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
  constructor(
    private readonly usersCommand: UsersCommand,
    private readonly secondFactorCommand: SecondFactorCommand,
  ) {}

  @Post(':tenantId/users')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Invites a user (Owner only) — returns the one-time invite token and accept link, and queues the invite email',
    description:
      'Story 5-1a: the invite email is queued in the same transaction (`inviteEmail.status` `pending`, or `skipped` when the email provider is off or the address is outside the allowlist); `inviteUrl` is the accept link the email carries.',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: InviteUserResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, invalid body, a client invite without clientId / a staff invite with one, or the tenant\u2019s own client (story 21-7)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks users.invite (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Story 21-7: the named client does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Email already has an account in any tenant (email-exists), the named client is not active (client-not-active, story 21-7), or a concurrent idempotent request (conflict)') })
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
      {
        tenantId,
        actorUserId: session.userId,
        email: dto.email,
        role: dto.role,
        ...(dto.clientId === undefined ? {} : { clientId: dto.clientId }),
      },
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
      session.userId,
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
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, invalid body, or a client-portal user as the target (story 21-7 — its role is fixed at invite)') })
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

  @Post(':tenantId/users/:userId/deactivate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 6-1a — deactivates a user (users.role_change): no sign-in or badge-in, every session ends now, device bindings released, a pending invite cancelled; history kept. Idempotent (an already-deactivated user writes nothing)' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: UserStatusResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or malformed userId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks users.role_change (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('User does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The last active Owner (last-owner — self-deactivation included), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  async deactivateUser(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<UserStatusResponse> {
    assertOwnTenant(session, tenantId);
    assertUserIdParam(userId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.usersCommand.setUserStatus(
      { tenantId, actorUserId: session.userId, targetUserId: userId, arm: 'deactivate' },
      key,
    );
  }

  @Post(':tenantId/users/:userId/reactivate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 6-1a — reactivates a deactivated user (users.role_change), restoring the status deactivation replaced; a never-accepted invitee gets a fresh invite token. Idempotent' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: UserStatusResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or malformed userId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks users.role_change (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('User does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  async reactivateUser(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<UserStatusResponse> {
    assertOwnTenant(session, tenantId);
    assertUserIdParam(userId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.usersCommand.setUserStatus(
      { tenantId, actorUserId: session.userId, targetUserId: userId, arm: 'reactivate' },
      key,
    );
  }

  @Post(':tenantId/users/:userId/resend-invite')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Story 5-1a — sends an invited user a NEW invitation (users.invite, Owner): a fresh one-time token (the old link stops working), a new 7-day expiry, and a new invite email (older queued ones are cancelled). Keyed; audited user.invite_resent',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: InviteUserResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or malformed userId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks users.invite (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('User does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The user is not invited — already active, or deactivated (user-not-invited); a portal user whose client is not active (client-not-active); or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  async resendInvite(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<InviteUserResponse> {
    assertOwnTenant(session, tenantId);
    assertUserIdParam(userId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.usersCommand.resendInvite({ tenantId, actorUserId: session.userId, targetUserId: userId }, key);
    return { ...result, user: { ...result.user } };
  }

  @Post(':tenantId/users/:userId/unlock')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 6-1a — clears the sign-in lock on this user’s email from every address (users.role_change). Audited; keyed' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: UserResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or malformed userId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks users.role_change (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('User does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  async unlockUser(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<UserResponse> {
    assertOwnTenant(session, tenantId);
    assertUserIdParam(userId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return { ...(await this.usersCommand.unlockUser({ tenantId, actorUserId: session.userId, targetUserId: userId }, key)) };
  }

  @Post(':tenantId/users/:userId/second-factor/reset')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Story 6-1b — resets a colleague’s two-factor sign-in (users.role_change); answers a one-time enrolment code (72 h) to hand over in person',
    description:
      'Clears the authenticator, the backup codes, the lock and any sign-in in progress, and ends the user’s web sessions. Their next sign-in sets two-factor up again and needs the enrolment code. Keyed; a user with nothing to reset is a no-op (null code). Your own: My account → Security.',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: SecondFactorResetResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or malformed userId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks users.role_change (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('User does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Your own account (self-reset), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  async resetSecondFactor(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<SecondFactorResetResponse> {
    assertOwnTenant(session, tenantId);
    assertUserIdParam(userId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return {
      ...(await this.secondFactorCommand.reset({ tenantId, actorUserId: session.userId, targetUserId: userId }, key)),
    };
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
    return { user: { ...snapshot.user, clientId: snapshot.user.clientId ?? null } };
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

  // ── Story 6-1b — My account → Security (the caller acts only on themselves) ──
  // Not keyed: the answers carry secrets or backup codes, which never enter
  // `idempotency_keys`; a lost answer is recovered by regenerating. A wrong
  // code is 422 (never 401 — that would sign the web user out).

  @Get(':tenantId/me/second-factor')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 6-1b — the caller’s two-factor sign-in: on or off, required for the role, backup codes left' })
  @ApiOkResponse({ type: SecondFactorStatusResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async secondFactorStatus(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<SecondFactorStatusResponse> {
    assertOwnTenant(session, tenantId);
    return { ...(await this.secondFactorCommand.status(tenantId, session.userId)) };
  }

  @Post(':tenantId/me/second-factor/setup')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Story 6-1b — starts setting up (or replacing) the authenticator: answers a new secret to scan, then confirm it',
    description: 'With two-factor sign-in off it needs the current `password` (counted like sign-in); with it on, a current `code` (or a backup code).',
  })
  @ApiBody({ type: SecondFactorSetupDto })
  @ApiOkResponse({ type: SecondFactorSetupResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Invalid body, or the proof this state needs is missing (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The factor changed while this ran (second-factor-changed)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Wrong password (password-invalid) or wrong code (second-factor-invalid; `attemptsLeft`) — the session stays') })
  @ApiResponse({ status: 423, ...problemJsonResponse('Too many wrong passwords (sign-in-locked) or codes (second-factor-locked)') })
  @ApiResponse({ status: 429, ...problemJsonResponse('Too many attempts from this address (rate-limited)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The stored secret cannot be opened with the configured key (second-factor-unavailable); nothing was counted') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async secondFactorSetup(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Req() request: IpRequest,
    @Body() dto: SecondFactorSetupDto,
  ): Promise<SecondFactorSetupResponse> {
    const caller = selfServiceCaller(session, tenantId, request);
    return {
      ...(await this.secondFactorCommand.setup(caller, {
        ...(dto.password === undefined ? {} : { password: dto.password }),
        ...(dto.code === undefined ? {} : { code: dto.code }),
      })),
    };
  }

  @Post(':tenantId/me/second-factor/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Story 6-1b — confirms the new authenticator with a code from it; answers ten backup codes once',
    description: 'Replacing an authenticator ends your other web sessions (this one stays).',
  })
  @ApiBody({ type: SecondFactorCodeDto })
  @ApiOkResponse({ type: BackupCodesResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('No setup in progress, or it expired after 24 h (second-factor-setup-expired), or it changed meanwhile (second-factor-changed)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Wrong code (second-factor-invalid; `attemptsLeft`) — the session stays') })
  @ApiResponse({ status: 423, ...problemJsonResponse('Too many wrong codes (second-factor-locked)') })
  @ApiResponse({ status: 429, ...problemJsonResponse('Too many attempts from this address (rate-limited)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The stored secret cannot be opened with the configured key (second-factor-unavailable); nothing was counted') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async secondFactorConfirm(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Req() request: IpRequest,
    @Body() dto: SecondFactorCodeDto,
  ): Promise<BackupCodesResponse> {
    return { ...(await this.secondFactorCommand.confirm(selfServiceCaller(session, tenantId, request), dto.code)) };
  }

  @Post(':tenantId/me/second-factor/backup-codes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Story 6-1b — replaces the backup codes (the old ones stop working); answers the new ten once',
    description: 'Needs a current code or a backup code. Ends your other web sessions (this one stays).',
  })
  @ApiBody({ type: SecondFactorCodeDto })
  @ApiOkResponse({ type: BackupCodesResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Two-factor sign-in is off (second-factor-not-enabled), or it changed meanwhile (second-factor-changed)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Wrong code (second-factor-invalid; `attemptsLeft`) — the session stays') })
  @ApiResponse({ status: 423, ...problemJsonResponse('Too many wrong codes (second-factor-locked)') })
  @ApiResponse({ status: 429, ...problemJsonResponse('Too many attempts from this address (rate-limited)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The stored secret cannot be opened with the configured key (second-factor-unavailable); nothing was counted') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async secondFactorBackupCodes(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Req() request: IpRequest,
    @Body() dto: SecondFactorCodeDto,
  ): Promise<BackupCodesResponse> {
    return {
      ...(await this.secondFactorCommand.regenerateBackupCodes(selfServiceCaller(session, tenantId, request), dto.code)),
    };
  }

  @Post(':tenantId/me/second-factor/disable')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Story 6-1b — turns two-factor sign-in off (not for owners, who must use it)',
    description: 'Needs a current code or a backup code. Ends your other web sessions (this one stays).',
  })
  @ApiBody({ type: SecondFactorCodeDto })
  @ApiOkResponse({ type: SecondFactorStatusResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The role requires two-factor sign-in (second-factor-required), it is already off (second-factor-not-enabled), or it changed meanwhile (second-factor-changed)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Wrong code (second-factor-invalid; `attemptsLeft`) — the session stays') })
  @ApiResponse({ status: 423, ...problemJsonResponse('Too many wrong codes (second-factor-locked)') })
  @ApiResponse({ status: 429, ...problemJsonResponse('Too many attempts from this address (rate-limited)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The stored secret cannot be opened with the configured key (second-factor-unavailable); nothing was counted') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async secondFactorDisable(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Req() request: IpRequest,
    @Body() dto: SecondFactorCodeDto,
  ): Promise<SecondFactorStatusResponse> {
    return { ...(await this.secondFactorCommand.disable(selfServiceCaller(session, tenantId, request), dto.code)) };
  }
}

/** The slice of the Express request the self-service routes read (the client address). */
interface IpRequest {
  headers: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

/** Story 6-1b — the self-service caller: the session's own user, on its own tenant's path. */
function selfServiceCaller(session: TenantSession, tenantId: string, request: IpRequest): SelfServiceCaller {
  assertOwnTenant(session, tenantId);
  return { tenantId, userId: session.userId, sessionId: session.sessionId, ip: clientIpOf(request) };
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

/** Story 6-1a — a malformed `userId` is a 400, never a database cast error. */
function assertUserIdParam(userId: string): void {
  if (!UUID_PARAM_RE.test(userId)) {
    throw new ProblemException('validation-failed', 400, 'Validation failed', 'userId must be a UUID.');
  }
}

const UUID_PARAM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
