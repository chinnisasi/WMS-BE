import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  MAX_NOTIFICATION_PAGE_SIZE,
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  type NotificationEntry,
} from '../modules/notifications/notifications.facade';
import { AUDIT_EXPORT_FAILURE_REASONS, SOURCE_RESOLUTIONS } from '../modules/notifications/notification-sources';

/**
 * Story 9-2 — the notification panel's wire shapes. Each entry is one arm of
 * a discriminated union on `sourceType`, carrying that source's own summary
 * (a per-source allowlist — never a raw event payload) and its own
 * resolution vocabulary.
 */

export class NotificationListQuery {
  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: DEFAULT_NOTIFICATION_PAGE_SIZE, minimum: 1, maximum: MAX_NOTIFICATION_PAGE_SIZE, description: `Page size, default ${DEFAULT_NOTIFICATION_PAGE_SIZE}` })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_NOTIFICATION_PAGE_SIZE)
  limit?: number;
}

// ── summaries ────────────────────────────────────────────────────────────────

export class StockAdjustmentSummaryDto {
  @ApiProperty({ format: 'uuid' }) skuId!: string;
  @ApiProperty({ description: 'The requested signed adjustment, base units of the SKU’s UoM' }) quantityDelta!: number;
  @ApiProperty() reasonCode!: string;
}

export class CountVarianceSummaryDto {
  @ApiProperty({ format: 'uuid' }) skuId!: string;
  @ApiProperty({ description: 'Counted − expected, base units' }) delta!: number;
}

export class OverReceiptSummaryDto {
  @ApiProperty() grnCode!: string;
  @ApiProperty({ format: 'uuid' }) skuId!: string;
  @ApiProperty({ description: 'The units received beyond the document, base units' }) excessQty!: number;
}

export class RejectedOpSummaryDto {
  @ApiProperty({ description: 'The device op type, e.g. `grn.submit`' }) opType!: string;
  @ApiProperty({ description: 'The refusal’s problem code' }) problemCode!: string;
}

export class ReorderBreachSummaryDto {
  @ApiProperty({ format: 'uuid' }) skuId!: string;
  @ApiProperty({ description: 'ATP at detection, base units' }) atpQty!: number;
  @ApiProperty({ description: 'The effective reorder point at detection, base units' }) pointQty!: number;
}

export class BatchAlertSummaryDto {
  @ApiProperty({ enum: ['expiry_upcoming', 'aged'] }) kind!: 'expiry_upcoming' | 'aged';
  @ApiProperty({ format: 'uuid' }) skuId!: string;
  @ApiProperty() batchCode!: string;
  @ApiProperty({ required: false, format: 'date-time', description: 'The batch’s expiry — the expiry_upcoming arm only' }) expiryDate?: string;
  @ApiProperty({ required: false, description: 'The frozen age in whole days — the aged arm only' }) ageDays?: number;
}

export class QcHoldSummaryDto {
  @ApiProperty({ format: 'uuid' }) skuId!: string;
  @ApiProperty() reason!: string;
}

export class ChannelSyncSummaryDto {
  @ApiProperty({ format: 'uuid' }) connectionId!: string;
}

/** Story 9-3b — a finished audit export (one summary arm for ready and failed). */
export class AuditExportSummaryDto {
  @ApiProperty({ enum: ['ready', 'failed'] }) status!: 'ready' | 'failed';
  @ApiProperty({ required: false, enum: AUDIT_EXPORT_FAILURE_REASONS, description: 'Why it failed — the failed arm only' }) reason?: (typeof AUDIT_EXPORT_FAILURE_REASONS)[number];
  @ApiProperty({ required: false, description: 'The events in the file — the ready arm only' }) rowCount?: number;
}

// ── entries ──────────────────────────────────────────────────────────────────

abstract class NotificationEntryBaseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid', description: 'The source occurrence’s own id (the pending adjustment, the over-receipt, the episode…)' }) sourceId!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The warehouse the source belongs to; null for a device op or a channel' }) warehouseId!: string | null;
  @ApiProperty({ format: 'date-time', description: 'When the source raised it (the list orders by this, newest first)' }) raisedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'When the source cleared; null while open' }) resolvedAt!: string | null;
}

export class StockAdjustmentNotificationDto extends NotificationEntryBaseDto {
  @ApiProperty({ enum: ['stock-adjustment'] }) sourceType!: 'stock-adjustment';
  @ApiProperty({ type: StockAdjustmentSummaryDto }) summary!: StockAdjustmentSummaryDto;
  @ApiProperty({ type: String, nullable: true, enum: [...SOURCE_RESOLUTIONS['stock-adjustment'], null] }) resolution!: (typeof SOURCE_RESOLUTIONS)['stock-adjustment'][number] | null;
}

export class CountVarianceNotificationDto extends NotificationEntryBaseDto {
  @ApiProperty({ enum: ['count-variance'] }) sourceType!: 'count-variance';
  @ApiProperty({ type: CountVarianceSummaryDto }) summary!: CountVarianceSummaryDto;
  @ApiProperty({ type: String, nullable: true, enum: [...SOURCE_RESOLUTIONS['count-variance'], null] }) resolution!: (typeof SOURCE_RESOLUTIONS)['count-variance'][number] | null;
}

export class OverReceiptNotificationDto extends NotificationEntryBaseDto {
  @ApiProperty({ enum: ['over-receipt'] }) sourceType!: 'over-receipt';
  @ApiProperty({ type: OverReceiptSummaryDto }) summary!: OverReceiptSummaryDto;
  @ApiProperty({ type: String, nullable: true, enum: [...SOURCE_RESOLUTIONS['over-receipt'], null] }) resolution!: (typeof SOURCE_RESOLUTIONS)['over-receipt'][number] | null;
}

