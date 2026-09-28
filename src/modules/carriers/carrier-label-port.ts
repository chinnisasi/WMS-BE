/**
 * The carrier label port (Story 4.6c) — the port's first real arm, grown from
 * `carrier-registry.ts` exactly as that file's header promised ("the port
 * grows those arms in the story that consumes them"). Story 4.6d grows the
 * second arm — `rate` — in the story that consumes it, beside the label arm.
 *
 * Shape: a label arm takes the adapter-use credential (request-scoped
 * plaintext, `openCredentialForAdapterUse`'s contract) plus the request, and
 * answers the two things a label IS — a tracking number and an opaque
 * document reference. **Never the document bytes**, and never anything about
 * the credential.
 *
 * The three DIRECT carriers have no transport integration yet (the story's
 * Never list: no HTTP client, no network in tests), so they register
 * `unconfiguredLabelArm` — a typed, verbatim, retryable 501 refusal. The
 * fourth registry entry, `sandbox`, is the documented stand-in (the
 * `envelope.ts` / `LoggingEventBus` precedent): a deterministic in-process
 * arm that makes the whole label → dispatch → manifest path real end-to-end
 * without a network. Its determinism is the point — the same request always
 * answers the same tracking number, so replay and e2e assertions are exact.
 *
 * The rate arms (4.6d) mirror the label pair: `unconfiguredRateArm` is THE
 * SAME typed verbatim 501 the label arm throws (one refusal per deployment —
 * the carriers module has no second unconfigured message to drift), and
 * `sandboxRateArm` prices deterministically in-process off the pincode pair
 * and the shippable weight. A rate arm answers an integer paise amount and
 * nothing else — never money in any other unit, never anything about the
 * credential.
 *
 * This file imports only TYPES from `carrier-registry.ts` — the registry
 * imports THIS file's arm functions, so keeping the reverse edge type-only
 * keeps the import graph cycle-free at runtime.
 */
import { createHash } from 'node:crypto';
import type { CarrierCredential } from './carrier-credentials';
import { carrierTransportUnconfigured } from './carriers.errors';

/** What the label command asks the carrier for. All identity is system-side. */
export interface CarrierLabelRequest {
  /** The order reference the label is for (the shipment points back at it). */
  readonly orderRef: string;
  /** Optional measurement, same bounds as pack — the shipment's durable columns. */
  readonly weightGrams: number | null;
  /** Optional measurement, same bounds as pack; arms present together or absent. */
  readonly dimensions:
    | { readonly lengthMm: number; readonly widthMm: number; readonly heightMm: number }
    | null;
}

/** What a label arm answers: the adapter-issued identity of the shipment. */
export interface CarrierLabelResult {
  /** The carrier's tracking number — what dispatch auto-stamps. */
  readonly trackingNumber: string;
  /** Opaque handle for the label document — never the bytes, never a URL to fetch here. */
  readonly labelDocumentRef: string;
}

/**
 * One label arm. The credential is REQUEST-SCOPED plaintext under the
 * `openCredentialForAdapterUse` rules: never logged, never persisted, never
 * in any response or event — the arm consumes it in-process and it dies with
 * the request.
 */
export type CarrierLabelArm = (
  credential: CarrierCredential,
  request: CarrierLabelRequest,
) => Promise<CarrierLabelResult>;

/**
 * The DIRECT carriers' arm until their real transports land: a typed,
 * verbatim, retryable refusal (501 `carrier-transport-unconfigured`). The
 * refusal is a first-class rendered arm, not a swallowed error — the surface
 * keeps the retry affordance, and nothing is written anywhere.
 */
export function unconfiguredLabelArm(carrierCode: string): CarrierLabelArm {
  return async (): Promise<CarrierLabelResult> => {
    throw carrierTransportUnconfigured(carrierCode);
  };
}

