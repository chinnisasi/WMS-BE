import { integrations } from '../../shared/db/schema';
import type { Integration } from '../../shared/db/schema';
import { canonicalInstant } from '../../shared/primitives/time';
import { requireChannelAdapterOrNull } from './channel-registry';

/**
 * The channels module's wire shapes + the read-side projections (story
 * 7.1). One file so the command service, the facade and the delivery
 * handler share the public face WITHOUT importing each other (no cycle):
 * **the sealed credential column appears in NO shape here.**
 */

/** The connection's public face — the ONLY shape that leaves this module. */
export interface ChannelConnectionView {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: string;
  /** The registry's display name, resolved at read time (never stored). */
  readonly providerName: string;
  readonly status: string;
  readonly backorderPolicy: string;
  /** RD-4 — the one ingest warehouse (null until the config PUT sets it). */
  readonly ingestWarehouseId: string | null;
  readonly credentialVersion: number;
  readonly connectedBy: string;
  readonly rotatedAt: string | null;
  readonly rotatedBy: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly lastError: string | null;
  readonly breakerState: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectionBufferRow {
  readonly warehouseId: string;
  readonly skuId: string;
  readonly bufferMilli: number;
}

export interface ChannelConnectionListEntry {
  readonly id: string;
  readonly provider: string;
  readonly providerName: string;
  readonly status: string;
  readonly backorderPolicy: string;
  readonly ingestWarehouseId: string | null;
  readonly credentialVersion: number;
  readonly health: 'ok' | 'degraded' | 'error';
  readonly lastSyncedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastError: string | null;
  readonly syncLagMs: number | null;
  readonly breakerState: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The connection's standing buffers (the editor rows, arm 4). */
  readonly buffers: readonly ConnectionBufferRow[];
  /** How many external references are mapped to this connection. */
  readonly mappingCount: number;
}

/** One per-item verdict from the buffers command (the arm-5 response shape). */
export interface ChannelBufferVerdict {
  readonly index: number;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly status: 'applied' | 'unchanged' | 'refused';
  /** The item's target — the request's own number, echoed for the surface. */
  readonly bufferMilli: number;
  /** The buffer standing after the verdict (the OLD one on a refusal). */
  readonly standingMilli: number;
  /** The refusal arm's machine code — the per-item 409's reason. */
  readonly code?: 'buffer-over-ceiling';
  readonly detail?: string;
}

export interface SetConnectionBuffersResult {
  readonly connectionId: string;
  readonly verdicts: readonly ChannelBufferVerdict[];
}

/** The select list every read of this table uses — the sealed blob is absent. */
export const CONNECTION_COLUMNS = {
  id: integrations.id,
  tenantId: integrations.tenantId,
  provider: integrations.provider,
  status: integrations.status,
  backorderPolicy: integrations.backorderPolicy,
  ingestWarehouseId: integrations.ingestWarehouseId,
  credentialVersion: integrations.credentialVersion,
  connectedBy: integrations.connectedBy,
  rotatedAt: integrations.rotatedAt,
  rotatedBy: integrations.rotatedBy,
  lastAttemptAt: integrations.lastAttemptAt,
  lastSyncedAt: integrations.lastSyncedAt,
  lastError: integrations.lastError,
  consecutiveFailures: integrations.consecutiveFailures,
  breakerState: integrations.breakerState,
  createdAt: integrations.createdAt,
  updatedAt: integrations.updatedAt,
} as const;

/** The stored row's public projection (the carriers `toConnectionView` shape). */
export function toConnectionView(row: Omit<Integration, 'credentialSealed'>): ChannelConnectionView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    provider: row.provider,
    // A row whose adapter was de-registered still lists — the code is the
    // truth, the name is a convenience (the carriers rule).
    providerName: requireChannelAdapterOrNull(row.provider)?.displayName ?? row.provider,
    status: row.status,
    backorderPolicy: row.backorderPolicy,
    ingestWarehouseId: row.ingestWarehouseId,
    credentialVersion: row.credentialVersion,
    connectedBy: row.connectedBy,
    rotatedAt: row.rotatedAt === null ? null : canonicalInstant(row.rotatedAt),
    rotatedBy: row.rotatedBy,
    lastAttemptAt: row.lastAttemptAt === null ? null : canonicalInstant(row.lastAttemptAt),
    lastSyncedAt: row.lastSyncedAt === null ? null : canonicalInstant(row.lastSyncedAt),
    lastError: row.lastError,
    breakerState: row.breakerState,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

/**
 * The breaker's consecutive-failure threshold (RN-5 — "a const threshold,
 * e.g. 5"). On the Nth consecutive delivery failure the connection's
 * breaker opens and refuses further publishes until the manual `retry`
 * half-opens it.
 */
export const BREAKER_FAILURE_THRESHOLD = 5;

/**
 * The health-lag SLO (60s, the epic's p95 publish-latency bound): a
 * connection whose last successful publish is older than this degrades.
 */
export const SYNC_HEALTH_SLO_MS = 60_000;

/**
 * The health read (arm 4): `error` = the breaker is open; `degraded` = the
 * breaker is half-open, the last delivery failed, or the lag exceeds the
 * SLO (or no publish ever succeeded); `ok` otherwise. Lag = now −
 * lastSyncedAt (null when nothing ever published).
 */
export function connectionHealth(row: {
  breakerState: string;
  lastError: string | null;
  lastSyncedAt: string | null;
}): { health: 'ok' | 'degraded' | 'error'; syncLagMs: number | null } {
  if (row.breakerState === 'open') {
    return { health: 'error', syncLagMs: lagMs(row.lastSyncedAt) };
  }
  const lag = lagMs(row.lastSyncedAt);
  if (row.breakerState === 'half-open' || row.lastError !== null || lag === null || lag > SYNC_HEALTH_SLO_MS) {
    return { health: 'degraded', syncLagMs: lag };
  }
  return { health: 'ok', syncLagMs: lag };
}

/** The lag in milliseconds from a sync stamp, or null when nothing synced yet. */
function lagMs(lastSyncedAt: string | null): number | null {
  if (lastSyncedAt === null) {
    return null;
  }
  return Math.max(0, Date.now() - Date.parse(lastSyncedAt));
}