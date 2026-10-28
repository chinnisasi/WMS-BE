import type { WebhookDeliveryRow, WebhookEndpointRow } from '../../shared/db/schema';
import { canonicalInstant } from '../../shared/primitives/time';
import type { WebhookDeliveryStatus, WebhookDisabledReason, WebhookEndpointStatus, WebhookEventType } from './webhook-rules';

/**
 * Story 5-2a — the read shapes, built key by key from the rows. The sealed
 * secrets never appear: only `secretHint` (the last four characters) and
 * when the previous secret stops signing.
 */
export interface WebhookEndpointView {
  readonly id: string;
  readonly clientId: string;
  readonly url: string;
  readonly description: string | null;
  readonly eventTypes: readonly WebhookEventType[];
  readonly status: WebhookEndpointStatus;
  readonly disabledReason: WebhookDisabledReason | null;
  readonly disabledAt: string | null;
  readonly schemaVersion: number;
  readonly secretHint: string;
  readonly previousSecretExpiresAt: string | null;
  readonly consecutiveFailures: number;
  readonly failingSince: string | null;
  readonly lastSuccessAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const instant = (value: string | null): string | null => (value === null ? null : canonicalInstant(value));

export function toEndpointView(row: WebhookEndpointRow): WebhookEndpointView {
  return {
    id: row.id,
    clientId: row.clientId,
    url: row.url,
    description: row.description,
    eventTypes: [...row.eventTypes] as WebhookEventType[],
    status: row.status as WebhookEndpointStatus,
    disabledReason: row.disabledReason as WebhookDisabledReason | null,
    disabledAt: instant(row.disabledAt),
    schemaVersion: row.schemaVersion,
    secretHint: row.secretHint,
    previousSecretExpiresAt: instant(row.previousSecretExpiresAt),
    consecutiveFailures: row.consecutiveFailures,
    failingSince: instant(row.failingSince),
    lastSuccessAt: instant(row.lastSuccessAt),
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

export interface WebhookDeliveryView {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: WebhookEventType;
  readonly subjectId: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastStatusCode: number | null;
  readonly lastErrorCode: string | null;
  readonly lastDurationMs: number | null;
  readonly succeededAt: string | null;
  readonly redeliveryCount: number;
  readonly createdAt: string;
}

export function toDeliveryView(row: WebhookDeliveryRow, event: { eventType: string; subjectId: string }): WebhookDeliveryView {
  const status = row.status as WebhookDeliveryStatus;
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: event.eventType as WebhookEventType,
    subjectId: event.subjectId,
    status,
    attempts: row.attempts,
    // Only a row that will be tried again has a next attempt.
    nextAttemptAt: status === 'pending' ? canonicalInstant(row.nextAttemptAt) : null,
    lastAttemptAt: instant(row.lastAttemptAt),
    lastStatusCode: row.lastStatusCode,
    lastErrorCode: row.lastErrorCode,
    lastDurationMs: row.lastDurationMs,
    succeededAt: instant(row.succeededAt),
    redeliveryCount: row.redeliveryCount,
    createdAt: canonicalInstant(row.createdAt),
  };
}
