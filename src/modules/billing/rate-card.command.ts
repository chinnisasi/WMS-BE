import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, rateCardLines, rateCards, type RateCard } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { addIsoDays, isIsoDate, istDateOf, istMidnightOf, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { getClientStatusInTx, lockClientInTx, type LockedClientFacts } from '../clients/clients.facade';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { linesByCardInTx, rateCardNotFound, toRateCardSnapshot, type RateCardSnapshot } from './billing.facade';
import { lineProblems, sortLines, type RateCardLineInput } from './rate-cards';

/**
 * The command clock (story 21-3). "Today" and "now" for the effective-date
 * and cancel rules are read here — never from the database — so a test can
 * move the clock across an IST midnight and prove a committed activation
 * still replays (the time-tightening rules sit BEHIND the replay lookup).
 */
export const rateCardClock = {
  now: (): number => Date.now(),
};

export interface CreateRateCardDraftCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId: string;
  readonly lines: readonly RateCardLineInput[];
}

export interface ReplaceRateCardLinesCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly rateCardId: string;
  readonly lines: readonly RateCardLineInput[];
}

export interface RateCardTargetCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly rateCardId: string;
}

export interface ActivateRateCardCommand extends RateCardTargetCommand {
  /** The IST date (`YYYY-MM-DD`) the card takes effect from, at IST midnight. */
  readonly effectiveFrom: string;
}

/** The API response body for a card mutation (the idempotency snapshot). */
export interface RateCardMutationSnapshot {
  readonly rateCard: RateCardSnapshot;
}

type AuditAction =
  | 'rate_card.drafted'
  | 'rate_card.lines-replaced'
  | 'rate_card.discarded'
  | 'rate_card.activated'
  | 'rate_card.cancelled'
  | 'rate_card.superseded'
  | 'rate_card.reopened';

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const OPEN_CARD_INDEX = 'rate_cards_one_open_per_client';

/** The canonical line form the hash and the write both use. */
function normalizeLines(lines: readonly RateCardLineInput[]): RateCardLineInput[] {
  return sortLines(lines).map((line) => ({
    chargeCode: line.chargeCode,
    basis: line.basis,
    amountPaise: line.amountPaise,
  }));
}

/**
 * Rate cards (story 21-3, FR-77, CAP-4) — the house skeleton
 * (IMPLEMENTATION-GUIDE §1) on every command: the payload is normalised and
 * hashed BEFORE the transaction; inside it, authority (`rates.manage` —
 * owner + accountant, re-read from the DB) → replay → parent lookups → locks
 * → replay again under the lock → state guards → the write → audit → the
 * idempotency key LAST. The time-tightening rules ("≥ today", "≥ tomorrow",
 * "cancel only before its date") run behind the replay lookup, on
 * `rateCardClock`, so a committed op re-serves its snapshot after midnight.
 *
 * Lock discipline: activate and cancel take the CLIENT row (`FOR UPDATE`,
 * through the clients facade) and then every card of that client (`FOR
 * UPDATE`, by id) — every dated transition of one client is serialised, so
 * two activations can never interleave. Replace and discard lock only their
 * own card row. No command locks a card before the client row, so there is
 * no cycle.
 *
 * No outbox event — nothing consumes a card's existence until metering
 * (21-4) reads it through `BillingFacade`.
 */
@Injectable()
export class RateCardCommand {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async createDraft(command: CreateRateCardDraftCommand, idempotencyKey: string): Promise<RateCardMutationSnapshot> {
    const lines = normalizeLines(command.lines);
    const payloadHash = hashCommandPayload({ tenantId: command.tenantId, clientId: command.clientId, lines });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'rates.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as RateCardMutationSnapshot;

      if (!UUID_RE.test(command.clientId)) throw clientIdNotFound(command.clientId);
      assertPricedClient(await getClientStatusInTx(tx, command.tenantId, command.clientId));
      assertLines(lines);

      const id = uuidv7();
      const inserted = await tx
        .insert(rateCards)
        .values({
          id,
          tenantId: command.tenantId,
          clientId: command.clientId,
          status: 'draft',
          createdBy: command.actorUserId,
        })
        .returning();
      await this.insertLines(tx, inserted[0]!, lines);
      const snapshot: RateCardMutationSnapshot = { rateCard: toRateCardSnapshot(inserted[0]!, lines) };

