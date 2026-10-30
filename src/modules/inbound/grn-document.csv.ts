import { buildCsv } from '../../shared/export/csv';
import type { ExportCell, ExportColumn } from '../../shared/export/cells';
import { fromMilli } from '../../shared/primitives/quantity';
import { istMidnightOf } from '../../shared/primitives/time';
import type { GrnDocument } from './grn-document.types';

/**
 * Story 2-9a (decision 10, A8) — the GRN's lines as a CSV: one row per GRN
 * line with the header facts repeated, over the shared typed-cell writer
 * (guide §6 "a file built from rows": UTF-8 with the BOM, the formula guard
 * on text cells only, numbers raw). Quantities are numbers in base units
 * (`fromMilli`); a reason cell carries the CODE, empty when its quantity is
 * 0; `clientCode` is the line SKU's client (a mixed-client GRN's lines name
 * their own). Names keep every script (the PDF folds; the CSV does not).
 * At most 200 lines (the submit's `@ArrayMaxSize(200)`), so no XLSX.
 */
export const GRN_CSV_COLUMNS: readonly ExportColumn[] = [
  { header: 'grnCode', kind: 'text' },
  { header: 'receivedAt', kind: 'instant' },
  { header: 'recordedAt', kind: 'instant' },
  { header: 'warehouseCode', kind: 'text' },
  { header: 'clientCode', kind: 'text' },
  { header: 'documentKind', kind: 'text' },
  { header: 'documentCode', kind: 'text' },
  { header: 'lineNo', kind: 'number' },
  { header: 'skuCode', kind: 'text' },
  { header: 'skuName', kind: 'text' },
  { header: 'uom', kind: 'text' },
  { header: 'batchCode', kind: 'text' },
  { header: 'mfgDate', kind: 'date' },
  { header: 'expiryDate', kind: 'date' },
  { header: 'expirySource', kind: 'text' },
  { header: 'expectedQty', kind: 'number' },
  { header: 'goodQty', kind: 'number' },
  { header: 'damagedQty', kind: 'number' },
  { header: 'damageReason', kind: 'text' },
  { header: 'shortQty', kind: 'number' },
  { header: 'shortReason', kind: 'text' },
  { header: 'excessPendingQty', kind: 'number' },
  { header: 'excessApprovedQty', kind: 'number' },
  { header: 'excessRejectedQty', kind: 'number' },
  { header: 'toleranceQty', kind: 'number' },
  { header: 'qcStatus', kind: 'text' },
  { header: 'qcHeldQty', kind: 'number' },
  { header: 'qcReleasedQty', kind: 'number' },
  { header: 'qcPassedQty', kind: 'number' },
  { header: 'qcFailedQty', kind: 'number' },
  { header: 'serialCount', kind: 'number' },
  { header: 'unreadableSerialCount', kind: 'number' },
  { header: 'rejectedSerialCount', kind: 'number' },
  { header: 'photoCount', kind: 'number' },
];

const calendarDate = (date: string | null): Date | null => (date === null ? null : new Date(istMidnightOf(date)));

export function grnDocumentCsv(doc: GrnDocument): Buffer {
  const rows: ExportCell[][] = doc.lines.map((line) => [
    doc.code,
    new Date(doc.receivedAt),
    new Date(doc.recordedAt),
    doc.parties.warehouse.code,
    line.clientCode,
    doc.document.kind,
    doc.document.code,
    line.lineNo,
    line.skuCode,
    line.skuName,
    line.uom,
    line.batchCode,
    calendarDate(line.mfgDate),
    calendarDate(line.expiryDate),
    line.expirySource,
    line.expectedMilli === null ? null : fromMilli(line.expectedMilli),
    fromMilli(line.goodMilli),
    fromMilli(line.damagedMilli),
    line.damagedMilli > 0 ? line.damageReasonCode : null,
    fromMilli(line.shortMilli),
    line.shortMilli > 0 ? line.shortReasonCode : null,
    fromMilli(line.excess.pendingMilli),
    fromMilli(line.excess.approvedMilli),
    fromMilli(line.excess.rejectedMilli),
    fromMilli(line.toleranceMilli),
    line.qc.status,
    fromMilli(line.qc.heldMilli),
    fromMilli(line.qc.releasedMilli),
    fromMilli(line.qc.passedMilli),
    fromMilli(line.qc.failedMilli),
    line.serialCount,
    line.unreadableSerialCount,
    line.rejectedSerialCount,
    line.photoCount,
  ]);
  return buildCsv(GRN_CSV_COLUMNS, rows);
}
