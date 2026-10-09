import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  advanceShipmentNotices,
  asnLines,
  auditEvents,
  goodsReceiptNotes,
  idempotencyKeys,
  overReceipts,
  skus,
} from '../../shared/db/schema';
import type { AsnLine } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import { assertUtcIso, canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission } from '../tenancy/permissions';
import {
  assertWarehouseInTenant,
  getMemberClientIdIn,
  getMemberPortalFactsIn,
  getMemberRoleIn,
} from '../tenancy/tenancy.service';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import {
  assertClientInTenantInTx,
  assertSingleClientInTx,
  clientSuspended,
  getClientLabelsInTx,
  getClientStatusInTx,
} from '../clients/clients.facade';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { assertRecordableQuantity, fromMilli } from '../../shared/primitives/quantity';
import { uomPrecision } from '../catalog/uom';
import { CatalogFacade } from '../catalog/catalog.facade';
import { kitCannotHoldStock } from '../catalog/kit.store';
import { portalAsnInTx, type PortalAsnDetail } from './portal-inbound';

// ── vocabularies ─────────────────────────────────────────────────────────────

/**
 * Story 21-6 — the ASN lifecycle. Mirrored by
 * `advance_shipment_notices_status_check` (0064) and pinned against it by
 * `test/asn.spec.ts`.
 *
 * - `announced`, `partially_received`, `received` are DERIVED from the lines
 *   (Σ received against Σ announced per line), in the same transaction as
 *   every receipt, approval and amend;
 * - `closed` (a short ASN, from `partially_received`) and `cancelled` (from
 *   `announced`) are explicit, terminal and carry a note.
 */
export const ASN_STATUSES = ['announced', 'partially_received', 'received', 'closed', 'cancelled'] as const;
export type AsnStatus = (typeof ASN_STATUSES)[number];

/** The three states the lines decide — every other state is terminal and never re-derived. */
export const DERIVED_ASN_STATUSES: readonly AsnStatus[] = ['announced', 'partially_received', 'received'];

/** The states an amend may land against — and the ones the device snapshot lists. */
export const OPEN_ASN_STATUSES: readonly AsnStatus[] = ['announced', 'partially_received'];

/**
 * The states a RECEIPT may land against (spec change log, 2026-10-08): a
 * `received` ASN still accepts goods — a scan queued while it was partly
 * received and replayed after must reach the ledger; everything beyond
 * announced pends as an over-receipt, exactly as on a PO. Only the explicit
 * terminals (`closed`, `cancelled`) refuse 409 `asn-not-open`.
 */
export const RECEIVABLE_ASN_STATUSES: readonly AsnStatus[] = ['announced', 'partially_received', 'received'];

/** The two explicit transitions and the one state each may leave. */
export const ASN_TRANSITIONS = { close: 'partially_received', cancel: 'announced' } as const satisfies Record<
  string,
  AsnStatus
>;
export type AsnTransition = keyof typeof ASN_TRANSITIONS;

/** The line limit, the same as a purchase order's. */
export const MAX_ASN_LINES = 200;
/** A client-supplied code — the PO code's bound. */
export const MAX_ASN_CODE_LENGTH = 64;
/** A close / cancel note, in code points. */
export const MAX_ASN_NOTE_CODE_POINTS = 500;

const ASN_TENANT_CLIENT_CODE = 'advance_shipment_notices_tenant_client_code_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

// ── command inputs ───────────────────────────────────────────────────────────

export interface AsnLineInput {
  readonly skuId: string;
  /** Announced quantity in base UoM, at the unit's declared precision. */
  readonly announcedQty: number;
}

export interface CreateAsnCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  /** Explicit, and checked against the client derived from the lines' SKUs. */
  readonly clientId: string;
  readonly warehouseId: string;
  readonly asnCode: string;
  readonly expectedAt?: string | null | undefined;
  readonly lines: readonly AsnLineInput[];
}

/**
 * Story 21-7b — a client user announces its OWN inbound shipment from the
 * portal. `clientId` is the portal session's (the guard's re-read), never a
 * body field; the command re-checks it against the actor in its own
 * transaction.
 */
export interface AnnounceAsnCommand {
  readonly tenantId: string;
  /** From `PortalSession` — never from the request body. */
  readonly clientId: string;
  /** The client-portal user. */
  readonly actorUserId: string;
  readonly warehouseId: string;
  readonly asnCode: string;
  readonly expectedAt?: string | null | undefined;
  readonly lines: readonly AsnLineInput[];
}

export interface AmendAsnCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly asnId: string;
  /** Absent: unchanged. Null: cleared. */
  readonly expectedAt?: string | null | undefined;
  /** The complete new line set (update by id, add without, delete by absence). */
  readonly lines: readonly (AsnLineInput & { readonly id?: string | undefined })[];
}

