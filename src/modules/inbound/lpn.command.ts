import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, goodsReceiptLines, goodsReceiptNotes, idempotencyKeys, lpns, putawayPlacements, skus, type Lpn } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { assertRecordableQuantity, fromMilli } from '../../shared/primitives/quantity';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { CatalogFacade } from '../catalog/catalog.facade';
import { uomPrecision } from '../catalog/uom';
import { approvedExcessOfLineInTx, failedReceiptQtyOfLineInTx } from '../putaway/putaway.command';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { MAX_LPN_MINT_QUANTITIES, MAX_LPNS_PER_LINE } from './lpn.dto';
import {
  LPN_VOID_NOTE_MAX,
  LPN_VOID_REASON_CODES,
  lpnCodeOf,
  type LpnStatus,
  type LpnVoidReasonCode,
} from './lpn.store';

/**
 * Story 2-10b — the licence plate (LPN) commands: `lpn.mint` and `lpn.void`.
 *
 * An LPN is one labelled pallet or carton of ONE GRN line. Minting declares a
 * quantity per label; it moves no stock (no ledger event, no outbox event) —
 * the receive command and its hash are untouched. Both commands are keyed
 * web commands (`labels.execute`) on the §1 skeleton, each with an audit row.
 *
 * - **The cap (A4).** A line's labelled total — Σ its `active` and `placed`
 *   LPNs — never exceeds its putaway quantity: `applied_qty + approved
 *   over-receipt excess − failed-inspection units` (QC-held units are still
 *   on the dock, so they stay labellable). Pending excess is not labellable
 *   until approved. Read under the tenant `':lpn-seq'` advisory lock, which
 *   serialises every mint of the tenant, so two mints never both pass it.
 * - **The number (decision 4).** `max(seq) + 1` over the unique `(tenant_id,
 *   seq)` index, under the same lock (no `max(substring(code))` scan).
 * - **Void (decision 7, A10).** An `active` LPN only; terminal; frees its
 *   quantity. A placed LPN is refused (409) — the placement consumed it.
 */

export interface MintLpnsCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly grnId: string;
  readonly lines: readonly { readonly grnLineId: string; readonly quantities: readonly number[] }[];
}

export interface VoidLpnCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly grnId: string;
  readonly lpnId: string;
  readonly reasonCode: string;
  readonly note?: string | null | undefined;
}

/** One LPN as every surface returns it (the list, the mint and void snapshots). Base units. */
export interface LpnSnapshot {
  readonly id: string;
  readonly code: string;
  readonly grnId: string;
  readonly grnLineId: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly batchId: string | null;
  readonly batchCode: string | null;
  readonly clientId: string;
  readonly qty: number;
  readonly status: LpnStatus;
  readonly createdAt: string;
  readonly placedAt: string | null;
  readonly voidedAt: string | null;
  readonly voidReasonCode: LpnVoidReasonCode | null;
  readonly voidNote: string | null;
}

export interface MintLpnsSnapshot {
  readonly grnId: string;
  readonly lpns: readonly LpnSnapshot[];
}

export interface LpnListSnapshot {
  readonly items: readonly LpnSnapshot[];
  readonly lines: readonly { readonly grnLineId: string; readonly unlabelledQty: number }[];
}

export interface VoidLpnSnapshot {
  readonly lpn: LpnSnapshot;
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const LPN_SEQ_UNIQUE = 'lpns_tenant_seq_unique';

function lpnValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid LPN request', detail);
}

function grnNotFound(grnId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Goods receipt not found', `No goods receipt with id "${grnId}" exists in this tenant.`);
}

/** Every LPN row → its snapshot: SKU codes from `skus`, batch codes through the catalog facade. */
export async function lpnSnapshotsInTx(
  tx: TenantTx,
  catalog: CatalogFacade,
  tenantId: string,
  rows: readonly Lpn[],
): Promise<LpnSnapshot[]> {
  if (rows.length === 0) return [];
  const skuIds = [...new Set(rows.map((row) => row.skuId))];
  const skuRows = await tx
    .select({ id: skus.id, code: skus.code })
    .from(skus)
    .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, skuIds)));
  const skuCodes = new Map(skuRows.map((row) => [row.id, row.code]));
  const batchCodes = await catalog.batchCodesByIdsInTx(
    tx,
    tenantId,
    [...new Set(rows.map((row) => row.batchId).filter((id): id is string => id !== null))],
  );
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    grnId: row.grnId,
    grnLineId: row.grnLineId,
    skuId: row.skuId,
    skuCode: skuCodes.get(row.skuId) ?? '',
    batchId: row.batchId,
    batchCode: row.batchId === null ? null : (batchCodes.get(row.batchId) ?? null),
    clientId: row.clientId,
    qty: fromMilli(row.qty),
    status: row.status as LpnStatus,
    createdAt: canonicalInstant(row.createdAt),
    placedAt: row.placedAt === null ? null : canonicalInstant(row.placedAt),
    voidedAt: row.voidedAt === null ? null : canonicalInstant(row.voidedAt),
    voidReasonCode: row.voidReasonCode as LpnVoidReasonCode | null,
    voidNote: row.voidNote,
  }));
}

