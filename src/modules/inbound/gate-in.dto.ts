import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RepeatableParam } from '../../shared/primitives/instant-range';
import { VendorSnapshotDto } from '../partners/partners.dto';
import { GATE_IN_DOCUMENT_KINDS, GATE_IN_LIMITS, GATE_IN_STATUSES, SEAL_STATUSES, UNLOAD_PHASES } from './gate-in.command';
import { GATE_IN_LINK_REASONS } from './gate-in.read';

/**
 * Story 2-3a — the gate-in's HTTP shapes. The DTO checks types, generous
 * outer bounds on the body's size and the fixed enums (a document `kind`,
 * an unload `phase`, a list `status` — `@IsIn`); every other rule —
 * normalisation, the regexes, the seal vocabulary and pairing, the duplicate
 * document, a time in the future, a document dated after today — is the
 * command's, behind its replay lookup, and answers a 400 naming the field or
 * the document row.
 */

/** Optional + nullable: a key may be absent, `null`, or a value of the type. */
const Nullable = () => ValidateIf((_, value) => value !== null && value !== undefined);

// ── inputs ────────────────────────────────────────────────────────────────────

export class GateInDocumentInputDto {
  @ApiProperty({ enum: [...GATE_IN_DOCUMENT_KINDS], description: 'The supplier document: an invoice, a delivery challan or a bill of entry' })
  @IsIn(GATE_IN_DOCUMENT_KINDS)
  kind!: string;

  @ApiProperty({ maxLength: GATE_IN_LIMITS.documentNumber, description: 'The document number as printed (trimmed; a repeated kind + number on one gate-in is refused)' })
  @IsString()
  @MaxLength(200)
  number!: string;

  @ApiProperty({ example: '2026-10-21', description: 'The date printed on the document, a calendar date YYYY-MM-DD as typed (never an instant); not after today in IST' })
  @IsString()
  @MaxLength(40)
  documentDate!: string;

