import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { idempotencyKeys, zones } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from './idempotency-guard';
import { idempotencyKeyReuse } from './registration.command';
import { assertPermission } from './permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from './tenancy.service';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';

export interface CreateZoneCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly name: string;
}

/** The API response body for a zone (the idempotency snapshot). */
export interface ZoneSnapshot {
  readonly zone: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly code: string;
    readonly name: string;
    readonly createdAt: string;
  };
}

const ZONES_WAREHOUSE_CODE = 'zones_warehouse_id_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * Zone creation (Story 1.3): validates nothing itself (DTO layer does),
 * asserts the parent warehouse belongs to the tenant inside the transaction
 * (404 `not-found` when absent — warehouse scoping is app-layer, RLS stays
 * single-dimension), and writes the zone with `tenant_id` + `warehouse_id`
 * stamped. Codes are unique per warehouse — the duplicate rejection names the
 * conflicting code. Idempotency de-dupe in the same transaction (AD-5).
 */
@Injectable()
export class ZoneCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async create(command: CreateZoneCommand, idempotencyKey: string): Promise<ZoneSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      code: command.code,
      name: command.name,
    });

    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry (Story 1.5) — DB read, same tx.
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'zone.create',
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
        if (existing[0]) {
          if (existing[0].payloadHash !== payloadHash) {
            throw idempotencyKeyReuse();
          }
          return {
            snapshot: existing[0].responseSnapshot as ZoneSnapshot,
            replayed: true,
          };
        }

        // Warehouse ownership inside the write transaction — before any zone
        // write (spec 1.3 Design Notes). RLS already scopes to the tenant;
        // this catches a foreign/nonexistent warehouse as 404.
        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

        let zone: ZoneSnapshot['zone'];
        try {
          const rows = await tx
            .insert(zones)
            .values({
              id: uuidv7(),
              tenantId: command.tenantId,
              warehouseId: command.warehouseId,
              code: command.code,
              name: command.name,
            })
            .returning();
          const row = rows[0]!;
          zone = {
            id: row.id,
            tenantId: row.tenantId,
            warehouseId: row.warehouseId,
            code: row.code,
            name: row.name,
            createdAt: row.createdAt,
          };
        } catch (err) {
          if (isUniqueViolationOn(err, ZONES_WAREHOUSE_CODE)) {
            throw duplicateZoneCode(command.code);
          }
          throw err;
        }

        // In-transaction outbox append (AD-7, story outbox-relay) — replaces
        // the old post-commit publish. The `!replayed` gate of the old
        // post-commit publish is structural here: the idempotent replay
        // returned above (and a concurrent duplicate's transaction rolls
        // back whole), so a replayed create appends nothing.
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'zone.created',
          occurredAt: nowIso(),
          payload: {
            zoneId: zone.id,
            warehouseId: zone.warehouseId,
            code: zone.code,
          },
        });

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: { zone },
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            // Concurrent duplicate of the same idempotent request — the
            // winner's response is authoritative (warehouse.command.ts).
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent idempotent request',
              'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
        return { snapshot: { zone }, replayed: false };
      },
    );

    return snapshot;
  }
}

export function duplicateZoneCode(code: string): ProblemException {
  return new ProblemException(
    'duplicate-zone-code',
    409,
    'Zone code already in use',
    `Zone code "${code}" already exists in this warehouse.`,
  );
}