import { and, eq } from 'drizzle-orm';
import { clientReturns } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { documentWarehousePartyOf, type WarehouseSnapshotInput } from '../../shared/documents/parties';
import { labelShipperOf, type LabelConsignee } from '../../shared/labels/shipping/carton-label';
import { packageLabelsFile, resolvePackageRange, type PackageLabelQuery, type PackageLabelsFile } from '../../shared/labels/shipping/package-labels-file';
import { UUID_RE } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import type { ClientPartySnapshotV1 } from '../clients/clients.facade';
import { getWarehouseCodeInTx, invoicePartyFactsInTx } from '../tenancy/tenancy.service';
import { clientReturnNotFound, type ConsigneeAddressV1 } from './client-return.read';

/**
 * Story 4-5a (A22, A43, A45, D14) — the 4×6 package labels of a return to
 * client (4-7c): FROM the brand (its frozen `client_snapshot`) c/o the
 * warehouse (the frozen `warehouse_snapshot` once dispatched, else the live
 * read — one projection, `documentWarehousePartyOf`), TO the RTC's frozen
 * `consignee_address`, `RETURN TO CLIENT {code}`, `PACKAGE n/N`, the carrier
 * and tracking ref once dispatched, and the barcode `{code}.{n}`. A read on
 * the caller's transaction (`labels.execute` is checked before it).
 */
export async function clientReturnPackageLabelsInTx(tx: TenantTx, tenantId: string, clientReturnId: string, query: PackageLabelQuery): Promise<PackageLabelsFile> {
  const rows = UUID_RE.test(clientReturnId)
    ? await tx
        .select()
        .from(clientReturns)
        .where(and(eq(clientReturns.tenantId, tenantId), eq(clientReturns.id, clientReturnId.toLowerCase())))
        .limit(1)
    : [];
  const row = rows[0];
  if (row === undefined) throw clientReturnNotFound(clientReturnId);
  if (row.status !== 'picked' && row.status !== 'dispatched') {
    throw new ProblemException(
      'rtc-not-picked',
      409,
      'The return to client is not picked',
      row.status === 'draft'
        ? `${row.code} has not been picked yet — its package labels print once it is picked.`
        : `${row.code} is ${row.status} — only a picked or dispatched return to client prints package labels.`,
      { rtcStatus: row.status },
    );
  }
  const range = resolvePackageRange(query, { documentCode: row.code, dispatched: row.status === 'dispatched', packageCount: row.packageCount });
  const client = row.clientSnapshot as ClientPartySnapshotV1;
  const address = row.consigneeAddress as ConsigneeAddressV1;
  const frozen = row.warehouseSnapshot as WarehouseSnapshotInput | null;
  const warehouse: WarehouseSnapshotInput =
    frozen ??
    (await (async () => {
      const party = await invoicePartyFactsInTx(tx, tenantId, row.warehouseId);
      return { code: await getWarehouseCodeInTx(tx, tenantId, row.warehouseId), name: party.warehouseName, gstin: party.warehouseGstin, originAddress: party.originAddress };
    })());
  const consignee: LabelConsignee = {
    contactName: address.contactName ?? client.name,
    legalName: client.legalName !== null && client.legalName !== (address.contactName ?? client.name) ? client.legalName : null,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state ?? (address.stateCode === null ? '' : `State code ${address.stateCode}`),
    pincode: address.pincode,
    phone: address.phone,
    gstin: row.consigneeGstin ?? client.gstin,
  };
  return packageLabelsFile({
    kind: 'rtc',
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
