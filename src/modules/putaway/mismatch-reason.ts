/**
 * The fixed mismatch-reason enum (the I/O matrix — 400 outside it): required
 * in the placement payload whenever the actual bin differs from the server's
 * re-derived suggestion. The `blindReasonCode` pattern — fixed, required,
 * report- and summary-labelable (SM-3).
 *
 * ONE source, per the standalone-constant rule (story 11-5): a constant both
 * the DTO layer (`putaway.dto.ts`) and the command layer (`putaway.command.ts`)
 * consume lives in its own module — the DTO imports it WITHOUT pulling the
 * command graph, and the two spellings can never drift. Story 12-4 adds
 * `bulk-asset` (the reason the server requires on a bulk-asset target).
 */
export const PUTAWAY_MISMATCH_REASON_CODES = [
  'pallet-too-heavy',
  'suggested-bin-occupied',
  'consolidation-with-existing-stock',
  'operator-preference',
  'bulk-asset',
  'other',
] as const;

export type PutawayMismatchReasonCode = (typeof PUTAWAY_MISMATCH_REASON_CODES)[number];
