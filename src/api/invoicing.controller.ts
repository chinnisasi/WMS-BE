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
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  GenerateInvoiceDto,
  InvoiceDto,
  InvoiceListQuery,
  InvoiceListResponse,
  InvoiceResponse,
} from './invoicing.dto';

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
      "An invoice issues (and takes its FY-series number, once) when every dispatched line is priced, the place of supply resolves and a supplier GSTIN exists (warehouse, else tenant); otherwise it stays 'awaiting-data' with its gaps listed in the document. " +
      'Content-identical regeneration leaves the revision unchanged. Overrides never write order_lines.rate_paise. ' +
      'A concurrent generation (the event delivery racing this call) settles to one invoice — on losing the insert this call retries once over the winner\'s row, so its rates still apply.',
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
  @ApiResponse({ status: 409, ...problemJsonResponse('The order is not dispatched (order-not-dispatched), a rate override names a line that is not of this order (line-not-of-order) or a line already priced at order acceptance (line-already-priced), or a concurrent idempotent request (conflict)') })
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
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listInvoices(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: InvoiceListQuery,
  ): Promise<InvoiceListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const page = await this.invoices.listInvoices(tenantId, { cursor: query.cursor, limit: query.limit });
    return {
      items: page.items.map((item) => ({ ...item, gapKinds: [...item.gapKinds] })),
      nextCursor: page.nextCursor,
    };
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
