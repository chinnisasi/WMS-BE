import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  auditEvents,
  ewayBills,
  ewayGstinSettings,
  ewayStateThresholds,
  gstStateCodes,
  idempotencyKeys,
  type EwayBill,
  type EwayGstinSetting,
  type EwayStateThreshold,
} from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { canonicalInstant, nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertPermission, type Capability } from '../tenancy/permissions';
import { getMemberRoleIn, tenantGstinsInTx } from '../tenancy/tenancy.service';
import { assertGstinParam } from './hsn-summary';
import {
  bulkFile,
  ewbBillObject,
  isIsoDate,
  normalizePartB,
  partBContext,
  partBProblems,
  type EwayBlocker,
  type EwayPartB,
  type EwbBillObject,
  type EwbBulkFile,
} from './eway-json';
import {
  EWAY_GATEWAY,
  EwayGatewayRefusal,
  EwayGatewayUnavailable,
  gatewayUnconfigured,
  type EwayGateway,
  type EwayGenerateResult,
} from './eway-gateway';
import {
  blockersFor,
  claimLive,
  invoiceFacts,
  partBOf,
  toEwayBillView,
  viewContextInTx,
  type EwayBillSnapshot,
  type EwayViewContext,
} from './eway-view';

/**
 * The e-way bill commands (story 8-2b) on the house skeleton: payload hash
 * over the NORMALISED body (fixed key order, a `kind` discriminator) →
 * authority (`eway.manage` / `eway.configure`, re-read from the DB) →
 * replay → lock → replay under the lock → guards → write → audit row per
 * bill → idempotency key LAST. Cheap request-shape checks run above the
 * transaction (a malformed request answers 400, never a replay).
 *
 * `generate` is the one command that calls out: it claims the bill in one
 * transaction, calls the gateway OUTSIDE any transaction, and settles in a
 * second one with a conditional write. The claim makes record/dismiss (and a
 * second generate) refuse while a call may be in flight; it expires after
 * `GATEWAY_CLAIM_TTL_MS`.
 */

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const EWB_NO_UNIQUE = 'eway_bills_tenant_ewb_no_unique';

/** `record`'s future tolerance on `generatedAt` (clock skew between NIC and here). */
const RECORD_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const EXPORT_MAX_BILLS = 100;
export const DISMISS_REASON_MAX = 200;
export const EWB_NO_RE = /^[0-9]{12}$/;
const STATE_CODE_RE = /^[0-9]{2}$/;
/** Place-of-supply codes NIC cannot take as a domestic bill-from state (Other Territory, Other Country). */
const UNSUPPORTED_STATE_CODES: ReadonlySet<string> = new Set(['97', '99']);

/** The reasons an export (or generate) refuses a bill — blocker codes plus these. */
export const EXPORT_REFUSAL_REASONS = ['not-found', 'not-pending', 'claimed', 'mixed-gstin'] as const;

// ── inputs ──────────────────────────────────────────────────────────────────

interface Actor {
  readonly tenantId: string;
  readonly actorUserId: string;
}

export interface UpdateTransportCommand extends Actor {
  readonly billId: string;
  readonly transport: Partial<Record<keyof EwayPartB, unknown>>;
}

export interface RecordEwbCommand extends Actor {
  readonly billId: string;
  readonly ewbNo: string;
  readonly generatedAt: string;
  readonly validUntil?: string | null | undefined;
}

export interface DismissEwayCommand extends Actor {
  readonly billId: string;
  readonly reason: string;
}

export interface ExportEwayCommand extends Actor {
  readonly ids: readonly string[];
}

export interface GenerateEwayCommand extends Actor {
  readonly billId: string;
}

export interface AppendStateThresholdCommand extends Actor {
  readonly stateCode: string;
  readonly thresholdPaise: number | null;
  readonly effectiveFrom: string;
}

export interface PutGstinSettingCommand extends Actor {
  readonly gstin: string;
  readonly eInvoiceApplies: boolean;
}

// ── outputs ─────────────────────────────────────────────────────────────────

export interface EwayExportSnapshot {
  readonly file: EwbBulkFile;
}

