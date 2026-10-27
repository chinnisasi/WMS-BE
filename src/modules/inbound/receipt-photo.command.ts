import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/db/tokens';
import type { Database } from '../../shared/db/db';
import { auditEvents, goodsReceiptLines, goodsReceiptNotes, idempotencyKeys, type AttachmentRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { AttachmentsFacade, attachmentObjectKey, sanitizeImage, type SanitizedImage } from '../attachments/attachments.facade';
import {
  assertReservationLive,
  countDeviceStagedInTx,
  countLiveInTx,
  DEVICE_STAGED_PHOTO_CAP,
  finalizeDeviceUploadInTx,
  finalizeOwnedUploadInTx,
  listByParentInTx,
  lockAttachmentOfParentInTx,
  lockReservationInTx,
  markRemovedInTx,
  RECEIPT_PHOTOS_MAX_PER_LINE,
  RECEIPT_PHOTOS_MAX_PER_RECEIPT,
  reserveUploadInTx,
} from '../attachments/attachment-records';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn, memberDisplayNamesInTx } from '../tenancy/tenancy.service';
import type {
  DeviceUploadStatus,
  ReceiptPhotoStatus,
} from './receipt-photo.dto';

/**
 * Story 2-5a — damage photos on a goods-receipt line: the handheld's upload
 * (`uploadFromDevice`), the web's add and remove, and the staff read. The
 * bytes live behind the attachments module's file-store port; the rows go
 * through its seam (`attachment-records.ts`).
 *
 * Every upload is RESERVE → PUT → FINALIZE (IMPLEMENTATION-GUIDE §8): the
 * S3 put cannot roll back with a transaction, so Tx A writes an `uploading`
 * reservation, the put runs OUTSIDE every transaction, and Tx B finalizes
 * and writes the idempotency key. A put that never finalizes leaves a
 * reservation the sweep discards after an hour — never an unfindable
 * object. The order inside Tx A is the A18 order: authority → replay →
 * mode → (scope / staging cap) → the gate slot → sanitize → reserve, so a
 * replayed key never re-sanitizes (a later sanitizer cannot refuse a
 * committed op).
 */

/** The device's capture time is stored clamped to `[now − 60 d, now + 10 min]` (A28); the hash keeps the raw value. */
export const CAPTURED_AT_PAST_MS = 60 * 86_400_000;
export const CAPTURED_AT_FUTURE_MS = 10 * 60_000;

/** The command clock (the `rateCardClock` precedent) — assigned by tests. */
export const receiptPhotoClock = { now: (): number => Date.now() };

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const INSTANT_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export interface DeviceUploadCommand {
  readonly tenantId: string;
  readonly deviceId: string;
  /** The capturing operator (`x-op-operator`) — the photo's attribution, re-authorized per request. */
  readonly opOperator: string | undefined;
  /** The device's capture instant (ISO-8601, `Z`). */
  readonly capturedAt: string | undefined;
  readonly bytes: Buffer | undefined;
}

export interface DeviceUploadSnapshot {
  readonly ref: string;
  readonly status: DeviceUploadStatus;
}

export interface WebAddCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly grnId: string;
  readonly grnLineId: string;
  readonly bytes: Buffer | undefined;
}

export interface RemoveCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly grnId: string;
  readonly attachmentId: string;
  readonly reason: string;
}

export interface ReceiptPhotoView {
  readonly id: string;
  readonly grnLineId: string;
  readonly status: ReceiptPhotoStatus;
  readonly contentType: string | null;
  readonly byteSize: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly capturedAt: string | null;
  readonly uploadedAt: string | null;
  readonly source: 'handheld' | 'web';
  readonly removedAt?: string;
}

export interface ReceiptPhotoSnapshot {
  readonly attachment: ReceiptPhotoView;
}

export interface ReceiptPhotoListItem extends ReceiptPhotoView {
  readonly lineNo: number;
  readonly fileName: string;
  readonly url: string | null;
  readonly urlExpiresAt: string | null;
  readonly createdAt: string;
  readonly removedBy?: string;
  readonly removedByName?: string;
  readonly removedReason?: string;
}

