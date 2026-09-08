/**
 * Money primitive (AD-9): all monetary amounts are integer paise.
 * Floating-point money is forbidden anywhere in the codebase.
 */

export type Paise = number & { readonly __brand: 'paise' };

export function paise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new Error(`Non-finite rupee amount: ${rupees}`);
  const value = Math.round(rupees * 100);
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