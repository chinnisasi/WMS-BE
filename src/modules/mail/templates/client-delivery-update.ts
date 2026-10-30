import { DELIVERY_OUTCOMES, type DeliveryOutcome } from '../../../shared/primitives/freight';
import { headerText, html, plainText } from './escape';
import { istLongDateTime, type RenderedEmail } from './invite';
import { asRecord, clientFooter, clientFromName, clientHtml, instantField, nullableText, textField } from './client-notice';

/**
 * Story 4-9a (A27) — the `client-delivery-update` notice: a truck consignment
 * of the client's order was delivered, delivered with exceptions, or refused
 * by the consignee (or that record was amended). One email per opted-in
 * contact (`delivery.recorded`), queued by the `client-emails` subscriber on
 * `freight_consignment.delivered`. What is STORED is exactly these params,
 * built key by key from the frozen outbox payload (5-2b A1). No driver phone,
 * no consignee name or address — only the city. The POD file reaches the
 * contact through 4-4a's document email, never this one (no attachment).
 */
/** The delivery outcomes (`DELIVERY_OUTCOMES`, shared/primitives/freight.ts — one vocabulary). */
export const DELIVERY_UPDATE_OUTCOMES = DELIVERY_OUTCOMES;
export type DeliveryUpdateOutcome = DeliveryOutcome;

export interface ClientDeliveryUpdateEmailParams {
  readonly tenantName: string;
  readonly clientName: string;
  readonly orderId: string;
  /** The order's label (the one order label rule). */
  readonly orderRef: string;
  /** The consignee's city, or null when the order carries none. */
  readonly consigneeCity: string | null;
  /** `LD-0007/03`. */
  readonly consignmentRef: string;
  readonly outcome: DeliveryUpdateOutcome;
  readonly deliveredAt: string;
  readonly receiverName: string | null;
  readonly shortPackageCount: number | null;
  readonly damagedPackageCount: number | null;
  readonly note: string | null;
  readonly transporterName: string;
  readonly lrNumber: string | null;
  readonly vehicleNumber: string | null;
  /** A second or later record of the same consignment (an office amendment). */
  readonly amended: boolean;
  readonly replyTo: string | null;
}

const WHAT = 'client-delivery-update params';

function nullableCount(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) throw new Error(`${WHAT}: ${key} is not a count or null`);
  return field;
}

