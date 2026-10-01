import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { channelMappings, integrationCalls, integrations } from '../../shared/db/schema';
import type { Integration } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InventoryFacade } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import { TenancyService } from '../tenancy/tenancy.service';
import { MAX_WAREHOUSE_PAGE_SIZE } from '../tenancy/tenancy.service';
import { BREAKER_FAILURE_THRESHOLD, CONNECTION_COLUMNS } from './channels.view';
import {
  CHANNEL_AVAILABILITY_PUBLISHED_EVENT,
  type ChannelAvailabilityPublication,
  type PublishedScope,
} from './channels.events';

/**
 * The availability-sync publication machinery (story 7-1), as its own
 * injectable: the sync worker, the delivery handler and the retry command
 * all ride THESE arms, while `ChannelsFacade` stays the module's only
 * published seam (the modules-singleton rule) by delegating.
 *
 * Why a separate service and not methods on the facade: the command service
 * consumes `preparePublication`/`appendPublication` for its manual retry,
   and the facade holds the command passthroughs — command → facade would
 * be a provider cycle (the facade delegates connect/rotate/… to the command).
 * The publish service stands BESIDE both, injected by each (the command →
 * publish edge and the facade → publish edge never cycle back).
 *
 * The publish fan-out (the spec's "mapped scopes", decided here because
 * the frozen mapping vocabulary carries the SKU only): one outbox
 * publication per (connection, cycle) carrying one scope per (tenant
 * WAREHOUSE × mapped SKU) — the core's `channelVisibleQuantity` is a
 * per-(warehouse, sku) committed read (RN-6), and a channel sells from
 * warehouse pools, so the warehouse dimension is the core's own, applied
 * to the mapped sku set. The per-cycle bound (`MAX_SYNC_SCOPES_PER_PUBLISH`)
 * caps a cycle's scope count; the next cycle continues (the snapshot is
 * full each publish, so a continued cycle is just the next snapshot).
 */

/** How many scopes ONE publication computes and carries (the worker's per-cycle bound). */
export const MAX_SYNC_SCOPES_PER_PUBLISH = 200;

/** What `preparePublication` reports to the worker and the retry command. */
export type PublicationPrep =
  | { kind: 'absent' }
  | { kind: 'blocked-open' }
  | { kind: 'no-mappings' }
  | { kind: 'ready'; provider: string; scopes: PublishedScope[] };

/** The delivery outcome one relay attempt produces (the delivery handler's input). */
export type SyncDeliveryOutcome =
  | { readonly ok: true; readonly latencyMs: number | null }
  | { readonly ok: false; readonly error: string; readonly latencyMs: number | null };

