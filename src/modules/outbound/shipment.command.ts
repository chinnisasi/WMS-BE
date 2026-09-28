import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, orders, shipments } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { CarriersFacade, labelThroughAdapter } from '../carriers/carriers.facade';
import type { CarrierLabelRequest } from '../carriers/carriers.facade';
import { MAX_DIMENSION_MM, MAX_WEIGHT_GRAMS } from './pack.command';
import type { PackDimensionsInput } from './pack.command';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * The discriminator that keeps this command's idempotency fingerprint out of
 * every sibling command's space (the `DISPATCH_COMMAND_KIND` rule —
 * `JSON.stringify` drops `undefined` keys, so two different commands on the
 * same order would otherwise hash identically and a replay could serve the
 * OTHER command's snapshot).
 */
const LABEL_COMMAND_KIND = 'outbound.label';

/**
 * The shipment lifecycle (Story 4.6c), additive per the repo convention —
 * `labelled` = the adapter's label exists (dispatch may auto-stamp from it,
 * the manifest command may pick it up); `manifested` = closed onto a
 * manifest, the terminal arm (no un-manifest). Pinned to the DB CHECK
 * `shipments_status_check` by the label.spec drift guard.
 */
export const SHIPMENT_STATUSES = ['labelled', 'manifested'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

// ── command inputs ───────────────────────────────────────────────────────────

export interface CreateShipmentLabelCommand {
  readonly tenantId: string;
  /** The session user — authority is re-read from the DB at command entry. */
  readonly actorUserId: string;
  readonly orderId: string;
  /** The carrier connection the label generates through (must be this tenant's). */
  readonly carrierConnectionId: string;
  /** Optional parcel weight in grams — absence is never an error. */
  readonly weightGrams?: number | null | undefined;
  /** Optional parcel dimensions in millimetres — absence is never an error. */
  readonly dimensionsMm?: PackDimensionsInput | null | undefined;
}

// ── snapshots ────────────────────────────────────────────────────────────────

/**
 * The label record — and the idempotency snapshot, so a replay re-serves it
 * byte for byte. The `PackSnapshot` shape, deliberately: a surface that
 * renders a pack slip renders a label.
 */
export interface ShipmentSnapshot {
  readonly shipment: {
    readonly id: string;
    readonly orderId: string;
    readonly tenantId: string;
    readonly warehouseId: string;
    /** `labelled` — the arm this command is the only writer of. */
    readonly status: ShipmentStatus;
    readonly carrierConnectionId: string;
    readonly carrierCode: string;
    /** The registry display name resolved at label time (point-in-time, the 11-1 precedent). */
    readonly carrierName: string;
    /** The adapter-issued tracking number — what dispatch auto-stamps. */
    readonly trackingNumber: string;
    /** The adapter's opaque handle for the label document — never the bytes. */
    readonly labelDocumentRef: string;
    readonly weightGrams: number | null;
    readonly dimensionsMm: PackDimensionsInput | null;
    readonly labelledBy: string;
    readonly labelledAt: string;
    readonly manifestId: string | null;
  };
}

/**
 * The label command (Story 4.6c): `labels.execute`, a tenant-session
 * idempotent command. It takes a `ready_to_dispatch` order, generates a
 * label through one of the tenant's carrier connections, and writes THE
 * shipment — the one record of the adapter-issued tracking number and label
 * document. The order status does NOT move (dispatch owns every order-state
 * transition); the label is a station act beside the state machine.
 *
 * ── why the adapter call runs INSIDE the transaction, after every guard ──────
 *
 * The matrix's ordering is the contract: a wrong-state order answers 409 (not
 * 501), a foreign connection answers 404 (not 501), a missing key answers
 * 503 — and only a fully-guarded order reaches the port. The adapter call is
 * the one non-deterministic step, and it runs before any write: on adapter
 * failure (the DIRECT carriers' typed 501) nothing is written and the order
 * stays `ready_to_dispatch` — the UX-DR19 "retryable error inline; dispatch
 * state unchanged" contract. Retry is a fresh submit with a fresh key.
 *
 * ── why the facade runs on THIS transaction ─────────────────────────────────
 *
 * The connection resolve and the credential open are facade work, but the
 * facade's standalone methods open their own `withTenantTransaction` — and
 * calling one inside a held transaction queues a second pool connection
 * behind the first (postgres.js queues, nothing times out): the documented
 * pool-nesting deadlock. So this command calls the facade's IN-TX
 * passthroughs (`resolveConnectionInTx` / `openCredentialForAdapterUseInTx`,
 * the `getPickTasksInTx` precedent) on the same `tx` it already holds.
 *
 * The credential is REQUEST-SCOPED plaintext under the facade's
 * non-negotiable adapter-use rules: handed straight to the adapter arm and
 * never
 * persisted, logged, or written into the snapshot, the outbox payload, the
 * audit row or the idempotency snapshot — the row stores the adapter's ANSWER
 * (tracking number, document ref) and the connection id.
 *
 * One LABELLED shipment per order — a partial unique index
 * (`shipments_tenant_order_labelled_unique`) is the race backstop behind the
 * existence guard, and there is no label regeneration once labelled (409).
 * A manifested shipment refuses the same way — the order's label arc is
 * closed.
 */
@Injectable()
export class ShipmentCommandService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Cross-module composition through the facade only (AD-6): the
    // connection resolve and the credential open ride the carriers facade's
    // IN-TX passthroughs inside THIS command's transaction — the outbound
    // module touches no carriers table and sees no sealed blob.
    @Inject(CarriersFacade) private readonly carriers: CarriersFacade,
  ) {}

  /**
   * `POST .../orders/{orderId}/label` — one labelled shipment per order. A
   * replay under the same key re-serves the stored record; the same key with
   * a different payload is the deterministic 422; a SECOND label under a NEW
   * key is a 409 (there is no label regeneration once labelled).
   */
  async createShipmentLabel(
    command: CreateShipmentLabelCommand,
    idempotencyKey: string,
  ): Promise<ShipmentSnapshot> {
    // The measurements ARE intent (a re-weigh is a different claim about the
    // parcel) and hash as given (the pack command's rule); absent normalizes
    // to `undefined`, which `JSON.stringify` drops, so a measurement-less
    // label hashes byte-identically whether the arms were omitted or null.
    const payloadHash = hashCommandPayload({
      command: LABEL_COMMAND_KIND,
      tenantId: command.tenantId,
      orderId: command.orderId,
      carrierConnectionId: command.carrierConnectionId,
      weightGrams: command.weightGrams ?? undefined,
      dimensionsMm: command.dimensionsMm ?? undefined,
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

      // ── input shape (400 before anything is read; the pack command's
      // validation-after-replay position, so a same-key retry re-serves the
      // stored record even though the retried body re-names the fields) ────
      const weightGrams = this.assertWeight(command.weightGrams);
      const dimensionsMm = this.assertDimensions(command.dimensionsMm);
      if (!UUID_RE.test(command.carrierConnectionId)) {
        throw labelValidation(`carrierConnectionId must be a uuid.`);
      }

      // ── the order, locked (the exactly-once serializer) ─────────────────
      const order = await this.lockOrder(tx, command.tenantId, command.orderId);
      if (order.status !== 'ready_to_dispatch') {
        // The frozen matrix row: the label command accepts exactly
        // `ready_to_dispatch` — and the refusal NAMES the status.
        throw labelConflict(
          'Order is not labellable',
          `Order "${order.id}" reads "${order.status}" — only a packed (ready_to_dispatch) order is labelled.`,
        );
      }

      // ── the shipment guard: one label per order, ever ───────────────────
      // Any existing row for the order refuses — `labelled` (no regeneration)
      // and `manifested` (the arc is closed) alike. Under the order lock this
      // read sees a concurrent label's committed row; the partial unique
      // index is the backstop for anything the lock cannot serialize.
      const existing = await tx
        .select({ id: shipments.id, status: shipments.status })
        .from(shipments)
        .where(and(eq(shipments.tenantId, command.tenantId), eq(shipments.orderId, order.id)))
        .limit(1);
      if (existing[0] !== undefined) {
        throw labelConflict(
          'Order already has a shipment',
          `Order "${order.id}" already reads a ${existing[0].status} shipment (${existing[0].id}) — there is no label regeneration once labelled.`,
        );
      }

      // ── the connection, in-tx through the facade (AD-6) ─────────────────
      // A foreign tenant's connection id resolves to nothing inside a
      // transaction stamped with THIS tenant's `app.tenant_id` — the read
      // yields nothing and the answer is a plain 404 (the tenant predicate
      // the spec pins its e2e to, shipped with the first caller).
      const connection = await this.carriers.resolveConnectionInTx(
        tx,
        command.tenantId,
        command.carrierConnectionId,
      );
      if (connection === null) {
        throw new ProblemException(
          'not-found',
          404,
          'Carrier connection not found',
          'No carrier connection with this id exists in this tenant.',
        );
      }

      // ── the credential, in-tx (503 arms; never persisted, never logged) ─
      const credential = await this.carriers.openCredentialForAdapterUseInTx(
        tx,
        command.tenantId,
        command.carrierConnectionId,
      );

      // ── the port: the adapter call is the FIRST non-DB step, and every
      // guard above is before it. On adapter failure NOTHING is written —
      // the order stays `ready_to_dispatch`, the retry stays a fresh submit.
      const request: CarrierLabelRequest = {
        orderRef: order.id,
        weightGrams,
        dimensions: dimensionsMm === null ? null : dimensionsMm,
      };
      const label = await labelThroughAdapter(connection.carrierCode, credential, request);

      // ── the write ────────────────────────────────────────────────────────
      const labelledAt = nowIso();
      const shipmentId = uuidv7();
      try {
        await tx.insert(shipments).values({
          id: shipmentId,
          tenantId: command.tenantId,
          warehouseId: order.warehouseId,
          orderId: order.id,
          status: 'labelled',
          carrierConnectionId: connection.id,
          carrierCode: connection.carrierCode,
          // The point-in-time registry display name (the 11-1
          // destination-address precedent): dispatch's auto-stamp reads it
          // straight off the row, with no carriers import.
          carrierName: connection.carrierName,
          trackingNumber: label.trackingNumber,
          labelDocumentRef: label.labelDocumentRef,
          weightGrams,
          lengthMm: dimensionsMm?.lengthMm ?? null,
          widthMm: dimensionsMm?.widthMm ?? null,
          heightMm: dimensionsMm?.heightMm ?? null,
          labelledBy: command.actorUserId,
          labelledAt,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, 'shipments_tenant_order_labelled_unique')) {
          // The race backstop beneath the order lock — a same-order label
          // that slipped past the existence read.
          throw labelConflict(
            'Order already has a shipment',
            `Order "${order.id}" already has a labelled shipment — there is no label regeneration once labelled.`,
          );
        }
        throw err;
      }

      const snapshot: ShipmentSnapshot = {
        shipment: {
          id: shipmentId,
          orderId: order.id,
          tenantId: command.tenantId,
          warehouseId: order.warehouseId,
          status: 'labelled',
          carrierConnectionId: connection.id,
          carrierCode: connection.carrierCode,
          carrierName: connection.carrierName,
          trackingNumber: label.trackingNumber,
          labelDocumentRef: label.labelDocumentRef,
          weightGrams,
          dimensionsMm,
          labelledBy: command.actorUserId,
          labelledAt: canonicalInstant(labelledAt),
          manifestId: null,
        },
      };

      // ── in-transaction outbox append (AD-7) — the writeback Epic 7's
      // channel consumer subscribes to ─────────────────────────────────────
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'shipment.label-created',
        occurredAt: labelledAt,
        payload: { shipment: snapshot.shipment },
      });

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'shipment.label-created',
        targetType: 'order',
        targetId: order.id,
        reference: idempotencyKey,
        occurredAt: labelledAt,
      });

      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── input validation (400 before any write) ───────────────────────────────

  private assertWeight(value: number | null | undefined): number | null {
    if (value === undefined || value === null) {
      return null; // optional: absence is never an error
    }
    if (!Number.isInteger(value) || value <= 0 || value > MAX_WEIGHT_GRAMS) {
      throw labelValidation(
        `weightGrams must be a positive integer of at most ${MAX_WEIGHT_GRAMS} (got ${String(value)}).`,
      );
    }
    return value;
  }

  private assertDimensions(
    value: PackDimensionsInput | null | undefined,
  ): PackDimensionsInput | null {
    if (value === undefined || value === null) {
      return null; // optional: absence is never an error
    }
    // All three arms together or the whole object absent (the pack command's
    // structural rule — a box with two sides is not a measurement).
    for (const arm of ['lengthMm', 'widthMm', 'heightMm'] as const) {
      const side = value[arm];
      if (!Number.isInteger(side) || side <= 0 || side > MAX_DIMENSION_MM) {
        throw labelValidation(
          `dimensionsMm.${arm} must be a positive integer of at most ${MAX_DIMENSION_MM} (got ${String(side)}).`,
        );
      }
    }
    return { lengthMm: value.lengthMm, widthMm: value.widthMm, heightMm: value.heightMm };
  }

  // ── shared pieces (the 4.1 idempotency shape) ─────────────────────────────

  private async lockOrder(tx: TenantTx, tenantId: string, orderId: string) {
    if (!UUID_RE.test(orderId)) {
      throw orderNotFound(orderId);
    }
    const orderRows = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1)
      .for('update');
    const order = orderRows[0];
    if (order === undefined) {
      throw orderNotFound(orderId);
    }
    return order;
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<ShipmentSnapshot | null> {
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
    return row.responseSnapshot as ShipmentSnapshot;
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

function orderNotFound(orderId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Order not found',
    `No order with id "${orderId}" exists in this tenant.`,
  );
}

function concurrentIdempotency(): ProblemException {
  return new ProblemException(
    'conflict',
    409,
    'Concurrent idempotent request',
    'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
  );
}

function labelValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Label validation failed', detail);
}

function labelConflict(title: string, detail: string): ProblemException {
  return new ProblemException('conflict', 409, title, detail);
}