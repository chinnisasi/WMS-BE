import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CONSIGNMENT_GATE_CODES } from '../shared/primitives/consignment-gate';
import { DELIVERY_OUTCOMES, FREIGHT_MODES, FREIGHT_TERMS, VEHICLE_TYPES } from '../shared/primitives/freight';
import {
  FREIGHT_ADD_REFUSALS,
  FREIGHT_CANDIDATE_STATUSES,
  FREIGHT_CONSIGNMENT_STATUSES,
  FREIGHT_DECISIONS,
  FREIGHT_DISPATCH_REFUSALS,
  FREIGHT_LIST_VIEWS,
  FREIGHT_LOAD_EXCEPTIONS,
  FREIGHT_LOAD_STATUSES,
  FREIGHT_SCAN_ACTIONS,
} from '../modules/outbound/freight-vocabulary';
import { FileViewDto } from './shipping.dto';

/**
 * Story 4-9a — the freight routes' DTOs. The request DTOs only stop absurd
 * bodies (the global `forbidNonWhitelisted` pipe); every shape rule is the
 * command's, behind the capability check and the replay (guide §1).
 */

// ── requests ─────────────────────────────────────────────────────────────

export class FreightTransporterDto {
  @ApiProperty({ required: false, type: String, nullable: true, format: 'uuid', description: 'A transporter partner (frozen at departure)' })
  @IsOptional()
  @IsString()
  transporterId?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Or the typed name (1–100) — exactly one of the two' })
  @IsOptional()
  @IsString()
  name?: string | null;
}

export class FreightLoadHeaderDto {
  @ApiProperty({ enum: [...FREIGHT_MODES] })
  @IsString()
  mode!: string;

  @ApiProperty({ type: FreightTransporterDto })
  @IsObject()
  @ValidateNested()
  @Type(() => FreightTransporterDto)
  transporter!: FreightTransporterDto;

  @ApiProperty({ required: false, enum: [...VEHICLE_TYPES, null], nullable: true })
  @IsOptional()
  @IsString()
  vehicleType?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Spaces, dots and hyphens stripped, upper-cased; 4–15 letters or digits' })
  @IsOptional()
  @IsString()
  vehicleNumber?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: '1–11 letters or digits' })
  @IsOptional()
  @IsString()
  containerNumber?: string | null;

  @ApiProperty({ required: false, type: Number, nullable: true, description: 'Kilograms, 1–60,000' })
  @IsOptional()
  @IsInt()
  vehicleCapacityKg?: number | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: '1–80 characters' })
  @IsOptional()
  @IsString()
  driverName?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: '7–15 digits, optionally with a leading +' })
  @IsOptional()
  @IsString()
  driverPhone?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Upper-cased, spaces and hyphens stripped; 6–20 letters or digits' })
  @IsOptional()
  @IsString()
  driverLicenceNumber?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: '1–20 letters, digits or hyphens (2-3b’s door code, or typed)' })
  @IsOptional()
  @IsString()
  dockDoor?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'date-time', description: 'When the truck reported, within the last 7 days' })
  @IsOptional()
  @IsString()
  vehicleReportedAt?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: '1–500 characters' })
  @IsOptional()
  @IsString()
  note?: string | null;
}

export class CreateFreightLoadDto extends FreightLoadHeaderDto {
  @ApiProperty({ required: false, type: [String], description: 'The orders to plan on it (≤ 100) — all-or-nothing (409 freight-orders-refused)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(101)
  @IsString({ each: true })
  orderIds?: string[];
}

export class UpdateFreightLoadDto extends FreightLoadHeaderDto {}

export class FreightOrderIdsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(101)
  @IsString({ each: true })
  orderIds!: string[];
}

export class FreightReasonDto {
  @ApiProperty({ description: '1–200 characters' })
  @IsString()
  reason!: string;
}

export class FreightScanDto {
  @ApiProperty({ description: 'The package label scanned (carton or pallet code), or a one-package order’s parcel tag' })
  @IsString()
  packageCode!: string;

  @ApiProperty({ enum: [...FREIGHT_SCAN_ACTIONS] })
  @IsString()
  action!: string;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'date-time', description: 'The handheld’s scan time (required on the device; 400 on the web)' })
  @IsOptional()
  @IsString()
  occurredAt?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Required for an unload (1–200)' })
  @IsOptional()
  @IsString()
  reason?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'uuid', description: 'A55 — the device’s warehouse (from its snapshot; required on the device)' })
  @IsOptional()
  @IsString()
  warehouseId?: string | null;
}

