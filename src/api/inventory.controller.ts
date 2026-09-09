import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import type { TenantSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { assertPermission } from '../modules/tenancy/permissions';
import { TenancyService } from '../modules/tenancy/tenancy.service';
import { assertUtcIso } from '../shared/primitives/time';
import { CatalogFacade } from '../modules/catalog/catalog.facade';
import { InventoryFacade } from '../modules/inventory/inventory.facade';
import type {
  BatchOnHandEntry,
  LedgerTimelineQuery,
} from '../modules/inventory/inventory.facade';
import type { AdjustStockBatch } from '../modules/inventory/inventory.command';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  LedgerEventListResponse,
  LedgerEventsQuery,
  StockAdjustmentDto,
  StockAdjustmentResponse,
} from '../modules/inventory/inventory.dto';

const IDEMPOTENCY_HEADER = [
  {
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated ULID key; replays return the original response',
    // ULID: 26 chars, Crockford base32.
    schema: { type: 'string', minLength: 26, maxLength: 26, pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  },
];

/**
 * The inventory HTTP surface (Story 2.1): the manual `stock.adjustment`
 * command and the event-timeline read — the api shell is the only HTTP
 * surface of the monolith. Every stock mutation goes through
 * `InventoryFacade`; the ledger core is not HTTP-exposed beyond these two
 * routes (replay/verify/anchor are consumed by Story 2.2, not HTTP).
 */
@ApiTags('inventory')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class InventoryController {
  constructor(
    @Inject(InventoryFacade) private readonly inventoryFacade: InventoryFacade,
    // Story 2.4's api-layer composition (AD-6): batch/serial identity ensure
    // through the catalog facade, FEFO resolution as the cross-facade join,
    // and the capability assert that must precede any identity creation.
    @Inject(CatalogFacade) private readonly catalogFacade: CatalogFacade,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
  ) {}

  @Post(':tenantId/inventory/adjustments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Records a manual stock adjustment (one ledger event + on-hand projection in one commit)',
  })
  @ApiBody({ type: StockAdjustmentDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: StockAdjustmentResponse,
    description: 'Adjustment committed: the ledger event snapshot plus the resulting on-hand quantity',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or invalid body (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks stock.adjust (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, bin, or SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Concurrent request on the same Idempotency-Key (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse), or the movement would drive on-hand below zero (insufficient-on-hand names the bin and current on-hand)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async adjustStock(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: StockAdjustmentDto,
  ): Promise<StockAdjustmentResponse> {
    assertOwnTenant(session, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    // Pure normalization first (review loop 1): null arms behave as absent,
    // serials are trimmed, an empty array is absent — the normalized values
    // feed BOTH identity creation and the idempotency fingerprint.
    const arms = normalizeArms(dto);
    const command = {
      tenantId,
      actorUserId: session.userId,
      warehouseId: dto.warehouseId,
      skuId: dto.skuId,
      binId: dto.binId,
      quantityDelta: dto.quantityDelta,
      reasonCode: dto.reasonCode,
      note: dto.note,
      occurredAt: dto.occurredAt,
      batch: arms.batch,
      serials: arms.serials,
    };
    // The SKU's tracking flags decide whether this request touches the 2.4
    // surface at all (a FEFO default draw carries NO fields, yet is armed).
    const sku = await this.catalogFacade.findSku(tenantId, dto.skuId);
    const touchesArms =
      arms.batch !== undefined ||
      arms.serials !== undefined ||
      (sku !== null && (sku.batchTracked || sku.serialTracked));
    if (touchesArms) {
      // Permission before EVERYTHING on the 2.4 surface (review loop 1): the
      // capability assert precedes any validation 400, any identity creation,
      // AND the replay pre-check (a demoted actor gets 403, never the
      // snapshot — the command's own carve-out parity, one level up).
      assertPermission(
        await this.tenancy.getMemberRole(tenantId, session.userId),
        'stock.adjust',
      );
      // Replay precedes composition (review loop 1): the stored snapshot is
      // the answer for a retry — even when the FEFO batch has since been
      // exhausted or the bin's batch state changed. The payload hash is
      // command-owned (via the facade) and hashes the RAW request arms, so
      // no current-state input can poison the replay decision.
      const replayed = await this.inventoryFacade.replayAdjustment(
        tenantId,
        key,
        this.inventoryFacade.adjustmentFingerprint(command),
      );
      if (replayed !== null) {
        return replayed;
      }
    }
    const { batchRef, serialRefs } = await this.composeBatchSerialArms(tenantId, dto, arms, sku);
    return this.inventoryFacade.adjustStock(
      {
        ...command,
        batchRef,
        serialRefs,
      },
      key,
    );
  }

  /**
   * The Story 2.4 api-layer composition (AD-6): the ONLY place catalog
   * identity and inventory stock state join. Runs ONLY on the non-replay
   * path of a request that touches the arms (the replay pre-check above has
   * already returned any stored snapshot). It validates the tracked-SKU
   * requirements, ensures identity idempotently, and resolves the movement's
   * batchRef — explicit (override, reason required) or the FEFO default
   * (oldest non-expired batch with stock in the bin, expiry ASC nulls-last —
   * CHECKPOINT 1). Serial ids resolve order-preserving through
   * `ensureSerials`; the ledger then enforces uniqueness-in-a-bin at write
   * time. (The `stock.adjust` capability has already been asserted by the
   * caller before this composition runs.)
   */
  private async composeBatchSerialArms(
    tenantId: string,
    dto: StockAdjustmentDto,
    arms: { batch: AdjustStockBatch | undefined; serials: string[] | undefined },
    sku: { batchTracked: boolean; serialTracked: boolean } | null,
  ): Promise<{ batchRef: string | null; serialRefs: string[] | undefined }> {
    const batch = arms.batch;
    const serials = arms.serials;
    const hasBatch = batch !== undefined;
    const hasSerials = serials !== undefined;
    if (!hasBatch && !hasSerials) {
      // The flagless passthrough stays byte-identical — but only when the SKU
      // actually tracks neither arm (a read; no identity rows are touched).
      // A tracked SKU without its arm falls through to the 400s below.
      if (sku === null || (!sku.batchTracked && !sku.serialTracked)) {
        return { batchRef: null, serialRefs: undefined };
      }
    } else if (sku === null) {
      // An unknown SKU with the new fields is 404 here (with no fields the
      // command's own assert keeps the passthrough byte-identical).
      throw new ProblemException(
        'not-found',
        404,
        'SKU not found',
        'No SKU with this id exists in this tenant.',
      );
    }

    let batchRef: string | null = null;
    let serialRefs: string[] | undefined;

    if (hasBatch) {
      if (!sku!.batchTracked) {
        throw untrackedSku('batch', 'batch');
      }
      // Dates are optional but must be well-formed UTC instants — 400
      // otherwise. Validation only (no transform): the fingerprint hashed
      // the raw instants and the command re-hashes the same values.
      void assertBatchInstant(batch!.mfgDate, 'mfgDate');
      void assertBatchInstant(batch!.expiryDate, 'expiryDate');
      // An expiry before manufacturing is a data-entry error that would
      // otherwise jump the FEFO queue forever (earliest expiry draws first).
      if (
        batch!.mfgDate !== undefined &&
        batch!.expiryDate !== undefined &&
        Date.parse(batch!.expiryDate) < Date.parse(batch!.mfgDate)
      ) {
        throw new ProblemException(
          'validation-failed',
          400,
          'batch.expiryDate precedes mfgDate',
          `batch.expiryDate (${batch!.expiryDate}) must not precede batch.mfgDate (${batch!.mfgDate}).`,
        );
      }
    }
    if (hasSerials && !sku!.serialTracked) {
      throw untrackedSku('serials', 'serial');
    }

    if (hasSerials) {
      // Duplicates within one request are a client error — a retried scan
      // line, not a multi-unit movement (400 before any identity ensure).
      if (new Set(serials!).size !== serials!.length) {
        throw new ProblemException(
          'validation-failed',
          400,
          'serials contains duplicates',
          'A serial-tracked movement writes one ledger event per serial unit — the same serial cannot appear twice in one request.',
        );
      }
      if (Math.abs(dto.quantityDelta) !== serials!.length) {
        throw new ProblemException(
          'validation-failed',
          400,
          'quantityDelta must match the serial count',
          `A serial-tracked movement writes one ledger event per serial unit — ${serials!.length} serials cannot move ${dto.quantityDelta} units.`,
        );
      }
      const ensured = await this.catalogFacade.ensureSerials(tenantId, dto.skuId, serials!);
      serialRefs = ensured.map((serial) => serial.id);
    }

    if (hasBatch) {
      if (dto.quantityDelta > 0) {
        // The override reason is the override-draw's audit field only — an
        // intake carries no FEFO decision to record (400, not a silent doc).
        if (batch!.overrideReason !== undefined) {
          throw new ProblemException(
            'validation-failed',
            400,
            'overrideReason applies only to an override draw',
            'batch.overrideReason records why a draw overrode the FEFO default — a positive intake names its batch outright and must omit it.',
          );
        }
        // Intake: identity is ensured idempotently (code unique per
        // tenant+sku; a retry with the same code returns the SAME batch).
        const [ensured] = await this.catalogFacade.ensureBatches(tenantId, dto.skuId, [
          { code: batch!.code, mfgDate: batch!.mfgDate, expiryDate: batch!.expiryDate },
        ]);
        batchRef = ensured!.id;
      } else {
        // Explicit draw = FEFO override: the reason is required and recorded
        // in the ledger reference doc (the hash chain is the audit log).
        if (batch!.overrideReason === undefined) {
          throw new ProblemException(
            'validation-failed',
            400,
            'overrideReason is required to override the FEFO default batch',
            'Drawing an explicit batch instead of the FEFO default must record a reason — supply batch.overrideReason.',
          );
        }
        const found = (await this.catalogFacade.getBatches(tenantId, dto.skuId)).find(
          (candidate) => candidate.code === batch!.code,
        );
        if (found === undefined) {
          throw new ProblemException(
            'not-found',
            404,
            'Batch not found',
            `No batch with code "${batch!.code}" exists for this SKU.`,
          );
        }
        batchRef = found.id;
        await this.assertBatchCoversDraw(tenantId, dto, found.id, batch!.code);
      }
    } else if (sku!.batchTracked && dto.quantityDelta < 0) {
      // FEFO default draw (CHECKPOINT 1): oldest non-expired batch with
      // stock in the bin, expiry ASC nulls-last — expired batches are never
      // default-drawn. (A retry of a succeeded default draw never reaches
      // this resolution — the replay pre-check returned the snapshot.)
      batchRef = await this.resolveFefoBatch(tenantId, dto);
    } else if (sku!.batchTracked) {
      // Batch-tracked intake without the batch arm: identity cannot be
      // ensured and the ledger's batch fold cannot key — reject.
      throw new ProblemException(
        'validation-failed',
        400,
        'batch is required for a batch-tracked intake',
        'A positive movement of a batch-tracked SKU must name its batch — supply batch { code, mfgDate?, expiryDate? }.',
      );
    }
    if (!hasSerials && sku!.serialTracked) {
      throw new ProblemException(
        'validation-failed',
        400,
        'serials are required for a serial-tracked movement',
        'A serial-tracked movement writes one ledger event per serial unit — supply serials: [s1..sN] with quantityDelta = N.',
      );
    }

    return { batchRef, serialRefs };
  }

  /**
   * The explicit-batch draw pre-check: the batch's bin quantity must cover
   * the movement (422 naming the batch CODE — the ledger's own fold guard is
   * the race backstop and names the batchRef).
   */
  private async assertBatchCoversDraw(
    tenantId: string,
    dto: StockAdjustmentDto,
    batchId: string,
    batchCode: string,
  ): Promise<void> {
    const rows = await this.inventoryFacade.batchOnHand(tenantId, dto.warehouseId, {
      skuId: dto.skuId,
      binId: dto.binId,
    });
    const held = rows.find((row) => row.batchId === batchId)?.quantity ?? 0;
    if (held < Math.abs(dto.quantityDelta)) {
      throw new ProblemException(
        'insufficient-on-hand',
        422,
        'Adjustment would drive the batch on-hand below zero',
        `Batch "${batchCode}" currently holds ${held} in this bin; this movement of ${dto.quantityDelta} would take it below zero.`,
      );
    }
  }

  /** The FEFO resolution (CHECKPOINT 1): the catalog expiry × inventory on-hand join. */
  private async resolveFefoBatch(tenantId: string, dto: StockAdjustmentDto): Promise<string> {
    const [onHand, batches] = await Promise.all([
      this.inventoryFacade.batchOnHand(tenantId, dto.warehouseId, {
        skuId: dto.skuId,
        binId: dto.binId,
      }),
      this.catalogFacade.getBatches(tenantId, dto.skuId),
    ]);
    const byId = new Map(batches.map((batch) => [batch.id, batch]));
    const now = Date.now();
    const candidates: { batchId: string; expiry: string | null }[] = onHand
      .filter((row: BatchOnHandEntry) => row.quantity > 0 && byId.has(row.batchId))
      .map((row) => ({ batchId: row.batchId, expiry: byId.get(row.batchId)!.expiryDate }))
      // Expired batches are never default-drawn (null expiry never expires).
      .filter((candidate) => candidate.expiry === null || Date.parse(candidate.expiry) >= now)
      // FEFO: expiry ASC, nulls LAST (a batch without expiry is drawn last).
      .sort((a, b) => {
        if (a.expiry === null) return b.expiry === null ? 0 : 1;
        if (b.expiry === null) return -1;
        return a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0;
      });
    if (candidates.length === 0) {
      throw new ProblemException(
        'insufficient-on-hand',
        422,
        'No batch to draw',
        `Bin "${dto.binId}" holds no non-expired batch stock of this SKU — name a batch explicitly (with an override reason) to draw.`,
      );
    }
    return candidates[0]!.batchId;
  }

  @Get(':tenantId/warehouses/:warehouseId/inventory/events')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Lists one warehouse's ledger event timeline (keyset cursor pagination, newest first)",
  })
  @ApiOkResponse({
    type: LedgerEventListResponse,
    description: "The warehouse's ledger event-timeline page (newest first, keyset cursor)",
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed skuId query, cursor, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'warehouseId', format: 'uuid' })
  async listEvents(
    @Param('tenantId') tenantId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: LedgerEventsQuery,
  ): Promise<LedgerEventListResponse> {
    assertOwnTenant(session, tenantId);
    const timelineQuery: LedgerTimelineQuery = {
      skuId: query.skuId,
      cursor: query.cursor,
      limit: query.limit,
    };
    const page = await this.inventoryFacade.listEvents(tenantId, warehouseId, timelineQuery);
    return { items: page.items, nextCursor: page.nextCursor };
  }
}

function assertOwnTenant(session: TenantSession, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The session token tenant does not own this path.',
    );
  }
}

/**
 * Pure arm normalization (review loop 1 — runs BEFORE the permission assert,
 * the fingerprint, and any identity work; throws nothing): a null batch or
 * serials behaves as absent (never a 500 on a tracked SKU, never a different
 * fingerprint than an omitted field); serial elements are trimmed (the DTO
 * trims too — idempotent) and an empty array is absent. The NORMALIZED arms
 * feed both `ensureSerials`/`ensureBatches` and the idempotency fingerprint —
 * the command hashes exactly what this returns (date validation happens
 * later, in the composition, without transforming the values, so the
 * fingerprint over the raw instants is stable across retries).
 */
function normalizeArms(dto: StockAdjustmentDto): {
  batch: AdjustStockBatch | undefined;
  serials: string[] | undefined;
} {
  const rawBatch = dto.batch ?? undefined;
  const batch =
    rawBatch === undefined
      ? undefined
      : {
          code: rawBatch.code,
          mfgDate: rawBatch.mfgDate,
          expiryDate: rawBatch.expiryDate,
          overrideReason: rawBatch.overrideReason,
        };
  const trimmed = (dto.serials ?? []).map((serial) => serial.trim());
  return { batch, serials: trimmed.length > 0 ? trimmed : undefined };
}

/** A batch/serial arm on a SKU that does not track it — 400 (the I/O matrix). */
function untrackedSku(field: 'batch' | 'serials', arm: 'batch' | 'serial'): ProblemException {
  return new ProblemException(
    'validation-failed',
    400,
    `SKU is not ${arm}-tracked`,
    `The "${field}" arm applies only to ${arm}-tracked SKUs — this SKU's tracking flags are false.`,
  );
}

/** Batch dates are optional but must be well-formed UTC instants — 400 otherwise. */
function assertBatchInstant(value: string | undefined, field: 'mfgDate' | 'expiryDate'): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return assertUtcIso(value);
  } catch {
    throw new ProblemException(
      'validation-failed',
      400,
      `batch.${field} must be a valid ISO-8601 UTC instant`,
      `batch.${field} must be a Z-suffixed ISO-8601 UTC timestamp (got "${value}").`,
    );
  }
}