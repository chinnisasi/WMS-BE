import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import { hashCommandPayload } from '../src/modules/tenancy/idempotency-guard';
import { cartonCode } from '../src/shared/primitives/carton-code';
import { parcelTagCode } from '../src/shared/primitives/parcel-tag';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
process.env.CARRIER_ENCRYPTION_KEY ??= 'e2e-only-carrier-encryption-key-0123456789abcdef';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';

jest.setTimeout(90_000);

interface PickLine {
  id: string;
  picklistId: string;
  orderId: string;
  orderLineId: string;
  skuId: string;
  binId: string | null;
  qty: number;
}

type ScanLine = { skuId: string; qty: number; handlingUnitIds?: string[] };
type CartonBody = { scanned: ScanLine[]; weightGrams?: number | null; dimensionsMm?: { lengthMm: number; widthMm: number; heightMm: number } | null };

/**
 * Story 4-5a — packing documents: the pack with cartons (web, handheld, sync),
 * the re-carton, the cartons read, the legacy virtual pack, cancel with
 * restock and a carrier label's piece count.
 */
describe('packing documents: cartons at pack and re-carton (e2e, story 4-5a)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;

  let tenantId: string;
  let ownerToken: string;
  let opsToken: string;
  let accountantToken: string;
  let webOperatorToken: string;
  let operatorToken: string; // the badge-in DEVICE session
  let operatorUserId: string;
  let warehouseId: string;
  let zoneId: string;
  let binA: string;
  const skuIds = new Map<string, string>();
  const SKU_CODES = ['PD-A', 'PD-B', 'PD-CW'] as const;

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('packing_documents');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Cartons Co ${ulid()}`, ownerEmail: email, password: 'correct-horse-battery' })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerToken = (await mintSignIn(app, { email, password: 'correct-horse-battery' })).body.accessToken as string;
    opsToken = await inviteAndSignIn('ops_manager', 'ops-password-123');
    accountantToken = await inviteAndSignIn('accountant', 'books-password-123');
    webOperatorToken = await inviteAndSignIn('operator', 'floor-password-123');

    warehouseId = (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code: `PD-${ulid().slice(10, 16).toUpperCase()}`, name: `Cartons WH ${ulid()}` })
        .expect(201)
    ).body.id as string;
    zoneId = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'A', name: 'Aisle A' })
        .expect(201)
    ).body.id as string;
    binA = (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zoneId}/bins`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ capacity: 1_000_000, type: 'shelf', code: 'A-01-01' })
        .expect(201)
    ).body.id as string;

    const csv = [
      'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode',
      ...SKU_CODES.map((code) => `${code},Cartons SKU ${code},pcs,,1800,,false,false,,,`),
    ].join('\n');
    await http()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const catalog = await http().get(`${API}/${tenantId}/catalog/skus`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const item of catalog.body.items as { code: string; id: string }[]) skuIds.set(item.code, item.id);
    for (const code of SKU_CODES) await seedStock(sku(code), 5_000);

    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Carton bench', pin: '2468' })
      .expect(201);
    const operatorEmail = `picker-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: operatorEmail, role: 'operator' })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: 'correct-horse-battery' })
      .expect(200);
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail, pin: '2468' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
    operatorUserId = ((await sql`select id from users where tenant_id = ${tenantId} and email = ${operatorEmail}`) as unknown as { id: string }[])[0]!.id;

    await app.get(InventoryFacade).rebuildReservationCounters(tenantId, warehouseId);
  });

  afterAll(async () => {
    const rawDb = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await rawDb.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── fixtures ───────────────────────────────────────────────────────────────

  function http() {
    return request(app.getHttpServer());
  }

  async function inviteAndSignIn(role: string, password: string): Promise<string> {
    const address = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email: address, role })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password })
      .expect(200);
    return (await mintSignIn(app, { email: address, password })).body.accessToken as string;
  }

  function sku(code: string): string {
    const id = skuIds.get(code);
    if (id === undefined) throw new Error(`unknown fixture SKU ${code}`);
    return id;
  }

  async function seedStock(skuId: string, quantity: number): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/inventory/adjustments`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, skuId, binId: binA, quantityDelta: quantity, reasonCode: 'stock-count', note: 'cartons seed' })
      .expect(201);
  }

  /** A fully-picked order: created, waved, released and every line picked on the device. */
  async function pickedOrder(lines: { skuId: string; quantity: number }[], extra: Record<string, unknown> = {}): Promise<string> {
    const order = await http()
      .post(`${API}/${tenantId}/outbound/orders`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, lines, destination: testAddress(), ...extra })
      .expect(201);
    const orderId = order.body.order.id as string;
    const policy = await http()
      .post(`${API}/${tenantId}/outbound/wave-policies`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, name: `pd-${ulid().slice(10, 20)}`, grouping: 'single' })
      .expect(201);
    const wave = await http()
      .post(`${API}/${tenantId}/outbound/waves`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, policyId: policy.body.policy.id, orderIds: [orderId] })
      .expect(201);
    const waveId = wave.body.wave.id as string;
    await http()
      .post(`${API}/${tenantId}/outbound/waves/${waveId}/release`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(200);
    const read = await http().get(`${API}/${tenantId}/outbound/waves/${waveId}`).set('Authorization', `Bearer ${accountantToken}`).expect(200);
    for (const picklist of read.body.wave.picklists as { lines: PickLine[] }[]) {
      for (const line of picklist.lines) {
        await http()
          .post(`${API}/${tenantId}/outbound/picks`)
          .set('Authorization', `Bearer ${operatorToken}`)
          .set(KEY_HEADER, ulid())
          .send({
            warehouseId,
            picklistId: line.picklistId,
            picklistLineId: line.id,
            skuId: line.skuId,
            binId: line.binId!,
            qty: line.qty,
            occurredAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          })
          .expect(201);
      }
    }
    return orderId;
  }

  function packWeb(orderId: string, body: Record<string, unknown>, key = ulid(), token = webOperatorToken): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/pack`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function packDevice(body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http().post(`${API}/${tenantId}/outbound/packs`).set('Authorization', `Bearer ${operatorToken}`).set(KEY_HEADER, key).send(body);
  }

  function recarton(orderId: string, cartons: CartonBody[], reason = 'Box split at the dock', key = ulid(), token = opsToken): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cartons`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ cartons, reason });
  }

  function cartonsRead(orderId: string, token = accountantToken): SupertestTest {
    return http().get(`${API}/${tenantId}/outbound/orders/${orderId}/cartons`).set('Authorization', `Bearer ${token}`);
  }

  async function packRows(orderId: string): Promise<{ seq: number; status: string; carton_count: number; gross_weight_grams: number | null; source: string; device_id: string | null; end_reason: string | null; packed_at: string; packed_by: string; document_parties: Record<string, unknown> }[]> {
    return (await sql`
      select seq, status, carton_count, gross_weight_grams, source, device_id, end_reason, packed_at::text, packed_by, document_parties
      from order_packs where tenant_id = ${tenantId} and order_id = ${orderId} order by seq`) as never;
  }

  async function packedDocs(orderId: string): Promise<Record<string, unknown>[]> {
    const rows = (await sql`
      select reference_doc from ledger_events
      where tenant_id = ${tenantId} and type = 'pack.packed' and reference_doc->>'orderId' = ${orderId}`) as unknown as { reference_doc: Record<string, unknown> }[];
    return rows.map((row) => row.reference_doc);
  }

  /** Seeds a live client-arranged (courier-label) shipment by the AWB pre-advice route. */
  async function adviseAwb(orderId: string, awb: string): Promise<void> {
    await http()
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/shipment/awb`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ awb, courierName: 'Blue Courier', packageCount: 1 })
      .expect(201);
  }

  async function liveShipment(orderId: string): Promise<{ kind: string; package_count: number | null; label_verified_at: string | null }> {
    const rows = (await sql`
      select kind, package_count, label_verified_at::text from shipments
      where tenant_id = ${tenantId} and order_id = ${orderId} and status <> 'voided'`) as unknown as {
      kind: string;
      package_count: number | null;
      label_verified_at: string | null;
    }[];
    return rows[0]!;
  }

  // ── the pack ───────────────────────────────────────────────────────────────

  it('legacy pack: a web pack without cartons is one carton O….1.1 with the parcel weight, its hash main’s, its parties frozen without the warehouse contact or phone', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-A'), quantity: 3 }]);
    const key = ulid();
    const body = { scanned: [{ skuId: sku('PD-A'), qty: 3 }], weightGrams: 900 };
    const res = await packWeb(orderId, body, key).expect(201);
    expect(res.body.pack.packSeq).toBe(1);
    expect(res.body.pack.weightGrams).toBe(900);
    expect(res.body.pack.cartons).toEqual([
      {
        seq: 1,
        code: cartonCode(orderId, 1, 1),
        weightGrams: 900,
        dimensionsMm: null,
        unitCount: 3,
        lines: [{ skuId: sku('PD-A'), skuCode: 'PD-A', qty: 3 }],
      },
    ]);
    // The stored hash is main's shape — no cartons key.
    const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
    expect(stored[0]!.payload_hash).toBe(
      hashCommandPayload({ tenantId, orderId, scanned: [{ skuId: sku('PD-A'), qty: 3000 }], weightGrams: 900 }),
    );
    const packs = await packRows(orderId);
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ seq: 1, status: 'live', carton_count: 1, gross_weight_grams: 900, source: 'web', device_id: null });
    const parties = packs[0]!.document_parties as { v: number; client: Record<string, unknown>; warehouse: Record<string, unknown> };
    expect(parties.v).toBe(1);
    expect(Object.keys(parties.warehouse).sort()).toEqual(['address', 'code', 'gstin', 'name']);
    const origin = testAddress();
    const text = JSON.stringify(parties);
    expect(text).not.toContain(String(origin.contactName));
    expect(text).not.toContain(String(origin.phone));
    // The pack.packed docs keep main's shape.
    const docs = await packedDocs(orderId);
    expect(docs.map((doc) => doc.weightGrams)).toEqual([900]);
    // The replay re-serves the same slip.
    const replay = await packWeb(orderId, body, key).expect(201);
    expect(replay.body).toEqual(res.body);
  });

  it('AC1 — three cartons from the handheld: pack 1 of three cartons, the ledger weight is the gross, the parties frozen, source handheld', async () => {
    const orderId = await pickedOrder([
      { skuId: sku('PD-A'), quantity: 10 },
      { skuId: sku('PD-B'), quantity: 4 },
    ]);
    const res = await packDevice({
      orderId,
      scanned: [
        { skuId: sku('PD-A'), qty: 10 },
        { skuId: sku('PD-B'), qty: 4 },
      ],
      cartons: [
        { scanned: [{ skuId: sku('PD-A'), qty: 6 }], weightGrams: 3200 },
        { scanned: [{ skuId: sku('PD-A'), qty: 4 }, { skuId: sku('PD-B'), qty: 2 }], weightGrams: 2000 },
        { scanned: [{ skuId: sku('PD-B'), qty: 2 }], weightGrams: 800 },
      ],
    }).expect(201);
    expect(res.body.pack.orderStatus).toBe('ready_to_dispatch');
    expect(res.body.pack.weightGrams).toBe(6000);
    expect(res.body.pack.dimensionsMm).toBeNull();
    expect((res.body.pack.cartons as { code: string }[]).map((c) => c.code)).toEqual([1, 2, 3].map((n) => cartonCode(orderId, 1, n)));
    const packs = await packRows(orderId);
    expect(packs[0]).toMatchObject({ seq: 1, status: 'live', carton_count: 3, gross_weight_grams: 6000, source: 'handheld' });
    expect(packs[0]!.device_id).not.toBeNull();
    expect((await packedDocs(orderId)).map((doc) => doc.weightGrams)).toEqual([6000, 6000]);
    const read = await cartonsRead(orderId).expect(200);
    expect(read.body.pack).toMatchObject({ packSeq: 1, status: 'live', legacy: false, partiesFrozen: true, cartonCount: 3, grossWeightGrams: 6000 });
    expect(read.body.pack.cartons[1]).toMatchObject({ seq: 2, lineCount: 2, totals: [{ uom: 'each', qty: 6 }] });
    expect(read.body.history).toEqual([{ packSeq: 1, status: 'live', cartonCount: 3, endedAt: null, endedBy: null, endReason: null }]);
  });

  it('shape refusals: cartons that do not add up, an empty carton, a weight twice, a case in two cartons, a fractional each split — 400 naming the carton, nothing written', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-A'), quantity: 10 }]);
    const scanned = [{ skuId: sku('PD-A'), qty: 10 }];
    const notAdding = await packWeb(orderId, { scanned, cartons: [{ scanned: [{ skuId: sku('PD-A'), qty: 6 }] }, { scanned: [{ skuId: sku('PD-A'), qty: 3 }] }] }).expect(400);
    expect(notAdding.body.code).toBe('validation-failed');
    expect(notAdding.body.detail).toContain('do not add up to the scanned parcel');
    const empty = await packWeb(orderId, { scanned, cartons: [{ scanned: [{ skuId: sku('PD-A'), qty: 10 }] }, { scanned: [] }] }).expect(400);
    expect(empty.body.code).toBe('validation-failed');
    const twice = await packWeb(orderId, { scanned, weightGrams: 500, cartons: [{ scanned }] }).expect(400);
    expect(twice.body.detail).toContain('weigh each carton');
    const unit = uuidv7();
    const caseTwice = await packWeb(orderId, {
      scanned: [{ skuId: sku('PD-A'), qty: 10, handlingUnitIds: [unit] }],
      cartons: [
        { scanned: [{ skuId: sku('PD-A'), qty: 5, handlingUnitIds: [unit] }] },
        { scanned: [{ skuId: sku('PD-A'), qty: 5, handlingUnitIds: [unit] }] },
      ],
    }).expect(400);
    expect(caseTwice.body.detail).toContain('is in carton 1 and carton 2');
    const fractional = await packWeb(orderId, {
      scanned,
      cartons: [{ scanned: [{ skuId: sku('PD-A'), qty: 6.5 }] }, { scanned: [{ skuId: sku('PD-A'), qty: 3.5 }] }],
    }).expect(400);
    expect(fractional.body.code).toBe('validation-failed');
    expect(fractional.body.detail).toContain('Carton 1');
    expect(await packRows(orderId)).toHaveLength(0);
    const order = (await sql`select status from orders where id = ${orderId}`) as unknown as { status: string }[];
    expect(order[0]!.status).toBe('accepted');
  });

  it('a catch-weight carton whose quantity disagrees with its case count is refused (A31)', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-CW'), quantity: 3 }]);
    await sql`update skus set catch_weight_tracked = true where id = ${sku('PD-CW')}`;
    try {
      const unit = uuidv7();
      const res = await packWeb(orderId, {
        scanned: [{ skuId: sku('PD-CW'), qty: 3, handlingUnitIds: [unit] }],
        cartons: [{ scanned: [{ skuId: sku('PD-CW'), qty: 3, handlingUnitIds: [unit] }] }],
      }).expect(400);
      expect(res.body.detail).toContain('catch-weight tracked');
    } finally {
      await sql`update skus set catch_weight_tracked = false where id = ${sku('PD-CW')}`;
    }
  });

  it('the device never measures boxes: carton dimensions are refused on the device route (400)', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-A'), quantity: 2 }]);
    const res = await packDevice({
      orderId,
      scanned: [{ skuId: sku('PD-A'), qty: 2 }],
      cartons: [{ scanned: [{ skuId: sku('PD-A'), qty: 2 }], dimensionsMm: { lengthMm: 10, widthMm: 10, heightMm: 10 } }],
    }).expect(400);
    expect(res.body.code).toBe('validation-failed');
  });

  it('heavy B2B: 40 cartons × 30 kg keep the true gross on the pack, and no weight flows into the ledger (A33)', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-B'), quantity: 40 }]);
    const cartons = Array.from({ length: 40 }, () => ({ scanned: [{ skuId: sku('PD-B'), qty: 1 }], weightGrams: 30_000 }));
    const res = await packWeb(orderId, { scanned: [{ skuId: sku('PD-B'), qty: 40 }], cartons }).expect(201);
    expect(res.body.pack.weightGrams).toBeNull();
    expect((await packRows(orderId))[0]).toMatchObject({ carton_count: 40, gross_weight_grams: 1_200_000 });
    expect((await packedDocs(orderId)).every((doc) => !('weightGrams' in doc))).toBe(true);
  });

  it('dimensions ride the ledger only for a one-carton pack (A39)', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-A'), quantity: 2 }]);
    await packWeb(orderId, {
      scanned: [{ skuId: sku('PD-A'), qty: 2 }],
      cartons: [
        { scanned: [{ skuId: sku('PD-A'), qty: 1 }] },
        { scanned: [{ skuId: sku('PD-A'), qty: 1 }], dimensionsMm: { lengthMm: 300, widthMm: 200, heightMm: 100 } },
      ],
    }).expect(201);
    const docs = await packedDocs(orderId);
    expect(docs.every((doc) => !('lengthMm' in doc))).toBe(true);
    const row = (await sql`select length_mm from order_cartons where order_id = ${orderId} and seq = 2`) as unknown as { length_mm: number }[];
    expect(row[0]!.length_mm).toBe(300);
  });

  it('a client label recorded before the pack counts the cartons once packed (A40)', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-A'), quantity: 3 }]);
    await adviseAwb(orderId, `AWB${ulid().slice(14, 24)}`);
    expect((await liveShipment(orderId)).package_count).toBe(1);
    await packWeb(orderId, {
      scanned: [{ skuId: sku('PD-A'), qty: 3 }],
      cartons: [1, 2, 3].map(() => ({ scanned: [{ skuId: sku('PD-A'), qty: 1 }] })),
    }).expect(201);
    expect((await liveShipment(orderId)).package_count).toBe(3);
  });

  // ── the sync path (A32) ───────────────────────────────────────────────────

  async function syncApply(payload: Record<string, unknown>): Promise<request.Response> {
    const row = {
      opId: ulid(),
      opType: 'pack.execute',
      classification: 'rejected',
      problemCode: 'epoch-conflict',
      problemDetail: 'replayed later',
      payload,
      attribution: { deviceLabel: 'Carton bench', operatorEmail: 'floor@example.com' },
      opEnqueuedAt: new Date(Date.now() - 60_000).toISOString(),
      opOccurredAt: null,
    };
    const uploaded = await http().post(`${API}/${tenantId}/devices/sync-reports`).set('Authorization', `Bearer ${operatorToken}`).set(KEY_HEADER, ulid()).send({ rows: [row] });
    // The payload probe runs at upload too: a malformed op is refused there.
    if (uploaded.status !== 201) return uploaded;
    const listing = await http().get(`${API}/${tenantId}/rejected-ops`).query({ status: 'open' }).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const op = (listing.body.items as { id: string; opId: string }[]).find((item) => item.opId === row.opId)!;
    return http()
      .post(`${API}/${tenantId}/rejected-ops/${op.id}/resolve`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ decision: 'apply' });
  }

  it('sync: a multi-carton op re-applied lands as cartons (source sync); a malformed cartons payload is the probe’s 400, never a 500; dimensions are refused', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-A'), quantity: 4 }]);
    const bad = await syncApply({ orderId, scanned: [{ skuId: sku('PD-A'), qty: 4 }], cartons: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('validation-failed');
    expect(bad.body.detail).toContain('payload.cartons must be array-or-absent');
    const empty = await syncApply({ orderId, scanned: [{ skuId: sku('PD-A'), qty: 4 }], cartons: [{}] });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('validation-failed');
    const dims = await syncApply({
      orderId,
      scanned: [{ skuId: sku('PD-A'), qty: 4 }],
      cartons: [{ scanned: [{ skuId: sku('PD-A'), qty: 4 }], dimensionsMm: { lengthMm: 1, widthMm: 1, heightMm: 1 } }],
    });
    expect(dims.status).toBe(400);
    expect(dims.body.detail).toContain('does not record carton dimensions');
    const applied = await syncApply({
      orderId,
      scanned: [{ skuId: sku('PD-A'), qty: 4 }],
      weightGrams: null,
      cartons: [
        { scanned: [{ skuId: sku('PD-A'), qty: 3 }], weightGrams: 1500 },
        { scanned: [{ skuId: sku('PD-A'), qty: 1 }], weightGrams: null },
      ],
    });
    expect(applied.status).toBe(200);
    expect(applied.body.outcome.snapshot.pack.cartons).toHaveLength(2);
    const packs = await packRows(orderId);
    expect(packs[0]).toMatchObject({ carton_count: 2, gross_weight_grams: null, source: 'sync' });
  });

  // ── the re-carton ─────────────────────────────────────────────────────────

  it('AC4 — re-carton: 2 → 3 cartons supersedes pack 1 (reason, codes .2.n, packed_at kept, parties copied); the same split again is a 200 no-op storing the key; goods changed 422', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-A'), quantity: 6 }]);
    await packWeb(orderId, {
      scanned: [{ skuId: sku('PD-A'), qty: 6 }],
      cartons: [{ scanned: [{ skuId: sku('PD-A'), qty: 3 }] }, { scanned: [{ skuId: sku('PD-A'), qty: 3 }] }],
    }).expect(201);
    const before = await packRows(orderId);
    const split: CartonBody[] = [
      { scanned: [{ skuId: sku('PD-A'), qty: 2 }], weightGrams: 1000 },
      { scanned: [{ skuId: sku('PD-A'), qty: 2 }], weightGrams: 1000, dimensionsMm: { lengthMm: 300, widthMm: 200, heightMm: 100 } },
      { scanned: [{ skuId: sku('PD-A'), qty: 2 }], weightGrams: 1000 },
    ];
    const key = ulid();
    const res = await recarton(orderId, split, 'Box split at the dock', key).expect(201);
    expect(res.body.unchanged).toBe(false);
    expect(res.body.pack).toMatchObject({ packSeq: 2, status: 'live', cartonCount: 3, grossWeightGrams: 3000, partiesFrozen: true });
    expect((res.body.pack.cartons as { code: string }[]).map((c) => c.code)).toEqual([1, 2, 3].map((n) => cartonCode(orderId, 2, n)));
    expect(res.body.pack.cartons[0].code.startsWith(parcelTagCode(orderId))).toBe(true);
    const after = await packRows(orderId);
    expect(after.map((row) => [row.seq, row.status, row.source, row.end_reason])).toEqual([
      [1, 'superseded', 'web', 'Box split at the dock'],
      [2, 'live', 'recarton', null],
    ]);
    expect(after[1]!.packed_at).toBe(before[0]!.packed_at);
    expect(after[1]!.document_parties).toEqual(before[0]!.document_parties);
    const opsUser = (await sql`select id from users where tenant_id = ${tenantId} and email like 'ops_manager-%'`) as unknown as { id: string }[];
    await expectAuditRow({ tenantId, key, action: 'order.recartoned', targetType: 'order', targetId: orderId, actorUserId: opsUser[0]!.id });
    // The replay re-serves.
    const replay = await recarton(orderId, split, 'Box split at the dock', key).expect(201);
    expect(replay.body).toEqual(res.body);
    // The live split again → 200 no-op, key stored, nothing written.
    const noOpKey = noOpIdempotencyKey(tenantId, ulid(), 'order.recarton:unchanged');
    const noOp = await recarton(orderId, split, 'Same again', noOpKey).expect(200);
    expect(noOp.body.unchanged).toBe(true);
    expect(await packRows(orderId)).toHaveLength(2);
    expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${noOpKey}`).toHaveLength(1);
    // Different goods → 422.
    const changed = await recarton(orderId, [{ scanned: [{ skuId: sku('PD-A'), qty: 5 }] }]).expect(422);
    expect(changed.body.code).toBe('carton-contents-mismatch');
    expect(changed.body.skus).toEqual([{ skuCode: 'PD-A', packed: 6, cartoned: 5 }]);
    // History newest first.
    const read = await cartonsRead(orderId).expect(200);
    expect(read.body.history.map((h: { packSeq: number; status: string }) => [h.packSeq, h.status])).toEqual([
      [2, 'live'],
      [1, 'superseded'],
    ]);
  });

  it('the re-carton hash is pinned: {command, tenantId, orderId, cartons (normal form), reason}', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-B'), quantity: 2 }]);
    await packWeb(orderId, { scanned: [{ skuId: sku('PD-B'), qty: 2 }] }).expect(201);
    const key = ulid();
    await recarton(orderId, [{ scanned: [{ skuId: sku('PD-B'), qty: 1 }], weightGrams: 400 }, { scanned: [{ skuId: sku('PD-B'), qty: 1 }] }], '  Two boxes  ', key).expect(201);
    const stored = (await sql`select payload_hash from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`) as unknown as { payload_hash: string }[];
    const literal = JSON.stringify({
      command: 'outbound.order.recarton',
      tenantId,
      orderId,
      cartons: [{ scanned: [{ skuId: sku('PD-B'), qty: 1000 }], weightGrams: 400 }, { scanned: [{ skuId: sku('PD-B'), qty: 1000 }] }],
      reason: 'Two boxes',
    });
    expect(stored[0]!.payload_hash).toBe(createHash('sha256').update(literal, 'utf8').digest('hex'));
  });

  it('re-carton refusals: a carrier label 409, not packed / dispatched 409 order-not-packed, the 99th pack 409 recarton-limit, a role without pack.execute 403', async () => {
    // A carrier label covers the order.
    const labelled = await pickedOrder([{ skuId: sku('PD-A'), quantity: 2 }]);
    await packWeb(labelled, { scanned: [{ skuId: sku('PD-A'), qty: 2 }] }).expect(201);
    const clientId = ((await sql`select client_id from orders where id = ${labelled}`) as unknown as { client_id: string }[])[0]!.client_id;
    await sql`insert into shipments (id, tenant_id, warehouse_id, order_id, client_id, status, kind, carrier_connection_id, carrier_code, carrier_name, tracking_number, label_document_ref, labelled_by, labelled_at)
      values (${uuidv7()}, ${tenantId}, ${warehouseId}, ${labelled}, ${clientId}, 'labelled', 'carrier', ${uuidv7()}, 'sandbox', 'Sandbox', ${`SBX-${ulid()}`}, 'sandbox://x', ${operatorUserId}, now())`;
    const carrier = await recarton(labelled, [{ scanned: [{ skuId: sku('PD-A'), qty: 1 }] }, { scanned: [{ skuId: sku('PD-A'), qty: 1 }] }]).expect(409);
    expect(carrier.body.code).toBe('shipment-labelled-by-carrier');

    // Not packed.
    const accepted = await pickedOrder([{ skuId: sku('PD-A'), quantity: 1 }]);
    const notPacked = await recarton(accepted, [{ scanned: [{ skuId: sku('PD-A'), qty: 1 }] }]).expect(409);
    expect(notPacked.body.code).toBe('order-not-packed');
    expect(notPacked.body.orderStatus).toBe('accepted');
    await cartonsRead(accepted).expect(409);

    // Dispatched.
    const dispatched = await pickedOrder([{ skuId: sku('PD-A'), quantity: 1 }]);
    await packWeb(dispatched, { scanned: [{ skuId: sku('PD-A'), qty: 1 }] }).expect(201);
    await http()
      .post(`${API}/${tenantId}/outbound/orders/${dispatched}/dispatch`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ carrierName: 'Hand', trackingNumber: `T${ulid().slice(16)}` })
      .expect(201);
    const left = await recarton(dispatched, [{ scanned: [{ skuId: sku('PD-A'), qty: 1 }] }]).expect(409);
    expect(left.body.code).toBe('order-not-packed');
    expect(left.body.orderStatus).toBe('dispatched');

    // The 99th pack.
    const limited = await pickedOrder([{ skuId: sku('PD-B'), quantity: 2 }]);
    await packWeb(limited, { scanned: [{ skuId: sku('PD-B'), qty: 2 }] }).expect(201);
    await sql`update order_cartons set pack_seq = 99, code = ${cartonCode(limited, 99, 1)} where order_id = ${limited}`;
    await sql`update order_packs set seq = 99 where order_id = ${limited}`;
    const limit = await recarton(limited, [{ scanned: [{ skuId: sku('PD-B'), qty: 1 }] }, { scanned: [{ skuId: sku('PD-B'), qty: 1 }] }]).expect(409);
    expect(limit.body.code).toBe('recarton-limit');

    // Authority.
    const denied = await recarton(limited, [{ scanned: [{ skuId: sku('PD-B'), qty: 2 }] }], 'x', ulid(), accountantToken).expect(403);
    expect(denied.body.code).toBe('role-denied');
  });

  it('re-carton with a client-arranged label: its piece count follows and its verification is cleared (A40)', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-A'), quantity: 3 }]);
    await packWeb(orderId, { scanned: [{ skuId: sku('PD-A'), qty: 3 }] }).expect(201);
    await adviseAwb(orderId, `AWB${ulid().slice(14, 24)}`);
    await sql`update shipments set label_verified_at = now(), label_verified_by = ${operatorUserId}, label_verify_method = 'scan'
      where order_id = ${orderId} and status = 'labelled'`;
    const res = await recarton(orderId, [1, 2, 3].map(() => ({ scanned: [{ skuId: sku('PD-A'), qty: 1 }] }))).expect(201);
    expect(res.body.clientLabelReverify).toBe(true);
    const shipment = await liveShipment(orderId);
    expect(shipment).toMatchObject({ kind: 'courier-label', package_count: 3, label_verified_at: null });
  });

  it('a same-key re-carton race parked on the order lock answers both with the winner’s pack, one audit row, one key, one new pack', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-B'), quantity: 2 }]);
    await packWeb(orderId, { scanned: [{ skuId: sku('PD-B'), qty: 2 }] }).expect(201);
    const key = ulid();
    const split: CartonBody[] = [{ scanned: [{ skuId: sku('PD-B'), qty: 1 }] }, { scanned: [{ skuId: sku('PD-B'), qty: 1 }] }];
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      await holder.begin(async (tx) => {
        const locked = (await tx`select pg_backend_pid() as pid from orders where id = ${orderId} for update`) as unknown as { pid: number }[];
        first = (async () => recarton(orderId, split, 'race', key))();
        second = (async () => recarton(orderId, split, 'race', key))();
        await waitParked(locked[0]!.pid, 2);
      });
      const [a, b] = await Promise.all([first!, second!]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(b.body).toEqual(a.body);
      expect(await sql`select 1 from audit_events where tenant_id = ${tenantId} and reference = ${key}`).toHaveLength(1);
      expect(await sql`select 1 from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`).toHaveLength(1);
      expect((await packRows(orderId)).map((row) => row.status)).toEqual(['superseded', 'live']);
    } finally {
      await Promise.allSettled([first, second]);
      await holder.end();
    }
  });

  async function waitParked(holderPid: number, min: number): Promise<void> {
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active' and a.query ilike '%"orders"%'
        `) as unknown as { pid: number; blockers: number[] }[];
        const chain = new Set<number>([holderPid]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const row of waiting) {
            if (!chain.has(row.pid) && row.blockers.some((pid) => chain.has(pid))) {
              chain.add(row.pid);
              grew = true;
            }
          }
        }
        if (chain.size - 1 >= min) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`fewer than ${min} request(s) parked on the order row`);
    } finally {
      await probe.end();
    }
  }

  // ── legacy, cancel, carrier label ─────────────────────────────────────────

  it('a legacy order (packed before 4-5a) reads as a virtual pack; its first re-carton writes pack 2 with parties frozen now', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-A'), quantity: 2 }]);
    await packWeb(orderId, { scanned: [{ skuId: sku('PD-A'), qty: 2 }], weightGrams: 700 }).expect(201);
    // Make it look packed before deploy: no stored pack.
    await sql`delete from order_carton_lines where order_id = ${orderId}`;
    await sql`delete from order_cartons where order_id = ${orderId}`;
    await sql`delete from order_packs where order_id = ${orderId}`;
    const read = await cartonsRead(orderId).expect(200);
    expect(read.body.pack).toMatchObject({
      packSeq: 1,
      status: 'live',
      legacy: true,
      partiesFrozen: false,
      cartonCount: 1,
      grossWeightGrams: 700,
    });
    expect(read.body.pack.cartons[0]).toMatchObject({ seq: 1, code: cartonCode(orderId, 1, 1), weightGrams: 700, lineCount: 1 });
    const res = await recarton(orderId, [{ scanned: [{ skuId: sku('PD-A'), qty: 1 }] }, { scanned: [{ skuId: sku('PD-A'), qty: 1 }] }]).expect(201);
    expect(res.body.pack).toMatchObject({ packSeq: 2, legacy: false, partiesFrozen: true });
    const packs = await packRows(orderId);
    expect(packs.map((row) => [row.seq, row.status])).toEqual([[2, 'live']]);
    const history = (await cartonsRead(orderId).expect(200)).body.history as { packSeq: number; status: string }[];
    expect(history.map((h) => [h.packSeq, h.status])).toEqual([
      [2, 'live'],
      [1, 'superseded'],
    ]);
  });

  it('cancel with restock cancels the live pack; the cartons read shows it cancelled', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-B'), quantity: 3 }]);
    await packWeb(orderId, {
      scanned: [{ skuId: sku('PD-B'), qty: 3 }],
      cartons: [{ scanned: [{ skuId: sku('PD-B'), qty: 1 }] }, { scanned: [{ skuId: sku('PD-B'), qty: 2 }] }],
    }).expect(201);
    const cancelled = await http()
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/cancel-with-restock`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({});
    expect([200, 201]).toContain(cancelled.status);
    const packs = await packRows(orderId);
    expect(packs).toHaveLength(1);
    expect(packs[0]!.status).toBe('cancelled');
    const read = await cartonsRead(orderId).expect(200);
    expect(read.body.pack.status).toBe('cancelled');
    const refused = await recarton(orderId, [{ scanned: [{ skuId: sku('PD-B'), qty: 3 }] }]).expect(409);
    expect(refused.body.code).toBe('order-not-packed');
  });

  it('a carrier label on a multi-carton pack counts the cartons (A41) and the sandbox canonical is unchanged', async () => {
    const orderId = await pickedOrder([{ skuId: sku('PD-A'), quantity: 2 }]);
    await packWeb(orderId, {
      scanned: [{ skuId: sku('PD-A'), qty: 2 }],
      cartons: [{ scanned: [{ skuId: sku('PD-A'), qty: 1 }] }, { scanned: [{ skuId: sku('PD-A'), qty: 1 }] }],
    }).expect(201);
    const connection = await http()
      .post(`${API}/${tenantId}/carriers/connections`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ carrierCode: 'sandbox', accountLabel: `Sandbox ${ulid().slice(10, 16)}`, credential: { accountToken: 'canary-sandbox-token-4f2e1d' } })
      .expect(201);
    const connectionId = (connection.body.connection?.id ?? connection.body.id) as string;
    const label = await http()
      .post(`${API}/${tenantId}/outbound/orders/${orderId}/label`)
      .set('Authorization', `Bearer ${opsToken}`)
      .set(KEY_HEADER, ulid())
      .send({ carrierConnectionId: connectionId })
      .expect(201);
    expect(label.body.shipment.trackingNumber).toMatch(/^SBX-/);
    const row = (await sql`select package_count from shipments where order_id = ${orderId} and kind = 'carrier'`) as unknown as { package_count: number }[];
    expect(row[0]!.package_count).toBe(2);
  });
});
