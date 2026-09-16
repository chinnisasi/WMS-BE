import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, carrierConnections, idempotencyKeys } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { getCarrierAdapter, knownCarrierCodes } from './carrier-registry';
import type { CarrierAdapter } from './carrier-registry';
import {
  MissingCarrierEncryptionKeyError,
  credentialHmac,
  sealCredential,
  validateCredential,
} from './carrier-credentials';
import type { CarrierCredential } from './carrier-credentials';
import {
  CARRIER_TENANT_CODE_UNIQUE,
  IDEMPOTENCY_TENANT_KEY,
  accountLabelRequired,
  carrierAlreadyConnected,
  carrierConnectionNotFound,
  carrierEncryptionUnavailable,
  concurrentIdempotency,
  credentialRejected,
  unknownCarrierCode,
} from './carriers.errors';

/**
 * The carrier credential vault's command service (Story 4.6b, AD-15):
 * connect, rotate, disconnect. The `bin-state.command.ts` landmark order
 * throughout — payload hash before the transaction, role re-read at command
 * entry, inline replay block, row lock, guards, write, then **outbox → audit
 * → idempotency key**, all in ONE `withTenantTransaction`.
 *
 * The one thing this command does differently from every sibling, and the
 * reason the story exists:
 *
 *   **the credential never reaches durable storage in any readable form.**
 *
 * Story 3.2 stored a device credential AND its sealed offline-store key in
 * `idempotency_keys.response_snapshot` (`enrollment.command.ts:79-84`) — a
 * durable, tenant-readable jsonb column. Copying that precedent here would
 * defeat the whole story, so the snapshot carries the connection's PUBLIC
 * FACE only, the outbox payload and audit row carry ids, and the payload
 * hash takes the credential as a master-key HMAC rather than as the secret
 * itself (see `carrier-credentials.ts`).
 */

/** The connection's public face — the ONLY shape that leaves this module. */
export interface CarrierConnectionView {
  readonly id: string;
  readonly tenantId: string;
  readonly carrierCode: string;
  /** The registry's display name, resolved at read time (never stored). */
  readonly carrierName: string;
  readonly accountLabel: string;
  readonly credentialVersion: number;
  readonly connectedBy: string;
  readonly rotatedAt: string | null;
  readonly rotatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectCarrierCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly carrierCode: string;
  readonly accountLabel: string;
  /** Plaintext material — sealed before the transaction, never stored raw. */
  readonly credential: unknown;
}

export interface RotateCarrierCredentialCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly credential: unknown;
}

export interface DisconnectCarrierCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly connectionId: string;
}

export const MAX_ACCOUNT_LABEL_LENGTH = 100;

/** The stored row's public projection. `credentialSealed` is never selected. */
type ConnectionRow = {
  id: string;
  tenantId: string;
  carrierCode: string;
  accountLabel: string;
  credentialVersion: number;
  connectedBy: string;
  rotatedAt: string | null;
  rotatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toConnectionView(row: ConnectionRow): CarrierConnectionView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    carrierCode: row.carrierCode,
    // A row whose adapter was de-registered still lists (the registry is
    // additive, but a deployment rollback could do it) — the code is the
    // truth, the name is a convenience.
    carrierName: getCarrierAdapter(row.carrierCode)?.displayName ?? row.carrierCode,
    accountLabel: row.accountLabel,
    credentialVersion: row.credentialVersion,
    connectedBy: row.connectedBy,
    rotatedAt: row.rotatedAt === null ? null : canonicalInstant(row.rotatedAt),
    rotatedBy: row.rotatedBy,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

/** The select list every read of this table uses — the sealed blob is absent. */
export const CONNECTION_COLUMNS = {
  id: carrierConnections.id,
  tenantId: carrierConnections.tenantId,
  carrierCode: carrierConnections.carrierCode,
  accountLabel: carrierConnections.accountLabel,
  credentialVersion: carrierConnections.credentialVersion,
  connectedBy: carrierConnections.connectedBy,
  rotatedAt: carrierConnections.rotatedAt,
  rotatedBy: carrierConnections.rotatedBy,
  createdAt: carrierConnections.createdAt,
  updatedAt: carrierConnections.updatedAt,
} as const;

/**
 * Anything touching the master key runs inside this: a missing (or too short)
 * `CARRIER_ENCRYPTION_KEY` escapes `seal`/`hmac` as a raw 500 otherwise — the
 * `sealOfflineStoreKey` shape from 3.2, typed as a 503 instead.
 */
function withCarrierKey<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof MissingCarrierEncryptionKeyError) {
      throw carrierEncryptionUnavailable();
    }
    throw err;
  }
}

/** Adapter-checked material, or the 400 naming exactly what was wrong. */
function acceptCredential(adapter: CarrierAdapter, supplied: unknown): CarrierCredential {
  const outcome = validateCredential(adapter, supplied);
  if ('failure' in outcome) {
    throw credentialRejected(adapter.code, outcome.failure);
  }
  return outcome.credential;
}

