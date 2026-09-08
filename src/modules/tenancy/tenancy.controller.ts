import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiHeaders,
  ApiOkResponse,
  ApiOperation,
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
import { RegistrationCommand, SignInCommand, WarehouseCommand, TenancyService } from './commands';
import {
  CreateWarehouseDto,
  RegisterTenantDto,
  SignInDto,
  SignInResponse,
  TenantRegistrationResponse,
  WarehouseListResponse,
  WarehouseResponse,
} from './tenancy.dto';

export class WarehouseListQuery {
  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50 })
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
  async createWarehouse(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateWarehouseDto,
  ): Promise<WarehouseResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.warehouseCommand.create(
      { tenantId, code: dto.code, name: dto.name },
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
  async listWarehouses(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: WarehouseListQuery,
  ): Promise<WarehouseListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.tenancyService.listWarehouses(
      tenantId,
      query.cursor,
      query.limit === undefined ? undefined : Number(query.limit),
    );
    return { items: [...page.items], nextCursor: page.nextCursor };
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