import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { CurrentSession, TenantSessionGuard } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { PartnersCommand } from '../modules/partners/partners.command';
import { PartnersFacade, type PartnerSnapshot } from '../modules/partners/partners.facade';
// Value imports: Nest decorator metadata needs the runtime class tokens.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CreatePartnerDto,
  CreatePartnerLinkDto,
  PartnerListQuery,
  PartnerListResponse,
  PartnerResponse,
  UpdatePartnerDto,
  UpdatePartnerLinkDto,
  UpdatePartnerStatusDto,
} from '../modules/partners/partners.dto';
import type { PartnerDto } from '../modules/partners/partners.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

const WRITE_403 = 'Session belongs to another tenant (permission-denied), or the caller lacks vendor.manage (role-denied)';
const KEY_409 = 'a concurrent request with the same Idempotency-Key (conflict)';
const KEY_422 = 'Idempotency key reused with a different payload (idempotency-key-reuse)';

/**
 * Story 1-3 — the business partner master: list (any staff member), create,
 * edit, status and the client links (`vendor.manage` — owner and ops
 * manager). Holds no rules — `PartnersCommand` owns authority, replay, the
 * locks and every shape rule; this maps DTOs. There is no `/vendors` alias
 * and no portal route (decision 8).
 */
@ApiTags('partners')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class PartnersController {
  constructor(
    @Inject(PartnersCommand) private readonly command: PartnersCommand,
    @Inject(PartnersFacade) private readonly facade: PartnersFacade,
  ) {}

  @Get(':tenantId/partners')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Lists the tenant's business partners by code (keyset), each with its client links — filter by role, an ACTIVE link to a client, status, or a search over code, name, legal name and GSTIN",
  })
  @ApiOkResponse({ type: PartnerListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed filter, cursor or limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listPartners(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: PartnerListQuery,
  ): Promise<PartnerListResponse> {
    assertOwnTenant(session, tenantId);
    const page = await this.facade.list(tenantId, {
      role: query.role,
      clientId: query.clientId,
      status: query.status,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(toPartnerDto), nextCursor: page.nextCursor };
  }

  @Post(':tenantId/partners')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Creates a business partner (vendor.manage) — one GST registration, with its roles' })
  @ApiBody({ type: CreatePartnerDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: PartnerResponse, description: 'The created partner, active (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a field that breaks its rule (validation-failed, naming the field); a PAN other than the GSTIN\'s (pan-gstin-mismatch); a GSTIN of another state than the registered address (gstin-state-mismatch)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 409, ...problemJsonResponse(`The code is taken (partner-code-taken), the GSTIN belongs to another partner (partner-gstin-taken, naming it), or ${KEY_409}`) })
  @ApiResponse({ status: 422, ...problemJsonResponse(KEY_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async createPartner(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreatePartnerDto,
  ): Promise<PartnerResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.create({ tenantId, actorUserId: session.userId, ...dto }, key);
    return { partner: toPartnerDto(snapshot.partner) };
  }

  @Patch(':tenantId/partners/:partnerId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Edits a business partner (vendor.manage). Tri-state: an absent key is unchanged, null clears; every rule runs on the merged row. An unchanged edit is a no-op (nothing written or audited; the key is stored)',
  })
  @ApiBody({ type: UpdatePartnerDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: PartnerResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a field that breaks its rule (validation-failed / pan-gstin-mismatch / gstin-state-mismatch)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No partner with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse(`partner-code-taken, partner-gstin-taken, a role removed while an active link carries it (partner-role-in-use), or ${KEY_409}`) })
  @ApiResponse({ status: 422, ...problemJsonResponse(KEY_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'partnerId', format: 'uuid' })
  async updatePartner(
    @Param('tenantId') tenantId: string,
    @Param('partnerId') partnerId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdatePartnerDto,
  ): Promise<PartnerResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.update({ tenantId, actorUserId: session.userId, partnerId, ...dto }, key);
    return { partner: toPartnerDto(snapshot.partner) };
  }

  @Patch(':tenantId/partners/:partnerId/status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Deactivates (with an optional reason) or reactivates a partner (vendor.manage). Inactive: kept off new POs and links, its defaults cleared; open POs keep receiving. Reactivating clears the reason and brings no default back. The same status is a no-op that stores the key",
  })
  @ApiBody({ type: UpdatePartnerStatusDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: PartnerResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an unknown status, or a reason with `active` (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No partner with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse(KEY_409) })
  @ApiResponse({ status: 422, ...problemJsonResponse(KEY_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'partnerId', format: 'uuid' })
  async updatePartnerStatus(
    @Param('tenantId') tenantId: string,
    @Param('partnerId') partnerId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdatePartnerStatusDto,
  ): Promise<PartnerResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.updateStatus(
      { tenantId, actorUserId: session.userId, partnerId, status: dto.status, reason: dto.reason },
      key,
    );
    return { partner: toPartnerDto(snapshot.partner) };
  }

  @Post(':tenantId/partners/:partnerId/links')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Links a vendor or consignee to a client (vendor.manage) — optionally as the client\'s default vendor' })
  @ApiBody({ type: CreatePartnerLinkDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.CREATED, type: PartnerResponse, description: 'The partner, its new link included' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed body (validation-failed), or a transporter / a role the partner lacks (link-role-invalid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such partner or client in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse(`The link already exists (link-exists, naming linkId), the partner is inactive (partner-inactive), the client has departed (client-departed), the client code is taken (link-client-code-taken), a concurrent default (default-vendor-conflict), or ${KEY_409}`) })
  @ApiResponse({ status: 422, ...problemJsonResponse(KEY_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'partnerId', format: 'uuid' })
  async createPartnerLink(
    @Param('tenantId') tenantId: string,
    @Param('partnerId') partnerId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: CreatePartnerLinkDto,
  ): Promise<PartnerResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.createLink(
      {
        tenantId,
        actorUserId: session.userId,
        partnerId,
        clientId: dto.clientId,
        role: dto.role,
        clientCode: dto.clientCode,
        isDefault: dto.isDefault,
      },
      key,
    );
    return { partner: toPartnerDto(snapshot.partner) };
  }

  @Patch(':tenantId/partners/:partnerId/links/:linkId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Edits a client link (vendor.manage): the client's code (null clears), active (false switches it off and clears its default; links are never deleted) and the default vendor flag. An unchanged edit is a no-op that stores the key",
  })
  @ApiBody({ type: UpdatePartnerLinkDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: PartnerResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed body, a default on a switched-off or consignee link (validation-failed), or a reactivation the partner\'s roles no longer allow (link-role-invalid)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse(WRITE_403) })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such partner, or no such link on it (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse(`partner-inactive, client-departed, link-client-code-taken, default-vendor-conflict, or ${KEY_409}`) })
  @ApiResponse({ status: 422, ...problemJsonResponse(KEY_422) })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'partnerId', format: 'uuid' })
  @ApiParam({ name: 'linkId', format: 'uuid' })
  async updatePartnerLink(
    @Param('tenantId') tenantId: string,
    @Param('partnerId') partnerId: string,
    @Param('linkId') linkId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: UpdatePartnerLinkDto,
  ): Promise<PartnerResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.command.updateLink(
      {
        tenantId,
        actorUserId: session.userId,
        partnerId,
        linkId,
        clientCode: dto.clientCode,
        active: dto.active,
        isDefault: dto.isDefault,
      },
      key,
    );
    return { partner: toPartnerDto(snapshot.partner) };
  }
}

/** The response is an exact key list rebuilt from the snapshot (a stored replay maps the same way). */
function toPartnerDto(partner: PartnerSnapshot): PartnerDto {
  return {
    id: partner.id,
    tenantId: partner.tenantId,
    code: partner.code,
    name: partner.name,
    legalName: partner.legalName,
    gstin: partner.gstin,
    pan: partner.pan,
    roles: [...partner.roles],
    registeredAddress: partner.registeredAddress,
    dispatchAddress: partner.dispatchAddress,
    contactName: partner.contactName,
    contactPhone: partner.contactPhone,
    contactEmail: partner.contactEmail,
    status: partner.status,
    inactiveReason: partner.inactiveReason,
    links: partner.links.map((link) => ({ ...link })),
    createdAt: partner.createdAt,
    updatedAt: partner.updatedAt,
  };
}

function assertOwnTenant(session: TenantSession, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new ProblemException('permission-denied', 403, 'Session belongs to another tenant', 'The session token tenant does not own this path.');
  }
}