export interface TransitionAsnCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly asnId: string;
  readonly transition: AsnTransition;
  readonly note: string;
}

// ── snapshots ────────────────────────────────────────────────────────────────

export interface AsnLineSnapshot {
  readonly id: string;
  readonly skuId: string;
  readonly announcedQty: number;
  readonly receivedQty: number;
  /** Derived: announced − received (negative after an approved over-receipt, as on a PO line). */
  readonly openQty: number;
}

/** One ASN header as the warehouse list returns it. */
export interface AsnEntry {
  readonly id: string;
  readonly code: string;
  readonly clientId: string;
  readonly status: AsnStatus;
  readonly expectedAt: string | null;
  readonly lineCount: number;
  /** Story 21-6 review — lines with received ≥ announced (the unit-safe progress figure). */
  readonly linesComplete: number;
  readonly announcedTotal: number;
  readonly receivedTotal: number;
  readonly createdAt: string;
}

/** The detail and every mutation's response (the idempotency snapshot). */
export interface AsnDetail extends AsnEntry {
  readonly warehouseId: string;
  readonly statusNote: string | null;
  readonly updatedAt: string;
  readonly lines: readonly AsnLineSnapshot[];
}

export interface AsnSnapshot {
  readonly asn: AsnDetail;
}

// ── refusals ─────────────────────────────────────────────────────────────────

export function asnNotFound(asnId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Advance shipment notice not found',
    `No advance shipment notice with id "${asnId}" exists in this tenant.`,
  );
}

export function asnNotOpen(code: string, status: string): ProblemException {
  return new ProblemException(
    'asn-not-open',
    409,
    'Advance shipment notice is not open',
    `Advance shipment notice "${code}" is ${status} — ${
      status === 'received'
        ? 'a fully received ASN can still receive (the excess pends), but no longer be amended'
        : 'a closed or cancelled ASN can no longer be received or amended'
    }.`,
  );
}

function asnTransitionInvalid(code: string, status: string, transition: AsnTransition): ProblemException {
  const from = ASN_TRANSITIONS[transition];
  return new ProblemException(
    'asn-transition-invalid',
    409,
    `Advance shipment notice cannot be ${transition === 'close' ? 'closed' : 'cancelled'}`,
    `Advance shipment notice "${code}" is ${status} — ${transition} applies only to a ${from.replace('_', ' ')} ASN${
      transition === 'close' ? ' (a fully received ASN is already complete; an untouched one is cancelled)' : ' (once anything is received, close it short instead)'
    }.`,
  );
}

function asnLineReceived(code: string, lineId: string, detail: string): ProblemException {
  return new ProblemException(
    'asn-line-received',
    409,
    'ASN line has already received stock',
    `Line "${lineId}" of advance shipment notice "${code}" ${detail}`,
  );
}

/** 409 `sku-client-mismatch` — a line SKU of another client than the document's. */
export function skuClientMismatch(subject: string, documentClient: string, skuClients: readonly string[]): ProblemException {
  return new ProblemException(
    'sku-client-mismatch',
    409,
    "SKUs belong to another client than the document's",
    `${subject} is for client ${documentClient}, but its lines name SKUs of ${[...new Set(skuClients)].sort().join(', ')} — an ASN carries only its own client's SKUs.`,
  );
}

function duplicateAsnCode(code: string, clientLabel: string): ProblemException {
  return new ProblemException(
    'duplicate-asn-code',
    409,
    'ASN code already in use',
    `Client ${clientLabel} already has an advance shipment notice "${code}".`,
  );
}

/** 409 `over-receipt-pending` — the decision 3 close guard, PO and ASN alike. */
export function overReceiptPending(subject: string, count: number): ProblemException {
  return new ProblemException(
    'over-receipt-pending',
    409,
    'Over-receipts await a decision',
    `${subject} has ${count} over-receipt(s) awaiting approval or rejection — decide them in Conflicts & Reviews first, so stock that physically arrived is never stranded.`,
  );
}

/** 403 for a client-portal session — 21-7 opens the portal's ASN routes. */
export function asnPortalRefused(): ProblemException {
  return new ProblemException(
    'role-denied',
    403,
    'Client-portal sessions cannot use advance shipment notices yet',
    'Advance shipment notices are an operator surface until the client portal opens them; a client-portal user cannot read or write them through this route.',
  );
}

function asnValidation(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid advance shipment notice', detail);
}

// ── shared helpers (exported for the receiving arm) ─────────────────────────

/**
 * Decision 3 — refuses 409 `over-receipt-pending` while any over-receipt of
 * the document awaits a decision. Run UNDER the document's row lock: an
 * approve locks the over-receipt row, the SKU, then the document, so a
 * concurrent close and approve serialise on the document and this read sees
 * whatever the approve committed.
 */
