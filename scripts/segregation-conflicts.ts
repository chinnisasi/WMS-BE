/**
 * Story 1-6b (decision 5) — list the bins that ALREADY mix goods the
 * segregation rules keep apart. The rules are not retroactive: a bin mixed
 * before 1-6b (or through a named bypass — `stock.adjust`, count-variance
 * corrections, `qc.released`) is neither moved nor refused until its next
 * gated write. This listing is how an operator finds them.
 *
 * It reads each storage bin's occupants (`quantity > 0`, a non-empty
 * segregation profile — `EMPTY_PROFILE_SQL`), then asks the ONE TypeScript
 * predicate (`goodsConflict`) of every pair of different SKUs in the bin.
 * There is no SQL copy of the rules. System bins (Receiving, QC-HOLD,
 * In-Transit, Returns) are staging and are not listed. Read-only: it
 * writes nothing.
 *
 * Usage (from wms-be; DATABASE_URL from .env — a role that can set the
 * tenant scope, as the app's; tenants are discovered on DATABASE_AUTH_URL,
 * falling back to DATABASE_URL):
 *   bun scripts/segregation-conflicts.ts [--tenant <uuid>] [--json]
 *
 * One line per conflicting pair (`--json`: one JSON object per line, keys
 * tenantId, warehouseCode, binId, binCode, rule, skuA, skuB, detail). Exit
 * code 0 = no mixed bin, 1 = mixed bins listed, 2 = bad arguments, no
 * tenant visible / an unknown --tenant (never a false all-clear), or a
 * failure.
 */

import { and, asc, eq, gt } from 'drizzle-orm';
import { createDatabase, requiredDbUrl } from '../src/shared/db/db';
import { bins, skus, stockOnHand, tenants, warehouses } from '../src/shared/db/schema';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { UUID_RE } from '../src/shared/primitives/ids';
import {
  EMPTY_PROFILE_SQL,
  SEGREGATION_PROFILE_COLUMNS,
  conflictFacts,
  goodsConflict,
  profileOf,
} from '../src/shared/primitives/segregation';

interface MixedPair {
  readonly tenantId: string;
  readonly warehouseCode: string;
  readonly binId: string;
  readonly binCode: string;
  readonly rule: string;
  readonly skuA: string;
  readonly skuB: string;
  readonly detail: string;
}

function parseArgs(argv: readonly string[]): { tenantId: string | null; json: boolean } {
  const index = argv.indexOf('--tenant');
  let tenantId: string | null = null;
  if (index !== -1) {
    const value = argv[index + 1];
    if (value === undefined || !UUID_RE.test(value)) {
      throw new Error('--tenant <uuid> needs a tenant id');
    }
    tenantId = value;
  }
  for (const arg of argv) {
    if (arg.startsWith('--') && arg !== '--tenant' && arg !== '--json') {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return { tenantId, json: argv.includes('--json') };
}

async function main(): Promise<number> {
  let args: { tenantId: string | null; json: boolean };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('usage: bun scripts/segregation-conflicts.ts [--tenant <uuid>] [--json]');
    return 2;
  }
  const db = createDatabase();
  const authDb = createDatabase(process.env.DATABASE_AUTH_URL || requiredDbUrl(), 'auth');
  // Tenants are read on the auth connection (BYPASSRLS in production). An
  // empty answer is never "all clear": an RLS-bound role sees no tenants, and
  // a mistyped --tenant names none — both exit 2, never 0.
  const tenantIds = (
    await authDb
      .select({ id: tenants.id })
      .from(tenants)
      .where(args.tenantId === null ? undefined : eq(tenants.id, args.tenantId))
      .orderBy(asc(tenants.id))
  ).map((row) => row.id);
  if (tenantIds.length === 0) {
    console.error(
      args.tenantId === null
        ? 'No tenants are visible — set DATABASE_AUTH_URL to a role that bypasses RLS (or pass --tenant <uuid>); nothing was checked.'
        : `Tenant ${args.tenantId} does not exist (checked on DATABASE_AUTH_URL, else DATABASE_URL); nothing was checked.`,
    );
    return 2;
  }

  const found: MixedPair[] = [];
  for (const tenantId of tenantIds) {
    const rows = await withTenantTransaction(db, tenantId, (tx) =>
      tx
        .select({
          warehouseCode: warehouses.code,
          binId: bins.id,
          binCode: bins.code,
          skuId: skus.id,
          skuCode: skus.code,
          ...SEGREGATION_PROFILE_COLUMNS,
        })
        .from(stockOnHand)
        .innerJoin(bins, eq(bins.id, stockOnHand.binId))
        .innerJoin(warehouses, eq(warehouses.id, bins.warehouseId))
        .innerJoin(skus, eq(skus.id, stockOnHand.skuId))
        .where(
          and(
            eq(stockOnHand.tenantId, tenantId),
            gt(stockOnHand.quantity, 0),
            eq(bins.systemOwned, false),
            EMPTY_PROFILE_SQL,
          ),
        )
        // One row per (bin, SKU) — the batch arms fold into separate rows.
        .groupBy(warehouses.id, bins.id, skus.id)
        .orderBy(asc(warehouses.code), asc(bins.code), asc(skus.code), asc(skus.id)),
    );
    const byBin = new Map<string, typeof rows>();
    for (const row of rows) {
      byBin.set(row.binId, [...(byBin.get(row.binId) ?? []), row]);
    }
    for (const occupants of byBin.values()) {
      for (let i = 0; i < occupants.length; i++) {
        for (let j = i + 1; j < occupants.length; j++) {
          const a = occupants[i]!;
          const b = occupants[j]!;
          const conflict = goodsConflict(profileOf(a), profileOf(b));
          if (conflict === null) {
            continue;
          }
          const facts = conflictFacts(conflict, profileOf(a), profileOf(b));
          found.push({
            tenantId,
            warehouseCode: a.warehouseCode,
            binId: a.binId,
            binCode: a.binCode,
            rule: conflict.rule,
            skuA: a.skuCode,
            skuB: b.skuCode,
            detail: `Bin "${a.binCode}" holds SKUs "${a.skuCode}" (${facts.a}) and "${b.skuCode}" (${facts.b}), which ${facts.pairVerdict}.`,
          });
        }
      }
    }
  }

  for (const pair of found) {
    process.stdout.write(
      args.json
        ? `${JSON.stringify(pair)}\n`
        : `${pair.tenantId}  ${pair.warehouseCode}/${pair.binCode}  ${pair.rule}  ${pair.detail}\n`,
    );
  }
  if (!args.json) {
    const binCount = new Set(found.map((pair) => pair.binId)).size;
    process.stdout.write(
      binCount === 0
        ? 'No bin mixes goods the segregation rules keep apart.\n'
        : `${binCount} bin(s) mix goods the segregation rules keep apart — relocate at the next move.\n`,
    );
  }
  return found.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(2);
  });
