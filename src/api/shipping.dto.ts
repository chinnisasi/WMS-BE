import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  HANDOVER_PARCEL_REFUSALS,
  LABEL_VERIFY_METHODS,
  MAX_HANDOVER_PARCELS,
  PORTAL_DOC_KINDS,
  PORTAL_SHIPPING_STATUSES,
  SHIPMENT_KINDS,
  SHIPMENT_STATUSES,
  SHIPPING_DOC_KINDS,
} from '../modules/outbound/outbound.facade';

/**
 * Story 4-4a — the client-arranged shipping DTOs (request bodies and the
 * response shapes the OpenAPI document publishes). The commands do every
 * domain shape check (400 `validation-failed`, naming the field); the
 * validators here only type the body.
 */

// ── requests ────────────────────────────────────────────────────────────────

/** A9 — `POST …/outbound/orders/{orderId}/shipment/awb` (staff). */
export class RecordAwbAdviceDto {
  @ApiProperty({ description: 'The AWB / LR number, normalised (trimmed, upper-cased, spaces and hyphens stripped): 4–50 letters, digits or "/"' })
  @IsString()
  @MaxLength(200)
  awb!: string;

  @ApiProperty({ required: false, description: 'The courier by name (1–100 characters) — or name a transporter partner; exactly one' })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  courierName?: string;

  @ApiProperty({ required: false, format: 'uuid', description: 'A transporter partner as the courier — or type its name; exactly one' })
  @IsOptional()
  @IsUUID()
  transporterId?: string;

  @ApiProperty({ required: false, type: Number, description: 'Parcels in the shipment, 1–999' })
  @IsOptional()
  @IsInt()
  packageCount?: number;

  @ApiProperty({ required: false, type: Boolean, description: 'Replace the order’s live client label or AWB (before the handover)' })
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

/** A9 — the portal twin: the courier by name only (transporters are staff master data). */
export class PortalAwbAdviceDto {
  @ApiProperty({ description: 'The AWB / LR number (normalised: 4–50 letters, digits or "/")' })
  @IsString()
  @MaxLength(200)
  awb!: string;

  @ApiProperty({ description: 'The courier’s name, 1–100 characters' })
  @IsString()
  @MaxLength(400)
  courierName!: string;

  @ApiProperty({ required: false, type: Number, description: 'Parcels, 1–999' })
  @IsOptional()
  @IsInt()
  packageCount?: number;

  @ApiProperty({ required: false, type: Boolean, description: 'Replace your label or AWB (before the handover)' })
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

/** A8 — the label upload's multipart text fields (strings). */
export class ClientLabelUploadFieldsDto {
  @ApiProperty({ description: 'The AWB printed on the label' })
  @IsString()
  awb!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  courierName?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsString()
  transporterId?: string;

  @ApiProperty({ required: false, description: 'Parcels, 1–999 (a whole number as text)' })
  @IsOptional()
  @IsString()
  packageCount?: string;

  @ApiProperty({ required: false, description: '"true" to replace the live label' })
  @IsOptional()
  @IsString()
  replace?: string;
}

/** A8 — the portal label upload's multipart text fields. */
export class PortalClientLabelUploadFieldsDto {
  @ApiProperty()
  @IsString()
  awb!: string;

  @ApiProperty()
  @IsString()
  courierName!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  packageCount?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  replace?: string;
}

/** A10 — `POST …/shipment/void`. */
export class VoidShipmentDto {
  @ApiProperty({ description: 'Why the shipment is voided, 1–200 characters' })
  @IsString()
  @MaxLength(800)
  reason!: string;
}

/** A11 — `POST …/shipment/verify`. */
export class VerifyLabelDto {
  @ApiProperty({ description: 'The scanned (or typed) AWB — compared normalised' })
  @IsString()
  @MaxLength(200)
  scannedCode!: string;

