import { drawDocumentPdf, type DocumentPage } from './a4-pdf';
import { DocumentFlow, LEADING, countGrouped, istLabel, kgGrouped, type FlowColumn } from './flow';
import { DOCUMENT_FONTS, documentText } from './text';
import { wrapText } from './wrap';
import { encodeCode128B } from '../labels/code128';
import { POINTS_PER_DOT } from '../labels/layout';

/**
 * Story 4-9a (A25) — the loading sheet: ONE pure function from the load's
 * model to positioned, folded runs on landscape A4, drawn by 2-9a's
 * `drawDocumentPdf`. Staff and the transporter only — never in the portal or
 * an email (it lists every client on the truck).
 *
 * Header (every page): "Loading sheet", the load code and its Code 128
 * barcode, the mode, and either the reversed "PLAN — not dispatched" band
 * (an open load) or "Dispatched {IST}", and "Printed {IST}". Then the
 * parties and the vehicle (the driver's phone is NEVER printed), the seals,
 * the Part B line and the over-capacity acknowledgement; one row per
 * consignment in LOADING order (the reverse of the stop order — last stop
 * first); the totals; and on every page the signature footer and "Page n of m".
 */

export interface LoadingSheetParty {
  readonly name: string;
  readonly gstin: string | null;
  /** Already composed address lines (none when unknown). */
  readonly addressLines: readonly string[];
}

export interface LoadingSheetRow {
  readonly stopSeq: number;
  readonly clientCode: string;
  readonly orderLabel: string;
  readonly consigneeName: string;
  readonly city: string;
  readonly pincode: string;
  readonly lrNumber: string | null;
  /** 4-6a's stamped number after departure, the live one before. */
  readonly invoiceNumber: string | null;
  readonly ewayBillNumber: string | null;
  /** An ISO date. */
  readonly ewayValidUntil: string | null;
  readonly cartons: number;
  readonly pallets: number;
  readonly weightGrams: number | null;
  /** Live-pack packages scanned onto the truck. */
  readonly loaded: number;
  /** The consignment's packages. */
  readonly total: number;
}

export interface LoadingSheetModel {
  readonly loadCode: string;
  readonly mode: 'ftl' | 'ltl';
  readonly status: 'open' | 'dispatched';
  readonly printedAt: string;
  /** Set when dispatched. */
  readonly dispatchedAt: string | null;
  /** The frozen warehouse after departure, the live one before. */
  readonly warehouse: LoadingSheetParty & { readonly code: string };
  readonly transporter: LoadingSheetParty;
  readonly vehicle: {
    readonly number: string | null;
    readonly type: string | null;
    readonly containerNumber: string | null;
    readonly capacityKg: number | null;
  };
  /** Never a phone. */
  readonly driver: { readonly name: string | null; readonly licenceNumber: string | null };
  readonly dockDoor: string | null;
  readonly seals: readonly string[];
  /** `required`: some consignment carries an e-way bill; `confirmedByName` once Part B was confirmed. */
  readonly partB: { readonly required: boolean; readonly confirmedByName: string | null };
  readonly capacityExceeded: boolean;
  readonly capacityAcknowledgedByName: string | null;
  /** In STOP order; the sheet prints them in loading order. */
  readonly rows: readonly LoadingSheetRow[];
  readonly totals: {
    readonly consignments: number;
    readonly cartons: number;
    readonly pallets: number;
    readonly loaded: number;
    readonly packages: number;
    /** Null when any consignment is unweighed. */
    readonly grossWeightGrams: number | null;
  };
}

const MARGIN = 30;
export const LOADING_SHEET_FOOTER_TOP = 92;
const FOOTER_BASELINE = 18;
const BODY = 8;
const SMALL = 7;
const TABLE = 7;
const HEADING = 9;
const BAR_MODULE_PT = 2 * POINTS_PER_DOT;
const BAR_HEIGHT_PT = 24;
const { regular, bold } = DOCUMENT_FONTS;

export const LOADING_SHEET_PLAN_BAND = (printedAt: string) => `PLAN — not dispatched, printed ${istLabel(printedAt)}`;
export const LOADING_SHEET_ORDER_NOTE = 'Load from the bottom up: last stop first.';
export const LOADING_SHEET_RECEIPT = 'Received the above packages in good order, sealed as stated.';

