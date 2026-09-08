/**
 * Deterministic identifier primitives (AD-9).
 *
 * Every entity id in the system is a UUIDv7: time-ordered so B-tree indexes
 * stay healthy, and unique across tenants. Idempotency keys are ULIDs
 * (client-generated, lexicographically sortable).
 */

// UUIDv7: 48-bit big-endian unix ms in the first 6 bytes, ver 7 / variant bits.
let lastMs = 0;
let seq = 0;

export function uuidv7(now: number = Date.now()): string {
  // 12-bit sequence guard for ids generated within the same millisecond.
  if (now === lastMs) {
    seq = (seq + 1) & 0x0fff;
    if (seq === 0) now += 1; // sequence exhausted — bump the clock
  } else {
    lastMs = now;
    seq = Math.floor(Math.random() * 0x0fff);
  }

  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(now / 2 ** 16));
  view.setUint16(4, now & 0xffff);
  view.setUint8(6, 0x70 | (seq >> 8)); // version 7 + top 4 seq bits
  view.setUint8(7, seq & 0xff);
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
