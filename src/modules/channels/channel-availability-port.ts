/**
 * The channel availability port (story 7.1) — the adapter-port pattern of
 * `carrier-label-port.ts`: the arms the sync's publication rides and the
 * credential-revocation attempt the disconnect verb makes, registered per
 * channel adapter. THIS STORY MAKES NO NETWORK CALLS: the three frozen
 * channels register `unconfiguredAvailabilityArm` — a typed, verbatim,
 * retryable 501 `channel-transport-unconfigured` — until their real
 * transports land with the launch story (7.2, webhooks + writeback).
 *
 * Delivery shape: the sync worker appends one
 * `channel.availability.published` outbox row per (connection, cycle); the
 * outbox relay publishes it through the event bus; the channels module's
 * delivery handler routes it HERE — at-least-once, so an arm may be invoked
 * more than once per cycle and must tolerate a repeat (a publish is a full
 * snapshot, naturally idempotent at the consumer side). An arm failure (a
 * 501 among them) is a retriable delivery: the relay re-drains with
 * backoff, and past the 5-attempt budget the row dead-letters.
 *
 * This file imports only TYPES from `channel-registry.ts` — the registry
 * imports THIS file's arm functions, so the import graph stays cycle-free
 * at runtime exactly like the carriers pair.
 */
import type { ChannelCredential } from './channel-credentials';
import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * One published scope: the inventory core's computed visible quantity
 * (RN-6 — the core performed the buffer math; this port only carries the
 * result) for one mapped (warehouse, sku).
 */
export interface ChannelAvailabilityScope {
  readonly warehouseId: string;
  readonly skuId: string;
  /** `V(c)` — the quantity this channel may list, in milli-units. */
  readonly visibleMilli: number;
}

/** The publication the sync delivers — a FULL snapshot per cycle, never a delta. */
export interface ChannelAvailabilityRequest {
  readonly tenantId: string;
  /** The integration (connection) the snapshot is for. */
  readonly integrationId: string;
  readonly provider: string;
  /** The mapped scopes and their visible quantities (empty never arrives — a connection with no mappings publishes nothing). */
  readonly scopes: readonly ChannelAvailabilityScope[];
  /** Business time the snapshot was computed (RFC-3339 UTC). */
  readonly publishedAt: string;
}

/** What an availability arm answers: the channel's own reception stamp. */
export interface ChannelAvailabilityResult {
  /** The channel-side accepted-at instant (opaque; arms mint it). */
  readonly acceptedAt: string;
}

/**
 * One availability arm. The credential is REQUEST-SCOPED plaintext under
 * the `openCredentialForAdapterUse` rules (the carriers module's): never
 * logged, never persisted, never in any response or event — the arm
 * consumes it in-process and it dies with the request.
 */
export type ChannelAvailabilityArm = (
  credential: ChannelCredential,
  request: ChannelAvailabilityRequest,
) => Promise<ChannelAvailabilityResult>;

/** What an availability arm answers... the revocation attempt's verdict. */
export type ChannelRevokeVerdict = 'revoked' | 'unconfigured';

/**
 * The disconnect verb's credential-revocation attempt (a port attempt,
 * logged and NOT blocking — the boundary note in the connection matrix).
 * A channel that never answers keeps no say in the disconnect: credential
 * deletion is a local, atomic act (AD-15).
 */
export type ChannelRevokeArm = (args: {
  readonly tenantId: string;
  readonly integrationId: string;
  readonly provider: string;
  readonly credential: ChannelCredential;
}) => Promise<{ readonly status: ChannelRevokeVerdict }>;

/** 501 `channel-transport-unconfigured` — the typed, verbatim retryable refusal. */
export function channelTransportUnconfigured(provider: string): ProblemException {
  return new ProblemException(
    'channel-transport-unconfigured',
    501,
    'Channel transport not configured',
    `Channel "${provider}" has no availability transport on this deployment — its real integration has not ` +
      `been configured yet (story 7.2). Retry once it lands.`,
  );
}

/**
 * The three channels' availability arm until their real transports land: a
 * typed verbatim refusal (501 `channel-transport-unconfigured`), the
 * `unconfiguredLabelArm` pattern. Nothing is written anywhere; the relay's
 * retry budget (and the connection's health read) carries the fact.
 */
export function unconfiguredAvailabilityArm(provider: string): ChannelAvailabilityArm {
  return async (): Promise<ChannelAvailabilityResult> => {
    throw channelTransportUnconfigured(provider);
  };
}

/**
 * The channels' revoke arm until real transports land: an HONEST
 * no-op — the attempt is answered locally as `unconfigured` (the caller
 * meters and logs it, and the disconnect proceeds). It does NOT throw: a
 * revocation that never happened must not be reported as failed delivery.
 */
export function unconfiguredRevokeArm(provider: string): ChannelRevokeArm {
  return async (): Promise<{ status: ChannelRevokeVerdict }> => {
    // No transport, nothing to revoke — the honest verdict the disconnect
    // verb logs (and meters) before it proceeds.
    void provider;
    return { status: 'unconfigured' };
  };
}

/**
 * Deterministic in-process stand-in arm (the `sandbox` carrier precedent):
 * NOT registered on any frozen channel today — available for tests that
 * need a delivery that actually answers. sha256 over the request's
 * canonical form yields the accepted-at stamp, so the same request always
 * answers identically.
 */
export function testAvailabilityArm(): ChannelAvailabilityArm {
  return async (_credential, request) => {
    const acceptedAt = request.publishedAt;
    return { acceptedAt };
  };
}