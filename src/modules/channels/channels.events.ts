/**
 * The channels module's domain events (story 7.1). One event type today:
 * the availability publication the sync worker appends through the
 * transactional outbox and the outbox relay delivers to the channels
 * module's delivery handler (AD-7).
 */

/** The outbox event type carrying one full per-connection availability snapshot. */
export const CHANNEL_AVAILABILITY_PUBLISHED_EVENT = 'channel.availability.published';

/** One published scope: the inventory core's computed visible quantity (RN-6). */
import type { ChannelAvailabilityScope } from './channel-availability-port';

/** The publication's scope shape — the port's scope verbatim (no duplicate vocabulary). */
export type PublishedScope = ChannelAvailabilityScope;

/** The publication payload — ids and quantities, never a secret. */
export interface ChannelAvailabilityPublication {
  readonly connectionId: string;
  readonly provider: string;
  readonly scopes: readonly PublishedScope[];
  readonly publishedAt: string;
}
/**
 * Story 9-2 — the sync-health EPISODE events (the notification panel's
 * channel-sync source). `degraded` is appended on the breaker's
 * closed → open transition (never half-open → open: the episode is still
 * the same one) and mints the episode id stored on
 * `integrations.sync_episode_id`; `recovered` is appended when the breaker
 * closes again (`reason: 'recovered'`) or when the connection is
 * disconnected while an episode is open (`reason: 'disconnected'`), and
 * clears it. Lag-based health is NOT a trigger. Payloads carry ids only.
 */
export const CHANNEL_SYNC_DEGRADED_EVENT = 'channel.sync.degraded';
export const CHANNEL_SYNC_RECOVERED_EVENT = 'channel.sync.recovered';

/** Why an episode closed. */
export type ChannelSyncRecoveredReason = 'recovered' | 'disconnected';
