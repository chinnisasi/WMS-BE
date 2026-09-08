import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { idempotencyKeys, warehouses } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { hashCommandPayload } from './idempotency-guard';
import { idempotencyKeyReuse } from './registration.command';
import { withTenantTransaction } from './tenant-scope';
import { EVENT_BUS } from './event-bus';

export interface CreateWarehouseCommand {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
}

/** The API response body for a warehouse (the idempotency snapshot). */
export interface WarehouseSnapshot {
  readonly warehouse: {
    readonly id: string;
    readonly tenantId: string;
    readonly code: string;
    readonly name: string;
    readonly createdAt: string;
  };
}

const WAREHOUSES_TENANT_CODE = 'warehouses_tenant_id_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * Warehouse creation (AD-10): validates nothing itself (DTO layer does),
 * writes the warehouse with `tenant_id` stamped, and de-dupes on
 * `(tenant_id, key)` in the same transaction (AD-5). Codes are unique per
 * tenant — the duplicate rejection names the conflicting code.
 */
@Injectable()
export class WarehouseCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
  ) {}

  async create(
    command: CreateWarehouseCommand,
    idempotencyKey: string,
  ): Promise<WarehouseSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      code: command.code,
      name: command.name,
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
            snapshot: existing[0].responseSnapshot as WarehouseSnapshot,
            replayed: true,
          };
        }

        let warehouse: WarehouseSnapshot['warehouse'];
        try {
          const rows = await tx
            .insert(warehouses)
            .values({
              id: uuidv7(),
              tenantId: command.tenantId,
              code: command.code,
              name: command.name,
            })
            .returning();
          const row = rows[0]!;
          warehouse = {
            id: row.id,
            tenantId: row.tenantId,
            code: row.code,
            name: row.name,
            createdAt: row.createdAt,
          };
        } catch (err) {
          if (isUniqueViolationOn(err, WAREHOUSES_TENANT_CODE)) {
            throw duplicateWarehouseCode(command.code);
          }
          throw err;
        }

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: { warehouse },
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            // Concurrent duplicate of the same idempotent request — the
            // winner's response is authoritative; this request carries no
            // new state. The unique (tenant_id, key) index is the arbiter
            // (the existence check above cannot see an uncommitted winner).
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent idempotent request',
              'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
        return { snapshot: { warehouse }, replayed: false };
      },
    );

    if (!replayed) {
      await this.eventBus.publish({
        eventId: uuidv7(),
        type: 'warehouse.created',
        tenantId: command.tenantId,
        occurredAt: nowIso(),
        payload: {
          warehouseId: snapshot.warehouse.id,
          code: snapshot.warehouse.code,
          name: snapshot.warehouse.name,
        },
      } satisfies DomainEvent);
    }
    return snapshot;
  }
}

function duplicateWarehouseCode(code: string): ProblemException {
  return new ProblemException(
    'duplicate-warehouse-code',
    409,
    'Warehouse code already in use',
    `Warehouse code "${code}" already exists for this tenant.`,
  );
}