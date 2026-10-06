import { ApiProperty } from '@nestjs/swagger';
import { SYNC_HEALTH_REASONS, SYNC_HEALTH_STATES } from '../modules/reporting/reporting.facade';

/**
 * Story 9-1 — the Overview's response shape. One flat DTO class per tile
 * (no generics, no inheritance — the generated FE client reads each tile's
 * own type). Every figure is `{ value, drill }`: `value` is null when the
 * tile is `unavailable` or the figure has no data (an empty median or
 * ratio); `drill` is ALWAYS present, so even an unavailable tile names the
 * list behind it.
 */

const TILE_STATES = ['ok', 'unavailable'] as const;

const STATE_DESCRIPTION =
  "`ok`: every figure was computed. `unavailable`: the tile timed out, missed the overall deadline, or failed — every value is null (there is no 'estimated' state)";

export class ReportingDrillDto {
  @ApiProperty({
    description:
      'The API route (relative to /api/v1, ids filled in) whose rows are behind the figure — e.g. /tenants/{t}/warehouses/{w}/outbound/picklist-lines',
  })
  apiPath!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'The exact query to send it. Windowed figures carry from and to (to = asOf, exclusive)',
  })
  query!: Record<string, string>;

  @ApiProperty({
    description:
      'True: paging apiPath?query to exhaustion yields exactly the figure. False for rates, medians and ratios — and for figures whose list cannot express the exact filter',
  })
  reconciles!: boolean;
}

export class ReportingFigureDto {
  @ApiProperty({ type: Number, nullable: true, description: 'Null when the tile is unavailable or the figure has no data' })
  value!: number | null;

  @ApiProperty({ type: ReportingDrillDto })
  drill!: ReportingDrillDto;
}

export class ReportingWindowedFigureDto {
  @ApiProperty({ type: ReportingFigureDto, description: 'Today so far — the IST calendar day of asOf' })
  today!: ReportingFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Today plus the previous six IST days' })
  d7!: ReportingFigureDto;
}

export class DockToStockTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Median minutes from GRN creation to bin placement, over placements in the window (negative intervals excluded); null with no placement' })
  medianMinutes!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: GRN lines whose applied stock still sits in Receiving — the putaway task list' })
  awaitingPutaway!: ReportingFigureDto;
}

export class PickRateTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Pick lines recorded (one per line — a serial draw is one line)' })
  pickLines!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Pick lines recorded in the hour before asOf' })
  lastHour!: ReportingFigureDto;
}

export class ShortPicksTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Picklist lines flipped to short in the window — zero-unit (empty-bin) shorts included' })
  shortLines!: ReportingWindowedFigureDto;
}

export class GrnVariancesTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Over-receipts requested in the window' })
  overReceipts!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: over-receipts awaiting a decision' })
  pendingOverReceipts!: ReportingFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Blind GRNs (no purchase order — flagged for PO matching) recorded in the window' })
  blindGrns!: ReportingWindowedFigureDto;
}

export class OrderAccuracyTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'SM-3: (short-picked lines + failed pack verifications) per 1,000 dispatched lines; null with no dispatched line' })
  defectsPer1000!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto })
  shortLines!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Failed pack verifications (recorded since countingSince)' })
  packFailures!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Order lines dispatched in the window' })
  dispatchedLines!: ReportingWindowedFigureDto;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC — when failed pack verifications began to be recorded (no backfill)' })
  countingSince!: string | null;
}

export class OversellTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'SM-4: channel orders accepted in the window with at least one backordered line (per order)' })
  backorderedOrders!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Channel orders refused under the reject backorder policy — oversell prevented (recorded since countingSince)' })
  prevented!: ReportingWindowedFigureDto;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC — when refusals began to be recorded (no backfill)' })
  countingSince!: string | null;
}

export class ExpiryAlertsTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: open expiry-upcoming alerts' })
  openExpiryUpcoming!: ReportingFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: open aged-stock alerts' })
  openAged!: ReportingFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Alerts of either kind raised in the window' })
  raised!: ReportingWindowedFigureDto;
}

export class SyncConnectionHealthDto {
  @ApiProperty({ format: 'uuid' })
  integrationId!: string;

  @ApiProperty()
  provider!: string;

  @ApiProperty({ enum: ['connected', 'disconnected'], description: 'A disconnected connection is always health error, reason disconnected' })
  status!: string;

  @ApiProperty({ enum: SYNC_HEALTH_STATES })
  health!: (typeof SYNC_HEALTH_STATES)[number];

