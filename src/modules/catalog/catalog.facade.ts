import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import { batches, catalogImports, products, serials, skus } from '../../shared/db/schema';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { uuidv7 } from '../../shared/primitives/ids';
// Story 12-7 — the segregation matrix is code in the shared primitive, not
// a table this module owns; the facade read enumerates it (see the method).
import {
  enumerateIncompatiblePairs,
  HAZARD_CLASSES,
} from '../../shared/primitives/hazard';
import type { HazardClass, SegregationPair } from '../../shared/primitives/hazard';
import type { ImportMode } from './import.command';
import { uomPrecision } from './uom';
// The handling-unit seam lives in its own file (see the block inside the
// class): these are re-exported so a consumer that already holds the facade
// imports one module, not two.
import {
  createHandlingUnitsInTx,
  lockHandlingUnitsInTx,
  markHandlingUnitsAdjustedInTx,
  markHandlingUnitsPackedInTx,
  settleHandlingUnitIntakeInTx,
} from './handling-unit.store';
import { getKitCompositionInTx, getKitSkuIdsInTx } from './kit.store';
import type { KitCompositionLine } from './kit.store';
import type {
  CreateHandlingUnitInput,
  HandlingUnitIdentity,
  HandlingUnitPackAssignment,
} from './handling-unit.store';

export type {
  CreateHandlingUnitInput,
  HandlingUnitIdentity,
  HandlingUnitPackAssignment,
} from './handling-unit.store';

/** What other modules get from the catalog module (module boundary — AD-6). */
export interface CatalogImportSummary {
  readonly skuCount: number;
  readonly lastImport: {
    readonly id: string;
    readonly mode: ImportMode;
    readonly committedRows: number;
    readonly failedRows: number;
    readonly skippedRows: number;
    readonly createdAt: string;
  } | null;
}

/** The SKU identity + tracking flags other modules compose against (Story 2.4). */
export interface CatalogSkuIdentity {
  readonly id: string;
  readonly code: string;
  readonly batchTracked: boolean;
  readonly serialTracked: boolean;
  /** Story 10.3 — handled by unit, priced by weight (`handling_units`). */
  readonly catchWeightTracked: boolean;
}

/** Batch identity (catalog-owned) — location/quantity live in inventory (AD-6). */
export interface BatchIdentity {
  readonly id: string;
  readonly code: string;
  readonly mfgDate: string | null;
  readonly expiryDate: string | null;
  readonly status: string;
}

/**
 * The scan-side batch intake facts (Story 6.2): identity + lifecycle + the
 * anchoring instants — `expiryDate` for the expiry arm, `createdAt` for the
 * aging arm. No `mfgDate` (the scan evaluates neither).
 */
export interface BatchIntake {
  readonly id: string;
  readonly code: string;
  readonly expiryDate: string | null;
  readonly status: string;
  readonly createdAt: string;
}

/** Serial identity (catalog-owned) — location/history are ledger-derived (AD-6). */
export interface SerialIdentity {
  readonly id: string;
  readonly serialNumber: string;
  readonly status: string;
}

/** One composition row as the explosion consumes it (Story 11.4) — milli-units in. */
export type { KitCompositionLine } from './kit.store';

/** One batch intake input to `ensureBatches` (dates are UTC-validated instants). */
export interface EnsureBatchInput {
  readonly code: string;
  readonly mfgDate?: string | undefined;
  readonly expiryDate?: string | undefined;
}

/**
 * The reorder defaults one SKU carries (story 6.1) — the tenant-wide fallback
 * the replenishment module breathes through this facade.
 */
export interface SkuReorderDefaults {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly uom: string;
  /** Milli-units (AD-9 / 10.1) — 0 means "no tenant-wide default". */
  readonly reorderPoint: number;
  readonly reorderQty: number;
}

/** The hazard segregation matrix as the story 12-7 admin read carries it. */
export interface CatalogSegregationMatrix {
  readonly classes: readonly HazardClass[];
  readonly incompatible: readonly SegregationPair[];
}

