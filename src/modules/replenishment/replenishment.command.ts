import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import type {
  BATCH_ALERT_KINDS,
  BATCH_ALERT_STATUSES,
  REPLENISHMENT_BREACH_STATUSES,
  SUGGESTED_PO_STATUSES} from '../../shared/db/schema';
import {
  auditEvents,
  batchAlerts,
  expiryAlertPolicies,
  idempotencyKeys,
  MAX_ALERT_CONFIG_DAYS,
  reorderBreaches,
  reorderPolicies,
  suggestedPos
} from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { MAX_QUANTITY_MILLI, QUANTITY_SCALE } from '../../shared/primitives/quantity';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { InboundFacade } from '../inbound/inbound.facade';
import type { PurchaseOrderSnapshot } from '../inbound/po.command';
import { CatalogFacade } from '../catalog/catalog.facade';

/**
 * The replenishment commands (story 6.1): the reorder-policy writes, the
 * breach dismissal, and the suggested-PO submit — every one on the frozen
 * command-skeleton order. The submit arm is the apply-arm pattern executed
 * in-tx: it orchestrates draft → PO → breach inside ONE held transaction and
 * mints the real PO through the inbound facade's in-tx variant
 * (`createPurchaseOrderInTx`) — never a second transaction inside a held one
 * (the documented pool-deadlock shape; see Design Notes in the spec).
 */

/**
 * The module-reserved audit actor: `audit_events.actor_user_id` is NOT NULL
 * and no system-actor user row exists, so the sweep's detection audit rows
 * ride this constant. It is NOT sign-in-able — no user row, no session —
 * merely a reserved uuid the audit trail can name (`01900000-…`, a UUIDv7
 * shape minted for the epoch the module was carved out in).
 */
export const REPLENISHMENT_SCHEDULER_ACTOR_ID = '01900000-0000-7000-8000-000000000000';

/** The policy upsert's milli ceiling — the one bound, derived from the scale (the MAX_VARIANCE_THRESHOLD_BASE derivation). */
export const MAX_REPLENISHMENT_MILLI = MAX_QUANTITY_MILLI;

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const POLICY_UNIQUE = 'reorder_policies_tenant_warehouse_sku_unique';
const EXPIRY_POLICY_UNIQUE = 'expiry_alert_policies_tenant_unique';

export interface UpsertReorderPolicyCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  /** Milli-units (AD-9 / 10.1) — integer, strictly positive. */
  readonly reorderPoint: number;
  readonly reorderQty: number;
}

export interface ReorderPolicySnapshot {
  readonly id: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly reorderPoint: number;
  readonly reorderQty: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeleteReorderPolicyCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly policyId: string;
}

export interface DismissBreachCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly breachId: string;
}

/** One breach row as every read returns it — the breach instant is `breachAt` (the shared `created_at`). */
export interface BreachEntry {
  readonly id: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly status: (typeof REPLENISHMENT_BREACH_STATUSES)[number];
  /** Frozen at detection — milli-units. */
  readonly pointMilli: number;
  readonly atpMilli: number;
  readonly breachAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

/** One suggested-PO draft (or settled draft) as every read returns it. */
export interface SuggestedPoEntry {
  readonly id: string;
  readonly breachId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly vendorId: string | null;
  readonly quantityMilli: number;
  readonly status: (typeof SUGGESTED_PO_STATUSES)[number];
  readonly submittedPoId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubmitSuggestedPoCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly draftId: string;
  /** The planner's edit — omitted keeps the draft's vendor. */
  readonly vendorId?: string | undefined;
  /** The planner's edit — omitted keeps the draft's quantity (milli-units). */
  readonly quantityMilli?: number | undefined;
}

/**
 * The submit response: the draft's id PLUS the FLAT PO snapshot —
 * `purchaseOrder` IS the PO (`{id, code, status, vendorId, …, lines}`), not
 * the inbound facade's wrapped `{purchaseOrder: {…}}` carrier (the wrapped
 * shape made the surface read `undefined` where the minted code goes).
 */
export interface SubmitSuggestedPoResult {
  readonly suggestedPoId: string;
  readonly purchaseOrder: PurchaseOrderSnapshot['purchaseOrder'];
}

export interface UpsertExpiryPolicyCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  /** Lead days before `batches.expiry_date` an expiry alert opens — ≥ 0. */
  readonly expiryLeadDays: number;
  /** Batch age since intake that raises an `aged` alert — ≥ 0. */
  readonly agingThresholdDays: number;
}

