import { headerText, html, plainText } from './escape';
import { type RenderedEmail } from './invite';
import { asRecord, clientFooter, clientFromName, clientHtml, nullableText, textField } from './client-notice';

/**
 * Story 4-6a (A20) — the `client-documents-needed` notice: a packed order of
 * the client is waiting for the brand's tax document or e-way bill before it
 * can leave. One email per opted-in contact (`consignment.documents-needed`),
 * queued by the `client-emails` subscriber on `order.packed` only when the
 * gate read AT DELIVERY is blocking. What is STORED is exactly these params,
 * built key by key. No consignee, no address, no value of the brand's own.
 */
export const DOCUMENTS_NEEDED_KINDS = ['invoice', 'eway-bill'] as const;
export type DocumentsNeededKind = (typeof DOCUMENTS_NEEDED_KINDS)[number];

/** Why the documents are needed — the gate's reason, or the live record's e-way state. */
export const DOCUMENTS_NEEDED_REASONS = ['policy-b2b', 'policy-all', 'value', 'eway-pending', 'eway-expired'] as const;
export type DocumentsNeededReason = (typeof DOCUMENTS_NEEDED_REASONS)[number];

export interface ClientDocumentsNeededEmailParams {
  readonly tenantName: string;
  readonly clientName: string;
  readonly warehouseName: string;
  readonly orderId: string;
  /** The order's label (the one order label rule). */
  readonly orderRef: string;
  readonly needs: DocumentsNeededKind;
  readonly reason: DocumentsNeededReason;
  /** The threshold the reason cites, in words (`₹50,000`), or null. */
  readonly threshold: string | null;
  /** An expired bill's last valid day (`YYYY-MM-DD`), or null. */
  readonly ewayValidUntil: string | null;
  readonly replyTo: string | null;
}

const WHAT = 'client-documents-needed params';

function oneOf<T extends string>(value: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const field = value[key];
  if (typeof field !== 'string' || !(allowed as readonly string[]).includes(field)) throw new Error(`${WHAT}: ${key} is not one of ${allowed.join(', ')}`);
  return field as T;
}

export function decodeClientDocumentsNeededParams(raw: unknown): ClientDocumentsNeededEmailParams {
  const value = asRecord(raw, WHAT);
  return {
    tenantName: textField(value, 'tenantName', WHAT),
    clientName: textField(value, 'clientName', WHAT),
    warehouseName: textField(value, 'warehouseName', WHAT),
    orderId: textField(value, 'orderId', WHAT),
    orderRef: textField(value, 'orderRef', WHAT),
    needs: oneOf(value, 'needs', DOCUMENTS_NEEDED_KINDS),
    reason: oneOf(value, 'reason', DOCUMENTS_NEEDED_REASONS),
    threshold: nullableText(value, 'threshold', WHAT),
    ewayValidUntil: nullableText(value, 'ewayValidUntil', WHAT),
    replyTo: nullableText(value, 'replyTo', WHAT),
  };
}

/** `{client}: order {ref} is packed — {your invoice | your e-way bill} is needed before it can leave`. */
export function clientDocumentsNeededSubject(params: Pick<ClientDocumentsNeededEmailParams, 'clientName' | 'orderRef' | 'needs'>): string {
  const what = params.needs === 'invoice' ? 'your invoice' : 'your e-way bill';
  return headerText(`${plainText(params.clientName)}: order ${plainText(params.orderRef)} is packed — ${what} is needed before it can leave`);
}

function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] ?? '';
  return `${d} ${month} ${y}`;
}

/** The "why" sentence (A20): the rule, or the order's own value, or the record's e-way state. */
export function documentsNeededReasonText(params: Pick<ClientDocumentsNeededEmailParams, 'reason' | 'threshold' | 'ewayValidUntil'>): string {
  const threshold = params.threshold ?? 'the e-way threshold';
  switch (params.reason) {
    case 'policy-b2b':
      return 'Your account asks for the tax invoice (or delivery challan) of every B2B order before it leaves the warehouse.';
    case 'policy-all':
      return 'Your account asks for the tax invoice (or delivery challan) of every order before it leaves the warehouse.';
    case 'value':
      return `The order's own value is above ${threshold} — the e-way threshold — so it cannot travel without your tax document and e-way bill.`;
    case 'eway-pending':
      return `The value on your recorded document is above ${threshold} — the e-way threshold — and no e-way bill number is recorded yet.`;
    case 'eway-expired':
      return `The e-way bill recorded for it expired${params.ewayValidUntil === null ? '' : ` on ${longDate(params.ewayValidUntil)}`} — record its extension or a new bill.`;
  }
}

/**
 * Renders the reminder. `portalUrl` is `{WEB_BASE_URL}/portal/orders?order={id}&tab=documents`.
 */
export function renderClientDocumentsNeededEmail(params: ClientDocumentsNeededEmailParams, portalUrl: string, fallbackReplyTo: string | null): RenderedEmail {
  const tenant = plainText(params.tenantName);
  const client = plainText(params.clientName);
  const warehouse = plainText(params.warehouseName);
  const ref = plainText(params.orderRef);
  const subject = clientDocumentsNeededSubject(params);
  const replyTo = params.replyTo ?? fallbackReplyTo;
  const footer = clientFooter(tenant, client, replyTo !== null);
  const what =
    params.needs === 'invoice'
      ? `${tenant} has packed order ${ref} for ${client} at ${warehouse}. It is waiting for your tax invoice (or delivery challan) before it can leave.`
      : `${tenant} has packed order ${ref} for ${client} at ${warehouse}. It is waiting for your e-way bill before it can leave.`;
  const why = documentsNeededReasonText(params);
  const action =
    params.needs === 'invoice'
      ? 'Record the document number, its date and the declared value — and the e-way bill when one is needed — in the client portal; the order is released as soon as it is recorded.'
      : 'Record the e-way bill number, its date and its validity in the client portal; the order is released as soon as it is recorded.';

  const text = [what, '', why, '', action, '', `Open the order: ${portalUrl}`, '', footer, ''].join('\n');
  const body = clientHtml(
    subject,
    [`<p>${html(what)}</p>`, `<p>${html(why)}</p>`, `<p>${html(action)}</p>`, `<p><a href="${html(portalUrl)}">Open order ${html(ref)} in the portal</a>.</p>`],
    footer,
  );
  return { subject, text, html: body, fromName: clientFromName(params.tenantName), replyTo };
}