export interface EwayStateThresholdView {
  readonly id: string;
  readonly stateCode: string;
  readonly thresholdPaise: number | null;
  readonly effectiveFrom: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface EwayStateThresholdSnapshot {
  readonly threshold: EwayStateThresholdView;
}

export interface EwayGstinSettingView {
  readonly gstin: string;
  readonly eInvoiceApplies: boolean;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

export interface EwayGstinSettingSnapshot {
  readonly setting: EwayGstinSettingView;
}

export function toStateThresholdView(row: EwayStateThreshold): EwayStateThresholdView {
  return {
    id: row.id,
    stateCode: row.stateCode,
    thresholdPaise: row.thresholdPaise === null ? null : Number(row.thresholdPaise),
    effectiveFrom: row.effectiveFrom,
    createdBy: row.createdBy,
    createdAt: canonicalInstant(row.createdAt),
  };
}

export function toGstinSettingView(row: EwayGstinSetting): EwayGstinSettingView {
  return {
    gstin: row.gstin,
    eInvoiceApplies: row.eInvoiceApplies,
    updatedBy: row.updatedBy,
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

// ── refusals ────────────────────────────────────────────────────────────────

function invalid(title: string, detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, title, detail);
}

function billNotFound(): ProblemException {
  return new ProblemException('not-found', 404, 'E-way bill not found', 'No e-way bill with this id exists in this tenant.');
}

function notPending(status: string): ProblemException {
  return new ProblemException(
    'eway-not-pending',
    409,
    'E-way bill is not pending',
    `This e-way bill is ${status} — only a pending bill can be changed, exported, recorded, dismissed or generated.`,
  );
}

function claimed(): ProblemException {
  return new ProblemException(
    'eway-claimed',
    409,
    'E-way bill is being generated',
    'A gateway generation for this bill is in flight (claimed under two minutes ago) — wait for it to settle, then refresh.',
  );
}

export interface ExportRefusal {
  readonly id: string;
  readonly reasons: readonly string[];
}

function notExportable(refusals: readonly ExportRefusal[]): ProblemException {
  return new ProblemException(
    'eway-not-exportable',
    409,
    'E-way bills cannot be exported',
    `Refused: ${refusals.map((r) => `${r.id} (${r.reasons.join(', ')})`).join('; ')}. Nothing was exported.`,
    { bills: refusals.map((r) => ({ id: r.id, reasons: [...r.reasons] })) },
  );
}

function ewbNoTaken(ewbNo: string): ProblemException {
  return new ProblemException(
    'ewb-no-taken',
    409,
    'EWB number already recorded',
    `EWB number ${ewbNo} is already recorded on another e-way bill in this tenant.`,
  );
}

function concurrentKey(): ProblemException {
  return new ProblemException(
    'conflict',
    409,
    'Concurrent idempotent request',
    'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
  );
}

function assertUuid(value: string, name: string): void {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw invalid(`${name} must be a uuid`, `The "${name}" parameter must be a uuid (got "${String(value)}").`);
  }
}

function isUtcInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

@Injectable()
export class EwayCommand {
  private readonly logger = new Logger(EwayCommand.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EWAY_GATEWAY) private readonly gateway: EwayGateway,
  ) {}

  // ── Part B ────────────────────────────────────────────────────────────────

  async updateTransport(command: UpdateTransportCommand, key: string): Promise<EwayBillSnapshot> {
    assertUuid(command.billId, 'billId');
    const transport = normalizePartB(command.transport);
    const payloadHash = hashCommandPayload({ kind: 'eway.transport', billId: command.billId, transport });
    return this.billMutation(command, key, payloadHash, 'eway.manage', 'eway.transport_updated', async (tx, row, ctx) => {
      const invoice = ctx.invoices.get(row.invoiceId);
      const facts = invoice === undefined ? null : invoiceFacts(invoice);
      if (facts === null) throw notExportable([{ id: row.id, reasons: ['invoice-unavailable'] }]);
      const problems = partBProblems(transport, partBContext(facts));
      if (problems.length > 0) {
        throw invalid('Invalid transport details', problems.join('; '));
      }
      const updated = await tx
        .update(ewayBills)
        .set({ ...transport, updatedAt: nowIso() })
        .where(eq(ewayBills.id, row.id))
        .returning();
      return updated[0]!;
    });
  }

  // ── record a number ──────────────────────────────────────────────────────