/** One tenant's expiry/aging config as every read returns it. */
export interface ExpiryPolicySnapshot {
  readonly expiryLeadDays: number;
  readonly agingThresholdDays: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DismissBatchAlertCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly alertId: string;
}

/**
 * One batch-alert row as every read returns it — the alert instant is
 * `detectedAt` (the shared `created_at`, the breach-row's `breachAt`
 * divergence applied to 6.2's vocabulary). The queue's LIVE on-hand is
 * stitched in by the facade read (`onHandMilli`), never a stored number.
 */
export interface BatchAlertEntry {
  readonly id: string;
  readonly warehouseId: string;
  readonly skuId: string;
  readonly batchId: string;
  readonly kind: (typeof BATCH_ALERT_KINDS)[number];
  readonly status: (typeof BATCH_ALERT_STATUSES)[number];
  /** FROZEN at detection — `aged` rows only (null on `expiry_upcoming`). */
  readonly ageDays: number | null;
  readonly detectedAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

/**
 * The one milli-quantity conversion at the replenishment write edge: an
 * integer of milli-units, strictly positive, inside the exact range. The
 * refusal names the field (the I/O matrix's arm) and fires behind the
 * replay lookup for the idempotent commands — the caller's order keeps it
 * there.
 */
export function assertPositiveMilli(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${field} must be a positive milli-unit integer`,
      `${field} is a quantity in milli-units (1 = 0.001 base) — a whole number > 0 was expected (got ${String(value)}).`,
    );
  }
  if (value > MAX_REPLENISHMENT_MILLI) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${field} is outside the exact quantity range`,
      `${field} must be at most ${MAX_REPLENISHMENT_MILLI} milli-units (got ${value}).`,
    );
  }
  return value;
}

/**
 * The config days' one validation at the command edge: a whole-day integer,
 * ≥ 0 (0 admits a live threshold — the spec's stated grammar), inside the
 * int4 storage bound the column carries. The refusal names the field (the
 * I/O matrix's arm), and fires at the edge, behind the replay lookup.
 */
export function assertNonNegativeDays(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${field} must be a non-negative whole-day integer`,
      `${field} is a day count — a whole number ≥ 0 was expected (got ${String(value)}).`,
    );
  }
  if (value > MAX_ALERT_CONFIG_DAYS) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${field} is outside the storable range`,
      `${field} must be at most ${MAX_ALERT_CONFIG_DAYS} days (got ${value}).`,
    );
  }
  return value;
}

/** The deterministic inner idempotency key the PO mint rides (`replenishment-submit-po-<draftId>`). */
export function poMintKey(draftId: string): string {
  return `replenishment-submit-po-${draftId}`;
}

/**
 * The submit arm's PO code: derived from the DRAFT's uuid (the last 8 hex
 * characters, uppercase) — a deterministic shape recorded as a deliberate
 * deviation from the fixture-style `PO-` + fresh-ULID slice, because the
 * inner mint's idempotent replay needs the payload deterministic. Collision
 * space per tenant is 2^32; the inner 409 `conflict` names the code if ever
 * hit.
 */
export function poCodeForDraft(draftId: string): string {
  return `PO-${draftId.replace(/-/g, '').slice(-8).toUpperCase()}`;
}