export function decodeClientDeliveryUpdateParams(raw: unknown): ClientDeliveryUpdateEmailParams {
  const value = asRecord(raw, WHAT);
  const outcome = value.outcome;
  if (typeof outcome !== 'string' || !(DELIVERY_UPDATE_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error(`${WHAT}: outcome is not one of ${DELIVERY_UPDATE_OUTCOMES.join(', ')}`);
  }
  if (typeof value.amended !== 'boolean') throw new Error(`${WHAT}: amended is not a boolean`);
  return {
    tenantName: textField(value, 'tenantName', WHAT),
    clientName: textField(value, 'clientName', WHAT),
    orderId: textField(value, 'orderId', WHAT),
    orderRef: textField(value, 'orderRef', WHAT),
    consigneeCity: nullableText(value, 'consigneeCity', WHAT),
    consignmentRef: textField(value, 'consignmentRef', WHAT),
    outcome: outcome as DeliveryUpdateOutcome,
    deliveredAt: instantField(value, 'deliveredAt', WHAT),
    receiverName: nullableText(value, 'receiverName', WHAT),
    shortPackageCount: nullableCount(value, 'shortPackageCount'),
    damagedPackageCount: nullableCount(value, 'damagedPackageCount'),
    note: nullableText(value, 'note', WHAT),
    transporterName: textField(value, 'transporterName', WHAT),
    lrNumber: nullableText(value, 'lrNumber', WHAT),
    vehicleNumber: nullableText(value, 'vehicleNumber', WHAT),
    amended: value.amended,
    replyTo: nullableText(value, 'replyTo', WHAT),
  };
}

const OUTCOME_WORDS: Record<DeliveryUpdateOutcome, string> = {
  delivered: 'delivered',
  'delivered-with-exceptions': 'delivered with exceptions',
  refused: 'refused by the consignee',
};

/** `{client}: order {ref} delivered` / `delivered with exceptions` / `refused by the consignee`; "Updated: " first when amended. */
export function clientDeliveryUpdateSubject(params: Pick<ClientDeliveryUpdateEmailParams, 'clientName' | 'orderRef' | 'outcome' | 'amended'>): string {
  return headerText(`${params.amended ? 'Updated: ' : ''}${plainText(params.clientName)}: order ${plainText(params.orderRef)} ${OUTCOME_WORDS[params.outcome]}`);
}

function packages(n: number): string {
  return `${n} ${n === 1 ? 'package' : 'packages'}`;
}

/** "1 package short, 2 packages damaged", or null when neither count is above zero. */
export function deliveryExceptionsText(params: Pick<ClientDeliveryUpdateEmailParams, 'shortPackageCount' | 'damagedPackageCount'>): string | null {
  const parts: string[] = [];
  if ((params.shortPackageCount ?? 0) > 0) parts.push(`${packages(params.shortPackageCount!)} short`);
  if ((params.damagedPackageCount ?? 0) > 0) parts.push(`${packages(params.damagedPackageCount!)} damaged`);
  return parts.length === 0 ? null : parts.join(', ');
}

/** Renders the delivery update. `portalUrl` is `{WEB_BASE_URL}/portal/orders?order={id}`. */
export function renderClientDeliveryUpdateEmail(params: ClientDeliveryUpdateEmailParams, portalUrl: string, fallbackReplyTo: string | null): RenderedEmail {
  const tenant = plainText(params.tenantName);
  const client = plainText(params.clientName);
  const ref = plainText(params.orderRef);
  const subject = clientDeliveryUpdateSubject(params);
  const replyTo = params.replyTo ?? fallbackReplyTo;
  const footer = clientFooter(tenant, client, replyTo !== null);
  const city = params.consigneeCity === null ? null : plainText(params.consigneeCity);
  const where = city === null ? '' : ` in ${city}`;
  const opening =
    params.outcome === 'refused'
      ? `The consignee${where} refused order ${ref} for ${client}, carried by ${plainText(params.transporterName)}.`
      : `Order ${ref} for ${client} was ${OUTCOME_WORDS[params.outcome]}${where}, carried by ${plainText(params.transporterName)}.`;
  const amendedNote = params.amended ? `${tenant} has updated the delivery record of this consignment; this replaces the earlier notice.` : null;
  const exceptions = deliveryExceptionsText(params);
  const facts: [string, string][] = [
    ['Order', ref],
    ...(city === null ? [] : [['Consignee city', city] as [string, string]]),
    ['Freight note', plainText(params.consignmentRef)],
    ['Transporter', plainText(params.transporterName)],
    ...(params.lrNumber === null ? [] : [['LR number', plainText(params.lrNumber)] as [string, string]]),
    ...(params.vehicleNumber === null ? [] : [['Vehicle', plainText(params.vehicleNumber)] as [string, string]]),
    [params.outcome === 'refused' ? 'Refused' : 'Delivered', `${istLongDateTime(params.deliveredAt)} (IST)`],
    ...(params.receiverName === null ? [] : [['Received by', plainText(params.receiverName)] as [string, string]]),
    ...(exceptions === null ? [] : [['Exceptions', exceptions] as [string, string]]),
    ...(params.note === null ? [] : [['Remarks', plainText(params.note)] as [string, string]]),
  ];

  const text = [
    opening,
    ...(amendedNote === null ? [] : ['', amendedNote]),
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    '',
    `If you have portal access, the order is at ${portalUrl}`,
    '',
    footer,
    '',
  ].join('\n');
  const body = clientHtml(
    subject,
    [
      `<p>${html(opening)}</p>`,
      ...(amendedNote === null ? [] : [`<p>${html(amendedNote)}</p>`]),
      `<p>${facts.map(([label, value]) => `${html(label)}: <strong>${html(value)}</strong>`).join('<br>')}</p>`,
      `<p>If you have portal access, <a href="${html(portalUrl)}">open order ${html(ref)} in the portal</a>.</p>`,
    ],
    footer,
  );
  return { subject, text, html: body, fromName: clientFromName(params.tenantName), replyTo };
}
