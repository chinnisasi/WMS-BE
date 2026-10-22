import { and, eq } from 'drizzle-orm';
import { bins, zones } from '../../shared/db/schema';
import { uuidv7 } from '../../shared/primitives/ids';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { QUANTITY_SCALE } from '../../shared/primitives/quantity';
import { ProblemException } from '../../shared/problem-details/problem.exception';

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
/**
 * Effectively unbounded: receiving intake is never capacity-gated. In
 * milli-units (story 10.1) — 1,000,000 base units of sentinel headroom, the
 * same figure it has always been, expressed in the units the column now holds.
 */
export const RECEIVING_BIN_CAPACITY = 1_000_000 * QUANTITY_SCALE;

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
/** Effectively unbounded: quarantining stock is never capacity-gated (milli-units). */
export const QC_HOLD_BIN_CAPACITY = 1_000_000 * QUANTITY_SCALE;

/**
 * The system IN-TRANSIT bin (Story 5-1): every warehouse owns exactly one,
 * seeded by migration 0043 for the warehouses that already exist and lazily
 * ensured by the transfer legs' first use for warehouses created afterwards —
 * the QC-hold mirror once more (both system bins are lazy-ensured at first
 * use; nothing is created at warehouse creation). Only the movements module's
 * transfer legs ever move stock through it: the outbound confirm parks the
 * drawn units here and the inbound confirm drains them out, so the
 * serial-in-exactly-one-bin invariant survives and the ATP exclusion
 * (`inTransitUnits`) is one subtraction term keyed on code + system-owned —
 * the same identity `qcHeldUnits` reads. `system_owned` excludes it from
 * putaway suggestions and picking like the other system bins; the type is
 * `staging` and the capacity a generous sentinel — parking units in transit
 * is never capacity-gated.
 */
export const IN_TRANSIT_ZONE_CODE = 'IN-TRANSIT';
export const IN_TRANSIT_BIN_CODE = 'IN-TRANSIT';
export const IN_TRANSIT_BIN_TYPE = 'staging';
/** Effectively unbounded: parking units in transit is never capacity-gated (milli-units). */
export const IN_TRANSIT_BIN_CAPACITY = 1_000_000 * QUANTITY_SCALE;

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

/**
 * `ensureInTransitBinInTx` — the QC-hold ensure's mirror (Story 5-1): zone
 * first, then the bin, each ensure-or-reselect inside the CALLER's
 * transaction; a concurrent first transfer races on the unique indexes and
 * the loser re-selects the winner's rows, both landing on one bin. Migration
 * 0043 seeded this pair for every warehouse that already existed; this helper
 * covers warehouses created afterwards (and re-selects the 0043 rows when a
 * transfer is the warehouse's first movement).
 */
export async function ensureInTransitBinInTx(
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
      code: IN_TRANSIT_ZONE_CODE,
      name: 'In Transit',
    })
    .onConflictDoNothing({ target: [zones.warehouseId, zones.code] });
  const zoneRows = await tx
    .select({ id: zones.id })
    .from(zones)
    .where(
      and(eq(zones.tenantId, tenantId), eq(zones.warehouseId, warehouseId), eq(zones.code, IN_TRANSIT_ZONE_CODE)),
    )
    .limit(1);
  const zone = zoneRows[0];
  if (zone === undefined) {
    // Unreachable short of an RLS/scope bug — fail loudly rather than
    // guess an id.
    throw new Error(`in-transit zone missing after ensure: ${tenantId}/${warehouseId}`);
  }

  await tx
    .insert(bins)
    .values({
      id: uuidv7(),
      tenantId,
      warehouseId,
      zoneId: zone.id,
      code: IN_TRANSIT_BIN_CODE,
      capacity: IN_TRANSIT_BIN_CAPACITY,
      type: IN_TRANSIT_BIN_TYPE,
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
        eq(bins.code, IN_TRANSIT_BIN_CODE),
        // The identity that feeds `inTransitUnits` is code + system-owned: a
        // user-created bin named `IN-TRANSIT` is not the in-transit bin —
        // adopting it would park stock where the ATP hook counts zero.
        // Refuse loudly rather than silently break the hook (the QC-hold
        // ensure's precedent).
        eq(bins.systemOwned, true),
      ),
    )
    .limit(1);
  const bin = binRows[0];
  if (bin === undefined) {
    // A user-created bin named `IN-TRANSIT` occupies the code (the insert
    // above was a no-op on the unique (warehouse, code) index) — adopting it
    // would park stock where the ATP hook counts zero, so the refusal is a
    // typed problem the caller can render, naming the remediation, not an
    // untyped 500 (review round 1; the migration's pre-flight is the bulk
    // remediation, this is the per-warehouse answer for master data created
    // after it ran).
    throw new ProblemException(
      'transfer-in-transit-bin-conflict',
      409,
      'A user bin named IN-TRANSIT exists',
      `Warehouse "${warehouseId}" already holds a user bin coded "IN-TRANSIT" — the system in-transit bin cannot be ensured. Rename or retire that bin, then retry the transfer.`,
    );
  }
  return { zoneId: zone.id, binId: bin.id };
}

