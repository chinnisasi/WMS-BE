import { WebhookConfigError, assertWebhooksConfigured, extraDenyList, webhookConfigFromEnv } from './webhook-config';

describe('webhook env (story 5-2a, decision 15)', () => {
  it('defaults: off, 50 a tick, 10 s, 8 in flight, no deny lists', () => {
    expect(webhookConfigFromEnv({})).toEqual({ gateway: 'off', maxPerTick: 50, httpTimeoutMs: 10_000, sendConcurrency: 8, denyHosts: [], denyCidrs: [] });
  });

  it('parses every variable and names the bad one', () => {
    const config = webhookConfigFromEnv({
      WEBHOOK_GATEWAY: 'https',
      WEBHOOK_MAX_PER_TICK: '10',
      WEBHOOK_HTTP_TIMEOUT_MS: '30000',
      WEBHOOK_SEND_CONCURRENCY: '4',
      WEBHOOK_DENY_HOSTS: 'API.wms.example., app.wms.example',
      WEBHOOK_DENY_CIDRS: '10.20.0.0/16, fd00::/8',
    });
    expect(config).toMatchObject({ gateway: 'https', maxPerTick: 10, httpTimeoutMs: 30_000, sendConcurrency: 4, denyHosts: ['api.wms.example', 'app.wms.example'] });
    expect(extraDenyList(config).check('10.20.3.4', 'ipv4')).toBe(true);
    expect(extraDenyList(config).check('fd12::1', 'ipv6')).toBe(true);
    for (const [name, value] of [
      ['WEBHOOK_GATEWAY', 'smtp'],
      ['WEBHOOK_MAX_PER_TICK', '0'],
      ['WEBHOOK_HTTP_TIMEOUT_MS', '30001'],
      ['WEBHOOK_HTTP_TIMEOUT_MS', '999'],
      ['WEBHOOK_SEND_CONCURRENCY', '65'],
      ['WEBHOOK_DENY_HOSTS', 'bad host'],
      ['WEBHOOK_DENY_CIDRS', '10.0.0.0'],
      ['WEBHOOK_DENY_CIDRS', '10.0.0.0/33'],
      // C23 — an empty prefix is refused, never read as /0 (every address).
      ['WEBHOOK_DENY_CIDRS', '10.0.0.0/'],
      ['WEBHOOK_DENY_CIDRS', '10.0.0.0/ 8'],
    ] as const) {
      expect(() => webhookConfigFromEnv({ [name]: value })).toThrow(new RegExp(name));
      expect(() => webhookConfigFromEnv({ [name]: value })).toThrow(WebhookConfigError);
    }
  });

  it('https needs a usable WEBHOOK_SEAL_KEY at boot; off does not', () => {
    const saved = { key: process.env.WEBHOOK_SEAL_KEY, previous: process.env.WEBHOOK_SEAL_KEY_PREVIOUS };
    try {
      delete process.env.WEBHOOK_SEAL_KEY;
      delete process.env.WEBHOOK_SEAL_KEY_PREVIOUS;
      expect(() => assertWebhooksConfigured({ WEBHOOK_GATEWAY: 'off' })).not.toThrow();
      expect(() => assertWebhooksConfigured({ WEBHOOK_GATEWAY: 'https' })).toThrow(/WEBHOOK_SEAL_KEY/);
      process.env.WEBHOOK_SEAL_KEY = 'short';
      expect(() => assertWebhooksConfigured({ WEBHOOK_GATEWAY: 'https' })).toThrow(/WEBHOOK_SEAL_KEY/);
      process.env.WEBHOOK_SEAL_KEY = 'a-unit-test-webhook-seal-key-0123456789';
      expect(() => assertWebhooksConfigured({ WEBHOOK_GATEWAY: 'https' })).not.toThrow();
      process.env.WEBHOOK_SEAL_KEY_PREVIOUS = 'too-short';
      expect(() => assertWebhooksConfigured({ WEBHOOK_GATEWAY: 'https' })).toThrow(/WEBHOOK_SEAL_KEY_PREVIOUS/);
    } finally {
      if (saved.key === undefined) delete process.env.WEBHOOK_SEAL_KEY;
      else process.env.WEBHOOK_SEAL_KEY = saved.key;
      if (saved.previous === undefined) delete process.env.WEBHOOK_SEAL_KEY_PREVIOUS;
      else process.env.WEBHOOK_SEAL_KEY_PREVIOUS = saved.previous;
    }
  });
});