/**
 * The draft quantity when the policy/SKU default carries none: the recovery
 * gap — the shortfall below the point in milli-units — with the docstring
 * that matters: it fills the gap, rounded UP to whole base units, so the
 * minted PO's line passes the PO command's precision guard for every UoM
 * vocabulary (a fractional `.each` mint would be refused there).
 */
export function recoveryGapMilli(pointMilli: number, atpMilli: number): number {
  return Math.ceil((pointMilli - atpMilli) / QUANTITY_SCALE) * QUANTITY_SCALE;
}

/**
 * The payload hash of the PO mint the submit arm re-executes — computed from
 * the mint command exactly as the standalone create's entry does (the
 * fingerprint is over BASE units: the PoLineInput order). One place, so the
 * inner idempotency key and the hash cannot disagree.
 */
export function poMintPayloadHash(mint: {
  tenantId: string;
  warehouseId: string;
  vendorId: string;
  code: string;
  skuId: string;
  orderedQty: number;
}): string {
  return hashCommandPayload({
    tenantId: mint.tenantId,
    warehouseId: mint.warehouseId,
    vendorId: mint.vendorId,
    code: mint.code,
    lines: [
      {
        id: undefined,
        skuId: mint.skuId,
        orderedQty: mint.orderedQty,
        unitCostPaise: 0,
        expectedDate: undefined,
      },
    ],
  });
}

/**
 * The breach row of a mutation, locked against concurrent transitions
 * (worker recovery, a second dismissal — the loadOpenPo shape).
 */
export async function loadBreachInTenant(
  tx: TenantTx,
  tenantId: string,
  breachId: string,
): Promise<ReorderBreachRow> {
  const rows = await tx
    .select()
    .from(reorderBreaches)
    .where(and(eq(reorderBreaches.tenantId, tenantId), eq(reorderBreaches.id, breachId)))
    .limit(1)
    .for('update');
  const row = rows[0];
  if (row === undefined) {
    throw new ProblemException(
      'not-found',
      404,
      'Breach not found',
      `No breach with id "${breachId}" exists in this tenant.`,
    );
  }
  return row;
}

type ReorderBreachRow = typeof reorderBreaches.$inferSelect;
type ReorderPolicyRow = typeof reorderPolicies.$inferSelect;
type SuggestedPoRow = typeof suggestedPos.$inferSelect;
type BatchAlertRow = typeof batchAlerts.$inferSelect;
type ExpiryAlertPolicyRow = typeof expiryAlertPolicies.$inferSelect;

export function policySnapshot(row: ReorderPolicyRow): ReorderPolicySnapshot {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    skuId: row.skuId,
    reorderPoint: row.reorderPointMilli,
    reorderQty: row.reorderQtyMilli,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

export function breachEntry(row: ReorderBreachRow): BreachEntry {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    skuId: row.skuId,
    // The column is text; the 0048 CHECK narrows it to the tuple — the cast
    // leans on that database guarantee (and on the command paths' inserts).
    status: row.status as (typeof REPLENISHMENT_BREACH_STATUSES)[number],
    pointMilli: row.pointMilli,
    atpMilli: row.atpMilli,
    // The breach instant lives in the shared `created_at` (the Design Notes'
    // naming divergence, recorded); the surface reads `breachAt`.
    breachAt: canonicalInstant(row.createdAt),
    resolvedAt: row.resolvedAt === null ? null : canonicalInstant(row.resolvedAt),
    resolvedBy: row.resolvedBy,
  };
}