export async function assertNoPendingOverReceiptsInTx(
  tx: TenantTx,
  tenantId: string,
  document: { readonly poId: string } | { readonly asnId: string },
  subject: string,
): Promise<void> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(overReceipts)
    .where(
      and(
        eq(overReceipts.tenantId, tenantId),
        'poId' in document ? eq(overReceipts.poId, document.poId) : eq(overReceipts.asnId, document.asnId),
        eq(overReceipts.status, 'pending'),
      ),
    );
  const n = Number(rows[0]?.n ?? 0);
  if (n > 0) {
    throw overReceiptPending(subject, n);
  }
}

/** The status the lines decide (Σ received against Σ announced, per line). */
export function derivedAsnStatus(lines: readonly { announcedQty: number; receivedQty: number }[]): AsnStatus {
  if (lines.length > 0 && lines.every((line) => line.receivedQty >= line.announcedQty)) {
    return 'received';
  }
  if (lines.every((line) => line.receivedQty === 0)) {
    return 'announced';
  }
  return 'partially_received';
}

/**
 * Re-derives an ASN's status from its lines, in the caller's transaction —
 * after every receipt, approval and amend. A terminal status (`closed`,
 * `cancelled`) is never re-derived: an approval on a short-closed ASN bumps
 * its line and leaves it closed. Returns the status it holds afterwards.
 */
export async function deriveAsnStatusInTx(tx: TenantTx, tenantId: string, asnId: string): Promise<AsnStatus> {
  const header = await tx
    .select({ status: advanceShipmentNotices.status })
    .from(advanceShipmentNotices)
    .where(and(eq(advanceShipmentNotices.tenantId, tenantId), eq(advanceShipmentNotices.id, asnId)))
    .limit(1);
  const current = header[0]?.status as AsnStatus | undefined;
  if (current === undefined) {
    throw asnNotFound(asnId);
  }
  if (!DERIVED_ASN_STATUSES.includes(current)) {
    return current;
  }
  const lines = await tx
    .select({ announcedQty: asnLines.announcedQty, receivedQty: asnLines.receivedQty })
    .from(asnLines)
    .where(eq(asnLines.asnId, asnId));
  const next = derivedAsnStatus(lines);
  if (next !== current) {
    await tx
      .update(advanceShipmentNotices)
      .set({ status: next, updatedAt: nowIso() })
      .where(and(eq(advanceShipmentNotices.id, asnId), eq(advanceShipmentNotices.status, current)));
  }
  return next;
}

/** One stored line as every read returns it — base units, open derived. */
export function asnLineSnapshot(row: AsnLine): AsnLineSnapshot {
  return {
    id: row.id,
    skuId: row.skuId,
    announcedQty: fromMilli(row.announcedQty),
    receivedQty: fromMilli(row.receivedQty),
    openQty: fromMilli(row.announcedQty - row.receivedQty),
  };
}

/** The ASN + lines as one snapshot (instants canonical, quantities base). Null when absent. */
export async function readAsnInTx(tx: TenantTx, tenantId: string, asnId: string): Promise<AsnDetail | null> {
  const rows = await tx
    .select()
    .from(advanceShipmentNotices)
    .where(and(eq(advanceShipmentNotices.tenantId, tenantId), eq(advanceShipmentNotices.id, asnId)))
    .limit(1);
  const asn = rows[0];
  if (asn === undefined) {
    return null;
  }
  const lineRows = await tx
    .select()
    .from(asnLines)
    .where(eq(asnLines.asnId, asn.id))
    .orderBy(asc(asnLines.createdAt), asc(asnLines.id));
  const announcedMilli = lineRows.reduce((total, line) => total + line.announcedQty, 0);
  const receivedMilli = lineRows.reduce((total, line) => total + line.receivedQty, 0);
  return {
    id: asn.id,
    code: asn.asnCode,
    clientId: asn.clientId,
    status: asn.status as AsnStatus,
    expectedAt: asn.expectedAt === null ? null : canonicalInstant(asn.expectedAt),
    lineCount: lineRows.length,
    linesComplete: lineRows.filter((line) => line.receivedQty >= line.announcedQty).length,
    announcedTotal: fromMilli(announcedMilli),
    receivedTotal: fromMilli(receivedMilli),
    createdAt: canonicalInstant(asn.createdAt),
    warehouseId: asn.warehouseId,
    statusNote: asn.statusNote,
    updatedAt: canonicalInstant(asn.updatedAt),
    lines: lineRows.map(asnLineSnapshot),
  };
}

/** `expectedAt`: absent/null pass through; a string must be a Z-suffixed UTC instant (400). */
function normalizedExpectedAt(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  try {
    return assertUtcIso(value);
  } catch {
    throw asnValidation(`expectedAt must be a Z-suffixed ISO-8601 UTC timestamp (got "${value}").`);
  }
}

