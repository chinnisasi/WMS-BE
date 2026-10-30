import { renderEmail } from './index';
import { decodeClientReceiptParams, type ClientReceiptEmailParams } from './client-receipt';
import { decodeClientDispatchParams, type ClientDispatchEmailParams } from './client-dispatch';
import { EMAIL_TEMPLATES, EMAIL_TEMPLATE_PRIORITY, CLIENT_EMAIL_TEMPLATES } from '../mail-rules';

/**
 * Story 5-2b — the two client notices: the subjects (pinned literally), the
 * bodies' facts, the 100-line tail, the footer's two forms (A10), escaping
 * and header injection, and the stored-params decoders refusing a shape the
 * builder never writes.
 */
const receipt: ClientReceiptEmailParams = {
  tenantName: 'Acme 3PL',
  clientName: 'ACME Brand',
  warehouseName: 'Main',
  grnCode: 'GRN-0007',
  poCode: 'PO-77',
  asnCode: null,
  recordedAt: '2026-10-30T08:35:00.000Z',
  replyTo: 'ops@3pl.example.in',
  lines: [
    { skuCode: 'RICE-25', skuName: 'Basmati rice', uom: 'kg', batchCode: 'B-1', received: '12.500', damaged: '0.000', short: '0.000' },
    { skuCode: 'TEE-M', skuName: 'Tee, medium', uom: 'pcs', batchCode: null, received: '4', damaged: '1', short: '2' },
  ],
  moreLines: 0,
  totals: { received: '12.500 kg, 4 pcs', damaged: '0.000 kg, 1 pcs', short: '0.000 kg, 2 pcs' },
  qcHeldLines: 1,
};

const dispatch: ClientDispatchEmailParams = {
  tenantName: 'Acme 3PL',
  clientName: 'ACME Brand',
  warehouseName: 'Main',
  orderRef: 'PO-77',
  channelRef: '#1042',
  dispatchedAt: '2026-10-30T09:00:00.000Z',
  carrierName: 'Delhivery',
  trackingNumber: 'DL123',
  totalUnits: '12.250 kg',
  replyTo: null,
  lines: [{ skuCode: 'RICE-25', skuName: 'Basmati rice', uom: 'kg', ordered: '12.500', dispatched: '12.250', short: '0.250' }],
  moreLines: 0,
  shortShipped: true,
};

const context = { tenantId: 't', to: 'a@acme.example', webBaseUrl: 'https://app.wms.test', secret: null };

