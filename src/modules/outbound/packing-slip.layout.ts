import { istWallClock, istDateOf } from '../../shared/primitives/time';
import { A4_HEIGHT_PT, A4_WIDTH_PT, type DocumentBarcode, type DocumentPage, type DocumentRule, type DocumentRun } from '../../shared/documents/a4-pdf';
import { DOCUMENT_FONTS, documentText, type DocumentFont } from '../../shared/documents/text';
import { wrapText } from '../../shared/documents/wrap';
import { encodeCode128B } from '../../shared/labels/code128';
import { POINTS_PER_DOT } from '../../shared/labels/layout';
import { cmText, indianRupees, kgText } from '../../shared/labels/shipping/carton-label';
import type { PackDocument, PackDocumentLine } from './pack-documents.read';

/**
 * Story 4-5a (A17, A35, A36, A48) — the A4 packing slip: ONE pure function
 * from the document model to positioned, folded runs, drawn by 2-9a's
 * `drawDocumentPdf`. Two audiences (A35): `staff` (the pack station) prints
 * the parcel-tag barcode, the carton codes, the handling-unit ids and the
 * packer; `client` (the portal and the dispatch email) prints none of them.
 *
 * No price, no tax figure (D4): every page's footer says the slip is not a
 * tax invoice and names who issues the tax documents. No phone (the slip
 * travels inside the box). Every string is normalised and WinAnsi-folded
 * (`documentText`) before it is measured. The header repeats on every page;
 * a table row never crosses the footer; a table that breaks repeats its
 * column header under "(continued)".
 */

export type PackingSlipAudience = 'staff' | 'client';

const MARGIN = 36;
const CONTENT_WIDTH = A4_WIDTH_PT - 2 * MARGIN;
const TOP = A4_HEIGHT_PT - MARGIN;
/** Content stays above this line; the page footer sits below it. */
export const SLIP_FOOTER_TOP = 64;
const FOOTER_BASELINE = 26;
const BODY = 8;
const SMALL = 7;
const TABLE = 7;
const HEADING = 9;
const LEADING = 1.25;
const PARTY_FIELD_MAX_LINES = 3;
/** 2 dots at 203 dpi — the label bars' module, in points. */
const BAR_MODULE_PT = 2 * POINTS_PER_DOT;
const BAR_HEIGHT_PT = 26;

export const SLIP_NOT_TAX_INVOICE = (issuer: string) => `This is not a tax invoice. Tax documents are issued by ${issuer}.`;
export const SLIP_PARTIES_LIVE = 'Party details are current, not as at packing (packed before frozen documents).';
export const SLIP_SHORT_PENDING = 'Items not in this shipment will follow separately';

const { regular, bold } = DOCUMENT_FONTS;
const fontOf = (name: 'regular' | 'bold'): DocumentFont => (name === 'bold' ? bold : regular);

function istLabel(instant: string): string {
  return `${istWallClock(instant).slice(0, 16)} IST`;
}

interface Column {
  readonly header: string;
  readonly width: number;
  readonly align: 'left' | 'right';
  readonly maxLines: number;
}

/** One table row: its cells, and whether it is a sub-row (a batch, a serial list — smaller, no rule above). */
interface Row {
  readonly cells: readonly string[];
  readonly sub?: boolean;
}

class Flow {
  readonly pages: { runs: DocumentRun[]; rules: DocumentRule[]; barcodes: DocumentBarcode[] }[] = [];
  y = TOP;

  constructor(private readonly header: (flow: Flow) => void) {
    this.newPage();
  }

  newPage(): void {
    this.pages.push({ runs: [], rules: [], barcodes: [] });
    this.y = TOP;
    this.header(this);
  }

  get page() {
    return this.pages[this.pages.length - 1]!;
  }

  ensure(height: number): boolean {
    if (this.y - height < SLIP_FOOTER_TOP) {
      this.newPage();
      return true;
    }
    return false;
  }

  run(x: number, baseline: number, size: number, font: 'regular' | 'bold', text: string): void {
    if (text.length > 0) this.page.runs.push({ x, y: baseline, size, font, text });
  }

  rule(x1: number, y1: number, x2: number, y2: number, width = 0.5): void {
    this.page.rules.push({ x1, y1, x2, y2, width });
  }

  gap(height: number): void {
    this.y -= height;
  }

