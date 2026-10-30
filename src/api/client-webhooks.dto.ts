import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { IsInstant } from '../shared/primitives/instant-range';
import {
  WEBHOOK_BULK_REDELIVER_STATUSES,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_DESCRIPTION_MAX_LENGTH,
  WEBHOOK_DISABLED_REASONS,
  WEBHOOK_ENDPOINT_STATUSES,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_HELD_DECISIONS,
  WEBHOOK_URL_MAX_LENGTH,
  type WebhookBulkRedeliverStatus,
  type WebhookDeliveryStatus,
  type WebhookDisabledReason,
  type WebhookEndpointStatus,
  type WebhookEventType,
  type WebhookHeldDecision,
} from '../modules/client-webhooks/webhook-rules';
import { WEBHOOK_DELIVERY_PAGE_MAX } from '../modules/client-webhooks/client-webhooks.facade';

// ── requests ─────────────────────────────────────────────────────────────

/** Story 5-2a — add a webhook endpoint for a client (owner-only). */
export class CreateWebhookEndpointDto {
  @ApiProperty({
    example: 'https://hooks.acme.example/wms',
    maxLength: WEBHOOK_URL_MAX_LENGTH,
    description:
      'An https URL with a public DNS host (no IP literal, no localhost / .local / .internal / .home.arpa), port 443 or 1024–65535, no user name or #fragment. Stored normalised (lower-case host, default port dropped)',
  })
  @IsString()
  @MaxLength(WEBHOOK_URL_MAX_LENGTH + 64)
  url!: string;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: WEBHOOK_DESCRIPTION_MAX_LENGTH, description: 'What the endpoint is for (blank for none)' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(WEBHOOK_DESCRIPTION_MAX_LENGTH + 64)
  description?: string | null;

  @ApiProperty({ enum: [...WEBHOOK_EVENT_TYPES], isArray: true, description: 'The event types it receives — at least one, none twice' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length)
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  eventTypes!: WebhookEventType[];
}

/** Story 5-2a — edit an endpoint: an absent field is unchanged. */
export class UpdateWebhookEndpointDto {
  @ApiProperty({ required: false, maxLength: WEBHOOK_URL_MAX_LENGTH, description: 'A new URL (the same rules as on create); resets the failure counters' })
  @IsOptional()
  @IsString()
  @MaxLength(WEBHOOK_URL_MAX_LENGTH + 64)
  url?: string;

  @ApiProperty({ required: false, nullable: true, type: String, maxLength: WEBHOOK_DESCRIPTION_MAX_LENGTH })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(WEBHOOK_DESCRIPTION_MAX_LENGTH + 64)
  description?: string | null;

  @ApiProperty({ required: false, enum: [...WEBHOOK_EVENT_TYPES], isArray: true, description: 'Narrowing fails the dropped types’ pending and held deliveries (`unsubscribed`)' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length)
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  eventTypes?: WebhookEventType[];

  @ApiProperty({ required: false, enum: ['active', 'disabled'], description: '`disabled` — by staff (its pending and held deliveries fail); `active` — re-enable (counters cleared)' })
  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @ApiProperty({
    required: false,
    enum: [...WEBHOOK_HELD_DECISIONS],
    description: 'Required when re-enabling an endpoint that holds deliveries: `release` sends them, `discard` fails them',
  })
  @IsOptional()
  @IsIn(WEBHOOK_HELD_DECISIONS)
  held?: WebhookHeldDecision;
}

export class RotateWebhookSecretDto {
  @ApiProperty({ required: false, description: 'true — the old secret stops signing now (no 24-hour overlap)' })
  @IsOptional()
  @IsBoolean()
  revokePrevious?: boolean;
}

export class BulkRedeliverWebhooksDto {
  @ApiProperty({ format: 'date-time', description: 'Deliveries created at or after this instant' })
  @IsInstant()
  since!: string;

  @ApiProperty({ required: false, enum: [...WEBHOOK_BULK_REDELIVER_STATUSES], isArray: true, description: '`failed` — every failed delivery (the default); `expired` — only those that expired undelivered' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(WEBHOOK_BULK_REDELIVER_STATUSES, { each: true })
  statuses?: WebhookBulkRedeliverStatus[];
}

export class WebhookDeliveryListQuery {
  @ApiProperty({ required: false, description: 'The previous page’s nextCursor' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: WEBHOOK_DELIVERY_PAGE_MAX, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(WEBHOOK_DELIVERY_PAGE_MAX)
  limit?: number;

  @ApiProperty({ required: false, enum: [...WEBHOOK_DELIVERY_STATUSES] })
  @IsOptional()
  @IsIn(WEBHOOK_DELIVERY_STATUSES)
  status?: WebhookDeliveryStatus;
}

// ── responses ────────────────────────────────────────────────────────────

export class WebhookEndpointDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: [...WEBHOOK_EVENT_TYPES], isArray: true }) eventTypes!: WebhookEventType[];
  @ApiProperty({ enum: [...WEBHOOK_ENDPOINT_STATUSES] }) status!: WebhookEndpointStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: [...WEBHOOK_DISABLED_REASONS, null],
    description: '`manual` — by staff; `failing` — ten final failures over 24 h (deliveries held); `gone` — the receiver answered 410; `client-departed`',
  })
  disabledReason!: WebhookDisabledReason | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) disabledAt!: string | null;
  @ApiProperty({ enum: [1] }) schemaVersion!: number;
  @ApiProperty({ description: 'The signing secret’s last four characters (the secret itself is shown once)' }) secretHint!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'When the previous secret stops signing (a rotation’s overlap)' })
  previousSecretExpiresAt!: string | null;
  @ApiProperty({ description: 'Consecutive FINAL delivery failures (reset by any success)' }) consecutiveFailures!: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) failingSince!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastSuccessAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class WebhookEndpointListEntryDto extends WebhookEndpointDto {
  @ApiProperty({ description: 'Deliveries held while the endpoint was failing' }) heldCount!: number;
}

