import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, batchRecallLines, batchRecalls, idempotencyKeys, type Batch, type BatchRecallLineRow, type BatchRecallRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { CatalogFacade } from '../catalog/catalog.facade';
import { InventoryFacade } from '../inventory/inventory.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import { assertSingleClientInTx } from '../clients/clients.facade';
import { openLiveRecallLinesForBatchesInTx } from './open-recall-lines';
import { recallLiveStateInTx } from './recall-figures';
import { buildCloseSummary, type CloseSummaryV1 } from './close-summary';

/**
 * Story 3-7a — the batch recall's vocabularies (TS tuple · the 0101 CHECK ·
 * the DTO's `@IsIn`, guide §4; pinned TS ↔ DB by `test/recalls.spec.ts`).
 */
export const RECALL_MODES = ['live', 'mock'] as const;
export type RecallMode = (typeof RECALL_MODES)[number];
export const RECALL_STATUSES = ['open', 'closed'] as const;
export type RecallStatus = (typeof RECALL_STATUSES)[number];

/** The most lots one recall names (open, add and the close lists alike). */
export const RECALL_MAX_LOTS = 50;
/** Note ceilings, in characters (code points). */
export const RECALL_NOTE_MAX = 500;
export const RECALL_REF_MAX = 100;
export const RECALL_EVIDENCE_MAX = 200;
/** A15 — how long a recall command waits on any lock before it answers 503 (milliseconds). */
export const RECALL_LOCK_TIMEOUT_MS = 5000;

/** The `55P03` Postgres raises when `lock_timeout` elapses. */
const LOCK_NOT_AVAILABLE = '55P03';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

export interface OpenRecallCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly batchIds: readonly string[];
  readonly reasonNote: string;
  readonly externalRef?: string | null | undefined;
  readonly mode?: RecallMode | undefined;
}

export interface AddRecallBatchesCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly recallId: string;
  readonly batchIds: readonly string[];
}

export interface CloseRecallCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly recallId: string;
  readonly note: string;
  readonly releaseBatchIds?: readonly string[] | undefined;
  readonly overrideReason?: string | null | undefined;
  readonly acknowledgeUnaccounted?: boolean | undefined;
  readonly dispositionNotes?: readonly { readonly batchId: string; readonly note: string }[] | undefined;
  readonly evidenceRef?: string | null | undefined;
}

/** One lot of a recall as its commands answer it. */
export interface RecallLotSnapshot {
  readonly batchId: string;
  readonly batchCode: string;
  readonly skuId: string;
  /** True when THIS recall blocked the lot (it was active); false when it was already blocked, and on every mock line. */
  readonly blockedByRecall: boolean;
}

/** The recall as its commands answer it — the stored idempotency snapshot. */
export interface RecallSnapshot {
  readonly recall: {
    readonly id: string;
    readonly code: string;
    readonly clientId: string;
    readonly mode: RecallMode;
    readonly status: RecallStatus;
    readonly reasonNote: string;
    readonly externalRef: string | null;
    readonly openedAt: string;
    readonly openedBy: string;
    readonly closedAt: string | null;
    readonly closedBy: string | null;
    readonly closeNote: string | null;
    readonly releasedBatchIds: readonly string[] | null;
    readonly closeSummary: CloseSummaryV1 | null;
    readonly lots: readonly RecallLotSnapshot[];
  };
}

function canonical(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid recall request', detail);
}

/** Trimmed; blank (or absent) is null. */
function normaliseText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function codePoints(value: string): number {
  return [...value].length;
}

/** At most `max` code points — a longer text is cut and ends in `…`. */
export function truncateCodePoints(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : `${points.slice(0, max - 1).join('')}…`;
}

/** A required note: trimmed, 1–max code points (400 otherwise). */
function requiredText(value: string | undefined, field: string, max: number): string {
  const text = normaliseText(value);
  if (text === null) throw invalid(`${field} is required — 1–${max} characters.`);
  if (codePoints(text) > max) throw invalid(`${field} is at most ${max} characters (got ${codePoints(text)}).`);
  return text;
}