export class FreightDispatchConsignmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  orderId!: string;

  @ApiProperty({ enum: [...FREIGHT_DECISIONS] })
  @IsString()
  decision!: string;

  @ApiProperty({ required: false, type: String, nullable: true })
  @IsOptional()
  @IsString()
  lrNumber?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'date' })
  @IsOptional()
  @IsString()
  lrDate?: string | null;

  @ApiProperty({ required: false, enum: [...FREIGHT_TERMS, null], nullable: true })
  @IsOptional()
  @IsString()
  freightTerms?: string | null;

  @ApiProperty({ required: false, type: Boolean, nullable: true, description: 'Web: send it with packages unscanned (recorded as a load exception)' })
  @IsOptional()
  @IsBoolean()
  unscannedAcknowledged?: boolean | null;
}

export class DispatchFreightLoadDto {
  @ApiProperty()
  @IsString()
  vehicleNumber!: string;

  @ApiProperty({ required: false, enum: [...VEHICLE_TYPES, null], nullable: true })
  @IsOptional()
  @IsString()
  vehicleType?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true })
  @IsOptional()
  @IsString()
  containerNumber?: string | null;

  @ApiProperty()
  @IsString()
  driverName!: string;

  @ApiProperty({ required: false, type: String, nullable: true })
  @IsOptional()
  @IsString()
  driverPhone?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true })
  @IsOptional()
  @IsString()
  driverLicenceNumber?: string | null;

  @ApiProperty({ required: false, type: [String], description: '≤ 5 seal numbers, unique' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  seals?: string[];

  @ApiProperty({ required: false, type: String, nullable: true, format: 'date-time', description: 'Web: when the truck left (default now; up to 7 days back, never before its loading)' })
  @IsOptional()
  @IsString()
  departedAt?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'date-time', description: 'Device: when the truck left (required on the device)' })
  @IsOptional()
  @IsString()
  occurredAt?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'uuid', description: 'A55 — the device’s warehouse (required on the device)' })
  @IsOptional()
  @IsString()
  warehouseId?: string | null;

  @ApiProperty({ required: false, type: Boolean, nullable: true, description: 'The e-way bills were updated with this vehicle (Part B)' })
  @IsOptional()
  @IsBoolean()
  ewayPartBConfirmed?: boolean | null;

  @ApiProperty({ required: false, type: Boolean, nullable: true, description: 'A66 — web: send it over the stated capacity' })
  @IsOptional()
  @IsBoolean()
  overCapacityAcknowledged?: boolean | null;

  @ApiProperty({ type: [FreightDispatchConsignmentDto] })
  @IsArray()
  @ArrayMaxSize(101)
  @ValidateNested({ each: true })
  @Type(() => FreightDispatchConsignmentDto)
  consignments!: FreightDispatchConsignmentDto[];

  @ApiProperty({ required: false, type: [String], description: 'Device: the signed loading-sheet photos (≤ 10 ULIDs)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(11)
  @IsString({ each: true })
  photoRefs?: string[];

  @ApiProperty({ required: false, type: String, nullable: true })
  @IsOptional()
  @IsString()
  note?: string | null;
}

export class RecordFreightLrDto {
  @ApiProperty()
  @IsString()
  lrNumber!: string;

  @ApiProperty({ required: false, type: String, nullable: true, format: 'date' })
  @IsOptional()
  @IsString()
  lrDate?: string | null;

  @ApiProperty({ required: false, enum: [...FREIGHT_TERMS, null], nullable: true })
  @IsOptional()
  @IsString()
  freightTerms?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Required to change the LR after departure' })
  @IsOptional()
  @IsString()
  reason?: string | null;
}

export class RecordFreightDeliveryDto {
  @ApiProperty({ enum: [...DELIVERY_OUTCOMES] })
  @IsString()
  outcome!: string;

  @ApiProperty({ format: 'date-time' })
  @IsString()
  deliveredAt!: string;

  @ApiProperty({ required: false, type: String, nullable: true })
  @IsOptional()
  @IsString()
  receiverName?: string | null;

  @ApiProperty({ required: false, type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  shortPackageCount?: number | null;

  @ApiProperty({ required: false, type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  damagedPackageCount?: number | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Required with exceptions or a refusal (1–500)' })
  @IsOptional()
  @IsString()
  note?: string | null;

  @ApiProperty({ required: false, type: String, nullable: true, description: 'Required to amend a recorded delivery (orders.manage)' })
  @IsOptional()
  @IsString()
  reason?: string | null;
}

export class FreightLoadsQueryDto {
  @ApiProperty({ required: false, enum: [...FREIGHT_LIST_VIEWS] })
  @IsOptional()
  @IsIn([...FREIGHT_LIST_VIEWS])
  view?: (typeof FREIGHT_LIST_VIEWS)[number];

  @ApiProperty({ required: false, format: 'uuid', description: 'Loads holding a live consignment of this client' })
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiProperty({ required: false, format: 'date', description: 'IST date, inclusive' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiProperty({ required: false, format: 'date', description: 'IST date, inclusive' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, description: '1–100 (default 50)' })
  @IsOptional()
  @IsString()
  limit?: string;
}

export class FreightCandidatesQueryDto {
  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  pincode?: string;

  @ApiProperty({ required: false, enum: [...FREIGHT_CANDIDATE_STATUSES] })
  @IsOptional()
  @IsIn([...FREIGHT_CANDIDATE_STATUSES])
  status?: (typeof FREIGHT_CANDIDATE_STATUSES)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, description: '1–500 (default 200)' })
  @IsOptional()
  @IsString()
  limit?: string;
}

export class FreightPdfQueryDto {
  @ApiProperty({ required: false, enum: ['pdf'] })
  @IsOptional()
  @IsIn(['pdf'])
  format?: 'pdf';
}

export class FreightPhotoFieldsDto {
  @ApiProperty({ format: 'date-time', description: 'When the photo was taken (ISO-8601, Z)' })
  @IsString()
  capturedAt!: string;
}

// ── responses ────────────────────────────────────────────────────────────

export class FreightTransporterViewDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) partnerId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty({ type: Object, nullable: true, description: 'TransporterSnapshotV1 (a partner), frozen at departure' }) snapshot!: unknown;
}

export class FreightVehicleViewDto {
  @ApiProperty({ type: String, nullable: true, enum: [...VEHICLE_TYPES, null] }) type!: string | null;
  @ApiProperty({ type: String, nullable: true }) number!: string | null;
  @ApiProperty({ type: String, nullable: true }) containerNumber!: string | null;
  @ApiProperty({ type: Number, nullable: true }) capacityKg!: number | null;
  @ApiProperty({ type: String, nullable: true }) reportedAt!: string | null;
}

export class FreightDriverViewDto {
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Unmasked for a dispatch.execute holder, else masked' }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The same rule as the phone' }) licenceNumber!: string | null;
}

export class FreightPartBDto {
  @ApiProperty() required!: boolean;
  @ApiProperty({ type: String, nullable: true }) confirmedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) confirmedBy!: string | null;
}

