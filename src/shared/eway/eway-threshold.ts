import { and, desc, eq, lte } from 'drizzle-orm';
import { ewayNationalThresholds, ewayStateThresholds } from '../db/schema';
import type { TenantTx } from '../db/tenant-scope';
import { ProblemException } from '../problem-details/problem.exception';
import type { SupplyType } from '../primitives/gst';

/**
 * The e-way bill threshold (story 8-2b): which consignments need an EWB.
 * Moved here unchanged from `invoicing/eway-threshold.ts` by story 4-6a (A8,
 * D6 — the `shared/primitives/vehicle.ts` precedent), so the order
 * consignment record's gate and the return dispatches share it; invoicing
 * re-exports every moved name, so its importers stand.
 *
 * Thresholds are versioned DATA, never code literals (AD-9): the national
 * rule (CGST Rule 138(1), ₹50,000) lives in `eway_national_thresholds`, and a
 * tenant's per-state intra-state overrides in the append-only
 * `eway_state_thresholds`. The one in force on the document's IST date
 * applies.
 */

export const THRESHOLD_RULE_RE = /^(national|state:[0-9]{2})$/;

/** The threshold in force: `null` paise means "no e-way bill required". */
export interface ThresholdInForce {
  readonly thresholdPaise: number | null;
  /** `national` or `state:<code>` — stored on the bill row. */
  readonly rule: string;
}

export interface ThresholdQuery {
  readonly supplyType: SupplyType;
  /** The bill-from state: the supplier GSTIN's two-digit prefix. */
  readonly billFromState: string;
  /** The invoice's IST issue date, `YYYY-MM-DD`. */
  readonly istDate: string;
}

function thresholdMissing(istDate: string): ProblemException {
  // Deterministic: no national rule covers the date (before the seeded
  // 2018-04-01 row). A data fault, not a transient one.
  return new ProblemException('eway-threshold-missing', 409, 'No e-way threshold in force', `No national e-way threshold is in force on ${istDate}.`);
}

/** The newest intra-state override of `stateCode` in force on `istDate`, or undefined when none is. */
async function stateOverrideInTx(tx: TenantTx, tenantId: string, stateCode: string, istDate: string): Promise<{ thresholdPaise: number | null } | undefined> {
  const overrides = await tx
    .select({ thresholdPaise: ewayStateThresholds.thresholdPaise })
    .from(ewayStateThresholds)
    .where(and(eq(ewayStateThresholds.tenantId, tenantId), eq(ewayStateThresholds.stateCode, stateCode), lte(ewayStateThresholds.effectiveFrom, istDate)))
    .orderBy(desc(ewayStateThresholds.effectiveFrom), desc(ewayStateThresholds.createdAt), desc(ewayStateThresholds.id))
    .limit(1);
  const override = overrides[0];
  return override === undefined ? undefined : { thresholdPaise: override.thresholdPaise === null ? null : Number(override.thresholdPaise) };
}

/** Story 4-6a (A12) — the national threshold in force on `istDate` (409 `eway-threshold-missing` when none is). */
export async function nationalThresholdInForceInTx(tx: TenantTx, istDate: string): Promise<number> {
  const national = await tx
    .select({ thresholdPaise: ewayNationalThresholds.thresholdPaise })
    .from(ewayNationalThresholds)
    .where(lte(ewayNationalThresholds.effectiveFrom, istDate))
    .orderBy(desc(ewayNationalThresholds.effectiveFrom))
    .limit(1);
  if (national[0] === undefined) throw thresholdMissing(istDate);
  return Number(national[0].thresholdPaise);
}

/**
 * The threshold in force on `istDate`. An INTRA-state supply uses the
 * bill-from state's newest override with `effective_from` on or before that
 * date (a same-date correction: the newest `created_at` wins), falling back
 * to national. An INTER-state supply always uses national.
 */
export async function thresholdFor(tx: TenantTx, tenantId: string, query: ThresholdQuery): Promise<ThresholdInForce> {
  if (query.supplyType === 'intra') {
    const override = await stateOverrideInTx(tx, tenantId, query.billFromState, query.istDate);
    if (override !== undefined) {
      return { thresholdPaise: override.thresholdPaise, rule: `state:${query.billFromState}` };
    }
  }
  return { thresholdPaise: await nationalThresholdInForceInTx(tx, query.istDate), rule: 'national' };
}

/** The bill is needed when the value EXCEEDS a threshold (a null threshold never needs one). */
export function ewayRequired(valuePaise: number, threshold: ThresholdInForce): boolean {
  return threshold.thresholdPaise !== null && valuePaise > threshold.thresholdPaise;
}

/** Story 4-6a (A8) — a movement's threshold, with the supply type it was judged as (null: destination unknown). */
export interface MovementThreshold extends ThresholdInForce {
  readonly supplyType: SupplyType | null;
}

/**
 * Story 4-6a (A8, A9, A41) — the threshold for a goods movement from
 * `fromState` (the dispatch point) to `toState`:
 * - both known: `thresholdFor` as intra (same state) or inter;
 * - `toState` unknown: the LOWER of national and `fromState`'s intra override
 *   in force — a null override means no bill is required intra-state, so it
 *   is never the lower one — with the rule that produced the figure and
 *   `supplyType: null`;
 * - `fromState` unknown too: national (A41's last fallback).
 */
export async function thresholdForMovement(
  tx: TenantTx,
  tenantId: string,
  movement: { readonly fromState: string | null; readonly toState: string | null; readonly istDate: string },
): Promise<MovementThreshold> {
  if (movement.fromState === null) {
    return { thresholdPaise: await nationalThresholdInForceInTx(tx, movement.istDate), rule: 'national', supplyType: null };
  }
  if (movement.toState !== null) {
    const supplyType: SupplyType = movement.fromState === movement.toState ? 'intra' : 'inter';
    const threshold = await thresholdFor(tx, tenantId, { supplyType, billFromState: movement.fromState, istDate: movement.istDate });
    return { ...threshold, supplyType };
  }
  const national = await nationalThresholdInForceInTx(tx, movement.istDate);
  const override = await stateOverrideInTx(tx, tenantId, movement.fromState, movement.istDate);
  if (override !== undefined && override.thresholdPaise !== null && override.thresholdPaise < national) {
    return { thresholdPaise: override.thresholdPaise, rule: `state:${movement.fromState}`, supplyType: null };
  }
  return { thresholdPaise: national, rule: 'national', supplyType: null };
}
