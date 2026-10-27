import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiHeaders,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { UUID_RE } from '../shared/primitives/ids';
import { CurrentSession, TenantSessionGuard } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { ClientsCommand } from '../modules/clients/clients.command';
import { ClientsFacade, type ClientSnapshot } from '../modules/clients/clients.facade';
import {
  ClientContactListResponse,
  ClientContactResponse,
  ClientListResponse,
  ClientAllocationPolicyResponse,
  ClientReceivingPolicyResponse,
  ClientResponse,
  CreateClientContactDto,
  CreateClientDto,
  RenameClientDto,
  UpdateClientAddressesDto,
  UpdateClientAllocationPolicyDto,
  UpdateClientContactDto,
  UpdateClientReceivingPolicyDto,
  UpdateClientStatusDto,
  UpdateClientTaxDetailsDto,
} from './clients.dto';
import type { ClientContactDto, ClientDto } from './clients.dto';
import type { ClientContactSnapshot } from '../modules/clients/clients.facade';
import { toAddressDto } from '../modules/tenancy/tenancy.dto';
import { CatalogFacade } from '../modules/catalog/catalog.facade';
import { InventoryFacade } from '../modules/inventory/inventory.facade';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

/**
 * Story 21-2b — the client admin surface: list (member-open), create and
 * rename (owner-only, `clients.manage`); 21-5 tax details; 21-10 suspend /
 * reactivate (owner-only). Holds no rules — the command owns
 * authority, replay and the shape rules; this maps DTOs.
 */
