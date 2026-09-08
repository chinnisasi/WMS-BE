import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { bins, idempotencyKeys, zones } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { hashCommandPayload } from './idempotency-guard';
import { idempotencyKeyReuse } from './registration.command';
import { assertWarehouseInTenant } from './tenancy.service';
import { withTenantTransaction, type TenancyTx } from './tenant-scope';
import { EVENT_BUS } from './event-bus';

export interface CreateBinCommand {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly zoneId: string;
  readonly code: string;
  readonly capacity: number;
  readonly type: string;
}

export interface GenerateBinsCommand {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly zoneId: string;
  /** Single aisle letters, inclusive — `A`..`C` spans A, B, C. */
  readonly aisleFrom: string;
  readonly aisleTo: string;
  readonly baysPerAisle: number;
  readonly levelsPerBay: number;
  readonly capacity: number;
  readonly type: string;
}

export interface SetBinBlockedCommand {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly blocked: boolean;
}

/** The API response body for a bin (the idempotency snapshot). */
export interface BinSnapshot {
  readonly bin: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly zoneId: string;
    readonly code: string;
    readonly capacity: number;
    readonly type: string;
    readonly blocked: boolean;
    readonly createdAt: string;
  };
}

/** The grid-generate response (one idempotency record for the whole run). */
export interface BinGridSnapshot {
  readonly warehouseId: string;
  readonly zoneId: string;
  readonly generatedCount: number;
  readonly firstCode: string;
  readonly lastCode: string;
}

/** Grid generator bound (spec 1.3): ≤ 500 bins per run. */
export const MAX_BINS_PER_GRID_RUN = 500;

const BINS_WAREHOUSE_CODE = 'bins_warehouse_id_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** `A-01-01` — aisle letter, zero-padded bay, zero-padded level. */
function gridCode(aisle: string, bay: number, level: number): string {
  return `${aisle}-${String(bay).padStart(2, '0')}-${String(level).padStart(2, '0')}`;
}

/**
 * Aisle count for an inclusive letter range — a descending or out-of-range
 * aisle span is a bad request, not an empty grid.
 */
function aisleRangeCount(aisleFrom: string, aisleTo: string): number {
  if (aisleFrom < 'A' || aisleTo > 'Z' || aisleFrom > aisleTo) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Invalid aisle range',
      `aisleFrom..aisleTo must be an ascending A–Z range (got "${aisleFrom}".."${aisleTo}").`,
    );
  }
  return aisleTo.charCodeAt(0) - aisleFrom.charCodeAt(0) + 1;
}

/** The generated code set; callers bound the total before calling this. */
function buildGridCodes(aisleFrom: string, aisleTo: string, bays: number, levels: number): string[] {
  const codes: string[] = [];
  for (let a = aisleFrom.charCodeAt(0); a <= aisleTo.charCodeAt(0); a += 1) {
    const aisle = String.fromCharCode(a);
    for (let bay = 1; bay <= bays; bay += 1) {
      for (let level = 1; level <= levels; level += 1) {
        codes.push(gridCode(aisle, bay, level));
      }
    }
  }
  return codes;
}

/**
 * Bin commands (Story 1.3): manual create, the ≤500-bin grid generator, and
 * the `blocked` toggle. Every write asserts the parent warehouse belongs to
 * the tenant inside the transaction (404 `not-found`) and the parent zone
 * belongs to that warehouse (also 404 — foreign zones never leak). Bin codes
 * are unique per warehouse — the duplicate rejection names the conflicting
 * code. Idempotency de-dupe in the same transaction (AD-5); the grid
 * generator is one transaction + one idempotency record (all-or-nothing).
 */