      await this.audit(tx, command, 'rate_card.drafted', id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  async replaceDraftLines(command: ReplaceRateCardLinesCommand, idempotencyKey: string): Promise<RateCardMutationSnapshot> {
    const lines = normalizeLines(command.lines);
    const payloadHash = hashCommandPayload({ tenantId: command.tenantId, cardId: command.rateCardId, lines });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'rates.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as RateCardMutationSnapshot;

      const card = await this.lockCard(tx, command.tenantId, command.rateCardId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as RateCardMutationSnapshot;
      assertDraft(card, 'edited');
      assertLines(lines);

      await tx.delete(rateCardLines).where(and(eq(rateCardLines.tenantId, command.tenantId), eq(rateCardLines.rateCardId, card.id)));
      await this.insertLines(tx, card, lines);
      const updated = await tx
        .update(rateCards)
        .set({ updatedAt: nowIso() })
        .where(and(eq(rateCards.tenantId, command.tenantId), eq(rateCards.id, card.id)))
        .returning();
      const snapshot: RateCardMutationSnapshot = { rateCard: toRateCardSnapshot(updated[0]!, lines) };

      await this.audit(tx, command, 'rate_card.lines-replaced', card.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Discard a draft: its lines and the card row are deleted (only a draft is
   * ever deleted — the trigger refuses any other). The DELETE verb has no
   * snapshot to serve: a replay under the same key settles (204), a repeat
   * under a NEW key is 404 (the `channels.controller.ts` disconnect
   * precedent).
   */
  async discardDraft(command: RateCardTargetCommand, idempotencyKey: string): Promise<void> {
    // The arm keeps this hash apart from `cancel`'s identical shape.
    const payloadHash = hashCommandPayload({ arm: 'discard', tenantId: command.tenantId, cardId: command.rateCardId });

    await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'rates.manage');
      if ((await this.replay(tx, command.tenantId, idempotencyKey, payloadHash)) !== null) return;

      const card = await this.lockCard(tx, command.tenantId, command.rateCardId);
      if ((await this.replay(tx, command.tenantId, idempotencyKey, payloadHash)) !== null) return;
      assertDraft(card, 'discarded');

      await tx.delete(rateCardLines).where(and(eq(rateCardLines.tenantId, command.tenantId), eq(rateCardLines.rateCardId, card.id)));
      await tx.delete(rateCards).where(and(eq(rateCards.tenantId, command.tenantId), eq(rateCards.id, card.id)));

      await this.audit(tx, command, 'rate_card.discarded', card.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, {
        rateCardId: card.id,
        discarded: true,
      });
    });
  }

  /**
   * Activate draft B from IST date F. Under the client row lock and every
   * card of the client:
   *   - F ≥ today (IST) when the client has no `active`/`superseded` card,
   *     else F ≥ tomorrow — no past hour is ever repriced (decision 3);
   *   - F is later than every non-cancelled card's `effective_from`;
   *   - B has at least one line;
   *   - the previous open card gets `effective_to = F` and `superseded`
   *     BEFORE B becomes `active` (the one-open-card index).
   */
  async activate(command: ActivateRateCardCommand, idempotencyKey: string): Promise<RateCardMutationSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      cardId: command.rateCardId,
      effectiveFrom: command.effectiveFrom,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'rates.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as RateCardMutationSnapshot;

      if (typeof command.effectiveFrom !== 'string' || !isIsoDate(command.effectiveFrom)) {
        throw new ProblemException(
          'validation-failed',
          400,
          'Invalid effective date',
          `effectiveFrom must be a real calendar date YYYY-MM-DD (got ${JSON.stringify(command.effectiveFrom)}).`,
        );
      }
      const { client, cards, target } = await this.lockClientCards(tx, command.tenantId, command.rateCardId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as RateCardMutationSnapshot;

      assertDraft(target, 'activated');
      assertPricedClient(client);

      // The time-tightening rules — behind the replay lookup, on the clock.
      const today = istDateOf(new Date(rateCardClock.now()).toISOString());
      const hasDated = cards.some((card) => card.status === 'active' || card.status === 'superseded');
      const earliest = hasDated ? addIsoDays(today, 1) : today;
      if (command.effectiveFrom < earliest) {
        throw new ProblemException(
          'rate-card-effective-date',
          400,
          'Effective date too early',
          hasDated
            ? `A replacement card takes effect tomorrow (IST) at the earliest — ${earliest} or later (got ${command.effectiveFrom}); no hour already passed is repriced.`
            : `A client's first card takes effect today (IST) or later — ${earliest} or later (got ${command.effectiveFrom}).`,
        );
      }
      const effectiveFromAt = istMidnightOf(command.effectiveFrom);
      const latest = cards
        .filter((card) => card.id !== target.id && card.status !== 'cancelled' && card.effectiveFrom !== null)
        .map((card) => new Date(card.effectiveFrom!).toISOString())
        .sort()
        .at(-1);
      if (latest !== undefined && effectiveFromAt <= latest) {
        throw new ProblemException(
          'rate-card-effective-overlap',
          409,
          'Effective date not after the latest card',
          `A new card must take effect after every existing card — after ${istDateOf(latest)} (got ${command.effectiveFrom}).`,
        );
      }
      const lines = await linesByCardInTx(tx, command.tenantId, [target.id]);
      const targetLines = lines.get(target.id) ?? [];
      if (targetLines.length === 0) {
        throw new ProblemException(
          'rate-card-no-lines',
          409,
          'Rate card has no lines',
          'A card must price at least one charge before it is activated.',
        );
      }

      const now = nowIso();
      // 1. Close the previous open card at F — BEFORE B becomes active.
      const open = cards.find((card) => card.id !== target.id && card.status === 'active' && card.effectiveTo === null);
      if (open !== undefined) {
        await tx
          .update(rateCards)
          .set({ status: 'superseded', effectiveTo: effectiveFromAt, updatedAt: now })
          .where(and(eq(rateCards.tenantId, command.tenantId), eq(rateCards.id, open.id), eq(rateCards.status, 'active')));
        await this.audit(tx, command, 'rate_card.superseded', open.id, idempotencyKey);
      }

      // 2. B becomes active from F.
      let activated: RateCard;
      try {
        const rows = await tx
          .update(rateCards)
          .set({
            status: 'active',
            effectiveFrom: effectiveFromAt,
            activatedBy: command.actorUserId,
            activatedAt: now,
            updatedAt: now,
          })
          .where(and(eq(rateCards.tenantId, command.tenantId), eq(rateCards.id, target.id), eq(rateCards.status, 'draft')))
          .returning();
        activated = rows[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, OPEN_CARD_INDEX)) {
          throw new ProblemException(
            'conflict',
            409,
            'Another card of this client is open',
            'A concurrent change left another open card for this client — reload and retry.',
          );
        }
        throw err;
      }
      const snapshot: RateCardMutationSnapshot = { rateCard: toRateCardSnapshot(activated, targetLines) };

      await this.audit(tx, command, 'rate_card.activated', target.id, idempotencyKey);
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /**
   * Cancel a scheduled card: any dated card (`active`, or `superseded` by a
   * later card) whose `effective_from` is still in the future on the command
   * clock — decision 3, "a card whose date has not arrived can be
   * cancelled". It becomes `cancelled` (never in force; its window clears),
   * and its predecessor — the card whose `effective_to` is this card's
   * `effective_from` — inherits this card's end: an open-ended card reopens
   * its predecessor (`active`, `effective_to` null); a card already followed
   * by a later one extends its predecessor to that later card's date (stays
   * `superseded`). The cancel lands first: reopening while this card is
   * still the open one would break the one-open-card index.
   */
  async cancel(command: RateCardTargetCommand, idempotencyKey: string): Promise<RateCardMutationSnapshot> {
    const payloadHash = hashCommandPayload({ arm: 'cancel', tenantId: command.tenantId, cardId: command.rateCardId });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'rates.manage');
      const replayed = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as RateCardMutationSnapshot;

      const { cards, target } = await this.lockClientCards(tx, command.tenantId, command.rateCardId);
      const replayedUnderLock = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock as RateCardMutationSnapshot;

      const nowMs = rateCardClock.now();
      const dated = target.status === 'active' || target.status === 'superseded';
      if (!dated || target.effectiveFrom === null || Date.parse(target.effectiveFrom) <= nowMs) {
        throw new ProblemException(
          'rate-card-not-cancellable',
          409,
          'Rate card cannot be cancelled',
          dated && target.effectiveFrom !== null
            ? `This card has been in force since ${istDateOf(new Date(target.effectiveFrom).toISOString())} — only a card whose date has not arrived can be cancelled. Activate a replacement instead.`
            : `This card is ${target.status} — only a dated card whose date has not arrived can be cancelled.`,
        );
      }

      const now = nowIso();
      const fromIso = new Date(target.effectiveFrom).toISOString();
      const inheritedEnd = target.effectiveTo === null ? null : new Date(target.effectiveTo).toISOString();
      const cancelledRows = await tx
        .update(rateCards)
        .set({ status: 'cancelled', effectiveTo: null, cancelledBy: command.actorUserId, cancelledAt: now, updatedAt: now })
        .where(and(eq(rateCards.tenantId, command.tenantId), eq(rateCards.id, target.id), eq(rateCards.status, target.status)))
        .returning();
      await this.audit(tx, command, 'rate_card.cancelled', target.id, idempotencyKey);

      const predecessor = cards.find(
        (card) => card.status === 'superseded' && card.effectiveTo !== null && new Date(card.effectiveTo).toISOString() === fromIso,
      );
      if (predecessor !== undefined) {
        await tx
          .update(rateCards)
          .set(
            inheritedEnd === null
              ? { status: 'active', effectiveTo: null, updatedAt: now }
              : { effectiveTo: inheritedEnd, updatedAt: now },
          )
          .where(and(eq(rateCards.tenantId, command.tenantId), eq(rateCards.id, predecessor.id), eq(rateCards.status, 'superseded')));
        await this.audit(tx, command, 'rate_card.reopened', predecessor.id, idempotencyKey);
      }

      const lines = await linesByCardInTx(tx, command.tenantId, [target.id]);
      const snapshot: RateCardMutationSnapshot = {
        rateCard: toRateCardSnapshot(cancelledRows[0]!, lines.get(target.id) ?? []),
      };
      await this.writeIdempotencyKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
  }

