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
      // Both import forms the sibling dirs can produce: the path-absolute
      // shape and the relative `../inventory/…` import specifier (epic-3
      // retro A7 — the guard only matched the literal path form before, so
      // a sibling importing `../inventory/reservation.service` slipped
      // through undetected).
      // The allowed suffixes must END the specifier (the closing quote):
      // `\\b` would wave through an `inventory.facade.internal` reach-through.
      '(?:modules/inventory|\\.\\./inventory)/' +
        '(?!inventory\\.(facade|module|dto)[\'"])',
    );
    const inventoryRoot = join(SRC_ROOT, 'modules', 'inventory');
    const siblingModules = files.filter(
      (file) =>
        file.path.startsWith(join(SRC_ROOT, 'modules')) &&
        !file.path.startsWith(inventoryRoot) &&
        /(?:modules\/inventory|\.\.\/inventory)\//.test(file.source),
    );
    // The detection itself must see the imports — the test is only
    // meaningful while it actually scans the sibling consumers.
    expect(siblingModules.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of siblingModules) {
      if (inventoryInternals.test(file.source)) {
        offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('architecture: the order aggregate is outbound-module-owned (story 4.1)', () => {
  /**
   * Story 4.1 adds the order aggregate (`orders`, `order_lines`) —
   * outbound-module-exclusive exactly like the stock tables are
   * inventory-exclusive (AD-6): every other module reads order state
   * through `OutboundFacade` and composes stock through `InventoryFacade`;
   * nothing outside the outbound module writes these tables.
   *
   * Story 4.2 extends the same ownership to the wave aggregate
   * (`wave_policies`, `waves`, `picklists`, `picklist_lines`) — the wave and
   * picklist state machines are the outbound module's alone, and the pick
   * path it plans is a SUGGESTION composed from stock the inventory facade
   * hands over (never a bin-level allocation, never a stock write here).
   */
  const ORDER_TABLES = [
    'orders',
    'orderLines',
    'wavePolicies',
    'waves',
    'picklists',
    'picklistLines',
  ] as const;
  const RAW_ORDER_TABLES = 'orders|order_lines|wave_policies|waves|picklists|picklist_lines';
  const outboundRoot = join(SRC_ROOT, 'modules', 'outbound');

  it('no order-table write happens outside the outbound module', () => {
    const outside = files.filter((file) => !file.path.startsWith(outboundRoot));
    const offenders: string[] = [];
    for (const file of outside) {
      for (const pattern of [
        ...ORDER_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_ORDER_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no other module reaches into the outbound module past the facade', () => {
    // The mirror of the inventory guard (same regex fix applied — both
    // import forms).
    // The allowed suffixes must END the specifier (the closing quote), not
    // merely sit on a word boundary: `\\b` would wave through a
    // `outbound.facade.internal` that is every bit a reach-through.
    const outboundInternals = new RegExp(
      '(?:modules/outbound|\\.\\./outbound)/' +
        '(?!outbound\\.(facade|module|dto)[\'"])',
    );
    const siblingModules = files.filter(
      (file) =>
        file.path.startsWith(join(SRC_ROOT, 'modules')) &&
        !file.path.startsWith(outboundRoot) &&
        /(?:modules\/outbound|\.\.\/outbound)\//.test(file.source),
    );
    // No sibling module consumes outbound YET (4.2 brings the first), so the
    // inventory twin's `siblingModules.length > 0` meaningfulness assert
    // cannot be used here — it would fail on an empty-but-correct codebase.
    // Pin the detector directly instead, so a typo or a regex that stops
    // matching an import form (the epic-3 retro A7 bug this file just fixed
    // for inventory) fails HERE rather than going unnoticed until the guard
    // silently scans nothing forever.
    for (const reaching of [
      "from '../outbound/order.command'",
      "from '../outbound/outbound.facade.internal'",
      "from '../outbound/outbound.dto.helpers'",
      "from 'src/modules/outbound/order.command'",
    ]) {
      expect(outboundInternals.test(reaching)).toBe(true);
    }
    for (const allowed of [
      "from '../outbound/outbound.facade'",
      "from '../outbound/outbound.module'",
      "from '../outbound/outbound.dto'",
      "from 'src/modules/outbound/outbound.facade'",
    ]) {
      expect(outboundInternals.test(allowed)).toBe(false);
    }
    const offenders: string[] = [];
    for (const file of siblingModules) {
      if (outboundInternals.test(file.source)) {
        offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the outbound module itself still writes the order tables (the test is meaningful)', () => {
    const source = readFileSync(join(outboundRoot, 'order.command.ts'), 'utf8');
    expect(drizzleWriteOn('orders').test(source)).toBe(true);
    expect(drizzleWriteOn('orderLines').test(source)).toBe(true);
    // Story 4.2's half of the same meaningfulness guard: the wave tables are
    // written, and written ONLY from the wave command service.
    const waveSource = readFileSync(join(outboundRoot, 'wave.command.ts'), 'utf8');
    for (const table of ['wavePolicies', 'waves', 'picklists', 'picklistLines'] as const) {
      expect(drizzleWriteOn(table).test(waveSource)).toBe(true);
    }
  });

  it('the wave aggregate writes no stock table and journals no ledger event (4.2)', () => {
    // The boundary the spec draws for this story: a wave PLANS a pick, it
    // never moves stock. Picking (4.3) is where a movement is journalled —
    // if this ever fails, a second quantity-mutation path has appeared in
    // the outbound module.
    const waveSource = readFileSync(join(outboundRoot, 'wave.command.ts'), 'utf8');
    for (const table of ['stockOnHand', 'batchOnHand', 'ledgerEvents', 'reservations'] as const) {
      expect(drizzleWriteOn(table).test(waveSource)).toBe(false);
    }
    expect(/appendLedgerEvent|grantReservation|commitReservation|releaseReservation/.test(waveSource)).toBe(
      false,
    );
  });
});
