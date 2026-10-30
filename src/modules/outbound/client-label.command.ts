import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, orders, shipments, type Order, type Shipment } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { awbProblem, normalizeAwb } from '../../shared/primitives/awb';
import { normalizeCourierInput } from '../../shared/primitives/courier';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { assertTransporterInTx, type TransporterSnapshotV1 } from '../partners/partners.facade';
import { AttachmentsFacade, sanitizePdf } from '../attachments/attachments.facade';
import { finalizeOwnedUploadInTx } from '../attachments/attachment-records';
import type { AttachmentRow } from '../../shared/db/schema';
import {
  CLIENT_REPLACED_VOID_REASON,
  STAFF_REPLACED_VOID_REASON,
  voidClientArrangedShipmentInTx,
} from './client-arranged';
import {
  authorizeWriterInTx,
  LABEL_OPEN_STATUSES,
  orderNotOpen,
  readOrderForWriterInTx,
  replayInTx,
  runUpload,
  sha256Hex,
  type TxOpener,
  validation,
  writeKeyInTx,
  type Writer,
} from './shipping-support';
import { clientShipmentViewOf, portalShipmentViewOf, type ClientShipmentView, type PortalShipmentView } from './shipping-views';

/**
 * Story 4-4a (A8–A11) — the client-arranged shipment commands: the client's
 * label PDF with its AWB (staff, or the client in the portal), an AWB
 * pre-advice without a file, a staff void, and the label verification at the
 * pack bench (web or handheld). Every command is the guide §1 skeleton; the
 * label upload is reserve → put → finalize (`runUpload`).
 */

/** A8 — `packageCount` bounds (one parcel per order today; a label PDF may carry several pages). */
export const MAX_PACKAGE_COUNT = 999;

export const LABEL_VERIFY_METHODS = ['scan', 'typed'] as const;
export type LabelVerifyMethod = (typeof LABEL_VERIFY_METHODS)[number];

/** A48, A11 — the no-op arm of a repeated (or late) verification. */
export const VERIFY_ALREADY_VERIFIED = 'shipment.verify:already-verified';

export interface ClientLabelInput {
  readonly tenantId: string;
  readonly writer: Writer;
  readonly orderId: string;
  readonly awb: string | undefined;
  readonly courierName?: string | null | undefined;
  readonly transporterId?: string | null | undefined;
  readonly packageCount?: number | null | undefined;
  readonly replace?: boolean | undefined;
}

export interface RecordClientLabelCommand extends ClientLabelInput {
  readonly bytes: Buffer | undefined;
}

/** The label fields every surface sends (A8, A9). */
type LabelFields = Omit<ClientLabelInput, 'writer' | 'tenantId'>;

export interface StaffAwbAdviceCommand extends LabelFields {
  readonly tenantId: string;
  readonly actorUserId: string;
}

export interface PortalAwbAdviceCommand extends Omit<LabelFields, 'transporterId'> {
  readonly tenantId: string;
  /** The SESSION's client (the portal guard's re-read) — never the body. */
  readonly clientId: string;
  readonly actorUserId: string;
}

export interface StaffClientLabelCommand extends StaffAwbAdviceCommand {
  readonly bytes: Buffer | undefined;
}

export interface PortalClientLabelCommand extends PortalAwbAdviceCommand {
  readonly bytes: Buffer | undefined;
}

export interface ShipmentCommandSnapshot {
  readonly shipment: ClientShipmentView;
}

export interface PortalShipmentCommandSnapshot {
  readonly shipment: PortalShipmentView;
}

export interface VoidShipmentCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly orderId: string;
  readonly reason: string;
}

export interface VerifyLabelCommand {
  readonly tenantId: string;
  readonly orderId: string;
  readonly scannedCode: string | undefined;
  readonly method: string | undefined;
  /** `web`: the session user. `device`: the badge-in's device and operator. */
  readonly surface:
    | { readonly kind: 'web'; readonly actorUserId: string }
    | { readonly kind: 'device'; readonly deviceId: string; readonly operatorUserId: string; readonly occurredAt: string | undefined };
}

export interface VerifyLabelSnapshot {
  readonly shipment: ClientShipmentView;
  /** True when this request verified the label; false on the no-op arm. */
  readonly verified: boolean;
}