/** One GRN line's LPN cap facts, milli-units. */
export interface LpnLineCap {
  /** applied + approved over-receipt excess − failed-inspection units (≥ 0). */
  readonly putawayQty: number;
  /** Σ every placement of the line (with or without an LPN). */
  readonly placed: number;
  /** Σ the line's ACTIVE LPNs. */
  readonly active: number;
  /** Active + placed LPN rows (the 5000 bound). */
  readonly rows: number;
  /** What may still go on labels: putawayQty − placed − active, floored at 0. */
  readonly unlabelled: number;
}

/**
 * Story 2-10b (A4, as amended at code review) — the cap is the units still on
 * the dock: Σ active LPNs + new ≤ applied + approved excess − failed
 * inspection − Σ the line's placements (every placement, with or without an
 * LPN). Placed and voided LPNs no longer count toward the quantity (a partial
 * LPN placement frees its remainder through the placed sum); the 5000 row
 * bound still counts active + placed rows. The mint reads it under the
 * ':lpn-seq' lock; the list read serves `unlabelled` to the web.
 */
export async function lpnLineCapsInTx(
  tx: TenantTx,
  tenantId: string,
  lines: readonly { readonly id: string; readonly appliedQty: number }[],
): Promise<Map<string, LpnLineCap>> {
  const out = new Map<string, LpnLineCap>();
  if (lines.length === 0) return out;
  const ids = lines.map((line) => line.id);
  const lpnRows = await tx
    .select({
      grnLineId: lpns.grnLineId,
      active: sql<string>`coalesce(sum(${lpns.qty}) filter (where ${lpns.status} = 'active'), 0)::bigint`,
      rows: sql<string>`count(*)::bigint`,
    })
    .from(lpns)
    .where(and(eq(lpns.tenantId, tenantId), inArray(lpns.grnLineId, ids), ne(lpns.status, 'voided')))
    .groupBy(lpns.grnLineId);
  const byLine = new Map(lpnRows.map((row) => [row.grnLineId, { active: Number(row.active), rows: Number(row.rows) }]));
  const placedRows = await tx
    .select({ grnLineId: putawayPlacements.grnLineId, placed: sql<string>`coalesce(sum(${putawayPlacements.qty}), 0)::bigint` })
    .from(putawayPlacements)
    .where(and(eq(putawayPlacements.tenantId, tenantId), inArray(putawayPlacements.grnLineId, ids)))
    .groupBy(putawayPlacements.grnLineId);
  const placedByLine = new Map(placedRows.map((row) => [row.grnLineId, Number(row.placed)]));
  for (const line of lines) {
    const putawayQty = Math.max(
      0,
      line.appliedQty + (await approvedExcessOfLineInTx(tx, tenantId, line.id)) - (await failedReceiptQtyOfLineInTx(tx, tenantId, line.id)),
    );
    const placed = placedByLine.get(line.id) ?? 0;
    const facts = byLine.get(line.id) ?? { active: 0, rows: 0 };
    out.set(line.id, { putawayQty, placed, active: facts.active, rows: facts.rows, unlabelled: Math.max(0, putawayQty - placed - facts.active) });
  }
  return out;
}

/** The receipt's header, or 404. */
export async function grnHeaderInTx(tx: TenantTx, tenantId: string, grnId: string): Promise<{ id: string; code: string; warehouseId: string }> {
  const rows = await tx
    .select({ id: goodsReceiptNotes.id, code: goodsReceiptNotes.code, warehouseId: goodsReceiptNotes.warehouseId })
    .from(goodsReceiptNotes)
    .where(and(eq(goodsReceiptNotes.tenantId, tenantId), eq(goodsReceiptNotes.id, grnId)))
    .limit(1);
  if (rows[0] === undefined) throw grnNotFound(grnId);
  return rows[0];
}

