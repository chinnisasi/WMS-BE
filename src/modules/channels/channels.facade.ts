import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { channelMappings, integrations } from '../../shared/db/schema';
import type { Integration } from '../../shared/db/schema';
import { canonicalInstant } from '../../shared/primitives/time';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { channelConnectionNotFound } from './channels.errors';
import { ChannelsCommandService } from './channels.command';
import { ChannelsIngestCommand } from './channels.ingest.command';
import type { ParsedChannelCancellation, ParsedChannelOrder } from './channel-registry';
import type {
  ConnectChannelCommand,
  RotateChannelCredentialCommand,
  UpdateConnectionConfigCommand,
  DisconnectChannelCommand,
  RetryConnectionCommand,
  SetConnectionBuffersCommand,
  SetConnectionMappingsCommand,
  ChannelMappingItem,
} from './channels.command';
import { ChannelsPublishService } from './channels.publish';
import { InventoryFacade } from '../inventory/inventory.facade';
import { CONNECTION_COLUMNS, toConnectionView, connectionHealth } from './channels.view';
import type {
  ChannelConnectionListEntry,
  ChannelConnectionView,
  SetConnectionBuffersResult,
} from './channels.view';
import type { SyncDeliveryOutcome } from './channels.publish';
import type { PublishedScope } from './channels.events';

// The facade is the module's ONLY published seam (the module-exemplar rule):
// the shapes its consumers need ride along here, re-exported, so nothing
// imports the module's internals.
export type {
  ConnectChannelCommand,
  RotateChannelCredentialCommand,
  UpdateConnectionConfigCommand,
  DisconnectChannelCommand,
  RetryConnectionCommand,
  SetConnectionBuffersCommand,
  SetConnectionMappingsCommand,
  ChannelMappingItem,
  ChannelBufferPlanItem,
} from './channels.command';
export type { PublicationPrep, SyncDeliveryOutcome } from './channels.publish';
export { MAX_SYNC_SCOPES_PER_PUBLISH } from './channels.publish';
export type {
  ChannelConnectionView,
  ChannelConnectionListEntry,
  ChannelBufferVerdict,
  SetConnectionBuffersResult,
} from './channels.view';
export {
  BREAKER_FAILURE_THRESHOLD,
  SYNC_HEALTH_SLO_MS,
} from './channels.view';
export type {
  ChannelAvailabilityPublication,
  PublishedScope,
} from './channels.events';
export { CHANNEL_AVAILABILITY_PUBLISHED_EVENT } from './channels.events';
// Story 9-1 — the ONE health rule, re-exported so the reporting dashboard's
// sync tile classifies a connection exactly as `/channels` does (a pure
// function; reporting reaches it through the facade specifier only).
export { connectionHealth } from './channels.view';

/**
 * The channels module's read side + the one seam every consumer rides
 * (story 7.1). Everything is a delegate: the command arms to
 * `ChannelsCommandService`, the sync/publication arms to
 * `ChannelsPublishService`, the reads (the arm-4 health list) live HERE
 * because they compose the module's own tables with the inventory core's
 * buffer buckets — no command, no publish machinery.
 *
 * The api shell's controller injects THIS class only (the carriers'
 * facade-passthrough convention — the sealed credential never reaches a
 * response DTO); the jobs shell's sync worker injects this class too (its
 * publish arms are passthroughs by construction, so the module-internal
 * service never has to be exported).
 *
 * The standing-buffer reads/releases ride the inventory facade (the AD-10
 * passthrough — a buffer IS a reservation row); a buffer read in this
 * module's list is `standingBuffersForTenantInTx`, folded per connection.
 */
