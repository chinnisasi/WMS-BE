import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
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
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { CurrentSession, TenantSessionGuard } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import {
  CLIENT_INVOICE_LIST_MAX_LIMIT,
  CLIENT_INVOICE_STATUSES,
  ClientInvoiceService,
  type ClientInvoiceStatus,
  type ClientInvoiceEntryView,
  type ClientInvoiceVerb,
  type ClientInvoiceView,
} from '../modules/billing/client-invoices';
import {
  ClientInvoiceListResponse,
  ClientInvoiceNoteDto,
  ClientInvoiceResponse,
  IssueClientInvoiceResponse,
  PrepareClientInvoicesDto,
  PrepareClientInvoicesResponse,
  type ClientInvoiceDto,
  type ClientInvoiceEntryDto,
} from './client-invoices.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

/**
 * The list query, declared beside the route (the `RateCardInForceQuery`
 * precedent): `@Query()` needs the class as a VALUE for the validation
 * pipe's `design:paramtypes` metadata.
 */
export class ClientInvoiceListQuery {
  @ApiProperty({ required: false, format: 'uuid', description: "One client's invoices" })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ required: false, enum: [...CLIENT_INVOICE_STATUSES] })
  @IsOptional()
  @IsIn([...CLIENT_INVOICE_STATUSES])
  status?: ClientInvoiceStatus;

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: CLIENT_INVOICE_LIST_MAX_LIMIT, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CLIENT_INVOICE_LIST_MAX_LIMIT)
  limit?: number;
}

const MUTATION_403 =
  'Session belongs to another tenant (permission-denied), or the caller lacks billing.invoice — owner and accountant only (role-denied)';
const READ_403 = 'Session belongs to another tenant (permission-denied), or a client-portal session — a user with a client (role-denied): this is an operator surface';

/**
 * Story 21-5 — client invoices (CAP-7): a monthly services (SAC) GST tax
 * invoice to a client brand per supplying GSTIN. Reads are member-open
 * (portal sessions refused); every mutation needs `billing.invoice` (owner +
 * accountant). Holds no rules — the service owns authority, replay, the
 * locks, the period rule, the gaps and the transitions; this maps DTOs.
 */
