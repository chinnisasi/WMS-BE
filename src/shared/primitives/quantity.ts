/**
 * Quantity primitive (AD-9): every quantity is an integer in the SKU's base
 * unit of measure. Conversions happen at the edges, never in storage.
 */

export type BaseQuantity = number & { readonly __brand: 'base-quantity' };

export function baseQuantity(value: number): BaseQuantity {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Quantity must be a non-negative integer in base UoM: ${value}`);
  }
  return value as BaseQuantity;
}

/** GST rate in basis points (e.g. 18% = 1800). Never a float, never a string. */
export type GstBps = number & { readonly __brand: 'gst-bps' };

export function gstBps(percent: number): GstBps {
  const bps = Math.round(percent * 100);
  if (!Number.isFinite(bps)) throw new Error(`Non-finite GST rate: ${percent}`);
  if (bps < 0 || bps > 10000) throw new Error(`GST out of range (0–100%): ${percent}`);
  return bps as GstBps;
}
