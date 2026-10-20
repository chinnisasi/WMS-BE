import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
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
  getSchemaPath,
} from '@nestjs/swagger';
import { ProblemDetailsDto } from '../../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { CurrentSession } from './tenant-session.guard';
import { TenantSessionGuard } from './tenant-session.guard';
import type { TenantSession } from './jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from './idempotency-guard';
import { clientIpOf } from './auth-attempts';
import {
  REFRESH_COOKIE_NAME,
  assertSessionRequestOrigin,
  clearedRefreshCookieHeader,
  readCookie,
  refreshCookieHeader,
} from './session-cookie';

/** Story 6-1b — the header a web build that can complete the second step sends on sign-in. */
const SECOND_FACTOR_HEADER = 'x-wms-second-factor';

/** The slice of the Express request / response the session routes touch. */
interface SessionHttpRequest {
  headers: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}
interface SessionHttpResponse {
  setHeader(name: string, value: string): unknown;
}
// Constructor params are types here but must stay value imports: Nest DI needs
// the runtime class tokens for decorator metadata (eslint rule bends for them).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  BinCommand,
  RegistrationCommand,
  SessionCommand,
  SecondFactorCommand,
  SignInCommand,
  WarehouseCommand,
  ZoneCommand,
  TenancyService,
} from './commands';
// Story 3.6: the `blocked` toggle's LOGIC re-homed to the putaway module
// (putaway owns bin operational state) — the URL and FE contract stay here.
// Value import: Nest DI needs the runtime class token for constructor
// metadata (same bend as the barrel above).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { BinStateCommand } from '../putaway/bin-state.command';
import {
  CreateBinDto,
  CreateWarehouseDto,
  CreateZoneDto,
  GenerateBinsDto,
  MergeBinDto,
  PatchBinDto,
  RegisterTenantDto,
  SignInDto,
  SignInResponse,
  TotpChallengeResponse,
  EnrollChallengeResponse,
  SecondFactorSignInDto,
  SecondFactorSignInResponse,
  RefreshResponse,
  TenantRegistrationResponse,
  WarehouseListResponse,
  WarehouseResponse,
  BinGridResponse,
  BinListResponse,
  BinMergeResponse,
  BinResponse,
  SetupChecklistResponse,
  ZoneListResponse,
  ZoneResponse,
  toAddressDto,
} from './tenancy.dto';

