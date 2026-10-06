import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { InvoicingCommand } from '../modules/invoicing/command';
import { InvoicingFacade } from '../modules/invoicing/facade';
import type { InvoiceView } from '../modules/invoicing/view';
import type { HsnSummaryRow } from '../modules/invoicing/hsn-summary';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  GenerateInvoiceDto,
  HsnSummaryGstinsResponse,
  HsnSummaryQuery,
  HsnSummaryResponse,
  HsnSummaryRowDto,
  InvoiceDto,
  InvoiceListQuery,
  InvoiceListResponse,
  InvoiceResponse,
} from './invoicing.dto';
import { assertInstantRange } from '../shared/primitives/instant-range';

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
 * The invoicing HTTP surface (story 8-1): the invoice list + detail reads
 * (`InvoicingFacade` — reads are never capability-gated) and the manual
 * generate/regenerate command (`InvoicingCommand`, `invoice.generate`, which
 * re-evaluates the caller's role against the DB at entry). Invoices are
 * otherwise created by the `order.dispatched` delivery handler; this route is
 * the operator's path to price unpriced lines or refresh from the dispatch
 * facts. This controller holds no rules.
 */
@ApiTags('invoicing')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class InvoicingController {
  constructor(
    @Inject(InvoicingCommand) private readonly command: InvoicingCommand,
    @Inject(InvoicingFacade) private readonly invoices: InvoicingFacade,
  ) {}

  @Post(':tenantId/invoices')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Generates or regenerates a dispatched order's ONE invoice (invoice.generate) — re-derived from the persisted dispatch facts, with optional per-line rate overrides frozen into the document",
    description:
      'Creates the invoice when the dispatch event has not yet (or never — pre-8-1 dispatches have no backfill) produced one; otherwise recomputes it. ' +
      "An invoice issues (and takes the next number of its supplier GSTIN's FY series, e.g. 29/2627/000001, once) when every dispatched line is priced, the place of supply resolves and a supplier GSTIN exists (warehouse, else tenant); otherwise it stays 'awaiting-data' with its gaps listed in the document. " +
      'An issued invoice is FROZEN: a plain regenerate returns it unchanged (no recompute, whatever the catalog now says), and rates sent to it are refused (invoice-frozen). ' +
      'Content-identical regeneration of an awaiting invoice leaves the revision unchanged. Overrides never write order_lines.rate_paise. ' +
      'A concurrent generation (the event delivery racing this call) settles to one invoice — on losing the insert this call retries once over the winner\'s row: if the winner parked awaiting-data the retry\'s rates apply; if the winner already issued, the retry hits the freeze and answers 409 invoice-frozen.',
  })
  @ApiBody({ type: GenerateInvoiceDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({
    type: InvoiceResponse,
    description: "The order's invoice as it stands after generation (the idempotency snapshot)",
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, a negative or non-integer ratePaise, or a duplicate orderLineId in rates (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks invoice.generate (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No order with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Rates sent to an issued or voided invoice (invoice-frozen — it outranks the line checks), the order is not dispatched (order-not-dispatched), a rate override names a line that is not of this order (line-not-of-order) or a line already priced at order acceptance (line-already-priced), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async generateInvoice(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: GenerateInvoiceDto,
  ): Promise<InvoiceResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.generate(
      {
        tenantId,
        actorUserId: session.userId,
        orderId: dto.orderId,
        rates: dto.rates?.map((rate) => ({ orderLineId: rate.orderLineId, ratePaise: rate.ratePaise })),
      },
      key,
    );
    return { invoice: toInvoiceDto(snapshot.invoice) };
  }

  @Get(':tenantId/invoices')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Lists the tenant's invoices (keyset cursor pagination, newest first — header rows, no lines or document; open to any member)",
  })
  @ApiOkResponse({ type: InvoiceListResponse, description: 'The invoice page (newest first)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor, warehouseId or out-of-range limit, a from/to that is not an ISO-8601 instant, or from not before to (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouseId filter names a warehouse outside this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listInvoices(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: InvoiceListQuery,
  ): Promise<InvoiceListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertInstantRange(query.from, query.to);
    const page = await this.invoices.listInvoices(tenantId, {
      warehouseId: query.warehouseId,
      from: query.from,
      to: query.to,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map((item) => ({ ...item, gapKinds: [...item.gapKinds] })),
      nextCursor: page.nextCursor,
    };
  }

  // Story 8-2a. DECLARED BEFORE `:tenantId/invoices/:invoiceId`: Express
  // matches routes in declaration order, and `:invoiceId` would otherwise
  // capture `hsn-summary` (and answer 400 "invoiceId must be a uuid").
  // `invoicing-hsn.spec.ts` pins the order. `hsn-summary/gstins` has two
  // segments and cannot collide with `:invoiceId`.
  @Get(':tenantId/invoices/hsn-summary')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "The HSN summary of one supplier GSTIN for one period — GSTR-1 Table 12's per-HSN figures over the ISSUED invoices, B2B and B2C (open to any member)",
    description:
      'Per supplier GSTIN (each GSTIN files its own return) and per accounting period by IST issue date: a month (YYYY-MM) or an FY quarter (FY-yyyy-Qn). ' +
      'Only issued invoices count (never awaiting-data or voided). Rows group by (HSN, UQC, GST rate); every amount is the exact paise sum of the frozen invoice lines — nothing is rounded per row and the invoice round-off is never spread. ' +
      'A line whose HSN is blank or malformed (not 4, 6 or 8 digits) is an hsnIssue row: inside the totals, listed in issueLines with the SKU\'s current catalog HSN as a hint, and left out of the Table 12 CSV by the client. ' +
      'A row whose GST rate is not on the GST rate master (0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40 %) is a rateIssue row: inside the totals and left out of the Table 12 CSV by the client. ' +
      'The totals equal the included invoices\' subtotal and GST to the paisa. A well-formed GSTIN with nothing issued in the period is an empty summary.',
  })
  @ApiOkResponse({ type: HsnSummaryResponse, description: 'The summary' })
  @ApiResponse({ status: 400, ...problemJsonResponse('A missing or malformed gstin, or a missing or invalid period — month 13, Q5, non-consecutive FY years (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async hsnSummary(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: HsnSummaryQuery,
  ): Promise<HsnSummaryResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const summary = await this.invoices.hsnSummary(tenantId, query.gstin, query.period);
    return {
      summary: {
        ...summary,
        period: { ...summary.period },
        b2b: { rows: summary.b2b.rows.map(toHsnRowDto), totals: { ...summary.b2b.totals } },
        b2c: { rows: summary.b2c.rows.map(toHsnRowDto), totals: { ...summary.b2c.totals } },
        totals: { ...summary.totals },
        issueLines: summary.issueLines.map((line) => ({ ...line })),
      },
    };
  }

  @Get(':tenantId/invoices/hsn-summary/gstins')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Every supplier GSTIN with issued invoices, with its first and last issue instant — the HSN summary pickers derive their periods from these (open to any member)',
  })
  @ApiOkResponse({ type: HsnSummaryGstinsResponse, description: 'GSTIN ascending' })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async hsnSummaryGstins(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<HsnSummaryGstinsResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    return { items: (await this.invoices.hsnSummaryGstins(tenantId)).map((item) => ({ ...item })) };
  }

  @Get(':tenantId/invoices/:invoiceId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Reads one invoice: the row, its priced lines and the document snapshot the printable invoice renders (open to any member)",
  })
  @ApiOkResponse({ type: InvoiceResponse, description: 'The invoice detail' })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed invoiceId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No invoice with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async getInvoice(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<InvoiceResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(invoiceId, 'invoiceId');
    const invoice = await this.invoices.getInvoice(tenantId, invoiceId);
    if (invoice === null) {
      throw new ProblemException('not-found', 404, 'Invoice not found', 'No invoice with this id exists in this tenant.');
    }
    return { invoice: toInvoiceDto(invoice) };
  }
}

/** Readonly view → mutable response DTO (the arrays are copied, nothing else changes). */
function toInvoiceDto(view: InvoiceView): InvoiceDto {
  return {
    ...view,
    document: view.document as unknown as Record<string, unknown>,
    lines: view.lines.map((line) => ({ ...line })),
  };
}

/** Readonly row → mutable response DTO. */
function toHsnRowDto(row: HsnSummaryRow): HsnSummaryRowDto {
  return { ...row, sourceUoms: [...row.sourceUoms] };
}

/** Path uuid params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'invoiceId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" parameter must be a uuid (got "${value}").`,
    );
  }
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
