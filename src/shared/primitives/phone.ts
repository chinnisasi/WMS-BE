/**
 * Phone numbers (story 2-3a — the gate-in's driver phone). A phone number is
 * personal data (DPDP, decision 10): stored normalised, masked on every read
 * that is not the detail for a `gate.manage` holder, and never copied into an
 * outbox payload.
 */

/** A stored phone: an optional leading `+` and 7–15 digits (E.164's ceiling). */
export const PHONE_RE = /^\+?[0-9]{7,15}$/;

/**
 * A typed phone normalised: trimmed, with spaces, hyphens, dots and
 * parentheses stripped (`+91 98765-43345` → `+919876543345`). Returns null
 * for a blank. NOT validated — test the result against `PHONE_RE`.
 */
export function normalizePhone(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(/[\s().-]+/g, '');
  return normalized === '' ? null : normalized;
}

/**
 * The masked form a list shows (`9876543345` → `98•••••345`): the first two
 * digits (after a leading `+`, which is kept) and the last three, every digit
 * between as a bullet. A number too short to mask meaningfully (fewer than
 * six digits — never stored, `PHONE_RE` needs seven) is all bullets.
 */
export function maskPhone(value: string | null): string | null {
  if (value === null) return null;
  const plus = value.startsWith('+') ? '+' : '';
  const digits = plus === '' ? value : value.slice(1);
  if (digits.length < 6) return plus + '•'.repeat(digits.length);
  return `${plus}${digits.slice(0, 2)}${'•'.repeat(digits.length - 5)}${digits.slice(-3)}`;
}
