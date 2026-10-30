import { headerText, html, plainText } from './escape';
import { istLongDateTime, type RenderedEmail } from './invite';
import {
  asRecord,
  clientFooter,
  clientFromName,
  clientHtml,
  countField,
  htmlTable,
  instantField,
  linesField,
  moreLinesNote,
  nullableText,
  quantityField,
  textField,
} from './client-notice';
import type { ClientAttachmentState } from './client-receipt';

/**
 * Story 5-2b — the `client-dispatch` notice: one email per opted-in contact
 * of the client whose order was dispatched. What is STORED is exactly
 * `ClientDispatchEmailParams`, built key by key from the frozen outbox
 * payload. No consignee name, address, phone, GSTIN or COD amount — ever
 * (5-2a decision 5's minimisation). Kit parent lines are dropped (their
 * components remain).
 */
export interface ClientDispatchLineParams {
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly ordered: string;
  readonly dispatched: string;
  readonly short: string;
}

export interface ClientDispatchEmailParams {
  readonly tenantName: string;
  readonly clientName: string;
  readonly warehouseName: string;
  /** The order's label: its client order number, else its channel reference, else its short id. */
  readonly orderRef: string;
  /** The channel's reference, shown only when it differs from `orderRef` (both exist). */
  readonly channelRef: string | null;
  readonly dispatchedAt: string;
  readonly carrierName: string | null;
  readonly trackingNumber: string | null;
  /** Units dispatched over every kept line, per UoM: `"12.500 kg, 2 pcs"`. */
  readonly totalUnits: string;
  readonly replyTo: string | null;
  readonly lines: readonly ClientDispatchLineParams[];
  readonly moreLines: number;
  /** True when any line (shown or not) shipped short. */
  readonly shortShipped: boolean;
  /**
   * Story 4-6a (A20) — the brand's tax document the goods left under, from
   * the consignment version stamped at dispatch (immutable, so the fact is
   * frozen). Optional: a 5-2b / 4-5a row stored none and renders its bytes.
   */
  readonly taxDocument?: { readonly label: string; readonly number: string; readonly date: string } | null;
  /** Story 4-6a (A20) — the e-way bill (number as recorded, its last valid day). */
  readonly ewayBill?: { readonly number: string; readonly validUntil: string | null } | null;
  /**
   * Story 4-9a (A27) — the truck the order left on, from its freight
   * consignment's frozen carriage snapshot. Optional: present only for an
   * order dispatched on a freight load (every other row keeps its bytes).
   */
  readonly freight?: { readonly consignmentRef: string; readonly vehicleNumber: string; readonly packageCount: number } | null;
}

const WHAT = 'client-dispatch params';

export function decodeClientDispatchParams(raw: unknown): ClientDispatchEmailParams {
  const value = asRecord(raw, WHAT);
  if (typeof value.shortShipped !== 'boolean') throw new Error(`${WHAT}: shortShipped is not a boolean`);
  return {
    tenantName: textField(value, 'tenantName', WHAT),
    clientName: textField(value, 'clientName', WHAT),
    warehouseName: textField(value, 'warehouseName', WHAT),
    orderRef: textField(value, 'orderRef', WHAT),
    channelRef: nullableText(value, 'channelRef', WHAT),
    dispatchedAt: instantField(value, 'dispatchedAt', WHAT),
    carrierName: nullableText(value, 'carrierName', WHAT),
    trackingNumber: nullableText(value, 'trackingNumber', WHAT),
    totalUnits: textField(value, 'totalUnits', WHAT),
    replyTo: nullableText(value, 'replyTo', WHAT),
    lines: linesField(value, 'lines', WHAT, (line) => ({
      skuCode: textField(line, 'skuCode', WHAT),
      skuName: textField(line, 'skuName', WHAT),
      uom: textField(line, 'uom', WHAT),
      ordered: quantityField(line, 'ordered', WHAT),
      dispatched: quantityField(line, 'dispatched', WHAT),
      short: quantityField(line, 'short', WHAT),
    })),
    moreLines: countField(value, 'moreLines', WHAT),
    shortShipped: value.shortShipped,
    // Story 4-6a — optional keys, decoded only when present (an older row has none).
    ...(value.taxDocument === undefined || value.taxDocument === null ? {} : { taxDocument: decodeTaxDocument(value.taxDocument) }),
    ...(value.ewayBill === undefined || value.ewayBill === null ? {} : { ewayBill: decodeEwayBill(value.ewayBill) }),
    // Story 4-9a — optional, decoded only when present.
    ...(value.freight === undefined || value.freight === null ? {} : { freight: decodeFreight(value.freight) }),
  };
}

