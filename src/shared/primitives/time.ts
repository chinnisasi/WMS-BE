/**
 * Time primitive (AD-9): all timestamps in the system are ISO-8601 UTC.
 * Never store local time; never format with locale on the backend.
 */

/**
 * India Standard Time is UTC+05:30 year-round (no DST). The one copy: the
 * invoicing FY/period math and the reporting module's IST calendar-day
 * windows (story 9-1) both read it from here.
 */
export const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/**
 * The IST calendar date (`YYYY-MM-DD`) an instant falls on. Moved here from
 * `invoicing/eway-threshold.ts` (story 21-3) — the e-way threshold lookup and
 * the rate-card effective dates both ask it. Throws a `RangeError` on an
 * unparseable instant; the invoicing module re-exports it wrapped in its own
 * typed `ArithmeticOverflowError` (its delivery handler acks that type as a
 * data fault).
 */
export function istDateOf(instant: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new RangeError(`unparseable instant "${instant}"`);
  }
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * A real calendar date in `YYYY-MM-DD` (shape AND existence — `2026-02-31`
 * is refused). Moved here from `invoicing/eway-json.ts` (story 21-3).
 */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * The instant IST midnight of a `YYYY-MM-DD` date begins, as ISO-8601 UTC
 * (`2026-11-01` → `2026-10-31T18:30:00.000Z`). Story 21-3: a rate card's
 * effective boundary is stored as the instant it starts, because lookups are
 * by instant (an event's time). The caller has already checked `isIsoDate`.
 */
export function istMidnightOf(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS).toISOString();
}

/** `YYYY-MM-DD` plus `days` calendar days (UTC arithmetic on a date — no zone). */
export function addIsoDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Normalizes a stored `timestamptz` (Postgres returns its own text shape)
 * to the canonical ISO-8601 UTC form every read surface, idempotency
 * snapshot, and cursor relies on. Moved here from the inventory module
 * (epic-3 retro A7): every module used to reach into `ledger.service` for
 * it — one shared normalizer, no module reach-through.
 */
export function canonicalInstant(value: string): string {
  return new Date(value).toISOString();
}

/**
 * The FULL-precision instant a pagination cursor must carry.
 *
 * `canonicalInstant` rides JS `Date`, whose resolution is milliseconds —
 * but a Postgres `timestamptz` holds microseconds, and rows appended in ONE
 * transaction share one `now()` down to that microsecond (a multi-serial
 * adjustment appends its per-serial events in a single transaction). A
 * cursor whose instant was truncated to milliseconds then fails the keyset's
 * strict `<` against the untruncated stored value, and the next page skips
 * the whole tail of the tie group — rows silently vanishing from the list.
 * This helper renders the driver's raw text (selected via `::text`, since
 * the driver's own parse already truncates) at microsecond precision. The
 * cursor stays opaque, so the wider ISO shape is invisible to clients —
 * `decodeCursorSafe`'s regex already admits any fractional digits.
 */
export function fullPrecisionInstant(raw: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:[+-]\d{2}(?::?\d{2})?)?$/.exec(raw);
  if (match === null) {
    // Already an ISO string (or an exotic shape): fall back to the
    // canonicalizer — the caller's cursor stays at least as precise as the
    // pre-5-2 behavior.
    return canonicalInstant(raw);
  }
  const micros = (match[3] ?? '').padEnd(6, '0').slice(0, 6);
  return `${match[1]}T${match[2]}.${micros}Z`;
}

export function assertUtcIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/.exec(value);
  // Date.parse rolls impossible dates (Feb 31 → Mar 3) instead of failing, so
  // the components must round-trip through Date as well.
  const date = match === null ? new Date(NaN) : new Date(value);
  const ok =
    match !== null &&
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6]);
  if (!ok) {
    throw new Error(`Timestamp must be a valid ISO-8601 UTC instant ('Z'-suffixed): ${value}`);
  }
  return value;
}
