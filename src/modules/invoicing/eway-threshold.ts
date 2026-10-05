import { and, desc, eq, lte } from 'drizzle-orm';
import { ewayNationalThresholds, ewayStateThresholds } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { ArithmeticOverflowError, type SupplyType } from './arith';
import { IST_OFFSET_MS } from './generator';

/**
 * The e-way bill threshold (story 8-2b): which consignments need an EWB.
 *
 * Thresholds are versioned DATA, never code literals (AD-9): the national
 * rule (CGST Rule 138(1), ₹50,000) lives in `eway_national_thresholds`, and a
 * tenant's per-state intra-state overrides in the append-only
 * `eway_state_thresholds`. The one in force on the invoice's IST issue date
 * applies.
 */

/** One frozen invoice line as the value computation sees it (paise / bps). */
export interface EwayValueLine {
  readonly gstBps: number;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
}

/**
 * The consignment value (Rule 138, Explanation 2): Σ (taxable + CGST + SGST
 * + IGST) over the TAXABLE lines, in exact integer paise. A 0% line is an
 * exempt supply and is excluded. Cess is never modelled (always 0).
 */
export function consignmentValuePaise(lines: readonly EwayValueLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (line.gstBps <= 0) continue;
    total += line.taxablePaise + line.cgstPaise + line.sgstPaise + line.igstPaise;
  }
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ArithmeticOverflowError(`e-way consignment value is not a safe non-negative integer (got ${String(total)})`);
  }
  return total;
}

/** The IST calendar date (`YYYY-MM-DD`) an instant falls on. */
export function istDateOf(instant: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new ArithmeticOverflowError(`e-way: unparseable instant "${instant}"`);
  }
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

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

/**
 * The threshold in force on `istDate`. An INTRA-state supply uses the
 * bill-from state's newest override with `effective_from` on or before that
 * date (a same-date correction: the newest `created_at` wins), falling back
 * to national. An INTER-state supply always uses national.
 */
export async function thresholdFor(tx: TenantTx, tenantId: string, query: ThresholdQuery): Promise<ThresholdInForce> {
  if (query.supplyType === 'intra') {
    const overrides = await tx
      .select({ thresholdPaise: ewayStateThresholds.thresholdPaise })
      .from(ewayStateThresholds)
      .where(
        and(
          eq(ewayStateThresholds.tenantId, tenantId),
          eq(ewayStateThresholds.stateCode, query.billFromState),
          lte(ewayStateThresholds.effectiveFrom, query.istDate),
        ),
      )
      .orderBy(desc(ewayStateThresholds.effectiveFrom), desc(ewayStateThresholds.createdAt), desc(ewayStateThresholds.id))
      .limit(1);
    const override = overrides[0];
    if (override !== undefined) {
      return {
        thresholdPaise: override.thresholdPaise === null ? null : Number(override.thresholdPaise),
        rule: `state:${query.billFromState}`,
      };
    }
  }
  const national = await tx
    .select({ thresholdPaise: ewayNationalThresholds.thresholdPaise })
    .from(ewayNationalThresholds)
    .where(lte(ewayNationalThresholds.effectiveFrom, query.istDate))
    .orderBy(desc(ewayNationalThresholds.effectiveFrom))
    .limit(1);
  if (national[0] === undefined) {
    // Deterministic: no national rule covers the date (before the seeded
    // 2018-04-01 row). A data fault, not a transient one.
    throw new ProblemException(
      'eway-threshold-missing',
      409,
      'No e-way threshold in force',
      `No national e-way threshold is in force on ${query.istDate}.`,
    );
  }
  return { thresholdPaise: Number(national[0].thresholdPaise), rule: 'national' };
}

/** The bill is needed when the value EXCEEDS a threshold (a null threshold never needs one). */
export function ewayRequired(valuePaise: number, threshold: ThresholdInForce): boolean {
  return threshold.thresholdPaise !== null && valuePaise > threshold.thresholdPaise;
}
