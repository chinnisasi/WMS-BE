import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiHeaders,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { RecallsFacade } from '../modules/recalls/recalls.facade';
import { ReportingFacade, XLSX_CONTENT_TYPE } from '../modules/reporting/reporting.facade';
import {
  RecallBinsResponse,
  RecallCandidatesResponse,
  RecallDetailResponse,
  RecallListResponse,
  RecallReceiptsResponse,
  RecallResponse,
  RecallShipmentsResponse,
} from '../modules/recalls/recall.dto';
// Bound to @Body()/@Query() — value imports (the ValidationPipe reads the classes).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AddRecallBatchesDto,
  CloseRecallDto,
  OpenRecallDto,
  RecallCandidatesQueryDto,
  RecallListQueryDto,
  RecallPageQueryDto,
  RecallReportQueryDto,
} from '../modules/recalls/recall.dto';
import { finishRecallReport, recallReportSink } from './recall-report-sink';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const R401 = 'Missing or invalid session token';
const R403_READ = 'Session belongs to another tenant (permission-denied), or a client-portal session — "This is an operator surface." (role-denied)';
const R403_WRITE = 'Session belongs to another tenant (permission-denied), the caller lacks qc.manage — owner and ops manager only (role-denied), or a client-portal session (role-denied)';
const R404_RECALL = 'No recall with this id exists in this tenant (not-found)';
const R503_LOCK = 'A lot is being picked, dispatched, blocked or recalled right now and the command waited 5 s — nothing was changed, retry (recall-open-contended)';
const R422_KEY = 'Idempotency key reused with a different payload (idempotency-key-reuse)';

/**
 * Story 3-7a — the batch recall, staff surface (`…/inventory/recalls`). The
 * commands (open, add batches, close) are `qc.manage` — the 3-3a block's
 * capability — and go through `RecallsFacade`; the reads (candidates, list,
 * detail, the paged bins / shipments / receipts, the report) are open to any
 * staff role and go through `ReportingFacade`. Holds no rules.
 *
 * Literal segments before `:recallId` (the guide's route-declaration rule):
 * `candidates` is declared first.
 */