interface NormalizedLabelInput {
  readonly awb: string;
  readonly transporterId: string | null;
  readonly courierName: string | null;
  readonly packageCount: number | null;
  readonly replace: boolean;
}

@Injectable()
export class ClientLabelCommand {
  private readonly logger = new Logger('ClientLabelCommand');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(AttachmentsFacade) private readonly attachments: AttachmentsFacade,
  ) {}

  // ── A8: the client's label PDF ────────────────────────────────────────────

  /** Staff (`labels.execute`) record the client's label on its behalf. */
  async recordClientLabel(command: StaffClientLabelCommand, idempotencyKey: string): Promise<ShipmentCommandSnapshot> {
    const writer: Writer = { surface: 'staff', actorUserId: command.actorUserId };
    const open: TxOpener = (fn) => withTenantTransaction(this.db, command.tenantId, fn);
    return (await this.recordClientLabelVia({ ...command, writer }, open, idempotencyKey)) as ShipmentCommandSnapshot;
  }

  /**
   * The portal twin (guide §7e): a separate entry, every transaction it opens
   * stamped with the SESSION's client; the portal hash starts with `surface`.
   */
  async portalRecordClientLabel(command: PortalClientLabelCommand, idempotencyKey: string): Promise<PortalShipmentCommandSnapshot> {
    const writer: Writer = { surface: 'portal', actorUserId: command.actorUserId, clientId: command.clientId };
    const open: TxOpener = (fn) => withTenantTransaction(this.db, command.tenantId, fn, { clientId: command.clientId });
    return (await this.recordClientLabelVia({ ...command, writer }, open, idempotencyKey)) as PortalShipmentCommandSnapshot;
  }

  private async recordClientLabelVia(command: RecordClientLabelCommand, open: TxOpener, key: string): Promise<ShipmentCommandSnapshot | PortalShipmentCommandSnapshot> {
    const bytes = command.bytes;
    if (bytes === undefined || bytes.byteLength === 0) {
      throw validation('A label file is required (multipart field "file", a PDF).');
    }
    const input = normalizeLabelInput(command);
    const rawSha256 = sha256Hex(bytes);
    const payloadHash = hashCommandPayload(labelHashInput('client-label', command, input, rawSha256));
    const { writer } = command;
    const authorize = (tx: TenantTx) => authorizeWriterInTx(tx, command.tenantId, writer, 'labels.execute');
    return runUpload({
      open,
      attachments: this.attachments,
      logger: this.logger,
      tenantId: command.tenantId,
      key,
      payloadHash,
      authorize,
      what: 'label',
      origin: {
        source: writer.surface === 'portal' ? 'portal' : 'web',
        deviceId: null,
        createdBy: writer.actorUserId,
        capturedAt: null,
        rawSha256,
      },
      scope: async (tx) => {
        const order = await readOrderForWriterInTx(tx, command.tenantId, writer, command.orderId, null);
        return { purpose: 'shipping-label', docKind: null, clientId: order.clientId, warehouseId: order.warehouseId };
      },
      sanitize: async () => {
        const pdf = await sanitizePdf(bytes);
        return { bytes: pdf.bytes, sha256: pdf.sha256, contentType: pdf.contentType, width: pdf.width, height: pdf.height, pageCount: pdf.pageCount };
      },
      // The replay already ran under the reservation lock; the order-lock
      // replay inside cannot find a key (the reservation serialises same-key).
      body: async (tx, reservation) => (await this.recordInTx(tx, command, input, 'client-label', key, payloadHash, reservation)).snapshot,
    });
  }

  // ── A9: the AWB pre-advice ────────────────────────────────────────────────

  async recordAwbAdvice(command: StaffAwbAdviceCommand, idempotencyKey: string): Promise<ShipmentCommandSnapshot> {
    const writer: Writer = { surface: 'staff', actorUserId: command.actorUserId };
    const open: TxOpener = (fn) => withTenantTransaction(this.db, command.tenantId, fn);
    return (await this.recordAwbAdviceVia({ ...command, writer }, open, idempotencyKey)) as ShipmentCommandSnapshot;
  }

  /** The portal twin — stamped with the SESSION's client. */
  async portalRecordAwbAdvice(command: PortalAwbAdviceCommand, idempotencyKey: string): Promise<PortalShipmentCommandSnapshot> {
    const writer: Writer = { surface: 'portal', actorUserId: command.actorUserId, clientId: command.clientId };
    const open: TxOpener = (fn) => withTenantTransaction(this.db, command.tenantId, fn, { clientId: command.clientId });
    return (await this.recordAwbAdviceVia({ ...command, writer }, open, idempotencyKey)) as PortalShipmentCommandSnapshot;
  }

  private async recordAwbAdviceVia(command: ClientLabelInput, open: TxOpener, key: string): Promise<ShipmentCommandSnapshot | PortalShipmentCommandSnapshot> {
    const input = normalizeLabelInput(command);
    const payloadHash = hashCommandPayload(labelHashInput('awb-advice', command, input, null));
    const { writer } = command;
    return open(async (tx) => {
      await authorizeWriterInTx(tx, command.tenantId, writer, 'labels.execute');
      const first = await replayInTx(tx, command.tenantId, key, payloadHash);
      if (first !== null) return first as ShipmentCommandSnapshot;
      const recorded = await this.recordInTx(tx, command, input, 'courier-label', key, payloadHash, null);
      if (recorded.replayed) return recorded.snapshot;
      await writeKeyInTx(tx, command.tenantId, key, payloadHash, recorded.snapshot);
      return recorded.snapshot;
    });
  }

  /**
   * Tx B of A8 and the body of A9: the order `FOR UPDATE` → replay again →
   * its live shipment `FOR UPDATE` → the transporter → the guards in order
   * (order open; the live shipment; the AWB free) → the writes.
   */
  private async recordInTx(
    tx: TenantTx,
    command: ClientLabelInput,
    input: NormalizedLabelInput,
    kind: 'client-label' | 'courier-label',
    key: string,
    payloadHash: string,
    reservation: AttachmentRow | null,
  ): Promise<{ snapshot: ShipmentCommandSnapshot | PortalShipmentCommandSnapshot; replayed: boolean }> {
    const { writer, tenantId } = command;
    const order = await readOrderForWriterInTx(tx, tenantId, writer, command.orderId, 'update');
    // The second replay, under the order lock (the A9 path's same-key race —
    // a duplicate parked on the order wakes to the winner's snapshot).
    const raced = await replayInTx(tx, tenantId, key, payloadHash);
    if (raced !== null) return { snapshot: raced as ShipmentCommandSnapshot, replayed: true };
    const live = await lockLiveShipmentInTx(tx, tenantId, order.id);
    const transporter: TransporterSnapshotV1 | null =
      input.transporterId === null ? null : await assertTransporterInTx(tx, tenantId, input.transporterId, 'a client label');
    const label = orderLabelOf(order);

    // 1. the order is open — except that a parcel already handed over answers
    // the more specific 409 `shipment-handed-over` (the matrix row "Replace …
    // after handover"): its order reads `dispatched`, so the open check alone
    // would make that answer unreachable.
    if (live !== null && live.status === 'handed_over') {
      throw new ProblemException('shipment-handed-over', 409, 'Shipment already handed over', `Order ${label}'s parcel was already handed to ${live.carrierName} (AWB ${live.trackingNumber}).`);
    }
    if (!(LABEL_OPEN_STATUSES as readonly string[]).includes(order.status)) {
      throw orderNotOpen(order, label);
    }
    // 2. the live shipment.
    const now = nowIso();
    let replaced: Shipment | null = null;
    if (live !== null) {
      if (live.kind === 'carrier') {
        throw new ProblemException(
          'shipment-exists',
          409,
          'Order already has a shipment',
          `Order ${label} already has a carrier label (${live.carrierName} ${live.trackingNumber}) — void it before recording the client's own courier.`,
          { awb: live.trackingNumber, kind: live.kind },
        );
      }
      if (live.status === 'handed_over') {
        throw new ProblemException('shipment-handed-over', 409, 'Shipment already handed over', `Order ${label}'s parcel was already handed to ${live.carrierName} (AWB ${live.trackingNumber}).`);
      }
      if (!input.replace) {
        throw new ProblemException(
          'shipment-exists',
          409,
          'Order already has a shipment',
          `Order ${label} already has ${live.kind === 'client-label' ? 'a client label' : 'an AWB'} (${live.carrierName} ${live.trackingNumber}) — replace it to record another.`,
          { awb: live.trackingNumber, kind: live.kind },
        );
      }
      // The void is written FIRST (D7): a replace with the same AWB is not
      // refused by its own shipment.
      replaced = await voidClientArrangedShipmentInTx(tx, this.outbox, {
        tenantId,
        shipment: live,
        actorUserId: writer.actorUserId,
        reason: writer.surface === 'portal' ? CLIENT_REPLACED_VOID_REASON : STAFF_REPLACED_VOID_REASON,
        at: now,
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId: writer.actorUserId,
        action: 'shipment.voided',
        targetType: 'order',
        targetId: order.id,
        reference: key,
        occurredAt: now,
      });
    }
    // 3. the AWB is free among the client's OPEN client-arranged shipments.
    await assertAwbFreeInTx(tx, tenantId, order.clientId, input.awb, label);

    // ── the writes ─────────────────────────────────────────────────────────
    const file =
      reservation === null
        ? null
        : await finalizeOwnedUploadInTx(tx, {
            reservation,
            ownerType: 'order',
            ownerId: order.id,
            ownerParentId: order.id,
            clientId: order.clientId,
            warehouseId: order.warehouseId,
          });
    const courierName = transporter?.name ?? input.courierName!;
    const row = await insertClientArrangedInTx(tx, {
      tenantId,
      order,
      kind,
      courierName,
      transporterId: input.transporterId,
      transporter,
      awb: input.awb,
      packageCount: input.packageCount,
      labelAttachmentId: file?.id ?? null,
      actorUserId: writer.actorUserId,
      labelledAt: now,
      surface: writer.surface === 'portal' ? 'portal' : 'web',
      status: 'labelled',
      label,
    });
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type: 'shipment.recorded',
      occurredAt: now,
      payload: { shipmentId: row.id, orderId: order.id, clientId: order.clientId, kind, awb: row.trackingNumber, courierName: row.carrierName },
    });
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId: writer.actorUserId,
      action: kind === 'client-label' ? 'shipment.client_label_recorded' : 'shipment.awb_recorded',
      targetType: 'order',
      targetId: order.id,
      reference: key,
      changes: { shipmentId: row.id, awb: row.trackingNumber, surface: writer.surface, ...(replaced === null ? {} : { replacedShipmentId: replaced.id }) },
      occurredAt: now,
    });
    return {
      snapshot: writer.surface === 'portal' ? { shipment: portalShipmentViewOf(row) } : { shipment: clientShipmentViewOf(row) },
      replayed: false,
    };
  }

  // ── A10: the staff void ───────────────────────────────────────────────────

  async voidShipment(command: VoidShipmentCommand, key: string): Promise<ShipmentCommandSnapshot> {
    const reason = typeof command.reason === 'string' ? command.reason.trim() : '';
    if (reason.length < 1 || [...reason].length > 200) {
      throw validation('reason must be 1–200 characters.');
    }
    const payloadHash = hashCommandPayload({ arm: 'shipment-void', tenantId: command.tenantId, orderId: command.orderId, reason });
    const writer: Writer = { surface: 'staff', actorUserId: command.actorUserId };
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'labels.execute');
      const first = await replayInTx(tx, command.tenantId, key, payloadHash);
      if (first !== null) return first as ShipmentCommandSnapshot;
      const order = await readOrderForWriterInTx(tx, command.tenantId, writer, command.orderId, 'update');
      const live = await lockLiveShipmentInTx(tx, command.tenantId, order.id);
      const second = await replayInTx(tx, command.tenantId, key, payloadHash);
      if (second !== null) return second as ShipmentCommandSnapshot;
      const label = orderLabelOf(order);
      if (live === null) {
        throw new ProblemException('not-found', 404, 'No shipment to void', `Order ${label} has no live shipment.`);
      }
      if (live.kind === 'carrier') {
        throw new ProblemException(
          'shipment-not-client-arranged',
          409,
          'Shipment is a carrier label',
          `Order ${label}'s shipment is a carrier label (${live.carrierName}) — cancel the order with restock to void it.`,
        );
      }
      if (live.status === 'handed_over') {
        throw new ProblemException('shipment-handed-over', 409, 'Shipment already handed over', `Order ${label}'s parcel was already handed to ${live.carrierName} (AWB ${live.trackingNumber}).`);
      }
      const now = nowIso();
      const voided = await voidClientArrangedShipmentInTx(tx, this.outbox, { tenantId: command.tenantId, shipment: live, actorUserId: command.actorUserId, reason, at: now });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'shipment.voided',
        targetType: 'order',
        targetId: order.id,
        reference: key,
        changes: { shipmentId: voided.id, reason },
        occurredAt: now,
      });
      const snapshot: ShipmentCommandSnapshot = { shipment: clientShipmentViewOf(voided) };
      await writeKeyInTx(tx, command.tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── A11, A48: the label verification ──────────────────────────────────────

  async verifyLabel(command: VerifyLabelCommand, key: string): Promise<VerifyLabelSnapshot> {
    const raw = typeof command.scannedCode === 'string' ? command.scannedCode : '';
    const scanned = normalizeAwb(raw);
    if (scanned === '' || scanned.length > 60) {
      throw validation('scannedCode must be the scanned (or typed) AWB, 1–60 characters.');
    }
    const method = command.method;
    if (method !== 'scan' && method !== 'typed') {
      throw validation(`method must be one of ["scan","typed"] (got ${JSON.stringify(method ?? null)}).`);
    }
    const surface = command.surface;
    let occurredAt: string | null = null;
    if (surface.kind === 'device') {
      const at = surface.occurredAt;
      if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || !/Z$/.test(at)) {
        throw validation('occurredAt is required on the device — an ISO-8601 UTC instant.');
      }
      occurredAt = at;
    }
    const payloadHash = hashCommandPayload({
      arm: 'label-verify',
      surface: surface.kind,
      tenantId: command.tenantId,
      orderId: command.orderId,
      scannedCode: scanned,
      method,
      occurredAt,
    });
    const actorUserId = surface.kind === 'web' ? surface.actorUserId : surface.operatorUserId;
    const writer: Writer = { surface: 'staff', actorUserId };
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      if (surface.kind === 'device') {
        await assertDeviceOperatorInTx(tx, command.tenantId, surface.deviceId, surface.operatorUserId);
      }
      assertPermission(await getMemberRoleIn(tx, command.tenantId, actorUserId), 'pack.execute');
      const first = await replayInTx(tx, command.tenantId, key, payloadHash);
      if (first !== null) return first as VerifyLabelSnapshot;
      const order = await readOrderForWriterInTx(tx, command.tenantId, writer, command.orderId, 'share');
      const live = await lockLiveShipmentInTx(tx, command.tenantId, order.id);
      const second = await replayInTx(tx, command.tenantId, key, payloadHash);
      if (second !== null) return second as VerifyLabelSnapshot;
      const label = orderLabelOf(order);
      const noOp = async (shipment: Shipment): Promise<VerifyLabelSnapshot> => {
        // The no-op arm (AUDIT_NO_OP_ARMS `shipment.verify:already-verified`):
        // the key is stored, nothing else written or audited.
        const snapshot: VerifyLabelSnapshot = { shipment: clientShipmentViewOf(shipment), verified: false };
        await writeKeyInTx(tx, command.tenantId, key, payloadHash, snapshot);
        return snapshot;
      };
      // A48 — a device verify that arrives after the handover: the same
      // normalised AWB, verified → the settled no-op; otherwise refused.
      if (order.status === 'dispatched' && live !== null && live.labelVerifiedAt !== null && live.trackingNumber === scanned) {
        return noOp(live);
      }
      if (!(LABEL_OPEN_STATUSES as readonly string[]).includes(order.status)) {
        throw orderNotOpen(order, label);
      }
      if (live === null || live.kind !== 'client-label' || live.status !== 'labelled') {
        throw new ProblemException(
          'no-client-label',
          409,
          'No client label to verify',
          live === null
            ? `Order ${label} has no client label — the courier brings its own; scan its AWB at the handover.`
            : `Order ${label}'s shipment is ${live.kind === 'courier-label' ? 'a courier label (scan its AWB at the handover)' : live.kind === 'carrier' ? 'a carrier label' : live.status}.`,
        );
      }
      if (live.trackingNumber !== scanned) {
        throw new ProblemException(
          'label-mismatch',
          422,
          'Label does not match the order',
          `This label reads …${scanned.slice(-4)} — order ${label}'s AWB ends …${live.trackingNumber.slice(-4)}. Re-print the client label and scan it again.`,
          { scanned },
        );
      }
      if (live.labelVerifiedAt !== null) return noOp(live);
      const now = nowIso();
      const verifiedAt = occurredAt === null ? now : new Date(Math.min(Date.parse(occurredAt), Date.parse(now))).toISOString();
      const [updated] = await tx
        .update(shipments)
        .set({
          labelVerifiedAt: verifiedAt,
          labelVerifiedBy: actorUserId,
          labelVerifiedDeviceId: surface.kind === 'device' ? surface.deviceId : null,
          labelVerifyMethod: method,
          updatedAt: now,
        })
        .where(and(eq(shipments.id, live.id), eq(shipments.status, 'labelled')))
        .returning();
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId,
        action: 'shipment.label_verified',
        targetType: 'order',
        targetId: order.id,
        reference: key,
        changes: { shipmentId: live.id, method, ...(surface.kind === 'device' ? { deviceId: surface.deviceId } : {}) },
        // The device's audit row is server time (guide §1, 3-2b).
        occurredAt: now,
      });
      if (surface.kind === 'device') await touchDeviceInTx(tx, surface.deviceId);
      const snapshot: VerifyLabelSnapshot = { shipment: clientShipmentViewOf(updated!), verified: true };
      await writeKeyInTx(tx, command.tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }
}

