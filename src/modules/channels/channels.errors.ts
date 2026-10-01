import { ProblemException } from '../../shared/problem-details/problem.exception';
import { MAX_CREDENTIAL_FIELDS, MAX_CREDENTIAL_VALUE_LENGTH } from './channel-credentials';
import type { CredentialValidationFailure } from './channel-credentials';

/**
 * The channel-command rejections (Story 7.1) — one home, no verbatim copies
 * (`bin.errors.ts` / `carriers.errors.ts` convention).
 *
 * **Every message in this file is written on the assumption that it will be
 * logged.** None of them echoes a supplied credential value: a refusal names
 * the offending FIELD, never what was put in it.
 */

/** The unique-violation constraint name backing the idempotency de-dupe (AD-5). */
export const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** One live connection per (tenant, provider) — the 409 comes off this index. */
export const CHANNEL_TENANT_PROVIDER_UNIQUE = 'integrations_tenant_provider_unique';

/** 400 `validation-failed` — a channel code the registry does not know. */
export function unknownChannelProvider(code: string, known: readonly string[]): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    'Unknown channel provider',
    `No channel adapter is registered for "${code}". Known channel providers: ${known.join(', ')}.`,
  );
}

/** 400 `validation-failed` — the supplied material does not fit the adapter. */
export function channelCredentialRejected(
  provider: string,
  failure: CredentialValidationFailure,
): ProblemException {
  const detail = ((): string => {
    switch (failure.reason) {
      case 'not-an-object':
        return `The "credentials" body field must be an object of ${provider} credential fields.`;
      case 'missing-field':
        return `Channel "${provider}" requires the credential field "${failure.field}" — it was absent or blank.`;
      case 'unknown-field':
        return `Channel "${provider}" declares no credential field named "${failure.field}".`;
      case 'non-string-value':
        return `The credential field "${failure.field}" must be a string.`;
      case 'value-too-long':
        return `The credential field "${failure.field}" exceeds the ${MAX_CREDENTIAL_VALUE_LENGTH}-character maximum.`;
      case 'too-many-fields':
        return `A credential carries at most ${MAX_CREDENTIAL_FIELDS} fields.`;
    }
  })();
  return new ProblemException('validation-failed', 400, 'Credential rejected', detail);
}

/**
 * 409 `connection-exists` — a second `connect` for a provider this tenant
 * already configured. Re-configuring is `rotate` (credentials) or
 * `updateConnectionConfig` (backorder policy), which keep the connection id
 * every mapping and buffer is stored against.
 */
export function channelConnectionExists(provider: string): ProblemException {
  return new ProblemException(
    'connection-exists',
    409,
    'Channel connection already exists',
    `This tenant already has a connection for channel "${provider}" — rotate its credential instead of connecting again.`,
  );
}

/** 404 `not-found` — no such connection in THIS tenant (cross-tenant included). */
export function channelConnectionNotFound(): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Channel connection not found',
    'No channel connection with this id exists in this tenant.',
  );
}

/** 404 `not-found` — a buffers item names a warehouse outside this tenant. */
export function bufferWarehouseNotFound(warehouseId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Warehouse not found',
    `No warehouse ${warehouseId} exists in this tenant.`,
  );
}

/** 404 `not-found` — a buffers item names a sku outside this tenant. */
export function bufferSkuNotFound(skuId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'SKU not found',
    `No sku ${skuId} exists in this tenant.`,
  );
}

/**
 * 503 `channel-encryption-unavailable` — the deployment has no (or a too
 * short) `CHANNEL_ENCRYPTION_KEY`. A raw throw from inside the transaction
 * would surface as a 500 and say nothing useful. Nothing is written.
 */
export function channelEncryptionUnavailable(): ProblemException {
  return new ProblemException(
    'channel-encryption-unavailable',
    503,
    'Channel connections temporarily unavailable',
    'The server is missing CHANNEL_ENCRYPTION_KEY — channel connections are unavailable until the deployment sets it (see .env.example).',
  );
}

/**
 * 503 `channel-credential-unreadable` — the sealed blob will not open under
 * the current master key (the key changed after the material was sealed; the
 * fix is a rotation under the current key). AES-GCM authenticates, so this
 * fails closed instead of handing back garbage.
 */
export function channelCredentialUnreadable(connectionId: string): ProblemException {
  return new ProblemException(
    'channel-credential-unreadable',
    503,
    'Channel credential cannot be opened',
    `The stored credential for connection ${connectionId} does not open under the current CHANNEL_ENCRYPTION_KEY — rotate the connection to re-seal it under the current key.`,
  );
}

/** 409 — the same Idempotency-Key is being processed concurrently. */
export function concurrentIdempotency(): ProblemException {
  return new ProblemException(
    'conflict',
    409,
    'Concurrent idempotent request',
    'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
  );
}

/**
 * 400 `validation-failed` — a uuid path param that is not a uuid. Called from
 * `channels.controller.ts`, so the refusal is stated once (this file's rule).
 */
export function invalidUuidParam(name: string, value: string): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    `${name} must be a uuid`,
    `The "${name}" path parameter must be a uuid (got "${value}").`,
  );
}