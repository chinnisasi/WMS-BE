/**
 * The atomic-decision scripts (story 2.3, AD-2) — the ONLY Valkey decision
 * paths in the system. Both are pre-declared (registered on the client with a
 * fixed key count, evaluated through EVALSHA with an EVAL fallback) and every
 * key they touch arrives through the KEYS array — never a keyless EVAL, never
 * a key smuggled through ARGV.
 *
 * The counter is the scope's RESERVED units (the frozen approach names the
 * store "reserved counters"): a winning grant INCREMENTS it (the sellable pool
 * shrinks — the "check+decrement" of the spec), a release/ expiry DECREMENTS
 * it back (the pool grows — the spec's "increment"). ATP is then always
 * `committed on-hand − reserved − QC-held − buffer`, never derived from a
 * second mirror that could disagree.
 */

/**
 * Grant (the one check-and-decrement): fail closed unless the warehouse is
 * ready and the counter exists (a missing counter under a ready marker is
 * divergence — the mirror must be repaired toward Postgres first, never
 * trusted blind). The ceiling is the committed, quarantine-excluded on-hand
 * passed as ARGV by the caller — the script never reads Postgres.
 *
 * KEYS[1] = reserved counter, KEYS[2] = warehouse ready marker
 * ARGV[1] = requested quantity, ARGV[2] = ATP ceiling, ARGV[3] = counter TTL
 *           seconds (a backstop only — the journal rebuild is the real repair)
 *
 * Returns {1, newReserved} on a win; {0, reason} on a deterministic loss
 * (`not-ready` / `missing-counter` / `unavailable`).
 */
export const RESERVATION_GRANT_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 0 then
  return {0, 'not-ready'}
end
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {0, 'missing-counter'}
end
local reserved = tonumber(redis.call('GET', KEYS[1]))
local qty = tonumber(ARGV[1])
if qty <= 0 then
  return {0, 'invalid-qty'}
end
if reserved + qty > tonumber(ARGV[2]) then
  return {0, 'unavailable'}
end
reserved = redis.call('INCRBY', KEYS[1], qty)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return {1, tostring(reserved)}
`;

/**
 * Release (the restore arm — commit never calls a script: a committed
 * reservation's units stay deducted until the consuming ledger movement):
 * decrements the reserved counter, floored at zero (a counter that already
 * disagrees is reparable toward Postgres; it must never go negative and
 * never block the journal-side terminal transition that already committed).
 *
 * KEYS[1] = reserved counter
 * ARGV[1] = quantity to restore, ARGV[2] = counter TTL seconds (backstop)
 *
 * Returns {1, newReserved} or {0, 'missing-counter'} (fail closed — the
 * counter is repaired by rebuild, never re-created from the release itself).
 */
export const RESERVATION_RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {0, 'missing-counter'}
end
local qty = tonumber(ARGV[1])
local reserved = tonumber(redis.call('GET', KEYS[1]))
local restored = reserved - qty
if restored < 0 then
  restored = 0
end
redis.call('SET', KEYS[1], restored, 'KEEPTTL')
return {1, tostring(restored)}
`;