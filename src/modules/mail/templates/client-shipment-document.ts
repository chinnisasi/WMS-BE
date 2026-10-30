import { headerText, html, plainText } from './escape';
import { istLongDateTime, type RenderedEmail } from './invite';
import type { ClientAttachmentState } from './client-receipt';
import { asRecord, clientFooter, clientFromName, clientHtml, countField, instantField, linesField, nullableText, textField } from './client-notice';

/**
 * Story 4-4a (A23, D4, D12) — the `client-shipment-document` notice: one
 * email per opted-in contact (`shipment.documents`) for each warehouse-
 * captured shipping document of an order (invoice, challan, e-way bill, POD,
 * other) and each signed handover-sheet page, the file attached at SEND time
 * (`stored-file`). What is STORED is exactly these params, built key by key
 * at enqueue (`OutboundFacade.shipmentDocumentEmailFactsInTx`).
 */

export const SHIPMENT_DOCUMENT_KINDS = ['invoice', 'challan', 'eway-bill', 'pod', 'other', 'handover-sheet', 'lr'] as const;
export type ShipmentDocumentKind = (typeof SHIPMENT_DOCUMENT_KINDS)[number];

/** The document words the subject and body use. */
export const SHIPMENT_DOCUMENT_WORD: Readonly<Record<ShipmentDocumentKind, string>> = {
  invoice: 'Invoice',
  challan: 'Delivery challan',
  'eway-bill': 'E-way bill',
  pod: 'Proof of delivery',
  other: 'Document',
  'handover-sheet': 'Signed handover sheet',
  // Story 4-9a — a scanned lorry receipt.
  lr: 'Lorry receipt',
};

/** A sheet's parcel list is shown up to this many; the rest is "…and N more". */
export const SHEET_PARCELS_SHOWN = 100;

export interface ClientShipmentDocumentParcelParams {
  readonly orderRef: string;
  readonly awb: string;
}

export interface ClientShipmentDocumentEmailParams {
  readonly tenantName: string;
  readonly clientName: string;
  readonly replyTo: string | null;
  readonly documentKind: ShipmentDocumentKind;
  /** The log's subject label: the order label, or `HO-0007 (page 2)`. */
  readonly subjectLabel: string;
  readonly orderId: string | null;
  readonly orderRef: string | null;
  readonly handoverCode: string | null;
  readonly handedOverAt: string | null;
  readonly courierName: string | null;
  readonly awb: string | null;
  readonly fileName: string;
  /** D12 — 1-based, a sheet page only. */
  readonly page: number | null;
  readonly parcels: readonly ClientShipmentDocumentParcelParams[];
  readonly moreParcels: number;
}

const WHAT = 'client-shipment-document params';

export function decodeClientShipmentDocumentParams(raw: unknown): ClientShipmentDocumentEmailParams {
  const value = asRecord(raw, WHAT);
  const kind = value.documentKind;
  if (typeof kind !== 'string' || !(SHIPMENT_DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`${WHAT}: documentKind is not a known kind`);
  }
  const page = value.page;
  if (page !== null && (typeof page !== 'number' || !Number.isInteger(page) || page < 1)) throw new Error(`${WHAT}: page is not a page number`);
  return {
    tenantName: textField(value, 'tenantName', WHAT),
    clientName: textField(value, 'clientName', WHAT),
    replyTo: nullableText(value, 'replyTo', WHAT),
    documentKind: kind as ShipmentDocumentKind,
    subjectLabel: textField(value, 'subjectLabel', WHAT),
    orderId: nullableText(value, 'orderId', WHAT),
    orderRef: nullableText(value, 'orderRef', WHAT),
    handoverCode: nullableText(value, 'handoverCode', WHAT),
    handedOverAt: value.handedOverAt === null ? null : instantField(value, 'handedOverAt', WHAT),
    courierName: nullableText(value, 'courierName', WHAT),
    awb: nullableText(value, 'awb', WHAT),
    fileName: textField(value, 'fileName', WHAT),
    page: page as number | null,
    parcels: linesField(value, 'parcels', WHAT, (line) => ({ orderRef: textField(line, 'orderRef', WHAT), awb: textField(line, 'awb', WHAT) })),
    moreParcels: countField(value, 'moreParcels', WHAT),
  };
}