  /** Lock one card row (`FOR UPDATE`), 404 when absent (unknown, foreign or malformed id). */
  private async lockCard(tx: TenantTx, tenantId: string, rateCardId: string): Promise<RateCard> {
    if (!UUID_RE.test(rateCardId)) throw rateCardNotFound(rateCardId);
    const rows = await tx
      .select()
      .from(rateCards)
      .where(and(eq(rateCards.tenantId, tenantId), eq(rateCards.id, rateCardId)))
      .limit(1)
      .for('update');
    if (rows[0] === undefined) throw rateCardNotFound(rateCardId);
    return rows[0];
  }

  /**
   * The dated-transition lock: find the card's client (404 if the card is
   * absent), lock the client row, then every card of that client by id —
   * and re-read the target from the locked set.
   */
  private async lockClientCards(
    tx: TenantTx,
    tenantId: string,
    rateCardId: string,
  ): Promise<{ client: LockedClientFacts; cards: RateCard[]; target: RateCard }> {
    if (!UUID_RE.test(rateCardId)) throw rateCardNotFound(rateCardId);
    const found = await tx
      .select({ clientId: rateCards.clientId })
      .from(rateCards)
      .where(and(eq(rateCards.tenantId, tenantId), eq(rateCards.id, rateCardId)))
      .limit(1);
    if (found[0] === undefined) throw rateCardNotFound(rateCardId);
    const client = await lockClientInTx(tx, tenantId, found[0].clientId);
    const cards = await tx
      .select()
      .from(rateCards)
      .where(and(eq(rateCards.tenantId, tenantId), eq(rateCards.clientId, client.id)))
      .orderBy(asc(rateCards.id))
      .for('update');
    const target = cards.find((card) => card.id === rateCardId);
    if (target === undefined) throw rateCardNotFound(rateCardId);
    return { client, cards, target };
  }