@Injectable()
export class BinCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
  ) {}

  async createBin(command: CreateBinCommand, idempotencyKey: string): Promise<BinSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      zoneId: command.zoneId,
      code: command.code,
      capacity: command.capacity,
      type: command.type,
    });

    // A manual bin carries no event of its own in this story — the spec names
    // zone.created / bins.generated / bin.blocked only — so `replayed` is not
    // consulted here.
    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, command.tenantId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as BinSnapshot,
            replayed: true,
          };
        }

        // Warehouse ownership inside the write transaction — before any bin
        // write (same gate as generateGrid / setBlocked).
        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

        const bin = await insertBin(tx, command);

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: { bin },
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent idempotent request',
              'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
        return { snapshot: { bin }, replayed: false };
      },
    );

    return snapshot;
  }

  async generateGrid(command: GenerateBinsCommand, idempotencyKey: string): Promise<BinGridSnapshot> {
    const from = command.aisleFrom.toUpperCase();
    const to = command.aisleTo.toUpperCase();
    // Count arithmetically first — a Z×99×99 request must not materialize a
    // 255k-code array just to reject it.
    const total = aisleRangeCount(from, to) * command.baysPerAisle * command.levelsPerBay;
    if (total > MAX_BINS_PER_GRID_RUN) {
      throw new ProblemException(
        'grid-too-large',
        422,
        'Grid generation exceeds the bin cap',
        `This grid would create ${total} bins — the cap is ${MAX_BINS_PER_GRID_RUN} per run. Narrow the aisle range, bays, or levels.`,
      );
    }
    const codes = buildGridCodes(from, to, command.baysPerAisle, command.levelsPerBay);

    // Hash the normalized aisle letters: the codes come from the uppercased
    // values, so a case-variant replay of the same request must replay too.
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      zoneId: command.zoneId,
      aisleFrom: from,
      aisleTo: to,
      baysPerAisle: command.baysPerAisle,
      levelsPerBay: command.levelsPerBay,
      capacity: command.capacity,
      type: command.type,
    });

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, command.tenantId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as BinGridSnapshot,
            replayed: true,
          };
        }

        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
        await assertZoneInWarehouse(tx, command.zoneId, command.warehouseId);

        // Collision pre-check in the same transaction: any generated code that
        // already exists in this warehouse (any zone — codes are unique per
        // warehouse) fails the run naming the first conflicting code, with
        // nothing committed.
        const conflicts = await tx
          .select({ code: bins.code })
          .from(bins)
          .where(and(eq(bins.warehouseId, command.warehouseId), inArray(bins.code, codes)));
        if (conflicts.length > 0) {
          const first = codes.find((code) => conflicts.some((c) => c.code === code));
          throw duplicateBinCode(first ?? conflicts[0]!.code);
        }

        const rows = codes.map((code) => ({
          id: uuidv7(),
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          zoneId: command.zoneId,
          code,
          capacity: command.capacity,
          type: command.type,
        }));
        try {
          await tx.insert(bins).values(rows);
        } catch (err) {
          if (isUniqueViolationOn(err, BINS_WAREHOUSE_CODE)) {
            // Concurrent writer won the race between the pre-check and the
            // insert; the transaction is aborted — retry replays cleanly.
            throw duplicateBinCode(codes[0]!);
          }
          throw err;
        }

        const snapshot: BinGridSnapshot = {
          warehouseId: command.warehouseId,
          zoneId: command.zoneId,
          generatedCount: rows.length,
          firstCode: codes[0]!,
          lastCode: codes[codes.length - 1]!,
        };
        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: snapshot,
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent idempotent request',
              'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
        return { snapshot, replayed: false };
      },
    );

    if (!replayed) {
      // Publish after the commit; a throwing bus must not 500 already-committed
      // work (the client's retry would replay instead of re-emit).
      try {
        await this.eventBus.publish({
          eventId: uuidv7(),
          type: 'bins.generated',
          tenantId: command.tenantId,
          occurredAt: nowIso(),
          payload: {
            warehouseId: snapshot.warehouseId,
            zoneId: snapshot.zoneId,
            count: snapshot.generatedCount,
            firstCode: snapshot.firstCode,
            lastCode: snapshot.lastCode,
          },
        } satisfies DomainEvent);
      } catch (error) {
        console.warn(
          `Event publish failed after commit — type=bins.generated tenant=${command.tenantId}:`,
          error,
        );
      }
    }
    return snapshot;
  }

  async setBlocked(command: SetBinBlockedCommand, idempotencyKey: string): Promise<BinSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      binId: command.binId,
      blocked: command.blocked,
    });

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        const existing = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, command.tenantId),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as BinSnapshot,
            replayed: true,
          };
        }

        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

        const rows = await tx
          .update(bins)
          .set({ blocked: command.blocked, updatedAt: nowIso() })
          .where(and(eq(bins.id, command.binId), eq(bins.warehouseId, command.warehouseId)))
          .returning();
        const row = rows[0];
        if (!row) {
          throw binNotFound();
        }
        const bin: BinSnapshot['bin'] = {
          id: row.id,
          tenantId: row.tenantId,
          warehouseId: row.warehouseId,
          zoneId: row.zoneId,
          code: row.code,
          capacity: row.capacity,
          type: row.type,
          blocked: row.blocked,
          createdAt: row.createdAt,
        };

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: { bin },
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent idempotent request',
              'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
        return { snapshot: { bin }, replayed: false };
      },
    );

    if (!replayed) {
      try {
        await this.eventBus.publish({
          eventId: uuidv7(),
          type: 'bin.blocked',
          tenantId: command.tenantId,
          occurredAt: nowIso(),
          payload: {
            binId: snapshot.bin.id,
            warehouseId: snapshot.bin.warehouseId,
            blocked: snapshot.bin.blocked,
          },
        } satisfies DomainEvent);
      } catch (error) {
        console.warn(
          `Event publish failed after commit — type=bin.blocked tenant=${command.tenantId}:`,
          error,
        );
      }
    }
    return snapshot;
  }
}

