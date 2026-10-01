/**
 * The channel adapter registry (story 7.1) — the declarative half of the
 * channel substrate, the `carrier-registry` pattern rung by the frozen
 * provider set: **which sales channels can a tenant sell through, and what
 * does each one need to be configured with.** Shopify, Amazon.in and
 * Flipkart are the three frozen channels (story 7.1's intent; the planning
 * fallback "Shopify first, marketplaces fast-follow" is a launch-order
 * fact, not a schema fact — all three register).
 *
 * The registry is an import-time `Map` populated by
 * `registerChannelAdapter` (throwing on a duplicate code), the
 * `ledger-registry`/`carrier-registry` convention for a fixed set of named
 * arms — and ADDITIVE: a new channel is one registration and no migration.
 *
 * The arms (this file's runtime edge) live in `channel-availability-port.ts`
 * and are registered type-only here, so the import graph stays cycle-free
 * in the same direction the carriers pair reads.
 */

// Runtime edge from the port file: the arms every registration below wires.
// Type-only in the reverse direction (channel-availability-port.ts imports
// only types from here).
import {
  unconfiguredAvailabilityArm,
  unconfiguredRevokeArm,
} from './channel-availability-port';
import type {
  ChannelAvailabilityArm,
  ChannelRevokeArm,
} from './channel-availability-port';

/** One credential field a channel declares it needs to be configured with. */
export interface ChannelCredentialField {
  /** The wire name inside the `credentials` object (camelCase). */
  readonly name: string;
  /** Human label for the surface's connect form. */
  readonly label: string;
  /** A required field absent (or blank) at connect/rotate is a 400. */
  readonly required: boolean;
  /** What the operator should paste here. */
  readonly description: string;
}

/** The channel port: identity + credential requirements + the two arms. */
export interface ChannelAdapter {
  /** Stable machine code — the `integrations.provider` value. */
  readonly code: string;
  /** Human name for the catalogue and for refusal messages. */
  readonly displayName: string;
  /** What this channel's account needs. Declaration order is wire order. */
  readonly credentialFields: readonly ChannelCredentialField[];
  /**
   * The availability delivery arm (story 7.1): the sync's published
   * snapshot, once through the transactional outbox's at-least-once relay.
   * The three channels register `unconfiguredAvailabilityArm` — a typed
   * verbatim 501 — until their real transports land (7.2).
   */
  readonly availabilityArm: ChannelAvailabilityArm;
  /**
   * The credential-revocation arm (the disconnect verb's port attempt,
   * logged and NOT blocking): unconfigured arms answer `unconfigured` and
   * the disconnect proceeds — a channel API being unreachable never keeps
   * secret material alive.
   */
  readonly revokeArm: ChannelRevokeArm;
}

const registry = new Map<string, ChannelAdapter>();

/** Registers one channel adapter; a duplicate code is a boot error. */
export function registerChannelAdapter(adapter: ChannelAdapter): void {
  if (registry.has(adapter.code)) {
    throw new Error(`A channel adapter with code "${adapter.code}" is already registered`);
  }
  registry.set(adapter.code, adapter);
}

/** The adapter for one provider code, or undefined when the code is unknown. */
export function channelAdapter(code: string): ChannelAdapter | undefined {
  return registry.get(code);
}

/** The adapter for one provider code, or NULL — the caller maps a miss to 400. */
export function requireChannelAdapterOrNull(code: string): ChannelAdapter | null {
  return registry.get(code) ?? null;
}

/** Every registered adapter (the catalogue read). */
export function registeredChannelAdapters(): ChannelAdapter[] {
  return [...registry.values()];
}

/** The known provider codes (the 400's wording rides it). */
export function knownChannelProviderCodes(): string[] {
  return registeredChannelAdapters().map((adapter) => adapter.code);
}

const SHOP_DOMAIN_FIELD: ChannelCredentialField = {
  name: 'shopDomain',
  label: 'Store domain',
  required: true,
  description: 'The *.myshopify.com store domain the API is called against.',
};

registerChannelAdapter({
  code: 'shopify',
  displayName: 'Shopify',
  credentialFields: [
    SHOP_DOMAIN_FIELD,
    {
      name: 'accessToken',
      label: 'Admin API access token',
      required: true,
      description: 'The Admin API access token minted for this app by the store owner.',
    },
    {
      name: 'apiVersion',
      label: 'Admin API version',
      required: false,
      description: 'Optional Admin API version pin (e.g. 2026-01); the adapter default applies when absent.',
    },
  ],
  availabilityArm: unconfiguredAvailabilityArm('shopify'),
  revokeArm: unconfiguredRevokeArm('shopify'),
});

registerChannelAdapter({
  code: 'amazon-in',
  displayName: 'Amazon.in',
  credentialFields: [
    {
      name: 'sellerId',
      label: 'Seller id',
      required: true,
      description: 'The Selling Partner account\'s seller identifier.',
    },
    {
      name: 'refreshToken',
      label: 'SP-API refresh token',
      required: true,
      description: 'The Selling Partner API refresh token minted at app authorization.',
    },
    {
      name: 'marketplaceId',
      label: 'Marketplace id',
      required: false,
      description: 'Optional marketplace pin (India when absent).',
    },
  ],
  availabilityArm: unconfiguredAvailabilityArm('amazon-in'),
  revokeArm: unconfiguredRevokeArm('amazon-in'),
});

registerChannelAdapter({
  code: 'flipkart',
  displayName: 'Flipkart',
  credentialFields: [
    {
      name: 'appId',
      label: 'Application id',
      required: true,
      description: 'The marketplace seller app\'s application identifier.',
    },
    {
      name: 'appSecret',
      label: 'Application secret',
      required: true,
      description: 'The marketplace seller app\'s secret material.',
    },
    {
      name: 'sellerId',
      label: 'Seller id',
      required: false,
      description: 'Optional seller identifier pin.',
    },
  ],
  availabilityArm: unconfiguredAvailabilityArm('flipkart'),
  revokeArm: unconfiguredRevokeArm('flipkart'),
});