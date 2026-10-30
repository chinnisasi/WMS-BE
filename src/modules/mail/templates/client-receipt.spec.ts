import { createHash } from 'node:crypto';
import { renderEmail } from './index';
import { decodeClientReceiptParams, RECEIPT_ATTACHMENT_FAILED, RECEIPT_ATTACHMENT_TOO_LARGE, type ClientReceiptEmailParams } from './client-receipt';

/**
 * Story 2-9a (D5) — the receipt notice's four attachment arms. `none` (a row
 * with no attachment, no `grnId`) renders 5-2b's bytes EXACTLY: the hash
 * below is of 5-2b's own template output for this fixture (computed from the
 * 5-2b source before this story changed the file).
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
const GRN_ID = '0192f5a0-0000-7000-8000-000000000042';
const context = { tenantId: 't', to: 'a@acme.example', webBaseUrl: 'https://app.wms.test', secret: null };
const FIVE_TWO_B_GOLDEN = '38e61fb9f9fa351924bcbd08263b233e85de2c72b7fdd8e927acf497b558aa69';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('the receipt notice and its GRN attachment (story 2-9a)', () => {
  it('none: a pre-2-9a row (no grnId, no attachment) renders 5-2b’s bytes exactly', () => {
    expect(hash(renderEmail('client-receipt', receipt, context))).toBe(FIVE_TWO_B_GOLDEN);
    expect(hash(renderEmail('client-receipt', receipt, { ...context, attachment: 'none' }))).toBe(FIVE_TWO_B_GOLDEN);
  });

  it('attached: names the file; the portal link opens THAT receipt (/portal/inbound?grn=…)', () => {
    const mail = renderEmail('client-receipt', { ...receipt, grnId: GRN_ID }, { ...context, attachment: 'attached' });
    expect(mail.text).toContain('The goods receipt note is attached (GRN-0007.pdf).');
    expect(mail.text).toContain(`https://app.wms.test/portal/inbound?grn=${GRN_ID}`);
    expect(mail.html).toContain(`href="https://app.wms.test/portal/inbound?grn=${GRN_ID}"`);
    expect(mail.text).not.toContain(RECEIPT_ATTACHMENT_FAILED);
  });

  it('too-large and failed: the email goes without the file and says where to get it', () => {
    const large = renderEmail('client-receipt', { ...receipt, grnId: GRN_ID }, { ...context, attachment: 'too-large' });
    expect(large.text).toContain(RECEIPT_ATTACHMENT_TOO_LARGE);
    expect(large.text).not.toContain('is attached');
    const failed = renderEmail('client-receipt', { ...receipt, grnId: GRN_ID }, { ...context, attachment: 'failed' });
    expect(failed.text).toContain('The GRN could not be attached — download it from the client portal, or reply to this email to ask for it.');
    expect(failed.html).toContain('could not be attached');
  });

  it('the decoder: grnId is optional, and refused when present but not a uuid', () => {
    expect(decodeClientReceiptParams(receipt)).not.toHaveProperty('grnId');
    expect(decodeClientReceiptParams({ ...receipt, grnId: GRN_ID }).grnId).toBe(GRN_ID);
    expect(() => decodeClientReceiptParams({ ...receipt, grnId: 'GRN-0007' })).toThrow(/grnId/);
  });
});
