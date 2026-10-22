import { assertKeyringConfigured, open, seal, type Keyring } from '../../shared/crypto/seal';

/**
 * Story 5-1a — the mail queue's sealed secrets. THE ONLY FILE THAT NAMES
 * `EMAIL_SEAL_KEY` (pinned by `test/architecture.spec.ts`): the secret a
 * message needs only at send time (an invite's raw token) is sealed under it
 * in `email_messages.sealed_secret`, with associated data
 * `tenant_id:message_id` — a blob copied to another row will not open — and
 * wiped once the row is final (the 0089 CHECK enforces the wipe).
 *
 * The key is at least 32 characters; `EMAIL_SEAL_KEY_PREVIOUS` opens rows
 * sealed before a rotation (`shared/crypto/seal.ts`). Losing the key loses
 * only the queued, unsent messages (they fail `unsealable`; resend mints a
 * fresh token) — nothing durable is sealed under it.
 */

export const EMAIL_SEAL_KEY_MIN_LENGTH = 32;

export class MissingEmailSealKeyError extends Error {
  constructor(which: 'current' | 'previous') {
    super(
      which === 'previous'
        ? `EMAIL_SEAL_KEY_PREVIOUS is set but shorter than ${EMAIL_SEAL_KEY_MIN_LENGTH} characters — set the full previous key, or unset it.`
        : `EMAIL_SEAL_KEY is required when EMAIL_PROVIDER is ses or log (set it to at least ${EMAIL_SEAL_KEY_MIN_LENGTH} characters; see .env.example).`,
    );
    this.name = 'MissingEmailSealKeyError';
  }
}

const EMAIL_KEYRING: Keyring = {
  env: 'EMAIL_SEAL_KEY',
  minLength: EMAIL_SEAL_KEY_MIN_LENGTH,
  missing: (which) => new MissingEmailSealKeyError(which),
};

/** The boot check (ses / log only): a usable key, and a well-formed `_PREVIOUS` when one is set. */
export function assertEmailSealKeyConfigured(): void {
  assertKeyringConfigured(EMAIL_KEYRING);
}

function associatedData(tenantId: string, messageId: string): string {
  return `${tenantId}:${messageId}`;
}

/** Seals a message's send-time secret for exactly this row. */
export function sealEmailSecret(secret: string, tenantId: string, messageId: string): string {
  return seal(EMAIL_KEYRING, Buffer.from(secret, 'utf8'), associatedData(tenantId, messageId));
}

/** Opens it; throws when malformed, sealed for another row, or under a key no longer configured. */
export function openEmailSecret(sealed: string, tenantId: string, messageId: string): string {
  return open(EMAIL_KEYRING, sealed, associatedData(tenantId, messageId)).toString('utf8');
}