/** A close / cancel note: trimmed, 1–500 code points (400 otherwise). */
export function normalizedAsnNote(note: string): string {
  const trimmed = typeof note === 'string' ? note.trim() : '';
  const length = [...trimmed].length;
  if (length === 0 || length > MAX_ASN_NOTE_CODE_POINTS) {
    throw asnValidation(`A note of 1–${MAX_ASN_NOTE_CODE_POINTS} characters is required (got ${length}).`);
  }
  return trimmed;
}

/** The code, counted in CODE POINTS — the unit of 0064's `char_length` CHECK (400 otherwise). */
function assertAsnCodeShape(asnCode: string): void {
  const codePoints = [...asnCode].length;
  if (codePoints === 0 || codePoints > MAX_ASN_CODE_LENGTH) {
    throw asnValidation(`asnCode must be 1–${MAX_ASN_CODE_LENGTH} characters (got ${codePoints}).`);
  }
}

function assertLineShape(lines: readonly AsnLineInput[]): void {
  if (lines.length === 0) {
    throw asnValidation('An advance shipment notice needs at least one line.');
  }
  if (lines.length > MAX_ASN_LINES) {
    throw asnValidation(`An advance shipment notice carries at most ${MAX_ASN_LINES} lines (got ${lines.length}).`);
  }
}

/** The operator commands' response and stored snapshot: `{asn}`. */
function operatorSnapshot(_tx: TenantTx, asn: AsnDetail): AsnSnapshot {
  return { asn };
}

// ── the commands ─────────────────────────────────────────────────────────────

/**
 * Story 21-6 — the advance shipment notice lifecycle: create, amend, close
 * (short) and cancel, each on the house skeleton — hash → permission
 * (`asn.manage`) → the portal refusal → replay → validate → lock → write →
 * outbox (`asn.created | amended | closed | cancelled`) → audit → key.
 *
 * The ASN mirrors the PO deliberately (receiving books against either in one
 * `grn.submit`) but owns its lifecycle: the three receipt states are derived
 * from the lines (`deriveAsnStatusInTx`), `closed` and `cancelled` are the
 * explicit terminals. The client is EXPLICIT on create and checked against
 * the lines' SKUs; the warehouse is fixed at create. SKUs are read without a
 * lock (the PO amend precedent): receiving locks SKU → ASN, and these
 * commands lock only the ASN, so the two never cross.
 */
