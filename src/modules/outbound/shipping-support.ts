import { createHash } from 'node:crypto';
import type { Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { idempotencyKeys, orders, type AttachmentRow, type Order } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { isUniqueViolationOn, ProblemException } from '../../shared/problem-details/problem.exception';
import { clientInactive, shareLockClientInTx } from '../clients/clients.facade';
import { assertPermission, type Capability } from '../tenancy/permissions';
import { getMemberPortalFactsIn, getMemberRoleIn } from '../tenancy/tenancy.service';
import { attachmentObjectKey } from '../attachments/attachments.facade';
import {
  assertReservationLive,
  lockReservationInTx,
  reserveUploadInTx,
  type AttachmentPurpose,
  type AttachmentSource,
  type ShippingDocKind,
} from '../attachments/attachment-records';
import type { SanitizedFile , AttachmentsFacade} from '../attachments/attachments.facade';

/**
 * Story 4-4a — what the client-arranged shipping commands share: the replay
 * and key writes (the 4.1 shape), the portal write gate (guide §7e), the
 * order reads, and the reserve → put → finalize upload (guide §8) with the
 * A34 sanitiser placement. Free functions over the caller's database or
 * transaction; no state.
 */

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** The open order statuses a label, an AWB or a verification is recorded against. */
export const LABEL_OPEN_STATUSES = ['accepted', 'ready_to_dispatch'] as const;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function replayInTx(tx: TenantTx, tenantId: string, key: string, payloadHash: string): Promise<unknown> {
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

export async function writeKeyInTx(tx: TenantTx, tenantId: string, key: string, payloadHash: string, snapshot: unknown): Promise<void> {
  try {
    await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key, payloadHash, responseSnapshot: snapshot });
  } catch (err) {
    if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
      throw concurrentRequest();
    }
    throw err;
  }
}

export function concurrentRequest(): ProblemException {
  return new ProblemException(
    'conflict',
    409,
    'Concurrent idempotent request',
    'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
  );
}

export function validation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Validation failed', detail);
}

export function orderNotFound(orderId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Order not found', `No order with id "${orderId}" exists here.`);
}

export function orderNotOpen(order: Pick<Order, 'status'>, label: string, open: readonly string[] = LABEL_OPEN_STATUSES): ProblemException {
  return new ProblemException(
    'order-not-open',
    409,
    'Order is not open',
    `Order ${label} reads "${order.status}" — only an order that is ${open.map((s) => s.replace(/_/g, ' ')).join(' or ')} takes this.`,
    { orderStatus: order.status },
  );
}

/** Who is writing: a staff member (a capability), or a client-portal user of one client (guide §7e). */
export type Writer =
  | { readonly surface: 'staff'; readonly actorUserId: string }
  | { readonly surface: 'portal'; readonly actorUserId: string; readonly clientId: string };

/**
 * The authority gate, first in every transaction of a command: staff →
 * `assertPermission(capability)`; portal → `orders.place`, the user re-read
 * (not active → 401; another client → 403 `role-denied`), and the client
 * `FOR SHARE` (not active → its 403).
 */
export async function authorizeWriterInTx(tx: TenantTx, tenantId: string, writer: Writer, staffCapability: Capability): Promise<void> {
  if (writer.surface === 'staff') {
    assertPermission(await getMemberRoleIn(tx, tenantId, writer.actorUserId), staffCapability);
    return;
  }
  assertPermission(await getMemberRoleIn(tx, tenantId, writer.actorUserId), 'orders.place');
  const actor = await getMemberPortalFactsIn(tx, tenantId, writer.actorUserId);
  if (actor === null || actor.status !== 'active') {
    throw new ProblemException(
      'unauthenticated',
      401,
      'Authentication required',
      'The session no longer describes an active client-portal user — sign in again.',
    );
  }
  if (actor.clientId !== writer.clientId) {
    throw new ProblemException('role-denied', 403, 'Role lacks the required capability', 'Only a client-portal user of this client may do this.');
  }
  const client = await shareLockClientInTx(tx, tenantId, writer.clientId);
  if (client.status !== 'active') throw clientInactive(client.status);
}

/** The order as the writer may see it (portal: its own client's; unknown and foreign the same 404), optionally locked. */
export async function readOrderForWriterInTx(
  tx: TenantTx,
  tenantId: string,
  writer: Writer,
  orderId: string,
  lock: 'update' | 'share' | null,
): Promise<Order> {
  if (!UUID_RE.test(orderId)) throw orderNotFound(orderId);
  const query = tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, orderId),
        ...(writer.surface === 'portal' ? [eq(orders.clientId, writer.clientId)] : []),
      ),
    )
    .limit(1);
  const rows = lock === 'update' ? await query.for('update') : lock === 'share' ? await query.for('share') : await query;
  const order = rows[0];
  if (order === undefined) throw orderNotFound(orderId);
  return order;
}

/** What the reservation of one upload carries. */
export interface UploadReservation {
  readonly purpose: AttachmentPurpose;
  readonly source: AttachmentSource;
  readonly deviceId: string | null;
  readonly createdBy: string;
  readonly capturedAt: string | null;
  readonly rawSha256: string;
  readonly docKind: ShippingDocKind | null;
  readonly clientId: string | null;
  readonly warehouseId: string | null;
}

/** Opens one transaction of a command (a portal command's opener stamps the session's client). */
export type TxOpener = <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;

