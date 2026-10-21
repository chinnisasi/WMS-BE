/**
 * Vehicle and e-way bill identifiers (story 2-3a — lifted here from the
 * invoicing module so the gate-in shares them; invoicing re-exports both,
 * its behaviour unchanged).
 */

/**
 * An Indian registration number as NIC's e-way bill takes it, and as a
 * gate-in stores it: 4–15 upper-case letters and digits, nothing else. BH
 * series (`22BH1234AA`) and temporary registrations (`T0822KA1234Z`) fit.
 * Lifted from `invoicing/eway-json.ts`.
 */
export const VEHICLE_NO_RE = /^[A-Z0-9]{4,15}$/;

/**
 * Story 2-3a (decision 13) — a typed plate normalised the way a gate desk
 * writes it: upper-cased, with spaces, dots and hyphens stripped
 * (`ka-01.ab 1234` → `KA01AB1234`). Returns null for a blank. The result is
 * NOT validated — test it against `VEHICLE_NO_RE`. (The e-way bill's Part B
 * keeps its own whitespace-only normalisation, unchanged.)
 */
export function normalizeVehicleNo(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(/[\s.-]+/g, '').toUpperCase();
  return normalized === '' ? null : normalized;
}

/** An e-way bill number: 12 digits (NIC). Lifted from `invoicing/eway.command.ts`. */
export const EWB_NO_RE = /^[0-9]{12}$/;