export class RejectedOpNotificationDto extends NotificationEntryBaseDto {
  @ApiProperty({ enum: ['rejected-op'] }) sourceType!: 'rejected-op';
  @ApiProperty({ type: RejectedOpSummaryDto }) summary!: RejectedOpSummaryDto;
  @ApiProperty({ type: String, nullable: true, enum: [...SOURCE_RESOLUTIONS['rejected-op'], null] }) resolution!: (typeof SOURCE_RESOLUTIONS)['rejected-op'][number] | null;
}

export class ReorderBreachNotificationDto extends NotificationEntryBaseDto {
  @ApiProperty({ enum: ['reorder-breach'] }) sourceType!: 'reorder-breach';
  @ApiProperty({ type: ReorderBreachSummaryDto }) summary!: ReorderBreachSummaryDto;
  @ApiProperty({ type: String, nullable: true, enum: [...SOURCE_RESOLUTIONS['reorder-breach'], null] }) resolution!: (typeof SOURCE_RESOLUTIONS)['reorder-breach'][number] | null;
}

export class BatchAlertNotificationDto extends NotificationEntryBaseDto {
  @ApiProperty({ enum: ['batch-alert'] }) sourceType!: 'batch-alert';
  @ApiProperty({ type: BatchAlertSummaryDto }) summary!: BatchAlertSummaryDto;
  @ApiProperty({ type: String, nullable: true, enum: [...SOURCE_RESOLUTIONS['batch-alert'], null] }) resolution!: (typeof SOURCE_RESOLUTIONS)['batch-alert'][number] | null;
}

export class QcHoldNotificationDto extends NotificationEntryBaseDto {
  @ApiProperty({ enum: ['qc-hold'] }) sourceType!: 'qc-hold';
  @ApiProperty({ type: QcHoldSummaryDto }) summary!: QcHoldSummaryDto;
  @ApiProperty({ type: String, nullable: true, enum: [...SOURCE_RESOLUTIONS['qc-hold'], null] }) resolution!: (typeof SOURCE_RESOLUTIONS)['qc-hold'][number] | null;
}

export class ChannelSyncNotificationDto extends NotificationEntryBaseDto {
  @ApiProperty({ enum: ['channel-sync'] }) sourceType!: 'channel-sync';
  @ApiProperty({ type: ChannelSyncSummaryDto }) summary!: ChannelSyncSummaryDto;
  @ApiProperty({ type: String, nullable: true, enum: [...SOURCE_RESOLUTIONS['channel-sync'], null] }) resolution!: (typeof SOURCE_RESOLUTIONS)['channel-sync'][number] | null;
}

/** Story 9-3b — addressed to the export's requester only; open until the file expires. */
export class AuditExportNotificationDto extends NotificationEntryBaseDto {
  @ApiProperty({ enum: ['audit-export'] }) sourceType!: 'audit-export';
  @ApiProperty({ type: AuditExportSummaryDto }) summary!: AuditExportSummaryDto;
  @ApiProperty({ type: String, nullable: true, enum: [...SOURCE_RESOLUTIONS['audit-export'], null] }) resolution!: (typeof SOURCE_RESOLUTIONS)['audit-export'][number] | null;
}

export const NOTIFICATION_ENTRY_DTOS = [
  StockAdjustmentNotificationDto,
  CountVarianceNotificationDto,
  OverReceiptNotificationDto,
  RejectedOpNotificationDto,
  ReorderBreachNotificationDto,
  BatchAlertNotificationDto,
  QcHoldNotificationDto,
  ChannelSyncNotificationDto,
  AuditExportNotificationDto,
] as const;

export type NotificationEntryDto = InstanceType<(typeof NOTIFICATION_ENTRY_DTOS)[number]>;

export class NotificationListResponse {
  @ApiProperty({
    type: 'array',
    description: 'Visible entries, newest first. A member sees only the sources it can act on.',
    items: {
      oneOf: NOTIFICATION_ENTRY_DTOS.map((dto) => ({ $ref: getSchemaPath(dto) })),
      discriminator: {
        propertyName: 'sourceType',
        mapping: {
          'stock-adjustment': getSchemaPath(StockAdjustmentNotificationDto),
          'count-variance': getSchemaPath(CountVarianceNotificationDto),
          'over-receipt': getSchemaPath(OverReceiptNotificationDto),
          'rejected-op': getSchemaPath(RejectedOpNotificationDto),
          'reorder-breach': getSchemaPath(ReorderBreachNotificationDto),
          'batch-alert': getSchemaPath(BatchAlertNotificationDto),
          'qc-hold': getSchemaPath(QcHoldNotificationDto),
          'channel-sync': getSchemaPath(ChannelSyncNotificationDto),
          'audit-export': getSchemaPath(AuditExportNotificationDto),
        },
      },
    },
  })
  items!: NotificationEntryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class NotificationStatusResponse {
  @ApiProperty({ description: 'Show the bell’s dot: an open entry you can act on surfaced since you last opened the panel (or you never have). Never a count' })
  hasNew!: boolean;
}

/**
 * The entry onto the wire — key by key (the facade's entry is already the
 * allowlist; this only narrows the union for the DTO types).
 */
export function toNotificationEntryDto(entry: NotificationEntry): NotificationEntryDto {
  return {
    id: entry.id,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    warehouseId: entry.warehouseId,
    summary: entry.summary,
    raisedAt: entry.raisedAt,
    resolvedAt: entry.resolvedAt,
    resolution: entry.resolution,
  } as NotificationEntryDto;
}
