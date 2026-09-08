import { isUuid, ulid, uuidv7 } from './ids';

describe('ids primitives', () => {
  test('uuidv7 produces valid, time-ordered UUIDv7s', () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(isUuid(a)).toBe(true);
    expect(isUuid(b)).toBe(true);
    expect(a).not.toBe(b);
    expect(a[14]).toBe('7'); // version nibble
    expect(a[19]).toMatch(/[89ab]/); // variant bits
    // UUIDv7 embeds unix-ms in the first 48 bits — ordering must hold.
    expect(BigInt(`0x${a.replace(/-/g, '').slice(0, 12)}`)).toBeLessThanOrEqual(
      BigInt(`0x${b.replace(/-/g, '').slice(0, 12)}`),
    );
  });

  test('uuidv7 is unique within the same millisecond', () => {
    const t = Date.parse('2026-09-08T00:00:00Z');
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7(t)));
    expect(ids.size).toBe(5000);
  });

  test('ulid is 26 Crockford base32 chars, time-prefixed and sortable', () => {
    const early = ulid(Date.parse('2026-09-08T00:00:00Z'));
    const late = ulid(Date.parse('2026-09-09T00:00:00Z'));
    expect(early).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // Same-millisecond ULIDs share their 10-char time prefix.
    expect(late.slice(0, 10) > early.slice(0, 10)).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => ulid())).size).toBe(1000);
  });
});