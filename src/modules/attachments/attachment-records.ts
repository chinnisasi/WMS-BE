import { and, asc, desc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { attachments, auditEvents, type AttachmentRow } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * Story 2-5a — the attachments seam: every write to `attachments` outside the
 * sweep, as free functions over the CALLER's transaction. It imports only
 * `drizzle-orm` and `shared/` (IMPLEMENTATION-GUIDE §7h), so the inbound
 * module's receipt command and `grn.submit`'s claim import it without
 * dragging a module graph (pinned by `test/architecture.spec.ts`).
 *
 * Two serialisation rules every caller relies on:
 *  - **The ref lock (A1).** A handheld photo's ref (its ULID) is read and
 *    written only under `pg_advisory_xact_lock(hashtext('attachment-ref:' ||
 *    tenant), hashtext(ref))`, taken BEFORE the ref's row is read — by the
 *    upload's final transaction and by the receipt's claim (refs sorted), so
 *    the two binding orders cannot interleave.
 *  - **Partial unique conflicts (A6).** Every insert against a partial
 *    unique index names the index's predicate in
 *    `onConflictDoNothing({ target, where })` (the `pack.command.ts`
 *    precedent) — Postgres infers a partial index only from its predicate.
 */

export const ATTACHMENT_PURPOSES = ['receipt-damage'] as const;
export type AttachmentPurpose = (typeof ATTACHMENT_PURPOSES)[number];

export const ATTACHMENT_STATUSES = [
  'uploading',
  'staged',
  'awaited',
  'attached',
  'removed',
  'expired',
  'discarded',
] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

export const ATTACHMENT_SOURCES = ['handheld', 'web'] as const;
export type AttachmentSource = (typeof ATTACHMENT_SOURCES)[number];

export const ATTACHMENT_OWNER_TYPES = ['goods_receipt_line'] as const;

/** The statuses that count toward a line's and a receipt's photo cap (K21: a staged row has no line yet). */
export const LIVE_ATTACHMENT_STATUSES = ['attached', 'awaited'] as const satisfies readonly AttachmentStatus[];

/** A8 — at most this many live photos (`attached` + `awaited`) per receipt line. */
export const RECEIPT_PHOTOS_MAX_PER_LINE = 10;
/** A5 — at most this many live photos per receipt. */
export const RECEIPT_PHOTOS_MAX_PER_RECEIPT = 50;
/** A16 — at most this many unbound `staged` photos per device. */
export const DEVICE_STAGED_PHOTO_CAP = 200;
/** A23 — the list returns every live row plus at most this many of the newest `removed`/`expired`. */
export const ATTACHMENT_HISTORY_LIMIT = 50;

/** The stored object a reservation carries (sanitized bytes). */
export interface StoredObject {
  readonly objectKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

/** A1 — the per-ref advisory lock, in the caller's transaction (released at commit/rollback). */
export async function lockAttachmentRefInTx(tx: TenantTx, tenantId: string, ref: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${'attachment-ref:' + tenantId}), hashtext(${ref}))`,
  );
}

/** The ref's LIVE row (any status but `discarded` — a discarded row keeps its ref as history), locked. */
async function lockRefRowInTx(tx: TenantTx, tenantId: string, ref: string): Promise<AttachmentRow | null> {
  const rows = await tx
    .select()
    .from(attachments)
    .where(and(eq(attachments.tenantId, tenantId), eq(attachments.clientRef, ref), ne(attachments.status, 'discarded')))
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

export interface ReserveUploadInput {
  readonly tenantId: string;
  readonly purpose: AttachmentPurpose;
  readonly source: AttachmentSource;
  readonly uploadKey: string;
  readonly uploadHash: string;
  readonly rawSha256: string;
  readonly deviceId: string | null;
  readonly createdBy: string | null;
  readonly capturedAt: string | null;
  /** Builds the object key from the reservation's id. */
  readonly objectKeyOf: (attachmentId: string) => string;
  readonly object: Omit<StoredObject, 'objectKey'>;
}

/**
 * The reservation (Design Notes step 1.8): an `uploading` row — owner null,
 * no `client_ref` (A1) — written BEFORE the put, so an object whose finalize
 * never ran is always findable by the sweep without listing the bucket. A
 * concurrent same-key request conflicts on `(tenant_id, upload_key) WHERE
 * status = 'uploading'`: the existing reservation is reused when its
 * `upload_hash` matches (both put identical bytes to the same key — an
 * idempotent overwrite), otherwise 422 `idempotency-key-reuse`.
 */
export async function reserveUploadInTx(tx: TenantTx, input: ReserveUploadInput): Promise<AttachmentRow> {
  const id = uuidv7();
  const now = nowIso();
  const inserted = await tx
    .insert(attachments)
    .values({
      id,
      tenantId: input.tenantId,
      purpose: input.purpose,
      status: 'uploading',
      source: input.source,
      uploadKey: input.uploadKey,
      uploadHash: input.uploadHash,
      rawSha256: input.rawSha256,
      objectKey: input.objectKeyOf(id),
      contentType: input.object.contentType,
      byteSize: input.object.byteSize,
      sha256: input.object.sha256,
      width: input.object.width,
      height: input.object.height,
      capturedAt: input.capturedAt,
      deviceId: input.deviceId,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [attachments.tenantId, attachments.uploadKey],
      where: sql`status = 'uploading'`,
    })
    .returning();
  if (inserted[0]) return inserted[0];
  const existing = await tx
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.tenantId, input.tenantId),
        eq(attachments.uploadKey, input.uploadKey),
        eq(attachments.status, 'uploading'),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (!row) {
    // The conflicting reservation finalized between the insert and this read:
    // its key committed — the retry replays it.
    throw concurrentRequest();
  }
  if (row.uploadHash !== input.uploadHash) {
    throw new ProblemException(
      'idempotency-key-reuse',
      422,
      'Idempotency key reused with a different payload',
      'This Idempotency-Key is already in use for a different upload.',
    );
  }
  return row;
}

/**
 * Locks the reservation for its finalize (Design Notes step 3.3) — LOCK ONLY
 * (guide §1, the `loadOpenPo` lesson): a same-key duplicate parked here wakes
 * to a finalized (or deleted) row, and must reach its replay lookup before
 * any status check. Null when the row is gone.
 */
export async function lockReservationInTx(tx: TenantTx, tenantId: string, reservationId: string): Promise<AttachmentRow | null> {
  const rows = await tx
    .select()
    .from(attachments)
    .where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, reservationId)))
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

/** After the replay under the lock: a reservation the sweep discarded, or one that is gone, is 503 `file-storage-failed` (A10). */
export function assertReservationLive(row: AttachmentRow | null): AttachmentRow {
  if (row === null || row.status !== 'uploading') {
    throw new ProblemException(
      'file-storage-failed',
      503,
      'File storage failed',
      'The upload was interrupted before it was recorded — send it again.',
    );
  }
  return row;
}

export type DeviceFinalizeArm = 'staged' | 'filled' | 'replayed';

export interface DeviceFinalizeResult {
  readonly arm: DeviceFinalizeArm;
  /** The row the photo now lives on (the staged reservation, the filled placeholder, or the existing row). */
  readonly row: AttachmentRow;
}

/**
 * The handheld upload's final transaction body (A2's table), under the ref
 * lock, with the reservation already locked by `lockReservationInTx`:
 *
 * | Ref row | Effect |
 * |---|---|
 * | none (or only a `discarded` one) | the reservation becomes `staged` and takes the ref |
 * | `awaited` / `expired` | FILL: the reservation is deleted first (its object key moves), the placeholder takes the object → `attached` |
 * | `removed` with no object (a cancelled placeholder) | `replayed`: the reservation is `discarded`; answered `removed` |
 * | `attached` / `removed` / `staged`, same raw bytes | `replayed`: the reservation is `discarded` (the sweep deletes its duplicate object) |
 * | the same, other bytes | 409 `attachment-ref-conflict` |
 */
export async function finalizeDeviceUploadInTx(
  tx: TenantTx,
  input: { readonly tenantId: string; readonly reservation: AttachmentRow; readonly ref: string },
): Promise<DeviceFinalizeResult> {
  const { tenantId, reservation, ref } = input;
  await lockAttachmentRefInTx(tx, tenantId, ref);
  const existing = await lockRefRowInTx(tx, tenantId, ref);
  const now = nowIso();
  if (existing === null) {
    const [row] = await tx
      .update(attachments)
      .set({ status: 'staged', clientRef: ref, uploadedAt: now, updatedAt: now })
      .where(and(eq(attachments.id, reservation.id), eq(attachments.status, 'uploading')))
      .returning();
    return { arm: 'staged', row: row! };
  }
  if (existing.status === 'awaited' || existing.status === 'expired') {
    // A9's unique live object key: the reservation goes first, then its object moves.
    await tx.delete(attachments).where(and(eq(attachments.id, reservation.id), eq(attachments.status, 'uploading')));
    const [row] = await tx
      .update(attachments)
      .set({
        status: 'attached',
        objectKey: reservation.objectKey,
        contentType: reservation.contentType,
        byteSize: reservation.byteSize,
        sha256: reservation.sha256,
        width: reservation.width,
        height: reservation.height,
        rawSha256: reservation.rawSha256,
        uploadKey: reservation.uploadKey,
        uploadHash: reservation.uploadHash,
        capturedAt: reservation.capturedAt,
        // The photo's attribution: the capturing operator and device (the
        // placeholder named the receipt's), as on a staged row.
        createdBy: reservation.createdBy,
        deviceId: reservation.deviceId,
        uploadedAt: now,
        updatedAt: now,
      })
      .where(and(eq(attachments.id, existing.id), inArray(attachments.status, ['awaited', 'expired'])))
      .returning();
    return { arm: 'filled', row: row! };
  }
  if (existing.status === 'removed' && existing.objectKey === null) {
    // A placeholder a manager CANCELLED before its photo arrived (A20): the
    // late upload is answered `removed` and stored nowhere — the reservation
    // is discarded (the sweep deletes its bytes). Never a ref conflict.
    await tx
      .update(attachments)
      .set({ status: 'discarded', updatedAt: now })
      .where(and(eq(attachments.id, reservation.id), eq(attachments.status, 'uploading')));
    return { arm: 'replayed', row: existing };
  }
  if (existing.status === 'attached' || existing.status === 'removed' || existing.status === 'staged') {
    if (existing.rawSha256 !== null && existing.rawSha256 === reservation.rawSha256) {
      await tx
        .update(attachments)
        .set({ status: 'discarded', updatedAt: now })
        .where(and(eq(attachments.id, reservation.id), eq(attachments.status, 'uploading')));
      return { arm: 'replayed', row: existing };
    }
    throw new ProblemException(
      'attachment-ref-conflict',
      409,
      'Photo reference already used',
      `Photo ${ref} is already stored with different bytes — the device sent two photos under one reference.`,
    );
  }
  // `uploading` never carries a ref (CHECK attachments_uploading_no_ref) and
  // `discarded` is excluded by the read — an allow-list, so a new status fails loudly.
  throw new Error(`attachment ${existing.id} has status ${existing.status}, which the device finalize does not know`);
}

/**
 * The web add's finalize: the reservation BECOMES the row — `attached`, with
 * its owner, the GRN's client and warehouse (set here, never at reserve —
 * A13: an `uploading` row is unowned).
 */
export async function finalizeOwnedUploadInTx(
  tx: TenantTx,
  input: {
    readonly reservation: AttachmentRow;
    readonly ownerId: string;
    readonly ownerParentId: string;
    readonly clientId: string | null;
    readonly warehouseId: string;
  },
): Promise<AttachmentRow> {
  const now = nowIso();
  const [row] = await tx
    .update(attachments)
    .set({
      status: 'attached',
      ownerType: 'goods_receipt_line',
      ownerId: input.ownerId,
      ownerParentId: input.ownerParentId,
      clientId: input.clientId,
      warehouseId: input.warehouseId,
      uploadedAt: now,
      updatedAt: now,
    })
    .where(and(eq(attachments.id, input.reservation.id), eq(attachments.status, 'uploading')))
    .returning();
  return row!;
}

/** The live count (`attached` + `awaited`) of one line and of its receipt. */
export async function countLiveInTx(
  tx: TenantTx,
  tenantId: string,
  grnId: string,
  grnLineId: string,
): Promise<{ readonly line: number; readonly receipt: number }> {
  const rows = await tx
    .select({
      receipt: sql<number>`count(*)::int`,
      line: sql<number>`(count(*) filter (where ${attachments.ownerId} = ${grnLineId}))::int`,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.tenantId, tenantId),
        eq(attachments.ownerParentId, grnId),
        inArray(attachments.status, [...LIVE_ATTACHMENT_STATUSES]),
      ),
    );
  return { line: Number(rows[0]?.line ?? 0), receipt: Number(rows[0]?.receipt ?? 0) };
}

/** A16 — the device's unbound `staged` count (the partial index `attachments_tenant_device_staged_idx`). */
export async function countDeviceStagedInTx(tx: TenantTx, tenantId: string, deviceId: string): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(attachments)
    .where(and(eq(attachments.tenantId, tenantId), eq(attachments.deviceId, deviceId), eq(attachments.status, 'staged')));
  return Number(rows[0]?.n ?? 0);
}

export interface ClaimLine {
  readonly grnLineId: string;
  /** The line's refs in capture order (validated ULIDs, unique across the receipt). */
  readonly refs: readonly string[];
}

export interface ClaimResult {
  /** Refs that now await their upload (a placeholder was written). */
  readonly awaited: readonly string[];
  /** Refs whose staged row this receipt attached. */
  readonly attached: readonly string[];
  /** Refs not bound: unknown to this device, already bound elsewhere, or another device's. */
  readonly skipped: readonly string[];
}

/**
 * The receipt's claim (A1, A17, A25, A27), inside `grn.submit` immediately
 * before its outbox append — after every ledger append, so the ref locks are
 * the LAST locks the receipt takes. Refs sorted for the lock order. Per ref:
 * insert an `awaited` placeholder (owner = the line, the GRN's client and
 * warehouse) ON CONFLICT DO NOTHING; when a live row exists, lock it — a
 * `staged` row of THIS device is attached, anything else is skipped. A ref is
 * never a refusal: the receipt books exactly as it would without it.
 */
export async function claimRefsInTx(
  tx: TenantTx,
  input: {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly grnId: string;
    readonly clientId: string | null;
    readonly warehouseId: string;
    readonly actorUserId: string;
    readonly reference: string;
    readonly lines: readonly ClaimLine[];
  },
): Promise<ClaimResult> {
  const lineOf = new Map<string, string>();
  for (const line of input.lines) for (const ref of line.refs) lineOf.set(ref, line.grnLineId);
  const refs = [...lineOf.keys()].sort();
  const awaited: string[] = [];
  const attached: string[] = [];
  const skipped: string[] = [];
  if (refs.length === 0) return { awaited, attached, skipped };
  for (const ref of refs) {
    await lockAttachmentRefInTx(tx, input.tenantId, ref);
  }
  const now = nowIso();
  for (const ref of refs) {
    const grnLineId = lineOf.get(ref)!;
    const inserted = await tx
      .insert(attachments)
      .values({
        id: uuidv7(),
        tenantId: input.tenantId,
        clientId: input.clientId,
        warehouseId: input.warehouseId,
        purpose: 'receipt-damage',
        status: 'awaited',
        source: 'handheld',
        ownerType: 'goods_receipt_line',
        ownerId: grnLineId,
        ownerParentId: input.grnId,
        clientRef: ref,
        deviceId: input.deviceId,
        createdBy: input.actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [attachments.tenantId, attachments.clientRef],
        where: sql`client_ref is not null and status <> 'discarded'`,
      })
      .returning({ id: attachments.id });
    if (inserted[0]) {
      awaited.push(ref);
      continue;
    }
    const row = await lockRefRowInTx(tx, input.tenantId, ref);
    if (row !== null && row.status === 'staged' && row.deviceId === input.deviceId) {
      await tx
        .update(attachments)
        .set({
          status: 'attached',
          ownerType: 'goods_receipt_line',
          ownerId: grnLineId,
          ownerParentId: input.grnId,
          clientId: input.clientId,
          warehouseId: input.warehouseId,
          updatedAt: now,
        })
        .where(and(eq(attachments.id, row.id), eq(attachments.status, 'staged')));
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'receipt_photo.attached',
        targetType: 'attachment',
        targetId: row.id,
        reference: input.reference,
        changes: { grnId: input.grnId, grnLineId },
        occurredAt: now,
      });
      attached.push(ref);
      continue;
    }
    skipped.push(ref);
  }
  if (skipped.length > 0) {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'receipt_photo.ref-skipped',
      targetType: 'goods_receipt',
      targetId: input.grnId,
      reference: input.reference,
      changes: { skippedRefs: skipped },
      occurredAt: now,
    });
  }
  return { awaited, attached, skipped };
}

/**
 * A23 — one receipt's photos: every live row (`attached`/`awaited`, ≤ 50 by
 * the caps) plus at most the 50 newest `removed`/`expired`. With `clientId`
 * (the portal), an explicit `client_id = $client` predicate as well as the
 * caller's stamp (guide §7e — two layers).
 */
export async function listByParentInTx(
  tx: TenantTx,
  input: { readonly tenantId: string; readonly grnId: string; readonly clientId?: string },
): Promise<AttachmentRow[]> {
  const scope = and(
    eq(attachments.tenantId, input.tenantId),
    eq(attachments.ownerParentId, input.grnId),
    ...(input.clientId === undefined ? [] : [eq(attachments.clientId, input.clientId)]),
  );
  const live = await tx
    .select()
    .from(attachments)
    .where(and(scope, inArray(attachments.status, [...LIVE_ATTACHMENT_STATUSES])))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  const history = await tx
    .select()
    .from(attachments)
    .where(and(scope, inArray(attachments.status, ['removed', 'expired'])))
    .orderBy(desc(attachments.updatedAt), desc(attachments.id))
    .limit(ATTACHMENT_HISTORY_LIMIT);
  return [...live, ...history.reverse()];
}

/**
 * Per-line live and awaited counts for a set of receipts (the lines read and
 * the GRN list rows). Story 2-9a (A13) — an optional `clientId` adds
 * `attachments.client_id = $client` (the portal and mail copies of the GRN
 * document pass it); omitted, the read is unchanged.
 */
export async function photoCountsByParentInTx(
  tx: TenantTx,
  tenantId: string,
  grnIds: readonly string[],
  clientId?: string,
): Promise<Map<string, { photoCount: number; pendingPhotoCount: number; byLine: Map<string, { photoCount: number; pendingPhotoCount: number }> }>> {
  const out = new Map<string, { photoCount: number; pendingPhotoCount: number; byLine: Map<string, { photoCount: number; pendingPhotoCount: number }> }>();
  if (grnIds.length === 0) return out;
  const rows = await tx
    .select({
      grnId: attachments.ownerParentId,
      lineId: attachments.ownerId,
      attached: sql<number>`(count(*) filter (where ${attachments.status} = 'attached'))::int`,
      awaited: sql<number>`(count(*) filter (where ${attachments.status} = 'awaited'))::int`,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.tenantId, tenantId),
        inArray(attachments.ownerParentId, [...grnIds]),
        inArray(attachments.status, [...LIVE_ATTACHMENT_STATUSES]),
        ...(clientId === undefined ? [] : [eq(attachments.clientId, clientId)]),
      ),
    )
    .groupBy(attachments.ownerParentId, attachments.ownerId);
  for (const row of rows) {
    if (row.grnId === null || row.lineId === null) continue;
    const entry = out.get(row.grnId) ?? { photoCount: 0, pendingPhotoCount: 0, byLine: new Map() };
    const attachedCount = Number(row.attached);
    const awaitedCount = Number(row.awaited);
    entry.photoCount += attachedCount;
    entry.pendingPhotoCount += awaitedCount;
    entry.byLine.set(row.lineId, { photoCount: attachedCount, pendingPhotoCount: awaitedCount });
    out.set(row.grnId, entry);
  }
  return out;
}

/** Locks one receipt photo by id within its receipt (404 when absent). */
export async function lockAttachmentOfParentInTx(
  tx: TenantTx,
  tenantId: string,
  grnId: string,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  const rows = await tx
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.tenantId, tenantId),
        eq(attachments.id, attachmentId),
        eq(attachments.ownerParentId, grnId),
        notInArray(attachments.status, ['uploading', 'staged', 'discarded']),
      ),
    )
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A20 — soft removal: an `attached` row → `removed` (its bytes purged after
 * ATTACHMENT_PURGE_DAYS by the sweep), or an `awaited` one cancelled →
 * `removed` with no object. Conditional on the status the caller checked.
 */
export async function markRemovedInTx(
  tx: TenantTx,
  input: { readonly row: AttachmentRow; readonly removedBy: string; readonly reason: string },
): Promise<AttachmentRow> {
  const now = nowIso();
  const [row] = await tx
    .update(attachments)
    .set({ status: 'removed', removedBy: input.removedBy, removedAt: now, removedReason: input.reason, updatedAt: now })
    .where(and(eq(attachments.id, input.row.id), inArray(attachments.status, ['attached', 'awaited'])))
    .returning();
  return row!;
}

function concurrentRequest(): ProblemException {
  return new ProblemException('conflict', 409, 'Concurrent idempotent request', 'A request with this Idempotency-Key is in progress — retry it.');
}
