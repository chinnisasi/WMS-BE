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
import { ChannelHttpError, channelHttpRequest } from './channel-http';
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

/**
 * The Shopify availability arm (RD-6): one inventory-set request PER SCOPE —
 * the payload carries the port's `ChannelAvailabilityScope` verbatim (the
 * core already computed `visibleMilli`; the arm converts to the API's unit
 * and addresses the location the credential names). A 4xx/5xx answer is the
 * delivery failure the breaker machinery already understands (the relay's
 * retry budget carries the rest).
 */
export async function shopifyAvailabilityArm(
  credential: ChannelCredential,
  request: ChannelAvailabilityRequest,
): Promise<ChannelAvailabilityResult> {
  if (credential.locationId === undefined || credential.locationId === '') {
    throw new ChannelHttpError('bad-arg', null, 'credential field "locationId" is absent (rotate to supply it)');
  }
  const base = adminBase(credential);
  for (const scope of request.scopes) {
    await channelHttpRequest({
      method: 'POST',
      url: `${base}/inventory_levels/set.json`,
      headers: adminHeaders(credential),
      body: {
        location_id: Number(credential.locationId),
        inventory_item_ids: [scope.skuId],
        available: fromMilli(scope.visibleMilli),
      },
    });
  }
  return { acceptedAt: new Date().toISOString() };
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
  // named failure, never a guessed location.
  if (credential.locationId === undefined || credential.locationId === '') {
    throw new Error(
      `${WRITEBACK_LOCATION_UNSET}: the connection's credential holds no locationId — rotate to supply Shopify's location the writeback fulfills against.`,
    );
  }
  const locationId = Number(credential.locationId);
  if (!Number.isSafeInteger(locationId) || locationId <= 0) {
    throw new Error(
      `${WRITEBACK_LOCATION_UNSET}: the connection's credential locationId "${credential.locationId}" is not a Shopify numeric location id (rotate to supply it).`,
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
    await channelHttpRequest({
      method: 'POST',
      url: `${base}/fulfillments/${String(untracked.id ?? '')}/tracking_info.json`,
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

/** The channel ref's ceiling — the order command's own MAX_EXTERNAL_EVENT_ID_LENGTH. */
const MAX_ORDER_REF_LENGTH = 200;

function parseOrderRef(body: Record<string, unknown>): string | null {
  const id = body['id'];
  if (typeof id !== 'string' && typeof id !== 'number') {
    return null;
  }
  const orderRef = String(id).trim();
  if (orderRef === '' || orderRef.length > MAX_ORDER_REF_LENGTH) {
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
  return { orderRef, destination, lines };
}

export function shopifyParseCancellation(body: Record<string, unknown>): ParsedChannelCancellation | null {
  const orderRef = parseOrderRef(body);
  if (orderRef === null) {
    return null;
  }
  return { orderRef };
}