export class FreightTotalsDto {
  @ApiProperty() consignments!: number;
  @ApiProperty() packages!: number;
  @ApiProperty() loaded!: number;
  @ApiProperty() pallets!: number;
  @ApiProperty({ type: Number, nullable: true }) grossWeightGrams!: number | null;
  @ApiProperty() weightKnown!: boolean;
  @ApiProperty() overCapacity!: boolean;
}

export class FreightConsigneeDto {
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) city!: string | null;
  @ApiProperty({ type: String, nullable: true }) state!: string | null;
  @ApiProperty({ type: String, nullable: true }) pincode!: string | null;
}

export class FreightLrDto {
  @ApiProperty({ type: String, nullable: true }) number!: string | null;
  @ApiProperty({ type: String, nullable: true }) date!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: [...FREIGHT_TERMS, null] }) terms!: string | null;
}

export class FreightPackagesDto {
  @ApiProperty() total!: number;
  @ApiProperty() pallets!: number;
  @ApiProperty() loaded!: number;
  @ApiProperty({ description: 'Scans of a superseded pack (re-packed after loading started — scan the new labels)' }) staleScans!: number;
  @ApiProperty() packed!: boolean;
}

export class FreightGateDto {
  @ApiProperty() state!: string;
  @ApiProperty() blocking!: boolean;
}

