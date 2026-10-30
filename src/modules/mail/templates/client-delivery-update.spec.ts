import { renderEmail } from './index';
import {
  clientDeliveryUpdateSubject,
  decodeClientDeliveryUpdateParams,
  deliveryExceptionsText,
  type ClientDeliveryUpdateEmailParams,
} from './client-delivery-update';
import { dispatchFreightLine } from './client-dispatch';

/** Story 4-9a (A27) — the delivery update's subject, body and decoder. */
const params: ClientDeliveryUpdateEmailParams = {
  tenantName: 'Northwind 3PL',
  clientName: 'Acme <Brands>',
  orderId: '019a0000-0000-7000-8000-0000000000b1',
  orderRef: 'PO-77',
  consigneeCity: 'Pune',
  consignmentRef: 'LD-0007/03',
  outcome: 'delivered-with-exceptions',
  deliveredAt: '2026-11-02T05:50:00.000Z',
  receiverName: 'A. Kumar',
  shortPackageCount: 0,
  damagedPackageCount: 1,
  note: 'pallet 4 crushed corner',
  transporterName: 'VRL Logistics',
  lrNumber: '4410',
  vehicleNumber: 'KA01AB1234',
  amended: false,
  replyTo: null,
};
const context = { tenantId: '019a0000-0000-7000-8000-000000000001', to: 'ops@acme.example', webBaseUrl: 'https://wms.example', secret: null };

describe('story 4-9a — the client-delivery-update notice', () => {
  it('the subject names the outcome; an amendment is prefixed "Updated: "', () => {
    expect(clientDeliveryUpdateSubject({ ...params, outcome: 'delivered' })).toBe('Acme <Brands>: order PO-77 delivered');
    expect(clientDeliveryUpdateSubject(params)).toBe('Acme <Brands>: order PO-77 delivered with exceptions');
    expect(clientDeliveryUpdateSubject({ ...params, outcome: 'refused', amended: true })).toBe('Updated: Acme <Brands>: order PO-77 refused by the consignee');
  });

  it('the body names the city, transporter, LR, vehicle, IST time, receiver, counts and note, with the order link; the HTML escapes', () => {
    const mail = renderEmail('client-delivery-update', params, context);
    expect(mail.text).toContain('Order PO-77 for Acme <Brands> was delivered with exceptions in Pune, carried by VRL Logistics.');
    for (const line of ['Freight note: LD-0007/03', 'LR number: 4410', 'Vehicle: KA01AB1234', 'Delivered: 2 November 2026, 11:20 (IST)', 'Received by: A. Kumar', 'Exceptions: 1 package damaged', 'Remarks: pallet 4 crushed corner']) {
      expect(mail.text).toContain(line);
    }
    expect(mail.text).toContain('https://wms.example/portal/orders?order=019a0000-0000-7000-8000-0000000000b1');
    expect(mail.html).toContain('Acme &lt;Brands&gt;');
    expect(mail.html).not.toContain('Acme <Brands>');
    expect(mail.fromName).toBe('Northwind 3PL via WMS');
  });

  it('a refusal reads as one; an amendment says it replaces the earlier notice; absent facts are omitted', () => {
    const mail = renderEmail('client-delivery-update', { ...params, outcome: 'refused', amended: true, consigneeCity: null, lrNumber: null, receiverName: null, damagedPackageCount: null, note: 'wrong item' }, context);
    expect(mail.text).toContain('The consignee refused order PO-77 for Acme <Brands>, carried by VRL Logistics.');
    expect(mail.text).toContain('replaces the earlier notice');
    expect(mail.text).not.toContain('LR number');
    expect(mail.text).not.toContain('Received by');
    expect(mail.text).toContain('Refused: 2 November 2026, 11:20 (IST)');
  });

  it('the exceptions text and the decoder', () => {
    expect(deliveryExceptionsText({ shortPackageCount: 2, damagedPackageCount: 1 })).toBe('2 packages short, 1 package damaged');
    expect(deliveryExceptionsText({ shortPackageCount: 0, damagedPackageCount: null })).toBeNull();
    expect(decodeClientDeliveryUpdateParams(JSON.parse(JSON.stringify(params)))).toEqual(params);
    expect(() => decodeClientDeliveryUpdateParams({ ...params, outcome: 'lost' })).toThrow(/outcome/);
    expect(() => decodeClientDeliveryUpdateParams({ ...params, damagedPackageCount: -1 })).toThrow(/damagedPackageCount/);
  });

  it('the dispatch email gains one truck line only for an order that left on a truck (A27)', () => {
    expect(dispatchFreightLine({ freight: { consignmentRef: 'LD-0007/03', vehicleNumber: 'KA01AB1234', packageCount: 15 } })).toBe('By truck KA01AB1234 — 15 packages, freight note LD-0007/03');
    expect(dispatchFreightLine({ freight: { consignmentRef: 'LD-0007/03', vehicleNumber: 'KA01AB1234', packageCount: 1 } })).toBe('By truck KA01AB1234 — 1 package, freight note LD-0007/03');
    expect(dispatchFreightLine({})).toBeNull();
  });
});
