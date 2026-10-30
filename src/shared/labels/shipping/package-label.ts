import { barcodeField, fitText, ruleField, singleText, stack, type LabelBand, type ShippingField, type ShippingLabel } from './fields';
import { FIELD_GAP_DOTS, SHIPPING_LABEL, SHIPPING_PRINTABLE_DOTS } from './geometry';
import { fromBand, toBand, type LabelConsignee, type LabelShipper } from './carton-label';

/**
 * Story 4-5a (A22, A43) — the 4×6 package label for a return shipment (RTV
 * to a vendor, 2-8b; RTC to the client, 4-7c), through the same renderer as
 * the carton label: FROM the brand c/o the warehouse with `PACKAGE n/N`
 * boxed; TO the frozen consignee; `RETURN TO VENDOR {code}` / `RETURN TO
 * CLIENT {code}`; the carrier and tracking reference once dispatched; and the
 * barcode `{code}.{n}`. No per-package contents (4-7c A9, post-go-live). Pure.
 */

const X = SHIPPING_LABEL.marginDots;
const W = SHIPPING_PRINTABLE_DOTS;

export const PACKAGE_LABEL_BANDS: readonly LabelBand[] = [
  { name: 'from', top: 30, bottom: 150 },
  { name: 'to', top: 175, bottom: 560 },
  { name: 'doc', top: 580, bottom: 754 },
  { name: 'courier', top: 820, bottom: 1010 },
  { name: 'code', top: 1030, bottom: 1188 },
];

export type ReturnShipmentKind = 'rtv' | 'rtc';

export interface PackageLabelInput {
  readonly kind: ReturnShipmentKind;
  /** `RTV-0007` / `RTC-0003`. */
  readonly documentCode: string;
  readonly shipper: LabelShipper;
  readonly consignee: LabelConsignee;
  readonly packageNo: number;
  readonly packageCount: number;
  /** Once dispatched. */
  readonly carrierName: string | null;
  readonly trackingRef: string | null;
}

/** The package's barcode payload: `{code}.{n}` (e.g. `RTV-0007.2`). */
export function packageCode(documentCode: string, packageNo: number): string {
  return `${documentCode}.${packageNo}`;
}

export function packageLabel(input: PackageLabelInput): ShippingLabel {
  const fields: ShippingField[] = [];
  fields.push(...fromBand(input.shipper, 'PACKAGE', input.packageNo, input.packageCount));
  fields.push(ruleField(165));
  fields.push(...toBand(input.consignee));
  fields.push(ruleField(570));
  const title = `${input.kind === 'rtv' ? 'RETURN TO VENDOR' : 'RETURN TO CLIENT'} ${input.documentCode}`;
  fields.push(...stack('doc', X, 590, W, [{ h: 44, lines: fitText(title, 44, W, 1), bold: true }], FIELD_GAP_DOTS).fields);
  fields.push(ruleField(810));
  if (input.carrierName !== null || input.trackingRef !== null) {
    const words = [input.carrierName ?? '', input.trackingRef === null ? '' : `Ref ${input.trackingRef}`].filter((part) => part !== '').join(' | ');
    const line = singleText('courier', X, 826, 36, W, words, true);
    if (line !== null) fields.push(line);
    if (input.trackingRef !== null) {
      const bars = barcodeField('courier', X, 868, 110, W, input.trackingRef);
      if (bars !== null) fields.push(bars);
    }
  } else {
    const blank = singleText('courier', X, 826, 36, W, 'Carrier ____________ | Ref ____________', true);
    if (blank !== null) fields.push(blank);
  }
  fields.push(ruleField(1020));
  const code = packageCode(input.documentCode, input.packageNo);
  const bars = barcodeField('code', X, 1036, 110, W, code);
  if (bars !== null) fields.push(bars);
  const text = singleText('code', X, 1152, 28, W, code);
  if (text !== null) fields.push(text);
  return { bands: PACKAGE_LABEL_BANDS, fields };
}
