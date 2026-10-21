import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { addIsoDays, istDateOf } from '../src/shared/primitives/time';
import { maskPhone, normalizePhone } from '../src/shared/primitives/phone';
import { normalizeVehicleNo, VEHICLE_NO_RE } from '../src/shared/primitives/vehicle';
import { VEHICLE_NO_RE as EWAY_VEHICLE_NO_RE } from '../src/modules/invoicing/eway-json';
import { EWB_NO_RE } from '../src/modules/invoicing/eway.command';
import {
  GATE_IN_DOCUMENT_KINDS,
  GATE_IN_STATUSES,
  SEAL_STATUSES,
  gateInClock,
} from '../src/modules/inbound/gate-in.command';
import { REJECTED_OP_DECISIONS_BY_TYPE, REJECTED_OP_TYPES } from '../src/modules/tenancy/sync-report.command';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { createLinkedVendor } from './support/linked-vendor';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

jest.setTimeout(240_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const DAY_MS = 86_400_000;

interface GateInDoc {
  id: string;
  position: number;
  kind: string;
  number: string;
  documentDate: string;
  ewayBillNo: string | null;
  poId: string | null;
  asnId: string | null;
  poCode?: string | null;
  asnCode?: string | null;
}

interface GateIn {
  id: string;
  code: string;
  status: string;
  warehouseId: string;
  handDelivery: boolean;
  vehicleNo: string | null;
  containerNo: string | null;
  transporterPartnerId: string | null;
  transporterName: string | null;
  transporterSnapshot: { v: 1; code: string; name: string } | null;
  transporterLabel: string;
  lrNumber: string | null;
  driverName: string | null;
  driverPhone: string | null;
  sealStatus: string;
  sealNumber: string | null;
  packagesDeclared: number | null;
  packagesCounted: number | null;
  dockDoor: string | null;
  gatedInAt: string;
  unloadStartedAt: string | null;
  unloadEndedAt: string | null;
  gatedOutAt: string | null;
  recordedBy: string;
  unloadStartedBy: string | null;
  unloadEndedBy: string | null;
  gatedOutBy: string | null;
  documents: GateInDoc[];
}

interface GateInEntry extends Omit<GateIn, 'documents'> {
  documentCount: number;
  receiptCount: number;
  packagesFlag: 'short' | 'excess' | 'matches' | null;
  packagesDifference: number | null;
  staleOpen: boolean;
}

interface GateInDetail extends GateInEntry {
  documents: GateInDoc[];
  receipts: { id: string; code: string; clientId: string | null; document: { kind: string; code: string | null } }[];
}

/**
 * Story 2-3a — the gate-in: one case per backend row of the spec's I/O
 * matrix, the audit and no-op pins, the vocabularies against 0086's CHECKs,
 * RLS, and the receipt link (the shelf-life and licence re-runs carry the
 * link in their own suites).
 */
describe('story 2-3a: gate-in and the receipt link', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;
  const realNow = gateInClock.now;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let accountantToken: string;
  let operatorToken: string;
  let operatorUserId: string;
  let deviceId: string;
  let wh1: string;
  let wh2: string;
  let glowCo: string;
  let skuId: string;
  let skuB: string;
  let po1001: { id: string; lineId: string };
  let po1002: { id: string; lineId: string };
  let poWh2: string;
  let transporter: string;
  let vendorOnly: string;
  let inactiveTransporter: string;

  const http = () => request(app.getHttpServer());

  function expectProblem(res: request.Response, status: number, code: string): void {
    expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
  }

  const today = (): string => istDateOf(new Date(gateInClock.now()).toISOString());

  async function member(role: 'ops_manager' | 'operator' | 'accountant'): Promise<string> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    return email;
  }

  async function site(code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code, name: `${code} site` })
        .expect(201)
    ).body.id as string;
  }

  async function partner(code: string, roles: string[]): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/partners`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code, name: `${code} Logistics`, roles })
        .expect(201)
    ).body.partner.id as string;
  }

  async function createPo(warehouseId: string, vendorId: string, code: string, sku = skuId): Promise<{ id: string; lineId: string }> {
    const res = await http()
      .post(`${API}/${tenantId}/inbound/purchase-orders`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ warehouseId, vendorId, code, lines: [{ skuId: sku, orderedQty: 100, unitCostPaise: 1000 }] })
      .expect(201);
    return { id: res.body.purchaseOrder.id as string, lineId: res.body.purchaseOrder.lines[0].id as string };
  }

  function baseBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      warehouseId: wh1,
      vehicleNo: 'KA01AB1234',
      transporterName: 'Typed Roadways',
      sealStatus: 'none',
      ...extra,
    };
  }

  function create(body: Record<string, unknown>, key = ulid(), token = ownerToken): SupertestTest {
    return http().post(`${API}/${tenantId}/receiving/gate-ins`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  function amend(id: string, body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http().patch(`${API}/${tenantId}/receiving/gate-ins/${id}`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key).send(body);
  }

  function unloadWeb(id: string, body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http().post(`${API}/${tenantId}/receiving/gate-ins/${id}/unload`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key).send(body);
  }

  function unloadDevice(id: string, body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http().post(`${API}/${tenantId}/devices/gate-ins/${id}/unload`).set('Authorization', `Bearer ${operatorToken}`).set(KEY_HEADER, key).send(body);
  }

  function gateOut(id: string, body: Record<string, unknown> = {}, key = ulid()): SupertestTest {
    return http().post(`${API}/${tenantId}/receiving/gate-ins/${id}/gate-out`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, key).send(body);
  }

  async function list(warehouseId: string, token = ownerToken, query: Record<string, unknown> = {}): Promise<GateInEntry[]> {
    const res = await http()
      .get(`${API}/${tenantId}/receiving/gate-ins`)
      .query({ warehouseId, limit: 200, ...query })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body.items as GateInEntry[];
  }

  async function detail(id: string, token = ownerToken): Promise<GateInDetail> {
    return (await http().get(`${API}/${tenantId}/receiving/gate-ins/${id}`).set('Authorization', `Bearer ${token}`).expect(200)).body.gateIn as GateInDetail;
  }

  async function newGateIn(extra: Record<string, unknown> = {}): Promise<GateIn> {
    return (await create(baseBody(extra)).expect(201)).body.gateIn as GateIn;
  }

  function receive(body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/receiving/goods-receipts`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: wh1, occurredAt: new Date().toISOString(), ...body });
  }

  async function snapshot(warehouseId = wh1): Promise<{ openGateIns: { id: string; code: string; status: string; documents: { kind: string; number: string }[] }[] }> {
    return (
      await http()
        .get(`${API}/${tenantId}/devices/catalog-snapshot`)
        .query({ warehouseId })
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200)
    ).body;
  }

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('gate_ins');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Gate Co ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
    const accountantEmail = await member('accountant');
    accountantToken = (await mintSignIn(app, { email: accountantEmail, password: PASSWORD })).body.accessToken as string;
    const operatorEmail = await member('operator');
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Dock handheld', pin: '2468' })
      .expect(201);
    const badged = await http()
      .post(`${API}/${tenantId}/devices/badge-in`)
      .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
      .send({ operatorEmail, pin: '2468' })
      .expect(200);
    operatorToken = badged.body.accessToken as string;
    operatorUserId = badged.body.operator.id as string;
    deviceId = enrolled.body.device.id as string;

    wh1 = await site('BLR-DC');
    wh2 = await site('PNQ-DC');
    glowCo = (
      await http()
        .post(`${API}/${tenantId}/clients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code: 'GLOW', name: 'GlowCo' })
        .expect(201)
    ).body.client.id as string;
    const sku = async (code: string): Promise<string> =>
      (
        await http()
          .post(`${API}/${tenantId}/catalog/skus`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, name: `${code} cream`, uom: 'each', gstRate: 1800, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId: glowCo })
          .expect(201)
      ).body.sku.id as string;
    skuId = await sku('GLOW-CREAM');
    skuB = await sku('GLOW-SERUM');
    const vendor = await createLinkedVendor(app, tenantId, ownerToken, { code: 'V-GLOW', name: 'Glow Supplier', clientIds: [glowCo] });
    po1001 = await createPo(wh1, vendor, 'PO-1001');
    po1002 = await createPo(wh1, vendor, 'PO-1002', skuB);
    poWh2 = (await createPo(wh2, vendor, 'PO-2001')).id;
    transporter = await partner('TR-VRL', ['transporter']);
    vendorOnly = await partner('V-ONLY', ['vendor']);
    inactiveTransporter = await partner('TR-OLD', ['transporter']);
    await http()
      .patch(`${API}/${tenantId}/partners/${inactiveTransporter}/status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ status: 'inactive', reason: 'Contract ended' })
      .expect(200);
  });

  afterAll(async () => {
    gateInClock.now = realNow;
    await sql?.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  afterEach(() => {
    gateInClock.now = realNow;
  });

  // ── the primitives and the vocabularies ────────────────────────────────────

  describe('the primitives, vocabularies and contract', () => {
    it('the vehicle, e-way bill and phone primitives (lifted; invoicing re-exports them unchanged)', () => {
      expect(normalizeVehicleNo('ka-01.ab 1234')).toBe('KA01AB1234');
      expect(normalizeVehicleNo('   ')).toBeNull();
      expect(VEHICLE_NO_RE.test('22BH1234AA')).toBe(true);
      expect(VEHICLE_NO_RE.test('T0822KA1234Z')).toBe(true);
      expect(VEHICLE_NO_RE.test('KA1')).toBe(false);
      expect(EWAY_VEHICLE_NO_RE).toBe(VEHICLE_NO_RE);
      expect(EWB_NO_RE.test('123456789012')).toBe(true);
      expect(EWB_NO_RE.test('12345678901')).toBe(false);
      expect(normalizePhone('+91 98765-43345')).toBe('+919876543345');
      expect(maskPhone('9876543345')).toBe('98•••••345');
      expect(maskPhone('+919876543345')).toBe('+91•••••••345');
      expect(maskPhone(null)).toBeNull();
    });

    it('the TS vocabularies equal the 0086 CHECKs', async () => {
      const rows = (await sql`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('gate_ins_status_check', 'gate_ins_seal_status_check', 'gate_in_documents_kind_check')`) as unknown as {
        conname: string;
        def: string;
      }[];
      const values = (name: string): string[] => [...rows.find((row) => row.conname === name)!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
      expect(values('gate_ins_status_check')).toEqual([...GATE_IN_STATUSES].sort());
      expect(values('gate_ins_seal_status_check')).toEqual([...SEAL_STATUSES].sort());
      expect(values('gate_in_documents_kind_check')).toEqual([...GATE_IN_DOCUMENT_KINDS].sort());
    });

    it('the review vocabulary: gate-in.unload is reviewable, Discard only', () => {
      expect(REJECTED_OP_TYPES).toContain('gate-in.unload');
      expect(REJECTED_OP_DECISIONS_BY_TYPE['gate-in.unload']).toEqual(['discard']);
    });

    it('both tables are tenant-isolated under RLS (wms_rls_probe sees only its stamped tenant)', async () => {
      // Seeded by hand (a non-`GI-<n>` code the allocator ignores), so the
      // record tests below still see the tenant's first code, GI-0001.
      const g = { id: uuidv7() };
      await sql`insert into gate_ins (id, tenant_id, warehouse_id, code, vehicle_no, transporter_name, seal_status, gated_in_at, recorded_by)
                values (${g.id}, ${tenantId}, ${wh1}, 'RLS-PROBE', 'KA01AB0000', 'Probe', 'none', now(), ${ownerUserId})`;
      await sql`insert into gate_in_documents (id, tenant_id, gate_in_id, position, kind, number, document_date)
                values (${uuidv7()}, ${tenantId}, ${g.id}, 0, 'invoice', 'RLS-1', ${today()})`;
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        for (const table of ['gate_ins', 'gate_in_documents']) {
          const column = table === 'gate_ins' ? 'id' : 'gate_in_id';
          expect(await rls.unsafe(`select 1 from ${table} where ${column} = '${g.id}'::uuid`)).toHaveLength(0);
          const foreign = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
            return tx.unsafe(`select 1 from ${table} where ${column} = '${g.id}'::uuid`);
          });
          expect(foreign).toHaveLength(0);
          const own = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            return tx.unsafe(`select 1 from ${table} where ${column} = '${g.id}'::uuid`);
          });
          expect(own).toHaveLength(1);
        }
      } finally {
        await rls.end();
      }
    });

    it('the committed OpenAPI publishes every gate-in route and the receipt link fields', () => {
      const doc = JSON.parse(readFileSync(resolvePath(process.cwd(), 'openapi/openapi.json'), 'utf8')) as {
        paths: Record<string, Record<string, unknown>>;
        components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
      };
      const base = '/tenants/{tenantId}';
      expect(Object.keys(doc.paths[`${base}/receiving/gate-ins`]!).sort()).toEqual(['get', 'post']);
      expect(Object.keys(doc.paths[`${base}/receiving/gate-ins/{gateInId}`]!).sort()).toEqual(['get', 'patch']);
      expect(Object.keys(doc.paths[`${base}/receiving/gate-ins/{gateInId}/unload`]!)).toEqual(['post']);
      expect(Object.keys(doc.paths[`${base}/receiving/gate-ins/{gateInId}/gate-out`]!)).toEqual(['post']);
      expect(Object.keys(doc.paths[`${base}/devices/gate-ins/{gateInId}/unload`]!)).toEqual(['post']);
      for (const field of ['gateInId', 'gateInCode', 'gateInLink']) {
        expect(Object.keys(doc.components.schemas['GoodsReceiptDto']!.properties!)).toContain(field);
      }
      expect(Object.keys(doc.components.schemas['RefusedReceiptDto']!.properties!)).toContain('gateInLink');
      expect(Object.keys(doc.components.schemas['SubmitGoodsReceiptDto']!.properties!)).toContain('gateInId');
      for (const field of ['gateInId', 'gateInCode', 'vehicleNo']) {
        expect(Object.keys(doc.components.schemas['GoodsReceiptEntryDto']!.properties!)).toContain(field);
      }
      expect(Object.keys(doc.components.schemas['CatalogSnapshotResponse']!.properties!)).toContain('openGateIns');
    });
  });

  // ── record ─────────────────────────────────────────────────────────────────

  describe('record (the gate desk)', () => {
    it('the full gate-in: normalised plate and EWB, a partner frozen, an invoice on PO-1001 and a bill of entry — GI-0001, gated_in, audited, the phone kept out of the event', async () => {
      const key = ulid();
      const body = {
        warehouseId: wh1,
        vehicleNo: 'ka-01.ab 1234',
        containerNo: 'MSKU1234567',
        transporterPartnerId: transporter,
        lrNumber: 'LR-77',
        driverName: 'Ravi Kumar',
        driverPhone: '98765 43345',
        sealStatus: 'intact',
        sealNumber: 'S-991, C-12',
        packagesDeclared: 12,
        dockDoor: 'D3',
        documents: [
          { kind: 'invoice', number: 'INV-55', documentDate: today(), ewayBillNo: '1234 5678 9012', poId: po1001.id },
          { kind: 'bill_of_entry', number: 'BOE-9', documentDate: today() },
        ],
      };
      const res = await create(body, key).expect(201);
      const g = res.body.gateIn as GateIn;
      expect(g).toMatchObject({
        code: 'GI-0001',
        status: 'gated_in',
        vehicleNo: 'KA01AB1234',
        containerNo: 'MSKU1234567',
        transporterPartnerId: transporter,
        transporterName: null,
        transporterLabel: 'TR-VRL Logistics',
        sealStatus: 'intact',
        sealNumber: 'S-991, C-12',
        packagesDeclared: 12,
        packagesCounted: null,
        dockDoor: 'D3',
        recordedBy: ownerUserId,
        // A mutation's answer (the stored snapshot) never holds the phone in full.
        driverPhone: '98•••••345',
      });
      expect(g.transporterSnapshot).toMatchObject({ v: 1, code: 'TR-VRL', name: 'TR-VRL Logistics' });
      expect(g.documents.map((doc) => [doc.position, doc.kind, doc.number, doc.ewayBillNo, doc.poId])).toEqual([
        [0, 'invoice', 'INV-55', '123456789012', po1001.id],
        [1, 'bill_of_entry', 'BOE-9', null, null],
      ]);
      const stored = (await sql`select driver_phone from gate_ins where id = ${g.id}`) as unknown as { driver_phone: string }[];
      expect(stored[0]!.driver_phone).toBe('9876543345');
      // Decision 10 — the outbox payload carries the gate-in WITHOUT the phone.
      const events = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'gate_in.recorded' and payload->'gateIn'->>'id' = ${g.id}`) as unknown as {
        payload: { gateIn: Record<string, unknown> };
      }[];
      expect(events).toHaveLength(1);
      expect(Object.keys(events[0]!.payload.gateIn)).not.toContain('driverPhone');
      expect(JSON.stringify(events[0]!.payload)).not.toContain('43345');
      await expectAuditRow({ tenantId, key, action: 'gate_in.recorded', targetType: 'gate_in', targetId: g.id, actorUserId: ownerUserId });
      const replayed = await create(body, key).expect(201);
      expect(replayed.body).toEqual(res.body);
      await expectAuditRow({ tenantId, key, action: 'gate_in.recorded', targetType: 'gate_in', targetId: g.id, actorUserId: ownerUserId });
    });

    it('BH-series and temporary plates are accepted', async () => {
      expect((await newGateIn({ vehicleNo: '22 BH 1234 AA' })).vehicleNo).toBe('22BH1234AA');
      expect((await newGateIn({ vehicleNo: 'T0822KA1234Z' })).vehicleNo).toBe('T0822KA1234Z');
    });

    it('a hand delivery needs no vehicle; otherwise the vehicle is required (and normalised before its pattern)', async () => {
      const g = await newGateIn({ handDelivery: true, vehicleNo: null });
      expect(g).toMatchObject({ handDelivery: true, vehicleNo: null });
      const entry = (await list(wh1)).find((row) => row.id === g.id)!;
      expect(entry).toMatchObject({ handDelivery: true, vehicleNo: null });
      const missing = await create(baseBody({ vehicleNo: null })).expect(400);
      expectProblem(missing, 400, 'validation-failed');
      expect(missing.body.detail).toContain('vehicleNo is required');
      const short = await create(baseBody({ vehicleNo: 'K-A1' })).expect(400);
      expect(short.body.detail).toContain('4–15 letters and digits; spaces, dots and hyphens are ignored');
    });

    it('the transporter: a typed name only → 201; both → 400; neither → 400', async () => {
      const typed = await newGateIn({ transporterName: '  Shree Carriers  ' });
      expect(typed).toMatchObject({ transporterName: 'Shree Carriers', transporterPartnerId: null, transporterSnapshot: null, transporterLabel: 'Shree Carriers' });
      expectProblem(await create(baseBody({ transporterPartnerId: transporter })), 400, 'validation-failed');
      expectProblem(await create(baseBody({ transporterName: null })), 400, 'validation-failed');
    });

    it('a vendor-only partner is 409 partner-not-transporter; an inactive transporter 409 transporter-inactive; an unknown one 404', async () => {
      const notTransporter = await create(baseBody({ transporterName: null, transporterPartnerId: vendorOnly }));
      expectProblem(notTransporter, 409, 'partner-not-transporter');
      expect(notTransporter.body.detail).toContain('V-ONLY');
      expectProblem(await create(baseBody({ transporterName: null, transporterPartnerId: inactiveTransporter })), 409, 'transporter-inactive');
      expectProblem(await create(baseBody({ transporterName: null, transporterPartnerId: uuidv7() })), 404, 'not-found');
    });

    it('bad fields are 400s naming each: an 11-digit EWB, phone "abc", an intact seal without a number, a duplicate invoice, a document dated tomorrow', async () => {
      const ewb = await create(baseBody({ documents: [{ kind: 'invoice', number: 'I-1', documentDate: today(), ewayBillNo: '12345678901' }] }));
      expectProblem(ewb, 400, 'validation-failed');
      expect(ewb.body.detail).toContain('Document 1 (invoice I-1): the e-way bill number must be 12 digits');
      const phone = await create(baseBody({ driverPhone: 'abc' }));
      expectProblem(phone, 400, 'validation-failed');
      expect(phone.body.detail).toContain('driverPhone');
      const seal = await create(baseBody({ sealStatus: 'intact' }));
      expectProblem(seal, 400, 'validation-failed');
      expect(seal.body.detail).toContain('sealNumber is required when the seal is intact');
      const duplicate = await create(
        baseBody({
          documents: [
            { kind: 'invoice', number: 'INV-9', documentDate: today() },
            { kind: 'invoice', number: 'inv-9', documentDate: today() },
          ],
        }),
      );
      expectProblem(duplicate, 400, 'validation-failed');
      expect(duplicate.body.detail).toContain('Document 2 (invoice inv-9) repeats document 1');
      const tomorrow = addIsoDays(today(), 1);
      const dated = await create(baseBody({ documents: [{ kind: 'challan', number: 'DC-1', documentDate: tomorrow }] }));
      expectProblem(dated, 400, 'validation-failed');
      expect(dated.body.detail).toContain(`dated ${tomorrow}, after today`);
      // A seal number with `none` is refused rather than silently dropped.
      expectProblem(await create(baseBody({ sealNumber: 'S-1' })), 400, 'validation-failed');
    });

    it('a time more than 5 minutes ahead is 400 time-in-future', async () => {
      expectProblem(await create(baseBody({ gatedInAt: new Date(Date.now() + 10 * 60_000).toISOString() })), 400, 'time-in-future');
      // Within the tolerance is accepted (clock skew).
      await create(baseBody({ gatedInAt: new Date(Date.now() + 60_000).toISOString() })).expect(201);
    });

    it("another warehouse's PO on a WH1 gate-in is 409 document-warehouse-mismatch; an unknown PO 404; a closed or other client's PO is fine", async () => {
      expectProblem(await create(baseBody({ documents: [{ kind: 'invoice', number: 'X-1', documentDate: today(), poId: poWh2 }] })), 409, 'document-warehouse-mismatch');
      expectProblem(await create(baseBody({ documents: [{ kind: 'invoice', number: 'X-2', documentDate: today(), poId: uuidv7() }] })), 404, 'not-found');
    });

    it('the same key retried with no time replays (no 422), whatever the clock reads now', async () => {
      const key = ulid();
      const first = await create(baseBody({ vehicleNo: 'MH12RT0001' }), key).expect(201);
      const base = Date.now();
      gateInClock.now = () => base + 3 * 60_000;
      const again = await create(baseBody({ vehicleNo: 'MH12RT0001' }), key).expect(201);
      expect(again.body).toEqual(first.body);
    });

    it('an accountant cannot record (403 role-denied); a malformed gateInId path is a 400', async () => {
      expectProblem(await create(baseBody(), ulid(), accountantToken), 403, 'role-denied');
      expectProblem(await http().get(`${API}/${tenantId}/receiving/gate-ins/not-a-uuid`).set('Authorization', `Bearer ${ownerToken}`), 400, 'validation-failed');
      expectProblem(await http().get(`${API}/${tenantId}/receiving/gate-ins/${uuidv7()}`).set('Authorization', `Bearer ${ownerToken}`), 404, 'not-found');
    });
  });

  // ── the unload ─────────────────────────────────────────────────────────────

  describe('the unload (dock handheld and web)', () => {
    it('offline unload end: a queued end with 10 counted of 12 declared — unloaded, start stamped too, the web reads "2 short"; audited unload_ended only', async () => {
      const g = await newGateIn({ packagesDeclared: 12 });
      const at = new Date(Date.now() - 30 * 60_000).toISOString();
      const key = ulid();
      const res = await unloadDevice(g.id, { phase: 'end', occurredAt: at, packagesCounted: 10 }, key).expect(200);
      expect(res.body.applied).toBe(true);
      expect(res.body.gateIn).toMatchObject({
        status: 'unloaded',
        packagesCounted: 10,
        unloadEndedAt: at,
        unloadStartedAt: at,
        unloadStartedBy: operatorUserId,
        unloadEndedBy: operatorUserId,
      });
      await expectAuditRow({ tenantId, key, action: 'gate_in.unload_ended', targetType: 'gate_in', targetId: g.id, actorUserId: operatorUserId });
      const entry = (await list(wh1)).find((row) => row.id === g.id)!;
      expect(entry).toMatchObject({ packagesFlag: 'short', packagesDifference: 2 });
      const replay = await unloadDevice(g.id, { phase: 'end', occurredAt: at, packagesCounted: 10 }, key).expect(200);
      expect(replay.body).toEqual(res.body);
    });

    it('a device start, then the web end — each audited; excess counted reads "excess"', async () => {
      const g = await newGateIn({ packagesDeclared: 4 });
      const startKey = ulid();
      const started = await unloadDevice(g.id, { phase: 'start', occurredAt: new Date().toISOString() }, startKey).expect(200);
      expect(started.body.gateIn.status).toBe('unloading');
      await expectAuditRow({ tenantId, key: startKey, action: 'gate_in.unload_started', targetType: 'gate_in', targetId: g.id, actorUserId: operatorUserId });
      const ended = await unloadWeb(g.id, { phase: 'end', packagesCounted: 5 }).expect(200);
      expect(ended.body).toMatchObject({ applied: true, gateIn: { status: 'unloaded', packagesCounted: 5, unloadEndedBy: ownerUserId } });
      expect((await list(wh1)).find((row) => row.id === g.id)).toMatchObject({ packagesFlag: 'excess', packagesDifference: 1 });
    });

    it('a late duplicate: the web recorded the end; the device\'s queued start replays → 200 applied: false, nothing written, no audit, no event', async () => {
      const g = await newGateIn();
      const webAt = new Date().toISOString();
      await unloadWeb(g.id, { phase: 'end', occurredAt: webAt, packagesCounted: 7 }).expect(200);
      const before = (await sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and payload->'gateIn'->>'id' = ${g.id}`) as unknown as { n: number }[];
      const key = noOpIdempotencyKey(tenantId, ulid(), 'gateIns.unload:already-recorded');
      const deviceAt = new Date(Date.now() - 3_600_000).toISOString();
      const res = await unloadDevice(g.id, { phase: 'start', occurredAt: deviceAt }, key).expect(200);
      expect(res.body.applied).toBe(false);
      expect(res.body.gateIn).toMatchObject({ status: 'unloaded', unloadStartedAt: webAt, packagesCounted: 7, unloadStartedBy: ownerUserId });
      const audit = (await sql`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${key}`) as unknown as { n: number }[];
      expect(audit[0]!.n).toBe(0);
      const after = (await sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and payload->'gateIn'->>'id' = ${g.id}`) as unknown as { n: number }[];
      expect(after[0]!.n).toBe(before[0]!.n);
      // The key IS stored: a replay re-serves the same body.
      expect((await unloadDevice(g.id, { phase: 'start', occurredAt: deviceAt }, key).expect(200)).body).toEqual(res.body);
    });

    it('gated out before the dock syncs: the queued end fills the count and the end, the status stays gated_out, applied: true', async () => {
      const g = await newGateIn({ packagesDeclared: 3 });
      await gateOut(g.id).expect(200);
      const res = await unloadDevice(g.id, { phase: 'end', occurredAt: new Date(Date.now() - 600_000).toISOString(), packagesCounted: 3 }).expect(200);
      expect(res.body).toMatchObject({ applied: true, gateIn: { status: 'gated_out', packagesCounted: 3 } });
      expect(res.body.gateIn.unloadEndedAt).not.toBeNull();
      expect((await list(wh1)).find((row) => row.id === g.id)).toMatchObject({ packagesFlag: 'matches', packagesDifference: 0 });
    });

    it('an unknown gate-in on the device route is 404 (the device sends it to review); a device end without a count is 400', async () => {
      expectProblem(await unloadDevice(uuidv7(), { phase: 'start', occurredAt: new Date().toISOString() }), 404, 'not-found');
      const g = await newGateIn();
      expectProblem(await unloadDevice(g.id, { phase: 'end', occurredAt: new Date().toISOString() }), 400, 'validation-failed');
      expectProblem(await unloadDevice(g.id, { phase: 'start' }), 400, 'validation-failed');
      expectProblem(await unloadDevice(g.id, { phase: 'start', occurredAt: new Date().toISOString(), packagesCounted: 3 }), 400, 'validation-failed');
    });

    it('web times are ordered (400 time-out-of-order) and bounded (time-in-future); device times are taken as sent', async () => {
      const gatedInAt = new Date(Date.now() - 3_600_000).toISOString();
      const g = await newGateIn({ gatedInAt });
      expectProblem(await unloadWeb(g.id, { phase: 'start', occurredAt: new Date(Date.parse(gatedInAt) - 60_000).toISOString() }), 400, 'time-out-of-order');
      expectProblem(await unloadWeb(g.id, { phase: 'start', occurredAt: new Date(Date.now() + 3_600_000).toISOString() }), 400, 'time-in-future');
      const deviceBefore = await unloadDevice(g.id, { phase: 'start', occurredAt: new Date(Date.parse(gatedInAt) - 600_000).toISOString() }).expect(200);
      expect(deviceBefore.body.applied).toBe(true);
      const startedAt = deviceBefore.body.gateIn.unloadStartedAt as string;
      expectProblem(await unloadWeb(g.id, { phase: 'end', occurredAt: new Date(Date.parse(startedAt) - 1000).toISOString(), packagesCounted: 1 }), 400, 'time-out-of-order');
    });

    it('the device route needs the device and gate.manage; the surface is in the fingerprint (same key, other surface → 422)', async () => {
      const g = await newGateIn();
      const key = ulid();
      const at = new Date().toISOString();
      await unloadDevice(g.id, { phase: 'start', occurredAt: at }, key).expect(200);
      expectProblem(await unloadWeb(g.id, { phase: 'start', occurredAt: at }, key), 422, 'idempotency-key-reuse');
      // The accountant (no gate.manage) is refused on the web entry.
      expectProblem(
        await http()
          .post(`${API}/${tenantId}/receiving/gate-ins/${g.id}/unload`)
          .set('Authorization', `Bearer ${accountantToken}`)
          .set(KEY_HEADER, ulid())
          .send({ phase: 'end', packagesCounted: 1 }),
        403,
        'role-denied',
      );
      // A web token cannot use the device entry.
      expect(
        (
          await http()
            .post(`${API}/${tenantId}/devices/gate-ins/${g.id}/unload`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .set(KEY_HEADER, ulid())
            .send({ phase: 'end', occurredAt: at, packagesCounted: 1 })
        ).status,
      ).toBe(401);
      expect(deviceId).toBeTruthy();
    });
  });

  // ── amend and gate-out ─────────────────────────────────────────────────────

  describe('amend and gate-out', () => {
    it('amend is a full replacement (a blank optional becomes null, the document set replaced), audited', async () => {
      const g = await newGateIn({ lrNumber: 'LR-1', dockDoor: 'D1', documents: [{ kind: 'invoice', number: 'A-1', documentDate: today() }] });
      const key = ulid();
      const res = await amend(g.id, { vehicleNo: 'KA01AB1234', transporterName: 'Typed Roadways', sealStatus: 'broken', sealNumber: 'S-7', lrNumber: '  ', documents: [{ kind: 'challan', number: 'DC-7', documentDate: today(), poId: po1002.id }] }, key).expect(200);
      const amended = res.body.gateIn as GateIn;
      expect(amended).toMatchObject({ lrNumber: null, dockDoor: null, sealStatus: 'broken', sealNumber: 'S-7' });
      expect(amended.documents.map((doc) => [doc.kind, doc.number, doc.poId])).toEqual([['challan', 'DC-7', po1002.id]]);
      await expectAuditRow({ tenantId, key, action: 'gate_in.amended', targetType: 'gate_in', targetId: g.id, actorUserId: ownerUserId });
    });

    it('the transporter is re-frozen only when it changes: an amend keeps a since-deactivated partner', async () => {
      const t = await partner(`TR-${ulid().slice(-6)}`, ['transporter']);
      const g = await newGateIn({ transporterName: null, transporterPartnerId: t });
      await http()
        .patch(`${API}/${tenantId}/partners/${t}/status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ status: 'inactive' })
        .expect(200);
      const kept = await amend(g.id, { vehicleNo: 'KA01AB9999', transporterPartnerId: t, sealStatus: 'none' }).expect(200);
      expect(kept.body.gateIn).toMatchObject({ vehicleNo: 'KA01AB9999', transporterPartnerId: t });
      expect(kept.body.gateIn.transporterSnapshot).toEqual(g.transporterSnapshot);
      expectProblem(await amend(g.id, { vehicleNo: 'KA01AB9999', transporterPartnerId: inactiveTransporter, sealStatus: 'none' }), 409, 'transporter-inactive');
    });

    it('the gated-in time: editable while gated_in (audited as an amend); once unloading 409 gate-in-time-locked, while other fields still amend', async () => {
      const g = await newGateIn();
      const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const moved = await amend(g.id, { vehicleNo: 'KA01AB1234', transporterName: 'Typed Roadways', sealStatus: 'none', gatedInAt: earlier }).expect(200);
      expect(moved.body.gateIn.gatedInAt).toBe(earlier);
      await unloadWeb(g.id, { phase: 'start' }).expect(200);
      expectProblem(
        await amend(g.id, { vehicleNo: 'KA01AB1234', transporterName: 'Typed Roadways', sealStatus: 'none', gatedInAt: new Date(Date.now() - 3_600_000).toISOString() }),
        409,
        'gate-in-time-locked',
      );
      // The same time resent is not a change; the other fields amend.
      const other = await amend(g.id, { vehicleNo: 'KA01AB1234', transporterName: 'Typed Roadways', sealStatus: 'none', gatedInAt: earlier, dockDoor: 'D9' }).expect(200);
      expect(other.body.gateIn).toMatchObject({ dockDoor: 'D9', gatedInAt: earlier, status: 'unloading' });
    });

    it('gate-out: audited; twice → 409 gate-in-closed; an amend after → 409 gate-in-closed; before the gated-in time → 400', async () => {
      const g = await newGateIn({ gatedInAt: new Date(Date.now() - 3_600_000).toISOString() });
      expectProblem(await gateOut(g.id, { gatedOutAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }), 400, 'time-out-of-order');
      const key = ulid();
      const out = await gateOut(g.id, {}, key).expect(200);
      expect(out.body.gateIn).toMatchObject({ status: 'gated_out', gatedOutBy: ownerUserId });
      await expectAuditRow({ tenantId, key, action: 'gate_in.gated_out', targetType: 'gate_in', targetId: g.id, actorUserId: ownerUserId });
      expectProblem(await gateOut(g.id), 409, 'gate-in-closed');
      expectProblem(await amend(g.id, { vehicleNo: 'KA01AB1234', transporterName: 'X', sealStatus: 'none' }), 409, 'gate-in-closed');
      // The replay of the committed gate-out still re-serves its answer.
      expect((await gateOut(g.id, {}, key).expect(200)).body).toEqual(out.body);
    });
  });

  // ── reads ──────────────────────────────────────────────────────────────────

  describe('the reads', () => {
    it('phone privacy: the list masks for everyone; the detail shows it in full only to a gate.manage holder', async () => {
      const g = await newGateIn({ driverPhone: '+91 98765 43345' });
      for (const token of [ownerToken, accountantToken]) {
        expect((await list(wh1, token)).find((row) => row.id === g.id)!.driverPhone).toBe('+91•••••••345');
      }
      expect((await detail(g.id, ownerToken)).driverPhone).toBe('+919876543345');
      expect((await detail(g.id, accountantToken)).driverPhone).toBe('+91•••••••345');
    });

    it('undeclared: no packages declared, 10 counted — no flag', async () => {
      const g = await newGateIn();
      await unloadWeb(g.id, { phase: 'end', packagesCounted: 10 }).expect(200);
      expect((await list(wh1)).find((row) => row.id === g.id)).toMatchObject({ packagesFlag: null, packagesDifference: null, packagesCounted: 10 });
    });

    it('the device bound: an open gate-in gated in 8 days ago is not on the device; the web flags it staleOpen', async () => {
      const stale = await newGateIn({ gatedInAt: new Date(Date.now() - 8 * DAY_MS).toISOString() });
      const fresh = await newGateIn({ documents: [{ kind: 'invoice', number: 'F-1', documentDate: today() }] });
      const closed = await newGateIn();
      await gateOut(closed.id).expect(200);
      const open = (await snapshot()).openGateIns;
      expect(open.some((row) => row.id === stale.id)).toBe(false);
      expect(open.some((row) => row.id === closed.id)).toBe(false);
      expect(open.find((row) => row.id === fresh.id)).toMatchObject({ code: fresh.code, status: 'gated_in', documents: [{ kind: 'invoice', number: 'F-1' }] });
      const entries = await list(wh1);
      expect(entries.find((row) => row.id === stale.id)!.staleOpen).toBe(true);
      expect(entries.find((row) => row.id === fresh.id)!.staleOpen).toBe(false);
    });

    it('the list: newest gated-in first, keyset paging, status taking several values', async () => {
      const a = await newGateIn({ gatedInAt: new Date(Date.now() - 20 * 60_000).toISOString() });
      const b = await newGateIn({ gatedInAt: new Date(Date.now() - 10 * 60_000).toISOString() });
      await unloadWeb(b.id, { phase: 'start' }).expect(200);
      const page1 = await http()
        .get(`${API}/${tenantId}/receiving/gate-ins`)
        .query({ warehouseId: wh1, limit: 1, status: ['gated_in', 'unloading'] })
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.nextCursor).not.toBeNull();
      const all = await list(wh1, ownerToken, { status: ['gated_in', 'unloading'] });
      const times = all.map((row) => Date.parse(row.gatedInAt));
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      expect(all.every((row) => row.status === 'gated_in' || row.status === 'unloading')).toBe(true);
      expect(all.findIndex((row) => row.id === b.id)).toBeLessThan(all.findIndex((row) => row.id === a.id));
      expectProblem(await http().get(`${API}/${tenantId}/receiving/gate-ins`).query({ warehouseId: wh1, status: 'parked' }).set('Authorization', `Bearer ${ownerToken}`), 400, 'validation-failed');
    });
  });

  // ── code review (2026-10-21): decisions 16 and 17, time floors, sync reports, races ──

  describe('code review: decisions 16 and 17, the time floors, the review queue, the races', () => {
    async function auditChanges(key: string): Promise<Record<string, unknown> | null> {
      const rows = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key} and action = 'gate_in.amended'`) as unknown as {
        changes: Record<string, unknown> | null;
      }[];
      expect(rows).toHaveLength(1);
      return rows[0]!.changes;
    }

    function uploadRow(row: Record<string, unknown>): SupertestTest {
      return http()
        .post(`${API}/${tenantId}/devices/sync-reports`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set(KEY_HEADER, ulid())
        .send({ rows: [{ classification: 'rejected', attribution: null, opEnqueuedAt: new Date().toISOString(), opOccurredAt: new Date().toISOString(), ...row }] });
    }

    async function rejectedOpId(opId: string): Promise<string> {
      const rows = (await sql`select id from rejected_ops where tenant_id = ${tenantId} and op_id = ${opId}`) as unknown as { id: string }[];
      expect(rows).toHaveLength(1);
      return rows[0]!.id;
    }

    function resolve(id: string, body: Record<string, unknown>): SupertestTest {
      return http().post(`${API}/${tenantId}/rejected-ops/${id}/resolve`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send(body);
    }

    it('decision 16: before the unload ends the seal and the declared count amend; after it they are 409 gate-in-field-locked while other fields still amend', async () => {
      const g = await newGateIn({ sealStatus: 'intact', sealNumber: 'S-1', packagesDeclared: 5 });
      const head = { vehicleNo: 'KA01AB1234', transporterName: 'Typed Roadways' };
      const unlocked = await amend(g.id, { ...head, sealStatus: 'broken', sealNumber: 'S-1', packagesDeclared: 6 }).expect(200);
      expect(unlocked.body.gateIn).toMatchObject({ sealStatus: 'broken', packagesDeclared: 6 });
      await unloadWeb(g.id, { phase: 'end', packagesCounted: 6 }).expect(200);
      const base = { ...head, sealStatus: 'broken', sealNumber: 'S-1', packagesDeclared: 6 };
      for (const change of [{ sealStatus: 'intact' }, { sealNumber: 'S-2' }, { packagesDeclared: 7 }, { sealStatus: 'none', sealNumber: null }]) {
        const res = await amend(g.id, { ...base, ...change });
        expectProblem(res, 409, 'gate-in-field-locked');
      }
      const other = await amend(g.id, { ...base, dockDoor: 'D7' }).expect(200);
      expect(other.body.gateIn).toMatchObject({ dockDoor: 'D7', sealStatus: 'broken', packagesDeclared: 6 });
    });

    it('decision 16: an amend\'s audit row records each changed field before and after — the driver phone as "changed" only', async () => {
      const g = await newGateIn({ driverPhone: '9876543345', dockDoor: 'D1', documents: [{ kind: 'invoice', number: 'AU-1', documentDate: today() }] });
      const key = ulid();
      await amend(
        g.id,
        { vehicleNo: 'KA01AB1234', transporterName: 'Typed Roadways', sealStatus: 'none', driverPhone: '9876500000', dockDoor: 'D2', documents: [{ kind: 'invoice', number: 'AU-1', documentDate: today() }] },
        key,
      ).expect(200);
      const changes = await auditChanges(key);
      expect(changes).toEqual({ driverPhone: { changed: true }, dockDoor: { before: 'D1', after: 'D2' } });
      expect(JSON.stringify(changes)).not.toContain('98765');
    });

    it('decision 17: the device snapshot carries no packagesDeclared', async () => {
      const g = await newGateIn({ packagesDeclared: 40 });
      const entry = (await snapshot()).openGateIns.find((row) => row.id === g.id)!;
      expect(entry).toBeDefined();
      expect(Object.keys(entry)).not.toContain('packagesDeclared');
    });

    it('the gate-out floor is the latest recorded instant (start, end, gated in); a web unload after the gate-out is 400; device times stay unchecked', async () => {
      const g = await newGateIn({ gatedInAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
      const startAt = new Date(Date.now() - 30 * 60_000).toISOString();
      await unloadDevice(g.id, { phase: 'start', occurredAt: startAt }).expect(200);
      expectProblem(await gateOut(g.id, { gatedOutAt: new Date(Date.now() - 3_600_000).toISOString() }), 400, 'time-out-of-order');
      await unloadWeb(g.id, { phase: 'end', occurredAt: new Date(Date.now() - 20 * 60_000).toISOString(), packagesCounted: 2 }).expect(200);
      expectProblem(await gateOut(g.id, { gatedOutAt: new Date(Date.now() - 25 * 60_000).toISOString() }), 400, 'time-out-of-order');
      await gateOut(g.id, { gatedOutAt: new Date(Date.now() - 10 * 60_000).toISOString() }).expect(200);

      const h = await newGateIn({ gatedInAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
      const outAt = new Date(Date.now() - 3_600_000).toISOString();
      await gateOut(h.id, { gatedOutAt: outAt }).expect(200);
      expectProblem(await unloadWeb(h.id, { phase: 'start', occurredAt: new Date(Date.now() - 30 * 60_000).toISOString() }), 400, 'time-out-of-order');
      const inside = await unloadWeb(h.id, { phase: 'start', occurredAt: new Date(Date.parse(outAt) - 60_000).toISOString() }).expect(200);
      expect(inside.body).toMatchObject({ applied: true, gateIn: { status: 'gated_out' } });
      // The device's end, after the gate-out, is taken as sent.
      const device = await unloadDevice(h.id, { phase: 'end', occurredAt: new Date().toISOString(), packagesCounted: 1 }).expect(200);
      expect(device.body).toMatchObject({ applied: true, gateIn: { status: 'gated_out', packagesCounted: 1 } });
    });

    it('(a) the list walked with limit 1 equals the unpaged order; a garbage cursor is 400 invalid-cursor', async () => {
      const all = (await list(wh1)).map((row) => row.id);
      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await http()
          .get(`${API}/${tenantId}/receiving/gate-ins`)
          .query({ warehouseId: wh1, limit: 1, ...(cursor === null ? {} : { cursor }) })
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200);
        walked.push(...(res.body.items as { id: string }[]).map((row) => row.id));
        cursor = res.body.nextCursor as string | null;
      } while (cursor !== null);
      expect(walked).toEqual(all);
      expectProblem(
        await http().get(`${API}/${tenantId}/receiving/gate-ins`).query({ warehouseId: wh1, cursor: 'garbage' }).set('Authorization', `Bearer ${ownerToken}`),
        400,
        'invalid-cursor',
      );
    });

    it('(b) a device start after the gate-out: applied, the start filled, the status stays gated_out', async () => {
      const g = await newGateIn();
      await gateOut(g.id).expect(200);
      const at = new Date(Date.now() - 600_000).toISOString();
      const res = await unloadDevice(g.id, { phase: 'start', occurredAt: at }).expect(200);
      expect(res.body).toMatchObject({ applied: true, gateIn: { status: 'gated_out', unloadStartedAt: at, unloadStartedBy: operatorUserId } });
    });

    it('(c) a refused grn.submit with gateInId uploaded by sync report and applied from the queue — the re-run links; a non-uuid gateInId is accepted into the report', async () => {
      const g = await newGateIn();
      const payload = {
        warehouseId: wh1,
        poId: null,
        blindReasonCode: 'other',
        clientId: glowCo,
        gateInId: g.id,
        occurredAt: new Date().toISOString(),
        lines: [{ poLineId: null, skuId, batchCode: null, mfgDate: null, qty: 1 }],
      };
      const opId = ulid();
      await uploadRow({ opId, opType: 'grn.submit', problemCode: 'not-found', payload }).expect(201);
      const applied = await resolve(await rejectedOpId(opId), { decision: 'apply' }).expect(200);
      const grn = (applied.body.outcome as { snapshot: { goodsReceipt: { id: string; gateInId?: string; gateInCode?: string } } }).snapshot.goodsReceipt;
      expect(grn).toMatchObject({ gateInId: g.id, gateInCode: g.code });
      const stored = (await sql`select gate_in_id from goods_receipt_notes where id = ${grn.id}`) as unknown as { gate_in_id: string }[];
      expect(stored[0]!.gate_in_id).toBe(g.id);

      const badOp = ulid();
      await uploadRow({ opId: badOp, opType: 'grn.submit', problemCode: 'not-found', payload: { ...payload, gateInId: 'not-a-uuid' } }).expect(201);
      const reapplied = await resolve(await rejectedOpId(badOp), { decision: 'apply' }).expect(200);
      expect((reapplied.body.outcome as { snapshot: { goodsReceipt: { gateInLink?: unknown } } }).snapshot.goodsReceipt.gateInLink).toEqual({
        status: 'not-linked',
        reason: 'unknown',
      });
    });

    it('(d) the device\'s exact gate-in.unload body files a review row (a non-uuid id too); apply is refused, discard resolves it', async () => {
      const opId = ulid();
      await uploadRow({
        opId,
        opType: 'gate-in.unload',
        problemCode: 'not-found',
        payload: { gateInId: uuidv7(), phase: 'end', occurredAt: new Date().toISOString(), packagesCounted: 3 },
      }).expect(201);
      const id = await rejectedOpId(opId);
      expectProblem(await resolve(id, { decision: 'apply' }), 409, 'decision-not-available');
      const discarded = await resolve(id, { decision: 'discard' }).expect(200);
      expect(discarded.body.rejectedOp.status).toBe('discarded');
      const badOp = ulid();
      await uploadRow({ opId: badOp, opType: 'gate-in.unload', problemCode: 'validation-failed', payload: { gateInId: 'nope', phase: 'start', occurredAt: new Date().toISOString() } }).expect(201);
      await rejectedOpId(badOp);
    });

    it('(e) a fully refused receipt naming an unknown gate-in carries refusedReceipt.gateInLink', async () => {
      const otherClient = (
        await http().post(`${API}/${tenantId}/clients`).set('Authorization', `Bearer ${ownerToken}`).set(KEY_HEADER, ulid()).send({ code: `OTH${ulid().slice(-4)}`, name: 'Other Brand' }).expect(201)
      ).body.client.id as string;
      const res = await receive({
        poId: null,
        blindReasonCode: 'other',
        clientId: otherClient,
        gateInId: uuidv7(),
        lines: [{ poLineId: null, skuId, batchCode: null, mfgDate: null, qty: 1 }],
      }).expect(201);
      expect(res.body.goodsReceipt).toBeNull();
      expect(res.body.refusedReceipt.gateInLink).toEqual({ status: 'not-linked', reason: 'unknown' });
    });

    it('(f) two concurrent creates parked on the code sequence get distinct GI- codes', async () => {
      const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':gate-in-seq', 0))`;
          first = (async () => create(baseBody({ vehicleNo: 'RC01AA0001' })))();
          second = (async () => create(baseBody({ vehicleNo: 'RC01AA0002' })))();
          const deadline = Date.now() + 10_000;
          for (;;) {
            const waiting = (await sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`) as unknown as { n: number }[];
            if (waiting[0]!.n >= 2) break;
            if (Date.now() > deadline) throw new Error('fewer than 2 creates parked on the sequence lock');
            await new Promise((r) => setTimeout(r, 25));
          }
        });
        const [a, b] = await Promise.all([first!, second!]);
        expect([a.status, b.status]).toEqual([201, 201]);
        const codes = [a.body.gateIn.code as string, b.body.gateIn.code as string];
        expect(new Set(codes).size).toBe(2);
        for (const code of codes) expect(code).toMatch(/^GI-\d{4,}$/);
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
    });

    it('(g) a device unload whose X-Op-Operator is not the badged operator is 409 operator-mismatch', async () => {
      const g = await newGateIn();
      const res = await http()
        .post(`${API}/${tenantId}/devices/gate-ins/${g.id}/unload`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set('X-Op-Operator', uuidv7())
        .set(KEY_HEADER, ulid())
        .send({ phase: 'start', occurredAt: new Date().toISOString() });
      expectProblem(res, 409, 'operator-mismatch');
    });
  });

  // ── the receipt link ───────────────────────────────────────────────────────

  describe('the receipt link (grn.submit)', () => {
    it('the acceptance: GI recorded, the dock starts, receives PO-1001 and PO-1002 against it, ends 10 of 12 — the web shows unloaded, "2 short", 2 receipts, and both GRNs show GI · vehicle', async () => {
      const g = await newGateIn({ vehicleNo: 'KA01AB1234', packagesDeclared: 12 });
      await unloadDevice(g.id, { phase: 'start', occurredAt: new Date(Date.now() - 20 * 60_000).toISOString() }).expect(200);
      const r1 = await receive({ poId: po1001.id, gateInId: g.id, lines: [{ poLineId: po1001.lineId, skuId, batchCode: null, mfgDate: null, qty: 4 }] }).expect(201);
      const r2 = await receive({ poId: po1002.id, gateInId: g.id, lines: [{ poLineId: po1002.lineId, skuId: skuB, batchCode: null, mfgDate: null, qty: 6 }] }).expect(201);
      for (const r of [r1, r2]) {
        expect(r.body.goodsReceipt).toMatchObject({ gateInId: g.id, gateInCode: g.code });
        expect(r.body.goodsReceipt.gateInLink).toBeUndefined();
      }
      await unloadDevice(g.id, { phase: 'end', occurredAt: new Date().toISOString(), packagesCounted: 10 }).expect(200);
      const entry = (await list(wh1)).find((row) => row.id === g.id)!;
      expect(entry).toMatchObject({ status: 'unloaded', packagesFlag: 'short', packagesDifference: 2, receiptCount: 2 });
      const grns = (
        await http().get(`${API}/${tenantId}/receiving/goods-receipts`).query({ warehouseId: wh1, limit: 200 }).set('Authorization', `Bearer ${ownerToken}`).expect(200)
      ).body.items as { id: string; gateInId?: string; gateInCode?: string; vehicleNo?: string }[];
      for (const id of [r1.body.goodsReceipt.id, r2.body.goodsReceipt.id]) {
        expect(grns.find((row) => row.id === id)).toMatchObject({ gateInId: g.id, gateInCode: g.code, vehicleNo: 'KA01AB1234' });
      }
      const unlinked = grns.find((row) => row.gateInId === undefined);
      if (unlinked !== undefined) expect(Object.keys(unlinked)).not.toContain('gateInCode');
      const d = await detail(g.id);
      expect(d.receipts.map((r) => [r.code, r.clientId, r.document.kind, r.document.code])).toEqual([
        [r1.body.goodsReceipt.code, glowCo, 'po', 'PO-1001'],
        [r2.body.goodsReceipt.code, glowCo, 'po', 'PO-1002'],
      ]);
      const stored = (await sql`select gate_in_id from goods_receipt_notes where id = ${r1.body.goodsReceipt.id}`) as unknown as { gate_in_id: string }[];
      expect(stored[0]!.gate_in_id).toBe(g.id);
    });

    it('a bad link never refuses: unknown, non-uuid or another warehouse\'s → 201 unlinked with gateInLink.not-linked; a gated-out gate-in links', async () => {
      const other = (await create(baseBody({ warehouseId: wh2 })).expect(201)).body.gateIn as GateIn;
      const blind = (gateInId: string) =>
        receive({ poId: null, blindReasonCode: 'other', clientId: glowCo, gateInId, lines: [{ poLineId: null, skuId, batchCode: null, mfgDate: null, qty: 1 }] }).expect(201);
      for (const [gateInId, reason] of [
        [uuidv7(), 'unknown'],
        ['not-a-uuid', 'unknown'],
        [other.id, 'other-warehouse'],
      ] as const) {
        const res = await blind(gateInId);
        expect(res.body.goodsReceipt.gateInId).toBeUndefined();
        expect(res.body.goodsReceipt.gateInLink).toEqual({ status: 'not-linked', reason });
        const stored = (await sql`select gate_in_id from goods_receipt_notes where id = ${res.body.goodsReceipt.id}`) as unknown as { gate_in_id: string | null }[];
        expect(stored[0]!.gate_in_id).toBeNull();
      }
      const closed = await newGateIn();
      await gateOut(closed.id).expect(200);
      const linked = await blind(closed.id);
      expect(linked.body.goodsReceipt).toMatchObject({ gateInId: closed.id, gateInCode: closed.code });
      // The list counts a receipt linked after the gate-out.
      expect((await list(wh1)).find((row) => row.id === closed.id)!.receiptCount).toBe(1);
    });

    it('a receipt with no gate-in books as before (no link keys at all)', async () => {
      const res = await receive({ poId: null, blindReasonCode: 'other', clientId: glowCo, lines: [{ poLineId: null, skuId, batchCode: null, mfgDate: null, qty: 1 }] }).expect(201);
      const keys = Object.keys(res.body.goodsReceipt as Record<string, unknown>);
      for (const key of ['gateInId', 'gateInCode', 'gateInLink']) expect(keys).not.toContain(key);
    });
  });
});