/**
 * The system RETURNS bin (story 13-2): every warehouse owns exactly one,
 * lazily ensured by the first return receipt — the fourth copy of the
 * IN-TRANSIT shape (zone + bin code `RETURNS`, `system_owned`, `staging`, the
 * 1M sentinel). It IS the epic's "received, awaiting disposition" state: a
 * place the projections already sum, so ATP subtracts it as one term
 * (`returnsAwaitingUnits`, keyed on code + system-owned — the `qcHeldUnits`
 * identity) and replay-reconciliation reproduces it for free. Only the
 * returns module moves stock INTO it (`return.received`); only 13-3's
 * disposition moves stock out. Count, transfer, merge, pick, replan and
 * putaway already exclude system-owned bins; the adjustment and the QC-hold
 * origin refuse it by code.
 */
export const RETURNS_ZONE_CODE = 'RETURNS';
export const RETURNS_BIN_CODE = 'RETURNS';
export const RETURNS_BIN_TYPE = 'staging';
/** Effectively unbounded: receiving a return is never capacity-gated (milli-units). */
export const RETURNS_BIN_CAPACITY = 1_000_000 * QUANTITY_SCALE;

/**
 * Story 2-4a — the system DAMAGED bin: every warehouse owns at most one,
 * lazily ensured by the first receipt that carries damaged units — the
 * RETURNS ensure's twin (zone + bin code `DAMAGED`, `system_owned`,
 * `staging`, the 1M sentinel). Damaged units arrive straight into it
 * (`grn.damaged`) and sit on-hand but NOT SELLABLE: inventory's
 * `damagedUnits` subtracts it from ATP (code + system-owned identity), so
 * reservations, channel publish and replenishment never see them. They leave
 * only by a write-off — a NEGATIVE stock adjustment (decision 3; a 400
 * `damaged-bin-write-off-only` refuses anything else). Count, transfer,
 * merge, pick, replan and putaway already exclude system-owned bins; the QC
 * hold origin refuses it by code.
 */
export const DAMAGED_ZONE_CODE = 'DAMAGED';
export const DAMAGED_BIN_CODE = 'DAMAGED';
export const DAMAGED_BIN_TYPE = 'staging';
/** Effectively unbounded: booking damaged arrivals is never capacity-gated (milli-units). */
export const DAMAGED_BIN_CAPACITY = 1_000_000 * QUANTITY_SCALE;

/**
 * The zone and bin codes reserved for system pairs that are ensured lazily
 * and never adopt a user's location: RETURNS (story 13-2) and DAMAGED
 * (story 2-4a). A user zone or bin with one of these codes is refused at
 * CREATE (409 `reserved-location-code`), so nothing can occupy the code
 * before the warehouse's first return receipt or damaged receipt ensures it.
 * A collision created before the rule still answers `returns-bin-conflict` /
 * `damaged-bin-conflict` at the ensure.
 */
export const RESERVED_LOCATION_CODES: Readonly<Record<string, string>> = {
  [RETURNS_BIN_CODE]: 'returns',
  [DAMAGED_BIN_CODE]: 'damaged',
};