/** `{client}: {Document} for order {ref}` / `{client}: signed handover sheet {HO} (page n)`. */
export function clientShipmentDocumentSubject(params: Pick<ClientShipmentDocumentEmailParams, 'clientName' | 'documentKind' | 'orderRef' | 'handoverCode' | 'page'>): string {
  const client = plainText(params.clientName);
  if (params.documentKind === 'handover-sheet') {
    return headerText(`${client}: signed handover sheet ${plainText(params.handoverCode ?? '')}${params.page === null ? '' : ` (page ${params.page})`}`);
  }
  return headerText(`${client}: ${SHIPMENT_DOCUMENT_WORD[params.documentKind]} for order ${plainText(params.orderRef ?? '')}`);
}

/** The attachment sentence (D4): `failed` and `too-large` send the email without the file and say where to find it. */
export function shipmentDocumentAttachmentNote(state: ClientAttachmentState, fileName: string): string | null {
  switch (state) {
    case 'attached':
      return `The file is attached (${plainText(fileName)}).`;
    case 'too-large':
      return `The file (${plainText(fileName)}) is too large to attach — download it from the client portal.`;
    case 'failed':
      return `The file (${plainText(fileName)}) could not be attached — download it from the client portal.`;
    case 'none':
      return null;
  }
}

/** Renders the notice. `portalUrl` is `{WEB_BASE_URL}/portal/orders?order={id}` (or the list for a sheet). */
export function renderClientShipmentDocumentEmail(
  params: ClientShipmentDocumentEmailParams,
  portalUrl: string,
  fallbackReplyTo: string | null,
  attachment: ClientAttachmentState = 'none',
): RenderedEmail {
  const tenant = plainText(params.tenantName);
  const client = plainText(params.clientName);
  const word = SHIPMENT_DOCUMENT_WORD[params.documentKind];
  const subject = clientShipmentDocumentSubject(params);
  const replyTo = params.replyTo ?? fallbackReplyTo;
  const footer = clientFooter(tenant, client, replyTo !== null);
  const sheet = params.documentKind === 'handover-sheet';
  const opening = sheet
    ? `${tenant} handed your parcels to ${plainText(params.courierName ?? 'the courier')} — here is the signed handover sheet ${plainText(params.handoverCode ?? '')}${params.page === null ? '' : `, page ${params.page}`}.`
    : `${tenant} shares the ${word.toLowerCase()} of order ${plainText(params.orderRef ?? '')} for ${client}.`;
  const facts: [string, string][] = [
    ...(params.orderRef === null ? [] : [['Order', plainText(params.orderRef)] as [string, string]]),
    ...(params.courierName === null ? [] : [['Courier', plainText(params.courierName)] as [string, string]]),
    ...(params.awb === null ? [] : [['AWB', plainText(params.awb)] as [string, string]]),
    ...(params.handoverCode === null ? [] : [['Handover', plainText(params.handoverCode)] as [string, string]]),
    ...(params.handedOverAt === null ? [] : [['Handed over', `${istLongDateTime(params.handedOverAt)} (IST)`] as [string, string]]),
    ['File', plainText(params.fileName)],
  ];
  const note = shipmentDocumentAttachmentNote(attachment, params.fileName);
  const parcelRows = params.parcels.map((parcel) => [plainText(parcel.orderRef), plainText(parcel.awb)]);
  const more = params.moreParcels > 0 ? `…and ${params.moreParcels} more` : null;
  const text = [
    opening,
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    ...(note === null ? [] : ['', note]),
    ...(sheet && parcelRows.length > 0 ? ['', 'Parcels:', ...parcelRows.map(([order, awb]) => `- ${order}: AWB ${awb}`), ...(more === null ? [] : [more])] : []),
    '',
    `If you have portal access, the order's shipping is at ${portalUrl}`,
    '',
    footer,
    '',
  ].join('\n');
  const body = clientHtml(
    subject,
    [
      `<p>${html(opening)}</p>`,
      `<p>${facts.map(([label, value]) => `${html(label)}: <strong>${html(value)}</strong>`).join('<br>')}</p>`,
      ...(note === null ? [] : [`<p>${html(note)}</p>`]),
      ...(sheet && parcelRows.length > 0
        ? [
            `<table cellpadding="4" cellspacing="0" border="1"><tr><th>Order</th><th>AWB</th></tr>${parcelRows
              .map(([order, awb]) => `<tr><td>${html(order!)}</td><td>${html(awb!)}</td></tr>`)
              .join('')}</table>`,
            ...(more === null ? [] : [`<p>${html(more)}</p>`]),
          ]
        : []),
      `<p>If you have portal access, <a href="${html(portalUrl)}">see the order's shipping in the portal</a>.</p>`,
    ],
    footer,
  );
  return { subject, text, html: body, fromName: clientFromName(params.tenantName), replyTo };
}