  paragraph(raw: string, size: number, fontName: 'regular' | 'bold' = 'regular', maxLines = Number.POSITIVE_INFINITY, indent = 0): void {
    const font = fontOf(fontName);
    for (const line of wrapText(documentText(raw, font), font, size, CONTENT_WIDTH - indent, maxLines)) {
      this.ensure(size * LEADING);
      this.run(MARGIN + indent, this.y - size, size, fontName, line);
      this.y -= size * LEADING;
    }
  }

  heading(text: string, keepWith: number): void {
    this.ensure(HEADING * LEADING + 4 + keepWith);
    this.gap(4);
    this.run(MARGIN, this.y - HEADING, HEADING, 'bold', documentText(text, bold));
    this.y -= HEADING * LEADING + 1;
  }

  table(title: string, columns: readonly Column[], rows: readonly Row[]): void {
    const lineHeight = TABLE * LEADING;
    const wrapRow = (cells: readonly string[], fontName: 'regular' | 'bold', size: number) =>
      cells.map((cell, index) => {
        const column = columns[index]!;
        const font = fontOf(fontName);
        return wrapText(documentText(cell, font), font, size, column.width - 4, column.maxLines);
      });
    const headerCells = wrapRow(
      columns.map((column) => column.header),
      'bold',
      TABLE,
    );
    const heightOf = (cells: string[][], size: number) => Math.max(1, ...cells.map((lines) => lines.length)) * size * LEADING + 3;
    const drawRow = (cells: string[][], fontName: 'regular' | 'bold', size: number, ruleBelow: number | null) => {
      const height = heightOf(cells, size);
      let x = MARGIN;
      cells.forEach((lines, index) => {
        const column = columns[index]!;
        lines.forEach((line, lineIndex) => {
          const baseline = this.y - 1.5 - size - lineIndex * size * LEADING;
          const width = fontOf(fontName).widthOfTextAtSize(line, size);
          const lineX = column.align === 'right' ? x + column.width - 2 - width : x + 2;
          this.run(lineX, baseline, size, fontName, line);
        });
        x += column.width;
      });
      this.y -= height;
      if (ruleBelow !== null) this.rule(MARGIN, this.y, MARGIN + CONTENT_WIDTH, this.y, ruleBelow);
    };
    const drawHeader = () => {
      this.rule(MARGIN, this.y, MARGIN + CONTENT_WIDTH, this.y, 0.75);
      drawRow(headerCells, 'bold', TABLE, 0.75);
    };
    const wrapped = rows.map((row) => ({ sub: row.sub === true, cells: wrapRow(row.cells, 'regular', row.sub === true ? SMALL : TABLE) }));
    const headerHeight = heightOf(headerCells, TABLE);
    const first = wrapped[0];
    this.heading(title, headerHeight + (first === undefined ? 0 : heightOf(first.cells, first.sub ? SMALL : TABLE)));
    drawHeader();
    wrapped.forEach((row, index) => {
      const size = row.sub ? SMALL : TABLE;
      const height = heightOf(row.cells, size);
      const next = wrapped[index + 1];
      const ruled = next === undefined || !next.sub;
      if (this.y - height < SLIP_FOOTER_TOP) {
        this.newPage();
        this.heading(`${title} (continued)`, headerHeight + height);
        drawHeader();
      }
      drawRow(row.cells, 'regular', size, ruled ? 0.25 : null);
    });
    void lineHeight;
  }
}

function addressLine(parts: readonly (string | null | undefined)[]): string | null {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return kept.length === 0 ? null : kept.join(', ');
}

function present(values: readonly (string | null)[]): string[] {
  return values.filter((value): value is string => value !== null && value !== '');
}

