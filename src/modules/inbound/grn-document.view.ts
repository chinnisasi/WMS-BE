import { drawDocumentPdf } from '../../shared/documents/a4-pdf';
import { fromMilli } from '../../shared/primitives/quantity';
import { grnDocumentCsv } from './grn-document.csv';
import { grnDocumentRef, grnPartyBlocks, layoutGrnDocument } from './grn-document.layout';
import { grnDocumentFilename, grnTotals, type GrnDocument, type GrnDocumentKind, type GrnQcStatus } from './grn-document.types';
import { blindReasonLabelOf, damageReasonLabelOf, shortReasonLabelOf } from './receipt-condition';

/**
 * Story 2-9a — the GRN document's two outputs over the one model: the JSON
 * view (the staff drawer's `GoodsReceiptDocumentDto`; the portal detail picks
 * its keys from it, key by key) and the file (`render(layout(read))` — the
 * ONE function the staff route, the portal route and the mail renderer call).
 * Quantities are base units at this edge (`fromMilli`); reasons carry their
 * code AND label.
 */

export type GrnDocumentFormat = 'pdf' | 'csv';

export interface GrnDocumentFile {
  readonly filename: string;
  readonly contentType: string;
  readonly body: Buffer;
}

export async function grnDocumentFile(doc: GrnDocument, format: GrnDocumentFormat): Promise<GrnDocumentFile> {
  if (format === 'csv') {
    return { filename: grnDocumentFilename(doc.code, 'csv'), contentType: 'text/csv; charset=utf-8', body: grnDocumentCsv(doc) };
  }
  const body = await drawDocumentPdf(layoutGrnDocument(doc), { title: `Goods Receipt Note ${doc.code}`, creationDate: doc.printedAt });
  return { filename: grnDocumentFilename(doc.code, 'pdf'), contentType: 'application/pdf', body };
}

export interface GrnAddressView {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  /** The warehouse's state name, or a client/vendor address's `State code {nn}` (A8). */
  readonly state: string;
  readonly pincode: string;
}

export interface GrnPartyView {
  readonly code: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly address: GrnAddressView | null;
}

export interface GrnPartiesView {
  readonly frozen: boolean;
  readonly warehouse: GrnPartyView & { readonly operatorName: string };
  /** Null on an older build's mixed-client receipt (staff only). */
  readonly client: GrnPartyView | null;
  /** The PO's frozen vendor; null on an ASN or blind receipt, or a PO without one. */
  readonly vendor: GrnPartyView | null;
  /** The supplier block's words when there is no vendor ("As announced by the client — ASN …", …). */
  readonly supplierNote: string | null;
}

export interface GrnDocumentLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly skuCode: string;
  readonly skuName: string;
  readonly clientCode: string;
  readonly uom: string;
  readonly uomPrecision: number;
  readonly batchCode: string | null;
  readonly mfgDate: string | null;
  readonly expiryDate: string | null;
  readonly expirySource: 'typed' | 'derived' | null;
  readonly expectedQty: number | null;
  readonly goodQty: number;
  readonly damagedQty: number;
  readonly damageReasonCode: string | null;
  readonly damageReasonLabel: string | null;
  readonly shortQty: number;
  readonly shortReasonCode: string | null;
  readonly shortReasonLabel: string | null;
  readonly toleranceQty: number;
  readonly excess: { readonly pendingQty: number; readonly approvedQty: number; readonly rejectedQty: number };
  readonly qc: { readonly status: GrnQcStatus | null; readonly heldQty: number; readonly releasedQty: number; readonly passedQty: number; readonly failedQty: number };
  readonly serialCount: number;
  readonly unreadableSerialCount: number;
  readonly rejectedSerialCount: number;
  readonly photoCount: number;
}

export interface GrnArrivalView {
  readonly gateInCode: string;
  readonly vehicleNo: string | null;
  readonly containerNo: string | null;
  readonly transporterName: string | null;
  readonly lrNumber: string | null;
  readonly sealStatus: string;
  readonly sealNumber: string | null;
  readonly dockDoor: string | null;
  readonly gatedInAt: string;
  readonly unloadStartedAt: string | null;
  readonly unloadEndedAt: string | null;
  readonly documents: readonly { readonly kind: string; readonly number: string; readonly date: string; readonly ewayBillNo: string | null }[];
  readonly documentsOmitted: boolean;
}

export interface GrnDocumentRefView {
  readonly kind: GrnDocumentKind;
  readonly code: string | null;
  readonly blindReasonCode: string | null;
  readonly blindReasonLabel: string | null;
  /** "PO P-1", "ASN A-77", "Blind receipt (Unannounced delivery)". */
  readonly label: string;
}

export interface GrnTotalsView {
  readonly lineCount: number;
  readonly byUom: readonly { readonly uom: string; readonly goodQty: number; readonly damagedQty: number; readonly shortQty: number }[];
}

export interface GrnDocumentView {
  readonly id: string;
  readonly code: string;
  readonly receivedAt: string;
  readonly recordedAt: string;
  readonly printedAt: string;
  readonly parties: GrnPartiesView;
  readonly document: GrnDocumentRefView;
  readonly arrival: GrnArrivalView | null;
  readonly lines: readonly GrnDocumentLineView[];
  readonly totals: GrnTotalsView;
}

