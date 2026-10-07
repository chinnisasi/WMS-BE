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
