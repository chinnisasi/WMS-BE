import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, courierHandovers, shipments, type CourierHandover } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { AttachmentsFacade, sanitizeImage, sanitizeShippingFile } from '../attachments/attachments.facade';
import {
  countDeviceStagedInTx,
  countLiveByOwnerInTx,
  DEVICE_STAGED_PHOTO_CAP,
  finalizeDeviceUploadInTx,
  finalizeOwnedUploadInTx,
  lockAttachmentByIdInTx,
  markRemovedInTx,
  SHIPPING_DOC_KINDS,
  type ShippingDocKind,
} from '../attachments/attachment-records';
import { appendDocumentSharedInTx, liveShipmentOfOrderInTx } from './client-arranged';
import {
  authorizeWriterInTx,
  readOrderForWriterInTx,
  replayInTx,
  runUpload,
  sha256Hex,
  type TxOpener,
  validation,
  writeKeyInTx,
  type Writer,
} from './shipping-support';
import { shippingFileSnapshotOf, type ShippingFileSnapshot } from './shipping-views';

/**
 * Story 4-4a (A14, A35, A46) — the shipping files: an order's documents
 * (staff, or the client's own in the portal), a handover's signed sheet (the
 * web upload, and the handheld's staged photo that the handover claims or a
 * late upload fills), and the staff removal. Every upload is reserve → put →
 * finalize (`runUpload`); the cap and the share decision are judged under
 * the owner's lock in Tx B.
 */

/** A46 — live documents per order, counted by source: the warehouse's and the client's own. */
export const ORDER_DOCUMENTS_MAX_WAREHOUSE = 20;
export const ORDER_DOCUMENTS_MAX_PORTAL = 10;
/** A14 — live signed-sheet pages per handover. */
export const HANDOVER_SHEET_MAX_PAGES = 10;
/** The kinds a client may upload (never `pod` — the warehouse's record of delivery). */
export const PORTAL_DOC_KINDS = ['invoice', 'challan', 'eway-bill', 'other'] as const satisfies readonly ShippingDocKind[];

/** 2-5a's capture-time clamp (A28): `[now − 60 d, now + 10 min]`. */
const CAPTURED_AT_PAST_MS = 60 * 86_400_000;
const CAPTURED_AT_FUTURE_MS = 10 * 60_000;
const INSTANT_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export interface UploadOrderDocumentCommand {
  readonly tenantId: string;
  readonly writer: Writer;
  readonly orderId: string;
  readonly kind: string | undefined;
  readonly bytes: Buffer | undefined;
}

export interface StaffOrderDocumentCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly orderId: string;
  readonly kind: string | undefined;
  readonly bytes: Buffer | undefined;
}

export interface PortalOrderDocumentCommand {
  readonly tenantId: string;
  /** The SESSION's client — never the body. */
  readonly clientId: string;
  readonly actorUserId: string;
  readonly orderId: string;
  readonly kind: string | undefined;
  readonly bytes: Buffer | undefined;
}

export interface UploadHandoverSheetCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly handoverId: string;
  readonly bytes: Buffer | undefined;
}

export interface StageHandoverPhotoCommand {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly opOperator: string | undefined;
  readonly capturedAt: string | undefined;
  readonly bytes: Buffer | undefined;
}

export interface RemoveShippingFileCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly attachmentId: string;
  readonly reason: string;
}

export interface ShippingFileCommandSnapshot {
  readonly file: ShippingFileSnapshot;
}

export interface StagedPhotoSnapshot {
  readonly ref: string;
  readonly status: 'staged' | 'attached' | 'removed';
}

