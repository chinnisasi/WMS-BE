import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import {
  RESERVATION_GRANT_SCRIPT,
  RESERVATION_RELEASE_SCRIPT,
} from './reservation-scripts';

/** One grant-script reply: `[win(0|1), newReserved | reason]`. */
export type GrantReply = [win: 0 | 1, rest: string];
/** One release-script reply: `[applied(0|1), newReserved | reason]`. */
export type ReleaseReply = [applied: 0 | 1, rest: string];

/** Script command names as registered on the client (fixed key counts). */
const GRANT_COMMAND = 'wmsResGrant';
const RELEASE_COMMAND = 'wmsResRelease';
const LEASE_RELEASE_COMMAND = 'wmsLeaseRelease';

/**
 * Story 4-1c (A1) — the import lease's compare-and-delete: the key is deleted
 * only while it still holds the caller's token, so a run whose lease expired
 * (and was re-taken by another run) can never free that other run's lease.
 * Replies 1 when it deleted, 0 otherwise.
 */
export const LEASE_RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * The shared Valkey client (story 2.3, AD-2): one lazy ioredis connection
 * carrying atomic-decision state (reserved counters + their ready markers)
 * and short import leases (story 4-1c: one run per order-import key at a
 * time — `acquireLease` / `releaseLease`). Boot-validated like the database
 * (`db.ts`): the URL requirement
 * fails loudly at first use — a deployment that reaches a reservation path
 * without `VALKEY_URL` gets a named error, never a silent downgrade — while
 * the app shell (OpenAPI export, contract tests) still boots without Valkey,
 * exactly as it does without Postgres.
 *
 * Availability contract: a command that cannot reach Valkey rejects (bounded
 * retries, no unbounded offline queue) — every caller fails closed on that
 * rejection (grants return `unavailable`, ATP reads throw), never oversells.
 */
@Injectable()
export class ValkeyClient implements OnApplicationShutdown {
  private client: Redis | undefined;

  /** The connected client, created (and validated) on first use. */
  private redis(): Redis {
    if (this.client !== undefined) {
      return this.client;
    }
    const url = process.env.VALKEY_URL;
    if (url === undefined || url === '') {
      throw new Error(
        'VALKEY_URL is required for the reservation paths (the atomic-decision store ' +
          'has no fallback — grants and ATP reads fail closed without it)',
      );
    }
    const client = new Redis(url, {
      lazyConnect: true,
      // Fail closed fast: a partitioned Valkey must surface as a rejected
      // command (→ `unavailable`), not a hung request. `commandTimeout`
      // covers the harder case `connectTimeout` cannot: a connection that
      // established and then stopped answering. Story 4.1's A2 re-validation
      // reads a counter while the journal tx holds `FOR UPDATE` on the
      // scope's stock rows, so a hung-but-connected store would block every
      // stock mutation for that scope behind those locks. No blocking
      // command (BLPOP/SUBSCRIBE/XREAD) is ever issued here, so a flat
      // per-command deadline is safe.
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    });
    // AD-2: both decision scripts are pre-declared here with fixed key counts
    // — there is no ad-hoc EVAL anywhere else in the codebase.
    client.defineCommand(GRANT_COMMAND, { numberOfKeys: 2, lua: RESERVATION_GRANT_SCRIPT });
    client.defineCommand(RELEASE_COMMAND, { numberOfKeys: 1, lua: RESERVATION_RELEASE_SCRIPT });
    client.defineCommand(LEASE_RELEASE_COMMAND, { numberOfKeys: 1, lua: LEASE_RELEASE_SCRIPT });
    this.client = client;
    return client;
  }

