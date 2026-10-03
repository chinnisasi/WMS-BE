/**
 * The REAL Shopify transport arms (story 7.2, RD-6) — the registrations the
 * `unconfigured*` stand-ins replaced for `shopify` only. `amazon-in` and
 * `flipkart` keep their typed verbatim 501s on every arm (RD-6: building
 * three untestable-without-credentials transports in one story produces
 * exactly the load a launch story would have to re-validate; RN-4).
 *
 * Every arm rides `channel-http.ts` (fetch, hard per-call timeout, no
 * retry — the OUTBOX RELAY owns the retry/backoff budget), opens the
 * request-scoped credential in process and never logs or meters its values.
 * Live-credential validation is a launch-activity PENDING row (not a test
 * gap): the transport-shape tests run against local stub servers and pin
 * request shape + response interpretation, per the carriers' sandbox-arm
 * discipline.
 *
 * Identity conventions, stated where they are chosen (RD-1's pin):
 *   - the ORDER reference is the Shopify order `id` (immutable — never
 *     `order_number`); the writeback addresses the channel's order by it;
 *   - the ITEM identity the arms carry is the mapping's externalRef (the
 *     channel-side SKU code); resolving our `skuId` back to it is the
 *     delivery's job (fresh mapping read), never a guess inside the arm;
 *   - `locationId` (the connection's Shopify location the writeback fulfills
 *     against) is a REQUIRED-AT-WRITEBACK credential: an arm invocation
 *     without it fails named `writeback-location-unset` — the location is
 *     NOT guessed from the channel's location list (RD-6; remediation is
 *     the rotate).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fromMilli } from '../../shared/primitives/quantity';
import { MAX_EXTERNAL_ID_LENGTH } from '../../shared/primitives/ids';
import { ChannelHttpError, channelHttpRequest } from './channel-http';
import { ChannelItemsUnresolvedError } from './channel-availability-port';
import type { ParsedChannelCancellation, ParsedChannelLine, ParsedChannelOrder } from './channel-registry';
import type { ChannelCredential } from './channel-credentials';
import type { AddressInput } from '../../shared/primitives/address';
import type {
  ChannelAvailabilityRequest,
  ChannelAvailabilityResult,
  ChannelRevokeArm,
} from './channel-availability-port';
import type {
  ChannelOrderWritebackRequest,
  ChannelOrderWritebackResult,
} from './channel-writeback-port';

/** The Admin API version the arms speak when the credential pins none. */
const SHOPIFY_DEFAULT_API_VERSION = '2026-01';

function adminBase(credential: ChannelCredential): string {
  const domain = credential.shopDomain;
  if (domain === undefined || domain === '') {
    throw new ChannelHttpError('bad-arg', null, 'credential field "shopDomain" is absent (rotate to supply it)');
  }
  const version = credential.apiVersion ?? SHOPIFY_DEFAULT_API_VERSION;
  return `https://${domain}/admin/api/${version}`;
}

function adminHeaders(credential: ChannelCredential): Record<string, string> {
  if (credential.accessToken === undefined || credential.accessToken === '') {
    throw new ChannelHttpError('bad-arg', null, 'credential field "accessToken" is absent (rotate to supply it)');
  }
  return { 'x-shopify-access-token': credential.accessToken };
}

/** The writeback-without-location failure's meter-facing name (RD-6). */
export const WRITEBACK_LOCATION_UNSET = 'writeback-location-unset';

/** The un-addressable read-back fulfillment's meter-facing name (RD-7). */
export const WRITEBACK_UNTRACKED_ID = 'writeback-untracked-fulfillment';

/**
 * The sku→item lookup (RD-6 amended; epic-7 retro D1): one Admin GRAPHQL
 * call per uncached ref. The 7-1 patch shipped a REST variants lookup the
 * Shopify REST Admin API does not have (no top-level variants resource, no
 * sku param — REST variants deprecated since API 2024-04): the real
 * transport 404d every uncached ref. GraphQL's `productVariants` search is the
 * published surface that answers it; the arm decides on the EDGES (below)
 * because the search is tokenized, never exact-match.
 */
