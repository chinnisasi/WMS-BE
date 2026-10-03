/**
 * The GSTIN primitive (story 8-1). A standalone file (the `bin-capacity`
 * pattern): a DTO must be able to import the shape WITHOUT pulling its
 * module's command graph in at load time, and the migration CHECK + the
 * tenancy normalizer + the outbound create-order command all share the one
 * regex — a shape stated twice drifts.
 *
 * The accepted shape is deliberately permissive: two leading digits (the
 * state code — place-of-supply resolution reads them) + thirteen
 * alphanumeric characters. The structural PAN/entity/checksum anatomy lives
 * in the CBIC format and is validated in full by the 8-2 regulatory pass;
 * storing today only what invoicing resolves (state code + party identity)
 * keeps this gate from inventing rules the regulator has not been asked
 * about here. Case: the canonical form is uppercase.
 */

/** The full shape — what the columns' CHECKs mirror and the validating edge throws on. */
export const GSTIN_RE = /^[0-9]{2}[A-Za-z0-9]{13}$/;

/**
 * The LENIENT normalize step (the `normalizeAddressInput` role): trim +
 * uppercase, a whitespace-only value reads as absent. NO shape validation —
 * this is what the idempotency payload hash fingerprints, so it must never
 * throw (a replayed key hashes FIRST; the shape refusal lives behind the
 * command's replay lookup, as every other input's does).
 */
export function normalizeGstinInput(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const value = raw.trim().toUpperCase();
  return value === '' ? null : value;
}

/**
 * The DTO-edge transform (`@Transform(gstinDtoTransform)`): the same lenient
 * rule as `normalizeGstinInput` — trim + uppercase, and a blank value reads
 * as ABSENT — so an HTTP client sending `""` for "no GSTIN" is not refused
 * by `@Matches` while the command would have accepted it.
 */
export function gstinDtoTransform({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.toUpperCase();
}