export interface ReceiptPhotoList {
  readonly storageEnabled: boolean;
  readonly photos: readonly ReceiptPhotoListItem[];
}

@Injectable()
export class ReceiptPhotoCommand {
  private readonly logger = new Logger('ReceiptPhotoCommand');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AttachmentsFacade) private readonly attachments: AttachmentsFacade,
  ) {}

  /**
   * The handheld's photo op (`receipt-photo.stage`): one keyed multipart
   * request per photo, `Idempotency-Key` = the photo's ULID = its ref. Sent
   * with the DEVICE credential and `x-op-operator` (A7) — a photo moves no
   * stock, so it still uploads after its capturer badged out or another
   * operator badged in; the capturer is re-authorized (an active device, a
   * floor role) on every request and named on the audit row.
   */
  async uploadFromDevice(command: DeviceUploadCommand, ref: string): Promise<DeviceUploadSnapshot> {
    // ── 0. shape, above the transaction (400) ────────────────────────────
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
      surface: 'device-photo',
      deviceId: command.deviceId,
      opOperator,
      capturedAt: capturedAtRaw,
      rawSha256,
    });
    const capturedAt = clampCapturedAt(capturedAtRaw);

    // ── 1. Tx A: authority → replay → mode → staging cap → slot → sanitize → reserve
    const reserved = await this.reserve(
      command.tenantId,
      ref,
      payloadHash,
      async (tx) => {
        await assertDeviceOperatorInTx(tx, command.tenantId, command.deviceId, opOperator);
      },
      async (tx) => {
        const staged = await countDeviceStagedInTx(tx, command.tenantId, command.deviceId);
        if (staged >= DEVICE_STAGED_PHOTO_CAP) {
          throw new ProblemException(
            'attachment-staging-limit',
            429,
            'Too many photos waiting for their receipt',
            `This device has ${staged} photos waiting for their receipt (at most ${DEVICE_STAGED_PHOTO_CAP}) — sync its receipts first.`,
          );
        }
      },
      bytes,
      { source: 'handheld', deviceId: command.deviceId, createdBy: opOperator, capturedAt, rawSha256 },
    );
    if (reserved.kind === 'replayed') return reserved.snapshot as DeviceUploadSnapshot;

    // ── 3. Tx B: authority → lock → replay → live → ref lock → A2's table → audit → key
    return this.finalize<DeviceUploadSnapshot>(command.tenantId, ref, payloadHash, reserved.reservationId,
      async (tx) => {
        await assertDeviceOperatorInTx(tx, command.tenantId, command.deviceId, opOperator);
      },
      async (tx, reservation) => {
        const result = await finalizeDeviceUploadInTx(tx, { tenantId: command.tenantId, reservation, ref });
        const now = nowIso();
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: opOperator,
          action: 'receipt_photo.uploaded',
          targetType: 'attachment',
          targetId: result.row.id,
          reference: ref,
          changes: { arm: result.arm, deviceId: command.deviceId },
          occurredAt: now,
        });
        if (result.arm === 'filled') {
          await tx.insert(auditEvents).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            actorUserId: opOperator,
            action: 'receipt_photo.attached',
            targetType: 'attachment',
            targetId: result.row.id,
            reference: ref,
            changes: { grnId: result.row.ownerParentId, grnLineId: result.row.ownerId },
            occurredAt: now,
          });
        }
        await touchDeviceInTx(tx, command.deviceId);
        const status: DeviceUploadStatus =
          result.row.status === 'staged' ? 'staged' : result.row.status === 'removed' ? 'removed' : 'attached';
        return { ref, status };
      },
    );
  }

  /** The web's add (`receipt.attach`): a photo onto one GRN line, attached at finalize. */
  async addOnWeb(command: WebAddCommand, idempotencyKey: string): Promise<ReceiptPhotoSnapshot> {
    const bytes = requireFile(command.bytes);
    const rawSha256 = sha256Hex(bytes);
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      surface: 'web-photo',
      grnId: command.grnId,
      grnLineId: command.grnLineId,
      rawSha256,
    });
    const authorize = async (tx: TenantTx): Promise<void> => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'receipt.attach');
    };
    const reserved = await this.reserve(
      command.tenantId,
      idempotencyKey,
      payloadHash,
      authorize,
      async (tx) => {
        // Scope (404) and an early cap check (409), so a full line refuses
        // before any bytes are put; Tx B re-checks under the line lock.
        await loadGrnLineInTx(tx, command.tenantId, command.grnId, command.grnLineId, false);
        assertCaps(await countLiveInTx(tx, command.tenantId, command.grnId, command.grnLineId));
      },
      bytes,
      { source: 'web', deviceId: null, createdBy: command.actorUserId, capturedAt: null, rawSha256 },
    );
    if (reserved.kind === 'replayed') return reserved.snapshot as ReceiptPhotoSnapshot;

    return this.finalize<ReceiptPhotoSnapshot>(command.tenantId, idempotencyKey, payloadHash, reserved.reservationId, authorize,
      async (tx, reservation) => {
        const grn = await loadGrnLineInTx(tx, command.tenantId, command.grnId, command.grnLineId, true);
        assertCaps(await countLiveInTx(tx, command.tenantId, command.grnId, command.grnLineId));
        const row = await finalizeOwnedUploadInTx(tx, {
          reservation,
          ownerId: command.grnLineId,
          ownerParentId: command.grnId,
          clientId: grn.clientId,
          warehouseId: grn.warehouseId,
        });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'receipt_photo.added',
          targetType: 'attachment',
          targetId: row.id,
          reference: idempotencyKey,
          changes: { grnId: command.grnId, grnLineId: command.grnLineId },
          occurredAt: nowIso(),
        });
        return { attachment: photoView(row) };
      },
    );
  }

  /**
   * Remove (`receipt.photo-remove`, A20): an `attached` photo → `removed`
   * (soft — the row and its audit stay; the bytes are purged after
   * ATTACHMENT_PURGE_DAYS), or an `awaited` placeholder cancelled. A URL
   * issued before the removal works until it expires (≤ 300 s — accepted).
   */
  async remove(command: RemoveCommand, idempotencyKey: string): Promise<ReceiptPhotoSnapshot> {
    const reason = command.reason.trim();
    if (reason.length < 1 || [...reason].length > 200) {
      throw validation('reason must be 1–200 characters.');
    }
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      surface: 'web-photo-remove',
      grnId: command.grnId,
      attachmentId: command.attachmentId,
      reason,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'receipt.photo-remove');
      const first = await replayInTx(tx, command.tenantId, idempotencyKey, payloadHash);
      if (first !== null) return first as ReceiptPhotoSnapshot;
      const row = await lockAttachmentOfParentInTx(tx, command.tenantId, command.grnId, command.attachmentId);
      if (row === null) {
        throw new ProblemException('not-found', 404, 'Photo not found', `No photo "${command.attachmentId}" on goods receipt "${command.grnId}".`);
      }
      // The second replay, under the lock (guide §1) — a parked same-key
      // duplicate wakes to a removed row and must re-serve, not 409.
      const second = await replayInTx(tx, command.tenantId, idempotencyKey, payloadHash);
      if (second !== null) return second as ReceiptPhotoSnapshot;
      if (row.status !== 'attached' && row.status !== 'awaited') {
        throw new ProblemException(
          'attachment-not-attached',
          409,
          'Photo not removable',
          `This photo is ${row.status === 'removed' ? 'already removed' : row.status === 'expired' ? 'one that never arrived' : row.status} — nothing to remove.`,
        );
      }
      const removed = await markRemovedInTx(tx, { row, removedBy: command.actorUserId, reason });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'receipt_photo.removed',
        targetType: 'attachment',
        targetId: removed.id,
        reference: idempotencyKey,
        changes: { status: { before: row.status, after: 'removed' }, reason },
        occurredAt: nowIso(),
      });
      const snapshot: ReceiptPhotoSnapshot = { attachment: photoView(removed) };
      await writeKeyInTx(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * The staff read (any member): every live photo of the receipt plus the
   * newest removed/expired (A23), each with a short-lived presigned URL when
   * it holds bytes. Presigned AFTER the read transaction.
   */
  async listForGrn(tenantId: string, grnId: string): Promise<ReceiptPhotoList> {
    const read = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const grn = await tx
        .select({ id: goodsReceiptNotes.id, code: goodsReceiptNotes.code })
        .from(goodsReceiptNotes)
        .where(and(eq(goodsReceiptNotes.tenantId, tenantId), eq(goodsReceiptNotes.id, grnId)))
        .limit(1);
      if (grn[0] === undefined) {
        throw new ProblemException('not-found', 404, 'Goods receipt not found', `No goods receipt with id "${grnId}" exists in this tenant.`);
      }
      const lines = await tx
        .select({ id: goodsReceiptLines.id })
        .from(goodsReceiptLines)
        .where(and(eq(goodsReceiptLines.tenantId, tenantId), eq(goodsReceiptLines.grnId, grnId)))
        .orderBy(asc(goodsReceiptLines.createdAt), asc(goodsReceiptLines.id));
      const rows = await listByParentInTx(tx, { tenantId, grnId });
      const removers = rows.map((row) => row.removedBy).filter((id): id is string => id !== null);
      const names = removers.length === 0 ? new Map<string, string>() : await memberDisplayNamesInTx(tx, tenantId, removers);
      return { code: grn[0].code, lineNos: new Map(lines.map((line, index) => [line.id, index + 1])), rows, names };
    });
    const fileNames = receiptPhotoFileNames(read.code, read.lineNos, read.rows);
    // Presigned concurrently (one request may carry up to 100 photos).
    const signedUrls = await Promise.all(
      read.rows.map((row) => (row.status === 'attached' ? this.attachments.presign(row, fileNames.get(row.id)!) : Promise.resolve(null))),
    );
    const photos: ReceiptPhotoListItem[] = [];
    for (const [index, row] of read.rows.entries()) {
      const fileName = fileNames.get(row.id)!;
      const signed = signedUrls[index]!;
      photos.push({
        ...photoView(row),
        lineNo: read.lineNos.get(row.ownerId!) ?? 0,
        fileName,
        url: signed?.url ?? null,
        urlExpiresAt: signed?.expiresAt ?? null,
        createdAt: canonicalInstant(row.createdAt),
        ...(row.removedBy === null ? {} : { removedBy: row.removedBy }),
        ...(row.removedBy === null || !read.names.has(row.removedBy) ? {} : { removedByName: read.names.get(row.removedBy)! }),
        ...(row.removedReason === null ? {} : { removedReason: row.removedReason }),
      });
    }
    return { storageEnabled: this.attachments.storageEnabled, photos };
  }

  // ── the shared reserve → put → finalize ─────────────────────────────────

  private async reserve(
    tenantId: string,
    key: string,
    payloadHash: string,
    authorize: (tx: TenantTx) => Promise<void>,
    scope: (tx: TenantTx) => Promise<void>,
    bytes: Buffer,
    origin: {
      readonly source: 'handheld' | 'web';
      readonly deviceId: string | null;
      readonly createdBy: string;
      readonly capturedAt: string | null;
      readonly rawSha256: string;
    },
  ): Promise<{ kind: 'replayed'; snapshot: unknown } | { kind: 'reserved'; reservationId: string }> {
    let release: (() => void) | null = null;
    try {
      const phaseA = await withTenantTransaction(this.db, tenantId, async (tx) => {
        await authorize(tx);
        const replayed = await replayInTx(tx, tenantId, key, payloadHash);
        if (replayed !== null) return { kind: 'replayed' as const, snapshot: replayed };
        if (!this.attachments.storageEnabled) {
          throw new ProblemException(
            'file-storage-unavailable',
            503,
            'File storage is not configured',
            'Photo storage is not configured on this server (FILE_STORE=none) — the photo cannot be stored.',
          );
        }
        await scope(tx);
        // A16 — held from here until the put returns (released in `finally`).
        release = this.attachments.uploadGate.acquire();
        const clean: SanitizedImage = sanitizeImage(bytes);
        const reservation = await reserveUploadInTx(tx, {
          tenantId,
          purpose: 'receipt-damage',
          source: origin.source,
          uploadKey: key,
          uploadHash: payloadHash,
          rawSha256: origin.rawSha256,
          deviceId: origin.deviceId,
          createdBy: origin.createdBy,
          capturedAt: origin.capturedAt,
          objectKeyOf: (id) => attachmentObjectKey(tenantId, id),
          object: {
            contentType: clean.contentType,
            byteSize: clean.bytes.byteLength,
            sha256: sha256Hex(clean.bytes),
            width: clean.width,
            height: clean.height,
          },
        });
        return { kind: 'reserved' as const, reservation, clean };
      });
      if (phaseA.kind === 'replayed') return phaseA;

      // ── 2. the put, OUTSIDE every transaction ──────────────────────────
      try {
        await this.attachments.fileStore.put({
          key: phaseA.reservation.objectKey!,
          bytes: phaseA.clean.bytes,
          contentType: phaseA.clean.contentType,
        });
      } catch (err) {
        this.logger.error(`put of attachment ${phaseA.reservation.id} (tenant ${tenantId}) failed: ${err instanceof Error ? err.message : String(err)}`);
        throw new ProblemException(
          'file-storage-failed',
          503,
          'File storage failed',
          'The photo could not be stored right now — send it again.',
        );
      }
      return { kind: 'reserved', reservationId: phaseA.reservation.id };
    } finally {
      (release as (() => void) | null)?.();
    }
  }

  private async finalize<S>(
    tenantId: string,
    key: string,
    payloadHash: string,
    reservationId: string,
    authorize: (tx: TenantTx) => Promise<void>,
    body: (tx: TenantTx, reservation: AttachmentRow) => Promise<S>,
  ): Promise<S> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await authorize(tx);
      const locked = await lockReservationInTx(tx, tenantId, reservationId);
      // The replay UNDER the lock (guide §1): a same-key duplicate parked on
      // the reservation wakes to a finalized (or deleted) row and re-serves.
      const replayed = await replayInTx(tx, tenantId, key, payloadHash);
      if (replayed !== null) return replayed as S;
      const reservation = assertReservationLive(locked);
      const snapshot = await body(tx, reservation);
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function validation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid photo upload', detail);
}

