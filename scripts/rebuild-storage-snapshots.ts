/**
 * Story 21-4 — verify (default) or rebuild (`--write`) one scope's daily
 * storage snapshots from the ledger (AD-25: the snapshots are a rebuildable
 * projection, and a rebuild is the test).
 *
 * Verify re-folds the scope from genesis through its watermark and diffs the
 * `(day, uom, on_hand_milli)` set against the stored rows — it writes
 * nothing. `--write` deletes the scope's rows and rewrites them from the
 * re-fold under the scope's advisory lock (the snapshot job waits behind
 * it); the watermark never moves. Exit code 0 = no drift (or rebuilt), 1 =
 * drift found on a dry run, 2 = bad arguments or a failure.
 *
 * The tenant's own `self` client is never snapshotted and is refused.
 *
 * Usage (from wms-be; DATABASE_URL from .env — a role that can set the
 * tenant scope, as the app's):
 *   bun scripts/rebuild-storage-snapshots.ts --tenant <uuid> --client <uuid> --warehouse <uuid> [--write]
 */

/* eslint-disable no-console */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BillingModule } from '../src/modules/billing/billing.module';
import { BillingFacade } from '../src/modules/billing/billing.facade';
import { UUID_RE } from '../src/shared/primitives/ids';

interface Args {
  readonly tenantId: string;
  readonly clientId: string;
  readonly warehouseId: string;
  readonly write: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string => {
    const index = argv.indexOf(flag);
    const found = index === -1 ? undefined : argv[index + 1];
    if (found === undefined || !UUID_RE.test(found)) {
      throw new Error(`${flag} <uuid> is required`);
    }
    return found;
  };
  return {
    tenantId: value('--tenant'),
    clientId: value('--client'),
    warehouseId: value('--warehouse'),
    write: argv.includes('--write'),
  };
}

@Module({ imports: [BillingModule] })
class RebuildModule {}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('usage: bun scripts/rebuild-storage-snapshots.ts --tenant <uuid> --client <uuid> --warehouse <uuid> [--write]');
    return 2;
  }
  const app = await NestFactory.createApplicationContext(RebuildModule, { logger: ['error', 'warn'] });
  try {
    const billing = app.get(BillingFacade);
    const { tenantId, clientId, warehouseId } = args;
    if (!args.write) {
      const report = await billing.verifySnapshots(tenantId, clientId, warehouseId);
      console.log(
        JSON.stringify(
          { mode: 'verify (dry run)', scope: { tenantId, clientId, warehouseId }, watermark: report.lastDay, expectedRows: report.expectedRows, storedRows: report.storedRows, drift: report.drift },
          null,
          2,
        ),
      );
      return report.drift.length === 0 ? 0 : 1;
    }
    // --write: the drift BEFORE the rebuild (what was wrong), then the
    // rebuild, then a fresh verify — the drift AFTER (what is still wrong).
    const before = await billing.rebuildSnapshots(tenantId, clientId, warehouseId);
    const after = await billing.verifySnapshots(tenantId, clientId, warehouseId);
    console.log(
      JSON.stringify(
        {
          mode: 'rebuild',
          scope: { tenantId, clientId, warehouseId },
          watermark: after.lastDay,
          driftBefore: { expectedRows: before.expectedRows, storedRows: before.storedRows, drift: before.drift },
          driftAfter: { expectedRows: after.expectedRows, storedRows: after.storedRows, drift: after.drift },
        },
        null,
        2,
      ),
    );
    console.log(after.drift.length === 0 ? `rebuilt — ${before.drift.length} drift(s) before, verify now clean` : `rebuilt, but ${after.drift.length} value(s) still differ`);
    return after.drift.length === 0 ? 0 : 1;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(2);
  },
);
