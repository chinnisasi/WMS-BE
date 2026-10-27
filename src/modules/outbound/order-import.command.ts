import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { fromMilli } from '../../shared/primitives/quantity';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { MAX_SHEET_UPLOAD_BYTES, importTooLarge, readSheet, type SheetFile, type SheetRow } from '../../shared/import/sheet-reader';
import { quantityToMilli } from '../../shared/import/quantity-cell';
import { ValkeyClient } from '../../shared/valkey/valkey.client';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import { existingWarehouseCodesInTx, getMemberRoleIn, getWarehouseCodeInTx } from '../tenancy/tenancy.service';
import { getClientLabelsInTx, getClientsByCodesInTx, mixedClient } from '../clients/clients.facade';
import { CatalogFacade, type SkuByCode } from '../catalog/catalog.facade';
import {
  OrderCommandService,
  assertPortalOrderGateInTx,
  type CreateOrderCommand,
  type OrderSnapshot,
  type PlacePortalOrderCommand,
  type PortalPlacedOrder,
} from './order.command';
import {
  MAX_ORDER_IMPORT_ROWS,
  ORDER_IMPORT_COLUMNS,
  ORDER_IMPORT_REQUIRED_COLUMNS,
  ORDER_IMPORT_ROW_ERROR_CODES,
  assertOrderImportCount,
  groupOrderImportRows,
  mergeOrderHeader,
  orderImportOrderKey,
  orderRowError,
  readOrderImportRows,
  repeatedOrderSkus,
  tooManyLines,
  type OrderImportGroup,
  type OrderImportHeader,
  type OrderImportRow,
  type OrderImportRowError,
  type OrderImportRowErrorCode,
  type OrderImportSurface,
} from './order-import.parse';

// ── the knobs (exported, mutable — the §7c clock pattern) ────────────────────

/**
 * A3 — the server-side budget: the import starts no new order once this long
 * has passed since the request began. 15 s sits inside the API's 20 s SIGTERM
 * drain (DEPLOY.md) and far inside the ALB's 60 s idle cut; the orders not
 * started are reported in `notAttemptedCount` and the next Import of the same
 * file resumes them for free (every created order replays under its derived key).
 */
export const ORDER_IMPORT_TIME_BUDGET_MS = 15_000;

/** A1 — the per-key lease's lifetime: it outlives the budget with margin, and a dead run frees the key within it. */
export const ORDER_IMPORT_LEASE_TTL_MS = 60_000;

/**
 * The import's clock and its budget, read through an exported object so a
 * suite can move time (`orderImportClock.now = () => …`) without sleeping.
 */
export const orderImportClock: { now: () => number; budgetMs: number } = {
  now: () => Date.now(),
  budgetMs: ORDER_IMPORT_TIME_BUDGET_MS,
};

/**
 * A16 — a test seam: when set, awaited after each order the run attempts (its
 * index in the file's order list). The overlap test parks a run here; the
 * timing test injects latency. Null in production.
 */
export const orderImportHooks: { afterOrder: ((index: number) => Promise<void>) | null } = { afterOrder: null };

// ── commands and responses ───────────────────────────────────────────────────

export interface ImportOrdersCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  /** The warehouse every order of the file is for (the Orders page's selected warehouse). */
  readonly warehouseId: string;
  /** Check file: validate through the create's phase 1, write nothing (no key, no replay, no audit). */
  readonly dryRun: boolean;
  readonly file: SheetFile;
}

/** The portal import: the client is the session's — never a cell, never the body. */
export interface ImportPortalOrdersCommand extends ImportOrdersCommand {
  readonly clientId: string;
}

/** One order the staff import created — or, on a dry run, found ready. */
export interface OrderImportOrder {
  /** Null on a dry run. */
  readonly orderId: string | null;
  readonly clientOrderRef: string;
  /** Top-level lines (a kit line counts once). */
  readonly lineCount: number;
  /** The spreadsheet row of the order's first line. */
  readonly firstRow: number;
  /** True when this order was created by an earlier run of the same import (its derived key replayed). */
  readonly replayed: boolean;
  readonly clientId: string;
  /** The client as people read it — the tenant's own reads "<tenant name> (your company)". */
  readonly clientLabel: string;
  /** Top-level lines left `backordered` (a kit parent counts once); null on a dry run. */
  readonly backorderedLineCount: number | null;
}

/** One order the portal import placed (or found ready) — an exact key allowlist, no client labels or stock facts. */
export interface PortalOrderImportOrder {
  readonly orderId: string | null;
  readonly clientOrderRef: string;
  readonly lineCount: number;
  readonly firstRow: number;
  readonly replayed: boolean;
}

/** One refused row, with its own `sku` and `quantity` cells as written. */
export type OrderImportReportedError = OrderImportRowError & { readonly sku: string | null; readonly quantity: string | null };

interface ImportResponseBase<O> {
  /** The import's audit target; null on a dry run and on an incomplete run. */
  readonly importId: string | null;
  readonly dryRun: boolean;
  readonly warehouseId: string;
  readonly fileSha256: string;
  /** Data rows read (blank rows not counted). */
  readonly rowCount: number;
  /** Orders the file describes. */
  readonly orderCount: number;
  /** Orders created (dry run: ready). */
  readonly acceptedCount: number;
  /** Orders refused whole. */
  readonly refusedCount: number;
  /** False when the time budget stopped the run before every order was tried — Import again with the same file. */
  readonly complete: boolean;
  /** Orders the run did not reach (0 when complete). */
  readonly notAttemptedCount: number;
  readonly orders: readonly O[];
  /** Every refused row, in sheet order. */
  readonly errors: readonly OrderImportReportedError[];
}