@Injectable()
export class ChannelsPublishService {
  private readonly logger = new Logger('ChannelsPublish');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
  ) {}

  /**
   * The publish scope computation shared by the worker and the retry
   * command: mapped sku set × tenant warehouses, one committed read per
   * scope through the core (RN-6 — the buffer math lives in the inventory
   * module; the count is bounded so a cycle stays bounded).
   *
   * A store-down ATP read THROWS the 503 `reservation-store-unavailable`
   * — the worker catches it (the degraded-on-503 arm: stamp + publish
   * nothing, never invent zero); the retry command lets it surface.
   */
  async computePublishedScopes(
    tenantId: string,
    skuIds: readonly string[],
    connectionId: string,
  ): Promise<PublishedScope[]> {
    const warehouseIds: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.tenancy.listWarehouses(tenantId, cursor, MAX_WAREHOUSE_PAGE_SIZE);
      warehouseIds.push(...page.items.map((warehouse) => warehouse.id));
      if (page.nextCursor === null || warehouseIds.length >= MAX_SYNC_SCOPES_PER_PUBLISH) {
        break;
      }
      cursor = page.nextCursor;
    }
    const scopes: PublishedScope[] = [];
    for (const skuId of skuIds) {
      for (const warehouseId of warehouseIds) {
        if (scopes.length >= MAX_SYNC_SCOPES_PER_PUBLISH) {
          return scopes;
        }
        const pool = await this.inventory.channelVisibleQuantity(
          tenantId,
          warehouseId,
          skuId,
          connectionId,
        );
        scopes.push({
          warehouseId: pool.warehouseId,
          skuId: pool.skuId,
          visibleMilli: pool.visibleMilli,
        });
      }
    }
    return scopes;
  }

  /**
   * The retry command's scope precomputation: the mapped sku set is passed
   * in (the command read it in its own transaction), the row is validated
   * for existence + provider (NO breaker check — a manual retry is the arm
   * that half-opens a broken breaker), and the snapshot is computed. The
   * command appends through `appendPublication` inside its own transaction.
   */
  async preparePublication(
    tenantId: string,
    connectionId: string,
    skuIds: readonly string[],
  ): Promise<
    | { kind: 'absent' }
    | { kind: 'ready'; provider: string; scopes: PublishedScope[] }
  > {
    const rows = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select({ id: integrations.id, provider: integrations.provider })
        .from(integrations)
        .where(and(eq(integrations.id, connectionId), eq(integrations.tenantId, tenantId)))
        .limit(1),
    );
    const row = rows[0];
    if (row === undefined) {
      return { kind: 'absent' };
    }
    const scopes = await this.computePublishedScopes(tenantId, skuIds, connectionId);
    return { kind: 'ready', provider: row.provider, scopes };
  }

  /**
   * The worker's per-connection publish cycle (T3): read the connection +
   * its mappings, compute the snapshot, and append — one outbox message
   * per (connection, cycle) when anything mapped exists and the row is
   * live and its breaker is not open. `true` = appended; `false` = skipped
   * (breaker open / nothing mapped / not connected); `'absent'` = the row
   * left mid-cycle (a disconnect raced it).
   */
  async publishConnectionSnapshot(tenantId: string, connectionId: string): Promise<boolean | 'absent'> {
    const prep = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select(CONNECTION_COLUMNS)
        .from(integrations)
        .where(and(eq(integrations.id, connectionId), eq(integrations.tenantId, tenantId)))
        .limit(1)
        .for('update');
      const row = (rows as Omit<Integration, 'credentialSealed'>[])[0] ?? null;
      if (row === null) {
        return { kind: 'absent' } as const;
      }
      if (row.status !== 'connected') {
        return { kind: 'no-mappings' } as const;
      }
      if (row.breakerState === 'open') {
        return { kind: 'blocked-open' } as const;
      }
      const mapped = await tx
        .select({ skuId: channelMappings.skuId })
        .from(channelMappings)
        .where(
          and(
            eq(channelMappings.tenantId, tenantId),
            eq(channelMappings.integrationId, connectionId),
          ),
        );
      const skuIds = [...new Set(mapped.map((row) => row.skuId))];
      return { kind: 'ready' as const, provider: row.provider, skuIds };
    });
    if (prep.kind === 'absent') {
      return 'absent';
    }
    if (prep.kind !== 'ready') {
      return false;
    }
    const scopes = await this.computePublishedScopes(tenantId, prep.skuIds, connectionId);
    if (scopes.length === 0) {
      // A connection with no (mapped × warehouse) scopes — no mappings is
      // the only way — publishes nothing (RN-6's rule).
      return false;
    }
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.appendPublication(tx, tenantId, {
        connectionId,
        scopes,
        publishedAt: nowIso(),
        halfOpen: false,
      }).then((appended) => appended.kind === 'appended'),
    );
  }

  /**
   * The in-tx publication appender — the retry command's second transaction
   * AND the worker's publish tx body both ride it: re-lock the row the
   * append commits for (the 404 / absent check rides the return), refuse
   * when the breaker has opened, half-open when `halfOpen` says so, and
   * append the outbox row in the SAME transaction (the append commits
   * together with the breaker write — the two cannot disagree).
   */
  async appendPublication(
    tx: TenantTx,
    tenantId: string,
    args: {
      connectionId: string;
      scopes: readonly PublishedScope[];
      publishedAt: string;
      halfOpen: boolean;
    },
  ): Promise<
    | { kind: 'appended'; row: Omit<Integration, 'credentialSealed'> }
    | { kind: 'skipped' }
  > {
    const rows = await tx
      .select(CONNECTION_COLUMNS)
      .from(integrations)
      .where(
        and(eq(integrations.id, args.connectionId), eq(integrations.tenantId, tenantId)),
      )
      .limit(1)
      .for('update');
    const row = (rows as Omit<Integration, 'credentialSealed'>[])[0];
    if (row === undefined) {
      return { kind: 'skipped' };
    }
    if (row.status !== 'connected' || (args.halfOpen === false && row.breakerState === 'open')) {
      return { kind: 'skipped' };
    }
    const updatedAt = nowIso();
    // The retry's half-open only un-sticks an OPEN breaker (RN-5's arm 6 is
    // the manual unstick path): a retry on a closed (or already half-open)
    // breaker leaves the state — otherwise a retry would WEAKEN a healthy
    // breaker (a fresh failure out of half-open opens it immediately, and a
    // closed breaker tolerates up to the threshold).
    const wantHalfOpen = args.halfOpen && row.breakerState === 'open';
    const updated = await tx
      .update(integrations)
      .set(
        wantHalfOpen
          ? { breakerState: 'half-open', consecutiveFailures: 0, updatedAt }
          : { updatedAt },
      )
      .where(eq(integrations.id, args.connectionId))
      .returning(CONNECTION_COLUMNS);
    const appendedRow = (updated as Omit<
      Integration,
      'credentialSealed'
    >[])[0]!;
    const publication: ChannelAvailabilityPublication = {
      connectionId: row.id,
      provider: row.provider,
      scopes: args.scopes,
      publishedAt: args.publishedAt,
    };
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type: CHANNEL_AVAILABILITY_PUBLISHED_EVENT,
      occurredAt: nowIso(),
      payload: { ...publication },
    });
    return { kind: 'appended', row: appendedRow };
  }

  /**
   * The failed-COMPUTE stamp (the spec's degraded-on-503 arm): the cycle
   * could not read ATP (503 `reservation-store-unavailable`), so it
   * publishes NOTHING (never invents zero — PENDING a8), stamps the
   * stall reason + attempt instant, and leaves. This is NOT a breaker
   * stroke (the breaker guards RUNAWAY DELIVERY loops, RN-5 — a
   * store-down is the reservation core's fail-closed mode, not a channel
   * failure) and not a metered row (no integration call ever left).
   */
  async recordSyncStall(tenantId: string, connectionId: string, reason: string): Promise<void> {
    await withTenantTransaction(this.db, tenantId, async (tx) => {
      await tx
        .update(integrations)
        .set({ lastAttemptAt: nowIso(), lastError: reason.slice(0, 300), updatedAt: nowIso() })
        .where(
          and(eq(integrations.id, connectionId), eq(integrations.tenantId, tenantId)),
        );
    });
  }

  /**
   * One delivery attempt's settle (RN-5): the meter row (append-only
   * `integration_calls`) and the connection's health stamps + breaker
   * transition, in one transaction. The breaker opens on the Nth
   * consecutive delivery failure (or an immediate failure out of
   * half-open); a success closes it and resets the streak, stamping
   * `last_synced_at`. The handler RETHROWS its failure AFTER settling —
   * the relay's re-drain re-delivers and re-meters (honest metering).
   */
  async recordDelivery(
    tenantId: string,
    connectionId: string,
    outcome: SyncDeliveryOutcome,
  ): Promise<void> {
    await withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(integrations)
        .where(
          and(eq(integrations.id, connectionId), eq(integrations.tenantId, tenantId)),
        )
        .limit(1)
        .for('update');
      const row = rows[0];
      if (row === undefined) {
        // The connection was deleted mid-retry: the delivery of a snapshot
        // for a dead connection NEEDS settling nowhere — the relay acks it
        // (the handler returns normally and never rethrows).
        return;
      }
      const now = nowIso();
      if (outcome.ok) {
        await tx
          .update(integrations)
          .set({
            lastAttemptAt: now,
            lastSyncedAt: now,
            lastError: null,
            consecutiveFailures: 0,
            breakerState: 'closed',
            updatedAt: now,
          })
          .where(eq(integrations.id, connectionId));
      } else {
        const failures = row.consecutiveFailures + 1;
        const open = row.breakerState === 'half-open' || failures >= BREAKER_FAILURE_THRESHOLD;
        await tx
          .update(integrations)
          .set({
            lastAttemptAt: now,
            lastError: outcome.error.slice(0, 300),
            consecutiveFailures: failures,
            breakerState: open ? 'open' : 'closed',
            updatedAt: now,
          })
          .where(eq(integrations.id, connectionId));
      }
      await tx.insert(integrationCalls).values({
        id: uuidv7(),
        tenantId,
        integrationId: connectionId,
        kind: 'availability-sync',
        status: outcome.ok ? 'ok' : 'failed',
        latencyMs: outcome.latencyMs,
        error: outcome.ok ? null : outcome.error.slice(0, 300),
        at: now,
      });
    });
  }

  /**
   * The delivery handler's connection read (internal — carries the sealed
   * blob so the handler can open the credential IN PROCESS, the AD-15
   * request-scoped rule). Null when the connection is gone (the handler
   * acks and drops).
   */
  async integrationForDelivery(
    tenantId: string,
    connectionId: string,
  ): Promise<{ provider: string; credentialSealed: string } | null> {
    const rows = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select({ provider: integrations.provider, credentialSealed: integrations.credentialSealed })
        .from(integrations)
        .where(
          and(eq(integrations.id, connectionId), eq(integrations.tenantId, tenantId)),
        )
        .limit(1),
    );
    const row = rows[0];
    if (row === undefined || row.credentialSealed === null) {
      return null;
    }
    return { provider: row.provider, credentialSealed: row.credentialSealed };
  }

  /**
   * The mapping write arm (the 7-1 deliverable's seed path; the facade's
   * seed arm delegates here). The story's I/O matrix exposes no mapping
   * ROUTE — 7-2's ingestion configures and resolves through it — so this
   * arm is the seed path, an upsert on (tenant, integration, externalRef):
   * re-mapping a ref repoints the row instead of 409ing.
   */
  async setChannelMappings(
    tenantId: string,
    connectionId: string,
    items: readonly { externalRef: string; skuId: string }[],
  ): Promise<number> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ id: integrations.id })
        .from(integrations)
        .where(
          and(eq(integrations.id, connectionId), eq(integrations.tenantId, tenantId)),
        )
        .limit(1);
      if (rows[0] === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Channel connection not found',
          'No channel connection with this id exists in this tenant.',
        );
      }
      // Every mapped sku must be this tenant's (the catalog facade read).
      for (const item of items) {
        const sku = await this.catalog.findSku(tenantId, item.skuId);
        if (sku === null) {
          throw new ProblemException(
            'not-found',
            404,
            'SKU not found',
            `No sku ${item.skuId} exists in this tenant.`,
          );
        }
      }
      let written = 0;
      for (const item of items) {
        const inserted = await tx
          .insert(channelMappings)
          .values({
            id: uuidv7(),
            tenantId,
            integrationId: connectionId,
            externalRef: item.externalRef,
            skuId: item.skuId,
          })
          .onConflictDoUpdate({
            target: [
              channelMappings.tenantId,
              channelMappings.integrationId,
              channelMappings.externalRef,
            ],
            set: { skuId: item.skuId, updatedAt: nowIso() },
          })
          .returning({ id: channelMappings.id });
        written += inserted.length;
      }
      return written;
    });
  }

  /** The mapping rows for one connection (the surface's editor + the worker's scope read). */
  async listChannelMappings(tenantId: string, connectionId: string): Promise<
    { externalRef: string; skuId: string }[]
  > {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select({ externalRef: channelMappings.externalRef, skuId: channelMappings.skuId })
        .from(channelMappings)
        .where(
          and(
            eq(channelMappings.tenantId, tenantId),
            eq(channelMappings.integrationId, connectionId),
          ),
        )
        .orderBy(channelMappings.externalRef),
    );
  }
}