function requireFile(bytes: Buffer | undefined): Buffer {
  if (bytes === undefined || bytes.byteLength === 0) {
    throw validation('A photo file is required (multipart field "file").');
  }
  return bytes;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A28 — the stored capture time, clamped to `[now − 60 d, now + 10 min]`. */
export function clampCapturedAt(raw: string): string {
  const now = receiptPhotoClock.now();
  const at = Date.parse(raw);
  return new Date(Math.min(Math.max(at, now - CAPTURED_AT_PAST_MS), now + CAPTURED_AT_FUTURE_MS)).toISOString();
}

function assertCaps(counts: { readonly line: number; readonly receipt: number }): void {
  if (counts.line >= RECEIPT_PHOTOS_MAX_PER_LINE) {
    throw new ProblemException(
      'attachment-limit-reached',
      409,
      'Photo limit reached',
      `This line already holds ${counts.line} photos — at most ${RECEIPT_PHOTOS_MAX_PER_LINE} per line. Remove one first.`,
    );
  }
  if (counts.receipt >= RECEIPT_PHOTOS_MAX_PER_RECEIPT) {
    throw new ProblemException(
      'attachment-limit-reached',
      409,
      'Photo limit reached',
      `This receipt already holds ${counts.receipt} photos — at most ${RECEIPT_PHOTOS_MAX_PER_RECEIPT} per receipt. Remove one first.`,
    );
  }
}

async function loadGrnLineInTx(
  tx: TenantTx,
  tenantId: string,
  grnId: string,
  grnLineId: string,
  lock: boolean,
): Promise<{ clientId: string | null; warehouseId: string }> {
  // Locked (Tx B): the RECEIPT row first, then the line — the receipt cap
  // (50) spans lines, so two adds on different lines must serialise on it.
  const header = tx
    .select({ clientId: goodsReceiptNotes.clientId, warehouseId: goodsReceiptNotes.warehouseId })
    .from(goodsReceiptNotes)
    .where(and(eq(goodsReceiptNotes.tenantId, tenantId), eq(goodsReceiptNotes.id, grnId)))
    .limit(1);
  const grn = lock ? await header.for('update') : await header;
  const query = tx
    .select({ id: goodsReceiptLines.id })
    .from(goodsReceiptLines)
    .where(and(eq(goodsReceiptLines.tenantId, tenantId), eq(goodsReceiptLines.grnId, grnId), eq(goodsReceiptLines.id, grnLineId)))
    .limit(1);
  const line = grn[0] === undefined ? [] : lock ? await query.for('update') : await query;
  if (grn[0] === undefined || line[0] === undefined) {
    throw new ProblemException(
      'not-found',
      404,
      'Goods receipt line not found',
      `No line "${grnLineId}" on goods receipt "${grnId}" in this tenant.`,
    );
  }
  return grn[0];
}

async function replayInTx(tx: TenantTx, tenantId: string, key: string, payloadHash: string): Promise<unknown> {
  const existing = await tx
    .select({ payloadHash: idempotencyKeys.payloadHash, responseSnapshot: idempotencyKeys.responseSnapshot })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
    .limit(1);
  if (!existing[0]) return null;
  if (existing[0].payloadHash !== payloadHash) {
    throw new ProblemException(
      'idempotency-key-reuse',
      422,
      'Idempotency key reused with a different payload',
      'This Idempotency-Key was already used for a different request.',
    );
  }
  return existing[0].responseSnapshot;
}

async function writeKeyInTx(tx: TenantTx, tenantId: string, key: string, payloadHash: string, snapshot: unknown): Promise<void> {
  try {
    await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key, payloadHash, responseSnapshot: snapshot });
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

/** The stored-snapshot view of one photo — no URL, ever (A14). */
export function photoView(row: AttachmentRow): ReceiptPhotoView {
  return {
    id: row.id,
    grnLineId: row.ownerId!,
    status: row.status as ReceiptPhotoStatus,
    contentType: row.contentType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    capturedAt: row.capturedAt === null ? null : canonicalInstant(row.capturedAt),
    uploadedAt: row.uploadedAt === null ? null : canonicalInstant(row.uploadedAt),
    source: row.source as 'handheld' | 'web',
    ...(row.removedAt === null ? {} : { removedAt: canonicalInstant(row.removedAt) }),
  };
}

const EXTENSIONS: Readonly<Record<string, string>> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * A14 — the server-built file name of every photo, `<grnCode>-L<lineNo>-<k>.<ext>`:
 * k counts the line's photos in creation order (1-based). ASCII only; never
 * the uploader's file name.
 */
export function receiptPhotoFileNames(
  grnCode: string,
  lineNos: ReadonlyMap<string, number>,
  rows: readonly Pick<AttachmentRow, 'id' | 'ownerId' | 'createdAt' | 'contentType'>[],
): Map<string, string> {
  const byLine = new Map<string, Pick<AttachmentRow, 'id' | 'ownerId' | 'createdAt' | 'contentType'>[]>();
  for (const row of rows) {
    const list = byLine.get(row.ownerId ?? '') ?? [];
    list.push(row);
    byLine.set(row.ownerId ?? '', list);
  }
  const out = new Map<string, string>();
  for (const [lineId, list] of byLine) {
    const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    sorted.forEach((row, index) => {
      const ext = row.contentType === null ? 'jpg' : (EXTENSIONS[row.contentType] ?? 'bin');
      out.set(row.id, `${grnCode}-L${lineNos.get(lineId) ?? 0}-${index + 1}.${ext}`.replace(/[^A-Za-z0-9._-]/g, '_'));
    });
  }
  return out;
}