export class WarehouseListQuery {
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
 * Tenancy HTTP surface (the echo pattern: ValidationPipe-enforced DTOs,
 * `@ApiExtraModels(ProblemDetailsDto)`, problem-json error responses).
 */
@ApiTags('tenancy')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class TenancyController {
  constructor(
    private readonly registrationCommand: RegistrationCommand,
    private readonly signInCommand: SignInCommand,
    private readonly secondFactorCommand: SecondFactorCommand,
    private readonly sessionCommand: SessionCommand,
    private readonly warehouseCommand: WarehouseCommand,
    private readonly zoneCommand: ZoneCommand,
    private readonly binCommand: BinCommand,
    private readonly binStateCommand: BinStateCommand,
    private readonly tenancyService: TenancyService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registers a tenant with its Owner user' })
  @ApiBody({ type: RegisterTenantDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: TenantRegistrationResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Owner email already registered (duplicate-email)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  async register(
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Body() dto: RegisterTenantDto,
  ): Promise<TenantRegistrationResponse> {
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.registrationCommand.register(
      { name: dto.name, ownerEmail: dto.ownerEmail, password: dto.password, gstin: dto.gstin },
      key,
    );
    return { tenant: { ...snapshot.tenant }, owner: { ...snapshot.owner } };
  }

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verifies the password; opens a server-side session — or, story 6-1b, asks for the second factor first',
    description:
      'Story 6-1a: a session answer also sets the httpOnly refresh cookie (`wms_refresh`, path /api/v1/tenants/session). Attempts are counted per (email, client IP) BEFORE the password check: 5 consecutive failures lock that pair for 15 minutes (423 for any password, real or unknown email alike); 300 attempts a minute per client IP answer 429. ' +
      'Story 6-1b: a user with two-factor sign-in set up gets `TotpChallengeResponse`; an owner who has not set it up yet gets `EnrollChallengeResponse` — both create no session and set no cookie, and are completed at `POST /tenants/sign-in/second-factor`. Clients tell the arms apart by the presence of `challenge`. A web client that can complete the second step sends `X-WMS-Second-Factor: 1`; without it, a sign-in that needs the second step answers 409 `client-outdated` and writes nothing.',
  })
  @ApiBody({ type: SignInDto })
  @ApiHeaders([
    {
      name: 'X-WMS-Second-Factor',
      required: false,
      description: 'Story 6-1b — `1` from a client that can complete the second step',
      schema: { type: 'string', enum: ['1'] },
    },
  ])
  @ApiExtraModels(SignInResponse, TotpChallengeResponse, EnrollChallengeResponse)
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(SignInResponse) },
        { $ref: getSchemaPath(TotpChallengeResponse) },
        { $ref: getSchemaPath(EnrollChallengeResponse) },
      ],
    },
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Unknown email, wrong password, or a deactivated account (unauthenticated — one answer for all three)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Invitation not yet accepted (invite-pending), a client-portal user whose client is suspended (client-suspended, story 21-7) or has departed (client-departed, story 1-2a), or — story 6-1b — an owner reset this user’s two-factor sign-in and the enrolment code has expired (enrolment-code-expired: ask for another reset; nothing counted)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Story 6-1b — the second step is needed and the client did not send `X-WMS-Second-Factor: 1` (client-outdated: "Reload this page to sign in"); nothing was written') })
  @ApiResponse({ status: 423, ...problemJsonResponse('Too many failed attempts for this email from this address (sign-in-locked; `retryAfterSeconds`)') })
  @ApiResponse({ status: 429, ...problemJsonResponse('Too many attempts from this address (rate-limited; `retryAfterSeconds`)') })
  async signIn(
    @Body() dto: SignInDto,
    @Req() request: SessionHttpRequest,
    @Res({ passthrough: true }) response: SessionHttpResponse,
  ): Promise<SignInResponse | TotpChallengeResponse | EnrollChallengeResponse> {
    const outcome = await this.signInCommand.execute({
      email: dto.email,
      password: dto.password,
      ip: clientIpOf(request),
      secondFactorCapable: request.headers[SECOND_FACTOR_HEADER] === '1',
    });
    // Story 6-1b — a challenge creates no session and sets no cookie.
    if ('challenge' in outcome) return outcome;
    const { refreshCookie, ...body } = outcome;
    response.setHeader('Set-Cookie', refreshCookieHeader(refreshCookie, body.refreshExpiresInSeconds));
    return body;
  }

  @Post('sign-in/second-factor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Story 6-1b — completes a sign-in with the second factor and opens the session',
    description:
      'Not keyed: it issues a credential. A `totp` challenge takes a 6-digit code (steps t−1…t+1, each usable once) or a backup code; an `enroll` challenge takes a code from the newly set-up app (and, after an owner\u2019s reset, the one-time `enrolmentCode`), then answers the ten backup codes once. Every attempt is counted BEFORE the code is checked: 5 consecutive wrong codes lock two-factor sign-in for 15 minutes; the third lock without a success lasts until an owner unlocks it. Sets the refresh cookie like sign-in.',
  })
  @ApiBody({ type: SecondFactorSignInDto })
  @ApiOkResponse({ type: SecondFactorSignInResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Wrong code (second-factor-invalid; `attemptsLeft`), or the challenge is unknown, expired, used, out of attempts, or the account changed (challenge-ended — sign in again)') })
  @ApiResponse({ status: 423, ...problemJsonResponse('Too many wrong codes (second-factor-locked; `retryAfterSeconds`, null until an owner unlocks)') })
  @ApiResponse({ status: 429, ...problemJsonResponse('Too many attempts from this address (rate-limited; `retryAfterSeconds`)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The stored secret cannot be opened with the configured key (second-factor-unavailable); nothing was counted') })
  async signInSecondFactor(
    @Body() dto: SecondFactorSignInDto,
    @Req() request: SessionHttpRequest,
    @Res({ passthrough: true }) response: SessionHttpResponse,
  ): Promise<SecondFactorSignInResponse> {
    const { refreshCookie, ...body } = await this.secondFactorCommand.completeSignIn({
      challengeToken: dto.challengeToken,
      code: dto.code,
      enrolmentCode: dto.enrolmentCode ?? null,
      ip: clientIpOf(request),
    });
    response.setHeader('Set-Cookie', refreshCookieHeader(refreshCookie, body.refreshExpiresInSeconds));
    return body;
  }

  @Post('session/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Story 6-1a — rotates the refresh cookie and issues a new access token',
    description:
      'Cookie-only (`wms_refresh`); requires an allow-listed Origin and `X-WMS-Session: 1`. Refresh never extends the idle window. A rotated token presented within 30 s is a tab race (a new access token, no new cookie); after that it is reuse and the session is revoked.',
  })
  @ApiOkResponse({ type: RefreshResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('No session to refresh (unauthenticated), or the session is over (session-ended with `reason`: signed-out | deactivated | role-changed | client-suspended | client-departed | refresh-reuse | idle | absolute)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Origin not allow-listed or the X-WMS-Session header missing (role-denied)') })
  async refreshSession(
    @Req() request: SessionHttpRequest,
    @Res({ passthrough: true }) response: SessionHttpResponse,
  ): Promise<RefreshResponse> {
    assertSessionRequestOrigin(request.headers);
    try {
      const { refreshCookie, ...body } = await this.sessionCommand.refresh(
        readCookie(request.headers.cookie, REFRESH_COOKIE_NAME),
      );
      if (refreshCookie !== null) {
        response.setHeader('Set-Cookie', refreshCookieHeader(refreshCookie, body.refreshExpiresInSeconds));
      }
      return body;
    } catch (error) {
      // Only an ENDED session clears the cookie: an unrecognised secret (a
      // stale tab presenting an older rotation) must not wipe the jar's
      // newest cookie and sign every tab out.
      if (error instanceof ProblemException && (error.getResponse() as { code?: unknown }).code === 'session-ended') {
        response.setHeader('Set-Cookie', clearedRefreshCookieHeader());
      }
      throw error;
    }
  }

  @Post('session/sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Story 6-1a — ends the session server-side and clears the refresh cookie',
    description:
      'Names the session by the refresh cookie, else by the bearer token (an expired access token still works). Idempotent. Requires an allow-listed Origin and `X-WMS-Session: 1`.',
  })
  @ApiResponse({ status: 204, description: 'Signed out (or there was nothing to sign out)' })
  @ApiResponse({ status: 403, ...problemJsonResponse('Origin not allow-listed or the X-WMS-Session header missing (role-denied)') })
  async signOut(
    @Req() request: SessionHttpRequest,
    @Res({ passthrough: true }) response: SessionHttpResponse,
  ): Promise<void> {
    assertSessionRequestOrigin(request.headers);
    const header = request.headers.authorization;
    const bearer = typeof header === 'string' ? (/^bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? null) : null;
    await this.sessionCommand.signOut(readCookie(request.headers.cookie, REFRESH_COOKIE_NAME), bearer);
    response.setHeader('Set-Cookie', clearedRefreshCookieHeader());
  }

  @Post(':tenantId/warehouses')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Creates a warehouse (code unique per tenant)' })
  @ApiBody({ type: CreateWarehouseDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: WarehouseResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks warehouse.create (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Warehouse code already exists (duplicate-warehouse-code names the code)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createWarehouse(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateWarehouseDto,
  ): Promise<WarehouseResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.warehouseCommand.create(
      {
        tenantId,
        actorUserId: session.userId,
        code: dto.code,
        name: dto.name,
        origin: dto.origin,
        gstin: dto.gstin,
      },
      key,
    );
    // Story 11-1: the origin crosses the snapshot→wire edge (line2 null → absent).
    return { ...snapshot.warehouse, origin: toAddressDto(snapshot.warehouse.origin) };
  }

  @Get(':tenantId/warehouses')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lists warehouses (keyset cursor pagination)' })
  @ApiOkResponse({ type: WarehouseListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listWarehouses(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: WarehouseListQuery,
  ): Promise<WarehouseListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.tenancyService.listWarehouses(
      tenantId,
      query.cursor,
      query.limit === undefined ? undefined : query.limit,
    );
    return {
      items: page.items.map((warehouse) => ({ ...warehouse, origin: toAddressDto(warehouse.origin) })),
      nextCursor: page.nextCursor,
    };
  }

  @Post(':tenantId/warehouses/:warehouseId/zones')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Creates a zone in a warehouse (code unique per warehouse)' })
  @ApiBody({ type: CreateZoneDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ZoneResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks zone.create (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Zone code already exists in this warehouse (duplicate-zone-code names the code), or the code is RETURNS — reserved for the system returns zone (reserved-location-code, story 13-2)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async createZone(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateZoneDto,
  ): Promise<ZoneResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.zoneCommand.create(
      { tenantId, actorUserId: session.userId, warehouseId, code: dto.code, name: dto.name },
      key,
    );
    return snapshot.zone;
  }

  @Get(':tenantId/warehouses/:warehouseId/zones')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lists the zones of one warehouse (keyset cursor pagination)' })
  @ApiOkResponse({ type: ZoneListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor) or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listZones(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: WarehouseListQuery,
  ): Promise<ZoneListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.tenancyService.listZones(
      tenantId,
      warehouseId,
      query.cursor,
      query.limit === undefined ? undefined : query.limit,
    );
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Post(':tenantId/warehouses/:warehouseId/zones/:zoneId/bins')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Creates a bin in a zone (code unique per warehouse; immediately usable)' })
  @ApiBody({ type: CreateBinDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: BinResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks bin.create (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse or zone does not exist in this tenant, or the dedicated client does not exist (not-found, story 1-5b)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Bin code already exists in this warehouse (duplicate-bin-code names the code), the code is RETURNS — reserved for the system returns bin (reserved-location-code, story 13-2), or the dedicated client has departed (client-departed, story 1-5b)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'zoneId', format: 'uuid' })
  async createBin(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Param('zoneId') zoneId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateBinDto,
  ): Promise<BinResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.binCommand.createBin(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId,
        zoneId,
        code: dto.code,
        // Story 10.2: capacity crosses this edge in WHOLE units. The bin
        // command scales it behind its replay lookup and refuses a fractional
        // value there — a bin's capacity is space shared by SKUs with no
        // single unit between them, so 2.5 of it means nothing.
        capacity: dto.capacity,
        // Story 11-5: the optional physical capacity (FR-39) — absent =
        // unconstrained on a fresh bin.
        lengthMm: dto.lengthMm,
        widthMm: dto.widthMm,
        heightMm: dto.heightMm,
        maxWeightGrams: dto.maxWeightGrams,
        // Story 12-1: the storage class (FR-40) — absent = 'ambient'.
        storageClass: dto.storageClass,
        // Story 1-5b: the dedicated client — absent/null = shared.
        dedicatedClientId: dto.dedicatedClientId,
        type: dto.type,
      },
      key,
    );
    // Story 12-1: through `normalizeBin` like every other bin response — a
    // stored pre-12.1 create snapshot lacks `storageClass`, which reads as
    // 'ambient' (the migration's DEFAULT).
    return normalizeBin(snapshot.bin);
  }

  @Post(':tenantId/warehouses/:warehouseId/zones/:zoneId/bins/grid')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Mass-creates bins in one zone from an aisle/bay/level grid (≤ 500, one transaction)',
  })
  @ApiBody({ type: GenerateBinsDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: BinGridResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, invalid body, or a descending aisle range (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks bin.create (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse or zone does not exist in this tenant, or the dedicated client does not exist (not-found, story 1-5b)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A generated code collides (duplicate-bin-code names the first conflicting code; nothing committed), a generated code is RETURNS (reserved-location-code, story 13-2), or the dedicated client has departed (client-departed, story 1-5b)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Grid exceeds 500 bins (grid-too-large), or idempotency-key-reuse') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'zoneId', format: 'uuid' })
  async generateBinGrid(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Param('zoneId') zoneId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: GenerateBinsDto,
  ): Promise<BinGridResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return this.binCommand.generateGrid(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId,
        zoneId,
        aisleFrom: dto.aisleFrom,
        aisleTo: dto.aisleTo,
        baysPerAisle: dto.baysPerAisle,
        levelsPerBay: dto.levelsPerBay,
        // Story 10.2: whole units across this edge (see `createBin`).
        capacity: dto.capacity,
        // Story 11-5: the optional physical capacity, per generated bin.
        lengthMm: dto.lengthMm,
        widthMm: dto.widthMm,
        heightMm: dto.heightMm,
        maxWeightGrams: dto.maxWeightGrams,
        // Story 12-1: the storage class, per generated bin — absent = 'ambient'.
        storageClass: dto.storageClass,
        // Story 1-5b: the dedicated client, per generated bin — absent/null = shared.
        dedicatedClientId: dto.dedicatedClientId,
        type: dto.type,
      },
      key,
    );
  }

  @Get(':tenantId/warehouses/:warehouseId/zones/:zoneId/bins')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lists the bins of one zone (keyset cursor pagination)' })
  @ApiOkResponse({ type: BinListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor) or out-of-range limit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse or zone does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'zoneId', format: 'uuid' })
  async listBins(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Param('zoneId') zoneId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: WarehouseListQuery,
  ): Promise<BinListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.tenancyService.listBins(
      tenantId,
      warehouseId,
      zoneId,
      query.cursor,
      query.limit === undefined ? undefined : query.limit,
    );
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Patch(':tenantId/warehouses/:warehouseId/bins/:binId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Blocks or unblocks a bin (Story 3.6: never a system or retired bin), or edits its structure (Story 11-5: dimensions and max weight; 12-1: storage class; 1-5b: dedicated client — tenancy owns the structure)',
  })
  @ApiBody({ type: PatchBinDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: BinResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, invalid body, a system bin on the blocked arm (validation-failed names the bin — the capacity arm deliberately permits system bins), a system bin given a dedicated client (validation-failed, story 1-5b), a body mixing blocked with capacity attributes or a dedicated client, a body carrying neither (validation-failed), or a non-boolean blocked (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks bin.block (role-denied) or bin.create (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Bin does not exist in this warehouse, or the dedicated client does not exist (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The bin is retired (bin-retired — retirement is terminal), a storage-class change would strand stock (storage-class-conflict), the dedicated client has departed (client-departed, story 1-5b), or the bin holds another client\'s stock or open QC holds (bin-client-conflict names up to 10 SKUs, story 1-5b)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'binId', format: 'uuid' })
  async setBinBlocked(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Param('binId') binId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: PatchBinDto,
  ): Promise<BinResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    // Story 11-5: per-body dispatch on ONE route — putaway owns bin
    // OPERATIONAL state (`blocked`), tenancy owns bin STRUCTURE (the capacity
    // attributes; the re-homing precedent in reverse). The two arms never mix
    // in one request (one idempotency key per request); a pre-11.5 body was
    // always `{blocked}`-shaped, so the state arm's contract is unchanged.
    // `blocked: null` must 400 here, NOT reach the state command: the DTO's
    // `@IsOptional` skips validation for null as well as undefined, and
    // `setBlocked` writing null into a NOT NULL column would answer 500 where
    // pre-11.5 answered 400 (the 11-5 review's one high finding). The four
    // capacity attributes keep their null-means-clear semantics — the
    // asymmetry is deliberate: `blocked` is a state toggle, the attrs are
    // limits.
    if (dto.blocked !== undefined && typeof dto.blocked !== 'boolean') {
      throw new ProblemException(
        'validation-failed',
        400,
        'blocked must be a boolean',
        'The PATCH body carries `blocked: null` — send `true`/`false` to change the bin\'s operational state, or omit `blocked` entirely to change a capacity attribute.',
      );
    }
    // Story 12-1 (code review): `storageClass: null` must 400 the same way —
    // the DTO's `@IsOptional` skips null as well as undefined, and the edit
    // command treats only `undefined` as absent, so an explicit null would
    // reach the NOT NULL column and answer 500 where a 400 is the answer
    // (the same 11-5 `blocked` reasoning; the class has no clear verb).
    if (dto.storageClass === null) {
      throw new ProblemException(
        'validation-failed',
        400,
        'storageClass must be a string',
        'The PATCH body carries `storageClass: null` — the storage class has no clear verb (the column is NOT NULL); omit `storageClass` to leave the bin\'s class unchanged.',
      );
    }
    const hasBlocked = dto.blocked !== undefined;
    // Story 12-1: the storage class rides the STRUCTURE arm (tenancy owns it)
    // — a storageClass-only body routes to `editBinCapacity`.
    const hasCapacity =
      dto.lengthMm !== undefined ||
      dto.widthMm !== undefined ||
      dto.heightMm !== undefined ||
      dto.maxWeightGrams !== undefined ||
      dto.storageClass !== undefined ||
      // Story 1-5b: the dedicated client rides the structure arm too — and
      // `null` (a clear) counts as present, unlike `storageClass: null`.
      dto.dedicatedClientId !== undefined;
    if (hasBlocked && hasCapacity) {
      throw new ProblemException(
        'validation-failed',
        400,
        'blocked and capacity attributes cannot change together',
        'A blocked change and a structure-attribute change (the capacity fields, the storage class or the dedicated client) are two different operations on this bin — send them as separate PATCH requests (one idempotency key per request).',
      );
    }
    if (hasCapacity) {
      const snapshot = await this.binCommand.editBinCapacity(
        {
          tenantId,
          actorUserId: session.userId,
          warehouseId,
          binId,
          lengthMm: dto.lengthMm,
          widthMm: dto.widthMm,
          heightMm: dto.heightMm,
          maxWeightGrams: dto.maxWeightGrams,
          storageClass: dto.storageClass,
          dedicatedClientId: dto.dedicatedClientId,
        },
        key,
      );
      return normalizeBin(snapshot.bin);
    }
    if (!hasBlocked) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Nothing to change',
        'Send `blocked` (the bin\'s operational state) or a structure attribute (lengthMm, widthMm, heightMm, maxWeightGrams, storageClass, dedicatedClientId) — the body carries neither.',
      );
    }
    // Story 3.6: delegated to the re-homed command — the putaway module owns
    // bin operational state; the URL and the response body are unchanged.
    // (`blocked` is defined here — the other two arms returned above.)
    const snapshot = await this.binStateCommand.setBlocked(
      { tenantId, actorUserId: session.userId, warehouseId, binId, blocked: dto.blocked! },
      key,
    );
    return normalizeBin(snapshot.bin);
  }

  @Post(':tenantId/warehouses/:warehouseId/bins/:binId/merge')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Merges this bin into the target bin (all on-hand moves through real ledger movements; the source retires in the same commit)',
  })
  @ApiBody({ type: MergeBinDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: BinMergeResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a structural guard (validation-failed / bin-retired / bin-blocked — a blocked SOURCE is allowed, the only way to empty a blocked bin; only the target must be live), a target overflow (bin-full names capacity and occupancy), the target over its physical limits (bin-overweight / bin-volume-exceeded / bin-item-oversize, story 11-5), a source SKU the target bin\'s class cannot satisfy (bin-storage-mismatch naming both classes — story 12-1), an incompatible co-located pair (bin-segregation-conflict naming both SKUs and both classes — story 12-2), or a source SKU of another client than the target\'s dedicated client (bin-client-mismatch naming the bin, its client and the SKU — story 1-5b; nothing committed in any arm)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks bin.retire (role-denied — Owner and Ops Manager only)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Source or target bin does not exist in this warehouse (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A source/target bin has an open QC hold (bin-merge-hold-open names the bin and the hold)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'binId', format: 'uuid', description: 'The SOURCE bin' })
  async mergeBin(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Param('binId') binId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: MergeBinDto,
  ): Promise<BinMergeResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.binCommand.mergeBin(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId,
        sourceBinId: binId,
        targetBinId: dto.targetBinId,
      },
      key,
    );
    return {
      source: normalizeBin(snapshot.source),
      target: normalizeBin(snapshot.target),
      moved: snapshot.moved,
    };
  }

  @Post(':tenantId/warehouses/:warehouseId/bins/:binId/retire')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Retires this bin — one-way, only an EMPTY bin can retire (the row stays; the code stays reserved)',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: BinResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a system bin (validation-failed), or the bin still holds stock (bin-not-empty names the (sku, batch, qty) rows)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks bin.retire (role-denied — Owner and Ops Manager)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Bin does not exist in this warehouse (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The bin is already retired (bin-retired — retirement is terminal)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  @ApiParam({ name: 'binId', format: 'uuid' })
  async retireBin(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @Param('binId') binId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<BinResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.binCommand.retireBin(
      { tenantId, actorUserId: session.userId, warehouseId, binId },
      key,
    );
    return normalizeBin(snapshot.bin);
  }

  @Get(':tenantId/setup-checklist')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Computed onboarding checklist (warehouse, bins, catalog, users — all four wired)',
  })
  @ApiOkResponse({ type: SetupChecklistResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async setupChecklist(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<SetupChecklistResponse> {
    assertOwnTenant(session, tenantId);
    const checklist = await this.tenancyService.computeSetupChecklist(tenantId);
    return { steps: [...checklist.steps] };
  }
}

/**
 * The bin response normalizer: stored pre-3.6 idempotency snapshots lack the
 * new nullable pair — an absent field reads as null (additive-nullable
 * contract; every fresh write stores the full shape).
 */
function normalizeBin(bin: {
  systemOwned?: boolean;
  retiredAt?: string | null;
  retiredBy?: string | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  maxWeightGrams?: number | null;
  storageClass?: string;
  dedicatedClientId?: string | null;
}): BinResponse {
  return {
    ...bin,
    systemOwned: bin.systemOwned ?? false,
    retiredAt: bin.retiredAt ?? null,
    retiredBy: bin.retiredBy ?? null,
    // Story 11-5: stored pre-11.5 idempotency snapshots lack the four
    // nullable capacity attributes — an absent field reads as null (the same
    // additive-nullable contract as the retirement pair above).
    lengthMm: bin.lengthMm ?? null,
    widthMm: bin.widthMm ?? null,
    heightMm: bin.heightMm ?? null,
    maxWeightGrams: bin.maxWeightGrams ?? null,
    // Story 12-1: stored pre-12.1 snapshots lack the class — an absent field
    // reads 'ambient' (the migration's DEFAULT, which is what every
    // pre-12.1 row is; NOT NULL, so never null).
    storageClass: bin.storageClass ?? 'ambient',
    // Story 1-5b: stored pre-1.5b snapshots lack the dedicated client — an
    // absent field reads null (shared — what every pre-1.5b bin was).
    dedicatedClientId: bin.dedicatedClientId ?? null,
  } as BinResponse;
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