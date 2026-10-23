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

  test('uuidv7 embeds the exact unix-ms timestamp (RFC 9562 unix_ts_ms)', () => {
    const t = Date.parse('2026-09-08T00:00:00Z');
    const id = uuidv7(t);
    expect(Number(BigInt(`0x${id.replace(/-/g, '').slice(0, 12)}`))).toBe(t);
  });

  test('uuidv7 is unique within the same millisecond', () => {
    const t = Date.parse('2026-09-08T00:00:00Z');
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7(t)));
    expect(ids.size).toBe(5000);
  });

  test('story 4-2a (A2): ids stay strictly increasing across a 12-bit sequence wrap in one fixed millisecond', () => {
    // A millisecond later than any id this process minted, so the sequence
    // starts here; 4097 ids in it MUST wrap the 12-bit counter at least once.
    const t = Date.parse('2099-01-01T00:00:00Z');
    const ids = Array.from({ length: 4097 }, () => uuidv7(t));
    const embedded = (id: string): number => Number(BigInt(`0x${id.replace(/-/g, '').slice(0, 12)}`));
    // The ms + version + sequence prefix (the first 16 hex) orders the ids.
    const prefix = (id: string): bigint => BigInt(`0x${id.replace(/-/g, '').slice(0, 16)}`);
    for (let i = 1; i < ids.length; i += 1) {
      expect(prefix(ids[i]!) > prefix(ids[i - 1]!)).toBe(true);
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
    // The wrap happened (the clock was bumped) and the bump was carried:
    // the last id embeds a later millisecond than the first, never an earlier one.
    expect(embedded(ids[0]!)).toBe(t);
    expect(embedded(ids[ids.length - 1]!)).toBeGreaterThan(t);
    // And the next id minted at the same fixed clock reading continues after it.
    const next = uuidv7(t);
    expect(prefix(next) > prefix(ids[ids.length - 1]!)).toBe(true);
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