/** The three party blocks: the brand (shipper), the warehouse (shipped from), the consignee (ship to). */
export function packingSlipPartyBlocks(doc: PackDocument): { readonly heading: string; readonly fields: readonly string[] }[] {
  const { client, warehouse, consignee } = doc;
  const registered = client.registeredAddress;
  const b2b = doc.orderType === 'b2b' || consignee.gstin !== null;
  return [
    {
      heading: 'Shipper (brand)',
      fields: present([
        client.name,
        client.legalName !== null && client.legalName !== client.name ? client.legalName : null,
        client.gstin === null ? null : `GSTIN ${client.gstin}`,
        registered === null ? null : addressLine([registered.line1, registered.line2, registered.city, `State code ${registered.stateCode}`, registered.pincode]),
      ]),
    },
    {
      heading: 'Shipped from',
      fields: present([
        `${warehouse.name} (${warehouse.code})`,
        warehouse.gstin === null ? null : `GSTIN ${warehouse.gstin}`,
        // A45 — a warehouse with no address prints "—".
        warehouse.address === null
          ? '—'
          : addressLine([warehouse.address.line1, warehouse.address.line2, warehouse.address.city, warehouse.address.state, warehouse.address.pincode]),
      ]),
    },
    {
      heading: 'Ship to',
      fields: present([
        consignee.contactName,
        b2b && consignee.legalName !== null && consignee.legalName !== consignee.contactName ? consignee.legalName : null,
        b2b && consignee.gstin !== null ? `GSTIN ${consignee.gstin}` : null,
        addressLine([consignee.line1, consignee.line2, consignee.city, consignee.state]),
        consignee.pincode === '' ? null : `PIN ${consignee.pincode}`,
      ]),
    },
  ];
}

/** "COD Rs 1,250.00" / "Prepaid" / "—". */
export function paymentLine(doc: Pick<PackDocument, 'payment'>): string {
  if (doc.payment === null) return '—';
  return doc.payment.kind === 'cod' ? `COD ${indianRupees(doc.payment.amountPaise)}` : 'Prepaid';
}

/** "Carton 2 of 3 — 4.20 kg — 40 × 30 × 20 cm" (+ " — {code}" for staff). */
export function cartonHeading(
  carton: Pick<PackDocument['cartons'][number], 'seq' | 'code' | 'weightGrams' | 'dimensionsMm'>,
  count: number,
  audience: PackingSlipAudience,
): string {
  return [
    `Carton ${carton.seq} of ${count}`,
    carton.weightGrams === null ? null : kgText(carton.weightGrams),
    carton.dimensionsMm === null ? null : cmText(carton.dimensionsMm).replace(/x/g, ' x '),
    audience === 'staff' ? carton.code : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' — ');
}

/** The shortfall sentence, or null (A36: named only once the follow-on exists). */
export function shortfallSentence(doc: Pick<PackDocument, 'shortfall'>): string | null {
  const { shortfall } = doc;
  if (shortfall.kind === 'none') return null;
  if (shortfall.kind === 'pending') return `${SLIP_SHORT_PENDING} (short: ${shortfall.totals}).`;
  return `${shortfall.totals} on backorder will follow as order ${shortfall.followOnLabel}.`;
}

function lineRows(line: PackDocumentLine): Row[] {
  const description = line.kind === 'kit' ? `Kit: ${line.skuName}` : line.kind === 'component' ? `  ${line.skuName}` : line.skuName;
  const rows: Row[] = [
    {
      cells: [
        String(line.lineNo),
        line.kind === 'component' ? `> ${line.skuCode}` : line.skuCode,
        description,
        line.uom,
        line.ordered,
        line.packed ?? '',
        line.short ?? '',
      ],
    },
  ];
  for (const batch of line.batches) {
    rows.push({ sub: true, cells: ['', '', `Batch ${batch.code}${batch.expiryDate === null ? '' : ` exp ${batch.expiryDate}`}`, '', '', '', ''] });
  }
  if (line.moreBatches > 0) rows.push({ sub: true, cells: ['', '', `+${line.moreBatches} more batches`, '', '', '', ''] });
  if (line.serials.length > 0) {
    const more = line.moreSerials > 0 ? ` … (+${line.moreSerials} more)` : '';
    rows.push({ sub: true, cells: ['', '', `Serials: ${line.serials.join(', ')}${more}`, '', '', '', ''] });
  }
  return rows;
}

