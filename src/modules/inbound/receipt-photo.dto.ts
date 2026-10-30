import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';
import { ATTACHMENT_IMAGE_TYPES } from '../attachments/attachments.facade';
import { GrnArrivalDto, GrnDocumentRefDto, GrnExcessDto, GrnLineQcDto, GrnPartiesDto, GrnTotalsDto } from './receiving.dto';

/**
 * Story 2-5a — the damage-photo shapes. A stored idempotency snapshot never
 * carries a URL (A14): the device upload answers `{ref, status}`, the web add
 * and remove answer the attachment WITHOUT a URL; presigned URLs exist only
 * in the GET reads.
 */

export const RECEIPT_PHOTO_STATUSES = ['awaited', 'attached', 'removed', 'expired'] as const;
export type ReceiptPhotoStatus = (typeof RECEIPT_PHOTO_STATUSES)[number];
export const RECEIPT_PHOTO_SOURCES = ['handheld', 'web'] as const;
export const DEVICE_UPLOAD_STATUSES = ['staged', 'attached', 'removed'] as const;
export type DeviceUploadStatus = (typeof DEVICE_UPLOAD_STATUSES)[number];

/** The upload of one handheld photo (POST …/receiving/receipt-photos, 201 — the idempotency snapshot). */
export class ReceiptPhotoUploadResponse {
  @ApiProperty({ description: "The photo's ULID — its Idempotency-Key and the ref its receipt names" })
  ref!: string;

  @ApiProperty({
    enum: [...DEVICE_UPLOAD_STATUSES],
    description:
      '`staged`: stored, waiting for its receipt; `attached`: it filled the placeholder its receipt left; `removed`: the same bytes were already stored and removed since (a late duplicate)',
  })
  status!: DeviceUploadStatus;
}

/** One receipt photo, as the web add and remove answer it (no URL — the stored snapshot). */
export class ReceiptPhotoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'The goods-receipt line it is evidence for' })
  grnLineId!: string;

  @ApiProperty({ enum: [...RECEIPT_PHOTO_STATUSES] })
  status!: ReceiptPhotoStatus;

  @ApiProperty({ enum: [...ATTACHMENT_IMAGE_TYPES, null], type: String, nullable: true, description: 'Null while awaited, and on a cancelled placeholder' })
  contentType!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'The stored (metadata-stripped) size in bytes' })
  byteSize!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  width!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height!: number | null;

  @ApiProperty({ type: String, nullable: true, description: "The device's capture time (clamped to [now − 60 d, now + 10 min]); null for a web photo" })
  capturedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'When the server received the bytes; null while awaited' })
  uploadedAt!: string | null;

  @ApiProperty({ enum: [...RECEIPT_PHOTO_SOURCES] })
  source!: 'handheld' | 'web';

  @ApiProperty({ required: false, description: 'Present on a removed photo' })
  removedAt?: string;
}

export class ReceiptPhotoResponse {
  @ApiProperty({ type: ReceiptPhotoDto })
  attachment!: ReceiptPhotoDto;
}

/** One photo of a receipt as the staff read shows it. */
export class ReceiptPhotoViewDto extends ReceiptPhotoDto {
  @ApiProperty({ minimum: 1, description: "The line's position in the receipt (1-based, receipt order)" })
  lineNo!: number;

  @ApiProperty({ description: 'A server-built ASCII file name, `<grnCode>-L<lineNo>-<k>.<ext>`' })
  fileName!: string;

  @ApiProperty({ type: String, nullable: true, description: 'A short-lived presigned GET URL; null when the photo holds no bytes (awaited, expired, removed), or storage is off' })
  url!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'When `url` stops working (≤ ATTACHMENT_URL_TTL_SECONDS) — refetch the list after it' })
  urlExpiresAt!: string | null;

  @ApiProperty({ description: 'Row creation time' })
  createdAt!: string;

  @ApiProperty({ required: false, format: 'uuid', description: 'Present on a removed photo' })
  removedBy?: string;

  @ApiProperty({ required: false, description: "The remover's name, when known" })
  removedByName?: string;

  @ApiProperty({ required: false, description: 'Present on a removed photo (1–200 characters)' })
  removedReason?: string;
}

export class ReceiptPhotosResponse {
  @ApiProperty({ description: 'False under FILE_STORE=none — no URLs, and adding a photo answers 503' })
  storageEnabled!: boolean;

  @ApiProperty({
    type: [ReceiptPhotoViewDto],
    description: 'Every live photo (attached + awaited) in receipt order, then at most the 50 newest removed/expired',
  })
  photos!: ReceiptPhotoViewDto[];
}