export function assertNotReservedLocationCode(code: string, what: 'zone' | 'bin'): void {
  const system = Object.prototype.hasOwnProperty.call(RESERVED_LOCATION_CODES, code) ? RESERVED_LOCATION_CODES[code] : undefined;
  if (system !== undefined) {
    throw new ProblemException(
      'reserved-location-code',
      409,
      'Location code is reserved',
      `${what === 'zone' ? 'Zone' : 'Bin'} code "${code}" is reserved for the system ${system} ${what} — choose another code.`,
      { code },
    );
  }
}

/** 409 `returns-bin-conflict` — a user zone or bin occupies the `RETURNS` code. */
export function returnsBinConflict(warehouseId: string, what: 'zone' | 'bin'): ProblemException {
  return new ProblemException(
    'returns-bin-conflict',
    409,
    `A user ${what} named RETURNS exists`,
    `Warehouse "${warehouseId}" already holds a user ${what} coded "RETURNS" — the system returns bin cannot be ensured. Rename or retire that ${what}, then receive the return again.`,
    { warehouseId },
  );
}

/**
 * 409 `damaged-bin-conflict` — a user zone or bin occupies the `DAMAGED`
 * code. DEFENSIVE ONLY (code review CR1): migration 0087 re-coded every
 * pre-rule user location coded DAMAGED and create reserves the code, so this
 * is unreachable short of a direct database write. A collision cannot be
 * cleared from the product (codes cannot be renamed; a retired bin keeps its
 * code; zones cannot be retired), so the detail names the location for an
 * administrator to re-code, never a retire.
 */
export function damagedBinConflict(warehouseId: string, what: 'zone' | 'bin', locationId: string): ProblemException {
  return new ProblemException(
    'damaged-bin-conflict',
    409,
    `A user ${what} named DAMAGED exists`,
    `Warehouse "${warehouseId}" holds a user ${what} (id "${locationId}") coded "DAMAGED", the code reserved for the system damaged ${what} — damaged units cannot be booked until an administrator re-codes it (migration 0087 re-codes such locations). Nothing was recorded.`,
    { warehouseId, locationId },
  );
}

/**
 * `ensureReturnsBinInTx` — the IN-TRANSIT ensure's mirror (story 13-2), with
 * one tightening: a user ZONE named `RETURNS` is refused too, never adopted.
 * Zones carry no system flag, so the system zone is recognised by what the
 * ensure itself creates: this call inserted it, or it already held the
 * system-owned `RETURNS` bin before this call (written in the same
 * transaction as the zone by whichever first receipt created it — a
 * concurrent loser's zone insert waits on the winner's uncommitted row and
 * then finds both). A pre-existing zone that did not already hold the system
 * `RETURNS` bin is a user's zone: 409. A user BIN coded
 * `RETURNS` anywhere in the warehouse is the IN-TRANSIT precedent's 409.
 */
export async function ensureReturnsBinInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
): Promise<ReceivingBinRef> {
  return ensureReservedSystemBinInTx(tx, tenantId, warehouseId, {
    zoneCode: RETURNS_ZONE_CODE,
    binCode: RETURNS_BIN_CODE,
    zoneName: 'Returns',
    capacity: RETURNS_BIN_CAPACITY,
    type: RETURNS_BIN_TYPE,
    conflict: (id, what) => returnsBinConflict(id, what),
  });
}

/**
 * `ensureDamagedBinInTx` — story 2-4a: the RETURNS ensure, for the DAMAGED
 * pair (the same tightening — a user ZONE or BIN coded `DAMAGED` is a 409
 * `damaged-bin-conflict`, never adopted). Called by a receipt only when one
 * of its settling lines carries damage, so a warehouse with a pre-rule
 * collision still receives good-only deliveries.
 */
export async function ensureDamagedBinInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
): Promise<ReceivingBinRef> {
  return ensureReservedSystemBinInTx(tx, tenantId, warehouseId, {
    zoneCode: DAMAGED_ZONE_CODE,
    binCode: DAMAGED_BIN_CODE,
    zoneName: 'Damaged',
    capacity: DAMAGED_BIN_CAPACITY,
    type: DAMAGED_BIN_TYPE,
    conflict: damagedBinConflict,
  });
}

