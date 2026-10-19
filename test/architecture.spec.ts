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
      // Story 1-2a: `client-wind-down` is the one declared file-level seam
      // beside the facade (the clients status command composes it; it
      // imports only shared/ — pinned in the clients block).
      '(?:modules/inventory|\\.\\./inventory)/' +
        '(?!(?:inventory\\.(facade|module|dto)|client-wind-down)[\'"])',
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
    // Story 1-2a: `client-wind-down` is the declared file-level seam (see
    // the inventory twin).
    const outboundInternals = new RegExp(
      '(?:modules/outbound|\\.\\./outbound)/' +
        '(?!(?:outbound\\.(facade|module|dto)|client-wind-down)[\'"])',
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
  // Story 1-2a — `client_contacts` joins the clients module's tables.
  const CLIENT_TABLES = ['clients', 'clientContacts'] as const;
  const RAW_CLIENT_TABLES = 'clients|client_contacts';
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

  /**
   * Story 1-2a — the wind-down reads. Each owning module exports a file-level
   * `clientWindDownBlockersInTx` that the clients module's status command
   * composes; every such file imports only `drizzle-orm` and `shared/` (so
   * never `modules/clients`, nor a command file that imports the clients
   * facade) — the dependency stays one-way, with no import cycle.
   */
  const WIND_DOWN_FILES = ['inventory', 'inbound', 'outbound', 'returns', 'tenancy', 'billing', 'channels'].map((module) =>
    join(SRC_ROOT, 'modules', module, 'client-wind-down.ts'),
  );

  it('story 1-2a: every wind-down file imports only drizzle-orm and shared/ — nothing from modules/clients', () => {
    const offenders: string[] = [];
    for (const path of WIND_DOWN_FILES) {
      const source = readFileSync(path, 'utf8');
      expect(source).toMatch(/export async function clientWindDownBlockersInTx\(/);
      for (const match of source.matchAll(/from '([^']+)'/g)) {
        const target = match[1]!;
        if (target !== 'drizzle-orm' && !target.startsWith('../../shared/')) offenders.push(`${path}: imports ${target}`);
      }
    }
    expect(offenders).toEqual([]);
    // Meaningful: the status command composes all six.
    const command = readFileSync(join(clientsRoot, 'clients.command.ts'), 'utf8');
    for (const module of ['inventory', 'inbound', 'outbound', 'returns', 'tenancy', 'billing', 'channels']) {
      expect(command).toContain(`from '../${module}/client-wind-down'`);
    }
  });

  /**
   * Story 1-2a — "no new work": every path that creates work for a client
   * runs the one gate, `assertClientTakesWorkInTx`. A path that dropped it
   * would let a departed client take new work silently.
   */
  const TAKES_WORK_CALLERS = [
    ['inbound', 'po.command.ts'],
    ['inbound', 'asn.command.ts'],
    ['inbound', 'asn-import.command.ts'],
    ['outbound', 'order.command.ts'],
    ['channels', 'channels.ingest.command.ts'],
    ['channels', 'channels.command.ts'],
    ['channels', 'channels.publish.ts'],
    ['catalog', 'import.command.ts'],
    ['catalog', 'sku-client.command.ts'],
    ['catalog', 'kit.command.ts'],
    ['catalog', 'sku.command.ts'],
    ['returns', 'return-authorization.command.ts'],
    ['inventory', 'inventory.command.ts'],
  ] as const;

  it('story 1-2a: every work-creating path calls assertClientTakesWorkInTx', () => {
    const missing = TAKES_WORK_CALLERS.map(([module, file]) => join(SRC_ROOT, 'modules', module, file)).filter(
      (path) => !/assertClientTakesWorkInTx\(/.test(readFileSync(path, 'utf8')),
    );
    expect(missing).toEqual([]);
    // The order create runs it twice: phase 1 (an early exit) and the top of
    // the phase-3 write transaction (the guard).
    const order = readFileSync(join(SRC_ROOT, 'modules', 'outbound', 'order.command.ts'), 'utf8');
    expect(order.match(/await assertClientTakesWorkInTx\(/g)?.length).toBe(2);
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

describe('architecture: business partners are partners-module-owned (story 1-3)', () => {
  /**
   * Story 1-3 renamed the Story 3.1 `vendors` table to `business_partners`
   * in place and added `partner_client_links`; both belong to the new
   * partners module alone. Inbound's PO guard and replenishment's default
   * pick read them through `partners.facade.ts` (file-level `…InTx`
   * functions on the caller's transaction) — never by writing them, and never
   * past the facade / module / DTO.
   */
  const PARTNER_TABLES = ['businessPartners', 'partnerClientLinks'] as const;
  const RAW_PARTNER_TABLES = 'business_partners|partner_client_links|vendors';
  const partnersRoot = join(SRC_ROOT, 'modules', 'partners');

  it('no partner-table write happens outside the partners module', () => {
    const outside = files.filter((file) => !file.path.startsWith(partnersRoot));
    const offenders: string[] = [];
    for (const file of outside) {
      for (const pattern of [
        ...PARTNER_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+"?(${RAW_PARTNER_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) offenders.push(`${file.path}: /${pattern.source}/`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no other module reaches into the partners module past the facade, module or DTO', () => {
    const internals = new RegExp('(?:modules/partners|\\.\\./partners)/(?!partners\\.(facade|module|dto)[\'"])');
    expect(internals.test("from '../partners/partners.command'")).toBe(true);
    expect(internals.test("from '../partners/partners.facade'")).toBe(false);
    expect(internals.test("from '../partners/partners.dto'")).toBe(false);
    const offenders = files
      .filter((file) => file.path.startsWith(join(SRC_ROOT, 'modules')) && !file.path.startsWith(partnersRoot))
      .filter((file) => internals.test(file.source))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('the partners command really writes both tables, and the PO guard and the sweep read through the facade (the test is meaningful)', () => {
    const command = readFileSync(join(partnersRoot, 'partners.command.ts'), 'utf8');
    expect(/\.insert\(\s*businessPartners\b/.test(command)).toBe(true);
    expect(/\.update\(\s*businessPartners\b/.test(command)).toBe(true);
    expect(/\.insert\(\s*partnerClientLinks\b/.test(command)).toBe(true);
    expect(/\.update\(\s*partnerClientLinks\b/.test(command)).toBe(true);
    // Nothing is ever deleted (decision: deactivate, never delete).
    for (const table of PARTNER_TABLES) expect(new RegExp(`\\.delete\\(\\s*${table}\\b`).test(command)).toBe(false);
    const po = readFileSync(join(SRC_ROOT, 'modules', 'inbound', 'po.command.ts'), 'utf8');
    expect(po).toContain("from '../partners/partners.facade'");
    expect(po).toMatch(/await assertVendorLinkedInTx\(/);
    const sweep = readFileSync(join(SRC_ROOT, 'modules', 'replenishment', 'replenishment.sweep.ts'), 'utf8');
    expect(sweep).toMatch(/findDefaultVendorForClientInTx\(/);
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
    for (const table of ['stockOnHand', 'batchOnHand', 'ledgerEvents', 'binStateEpochs', 'reservations', 'purchaseOrders', 'advanceShipmentNotices', 'asnLines', 'skus', 'businessPartners', 'partnerClientLinks', 'batches'] as const) {
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
        'advanceShipmentNotices',
        'asnLines',
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
    // Story 1-2a: `client-wind-down` is the declared file-level seam the
    // clients status command composes (it imports only shared/).
    const guard = new RegExp(
      '(?:modules/channels|\\.\\./channels)/(?!(?:channels\\.facade|channels\\.module|channels\\.dto|client-wind-down)[\'"])',
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

describe('architecture: the notification panel is notifications-module-owned (story 9-2)', () => {
  /**
   * Story 9-2: `notifications` and `notification_reads` are written ONLY by
   * the notifications module (the delivery handler projects the outbox
   * events; the facade records a panel open), and the module reads NO
   * sibling's table — its entries are a projection of events, never a join
   * into the source modules (the spec's Never list). Siblings reach it only
   * through its facade/module.
   */
  // Story 9-2b adds the push queue (`push_deliveries`) to the module's tables.
  const NOTIFICATION_TABLES = ['notifications', 'notificationReads', 'pushDeliveries'] as const;
  const RAW_NOTIFICATION_TABLES = 'notifications|notification_reads|push_deliveries';
  const notificationsRoot = join(SRC_ROOT, 'modules', 'notifications');
  const notificationFiles = files.filter((file) => file.path.startsWith(notificationsRoot));
  /**
   * The schema names the module may import: its two tables and types, plus
   * two shared status VOCABULARIES (tuples, never tables) its resolutions
   * derive from.
   */
  const OWN_SCHEMA_NAMES = new Set([
    'notifications',
    'notificationReads',
    'NotificationRow',
    'pushDeliveries',
    'PushDeliveryRow',
    'UserRole',
    'COUNT_VARIANCE_STATUSES',
    'REJECTED_OP_STATUSES',
  ]);
  const SCHEMA_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[./]*shared\/db\/schema'/g;

  function schemaNames(source: string): string[] {
    return [...source.matchAll(SCHEMA_IMPORT)].flatMap((match) =>
      match[1]!
        .split(',')
        .map((name) => name.replace(/^\s*type\s+/, '').trim())
        .filter((name) => name.length > 0),
    );
  }

  it('the detectors bite (the test is meaningful)', () => {
    expect(notificationFiles.length).toBeGreaterThanOrEqual(4);
    expect(schemaNames("import { notifications, reorderBreaches } from '../../shared/db/schema';")).toEqual([
      'notifications',
      'reorderBreaches',
    ]);
    expect(schemaNames("import type { UserRole } from '../../shared/db/schema';")).toEqual(['UserRole']);
    // The delivery writes the entries, the facade the reads — both real.
    const delivery = readFileSync(join(notificationsRoot, 'notifications.delivery.ts'), 'utf8');
    const facade = readFileSync(join(notificationsRoot, 'notifications.facade.ts'), 'utf8');
    expect(drizzleWriteOn('notifications').test(delivery)).toBe(true);
    expect(drizzleWriteOn('notificationReads').test(facade)).toBe(true);
    expect(schemaNames(delivery)).toContain('notifications');
    // Story 9-2b: the enqueue and the sender really write the push queue.
    const enqueue = readFileSync(join(notificationsRoot, 'push.enqueue.ts'), 'utf8');
    const sender = readFileSync(join(notificationsRoot, 'push.sender.ts'), 'utf8');
    expect(drizzleWriteOn('pushDeliveries').test(enqueue)).toBe(true);
    expect(drizzleWriteOn('pushDeliveries').test(sender)).toBe(true);
  });

  it('the push enqueue (an outbox handler) makes no network call and never reaches the gateway (story 9-2b)', () => {
    // The relay is one serial loop for every tenant: a network call inside a
    // handler would let a provider outage stall it and quarantine rows the
    // 9-2 projection shares. Only the sender may hold the gateway.
    const NETWORK = /from 'node:https?'|from 'https?'|\bfetch\(|PUSH_GATEWAY|PushGateway\b|push-gateway'/;
    expect(NETWORK.test("import https from 'node:https';")).toBe(true);
    expect(NETWORK.test("@Inject(PUSH_GATEWAY) private readonly gateway: PushGateway")).toBe(true);
    const enqueue = readFileSync(join(notificationsRoot, 'push.enqueue.ts'), 'utf8');
    expect(NETWORK.test(enqueue)).toBe(false);
    for (const handler of ['notifications.delivery.ts', 'push.enqueue.ts']) {
      expect(NETWORK.test(readFileSync(join(notificationsRoot, handler), 'utf8'))).toBe(false);
    }
    // Meaningful: the sender does hold it.
    expect(NETWORK.test(readFileSync(join(notificationsRoot, 'push.sender.ts'), 'utf8'))).toBe(true);
  });

  it('no notifications-table write happens outside the notifications module', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => !f.path.startsWith(notificationsRoot))) {
      for (const pattern of [
        ...NOTIFICATION_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_NOTIFICATION_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) {
          offenders.push(`${file.path}: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the notifications module touches no other module’s table (it imports only its own from the schema, and runs no raw SQL statement)', () => {
    const offenders: string[] = [];
    for (const file of notificationFiles) {
      for (const name of schemaNames(file.source)) {
        if (!OWN_SCHEMA_NAMES.has(name)) offenders.push(`${file.path}: imports ${name}`);
      }
      if (/\.execute\(|sql\.raw\(/.test(file.source)) offenders.push(`${file.path}: raw SQL statement`);
    }
    expect(offenders).toEqual([]);
  });

  it('no other module reaches into the notifications module past the facade (and only the api shell, the jobs shell + root import it)', () => {
    const reaching = /(?:modules\/notifications|\.\.\/notifications)\/(?!notifications\.(?:facade|module)['"])/;
    expect(reaching.test("from '../modules/notifications/notifications.delivery'")).toBe(true);
    expect(reaching.test("from '../modules/notifications/notification-sources'")).toBe(true);
    expect(reaching.test("from '../modules/notifications/notifications.facade'")).toBe(false);
    const importers = files.filter(
      (file) => !file.path.startsWith(notificationsRoot) && /(?:modules\/notifications|\.\.\/notifications)\//.test(file.source),
    );
    // Meaningful: the api shell does import it.
    expect(importers.some((file) => file.path === join(SRC_ROOT, 'api', 'notifications.controller.ts'))).toBe(true);
    // Story 9-2b: the jobs shell drives the push sender through the facade.
    const allowedImporter = (path: string): boolean =>
      path.startsWith(join(SRC_ROOT, 'api')) ||
      path === join(SRC_ROOT, 'app.module.ts') ||
      path === join(SRC_ROOT, 'jobs', 'jobs.module.ts');
    expect(importers.filter((file) => !allowedImporter(file.path)).map((file) => file.path)).toEqual([]);
    const jobs = files.find((file) => file.path === join(SRC_ROOT, 'jobs', 'jobs.module.ts'))!;
    expect(reaching.test(jobs.source)).toBe(false);
    // Sibling MODULES may not reach past the facade at all; the api shell's
    // DTOs read the source vocabulary (the summaries' resolution enums).
    const offenders = importers
      .filter((file) => file.path.startsWith(join(SRC_ROOT, 'modules')) && reaching.test(file.source))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
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
      for (const table of [...STOCK_TABLES, 'clients', 'skus', 'orders', 'orderLines', 'purchaseOrders', 'advanceShipmentNotices', 'asnLines'] as const) {
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
    // Story 1-2a: `client-wind-down` is the declared file-level seam the
    // clients status command composes (it imports only shared/).
    const reach = /from '[^']*modules\/billing\/(?!billing\.facade'|billing\.module'|rate-cards'|client-wind-down')[^']*'|from '\.\.\/billing\/(?!billing\.facade'|billing\.module'|rate-cards'|client-wind-down')[^']*'/;
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

describe('architecture: advance shipment notices are inbound-module-owned (story 21-6)', () => {
  /**
   * Story 21-6 adds the ASN beside the PO in the inbound module (spec-3pl
   * `architecture.md`: "inbound — gains the ASN document beside the PO (same
   * module, same GRN flow)"). `advance_shipment_notices` and `asn_lines` are
   * written ONLY under `src/modules/inbound` — the ASN commands and the
   * receiving fold (received quantities, the derived status). Readers
   * elsewhere (the SKU client-correction history probe, billing's drill
   * through `InboundFacade`) read; nothing outside writes.
   */
  const inboundRoot = join(SRC_ROOT, 'modules', 'inbound');

  it('no ASN-table write happens outside the inbound module', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => !f.path.startsWith(inboundRoot))) {
      for (const pattern of [
        drizzleWriteOn('advanceShipmentNotices'),
        drizzleWriteOn('asnLines'),
        new RegExp('\\b(insert into|update|delete from)\\s+"?(advance_shipment_notices|asn_lines)\\b', 'i'),
      ]) {
        if (pattern.test(file.source)) offenders.push(`${file.path}: /${pattern.source}/`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the inbound module really writes both tables (the test is meaningful)', () => {
    const command = readFileSync(join(inboundRoot, 'asn.command.ts'), 'utf8');
    expect(drizzleWriteOn('advanceShipmentNotices').test(command)).toBe(true);
    expect(drizzleWriteOn('asnLines').test(command)).toBe(true);
    const receiving = readFileSync(join(inboundRoot, 'receiving.command.ts'), 'utf8');
    expect(/\.update\(\s*asnLines\b/.test(receiving)).toBe(true);
  });
});

describe('architecture: return authorizations are returns-module-owned (story 13-1)', () => {
  /**
   * Story 13-1 stands up the returns module (Epic 13). `return_authorizations`
   * and `return_authorization_lines` are written ONLY under
   * `src/modules/returns`, and the module READS no sibling's table: it imports
   * from the schema only its own two tables, `idempotencyKeys` and
   * `auditEvents` (the keyed-command tail), and no raw `sql` names an order,
   * pick, ledger, serial, SKU or handling-unit table — the order facts, the
   * ledger and the catalog come through `OutboundFacade`, `InventoryFacade`
   * and `CatalogFacade` only. Siblings reach it only through its facade
   * (only the api shell and the root composition import it).
   *
   * Story 13-2 (design review #13) amends it: the module also owns
   * `return_receipts` and `return_receipt_lines` (only it writes them), and
   * it reaches tenancy's devices, users, bins and review queue only through
   * tenancy's exported in-transaction helpers (`assertDeviceOperatorInTx`,
   * `ensureReturnsBinInTx`, `recordServerRejectedOpInTx`, `userEmailsInTx`) —
   * never their tables; `handling_units` stays catalog's (written only
   * through `CatalogFacade`). Returns imports tenancy; tenancy never imports
   * returns.
   */
  const returnsRoot = join(SRC_ROOT, 'modules', 'returns');
  const returnsFiles = files.filter((file) => file.path.startsWith(returnsRoot));
  const RETURNS_TABLES = ['returnAuthorizations', 'returnAuthorizationLines', 'returnReceipts', 'returnReceiptLines'] as const;
  const RAW_RETURNS_WRITE =
    /\b(insert into|update|delete from)\s+"?(return_authorizations|return_authorization_lines|return_receipts|return_receipt_lines)\b/i;
  const OWN_SCHEMA_NAMES = new Set([
    'returnAuthorizations',
    'returnAuthorizationLines',
    'ReturnAuthorizationRow',
    'ReturnAuthorizationLineRow',
    'returnReceipts',
    'returnReceiptLines',
    'ReturnReceiptRow',
    'ReturnReceiptLineRow',
    'idempotencyKeys',
    'auditEvents',
  ]);
  const SCHEMA_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[./]*shared\/db\/schema'/g;
  /** A raw-SQL mention of a sibling table the module may only reach through a facade (13-2: or tenancy's helpers). */
  const FOREIGN_RAW_TABLE =
    /\b(orders|order_lines|picks|ledger_events|serials|skus|handling_units|devices|users|bins|zones|rejected_ops|stock_on_hand)\b/;
  /** The bodies of every `sql\`…\`` template in a source (the raw SQL the module runs). */
  function sqlTemplates(source: string): string[] {
    return [...source.matchAll(/\bsql(?:<[^>]*>)?`([^`]*)`/g)].map((match) => match[1]!);
  }
  function schemaNames(source: string): string[] {
    return [...source.matchAll(SCHEMA_IMPORT)].flatMap((match) =>
      match[1]!
        .split(',')
        .map((name) => name.replace(/^\s*type\s+/, '').trim())
        .filter((name) => name.length > 0),
    );
  }

  it('the detectors bite (the test is meaningful)', () => {
    expect(returnsFiles.length).toBeGreaterThanOrEqual(5);
    // The schema-import reader.
    expect(schemaNames("import { returnAuthorizations, orders } from '../../shared/db/schema';")).toEqual(['returnAuthorizations', 'orders']);
    expect(schemaNames("import type { ReturnAuthorizationRow } from '../../shared/db/schema';")).toEqual(['ReturnAuthorizationRow']);
    // The raw-SQL reader and the foreign-table detector.
    const raw = sqlTemplates('await tx.execute(sql`select sum(qty) from picks where order_line_id = ${id}`);');
    expect(raw).toHaveLength(1);
    expect(FOREIGN_RAW_TABLE.test(raw[0]!)).toBe(true);
    expect(sqlTemplates('sql<number>`select 1 from ledger_events`').some((text) => FOREIGN_RAW_TABLE.test(text))).toBe(true);
    expect(FOREIGN_RAW_TABLE.test('select pg_advisory_xact_lock(hashtextextended(${key}, 0))')).toBe(false);
    // The write detectors, against the module's own command.
    const command = readFileSync(join(returnsRoot, 'return-authorization.command.ts'), 'utf8');
    expect(drizzleWriteOn('returnAuthorizations').test(command)).toBe(true);
    expect(drizzleWriteOn('returnAuthorizationLines').test(command)).toBe(true);
    // Story 13-2 — the receipt command writes its two tables.
    const receipt = readFileSync(join(returnsRoot, 'return-receipt.command.ts'), 'utf8');
    expect(drizzleWriteOn('returnReceipts').test(receipt)).toBe(true);
    expect(drizzleWriteOn('returnReceiptLines').test(receipt)).toBe(true);
    expect(RAW_RETURNS_WRITE.test('sql`insert into return_receipt_lines values (1)`')).toBe(true);
    expect(FOREIGN_RAW_TABLE.test('select role from users where id = $1')).toBe(true);
    expect(RAW_RETURNS_WRITE.test('sql`update return_authorizations set status = 1`')).toBe(true);
    // Meaningful: the module really does run raw SQL the scan reads.
    expect(sqlTemplates(command).length).toBeGreaterThan(0);
  });

  it('no return-authorization write happens outside the returns module', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => !f.path.startsWith(returnsRoot))) {
      for (const pattern of [...RETURNS_TABLES.map((table) => drizzleWriteOn(table)), RAW_RETURNS_WRITE]) {
        if (pattern.test(file.source)) offenders.push(`${file.path}: /${pattern.source}/`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the returns module reads no sibling table: only its own tables, idempotencyKeys and auditEvents from the schema; no raw SQL names an order, pick, ledger, serial, SKU or handling-unit table', () => {
    const offenders: string[] = [];
    for (const file of returnsFiles) {
      for (const name of schemaNames(file.source)) {
        if (!OWN_SCHEMA_NAMES.has(name)) offenders.push(`${file.path}: imports ${name}`);
      }
      for (const text of sqlTemplates(file.source)) {
        if (FOREIGN_RAW_TABLE.test(text)) offenders.push(`${file.path}: raw SQL names a sibling table: ${text.trim().slice(0, 80)}`);
      }
      if (/sql\.raw\(/.test(file.source)) offenders.push(`${file.path}: sql.raw`);
    }
    expect(offenders).toEqual([]);
  });

  it('no other module reaches into the returns module (only the api shell and the root import it, through the facade/module)', () => {
    const importsReturns = /(?:modules\/returns|\.\.\/returns)\//;
    // Story 1-2a: `client-wind-down` is the declared file-level seam the
    // clients status command composes (it imports only shared/ and its own table).
    const reaching = /(?:modules\/returns|\.\.\/returns)\/(?!(?:returns\.(?:facade|module|dto)|client-wind-down)['"])/;
    expect(reaching.test("from '../modules/returns/return-authorization.command'")).toBe(true);
    expect(reaching.test("from '../modules/returns/returns.facade'")).toBe(false);
    const importers = files.filter((file) => !file.path.startsWith(returnsRoot) && importsReturns.test(file.source));
    expect(importers.some((file) => file.path === join(SRC_ROOT, 'api', 'returns.controller.ts'))).toBe(true);
    const allowed = (path: string): boolean =>
      path.startsWith(join(SRC_ROOT, 'api')) ||
      path === join(SRC_ROOT, 'app.module.ts') ||
      // Story 1-2a — the clients status command composes the wind-down read
      // (and only that: `reaching` below still refuses anything else).
      path === join(SRC_ROOT, 'modules', 'clients', 'clients.command.ts');
    expect(importers.filter((file) => !allowed(file.path)).map((file) => file.path)).toEqual([]);
    expect(importers.filter((file) => reaching.test(file.source)).map((file) => file.path)).toEqual([]);
    const moduleSource = readFileSync(join(returnsRoot, 'returns.module.ts'), 'utf8');
    expect(moduleSource).toMatch(/exports:\s*\[ReturnsFacade\]/);
  });

  it('story 13-2: returns reaches tenancy only through its exported helpers, imports no devices/users/bins/rejected_ops table, and tenancy never imports returns', () => {
    const tenancyRoot = join(SRC_ROOT, 'modules', 'tenancy');
    // Tenancy → returns would be a cycle (and the apply arm has no
    // return.receive case — Discard only).
    const tenancyImportsReturns = files
      .filter((file) => file.path.startsWith(tenancyRoot))
      .filter((file) => /(?:modules\/returns|\.\.\/returns)\//.test(file.source))
      .map((file) => file.path);
    expect(tenancyImportsReturns).toEqual([]);
    // The tenancy files returns may import — the helper files, plus the
    // pre-13-1 permission / idempotency / role imports every command uses.
    const ALLOWED_TENANCY = new Set([
      'device-operator',
      'receiving-bin',
      'server-rejected-op',
      'tenancy.service',
      'permissions',
      'idempotency-guard',
      'registration.command',
    ]);
    const offenders: string[] = [];
    for (const file of returnsFiles) {
      for (const match of file.source.matchAll(/from '\.\.\/tenancy\/([a-z.-]+)'/g)) {
        if (!ALLOWED_TENANCY.has(match[1]!)) offenders.push(`${file.path}: imports tenancy/${match[1]!}`);
      }
    }
    expect(offenders).toEqual([]);
    // Meaningful: the receipt really uses the three helpers.
    const receipt = readFileSync(join(returnsRoot, 'return-receipt.command.ts'), 'utf8');
    for (const helper of ['assertDeviceOperatorInTx', 'ensureReturnsBinInTx', 'recordServerRejectedOpInTx']) {
      expect(receipt).toContain(helper);
    }
    // handling_units is catalog's: returns creates a returned case only
    // through the catalog facade.
    expect(drizzleWriteOn('handlingUnits').test(receipt)).toBe(false);
    expect(receipt).toContain('this.catalog.createHandlingUnits(');
  });
});

describe('architecture: the client portal (story 21-7)', () => {
  /**
   * `users.client_id` is written ONLY by the invite insert and never
   * updated: the token's `client_id` claim (AD-4 amended for the fence) can
   * then never go stale. The CHECK (0065) pairs it with the `client` role,
   * and the role is never ASSIGNED `client` nor changed FROM it (the DTO and
   * the command refusal, proved by HTTP tests in test/portal.spec.ts — a
   * source scan cannot see role values).
   */
  const USERS_CLIENT_UPDATE = /\.update\(\s*users\s*\)\s*\.set\(\s*\{[^}]*\bclientId\b/;
  const RAW_USERS_CLIENT_UPDATE = /\bupdate\s+"?users"?\s+set\b[^;`]*\bclient_id\b/i;
  const USERS_CLIENT_INSERT = /\.insert\(\s*users\s*\)\s*\.values\(\s*\{[^}]*\bclientId\b/;
  const INVITE_FILE = join(SRC_ROOT, 'modules', 'tenancy', 'users.command.ts');

  it('no code path updates users.client_id (Drizzle or raw SQL); only the invite insert writes it', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const pattern of [USERS_CLIENT_UPDATE, RAW_USERS_CLIENT_UPDATE]) {
        if (pattern.test(file.source)) offenders.push(`${file.path}: /${pattern.source}/`);
      }
      if (file.path !== INVITE_FILE && USERS_CLIENT_INSERT.test(file.source)) {
        offenders.push(`${file.path}: inserts a users row carrying clientId`);
      }
      // Any `.update(users)` whose patch names clientId, however it is built.
      for (const match of file.source.matchAll(/\.update\(\s*users\s*\)([\s\S]{0,600}?)\.where\(/g)) {
        if (/\bclientId\b/.test(match[1]!)) offenders.push(`${file.path}: an .update(users) patch names clientId`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the invite really is the writer, and the detectors bite (the test is meaningful)', () => {
    expect(USERS_CLIENT_INSERT.test(readFileSync(INVITE_FILE, 'utf8'))).toBe(true);
    expect(USERS_CLIENT_UPDATE.test('tx.update(users).set({ role, clientId: other })')).toBe(true);
    expect(RAW_USERS_CLIENT_UPDATE.test('UPDATE users SET client_id = $1 WHERE id = $2')).toBe(true);
    expect(USERS_CLIENT_UPDATE.test('tx.update(users).set({ role: command.role, updatedAt: nowIso() })')).toBe(false);
    expect(/\.update\(\s*users\s*\)([\s\S]{0,600}?)\.where\(/.exec('tx.update(users).set({ ...patch, clientId }).where(eq(users.id, id))')?.[1]).toContain('clientId');
  });

  /**
   * Two layers, both required: every portal read's transaction is stamped
   * with the client (`withTenantTransaction(…, { clientId })` — RLS), and
   * its query carries the explicit predicate. jest e2e connects as a
   * superuser (RLS inert), so the HTTP tests prove only the predicate; this
   * scan proves the stamp is there, and the `wms_rls_probe` arms in
   * test/client-isolation.spec.ts prove the stamp alone isolates.
   */
  const PORTAL_READS: readonly { file: string; methods: readonly string[] }[] = [
    { file: join(SRC_ROOT, 'modules', 'inventory', 'inventory.facade.ts'), methods: ['portalStock'] },
    { file: join(SRC_ROOT, 'modules', 'outbound', 'outbound.facade.ts'), methods: ['portalOrders', 'portalOrder'] },
    { file: join(SRC_ROOT, 'modules', 'inbound', 'inbound.facade.ts'), methods: ['portalAsns', 'portalAsn', 'portalPurchaseOrders', 'portalPurchaseOrder'] },
    { file: join(SRC_ROOT, 'modules', 'billing', 'billing.facade.ts'), methods: ['portalInvoices', 'portalInvoice'] },
    { file: join(SRC_ROOT, 'modules', 'clients', 'clients.facade.ts'), methods: ['portalMeIn'] },
    // Story 21-7b — the announce form's two reads.
    { file: join(SRC_ROOT, 'modules', 'catalog', 'catalog.facade.ts'), methods: ['portalSkus'] },
    { file: join(SRC_ROOT, 'modules', 'tenancy', 'tenancy.service.ts'), methods: ['portalWarehouses'] },
    // Story 21-8 — the client's service report (the operator read's twin, stamped).
    { file: join(SRC_ROOT, 'modules', 'reporting', 'reporting.facade.ts'), methods: ['portalServiceReport'] },
  ];

  /** The body of one method or function: from its declaration to the next top-level member. */
  function bodyOf(source: string, name: string): string | null {
    const start = new RegExp(`\\n\\s*(?:export\\s+)?(?:async\\s+)?(?:function\\s+)?${name}\\s*\\(`).exec(source);
    if (start === null) return null;
    const rest = source.slice(start.index + 1);
    const end = /\n(?: {2}(?:async |\/\*\*|\/\/ ──|get |private |public )|\}\n|export )/.exec(rest.slice(1));
    return end === null ? rest : rest.slice(0, end.index + 1);
  }

  function stampsClient(body: string): boolean {
    return /withTenantTransaction\(/.test(body) && /\{\s*clientId\s*,?\s*\}\s*,?\s*\)/.test(body);
  }

  it('every portal facade read opens withTenantTransaction stamped with { clientId }', () => {
    const offenders: string[] = [];
    for (const { file, methods } of PORTAL_READS) {
      const source = readFileSync(file, 'utf8');
      for (const method of methods) {
        const body = bodyOf(source, method);
        if (body === null) offenders.push(`${file}: no ${method}`);
        else if (!stampsClient(body)) offenders.push(`${file}: ${method} does not stamp { clientId }`);
      }
    }
    expect(offenders).toEqual([]);
    // Every portal read the facades declare is on the list (a new one cannot slip past).
    const declared = PORTAL_READS.flatMap(({ file }) =>
      [...readFileSync(file, 'utf8').matchAll(/\n {2}async (portal[A-Z]\w*)\(/g)].map((match) => match[1]!),
    );
    expect(declared.sort()).toEqual(
      [
        'portalStock',
        'portalOrders',
        'portalOrder',
        'portalAsns',
        'portalAsn',
        'portalPurchaseOrders',
        'portalPurchaseOrder',
        'portalInvoices',
        'portalInvoice',
        'portalMe',
        'portalSkus',
        'portalWarehouses',
        'portalServiceReport',
      ].sort(),
    );
  });

  /**
   * Story 21-7b — the portal's WRITES carry the same two layers. The stamp
   * lives in the COMMAND, not the facade (`InboundFacade.announceAsn` is a
   * one-line delegation, deliberately not `portal*`-named, so the read scan
   * above never sees it): the command opens its own `withTenantTransaction`
   * stamped with the SESSION's client (`{ clientId: command.clientId }`).
   */
  const PORTAL_WRITES: readonly { file: string; methods: readonly string[] }[] = [
    { file: join(SRC_ROOT, 'modules', 'inbound', 'asn.command.ts'), methods: ['announce'] },
  ];

  function stampsCommandClient(body: string): boolean {
    return /withTenantTransaction\(/.test(body) && /\{\s*clientId:\s*command\.clientId\s*,?\s*\}\s*,?\s*\)/.test(body);
  }

  it('every portal write command opens withTenantTransaction stamped with { clientId: command.clientId }', () => {
    const offenders: string[] = [];
    for (const { file, methods } of PORTAL_WRITES) {
      const source = readFileSync(file, 'utf8');
      for (const method of methods) {
        const body = bodyOf(source, method);
        if (body === null) offenders.push(`${file}: no ${method}`);
        else if (!stampsCommandClient(body)) offenders.push(`${file}: ${method} does not stamp { clientId: command.clientId }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the write-stamp detector bites (the test is meaningful)', () => {
    const stamped = `
  async announce(command: AnnounceAsnCommand, key: string) {
    return withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => writeInTx(tx, command),
      { clientId: command.clientId },
    );
  }
`;
    const unstamped = `
  async announce(command: AnnounceAsnCommand, key: string) {
    return withTenantTransaction(this.db, command.tenantId, async (tx) => writeInTx(tx, command));
  }
`;
    const wrongClient = `
  async announce(command: AnnounceAsnCommand, key: string) {
    return withTenantTransaction(this.db, command.tenantId, async (tx) => writeInTx(tx, command), { clientId: body.clientId });
  }
`;
    expect(stampsCommandClient(bodyOf(stamped, 'announce')!)).toBe(true);
    expect(stampsCommandClient(bodyOf(unstamped, 'announce')!)).toBe(false);
    expect(stampsCommandClient(bodyOf(wrongClient, 'announce')!)).toBe(false);
    // The real command is found by name (a rename would empty the scan).
    expect(bodyOf(readFileSync(PORTAL_WRITES[0]!.file, 'utf8'), 'announce')).not.toBeNull();
  });

  it('the stamp detector bites (the test is meaningful)', () => {
    const stamped = `
  async portalThing(tenantId: string, clientId: string) {
    return withTenantTransaction(this.db, tenantId, (tx) => readInTx(tx, tenantId, clientId), { clientId });
  }
`;
    const unstamped = `
  async portalThing(tenantId: string, clientId: string) {
    return withTenantTransaction(this.db, tenantId, (tx) => readInTx(tx, tenantId, clientId));
  }
`;
    const wrongOption = `
  async portalThing(tenantId: string, clientId: string) {
    return withTenantTransaction(this.db, tenantId, (tx) => readInTx(tx, tenantId, clientId), { isolationLevel: 'repeatable read' });
  }
`;
    expect(stampsClient(bodyOf(stamped, 'portalThing')!)).toBe(true);
    expect(stampsClient(bodyOf(unstamped, 'portalThing')!)).toBe(false);
    expect(stampsClient(bodyOf(wrongOption, 'portalThing')!)).toBe(false);
  });

  /**
   * Story 21-11a (epic-21 retro X3) — the scans above check the NAMED facade
   * methods; nothing tied the portal controller's calls to them. A new portal
   * route calling an unstamped facade read (the operator `listOrders`, say)
   * would return every client's rows — the policies are open when the
   * transaction is unstamped (0041) — and every test would still pass. So:
   *
   *   1. the controller's injected fields are pinned (field → class), so a
   *      new facade cannot arrive with methods that share a stamped name;
   *   2. every `this.<field>.<method>(` call — multi-line and optional calls
   *      included — must be a `field.method` pair from PORTAL_READS (via the
   *      file's class and its field) or a DECLARED delegation;
   *   3. no escape hatch: every `this.<field>` must be immediately called
   *      (an alias, a destructure or a facade passed as an argument fails);
   *   4. each delegation's target is itself on PORTAL_READS / PORTAL_WRITES,
   *      and the delegating method is a single `return <target>(…);`.
   */
  const PORTAL_CONTROLLER = join(SRC_ROOT, 'api', 'portal.controller.ts');

  const PORTAL_CONTROLLER_FIELDS: Readonly<Record<string, string>> = {
    clients: 'ClientsFacade',
    inventory: 'InventoryFacade',
    outbound: 'OutboundFacade',
    inbound: 'InboundFacade',
    billing: 'BillingFacade',
    catalog: 'CatalogFacade',
    tenancy: 'TenancyService',
    reporting: 'ReportingFacade',
  };

  /** Each PORTAL_READS file's class — the one the controller injects. */
  const PORTAL_READ_CLASS_BY_FILE: ReadonlyMap<string, string> = new Map([
    [join(SRC_ROOT, 'modules', 'inventory', 'inventory.facade.ts'), 'InventoryFacade'],
    [join(SRC_ROOT, 'modules', 'outbound', 'outbound.facade.ts'), 'OutboundFacade'],
    [join(SRC_ROOT, 'modules', 'inbound', 'inbound.facade.ts'), 'InboundFacade'],
    [join(SRC_ROOT, 'modules', 'billing', 'billing.facade.ts'), 'BillingFacade'],
    [join(SRC_ROOT, 'modules', 'clients', 'clients.facade.ts'), 'ClientsFacade'],
    [join(SRC_ROOT, 'modules', 'catalog', 'catalog.facade.ts'), 'CatalogFacade'],
    [join(SRC_ROOT, 'modules', 'tenancy', 'tenancy.service.ts'), 'TenancyService'],
    [join(SRC_ROOT, 'modules', 'reporting', 'reporting.facade.ts'), 'ReportingFacade'],
  ]);

  /**
   * The facade methods the controller calls that are not themselves on the
   * lists, each a one-statement hand-off to a target that is. `via` names
   * the injected member (and its class) the hand-off goes through; without
   * it the target is a function in the facade's own file.
   */
  const PORTAL_DELEGATIONS: readonly {
    field: string;
    method: string;
    target: string;
    via?: { member: string; className: string };
    /** The method's whole body, whitespace-normalised — nothing else may ride in it, its arguments included. */
    statement: string;
  }[] = [
    { field: 'clients', method: 'portalMe', target: 'portalMeIn', statement: 'return portalMeIn(this.db, tenantId, userId, clientId);' },
    {
      field: 'inbound',
      method: 'announceAsn',
      target: 'announce',
      via: { member: 'asnCommand', className: 'AsnCommand' },
      statement: 'return this.asnCommand.announce(command, idempotencyKey);',
    },
  ];

  /**
   * The client argument every controller call must carry: the SESSION's
   * client (the guard's re-read), never one from the path, query or body.
   * Every `<x>.clientId` in a call's arguments must be `session.clientId`,
   * and at least one must be present. `portalMe` additionally passes the
   * session's user — its whole argument list is pinned.
   */
  const SESSION_CLIENT = 'session.clientId';
  const PINNED_CALL_ARGS: Readonly<Record<string, string>> = {
    'clients.portalMe': 'tenantId, session.userId, session.clientId',
  };

  /** `@Inject(X) private readonly <field>: X` pairs of the controller's constructor. */
  function controllerFields(source: string): Record<string, string> {
    const ctor = /\n\s*constructor\(([\s\S]*?)\)\s*\{\s*\}/.exec(source);
    if (ctor === null) return {};
    const fields: Record<string, string> = {};
    const params = ctor[1]!;
    const injected = [...params.matchAll(/@Inject\((\w+)\)\s+private\s+readonly\s+(\w+)\s*:\s*(\w+)/g)];
    for (const [, token, field, type] of injected) {
      // The token and the declared type must agree (a mismatched token injects another class).
      fields[field!] = token === type ? type! : `${token}≠${type}`;
    }
    // A parameter injected any other way is a field the map does not see.
    const declared = [...params.matchAll(/\b(?:private|public|protected|readonly)\s+(?:readonly\s+)?(\w+)\s*:/g)];
    for (const [, field] of declared) {
      if (!(field! in fields)) fields[field!] = '<not @Inject-ed>';
    }
    return fields;
  }

  const CONTROLLER_CALL = /this\.(\w+)\s*\??\.\s*(\w+)\s*\(/g;

  /**
   * The source with every comment and string literal blanked to spaces
   * (offsets kept), so prose like "this client's orders" in an `@ApiOperation`
   * summary is not read as code. A template literal's `${…}` stays code.
   */
  function codeOnly(source: string): string {
    const out = source.split('');
    const blank = (from: number, to: number): void => {
      for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
    };
    let i = 0;
    const templateDepth: number[] = []; // brace depth at each open `${`
    let braces = 0;
    while (i < source.length) {
      const c = source[i]!;
      const next = source[i + 1];
      if (c === '/' && next === '/') {
        const end = source.indexOf('\n', i);
        const stop = end === -1 ? source.length : end;
        blank(i, stop);
        i = stop;
      } else if (c === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end === -1 ? source.length : end + 2;
        blank(i, stop);
        i = stop;
      } else if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
        blank(i, j + 1);
        i = j + 1;
      } else if (c === '`' || (c === '}' && templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === braces)) {
        if (c === '}') templateDepth.pop();
        // Inside a template: blank up to the closing backtick or the next `${`.
        let j = i + 1;
        while (j < source.length && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) j += source[j] === '\\' ? 2 : 1;
        blank(i, j);
        if (source[j] === '$') {
          templateDepth.push(braces);
          i = j + 2;
        } else {
          out[j] = ' ';
          i = j + 1;
        }
      } else {
        if (c === '{') braces += 1;
        else if (c === '}') braces -= 1;
        i += 1;
      }
    }
    return out.join('');
  }

  /** The argument text of a call whose `(` ends just before `from`, up to its matching `)` (unbalanced → the rest). */
  function callArguments(source: string, from: number): string {
    let depth = 1;
    for (let i = from; i < source.length; i += 1) {
      const c = source[i];
      if (c === '(') depth += 1;
      else if (c === ')' && (depth -= 1) === 0) return source.slice(from, i);
    }
    return source.slice(from);
  }

  /** Every offence in a controller source: an unknown field, an unlisted pair, an escape hatch, a non-session client. */
  function portalControllerOffenders(rawSource: string, fields: ReadonlySet<string>, allowed: ReadonlySet<string>): string[] {
    const source = codeOnly(rawSource);
    const offenders: string[] = [];
    const callStarts = new Set<number>();
    for (const match of source.matchAll(CONTROLLER_CALL)) {
      callStarts.add(match.index!);
      const [, field, method] = match;
      if (!fields.has(field!)) offenders.push(`this.${field}.${method}( — ${field} is not a pinned field`);
      else if (!allowed.has(`${field}.${method}`)) offenders.push(`this.${field}.${method}( — not a stamped portal read or a declared delegation`);
      const args = callArguments(source, match.index! + match[0].length);
      const pinned = PINNED_CALL_ARGS[`${field}.${method}`];
      if (pinned !== undefined) {
        if (args.replace(/\s+/g, ' ').trim() !== pinned) offenders.push(`this.${field}.${method}( — arguments are not exactly (${pinned})`);
      } else if (!args.includes(SESSION_CLIENT)) {
        offenders.push(`this.${field}.${method}( — does not pass ${SESSION_CLIENT}`);
      }
      for (const client of args.matchAll(/(?:\b[\w$]+\s*\??\.\s*)+clientId\b/g)) {
        if (client[0].replace(/\s+/g, '') !== SESSION_CLIENT) {
          offenders.push(`this.${field}.${method}( — passes ${client[0].replace(/\s+/g, '')}, not ${SESSION_CLIENT}`);
        }
      }
    }
    for (const match of source.matchAll(/\bthis\b(\s*\??\.\s*(\w+))?/g)) {
      if (callStarts.has(match.index!)) continue;
      offenders.push(
        match[2] === undefined
          ? `\`this\` used bare at offset ${match.index} (a destructure or a pass-through)`
          : `this.${match[2]} is not immediately called (an alias, or the facade passed as a value)`,
      );
    }
    return offenders;
  }

  /** The allowed `field.method` pairs: PORTAL_READS through file → class → field, plus the delegations. */
  function allowedPortalPairs(): Set<string> {
    const fieldOfClass = new Map(Object.entries(PORTAL_CONTROLLER_FIELDS).map(([field, cls]) => [cls, field]));
    const allowed = new Set<string>();
    for (const { file, methods } of PORTAL_READS) {
      const cls = PORTAL_READ_CLASS_BY_FILE.get(file);
      if (cls === undefined) throw new Error(`PORTAL_READS file ${file} has no entry in PORTAL_READ_CLASS_BY_FILE`);
      const field = fieldOfClass.get(cls);
      if (field === undefined) throw new Error(`${cls} (from ${file}) is not an injected portal controller field`);
      for (const method of methods) allowed.add(`${field}.${method}`);
    }
    for (const { field, method } of PORTAL_DELEGATIONS) allowed.add(`${field}.${method}`);
    return allowed;
  }

  it('PortalSessionGuard guards routes in portal.controller.ts only (the scan below covers every portal route)', () => {
    const users = files.filter((file) => /@UseGuards\([^)]*\bPortalSessionGuard\b/.test(file.source)).map((file) => file.path);
    expect(users).toEqual([PORTAL_CONTROLLER]);
  });

  it('the portal controller injects exactly the pinned facades (field → class)', () => {
    expect(controllerFields(readFileSync(PORTAL_CONTROLLER, 'utf8'))).toEqual(PORTAL_CONTROLLER_FIELDS);
    // Every PORTAL_READS file is mapped to a class it really declares, and that class is injected.
    for (const { file } of PORTAL_READS) {
      const cls = PORTAL_READ_CLASS_BY_FILE.get(file);
      expect(cls).toBeDefined();
      expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`\\nexport class ${cls}\\b`));
      expect(Object.values(PORTAL_CONTROLLER_FIELDS)).toContain(cls);
    }
  });

  it('every portal controller call is a stamped portal read or a declared delegation — no escape hatch', () => {
    const source = readFileSync(PORTAL_CONTROLLER, 'utf8');
    const fields = new Set(Object.keys(PORTAL_CONTROLLER_FIELDS));
    expect(portalControllerOffenders(source, fields, allowedPortalPairs())).toEqual([]);
    // The scan really reads the controller's calls (a broken regex would pass empty).
    const calls = [...source.matchAll(CONTROLLER_CALL)].map((match) => `${match[1]}.${match[2]}`);
    expect(calls.length).toBeGreaterThanOrEqual(14);
    expect(calls).toEqual(expect.arrayContaining(['outbound.portalOrders', 'inbound.announceAsn', 'clients.portalMe']));
  });

  it('each declared delegation is exactly its pinned `return <target>(…);` to a listed portal read or write', () => {
    const listedTargets = new Map<string, string[]>();
    for (const { file, methods } of [...PORTAL_READS, ...PORTAL_WRITES]) {
      for (const method of methods) listedTargets.set(method, [...(listedTargets.get(method) ?? []), file]);
    }
    const fileOfClass = new Map([...PORTAL_READ_CLASS_BY_FILE].map(([file, cls]) => [cls, file]));
    const offenders: string[] = [];
    for (const { field, method, target, via, statement } of PORTAL_DELEGATIONS) {
      const facadeFile = fileOfClass.get(PORTAL_CONTROLLER_FIELDS[field]!)!;
      const source = readFileSync(facadeFile, 'utf8');
      const targetFiles = listedTargets.get(target) ?? [];
      if (via === undefined) {
        // A function of the facade's own file, listed against that file.
        if (!targetFiles.includes(facadeFile)) offenders.push(`${field}.${method} → ${target}: not listed for ${facadeFile}`);
      } else {
        // The member is injected as the named class, and the target is listed against the file declaring it.
        if (!new RegExp(`@Inject\\(${via.className}\\)\\s+private\\s+readonly\\s+${via.member}\\s*:\\s*${via.className}\\b`).test(source)) {
          offenders.push(`${field}.${method}: ${via.member} is not an injected ${via.className}`);
        }
        if (!targetFiles.some((file) => new RegExp(`\\nexport class ${via.className}\\b`).test(readFileSync(file, 'utf8')))) {
          offenders.push(`${field}.${method} → ${target}: not listed for ${via.className}`);
        }
      }
      const body = bodyOf(source, method);
      if (body === null || delegationStatement(body) !== statement) {
        offenders.push(`${field}.${method}: its body is not exactly \`${statement}\``);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('story 9-3a: the audit trail is never a portal read — not on PORTAL_READS, not a delegation, never called by the portal controller', () => {
    expect(PORTAL_READS.flatMap(({ methods }) => methods)).not.toContain('auditTrail');
    expect(PORTAL_DELEGATIONS.map(({ method, target }) => [method, target]).flat()).not.toContain('auditTrail');
    expect(readFileSync(PORTAL_CONTROLLER, 'utf8')).not.toMatch(/auditTrail|reporting\/audit/);
  });

  /** A method's whole body, comments dropped and whitespace normalised (null when it cannot be parsed). */
  function delegationStatement(body: string): string | null {
    const inner = /\)\s*(?::\s*[^{]+)?\{([\s\S]*)\}\s*$/.exec(body.trimEnd());
    if (inner === null) return null;
    return inner[1]!
      .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/\(\s/g, '(')
      .replace(/\s\)/g, ')')
      .trim();
  }

  it('the controller-call scan bites: an unknown call, a multi-line call, an optional call and an alias are flagged', () => {
    const fields = new Set(Object.keys(PORTAL_CONTROLLER_FIELDS));
    const allowed = allowedPortalPairs();
    const clean = `
    const page = await this.outbound.portalOrders(tenantId, session.clientId, query);
    return this.clients.portalMe(tenantId, session.userId, session.clientId);`;
    const unknownCall = `
    const page = await this.outbound.listOrders(tenantId, query);`;
    const multiLine = `
    const page = await this.outbound
      .listOrders(tenantId, session.clientId, query);`;
    const optional = `
    const page = await this.outbound?.listOrders(tenantId, query);`;
    const alias = `
    const o = this.outbound;
    return o.listOrders(tenantId, query);`;
    const destructure = `
    const { outbound } = this;
    return outbound.listOrders(tenantId, query);`;
    const passedAsValue = `
    return readThrough(this.outbound, tenantId);`;
    const unknownField = `
    return this.reservations.portalStock(tenantId, session.clientId);`;
    expect(portalControllerOffenders(clean, fields, allowed)).toEqual([]);
    for (const fixture of [unknownCall, multiLine, optional, alias, destructure, passedAsValue, unknownField]) {
      expect(portalControllerOffenders(fixture, fields, allowed)).not.toEqual([]);
    }
    // Prose and comments are not code; a template's `${…}` is.
    expect(portalControllerOffenders(`summary: "This client's orders — this.outbound" // this.outbound`, fields, allowed)).toEqual([]);
    expect(portalControllerOffenders('const s = `orders ${readThrough(this.outbound)}`;', fields, allowed)).not.toEqual([]);
    expect(portalControllerOffenders(multiLine, fields, allowed)).toEqual([
      'this.outbound.listOrders( — not a stamped portal read or a declared delegation',
    ]);
    // The field map catches a new or re-typed injection.
    const extraField = `
  constructor(
    @Inject(ClientsFacade) private readonly clients: ClientsFacade,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}`;
    expect(controllerFields(extraField)).toEqual({ clients: 'ClientsFacade', orders: 'OrdersService' });
    // The delegation shape check refuses an extra statement hidden inside.
    const twoStatements = `
  async portalMe(tenantId: string, userId: string, clientId: string): Promise<PortalMe> {
    const leak = await listEveryClientsOrders(tenantId);
    return portalMeIn(this.db, tenantId, userId, clientId);
  }
`;
    const oneStatement = `
  async portalMe(tenantId: string, userId: string, clientId: string): Promise<PortalMe> {
    return portalMeIn(this.db, tenantId, userId, clientId);
  }
`;
    const workInArgs = `
  async portalMe(tenantId: string, userId: string, clientId: string): Promise<PortalMe> {
    return portalMeIn(this.db, tenantId, userId, (await listEveryClientsOrders(tenantId), clientId));
  }
`;
    const pinned = PORTAL_DELEGATIONS.find((d) => d.method === 'portalMe')!.statement;
    expect(delegationStatement(bodyOf(oneStatement, 'portalMe')!)).toBe(pinned);
    expect(delegationStatement(bodyOf(twoStatements, 'portalMe')!)).not.toBe(pinned);
    expect(delegationStatement(bodyOf(workInArgs, 'portalMe')!)).not.toBe(pinned);
    // A client id from the query, the body or the path is flagged, even on an allowed read.
    for (const foreign of [
      'const page = await this.outbound.portalOrders(tenantId, query.clientId, {});',
      'const page = await this.outbound.portalOrders(tenantId, dto.clientId ?? session.clientId, {});',
      'return this.clients.portalMe(tenantId, session.userId, query.clientId);',
      'const page = await this.inventory.portalStock(tenantId, clientId, pageQuery(query));',
    ]) {
      expect(portalControllerOffenders(foreign, fields, allowed)).not.toEqual([]);
    }
    // The announce shape — the session's client inside an object argument — passes.
    expect(
      portalControllerOffenders('const asn = await this.inbound.announceAsn({ tenantId, clientId: session.clientId, lines }, key);', fields, allowed),
    ).toEqual([]);
  });
});

describe('architecture: the audit read is reporting\'s THIRD read-only exception (story 9-3a)', () => {
  /**
   * Human decision 2 (2026-10-12): the audit trail read lives in reporting
   * as its third named exception (IMPLEMENTATION-GUIDE §7a), on the
   * narrowest terms — it reads `audit_events` and nothing else. The
   * directory-wide reporting guards above (writes nothing, owns no table,
   * only the api shell imports it) cover it too; these are its own.
   *
   * Story 9-3b moved its FILTER to `shared/db/audit-filter.ts` (the export
   * reads the same rows, and tenancy may not import reporting): that file is
   * held to the same rules — only `auditEvents`, no other table, no join, no
   * role read.
   */
  const AUDIT_READ = join(SRC_ROOT, 'modules', 'reporting', 'audit.ts');
  const AUDIT_FILTER = join(SRC_ROOT, 'shared', 'db', 'audit-filter.ts');
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const READ_MODELS = [AUDIT_READ, AUDIT_FILTER].map((path) => {
    const source = readFileSync(path, 'utf8');
    return { path, source, code: strip(source) };
  });

  /** The names a file imports from the schema module (`./schema` is the shared filter's own spelling). */
  function schemaImports(text: string): string[] {
    return [...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(?:[./]*shared\/db\/schema|\.\/schema)'/g)].flatMap((match) =>
      match[1]!.split(',').map((name) => name.trim()).filter((name) => name.length > 0),
    );
  }

  /** Every snake_case table-ish identifier named after FROM/JOIN/INTO/UPDATE in raw SQL. */
  function rawTableNames(text: string): string[] {
    return [...text.matchAll(/\b(?:from|join|into|update)\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((match) => match[1]!);
  }

  it('the detectors bite', () => {
    expect(schemaImports("import { auditEvents, users } from '../../shared/db/schema';")).toEqual(['auditEvents', 'users']);
    expect(schemaImports("import { auditEvents, users } from './schema';")).toEqual(['auditEvents', 'users']);
    expect(rawTableNames('sql`select 1 from audit_events a join users u on true`')).toEqual(['audit_events', 'users']);
  });

  it('the read imports the shared filter (9-3b: one definition of the filter, never a copy)', () => {
    expect(READ_MODELS[0]!.code).toMatch(/import \{ auditFilterSql \} from '\.\.\/\.\.\/shared\/db\/audit-filter'/);
    expect(READ_MODELS[0]!.code).toMatch(/\.\.\.auditFilterSql\(tenantId, query\)/);
  });

  it.each(READ_MODELS.map((model) => [model.path.slice(SRC_ROOT.length + 1), model] as const))(
    '%s imports only `auditEvents` from the schema',
    (_name, model) => {
      expect(schemaImports(model.source)).toEqual(['auditEvents']);
    },
  );

  it.each(READ_MODELS.map((model) => [model.path.slice(SRC_ROOT.length + 1), model] as const))(
    '%s names no table but audit_events in raw SQL',
    (_name, model) => {
      // Drizzle builder calls (`.from(auditEvents)`) are covered by the import
      // pin; this catches a raw `from <table>` / `join <table>` in a template.
      const sqlTemplates = [...model.code.matchAll(/sql(?:<[^>]*>)?`([^`]*)`/g)].map((match) => match[1]!);
      expect(sqlTemplates.length).toBeGreaterThan(0);
      expect(sqlTemplates.flatMap(rawTableNames).filter((name) => name !== 'audit_events')).toEqual([]);
    },
  );

  it.each(READ_MODELS.map((model) => [model.path.slice(SRC_ROOT.length + 1), model] as const))(
    '%s contains no join (no second table can enter the read)',
    (_name, model) => {
      expect(/join/i.test(model.code)).toBe(false);
    },
  );

  it.each(READ_MODELS.map((model) => [model.path.slice(SRC_ROOT.length + 1), model] as const))(
    '%s never reads a role (the role check is the facade\'s, in its own transaction)',
    (_name, model) => {
      expect(model.code).not.toMatch(/getMemberRoleIn|assertPermission|\busers\b/);
    },
  );

  it('the facade carries the guard line verbatim', () => {
    const facade = readFileSync(join(SRC_ROOT, 'modules', 'reporting', 'reporting.facade.ts'), 'utf8');
    expect(facade).toMatch(/assertPermission\(await getMemberRoleIn\(tx, tenantId, actorUserId\), 'audit\.view'\)/);
  });
});

describe('architecture: the audit exports are tenancy-owned (story 9-3b)', () => {
  /**
   * Story 9-3b: `audit_exports` and `audit_export_files` are written ONLY by
   * the tenancy module (the request command, the worker's runner, the
   * Postgres file store) — the 9-2 notifications block's shape. Reporting
   * stays read-only and gains no export code; the routes sit in the api
   * shell's `ReportingController`, which calls `TenancyService`.
   */
  const EXPORT_TABLES = ['auditExports', 'auditExportFiles'] as const;
  const RAW_EXPORT_TABLES = 'audit_exports|audit_export_files';
  const tenancyRoot = join(SRC_ROOT, 'modules', 'tenancy');
  const reportingRoot = join(SRC_ROOT, 'modules', 'reporting');

  it('the detectors bite (the test is meaningful): the command, the runner and the store really write', () => {
    const command = readFileSync(join(tenancyRoot, 'audit-export.command.ts'), 'utf8');
    const runner = readFileSync(join(tenancyRoot, 'audit-export.runner.ts'), 'utf8');
    const store = readFileSync(join(tenancyRoot, 'audit-export.store.ts'), 'utf8');
    expect(drizzleWriteOn('auditExports').test(command)).toBe(true);
    expect(drizzleWriteOn('auditExports').test(runner)).toBe(true);
    expect(drizzleWriteOn('auditExportFiles').test(store)).toBe(true);
    expect(new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_EXPORT_TABLES})\\b`, 'i').test('sql`delete from audit_export_files`')).toBe(true);
  });

  it('no export-table write happens outside the tenancy module', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => !f.path.startsWith(tenancyRoot))) {
      for (const pattern of [
        ...EXPORT_TABLES.map((table) => drizzleWriteOn(table)),
        new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_EXPORT_TABLES})\\b`, 'i'),
      ]) {
        if (pattern.test(file.source)) offenders.push(`${file.path}: /${pattern.source}/`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reporting holds no export code (it never names the export tables or the runner)', () => {
    const offenders = files
      .filter((file) => file.path.startsWith(reportingRoot))
      .filter((file) => /\bauditExports?\b|auditExportFiles|audit_exports?\b|audit_export_files|AuditExport/.test(file.source))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('the worker-written lifecycle events are outbox events only — the runner writes no audit row', () => {
    const runner = strip(readFileSync(join(tenancyRoot, 'audit-export.runner.ts'), 'utf8'));
    expect(drizzleWriteOn('auditEvents').test(runner)).toBe(false);
    expect(runner).toMatch(/this\.outbox\.append\(/);
  });

  function strip(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
});

describe('architecture: the ledger integrity tables are inventory-owned (story 9-3c)', () => {
  /**
   * Story 9-3c: `ledger_integrity_state`, `ledger_chain_breaks` and
   * `ledger_anchor_worm_copies` are written ONLY by the inventory module —
   * the ledger is inventory's, and so is the record of its integrity. Within
   * the module the writers are named: the break recorder
   * (`ledger.service.ts` — the ONE path every detector records through), the
   * integrity check (`ledger-integrity.ts` — baseline, run stamps, the
   * rotation cursor, the WORM copy rows) and the acknowledgement
   * (`ledger-break.command.ts`). The routes reach them through
   * `InventoryFacade` only.
   */
  const INTEGRITY_TABLES = ['ledgerIntegrityState', 'ledgerChainBreaks', 'ledgerAnchorWormCopies'] as const;
  const RAW_INTEGRITY_TABLES = 'ledger_integrity_state|ledger_chain_breaks|ledger_anchor_worm_copies';
  const inventoryRoot = join(SRC_ROOT, 'modules', 'inventory');
  const WRITERS: Readonly<Record<(typeof INTEGRITY_TABLES)[number], readonly string[]>> = {
    ledgerIntegrityState: [join(inventoryRoot, 'ledger.service.ts'), join(inventoryRoot, 'ledger-integrity.ts')],
    ledgerChainBreaks: [join(inventoryRoot, 'ledger.service.ts'), join(inventoryRoot, 'ledger-break.command.ts')],
    ledgerAnchorWormCopies: [join(inventoryRoot, 'ledger-integrity.ts')],
  };

  it('the detectors bite (the test is meaningful): each named writer really writes its table', () => {
    for (const [table, writers] of Object.entries(WRITERS)) {
      for (const path of writers) {
        expect(drizzleWriteOn(table).test(readFileSync(path, 'utf8'))).toBe(true);
      }
    }
    expect(new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_INTEGRITY_TABLES})\\b`, 'i').test('sql`update ledger_chain_breaks set`')).toBe(true);
  });

  it('no integrity-table write happens outside its named inventory writers', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const table of INTEGRITY_TABLES) {
        if (drizzleWriteOn(table).test(file.source) && !WRITERS[table].includes(file.path)) {
          offenders.push(`${file.path}: ${table}`);
        }
      }
      if (new RegExp(`\\b(insert into|update|delete from)\\s+(${RAW_INTEGRITY_TABLES})\\b`, 'i').test(file.source)) {
        offenders.push(`${file.path}: raw write`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the WORM copy rows are append-only in code too (never updated or deleted)', () => {
    const offenders = files
      .filter((file) => /\.(update|delete)\(\s*ledgerAnchorWormCopies\b/.test(file.source))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('the api shell reaches the integrity surface through the facade only', () => {
    const controller = readFileSync(join(SRC_ROOT, 'api', 'inventory.controller.ts'), 'utf8');
    expect(controller).toMatch(/this\.inventoryFacade\.ledgerIntegrity\(/);
    expect(controller).toMatch(/this\.inventoryFacade\.acknowledgeChainBreak\(/);
    expect(controller).not.toMatch(/ledger-integrity|ledger-break\.command|LedgerIntegrityService|LedgerBreakCommand/);
  });
});

describe('architecture: the audit rule — every keyed command writes its audit row (story 9-3a, static half)', () => {
  /**
   * The dynamic half (`assertEveryKeyAudited`, every suite's teardown)
   * proves it for the paths the suites drive; this scan covers every file
   * under src/modules, so a keyed writer no suite reaches (invoicing's
   * manual generate, the client invoices) still cannot drop its audit row.
   */
  const KEY_WRITE = /\.insert\(\s*idempotencyKeys\b/;
  const AUDIT_REF = /\bauditEvents\b/;

  it('the detector bites', () => {
    expect(KEY_WRITE.test('await tx.insert(idempotencyKeys).values({})')).toBe(true);
    expect(KEY_WRITE.test('tx.select().from(idempotencyKeys)')).toBe(false);
  });

  it('every src/modules file that writes idempotencyKeys also references auditEvents', () => {
    const writers = files.filter((file) => file.path.startsWith(join(SRC_ROOT, 'modules')) && KEY_WRITE.test(file.source));
    // Meaningful: the keyed writers really are found (40 files when 9-3a landed).
    expect(writers.length).toBeGreaterThanOrEqual(35);
    expect(writers.some((file) => file.path.endsWith(join('invoicing', 'command.ts')))).toBe(true);
    expect(writers.some((file) => file.path.endsWith(join('billing', 'client-invoices.ts')))).toBe(true);
    expect(writers.filter((file) => !AUDIT_REF.test(file.source)).map((file) => file.path)).toEqual([]);
  });
});

describe('architecture: AUDIT_TARGET_TYPES is the audit vocabulary (story 9-3a)', () => {
  /**
   * The audit read's `targetType` filter is an enum published in
   * openapi.json (the web select is generated from it), so it must hold
   * EVERY target type a writer can store — and nothing no writer uses. Two
   * writers pick the type dynamically; their possible values are listed here.
   */
  const DYNAMIC_WRITERS: Readonly<Record<string, readonly string[]>> = {
    [join(SRC_ROOT, 'modules', 'outbound', 'pick.command.ts')]: ['picklist_line', 'pick'],
    [join(SRC_ROOT, 'modules', 'invoicing', 'eway.command.ts')]: ['eway_bill', 'eway_state_threshold', 'eway_gstin_setting'],
    // Story 13-2 — the receipt targets the receipt, or (nothing applied) the RMA.
    [join(SRC_ROOT, 'modules', 'returns', 'return-receipt.command.ts')]: ['return_receipt', 'return_authorization'],
    // Story 1-3 — the partner commands' one audit helper takes the target type.
    [join(SRC_ROOT, 'modules', 'partners', 'partners.command.ts')]: ['partner', 'partner_link'],
  };

  /** Literal `targetType: '…'` values, plus the e-way `audit(tx, …, '<action>', '<targetType>', …)` helper calls. */
  function literalTargetTypes(text: string): string[] {
    return [
      ...[...text.matchAll(/targetType:\s*'([a-z_]+)'/g)].map((match) => match[1]!),
      ...[...text.matchAll(/\baudit\(tx,\s*[a-zA-Z]+,\s*(?:'[^']*'|[a-zA-Z]+),\s*'([a-z_]+)'/g)].map((match) => match[1]!),
    ];
  }

  it('the detector bites', () => {
    expect(literalTargetTypes("targetType: 'transfer_order',")).toEqual(['transfer_order']);
    expect(literalTargetTypes("await audit(tx, command, 'eway.exported', 'eway_bill', id, key);")).toEqual(['eway_bill']);
  });

  it('holds every literal target type written under src, and none no writer uses', async () => {
    const { AUDIT_TARGET_TYPES } = await import('../src/shared/primitives/audit');
    const written = new Set<string>();
    for (const file of files) {
      if (file.path.endsWith(join('shared', 'primitives', 'audit.ts'))) continue;
      for (const type of literalTargetTypes(file.source)) written.add(type);
    }
    for (const [path, types] of Object.entries(DYNAMIC_WRITERS)) {
      expect(files.some((file) => file.path === path)).toBe(true);
      for (const type of types) written.add(type);
    }
    expect([...AUDIT_TARGET_TYPES].sort()).toEqual([...written].sort());
  });

  it('every AUDIT_NEW_ACTIONS row is pinned by an expectAuditRow assertion in some suite', async () => {
    const { AUDIT_NEW_ACTIONS } = await import('../src/shared/primitives/audit');
    const suites = tsFilesUnder(TEST_ROOT)
      .filter((path) => path.endsWith('.spec.ts'))
      .map((path) => readFileSync(path, 'utf8'))
      .filter((text) => text.includes('expectAuditRow('));
    const pinned = (action: string, targetType: string): boolean =>
      suites.some((text) =>
        new RegExp(`expectAuditRow\\(\\{[^}]*action: '${action.replace(/\./g, '\\.')}',[^}]*targetType: '${targetType}'`).test(text),
      );
    expect(AUDIT_NEW_ACTIONS.filter(({ action, targetType }) => !pinned(action, targetType)).map(({ action }) => action)).toEqual([]);
  });
});

describe('architecture: no suite deletes the audit guard\'s evidence before the check runs (story 9-3a)', () => {
  /**
   * `assertEveryKeyAudited` runs in `SuiteDatabase.drop()`, AFTER each
   * suite's `afterAll` cleanup. A cleanup that deletes `idempotency_keys` or
   * `audit_events` (the shared-DB era's habit) blinds the check — the suite
   * database is dropped whole anyway. The allowed deletes remove ONE named
   * row the suite itself put there (`... and key = ...`, `... where id = ...`).
   */
  const DELETE = /delete\s+from\s+"?(idempotency_keys|audit_events)\b/i;
  /** A table-name entry in a cleanup list: alone on its line, or after `[` / `,`. */
  const LISTED = /^\s*['"](idempotency_keys|audit_events)['"],?\s*$|[[,]\s*['"](idempotency_keys|audit_events)['"]/;

  it('the detectors bite', () => {
    expect(DELETE.test("await sql.unsafe('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [ids]);")).toBe(true);
    expect(LISTED.test("for (const table of ['outbox_messages', 'idempotency_keys', 'skus'])")).toBe(true);
    expect(LISTED.test("        'audit_events',")).toBe(true);
    expect(LISTED.test("t('idempotency_keys')")).toBe(false);
    expect(LISTED.test("await dbCount('idempotency_keys', 'and key = $2', [key])")).toBe(false);
  });

  it('no spec deletes idempotency_keys or audit_events wholesale (one named row only)', () => {
    const offenders: string[] = [];
    for (const path of tsFilesUnder(TEST_ROOT).filter((p) => p.endsWith('.spec.ts') && p !== __filename)) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const deleting = DELETE.test(line) && !/\b(and key|where id)\s*=/.test(line);
          if (deleting || LISTED.test(line)) offenders.push(`${path}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('architecture: the second factor’s key material has one home (story 6-1b)', () => {
  const tenancyRoot = join(SRC_ROOT, 'modules', 'tenancy');
  const SECRETS_OWNER = join(tenancyRoot, 'second-factor-secrets.ts');
  const ENVELOPE_IMPORT = /from\s+['"][^'"]*crypto\/envelope['"]/;

  it('MFA_ENCRYPTION_KEY (and its _PREVIOUS) is read only in second-factor-secrets.ts', () => {
    const offenders = files
      .filter((file) => file.path !== SECRETS_OWNER && /process\.env\.MFA_ENCRYPTION_KEY/.test(file.source))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
    // Meaningful: the owner really reads both.
    const owner = readFileSync(SECRETS_OWNER, 'utf8');
    expect(owner).toContain('process.env.MFA_ENCRYPTION_KEY');
    expect(owner).toContain('process.env.MFA_ENCRYPTION_KEY_PREVIOUS');
  });

  it('tenancy’s envelope importers are only enrollment.command.ts (and second-factor-secrets.ts, which does its own GCM)', () => {
    const importers = files
      .filter((file) => file.path.startsWith(tenancyRoot) && ENVELOPE_IMPORT.test(file.source))
      .map((file) => file.path.slice(tenancyRoot.length + 1))
      .sort();
    for (const importer of importers) expect(['enrollment.command.ts', 'second-factor-secrets.ts']).toContain(importer);
    expect(importers).toContain('enrollment.command.ts');
    // The 2FA secrets never go through the device envelope (whose seal/open default to the device key).
    expect(readFileSync(SECRETS_OWNER, 'utf8')).toContain("cipher.setAAD(");
  });

  it('the app refuses to boot without the key: main.ts runs the check before createApp', () => {
    const main = readFileSync(join(SRC_ROOT, 'main.ts'), 'utf8');
    const check = main.indexOf('assertSecondFactorKeyConfigured()');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(main.indexOf('await createApp('));
  });
});
