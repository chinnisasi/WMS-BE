import { ProblemException } from '../../problem-details/problem.exception';
import { MAX_LABELS_PER_PRINT } from '../layout';
import type { LabelConsignee, LabelShipper } from './carton-label';
import { packageLabel, type ReturnShipmentKind } from './package-label';
import { renderShippingLabelsPdf } from './pdf';
import { renderShippingLabelsZpl } from './zpl';

/**
 * Story 4-5a (A22, A43) — the package-label print of a return shipment (RTV,
 * 2-8b; RTC, 4-7c), shared by both modules: the query's vocabularies, the
 * count and range rules, and the file. Pure apart from the PDF render.
 */

/** The `package_count` bound of 0105 / 0113. */
export const MAX_RETURN_PACKAGE_COUNT = 9999;

export interface PackageLabelQuery {
  readonly format: 'zpl' | 'pdf';
  readonly layout: 'label' | 'a4';
  readonly count: number | null;
  readonly from: number | null;
  readonly to: number | null;
}

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid request', detail);
}

function positiveInt(raw: unknown, name: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,3}$/.test(raw)) throw invalid(`${name} is a whole number 1–${MAX_RETURN_PACKAGE_COUNT}.`);
  return Number(raw);
}

/** `?format=zpl|pdf&layout=label|a4&count=&from=&to=` — the vocabularies (400). */
export function parsePackageLabelQuery(raw: { readonly format?: unknown; readonly layout?: unknown; readonly count?: unknown; readonly from?: unknown; readonly to?: unknown }): PackageLabelQuery {
  const format = raw.format === undefined || raw.format === '' ? 'zpl' : raw.format;
  if (format !== 'zpl' && format !== 'pdf') throw invalid('format is zpl or pdf.');
  const layout = raw.layout === undefined || raw.layout === '' ? 'label' : raw.layout;
  if (layout !== 'label' && layout !== 'a4') throw invalid('layout is label or a4.');
  if (format === 'zpl' && layout === 'a4') throw invalid('The A4 layout is a PDF — send format=pdf, or layout=label for ZPL.');
  return { format, layout, count: positiveInt(raw.count, 'count'), from: positiveInt(raw.from, 'from'), to: positiveInt(raw.to, 'to') };
}

/**
 * A22 / A43 — the packages to print. Before dispatch `count` is required
 * (400); after it, `count` defaults to the recorded `package_count` and a
 * different one is 409 `package-count-mismatch`. `from`/`to` print a slice
 * (1 ≤ from ≤ to ≤ count); one print renders at most 1,000 labels (422
 * `too-many-labels`, naming the range to ask for).
 */
export function resolvePackageRange(
  query: PackageLabelQuery,
  shipment: { readonly documentCode: string; readonly dispatched: boolean; readonly packageCount: number | null },
): { readonly count: number; readonly from: number; readonly to: number } {
  let count: number;
  if (shipment.dispatched && shipment.packageCount !== null) {
    if (query.count !== null && query.count !== shipment.packageCount) {
      throw new ProblemException(
        'package-count-mismatch',
        409,
        'Package count differs',
        `${shipment.documentCode} was dispatched as ${shipment.packageCount} package${shipment.packageCount === 1 ? '' : 's'} — print count=${shipment.packageCount}, or leave count out.`,
        { packageCount: shipment.packageCount },
      );
    }
    count = shipment.packageCount;
  } else {
    if (query.count === null) throw invalid(`count is required before dispatch — how many packages ${shipment.documentCode} leaves in (1–${MAX_RETURN_PACKAGE_COUNT}).`);
    count = query.count;
  }
  const from = query.from ?? 1;
  const to = query.to ?? count;
  if (from > to || to > count) throw invalid(`from and to name packages 1–${count}, from ≤ to (got ${from}–${to}).`);
  const n = to - from + 1;
  if (n > MAX_LABELS_PER_PRINT) {
    throw new ProblemException(
      'too-many-labels',
      422,
      'Too many labels for one print',
      `This print is ${n} labels — at most ${MAX_LABELS_PER_PRINT} print at once. Ask for from=${from}&to=${from + MAX_LABELS_PER_PRINT - 1}, then the rest.`,
      { count: n, max: MAX_LABELS_PER_PRINT, from, to: from + MAX_LABELS_PER_PRINT - 1 },
    );
  }
  return { count, from, to };
}

/** A45 — a consignee with no address of the kind: print by hand. */
export function consigneeAddressMissing(documentCode: string, party: string): ProblemException {
  return new ProblemException(
    'consignee-address-missing',
    409,
    'Consignee address missing',
    `${documentCode}'s consignee (${party}) has no address of the kind it ships to — add the address to the partner, or print by hand.`,
  );
}

export interface PackageLabelsFile {
  readonly filename: string;
  readonly contentType: string;
  readonly body: Buffer;
}

/** The file: `{code}-package-labels.{zpl|pdf}` (the code folded to `[A-Za-z0-9._-]`). */
export async function packageLabelsFile(input: {
  readonly kind: ReturnShipmentKind;
  readonly documentCode: string;
  readonly shipper: LabelShipper;
  readonly consignee: LabelConsignee;
  readonly carrierName: string | null;
  readonly trackingRef: string | null;
  readonly range: { readonly count: number; readonly from: number; readonly to: number };
  readonly query: PackageLabelQuery;
  readonly printedAt: string;
}): Promise<PackageLabelsFile> {
  const labels = [];
  for (let n = input.range.from; n <= input.range.to; n++) {
    labels.push(
      packageLabel({
        kind: input.kind,
        documentCode: input.documentCode,
        shipper: input.shipper,
        consignee: input.consignee,
        packageNo: n,
        packageCount: input.range.count,
        carrierName: input.carrierName,
        trackingRef: input.trackingRef,
      }),
    );
  }
  const stem = `${input.documentCode.replace(/[^A-Za-z0-9._-]+/g, '_')}-package-labels`;
  return input.query.format === 'zpl'
    ? { filename: `${stem}.zpl`, contentType: 'text/plain; charset=us-ascii', body: Buffer.from(renderShippingLabelsZpl(labels), 'ascii') }
    : {
        filename: `${stem}.pdf`,
        contentType: 'application/pdf',
        body: await renderShippingLabelsPdf(labels, { layout: input.query.layout, title: `Package labels ${input.documentCode}`, creationDate: input.printedAt }),
      };
}