/** An optional note: trimmed, blank = absent, at most max code points. */
function optionalText(value: string | null | undefined, field: string, max: number): string | null {
  const text = normaliseText(value);
  if (text !== null && codePoints(text) > max) throw invalid(`${field} is at most ${max} characters (got ${codePoints(text)}).`);
  return text;
}

/** A list of batch ids: well-formed, distinct, within bounds; answered lower-cased and SORTED (the hash's order). */
function batchIdList(ids: readonly string[] | undefined, field: string, min: number): string[] {
  const list = ids ?? [];
  if (list.length < min || list.length > RECALL_MAX_LOTS) {
    throw invalid(`${field} names ${min}–${RECALL_MAX_LOTS} batches (got ${list.length}).`);
  }
  const lowered = list.map((id) => {
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw invalid(`${field} holds a malformed batch id ${JSON.stringify(id)}.`);
    return id.toLowerCase();
  });
  if (new Set(lowered).size !== lowered.length) throw invalid(`${field} names a batch twice — each batch once.`);
  return [...lowered].sort();
}

function notFound(detail: string): ProblemException {
  return new ProblemException('not-found', 404, 'Not found', detail);
}

function recallNotFound(recallId: string): ProblemException {
  return notFound(`No recall with id "${recallId}" exists in this tenant.`);
}

/** Walks a driver error's `cause` chain for one SQLSTATE. */
function hasSqlState(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === code) return true;
    current = candidate.cause;
  }
  return false;
}

/** The recall code of a sequence number: `RCL-` and at least six digits. */
export function recallCode(n: number): string {
  return `RCL-${String(n).padStart(6, '0')}`;
}

/**
 * Story 3-7a — the batch recall document's commands (`batch_recalls`,
 * `batch_recall_lines` — written only here). A recall names 1–50 batches of
 * ONE client; a LIVE one blocks every active batch it names in the same
 * transaction (3-3a's block, reason `recall`, through `CatalogFacade`), so
 * the lot stops being promised and drawn in every warehouse at once; a MOCK
 * one (a drill) blocks nothing. Dispatch refuses an order whose picks drew a
 * lot on an open live recall, and a pick refuses a bin holding one
 * (outbound, through the `open-recall-lines.ts` seam). Close freezes the
 * figures and optionally releases lots.
 *
 * The skeleton (guide §1), each command: the shape checks above the
 * transaction (A18 — text in code points, distinct ids, bounds: 400) → the
 * hash → `lock_timeout` (A15: 5 s, a 55P03 is 503 `recall-open-contended`,
 * nothing written) → `qc.manage` → replay → the target rows locked
 * (`addBatches` / `close`: the recall row FIRST, then the batch rows `FOR
 * UPDATE` in id order — the batch-row family sits outside the canonical
 * bin → serial → warehouse chain and its holders wait on nothing else but
 * the recall sequence advisory) → replay again UNDER the locks → the state
 * guards → the writes → outbox → audit → the key LAST. No refusal stores a
 * key (A21).
 */
