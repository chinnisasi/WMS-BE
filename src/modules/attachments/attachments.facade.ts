import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/db/tokens';
import type { Database } from '../../shared/db/db';
import { attachments, auditEvents, type AttachmentRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { SYSTEM_ACTOR_ID } from '../../shared/primitives/audit';
import { uuidv7 } from '../../shared/primitives/ids';
import { FILE_STORE, s3ErrorCode, type FileStore, type PresignedUrl } from './file-store';
import { UploadGate } from './upload-gate';

export { FILE_STORE, attachmentObjectKey, type FileStore, type FileStoreMode, type PresignedUrl } from './file-store';
export { sanitizeImage, sniffImageType, MAX_IMAGE_BYTES, ATTACHMENT_IMAGE_TYPES, type SanitizedImage } from './image-sanitize';
export { UploadGate } from './upload-gate';

/** The default bytes-retention after removal, and the age of an unbound or awaited photo (A10). */
export const DEFAULT_ATTACHMENT_PURGE_DAYS = 30;
export const MAX_ATTACHMENT_PURGE_DAYS = 3650;
/** A10 — an `uploading` reservation older than this is discarded (its put never finalized). */
export const UPLOADING_MAX_AGE_MS = 60 * 60 * 1000;
/** Decision 9 — at most this many rows per arm per tenant per tick. */
export const ATTACHMENT_SWEEP_BATCH = 100;

/** `ATTACHMENT_PURGE_DAYS` — a positive integer of days ≤ 3,650; default 30. */
export function parseAttachmentPurgeDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ATTACHMENT_PURGE_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_ATTACHMENT_PURGE_DAYS) {
    throw new Error(`ATTACHMENT_PURGE_DAYS must be a positive integer of days, at most ${MAX_ATTACHMENT_PURGE_DAYS} (got "${raw}")`);
  }
  return parsed;
}

export interface AttachmentSweepSummary {
  /** `uploading` reservations discarded (their put never finalized). */
  readonly discardedUploading: number;
  /** Unbound `staged` photos discarded. */
  readonly discardedStaged: number;
  /** `awaited` placeholders that became `expired`. */
  readonly expired: number;
  /** Rows whose bytes were deleted (`purged_at` set). */
  readonly purged: number;
  /** Deletes that failed — the row keeps `purged_at` null and is retried next tick. */
  readonly deleteFailures: number;
  /** Staged photos kept because an open review row still names them (K11). */
  readonly keptReferenced: number;
}

/**
 * Story 2-5a — the attachments module's face: the file-store port (a public
 * FIELD — the e2e suites assign an in-memory fake, the
 * `LEDGER_ANCHOR_WORM_STORE` precedent), the process-wide upload gate (A16),
 * the presigned reads, and the retention sweep (A10). Every other write to
 * `attachments` is the free-function seam `attachment-records.ts`.
 */
