import { drawDocumentPdf, type DocumentPage } from './a4-pdf';
import { DocumentFlow, LEADING, countGrouped, documentFileStem, fontOf, istLabel, kgGrouped, type FlowColumn } from './flow';
import { DOCUMENT_FONTS, documentText } from './text';
import { wrapText } from './wrap';
import { encodeCode128B } from '../labels/code128';
import { POINTS_PER_DOT } from '../labels/layout';

/**
 * Story 4-9a (A26) — the freight note: one per consignment, portrait A4, a
 * pure layout drawn by 2-9a's `drawDocumentPdf`. Two audiences (4-5a A35's
 * shape): `staff` prints the consignment ref's barcode and every package's
 * code; `client` (the portal) prints neither — only each package's type,
 * count and weight. It carries the receipt block the consignee signs (the
 * POD form the office records with A17). Every load fact comes from the
 * consignment's frozen carriage snapshot (A63), so the client copy reads
 * nothing staff-only. No phone. Not a tax invoice and not a lorry receipt.
 */

export type FreightNoteAudience = 'staff' | 'client';

export interface FreightNoteParty {
  readonly name: string;
  readonly legalName: string | null;
  readonly gstin: string | null;
  /** Already composed address lines (none when unknown). */
  readonly addressLines: readonly string[];
}

export interface FreightNotePackage {
  /** The package label's code (printed for staff only). */
  readonly code: string;
  readonly type: 'carton' | 'pallet';
  readonly seq: number;
  readonly innerCount: number | null;
  readonly weightGrams: number | null;
}

export interface FreightNoteModel {
  /** `LD-0007/03`. */
  readonly consignmentRef: string;
  readonly dispatchedAt: string;
  readonly printedAt: string;
  /** The brand (the pack's frozen consignor — A65). */
  readonly consignor: FreightNoteParty;
  /** "c/o" — the warehouse the goods left (the carriage snapshot's party). */
  readonly careOf: { readonly code: string; readonly name: string; readonly gstin: string | null; readonly addressLines: readonly string[] };
  readonly consignee: {
    readonly name: string;
    readonly legalName: string | null;
    readonly gstin: string | null;
    readonly addressLines: readonly string[];
    readonly city: string;
    readonly state: string;
    readonly pincode: string;
  };
  readonly transporter: { readonly name: string; readonly gstin: string | null };
  readonly vehicle: { readonly number: string; readonly type: string | null; readonly containerNumber: string | null };
  readonly driverName: string | null;
  /** FTL or LTL (the carriage snapshot's) — the client copy prints seals for FTL only. */
  readonly mode?: 'ftl' | 'ltl' | undefined;
  readonly seals: readonly string[];
  readonly orderLabel: string;
  readonly clientOrderRef: string | null;
  readonly lr: { readonly number: string | null; readonly date: string | null; readonly terms: string | null };
  /** 4-6a's stamped brand document. */
  readonly invoice: { readonly type: string; readonly number: string; readonly date: string } | null;
  readonly ewayBill: { readonly number: string; readonly validUntil: string | null } | null;
  readonly packages: readonly FreightNotePackage[];
  readonly totals: {
    readonly packages: number;
    readonly cartons: number;
    readonly pallets: number;
    /** Null when a package is unweighed. */
    readonly weightGrams: number | null;
  };
}

const MARGIN = 36;
export const FREIGHT_NOTE_FOOTER_TOP = 54;
const FOOTER_BASELINE = 24;
const BODY = 8;
const SMALL = 7;
const TABLE = 7;
const HEADING = 9;
const BAR_MODULE_PT = 2 * POINTS_PER_DOT;
const BAR_HEIGHT_PT = 26;
const { regular, bold } = DOCUMENT_FONTS;

export const FREIGHT_NOTE_DISCLAIMER = 'This is not a tax invoice or a lorry receipt.';
const TERMS_WORDS: Readonly<Record<string, string>> = { paid: 'Paid', 'to-pay': 'To pay', tbb: 'To be billed' };

const plural = (n: number, one: string, many: string) => `${countGrouped(n)} ${n === 1 ? one : many}`;

/**
 * "15 pallets (STC 600 cartons), 2 cartons — 9,840 kg". The STC figure prints
 * only when every pallet carries an inner count (a partial sum would understate
 * the contents); the weight only when every package is weighed.
 */
export function packagesLine(model: Pick<FreightNoteModel, 'packages' | 'totals'>): string {
  const pallets = model.packages.filter((pkg) => pkg.type === 'pallet');
  const cartons = model.packages.length - pallets.length;
  const parts: string[] = [];
  if (pallets.length > 0) {
    const counted = pallets.every((pkg) => pkg.innerCount !== null);
    const stc = counted ? ` (STC ${plural(pallets.reduce((sum, pkg) => sum + pkg.innerCount!, 0), 'carton', 'cartons')})` : '';
    parts.push(`${plural(pallets.length, 'pallet', 'pallets')}${stc}`);
  }
  if (cartons > 0) parts.push(plural(cartons, 'carton', 'cartons'));
  const line = parts.length === 0 ? plural(model.totals.packages, 'package', 'packages') : parts.join(', ');
  return model.totals.weightGrams === null ? line : `${line} — ${kgGrouped(model.totals.weightGrams)}`;
}