export function suggestedPoEntry(row: SuggestedPoRow): SuggestedPoEntry {
  return {
    id: row.id,
    breachId: row.breachId,
    warehouseId: row.warehouseId,
    skuId: row.skuId,
    vendorId: row.vendorId,
    quantityMilli: row.quantityMilli,
    // The column is text; the 0048 CHECK narrows it to the tuple (as above).
    status: row.status as (typeof SUGGESTED_PO_STATUSES)[number],
    submittedPoId: row.submittedPoId,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

/** The batch-alert row of a mutation, locked against concurrent transitions (the loadBreachInTenant shape). */
export async function loadBatchAlertInTenant(
  tx: TenantTx,
  tenantId: string,
  alertId: string,
): Promise<BatchAlertRow> {
  const rows = await tx
    .select()
    .from(batchAlerts)
    .where(and(eq(batchAlerts.tenantId, tenantId), eq(batchAlerts.id, alertId)))
    .limit(1)
    .for('update');
  const row = rows[0];
  if (row === undefined) {
    throw new ProblemException(
      'not-found',
      404,
      'Batch alert not found',
      `No batch alert with id "${alertId}" exists in this tenant.`,
    );
  }
  return row;
}

export function expiryPolicySnapshot(row: ExpiryAlertPolicyRow): ExpiryPolicySnapshot {
  return {
    expiryLeadDays: row.expiryLeadDays,
    agingThresholdDays: row.agingThresholdDays,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

export function batchAlertEntry(row: BatchAlertRow): BatchAlertEntry {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    skuId: row.skuId,
    batchId: row.batchId,
    // The columns are text; the 0049 CHECKs narrow them to the tuples — the
    // casts lean on that database guarantee (and on the scan's inserts).
    kind: row.kind as (typeof BATCH_ALERT_KINDS)[number],
    status: row.status as (typeof BATCH_ALERT_STATUSES)[number],
    ageDays: row.ageDays,
    // The alert instant lives in the shared `created_at` (the breach naming
    // divergence, applied to 6.2's vocabulary).
    detectedAt: canonicalInstant(row.createdAt),
    resolvedAt: row.resolvedAt === null ? null : canonicalInstant(row.resolvedAt),
    resolvedBy: row.resolvedBy,
  };
}

/** The stored response snapshot for (tenant, key) — null when the key is fresh. */
async function replay(
  tx: TenantTx,
  tenantId: string,
  idempotencyKey: string,
  payloadHash: string,
): Promise<unknown | null> {
  const existing = await tx
    .select()
    .from(idempotencyKeys)
    .where(
      and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)),
    )
    .limit(1);
  const row = existing[0];
  if (row === undefined) {
    return null;
  }
  if (row.payloadHash !== payloadHash) {
    throw idempotencyKeyReuse();
  }
  return row.responseSnapshot;
}

/** The idempotency key's write, LAST — every other invariant has settled (the variance-policy shape). */
async function writeIdempotencyKey(
  tx: TenantTx,
  tenantId: string,
  idempotencyKey: string,
  payloadHash: string,
  snapshot: unknown,
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

@Injectable()
export class ReplenishmentCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // The submit arm's PO mint rides the inbound facade's in-tx variant —
    // the inbound module remains the ONLY writer of purchase_orders (AD-6),
    // and its `po.manage` gate stays live on this path.
    @Inject(InboundFacade) private readonly inbound: InboundFacade,
    // The SKU existence + defaults read the policy upsert asserts through
    // (the catalog facade's in-tx read; catalog tables stay module-exclusive).
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  /**
   * PUT …/replenishment/policies — the per-warehouse override row, idempotent
   * under the Idempotency-Key (a replay re-serves the stored snapshot; a key
   * reuse with a different policy is the 422). Upsert is last-write-wins
   * (the variance-policy precedent): the existing row locked `.for('update')`,
   * insert-with-unique-violation-409 / update. Audit:
   * `replenishment.policy_upserted`.
   */
  async upsertReorderPolicy(
    command: UpsertReorderPolicyCommand,
    idempotencyKey: string,
  ): Promise<ReorderPolicySnapshot> {
    // The milli conversion at the edge, behind the replay lookup below: a
    // non-milli or non-positive point/qty is the 400 naming the field.
    assertPositiveMilli(command.reorderPoint, 'reorderPoint');
    assertPositiveMilli(command.reorderQty, 'reorderQty');
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      skuId: command.skuId,
      reorderPoint: command.reorderPoint,
      reorderQty: command.reorderQty,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority at command-service entry — DB role read, same tx, BEFORE
      // the replay lookup (the deliberate fail-closed carve-out).
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'replenishment.manage',
      );

      const stored = await replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (stored !== null) {
        return stored as ReorderPolicySnapshot;
      }

      // Master-data integrity before any write (no FK repo convention):
      // warehouse in tenant (404), and the SKU must exist — its defaults map
      // is the catalog read this module breathes through (existence comes
      // free with it).
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      await this.assertSkuInTenant(tx, command.tenantId, command.skuId);

      // The race-loser 409 shape: the unique (tenant, warehouse, sku) index
      // is the backstop, the locked existing row the usual path.
      const existing = await tx
        .select()
        .from(reorderPolicies)
        .where(
          and(
            eq(reorderPolicies.tenantId, command.tenantId),
            eq(reorderPolicies.warehouseId, command.warehouseId),
            eq(reorderPolicies.skuId, command.skuId),
          ),
        )
        .limit(1)
        .for('update');
      let written: ReorderPolicyRow | undefined;
      if (existing[0] === undefined) {
        try {
          const rows = await tx
            .insert(reorderPolicies)
            .values({
              id: uuidv7(),
              tenantId: command.tenantId,
              warehouseId: command.warehouseId,
              skuId: command.skuId,
              reorderPointMilli: command.reorderPoint,
              reorderQtyMilli: command.reorderQty,
            })
            .returning();
          written = rows[0];
        } catch (err) {
          if (isUniqueViolationOn(err, POLICY_UNIQUE)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent policy write',
              'The reorder policy is being written concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
      } else {
        written = (
          await tx
            .update(reorderPolicies)
            .set({
              reorderPointMilli: command.reorderPoint,
              reorderQtyMilli: command.reorderQty,
              updatedAt: nowIso(),
            })
            .where(eq(reorderPolicies.id, existing[0].id))
            .returning()
        )[0];
      }
      const policy = written!;

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'replenishment.policy_upserted',
        targetType: 'reorder_policy',
        targetId: policy.id,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });

      const snapshot = policySnapshot(policy);
      await writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * DELETE …/replenishment/policies/:policyId — the override row's removal
   * (tenant-wide SKU defaults take over again), idempotent under the
   * Idempotency-Key; absent-or-foreign id → 404. Audit:
   * `replenishment.policy_deleted`.
   */
  async deleteReorderPolicy(
    command: DeleteReorderPolicyCommand,
    idempotencyKey: string,
  ): Promise<ReorderPolicySnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      policyId: command.policyId,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'replenishment.manage',
      );

      const stored = await replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (stored !== null) {
        return stored as ReorderPolicySnapshot;
      }

      const existing = await tx
        .select()
        .from(reorderPolicies)
        .where(
          and(
            eq(reorderPolicies.tenantId, command.tenantId),
            eq(reorderPolicies.id, command.policyId),
          ),
        )
        .limit(1)
        .for('update');
      const policy = existing[0];
      if (policy === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Reorder policy not found',
          `No reorder policy with id "${command.policyId}" exists in this tenant.`,
        );
      }

      const snapshot = policySnapshot(policy);
      await tx.delete(reorderPolicies).where(eq(reorderPolicies.id, policy.id));

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'replenishment.policy_deleted',
        targetType: 'reorder_policy',
        targetId: policy.id,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });

      await writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * POST …/replenishment/breaches/:breachId/dismiss — the human's dismissal
   * arm. The breach must be `open` (`breach-not-open` 409 otherwise — every
   * terminal state is terminal). Its draft stays a draft (dismissal is about
   * the breach, not the draft). Audit: `replenishment.breach_dismissed`.
   */
  async dismissBreach(
    command: DismissBreachCommand,
    idempotencyKey: string,
  ): Promise<BreachEntry> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      breachId: command.breachId,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'replenishment.manage',
      );

      const stored = await replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (stored !== null) {
        return stored as BreachEntry;
      }

      const breach = await loadBreachInTenant(tx, command.tenantId, command.breachId);
      if (breach.status !== 'open') {
        throw new ProblemException(
          'breach-not-open',
          409,
          'Breach is not open',
          `Breach "${breach.id}" is ${breach.status} — only an open breach can be dismissed.`,
        );
      }
      const resolvedAt = nowIso();
      await tx
        .update(reorderBreaches)
        .set({ status: 'dismissed', resolvedAt, resolvedBy: command.actorUserId, updatedAt: resolvedAt })
        .where(eq(reorderBreaches.id, breach.id));

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'replenishment.breach_dismissed',
        targetType: 'reorder_breach',
        targetId: breach.id,
        reference: idempotencyKey,
        occurredAt: resolvedAt,
      });

      const entry: BreachEntry = {
        ...breachEntry(breach),
        status: 'dismissed',
        resolvedAt,
        resolvedBy: command.actorUserId,
      };
      await writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, entry);
      return entry;
    });
  }

  /**
   * POST …/replenishment/suggested-pos/:draftId/submit — the ONLY writer of
   * a real PO in this story, and a human-triggered one (FR-22's never
   * auto-submit). The arm re-executes PO creation through the inbound
   * facade's in-tx variant INSIDE this command's own held transaction — one
   * pooled connection total (never a nested transaction while one is held:
   * the documented pool-deadlock shape) — under the inbound module's own
   * `po.manage` gate, so the PO lifecycle's guards answer the mint verbatim:
   * a vendor or SKU that vanished 404s, a colliding code 409s, and the draft
   * STAYS a draft (the caller's transaction rolls back whole).
   *
   * Edits are optional: the draft's own vendor/quantity are the defaults.
   * A draft with no vendor (and no edit naming one) refuses 400
   * `suggested-po-vendor-required` — the human picks the vendor on the
   * surface. The response carries the FLAT PO snapshot (the amendment:
   * `purchaseOrder` IS the PO, not the wrapped carrier).
   */
  async submitSuggestedPo(
    command: SubmitSuggestedPoCommand,
    idempotencyKey: string,
  ): Promise<SubmitSuggestedPoResult> {
    // The planner's quantity edit converts at the edge (behind the replay
    // lookup): non-milli or non-positive is the 400 naming `quantityMilli`.
    if (command.quantityMilli !== undefined) {
      assertPositiveMilli(command.quantityMilli, 'quantityMilli');
    }
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      draftId: command.draftId,
      vendorId: command.vendorId ?? null,
      quantityMilli: command.quantityMilli ?? null,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'replenishment.manage',
      );

      const stored = await replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (stored !== null) {
        return stored as SubmitSuggestedPoResult;
      }

      const drafts = await tx
        .select()
        .from(suggestedPos)
        .where(and(eq(suggestedPos.tenantId, command.tenantId), eq(suggestedPos.id, command.draftId)))
        .limit(1)
        .for('update');
      const draft = drafts[0];
      if (draft === undefined) {
        throw new ProblemException(
          'not-found',
          404,
          'Suggested PO draft not found',
          `No suggested PO with id "${command.draftId}" exists in this tenant.`,
        );
      }
      if (draft.status !== 'draft') {
        throw new ProblemException(
          'suggested-po-submitted',
          409,
          'Suggested PO is not a draft',
          `Suggested PO "${draft.id}" is ${draft.status} — only a draft can be submitted.`,
        );
      }
      const vendorId = command.vendorId ?? draft.vendorId;
      if (vendorId === null) {
        throw new ProblemException(
          'suggested-po-vendor-required',
          400,
          'Vendor required',
          'This draft names no vendor (the tenant carried none at detection) — choose one to submit.',
        );
      }
      const quantityMilli = command.quantityMilli ?? draft.quantityMilli;
      assertPositiveMilli(quantityMilli, 'quantityMilli');

      // The mint, inside THIS transaction: the PO code derives from the
      // draft's uuid (the recorded deviation — the inner mint's idempotent
      // replay needs the payload deterministic), the unit cost stays 0
      // (v1 has no price source), and the ordered quantity crosses the
      // inbound edge in BASE units from the draft's milli (a fractional
      // whole-unit quantity fails the PO command's precision guard there,
      // verbatim — the draft stays a draft).
      const mintCode = poCodeForDraft(draft.id);
      const orderedQty = quantityMilli / QUANTITY_SCALE;
      const mint = await this.inbound.createPurchaseOrderInTx(
        tx,
        {
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          warehouseId: draft.warehouseId,
          vendorId,
          code: mintCode,
          lines: [{ skuId: draft.skuId, orderedQty, unitCostPaise: 0 }],
        },
        // The deterministic inner key stays (the Design Notes): harmless
        // under single-transaction atomicity, and it keeps the mint
        // reproducible.
        poMintKey(draft.id),
        poMintPayloadHash({
          tenantId: command.tenantId,
          warehouseId: draft.warehouseId,
          vendorId,
          code: mintCode,
          skuId: draft.skuId,
          orderedQty,
        }),
      );

      await tx
        .update(suggestedPos)
        .set({ status: 'submitted', submittedPoId: mint.purchaseOrder.id, updatedAt: nowIso() })
        .where(eq(suggestedPos.id, draft.id));

      // The breach reads `actioned` — but only FROM open: a breach the
      // worker already recovered stays recovered (terminal is terminal),
      // and the draft's submission is still real.
      const breach = await loadBreachInTenant(tx, command.tenantId, draft.breachId);
      if (breach.status === 'open') {
        const resolvedAt = nowIso();
        await tx
          .update(reorderBreaches)
          .set({ status: 'actioned', resolvedAt, resolvedBy: command.actorUserId, updatedAt: resolvedAt })
          .where(eq(reorderBreaches.id, breach.id));
      }

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'replenishment.suggested_po_submitted',
        occurredAt: nowIso(),
        payload: {
          suggestedPoId: draft.id,
          poId: mint.purchaseOrder.id,
          poCode: mint.purchaseOrder.code,
          warehouseId: draft.warehouseId,
          vendorId,
          quantityMilli,
        },
      });

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'replenishment.suggested_po_submitted',
        targetType: 'suggested_po',
        targetId: draft.id,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });

      const result: SubmitSuggestedPoResult = {
        suggestedPoId: draft.id,
        // The FLAT PO snapshot (the amendment — never the wrapped carrier).
        purchaseOrder: mint.purchaseOrder,
      };
      await writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, result);
      return result;
    });
  }

  /**
   * PUT …/replenishment/expiry-policies — the tenant's expiry/aging config,
   * last-write-wins (the variance-policy precedent): the existing row locked
   * `.for('update')`, insert-with-unique-violation-409 / update. There is no
   * DELETE — "GET reads 404 when absent" is the absent-row family's shape,
   * and a tenant that wants the arms effectively off writes wide values (both
   * ≥ 0 are admitted; 0 stays a threshold, not an off switch). Audit:
   * `replenishment.expiry_policy_upserted`.
   */
  async upsertExpiryPolicy(
    command: UpsertExpiryPolicyCommand,
    idempotencyKey: string,
  ): Promise<ExpiryPolicySnapshot> {
    // The day counts validate at the edge, behind the replay lookup below:
    // a negative day count is the 400 naming the field.
    assertNonNegativeDays(command.expiryLeadDays, 'expiryLeadDays');
    assertNonNegativeDays(command.agingThresholdDays, 'agingThresholdDays');
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      expiryLeadDays: command.expiryLeadDays,
      agingThresholdDays: command.agingThresholdDays,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'replenishment.manage',
      );

      const stored = await replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (stored !== null) {
        return stored as ExpiryPolicySnapshot;
      }

      // The race-loser 409 shape (the reorder-policy upsert's): the unique
      // (tenant_id) index is the backstop, the locked existing row the path.
      const existing = await tx
        .select()
        .from(expiryAlertPolicies)
        .where(eq(expiryAlertPolicies.tenantId, command.tenantId))
        .limit(1)
        .for('update');
      let written: ExpiryAlertPolicyRow | undefined;
      if (existing[0] === undefined) {
        try {
          const rows = await tx
            .insert(expiryAlertPolicies)
            .values({
              id: uuidv7(),
              tenantId: command.tenantId,
              expiryLeadDays: command.expiryLeadDays,
              agingThresholdDays: command.agingThresholdDays,
            })
            .returning();
          written = rows[0];
        } catch (err) {
          if (isUniqueViolationOn(err, EXPIRY_POLICY_UNIQUE)) {
            throw new ProblemException(
              'conflict',
              409,
              'Concurrent expiry-policy write',
              'The expiry/aging policy is being written concurrently; retry to read the settled result.',
            );
          }
          throw err;
        }
      } else {
        written = (
          await tx
            .update(expiryAlertPolicies)
            .set({
              expiryLeadDays: command.expiryLeadDays,
              agingThresholdDays: command.agingThresholdDays,
              updatedAt: nowIso(),
            })
            .where(eq(expiryAlertPolicies.id, existing[0].id))
            .returning()
        )[0];
      }
      const policy = written!;

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'replenishment.expiry_policy_upserted',
        targetType: 'expiry_alert_policy',
        targetId: policy.id,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });

      const snapshot = expiryPolicySnapshot(policy);
      await writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * POST …/replenishment/batch-alerts/:alertId/dismiss — the human's dismissal
   * arm on a batch alert. The alert must be `open` (`batch-alert-not-open` 409
   * otherwise — every terminal state is terminal). NO stock-side effect: the
   * alert is evidence, and dismissal discards evidence, never stock. Audit:
   * `replenishment.batch_alert_dismissed`.
   */
  async dismissBatchAlert(
    command: DismissBatchAlertCommand,
    idempotencyKey: string,
  ): Promise<BatchAlertEntry> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      alertId: command.alertId,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'replenishment.manage',
      );

      const stored = await replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (stored !== null) {
        return stored as BatchAlertEntry;
      }

      const alert = await loadBatchAlertInTenant(tx, command.tenantId, command.alertId);
      if (alert.status !== 'open') {
        throw new ProblemException(
          'batch-alert-not-open',
          409,
          'Batch alert is not open',
          `Batch alert "${alert.id}" is ${alert.status} — only an open batch alert can be dismissed.`,
        );
      }
      const resolvedAt = nowIso();
      await tx
        .update(batchAlerts)
        .set({ status: 'dismissed', resolvedAt, resolvedBy: command.actorUserId, updatedAt: resolvedAt })
        .where(eq(batchAlerts.id, alert.id));

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'replenishment.batch_alert_dismissed',
        targetType: 'batch_alert',
        targetId: alert.id,
        reference: idempotencyKey,
        occurredAt: resolvedAt,
      });

      const entry: BatchAlertEntry = {
        ...batchAlertEntry(alert),
        status: 'dismissed',
        resolvedAt,
        resolvedBy: command.actorUserId,
      };
      await writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, entry);
      return entry;
    });
  }

  /**
   * The SKU's existence as a throw (404 naming the id) — asserted through
   * the catalog facade's in-tx defaults read, so the policy commands never
   * touch a catalog table directly (AD-6) and the existence check costs the
   * one query the module already breathes through.
   */
  private async assertSkuInTenant(tx: TenantTx, tenantId: string, skuId: string): Promise<void> {
    const defaults = await this.catalog.getSkuReorderDefaultsInTx(tx, tenantId);
    if (!defaults.some((sku) => sku.id === skuId)) {
      throw new ProblemException(
        'not-found',
        404,
        'SKU not found',
        `No SKU with id "${skuId}" exists in this tenant.`,
      );
    }
  }
}

export type { PurchaseOrderSnapshot };