  @ApiProperty({ enum: [...LABEL_VERIFY_METHODS] })
  @IsString()
  method!: string;

  @ApiProperty({ required: false, description: 'The handheld’s scan instant (required on the device; refused-as-ignored on the web — null there)' })
  @IsOptional()
  @IsString()
  occurredAt?: string;
}

export class HandoverCourierDto {
  @ApiProperty({ required: false, format: 'uuid', description: 'A transporter partner — or name it; exactly one' })
  @IsOptional()
  @IsString()
  transporterId?: string;

  @ApiProperty({ required: false, description: 'The courier’s name, 1–100 characters' })
  @IsOptional()
  @IsString()
  courierName?: string;
}

export class HandoverParcelDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  orderId!: string;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'The AWB scanned on the parcel (required with no verified client label)' })
  @IsOptional()
  @IsString()
  awb?: string | null;

  @ApiProperty({ required: false, type: Number, nullable: true, description: 'Parcels, 1–999 (default: the shipment’s, else 1)' })
  @IsOptional()
  @IsInt()
  packageCount?: number | null;

  @ApiProperty({ required: false, type: Number, nullable: true, description: 'Weight in grams, 1–1,000,000 (default: the last pack measurement)' })
  @IsOptional()
  @IsInt()
  weightGrams?: number | null;
}

/** A12 — `POST …/outbound/handovers`. */
export class CreateHandoverDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid', description: 'One handover carries one client’s parcels' })
  @IsString()
  clientId!: string;

  @ApiProperty({ type: HandoverCourierDto })
  @ValidateNested()
  @Type(() => HandoverCourierDto)
  courier!: HandoverCourierDto;

  @ApiProperty({ description: 'Who collected the parcels, 1–100 characters' })
  @IsString()
  pickupPersonName!: string;

  @ApiProperty({ required: false, type: String, nullable: true })
  @IsOptional()
  @IsString()
  pickupPersonPhone?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Vehicle number (normalised: KA01AB1234)' })
  @IsOptional()
  @IsString()
  vehicleNumber?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'The pickup time: on the web within the last 7 days (default now); required on the handheld' })
  @IsOptional()
  @IsString()
  occurredAt?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Up to 500 characters' })
  @IsOptional()
  @IsString()
  note?: string | null;

  @ApiProperty({ type: [HandoverParcelDto], description: `1–${MAX_HANDOVER_PARCELS} parcels` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_HANDOVER_PARCELS + 1)
  @ValidateNested({ each: true })
  @Type(() => HandoverParcelDto)
  parcels!: HandoverParcelDto[];

  @ApiProperty({ required: false, type: [String], description: 'The handheld’s signed-sheet photo refs (≤ 10; refused on the web)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photoRefs?: string[];
}

/** A14 — a document upload's multipart text field. */
export class OrderDocumentFieldsDto {
  @ApiProperty({ enum: [...SHIPPING_DOC_KINDS], description: 'invoice, challan, eway-bill, pod or other (the portal: never pod)' })
  @IsString()
  kind!: string;
}

/** A14 — the handheld sheet photo's multipart text field. */
export class HandoverPhotoFieldsDto {
  @ApiProperty({ format: 'date-time', description: 'The capture instant, ISO-8601 UTC ending in Z' })
  @IsString()
  capturedAt!: string;
}

/** A14 — `POST …/outbound/shipping-files/{attachmentId}/remove`. */
export class RemoveShippingFileDto {
  @ApiProperty({ description: 'Why, 1–200 characters' })
  @IsString()
  @MaxLength(800)
  reason!: string;
}

// ── responses ───────────────────────────────────────────────────────────────

export class ClientShipmentViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: [...SHIPMENT_KINDS] }) kind!: string;
  @ApiProperty({ enum: [...SHIPMENT_STATUSES] }) status!: string;
  @ApiProperty() courierName!: string;
  @ApiProperty({ description: 'The AWB / LR number as stored (normalised)' }) awb!: string;
  @ApiProperty({ type: Number, nullable: true }) packageCount!: number | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) transporterId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) labelAttachmentId!: string | null;
  @ApiProperty({ type: String, nullable: true }) labelVerifiedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['scan', 'typed', 'handover-scan', null] }) labelVerifyMethod!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['web', 'portal', 'handheld', null] }) recordedSurface!: string | null;
  @ApiProperty() labelledAt!: string;
  @ApiProperty({ format: 'uuid' }) labelledBy!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) handoverId!: string | null;
  @ApiProperty({ type: String, nullable: true }) handedOverAt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) weightGrams!: number | null;
  @ApiProperty({ type: String, nullable: true }) voidedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidReason!: string | null;
}