/** POST …/goods-receipts/{grnId}/photos/{attachmentId}/remove body. */
export class RemoveReceiptPhotoDto {
  @ApiProperty({ minLength: 1, maxLength: 200, description: 'Why the photo is removed (or the placeholder cancelled) — kept on the record; trimmed, then 1–200 characters' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 200)
  reason!: string;
}

// ── the client portal (A4) ────────────────────────────────────────────────────

export class PortalReceiptPhotoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['attached', 'removed'], description: '`removed`: shown as "Removed by the warehouse" — no image, no reason' })
  status!: 'attached' | 'removed';

  @ApiProperty({ type: String, nullable: true })
  url!: string | null;

  @ApiProperty({ type: String, nullable: true })
  urlExpiresAt!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  width!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height!: number | null;

  @ApiProperty({ type: String, nullable: true })
  capturedAt!: string | null;
}

export class PortalGoodsReceiptRowDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  warehouseName!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The purchase order received against, when any' })
  poCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The advance shipment notice received against, when any' })
  asnCode!: string | null;

  @ApiProperty()
  lineCount!: number;

  @ApiProperty({ description: 'Good units across the lines (base units, indicative across UoMs)' })
  receivedTotal!: number;

  @ApiProperty({ description: 'Damaged units across the lines' })
  damagedTotal!: number;

  @ApiProperty({ description: 'Short units across the lines' })
  shortTotal!: number;

  @ApiProperty({ description: 'Attached damage photos across the lines' })
  photoCount!: number;

  @ApiProperty({ description: 'When the goods were received (the device time)' })
  receivedAt!: string;

  @ApiProperty()
  createdAt!: string;
}

export class PortalGoodsReceiptListResponse {
  @ApiProperty({ type: [PortalGoodsReceiptRowDto] })
  items!: PortalGoodsReceiptRowDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class PortalGoodsReceiptLineDto {
  @ApiProperty({ minimum: 1 })
  lineNo!: number;

  @ApiProperty()
  skuCode!: string;

  @ApiProperty()
  skuName!: string;

  @ApiProperty({ description: 'Good units' })
  qty!: number;

  @ApiProperty()
  damagedQty!: number;

  @ApiProperty({ type: String, nullable: true })
  damageReasonCode!: string | null;

  @ApiProperty()
  shortQty!: number;

  @ApiProperty({ type: String, nullable: true })
  shortReasonCode!: string | null;

  @ApiProperty({ type: [PortalReceiptPhotoDto] })
  photos!: PortalReceiptPhotoDto[];

  // ── story 2-9a (additive) ──
  @ApiProperty({ type: String, nullable: true })
  damageReasonLabel!: string | null;

  @ApiProperty({ type: String, nullable: true })
  shortReasonLabel!: string | null;

  @ApiProperty()
  uom!: string;

  @ApiProperty({ description: 'Decimal places of the UoM' })
  uomPrecision!: number;

  @ApiProperty({ type: String, nullable: true })
  batchCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'IST calendar date' })
  mfgDate!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'IST calendar date' })
  expiryDate!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: ['typed', 'derived', null] })
  expirySource!: 'typed' | 'derived' | null;

  @ApiProperty({ type: GrnExcessDto, description: 'Over-receipt units awaiting approval, approved and rejected' })
  excess!: GrnExcessDto;

  @ApiProperty({ type: GrnLineQcDto, description: 'The quality-check outcome of the line' })
  qc!: GrnLineQcDto;

  @ApiProperty()
  serialCount!: number;

  @ApiProperty()
  unreadableSerialCount!: number;
}

export class PortalGoodsReceiptDetailDto extends PortalGoodsReceiptRowDto {
  @ApiProperty({ type: [PortalGoodsReceiptLineDto] })
  lines!: PortalGoodsReceiptLineDto[];

  // ── story 2-9a (additive): the GRN document's header ──
  @ApiProperty({ type: GrnPartiesDto })
  parties!: GrnPartiesDto;

  @ApiProperty({ type: GrnDocumentRefDto })
  document!: GrnDocumentRefDto;

  @ApiProperty({ type: GrnArrivalDto, nullable: true })
  arrival!: GrnArrivalDto | null;

  @ApiProperty({ type: GrnTotalsDto })
  totals!: GrnTotalsDto;
}

/** The text part of the handheld's multipart upload (the `file` part carries the bytes). */
export class UploadReceiptPhotoFieldsDto {
  @ApiProperty({ required: false, description: "The device's capture instant, ISO-8601 UTC ending in Z (required — validated by the command)" })
  @IsOptional()
  @IsString()
  capturedAt?: string;
}