const VARIANTS_BY_SKU_QUERY = `
  query VariantsBySku($query: String!) {
    productVariants(first: 10, query: $query) {
      edges { node { sku inventoryItem { legacyResourceId } } }
    }
  }
`;

/** One Admin GRAPHQL variant-lookup answer (the shape above, decoded). */
interface VariantLookupResponse {
  data?: {
    productVariants?: {
      edges?: readonly {
        node?: {
          sku?: string | null;
          inventoryItem?: { legacyResourceId?: string | number | null } | null;
        } | null;
      }[] | null;
    } | null;
  } | null;
  errors?: readonly { message?: string }[] | null;
}

/**
 * The credential's location as the NUMERIC Shopify location id, or null when
 * it cannot address an inventory/fulfillment write — the one validation both
 * POST arms share (epic-7 retro D9: the availability arm's bare empty-string
 * check let a non-numeric locationId reach the wire as `location_id: null`).
 */
function numericLocationId(credential: ChannelCredential): number | null {
  if (credential.locationId === undefined) {
    return null;
  }
  const parsed = Number(credential.locationId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The Shopify availability arm (RD-6, amended by human negotiation — change
 * log #7): one inventory-set request PER POSTABLE scope, every scope's
 * mapped `externalRef` resolved to Shopify's OWN `inventory_item_id` first
 * (a variant lookup through the Admin API) — the WMS `skuId` uuid is never
 * put on the channel wire. A scope whose cached `inventoryItemId` arrived on
 * the port carries no lookup; a fresh resolution rides the result back as
 * `resolvedItems` so the delivery can persist it (the per-connection cache).
 *
 * An unresolvable ref (empty lookup answer, or any lookup failure) SKIPS its
 * scopes — never guessed, never the uuid. Every scope unresolvable refuses
 * the whole attempt with the typed `ChannelItemsUnresolvedError` (the
 * delivery meters `item-unresolved`; no breaker/health movement — RD-9); a
 * partial run posts what resolved and reports the skipped refs for the
 * metered count. Posted availability is quantized
 * `floor(visibleMilli)` — Shopify inventory is integer-only and floor is
 * ATP-safe (never advertises more than exists). A 4xx/5xx answer on a POST
 * itself is the delivery failure the breaker machinery already understands.
 */
export async function shopifyAvailabilityArm(
  credential: ChannelCredential,
  request: ChannelAvailabilityRequest,
): Promise<ChannelAvailabilityResult> {
  const locationId = numericLocationId(credential);
  if (locationId === null) {
    throw new ChannelHttpError(
      'bad-arg',
      null,
      `credential field "locationId"${credential.locationId === undefined ? ' is absent' : ' is not a Shopify numeric location id'} (rotate to supply it)`,
    );
  }
  const base = adminBase(credential);
  const headers = adminHeaders(credential);

  const resolved = new Map<string, number>();
  const fresh = new Map<string, number>();
  const unresolved: string[] = [];
  for (const scope of request.scopes) {
    if (scope.inventoryItemId !== undefined) {
      resolved.set(scope.externalRef, scope.inventoryItemId);
      continue;
    }
    // One scope per (ref × warehouse): the second scope of the same ref
    // needs no second lookup.
    if (resolved.has(scope.externalRef) || unresolved.includes(scope.externalRef)) {
      continue;
    }
    try {
      // The ref rides QUOTED so SKUs containing spaces/colons form a valid
      // search term; embedded double quotes are dropped before quoting (a
      // malformed term can only yield zero edges → unresolved — the exact
      // edge filter below is the correctness boundary, the quoting recalls).
      const searchRef = scope.externalRef.trim().replace(/"/g, '');
      const response = await channelHttpRequest({
        method: 'POST',
        url: `${base}/graphql.json`,
        headers,
        body: { query: VARIANTS_BY_SKU_QUERY, variables: { query: `sku:"${searchRef}"` } },
      });
      const body = JSON.parse(response.body) as VariantLookupResponse;
      if (body.errors !== undefined && body.errors !== null && body.errors.length > 0) {
        // Throttling included: a GraphQL errors body never reads as data.
        throw new ChannelHttpError('not-ok', response.status, 'the admin GraphQL lookup answered with errors');
      }
      // Shopify's sku: search is TOKENIZED, not exact-match: only an edge
      // whose node.sku IS the ref (trimmed) may resolve it, and the resolved
      // id comes from `inventoryItem.legacyResourceId` — Shopify's own
      // documented bridge to the numeric REST id the set call needs (no
      // gid-suffix parsing). Distinct ids > 1 (a SKU repeated across
      // products — Shopify permits it) are ambiguous: refused as unresolved,
      // never guessed (RD-6).
      const ref = scope.externalRef.trim();
      const ids = new Set<string>();
      for (const edge of body.data?.productVariants?.edges ?? []) {
        const node = edge?.node;
        if (node === null || node === undefined || typeof node.sku !== 'string' || node.sku.trim() !== ref) {
          continue;
        }
        const raw = node.inventoryItem?.legacyResourceId;
        // `legacyResourceId` is an UnsignedInt64 — a JSON STRING on every
        // 2023-04+ version; a number still arrives on older ones. Either
        // shape must convert to a safe, positive integer or the edge
        // resolves nothing.
        const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          ids.add(String(parsed));
        }
      }
      if (ids.size !== 1) {
        unresolved.push(scope.externalRef);
        continue;
      }
      const itemId = Number([...ids][0]!);
      resolved.set(scope.externalRef, itemId);
      fresh.set(scope.externalRef, itemId);
    } catch {
      // A lookup failure is an unresolvable ref this attempt — the typed
      // refusal (or the skipped count) carries it; nothing is posted with a
      // guessed id.
      unresolved.push(scope.externalRef);
    }
  }

  if (resolved.size === 0) {
    throw new ChannelItemsUnresolvedError(request.scopes.map((scope) => scope.externalRef));
  }

  for (const scope of request.scopes) {
    const itemId = resolved.get(scope.externalRef);
    if (itemId === undefined) {
      continue; // unresolvable this attempt — the skipped count rides the result
    }
    await channelHttpRequest({
      method: 'POST',
      url: `${base}/inventory_levels/set.json`,
      headers,
      body: {
        location_id: locationId,
        inventory_item_ids: [itemId],
        available: Math.floor(fromMilli(scope.visibleMilli)),
      },
    });
  }
  const skippedRefs = unresolved.filter((ref) => !resolved.has(ref));
  return {
    acceptedAt: new Date().toISOString(),
    ...(fresh.size > 0 ? { resolvedItems: Object.fromEntries(fresh) } : {}),
    ...(skippedRefs.length > 0 ? { skippedRefs } : {}),
  };
}

/**
 * The Shopify revoke arm (RD-6, best-effort — the disconnect's non-blocking
 * posture): one DELETE against the Admin API's current api_permissions
 * (the custom-app token revoke). A non-2xx is the caller's metered,
 * logged, non-blocking outcome.
 */
export const shopifyRevokeArm: ChannelRevokeArm = async (args) => {
  const base = adminBase(args.credential);
  await channelHttpRequest({
    method: 'DELETE',
    url: `${base}/api_permissions/current.json`,
    headers: adminHeaders(args.credential),
  });
  return { status: 'revoked' };
};

/**
 * The Shopify writeback arm (RD-7): state-specific read-back, then the
 * write. The channel's own fulfillment state is READ (`orders/{id}/
 * fulfillments.json`) and its cancellation state READ (`orders/{id}.json`)
 * every invocation — the relay's at-least-once redrain then self-heals:
 *
 *   packed     — POST a fulfillment only when none exists;
 *   dispatched — tracking already present → noop; a tracking-less
 *                fulfillment → POST tracking_info onto it; none at all →
 *                create ONE fulfillment carrying the tracking (the
 *                reordering convergence — RD-7/T5);
 *   cancelled  — channel already cancelled → noop; else POST cancel.
 */
export async function shopifyOrderWritebackArm(
  credential: ChannelCredential,
  request: ChannelOrderWritebackRequest,
): Promise<ChannelOrderWritebackResult> {
  // RD-6: the location is REQUIRED material for a fulfillment call — the
  // named failure, never a guessed location. The validation expression is
  // the shared `numericLocationId` (epic-7 retro D9 — one validation, both
  // POST arms); the ERROR differs per arm (the availability arm's is the
  // typed `bad-arg`).
  const locationId = numericLocationId(credential);
  if (locationId === null) {
    throw new Error(
      `${WRITEBACK_LOCATION_UNSET}: the connection's credential locationId ${credential.locationId === undefined ? 'is absent' : `"${credential.locationId}"`} is not a Shopify numeric location id (rotate to supply it).`,
    );
  }
  const base = adminBase(credential);
  const headers = adminHeaders(credential);

  const readJson = async <T>(path: string): Promise<T> => {
    const response = await channelHttpRequest({ method: 'GET', url: `${base}/${path}`, headers });
    return JSON.parse(response.body) as T;
  };

  if (request.state === 'cancelled') {
    const order = await readJson<{ order?: { cancelled_at?: string | null } }>(`orders/${request.orderRef}.json`);
    if ((order.order?.cancelled_at ?? null) !== null) {
      return { settledAt: new Date().toISOString(), action: 'noop' };
    }
    await channelHttpRequest({
      method: 'POST',
      url: `${base}/orders/${request.orderRef}/cancel.json`,
      headers,
      body: {},
    });
    return { settledAt: new Date().toISOString(), action: 'cancelled' };
  }

  type Fulfillment = {
    readonly id?: number;
    readonly tracking_number?: string | null;
    readonly carrier_service?: string | null;
  };
  type FulfillmentsResponse = { fulfillments?: Fulfillment[] };
  const fulfillments = (await readJson<FulfillmentsResponse>(`orders/${request.orderRef}/fulfillments.json`))
    .fulfillments ?? [];

  if (request.state === 'packed') {
    if (fulfillments.length > 0) {
      // The dispatched arm landed first (reordering) — the fulfillment is
      // the packed state's own result; ack.
      return { settledAt: new Date().toISOString(), action: 'noop' };
    }
    await channelHttpRequest({
      method: 'POST',
      url: `${base}/fulfillments.json`,
      headers,
      body: {
        fulfillment: {
          location_id: locationId,
          notify_customer: false,
          line_items: request.lines.map((line) => ({
            sku: line.externalRef,
            quantity: line.quantity,
          })),
        },
      },
    });
    return { settledAt: new Date().toISOString(), action: 'created' };
  }

  // state === 'dispatched'
  const tracked = fulfillments.find((f) => (f.tracking_number ?? '') !== '');
  if (tracked !== undefined) {
    return { settledAt: new Date().toISOString(), action: 'noop' };
  }
  if (fulfillments.length > 0) {
    const untracked = fulfillments[0]!;
    // The tracking write addresses the fulfillment BY its id — a read-back
    // row without one is un-addressable (never a malformed
    // `fulfillments//tracking_info.json` request): the typed, metered
    // failure arm, the relay's budget carries the retry.
    if (typeof untracked.id !== 'number' || !Number.isSafeInteger(untracked.id)) {
      throw new Error(
        `${WRITEBACK_UNTRACKED_ID}: the channel's read-back fulfillment carries no id — the tracking write is un-addressable; not retried with a guessed path.`,
      );
    }
    await channelHttpRequest({
      method: 'POST',
      url: `${base}/fulfillments/${untracked.id}/tracking_info.json`,
      headers,
      body: {
        tracking_info: {
          number: request.tracking ?? null,
          carrier_service: request.carrier ?? null,
          url: undefined,
        },
        notify_customer: false,
      },
    });
    return { settledAt: new Date().toISOString(), action: 'updated' };
  }
  await channelHttpRequest({
    method: 'POST',
    url: `${base}/fulfillments.json`,
    headers,
    body: {
      fulfillment: {
        location_id: locationId,
        notify_customer: false,
        line_items: request.lines.map((line) => ({
          sku: line.externalRef,
          quantity: line.quantity,
        })),
        tracking_info: {
          number: request.tracking ?? null,
          carrier_service: request.carrier ?? null,
        },
      },
    },
  });
  return { settledAt: new Date().toISOString(), action: 'created' };
}

/**
 * The webhook signature verification for shopify (RD-5): HMAC-SHA256 over
 * the RAW body, base64-encoded, carried on `X-Shopify-Hmac-Sha256` —
 * constant-time compared. The topic header BINDS the endpoint (the
 * controller checks it; the declared header name rides the registry). Both
 * the secret and any body content stay inside this call.
 */
export function shopifySignatureValid(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (secret === '' || signatureHeader === undefined || signatureHeader === '') {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

// ── the parse arms (RD-1) ────────────────────────────────────────────────────
// Verification proves the SENDER; these prove the SHAPE. Each normalizes the
// verified JSON to exactly what the order path captures, or answers null —
// the controller's 400 `validation-failed` (which names nothing
// channel-sensitive). The channel order REF is the payload's `id` (immutable;
// never `order_number` per RD-1's pin).

function parseOrderRef(body: Record<string, unknown>): string | null {
  const id = body['id'];
  if (typeof id !== 'string' && typeof id !== 'number') {
    return null;
  }
  const orderRef = String(id).trim();
  if (orderRef === '' || orderRef.length > MAX_EXTERNAL_ID_LENGTH) {
    return null;
  }
  return orderRef;
}

function parseShippingAddress(raw: unknown): AddressInput | undefined | null {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object') {
    return null;
  }
  const addr = raw as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  // Shopify's shipping-address shape → the shared AddressInput: `name` and
  // `address1/address2` map across; `province` is the state, `zip` the
  // pincode. Missing fields come through as '' and die in the command's
  // `assertAddress` (the 400 — required at create, validated command-side).
  const destination = {
    contactName: text(addr['name']) ?? '',
    phone: text(addr['phone']) ?? '',
    line1: text(addr['address1']) ?? '',
    line2: text(addr['address2']),
    city: text(addr['city']) ?? '',
    state: text(addr['province']) ?? '',
    pincode: text(addr['zip']) ?? '',
  };
  return destination.line2 === undefined ? destination : { ...destination, line2: destination.line2 };
}

export function shopifyParseOrder(body: Record<string, unknown>): ParsedChannelOrder | null {
  const orderRef = parseOrderRef(body);
  if (orderRef === null) {
    return null;
  }
  const destination = parseShippingAddress(body['shipping_address']);
  if (destination === null) {
    return null;
  }
  const rawLines = body['line_items'];
  if (!Array.isArray(rawLines)) {
    return null;
  }
  const lines: ParsedChannelLine[] = [];
  for (const raw of rawLines) {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const item = raw as Record<string, unknown>;
    const sku = item['sku'];
    const quantity = item['quantity'];
    // A line item without a usable SKU code cannot be mapped (the mapping
    // set is externalRef → skuId) — the whole body is unmappable.
    if (typeof sku !== 'string' || sku.trim() === '') {
      return null;
    }
    // The channel speaks whole items; a fraction or a string is malformed.
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) {
      return null;
    }
    lines.push({ externalRef: sku.trim(), quantity });
  }
  // An order with no parseable line at all is not an empty order the ingest
  // path creates with zero lines (review patch P11): it is an unmappable
  // body — the parse arm refuses it exactly like any other shape it cannot
  // capture, so the meted parse refusal (P5's posture) carries the 400.
  if (lines.length === 0) {
    return null;
  }
  return { orderRef, destination, lines };
}

export function shopifyParseCancellation(body: Record<string, unknown>): ParsedChannelCancellation | null {
  const orderRef = parseOrderRef(body);
  if (orderRef === null) {
    return null;
  }
  return { orderRef };
}