  async record(command: RecordEwbCommand, key: string): Promise<EwayBillSnapshot> {
    assertUuid(command.billId, 'billId');
    const ewbNo = typeof command.ewbNo === 'string' ? command.ewbNo.trim() : '';
    if (!EWB_NO_RE.test(ewbNo)) {
      throw invalid('Invalid EWB number', `ewbNo must be exactly 12 digits (got "${String(command.ewbNo)}").`);
    }
    if (!isUtcInstant(command.generatedAt)) {
      throw invalid('Invalid generatedAt', `generatedAt must be an ISO-8601 UTC instant (got "${String(command.generatedAt)}").`);
    }
    const validUntil = command.validUntil ?? null;
    if (validUntil !== null) {
      if (!isUtcInstant(validUntil)) {
        throw invalid('Invalid validUntil', `validUntil must be an ISO-8601 UTC instant (got "${String(validUntil)}").`);
      }
      if (Date.parse(validUntil) < Date.parse(command.generatedAt)) {
        throw invalid('Invalid validUntil', `validUntil ${validUntil} is before generatedAt ${command.generatedAt}.`);
      }
    }
    const generatedAt = canonicalInstant(command.generatedAt);
    const payloadHash = hashCommandPayload({
      kind: 'eway.record',
      billId: command.billId,
      ewbNo,
      generatedAt,
      validUntil: validUntil === null ? null : canonicalInstant(validUntil),
    });
    return this.billMutation(command, key, payloadHash, 'eway.manage', 'eway.recorded', async (tx, row, ctx) => {
      const issuedAt = ctx.invoices.get(row.invoiceId)?.issuedAt ?? null;
      const now = Date.now();
      if (issuedAt !== null && Date.parse(generatedAt) < Date.parse(canonicalInstant(issuedAt))) {
        throw invalid('Invalid generatedAt', `generatedAt ${generatedAt} is before the invoice was issued (${canonicalInstant(issuedAt)}).`);
      }
      if (Date.parse(generatedAt) > now + RECORD_FUTURE_TOLERANCE_MS) {
        throw invalid('Invalid generatedAt', `generatedAt ${generatedAt} is in the future.`);
      }
      const taken = await tx
        .select({ id: ewayBills.id })
        .from(ewayBills)
        .where(and(eq(ewayBills.tenantId, command.tenantId), eq(ewayBills.ewbNo, ewbNo)))
        .limit(1);
      if (taken[0] !== undefined) throw ewbNoTaken(ewbNo);
      try {
        const updated = await tx
          .update(ewayBills)
          .set({
            status: 'generated',
            ewbNo,
            ewbGeneratedAt: generatedAt,
            ewbValidUntil: validUntil === null ? null : canonicalInstant(validUntil),
            source: 'manual',
            lastError: null,
            updatedAt: nowIso(),
          })
          .where(and(eq(ewayBills.id, row.id), eq(ewayBills.status, 'pending')))
          .returning();
        return updated[0]!;
      } catch (err) {
        if (isUniqueViolationOn(err, EWB_NO_UNIQUE)) throw ewbNoTaken(ewbNo);
        throw err;
      }
    });
  }

  // ── dismiss ───────────────────────────────────────────────────────────────

  async dismiss(command: DismissEwayCommand, key: string): Promise<EwayBillSnapshot> {
    assertUuid(command.billId, 'billId');
    const reason = typeof command.reason === 'string' ? command.reason.trim() : '';
    if (reason.length < 1 || reason.length > DISMISS_REASON_MAX) {
      throw invalid('Invalid dismiss reason', `reason must be 1–${DISMISS_REASON_MAX} characters after trimming.`);
    }
    const payloadHash = hashCommandPayload({ kind: 'eway.dismiss', billId: command.billId, reason });
    return this.billMutation(command, key, payloadHash, 'eway.manage', 'eway.dismissed', async (tx, row) => {
      const updated = await tx
        .update(ewayBills)
        .set({ status: 'dismissed', dismissedReason: reason, updatedAt: nowIso() })
        .where(and(eq(ewayBills.id, row.id), eq(ewayBills.status, 'pending')))
        .returning();
      return updated[0]!;
    });
  }

  /**
   * The single-bill skeleton: permission → replay → lock → replay under the
   * lock → pending and unclaimed → `write` → audit → key.
   */
  private async billMutation(
    command: Actor & { billId: string },
    key: string,
    payloadHash: string,
    capability: Capability,
    action: string,
    write: (tx: TenantTx, row: EwayBill, ctx: EwayViewContext) => Promise<EwayBill>,
  ): Promise<EwayBillSnapshot> {
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), capability);
      const replayed = await replay<EwayBillSnapshot>(tx, command.tenantId, key, payloadHash);
      if (replayed !== null) return replayed;