/**
 * The bin's parent zone must exist and belong to the warehouse — validated in
 * the command transaction (no FK constraints; repo convention is uuid columns
 * + app-layer integrity). A foreign/nonexistent zone is 404 `not-found`.
 */
async function assertZoneInWarehouse(
  tx: TenancyTx,
  zoneId: string,
  warehouseId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: zones.id })
    .from(zones)
    .where(and(eq(zones.id, zoneId), eq(zones.warehouseId, warehouseId)))
    .limit(1);
  if (rows.length === 0) {
    throw new ProblemException(
      'not-found',
      404,
      'Zone not found',
      'No zone with this id exists in this warehouse.',
    );
  }
}

/** Shared insert path for manually-created bins (same duplicate mapping). */
async function insertBin(
  tx: TenancyTx,
  command: CreateBinCommand,
): Promise<BinSnapshot['bin']> {
  // Zone must exist and belong to the warehouse before any bin write.
  await assertZoneInWarehouse(tx, command.zoneId, command.warehouseId);
  try {
    const rows = await tx
      .insert(bins)
      .values({
        id: uuidv7(),
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        zoneId: command.zoneId,
        code: command.code,
        capacity: command.capacity,
        type: command.type,
      })
      .returning();
    const row = rows[0]!;
    return {
      id: row.id,
      tenantId: row.tenantId,
      warehouseId: row.warehouseId,
      zoneId: row.zoneId,
      code: row.code,
      capacity: row.capacity,
      type: row.type,
      blocked: row.blocked,
      createdAt: row.createdAt,
    };
  } catch (err) {
    if (isUniqueViolationOn(err, BINS_WAREHOUSE_CODE)) {
      throw duplicateBinCode(command.code);
    }
    throw err;
  }
}

export function duplicateBinCode(code: string): ProblemException {
  return new ProblemException(
    'duplicate-bin-code',
    409,
    'Bin code already in use',
    `Bin code "${code}" already exists in this warehouse.`,
  );
}

function binNotFound(): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Bin not found',
    'No bin with this id exists in this warehouse.',
  );
}