  @ApiProperty({ required: false, nullable: true, type: String, example: '1234 5678 9012', description: 'The inward e-way bill number — 12 digits, spaces ignored' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(40)
  ewayBillNo?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid', description: 'The purchase order the document covers (any status, any client, this warehouse) — at most one of poId / asnId' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(64)
  poId?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid', description: 'The advance shipment notice the document covers (any status, any client, this warehouse)' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(64)
  asnId?: string | null;
}

/** The header shared by create and amend (amend: a FULL replacement — an absent optional becomes null). */
export class GateInHeaderDto {
  @ApiProperty({ required: false, type: Boolean, nullable: true, description: 'Goods brought by hand — no vehicle; makes vehicleNo optional (decision 13). Absent = false' })
  @IsOptional()
  @Nullable()
  @IsBoolean()
  handDelivery?: boolean | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: 'KA-01.AB 1234',
    description: 'The registration number — uppercased, spaces, dots and hyphens stripped, then 4–15 letters and digits (BH-series and temporary plates fit). Required unless handDelivery',
  })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(60)
  vehicleNo?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, example: 'MSKU1234567', description: 'The container number — at most 11 letters and digits (uppercased)' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(60)
  containerNo?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid', description: 'An active partner holding the transporter role — exactly one of transporterPartnerId / transporterName (decision 4)' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(64)
  transporterPartnerId?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: GATE_IN_LIMITS.transporterName, description: 'The transporter typed by name (not in the partner master)' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(400)
  transporterName?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: GATE_IN_LIMITS.lrNumber, description: "The lorry receipt (LR) / consignment note number" })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(200)
  lrNumber?: string | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: GATE_IN_LIMITS.driverName })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(400)
  driverName?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: '98765 43345',
    description: "The driver's phone — 7–15 digits, optionally led by +; spaces, hyphens, dots and brackets ignored. Personal data: masked on every read but the detail for a gate.manage holder, never in an event",
  })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(60)
  driverPhone?: string | null;

  @ApiProperty({ enum: [...SEAL_STATUSES], description: 'The seal as found at the gate — a broken seal is flagged, never blocked (decision 8)' })
  @IsString()
  @MaxLength(40)
  sealStatus!: string;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: GATE_IN_LIMITS.sealNumber, description: 'The seal number(s), several comma-separated — required unless sealStatus is none, refused when none' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(400)
  sealNumber?: string | null;

  @ApiProperty({ required: false, nullable: true, type: Number, minimum: 0, maximum: GATE_IN_LIMITS.packages, description: 'Packages the paperwork declares — blank means not declared, and no mismatch flag is shown (decision 11)' })
  @IsOptional()
  @Nullable()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  packagesDeclared?: number | null;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: GATE_IN_LIMITS.dockDoor, description: 'The dock door, a typed code (the dock-door master is 2-3b)' })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(200)
  dockDoor?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'When the vehicle gated in (ISO-8601 with a zone). Create: absent = now. Amend: absent = unchanged; a different time only while gated_in (409 gate-in-time-locked). More than 5 minutes ahead of the server clock is 400 time-in-future',
  })
  @IsOptional()
  @Nullable()
  @IsString()
  @MaxLength(40)
  gatedInAt?: string | null;

  @ApiProperty({ required: false, type: [GateInDocumentInputDto], maxItems: GATE_IN_LIMITS.documents, description: 'The supplier documents (0–20) — the full set (amend replaces it)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(GATE_IN_LIMITS.documents)
  @ValidateNested({ each: true })
  @Type(() => GateInDocumentInputDto)
  documents?: GateInDocumentInputDto[];
}

export class CreateGateInDto extends GateInHeaderDto {
  @ApiProperty({ format: 'uuid', description: 'The warehouse whose gate the vehicle came through' })
  @IsUUID()
  warehouseId!: string;
}

export class AmendGateInDto extends GateInHeaderDto {}

export class UnloadGateInDto {
  @ApiProperty({ enum: [...UNLOAD_PHASES], description: '`start` records the unload start; `end` records its end with the packages counted' })
  @IsIn(UNLOAD_PHASES)
  phase!: string;

  @ApiProperty({
    required: false,
    type: String,
    format: 'date-time',
    description:
      'When it happened (ISO-8601 with a zone). REQUIRED on the device route (minted at the press, taken as sent). Web: absent = now; more than 5 minutes ahead is 400 time-in-future, and before the gated-in time (or, for an end, the start) is 400 time-out-of-order',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  occurredAt?: string;

  @ApiProperty({ required: false, type: Number, minimum: 0, maximum: GATE_IN_LIMITS.packages, description: 'The packages counted off the vehicle — required with end, refused with start' })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  packagesCounted?: number;
}

export class GateOutDto {
  @ApiProperty({ required: false, type: String, format: 'date-time', description: 'When the vehicle left (ISO-8601 with a zone); absent = now. Not before the gated-in time, not more than 5 minutes ahead' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  gatedOutAt?: string;
}

export class GateInListQuery {
  @ApiProperty({ format: 'uuid', description: "The warehouse whose gate-ins to list (every client's — a truck can carry several)" })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ required: false, enum: [...GATE_IN_STATUSES], isArray: true, description: 'Only these statuses (repeat the parameter for several: ?status=gated_in&status=unloading)' })
  @IsOptional()
  @RepeatableParam()
  @IsArray()
  @IsIn(GATE_IN_STATUSES, { each: true })
  status?: string[];

  @ApiProperty({ required: false, description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, example: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

// ── answers ───────────────────────────────────────────────────────────────────

export class GateInDocumentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ minimum: 0, description: 'Its place on the gate-in (0-based)' })
  position!: number;

  @ApiProperty({ enum: [...GATE_IN_DOCUMENT_KINDS] })
  kind!: string;

  @ApiProperty()
  number!: string;

  @ApiProperty({ description: 'A calendar date YYYY-MM-DD' })
  documentDate!: string;

  @ApiProperty({ type: String, nullable: true, description: '12 digits' })
  ewayBillNo!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  poId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  asnId!: string | null;
}

/** The header every gate-in surface carries. */
class GateInHeaderFieldsDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ example: 'GI-0001', description: 'GI-<n>, unique per tenant' })
  code!: string;

  @ApiProperty({ enum: [...GATE_IN_STATUSES] })
  status!: string;

  @ApiProperty()
  handDelivery!: boolean;

  @ApiProperty({ type: String, nullable: true, description: 'Normalised (KA01AB1234); null on a hand delivery' })
  vehicleNo!: string | null;

  @ApiProperty({ type: String, nullable: true })
  containerNo!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  transporterPartnerId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  transporterName!: string | null;

  @ApiProperty({ type: VendorSnapshotDto, nullable: true, description: 'The transporter partner as it was frozen at record time (the vendor snapshot shape, v1); null for a typed name' })
  transporterSnapshot!: VendorSnapshotDto | null;

  @ApiProperty({ description: "The frozen partner's name, else the typed name" })
  transporterLabel!: string;

  @ApiProperty({ type: String, nullable: true })
  lrNumber!: string | null;

  @ApiProperty({ type: String, nullable: true })
  driverName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '98•••••345', description: 'MASKED everywhere but the detail read for a gate.manage holder (decision 10)' })
  driverPhone!: string | null;

  @ApiProperty({ enum: [...SEAL_STATUSES] })
  sealStatus!: string;

  @ApiProperty({ type: String, nullable: true })
  sealNumber!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  packagesDeclared!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Recorded with the unload end' })
  packagesCounted!: number | null;

  @ApiProperty({ type: String, nullable: true })
  dockDoor!: string | null;

  @ApiProperty({ description: 'ISO-8601 UTC — entered at the gate (editable while gated_in)' })
  gatedInAt!: string;

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC — as recorded (a device time is taken as sent)' })
  unloadStartedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  unloadEndedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gatedOutAt!: string | null;

  @ApiProperty({ format: 'uuid' })
  recordedBy!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  unloadStartedBy!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  unloadEndedBy!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  gatedOutBy!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

