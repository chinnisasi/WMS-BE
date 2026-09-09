import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The first architecture test in the repo (Story 2.1). It is a pure source
 * scan — no database, no app — so it fails at build time in CI, before any
 * e2e cost, when a new code path:
 *
 *   1. mutates or deletes the append-only ledger tables in code (the DB
 *      trigger is the enforcement backstop; this is the code-side gate),
 *   2. writes any stock/ledger table from outside `src/modules/inventory`
 *      (consumers go through `InventoryFacade` only),
 *   3. opens a second quantity-mutation path — anything but
 *      `ledger.service.ts` writing `stock_on_hand`.
 *
 * It also fails any file outside the inventory module (and the api shell's
 * wiring) that reaches into the module's internals instead of the facade.
 */

const SRC_ROOT = join(__dirname, '..', 'src');

/** The append-only tables: no UPDATE/DELETE from code, ever. */
const LEDGER_TABLES = ['ledgerEvents', 'ledgerAnchors'] as const;
/** All stock-state tables: writes are inventory-module-exclusive. */
const STOCK_TABLES = [...LEDGER_TABLES, 'stockOnHand', 'batchOnHand'] as const;
/**
 * The one file allowed to mutate `stock_on_hand` / `batch_on_hand` (the
 * projection points — Story 2.4 folds the batch arm beside the plain fold,
 * in the same file and transaction).
 */
const PROJECTION_OWNER = join(SRC_ROOT, 'modules', 'inventory', 'ledger.service.ts');

interface ScannedFile {
  readonly path: string;
  readonly source: string;
}

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return tsFilesUnder(full);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

const files: ScannedFile[] = tsFilesUnder(SRC_ROOT)
  .sort()
  .map((path) => ({ path, source: readFileSync(path, 'utf8') }));

/** Drizzle write calls on a table object, e.g. `.insert(stockOnHand)`. */
function drizzleWriteOn(table: string): RegExp {
  return new RegExp(`\\.(insert|update|delete)\\(\\s*${table}\\b`);
}

/** Raw SQL writes to a physical table, e.g. `DELETE FROM ledger_events`. */
function rawWriteOn(physical: string): RegExp {
  return new RegExp(`\\b(insert into|update|delete from)\\s+${physical}\\b`, 'i');
}

const RAW_STOCK_TABLES = 'ledger_events|ledger_anchors|stock_on_hand|batch_on_hand';

describe('architecture: the ledger core is append-only and inventory-module-owned', () => {
  it(
    'every source file is scannable (the tests read the whole tree)',
    () => {
      // A sanity backstop: if the walk ever glob-fails to nothing, the
      // assertions below would pass vacuously.
      expect(files.length).toBeGreaterThan(40);
    },
  );

  it('no code path updates or deletes the ledger tables (append-only, AD-16)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const statement of [
        // Drizzle update/delete on the table objects — `.insert(` stays
        // legal inside the inventory module (the append path itself).
        ...LEDGER_TABLES.map((table) => new RegExp(`\\.(update|delete)\\(\\s*${table}\\b`)),
        // Raw SQL mutations of the physical tables.
        new RegExp('\\b(update|delete from|truncate)\\s+ledger_(events|anchors)\\b', 'i'),
      ]) {
        if (statement.test(file.source)) {
          offenders.push(`${file.path}: /${statement.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no stock-table write happens outside the inventory module', () => {
    const outside = files.filter(
      (file) => !file.path.startsWith(join(SRC_ROOT, 'modules', 'inventory')),
    );
    const offenders: string[] = [];
    for (const file of outside) {
      for (const pattern of [
        ...STOCK_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_STOCK_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('there is exactly one quantity-mutation path: ledger.service.ts owns stock_on_hand (and the batch_on_hand arm)', () => {
    const otherInventoryFiles = files.filter(
      (file) =>
        file.path.startsWith(join(SRC_ROOT, 'modules', 'inventory')) &&
        file.path !== PROJECTION_OWNER,
    );
    const offenders: string[] = [];
    for (const file of otherInventoryFiles) {
      for (const pattern of [
        drizzleWriteOn('stockOnHand'),
        rawWriteOn('stock_on_hand'),
        drizzleWriteOn('batchOnHand'),
        rawWriteOn('batch_on_hand'),
      ]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);

    // The projection point itself must still write them — the test is only
    // meaningful while the single path exists.
    const projectionOwner = readFileSync(PROJECTION_OWNER, 'utf8');
    expect(drizzleWriteOn('stockOnHand').test(projectionOwner)).toBe(true);
    expect(drizzleWriteOn('batchOnHand').test(projectionOwner)).toBe(true);
  });

  it('no other module reaches into the inventory module past the facade', () => {
    // Sibling modules may import ONLY `inventory.facade`. The `api` shell
    // additionally wires `inventory.module` and carries the HTTP DTO — the
    // established controller-in-shell wiring, not a second consumer seam.
    const inventoryInternals = new RegExp(
      'modules/inventory/(?!' +
        '(inventory\\.facade|inventory\\.module|inventory\\.dto)\\b)',
    );
    const inventoryRoot = join(SRC_ROOT, 'modules', 'inventory');
    const siblingModules = files.filter(
      (file) =>
        file.path.startsWith(join(SRC_ROOT, 'modules')) &&
        !file.path.startsWith(inventoryRoot) &&
        /modules\/inventory\//.test(file.source),
    );
    const offenders: string[] = [];
    for (const file of siblingModules) {
      if (inventoryInternals.test(file.source)) {
        offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
  });
});