import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, licences, type LicenceRow } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK, type OutboxSink } from '../../shared/events/outbox.seam';
import { SYSTEM_ACTOR_ID } from '../../shared/primitives/audit';
import { uuidv7 } from '../../shared/primitives/ids';
import {
  LICENCE_NEEDS,
  LICENCE_WARNING_LEAD_DAYS,
  NEED_COVERED_BY,
  clientLicenceCovers,
  daysLeftOf,
  expiryStateOf,
  licenceValidOn,
  needsOf,
  siteLicenceCovers,
  warningState,
  type LicenceExpiryState,
  type LicenceFacts,
  type LicenceKind,
  type LicenceNeed,
  type LicenceStatus,
} from '../../shared/primitives/licence';
import { addIsoDays, nowIso } from '../../shared/primitives/time';
import {
  LICENCE_EXPIRED_EVENT,
  LICENCE_EXPIRY_UPCOMING_EVENT,
  LicenceCommand,
  appendWarningCleared,
  licenceToday,
  toLicenceSnapshot,
  type AddLicenceCommand,
  type EditLicenceCommand,
  type LicenceMutationSnapshot,
  type LicenceSnapshot,
  type WithdrawLicenceCommand,
} from './licence.command';

/** The list read's bound — a tenant's licences are tens, not thousands. */
export const MAX_LICENCE_LIST = 500;

export interface LicenceListFilters {
  readonly clientId?: string;
  readonly warehouseId?: string;
  readonly status?: LicenceStatus;
}

export interface LicenceListItem extends LicenceSnapshot {
  /** The server's badge on `asOfDate` (never the browser's clock). */
  readonly expiryState: LicenceExpiryState;
  /** Whole days from `asOfDate` to `validUntil` (negative once expired); null without a date. */
  readonly daysLeft: number | null;
}

export interface LicenceList {
  /** The IST date the badges were computed for. */
  readonly asOfDate: string;
  readonly items: readonly LicenceListItem[];
}

/** One missing licence where drug or food goods are (decision 2). */
export interface CoverageGap {
  /** `client` — the brand's licence is missing for this site; `site` — the site's own. */
  readonly holder: 'client' | 'site';
  /** The client of a client gap; absent on a site gap. */
  readonly clientId?: string;
  readonly warehouseId: string;
  readonly need: LicenceNeed;
  /** The kinds that would close it (the web words the gap from these). */
  readonly coveredBy: readonly LicenceKind[];
  /** Distinct SKUs needing it there (on hand, or on an open PO or ASN). */
  readonly skuCount: number;
}

export interface CoverageGaps {
  readonly asOfDate: string;
  readonly gaps: readonly CoverageGap[];
}

export interface LicenceSweepSummary {
  readonly raised: number;
  readonly cleared: number;
}

/** The SKU goods filter — a drug schedule, or food (1-6b `isFood`). Kept beside `needsOf`, which decides the needs. */
const GOODS_FILTER = sql`(cardinality(s.drug_schedules) > 0 or (s.food_category is not null and s.food_category <> 'non-food'))`;

/**
 * The licence seam (story 1-6c): the master's three writes (delegated to
 * `LicenceCommand`), the list and the coverage gaps (reads — any staff
 * session, never the portal: the api guard refuses a portal token), and the
 * expiry sweep the jobs shell drives.
 *
 * Compliance READS the clients, warehouses, SKU, stock and inbound-document
 * tables directly (the 12-5 shared-substrate precedent) and imports none of
 * their modules: tenancy imports compliance, so a catalog or tenancy module
 * import would cycle. It writes only `licences` (plus outbox and audit).
 */