/**
 * The sandbox carrier's deterministic label arm (the human decision,
 * 2026-09-28): sha256 over the request's canonical form yields the tracking
 * number and document ref, so the same request always answers identically —
 * replay reads the stored row anyway, but determinism makes the e2e
 * assertions exact instead of shape-only.
 */
export function sandboxLabelArm(): CarrierLabelArm {
  return async (_credential, request) => {
    const canonical = [
      request.orderRef,
      request.weightGrams === null ? '' : String(request.weightGrams),
      request.dimensions === null
        ? ''
        : `${request.dimensions.lengthMm}x${request.dimensions.widthMm}x${request.dimensions.heightMm}`,
    ].join('|');
    const digest = createHash('sha256').update(canonical).digest('hex').toUpperCase();
    return {
      trackingNumber: `SBX-${digest.slice(0, 12)}`,
      labelDocumentRef: `sandbox://labels/${digest.toLowerCase()}`,
    };
  };
}

/**
 * The one entry the label command uses lives on the facade file
 * (`labelThroughAdapter`, which resolves the adapter by code and calls its
 * arm) — deliberately NOT here: this file imports only TYPES from
 * `carrier-registry.ts`, so the registry → port → (type-only) import graph
 * has no runtime cycle at all.
 */

// ── the rate arm (Story 4.6d) ─────────────────────────────────────────────────

/** What the rate read asks the carrier for. All identity is system-side. */
export interface CarrierRateRequest {
  /** The order reference being priced (read-only — rating writes nothing). */
  readonly orderRef: string;
  /**
   * The origin pincode — the warehouse's, read at rate time. Null on rows
   * created before 11-1 made the address required (the column reads null).
   */
  readonly originPincode: string | null;
  /** The destination pincode — the order's, point-in-time at create. Null on pre-11-1 rows. */
  readonly destinationPincode: string | null;
  /**
   * The order's shippable weight in grams — the line×SKU aggregate. Null when
   * the caller cannot weight the order (the outbound side refuses such an
   * order with 409 before any arm runs — the type stays honest for arms
   * consumed outside that guard).
   */
  readonly weightGrams: number | null;
}

/**
 * What a rate arm answers: the quote in INTEGER PAISE (AD-9 — money is an
 * integer paise amount everywhere in this codebase; no float, no rupee
 * decimal, no currency code — the quote is an INR rate).
 */
export interface CarrierRateResult {
  readonly amountPaise: number;
}

/** One rate arm — the credential contract is the label arm's, verbatim. */
export type CarrierRateArm = (
  credential: CarrierCredential,
  request: CarrierRateRequest,
) => Promise<CarrierRateResult>;

/**
 * The DIRECT carriers' rate arm until their real transports land: THE SAME
 * typed verbatim 501 `carrier-transport-unconfigured` the label arm throws —
 * the same refusal, the same retryable shape, rendered as a refused item by
 * the rate read rather than as the whole response's failure.
 */
export function unconfiguredRateArm(carrierCode: string): CarrierRateArm {
  return async (): Promise<CarrierRateResult> => {
    throw carrierTransportUnconfigured(carrierCode);
  };
}

/**
 * The sandbox carrier's deterministic rate arm (4.6d's Design Notes): base +
 * per-kg + a pincode-pair jitter band, all integer paise — a formula, not a
 * bare hash, so heavier orders quote more (the quote must respond sensibly to
 * its inputs) while staying exactly reproducible in tests by recomputation.
 * An unweighted request prices at zero carried weight (the base fare).
 */
export function sandboxRateArm(): CarrierRateArm {
  return async (_credential, request) => {
    const weight = request.weightGrams === null ? 0 : request.weightGrams;
    const digest = createHash('sha256')
      .update(
        `sandbox-rate|${request.originPincode ?? ''}|${request.destinationPincode ?? ''}`,
      )
      .digest();
    const jitter = digest.readUInt32BE(0) % 1500;
    return { amountPaise: 2500 + 500 * Math.ceil(weight / 1000) + jitter };
  };
}