export class ClientShipmentResponse {
  @ApiProperty({ type: ClientShipmentViewDto }) shipment!: ClientShipmentViewDto;
}

export class VerifyLabelResponse {
  @ApiProperty({ type: ClientShipmentViewDto }) shipment!: ClientShipmentViewDto;
  @ApiProperty({ description: 'True when this request verified the label; false when it already was (a no-op that stores the key)' }) verified!: boolean;
}

export class PortalShipmentViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: [...SHIPMENT_KINDS] }) kind!: string;
  @ApiProperty({ enum: [...SHIPMENT_STATUSES] }) status!: string;
  @ApiProperty() courierName!: string;
  @ApiProperty() awb!: string;
  @ApiProperty({ type: Number, nullable: true }) packageCount!: number | null;
  @ApiProperty() recordedAt!: string;
}

export class PortalShipmentResponse {
  @ApiProperty({ type: PortalShipmentViewDto }) shipment!: PortalShipmentViewDto;
}

export class ShippingFileSnapshotDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['shipping-label', 'shipping-document', 'handover-sheet'] }) purpose!: string;
  @ApiProperty({ type: String, nullable: true, enum: [...SHIPPING_DOC_KINDS, null] }) docKind!: string | null;
  @ApiProperty({ type: String, nullable: true }) contentType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) byteSize!: number | null;
  @ApiProperty({ type: Number, nullable: true }) pageCount!: number | null;
  @ApiProperty({ enum: ['web', 'portal', 'handheld'] }) source!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: String, nullable: true }) uploadedAt!: string | null;
}

export class ShippingFileResponse {
  @ApiProperty({ type: ShippingFileSnapshotDto }) file!: ShippingFileSnapshotDto;
}

export class StagedPhotoResponse {
  @ApiProperty() ref!: string;
  @ApiProperty({ enum: ['staged', 'attached', 'removed'] }) status!: string;
}

export class HandoverViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'HO-NNNN' }) code!: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty() courierName!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) transporterId!: string | null;
  @ApiProperty() pickupPersonName!: string;
  @ApiProperty({ type: String, nullable: true }) vehicleNumber!: string | null;
  @ApiProperty() handedOverAt!: string;
  @ApiProperty() shipmentCount!: number;
  @ApiProperty() packageCount!: number;
  @ApiProperty() codShipmentCount!: number;
  @ApiProperty() codTotalPaise!: number;
  @ApiProperty({ enum: ['web', 'handheld'] }) source!: string;
}

export class HandoverParcelResultDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) shipmentId!: string;
  @ApiProperty() awb!: string;
  @ApiProperty({ enum: [true] }) dispatched!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) followOnOrderId!: string | null;
}

export class HandoverRefusedParcelDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: [...HANDOVER_PARCEL_REFUSALS] }) code!: string;
  @ApiProperty() detail!: string;
}