      const row = await lockBill(tx, command.tenantId, command.billId);
      const replayedUnderLock = await replay<EwayBillSnapshot>(tx, command.tenantId, key, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (row.status !== 'pending') throw notPending(row.status);
      if (claimLive(row)) throw claimed();

      const ctx = await viewContextInTx(tx, command.tenantId, [row], this.gateway);
      const updated = await write(tx, row, ctx);
      await audit(tx, command, action, 'eway_bill', updated.id, key);
      const snapshot: EwayBillSnapshot = { bill: toEwayBillView(updated, ctx) };
      await settleKey(tx, command.tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── export ────────────────────────────────────────────────────────────────

  async export(command: ExportEwayCommand, key: string): Promise<EwayExportSnapshot> {
    const ids = command.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > EXPORT_MAX_BILLS) {
      throw invalid('Invalid export', `ids must list 1–${EXPORT_MAX_BILLS} e-way bill ids.`);
    }
    for (const id of ids) assertUuid(id, 'ids[]');
    // Stored ids are lowercase: normalise BEFORE the dedupe, the sort and the hash.
    const lowered = ids.map((id) => id.toLowerCase());
    if (new Set(lowered).size !== lowered.length) {
      throw invalid('Invalid export', 'ids must not repeat an e-way bill id.');
    }
    const sorted = [...lowered].sort();
    const payloadHash = hashCommandPayload({ kind: 'eway.export', ids: sorted });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'eway.manage');
      const replayed = await replay<EwayExportSnapshot>(tx, command.tenantId, key, payloadHash);
      if (replayed !== null) return replayed;

      // Locked in id order (one lock family, sorted — deadlock-free).
      const rows = await tx
        .select()
        .from(ewayBills)
        .where(and(eq(ewayBills.tenantId, command.tenantId), inArray(ewayBills.id, sorted)))
        .orderBy(asc(ewayBills.id))
        .for('update');
      const replayedUnderLock = await replay<EwayExportSnapshot>(tx, command.tenantId, key, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;

      const byId = new Map(rows.map((row) => [row.id, row]));
      const ctx = await viewContextInTx(tx, command.tenantId, rows, this.gateway);
      const referenceGstin = dominantGstin(rows);
      const refusals: ExportRefusal[] = [];
      for (const id of sorted) {
        const row = byId.get(id);
        if (row === undefined) {
          refusals.push({ id, reasons: ['not-found'] });
          continue;
        }
        const reasons = refusalReasons(row, ctx);
        if (row.originGstin !== referenceGstin) reasons.push('mixed-gstin');
        if (reasons.length > 0) refusals.push({ id, reasons });
      }
      if (refusals.length > 0) throw notExportable(refusals);

      const bills: EwbBillObject[] = sorted.map((id) => billObjectFor(byId.get(id)!, ctx));
      const file = bulkFile(bills);
      const stamp = nowIso();
      await tx
        .update(ewayBills)
        .set({ lastExportedAt: stamp, lastExportedBy: command.actorUserId, updatedAt: stamp })
        .where(and(eq(ewayBills.tenantId, command.tenantId), inArray(ewayBills.id, sorted)));
      for (const id of sorted) {
        await audit(tx, command, 'eway.exported', 'eway_bill', id, key);
      }
      const snapshot: EwayExportSnapshot = { file };
      await settleKey(tx, command.tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  // ── generate through the gateway ─────────────────────────────────────────

  async generate(command: GenerateEwayCommand, key: string): Promise<EwayBillSnapshot> {
    assertUuid(command.billId, 'billId');
    const payloadHash = hashCommandPayload({ kind: 'eway.generate', billId: command.billId });

    // 1–2. Claim in its own transaction (committed before the call).
    const claim = await withTenantTransaction(
      this.db,
      command.tenantId,
      async (tx): Promise<{ replayed: EwayBillSnapshot } | { bill: EwbBillObject; gstin: string }> => {
        assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'eway.manage');
        const replayed = await replay<EwayBillSnapshot>(tx, command.tenantId, key, payloadHash);
        if (replayed !== null) return { replayed };
        const row = await lockBill(tx, command.tenantId, command.billId);
        const replayedUnderLock = await replay<EwayBillSnapshot>(tx, command.tenantId, key, payloadHash);
        if (replayedUnderLock !== null) return { replayed: replayedUnderLock };
        if (row.status !== 'pending') throw notPending(row.status);
        const ctx = await viewContextInTx(tx, command.tenantId, [row], this.gateway);
        const blockers = blockersFor(row, ctx);
        if (blockers.length > 0) {
          throw notExportable([{ id: row.id, reasons: blockers.map((b) => b.code) }]);
        }
        if (!ctx.configuredGstins.has(row.originGstin)) throw gatewayUnconfigured();
        if (claimLive(row)) throw claimed();
        const bill = billObjectFor(row, ctx);
        const stamp = nowIso();
        await tx.update(ewayBills).set({ gatewayClaimedAt: stamp, updatedAt: stamp }).where(eq(ewayBills.id, row.id));
        return { bill, gstin: row.originGstin };
      },
    );
    if ('replayed' in claim) return claim.replayed;

    // 3. The call, outside any transaction.
    let result: EwayGenerateResult;
    try {
      result = await this.gateway.generate(command.tenantId, claim.gstin, { billId: command.billId, bill: claim.bill });
    } catch (err) {
      if (err instanceof EwayGatewayRefusal) {
        await this.releaseClaim(command, err.message);
        throw new ProblemException('eway-gateway-refused', 422, 'E-way gateway refused the bill', err.message);
      }
      // Unavailable — and ANY other failure, whose outcome at NIC is unknown:
      // the claim is KEPT (it expires), so a retry never races a call that
      // may still have landed.
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof EwayGatewayUnavailable)) {
        this.logger.error(`e-way generate for bill ${command.billId}: unexpected gateway failure — claim kept: ${message}`);
      }
      throw new ProblemException(
        'eway-gateway-unavailable',
        503,
        'E-way gateway unavailable',
        `The e-way gateway could not complete the call: ${message} Retry in two minutes.`,
      );
    }
    const validUntilOk =
      result.validUntil === null ||
      (isUtcInstant(result.validUntil) && Date.parse(result.validUntil) >= Date.parse(result.generatedAt));
    if (!EWB_NO_RE.test(result.ewbNo) || !isUtcInstant(result.generatedAt) || !validUntilOk) {
      await this.releaseClaim(command, `The gateway answered a malformed result (ewbNo "${result.ewbNo}").`);
      throw new ProblemException('eway-gateway-refused', 422, 'E-way gateway refused the bill', 'The gateway answered a malformed result.');
    }

    // 4. Settle in a new transaction: conditional on still pending.
    try {
      return await withTenantTransaction(this.db, command.tenantId, async (tx): Promise<EwayBillSnapshot> => {
        const stamp = nowIso();
        let updated: EwayBill[];
        try {
          updated = await tx
            .update(ewayBills)
            .set({
              status: 'generated',
              ewbNo: result.ewbNo,
              ewbGeneratedAt: canonicalInstant(result.generatedAt),
              ewbValidUntil: result.validUntil === null ? null : canonicalInstant(result.validUntil),
              source: 'gateway',
              gatewayClaimedAt: null,
              lastError: null,
              updatedAt: stamp,
            })
            .where(
              and(
                eq(ewayBills.tenantId, command.tenantId),
                eq(ewayBills.id, command.billId),
                eq(ewayBills.status, 'pending'),
              ),
            )
            .returning();
        } catch (err) {
          if (isUniqueViolationOn(err, EWB_NO_UNIQUE)) throw new LostEwbNumber('the number is taken', null);
          throw err;
        }
        const row = updated[0];
        if (row === undefined) {
          const current = await tx
            .select({ status: ewayBills.status })
            .from(ewayBills)
            .where(and(eq(ewayBills.tenantId, command.tenantId), eq(ewayBills.id, command.billId)))
            .limit(1);
          const status = current[0]?.status ?? 'gone';
          throw new LostEwbNumber(`the bill was already ${status}`, status);
        }
        const ctx = await viewContextInTx(tx, command.tenantId, [row], this.gateway);
        await audit(tx, command, 'eway.generated', 'eway_bill', row.id, key);
        const snapshot: EwayBillSnapshot = { bill: toEwayBillView(row, ctx) };
        await settleKey(tx, command.tenantId, key, payloadHash, snapshot);
        return snapshot;
      });
    } catch (err) {
      if (!(err instanceof LostEwbNumber)) throw err;
      await this.recordLostNumber(command, result.ewbNo, err);
      throw err.status === null ? ewbNoTaken(result.ewbNo) : notPending(err.status);
    }
  }