@Injectable()
export class LpnCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // The batch codes of the snapshots (catalog-owned, AD-6).
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  /**
   * `lpn.mint` — one keyed command for any number of lines of ONE receipt.
   * The §1 skeleton: shape above the tx → hash → authority → replay → the GRN
   * (404) → the `':lpn-seq'` advisory lock → replay again (the same-key race)
   * → the lines (404) → per line: precision, the cap, the 5000 bound → the
   * inserts in request order → audit `lpn.minted` → the key last.
   */
  async mint(command: MintLpnsCommand, idempotencyKey: string): Promise<MintLpnsSnapshot> {
    // ── shape, above the transaction ───────────────────────────────────────
    // Ids lower-cased (uuids compare case-insensitively), so a case-only
    // duplicate is a duplicate and a replay hashes one spelling.
    const grnId = command.grnId.toLowerCase();
    const lines = command.lines.map((line) => ({ grnLineId: line.grnLineId.toLowerCase(), quantities: [...line.quantities] }));
    if (lines.length === 0) throw lpnValidation('lines must name at least one GRN line.');
    if (new Set(lines.map((line) => line.grnLineId)).size !== lines.length) {
      throw lpnValidation('lines names the same GRN line more than once — send all of a line\'s labels in its one entry.');
    }
    const total = lines.reduce((sum, line) => sum + line.quantities.length, 0);
    if (lines.some((line) => line.quantities.length === 0)) throw lpnValidation('Each line needs at least one quantity (one per label).');
    if (total > MAX_LPN_MINT_QUANTITIES) {
      throw lpnValidation(`One mint creates at most ${MAX_LPN_MINT_QUANTITIES} labels (got ${total}) — split it into several mints.`);
    }

    // ── the fingerprint (A7): an arm, request order, base units ───────────
    const payloadHash = hashCommandPayload({ arm: 'lpn.mint', tenantId: command.tenantId, grnId, lines });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'labels.execute');
      const replayed = await this.replay<MintLpnsSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      const grn = await grnHeaderInTx(tx, command.tenantId, grnId);

      // The tenant's LPN sequence AND the caps of every line serialise here
      // (its own key, never ':grn-seq' — A7).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${command.tenantId} || ':lpn-seq', 0))`);
      // The same-key race: a duplicate parked on the lock wakes to the winner's snapshot.
      const replayedUnderLock = await this.replay<MintLpnsSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;

      const lineIds = lines.map((line) => line.grnLineId);
      const lineRows = await tx
        .select({
          id: goodsReceiptLines.id,
          skuId: goodsReceiptLines.skuId,
          batchId: goodsReceiptLines.batchId,
          appliedQty: goodsReceiptLines.appliedQty,
        })
        .from(goodsReceiptLines)
        .where(and(eq(goodsReceiptLines.tenantId, command.tenantId), eq(goodsReceiptLines.grnId, grn.id), inArray(goodsReceiptLines.id, lineIds)));
      const lineById = new Map(lineRows.map((row) => [row.id, row]));
      const missing = lineIds.filter((id) => !lineById.has(id));
      if (missing.length > 0) {
        throw new ProblemException(
          'not-found',
          404,
          'GRN line not found',
          `${missing.length === 1 ? 'This line is' : 'These lines are'} not a line of goods receipt "${grn.code}": ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` +${missing.length - 10} more` : ''}.`,
        );
      }
      const skuRows = await tx
        .select({ id: skus.id, code: skus.code, uom: skus.uom, clientId: skus.clientId })
        .from(skus)
        .where(and(eq(skus.tenantId, command.tenantId), inArray(skus.id, [...new Set(lineRows.map((row) => row.skuId))])));
      const skuById = new Map(skuRows.map((row) => [row.id, row]));

      // Each line's cap facts — the one function the list read uses too.
      const capByLine = await lpnLineCapsInTx(tx, command.tenantId, lineRows);

      // ── per line, in request order: precision (behind the replay), the cap, the bound ──
      const planned: { line: (typeof lineRows)[number]; clientId: string; milli: number[] }[] = [];
      for (const line of lines) {
        const row = lineById.get(line.grnLineId)!;
        const sku = skuById.get(row.skuId);
        if (sku === undefined) {
          throw new ProblemException('not-found', 404, 'SKU not found', `The SKU of GRN line "${row.id}" no longer exists in this tenant.`);
        }
        const milli = line.quantities.map((qty) => assertRecordableQuantity(qty, 'quantities', sku.uom, uomPrecision(sku.uom)));
        if (milli.some((value) => value <= 0)) {
          throw lpnValidation(`Each label quantity must be greater than 0 ${sku.uom}.`);
        }
        const caps = capByLine.get(row.id)!;
        const asked = milli.reduce((sum, value) => sum + value, 0);
        if (asked > caps.unlabelled) {
          throw new ProblemException(
            'lpn-quantity-exceeds-line',
            422,
            'More than the line holds',
            `GRN line of SKU "${sku.code}" can take ${fromMilli(caps.unlabelled)} ${sku.uom} more on labels (${fromMilli(caps.putawayQty)} to put away, ${fromMilli(caps.placed)} already put away, ${fromMilli(caps.active)} on active labels) — ${fromMilli(asked)} cannot be labelled. Void a label to free its quantity.`,
            {
              grnLineId: row.id,
              remaining: fromMilli(caps.unlabelled),
              putawayQty: fromMilli(caps.putawayQty),
              placed: fromMilli(caps.placed),
              labelled: fromMilli(caps.active),
            },
          );
        }
        const already = { n: caps.rows };
        if (already.n + milli.length > MAX_LPNS_PER_LINE) {
          throw new ProblemException(
            'too-many-labels',
            422,
            'Too many labels',
            `A GRN line holds at most ${MAX_LPNS_PER_LINE} labels that are not voided; this mint would give the line of SKU "${sku.code}" ${already.n + milli.length}.`,
            { count: already.n + milli.length, grnLineId: row.id },
          );
        }
        planned.push({ line: row, clientId: sku.clientId, milli });
      }

      // ── the inserts: the next numbers, in request order ────────────────
      const head = await tx
        .select({ n: sql<string>`coalesce(max(${lpns.seq}), 0)::bigint` })
        .from(lpns)
        .where(eq(lpns.tenantId, command.tenantId));
      let seq = Number(head[0]?.n ?? 0);
      const values: (typeof lpns.$inferInsert)[] = [];
      for (const entry of planned) {
        for (const qty of entry.milli) {
          seq += 1;
          values.push({
            id: uuidv7(),
            tenantId: command.tenantId,
            warehouseId: grn.warehouseId,
            grnId: grn.id,
            grnLineId: entry.line.id,
            skuId: entry.line.skuId,
            batchId: entry.line.batchId,
            clientId: entry.clientId,
            seq,
            code: lpnCodeOf(seq),
            qty,
            status: 'active',
            createdBy: command.actorUserId,
          });
        }
      }
      let inserted: Lpn[];
      try {
        // ≤ 1000 rows × 13 columns: far below the 65,535 bind parameters.
        inserted = await tx.insert(lpns).values(values).returning();
      } catch (err) {
        if (isUniqueViolationOn(err, LPN_SEQ_UNIQUE)) {
          // The advisory lock serialises the tenant's mints; this is the backstop.
          throw new ProblemException('conflict', 409, 'LPN numbers taken', 'LPN numbers were taken concurrently — retry.');
        }
        throw err;
      }
      inserted.sort((a, b) => a.seq - b.seq);
      const snapshot: MintLpnsSnapshot = { grnId: grn.id, lpns: await lpnSnapshotsInTx(tx, this.catalog, command.tenantId, inserted) };

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'lpn.minted',
        targetType: 'goods_receipt',
        targetId: grn.id,
        reference: idempotencyKey,
        changes: {
          count: inserted.length,
          firstCode: inserted[0]!.code,
          lastCode: inserted[inserted.length - 1]!.code,
          lines: planned.map((entry) => ({ grnLineId: entry.line.id, labels: entry.milli.length, qty: fromMilli(entry.milli.reduce((s, v) => s + v, 0)) })),
        },
        occurredAt: nowIso(),
      });
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * `lpn.void` — an `active` LPN becomes `voided` (terminal), freeing its
   * quantity. Authority → replay → lock the row (lock only, 404) → replay
   * again → the state guard (409 `lpn-not-active`) → the conditional update
   * → audit `lpn.voided` → the key. The stored snapshot is the voided LPN; a
   * same-key retry re-serves it whatever the row's later state.
   */
  async void(command: VoidLpnCommand, idempotencyKey: string): Promise<VoidLpnSnapshot> {
    const grnId = command.grnId.toLowerCase();
    const lpnId = command.lpnId.toLowerCase();
    const trimmed = typeof command.note === 'string' ? command.note.trim() : '';
    const note = trimmed === '' ? null : trimmed;
    if (!(LPN_VOID_REASON_CODES as readonly string[]).includes(command.reasonCode)) {
      throw lpnValidation(`reasonCode must be one of ${JSON.stringify(LPN_VOID_REASON_CODES)} (got "${command.reasonCode}").`);
    }
    if (note !== null && note.length > LPN_VOID_NOTE_MAX) {
      throw lpnValidation(`The note is at most ${LPN_VOID_NOTE_MAX} characters (got ${note.length}).`);
    }
    if (command.reasonCode === 'other' && note === null) {
      throw lpnValidation('A void with the reason "other" needs a note saying why.');
    }
    const payloadHash = hashCommandPayload({ arm: 'lpn.void', tenantId: command.tenantId, grnId, lpnId, reasonCode: command.reasonCode, note });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'labels.execute');
      const replayed = await this.replay<VoidLpnSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;

      // Lock only (404 when absent) — the state guard sits after the second replay (guide §1).
      const locked = await tx
        .select()
        .from(lpns)
        .where(and(eq(lpns.tenantId, command.tenantId), eq(lpns.grnId, grnId), eq(lpns.id, lpnId)))
        .limit(1)
        .for('update');
      if (locked[0] === undefined) {
        throw new ProblemException('not-found', 404, 'LPN not found', `No LPN with id "${lpnId}" exists on goods receipt "${grnId}".`);
      }
      const replayedUnderLock = await this.replay<VoidLpnSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      const row = locked[0];
      if (row.status !== 'active') {
        throw new ProblemException(
          'lpn-not-active',
          409,
          'LPN not active',
          row.status === 'placed'
            ? `${row.code} was already put away — a placed LPN cannot be voided.`
            : `${row.code} is already voided.`,
          { lpnCode: row.code, lpnStatus: row.status },
        );
      }
      const now = nowIso();
      const updated = await tx
        .update(lpns)
        .set({ status: 'voided', voidedAt: now, voidedBy: command.actorUserId, voidReasonCode: command.reasonCode, voidNote: note, updatedAt: now })
        .where(and(eq(lpns.tenantId, command.tenantId), eq(lpns.id, row.id), eq(lpns.status, 'active')))
        .returning();
      const [lpn] = await lpnSnapshotsInTx(tx, this.catalog, command.tenantId, updated);
      const snapshot: VoidLpnSnapshot = { lpn: lpn! };
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'lpn.voided',
        targetType: 'lpn',
        targetId: row.id,
        reference: idempotencyKey,
        changes: { code: row.code, reasonCode: command.reasonCode, note, qty: fromMilli(row.qty) },
        occurredAt: now,
      });
      await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Every LPN of a receipt in code order (any status), and each line's
   * `unlabelledQty` (base units) from the mint's own cap function — the list
   * read (any member).
   */
  async list(tenantId: string, grnId: string): Promise<LpnListSnapshot> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const grn = await grnHeaderInTx(tx, tenantId, grnId.toLowerCase());
      const rows = await tx
        .select()
        .from(lpns)
        .where(and(eq(lpns.tenantId, tenantId), eq(lpns.grnId, grn.id)))
        .orderBy(asc(lpns.seq));
      const lineRows = await tx
        .select({ id: goodsReceiptLines.id, appliedQty: goodsReceiptLines.appliedQty })
        .from(goodsReceiptLines)
        .where(and(eq(goodsReceiptLines.tenantId, tenantId), eq(goodsReceiptLines.grnId, grn.id)))
        .orderBy(asc(goodsReceiptLines.createdAt), asc(goodsReceiptLines.id));
      const caps = await lpnLineCapsInTx(tx, tenantId, lineRows);
      return {
        items: await lpnSnapshotsInTx(tx, this.catalog, tenantId, rows),
        lines: lineRows.map((line) => ({ grnLineId: line.id, unlabelledQty: fromMilli(caps.get(line.id)!.unlabelled) })),
      };
    });
  }

  private async replay<T>(tx: TenantTx, tenantId: string, key: string, payloadHash: string): Promise<T | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
      .limit(1);
    const existing = rows[0];
    if (existing === undefined) return null;
    if (existing.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return existing.responseSnapshot as T;
  }

  private async writeKey(tx: TenantTx, tenantId: string, key: string, payloadHash: string, snapshot: unknown): Promise<void> {
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
}