@ApiTags('recalls')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class RecallsController {
  constructor(
    @Inject(RecallsFacade) private readonly recalls: RecallsFacade,
    @Inject(ReportingFacade) private readonly reporting: ReportingFacade,
  ) {}

  // ── literal routes FIRST ─────────────────────────────────────────────────

  @Get(':tenantId/inventory/recalls/candidates')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 3-7a — the batches of ONE client's SKUs whose lot code matches (letters and digits only, case-insensitive — `exact` or `normalised`), with on-hand and whether an open recall already names the batch or its code — the open dialog's checklist",
  })
  @ApiOkResponse({ type: RecallCandidatesResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed clientId, or a code with no letter or digit (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(R401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(R403_READ) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such client in this tenant (not-found)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The read did not finish within its budget (report-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async candidates(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: RecallCandidatesQueryDto,
  ): Promise<RecallCandidatesResponse> {
    assertOwnTenant(session, tenantId);
    const result = await this.reporting.recallCandidates(tenantId, query.clientId, query.code);
    return { normalisedCode: result.normalisedCode, items: result.items.map((item) => ({ ...item })) };
  }

  @Get(':tenantId/inventory/recalls')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Story 3-7a — the tenant's batch recalls, newest first, filterable by client, status, mode and the brand's reference (keyset cursor)" })
  @ApiOkResponse({ type: RecallListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed filter, cursor or limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(R401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(R403_READ) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async list(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: RecallListQueryDto,
  ): Promise<RecallListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.reporting.recallList(tenantId, {
      clientId: query.clientId,
      status: query.status,
      mode: query.mode,
      externalRef: query.externalRef,
      code: query.code,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Post(':tenantId/inventory/recalls')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 3-7a — opens a batch recall over 1–50 lots of ONE client (qc.manage). A live recall blocks every active lot it names in every warehouse in the same transaction (3-3a's block, reason `recall`): ATP, the grant ceiling and channel quantities stop counting them, waves and picks never draw them, dispatch refuses an order holding one, and a pick refuses a bin holding one. A lot already blocked keeps its reason. A mock recall (a drill) blocks nothing. A suspended or departed client is not refused",
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiBody({ type: OpenRecallDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: RecallResponse })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse('Missing or malformed Idempotency-Key; 0 or over 50 batch ids, a malformed or repeated id, a blank or over-500-character reason note, an over-100-character reference, or a mode outside live | mock (validation-failed)'),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse(R401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(R403_WRITE) })
  @ApiResponse({ status: 404, ...problemJsonResponse('A batch id names no batch of this tenant — every missing id is named (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse('The lots belong to more than one client (mixed-client); a live recall naming a lot already on an open live recall — the detail names it (batch-already-recalled, member recallCodes); or a concurrent request on the same Idempotency-Key (conflict)'),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse(R422_KEY) })
  @ApiResponse({ status: 503, ...problemJsonResponse(R503_LOCK) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async open(
    @Param('tenantId') tenantId: string,
    @Body() body: OpenRecallDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<RecallResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return toRecallResponse(
      await this.recalls.openRecall(
        {
          tenantId,
          actorUserId: session.userId,
          batchIds: body.batchIds,
          reasonNote: body.reasonNote,
          externalRef: body.externalRef,
          mode: body.mode,
        },
        key,
      ),
    );
  }

  // ── one recall ───────────────────────────────────────────────────────────

  @Get(':tenantId/inventory/recalls/:recallId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Story 3-7a — one recall: its lots with live figures (received, damaged, on hand, in transit, held in open orders, dispatched, returned, scrapped, written off, unaccounted) and the figures frozen at close, where the lots sit (per warehouse and location role), the open orders holding them and the planned picks that will refuse',
  })
  @ApiOkResponse({ type: RecallDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed recallId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(R401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(R403_READ) })
  @ApiResponse({ status: 404, ...problemJsonResponse(R404_RECALL) })
  @ApiResponse({ status: 503, ...problemJsonResponse('The read did not finish within its budget (report-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'recallId', format: 'uuid' })
  async detail(
    @Param('tenantId') tenantId: string,
    @Param('recallId') recallId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<RecallDetailResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(recallId, 'recallId');
    const view = await this.reporting.recallDetail(tenantId, recallId);
    return JSON.parse(JSON.stringify(view)) as RecallDetailResponse;
  }

  @Get(':tenantId/inventory/recalls/:recallId/bins')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 3-7a — every bin holding a lot of the recall (staff only — the client sees warehouses and roles, never bins), paged' })
  @ApiOkResponse({ type: RecallBinsResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed recallId, cursor or limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(R401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(R403_READ) })
  @ApiResponse({ status: 404, ...problemJsonResponse(R404_RECALL) })
  @ApiResponse({ status: 503, ...problemJsonResponse('The read did not finish within its budget (report-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'recallId', format: 'uuid' })
  async bins(
    @Param('tenantId') tenantId: string,
    @Param('recallId') recallId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: RecallPageQueryDto,
  ): Promise<RecallBinsResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(recallId, 'recallId');
    const page = await this.reporting.recallBins(tenantId, recallId, query.cursor, query.limit ?? 50);
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/inventory/recalls/:recallId/shipments')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 3-7a — where the recalled lots went: one row per dispatched pick of a lot — the order, consignee legal name and GSTIN, destination city / state / pincode, carrier and AWB (no contact names, phones or address lines), paged",
  })
  @ApiOkResponse({ type: RecallShipmentsResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed recallId, cursor or limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(R401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(R403_READ) })
  @ApiResponse({ status: 404, ...problemJsonResponse(R404_RECALL) })
  @ApiResponse({ status: 503, ...problemJsonResponse('The read did not finish within its budget (report-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'recallId', format: 'uuid' })
  async shipments(
    @Param('tenantId') tenantId: string,
    @Param('recallId') recallId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: RecallPageQueryDto,
  ): Promise<RecallShipmentsResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(recallId, 'recallId');
    const page = await this.reporting.recallShipments(tenantId, recallId, query.cursor, query.limit ?? 50);
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/inventory/recalls/:recallId/receipts')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Story 3-7a — where the recalled lots came from: one row per goods receipt of a lot (its GRN, document and vendor), paged' })
  @ApiOkResponse({ type: RecallReceiptsResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed recallId, cursor or limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(R401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(R403_READ) })
  @ApiResponse({ status: 404, ...problemJsonResponse(R404_RECALL) })
  @ApiResponse({ status: 503, ...problemJsonResponse('The read did not finish within its budget (report-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'recallId', format: 'uuid' })
  async receipts(
    @Param('tenantId') tenantId: string,
    @Param('recallId') recallId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: RecallPageQueryDto,
  ): Promise<RecallReceiptsResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(recallId, 'recallId');
    const page = await this.reporting.recallReceipts(tenantId, recallId, query.cursor, query.limit ?? 50);
    return { items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/inventory/recalls/:recallId/report')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Story 3-7a — the client recall report as a FILE: one table with a `section` column (meta, figure_live, figure_at_close, on_hand, in_transit, held_in_open_order, planned_pick_in_recalled_bin — staff only —, dispatched, received, received_damaged, returned, return_scrapped, adjusted_out, end). CSV streams every row and ends in a `section=end` row carrying the count (a file without it was cut short); XLSX is built whole (a "Recall" facts sheet and a "Trace" sheet), at most 200,000 rows. Every download is audited',
  })
  @ApiProduces('text/csv', XLSX_CONTENT_TYPE)
  @ApiOkResponse({ description: 'The file', content: { 'text/csv': { schema: { type: 'string', format: 'binary' } }, [XLSX_CONTENT_TYPE]: { schema: { type: 'string', format: 'binary' } } } })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed recallId, or a format outside csv | xlsx (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(R401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(R403_READ) })
  @ApiResponse({ status: 404, ...problemJsonResponse(R404_RECALL) })
  @ApiResponse({ status: 422, ...problemJsonResponse('The XLSX would pass 200,000 rows — download the CSV (report-too-large)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('A recall report is already being prepared, or the read did not finish within its 60 s budget (report-unavailable; Retry-After: 5)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'recallId', format: 'uuid' })
  async report(
    @Param('tenantId') tenantId: string,
    @Param('recallId') recallId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: RecallReportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(recallId, 'recallId');
    await finishRecallReport(res, () =>
      this.reporting.recallReport(
        tenantId,
        recallId,
        query.format,
        recallReportSink(res, (rowCount) => this.recalls.recordReportDownload(tenantId, recallId, session.userId, query.format, rowCount)),
      ),
    );
  }

  @Post(':tenantId/inventory/recalls/:recallId/batches')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 3-7a — adds lots to an OPEN recall (qc.manage) — a matching batch found later (the candidates read flags it with sameCodeOnOpenRecall). The same rules as open: one client (the recall's), no lot on another open live recall, at most 50 lots in all; a live recall blocks every active one",
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiBody({ type: AddRecallBatchesDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: RecallResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key; 0 or over 50 batch ids, or a malformed or repeated id (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(R401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(R403_WRITE) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such recall, or a batch id names no batch of this tenant (not-found)') })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse("The recall is closed (recall-not-open); a lot of another client (mixed-client); a lot already on this or another open live recall (batch-already-recalled); more than 50 lots in all (recall-too-many-lots); or a concurrent request on the same Idempotency-Key (conflict)"),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse(R422_KEY) })
  @ApiResponse({ status: 503, ...problemJsonResponse(R503_LOCK) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'recallId', format: 'uuid' })
  async addBatches(
    @Param('tenantId') tenantId: string,
    @Param('recallId') recallId: string,
    @Body() body: AddRecallBatchesDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<RecallResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(recallId, 'recallId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return toRecallResponse(await this.recalls.addRecallBatches({ tenantId, actorUserId: session.userId, recallId, batchIds: body.batchIds }, key));
  }

  @Post(':tenantId/inventory/recalls/:recallId/close')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Story 3-7a — closes a recall (qc.manage): freezes every lot’s figures as of now (the close summary) and unblocks the lots named in releaseBatchIds — only lots THIS recall blocked; a lot with stock on hand, in transit or in open orders needs an overrideReason; any lot whose stock does not match its ledger history needs acknowledgeUnaccounted. Every other lot stays blocked. No stock moves',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CloseRecallDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: RecallResponse })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse('Missing or malformed Idempotency-Key; a blank or over-500-character note or override reason, over 50 or repeated release ids or disposition notes, or an over-200-character evidence reference (validation-failed)'),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse(R401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(R403_WRITE) })
  @ApiResponse({ status: 404, ...problemJsonResponse(R404_RECALL) })
  @ApiResponse({
    status: 409,
    ...problemJsonResponse(
      'The recall is already closed (recall-not-open); a release or note names a batch that is not a lot of this recall (recall-batch-not-on-recall); a lot this recall did not block, or no longer blocked for the recall (recall-release-not-eligible, member batchCodes); a released lot still has stock and no overrideReason (recall-release-has-stock, member batchCodes); a lot whose stock does not match its ledger and no acknowledgeUnaccounted (recall-unaccounted, member batchCodes); or a concurrent request on the same Idempotency-Key (conflict)',
    ),
  })
  @ApiResponse({ status: 422, ...problemJsonResponse(R422_KEY) })
  @ApiResponse({ status: 503, ...problemJsonResponse(R503_LOCK) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'recallId', format: 'uuid' })
  async close(
    @Param('tenantId') tenantId: string,
    @Param('recallId') recallId: string,
    @Body() body: CloseRecallDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<RecallResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(recallId, 'recallId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    return toRecallResponse(
      await this.recalls.closeRecall(
        {
          tenantId,
          actorUserId: session.userId,
          recallId,
          note: body.note,
          releaseBatchIds: body.releaseBatchIds,
          overrideReason: body.overrideReason,
          acknowledgeUnaccounted: body.acknowledgeUnaccounted,
          dispositionNotes: body.dispositionNotes,
          evidenceRef: body.evidenceRef,
        },
        key,
      ),
    );
  }
}

function toRecallResponse(snapshot: unknown): RecallResponse {
  return JSON.parse(JSON.stringify(snapshot)) as RecallResponse;
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
