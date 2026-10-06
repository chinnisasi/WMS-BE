import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { EwayCommand } from '../modules/invoicing/eway.command';
import { InvoicingFacade } from '../modules/invoicing/facade';
import type { EwayBillView } from '../modules/invoicing/eway-view';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AppendEwayStateThresholdDto,
  DismissEwayDto,
  EwayBillDto,
  EwayBillListQuery,
  EwayBillListResponse,
  EwayBillResponse,
  EwayExportResponse,
  EwayGstinSettingListResponse,
  EwayGstinSettingResponse,
  EwayStateThresholdListResponse,
  EwayStateThresholdResponse,
  ExportEwayDto,
  PutEwayGstinSettingDto,
  RecordEwayDto,
  UpdateEwayTransportDto,
} from './eway.dto';
import { assertInstantRange } from '../shared/primitives/instant-range';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const BILL_PARAM = { name: 'billId', format: 'uuid', description: 'The e-way bill' } as const;
const TENANT_PARAM = { name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' } as const;

/**
 * The e-way bill HTTP surface (story 8-2b) under `/tenants/{t}/eway`. Reads
 * are member-open; the finance verbs need `eway.manage` (owner, ops manager,
 * accountant) and the configuration `eway.configure` (owner). This
 * controller holds no rules.
 *
 * ROUTE ORDER: every literal segment (`bills/export`) is declared BEFORE the
 * sibling `bills/:billId/…` routes — Express matches in declaration order
 * (the 8-2a gotcha). `eway.spec.ts` pins the method order.
 */
@ApiTags('eway')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class EwayController {
  constructor(
    @Inject(EwayCommand) private readonly command: EwayCommand,
    @Inject(InvoicingFacade) private readonly facade: InvoicingFacade,
  ) {}

  @Get(':tenantId/eway/bills')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Lists e-way bills (newest first, at most 50 per page; open to any member) — each with its computed blockers and whether a gateway can generate it',
    description:
      'A bill is queued automatically shortly after an invoice issues whose consignment value (taxable + GST over taxable lines) exceeds the threshold in force on its IST issue date. ' +
      'Blockers are computed at read time: terminal ones (the invoice is frozen) mean the bill must be generated on the portal by hand and its number recorded here; needs-irn and transport-incomplete are fixable.',
  })
  @ApiOkResponse({ type: EwayBillListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed status, gstin, warehouseId, source, cursor or limit, a from/to that is not an ISO-8601 instant, or from not before to (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouseId filter names a warehouse outside this tenant (not-found)') })
  @ApiParam(TENANT_PARAM)
  async listBills(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: EwayBillListQuery,
  ): Promise<EwayBillListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertInstantRange(query.from, query.to);
    const page = await this.facade.listEwayBills(tenantId, query);
    return { items: page.items.map(toBillDto), nextCursor: page.nextCursor };
  }

  // DECLARED BEFORE `bills/:billId/…` (the literal-first rule).
  @Post(':tenantId/eway/bills/export')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Exports ready pending bills of ONE supplier GSTIN as the NIC bulk-upload JSON (eway.manage); stamps lastExportedAt',
    description:
      'All or nothing: if any id is missing, not pending, being generated, blocked, or of a different GSTIN than the rest, nothing is exported and the 409 lists each refused bill as { id, reasons } in its `bills` member. ' +
      'Upload the file on the e-way portal, then record each returned EWB number.',
  })
  @ApiBody({ type: ExportEwayDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: EwayExportResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing Idempotency-Key, or ids empty, over 100, repeated or not uuids (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Another tenant (permission-denied), or the caller lacks eway.manage (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse("A bill cannot be exported (eway-not-exportable — `bills: [{id, reasons}]`, reasons among not-found, not-pending, claimed, mixed-gstin and the blocker codes), or a concurrent idempotent request (conflict)") })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam(TENANT_PARAM)
  async exportBills(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ExportEwayDto,
  ): Promise<EwayExportResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.export({ tenantId, actorUserId: session.userId, ids: dto.ids }, key);
    return { file: snapshot.file as unknown as Record<string, unknown> };
  }

  @Patch(':tenantId/eway/bills/:billId/transport')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Replaces a pending bill's Part B (transport details) — the whole set; null or absent clears a field (eway.manage)",
    description:
      'Rules (NIC): mode is required when any field is set; Road takes a vehicle (4–15 letters or digits) with a vehicle type R/O; Rail, Air and Ship need a transport document number (≤ 15) and date, and no vehicle; ' +
      'the transporter id is a 15-character GSTIN/TRANSIN; the document date is on or after the invoice date; distance 0–4000 km, at most 100 when both pincodes are equal.',
  })
  @ApiBody({ type: UpdateEwayTransportDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: EwayBillResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing Idempotency-Key, a malformed billId, or a Part B rule broken — each named (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Another tenant (permission-denied), or the caller lacks eway.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such bill in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The bill is not pending (eway-not-pending), a gateway generation is in flight (eway-claimed), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(BILL_PARAM)
  async updateTransport(
    @Param('tenantId') tenantId: string,
    @Param('billId') billId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateEwayTransportDto,
  ): Promise<EwayBillResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.updateTransport(
      { tenantId, actorUserId: session.userId, billId, transport: { ...dto } },
      key,
    );
    return { bill: toBillDto(snapshot.bill) };
  }

  @Post(':tenantId/eway/bills/:billId/record')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Records the EWB number the portal returned for a pending bill — final (eway.manage)',
    description: 'Blockers are ignored (a terminal bill is generated on the portal by hand). The number is 12 digits and unused in the tenant.',
  })
  @ApiBody({ type: RecordEwayDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: EwayBillResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing Idempotency-Key, a malformed billId, ewbNo not 12 digits, generatedAt not an instant between the invoice issue and now (+5 min), or validUntil before generatedAt (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Another tenant (permission-denied), or the caller lacks eway.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such bill in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Not pending (eway-not-pending), a gateway generation in flight (eway-claimed), the number already recorded (ewb-no-taken), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(BILL_PARAM)
  async record(
    @Param('tenantId') tenantId: string,
    @Param('billId') billId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RecordEwayDto,
  ): Promise<EwayBillResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.record(
      { tenantId, actorUserId: session.userId, billId, ewbNo: dto.ewbNo, generatedAt: dto.generatedAt, validUntil: dto.validUntil ?? null },
      key,
    );
    return { bill: toBillDto(snapshot.bill) };
  }

  @Post(':tenantId/eway/bills/:billId/dismiss')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dismisses a pending bill with a reason (eway.manage) — blockers are ignored' })
  @ApiBody({ type: DismissEwayDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: EwayBillResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing Idempotency-Key, a malformed billId, or a reason not 1–200 characters (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Another tenant (permission-denied), or the caller lacks eway.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such bill in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Not pending (eway-not-pending), a gateway generation in flight (eway-claimed), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(BILL_PARAM)
  async dismiss(
    @Param('tenantId') tenantId: string,
    @Param('billId') billId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: DismissEwayDto,
  ): Promise<EwayBillResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.dismiss({ tenantId, actorUserId: session.userId, billId, reason: dto.reason }, key);
    return { bill: toBillDto(snapshot.bill) };
  }

  @Post(':tenantId/eway/bills/:billId/generate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Generates a ready pending bill through the configured e-way gateway (eway.manage) — audited',
    description: 'Offered only when the bill reads gatewayAvailable. The bill is claimed for two minutes while the gateway is called; a refusal is recorded as lastError.',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: EwayBillResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing Idempotency-Key or a malformed billId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Another tenant (permission-denied), or the caller lacks eway.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such bill in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Not pending (eway-not-pending), blocked (eway-not-exportable, with `bills`), already being generated (eway-claimed), the returned number already recorded (ewb-no-taken), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('The gateway refused the bill (eway-gateway-refused — also stored as lastError), or the key was reused with a different payload (idempotency-key-reuse)') })
  @ApiResponse({ status: 501, ...problemJsonResponse('No gateway is configured on this deployment (gateway-unconfigured)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The gateway is unreachable (eway-gateway-unavailable) — the claim expires in two minutes') })
  @ApiParam(TENANT_PARAM)
  @ApiParam(BILL_PARAM)
  async generate(
    @Param('tenantId') tenantId: string,
    @Param('billId') billId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<EwayBillResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.generate({ tenantId, actorUserId: session.userId, billId }, key);
    return { bill: toBillDto(snapshot.bill) };
  }

  @Get(':tenantId/eway/state-thresholds')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "The tenant's intra-state threshold overrides — the full append-only history (open to any member)" })
  @ApiOkResponse({ type: EwayStateThresholdListResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam(TENANT_PARAM)
  async listStateThresholds(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<EwayStateThresholdListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    return { items: (await this.facade.listEwayStateThresholds(tenantId)).map((row) => ({ ...row })) };
  }

  @Post(':tenantId/eway/state-thresholds')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Appends an intra-state threshold override for one state (eway.configure, owner)',
    description:
      'Applies to intra-state invoices issued (IST) on or after effectiveFrom; null means none required. Append-only: a same-date row supersedes the earlier one. Bills already queued (and invoices not queued) are never re-evaluated.',
  })
  @ApiBody({ type: AppendEwayStateThresholdDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: 201, type: EwayStateThresholdResponse, description: 'The appended override' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing Idempotency-Key, a state not on the CBIC list or 97/99, a malformed date or a negative amount (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Another tenant (permission-denied), or the caller lacks eway.configure (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam(TENANT_PARAM)
  async appendStateThreshold(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: AppendEwayStateThresholdDto,
  ): Promise<EwayStateThresholdResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.appendStateThreshold(
      { tenantId, actorUserId: session.userId, stateCode: dto.stateCode, thresholdPaise: dto.thresholdPaise, effectiveFrom: dto.effectiveFrom },
      key,
    );
    return { threshold: { ...snapshot.threshold } };
  }

  @Get(':tenantId/eway/gstin-settings')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "The e-way settings of every GSTIN the tenant holds (its own and its warehouses'); open to any member" })
  @ApiOkResponse({ type: EwayGstinSettingListResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam(TENANT_PARAM)
  async listGstinSettings(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<EwayGstinSettingListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    return { items: (await this.facade.listEwayGstinSettings(tenantId)).map((row) => ({ ...row })) };
  }

  @Put(':tenantId/eway/gstin-settings/:gstin')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Sets whether e-invoicing applies to one of the tenant\'s GSTINs (eway.configure, owner) — its B2B bills are then held as needs-irn',
  })
  @ApiBody({ type: PutEwayGstinSettingDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: EwayGstinSettingResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing Idempotency-Key, or a malformed gstin (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Another tenant (permission-denied), or the caller lacks eway.configure (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse("The GSTIN is neither the tenant's nor a warehouse's (not-found)") })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam(TENANT_PARAM)
  @ApiParam({ name: 'gstin', description: 'One of the tenant\'s GSTINs (exact, uppercase)' })
  async putGstinSetting(
    @Param('tenantId') tenantId: string,
    @Param('gstin') gstin: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: PutEwayGstinSettingDto,
  ): Promise<EwayGstinSettingResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.putGstinSetting(
      { tenantId, actorUserId: session.userId, gstin, eInvoiceApplies: dto.eInvoiceApplies },
      key,
    );
    return { setting: { ...snapshot.setting } };
  }
}

function toBillDto(view: EwayBillView): EwayBillDto {
  return { ...view, transport: { ...view.transport }, blockers: view.blockers.map((b) => ({ ...b })) };
}

function assertOwnTenantToken(tokenTenantId: string, tenantId: string): void {
  if (tokenTenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The session token tenant does not own this path.',
    );
  }
}