@ApiTags('clients')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ClientsController {
  constructor(
    @Inject(ClientsCommand) private readonly command: ClientsCommand,
    @Inject(ClientsFacade) private readonly facade: ClientsFacade,
    // Story 1-2b — the policy read's `untrackedSkuCount` is composed HERE
    // (the api shell): the clients module must not import catalog.
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    // Story 4-3a (A12) — the allocation read's `undatedBatchesOnHand`, composed
    // here beside the catalog count: the clients module reaches inventory only
    // for its departure blockers (`inventory/client-wind-down`), never its facade.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  @Get(':tenantId/clients')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Lists the tenant's clients — every status, the system-owned `self` client first, then by code (unpaginated, bounded at 500)",
  })
  @ApiOkResponse({ type: ClientListResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listClients(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<ClientListResponse> {
    assertOwnTenant(session, tenantId);
    return { items: (await this.facade.listClients(tenantId)).map(toClientDto) };
  }

  @Post(':tenantId/clients')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Registers a client brand (owner-only). The code is stored uppercase; the client starts active' })
  @ApiBody({ type: CreateClientDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ClientResponse, description: 'The created client (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a code/name that breaks the shape rules — including the reserved code SELF (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage (role-denied)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The code is already used by another client of this tenant, including by a concurrent create (duplicate-client-code), or a concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createClient(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateClientDto,
  ): Promise<ClientResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.create(
      { tenantId, actorUserId: session.userId, code: dto.code, name: dto.name },
      key,
    );
    return { client: toClientDto(snapshot.client) };
  }

  @Patch(':tenantId/clients/:clientId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Renames a client (owner-only). The tenant's own `self` client mirrors the tenant name and cannot be renamed" })
  @ApiBody({ type: RenameClientDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed clientId, a name outside 1-200 characters, or a rename of the self client (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async renameClient(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: RenameClientDto,
  ): Promise<ClientResponse> {
    assertOwnTenant(session, tenantId);
    if (!UUID_RE.test(clientId)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Malformed clientId',
        `clientId must be a uuid (got "${clientId}").`,
      );
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.rename(
      { tenantId, actorUserId: session.userId, clientId, name: dto.name },
      key,
    );
    return { client: toClientDto(snapshot.client) };
  }

  // Story 21-5 — the literal `tax-details` segment sits under `:clientId`,
  // so it cannot collide with the PATCH above (a different path depth).
  @Patch(':tenantId/clients/:clientId/tax-details')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Sets a client brand's tax details — legal name, GSTIN and billing address (owner + accountant, billing.invoice). Absent fields are unchanged; null or blank clears",
  })
  @ApiBody({ type: UpdateClientTaxDetailsDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientResponse })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      "Missing or malformed Idempotency-Key, a malformed clientId, a malformed GSTIN or one whose prefix is not a registration state code, a billing state code off the registration list, a GSTIN in another state than the billing state, a pincode that is not six digits, an over-long field, or the tenant's own self client (validation-failed)",
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks billing.invoice — owner and accountant only (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async updateTaxDetails(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateClientTaxDetailsDto,
  ): Promise<ClientResponse> {
    assertOwnTenant(session, tenantId);
    if (!UUID_RE.test(clientId)) {
      throw new ProblemException('validation-failed', 400, 'Malformed clientId', `clientId must be a uuid (got "${clientId}").`);
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.updateTaxDetails(
      {
        tenantId,
        actorUserId: session.userId,
        clientId,
        legalName: dto.legalName,
        gstin: dto.gstin,
        billingLine1: dto.billingLine1,
        billingLine2: dto.billingLine2,
        billingCity: dto.billingCity,
        billingStateCode: dto.billingStateCode,
        billingPincode: dto.billingPincode,
      },
      key,
    );
    return { client: toClientDto(snapshot.client) };
  }

  // Story 21-10 — the literal `status` segment sits under `:clientId` and is
  // declared after it, as with `tax-details`: a different path depth, so the
  // `:clientId` PATCH above can never capture it.
  @Patch(':tenantId/clients/:clientId/status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Suspends, departs or reactivates a client brand (owner-only). Suspension stops its portal (sign-in and every portal call), portal ASN announce, new portal users and rate-card drafts and activation; operator work and billing continue, and open ASNs stay open. Departure (story 1-2a) is allowed only once nothing is left open for the client (stock, open documents, pending decisions, unsettled invoices) and also stops every new piece of work for it and ends its portal sessions; history, reports, metering and invoices stay readable. A departed client can only be reactivated. An unchanged status is a no-op (nothing written or audited; the key is stored)',
  })
  @ApiBody({ type: UpdateClientStatusDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientResponse, description: 'The client after the change (a matching Idempotency-Key replays it)' })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      "Missing or malformed Idempotency-Key, a malformed clientId, a status other than active, suspended or departed, or the tenant's own self client (validation-failed)",
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage — owner only (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A departed client asked to be suspended — it can only be reactivated (client-not-active); a departure while work remains (client-not-wound-down — `blockers: [{kind, count, codes?}]` lists every blocker: stock, open-purchase-orders, open-asns, pending-over-receipts, open-orders, open-rmas, pending-adjustments, open-counts, open-review-items, unsettled-invoices, unbilled-charges — story 5-5a, channel-mappings); or a concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async updateClientStatus(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateClientStatusDto,
  ): Promise<ClientResponse> {
    assertOwnTenant(session, tenantId);
    if (!UUID_RE.test(clientId)) {
      throw new ProblemException('validation-failed', 400, 'Malformed clientId', `clientId must be a uuid (got "${clientId}").`);
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.updateStatus(
      { tenantId, actorUserId: session.userId, clientId, status: dto.status },
      key,
    );
    return { client: toClientDto(snapshot.client) };
  }

  // ── Story 1-2a — addresses and contacts. Literal segments under
  // `:clientId` at a deeper path than the `:clientId` PATCH, so nothing
  // above can capture them.

  @Patch(':tenantId/clients/:clientId/addresses')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Sets a client's registered and return addresses (owner-only, clients.manage). Each group: absent is unchanged, null clears it, a value replaces it whole. Allowed on the self client and on a departed one. An unchanged patch is a no-op (nothing written or audited; the key is stored)",
  })
  @ApiBody({ type: UpdateClientAddressesDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed clientId, or an address field that breaks its rule — a missing field, an over-long one, a registered state code off the GST registration list, a pincode that is not six digits (validation-failed, naming the field)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage — owner only (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async updateAddresses(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateClientAddressesDto,
  ): Promise<ClientResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.updateAddresses(
      {
        tenantId,
        actorUserId: session.userId,
        clientId,
        registered: dto.registered,
        returnAddress: dto.return,
      },
      key,
    );
    return { client: toClientDto(snapshot.client) };
  }

  // ── Story 1-2b — the receiving policy (literal segment under :clientId) ──

  @Get(':tenantId/clients/:clientId/receiving-policy')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Reads a client's receiving policy — tolerance (basis points), QC on receipt, expiry required, minimum remaining shelf life — plus how many of its SKUs are untracked (any staff session; never the portal)",
  })
  @ApiOkResponse({ type: ClientReceivingPolicyResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed clientId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async getReceivingPolicy(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<ClientReceivingPolicyResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    const policy = await this.facade.getReceivingPolicy(tenantId, clientId);
    const untrackedSkuCount = await this.catalog.countUntrackedSkus(tenantId, clientId);
    return { clientId, ...policy, untrackedSkuCount };
  }

  @Put(':tenantId/clients/:clientId/receiving-policy')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Replaces a client's receiving policy whole (owner-only, clients.manage). Allowed on the self client and on a departed one. An unchanged policy is a no-op (nothing written or audited; the key is stored)",
  })
  @ApiBody({ type: UpdateClientReceivingPolicyDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed clientId, or a field that breaks its rule — a tolerance outside 0-10000 basis points, a minimum shelf life outside 1-3650 days or without expiryRequired (validation-failed, naming the field)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage — owner only (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async updateReceivingPolicy(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateClientReceivingPolicyDto,
  ): Promise<ClientResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.updateReceivingPolicy(
      {
        tenantId,
        actorUserId: session.userId,
        clientId,
        receivingToleranceBps: dto.receivingToleranceBps,
        qcOnReceipt: dto.qcOnReceipt,
        expiryRequired: dto.expiryRequired,
        minShelfLifeDays: dto.minShelfLifeDays ?? null,
      },
      key,
    );
    return { client: toClientDto(snapshot.client) };
  }

  // ── Story 4-3a — the allocation policy (literal segment under :clientId) ──

  @Get(':tenantId/clients/:clientId/allocation-policy')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Reads a client's outbound allocation policy — the rule (fefo | fifo) and the minimum remaining shelf life at dispatch — plus how many of its SKUs are untracked and how many undated batches it has on hand (any staff session; never the portal). Story 4-3a",
  })
  @ApiOkResponse({ type: ClientAllocationPolicyResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed clientId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async getAllocationPolicy(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<ClientAllocationPolicyResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    const policy = await this.facade.getAllocationPolicy(tenantId, clientId);
    const untrackedSkuCount = await this.catalog.countUntrackedSkus(tenantId, clientId);
    const undatedBatchesOnHand = await this.inventory.undatedBatchesOnHandOfClient(tenantId, clientId);
    return { clientId, ...policy, untrackedSkuCount, undatedBatchesOnHand };
  }

  @Put(':tenantId/clients/:clientId/allocation-policy')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Replaces a client's outbound allocation policy whole (owner-only, clients.manage): the rule and the minimum remaining shelf life at dispatch, both required. Applies to waves generated after it and to ATP at once. Allowed on the self client and on a departed one. An unchanged policy is a no-op (nothing written or audited; the key is stored). Story 4-3a",
  })
  @ApiBody({ type: UpdateClientAllocationPolicyDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed clientId, or a field that breaks its rule — a rule outside fefo|fifo, a minimum outside 1-3650 whole days, or a missing key (validation-failed, naming the field)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage — owner only (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('A concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async updateAllocationPolicy(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateClientAllocationPolicyDto,
  ): Promise<ClientResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.updateAllocationPolicy(
      {
        tenantId,
        actorUserId: session.userId,
        clientId,
        // RAW (A11): no `?? null` — the DTO already refused a missing key.
        allocationRule: dto.allocationRule,
        minOutboundShelfLifeDays: dto.minOutboundShelfLifeDays,
      },
      key,
    );
    return { client: toClientDto(snapshot.client) };
  }

  @Get(':tenantId/clients/:clientId/contacts')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Lists a client's contacts — the primary first, then by name (any staff session; never the portal). At most 20",
  })
  @ApiOkResponse({ type: ClientContactListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed clientId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async listContacts(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<ClientContactListResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    return { items: (await this.facade.listClientContacts(tenantId, clientId)).map(toContactDto) };
  }

  @Post(':tenantId/clients/:clientId/contacts')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Adds a contact to a client (owner-only, clients.manage). The first contact becomes the primary' })
  @ApiBody({ type: CreateClientContactDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: ClientContactResponse, description: 'The added contact (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed clientId, or a name, email, phone or role that breaks its rule (validation-failed, naming the field)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No client with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The client already has 20 contacts (contact-limit), another contact of the client has this email (duplicate-contact-email), or a concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async addContact(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreateClientContactDto,
  ): Promise<ClientContactResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.addContact(
      {
        tenantId,
        actorUserId: session.userId,
        clientId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        roles: dto.roles,
      },
      key,
    );
    return { contact: toContactDto(snapshot.contact) };
  }

  @Patch(':tenantId/clients/:clientId/contacts/:contactId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Edits a client contact (owner-only, clients.manage): absent fields are unchanged, a null phone clears it, isPrimary: true makes it the primary. An unchanged edit is a no-op (nothing written or audited; the key is stored)",
  })
  @ApiBody({ type: UpdateClientContactDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientContactResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed clientId or contactId, a field that breaks its rule, or isPrimary: false (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such client in this tenant, or no such contact of this client (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Another contact of the client has this email (duplicate-contact-email), or a concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  @ApiParam({ name: 'contactId', format: 'uuid' })
  async editContact(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @Param('contactId') contactId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdateClientContactDto,
  ): Promise<ClientContactResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    assertUuidParam('contactId', contactId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.editContact(
      {
        tenantId,
        actorUserId: session.userId,
        clientId,
        contactId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        roles: dto.roles,
        isPrimary: dto.isPrimary,
      },
      key,
    );
    return { contact: toContactDto(snapshot.contact) };
  }

  @Delete(':tenantId/clients/:clientId/contacts/:contactId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Removes a client contact (owner-only, clients.manage). The primary cannot be removed while other contacts remain' })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ClientContactResponse, description: 'The removed contact (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed clientId or contactId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks clients.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such client in this tenant, or no such contact of this client (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The primary contact while others remain — make another primary first (primary-contact-required), or a concurrent request with the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  @ApiParam({ name: 'contactId', format: 'uuid' })
  async removeContact(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @Param('contactId') contactId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<ClientContactResponse> {
    assertOwnTenant(session, tenantId);
    assertUuidParam('clientId', clientId);
    assertUuidParam('contactId', contactId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.removeContact(
      { tenantId, actorUserId: session.userId, clientId, contactId },
      key,
    );
    return { contact: toContactDto(snapshot.contact) };
  }
}

function toContactDto(contact: ClientContactSnapshot): ClientContactDto {
  return {
    id: contact.id,
    clientId: contact.clientId,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    roles: [...contact.roles],
    isPrimary: contact.isPrimary,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  };
}

function assertUuidParam(name: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException('validation-failed', 400, `Malformed ${name}`, `${name} must be a uuid (got "${value}").`);
  }
}

function toClientDto(client: ClientSnapshot): ClientDto {
  // A replay of a pre-21-5 snapshot carries no tax details — read them as
  // unset; a pre-1-2a one carries no addresses — read them as null.
  return {
    ...client,
    registeredAddress: client.registeredAddress ?? null,
    returnAddress: toAddressDto(client.returnAddress ?? null),
    taxDetails: client.taxDetails ?? {
      legalName: null,
      gstin: null,
      billingLine1: null,
      billingLine2: null,
      billingCity: null,
      billingStateCode: null,
      billingPincode: null,
    },
  };
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