export class HandoverResponse {
  @ApiProperty({ type: HandoverViewDto, nullable: true, description: 'Null when every parcel of a handheld handover was refused (the review row holds them)' })
  handover!: HandoverViewDto | null;
  @ApiProperty({ type: [HandoverParcelResultDto] }) parcels!: HandoverParcelResultDto[];
  @ApiProperty({ type: [HandoverRefusedParcelDto], description: 'Handheld only: the parcels refused into one review row (Discard only)' }) refused!: HandoverRefusedParcelDto[];
  @ApiProperty({ type: String, nullable: true, description: 'The review row’s op id (derived from the key)' }) rejectedOpId!: string | null;
}

export class FileViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['shipping-label', 'shipping-document', 'handover-sheet'] }) purpose!: string;
  @ApiProperty({ type: String, nullable: true, enum: [...SHIPPING_DOC_KINDS, null] }) docKind!: string | null;
  @ApiProperty({ description: 'The server-built name (never the uploader’s)' }) fileName!: string;
  @ApiProperty({ type: String, nullable: true }) contentType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) byteSize!: number | null;
  @ApiProperty({ type: Number, nullable: true }) pageCount!: number | null;
  @ApiProperty({ enum: ['web', 'portal', 'handheld'] }) source!: string;
  @ApiProperty({ type: String, nullable: true }) uploadedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) uploadedBy!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'A short-lived presigned URL; null when unsigned' }) url!: string | null;
  @ApiProperty({ type: String, nullable: true }) urlExpiresAt!: string | null;
}

export class OrderShippingHandoverDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() courierName!: string;
  @ApiProperty() handedOverAt!: string;
  @ApiProperty() pickupPersonName!: string;
  @ApiProperty({ type: String, nullable: true }) pickupPersonPhoneMasked!: string | null;
  @ApiProperty({ type: String, nullable: true }) vehicleNumber!: string | null;
  @ApiProperty({ type: [FileViewDto] }) sheet!: FileViewDto[];
}

export class OrderShippingResponse {
  @ApiProperty({ type: ClientShipmentViewDto, nullable: true }) shipment!: ClientShipmentViewDto | null;
  @ApiProperty({ type: [ClientShipmentViewDto], description: 'Voided shipments, newest first' }) history!: ClientShipmentViewDto[];
  @ApiProperty({ type: FileViewDto, nullable: true }) label!: FileViewDto | null;
  @ApiProperty({ type: [FileViewDto] }) documents!: FileViewDto[];
  @ApiProperty({ type: OrderShippingHandoverDto, nullable: true }) handover!: OrderShippingHandoverDto | null;
  @ApiProperty({ description: 'The parcel tag’s code (`O` + the order id’s last 16 hex digits)' }) parcelTagCode!: string;
  @ApiProperty() storageEnabled!: boolean;
}

export class HandoverCandidateShipmentDto {
  @ApiProperty({ enum: [...SHIPMENT_KINDS] }) kind!: string;
  @ApiProperty() awb!: string;
  @ApiProperty() courierName!: string;
  @ApiProperty({ type: Number, nullable: true }) packageCount!: number | null;
  @ApiProperty() labelVerified!: boolean;
}

export class HandoverCandidateDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderLabel!: string;
  @ApiProperty({ type: String, nullable: true }) clientOrderRef!: string | null;
  @ApiProperty({ type: String, nullable: true }) externalEventId!: string | null;
  @ApiProperty({ type: Number, nullable: true }) followOnSeq!: number | null;
  @ApiProperty() parcelTagCode!: string;
  @ApiProperty({ type: String, nullable: true }) destinationCity!: string | null;
  @ApiProperty({ type: Number, nullable: true }) codAmountPaise!: number | null;
  @ApiProperty({ type: String, nullable: true }) packedAt!: string | null;
  @ApiProperty({ type: HandoverCandidateShipmentDto, nullable: true }) shipment!: HandoverCandidateShipmentDto | null;
}