function decodeFreight(raw: unknown): { consignmentRef: string; vehicleNumber: string; packageCount: number } {
  const value = asRecord(raw, `${WHAT} freight`);
  const packageCount = value.packageCount;
  if (typeof packageCount !== 'number' || !Number.isSafeInteger(packageCount) || packageCount < 1) throw new Error(`${WHAT}: freight.packageCount is not a count`);
  return { consignmentRef: textField(value, 'consignmentRef', WHAT), vehicleNumber: textField(value, 'vehicleNumber', WHAT), packageCount };
}

/** Story 4-9a (A27) — "By truck KA01AB1234 — 15 packages, freight note LD-0007/03", or null for an order that left by no truck. */
export function dispatchFreightLine(params: Pick<ClientDispatchEmailParams, 'freight'>): string | null {
  const freight = params.freight ?? null;
  if (freight === null) return null;
  return `By truck ${plainText(freight.vehicleNumber)} — ${freight.packageCount} ${freight.packageCount === 1 ? 'package' : 'packages'}, freight note ${plainText(freight.consignmentRef)}`;
}

function decodeTaxDocument(raw: unknown): { label: string; number: string; date: string } {
  const value = asRecord(raw, `${WHAT} taxDocument`);
  return { label: textField(value, 'label', WHAT), number: textField(value, 'number', WHAT), date: textField(value, 'date', WHAT) };
}

function decodeEwayBill(raw: unknown): { number: string; validUntil: string | null } {
  const value = asRecord(raw, `${WHAT} ewayBill`);
  const number = textField(value, 'number', WHAT);
  if (!/^[0-9]{12}$/.test(number)) throw new Error(`${WHAT}: ewayBill.number is not 12 digits`);
  return { number, validUntil: nullableText(value, 'validUntil', WHAT) };
}

/** Story 4-6a (A20) — "Sent under Invoice INV-1 · E-way bill 1234 5678 9012", or null when no document was recorded. */
export function dispatchDocumentsLine(params: Pick<ClientDispatchEmailParams, 'taxDocument' | 'ewayBill'>): string | null {
  const doc = params.taxDocument ?? null;
  if (doc === null) return null;
  const eway = params.ewayBill ?? null;
  const number = eway === null ? null : `${eway.number.slice(0, 4)} ${eway.number.slice(4, 8)} ${eway.number.slice(8)}`;
  return `Sent under ${plainText(doc.label)} ${plainText(doc.number)}${number === null ? '' : ` · E-way bill ${number}`}`;
}

/** `{client}: order {ref} dispatched` plus ` — {carrier} {tracking}` when either is known. */
export function clientDispatchSubject(params: Pick<ClientDispatchEmailParams, 'clientName' | 'orderRef' | 'carrierName' | 'trackingNumber'>): string {
  const shipping = [params.carrierName, params.trackingNumber].filter((part): part is string => part !== null).map(plainText);
  return headerText(
    `${plainText(params.clientName)}: order ${plainText(params.orderRef)} dispatched${shipping.length === 0 ? '' : ` — ${shipping.join(' ')}`}`,
  );
}

export const DISPATCH_SHORT_NOTE = 'Short-shipped: some lines were dispatched short of the ordered quantity.';

/** Story 4-5a (A20) — the attachment's name in the body: the SAME fold as outbound's `packDocumentFileStem` (mail imports nothing from outbound). */
export function packingSlipFileName(orderRef: string): string {
  return `${orderRef.replace(/[^A-Za-z0-9._-]/g, '_') || 'order'}-packing-slip.pdf`;
}

export const DISPATCH_SLIP_TOO_LARGE = 'The packing slip is too large to attach — download it from the client portal.';
export const DISPATCH_SLIP_FAILED = 'The packing slip could not be attached — download it from the client portal.';