@Injectable()
export class AttachmentsFacade {
  private readonly logger = new Logger('AttachmentsFacade');
  /** The port. Assigned by tests; read on every call, never cached elsewhere. */
  fileStore: FileStore;
  /** A16 — at most 4 uploads hold their bytes at once, process-wide. */
  readonly uploadGate = new UploadGate();
  /** A10 — the purge age in days (`ATTACHMENT_PURGE_DAYS`). A plain field: tests shrink it. */
  purgeDays: number;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FILE_STORE) fileStore: FileStore,
  ) {
    this.fileStore = fileStore;
    this.purgeDays = parseAttachmentPurgeDays(process.env.ATTACHMENT_PURGE_DAYS);
  }

  /** `false` under `FILE_STORE=none` — uploads 503, the device hides the camera, reads list no URLs. */
  get storageEnabled(): boolean {
    return this.fileStore.mode !== 'none';
  }

  /**
   * A presigned GET for a row that holds bytes, or null (no store, no object,
   * or the presign failed — logged; a read never fails because a URL could
   * not be signed).
   */
  async presign(row: Pick<AttachmentRow, 'id' | 'objectKey' | 'contentType' | 'purgedAt'>, filename: string): Promise<PresignedUrl | null> {
    if (!this.storageEnabled || row.objectKey === null || row.contentType === null || row.purgedAt !== null) return null;
    try {
      return await this.fileStore.presignGet({ key: row.objectKey, contentType: row.contentType, filename });
    } catch (err) {
      this.logger.error(`presign of attachment ${row.id} failed (${s3ErrorCode(err)})`);
      return null;
    }
  }

  /**
   * One tenant's retention sweep (A10). Per arm: claim ≤ 100 rows `FOR UPDATE
   * SKIP LOCKED`, re-check status and age, move them to their terminal state
   * and COMMIT; then delete the bytes outside any transaction; then set
   * `purged_at` in a second short transaction. A delete that fails leaves
   * `purged_at` null, is pushed to the back of the queue (`updated_at`
   * touched) and retried next tick. Safe to run in two worker processes:
   * the transitions claim `FOR UPDATE SKIP LOCKED` and are conditional on
   * status; the purge pass's lock ends with its read, so two sweepers may
   * delete the same object — harmless, an S3 delete is idempotent — and the
   * CONDITIONAL `purged_at` update is what makes each purge (and its audit
   * row) happen once.
   */
  async sweep(tenantId: string, now: Date = new Date()): Promise<AttachmentSweepSummary> {
    const uploadingCutoff = new Date(now.getTime() - UPLOADING_MAX_AGE_MS).toISOString();
    const ageCutoff = new Date(now.getTime() - this.purgeDays * 86_400_000).toISOString();
    const nowText = now.toISOString();

    const transitioned = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const discardedUploading = await this.discardInTx(tx, tenantId, 'uploading', uploadingCutoff, nowText);
      const staged = await this.discardStagedInTx(tx, tenantId, ageCutoff, nowText);
      const expired = await tx
        .update(attachments)
        .set({ status: 'expired', updatedAt: nowText })
        .where(
          inArray(
            attachments.id,
            sql`(select id from ${attachments} where tenant_id = ${tenantId} and status = 'awaited' and created_at < ${ageCutoff}
                 order by created_at, id limit ${ATTACHMENT_SWEEP_BATCH} for update skip locked)`,
          ),
        )
        .returning({ id: attachments.id });
      return { discardedUploading, discardedStaged: staged.discarded, keptReferenced: staged.kept, expired: expired.length };
    });

    // Rows whose bytes are due: every `discarded` row not yet purged, and every
    // `removed` row holding an object whose removal is older than the purge age.
    const due = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select({ id: attachments.id, objectKey: attachments.objectKey, status: attachments.status })
        .from(attachments)
        .where(
          and(
            eq(attachments.tenantId, tenantId),
            isNull(attachments.purgedAt),
            isNotNull(attachments.objectKey),
            sql`(${attachments.status} = 'discarded' or (${attachments.status} = 'removed' and ${attachments.removedAt} < ${ageCutoff}))`,
          ),
        )
        // Oldest-touched first: a row whose delete failed is touched and
        // goes to the back, so a run of failing deletes cannot starve the rest.
        .orderBy(asc(attachments.updatedAt), asc(attachments.id))
        .limit(ATTACHMENT_SWEEP_BATCH)
        .for('update', { skipLocked: true }),
    );

    let purged = 0;
    let deleteFailures = 0;
    for (const row of due) {
      const key = row.objectKey!;
      try {
        // Shared objects (A10): never delete bytes another live row still holds.
        const shared = await withTenantTransaction(this.db, tenantId, (tx) =>
          tx
            .select({ id: attachments.id })
            .from(attachments)
            .where(
              and(
                eq(attachments.tenantId, tenantId),
                eq(attachments.objectKey, key),
                ne(attachments.id, row.id),
                notInArray(attachments.status, ['removed', 'discarded']),
              ),
            )
            .limit(1),
        );
        if (shared.length === 0) {
          await this.fileStore.delete(key);
        }
      } catch (err) {
        deleteFailures += 1;
        this.logger.error(`attachment ${row.id}: delete of its bytes failed (${s3ErrorCode(err)}) — retried next tick`);
        await withTenantTransaction(this.db, tenantId, (tx) =>
          tx.update(attachments).set({ updatedAt: nowText }).where(and(eq(attachments.id, row.id), isNull(attachments.purgedAt))),
        );
        continue;
      }
      const marked = await withTenantTransaction(this.db, tenantId, async (tx) => {
        const updated = await tx
          .update(attachments)
          .set({ purgedAt: nowText, updatedAt: nowText })
          .where(and(eq(attachments.id, row.id), isNull(attachments.purgedAt), inArray(attachments.status, ['removed', 'discarded'])))
          .returning({ id: attachments.id });
        if (updated.length === 0) return false;
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId,
          actorUserId: SYSTEM_ACTOR_ID,
          action: 'receipt_photo.purged',
          targetType: 'attachment',
          targetId: row.id,
          reference: null,
          occurredAt: nowText,
        });
        return true;
      });
      if (marked) purged += 1;
    }
    return { ...transitioned, purged, deleteFailures };
  }

  private async discardInTx(tx: TenantTx, tenantId: string, status: 'uploading', cutoff: string, nowText: string): Promise<number> {
    const rows = await tx
      .update(attachments)
      .set({ status: 'discarded', updatedAt: nowText })
      .where(
        inArray(
          attachments.id,
          sql`(select id from ${attachments} where tenant_id = ${tenantId} and status = ${status} and created_at < ${cutoff}
               order by created_at, id limit ${ATTACHMENT_SWEEP_BATCH} for update skip locked)`,
        ),
      )
      .returning({ id: attachments.id });
    return rows.length;
  }

  /**
   * Unbound staged photos older than the purge age are discarded — EXCEPT
   * one an OPEN review row still names (K11): a refused receipt line's refs
   * ride its review payload (`lines[*].photoRefs`), and its Apply re-binds
   * them. Read-only over tenancy's `rejected_ops` (the predicate needs the
   * payload, which no facade exposes); `EXPLAIN` pinned in the suite.
   */
  private async discardStagedInTx(tx: TenantTx, tenantId: string, cutoff: string, nowText: string): Promise<{ discarded: number; kept: number }> {
    // The referenced rows are excluded BEFORE the limit, so a backlog of
    // kept photos can never starve the newer unbound ones.
    // Story 4-4a (A29) — a device handover's sheet photos ride its payload at
    // the top level (`$.photoRefs`), so a `handover.create` review row keeps
    // them too.
    const referenced = sql`exists (
        select 1 from rejected_ops r
        where r.tenant_id = a.tenant_id and r.status = 'open'
          and (jsonb_path_exists(r.payload, '$.lines[*].photoRefs[*] ? (@ == $ref)', jsonb_build_object('ref', a.client_ref))
            or jsonb_path_exists(r.payload, '$.photoRefs[*] ? (@ == $ref)', jsonb_build_object('ref', a.client_ref)))
      )`;
    const candidates = (await tx.execute(sql`
      select a.id
      from attachments a
      where a.tenant_id = ${tenantId} and a.status = 'staged' and a.created_at < ${cutoff}
        and not ${referenced}
      order by a.created_at, a.id
      limit ${ATTACHMENT_SWEEP_BATCH}
      for update of a skip locked
    `)) as unknown as { id: string }[];
    const discard = candidates.map((row) => row.id);
    if (discard.length > 0) {
      await tx
        .update(attachments)
        .set({ status: 'discarded', updatedAt: nowText })
        .where(and(inArray(attachments.id, discard), eq(attachments.status, 'staged'), lt(attachments.createdAt, cutoff)));
    }
    const kept = (await tx.execute(sql`
      select count(*)::int as n from attachments a
      where a.tenant_id = ${tenantId} and a.status = 'staged' and a.created_at < ${cutoff} and ${referenced}
    `)) as unknown as { n: number }[];
    return { discarded: discard.length, kept: Number(kept[0]?.n ?? 0) };
  }
}
