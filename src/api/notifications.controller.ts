import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { NotificationsFacade } from '../modules/notifications/notifications.facade';
import {
  NOTIFICATION_ENTRY_DTOS,
  NotificationListResponse,
  NotificationStatusResponse,
  toNotificationEntryDto,
} from './notifications.dto';
// The query class is bound to @Query() and read by the ValidationPipe through
// emitDecoratorMetadata — a type-only import would erase it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { NotificationListQuery } from './notifications.dto';

/**
 * Story 9-2 — the notification panel: the caller's visible entries, the
 * bell's dot, and the panel-opened mark. Behind `TenantSessionGuard` (which
 * fences a client-portal token with 403 `role-denied`) and the own-tenant
 * check. The ROUTING is the facade's — it re-reads the caller's role in its
 * transaction and maps it to the sources it can act on; this controller
 * holds no rules.
 *
 * The literal `status` and `opened` segments sit beside the collection, not
 * under an `:id`, so no route-order hazard exists (there is no `:id` route).
 */
@ApiTags('notifications')
@ApiExtraModels(ProblemDetailsDto, ...NOTIFICATION_ENTRY_DTOS)
@Controller('tenants')
export class NotificationsController {
  constructor(@Inject(NotificationsFacade) private readonly notifications: NotificationsFacade) {}

  @Get(':tenantId/notifications')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Lists the caller's notification entries (keyset cursor pagination, newest raised first)",
    description:
      'Only the entries whose source the caller can act on: stock adjustments awaiting approval (adjustments.approve), over-threshold count variances (owner), over-receipts and rejected device ops (review.decide), reorder breaches and batch alerts (replenishment.manage), QC holds (qc.manage), channel sync episodes (channel.manage). ' +
      'A role that can act on none gets an empty list. Resolved entries stay listed, with their resolution.',
  })
  @ApiOkResponse({ type: NotificationListResponse, description: 'The page (newest first)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor), or a limit outside 1–100 (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async list(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: NotificationListQuery,
  ): Promise<NotificationListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const page = await this.notifications.list(tenantId, session.userId, { cursor: query.cursor, limit: query.limit });
    return { items: page.items.map(toNotificationEntryDto), nextCursor: page.nextCursor };
  }

  @Get(':tenantId/notifications/status')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "The bell's dot for the caller — never a count",
    description:
      'hasNew is true iff an OPEN entry the caller can act on surfaced after the caller last opened the panel — or the caller has never opened it and such an entry exists. Resolved entries never light it.',
  })
  @ApiOkResponse({ type: NotificationStatusResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async status(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<NotificationStatusResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    return this.notifications.status(tenantId, session.userId);
  }

  @Post(':tenantId/notifications/opened')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Marks the panel opened by the caller (clears the dot)',
    description:
      "Sets the caller's last-opened time to now and answers {hasNew: false}. Takes NO Idempotency-Key — the one exception among the mutating routes: setting a time to now is naturally idempotent, and a retry only moves it forward.",
  })
  @ApiOkResponse({ type: NotificationStatusResponse })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async opened(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<NotificationStatusResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    return this.notifications.opened(tenantId, session.userId);
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
