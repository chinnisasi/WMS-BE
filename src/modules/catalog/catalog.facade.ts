import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import { batches, catalogImports, serials, skus } from '../../shared/db/schema';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { uuidv7 } from '../../shared/primitives/ids';
import type { ImportMode } from './import.command';

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
}

/** Batch identity (catalog-owned) — location/quantity live in inventory (AD-6). */
export interface BatchIdentity {
  readonly id: string;
  readonly code: string;
  readonly mfgDate: string | null;
  readonly expiryDate: string | null;
  readonly status: string;
}

/** Serial identity (catalog-owned) — location/history are ledger-derived (AD-6). */
export interface SerialIdentity {
  readonly id: string;
  readonly serialNumber: string;
  readonly status: string;
}

/** One batch intake input to `ensureBatches` (dates are UTC-validated instants). */
export interface EnsureBatchInput {
  readonly code: string;
  readonly mfgDate?: string | undefined;
  readonly expiryDate?: string | undefined;
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

  /** The one SKU identity read (null when the id is foreign or unknown). */
  async findSku(tenantId: string, skuId: string): Promise<CatalogSkuIdentity | null> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: skus.id,
          code: skus.code,
          batchTracked: skus.batchTracked,
          serialTracked: skus.serialTracked,
        })
        .from(skus)
        .where(and(eq(skus.tenantId, tenantId), eq(skus.id, skuId)))
        .limit(1);
      return rows[0] ?? null;
    });
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
   */
  async ensureBatches(
    tenantId: string,
    skuId: string,
    inputs: readonly EnsureBatchInput[],
  ): Promise<BatchIdentity[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
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
    });
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