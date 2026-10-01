import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  channelMappings,
  idempotencyKeys,
  integrationCalls,
  integrations,
} from '../../shared/db/schema';
import type { Integration } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { MAX_QUANTITY_MILLI } from '../../shared/primitives/quantity';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import {
  getMemberRoleIn,
  assertWarehouseInTenant,
  TenancyService,
  MAX_WAREHOUSE_PAGE_SIZE,
} from '../tenancy/tenancy.service';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import { ChannelsPublishService } from './channels.publish';
import { knownChannelProviderCodes, requireChannelAdapterOrNull } from './channel-registry';
import type { ChannelAdapter } from './channel-registry';
import {
  MissingChannelEncryptionKeyError,
  credentialHmac,
  openCredential,
  sealCredential,
  validateCredential,
} from './channel-credentials';
import {
  CHANNEL_TENANT_PROVIDER_UNIQUE,
  IDEMPOTENCY_TENANT_KEY,
  bufferSkuNotFound,
  bufferWarehouseNotFound,
  channelConnectionExists,
  channelConnectionNotFound,
  channelCredentialRejected,
  channelEncryptionUnavailable,
  concurrentIdempotency,
  ingestWarehouseNotFound,
  invalidUuidParam,
  unknownChannelProvider,
} from './channels.errors';
import { MAX_SYNC_SCOPES_PER_PUBLISH } from './channels.publish';
import type { PublishedScope } from './channels.events';
import { CONNECTION_COLUMNS, toConnectionView } from './channels.view';
import type {
  ChannelConnectionView,
  ChannelBufferVerdict,
  SetConnectionBuffersResult,
} from './channels.view';

/**
 * The channels command service (Story 7.1): connect, rotate credentials,
 * update the connection's config (backorder policy), set standing buffers,
 * disconnect, and the manual `retry`. The `carrier.command.ts` landmark
 * order throughout — payload hash before the transaction, role re-read at
 * command entry, inline replay block, row lock, guards, write, then
 * **outbox → audit → idempotency key** — all in ONE `withTenantTransaction`
 * wherever a single transaction can hold every invariant.
 *
 * Two documented deviations from the single-transaction skeleton (the spec's
 * Design Notes + this module's head rule):
 *
 *   **`setConnectionBuffers`** applies its items through the inventory
 *   facade's standing-buffer arm — one `applyChannelBuffer` call per item,
 *   each its own transaction, because the reservation core arbitrates each
 *   target against the live counter in its own two-phase machinery. A
 *   per-item ceiling refusal is a per-item verdict (`refused`,
 *   `buffer-over-ceiling`, the OLD buffer standing), not a request-level
 *   409; only a malformed item (400), a store outage (503) or a settled
 *   conflict fails the whole request. The idempotency-key row is written in
 *   a final small transaction after all items settle: a crash mid-request
 *   replays safely because targets are ABSOLUTE (re-applying the same list
 *   is a no-op per unchanged item).
 *
 *   **`retryConnection`** computes the published scopes through the
 *   inventory facade BETWEEN two transactions (one read tx per scope —
 *   the core's committed read by design, RN-6), then half-opens the breaker
 *   and appends the outbox publication in the second.
 *
 * `disconnect` is the spec's hard DELETE (the carriers shape): the row goes
 * with the sealed credential inside it, every standing buffer this
 * connection holds releases THROUGH the core's release (a buffer IS a
 * reservations row, AD-13) with its counter mirror after commit, and the
 * mapped external references go with it (no orphan mapping survives its
 * connection). Story 7.2 (RN-7): the revoke port attempt happens AFTER the
 * delete commits — outside any transaction (a real HTTP arm inside the tx
 * would hold the row lock up to CHANNEL_HTTP_TIMEOUT_MS), metered, logged,
 * never blocking (an unreachable channel keeps no say in the disconnect;
 * AD-15 makes deletion a local atomic act). The read happens in the
 * unlocking first transaction, and the delete re-locks and re-404s (same
 * Idempotency-Key replays are carried by
 * the response being 204 — there is no snapshot to serve).
 *
 * All secrets ride the AD-15 paths of `channel-credentials.ts`: sealed
 * before insert, never selected into any view or snapshot, and hashed into
 * `payload_hash` only as a master-key HMAC.
 */

/** The connection's public face lives in `channels.view.ts` (shared with the
 * facade and the delivery handler — no module-internal import cycle). */

export interface ConnectChannelCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly provider: string;
  /** Plaintext material — sealed before the transaction, never stored raw. */
  readonly credentials: unknown;
}

export interface RotateChannelCredentialCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly connectionId: string;
  /** Plaintext material — sealed before the transaction, never stored raw. */
  readonly credentials: unknown;
}

export interface UpdateConnectionConfigCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly backorderPolicy: 'accept' | 'reject';
  /**
   * Story 7.2 (RD-4): the one ingest warehouse, WYSIWYG — ABSENT means
   * "unchanged", an explicit `null` means "clear", a uuid sets it. The
   * command-side boundary validates the uuid shape (the DTO carries
   * @IsUUID, but the command is the boundary for non-HTTP callers) and the
   * tenant membership (404).
   */
  readonly ingestWarehouseId?: string | null | undefined;
}

export interface DisconnectChannelCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly connectionId: string;
}

export interface RetryConnectionCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly connectionId: string;
}

export interface ChannelBufferPlanItem {
  readonly warehouseId: string;
  readonly skuId: string;
  readonly bufferMilli: number;
}