/** The staff response — and, for a complete import, the idempotency snapshot. */
export type OrderImportResponse = ImportResponseBase<OrderImportOrder>;
/** The portal response — and, for a complete import, the idempotency snapshot. */
export type PortalOrderImportResponse = ImportResponseBase<PortalOrderImportOrder>;

// ── internals ────────────────────────────────────────────────────────────────

/** The create's own codes, passed through as row errors with the create's detail (A6). */
const PASSED_THROUGH_CODES: readonly OrderImportRowErrorCode[] = [
  'validation-failed',
  'not-found',
  'duplicate-client-order-ref',
  'client-departed',
  'client-suspended',
  'sku-inactive',
  'licence-not-covered',
  'order-catalog-changed',
  'order-backorder-rejected',
  'mixed-client',
];
const PASSED_THROUGH: ReadonlySet<string> = new Set<string>(PASSED_THROUGH_CODES);

// A compile-time-free sanity check that the passed-through codes are on the published list.
for (const code of PASSED_THROUGH) {
  if (!(ORDER_IMPORT_ROW_ERROR_CODES as readonly string[]).includes(code)) {
    throw new Error(`order-import: ${code} is passed through but not on ORDER_IMPORT_ROW_ERROR_CODES`);
  }
}

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/**
 * The codes that judge the WHOLE order (they sit on its first row): the
 * report leaves that row's sku and quantity cells out, so it does not point
 * at a line that did not cause it.
 */
const ORDER_LEVEL_CODES: ReadonlySet<string> = new Set<OrderImportRowErrorCode>([
  'client-required',
  'mixed-client',
  'duplicate-order-in-file',
  'too-many-lines',
  'order-changed-since-first-run',
  'order-refused',
  ...PASSED_THROUGH_CODES,
]);

interface Surface {
  readonly kind: OrderImportSurface;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly dryRun: boolean;
  readonly file: SheetFile;
  /** The import's fingerprint (decision 3) — the bytes and the target, never the parsed rows. */
  readonly fingerprint: Record<string, unknown>;
  /** Opens the import's own transactions (the portal: client-stamped). */
  readonly transaction: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  /** Authority — first in Transaction A (before the replay) and again first in Transaction B. */
  readonly authorize: (tx: TenantTx) => Promise<void>;
  /** The derived key's client part (A2): staff the `client` cell, portal the session's client. */
  readonly keyClient: (group: OrderImportGroup) => string;
}

/** A group Transaction A cleared — the create command's inputs. */
interface ReadyOrder {
  readonly clientId: string;
  readonly lines: readonly { readonly skuId: string; readonly quantity: number; readonly ratePaise?: number }[];
  readonly header: OrderImportHeader;
}

/** One group's outcome. */
type Outcome =
  | { readonly kind: 'refused' }
  | { readonly kind: 'ready'; readonly order: ReadyOrder }
  | { readonly kind: 'created'; readonly orderId: string | null; readonly clientId: string; readonly lineCount: number; readonly backordered: number | null; readonly replayed: boolean }
  | { readonly kind: 'not-attempted' };

interface Planned {
  readonly groups: readonly OrderImportGroup[];
  readonly keys: readonly (string | null)[];
  readonly outcomes: Outcome[];
  /** File and rule errors (they stand). */
  readonly errors: OrderImportRowError[];
  readonly labels: Map<string, string>;
  readonly sheet: readonly SheetRow[];
}

function problemOf(error: unknown): { code: string; status: number; detail: string; extensions?: Record<string, unknown> } | null {
  if (!(error instanceof ProblemException)) return null;
  const body = error.getResponse() as { code?: string; detail?: string; title?: string; extensions?: Record<string, unknown> };
  return {
    code: body.code ?? 'unknown',
    status: error.getStatus(),
    detail: body.detail ?? body.title ?? error.message,
    ...(body.extensions === undefined ? {} : { extensions: body.extensions }),
  };
}

/** A stored staff snapshot's facts (`OrderSnapshot`), or null when the row is not one. */
function staffSnapshotFacts(snapshot: unknown): { orderId: string; clientId: string; lineCount: number; backordered: number } | null {
  const order = (snapshot as { order?: { id?: unknown; clientId?: unknown; lines?: unknown } } | null)?.order;
  if (order === undefined || typeof order.id !== 'string' || typeof order.clientId !== 'string' || !Array.isArray(order.lines)) return null;
  const top = (order.lines as { parentLineId?: unknown; status?: unknown }[]).filter((line) => line.parentLineId === null || line.parentLineId === undefined);
  return { orderId: order.id, clientId: order.clientId, lineCount: top.length, backordered: top.filter((line) => line.status === 'backordered').length };
}

