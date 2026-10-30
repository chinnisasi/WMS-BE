/**
 * Story 4-5a (A45, D13) — ONE warehouse party projection for every document
 * that prints a warehouse: the GRN (2-9a), the packing slip and the carton
 * label (4-5a), and the RTV / RTC package labels. Mapped key by key from the
 * `{code, name, gstin, originAddress}` shape the live warehouse read and every
 * frozen `warehouse_snapshot` share, so the origin address's contact name and
 * phone never enter a document (guide §7q).
 *
 * Pure, and free of module imports (it lives in `shared/`): the input is
 * structural.
 */

/** The origin address as the warehouse read and the frozen snapshots carry it (contact and phone may ride beside). */
export interface WarehouseOriginAddressInput {
  readonly line1: string;
  readonly line2?: string | null | undefined;
  readonly city: string;
  readonly state: string;
  readonly pincode: string;
}

export interface WarehouseSnapshotInput {
  readonly code: string;
  readonly name: string;
  readonly gstin: string | null;
  readonly originAddress: WarehouseOriginAddressInput | null;
}

/** The warehouse a document prints: no contact name, no phone. */
export interface DocumentWarehouseParty {
  readonly code: string;
  readonly name: string;
  readonly gstin: string | null;
  readonly address: {
    readonly line1: string;
    readonly line2: string | null;
    readonly city: string;
    readonly state: string;
    readonly pincode: string;
  } | null;
}

export function documentWarehousePartyOf(snapshot: WarehouseSnapshotInput): DocumentWarehouseParty {
  const origin = snapshot.originAddress;
  return {
    code: snapshot.code,
    name: snapshot.name,
    gstin: snapshot.gstin,
    address:
      origin === null
        ? null
        : { line1: origin.line1, line2: origin.line2 ?? null, city: origin.city, state: origin.state, pincode: origin.pincode },
  };
}
