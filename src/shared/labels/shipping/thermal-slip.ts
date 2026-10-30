import { formatLabelQuantity } from '../layout';
import { fitText, reverseField, ruleField, singleText, stack, type LabelBand, type ShippingField, type ShippingLabel } from './fields';
import { FIELD_GAP_DOTS, SHIPPING_LABEL, SHIPPING_PRINTABLE_DOTS } from './geometry';

/**
 * Story 4-5a (A18, A36) — the 4×6 thermal packing slip that goes INSIDE a
 * carton: the order, `CARTON n/N` reversed, the consignee's name and place,
 * then the carton's SKUs (code left, quantity and UoM right, the name below),
 * 12 rows per label, sorted by SKU code. A carton with more rows prints
 * continuation labels `k/m`; the last carries the totals per UoM (never a
 * cross-UoM sum — A36) and "Not a tax invoice". Pure.
 */

const X = SHIPPING_LABEL.marginDots;
const W = SHIPPING_PRINTABLE_DOTS;
export const THERMAL_SLIP_ROWS_PER_LABEL = 12;
const ROW_PITCH = 70;
const QTY_X = 520;

export const THERMAL_SLIP_BANDS: readonly LabelBand[] = [
  { name: 'head', top: 30, bottom: 260 },
  { name: 'rows', top: 270, bottom: 1110 },
  { name: 'foot', top: 1120, bottom: 1188 },
];

export interface ThermalSlipRow {
  readonly skuCode: string;
  readonly skuName: string;
  /** Base units. */
  readonly qty: number;
  readonly uom: string;
}

export interface ThermalSlipInput {
  readonly orderLabel: string;
  readonly cartonNo: number;
  readonly cartonCount: number;
  readonly consigneeName: string;
  readonly city: string;
  readonly pincode: string;
  readonly rows: readonly ThermalSlipRow[];
}

/** `12 EA, 2.5 KG` — one total per UoM, in first-seen (sorted-row) order. */
export function totalsPerUom(rows: readonly { readonly qty: number; readonly uom: string }[]): string {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.uom, Math.round(((totals.get(row.uom) ?? 0) + row.qty) * 1000) / 1000);
  return [...totals].map(([uom, qty]) => `${formatLabelQuantity(qty)} ${uom}`).join(', ');
}

/** How many labels a carton of `rows` rows prints (at least one). */
export function thermalSlipLabelCount(rows: number): number {
  return Math.max(1, Math.ceil(rows / THERMAL_SLIP_ROWS_PER_LABEL));
}

export function thermalSlipLabels(input: ThermalSlipInput): ShippingLabel[] {
  const rows = [...input.rows].sort((a, b) => (a.skuCode < b.skuCode ? -1 : a.skuCode > b.skuCode ? 1 : 0));
  const pages = thermalSlipLabelCount(rows.length);
  const labels: ShippingLabel[] = [];
  for (let k = 0; k < pages; k += 1) {
    const fields: ShippingField[] = [];
    fields.push(
      ...stack(
        'head',
        X,
        36,
        W,
        [
          { h: 40, lines: fitText('PACKING SLIP', 40, W, 1), bold: true },
          { h: 36, lines: fitText(`ORDER ${input.orderLabel}`, 36, W, 1), bold: true },
        ],
        FIELD_GAP_DOTS,
      ).fields,
    );
    fields.push(reverseField('head', X, 124, 400, 56, 40, `CARTON ${input.cartonNo}/${input.cartonCount}`));
    if (pages > 1) {
      const cont = singleText('head', 450, 138, 28, W - 420, `Slip ${k + 1}/${pages}`, true);
      if (cont !== null) fields.push(cont);
    }
    fields.push(
      ...stack(
        'head',
        X,
        188,
        W,
        [
          { h: 28, lines: fitText(input.consigneeName, 28, W, 1) },
          { h: 28, lines: fitText(`${input.city} ${input.pincode}`, 28, W, 1) },
        ],
        FIELD_GAP_DOTS,
      ).fields,
    );
    fields.push(ruleField(264));
    rows.slice(k * THERMAL_SLIP_ROWS_PER_LABEL, (k + 1) * THERMAL_SLIP_ROWS_PER_LABEL).forEach((row, index) => {
      const y = 272 + index * ROW_PITCH;
      const code = singleText('rows', X, y, 32, QTY_X - X - 12, row.skuCode, true);
      if (code !== null) fields.push(code);
      const qty = singleText('rows', QTY_X, y, 32, X + W - QTY_X, `${formatLabelQuantity(row.qty)} ${row.uom}`, true);
      if (qty !== null) fields.push(qty);
      const name = singleText('rows', X, y + 36, 24, W, row.skuName);
      if (name !== null) fields.push(name);
    });
    fields.push(ruleField(1112));
    if (k === pages - 1) {
      fields.push(
        ...stack(
          'foot',
          X,
          1124,
          W,
          [
            { h: 24, lines: fitText(`Total ${totalsPerUom(rows)}`, 24, W, 1), bold: true },
            { h: 24, lines: fitText('Not a tax invoice', 24, W, 1) },
          ],
          FIELD_GAP_DOTS,
        ).fields,
      );
    } else {
      const more = singleText('foot', X, 1124, 24, W, `Continued on slip ${k + 2}/${pages}`);
      if (more !== null) fields.push(more);
    }
    labels.push({ bands: THERMAL_SLIP_BANDS, fields });
  }
  return labels;
}