export class FreightEwayDto {
  @ApiProperty({ type: String, nullable: true }) number!: string | null;
  @ApiProperty({ type: String, nullable: true }) validUntil!: string | null;
}

export class FreightInvoiceDto {
  @ApiProperty() type!: string;
  @ApiProperty() number!: string;
  @ApiProperty() date!: string;
}

export class FreightDeliveryDto {
  @ApiProperty({ enum: [...DELIVERY_OUTCOMES] }) outcome!: string;
  @ApiProperty() deliveredAt!: string;
  @ApiProperty({ type: String, nullable: true }) receiverName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) short!: number | null;
  @ApiProperty({ type: Number, nullable: true }) damaged!: number | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty() deliverySeq!: number;
  @ApiProperty({ type: String, nullable: true }) recordedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) recordedBy!: string | null;
}

export class FreightConsignmentViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderLabel!: string;
  @ApiProperty() orderStatus!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty() clientCode!: string;
  @ApiProperty() stopSeq!: number;
  @ApiProperty({ description: 'LD-0007/03' }) consignmentRef!: string;
  @ApiProperty({ enum: [...FREIGHT_CONSIGNMENT_STATUSES] }) status!: string;
  @ApiProperty({ type: FreightConsigneeDto }) consignee!: FreightConsigneeDto;
  @ApiProperty({ type: FreightLrDto }) lr!: FreightLrDto;
  @ApiProperty({ type: FreightPackagesDto }) packages!: FreightPackagesDto;
  @ApiProperty({ type: Number, nullable: true }) weightGrams!: number | null;
  @ApiProperty({ required: false, type: FreightGateDto, description: '4-6a’s gate before departure; absent when not judged' }) gate?: FreightGateDto;
  @ApiProperty({ type: FreightEwayDto }) eway!: FreightEwayDto;
  @ApiProperty({ type: FreightInvoiceDto, nullable: true }) invoice!: FreightInvoiceDto | null;
  @ApiProperty({ type: String, nullable: true, enum: [...FREIGHT_LOAD_EXCEPTIONS, null] }) loadException!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: [...CONSIGNMENT_GATE_CODES, null] }) complianceException!: string | null;
  @ApiProperty({ type: String, nullable: true }) dispatchedAt!: string | null;
  @ApiProperty({ type: FreightDeliveryDto, nullable: true }) delivery!: FreightDeliveryDto | null;
}

export class FreightRemovedDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderLabel!: string;
  @ApiProperty() reason!: string;
  @ApiProperty() removedAt!: string;
}

export class FreightCancelDto {
  @ApiProperty() at!: string;
  @ApiProperty({ format: 'uuid' }) by!: string;
  @ApiProperty() reason!: string;
}

export class FreightLoadViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: [...FREIGHT_LOAD_STATUSES] }) status!: string;
  @ApiProperty({ enum: [...FREIGHT_MODES] }) mode!: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty({ type: FreightTransporterViewDto }) transporter!: FreightTransporterViewDto;
  @ApiProperty({ type: FreightVehicleViewDto }) vehicle!: FreightVehicleViewDto;
  @ApiProperty({ type: FreightDriverViewDto }) driver!: FreightDriverViewDto;
  @ApiProperty({ type: String, nullable: true }) dockDoor!: string | null;
  @ApiProperty({ type: [String] }) seals!: string[];
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, nullable: true }) loadingStartedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) dispatchedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) dispatchedBy!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['web', 'handheld', null] }) dispatchSource!: string | null;
  @ApiProperty({ type: FreightPartBDto }) partB!: FreightPartBDto;
  @ApiProperty() capacityExceeded!: boolean;
  @ApiProperty({ type: FreightTotalsDto }) totals!: FreightTotalsDto;
  @ApiProperty({ type: [FreightConsignmentViewDto] }) consignments!: FreightConsignmentViewDto[];
  @ApiProperty({ type: [FreightRemovedDto] }) removed!: FreightRemovedDto[];
  @ApiProperty({ type: () => [FileViewDto], description: 'The signed loading-sheet pages (a command’s answer carries no link)' }) sheet!: FileViewDto[];
  @ApiProperty({ type: FreightCancelDto, nullable: true }) cancel!: FreightCancelDto | null;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty() createdAt!: string;
}

