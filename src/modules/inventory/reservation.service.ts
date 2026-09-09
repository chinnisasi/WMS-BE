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
 * subtract from ATP but have no surface in this story — the hooks are where
 * Epic 4/7 plug their computations in (callers pass the scope through, so the
 * formula `on-hand − reserved − QC-held − buffer` never changes).
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
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'ttlSeconds must be a non-negative integer',
        `ttlSeconds must be a non-negative integer of seconds (got ${String(ttlSeconds)}).`,
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
      return toSnapshot(probe.existing); // idempotent repeat while held
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
        // (idempotency), else the caller retries against a settled state.
        const existing = await withTenantTransaction(this.db, tenantId, (tx) =>
          this.findOpenHold(tx, command),
        );
        if (existing !== undefined) {
          return toSnapshot(existing);
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
   * `held → committed` (the consuming flow claims its hold): serialized
   * through the conditional UPDATE — exactly one winner; a second commit is a
   * deterministic conflict. The counter is UNTOUCHED: committed units stay
   * deducted until the consuming ledger movement (Epic 4) moves stock.
   */
  async commit(tenantId: string, reservationId: string): Promise<ReservationSnapshot> {
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
        // the journal's live-state sum — before reading.
        const sum = await this.journalReservedSum(tenantId, warehouseId, skuId);
        await this.valkey.setCounter(counterKey, sum, COUNTER_TTL_SECONDS, false);
        reserved = sum;
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
    }
    return expired;
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
      const sum = await this.journalReservedSum(tenantId, warehouseId, skuId);
      await this.valkey.setCounter(counterKey, sum, COUNTER_TTL_SECONDS, false);
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