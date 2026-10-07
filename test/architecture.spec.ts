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
/**
 * All stock-state tables: writes are inventory-module-exclusive. Story 4.3b
 * adds `bin_state_epochs` — the per-bin state epoch is minted inside the
 * ledger fold, so it belongs to the same single write path as the quantities
 * it shadows (a column on the tenancy-owned `bins` would have had the ledger
 * writing another module's table, which AD-6 forbids).
 */
const STOCK_TABLES = [...LEDGER_TABLES, 'stockOnHand', 'batchOnHand', 'binStateEpochs'] as const;
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

/**
 * The quantity scans below cover the SUITES too. A test that sums a quantity
 * column through an int4 cast raises 22003 the moment its fixture grows past
 * ~2,147 base units — and a guard that only watched `src/` would let that
 * land, then present as a mystery failure in whichever suite grew first.
 */
const TEST_ROOT = join(__dirname);
const quantityScanFiles: ScannedFile[] = [
  ...files,
  ...tsFilesUnder(TEST_ROOT)
    .sort()
    // This file is excluded from its own scan: it carries the counterexamples
    // the matchers are proved against, and a guard that fails on its own
    // evidence proves nothing.
    .filter((path) => path !== __filename)
    .map((path) => ({ path, source: readFileSync(path, 'utf8') })),
];

/** Drizzle write calls on a table object, e.g. `.insert(stockOnHand)`. */
function drizzleWriteOn(table: string): RegExp {
  return new RegExp(`\\.(insert|update|delete)\\(\\s*${table}\\b`);
}

/** Raw SQL writes to a physical table, e.g. `DELETE FROM ledger_events`. */
function rawWriteOn(physical: string): RegExp {
  return new RegExp(`\\b(insert into|update|delete from)\\s+${physical}\\b`, 'i');
}

