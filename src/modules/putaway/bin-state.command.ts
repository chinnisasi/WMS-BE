import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { BIN_BLOCK_REASONS, SUSPECT_STOCK_BIN_BLOCK_REASONS, auditEvents, bins, idempotencyKeys, type BinBlockReason } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { binSnapshotFromRow, type BinSnapshot } from '../tenancy/bin.command';
import { IDEMPOTENCY_TENANT_KEY, binNotFound, binRetired409 } from '../tenancy/bin.errors';

/** Story 3-3b (decision 3) — the reason vocabulary lives beside the table (`schema.ts`). */
export { BIN_BLOCK_REASONS, SUSPECT_STOCK_BIN_BLOCK_REASONS, type BinBlockReason };

/** The block / unblock note's ceiling, in characters (code points) — the `bins_blocked_pairing` CHECK's `char_length`. */
export const BIN_BLOCK_NOTE_MAX = 500;


/** The note the 0106 backfill wrote on every bin blocked before 3-3b (the CHECK admits a null blocker only beside it). */
export const BIN_BLOCK_BACKFILL_NOTE = 'Blocked before story 3-3b recorded reasons';

export interface BlockBinCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly reason: string;
  readonly note?: string | null | undefined;
}

export interface UnblockBinCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly note?: string | null | undefined;
}

/** A pre-3-3b `PATCH …/bins/{binId} {blocked}` body — retired (A6); only its stored key still replays. */
export interface LegacyBinBlockedPatchCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly binId: string;
  readonly blocked: boolean;
}

type BinRow = typeof bins.$inferSelect;

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid bin block', detail);
}

/** Trimmed; blank after trimming is absent (null). */
function normaliseNote(note: string | null | undefined): string | null {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
}

