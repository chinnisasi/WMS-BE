import { createHmac } from 'node:crypto';

/**
 * Story 5-2a (decision 9, A7) — the Standard Webhooks signature, so a
 * receiver can verify with an off-the-shelf library (`standardwebhooks`,
 * `svix`):
 *
 *   webhook-id:        the event id (stable across retries and redeliveries — the dedupe key)
 *   webhook-timestamp: unix seconds, set per attempt
 *   webhook-signature: `v1,<base64 HMAC-SHA256(key, "{id}.{timestamp}.{body}")>`
 *
 * The key is the decoded secret (`signingKeyOf`). During a rotation's overlap
 * the header carries one space-separated `v1,` entry per key, the current
 * first; a receiver accepts any match. Receivers refuse a timestamp more than
 * five minutes off (`WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`).
 */

export const WEBHOOK_USER_AGENT = 'WMS-Webhooks/1';

/** One `v1,<sig>` entry. */
export function signWebhook(key: Buffer, id: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64');
  return `v1,${mac}`;
}

/** The headers of one attempt, signed with every key given (the current first). */
export function webhookHeaders(keys: readonly Buffer[], id: string, timestamp: number, body: string): Record<string, string> {
  if (keys.length === 0) throw new Error('A webhook needs at least one signing key');
  return {
    'content-type': 'application/json',
    'user-agent': WEBHOOK_USER_AGENT,
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': keys.map((key) => signWebhook(key, id, timestamp, body)).join(' '),
  };
}
