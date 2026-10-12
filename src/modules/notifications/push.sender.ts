import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { AUTH_DATABASE, DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { pushDeliveries, type PushDeliveryRow } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { clearPushTokenIn, getPushTargetsIn, pushTokenOwners } from '../tenancy/tenancy.service';
import { PUSH_GATEWAY, type PushGateway, type PushMessage, type PushTicket } from './push-gateway';
import {
  APPROVAL_PUSH_SOURCES,
  PUSH_BATCH_SIZE,
  PUSH_CONFIG_FAULT_MAX_AGE_MS,
  PUSH_CONFIG_FAULT_RETRY_MS,
  PUSH_KINDS,
  PUSH_MAX_ATTEMPTS,
  PUSH_SENDING_STALE_MS,
  PUSH_TABS,
  PUSH_TTL_SECONDS,
  boundedCode,
  classifyPushCode,
  pushAudienceAllows,
  pushBackoffMs,
  pushCopyFor,
  type ApprovalPushSource,
  type PushKind,
  type PushTab,
} from './push-rules';

/** What one `sendDue` call did (the worker logs it; the suite asserts it). */
export interface PushSendSummary {
  /** Rows claimed this call (≤ `PUSH_BATCH_SIZE`). */
  readonly claimed: number;
  /** Rows actually handed to the gateway. */
  readonly sent: number;
  readonly delivered: number;
  readonly failed: number;
  readonly retried: number;
  /** Rows failed `stale` by the sweep at the start of the call. */
  readonly stale: number;
}

const EMPTY: PushSendSummary = { claimed: 0, sent: 0, delivered: 0, failed: 0, retried: 0, stale: 0 };

/** One claimed row headed for the gateway, with the token it is sent to. */
interface InFlight {
  readonly row: PushDeliveryRow;
  readonly token: string;
  readonly message: PushMessage;
}

const KINDS: ReadonlySet<string> = new Set(PUSH_KINDS);
const TABS: ReadonlySet<string> = new Set(PUSH_TABS);
const APPROVALS: ReadonlySet<string> = new Set(APPROVAL_PUSH_SOURCES);

/**
 * Story 9-2b — the push SENDER, behind `NotificationsFacade.sendDuePushes`
 * (driven per tenant by the jobs shell's `PushSenderWorker`). One call:
 *
 *  1. **Claim** (tenant transaction A): rows `sending` for more than 5
 *     minutes are failed `stale` (the process died mid-send — at-most-once:
 *     they are never re-sent); then up to 100 due `pending` rows are taken
 *     `FOR UPDATE SKIP LOCKED` (a second sender skips them). Each is
 *     re-checked — the device's base eligibility (tenancy's
 *     `getPushTargetsIn`) and its kind's audience (`pushAudienceAllows`) —
 *     and a row that fails is `failed` `ineligible`. Each survivor's token
 *     is then checked for OWNERSHIP across tenants (`pushTokenOwners`, a
 *     read on the BYPASSRLS `AUTH_DATABASE`): if the latest registration of
 *     the token is another device, the row is `failed` `superseded` and the
 *     token cleared from this row's own device (in-tenant — never a
 *     cross-tenant write). The rest are marked `sending`, and A COMMITS.
 *  2. **Send** one batch through the `PushGateway` — outside any transaction.
 *  3. **Outcomes** (tenant transaction B), per ticket: `ok` → `sent`;
 *     permanent → `failed` with the code (`DeviceNotRegistered` also clears
 *     the device's token when it still equals the token sent); transient →
 *     `pending` with `attempts + 1` and backoff, `failed` once the attempts
 *     reach 5; config → logged ONCE for the call, `pending` without spending
 *     an attempt, `failed` once the row is an hour old.
 *
 * Only `sending` rows are touched in B, so a row the stale sweep already
 * failed is never resurrected. Only codes are stored or logged — never a
 * provider message or a token.
 */
@Injectable()
export class PushSender {
  private readonly logger = new Logger('PushSender');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(PUSH_GATEWAY) private readonly gateway: PushGateway,
  ) {}

  async sendDue(tenantId: string): Promise<PushSendSummary> {
    const claim = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const stale = await tx
        .update(pushDeliveries)
        .set({ status: 'failed', errorCode: 'stale', updatedAt: sql`now()` })
        .where(
          and(
            eq(pushDeliveries.tenantId, tenantId),
            eq(pushDeliveries.status, 'sending'),
            sql`${pushDeliveries.updatedAt} < now() - make_interval(secs => ${PUSH_SENDING_STALE_MS / 1000}::double precision)`,
          ),
        )
        .returning({ eventId: pushDeliveries.eventId });

      const due = await tx
        .select()
        .from(pushDeliveries)
        .where(
          and(
            eq(pushDeliveries.tenantId, tenantId),
            eq(pushDeliveries.status, 'pending'),
            lte(pushDeliveries.nextAttemptAt, sql`now()`),
          ),
        )
        .orderBy(asc(pushDeliveries.nextAttemptAt), asc(pushDeliveries.createdAt), asc(pushDeliveries.eventId), asc(pushDeliveries.deviceId))
        .limit(PUSH_BATCH_SIZE)
        .for('update', { skipLocked: true });
      if (due.length === 0) {
        return { stale: stale.length, claimed: 0, failed: 0, inFlight: [] as InFlight[] };
      }

      // The send-time eligibility RE-CHECK.
      const targets = await getPushTargetsIn(tx, tenantId, due.map((row) => row.deviceId));
      const candidates: InFlight[] = [];
      const ineligible: PushDeliveryRow[] = [];
      for (const row of due) {
        const target = targets.get(row.deviceId);
        const message = target === undefined ? null : messageFor(row, target.token);
        if (target === undefined || message === null || !pushAudienceAllows(target, factsOf(row))) {
          ineligible.push(row);
        } else {
          candidates.push({ row, token: target.token, message });
        }
      }

      // The token-OWNERSHIP check (latest registration across tenants wins).
      const owners = await pushTokenOwners(this.authDb, candidates.map((c) => c.token));
      const inFlight: InFlight[] = [];
      const superseded: InFlight[] = [];
      for (const candidate of candidates) {
        const owner = owners.get(candidate.token);
        if (owner === undefined || owner.tenantId !== tenantId || owner.deviceId !== candidate.row.deviceId) {
          superseded.push(candidate);
        } else {
          inFlight.push(candidate);
        }
      }
      for (const lost of superseded) {
        // In-tenant only: the other tenant's row keeps the token it now owns.
        await clearPushTokenIn(tx, tenantId, lost.row.deviceId, lost.token);
      }

      for (const [rows, code] of [
        [ineligible, 'ineligible'],
        [superseded.map((c) => c.row), 'superseded'],
      ] as const) {
        for (const row of rows) {
          await tx
            .update(pushDeliveries)
            .set({ status: 'failed', errorCode: code, updatedAt: sql`now()` })
            .where(keyOf(row));
        }
      }
      for (const { row } of inFlight) {
        await tx
          .update(pushDeliveries)
          .set({ status: 'sending', gateway: this.gateway.mode, updatedAt: sql`now()` })
          .where(keyOf(row));
      }
      return { stale: stale.length, claimed: due.length, failed: ineligible.length + superseded.length, inFlight };
    });

    if (claim.inFlight.length === 0) {
      return { ...EMPTY, stale: claim.stale, claimed: claim.claimed, failed: claim.failed };
    }

    // The ONE network call — no transaction, no lock held.
    let tickets: PushTicket[];
    try {
      tickets = await this.gateway.send(claim.inFlight.map((f) => f.message));
    } catch (err) {
      // The port never throws; a throw is a programming error. The rows stay
      // `sending` and the stale sweep fails them — never a duplicate.
      this.logger.error(`push gateway threw — ${claim.inFlight.length} row(s) left to the stale sweep: ${(err as Error).name}`);
      return { ...EMPTY, stale: claim.stale, claimed: claim.claimed, sent: claim.inFlight.length, failed: claim.failed };
    }

    let delivered = 0;
    let failed = claim.failed;
    let retried = 0;
    const configCodes = new Set<string>();
    await withTenantTransaction(this.db, tenantId, async (tx) => {
      for (const [index, flight] of claim.inFlight.entries()) {
        const ticket: PushTicket = tickets[index] ?? { ok: false, code: 'bad-response' };
        const stillSending = and(keyOf(flight.row), eq(pushDeliveries.status, 'sending'));
        if (ticket.ok) {
          await tx.update(pushDeliveries).set({ status: 'sent', errorCode: null, updatedAt: sql`now()` }).where(stillSending);
          delivered += 1;
          continue;
        }
        const code = boundedCode(ticket.code);
        const kind = classifyPushCode(code);
        if (kind === 'permanent') {
          await tx.update(pushDeliveries).set({ status: 'failed', errorCode: code, updatedAt: sql`now()` }).where(stillSending);
          if (code === 'DeviceNotRegistered') {
            await clearPushTokenIn(tx, tenantId, flight.row.deviceId, flight.token);
          }
          failed += 1;
        } else if (kind === 'transient') {
          const attempts = flight.row.attempts + 1;
          if (attempts >= PUSH_MAX_ATTEMPTS) {
            await tx
              .update(pushDeliveries)
              .set({ status: 'failed', errorCode: code, attempts, updatedAt: sql`now()` })
              .where(stillSending);
            failed += 1;
          } else {
            await tx
              .update(pushDeliveries)
              .set({
                status: 'pending',
                errorCode: code,
                attempts,
                nextAttemptAt: sql`now() + make_interval(secs => ${pushBackoffMs(attempts) / 1000}::double precision)`,
                updatedAt: sql`now()`,
              })
              .where(stillSending);
            retried += 1;
          }
        } else {
          configCodes.add(code);
          const expired = sql`${pushDeliveries.createdAt} < now() - make_interval(secs => ${PUSH_CONFIG_FAULT_MAX_AGE_MS / 1000}::double precision)`;
          const updated = await tx
            .update(pushDeliveries)
            .set({
              status: sql`case when ${expired} then 'failed' else 'pending' end`,
              errorCode: code,
              nextAttemptAt: sql`now() + make_interval(secs => ${PUSH_CONFIG_FAULT_RETRY_MS / 1000}::double precision)`,
              updatedAt: sql`now()`,
            })
            .where(stillSending)
            .returning({ status: pushDeliveries.status });
          if (updated[0]?.status === 'failed') failed += 1;
          else retried += 1;
        }
      }
    });
    if (configCodes.size > 0) {
      // Once per call (one call per tenant per tick): the deployment's
      // credentials are wrong. The code only — never a provider message.
      this.logger.error(
        `push gateway refused the credentials (${[...configCodes].join(', ')}) — check EXPO_ACCESS_TOKEN; rows retried, failed after 1 h`,
      );
    }
    return { stale: claim.stale, claimed: claim.claimed, sent: claim.inFlight.length, delivered, failed, retried };
  }
}

