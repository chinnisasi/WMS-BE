/**
 * The ONE HSN rule (story 8-1d): one normaliser and one validity check,
 * shared by the generator (the `hsn-invalid` warning at issue), the HSN
 * summary (8-2a's `hsnIssue` rows) and the e-way builder (8-2b's `hsn-issue`
 * blocker and `hsnCode`). Before 8-1d each reader carried its own copy and
 * issuance checked only for null — a malformed HSN issued silently and was
 * then flagged forever downstream.
 *
 * The catalog's HSN is free text, so anything that is not 4, 6 or 8 digits
 * after the normaliser (a blank, `'HSN 0910'`, a 5-digit code) is an issue.
 */

/**
 * Validity, as a POSIX pattern string (not `\d`) so the SQL classifier
 * (`!~`) and the JS check agree on what a digit is.
 */
export const HSN_PATTERN = '^[0-9]{4}([0-9]{2}){0,2}$';
const HSN_RE = new RegExp(HSN_PATTERN);

/**
 * The normaliser: trims SPACES only (U+0020 — exactly what SQL `btrim(hsn)`
 * strips, so the HSN summary's `nullif(btrim(hsn), '')` and this function
 * never disagree on a row; JS `trim()` would strip tabs and NBSPs too), and
 * an empty result reads as null.
 */
export function normalizeHsn(hsn: string | null): string | null {
  if (hsn === null) return null;
  const trimmed = hsn.replace(/^ +| +$/g, '');
  return trimmed === '' ? null : trimmed;
}

/**
 * Validity of an HSN ALREADY normalised (by `normalizeHsn`, or by SQL's
 * `nullif(btrim(hsn), '')`) — no second trim here. Null or not matching →
 * an issue.
 */
export function isValidHsn(hsn: string | null): boolean {
  return hsn !== null && HSN_RE.test(hsn);
}
