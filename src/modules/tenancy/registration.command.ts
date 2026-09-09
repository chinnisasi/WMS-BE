import { Inject } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AUTH_DATABASE, DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { idempotencyKeys, tenants, users } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { hashPassword } from './passwords';
import { hashCommandPayload } from './idempotency-guard';
import { setTenantScope } from '../../shared/db/tenant-scope';

/** Registration command input (AD-10: state changes enter command services). */
export interface RegisterTenantCommand {
  readonly name: string;
  readonly ownerEmail: string;
  readonly password: string;
}

/** The API response body — never carries the password hash. */
export interface TenantRegistrationSnapshot {
  readonly tenant: { readonly id: string; readonly name: string };
  readonly owner: { readonly id: string; readonly email: string };
}

const USERS_EMAIL = 'users_email_unique';

/**
 * Tenant registration: one transaction creates the tenant, its Owner user
 * (scrypt-hashed password), and the idempotency record (AD-5) — replay
 * returns the original response, a hash mismatch 422s, and a duplicate owner
 * email 409s without creating anything.
 *
 * Idempotency scoping note: registration is the one command with no tenant
 * context yet. The stored row is still tenant-scoped (tenant_id = the created
 * tenant), but the replay lookup runs by key alone on the AUTH_DATABASE
 * connection (BYPASSRLS role — review loop 1 decision): the fail-closed RLS
 * policies would hide the row from the scoped app role and turn every replay
 * into a duplicate-email 409. A foreign replay fails the payload-hash
 * comparison (422 `idempotency-key-reuse`), so nothing leaks. Duplicate email
 * is enforced by the DB unique constraint inside the scoped write
 * transaction.
 *
 * The payload fingerprint covers `name` + the normalized `ownerEmail` —
 * never password material: the raw password would make a leaked idempotency
 * row an offline password oracle, and the scrypt hash is salted (random per
 * call), so it cannot be part of a replay-deterministic fingerprint either.
 * A retry with the same key+name+email replays the original response.
 */
@Injectable()
export class RegistrationCommand {
  constructor(
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async register(
    command: RegisterTenantCommand,
    idempotencyKey: string,
  ): Promise<TenantRegistrationSnapshot> {
    const email = command.ownerEmail.trim().toLowerCase();
    // Cheap fingerprint first, replay lookup second, scrypt hash LAST — a
    // replay must not pay the ~100 ms hashing cost just to discard it.
    const payloadHash = hashCommandPayload({
      name: command.name,
      ownerEmail: email,
    });

    // Auth-time replay lookup (no tenant context yet) — BYPASSRLS connection.
    const existing = await this.authDb
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, idempotencyKey))
      .limit(1);
    if (existing[0]) {
      if (existing[0].payloadHash !== payloadHash) {
        throw idempotencyKeyReuse();
      }
      return existing[0].responseSnapshot as TenantRegistrationSnapshot;
    }

    const passwordHash = await hashPassword(command.password);

    const snapshot = await this.db.transaction(async (tx) => {
      const tenantId = uuidv7();
      await setTenantScope(tx, tenantId);

      const tenantRows = await tx
        .insert(tenants)
        .values({ id: tenantId, tenantId, name: command.name })
        .returning();
      const tenant = tenantRows[0]!;

      let owner: { id: string; email: string };
      try {
        const userRows = await tx
          .insert(users)
          .values({ id: uuidv7(), tenantId, email, passwordHash, role: 'owner' })
          .returning();
        const user = userRows[0]!;
        owner = { id: user.id, email: user.email };
      } catch (err) {
        if (isUniqueViolationOn(err, USERS_EMAIL)) {
          throw new ProblemException(
            'duplicate-email',
            409,
            'Owner email already registered',
            `An account for ${email} already exists.`,
          );
        }
        throw err;
      }

      const body: TenantRegistrationSnapshot = {
        tenant: { id: tenant.id, name: tenant.name },
        owner,
      };
      // In-transaction outbox append (AD-7, story outbox-relay) — replaces
      // the old post-commit publish. The auth-time replay lookup returned
      // before this transaction, so a replayed registration appends nothing;
      // a concurrent duplicate's transaction rolls back whole.
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId,
        type: 'tenant.registered',
        occurredAt: nowIso(),
        payload: { name: tenant.name, ownerEmail: owner.email },
      });
      await tx.insert(idempotencyKeys).values({
        id: uuidv7(),
        tenantId,
        key: idempotencyKey,
        payloadHash,
        responseSnapshot: body,
      });
      return body;
    });

    return snapshot;
  }
}

export function idempotencyKeyReuse(): ProblemException {
  return new ProblemException(
    'idempotency-key-reuse',
    422,
    'Idempotency key already used with a different payload',
    'This Idempotency-Key was previously used with a different request payload.',
  );
}