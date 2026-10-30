import { and, eq } from 'drizzle-orm';
import { vendorReturns } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { documentWarehousePartyOf } from '../../shared/documents/parties';
import { labelShipperOf, type LabelConsignee } from '../../shared/labels/shipping/carton-label';
import {
  consigneeAddressMissing,
  packageLabelsFile,
  resolvePackageRange,
  type PackageLabelQuery,
  type PackageLabelsFile,
} from '../../shared/labels/shipping/package-labels-file';
import { UUID_RE } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import type { ClientPartySnapshotV1 } from '../clients/clients.facade';
import type { VendorSnapshotV1 } from '../partners/partners.facade';
import {
  consigneeAddressOf,
  liveWarehouseSnapshotInTx,
  vendorReturnNotFound,
  type RtvWarehouseSnapshotV1,
} from './vendor-return.read';
import type { RtvConsigneeAddressKind } from './vendor-return.command';

/**
 * Story 4-5a (A22, A43, A45, D14) — the 4×6 package labels of a return to
 * vendor: FROM the brand (its frozen `client_snapshot`) c/o the warehouse (the
 * frozen `warehouse_snapshot` once dispatched, else the live read — one
 * projection, `documentWarehousePartyOf`), TO the vendor's frozen address of
 * the RTV's consignee kind, `RETURN TO VENDOR {code}`, `PACKAGE n/N`, the
 * carrier and tracking ref once dispatched, and the barcode `{code}.{n}`.
 * A read on the caller's transaction (`labels.execute` is checked before it).
 */
export async function vendorReturnPackageLabelsInTx(tx: TenantTx, tenantId: string, vendorReturnId: string, query: PackageLabelQuery): Promise<PackageLabelsFile> {
  const rows = UUID_RE.test(vendorReturnId)
    ? await tx
        .select()
        .from(vendorReturns)
        .where(and(eq(vendorReturns.tenantId, tenantId), eq(vendorReturns.id, vendorReturnId.toLowerCase())))
        .limit(1)
    : [];
  const row = rows[0];
  if (row === undefined) throw vendorReturnNotFound(vendorReturnId);
  if (row.status !== 'picked' && row.status !== 'dispatched') {
    throw new ProblemException(
      'rtv-not-picked',
      409,
      'The return to vendor is not picked',
      row.status === 'draft'
        ? `${row.code} has not been picked yet — its package labels print once it is picked.`
        : `${row.code} is ${row.status} — only a picked or dispatched return to vendor prints package labels.`,
      { rtvStatus: row.status },
    );
  }
  const vendor = row.vendorSnapshot as VendorSnapshotV1;
  const address = consigneeAddressOf(vendor, row.consigneeAddressKind as RtvConsigneeAddressKind);
  if (address === null) throw consigneeAddressMissing(row.code, vendor.name);
  const range = resolvePackageRange(query, { documentCode: row.code, dispatched: row.status === 'dispatched', packageCount: row.packageCount });
  const client = row.clientSnapshot as ClientPartySnapshotV1;
  const warehouse = (row.warehouseSnapshot as RtvWarehouseSnapshotV1 | null) ?? (await liveWarehouseSnapshotInTx(tx, tenantId, row.warehouseId));
  const consignee: LabelConsignee = {
    contactName: vendor.name,
    legalName: vendor.legalName !== null && vendor.legalName !== vendor.name ? vendor.legalName : null,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: `State code ${address.stateCode}`,
    pincode: address.pincode,
    phone: null,
    gstin: vendor.gstin,
  };
  return packageLabelsFile({
    kind: 'rtv',
    documentCode: row.code,
    shipper: labelShipperOf(client.name, documentWarehousePartyOf(warehouse)),
    consignee,
    carrierName: row.status === 'dispatched' ? row.carrierName : null,
    trackingRef: row.status === 'dispatched' ? row.trackingRef : null,
    range,
    query,
    printedAt: nowIso(),
  });
}