  private async insertLines(tx: TenantTx, card: RateCard, lines: readonly RateCardLineInput[]): Promise<void> {
    if (lines.length === 0) return;
    await tx.insert(rateCardLines).values(
      lines.map((line) => ({
        id: uuidv7(),
        tenantId: card.tenantId,
        clientId: card.clientId,
        rateCardId: card.id,
        chargeCode: line.chargeCode,
        basis: line.basis,
        amountPaise: line.amountPaise,
      })),
    );
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<unknown> {
    const existing = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = existing[0];
    if (row === undefined) return null;
    if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return row.responseSnapshot;
  }

  private async audit(
    tx: TenantTx,
    command: { tenantId: string; actorUserId: string },
    action: AuditAction,
    rateCardId: string,
    reference: string,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      action,
      targetType: 'rate_card',
      targetId: rateCardId,
      reference,
      occurredAt: nowIso(),
    });
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

/** Cards are refused for the tenant's own `self` client (400) and a non-active client (409). */
function assertPricedClient(client: LockedClientFacts): void {
  if (client.systemOwned) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Your own company has no rate card',
      "Rate cards price a client brand's storage and handling — the tenant's own client is never billed.",
    );
  }
  if (client.status !== 'active') {
    throw new ProblemException(
      'client-not-active',
      409,
      'Client is not active',
      `Client ${client.code} is ${client.status} — rate cards are drafted and activated only for an active client.`,
    );
  }
}

function assertDraft(card: RateCard, verb: 'edited' | 'discarded' | 'activated'): void {
  if (card.status !== 'draft') {
    throw new ProblemException(
      'rate-card-not-draft',
      409,
      'Rate card is not a draft',
      `This card is ${card.status} — only a draft can be ${verb}. An activated card never changes; draft a new card instead.`,
    );
  }
}

function assertLines(lines: readonly RateCardLineInput[]): void {
  const problems = lineProblems(lines);
  if (problems.length > 0) {
    throw new ProblemException('validation-failed', 400, 'Invalid rate card lines', problems.join('; '));
  }
}

function clientIdNotFound(clientId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Client not found', `No client with id "${clientId}" exists in this tenant.`);
}