// ── shared pieces ─────────────────────────────────────────────────────────────

function normalizeLabelInput(command: ClientLabelInput): NormalizedLabelInput {
  const awb = normalizeAwb(typeof command.awb === 'string' ? command.awb : '');
  const problem = awbProblem(awb);
  if (problem !== null) throw validation(`awb: ${problem}`);
  if (command.writer.surface === 'portal' && command.transporterId !== undefined && command.transporterId !== null && command.transporterId !== '') {
    throw validation('transporterId is not accepted in the portal — type the courier’s name (courierName).');
  }
  const courier = normalizeCourierInput({ transporterId: command.transporterId, courierName: command.courierName });
  const count = command.packageCount ?? null;
  if (count !== null && (!Number.isInteger(count) || count < 1 || count > MAX_PACKAGE_COUNT)) {
    throw validation(`packageCount must be a whole number of parcels, 1–${MAX_PACKAGE_COUNT}.`);
  }
  return { awb, transporterId: courier.transporterId, courierName: courier.courierName, packageCount: count, replace: command.replace === true };
}

/** The A8 / A9 hash, per surface (the portal's key set starts with `surface`, and names the client, never a transporter). */
function labelHashInput(arm: 'client-label' | 'awb-advice', command: ClientLabelInput, input: NormalizedLabelInput, rawSha256: string | null): Record<string, unknown> {
  if (command.writer.surface === 'portal') {
    return {
      surface: 'portal',
      arm,
      tenantId: command.tenantId,
      clientId: command.writer.clientId,
      orderId: command.orderId,
      ...(arm === 'client-label' ? { rawSha256 } : {}),
      awb: input.awb,
      courierName: input.courierName,
      packageCount: input.packageCount,
      replace: input.replace,
    };
  }
  return {
    arm,
    surface: 'staff',
    tenantId: command.tenantId,
    orderId: command.orderId,
    ...(arm === 'client-label' ? { rawSha256 } : {}),
    awb: input.awb,
    transporterId: input.transporterId,
    courierName: input.courierName,
    packageCount: input.packageCount,
    replace: input.replace,
  };
}

