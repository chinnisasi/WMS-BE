import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PENDING_EXPIRY_MS,
  WEBHOOK_RETRY_WAITS_MS,
  WEBHOOK_STALE_MS,
  assertStaleBound,
  classifyOutcome,
  normaliseWebhookUrl,
  outcomeErrorCode,
  parseRetryAfterMs,
  shouldAutoDisable,
  sortEventTypes,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_SOURCE_EVENTS,
  webhookNextWaitMs,
  webhookRetryDelayMs,
  webhookUrlWithoutQuery,
  WebhookUrlError,
  type WebhookSendOutcome,
} from './webhook-rules';

function ruleOf(raw: string, deny: readonly string[] = []): string {
  try {
    normaliseWebhookUrl(raw, deny);
    return 'ok';
  } catch (err) {
    return err instanceof WebhookUrlError ? err.rule : 'threw';
  }
}

const response = (statusCode: number, retryAfterMs: number | null = null): WebhookSendOutcome => ({ kind: 'response', statusCode, retryAfterMs, durationMs: 5 });

describe('webhook rules (story 5-2a)', () => {
  describe('the save-time URL rules (decision 11, A14)', () => {
    it.each([
      ['https://hooks.acme.in/wms', 'https://hooks.acme.in/wms'],
      ['https://HOOKS.Acme.IN:443/wms?token=a', 'https://hooks.acme.in/wms?token=a'],
      ['https://hooks.acme.in./wms', 'https://hooks.acme.in/wms'],
      ['https://hooks.acme.in:8443/', 'https://hooks.acme.in:8443/'],
      ['  https://hooks.acme.in  ', 'https://hooks.acme.in/'],
    ])('normalises %s', (raw, expected) => {
      expect(normaliseWebhookUrl(raw)).toBe(expected);
    });

    it.each([
      ['http://hooks.acme.in/', 'scheme'],
      ['ftp://hooks.acme.in/', 'scheme'],
      ['https://u:p@hooks.acme.in/', 'userinfo'],
      ['https://hooks.acme.in/#frag', 'fragment'],
      ['https://10.0.0.5/', 'host'],
      ['https://169.254.170.2/', 'host'],
      ['https://[::1]/', 'host'],
      ['https://[fd00::1]/', 'host'],
      ['https://2130706433/', 'host'],
      ['https://0x7f.1/', 'host'],
      ['https://127.1/', 'host'],
      ['https://017700000001/', 'host'],
      ['https://localhost/', 'host'],
      ['https://localhost./', 'host'],
      ['https://intranet/', 'host'],
      ['https://printer.local/', 'host'],
      ['https://x.localhost/', 'host'],
      ['https://db.internal/', 'host'],
      ['https://nas.home.arpa/', 'host'],
      ['https://hooks.acme.in:80/', 'port'],
      ['https://hooks.acme.in:1023/', 'port'],
      ['not a url', 'parse'],
      ['', 'length'],
      [`https://hooks.acme.in/${'a'.repeat(2048)}`, 'length'],
    ])('refuses %s by the %s rule', (raw, rule) => {
      expect(ruleOf(raw)).toBe(rule);
    });

    it('refuses the deployment’s own hosts and their sub-domains (WEBHOOK_DENY_HOSTS)', () => {
      expect(ruleOf('https://api.wms.example/hook', ['api.wms.example'])).toBe('host');
      expect(ruleOf('https://x.api.wms.example/hook', ['api.wms.example'])).toBe('host');
      expect(ruleOf('https://notapi.wms.example/hook', ['api.wms.example'])).toBe('ok');
    });

    it('a host whose labels are digits only where WHATWG would read a number — but a name with a numeric label is fine', () => {
      expect(ruleOf('https://123.example.com/')).toBe('ok');
      expect(ruleOf('https://1password.com/')).toBe('ok');
    });

    it('the audit form drops the query (A26)', () => {
      expect(webhookUrlWithoutQuery('https://hooks.acme.in/wms?token=secret')).toBe('https://hooks.acme.in/wms?…');
      expect(webhookUrlWithoutQuery('https://hooks.acme.in/wms')).toBe('https://hooks.acme.in/wms');
    });
  });

  describe('the fate table (A18)', () => {
    it.each([
      [200, 'succeeded'],
      [204, 'succeeded'],
      [299, 'succeeded'],
      [408, 'retry'],
      [429, 'retry'],
      [500, 'retry'],
      [503, 'retry'],
      [599, 'retry'],
      [301, 'failed'],
      [302, 'failed'],
      [400, 'failed'],
      [401, 'failed'],
      [403, 'failed'],
      [404, 'failed'],
      [413, 'failed'],
      [422, 'failed'],
      [410, 'gone'],
    ])('%i → %s', (status, kind) => {
      expect(classifyOutcome(response(status)).kind).toBe(kind);
    });

    it('transport errors retry; target-blocked never counts', () => {
      for (const code of ['network', 'timeout', 'dns-failed', 'tls-handshake', 'tls-cert'] as const) {
        expect(classifyOutcome({ kind: 'error', code, durationMs: 1 })).toEqual({ kind: 'retry', countsWhenFinal: true });
      }
      expect(classifyOutcome({ kind: 'error', code: 'target-blocked', durationMs: 1 })).toEqual({ kind: 'retry', countsWhenFinal: false });
    });

    it('stores http-<status> for a non-2xx and the transport code for an error', () => {
      expect(outcomeErrorCode(response(503))).toBe('http-503');
      expect(outcomeErrorCode(response(204))).toBeNull();
      expect(outcomeErrorCode({ kind: 'error', code: 'tls-cert', durationMs: 0 })).toBe('tls-cert');
    });
  });

  describe('the retry schedule (A2)', () => {
    it('nine attempts, the last about 68.6 h after the first — inside the 72 h expiry even before jitter', () => {
      expect(WEBHOOK_MAX_ATTEMPTS).toBe(9);
      const total = WEBHOOK_RETRY_WAITS_MS.reduce((sum, wait) => sum + wait, 0);
      expect(total / 3_600_000).toBeCloseTo(68.6, 1);
      expect(total).toBeLessThan(WEBHOOK_PENDING_EXPIRY_MS);
      expect([1, 2, 3, 4, 5, 6, 7, 8].map(webhookRetryDelayMs)).toEqual([...WEBHOOK_RETRY_WAITS_MS]);
    });

    it('jitter only ever shortens (0 to −10 %)', () => {
      expect(webhookNextWaitMs(1, null, () => 0)).toBe(60_000);
      expect(webhookNextWaitMs(1, null, () => 1)).toBe(54_000);
      expect(webhookNextWaitMs(1, null, () => 0.5)).toBe(57_000);
    });

    it('a longer Retry-After replaces the wait, capped at 24 h; a shorter one does not', () => {
      expect(webhookNextWaitMs(1, 3_600_000, () => 0)).toBe(3_600_000);
      expect(webhookNextWaitMs(1, 1_000, () => 0)).toBe(60_000);
      expect(webhookNextWaitMs(1, 48 * 3_600_000, () => 0)).toBe(24 * 3_600_000);
    });

    it('parses Retry-After as seconds or an HTTP date', () => {
      const now = Date.parse('2026-10-27T10:00:00Z');
      expect(parseRetryAfterMs('120', now)).toBe(120_000);
      expect(parseRetryAfterMs('Tue, 27 Oct 2026 10:05:00 GMT', now)).toBe(300_000);
      expect(parseRetryAfterMs('soon', now)).toBeNull();
      expect(parseRetryAfterMs(undefined, now)).toBeNull();
    });
  });

  describe('auto-disable (A12)', () => {
    const now = Date.parse('2026-10-27T10:00:00Z');
    it('needs ten final failures AND 24 h of failing', () => {
      expect(shouldAutoDisable(10, '2026-10-26T10:00:00Z', now)).toBe(true);
      expect(shouldAutoDisable(9, '2026-10-20T10:00:00Z', now)).toBe(false);
      expect(shouldAutoDisable(50, '2026-10-26T10:00:01Z', now)).toBe(false);
      expect(shouldAutoDisable(10, null, now)).toBe(false);
    });
  });

  it('the stale bound holds for every accepted timeout, and a 2.5-minute one would break it (A3)', () => {
    expect(WEBHOOK_STALE_MS).toBe(300_000);
    expect(() => assertStaleBound(30_000)).not.toThrow();
    expect(() => assertStaleBound(150_001)).toThrow(/stale bound/);
  });

  it('event types sort into the tuple order, duplicates dropped', () => {
    expect(sortEventTypes(['order.dispatched', 'receipt.recorded', 'order.dispatched'])).toEqual(['receipt.recorded', 'order.dispatched']);
  });

  it('story 4-9a (A28): order.delivered is subscribable and sourced from freight_consignment.delivered only', () => {
    expect([...WEBHOOK_EVENT_TYPES]).toEqual(['receipt.recorded', 'order.dispatched', 'order.delivered']);
    expect(WEBHOOK_SOURCE_EVENTS).toEqual({
      'grn.recorded': 'receipt.recorded',
      'order.dispatched': 'order.dispatched',
      'freight_consignment.delivered': 'order.delivered',
    });
    expect(sortEventTypes(['order.delivered', 'receipt.recorded'])).toEqual(['receipt.recorded', 'order.delivered']);
  });
});