export function layoutPackingSlip(doc: PackDocument, options: { readonly audience: PackingSlipAudience }): DocumentPage[] {
  const staff = options.audience === 'staff';
  const label = documentText(doc.orderLabel, bold);

  // ── the header, on every page ────────────────────────────────────────────
  const header = (flow: Flow) => {
    flow.run(MARGIN, flow.y - 16, 16, 'bold', documentText('Packing slip', bold));
    flow.run(MARGIN + CONTENT_WIDTH - bold.widthOfTextAtSize(label, 12), flow.y - 14, 12, 'bold', label);
    flow.gap(16 * LEADING + 2);
    if (staff) {
      // The parcel tag's barcode, right-aligned, its quiet zones left free.
      const modules = encodeCode128B(doc.parcelTag).reduce((sum, width) => sum + width, 0);
      const width = modules * BAR_MODULE_PT;
      const x = MARGIN + CONTENT_WIDTH - width;
      flow.page.barcodes.push({ x, y: flow.y - BAR_HEIGHT_PT, height: BAR_HEIGHT_PT, moduleWidth: BAR_MODULE_PT, payload: doc.parcelTag });
      const tag = documentText(doc.parcelTag, regular);
      flow.run(MARGIN + CONTENT_WIDTH - regular.widthOfTextAtSize(tag, SMALL), flow.y - BAR_HEIGHT_PT - SMALL - 1, SMALL, 'regular', tag);
    }
    const stamp = [
      `Packed ${istLabel(doc.packedAt)}`,
      doc.repackedAt === null ? null : `Re-packed ${istLabel(doc.repackedAt)}`,
      `Printed ${istLabel(doc.printedAt)}`,
      staff && doc.packerName !== null ? `Packed by ${doc.packerName}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · ');
    const stampLines = wrapText(documentText(stamp, regular), regular, BODY, staff ? CONTENT_WIDTH - 180 : CONTENT_WIDTH, 2);
    stampLines.forEach((line, index) => flow.run(MARGIN, flow.y - BODY - index * BODY * LEADING, BODY, 'regular', line));
    flow.gap(Math.max(stampLines.length * BODY * LEADING, staff ? BAR_HEIGHT_PT + SMALL + 3 : 0) + 6);
    flow.rule(MARGIN, flow.y, MARGIN + CONTENT_WIDTH, flow.y, 0.75);
    flow.gap(4);
  };
  const flow = new Flow(header);

  // ── the three parties, side by side ──────────────────────────────────────
  const blocks = packingSlipPartyBlocks(doc);
  const blockGap = 12;
  const blockWidth = (CONTENT_WIDTH - 2 * blockGap) / 3;
  const wrappedBlocks = blocks.map((block) => ({
    heading: documentText(block.heading, bold),
    lines: block.fields.flatMap((field) => wrapText(documentText(field, regular), regular, BODY, blockWidth, PARTY_FIELD_MAX_LINES)),
  }));
  const blockHeight = HEADING * LEADING + Math.max(...wrappedBlocks.map((block) => block.lines.length)) * BODY * LEADING;
  flow.ensure(blockHeight + 4);
  const blockTop = flow.y;
  wrappedBlocks.forEach((block, index) => {
    const x = MARGIN + index * (blockWidth + blockGap);
    flow.run(x, blockTop - HEADING, HEADING, 'bold', block.heading);
    block.lines.forEach((line, lineIndex) => {
      flow.run(x, blockTop - HEADING * LEADING - BODY - lineIndex * BODY * LEADING, BODY, 'regular', line);
    });
  });
  flow.y = blockTop - blockHeight - 4;
  flow.rule(MARGIN, flow.y, MARGIN + CONTENT_WIDTH, flow.y, 0.75);

  // ── the order's facts ────────────────────────────────────────────────────
  flow.heading('Order', BODY * LEADING * 3);
  const facts = [
    doc.clientOrderRef === null ? null : `Client order ref ${doc.clientOrderRef}`,
    doc.channelRef === null || doc.channelRef === doc.clientOrderRef ? null : `Channel ref ${doc.channelRef}`,
    `Ordered ${istDateOf(doc.orderedAt)}`,
    doc.orderType === null ? null : `Type ${doc.orderType.toUpperCase()}`,
    `Payment ${paymentLine(doc)}`,
  ].filter((part): part is string => part !== null);
  flow.paragraph(facts.join(' · '), BODY, 'regular', 3);
  if (doc.shipment !== null) flow.paragraph(`Courier ${doc.shipment.courierName} · AWB ${doc.shipment.awb}`, BODY, 'regular', 2);
  flow.paragraph(
    `Cartons ${doc.cartonCount}${doc.grossWeightGrams === null ? '' : ` · Gross weight ${kgText(doc.grossWeightGrams)}`} · Packed ${doc.totals}`,
    BODY,
    'regular',
    2,
  );

  // ── the lines ────────────────────────────────────────────────────────────
  const columns: Column[] = [
    { header: '#', width: 18, align: 'right', maxLines: 1 },
    { header: 'SKU', width: 80, align: 'left', maxLines: 3 },
    { header: 'Description', width: 225, align: 'left', maxLines: 2 },
    { header: 'UoM', width: 34, align: 'left', maxLines: 1 },
    { header: 'Ordered', width: 56, align: 'right', maxLines: 1 },
    { header: 'Packed', width: 56, align: 'right', maxLines: 1 },
    { header: 'Short', width: CONTENT_WIDTH - 469, align: 'right', maxLines: 1 },
  ];
  flow.table('Items', columns, doc.lines.flatMap(lineRows));
  const shortfall = shortfallSentence(doc);
  if (shortfall !== null) {
    flow.gap(3);
    flow.paragraph(shortfall, BODY, 'bold', 3);
  }

  // ── the cartons ──────────────────────────────────────────────────────────
  const cartonColumns: Column[] = [
    { header: 'SKU', width: 98, align: 'left', maxLines: 3 },
    { header: 'Description', width: 279, align: 'left', maxLines: 2 },
    { header: 'Qty', width: CONTENT_WIDTH - 377, align: 'right', maxLines: 1 },
  ];
  for (const carton of doc.cartons) {
    const rows: Row[] = carton.lines.map((line) => ({ cells: [line.skuCode, line.skuName, `${formatSlipQty(line.qty)} ${line.uom}`] }));
    if (staff) {
      for (const line of carton.lines) {
        if (line.handlingUnitIds !== null && line.handlingUnitIds.length > 0) {
          rows.push({ sub: true, cells: ['', `Cases (${line.skuCode}): ${line.handlingUnitIds.join(', ')}`, ''] });
        }
      }
    }
    rows.push({ sub: true, cells: ['', 'Total', carton.totals] });
    flow.table(cartonHeading(carton, doc.cartonCount, options.audience), cartonColumns, rows);
  }

  // ── notes ────────────────────────────────────────────────────────────────
  flow.gap(6);
  const notes = [
    ...(doc.partiesFrozen ? [] : [SLIP_PARTIES_LIVE]),
    ...(doc.partiesAsAt === null ? [] : [`Party details as at ${istDateOf(doc.partiesAsAt)}.`]),
    ...doc.annotations,
  ];
  for (const note of notes) flow.paragraph(note, SMALL);

  // ── every page's footer ──────────────────────────────────────────────────
  const issuer = doc.client.legalName ?? doc.client.name;
  const notice = wrapText(documentText(SLIP_NOT_TAX_INVOICE(issuer), bold), bold, SMALL, CONTENT_WIDTH, 2);
  const total = flow.pages.length;
  const printed = documentText(`${doc.orderLabel} · Printed ${istLabel(doc.printedAt)}`, regular);
  flow.pages.forEach((page, index) => {
    page.rules.push({ x1: MARGIN, y1: SLIP_FOOTER_TOP - 4, x2: MARGIN + CONTENT_WIDTH, y2: SLIP_FOOTER_TOP - 4, width: 0.5 });
    notice.forEach((line, lineIndex) => {
      page.runs.push({ x: MARGIN, y: SLIP_FOOTER_TOP - 4 - SMALL - 3 - lineIndex * SMALL * LEADING, size: SMALL, font: 'bold', text: line });
    });
    page.runs.push({ x: MARGIN, y: FOOTER_BASELINE, size: SMALL, font: 'regular', text: printed });
    const pageNo = `Page ${index + 1} of ${total}`;
    page.runs.push({ x: MARGIN + CONTENT_WIDTH - regular.widthOfTextAtSize(pageNo, SMALL), y: FOOTER_BASELINE, size: SMALL, font: 'regular', text: pageNo });
  });
  return flow.pages.map((page) => (page.barcodes.length === 0 ? { runs: page.runs, rules: page.rules } : page));
}

/** Base units, at most three decimals, no trailing zeros. */
function formatSlipQty(qty: number): string {
  return String(Math.round(qty * 1000) / 1000);
}

/** `{order label, folded}-packing-slip.pdf` (the 2-10b fold to `[A-Za-z0-9._-]`). */
export function packDocumentFileStem(orderLabel: string): string {
  return orderLabel.replace(/[^A-Za-z0-9._-]/g, '_') || 'order';
}
