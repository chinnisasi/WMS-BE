/**
 * Story 3-1 — the bin-to-bin move's reason vocabulary (decision 3).
 *
 * A move always carries a reason. The code is validated by the command (it
 * lives on the ledger event's reference doc, not in a column, so there is no
 * DB CHECK to mirror) and rides the device catalog snapshot as `moveReasons`,
 * reached by the api shell through `MovementsFacade` — no other module
 * imports this file.
 *
 * Widening this list is additive; renaming or removing a code is not (the
 * code is inside the hash chain of every event that carries it).
 */
export const MOVE_REASON_CODES = [
  'consolidate',
  're-slot',
  'make-room',
  'found-misplaced',
  'client-request',
  'other',
] as const;

export type MoveReasonCode = (typeof MOVE_REASON_CODES)[number];

/** The codes that need a note beside them (decision 3: `other`). */
export const MOVE_NOTE_REQUIRED_CODES: readonly MoveReasonCode[] = ['other'];

/** The note's ceiling, in code points, after trimming (decision 3). */
export const MOVE_NOTE_MAX = 200;

/** The serial-count ceiling of one move (decision 6). */
export const MAX_MOVE_SERIALS = 500;

/** One reason as the device snapshot carries it. */
export interface MoveReasonEntry {
  readonly code: MoveReasonCode;
  readonly noteRequired: boolean;
}

export function isMoveReasonCode(value: unknown): value is MoveReasonCode {
  return typeof value === 'string' && (MOVE_REASON_CODES as readonly string[]).includes(value);
}

/** The snapshot's `moveReasons` arm, in vocabulary order. */
export function moveReasonEntries(): MoveReasonEntry[] {
  return MOVE_REASON_CODES.map((code) => ({ code, noteRequired: MOVE_NOTE_REQUIRED_CODES.includes(code) }));
}
