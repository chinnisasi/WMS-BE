import type { INestApplication } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import type { Database } from '../src/shared/db/db';
import { withTenantTransaction } from '../src/shared/db/tenant-scope';
import { txDeadlineOf } from '../src/shared/db/tx-deadline';
import { addIsoDays, istDateOf, istMidnightOf, istWallClock } from '../src/shared/primitives/time';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import type { SignedQuantity } from '../src/shared/primitives/quantity';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { InboundFacade } from '../src/modules/inbound/inbound.facade';
import { OutboundFacade } from '../src/modules/outbound/outbound.facade';
import { firstDispatchQuery } from '../src/modules/inventory/registers';
import { REGISTER_CONCURRENCY, REGISTER_DEADLINE_MS, REGISTERS, ReportingFacade } from '../src/modules/reporting/reporting.facade';
import type { RegisterName } from '../src/modules/reporting/reporting.facade';
import { auditCsvLine, csvCell as auditCsvCell, UTF8_BOM as AUDIT_BOM } from '../src/modules/tenancy/audit-export.csv';
import { buildCsv, csvCell, UTF8_BOM } from '../src/shared/export/csv';
import { memberDisplayNamesInTx } from '../src/modules/tenancy/tenancy.service';
import { SYSTEM_ACTOR_ID } from '../src/shared/primitives/audit';
import { createLinkedVendor } from './support/linked-vendor';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 5-3a — the operational registers: one read-only download route, five
// registers, CSV and XLSX. Stock is seeded through the real adjustment route
// (so the projections are the fold's); the dated sources (GRNs, orders,
// shipments) are raw inserts with chosen server stamps, in a period that
// ends 80 days before the run; the dispatch events go through the ledger
// facade with a chosen `recordedAt`. Every expected row is hand-written from
// these fixtures. Superuser connection (RLS inert): the HTTP tests prove the
// app predicates.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.STORAGE_SNAPSHOT_POLL_MS;

jest.setTimeout(180_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A minimal RFC 4180 reader (quotes, doubled quotes, CRLF) for the files under test. */
function parseCsv(text: string): string[][] {
  expect(text.startsWith(UTF8_BOM)).toBe(true);
  const body = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += ch;
    }
  }
  expect(cell).toBe('');
  expect(row).toEqual([]);
  return rows;
}