@Injectable()
export class ChannelsFacade {
  private readonly logger = new Logger('ChannelsFacade');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ChannelsCommandService) private readonly commands: ChannelsCommandService,
    @Inject(ChannelsPublishService) private readonly publish: ChannelsPublishService,
    @Inject(ChannelsIngestCommand) private readonly ingest: ChannelsIngestCommand,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  // ── command passthroughs (the skeleton's owner is the command service) ─────

  /** Arm 1 — `POST .../channels/connections`. */
  connect(command: ConnectChannelCommand, idempotencyKey: string): Promise<ChannelConnectionView> {
    return this.commands.connect(command, idempotencyKey);
  }

  /** Arm 2 — `PUT .../connections/{id}/credentials` (in-place rotation). */
  rotateCredentials(
    command: RotateChannelCredentialCommand,
    idempotencyKey: string,
  ): Promise<ChannelConnectionView> {
    return this.commands.rotateCredentials(command, idempotencyKey);
  }

  /** Arm 2b — `PUT .../connections/{id}` (the backorder policy). */
  updateConnectionConfig(
    command: UpdateConnectionConfigCommand,
    idempotencyKey: string,
  ): Promise<ChannelConnectionView> {
    return this.commands.updateConnectionConfig(command, idempotencyKey);
  }

  /** Arm 5 — `PUT .../connections/{id}/buffers` (per-item verdicts). */
  setConnectionBuffers(
    command: SetConnectionBuffersCommand,
    idempotencyKey: string,
  ): Promise<SetConnectionBuffersResult> {
    return this.commands.setConnectionBuffers(command, idempotencyKey);
  }

  /** Arm 7 — `PUT .../connections/{id}/mappings` (story 7.2, T6). */
  setConnectionMappings(
    command: SetConnectionMappingsCommand,
    idempotencyKey: string,
  ): Promise<{ connectionId: string; items: readonly ChannelMappingItem[] }> {
    return this.commands.setConnectionMappings(command, idempotencyKey);
  }

  /** Arm 3 — `DELETE .../connections/{id}` (the hard delete). */
  disconnect(command: DisconnectChannelCommand, idempotencyKey: string): Promise<void> {
    return this.commands.disconnect(command, idempotencyKey);
  }

  /** Arm 6 — `POST .../connections/{id}/retry` (re-append + half-open). */
  retryConnection(
    command: RetryConnectionCommand,
    idempotencyKey: string,
  ): Promise<ChannelConnectionView> {
    return this.commands.retryConnection(command, idempotencyKey);
  }

  /**
   * The mappings GET's guard (7.2 row 4): `channel.manage` in one tx plus
   * the connection-existence check — the command arms carry their own; the
   * GET has no command, so the guard IS the read arm's authority (AD-4).
   */
  async assertConnectionManage(
    tenantId: string,
    actorUserId: string,
    connectionId: string,
  ): Promise<void> {
    await withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, actorUserId), 'channel.manage');
      const rows = await tx
        .select({ id: integrations.id })
        .from(integrations)
        .where(and(eq(integrations.id, connectionId), eq(integrations.tenantId, tenantId)))
        .limit(1);
      if (rows[0] === undefined) {
        throw channelConnectionNotFound();
      }
    });
  }

  // ── ingest passthroughs (7.2 rows 1-2 — the webhooks controller's arms) ────

  /**
   * One verified + parsed `orders` delivery through the connection's config
   * (the ingest command's own doc). The webhook caller never sees a
   * credential; the outcome is the row-1 vocabulary.
   */
  ingestOrderDelivery(args: {
    tenantId: string;
    connectionId: string;
    parsed: ParsedChannelOrder;
  }): Promise<{ outcome: 'accepted' | 'backordered' | 'replayed'; orderId: string }> {
    return this.ingest.ingestOrderDelivery(args);
  }

  /** One verified + parsed `cancellations` delivery (RD-8). */
  ingestCancellationDelivery(args: {
    tenantId: string;
    connectionId: string;
    parsed: ParsedChannelCancellation;
  }): Promise<{ outcome: 'released' | 'ignored' }> {
    return this.ingest.ingestCancellationDelivery(args);
  }

  /**
   * The verification-failure class's coarse meter (RD-5/bl-5): named
   * `verification-failed`, content-free, rate-limited to one row per
   * connection per 60s window — the controller's only meter before the
   * ingest command runs.
   */
  recordIngestVerificationRefused(tenantId: string, connectionId: string): Promise<void> {
    return this.publish.recordIngestVerificationRefused(tenantId, connectionId);
  }

  /** The parse-arm refusal's meter (a VERIFIED body with no mappable shape). */
  recordIngestParseRefused(tenantId: string, connectionId: string): Promise<void> {
    return this.publish.recordIngestOutcome(tenantId, connectionId, {
      status: 'validation-failed',
      latencyMs: 0,
      error: 'the payload carries no mappable shape for the endpoint',
    });
  }

  // ── read arms (this file's own) ────────────────────────────────────────────

  /**
   * Arm 4 — `GET .../channels/connections`: the sync-health rows (every
   * registered connection with its health derivation, buffer buckets and
   * mapping count — never a secret).
   */
  async listConnections(tenantId: string): Promise<ChannelConnectionListEntry[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = (await tx
        .select(CONNECTION_COLUMNS)
        .from(integrations)
        .where(eq(integrations.tenantId, tenantId))
        .orderBy(integrations.createdAt, integrations.id)) as Omit<Integration, 'credentialSealed'>[];
      const buffers = await this.inventory.standingBuffersForTenantInTx(tx, tenantId);
      const buffersByOwner = new Map<string, { warehouseId: string; skuId: string; bufferMilli: number }[]>();
      for (const buffer of buffers) {
        const bucket = buffersByOwner.get(buffer.ownerId) ?? [];
        bucket.push({
          warehouseId: buffer.warehouseId,
          skuId: buffer.skuId,
          bufferMilli: buffer.quantity,
        });
        buffersByOwner.set(buffer.ownerId, bucket);
      }
      const counts = (await tx
        .select({ integrationId: channelMappings.integrationId, count: sql<number>`count(*)::int` })
        .from(channelMappings)
        .groupBy(channelMappings.integrationId)) as unknown as { integrationId: string; count: number }[];
      const countById = new Map(counts.map((c) => [c.integrationId, c.count]));
      return rows.map((row) => {
        const view = toConnectionView(row);
        const { health, syncLagMs } = connectionHealth(view);
        return {
          id: view.id,
          provider: view.provider,
          providerName: view.providerName,
          status: view.status,
          backorderPolicy: view.backorderPolicy,
          ingestWarehouseId: view.ingestWarehouseId,
          credentialVersion: view.credentialVersion,
          health,
          lastSyncedAt: view.lastSyncedAt,
          lastAttemptAt: view.lastAttemptAt,
          lastError: view.lastError,
          syncLagMs,
          breakerState: view.breakerState,
          createdAt: canonicalInstant(view.createdAt),
          updatedAt: canonicalInstant(view.updatedAt),
          buffers: buffersByOwner.get(row.id) ?? [],
          mappingCount: countById.get(row.id) ?? 0,
        };
      });
    });
  }

  // ── publish passthroughs (the machinery lives in ChannelsPublishService) ───

  /**
   * The worker's per-connection publish cycle (T3) — the jobs shell drives
   * this through the facade (the module's one exported seam).
   */
  publishConnectionSnapshot(tenantId: string, connectionId: string): Promise<boolean | 'absent'> {
    return this.publish.publishConnectionSnapshot(tenantId, connectionId);
  }

  /** The failed-compute stamp (the degraded-on-503 arm). */
  recordSyncStall(tenantId: string, connectionId: string, reason: string): Promise<void> {
    return this.publish.recordSyncStall(tenantId, connectionId, reason);
  }

  /** One delivery attempt's settle (RN-5 metering + breaker). */
  recordDelivery(
    tenantId: string,
    connectionId: string,
    outcome: SyncDeliveryOutcome,
  ): Promise<void> {
    return this.publish.recordDelivery(tenantId, connectionId, outcome);
  }

  /** The delivery read (sealed blob, in-process only). */
  integrationForDelivery(
    tenantId: string,
    connectionId: string,
  ): Promise<{ provider: string; credentialSealed: string } | null> {
    return this.publish.integrationForDelivery(tenantId, connectionId);
  }

  /**
   * The WEBHOOK surface's delivery face (story 7-2): provider + LAZY access
   * to the signing secret — opened only when the caller's 501 gate has
   * passed (review patch P5), the sealed blob never crosses into `src/api`
   * (the carriers 4.6b pin). `openSecret() === null` = absent or
   * unopenable — the caller's fail-closed 401 arm.
   */
  webhookDeliveryFace(
    tenantId: string,
    connectionId: string,
  ): Promise<{ provider: string; openSecret: () => string | null } | null> {
    return this.publish.webhookDeliveryFace(tenantId, connectionId);
  }

  // ── mapping seed arms (no route; 7-2's config path + the e2e seeder) ───────

  setChannelMappings(
    tenantId: string,
    connectionId: string,
    items: readonly { externalRef: string; skuId: string }[],
  ): Promise<number> {
    return this.publish.setChannelMappings(tenantId, connectionId, items);
  }

  listChannelMappings(
    tenantId: string,
    connectionId: string,
  ): Promise<{ externalRef: string; skuId: string }[]> {
    return this.publish.listChannelMappings(tenantId, connectionId);
  }

  // (kept for the arm-4 composition test + the surfaces story's reads)
  computePublishedScopes(
    tenantId: string,
    skuRefs: readonly { skuId: string; externalRef: string }[],
    connectionId: string,
  ): Promise<PublishedScope[]> {
    return this.publish.computePublishedScopes(tenantId, skuRefs, connectionId);
  }
}