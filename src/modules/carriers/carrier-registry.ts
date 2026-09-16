/**
 * The carrier adapter registry (Story 4.6b, AD-6/AD-15) — the compile-time
 * half of the carrier substrate. It answers the question the repo has had no
 * answer to since the AD-6 boundary was declared: **which carriers can a
 * tenant ship with, and what does each one need to be configured with.**
 *
 * An adapter here is a DECLARATIVE DESCRIPTOR: carrier code, display name,
 * and the credential fields that carrier requires. `rate()`, `label()` and
 * `track()` are deliberately NOT declared — nothing calls them today (rating
 * is deferred; labels and manifests are 4-6c), and a method signature guessed
 * before its first caller is a shipped interface to unpick. The port grows
 * those arms in the story that consumes them; this file is the seam they grow
 * from. **This story makes no network calls** and the backend gains no HTTP
 * client.
 *
 * The registry follows `inventory/ledger-registry.ts`, not a DI token: every
 * existing port seam in the repo (`LEDGER_ANCHOR_STORE`, `WAVE_CLOCK`, the
 * outbox seams) has exactly one production implementation, so none of them is
 * a precedent for N providers selected by name. An import-time `Map`
 * populated by `registerCarrierAdapter`, throwing on a duplicate code, is the
 * repo's own pattern for a registry of named arms — and it is ADDITIVE: a new
 * carrier is one `registerCarrierAdapter` call and no migration.
 */

/** One credential field a carrier declares it needs to be configured with. */
export interface CarrierCredentialField {
  /** The wire name inside the `credential` object (camelCase). */
  readonly name: string;
  /** Human label for whatever surface eventually asks for it. */
  readonly label: string;
  /** A required field absent (or blank) at connect/rotate is a 400. */
  readonly required: boolean;
  /** What the operator should paste here (shown by the future surface). */
  readonly description: string;
}

/** The carrier port, Story 4.6b shape: identity + credential requirements. */
export interface CarrierAdapter {
  /** Stable machine code — the `carrier_connections.carrier_code` value. */
  readonly code: string;
  /** Human name for the catalogue and for refusal messages. */
  readonly displayName: string;
  /** What this carrier's account needs. Declaration order is wire order. */
  readonly credentialFields: readonly CarrierCredentialField[];
}

const REGISTRY = new Map<string, CarrierAdapter>();

/**
 * The one registration point. Registering a duplicate code fails loudly at
 * import time — a carrier is declared once (the `registerLedgerEventType`
 * rule).
 */
export function registerCarrierAdapter(adapter: CarrierAdapter): void {
  if (REGISTRY.has(adapter.code)) {
    throw new Error(`Carrier adapter already registered: ${adapter.code}`);
  }
  if (adapter.credentialFields.length === 0) {
    // A carrier with no credential fields would make `connect` a no-op that
    // seals an empty record — there would be nothing to rotate and nothing to
    // protect. Every carrier needs at least one field.
    throw new Error(`Carrier adapter declares no credential fields: ${adapter.code}`);
  }
  const seen = new Set<string>();
  for (const field of adapter.credentialFields) {
    if (seen.has(field.name)) {
      throw new Error(`Carrier adapter ${adapter.code} declares duplicate field: ${field.name}`);
    }
    seen.add(field.name);
  }
  REGISTRY.set(adapter.code, adapter);
}

/**
 * The three DIRECT carriers (human decision, 2026-09-16 — closes OQ1, open
 * since the 4.6 gate). Shiprocket, the fourth epic candidate, is deliberately
 * excluded: it is an *aggregator* fronting other carriers, so its credential
 * shape and its eventual rate/label shape differ in kind from a direct
 * carrier's, and absorbing that difference into the port before any consumer
 * exists is exactly the guessing OQ1 was held open to avoid. Aggregator
 * support stays a later decision, not a foreclosed one.
 */
registerCarrierAdapter({
  code: 'delhivery',
  displayName: 'Delhivery',
  credentialFields: [
    {
      name: 'apiToken',
      label: 'API token',
      required: true,
      description: 'The Delhivery API token issued for this client account.',
    },
    {
      name: 'clientName',
      label: 'Client name',
      required: true,
      description: 'The registered Delhivery client name the token belongs to.',
    },
  ],
});

registerCarrierAdapter({
  code: 'blue_dart',
  displayName: 'Blue Dart',
  credentialFields: [
    {
      name: 'licenceKey',
      label: 'Licence key',
      required: true,
      description: 'The Blue Dart API licence key for this customer code.',
    },
    {
      name: 'loginId',
      label: 'Login ID',
      required: true,
      description: 'The Blue Dart API login id paired with the licence key.',
    },
    {
      name: 'customerCode',
      label: 'Customer code',
      required: false,
      description: 'Optional customer code, when the account uses one.',
    },
  ],
});

registerCarrierAdapter({
  code: 'ecom_express',
  displayName: 'Ecom Express',
  credentialFields: [
    {
      name: 'username',
      label: 'Username',
      required: true,
      description: 'The Ecom Express API username.',
    },
    {
      name: 'password',
      label: 'Password',
      required: true,
      description: 'The Ecom Express API password.',
    },
  ],
});

/** The registered adapter, or undefined for a code the registry never knew. */
export function getCarrierAdapter(code: string): CarrierAdapter | undefined {
  return REGISTRY.get(code);
}

export function isKnownCarrierCode(code: string): boolean {
  return REGISTRY.has(code);
}

/** Every registered code, sorted — what a refusal lists back to the caller. */
export function knownCarrierCodes(): readonly string[] {
  return [...REGISTRY.keys()].sort();
}

/**
 * The catalogue read: every adapter, code-sorted. This is how ANY future
 * surface (web settings, 4-6c's label flow) learns what to ask an operator
 * for — the credential shape is never hard-coded client-side.
 */
export function listCarrierAdapters(): readonly CarrierAdapter[] {
  return knownCarrierCodes().map((code) => REGISTRY.get(code)!);
}