// supertest's `.parse()` types its stream as superagent's Response, which at
// runtime is the Node IncomingMessage — a readable stream.
function binary(res: request.Response, callback: (err: Error | null, body: Buffer) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('operational registers (e2e, story 5-3a)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let db: Database;
  let inventory: InventoryFacade;
  let reporting: ReportingFacade;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let ownerName: string;
  let opsToken: string;
  let opsName: string;
  let portalToken: string;
  let wh1: string;
  let wh1Code: string;
  let wh2: string;
  let acme: string;
  let beta: string;
  const bin = new Map<string, string>();
  let zoneId: string;
  const sku = new Map<string, string>();
  let batchB1: string;
  let po1: { id: string; code: string };
  let gateIn: { id: string; code: string };
  let asn1: { id: string; code: string };
  const grnIds = new Map<string, string>();
  let receivingBin: string;
  const order = new Map<string, string>();

  const today = istDateOf(new Date().toISOString());
  const D0 = addIsoDays(today, -90);
  /** The dated fixtures' period: 10 IST days ending 80 days before the run. */
  const P = { from: D0, to: addIsoDays(D0, 9) };
  const EXPIRY_B1 = '2027-03-15';
  const EXPIRY_B2 = '2027-01-10';
  const MFG_B1 = '2026-09-01';

  /** An instant on fixture day `day` (offset from D0), at the IST wall clock hh:mm:ss. */
  function at(day: number, hh: number, mm = 0, ss = 0): string {
    return new Date(Date.parse(istMidnightOf(addIsoDays(D0, day))) + hh * HOUR + mm * MINUTE + ss * 1000).toISOString();
  }

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('registers');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    db = app.get<Database>(DATABASE);
    inventory = app.get(InventoryFacade);
    reporting = app.get(ReportingFacade);

    const ownerHandle = `ravi.kumar+${ulid().toLowerCase()}`;
    ownerName = ownerHandle;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Register 3PL ${ulid()}`, ownerEmail: `${ownerHandle}@example.com`, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = await signIn(`${ownerHandle}@example.com`);

    wh1Code = `RG1-${ulid().slice(20)}`;
    wh1 = await createWarehouse(wh1Code);
    wh2 = await createWarehouse(`RG2-${ulid().slice(20)}`);
    const zone = await http()
      .post(`${API}/${tenantId}/warehouses/${wh1}/zones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: 'Zone A' })
      .expect(201);
    zoneId = zone.body.id as string;
    for (const code of ['A-01-01', 'A-01-02', 'A-01-03']) {
      const created = await http()
        .post(`${API}/${tenantId}/warehouses/${wh1}/zones/${zone.body.id as string}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 100000, type: 'shelf', code })
        .expect(201);
      bin.set(code, created.body.id as string);
    }

    acme = await createClient('ACME', 'Acme Brands');
    beta = await createClient('BETA', 'Beta Beauty');
    await importCsv(['AC-BT,Acme Pills,pcs,,1800,3004,true,false,,,', 'AC-PL,Acme Plain,pcs,,1800,,false,false,,,', 'AC-KIT,Acme Kit,pcs,,1800,,false,false,,,'], acme);
    await importCsv(['BE-PL,Beta Plain,pcs,,1800,,false,false,,,'], beta);
    const skus = await http().get(`${API}/${tenantId}/catalog/skus?limit=200`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of skus.body.items as { code: string; id: string }[]) sku.set(item.code, item.id);

    const opsHandle = `meera.ops+${ulid().toLowerCase()}`;
    opsName = opsHandle;
    opsToken = await invite(`${opsHandle}@example.com`, 'ops_manager');
    opsId = (await sql`select id from users where email = ${`${opsHandle}@example.com`}`)[0]!.id as string;
    portalToken = await invite(`portal-${ulid().toLowerCase()}@brand.example`, 'client', acme);

    // ── stock, through the real adjustment route (the ops manager) ──────────
    await adjust({ skuId: sku.get('AC-PL')!, binId: bin.get('A-01-01')!, quantityDelta: 2 });
    await adjust({ skuId: sku.get('AC-PL')!, binId: bin.get('A-01-02')!, quantityDelta: 3 });
    await adjust({
      skuId: sku.get('AC-BT')!,
      binId: bin.get('A-01-01')!,
      quantityDelta: 5,
      batch: { code: 'B1', mfgDate: istMidnightOf(MFG_B1), expiryDate: istMidnightOf(EXPIRY_B1) },
    });
    await adjust({ skuId: sku.get('AC-BT')!, binId: bin.get('A-01-02')!, quantityDelta: 4, batch: { code: 'B2', expiryDate: istMidnightOf(EXPIRY_B2) } });
    await adjust({ skuId: sku.get('BE-PL')!, binId: bin.get('A-01-03')!, quantityDelta: 7 });
    await adjust({ skuId: sku.get('AC-PL')!, binId: bin.get('A-01-01')!, quantityDelta: -1 });
    // A batch with NO expiry — batch ageing lists it last, with no days to expiry.
    await adjust({ skuId: sku.get('AC-BT')!, binId: bin.get('A-01-03')!, quantityDelta: 2, batch: { code: 'B3' } });
    // Stock in a SYSTEM bin (RECEIVING, inserted the way `ensureReceivingBinInTx` would), through the ledger fold.
    receivingBin = uuidv7();
    await sql`insert into bins (id, tenant_id, warehouse_id, zone_id, code, capacity, type, system_owned)
      values (${receivingBin}, ${tenantId}, ${wh1}, ${zoneId}, 'RECEIVING', 1000000000, 'staging', true)`;
    await withTenantTransaction(db, tenantId, (tx) =>
      inventory.appendLedgerEventInTx(tx, {
        tenantId,
        warehouseId: wh1,
        type: 'stock.adjusted',
        skuId: sku.get('AC-PL')!,
        quantityDelta: 2000 as SignedQuantity,
        fromBinId: null,
        toBinId: receivingBin,
        batchRef: null,
        serialRef: null,
        actorUserId: ownerUserId,
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        referenceDoc: { kind: 'manual-adjustment', reasonCode: 'stock-count', note: 'receiving seed' },
      }),
    );
    batchB1 = (await sql`select id from batches where tenant_id = ${tenantId} and code = 'B1'`)[0]!.id as string;

    // ── inbound: a PO and a gate-in through their routes, GRNs by insert ────
    const vendorId = await createLinkedVendor(app, tenantId, ownerToken, { code: `V-${ulid().slice(20)}`, name: 'Acme Supplies', clientIds: [acme] });
    const po = await http()
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh1, vendorId, code: 'PO-7001', lines: [{ skuId: sku.get('AC-PL')!, orderedQty: 100, unitCostPaise: 1000 }] })
      .expect(201);
    po1 = { id: po.body.purchaseOrder.id as string, code: 'PO-7001' };
    const asn = await http()
      .post(`${API}/${tenantId}/inbound/asns`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ clientId: acme, warehouseId: wh1, asnCode: 'ASN-55', lines: [{ skuId: sku.get('AC-PL')!, announcedQty: 10 }] })
      .expect(201);
    asn1 = { id: asn.body.asn.id as string, code: 'ASN-55' };
    const gi = await http()
      .post(`${API}/${tenantId}/receiving/gate-ins`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({
        warehouseId: wh1,
        vehicleNo: 'KA01AB1234',
        transporterName: 'Typed Roadways',
        sealStatus: 'none',
        documents: [
          { kind: 'invoice', number: 'INV-77', documentDate: addIsoDays(D0, 1), ewayBillNo: '123456789012', poId: po1.id },
          // Unlinked — never printed beside a receipt (another client's goods may ride the truck).
          { kind: 'challan', number: 'CH-9', documentDate: addIsoDays(D0, 1) },
          // The ASN's two documents — one with an e-way bill, one without: the three lists stay aligned.
          { kind: 'invoice', number: 'INV-88', documentDate: addIsoDays(D0, 2), ewayBillNo: '999988887777', asnId: asn1.id },
          { kind: 'challan', number: 'CH-ASN', documentDate: addIsoDays(D0, 2), asnId: asn1.id },
        ],
      })
      .expect(201);
    gateIn = { id: gi.body.gateIn.id as string, code: gi.body.gateIn.code as string };

    // G1: the PO receipt at the gate-in — two ACME lines (one batch).
    await grn('GRN-0901', at(2, 10), { poId: po1.id, gateInId: gateIn.id, clientId: acme }, [
      { sku: 'AC-PL', qty: 10, applied: 10 },
      { sku: 'AC-BT', qty: 6, applied: 5, batchId: batchB1 },
    ]);
    // G2: a BLIND receipt with a NULL client, one ACME line and one BETA line.
    await grn('GRN-0902', at(3, 11), { blind: 'other', clientId: null }, [
      { sku: 'AC-PL', qty: 4, applied: 4 },
      { sku: 'BE-PL', qty: 2, applied: 2 },
    ]);
    // G3: BETA's own.
    await grn('GRN-0903', at(4, 9), { blind: 'unannounced-delivery', clientId: beta }, [{ sku: 'BE-PL', qty: 3, applied: 3 }]);
    // G8: the ASN receipt at the same gate-in.
    await grn('GRN-0908', at(5, 9), { asnId: asn1.id, gateInId: gateIn.id, clientId: acme }, [{ sku: 'AC-PL', qty: 3, applied: 3 }]);
    // Two GRNs sharing ONE created_at — the keyset tie a page boundary must never split badly.
    await grn('GRN-0906', at(6, 12), { blind: 'other', clientId: acme }, [{ sku: 'AC-PL', qty: 1, applied: 1 }]);
    await grn('GRN-0907', at(6, 12), { blind: 'other', clientId: acme }, [{ sku: 'AC-PL', qty: 2, applied: 2 }]);
    // The IST edges: 23:59:59 on the LAST day is in; 00:00 the day after is out; before the first day is out.
    await grn('GRN-0904', at(9, 23, 59, 59), { blind: 'other', clientId: acme }, [{ sku: 'AC-PL', qty: 1, applied: 1 }]);
    await grn('GRN-0905', at(10, 0), { blind: 'other', clientId: acme }, [{ sku: 'AC-PL', qty: 1, applied: 1 }]);
    await grn('GRN-0900', at(-1, 23, 59, 59), { blind: 'other', clientId: acme }, [{ sku: 'AC-PL', qty: 1, applied: 1 }]);

    // ── outbound: orders by insert, dispatches through the ledger facade ────
    // Story 4-1b — O1 carries ACME's own order number (the register's client_order_ref column).
    // Story 4-2a — and the order header fields: a two-line COD order, so the
    // register's ORDER-level cod_amount_paise repeats on both lines (A20).
    const o1 = await insertOrder(
      'O1',
      acme,
      at(2, 10),
      'dispatched',
      {
        consignee: ['Acme Retail LLP', '29ABCDE1234F1Z5'],
        clientOrderRef: 'SO-1042',
        orderType: 'b2b',
        priority: 'high',
        shipByDate: addIsoDays(D0, 3),
        codAmountPaise: 149900,
      },
      [['AC-PL', 2], ['AC-BT', 3]],
    );
    // Two dispatches of O1: the FIRST wins (carrier and AWB from its event).
    await dispatch(o1, wh1, at(3, 9), { carrierName: 'BlueDart', trackingNumber: 'BD-111' });
    await dispatch(o1, wh1, at(4, 9), { carrierName: 'Delhivery', trackingNumber: 'DL-999' });
    // …and TWO shipment rows (a manifested older one, a newer labelled one) — still one row per line.
    await shipment(o1.orderId, wh1, at(2, 18), 'manifested', 'OldCarrier', 'OLD-1');
    await shipment(o1.orderId, wh1, at(3, 8), 'labelled', 'NewCarrier', 'NEW-2');
    // O2: ingested; its dispatch event names no carrier — the latest shipment is the fallback.
    const o2 = await insertOrder('O2', acme, at(5, 10), 'dispatched', { externalEventId: 'SHOP-1001' }, [['AC-PL', 1]]);
    await dispatch(o2, wh1, at(5, 15), {});
    await shipment(o2.orderId, wh1, at(5, 12), 'labelled', 'Ekart', 'AWB-22');
    // …and an OLDER shipment: the fallback is the LATEST one.
    await shipment(o2.orderId, wh1, at(5, 11), 'manifested', 'OldEkart', 'AWB-OLD');
    // O3: BETA's, not dispatched.
    await insertOrder('O3', beta, at(6, 10), 'accepted', {}, [['BE-PL', 4]]);
    // O5: a kit order — the kit line and its two exploded components.
    await insertOrder('O5', acme, at(7, 10), 'accepted', {}, [['AC-KIT', 1], ['AC-PL', 2, 0], ['AC-BT', 1, 0]]);
    // O6 and O7 share ONE created_at.
    await insertOrder('O6', acme, at(8, 10), 'accepted', {}, [['AC-PL', 1]]);
    await insertOrder('O7', acme, at(8, 10), 'accepted', {}, [['AC-PL', 2]]);
    // O4: after the period.
    await insertOrder('O4', acme, at(10, 0), 'accepted', {}, [['AC-PL', 9]]);

    // ── the ledger's IST edges, in the second warehouse (raw events with a chosen created_at) ──
    await rawEvent(wh2, 1, at(9, 23, 59, 59), 'AC-PL', 1000);
    await rawEvent(wh2, 2, at(10, 0), 'AC-PL', 2000);
    // Three events sharing ONE created_at — the last names a GRN (its code is looked up).
    await rawEvent(wh2, 3, at(5, 10), 'AC-PL', 1000);
    await rawEvent(wh2, 4, at(5, 10), 'AC-PL', -1000);
    await rawEvent(wh2, 5, at(5, 10), 'AC-PL', 3000, { kind: 'grn-receipt', grnId: grnIds.get('GRN-0901')! });
  });

  afterAll(async () => {
    reporting.registerRead = (ctx) => REGISTERS[ctx.name].read(ctx);
    reporting.registerDeadlineMs = REGISTER_DEADLINE_MS;
    reporting.registerMaxRows = 50_000;
    await sql?.end();
    const appDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await appDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function signIn(email: string): Promise<string> {
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
  }

  async function createWarehouse(code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code, name: `${code} warehouse` })
        .expect(201)
    ).body.id as string;
  }

  async function createClient(code: string, name: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name })
        .expect(201)
    ).body.client.id as string;
  }

  async function importCsv(rows: string[], clientId: string): Promise<void> {
    const csv = ['sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode', ...rows].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .field('clientId', clientId)
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
  }

  async function invite(email: string, role: 'ops_manager' | 'client', clientId?: string): Promise<string> {
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role, ...(clientId === undefined ? {} : { clientId }) })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    return signIn(email);
  }

  async function adjust(body: {
    skuId: string;
    binId: string;
    quantityDelta: number;
    batch?: { code: string; mfgDate?: string; expiryDate?: string };
  }): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId: wh1, reasonCode: 'stock-count', note: 'register seed', ...body })
      .expect(201);
  }

  async function grn(
    code: string,
    createdAt: string,
    doc: { poId?: string; asnId?: string; gateInId?: string; blind?: string; clientId: string | null },
    lines: { sku: string; qty: number; applied: number; batchId?: string }[],
  ): Promise<void> {
    const grnId = uuidv7();
    grnIds.set(code, grnId);
    await sql`insert into goods_receipt_notes (id, tenant_id, warehouse_id, code, po_id, asn_id, client_id, blind_reason_code, gate_in_id, status, device_id, recorded_by, occurred_at, recorded_at, created_at, updated_at)
      values (${grnId}, ${tenantId}, ${wh1}, ${code}, ${doc.poId ?? null}, ${doc.asnId ?? null}, ${doc.clientId}, ${doc.blind ?? null}, ${doc.gateInId ?? null}, 'recorded', ${uuidv7()}, ${ownerUserId},
        ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt})`;
    for (const line of lines) {
      await sql`insert into goods_receipt_lines (id, tenant_id, grn_id, sku_id, batch_id, qty, applied_qty)
        values (${uuidv7()}, ${tenantId}, ${grnId}, ${sku.get(line.sku)!}, ${line.batchId ?? null}, ${line.qty * 1000}, ${line.applied * 1000})`;
    }
  }

  interface SeededOrder {
    readonly orderId: string;
    readonly lines: readonly { readonly id: string; readonly skuId: string; readonly qty: number }[];
  }

  async function insertOrder(
    name: string,
    clientId: string,
    createdAt: string,
    status: 'accepted' | 'dispatched',
    extra: {
      consignee?: [string, string];
      externalEventId?: string;
      clientOrderRef?: string;
      // Story 4-2a — the order header fields (the register's four last columns).
      orderType?: string;
      priority?: string;
      shipByDate?: string;
      codAmountPaise?: number;
    },
    lines: ([string, number] | [string, number, number])[],
  ): Promise<SeededOrder> {
    const orderId = uuidv7();
    const ingested = extra.externalEventId !== undefined;
    await sql`insert into orders (id, tenant_id, client_id, warehouse_id, status, source, integration_id, external_event_id,
        consignee_legal_name, consignee_gstin, destination_city, destination_state, destination_pincode, client_order_ref,
        order_type, priority, ship_by_date, cod_amount_paise, created_at, updated_at)
      values (${orderId}, ${tenantId}, ${clientId}, ${wh1}, ${status}, ${ingested ? 'ingested' : 'manual'}, ${ingested ? uuidv7() : null}, ${extra.externalEventId ?? null},
        ${extra.consignee?.[0] ?? null}, ${extra.consignee?.[1] ?? null}, 'Bengaluru', 'Karnataka', '560001', ${extra.clientOrderRef ?? null},
        ${extra.orderType ?? null}, ${extra.priority ?? 'normal'}, ${extra.shipByDate ?? null}, ${extra.codAmountPaise ?? null}, ${createdAt}, ${createdAt})`;
    const seeded: { id: string; skuId: string; qty: number }[] = [];
    for (const [code, qty, parent] of lines) {
      const id = uuidv7();
      const parentLineId = parent === undefined ? null : seeded[parent]!.id;
      await sql`insert into order_lines (id, tenant_id, order_id, sku_id, qty, parent_line_id, created_at, updated_at)
        values (${id}, ${tenantId}, ${orderId}, ${sku.get(code)!}, ${qty * 1000}, ${parentLineId}, ${createdAt}, ${createdAt})`;
      seeded.push({ id, skuId: sku.get(code)!, qty });
    }
    order.set(name, orderId);
    return { orderId, lines: seeded };
  }

  async function dispatch(seeded: SeededOrder, warehouseId: string, recordedAt: string, carrier: { carrierName?: string; trackingNumber?: string }): Promise<void> {
    await withTenantTransaction(db, tenantId, async (tx) => {
      for (const line of seeded.lines) {
        await inventory.appendLedgerEventInTx(tx, {
          tenantId,
          warehouseId,
          type: 'dispatch.dispatched',
          skuId: line.skuId,
          quantityDelta: 0 as SignedQuantity,
          fromBinId: null,
          toBinId: null,
          batchRef: null,
          serialRef: null,
          actorUserId: ownerUserId,
          occurredAt: recordedAt,
          recordedAt,
          referenceDoc: { kind: 'dispatch', orderId: seeded.orderId, orderLineId: line.id, dispatchedQty: line.qty, ...carrier },
        });
      }
    });
  }

  async function shipment(orderId: string, warehouseId: string, labelledAt: string, status: 'labelled' | 'manifested', carrierName: string, trackingNumber: string): Promise<void> {
    await sql`insert into shipments (id, tenant_id, warehouse_id, order_id, status, carrier_connection_id, carrier_code, carrier_name, tracking_number, label_document_ref,
        labelled_by, labelled_at, manifest_id, created_at, updated_at)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${orderId}, ${status}, ${uuidv7()}, 'manual', ${carrierName}, ${trackingNumber}, 'label://seed',
        ${ownerUserId}, ${labelledAt}, ${status === 'manifested' ? uuidv7() : null}, ${labelledAt}, ${labelledAt})`;
  }

  /** A raw ledger event with a chosen `created_at` (the append path stamps `now()`): the window's edges. */
  async function rawEvent(warehouseId: string, seq: number, createdAt: string, skuCode: string, milli: number, referenceDoc?: Record<string, string>): Promise<void> {
    await sql`insert into ledger_events (id, tenant_id, client_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta, from_bin_id, to_bin_id,
        batch_ref, serial_ref, actor_user_id, occurred_at, recorded_at, reference_doc, prev_hash, event_hash, created_at)
      values (${uuidv7()}, ${tenantId}, ${acme}, ${warehouseId}, ${seq}, 'stock.adjusted', 1, ${sku.get(skuCode)!}, ${milli}, null, ${uuidv7()},
        null, null, ${ownerUserId}, ${createdAt}, ${createdAt}, ${sql.json(referenceDoc ?? { kind: 'manual-adjustment', reasonCode: 'stock-count', note: `edge ${seq}` })}, 'seed', ${`seed-${seq}`}, ${createdAt})`;
  }

  function download(report: string, query: string, token = opsToken, warehouseId = wh1) {
    return http().get(`${API}/${tenantId}/warehouses/${warehouseId}/reports/${report}?${query}`).set('Authorization', `Bearer ${token}`);
  }

  async function csv(report: RegisterName, query: string, warehouseId = wh1): Promise<{ header: string[]; rows: string[][]; text: string }> {
    const res = await download(report, `format=csv&${query}`, opsToken, warehouseId).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[A-Za-z0-9_.-]+"$/);
    const text = res.text;
    const [header, ...rows] = parseCsv(text);
    return { header: header!, rows, text };
  }

  async function xlsx(report: RegisterName, query: string): Promise<Workbook> {
    const res = await download(report, `format=xlsx&${query}`).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-type']).toBe(XLSX);
    const workbook = new Workbook();
    await workbook.xlsx.load(res.body as Parameters<Workbook['xlsx']['load']>[0]);
    return workbook;
  }

  const period = (p: { from: string; to: string }) => `from=${p.from}&to=${p.to}`;
  const istDaysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

  // ── the header goldens ─────────────────────────────────────────────────────

  it('every register: the header golden (and the registry names exactly the five)', () => {
    const headers = Object.fromEntries(Object.entries(REGISTERS).map(([name, def]) => [name, def.columns.map((c) => `${c.header}:${c.kind}`)]));
    expect(headers).toEqual({
      'stock-on-hand': [
        'warehouse:text', 'zone:text', 'bin:text', 'system_bin:text', 'sku_code:text', 'sku_name:text', 'hsn:text', 'client_code:text',
        'uom:text', 'batch_code:text', 'expiry_date:date', 'quantity:number',
      ],
      'inbound-register': [
        'grn_code:text', 'created_ist:instant', 'recorded_ist:instant', 'document:text', 'vendor_name:text', 'client_code:text', 'gate_in_code:text',
        'supplier_documents:text', 'supplier_document_dates:text', 'eway_bill_numbers:text', 'sku_code:text', 'sku_name:text', 'uom:text',
        'batch_code:text', 'qty:number', 'applied_qty:number', 'recorded_by:text',
      ],
      'outbound-register': [
        'order_id:text', 'created_ist:instant', 'status:text', 'source:text', 'channel_order_ref:text', 'client_code:text',
        'consignee_legal_name:text', 'consignee_gstin:text', 'destination_city:text', 'destination_state:text', 'destination_pincode:text',
        'sku_code:text', 'sku_name:text', 'kit_of:text', 'uom:text', 'ordered_qty:number', 'first_dispatched_ist:instant', 'carrier:text', 'awb:text', 'client_order_ref:text',
        // Story 4-2a (A20) — the order header fields, appended at the END.
        'order_type:text', 'priority:text', 'ship_by_date:date', 'cod_amount_paise:number',
        // Story 4-2c — the backorder link, appended at the END.
        'follow_on_of_order_id:text', 'follow_on_seq:number',
      ],
      ledger: [
        'created_ist:instant', 'recorded_ist:instant', 'occurred_ist:instant', 'type:text', 'sku_code:text', 'client_code:text', 'uom:text',
        'from_bin:text', 'to_bin:text', 'batch_code:text', 'quantity:number', 'reference:text', 'actor:text',
      ],
      'batch-ageing': [
        'sku_code:text', 'sku_name:text', 'client_code:text', 'bin:text', 'batch_code:text', 'mfg_date:date', 'expiry_date:date',
        'days_to_expiry:number', 'batch_created_ist:instant', 'days_since_batch_created:number', 'uom:text', 'quantity:number',
      ],
    });
  });

  // ── stock on hand ──────────────────────────────────────────────────────────

  it('stock CSV: the whole file byte for byte — BOM, one row per bin × batch and per untracked bin, IST expiry dates, system bins flagged and last', async () => {
    const res = await download('stock-on-hand', 'format=csv').expect(200);
    const W = wh1Code;
    expect(res.text).toBe(
      `${UTF8_BOM}warehouse,zone,bin,system_bin,sku_code,sku_name,hsn,client_code,uom,batch_code,expiry_date,quantity\r\n` +
        `${W},A,A-01-01,no,AC-BT,Acme Pills,3004,ACME,each,B1,${EXPIRY_B1},5\r\n` +
        `${W},A,A-01-01,no,AC-PL,Acme Plain,,ACME,each,,,1\r\n` +
        `${W},A,A-01-02,no,AC-BT,Acme Pills,3004,ACME,each,B2,${EXPIRY_B2},4\r\n` +
        `${W},A,A-01-02,no,AC-PL,Acme Plain,,ACME,each,,,3\r\n` +
        `${W},A,A-01-03,no,AC-BT,Acme Pills,3004,ACME,each,B3,,2\r\n` +
        `${W},A,A-01-03,no,BE-PL,Beta Plain,,BETA,each,,,7\r\n` +
        `${W},A,RECEIVING,yes,AC-PL,Acme Plain,,ACME,each,,,2\r\n`,
    );
  });

  it('stock: the batch SKU is never double-counted — its file total equals batch_on_hand, and both projections hold it', async () => {
    const { rows } = await csv('stock-on-hand', '');
    const total = rows.filter((r) => r[4] === 'AC-BT').reduce((sum, r) => sum + Number(r[11]), 0);
    const [batchSum] = await sql`select coalesce(sum(quantity), 0)::text as n from batch_on_hand where tenant_id = ${tenantId} and sku_id = ${sku.get('AC-BT')!}`;
    const [plainSum] = await sql`select coalesce(sum(quantity), 0)::text as n from stock_on_hand where tenant_id = ${tenantId} and sku_id = ${sku.get('AC-BT')!}`;
    // Meaningful: the plain projection holds the batch SKU too — a union of both arms would print 22.
    expect({ total, batch: Number(batchSum!.n) / 1000, plain: Number(plainSum!.n) / 1000 }).toEqual({ total: 11, batch: 11, plain: 11 });
  });

  it('stock as Excel for ACME (the acceptance): only ACME bin × batch rows, HSN, IST expiry date cells, totals = on hand', async () => {
    const workbook = await xlsx('stock-on-hand', `clientId=${acme}`);
    expect(workbook.worksheets).toHaveLength(1);
    const sheet = workbook.worksheets[0]!;
    const values = (n: number) => (sheet.getRow(n).values as unknown[]).slice(1);
    expect(values(1)).toEqual(REGISTERS['stock-on-hand'].columns.map((c) => c.header));
    expect(sheet.rowCount).toBe(7);
    const rows = [2, 3, 4, 5, 6, 7].map(values);
    expect(rows.map((r) => [r[2], r[3], r[4], r[6], r[7], r[9], r[11]])).toEqual([
      ['A-01-01', 'no', 'AC-BT', '3004', 'ACME', 'B1', 5],
      ['A-01-01', 'no', 'AC-PL', undefined, 'ACME', undefined, 1],
      ['A-01-02', 'no', 'AC-BT', '3004', 'ACME', 'B2', 4],
      ['A-01-02', 'no', 'AC-PL', undefined, 'ACME', undefined, 3],
      ['A-01-03', 'no', 'AC-BT', '3004', 'ACME', 'B3', 2],
      ['RECEIVING', 'yes', 'AC-PL', undefined, 'ACME', undefined, 2],
    ]);
    // A date cell whose (UTC-field) value is the IST calendar date — never the UTC day before.
    const expiry = rows[0]![10] as Date;
    expect(expiry).toBeInstanceOf(Date);
    expect(expiry.toISOString()).toBe(`${EXPIRY_B1}T00:00:00.000Z`);
    expect(sheet.getRow(2).getCell(11).numFmt).toBe('yyyy-mm-dd');
    const [onHand] = await sql`select coalesce(sum(s.quantity), 0)::text as n from stock_on_hand s join skus k on k.id = s.sku_id
      where s.tenant_id = ${tenantId} and s.warehouse_id = ${wh1} and k.client_id = ${acme}`;
    expect(rows.reduce((sum, r) => sum + (r[11] as number), 0)).toBe(Number(onHand!.n) / 1000);
  });

  // ── inbound ────────────────────────────────────────────────────────────────

  it('inbound CSV: GRN lines in the IST period — document, vendor, gate-in and LINKED documents only (aligned), IST times, display names', async () => {
    const { rows, text } = await csv('inbound-register', period(P));
    const t = (iso: string) => istWallClock(iso);
    const blind = (code: string, when: string, reason: string, client: string, skuCode: string, name: string, qty: string) =>
      [code, t(when), t(when), `blind:${reason}`, '', client, '', '', '', '', skuCode, name, 'each', '', qty, qty, ownerName];
    expect(rows).toEqual([
      ['GRN-0901', t(at(2, 10)), t(at(2, 10)), `po:${po1.code}`, 'Acme Supplies', 'ACME', gateIn.code, 'invoice INV-77', addIsoDays(D0, 1), '123456789012', 'AC-PL', 'Acme Plain', 'each', '', '10', '10', ownerName],
      ['GRN-0901', t(at(2, 10)), t(at(2, 10)), `po:${po1.code}`, 'Acme Supplies', 'ACME', gateIn.code, 'invoice INV-77', addIsoDays(D0, 1), '123456789012', 'AC-BT', 'Acme Pills', 'each', 'B1', '6', '5', ownerName],
      blind('GRN-0902', at(3, 11), 'other', 'ACME', 'AC-PL', 'Acme Plain', '4'),
      blind('GRN-0902', at(3, 11), 'other', 'BETA', 'BE-PL', 'Beta Plain', '2'),
      blind('GRN-0903', at(4, 9), 'unannounced-delivery', 'BETA', 'BE-PL', 'Beta Plain', '3'),
      // The ASN receipt: its two ASN-linked documents, the e-way slot `-` where the challan has none.
      ['GRN-0908', t(at(5, 9)), t(at(5, 9)), `asn:${asn1.code}`, '', 'ACME', gateIn.code, 'invoice INV-88; challan CH-ASN', `${addIsoDays(D0, 2)}; ${addIsoDays(D0, 2)}`, '999988887777; -', 'AC-PL', 'Acme Plain', 'each', '', '3', '3', ownerName],
      blind('GRN-0906', at(6, 12), 'other', 'ACME', 'AC-PL', 'Acme Plain', '1'),
      blind('GRN-0907', at(6, 12), 'other', 'ACME', 'AC-PL', 'Acme Plain', '2'),
      blind('GRN-0904', at(9, 23, 59, 59), 'other', 'ACME', 'AC-PL', 'Acme Plain', '1'),
    ]);
    // The IST edges: 23:59:59 on `to` is in (it printed); 00:00 the day after and the day before `from` are out.
    expect(rows[8]![1]).toBe(`${addIsoDays(D0, 9)} 23:59:59`);
    expect(text).not.toContain('GRN-0905');
    expect(text).not.toContain('GRN-0900');
    expect(text).not.toContain('CH-9');
    expect(text).not.toContain('@');
  });

  it('inbound for ACME: the blind GRN with a NULL client is attributed through its ACME line; BETA’s lines never appear', async () => {
    const { rows } = await csv('inbound-register', `${period(P)}&clientId=${acme}`);
    expect(rows.map((r) => [r[0], r[5], r[10]])).toEqual([
      ['GRN-0901', 'ACME', 'AC-PL'],
      ['GRN-0901', 'ACME', 'AC-BT'],
      ['GRN-0902', 'ACME', 'AC-PL'],
      ['GRN-0908', 'ACME', 'AC-PL'],
      ['GRN-0906', 'ACME', 'AC-PL'],
      ['GRN-0907', 'ACME', 'AC-PL'],
      ['GRN-0904', 'ACME', 'AC-PL'],
    ]);
    const beta = await csv('inbound-register', `${period(P)}&clientId=${betaId()}`);
    expect(beta.rows.map((r) => [r[0], r[5]])).toEqual([
      ['GRN-0902', 'BETA'],
      ['GRN-0903', 'BETA'],
    ]);
  });

  let opsId: string | undefined;
  function opsUserId(): string {
    return opsId!;
  }

  function betaId(): string {
    return beta;
  }

  it('inbound as Excel: a valid workbook parsed back — typed cells, IST date-time cells', async () => {
    const workbook = await xlsx('inbound-register', period(P));
    const sheet = workbook.worksheets[0]!;
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(REGISTERS['inbound-register'].columns.map((c) => c.header));
    expect(sheet.rowCount).toBe(10);
    const first = sheet.getRow(2);
    const recorded = first.getCell(3).value as Date;
    expect(recorded).toBeInstanceOf(Date);
    // exceljs reads the cell's fields as UTC: they hold the IST wall clock.
    expect(recorded.toISOString()).toBe(`${addIsoDays(D0, 2)}T10:00:00.000Z`);
    expect(first.getCell(3).numFmt).toBe('yyyy-mm-dd hh:mm:ss');
    expect(first.getCell(15).value).toBe(10);
    expect(first.getCell(16).value).toBe(10);
    expect(first.getCell(1).value).toBe('GRN-0901');
  });

  // ── outbound ───────────────────────────────────────────────────────────────

  it('outbound CSV: one row per line (two shipment rows never duplicate one); the FIRST dispatch; the LATEST shipment as the fallback pair; kit components', async () => {
    const { rows } = await csv('outbound-register', period(P));
    const o1 = order.get('O1')!;
    const o2 = order.get('O2')!;
    const o3 = order.get('O3')!;
    const o5 = order.get('O5')!;
    const first = istWallClock(at(3, 9));
    const accepted = (id: string, when: string, client: string, skuCode: string, name: string, kitOf: string, qty: string) =>
      // (Story 4-2a: a legacy-shaped row — no type, priority normal, no ship-by, prepaid.)
      [id, istWallClock(when), 'accepted', 'manual', '', client, '', '', 'Bengaluru', 'Karnataka', '560001', skuCode, name, kitOf, 'each', qty, '', '', '', '', '', 'normal', '', '', '', ''];
    expect(rows).toEqual([
      // Story 4-1b — the client order number is the LAST column.
      // Story 4-2a (A20) — the four order fields last; the ORDER-level COD
      // (paise) repeated on BOTH lines of the two-line order. Story 4-2c —
      // the two backorder-link columns after them (blank: no follow-on here;
      // a follow-on's are pinned in test/order-follow-on.spec.ts).
      [o1, istWallClock(at(2, 10)), 'dispatched', 'manual', '', 'ACME', 'Acme Retail LLP', '29ABCDE1234F1Z5', 'Bengaluru', 'Karnataka', '560001', 'AC-PL', 'Acme Plain', '', 'each', '2', first, 'BlueDart', 'BD-111', 'SO-1042', 'b2b', 'high', addIsoDays(D0, 3), '149900', '', ''],
      [o1, istWallClock(at(2, 10)), 'dispatched', 'manual', '', 'ACME', 'Acme Retail LLP', '29ABCDE1234F1Z5', 'Bengaluru', 'Karnataka', '560001', 'AC-BT', 'Acme Pills', '', 'each', '3', first, 'BlueDart', 'BD-111', 'SO-1042', 'b2b', 'high', addIsoDays(D0, 3), '149900', '', ''],
      // The dispatch event named no carrier: the LATEST shipment's pair (never the older one's).
      [o2, istWallClock(at(5, 10)), 'dispatched', 'ingested', 'SHOP-1001', 'ACME', '', '', 'Bengaluru', 'Karnataka', '560001', 'AC-PL', 'Acme Plain', '', 'each', '1', istWallClock(at(5, 15)), 'Ekart', 'AWB-22', '', '', 'normal', '', '', '', ''],
      accepted(o3, at(6, 10), 'BETA', 'BE-PL', 'Beta Plain', '', '4'),
      accepted(o5, at(7, 10), 'ACME', 'AC-KIT', 'Acme Kit', '', '1'),
      accepted(o5, at(7, 10), 'ACME', 'AC-PL', 'Acme Plain', 'AC-KIT', '2'),
      accepted(o5, at(7, 10), 'ACME', 'AC-BT', 'Acme Pills', 'AC-KIT', '1'),
      accepted(order.get('O6')!, at(8, 10), 'ACME', 'AC-PL', 'Acme Plain', '', '1'),
      accepted(order.get('O7')!, at(8, 10), 'ACME', 'AC-PL', 'Acme Plain', '', '2'),
    ]);
    const acmeOnly = await csv('outbound-register', `${period(P)}&clientId=${acme}`);
    expect(acmeOnly.rows.map((r) => r[0])).toEqual([o1, o1, o2, o5, o5, o5, order.get('O6')!, order.get('O7')!]);
  });

  it('the first-dispatch lookup states reference_doc ? \'orderId\': the REAL query plans on ledger_events_order_ref_idx', async () => {
    const plan = await withTenantTransaction(db, tenantId, async (tx) => {
      // The fixture is tiny; with seq scans priced out, a plan can use the
      // partial index only if the query implies its predicate.
      await tx.execute(dsql`set local enable_seqscan = off`);
      const rows = (await tx.execute(dsql`explain ${firstDispatchQuery(tenantId, [order.get('O1')!, order.get('O2')!])}`)) as unknown as Record<string, string>[];
      return rows.map((row) => Object.values(row)[0]).join('\n');
    });
    expect(plan).toContain('ledger_events_order_ref_idx');
    // And the facade answers the first event of each order.
    const found = await withTenantTransaction(db, tenantId, (tx) => inventory.firstDispatchByOrderInTx(tx, tenantId, [order.get('O1')!, order.get('O3')!]));
    expect([...found.values()]).toEqual([{ orderId: order.get('O1')!, dispatchedAt: at(3, 9), carrierName: 'BlueDart', trackingNumber: 'BD-111' }]);
  });

  // ── the keyset walks, one row per page, over created_at ties ───────────────

  it('page size 1: inbound, outbound and ledger walk every row exactly once, in order, across rows sharing a created_at', async () => {
    const window = { from: istMidnightOf(P.from), to: istMidnightOf(addIsoDays(P.to, 1)) };
    const inbound = app.get(InboundFacade);
    const outbound = app.get(OutboundFacade);
    await withTenantTransaction(db, tenantId, async (tx) => {
      const scope = { tenantId, warehouseId: wh1, clientId: null, ...window };
      const keyOf = (r: { grnCode: string; skuId: string; qty: number }) => `${r.grnCode}:${r.skuId}:${r.qty}`;
      const inAll = (await inbound.inboundRegisterInTx(tx, scope, 1000)).map(keyOf);
      const inOne = (await inbound.inboundRegisterInTx(tx, scope, 1000, 1)).map(keyOf);
      expect(inOne).toEqual(inAll);
      expect(new Set(inOne).size).toBe(inOne.length);
      expect(inOne.filter((k) => k.startsWith('GRN-0906') || k.startsWith('GRN-0907'))).toHaveLength(2);

      const outAll = (await outbound.outboundRegisterInTx(tx, scope, 1000)).map((r) => r.lineId);
      const outOne = (await outbound.outboundRegisterInTx(tx, scope, 1000, 1)).map((r) => r.lineId);
      expect(outOne).toEqual(outAll);
      expect(new Set(outOne).size).toBe(outOne.length);
      expect(outOne).toHaveLength(9);

      const ledgerScope = { tenantId, warehouseId: wh2, clientId: null, ...window };
      const ledAll = (await inventory.ledgerRegisterInTx(tx, ledgerScope, 1000)).map((r) => r.id);
      const ledOne = (await inventory.ledgerRegisterInTx(tx, ledgerScope, 1000, 1)).map((r) => r.id);
      expect(ledOne).toEqual(ledAll);
      expect(new Set(ledOne).size).toBe(4); // three tied at day 5, plus the 23:59:59 edge
    });
  });

  // ── the ledger ─────────────────────────────────────────────────────────────

  it('ledger CSV over 30 days (the acceptance): every event in range once, IST times, signed numeric quantities, actor names — no emails', async () => {
    const window = { from: addIsoDays(today, -29), to: today };
    const { rows, text } = await csv('ledger', period(window));
    const [count] = await sql`select count(*)::int as n from ledger_events where tenant_id = ${tenantId} and warehouse_id = ${wh1}
      and created_at >= ${istMidnightOf(window.from)} and created_at < ${istMidnightOf(addIsoDays(window.to, 1))}`;
    expect(rows).toHaveLength(Number(count!.n));
    expect(rows.length).toBe(13); // eight adjustments + five dispatch events (O1 twice × 2 lines, O2 once)
    const adjustments = rows.filter((r) => r[3] === 'stock.adjusted');
    const seed = 'adjustment stock-count — register seed';
    expect(adjustments.map((r) => [r[4], r[5], r[8], r[9], r[10], r[11], r[12]])).toEqual([
      ['AC-PL', 'ACME', 'A-01-01', '', '2', seed, opsName],
      ['AC-PL', 'ACME', 'A-01-02', '', '3', seed, opsName],
      ['AC-BT', 'ACME', 'A-01-01', 'B1', '5', seed, opsName],
      ['AC-BT', 'ACME', 'A-01-02', 'B2', '4', seed, opsName],
      ['BE-PL', 'BETA', 'A-01-03', '', '7', seed, opsName],
      // The draw: a negative NUMBER — never the formula-guarded text `'-1`.
      ['AC-PL', 'ACME', '', '', '-1', seed, opsName],
      ['AC-BT', 'ACME', 'A-01-03', 'B3', '2', seed, opsName],
      ['AC-PL', 'ACME', 'RECEIVING', '', '2', 'adjustment stock-count — receiving seed', ownerName],
    ]);
    expect(adjustments[5]![7]).toBe('A-01-01');
    for (const row of rows) expect(row[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const dispatches = rows.filter((r) => r[3] === 'dispatch.dispatched');
    expect(dispatches).toHaveLength(5);
    expect(dispatches[0]![1]).toBe(istWallClock(at(3, 9)));
    expect(dispatches.map((r) => r[11])).toContain(`dispatch order ${order.get('O1')!} · BlueDart BD-111`);
    expect(dispatches.every((r) => r[12] === ownerName)).toBe(true);
    expect(text).not.toContain('@');
    expect(text).not.toContain("'-1");
  });

  it('negative quantity: the ledger as Excel holds the number −1, never the text', async () => {
    const workbook = await xlsx('ledger', period({ from: addIsoDays(today, -29), to: today }));
    const sheet = workbook.worksheets[0]!;
    const quantities: unknown[] = [];
    sheet.eachRow((row, n) => {
      if (n > 1) quantities.push(row.getCell(11).value);
    });
    expect(quantities).toContain(-1);
    expect(quantities.every((q) => typeof q === 'number')).toBe(true);
  });

  it('ledger IST boundary and a grn-receipt reference: 23:59:59 IST on `to` is in, 00:00 the day after is out; the GRN is named by code', async () => {
    const { rows } = await csv('ledger', period(P), wh2);
    expect(rows.map((r) => [r[0], r[10], r[11]])).toEqual([
      [istWallClock(at(5, 10)), '1', 'adjustment stock-count — edge 3'],
      [istWallClock(at(5, 10)), '-1', 'adjustment stock-count — edge 4'],
      [istWallClock(at(5, 10)), '3', 'receipt GRN GRN-0901'],
      [`${addIsoDays(D0, 9)} 23:59:59`, '1', 'adjustment stock-count — edge 1'],
    ]);
    const next = await csv('ledger', period({ from: addIsoDays(D0, 10), to: addIsoDays(D0, 10) }), wh2);
    expect(next.rows.map((r) => r[11])).toEqual(['adjustment stock-count — edge 2']);
  });

  // ── batch ageing ───────────────────────────────────────────────────────────

  it('batch ageing: bin × batch with stock, expiry first, no expiry last, IST dates, days to expiry and since the batch first appeared in the tenant', async () => {
    const { rows } = await csv('batch-ageing', '');
    const [created] = await sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at from batches where id = ${batchB1}`;
    const createdAt = created!.at as string;
    expect(rows.map((r) => [r[0], r[2], r[3], r[4], r[5], r[6], r[7], r[9], r[10], r[11]])).toEqual([
      ['AC-BT', 'ACME', 'A-01-02', 'B2', '', EXPIRY_B2, String(istDaysBetween(today, EXPIRY_B2)), '0', 'each', '4'],
      ['AC-BT', 'ACME', 'A-01-01', 'B1', MFG_B1, EXPIRY_B1, String(istDaysBetween(today, EXPIRY_B1)), String(istDaysBetween(istDateOf(createdAt), today)), 'each', '5'],
      // No expiry: last, and no days to expiry (an empty cell, never 0).
      ['AC-BT', 'ACME', 'A-01-03', 'B3', '', '', '', '0', 'each', '2'],
    ]);
    expect(rows[1]![8]).toBe(istWallClock(createdAt));
    expect((await csv('batch-ageing', `clientId=${beta}`)).rows).toEqual([]);
  });

  // ── isolation, the client filter and the refusals ───────────────────────────

  it('isolation per register: BETA’s file holds only BETA rows; an unknown client is an empty file; a malformed one 400', async () => {
    const cases: [RegisterName, string, number][] = [
      ['stock-on-hand', '', 7],
      ['inbound-register', period(P), 5],
      ['outbound-register', period(P), 5],
      ['ledger', period({ from: addIsoDays(today, -29), to: today }), 5],
    ];
    for (const [report, query, clientColumn] of cases) {
      const { rows } = await csv(report, `${query}${query === '' ? '' : '&'}clientId=${beta}`);
      expect({ report, clients: [...new Set(rows.map((r) => r[clientColumn]))] }).toEqual({ report, clients: ['BETA'] });
      const unknown = await download(report, `format=csv&${query}${query === '' ? '' : '&'}clientId=${uuidv7()}`).expect(200);
      expect(unknown.headers['content-disposition']).toContain('-client-unknown-');
      const [header, ...rows2] = parseCsv(unknown.text);
      expect({ report, rows: rows2 }).toEqual({ report, rows: [] });
      expect(header).toEqual(REGISTERS[report].columns.map((c) => c.header));
    }
    // An upper-case uuid is the same client (ids are compared lower-case).
    const upper = await csv('stock-on-hand', `clientId=${beta.toUpperCase()}`);
    expect(upper.rows.map((r) => r[7])).toEqual(['BETA']);
    expect((await download('stock-on-hand', 'format=csv&clientId=nope').expect(400)).body.code).toBe('validation-failed');
  });

  it('refusals before any header: 400 shape and period, 404 unknown-warehouse, 403 portal and another tenant — all problem+json', async () => {
    const problems: [string, string, number, string][] = [
      ['stock-on-hand', '', 400, 'validation-failed'], // no format
      ['stock-on-hand', 'format=pdf', 400, 'validation-failed'],
      ['nonsense', 'format=csv', 400, 'validation-failed'],
      ['stock-on-hand', `format=csv&${period(P)}`, 400, 'validation-failed'], // a snapshot takes no period
      ['ledger', 'format=csv', 400, 'validation-failed'], // a dated register needs one
      ['ledger', 'format=csv&from=2026-02-31&to=2026-03-01', 400, 'validation-failed'],
      ['ledger', 'format=csv&from=2025-01-01&to=2026-01-02', 400, 'validation-failed'], // 367 days
    ];
    for (const [report, query, status, code] of problems) {
      const res = await download(report, query);
      expect({ report, query, status: res.status, code: res.body.code, type: res.headers['content-type'] }).toEqual({
        report,
        query,
        status,
        code,
        type: expect.stringMatching(/^application\/problem\+json/),
      });
    }
    expect((await download('ledger', `format=csv&${period(P)}`, opsToken, uuidv7()).expect(404)).body.code).toBe('unknown-warehouse');
    expect((await download('ledger', `format=csv&${period(P)}`, opsToken, 'not-a-uuid').expect(400)).body.code).toBe('validation-failed');
    expect((await download('stock-on-hand', 'format=csv', portalToken).expect(403)).body.code).toBe('role-denied');
    // Another tenant's session on this tenant's path.
    const otherEmail = `other-${ulid().toLowerCase()}@example.com`;
    await http().post(API).set(KEY_HEADER, ulid()).send({ name: `Other 3PL ${ulid()}`, ownerEmail: otherEmail, password: PASSWORD }).expect(201);
    const otherToken = await signIn(otherEmail);
    expect((await download('stock-on-hand', 'format=csv', otherToken).expect(403)).body.code).toBe('permission-denied');
  });

  it('too large: the row past the cap is 422 report-too-large (advice per register, the cap in the problem), no partial file; the cap itself is admitted', async () => {
    reporting.registerMaxRows = 7;
    try {
      // Seven stock rows: exactly the cap.
      expect((await csv('stock-on-hand', '')).rows).toHaveLength(7);
      reporting.registerMaxRows = 6;
      const res = await download('stock-on-hand', 'format=xlsx').expect(422);
      expect(res.body.code).toBe('report-too-large');
      expect(res.body.maxRows).toBe(6);
      // A snapshot has no period to shorten.
      expect(res.body.detail).toBe('The stock-on-hand register has more than 6 rows — pick a client.');
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      reporting.registerMaxRows = 3;
      const dated = await download('inbound-register', `format=csv&${period(P)}`).expect(422);
      expect(dated.body.detail).toBe('The inbound-register register has more than 3 rows — pick a client or a shorter period.');
    } finally {
      reporting.registerMaxRows = 50_000;
    }
  });

  it('busy: with every slot held, a register is 503 report-unavailable (Retry-After) before it reads anything', async () => {
    let reads = 0;
    reporting.registerRead = async (ctx) => {
      reads += 1;
      return REGISTERS[ctx.name].read(ctx);
    };
    const held: boolean[] = [];
    try {
      for (let i = 0; i < REGISTER_CONCURRENCY; i += 1) held.push(reporting.registerSlots.tryAcquire());
      expect(held).toEqual([true, true]);
      const res = await download('stock-on-hand', 'format=csv').expect(503);
      expect(res.body.code).toBe('report-unavailable');
      expect(res.headers['retry-after']).toBe('5');
      expect(reads).toBe(0);
    } finally {
      for (const ok of held) if (ok) reporting.registerSlots.release();
      reporting.registerRead = (ctx) => REGISTERS[ctx.name].read(ctx);
    }
    // Freed: the slot was released by the refusal path too.
    expect(reporting.registerSlots.inFlight).toBe(0);
    await download('stock-on-hand', 'format=csv').expect(200);
    expect(reporting.registerSlots.inFlight).toBe(0);
  });

  it('slow: one repeatable-read, read-only transaction under a WHOLE-read deadline re-armed per statement; past it, 503 with nothing partial', async () => {
    const setting = async (tx: Parameters<typeof reporting.registerRead>[0]['tx'], name: string): Promise<string> =>
      (((await tx.execute(dsql`select setting as v from pg_settings where name = ${name}`)) as unknown as { v: string }[])[0]!.v);
    let observed: Record<string, unknown> = {};
    reporting.registerRead = async (ctx) => {
      const armed = Number(await setting(ctx.tx, 'statement_timeout'));
      const deadlineAt = txDeadlineOf(ctx.tx)!;
      const rows = await REGISTERS[ctx.name].read(ctx);
      const rearmed = Number(await setting(ctx.tx, 'statement_timeout'));
      observed = {
        armed: armed > 0 && armed <= REGISTER_DEADLINE_MS,
        // Re-armed to the time LEFT before each statement — never back to a fresh 15 s.
        rearmedWithinBudget: rearmed > 0 && rearmed < armed && rearmed <= deadlineAt - Date.now() + 50,
        isolation: await setting(ctx.tx, 'transaction_isolation'),
        readOnly: await setting(ctx.tx, 'transaction_read_only'),
      };
      return rows;
    };
    try {
      await download('ledger', `format=csv&${period(P)}`).expect(200);
      expect(observed).toEqual({ armed: true, rearmedWithinBudget: true, isolation: 'repeatable read', readOnly: 'on' });

      // The facade's own deadline, shrunk: a statement that outlives it is 57014 → 503.
      reporting.registerDeadlineMs = 200;
      reporting.registerRead = async (ctx) => {
        await ctx.tx.execute(dsql`select pg_sleep(2)`);
        throw new Error('unreachable');
      };
      for (const format of ['csv', 'xlsx']) {
        const res = await download('ledger', `format=${format}&${period(P)}`);
        expect({ status: res.status, code: res.body.code, type: res.headers['content-type'], retry: res.headers['retry-after'] }).toEqual({
          status: 503,
          code: 'report-unavailable',
          type: expect.stringMatching(/^application\/problem\+json/),
          retry: '5',
        });
      }
    } finally {
      reporting.registerDeadlineMs = REGISTER_DEADLINE_MS;
      reporting.registerRead = (ctx) => REGISTERS[ctx.name].read(ctx);
    }
    expect(reporting.registerSlots.inFlight).toBe(0);
  });
  // ── the writers ────────────────────────────────────────────────────────────

  it('the CSV writer: text through the formula guard, numbers raw; the audit export re-exports the same cell and BOM', () => {
    const file = buildCsv(
      [
        { header: 'note', kind: 'text' },
        { header: 'quantity', kind: 'number' },
      ],
      [
        ['=HYPERLINK("x")', -5],
        ['a,b', 0.125],
        [null, null],
      ],
    ).toString('utf8');
    expect(file).toBe(`${UTF8_BOM}note,quantity\r\n"'=HYPERLINK(""x"")",-5\r\n"a,b",0.125\r\n,\r\n`);
    expect(() => buildCsv([{ header: 'q', kind: 'number' }], [['5']])).toThrow(TypeError);
    // The audit export's helpers are the shared ones (its own suite pins its bytes).
    expect(auditCsvCell).toBe(csvCell);
    expect(AUDIT_BOM).toBe(UTF8_BOM);
    expect(
      auditCsvLine({
        createdAt: '2026-10-13T08:33:07.412Z',
        occurredAt: '2026-10-13T08:33:07.412Z',
        actorUserId: ownerUserId,
        actorEmail: 'x@example.com',
        action: '-danger',
        targetType: 'order',
        targetId: 'id',
      }),
    ).toBe(`2026-10-13T14:03:07.412+05:30,2026-10-13T14:03:07.412+05:30,user,${ownerUserId},x@example.com,'-danger,order,id\r\n`);
  });

  it('display names: the local part, never an email; two members sharing one get a -user-<tail> suffix; an empty one, an unknown id and the system actor', async () => {
    const twin = uuidv7();
    const blank = uuidv7();
    const missing = uuidv7();
    await sql`insert into users (id, tenant_id, email, password_hash, role, status) values
      (${twin}, ${tenantId}, ${`${ownerName}@twin.example`}, 'x', 'operator', 'active'),
      (${blank}, ${tenantId}, ${`@blank-${ulid().toLowerCase()}.example`}, 'x', 'operator', 'active')`;
    try {
      const names = await withTenantTransaction(db, tenantId, (tx) =>
        memberDisplayNamesInTx(tx, tenantId, [ownerUserId, twin, blank, missing, SYSTEM_ACTOR_ID, opsUserId()]),
      );
      expect(Object.fromEntries(names)).toEqual({
        [ownerUserId]: `${ownerName}-user-${ownerUserId.slice(-8)}`,
        [twin]: `${ownerName}-user-${twin.slice(-8)}`,
        [blank]: `user-${blank.slice(-8)}`,
        [missing]: `user-${missing.slice(-8)}`,
        [SYSTEM_ACTOR_ID]: 'System',
        [opsUserId()]: opsName,
      });
    } finally {
      await sql`delete from users where id in (${twin}, ${blank})`;
    }
  });

  it('the route is in the OpenAPI document with both file types and the five reports', async () => {
    const doc = await http().get('/api/v1/openapi.json').expect(200);
    const op = doc.body.paths['/tenants/{tenantId}/warehouses/{warehouseId}/reports/{report}']?.get as {
      parameters: { name: string; schema: { enum?: string[] } }[];
      responses: Record<string, { content?: Record<string, unknown> }>;
    };
    expect(op).toBeDefined();
    expect(Object.keys(op.responses['200']!.content!).sort()).toEqual(['text/csv', XLSX].sort());
    expect(op.parameters.find((p) => p.name === 'report')!.schema.enum).toEqual(['stock-on-hand', 'inbound-register', 'outbound-register', 'ledger', 'batch-ageing']);
    expect(op.parameters.find((p) => p.name === 'format')!.schema.enum).toEqual(['csv', 'xlsx']);
    expect(Object.keys(op.responses).sort()).toEqual(['200', '400', '401', '403', '404', '422', '503']);
  });
});