const RAW_STOCK_TABLES = 'ledger_events|ledger_anchors|stock_on_hand|batch_on_hand|bin_state_epochs';

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
        drizzleWriteOn('binStateEpochs'),
        rawWriteOn('bin_state_epochs'),
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
    expect(drizzleWriteOn('binStateEpochs').test(projectionOwner)).toBe(true);
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
    // Story 4.3 — the pick settlement record joins the same ownership.
    'picks',
    // Story 4.6c — the label + manifest records join the same ownership.
    'shipments',
    'manifests',
    // Story 9-1 — the two reporting facts are outbound's: the refusals they
    // record are outbound's own (the pack verification, the reject policy).
    'packVerificationFailures',
    'ingestBackorderRefusals',
  ] as const;
  const RAW_ORDER_TABLES =
    'orders|order_lines|wave_policies|waves|picklists|picklist_lines|picks|shipments|manifests|pack_verification_failures|ingest_backorder_refusals';
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
    // Story 4.3's half: the pick command writes the settlement record and the
    // line flip, and nothing else writes `picks`.
    const pickSource = readFileSync(join(outboundRoot, 'pick.command.ts'), 'utf8');
    expect(drizzleWriteOn('picks').test(pickSource)).toBe(true);
    expect(drizzleWriteOn('picklistLines').test(pickSource)).toBe(true);
    // Story 4.6c's half: the label command writes the shipment record and
    // the manifest command writes the manifest row AND flips the shipments;
    // dispatch READS a labelled shipment (auto-stamp) and writes neither.
    const shipmentSource = readFileSync(join(outboundRoot, 'shipment.command.ts'), 'utf8');
    expect(drizzleWriteOn('shipments').test(shipmentSource)).toBe(true);
    const manifestSource = readFileSync(join(outboundRoot, 'manifest.command.ts'), 'utf8');
    expect(drizzleWriteOn('manifests').test(manifestSource)).toBe(true);
    expect(drizzleWriteOn('shipments').test(manifestSource)).toBe(true);
    const dispatchSource = readFileSync(join(outboundRoot, 'dispatch.command.ts'), 'utf8');
    expect(drizzleWriteOn('shipments').test(dispatchSource)).toBe(false);
    expect(drizzleWriteOn('manifests').test(dispatchSource)).toBe(false);
    // Story 9-1's half: the pack command writes the failed-verification
    // fact, the order command writes the reject-policy refusal fact.
    const packSource = readFileSync(join(outboundRoot, 'pack.command.ts'), 'utf8');
    expect(drizzleWriteOn('packVerificationFailures').test(packSource)).toBe(true);
    const orderSource = readFileSync(join(outboundRoot, 'order.command.ts'), 'utf8');
    expect(drizzleWriteOn('ingestBackorderRefusals').test(orderSource)).toBe(true);
  });

  it('the pick command moves stock ONLY through the inventory facade (4.3)', () => {
    // The outbound module's first stock-moving path. It must never write a
    // stock table or the reservation journal itself: the `pick.picked` draw
    // and the `held → committed` settlement both ride `InventoryFacade`'s
    // in-transaction passthroughs, which is what keeps them in ONE
    // transaction without opening a second quantity-mutation path (AD-6/16).
    const pickSource = readFileSync(join(outboundRoot, 'pick.command.ts'), 'utf8');
    for (const table of ['stockOnHand', 'batchOnHand', 'ledgerEvents', 'reservations'] as const) {
      expect(drizzleWriteOn(table).test(pickSource)).toBe(false);
    }
    expect(pickSource).toContain('this.inventory.appendLedgerEventInTx');
    expect(pickSource).toContain('this.inventory.commitReservationInTx');
  });

  it('the dispatch command writes no inventory table — the ledger events AND the hold retirements ride the facade (4.6)', () => {
    // The outbound module's terminal command touches BOTH halves of the
    // inventory module: it journals `dispatch.dispatched` events and it
    // retires every `committed` reservation the order owns. Both must ride
    // `InventoryFacade`'s in-transaction passthroughs — that is what keeps
    // them in ONE transaction with the order flip without opening a second
    // quantity-mutation path or a second writer of the reservation journal
    // (AD-6/12/16). A direct `reservations` write here would be exactly the
    // cancel-vs-dispatch double-release the lifecycle forbids.
    const dispatchSource = readFileSync(join(outboundRoot, 'dispatch.command.ts'), 'utf8');
    for (const table of ['stockOnHand', 'batchOnHand', 'ledgerEvents', 'reservations'] as const) {
      expect(drizzleWriteOn(table).test(dispatchSource)).toBe(false);
    }
    expect(dispatchSource).toContain('this.inventory.appendLedgerEventInTx');
    expect(dispatchSource).toContain('this.inventory.retireCommittedReservationInTx');
    // The order flip itself IS this module's own write (the meaningfulness
    // half — the assertions above are vacuous if the file writes nothing).
    expect(drizzleWriteOn('orders').test(dispatchSource)).toBe(true);
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

describe('architecture: catalog identity is catalog-module-owned (story 10.3)', () => {
  /**
   * Catalog has owned `skus`, `batches` and `serials` exclusively since 1.4 /
   * 2.4, and `../SYSTEM-DESIGN.md` records that the ownership was never
   * ENFORCED: this file covered the stock/ledger, order/wave/pick and carrier
   * table sets, and `catalog` (with `tenancy`, `inbound` and `putaway`) had no
   * block at all. Story 10.3 adds `handling_units` — a fourth catalog-owned
   * identity table with FOUR write paths spread across three sibling modules —
   * so the guard is written now, while the table is new and it is free, and it
   * closes the standing gap on the three older tables at the same time.
   *
   * The rule it enforces is the one `ensureSerials` established: catalog
   * identity has exactly ONE writer, `catalog.facade.ts`, and inbound,
   * outbound and inventory reach it through facade methods that run on their
   * own transaction. A direct write from a sibling is how 10.3's first
   * revision was drafted, and nothing in the repo would have caught it.
   *
   * Note what is deliberately NOT guarded here: catalog's file-level
   * *imports*. `uom.ts` is imported directly by inbound, outbound, inventory
   * and the api shell by design (the vocabulary is a shared primitive, not a
   * seam), so an inventory-style past-the-facade import guard would be a lie
   * about this module. Table WRITES are the invariant that actually matters.
   */
  const CATALOG_TABLES = [
    'skus',
    'batches',
    'serials',
    'handlingUnits',
    // `uom_conversions` was in the raw-SQL list but missing from the Drizzle
    // one, so a `.insert(uomConversions)` outside catalog walked straight
    // through a guard whose name says it cannot.
    'uomConversions',
    // Story 11.4: kit-ness is the presence of composition rows — a write
    // outside catalog would forge kit-ness (KitCommand is the one writer).
    'kitCompositions',
  ] as const;
  const RAW_CATALOG_TABLES = 'skus|batches|serials|handling_units|uom_conversions|kit_compositions';
  const catalogRoot = join(SRC_ROOT, 'modules', 'catalog');

  it('no catalog-identity write happens outside the catalog module', () => {
    const outside = files.filter((file) => !file.path.startsWith(catalogRoot));
    const offenders: string[] = [];
    for (const file of outside) {
      for (const pattern of [
        ...CATALOG_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_CATALOG_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the catalog module itself writes them (the test is meaningful)', () => {
    // A guard whose subject stopped being written would pass vacuously
    // forever. Each table is pinned to the file that owns its writes.
    const facade = readFileSync(join(catalogRoot, 'catalog.facade.ts'), 'utf8');
    expect(drizzleWriteOn('batches').test(facade)).toBe(true);
    expect(drizzleWriteOn('serials').test(facade)).toBe(true);
    const store = readFileSync(join(catalogRoot, 'handling-unit.store.ts'), 'utf8');
    expect(drizzleWriteOn('handlingUnits').test(store)).toBe(true);
    const importCommand = readFileSync(join(catalogRoot, 'import.command.ts'), 'utf8');
    expect(drizzleWriteOn('skus').test(importCommand)).toBe(true);
  });

  it('handling units have exactly ONE writer, and every transition goes through it (story 10.3)', () => {
    // The `ensureSerials` seam, made mechanical. FOUR transitions — create at
    // receipt, settle an over-receipt intake, pack, adjust away — reached from
    // THREE different sibling modules; every one of them must land in this one
    // file, or a status flip and the movement it belongs with can drift into
    // two transactions.
    const HANDLING_UNIT_OWNER = join(catalogRoot, 'handling-unit.store.ts');
    const offenders: string[] = [];
    for (const file of files) {
      if (file.path === HANDLING_UNIT_OWNER) continue;
      if (drizzleWriteOn('handlingUnits').test(file.source)) {
        offenders.push(`${file.path}: writes handlingUnits`);
      }
      if (/\b(insert into|update|delete from)\s+handling_units\b/i.test(file.source)) {
        offenders.push(`${file.path}: raw-SQL write of handling_units`);
      }
    }
    expect(offenders).toEqual([]);

    // The seam covers every transition the table has. A missing function here
    // is a transition some command is about to implement inline.
    const store = readFileSync(HANDLING_UNIT_OWNER, 'utf8');
    const facade = readFileSync(join(catalogRoot, 'catalog.facade.ts'), 'utf8');
    for (const fn of [
      'createHandlingUnitsInTx',
      'settleHandlingUnitIntakeInTx',
      'markHandlingUnitsPackedInTx',
      'markHandlingUnitsAdjustedInTx',
      'lockHandlingUnitsInTx',
      // The read `SkuCommand.edit` guards the flag flip with — catalog-internal,
      // so it is exported by the seam but has no facade face. A facade method
      // with no sibling caller is an unpinned surface, which is why the
      // by-GRN-line read that had none was deleted rather than kept.
      'countLiveHandlingUnitsInTx',
    ]) {
      expect(store).toContain(`export async function ${fn}(`);
    }
    // The four transitions plus the guarded read DO have facade faces, for
    // the siblings that hold this module (inbound, outbound).
    for (const fn of [
      'createHandlingUnitsInTx',
      'settleHandlingUnitIntakeInTx',
      'markHandlingUnitsPackedInTx',
      'markHandlingUnitsAdjustedInTx',
      'lockHandlingUnitsInTx',
    ]) {
      expect(facade).toContain(fn);
    }
    // Each consuming module actually reaches the seam (the assertions above
    // are vacuous if nobody calls it).
    const receiving = readFileSync(
      join(SRC_ROOT, 'modules', 'inbound', 'receiving.command.ts'),
      'utf8',
    );
    expect(receiving).toContain('this.catalog.createHandlingUnits');
    expect(receiving).toContain('this.catalog.settleHandlingUnitIntake');
    expect(readFileSync(join(SRC_ROOT, 'modules', 'outbound', 'pack.command.ts'), 'utf8')).toContain(
      'this.catalog.markHandlingUnitsPacked',
    );
    expect(
      readFileSync(join(SRC_ROOT, 'modules', 'inventory', 'inventory.command.ts'), 'utf8'),
    ).toContain('markHandlingUnitsAdjustedInTx(');
    expect(readFileSync(join(catalogRoot, 'sku.command.ts'), 'utf8')).toContain(
      'countLiveHandlingUnitsInTx(',
    );
  });

  it('nothing under src/ ever updates a captured weight (story 10.3)', () => {
    // `weight_grams` is captured once at receipt and carried to invoice, and
    // the ledger does NOT cover it: `grn.received` is an aggregate event
    // carrying neither the unit ids nor their grams, so an UPDATE of the
    // column would leave `verifyChain` perfectly green. "Immutable" is
    // therefore a property of the CODE — which means it needs a code-side
    // guard, or it is a comment that goes stale the first time someone adds a
    // re-weigh endpoint without reading this file.
    const offenders: string[] = [];
    for (const file of files) {
      // A Drizzle `.set({...weightGrams...})` on any update, and the raw-SQL
      // spelling. The column NAME alone is not banned — the migration and the
      // doc comments must be free to say it.
      if (/\.set\(\s*\{[^}]*\bweightGrams\b/s.test(file.source)) {
        offenders.push(`${file.path}: updates weightGrams`);
      }
      if (/\bset\s+weight_grams\s*=/i.test(file.source)) {
        offenders.push(`${file.path}: raw-SQL update of weight_grams`);
      }
    }
    expect(offenders).toEqual([]);
    // Meaningfulness: both shapes it bans are shapes it would actually catch,
    // and the INSERT that legitimately writes the column is not one of them.
    expect(/\.set\(\s*\{[^}]*\bweightGrams\b/s.test('.set({ weightGrams: 1 })')).toBe(true);
    expect(/\bset\s+weight_grams\s*=/i.test('update handling_units set weight_grams = 1')).toBe(
      true,
    );
    expect(/\.set\(\s*\{[^}]*\bweightGrams\b/s.test('.values({ weightGrams: 1 })')).toBe(false);
  });

  it('a catch weight never enters the quantity path (story 10.3)', () => {
    // The story's single loudest boundary: a catch weight is integer GRAMS
    // and is never a quantity. If `handling-unit.ts` ever reaches for the
    // milli-unit primitives, the weight has started travelling the path that
    // scales, reserves and folds — and 10.1's completed migration re-opens.
    const handlingUnit =
      readFileSync(join(catalogRoot, 'handling-unit.ts'), 'utf8') +
      readFileSync(join(catalogRoot, 'handling-unit.store.ts'), 'utf8');
    // The IMPORT and the CALL, never the name in prose — a guard that banned
    // the string would only teach people to stop naming it in comments (the
    // `CARRIER_ENCRYPTION_KEY` precedent above).
    expect(/primitives\/quantity['"]/.test(handlingUnit)).toBe(false);
    expect(/\b(toMilli|fromMilli|assertRecordableQuantity|milliQuantity)\s*\(/.test(handlingUnit)).toBe(
      false,
    );
    // Meaningfulness: the shapes it bans are shapes it would actually catch.
    expect(/primitives\/quantity['"]/.test("from '../../shared/primitives/quantity';")).toBe(true);
    expect(/\b(toMilli|fromMilli|assertRecordableQuantity|milliQuantity)\s*\(/.test('toMilli(x)')).toBe(
      true,
    );
  });
});

describe('architecture: carrier credentials are carriers-module-owned (story 4.6b)', () => {
  /**
   * Story 4.6b stands up the carrier substrate: the adapter registry and the
   * tenant credential vault. `carrier_connections` is carriers-module-
   * exclusive exactly as the stock tables are inventory-exclusive (AD-6) —
   * every other module reads carrier state through `CarriersFacade`.
   *
   * The second guard here is the one this story exists for. The sealed
   * credential (and the master key that opens it) must stay inside
   * `carrier-credentials.ts`: the moment another file imports the envelope
   * primitives or reads `CARRIER_ENCRYPTION_KEY`, secret material has a
   * second handling path — and the whole invariant ("secret material leaves
   * the system exactly never") is one careless response DTO away from
   * breaking. A source scan catches that at build time, before any e2e cost.
   */
  const CARRIER_TABLES = ['carrierConnections'] as const;
  const RAW_CARRIER_TABLES = 'carrier_connections';
  const carriersRoot = join(SRC_ROOT, 'modules', 'carriers');
  const CREDENTIAL_OWNER = join(carriersRoot, 'carrier-credentials.ts');
  /** Any import of the envelope primitives, at any depth and via any alias. */
  const ENVELOPE_IMPORT = /from\s+['"][^'"]*crypto\/envelope['"]/;

  it('no carrier-connection write happens outside the carriers module', () => {
    const outside = files.filter((file) => !file.path.startsWith(carriersRoot));
    const offenders: string[] = [];
    for (const file of outside) {
      for (const pattern of [
        ...CARRIER_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_CARRIER_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no other module reaches into the carriers module past the facade', () => {
    // The mirror of the inventory/outbound guards (both import forms; the
    // allowed suffixes must END the specifier, so a `carriers.facade.internal`
    // is caught rather than waved through on a word boundary).
    const carrierInternals = new RegExp(
      '(?:modules/carriers|\\.\\./carriers)/' + '(?!carriers\\.(facade|module|dto)[\'"])',
    );
    const siblingModules = files.filter(
      (file) =>
        file.path.startsWith(join(SRC_ROOT, 'modules')) &&
        !file.path.startsWith(carriersRoot) &&
        /(?:modules\/carriers|\.\.\/carriers)\//.test(file.source),
    );
    // Story 4.6c brought the first consumer (the outbound label command
    // imports `../carriers/carriers.facade` and nothing else), but the
    // `siblingModules.length > 0` meaningfulness assert would still be
    // vacuous against a DETECTOR typo (the list is one file). Pin the
    // detector directly too (the outbound block's precedent), so a typo or a
    // regex that stops matching an import form fails HERE rather than going
    // unnoticed while the guard silently scans nothing forever.
    for (const reaching of [
      "from '../carriers/carrier.command'",
      "from '../carriers/carrier-credentials'",
      "from '../carriers/carrier-registry'",
      "from '../carriers/carriers.facade.internal'",
      "from 'src/modules/carriers/carrier.command'",
    ]) {
      expect(carrierInternals.test(reaching)).toBe(true);
    }
    for (const allowed of [
      "from '../carriers/carriers.facade'",
      "from '../carriers/carriers.module'",
      "from '../carriers/carriers.dto'",
      "from 'src/modules/carriers/carriers.facade'",
    ]) {
      expect(carrierInternals.test(allowed)).toBe(false);
    }
    const offenders: string[] = [];
    for (const file of siblingModules) {
      if (carrierInternals.test(file.source)) {
        offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
    // Story 4.6c — the facade-only import is now EXERCISED by real code: the
    // outbound label command is the first sibling consumer, and it must touch
    // carriers through the facade (and its `labelThroughAdapter` export)
    // alone. Meaningfulness for the scan above — if this file stops
    // importing carriers, the scan above is asserting the absence of
    // something that exists nowhere.
    const shipmentSource = readFileSync(
      join(SRC_ROOT, 'modules', 'outbound', 'shipment.command.ts'),
      'utf8',
    );
    expect(/from\s+'\.\.\/carriers\/carriers\.facade'/.test(shipmentSource)).toBe(true);
    for (const forbidden of [
      '../carriers/carrier.command',
      '../carriers/carrier-registry',
      '../carriers/carrier-credentials',
      '../carriers/carrier-label-port',
      '../carriers/carriers.errors',
    ]) {
      expect(shipmentSource).not.toContain(forbidden);
    }
  });

  it('the carriers module itself writes the table (the test is meaningful)', () => {
    const source = readFileSync(join(carriersRoot, 'carrier.command.ts'), 'utf8');
    expect(drizzleWriteOn('carrierConnections').test(source)).toBe(true);
    // Disconnect is a hard DELETE (AD-15) — the story's one destructive path,
    // pinned so a later "soft delete" refactor has to argue with this test.
    expect(/\.delete\(\s*carrierConnections\b/.test(source)).toBe(true);
  });

  it('the carrier master key and the envelope live ONLY in carrier-credentials.ts', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.path === CREDENTIAL_OWNER) continue;
      // The READ of the env var, not the name in prose: the .env.example
      // pointer and the 503 problem detail both mention the variable, and a
      // guard that banned the string would only teach people to stop naming
      // it in comments.
      if (/process\.env\.CARRIER_ENCRYPTION_KEY/.test(file.source)) {
        offenders.push(`${file.path}: reads process.env.CARRIER_ENCRYPTION_KEY`);
      }
      // Only the credential owner may reach the raw seal/open primitives with
      // carrier material; everything else handles the public face. Matched on
      // the specifier SUFFIX, not an exact relative prefix: a file one
      // directory deeper (`../../../shared/...`) or an aliased import would
      // otherwise walk straight past a guard that claims to confine this.
      if (file.path.startsWith(carriersRoot) && ENVELOPE_IMPORT.test(file.source)) {
        offenders.push(`${file.path}: imports the envelope primitives`);
      }
    }
    expect(offenders).toEqual([]);
    // Meaningfulness: the owner really does both, so the scan above is not
    // asserting the absence of something that exists nowhere.
    const owner = readFileSync(CREDENTIAL_OWNER, 'utf8');
    expect(owner).toContain('process.env.CARRIER_ENCRYPTION_KEY');
    expect(ENVELOPE_IMPORT.test(owner)).toBe(true);
    // The matcher itself: suffix, any depth, any quote style — and it does
    // not fire on a neighbouring module whose name merely ends the same way.
    for (const reaching of [
      "from '../../shared/crypto/envelope'",
      'from "../../../../shared/crypto/envelope"',
      "from 'src/shared/crypto/envelope'",
    ]) {
      expect(ENVELOPE_IMPORT.test(reaching)).toBe(true);
    }
    expect(ENVELOPE_IMPORT.test("from '../../shared/crypto/envelope-registry'")).toBe(false);
  });

  it('no carrier response shape, outbox payload or audit row can carry the sealed blob', () => {
    // `credentialSealed` is the column name; it may appear ONLY where the row
    // is written and where the envelope is opened. It must never reach the
    // api shell (a response DTO), which is what a leak would look like.
    const apiRoot = join(SRC_ROOT, 'api');
    const offenders = files
      .filter((file) => file.path.startsWith(apiRoot) && /credentialSealed/.test(file.source))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
    // And the select list every read uses does not name the column.
    const command = readFileSync(join(carriersRoot, 'carrier.command.ts'), 'utf8');
    const columnList = /export const CONNECTION_COLUMNS = \{[\s\S]*?\} as const;/.exec(command);
    expect(columnList).not.toBeNull();
    expect(columnList![0]).not.toContain('credentialSealed');
  });
});

/**
 * Story 10.1: quantities are scaled integers in milli-units, which puts two
 * int4 traps in the way of anything that touches them in raw SQL. Both are
 * silent until a warehouse is large enough, and both are 500s rather than
 * refusals when they finally fire — so they are scanned for here rather than
 * left to be found in production.
 */
describe('architecture: no int4 trap sits over a milli-unit quantity (story 10.1)', () => {
  /** The quantity columns, in both their Drizzle and physical spellings. */
  const QUANTITY_COLUMN =
    '(quantity|quantityDelta|quantity_delta|qty|appliedQty|applied_qty|orderedQty|ordered_qty' +
    '|receivedQty|received_qty|excessQty|excess_qty|reservedQty|reserved_qty' +
    '|shortfallQty|shortfall_qty|capacity|reorderPoint|reorder_point|reorderQty|reorder_qty)';

  it('no `::int` cast sits over a quantity column, in src or in the suites', () => {
    // Aggregates AND the bare column: `sum(quantity)::int` overflows at ~2.1
    // million base units, and `quantity::int` at the same place. `count(*)`,
    // a parsed document number and an epoch extraction are not quantities, so
    // the scan keys on the COLUMN, never on the cast alone.
    const CAST_OVER_QUANTITY = new RegExp(
      `(?:(?:sum|max|min|avg)\\s*\\(\\s*)?(?:\\$\\{[A-Za-z]+\\.)?${QUANTITY_COLUMN}\\}?\\s*\\)?[^;\`\n]{0,40}?::int\\b`,
    );
    const offenders: string[] = [];
    for (const file of quantityScanFiles) {
      const hit = CAST_OVER_QUANTITY.exec(file.source);
      if (hit !== null) {
        offenders.push(`${file.path}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
    // Meaningfulness: the matcher fires on every shape it forbids…
    for (const forbidden of [
      'sql`coalesce(sum(${stockOnHand.quantity}), 0)::int`',
      'coalesce(sum(quantity), 0)::int as reserved',
      'select max(qty)::int from picks',
      'select quantity::int from stock_on_hand',
      'sql`avg(${picks.qty})::int`',
      'coalesce(sum(shortfall_qty), 0)::int',
    ]) {
      expect(`${forbidden} -> ${CAST_OVER_QUANTITY.test(forbidden)}`).toBe(`${forbidden} -> true`);
    }
    // …and on none of the casts that are not quantities.
    for (const allowed of [
      'sql`count(*)::int`',
      "count(*)::int as n from skus",
      "extract(epoch from expires_at - created_at)::int as ttl",
      "coalesce(max(substring(code from '^GRN-([0-9]{1,9})$')::int), 0)",
      "select count(*)::int from picklists pl where pl.wave_id = waves.id",
    ]) {
      expect(`${allowed} -> ${CAST_OVER_QUANTITY.test(allowed)}`).toBe(`${allowed} -> false`);
    }
  });

  it('every quantity bound into a raw-SQL expression carries an explicit `::bigint`', () => {
    // The second trap, and the one that actually shipped: Postgres resolves an
    // untyped bound parameter beside an integer literal as int4, so
    // `greatest(${delta}, 0)` died with a raw 22003 against a `bigint` column
    // that could hold the value perfectly well. The fix is a cast on the
    // PARAMETER; this is the guard that keeps the next one from going in
    // without it, since the comment calling the cast load-bearing cannot.
    // A Drizzle COLUMN reference (`${stockOnHand.quantity}`) is typed by the
    // column and needs nothing; what needs the cast is a scalar VALUE bound
    // into the statement. The two are told apart by their prefix: a column
    // reference names a schema table object, a value names a local binding.
    const UNTYPED_QUANTITY_PARAM = new RegExp(
      'sql`[^`]*\\$\\{\\s*' +
        '(?:(?:row|entry|command|line|hold|arm|input|slice|candidate|current|existing)\\.)?' +
        '(?:delta|applied|magnitude|remainder|excessQty|quantity|qty)' +
        '\\s*\\}(?!::bigint)',
    );
    const offenders: string[] = [];
    for (const file of files) {
      const hit = UNTYPED_QUANTITY_PARAM.exec(file.source);
      if (hit !== null) {
        offenders.push(`${file.path}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
    // Meaningfulness: the shape that shipped is caught, the fixed one is not.
    expect(UNTYPED_QUANTITY_PARAM.test('sql`greatest(${delta}, 0)`')).toBe(true);
    expect(UNTYPED_QUANTITY_PARAM.test('sql`greatest(${delta}::bigint, 0)`')).toBe(false);
    expect(UNTYPED_QUANTITY_PARAM.test('sql`${purchaseOrderLines.receivedQty} + ${applied}`')).toBe(true);
    expect(UNTYPED_QUANTITY_PARAM.test('sql`${purchaseOrderLines.receivedQty} + ${applied}::bigint`')).toBe(false);
    // A column reference is typed by the column, not by the parameter.
    expect(UNTYPED_QUANTITY_PARAM.test('sql`${stockOnHand.quantity} > 0`')).toBe(false);
  });
});

describe('architecture: clients are clients-module-owned (story 21-1)', () => {
  /**
   * Story 21-1 stands up the client dimension (AD-23): the `clients` table
   * is the new clients module's alone, exactly like the stock tables are
   * inventory-exclusive — every other module resolves the tenant's `self`
   * client through the module's `ensureSelfClientInTx` helper (the
   * `ensureReceivingBinInTx` seam: a file-level function other modules
   * import directly, NOT a past-the-facade reach) and stamps its column.
   * The guard is written now, while the table is new, so 21-2…21-8 inherit
   * an answered ownership question instead of re-litigating it.
   *
   * Deliberately NOT guarded: the imports of `ensure-self-client.ts` /
   * `clients.schema.ts` by sibling modules — that IS the seam (the
   * receiving-bin precedent); the invariant that matters is who WRITES the
   * table.
   */
  const CLIENT_TABLES = ['clients'] as const;
  const RAW_CLIENT_TABLES = 'clients';
  const clientsRoot = join(SRC_ROOT, 'modules', 'clients');

  it('no clients-table write happens outside the clients module', () => {
    const outside = files.filter((file) => !file.path.startsWith(clientsRoot));
    const offenders: string[] = [];
    for (const file of outside) {
      for (const pattern of [
        ...CLIENT_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_CLIENT_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the clients module owns the write, and tenancy + inventory reach it through the module (the test is meaningful)', () => {
    // A guard whose subject stopped being written would pass vacuously
    // forever — the ensure really does write the table, and (story 21-2b)
    // so does the admin command (create + rename).
    const ensure = readFileSync(join(clientsRoot, 'ensure-self-client.ts'), 'utf8');
    expect(drizzleWriteOn('clients').test(ensure)).toBe(true);
    const admin = readFileSync(join(clientsRoot, 'clients.command.ts'), 'utf8');
    expect(/\.insert\(\s*clients\b/.test(admin)).toBe(true);
    expect(/\.update\(\s*clients\b/.test(admin)).toBe(true);
    // Registration creates the self client in ITS OWN transaction — through
    // the module's ensure function, never a direct `clients` write.
    const registration = readFileSync(
      join(SRC_ROOT, 'modules', 'tenancy', 'registration.command.ts'),
      'utf8',
    );
    expect(registration).toContain('ensureSelfClientInTx');
    expect(drizzleWriteOn('clients').test(registration)).toBe(false);
    // Story 21-2b re-pin: the ledger stamps every event's client FROM ITS
    // SKU (read in the append transaction) — no longer the tenant's `self`
    // client. A ledger that went back to `ensureSelfClientInTx` would
    // silently attribute a client's movements to the tenant.
    const ledger = readFileSync(join(SRC_ROOT, 'modules', 'inventory', 'ledger.service.ts'), 'utf8');
    expect(ledger).not.toContain('ensureSelfClientInTx');
    expect(ledger).toMatch(/select\(\{\s*clientId:\s*skus\.clientId\s*\}\)/);
    expect(ledger).toMatch(/clientId,\s*\n\s*warehouseId: movement\.warehouseId/);
  });

  /**
   * Story 21-2b (decision 3): a SKU's client is set ONCE, at creation (the
   * import's INSERT), and moved only by the owner's correction command —
   * which refuses once the SKU has history. Any other UPDATE of
   * `skus.client_id` would re-attribute a client's stock behind the ledger's
   * back. Patterns: a Drizzle `.update(skus).set({ … clientId … })`, a
   * patch-object assignment (`updates.clientId = …`), and raw SQL.
   */
  const CORRECTION_FILE = join(SRC_ROOT, 'modules', 'catalog', 'sku-client.command.ts');
  const SKU_CLIENT_UPDATE = /\.update\(\s*skus\s*\)\s*\.set\(\s*\{[^}]*\bclientId\b/;
  const SKU_CLIENT_ASSIGN = /\b\w+\.clientId\s*=(?!=)/;
  const RAW_SKU_CLIENT_UPDATE = /\bupdate\s+"?skus"?\s+set\b[^;`]*\bclient_id\b/i;

  it('only the correction command updates skus.client_id', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.path === CORRECTION_FILE) continue;
      for (const pattern of [SKU_CLIENT_UPDATE, RAW_SKU_CLIENT_UPDATE]) {
        if (pattern.test(file.source)) offenders.push(`${file.path}: /${pattern.source}/`);
      }
      // The patch-object form only matters where a SKU update happens.
      if (/\.update\(\s*skus\b/.test(file.source) && SKU_CLIENT_ASSIGN.test(file.source)) {
        offenders.push(`${file.path}: /${SKU_CLIENT_ASSIGN.source}/`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the correction command really is the writer (the guard is meaningful)', () => {
    const correction = readFileSync(CORRECTION_FILE, 'utf8');
    expect(SKU_CLIENT_UPDATE.test(correction)).toBe(true);
    // The guard's patterns bite on the shapes they name.
    expect(SKU_CLIENT_UPDATE.test('tx.update(skus).set({ name, clientId: x })')).toBe(true);
    expect(RAW_SKU_CLIENT_UPDATE.test('UPDATE skus SET client_id = $1')).toBe(true);
    expect(SKU_CLIENT_ASSIGN.test('updates.clientId = other;')).toBe(true);
    expect(SKU_CLIENT_ASSIGN.test('if (row.clientId === other)')).toBe(false);
  });
});

describe('architecture: the transfer aggregate is movements-module-owned (story 5-1)', () => {
  /**
   * Story 5-1 populates the movements spine with the transfer aggregate
   * (`transfer_orders`, `transfer_order_lines`) — module-exclusive exactly
   * like the order aggregate is outbound-exclusive (AD-6): every other
   * module reads transfer state through `MovementsFacade` and composes its
   * stock through `InventoryFacade`. The legs are LEDGER events — the
   * command writes no stock table itself, so the ledger stays the
   * PROJECTION_OWNER and there is no second quantity-mutation path.
   */
  const TRANSFER_TABLES = ['transferOrders', 'transferOrderLines'] as const;
  const RAW_TRANSFER_TABLES = 'transfer_orders|transfer_order_lines';
  const movementsRoot = join(SRC_ROOT, 'modules', 'movements');

  it('no transfer-table write happens outside the movements module', () => {
    const outside = files.filter((file) => !file.path.startsWith(movementsRoot));
    const offenders: string[] = [];
    for (const file of outside) {
      for (const pattern of [
        ...TRANSFER_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_TRANSFER_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no other module reaches into the movements module past the facade', () => {
    // The mirror of the inventory/outbound guards (both import forms; the
    // allowed suffixes must END the specifier). The facade file for this
    // aggregate is `transfer.facade` (the seam), so its import is whitelisted
    // beside the `movements.facade` legacy suffix.
    const movementsInternals = new RegExp(
      '(?:modules/movements|\\.\\./movements)/' +
        '(?!movements\\.(facade|module|dto)[\'"])(?!transfer\\.facade[\'"])',
    );
    const siblingModules = files.filter(
      (file) =>
        file.path.startsWith(join(SRC_ROOT, 'modules')) &&
        !file.path.startsWith(movementsRoot) &&
        /(?:modules\/movements|\.\.\/movements)\//.test(file.source),
    );
    // Story 5-1 brought the first consumers (the transfer.command + facade
    // pair, plus the api shell's snapshot arm), but the meaningfulness assert
    // stays pinned directly (the outbound block's precedent): the detector
    // must catch a reach-through, not just find files.
    for (const reaching of [
      "from '../movements/transfer.command'",
      "from '../movements/movements.facade.internal'",
      "from 'src/modules/movements/transfer.command'",
    ]) {
      expect(movementsInternals.test(reaching)).toBe(true);
    }
    for (const allowed of [
      "from '../movements/transfer.facade'",
      "from '../movements/movements.module'",
      "from '../movements/movements.dto'",
      "from 'src/modules/movements/transfer.facade'",
    ]) {
      expect(movementsInternals.test(allowed)).toBe(false);
    }
    const offenders: string[] = [];
    for (const file of siblingModules) {
      if (movementsInternals.test(file.source)) {
        offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the movements module writes its own tables and moves stock only through the inventory facade (the test is meaningful)', () => {
    const source = readFileSync(join(movementsRoot, 'transfer.command.ts'), 'utf8');
    // The aggregate's writes live here — and nowhere else.
    expect(drizzleWriteOn('transferOrders').test(source)).toBe(true);
    expect(drizzleWriteOn('transferOrderLines').test(source)).toBe(true);
    // The legs ride the ledger passthrough — no second quantity-mutation path
    // (AD-6/16), the pick/dispatch commands' guard mirrored.
    for (const table of ['stockOnHand', 'batchOnHand', 'ledgerEvents', 'binStateEpochs', 'reservations'] as const) {
      expect(drizzleWriteOn(table).test(source)).toBe(false);
    }
    expect(source).toContain('this.inventory.appendLedgerEventInTx');
    // The facade is read-only over the aggregate (the seam, not a writer).
    const facade = readFileSync(join(movementsRoot, 'transfer.facade.ts'), 'utf8');
    for (const table of ['transferOrders', 'transferOrderLines'] as const) {
      expect(drizzleWriteOn(table).test(facade)).toBe(false);
    }
  });
});

describe('architecture: the replenishment planning state is replenishment-module-owned (stories 6-1 and 6-2)', () => {
  /**
   * Story 6-1 populates the replenishment spine (`reorder_policies`,
   * `reorder_breaches`, `suggested_pos`) — a CONSUMER of derived state, never
   * a second balance book: ATP is read only through `InventoryFacade.atp`
   * (the sweep never touches a stock table), the tenant-wide SKU defaults
   * only through `CatalogFacade`, and the real PO only through the inbound
   * facade's in-tx mint (the submit arm — inbound stays the ONLY writer of
   * `purchase_orders`). Story 6-2 adds the batch-alert spine
   * (`batch_alerts`, `expiry_alert_policies`): the scan reads on-hand only
   * through the inventory facade's projection sums and batch identity only
   * through the catalog facade. Every other module reaches it through
   * `ReplenishmentFacade`.
   */
  const REPLENISHMENT_TABLES = [
    'reorderPolicies',
    'reorderBreaches',
    'suggestedPos',
    'batchAlerts',
    'expiryAlertPolicies',
  ] as const;
  const RAW_REPLENISHMENT_TABLES = 'reorder_policies|reorder_breaches|suggested_pos|batch_alerts|expiry_alert_policies';
  const replenishmentRoot = join(SRC_ROOT, 'modules', 'replenishment');

  it('no replenishment-table write happens outside the replenishment module', () => {
    // The jobs shell's scope enumeration is a raw SELECT — reads are not
    // writes and are allowed anywhere BYPASSRLS can honestly read them.
    const outside = files.filter((file) => !file.path.startsWith(replenishmentRoot));
    const offenders: string[] = [];
    for (const file of outside) {
      for (const pattern of [
        ...REPLENISHMENT_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_REPLENISHMENT_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no other module reaches into the replenishment module past the facade', () => {
    // The mirror of the movements guard (both import forms; the allowed
    // suffixes must END the specifier). The api shell's DTO/carrier classes
    // are `replenishment.dto` — a whitelist suffix like every sibling.
    const replenishmentInternals = new RegExp(
      '(?:modules/replenishment|\\.\\./replenishment)/' +
        '(?!replenishment\\.(facade|module|dto)[\'"])',
    );
    const siblingModules = files.filter(
      (file) =>
        file.path.startsWith(join(SRC_ROOT, 'modules')) &&
        !file.path.startsWith(replenishmentRoot) &&
        /(?:modules\/replenishment|\.\.\/replenishment)\//.test(file.source),
    );
    for (const reaching of [
      "from '../replenishment/replenishment.command'",
      "from '../replenishment/replenishment.sweep'",
      "from 'src/modules/replenishment/replenishment.command'",
    ]) {
      expect(replenishmentInternals.test(reaching)).toBe(true);
    }
    for (const allowed of [
      "from '../replenishment/replenishment.facade'",
      "from '../replenishment/replenishment.module'",
      "from '../replenishment/replenishment.dto'",
      "from 'src/modules/replenishment/replenishment.facade'",
    ]) {
      expect(replenishmentInternals.test(allowed)).toBe(false);
    }
    const offenders: string[] = [];
    for (const file of siblingModules) {
      if (replenishmentInternals.test(file.source)) {
        offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the replenishment module writes only its own tables and reads stock/state only through facades (the test is meaningful)', () => {
    // The aggregate's writes live in the command (policies, idempotency) and
    // the sweep (breaches, drafts) — and nowhere else. Story 6-2 splits the
    // batch-alert writes: the command owns the CONFIG row and the dismissal,
    // the scan owns the raise/resolve transitions.
    const command = readFileSync(join(replenishmentRoot, 'replenishment.command.ts'), 'utf8');
    expect(drizzleWriteOn('reorderPolicies').test(command)).toBe(true);
    expect(drizzleWriteOn('suggestedPos').test(command)).toBe(true);
    expect(drizzleWriteOn('expiryAlertPolicies').test(command)).toBe(true);
    expect(drizzleWriteOn('batchAlerts').test(command)).toBe(true);
    const sweep = readFileSync(join(replenishmentRoot, 'replenishment.sweep.ts'), 'utf8');
    expect(drizzleWriteOn('reorderBreaches').test(sweep)).toBe(true);
    expect(drizzleWriteOn('suggestedPos').test(sweep)).toBe(true);
    const scan = readFileSync(join(replenishmentRoot, 'replenishment.expiry.scan.ts'), 'utf8');
    expect(drizzleWriteOn('batchAlerts').test(scan)).toBe(true);
    // The scan NEVER writes the config row (the command is its only writer).
    expect(drizzleWriteOn('expiryAlertPolicies').test(scan)).toBe(false);
    // No second quantity-mutation path: the module writes NO stock/ledger
    // table, the ATP numbers come from the inventory facade only, and the
    // scan's on-hand/batch facts from the facades' in-tx reads (never a
    // cross-module table reach — AD-6).
    for (const table of ['stockOnHand', 'batchOnHand', 'ledgerEvents', 'binStateEpochs', 'reservations', 'purchaseOrders', 'skus', 'vendors', 'batches'] as const) {
      expect(drizzleWriteOn(table).test(command)).toBe(false);
      expect(drizzleWriteOn(table).test(sweep)).toBe(false);
      expect(drizzleWriteOn(table).test(scan)).toBe(false);
      expect(drizzleWriteOn(table).test(replenishmentFacadeSource())).toBe(false);
    }
    expect(sweep).toContain('this.inventory.atp');
    expect(scan).toContain('this.inventory.batchScopeSumsInTx');
    expect(scan).toContain('this.catalog.getBatchIntakesForSkusInTx');
    // The facade is the seam: read-only over the aggregate's tables (the
    // writes ride the command/sweep/scan), passthroughs only.
    for (const table of REPLENISHMENT_TABLES) {
      expect(drizzleWriteOn(table).test(replenishmentFacadeSource())).toBe(false);
    }
  });

  function replenishmentFacadeSource(): string {
    return readFileSync(join(replenishmentRoot, 'replenishment.facade.ts'), 'utf8');
  }
});

describe('architecture: channel connections are channels-module-owned (story 7-1)', () => {
  /**
   * Story 7-1 stands up the sales-channel substrate: the adapter registry,
   * the credential vault (`integrations`), the external-reference mappings
   * (`channel_mappings`) and the delivery metering (`integration_calls`) —
   * module-exclusive tables exactly as the carrier vault is
   * carriers-exclusive (AD-6): every sibling reads connection state
   * (including sync health and the standing-buffer buckets it folds in from
   * the reservation core) through `ChannelsFacade` alone.
   *
   * The mirrored guard matters just as much: the channels module NEVER
   * writes another module's tables. Its standing buffers are the inventory
   * core's `reservations` rows reached through `InventoryFacade`
   * (`applyChannelBuffer` / `releaseReservationInTx` — AD-13/RN-1), and a
   * direct drizzle or raw-SQL write of any stock/ledger/order table from
   * this module would be a second quantity-mutation path — the exact defect
   * class the reservation core exists to make impossible.
   */
  const CHANNELS_TABLES = ['integrations', 'channelMappings', 'integrationCalls'] as const;
  const RAW_CHANNELS_TABLES = 'integrations|channel_mappings|integration_calls';
  const channelsRoot = join(SRC_ROOT, 'modules', 'channels');
  const CREDENTIAL_OWNER = join(channelsRoot, 'channel-credentials.ts');
  /** Any import of a shared envelope primitive, from any depth or alias. */
  const ENVELOPE_IMPORT = /from\s+['"][^'"]*crypto\/envelope['"]/;

  it('no channel-table write happens outside the channels module', () => {
    const outside = files.filter((file) => !file.path.startsWith(channelsRoot));
    const offenders: string[] = [];
    for (const file of outside) {
      for (const pattern of [
        ...CHANNELS_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_CHANNELS_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the channels module writes no other module’s table — the reservation core stays single-path', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => f.path.startsWith(channelsRoot))) {
      for (const table of [
        'stockOnHand',
        'batchOnHand',
        'ledgerEvents',
        'ledgerAnchors',
        'binStateEpochs',
        'reservations',
        'reservationCounters',
        'warehouseCounters',
        'skus',
        'batches',
        'purchaseOrders',
        'warehouses',
        'memberships',
        'carrierConnections',
        'orders',
        'orderLines',
        'picks',
      ] as const) {
        if (drizzleWriteOn(table).test(file.source)) {
          offenders.push(`${file.path}: writes ${table}`);
        }
      }
      // The one deliberately-visible raw-SQL write in the family is the
      // channels module's own — nothing here reaches a physical
      // reservations/stock ledger table with UPDATE/DELETE/INSERT.
      for (const physical of [
        'reservations',
        'stock_on_hand',
        'batch_on_hand',
        'ledger_events',
        'reservation_counters',
        'warehouse_counters',
      ]) {
        if (rawWriteOn(physical).test(file.source)) {
          offenders.push(`${file.path}: raw-SQL write of ${physical}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Meaningfulness — the boundary is real, so pin that the buffer writes
    // DO ride the inventory facade in the command (AD-13's single path):
    const command = readFileSync(join(channelsRoot, 'channels.command.ts'), 'utf8');
    expect(command).toContain('applyChannelBuffer');
    expect(command).toContain('releaseReservationInTx');
  });

  it('the channels module itself writes its tables (the test is meaningful)', () => {
    // The writers AFTER the publish-machinery extraction (ChannelsPublish
    // standing beside the command and the facade): the command owns the
    // connection-row lifecycle writes (connect / rotate / config / DELETE),
    // the publish service owns the breaker updates + the metering rows and
    // the mapping seed, and the FACADE only READS (it composes arm 4 from
    // the module's tables and is the module's only exported seam).
    const command = readFileSync(join(channelsRoot, 'channels.command.ts'), 'utf8');
    const facade = readFileSync(join(channelsRoot, 'channels.facade.ts'), 'utf8');
    const publish = readFileSync(join(channelsRoot, 'channels.publish.ts'), 'utf8');
    expect(drizzleWriteOn('integrations').test(command)).toBe(true);
    expect(drizzleWriteOn('integrations').test(publish)).toBe(true);
    // Disconnect is a hard DELETE (AD-15) — the story's one destructive
    // vault path, pinned so a later "soft delete" refactor argues with this.
    expect(/\.delete\(\s*integrations\b/.test(command)).toBe(true);
    // Metering rows and mappings have exactly one writer each.
    expect(drizzleWriteOn('integrationCalls').test(publish)).toBe(true);
    expect(drizzleWriteOn('channelMappings').test(publish)).toBe(true);
    // The facade composes, never writes.
    expect(drizzleWriteOn('integrations').test(facade)).toBe(false);
  });

  it('the channels key and envelope primitives live ONLY in channel-credentials.ts', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.path === CREDENTIAL_OWNER) continue;
      // The READ of the env var, not the name in prose (the carriers block's
      // precedent: .env pointers and problem details must still name it).
      if (/process\.env\.CHANNEL_ENCRYPTION_KEY/.test(file.source)) {
        offenders.push(`${file.path}: reads process.env.CHANNEL_ENCRYPTION_KEY`);
      }
      if (file.path.startsWith(channelsRoot) && ENVELOPE_IMPORT.test(file.source)) {
        offenders.push(`${file.path}: imports the envelope primitives`);
      }
    }
    expect(offenders).toEqual([]);
    const owner = readFileSync(CREDENTIAL_OWNER, 'utf8');
    expect(owner).toContain('process.env.CHANNEL_ENCRYPTION_KEY');
    expect(ENVELOPE_IMPORT.test(owner)).toBe(true);
  });

  it('no other module reaches into the channels module past the facade', () => {
    // Deliberately WRONG on purpose below: the reach detector must catch
    // command/registry/errors/events/view imports, and allow only the
    // facade/module/dto forms, so it is pinned against a detector typo the
    // same way the carriers block is.
    const guard = new RegExp(
      '(?:modules/channels|\\.\\./channels)/(?!(?:channels\\.facade|channels\\.module|channels\\.dto)[\'"])',
    );
    for (const reaching of [
      "from '../channels/channels.command'",
      "from '../channels/channel-registry'",
      "from '../channels/channel-credentials'",
      "from '../channels/channels.events'",
      "from '../channels/channels.view'",
      "from '../channels/channels.errors'",
      "from '../channels/channels.facade.internal'",
    ]) {
      expect(guard.test(reaching)).toBe(true);
    }
    for (const allowed of [
      "from '../channels/channels.facade'",
      "from '../channels/channels.module'",
      "from '../channels/channels.dto'",
    ]) {
      expect(guard.test(allowed)).toBe(false);
    }
    const siblingModules = files.filter(
      (file) =>
        file.path.startsWith(join(SRC_ROOT, 'modules')) &&
        !file.path.startsWith(channelsRoot) &&
        /(?:modules\/channels|\.\.\/channels)\//.test(file.source),
    );
    const offenders: string[] = [];
    for (const file of siblingModules) {
      if (guard.test(file.source)) {
        offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
    // And the detector really scans files that import channels (the
    // jobs shell drives the facade — meaningfulness for the scan above).
    const jobs = readFileSync(join(SRC_ROOT, 'jobs', 'jobs.module.ts'), 'utf8');
    expect(jobs).toContain("from '../modules/channels/channels.facade'");
  });
});

describe('architecture: channel ingest + writeback ride the frozen seams (story 7-2)', () => {
  const channelsRoot = join(SRC_ROOT, 'modules', 'channels');
  const apiRoot = join(SRC_ROOT, 'api');

  it('the webhook controller reaches the channels module ONLY via its facade + the declared registry arms', () => {
    const controller = readFileSync(join(apiRoot, 'webhooks.controller.ts'), 'utf8');
    // No channel table, no channel command/service — the controller verifies,
    // parses and ROUTES; the ingest decisions live in the channels module.
    expect(controller).toContain('ChannelsFacade');
    expect(controller).toContain('channelAdapter');
    // The carriers 4.6b pin's posture: the sealed blob is NEVER named in
    // `src/api` — the signing secret crosses via `webhookDeliveryFace`'s
    // opened face, module-owned envelope.
    expect(controller).not.toContain('credentialSealed');
    expect(controller).not.toContain('openCredential');
    for (const forbidden of ['ChannelsIngestCommand', 'ChannelsPublishService', 'channels.command', 'drizzle']) {
      expect(controller).not.toContain(forbidden);
    }
  });

  it('the ingest command creates orders ONLY through the outbound facade (the single acceptance path, 4-1)', () => {
    const command = readFileSync(join(channelsRoot, 'channels.ingest.command.ts'), 'utf8');
    expect(command).toContain('this.outbound.createOrder');
    expect(command).toContain('this.outbound.cancelOrder');
    // And it writes NO outbound table of its own — drizzle writes here are
    // the connection/mapping reads only.
    expect(drizzleWriteOn('orders').test(command)).toBe(false);
    expect(drizzleWriteOn('orderLines').test(command)).toBe(false);
  });

  it('the ingest + writeback metering has exactly ONE writer per kind — the publish service', () => {
    const publish = readFileSync(join(channelsRoot, 'channels.publish.ts'), 'utf8');
    expect(drizzleWriteOn('integrationCalls').test(publish)).toBe(true);
    // The ingest command meters through the publish service, never directly.
    const ingest = readFileSync(join(channelsRoot, 'channels.ingest.command.ts'), 'utf8');
    expect(ingest).toContain('this.publish.recordIngestOutcome');
    expect(drizzleWriteOn('integrationCalls').test(ingest)).toBe(false);
    // The writeback delivery settles through the publish service too.
    const writeback = readFileSync(join(channelsRoot, 'channel-writeback.delivery.ts'), 'utf8');
    expect(writeback).toContain('recordWritebackDelivery');
    expect(drizzleWriteOn('integrationCalls').test(writeback)).toBe(false);
  });

  it('the writeback delivery subscribes the order events through EVENT_BUS and re-reads the order (RD-7)', () => {
    const writeback = readFileSync(join(channelsRoot, 'channel-writeback.delivery.ts'), 'utf8');
    expect(writeback).toContain('order.packed');
    expect(writeback).toContain('order.dispatched');
    expect(writeback).toContain('order.cancelled');
    expect(writeback).toContain('this.eventBus.subscribe');
    // The payload is never trusted for the channel arms — the order row is
    // re-read via the outbound facade.
    expect(writeback).toContain('orderForWriteback');
  });

  it('the webhook controller is registered in the api module ahead of the catch-alls (the last-siblings convention)', () => {
    const apiModule = readFileSync(join(apiRoot, 'api.module.ts'), 'utf8');
    const webhooks = apiModule.indexOf('WebhooksController');
    const openApi = apiModule.indexOf('OpenApiController');
    const notFound = apiModule.indexOf('NotFoundController');
    expect(webhooks).toBeGreaterThan(-1);
    expect(openApi).toBeGreaterThan(webhooks);
    expect(notFound).toBeGreaterThan(openApi);
  });

  it('the registry’s webhook declarations carry the topic-binding header (the cross-endpoint replay stop)', () => {
    const registry = readFileSync(join(channelsRoot, 'channel-registry.ts'), 'utf8');
    expect(registry).toContain('topicHeader');
    expect(registry).toContain("topicHeader: 'X-Shopify-Topic'");
  });
});

describe('architecture: invoices are invoicing-module-owned (story 8-1)', () => {
  /**
   * Story 8-1's invoice records are module-exclusive to `invoicing/` (the
   * spec's Always-rule): siblings read them through `InvoicingFacade`, and
   * the rate/GSTIN columns invoicing consumes are written only by their
   * owning modules — invoicing never writes an outbound or tenancy table
   * (the rate override freezes into the invoice document, never into
   * `order_lines`).
   */
  // Story 8-2b: the e-way tables are invoicing-owned too.
  const INVOICING_TABLES = [
    'invoices',
    'invoiceLines',
    'invoiceSeries',
    'ewayBills',
    'ewayStateThresholds',
    'ewayGstinSettings',
    'ewayNationalThresholds',
  ] as const;
  const RAW_INVOICING_TABLES = 'invoices|invoice_lines|invoice_series|eway_bills|eway_state_thresholds|eway_gstin_settings|eway_national_thresholds';
  const invoicingRoot = join(SRC_ROOT, 'modules', 'invoicing');

  it('no invoice-table write happens outside the invoicing module', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => !f.path.startsWith(invoicingRoot))) {
      for (const pattern of [
        ...INVOICING_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_INVOICING_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the invoicing module writes no outbound or tenancy table (the frozen rate stays frozen)', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => f.path.startsWith(invoicingRoot))) {
      for (const table of ['orders', 'orderLines', 'picks', 'tenants', 'warehouses', 'skus', 'gstStateCodes'] as const) {
        if (drizzleWriteOn(table).test(file.source)) {
          offenders.push(`${file.path}: writes ${table}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the invoicing generator itself writes its tables (the test is meaningful)', () => {
    const generator = readFileSync(join(invoicingRoot, 'generator.ts'), 'utf8');
    for (const table of ['invoices', 'invoiceLines', 'invoiceSeries'] as const) {
      expect(drizzleWriteOn(table).test(generator)).toBe(true);
    }
    // Story 8-2b: the e-way command and delivery write theirs.
    const eway = readFileSync(join(invoicingRoot, 'eway.command.ts'), 'utf8') + readFileSync(join(invoicingRoot, 'eway.delivery.ts'), 'utf8');
    for (const table of ['ewayBills', 'ewayStateThresholds', 'ewayGstinSettings'] as const) {
      expect(drizzleWriteOn(table).test(eway)).toBe(true);
    }
  });
});

describe('architecture: reporting is a read-only exception, imported only by the api shell (story 9-1, decision 6)', () => {
  /**
   * Decision 6 lets the reporting tiles read the owning modules' tables
   * directly — the ONE named exception to AD-6's facade rule. Its terms are
   * what keep it an exception rather than a precedent:
   *   1. reporting writes nothing — no Drizzle insert/update/delete on any
   *      table object, no raw INSERT/UPDATE/DELETE/TRUNCATE in its SQL;
   *   2. nothing imports the reporting module but the api shell (and the
   *      root composition, which wires every spine module) — no sibling may
   *      build on a read model that is allowed to bypass facades.
   */
  const reportingRoot = join(SRC_ROOT, 'modules', 'reporting');
  const reportingFiles = files.filter((file) => file.path.startsWith(reportingRoot));
  const DRIZZLE_ANY_WRITE = /\.(insert|update|delete)\(\s*[A-Za-z_]/;
  const RAW_ANY_WRITE = /\b(insert\s+into|update\s+[a-z_]+\s+set|delete\s+from|truncate)\b/i;

  it('the detectors bite (the test is meaningful)', () => {
    expect(reportingFiles.length).toBeGreaterThanOrEqual(3);
    expect(DRIZZLE_ANY_WRITE.test('await tx.insert(orders).values({})')).toBe(true);
    expect(DRIZZLE_ANY_WRITE.test('await tx.update(picks).set({})')).toBe(true);
    expect(RAW_ANY_WRITE.test('sql`insert into orders (id) values (1)`')).toBe(true);
    expect(RAW_ANY_WRITE.test('sql`update picks set qty = 0`')).toBe(true);
    expect(RAW_ANY_WRITE.test('sql`DELETE FROM batch_alerts`')).toBe(true);
    expect(RAW_ANY_WRITE.test('sql`select count(*) from picks where updated_at < now()`')).toBe(false);
  });

  it('nothing under src/modules/reporting writes any table', () => {
    const offenders: string[] = [];
    for (const file of reportingFiles) {
      for (const pattern of [DRIZZLE_ANY_WRITE, RAW_ANY_WRITE]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only the api shell (and the root composition) imports the reporting module', () => {
    const importsReporting = /(?:modules\/reporting|\.\.\/reporting)\//;
    const allowed = (path: string): boolean =>
      path.startsWith(join(SRC_ROOT, 'api')) ||
      path === join(SRC_ROOT, 'app.module.ts') ||
      path.startsWith(reportingRoot);
    const importers = files.filter((file) => importsReporting.test(file.source));
    // Meaningful: the api shell DOES import it (controller + module wiring).
    expect(importers.some((file) => file.path === join(SRC_ROOT, 'api', 'api.module.ts'))).toBe(true);
    expect(importers.some((file) => file.path === join(SRC_ROOT, 'api', 'reporting.controller.ts'))).toBe(true);
    expect(importers.filter((file) => !allowed(file.path)).map((file) => file.path)).toEqual([]);
  });

  it('the reporting module owns no table and exports only its facade', () => {
    const moduleSource = readFileSync(join(reportingRoot, 'reporting.module.ts'), 'utf8');
    expect(moduleSource).toMatch(/exports:\s*\[ReportingFacade\]/);
    const schemaSource = readFileSync(join(SRC_ROOT, 'shared', 'db', 'schema.ts'), 'utf8');
    // Both 9-1 fact tables are declared — and owned by outbound (the order
    // block above), never by reporting.
    expect(schemaSource).toContain("pgTable(\n  'pack_verification_failures'");
    expect(schemaSource).toContain("pgTable(\n  'ingest_backorder_refusals'");
  });
});

describe('architecture: rate cards are billing-module-owned (story 21-3)', () => {
  /**
   * Story 21-3 stands up the billing module (AD-6, `spec-3pl/architecture.md`
   * "billing … owns its own tables; writes no stock"). `rate_cards` and
   * `rate_card_lines` are written ONLY by `src/modules/billing`; siblings
   * (21-4 metering, 21-5 invoices) read them through `billing.facade.ts`;
   * billing itself writes no other module's table — it reads the client
   * entity (and locks its row) through `clients.facade.ts`.
   */
  // Story 21-4 adds the storage snapshots and their per-scope watermark —
  // billing-owned the same way (a projection over the ledger, AD-25).
  // Story 21-5 adds the client invoices, their lines and the services series.
  const BILLING_TABLES = [
    'rateCards',
    'rateCardLines',
    'storageSnapshots',
    'storageSnapshotProgress',
    'clientInvoices',
    'clientInvoiceLines',
    'clientInvoiceSeries',
  ] as const;
  const RAW_BILLING_TABLES =
    'rate_cards|rate_card_lines|storage_snapshots|storage_snapshot_progress|client_invoices|client_invoice_lines|client_invoice_series';
  const billingRoot = join(SRC_ROOT, 'modules', 'billing');
  const billingFiles = files.filter((file) => file.path.startsWith(billingRoot));

  it('no rate-card write happens outside the billing module', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => !f.path.startsWith(billingRoot))) {
      for (const pattern of [
        ...BILLING_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+"?(${RAW_BILLING_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) offenders.push(`${file.path}: /${pattern.source}/`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the billing module writes no stock, ledger, client or order table', () => {
    const offenders: string[] = [];
    for (const file of billingFiles) {
      for (const table of [...STOCK_TABLES, 'clients', 'skus', 'orders', 'orderLines', 'purchaseOrders'] as const) {
        if (drizzleWriteOn(table).test(file.source)) offenders.push(`${file.path}: writes ${table}`);
      }
      if (new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_STOCK_TABLES}|clients)\\b`, 'i').test(file.source)) {
        offenders.push(`${file.path}: raw write`);
      }
      // The client entity is reached only through its facade (plus the
      // schema-face re-export the module never needs).
      if (/from '\.\.\/clients\/(?!clients\.facade')/.test(file.source)) {
        offenders.push(`${file.path}: reaches past the clients facade`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no other module reaches into the billing module past the facade', () => {
    const offenders: string[] = [];
    const reach = /from '[^']*modules\/billing\/(?!billing\.facade'|billing\.module'|rate-cards')[^']*'|from '\.\.\/billing\/(?!billing\.facade'|billing\.module'|rate-cards')[^']*'/;
    for (const file of files.filter((f) => !f.path.startsWith(billingRoot) && !f.path.startsWith(join(SRC_ROOT, 'api')))) {
      if (reach.test(file.source)) offenders.push(file.path);
    }
    expect(offenders).toEqual([]);
  });

  it('no module outside billing even READS the rate-card tables — siblings go through billing.facade.ts', () => {
    // `rate-cards.ts` is a public file (the vocabularies), so it must not
    // re-export the tables either; the only other place the identifiers may
    // appear is their definition in the shared schema.
    const schemaFile = join(SRC_ROOT, 'shared', 'db', 'schema.ts');
    const offenders = files
      .filter((file) => !file.path.startsWith(billingRoot) && file.path !== schemaFile)
      .filter((file) => /\b(rateCards|rateCardLines|storageSnapshots|storageSnapshotProgress|clientInvoices|clientInvoiceLines|clientInvoiceSeries)\b/.test(file.source))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
    const publicVocabulary = readFileSync(join(billingRoot, 'rate-cards.ts'), 'utf8');
    expect(/export\s*\{[^}]*\b(rateCards|rateCardLines|storageSnapshots|storageSnapshotProgress|clientInvoices|clientInvoiceLines|clientInvoiceSeries)\b/.test(publicVocabulary)).toBe(false);
    // Meaningful: the facade really does read them.
    expect(/\bfrom\(\s*rateCards\b/.test(readFileSync(join(billingRoot, 'billing.facade.ts'), 'utf8'))).toBe(true);
  });

  it('the billing command really writes both tables (the test is meaningful)', () => {
    const command = readFileSync(join(billingRoot, 'rate-card.command.ts'), 'utf8');
    for (const table of ['rateCards', 'rateCardLines'] as const) {
      expect(drizzleWriteOn(table).test(command)).toBe(true);
    }
    expect(/\.update\(\s*rateCards\b/.test(command)).toBe(true);
    // The detectors bite on the shapes they name.
    expect(drizzleWriteOn('rateCardLines').test('tx.insert(rateCardLines).values({})')).toBe(true);
    expect(new RegExp(`\\b(insert into|update|delete from)\\s+"?(${RAW_BILLING_TABLES})\\b`, 'i').test('UPDATE rate_cards SET status')).toBe(true);
  });

  it('the snapshot service really writes both 21-4 tables, and the metering read reads the snapshots (the test is meaningful)', () => {
    const snapshots = readFileSync(join(billingRoot, 'storage-snapshot.ts'), 'utf8');
    expect(/insert into storage_snapshots\b/i.test(snapshots)).toBe(true);
    expect(/insert into storage_snapshot_progress\b/i.test(snapshots)).toBe(true);
    expect(/update storage_snapshot_progress\b/i.test(snapshots)).toBe(true);
    expect(/\.delete\(\s*storageSnapshots\b/.test(snapshots)).toBe(true);
    expect(/\bfrom\(\s*storageSnapshots\b/.test(readFileSync(join(billingRoot, 'metering.ts'), 'utf8'))).toBe(true);
  });

  it('the client-invoice service really writes the three 21-5 tables, and reaches invoicing only through its facade (the test is meaningful)', () => {
    const service = readFileSync(join(billingRoot, 'client-invoices.ts'), 'utf8');
    for (const table of ['clientInvoices', 'clientInvoiceLines', 'clientInvoiceSeries'] as const) {
      expect(drizzleWriteOn(table).test(service)).toBe(true);
    }
    // Billing reads the e-invoicing flag and the state codes ONLY through
    // `InvoicingFacade` — never invoicing's tables or internals.
    const offenders = billingFiles
      .filter((file) => /from '\.\.\/invoicing\/(?!facade'|invoicing\.module')/.test(file.source) || /\b(ewayGstinSettings|gstStateCodes|invoiceSeries)\b/.test(file.source))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
    expect(service).toContain("from '../invoicing/facade'");
  });

  it('billing reads the ledger, the GRN lines and the picks ONLY through the inventory, inbound and outbound facades (story 21-4)', () => {
    // AD-6 + AD-25: metering is aggregation over other modules' records, and
    // every such read has ONE definition on the owning module's facade (the
    // shared predicates 21-5's drill-down reuses). Billing never names the
    // tables — not the Drizzle objects, not the physical names in raw SQL.
    const FORBIDDEN_IDENTIFIER = /\b(ledgerEvents|picks|goodsReceipt[A-Za-z]*)\b/;
    const FORBIDDEN_RAW = /\b(from|join)\s+"?(ledger_events|picks|goods_receipt_[a-z_]+)\b/i;
    // Code only — the doc comments name what the counts MEAN ("picks rows").
    const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const offenders: string[] = [];
    for (const file of billingFiles) {
      const identifier = FORBIDDEN_IDENTIFIER.exec(code(file.source));
      if (identifier !== null) offenders.push(`${file.path}: names ${identifier[0]}`);
      const raw = FORBIDDEN_RAW.exec(code(file.source));
      if (raw !== null) offenders.push(`${file.path}: raw read ${raw[0]}`);
    }
    expect(offenders).toEqual([]);
    // The detectors bite on the shapes they name…
    expect(FORBIDDEN_IDENTIFIER.test('tx.select().from(ledgerEvents)')).toBe(true);
    expect(FORBIDDEN_IDENTIFIER.test('import { goodsReceiptLines } from')).toBe(true);
    expect(FORBIDDEN_RAW.test('select count(*) from picks p')).toBe(true);
    expect(FORBIDDEN_RAW.test('join goods_receipt_notes grn on')).toBe(true);
    // …and the metering read really goes through the three facades.
    const metering = readFileSync(join(billingRoot, 'metering.ts'), 'utf8');
    expect(metering).toContain("from '../inventory/inventory.facade'");
    expect(metering).toContain("from '../inbound/inbound.facade'");
    expect(metering).toContain("from '../outbound/outbound.facade'");
  });
});