  /**
   * NIC issued a number this bill cannot take: never drop it silently — log
   * it and keep it on the bill (own tx; the settle tx rolled back) so
   * finance can cancel it on the portal.
   */
  private async recordLostNumber(command: GenerateEwayCommand, ewbNo: string, lost: LostEwbNumber): Promise<void> {
    const note = `gateway generated EWB ${ewbNo} but ${lost.message} — cancel it on the portal`;
    this.logger.error(`e-way bill ${command.billId}: ${note}`);
    await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      await tx
        .update(ewayBills)
        .set({ lastError: note, gatewayClaimedAt: null, updatedAt: nowIso() })
        .where(and(eq(ewayBills.tenantId, command.tenantId), eq(ewayBills.id, command.billId)));
    });
  }

  /** Clears the claim (and records a refusal's message) on a pending bill. */
  private async releaseClaim(command: GenerateEwayCommand, lastError: string | null): Promise<void> {
    await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      await tx
        .update(ewayBills)
        .set({
          gatewayClaimedAt: null,
          ...(lastError === null ? {} : { lastError: lastError.slice(0, 1000) }),
          updatedAt: nowIso(),
        })
        .where(
          and(eq(ewayBills.tenantId, command.tenantId), eq(ewayBills.id, command.billId), eq(ewayBills.status, 'pending')),
        );
    });
  }

  // ── configuration (owner) ────────────────────────────────────────────────

  async appendStateThreshold(command: AppendStateThresholdCommand, key: string): Promise<EwayStateThresholdSnapshot> {
    if (typeof command.stateCode !== 'string' || !STATE_CODE_RE.test(command.stateCode)) {
      throw invalid('Invalid state code', `stateCode must be a two-digit GST state code (got "${String(command.stateCode)}").`);
    }
    if (typeof command.effectiveFrom !== 'string' || !isIsoDate(command.effectiveFrom)) {
      throw invalid('Invalid effectiveFrom', `effectiveFrom must be a date YYYY-MM-DD (got "${String(command.effectiveFrom)}").`);
    }
    const amount = command.thresholdPaise;
    if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) {
      throw invalid('Invalid threshold', 'thresholdPaise must be a non-negative integer in paise, or null for "no e-way bill required".');
    }
    const payloadHash = hashCommandPayload({
      kind: 'eway.state-threshold',
      stateCode: command.stateCode,
      thresholdPaise: amount,
      effectiveFrom: command.effectiveFrom,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'eway.configure');
      const replayed = await replay<EwayStateThresholdSnapshot>(tx, command.tenantId, key, payloadHash);
      if (replayed !== null) return replayed;
      const known = await tx
        .select({ stateCode: gstStateCodes.stateCode })
        .from(gstStateCodes)
        .where(eq(gstStateCodes.stateCode, command.stateCode))
        .limit(1);
      if (known[0] === undefined || UNSUPPORTED_STATE_CODES.has(command.stateCode)) {
        throw invalid(
          'Invalid state code',
          `stateCode ${command.stateCode} is not a GST state an intra-state threshold can apply to (the CBIC list, excluding 97 Other Territory and 99 Other Country).`,
        );
      }
      const inserted = await tx
        .insert(ewayStateThresholds)
        .values({
          id: uuidv7(),
          tenantId: command.tenantId,
          stateCode: command.stateCode,
          thresholdPaise: amount,
          effectiveFrom: command.effectiveFrom,
          createdBy: command.actorUserId,
        })
        .returning();
      const row = inserted[0]!;
      await audit(tx, command, 'eway.threshold_added', 'eway_state_threshold', row.id, key);
      const snapshot: EwayStateThresholdSnapshot = { threshold: toStateThresholdView(row) };
      await settleKey(tx, command.tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }

  async putGstinSetting(command: PutGstinSettingCommand, key: string): Promise<EwayGstinSettingSnapshot> {
    const gstin = assertGstinParam(typeof command.gstin === 'string' ? command.gstin.trim().toUpperCase() : command.gstin);
    if (typeof command.eInvoiceApplies !== 'boolean') {
      throw invalid('Invalid setting', 'eInvoiceApplies must be a boolean.');
    }
    const payloadHash = hashCommandPayload({ kind: 'eway.gstin-setting', gstin, eInvoiceApplies: command.eInvoiceApplies });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'eway.configure');
      const replayed = await replay<EwayGstinSettingSnapshot>(tx, command.tenantId, key, payloadHash);
      if (replayed !== null) return replayed;
      const owned = await tenantGstinsInTx(tx, command.tenantId);
      if (!owned.includes(gstin)) {
        throw new ProblemException(
          'not-found',
          404,
          'GSTIN not found',
          `GSTIN ${gstin} is neither the tenant's nor any of its warehouses' registration.`,
        );
      }
      const stamp = nowIso();
      const upserted = await tx
        .insert(ewayGstinSettings)
        .values({
          id: uuidv7(),
          tenantId: command.tenantId,
          gstin,
          eInvoiceApplies: command.eInvoiceApplies,
          updatedBy: command.actorUserId,
          updatedAt: stamp,
        })
        .onConflictDoUpdate({
          target: [ewayGstinSettings.tenantId, ewayGstinSettings.gstin],
          set: { eInvoiceApplies: command.eInvoiceApplies, updatedBy: command.actorUserId, updatedAt: stamp },
        })
        .returning();
      const row = upserted[0]!;
      await audit(tx, command, 'eway.gstin_setting_updated', 'eway_gstin_setting', row.id, key);
      const snapshot: EwayGstinSettingSnapshot = { setting: toGstinSettingView(row) };
      await settleKey(tx, command.tenantId, key, payloadHash, snapshot);
      return snapshot;
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** The settle could not take the number the gateway issued (status null = the number is taken). */
class LostEwbNumber extends Error {
  constructor(
    message: string,
    readonly status: string | null,
  ) {
    super(message);
  }
}

async function replay<T>(tx: TenantTx, tenantId: string, key: string, payloadHash: string): Promise<T | null> {
  const existing = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
    .limit(1);
  if (existing[0] === undefined) return null;
  if (existing[0].payloadHash !== payloadHash) throw idempotencyKeyReuse();
  return existing[0].responseSnapshot as T;
}

async function settleKey(tx: TenantTx, tenantId: string, key: string, payloadHash: string, snapshot: unknown): Promise<void> {
  try {
    await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key, payloadHash, responseSnapshot: snapshot });
  } catch (err) {
    if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) throw concurrentKey();
    throw err;
  }
}

