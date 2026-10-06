import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { assertWarehouseInTenant } from '../tenancy/tenancy.service';
import { TILES, TILE_STATEMENT_TIMEOUT_MS, TILE_TX_DEADLINES } from './kpis';
import type { OverviewTiles, ReportingScope, TileContext, TileDefinition, TileName } from './kpis';
import { reportingWindow } from './window';

export type {
  DockToStockTile,
  DispatchPipelineTile,
  Drill,
  ExpiryAlertsTile,
  Figure,
  GrnVariancesTile,
  OrderAccuracyTile,
  OverviewTiles,
  OversellTile,
  PickRateTile,
  ReportingScope,
  ShortPicksTile,
  Sm8Tile,
  SyncConnectionHealth,
  SyncHealthTile,
  TileState,
  WindowedFigure,
} from './kpis';
export { SYNC_HEALTH_REASONS, SYNC_HEALTH_STATES } from './kpis';

/**
 * At most this many reporting tile transactions run at once IN THE PROCESS —
 * across every concurrent Overview read, not per request. The pool is
 * `max: 10`, and the scan path must never queue behind dashboards (AD-17).
 */
export const TILE_CONCURRENCY = 3;
/** The overall budget: any tile not finished by then is `unavailable`. Under NFR-6's 2 s. */
export const OVERVIEW_DEADLINE_MS = 1800;
export { TILE_STATEMENT_TIMEOUT_MS };

/**
 * The process-wide tile semaphore. `acquire` waits for a slot at most until
 * the caller's deadline and answers false when none freed in time — that
 * tile is then `unavailable` without ever taking a connection.
 */
class TileSlots {
  private active = 0;
  private readonly waiters: { grant: () => void }[] = [];

  constructor(private readonly capacity: number) {}

  acquire(deadlineAt: number): Promise<boolean> {
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve(false);
      }, Math.max(0, deadlineAt - Date.now()));
      this.waiters.push(waiter);
    });
  }

  /** Hands the slot straight to the next waiter, or frees it. */
  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next.grant();
    } else {
      this.active -= 1;
    }
  }
}

const TILE_SLOTS = new TileSlots(TILE_CONCURRENCY);

const STATEMENT_TIMEOUT_SQLSTATE = '57014';

export interface Overview {
  readonly asOf: string;
  /** True whenever any tile is `unavailable`. */
  readonly stale: boolean;
  readonly window: {
    readonly todayFrom: string;
    readonly d7From: string;
    readonly to: string;
    /** `asOf − 1 h` — the pick rate's live-hour drill `from`. */
    readonly lastHourFrom: string;
    /** `asOf − 24 h` — the sync tile's failure window. */
    readonly last24hFrom: string;
  };
  readonly tiles: OverviewTiles;
}

/** Walks a driver error's `cause` chain (drizzle wraps postgres.js errors) for the SQLSTATE. */
function isStatementTimeout(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === STATEMENT_TIMEOUT_SQLSTATE) return true;
    current = candidate.cause;
  }
  return false;
}

const DEADLINE = Symbol('deadline');

/**
 * Story 9-1 — the reporting read model (FR-27): the per-warehouse Overview.
 *
 * Best-effort tiles (AD-17), in this order:
 *   1. the warehouse is checked to exist in the tenant BEFORE any tile runs
 *      (404 otherwise — no tile ever reads a foreign warehouse id);
 *   2. one `asOf` fixes every window of the read (`window.ts`);
 *   3. at most `TILE_CONCURRENCY` tile transactions run at once in the whole
 *      PROCESS (a shared semaphore across concurrent reads), each its OWN
 *      tenant read transaction whose every statement runs under a
 *      transaction-local `statement_timeout` of min(1500 ms, time left);
 *   4. at `OVERVIEW_DEADLINE_MS` the response is assembled from whatever has
 *      finished — a tile still running, or never started, is `unavailable`;
 *   5. a statement timeout (57014) or the deadline is silent; ANY other error
 *      is logged with the tile's name — and still yields `unavailable`, never
 *      a 500 for the whole page;
 *   6. `stale` is true whenever any tile is `unavailable`.
 *
 * Reads only, member-open: nothing here is capability-gated. Decision 6
 * (`kpis.ts`) is the named exception that lets the tiles read sibling tables.
 */
