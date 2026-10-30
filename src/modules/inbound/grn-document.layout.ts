import { formatQuantity } from '../../shared/primitives/client-event-facts';
import { istWallClock } from '../../shared/primitives/time';
import { A4_HEIGHT_PT, A4_WIDTH_PT, type DocumentPage, type DocumentRule, type DocumentRun } from '../../shared/documents/a4-pdf';
import { DOCUMENT_FONTS, documentText, type DocumentFont } from '../../shared/documents/text';
import { blindReasonLabelOf, damageReasonLabelOf, shortReasonLabelOf } from './receipt-condition';
import { grnTotals, type GrnDocument, type GrnDocumentLine } from './grn-document.types';

/**
 * Story 2-9a — the GRN document's A4 layout: ONE pure function from the one
 * model to positioned, folded text runs (decision 5, A11). Every door (the
 * staff web, the portal, the receipt email) draws exactly these runs, so the
 * brand, the vendor and the warehouse hold the same document.
 *
 * One vertical flow over every section — header, parties, arrival, lines,
 * damage details, serials, totals, footer notes, signatures. A block that
 * would cross the footer starts a new page; the two tables repeat their
 * column header after a break; the signatures stay together. A party field
 * wraps to its block, at most 4 lines then `…`; a SKU name at most 2 lines.
 * Every string is normalised and WinAnsi-folded (`documentText`) BEFORE it
 * is measured, so the width measured is the width drawn. No personal name
 * is ever printed (decision 6).
 */

const MARGIN = 36;
const CONTENT_WIDTH = A4_WIDTH_PT - 2 * MARGIN;
const TOP = A4_HEIGHT_PT - MARGIN;
/** Content stays above this line; the page footer sits below it. */
export const FOOTER_TOP = 54;
const FOOTER_BASELINE = 30;
const BODY = 8;
const SMALL = 7;
const TABLE = 6.5;
const HEADING = 9;
const LEADING = 1.25;
const PARTY_FIELD_MAX_LINES = 4;
const SKU_NAME_MAX_LINES = 2;
const CELL_MAX_LINES = 3;

export const GRN_RECEIPT_NOTE = 'Quantities are as counted at the warehouse dock. Over-receipt and QC outcomes are as at the print time.';
export const GRN_NOT_AN_INVOICE = 'This is a warehouse receipt record, not a tax invoice or delivery challan.';
export const GRN_ITEMS_CURRENT = 'Item descriptions are current.';
export const GRN_ARRIVAL_LIVE = 'Arrival details are as on the gate-in record.';
export const GRN_NOT_FROZEN = 'Party details are current, not as at receipt (recorded before frozen documents).';
export const GRN_DOCUMENTS_OMITTED = 'Other documents of this vehicle are not shown.';

const SEAL_LABEL: Readonly<Record<string, string>> = { intact: 'intact', broken: 'broken', none: 'none (unsealed)' };
const DOCUMENT_KIND_LABEL: Readonly<Record<string, string>> = {
  invoice: 'Invoice',
  challan: 'Delivery challan',
  bill_of_entry: 'Bill of entry',
};

const { regular, bold } = DOCUMENT_FONTS;
const fontOf = (name: 'regular' | 'bold'): DocumentFont => (name === 'bold' ? bold : regular);

function istLabel(instant: string): string {
  return `${istWallClock(instant).slice(0, 16)} IST`;
}

function ellipsisFor(font: DocumentFont): string {
  return documentText('…', font) === '…' ? '…' : '...';
}

/**
 * Wraps already-folded text to `width` at `size`: by words, a word wider
 * than the line broken by characters; past `maxLines` the last kept line
 * ends in `…`. Empty text is no line.
 */
