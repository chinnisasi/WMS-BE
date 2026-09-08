import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { bins, idempotencyKeys, skus } from '../../shared/db/schema';
import { signedQuantity } from '../../shared/primitives/quantity';
import type { SignedQuantity } from '../../shared/primitives/quantity';
import { uuidv7 } from '../../shared/primitives/ids';
import { assertUtcIso, nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { EVENT_BUS } from '../../shared/events/event-bus';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { LedgerService } from './ledger.service';

/**
 * `stock.adjustment` (Story 2.1): the first movement producer, exercisable
 * end-to-end. One command → exactly one ledger event + the updated on-hand
 * projection, committed in ONE transaction (`withTenantTransaction`).
 *
 * Authorization (epic-1 carve-out parity): the capability is asserted at
 * command-service entry — a DB role read in the command's own transaction,
 * BEFORE the idempotency replay lookup — so an actor demoted after the
 * original request gets `403 role-denied` naming the role and capability,
 * never the snapshot.
 *
 * Idempotency (AD-5): the client-generated ULID key de-dupes in the same
 * transaction as the write; same key + same payload replays the original
 * response (no second event), same key + different payload is a 422
 * `idempotency-key-reuse`.
 */
export interface AdjustStockCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly binId: string;
  /** Signed base-UoM delta; zero is rejected (a nothing movement). */
  readonly quantityDelta: number;
  readonly reasonCode: string;
  readonly note: string;
  /**
   * Business time; defaults to the commit clock when the client omits it.
   * (`string | undefined` explicit for `exactOptionalPropertyTypes` — the
   * controller passes the DTO's maybe-undefined field straight through.)
   */
  readonly occurredAt?: string | undefined;
}