/** The table's columns (content width 781.89 pt on landscape A4). */
export const LOADING_SHEET_COLUMNS: readonly FlowColumn[] = [
  { header: 'Stop', width: 28, align: 'right', maxLines: 1 },
  { header: 'Client', width: 52, align: 'left', maxLines: 2 },
  { header: 'Order', width: 72, align: 'left', maxLines: 2 },
  { header: 'Consignee', width: 118, align: 'left', maxLines: 2 },
  { header: 'City / PIN', width: 82, align: 'left', maxLines: 2 },
  { header: 'LR', width: 66, align: 'left', maxLines: 2 },
  { header: 'Invoice', width: 72, align: 'left', maxLines: 2 },
  { header: 'E-way bill / valid until', width: 92, align: 'left', maxLines: 2 },
  { header: 'Cartons', width: 38, align: 'right', maxLines: 1 },
  { header: 'Pallets', width: 38, align: 'right', maxLines: 1 },
  { header: 'Weight', width: 52, align: 'right', maxLines: 1 },
  { header: 'Loaded', width: 44, align: 'right', maxLines: 1 },
  { header: 'Check', width: 27.89, align: 'left', maxLines: 1 },
];

/** "E-way bills updated with vehicle KA01AB1234 (Part B): confirmed by Asha" / "…: not confirmed". */
export function partBLine(model: Pick<LoadingSheetModel, 'vehicle' | 'partB'>): string | null {
  if (!model.partB.required) return null;
  const vehicle = model.vehicle.number ?? '—';
  return `E-way bills updated with vehicle ${vehicle} (Part B): ${model.partB.confirmedByName === null ? 'not confirmed' : `confirmed by ${model.partB.confirmedByName}`}`;
}

/** The rows in loading order: the reverse of the stop order (last drop loaded first). */
export function loadingOrder<T extends { readonly stopSeq: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.stopSeq - a.stopSeq);
}

