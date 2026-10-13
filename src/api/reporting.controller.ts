import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { UUID_RE } from '../shared/primitives/ids';
import { ReportingFacade } from '../modules/reporting/reporting.facade';
import type { Figure, Overview, SyncConnectionHealth, WindowedFigure } from '../modules/reporting/reporting.facade';
import { assertInstantRange } from '../shared/primitives/instant-range';
import { SYSTEM_ACTOR_ID } from '../shared/primitives/audit';
import { AuditTrailResponse, ReportingOverviewResponse, ServiceReportDto, toServiceReportDto } from './reporting.dto';
// The query class is bound to @Query() and read by the ValidationPipe through
// emitDecoratorMetadata — a type-only import would erase it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AuditTrailQueryDto, ServiceReportQuery } from './reporting.dto';
import type { ReportingFigureDto, ReportingWindowedFigureDto, SyncConnectionHealthDto } from './reporting.dto';

/**
 * Story 9-1 — the reporting surface: the per-warehouse Overview (FR-27).
 * A READ, member-open (never capability-gated): any member of the tenant
 * sees the dashboard. The facade checks the warehouse before any tile runs.
 * This controller holds no rules — it maps the facade's read onto the DTOs.
 */
@ApiTags('reporting')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ReportingController {
  constructor(@Inject(ReportingFacade) private readonly reporting: ReportingFacade) {}

  @Get(':tenantId/warehouses/:warehouseId/reporting/overview')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "The operational dashboard for one warehouse: ten KPI tiles, each a projection over its owning module's records, with today's (IST) and the 7-day figure, and the list behind every number",
    description:
      'Best-effort: at most 3 tile transactions run at once across the whole process, each statement under min(1.5 s, time left), inside a 1.8 s overall budget. A tile that times out, misses the budget or fails reads `unavailable` (every value null) and the response is `stale: true` — it never fails the page. ' +
      'Every figure carries a `drill` {apiPath, query, reconciles}: for `reconciles: true`, paging that list with that query to exhaustion yields exactly the figure. No polling — read it again to refresh.',
  })
  @ApiOkResponse({ type: ReportingOverviewResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed warehouseId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found) — checked before any tile runs') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async overview(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<ReportingOverviewResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(warehouseId, 'warehouseId');
    return toOverviewResponse(await this.reporting.overview(tenantId, warehouseId));
  }

  /**
   * Story 21-8 — one client's service report (CAP-10). Member-open like the
   * Overview: floor-performance figures with no money in them. Any client of
   * the tenant — a suspended one and the tenant's own (`self`) included.
   * The portal's `GET portal/service` serves the same facade read.
   */
  @Get(':tenantId/reporting/clients/:clientId/service')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "One client's service report over an inclusive IST date period: dock-to-stock, pick accuracy and dispatch timeliness (against a fixed 24 h target), from the ledger and its same-transaction projections",
    description:
      'The window is [IST midnight of from, min(IST midnight after to, asOf)) on server-stamped columns. Ratios are 0–1 to 4 dp and null with an empty denominator; medians are minutes to 1 dp. ' +
      '`dispatchTimeliness.ordersDispatched` equals the dispatched-order count the client is invoiced for. One transaction with a 5 s budget for the whole read (every statement runs under the time left) — past it, 503 and nothing partial. The client-portal route `GET /tenants/{t}/portal/service` answers the identical body for its own client.',
  })
  @ApiOkResponse({ type: ServiceReportDto })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'A malformed clientId or warehouseId, a from/to that is not a real YYYY-MM-DD date, from after to, or a period longer than 366 days (validation-failed)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({
    status: 403,
    ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session — "This is an operator surface." (role-denied)'),
  })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such client, or no such warehouse, in this tenant (not-found)') })
  @ApiResponse({ status: 503, ...problemJsonResponse('The report did not finish within its 5 s budget — try a shorter period (report-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async clientService(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: ServiceReportQuery,
  ): Promise<ServiceReportDto> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(clientId, 'clientId');
    return toServiceReportDto(
      await this.reporting.serviceReport(tenantId, clientId, {
        from: query.from,
        to: query.to,
        warehouseId: query.warehouseId ?? null,
      }),
    );
  }

  /**
   * Story 9-3a — the tenant's audit trail (FR-28): every state-changing
   * action with who, what, when and the document it changed, newest
   * recorded first. OWNER-ONLY (`audit.view`), unlike the member-open
   * reports above — the facade's guard refuses any other role before the
   * read. Operator surface only: the session guard fences a client-portal
   * token, and no portal route serves the trail.
   */
  @Get(':tenantId/reporting/audit')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "The tenant's audit trail: every state-changing action — who, what, when, and the document it changed — filterable, newest recorded first (keyset cursor pagination)",
    description:
      'Owner only (`audit.view`). Ordering, paging and the from/to window all use `recordedAt` (the server commit stamp); the window is half-open [from, to). The trail is complete from story 9-3a onward — earlier actions of some commands were never audited and are not reconstructed. ' +
      'One read under a 5 s budget: a broad filter over a very large history can answer 503 — narrow the filters or the dates.',
  })
  @ApiOkResponse({ type: AuditTrailResponse })
  @ApiResponse({
    status: 400,
    ...problemJsonResponse(
      'A malformed actorUserId/targetId, an actionPrefix outside the stem shape (e.g. carrying `%`), an unknown targetType, a from/to that is not an ISO-8601 instant, from not before to, a malformed cursor, or an out-of-range limit (validation-failed / invalid-cursor)',
    ),
  })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({
    status: 403,
    ...problemJsonResponse(
      'Session belongs to another tenant (permission-denied); a role without `audit.view` — every role but the owner (role-denied); or a client-portal session — "This is an operator surface." (role-denied)',
    ),
  })
  @ApiResponse({ status: 503, ...problemJsonResponse('The read did not finish within its 5 s budget — narrow the filters or the dates (report-unavailable)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async audit(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: AuditTrailQueryDto,
  ): Promise<AuditTrailResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertInstantRange(query.from, query.to);
    const page = await this.reporting.auditTrail(tenantId, session.userId, {
      actorUserId: query.actorUserId,
      actionPrefix: query.actionPrefix,
      targetType: query.targetType,
      targetId: query.targetId,
      from: query.from,
      to: query.to,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map((entry) => ({
        id: entry.id,
        recordedAt: entry.recordedAt,
        occurredAt: entry.occurredAt,
        actorUserId: entry.actorUserId,
        actorKind: entry.actorKind,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
      })),
      nextCursor: page.nextCursor,
      systemActorId: SYSTEM_ACTOR_ID,
    };
  }
}

function toFigureDto(figure: Figure): ReportingFigureDto {
  return { value: figure.value, drill: { ...figure.drill, query: { ...figure.drill.query } } };
}

function toWindowedDto(figure: WindowedFigure): ReportingWindowedFigureDto {
  return { today: toFigureDto(figure.today), d7: toFigureDto(figure.d7) };
}

function toConnectionDto(connection: SyncConnectionHealth): SyncConnectionHealthDto {
  return { ...connection };
}

/** The facade's read onto the flat per-tile DTOs — typed field by field, no cast. */
function toOverviewResponse(overview: Overview): ReportingOverviewResponse {
  const t = overview.tiles;
  return {
    asOf: overview.asOf,
    stale: overview.stale,
    window: { ...overview.window },
    tiles: {
      dockToStock: {
        state: t.dockToStock.state,
        medianMinutes: toWindowedDto(t.dockToStock.medianMinutes),
        awaitingPutaway: toFigureDto(t.dockToStock.awaitingPutaway),
      },
      pickRate: {
        state: t.pickRate.state,
        pickLines: toWindowedDto(t.pickRate.pickLines),
        lastHour: toFigureDto(t.pickRate.lastHour),
      },
      shortPicks: { state: t.shortPicks.state, shortLines: toWindowedDto(t.shortPicks.shortLines) },
      grnVariances: {
        state: t.grnVariances.state,
        overReceipts: toWindowedDto(t.grnVariances.overReceipts),
        pendingOverReceipts: toFigureDto(t.grnVariances.pendingOverReceipts),
        blindGrns: toWindowedDto(t.grnVariances.blindGrns),
      },
      orderAccuracy: {
        state: t.orderAccuracy.state,
        defectsPer1000: toWindowedDto(t.orderAccuracy.defectsPer1000),
        shortLines: toWindowedDto(t.orderAccuracy.shortLines),
        packFailures: toWindowedDto(t.orderAccuracy.packFailures),
        dispatchedLines: toWindowedDto(t.orderAccuracy.dispatchedLines),
        countingSince: t.orderAccuracy.countingSince,
      },
      oversell: {
        state: t.oversell.state,
        backorderedOrders: toWindowedDto(t.oversell.backorderedOrders),
        prevented: toWindowedDto(t.oversell.prevented),
        countingSince: t.oversell.countingSince,
      },
      expiryAlerts: {
        state: t.expiryAlerts.state,
        openExpiryUpcoming: toFigureDto(t.expiryAlerts.openExpiryUpcoming),
        openAged: toFigureDto(t.expiryAlerts.openAged),
        raised: toWindowedDto(t.expiryAlerts.raised),
      },
      syncHealth: {
        state: t.syncHealth.state,
        connections: t.syncHealth.connections === null ? null : t.syncHealth.connections.map(toConnectionDto),
        drill: { ...t.syncHealth.drill, query: { ...t.syncHealth.drill.query } },
      },
      dispatchPipeline: {
        state: t.dispatchPipeline.state,
        accepted: toFigureDto(t.dispatchPipeline.accepted),
        readyToDispatch: toFigureDto(t.dispatchPipeline.readyToDispatch),
        labelledNotManifested: toFigureDto(t.dispatchPipeline.labelledNotManifested),
        ordersDispatched: toWindowedDto(t.dispatchPipeline.ordersDispatched),
      },
      sm8: {
        state: t.sm8.state,
        eligible: toWindowedDto(t.sm8.eligible),
        gatewayGenerated: toWindowedDto(t.sm8.gatewayGenerated),
        gatewayShare: toWindowedDto(t.sm8.gatewayShare),
        invoicesIssued: toWindowedDto(t.sm8.invoicesIssued),
        noManualPricingShare: toWindowedDto(t.sm8.noManualPricingShare),
      },
    },
  };
}

/** The session tenant must own the path (the receiving/eway controllers' shape). */
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

/** A uuid path param fails 400 (never a 500 from the `::uuid` cast) — the outbound controller's shape. */
function assertUuidParam(value: string, name: 'warehouseId' | 'clientId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" path parameter must be a uuid (got "${value}").`,
    );
  }
}