/**
 * Catalog facade for the tenancy spine's setup checklist (Story 1.4): the
 * only cross-module surface — catalog tables stay module-exclusive. The
 * summary is read in one tenant-scoped transaction: the SKU count decides the
 * checklist's catalog step, the latest run's counts make the detail honest
 * ("last import X committed, Y failed").
 *
 * Story 2.4: batch/serial IDENTITY joins the surface — `ensureBatches` /
 * `ensureSerials` create missing identity rows idempotently (per
 * tenant+sku+code/serial-number) so the api layer can compose an adjustment:
 * ensure identity here, then hand the resolved ids to the inventory facade
 * (which owns location/quantity/uniqueness-in-a-bin — never this module).
 *
 * Story 2.5: the detail routes' catalog 404 checks — tiny `findBatch` /
 * `findSerial` existence reads (null when the id is unknown or foreign),
 * checked at the api layer before any detail query (CHECKPOINT 1).
 */
/** One SKU as the device catalog snapshot carries it (the scan identity). */
export interface SkuSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly barcode: string;
  readonly uom: string;
  /**
   * Story 10.2: the decimal places `uom` declares. It rides the snapshot so
   * the DEVICE can refuse a too-precise entry inside its own Rejected banner,
   * offline, before the scan is ever queued — a refusal that only the server
   * knew about would queue in a dead zone and come back hours later as a
   * rejection the operator can no longer act on.
   *
   * Derived in process from the vocabulary, never read from a table: there is
   * no per-SKU precision, and a nested pool-opening read here is the exact
   * shape that deadlocked this endpoint once already.
   */
  readonly uomPrecision: number;
  readonly batchTracked: boolean;
  readonly serialTracked: boolean;
  /**
   * Story 10.3: the SKU is handled by unit and priced by weight. It rides the
   * snapshot for the same reason `uomPrecision` does — the device has to
   * PROMPT for a per-unit weight at receipt while offline, and a prompt that
   * only the server knows about never happens on the floor.
   */
  readonly catchWeightTracked: boolean;
  /**
   * Story 11.7: the SKU's values on its product's declared variant axes
   * (`size: M, colour: Red`), null when the SKU is unattached. It rides the
   * snapshot so the device can SAY which variant a scan holds at pick time,
   * offline — picking the wrong size is the dominant apparel error (UX-DR28),
   * and a label that only the server could compose never reaches the floor.
   */
  readonly variantValues: Record<string, string> | null;
  /**
   * Story 11.7: the attached product's declared axes, in DECLARATION order —
   * the order a variant label is read in. Null when the SKU is unattached
   * (left join on `products`).
   */
  readonly axes: string[] | null;
  /**
   * Story 12.8 (UX-DR29): the SKU's storage class — the other half of the
   * device's offline conformance mirror. It rides the snapshot beside the
   * bin arm's class so the device can refuse a non-conforming placement or
   * draw in its own Rejected banner, offline, in under 500 ms; a refusal
   * only the server knew about queues in a dead zone and comes back hours
   * later as a rejection the operator can no longer act on. Never null on the
   * wire: the column defaults to `ambient` (0035_storage_class.sql), so every
   * SKU reads a class.
   */
  readonly storageClass: string;
}

