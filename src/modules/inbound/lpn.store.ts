import { and, eq } from 'drizzle-orm';
import { lpns } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';

/**
 * Story 2-10b — the LPN free-function seam (IMPLEMENTATION-GUIDE §7h, the
 * 1-6d shape). It imports ONLY `drizzle-orm` and `shared/`, so the putaway
 * placement (`putaway.command.ts`) reaches the inbound-owned `lpns` table
 * without importing the inbound module (inbound imports putaway — the module
 * edge back would cycle). This file and `lpn.command.ts` are the only writers
 * of `lpns` (pinned by `test/architecture.spec.ts`).
 *
 * The vocabularies live here too, so the DTOs, the command and the putaway
 * seam share one copy (§4 — mirrored by 0109's CHECKs, pinned by
 * `test/lpns.spec.ts`).
 */

/** A1 — an LPN is minted `active`, consumed once by a placement (`placed`), or `voided` (terminal). */
export const LPN_STATUSES = ['active', 'placed', 'voided'] as const;
export type LpnStatus = (typeof LPN_STATUSES)[number];

/** A10 — why an LPN was voided; `other` requires a note. */
export const LPN_VOID_REASON_CODES = ['misprint', 'wrong-quantity', 'label-damaged', 'other'] as const;
export type LpnVoidReasonCode = (typeof LPN_VOID_REASON_CODES)[number];

/** A10 — the void note's bounds (characters, after trimming). */
export const LPN_VOID_NOTE_MAX = 200;

/** A1 — the placement's `lpnCode` bounds (characters, after trimming). */
export const LPN_CODE_MAX = 32;

/** Decision 4 — `LPN-` and the tenant number zero-padded to 6 digits (longer past 999,999). */
export function lpnCodeOf(seq: number): string {
  return `LPN-${String(seq).padStart(6, '0')}`;
}

/** The LPN row facts the placement needs. */
export interface LockedLpn {
  readonly id: string;
  readonly code: string;
  readonly grnId: string;
  readonly grnLineId: string;
  /** Milli-units. */
  readonly qty: number;
  readonly status: string;
}

/**
 * The LPN with this code, locked `FOR UPDATE` — or null when the tenant has
 * none. Lock only: the caller judges the status after the lock (the
 * `loadOpenPo` lesson, guide §1). The code compares exactly (a scan matches
 * `value.trim()` byte for byte; the caller trims).
 */
export async function lockLpnByCodeInTx(tx: TenantTx, tenantId: string, code: string): Promise<LockedLpn | null> {
  const rows = await tx
    .select({
      id: lpns.id,
      code: lpns.code,
      grnId: lpns.grnId,
      grnLineId: lpns.grnLineId,
      qty: lpns.qty,
      status: lpns.status,
    })
    .from(lpns)
    .where(and(eq(lpns.tenantId, tenantId), eq(lpns.code, code)))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/**
 * A1 — the placement consumes the LPN: `placed`, the server's instant and
 * the placement id. Conditional on `active` (the caller holds the row lock
 * and checked it, so a miss is a programming error and throws).
 */
export async function markLpnPlacedInTx(
  tx: TenantTx,
  args: { readonly tenantId: string; readonly lpnId: string; readonly placementId: string; readonly placedAt: string },
): Promise<void> {
  const updated = await tx
    .update(lpns)
    .set({ status: 'placed', placedAt: args.placedAt, placementId: args.placementId, updatedAt: args.placedAt })
    .where(and(eq(lpns.tenantId, args.tenantId), eq(lpns.id, args.lpnId), eq(lpns.status, 'active')))
    .returning({ id: lpns.id });
  if (updated.length !== 1) {
    throw new Error(`LPN ${args.lpnId} was not active under its own row lock`);
  }
}

/**
 * Story 2-10b (code review) — the LPN with this code as it stands, read-only
 * (no lock), or null. The review queue's `putaway.place` re-apply judges with
 * it whether a stored op's `lpnCode` is still placeable (`lpnPlaceableFor`).
 */
export async function lpnStateByCodeInTx(
  tx: TenantTx,
  tenantId: string,
  code: string,
): Promise<{ readonly grnLineId: string; readonly qty: number; readonly status: string; readonly placementId: string | null } | null> {
  const rows = await tx
    .select({ grnLineId: lpns.grnLineId, qty: lpns.qty, status: lpns.status, placementId: lpns.placementId })
    .from(lpns)
    .where(and(eq(lpns.tenantId, tenantId), eq(lpns.code, code)))
    .limit(1);
  return rows[0] ?? null;
}

/** An `active` LPN of this GRN line holding at least `qtyMilli`. */
export function lpnPlaceableFor(
  lpn: { readonly grnLineId: string; readonly qty: number; readonly status: string } | null,
  grnLineId: string,
  qtyMilli: number,
): boolean {
  return lpn !== null && lpn.status === 'active' && lpn.grnLineId === grnLineId.toLowerCase() && lpn.qty >= qtyMilli;
}
