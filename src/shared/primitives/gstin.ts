/**
 * The GSTIN primitive (story 8-1). A standalone file (the `bin-capacity`
 * pattern): a DTO must be able to import the shape WITHOUT pulling its
 * module's command graph in at load time, and the migration CHECK + the
 * tenancy normalizer + the outbound create-order command all share the one
 * regex — a shape stated twice drifts.
 *
 * What the gates check (story 8-1d, the comment made true): the SHAPE (two
 * digits + thirteen alphanumeric characters, `GSTIN_RE`) and, at entry, that
 * the two-digit prefix is a GST REGISTRATION state code
 * (`isGstinStateCode`). The PAN segment, the entity code, the `Z` and the
 * checksum character are NOT validated anywhere — no regulatory pass built
 * that, and storing only what invoicing resolves (state code + party
 * identity) keeps this gate from inventing rules nobody asked the regulator
 * about. Case: the canonical form is uppercase.
 */

/** The full shape — what the columns' CHECKs mirror and the validating edge throws on. */
export const GSTIN_RE = /^[0-9]{2}[A-Za-z0-9]{13}$/;

/**
 * The GST REGISTRATION state codes (story 8-1d): the codes a GSTIN's
 * two-digit prefix may carry — `gst_state_codes` minus `99`. Sorted.
 *
 * - `25` (Daman & Diu) is absent: its GSTINs were re-issued under `26` from
 *   1 Aug 2020 (the merged UT).
 * - `28` is absent: pre-GST Andhra Pradesh (`37` under GST).
 * - `99` (Centre Jurisdiction — OIDAR / UIN registrations) is excluded: such
 *   a registrant never ships goods, so it can be neither a supplier nor a
 *   goods consignee here. (The seed labels 99 "Other Country"; that label is
 *   wrong — Other Country is 96 — and is recorded in PENDING.)
 * - `97` (Other Territory) is kept: its GSTINs are real.
 *
 * A pure constant, not a DB read: the check runs in synchronous helpers and
 * outside any transaction (registration). `test/issuance-gate-parity.spec.ts`
 * pins it equal to `gst_state_codes` minus 99, and the web mirrors it.
 * The SAME predicate gates entry (registration, warehouse create, order
 * create) and filters the generator's GSTIN-prefix resolution.
 */
export const GSTIN_STATE_CODES: readonly string[] = Object.freeze([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '21', '22', '23', '24', '26', '27', '29', '30', '31', '32',
  '33', '34', '35', '36', '37', '38', '97',
]);

const GSTIN_STATE_CODE_SET: ReadonlySet<string> = new Set(GSTIN_STATE_CODES);

/** Whether a two-digit code is a GST registration state code (see `GSTIN_STATE_CODES`). */
export function isGstinStateCode(code: string): boolean {
  return GSTIN_STATE_CODE_SET.has(code);
}

/**
 * The prefix refusal's sentence, or null when the GSTIN's prefix is a
 * registration state code. Shared by every entry gate so the wording is one.
 */
export function gstinPrefixProblem(gstin: string): string | null {
  const prefix = gstin.slice(0, 2);
  return isGstinStateCode(prefix) ? null : `"${prefix}" is not a GST registration state code`;
}

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
