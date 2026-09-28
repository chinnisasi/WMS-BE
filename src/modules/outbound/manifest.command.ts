import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, manifests, shipments } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * The discriminator that keeps this command's idempotency fingerprint out of
 * every sibling command's space (the `DISPATCH_COMMAND_KIND` rule).
 */
const MANIFEST_COMMAND_KIND = 'outbound.manifest';

/**
 * The ceiling on shipments in ONE manifest. A hand-over document is a
 * physical act (the courier takes one bundle); the bounded set bounds the
 * problem-detail enumeration with it (the `MAX_SCAN_LINES` precedent).
 */
export const MAX_MANIFEST_SHIPMENTS = 500;

// ── command inputs ───────────────────────────────────────────────────────────

export interface CreateManifestCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  /** The labelled shipments this manifest closes (≥ 1, bounded, this warehouse). */
  readonly shipmentIds: readonly string[];
}

// ── snapshots ────────────────────────────────────────────────────────────────

/**
 * The manifest record — and the idempotency snapshot, so a replay re-serves
 * it byte for byte. The row is deliberately thin (connection + count); the
 * per-shipment truth lives on the shipment rows, so the snapshot carries the
 * id set beside them.
 */
export interface ManifestSnapshot {
  readonly manifest: {
    readonly id: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    /** The ONE connection every closed shipment labelled through. */
    readonly carrierConnectionId: string;
    readonly carrierCode: string;
    readonly shipmentCount: number;
    readonly shipmentIds: readonly string[];
    readonly createdBy: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
}

/**
 * The manifest command (Story 4.6c): `labels.execute`, a tenant-session
 * idempotent command. It closes a set of `labelled` shipments — all on ONE
 * carrier connection, all in one warehouse — onto the carrier, flips them to
 * `manifested`, and is TERMINAL (no un-manifest).
 *
 * ── why the whole set validates before anything writes ───────────────────────
 *
 * The matrix's "409 naming the offender" is an all-or-nothing contract: a
 * manifest naming one foreign shipment, one manifested shipment or two
 * connections writes NOTHING. Every shipment row is locked
 * (`for('update')`, in id order so concurrent manifests acquire their locks
 * in one order and cannot deadlock), the offender enumeration runs against
 * the locked rows, and only a fully valid set reaches the writes. The
 * subsequent flip is conditional on `status = 'labelled'` anyway — the
 * backstop that rolls the transaction back if a row moved under us.
 *
 * The connection (and its carrier code) is read FROM the shipments, never
 * from the request: the manifest records the connection the labels actually
 * went through — a body that also named a connection id could only disagree.
 */
@Injectable()
export class ManifestCommandService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  /**
   * `POST .../warehouses/{warehouseId}/outbound/manifests` — one manifest per
   * (validated) shipment set. A replay under the same key re-serves the
   * stored record; the same key with a different payload is the deterministic
   * 422.
   */
  async createManifest(
    command: CreateManifestCommand,
    idempotencyKey: string,
  ): Promise<ManifestSnapshot> {
    // The SET is the intent, not its order (the aggregateScan rule): the
    // operator closes the parcels they have, and two postings of the same
    // set — in any order — are one manifest. Duplicates collapse and the
    // sorted set hashes, so `{A,B}` and `{B,A}` replay rather than collide.
    const shipmentIds = this.normalizeShipmentIds(command.shipmentIds);
    const payloadHash = hashCommandPayload({
      command: MANIFEST_COMMAND_KIND,
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      shipmentIds,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // ── authority: the role is re-read from the DB per command (AD-10) ──
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'labels.execute',
      );

      // ── idempotency replay (before any read of state, before any write) ─
      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return replay;
      }

      // ── the warehouse (404 app-layer, RLS stays single-dimension) ───────
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);

      // ── the shipments, locked in id order (the deadlock-free lock order) ─
      const rows = await tx
        .select()
        .from(shipments)
        .where(and(eq(shipments.tenantId, command.tenantId), inArray(shipments.id, shipmentIds)))
        .orderBy(asc(shipments.id))
        .for('update');
      const byId = new Map(rows.map((row) => [row.id, row]));