/** A mutation's answer: the header and its documents (the phone masked). */
export class GateInDto extends GateInHeaderFieldsDto {
  @ApiProperty({ type: [GateInDocumentDto] })
  documents!: readonly GateInDocumentDto[];
}

export class GateInResponse {
  @ApiProperty({ type: GateInDto })
  gateIn!: GateInDto;
}

export class GateInUnloadResponse {
  @ApiProperty({ description: 'false when every column this unload would fill was already recorded — the first record stands, nothing changed (the web reads "Already recorded")' })
  applied!: boolean;

  @ApiProperty({ type: GateInDto })
  gateIn!: GateInDto;
}

/** One row of the staff list. */
export class GateInEntryDto extends GateInHeaderFieldsDto {
  @ApiProperty({ minimum: 0 })
  documentCount!: number;

  @ApiProperty({ minimum: 0, description: 'Goods receipts linked to this visit — any client, including receipts linked after the gate-out' })
  receiptCount!: number;

  @ApiProperty({ type: String, nullable: true, enum: ['short', 'excess', 'matches', null], description: 'Counted against declared; null while either is missing (blank declared = no flag)' })
  packagesFlag!: 'short' | 'excess' | 'matches' | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, description: '|declared − counted| beside a flag' })
  packagesDifference!: number | null;

  @ApiProperty({ description: 'Not gated out and gated in more than 7 days ago (the device no longer offers it)' })
  staleOpen!: boolean;
}

export class GateInListResponse {
  @ApiProperty({ type: [GateInEntryDto] })
  items!: readonly GateInEntryDto[];

  @ApiProperty({ type: String, nullable: true, required: false })
  nextCursor?: string | null;
}

export class GateInDetailDocumentDto extends GateInDocumentDto {
  @ApiProperty({ type: String, nullable: true, description: "The covered PO's code" })
  poCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The covered ASN's code" })
  asnCode!: string | null;
}

export class GateInReceiptDocumentDto {
  @ApiProperty({ enum: ['po', 'asn', 'blind'] })
  kind!: 'po' | 'asn' | 'blind';

  @ApiProperty({ type: String, nullable: true, description: 'The PO or ASN code; null on a blind receipt' })
  code!: string | null;
}

export class GateInReceiptDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'GRN-0042' })
  code!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: "The receipt's client (null on an older unattributed receipt)" })
  clientId!: string | null;

  @ApiProperty({ type: GateInReceiptDocumentDto })
  document!: GateInReceiptDocumentDto;
}

export class GateInDetailDto extends GateInEntryDto {
  @ApiProperty({ type: [GateInDetailDocumentDto] })
  documents!: readonly GateInDetailDocumentDto[];

  @ApiProperty({ type: [GateInReceiptDto], description: 'The goods receipts linked to this visit, oldest first' })
  receipts!: readonly GateInReceiptDto[];
}

export class GateInDetailResponse {
  @ApiProperty({ type: GateInDetailDto })
  gateIn!: GateInDetailDto;
}

// ── the receipt link and the device snapshot ─────────────────────────────────

/** Why a receipt that named a gate-in booked unlinked (decision 5 — the link never refuses). */
export class GateInLinkDto {
  @ApiProperty({ enum: ['not-linked'] })
  status!: 'not-linked';

  @ApiProperty({ enum: [...GATE_IN_LINK_REASONS], description: '`unknown`: no such gate-in (or not a uuid); `other-warehouse`: it is another warehouse\'s' })
  reason!: (typeof GATE_IN_LINK_REASONS)[number];
}

export class CatalogOpenGateInDocumentDto {
  @ApiProperty({ enum: [...GATE_IN_DOCUMENT_KINDS] })
  kind!: string;

  @ApiProperty()
  number!: string;
}

/** Story 2-3a — one open gate-in of the device snapshot (decision 15). */
export class CatalogOpenGateInDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'GI-0001' })
  code!: string;

  @ApiProperty({ type: String, nullable: true })
  vehicleNo!: string | null;

  @ApiProperty()
  handDelivery!: boolean;

  @ApiProperty()
  transporterLabel!: string;

  @ApiProperty({ type: String, nullable: true })
  dockDoor!: string | null;

  @ApiProperty({ enum: ['gated_in', 'unloading', 'unloaded'] })
  status!: string;

  @ApiProperty({ enum: [...SEAL_STATUSES] })
  sealStatus!: string;

  // Decision 17 — no packagesDeclared: the dock counts blind.

  @ApiProperty({ type: String, nullable: true, description: 'ISO-8601 UTC, null until the unload started' })
  unloadStartedAt!: string | null;

  @ApiProperty({ type: [CatalogOpenGateInDocumentDto] })
  documents!: readonly CatalogOpenGateInDocumentDto[];
}