async function audit(tx: TenantTx, actor: Actor, action: string, targetType: string, targetId: string, key: string): Promise<void> {
  await tx.insert(auditEvents).values({
    id: uuidv7(),
    tenantId: actor.tenantId,
    actorUserId: actor.actorUserId,
    action,
    targetType,
    targetId,
    reference: key,
    occurredAt: nowIso(),
  });
}

async function lockBill(tx: TenantTx, tenantId: string, billId: string): Promise<EwayBill> {
  const rows = await tx
    .select()
    .from(ewayBills)
    .where(and(eq(ewayBills.tenantId, tenantId), eq(ewayBills.id, billId)))
    .limit(1)
    .for('update');
  if (rows[0] === undefined) throw billNotFound();
  return rows[0];
}

/** Why a found bill cannot be exported: state, claim, then its blockers. */
function refusalReasons(row: EwayBill, ctx: EwayViewContext): string[] {
  if (row.status !== 'pending') return ['not-pending'];
  const reasons: string[] = [];
  if (claimLive(row)) reasons.push('claimed');
  const blockers: EwayBlocker[] = blockersFor(row, ctx);
  reasons.push(...blockers.map((blocker) => blocker.code));
  return reasons;
}

/** The GSTIN most of the bills share (ties: the smallest) — the others are `mixed-gstin`. */
function dominantGstin(rows: readonly EwayBill[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.originGstin, (counts.get(row.originGstin) ?? 0) + 1);
  let best: string | null = null;
  for (const [gstin, count] of [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (best === null || count > counts.get(best)!) best = gstin;
  }
  return best;
}

function billObjectFor(row: EwayBill, ctx: EwayViewContext): EwbBillObject {
  const invoice = ctx.invoices.get(row.invoiceId);
  const facts = invoice === undefined ? null : invoiceFacts(invoice);
  if (facts === null) throw notExportable([{ id: row.id, reasons: ['invoice-unavailable'] }]);
  return ewbBillObject(facts, partBOf(row), ctx.maps);
}
