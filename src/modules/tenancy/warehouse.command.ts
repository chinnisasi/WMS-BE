import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { idempotencyKeys, warehouses } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from './idempotency-guard';
import { idempotencyKeyReuse } from './registration.command';
import { assertPermission } from './permissions';
import { getMemberRoleIn } from './tenancy.service';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { addressFingerprint, assertAddress, addressFromColumns, normalizeAddressInput } from '../../shared/primitives/address';
import type { AddressInput, AddressSnapshot } from '../../shared/primitives/address';

export interface CreateWarehouseCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly code: string;
  readonly name: string;
  /**
   * The origin address (story 11-1) — where shipments leave from. REQUIRED
   * at create (the human decision 2026-09-19); validated command-side
   * (`assertAddress`, behind the replay lookup) because the shape rules must
   * hold for any non-HTTP caller too, not only the DTO path. Set at create
   * only — no update endpoint exists (story 4-6d owns that decision).
   */
  readonly origin?: AddressInput | undefined;
}

/** The API response body for a warehouse (the idempotency snapshot). */
export interface WarehouseSnapshot {
  readonly warehouse: {
    readonly id: string;
    readonly tenantId: string;
    readonly code: string;
    readonly name: string;
    /** The origin address (story 11-1); null on a pre-11.1 warehouse row. */
    readonly origin: AddressSnapshot | null;
    readonly createdAt: string;
  };
}

const WAREHOUSES_TENANT_CODE = 'warehouses_tenant_id_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * Warehouse creation (AD-10): writes the warehouse with `tenant_id` stamped,
 * and de-dupes on `(tenant_id, key)` in the same transaction (AD-5). Codes
 * are unique per tenant — the duplicate rejection names the conflicting code.
 * The origin address (story 11-1) is validated HERE, behind the replay
 * lookup (`assertAddress`) — the DTO mirrors the shapes for HTTP callers,
 * but the command is the boundary that keeps a bad address out of the
 * columns (the adapter-path rule).
 */
@Injectable()
export class WarehouseCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async create(
    command: CreateWarehouseCommand,
    idempotencyKey: string,
  ): Promise<WarehouseSnapshot> {
    // Story 11-1: the origin joins the payload hash with the key always
    // present (`?? null`) — a pre-11.1 body (no origin) hashes differently
    // from any 11.1 body, so an in-flight pre-11.1 key answers 422 rather
    // than replaying (the accepted hash-break precedent, pinned for orders
    // in test/shipment-addresses.spec.ts). Normalized before hashing —
    // deterministic, DB-independent.
    const normalizedOrigin = addressFingerprint(normalizeAddressInput(command.origin));
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      code: command.code,
      name: command.name,
      origin: normalizedOrigin ?? null,
    });

    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry (Story 1.5): the role is re-read
        // from the DB in this same tenant transaction — never a JWT claim.
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'warehouse.create',
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
            snapshot: existing[0].responseSnapshot as WarehouseSnapshot,
            replayed: true,
          };
        }

        let warehouse: WarehouseSnapshot['warehouse'];
        // Story 11-1: the origin's shape rules run HERE, behind the replay
        // lookup — required at create, atomic, pincode six digits as text.
        const origin = assertAddress(command.origin, 'origin');
        try {
          const rows = await tx
            .insert(warehouses)
            .values({
              id: uuidv7(),
              tenantId: command.tenantId,
              code: command.code,
              name: command.name,
              originContactName: origin.contactName,
              originPhone: origin.phone,
              originLine1: origin.line1,
              originLine2: origin.line2 ?? null,
              originCity: origin.city,
              originState: origin.state,
              originPincode: origin.pincode,
            })
            .returning();
          const row = rows[0]!;
          warehouse = {
            id: row.id,
            tenantId: row.tenantId,
            code: row.code,
            name: row.name,
            origin: addressFromColumns({
              contactName: row.originContactName,
              phone: row.originPhone,
              line1: row.originLine1,
              line2: row.originLine2,
              city: row.originCity,
              state: row.originState,
              pincode: row.originPincode,
            }),
            createdAt: row.createdAt,
          };
        } catch (err) {
          if (isUniqueViolationOn(err, WAREHOUSES_TENANT_CODE)) {
            throw duplicateWarehouseCode(command.code);
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
          type: 'warehouse.created',
          occurredAt: nowIso(),
          payload: {
            warehouseId: warehouse.id,
            code: warehouse.code,
            name: warehouse.name,
          },
        });

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