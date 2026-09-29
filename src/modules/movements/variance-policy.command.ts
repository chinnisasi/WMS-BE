import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, countVariancePolicies, idempotencyKeys } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { fromMilli, QUANTITY_SCALE } from '../../shared/primitives/quantity';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import type { SetVariancePolicyCommand, VariancePolicySnapshot } from './count.command';

/**
 * The variance-threshold policy commands (story 5-4): the PER-TENANT config
 * routing a count variance to resolution — the
 * `stock_adjustment_policies` mirror, in the inventory module's file:
 * capability assert BEFORE the replay lookup (fail-closed), the policy row
 * locked `.for('update')`, insert-with-unique-violation-409 / update (the
 * matrix's race-loser 409), the audit row, idempotency LAST.
 *
 * The write rides `variances.resolve` (a policy IS the resolution rule — the
 * `waves.manage` rationale): the threshold decides which variances go
 * owner-only and what the submit freezes. No delete verb (PUT is upsert); a
 * null threshold disables the routing, the same semantics as a missing row.
 */
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const POLICY_TENANT_KEY = 'count_variance_policies_tenant_id_unique';

/**
 * The threshold's base-unit ceiling on the wire: the stored column is
 * integer MILLI-units, so a base threshold above the int4 ceiling over
 * milli-scaling would overflow the row — refused at the edge, never
 * silently clamped.
 */
export const MAX_VARIANCE_THRESHOLD_BASE = Math.floor(2_147_483_647 / 1_000);

/**
 * One threshold conversion, one place: the wire's base units scale to the
 * stored milli column behind the SHAPE CHECK (integer base × the scale is
 * exact, and the ceiling above proves the row fits int4). Null passes
 * through — the disabled shape.
 */
function thresholdToMilli(quantityThreshold: number | null): number | null {
  if (quantityThreshold === null) {
    return null;
  }
  if (!Number.isInteger(quantityThreshold) || quantityThreshold < 0) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Threshold must be a non-negative whole number',
      `quantityThreshold must be a whole base-unit number ≥ 0, or null to disable (got ${quantityThreshold}).`,
    );
  }
  if (quantityThreshold > MAX_VARIANCE_THRESHOLD_BASE) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Threshold exceeds the stored column bound',
      `quantityThreshold must be ≤ ${MAX_VARIANCE_THRESHOLD_BASE} base units (the stored milli column is an integer; ${quantityThreshold} would overflow it).`,
    );
  }
  return quantityThreshold * QUANTITY_SCALE;
}

@Injectable()
export class VariancePolicyCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /**
   * PUT …/movements/variance-policies — the tenant's threshold row,
   * idempotent under the Idempotency-Key (a replay re-serves the stored
   * snapshot; a key reuse with a different threshold is the 422). Audit
   * row: `count.variance_policy_updated`.
   */
  async setVariancePolicy(
    command: SetVariancePolicyCommand,
    idempotencyKey: string,
  ): Promise<VariancePolicySnapshot> {
    const thresholdMilli = thresholdToMilli(command.quantityThreshold);
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      quantityThreshold: command.quantityThreshold,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority at command-service entry — DB role read, same tx, BEFORE
      // the replay lookup (the deliberate fail-closed carve-out).
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'variances.resolve',
      );

      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(eq(idempotencyKeys.tenantId, command.tenantId), eq(idempotencyKeys.key, idempotencyKey)),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].payloadHash !== payloadHash) {
          throw idempotencyKeyReuse();
        }
        return existing[0].responseSnapshot as VariancePolicySnapshot;
      }

      const updatedAt = nowIso();
      const current = await tx
        .select()
        .from(countVariancePolicies)
        .where(eq(countVariancePolicies.tenantId, command.tenantId))
        .limit(1)
        .for('update');
      let written: readonly (typeof countVariancePolicies.$inferSelect)[];
      if (current[0] === undefined) {
        try {
          written = await tx
            .insert(countVariancePolicies)
            .values({
              id: uuidv7(),
              tenantId: command.tenantId,
              quantityThresholdMilli: thresholdMilli,
            })
            .returning();
        } catch (err) {
          // Two concurrent first-time PUTs race the unique index — the
          // winner's row is authoritative; retry to read the settled result.
          if (isUniqueViolationOn(err, POLICY_TENANT_KEY)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent policy write',
              'The variance threshold policy is being written concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
      } else {
        written = await tx
          .update(countVariancePolicies)
          .set({ quantityThresholdMilli: thresholdMilli, updatedAt })
          .where(eq(countVariancePolicies.id, current[0]!.id))
          .returning();
      }
      const policy = written[0]!;

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'count.variance_policy_updated',
        targetType: 'count_variance_policy',
        targetId: policy.id,
        reference: idempotencyKey,
        occurredAt: updatedAt,
      });

      const snapshot: VariancePolicySnapshot = {
        id: policy.id,
        tenantId: policy.tenantId,
        quantityThreshold: policy.quantityThresholdMilli === null ? null : fromMilli(policy.quantityThresholdMilli),
        createdAt: canonicalInstant(policy.createdAt),
        updatedAt: canonicalInstant(policy.updatedAt),
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
      return snapshot;
    });
  }

  /**
   * GET …/movements/variance-policies — the tenant's policy row, or null
   * when none exists (the routing is disabled; the controller answers 404).
   * A read — never capability-gated.
   */
  async getVariancePolicy(tenantId: string): Promise<VariancePolicySnapshot | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(countVariancePolicies)
        .where(eq(countVariancePolicies.tenantId, tenantId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        id: row.id,
        tenantId: row.tenantId,
        quantityThreshold: row.quantityThresholdMilli === null ? null : fromMilli(row.quantityThresholdMilli),
        createdAt: canonicalInstant(row.createdAt),
        updatedAt: canonicalInstant(row.updatedAt),
      };
    });
  }
}
