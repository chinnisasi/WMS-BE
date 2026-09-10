import { and, eq } from 'drizzle-orm';
import { bins, zones } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import type { TenantTx } from '../../shared/db/tenant-scope';

/**
 * The system Receiving bin (Story 3.3): every warehouse owns exactly one,
 * auto-created at first receipt — bin master data stays tenancy-owned (AD-6),
 * so the receive command ensures it through this module's helper and never
 * writes `zones`/`bins` rows itself.
 *
 * Identity is the fixed code pair — zone `RECEIVING`, bin `RECEIVING` —
 * ensured idempotently inside the CALLER's transaction (the GRN command's
 * tenant tx): a concurrent first receipt races on the unique indexes and the
 * loser re-selects the winner's rows, both landing on one bin. `system_owned`
 * flags it so putaway suggestions (3.5) and picking exclude it; the type is
 * `staging` (the fixed 1.3 set) and the capacity is a generous sentinel —
 * receiving is never capacity-gated.
 */
export const RECEIVING_ZONE_CODE = 'RECEIVING';
export const RECEIVING_BIN_CODE = 'RECEIVING';
export const RECEIVING_BIN_TYPE = 'staging';
/** Effectively unbounded: receiving intake is never capacity-gated. */
export const RECEIVING_BIN_CAPACITY = 1_000_000;

export interface ReceivingBinRef {
  readonly zoneId: string;
  readonly binId: string;
}

/**
 * The system QC-hold bin (Story 3.4): every warehouse owns exactly one,
 * auto-created at first hold — the Receiving-bin mirror (Story 3.3). Only the
 * QC hold/release commands ever move stock through it; `qcHeldUnits` reads
 * the stock sitting in it (the bin code is the identity, so ATP needs no
 * hold-table read). `system_owned` excludes it from putaway suggestions and
 * picking like the Receiving bin; the type is `staging` and the capacity a
 * generous sentinel — quarantine intake is never capacity-gated.
 */
export const QC_HOLD_ZONE_CODE = 'QC-HOLD';
export const QC_HOLD_BIN_CODE = 'QC-HOLD';
export const QC_HOLD_BIN_TYPE = 'staging';
/** Effectively unbounded: quarantining stock is never capacity-gated. */
export const QC_HOLD_BIN_CAPACITY = 1_000_000;

export async function ensureReceivingBinInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
): Promise<ReceivingBinRef> {
  // Zone first (the bin's parent), then the bin — each ensure-or-reselect.
  await tx
    .insert(zones)
    .values({
      id: uuidv7(),
      tenantId,
      warehouseId,
      code: RECEIVING_ZONE_CODE,
      name: 'Receiving',
    })
    .onConflictDoNothing({ target: [zones.warehouseId, zones.code] });
  const zoneRows = await tx
    .select({ id: zones.id })
    .from(zones)
    .where(
      and(eq(zones.tenantId, tenantId), eq(zones.warehouseId, warehouseId), eq(zones.code, RECEIVING_ZONE_CODE)),
    )
    .limit(1);
  const zone = zoneRows[0];
  if (zone === undefined) {
    // Unreachable short of an RLS/scope bug — fail loudly rather than
    // guess an id.
    throw new Error(`receiving zone missing after ensure: ${tenantId}/${warehouseId}`);
  }

  await tx
    .insert(bins)
    .values({
      id: uuidv7(),
      tenantId,
      warehouseId,
      zoneId: zone.id,
      code: RECEIVING_BIN_CODE,
      capacity: RECEIVING_BIN_CAPACITY,
      type: RECEIVING_BIN_TYPE,
      systemOwned: true,
    })
    .onConflictDoNothing({ target: [bins.warehouseId, bins.code] });
  const binRows = await tx
    .select({ id: bins.id })
    .from(bins)
    .where(
      and(eq(bins.tenantId, tenantId), eq(bins.warehouseId, warehouseId), eq(bins.code, RECEIVING_BIN_CODE)),
    )
    .limit(1);
  const bin = binRows[0];
  if (bin === undefined) {
    throw new Error(`receiving bin missing after ensure: ${tenantId}/${warehouseId}`);
  }
  return { zoneId: zone.id, binId: bin.id };
}

/**
 * `ensureQcHoldBinInTx` — the Receiving-bin ensure's mirror (Story 3.4):
 * zone first, then the bin, each ensure-or-reselect inside the CALLER's
 * transaction; a concurrent first hold races on the unique indexes and the
 * loser re-selects the winner's rows, both landing on one bin.
 */
export async function ensureQcHoldBinInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
): Promise<ReceivingBinRef> {
  await tx
    .insert(zones)
    .values({
      id: uuidv7(),
      tenantId,
      warehouseId,
      code: QC_HOLD_ZONE_CODE,
      name: 'QC Hold',
    })
    .onConflictDoNothing({ target: [zones.warehouseId, zones.code] });
  const zoneRows = await tx
    .select({ id: zones.id })
    .from(zones)
    .where(
      and(eq(zones.tenantId, tenantId), eq(zones.warehouseId, warehouseId), eq(zones.code, QC_HOLD_ZONE_CODE)),
    )
    .limit(1);
  const zone = zoneRows[0];
  if (zone === undefined) {
    // Unreachable short of an RLS/scope bug — fail loudly rather than
    // guess an id.
    throw new Error(`qc-hold zone missing after ensure: ${tenantId}/${warehouseId}`);
  }

  await tx
    .insert(bins)
    .values({
      id: uuidv7(),
      tenantId,
      warehouseId,
      zoneId: zone.id,
      code: QC_HOLD_BIN_CODE,
      capacity: QC_HOLD_BIN_CAPACITY,
      type: QC_HOLD_BIN_TYPE,
      systemOwned: true,
    })
    .onConflictDoNothing({ target: [bins.warehouseId, bins.code] });
  const binRows = await tx
    .select({ id: bins.id })
    .from(bins)
    .where(
      and(
        eq(bins.tenantId, tenantId),
        eq(bins.warehouseId, warehouseId),
        eq(bins.code, QC_HOLD_BIN_CODE),
        // The identity that feeds `qcHeldUnits` is code + system-owned: a
        // user-created bin named `QC-HOLD` is not the QC bin — adopting it
        // would park stock where the ATP hook counts zero. Refuse loudly
        // (the insert below collides on the unique (warehouse, code) index)
        // rather than silently break the hook.
        eq(bins.systemOwned, true),
      ),
    )
    .limit(1);
  const bin = binRows[0];
  if (bin === undefined) {
    throw new Error(`qc-hold bin missing after ensure: ${tenantId}/${warehouseId}`);
  }
  return { zoneId: zone.id, binId: bin.id };
}
