import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, licencePolicies } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { licenceToday } from './licence-enforcement';
import { coverageGapsInTx } from './licence-coverage';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** The switch as every read and write answers it (the idempotency snapshot of a PUT). */
export interface LicencePolicySnapshot {
  /** On: uncovered drug or food receipt lines go to review, and such orders are refused. */
  readonly enforce: boolean;
  /**
   * The KNOWN coverage gaps today (IST) — `coverageGaps().gaps.length`. A
   * lower bound on what enforcement refuses: a blind receipt, or an order of
   * goods with no stock or open document anywhere, is refused without having
   * been a gap.
   */
  readonly gapCount: number;
}

export interface SetLicencePolicyCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly enforce: boolean;
  /** A precondition for turning on with known gaps — never hashed. */
  readonly acknowledgeGaps: boolean;
}

export function licenceGapsUnacknowledged(gapCount: number): ProblemException {
  return new ProblemException(
    'licence-gaps-unacknowledged',
    409,
    'Known licence coverage gaps',
    `There ${gapCount === 1 ? 'is 1 known coverage gap' : `are ${gapCount} known coverage gaps`} — with enforcement on, uncovered receipts (including goods on open POs and ASNs) go to review and such orders are refused. Send acknowledgeGaps: true to turn it on anyway.`,
    { gapCount },
  );
}

/**
 * Story 1-6d — the per-tenant licence enforcement switch (decisions 1, 7,
 * 12). Off by default (no row). The PUT is owner-only (`licences.manage`):
 * hash `{tenantId, enforce}` (`acknowledgeGaps` is a precondition, not part
 * of the hash) → authority → replay → the row `FOR UPDATE` → replay again →
 * unchanged → a declared no-op that stores the key (`licencePolicy.put:
 * unchanged`, no audit) → turning ON with known gaps and no acknowledgement →
 * 409 `licence-gaps-unacknowledged` (`gapCount`) → the upsert → audit
 * `licence.enforcement_changed` (target `licence_policy`) → the key LAST.
 * Turning it off is always allowed.
 */
@Injectable()
export class LicencePolicyCommand {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The switch and today's known gap count — any staff session (the controller refuses a portal token). */
  async read(tenantId: string): Promise<LicencePolicySnapshot> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ enforce: licencePolicies.enforce })
        .from(licencePolicies)
        .where(eq(licencePolicies.tenantId, tenantId))
        .limit(1);
      const gaps = await coverageGapsInTx(tx, tenantId, licenceToday());
      return { enforce: rows[0]?.enforce === true, gapCount: gaps.gaps.length };
    });
  }

  async set(command: SetLicencePolicyCommand, idempotencyKey: string): Promise<LicencePolicySnapshot> {
    if (typeof command.enforce !== 'boolean') {
      throw new ProblemException('validation-failed', 400, 'Invalid licence policy', 'enforce must be true or false.');
    }
    const payloadHash = hashCommandPayload({ tenantId: command.tenantId, enforce: command.enforce });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'licences.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      const current = await this.lockPolicy(tx, command.tenantId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;

      const enforcedNow = current?.enforce === true;
      const gapCount = (await coverageGapsInTx(tx, command.tenantId, licenceToday())).gaps.length;
      if (enforcedNow === command.enforce) {
        // A declared no-op (`licencePolicy.put:unchanged`): nothing written or audited; the key is stored.
        const snapshot: LicencePolicySnapshot = { enforce: enforcedNow, gapCount };
        await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }
      if (command.enforce && gapCount > 0 && command.acknowledgeGaps !== true) {
        throw licenceGapsUnacknowledged(gapCount);
      }

      let policyId: string;
      if (current === null) {
        try {
          const inserted = await tx
            .insert(licencePolicies)
            .values({ id: uuidv7(), tenantId: command.tenantId, enforce: command.enforce, updatedBy: command.actorUserId })
            .returning({ id: licencePolicies.id });
          policyId = inserted[0]!.id;
        } catch (err) {
          if (isUniqueViolationOn(err, 'licence_policies_tenant_unique')) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent licence policy change',
              'Another change to the licence enforcement switch committed first — reload it and decide again.',
            );
          }
          throw err;
        }
      } else {
        await tx
          .update(licencePolicies)
          .set({ enforce: command.enforce, updatedBy: command.actorUserId, updatedAt: nowIso() })
          .where(and(eq(licencePolicies.tenantId, command.tenantId), eq(licencePolicies.id, current.id)));
        policyId = current.id;
      }
      const snapshot: LicencePolicySnapshot = { enforce: command.enforce, gapCount };
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'licence.enforcement_changed',
        targetType: 'licence_policy',
        targetId: policyId,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * The tenant's policy row `FOR UPDATE`, or null when none exists yet (off).
   * Two first-ever PUTs racing both see null; the tenant unique index lets
   * one insert win and the other answers 409 `conflict` (a retry reads the
   * winner's row).
   */
  private async lockPolicy(tx: TenantTx, tenantId: string): Promise<{ id: string; enforce: boolean } | null> {
    const rows = await tx
      .select({ id: licencePolicies.id, enforce: licencePolicies.enforce })
      .from(licencePolicies)
      .where(eq(licencePolicies.tenantId, tenantId))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<LicencePolicySnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot as LicencePolicySnapshot;
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: LicencePolicySnapshot,
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key: idempotencyKey, payloadHash, responseSnapshot: snapshot });
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
  }
}
