/**
 * The channel order-writeback port (story 7.2, RD-7): the arm the writeback
 * delivery routes a relayed `order.packed` / `order.dispatched` /
 * `order.cancelled` event through — the fulfillment/dispatch/cancellation
 * statement TO the channel, via the same outbox-and-port machinery the
 * availability sync rides.
 *
 * Shape mirrors `channel-availability-port.ts` (the frozen providers register
 * `unconfiguredWritebackArm` — a typed verbatim 501 — until their real
 * transports land; shopify's real arm is `channel-shopify-port.ts`). The arm
 * is invoked AT-LEAST-ONCE by the relay: the read-back dedupe is
 * STATE-SPECIFIC and lives inside the arm (RD-7):
 *
 *   packed     — posts a fulfillment ONLY when the channel holds none;
 *   dispatched — the fulfillment WITHOUT tracking is UPDATED, tracking
 *                present acks (`noop`);
 *   cancelled  — the channel's order already cancelled acks; an uncancelled
 *                channel order is cancelled through the channel API.
 *
 * The echoes converge: a relay reordering that settles `dispatched` first
 * lands a fulfillment carrying tracking; the `packed` re-drain reads
 * fulfillment-present and acks. A channel-initiated cancellation echoes back
 * through `order.cancelled` and self-settles as one idempotent `cancelled`
 * read-back.
 *
 * This file imports only TYPES from `channel-registry.ts` (cycle-free).
 */
import { ProblemException } from '../../shared/problem-details/problem.exception';
import type { ChannelCredential } from './channel-credentials';

/** The fulfillment lifecycle states this port writes back to the channel. */
export type ChannelWritebackState = 'packed' | 'dispatched' | 'cancelled';

/**
 * The writeback request: the order's channel identity (`orderRef` — the
 * order's stored `externalEventId`) + the state + the identity lines. The
 * delivery builds this from a fresh order-row READ (RD-7 — never the
 * payload's word); `carrier`/`tracking` ride only `dispatched`.
 */
export interface ChannelOrderWritebackRequest {
  readonly tenantId: string;
  readonly integrationId: string;
  readonly provider: string;
  /** The channel's order reference — the ingested order's externalEventId. */
  readonly orderRef: string;
  readonly state: ChannelWritebackState;
  /** One line per order line, as the channel knows the items. */
  readonly lines: readonly {
    /** The channel-side SKU identifier (the mapping's externalRef). */
    readonly externalRef: string;
    /** Quantity in the channel-facing unit (base units). */
    readonly quantity: number;
  }[];
  /** Dispatched only — the carrier + tracking the dispatch stamped. */
  readonly carrier?: string | null;
  readonly tracking?: string | null;
}

/** What a writeback arm answers: the channel-side settle stamp + verdict. */
export interface ChannelOrderWritebackResult {
  /** The channel's settle instant (opaque; arms mint it). */
  readonly settledAt: string;
  /** What the arm did: applied, or a no-op through the read-back guard. */
  readonly action: 'created' | 'updated' | 'cancelled' | 'noop';
}

/**
 * One writeback arm. The credential is REQUEST-SCOPED plaintext under the
 * `openCredentialForAdapterUse` rules — never logged, never persisted,
 * never in any response or event.
 */
export type ChannelOrderWritebackArm = (
  credential: ChannelCredential,
  request: ChannelOrderWritebackRequest,
) => Promise<ChannelOrderWritebackResult>;

/** 501 `channel-transport-unconfigured` — the typed verbatim retryable refusal. */
export function channelWritebackUnconfigured(provider: string): ProblemException {
  return new ProblemException(
    'channel-transport-unconfigured',
    501,
    'Channel transport not configured',
    `Channel "${provider}" has no fulfillment-writeback transport on this deployment — its real integration has not been configured yet (story 7.2). Retry once it lands.`,
  );
}

/**
 * The writeback arm until a channel's real transport lands: a typed verbatim
 * refusal (501), the `unconfiguredAvailabilityArm` pattern — the delivery
 * meters the failure and RETHROWS (the relay retries; past budget the row
 * dead-letters). amazon-in/flipkart keep this verbatim (RD-6).
 */
export function unconfiguredWritebackArm(provider: string): ChannelOrderWritebackArm {
  return async (): Promise<ChannelOrderWritebackResult> => {
    throw channelWritebackUnconfigured(provider);
  };
}

/**
 * Deterministic in-process stand-in arm (the `testAvailabilityArm` shape):
 * NOT registered on any frozen channel — the suites register a test adapter
 * with it. The channel's fulfillment state is modeled in the closure over a
 * shared mutable record so the state-specific read-back guards,
 * the reordering convergence and the echo settle are testable end-to-end.
 * Keyed by the order ref — the read-back guard's ledger.
 */
export interface TestChannelOrderState {
  /** The fulfillment the channel holds for the order, if any. */
  readonly fulfillments: Map<
    string,
    { readonly withTracking: boolean; readonly carrier: string | null; readonly tracking: string | null }
  >;
  /** Whether the channel has cancelled the order (the read-back for `cancelled`). */
  cancelled: boolean;
}

export function testWritebackArm(
  states: Map<string, TestChannelOrderState>,
): ChannelOrderWritebackArm {
  return async (_credential, request) => {
    const state = states.get(request.orderRef) ?? {
      fulfillments: new Map(),
      cancelled: false,
    };
    states.set(request.orderRef, state);
    const settledAt = new Date().toISOString();
    switch (request.state) {
      case 'packed': {
        // RD-7: packed posts ONLY when no fulfillment exists.
        if (state.fulfillments.size > 0 || state.cancelled) {
          return { settledAt, action: 'noop' };
        }
        state.fulfillments.set('test-fulfillment', {
          withTracking: false,
          carrier: null,
          tracking: null,
        });
        return { settledAt, action: 'created' };
      }
      case 'dispatched': {
        const untracked = [...state.fulfillments.values()].find((f) => !f.withTracking);
        if (state.fulfillments.size > 0 && untracked === undefined) {
          return { settledAt, action: 'noop' }; // tracking already present
        }
        if (untracked !== undefined) {
          state.fulfillments.set('test-fulfillment', {
            withTracking: true,
            carrier: request.carrier ?? null,
            tracking: request.tracking ?? null,
          });
          return { settledAt, action: 'updated' };
        }
        // No fulfillment at all: the packed arm never ran (relay reordering)
        // — create ONE fulfillment carrying the tracking (convergence).
        state.fulfillments.set('test-fulfillment', {
          withTracking: true,
          carrier: request.carrier ?? null,
          tracking: request.tracking ?? null,
        });
        return { settledAt, action: 'created' };
      }
      case 'cancelled': {
        if (state.cancelled) {
          return { settledAt, action: 'noop' };
        }
        state.cancelled = true;
        return { settledAt, action: 'cancelled' };
      }
    }
  };
}