/**
 * The shared body of the reserved system-bin ensures (RETURNS, DAMAGED) —
 * extracted unchanged from story 13-2's `ensureReturnsBinInTx`. Zones carry
 * no system flag, so the system zone is recognised by what the ensure itself
 * creates: this call inserted it, or it already held the system-owned bin
 * before this call (written in the same transaction as the zone by whichever
 * first call created it — a concurrent loser's zone insert waits on the
 * winner's uncommitted row and then finds both). A pre-existing zone that did
 * not already hold the system bin is a user's zone: 409. A user BIN with the
 * code anywhere in the warehouse is the IN-TRANSIT precedent's 409.
 */
async function ensureReservedSystemBinInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  pair: {
    readonly zoneCode: string;
    readonly binCode: string;
    readonly zoneName: string;
    readonly capacity: number;
    readonly type: string;
    readonly conflict: (warehouseId: string, what: 'zone' | 'bin', locationId: string) => ProblemException;
  },
): Promise<ReceivingBinRef> {
  // The bin first: once ensured it is the identity, whatever its zone is
  // called now (a renamed system zone must not breed a stray zone and a
  // wrong zoneId). A user bin holding the code is the 409.
  const existing = await tx
    .select({ id: bins.id, zoneId: bins.zoneId, systemOwned: bins.systemOwned })
    .from(bins)
    .where(and(eq(bins.tenantId, tenantId), eq(bins.warehouseId, warehouseId), eq(bins.code, pair.binCode)))
    .limit(1);
  if (existing[0] !== undefined) {
    if (!existing[0].systemOwned) throw pair.conflict(warehouseId, 'bin', existing[0].id);
    return { zoneId: existing[0].zoneId, binId: existing[0].id };
  }
  const insertedZone = await tx
    .insert(zones)
    .values({
      id: uuidv7(),
      tenantId,
      warehouseId,
      code: pair.zoneCode,
      name: pair.zoneName,
    })
    .onConflictDoNothing({ target: [zones.warehouseId, zones.code] })
    .returning({ id: zones.id });
  const zoneRows = await tx
    .select({ id: zones.id })
    .from(zones)
    .where(and(eq(zones.tenantId, tenantId), eq(zones.warehouseId, warehouseId), eq(zones.code, pair.zoneCode)))
    .limit(1);
  const zone = zoneRows[0];
  if (zone === undefined) {
    // Unreachable short of an RLS/scope bug — fail loudly rather than
    // guess an id.
    throw new Error(`${pair.zoneCode} zone missing after ensure: ${tenantId}/${warehouseId}`);
  }

  const insertedBin = await tx
    .insert(bins)
    .values({
      id: uuidv7(),
      tenantId,
      warehouseId,
      zoneId: zone.id,
      code: pair.binCode,
      capacity: pair.capacity,
      type: pair.type,
      systemOwned: true,
    })
    .onConflictDoNothing({ target: [bins.warehouseId, bins.code] })
    .returning({ id: bins.id });
  const binRows = await tx
    .select({ id: bins.id, zoneId: bins.zoneId, systemOwned: bins.systemOwned })
    .from(bins)
    .where(and(eq(bins.tenantId, tenantId), eq(bins.warehouseId, warehouseId), eq(bins.code, pair.binCode)))
    .limit(1);
  const bin = binRows[0];
  if (bin === undefined) {
    throw new Error(`${pair.binCode} bin missing after ensure: ${tenantId}/${warehouseId}`);
  }
  // The identity that feeds the ATP hook (`returnsAwaitingUnits`,
  // `damagedUnits`) is code + system-owned: a user-created bin with the code
  // is not the system bin — adopting it would park units where the ATP hook
  // counts zero, i.e. sellable.
  if (!bin.systemOwned) {
    throw pair.conflict(warehouseId, 'bin', bin.id);
  }
  // A zone this call did not create must ALREADY have held the system bin
  // (written with it by the call that created it) — a pre-existing zone
  // into which this call just inserted the bin is a user's zone with the
  // code, never adopted (the throw rolls the insert back).
  if (insertedZone.length === 0 && (insertedBin.length > 0 || bin.zoneId !== zone.id)) {
    throw pair.conflict(warehouseId, 'zone', zone.id);
  }
  return { zoneId: zone.id, binId: bin.id };
}