/** A stored portal snapshot's facts (`PortalPlacedOrder`), or null when the row is not one. */
function portalSnapshotFacts(snapshot: unknown): { orderId: string; lineCount: number } | null {
  const placed = snapshot as { orderId?: unknown; lineCount?: unknown } | null;
  if (placed === null || typeof placed.orderId !== 'string' || typeof placed.lineCount !== 'number') return null;
  return { orderId: placed.orderId, lineCount: placed.lineCount };
}

/**
 * The order import (story 4-1c): many orders from one CSV or XLSX file, one
 * row per order line, grouped by the client order number. Two steps on one
 * route per surface: Check file (`dryRun`) runs every order through the
 * create's phase 1 and writes nothing; Import creates each valid order
 * EXACTLY as the one-at-a-time create would — `createOrder` (staff) or
 * `placePortalOrder` (portal), under a key derived from the import's — and
 * refuses an order with any bad row whole, never the file.
 *
 * Flow: the fingerprint above any transaction → (Import) the per-key lease
 * (A1) → Transaction A: authority → (Import) the import key's replay → the
 * size cap → the sheet → the warehouse → rows, groups, the order cap → (Import)
 * the derived keys already committed, settled from their snapshots before any
 * rule (A2) → the lookups and the file's rules. Closes. Then each order in
 * file order, one after another, inside the 15 s budget (A3): Check →
 * `checkOrder` / `checkPortalOrder`; Import → the create, a 4xx being that
 * order's row error (after a probe of its derived key), a 5xx, 401 or 403
 * aborting the run. Then (Import) Transaction B: authority again → the
 * derived keys re-read (any committed one counts created) → for a complete run
 * the `order_import.executed` audit row and the import key, LAST.
 */