export class WebhookEndpointListResponse {
  @ApiProperty({ type: [WebhookEndpointListEntryDto], description: 'Oldest first; deleted endpoints are not listed' })
  items!: WebhookEndpointListEntryDto[];
  @ApiProperty({ enum: ['webhooks-unavailable'], isArray: true, description: '`webhooks-unavailable` — sending is off on this server (deliveries are paused)' })
  warnings!: 'webhooks-unavailable'[];
}

export class WebhookEndpointResponse {
  @ApiProperty({ type: WebhookEndpointDto }) endpoint!: WebhookEndpointDto;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The raw `whsec_…` signing secret — ONLY in the response to a fresh create or rotate; null on every replay and every other write. It is never shown again: rotate to get a new one',
  })
  signingSecret!: string | null;
  @ApiProperty({ required: false, description: 'A re-enable: the held deliveries released to send' }) heldReleased?: number;
  @ApiProperty({ required: false, description: 'A re-enable: the held deliveries discarded' }) heldDiscarded?: number;
  @ApiProperty({ enum: ['webhooks-unavailable'], isArray: true }) warnings!: 'webhooks-unavailable'[];
}

export class WebhookTestResultDto {
  @ApiProperty({ type: Number, nullable: true, description: 'The receiver’s HTTP status; null when no response came back' }) statusCode!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null on a 2xx; else `http-<status>`, or `network`, `timeout`, `dns-failed`, `tls-handshake`, `tls-cert`, `target-blocked`, `secret-unavailable`',
  })
  errorCode!: string | null;
  @ApiProperty() durationMs!: number;
}

export class WebhookTestResponse {
  @ApiProperty({ type: WebhookTestResultDto }) test!: WebhookTestResultDto;
  @ApiProperty({ enum: ['webhooks-unavailable'], isArray: true }) warnings!: 'webhooks-unavailable'[];
}

export class WebhookDeliveryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) endpointId!: string;
  @ApiProperty({ format: 'uuid', description: 'The webhook event id — the `webhook-id` header and the body’s `id`' }) eventId!: string;
  @ApiProperty({ enum: [...WEBHOOK_EVENT_TYPES] }) eventType!: WebhookEventType;
  @ApiProperty({ format: 'uuid', description: 'The receipt (GRN) id, the order id, or (order.delivered) an id derived from the consignment id and its deliverySeq — stable per recorded version, stored on no row (the body’s orderId names the order)' }) subjectId!: string;
  @ApiProperty({ enum: [...WEBHOOK_DELIVERY_STATUSES] }) status!: WebhookDeliveryStatus;
  @ApiProperty() attempts!: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'A pending delivery’s next try' }) nextAttemptAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastAttemptAt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) lastStatusCode!: number | null;
  @ApiProperty({ type: String, nullable: true, description: 'A bounded code (`http-500`, `timeout`, `expired`, …) — never a message' }) lastErrorCode!: string | null;
  @ApiProperty({ type: Number, nullable: true }) lastDurationMs!: number | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) succeededAt!: string | null;
  @ApiProperty() redeliveryCount!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class WebhookDeliveryListResponse {
  @ApiProperty({ type: [WebhookDeliveryDto], description: 'Newest first' }) items!: WebhookDeliveryDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class WebhookDeliveryDetailDto extends WebhookDeliveryDto {
  @ApiProperty({ description: 'The exact JSON body every attempt sends' }) body!: string;
}

export class WebhookDeliveryDetailResponse {
  @ApiProperty({ type: WebhookDeliveryDetailDto }) delivery!: WebhookDeliveryDetailDto;
}

export class WebhookRedeliverResponse {
  @ApiProperty({ type: WebhookDeliveryDto }) delivery!: WebhookDeliveryDto;
}

export class WebhookBulkRedeliverResponse {
  @ApiProperty({ description: 'Deliveries put back to pending (at most 1000)' }) redelivered!: number;
  @ApiProperty({ description: 'Matching failed deliveries still left — call again to continue' }) remaining!: number;
}