@Injectable()
export class RecallCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
  ) {}

  // ── open ──────────────────────────────────────────────────────────────────

  async open(command: OpenRecallCommand, idempotencyKey: string): Promise<RecallSnapshot> {
    const batchIds = batchIdList(command.batchIds, 'batchIds', 1);
    const reasonNote = requiredText(command.reasonNote, 'reasonNote', RECALL_NOTE_MAX);
    const externalRef = optionalText(command.externalRef, 'externalRef', RECALL_REF_MAX);
    const mode = command.mode ?? 'live';
    if (!(RECALL_MODES as readonly string[]).includes(mode)) {
      throw invalid(`mode must be one of ${JSON.stringify(RECALL_MODES)} (got ${JSON.stringify(mode)}).`);
    }
    const payloadHash = hashCommandPayload({
      command: 'recall.open',
      tenantId: command.tenantId,
      batchIds,
      reasonNote,
      externalRef,
      mode,
    });
    return this.contended(() =>
      withTenantTransaction(this.db, command.tenantId, async (tx) => {
        await this.armLockTimeout(tx);
        assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'qc.manage');
        const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replayed !== null) return replayed;

        const locked = await this.lockBatches(tx, command.tenantId, batchIds);
        const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replayedUnderLock !== null) return replayedUnderLock;

        const clientId = await this.singleClientOf(tx, command.tenantId, locked);
        if (mode === 'live') await this.assertNotRecalled(tx, command.tenantId, locked, null);

        // The recall sequence (A15 — the one advisory a batch-lock holder takes).
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${command.tenantId} || ':recall-seq', 0))`);
        const head = await tx
          .select({ n: sql<number>`coalesce(max(substring(${batchRecalls.code} from '^RCL-([0-9]{6,9})$')::int), 0)` })
          .from(batchRecalls)
          .where(eq(batchRecalls.tenantId, command.tenantId));
        const code = recallCode((head[0]?.n ?? 0) + 1);
        const openedAt = nowIso();
        const recallId = uuidv7();
        await tx.insert(batchRecalls).values({
          id: recallId,
          tenantId: command.tenantId,
          clientId,
          code,
          mode,
          status: 'open',
          reasonNote,
          externalRef,
          openedAt,
          openedBy: command.actorUserId,
        });
        const blocked = await this.addLines(tx, command.tenantId, command.actorUserId, idempotencyKey, { id: recallId, code, mode, reasonNote }, locked);

        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'batch_recall.opened',
          occurredAt: openedAt,
          payload: { recallId, code, clientId, mode, batchIds, blockedBatchIds: blocked },
        });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'batch_recall.opened',
          targetType: 'batch_recall',
          targetId: recallId,
          reference: idempotencyKey,
          changes: {
            code: { before: null, after: code },
            mode: { before: null, after: mode },
            clientId: { before: null, after: clientId },
            reasonNote: { before: null, after: reasonNote },
            externalRef: { before: null, after: externalRef },
            batchIds: { before: null, after: batchIds },
            blockedBatchIds: { before: null, after: blocked },
          },
          occurredAt: nowIso(),
        });
        const snapshot = await this.snapshotOf(tx, command.tenantId, recallId);
        await this.storeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }),
    );
  }

  // ── add batches (A14) ────────────────────────────────────────────────────

  async addBatches(command: AddRecallBatchesCommand, idempotencyKey: string): Promise<RecallSnapshot> {
    const batchIds = batchIdList(command.batchIds, 'batchIds', 1);
    const payloadHash = hashCommandPayload({
      command: 'recall.addBatches',
      tenantId: command.tenantId,
      recallId: command.recallId.toLowerCase(),
      batchIds,
    });
    return this.contended(() =>
      withTenantTransaction(this.db, command.tenantId, async (tx) => {
        await this.armLockTimeout(tx);
        assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'qc.manage');
        const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replayed !== null) return replayed;

        const recall = await this.lockRecall(tx, command.tenantId, command.recallId);
        const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replayedUnderLock !== null) return replayedUnderLock;
        this.assertOpen(recall);

        const existing = await this.linesOf(tx, command.tenantId, recall.id);
        const locked = await this.lockBatches(tx, command.tenantId, batchIds);
        const already = locked.filter((batch) => existing.some((line) => line.batchId === batch.id));
        if (already.length > 0) {
          throw new ProblemException(
            'batch-already-recalled',
            409,
            'Batch already recalled',
            `Batch ${already.map((batch) => `"${batch.code}"`).join(', ')} is already on ${recall.code}.`,
            { recallCodes: [recall.code] },
          );
        }
        if (existing.length + locked.length > RECALL_MAX_LOTS) {
          throw new ProblemException(
            'recall-too-many-lots',
            409,
            'Too many lots',
            `${recall.code} names ${existing.length} lots — adding ${locked.length} would pass the ${RECALL_MAX_LOTS}-lot ceiling of one recall. Open a second recall with the same brand reference.`,
          );
        }
        const clientId = await this.singleClientOf(tx, command.tenantId, locked, recall.clientId);
        if (clientId !== recall.clientId) throw new Error('unreachable: single client differs from the recall client');
        if (recall.mode === 'live') await this.assertNotRecalled(tx, command.tenantId, locked, recall.id);

        const blocked = await this.addLines(tx, command.tenantId, command.actorUserId, idempotencyKey, recall, locked);
        await tx
          .update(batchRecalls)
          .set({ updatedAt: nowIso() })
          .where(and(eq(batchRecalls.tenantId, command.tenantId), eq(batchRecalls.id, recall.id)));
        const at = nowIso();
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'batch_recall.batches_added',
          occurredAt: at,
          payload: { recallId: recall.id, code: recall.code, clientId: recall.clientId, mode: recall.mode, batchIds, blockedBatchIds: blocked },
        });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'batch_recall.batches_added',
          targetType: 'batch_recall',
          targetId: recall.id,
          reference: idempotencyKey,
          changes: {
            batchIds: { before: existing.map((line) => line.batchId).sort(), after: [...existing.map((line) => line.batchId), ...batchIds].sort() },
            blockedBatchIds: { before: null, after: blocked },
          },
          occurredAt: at,
        });
        const snapshot = await this.snapshotOf(tx, command.tenantId, recall.id);
        await this.storeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }),
    );
  }

  // ── close (A5, A6) ───────────────────────────────────────────────────────

  async close(command: CloseRecallCommand, idempotencyKey: string): Promise<RecallSnapshot> {
    const note = requiredText(command.note, 'note', RECALL_NOTE_MAX);
    const releaseBatchIds = batchIdList(command.releaseBatchIds, 'releaseBatchIds', 0);
    const overrideReason = optionalText(command.overrideReason, 'overrideReason', RECALL_NOTE_MAX);
    const acknowledgeUnaccounted = command.acknowledgeUnaccounted === true;
    const evidenceRef = optionalText(command.evidenceRef, 'evidenceRef', RECALL_EVIDENCE_MAX);
    const rawNotes = command.dispositionNotes ?? [];
    if (rawNotes.length > RECALL_MAX_LOTS) throw invalid(`dispositionNotes holds at most ${RECALL_MAX_LOTS} entries (got ${rawNotes.length}).`);
    const dispositionNotes = rawNotes
      .map((entry) => {
        if (typeof entry?.batchId !== 'string' || !UUID_RE.test(entry.batchId)) {
          throw invalid(`dispositionNotes holds a malformed batch id ${JSON.stringify(entry?.batchId)}.`);
        }
        return { batchId: entry.batchId.toLowerCase(), note: requiredText(entry.note, 'dispositionNotes[].note', RECALL_NOTE_MAX) };
      })
      .sort((a, b) => (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0));
    if (new Set(dispositionNotes.map((entry) => entry.batchId)).size !== dispositionNotes.length) {
      throw invalid('dispositionNotes names a batch twice — one note per lot.');
    }
    const payloadHash = hashCommandPayload({
      command: 'recall.close',
      tenantId: command.tenantId,
      recallId: command.recallId.toLowerCase(),
      note,
      releaseBatchIds,
      overrideReason,
      acknowledgeUnaccounted,
      dispositionNotes,
      evidenceRef,
    });
    return this.contended(() =>
      withTenantTransaction(this.db, command.tenantId, async (tx) => {
        await this.armLockTimeout(tx);
        assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'qc.manage');
        const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replayed !== null) return replayed;

        const recall = await this.lockRecall(tx, command.tenantId, command.recallId);
        const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replayedUnderLock !== null) return replayedUnderLock;
        this.assertOpen(recall);

        const lines = await this.linesOf(tx, command.tenantId, recall.id);
        const batchRows = new Map((await this.catalog.lockBatchesForUpdateInTx(tx, command.tenantId, lines.map((line) => line.batchId))).map((row) => [row.id, row]));
        const lineByBatch = new Map(lines.map((line) => [line.batchId, line]));

        const notOnRecall = [...releaseBatchIds, ...dispositionNotes.map((entry) => entry.batchId)].filter((id) => !lineByBatch.has(id));
        if (notOnRecall.length > 0) {
          throw new ProblemException(
            'recall-batch-not-on-recall',
            409,
            'Batch not on this recall',
            `${[...new Set(notOnRecall)].join(', ')} ${notOnRecall.length === 1 ? 'is' : 'are'} not a lot of ${recall.code} — release and note only its own lots.`,
          );
        }
        // A5 — a lot is released only when THIS recall blocked it and the
        // block is still the recall's (a lot blocked for another reason
        // before the recall, or re-blocked since, stays as it is).
        const ineligible = releaseBatchIds.filter((id) => {
          const line = lineByBatch.get(id)!;
          const row = batchRows.get(id);
          return !line.blockedByRecall || row === undefined || row.status !== 'blocked' || row.blockedReason !== 'recall';
        });
        if (ineligible.length > 0) {
          const codes = ineligible.map((id) => lineByBatch.get(id)!.batchCode).sort();
          throw new ProblemException(
            'recall-release-not-eligible',
            409,
            'Lot not releasable by this recall',
            `${codes.join(', ')} ${codes.length === 1 ? 'was' : 'were'} not blocked by ${recall.code} (or ${codes.length === 1 ? 'is' : 'are'} no longer blocked for the recall) — the recall releases only the lots it blocked.`,
            { batchCodes: codes },
          );
        }

        // The figures as of close — the same definition the detail reads live.
        const state = await recallLiveStateInTx(
          tx,
          { inventory: this.inventory, outbound: this.outbound },
          command.tenantId,
          recall.clientId,
          lines.map((line) => ({ batchId: line.batchId, skuId: line.skuId })),
        );
        if (overrideReason === null) {
          const withStock = releaseBatchIds.filter((id) => {
            const figures = state.figures.get(id)!;
            return figures.onHand + figures.inTransit > 0 || figures.heldInOpenOrders > 0;
          });
          if (withStock.length > 0) {
            const detail = withStock
              .map((id) => {
                const figures = state.figures.get(id)!;
                return `${lineByBatch.get(id)!.batchCode} (${figures.onHand + figures.inTransit} on hand or in transit, ${figures.heldInOpenOrders} in open orders)`;
              })
              .sort();
            throw new ProblemException(
              'recall-release-has-stock',
              409,
              'Recalled lot still has stock',
              `Releasing ${detail.join('; ')} would make recalled units sellable again — dispose of them first, or give an overrideReason.`,
              { batchCodes: withStock.map((id) => lineByBatch.get(id)!.batchCode).sort() },
            );
          }
        }
        const unaccounted = lines.filter((line) => state.figures.get(line.batchId)!.unaccounted !== 0);
        if (unaccounted.length > 0 && !acknowledgeUnaccounted) {
          const detail = unaccounted.map((line) => `${line.batchCode} (${state.figures.get(line.batchId)!.unaccounted})`).sort();
          throw new ProblemException(
            'recall-unaccounted',
            409,
            'Recall figures do not reconcile',
            `The stock of ${detail.join('; ')} does not match its ledger history — investigate (a quarantined scope, or a projection to rebuild), or close with acknowledgeUnaccounted.`,
            { batchCodes: unaccounted.map((line) => line.batchCode).sort() },
          );
        }

        const closedAt = nowIso();
        const released = new Set(releaseBatchIds);
        const notes = new Map(dispositionNotes.map((entry) => [entry.batchId, entry.note]));
        const summary = buildCloseSummary({
          asOf: closedAt,
          lots: lines.map((line) => ({
            batchId: line.batchId,
            batchCode: line.batchCode,
            skuId: line.skuId,
            figures: state.figures.get(line.batchId)!,
            adjustedOutByReason: state.adjustedOutByReason.get(line.batchId) ?? {},
            released: released.has(line.batchId),
            overrideReason: released.has(line.batchId) ? overrideReason : null,
            dispositionNote: notes.get(line.batchId) ?? null,
          })),
          acknowledgedUnaccounted: acknowledgeUnaccounted,
          evidenceRef,
        });
        const flipped = await tx
          .update(batchRecalls)
          .set({
            status: 'closed',
            closedAt,
            closedBy: command.actorUserId,
            closeNote: note,
            closeSummary: summary,
            releasedBatchIds: releaseBatchIds,
            updatedAt: closedAt,
          })
          .where(and(eq(batchRecalls.tenantId, command.tenantId), eq(batchRecalls.id, recall.id), eq(batchRecalls.status, 'open')))
          .returning({ id: batchRecalls.id });
        if (flipped[0] === undefined) throw new Error(`recall ${recall.id} was not open under its lock`);

        const releaseNote = truncateCodePoints(`${recall.code} closed: ${note}`, RECALL_NOTE_MAX);
        for (const batchId of releaseBatchIds) {
          await this.catalog.unblockBatchInTx(tx, {
            tenantId: command.tenantId,
            actorUserId: command.actorUserId,
            locked: batchRows.get(batchId)!,
            note: releaseNote,
            reference: idempotencyKey,
            extraChanges: {
              recall: { before: recall.code, after: null },
              overrideReason: { before: null, after: overrideReason },
            },
          });
        }
        await this.outbox.append(tx, {
          messageId: uuidv7(),
          tenantId: command.tenantId,
          type: 'batch_recall.closed',
          occurredAt: closedAt,
          payload: { recallId: recall.id, code: recall.code, clientId: recall.clientId, mode: recall.mode, releasedBatchIds: releaseBatchIds },
        });
        await tx.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'batch_recall.closed',
          targetType: 'batch_recall',
          targetId: recall.id,
          reference: idempotencyKey,
          changes: {
            status: { before: 'open', after: 'closed' },
            closeNote: { before: null, after: note },
            releasedBatchIds: { before: null, after: releaseBatchIds },
            overrideReason: { before: null, after: overrideReason },
            acknowledgedUnaccounted: { before: null, after: acknowledgeUnaccounted },
            evidenceRef: { before: null, after: evidenceRef },
          },
          occurredAt: nowIso(),
        });
        const snapshot = await this.snapshotOf(tx, command.tenantId, recall.id);
        await this.storeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }),
    );
  }

  // ── the report download's audit (A10) ────────────────────────────────────

  /**
   * One audit row per report download (`batch_recall.report_downloaded`), in
   * its OWN transaction, before any header is written: an unkeyed read
   * audit — `reference` is a fresh uuidv7 (no key was sent). The first
   * download stamps `first_report_at` (the "time to report" figure). A
   * recall the session cannot see (an unknown id, or — on the portal stamp —
   * another client's) is the same 404. `clientId` set = the portal surface:
   * the caller (`RecallsFacade`) opens the transaction stamped with it, and
   * the predicate here names it too.
   */
  async recordReportDownloadInTx(
    tx: TenantTx,
    input: {
      readonly tenantId: string;
      readonly recallId: string;
      readonly actorUserId: string;
      readonly clientId: string | null;
      readonly format: 'csv' | 'xlsx';
      readonly rowCount: number | null;
    },
  ): Promise<void> {
    {
      if (!UUID_RE.test(input.recallId)) throw recallNotFound(input.recallId);
      const at = nowIso();
      const rows = await tx
        .update(batchRecalls)
        .set({ firstReportAt: sql`coalesce(${batchRecalls.firstReportAt}, ${at}::timestamptz)` })
        .where(
          and(
            eq(batchRecalls.tenantId, input.tenantId),
            eq(batchRecalls.id, input.recallId.toLowerCase()),
            ...(input.clientId === null ? [] : [eq(batchRecalls.clientId, input.clientId)]),
          ),
        )
        .returning({ id: batchRecalls.id });
      if (rows[0] === undefined) throw recallNotFound(input.recallId);
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'batch_recall.report_downloaded',
        targetType: 'batch_recall',
        targetId: rows[0].id,
        reference: uuidv7(),
        changes: {
          surface: { before: null, after: input.clientId === null ? 'staff' : 'portal' },
          format: { before: null, after: input.format },
          rowCount: { before: null, after: input.rowCount },
        },
        occurredAt: at,
      });
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** A15 — every recall command waits at most `RECALL_LOCK_TIMEOUT_MS` on a lock (transaction-local). */
  private async armLockTimeout(tx: TenantTx): Promise<void> {
    await tx.execute(sql`select set_config('lock_timeout', ${String(RECALL_LOCK_TIMEOUT_MS)}, true)`);
  }

  /** A 55P03 (the lock timeout) anywhere is 503 `recall-open-contended` — the transaction rolled back whole, no key. */
  private async contended<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (hasSqlState(err, LOCK_NOT_AVAILABLE)) {
        throw new ProblemException(
          'recall-open-contended',
          503,
          'Recall contended',
          `A lot of this recall is being picked, dispatched, blocked or recalled right now (waited ${RECALL_LOCK_TIMEOUT_MS / 1000} s) — nothing was changed; try again in a moment.`,
        );
      }
      throw err;
    }
  }

  /** The batch rows `FOR UPDATE` in id order; 404 naming every missing id. */
  private async lockBatches(tx: TenantTx, tenantId: string, batchIds: readonly string[]): Promise<Batch[]> {
    const rows = await this.catalog.lockBatchesForUpdateInTx(tx, tenantId, batchIds);
    const found = new Set(rows.map((row) => row.id));
    const missing = batchIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw notFound(`No batch with id ${missing.map((id) => `"${id}"`).join(', ')} exists in this tenant.`);
    }
    return rows;
  }

  /** Lock the recall row, 404 when absent — nothing else (the `loadOpenPo` lesson, guide §1). */
  private async lockRecall(tx: TenantTx, tenantId: string, recallId: string): Promise<BatchRecallRow> {
    if (!UUID_RE.test(recallId)) throw recallNotFound(recallId);
    const rows = await tx
      .select()
      .from(batchRecalls)
      .where(and(eq(batchRecalls.tenantId, tenantId), eq(batchRecalls.id, recallId.toLowerCase())))
      .limit(1)
      .for('update');
    if (rows[0] === undefined) throw recallNotFound(recallId);
    return rows[0];
  }

  private assertOpen(recall: BatchRecallRow): void {
    if (recall.status !== 'open') {
      throw new ProblemException('recall-not-open', 409, 'Recall not open', `${recall.code} is ${recall.status} — a closed recall changes no more.`);
    }
  }

  /** Every batch's SKU belongs to one client (and, when given, to `expected`); 409 `mixed-client` otherwise. Departed and suspended clients are NOT refused — safety first. */
  private async singleClientOf(tx: TenantTx, tenantId: string, batches: readonly Batch[], expected?: string): Promise<string> {
    const clients = await this.catalog.skuClientIdsInTx(tx, tenantId, batches.map((batch) => batch.skuId));
    const ids = batches.map((batch) => {
      const client = clients.get(batch.skuId);
      if (client === undefined) throw new Error(`batch ${batch.id}'s SKU ${batch.skuId} has no catalog row`);
      return client;
    });
    return assertSingleClientInTx(tx, tenantId, expected === undefined ? ids : [expected, ...ids], 'A recall');
  }

  /** Live only: a batch already on an OPEN LIVE recall is 409 `batch-already-recalled`, naming that recall. */
  private async assertNotRecalled(tx: TenantTx, tenantId: string, batches: readonly Batch[], exceptRecallId: string | null): Promise<void> {
    const lines = (await openLiveRecallLinesForBatchesInTx(tx, tenantId, batches.map((batch) => batch.id))).filter(
      (line) => line.recallId !== exceptRecallId,
    );
    if (lines.length === 0) return;
    const codeOf = new Map(batches.map((batch) => [batch.id, batch.code]));
    const recallCodes = [...new Set(lines.map((line) => line.recallCode))].sort();
    throw new ProblemException(
      'batch-already-recalled',
      409,
      'Batch already recalled',
      `${lines.map((line) => `Batch "${codeOf.get(line.batchId) ?? line.batchId}" is on ${line.recallCode}`).join('; ')} — one lot is on one open recall; add to that recall instead.`,
      { recallCodes },
    );
  }

  /**
   * The recall's lines for these locked batches, and — on a LIVE recall —
   * 3-3a's block on every ACTIVE one (reason `recall`, note `RCL-x:
   * <reason>` cut to 500 code points; one `batch.blocked` audit row each
   * under the key). A batch already blocked for another reason keeps its
   * reason (`blocked_by_recall = false`). Answers the batches it blocked.
   */
  private async addLines(
    tx: TenantTx,
    tenantId: string,
    actorUserId: string,
    idempotencyKey: string,
    recall: { readonly id: string; readonly code: string; readonly mode: string; readonly reasonNote: string },
    batches: readonly Batch[],
  ): Promise<string[]> {
    const blocked: string[] = [];
    await tx.insert(batchRecallLines).values(
      batches.map((batch) => ({
        id: uuidv7(),
        tenantId,
        recallId: recall.id,
        batchId: batch.id,
        skuId: batch.skuId,
        batchCode: batch.code,
        blockedByRecall: recall.mode === 'live' && batch.status === 'active',
      })),
    );
    if (recall.mode !== 'live') return blocked;
    const note = truncateCodePoints(`${recall.code}: ${recall.reasonNote}`, RECALL_NOTE_MAX);
    for (const batch of batches) {
      if (batch.status !== 'active') continue;
      await this.catalog.blockBatchInTx(tx, {
        tenantId,
        actorUserId,
        locked: batch,
        reason: 'recall',
        note,
        reference: idempotencyKey,
        extraChanges: { recall: { before: null, after: recall.code } },
      });
      blocked.push(batch.id);
    }
    return blocked;
  }

  private async linesOf(tx: TenantTx, tenantId: string, recallId: string): Promise<BatchRecallLineRow[]> {
    return tx
      .select()
      .from(batchRecallLines)
      .where(and(eq(batchRecallLines.tenantId, tenantId), eq(batchRecallLines.recallId, recallId)))
      .orderBy(asc(batchRecallLines.batchCode), asc(batchRecallLines.batchId));
  }

  private async snapshotOf(tx: TenantTx, tenantId: string, recallId: string): Promise<RecallSnapshot> {
    const rows = await tx
      .select()
      .from(batchRecalls)
      .where(and(eq(batchRecalls.tenantId, tenantId), eq(batchRecalls.id, recallId)))
      .limit(1);
    const row = rows[0]!;
    const lines = await this.linesOf(tx, tenantId, recallId);
    return {
      recall: {
        id: row.id,
        code: row.code,
        clientId: row.clientId,
        mode: row.mode as RecallMode,
        status: row.status as RecallStatus,
        reasonNote: row.reasonNote,
        externalRef: row.externalRef,
        openedAt: canonical(row.openedAt)!,
        openedBy: row.openedBy,
        closedAt: canonical(row.closedAt),
        closedBy: row.closedBy,
        closeNote: row.closeNote,
        releasedBatchIds: row.releasedBatchIds,
        closeSummary: (row.closeSummary as CloseSummaryV1 | null) ?? null,
        lots: lines.map((line) => ({ batchId: line.batchId, batchCode: line.batchCode, skuId: line.skuId, blockedByRecall: line.blockedByRecall })),
      },
    };
  }

  private async replay(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<RecallSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    if (existing[0] === undefined) return null;
    if (existing[0].payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return existing[0].responseSnapshot as RecallSnapshot;
  }

  private async storeKey(tx: TenantTx, tenantId: string, idempotencyKey: string, payloadHash: string, snapshot: RecallSnapshot): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key: idempotencyKey, payloadHash, responseSnapshot: snapshot });
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
}