export interface UploadPipeline<S> {
  /** Every transaction's opener (the portal's is client-stamped, literally, in the command). */
  readonly open: TxOpener;
  readonly attachments: AttachmentsFacade;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly key: string;
  readonly payloadHash: string;
  /** First in each transaction (authority, re-read per transaction). */
  readonly authorize: (tx: TenantTx) => Promise<void>;
  /** After the replay in the pre-flight and in Tx A: the scope (404) and the cheap refusals; answers the reservation's facts. */
  readonly scope: (tx: TenantTx) => Promise<Omit<UploadReservation, 'rawSha256' | 'source' | 'deviceId' | 'createdBy' | 'capturedAt'>>;
  readonly origin: Pick<UploadReservation, 'source' | 'deviceId' | 'createdBy' | 'capturedAt' | 'rawSha256'>;
  /** The sanitiser (A34) — run OUTSIDE every transaction, inside the gate slot. */
  readonly sanitize: () => Promise<SanitizedFile>;
  /** Tx B after authority → reservation lock → replay → live: the command body (writes the key itself? no — the pipeline does). */
  readonly body: (tx: TenantTx, reservation: AttachmentRow) => Promise<S>;
  /** The storage-off wording. */
  readonly what: string;
}

/**
 * Story 4-4a (A8, A34, guide §8) — reserve → put → finalize, with the
 * sanitiser OUTSIDE every transaction (no database lock is held while an
 * untrusted file is parsed) but still AFTER the replay lookup (a committed
 * key always replays, whatever a later sanitiser would say):
 *
 *  0. pre-flight transaction: authority → replay → storage mode → scope;
 *  1. the gate slot (503 `file-storage-busy`) → the sanitiser;
 *  2. Tx A: authority → replay → storage → scope → the reservation;
 *  3. the put, outside every transaction (503 `file-storage-failed` keeps the
 *     reservation for the same-key retry);
 *  4. Tx B: authority → lock the reservation (lock only) → replay under the
 *     lock → live (503 when swept) → the body → the key LAST.
 */
export async function runUpload<S>(pipeline: UploadPipeline<S>): Promise<S> {
  const { open, attachments, tenantId, key, payloadHash } = pipeline;
  const storageOff = (): ProblemException =>
    new ProblemException(
      'file-storage-unavailable',
      503,
      'File storage is not configured',
      `File storage is not configured on this server (FILE_STORE=none) — the ${pipeline.what} cannot be stored.`,
    );

  const preflight = await open(async (tx) => {
      await pipeline.authorize(tx);
      const replayed = await replayInTx(tx, tenantId, key, payloadHash);
      if (replayed !== null) return { replayed: replayed as S };
      if (!attachments.storageEnabled) throw storageOff();
      await pipeline.scope(tx);
      return { replayed: null };
  });
  if (preflight.replayed !== null) return preflight.replayed;

  let release: (() => void) | null = null;
  let reservationId: string;
  try {
    release = attachments.uploadGate.acquire();
    const clean = await pipeline.sanitize();
    const phaseA = await open(async (tx) => {
        await pipeline.authorize(tx);
        const replayed = await replayInTx(tx, tenantId, key, payloadHash);
        if (replayed !== null) return { kind: 'replayed' as const, snapshot: replayed as S };
        if (!attachments.storageEnabled) throw storageOff();
        const facts = await pipeline.scope(tx);
        const reservation = await reserveUploadInTx(tx, {
          tenantId,
          purpose: facts.purpose,
          source: pipeline.origin.source,
          uploadKey: key,
          uploadHash: payloadHash,
          rawSha256: pipeline.origin.rawSha256,
          deviceId: pipeline.origin.deviceId,
          createdBy: pipeline.origin.createdBy,
          capturedAt: pipeline.origin.capturedAt,
          objectKeyOf: (id) => attachmentObjectKey(tenantId, id),
          object: {
            contentType: clean.contentType,
            byteSize: clean.bytes.byteLength,
            sha256: clean.sha256,
            width: clean.width,
            height: clean.height,
            pageCount: clean.pageCount,
          },
          clientId: facts.clientId,
          warehouseId: facts.warehouseId,
          docKind: facts.docKind,
        });
        return { kind: 'reserved' as const, reservation };
    });
    if (phaseA.kind === 'replayed') return phaseA.snapshot;
    try {
      await attachments.fileStore.put({ key: phaseA.reservation.objectKey!, bytes: clean.bytes, contentType: clean.contentType });
    } catch (err) {
      pipeline.logger.error(
        `put of attachment ${phaseA.reservation.id} (tenant ${tenantId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ProblemException('file-storage-failed', 503, 'File storage failed', `The ${pipeline.what} could not be stored right now — send it again.`);
    }
    reservationId = phaseA.reservation.id;
  } finally {
    (release as (() => void) | null)?.();
  }

  return open(async (tx) => {
      await pipeline.authorize(tx);
      const locked = await lockReservationInTx(tx, tenantId, reservationId);
      const replayed = await replayInTx(tx, tenantId, key, payloadHash);
      if (replayed !== null) return replayed as S;
      const reservation = assertReservationLive(locked);
      const snapshot = await pipeline.body(tx, reservation);
      await writeKeyInTx(tx, tenantId, key, payloadHash, snapshot);
      return snapshot;
  });
}

/** A50 (D33) — an ASCII-folded order label for a derived file name. */
export function fileNamePart(text: string): string {
  const folded = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return folded === '' ? 'file' : folded.slice(0, 60);
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function extensionOf(contentType: string | null): string {
  return contentType === null ? 'bin' : (EXTENSIONS[contentType] ?? 'bin');
}
