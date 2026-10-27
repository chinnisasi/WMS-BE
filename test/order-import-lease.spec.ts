import { ValkeyClient } from '../src/shared/valkey/valkey.client';
import { ulid } from '../src/shared/primitives/ids';

// Story 4-1c (A1) — the order import's per-key lease on the REAL Valkey:
// `SET key token NX PX ttl` to take it, a compare-and-delete script to free
// it. Acquire, refuse a second holder, expire, and a token-checked release
// that never frees another holder's lease.
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';

jest.setTimeout(30_000);

describe('the order-import lease (story 4-1c, A1)', () => {
  const valkey = new ValkeyClient();
  const key = (): string => `order-import:lease-spec:${ulid()}`;

  afterAll(async () => {
    await valkey.onApplicationShutdown();
  });

  it('acquire → a second holder is refused → the holder releases → it can be taken again', async () => {
    const lease = key();
    expect(await valkey.acquireLease(lease, 'run-1', 60_000)).toBe(true);
    expect(await valkey.acquireLease(lease, 'run-2', 60_000)).toBe(false);
    expect(await valkey.releaseLease(lease, 'run-1')).toBe(true);
    expect(await valkey.acquireLease(lease, 'run-2', 60_000)).toBe(true);
    await valkey.releaseLease(lease, 'run-2');
  });

  it('a release with another token frees nothing (the expired-and-retaken case)', async () => {
    const lease = key();
    expect(await valkey.acquireLease(lease, 'run-2', 60_000)).toBe(true);
    expect(await valkey.releaseLease(lease, 'run-1')).toBe(false);
    expect(await valkey.acquireLease(lease, 'run-3', 60_000)).toBe(false);
    expect(await valkey.releaseLease(lease, 'run-2')).toBe(true);
    // A release of an absent lease is a no-op.
    expect(await valkey.releaseLease(lease, 'run-2')).toBe(false);
  });

  it('the lease expires on its own (a run whose process died frees the key)', async () => {
    const lease = key();
    expect(await valkey.acquireLease(lease, 'run-1', 150)).toBe(true);
    expect(await valkey.acquireLease(lease, 'run-2', 150)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await valkey.acquireLease(lease, 'run-2', 60_000)).toBe(true);
    await valkey.releaseLease(lease, 'run-2');
  });

  it('a non-positive or fractional TTL is refused before any call', async () => {
    await expect(valkey.acquireLease(key(), 't', 0)).rejects.toThrow(/positive integer/);
    await expect(valkey.acquireLease(key(), 't', 1.5)).rejects.toThrow(/positive integer/);
  });
});
