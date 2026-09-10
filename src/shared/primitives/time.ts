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