/** The order's live shipment, `FOR UPDATE` (lock only — guide §1). */
export async function lockLiveShipmentInTx(tx: TenantTx, tenantId: string, orderId: string): Promise<Shipment | null> {
  const rows = await tx
    .select()
    .from(shipments)
    .where(and(eq(shipments.tenantId, tenantId), eq(shipments.orderId, orderId), ne(shipments.status, 'voided')))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/**
 * D6 — the AWB is free among the CLIENT's open (`labelled`) client-arranged
 * shipments: a read that, under either stamp, sees only the client's own
 * rows, so the refusal always names the client's own order.
 */
export async function assertAwbFreeInTx(tx: TenantTx, tenantId: string, clientId: string, awb: string, forLabel: string): Promise<void> {
  const rows = await tx
    .select({ orderId: shipments.orderId, order: orders })
    .from(shipments)
    .innerJoin(orders, and(eq(orders.tenantId, shipments.tenantId), eq(orders.id, shipments.orderId)))
    .where(
      and(
        eq(shipments.tenantId, tenantId),
        eq(shipments.clientId, clientId),
        eq(shipments.trackingNumber, awb),
        eq(shipments.status, 'labelled'),
        sql`${shipments.kind} <> 'carrier'`,
      ),
    )
    .limit(1);
  const holder = rows[0];
  if (holder !== undefined) throw awbInUse(awb, holder.orderId, orderLabelOf(holder.order), forLabel);
}

export function awbInUse(awb: string, holderOrderId: string, holderLabel: string, forLabel: string): ProblemException {
  return new ProblemException(
    'awb-in-use',
    409,
    'AWB already in use',
    `AWB ${awb} is already on order ${holderLabel}, which has not been handed over — check the AWB for order ${forLabel}.`,
    { orderId: holderOrderId },
  );
}

/** The client-arranged shipment insert — the unique-index backstops mapped by constraint name (D6, A28). */
export async function insertClientArrangedInTx(
  tx: TenantTx,
  input: {
    readonly tenantId: string;
    readonly order: Order;
    readonly kind: 'client-label' | 'courier-label';
    readonly courierName: string;
    readonly transporterId: string | null;
    readonly transporter: TransporterSnapshotV1 | null;
    readonly awb: string;
    readonly packageCount: number | null;
    readonly labelAttachmentId: string | null;
    readonly actorUserId: string;
    readonly labelledAt: string;
    readonly surface: 'web' | 'portal' | 'handheld';
    readonly status: 'labelled' | 'handed_over';
    readonly label: string;
    readonly handover?: { readonly id: string; readonly at: string; readonly weightGrams: number | null; readonly dims: { lengthMm: number; widthMm: number; heightMm: number } | null; readonly verify: { readonly at: string; readonly by: string; readonly deviceId: string | null } | null };
  },
): Promise<Shipment> {
  try {
    const [row] = await tx
      .insert(shipments)
      .values({
        id: uuidv7(),
        tenantId: input.tenantId,
        warehouseId: input.order.warehouseId,
        orderId: input.order.id,
        clientId: input.order.clientId,
        kind: input.kind,
        status: input.status,
        carrierName: input.courierName,
        trackingNumber: input.awb,
        courierPartnerId: input.transporterId,
        courierSnapshot: input.transporter,
        packageCount: input.packageCount,
        labelAttachmentId: input.labelAttachmentId,
        labelledBy: input.actorUserId,
        labelledAt: input.labelledAt,
        recordedSurface: input.surface,
        ...(input.handover === undefined
          ? {}
          : {
              handoverId: input.handover.id,
              handedOverAt: input.handover.at,
              weightGrams: input.handover.weightGrams,
              lengthMm: input.handover.dims?.lengthMm ?? null,
              widthMm: input.handover.dims?.widthMm ?? null,
              heightMm: input.handover.dims?.heightMm ?? null,
              ...(input.handover.verify === null
                ? {}
                : {
                    labelVerifiedAt: input.handover.verify.at,
                    labelVerifiedBy: input.handover.verify.by,
                    labelVerifiedDeviceId: input.handover.verify.deviceId,
                    labelVerifyMethod: 'handover-scan',
                  }),
            }),
        createdAt: input.labelledAt,
        updatedAt: input.labelledAt,
      })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolationOn(err, 'shipments_client_awb_open_unique')) {
      // The race backstop behind `assertAwbFreeInTx` (D6): another command
      // took this AWB for this client meanwhile.
      throw new ProblemException('awb-in-use', 409, 'AWB already in use', `AWB ${input.awb} was just recorded on another of this client's orders — check the AWB for order ${input.label}.`);
    }
    if (isUniqueViolationOn(err, 'shipments_tenant_order_live_unique') || isUniqueViolationOn(err, 'shipments_tenant_order_labelled_unique')) {
      throw new ProblemException('shipment-exists', 409, 'Order already has a shipment', `Order ${input.label} already has a shipment — reload it.`);
    }
    throw err;
  }
}

