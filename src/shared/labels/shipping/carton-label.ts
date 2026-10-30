import { istDateOf } from '../../primitives/time';
import type { DocumentWarehouseParty } from '../../documents/parties';
import {
  barcodeField,
  fitText,
  reverseField,
  ruleField,
  singleText,
  stack,
  type FittedLine,
  type LabelBand,
  type ShippingField,
  type ShippingLabel,
} from './fields';
import { FIELD_GAP_DOTS, SHIPPING_LABEL, SHIPPING_PRINTABLE_DOTS } from './geometry';

/**
 * Story 4-5a (A16, A42, decision 6) — the 4×6 carton label, one per carton:
 * FROM the brand c/o the warehouse with "CARTON n/N" boxed beside it; TO the
 * consignee; the order, its packed date, the carton's weight and size and the
 * payment (COD on carton 1 only, reversed); the seam band (4-6a's EWB line,
 * 4-10a's hazard marks — empty in 4-5a); the courier and the AWB with its
 * barcode; and the carton code's barcode. Pure.
 */

const X = SHIPPING_LABEL.marginDots;
const W = SHIPPING_PRINTABLE_DOTS;
const GAP = FIELD_GAP_DOTS;

/** A42's bands (dots from the top). The ORDER band ends at 754; the seam band is 760–806. */
export const CARTON_LABEL_BANDS: readonly LabelBand[] = [
  { name: 'from', top: 30, bottom: 150 },
  { name: 'to', top: 175, bottom: 560 },
  { name: 'order', top: 580, bottom: 754 },
  { name: 'seam', top: 760, bottom: 806 },
  { name: 'courier', top: 820, bottom: 1010 },
  { name: 'carton', top: 1030, bottom: 1188 },
];

/** Who ships it: the brand, care of the warehouse (A45 — no contact, no phone). */
export interface LabelShipper {
  readonly brandName: string;
  readonly warehouseName: string;
  /** Null when the warehouse has no address: the label prints `c/o {name}` only. */
  readonly warehouseCity: string | null;
  readonly warehousePincode: string | null;
}

export function labelShipperOf(brandName: string, warehouse: DocumentWarehouseParty): LabelShipper {
  return {
    brandName,
    warehouseName: warehouse.name,
    warehouseCity: warehouse.address?.city ?? null,
    warehousePincode: warehouse.address?.pincode ?? null,
  };
}

/** Who receives it. */
export interface LabelConsignee {
  readonly contactName: string;
  /** B2B only. */
  readonly legalName: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly state: string;
  readonly pincode: string;
  readonly phone: string | null;
  /** B2B only. */
  readonly gstin: string | null;
}

export type LabelPayment = { readonly kind: 'cod'; readonly amountPaise: number } | { readonly kind: 'prepaid' };

export interface CartonLabelInput {
  readonly shipper: LabelShipper;
  readonly consignee: LabelConsignee;
  readonly orderLabel: string;
  readonly clientOrderRef: string | null;
  /** The physical pack's instant (A47 — a re-carton keeps it). */
  readonly packedAt: string;
  /** Set when the pack number is above 1 (A47: "Re-packed {IST}"). */
  readonly repackedAt?: string | null;
  readonly cartonNo: number;
  readonly cartonCount: number;
  readonly weightGrams: number | null;
  readonly dimensionsMm: { readonly lengthMm: number; readonly widthMm: number; readonly heightMm: number } | null;
  /** Null for a legacy order with no type: nothing prints. */
  readonly payment: LabelPayment | null;
  readonly courierName: string | null;
  readonly awb: string | null;
  readonly cartonCode: string;
  /** 4-6a's seam ("EWB 1234 5678 9012"). */
  readonly extraLines?: readonly string[];
  /** 4-10a's seam (the UN number and hazard class). */
  readonly marks?: readonly string[];
  /** Story 4-9a (A24) — `pallet` prints `PALLET` in the box; absent or `carton` prints `CARTON` (byte-identical). */
  readonly packageType?: 'carton' | 'pallet';
  /** Story 4-9a (A24) — a pallet's "said to contain" count: the order band prints `STC {n} CARTONS`. */
  readonly innerCount?: number | null;
}

/** Story 4-9a (A24) — `STC 600 CARTONS`, or null when no inner count is set. */
export function stcText(innerCount: number | null | undefined): string | null {
  return innerCount === null || innerCount === undefined ? null : `STC ${innerCount} CARTONS`;
}

/** `125000` paise → `Rs 1,250.00` — Indian digit grouping (x,xx,xxx.xx), integer arithmetic. */
export function indianRupees(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const whole = String(Math.trunc(abs / 100));
  const fraction = String(abs % 100).padStart(2, '0');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `${negative ? '-' : ''}Rs ${grouped}.${fraction}`;
}

