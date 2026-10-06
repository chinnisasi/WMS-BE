import { IST_OFFSET_MS } from '../../shared/primitives/time';

/**
 * Story 9-1 — the dashboard's time windows, as absolute instants.
 *
 * Every window is an IST CALENDAR day computed here in TS and bound into SQL
 * as a `timestamptz` (never `now()`, never `date_trunc` in a session time
 * zone): one `asOf` instant fixes every bound of one overview read, so all
 * ten tiles count the same windows, and every drill carries `to = asOf` so
 * paging it later still lands on exactly the tile's count.
 *
 * Bounds are half-open `[from, to)`. The windows are read against
 * SERVER-stamped columns only (`created_at` / `recorded_at` / `updated_at`),
 * never a device `occurred_at` — an offline op replayed tomorrow must not
 * revise "today".
 */
export interface ReportingWindow {
  /** The instant the read was taken — the exclusive upper bound of every window. */
  readonly asOf: string;
  /** IST midnight of `asOf`'s IST date — the start of "today". */
  readonly todayFrom: string;
  /** IST midnight six days before `todayFrom` — "today plus the last 6 days" (7 calendar days). */
  readonly d7From: string;
  /** `asOf − 1 h` — the pick rate's live hour. */
  readonly lastHourFrom: string;
  /** `asOf − 24 h` — the sync tile's failure window. */
  readonly last24hFrom: string;
}

const DAY_MS = 24 * 3600 * 1000;

/** The IST midnight (as a UTC instant, ms) that opens the IST calendar day containing `ms`. */
export function istMidnightBefore(ms: number): number {
  const shifted = new Date(ms + IST_OFFSET_MS);
  const midnightShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return midnightShifted - IST_OFFSET_MS;
}

export function reportingWindow(now: Date): ReportingWindow {
  const asOfMs = now.getTime();
  if (Number.isNaN(asOfMs)) {
    throw new Error('reportingWindow: an invalid clock instant');
  }
  const todayFromMs = istMidnightBefore(asOfMs);
  return {
    asOf: new Date(asOfMs).toISOString(),
    todayFrom: new Date(todayFromMs).toISOString(),
    // IST has no DST, so six whole days back is exactly six IST midnights back.
    d7From: new Date(todayFromMs - 6 * DAY_MS).toISOString(),
    lastHourFrom: new Date(asOfMs - 3600 * 1000).toISOString(),
    last24hFrom: new Date(asOfMs - DAY_MS).toISOString(),
  };
}