export function wrapText(text: string, font: DocumentFont, size: number, width: number, maxLines: number): string[] {
  if (text.length === 0) return [];
  const fits = (value: string) => font.widthOfTextAtSize(value, size) <= width;
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    current = word;
    while (!fits(current)) {
      let cut = current.length - 1;
      while (cut > 1 && !fits(current.slice(0, cut))) cut -= 1;
      lines.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current !== '') lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const dots = ellipsisFor(font);
  let last = kept[maxLines - 1]!;
  while (last.length > 0 && !fits(`${last}${dots}`)) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}${dots}`;
  return kept;
}

interface Column {
  readonly header: string;
  readonly width: number;
  readonly align: 'left' | 'right';
  readonly maxLines: number;
}

/** The one cursor over every page. `y` is the top of the free space. */
class Flow {
  readonly pages: { runs: DocumentRun[]; rules: DocumentRule[] }[] = [];
  y = TOP;

  constructor() {
    this.newPage();
  }

  newPage(): void {
    this.pages.push({ runs: [], rules: [] });
    this.y = TOP;
  }

  private get page() {
    return this.pages[this.pages.length - 1]!;
  }

  /** Starts a new page when `height` would cross the footer (never on an empty page). */
  ensure(height: number): void {
    if (this.y - height < FOOTER_TOP && this.y < TOP) this.newPage();
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

  /** A wrapped paragraph, broken across pages line by line. */
  paragraph(raw: string, size: number, fontName: 'regular' | 'bold' = 'regular', maxLines = Number.POSITIVE_INFINITY): void {
    const font = fontOf(fontName);
    for (const line of wrapText(documentText(raw, font), font, size, CONTENT_WIDTH, maxLines)) {
      this.ensure(size * LEADING);
      this.run(MARGIN, this.y - size, size, fontName, line);
      this.y -= size * LEADING;
    }
  }

  heading(text: string, keepWith: number): void {
    this.ensure(HEADING * LEADING + keepWith);
    this.gap(4);
    this.run(MARGIN, this.y - HEADING, HEADING, 'bold', documentText(text, bold));
    this.y -= HEADING * LEADING + 1;
  }

  /** A table: the header row repeats after every break; a row never crosses the footer. */
  table(columns: readonly Column[], rows: readonly (readonly string[])[]): void {
    const lineHeight = TABLE * LEADING;
    const wrapRow = (cells: readonly string[], fontName: 'regular' | 'bold') =>
      cells.map((cell, index) => {
        const column = columns[index]!;
        const font = fontOf(fontName);
        return wrapText(documentText(cell, font), font, TABLE, column.width - 4, column.maxLines);
      });
    const headerCells = wrapRow(
      columns.map((column) => column.header),
      'bold',
    );
    const heightOf = (cells: string[][]) => Math.max(1, ...cells.map((lines) => lines.length)) * lineHeight + 3;
    const headerHeight = heightOf(headerCells);
    const drawRow = (cells: string[][], fontName: 'regular' | 'bold', ruleBelow: number) => {
      const height = heightOf(cells);
      let x = MARGIN;
      cells.forEach((lines, index) => {
        const column = columns[index]!;
        lines.forEach((line, lineIndex) => {
          const baseline = this.y - 1.5 - TABLE - lineIndex * lineHeight;
          const width = fontOf(fontName).widthOfTextAtSize(line, TABLE);
          const lineX = column.align === 'right' ? x + column.width - 2 - width : x + 2;
          this.run(lineX, baseline, TABLE, fontName, line);
        });
        x += column.width;
      });
      this.y -= height;
      this.rule(MARGIN, this.y, MARGIN + CONTENT_WIDTH, this.y, ruleBelow);
    };
    const drawHeader = () => {
      this.rule(MARGIN, this.y, MARGIN + CONTENT_WIDTH, this.y, 0.75);
      drawRow(headerCells, 'bold', 0.75);
    };
    const wrapped = rows.map((row) => wrapRow(row, 'regular'));
    this.ensure(headerHeight + (wrapped[0] === undefined ? 0 : heightOf(wrapped[0])));
    drawHeader();
    for (const cells of wrapped) {
      const height = heightOf(cells);
      if (this.y - height < FOOTER_TOP) {
        this.newPage();
        drawHeader();
      }
      drawRow(cells, 'regular', 0.25);
    }
  }
}

function addressLine(parts: readonly (string | null | undefined)[]): string | null {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return kept.length === 0 ? null : kept.join(', ');
}

/** The three party blocks' fields (decision 5, A5, A8 — the client and vendor print their state CODE). */
export function grnPartyBlocks(doc: GrnDocument): { readonly heading: string; readonly fields: readonly string[] }[] {
  const { warehouse, client, vendor } = doc.parties;
  const present = (values: readonly (string | null)[]) => values.filter((value): value is string => value !== null && value !== '');
  const warehouseFields = present([
    `${warehouse.name} (${warehouse.code})`,
    warehouse.gstin === null ? null : `GSTIN ${warehouse.gstin}`,
    warehouse.address === null
      ? null
      : addressLine([warehouse.address.line1, warehouse.address.line2, warehouse.address.city, warehouse.address.state, warehouse.address.pincode]),
    `Operated by ${warehouse.operatorName}`,
  ]);
  let clientFields: string[];
  if (client !== null) {
    const address = client.registeredAddress;
    clientFields = present([
      `${client.code} — ${client.name}`,
      client.legalName !== null && client.legalName !== client.name ? client.legalName : null,
      client.gstin === null ? null : `GSTIN ${client.gstin}`,
      address === null ? null : addressLine([address.line1, address.line2, address.city, `State code ${address.stateCode}`, address.pincode]),
    ]);
  } else {
    clientFields = [doc.clientId === null ? 'Client: several (older receipt)' : '—'];
  }
  let supplierFields: string[];
  if (doc.document.kind === 'po') {
    if (vendor === null) {
      supplierFields = [`Supplier not recorded on PO ${doc.document.code ?? ''}`.trim()];
    } else {
      const address = vendor.dispatchAddress ?? vendor.registeredAddress;
      supplierFields = present([
        `${vendor.code} — ${vendor.name}`,
        vendor.legalName !== null && vendor.legalName !== vendor.name ? vendor.legalName : null,
        vendor.gstin === null ? null : `GSTIN ${vendor.gstin}`,
        address === null ? null : addressLine([address.line1, address.line2, address.city, `State code ${address.stateCode}`, address.pincode]),
      ]);
    }
  } else if (doc.document.kind === 'asn') {
    supplierFields = [`As announced by the client — ASN ${doc.document.code ?? ''}`.trim()];
  } else {
    supplierFields = [`Unannounced — ${blindReasonLabelOf(doc.document.blindReasonCode) ?? 'no reason'}`];
  }
  return [
    { heading: 'Received at', fields: warehouseFields },
    { heading: 'Client (owner of goods)', fields: clientFields },
    { heading: 'Supplier', fields: supplierFields },
  ];
}

/** "PO P-1", "ASN A-77" or "Blind receipt (Unannounced delivery)". */
export function grnDocumentRef(doc: Pick<GrnDocument, 'document'>): string {
  const { kind, code, blindReasonCode } = doc.document;
  if (kind === 'po') return `PO ${code ?? '—'}`;
  if (kind === 'asn') return `ASN ${code ?? '—'}`;
  return `Blind receipt (${blindReasonLabelOf(blindReasonCode) ?? 'no reason'})`;
}

const q = (milli: number, line: Pick<GrnDocumentLine, 'uomPrecision'>) => formatQuantity(milli, line.uomPrecision);

/** The Over-receipt cell: blank, or each non-zero part (A8: the tolerance too). */
export function overReceiptCell(line: GrnDocumentLine): string {
  const parts: string[] = [];
  if (line.excess.pendingMilli > 0) parts.push(`${q(line.excess.pendingMilli, line)} awaiting approval`);
  if (line.excess.approvedMilli > 0) parts.push(`${q(line.excess.approvedMilli, line)} approved`);
  if (line.excess.rejectedMilli > 0) parts.push(`${q(line.excess.rejectedMilli, line)} rejected`);
  if (line.toleranceMilli > 0) parts.push(`${q(line.toleranceMilli, line)} within tolerance`);
  return parts.join('; ');
}

/** The QC cell: blank, or every non-zero part in a fixed order (A8); the status word when all are zero. */
export function qcCell(line: GrnDocumentLine): string {
  const { qc } = line;
  if (qc.status === null) return '';
  const parts: string[] = [];
  if (qc.onHoldMilli > 0) parts.push(`On hold ${q(qc.onHoldMilli, line)}`);
  if (qc.releasedMilli > 0) parts.push(`Released ${q(qc.releasedMilli, line)}`);
  if (qc.passedMilli > 0) parts.push(`Passed ${q(qc.passedMilli, line)}`);
  if (qc.failedMilli > 0) parts.push(`Failed ${q(qc.failedMilli, line)}`);
  if (parts.length > 0) return parts.join(' · ');
  return qc.status === 'on-hold' ? 'On hold' : qc.status === 'released' ? 'Released' : 'Inspected';
}

/** "Serials captured: 50 (2 unreadable, 1 rejected excess)", omitting a zero part; null when the line has no serial rows. */
export function serialsSentence(line: GrnDocumentLine): string | null {
  if (line.serialCount + line.unreadableSerialCount + line.rejectedSerialCount === 0) return null;
  const extra = [
    line.unreadableSerialCount > 0 ? `${line.unreadableSerialCount} unreadable` : null,
    line.rejectedSerialCount > 0 ? `${line.rejectedSerialCount} rejected excess` : null,
  ].filter((part): part is string => part !== null);
  return `Serials captured: ${line.serialCount}${extra.length === 0 ? '' : ` (${extra.join(', ')})`}`;
}

export function photosCell(count: number): string {
  return count === 0 ? '' : `${count} photo(s) — view in the client portal`;
}

/** Totals per UoM in first-appearance order: "40 pcs, 12.500 kg". */
function totalsOf(doc: GrnDocument, key: 'goodMilli' | 'damagedMilli' | 'shortMilli'): string {
  const groups = grnTotals(doc).byUom;
  if (groups.length === 0) return '0';
  return groups.map((group) => `${formatQuantity(group[key], group.uomPrecision)} ${group.uom}`).join(', ');
}

export function layoutGrnDocument(doc: GrnDocument): DocumentPage[] {
  const flow = new Flow();
  const mixed = doc.clientId === null;

  // ── header ────────────────────────────────────────────────────────────────
  flow.run(MARGIN, flow.y - 16, 16, 'bold', documentText('Goods Receipt Note', bold));
  const code = documentText(doc.code, bold);
  flow.run(MARGIN + CONTENT_WIDTH - bold.widthOfTextAtSize(code, 12), flow.y - 14, 12, 'bold', code);
  flow.gap(16 * LEADING + 2);
  flow.paragraph(`Received ${istLabel(doc.receivedAt)} · Recorded ${istLabel(doc.recordedAt)}`, BODY);
  flow.paragraph(`Document: ${grnDocumentRef(doc)}`, BODY, 'bold');
  flow.gap(4);

  // ── the three parties, side by side ──────────────────────────────────────
  const blocks = grnPartyBlocks(doc);
  const blockGap = 12;
  const blockWidth = (CONTENT_WIDTH - 2 * blockGap) / 3;
  const wrappedBlocks = blocks.map((block) => ({
    heading: documentText(block.heading, bold),
    lines: block.fields.flatMap((field) => wrapText(documentText(field, regular), regular, BODY, blockWidth, PARTY_FIELD_MAX_LINES)),
  }));
  const blockHeight = HEADING * LEADING + Math.max(...wrappedBlocks.map((block) => block.lines.length)) * BODY * LEADING;
  flow.ensure(blockHeight + 4);
  flow.rule(MARGIN, flow.y, MARGIN + CONTENT_WIDTH, flow.y, 0.75);
  flow.gap(4);
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

  // ── arrival (only when a gate-in is linked) ──────────────────────────────
  if (doc.arrival !== null) {
    const a = doc.arrival;
    flow.heading(`Arrival — as recorded on gate-in ${a.gateInCode}`, BODY * LEADING);
    const join = (parts: readonly (string | null)[]) => parts.filter((part): part is string => part !== null).join(' · ');
    const vehicle = join([a.vehicleNo === null ? null : `Vehicle ${a.vehicleNo}`, a.containerNo === null ? null : `Container ${a.containerNo}`]);
    const transporter = join([a.transporterName === null ? null : `Transporter ${a.transporterName}`, a.lrNumber === null ? null : `LR/AWB ${a.lrNumber}`]);
    const seal = join([
      `Seal ${SEAL_LABEL[a.sealStatus] ?? a.sealStatus}${a.sealNumber === null ? '' : ` ${a.sealNumber}`}`,
      a.dockDoor === null ? null : `Dock door ${a.dockDoor}`,
    ]);
    const times = join([
      `Gated in ${istLabel(a.gatedInAt)}`,
      a.unloadStartedAt === null ? null : `Unload started ${istLabel(a.unloadStartedAt)}`,
      a.unloadEndedAt === null ? null : `Unload ended ${istLabel(a.unloadEndedAt)}`,
    ]);
    for (const text of [vehicle, transporter, seal, times]) if (text !== '') flow.paragraph(text, BODY, 'regular', 4);
    for (const document of a.documents) {
      flow.paragraph(
        `${DOCUMENT_KIND_LABEL[document.kind] ?? document.kind} ${document.number} dated ${document.date}${document.ewayBillNo === null ? '' : ` · e-way bill ${document.ewayBillNo}`}`,
        BODY,
        'regular',
        4,
      );
    }
    if (a.documentsOmitted) flow.paragraph(GRN_DOCUMENTS_OMITTED, BODY);
  }

  // ── the lines ────────────────────────────────────────────────────────────
  flow.heading('Lines', 20);
  const columns: Column[] = [
    { header: '#', width: 16, align: 'right', maxLines: 1 },
    ...(mixed ? [{ header: 'Client', width: 30, align: 'left' as const, maxLines: CELL_MAX_LINES }] : []),
    { header: 'SKU', width: 50, align: 'left', maxLines: CELL_MAX_LINES },
    { header: 'Description', width: mixed ? 46 : 76, align: 'left', maxLines: SKU_NAME_MAX_LINES },
    { header: 'UoM', width: 22, align: 'left', maxLines: 1 },
    { header: 'Batch', width: 40, align: 'left', maxLines: CELL_MAX_LINES },
    { header: 'Mfg', width: 38, align: 'left', maxLines: 1 },
    { header: 'Expiry', width: 42, align: 'left', maxLines: 2 },
    { header: 'Expected', width: 34, align: 'right', maxLines: 1 },
    { header: 'Good', width: 34, align: 'right', maxLines: 1 },
    { header: 'Damaged', width: 34, align: 'right', maxLines: 1 },
    { header: 'Short', width: 30, align: 'right', maxLines: 1 },
    { header: 'Over-receipt', width: 52, align: 'left', maxLines: 4 },
    { header: 'QC', width: CONTENT_WIDTH - 468, align: 'left', maxLines: 4 },
  ];
  const lineRows = doc.lines.map((line) => [
    String(line.lineNo),
    ...(mixed ? [line.clientCode] : []),
    line.skuCode,
    line.skuName,
    line.uom,
    line.batchCode ?? '',
    line.mfgDate ?? '',
    line.expiryDate === null ? '' : `${line.expiryDate}${line.expirySource === 'derived' ? ' (derived)' : ''}`,
    line.expectedMilli === null ? '' : q(line.expectedMilli, line),
    q(line.goodMilli, line),
    q(line.damagedMilli, line),
    q(line.shortMilli, line),
    overReceiptCell(line),
    qcCell(line),
  ]);
  flow.table(columns, lineRows);

  // ── damage and short details ─────────────────────────────────────────────
  const affected = doc.lines.filter((line) => line.damagedMilli > 0 || line.shortMilli > 0 || line.photoCount > 0);
  if (affected.length > 0) {
    flow.heading('Damage and short details', 20);
    flow.table(
      [
        { header: '#', width: 16, align: 'right', maxLines: 1 },
        { header: 'SKU', width: 68, align: 'left', maxLines: CELL_MAX_LINES },
        { header: 'Damaged', width: 50, align: 'right', maxLines: 1 },
        { header: 'Damage reason', width: 80, align: 'left', maxLines: 2 },
        { header: 'Short', width: 50, align: 'right', maxLines: 1 },
        { header: 'Short reason', width: 80, align: 'left', maxLines: 2 },
        { header: 'Photos', width: CONTENT_WIDTH - 344, align: 'left', maxLines: 2 },
      ],
      affected.map((line) => [
        String(line.lineNo),
        line.skuCode,
        line.damagedMilli > 0 ? `${q(line.damagedMilli, line)} ${line.uom}` : '',
        damageReasonLabelOf(line.damageReasonCode) ?? '',
        line.shortMilli > 0 ? `${q(line.shortMilli, line)} ${line.uom}` : '',
        shortReasonLabelOf(line.shortReasonCode) ?? '',
        photosCell(line.photoCount),
      ]),
    );
  }

  // ── serials: the count, not the list (decision 11) ──────────────────────
  const serialLines = doc.lines.flatMap((line) => {
    const sentence = serialsSentence(line);
    return sentence === null ? [] : [`Line ${line.lineNo} ${line.skuCode}: ${sentence}`];
  });
  if (serialLines.length > 0) {
    flow.heading('Serials', BODY * LEADING);
    for (const text of serialLines) flow.paragraph(text, BODY, 'regular', 2);
  }

  // ── totals ───────────────────────────────────────────────────────────────
  flow.heading('Totals', BODY * LEADING * 4);
  flow.paragraph(`Lines: ${doc.lines.length}`, BODY);
  flow.paragraph(`Good: ${totalsOf(doc, 'goodMilli')}`, BODY);
  flow.paragraph(`Damaged: ${totalsOf(doc, 'damagedMilli')}`, BODY);
  flow.paragraph(`Short: ${totalsOf(doc, 'shortMilli')}`, BODY);

  // ── footer notes ─────────────────────────────────────────────────────────
  flow.gap(6);
  const notes = [
    GRN_RECEIPT_NOTE,
    GRN_NOT_AN_INVOICE,
    GRN_ITEMS_CURRENT,
    ...(doc.arrival === null ? [] : [GRN_ARRIVAL_LIVE]),
    ...(doc.parties.frozen ? [] : [GRN_NOT_FROZEN]),
  ];
  for (const note of notes) flow.paragraph(note, SMALL);

  // ── the two signature blocks, kept together ─────────────────────────────
  const signatureHeight = 56;
  flow.ensure(signatureHeight);
  const lineY = flow.y - 40;
  const half = CONTENT_WIDTH / 2;
  for (const [index, label] of ['For the warehouse', 'Delivered by (driver / transporter)'].entries()) {
    const x = MARGIN + index * half;
    flow.rule(x, lineY, x + half - 24, lineY, 0.5);
    flow.run(x, lineY - BODY - 2, BODY, 'regular', documentText(label, regular));
  }
  flow.y -= signatureHeight;

  // ── every page's footer ──────────────────────────────────────────────────
  const total = flow.pages.length;
  const printed = documentText(`${doc.code} · Printed ${istLabel(doc.printedAt)}`, regular);
  flow.pages.forEach((page, index) => {
    page.runs.push({ x: MARGIN, y: FOOTER_BASELINE, size: SMALL, font: 'regular', text: printed });
    const pageNo = `Page ${index + 1} of ${total}`;
    page.runs.push({ x: MARGIN + CONTENT_WIDTH - regular.widthOfTextAtSize(pageNo, SMALL), y: FOOTER_BASELINE, size: SMALL, font: 'regular', text: pageNo });
  });
  return flow.pages;
}
