import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Password hashing on `node:crypto` scrypt only — no new dependency (spec).
 * Stored format: `scrypt:<salt hex>:<derived-key hex>`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEY_BYTES);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const keyBytes = keyHex.length / 2;
  if (!Number.isInteger(keyBytes) || keyBytes < 16) return false;
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), keyBytes);
  const expected = Buffer.from(keyHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * A valid-format scrypt hash of an unguessable random value, precomputed so
 * sign-in can burn the same scrypt round for unknown emails as for wrong
 * passwords — the two cases stay indistinguishable in time, not just in body.
 * (Generated once with `hashPassword(randomBytes(32).toString('hex'))`.)
 */
export const DUMMY_HASH =
  'scrypt:0f4d1a2c8e5b3a79d6c04f81b2e95a63:5c1b7e2a9d8f3064c7e5a1b09d284f663e07c2b5819d4a3f0e6c8b2517d94a3c2f08b6e4d1a9c7f305b2e8d6a1409c375b1e0d2f4a6c8930e57d2b418fac6093';