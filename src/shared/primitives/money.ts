/**
 * Money primitive (AD-9): all monetary amounts are integer paise.
 * Floating-point money is forbidden anywhere in the codebase.
 */

export type Paise = number & { readonly __brand: 'paise' };

export function paise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new Error(`Non-finite rupee amount: ${rupees}`);
  const value = Math.round(rupees * 100);
  if (!Number.isSafeInteger(value)) throw new Error(`Rupee amount out of safe paise range: ${rupees}`);
  return value as Paise;
}

export function rupees(amount: Paise): number {
  return amount / 100;
}

export function addPaise(a: Paise, b: Paise): Paise {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new Error('Paise overflow');
  return sum as Paise;
}

export function isPaise(value: number): value is Paise {
  return Number.isSafeInteger(value);
}

/**
 * The BigInt half-up divide — `numerator ÷ denominator` rounded once, half
 * up, for a non-negative numerator and a positive denominator. Moved here
 * from `invoicing/arith.ts` (story 21-4): invoice line maths and storage
 * metering (`Σ milli-unit-days × rate ÷ 1,000,000`) round the same way, in
 * BigInt because the product can pass 2⁵³. `invoicing/arith.ts` re-exports
 * it unchanged.
 */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator === 0n) return 0n;
  const quotient = numerator / denominator;
  const remainder = numerator - quotient * denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

/**
 * Story 4-2a — the cash-on-delivery ceiling: ₹1 crore in paise. One copy for
 * the order command's COD check, the `orders_cod_amount_paise_check` CHECK
 * (migration 0093, pinned by test/order-fields.spec.ts) and the channel parse
 * arms (Shopify's `total_outstanding`), which may not import outbound.
 */
export const MAX_COD_AMOUNT_PAISE = 1_000_000_000;

/**
 * Story 4-2a — a channel's decimal rupee string (`^\d{1,8}(\.\d{1,2})?$`,
 * e.g. Shopify's `total_outstanding: "1499.00"`) as integer paise, by integer
 * arithmetic (never a float). Null for any other shape.
 */
export function decimalRupeesToPaise(text: string): number | null {
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) return null;
  const whole = Number.parseInt(match[1]!, 10);
  const fraction = Number.parseInt((match[2] ?? '').padEnd(2, '0'), 10);
  return whole * 100 + fraction;
}
