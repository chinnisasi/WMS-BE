import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { AUTH_DATABASE, DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { inventoryQuarantines, reservations, stockOnHand } from '../../shared/db/schema';
import type { Reservation } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { nowIso } from '../../shared/primitives/time';
import { uuidv7 } from '../../shared/primitives/ids';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { ValkeyClient } from '../../shared/valkey/valkey.client';
import {
  reservationCounterKey,
  reservationReadyKey,
} from '../../shared/valkey/reservation-keys';

/** Default hold TTL (seconds): the reaper expires past-TTL holds. */
export const DEFAULT_RESERVATION_TTL_SECONDS = 900;

/**
 * Hold TTL upper bound (review loop 1): a sane ceiling on how far out a hold
 * may promise — ten years. Beyond it the journal's `expires_at` would be an
 * invalid date (raw 500 after compensating), so the bound is validated up
 * front like every other grant input.
 */
export const MAX_RESERVATION_TTL_SECONDS = 10 * 365 * 24 * 3600;

/** The uuid shape of every reservation id (the terminal-transition guard). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valkey counter keys' TTL seconds — a BACKSTOP only (story 2.3): a counter
 * that outlives all writes eventually vanishes, and a vanished counter fails
 * closed (missing under a ready marker = divergence) into the journal-driven
 * repair. Expiry of HOLDS is the reaper's Postgres-driven job, never a key TTL.
 */
export const COUNTER_TTL_SECONDS = 7 * 24 * 3600;

/** The reaper's per-cycle batch bound (the outbox relay's drain-limit pattern). */
export const REAP_BATCH = 100;

/**
 * Zero-valued named hooks (story 2.3 boundary): QC holds and channel buffers
 * subtract from ATP but have no surface in this story — these are the
 * zero-valued placeholders where Epic 4/7 will plug in their (scope-aware)
 * computations, so the formula `on-hand − reserved − QC-held − buffer` never
 * changes.
 */
export function qcHeldUnits(): number {
  return 0;
}

export function bufferUnits(): number {
  return 0;
}

/** Grant input (story 2.3): one owner hold against a (warehouse, sku) scope. */
export interface GrantReservationCommand {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  /** Who holds the units (free-form — Epic 4's order lines are the first writers). */
  readonly ownerType: string;
  readonly ownerId: string;
  /** Base-UoM units to hold; a positive integer. */
  readonly quantity: number;
  /** Hold TTL in seconds; defaults to `DEFAULT_RESERVATION_TTL_SECONDS`. */
  readonly ttlSeconds?: number;
}

/** The durable reservation record, as returned by every operation. */
export interface ReservationSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly quantity: number;
  readonly state: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Real-time available-to-promise for one scope (the 2.3 read). */
export interface AtpSnapshot {
  readonly warehouseId: string;
  readonly skuId: string;
  /** Committed on-hand with open-quarantined (sku, bin) scopes excluded. */
  readonly onHand: number;
  /** The Valkey counter (the live reserved units). */
  readonly reserved: number;
  /** Named hook — zero in this story. */
  readonly qcHeld: number;
  /** Named hook — zero in this story. */
  readonly buffer: number;
  /** `max(0, onHand − reserved − qcHeld − buffer)` — never oversells. */
  readonly atp: number;
}

/** One rebuilt warehouse's counter set (the repair report). */
export interface ReservationRebuildReport {
  readonly warehouseId: string;
  /** One entry per seeded scope: the journal sum written to the counter. */
  readonly scopes: readonly { skuId: string; reserved: number }[];
}

/** One due hold, as the reaper's cross-tenant discovery read returns it. */
interface DueHold {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly quantity: number;
}

function toSnapshot(row: Reservation): ReservationSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    warehouseId: row.warehouseId,
    skuId: row.skuId,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    quantity: row.quantity,
    state: row.state,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function unavailable(detail: string): ProblemException {
  // The deterministic race-loser outcome (story 2.3): 409 `unavailable`
  // problem-details. Per-channel backorder/accept arrives with Epic 7.
  return new ProblemException('unavailable', 409, 'Stock unavailable', detail);
}

/** Rejects a malformed/empty scope id at the boundary — 400, never a raw 22P02. */
function requireUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a well-formed uuid`,
      `The ${name} scope id must be a non-empty uuid (got ${value === '' ? "''" : `"${value}"`}).`,
    );
  }
}

/**
 * Reservations (story 2.3, AD-2/AD-12): the ONE atomic decision point for
 * sellable stock. Valkey carries per-(warehouse, sku) reserved counters behind
 * pre-declared-keys Lua scripts (every grant/release, no other decision
 * path); Postgres `reservations` is the journal truth — the mirror is always
 * repaired toward Postgres, never the reverse, and every failure mode fails
 * closed (`unavailable`), never oversells.
 *
 * Grant shape (journal is truth, commit-then-apply):
 *   probe (idempotency) → ceiling = committed quarantine-excluded on-hand −
 *   hooks → Lua script (check reserved+qty ≤ ceiling, increment) → INSERT the
 *   `held` journal row → on journal failure a compensating script release
 *   (the decrement never outlives a missing journal row).
 *
 * Terminal transitions (`held → committed/released/expired`) serialize through
 * a conditional UPDATE — the rowcount is the single-winner proof; a second
 * terminal write is a deterministic conflict. Commit leaves the counter
 * untouched (committed units stay deducted until Epic 4's dispatch movement);
 * release and reaper-expiry restore it via the release script.
 */
@Injectable()
export class ReservationService implements OnModuleInit {
  private readonly logger = new Logger('ReservationService');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // The reaper's one cross-tenant read (due holds) runs on the BYPASSRLS
    // connection — the sanctioned second use (relay/reconciliation precedent).
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(ValkeyClient) private readonly valkey: ValkeyClient,
  ) {}

  /**
   * Cold start: the journal is truth, so on module init every tenant's
   * counters are rebuilt from `reservations` (disarm → reseed → arm).
   * Best-effort — if Valkey is down the rebuild logs and grants fail closed
   * until the next explicit or not-ready-triggered rebuild succeeds.
   */
  async onModuleInit(): Promise<void> {
    try {
      // Cross-tenant discovery of every tenant that owns reservation scopes
      // or stock — the same BYPASSRLS read class the reaper uses.
      const rows = (await this.authDb.execute(sql`
        select distinct tenant_id from (
          select distinct tenant_id from reservations
          union
          select distinct tenant_id from stock_on_hand
        ) tenants
      `)) as unknown as { tenant_id: string }[];
      for (const { tenant_id: tenantId } of rows) {
        await this.rebuildCounters(tenantId);
      }
      this.logger.log(`Reservation counters rebuilt on startup (${rows.length} tenant(s))`);
    } catch (error) {
      this.logger.error(
        `Startup rebuild failed — grants fail closed until a rebuild succeeds: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Grants one hold. Idempotent per (owner_type, owner_id, warehouse, sku):
   * a repeat grant while held returns the existing reservation untouched.
   * The loser of a stock race receives the deterministic 409 `unavailable`.
   */
  async grant(command: GrantReservationCommand): Promise<ReservationSnapshot> {
    const { tenantId, warehouseId, skuId, ownerType, ownerId } = command;
    requireUuid(tenantId, 'tenantId');
    requireUuid(warehouseId, 'warehouseId');
    requireUuid(skuId, 'skuId');
    if (ownerType === '' || ownerId === '') {
      throw new ProblemException(
        'validation-failed',
        400,
        'ownerType and ownerId are required',
        'A reservation names its holder — ownerType/ownerId must be non-empty.',
      );
    }
    if (!Number.isInteger(command.quantity) || command.quantity <= 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'quantity must be a positive integer',
        `Reservation quantity must be a positive integer in base UoM (got ${command.quantity}).`,
      );
    }
    const ttlSeconds = command.ttlSeconds ?? DEFAULT_RESERVATION_TTL_SECONDS;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > MAX_RESERVATION_TTL_SECONDS) {
      throw new ProblemException(
        'validation-failed',
        400,
        'ttlSeconds out of range',
        `ttlSeconds must be an integer between 0 and ${MAX_RESERVATION_TTL_SECONDS} (got ${String(ttlSeconds)}).`,
      );
    }
    const counterKey = reservationCounterKey(tenantId, warehouseId, skuId);
    const readyKey = reservationReadyKey(tenantId, warehouseId);

    // Probe + ceiling in ONE committed-read transaction: an adjustment
    // committing mid-grant is either fully visible or not yet — the grant
    // reads the committed projection, so no interleave oversells.
    const probe = await withTenantTransaction(this.db, tenantId, async (tx) => ({
      existing: await this.findOpenHold(tx, command),
      ceiling: await this.committedCeiling(tx, tenantId, warehouseId, skuId),
    }));
    if (probe.existing !== undefined) {
      return this.idempotentHit(probe.existing, command);
    }

    const granted = await this.runGrantScript(counterKey, readyKey, tenantId, warehouseId, skuId, {
      quantity: command.quantity,
      ceiling: probe.ceiling,
    });
    if (!granted) {
      throw unavailable(
        `SKU ${skuId} has ${probe.ceiling} sellable unit(s) in warehouse ${warehouseId} — ` +
          `the request for ${command.quantity} cannot be reserved.`,
      );
    }

    // The journal row — the truth the counter now mirrors. If it cannot
    // commit, the decrement is compensated (never the reverse).
    try {
      return await withTenantTransaction(this.db, tenantId, async (tx) => {
        const rows = await tx
          .insert(reservations)
          .values({
            id: uuidv7(),
            tenantId,
            warehouseId,
            skuId,
            ownerType,
            ownerId,
            quantity: command.quantity,
            state: 'held',
            expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
          })
          .returning();
        return toSnapshot(rows[0]!);
      });
    } catch (err) {
      await this.compensate(counterKey, command.quantity, err);
      if (isUniqueViolationOn(err, 'reservations_open_owner_scope_unique')) {
        // A concurrent grant for the SAME owner scope won the journal insert:
        // re-probe — if its row is visible this grant collapses into it
        // (idempotency — same quantity only), else the caller retries against
        // a settled state.
        const existing = await withTenantTransaction(this.db, tenantId, (tx) =>
          this.findOpenHold(tx, command),
        );
        if (existing !== undefined) {
          return this.idempotentHit(existing, command);
        }
        throw new ProblemException(
          'conflict',
          409,
          'Concurrent reservation for this owner',
          'The same owner scope is being reserved concurrently; retry to read the settled result.',
        );
      }
      throw err;
    }
  }

  /**
   * The idempotent repeat (review loop 1 decision): a same-quantity replay
   * while held returns the existing reservation untouched; a replay whose
   * quantity DIFFERS is a deterministic 409 conflict — silently returning the
   * hold would let a caller under-hold (ask for 5, keep 2) with a
   * success-shaped reply.
   */
  private idempotentHit(existing: Reservation, command: GrantReservationCommand): ReservationSnapshot {
    if (existing.quantity !== command.quantity) {
      throw new ProblemException(
        'conflict',
        409,
        'Reservation quantity mismatch',
        `This owner scope already holds ${existing.quantity} unit(s); a repeat grant for ` +
          `${command.quantity} would change the hold — release the existing one first.`,
      );
    }
    return toSnapshot(existing);
  }

  /**
   * `held → committed` (the consuming flow claims its hold): serialized
   * through the conditional UPDATE — exactly one winner; a second commit is a
   * deterministic conflict. The counter is UNTOUCHED: committed units stay
   * deducted until the consuming ledger movement (Epic 4) moves stock.
   */
  async commit(tenantId: string, reservationId: string): Promise<ReservationSnapshot> {
    if (!UUID_RE.test(reservationId)) {
      // A non-uuid id cannot be a row — the contract's 404, not a raw
      // 22P02 from feeding the garbage into `eq(uuid, …)`.
      return this.terminalNotFound(reservationId);
    }
    const rows = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .update(reservations)
        .set({ state: 'committed', updatedAt: nowIso() })
        .where(
          and(
            eq(reservations.id, reservationId),
            eq(reservations.tenantId, tenantId),
            eq(reservations.state, 'held'),
          ),
        )
        .returning(),
    );
    const row = rows[0];
    if (row === undefined) {
      return this.terminalConflict(tenantId, reservationId);
    }
    return toSnapshot(row);
  }

  /**
   * `held → released`: serialized conditional UPDATE first (journal is
   * truth), then the script restores the counter. A non-held row is a
   * deterministic conflict; a missed mirror (Valkey down at restore time)
   * over-counts reserved — the fail-safe direction — and is repaired toward
   * Postgres by the next rebuild.
   */
  async release(tenantId: string, reservationId: string): Promise<ReservationSnapshot> {
    if (!UUID_RE.test(reservationId)) {
      return this.terminalNotFound(reservationId);
    }
    const rows = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .update(reservations)
        .set({ state: 'released', updatedAt: nowIso() })
        .where(
          and(
            eq(reservations.id, reservationId),
            eq(reservations.tenantId, tenantId),
            eq(reservations.state, 'held'),
          ),
        )
        .returning(),
    );
    const row = rows[0];
    if (row === undefined) {
      return this.terminalConflict(tenantId, reservationId);
    }
    await this.restoreCounter(row, 'release');
    return toSnapshot(row);
  }

  /**
   * Real-time ATP (story 2.3): `on-hand (open-quarantined scopes excluded) −
   * reserved − QC-held − buffer` (the hooks are zero-valued). Fails closed
   * (503) when Valkey is unreachable or its counters are not loaded — a read
   * that cannot prove the reserved figure never invents one. A missing
   * counter under a ready marker is divergence: healed from the journal
   * (Postgres wins) before the read.
   */
  async atp(tenantId: string, warehouseId: string, skuId: string): Promise<AtpSnapshot> {
    requireUuid(tenantId, 'tenantId');
    requireUuid(warehouseId, 'warehouseId');
    requireUuid(skuId, 'skuId');
    const onHand = await withTenantTransaction(this.db, tenantId, (tx) =>
      this.committedOnHand(tx, tenantId, warehouseId, skuId),
    );
    const counterKey = reservationCounterKey(tenantId, warehouseId, skuId);
    const readyKey = reservationReadyKey(tenantId, warehouseId);

    let ready: boolean;
    try {
      ready = await this.valkey.isReady(readyKey);
    } catch (err) {
      throw this.valkeyDown(err, 'ATP read');
    }
    if (!ready) {
      // Counters not loaded (cold start / rebuild in progress): fail closed.
      throw new ProblemException(
        'unavailable',
        503,
        'Reservation counters are not loaded',
        `Warehouse ${warehouseId} counters are being (re)built from the journal — ATP is unavailable, not zero.`,
      );
    }
    let reserved: number;
    try {
      const current = await this.valkey.getCounter(counterKey);
      if (current === null) {
        // Divergence (counter missing while ready): repair toward Postgres —
        // the journal's live-state sum — before reading. The snapshot reads
        // the counter BACK after the heal: the journal sum was read before
        // the SET NX, and a concurrent re-creation (or a concurrent winning
        // script the NX skipped) must not be overwritten by a stale figure.
        const sum = await this.journalReservedSum(tenantId, warehouseId, skuId);
        await this.valkey.setCounter(counterKey, sum, COUNTER_TTL_SECONDS, false);
        reserved = (await this.valkey.getCounter(counterKey)) ?? sum;
      } else {
        reserved = current;
      }
    } catch (err) {
      throw this.valkeyDown(err, 'ATP read');
    }

    const qcHeld = qcHeldUnits();
    const buffer = bufferUnits();
    return {
      warehouseId,
      skuId,
      onHand,
      reserved,
      qcHeld,
      buffer,
      atp: Math.max(0, onHand - reserved - qcHeld - buffer),
    };
  }

  /**
   * Rebuild (the repair/cold-start path): re-seeds every scope's reserved
   * counter from the journal (`state IN ('held','committed')` sums — Postgres
   * wins on divergence). The warehouse's ready marker is disarmed FIRST, so
   * grants and ATP reads fail closed for the whole rebuild, and armed only
   * after the counters are written. Rebuilds every warehouse of the tenant
   * when no warehouse is named.
   */
  async rebuildCounters(tenantId: string, warehouseId?: string): Promise<ReservationRebuildReport[]> {
    requireUuid(tenantId, 'tenantId');
    if (warehouseId !== undefined) {
      requireUuid(warehouseId, 'warehouseId');
    }
    const targets =
      warehouseId !== undefined
        ? [warehouseId]
        : await withTenantTransaction(this.db, tenantId, async (tx) => {
            const withReservations = await tx
              .selectDistinct({ warehouseId: reservations.warehouseId })
              .from(reservations)
              .where(eq(reservations.tenantId, tenantId));
            const withOnHand = await tx
              .selectDistinct({ warehouseId: stockOnHand.warehouseId })
              .from(stockOnHand)
              .where(eq(stockOnHand.tenantId, tenantId));
            return [
              ...new Set([
                ...withReservations.map((row) => row.warehouseId),
                ...withOnHand.map((row) => row.warehouseId),
              ]),
            ];
          });

    const reports: ReservationRebuildReport[] = [];
    for (const target of targets) {
      const readyKey = reservationReadyKey(tenantId, target);
      await this.valkey.disarmReady(readyKey);
      // Fail closed from here until the counters agree with the journal.
      let sums = await this.journalReservedSums(tenantId, target);
      // Scopes with on-hand but no live reservation still need a counter
      // (seeded at their — possibly zero — reserved sum), or every future
      // grant against them would read a missing counter as divergence.
      const onHandSkus = await withTenantTransaction(this.db, tenantId, (tx) =>
        tx
          .selectDistinct({ skuId: stockOnHand.skuId })
          .from(stockOnHand)
          .where(and(eq(stockOnHand.tenantId, tenantId), eq(stockOnHand.warehouseId, target))),
      );
      const reservedBySku = new Map<string, number>(sums.map((row) => [row.skuId, row.reserved]));
      for (const { skuId } of onHandSkus) {
        if (!reservedBySku.has(skuId)) {
          reservedBySku.set(skuId, 0);
        }
      }
      const scopes: { skuId: string; reserved: number }[] = [];
      for (const [skuId, reserved] of reservedBySku) {
        await this.valkey.setCounter(reservationCounterKey(tenantId, target, skuId), reserved, COUNTER_TTL_SECONDS, true);
        scopes.push({ skuId, reserved });
      }
      // Correction pass: a hold whose script won just before the disarm (its
      // journal row commits during the rebuild) must not be lost — where the
      // journal grew past the counter just written, Postgres wins again.
      // (In-flight grants that commit AFTER this read re-converge the moment
      // their journal lands; the residual window is the documented
      // rebuild-vs-in-flight-grant race — the next rebuild heals it.)
      sums = await this.journalReservedSums(tenantId, target);
      for (const { skuId, reserved } of sums) {
        const current = await this.valkey.getCounter(reservationCounterKey(tenantId, target, skuId));
        if (current === null || current < reserved) {
          await this.valkey.setCounter(reservationCounterKey(tenantId, target, skuId), reserved, COUNTER_TTL_SECONDS, true);
        }
      }
      await this.valkey.setReady(readyKey);
      reports.push({ warehouseId: target, scopes });
      this.logger.log(
        `Reservation counters rebuilt from journal: tenant=${tenantId} warehouse=${target} scopes=${scopes.length}`,
      );
    }
    return reports;
  }

  /**
   * The reaper's entry (driven through the facade by the jobs shell): every
   * held row past `expires_at` transitions to `expired` via the conditional
   * UPDATE (exactly one winner, whatever else races it) and its counter is
   * restored. Returns the number of rows this cycle expired.
   */
  async expireDue(): Promise<number> {
    const due = (await this.authDb.execute(sql`
      select id, tenant_id as "tenantId", warehouse_id as "warehouseId",
             sku_id as "skuId", quantity
      from reservations
      where state = 'held' and expires_at <= now()
      order by expires_at asc
      limit ${REAP_BATCH}
    `)) as unknown as DueHold[];

    let expired = 0;
    for (const hold of due) {
      // One poison hold (a repeatedly-failing tenant tx) must not abort the
      // cycle — it re-selects first every cycle, so a thrown row would
      // starve every later due hold in the batch. Log and continue.
      try {
        const rows = await withTenantTransaction(this.db, hold.tenantId, (tx) =>
          tx
            .update(reservations)
            .set({ state: 'expired', updatedAt: nowIso() })
            .where(
              and(
                eq(reservations.id, hold.id),
                eq(reservations.tenantId, hold.tenantId),
                eq(reservations.state, 'held'),
              ),
            )
            .returning(),
        );
        if (rows[0] === undefined) {
          continue; // a concurrent terminal writer won the row — not ours to count
        }
        expired += 1;
        await this.restoreCounter(rows[0], 'expiry');
      } catch (err) {
        this.logger.error(
          `Reservation reaper could not expire hold ${hold.id} — skipped this cycle: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await this.parityPass();
    return expired;
  }

  /**
   * The scheduled parity pass (review loop 1 decision): every reaper cycle
   * ALSO compares each live scope's Valkey counter against its journal sum
   * (`state IN ('held','committed')`) and triggers a warehouse rebuild from
   * the journal on any value mismatch — a counter that is PRESENT but WRONG
   * (the rebuild residual race, a failed compensation/restore) is repaired
   * toward Postgres instead of persisting silently. A missing counter at a
   * non-zero sum is a mismatch too (the grant/ATP heal arms repair it lazily;
   * the scheduled pass closes it on a bound); a missing counter at sum 0 is
   * not — nothing to repair. Failures log and wait for the next cycle:
   * expiry, not parity, is the reaper's primary job, and a parity read that
   * cannot reach Valkey must not fail the expiry cycle.
   */
  private async parityPass(): Promise<void> {
    let live: { tenantId: string; warehouseId: string; skuId: string; reserved: number }[];
    try {
      live = (await this.authDb.execute(sql`
        select tenant_id as "tenantId", warehouse_id as "warehouseId",
               sku_id as "skuId", coalesce(sum(quantity), 0)::int as reserved
        from reservations
        where state in ('held', 'committed')
        group by tenant_id, warehouse_id, sku_id
      `)) as unknown as typeof live;
    } catch (err) {
      this.logger.error(
        `Reservation parity pass could not read the journal — retried next cycle: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (live.length === 0) {
      return;
    }
    // Group by (tenant, warehouse): one rebuild heals a whole warehouse.
    const scopes = new Map<string, Map<string, Map<string, number>>>();
    for (const { tenantId, warehouseId, skuId, reserved } of live) {
      const warehouseMap = scopes.get(tenantId) ?? new Map<string, Map<string, number>>();
      const skuSums = warehouseMap.get(warehouseId) ?? new Map<string, number>();
      skuSums.set(skuId, reserved);
      warehouseMap.set(warehouseId, skuSums);
      scopes.set(tenantId, warehouseMap);
    }
    for (const [tenantId, warehouseMap] of scopes) {
      for (const [warehouseId, skuSums] of warehouseMap) {
        try {
          let divergent = false;
          for (const [skuId, reserved] of skuSums) {
            const counter = await this.valkey.getCounter(reservationCounterKey(tenantId, warehouseId, skuId));
            if (counter === null ? reserved > 0 : counter !== reserved) {
              divergent = true;
              break;
            }
          }
          if (divergent) {
            this.logger.warn(
              `Reservation parity pass found a divergent counter — rebuilding from the ` +
                `journal (Postgres wins): tenant=${tenantId} warehouse=${warehouseId}`,
            );
            await this.rebuildCounters(tenantId, warehouseId);
          }
        } catch (err) {
          this.logger.error(
            `Reservation parity pass failed for warehouse ${warehouseId} — retried next cycle: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  /**
   * The grant script, with the two fail-closed repair arms:
   * - `not-ready` (counters not loaded): triggers the journal rebuild (so the
   *   NEXT grant can proceed) and fails this one closed.
   * - `missing-counter` (divergence under a ready marker): repairs the scope
   *   from the journal (Postgres wins, SET NX so a concurrent winning script
   *   is never clobbered) and retries the script exactly once.
   * Returns true only on a script win; every other outcome is a deterministic
   * loss the caller rejects with `unavailable` (never a retry).
   */
  private async runGrantScript(
    counterKey: string,
    readyKey: string,
    tenantId: string,
    warehouseId: string,
    skuId: string,
    request: { quantity: number; ceiling: number },
  ): Promise<boolean> {
    let reply: Awaited<ReturnType<ValkeyClient['grantReservation']>>;
    try {
      reply = await this.valkey.grantReservation(
        counterKey,
        readyKey,
        request.quantity,
        request.ceiling,
        COUNTER_TTL_SECONDS,
      );
    } catch {
      // Valkey unreachable: fail closed — never oversell on a silent mirror.
      return false;
    }
    if (reply[0] === 1) {
      return true;
    }
    if (reply[1] === 'not-ready') {
      // Cold start / rebuild gap: repair from the journal so subsequent
      // grants have counters to decide against; THIS grant still fails
      // closed (the I/O matrix: grants during rebuild are `unavailable`).
      await this.rebuildCounters(tenantId, warehouseId).catch((err: unknown) => {
        this.logger.error(
          `Reservation rebuild triggered by a not-ready grant failed: tenant=${tenantId} ` +
            `warehouse=${warehouseId} — ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return false;
    }
    if (reply[1] === 'missing-counter') {
      // The repair itself can fail (journal read or Valkey write): like every
      // other arm, it must surface as the deterministic loss the caller
      // rejects with `unavailable`, never an unclassified error.
      try {
        const sum = await this.journalReservedSum(tenantId, warehouseId, skuId);
        await this.valkey.setCounter(counterKey, sum, COUNTER_TTL_SECONDS, false);
      } catch (err) {
        this.logger.error(
          `Reservation missing-counter repair failed — grant fails closed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
      try {
        const retry = await this.valkey.grantReservation(
          counterKey,
          readyKey,
          request.quantity,
          request.ceiling,
          COUNTER_TTL_SECONDS,
        );
        return retry[0] === 1;
      } catch {
        return false;
      }
    }
    return false; // 'unavailable' (or 'invalid-qty' — the caller pre-validates)
  }

  /**
   * The compensating release: a journal insert that failed must not leave its
   * decrement behind (the decrement never outlives a missing journal row). A
   * compensation that cannot reach Valkey leaves the counter too HIGH (ATP
   * too low — the fail-safe direction) and is repaired by rebuild.
   */
  private async compensate(counterKey: string, quantity: number, cause: unknown): Promise<void> {
    try {
      const reply = await this.valkey.releaseReservation(counterKey, quantity, COUNTER_TTL_SECONDS);
      if (reply[1] === 'missing-counter') {
        this.logger.warn(
          `Reservation compensation found a missing counter (rebuild will repair): ${counterKey}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Reservation compensation failed — counter over-counts until the next rebuild ` +
          `(journal error: ${cause instanceof Error ? cause.message : String(cause)}; ` +
          `compensation error: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /**
   * The counter restore after a journal-committed release/expiry. Journal
   * first, mirror second: a restore that cannot reach Valkey over-counts
   * reserved (ATP too low — fail-safe) and is repaired by rebuild.
   */
  private async restoreCounter(row: Reservation, arm: 'release' | 'expiry'): Promise<void> {
    const counterKey = reservationCounterKey(row.tenantId, row.warehouseId, row.skuId);
    try {
      const reply = await this.valkey.releaseReservation(counterKey, row.quantity, COUNTER_TTL_SECONDS);
      if (reply[1] === 'missing-counter') {
        this.logger.warn(
          `Reservation ${arm} found a missing counter (rebuild will repair): ${counterKey}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Reservation ${arm} counter restore failed — counter over-counts until the next ` +
          `rebuild (reservation ${row.id}, qty ${row.quantity}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The open `held` row for one owner scope, if any (grant idempotency). */
  private async findOpenHold(
    tx: TenantTx,
    command: GrantReservationCommand,
  ): Promise<Reservation | undefined> {
    const rows = await tx
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.tenantId, command.tenantId),
          eq(reservations.warehouseId, command.warehouseId),
          eq(reservations.skuId, command.skuId),
          eq(reservations.ownerType, command.ownerType),
          eq(reservations.ownerId, command.ownerId),
          eq(reservations.state, 'held'),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * The grant ceiling: committed on-hand for the scope with OPEN-quarantined
   * (sku, bin) rows excluded (the 2.2 flag now gates ATP), minus the named
   * zero-valued hooks. Read-committed: the committed projection is what a
   * grant may promise against.
   */
  private async committedCeiling(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    skuId: string,
  ): Promise<number> {
    const onHand = await this.committedOnHand(tx, tenantId, warehouseId, skuId);
    return Math.max(0, onHand - qcHeldUnits() - bufferUnits());
  }

  /** Committed on-hand, excluding every open-quarantined (sku, bin) scope. */
  private async committedOnHand(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    skuId: string,
  ): Promise<number> {
    const conditions: SQL[] = [
      eq(stockOnHand.tenantId, tenantId),
      eq(stockOnHand.warehouseId, warehouseId),
      eq(stockOnHand.skuId, skuId),
    ];
    const quarantined = tx
      .select({ one: sql<number>`1` })
      .from(inventoryQuarantines)
      .where(
        and(
          eq(inventoryQuarantines.tenantId, tenantId),
          eq(inventoryQuarantines.warehouseId, warehouseId),
          eq(inventoryQuarantines.skuId, skuId),
          eq(inventoryQuarantines.binId, stockOnHand.binId),
          eq(inventoryQuarantines.status, 'open'),
        ),
      );
    conditions.push(notExists(quarantined));
    const rows = await tx
      .select({ onHand: sql<number>`coalesce(sum(${stockOnHand.quantity}), 0)::int` })
      .from(stockOnHand)
      .where(and(...conditions));
    return rows[0]?.onHand ?? 0;
  }

  /** The journal's live-state reserved sum for one scope. */
  private async journalReservedSum(
    tenantId: string,
    warehouseId: string,
    skuId: string,
  ): Promise<number> {
    const sums = await this.journalReservedSums(tenantId, warehouseId, skuId);
    return sums[0]?.reserved ?? 0;
  }

  /** Per-sku journal sums over the live states (`held` + `committed`). */
  private async journalReservedSums(
    tenantId: string,
    warehouseId: string,
    skuId?: string,
  ): Promise<{ skuId: string; reserved: number }[]> {
    const conditions: SQL[] = [
      eq(reservations.tenantId, tenantId),
      eq(reservations.warehouseId, warehouseId),
      inArray(reservations.state, ['held', 'committed']),
    ];
    if (skuId !== undefined) {
      conditions.push(eq(reservations.skuId, skuId));
    }
    return withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select({ skuId: reservations.skuId, reserved: sql<number>`coalesce(sum(${reservations.quantity}), 0)::int` })
        .from(reservations)
        .where(and(...conditions))
        .groupBy(reservations.skuId),
    );
  }

  /** A row lost by the conditional UPDATE: 404 when absent, else 409 conflict. */
  private async terminalConflict(tenantId: string, reservationId: string): Promise<never> {
    if (!UUID_RE.test(reservationId)) {
      return this.terminalNotFound(reservationId);
    }
    const rows = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select({ state: reservations.state })
        .from(reservations)
        .where(and(eq(reservations.id, reservationId), eq(reservations.tenantId, tenantId)))
        .limit(1),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'Reservation not found',
        'No reservation with this id exists in this tenant.',
      );
    }
    throw new ProblemException(
      'conflict',
      409,
      'Reservation is not held',
      `The reservation is already terminal (state "${row.state}") — exactly one terminal transition wins (AD-12).`,
    );
  }

  /** The terminal transition's not-found outcome (malformed ids included). */
  private terminalNotFound(reservationId: string): never {
    throw new ProblemException(
      'not-found',
      404,
      'Reservation not found',
      `No reservation with id ${reservationId} exists in this tenant.`,
    );
  }

  private valkeyDown(err: unknown, path: string): ProblemException {
    this.logger.error(
      `Valkey unreachable during ${path} — failing closed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return new ProblemException(
      'unavailable',
      503,
      'Reservation store unavailable',
      'The atomic-decision store (Valkey) is unreachable — the request fails closed rather than risk oversell.',
    );
  }
}