@Injectable()
export class CatalogFacade {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getImportSummary(tenantId: string): Promise<CatalogImportSummary> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const skuRows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(skus)
        .where(eq(skus.tenantId, tenantId));
      const lastRows = await tx
        .select({
          id: catalogImports.id,
          mode: catalogImports.mode,
          committedRows: catalogImports.committedRows,
          failedRows: catalogImports.failedRows,
          skippedRows: catalogImports.skippedRows,
          createdAt: catalogImports.createdAt,
        })
        .from(catalogImports)
        .where(eq(catalogImports.tenantId, tenantId))
        .orderBy(desc(catalogImports.createdAt), desc(catalogImports.id))
        .limit(1);
      const last = lastRows[0];
      return {
        skuCount: skuRows[0]?.n ?? 0,
        lastImport: last
          ? {
              id: last.id,
              mode: last.mode as ImportMode,
              committedRows: last.committedRows,
              failedRows: last.failedRows,
              skippedRows: last.skippedRows,
              createdAt: last.createdAt,
            }
          : null,
      };
    });
  }

  /**
   * Story 12-7 — the segregation-matrix read: the hazard vocabulary plus the
   * FULLY EXPANDED incompatible unordered-pair set, enumerated from the
   * shared predicate (`enumerateIncompatiblePairs` in hazard.ts — the
   * explosive universal rule included, `explosive|explosive` with it) so the
   * web renders the server's truth instead of a drift-prone hand copy. A
   * pure read of code — no table, no transaction, the one facade method
   * without one; path ownership stays the controller's `assertOwnTenant`,
   * exactly as for every other GET here.
   */
  getSegregationMatrix(): CatalogSegregationMatrix {
    return {
      classes: [...HAZARD_CLASSES],
      incompatible: enumerateIncompatiblePairs().map((pair) => ({ ...pair })),
    };
  }

  /**
   * Story 6.1 — the tenant's SKUs with their reorder defaults (milli-units),
   * inside the CALLER's transaction (the `getBatchesForSkusInTx` shape): the
   * replenishment sweep composes these beside its own policy rows in ONE
   * transaction, so the effective points it commits are the catalog it saw.
   * Every tenant SKU is returned (also the 0/0 ones — the replenishment
   * module decides what a zero point means and the read doubles as the
   * SKU-in-tenant existence assert for the policy commands); the code + name
   * ride along for the draft/log surfaces. A read — never capability-gated.
   */
  async getSkuReorderDefaultsInTx(
    tx: TenantTx,
    tenantId: string,
  ): Promise<SkuReorderDefaults[]> {
    return tx
      .select({
        id: skus.id,
        code: skus.code,
        name: skus.name,
        uom: skus.uom,
        reorderPoint: skus.reorderPoint,
        reorderQty: skus.reorderQty,
      })
      .from(skus)
      .where(eq(skus.tenantId, tenantId))
      .orderBy(skus.code);
  }

  /**
   * The same read on its own transaction (the `getSkuSummaries` wrapper
   * shape) — the standalone entry for a caller that holds no transaction.
   */
  async getSkuReorderDefaults(tenantId: string): Promise<SkuReorderDefaults[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getSkuReorderDefaultsInTx(tx, tenantId),
    );
  }

  /** The one SKU identity read (null when the id is foreign or unknown). */
  async findSku(tenantId: string, skuId: string): Promise<CatalogSkuIdentity | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: skus.id,
          code: skus.code,
          batchTracked: skus.batchTracked,
          serialTracked: skus.serialTracked,
          catchWeightTracked: skus.catchWeightTracked,
        })
        .from(skus)
        .where(and(eq(skus.tenantId, tenantId), eq(skus.id, skuId)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  /**
   * The full SKU scan surface (Story 3.3, device catalog snapshot): every
   * SKU's scan identity — code, barcode, UoM, tracking flags. Barcode is
   * never null in the catalog (import defaults it to the code), so the
   * snapshot carries it as a plain string.
   */
  async getSkuSummaries(tenantId: string): Promise<SkuSummary[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.getSkuSummariesInTx(tx, tenantId),
    );
  }

  /**
   * The same read inside the CALLER's transaction (story 4.3) — the device
   * catalog snapshot's in-tx passthrough, the `reservationsByIdsInTx` shape.
   *
   * The snapshot composes SKUs, bins, putaway tasks and pick tasks, and it
   * must do so on ONE connection: a nested transaction reserves a SECOND
   * pooled connection while the outer one is held, and postgres.js queues
   * connection requests with no timeout, so concurrent snapshots can exhaust
   * the pool and wait on each other forever. The other three reads were moved
   * onto the caller's transaction already; this was the last one left.
   */
  async getSkuSummariesInTx(tx: TenantTx, tenantId: string): Promise<SkuSummary[]> {
    const rows = await tx
      .select({
        id: skus.id,
        code: skus.code,
        name: skus.name,
        barcode: skus.barcode,
        uom: skus.uom,
        batchTracked: skus.batchTracked,
        serialTracked: skus.serialTracked,
        catchWeightTracked: skus.catchWeightTracked,
        // Story 11.7: the variant identity rides the scan surface. The values
        // are already a `skus` column; the axes are the ATTACHED PRODUCT's, so
        // a left join — an unattached SKU carries null on both.
        variantValues: skus.variantValues,
        axes: products.axes,
        // Story 12.8 (UX-DR29): the class rides beside the variant identity —
        // the device's offline conformance mirror reads both arms (SKU here,
        // bin on the putaway facade) beside the fields it already gates on.
        storageClass: skus.storageClass,
      })
      .from(skus)
      .leftJoin(products, eq(products.id, skus.productId))
      .where(eq(skus.tenantId, tenantId))
      .orderBy(skus.code);
    // Story 10.2: the unit's declared precision joins the scan identity. It is
    // a property of the UNIT, so it is looked up here rather than selected —
    // still on the caller's transaction, still one query.
    return rows.map((row) => ({ ...row, uomPrecision: uomPrecision(row.uom) }));
  }

  /** Batch identities of one SKU — the expiry half of the api layer's FEFO join. */
  async getBatches(tenantId: string, skuId: string): Promise<BatchIdentity[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: batches.id,
          code: batches.code,
          mfgDate: batches.mfgDate,
          expiryDate: batches.expiryDate,
          status: batches.status,
        })
        .from(batches)
        .where(and(eq(batches.tenantId, tenantId), eq(batches.skuId, skuId)))
        .orderBy(batches.code);
      return rows;
    });
  }

  /**
   * Batch identities of a SET of SKUs, inside the caller's transaction
   * (Story 4.2 — the wave planner's FEFO half). Catalog owns expiry and the
   * batch lifecycle flag; inventory owns location and quantity (AD-6), so a
   * pick suggestion joins the two. The in-tx shape mirrors the inventory
   * facade's `reservationsByIdsInTx`: one wave generation is ONE tenant
   * transaction, so the plan it commits is the catalog it saw.
   */
  async getBatchesForSkusInTx(
    tx: TenantTx,
    tenantId: string,
    skuIds: readonly string[],
  ): Promise<ReadonlyArray<BatchIdentity & { readonly skuId: string }>> {
    if (skuIds.length === 0) {
      return [];
    }
    return tx
      .select({
        id: batches.id,
        skuId: batches.skuId,
        code: batches.code,
        mfgDate: batches.mfgDate,
        expiryDate: batches.expiryDate,
        status: batches.status,
      })
      .from(batches)
      .where(and(eq(batches.tenantId, tenantId), inArray(batches.skuId, [...new Set(skuIds)])));
  }

  /**
   * Story 6.2 — the expiry scan's identity read: the INTAKE facts of a set of
   * SKUs' batches, inside the caller's transaction (the
   * `getBatchesForSkusInTx` shape). Beyond the identity columns this carries
   * `createdAt` — the batch's receipt instant, the AGING definition's anchor
   * (ratified for 6.2: `age_days = floor((now − created_at) / 86400s)`,
   * frozen at detection). The expiry evaluation reads `expiryDate` and the
   * lifecycle flag `status` from the same rows — the scan never joins
   * `batches` from an inventory-side table (AD-6).
   */
  async getBatchIntakesForSkusInTx(
    tx: TenantTx,
    tenantId: string,
    skuIds: readonly string[],
  ): Promise<ReadonlyArray<BatchIntake & { readonly skuId: string }>> {
    if (skuIds.length === 0) {
      return [];
    }
    return tx
      .select({
        id: batches.id,
        skuId: batches.skuId,
        code: batches.code,
        expiryDate: batches.expiryDate,
        status: batches.status,
        createdAt: batches.createdAt,
      })
      .from(batches)
      .where(and(eq(batches.tenantId, tenantId), inArray(batches.skuId, [...new Set(skuIds)])));
  }

  /**
   * The storage classes of a SET of SKUs (Story 12-1, FR-40), inside the
   * caller's transaction — the wave planner's and the short-pick re-plan's
   * conformance filter (`buildStockPool`), the `getBatchesForSkusInTx` shape:
   * one plan is ONE tenant transaction, so the plan it commits is the catalog
   * it saw. The wave/replan POOL filter reaches the class through this seam
   * (AD-6); a SKU id the catalog does not know is simply absent from the map,
   * which the pool filter treats as unprovable — fail-closed. The pick DRAW,
   * by contrast, reads `skus.storageClass` directly in its own projection
   * (the pre-existing outbound direct-read pattern, `pick.command.ts:671`).
   */
  async getSkuStorageClassesInTx(
    tx: TenantTx,
    tenantId: string,
    skuIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (skuIds.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select({ id: skus.id, storageClass: skus.storageClass })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, [...new Set(skuIds)])));
    return new Map(rows.map((row) => [row.id, row.storageClass]));
  }

  /**
   * The CURRENT catalog HSN of a set of SKU codes (story 8-2a), inside the
   * caller's transaction — the HSN summary's hint beside an issued line whose
   * frozen HSN is blank or malformed. A hint only: an issued invoice is never
   * rewritten from it. A code the catalog does not know is absent from the
   * map (codes are immutable and SKUs are never deleted, so in practice
   * every snapshot code resolves).
   */
  async getSkuHsnByCodesInTx(
    tx: TenantTx,
    tenantId: string,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>> {
    if (codes.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select({ code: skus.code, hsn: skus.hsn })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.code, [...new Set(codes)])));
    return new Map(rows.map((row) => [row.code, row.hsn]));
  }

  /**
   * The one batch existence read (Story 2.5): null when the id is unknown or
   * foreign — the batch detail route's catalog 404 check, before any
   * inventory read. The `skuId` rides along (a batch's SKU identity).
   */
  async findBatch(
    tenantId: string,
    batchId: string,
  ): Promise<(BatchIdentity & { readonly skuId: string }) | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: batches.id,
          skuId: batches.skuId,
          code: batches.code,
          mfgDate: batches.mfgDate,
          expiryDate: batches.expiryDate,
          status: batches.status,
        })
        .from(batches)
        .where(and(eq(batches.tenantId, tenantId), eq(batches.id, batchId)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  /**
   * The one serial existence read (Story 2.5): null when the id is unknown
   * or foreign — the serial detail route's catalog 404 check, before any
   * ledger read. The `skuId` rides along (a serial's SKU identity).
   */
  async findSerial(
    tenantId: string,
    serialId: string,
  ): Promise<(SerialIdentity & { readonly skuId: string }) | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: serials.id,
          skuId: serials.skuId,
          serialNumber: serials.serialNumber,
          status: serials.status,
        })
        .from(serials)
        .where(and(eq(serials.tenantId, tenantId), eq(serials.id, serialId)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  /**
   * Idempotent batch-identity creation (AD-6): every requested code ends up
   * existing for (tenant, sku) — existing rows are returned untouched, with
   * their ORIGINAL mfg/expiry (a retry with different dates never rewrites
   * identity). Fails closed: 404 unknown SKU, 400 non-batch-tracked SKU.
   * A batch+serial-tracked SKU may carry both arms — the two ensures compose.
   *
   * Story 3.3 splits the body into `ensureBatchesInTx` so a caller that
   * composes batch identity into a larger write (the GRN command: batch
   * identity + ledger event + relational state in ONE transaction) can run
   * the same ensure inside its own tenant transaction; this wrapper keeps
   * the standalone entry exactly as before.
   */
  async ensureBatches(
    tenantId: string,
    skuId: string,
    inputs: readonly EnsureBatchInput[],
  ): Promise<BatchIdentity[]> {
    return withTenantTransaction(this.db, tenantId, (tx) =>
      this.ensureBatchesInTx(tx, tenantId, skuId, inputs),
    );
  }

  /** The in-transaction body of `ensureBatches` (see above for the contract). */
  async ensureBatchesInTx(
    tx: TenantTx,
    tenantId: string,
    skuId: string,
    inputs: readonly EnsureBatchInput[],
  ): Promise<BatchIdentity[]> {
    await this.assertSkuTracked(tx, tenantId, skuId, 'batchTracked', 'batch');
    const codes = [...new Set(inputs.map((input) => input.code))];
    if (codes.length > 0) {
      await tx
        .insert(batches)
        .values(
          // Deduplicated: one insert tuple per distinct code (the first
          // occurrence's dates win — ensure is identity creation, not edit).
          codes.map((code) => {
            const input = inputs.find((candidate) => candidate.code === code)!;
            return {
              id: uuidv7(),
              tenantId,
              skuId,
              code,
              mfgDate: input.mfgDate ?? null,
              expiryDate: input.expiryDate ?? null,
            };
          }),
        )
        // The unique index is the race backstop; the re-select below is
        // the source of truth for what exists now.
        .onConflictDoNothing({
          target: [batches.tenantId, batches.skuId, batches.code],
        });
    }
    const rows =
      codes.length === 0
        ? []
        : await tx
            .select({
              id: batches.id,
              code: batches.code,
              mfgDate: batches.mfgDate,
              expiryDate: batches.expiryDate,
              status: batches.status,
            })
            .from(batches)
            .where(and(eq(batches.tenantId, tenantId), eq(batches.skuId, skuId), inArray(batches.code, codes)));
    // Aligned to the caller's input order (duplicates share their row).
    return inputs.map((input) => rows.find((row) => row.code === input.code)!);
  }

  /**
   * Idempotent serial-identity creation — the `ensureSerials` twin of
   * `ensureBatches` (404 unknown SKU, 400 non-serial-tracked SKU).
   */
  async ensureSerials(
    tenantId: string,
    skuId: string,
    serialNumbers: readonly string[],
  ): Promise<SerialIdentity[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await this.assertSkuTracked(tx, tenantId, skuId, 'serialTracked', 'serial');
      const numbers = [...new Set(serialNumbers)];
      if (numbers.length > 0) {
        await tx
          .insert(serials)
          .values(numbers.map((serialNumber) => ({ id: uuidv7(), tenantId, skuId, serialNumber })))
          .onConflictDoNothing({
            target: [serials.tenantId, serials.skuId, serials.serialNumber],
          });
      }
      const rows =
        numbers.length === 0
          ? []
          : await tx
              .select({
                id: serials.id,
                serialNumber: serials.serialNumber,
                status: serials.status,
              })
              .from(serials)
              .where(
                and(
                  eq(serials.tenantId, tenantId),
                  eq(serials.skuId, skuId),
                  inArray(serials.serialNumber, numbers),
                ),
              );
      return serialNumbers.map((serialNumber) => rows.find((row) => row.serialNumber === serialNumber)!);
    });
  }

  // ── kits (Story 11.4 — the composition seam) ──────────────────────────────
  //
  // `kit_compositions` is catalog-owned (a kit IS a SKU: kit-ness is the
  // PRESENCE of composition rows, never a flag — AD-19). Outbound needs the
  // BOM to explode a kit line at acceptance; inbound and inventory need the
  // one-bit "is this SKU a kit" answer to refuse +stock onto it. The
  // implementation lives in `kit.store.ts` (a file-level in-tx seam) because
  // the inventory module cannot import `CatalogModule` — these methods are the
  // facade face of the same functions, for the siblings that already hold this
  // module (inbound, outbound). One implementation.

  /** See `getKitCompositionInTx` — the explosion's flat-BOM read. */
  async getKitCompositionInTx(
    tx: TenantTx,
    tenantId: string,
    kitSkuId: string,
  ): Promise<KitCompositionLine[]> {
    return getKitCompositionInTx(tx, tenantId, kitSkuId);
  }

  /** See `getKitSkuIdsInTx` — the batch "is a kit" answer the +stock guards take. */
  async getKitSkuIdsInTx(
    tx: TenantTx,
    tenantId: string,
    skuIds: readonly string[],
  ): Promise<string[]> {
    return getKitSkuIdsInTx(tx, tenantId, skuIds);
  }

  // ── handling units (Story 10.3 — the catch-weight write seam) ─────────────
  //
  // `handling_units` has exactly ONE writer, the way `serials` does. The
  // implementation lives in `handling-unit.store.ts` (a file-level in-tx seam,
  // the `ensureReceivingBinInTx` / `openQcHoldsForBinsInTx` pattern) because
  // the inventory module cannot import `CatalogModule` — catalog reaches
  // tenancy, tenancy reaches putaway, putaway reaches inventory, and that is a
  // module-EVALUATION cycle no `forwardRef` can unwind. These methods are the
  // facade face of the same functions, for the siblings that already hold this
  // module (inbound, outbound) and for the api shell. One implementation.
  //
  // Every one of them runs on the CALLER's transaction: a unit row commits with
  // the GRN that produced it and flips with the pack or adjustment that
  // consumed it.

  /** See `createHandlingUnitsInTx` — the only moment a weight is captured. */
  async createHandlingUnits(
    tx: TenantTx,
    tenantId: string,
    inputs: readonly CreateHandlingUnitInput[],
  ): Promise<HandlingUnitIdentity[]> {
    return createHandlingUnitsInTx(tx, tenantId, inputs);
  }

  /** See `settleHandlingUnitIntakeInTx` — `pending_approval → active | rejected`. */
  async settleHandlingUnitIntake(
    tx: TenantTx,
    tenantId: string,
    grnLineId: string,
    decision: 'approve' | 'reject',
  ): Promise<HandlingUnitIdentity[]> {
    return settleHandlingUnitIntakeInTx(tx, tenantId, grnLineId, decision);
  }

  /** See `markHandlingUnitsAdjustedInTx` — the write-off's `active → rejected`. */
  async markHandlingUnitsAdjusted(
    tx: TenantTx,
    tenantId: string,
    ids: readonly string[],
  ): Promise<HandlingUnitIdentity[]> {
    return markHandlingUnitsAdjustedInTx(tx, tenantId, ids);
  }

  /** See `markHandlingUnitsPackedInTx` — the set-once `active → packed`. */
  async markHandlingUnitsPacked(
    tx: TenantTx,
    tenantId: string,
    assignments: readonly HandlingUnitPackAssignment[],
  ): Promise<HandlingUnitIdentity[]> {
    return markHandlingUnitsPackedInTx(tx, tenantId, assignments);
  }

  /** See `lockHandlingUnitsInTx` — the guarded read every consuming path takes. */
  async lockHandlingUnits(
    tx: TenantTx,
    tenantId: string,
    ids: readonly string[],
  ): Promise<HandlingUnitIdentity[]> {
    return lockHandlingUnitsInTx(tx, tenantId, ids);
  }

  /** Fail-closed tracked-flag check inside the ensure transaction. */
  private async assertSkuTracked(
    tx: TenantTx,
    tenantId: string,
    skuId: string,
    flag: 'batchTracked' | 'serialTracked',
    arm: 'batch' | 'serial',
  ): Promise<void> {
    const rows = await tx
      .select({ id: skus.id, batchTracked: skus.batchTracked, serialTracked: skus.serialTracked })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), eq(skus.id, skuId)))
      .limit(1);
    const sku = rows[0];
    if (sku === undefined) {
      throw new ProblemException(
        'not-found',
        404,
        'SKU not found',
        'No SKU with this id exists in this tenant.',
      );
    }
    if (!sku[flag]) {
      throw new ProblemException(
        'validation-failed',
        400,
        `SKU is not ${arm}-tracked`,
        `Batch/serial arms open only for tracked SKUs — this SKU has ${flag} = false.`,
      );
    }
  }
}