export class HandoverCandidatesResponse {
  @ApiProperty({ type: [HandoverCandidateDto] }) items!: HandoverCandidateDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class HandoverListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty({ type: String, nullable: true }) clientCode!: string | null;
  @ApiProperty() courierName!: string;
  @ApiProperty() shipmentCount!: number;
  @ApiProperty() packageCount!: number;
  @ApiProperty() handedOverAt!: string;
  @ApiProperty() sheetPageCount!: number;
  @ApiProperty({ enum: ['web', 'handheld'] }) source!: string;
}

export class HandoversResponse {
  @ApiProperty({ type: [HandoverListItemDto] }) items!: HandoverListItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class HandoverDetailParcelDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderLabel!: string;
  @ApiProperty({ format: 'uuid' }) shipmentId!: string;
  @ApiProperty({ enum: [...SHIPMENT_KINDS] }) kind!: string;
  @ApiProperty() awb!: string;
  @ApiProperty({ type: Number, nullable: true }) packageCount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) weightGrams!: number | null;
  @ApiProperty({ type: Number, nullable: true }) codAmountPaise!: number | null;
  @ApiProperty({ type: String, nullable: true }) destinationCity!: string | null;
}

export class HandoverDetailDto extends HandoverViewDto {
  @ApiProperty({ type: String, nullable: true, description: 'Unmasked for a dispatch.execute holder; masked otherwise' }) pickupPersonPhone!: string | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: Object, description: 'The client as frozen at the handover (ClientPartySnapshotV1)' }) clientSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: Object, description: 'The warehouse as frozen at the handover' }) warehouseSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: Object, nullable: true, description: 'The transporter as frozen (TransporterSnapshotV1), when one was named' }) courierSnapshot!: Record<string, unknown> | null;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ type: [HandoverDetailParcelDto] }) parcels!: HandoverDetailParcelDto[];
  @ApiProperty({ type: [FileViewDto] }) sheet!: FileViewDto[];
}

export class HandoverDetailResponse {
  @ApiProperty({ type: HandoverDetailDto }) handover!: HandoverDetailDto;
}

export class PortalFileDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'invoice, challan, eway-bill, pod, other, label or signed-sheet' }) kind!: string;
  @ApiProperty() fileName!: string;
  @ApiProperty({ type: String, nullable: true }) contentType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) pageCount!: number | null;
  @ApiProperty({ type: String, nullable: true }) uploadedAt!: string | null;
  @ApiProperty() uploadedByYou!: boolean;
  @ApiProperty({ type: String, nullable: true }) url!: string | null;
  @ApiProperty({ type: String, nullable: true }) urlExpiresAt!: string | null;
}

export class PortalOrderShippingResponse {
  @ApiProperty({ enum: [...PORTAL_SHIPPING_STATUSES] }) status!: string;
  @ApiProperty({ type: String, nullable: true }) courierName!: string | null;
  @ApiProperty({ type: String, nullable: true }) awb!: string | null;
  @ApiProperty({ type: Number, nullable: true }) packageCount!: number | null;
  @ApiProperty({ type: String, nullable: true }) handedOverAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) vehicleNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) handoverCode!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Who collected the parcels — as on the signed sheet' }) pickupPersonName!: string | null;
  @ApiProperty({ type: PortalFileDto, nullable: true }) label!: PortalFileDto | null;
  @ApiProperty({ type: [PortalFileDto] }) documents!: PortalFileDto[];
  @ApiProperty({ type: [PortalFileDto] }) handoverSheet!: PortalFileDto[];
}

/** The portal's document kinds, for the upload form. */
export const PORTAL_DOCUMENT_KINDS = PORTAL_DOC_KINDS;

/** A guard for the parcel tag's `format` query. */
export const PARCEL_TAG_FORMATS = ['zpl', 'pdf'] as const;

export class ParcelTagQueryDto {
  @ApiProperty({ enum: [...PARCEL_TAG_FORMATS], required: false })
  @IsOptional()
  @IsIn([...PARCEL_TAG_FORMATS])
  format?: 'zpl' | 'pdf';
}