export class FreightLoadResponse {
  @ApiProperty({ type: FreightLoadViewDto }) load!: FreightLoadViewDto;
}

export class FreightScanViewDto {
  @ApiProperty() packageCode!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: ['loaded', 'unloaded'] }) status!: string;
}

export class FreightProgressDto {
  @ApiProperty({ format: 'uuid' }) consignmentId!: string;
  @ApiProperty() loaded!: number;
  @ApiProperty() total!: number;
}

export class FreightScanResponse {
  @ApiProperty({ type: FreightScanViewDto }) scan!: FreightScanViewDto;
  @ApiProperty({ description: 'A scan of a package already loaded (another device, or a re-scan): a no-op' }) alreadyLoaded!: boolean;
  @ApiProperty({ type: FreightProgressDto }) progress!: FreightProgressDto;
}

export class FreightDispatchedEntryDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) consignmentId!: string;
  @ApiProperty({ type: String, nullable: true }) lrNumber!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: [...FREIGHT_LOAD_EXCEPTIONS, null] }) loadException!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: [...CONSIGNMENT_GATE_CODES, null] }) complianceException!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) followOnOrderId!: string | null;
}

export class FreightLeftEntryDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() reason!: string;
}

export class FreightRefusedEntryDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: [...new Set([...FREIGHT_DISPATCH_REFUSALS, ...FREIGHT_ADD_REFUSALS])] }) code!: string;
  @ApiProperty() detail!: string;
}

export class FreightDispatchResponse {
  @ApiProperty({ type: FreightLoadViewDto }) load!: FreightLoadViewDto;
  @ApiProperty({ type: [FreightDispatchedEntryDto] }) dispatched!: FreightDispatchedEntryDto[];
  @ApiProperty({ type: [FreightLeftEntryDto] }) left!: FreightLeftEntryDto[];
  @ApiProperty({ type: [FreightRefusedEntryDto], description: 'Device only: the orders that left but were not dispatched (one review row)' }) refused!: FreightRefusedEntryDto[];
  @ApiProperty({ type: String, nullable: true }) rejectedOpId!: string | null;
}

export class FreightConsignmentSnapshotDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) loadId!: string;
  @ApiProperty({ enum: [...FREIGHT_CONSIGNMENT_STATUSES] }) status!: string;
  @ApiProperty() consignmentRef!: string;
  @ApiProperty({ type: FreightLrDto }) lr!: FreightLrDto;
  @ApiProperty({ type: FreightDeliveryDto, nullable: true }) delivery!: FreightDeliveryDto | null;
}

export class FreightConsignmentResponse {
  @ApiProperty({ type: FreightConsignmentSnapshotDto }) consignment!: FreightConsignmentSnapshotDto;
  @ApiProperty({ required: false, description: 'Present (true) on the unchanged no-op (200)' }) unchanged?: boolean;
}

export class FreightLoadListRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: [...FREIGHT_LOAD_STATUSES] }) status!: string;
  @ApiProperty({ enum: [...FREIGHT_MODES] }) mode!: string;
  @ApiProperty() transporterName!: string;
  @ApiProperty({ type: String, nullable: true }) vehicleNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) dockDoor!: string | null;
  @ApiProperty() consignmentCount!: number;
  @ApiProperty({ type: [String], description: 'At most 5' }) clientCodes!: string[];
  @ApiProperty() clientMore!: number;
  @ApiProperty({ type: FreightProgressDto }) packages!: { loaded: number; total: number };
  @ApiProperty() palletCount!: number;
  @ApiProperty({ type: Number, nullable: true }) grossWeightGrams!: number | null;
  @ApiProperty({ type: Number, nullable: true }) capacityKg!: number | null;
  @ApiProperty({ type: String, nullable: true }) dispatchedAt!: string | null;
  @ApiProperty() deliveredCount!: number;
  @ApiProperty() createdAt!: string;
}

export class FreightLoadsResponse {
  @ApiProperty({ type: [FreightLoadListRowDto] }) items!: FreightLoadListRowDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class FreightCandidatePackagesDto {
  @ApiProperty() cartons!: number;
  @ApiProperty() pallets!: number;
  @ApiProperty() packed!: boolean;
}

export class FreightCandidateDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderLabel!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty() clientCode!: string;
  @ApiProperty({ enum: ['accepted', 'ready_to_dispatch'] }) status!: string;
  @ApiProperty({ type: FreightConsigneeDto }) consignee!: FreightConsigneeDto;
  @ApiProperty({ type: FreightCandidatePackagesDto }) packages!: FreightCandidatePackagesDto;
  @ApiProperty({ type: Number, nullable: true }) grossWeightGrams!: number | null;
  @ApiProperty({ required: false, type: FreightGateDto }) consignment?: FreightGateDto;
}

