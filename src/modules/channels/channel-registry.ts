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
 * arms — and ADDITIVE at the registry itself: a new channel is one
 * registration here, plus the FE credential-field mirror and a migration
 * widening the `integrations.provider` CHECK's IN-list (that migration is
 * not optional — see `docs/design/modules/channels.md`).
 *
 * The arms (this file's runtime edge) live in `channel-availability-port.ts`
 * and are registered type-only here, so the import graph stays cycle-free
 * in the same direction the carriers pair reads.
 */

// Runtime edge from the port files: the arms every registration below wires.
// Type-only in the reverse direction (the port files import only types from
// here).
import type { AddressInput } from '../../shared/primitives/address';
import {
  shopifyAvailabilityArm,
  shopifyOrderWritebackArm,
  shopifyParseCancellation,
  shopifyParseOrder,
  shopifyRevokeArm,
} from './channel-shopify-port';
import { unconfiguredAvailabilityArm, unconfiguredRevokeArm } from './channel-availability-port';
import { unconfiguredWritebackArm } from './channel-writeback-port';
import type {
  ChannelAvailabilityArm,
  ChannelRevokeArm,
} from './channel-availability-port';
import type { ChannelOrderWritebackArm } from './channel-writeback-port';

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

// ── story 7.2 (RD-5): the webhook declaration ────────────────────────────────

/** The webhook endpoints an ingest-capable channel serves. */
export type ChannelWebhookEndpoint = 'orders' | 'cancellations';

/**
 * The signature-verification declaration (RD-5): the request header that
 * carries the signature, the encoding it is carried in, and the signing
 * scheme. Verification runs over the RAW body before any parse.
 */
export interface ChannelWebhookVerification {
  /** The signature request header (e.g. `X-Shopify-Hmac-Sha256`). */
  readonly header: string;
  /** The encoding the provider applies the signature bytes with. */
  readonly encoding: 'base64' | 'hex';
  /** The signing scheme (today: HMAC-SHA256 — RD-5 freezes it there). */
  readonly scheme: 'hmac-sha256';
  /**
   * The header carrying the provider's TOPIC (e.g. `X-Shopify-Topic`)
   * — the controller binds its value to the endpoint's declared topic
   * (RD-5: a captured `orders/create` delivery replayed against the
   * cancellations endpoint fails verification).
   */
  readonly topicHeader: string;
}

/**
 * One line as the parse arm normalizes it (RD-1): the channel-side SKU
 * reference (what the mappings resolve) and the ordered quantity in the
 * channel-facing unit (base units as the channel speaks them). The
 * command-side hash is over the RESOLVED content (skuId + base quantity);
 * the raw line never reaches any hash or store.
 */
export interface ParsedChannelLine {
  readonly externalRef: string;
  readonly quantity: number;
}

/**
 * An `orders` endpoint payload, normalized to EXACTLY what the order
 * captures (RD-1): the channel's immutable order ref (Shopify's `id`, never
 * `order_number`), the destination as the shared `AddressInput` shape (the
 * command re-validates it — the parse is not the trust boundary), and the
 * per-line externalRef + quantity. Non-material channel-side noise (tags,
 * notes, timestamps, ids of the DELIVERY) never survives the parse, so it
 * can never re-hash — a marketplace's own re-notification of an unchanged
 * order replays to the first order.
 */
export interface ParsedChannelOrder {
  readonly orderRef: string;
  /** Unset when the payload carries no address — the command 400s (required at create). */
  readonly destination?: AddressInput | undefined;
  readonly lines: readonly ParsedChannelLine[];
}

/** A `cancellations` endpoint payload, normalized to the order ref alone. */
export interface ParsedChannelCancellation {
  readonly orderRef: string;
}

/**
 * The provider's inbound webhook declaration — OPTIONAL. A provider
 * declaring none (today `amazon-in`/`flipkart` — their schemes are not
 * invented spec-side, RD-6) refuses the webhook endpoints with the typed
 * verbatim 501 `channel-transport-unconfigured`. `topics` names each
 * endpoint's registry-declared topic — the TOPIC BINDING (RD-5): the
 * provider's topic header must equal the endpoint's declared topic, so a
 * signature-valid payload replayed across endpoints fails verification.
 *
 * The parse arms (RD-1) are part of the declaration: verification proves
 * the SENDER, the parse arm proves the SHAPE — it normalizes the verified
 * body or answers null (the controller 400s a shaped-but-unmappable body
 * after verification, naming nothing channel-sensitive).
 */
export interface ChannelWebhookDeclaration {
  readonly topics: Readonly<Record<ChannelWebhookEndpoint, string>>;
  readonly verification: ChannelWebhookVerification;
  parseOrder(body: Record<string, unknown>): ParsedChannelOrder | null;
  parseCancellation(body: Record<string, unknown>): ParsedChannelCancellation | null;
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
   * The webhook ingest declaration (story 7.2, RD-5) — absent when the
   * provider carries no ingest transport.
   */
  readonly webhook?: ChannelWebhookDeclaration;
  /**
   * The availability delivery arm (story 7.1): the sync's published
   * snapshot, once through the transactional outbox's at-least-once relay.
   * story 7.2 replaced the shopify registration's stand-in with the real
   * transport (`channel-shopify-port.ts`) — amazon-in and flipkart keep
   * theirs (typed verbatim 501s).
   */
  readonly availabilityArm: ChannelAvailabilityArm;
  /**
   * The credential-revocation arm (the disconnect verb's port attempt,
   * logged and NOT blocking): unconfigured arms answer `unconfigured` and
   * the disconnect proceeds — a channel API being unreachable never keeps
   * secret material alive. shopify's real arm rides RD-7/RN-7's
   * post-delete-commit re-revoke.
   */
  readonly revokeArm: ChannelRevokeArm;
  /**
   * The order-writeback arm (story 7.2, RD-7): the relayed
   * `order.packed`/`order.dispatched`/`order.cancelled` events route here
   * — state-specific read-back guards inside; at-least-once across
   * invocations. Unconfigured providers register a typed verbatim 501.
   */
  readonly orderWritebackArm: ChannelOrderWritebackArm;
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
    {
      // RD-5: optional so a pre-7.2 connection stays readable — a connection
      // acquires it by the ordinary rotate. Absent verification is the same
      // 401 posture, visibly (the coarse rate-limited meter row).
      name: 'webhookSecret',
      label: 'Webhook signing secret',
      required: false,
      description: "The store's webhook signing secret — verifies this channel's order/cancellation webhooks.",
    },
    {
      // RD-6: the location the writeback fulfills against (one per shop —
      // a connection IS a shop). Required at writeback time, optional here.
      name: 'locationId',
      label: 'Shopify location id',
      required: false,
      description: "The numeric Shopify location id fulfillment writeback fulfills against (required before a dispatch can write back).",
    },
  ],
  webhook: {
    topics: {
      orders: 'orders/create',
      cancellations: 'orders/cancelled',
    },
    verification: {
      header: 'X-Shopify-Hmac-Sha256',
      encoding: 'base64',
      scheme: 'hmac-sha256',
      topicHeader: 'X-Shopify-Topic',
    },
    parseOrder: shopifyParseOrder,
    parseCancellation: shopifyParseCancellation,
  },
  availabilityArm: shopifyAvailabilityArm,
  revokeArm: shopifyRevokeArm,
  orderWritebackArm: shopifyOrderWritebackArm,
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
  orderWritebackArm: unconfiguredWritebackArm('amazon-in'),
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
  orderWritebackArm: unconfiguredWritebackArm('flipkart'),
});