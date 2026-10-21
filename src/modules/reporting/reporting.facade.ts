import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertWarehouseInTenant, getMemberRoleIn, getWarehouseCodeInTx } from '../tenancy/tenancy.service';
import { CatalogFacade } from '../catalog/catalog.facade';
import { InboundFacade } from '../inbound/inbound.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import { rearmTxDeadline, setTxDeadline } from '../../shared/db/tx-deadline';
import { buildCsv } from '../../shared/export/csv';
import { buildXlsx } from '../../shared/export/xlsx';
import type { ExportCell } from '../../shared/export/cells';
import { istDateOf } from '../../shared/primitives/time';
import { getClientsInTx } from '../clients/clients.facade';
import {
  CSV_CONTENT_TYPE,
  REGISTER_CONCURRENCY,
  REGISTER_DEADLINE_MS,
  REGISTER_MAX_ROWS,
  REGISTERS,
  RegisterSlots,
  XLSX_CONTENT_TYPE,
  assertWithinCap,
  invalidRegisterQuery,
} from './registers';
import type { RegisterContext, RegisterFormat, RegisterName } from './registers';
import { assertPermission } from '../tenancy/permissions';
import type { Page } from '../../shared/primitives/pagination';
import { armAuditDeadline, AUDIT_STATEMENT_TIMEOUT_MS, readAuditPageInTx } from './audit';
import type { AuditTrailEntry, AuditTrailQuery } from './audit';
import { assertClientInTenantInTx } from '../clients/clients.facade';
import { TILES, TILE_STATEMENT_TIMEOUT_MS, TILE_TX_DEADLINES } from './kpis';
import type { OverviewTiles, ReportingScope, TileContext, TileDefinition, TileName } from './kpis';
import { reportingWindow } from './window';
import {
  armServiceDeadline,
  assertServicePeriod,
  readServiceFiguresInTx,
  SERVICE_STATEMENT_TIMEOUT_MS,
  SERVICE_TARGET_HOURS,
  serviceWindow,
} from './service';
import type { ServiceFigures, ServiceReport, ServiceReportScope, ServiceWindow } from './service';

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
export type {
  ServiceDispatchTimeliness,
  ServiceDockToStock,
  ServicePickAccuracy,
  ServiceReport,
} from './service';
export { MAX_SERVICE_REPORT_DAYS, SERVICE_STATEMENT_TIMEOUT_MS, SERVICE_TARGET_HOURS } from './service';
export type { AuditActorKind, AuditTrailEntry, AuditTrailQuery } from './audit';
export type { RegisterFormat, RegisterName } from './registers';
export {
  REGISTER_CONCURRENCY,
  REGISTER_DEADLINE_MS,
  REGISTER_FORMATS,
  REGISTER_MAX_ROWS,
  REGISTER_NAMES,
  REGISTERS,
  CSV_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  isRegisterName,
  referenceSummary,
} from './registers';
export { AUDIT_ACTION_PREFIX_RE, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT, AUDIT_STATEMENT_TIMEOUT_MS } from './audit';

/** Story 21-8 — the service report's query: an inclusive IST date period, optionally one warehouse. */
export interface ServiceReportQuery {
  readonly from: string;
  readonly to: string;
  /** Null or absent: every warehouse of the tenant. */
  readonly warehouseId?: string | null;
}

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

/** Story 5-3a — the process-wide register slots (decision 2): at most two register reads at once. */
const REGISTER_SLOTS = new RegisterSlots(REGISTER_CONCURRENCY);

/** Story 5-3a — one register request (the route's path and query, shape-checked by the DTO). */
export interface RegisterQuery {
  readonly report: RegisterName;
  readonly format: RegisterFormat;
  /** Null: every client. */
  readonly clientId: string | null;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** Story 5-3a — a finished register file, built whole before the route writes a header. */
export interface RegisterFile {
  readonly report: RegisterName;
  readonly format: RegisterFormat;
  readonly contentType: string;
  /** The server's name for it (CORS hides `Content-Disposition` — the web names its own). */
  readonly filename: string;
  readonly rowCount: number;
  readonly body: Buffer;
}

/** A code made safe for a filename: letters, digits and `-` only. */
function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

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

  /**
   * Story 21-8 — the service report's figures, read inside the report's one
   * timed transaction. A plain field so a suite can force a statement timeout
   * (or read the armed timeout) without a second production code path.
   */
  serviceRead: (tx: TenantTx, scope: ServiceReportScope, window: ServiceWindow) => Promise<ServiceFigures> = readServiceFiguresInTx;

