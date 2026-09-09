import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { RESERVATION_GRANT_SCRIPT, RESERVATION_RELEASE_SCRIPT } from './reservation-scripts';

/** One grant-script reply: `[win(0|1), newReserved | reason]`. */
export type GrantReply = [win: 0 | 1, rest: string];
/** One release-script reply: `[applied(0|1), newReserved | reason]`. */
export type ReleaseReply = [applied: 0 | 1, rest: string];

/** Script command names as registered on the client (fixed key counts). */
const GRANT_COMMAND = 'wmsResGrant';
const RELEASE_COMMAND = 'wmsResRelease';

/**
 * The shared Valkey client (story 2.3, AD-2): one lazy ioredis connection
 * carrying ONLY atomic-decision state (reserved counters + their ready
 * markers). Boot-validated like the database (`db.ts`): the URL requirement
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
      // command (→ `unavailable`), not a hung request.
      connectTimeout: 2_000,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    });
    // AD-2: both decision scripts are pre-declared here with fixed key counts
    // — there is no ad-hoc EVAL anywhere else in the codebase.
    client.defineCommand(GRANT_COMMAND, { numberOfKeys: 2, lua: RESERVATION_GRANT_SCRIPT });
    client.defineCommand(RELEASE_COMMAND, { numberOfKeys: 1, lua: RESERVATION_RELEASE_SCRIPT });
    this.client = client;
    return client;
  }

  /** The grant decision (see `RESERVATION_GRANT_SCRIPT`). */
  async grantReservation(
    counterKey: string,
    readyKey: string,
    quantity: number,
    ceiling: number,
    counterTtlSeconds: number,
  ): Promise<GrantReply> {
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