@Injectable()
export class OrderImportCommand {
  private readonly logger = new Logger('OrderImport');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
    @Inject(OrderCommandService) private readonly orders: OrderCommandService,
    @Inject(ValkeyClient) private readonly valkey: ValkeyClient,
  ) {}

  /** `POST …/outbound/order-imports` — the staff import (`orders.manage`). */
  async importOrders(command: ImportOrdersCommand, idempotencyKey: string | null): Promise<OrderImportResponse> {
    const fileSha256 = sha256(command.file.buffer);
    const surface: Surface = {
      kind: 'staff',
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      warehouseId: command.warehouseId,
      dryRun: command.dryRun,
      file: command.file,
      fingerprint: { surface: 'staff', warehouseId: command.warehouseId, fileSha256 },
      // The operator-shape transaction (an order's reads span the tenant).
      transaction: (fn) => withTenantTransaction(this.db, command.tenantId, fn),
      authorize: async (tx) => {
        assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'orders.manage');
      },
      keyClient: (group) => group.client.toUpperCase(),
    };
    const result = await this.run(surface, fileSha256, idempotencyKey, null);
    return result as OrderImportResponse;
  }

  /**
   * `POST …/portal/order-imports` — the client portal's import (`orders.place`),
   * a SEPARATE command (§7e): its own transactions stamped with the session's
   * client, the portal gate before its replay and again before its key, the
   * client's own active non-kit SKUs only, `placePortalOrder` per order, and
   * an exact-key response with no client labels or stock facts.
   */
  async importPortalOrders(command: ImportPortalOrdersCommand, idempotencyKey: string | null): Promise<PortalOrderImportResponse> {
    const fileSha256 = sha256(command.file.buffer);
    const surface: Surface = {
      kind: 'portal',
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      warehouseId: command.warehouseId,
      dryRun: command.dryRun,
      file: command.file,
      // `surface` FIRST — `idempotency_keys` is unique per tenant across every route.
      fingerprint: { surface: 'portal', clientId: command.clientId, warehouseId: command.warehouseId, fileSha256 },
      transaction: (fn) => withTenantTransaction(this.db, command.tenantId, fn, { clientId: command.clientId }),
      authorize: (tx) =>
        assertPortalOrderGateInTx(tx, { tenantId: command.tenantId, clientId: command.clientId, actorUserId: command.actorUserId }),
      keyClient: () => command.clientId,
    };
    const result = await this.run(surface, fileSha256, idempotencyKey, command.clientId);
    return result as PortalOrderImportResponse;
  }

  private async run(
    surface: Surface,
    fileSha256: string,
    idempotencyKey: string | null,
    portalClientId: string | null,
  ): Promise<OrderImportResponse | PortalOrderImportResponse> {
    if (!surface.dryRun && idempotencyKey === null) {
      throw new Error('OrderImportCommand: an import needs its Idempotency-Key');
    }
    const started = orderImportClock.now();
    const payloadHash = hashCommandPayload(surface.fingerprint);
    if (surface.dryRun) {
      return this.execute(surface, fileSha256, null, payloadHash, portalClientId, started);
    }
    const key = idempotencyKey!;
    // A1 — one run per import key at a time (the overlap defence).
    const leaseKey = `order-import:${surface.tenantId}:${key}`;
    const token = uuidv7();
    let held: boolean;
    try {
      held = await this.valkey.acquireLease(leaseKey, token, ORDER_IMPORT_LEASE_TTL_MS);
    } catch (error) {
      this.logger.error(`order import lease unavailable: ${(error as Error).message}`);
      throw new ProblemException(
        'reservation-store-unavailable',
        503,
        'Reservation store unavailable',
        'The stock reservation store is unreachable, so the import cannot run — nothing was created. Import again once it is back.',
      );
    }
    if (!held) {
      throw new ProblemException(
        'import-in-progress',
        409,
        'This import is still running',
        'This import is still running — wait a moment, then Import again to read its result.',
      );
    }
    try {
      return await this.execute(surface, fileSha256, key, payloadHash, portalClientId, started);
    } finally {
      // Never throws: the run's answer stands whatever happens to the lease (it expires anyway).
      try {
        if (!(await this.valkey.releaseLease(leaseKey, token))) {
          // The lease expired under this run (and may have been re-taken): the
          // overlap residual in PENDING — say so, so an operator can correlate.
          this.logger.warn(`order import lease ${leaseKey} had expired before the run ended (TTL ${ORDER_IMPORT_LEASE_TTL_MS} ms)`);
        }
      } catch (error) {
        this.logger.warn(`order import lease release failed (it expires in ${ORDER_IMPORT_LEASE_TTL_MS} ms): ${(error as Error).message}`);
      }
    }
  }

  private async execute(
    surface: Surface,
    fileSha256: string,
    key: string | null,
    payloadHash: string,
    portalClientId: string | null,
    started: number,
  ): Promise<OrderImportResponse | PortalOrderImportResponse> {
    // ── Transaction A ────────────────────────────────────────────────────
    const planned = await surface.transaction(async (tx): Promise<{ replay: unknown } | Planned> => {
      await surface.authorize(tx);
      if (key !== null) {
        const stored = await readKeysInTx(tx, surface.tenantId, [key]);
        const row = stored.get(key);
        if (row !== undefined) {
          if (row.payloadHash !== payloadHash) throw idempotencyKeyReuse();
          return { replay: row.responseSnapshot };
        }
      }
      return this.plan(tx, surface, fileSha256, key, portalClientId);
    });
    if ('replay' in planned) {
      return planned.replay as OrderImportResponse;
    }

    const { groups, keys, outcomes } = planned;
    const refusals = new Map<number, OrderImportRowError>();

    // ── each order, in file order, one after another (decision 2) ─────────
    // A3 — the budget: no order starts once it is spent, nor one that the
    // run's own measured pace (ms per line so far) says would end past it,
    // so a long order near the end cannot carry the request past the drain.
    // The run's first attempted order always starts, however long
    // Transaction A took (a run must make progress, or a retry would loop).
    // Once one order is held back every later one is too — file order.
    let budgetSpent = false;
    let attempted = 0;
    let spentMs = 0;
    let spentLines = 0;
    for (let index = 0; index < groups.length; index += 1) {
      const outcome = outcomes[index]!;
      if (outcome.kind !== 'ready') continue;
      const elapsed = orderImportClock.now() - started;
      const projected = spentLines === 0 ? 0 : (spentMs / spentLines) * outcome.order.lines.length;
      if (attempted > 0 && (budgetSpent || elapsed >= orderImportClock.budgetMs || elapsed + projected > orderImportClock.budgetMs)) {
        budgetSpent = true;
        outcomes[index] = { kind: 'not-attempted' };
        continue;
      }
      const group = groups[index]!;
      const derivedKey = keys[index] ?? null;
      const attemptStarted = orderImportClock.now();
      attempted += 1;
      try {
        outcomes[index] = await this.attempt(surface, group, outcome.order, derivedKey, portalClientId);
      } catch (error) {
        const problem = problemOf(error);
        if (problem === null || problem.status >= 500 || problem.status === 401 || problem.status === 403) {
          // Decision 5 — the run aborts: no import key, no audit row; every
          // order created so far keeps its own key and replays on the retry.
          if (problem !== null && problem.status === 503) {
            // THIS run's creations only — orders settled from an earlier run are not news.
            const created = outcomes.filter((entry) => entry.kind === 'created' && !entry.replayed).length;
            throw new ProblemException(
              problem.code,
              503,
              'Import stopped — the stock reservation store is unreachable',
              `${created === 1 ? '1 order was' : `${created} orders were`} created before the stock reservation store became unreachable. ` +
                'Import again with the same file once it is back — the orders already created are not created twice, and the rest are.',
              problem.extensions,
            );
          }
          throw error;
        }
        // Settle-once (A1/K3): any 4xx — a committed derived key counts the
        // order created. Except a 422 on the derived key itself (A6): the key
        // committed with ANOTHER payload, so the order that exists is not this
        // row's — it is reported `order-changed-since-first-run`, never as created.
        const committed =
          derivedKey === null || problem.code === 'idempotency-key-reuse'
            ? undefined
            : (await surface.transaction((tx) => readKeysInTx(tx, surface.tenantId, [derivedKey]))).get(derivedKey);
        const settled = committed === undefined ? null : this.settledOutcome(surface, committed.responseSnapshot);
        if (settled !== null) {
          outcomes[index] = settled;
        } else {
          outcomes[index] = { kind: 'refused' };
          refusals.set(index, this.refusalOf(group, problem));
        }
      }
      spentMs += orderImportClock.now() - attemptStarted;
      spentLines += outcome.order.lines.length;
      if (orderImportHooks.afterOrder !== null) await orderImportHooks.afterOrder(index);
    }

    const complete = !outcomes.some((entry) => entry.kind === 'not-attempted');
    if (key === null) {
      return this.respond(surface, fileSha256, planned, refusals, null, complete);
    }

    // ── Transaction B ────────────────────────────────────────────────────
    return surface.transaction(async (tx) => {
      await surface.authorize(tx);
      // The belt-and-braces re-read (B1): an order whose derived key committed
      // is created, whatever its call answered.
      const pending = keys.flatMap((derived, index) =>
        derived !== null && outcomes[index]!.kind === 'refused' && refusals.has(index) && refusals.get(index)!.code !== 'order-changed-since-first-run'
          ? [derived]
          : [],
      );
      if (pending.length > 0) {
        const committed = await readKeysInTx(tx, surface.tenantId, pending);
        keys.forEach((derived, index) => {
          const row = derived === null ? undefined : committed.get(derived);
          const settled = row === undefined ? null : this.settledOutcome(surface, row.responseSnapshot);
          if (settled !== null) {
            outcomes[index] = settled;
            refusals.delete(index);
          }
        });
      }
      await this.ensureLabels(tx, surface, planned);
      if (!complete) {
        // A3 — an incomplete run writes neither the import key nor its audit
        // row: the next Import of the same file resumes it.
        return this.respond(surface, fileSha256, planned, refusals, null, false);
      }
      const importId = uuidv7();
      const response = this.respond(surface, fileSha256, planned, refusals, importId, true);
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: surface.tenantId,
        actorUserId: surface.actorUserId,
        action: 'order_import.executed',
        targetType: 'order_import',
        targetId: importId,
        reference: key,
        occurredAt: nowIso(),
      });
      try {
        await tx.insert(idempotencyKeys).values({
          id: uuidv7(),
          tenantId: surface.tenantId,
          key,
          payloadHash,
          responseSnapshot: response,
        });
      } catch (error) {
        if (isUniqueViolationOn(error, IDEMPOTENCY_TENANT_KEY)) {
          throw new ProblemException(
            'conflict',
            409,
            'Concurrent idempotent request',
            'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
          );
        }
        throw error;
      }
      return response;
    });
  }

  /** Transaction A after the replay miss: the size cap, the sheet, grouping, the settled keys, the lookups and the file's rules. */
  private async plan(
    tx: TenantTx,
    surface: Surface,
    fileSha256: string,
    key: string | null,
    portalClientId: string | null,
  ): Promise<Planned> {
    if (surface.file.size > MAX_SHEET_UPLOAD_BYTES) {
      throw importTooLarge(`The file is ${surface.file.size} bytes — the cap is ${MAX_SHEET_UPLOAD_BYTES} bytes.`);
    }
    const sheet = await readSheet(surface.file, {
      knownColumns: new Set(ORDER_IMPORT_COLUMNS[surface.kind]),
      requiredColumns: ORDER_IMPORT_REQUIRED_COLUMNS,
      maxRows: MAX_ORDER_IMPORT_ROWS,
      unknownColumns: 'ignore',
      rowNumbers: 'sheet',
      missingColumns: 'all',
      dateCells: 'ist-wall-clock',
      numberCells: 'excel-display',
    });
    const warehouseCode = await getWarehouseCodeInTx(tx, surface.tenantId, surface.warehouseId);
    const read = readOrderImportRows(sheet, surface.kind);
    const groups = groupOrderImportRows(read.rows);
    // A6 — every group counts toward the cap, refused and settled ones included.
    assertOrderImportCount(groups.length);

    const errors: OrderImportRowError[] = [...read.errors];
    const outcomes: Outcome[] = groups.map(() => ({ kind: 'refused' }) as Outcome);
    const labels = new Map<string, string>();

    // ── A2: committed orders settle BEFORE any rule runs ──────────────────
    const keys = groups.map((group) =>
      key === null
        ? null
        : orderImportOrderKey(key, {
            surface: surface.kind,
            fileSha256,
            warehouseId: surface.warehouseId,
            client: surface.keyClient(group),
            orderRef: group.orderRef,
          }),
    );
    const settledIndexes = new Set<number>();
    if (key !== null) {
      const committed = await readKeysInTx(tx, surface.tenantId, keys.filter((entry): entry is string => entry !== null));
      keys.forEach((derived, index) => {
        const row = derived === null ? undefined : committed.get(derived);
        const settled = row === undefined ? null : this.settledOutcome(surface, row.responseSnapshot);
        if (settled !== null) {
          outcomes[index] = settled;
          settledIndexes.add(index);
        }
      });
    }

    // ── the lookups, in bulk, for every order still to judge ──────────────
    const open = groups.map((group, index) => ({ group, index })).filter(({ index }) => !settledIndexes.has(index));
    const openRows = open.flatMap(({ group }) => group.rows);
    const selectedWarehouse = warehouseCode.toUpperCase();
    const otherWarehouses = await existingWarehouseCodesInTx(
      tx,
      surface.tenantId,
      openRows.map((row) => row.warehouse).filter((code) => code !== '' && code.toUpperCase() !== selectedWarehouse),
    );
    const codes = openRows.map((row) => row.sku);
    // Staff: every holder of each code. Portal (A10): the session client's
    // codes only (the explicit predicate, in this stamped transaction), then
    // only ACTIVE NON-KIT SKUs — the `portal/skus` population — so another
    // client's code, a kit, an inactive SKU and an unknown code are the SAME
    // `unknown-sku`.
    const skus =
      surface.kind === 'staff'
        ? await this.catalog.getSkusByCodesInTx(tx, surface.tenantId, codes)
        : new Map(
            [...(await this.catalog.getClientSkusByCodesInTx(tx, surface.tenantId, portalClientId!, codes))].map(
              ([code, list]) => [code, list.filter((sku) => sku.status === 'active' && !sku.isKit)] as const,
            ),
          );
    const clients =
      surface.kind === 'staff'
        ? await getClientsByCodesInTx(
            tx,
            surface.tenantId,
            open.map(({ group }) => group.client).filter((cell) => cell !== ''),
          )
        : new Map<string, { id: string; label: string }>();
    for (const client of clients.values()) labels.set(client.id, client.label);

    // ── each open order: its client, its rows, its cells ──────────────────
    const clientOf = new Map<number, string>();
    const groupErrors = new Map<number, OrderImportRowError[]>();
    const ready = new Map<number, { lines: ReadyOrder['lines']; header: OrderImportHeader }>();
    for (const { group, index } of open) {
      const found: OrderImportRowError[] = [];
      const first = group.rows[0]!;
      const holdersOf = (row: OrderImportRow): readonly SkuByCode[] => skus.get(row.sku) ?? [];

      // The order's client (decision 9).
      let clientId: string | null = null;
      if (surface.kind === 'portal') {
        clientId = portalClientId;
      } else if (group.client !== '') {
        clientId = clients.get(group.client.toUpperCase())?.id ?? null;
        if (clientId === null) {
          for (const row of group.rows) {
            found.push(orderRowError(row.rowNumber, group.orderRef, 'unknown-client', `No client with code "${row.client}" exists in this tenant.`));
          }
        }
      } else {
        const known = group.rows.map(holdersOf).filter((list) => list.length > 0);
        const common =
          known.length === 0 ? [] : [...new Set(known[0]!.map((sku) => sku.clientId))].filter((id) => known.every((list) => list.some((sku) => sku.clientId === id)));
        if (common.length === 1) {
          clientId = common[0]!;
        } else if (common.length > 1) {
          const holderLabels = await getClientLabelsInTx(tx, surface.tenantId, common);
          found.push(
            orderRowError(
              first.rowNumber,
              group.orderRef,
              'client-required',
              `Order "${group.orderRef}" names no client, and its SKU codes are held by more than one client ` +
                `(${common.map((id) => holderLabels.get(id) ?? id).sort().join(', ')}) — fill the client column.`,
            ),
          );
        } else if (known.length > 0) {
          const spanned = [...new Set(known.flatMap((list) => list.map((sku) => sku.clientId)))];
          const spannedLabels = await getClientLabelsInTx(tx, surface.tenantId, spanned);
          const problem = problemOf(mixedClient(`Order "${group.orderRef}"`, spanned.map((id) => spannedLabels.get(id) ?? id)))!;
          found.push(orderRowError(first.rowNumber, group.orderRef, 'mixed-client', problem.detail));
        }
      }
      if (clientId !== null) clientOf.set(index, clientId);

      // Row by row — first failure wins on a row (its cell refusals ran first).
      const lines: { skuId: string; quantity: number; ratePaise?: number }[] = [];
      for (const row of group.rows) {
        if (row.refused) continue;
        if (row.warehouse !== '' && row.warehouse.toUpperCase() !== selectedWarehouse) {
          found.push(
            otherWarehouses.has(row.warehouse.toUpperCase())
              ? orderRowError(
                  row.rowNumber,
                  group.orderRef,
                  'wrong-warehouse',
                  `warehouse "${row.warehouse}" is another warehouse — this import creates orders in ${warehouseCode}; leave the column blank or switch warehouse.`,
                )
              : orderRowError(row.rowNumber, group.orderRef, 'unknown-warehouse', `No warehouse with code "${row.warehouse}" exists${surface.kind === 'portal' ? '' : ' in this tenant'}.`),
          );
          continue;
        }
        const holders = holdersOf(row);
        if (holders.length === 0) {
          found.push(
            orderRowError(
              row.rowNumber,
              group.orderRef,
              'unknown-sku',
              surface.kind === 'portal'
                ? `"${row.sku}" is not one of your active products — check the code against your product list (kits cannot be ordered here).`
                : `No SKU with code "${row.sku}" exists in this tenant.`,
            ),
          );
          continue;
        }
        if (clientId === null) continue; // the order's client is refused already
        const sku = holders.find((candidate) => candidate.clientId === clientId);
        if (sku === undefined) {
          found.push(
            orderRowError(
              row.rowNumber,
              group.orderRef,
              'sku-client-mismatch',
              `SKU "${row.sku}" is not a SKU of ${labels.get(clientId) ?? group.client} — every SKU of an order belongs to the order's client.`,
            ),
          );
          continue;
        }
        const quantity = quantityToMilli(row.quantity, sku.uom, sku.uomPrecision);
        if (!quantity.ok) {
          found.push(orderRowError(row.rowNumber, group.orderRef, quantity.code, quantity.detail));
          continue;
        }
        lines.push({
          skuId: sku.id,
          // BASE units cross into the create (story 10.2); exact from the milli value.
          quantity: fromMilli(quantity.milli),
          ...(row.ratePaise === null || row.ratePaise === undefined ? {} : { ratePaise: row.ratePaise }),
        });
      }
      const merged = mergeOrderHeader(group);
      found.push(...merged.errors, ...repeatedOrderSkus(group));
      const tooMany = tooManyLines(group);
      if (tooMany !== null) found.push(tooMany);
      groupErrors.set(index, found);
      if (found.length === 0 && clientId !== null && group.rows.every((row) => !row.refused)) {
        ready.set(index, { lines, header: merged.header });
      }
    }

    // Decision 9 — a blank-client order and a named one that settle on the
    // same (client, order number) are both refused (staff; a settled order's
    // client is its snapshot's).
    if (surface.kind === 'staff') {
      const byClientRef = new Map<string, number[]>();
      groups.forEach((group, index) => {
        const settled = outcomes[index]!;
        const clientId = settled.kind === 'created' ? settled.clientId : clientOf.get(index);
        if (clientId === undefined) return;
        const slot = `${clientId}\u0000${group.orderRef}`;
        byClientRef.set(slot, [...(byClientRef.get(slot) ?? []), index]);
      });
      for (const indexes of byClientRef.values()) {
        if (indexes.length < 2) continue;
        for (const index of indexes) {
          if (settledIndexes.has(index)) continue;
          const group = groups[index]!;
          const others = indexes.filter((other) => other !== index).map((other) => groups[other]!.rows[0]!.rowNumber);
          (groupErrors.get(index) ?? []).push(
            orderRowError(
              group.rows[0]!.rowNumber,
              group.orderRef,
              'duplicate-order-in-file',
              `Order "${group.orderRef}" appears again from row ${others.join(', ')} for the same client (a blank client is the SKUs' client) — give each order one client cell, or different order numbers.`,
            ),
          );
          ready.delete(index);
        }
      }
    }

    for (const [index, found] of groupErrors) {
      errors.push(...found);
      const entry = ready.get(index);
      if (entry !== undefined) outcomes[index] = { kind: 'ready', order: { clientId: clientOf.get(index)!, lines: entry.lines, header: entry.header } };
    }
    const planned: Planned = { groups, keys, outcomes, errors, labels, sheet };
    await this.ensureLabels(tx, surface, planned);
    return planned;
  }

  /** One order's Check (dry run) or create (Import). Throws the create's refusal. */
  private async attempt(
    surface: Surface,
    group: OrderImportGroup,
    order: ReadyOrder,
    derivedKey: string | null,
    portalClientId: string | null,
  ): Promise<Outcome> {
    const { header } = order;
    const destination = {
      contactName: header.shipToName,
      phone: header.shipToPhone,
      line1: header.shipToLine1,
      ...(header.shipToLine2 === null ? {} : { line2: header.shipToLine2 }),
      city: header.shipToCity,
      state: header.shipToState,
      pincode: header.shipToPincode,
    };
    // The cells VERBATIM (each only when given) — the command normalises them
    // and owns every refusal behind its replay lookup.
    const fields = {
      ...(header.consigneeGstin === null ? {} : { consigneeGstin: header.consigneeGstin }),
      ...(header.consigneeLegalName === null ? {} : { consigneeLegalName: header.consigneeLegalName }),
      clientOrderRef: group.orderRef,
      ...(header.orderType === null ? {} : { orderType: header.orderType }),
      ...(header.priority === null ? {} : { priority: header.priority }),
      ...(header.shipBy === null ? {} : { shipByDate: header.shipBy }),
      ...(header.codAmountPaise === null ? {} : { codAmountPaise: header.codAmountPaise }),
    };
    if (surface.kind === 'staff') {
      const create: CreateOrderCommand = {
        tenantId: surface.tenantId,
        actorUserId: surface.actorUserId,
        warehouseId: surface.warehouseId,
        source: 'manual',
        destination,
        ...fields,
        lines: order.lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity, ...(line.ratePaise === undefined ? {} : { ratePaise: line.ratePaise }) })),
      };
      if (derivedKey === null) {
        const checked = await this.orders.checkOrder(create);
        return { kind: 'created', orderId: null, clientId: checked.clientId, lineCount: checked.lineCount, backordered: null, replayed: false };
      }
      const snapshot: OrderSnapshot = await this.orders.createOrder(create, derivedKey);
      const facts = staffSnapshotFacts(snapshot)!;
      return { kind: 'created', orderId: facts.orderId, clientId: facts.clientId, lineCount: facts.lineCount, backordered: facts.backordered, replayed: false };
    }
    const place: PlacePortalOrderCommand = {
      tenantId: surface.tenantId,
      clientId: portalClientId!,
      actorUserId: surface.actorUserId,
      warehouseId: surface.warehouseId,
      destination,
      ...fields,
      lines: order.lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity })),
    };
    if (derivedKey === null) {
      const checked = await this.orders.checkPortalOrder(place);
      return { kind: 'created', orderId: null, clientId: checked.clientId, lineCount: checked.lineCount, backordered: null, replayed: false };
    }
    const placed: PortalPlacedOrder = await this.orders.placePortalOrder(place, derivedKey);
    return { kind: 'created', orderId: placed.orderId, clientId: portalClientId!, lineCount: placed.lineCount, backordered: null, replayed: false };
  }

  /** A committed derived key's stored snapshot as a created outcome (A2), or null when it is not this surface's shape. */
  private settledOutcome(surface: Surface, snapshot: unknown): Outcome | null {
    if (surface.kind === 'staff') {
      const facts = staffSnapshotFacts(snapshot);
      return facts === null
        ? null
        : { kind: 'created', orderId: facts.orderId, clientId: facts.clientId, lineCount: facts.lineCount, backordered: facts.backordered, replayed: true };
    }
    const facts = portalSnapshotFacts(snapshot);
    return facts === null ? null : { kind: 'created', orderId: facts.orderId, clientId: '', lineCount: facts.lineCount, backordered: null, replayed: true };
  }

  /** The create's refusal as the order's row error, on its first row (A6). */
  private refusalOf(group: OrderImportGroup, problem: { code: string; detail: string }): OrderImportRowError {
    const rowNumber = group.rows[0]!.rowNumber;
    if (problem.code === 'idempotency-key-reuse') {
      return orderRowError(
        rowNumber,
        group.orderRef,
        'order-changed-since-first-run',
        `This order was created by an earlier run of this import, and its SKUs or client now resolve differently — find it by order number ${group.orderRef}.`,
      );
    }
    if (PASSED_THROUGH.has(problem.code)) {
      return orderRowError(rowNumber, group.orderRef, problem.code as OrderImportRowErrorCode, problem.detail);
    }
    return orderRowError(rowNumber, group.orderRef, 'order-refused', `${problem.code}: ${problem.detail}`);
  }

  /** The staff response names each created order's client (a settled one's client may be new to the run). */
  private async ensureLabels(tx: TenantTx, surface: Surface, planned: Planned): Promise<void> {
    if (surface.kind !== 'staff') return;
    const missing = [
      ...new Set(
        planned.outcomes.flatMap((outcome) =>
          outcome.kind === 'created' && !planned.labels.has(outcome.clientId)
            ? [outcome.clientId]
            : outcome.kind === 'ready' && !planned.labels.has(outcome.order.clientId)
              ? [outcome.order.clientId]
              : [],
        ),
      ),
    ];
    if (missing.length === 0) return;
    for (const [id, label] of await getClientLabelsInTx(tx, surface.tenantId, missing)) planned.labels.set(id, label);
  }

  private respond(
    surface: Surface,
    fileSha256: string,
    planned: Planned,
    refusals: ReadonlyMap<number, OrderImportRowError>,
    importId: string | null,
    complete: boolean,
  ): OrderImportResponse | PortalOrderImportResponse {
    const cellsOf = new Map(planned.sheet.map((row) => [row.rowNumber, row.values]));
    const cell = (rowNumber: number, column: string): string | null => {
      const value = (cellsOf.get(rowNumber)?.[column] ?? '').trim();
      return value === '' ? null : value;
    };
    const errors = [...planned.errors, ...refusals.values()]
      .map((error, index) => ({ error, index }))
      .sort((a, b) => a.error.rowNumber - b.error.rowNumber || a.index - b.index)
      // An order-level refusal sits on the order's first row but is not about
      // that row's line: its sku and quantity cells are not echoed.
      .map(({ error }) =>
        ORDER_LEVEL_CODES.has(error.code)
          ? { ...error, sku: null, quantity: null }
          : { ...error, sku: cell(error.rowNumber, 'sku'), quantity: cell(error.rowNumber, 'quantity') },
      );
    const orders: (OrderImportOrder | PortalOrderImportOrder)[] = [];
    planned.groups.forEach((group, index) => {
      const outcome = planned.outcomes[index]!;
      if (outcome.kind !== 'created') return;
      const base = {
        orderId: outcome.orderId,
        clientOrderRef: group.orderRef,
        lineCount: outcome.lineCount,
        firstRow: group.rows[0]!.rowNumber,
        replayed: outcome.replayed,
      };
      orders.push(
        surface.kind === 'staff'
          ? {
              ...base,
              clientId: outcome.clientId,
              clientLabel: planned.labels.get(outcome.clientId) ?? outcome.clientId,
              backorderedLineCount: outcome.backordered,
            }
          : base,
      );
    });
    const notAttemptedCount = planned.outcomes.filter((outcome) => outcome.kind === 'not-attempted').length;
    return {
      importId,
      dryRun: surface.dryRun,
      warehouseId: surface.warehouseId,
      fileSha256,
      rowCount: planned.sheet.length,
      orderCount: planned.groups.length,
      acceptedCount: orders.length,
      refusedCount: planned.groups.length - orders.length - notAttemptedCount,
      complete,
      notAttemptedCount,
      orders,
      errors,
    } as OrderImportResponse | PortalOrderImportResponse;
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Stored idempotency rows by key, in the caller's transaction (one bulk read). */
async function readKeysInTx(
  tx: TenantTx,
  tenantId: string,
  keys: readonly string[],
): Promise<Map<string, { payloadHash: string; responseSnapshot: unknown }>> {
  if (keys.length === 0) return new Map();
  const rows = await tx
    .select({ key: idempotencyKeys.key, payloadHash: idempotencyKeys.payloadHash, responseSnapshot: idempotencyKeys.responseSnapshot })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, tenantId), inArray(idempotencyKeys.key, [...new Set(keys)])));
  return new Map(rows.map((row) => [row.key, { payloadHash: row.payloadHash, responseSnapshot: row.responseSnapshot }]));
}