      // ── the offender enumeration — all-or-nothing, naming the offender ──
      // Missing (foreign tenant included — RLS makes a foreign id read as
      // absent), wrong warehouse, wrong state: each gets its own refusal that
      // NAMES the offending ids (capped — a multi-kilobyte detail is the
      // payload-amplification rule).
      const missing = shipmentIds.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        throw manifestConflict(
          'Shipments not found',
          `${missing.length} of the named shipment(s) do not exist in this tenant: ${namedSample(missing)}. Nothing was written.`,
        );
      }
      const foreignWarehouse = [...byId.values()]
        .filter((row) => row.warehouseId !== command.warehouseId)
        .map((row) => row.id);
      if (foreignWarehouse.length > 0) {
        throw manifestConflict(
          'Shipments in another warehouse',
          `${foreignWarehouse.length} of the named shipment(s) belong to another warehouse: ${namedSample(foreignWarehouse)}. Nothing was written.`,
        );
      }
      const wrongState = [...byId.values()]
        .filter((row) => row.status !== 'labelled')
        .map((row) => `${row.id} (${row.status})`);
      if (wrongState.length > 0) {
        throw manifestConflict(
          'Shipments not labellable onto a manifest',
          `${wrongState.length} of the named shipment(s) are not in the labelled state: ${namedSample(wrongState)}. Only a labelled shipment closes onto a manifest.`,
        );
      }
      // ONE connection — the hand-over document's whole point. The carrier
      // code rides the connection (a connection never changes carrier), so
      // one connection id implies one code.
      const connectionIds = [...new Set([...byId.values()].map((row) => row.carrierConnectionId))];
      if (connectionIds.length > 1) {
        throw manifestConflict(
          'Shipments span carrier connections',
          `The named shipments labelled through ${connectionIds.length} different carrier connections (${namedSample(connectionIds)}) — one manifest closes one connection's shipments. Nothing was written.`,
        );
      }

      // ── the write: the manifest row, then the conditional flip ──────────
      const first = byId.get(shipmentIds[0]!)!;
      const createdAt = nowIso();
      const manifestId = uuidv7();
      await tx.insert(manifests).values({
        id: manifestId,
        tenantId: command.tenantId,
        warehouseId: command.warehouseId,
        carrierConnectionId: first.carrierConnectionId,
        carrierCode: first.carrierCode,
        shipmentCount: shipmentIds.length,
        createdBy: command.actorUserId,
      });
      const flipped = await tx
        .update(shipments)
        .set({ status: 'manifested', manifestId, updatedAt: createdAt })
        .where(
          and(
            eq(shipments.tenantId, command.tenantId),
            inArray(shipments.id, shipmentIds),
            eq(shipments.status, 'labelled'),
          ),
        )
        .returning({ id: shipments.id });
      if (flipped.length !== shipmentIds.length) {
        // Unreachable beneath the row locks above; kept as the backstop that
        // rolls the whole transaction back rather than manifesting a set this
        // command did not actually close.
        throw manifestConflict(
          'Shipments moved during manifesting',
          `${shipmentIds.length - flipped.length} of the named shipment(s) moved out of the labelled state concurrently — nothing was written.`,
        );
      }

      const snapshot: ManifestSnapshot = {
        manifest: {
          id: manifestId,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          carrierConnectionId: first.carrierConnectionId,
          carrierCode: first.carrierCode,
          shipmentCount: shipmentIds.length,
          shipmentIds,
          createdBy: command.actorUserId,
          createdAt: canonicalInstant(createdAt),
          updatedAt: canonicalInstant(createdAt),
        },
      };

      // ── in-transaction outbox append (AD-7) — the writeback Epic 7's
      // channel consumer subscribes to ─────────────────────────────────────
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'manifest.created',
        occurredAt: createdAt,
        payload: { manifest: snapshot.manifest },
      });

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'manifest.created',
        targetType: 'manifest',
        targetId: manifestId,
        reference: idempotencyKey,
        occurredAt: createdAt,
      });

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── input validation (400 before any write) ───────────────────────────────

  /**
   * The set: every id a uuid, 1..MAX_MANIFEST_SHIPMENTS entries, duplicates
   * collapsed, sorted — the shape the lock, the guards and the hash all read.
   */
  private normalizeShipmentIds(input: readonly string[]): string[] {
    if (!Array.isArray(input) || input.length === 0) {
      throw manifestValidation('shipmentIds must be a non-empty array of shipment ids.');
    }
    for (const id of input) {
      if (!UUID_RE.test(id)) {
        throw manifestValidation(`shipmentIds must all be uuids (got "${String(id)}").`);
      }
    }
    const unique = [...new Set(input)];
    if (unique.length > MAX_MANIFEST_SHIPMENTS) {
      throw manifestValidation(
        `A manifest closes at most ${MAX_MANIFEST_SHIPMENTS} shipments (got ${unique.length}).`,
      );
    }
    return unique.sort();
  }

  // ── shared pieces (the 4.1 idempotency shape) ─────────────────────────────

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<ManifestSnapshot | null> {
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
    return row.responseSnapshot as ManifestSnapshot;
  }

  private async writeIdempotencyKey(
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
        throw concurrentIdempotency();
      }
      throw err;
    }
  }
}

/**
 * The detail cap (the `namedSample` rule in pack.command.ts): a refusal may
 * enumerate the offenders, but a multi-kilobyte `detail` is unreadable to the
 * operator AND a payload amplification an unauthenticated-adjacent caller
 * controls. The COUNT is what tells them the size; the sample tells them
 * where to start.
 */
const MAX_ENUMERATED_IN_DETAIL = 20;

function namedSample(items: readonly string[]): string {
  if (items.length <= MAX_ENUMERATED_IN_DETAIL) {
    return items.join('; ');
  }
  const shown = items.slice(0, MAX_ENUMERATED_IN_DETAIL).join('; ');
  return `${shown}; … and ${items.length - MAX_ENUMERATED_IN_DETAIL} more`;
}

function concurrentIdempotency(): ProblemException {
  return new ProblemException(
    'conflict',
    409,
    'Concurrent idempotent request',
    'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
  );
}

function manifestValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Manifest validation failed', detail);
}

function manifestConflict(title: string, detail: string): ProblemException {
  return new ProblemException('conflict', 409, title, detail);
}