/** Grams → `4.20 kg`. */
export function kgText(grams: number): string {
  return `${(grams / 1000).toFixed(2)} kg`;
}

/** Millimetres → `40x30x20 cm` (one decimal at most). */
export function cmText(dims: { readonly lengthMm: number; readonly widthMm: number; readonly heightMm: number }): string {
  const cm = (mm: number) => (mm / 10).toFixed(1).replace(/\.0$/, '');
  return `${cm(dims.lengthMm)}x${cm(dims.widthMm)}x${cm(dims.heightMm)} cm`;
}

/** The FROM band: brand c/o warehouse on the left, a box on the right with `title` over `n/N`. */
export function fromBand(shipper: LabelShipper, title: string, n: number, count: number): ShippingField[] {
  const boxX = 582;
  const leftWidth = boxX - X - 12;
  const place = [shipper.warehouseCity, shipper.warehousePincode].filter((part): part is string => part !== null && part.trim() !== '').join(' ');
  const careOf = place === '' ? `c/o ${shipper.warehouseName}` : `c/o ${shipper.warehouseName}, ${place}`;
  const left = stack(
    'from',
    X,
    36,
    leftWidth,
    [
      { h: 40, lines: fitText(`FROM ${shipper.brandName}`, 40, leftWidth, 1), bold: true },
      { h: 28, lines: fitText(careOf, 28, leftWidth, 2) },
    ],
    GAP,
  );
  const boxW = SHIPPING_LABEL.widthDots - X - boxX;
  const fields: ShippingField[] = [...left.fields, { kind: 'box', band: 'from', x: boxX, y: 30, w: boxW, h: 120, t: 3 }];
  const titleField = singleText('from', boxX + 14, 38, 28, boxW - 28, title, true);
  if (titleField !== null) fields.push(titleField);
  const count_ = singleText('from', boxX + 14, 68, 80, boxW - 28, `${n}/${count}`, true);
  if (count_ !== null) fields.push(count_);
  return fields;
}

/**
 * The TO band (A42): contact 44, legal name 32 (B2B), line 1 and line 2 at 32
 * (each ≤ 2 lines, ≤ 3 together), city/state 32, PIN 64, Ph 28, GSTIN 26.
 * On overflow it drops, in order: line 2's second wrap → the legal name (B2B
 * keeps the GSTIN) → the phone. Still over → throws (a programming error).
 */
export function toBand(consignee: LabelConsignee, band = 'to', top = 175, bottom = 560): ShippingField[] {
  let line1 = fitText(consignee.line1, 32, W, 2);
  let line2 = consignee.line2 === null ? [] : fitText(consignee.line2, 32, W, 2);
  if (line1.length + line2.length > 3) line2 = consignee.line2 === null ? [] : fitText(consignee.line2, 32, W, 1);
  if (line1.length > 3) line1 = line1.slice(0, 3);
  const legal = consignee.legalName === null ? [] : fitText(consignee.legalName, 32, W, 1);
  const phone = consignee.phone === null || consignee.phone.trim() === '' ? [] : fitText(`Ph ${consignee.phone}`, 28, W, 1);
  const build = (l2: readonly FittedLine[], legalLines: readonly FittedLine[], phoneLines: readonly FittedLine[]) =>
    stack(
      band,
      X,
      top,
      W,
      [
        { h: 28, lines: fitText('TO', 28, W, 1), bold: true },
        { h: 44, lines: fitText(consignee.contactName, 44, W, 1), bold: true },
        { h: 32, lines: legalLines },
        { h: 32, lines: line1 },
        { h: 32, lines: l2 },
        { h: 32, lines: fitText(`${consignee.city}, ${consignee.state}`, 32, W, 1) },
        { h: 64, lines: fitText(`PIN ${consignee.pincode}`, 64, W, 1), bold: true },
        { h: 28, lines: phoneLines },
        { h: 26, lines: consignee.gstin === null ? [] : fitText(`GSTIN ${consignee.gstin}`, 26, W, 1) },
      ],
      GAP,
    );
  const line2Cut = line2.length === 2 && consignee.line2 !== null ? fitText(consignee.line2, 32, W, 1) : line2;
  const attempts = [
    build(line2, legal, phone),
    build(line2Cut, legal, phone),
    build(line2Cut, [], phone),
    build(line2Cut, [], []),
  ];
  const fit = attempts.find((attempt) => attempt.bottom <= bottom);
  if (fit === undefined) throw new Error(`the TO band overflows (${attempts[attempts.length - 1]!.bottom} > ${bottom})`);
  return fit.fields;
}