function partiesView(doc: GrnDocument): GrnPartiesView {
  const { warehouse, client, vendor } = doc.parties;
  const stateCode = (code: string) => `State code ${code}`;
  const supplierBlock = grnPartyBlocks(doc)[2]!;
  return {
    frozen: doc.parties.frozen,
    warehouse: {
      code: warehouse.code,
      name: warehouse.name,
      legalName: null,
      gstin: warehouse.gstin,
      address:
        warehouse.address === null
          ? null
          : { line1: warehouse.address.line1, line2: warehouse.address.line2, city: warehouse.address.city, state: warehouse.address.state, pincode: warehouse.address.pincode },
      operatorName: warehouse.operatorName,
    },
    client:
      client === null
        ? null
        : {
            code: client.code,
            name: client.name,
            legalName: client.legalName,
            gstin: client.gstin,
            address:
              client.registeredAddress === null
                ? null
                : {
                    line1: client.registeredAddress.line1,
                    line2: client.registeredAddress.line2 ?? null,
                    city: client.registeredAddress.city,
                    state: stateCode(client.registeredAddress.stateCode),
                    pincode: client.registeredAddress.pincode,
                  },
          },
    vendor:
      vendor === null || doc.document.kind !== 'po'
        ? null
        : (() => {
            const address = vendor.dispatchAddress ?? vendor.registeredAddress;
            return {
              code: vendor.code,
              name: vendor.name,
              legalName: vendor.legalName,
              gstin: vendor.gstin,
              address:
                address === null
                  ? null
                  : { line1: address.line1, line2: address.line2 ?? null, city: address.city, state: stateCode(address.stateCode), pincode: address.pincode },
            };
          })(),
    supplierNote: vendor !== null && doc.document.kind === 'po' ? null : (supplierBlock.fields[0] ?? null),
  };
}

export function grnDocumentView(doc: GrnDocument): GrnDocumentView {
  const totals = grnTotals(doc);
  return {
    id: doc.id,
    code: doc.code,
    receivedAt: doc.receivedAt,
    recordedAt: doc.recordedAt,
    printedAt: doc.printedAt,
    parties: partiesView(doc),
    document: {
      kind: doc.document.kind,
      code: doc.document.code,
      blindReasonCode: doc.document.blindReasonCode,
      blindReasonLabel: blindReasonLabelOf(doc.document.blindReasonCode),
      label: grnDocumentRef(doc),
    },
    arrival:
      doc.arrival === null
        ? null
        : {
            gateInCode: doc.arrival.gateInCode,
            vehicleNo: doc.arrival.vehicleNo,
            containerNo: doc.arrival.containerNo,
            transporterName: doc.arrival.transporterName,
            lrNumber: doc.arrival.lrNumber,
            sealStatus: doc.arrival.sealStatus,
            sealNumber: doc.arrival.sealNumber,
            dockDoor: doc.arrival.dockDoor,
            gatedInAt: doc.arrival.gatedInAt,
            unloadStartedAt: doc.arrival.unloadStartedAt,
            unloadEndedAt: doc.arrival.unloadEndedAt,
            documents: doc.arrival.documents.map((d) => ({ kind: d.kind, number: d.number, date: d.date, ewayBillNo: d.ewayBillNo })),
            documentsOmitted: doc.arrival.documentsOmitted,
          },
    lines: doc.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      skuCode: line.skuCode,
      skuName: line.skuName,
      clientCode: line.clientCode,
      uom: line.uom,
      uomPrecision: line.uomPrecision,
      batchCode: line.batchCode,
      mfgDate: line.mfgDate,
      expiryDate: line.expiryDate,
      expirySource: line.expirySource,
      expectedQty: line.expectedMilli === null ? null : fromMilli(line.expectedMilli),
      goodQty: fromMilli(line.goodMilli),
      damagedQty: fromMilli(line.damagedMilli),
      damageReasonCode: line.damageReasonCode,
      damageReasonLabel: damageReasonLabelOf(line.damageReasonCode),
      shortQty: fromMilli(line.shortMilli),
      shortReasonCode: line.shortReasonCode,
      shortReasonLabel: shortReasonLabelOf(line.shortReasonCode),
      toleranceQty: fromMilli(line.toleranceMilli),
      excess: {
        pendingQty: fromMilli(line.excess.pendingMilli),
        approvedQty: fromMilli(line.excess.approvedMilli),
        rejectedQty: fromMilli(line.excess.rejectedMilli),
      },
      qc: {
        status: line.qc.status,
        heldQty: fromMilli(line.qc.heldMilli),
        releasedQty: fromMilli(line.qc.releasedMilli),
        passedQty: fromMilli(line.qc.passedMilli),
        failedQty: fromMilli(line.qc.failedMilli),
      },
      serialCount: line.serialCount,
      unreadableSerialCount: line.unreadableSerialCount,
      rejectedSerialCount: line.rejectedSerialCount,
      photoCount: line.photoCount,
    })),
    totals: {
      lineCount: totals.lineCount,
      byUom: totals.byUom.map((group) => ({
        uom: group.uom,
        goodQty: fromMilli(group.goodMilli),
        damagedQty: fromMilli(group.damagedMilli),
        shortQty: fromMilli(group.shortMilli),
      })),
    },
  };
}
