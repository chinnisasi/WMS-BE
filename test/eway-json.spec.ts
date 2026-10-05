import {
  EMPTY_PART_B,
  EWAY_BLOCKERS,
  NIC_BULK_VERSION,
  NIC_RATE_BPS,
  TERMINAL_BLOCKERS,
  bulkFile,
  ewbBillObject,
  ewbBlockers,
  nicText,
  normalizePartB,
  partBProblems,
  type EwayInvoiceFacts,
  type EwayPartB,
  type StateCodeMaps,
} from '../src/modules/invoicing/eway-json';
import { consignmentValuePaise, ewayRequired, istDateOf } from '../src/modules/invoicing/eway-threshold';
import { sandboxEwayGateway, unconfiguredEwayGateway, ewayGatewayFromEnv, EwayGatewayRefusal } from '../src/modules/invoicing/eway-gateway';
import { normalizeStateName, type InvoiceDocument, type InvoiceDocumentLine, type StateCodeEntry } from '../src/modules/invoicing/generator';
import { ProblemException } from '../src/shared/problem-details/problem.exception';

/**
 * Story 8-2b — the pure e-way functions: the consignment value, the NIC bill
 * object builder (every key AND its typeof), the blockers, the Part B rules
 * and the gateway adapters. No DB, no app.
 */

const STATES: StateCodeEntry[] = [
  { stateCode: '07', stateName: 'Delhi' },
  { stateCode: '24', stateName: 'Gujarat' },
  { stateCode: '27', stateName: 'Maharashtra' },
  { stateCode: '29', stateName: 'Karnataka' },
  { stateCode: '97', stateName: 'Other Territory' },
  { stateCode: '99', stateName: 'Other Country' },
];
const MAPS: StateCodeMaps = {
  byPrefix: new Map(STATES.map((s) => [s.stateCode, s])),
  byName: new Map(STATES.map((s) => [normalizeStateName(s.stateName), s])),
};