function acceptAccountLabel(raw: string): string {
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (label === '' || label.length > MAX_ACCOUNT_LABEL_LENGTH) {
    throw accountLabelRequired();
  }
  return label;
}

@Injectable()
export class CarrierCommandService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  /**
   * `POST /tenants/{tenantId}/carriers/connections` — seals a tenant's
   * credential for one registered carrier. A second connect for the same
   * carrier is a 409 off the unique index (never a read-then-write race).
   */
  async connect(
    command: ConnectCarrierCommand,
    idempotencyKey: string,
  ): Promise<CarrierConnectionView> {
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority at command-service entry (Story 1.5) — DB read, same tx —
      // and it precedes EVERYTHING (the `inventory.controller.ts:127-129`
      // convention): before any validation 400, before the master key is
      // touched, before the replay pre-check. A caller without the capability
      // must not learn which carrier codes the registry holds or whether the
      // deployment has an encryption key, and must not be able to drive
      // AES work by sending material it was never allowed to store.
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'carrier.manage',
      );

      // Registry + shape refusals run BEFORE anything is sealed or written:
      // an unknown carrier and a missing field are 400s that touch no state.
      const adapter = getCarrierAdapter(command.carrierCode);
      if (adapter === undefined) {
        throw unknownCarrierCode(command.carrierCode, knownCarrierCodes());
      }
      const accountLabel = acceptAccountLabel(command.accountLabel);
      const credential = acceptCredential(adapter, command.credential);

      // The hash takes the credential as a MASTER-KEY HMAC, never the secret:
      // `payload_hash` is persisted, and a bare sha256 of a low-entropy API
      // key is a crackable digest of that key. Replay detection is unchanged
      // — identical material hmacs identically, different material 422s.
      const { sealed, hmac } = withCarrierKey(() => ({
        sealed: sealCredential(credential),
        hmac: credentialHmac(credential),
      }));
      const payloadHash = hashCommandPayload({
        tenantId: command.tenantId,
        carrierCode: adapter.code,
        accountLabel,
        credentialHmac: hmac,
      });

      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }

      const id = uuidv7();
      let row: ConnectionRow;
      try {
        const inserted = await tx
          .insert(carrierConnections)
          .values({
            id,
            tenantId: command.tenantId,
            carrierCode: adapter.code,
            accountLabel,
            credentialSealed: sealed,
            credentialVersion: 1,
            connectedBy: command.actorUserId,
          })
          .returning(CONNECTION_COLUMNS);
        row = inserted[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, CARRIER_TENANT_CODE_UNIQUE)) {
          throw carrierAlreadyConnected(adapter.code);
        }
        throw err;
      }
      const connection = toConnectionView(row);

      await this.recordAndSettle(tx, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'carrier.connected',
        connection,
        idempotencyKey,
        payloadHash,
      });
      return connection;
    });
  }

  /**
   * `POST .../connections/{connectionId}/rotate` — replaces the material IN
   * PLACE. The row id is the stable handle AD-15 means by "referenced by id"
   * (what rating and 4-6c will store against a shipment), so a rotation that
   * minted a new id would orphan every reference; `credential_version`
   * increments and `rotated_at`/`rotated_by` stamp the row.
   */
  async rotate(
    command: RotateCarrierCredentialCommand,
    idempotencyKey: string,
  ): Promise<CarrierConnectionView> {
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority before everything, connect's rule (a caller without the
      // capability must not learn whether the deployment holds a key).
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'carrier.manage',
      );

      // The adapter is only known once the row is read, so the material is
      // validated further down; the HMAC needs only the master key, so the
      // payload hash is still computed before the replay pre-check (the
      // landmark order).
      const hmac = withCarrierKey(() => credentialHmac(asStringRecord(command.credential)));
      const payloadHash = hashCommandPayload({
        tenantId: command.tenantId,
        connectionId: command.connectionId,
        credentialHmac: hmac,
      });

      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }

      // The row first, locked — the guards run against the locked row BEFORE
      // any write, so a rejection never depends on an UPDATE rolling back.
      const locked = await tx
        .select(CONNECTION_COLUMNS)
        .from(carrierConnections)
        .where(
          and(
            eq(carrierConnections.id, command.connectionId),
            eq(carrierConnections.tenantId, command.tenantId),
          ),
        )
        .limit(1)
        .for('update');
      const existing = locked[0];
      if (!existing) {
        throw carrierConnectionNotFound();
      }

      const adapter = getCarrierAdapter(existing.carrierCode);
      if (adapter === undefined) {
        // The row names a carrier this build no longer registers — refuse
        // rather than seal material against a port that does not exist.
        throw unknownCarrierCode(existing.carrierCode, knownCarrierCodes());
      }
      const credential = acceptCredential(adapter, command.credential);
      const sealed = withCarrierKey(() => sealCredential(credential));

      const rotatedAt = nowIso();
      const updated = await tx
        .update(carrierConnections)
        .set({
          credentialSealed: sealed,
          credentialVersion: existing.credentialVersion + 1,
          rotatedAt,
          rotatedBy: command.actorUserId,
          updatedAt: rotatedAt,
        })
        .where(eq(carrierConnections.id, existing.id))
        .returning(CONNECTION_COLUMNS);
      const connection = toConnectionView(updated[0]!);

      await this.recordAndSettle(tx, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'carrier.credential_rotated',
        connection,
        idempotencyKey,
        payloadHash,
      });
      return connection;
    });
  }

  /**
   * `POST .../connections/{connectionId}/disconnect` — a hard DELETE. AD-15
   * says disconnect deletes, and a status flip would leave sealed secret
   * material at rest after the operator asked for it to be gone. The verb
   * shape follows `devices/{id}/revoke` (the repo has no `@Delete` route
   * anywhere — every destructive verb is a POST sub-resource carrying an
   * `Idempotency-Key`); the effect follows `po.command.ts`'s hard delete.
   *
   * A repeat under a NEW key is a 404: the row is gone, so there is nothing
   * to disconnect. A repeat under the SAME key replays the snapshot.
   */
  async disconnect(
    command: DisconnectCarrierCommand,
    idempotencyKey: string,
  ): Promise<CarrierConnectionView> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      connectionId: command.connectionId,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'carrier.manage',
      );

      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }

      const locked = await tx
        .select(CONNECTION_COLUMNS)
        .from(carrierConnections)
        .where(
          and(
            eq(carrierConnections.id, command.connectionId),
            eq(carrierConnections.tenantId, command.tenantId),
          ),
        )
        .limit(1)
        .for('update');
      const existing = locked[0];
      if (!existing) {
        throw carrierConnectionNotFound();
      }
      const connection = toConnectionView(existing);

      await tx.delete(carrierConnections).where(eq(carrierConnections.id, existing.id));

      await this.recordAndSettle(tx, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'carrier.disconnected',
        connection,
        idempotencyKey,
        payloadHash,
      });
      return connection;
    });
  }

  /**
   * The inline replay block (the `bin-state.command.ts` shape). Scoped to
   * `(tenant_id, key)` — never `key` alone: `idempotency_keys` is unique per
   * tenant AND key, so a lookup on the key alone would read ANOTHER tenant's
   * row (3.2's device-credential hijack case, and worse here).
   */
  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<CarrierConnectionView | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (!row) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return (row.responseSnapshot as { connection: CarrierConnectionView }).connection;
  }

  /**
   * The landmark tail, one place for all three commands: outbox → audit →
   * idempotency key (the current convention `bin-state.command.ts` documents;
   * 3.2 has them reversed).
   *
   * **None of the three carries secret material.** The outbox payload is ids
   * and the version counter — an integration event is relayed to a bus and
   * may be logged by its consumers; the audit row is the actor and the
   * target; and the snapshot is the connection's public face, NOT the 3.2
   * precedent of a credential in `response_snapshot`.
   */
  private async recordAndSettle(
    tx: TenantTx,
    args: {
      tenantId: string;
      actorUserId: string;
      action: 'carrier.connected' | 'carrier.credential_rotated' | 'carrier.disconnected';
      connection: CarrierConnectionView;
      idempotencyKey: string;
      payloadHash: string;
    },
  ): Promise<void> {
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId: args.tenantId,
      type: args.action,
      occurredAt: nowIso(),
      payload: {
        connectionId: args.connection.id,
        carrierCode: args.connection.carrierCode,
        credentialVersion: args.connection.credentialVersion,
      },
    });

    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      action: args.action,
      targetType: 'carrier_connection',
      targetId: args.connection.id,
      reference: args.idempotencyKey,
      occurredAt: nowIso(),
    });

    try {
      await tx.insert(idempotencyKeys).values({
        id: uuidv7(),
        tenantId: args.tenantId,
        key: args.idempotencyKey,
        payloadHash: args.payloadHash,
        responseSnapshot: { connection: args.connection },
      });
    } catch (err) {
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        throw concurrentIdempotency();
      }
      throw err;
    }
  }
}

/**
 * The HMAC input for a rotation, computed before the adapter is known — so it
 * normalizes COARSELY where connect's hash normalizes exactly: it keeps every
 * string-valued key, declared or not, and drops everything else, whereas
 * connect hashes the adapter-validated record.
 *
 * That coarseness is deliberate (the digest only has to be STABLE for
 * identical material, and the adapter is not known yet), and this is what it
 * costs: a caller that retries the SAME key after adding an undeclared field
 * — or after fixing a non-string value — hashes differently, so it gets
 * `422 idempotency-key-reuse` instead of the 400 that would name the field.
 * A fresh key gets the naming 400. The alternative, dropping the credential
 * from the hash, would make a key reused with genuinely different secret
 * material look like a replay, which is the worse failure by far.
 */
function asStringRecord(supplied: unknown): CarrierCredential {
  if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
    return {};
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(supplied as Record<string, unknown>)) {
    // Blank values are dropped exactly as `validateCredential` drops them,
    // so a well-formed rotation hmacs the same record that gets sealed.
    if (typeof value === 'string' && value.trim() !== '') {
      record[key] = value.trim();
    }
  }
  return record;
}
