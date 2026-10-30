/**
 * Story 4-6a (A15, A36, A42) — the consignment gate: may this client order
 * leave, given its client's documents rule, its own figures and its live
 * consignment record? ONE pure function, evaluated by the per-order dispatch
 * (`dispatchOrderInTx`), the courier handover's classification, the staff and
 * portal reads, the worklists and the documents-needed email. Mirrored
 * byte-for-byte in wms-fe (`src/lib/consignment-gate.ts`) and pinned by one
 * shared vector file (`consignment-gate.vectors.json`, beside each copy — D10).
 *
 * Money is integer paise as plain numbers (A42): the rated value is computed
 * in BigInt by the caller and converted after `Number.isSafeInteger`.
 * Dates are IST calendar dates (`YYYY-MM-DD`), compared as strings.
 */

/** The client's documents rule (`clients.consignment_document_rule`). */
export type ConsignmentDocumentRule = 'b2b' | 'all' | 'high-value';

/** The refusal codes a blocking state answers (409), and a device handover's exception flag. */
export const CONSIGNMENT_GATE_CODES = ['consignment-documents-missing', 'eway-bill-required', 'eway-bill-expired'] as const;
export type ConsignmentGateCode = (typeof CONSIGNMENT_GATE_CODES)[number];

export const CONSIGNMENT_GATE_STATES = ['not-applicable', 'dispatched', 'eway-required', 'eway-expired', 'ready', 'missing', 'not-required'] as const;
export type ConsignmentGateState = (typeof CONSIGNMENT_GATE_STATES)[number];

export const CONSIGNMENT_REQUIRED_BECAUSE = ['policy-all', 'policy-b2b', 'value'] as const;
export type ConsignmentRequiredBecause = (typeof CONSIGNMENT_REQUIRED_BECAUSE)[number];

export interface ConsignmentGateFacts {
  /** The tenant's own (`self`) client — invoiced and e-way-billed by 8-1 / 8-2b. */
  readonly clientSystemOwned: boolean;
  readonly documentRule: ConsignmentDocumentRule;
  /** The order's status (A36): `cancelled` → not applicable; `dispatched` → its own state. */
  readonly orderStatus: string;
  /** `b2b` | `b2c`, or null on a pre-4-2a order. */
  readonly orderType: string | null;
  readonly consigneeGstin: string | null;
  /** floor(Σ qty × rate / 1000) over the top-level lines that carry a rate; null when none does. */
  readonly ratedValuePaise: number | null;
  readonly codAmountPaise: number | null;
  /** The national e-way threshold in force on `istDate`. */
  readonly nationalThresholdPaise: number;
  /** The live record's verdict, or null when none is live. */
  readonly live: { readonly ewayStatus: string; readonly ewayValidUntil: string | null } | null;
  /** The judging IST date (the dispatch's `occurredAt`, or today on a read). */
  readonly istDate: string;
}

export interface ConsignmentGateResult {
  readonly state: ConsignmentGateState;
  readonly blocking: boolean;
  /** Why a record is required when none is live (rows 5–7); null otherwise. */
  readonly requiredBecause: ConsignmentRequiredBecause | null;
  /** max(rated value, COD amount) — null when the order carries neither. */
  readonly valueFloorPaise: number | null;
  /** A live recorded e-way bill whose last valid day is the judging date. */
  readonly expiresToday: boolean;
  /** The 409 code of a blocking state, else null. */
  readonly code: ConsignmentGateCode | null;
}

/** The order's own value floor (A15): the larger of its rated value and its COD amount. */
export function valueFloorOf(ratedValuePaise: number | null, codAmountPaise: number | null): number | null {
  if (ratedValuePaise === null && codAmountPaise === null) return null;
  return Math.max(ratedValuePaise ?? 0, codAmountPaise ?? 0);
}

