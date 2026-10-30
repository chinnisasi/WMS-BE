import type { ClientPartySnapshotV1 } from '../clients/clients.facade';
import type { VendorSnapshotV1 } from '../partners/partners.facade';
import type { RtvWarehouseSnapshotV1 } from './vendor-return.read';
import { documentWarehousePartyOf } from '../../shared/documents/parties';

/**
 * Story 2-9a — the GRN document: the shapes the freeze writes and the one
 * model every door (the staff web, the client portal, the receipt email)
 * renders from. Pure types plus the two pure mappers the freeze and the
 * legacy read share.
 */

/**
 * The warehouse as a GRN prints it (A3): code, name, GSTIN, the origin
 * address WITHOUT its contact name and phone, and the operator (the
 * tenant's name). Mapped key by key from `liveWarehouseSnapshotInTx`, so no
 * person ever enters `document_parties`.
 */
export interface GrnWarehousePartyV1 {
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
  readonly operatorName: string;
}

/**
 * `goods_receipt_notes.document_parties` (0115
 * `goods_receipt_notes_document_parties_shape`): every key present, frozen by
 * `grn.submit` and never rewritten. `vendor` is the PO's own frozen vendor
 * (1-3) — null on an ASN or blind receipt, and on a pre-1-3 PO without one.
 */
export interface GrnPartiesSnapshotV1 {
  readonly v: 1;
  readonly warehouse: GrnWarehousePartyV1;
  readonly client: ClientPartySnapshotV1 | null;
  readonly vendor: VendorSnapshotV1 | null;
}

/**
 * A3 — the GRN's warehouse party from the RTV's live warehouse read, key by
 * key (no contact name, no phone). Story 4-5a (D13): the mapping is the one
 * shared `documentWarehousePartyOf`, plus the operator — same values, so the
 * GRN goldens are unchanged.
 */
export function grnWarehousePartyOf(live: RtvWarehouseSnapshotV1): GrnWarehousePartyV1 {
  return { ...documentWarehousePartyOf(live), operatorName: live.operatorName };
}

export type GrnDocumentKind = 'po' | 'asn' | 'blind';
export type GrnQcStatus = 'on-hold' | 'released' | 'inspected';

/** One line's QC outcome from QC's own record (decision 9, A8): milli-units. */
export interface GrnLineQc {
  readonly status: GrnQcStatus | null;
  /** = released + passed + failed + still on hold. */
  readonly heldMilli: number;
  readonly onHoldMilli: number;
  readonly releasedMilli: number;
  readonly passedMilli: number;
  readonly failedMilli: number;
}

export interface GrnDocumentLine {
  readonly id: string;
  readonly lineNo: number;
  readonly skuCode: string;
  readonly skuName: string;
  /** The line SKU's client code (A8 — a mixed-client GRN's per-line client). */
  readonly clientCode: string;
  readonly uom: string;
  readonly uomPrecision: number;
  readonly batchCode: string | null;
  /** IST calendar dates (D11). */
  readonly mfgDate: string | null;
  readonly expiryDate: string | null;
  readonly expirySource: 'typed' | 'derived' | null;
  /** The PO line's ordered or the ASN line's announced quantity, as at print; null on a blind or unmatched line. */
  readonly expectedMilli: number | null;
  /** `goods_receipt_lines.qty` — the good units, an excess included. */
  readonly goodMilli: number;
  readonly damagedMilli: number;
  readonly damageReasonCode: string | null;
  readonly shortMilli: number;
  readonly shortReasonCode: string | null;
  readonly toleranceMilli: number;
  readonly excess: { readonly pendingMilli: number; readonly approvedMilli: number; readonly rejectedMilli: number };
  readonly qc: GrnLineQc;
  /** Serial rows `applied` + `pending` (A8). */
  readonly serialCount: number;
  readonly unreadableSerialCount: number;
  readonly rejectedSerialCount: number;
  /** Attached damage photos. */
  readonly photoCount: number;
}

export interface GrnArrival {
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
  /** Only the documents A9 admits. */
  readonly documents: readonly {
    readonly kind: string;
    readonly number: string;
    readonly date: string;
    readonly ewayBillNo: string | null;
  }[];
  /** True when the gate-in carried a document this GRN does not print. */
  readonly documentsOmitted: boolean;
}

export interface GrnDocument {
  readonly id: string;
  readonly code: string;
  /** `occurred_at` — when the goods were received (the device time). */
  readonly receivedAt: string;
  readonly recordedAt: string;
  readonly printedAt: string;
  /** Null on an older build's mixed-client receipt (staff only). */
  readonly clientId: string | null;
  readonly parties: {
    /** False on a GRN recorded before 2-9a: the parties printed are the live ones. */
    readonly frozen: boolean;
    readonly warehouse: GrnWarehousePartyV1;
    readonly client: ClientPartySnapshotV1 | null;
    readonly vendor: VendorSnapshotV1 | null;
  };
  readonly document: {
    readonly kind: GrnDocumentKind;
    /** The PO or ASN code; null on a blind receipt. */
    readonly code: string | null;
    readonly blindReasonCode: string | null;
  };
  readonly arrival: GrnArrival | null;
  readonly lines: readonly GrnDocumentLine[];
}

/** The totals per UoM, in first-appearance order (milli-units). */
export interface GrnUomTotals {
  readonly uom: string;
  readonly uomPrecision: number;
  readonly goodMilli: number;
  readonly damagedMilli: number;
  readonly shortMilli: number;
}

export function grnTotals(doc: Pick<GrnDocument, 'lines'>): { readonly lineCount: number; readonly byUom: readonly GrnUomTotals[] } {
  const groups = new Map<string, { uom: string; uomPrecision: number; goodMilli: number; damagedMilli: number; shortMilli: number }>();
  for (const line of doc.lines) {
    const group = groups.get(line.uom) ?? { uom: line.uom, uomPrecision: line.uomPrecision, goodMilli: 0, damagedMilli: 0, shortMilli: 0 };
    group.goodMilli += line.goodMilli;
    group.damagedMilli += line.damagedMilli;
    group.shortMilli += line.shortMilli;
    groups.set(line.uom, group);
  }
  return { lineCount: doc.lines.length, byUom: [...groups.values()] };
}

/** `{GRN code}.pdf` / `{GRN code}-lines.csv`, ASCII-only (decision 12; the web builds the same name). */
export function grnDocumentFilename(code: string, format: 'pdf' | 'csv'): string {
  const safe = code.replace(/[^A-Za-z0-9._-]/g, '_') || 'GRN';
  return format === 'pdf' ? `${safe}.pdf` : `${safe}-lines.csv`;
}