  /**
   * Story 5-3a — the register slots, the whole-read budget and the read
   * itself: plain fields so a suite can hold the slots, shrink the budget or
   * force a statement timeout without a second production code path (the
   * `serviceRead` precedent).
   */
  registerSlots: RegisterSlots = REGISTER_SLOTS;
  registerDeadlineMs = REGISTER_DEADLINE_MS;
  registerMaxRows = REGISTER_MAX_ROWS;
  registerRead: (ctx: RegisterContext) => Promise<ExportCell[][]> = (ctx) => REGISTERS[ctx.name].read(ctx);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // Story 5-3a — the registers read their rows through the OWNING modules'
    // facades (AD-6), never their tables.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(InboundFacade) private readonly inbound: InboundFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  /**
   * Story 5-3a — one operational register as a file. Every refusal is thrown
   * before the route writes a header (IMPLEMENTATION-GUIDE §6), in this order:
   *   1. the period rule (400): a dated register needs `from`/`to` (the
   *      service report's rules — real dates, `from ≤ to`, ≤ 366 days); a
   *      snapshot register takes none;
   *   2. a slot (503 `report-unavailable`, before anything reads): at most
   *      `REGISTER_CONCURRENCY` register reads run in the process at once;
   *   3. ONE `REPEATABLE READ, READ ONLY` tenant transaction under a
   *      `REGISTER_DEADLINE_MS` WHOLE-read deadline, re-armed before every
   *      statement (`setTxDeadline` — the facades' reads re-arm it too): the
   *      warehouse (404 `unknown-warehouse`), the register's facade reads,
   *      and the cap (422 `report-too-large` on the 50,001st row);
   *   4. a statement timeout anywhere is 503 `report-unavailable`, nothing
   *      partial. Only then is the file built (CSV or XLSX, in memory).
   * Member-open (any staff role, like the source lists); no audit row (a
   * download audit is roadmap 6.4).
   */
  async register(tenantId: string, warehouseId: string, rawQuery: RegisterQuery, now: Date = new Date()): Promise<RegisterFile> {
    // Ids are compared as stored (lower-case) — an upper-case uuid must not read as an unknown client.
    const query: RegisterQuery = { ...rawQuery, clientId: rawQuery.clientId === null ? null : rawQuery.clientId.toLowerCase() };
    const definition = REGISTERS[query.report];
    const hasPeriod = query.from !== undefined || query.to !== undefined;
    if (definition.period === 'dated') {
      if (query.from === undefined || query.to === undefined) {
        throw invalidRegisterQuery(`The ${query.report} register needs from and to — inclusive IST dates, YYYY-MM-DD.`);
      }
      assertServicePeriod(query.from, query.to);
    } else if (hasPeriod) {
      throw invalidRegisterQuery(`The ${query.report} register is as of now and takes no from or to.`);
    }

    if (!this.registerSlots.tryAcquire()) {
      throw new ProblemException(
        'report-unavailable',
        503,
        'Report unavailable',
        `${REGISTER_CONCURRENCY} registers are already being prepared — try again in a moment.`,
      );
    }
    try {
      const { rows, warehouseCode, clientCode } = await withTenantTransaction(
        this.db,
        tenantId,
        async (tx) => {
          const deadlineAt = Date.now() + this.registerDeadlineMs;
          setTxDeadline(tx, deadlineAt);
          await rearmTxDeadline(tx);
          let code: string;
          try {
            code = await getWarehouseCodeInTx(tx, tenantId, warehouseId);
          } catch (err) {
            if (err instanceof ProblemException && (err.getResponse() as { code?: unknown }).code === 'not-found') {
              throw new ProblemException('unknown-warehouse', 404, 'Warehouse not found', 'No warehouse with this id exists in this tenant.');
            }
            throw err;
          }
          let client: string | null = null;
          if (query.clientId !== null) {
            await rearmTxDeadline(tx);
            // An unknown client is an empty file — named so, never as every client's.
            client = (await getClientsInTx(tx, tenantId, [query.clientId])).get(query.clientId)?.code ?? 'client-unknown';
          }
          const window =
            definition.period === 'dated'
              ? serviceWindow(query.from!, query.to!, now, deadlineAt)
              : null;
          const cells = await this.registerRead({
            name: query.report,
            tx,
            tenantId,
            warehouseId,
            warehouseCode: code,
            clientId: query.clientId,
            window: window === null ? null : { from: window.from, to: window.to },
            now,
            maxRows: this.registerMaxRows,
            limit: this.registerMaxRows + 1,
            sources: { inventory: this.inventory, inbound: this.inbound, outbound: this.outbound, catalog: this.catalog },
          });
          assertWithinCap(query.report, cells.length, this.registerMaxRows);
          return { rows: cells, warehouseCode: code, clientCode: client };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      const body =
        query.format === 'csv'
          ? buildCsv(definition.columns, rows)
          : await buildXlsx(query.report, definition.columns, rows);
      const span =
        definition.period === 'dated' ? `${query.from}_${query.to}` : `asof-${istDateOf(now.toISOString())}`;
      const filename = [query.report, slug(warehouseCode), ...(clientCode === null ? [] : [slug(clientCode)]), span].join('-');
      return {
        report: query.report,
        format: query.format,
        contentType: query.format === 'csv' ? CSV_CONTENT_TYPE : XLSX_CONTENT_TYPE,
        filename: `${filename}.${query.format}`,
        rowCount: rows.length,
        body,
      };
    } catch (err) {
      if (isStatementTimeout(err)) {
        throw new ProblemException(
          'report-unavailable',
          503,
          'Report unavailable',
          `The register did not finish within ${this.registerDeadlineMs / 1000} s — narrow the filters (a client, a shorter period).`,
        );
      }
      throw err;
    } finally {
      this.registerSlots.release();
    }
  }

  /**
   * Story 21-8 — one client's service report (CAP-10), the OPERATOR read:
   * any client of the tenant (suspended and `self` included). Period rules
   * first (400), then the client (404), then the warehouse (404), then the
   * figures — all in ONE tenant transaction under a 5 s `statement_timeout`;
   * a timeout is 503 `report-unavailable`, nothing partial.
   */
  async serviceReport(tenantId: string, clientId: string, query: ServiceReportQuery, now: Date = new Date()): Promise<ServiceReport> {
    assertServicePeriod(query.from, query.to);
    return this.readService(
      () =>
        withTenantTransaction(this.db, tenantId, (tx) =>
          this.serviceInTx(tx, { tenantId, clientId, warehouseId: query.warehouseId ?? null }, query, now),
        ),
    );
  }

  /**
   * Story 21-8 — the same report for the client-portal session's OWN client
   * (the client comes from `PortalSession`, never the request). The same
   * figures as the operator read, from the same code, in a transaction
   * stamped with the client (RLS) on top of every query's explicit
   * `client_id` predicate.
   */
  async portalServiceReport(tenantId: string, clientId: string, query: ServiceReportQuery, now: Date = new Date()): Promise<ServiceReport> {
    assertServicePeriod(query.from, query.to);
    return this.readService(() =>
      withTenantTransaction(
        this.db,
        tenantId,
        (tx) => this.serviceInTx(tx, { tenantId, clientId, warehouseId: query.warehouseId ?? null }, query, now),
        { clientId },
      ),
    );
  }

  private async serviceInTx(tx: TenantTx, scope: ServiceReportScope, query: ServiceReportQuery, now: Date): Promise<ServiceReport> {
    // The budget bounds the WHOLE read: every statement below runs under the
    // time left (transaction-local — it dies with this transaction).
    const deadlineAt = Date.now() + SERVICE_STATEMENT_TIMEOUT_MS;
    await armServiceDeadline(tx, deadlineAt);
    await assertClientInTenantInTx(tx, scope.tenantId, scope.clientId);
    if (scope.warehouseId !== null) await assertWarehouseInTenant(tx, scope.tenantId, scope.warehouseId);
    const window = serviceWindow(query.from, query.to, now, deadlineAt);
    const figures = await this.serviceRead(tx, scope, window);
    return {
      from: query.from,
      to: query.to,
      warehouseId: scope.warehouseId,
      asOf: window.asOf,
      targetHours: SERVICE_TARGET_HOURS,
      dockToStock: figures.dockToStock,
      pickAccuracy: figures.pickAccuracy,
      dispatchTimeliness: figures.dispatchTimeliness,
    };
  }

  /**
   * Story 9-3a — the tenant's audit trail (FR-28), reporting's third
   * read-only exception (`audit.ts`). OWNER-ONLY: the guard reads the
   * caller's role and asserts `audit.view` in its OWN transaction first (the
   * `channels.facade` gated-read shape) — 403 `role-denied` before anything
   * of the trail is read — so the read model itself touches `audit_events`
   * only. The read then runs in one tenant transaction under a 5 s budget; a
   * timeout is 503 `report-unavailable` (a broad filter over a very large
   * history is expected to hit it — narrow the filters or dates).
   */
  async auditTrail(tenantId: string, actorUserId: string, query: AuditTrailQuery): Promise<Page<AuditTrailEntry>> {
    await withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, actorUserId), 'audit.view');
    });
    try {
      return await withTenantTransaction(this.db, tenantId, async (tx) => {
        await armAuditDeadline(tx);
        return this.auditRead(tx, tenantId, query);
      });
    } catch (err) {
      if (isStatementTimeout(err)) {
        throw new ProblemException(
          'report-unavailable',
          503,
          'Report unavailable',
          `The audit trail did not finish within ${AUDIT_STATEMENT_TIMEOUT_MS / 1000} s — narrow the filters or the dates.`,
        );
      }
      throw err;
    }
  }

  /**
   * Story 9-3a — the audit page read, inside the timed transaction. A plain
   * field so a suite can force a statement timeout without a second
   * production code path (the `serviceRead` precedent).
   */
  auditRead: (tx: TenantTx, tenantId: string, query: AuditTrailQuery) => Promise<Page<AuditTrailEntry>> = readAuditPageInTx;

  /** A statement timeout anywhere in the read is 503 `report-unavailable` — never a partial report. */
  private async readService(run: () => Promise<ServiceReport>): Promise<ServiceReport> {
    try {
      return await run();
    } catch (err) {
      if (isStatementTimeout(err)) {
        throw new ProblemException(
          'report-unavailable',
          503,
          'Report unavailable',
          `The report did not finish within ${SERVICE_STATEMENT_TIMEOUT_MS / 1000} s — try a shorter period.`,
        );
      }
      throw err;
    }
  }

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
