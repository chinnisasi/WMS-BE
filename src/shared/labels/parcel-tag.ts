import { parcelTagCode } from '../primitives/parcel-tag';
import { moduleCount } from './code128';
import { fitModuleWidth, labelPrintableDots, type LabelLines, type LabelSize } from './layout';
import { renderLabelsPdf } from './pdf';
import { asciiFold } from './text';
import { renderLabelsZpl } from './zpl';

/**
 * Story 4-4a (A16, D32) — the parcel tag: printed at the pack bench for every
 * client-arranged parcel, so a handover can pair a courier's label with an
 * order by scanning both. 4×2 ONLY: the 17-character code (222 modules) needs
 * 484 dots at the 2-dot bar and a 2×1 label prints 366 (pinned by the spec).
 *
 * - the code band: `{client code} {order label}`;
 * - the barcode: `parcelTagCode(orderId)` (a match key, never an AWB);
 * - line 1: the destination city and pincode;
 * - line 2: `COD Rs <amount>` or `Prepaid`, then the parcel count, then
 *   `Carton n/N` when given (4-5a's per-carton tags).
 * Every printed string is ASCII-folded (WinAnsi, the 2-10a limit).
 */
export const PARCEL_TAG_SIZE: LabelSize = '4x2';

export interface ParcelTagLabel {
  readonly orderId: string;
  readonly orderLabel: string;
  readonly clientCode: string;
  readonly destinationCity: string | null;
  readonly destinationPincode: string | null;
  readonly codAmountPaise: number | null;
  readonly packageCount: number;
  /** 4-5a — the carton this tag is for, of how many. */
  readonly cartonNo?: number;
  readonly cartonCount?: number;
}

/** `₹499.00` → `Rs 499.00` (integer paise, never a float). */
export function rupeesText(paise: number): string {
  const whole = Math.trunc(paise / 100);
  const fraction = String(Math.abs(paise % 100)).padStart(2, '0');
  return `Rs ${whole}.${fraction}`;
}

export function parcelTagLines(label: ParcelTagLabel): LabelLines {
  const place = [label.destinationCity, label.destinationPincode].filter((part): part is string => part !== null && part.trim() !== '').join(' ');
  const parts = [
    label.codAmountPaise === null ? 'Prepaid' : `COD ${rupeesText(label.codAmountPaise)}`,
    `${label.packageCount} parcel${label.packageCount === 1 ? '' : 's'}`,
  ];
  if (label.cartonNo !== undefined && label.cartonCount !== undefined) parts.push(`Carton ${label.cartonNo}/${label.cartonCount}`);
  return {
    code: asciiFold(`${label.clientCode} ${label.orderLabel}`),
    payload: parcelTagCode(label.orderId),
    line1: asciiFold(place === '' ? '-' : place),
    line2: asciiFold(parts.join(' | ')),
  };
}

/** Does the tag's code fit a label size at the 2-dot minimum bar? (4×2 yes, 2×1 no.) */
export function parcelTagFits(size: LabelSize): boolean {
  return fitModuleWidth(moduleCount(17), labelPrintableDots(size)) !== null;
}

export function renderParcelTagZpl(label: ParcelTagLabel): string {
  return renderLabelsZpl([parcelTagLines(label)], PARCEL_TAG_SIZE);
}

export async function renderParcelTagPdf(label: ParcelTagLabel): Promise<Buffer> {
  return renderLabelsPdf([parcelTagLines(label)], { layout: 'label', size: PARCEL_TAG_SIZE, title: 'Parcel tag' });
}