export class FreightCandidatesResponse {
  @ApiProperty({ type: [FreightCandidateDto] }) items!: FreightCandidateDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ description: 'More than 2,000 orders matched — narrow the filters' }) truncated!: boolean;
}

export class OrderFreightDeliveryDto {
  @ApiProperty({ enum: [...DELIVERY_OUTCOMES] }) outcome!: string;
  @ApiProperty() deliveredAt!: string;
  @ApiProperty({ type: String, nullable: true }) receiverName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) short!: number | null;
  @ApiProperty({ type: Number, nullable: true }) damaged!: number | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty() deliverySeq!: number;
}

/** A20 — the order's freight block on the staff shipping read. */
export class OrderFreightBlockDto {
  @ApiProperty({ format: 'uuid' }) consignmentId!: string;
  @ApiProperty({ format: 'uuid' }) loadId!: string;
  @ApiProperty() loadCode!: string;
  @ApiProperty() consignmentRef!: string;
  @ApiProperty({ enum: [...FREIGHT_CONSIGNMENT_STATUSES] }) status!: string;
  @ApiProperty() stopSeq!: number;
  @ApiProperty({ type: String, nullable: true }) lrNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) lrDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) freightTerms!: string | null;
  @ApiProperty() transporterName!: string;
  @ApiProperty({ type: String, nullable: true }) vehicleNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) dispatchedAt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) packageCount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) loadedPackageCount!: number | null;
  @ApiProperty({ type: String, nullable: true }) loadException!: string | null;
  @ApiProperty({ type: OrderFreightDeliveryDto, nullable: true }) delivery!: OrderFreightDeliveryDto | null;
}

/** A22 — the portal's truck block: only `status` while planned. */
export class PortalFreightBlockDto {
  @ApiProperty({ enum: ['planned', 'dispatched', 'delivered', 'delivered-with-exceptions', 'refused'] }) status!: string;
  @ApiProperty({ required: false }) consignmentRef?: string;
  @ApiProperty({ required: false }) transporterName?: string;
  @ApiProperty({ required: false }) vehicleNumber?: string;
  @ApiProperty({ required: false, type: String, nullable: true }) containerNumber?: string | null;
  @ApiProperty({ required: false, type: [String], nullable: true, description: 'FTL only' }) seals?: string[] | null;
  @ApiProperty({ required: false }) driverName?: string;
  @ApiProperty({ required: false, type: String, nullable: true }) lrNumber?: string | null;
  @ApiProperty({ required: false, type: String, nullable: true }) lrDate?: string | null;
  @ApiProperty({ required: false, type: String, nullable: true }) freightTerms?: string | null;
  @ApiProperty({ required: false }) packageCount?: number;
  @ApiProperty({ required: false }) palletCount?: number;
  @ApiProperty({ required: false, type: Number, nullable: true }) weightGrams?: number | null;
  @ApiProperty({ required: false }) dispatchedAt?: string;
  @ApiProperty({ required: false, type: String, nullable: true }) deliveredAt?: string | null;
  @ApiProperty({ required: false, type: String, nullable: true }) receiverName?: string | null;
  @ApiProperty({ required: false, type: Number, nullable: true }) shortPackageCount?: number | null;
  @ApiProperty({ required: false, type: Number, nullable: true }) damagedPackageCount?: number | null;
  @ApiProperty({ required: false, type: String, nullable: true }) deliveryNote?: string | null;
  @ApiProperty({ required: false, description: 'The freight note downloads' }) noteAvailable?: boolean;
}

/** A22 — the portal order list row's truck facts. */
export class PortalOrderFreightDto {
  @ApiProperty({ type: String, nullable: true }) lrNumber!: string | null;
  @ApiProperty() transporterName!: string;
  @ApiProperty({ type: String, nullable: true }) deliveredAt!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: [...DELIVERY_OUTCOMES, null] }) outcome!: string | null;
}
