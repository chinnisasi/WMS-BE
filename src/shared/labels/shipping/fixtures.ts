import type { CartonLabelInput, LabelConsignee, LabelShipper } from './carton-label';

/** Story 4-5a — shared label fixtures for the shipping-label specs (test-only data, no logic). */
export const ORDER_ID = '01a18ba8-4743-79dd-8fe5-145b99902272';

export const SHIPPER: LabelShipper = { brandName: 'Acme Brands', warehouseName: 'Main DC', warehouseCity: 'Bengaluru', warehousePincode: '562123' };

export const B2C: LabelConsignee = {
  contactName: 'Ravi Kumar',
  legalName: null,
  line1: '12, 3rd Cross, Indiranagar',
  line2: null,
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560038',
  phone: '9876543210',
  gstin: null,
};

/** The A42 worst case: a B2B consignee whose legal name and both address lines wrap. */
export const WORST_B2B: LabelConsignee = {
  contactName: 'Purchase Department Receiving Desk Attn Mr Venkataraman Subramanian',
  legalName: 'Shree Venkateshwara Wholesale Distributors and Logistics Private Limited',
  line1: 'Plot No 1234, Industrial Estate Phase II, Near the Old Railway Goods Shed, Opposite Indian Oil Petrol Bunk',
  line2: 'Survey No 56/7B, Behind Government Higher Primary School, Peenya Second Stage, Tumkur Road Industrial Area',
  city: 'Bengaluru Rural District Headquarters',
  state: 'Karnataka',
  pincode: '562123',
  phone: '+919876543210',
  gstin: '29ABCDE1234F1Z5',
};

export function cartonInput(extra: Partial<CartonLabelInput> = {}): CartonLabelInput {
  return {
    shipper: SHIPPER,
    consignee: B2C,
    orderLabel: 'SO-1',
    clientOrderRef: 'ACME-77',
    packedAt: '2026-10-30T05:00:00.000Z',
    cartonNo: 1,
    cartonCount: 2,
    weightGrams: 3200,
    dimensionsMm: { lengthMm: 400, widthMm: 300, heightMm: 200 },
    payment: { kind: 'cod', amountPaise: 125000 },
    courierName: 'Delhivery',
    awb: '123456789012',
    cartonCode: 'O8FE5145B99902272.1.1',
    ...extra,
  };
}
