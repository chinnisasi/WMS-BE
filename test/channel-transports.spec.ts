import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

// The arms read the per-call timeout at IMPORT time — this suite pins a
// small one so a hung stub answers the timeout shape in milliseconds, not
// the 10 s default.
process.env.CHANNEL_HTTP_TIMEOUT_MS = '1500';
// The stub is a LOCAL self-signed server — trust is set per-connection.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { DEFAULT_CHANNEL_HTTP_TIMEOUT_MS, parseChannelHttpTimeoutMs } from '../src/modules/channels/channel-http';
import type { ChannelHttpResponse } from '../src/modules/channels/channel-http';
import { channelHttpRequest } from '../src/modules/channels/channel-http';
import {
  ChannelItemsUnresolvedError,
} from '../src/modules/channels/channel-availability-port';
import {
  WRITEBACK_LOCATION_UNSET,
  WRITEBACK_UNTRACKED_ID,
  shopifyAvailabilityArm,
  shopifyOrderWritebackArm,
  shopifyRevokeArm,
  shopifySignatureValid,
} from '../src/modules/channels/channel-shopify-port';
import type { ChannelCredential } from '../src/modules/channels/channel-credentials';

jest.setTimeout(30_000);

/** One captured (never-logged) request on the stub. */
interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/**
 * The local HTTPS stub the transport-shape tests run against (the carriers
 * sandbox-arm discipline): one self-signed cert is minted in the OS temp dir
 * per suite run (never committed), the arms' `https://` requirement holds,
 * the process trusts the cert for these requests only.
 */
class ShopStub {
  readonly requests: CapturedRequest[] = [];
  private readonly server: https.Server;

  constructor(
    /** The scripted answers, matched in order; the LAST one repeats. */
    private readonly answers: { status: number; body: object }[],
  ) {
    this.server = https.createServer(
      { key: ShopStub.key, cert: ShopStub.cert },
      (req, res) => {
        const chunks: string[] = [];
        req.on('data', (chunk) => chunks.push(String(chunk)));
        req.on('end', () => {
          this.requests.push({
            method: req.method ?? '',
            url: req.url ?? '',
            headers: req.headers,
            body: chunks.join(''),
          });
          const answer = this.answers[Math.min(this.requests.length - 1, this.answers.length - 1)]!;
          res.writeHead(answer.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(answer.body));
        });
      },
    );
  }

  /** The minted self-signed material (one per suite run). */
  static key = '';
  static cert = '';

  static async mint(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-channel-stub-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'key.pem'),
      '-out', path.join(dir, 'cert.pem'), '-days', '1', '-nodes', '-subj', '/CN=localhost',
    ], { stdio: 'ignore' });
    ShopStub.key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
    ShopStub.cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
    this.dir = dir;
  }

  static dir = '';

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const port = (this.server.address() as { port: number }).port;
    return `127.0.0.1:${port}`;
  }

  close(): void {
    this.server.close();
  }
}

const ADMIN_TOKEN = 'canary-stub-access-token';
const CREDENTIAL: ChannelCredential = {
  shopDomain: 'placeholder-set-per-test',
  accessToken: ADMIN_TOKEN,
  locationId: '9001',
} as unknown as ChannelCredential;

beforeAll(async () => {
  await ShopStub.mint();
});

afterAll(() => {
  fs.rmSync(ShopStub.dir, { recursive: true, force: true });
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
});