export interface SetConnectionBuffersCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly items: readonly ChannelBufferPlanItem[];
}

/**
 * The mappings PUT's item (story 7.2, T6 — the 7-1 facade-only seed arm's
 * first ROUTE caller). FULL replacement: the connection's mapping set
 * becomes exactly `items` — rows removed from the list are gone.
 */
export interface ChannelMappingItem {
  readonly externalRef: string;
  readonly skuId: string;
}

export interface SetConnectionMappingsCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly items: readonly ChannelMappingItem[];
}


/** The per-item bound on one buffers request (the sync's ≤200 bound, shared). */
export const MAX_BUFFER_ITEMS = 200;

/**
 * Anything touching the master key runs inside this: a missing (or too
 * short) `CHANNEL_ENCRYPTION_KEY` escapes `seal`/`hmac` as a raw 500
 * otherwise — the `withCarrierKey` shape from 4.6b, typed as a 503 instead.
 */
function withChannelKey<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof MissingChannelEncryptionKeyError) {
      throw channelEncryptionUnavailable();
    }
    throw err;
  }
}

/** Adapter-checked material, or the 400 naming exactly what was wrong. */
function acceptCredential(adapter: ChannelAdapter, supplied: unknown) {
  const outcome = validateCredential(adapter, supplied);
  if ('failure' in outcome) {
    throw channelCredentialRejected(adapter.code, outcome.failure);
  }
  return outcome.credential;
}

/**
 * The HMAC input for a rotation, computed before the adapter is known — the
 * carriers command's coarse normalization verbatim (its rationale is its
 * own: the digest only has to be STABLE for identical material, and a
 * same-key retry with different-shaped material 422s rather than 400s,
 * which is the worse failure's cost by design).
 */
function asStringRecord(supplied: unknown): Record<string, string> {
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

/** The problem code off a thrown refinement (the `order.command.ts` helper). */
function codeOf(error: ProblemException): string {
  return (error.getResponse() as { code: string }).code;
}

/** 400 `validation-failed` — the mappings PUT's generic shape refusal. */
function validationFailed(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Mapping set rejected', detail);
}

/** 400 `validation-failed` — the item count of the mappings PUT is over the cap. */
function mappingSetTooLarge(count: number, max: number): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    'Mapping set too large',
    `The mapping list carries ${count} entries; at most ${max} SKUs per connection. (The full scope arithmetic rides the ceiling check inside the transaction.)`,
  );
}

