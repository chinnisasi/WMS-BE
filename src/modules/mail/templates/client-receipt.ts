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

/**
 * Story 5-2b — the `client-receipt` notice: one email per opted-in contact of
 * the client a GRN was recorded for. What is STORED (`email_messages.params`)
 * is exactly `ClientReceiptEmailParams`, built key by key by the
 * `client-emails` subscriber from the frozen outbox payload (labels — the
 * names and codes — read at enqueue). Quantities are decimal strings at the
 * SKU UoM's precision, from milli-units — never a float.
 */
export interface ClientReceiptLineParams {
  readonly skuCode: string;
  readonly skuName: string;
  readonly uom: string;
  readonly batchCode: string | null;
  /** The good units booked (the line's `qty`). */
  readonly received: string;
  readonly damaged: string;
  readonly short: string;
}

export interface ClientReceiptEmailParams {
  readonly tenantName: string;
  readonly clientName: string;
  readonly warehouseName: string;
  readonly grnCode: string;
  readonly poCode: string | null;
  readonly asnCode: string | null;
  /** When the receipt was recorded (ISO instant) — shown in IST. */
  readonly recordedAt: string;
  /** The client's own Reply-To (`clients.email_reply_to`), frozen at enqueue; null → the deployment's. */
  readonly replyTo: string | null;
  /** At most `CLIENT_EMAIL_MAX_LINES`. */
  readonly lines: readonly ClientReceiptLineParams[];
  /** Lines beyond the shown ones. */
  readonly moreLines: number;
  /** Over EVERY line (not only the shown ones), per UoM: `"16.500 kg, 4 pcs"`. */
  readonly totals: { readonly received: string; readonly damaged: string; readonly short: string };
  /** How many lines were placed on a QC hold (the snapshot's `qcHeldLines`; 0 when absent). */
  readonly qcHeldLines: number;
}

const WHAT = 'client-receipt params';

export function decodeClientReceiptParams(raw: unknown): ClientReceiptEmailParams {
  const value = asRecord(raw, WHAT);
  const totals = asRecord(value.totals, `${WHAT} totals`);
  return {
    tenantName: textField(value, 'tenantName', WHAT),
    clientName: textField(value, 'clientName', WHAT),
    warehouseName: textField(value, 'warehouseName', WHAT),
    grnCode: textField(value, 'grnCode', WHAT),
    poCode: nullableText(value, 'poCode', WHAT),
    asnCode: nullableText(value, 'asnCode', WHAT),
    recordedAt: instantField(value, 'recordedAt', WHAT),
    replyTo: nullableText(value, 'replyTo', WHAT),
    lines: linesField(value, 'lines', WHAT, (line) => ({
      skuCode: textField(line, 'skuCode', WHAT),
      skuName: textField(line, 'skuName', WHAT),
      uom: textField(line, 'uom', WHAT),
      batchCode: nullableText(line, 'batchCode', WHAT),
      received: quantityField(line, 'received', WHAT),
      damaged: quantityField(line, 'damaged', WHAT),
      short: quantityField(line, 'short', WHAT),
    })),
    moreLines: countField(value, 'moreLines', WHAT),
    totals: {
      received: textField(totals, 'received', WHAT),
      damaged: textField(totals, 'damaged', WHAT),
      short: textField(totals, 'short', WHAT),
    },
    qcHeldLines: countField(value, 'qcHeldLines', WHAT),
  };
}

export const RECEIPT_DISCREPANCY_NOTE =
  'Damaged and short units are as counted at the dock; the warehouse will contact you about any discrepancy.';

/**
 * Renders the receipt notice. `portalUrl` is `{WEB_BASE_URL}/portal/inbound`;
 * `fallbackReplyTo` is the deployment's `EMAIL_REPLY_TO` (the footer reads
 * "reply to this email" only when SOME Reply-To exists — A10).
 */
export function renderClientReceiptEmail(params: ClientReceiptEmailParams, portalUrl: string, fallbackReplyTo: string | null): RenderedEmail {
  const tenant = plainText(params.tenantName);
  const client = plainText(params.clientName);
  const warehouse = plainText(params.warehouseName);
  const grn = plainText(params.grnCode);
  const when = istLongDateTime(params.recordedAt);
  const subject = headerText(`${client}: goods received at ${warehouse} — ${grn}`);
  const replyTo = params.replyTo ?? fallbackReplyTo;
  const footer = clientFooter(tenant, client, replyTo !== null);

  const facts: [string, string][] = [
    ['GRN', grn],
    ...(params.poCode === null ? [] : [['Purchase order', plainText(params.poCode)] as [string, string]]),
    ...(params.asnCode === null ? [] : [['Shipment notice (ASN)', plainText(params.asnCode)] as [string, string]]),
    ['Warehouse', warehouse],
    ['Received', `${when} (IST)`],
  ];
  const rows = params.lines.map((line) => [
    plainText(line.skuCode),
    plainText(line.skuName),
    line.batchCode === null ? '—' : plainText(line.batchCode),
    `${line.received} ${plainText(line.uom)}`,
    `${line.damaged} ${plainText(line.uom)}`,
    `${line.short} ${plainText(line.uom)}`,
  ]);
  const more = moreLinesNote(params.moreLines);
  const totals = `Totals — received: ${plainText(params.totals.received)}; damaged: ${plainText(params.totals.damaged)}; short: ${plainText(params.totals.short)}.`;
  const qc =
    params.qcHeldLines === 0
      ? null
      : `${params.qcHeldLines} ${params.qcHeldLines === 1 ? 'line is' : 'lines are'} held for quality check.`;
  const opening = `${tenant} received goods for ${client} at ${warehouse}.`;
  const portal = `If you have portal access, your receipts are at ${portalUrl}`;

  const text = [
    opening,
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    '',
    ...params.lines.map((line, index) => {
      const [code, name, , received, damaged, short] = rows[index]!;
      const batch = line.batchCode === null ? '' : ` (batch ${plainText(line.batchCode)})`;
      return `- ${code} ${name}${batch}: received ${received}, damaged ${damaged}, short ${short}`;
    }),
    ...(more === null ? [] : [more]),
    '',
    totals,
    ...(qc === null ? [] : [qc]),
    '',
    RECEIPT_DISCREPANCY_NOTE,
    '',
    portal,
    '',
    footer,
    '',
  ].join('\n');

  const body = clientHtml(
    subject,
    [
      `<p>${html(opening)}</p>`,
      `<p>${facts.map(([label, value]) => `${html(label)}: <strong>${html(value)}</strong>`).join('<br>')}</p>`,
      htmlTable(['SKU', 'Name', 'Batch', 'Received', 'Damaged', 'Short'], rows, new Set([3, 4, 5])),
      ...(more === null ? [] : [`<p>${html(more)}</p>`]),
      `<p>${html(totals)}${qc === null ? '' : `<br>${html(qc)}`}</p>`,
      `<p>${html(RECEIPT_DISCREPANCY_NOTE)}</p>`,
      `<p>If you have portal access, <a href="${html(portalUrl)}">see your receipts in the portal</a>.</p>`,
    ],
    footer,
  );

  return { subject, text, html: body, fromName: clientFromName(params.tenantName), replyTo };
}