  /**
   * Story 10.1: every milli-unit value crossing into Lua is asserted exact
   * first. Lua 5.1 numbers are IEEE doubles, so `tonumber(ARGV[n])` and the
   * `reserved + qty > ceiling` comparison are exact only to 2⁵³ — and past it
   * the script does not fail, it silently decides against a rounded number.
   * `setCounter` failed fast already; the INCRBY path is the one that decides.
   */
  private assertCounterValue(label: string, value: number): void {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Reservation ${label} must be an exact integer in milli-units: ${value}`,
      );
    }
  }

  /** The grant decision (see `RESERVATION_GRANT_SCRIPT`). */
  async grantReservation(
    counterKey: string,
    readyKey: string,
    quantity: number,
    ceiling: number,
    counterTtlSeconds: number,
  ): Promise<GrantReply> {
    this.assertCounterValue('grant quantity', quantity);
    this.assertCounterValue('grant ceiling', ceiling);
    const client = this.redis() as unknown as Record<
      string,
      (...args: (string | number)[]) => Promise<[number, string]>
    >;
    const reply = await client[GRANT_COMMAND]!(counterKey, readyKey, quantity, ceiling, counterTtlSeconds);
    return [reply[0] === 1 ? 1 : 0, reply[1]];
  }

  /** The release restore (see `RESERVATION_RELEASE_SCRIPT`). */
  async releaseReservation(
    counterKey: string,
    quantity: number,
    counterTtlSeconds: number,
  ): Promise<ReleaseReply> {
    this.assertCounterValue('release quantity', quantity);
    const client = this.redis() as unknown as Record<
      string,
      (...args: (string | number)[]) => Promise<[number, string]>
    >;
    const reply = await client[RELEASE_COMMAND]!(counterKey, quantity, counterTtlSeconds);
    return [reply[0] === 1 ? 1 : 0, reply[1]];
  }

  /**
   * Seeds/overwrites one counter (rebuild + divergence repair — Postgres
   * wins; `overwrite=false` makes it a conditional `SET NX` so a concurrent
   * winning script is never clobbered by a stale journal read).
   */
  async setCounter(key: string, value: number, ttlSeconds: number, overwrite: boolean): Promise<void> {
    // Story 10.1: the counter holds milli-units, and `String(value)` must stay
    // an INCRBY-parsable decimal integer — never exponential notation, never a
    // float. Past 2⁵³ neither JavaScript here nor Lua inside the scripts can
    // represent the value exactly, so a fail-fast beats a counter that drifts
    // silently and takes ATP with it.
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Reserved counter must be a non-negative exact integer in milli-units: ${value}`,
      );
    }
    if (overwrite) {
      await this.redis().set(key, String(value), 'EX', ttlSeconds);
    } else {
      await this.redis().set(key, String(value), 'EX', ttlSeconds, 'NX');
    }
  }

  /** The counter's current value, or null when the key is absent/corrupt. */
  async getCounter(key: string): Promise<number | null> {
    const raw = await this.redis().get(key);
    if (raw === null) {
      return null;
    }
    // A corrupt (non-numeric, non-integer or negative) value is divergence,
    // not a number: null sends the caller down the heal-from-journal path
    // (Postgres wins). A reserved counter is always a non-negative integer.
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  /** Arms the warehouse's ready marker (rebuild complete). */
  async setReady(readyKey: string): Promise<void> {
    await this.redis().set(readyKey, '1');
  }

  /** True when the warehouse's counters are loaded (the fail-closed gate). */
  async isReady(readyKey: string): Promise<boolean> {
    return (await this.redis().exists(readyKey)) === 1;
  }

  /** Disarms the ready marker — grants fail closed while it is down. */
  async disarmReady(readyKey: string): Promise<void> {
    await this.redis().del(readyKey);
  }

  /**
   * Story 4-1c (A1) — takes a short lease: `SET key token NX PX ttlMs`. True
   * when this caller now holds it; false when another holder does. Rejects
   * when Valkey is unreachable (the caller fails closed).
   */
  async acquireLease(key: string, token: string, ttlMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error(`Lease TTL must be a positive integer of milliseconds: ${ttlMs}`);
    }
    return (await this.redis().set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
  }

  /**
   * Story 4-1c (A1) — frees the lease only while it still holds `token`
   * (`LEASE_RELEASE_SCRIPT`). True when this call deleted it.
   */
  async releaseLease(key: string, token: string): Promise<boolean> {
    const client = this.redis() as unknown as Record<string, (...args: string[]) => Promise<number>>;
    return (await client[LEASE_RELEASE_COMMAND]!(key, token)) === 1;
  }

  /**
   * Story 6-2a — the readiness probe's `PING` (never a decision path). Rejects
   * when Valkey is unreachable or `VALKEY_URL` is unset, within the client's
   * connect/command timeouts.
   */
  async ping(): Promise<void> {
    const reply = await this.redis().ping();
    if (reply !== 'PONG') throw new Error(`Valkey PING answered ${String(reply)}`);
  }

  /** Removes a counter key (test/repair helper — never a decision path). */
  async deleteKey(key: string): Promise<void> {
    await this.redis().del(key);
  }

  async onApplicationShutdown(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) {
      await client.quit().catch(() => client.disconnect());
    }
  }
}