@Injectable()
export class ReportingFacade {
  private readonly logger = new Logger('Reporting');

  /**
   * The tile set. A plain field so a suite can substitute one definition
   * (e.g. to force a timeout) without a second code path in production.
   */
  tiles: readonly TileDefinition[] = TILES;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async overview(tenantId: string, warehouseId: string, now: Date = new Date()): Promise<Overview> {
    // 404 before any tile runs (its own short transaction — the tiles each
    // take their own connection below; nothing is held across them).
    await withTenantTransaction(this.db, tenantId, (tx) => assertWarehouseInTenant(tx, tenantId, warehouseId));

    const window = reportingWindow(now);
    const scope: ReportingScope = { tenantId, warehouseId, clientId: null };
    const ctx: TileContext = { scope, window };
    const results = await this.runTiles(ctx);

    const tiles = {} as Record<TileName, OverviewTiles[TileName]>;
    let stale = false;
    for (const tile of this.tiles) {
      const result = results.get(tile.name);
      if (result === undefined) {
        stale = true;
        tiles[tile.name] = tile.unavailable(ctx);
      } else {
        stale = stale || result.state === 'unavailable';
        tiles[tile.name] = result;
      }
    }
    return {
      asOf: window.asOf,
      stale,
      window: {
        todayFrom: window.todayFrom,
        d7From: window.d7From,
        to: window.asOf,
        lastHourFrom: window.lastHourFrom,
        last24hFrom: window.last24hFrom,
      },
      tiles: tiles as unknown as OverviewTiles,
    };
  }

  private async runTiles(ctx: TileContext): Promise<Map<TileName, OverviewTiles[TileName]>> {
    const results = new Map<TileName, OverviewTiles[TileName]>();
    const started = Date.now();
    const deadlineAt = started + OVERVIEW_DEADLINE_MS;
    const queue = [...this.tiles];
    let next = 0;

    const worker = async (): Promise<void> => {
      // A worker starts a tile only while the budget lasts and only once the
      // PROCESS-WIDE semaphore grants a slot: a tile that cannot start before
      // the deadline is `unavailable` without ever taking a connection.
      while (next < queue.length && Date.now() < deadlineAt) {
        const tile = queue[next]!;
        next += 1;
        if (!(await TILE_SLOTS.acquire(deadlineAt))) continue;
        try {
          const value = await this.runTile(tile, ctx, deadlineAt);
          // A tile that finishes after the response was assembled is simply
          // not read — the map is consulted once, at the deadline.
          results.set(tile.name, value);
        } catch (err) {
          if (!isStatementTimeout(err)) {
            this.logger.error(
              `Reporting tile "${tile.name}" failed for warehouse ${ctx.scope.warehouseId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          results.set(tile.name, tile.unavailable(ctx));
        } finally {
          TILE_SLOTS.release();
        }
      }
    };

    const workers = Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, queue.length) }, () => worker()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), Math.max(0, deadlineAt - Date.now()));
    });
    try {
      await Promise.race([workers, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // Snapshot NOW: a straggler landing after this point must not change a
    // response already being assembled.
    return new Map(results);
  }

  private async runTile(tile: TileDefinition, ctx: TileContext, deadlineAt: number): Promise<OverviewTiles[TileName]> {
    return withTenantTransaction(this.db, ctx.scope.tenantId, async (tx) => {
      // Transaction-local (`is_local = true`): the timeout dies with this
      // transaction and never leaks onto the pooled connection. Every tile
      // statement re-arms it to min(1500 ms, time left) — `kpis.ts` rowsOf.
      TILE_TX_DEADLINES.set(tx, deadlineAt);
      const timeoutMs = Math.max(1, Math.min(TILE_STATEMENT_TIMEOUT_MS, deadlineAt - Date.now()));
      await tx.execute(sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`);
      return tile.run(tx, ctx);
    });
  }
}
