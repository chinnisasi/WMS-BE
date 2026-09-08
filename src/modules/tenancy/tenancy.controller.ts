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
import {
  BinCommand,
  RegistrationCommand,
  SignInCommand,
  WarehouseCommand,
  ZoneCommand,
  TenancyService,
} from './commands';
import {
  CreateBinDto,
  CreateWarehouseDto,
  CreateZoneDto,
  GenerateBinsDto,
  PatchBinDto,
  RegisterTenantDto,
  SignInDto,
  SignInResponse,
  TenantRegistrationResponse,
  WarehouseListResponse,
  WarehouseResponse,
  BinGridResponse,
  BinListResponse,
  BinResponse,
  SetupChecklistResponse,
  ZoneListResponse,
  ZoneResponse,
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
    private readonly warehouseCommand: WarehouseCommand,
    private readonly zoneCommand: ZoneCommand,
    private readonly binCommand: BinCommand,
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
      { name: dto.name, ownerEmail: dto.ownerEmail, password: dto.password },
      key,
    );
    return { tenant: { ...snapshot.tenant }, owner: { ...snapshot.owner } };
  }

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verifies the password and issues a short-lived session token' })
  @ApiBody({ type: SignInDto })
  @ApiOkResponse({ type: SignInResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Unknown email or wrong password (unauthenticated)') })
  async signIn(@Body() dto: SignInDto): Promise<SignInResponse> {
    return this.signInCommand.execute({ email: dto.email, password: dto.password });
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
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
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
      { tenantId, actorUserId: session.userId, code: dto.code, name: dto.name },
      key,
    );
    return snapshot.warehouse;
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
    return { items: [...page.items], nextCursor: page.nextCursor };
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
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Zone code already exists in this warehouse (duplicate-zone-code names the code)') })
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
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse or zone does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Bin code already exists in this warehouse (duplicate-bin-code names the code)') })
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
        capacity: dto.capacity,
        type: dto.type,
      },
      key,
    );
    return snapshot.bin;
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
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse or zone does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A generated code collides (duplicate-bin-code names the first conflicting code; nothing committed)') })
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
        capacity: dto.capacity,
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
  @ApiOperation({ summary: 'Blocks or unblocks a bin (the only bin edit in this story)' })
  @ApiBody({ type: PatchBinDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: BinResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Bin does not exist in this warehouse (not-found)') })
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
    const snapshot = await this.binCommand.setBlocked(
      { tenantId, actorUserId: session.userId, warehouseId, binId, blocked: dto.blocked },
      key,
    );
    return snapshot.bin;
  }

  @Get(':tenantId/setup-checklist')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Computed onboarding checklist (warehouse, bins, catalog, users — catalog/users pending)',
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