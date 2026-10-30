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
  };
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
