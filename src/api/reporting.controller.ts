import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { UUID_RE } from '../shared/primitives/ids';
import { ReportingFacade } from '../modules/reporting/reporting.facade';
import type { Figure, Overview, SyncConnectionHealth, WindowedFigure } from '../modules/reporting/reporting.facade';
import { ReportingOverviewResponse } from './reporting.dto';
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
function assertUuidParam(value: string, name: 'warehouseId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" path parameter must be a uuid (got "${value}").`,
    );
  }
}