describe('client notices (story 5-2b)', () => {
  it('the vocabulary: five templates, the two client ones at priority 1, account mail at 0', () => {
    expect([...EMAIL_TEMPLATES]).toEqual(['user-invite', 'password-reset', 'password-changed', 'client-receipt', 'client-dispatch']);
    expect([...CLIENT_EMAIL_TEMPLATES]).toEqual(['client-receipt', 'client-dispatch']);
    expect(EMAIL_TEMPLATE_PRIORITY).toEqual({
      'user-invite': 0,
      'password-reset': 0,
      'password-changed': 0,
      'client-receipt': 1,
      'client-dispatch': 1,
    });
  });

  it('the receipt: subject, From, the client Reply-To, the facts in IST, every line, totals, QC count, the dock note, the portal link, the reply footer', () => {
    const mail = renderEmail('client-receipt', receipt, context);
    expect(mail.subject).toBe('ACME Brand: goods received at Main — GRN-0007');
    expect(mail.fromName).toBe('Acme 3PL via WMS');
    expect(mail.replyTo).toBe('ops@3pl.example.in');
    expect(mail.text).toContain('GRN: GRN-0007');
    expect(mail.text).toContain('Purchase order: PO-77');
    expect(mail.text).not.toContain('ASN');
    expect(mail.text).toContain('Received: 30 October 2026, 14:05 (IST)');
    expect(mail.text).toContain('- RICE-25 Basmati rice (batch B-1): received 12.500 kg, damaged 0.000 kg, short 0.000 kg');
    expect(mail.text).toContain('- TEE-M Tee, medium: received 4 pcs, damaged 1 pcs, short 2 pcs');
    expect(mail.text).toContain('Totals — received: 12.500 kg, 4 pcs; damaged: 0.000 kg, 1 pcs; short: 0.000 kg, 2 pcs.');
    expect(mail.text).toContain('1 line is held for quality check.');
    expect(mail.text).toContain('Damaged and short units are as counted at the dock; the warehouse will contact you about any discrepancy.');
    expect(mail.text).toContain('https://app.wms.test/portal/inbound');
    expect(mail.text).toContain(
      'You receive this because Acme 3PL lists you as a contact for ACME Brand. To stop these emails, reply to this email or ask Acme 3PL.',
    );
    expect(mail.html).toContain('href="https://app.wms.test/portal/inbound"');
  });

  it('the dispatch: subject with carrier and tracking, the channel ref, short-shipped, no Reply-To → the "ask to remove you" footer', () => {
    const mail = renderEmail('client-dispatch', dispatch, context);
    expect(mail.subject).toBe('ACME Brand: order PO-77 dispatched — Delhivery DL123');
    expect(mail.replyTo).toBeNull();
    expect(mail.text).toContain('Channel reference: #1042');
    expect(mail.text).toContain('Dispatched: 30 October 2026, 14:30 (IST)');
    expect(mail.text).toContain('Total units: 12.250 kg');
    expect(mail.text).toContain('- RICE-25 Basmati rice: ordered 12.500 kg, dispatched 12.250 kg, short 0.250 kg');
    expect(mail.text).toContain('Short-shipped');
    expect(mail.text).toContain('https://app.wms.test/portal/orders');
    expect(mail.text).toContain('To stop these emails, ask Acme 3PL to remove you.');
    expect(mail.text).not.toContain('reply to this email');
  });

  it('the deployment Reply-To (EMAIL_REPLY_TO) is enough for the reply footer; the subject without carrier or tracking ends at "dispatched"', () => {
    const mail = renderEmail('client-dispatch', { ...dispatch, carrierName: null, trackingNumber: null, shortShipped: false }, { ...context, fallbackReplyTo: 'help@3pl.example.in' });
    expect(mail.subject).toBe('ACME Brand: order PO-77 dispatched');
    expect(mail.replyTo).toBe('help@3pl.example.in');
    expect(mail.text).toContain('reply to this email or ask Acme 3PL');
    expect(mail.text).not.toContain('Short-shipped');
    expect(renderEmail('client-dispatch', { ...dispatch, carrierName: null }, context).subject).toBe('ACME Brand: order PO-77 dispatched — DL123');
  });

  it('…and N more lines', () => {
    expect(renderEmail('client-receipt', { ...receipt, moreLines: 3 }, context).text).toContain('…and 3 more lines');
    expect(renderEmail('client-dispatch', { ...dispatch, moreLines: 1 }, context).text).toContain('…and 1 more line');
  });

  it('template injection: a client name with markup and CR/LF is escaped in the HTML and flattened in the subject', () => {
    const hostile = { ...receipt, clientName: '<b>x</b>\r\nBcc: evil@x.in', lines: [{ ...receipt.lines[0]!, skuName: '<script>alert(1)</script>' }] };
    const mail = renderEmail('client-receipt', hostile, context);
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toBe('<b>x</b> Bcc: evil@x.in: goods received at Main — GRN-0007');
    expect(mail.html).not.toContain('<b>x</b>');
    expect(mail.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.fromName).not.toMatch(/[\r\n]/);
  });

  it('the decoders refuse what the builder never writes (a float quantity, a missing key, more than 100 lines)', () => {
    expect(decodeClientReceiptParams(receipt)).toEqual(receipt);
    expect(decodeClientDispatchParams(dispatch)).toEqual(dispatch);
    expect(() => decodeClientReceiptParams({ ...receipt, lines: [{ ...receipt.lines[0]!, received: 12.5 }] })).toThrow();
    expect(() => decodeClientReceiptParams({ ...receipt, grnCode: undefined })).toThrow();
    expect(() => decodeClientDispatchParams({ ...dispatch, shortShipped: 'yes' })).toThrow();
    expect(() => decodeClientDispatchParams({ ...dispatch, lines: Array.from({ length: 101 }, () => dispatch.lines[0]) })).toThrow();
    expect(() => renderEmail('client-receipt', { nonsense: true }, context)).toThrow();
  });
});
