import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { idempotencyKeys, vendors } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';

export interface CreateVendorCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly code: string;
  readonly name: string;
  readonly isDefault: boolean;
}

/** The API response body for a vendor (the idempotency snapshot). */
export interface VendorSnapshot {
  readonly vendor: {
    readonly id: string;
    readonly tenantId: string;
    readonly code: string;
    readonly name: string;
    readonly isDefault: boolean;
    readonly createdAt: string;
  };
}

const VENDORS_TENANT_CODE = 'vendors_tenant_id_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * Vendor creation (Story 3.1): vendors are a real entity — not a free-text
 * field on the PO — because Epic 6's suggested-PO drafts read default
 * vendors (human decision 2026-09-09). Validates nothing itself (DTO layer
 * does), writes the vendor with `tenant_id` stamped, and de-dupes on
 * `(tenant_id, key)` in the same transaction (AD-5). Codes are unique per
 * tenant (the SKU-code convention) — the duplicate rejection names the
 * conflicting code.
 */
@Injectable()
export class VendorCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async create(
    command: CreateVendorCommand,
    idempotencyKey: string,
  ): Promise<VendorSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      code: command.code,
      name: command.name,
      isDefault: command.isDefault,
    });

    const { snapshot } = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        // Authority at command-service entry — DB role read, same tx, BEFORE
        // the replay lookup (the deliberate fail-closed carve-out).
        assertPermission(
          await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
          'vendor.manage',
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
            snapshot: existing[0].responseSnapshot as VendorSnapshot,
            replayed: true,
          };
        }

        let vendor: VendorSnapshot['vendor'];
        try {
          const rows = await tx
            .insert(vendors)
            .values({
              id: uuidv7(),
              tenantId: command.tenantId,
              code: command.code,
              name: command.name,
              isDefault: command.isDefault,
            })
            .returning();
          const row = rows[0]!;
          vendor = {
            id: row.id,
            tenantId: row.tenantId,
            code: row.code,
            name: row.name,
            isDefault: row.isDefault,
            createdAt: row.createdAt,
          };
        } catch (err) {
          if (isUniqueViolationOn(err, VENDORS_TENANT_CODE)) {
            throw duplicateVendorCode(command.code);
          }
          throw err;
        }

        // In-transaction outbox append (AD-7) — the replay returned above and
        // a concurrent duplicate's transaction rolls back whole, so a
        // replayed create appends nothing. The payload carries the full
        // post-mutation vendor snapshot (no read-after-write for consumers).
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'vendor.created',
          occurredAt: nowIso(),
          payload: { vendor },
        });

        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: { vendor },
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
        return { snapshot: { vendor }, replayed: false };
      },
    );

    return snapshot;
  }
}

function duplicateVendorCode(code: string): ProblemException {
  return new ProblemException(
    'conflict',
    409,
    'Vendor code already in use',
    `Vendor code "${code}" already exists for this tenant.`,
  );
}