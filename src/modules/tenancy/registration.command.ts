import { Inject } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { idempotencyKeys, tenants, users } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import type { DomainEvent, EventBus } from '../../shared/events/event-bus.seam';
import { hashPassword } from './passwords';
import { hashCommandPayload } from './idempotency-guard';
import { setTenantScope } from './tenant-scope';
import { EVENT_BUS } from './event-bus';

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
 * tenant), but replay lookup is by key alone — a foreign replay fails the
 * payload-hash comparison (422 `idempotency-key-reuse`), so nothing leaks.
 * Duplicate email is enforced by the DB unique constraint (the RLS-scoped
 * session cannot see other tenants' users to check first).
 */
@Injectable()
export class RegistrationCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EVENT_BUS) private readonly eventBus: EventBus,
  ) {}

  async register(
    command: RegisterTenantCommand,
    idempotencyKey: string,
  ): Promise<TenantRegistrationSnapshot> {
    const payloadHash = hashCommandPayload({
      name: command.name,
      ownerEmail: command.ownerEmail,
      password: command.password,
    });
    const passwordHash = await hashPassword(command.password);

    const { snapshot, replayed } = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, idempotencyKey))
        .limit(1);
      if (existing[0]) {
        if (existing[0].payloadHash !== payloadHash) {
          throw idempotencyKeyReuse();
        }
        return {
          snapshot: existing[0].responseSnapshot as TenantRegistrationSnapshot,
          replayed: true,
        };
      }

      const tenantId = uuidv7();
      await setTenantScope(tx, tenantId);
      const email = command.ownerEmail;

      const tenantRows = await tx
        .insert(tenants)
        .values({ id: tenantId, tenantId, name: command.name })
        .returning();
      const tenant = tenantRows[0]!;

      let owner: { id: string; email: string };
      try {
        const userRows = await tx
          .insert(users)
          .values({ id: uuidv7(), tenantId, email, passwordHash })
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
      await tx.insert(idempotencyKeys).values({
        id: uuidv7(),
        tenantId,
        key: idempotencyKey,
        payloadHash,
        responseSnapshot: body,
      });
      return { snapshot: body, replayed: false };
    });

    if (!replayed) {
      await this.eventBus.publish({
        eventId: uuidv7(),
        type: 'tenant.registered',
        tenantId: snapshot.tenant.id,
        occurredAt: nowIso(),
        payload: { name: snapshot.tenant.name, ownerEmail: snapshot.owner.email },
      } satisfies DomainEvent);
    }
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