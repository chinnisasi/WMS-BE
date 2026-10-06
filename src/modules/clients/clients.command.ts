import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { CLIENT_CODE_RE, CLIENT_NAME_MAX, SELF_CLIENT_CODE, clients } from './clients.schema';
import { clientNotFound, toClientSnapshot, type ClientSnapshot } from './clients.facade';

export interface CreateClientCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly code: string;
  readonly name: string;
}

export interface RenameClientCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  readonly name: string;
}

/** The API response body for a client mutation (the idempotency snapshot). */
export interface ClientMutationSnapshot {
  readonly client: ClientSnapshot;
}

const CLIENTS_TENANT_CODE = 'clients_tenant_id_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** Trim + uppercase — the stored form (the warehouse-code convention). */
export function normalizeClientCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Client admin (story 21-2b): an owner registers a client brand and renames
 * it. The house skeleton (IMPLEMENTATION-GUIDE §1): the payload is
 * normalized and hashed BEFORE the transaction; inside it, authority
 * (`clients.manage`, owner-only, re-read from the DB) → replay → shape
 * validation → the write → the audit row → the idempotency key LAST. No
 * outbox event — nothing downstream consumes a client's existence yet.
 *
 * Deliberately absent (the story's Never list): status transitions,
 * deletion, and any write to the system-owned `self` client — it is created
 * only by registration (`ensureSelfClientInTx`) and its name mirrors the
 * tenant's, so a rename of it is refused 400.
 */
@Injectable()
export class ClientsCommand {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(command: CreateClientCommand, idempotencyKey: string): Promise<ClientMutationSnapshot> {
    const code = normalizeClientCode(command.code);
    const name = command.name.trim();
    const payloadHash = hashCommandPayload({ tenantId: command.tenantId, code, name });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'clients.manage',
      );
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }

      // The command is the boundary (a non-HTTP caller skips the DTO): the
      // same rules the 0059 CHECKs enforce, answered as a named 400 rather
      // than a raw 23514.
      assertClientCode(code);
      assertClientName(name);

      let snapshot: ClientMutationSnapshot;
      try {
        const rows = await tx
          .insert(clients)
          .values({
            id: uuidv7(),
            tenantId: command.tenantId,
            code,
            name,
            status: 'active',
            systemOwned: false,
          })
          .returning();
        snapshot = { client: toClientSnapshot(rows[0]!) };
      } catch (err) {
        // The unique (tenant_id, code) index is the arbiter — a sequential
        // duplicate and a concurrent one both land here.
        if (isUniqueViolationOn(err, CLIENTS_TENANT_CODE)) {
          throw duplicateClientCode(code);
        }
        throw err;
      }

      await this.audit(tx, command.tenantId, command.actorUserId, 'client.created', snapshot.client.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  async rename(command: RenameClientCommand, idempotencyKey: string): Promise<ClientMutationSnapshot> {
    const name = command.name.trim();
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      clientId: command.clientId,
      name,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'clients.manage',
      );
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }

      // A non-uuid id names nothing — 404, never a raw 22P02 (the controller
      // refuses the malformed path param 400 first; this is the non-HTTP
      // boundary).
      if (!UUID_RE.test(command.clientId)) {
        throw clientNotFound(command.clientId);
      }
      const lockedRows = await tx
        .select()
        .from(clients)
        .where(and(eq(clients.tenantId, command.tenantId), eq(clients.id, command.clientId)))
        .limit(1)
        .for('update');
      const current = lockedRows[0];
      if (current === undefined) {
        throw clientNotFound(command.clientId);
      }
      if (current.systemOwned) {
        throw new ProblemException(
          'validation-failed',
          400,
          'The self client cannot be renamed',
          "The tenant's own client mirrors the tenant name — it is not renamed here.",
        );
      }
      assertClientName(name);
      // An unchanged name is a no-op: nothing is written, nothing audited.
      if (current.name === name) {
        return { client: toClientSnapshot(current) };
      }

      const rows = await tx
        .update(clients)
        .set({ name, updatedAt: nowIso() })
        .where(and(eq(clients.tenantId, command.tenantId), eq(clients.id, current.id)))
        .returning();
      const snapshot: ClientMutationSnapshot = { client: toClientSnapshot(rows[0]!) };

      await this.audit(tx, command.tenantId, command.actorUserId, 'client.renamed', current.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<ClientMutationSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (row === undefined) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return row.responseSnapshot as ClientMutationSnapshot;
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    actorUserId: string,
    action: 'client.created' | 'client.renamed',
    clientId: string,
    reference: string,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId,
      action,
      targetType: 'client',
      targetId: clientId,
      reference,
      occurredAt: nowIso(),
    });
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: ClientMutationSnapshot,
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({
        id: uuidv7(),
        tenantId,
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
  }
}

/** The created-client code rule (the 0059 CHECKs, answered as a 400). */
export function assertClientCode(code: string): void {
  if (code === SELF_CLIENT_CODE.toUpperCase()) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Client code is reserved',
      `Client code "${code}" is reserved for the tenant's own client — choose another code.`,
    );
  }
  if (!CLIENT_CODE_RE.test(code)) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Invalid client code',
      `Client code "${code}" must be 2-32 characters of A-Z, 0-9 and "-", starting with a letter or digit.`,
    );
  }
}

export function assertClientName(name: string): void {
  const length = [...name].length;
  if (length < 1 || length > CLIENT_NAME_MAX) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Invalid client name',
      `Client name must be 1-${CLIENT_NAME_MAX} characters once trimmed (got ${length}).`,
    );
  }
}

function duplicateClientCode(code: string): ProblemException {
  return new ProblemException(
    'duplicate-client-code',
    409,
    'Client code already in use',
    `Client code "${code}" already exists for this tenant.`,
  );
}
