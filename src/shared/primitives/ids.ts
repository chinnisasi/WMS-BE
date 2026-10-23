/**
 * Deterministic identifier primitives (AD-9).
 *
 * Every entity id in the system is a UUIDv7: time-ordered so B-tree indexes
 * stay healthy, and unique across tenants. Idempotency keys are ULIDs
 * (client-generated, lexicographically sortable).
 */

// UUIDv7: 48-bit big-endian unix ms in the first 6 bytes, ver 7 / variant bits.
//
// Story 4-2a (A2) — MONOTONIC within a process. `lastMs` is the millisecond
// the last id EMBEDDED, `lastRaw` the clock reading it was minted at. When the
// 12-bit sequence wraps inside one millisecond the embedded clock is bumped
// past it, and that bump is CARRIED (`lastMs`): every later id minted while
// the clock still reads at or before the bumped millisecond continues the
// sequence from it, so an id never goes back in time. (Before 4-2a the bump
// was never stored — the next id in the same millisecond embedded the old one
// again and sorted before the bumped id.) A reading BEFORE the last one (the
// clock stepped back, or a test minting an id "two hours ago") restarts the
// sequence at that reading, as before 4-2a — so ids minted in that
// millisecond are monotonic again at once, and an explicit far-future `now`
// never strands later real-clock ids outside the sequence.
let lastMs = 0;
let lastRaw = 0;
let seq = 0;

export function uuidv7(now: number = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    lastRaw = now;
    seq = Math.floor(Math.random() * 0x0fff);
  } else if (now >= lastRaw) {
    // The same millisecond (or one the carried bump already covers): continue
    // the 12-bit sequence; a wrap moves the embedded clock forward one ms.
    lastRaw = now;
    seq = (seq + 1) & 0x0fff;
    if (seq === 0) lastMs += 1;
    now = lastMs;
  } else {
    lastMs = now;
    lastRaw = now;
    seq = Math.floor(Math.random() * 0x0fff);
  }
  return build(now, seq);
}

function build(now: number, sequence: number): string {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(now / 2 ** 16));
  view.setUint16(4, now & 0xffff);
  view.setUint8(6, 0x70 | (sequence >> 8)); // version 7 + top 4 seq bits
  view.setUint8(7, sequence & 0xff);
  crypto.getRandomValues(bytes.subarray(8, 16));
  bytes[8]! = (bytes[8]! & 0x3f) | 0x80; // variant 10xx

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Uint8Array, charCount: number): string {
  let out = '';
  let bits = 0;
  let nBits = 0;
  let idx = 0;
  for (let c = 0; c < charCount; c++) {
    while (nBits < 5 && idx < bytes.length) {
      bits = ((bits << 8) | bytes[idx]!) & 0xffffff;
      idx++;
      nBits += 8;
    }
    out += nBits >= 5 ? ULID_ALPHABET.charAt((bits >> (nBits - 5)) & 31) : ULID_ALPHABET[0]!;
    nBits -= 5;
  }
  return out;
}

/** ULID: 10 chars of millisecond timestamp + 16 chars of randomness (Crockford base32). */
export function ulid(now: number = Date.now()): string {
  let ms = now;
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = ULID_ALPHABET.charAt(ms % 32) + timePart;
    ms = Math.floor(ms / 32);
  }
  return timePart + encodeBase32(crypto.getRandomValues(new Uint8Array(10)), 16);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/**
 * The loose uuid shape (any version, any case) — the ONE shared uuid matcher
 * (retro A3): guards cursor payloads and uuid path params before the values
 * reach a Postgres `::uuid` cast, so crafted input surfaces as a 400/404
 * instead of a 500. (`isUuid` stays the stricter UUIDv7 identity check —
 * this one only answers "can this string be a uuid at all".)
 */
/**
 * The millisecond timestamp a UUIDv7 was minted at (its first 48 bits), or
 * null when the id is not a version-7 UUID. Story 9-2b: the push enqueue
 * dates an event by its outbox row id — minted server-side at append — never
 * by its `occurredAt`, which can be device time.
 */
export function uuidv7TimestampMs(id: string): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ONE ceiling for channel-supplied external identifiers (story 7-2):
 * the ingested order's channel ref and the ingest command's external event
 * id both bound here — a shared const (not a private literal at each site)
 * so the ingest-side parse arm and the order command's storage bound cannot
 * drift apart silently.
 */
export const MAX_EXTERNAL_ID_LENGTH = 200;
