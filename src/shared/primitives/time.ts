/**
 * Time primitive (AD-9): all timestamps in the system are ISO-8601 UTC.
 * Never store local time; never format with locale on the backend.
 */

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