/** ISO-8601 UTC — Postgres's own text shape never reaches the audit trail. */
function canonical(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * A bin's operational state — putaway owns it (story 3.6 re-homed the toggle
 * here from tenancy: tenancy owns bin STRUCTURE, putaway owns whether a bin
 * may take part in the flow at all).
 *
 * Story 3-3b turns the PATCH `{blocked}` toggle into two verbs that record
 * WHY, WHEN and BY WHOM — `block` (`{reason, note?}`) and `unblock`
 * (`{note}`, required: lifting a block is the riskier direction, the 3-3a A8
 * rule). A block never moves stock and never cancels a reservation or a task:
 * the units stay on hand, the inventory core stops PROMISING them
 * (`unpromisableUnits.blockedBin`), the draw and placement sides already
 * refuse or skip the bin, and a planned pick stop in it is Skipped and
 * re-planned (`pick.command.ts`).
 *
 * The skeleton (guide §1, decision 6): `bin.block` → the shape checks (the
 * vocabulary, `other` needs a note, the note's bounds — none reads a row) →
 * replay → warehouse in tenant → the bin row `FOR UPDATE` WITH the tenant
 * predicate (404) → replay again UNDER the lock (the same-key race) → the
 * structural guards (system 400, retired 409) → the state guard (409
 * `bin-already-blocked` / `bin-not-blocked` — thrown, so no key and no audit
 * row) → the conditional update → outbox → audit (with `changes`, so the
 * history survives the unblock clearing the row) → the idempotency key LAST.
 * The fingerprint is `{tenantId, warehouseId, binId, verb, reason, note}`
 * with the note trimmed and blank as null.
 */
@Injectable()
export class BinStateCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async block(command: BlockBinCommand, idempotencyKey: string): Promise<BinSnapshot> {
    const note = normaliseNote(command.note);
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      binId: command.binId,
      verb: 'block',
      reason: command.reason,
      note,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'bin.block');
      if (!(BIN_BLOCK_REASONS as readonly string[]).includes(command.reason)) {
        throw invalid(`reason must be one of ${JSON.stringify(BIN_BLOCK_REASONS)} (got ${JSON.stringify(command.reason)}).`);
      }
      if (command.reason === 'other' && note === null) {
        throw invalid('A block for reason "other" must say why — supply a note.');
      }
      if (note !== null && [...note].length > BIN_BLOCK_NOTE_MAX) {
        throw invalid(`note is at most ${BIN_BLOCK_NOTE_MAX} characters.`);
      }
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      const locked = await this.lockBin(tx, command.tenantId, command.warehouseId, command.binId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      this.assertOperable(locked);
      if (locked.blocked) {
        throw new ProblemException(
          'bin-already-blocked',
          409,
          'Bin already blocked',
          `Bin "${locked.code}" is already blocked (${locked.blockedReason ?? 'no reason'}) — unblock it first to change the reason.`,
        );
      }

      const blockedAt = nowIso();
      const reason = command.reason as BinBlockReason;
      const updated = await tx
        .update(bins)
        .set({
          blocked: true,
          blockedReason: reason,
          blockedNote: note,
          blockedAt,
          blockedBy: command.actorUserId,
          updatedAt: blockedAt,
        })
        .where(and(eq(bins.tenantId, command.tenantId), eq(bins.id, locked.id), eq(bins.blocked, false)))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        // Unreachable beneath the row lock and the state guard; the backstop
        // that rolls the whole transaction back.
        throw new Error(`bin ${locked.id} was not active under its lock`);
      }
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'bin.blocked',
        occurredAt: blockedAt,
        // The 1.3 type is kept; 3-3b adds `reason` (A8). No consumer exists.
        payload: { binId: row.id, warehouseId: row.warehouseId, blocked: true, reason },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'bin.blocked',
        targetType: 'bin',
        targetId: row.id,
        reference: idempotencyKey,
        changes: {
          blocked: { before: false, after: true },
          reason: { before: null, after: reason },
          note: { before: null, after: note },
          // The mirror of the unblock's `before` (the same canonical ISO shape).
          blockedAt: { before: null, after: canonical(blockedAt) },
          blockedBy: { before: null, after: command.actorUserId },
        },
        // The block's own instant — one clock reading for the row and its audit.
        occurredAt: blockedAt,
      });
      const snapshot: BinSnapshot = { bin: binSnapshotFromRow(row) };
      await this.storeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  async unblock(command: UnblockBinCommand, idempotencyKey: string): Promise<BinSnapshot> {
    const note = normaliseNote(command.note);
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      binId: command.binId,
      verb: 'unblock',
      reason: null,
      note,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'bin.block');
      // Lifting a block is the riskier direction: it always says why (the 3-3a A8 rule).
      if (note === null) {
        throw invalid(`Unblocking a bin must say why — supply a note (1–${BIN_BLOCK_NOTE_MAX} characters).`);
      }
      if ([...note].length > BIN_BLOCK_NOTE_MAX) {
        throw invalid(`note is at most ${BIN_BLOCK_NOTE_MAX} characters.`);
      }
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      const locked = await this.lockBin(tx, command.tenantId, command.warehouseId, command.binId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      this.assertOperable(locked);
      if (!locked.blocked) {
        throw new ProblemException(
          'bin-not-blocked',
          409,
          'Bin not blocked',
          `Bin "${locked.code}" is not blocked — there is nothing to unblock.`,
        );
      }

      const at = nowIso();
      const updated = await tx
        .update(bins)
        .set({ blocked: false, blockedReason: null, blockedNote: null, blockedAt: null, blockedBy: null, updatedAt: at })
        .where(and(eq(bins.tenantId, command.tenantId), eq(bins.id, locked.id), eq(bins.blocked, true)))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new Error(`bin ${locked.id} was not blocked under its lock`);
      }
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'bin.unblocked',
        occurredAt: at,
        payload: { binId: row.id, warehouseId: row.warehouseId, blocked: false },
      });
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'bin.unblocked',
        targetType: 'bin',
        targetId: row.id,
        reference: idempotencyKey,
        changes: {
          blocked: { before: true, after: false },
          reason: { before: locked.blockedReason, after: null },
          // `before` is the block's own note (cleared from the row now);
          // `after` is why the block was lifted.
          note: { before: locked.blockedNote, after: note },
          blockedAt: { before: canonical(locked.blockedAt), after: null },
          blockedBy: { before: locked.blockedBy, after: null },
        },
        // The unblock's own instant — the row's `updated_at` and this row agree.
        occurredAt: at,
      });
      const snapshot: BinSnapshot = { bin: binSnapshotFromRow(row) };
      await this.storeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * A pre-3-3b `PATCH {blocked}` body (A6): the arm is RETIRED, but behind the
   * replay lookup — a key stored by a pre-3-3b PATCH re-serves its snapshot
   * (the fingerprint is that build's, byte for byte); any other request is a
   * 400 naming the two verbs. Authority first, as on every keyed arm.
   */
  async legacyPatch(command: LegacyBinBlockedPatchCommand, idempotencyKey: string): Promise<BinSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      warehouseId: command.warehouseId,
      binId: command.binId,
      blocked: command.blocked,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'bin.block');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      throw new ProblemException(
        'validation-failed',
        400,
        'blocked is no longer patched',
        `A bin is blocked with POST …/bins/${command.binId}/block {reason, note?} and unblocked with POST …/bins/${command.binId}/unblock {note} — ` +
          'the PATCH `blocked` field was retired by story 3-3b (a block now records why, when and by whom).',
      );
    });
  }

  /** The structural guards against the locked row (the story 3.6 arms, unchanged). */
  private assertOperable(row: BinRow): void {
    // The system bins (Receiving/QC-hold/…) are operational infrastructure
    // the commands own — blocking one would drop the warehouse's intake or
    // quarantine out of the flow. Never blockable.
    if (row.systemOwned) {
      throw new ProblemException(
        'validation-failed',
        400,
        'System bins can never be blocked',
        `Bin "${row.code}" is a system bin (Receiving/QC-hold/In-Transit/Returns/Damaged) — blocking it is refused.`,
      );
    }
    // A retired bin is operationally gone — nothing left to block or unblock.
    if (row.retiredAt !== null) {
      throw binRetired409(row.code);
    }
  }

  /** Lock the bin row in the tenant and warehouse, 404 when absent — nothing else (guide §1, the `loadOpenPo` lesson). */
  private async lockBin(tx: TenantTx, tenantId: string, warehouseId: string, binId: string): Promise<BinRow> {
    if (!UUID_RE.test(binId)) throw binNotFound();
    const rows = await tx
      .select()
      .from(bins)
      .where(and(eq(bins.tenantId, tenantId), eq(bins.id, binId), eq(bins.warehouseId, warehouseId)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (row === undefined) throw binNotFound();
    return row;
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<BinSnapshot | null> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    if (existing[0] === undefined) return null;
    if (existing[0].payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return existing[0].responseSnapshot as BinSnapshot;
  }

  private async storeKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: BinSnapshot,
  ): Promise<void> {
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
