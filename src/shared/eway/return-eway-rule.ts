import { sql } from 'drizzle-orm';
import { gstStateCodes } from '../db/schema';
import type { TenantTx } from '../db/tenant-scope';
import { ProblemException } from '../problem-details/problem.exception';
import { formatRupees } from '../primitives/consignment-record';
import { thresholdForMovement, type MovementThreshold } from './eway-threshold';

/**
 * Story 4-6a (A22, A41) — the return dispatches' e-way rule, shared by the
 * return to vendor (inbound) and the return to client (returns): a SENT
 * declared value is judged against the threshold in force on the document's
 * date for the movement (`thresholdForMovement`). Required → an e-way bill
 * number or an exemption must come with it (409 `eway-bill-required`), and a
 * given bill must still be valid today (409 `eway-bill-expired`). No value
 * sent (an older API caller) → not judged; the caller marks `ewayUnjudged`.
 */
export interface ReturnEwayFacts {
  readonly declaredValuePaise: number | null;
  readonly fromState: string | null;
  readonly toState: string | null;
  /** The brand document's date — the threshold in force on it applies. */
  readonly documentDate: string;
  readonly todayIst: string;
  readonly ewayBillNumber: string | null;
  readonly ewayValidUntil: string | null;
  readonly exempt: boolean;
}

export async function assertReturnEwayRuleInTx(tx: TenantTx, tenantId: string, facts: ReturnEwayFacts): Promise<MovementThreshold | null> {
  if (facts.declaredValuePaise === null) return null;
  const threshold = await thresholdForMovement(tx, tenantId, { fromState: facts.fromState, toState: facts.toState, istDate: facts.documentDate });
  const required = threshold.thresholdPaise !== null && facts.declaredValuePaise > threshold.thresholdPaise;
  if (!required) return threshold;
  const extensions = { declaredValuePaise: facts.declaredValuePaise, thresholdPaise: threshold.thresholdPaise, thresholdRule: threshold.rule };
  if (facts.ewayBillNumber === null && !facts.exempt) {
    throw new ProblemException(
      'eway-bill-required',
      409,
      'E-way bill required',
      `The declared value ${formatRupees(facts.declaredValuePaise)} is above the e-way threshold ${formatRupees(threshold.thresholdPaise!)} (${threshold.rule === 'national' ? 'national' : `the state's intra-state limit, ${threshold.rule}`}) — record the brand's e-way bill number, or an exemption.`,
      extensions,
    );
  }
  if (facts.ewayBillNumber !== null && facts.ewayValidUntil !== null && facts.ewayValidUntil < facts.todayIst) {
    throw new ProblemException(
      'eway-bill-expired',
      409,
      'E-way bill expired',
      `E-way bill ${facts.ewayBillNumber} expired on ${facts.ewayValidUntil} — record its extension or a new bill.`,
      extensions,
    );
  }
  return threshold;
}

/**
 * Story 4-6a (A41) — a free-text address state (the RTC's return address)
 * to its two-digit GST code by the official name (case and spacing ignored),
 * else null. Narrower than invoicing's resolver (no aliases): an unmatched
 * name falls back to the GSTIN prefix, then to the unknown-destination rule.
 */
export async function stateCodeOfNameInTx(tx: TenantTx, text: string | null): Promise<string | null> {
  if (text === null || text.trim() === '') return null;
  const rows = await tx
    .select({ code: gstStateCodes.stateCode })
    .from(gstStateCodes)
    .where(sql`lower(regexp_replace(${gstStateCodes.stateName}, '\\s+', ' ', 'g')) = lower(regexp_replace(trim(${text}), '\\s+', ' ', 'g'))`)
    .limit(1);
  return rows[0]?.code ?? null;
}
