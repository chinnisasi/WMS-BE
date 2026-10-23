/**
 * Story 3-3a (design review A3) — THE batch expiry predicate, shared by the
 * draw side (the wave planner's and the short-pick re-plan's
 * `buildStockPool`, the pick's FEFO re-derivation, the adjustment's FEFO
 * default draw) and the promise side (inventory's `unpromisableBatchUnits`
 * ATP hook). Before 3-3a the rule lived in three hand-written copies; the
 * promise side now reads it too, so what a grant may promise and what a wave
 * may draw cannot drift apart.
 *
 * The boundary — the existing draw side's, unchanged: a batch is DRAWABLE
 * while `Date.parse(expiry) >= at`. It is still drawable (and promisable) AT
 * the stored expiry instant itself and expired from the next millisecond on.
 * A received batch's expiry is stored as the instant its IST label date
 * begins (`istMidnightOf`), so a batch labelled "expires 2027-03-31" stops
 * being promisable just after 2027-03-31 00:00:00.000 IST. A null expiry
 * never expires. An expiry that does not parse fails CLOSED — it reads as
 * expired (the old copies' `!(NaN >= at)` behaviour, kept).
 *
 * `at` is epoch milliseconds — the caller's clock (the planner's injected
 * clock, the pick's business time, the ATP hook's `batchExpiryClock`).
 */
export function isBatchExpiredAt(expiryDate: string | null, at: number): boolean {
  if (expiryDate === null) return false;
  return !(Date.parse(expiryDate) >= at);
}

/**
 * Story 3-3a (A3) — the clock the PROMISE side judges expiry by: the ATP
 * hook (`unpromisableBatchUnits`) and the batch reads' `expired` flag. An
 * exported, mutable object (the `reservationRepairClock` / `rateCardClock`
 * pattern, IMPLEMENTATION-GUIDE §7c), so a suite moves time across an expiry
 * instant by ASSIGNING `now` — never `spyOn` (jest's `restoreMocks` would undo
 * it) and never the database's `now()` (no SQL copy of the predicate).
 */
export const batchExpiryClock = { now: (): number => Date.now() };