@ApiTags('billing')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ClientInvoicesController {
  constructor(@Inject(ClientInvoiceService) private readonly invoices: ClientInvoiceService) {}

  @Post(':tenantId/clients/:clientId/invoices')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Prepares a client's invoice drafts for an ended IST month (billing.invoice): one per supplying GSTIN with usage and no live invoice — `created` and `existing`",
  })
  @ApiBody({ type: PrepareClientInvoicesDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: PrepareClientInvoicesResponse, description: 'The drafts created and the live invoices already covering a group' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed clientId, or a month that is not YYYY-MM (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      "The month has not ended (period-not-ended), the tenant's own client (client-not-billable), no group has any usage (nothing-to-invoice), a live invoice raced in (invoice-exists), or a concurrent request with the same Idempotency-Key (conflict)",
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async prepare(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: PrepareClientInvoicesDto,
  ): Promise<PrepareClientInvoicesResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(clientId, 'clientId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.invoices.prepare({ tenantId, actorUserId: session.userId, clientId, month: dto.month }, key);
    return { created: result.created.map(toInvoiceDto), existing: result.existing.map(toInvoiceDto) };
  }

  @Get(':tenantId/client-invoices')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lists client invoices, newest first (keyset on createdAt, id), optionally one client’s or one status’s' })
  @ApiOkResponse({ type: ClientInvoiceListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed clientId or status, a limit outside 1–100 (validation-failed), or a malformed cursor (invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async list(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: ClientInvoiceListQuery,
  ): Promise<ClientInvoiceListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.invoices.list(tenantId, session.userId, {
      clientId: query.clientId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(toEntryDto), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/client-invoices/:invoiceId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One client invoice: its lines, gaps, warnings, party and totals' })
  @ApiOkResponse({ type: ClientInvoiceResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed invoiceId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(READ_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client invoice with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async get(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<ClientInvoiceResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(invoiceId, 'invoiceId');
    return { invoice: toInvoiceDto(await this.invoices.get(tenantId, session.userId, invoiceId)) };
  }

  @Post(':tenantId/client-invoices/:invoiceId/refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Re-derives a draft from the current figures, client tax details and rate cards (billing.invoice)' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientInvoiceResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed invoiceId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client invoice with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The invoice is not a draft (invoice-not-draft), or a concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async refresh(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<ClientInvoiceResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(invoiceId, 'invoiceId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.invoices.refresh({ tenantId, actorUserId: session.userId, invoiceId }, key);
    return { invoice: toInvoiceDto(result.invoice) };
  }

  @Delete(':tenantId/client-invoices/:invoiceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Discards a draft (billing.invoice). An issued invoice is never deleted — void it' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiNoContentResponse({ description: 'Discarded (a replay under the same key answers 204 too)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed invoiceId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client invoice with this id exists in this tenant — including one already discarded under another key (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The invoice is not a draft (invoice-not-draft), or a concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async discard(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<void> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(invoiceId, 'invoiceId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    await this.invoices.discard({ tenantId, actorUserId: session.userId, invoiceId }, key);
  }

  @Post(':tenantId/client-invoices/:invoiceId/issue')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Issues a draft (billing.invoice): re-meters first — `stale` if the figures moved (the fresh draft is stored, nothing issued, no number used) — then numbers it in its own services series and freezes it',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: IssueClientInvoiceResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed invoiceId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client invoice with this id exists in this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'The draft has gaps — the `gaps` member names them (invoice-has-gaps), it has no line (nothing-to-invoice), it is not a draft (invoice-not-draft), or a concurrent request with the same Idempotency-Key (conflict)',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async issue(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<IssueClientInvoiceResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(invoiceId, 'invoiceId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.invoices.issue({ tenantId, actorUserId: session.userId, invoiceId }, key);
    return { outcome: result.outcome, invoice: toInvoiceDto(result.invoice) };
  }

  @Post(':tenantId/client-invoices/:invoiceId/dispute')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Marks an issued invoice disputed (billing.invoice) — a note is required' })
  @ApiBody({ type: ClientInvoiceNoteDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientInvoiceResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed invoiceId, or no note (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client invoice with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Only an issued invoice can be disputed (invoice-transition-invalid), or a concurrent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async dispute(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ClientInvoiceNoteDto,
  ): Promise<ClientInvoiceResponse> {
    return this.transition('dispute', tenantId, invoiceId, idempotencyKey, session, dto);
  }

  @Post(':tenantId/client-invoices/:invoiceId/settle')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Marks an issued or disputed invoice settled (billing.invoice) — a note is optional. Recording a settlement only: no payment is collected' })
  @ApiBody({ type: ClientInvoiceNoteDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientInvoiceResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed invoiceId, or an over-long note (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client invoice with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Only an issued or disputed invoice can be settled (invoice-transition-invalid), or a concurrent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async settle(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ClientInvoiceNoteDto,
  ): Promise<ClientInvoiceResponse> {
    return this.transition('settle', tenantId, invoiceId, idempotencyKey, session, dto);
  }

  @Post(':tenantId/client-invoices/:invoiceId/void')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Voids an issued or disputed invoice (billing.invoice) — a note is required. The void keeps its number; the next prepare for its month and GSTIN drafts a replacement naming it',
  })
  @ApiBody({ type: ClientInvoiceNoteDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientInvoiceResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed invoiceId, or no note (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(MUTATION_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client invoice with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Only an issued or disputed invoice can be voided (invoice-transition-invalid), or a concurrent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async void(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ClientInvoiceNoteDto,
  ): Promise<ClientInvoiceResponse> {
    return this.transition('void', tenantId, invoiceId, idempotencyKey, session, dto);
  }

  private async transition(
    verb: ClientInvoiceVerb,
    tenantId: string,
    invoiceId: string,
    idempotencyKey: string | undefined,
    session: TenantSession,
    dto: ClientInvoiceNoteDto,
  ): Promise<ClientInvoiceResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(invoiceId, 'invoiceId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const result = await this.invoices.transition({ tenantId, actorUserId: session.userId, invoiceId, verb, note: dto.note }, key);
    return { invoice: toInvoiceDto(result.invoice) };
  }
}

function toInvoiceDto(view: ClientInvoiceView): ClientInvoiceDto {
  return {
    ...view,
    totals: { ...view.totals },
    gaps: view.gaps.map((gap) => ({ ...gap })),
    warnings: view.warnings.map((warning) => ({ ...warning })),
    party: view.party as ClientInvoiceDto['party'],
    lines: view.lines.map((line) => ({ ...line })),
  };
}

function toEntryDto(view: ClientInvoiceEntryView): ClientInvoiceEntryDto {
  return { ...view, totals: { ...view.totals } };
}

function assertOwnTenant(session: TenantSession, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new ProblemException('permission-denied', 403, 'Session belongs to another tenant', 'The session token tenant does not own this path.');
  }
}

function assertUuidParam(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, `Malformed ${name}`, `${name} must be a uuid (got "${value}").`);
  }
}
