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
 * 404 `not-found` — the config PUT's ingest warehouse is unknown or foreign
 * (7.2, T1). Named for the config arm; the buffers refusal keeps its own.
 */
export function ingestWarehouseNotFound(warehouseId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Warehouse not found',
    `No warehouse ${warehouseId} exists in this tenant — the ingest warehouse must be one of the connection's own.`,
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

// ── story 7.2: the ingest + writeback refusals (RD-1..RD-9) ─────────────────
// The webhook arm's messages never name channel-side content beyond the ids
// the tenant already owns, and never a credential value or raw payload.

/**
 * 422 `order-source-conflict` — a verified delivery whose MAPPED content
 * diverges from the order the ref already created (RD-1; the out bound
 * command's same-code refusal — declared here too so the webhook layer and
 * the command agree on the code string).
 */
export const ORDER_SOURCE_CONFLICT_CODE = 'order-source-conflict';

/**
 * 422 `ingest-warehouse-unset` — a delivered order for a connection whose
 * config never set `ingest_warehouse_id` (RD-4). NACK: the channel retries;
 * remediation is the config PUT.
 */
export function ingestWarehouseUnset(connectionId: string): ProblemException {
  return new ProblemException(
    'ingest-warehouse-unset',
    422,
    'Ingest warehouse is not set',
    `Connection ${connectionId} has no ingest warehouse configured — set it with the config PUT (PUT .../connections/{id}) before this channel can ingest orders.`,
  );
}

/**
 * 422 `ingest-config-invalid` — the ingest REFERENCES resolve to master data
 * that left after being configured (the ingest warehouse was deleted, or a
 * mapped SKU was). NACK: the channel retries into the same refusal; the
 * remediation is the mapping/config PUT. Never a 404 (a 404 would tell the
 * channel the DELIVERY is wrong — the configuration is).
 */
export function ingestConfigInvalid(connectionId: string, detail: string): ProblemException {
  return new ProblemException(
    'ingest-config-invalid',
    422,
    'Channel ingest configuration is invalid',
    `Connection ${connectionId}'s ingest configuration references master data that no longer exists — ${detail}. Remediate with the config PUT / mappings PUT; the channel retries this delivery.`,
  );
}

/**
 * 409 `order-backorder-rejected` — RD-3's whole-order post-grant refusal
 * under `backorder_policy: 'reject'`: any line whose grant came back short
 * (zero-grant included) releases everything and refuses the order. No order
 * row exists, so the detail names no order.
 */
export function orderBackorderRejected(connectionId: string): ProblemException {
  return new ProblemException(
    'order-backorder-rejected',
    409,
    'Order rejected under the backorder policy',
    `Connection ${connectionId} is configured to REJECT backorders; some line could not fully reserve at grant time, so the whole order was refused and every reservation it moved was released (the fail-safe direction).`,
  );
}

/**
 * 403 `order-actor-unprivileged` — RD-2's fail-closed actor: the
 * connection's `connected_by` (the ingestion's authority) has lost
 * `orders.manage` since connecting. NACK — the channel retries; the
 * remediation is re-connecting with an eligible account.
 */
export function orderActorUnprivileged(connectionId: string): ProblemException {
  return new ProblemException(
    'order-actor-unprivileged',
    403,
    'The ingest actor has lost the orders capability',
    `Connection ${connectionId}'s connected_by no longer holds "orders.manage" — the ingest refuses closed. Remediation: reconnect the channel with an account that holds it.`,
  );
}

/**
 * 503 `cancellation-unresolved` — RD-8: a cancellation for an order ref the
 * order tables have never committed (the create/cancel race, or a foreign
 * ref). NACK: the channel retries and resolves on the retry once the create
 * lands; a ref that never resolves is abandoned by the channel's own retry
 * budget — an order we never created holds nothing to leak.
 */
export function cancellationUnresolved(connectionId: string, orderRef: string): ProblemException {
  return new ProblemException(
    'cancellation-unresolved',
    503,
    'Cancellation cannot be resolved to an order',
    `No order for connection ${connectionId} carries external ref "${orderRef}" (yet) — retry; the cancellation settles once the order's create has committed.`,
  );
}

/**
 * 400 `validation-failed` — a verified, parsed delivery whose content
 * cannot become an order because the TENANT'S configuration misses
 * something (an unmapped external ref). Named differently from the
 * transport's own `validationFailed` helper to keep the two 400 families
 * greppable.
 */
export function validationFailedIngest(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Ingest mapping failed', detail);
}

/**
 * 501 `channel-transport-unconfigured` — the webhook endpoint's registry
 * gate (RD-5/RD-6): the provider declares no webhook configuration (today:
 * `amazon-in`/`flipkart`). The typed verbatim refusal, before any
 * credential is touched.
 */
export function channelWebhookUnconfigured(provider: string): ProblemException {
  return new ProblemException(
    'channel-transport-unconfigured',
    501,
    'Channel transport not configured',
    `Channel "${provider}" has no webhook ingest transport on this deployment — its real integration has not been configured yet. Retry once it lands.`,
  );
}