function present(values: readonly (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

export function layoutFreightNote(model: FreightNoteModel, options: { readonly audience: FreightNoteAudience }): DocumentPage[] {
  const staff = options.audience === 'staff';
  const title = documentText('Freight note', bold);
  const refText = documentText(model.consignmentRef, bold);
  const barWidth = encodeCode128B(model.consignmentRef).reduce((sum, width) => sum + width, 0) * BAR_MODULE_PT;
  const header = (flow: DocumentFlow) => {
    const right = flow.left + flow.contentWidth;
    flow.run(flow.left, flow.y - 16, 16, 'bold', title);
    flow.run(flow.left + bold.widthOfTextAtSize(title, 16) + 14, flow.y - 14, 13, 'bold', refText);
    if (staff) {
      flow.page.barcodes.push({ x: right - barWidth, y: flow.y - BAR_HEIGHT_PT, height: BAR_HEIGHT_PT, moduleWidth: BAR_MODULE_PT, payload: model.consignmentRef });
    }
    flow.gap(16 * LEADING + 2);
    const stamp = documentText(`Dispatched ${istLabel(model.dispatchedAt)} · Printed ${istLabel(model.printedAt)}`, regular);
    flow.run(flow.left, flow.y - BODY, BODY, 'regular', stamp);
    flow.gap(BODY * LEADING + 4);
    if (staff) flow.y = Math.min(flow.y, flow.top - BAR_HEIGHT_PT - 6);
    flow.rule(flow.left, flow.y, right, flow.y, 0.75);
    flow.gap(4);
  };
  const flow = new DocumentFlow({ landscape: false, margin: MARGIN, footerTop: FREIGHT_NOTE_FOOTER_TOP }, header);

  // ── the parties ──────────────────────────────────────────────────────────
  const c = model.consignor;
  const ce = model.consignee;
  flow.blocks(
    [
      {
        heading: 'Consignor',
        fields: present([
          c.name,
          c.legalName !== null && c.legalName !== c.name ? c.legalName : null,
          c.gstin === null ? null : `GSTIN ${c.gstin}`,
          `c/o ${model.careOf.name} (${model.careOf.code})`,
          ...model.careOf.addressLines,
        ]),
      },
      {
        heading: 'Consignee',
        fields: present([
          ce.name,
          ce.legalName !== null && ce.legalName !== ce.name ? ce.legalName : null,
          ce.gstin === null ? null : `GSTIN ${ce.gstin}`,
          ...ce.addressLines,
          [ce.city, ce.state].filter((part) => part !== '').join(', '),
          ce.pincode === '' ? null : `PIN ${ce.pincode}`,
        ]),
      },
      {
        heading: 'Transporter and vehicle',
        fields: present([
          model.transporter.name,
          model.transporter.gstin === null ? null : `GSTIN ${model.transporter.gstin}`,
          `Vehicle ${model.vehicle.number}${model.vehicle.type === null ? '' : ` (${model.vehicle.type})`}`,
          model.vehicle.containerNumber === null ? null : `Container ${model.vehicle.containerNumber}`,
          model.driverName === null ? null : `Driver ${model.driverName}`,
          // The client copy prints seals for a full truck only (an LTL truck's seals are the load's, shared with other brands — the portal rule).
          model.seals.length === 0 || (!staff && model.mode !== 'ftl') ? null : `Seals ${model.seals.join(', ')}`,
        ]),
      },
    ],
    HEADING,
    BODY,
  );
  flow.rule(flow.left, flow.y, flow.left + flow.contentWidth, flow.y, 0.75);

  // ── the facts ────────────────────────────────────────────────────────────
  flow.heading('Consignment', HEADING, BODY * LEADING * 3);
  flow.paragraph(
    present([
      `Order ${model.orderLabel}`,
      model.clientOrderRef === null || model.clientOrderRef === model.orderLabel ? null : `Client order ref ${model.clientOrderRef}`,
      model.lr.number === null
        ? 'LR not recorded'
        : `LR ${model.lr.number}${model.lr.date === null ? '' : ` dated ${model.lr.date}`}${model.lr.terms === null ? '' : ` (${TERMS_WORDS[model.lr.terms] ?? model.lr.terms})`}`,
    ]).join(' · '),
    BODY,
    'regular',
    3,
  );
  const docs = present([
    model.invoice === null ? null : `${model.invoice.type === 'invoice' ? 'Invoice' : model.invoice.type === 'challan' ? 'Challan' : 'Bill of supply'} ${model.invoice.number} dated ${model.invoice.date}`,
    model.ewayBill === null ? null : `E-way bill ${model.ewayBill.number}${model.ewayBill.validUntil === null ? '' : ` valid until ${model.ewayBill.validUntil}`}`,
  ]);
  if (docs.length > 0) flow.paragraph(docs.join(' · '), BODY, 'regular', 3);
  flow.paragraph(`Packages: ${packagesLine(model)}`, BODY, 'bold', 3);

  // ── the package list ─────────────────────────────────────────────────────
  const count = model.packages.length;
  const columns: FlowColumn[] = staff
    ? [
        { header: 'Package', width: 70, align: 'left', maxLines: 1 },
        { header: 'Type', width: 60, align: 'left', maxLines: 1 },
        { header: 'Contents', width: 120, align: 'left', maxLines: 1 },
        { header: 'Weight', width: 70, align: 'right', maxLines: 1 },
        { header: 'Code', width: flow.contentWidth - 320, align: 'left', maxLines: 1 },
      ]
    : [
        { header: 'Package', width: 90, align: 'left', maxLines: 1 },
        { header: 'Type', width: 90, align: 'left', maxLines: 1 },
        { header: 'Contents', width: 160, align: 'left', maxLines: 1 },
        { header: 'Weight', width: flow.contentWidth - 340, align: 'right', maxLines: 1 },
      ];
  const rows = [...model.packages]
    .sort((a, b) => a.seq - b.seq)
    .map((pkg) => {
      const cells = [
        `${pkg.seq} of ${count}`,
        pkg.type === 'pallet' ? 'Pallet' : 'Carton',
        pkg.innerCount === null ? '' : `STC ${plural(pkg.innerCount, 'carton', 'cartons')}`,
        pkg.weightGrams === null ? '' : kgGrouped(pkg.weightGrams),
      ];
      return { cells: staff ? [...cells, pkg.code] : cells };
    });
  flow.table('Packages', columns, rows, TABLE, HEADING);

  // ── the receipt block (the POD form), kept whole ─────────────────────────
  const boxHeight = 132;
  flow.ensure(boxHeight + HEADING * LEADING + 10);
  flow.heading('Receipt (to be completed by the consignee)', HEADING, boxHeight);
  const top = flow.y;
  const left = flow.left;
  const width = flow.contentWidth;
  flow.box(left, top - boxHeight, width, boxHeight, 0.75);
  const line = (y: number, text: string, x = left + 8, fontName: 'regular' | 'bold' = 'regular') => flow.run(x, y, BODY, fontName, documentText(text, fontOf(fontName)));
  line(top - 14, `Received ${plural(model.totals.packages, 'package', 'packages')} in good order / with the remarks below.`, left + 8, 'bold');
  // The short and damaged boxes.
  flow.box(left + 8, top - 44, 60, 20);
  line(top - 50 - BODY + 2, 'Short (packages)');
  flow.box(left + 120, top - 44, 60, 20);
  line(top - 50 - BODY + 2, 'Damaged (packages)', left + 120);
  line(top - 32, 'Remarks', left + 220);
  flow.rule(left + 260, top - 32, left + width - 8, top - 32);
  flow.rule(left + 220, top - 48, left + width - 8, top - 48);
  const fields = ['Receiver name', 'Signature', 'Stamp', 'Date and time'];
  const fieldWidth = (width - 16) / fields.length;
  fields.forEach((label, index) => {
    const x = left + 8 + index * fieldWidth;
    flow.rule(x, top - boxHeight + 30, x + fieldWidth - 12, top - boxHeight + 30);
    line(top - boxHeight + 20, label, x);
  });
  flow.y = top - boxHeight - 6;

  // ── every page's footer ──────────────────────────────────────────────────
  const total = flow.pages.length;
  const disclaimer = wrapText(documentText(FREIGHT_NOTE_DISCLAIMER, bold), bold, SMALL, flow.contentWidth, 1);
  const printed = documentText(`${model.consignmentRef} · ${model.orderLabel} · Printed ${istLabel(model.printedAt)}`, regular);
  flow.pages.forEach((page, index) => {
    const ruleY = FREIGHT_NOTE_FOOTER_TOP - 4;
    page.rules.push({ x1: flow.left, y1: ruleY, x2: flow.left + flow.contentWidth, y2: ruleY, width: 0.5 });
    disclaimer.forEach((text) => page.runs.push({ x: flow.left, y: ruleY - SMALL - 3, size: SMALL, font: 'bold', text }));
    page.runs.push({ x: flow.left, y: FOOTER_BASELINE - 8, size: SMALL, font: 'regular', text: printed });
    const pageNo = `Page ${index + 1} of ${total}`;
    page.runs.push({ x: flow.left + flow.contentWidth - regular.widthOfTextAtSize(pageNo, SMALL), y: FOOTER_BASELINE - 8, size: SMALL, font: 'regular', text: pageNo });
  });
  return flow.finish();
}

/** The note's PDF for one audience at its print instant (same instant → same bytes). */
export async function renderFreightNotePdf(model: FreightNoteModel, audience: FreightNoteAudience): Promise<Buffer> {
  return drawDocumentPdf(layoutFreightNote(model, { audience }), { title: `Freight note ${model.consignmentRef}`, creationDate: model.printedAt });
}

/** `LD-0007-03-freight-note.pdf`. */
export function freightNoteFileName(consignmentRef: string): string {
  return `${documentFileStem(consignmentRef)}-freight-note.pdf`;
}
