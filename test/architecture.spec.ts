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
  ] as const;
  const RAW_ORDER_TABLES =
    'orders|order_lines|wave_policies|waves|picklists|picklist_lines|picks';
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
    // No sibling module consumes carriers YET (4-6c's labels bring the
    // first), so the inventory twin's `siblingModules.length > 0`
    // meaningfulness assert cannot carry this one — it would fail on an
    // empty-but-correct codebase. Pin the detector directly instead (the
    // outbound block's precedent), so a typo or a regex that stops matching
    // an import form fails HERE rather than going unnoticed while the guard
    // silently scans nothing forever.
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
