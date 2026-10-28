import { Webhook } from 'standardwebhooks';
import { signWebhook, webhookHeaders } from './webhook-signature';
import { generateSigningSecret, openSigningKeys, sealSigningSecret, signingKeyOf } from './webhook-secrets';

/**
 * Story 5-2a (A7) — the Standard Webhooks signature: the frozen reference
 * vector (verified with node:crypto on 2026-10-23), the key being the DECODED
 * bytes after `whsec_` (not the string), and the off-the-shelf
 * `standardwebhooks` library verifying our headers and body — with one and
 * with two (a rotation's overlap) signatures.
 */
describe('webhook signature (story 5-2a, A7)', () => {
  const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const TIMESTAMP = 1614265330;
  const BODY = '{"test": 2432232314}';

  it('signs the reference vector exactly', () => {
    expect(signWebhook(signingKeyOf(SECRET), ID, TIMESTAMP, BODY)).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('keys on the decoded bytes, never the string (mutation check: the string key gives another mac)', () => {
    expect(signWebhook(Buffer.from(SECRET, 'utf8'), ID, TIMESTAMP, BODY)).not.toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('the standardwebhooks library verifies our headers and body', () => {
    const { secret } = generateSigningSecret();
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id: 'e1', type: 'order.dispatched', data: { orderId: 'o1' } });
    const headers = webhookHeaders([signingKeyOf(secret)], 'e1', now, body);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('WMS-Webhooks/1');
    expect(new Webhook(secret).verify(body, headers)).toEqual(JSON.parse(body));
    // A tampered body fails.
    expect(() => new Webhook(secret).verify(`${body} `, headers)).toThrow();
  });

  it('during a rotation two space-separated signatures go out, the current first, and either secret verifies', () => {
    const current = generateSigningSecret().secret;
    const previous = generateSigningSecret().secret;
    const now = Math.floor(Date.now() / 1000);
    const body = '{"a":1}';
    const headers = webhookHeaders([signingKeyOf(current), signingKeyOf(previous)], 'e2', now, body);
    const parts = headers['webhook-signature']!.split(' ');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(signWebhook(signingKeyOf(current), 'e2', now, body));
    expect(new Webhook(current).verify(body, headers)).toEqual({ a: 1 });
    expect(new Webhook(previous).verify(body, headers)).toEqual({ a: 1 });
    expect(() => new Webhook(generateSigningSecret().secret).verify(body, headers)).toThrow();
  });

  it('a stale timestamp is refused by the library (the 5-minute window receivers apply)', () => {
    const { secret } = generateSigningSecret();
    const old = Math.floor(Date.now() / 1000) - 301;
    const headers = webhookHeaders([signingKeyOf(secret)], 'e3', old, '{}');
    expect(() => new Webhook(secret).verify('{}', headers)).toThrow();
  });

  it('a secret is whsec_ + base64 of 32 bytes; its hint the last four characters before the padding (C14)', () => {
    const { secret, hint } = generateSigningSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(signingKeyOf(secret)).toHaveLength(32);
    expect(hint).toBe(secret.slice(-5, -1));
    expect(hint).not.toContain('=');
  });

  it('C21: a previous secret that no longer opens is skipped — the current one alone signs', () => {
    const saved = process.env.WEBHOOK_SEAL_KEY;
    process.env.WEBHOOK_SEAL_KEY = 'a-unit-test-webhook-seal-key-0123456789';
    try {
      const { secret } = generateSigningSecret();
      const row = {
        tenantId: 't1',
        endpointId: 'e1',
        secretSealed: sealSigningSecret(secret, 't1', 'e1'),
        previousSecretSealed: 'v1:deadbeef:AAAA:AAAA:AAAA',
        previousSecretExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      const keys = openSigningKeys(row, Date.now());
      expect(keys).toHaveLength(1);
      expect(keys[0]!.equals(signingKeyOf(secret))).toBe(true);
      // The current one not opening is still the config fault.
      expect(() => openSigningKeys({ ...row, secretSealed: row.previousSecretSealed }, Date.now())).toThrow();
    } finally {
      if (saved === undefined) delete process.env.WEBHOOK_SEAL_KEY;
      else process.env.WEBHOOK_SEAL_KEY = saved;
    }
  });
});
