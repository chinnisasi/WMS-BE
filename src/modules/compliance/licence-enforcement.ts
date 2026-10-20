/**
 * Story 1-6d — licence ENFORCEMENT: the switch read and the ONE coverage
 * check the goods receipt and the order create run while it is on.
 *
 * Free functions over the caller's transaction, importing only
 * `drizzle-orm` and `shared/` (pinned by `test/architecture.spec.ts`):
 * receiving and orders import them directly, never the compliance Nest
 * module — compliance already forward-references inbound and outbound, and
 * tenancy imports compliance, so a module import back would close a cycle.
 *
 * The rule is 1-6c's, unchanged (`shared/primitives/licence.ts`): for a
 * (client C, site W) pair each need requires a CLIENT licence of a covering
 * kind held by C — for W or for no site — AND a SITE licence of a covering
 * kind held by W, each valid on the date asked about. The `self` client
 * needs only the site licence.
 *
 * Licences are read WITHOUT a lock (the 1-2b receiving-policy stance): a
 * receipt or an order sees the licences committed when it reads them; a
 * withdrawal racing an order is not serialised against it (PENDING).
 */
import { and, eq } from 'drizzle-orm';
import { licencePolicies, licences } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import {
  LICENCE_NEEDS,
  clientLicenceCovers,
  licenceFacts,
  siteLicenceCovers,
  missingLicencePhrase,
  type LicenceHolder,
  type LicenceNeed,
} from '../../shared/primitives/licence';
import { istDateOf } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * The licence clock (IMPLEMENTATION-GUIDE §7c): "today" for the 1-6c reads,
 * the edit's warning comparison and — 1-6d — the order create's one captured
 * IST date. Tests ASSIGN `now` (jest's `restoreMocks` would undo a spy) and
 * restore it after. `licence.command.ts` re-exports this same object.
 */
export const licenceClock = { now: (): number => Date.now() };

/** The IST calendar date the licence clock reads. */
export function licenceToday(): string {
  return istDateOf(new Date(licenceClock.now()).toISOString());
}

/** Whether the tenant's licence enforcement is on — a missing policy row means off (decision 7). */
export async function licenceEnforcedInTx(tx: TenantTx, tenantId: string): Promise<boolean> {
  const rows = await tx
    .select({ enforce: licencePolicies.enforce })
    .from(licencePolicies)
    .where(eq(licencePolicies.tenantId, tenantId))
    .limit(1);
  return rows[0]?.enforce === true;
}

/** One goods owner whose needs are checked at the site: a SKU (its code and its client). */
export interface LicenceParty {
  readonly clientId: string;
  /** The tenant's own `self` client — needs only the site licence. */
  readonly systemOwned: boolean;
  readonly skuCode: string;
  /** `needsOf(sku)` — empty for goods that need no licence. */
  readonly needs: readonly LicenceNeed[];
}

/** One need not covered, and which holder lacks the licence. */
export interface UncoveredNeed {
  readonly skuCode: string;
  readonly clientId: string;
  readonly need: LicenceNeed;
  readonly holder: LicenceHolder;
}

/**
 * The uncovered needs of `parties` at `warehouseId` on the IST `date`, in a
 * stable order: by SKU code, then client, then need (vocabulary order), the
 * client holder before the site. Each (party, need) yields at most two items
 * (client, site). A party with no needs yields nothing; no needs at all
 * reads no licence.
 */
export async function licenceCoverageInTx(
  tx: TenantTx,
  args: {
    readonly tenantId: string;
    readonly warehouseId: string;
    readonly date: string;
    readonly parties: readonly LicenceParty[];
  },
): Promise<UncoveredNeed[]> {
  if (!args.parties.some((party) => party.needs.length > 0)) return [];
  const rows = await tx
    .select({
      clientId: licences.clientId,
      warehouseId: licences.warehouseId,
      kind: licences.kind,
      status: licences.status,
      validFrom: licences.validFrom,
      validUntil: licences.validUntil,
    })
    .from(licences)
    .where(and(eq(licences.tenantId, args.tenantId), eq(licences.status, 'active')));
  const facts = rows.map(licenceFacts);

  const seen = new Set<string>();
  const uncovered: UncoveredNeed[] = [];
  for (const party of args.parties) {
    for (const need of party.needs) {
      const key = `${party.clientId}|${party.skuCode}|${need}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (
        !party.systemOwned &&
        !facts.some((licence) => clientLicenceCovers(licence, party.clientId, args.warehouseId, need, args.date))
      ) {
        uncovered.push({ skuCode: party.skuCode, clientId: party.clientId, need, holder: 'client' });
      }
      if (!facts.some((licence) => siteLicenceCovers(licence, args.warehouseId, need, args.date))) {
        uncovered.push({ skuCode: party.skuCode, clientId: party.clientId, need, holder: 'site' });
      }
    }
  }
  const needRank = (need: LicenceNeed): number => LICENCE_NEEDS.indexOf(need);
  return uncovered.sort(
    (a, b) =>
      compare(a.skuCode, b.skuCode) ||
      compare(a.clientId, b.clientId) ||
      needRank(a.need) - needRank(b.need) ||
      (a.holder === b.holder ? 0 : a.holder === 'client' ? -1 : 1),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Story 1-6d (decision 4) — 409 `licence-not-covered` for an order: the
 * detail lists each SKU, its missing need and the holder, sorted, one entry
 * per uncovered (SKU, need, holder), separated by "; " —
 * `RICE-5KG — needs an FSSAI licence (site "WH-PUN")`; `extensions.skuCodes`
 * carries the SKU codes (sorted, distinct), the `sku-inactive` precedent.
 */
export function licenceNotCovered(uncovered: readonly UncoveredNeed[], siteCode: string): ProblemException {
  const entries = [...new Set(uncovered.map((item) => `${item.skuCode} — ${missingLicencePhrase(item.need, item.holder, siteCode)}`))].sort();
  const skuCodes = [...new Set(uncovered.map((item) => item.skuCode))].sort();
  return new ProblemException(
    'licence-not-covered',
    409,
    'No valid licence covers the goods',
    `No valid licence covers this order's drug or food goods at site "${siteCode}" today: ${entries.join('; ')}. Add or renew the licence, then place the order again.`,
    { skuCodes },
  );
}