/** The courier band: `{courier}  AWB {awb}` on one 36-dot line, the AWB's barcode (110) when it fits. */
export function courierBand(courierName: string | null, awb: string | null, band = 'courier', top = 826): ShippingField[] {
  const words = [courierName ?? '', `AWB ${awb ?? '__________'}`].filter((part) => part.trim() !== '').join(' | ');
  const fields: ShippingField[] = [];
  const line = singleText(band, X, top, 36, W, words, true);
  if (line !== null) fields.push(line);
  if (awb !== null) {
    const bars = barcodeField(band, X, top + 36 + GAP, 110, W, awb);
    if (bars !== null) fields.push(bars);
  }
  return fields;
}

/** Story 4-5a — the carton label. */
export function cartonLabel(input: CartonLabelInput): ShippingLabel {
  const fields: ShippingField[] = [];
  fields.push(...fromBand(input.shipper, input.packageType === 'pallet' ? 'PALLET' : 'CARTON', input.cartonNo, input.cartonCount));
  fields.push(ruleField(165));
  fields.push(...toBand(input.consignee));
  fields.push(ruleField(570));

  // ORDER band (580–754): the order on the left, the payment on the right.
  const payX = 440;
  const payW = SHIPPING_LABEL.widthDots - X - payX;
  const leftWidth = payX - X - 10;
  const packed = `Packed ${istDateOf(input.packedAt)}${input.repackedAt ? ` | Re-packed ${istDateOf(input.repackedAt)}` : ''}`;
  const measures = [input.weightGrams === null ? '' : kgText(input.weightGrams), input.dimensionsMm === null ? '' : cmText(input.dimensionsMm)]
    .filter((part) => part !== '')
    .join(' | ');
  const showRef = input.clientOrderRef !== null && input.clientOrderRef.trim() !== '' && input.clientOrderRef !== input.orderLabel;
  // The order and its ref beside the payment; the dates and measurements
  // below it, across the full width (the payment box ends at 666).
  // Story 4-9a (A24) — a pallet's inner count: its own 28-dot line beside
  // the payment when the band has room; otherwise (a Ref line too) it joins
  // the measurements line, so the band never overflows (the stated drop order).
  const stc = stcText(input.innerCount);
  const build = (stcOwnLine: boolean) => {
    const head = stack(
      'order',
      X,
      586,
      leftWidth,
      [
        { h: 40, lines: fitText(`ORDER ${input.orderLabel}`, 40, leftWidth, 1), bold: true },
        { h: 28, lines: showRef ? fitText(`Ref ${input.clientOrderRef}`, 28, leftWidth, 1) : [] },
        { h: 28, lines: stc !== null && stcOwnLine ? fitText(stc, 28, leftWidth, 1) : [] },
      ],
      GAP,
    );
    const measured = stc !== null && !stcOwnLine ? [measures, stc].filter((part) => part !== '').join(' | ') : measures;
    const low = stack(
      'order',
      X,
      Math.max(head.bottom + GAP, 672),
      W,
      [
        { h: 28, lines: fitText(packed, 28, W, 1) },
        { h: 32, lines: measured === '' ? [] : fitText(measured, 32, W, 1) },
      ],
      GAP,
    );
    return { fields: [...head.fields, ...low.fields], bottom: low.bottom };
  };
  const ownLine = build(true);
  fields.push(...(stc === null || ownLine.bottom <= 754 ? ownLine : build(false)).fields);
  if (input.payment !== null) {
    if (input.payment.kind === 'prepaid') {
      const prepaid = singleText('order', payX, 596, 56, payW, 'PREPAID', true);
      if (prepaid !== null) fields.push(prepaid);
    } else if (input.cartonNo === 1) {
      fields.push(reverseField('order', payX, 586, payW, 80, 44, `COD ${indianRupees(input.payment.amountPaise)}`));
    } else {
      const elsewhere = singleText('order', payX, 600, 40, payW, 'COD ON CARTON 1', true);
      if (elsewhere !== null) fields.push(elsewhere);
    }
  }
  const seam = [...(input.extraLines ?? []), ...(input.marks ?? [])].slice(0, 2);
  fields.push(...stack('seam', X, 762, W, seam.map((text) => ({ h: 22, lines: fitText(text, 22, W, 1) })), 0).fields);
  fields.push(ruleField(810));
  fields.push(...courierBand(input.courierName, input.awb));
  fields.push(ruleField(1020));
  const bars = barcodeField('carton', X, 1036, 110, W, input.cartonCode);
  if (bars !== null) fields.push(bars);
  const codeText = singleText('carton', X, 1152, 28, W, input.cartonCode);
  if (codeText !== null) fields.push(codeText);
  return { bands: CARTON_LABEL_BANDS, fields };
}
