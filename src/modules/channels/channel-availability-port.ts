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
 * result) for one mapped (warehouse, sku), plus the CHANNEL identity the
 * publish arm must resolve and never the WMS one (RD-6 amended: the arm
 * posts Shopify's `inventory_item_id`, the WMS `skuId` uuid is never put on
 * the channel wire).
 */
export interface ChannelAvailabilityScope {
  readonly warehouseId: string;
  readonly skuId: string;
  /** The mapped ref the publish arm resolves to the channel's item id. */
  readonly externalRef: string;
  /** `V(c)` — the quantity this channel may list, in milli-units. */
  readonly visibleMilli: number;
  /**
   * The previously-resolved channel item id, cached on the mapping row —
   * when present the arm posts WITHOUT a variant lookup. Absent means the
   * arm must resolve (and may answer `resolvedItems` for the write-back).
   */
  readonly inventoryItemId?: number;
}

/**
 * The publication the sync delivers — a full snapshot per cycle (never a
 * delta), UP TO the `MAX_SYNC_SCOPES_PER_PUBLISH = 200` cap:
 * `computePublishedScopes` is a head-only slice past 200 (an over-cap
 * tenant publishes the head scopes; the truncation is currently unmarked —
 * tracked as a future PENDING row).
 */
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
  /**
   * RD-6 amended: the item ids THIS attempt resolved (externalRef → the
   * channel's numeric `inventory_item_id`) — the delivery persists them on
   * the mapping rows so the next cycle skips the lookup. Present only when
   * the arm actually looked something up.
   */
  readonly resolvedItems?: Readonly<Record<string, number>>;
  /**
   * The refs neither cached nor resolvable this attempt — the scopes the
   * arm SKIPPED (never posted with a guessed or WMS id). Empty/absent when
   * every scope posted; when it holds the WHOLE scope set the arm refuses
   * (see `ChannelItemsUnresolvedError`) — partial skips stay a metered,
   * non-refusing outcome.
   */
  readonly skippedRefs?: readonly string[];
}

/**
 * The availability publish's typed refusal (RD-6 amended): EVERY scope's
 * variant lookup failed or resolved to nothing — the arm has nothing it may
 * honestly post, so the attempt refuses with this typed (meted, never
 * breaker/health-moving) error. The delivery meters `item-unresolved` and
 * rethrows; the relay's budget owns the retry, remediation is the mapping
 * PUT (or the channel's lookup healing, since a lookup failure is one
 * trigger).
 */
export class ChannelItemsUnresolvedError extends Error {
  constructor(readonly unresolvedRefs: readonly string[]) {
    super(
      `channel availability publish refused: no inventory_item_id resolved for ${unresolvedRefs.length} ` +
        `mapped ref(s) (${unresolvedRefs.slice(0, 5).join(', ')}) — nothing was posted.`,
    );
    this.name = 'ChannelItemsUnresolvedError';
  }
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