import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { ClientsFacade } from '../modules/clients/clients.facade';
import { CurrentPortalSession, PortalSessionGuard, type PortalSession } from '../modules/clients/portal-session.guard';
import { InventoryFacade } from '../modules/inventory/inventory.facade';
import { OutboundFacade } from '../modules/outbound/outbound.facade';
import { InboundFacade } from '../modules/inbound/inbound.facade';
import { BillingFacade } from '../modules/billing/billing.facade';
// The query classes are bound to @Query() and read by the ValidationPipe
// through emitDecoratorMetadata — a type-only import would erase them.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  PortalAsnDetailResponse,
  PortalAsnPageResponse,
  PortalAsnsQuery,
  PortalInvoiceDetailResponse,
  PortalInvoicePageResponse,
  PortalMeResponse,
  PortalOrderDetailResponse,
  PortalOrderPageResponse,
  PortalOrdersQuery,
  PortalPageQuery,
  PortalPurchaseOrderDetailResponse,
  PortalPurchaseOrderPageResponse,
  PortalPurchaseOrdersQuery,
  PortalStockPageResponse,
} from './portal.dto';

const PORTAL_401 = 'Missing, invalid or expired session token — or the user is no longer an active client-portal user of this client (unauthenticated)';
const PORTAL_403 =
  'An operator session — "This is a client-portal surface." (role-denied); the session belongs to another tenant (permission-denied); or the client is not active (client-suspended)';
const PORTAL_PAGE_400 = 'A malformed cursor (invalid-cursor), a limit outside 1–100 or a status outside its vocabulary (validation-failed)';

/**
 * Story 21-7 — the client portal (CAP-8): read-only (decision 2), every
 * route `GET /tenants/{t}/portal/…` behind `PortalSessionGuard` (a portal
 * token only, the user and client re-read per request) and `assertOwnTenant`.
 * Each read is its owning module's facade method taking `(tenantId,
 * clientId, query)` — the client comes from the guard's re-read, never from
 * the request — and never an operator read route. Holds no rules.
 *
 * Literal segments are declared before their `:param` siblings (the guide's
 * route-declaration-order rule).
 */