/** The API response body (the idempotency snapshot). */
export interface StockAdjustmentSnapshot {
  readonly event: {
    readonly id: string;
    readonly seq: number;
    readonly type: string;
    readonly skuId: string;
    readonly binId: string | null;
    readonly quantityDelta: number;
    readonly occurredAt: string;
    readonly recordedAt: string;
  };
  readonly onHand: {
    readonly skuId: string;
    readonly binId: string;
    readonly quantity: number;
  };
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

@Injectable()
export class StockAdjustmentCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
    // No cycle: the command consumes the ledger one-way.
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  async adjust(
    command: AdjustStockCommand,
    idempotencyKey: string,
  ): Promise<{ snapshot: StockAdjustmentSnapshot; replayed: boolean }> {
    // The business time is client-supplied and UTC-validated (the primitive
    // throws a plain error — mapped to 400 here so it never renders as 500).
    let occurredAt: string;
    if (command.occurredAt === undefined) {
      occurredAt = nowIso();
    } else {
      try {
        occurredAt = assertUtcIso(command.occurredAt);
      } catch {
        throw new ProblemException(
          'validation-failed',
          400,
          'occurredAt must be a valid ISO-8601 UTC instant',
          `occurredAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${command.occurredAt}").`,
        );
      }
    }
    const delta = this.assertNonZeroDelta(command.quantityDelta);

    // Stable fingerprint over the command's business fields (fixed key
    // order — see hashCommandPayload). An omitted occurredAt is absent
    // from both attempts, so the fingerprint is stable across retries.
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      skuId: command.skuId,
      binId: command.binId,
      quantityDelta: command.quantityDelta,
      reasonCode: command.reasonCode,
      note: command.note,
      occurredAt: command.occurredAt,
    });

    const { snapshot, replayed } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry — DB read, same tx, BEFORE the
        // replay lookup (the deliberate fail-closed carve-out).
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'stock.adjust',
        );

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
        if (existing[0] !== undefined) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as StockAdjustmentSnapshot,
            replayed: true,
          };
        }

        // Master-data integrity in the command transaction (no FK repo
        // convention): warehouse in tenant, bin in that warehouse, SKU in
        // tenant — a foreign or nonexistent scope is 404 before any write.
        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
        // Integrity-only reads: a missing scope is 404 before any write
        // (the rows themselves are not used beyond existence).
        await this.assertBinInWarehouse(tx, command);
        await this.assertSkuInTenant(tx, command);

        const snapshot = await this.adjustToSnapshot(tx, command, delta, occurredAt);

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
      // Post-commit publish (the epic-1 pattern): a throwing bus must not
      // 500 already-committed work — the client's retry would replay.
      try {
        await this.eventBus.publish({
          eventId: uuidv7(),
          type: 'stock.adjusted',
          tenantId: command.tenantId,
          // Business time — the same instant the event committed with,
          // not the publish clock.
          occurredAt,
          payload: {
            warehouseId: command.warehouseId,
            skuId: command.skuId,
            binId: command.binId,
            quantityDelta: command.quantityDelta,
            seq: snapshot.event.seq,
            eventId: snapshot.event.id,
          },
        } satisfies DomainEvent);
      } catch (error) {
        console.warn(
          `Event publish failed after commit — type=stock.adjusted tenant=${command.tenantId}:`,
          error,
        );
      }
    }
    return { snapshot, replayed };
  }

  /** Signed, non-zero integer delta (a zero-delta event is pure noise). */
  private assertNonZeroDelta(raw: number): SignedQuantity {
    if (raw === 0) {
      throw new ProblemException(
        'validation-failed',
        400,
        'quantityDelta must be a non-zero integer',
        'A stock adjustment moves a non-zero quantity — zero deltas write no ledger event.',
      );
    }
    return signedQuantity(raw);
  }

  /**
   * The bin must exist in this tenant's warehouse (404 otherwise). The
   * `bins` row is tenancy master data read here only for referential
   * integrity (uuid columns, no FKs — the repo convention); stock tables
   * stay inventory-exclusive (the architecture test enforces the writes).
   */
  private async assertBinInWarehouse(
    tx: TenantTx,
    command: AdjustStockCommand,
  ): Promise<{ id: string; code: string }> {
    const rows = await tx
      .select({ id: bins.id, code: bins.code })
      .from(bins)
      .where(
        and(
          eq(bins.id, command.binId),
          eq(bins.warehouseId, command.warehouseId),
          eq(bins.tenantId, command.tenantId),
        ),
      )
      .limit(1);
    const bin = rows[0];
    if (bin === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'Bin not found',
        'No bin with this id exists in this warehouse.',
      );
    }
    return bin;
  }

  private async assertSkuInTenant(
    tx: TenantTx,
    command: AdjustStockCommand,
  ): Promise<{ id: string }> {
    const rows = await tx
      .select({ id: skus.id })
      .from(skus)
      .where(and(eq(skus.id, command.skuId), eq(skus.tenantId, command.tenantId)))
      .limit(1);
    if (rows[0] === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'SKU not found',
        'No SKU with this id exists in this tenant.',
      );
    }
    return rows[0];
  }

  /**
   * The movement itself: a positive delta is an into-bin movement
   * (`to_bin_id`), a negative delta an out-of-bin movement (`from_bin_id`)
   * — the signed-delta envelope convention documented on `ledger_events`.
   */
  private async adjustToSnapshot(
    tx: TenantTx,
    command: AdjustStockCommand,
    delta: SignedQuantity,
    occurredAt: string,
  ): Promise<StockAdjustmentSnapshot> {
    const appended = await this.ledger.appendMovement(tx, {
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      type: 'stock.adjusted',
      skuId: command.skuId,
      quantityDelta: delta,
      fromBinId: delta < 0 ? command.binId : null,
      toBinId: delta >= 0 ? command.binId : null,
      batchRef: null,
      serialRef: null,
      actorUserId: command.actorUserId,
      occurredAt,
      recordedAt: nowIso(),
      referenceDoc: {
        kind: 'manual-adjustment',
        reasonCode: command.reasonCode,
        note: command.note,
      },
    });
    const touched = appended.touched[0]!;
    return {
      event: {
        id: appended.eventId,
        seq: appended.seq,
        type: 'stock.adjusted',
        skuId: command.skuId,
        binId: command.binId,
        quantityDelta: command.quantityDelta,
        occurredAt: appended.occurredAt,
        recordedAt: appended.recordedAt,
      },
      onHand: {
        skuId: command.skuId,
        binId: touched.binId,
        quantity: touched.quantity,
      },
    };
  }
}