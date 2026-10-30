import { SHEET_PARCELS_SHOWN } from './client-shipment-document';
import { renderEmail } from './index';
import { decodeClientReceiptParams, type ClientReceiptEmailParams } from './client-receipt';
import { createHash } from 'node:crypto';
import { DISPATCH_SLIP_FAILED, DISPATCH_SLIP_TOO_LARGE, decodeClientDispatchParams, packingSlipFileName, renderClientDispatchEmail, type ClientDispatchEmailParams } from './client-dispatch';
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
  it('the vocabulary: six templates (story 4-4a added the shipping document), the three client ones at priority 1, account mail at 0', () => {
    expect([...EMAIL_TEMPLATES]).toEqual(['user-invite', 'password-reset', 'password-changed', 'client-receipt', 'client-dispatch', 'client-shipment-document']);
    expect([...CLIENT_EMAIL_TEMPLATES]).toEqual(['client-receipt', 'client-dispatch', 'client-shipment-document']);
    expect(EMAIL_TEMPLATE_PRIORITY).toEqual({
      'user-invite': 0,
      'password-reset': 0,
      'password-changed': 0,
      'client-receipt': 1,
      'client-dispatch': 1,
      'client-shipment-document': 1,
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

  it('story 4-5a (A20, A49): the none arm is 5-2b\'s bytes exactly (golden computed on the pre-4-5a renderer); attached / too-large / failed each say one sentence', () => {
    const portal = 'https://app.wms.test/portal/orders';
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(hash(renderClientDispatchEmail(dispatch, portal, null))).toBe('ca2bc6872ae56fd8618c8f6061c7fe50ae9f738facd6f2167a02289d3091f1be');
    expect(hash(renderEmail('client-dispatch', dispatch, context))).toBe(hash(renderClientDispatchEmail(dispatch, portal, null, 'none')));
    const attached = renderEmail('client-dispatch', dispatch, { ...context, attachment: 'attached' });
    expect(attached.text).toContain('The packing slip is attached (PO-77-packing-slip.pdf).');
    expect(attached.html).toContain('The packing slip is attached (PO-77-packing-slip.pdf).');
    expect(renderEmail('client-dispatch', dispatch, { ...context, attachment: 'too-large' }).text).toContain(DISPATCH_SLIP_TOO_LARGE);
    expect(DISPATCH_SLIP_TOO_LARGE).toBe('The packing slip is too large to attach — download it from the client portal.');
    expect(renderEmail('client-dispatch', dispatch, { ...context, attachment: 'failed' }).text).toContain(DISPATCH_SLIP_FAILED);
    expect(renderEmail('client-dispatch', dispatch, context).text).not.toContain('packing slip');
    expect(packingSlipFileName('PO/77 #2')).toBe('PO_77__2-packing-slip.pdf');
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

  describe('story 4-4a — the shipping-document notice', () => {
    const base = {
      tenantName: 'Acme 3PL',
      clientName: 'ACME Brand',
      replyTo: null,
      documentKind: 'pod' as const,
      subjectLabel: 'SO-1',
      orderId: '01a18ba8-4743-79dd-8fe5-145b99902272',
      orderRef: 'SO-1',
      handoverCode: 'HO-0007',
      handedOverAt: '2026-10-30T10:35:00.000Z',
      courierName: 'Delhivery',
      awb: '123456789012',
      fileName: 'SO-1-pod-1.jpg',
      page: null,
      parcels: [],
      moreParcels: 0,
    };
    it('the subject, and the failed and too-large notes name the file', () => {
      const failed = renderEmail('client-shipment-document', base, { ...context, attachment: 'failed' });
      expect(failed.subject).toBe('ACME Brand: Proof of delivery for order SO-1');
      expect(failed.text).toContain('The file (SO-1-pod-1.jpg) could not be attached — download it from the client portal.');
      const large = renderEmail('client-shipment-document', base, { ...context, attachment: 'too-large' });
      expect(large.text).toContain('The file (SO-1-pod-1.jpg) is too large to attach — download it from the client portal.');
      expect(renderEmail('client-shipment-document', base, { ...context, attachment: 'attached' }).text).toContain('The file is attached (SO-1-pod-1.jpg).');
    });
    it('a sheet over SHEET_PARCELS_SHOWN lists the first ones and says "…and N more"', () => {
      const parcels = Array.from({ length: SHEET_PARCELS_SHOWN }, (_, i) => ({ orderRef: `SO-${i}`, awb: `AWB${i}` }));
      const sheet = renderEmail(
        'client-shipment-document',
        { ...base, documentKind: 'handover-sheet', subjectLabel: 'HO-0007 (page 2)', orderId: null, orderRef: null, awb: null, fileName: 'HO-0007-sheet-2.pdf', page: 2, parcels, moreParcels: 3 },
        context,
      );
      expect(sheet.subject).toBe('ACME Brand: signed handover sheet HO-0007 (page 2)');
      expect(sheet.text).toContain('- SO-0: AWB AWB0');
      expect(sheet.text).toContain('…and 3 more');
    });
  });
});