@ApiTags('portal')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class PortalController {
  constructor(
    @Inject(ClientsFacade) private readonly clients: ClientsFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(InboundFacade) private readonly inbound: InboundFacade,
    @Inject(BillingFacade) private readonly billing: BillingFacade,
  ) {}

  @Get(':tenantId/portal/me')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in client-portal user and its client brand' })
  @ApiOkResponse({ type: PortalMeResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async me(@Param('tenantId') tenantId: string, @CurrentPortalSession() session: PortalSession): Promise<PortalMeResponse> {
    assertOwnTenant(session, tenantId);
    return this.clients.portalMe(tenantId, session.userId, session.clientId);
  }

  @Get(':tenantId/portal/stock')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "This client's stock, one row per (SKU, warehouse) where on-hand or allocated is above zero — on hand across every bin, allocated to open orders; keyset by SKU code then warehouse",
  })
  @ApiOkResponse({ type: PortalStockPageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(PORTAL_PAGE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async stock(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalPageQuery,
  ): Promise<PortalStockPageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.inventory.portalStock(tenantId, session.clientId, pageQuery(query));
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/orders')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "This client's orders, newest first (keyset), optionally one status" })
  @ApiOkResponse({ type: PortalOrderPageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(PORTAL_PAGE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async orders(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalOrdersQuery,
  ): Promise<PortalOrderPageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.outbound.portalOrders(tenantId, session.clientId, {
      ...pageQuery(query),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/orders/:orderId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One order of this client with its lines (kit components nested under their kit line)' })
  @ApiOkResponse({ type: PortalOrderDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed orderId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such order of this client — unknown, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  async order(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalOrderDetailResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(orderId, 'orderId');
    const order = await this.outbound.portalOrder(tenantId, session.clientId, orderId);
    if (order === null) throw notFound('Order', orderId);
    return { ...order, lines: order.lines.map((line) => ({ ...line, components: [...line.components] })) };
  }

  @Get(':tenantId/portal/inbound/asns')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "This client's advance shipment notices, newest first (keyset), optionally one status" })
  @ApiOkResponse({ type: PortalAsnPageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(PORTAL_PAGE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async asns(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalAsnsQuery,
  ): Promise<PortalAsnPageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.inbound.portalAsns(tenantId, session.clientId, {
      ...pageQuery(query),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/inbound/asns/:asnId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One advance shipment notice of this client with its lines' })
  @ApiOkResponse({ type: PortalAsnDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed asnId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such ASN of this client — unknown, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'asnId', format: 'uuid' })
  async asn(
    @Param('tenantId') tenantId: string,
    @Param('asnId') asnId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalAsnDetailResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(asnId, 'asnId');
    const asn = await this.inbound.portalAsn(tenantId, session.clientId, asnId);
    if (asn === null) throw notFound('Advance shipment notice', asnId);
    return { ...asn, lines: [...asn.lines] };
  }

  @Get(':tenantId/portal/inbound/purchase-orders')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "This client's purchase orders, newest first (keyset), optionally one status" })
  @ApiOkResponse({ type: PortalPurchaseOrderPageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse(PORTAL_PAGE_400) })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async purchaseOrders(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalPurchaseOrdersQuery,
  ): Promise<PortalPurchaseOrderPageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.inbound.portalPurchaseOrders(tenantId, session.clientId, {
      ...pageQuery(query),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/inbound/purchase-orders/:poId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One purchase order of this client with its lines' })
  @ApiOkResponse({ type: PortalPurchaseOrderDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed poId path parameter (validation-failed — it must be a uuid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such purchase order of this client — unknown, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'poId', format: 'uuid' })
  async purchaseOrder(
    @Param('tenantId') tenantId: string,
    @Param('poId') poId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalPurchaseOrderDetailResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam(poId, 'poId');
    const po = await this.inbound.portalPurchaseOrder(tenantId, session.clientId, poId);
    if (po === null) throw notFound('Purchase order', poId);
    return { ...po, lines: [...po.lines] };
  }

  @Get(':tenantId/portal/invoices')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "This client's issued invoices (never a draft), newest first (keyset) — the invoice and its lines only" })
  @ApiOkResponse({ type: PortalInvoicePageResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed cursor (invalid-cursor) or a limit outside 1–100 (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async invoices(
    @Param('tenantId') tenantId: string,
    @CurrentPortalSession() session: PortalSession,
    @Query() query: PortalPageQuery,
  ): Promise<PortalInvoicePageResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.billing.portalInvoices(tenantId, session.clientId, pageQuery(query));
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  @Get(':tenantId/portal/invoices/:invoiceId')
  @UseGuards(PortalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One issued invoice of this client: the frozen party and its lines (no drill-down, no rate card)' })
  @ApiOkResponse({ type: PortalInvoiceDetailResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse(PORTAL_401) })
  @ApiResponse({ status: 403, ...problemJsonResponse(PORTAL_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse("No such invoice of this client — unknown, malformed, a draft, or another client's (not-found)") })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'invoiceId', format: 'uuid' })
  async invoice(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @CurrentPortalSession() session: PortalSession,
  ): Promise<PortalInvoiceDetailResponse> {
    assertOwnTenant(session, tenantId);
    // The operator route's convention (21-5): a malformed invoice id is the
    // same 404 as an unknown one.
    if (!UUID_RE.test(invoiceId)) throw notFound('Client invoice', invoiceId);
    const invoice = await this.billing.portalInvoice(tenantId, session.clientId, invoiceId);
    if (invoice === null) throw notFound('Client invoice', invoiceId);
    return { ...invoice, lines: [...invoice.lines] };
  }
}

function pageQuery(query: PortalPageQuery): { cursor?: string; limit?: number } {
  return {
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

function assertOwnTenant(session: PortalSession, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The session token tenant does not own this path.',
    );
  }
}

function assertUuidParam(value: string, name: 'orderId' | 'asnId' | 'poId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" path parameter must be a uuid (got "${value}").`,
    );
  }
}

function notFound(subject: string, id: string): ProblemException {
  return new ProblemException('not-found', 404, `${subject} not found`, `No ${subject.toLowerCase()} with id "${id}" exists for this client.`);
}