@Injectable()
export class LicenceFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(LicenceCommand) private readonly command: LicenceCommand,
  ) {}

  addLicence(command: AddLicenceCommand, idempotencyKey: string): Promise<LicenceMutationSnapshot> {
    return this.command.add(command, idempotencyKey);
  }

  editLicence(command: EditLicenceCommand, idempotencyKey: string): Promise<LicenceMutationSnapshot> {
    return this.command.edit(command, idempotencyKey);
  }

  withdrawLicence(command: WithdrawLicenceCommand, idempotencyKey: string): Promise<LicenceMutationSnapshot> {
    return this.command.withdraw(command, idempotencyKey);
  }

  /**
   * Every licence of the tenant (bounded at `MAX_LICENCE_LIST`), active
   * first, then by `validUntil` (soonest first, none last), each with the
   * server's badge for `asOfDate`. Unknown filter ids read as an empty list.
   */
  async listLicences(tenantId: string, filters: LicenceListFilters = {}, istToday?: string): Promise<LicenceList> {
    const asOfDate = istToday ?? licenceToday();
    const rows = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(licences)
        .where(
          and(
            eq(licences.tenantId, tenantId),
            filters.clientId === undefined ? undefined : eq(licences.clientId, filters.clientId),
            filters.warehouseId === undefined ? undefined : eq(licences.warehouseId, filters.warehouseId),
            filters.status === undefined ? undefined : eq(licences.status, filters.status),
          ),
        )
        .orderBy(asc(licences.status), sql`${licences.validUntil} asc nulls last`, asc(licences.createdAt), asc(licences.id))
        .limit(MAX_LICENCE_LIST),
    );
    return {
      asOfDate,
      items: rows.map((row) => {
        const snapshot = toLicenceSnapshot(row);
        return {
          ...snapshot,
          expiryState: expiryStateOf(snapshot, asOfDate),
          daysLeft: snapshot.status === 'withdrawn' ? null : daysLeftOf(snapshot.validUntil, asOfDate),
        };
      }),
    };
  }

  /**
   * The coverage gaps on `asOfDate` (decisions 2 and 4). A (client, site)
   * pair counts where the client has drug or food goods: stock on hand
   * (`quantity > 0`) at the site, or such a SKU on an open PO line or an
   * open ASN into it — filtered in SQL. Each need of those SKUs requires a
   * client licence (for the site or for no site) AND a site licence, both
   * valid that day. The `self` client needs only the site licence; departed
   * clients are skipped.
   */
  async coverageGaps(tenantId: string, istToday?: string): Promise<CoverageGaps> {
    const asOfDate = istToday ?? licenceToday();
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const goods = (await tx.execute(sql`
        with goods as (
          select s.client_id, soh.warehouse_id, s.id as sku_id
            from stock_on_hand soh
            join skus s on s.id = soh.sku_id and s.tenant_id = soh.tenant_id
           where soh.tenant_id = ${tenantId} and soh.quantity > 0 and ${GOODS_FILTER}
          union
          select s.client_id, po.warehouse_id, s.id
            from purchase_orders po
            join purchase_order_lines pol on pol.po_id = po.id and pol.tenant_id = po.tenant_id
            join skus s on s.id = pol.sku_id and s.tenant_id = pol.tenant_id
           where po.tenant_id = ${tenantId} and po.status = 'open' and pol.status = 'open'
             and pol.received_qty < pol.ordered_qty and ${GOODS_FILTER}
          union
          select s.client_id, a.warehouse_id, s.id
            from advance_shipment_notices a
            join asn_lines al on al.asn_id = a.id and al.tenant_id = a.tenant_id
            join skus s on s.id = al.sku_id and s.tenant_id = al.tenant_id
           where a.tenant_id = ${tenantId} and a.status in ('announced', 'partially_received') and ${GOODS_FILTER}
        )
        select g.client_id as "clientId", g.warehouse_id as "warehouseId", g.sku_id as "skuId",
               c.system_owned as "systemOwned", s.food_category as "foodCategory", s.drug_schedules as "drugSchedules"
          from goods g
          join clients c on c.id = g.client_id and c.tenant_id = ${tenantId} and c.status <> 'departed'
          join skus s on s.id = g.sku_id and s.tenant_id = ${tenantId}
         order by g.warehouse_id, g.client_id, g.sku_id
      `)) as unknown as {
        clientId: string;
        warehouseId: string;
        skuId: string;
        systemOwned: boolean;
        foodCategory: string | null;
        drugSchedules: string[];
      }[];

      const active = await tx
        .select()
        .from(licences)
        .where(and(eq(licences.tenantId, tenantId), eq(licences.status, 'active')));
      const facts = active.map(licenceFacts);

      // (client, site, need) → SKUs, and (site, need) → SKUs.
      const clientNeeds = new Map<string, { clientId: string; warehouseId: string; need: LicenceNeed; skus: Set<string> }>();
      const siteNeeds = new Map<string, { warehouseId: string; need: LicenceNeed; skus: Set<string> }>();
      for (const row of goods) {
        for (const need of needsOf({ foodCategory: row.foodCategory, drugSchedules: row.drugSchedules })) {
          if (!row.systemOwned) {
            const key = `${row.clientId}|${row.warehouseId}|${need}`;
            const entry = clientNeeds.get(key) ?? { clientId: row.clientId, warehouseId: row.warehouseId, need, skus: new Set() };
            entry.skus.add(row.skuId);
            clientNeeds.set(key, entry);
          }
          const siteKey = `${row.warehouseId}|${need}`;
          const site = siteNeeds.get(siteKey) ?? { warehouseId: row.warehouseId, need, skus: new Set() };
          site.skus.add(row.skuId);
          siteNeeds.set(siteKey, site);
        }
      }

      const gaps: CoverageGap[] = [];
      for (const entry of siteNeeds.values()) {
        if (!facts.some((licence) => siteLicenceCovers(licence, entry.warehouseId, entry.need, asOfDate))) {
          gaps.push({ holder: 'site', warehouseId: entry.warehouseId, need: entry.need, coveredBy: NEED_COVERED_BY[entry.need], skuCount: entry.skus.size });
        }
      }
      for (const entry of clientNeeds.values()) {
        if (!facts.some((licence) => clientLicenceCovers(licence, entry.clientId, entry.warehouseId, entry.need, asOfDate))) {
          gaps.push({
            holder: 'client',
            clientId: entry.clientId,
            warehouseId: entry.warehouseId,
            need: entry.need,
            coveredBy: NEED_COVERED_BY[entry.need],
            skuCount: entry.skus.size,
          });
        }
      }
      const needRank = (need: LicenceNeed): number => LICENCE_NEEDS.indexOf(need);
      gaps.sort(
        (a, b) =>
          compare(a.warehouseId, b.warehouseId) ||
          compare(a.holder === 'site' ? '' : (a.clientId ?? ''), b.holder === 'site' ? '' : (b.clientId ?? '')) ||
          needRank(a.need) - needRank(b.need),
      );
      return { asOfDate, gaps };
    });
  }

  /**
   * One expiry sweep of a tenant for `istToday` (decisions 3, 8, 9), in its
   * own tenant transaction. Locks the due rows — active, with a
   * `validUntil` inside the 60-day window, not yet warned for every state —
   * by id `FOR NO KEY UPDATE SKIP LOCKED` (a concurrent sweep or an edit
   * holding a row is skipped this tick), then per row:
   *
   * - raises nothing for a departed client's licence, a historical record
   *   (`validUntil` before the IST date it was added), or one a successor
   *   covers (an active licence of the same client, site and need, valid on
   *   `validUntil + 1`) — but still resolves its open warning (`renewed`
   *   for a successor, `expired` once past `validUntil`) and stamps the warned
   *   date of its current state, with no raise or audit row, so it leaves
   *   the due set (withdrawn licences are outside the filter);
   * - `upcoming`, never warned: raises `licence.expiry_upcoming` with a
   *   fresh warning id;
   * - `expired`, not warned expired: clears the open upcoming entry
   *   (`expired`) first, then raises `licence.expired` with a fresh id.
   *
   * Each raise writes one audit row (system actor). A second run the same
   * day raises nothing — the warned dates are the state.
   */
  async sweepExpiry(tenantId: string, istToday: string): Promise<LicenceSweepSummary> {
    const windowEnd = addIsoDays(istToday, LICENCE_WARNING_LEAD_DAYS);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const due = await tx
        .select()
        .from(licences)
        .where(
          and(
            eq(licences.tenantId, tenantId),
            eq(licences.status, 'active'),
            sql`${licences.validUntil} is not null`,
            sql`${licences.validUntil} <= ${windowEnd}::date`,
            sql`(${licences.upcomingWarnedOn} is null or ${licences.expiredWarnedOn} is null)`,
          ),
        )
        .orderBy(asc(licences.id))
        .for('no key update', { skipLocked: true });
      if (due.length === 0) return { raised: 0, cleared: 0 };

      const context = await this.sweepContext(tx, tenantId, due);
      let raised = 0;
      let cleared = 0;
      for (const row of due) {
        const state = warningState(row.validUntil, istToday);
        if (state === 'none') continue;
        // Decision 9's skips suppress RAISING only: an open warning still
        // resolves, and the row is stamped for its current state (no outbox
        // raise, no audit row) so it leaves the due set.
        const departed = row.clientId !== null && context.departed.has(row.clientId);
        const historical = row.validUntil! < (context.addedOn.get(row.id) ?? istToday);
        const succeeded = !departed && !historical && this.hasSuccessor(row, context.active);
        if (departed || historical || succeeded) {
          let clearedHere = false;
          if (row.openWarningId !== null && (succeeded || state === 'expired')) {
            await appendWarningCleared(this.outbox, tx, tenantId, row, succeeded ? 'renewed' : 'expired');
            cleared += 1;
            clearedHere = true;
          }
          await tx
            .update(licences)
            .set({
              upcomingWarnedOn: row.upcomingWarnedOn ?? istToday,
              ...(state === 'expired' ? { expiredWarnedOn: row.expiredWarnedOn ?? istToday } : {}),
              ...(clearedHere ? { openWarningId: null } : {}),
              updatedAt: nowIso(),
            })
            .where(and(eq(licences.tenantId, tenantId), eq(licences.id, row.id)));
          continue;
        }

        if (state === 'upcoming') {
          if (row.upcomingWarnedOn !== null || row.expiredWarnedOn !== null) continue;
          const warningId = uuidv7();
          await this.raise(tx, tenantId, row, warningId, 'upcoming', context);
          await tx
            .update(licences)
            .set({ upcomingWarnedOn: istToday, openWarningId: warningId, updatedAt: nowIso() })
            .where(and(eq(licences.tenantId, tenantId), eq(licences.id, row.id)));
          raised += 1;
          continue;
        }
        // expired
        if (row.expiredWarnedOn !== null) continue;
        if (row.openWarningId !== null) {
          await appendWarningCleared(this.outbox, tx, tenantId, row, 'expired');
          cleared += 1;
        }
        const warningId = uuidv7();
        await this.raise(tx, tenantId, row, warningId, 'expired', context);
        await tx
          .update(licences)
          .set({
            expiredWarnedOn: istToday,
            // A term the sweep never saw upcoming (it was off) is warned once,
            // expired — and leaves the due set for good.
            upcomingWarnedOn: row.upcomingWarnedOn ?? istToday,
            openWarningId: warningId,
            updatedAt: nowIso(),
          })
          .where(and(eq(licences.tenantId, tenantId), eq(licences.id, row.id)));
        raised += 1;
      }
      return { raised, cleared };
    });
  }

  /** Decision 9's successor: an active licence of the same client, site and need, valid on `validUntil + 1`. */
  private hasSuccessor(row: LicenceRow, active: readonly LicenceRow[]): boolean {
    const dayAfter = addIsoDays(row.validUntil!, 1);
    const kind = row.kind as LicenceKind;
    const need = LICENCE_NEEDS.find((candidate) => NEED_COVERED_BY[candidate].includes(kind));
    if (need === undefined) return false;
    return active.some(
      (other) =>
        other.id !== row.id &&
        other.clientId === row.clientId &&
        other.warehouseId === row.warehouseId &&
        NEED_COVERED_BY[need].includes(other.kind as LicenceKind) &&
        licenceValidOn(licenceFacts(other), dayAfter),
    );
  }

  /** What the sweep needs beside the due rows: added dates, departed clients, holder names, active licences. */
  private async sweepContext(
    tx: TenantTx,
    tenantId: string,
    due: readonly LicenceRow[],
  ): Promise<{
    addedOn: Map<string, string>;
    departed: Set<string>;
    clients: Map<string, string>;
    sites: Map<string, { code: string; name: string }>;
    active: LicenceRow[];
  }> {
    const ids = due.map((row) => row.id);
    const added = (await tx.execute(sql`
      select id, to_char((created_at at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as "addedOn"
        from licences where tenant_id = ${tenantId} and id = any(${sqlUuidArray(ids)})
    `)) as unknown as { id: string; addedOn: string }[];
    const clientRows = (await tx.execute(sql`
      select id, name, status from clients where tenant_id = ${tenantId}
    `)) as unknown as { id: string; name: string; status: string }[];
    const siteRows = (await tx.execute(sql`
      select id, code, name from warehouses where tenant_id = ${tenantId}
    `)) as unknown as { id: string; code: string; name: string }[];
    const active = await tx
      .select()
      .from(licences)
      .where(and(eq(licences.tenantId, tenantId), eq(licences.status, 'active')));
    return {
      addedOn: new Map(added.map((row) => [row.id, row.addedOn])),
      departed: new Set(clientRows.filter((row) => row.status === 'departed').map((row) => row.id)),
      clients: new Map(clientRows.map((row) => [row.id, row.name])),
      sites: new Map(siteRows.map((row) => [row.id, { code: row.code, name: row.name }])),
      active,
    };
  }

  /** One warning raise: the outbox event (the `licence-expiry` entry) and one system audit row. */
  private async raise(
    tx: TenantTx,
    tenantId: string,
    row: LicenceRow,
    warningId: string,
    state: 'upcoming' | 'expired',
    context: { clients: Map<string, string>; sites: Map<string, { code: string; name: string }> },
  ): Promise<void> {
    const site = row.warehouseId === null ? undefined : context.sites.get(row.warehouseId);
    const holder = row.clientId === null ? 'site' : 'client';
    const holderName =
      holder === 'client'
        ? (context.clients.get(row.clientId!) ?? row.clientId!)
        : (site?.name ?? row.warehouseId!);
    const occurredAt = nowIso();
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type: state === 'upcoming' ? LICENCE_EXPIRY_UPCOMING_EVENT : LICENCE_EXPIRED_EVENT,
      occurredAt,
      payload: {
        warningId,
        licenceId: row.id,
        warehouseId: row.warehouseId,
        kind: row.kind,
        number: row.number,
        holder,
        holderName,
        ...(site === undefined ? {} : { siteCode: site.code }),
        validUntil: row.validUntil,
        state,
      },
    });
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId: SYSTEM_ACTOR_ID,
      action: state === 'upcoming' ? 'licence.expiry_upcoming_raised' : 'licence.expired_raised',
      targetType: 'licence',
      targetId: row.id,
      occurredAt,
    });
  }
}

function licenceFacts(row: LicenceRow): LicenceFacts {
  return {
    clientId: row.clientId,
    warehouseId: row.warehouseId,
    kind: row.kind as LicenceKind,
    status: row.status as LicenceStatus,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A uuid[] parameter (each id a bound parameter, cast once). */
function sqlUuidArray(ids: readonly string[]): SQL {
  return sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}