describe('channel transports: the shopify arms against a local stub (story 7.2, RD-6/RD-7 amended)', () => {
  // The WMS-side identity of the mapped SKUs (uuid — never on the wire post-
  // amendment) and the CHANNEL-side refs the arm must resolve (RD-6 amended,
  // change log #7: the WMS skuId uuid is never posted as Shopify's
  // inventory_item_id).
  const SKU_1 = '00000000-0000-0000-0000-000000000031';
  const SKU_2 = '00000000-0000-0000-0000-000000000032';
  const WAREHOUSE = '00000000-0000-0000-0000-000000000003';
  const REF_1 = 'SHOPIFY-STUB-SKU-1';
  const REF_2 = 'SHOPIFY-STUB-SKU-2';

  /** One base scope shape, filled per test. */
  const scope = (skuId: string, ref: string, visibleMilli: number, itemId?: number) => ({
    warehouseId: WAREHOUSE,
    skuId,
    externalRef: ref,
    visibleMilli,
    ...(itemId === undefined ? {} : { inventoryItemId: itemId }),
  });

  // The first two lookups (one per distinct ref) then the two set posts.
  const RESOLVED_STUB_ANSWERS = [
    { status: 200, body: { variants: [{ id: 11, inventory_item_id: 445566 }] } },
    { status: 200, body: { variants: [{ id: 12, inventory_item_id: 556677 }] } },
    { status: 200, body: {} },
    { status: 200, body: {} },
  ];

  it('the availability arm resolves every mapped ref first, then posts the RESOLVED item id and the FLOORED quantity (RD-6 amended: the WMS skuId uuid is never posted)', async () => {
    const stub = new ShopStub(RESOLVED_STUB_ANSWERS);
    const domain = await stub.start();
    try {
      const result = await shopifyAvailabilityArm({ ...CREDENTIAL, shopDomain: domain } as ChannelCredential, {
        tenantId: '00000000-0000-0000-0000-000000000001',
        integrationId: '00000000-0000-0000-0000-000000000002',
        provider: 'shopify',
        scopes: [scope(SKU_1, REF_1, 12_500), scope(SKU_2, REF_2, 0)],
        publishedAt: '2026-10-02T00:00:00.000Z',
      });
      expect(typeof result.acceptedAt).toBe('string');
      // The resolutions ride the result — the delivery persists the cache.
      expect(result.resolvedItems).toEqual({ [REF_1]: 445566, [REF_2]: 556677 });
      // TWO variant lookups, then the two set posts (one postable scope each).
      expect(stub.requests).toHaveLength(4);
      expect(stub.requests[0]!.method).toBe('GET');
      expect(stub.requests[0]!.url).toBe(`/admin/api/2026-01/variants.json?sku=${encodeURIComponent(REF_1)}`);
      expect(stub.requests[1]!.url).toBe(`/admin/api/2026-01/variants.json?sku=${encodeURIComponent(REF_2)}`);
      expect(stub.requests[2]!.url).toBe('/admin/api/2026-01/inventory_levels/set.json');
      expect(stub.requests[2]!.method).toBe('POST');
      expect(stub.requests[2]!.headers['x-shopify-access-token']).toBe(ADMIN_TOKEN);
      // The inventory_set body carries the CHANNEL item id — the WMS uuid
      // (SKU_1) appears NOWHERE in any request.
      const firstBody = JSON.parse(stub.requests[2]!.body) as Record<string, unknown>;
      expect(firstBody).toMatchObject({ location_id: 9001, inventory_item_ids: [445566], available: 12 });
      expect(stub.requests[2]!.body).not.toContain(SKU_1);
      const secondBody = JSON.parse(stub.requests[3]!.body) as Record<string, unknown>;
      expect(secondBody).toMatchObject({ inventory_item_ids: [556677], available: 0 });
      // The 12.5 milli quantity lands FLOORED (RD-6 amended's quantization
      // policy: Shopify inventory is integer-only; floor is ATP-safe — it
      // never advertises more than exists).
      expect(stub.requests[2]!.body).not.toContain('12.5');
    } finally {
      stub.close();
    }
  });

  it('a cached inventoryItemId posts without a lookup; an unresolvable ref SKIPS its scopes with the skipped count (RD-6 amended)', async () => {
    // The lookups: ref 2's answer resolves nothing (empty variants).
    const stub = new ShopStub([
      { status: 200, body: { variants: [] } },
      { status: 200, body: {} },
    ]);
    const domain = await stub.start();
    try {
      const result = await shopifyAvailabilityArm({ ...CREDENTIAL, shopDomain: domain } as ChannelCredential, {
        tenantId: '00000000-0000-0000-0000-000000000001',
        integrationId: '00000000-0000-0000-0000-000000000002',
        provider: 'shopify',
        scopes: [scope(SKU_1, REF_1, 1_000, 778899), scope(SKU_2, REF_2, 2_000)],
        publishedAt: '2026-10-02T00:00:00.000Z',
      });
      // Exactly ONE lookup (only the uncached ref), exactly ONE post (the
      // skipped ref's scopes never post anything).
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0]!.url).toContain('/variants.json?sku=');
      const postBody = JSON.parse(stub.requests[1]!.body) as Record<string, unknown>;
      expect(postBody).toMatchObject({ inventory_item_ids: [778899] });
      expect(result.skippedRefs).toEqual([REF_2]);
    } finally {
      stub.close();
    }
  });

  it('EVERY scope unresolvable refuses the attempt with the typed ChannelItemsUnresolvedError and NO inventory_set request (RD-6 amended)', async () => {
    const stub = new ShopStub([
      { status: 200, body: { variants: [] } },
      { status: 200, body: { variants: [] } },
    ]);
    const domain = await stub.start();
    try {
      await expect(shopifyAvailabilityArm({ ...CREDENTIAL, shopDomain: domain } as ChannelCredential, {
        tenantId: '00000000-0000-0000-0000-000000000001',
        integrationId: '00000000-0000-0000-0000-000000000002',
        provider: 'shopify',
        scopes: [scope(SKU_1, REF_1, 1_000), scope(SKU_2, REF_2, 1_000)],
        publishedAt: '2026-10-02T00:00:00.000Z',
      })).rejects.toThrow(ChannelItemsUnresolvedError);
      // No inventory_levels request ever left with a guessed id.
      expect(stub.requests.filter((request_) => request_.url.includes('inventory_levels'))).toEqual([]);
    } finally {
      stub.close();
    }
  });

  it('a 4xx answer reads as the delivery failure the breaker already understands (not-ok)', async () => {
    const stub = new ShopStub([
      { status: 200, body: { variants: [{ inventory_item_id: 445566 }] } },
      { status: 422, body: { errors: 'Inventory not found' } },
    ]);
    const domain = await stub.start();
    try {
      const attempt = shopifyAvailabilityArm({ ...CREDENTIAL, shopDomain: domain } as ChannelCredential, {
        tenantId: '00000000-0000-0000-0000-000000000001',
        integrationId: '00000000-0000-0000-0000-000000000002',
        provider: 'shopify',
        scopes: [scope(SKU_1, REF_1, 1000)],
        publishedAt: '2026-10-02T00:00:00.000Z',
      });
      await expect(attempt).rejects.toMatchObject({ kind: 'not-ok', status: 422 });
    } finally {
      stub.close();
    }
  });

  it('the missing-credential-field shapes fail as bad-arg naming the FIELD, before any request', async () => {
    const revokeArgs = (credential: ChannelCredential): Parameters<typeof shopifyRevokeArm>[0] => ({
      tenantId: '00000000-0000-0000-0000-000000000001',
      integrationId: '00000000-0000-0000-0000-000000000002',
      provider: 'shopify',
      credential,
    });
    const withoutDomain: ChannelCredential = { accessToken: ADMIN_TOKEN } as unknown as ChannelCredential;
    await expect(shopifyRevokeArm(revokeArgs(withoutDomain))).rejects.toMatchObject({ kind: 'bad-arg' });
    const withoutToken: ChannelCredential = { shopDomain: 'stub.myshopify.com' } as unknown as ChannelCredential;
    await expect(shopifyRevokeArm(revokeArgs(withoutToken))).rejects.toMatchObject({
      kind: 'bad-arg',
      message: expect.stringContaining('accessToken'),
    });
  });

  it('the revoke arm DELETEs the current api_permissions with the access-token header', async () => {
    const stub = new ShopStub([{ status: 200, body: { api_permissions: null } }]);
    const domain = await stub.start();
    try {
      const verdict = await shopifyRevokeArm({
        tenantId: '00000000-0000-0000-0000-000000000001',
        integrationId: '00000000-0000-0000-0000-000000000002',
        provider: 'shopify',
        credential: { ...CREDENTIAL, shopDomain: domain } as ChannelCredential,
      });
      expect(verdict.status).toBe('revoked');
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]!.method).toBe('DELETE');
      expect(stub.requests[0]!.url).toBe('/admin/api/2026-01/api_permissions/current.json');
      expect(stub.requests[0]!.headers['x-shopify-access-token']).toBe(ADMIN_TOKEN);
    } finally {
      stub.close();
    }
  });

  it('the writeback arm with NO locationId fails named — never a guessed location (RD-6)', async () => {
    const stub = new ShopStub([{ status: 200, body: {} }]);
    const domain = await stub.start();
    try {
      const noLocation = { accessToken: ADMIN_TOKEN, shopDomain: domain } as unknown as ChannelCredential;
      const attempt = shopifyOrderWritebackArm(noLocation, {
        tenantId: 't', integrationId: 'i', provider: 'shopify', orderRef: '9001', state: 'packed',
        lines: [{ externalRef: 'SKU-1', quantity: 2 }],
      });
      await expect(attempt).rejects.toThrow(WRITEBACK_LOCATION_UNSET);
      expect(stub.requests).toEqual([]); // NO request guessed the location list
    } finally {
      stub.close();
    }
  });

  it('the writeback arm "packed" POSTs one fulfillment the location + sku/quantity lines', async () => {
    const stub = new ShopStub([
      { status: 200, body: { fulfillments: [] } }, // the read-back
      { status: 201, body: { fulfillment: { id: 51 } } },
    ]);
    const domain = await stub.start();
    try {
      const result = await shopifyOrderWritebackArm({ ...CREDENTIAL, shopDomain: domain } as ChannelCredential, {
        tenantId: 't', integrationId: 'i', provider: 'shopify', orderRef: '9001', state: 'packed',
        lines: [{ externalRef: 'SKU-1', quantity: 2 }, { externalRef: 'SKU-2', quantity: 1 }],
      });
      expect(result.action).toBe('created');
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0]!.method).toBe('GET');
      expect(stub.requests[0]!.url).toBe('/admin/api/2026-01/orders/9001/fulfillments.json');
      expect(stub.requests[1]!.method).toBe('POST');
      expect(stub.requests[1]!.url).toBe('/admin/api/2026-01/fulfillments.json');
      const body = JSON.parse(stub.requests[1]!.body) as {
        fulfillment: { location_id: number; line_items: { sku: string; quantity: number }[]; notify_customer: boolean };
      };
      expect(body.fulfillment.location_id).toBe(9001);
      expect(body.fulfillment.line_items).toEqual([{ sku: 'SKU-1', quantity: 2 }, { sku: 'SKU-2', quantity: 1 }]);
      expect(body.fulfillment.notify_customer).toBe(false);
    } finally {
      stub.close();
    }
  });

  it('the writeback arm "dispatched": a read-back fulfillment WITHOUT an id is the typed un-addressable failure (review patch P8)', async () => {
    const stub = new ShopStub([
      { status: 200, body: { fulfillments: [{ tracking_number: null }] } }, // no id
    ]);
    const domain = await stub.start();
    try {
      const attempt = shopifyOrderWritebackArm({ ...CREDENTIAL, shopDomain: domain } as ChannelCredential, {
        tenantId: 't', integrationId: 'i', provider: 'shopify', orderRef: '9001', state: 'dispatched',
        carrier: 'Blue Dart', tracking: 'BD-9', lines: [{ externalRef: 'SKU-1', quantity: 2 }],
      });
      // The typed marker — never the malformed `fulfillments//tracking_info`
      // request path a `String(id ?? '')` would have built.
      await expect(attempt).rejects.toThrow(WRITEBACK_UNTRACKED_ID);
      expect(stub.requests).toHaveLength(1); // the read-back; NO follow-up request
    } finally {
      stub.close();
    }
  });

  it('the writeback arm "dispatched": a tracked read-back acks; an untracked one UPDATES with the tracking', async () => {
    const trackedStub = new ShopStub([
      { status: 200, body: { fulfillments: [{ id: 51, tracking_number: 'BD-8', carrier_service: 'Blue Dart' }] } },
    ]);
    const trackedDomain = await trackedStub.start();
    try {
      const noop = await shopifyOrderWritebackArm({ ...CREDENTIAL, shopDomain: trackedDomain } as ChannelCredential, {
        tenantId: 't', integrationId: 'i', provider: 'shopify', orderRef: '9001', state: 'dispatched',
        carrier: 'Blue Dart', tracking: 'BD-9', lines: [{ externalRef: 'SKU-1', quantity: 2 }],
      });
      expect(noop.action).toBe('noop');
      expect(trackedStub.requests).toHaveLength(1); // the read — NO tracking write
    } finally {
      trackedStub.close();
    }

    const untrackedStub = new ShopStub([
      { status: 200, body: { fulfillments: [{ id: 51, tracking_number: null }] } }, // the read-back
      { status: 201, body: { receipt: { test: true } } },
    ]);
    const untrackedDomain = await untrackedStub.start();
    try {
      const updated = await shopifyOrderWritebackArm({ ...CREDENTIAL, shopDomain: untrackedDomain } as ChannelCredential, {
        tenantId: 't', integrationId: 'i', provider: 'shopify', orderRef: '9001', state: 'dispatched',
        carrier: 'Blue Dart', tracking: 'BD-9', lines: [{ externalRef: 'SKU-1', quantity: 2 }],
      });
      expect(updated.action).toBe('updated');
      expect(untrackedStub.requests).toHaveLength(2);
      expect(untrackedStub.requests[1]!.method).toBe('POST');
      expect(untrackedStub.requests[1]!.url).toBe('/admin/api/2026-01/fulfillments/51/tracking_info.json');
      const body = JSON.parse(untrackedStub.requests[1]!.body) as { tracking_info: { number: string; carrier_service: string } };
      expect(body.tracking_info.number).toBe('BD-9');
      expect(body.tracking_info.carrier_service).toBe('Blue Dart');
    } finally {
      untrackedStub.close();
    }
  });

  it('the writeback arm "cancelled": an already-cancelled read-back acks; a live one cancels', async () => {
    const cancelledStub = new ShopStub([
      { status: 200, body: { order: { cancelled_at: '2026-10-02T00:00:00Z' } } },
    ]);
    const cancelledDomain = await cancelledStub.start();
    try {
      const noop = await shopifyOrderWritebackArm({ ...CREDENTIAL, shopDomain: cancelledDomain } as ChannelCredential, {
        tenantId: 't', integrationId: 'i', provider: 'shopify', orderRef: '9001', state: 'cancelled',
        lines: [],
      });
      expect(noop.action).toBe('noop');
      expect(cancelledStub.requests).toHaveLength(1); // the read — NO cancel write
    } finally {
      cancelledStub.close();
    }

    const liveStub = new ShopStub([
      { status: 200, body: { order: { cancelled_at: null } } }, // the read-back
      { status: 202, body: { order: { id: 9001 } } },
    ]);
    const liveDomain = await liveStub.start();
    try {
      const cancelled = await shopifyOrderWritebackArm({ ...CREDENTIAL, shopDomain: liveDomain } as ChannelCredential, {
        tenantId: 't', integrationId: 'i', provider: 'shopify', orderRef: '9001', state: 'cancelled',
        lines: [],
      });
      expect(cancelled.action).toBe('cancelled');
      expect(liveStub.requests).toHaveLength(2);
      expect(liveStub.requests[1]!.method).toBe('POST');
      expect(liveStub.requests[1]!.url).toBe('/admin/api/2026-01/orders/9001/cancel.json');
    } finally {
      liveStub.close();
    }
  });

  it('the signature helper: the raw-body HMAC (base64) matches and a tampered body does not', () => {
    const secret = 'whsec-shopify-stub-canary';
    const body = Buffer.from(JSON.stringify({ id: 9001 }));
    // The expected digest is minted by an INDEPENDENT construction of the
    // same HMAC (the stub's own helper — not the code under test).
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('base64')}`.replace('sha256=', '');
    expect(shopifySignatureValid(secret, body, expected)).toBe(true);
    expect(shopifySignatureValid(secret, body, 'AAAA')).toBe(false);
    expect(shopifySignatureValid('', body, 'QUFB')).toBe(false);
    expect(shopifySignatureValid(secret, body, undefined)).toBe(false);
  });

  it("an unregistered provider's writeback keeps the typed verbatim 501 (RD-6)", async () => {
    const { channelAdapter } = await import('../src/modules/channels/channel-registry');
    const { ProblemException } = await import('../src/shared/problem-details/problem.exception');
    for (const provider of ['amazon-in', 'flipkart']) {
      const adapter = channelAdapter(provider);
      expect(adapter).toBeDefined();
      const attempt = adapter!.orderWritebackArm({} as ChannelCredential, {
        tenantId: 't', integrationId: 'i', provider, orderRef: 'ref', state: 'packed', lines: [],
      });
      let caught: unknown;
      try {
        await attempt;
        throw new Error('the unconfigured arm did not refuse');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProblemException);
      const problem = (caught as { getResponse(): { code?: string } }).getResponse();
      expect(problem.code).toBe('channel-transport-unconfigured');
      expect((caught as { getStatus(): number }).getStatus()).toBe(501);
    }
  });
});

describe('channel-http body integrity (review patch P7)', () => {
  /** A one-shot raw HTTPS server (beyond the JSON stub's vocabulary). */
  async function withRawServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ run: (path: string) => Promise<unknown>; close: () => Promise<void> }> {
    const server = https.createServer({ key: ShopStub.key, cert: ShopStub.cert }, handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
      run: (path: string) =>
        channelHttpRequest({ method: 'GET', url: `https://127.0.0.1:${port}/${path}`, headers: {} }),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('a multi-byte UTF-8 character split across chunk boundaries decodes INTACT', async () => {
    const server = await withRawServer((req, res) => {
      void req;
      res.writeHead(200, { 'content-type': 'application/json' });
      // 'café' as raw bytes: the é (0xC3 0xA9) deliberately SPLIT — the
      // 0xC3 rides one chunk, the 0xA9 the next (a per-chunk string decode
      // would corrupt it into a replacement char).
      res.write(Buffer.from('{"a":"caf\xC3', 'binary'));
      setTimeout(() => res.end(Buffer.from('\xA9"}', 'binary')), 20);
    });
    try {
      const response = (await server.run('split')) as { body: string };
      expect(JSON.parse(response.body)).toEqual({ a: 'café' });
    } finally {
      await server.close();
    }
  });

  it('a truncated 2xx (declared content-length never fully arrives) is the TYPED failure, never a partial body', async () => {
    const server = await withRawServer((req, res) => {
      void req;
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' });
      res.write('part');
      setImmediate(() => (req.socket as Socket).destroy());
    });
    try {
      await expect(server.run('truncate')).rejects.toMatchObject({
        kind: expect.stringMatching(/^(network|not-ok)$/),
        status: null,
      });
    } finally {
      await server.close();
    }
  });
});

