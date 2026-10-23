import { assertEmailSealKeyConfigured } from './mail-secrets';
import { DEFAULT_EMAIL_MAX_PER_TICK, EMAIL_PROVIDERS, type EmailProvider } from './mail-rules';

/**
 * Story 5-1a (decision 4) — the mail module's environment, parsed in one
 * place:
 *
 * | Variable | Meaning |
 * |---|---|
 * | `EMAIL_PROVIDER` | `ses` \| `log` \| `off` (default `off` — every row `skipped`) |
 * | `EMAIL_FROM` | the sending address, a verified SES identity (ses/log: required) |
 * | `EMAIL_REPLY_TO` | the fallback Reply-To when a message has no inviter (optional) |
 * | `WEB_BASE_URL` | the web app's absolute base URL — every link a mail or a response carries (ses/log: required; https in production) |
 * | `EMAIL_MAX_PER_TICK` | messages sent per worker tick across every tenant (default 10) |
 * | `EMAIL_ALLOWLIST_DOMAINS` | when set, an address outside these domains is `skipped` — the staging and seed guard |
 *
 * `EMAIL_SEND_POLL_MS` is the jobs shell's (`EmailSenderWorker`), and
 * `EMAIL_SEAL_KEY` is `mail-secrets.ts`'s (required here for ses/log).
 *
 * `assertMailConfigured()` is the boot check — `main.ts` runs it beside
 * `assertSecondFactorKeyConfigured()`, and `emailGatewayFromEnv` runs it
 * again when the module builds its gateway, so an app built without
 * `main.ts` (the e2e suites) refuses a broken configuration too.
 */
export interface MailConfig {
  readonly provider: EmailProvider;
  /** The bare sending address (`local@domain`); null only when the provider is `off` and none is set. */
  readonly from: string | null;
  readonly replyTo: string | null;
  /** Normalised: no trailing slash, no query or fragment; null only when unset under `off`. */
  readonly webBaseUrl: string | null;
  readonly maxPerTick: number;
  /** Lower-cased domains; null = no allowlist. */
  readonly allowlistDomains: readonly string[] | null;
}

export class MailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailConfigError';
  }
}

/** A bare address — no display name, no angle brackets, no whitespace or control characters. */
const ADDRESS_RE = /^[^\s<>"(),;:\\@[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function blankToNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** `true` for a bare address the config and the sender accept. */
export function isBareEmailAddress(value: string): boolean {
  return value.length <= 254 && ADDRESS_RE.test(value);
}

/**
 * `WEB_BASE_URL` → its normalised form: absolute http(s), no credentials,
 * query or fragment, no trailing slash (a sub-path is kept). `https` is
 * required when `NODE_ENV=production`.
 */
export function normaliseWebBaseUrl(raw: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MailConfigError(`WEB_BASE_URL must be an absolute URL such as https://app.example.in (got "${raw}")`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MailConfigError(`WEB_BASE_URL must be an http(s) URL (got "${raw}")`);
  }
  if (production && url.protocol !== 'https:') {
    throw new MailConfigError(`WEB_BASE_URL must be https when NODE_ENV=production (got "${raw}")`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new MailConfigError(`WEB_BASE_URL must carry no credentials, query or fragment (got "${raw}")`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Parses the mail environment; throws `MailConfigError` (naming the variable) on anything malformed. */
export function mailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const rawProvider = blankToNull(env.EMAIL_PROVIDER) ?? 'off';
  if (!(EMAIL_PROVIDERS as readonly string[]).includes(rawProvider)) {
    throw new MailConfigError(`EMAIL_PROVIDER must be one of ${EMAIL_PROVIDERS.join(', ')} (got "${rawProvider}")`);
  }
  const provider = rawProvider as EmailProvider;
  const sending = provider !== 'off';

  const from = blankToNull(env.EMAIL_FROM);
  if (from !== null && !isBareEmailAddress(from)) {
    throw new MailConfigError(`EMAIL_FROM must be a bare address such as no-reply@mail.example.in (got "${from}")`);
  }
  if (sending && from === null) {
    throw new MailConfigError(`EMAIL_PROVIDER=${provider} requires EMAIL_FROM (a verified SES identity)`);
  }

  const replyTo = blankToNull(env.EMAIL_REPLY_TO);
  if (replyTo !== null && !isBareEmailAddress(replyTo)) {
    throw new MailConfigError(`EMAIL_REPLY_TO must be a bare address (got "${replyTo}")`);
  }

  const rawBase = blankToNull(env.WEB_BASE_URL);
  const webBaseUrl = rawBase === null ? null : normaliseWebBaseUrl(rawBase, env.NODE_ENV === 'production');
  if (sending && webBaseUrl === null) {
    throw new MailConfigError(`EMAIL_PROVIDER=${provider} requires WEB_BASE_URL (the web app's absolute base URL — every emailed link is built from it)`);
  }

  const rawMax = blankToNull(env.EMAIL_MAX_PER_TICK);
  let maxPerTick = DEFAULT_EMAIL_MAX_PER_TICK;
  if (rawMax !== null) {
    const parsed = Number(rawMax);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      throw new MailConfigError(`EMAIL_MAX_PER_TICK must be an integer from 1 to 1000 (got "${rawMax}")`);
    }
    maxPerTick = parsed;
  }

  const rawAllow = blankToNull(env.EMAIL_ALLOWLIST_DOMAINS);
  let allowlistDomains: string[] | null = null;
  if (rawAllow !== null) {
    allowlistDomains = rawAllow
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain !== '');
    const bad = allowlistDomains.filter((domain) => !DOMAIN_RE.test(domain));
    if (bad.length > 0 || allowlistDomains.length === 0) {
      throw new MailConfigError(`EMAIL_ALLOWLIST_DOMAINS must be a comma-separated list of domains (bad: ${bad.join(', ') || '(empty)'})`);
    }
  }

  return { provider, from, replyTo, webBaseUrl, maxPerTick, allowlistDomains };
}

/**
 * The boot check: the parse above, plus `EMAIL_SEAL_KEY` (and a well-formed
 * `_PREVIOUS`) whenever mail is really sent or logged.
 */
export function assertMailConfigured(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const config = mailConfigFromEnv(env);
  if (config.provider !== 'off') assertEmailSealKeyConfigured();
  return config;
}

/**
 * The allowlist guard: `true` when no allowlist is set, or the address's
 * domain (case-insensitive, exact — a sub-domain is not its parent) is on it.
 */
export function addressAllowed(config: Pick<MailConfig, 'allowlistDomains'>, address: string): boolean {
  if (config.allowlistDomains === null) return true;
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  const domain = address.slice(at + 1).toLowerCase();
  return config.allowlistDomains.includes(domain);
}
