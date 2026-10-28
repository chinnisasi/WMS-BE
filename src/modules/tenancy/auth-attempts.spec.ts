import { ipKey, rateLimited } from './auth-attempts';
import { issueDeviceCookie, verifyDeviceCookie, DEVICE_COOKIE_MAX_AGE_SECONDS, deviceCookieHeader } from './device-cookie';

process.env.JWT_SECRET ??= 'unit-only-secret-0123456789abcdef';

// Story 6-1c (A11) — the ONE address key: IPv4 unchanged, IPv6 cut to its
// /64 in one canonical spelling whatever form it arrives in.
describe('ipKey (story 6-1c)', () => {
  it('IPv4, unknown and junk pass through unchanged', () => {
    expect(ipKey('203.0.113.9')).toBe('203.0.113.9');
    expect(ipKey('unknown')).toBe('unknown');
    expect(ipKey('not an address')).toBe('not an address');
  });

  it('every spelling of one /64 is one key', () => {
    const key = '2001:db8:0:a::/64';
    for (const form of [
      '2001:db8:0:a::1',
      '2001:0db8:0000:000a:0000:0000:0000:0001',
      '2001:DB8:0:A:ffff:1:2:3',
      '2001:db8::a:1:2:3:4',
      '2001:db8:0:a::1%eth0',
      '2001:db8:0:a:1:2:192.0.2.1',
    ]) {
      expect([form, ipKey(form)]).toEqual([form, key]);
    }
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(ipKey('2001:db8:0:b::1')).not.toBe(key);
  });

  it('an IPv4-mapped address keys as its IPv4 address, in either spelling', () => {
    expect(ipKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(ipKey('::ffff:c000:207')).toBe('192.0.2.7');
  });
});

describe('rateLimited (story 6-1c, A12)', () => {
  it('says seconds up to two minutes, minutes beyond', () => {
    expect((rateLimited(45).getResponse() as { detail: string }).detail).toBe('Too many attempts. Try again in 45 seconds.');
    expect((rateLimited(120).getResponse() as { detail: string }).detail).toBe('Too many attempts. Try again in 120 seconds.');
    expect((rateLimited(1800).getResponse() as { detail: string }).detail).toBe('Too many attempts. Try again in 30 minutes.');
  });
});

// Story 6-1c (A1) — the device cookie.
describe('the device cookie (story 6-1c)', () => {
  const HASH = 'scrypt:aa:bb';
  const now = Date.UTC(2026, 9, 28, 6, 0, 0);

  it('verifies for its email (any case) and the hash it was bound to, until it expires', () => {
    const value = issueDeviceCookie('Priya@Example.com', HASH, now);
    expect(value).toMatch(/^v1\.[0-9a-f]{32}\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyDeviceCookie(value, 'priya@example.com', HASH, now)).toEqual({ nonce: value.split('.')[3] });
    expect(verifyDeviceCookie(value, 'priya@example.com', HASH, now + (DEVICE_COOKIE_MAX_AGE_SECONDS - 1) * 1000)).not.toBeNull();
    expect(verifyDeviceCookie(value, 'priya@example.com', HASH, now + DEVICE_COOKIE_MAX_AGE_SECONDS * 1000)).toBeNull();
  });

  it('refuses another email, a changed password hash (a reset), a forged MAC or expiry, junk and null', () => {
    const value = issueDeviceCookie('priya@example.com', HASH, now);
    expect(verifyDeviceCookie(value, 'ravi@example.com', HASH, now)).toBeNull();
    expect(verifyDeviceCookie(value, 'priya@example.com', 'scrypt:aa:cc', now)).toBeNull();
    const parts = value.split('.');
    expect(verifyDeviceCookie([...parts.slice(0, 4), `${parts[4]!.slice(0, -1)}${parts[4]!.endsWith('A') ? 'B' : 'A'}`].join('.'), 'priya@example.com', HASH, now)).toBeNull();
    expect(verifyDeviceCookie([parts[0], parts[1], String(Number(parts[2]) + 999), parts[3], parts[4]].join('.'), 'priya@example.com', HASH, now)).toBeNull();
    for (const junk of [null, '', 'v1', 'v2.a.b.c.d', `${value}.x`, 'x'.repeat(400)]) {
      expect(verifyDeviceCookie(junk, 'priya@example.com', HASH, now)).toBeNull();
    }
  });

  it('a key derived from JWT_SECRET: another secret verifies nothing', () => {
    const value = issueDeviceCookie('priya@example.com', HASH, now);
    const saved = process.env.JWT_SECRET;
    try {
      process.env.JWT_SECRET = 'another-secret-0123456789abcdef!!';
      expect(verifyDeviceCookie(value, 'priya@example.com', HASH, now)).toBeNull();
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });

  it('the header: httpOnly, SameSite=Strict, the sign-in path, 30 days, Secure unless COOKIE_SECURE=false', () => {
    const saved = process.env.COOKIE_SECURE;
    try {
      delete process.env.COOKIE_SECURE;
      expect(deviceCookieHeader('v')).toBe('wms_device=v; Path=/api/v1/tenants/sign-in; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure');
      process.env.COOKIE_SECURE = 'false';
      expect(deviceCookieHeader('v')).not.toContain('Secure');
    } finally {
      if (saved === undefined) delete process.env.COOKIE_SECURE;
      else process.env.COOKIE_SECURE = saved;
    }
  });
});