/** 4-2a's derivation (`order.command.ts`): a B2B order, or a legacy (NULL type) order with a consignee GSTIN. */
export function isB2bOrder(orderType: string | null, consigneeGstin: string | null): boolean {
  return orderType === 'b2b' || (orderType === null && consigneeGstin !== null);
}

/** The code a blocking state answers. */
export function consignmentGateCodeOf(state: ConsignmentGateState): ConsignmentGateCode | null {
  switch (state) {
    case 'missing':
      return 'consignment-documents-missing';
    case 'eway-required':
      return 'eway-bill-required';
    case 'eway-expired':
      return 'eway-bill-expired';
    default:
      return null;
  }
}

function result(
  state: ConsignmentGateState,
  requiredBecause: ConsignmentRequiredBecause | null,
  valueFloorPaise: number | null,
  expiresToday: boolean,
): ConsignmentGateResult {
  const code = consignmentGateCodeOf(state);
  return { state, blocking: code !== null, requiredBecause, valueFloorPaise, expiresToday, code };
}

/**
 * The gate table (A15, A36), evaluated in this order:
 * 1. the `self` client → `not-applicable`;
 *    a cancelled order → `not-applicable`; a dispatched one → `dispatched` (A36);
 * 2. a live record whose e-way bill is owed → `eway-required` (blocking);
 * 3. a live recorded bill valid until before the judging date → `eway-expired` (blocking);
 * 4. any other live record → `ready` (`expiresToday` on its last day);
 * 5. no live record and the rule `all` → `missing` (`policy-all`);
 * 6. the rule `b2b` and a B2B order → `missing` (`policy-b2b`);
 * 7. the value floor strictly above the national threshold → `missing` (`value`);
 * 8. otherwise `not-required`.
 * A record that exists is judged by its own verdict under every rule.
 */
export function consignmentGate(facts: ConsignmentGateFacts): ConsignmentGateResult {
  const floor = valueFloorOf(facts.ratedValuePaise, facts.codAmountPaise);
  if (facts.clientSystemOwned || facts.orderStatus === 'cancelled') return result('not-applicable', null, floor, false);
  if (facts.orderStatus === 'dispatched') return result('dispatched', null, floor, false);
  const live = facts.live;
  if (live !== null) {
    if (live.ewayStatus === 'pending') return result('eway-required', null, floor, false);
    if (live.ewayStatus === 'recorded' && live.ewayValidUntil !== null && live.ewayValidUntil < facts.istDate) {
      return result('eway-expired', null, floor, false);
    }
    return result('ready', null, floor, live.ewayStatus === 'recorded' && live.ewayValidUntil === facts.istDate);
  }
  if (facts.documentRule === 'all') return result('missing', 'policy-all', floor, false);
  if (facts.documentRule === 'b2b' && isB2bOrder(facts.orderType, facts.consigneeGstin)) return result('missing', 'policy-b2b', floor, false);
  if (floor !== null && floor > facts.nationalThresholdPaise) return result('missing', 'value', floor, false);
  return result('not-required', null, floor, false);
}

/**
 * A42 — the rated value floor: floor(Σ qty × rate_paise / 1000) over the
 * top-level lines that carry a rate (qty in milli-units, rate per base unit),
 * in exact BigInt, then a plain number (it is ≤ 10^12-scale by the bounds;
 * an unsafe result is a programming error). Null when no line carries a rate.
 */
export function ratedValuePaiseOf(lines: readonly { readonly qty: number; readonly ratePaise: number | null; readonly parentLineId: string | null }[]): number | null {
  let total = 0n;
  let any = false;
  for (const line of lines) {
    if (line.parentLineId !== null || line.ratePaise === null) continue;
    any = true;
    total += BigInt(line.qty) * BigInt(line.ratePaise);
  }
  if (!any) return null;
  const value = Number(total / 1000n);
  if (!Number.isSafeInteger(value)) throw new RangeError(`rated value ${String(total / 1000n)} paise is not a safe integer`);
  return value;
}