function present(values: readonly (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

export function layoutLoadingSheet(model: LoadingSheetModel): DocumentPage[] {
  const title = documentText('Loading sheet', bold);
  const codeText = documentText(model.loadCode, bold);
  const barWidth = encodeCode128B(model.loadCode).reduce((sum, width) => sum + width, 0) * BAR_MODULE_PT;
  const modeText = model.mode === 'ftl' ? 'FTL (full truck load)' : 'LTL (part load)';
  const header = (flow: DocumentFlow) => {
    const right = flow.left + flow.contentWidth;
    flow.run(flow.left, flow.y - 16, 16, 'bold', title);
    flow.run(flow.left + bold.widthOfTextAtSize(title, 16) + 16, flow.y - 14, 13, 'bold', codeText);
    flow.page.barcodes.push({ x: right - barWidth, y: flow.y - BAR_HEIGHT_PT, height: BAR_HEIGHT_PT, moduleWidth: BAR_MODULE_PT, payload: model.loadCode });
    flow.gap(16 * LEADING + 2);
    flow.run(flow.left, flow.y - BODY, BODY, 'regular', documentText(`${modeText} · Printed ${istLabel(model.printedAt)}`, regular));
    flow.gap(BODY * LEADING + 4);
    if (model.status === 'open') {
      const band = documentText(LOADING_SHEET_PLAN_BAND(model.printedAt), bold);
      const width = bold.widthOfTextAtSize(band, 11) + 16;
      flow.page.fills.push({ x: flow.left, y: flow.y - 18, w: width, h: 18 });
      flow.run(flow.left + 8, flow.y - 13, 11, 'bold', band, true);
      flow.gap(18 + 4);
    } else {
      flow.run(flow.left, flow.y - 11, 11, 'bold', documentText(`Dispatched ${istLabel(model.dispatchedAt ?? model.printedAt)}`, bold));
      flow.gap(11 * LEADING + 4);
    }
    flow.y = Math.min(flow.y, flow.top - BAR_HEIGHT_PT - 6);
    flow.rule(flow.left, flow.y, right, flow.y, 0.75);
    flow.gap(4);
  };
  const flow = new DocumentFlow({ landscape: true, margin: MARGIN, footerTop: LOADING_SHEET_FOOTER_TOP }, header);

  // ── parties, vehicle, driver ─────────────────────────────────────────────
  const vehicle = model.vehicle;
  flow.blocks(
    [
      {
        heading: 'From',
        fields: present([`${model.warehouse.name} (${model.warehouse.code})`, model.warehouse.gstin === null ? null : `GSTIN ${model.warehouse.gstin}`, ...model.warehouse.addressLines]),
      },
      {
        heading: 'Transporter',
        fields: present([model.transporter.name, model.transporter.gstin === null ? null : `GSTIN ${model.transporter.gstin}`, ...model.transporter.addressLines]),
      },
      {
        heading: 'Vehicle',
        fields: present([
          vehicle.number ?? 'Not recorded',
          vehicle.type === null ? null : `Type ${vehicle.type}`,
          vehicle.containerNumber === null ? null : `Container ${vehicle.containerNumber}`,
          vehicle.capacityKg === null ? null : `Capacity ${kgGrouped(vehicle.capacityKg * 1000)}`,
        ]),
      },
      {
        heading: 'Driver and dock',
        fields: present([
          model.driver.name ?? 'Driver not recorded',
          model.driver.licenceNumber === null ? null : `Licence ${model.driver.licenceNumber}`,
          model.dockDoor === null ? null : `Dock ${model.dockDoor}`,
          `Seals ${model.seals.length === 0 ? '—' : model.seals.join(', ')}`,
        ]),
      },
    ],
    HEADING,
    BODY,
  );
  const partB = partBLine(model);
  if (partB !== null) flow.paragraph(partB, BODY, 'bold', 2);
  if (model.capacityExceeded) {
    flow.paragraph(`Over the stated capacity — acknowledged by ${model.capacityAcknowledgedByName ?? '—'}`, BODY, 'bold', 2);
  }
  flow.rule(flow.left, flow.y - 2, flow.left + flow.contentWidth, flow.y - 2, 0.75);
  flow.gap(4);

  // ── the consignments, in loading order ───────────────────────────────────
  flow.paragraph(LOADING_SHEET_ORDER_NOTE, BODY, 'bold', 1);
  const rows = loadingOrder(model.rows).map((row) => ({
    cells: [
      String(row.stopSeq),
      row.clientCode,
      row.orderLabel,
      row.consigneeName,
      `${row.city} ${row.pincode}`.trim(),
      row.lrNumber ?? '',
      row.invoiceNumber ?? '',
      row.ewayBillNumber === null ? '' : `${row.ewayBillNumber}${row.ewayValidUntil === null ? '' : ` / ${row.ewayValidUntil}`}`,
      String(row.cartons),
      String(row.pallets),
      row.weightGrams === null ? '' : kgGrouped(row.weightGrams),
      `${row.loaded}/${row.total}`,
      '[ ]',
    ],
  }));
  flow.table('Consignments', LOADING_SHEET_COLUMNS, rows, TABLE, HEADING);

  // ── the totals ───────────────────────────────────────────────────────────
  const t = model.totals;
  flow.gap(4);
  flow.paragraph(
    [
      `Consignments ${t.consignments}`,
      `Packages ${countGrouped(t.packages)} (${countGrouped(t.cartons)} cartons, ${countGrouped(t.pallets)} pallets)`,
      `Loaded ${countGrouped(t.loaded)} of ${countGrouped(t.packages)}`,
      `Gross weight ${t.grossWeightGrams === null ? 'not known (a consignment is unweighed)' : kgGrouped(t.grossWeightGrams)}`,
      vehicle.capacityKg === null ? null : `Capacity ${kgGrouped(vehicle.capacityKg * 1000)}`,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
    BODY,
    'bold',
    3,
  );
  if (t.grossWeightGrams !== null && vehicle.capacityKg !== null && t.grossWeightGrams > vehicle.capacityKg * 1000) {
    flow.paragraph('Over capacity: the gross weight is above the vehicle’s stated capacity.', BODY, 'bold', 2);
  }

  // ── every page's footer: the signature lines and the page number ────────
  const total = flow.pages.length;
  const receipt = wrapText(documentText(LOADING_SHEET_RECEIPT, bold), bold, SMALL, flow.contentWidth, 1);
  const half = flow.contentWidth / 2;
  const signatureLabels = ['Loading supervisor — signature, name, date', 'Driver — signature, name, date'];
  const printed = documentText(`${model.loadCode} · Printed ${istLabel(model.printedAt)}`, regular);
  flow.pages.forEach((page, index) => {
    const top = LOADING_SHEET_FOOTER_TOP - 4;
    page.rules.push({ x1: flow.left, y1: top, x2: flow.left + flow.contentWidth, y2: top, width: 0.5 });
    receipt.forEach((line) => page.runs.push({ x: flow.left, y: top - SMALL - 3, size: SMALL, font: 'bold', text: line }));
    signatureLabels.forEach((label, i) => {
      const x = flow.left + i * half;
      page.rules.push({ x1: x, y1: 42, x2: x + half - 24, y2: 42, width: 0.5 });
      page.runs.push({ x, y: 33, size: SMALL, font: 'regular', text: documentText(label, regular) });
    });
    page.runs.push({ x: flow.left, y: FOOTER_BASELINE, size: SMALL, font: 'regular', text: printed });
    const pageNo = `Page ${index + 1} of ${total}`;
    page.runs.push({ x: flow.left + flow.contentWidth - regular.widthOfTextAtSize(pageNo, SMALL), y: FOOTER_BASELINE, size: SMALL, font: 'regular', text: pageNo });
  });
  return flow.finish();
}

/** The sheet's PDF at its print instant (same instant → same bytes). */
export async function renderLoadingSheetPdf(model: LoadingSheetModel): Promise<Buffer> {
  return drawDocumentPdf(layoutLoadingSheet(model), { title: `Loading sheet ${model.loadCode}`, creationDate: model.printedAt });
}

/** `LD-0007-loading-sheet.pdf`. */
export function loadingSheetFileName(loadCode: string): string {
  return `${loadCode.replace(/[^A-Za-z0-9._-]/g, '_')}-loading-sheet.pdf`;
}