@Injectable()
export class AsnCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    // Story 21-7b — the kit lookup for the portal announce (catalog owns
    // `kit_compositions`; the receiving command's facade seam).
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  async create(command: CreateAsnCommand, idempotencyKey: string): Promise<AsnSnapshot> {
    const asnCode = command.asnCode.trim();
    const expectedAt = normalizedExpectedAt(command.expectedAt) ?? null;
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      clientId: command.clientId,
      warehouseId: command.warehouseId,
      asnCode,
      expectedAt,
      lines: command.lines.map((line) => ({ skuId: line.skuId, announcedQty: line.announcedQty })),
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      await this.assertAuthority(tx, command.tenantId, command.actorUserId);
      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return replay as AsnSnapshot;
      }

      // Behind authority and replay (an unauthorised caller learns nothing;
      // a committed op re-serves). The code is counted in CODE POINTS — the
      // unit of 0064's `char_length` CHECK.
      assertAsnCodeShape(asnCode);
      assertLineShape(command.lines);

      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      const client = await assertClientInTenantInTx(tx, command.tenantId, command.clientId);
      const skuFacts = await this.readSkus(tx, command.tenantId, command.lines.map((line) => line.skuId));
      const derived = await assertSingleClientInTx(
        tx,
        command.tenantId,
        [...skuFacts.values()].map((sku) => sku.clientId),
        `Advance shipment notice "${asnCode}"`,
      );
      if (derived !== command.clientId) {
        const labels = await getClientLabelsInTx(tx, command.tenantId, [command.clientId, derived]);
        throw skuClientMismatch(
          `Advance shipment notice "${asnCode}"`,
          labels.get(command.clientId) ?? command.clientId,
          [labels.get(derived) ?? derived],
        );
      }
      const lines = this.scaleLines(command.lines, skuFacts);

      const asnId = await this.insertAsn(tx, {
        tenantId: command.tenantId,
        clientId: command.clientId,
        clientCode: client.code,
        warehouseId: command.warehouseId,
        asnCode,
        expectedAt,
        lines,
      });

      return this.finish(tx, command.tenantId, command.actorUserId, asnId, 'asn.created', idempotencyKey, payloadHash, operatorSnapshot);
    });
  }

  /**
   * Story 21-7b — the portal's first write: a client user announces its OWN
   * inbound shipment. A separate command on the same tables (never a flag
   * on `create`): the client comes from the portal session, the SKUs are
   * read FILTERED by it, the fingerprint carries `surface: 'portal'`, and
   * the stored snapshot is the portal's `PortalAsnDetail`. The result is an
   * ordinary ASN — operators, the device snapshot and receiving see it
   * exactly as one an operator keyed.
   *
   * Two layers (21-7): the transaction is stamped `{ clientId }` (the
   * header's WITH CHECK requires `client_id = app.client_id`), and every
   * read carries the explicit client predicate. It does NOT share
   * `assertAuthority` (`asn.manage` + the portal refusal stay the operator
   * path's, untouched): authority is `asn.announce`, then the actor and its
   * client are re-read IN THIS transaction — the guard's re-read ran in
   * another one, and on a write the window between them matters (a
   * suspended brand's in-flight request must not commit).
   *
   * Order: hash → authority (capability, then the user — not active 401,
   * another client 403 — then the client — not active 403
   * `client-suspended`) → replay → code and line shape → warehouse in
   * tenant (404) → the client's SKUs (404, never confirming another
   * client's) → kits (409) → scale → insert (409 `duplicate-asn-code`) →
   * outbox `asn.created` / audit (actor = the client user) / key. `mixed-
   * client` and `sku-client-mismatch` are unreachable by construction.
   */
  async announce(command: AnnounceAsnCommand, idempotencyKey: string): Promise<PortalAsnDetail> {
    const asnCode = command.asnCode.trim();
    const expectedAt = normalizedExpectedAt(command.expectedAt) ?? null;
    // The portal fingerprint: `surface` FIRST, so an identical payload can
    // never replay the operator surface's snapshot under a shared key
    // (`idempotency_keys` is unique on (tenant_id, key) across surfaces).
    // Key order is fixed — pinned by a golden in test/portal-asn.spec.ts.
    const payloadHash = hashCommandPayload({
      surface: 'portal',
      tenantId: command.tenantId,
      clientId: command.clientId,
      warehouseId: command.warehouseId,
      asnCode,
      expectedAt,
      lines: command.lines.map(({ skuId, announcedQty }) => ({ skuId, announcedQty })),
    });

    return withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx) => {
        assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'asn.announce');
        const actor = await getMemberPortalFactsIn(tx, command.tenantId, command.actorUserId);
        if (actor === null || actor.status !== 'active') {
          throw new ProblemException(
            'unauthenticated',
            401,
            'Authentication required',
            'The session no longer describes an active client-portal user — sign in again.',
          );
        }
        if (actor.clientId !== command.clientId) {
          throw new ProblemException(
            'role-denied',
            403,
            'Role lacks the required capability',
            'Only a client-portal user of this client may announce its shipments.',
          );
        }
        const client = await getClientStatusInTx(tx, command.tenantId, command.clientId);
        if (client.status !== 'active') {
          throw clientSuspended();
        }

        const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replay !== null) {
          return replay as PortalAsnDetail;
        }

        assertAsnCodeShape(asnCode);
        assertLineShape(command.lines);

        await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
        const skuFacts = await this.readClientSkus(
          tx,
          command.tenantId,
          command.clientId,
          command.lines.map((line) => line.skuId),
        );
        // FR-38: receiving refuses a kit line, so a kit announced here could
        // never be received (`portal/skus` never lists one either).
        const kitSkuIds = await this.catalog.getKitSkuIdsInTx(
          tx,
          command.tenantId,
          command.lines.map((line) => line.skuId),
        );
        if (kitSkuIds.length > 0) {
          throw kitCannotHoldStock(
            'Advance shipment notice line',
            [...new Set(kitSkuIds)].map((skuId) => skuFacts.get(skuId)!.code),
          );
        }
        const lines = this.scaleLines(command.lines, skuFacts);

        const asnId = await this.insertAsn(tx, {
          tenantId: command.tenantId,
          clientId: command.clientId,
          clientCode: client.code,
          warehouseId: command.warehouseId,
          asnCode,
          expectedAt,
          lines,
        });

        return this.finish(
          tx,
          command.tenantId,
          command.actorUserId,
          asnId,
          'asn.created',
          idempotencyKey,
          payloadHash,
          async (inner) => (await portalAsnInTx(inner, command.tenantId, command.clientId, asnId))!,
        );
      },
      { clientId: command.clientId },
    );
  }

  async amend(command: AmendAsnCommand, idempotencyKey: string): Promise<AsnSnapshot> {
    const expectedAt = normalizedExpectedAt(command.expectedAt);
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      asnId: command.asnId,
      // Absent → unchanged (dropped by JSON); null → cleared (kept).
      expectedAt,
      lines: command.lines.map((line) => ({ id: line.id, skuId: line.skuId, announcedQty: line.announcedQty })),
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      await this.assertAuthority(tx, command.tenantId, command.actorUserId);
      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return replay as AsnSnapshot;
      }
      assertLineShape(command.lines);

      const asn = await this.lockAsn(tx, command.tenantId, command.asnId);
      if (!OPEN_ASN_STATUSES.includes(asn.status as AsnStatus)) {
        throw asnNotOpen(asn.asnCode, asn.status);
      }

      const existing = await tx
        .select()
        .from(asnLines)
        .where(eq(asnLines.asnId, asn.id))
        .orderBy(asc(asnLines.createdAt), asc(asnLines.id));
      const existingById = new Map(existing.map((line) => [line.id, line]));
      const seen = new Set<string>();
      for (const line of command.lines) {
        if (line.id === undefined) continue;
        if (seen.has(line.id)) {
          throw asnValidation(`Line "${line.id}" appears more than once in the amend's line set.`);
        }
        seen.add(line.id);
        if (!existingById.has(line.id)) {
          throw new ProblemException(
            'not-found',
            404,
            'ASN line not found',
            `No line with id "${line.id}" exists on advance shipment notice "${asn.asnCode}".`,
          );
        }
      }

      const skuFacts = await this.readSkus(tx, command.tenantId, command.lines.map((line) => line.skuId));
      const foreign = [...new Set([...skuFacts.values()].map((sku) => sku.clientId))].filter(
        (clientId) => clientId !== asn.clientId,
      );
      if (foreign.length > 0) {
        const labels = await getClientLabelsInTx(tx, command.tenantId, [asn.clientId, ...foreign]);
        throw skuClientMismatch(
          `Advance shipment notice "${asn.asnCode}"`,
          labels.get(asn.clientId) ?? asn.clientId,
          foreign.map((clientId) => labels.get(clientId) ?? clientId),
        );
      }
      const lines = this.scaleLines(command.lines, skuFacts);

      // A line that has received anything keeps its history: it may not be
      // deleted, change SKU, or announce less than it already received.
      const requested = new Map(lines.filter((line) => line.id !== undefined).map((line) => [line.id!, line]));
      for (const line of existing) {
        if (line.receivedQty <= 0) continue;
        const next = requested.get(line.id);
        if (next === undefined) {
          throw asnLineReceived(asn.asnCode, line.id, `has received ${fromMilli(line.receivedQty)} — it cannot be removed.`);
        }
        if (next.skuId !== line.skuId) {
          throw asnLineReceived(asn.asnCode, line.id, `has received ${fromMilli(line.receivedQty)} — its SKU cannot change.`);
        }
        // Only a LOWERED quantity that ends below received refuses: after an
        // approved over-receipt received exceeds announced, and resending the
        // line unchanged (the web form pre-fills it) must still amend.
        if (next.announcedQty < line.announcedQty && next.announcedQty < line.receivedQty) {
          throw asnLineReceived(
            asn.asnCode,
            line.id,
            `has received ${fromMilli(line.receivedQty)} — it cannot announce less (got ${fromMilli(next.announcedQty)}).`,
          );
        }
      }

      const removed = existing.filter((line) => !requested.has(line.id)).map((line) => line.id);
      if (removed.length > 0) {
        await tx.delete(asnLines).where(inArray(asnLines.id, removed));
      }
      const now = nowIso();
      for (const line of lines) {
        if (line.id === undefined) continue;
        await tx
          .update(asnLines)
          .set({ skuId: line.skuId, announcedQty: line.announcedQty, updatedAt: now })
          .where(eq(asnLines.id, line.id));
      }
      const added = lines.filter((line) => line.id === undefined);
      if (added.length > 0) {
        await tx.insert(asnLines).values(
          added.map((line) => ({
            id: uuidv7(),
            tenantId: command.tenantId,
            asnId: asn.id,
            skuId: line.skuId,
            announcedQty: line.announcedQty,
            receivedQty: 0,
          })),
        );
      }
      await tx
        .update(advanceShipmentNotices)
        .set({ ...(expectedAt === undefined ? {} : { expectedAt }), updatedAt: now })
        .where(eq(advanceShipmentNotices.id, asn.id));
      // Amending can complete an ASN (an announced quantity lowered to what
      // was received) or reopen nothing: the status follows the lines.
      await deriveAsnStatusInTx(tx, command.tenantId, asn.id);

      return this.finish(tx, command.tenantId, command.actorUserId, asn.id, 'asn.amended', idempotencyKey, payloadHash, operatorSnapshot);
    });
  }

  /** Close (short, from `partially_received`) or cancel (from `announced`) — terminal, with a note. */
  async transition(command: TransitionAsnCommand, idempotencyKey: string): Promise<AsnSnapshot> {
    const note = normalizedAsnNote(command.note);
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      asnId: command.asnId,
      transition: command.transition,
      note,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      await this.assertAuthority(tx, command.tenantId, command.actorUserId);
      const replay = await this.replay(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replay !== null) {
        return replay as AsnSnapshot;
      }

      const asn = await this.lockAsn(tx, command.tenantId, command.asnId);
      if (asn.status !== ASN_TRANSITIONS[command.transition]) {
        throw asnTransitionInvalid(asn.asnCode, asn.status, command.transition);
      }
      // A receipt that credited no line (all unmatched or rejected) leaves
      // the ASN `announced` — but goods were received against it, so it may
      // not be cancelled as if nothing came: close it short instead.
      if (command.transition === 'cancel') {
        const receipts = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(goodsReceiptNotes)
          .where(and(eq(goodsReceiptNotes.tenantId, command.tenantId), eq(goodsReceiptNotes.asnId, asn.id)));
        const n = Number(receipts[0]?.n ?? 0);
        if (n > 0) {
          throw new ProblemException(
            'asn-has-receipts',
            409,
            'Advance shipment notice has receipts',
            `Advance shipment notice "${asn.asnCode}" has ${n} goods receipt(s) recorded against it — it cannot be cancelled as if nothing arrived.`,
          );
        }
      }
      // Decision 3: never close past an undecided excess (under the ASN lock).
      await assertNoPendingOverReceiptsInTx(
        tx,
        command.tenantId,
        { asnId: asn.id },
        `Advance shipment notice "${asn.asnCode}"`,
      );
      const status: AsnStatus = command.transition === 'close' ? 'closed' : 'cancelled';
      const updated = await tx
        .update(advanceShipmentNotices)
        .set({ status, statusNote: note, updatedAt: nowIso() })
        .where(and(eq(advanceShipmentNotices.id, asn.id), eq(advanceShipmentNotices.status, asn.status)))
        .returning({ id: advanceShipmentNotices.id });
      if (updated.length !== 1) {
        throw asnTransitionInvalid(asn.asnCode, asn.status, command.transition);
      }

      return this.finish(
        tx,
        command.tenantId,
        command.actorUserId,
        asn.id,
        command.transition === 'close' ? 'asn.closed' : 'asn.cancelled',
        idempotencyKey,
        payloadHash,
        operatorSnapshot,
      );
    });
  }

  // ── shared pieces ─────────────────────────────────────────────────────────

  /** `asn.manage` (fresh DB role read), then the portal refusal — both before replay. */
  private async assertAuthority(tx: TenantTx, tenantId: string, actorUserId: string): Promise<void> {
    assertPermission(await getMemberRoleIn(tx, tenantId, actorUserId), 'asn.manage');
    if ((await getMemberClientIdIn(tx, tenantId, actorUserId)) !== null) {
      throw asnPortalRefused();
    }
  }

  /**
   * Snapshot → outbox → audit → idempotency key (the skeleton's tail). The
   * outbox payload is ALWAYS the operator `{asn}` (one event shape whoever
   * raised the ASN); `snapshotOf` builds the surface's own response — the
   * stored idempotency snapshot — on the same transaction: `{asn}` for the
   * operator commands (`operatorSnapshot`), the `PortalAsnDetail` for the
   * portal announce.
   */
  private async finish<S>(
    tx: TenantTx,
    tenantId: string,
    actorUserId: string,
    asnId: string,
    event: 'asn.created' | 'asn.amended' | 'asn.closed' | 'asn.cancelled',
    idempotencyKey: string,
    payloadHash: string,
    snapshotOf: (tx: TenantTx, asn: AsnDetail) => S | Promise<S>,
  ): Promise<S> {
    const asn = (await readAsnInTx(tx, tenantId, asnId))!;
    const snapshot = await snapshotOf(tx, asn);
    const at = nowIso();
    await this.outbox.append(tx, {
      messageId: uuidv7(),
      tenantId,
      type: event,
      occurredAt: at,
      payload: { asn },
    });
    await tx.insert(auditEvents).values({
      id: uuidv7(),
      tenantId,
      actorUserId,
      action: event,
      targetType: 'advance_shipment_notice',
      targetId: asnId,
      reference: idempotencyKey,
      occurredAt: at,
    });
    await this.writeIdempotencyKey(tx, tenantId, idempotencyKey, payloadHash, snapshot);
    return snapshot;
  }

  private async lockAsn(tx: TenantTx, tenantId: string, asnId: string): Promise<typeof advanceShipmentNotices.$inferSelect> {
    const rows = await tx
      .select()
      .from(advanceShipmentNotices)
      .where(and(eq(advanceShipmentNotices.tenantId, tenantId), eq(advanceShipmentNotices.id, asnId)))
      .limit(1)
      .for('update');
    const asn = rows[0];
    if (asn === undefined) {
      throw asnNotFound(asnId);
    }
    return asn;
  }

  /** Every line's SKU in the tenant (404 naming the unknown id) — unit and client; NO lock. */
  private async readSkus(
    tx: TenantTx,
    tenantId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, { uom: string; clientId: string }>> {
    const distinct = [...new Set(skuIds)];
    const rows = await tx
      .select({ id: skus.id, uom: skus.uom, clientId: skus.clientId })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, distinct)));
    const byId = new Map(rows.map((row) => [row.id, { uom: row.uom, clientId: row.clientId }]));
    for (const skuId of distinct) {
      if (!byId.has(skuId)) {
        throw new ProblemException('not-found', 404, 'SKU not found', `No SKU with id "${skuId}" exists in this tenant.`);
      }
    }
    return byId;
  }

  /**
   * Story 21-7b — the portal's SKU read: every line's SKU in the tenant AND
   * of THIS client (the explicit predicate; the stamped transaction's RLS
   * filters `skus` a second time). An unknown id and another client's SKU
   * are the SAME 404 — another client's SKU is never confirmed to exist.
   * Unit and code; NO lock (the PO amend precedent).
   */
  private async readClientSkus(
    tx: TenantTx,
    tenantId: string,
    clientId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, { uom: string; code: string }>> {
    const distinct = [...new Set(skuIds)];
    const rows = await tx
      .select({ id: skus.id, uom: skus.uom, code: skus.code })
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), eq(skus.clientId, clientId), inArray(skus.id, distinct)));
    const byId = new Map(rows.map((row) => [row.id, { uom: row.uom, code: row.code }]));
    for (const skuId of distinct) {
      if (!byId.has(skuId)) {
        throw new ProblemException('not-found', 404, 'SKU not found', `No SKU with id "${skuId}" exists for this client.`);
      }
    }
    return byId;
  }

  /**
   * The one insert path (create and announce): the header — a duplicate
   * code for the client is 409 `duplicate-asn-code` (the unique index is
   * the arbiter) — then its lines (milli-units, nothing received).
   */
  private async insertAsn(
    tx: TenantTx,
    asn: {
      readonly tenantId: string;
      readonly clientId: string;
      readonly clientCode: string;
      readonly warehouseId: string;
      readonly asnCode: string;
      readonly expectedAt: string | null;
      readonly lines: readonly AsnLineInput[];
    },
  ): Promise<string> {
    // Read before the insert: a unique violation aborts the transaction,
    // so the refusal's label cannot be fetched after it.
    const clientLabels = await getClientLabelsInTx(tx, asn.tenantId, [asn.clientId]);
    const asnId = uuidv7();
    try {
      await tx.insert(advanceShipmentNotices).values({
        id: asnId,
        tenantId: asn.tenantId,
        clientId: asn.clientId,
        warehouseId: asn.warehouseId,
        asnCode: asn.asnCode,
        status: 'announced',
        expectedAt: asn.expectedAt,
        statusNote: null,
      });
    } catch (err) {
      if (isUniqueViolationOn(err, ASN_TENANT_CLIENT_CODE)) {
        throw duplicateAsnCode(asn.asnCode, clientLabels.get(asn.clientId) ?? asn.clientCode);
      }
      throw err;
    }
    await tx.insert(asnLines).values(
      asn.lines.map((line) => ({
        id: uuidv7(),
        tenantId: asn.tenantId,
        asnId,
        skuId: line.skuId,
        announcedQty: line.announcedQty,
        receivedQty: 0,
      })),
    );
    return asnId;
  }

  /** Base → milli with the precision refusal, behind the replay lookup (story 10.2). */
  private scaleLines<T extends AsnLineInput>(
    lines: readonly T[],
    skuFacts: ReadonlyMap<string, { uom: string }>,
  ): T[] {
    return lines.map((line) => {
      const uom = skuFacts.get(line.skuId)!.uom;
      return {
        ...line,
        announcedQty: assertRecordableQuantity(line.announcedQty, 'announcedQty', uom, uomPrecision(uom)),
      };
    });
  }

  private async replay(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<unknown | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    if (row.payloadHash !== payloadHash) {
      throw idempotencyKeyReuse();
    }
    return row.responseSnapshot;
  }

  private async writeIdempotencyKey(
    tx: TenantTx,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: unknown,
  ): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({
        id: uuidv7(),
        tenantId,
        key: idempotencyKey,
        payloadHash,
        responseSnapshot: snapshot,
      });
    } catch (err) {
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        throw new ProblemException(
          'conflict',
          409,
          'Concurrent idempotent request',
          'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
        );
      }
      throw err;
    }
  }
}
