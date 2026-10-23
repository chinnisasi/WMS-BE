import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiHeaders, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../shared/problem-details/problem-details.dto';
import { problemJsonResponse } from '../shared/problem-details/problem-details.openapi';
import { ProblemException } from '../shared/problem-details/problem.exception';
import { TenantSessionGuard, CurrentSession } from '../modules/tenancy/tenant-session.guard';
import { DeviceSessionGuard, CurrentDeviceSession } from '../modules/tenancy/device-session.guard';
import type { TenantSession, DeviceSession } from '../modules/tenancy/jwt-session';
import { IdempotencyKey, parseRequiredIdempotencyKey } from '../modules/tenancy/idempotency-guard';
import { UUID_RE } from '../shared/primitives/ids';
import { ReceivingFacade } from '../modules/inbound/receiving.facade';
import { OutboundFacade } from '../modules/outbound/outbound.facade';
import { QcFacade } from '../modules/inbound/qc.facade';
import { MovementsFacade } from '../modules/movements/transfer.facade';
import { ClientsFacade } from '../modules/clients/clients.facade';
import { ReturnsFacade } from '../modules/returns/returns.facade';
import { InventoryFacade } from '../modules/inventory/inventory.facade';
// Constructor params are types here but must stay value imports: Nest
// decorator metadata needs the runtime class tokens (eslint rule bends).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CatalogSnapshotQuery,
  CatalogSnapshotResponse,
  GoodsReceiptLinesResponse,
  GoodsReceiptListQuery,
  GoodsReceiptListResponse,
  GoodsReceiptResponse,
  OverReceiptDecisionResponse,
  OverReceiptListQuery,
  OverReceiptListResponse,
  SubmitGoodsReceiptDto,
} from '../modules/inbound/receiving.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  InspectQcHoldDto,
  InspectQcHoldResponse,
  PlaceQcHoldDto,
  QcHoldDetailResponse,
  QcHoldListQuery,
  QcHoldListResponse,
  QcHoldResponse,
  ReleaseReceiptHoldsDto,
  ReleaseReceiptHoldsResponse,
} from '../modules/inbound/qc.dto';
import { assertInstantRange } from '../shared/primitives/instant-range';
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
 * The receiving HTTP surface (Story 3.3): the device-side `grn.submit` route
 * (badge-in session — the substrate's first real op) and the web-side read +
 * decision surfaces (GRN list, over-receipt queue, approve/reject gated by
 * `review.decide`). The api shell is the only HTTP surface of the monolith;
 * every mutation goes through `ReceivingFacade`, whose commands re-evaluate
 * device status / operator role / caller role against the DB at entry — the
 * token is transport, never authority.
 */
@ApiTags('receiving')
@ApiExtraModels(ProblemDetailsDto)
@Controller('tenants')
export class ReceivingController {
  constructor(
    @Inject(ReceivingFacade) private readonly receiving: ReceivingFacade,
    @Inject(QcFacade) private readonly qc: QcFacade,
    // Story 4.3: the snapshot's `pickTasks` arm — cross-facade composition at
    // the shell, which is where AD-6 puts it.
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
    // Story 5-1: the snapshot's `transferTasks` arm — the same composition
    // (the transfer aggregate is movements-exclusive).
    @Inject(MovementsFacade) private readonly movements: MovementsFacade,
    // Story 13-2: the snapshot's `openReturns` arm — the same composition
    // (the returns module is imported only by the api shell).
    @Inject(ReturnsFacade) private readonly returns: ReturnsFacade,
    // Story 1-1: the snapshot's `clients` arm — read through the clients
    // facade (inbound does not own the table), composed here like the others.
    @Inject(ClientsFacade) private readonly clients: ClientsFacade,
    // Story 3-2b: the snapshot's `adjustReasons` arm (the vocabulary with
    // labels), read through the inventory facade.
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
  ) {}

  @Post(':tenantId/receiving/goods-receipts')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'grn.submit — records a whole goods receipt exactly once (badge-in session required); the excess over a line\'s open quantity pends for Ops Manager approval',
  })
  @ApiBody({ type: SubmitGoodsReceiptDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: GoodsReceiptResponse,
    description:
      'GRN recorded: server-assigned code, per-line physical/applied/excess quantities, ledger events for the applied portion (the idempotency snapshot). Story 21-9: a receipt against a closed PO or a cancelled/closed ASN is no longer refused — every line pends as an over-receipt against that document (applied 0); a closed PO with an open carried successor is booked against the successor instead (poId/poCode name it)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or an invalid body (validation-failed) — story 1-1: a clientId beside a poId or an asnId; story 2-4a: a damaged or short quantity without its reason, a reason with 0 or outside its vocabulary, a negative or over-maximum quantity, a line with qty + damagedQty = 0, or damage on a serial-tracked or catch-weight SKU') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked), or the operator was demoted to accountant (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, purchase order, advance shipment notice, a blind receipt\'s client (story 1-1), or a line\'s SKU does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The document belongs to another warehouse (document-warehouse-mismatch — checked before the document\'s status, so a closed or cancelled document of another warehouse answers this too), the document has a status receiving does not know (po-not-open / asn-not-open — DEFENSIVE since story 21-9: a closed PO or a cancelled/closed ASN no longer refuses, the receipt pends for approval), a GRN line names a kit SKU — a kit never receives stock (kit-cannot-hold-stock, naming it), a line carries damaged units and a user zone or bin coded DAMAGED blocks the system damaged bin (damaged-bin-conflict, story 2-4a), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async submitGoodsReceipt(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentDeviceSession() session: DeviceSession,
    @Body() dto: SubmitGoodsReceiptDto,
  ): Promise<GoodsReceiptResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (session.userId === null) {
      // A bare enrollment credential has no operator — badge-in first.
      throw badgeInRequired();
    }
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.receiving.submitGoodsReceipt(
      {
        tenantId,
        deviceId: session.deviceId,
        operatorUserId: session.userId,
        warehouseId: dto.warehouseId,
        poId: dto.poId ?? null,
        // Story 21-6: absent → null, like poId (the command hashes it only
        // when present, so the two spellings hash identically).
        asnId: dto.asnId ?? null,
        blindReasonCode: dto.blindReasonCode ?? null,
        // Story 1-1: absent stays absent (hashed only when present).
        ...(dto.clientId === undefined ? {} : { clientId: dto.clientId }),
        // Story 2-3a: the gate-in link — absent stays absent (hashed only when present).
        ...(dto.gateInId === undefined ? {} : { gateInId: dto.gateInId }),
        occurredAt: dto.occurredAt,
        lines: dto.lines.map((line) => ({
          poLineId: line.poLineId ?? null,
          asnLineId: line.asnLineId ?? null,
          skuId: line.skuId,
          batchCode: line.batchCode ?? null,
          mfgDate: line.mfgDate ?? null,
          // Story 1-2b: the label's expiry (an IST date). Absent and null
          // hash identically (the command folds it `?? undefined`).
          ...(line.expiryDate === undefined || line.expiryDate === null ? {} : { expiryDate: line.expiryDate }),
          // Story 10.2: BASE units cross this edge. The receiving command
          // scales each line behind its replay lookup, once it has read the
          // line's SKU and therefore the unit's declared precision.
          qty: line.qty,
          // Story 10.3: GRAMS cross this edge unchanged and stay grams all
          // the way to the column — a catch weight is never scaled, because
          // it is never a quantity. `@IsOptional()` lets an explicit `null`
          // through; it normalizes to absent so the two spellings of "no
          // weights" hash identically.
          // An empty array normalizes to ABSENT, the way the sibling
          // controllers normalize their optional arms: otherwise `[]` on a
          // non-catch-weight line answers the one-weight-per-unit count
          // message instead of "is not catch-weight tracked", and the two
          // spellings of "no weights" would fingerprint differently.
          weightsGrams:
            line.weightsGrams !== undefined &&
            line.weightsGrams !== null &&
            line.weightsGrams.length > 0
              ? line.weightsGrams
              : null,
          // Story 2-4a: the condition fields, base units — absent stays
          // absent (the command normalises `?? 0` / `?? null` and hashes each
          // only when its quantity is > 0, so absent, null and 0 hash alike).
          ...(line.damagedQty === undefined || line.damagedQty === null ? {} : { damagedQty: line.damagedQty }),
          ...(line.damageReasonCode === undefined || line.damageReasonCode === null ? {} : { damageReasonCode: line.damageReasonCode }),
          ...(line.shortQty === undefined || line.shortQty === null ? {} : { shortQty: line.shortQty }),
          ...(line.shortReasonCode === undefined || line.shortReasonCode === null ? {} : { shortReasonCode: line.shortReasonCode }),
        })),
      },
      key,
    );
    // Story 1-1 (decision 6): every line client-refused → no receipt.
    if (snapshot.goodsReceipt === null) {
      return { goodsReceipt: null, refusedReceipt: { ...snapshot.refusedReceipt } };
    }
    return { goodsReceipt: { ...snapshot.goodsReceipt } };
  }

  @Get(':tenantId/devices/catalog-snapshot')
  @UseGuards(DeviceSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'The device catalog snapshot (badge-in session required): SKU barcode map + open PO lines for the offline decision mirror (AD-4)',
  })
  @ApiOkResponse({
    type: CatalogSnapshotResponse,
    description: 'The warehouse\'s SKU scan identity + open purchase orders with per-line quantities',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed warehouseId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing/invalid device token, or a bare device credential without badge-in (unauthenticated)') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Unknown or revoked device (device-revoked)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse does not exist in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the device token)' })
  async getCatalogSnapshot(
    @Param('tenantId') tenantId: string,
    @CurrentDeviceSession() session: DeviceSession,
    @Query() query: CatalogSnapshotQuery,
  ): Promise<CatalogSnapshotResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (session.userId === null) {
      throw badgeInRequired();
    }
    assertUuidParam(query.warehouseId, 'warehouseId');
    // Story 4.3: `pickTasks` is composed HERE, across the two facades, not by
    // `ReceivingFacade` reaching into the outbound module. The wave aggregate
    // is outbound-exclusive (AD-6) and the api shell is the sanctioned place
    // to join two modules' reads — the pattern story 2.4 set when the
    // adjustment's batch/serial arms needed catalog + inventory together.
    // Making `InboundModule` import `OutboundModule` instead would pull the
    // entire outbound graph into inbound's initialization for one array.
    const snapshot = await this.receiving.getCatalogSnapshot(tenantId, query.warehouseId);
    const pickTasks = await this.outbound.getPickTasks(tenantId, query.warehouseId);
    // Story 10.7: the pack arm — packable orders' per-SKU picked totals plus
    // the warehouse's active handling units. Same sequential composition: the
    // shell never nests one facade's transaction inside another's.
    const packWork = await this.outbound.getPackTasks(tenantId, query.warehouseId);
    // Story 5-1: the Transfer inbox arm — in-transit transfers TO this
    // warehouse, the inbound-confirm tasks. Same sequential composition: the
    // shell never nests one facade's transaction inside another's.
    const transferTasks = await this.movements.getTransferTasks(tenantId, query.warehouseId);
    // Story 5-3: the Count inbox arm — STORED pending count tasks for this
    // warehouse (the first stored task feed; every other arm derives on
    // read). Story 3-5a — BLIND: each line names its SKU only; the frozen
    // expectations never reach a device. Same sequential composition.
    const countTasks = await this.movements.getCountTasks(tenantId, query.warehouseId);
    // Story 13-2: the return-receipt arm — the warehouse's open and
    // partially received RMAs. A plain facade call in its own transaction,
    // composed beside the task lists (never nested).
    const openReturns = await this.returns.getOpenReturns(tenantId, query.warehouseId);
    // Story 1-1: every client a SKU or an open document references — the
    // names the device shows when a scan is another client's, and the blind
    // receipt's picker. Same sequential composition.
    const clients = await this.clients.snapshotClients(tenantId, [
      ...snapshot.skus.map((sku) => sku.clientId),
      ...snapshot.openPurchaseOrders.map((po) => po.clientId),
      ...snapshot.openAsns.map((asn) => asn.clientId),
      ...openReturns.map((rma) => rma.clientId),
      // Story 1-5b: every bin's dedicated client, so the device can name the
      // client a dedicated bin belongs to when it refuses a scan against it.
      ...snapshot.bins.map((bin) => bin.dedicatedClientId).filter((id): id is string => id !== null),
    ]);
    return {
      ...snapshot,
      // Story 1-4 — the pack barcodes, copied key by key (a mutable DTO array).
      // Story 1-6a — and the DG arm, its subsidiary list copied too.
      skus: snapshot.skus.map((sku) => ({
        ...sku,
        packBarcodes: sku.packBarcodes.map((entry) => ({ ...entry })),
        dg: sku.dg === null ? null : { ...sku.dg, subsidiaryClasses: [...sku.dg.subsidiaryClasses] },
      })),
      pickTasks: pickTasks.map((task) => ({ ...task })),
      packTasks: packWork.packTasks.map((task) => ({ ...task })),
      handlingUnits: packWork.handlingUnits.map((unit) => ({ ...unit })),
      transferTasks: transferTasks.map((task) => ({ ...task, lines: task.lines.map((line) => ({ ...line })) })),
      // Story 3-5a — the lines rebuilt key by key (an exact allowlist, never
      // a spread): no expected quantity can ride along.
      countTasks: countTasks.map((task) => ({
        ...task,
        lines: task.lines.map((line) => ({ skuId: line.skuId, skuCode: line.skuCode, skuName: line.skuName })),
      })),
      openReturns: openReturns.map((rma) => ({
        ...rma,
        lines: rma.lines.map((line) => ({ ...line, batchCodes: [...line.batchCodes], serials: line.serials.map((serial) => ({ ...serial })) })),
      })),
      clients,
      // Story 2-3a — the open gate-ins, copied key by key (a mutable DTO array).
      openGateIns: snapshot.openGateIns.map((gateIn) => ({ ...gateIn, documents: gateIn.documents.map((doc) => ({ ...doc })) })),
      // Story 3-1 — the move reason vocabulary, read through the movements
      // facade (inbound never imports the movements module).
      moveReasons: this.movements.moveReasons().map((reason) => ({ ...reason })),
      // Story 3-2b (A9) — the adjustment reason vocabulary with labels, read
      // through the inventory facade (inbound never imports inventory's
      // vocabulary file); the handheld's Adjust entry shows only when present.
      adjustReasons: this.inventory.adjustmentReasons().map((reason) => ({ code: reason.code, label: reason.label })),
    };
  }

  @Get(':tenantId/receiving/goods-receipts')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Lists goods receipt notes (keyset cursor pagination, warehouse-filterable — open to any member)",
  })
  @ApiOkResponse({
    type: GoodsReceiptListResponse,
    description: 'The GRN page (headers with line/unit sums — the Inbound surface\'s list read)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed cursor (invalid-cursor), malformed warehouseId, out-of-range limit, a blind/poless flag other than true/false or the two disagreeing, a from/to that is not an ISO-8601 instant, or from not before to (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouseId filter names a warehouse outside this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listGoodsReceipts(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: GoodsReceiptListQuery,
  ): Promise<GoodsReceiptListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (query.warehouseId !== undefined) {
      assertUuidParam(query.warehouseId, 'warehouseId');
    }
    assertInstantRange(query.from, query.to);
    // Story 21-6: `poless` stays accepted as an alias of `blind` (an ASN
    // receipt has no PO and is not blind, so "poless" now MEANS blind).
    if (query.blind !== undefined && query.poless !== undefined && query.blind !== query.poless) {
      throw new ProblemException(
        'validation-failed',
        400,
        'blind and poless disagree',
        '`poless` is an alias of `blind` — send one, or both with the same value.',
      );
    }
    const page = await this.receiving.listGoodsReceipts(tenantId, {
      warehouseId: query.warehouseId,
      clientId: query.clientId,
      blind: query.blind ?? query.poless,
      from: query.from,
      to: query.to,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Get(':tenantId/receiving/goods-receipts/:grnId/lines')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 2-4a — one goods receipt's lines (the web's expandable GRN row): SKU, batch, good and applied units, and the damaged and short quantities with their reasons — open to any member",
  })
  @ApiOkResponse({ type: GoodsReceiptLinesResponse, description: "The GRN's lines in receipt order" })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed grnId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or a client-portal session (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No such goods receipt in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'grnId', format: 'uuid', description: 'The goods receipt' })
  async listGoodsReceiptLines(
    @Param('tenantId') tenantId: string,
    @Param('grnId') grnId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<GoodsReceiptLinesResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(grnId, 'grnId');
    const items = await this.receiving.listGoodsReceiptLines(tenantId, grnId);
    return { items: items.map((item) => ({ ...item })) };
  }

  @Get(':tenantId/receiving/over-receipts')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Lists over-receipts (keyset cursor pagination, status-filterable — the Conflicts & Reviews queue read)',
  })
  @ApiOkResponse({ type: OverReceiptListResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed status, warehouseId, cursor, out-of-range limit, a from/to that is not an ISO-8601 instant, or from not before to (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouseId filter names a warehouse outside this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listOverReceipts(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: OverReceiptListQuery,
  ): Promise<OverReceiptListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertInstantRange(query.from, query.to);
    const page = await this.receiving.listOverReceipts(tenantId, {
      status: query.status,
      clientId: query.clientId,
      warehouseId: query.warehouseId,
      from: query.from,
      to: query.to,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Post(':tenantId/receiving/over-receipts/:overReceiptId/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Approves an over-receipt (review.decide) — a grn.received ledger event applies the excess and received_qty bumps; audited',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: OverReceiptDecisionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed overReceiptId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks review.decide (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No over-receipt with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Already approved/rejected (over-receipt-decided), the SKU became a kit since the GRN — the excess can never apply to it (kit-cannot-hold-stock, naming it), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'overReceiptId', format: 'uuid' })
  async approveOverReceipt(
    @Param('tenantId') tenantId: string,
    @Param('overReceiptId') overReceiptId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<OverReceiptDecisionResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(overReceiptId, 'overReceiptId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.receiving.decideOverReceipt(
      { tenantId, actorUserId: session.userId, overReceiptId, decision: 'approve' },
      key,
    );
    return { overReceipt: { ...snapshot.overReceipt } };
  }

  @Post(':tenantId/receiving/over-receipts/:overReceiptId/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Rejects an over-receipt (review.decide) — the excess stays unapplied; audited',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({ status: HttpStatus.OK, type: OverReceiptDecisionResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed overReceiptId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks review.decide (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No over-receipt with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Already approved/rejected (over-receipt-decided), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'overReceiptId', format: 'uuid' })
  async rejectOverReceipt(
    @Param('tenantId') tenantId: string,
    @Param('overReceiptId') overReceiptId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<OverReceiptDecisionResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(overReceiptId, 'overReceiptId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.receiving.decideOverReceipt(
      { tenantId, actorUserId: session.userId, overReceiptId, decision: 'reject' },
      key,
    );
    return { overReceipt: { ...snapshot.overReceipt } };
  }

  @Post(':tenantId/receiving/qc-holds')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'qc-holds.place — quarantines a (sku, bin) scope: qc.held ledger movements move the stock into the warehouse\'s system QC-hold bin; ATP drops by the moved quantity (qc.manage)',
  })
  @ApiBody({ type: PlaceQcHoldDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: QcHoldResponse,
    description: 'Hold placed: the open hold row (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, an invalid body, an empty scope, a serial-tracked SKU, or the system QC-hold bin as the hold origin (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks qc.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('Warehouse, SKU, or bin does not exist in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('An open hold already covers this scope (qc-hold-open), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async placeQcHold(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: PlaceQcHoldDto,
  ): Promise<QcHoldResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.qc.placeHold(
      {
        tenantId,
        actorUserId: session.userId,
        warehouseId: dto.warehouseId,
        skuId: dto.skuId,
        binId: dto.binId,
        reason: dto.reason,
      },
      key,
    );
    return { qcHold: { ...snapshot.qcHold } };
  }

  @Post(':tenantId/receiving/qc-holds/:holdId/release')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Releases a QC hold (qc.manage) — qc.released movements return exactly the held units (the hold\'s own ledger arms) to its recorded origin bin; audited',
  })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiResponse({
    status: HttpStatus.OK,
    type: QcHoldResponse,
    description: 'Hold released: the released hold row with its releasedBy/releasedAt (the idempotency snapshot)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed holdId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks qc.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No QC hold with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('Already released (qc-hold-released), the origin bin no longer exists (qc-hold-origin-bin-gone), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'holdId', format: 'uuid' })
  async releaseQcHold(
    @Param('tenantId') tenantId: string,
    @Param('holdId') holdId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
  ): Promise<QcHoldResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(holdId, 'holdId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.qc.releaseHold(
      { tenantId, actorUserId: session.userId, holdId },
      key,
    );
    return { qcHold: { ...snapshot.qcHold } };
  }

  @Post(':tenantId/receiving/qc-holds/:holdId/inspect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 2-8a — records a QC hold's inspection outcome and closes it (qc.manage): per held batch arm, passed units return to the origin bin (qc.released; Receiving for a receipt hold — putaway work again) and failed units move to the system DAMAGED bin (qc.failed — ATP-excluded, write-off only) with a fail reason; the hold closes `inspected`; audited",
  })
  @ApiBody({ type: InspectQcHoldDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: InspectQcHoldResponse, description: 'The inspected hold and its inspection (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, a malformed holdId or body, a batch named twice, a reason named twice in one batch, `other` without a note, a note over 500 characters, or a quantity finer than the unit allows (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks qc.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No QC hold with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The hold is already closed — released or inspected (qc-hold-released); units pass but the origin bin is gone or retired (qc-hold-origin-bin-gone); a user location occupies the DAMAGED code (damaged-bin-conflict); or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('The lines do not cover exactly the held arms and quantities (qc-inspection-mismatch), or the Idempotency-Key was reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'holdId', format: 'uuid' })
  async inspectQcHold(
    @Param('tenantId') tenantId: string,
    @Param('holdId') holdId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: InspectQcHoldDto,
  ): Promise<InspectQcHoldResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(holdId, 'holdId');
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.qc.inspectHold(
      {
        tenantId,
        actorUserId: session.userId,
        holdId,
        lines: dto.lines.map((line) => ({
          batchId: line.batchId,
          passed: line.passed,
          failed: line.failed.map((failure) => ({ reason: failure.reason, quantity: failure.quantity })),
        })),
        note: dto.note ?? null,
      },
      key,
    );
    return {
      qcHold: { ...snapshot.qcHold },
      inspection: { ...snapshot.inspection, lines: snapshot.inspection.lines.map((line) => ({ ...line })) },
    };
  }

  @Post(':tenantId/receiving/qc-holds/release-receipt')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Story 1-2b — releases EVERY open QC-on-receipt hold of one goods receipt in one transaction (qc.manage) — each hold's own qc.released arms return its units to the Receiving bin, where they become putaway work; one audit row; the receipt's notification resolves",
  })
  @ApiBody({ type: ReleaseReceiptHoldsDto })
  @ApiHeaders(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: ReleaseReceiptHoldsResponse, description: 'The released holds (a matching Idempotency-Key replays it)' })
  @ApiResponse({ status: 400, ...problemJsonResponse('Missing or malformed Idempotency-Key, or a malformed grnId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied), or the caller lacks qc.manage (role-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No goods receipt with this id exists in this tenant (not-found)') })
  @ApiResponse({ status: 409, ...problemJsonResponse('The receipt has no open QC-on-receipt hold (qc-hold-released), a hold\'s origin bin is gone (qc-hold-origin-bin-gone), or a concurrent idempotent request (conflict)') })
  @ApiResponse({ status: 422, ...problemJsonResponse('Idempotency key reused with a different payload (idempotency-key-reuse)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async releaseReceiptHolds(
    @Param('tenantId') tenantId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentSession() session: TenantSession,
    @Body() dto: ReleaseReceiptHoldsDto,
  ): Promise<ReleaseReceiptHoldsResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    const key = parseRequiredIdempotencyKey(idempotencyKey);
    const snapshot = await this.qc.releaseReceiptHolds(
      { tenantId, actorUserId: session.userId, grnId: dto.grnId },
      key,
    );
    return { grnId: snapshot.grnId, grnCode: snapshot.grnCode, qcHolds: snapshot.qcHolds.map((hold) => ({ ...hold })) };
  }

  @Get(':tenantId/receiving/qc-holds')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Lists QC holds (keyset cursor pagination, warehouse- and status-filterable — open to any member; story 2-8a: `inspected` and `closed` = released or inspected)',
  })
  @ApiOkResponse({
    type: QcHoldListResponse,
    description: 'The QC-hold page (newest first — the Inbound surface\'s holds read)',
  })
  @ApiResponse({ status: 400, ...problemJsonResponse('Malformed status, cursor, warehouseId, or out-of-range limit (validation-failed / invalid-cursor)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('The warehouseId filter names a warehouse outside this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  async listQcHolds(
    @Param('tenantId') tenantId: string,
    @CurrentSession() session: TenantSession,
    @Query() query: QcHoldListQuery,
  ): Promise<QcHoldListResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    if (query.warehouseId !== undefined) {
      assertUuidParam(query.warehouseId, 'warehouseId');
    }
    const page = await this.qc.listQcHolds(tenantId, {
      warehouseId: query.warehouseId,
      status: query.status,
      grnId: query.grnId,
      clientId: query.clientId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items, nextCursor: page.nextCursor };
  }

  @Get(':tenantId/receiving/qc-holds/:holdId')
  @UseGuards(TenantSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Story 2-8a — one QC hold: the list row, the batch arms it moved (code, expiry, quantity) and, once inspected, its inspection (open to any member)',
  })
  @ApiOkResponse({ type: QcHoldDetailResponse })
  @ApiResponse({ status: 400, ...problemJsonResponse('A malformed holdId (validation-failed)') })
  @ApiResponse({ status: 401, ...problemJsonResponse('Missing or invalid session token') })
  @ApiResponse({ status: 403, ...problemJsonResponse('Session belongs to another tenant (permission-denied)') })
  @ApiResponse({ status: 404, ...problemJsonResponse('No QC hold with this id exists in this tenant (not-found)') })
  @ApiParam({ name: 'tenantId', format: 'uuid', description: 'Owning tenant (must match the session)' })
  @ApiParam({ name: 'holdId', format: 'uuid' })
  async getQcHold(
    @Param('tenantId') tenantId: string,
    @Param('holdId') holdId: string,
    @CurrentSession() session: TenantSession,
  ): Promise<QcHoldDetailResponse> {
    assertOwnTenantToken(session.tenantId, tenantId);
    assertUuidParam(holdId, 'holdId');
    const detail = await this.qc.getQcHold(tenantId, holdId);
    return {
      qcHold: detail.qcHold,
      arms: detail.arms.map((arm) => ({ ...arm })),
      inspection:
        detail.inspection === null
          ? null
          : { ...detail.inspection, lines: detail.inspection.lines.map((line) => ({ ...line })) },
    };
  }
}

/** Receiving uuid path/query params fail 400 (not a 500 from the `::uuid` cast). */
function assertUuidParam(value: string, name: 'overReceiptId' | 'holdId' | 'warehouseId' | 'grnId'): void {
  if (!UUID_RE.test(value)) {
    throw new ProblemException(
      'validation-failed',
      400,
      `${name} must be a uuid`,
      `The "${name}" parameter must be a uuid (got "${value}").`,
    );
  }
}

function badgeInRequired(): ProblemException {
  return new ProblemException(
    'unauthenticated',
    401,
    'Badge-in required',
    'This endpoint requires an operator badge-in session.',
  );
}

function assertOwnTenantToken(tokenTenantId: string, tenantId: string): void {
  if (tokenTenantId !== tenantId) {
    throw new ProblemException(
      'permission-denied',
      403,
      'Session belongs to another tenant',
      'The session token tenant does not own this path.',
    );
  }
}