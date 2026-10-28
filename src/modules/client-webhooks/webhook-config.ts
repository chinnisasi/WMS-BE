import { BlockList, isIP } from 'node:net';
import { assertWebhookSealKeyConfigured } from './webhook-secrets';
import { assertStaleBound } from './webhook-rules';

/**
 * Story 5-2a (decision 15 as amended by A3, A4, A8, A14) — the module's
 * environment, parsed in one place:
 *
 * | Variable | Meaning | Where |
 * |---|---|---|
 * | `WEBHOOK_GATEWAY` | `off` (default — the sender claims nothing; rows stay pending until they expire; the sweep still runs) \| `https` | api + worker (only the worker's value sends; the API reads it for the `webhooks-unavailable` warning and the test send) |
 * | `WEBHOOK_SEAL_KEY` | the signing-secret seal key, ≥ 32 characters (`webhook-secrets.ts`); `_PREVIOUS` while rotating | api + worker |
 * | `WEBHOOK_MAX_PER_TICK` | deliveries claimed per worker tick across every tenant (default 50, 1–1000) | worker |
 * | `WEBHOOK_HTTP_TIMEOUT_MS` | one send's total timeout (default 10000, 1000–30000) | api + worker |
 * | `WEBHOOK_SEND_CONCURRENCY` | sends in flight per process (default 8, 1–64) | worker |
 * | `WEBHOOK_DENY_HOSTS` | comma-separated hostnames of this deployment (its API and web hosts), refused at save and at send | api + worker |
 * | `WEBHOOK_DENY_CIDRS` | comma-separated extra CIDRs refused at send (beside the built-in non-public ranges) | api + worker |
 *
 * `WEBHOOK_SEND_POLL_MS` is the jobs shell's (`WebhookSenderWorker`).
 * `assertWebhooksConfigured()` is the boot check `main.ts` runs: a malformed
 * value, or `https` without a usable `WEBHOOK_SEAL_KEY`, refuses the boot.
 */

export const WEBHOOK_GATEWAY_MODES = ['off', 'https'] as const;
export type WebhookGatewayMode = (typeof WEBHOOK_GATEWAY_MODES)[number];

export const DEFAULT_WEBHOOK_MAX_PER_TICK = 50;
export const DEFAULT_WEBHOOK_HTTP_TIMEOUT_MS = 10_000;
export const MAX_WEBHOOK_HTTP_TIMEOUT_MS = 30_000;
export const DEFAULT_WEBHOOK_SEND_CONCURRENCY = 8;

export interface WebhookConfig {
  readonly gateway: WebhookGatewayMode;
  readonly maxPerTick: number;
  readonly httpTimeoutMs: number;
  readonly sendConcurrency: number;
  /** Lower-cased, no trailing dot. */
  readonly denyHosts: readonly string[];
  /** The extra CIDRs as written (validated). */
  readonly denyCidrs: readonly string[];
}

export class WebhookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookConfigError';
  }
}

function blankToNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function intIn(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = blankToNull(raw);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new WebhookConfigError(`${name} must be an integer from ${min} to ${max} (got "${value}")`);
  }
  return parsed;
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** A CIDR (`10.1.0.0/16`, `2001:db8::/32`) → its parts; throws on anything else. */
export function parseCidr(raw: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } {
  const [address, prefixText, extra] = raw.trim().split('/');
  const family = isIP(address ?? '');
  // Code review C23 — digits only: `Number('')` is 0, so `10.0.0.0/` would have read as /0 (every address).
  const prefix = prefixText !== undefined && /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
  if (extra !== undefined || family === 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
    throw new WebhookConfigError(`WEBHOOK_DENY_CIDRS entry "${raw}" is not a CIDR such as 10.20.0.0/16 or fd00::/8`);
  }
  return { address: address!, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
}

/** Parses the webhook environment; throws `WebhookConfigError` naming the variable. */
export function webhookConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookConfig {
  const rawGateway = blankToNull(env.WEBHOOK_GATEWAY) ?? 'off';
  if (!(WEBHOOK_GATEWAY_MODES as readonly string[]).includes(rawGateway)) {
    throw new WebhookConfigError(`WEBHOOK_GATEWAY must be one of ${WEBHOOK_GATEWAY_MODES.join(', ')} (got "${rawGateway}")`);
  }
  const httpTimeoutMs = intIn('WEBHOOK_HTTP_TIMEOUT_MS', env.WEBHOOK_HTTP_TIMEOUT_MS, DEFAULT_WEBHOOK_HTTP_TIMEOUT_MS, 1000, MAX_WEBHOOK_HTTP_TIMEOUT_MS);
  try {
    assertStaleBound(httpTimeoutMs);
  } catch (err) {
    throw new WebhookConfigError((err as Error).message);
  }
  const denyHosts = (blankToNull(env.WEBHOOK_DENY_HOSTS) ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ''))
    .filter((host) => host !== '');
  const badHosts = denyHosts.filter((host) => !HOST_RE.test(host));
  if (badHosts.length > 0) {
    throw new WebhookConfigError(`WEBHOOK_DENY_HOSTS must be a comma-separated list of hostnames (bad: ${badHosts.join(', ')})`);
  }
  const denyCidrs = (blankToNull(env.WEBHOOK_DENY_CIDRS) ?? '')
    .split(',')
    .map((cidr) => cidr.trim())
    .filter((cidr) => cidr !== '');
  for (const cidr of denyCidrs) parseCidr(cidr);
  return {
    gateway: rawGateway as WebhookGatewayMode,
    maxPerTick: intIn('WEBHOOK_MAX_PER_TICK', env.WEBHOOK_MAX_PER_TICK, DEFAULT_WEBHOOK_MAX_PER_TICK, 1, 1000),
    httpTimeoutMs,
    sendConcurrency: intIn('WEBHOOK_SEND_CONCURRENCY', env.WEBHOOK_SEND_CONCURRENCY, DEFAULT_WEBHOOK_SEND_CONCURRENCY, 1, 64),
    denyHosts,
    denyCidrs,
  };
}

/** The extra deny ranges as a `BlockList` (the built-in ranges live in `webhook-http.ts`). */
export function extraDenyList(config: Pick<WebhookConfig, 'denyCidrs'>): BlockList {
  const list = new BlockList();
  for (const cidr of config.denyCidrs) {
    const { address, prefix, family } = parseCidr(cidr);
    list.addSubnet(address, prefix, family);
  }
  return list;
}

/** The boot check: the parse above, plus a usable `WEBHOOK_SEAL_KEY` whenever webhooks are really sent. */
export function assertWebhooksConfigured(env: NodeJS.ProcessEnv = process.env): WebhookConfig {
  const config = webhookConfigFromEnv(env);
  if (config.gateway === 'https') assertWebhookSealKeyConfigured();
  return config;
}