function keyOf(row: PushDeliveryRow) {
  return and(
    eq(pushDeliveries.tenantId, row.tenantId),
    eq(pushDeliveries.eventId, row.eventId),
    eq(pushDeliveries.deviceId, row.deviceId),
  );
}

function factsOf(row: PushDeliveryRow): { kind: PushKind; warehouseId: string | null; approvalSource: ApprovalPushSource | null } {
  return {
    kind: row.kind as PushKind,
    warehouseId: row.warehouseId,
    approvalSource: row.approvalSource !== null && APPROVALS.has(row.approvalSource) ? (row.approvalSource as ApprovalPushSource) : null,
  };
}

/** The wire message for a row — fixed copy, `data: {kind, tab}`, nothing else; null for an unknown shape. */
function messageFor(row: PushDeliveryRow, token: string): PushMessage | null {
  if (!KINDS.has(row.kind) || !TABS.has(row.tab)) return null;
  const tab = row.tab as PushTab;
  const copy = pushCopyFor(row.kind as PushKind, tab);
  if (copy === null) return null;
  return {
    to: token,
    title: copy.title,
    body: copy.body,
    data: { kind: row.kind, tab },
    ttl: PUSH_TTL_SECONDS,
    channelId: 'work',
    priority: 'high',
  };
}