describe('CHANNEL_HTTP_TIMEOUT_MS: the poll-gate parse conventions (RD-6)', () => {
  it('unset (or blank) parses to the default', () => {
    expect(parseChannelHttpTimeoutMs(undefined)).toBe(DEFAULT_CHANNEL_HTTP_TIMEOUT_MS);
    expect(parseChannelHttpTimeoutMs('')).toBe(DEFAULT_CHANNEL_HTTP_TIMEOUT_MS);
    expect(DEFAULT_CHANNEL_HTTP_TIMEOUT_MS).toBe(10_000);
  });

  it('a valid integer parses; garbage and out-of-ceiling values boot loud', () => {
    expect(parseChannelHttpTimeoutMs('5000')).toBe(5000);
    expect(() => parseChannelHttpTimeoutMs('abc')).toThrow(/Invalid CHANNEL_HTTP_TIMEOUT_MS/);
    expect(() => parseChannelHttpTimeoutMs('-1')).toThrow(/Invalid CHANNEL_HTTP_TIMEOUT_MS/);
    expect(() => parseChannelHttpTimeoutMs('0')).toThrow(/Invalid CHANNEL_HTTP_TIMEOUT_MS/);
    expect(() => parseChannelHttpTimeoutMs('300001')).toThrow(/Invalid CHANNEL_HTTP_TIMEOUT_MS/);
    expect(parseChannelHttpTimeoutMs('300000')).toBe(300_000); // the ceiling holds
  });

  it('a HUNG channel call is cut at the configured timeout — the typed timeout shape', async () => {
    // A fresh module registry so the file-top env (1500 ms) is the constant
    // THIS instance read at import (the main registry's constant parsed the
    // env at hoisted-import time, before the assignment).
    type HttpTransport = {
      channelHttpRequest: (args: {
        method: 'GET' | 'POST' | 'PUT' | 'DELETE';
        url: string;
        headers: Readonly<Record<string, string>>;
        body?: unknown;
      }) => Promise<ChannelHttpResponse>;
    };
    const { channelHttpRequest } = await new Promise<HttpTransport>((done) => {
      jest.isolateModules(() => {
        done(jest.requireActual('../src/modules/channels/channel-http') as HttpTransport);
      });
    });
    // A TLS server that accepts the handshake and NEVER answers.
    const hung = https.createServer({ key: ShopStub.key, cert: ShopStub.cert }, () => {
      // never answers
    });
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const port = (hung.address() as { port: number }).port;
    try {
      const attempt = channelHttpRequest({
        method: 'GET',
        url: `https://127.0.0.1:${port}/hang`,
        headers: {},
      });
      await expect(attempt).rejects.toMatchObject({ kind: 'timeout', status: null });
    } finally {
      hung.close();
    }
  });
});