  @ApiProperty({
    type: String,
    nullable: true,
    enum: [...SYNC_HEALTH_REASONS, null],
    description:
      "Why the health is not ok. disconnected / ingest-warehouse-unset (error — channel orders land nowhere); then /channels' own rule (connectionHealth): breaker-open (error), breaker-half-open, last-delivery-failed, never-synced, sync-lag (degraded); then ingest-failures (degraded — a genuine order-ingest failure in 24 h; refusals and settled cancellations are not failures). Null when ok",
  })
  reason!: (typeof SYNC_HEALTH_REASONS)[number] | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Seconds since the last successful availability sync; null when it never synced' })
  lagSeconds!: number | null;

  @ApiProperty({ description: 'Genuine order-ingest failures in the 24 h before asOf (a policy refusal or a settled cancellation is not one)' })
  ingestFailures24h!: number;
}

export class SyncHealthTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({
    type: [SyncConnectionHealthDto],
    nullable: true,
    description: 'Channel connections (connected or disconnected) ingesting into this warehouse or with no ingest warehouse set; null when unavailable',
  })
  connections!: SyncConnectionHealthDto[] | null;

  @ApiProperty({ type: ReportingDrillDto })
  drill!: ReportingDrillDto;
}

export class DispatchPipelineTileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: orders accepted, not yet packed' })
  accepted!: ReportingFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: orders packed, ready to dispatch' })
  readyToDispatch!: ReportingFigureDto;

  @ApiProperty({ type: ReportingFigureDto, description: 'Live: shipments labelled but not yet on a manifest (no list of their own — drills to the packed orders)' })
  labelledNotManifested!: ReportingFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Orders dispatched in the window' })
  ordersDispatched!: ReportingWindowedFigureDto;
}

export class Sm8TileDto {
  @ApiProperty({ enum: TILE_STATES, description: STATE_DESCRIPTION })
  state!: (typeof TILE_STATES)[number];

  @ApiProperty({ type: ReportingWindowedFigureDto, description: "E-way bills queued in the window for this warehouse's invoices (dismissed bills and voided invoices excluded)" })
  eligible!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Of those, generated through the gateway' })
  gatewayGenerated!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'SM-8: gatewayGenerated ÷ eligible, 0–1; null with none eligible. Reads 0 until a live gateway adapter exists' })
  gatewayShare!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: "This warehouse's invoices issued in the window" })
  invoicesIssued!: ReportingWindowedFigureDto;

  @ApiProperty({ type: ReportingWindowedFigureDto, description: 'Secondary: the share (0–1) of those issued with no manually priced line; null with none issued' })
  noManualPricingShare!: ReportingWindowedFigureDto;
}

export class ReportingTilesDto {
  @ApiProperty({ type: DockToStockTileDto })
  dockToStock!: DockToStockTileDto;

  @ApiProperty({ type: PickRateTileDto })
  pickRate!: PickRateTileDto;

  @ApiProperty({ type: ShortPicksTileDto })
  shortPicks!: ShortPicksTileDto;

  @ApiProperty({ type: GrnVariancesTileDto })
  grnVariances!: GrnVariancesTileDto;

  @ApiProperty({ type: OrderAccuracyTileDto })
  orderAccuracy!: OrderAccuracyTileDto;

  @ApiProperty({ type: OversellTileDto })
  oversell!: OversellTileDto;

  @ApiProperty({ type: ExpiryAlertsTileDto })
  expiryAlerts!: ExpiryAlertsTileDto;

  @ApiProperty({ type: SyncHealthTileDto })
  syncHealth!: SyncHealthTileDto;

  @ApiProperty({ type: DispatchPipelineTileDto })
  dispatchPipeline!: DispatchPipelineTileDto;

  @ApiProperty({ type: Sm8TileDto })
  sm8!: Sm8TileDto;
}

export class ReportingWindowDto {
  @ApiProperty({ description: "ISO-8601 UTC — IST midnight of asOf's IST date (the start of today)" })
  todayFrom!: string;

  @ApiProperty({ description: 'ISO-8601 UTC — IST midnight six days before todayFrom' })
  d7From!: string;

  @ApiProperty({ description: 'ISO-8601 UTC — the exclusive end of every window (= asOf)' })
  to!: string;

  @ApiProperty({ description: "ISO-8601 UTC — asOf − 1 h: the pick rate's lastHour window start (its drill's from)" })
  lastHourFrom!: string;

  @ApiProperty({ description: "ISO-8601 UTC — asOf − 24 h: the sync tile's ingest-failure window start" })
  last24hFrom!: string;
}

export class ReportingOverviewResponse {
  @ApiProperty({ description: 'ISO-8601 UTC — the instant every figure was read at' })
  asOf!: string;

  @ApiProperty({ description: 'True whenever any tile is unavailable' })
  stale!: boolean;

  @ApiProperty({ type: ReportingWindowDto })
  window!: ReportingWindowDto;

  @ApiProperty({ type: ReportingTilesDto })
  tiles!: ReportingTilesDto;
}