@Injectable()
export class ChannelsCommandService {
  private readonly logger = new Logger('ChannelsCommand');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(ChannelsPublishService) private readonly publish: ChannelsPublishService,
    // Story 7.2 (T6) — the scope-ceiling arithmetic counts the tenant's
    // ACTIVE warehouses (the publish's scope enumeration dimension).
    @Inject(TenancyService) private readonly tenancy: TenancyService,
  ) {}

  /**
   * Arm 1 — `POST .../channels/connections`: seals a tenant's credential
   * for one registered channel provider. A second connect for the same
   * provider is a 409 off the unique index (never a read-then-write race).
   */
  async connect(
    command: ConnectChannelCommand,
    idempotencyKey: string,
  ): Promise<ChannelConnectionView> {
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority at command-service entry — before any validation 400,
      // before the master key is touched, before the replay pre-check (a
      // caller without the capability must not learn which providers the
      // registry holds or whether the deployment has an encryption key).
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'channel.manage',
      );

      // Registry + shape refusals run BEFORE anything is sealed or written.
      const adapter = requireChannelAdapterOrNull(command.provider);
      if (adapter === null) {
        throw unknownChannelProvider(command.provider, knownChannelProviderCodes());
      }
      const credential = acceptCredential(adapter, command.credentials);

      // The hash takes the credential as a MASTER-KEY HMAC, never the
      // secret (`payload_hash` is persisted; a bare sha256 of a low-entropy
      // API key would be a crackable digest of that key).
      const { sealed, hmac } = withChannelKey(() => ({
        sealed: sealCredential(credential),
        hmac: credentialHmac(credential),
      }));
      const payloadHash = hashCommandPayload({
        tenantId: command.tenantId,
        provider: adapter.code,
        credentialHmac: hmac,
      });

      const replayed = await this.replayConnection(
        tx,
        command.tenantId,
        idempotencyKey,
        payloadHash,
      );
      if (replayed !== null) {
        return replayed;
      }

      const id = uuidv7();
      let row: Omit<Integration, 'credentialSealed'>;
      try {
        const inserted = await tx
          .insert(integrations)
          .values({
            id,
            tenantId: command.tenantId,
            provider: adapter.code,
            status: 'connected',
            credentialSealed: sealed,
            credentialVersion: 1,
            connectedBy: command.actorUserId,
          })
          .returning(CONNECTION_COLUMNS);
        row = inserted[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, CHANNEL_TENANT_PROVIDER_UNIQUE)) {
          throw channelConnectionExists(adapter.code);
        }
        throw err;
      }
      const connection = toConnectionView(row);

      await this.settle(tx, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'channels.connected',
        connection,
        idempotencyKey,
        payloadHash,
        outbox: {
          type: 'channels.connected',
          payload: {
            connectionId: connection.id,
            provider: connection.provider,
            credentialVersion: connection.credentialVersion,
          },
        },
      });
      return connection;
    });
  }

  /**
   * Arm 2 — `PUT .../connections/{id}/credentials`: replaces the material
   * IN PLACE. The row id is the stable handle every mapping and standing
   * buffer is stored against (AD-15's "referenced by id"), so a rotation
   * that minted a new id would orphan them; `credential_version` increments
   * and `rotated_at`/`rotated_by` stamp the row.
   */
  async rotateCredentials(
    command: RotateChannelCredentialCommand,
    idempotencyKey: string,
  ): Promise<ChannelConnectionView> {
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority before everything, connect's rule.
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'channel.manage',
      );

      // The adapter is only known once the row is read, so the material is
      // validated further down; the HMAC needs only the master key, so the
      // payload hash is still computed before the replay pre-check (the
      // landmark order).
      const hmac = withChannelKey(() => credentialHmac(asStringRecord(command.credentials)));
      const payloadHash = hashCommandPayload({
        tenantId: command.tenantId,
        connectionId: command.connectionId,
        credentialHmac: hmac,
      });

      const replayed = await this.replayConnection(
        tx,
        command.tenantId,
        idempotencyKey,
        payloadHash,
      );
      if (replayed !== null) {
        return replayed;
      }

      // The row first, locked — the guards run against the locked row
      // BEFORE any write.
      const existing = await this.lockConnection(tx, command.tenantId, command.connectionId);
      if (existing === null) {
        throw channelConnectionNotFound();
      }

      const adapter = requireChannelAdapterOrNull(existing.provider);
      if (adapter === null) {
        // A row naming a provider this build no longer registers is refused
        // rather than sealed against a port that does not exist.
        throw unknownChannelProvider(existing.provider, knownChannelProviderCodes());
      }
      const credential = acceptCredential(adapter, command.credentials);
      const sealed = withChannelKey(() => sealCredential(credential));

      const rotatedAt = nowIso();
      const updated = await tx
        .update(integrations)
        .set({
          credentialSealed: sealed,
          credentialVersion: existing.credentialVersion + 1,
          rotatedAt,
          rotatedBy: command.actorUserId,
          updatedAt: rotatedAt,
        })
        .where(eq(integrations.id, existing.id))
        .returning(CONNECTION_COLUMNS);
      const connection = toConnectionView(updated[0]!);

      await this.settle(tx, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'channels.credentials_rotated',
        connection,
        idempotencyKey,
        payloadHash,
        outbox: {
          type: 'channels.credentials_rotated',
          payload: {
            connectionId: connection.id,
            provider: connection.provider,
            credentialVersion: connection.credentialVersion,
          },
        },
      });
      return connection;
    });
  }

  /**
   * Arm 2b — `PUT .../connections/{id}`: the connection's config — the
   * backorder policy (consumed by the ingest's acceptance, RD-3) and, story
   * 7.2, the ingest warehouse (RD-4: WYSIWYG — absent = unchanged, null =
   * clear, uuid = set with a 404 on a foreign/unknown warehouse). A config
   * write only — no credential material is involved.
   */
  async updateConnectionConfig(
    command: UpdateConnectionConfigCommand,
    idempotencyKey: string,
  ): Promise<ChannelConnectionView> {
    // RD-4's uuid-shape boundary (22P02-free): the DTO validates too, but
    // the command is the boundary for the adapter path.
    if (typeof command.ingestWarehouseId === 'string' && !UUID_RE.test(command.ingestWarehouseId)) {
      throw invalidUuidParam('ingestWarehouseId', command.ingestWarehouseId);
    }
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      connectionId: command.connectionId,
      backorderPolicy: command.backorderPolicy,
      // `undefined` drops (absent = unchanged); `null` stays (clear). The
      // two hash differently — replay distinguishes them.
      ingestWarehouseId: command.ingestWarehouseId ?? undefined,
      ingestWarehouseCleared: command.ingestWarehouseId === null ? true : undefined,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'channel.manage',
      );

      const replayed = await this.replayConnection(
        tx,
        command.tenantId,
        idempotencyKey,
        payloadHash,
      );
      if (replayed !== null) {
        return replayed;
      }

      const existing = await this.lockConnection(tx, command.tenantId, command.connectionId);
      if (existing === null) {
        throw channelConnectionNotFound();
      }

      // The warehouse write's own guards, in THIS transaction (404 before
      // any write): a set that is a uuid must belong to the tenant.
      if (typeof command.ingestWarehouseId === 'string') {
        await assertWarehouseInTenant(tx, command.tenantId, command.ingestWarehouseId).catch(
          (err) => {
            if (err instanceof ProblemException && err.getStatus() === 404) {
              throw ingestWarehouseNotFound(command.ingestWarehouseId!);
            }
            throw err;
          },
        );
      }

      const updatedAt = nowIso();
      const updated = await tx
        .update(integrations)
        .set({
          backorderPolicy: command.backorderPolicy,
          // Absent = unchanged (the field is skipped); explicit null = clear.
          ...(command.ingestWarehouseId === undefined
            ? {}
            : { ingestWarehouseId: command.ingestWarehouseId }),
          updatedAt,
        })
        .where(eq(integrations.id, existing.id))
        .returning(CONNECTION_COLUMNS);
      const connection = toConnectionView(updated[0]!);

      await this.settle(tx, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'channels.backorder_policy_set',
        connection,
        idempotencyKey,
        payloadHash,
        outbox: {
          type: 'channels.backorder_policy_set',
          payload: {
            connectionId: connection.id,
            provider: connection.provider,
            backorderPolicy: command.backorderPolicy,
            ...(command.ingestWarehouseId === undefined
              ? {}
              : { ingestWarehouseId: command.ingestWarehouseId }),
          },
        },
      });
      return connection;
    });
  }

  /**
   * Arm 5 — `PUT .../channels/{connectionId}/buffers`: standing-buffer
   * placement and adjustment (RN-3). See the module head: per-item
   * verdicts, per-item transactions, the key written in a final small tx.
   * A refused item's verdict carries `buffer-over-ceiling` and the OLD
   * buffer standing — the reservation core rolled the change back by
   * construction, so no mirror moves for it.
   */
  async setConnectionBuffers(
    command: SetConnectionBuffersCommand,
    idempotencyKey: string,
  ): Promise<SetConnectionBuffersResult> {
    // Shape at command entry (the DTO types; the BOUNDS here, so a crafted
    // 0.5 or a negative never reaches the core).
    if (command.items.length < 1 || command.items.length > MAX_BUFFER_ITEMS) {
      throw new ProblemException(
        'validation-failed',
        400,
        'items length out of bounds',
        `items carries ${command.items.length} entries; between 1 and ${MAX_BUFFER_ITEMS} is required.`,
      );
    }
    for (const item of command.items) {
      if (
        !Number.isInteger(item.bufferMilli) ||
        item.bufferMilli < 0 ||
        item.bufferMilli > MAX_QUANTITY_MILLI
      ) {
        throw new ProblemException(
          'validation-failed',
          400,
          'bufferMilli out of range',
          `bufferMilli must be an integer between 0 and ${MAX_QUANTITY_MILLI} (got ${item.bufferMilli}).`,
        );
      }
    }
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      connectionId: command.connectionId,
      items: command.items,
    });

    // Phase 1 — authority, replay, connection + scope asserts. No writes.
    const stored = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'channel.manage',
      );
      const replayed = await this.replayBuffers(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      const existing = await this.lockConnection(tx, command.tenantId, command.connectionId);
      if (existing === null) {
        throw channelConnectionNotFound();
      }
      for (const warehouseId of [...new Set(command.items.map((item) => item.warehouseId))]) {
        await assertWarehouseInTenant(tx, command.tenantId, warehouseId).catch((err) => {
          if (err instanceof ProblemException) {
            throw bufferWarehouseNotFound(warehouseId);
          }
          throw err;
        });
      }
      // Catalog reads ride its facade (never a foreign table raw) — the
      // read is the SKU-in-tenant existence assert.
      for (const skuId of [...new Set(command.items.map((item) => item.skuId))]) {
        const sku = await this.catalog.findSku(command.tenantId, skuId);
        if (sku === null) {
          throw bufferSkuNotFound(skuId);
        }
      }
      return null;
    });
    if (stored !== null) {
      return stored;
    }

    // Phase 2 — per-item application through the inventory facade's
    // standing-buffer arm (its own transaction; the counter arbitrates).
    const verdicts: ChannelBufferVerdict[] = [];
    for (const [index, item] of command.items.entries()) {
      try {
        const result = await this.inventory.applyChannelBuffer({
          tenantId: command.tenantId,
          warehouseId: item.warehouseId,
          skuId: item.skuId,
          ownerId: command.connectionId,
          targetMilli: item.bufferMilli,
        });
        verdicts.push({
          index,
          warehouseId: item.warehouseId,
          skuId: item.skuId,
          status: result.previousMilli === result.targetMilli ? 'unchanged' : 'applied',
          bufferMilli: item.bufferMilli,
          standingMilli: result.targetMilli,
        });
      } catch (err) {
        // A deterministic ceiling loss is a per-item refusal, NOT a
        // request-level 409: the target could not be granted against the
        // pool, the old buffer stands, and the request continues. The
        // standing read here has NO catch-to-zero: the same store being
        // down must propagate and fail the whole request fail-closed (503
        // — nothing was written), never report a standing of 0 the store
        // itself contradicts.
        if (err instanceof ProblemException && err.getStatus() === 409 && codeOf(err) === 'unavailable') {
          const standing = await this.inventory
            .channelVisibleQuantity(command.tenantId, item.warehouseId, item.skuId, command.connectionId)
            .then((pool) => pool.buffer);
          verdicts.push({
            index,
            warehouseId: item.warehouseId,
            skuId: item.skuId,
            status: 'refused',
            bufferMilli: item.bufferMilli,
            standingMilli: standing,
            code: 'buffer-over-ceiling',
            detail: err.message,
          });
          continue;
        }
        // Malformed (400), store-down (503), a genuine conflict — the whole
        // request fails (the facade surfaces them verbatim). A crash
        // mid-request + replay stays safe: targets are absolute, so a
        // partial run's re-application is a no-op per settled item.
        throw err;
      }
    }

    // Phase 3 — the audit row + the idempotency key's write, LAST (one
    // small tx; a concurrent duplicate of the same request 409s on the key
    // insert instead of re-applying, which would also be safe). The audit
    // rides here like every sibling command's settle tail (the buffers PUT
    // moves real ATP, so it is audited like them).
    const compensated: Awaited<ReturnType<InventoryFacade['standingBuffersByOwnerInTx']>> = [];
    const result: SetConnectionBuffersResult = {
      connectionId: command.connectionId,
      verdicts,
    };
    try {
      await withTenantTransaction(this.db, command.tenantId, async (tx) => {
        // A disconnect may have committed between Phase 1 and the per-item
        // transactions (which never re-check the connection), leaving
        // owner-scoped `held` rows for a deleted owner no surface can ever
        // release. This compensator exists because the per-item txs cannot
        // be serialized against the disconnect's delete — it releases
        // whatever the disconnect left behind, exactly the way disconnect
        // itself does (release-in-tx here, counter mirrors after commit).
        const stillThere = await tx
          .select({ id: integrations.id })
          .from(integrations)
          .where(
            and(
              eq(integrations.id, command.connectionId),
              eq(integrations.tenantId, command.tenantId),
            ),
          )
          .limit(1);
        if (stillThere[0] === undefined) {
          const orphans = await this.inventory.standingBuffersByOwnerInTx(
            tx,
            command.tenantId,
            command.connectionId,
          );
          for (const buffer of orphans) {
            await this.inventory.releaseReservationInTx(tx, command.tenantId, buffer.id);
          }
          compensated.push(...orphans);
        }

        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'channels.buffers_set',
          targetType: 'channel_connection',
          targetId: command.connectionId,
          reference: idempotencyKey,
          occurredAt: nowIso(),
        });

        await tx.insert(idempotencyKeys).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          key: idempotencyKey,
          payloadHash,
          responseSnapshot: { result },
        });
      });
    } catch (err) {
      // No mirror on this path: the failed tx rolled the compensator's
      // releases back with it, so there is nothing committed to mirror.
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        throw concurrentIdempotency();
      }
      throw err;
    }
    // Post-commit mirror for any compensator release — the same
    // never-throws shape disconnect uses (a lost mirror fails safe: the
    // parity pass heals; log, never rethrow).
    for (const buffer of compensated) {
      try {
        await this.inventory.restoreReservedUnits(
          command.tenantId,
          buffer.warehouseId,
          buffer.skuId,
          buffer.quantity,
        );
      } catch (err) {
        this.logger.error(
          `post-commit counter restore for compensator release of buffer ${buffer.id} failed (parity pass heals): ${String(err)}`,
        );
      }
    }
    return result;
  }

  /**
   * Arm 3 — `DELETE .../connections/{id}`: a hard DELETE (the carriers
   * disconnect shape — a status flip would leave sealed secret material at
   * rest after the operator asked for it to be gone). Story 7.2 (RN-7): the
   * revoke attempt rides AFTER the delete commits — outside any transaction
   * (a port call inside the tx would hold the row lock up to
   * `CHANNEL_HTTP_TIMEOUT_MS`); the delete releases the connection's
   * standing buffers and drops its mappings; mirrors happen after the
   * commit. The route returns 204 — there is no snapshot to replay, and a
   * repeat under a NEW key is a 404 (the carriers rule). The Idempotency-Key
   * is still consumed (its key row records the disconnect happened), so a
   * same-key retry after a crash before the revoke cannot silently skip it.
   */
  async disconnect(
    command: DisconnectChannelCommand,
    idempotencyKey: string,
  ): Promise<void> {
    // The arm discriminator keeps this hash from colliding with
    // `retryConnection`'s (an identical `{tenantId, connectionId}` shape):
    // one Idempotency-Key reused ACROSS the two arms must 422
    // `idempotency-key-reuse`, never settle the second arm from the
    // first's key row.
    const payloadHash = hashCommandPayload({
      arm: 'disconnect',
      tenantId: command.tenantId,
      connectionId: command.connectionId,
    });

    // Phase 1 — authority (+ replay: an idempotent repeat settles without
    // a second revoke attempt) + the row read with its sealed blob.
    type DisconnectPhase1 =
      | { kind: 'settled' }
      | { kind: 'row'; row: Integration };
    const phase1 = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'channel.manage',
      );
      const replayed = await this.replayDisconnect(
        tx,
        command.tenantId,
        idempotencyKey,
        payloadHash,
      );
      if (replayed) {
        return { kind: 'settled' } satisfies DisconnectPhase1;
      }
      const rows = await tx
        .select()
        .from(integrations)
        .where(
          and(
            eq(integrations.id, command.connectionId),
            eq(integrations.tenantId, command.tenantId),
          ),
        )
        .limit(1)
        .for('update');
      if (rows[0] === undefined) {
        throw channelConnectionNotFound();
      }
      return { kind: 'row', row: rows[0] } satisfies DisconnectPhase1;
    });
    if (phase1.kind === 'settled') {
      return; // replayed delete under the same key: already done (204)
    }
    const existing = phase1.row;

    // Phase 2 — the delete itself, one transaction: release buffers, drop
    // mappings + the row, audit, consume the key. (The revoke attempt moved
    // AFTER this commit — story 7.2's RN-7 fold; see below the mirror loop.)
    const released = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const locked = await this.lockConnection(tx, command.tenantId, command.connectionId);
      if (locked === null) {
        // The row left between the phases — but a CONCURRENT duplicate of
        // this same request may have been the one that deleted it and
        // settled the key. Mirror `retryConnection`'s double-replay shape:
        // a second replay answers settled for that loser (an empty
        // `released` — the post-commit mirror loop skips), and only a
        // genuinely absent connection under an unsettled key is the 404.
        const settled = await this.replayDisconnect(
          tx,
          command.tenantId,
          idempotencyKey,
          payloadHash,
        );
        if (settled) {
          return [];
        }
        throw channelConnectionNotFound();
      }
      // Every standing buffer this connection holds, released through the
      // core's release-in-tx (the journal rows to 'released'). The caller
      // mirrors once per release AFTER the commit — the counter sees one
      // net decrease per buffer, single net mirror (the spec's arm-3 rule).
      const buffers = await this.inventory.standingBuffersByOwnerInTx(
        tx,
        command.tenantId,
        existing.id,
      );
      for (const buffer of buffers) {
        await this.inventory.releaseReservationInTx(tx, command.tenantId, buffer.id);
      }
      await tx
        .delete(channelMappings)
        .where(
          and(
            eq(channelMappings.tenantId, command.tenantId),
            eq(channelMappings.integrationId, existing.id),
          ),
        );
      await tx.delete(integrations).where(eq(integrations.id, existing.id));

      // The revoke attempt's METER row moved after the commit with the
      // attempt itself (RN-7). The audit row + the key row — the landmark
      // tail's order, adapted.
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'channels.disconnected',
        targetType: 'channel_connection',
        targetId: existing.id,
        occurredAt: nowIso(),
      });
      try {
        await tx.insert(idempotencyKeys).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          key: idempotencyKey,
          payloadHash,
          responseSnapshot: { disconnected: existing.id },
        });
      } catch (err) {
        if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
          // A concurrent duplicate: it wants the same effect (a delete),
          // so the settled row is enough — rethrow as the shared 409.
          throw concurrentIdempotency();
        }
        throw err;
      }
      return buffers;
    });

    // Post-commit mirror (the core's one-mirror rule): each release
    // decrements its counter exactly once. Never throws (a lost mirror
    // fails safe — the parity pass heals over-estimates and under-holds
    // is caught by the store-down path, not by silent oversell).
    for (const buffer of released) {
      try {
        await this.inventory.restoreReservedUnits(
          command.tenantId,
          buffer.warehouseId,
          buffer.skuId,
          buffer.quantity,
        );
      } catch (err) {
        this.logger.error(
          `post-commit counter restore for buffer ${buffer.id} failed (parity pass heals): ${String(err)}`,
        );
      }
    }

    // ── story 7.2 (RN-7 / review finding 4): the re-revoke rides AFTER the
    // delete commits, OUTSIDE any transaction. The 7-1 posture revoked
    // BEFORE the delete tx; with a real HTTP revoke arm that would hold the
    // row's lock up to CHANNEL_HTTP_TIMEOUT_MS against the pool — the exact
    // lock-duration the pool-nesting gotcha forbids. Post-commit is equally
    // correct under AD-15: the delete is a local atomic act, and the stale
    // blob's revocation needs no transaction. Phase 1's row is the read —
    // the delete re-locked and re-404'd below; this attempt uses ITS blob.

    const adapter = requireChannelAdapterOrNull(existing.provider);
    let revokeError: string | null = null;
    let revokeStatus: 'ok' | 'failed' = 'ok';
    if (adapter === null || adapter === undefined) {
      revokeStatus = 'failed';
      revokeError = 'adapter no longer registered';
    } else {
      try {
        const credential = openCredential(existing.credentialSealed!);
        await adapter.revokeArm({
          tenantId: command.tenantId,
          integrationId: existing.id,
          provider: existing.provider,
          credential,
        });
        revokeStatus = 'ok';
      } catch (err) {
        revokeStatus = 'failed';
        revokeError = err instanceof MissingChannelEncryptionKeyError
          ? 'credential unopenable (encryption key unavailable)'
          : err instanceof Error
            ? err.message.slice(0, 300)
            : 'revoke attempt failed';
        this.logger.warn(
          `revoke attempt for provider ${existing.provider} connection ${existing.id} failed: ${revokeError}`,
        );
      }
    }

    // The revoke attempt's meter row — its own tiny transaction, best-effort
    // (a lost meter row must not wedge anything; the delete already
    // committed and the caller's answer stands).
    try {
      await withTenantTransaction(this.db, command.tenantId, async (tx) => {
        await tx.insert(integrationCalls).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          integrationId: existing.id,
          kind: 'credential-revoke',
          status: revokeStatus,
          latencyMs: null,
          error: revokeError,
          at: nowIso(),
        });
      });
    } catch (err) {
      this.logger.error(
        `meter row for the revoke attempt of connection ${existing.id} failed to write (non-blocking): ${String(err)}`,
      );
    }
  }

  /**
   * Arm 6 — `POST .../connections/{id}/retry`: the manual restart. Two
   * transactions per the module head — the first asserts, replays and
   * 404s and reads the mapped sku set; the visible quantities are computed
   * between the two (one read tx per scope through the core); the second
   * half-opens the breaker, appends the outbox publication, and settles.
   */
  async retryConnection(
    command: RetryConnectionCommand,
    idempotencyKey: string,
  ): Promise<ChannelConnectionView> {
    // The arm discriminator keeps this hash from colliding with
    // `disconnect`'s (an identical `{tenantId, connectionId}` shape): one
    // Idempotency-Key reused ACROSS the two arms must 422
    // `idempotency-key-reuse`, never settle the second arm from the
    // first's key row.
    const payloadHash = hashCommandPayload({
      arm: 'retry',
      tenantId: command.tenantId,
      connectionId: command.connectionId,
    });

    type RetryPhase1 =
      | { kind: 'replayed'; snapshot: ChannelConnectionView }
      | { kind: 'mapped'; skuIds: string[] };
    const phase1 = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'channel.manage',
      );
      const replayed = await this.replayConnection(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return { kind: 'replayed', snapshot: replayed } satisfies RetryPhase1;
      }
      const existing = await this.lockConnection(tx, command.tenantId, command.connectionId);
      if (existing === null) {
        throw channelConnectionNotFound();
      }
      const mapped = await tx
        .select({ skuId: channelMappings.skuId })
        .from(channelMappings)
        .where(
          and(
            eq(channelMappings.tenantId, command.tenantId),
            eq(channelMappings.integrationId, command.connectionId),
          ),
        );
      return { kind: 'mapped', skuIds: [...new Set(mapped.map((row) => row.skuId))] } satisfies RetryPhase1;
    });
    if (phase1.kind === 'replayed') {
      return phase1.snapshot;
    }

    // The publish cycle's own computation (shared with the sync worker):
    // mapped skus × tenant warehouses, ONE read tx per scope (RN-6's
    // committed read; a store-down ATP here throws the 503 — a retry is
    // exactly the same compute path, and the breaker does NOT block a
    // manual retry; half-opening is its whole point).
    const prep = await this.publish.preparePublication(
      command.tenantId,
      command.connectionId,
      phase1.skuIds,
    );
    const scopes: PublishedScope[] = prep.kind === 'ready' ? prep.scopes : [];

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // A concurrent duplicate may have settled the key between the phases:
      // the idempotency insert below collides and 409s — the double replay
      // check catches the already-settled case first.
      const replayed = await this.replayConnection(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }

      const appended = await this.publish.appendPublication(tx, command.tenantId, {
        connectionId: command.connectionId,
        scopes,
        publishedAt: nowIso(),
        halfOpen: true,
      });
      if (appended.kind !== 'appended') {
        // The row left between the phases (a disconnect is the only writer).
        throw channelConnectionNotFound();
      }

      await this.settle(tx, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'channels.sync_retried',
        connection: toConnectionView(appended.row),
        idempotencyKey,
        payloadHash,
        outbox: {
          type: 'channels.sync_retried',
          payload: {
            connectionId: appended.row.id,
            scopeCount: scopes.length,
          },
        },
      });
      return toConnectionView(appended.row);
    });
  }

  /**
   * Arm 7 — `PUT .../connections/{id}/mappings` (story 7.2, T6): FULL
   * replacement of the connection's `externalRef → skuId` mapping set in
   * ONE transaction — `channel.manage` on both mapping routes (the epic's
   * channel-settings rule; the manage⇒orders.manage parity pin rides T8).
   *
   * The cap is the publish's scope arithmetic, not SKU count alone
   * (review finding 14): beyond `skuCount × activeWarehouseCount ≤
   * MAX_SYNC_SCOPES_PER_PUBLISH` the publish head-truncates its per-cycle
   * scope slice and the tail SKUs would never publish — the stale-for-
   * forever wedge the 400 names the arithmetic to prevent.
   */
  async setConnectionMappings(
    command: SetConnectionMappingsCommand,
    idempotencyKey: string,
  ): Promise<{ connectionId: string; items: readonly ChannelMappingItem[] }> {
    // ── shape at command entry (400 before any transaction) ──────────────
    if (command.items.length > MAX_BUFFER_ITEMS) {
      throw mappingSetTooLarge(command.items.length, MAX_BUFFER_ITEMS);
    }
    for (const item of command.items) {
      if (typeof item.externalRef !== 'string' || item.externalRef.trim() === '') {
        throw validationFailed('Every mapping item carries a non-empty externalRef.');
      }
      if (item.externalRef.length > 512) {
        throw validationFailed(`externalRef "${item.externalRef.slice(0, 24)}…" exceeds 512 characters.`);
      }
      if (!UUID_RE.test(item.skuId)) {
        throw validationFailed(`Every mapping item's skuId must be a uuid (got "${item.skuId.slice(0, 12)}…").`);
      }
    }
    const refDuplicates = [...new Set(
      command.items.filter((item, index) => command.items.findIndex((other) => other.externalRef === item.externalRef) !== index).map((item) => item.externalRef),
    )];
    if (refDuplicates.length > 0) {
      throw validationFailed(
        `externalRef must appear at most once per connection — duplicates: ${refDuplicates.slice(0, 5).join(', ')}.`,
      );
    }

    const payloadHash = hashCommandPayload({
      arm: 'mappings',
      tenantId: command.tenantId,
      connectionId: command.connectionId,
      items: command.items,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'channel.manage',
      );
      const replayed = await this.replayMappings(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) {
        return replayed;
      }
      const existing = await this.lockConnection(tx, command.tenantId, command.connectionId);
      if (existing === null) {
        throw channelConnectionNotFound();
      }

      // Every mapped sku must be this tenant's (404 naming it — the catalog
      // facade read, the buffers arm's shape).
      for (const skuId of [...new Set(command.items.map((item) => item.skuId))]) {
        const sku = await this.catalog.findSku(command.tenantId, skuId);
        if (sku === null) {
          throw bufferSkuNotFound(skuId);
        }
      }

      // The scope-ceiling arithmetic (row 5's 400): distinct SKUs × ACTIVE
      // tenant warehouses against the publish's per-cycle cap.
      const skuCount = new Set(command.items.map((item) => item.skuId)).size;
      const warehouseCount = await this.countActiveWarehouses(command.tenantId);
      const scopes = skuCount * warehouseCount;
      if (scopes > MAX_SYNC_SCOPES_PER_PUBLISH) {
        throw new ProblemException(
          'validation-failed',
          400,
          'Mapping set exceeds the publish scope ceiling',
          `${skuCount} mapped SKU(s) × ${warehouseCount} active warehouse(s) = ${scopes} publication scopes, above the ${MAX_SYNC_SCOPES_PER_PUBLISH}-scope cap one publish cycle carries — the tail would be silently truncated and those SKUs would never publish. Shrink the mapping set (or the warehouse set) below ${MAX_SYNC_SCOPES_PER_PUBLISH} scopes.`,
        );
      }

      // ── FULL replacement, in this one tx: rows removed from the list are
      // gone (the stale-scope wedge the upsert-only seed arm cannot fix).
      await tx
        .delete(channelMappings)
        .where(
          and(
            eq(channelMappings.tenantId, command.tenantId),
            eq(channelMappings.integrationId, command.connectionId),
          ),
        );
      if (command.items.length > 0) {
        await tx.insert(channelMappings).values(
          command.items.map((item) => ({
            id: uuidv7(),
            tenantId: command.tenantId,
            integrationId: command.connectionId,
            externalRef: item.externalRef.trim(),
            skuId: item.skuId,
          })),
        );
      }

      const result = { connectionId: command.connectionId, items: command.items };
      await this.settle(tx, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'channels.mappings_set',
        connection: toConnectionView(existing),
        idempotencyKey,
        payloadHash,
        outbox: {
          type: 'channels.mappings_set',
          payload: {
            connectionId: command.connectionId,
            itemCount: command.items.length,
            skuCount,
            warehouseCount,
          },
        },
        result,
      });
      return result;
    });
  }

  /**
   * The tenant's active warehouse count, paged (the publish enumeration's
   * same source — the scope arithmetic counts THESE).
   */
  private async countActiveWarehouses(tenantId: string): Promise<number> {
    let count = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.tenancy.listWarehouses(tenantId, cursor, MAX_WAREHOUSE_PAGE_SIZE);
      count += page.items.length;
      if (page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }
    return count;
  }

  /** The row, locked — the 404 check rides the caller (the guards-first order). */
  private async lockConnection(
    tx: TenantTx,
    tenantId: string,
    connectionId: string,
  ): Promise<Omit<Integration, 'credentialSealed'> | null> {
    const rows = await tx
      .select(CONNECTION_COLUMNS)
      .from(integrations)
      .where(and(eq(integrations.id, connectionId), eq(integrations.tenantId, tenantId)))
      .limit(1)
      .for('update');
    return (rows as Omit<Integration, 'credentialSealed'>[])[0] ?? null;
  }

  /**
   * The inline replay block (the `bin-state.command.ts` shape). Scoped to
   * `(tenant_id, key)` — never `key` alone: `idempotency_keys` is unique
   * per tenant AND key, so a lookup on the key alone would read ANOTHER
   * tenant's row (the 3.2 device-credential hijack case, and worse here —
   * the snapshot carries the connection's public face).
   */
  private async replayConnection(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<ChannelConnectionView | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return (row.responseSnapshot as { connection: ChannelConnectionView }).connection ?? null;
  }

  /** The buffers command's replay: the stored verdicts snapshot, or null. */
  private async replayBuffers(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<SetConnectionBuffersResult | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return ((row.responseSnapshot as { result?: SetConnectionBuffersResult }).result ?? null);
  }

  /** The mappings command's replay: the stored `{connectionId, items}` snapshot, or null. */
  private async replayMappings(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<{ connectionId: string; items: readonly ChannelMappingItem[] } | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return ((row.responseSnapshot as { result?: { connectionId: string; items: readonly ChannelMappingItem[] } }).result ?? null);
  }

  /** The disconnect command's replay: true when the key already settled a delete. */
  private async replayDisconnect(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<boolean> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return false;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return row.responseSnapshot !== null;
  }

  /**
   * The landmark tail, one place: outbox → audit → idempotency key. **None
   * of the three carries secret material** — the outbox payload is ids and
   * counters (it will be relayed and may be logged), the audit row is the
   * actor and the target, and the idempotency snapshot is the connection's
   * PUBLIC face (never the 3.2 precedent of a credential in
   * `response_snapshot`).
   */
  private async settle(
    tx: TenantTx,
    args: {
      tenantId: string;
      actorUserId: string;
      action:
        | 'channels.connected'
        | 'channels.credentials_rotated'
        | 'channels.backorder_policy_set'
        | 'channels.mappings_set'
        | 'channels.sync_retried';
      connection: ChannelConnectionView;
      idempotencyKey: string;
      payloadHash: string;
      outbox: { type: string; payload: Record<string, unknown> };
      /**
       * The command's own return value, snapshotted alongside the
       * connection view when the command returns more than it (the
       * mappings PUT's `{connectionId, items}`). Public-face only.
       */
      result?: unknown;
    },
  ): Promise<void> {
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId: args.tenantId,
      type: args.outbox.type,
      occurredAt: nowIso(),
      payload: args.outbox.payload,
    });

    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      action: args.action,
      targetType: 'channel_connection',
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
        responseSnapshot: {
          connection: args.connection,
          ...(args.result === undefined ? {} : { result: args.result }),
        },
      });
    } catch (err) {
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        throw concurrentIdempotency();
      }
      throw err;
    }
  }
}