/**
 * Renders the dispatch notice. `portalUrl` is `{WEB_BASE_URL}/portal/orders`.
 * Story 4-5a (A20, D9) — `attachment` is what the sender attached: `none`
 * (a 5-2b row — its bytes exactly), `attached`, or sent without the file.
 */
export function renderClientDispatchEmail(
  params: ClientDispatchEmailParams,
  portalUrl: string,
  fallbackReplyTo: string | null,
  attachment: ClientAttachmentState = 'none',
): RenderedEmail {
  const tenant = plainText(params.tenantName);
  const client = plainText(params.clientName);
  const warehouse = plainText(params.warehouseName);
  const ref = plainText(params.orderRef);
  const when = istLongDateTime(params.dispatchedAt);
  const subject = clientDispatchSubject(params);
  const replyTo = params.replyTo ?? fallbackReplyTo;
  const footer = clientFooter(tenant, client, replyTo !== null);

  const facts: [string, string][] = [
    ['Order', ref],
    ...(params.channelRef === null ? [] : [['Channel reference', plainText(params.channelRef)] as [string, string]]),
    ['Warehouse', warehouse],
    ['Dispatched', `${when} (IST)`],
    ...(params.carrierName === null ? [] : [['Carrier', plainText(params.carrierName)] as [string, string]]),
    ...(params.trackingNumber === null ? [] : [['Tracking number', plainText(params.trackingNumber)] as [string, string]]),
    ['Total units', plainText(params.totalUnits)],
  ];
  const rows = params.lines.map((line) => {
    const uom = plainText(line.uom);
    return [plainText(line.skuCode), plainText(line.skuName), `${line.ordered} ${uom}`, `${line.dispatched} ${uom}`, `${line.short} ${uom}`];
  });
  const more = moreLinesNote(params.moreLines);
  const opening = `${tenant} dispatched order ${ref} for ${client} from ${warehouse}.`;
  // Story 4-6a — one line when the brand's document was recorded; none on an older row.
  const documents = dispatchDocumentsLine(params);
  // Story 4-9a — one line for an order that left on a truck; none otherwise.
  const truck = dispatchFreightLine(params);
  // Story 4-5a — one sentence about the slip; none at all on a pre-4-5a row.
  const fileNote =
    attachment === 'attached'
      ? `The packing slip is attached (${plainText(packingSlipFileName(params.orderRef))}).`
      : attachment === 'too-large'
        ? DISPATCH_SLIP_TOO_LARGE
        : attachment === 'failed'
          ? DISPATCH_SLIP_FAILED
          : null;

  const text = [
    opening,
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    ...(documents === null ? [] : [documents]),
    ...(truck === null ? [] : [truck]),
    '',
    ...rows.map(([code, name, ordered, dispatched, short]) => `- ${code} ${name}: ordered ${ordered}, dispatched ${dispatched}, short ${short}`),
    ...(more === null ? [] : [more]),
    ...(params.shortShipped ? ['', DISPATCH_SHORT_NOTE] : []),
    '',
    ...(fileNote === null ? [] : [fileNote, '']),
    `If you have portal access, your orders are at ${portalUrl}`,
    '',
    footer,
    '',
  ].join('\n');

  const body = clientHtml(
    subject,
    [
      `<p>${html(opening)}</p>`,
      `<p>${facts.map(([label, value]) => `${html(label)}: <strong>${html(value)}</strong>`).join('<br>')}</p>`,
      ...(documents === null ? [] : [`<p>${html(documents)}</p>`]),
      ...(truck === null ? [] : [`<p>${html(truck)}</p>`]),
      htmlTable(['SKU', 'Name', 'Ordered', 'Dispatched', 'Short'], rows, new Set([2, 3, 4])),
      ...(more === null ? [] : [`<p>${html(more)}</p>`]),
      ...(params.shortShipped ? [`<p><strong>${html(DISPATCH_SHORT_NOTE)}</strong></p>`] : []),
      ...(fileNote === null ? [] : [`<p>${html(fileNote)}</p>`]),
      `<p>If you have portal access, <a href="${html(portalUrl)}">see your orders in the portal</a>.</p>`,
    ],
    footer,
  );

  return { subject, text, html: body, fromName: clientFromName(params.tenantName), replyTo };
}
