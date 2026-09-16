import { ProblemException } from '../../shared/problem-details/problem.exception';
import { MAX_CREDENTIAL_FIELDS, MAX_CREDENTIAL_VALUE_LENGTH } from './carrier-credentials';
import type { CredentialValidationFailure } from './carrier-credentials';

/**
 * The carrier-command rejections (Story 4.6b) — one home, no verbatim copies
 * (the `bin.errors.ts` convention).
 *
 * **Every message in this file is written on the assumption that it will be
 * logged.** None of them echoes a supplied credential value: a refusal names
 * the offending FIELD, never what was put in it. That is the one invariant
 * the story exists to hold, and a chatty error message is the easiest way to
 * break it.
 */

/** The unique-violation constraint name backing the idempotency de-dupe (AD-5). */
export const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** One live connection per (tenant, carrier) — the 409 comes off this index. */
export const CARRIER_TENANT_CODE_UNIQUE = 'carrier_connections_tenant_carrier_unique';

/** 400 `validation-failed` — a carrier code the registry does not know. */
export function unknownCarrierCode(code: string, known: readonly string[]): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    'Unknown carrier code',
    `No carrier adapter is registered for "${code}". Known carrier codes: ${known.join(', ')}.`,
  );
}

/** 400 `validation-failed` — the supplied material does not fit the adapter. */
export function credentialRejected(
  carrierCode: string,
  failure: CredentialValidationFailure,
): ProblemException {
  const detail = ((): string => {
    switch (failure.reason) {
      case 'not-an-object':
        return `The "credential" body field must be an object of ${carrierCode} credential fields.`;
      case 'missing-field':
        return `Carrier "${carrierCode}" requires the credential field "${failure.field}" — it was absent or blank.`;
      case 'unknown-field':
        return `Carrier "${carrierCode}" declares no credential field named "${failure.field}".`;
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
 * 400 `validation-failed` — the account label is required, non-blank and
 * bounded. The DTO's `@Length(1, 100)` counts characters, so `'   '` clears
 * it; this is the arm that actually holds the invariant (and keeps a blank
 * label off the DB CHECK, which would surface as a 500).
 */
export function accountLabelRequired(): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    'accountLabel is required',
    'A carrier connection carries a non-blank accountLabel of at most 100 characters.',
  );
}

/**
 * 409 `carrier-already-connected` — a second `connect` for a carrier this
 * tenant already configured. Re-configuring is `rotate`, which keeps the
 * connection id every downstream reference is stored against.
 */
export function carrierAlreadyConnected(carrierCode: string): ProblemException {
  return new ProblemException(
    'carrier-already-connected',
    409,
    'Carrier already connected',
    `This tenant already has a connection for carrier "${carrierCode}" — rotate its credential instead of connecting again.`,
  );
}

/** 404 `not-found` — no such connection in THIS tenant (cross-tenant included). */
export function carrierConnectionNotFound(): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Carrier connection not found',
    'No carrier connection with this id exists in this tenant.',
  );
}

/**
 * 503 `carrier-encryption-unavailable` — the deployment has no (or a too
 * short) `CARRIER_ENCRYPTION_KEY`. Mirrors 3.2's
 * `device-encryption-unavailable`: a raw throw from inside the transaction
 * would surface as a 500 and say nothing useful. Nothing is written.
 */
export function carrierEncryptionUnavailable(): ProblemException {
  return new ProblemException(
    'carrier-encryption-unavailable',
    503,
    'Carrier connections temporarily unavailable',
    'The server is missing CARRIER_ENCRYPTION_KEY — carrier connections are unavailable until the deployment sets it (see .env.example).',
  );
}

/**
 * 503 `carrier-credential-unreadable` — the sealed blob will not open under
 * the current master key. AES-GCM authenticates, so this fails closed instead
 * of handing back garbage; the cause is a key changed after the material was
 * sealed, and the fix is a rotation under the current key.
 */
export function carrierCredentialUnreadable(connectionId: string): ProblemException {
  return new ProblemException(
    'carrier-credential-unreadable',
    503,
    'Carrier credential cannot be opened',
    `The stored credential for connection ${connectionId} does not open under the current CARRIER_ENCRYPTION_KEY — rotate the connection to re-seal it under the current key.`,
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

/** 400 `invalid-cursor` — a crafted cursor never reaches the `::uuid` cast. */
export function invalidCursor(): ProblemException {
  return new ProblemException(
    'invalid-cursor',
    400,
    'Malformed pagination cursor',
    'The `cursor` query parameter is not a cursor this endpoint issued.',
  );
}

/**
 * 400 `validation-failed` — a uuid path param that is not a uuid. Called from
 * `carriers.controller.ts`, so the refusal is stated once (this file's rule)
 * rather than re-implemented at the boundary.
 */
export function invalidUuidParam(name: string, value: string): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    `${name} must be a uuid`,
    `The "${name}" path parameter must be a uuid (got "${value}").`,
  );
}