const ORIGIN = {
  contactName: 'Dock',
  phone: '9999999999',
  line1: '12, Industrial Area — Phase "2"',
  line2: null,
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const CONSIGNEE = {
  contactName: 'Asha Traders',
  phone: '8888888888',
  line1: '4/7 MG Road',
  line2: 'Near Station; Gate #2',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
};

function line(overrides: Partial<InvoiceDocumentLine> = {}): InvoiceDocumentLine {
  return {
    orderLineId: '00000000-0000-7000-8000-000000000001',
    skuCode: 'PEP',
    skuName: 'Black pepper (whole) 1kg',
    hsn: '0904',
    qtyMilli: 2_500,
    uom: 'kg',
    ratePaise: 2_000_000,
    rateSource: 'order_line',
    taxablePaise: 5_000_000,
    gstBps: 500,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 250_000,
    hsnGap: false,
    ...overrides,
  };
}

function facts(overrides: Partial<EwayInvoiceFacts> = {}, docOverrides: Partial<InvoiceDocument> = {}, headerOverrides: Partial<InvoiceDocument['header']> = {}): EwayInvoiceFacts {
  const lines = docOverrides.lines ?? [line(), line({ orderLineId: 'b', skuName: 'Rice 25kg bag', hsn: '1006', uom: 'bag', qtyMilli: 3_000, taxablePaise: 1_234_567, gstBps: 1800, igstPaise: 222_222 })];
  const subtotal = lines.reduce((s, l) => s + l.taxablePaise, 0);
  const gst = lines.reduce((s, l) => s + l.cgstPaise + l.sgstPaise + l.igstPaise, 0);
  const total = subtotal + gst;
  const payable = Math.floor((total + 50) / 100) * 100;
  const document: InvoiceDocument = {
    header: {
      invoiceNo: '29/2627/000042',
      fyLabel: 'FY-2627',
      orderRef: 'o',
      issuedAt: '2026-10-03T20:00:00.000Z',
      supplyType: 'inter',
      placeOfSupply: '27',
      originGstin: '29AAAPZ1234C1ZV',
      consigneeGstin: '27BBBPT5678M2AB',
      originAddress: ORIGIN,
      consigneeAddress: CONSIGNEE,
      ...headerOverrides,
    },
    seller: { name: 'Spice Co & Sons (P) Ltd.', gstin: '29AAAPZ1234C1ZV' },
    buyer: { name: 'Asha Traders', gstin: '27BBBPT5678M2AB' },
    lines,
    totals: { subtotal, gst, total, roundOff: payable - total, payable },
    gaps: [],
    revision: 1,
    ...docOverrides,
  };
  return {
    invoiceNo: '29/2627/000042',
    issuedAt: '2026-10-03T20:00:00.000Z',
    originGstin: '29AAAPZ1234C1ZV',
    consigneeGstin: '27BBBPT5678M2AB',
    placeOfSupply: '27',
    supplyType: 'inter',
    payablePaise: payable,
    roundOffPaise: payable - total,
    document,
    ...overrides,
  };
}

const ROAD: EwayPartB = { ...EMPTY_PART_B, transMode: 1, vehicleNo: 'KA01AB1234', vehicleType: 'R', distanceKm: 840 };
const CTX = { maps: MAPS, eInvoiceApplies: false, todayIst: '2026-10-04' };

describe('e-way: consignment value and threshold (story 8-2b)', () => {
  it('sums taxable + every tax over TAXABLE lines only (0% lines are exempt)', () => {
    // Matrix: ₹40k at 0% + ₹20k at 5% → ₹21,000, under the ₹50,000 threshold.
    const value = consignmentValuePaise([
      { gstBps: 0, taxablePaise: 4_000_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
      { gstBps: 500, taxablePaise: 2_000_000, cgstPaise: 50_000, sgstPaise: 50_000, igstPaise: 0 },
    ]);
    expect(value).toBe(2_100_000);
    expect(ewayRequired(value, { thresholdPaise: 5_000_000, rule: 'national' })).toBe(false);
  });

  it('needs a bill strictly ABOVE the threshold; a null threshold never needs one', () => {
    const national = { thresholdPaise: 5_000_000, rule: 'national' };
    expect(ewayRequired(5_000_001, national)).toBe(true);
    expect(ewayRequired(5_000_000, national)).toBe(false);
    expect(ewayRequired(99_999_999, { thresholdPaise: null, rule: 'state:27' })).toBe(false);
  });

  it('reads the IST calendar date of an instant (18:30Z is the next IST day)', () => {
    expect(istDateOf('2026-09-30T18:29:59.999Z')).toBe('2026-09-30');
    expect(istDateOf('2026-09-30T18:30:00.000Z')).toBe('2026-10-01');
  });
});

describe('e-way: the NIC bill object (story 8-2b)', () => {
  const KEY_TYPES: Record<string, string> = {
    userGstin: 'string', supplyType: 'string', subSupplyType: 'number', subSupplyDesc: 'string', docType: 'string',
    docNo: 'string', docDate: 'string', transType: 'number', fromGstin: 'string', fromTrdName: 'string',
    fromAddr1: 'string', fromAddr2: 'string', fromPlace: 'string', fromPincode: 'number', fromStateCode: 'number',
    actualFromStateCode: 'number', toGstin: 'string', toTrdName: 'string', toAddr1: 'string', toAddr2: 'string',
    toPlace: 'string', toPincode: 'number', toStateCode: 'number', actualToStateCode: 'number', totalValue: 'number',
    cgstValue: 'number', sgstValue: 'number', igstValue: 'number', cessValue: 'number', TotNonAdvolVal: 'number',
    OthValue: 'number', totInvValue: 'number', transMode: 'number', transDistance: 'number', transporterId: 'string',
    transporterName: 'string', transDocNo: 'string', transDocDate: 'string', vehicleNo: 'string', vehicleType: 'string',
    mainHsnCode: 'string', itemList: 'object',
  };
  const ITEM_TYPES: Record<string, string> = {
    itemNo: 'number', productName: 'string', productDesc: 'string', hsnCode: 'string', quantity: 'number',
    qtyUnit: 'string', taxableAmount: 'number', cgstRate: 'number', sgstRate: 'number', igstRate: 'number',
    cessRate: 'number', cessNonAdvol: 'number',
  };

  it('emits exactly NIC bulk keys with their pinned types', () => {
    const bill = ewbBillObject(facts(), ROAD, MAPS);
    expect(Object.keys(bill).sort()).toEqual(Object.keys(KEY_TYPES).sort());
    for (const [key, type] of Object.entries(KEY_TYPES)) {
      expect([key, typeof (bill as unknown as Record<string, unknown>)[key]]).toEqual([key, type]);
    }
    for (const item of bill.itemList) {
      expect(Object.keys(item).sort()).toEqual(Object.keys(ITEM_TYPES).sort());
      for (const [key, type] of Object.entries(ITEM_TYPES)) {
        expect([key, typeof (item as unknown as Record<string, unknown>)[key]]).toEqual([key, type]);
      }
    }
  });

  it('maps the parties, the fixed codes, the IST date and the text rule', () => {
    const bill = ewbBillObject(facts(), ROAD, MAPS);
    expect(bill).toMatchObject({
      userGstin: '29AAAPZ1234C1ZV',
      fromGstin: '29AAAPZ1234C1ZV',
      supplyType: 'O',
      subSupplyType: 1,
      subSupplyDesc: '',
      docType: 'INV',
      transType: 1,
      docNo: '29/2627/000042',
      // 20:00Z on 3 Oct is 01:30 IST on 4 Oct.
      docDate: '04/10/2026',
      fromTrdName: 'Spice Co & Sons P Ltd.',
      fromAddr1: '12, Industrial Area  Phase 2',
      fromAddr2: '',
      fromPlace: 'Bengaluru',
      fromPincode: 560001,
      fromStateCode: 29,
      actualFromStateCode: 29,
      toGstin: '27BBBPT5678M2AB',
      toTrdName: 'Asha Traders',
      toAddr1: '4/7 MG Road',
      toAddr2: 'Near Station Gate #2',
      toPincode: 411001,
      toStateCode: 27,
      actualToStateCode: 27,
      cessValue: 0,
      TotNonAdvolVal: 0,
      transMode: 1,
      transDistance: 840,
      vehicleNo: 'KA01AB1234',
      vehicleType: 'R',
      transporterId: '',
      mainHsnCode: '0904',
    });
    expect(bill.itemList[1]).toMatchObject({ itemNo: 2, hsnCode: '1006', quantity: 3, qtyUnit: 'BAG', igstRate: 18, cgstRate: 0, sgstRate: 0 });
    expect(bill.itemList[0]).toMatchObject({ quantity: 2.5, qtyUnit: 'KGS', igstRate: 5, taxableAmount: 50000 });
  });

  it('reconciles in integer paise: totalValue + cgst + sgst + igst + OthValue = totInvValue = payable', () => {
    const f = facts();
    const bill = ewbBillObject(f, ROAD, MAPS);
    const paise = (n: number): number => Math.round(n * 100);
    expect(paise(bill.totalValue) + paise(bill.cgstValue) + paise(bill.sgstValue) + paise(bill.igstValue) + paise(bill.OthValue)).toBe(
      paise(bill.totInvValue),
    );
    expect(paise(bill.totInvValue)).toBe(f.payablePaise);
    expect(paise(bill.totalValue)).toBe(f.document.totals.subtotal);
  });

  it('splits intra-state rates into CGST/SGST halves', () => {
    const intra = facts(
      { supplyType: 'intra', placeOfSupply: '29', consigneeGstin: null },
      { lines: [line({ gstBps: 1800, igstPaise: 0, cgstPaise: 450_000, sgstPaise: 450_000 }), line({ orderLineId: 'c', gstBps: 25, igstPaise: 0, cgstPaise: 6_250, sgstPaise: 6_250 })] },
      { consigneeAddress: { ...CONSIGNEE, state: 'Karnataka', pincode: '560001' } },
    );
    const bill = ewbBillObject(intra, { ...ROAD, distanceKm: 0 }, MAPS);
    expect(bill.toGstin).toBe('URP');
    expect(bill.itemList[0]).toMatchObject({ cgstRate: 9, sgstRate: 9, igstRate: 0 });
    expect(bill.itemList[1]).toMatchObject({ cgstRate: 0.125, sgstRate: 0.125 });
    // Distance 0 with equal pincodes is sent as 1 (NIC refuses 0 there).
    expect(bill.transDistance).toBe(1);
  });

  it('exports a Part-A-only bill as Road with an empty vehicle of type R', () => {
    const partA: EwayPartB = { ...EMPTY_PART_B, transMode: 1, transporterId: '29AABCT1234Q1ZP' };
    const bill = ewbBillObject(facts(), partA, MAPS);
    expect([bill.transMode, bill.vehicleNo, bill.vehicleType, bill.transporterId]).toEqual([1, '', 'R', '29AABCT1234Q1ZP']);
    expect(ewbBlockers(facts(), partA, CTX)).toEqual([]);
  });

  it('a transporter id with NO mode is a valid Part A and exports as Road (transMode 1)', () => {
    const partA: EwayPartB = { ...EMPTY_PART_B, transporterId: '29AABCT1234Q1ZP', transporterName: 'Swift' };
    expect(partBProblems(partA, { invoiceDate: '2026-10-04', fromPincode: '560001', toPincode: '411001' })).toEqual([]);
    expect(ewbBlockers(facts(), partA, CTX)).toEqual([]);
    const bill = ewbBillObject(facts(), partA, MAPS);
    expect([bill.transMode, bill.vehicleNo, bill.vehicleType]).toEqual([1, '', 'R']);
  });

  it('carries the transport document (and no vehicle) for Rail/Air/Ship', () => {
    const rail: EwayPartB = { ...EMPTY_PART_B, transMode: 2, transDocNo: 'RR-99/1', transDocDate: '2026-10-05', distanceKm: 1200 };
    const bill = ewbBillObject(facts(), rail, MAPS);
    expect([bill.transMode, bill.vehicleNo, bill.vehicleType, bill.transDocNo, bill.transDocDate]).toEqual([2, '', 'R', 'RR-99/1', '05/10/2026']);
  });

  it('wraps bills in the bulk version envelope', () => {
    const file = bulkFile([ewbBillObject(facts(), ROAD, MAPS)]);
    expect(file.version).toBe(NIC_BULK_VERSION);
    expect(file.billLists).toHaveLength(1);
  });

  it('nicText drops characters outside NIC\'s set, then truncates', () => {
    expect(nicText('Aéb*c(d)', 100)).toBe('Abcd');
    expect(nicText('x'.repeat(130), 120)).toHaveLength(120);
  });
});

describe('e-way: blockers (story 8-2b)', () => {
  const codes = (f: EwayInvoiceFacts, partB: EwayPartB = ROAD, ctx = CTX): string[] => ewbBlockers(f, partB, ctx).map((b) => b.code);

  it('a ready bill has none', () => {
    expect(codes(facts())).toEqual([]);
  });

  it('marks exactly the two fixable kinds non-terminal', () => {
    expect(EWAY_BLOCKERS.filter((code) => !TERMINAL_BLOCKERS.has(code))).toEqual(['needs-irn', 'transport-incomplete']);
  });

  it('hsn-issue: a blank or malformed HSN on any line', () => {
    expect(codes(facts({}, { lines: [line({ hsn: null })] }))).toEqual(['hsn-issue']);
    expect(codes(facts({}, { lines: [line({ hsn: 'HSN 0904' })] }))).toEqual(['hsn-issue']);
    expect(codes(facts({}, { lines: [line({ hsn: ' 090411 ' })] }))).toEqual([]);
  });

  it('doc-too-old: more than 180 IST calendar days', () => {
    // Issued 4 Oct IST: 180 days later is 2 Apr 2027 (ok), 181 is 3 Apr.
    expect(codes(facts(), ROAD, { ...CTX, todayIst: '2027-04-02' })).toEqual([]);
    expect(codes(facts(), ROAD, { ...CTX, todayIst: '2027-04-03' })).toEqual(['doc-too-old']);
  });

  it('too-many-lines: over 250', () => {
    const lines = Array.from({ length: 251 }, (_, i) => line({ orderLineId: String(i) }));
    expect(codes(facts({}, { lines }))).toEqual(['too-many-lines']);
  });

  it('address-incomplete: a null address or buyer name', () => {
    expect(codes(facts({}, {}, { consigneeAddress: null }))).toContain('address-incomplete');
    expect(codes(facts({}, { buyer: { name: null, gstin: null } }))).toEqual(['address-incomplete']);
  });

  it('address-incomplete: a name, line1 or city that NIC\'s text rule empties', () => {
    expect(codes(facts({}, { buyer: { name: '***', gstin: null } }))).toEqual(['address-incomplete']);
    expect(codes(facts({}, { seller: { name: '()', gstin: null } }))).toEqual(['address-incomplete']);
    expect(codes(facts({}, {}, { originAddress: { ...ORIGIN, line1: '"!"' } }))).toEqual(['address-incomplete']);
    expect(codes(facts({}, {}, { consigneeAddress: { ...CONSIGNEE, city: '()' } }))).toContain('address-incomplete');
  });

  it('state-unresolved: an address state off the CBIC list', () => {
    expect(codes(facts({}, {}, { consigneeAddress: { ...CONSIGNEE, state: 'Atlantis' } }))).toEqual(['state-unresolved']);
  });

  it('ship-to-differs: the address state disagrees with the place of supply or the GSTIN state (pos-discrepancy)', () => {
    expect(codes(facts({}, {}, { consigneeAddress: { ...CONSIGNEE, state: 'Gujarat' } }))).toEqual(['ship-to-differs']);
    expect(codes(facts({}, {}, { originAddress: { ...ORIGIN, state: 'Delhi' } }))).toEqual(['ship-to-differs']);
  });

  it('unsupported-supply: place of supply 97 or 99', () => {
    expect(codes(facts({ placeOfSupply: '97' }))).toContain('unsupported-supply');
  });

  it('rate-not-standard: outside NIC\'s table (40% allowed)', () => {
    expect(NIC_RATE_BPS).toEqual([0, 10, 25, 300, 500, 1200, 1800, 2800, 4000]);
    expect(codes(facts({}, { lines: [line({ gstBps: 4000 })] }))).toEqual([]);
    expect(codes(facts({}, { lines: [line({ gstBps: 600 })] }))).toEqual(['rate-not-standard']);
  });

  it('needs-irn: B2B with the GSTIN flag on (B2C still exports)', () => {
    expect(ewbBlockers(facts(), ROAD, { ...CTX, eInvoiceApplies: true })).toEqual([{ code: 'needs-irn', terminal: false }]);
    expect(codes(facts({ consigneeGstin: null }), ROAD, { ...CTX, eInvoiceApplies: true })).toEqual([]);
  });

  it('transport-incomplete: no Part B and no transporter, or an invalid Part B', () => {
    expect(ewbBlockers(facts(), EMPTY_PART_B, CTX)).toEqual([{ code: 'transport-incomplete', terminal: false }]);
    expect(codes(facts(), { ...ROAD, vehicleType: null })).toEqual(['transport-incomplete']);
  });
});

describe('e-way: Part B rules (story 8-2b)', () => {
  const ctx = { invoiceDate: '2026-10-04', fromPincode: '560001', toPincode: '411001' };

  it('normalizes leniently (uppercases, strips vehicle spaces, blank → null)', () => {
    expect(normalizePartB({ transMode: 1, vehicleNo: ' ka 01 ab 1234 ', vehicleType: 'r', transporterId: ' 29aabct1234q1zp ', transporterName: '  ' })).toEqual({
      ...EMPTY_PART_B,
      transMode: 1,
      vehicleNo: 'KA01AB1234',
      vehicleType: 'R',
      transporterId: '29AABCT1234Q1ZP',
    });
  });

  it('accepts an empty Part B and a valid Road one', () => {
    expect(partBProblems(EMPTY_PART_B, ctx)).toEqual([]);
    expect(partBProblems(ROAD, ctx)).toEqual([]);
  });

  it('names each broken rule', () => {
    expect(partBProblems({ ...EMPTY_PART_B, vehicleNo: 'KA01AB1234' }, ctx).join('|')).toContain('transMode is required');
    expect(partBProblems({ ...ROAD, vehicleType: null }, ctx).join('|')).toContain('vehicleType');
    expect(partBProblems({ ...ROAD, vehicleNo: 'K-1' }, ctx).join('|')).toContain('vehicleNo');
    expect(partBProblems({ ...EMPTY_PART_B, transMode: 3 }, ctx).join('|')).toContain('transDocNo is required');
    expect(partBProblems({ ...EMPTY_PART_B, transMode: 4, transDocNo: 'B/L 1', transDocDate: '2026-10-04', vehicleNo: 'KA01AB1234' }, ctx).join('|')).toContain('must be empty');
    expect(partBProblems({ ...ROAD, transporterId: '29AAB' }, ctx).join('|')).toContain('transporterId');
    expect(partBProblems({ ...ROAD, transporterName: 'x'.repeat(26) }, ctx).join('|')).toContain('transporterName');
    expect(partBProblems({ ...ROAD, transDocDate: '2026-10-03' }, ctx).join('|')).toContain('before the invoice date');
    expect(partBProblems({ ...ROAD, distanceKm: 4001 }, ctx).join('|')).toContain('distanceKm');
    expect(partBProblems({ ...ROAD, distanceKm: 101 }, { ...ctx, toPincode: '560001' }).join('|')).toContain('both pincodes are equal');
    expect(partBProblems({ ...ROAD, distanceKm: 100 }, { ...ctx, toPincode: '560001' })).toEqual([]);
  });
});

describe('e-way: gateway adapters (story 8-2b)', () => {
  const request = (overrides: Partial<ReturnType<typeof ewbBillObject>> = {}) => ({
    billId: '0192a000-0000-7000-8000-00000000abcd',
    bill: { ...ewbBillObject(facts(), ROAD, MAPS), ...overrides },
  });

  it('unconfigured: never configured, generate throws the typed 501', async () => {
    const gw = unconfiguredEwayGateway();
    await expect(gw.configuredFor('t', '29AAAPZ1234C1ZV')).resolves.toBe(false);
    const err = await gw.generate('t', 'g', request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).getStatus()).toBe(501);
    expect(((err as ProblemException).getResponse() as { code: string }).code).toBe('gateway-unconfigured');
  });

  it('sandbox: a deterministic 12-digit number; validity ⌈distance/200⌉ days with a vehicle', async () => {
    const gw = sandboxEwayGateway(() => '2026-10-04T10:00:00.000Z');
    const a = await gw.generate('t', 'g', request());
    const b = await gw.generate('t', 'g', request());
    expect(a.ewbNo).toMatch(/^[0-9]{12}$/);
    expect(b.ewbNo).toBe(a.ewbNo);
    // 840 km → 5 days.
    expect(a.validUntil).toBe('2026-10-09T10:00:00.000Z');
    const partA = await gw.generate('t', 'g', request({ vehicleNo: '' }));
    expect(partA.validUntil).toBeNull();
  });

  it('sandbox: a Rail bill with a document gets validity; over-dimensional cargo runs 20 km a day', async () => {
    const gw = sandboxEwayGateway(() => '2026-10-04T10:00:00.000Z');
    const rail = await gw.generate('t', 'g', request({ transMode: 2, vehicleNo: '', transDocNo: 'RR1', transDistance: 400 }));
    expect(rail.validUntil).toBe('2026-10-06T10:00:00.000Z');
    const odc = await gw.generate('t', 'g', request({ vehicleType: 'O', transDistance: 50 }));
    expect(odc.validUntil).toBe('2026-10-07T10:00:00.000Z');
  });

  it('sandbox: refuses a SANDBOX-REFUSE transporter as a business refusal', async () => {
    await expect(sandboxEwayGateway().generate('t', 'g', request({ transporterName: 'SANDBOX-REFUSE' }))).rejects.toBeInstanceOf(EwayGatewayRefusal);
  });

  it('the env selects a mode (default unconfigured) and refuses an unknown one', async () => {
    await expect(ewayGatewayFromEnv(undefined).configuredFor('t', 'g')).resolves.toBe(false);
    await expect(ewayGatewayFromEnv('sandbox').configuredFor('t', 'g')).resolves.toBe(true);
    expect(() => ewayGatewayFromEnv('live-nic')).toThrow(/EWAY_GATEWAY/);
  });
});