@Injectable()
export class ShippingFilesCommand {
  private readonly logger = new Logger('ShippingFilesCommand');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(AttachmentsFacade) private readonly attachments: AttachmentsFacade,
  ) {}

  // ── A14: an order's document ──────────────────────────────────────────────

  async uploadOrderDocument(command: StaffOrderDocumentCommand, idempotencyKey: string): Promise<ShippingFileCommandSnapshot> {
    const writer: Writer = { surface: 'staff', actorUserId: command.actorUserId };
    const open: TxOpener = (fn) => withTenantTransaction(this.db, command.tenantId, fn);
    return this.uploadOrderDocumentVia({ ...command, writer }, open, idempotencyKey);
  }

  /** The portal twin (guide §7e) — every transaction stamped with the SESSION's client; never `pod`. */
  async portalUploadOrderDocument(command: PortalOrderDocumentCommand, idempotencyKey: string): Promise<ShippingFileCommandSnapshot> {
    const writer: Writer = { surface: 'portal', actorUserId: command.actorUserId, clientId: command.clientId };
    const open: TxOpener = (fn) => withTenantTransaction(this.db, command.tenantId, fn, { clientId: command.clientId });
    return this.uploadOrderDocumentVia({ ...command, writer }, open, idempotencyKey);
  }

  private async uploadOrderDocumentVia(command: UploadOrderDocumentCommand, open: TxOpener, key: string): Promise<ShippingFileCommandSnapshot> {
    const bytes = requireFile(command.bytes);
    const { writer } = command;
    const allowed: readonly string[] = writer.surface === 'portal' ? PORTAL_DOC_KINDS : SHIPPING_DOC_KINDS;
    const kind = command.kind;
    if (typeof kind !== 'string' || !allowed.includes(kind)) {
      throw validation(`kind must be one of ${JSON.stringify(allowed)} (got ${JSON.stringify(kind ?? null)}).`);
    }
    const rawSha256 = sha256Hex(bytes);
    const payloadHash = hashCommandPayload({
      arm: 'order-document',
      surface: writer.surface,
      tenantId: command.tenantId,
      ...(writer.surface === 'portal' ? { clientId: writer.clientId } : {}),
      orderId: command.orderId,
      kind,
      rawSha256,
    });
    const source = writer.surface === 'portal' ? 'portal' : 'web';
    return runUpload({
      open,
      attachments: this.attachments,
      logger: this.logger,
      tenantId: command.tenantId,
      key,
      payloadHash,
      authorize: (tx) => authorizeWriterInTx(tx, command.tenantId, writer, 'dispatch.execute'),
      what: 'document',
      origin: { source, deviceId: null, createdBy: writer.actorUserId, capturedAt: null, rawSha256 },
      scope: async (tx) => {
        const order = await readOrderForWriterInTx(tx, command.tenantId, writer, command.orderId, null);
        assertDocumentableOrder(order);
        await assertDocumentCap(tx, command.tenantId, order.id, source);
        return { purpose: 'shipping-document', docKind: kind as ShippingDocKind, clientId: order.clientId, warehouseId: order.warehouseId };
      },
      sanitize: () => sanitizeShippingFile(bytes),
      body: async (tx, reservation) => {
        // A46 — the order FOR SHARE before the count and the share decision:
        // a handover's `FOR UPDATE` of the order serialises against it.
        const order = await readOrderForWriterInTx(tx, command.tenantId, writer, command.orderId, 'share');
        assertDocumentableOrder(order);
        await assertDocumentCap(tx, command.tenantId, order.id, source);
        const row = await finalizeOwnedUploadInTx(tx, {
          reservation,
          ownerType: 'order',
          ownerId: order.id,
          ownerParentId: order.id,
          clientId: order.clientId,
          warehouseId: order.warehouseId,
        });
        const now = nowIso();
        // Already dispatched (and warehouse-captured): shared now. Before the
        // dispatch, the dispatch shares it (A47).
        if (order.status === 'dispatched' && source !== 'portal') {
          const live = await liveShipmentOfOrderInTx(tx, command.tenantId, order.id);
          await appendDocumentSharedInTx(tx, this.outbox, {
            tenantId: command.tenantId,
            at: now,
            payload: {
              attachmentId: row.id,
              clientId: order.clientId,
              orderId: order.id,
              handoverId: live?.handoverId ?? null,
              purpose: 'shipping-document',
              docKind: row.docKind,
            },
          });
        }
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: writer.actorUserId,
          action: 'shipping_file.attached',
          targetType: 'attachment',
          targetId: row.id,
          reference: key,
          changes: { orderId: order.id, purpose: 'shipping-document', docKind: kind, source },
          occurredAt: now,
        });
        return { file: shippingFileSnapshotOf(row) };
      },
    });
  }

  // ── A14, A35: a handover's signed sheet (web) ─────────────────────────────

  async uploadHandoverSheet(command: UploadHandoverSheetCommand, key: string): Promise<ShippingFileCommandSnapshot> {
    const bytes = requireFile(command.bytes);
    const rawSha256 = sha256Hex(bytes);
    const payloadHash = hashCommandPayload({ arm: 'handover-sheet', tenantId: command.tenantId, handoverId: command.handoverId, rawSha256 });
    const writer: Writer = { surface: 'staff', actorUserId: command.actorUserId };
    return runUpload({
      open: (fn) => withTenantTransaction(this.db, command.tenantId, fn),
      attachments: this.attachments,
      logger: this.logger,
      tenantId: command.tenantId,
      key,
      payloadHash,
      authorize: (tx) => authorizeWriterInTx(tx, command.tenantId, writer, 'dispatch.execute'),
      what: 'signed sheet',
      origin: { source: 'web', deviceId: null, createdBy: command.actorUserId, capturedAt: null, rawSha256 },
      scope: async (tx) => {
        const handover = await readHandoverInTx(tx, command.tenantId, command.handoverId, false);
        await assertSheetCap(tx, command.tenantId, handover.id);
        return { purpose: 'handover-sheet', docKind: null, clientId: handover.clientId, warehouseId: handover.warehouseId };
      },
      sanitize: () => sanitizeShippingFile(bytes),
      body: async (tx, reservation) => {
        const handover = await readHandoverInTx(tx, command.tenantId, command.handoverId, true);
        await assertSheetCap(tx, command.tenantId, handover.id);
        const row = await finalizeOwnedUploadInTx(tx, {
          reservation,
          ownerType: 'courier_handover',
          ownerId: handover.id,
          ownerParentId: handover.id,
          clientId: handover.clientId,
          warehouseId: handover.warehouseId,
        });
        const now = nowIso();
        await appendDocumentSharedInTx(tx, this.outbox, {
          tenantId: command.tenantId,
          at: now,
          payload: { attachmentId: row.id, clientId: handover.clientId, orderId: null, handoverId: handover.id, purpose: 'handover-sheet', docKind: null },
        });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'handover.sheet_attached',
          targetType: 'attachment',
          targetId: row.id,
          reference: key,
          changes: { handoverId: handover.id, code: handover.code },
          occurredAt: now,
        });
        return { file: shippingFileSnapshotOf(row) };
      },
    });
  }

  // ── A14, A35: the handheld's sheet photo (2-5a's twin) ────────────────────

  async stageHandoverPhoto(command: StageHandoverPhotoCommand, ref: string): Promise<StagedPhotoSnapshot> {
    const opOperator = command.opOperator?.trim() ?? '';
    if (!UUID_RE.test(opOperator)) {
      throw validation('The x-op-operator header must name the capturing operator (a user id).');
    }
    const capturedAtRaw = command.capturedAt?.trim() ?? '';
    if (!INSTANT_Z.test(capturedAtRaw) || Number.isNaN(Date.parse(capturedAtRaw))) {
      throw validation(`capturedAt must be an ISO-8601 UTC instant ending in Z (got ${JSON.stringify(command.capturedAt ?? null)}).`);
    }
    const bytes = requireFile(command.bytes);
    const rawSha256 = sha256Hex(bytes);
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      surface: 'device-handover-photo',
      deviceId: command.deviceId,
      opOperator,
      capturedAt: capturedAtRaw,
      rawSha256,
    });
    const now = Date.now();
    const capturedAt = new Date(Math.min(Math.max(Date.parse(capturedAtRaw), now - CAPTURED_AT_PAST_MS), now + CAPTURED_AT_FUTURE_MS)).toISOString();
    const authorize = (tx: TenantTx) => assertDeviceOperatorInTx(tx, command.tenantId, command.deviceId, opOperator);
    return runUpload({
      open: (fn) => withTenantTransaction(this.db, command.tenantId, fn),
      attachments: this.attachments,
      logger: this.logger,
      tenantId: command.tenantId,
      key: ref,
      payloadHash,
      authorize,
      what: 'photo',
      origin: { source: 'handheld', deviceId: command.deviceId, createdBy: opOperator, capturedAt, rawSha256 },
      scope: async (tx) => {
        const staged = await countDeviceStagedInTx(tx, command.tenantId, command.deviceId);
        if (staged >= DEVICE_STAGED_PHOTO_CAP) {
          throw new ProblemException(
            'attachment-staging-limit',
            429,
            'Too many photos waiting',
            `This device has ${staged} photos waiting for their receipt or handover (at most ${DEVICE_STAGED_PHOTO_CAP}) — sync first.`,
          );
        }
        return { purpose: 'handover-sheet', docKind: null, clientId: null, warehouseId: null };
      },
      sanitize: async () => {
        const image = sanitizeImage(bytes);
        return { bytes: image.bytes, sha256: sha256Hex(image.bytes), contentType: image.contentType, width: image.width, height: image.height, pageCount: null };
      },
      body: async (tx, reservation) => {
        const result = await finalizeDeviceUploadInTx(tx, { tenantId: command.tenantId, reservation, ref });
        const at = nowIso();
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: opOperator,
          action: 'handover_photo.uploaded',
          targetType: 'attachment',
          targetId: result.row.id,
          reference: ref,
          changes: { arm: result.arm, deviceId: command.deviceId },
          occurredAt: at,
        });
        if (result.arm === 'filled' && result.row.ownerType === 'courier_handover' && result.row.clientId !== null) {
          // A35 — a page becomes `attached` here: it is shared now.
          await appendDocumentSharedInTx(tx, this.outbox, {
            tenantId: command.tenantId,
            at,
            payload: {
              attachmentId: result.row.id,
              clientId: result.row.clientId,
              orderId: null,
              handoverId: result.row.ownerId,
              purpose: 'handover-sheet',
              docKind: null,
            },
          });
        }
        await touchDeviceInTx(tx, command.deviceId);
        const status = result.row.status === 'staged' ? 'staged' : result.row.status === 'removed' ? 'removed' : 'attached';
        return { ref, status };
      },
    });
  }

  // ── A14: remove a shipping file ───────────────────────────────────────────

  async removeFile(command: RemoveShippingFileCommand, key: string): Promise<ShippingFileCommandSnapshot> {
    const reason = typeof command.reason === 'string' ? command.reason.trim() : '';
    if (reason.length < 1 || [...reason].length > 200) throw validation('reason must be 1–200 characters.');
    const payloadHash = hashCommandPayload({ arm: 'shipping-file-remove', tenantId: command.tenantId, attachmentId: command.attachmentId, reason });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'orders.manage');
      const first = await replayInTx(tx, command.tenantId, key, payloadHash);
      if (first !== null) return first as ShippingFileCommandSnapshot;
      const row = UUID_RE.test(command.attachmentId) ? await lockAttachmentByIdInTx(tx, command.tenantId, command.attachmentId) : null;
      const second = await replayInTx(tx, command.tenantId, key, payloadHash);
      if (second !== null) return second as ShippingFileCommandSnapshot;
      if (row === null || row.purpose === 'receipt-damage') {
        throw new ProblemException('not-found', 404, 'File not found', `No shipping file "${command.attachmentId}" exists in this tenant.`);
      }
      if (row.status !== 'attached' && row.status !== 'awaited') {
        throw new ProblemException('attachment-not-attached', 409, 'File not removable', `This file is ${row.status} — nothing to remove.`);
      }
      if (row.purpose === 'shipping-label') {
        const inUse = await tx
          .select({ id: shipments.id })
          .from(shipments)
          .where(and(eq(shipments.tenantId, command.tenantId), eq(shipments.labelAttachmentId, row.id)))
          .limit(1);
        if (inUse.length > 0) {
          throw new ProblemException(
            'label-in-use',
            409,
            'The label is in use',
            'This is the client label of the order’s shipment — void or replace the shipment instead; its file goes with it.',
          );
        }
      }
      const removed = await markRemovedInTx(tx, { row, removedBy: command.actorUserId, reason });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'shipping_file.removed',
        targetType: 'attachment',
        targetId: removed.id,
        reference: key,
        changes: { status: { before: row.status, after: 'removed' }, reason, purpose: row.purpose },
        occurredAt: nowIso(),
      });
      const snapshot: ShippingFileCommandSnapshot = { file: shippingFileSnapshotOf(removed) };
      await writeKeyInTx(tx, command.tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function requireFile(bytes: Buffer | undefined): Buffer {
  if (bytes === undefined || bytes.byteLength === 0) throw validation('A file is required (multipart field "file").');
  return bytes;
}

function assertDocumentableOrder(order: { status: string; id: string; clientOrderRef: string | null; externalEventId: string | null; followOnSeq: number | null; followOnRootOrderId: string | null }): void {
  if (order.status === 'cancelled') {
    throw new ProblemException('order-not-open', 409, 'Order is cancelled', `Order ${orderLabelOf(order)} is cancelled — it takes no shipping documents.`, { orderStatus: order.status });
  }
}

async function assertDocumentCap(tx: TenantTx, tenantId: string, orderId: string, source: 'web' | 'portal'): Promise<void> {
  const sources = source === 'portal' ? (['portal'] as const) : (['web', 'handheld'] as const);
  const max = source === 'portal' ? ORDER_DOCUMENTS_MAX_PORTAL : ORDER_DOCUMENTS_MAX_WAREHOUSE;
  const live = await countLiveByOwnerInTx(tx, { tenantId, ownerType: 'order', ownerId: orderId, purpose: 'shipping-document', sources });
  if (live >= max) {
    throw new ProblemException(
      'document-limit',
      409,
      'Document limit reached',
      `This order already holds ${live} ${source === 'portal' ? 'of your' : 'warehouse'} documents — at most ${max}. Remove one first.`,
    );
  }
}

async function assertSheetCap(tx: TenantTx, tenantId: string, handoverId: string): Promise<void> {
  const live = await countLiveByOwnerInTx(tx, { tenantId, ownerType: 'courier_handover', ownerId: handoverId, purpose: 'handover-sheet' });
  if (live >= HANDOVER_SHEET_MAX_PAGES) {
    throw new ProblemException(
      'handover-sheet-limit',
      409,
      'Signed sheet page limit reached',
      `This handover already holds ${live} signed-sheet pages — at most ${HANDOVER_SHEET_MAX_PAGES}. Remove one first.`,
    );
  }
}

/** The handover (404 when unknown), optionally `FOR UPDATE` (A46: the sheet cap under its lock). */
export async function readHandoverInTx(tx: TenantTx, tenantId: string, handoverId: string, lock: boolean): Promise<CourierHandover> {
  if (!UUID_RE.test(handoverId)) throw handoverNotFound(handoverId);
  const query = tx
    .select()
    .from(courierHandovers)
    .where(and(eq(courierHandovers.tenantId, tenantId), eq(courierHandovers.id, handoverId)))
    .limit(1);
  const rows = lock ? await query.for('update') : await query;
  if (rows[0] === undefined) throw handoverNotFound(handoverId);
  return rows[0];
}

function handoverNotFound(id: string): ProblemException {
  return new ProblemException('not-found', 404, 'Handover not found', `No courier handover with id "${id}" exists in this tenant.`);
}
